"""OCR 提供者抽象与 Windows 实现。

- ``OcrProvider``：抽象接口，便于测试注入 Fake/Null 实现；
- ``WindowsOcrProvider``：通过子进程调用 ``desktop/ocr/win_helper.py``
  （必须在 DSH Python 3.12 + ``desktop/.vendor`` 的 winsdk 下运行）；
- ``NullProvider``：OCR 不可用时的诚实实现，永远返回 unavailable。

约束：
- 本模块只使用标准库，**不 import winsdk/PIL**；winsdk 只在 helper 子进程中加载；
- OCR 不可用、超时、输出非法时返回 ``available=False``，绝不伪造成功；
- 中文 OCR 结果常被插入字间空格，统一由 ``normalize_ocr_text`` 规范化后再比对。
"""
from __future__ import annotations

import abc
import json
import os
import re
import subprocess
import sys
import runpy
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Sequence

# ---------------------------------------------------------------------------
# 路径探测
# ---------------------------------------------------------------------------

DESKTOP_DIR = Path(__file__).resolve().parent
DEFAULT_HELPER_PATH = DESKTOP_DIR / "ocr" / "win_helper.py"
DEFAULT_VENDOR_DIR = DESKTOP_DIR / ".vendor"

# 任务指定的 DSH Python 路径 + 本机已知的 DSH runtime 路径；按顺序探测。
DEFAULT_OCR_PYTHON_CANDIDATES: tuple[str, ...] = (
    r"D:\dsh\resources\runtime\primary-runtime\dependencies\python\python.exe",
    os.path.expandvars(r"%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"),
    os.path.expandvars(r"%LOCALAPPDATA%\dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"),
)

OCR_WORK_TIMEOUT = 20.0
MAX_OCR_IMAGE_BYTES = 32 * 1024 * 1024

# 常见“发送失败”toast 文案（OCR 规范化后匹配）。
ERROR_TOAST_PHRASES: tuple[str, ...] = (
    "文字未发送",
    "发送失败",
    "发表失败",
    "发送不成功",
    "请稍后重试",
    "网络异常",
    "内容发送失败",
)


def default_ocr_python() -> str | None:
    """返回第一个存在的 DSH Python 3.12 路径；都不存在时返回 None。"""
    if getattr(sys, "frozen", False):
        return sys.executable
    for candidate in DEFAULT_OCR_PYTHON_CANDIDATES:
        if candidate and os.path.isfile(candidate):
            return candidate
    return None


# ---------------------------------------------------------------------------
# 数据模型
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class OcrBBox:
    x: int
    y: int
    width: int
    height: int

    @property
    def center(self) -> tuple[int, int]:
        return self.x + self.width // 2, self.y + self.height // 2

    def to_dict(self) -> dict[str, int]:
        return {"x": self.x, "y": self.y, "width": self.width, "height": self.height}

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> "OcrBBox":
        return cls(
            x=int(value.get("x", 0)),
            y=int(value.get("y", 0)),
            width=int(value.get("width", 0)),
            height=int(value.get("height", 0)),
        )


@dataclass(frozen=True)
class OcrWord:
    text: str
    bbox: OcrBBox


@dataclass(frozen=True)
class OcrLine:
    text: str
    bbox: OcrBBox
    words: tuple[OcrWord, ...] = ()


@dataclass
class OcrResult:
    """一次 OCR 的结果；``available=False`` 表示 OCR 不可用/失败。"""

    available: bool = False
    text: str = ""
    lines: list[OcrLine] = field(default_factory=list)
    words: list[OcrWord] = field(default_factory=list)
    engine: str | None = None
    language: str | None = None
    error_code: str | None = None
    message: str = ""

    @property
    def ok(self) -> bool:
        return self.available

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.available,
            "engine": self.engine,
            "language": self.language,
            "text": self.text,
            "errorCode": self.error_code,
            "message": self.message,
            "lines": [
                {
                    "text": line.text,
                    "bbox": line.bbox.to_dict(),
                    "words": [{"text": word.text, "bbox": word.bbox.to_dict()} for word in line.words],
                }
                for line in self.lines
            ],
            "words": [{"text": word.text, "bbox": word.bbox.to_dict()} for word in self.words],
        }

    @classmethod
    def unavailable(cls, message: str, *, error_code: str = "OCR_UNAVAILABLE") -> "OcrResult":
        return cls(available=False, error_code=error_code, message=message)


