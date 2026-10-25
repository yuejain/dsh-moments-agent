#!/usr/bin/env python3
"""DSH Moments Agent —— 独立 Windows OCR 辅助脚本（winsdk / Windows.Media.Ocr）。

运行环境
--------
本脚本必须由 **DSH 自带 Python 3.12** 执行，并通过 ``PYTHONPATH`` 指向
``desktop/.vendor``（其中包含 winsdk 1.0.0b10）::

    set PYTHONPATH=desktop\\.vendor
    "D:\\dsh\\resources\\runtime\\primary-runtime\\dependencies\\python\\python.exe" ^
        desktop\\ocr\\win_helper.py --check

设计约束
--------
- 只读：读取图片、调用系统 OCR、把结果以 UTF-8 JSON 输出到 stdout；
- 不联网、不写文件、不执行任何微信/GUI 操作；
- OCR/语言不可用时输出 ``{"ok": false, "errorCode": "OCR_UNAVAILABLE", ...}``，
  绝不伪造成功；
- 输出结构（供 ``desktop/ocr.py`` 解析）::

    {"ok": true, "engine": "winsdk", "language": "zh-Hans-CN",
     "text": "...", "lines": [{"text": "...", "bbox": {...},
                              "words": [{"text": "...", "bbox": {...}}]}],
     "words": [{"text": "...", "bbox": {...}}]}

  bbox 为图片像素坐标：``{"x": int, "y": int, "width": int, "height": int}``。

退出码
------
- 0：已输出合法 JSON（ok=true 或 ok=false 的已知不可用状态）；
- 1：未预期异常（stderr 有摘要，stdout 可能为空）。
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys

MAX_IMAGE_BYTES = 32 * 1024 * 1024
ENGINE = "winsdk"
RAPID_ENGINE = "rapidocr_onnxruntime"


def _rapid_import():
    """惰性导入 RapidOCR（可选依赖；随 desktop/.vendor 安装）。"""
    try:
        from rapidocr_onnxruntime import RapidOCR  # type: ignore[import-not-found]
    except Exception as exc:  # ImportError / onnxruntime DLL 缺失
        return None, f"RapidOCR 不可用：{type(exc).__name__}: {exc}"
    return RapidOCR, None


def _rapid_bbox(box) -> dict:
    xs = [float(point[0]) for point in box]
    ys = [float(point[1]) for point in box]
    left, top = min(xs), min(ys)
    return {
        "x": int(round(left)),
        "y": int(round(top)),
        "width": int(round(max(xs) - left)),
        "height": int(round(max(ys) - top)),
    }


def _rapid_recognize(image_path: str) -> dict:
    """用 RapidOCR（PP-OCR 中文模型）识别；比 Windows OCR 中文准确率更高。"""
    rapid_cls, error = _rapid_import()
    if rapid_cls is None:
        return _unavailable(error or "RapidOCR 不可用")
    try:
        engine = rapid_cls()
        result, _elapsed = engine(image_path)
    except Exception as exc:
        return _unavailable(f"RapidOCR 执行异常：{type(exc).__name__}: {exc}", error_code="OCR_FAILED")
    lines: list[dict] = []
    words: list[dict] = []
    for item in result or []:
        try:
            box, text, _score = item
        except (TypeError, ValueError):
            continue
        text = str(text).strip()
        if not text:
            continue
        bbox = _rapid_bbox(box)
        line = {
            "text": text,
            "bbox": bbox,
            # RapidOCR 只提供行级框；把整行作为一个“词”，便于 UI token 定位。
            "words": [{"text": text, "bbox": bbox}],
        }
        lines.append(line)
        words.extend(line["words"])
    if not lines:
        return _unavailable("RapidOCR 未识别到文字", error_code="OCR_FAILED")
    return {
        "ok": True,
        "engine": RAPID_ENGINE,
        "language": "zh-Hans",
        "text": "\n".join(line["text"] for line in lines),
        "lines": lines,
        "words": words,
    }


def _emit(payload: dict) -> None:
    """以 UTF-8 输出 JSON（不依赖控制台代码页）。"""
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="strict")
    except (AttributeError, OSError):  # pragma: no cover - 极旧环境
        pass
    json.dump(payload, sys.stdout, ensure_ascii=False, separators=(",", ":"))
    sys.stdout.write("\n")
    sys.stdout.flush()


def _unavailable(message: str, *, error_code: str = "OCR_UNAVAILABLE") -> dict:
    return {"ok": False, "engine": ENGINE, "errorCode": error_code, "message": message}


def _import_winsdk():
    """惰性导入 winsdk；失败返回 (None, 错误摘要)。"""
    try:
        from winsdk.windows.graphics.imaging import BitmapDecoder  # type: ignore[import-not-found]
        from winsdk.windows.media.ocr import OcrEngine  # type: ignore[import-not-found]
        from winsdk.windows.storage.streams import DataWriter, InMemoryRandomAccessStream  # type: ignore[import-not-found]
    except Exception as exc:  # ImportError / WinRT 初始化失败
        return None, f"winsdk 不可用：{type(exc).__name__}: {exc}"
    return {
        "BitmapDecoder": BitmapDecoder,
        "OcrEngine": OcrEngine,
        "DataWriter": DataWriter,
        "InMemoryRandomAccessStream": InMemoryRandomAccessStream,
    }, None


def _create_engine(ocr_engine_cls):
    """优先使用用户配置语言，其次尝试系统可用语言。"""
    try:
        engine = ocr_engine_cls.try_create_from_user_profile_languages()
    except Exception:
        engine = None
    if engine is not None:
        return engine
    try:
        from winsdk.windows.globalization import Language  # type: ignore[import-not-found]
    except Exception:
        return None
    for tag in ("zh-Hans-CN", "zh-CN", "en-US"):
        try:
            engine = ocr_engine_cls.try_create_from_language(Language(tag))
        except Exception:
            engine = None
        if engine is not None:
            return engine
    return None


def _language_tag(engine) -> str | None:
    try:
        return engine.recognizer_language.language_tag
    except Exception:
        return None


def _bbox(rect) -> dict:
    return {
        "x": int(round(rect.x)),
        "y": int(round(rect.y)),
        "width": int(round(rect.width)),
        "height": int(round(rect.height)),
    }


def _word_json(word) -> dict:
    return {"text": word.text, "bbox": _bbox(word.bounding_rect)}


def _union_bbox(words: list[dict]) -> dict:
    if not words:
        return {"x": 0, "y": 0, "width": 0, "height": 0}
    left = min(word["bbox"]["x"] for word in words)
    top = min(word["bbox"]["y"] for word in words)
    right = max(word["bbox"]["x"] + word["bbox"]["width"] for word in words)
    bottom = max(word["bbox"]["y"] + word["bbox"]["height"] for word in words)
    return {"x": left, "y": top, "width": right - left, "height": bottom - top}


async def _recognize_async(modules: dict, image_path: str) -> dict:
    with open(image_path, "rb") as handle:
        data = handle.read(MAX_IMAGE_BYTES + 1)
    if not data:
        return _unavailable("图片为空", error_code="OCR_FAILED")
    if len(data) > MAX_IMAGE_BYTES:
        return _unavailable("图片过大，拒绝 OCR", error_code="OCR_FAILED")

    stream = modules["InMemoryRandomAccessStream"]()
    writer = modules["DataWriter"](stream)
    writer.write_bytes(data)
    await writer.store_async()
    await writer.flush_async()
    writer.detach_stream()
    stream.seek(0)
    decoder = await modules["BitmapDecoder"].create_async(stream)
    bitmap = await decoder.get_software_bitmap_async()
    engine = _create_engine(modules["OcrEngine"])
    if engine is None:
        return _unavailable("系统没有可用的 OCR 语言（需要中文/英文语言包）")
    result = await engine.recognize_async(bitmap)

    lines: list[dict] = []
    all_words: list[dict] = []
    for line in result.lines:
        words = [_word_json(word) for word in line.words]
        lines.append({"text": line.text, "bbox": _union_bbox(words), "words": words})
        all_words.extend(words)
    return {
        "ok": True,
        "engine": ENGINE,
        "language": _language_tag(engine),
        "text": result.text,
        "lines": lines,
        "words": all_words,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Windows OCR 辅助脚本（RapidOCR / Windows.Media.Ocr，UTF-8 JSON）")
    parser.add_argument("image", nargs="?", help="待 OCR 的 PNG/JPEG 图片路径")
    parser.add_argument("--check", action="store_true", help="只检查 OCR 引擎/语言可用性")
    parser.add_argument("--language", default=None, help="（保留）期望的 OCR 语言 tag")
    args = parser.parse_args(argv)

    rapid_cls, rapid_error = _rapid_import()

    if args.check:
        if rapid_cls is not None:
            _emit({"ok": True, "engine": RAPID_ENGINE, "language": "zh-Hans", "languages": ["zh-Hans", "en"]})
            return 0
        modules, import_error = _import_winsdk()
        if modules is None:
            _emit(_unavailable(f"{rapid_error}; {import_error or 'winsdk 不可用'}"))
            return 0
        engine = _create_engine(modules["OcrEngine"])
        if engine is None:
            _emit(_unavailable(f"{rapid_error}; 系统没有可用的 OCR 语言"))
            return 0
        tags: list[str] = []
        try:
            tags = [language.language_tag for language in modules["OcrEngine"].available_recognizer_languages]
        except Exception:
            tags = []
        _emit({"ok": True, "engine": ENGINE, "language": _language_tag(engine), "languages": tags})
        return 0

    if not args.image:
        _emit(_unavailable("缺少图片路径", error_code="OCR_FAILED"))
        return 0
    image_path = os.path.abspath(args.image)
    if not os.path.isfile(image_path):
        _emit(_unavailable(f"图片不存在：{image_path}", error_code="OCR_FAILED"))
        return 0

    # 1) 优先 RapidOCR（中文准确率更高）
    if rapid_cls is not None:
        payload = _rapid_recognize(image_path)
        if payload.get("ok"):
            _emit(payload)
            return 0
    else:
        payload = _unavailable(rapid_error or "RapidOCR 不可用")

    # 2) 回退 Windows.Media.Ocr
    modules, import_error = _import_winsdk()
    if modules is None:
        message = payload.get("message", "")
        _emit(_unavailable(f"{message}; {import_error or 'winsdk 不可用'}"))
        return 0
    try:
        fallback = asyncio.run(_recognize_async(modules, image_path))
    except Exception as exc:  # 未预期异常：输出已知失败结构，避免调用方猜成功
        fallback = _unavailable(f"OCR 执行异常：{type(exc).__name__}: {exc}", error_code="OCR_FAILED")
    if not fallback.get("ok"):
        fallback["message"] = f"{payload.get('message', '')}; {fallback.get('message', '')}".strip("; ")
    _emit(fallback)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