# ---------------------------------------------------------------------------
# 中文 OCR 文本规范化与匹配
# ---------------------------------------------------------------------------

_CJK_RANGES = (
    "\u3400-\u4dbf"  # CJK 扩展 A
    "\u4e00-\u9fff"  # CJK 基本区
    "\uf900-\ufaff"  # 兼容表意文字
    "\u3000-\u303f"  # CJK 标点
    "\uff01-\uff65"  # 全角标点/字母数字
)
_CJK_GAP_RE = re.compile(rf"(?<=[{_CJK_RANGES}])[ \t\u3000]+(?=[{_CJK_RANGES}])")
_CJK_GAP_REPEAT = 6  # 处理“字 字 字”多轮空格


def normalize_ocr_text(text: str) -> str:
    """规范化 OCR 中文文本：

    - 统一换行、去掉控制字符；
    - 删除 CJK 字符之间的 OCR 空格（“微 信 朋 友 圈” -> “微信朋友圈”）；
    - 每行去首尾空白，去掉空行，行间用 ``\\n`` 连接。
    """
    if not isinstance(text, str) or not text:
        return ""
    value = text.replace("\r\n", "\n").replace("\r", "\n")
    value = "".join(ch for ch in value if ch == "\n" or ch.isprintable())
    previous = None
    for _ in range(_CJK_GAP_REPEAT):
        if value == previous:
            break
        previous = value
        value = _CJK_GAP_RE.sub("", value)
    lines = [line.strip() for line in value.split("\n")]
    return "\n".join(line for line in lines if line)


def contains_expected_text(visible_text: str, expected_text: str, *, mode: str = "all") -> bool:
    """判断 OCR 可见文本是否包含预期正文。

    先尝试完整正文（规范化后）子串匹配；否则按行匹配：
    - ``mode="all"``：预期正文中所有长度 >= 8 的行都必须出现（编辑器场景）；
    - ``mode="any"``：任意一个长度 >= 8 的行出现即可（朋友圈信息流场景）。
    短正文（< 8 字符）只接受完整子串匹配，避免误判。
    """
    visible = normalize_ocr_text(visible_text)
    expected = normalize_ocr_text(expected_text)
    if not expected:
        return False
    if expected in visible:
        return True
    expected_lines = [line for line in expected.split("\n") if len(line) >= 8]
    if not expected_lines:
        return False
    if mode == "any":
        return any(line in visible for line in expected_lines)
    return all(line in visible for line in expected_lines)


def _line_similarity(left: str, right: str) -> float:
    """行级相似度（0–1），用于容忍 Windows OCR 的中文字符误识别。"""
    if not left or not right:
        return 0.0
    if left in right or right in left:
        return 1.0
    # 长度差过大时快速判不相似，避免把短 UI 文案误配到长正文
    shorter, longer = (left, right) if len(left) <= len(right) else (right, left)
    if len(longer) > max(8, int(len(shorter) * 1.6)):
        return 0.0
    import difflib

    return difflib.SequenceMatcher(None, left, right).ratio()


def line_similarity(left: str, right: str) -> float:
    """公开的行级相似度入口（供几何驱动做删除候选匹配）。"""
    return _line_similarity(left, right)


def contains_expected_text_fuzzy(
    visible_text: str,
    expected_text: str,
    *,
    mode: str = "all",
    threshold: float = 0.72,
) -> bool:
    """OCR 容错匹配：允许少量中文字符误识别，但要求整行/整段相似。

    - 优先精确子串；
    - 否则按行做 ``difflib`` 相似度，任意/全部行达到阈值；
    - 短行（<6 字符）仍只允许精确匹配，避免“公开/发表”等 UI 词误判；
    - 不用于安全关键内容校验？——用于发布后核验仍必须配合人工截图复核。
    """
    visible = normalize_ocr_text(visible_text)
    expected = normalize_ocr_text(expected_text)
    if not expected:
        return False
    if expected in visible:
        return True
    expected_lines = [line for line in expected.split("\n") if line]
    visible_lines = [line for line in visible.split("\n") if line]
    if not expected_lines or not visible_lines:
        return False
    def _line_ok(expected_line: str) -> bool:
        if len(expected_line) < 6:
            return any(expected_line == line for line in visible_lines)
        return any(_line_similarity(expected_line, line) >= threshold for line in visible_lines)
    if mode == "any":
        return any(_line_ok(line) for line in expected_lines if len(line) >= 6)
    # 编辑器/正文场景：所有有意义的行都要能对上；忽略过短标点行
    meaningful = [line for line in expected_lines if len(line) >= 6]
    return bool(meaningful) and all(_line_ok(line) for line in meaningful)


def locate_token(result: OcrResult, token: str) -> list[OcrBBox]:
    """定位 OCR 结果中的标记文本（如「粘贴」「删除」），返回 bbox 列表。

    优先使用单词级 bbox（点击更精确），找不到时退回行级 bbox。
    """
    target = normalize_ocr_text(token)
    if not target or not result.available:
        return []
    boxes: list[OcrBBox] = []
    for word in result.words:
        if normalize_ocr_text(word.text) == target:
            boxes.append(word.bbox)
    if boxes:
        return boxes
    for line in result.lines:
        if target in normalize_ocr_text(line.text):
            boxes.append(line.bbox)
    return boxes


def find_error_toast(result: OcrResult) -> str | None:
    """检测 OCR 文本中的发送失败提示，返回命中的文案（未命中返回 None）。"""
    if not result.available:
        return None
    visible = normalize_ocr_text(result.text)
    for phrase in ERROR_TOAST_PHRASES:
        if normalize_ocr_text(phrase) in visible:
            return phrase
    return None


# ---------------------------------------------------------------------------
# Provider 抽象
# ---------------------------------------------------------------------------


class OcrProvider(abc.ABC):
    """OCR 提供者接口。"""

    @property
    @abc.abstractmethod
    def available(self) -> bool:
        """OCR 当前是否可用（只读探测，可缓存）。"""

    @abc.abstractmethod
    def recognize(self, image_path: str) -> OcrResult:
        """识别图片；失败返回 ``OcrResult.unavailable``，不抛异常。"""


class NullProvider(OcrProvider):
    """OCR 不可用时的实现：永远返回 unavailable。"""

    def __init__(self, message: str = "OCR 未配置或当前平台不支持") -> None:
        self._message = message

    @property
    def available(self) -> bool:
        return False

    def recognize(self, image_path: str) -> OcrResult:
        return OcrResult.unavailable(self._message)


# ---------------------------------------------------------------------------
# 子进程运行器（测试可注入）
# ---------------------------------------------------------------------------


@dataclass
class OcrCommandResult:
    returncode: int
    stdout: str
    stderr: str = ""


RunCommand = Callable[[Sequence[str], Mapping[str, str], float], OcrCommandResult]


# ---------------------------------------------------------------------------
# Windows winsdk Provider
# ---------------------------------------------------------------------------


class WindowsOcrProvider(OcrProvider):
    """通过子进程调用 ``ocr/win_helper.py`` 的 Windows OCR。"""

    def __init__(
        self,
        *,
        ocr_python: str | None = None,
        helper_path: str | os.PathLike[str] | None = None,
        vendor_dir: str | os.PathLike[str] | None = None,
        timeout: float = OCR_WORK_TIMEOUT,
        runner: RunCommand | None = None,
        logger: Any | None = None,
    ) -> None:
        self._python = ocr_python or default_ocr_python()
        self._helper = str(helper_path or DEFAULT_HELPER_PATH)
        self._vendor = str(vendor_dir or DEFAULT_VENDOR_DIR)
        self._timeout = float(timeout)
        self._runner = runner
        self._logger = logger
        self._checked = False
        self._available = False
        self._language: str | None = None
        self._unavailable_reason = ""

    # -- 配置与探测 -------------------------------------------------------

    @property
    def python_path(self) -> str | None:
        return self._python

    @property
    def helper_path(self) -> str:
        return self._helper

    @property
    def available(self) -> bool:
        if not self._checked:
            self.check_available()
        return self._available

    @property
    def language(self) -> str | None:
        return self._language

    @property
    def unavailable_reason(self) -> str:
        return self._unavailable_reason

    def _environment(self) -> dict[str, str]:
        env = dict(os.environ)
        existing = env.get("PYTHONPATH", "")
        parts = [self._vendor] + [part for part in existing.split(os.pathsep) if part]
        env["PYTHONPATH"] = os.pathsep.join(parts)
        env["PYTHONUTF8"] = "1"
        env["PYTHONIOENCODING"] = "utf-8"
        return env

    def check_available(self, *, force: bool = False) -> bool:
        """检查 DSH Python、helper 与 winsdk OCR 语言是否可用（结果缓存）。"""
        if self._checked and not force:
            return self._available
        self._checked = True
        self._available = False
        if os.name != "nt":
            self._unavailable_reason = "非 Windows 平台，系统 OCR 不可用"
            return False
        if not self._python or not os.path.isfile(self._python):
            self._unavailable_reason = "未找到 DSH Python 3.12（--ocr-python 未指定或路径不存在）"
            return False
        if not os.path.isfile(self._helper):
            self._unavailable_reason = "OCR helper 文件不存在"
            return False
        result = self._run([self._python, self._helper, "--check"], timeout=self._timeout)
        if result is None or result.returncode != 0:
            self._unavailable_reason = "OCR helper --check 执行失败"
            return False
        payload = _load_json(result.stdout)
        if payload is None or not payload.get("ok"):
            self._unavailable_reason = str(
                (payload or {}).get("message") or "OCR 引擎或语言不可用"
            )
            return False
        self._available = True
        self._language = payload.get("language")
        return True

    # -- 识别 -------------------------------------------------------------

    def recognize(self, image_path: str) -> OcrResult:
        if not self.available:
            return OcrResult.unavailable(self._unavailable_reason or "OCR 不可用")
        if not image_path or not os.path.isfile(image_path):
            return OcrResult.unavailable("OCR 输入图片不存在", error_code="OCR_FAILED")
        try:
            if os.path.getsize(image_path) > MAX_OCR_IMAGE_BYTES:
                return OcrResult.unavailable("OCR 输入图片过大", error_code="OCR_FAILED")
        except OSError:
            return OcrResult.unavailable("无法读取 OCR 输入图片", error_code="OCR_FAILED")
        result = self._run([self._python or "", self._helper, os.path.abspath(image_path)], timeout=self._timeout)
        if result is None:
            return OcrResult.unavailable("OCR 调用超时或无法启动 helper", error_code="OCR_TIMEOUT")
        if result.returncode != 0:
            detail = (result.stderr or result.stdout or "").strip().replace("\n", " ")[:200]
            return OcrResult.unavailable(
                f"OCR helper 执行失败（exit={result.returncode}）：{detail or '无输出'}",
                error_code="OCR_FAILED",
            )
        payload = _load_json(result.stdout)
        if payload is None:
            detail = (result.stderr or result.stdout or "").strip().replace("\n", " ")[:200]
            return OcrResult.unavailable(
                f"OCR helper 输出非法（exit={result.returncode}）：{detail or '无输出'}",
                error_code="OCR_FAILED",
            )
        return parse_ocr_payload(payload)

    # -- 子进程 -----------------------------------------------------------

    def _run(self, args: Sequence[str], *, timeout: float) -> OcrCommandResult | None:
        if getattr(sys, "frozen", False) and self._runner is None:
            # EXE 不是 Python 解释器；直接在线程中加载随包 OCR，避免递归启动客户端。
            results = []
            def work():
                try:
                    helper = runpy.run_path(self._helper, run_name="dsh_bundled_ocr")
                    payloads = []
                    helper["main"].__globals__["_emit"] = payloads.append
                    code = helper["main"](list(args[2:]))
                    results.append(OcrCommandResult(code, json.dumps(payloads[-1]) if payloads else "", ""))
                except Exception as exc:
                    results.append(OcrCommandResult(1, "", f"内置 OCR 失败：{exc}"))
            worker = threading.Thread(target=work, name="bundled-ocr", daemon=True)
            worker.start()
            worker.join(timeout)
            return results[0] if results else None
        env = self._environment()
        if self._runner is not None:
            try:
                return self._runner(args, env, timeout)
            except subprocess.TimeoutExpired:
                return None
            except Exception as exc:  # 注入的 runner 失败也不应崩溃
                return OcrCommandResult(returncode=1, stdout="", stderr=f"runner error: {type(exc).__name__}")
        try:
            completed = subprocess.run(
                list(args),
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout,
                env=env,
                check=False,
            )
            return OcrCommandResult(
                returncode=int(completed.returncode),
                stdout=completed.stdout or "",
                stderr=completed.stderr or "",
            )
        except subprocess.TimeoutExpired:
            return None
        except OSError as exc:
            return OcrCommandResult(returncode=1, stdout="", stderr=f"无法启动 OCR helper：{exc}")


# ---------------------------------------------------------------------------
# 输出解析
# ---------------------------------------------------------------------------


def _load_json(text: str) -> Mapping[str, Any] | None:
    if not text:
        return None
    stripped = text.strip()
    if not stripped:
        return None
    # helper 可能输出多行（仅 JSON 一行），取第一个 '{' 到最后一个 '}'。
    start = stripped.find("{")
    end = stripped.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        payload = json.loads(stripped[start : end + 1])
    except json.JSONDecodeError:
        return None
    return payload if isinstance(payload, Mapping) else None


def _bbox_from_payload(value: Any) -> OcrBBox:
    if not isinstance(value, Mapping):
        return OcrBBox(0, 0, 0, 0)
    return OcrBBox.from_mapping(value)


def parse_ocr_payload(payload: Mapping[str, Any]) -> OcrResult:
    """把 helper JSON 解析为 OcrResult（纯函数，便于单元测试）。"""
    if not isinstance(payload, Mapping):
        return OcrResult.unavailable("OCR 输出不是 JSON 对象", error_code="OCR_FAILED")
    if not payload.get("ok"):
        return OcrResult.unavailable(
            str(payload.get("message") or "OCR 不可用"),
            error_code=str(payload.get("errorCode") or "OCR_UNAVAILABLE"),
        )
    raw_lines = payload.get("lines") or []
    lines: list[OcrLine] = []
    all_words: list[OcrWord] = []
    if isinstance(raw_lines, list):
        for raw_line in raw_lines:
            if not isinstance(raw_line, Mapping):
                continue
            words: list[OcrWord] = []
            for raw_word in raw_line.get("words") or []:
                if not isinstance(raw_word, Mapping):
                    continue
                word = OcrWord(
                    text=normalize_ocr_text(str(raw_word.get("text") or "")),
                    bbox=_bbox_from_payload(raw_word.get("bbox")),
                )
                if word.text:
                    words.append(word)
                    all_words.append(word)
            line_text = normalize_ocr_text(str(raw_line.get("text") or ""))
            if not line_text and words:
                line_text = normalize_ocr_text(" ".join(word.text for word in words))
            if line_text:
                lines.append(
                    OcrLine(
                        text=line_text,
                        bbox=_bbox_from_payload(raw_line.get("bbox")),
                        words=tuple(words),
                    )
                )
    text = normalize_ocr_text(str(payload.get("text") or ""))
    if not text and lines:
        text = "\n".join(line.text for line in lines)
    return OcrResult(
        available=True,
        text=text,
        lines=lines,
        words=all_words,
        engine=str(payload.get("engine") or "winsdk"),
        language=payload.get("language") if isinstance(payload.get("language"), str) else None,
    )


def create_ocr_provider(
    *,
    ocr_python: str | None = None,
    timeout: float = OCR_WORK_TIMEOUT,
    logger: Any | None = None,
) -> OcrProvider:
    """按配置创建 OCR Provider；Windows 下返回 winsdk Provider（惰性探测）。"""
    if os.name != "nt":
        return NullProvider("非 Windows 平台，系统 OCR 不可用")
    return WindowsOcrProvider(ocr_python=ocr_python, timeout=timeout, logger=logger)
