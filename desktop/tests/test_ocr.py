"""OCR Provider 与中文规范化测试（不依赖 winsdk；helper 用注入 runner 模拟）。"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from desktop.ocr import (  # noqa: E402
    ERROR_TOAST_PHRASES,
    NullProvider,
    OcrBBox,
    OcrCommandResult,
    OcrResult,
    WindowsOcrProvider,
    contains_expected_text,
    contains_expected_text_fuzzy,
    default_ocr_python,
    find_error_toast,
    locate_token,
    normalize_ocr_text,
    parse_ocr_payload,
)


def make_ocr_payload(text: str = "微 信 朋 友 圈", *, language: str = "zh-Hans-CN") -> dict:
    return {
        "ok": True,
        "engine": "winsdk",
        "language": language,
        "text": text,
        "lines": [
            {
                "text": text,
                "bbox": {"x": 100, "y": 200, "width": 300, "height": 40},
                "words": [
                    {"text": "微", "bbox": {"x": 100, "y": 200, "width": 20, "height": 20}},
                    {"text": "信", "bbox": {"x": 125, "y": 200, "width": 20, "height": 20}},
                ],
            }
        ],
        "words": [{"text": "微", "bbox": {"x": 100, "y": 200, "width": 20, "height": 20}}],
    }


class FakeRunner:
    def __init__(self, responses) -> None:
        self.responses = list(responses)
        self.calls: list[tuple[list[str], dict[str, str], float]] = []

    def __call__(self, args, env, timeout):
        self.calls.append((list(args), dict(env), timeout))
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


def ok_result(stdout: str, returncode: int = 0, stderr: str = "") -> OcrCommandResult:
    return OcrCommandResult(returncode=returncode, stdout=stdout, stderr=stderr)


class NormalizationTest(unittest.TestCase):
    def test_removes_cjk_spaces(self):
        self.assertEqual(normalize_ocr_text("微 信 朋 友 圈 发 表"), "微信朋友圈发表")
        self.assertEqual(normalize_ocr_text("这 是 一 条 测 试"), "这是一条测试")

    def test_preserves_english_spaces(self):
        self.assertEqual(normalize_ocr_text("hello world"), "hello world")
        self.assertEqual(normalize_ocr_text("微 信 hello 世 界"), "微信 hello 世界")

    def test_normalizes_newlines_and_blank_lines(self):
        text = "第一 行\r\n\r\n 第二 行  \n\n"
        self.assertEqual(normalize_ocr_text(text), "第一行\n第二行")

    def test_empty_and_non_string(self):
        self.assertEqual(normalize_ocr_text(""), "")
        self.assertEqual(normalize_ocr_text(None), "")  # type: ignore[arg-type]


class MatchingTest(unittest.TestCase):
    def test_full_text_match_with_ocr_spaces(self):
        visible = "这 是 一 条 已 发 布 的 测 试 正 文"
        self.assertTrue(contains_expected_text(visible, "这是一条已发布的测试正文"))

    def test_all_mode_requires_every_long_line(self):
        visible = "第一行比较长的正文内容\n第二行比较长的正文内容"
        expected = "第一行比较长的正文内容\n缺失的第二行比较长的正文"
        self.assertTrue(contains_expected_text(visible, "第一行比较长的正文内容", mode="all"))
        self.assertFalse(contains_expected_text(visible, expected, mode="all"))

    def test_any_mode_accepts_one_fragment(self):
        visible = "第一行比较长的正文内容"
        expected = "第一行比较长的正文内容\n不存在的第二行比较长的正文"
        self.assertFalse(contains_expected_text(visible, expected, mode="all"))
        self.assertTrue(contains_expected_text(visible, expected, mode="any"))

    def test_short_expected_requires_full_substring(self):
        self.assertTrue(contains_expected_text("测试正文", "测试正文"))
        self.assertFalse(contains_expected_text("别的内容", "测试"))

    def test_empty_expected_is_false(self):
        self.assertFalse(contains_expected_text("任意", ""))

    def test_locate_token_prefers_word_bbox(self):
        result = parse_ocr_payload(make_ocr_payload("粘 贴"))
        boxes = locate_token(result, "粘贴")
        self.assertEqual(len(boxes), 1)
        self.assertIsInstance(boxes[0], OcrBBox)
        self.assertEqual((boxes[0].x, boxes[0].y), (100, 200))

    def test_locate_token_line_fallback(self):
        payload = make_ocr_payload("请 点 击 粘 贴 按 钮")
        payload["words"] = []
        payload["lines"][0]["words"] = []
        result = parse_ocr_payload(payload)
        boxes = locate_token(result, "粘贴")
        self.assertEqual(len(boxes), 1)

    def test_locate_token_absent(self):
        result = parse_ocr_payload(make_ocr_payload())
        self.assertEqual(locate_token(result, "删除"), [])

    def test_find_error_toast_normalized(self):
        result = parse_ocr_payload(make_ocr_payload("文 字 未 发 送"))
        self.assertEqual(find_error_toast(result), "文字未发送")
        self.assertIsNone(find_error_toast(parse_ocr_payload(make_ocr_payload("正常内容"))))
        self.assertIn("文字未发送", ERROR_TOAST_PHRASES)

    def test_error_toast_on_unavailable_result(self):
        self.assertIsNone(find_error_toast(OcrResult.unavailable("no")))


class PayloadParsingTest(unittest.TestCase):
    def test_ok_payload(self):
        result = parse_ocr_payload(make_ocr_payload())
        self.assertTrue(result.available)
        self.assertEqual(result.text, "微信朋友圈")
        self.assertEqual(result.engine, "winsdk")
        self.assertEqual(result.language, "zh-Hans-CN")
        self.assertEqual(len(result.lines), 1)
        self.assertEqual(result.lines[0].bbox.width, 300)
        self.assertEqual(result.words[0].text, "微")
        self.assertEqual(result.to_dict()["lines"][0]["bbox"]["x"], 100)

    def test_line_text_falls_back_to_words(self):
        payload = make_ocr_payload()
        payload["lines"][0]["text"] = ""
        result = parse_ocr_payload(payload)
        self.assertEqual(result.lines[0].text, "微信")

    def test_unavailable_payload(self):
        result = parse_ocr_payload(
            {"ok": False, "engine": "winsdk", "errorCode": "OCR_UNAVAILABLE", "message": "no language"}
        )
        self.assertFalse(result.available)
        self.assertEqual(result.error_code, "OCR_UNAVAILABLE")
        self.assertIn("no language", result.message)

    def test_empty_payload(self):
        result = parse_ocr_payload({})
        self.assertFalse(result.available)
        self.assertEqual(result.error_code, "OCR_UNAVAILABLE")

    def test_null_provider(self):
        provider = NullProvider()
        self.assertFalse(provider.available)
        self.assertFalse(provider.recognize("x.png").available)


class WindowsProviderTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.helper = self.root / "win_helper.py"
        self.helper.write_text("# fake helper", encoding="utf-8")
        self.image = self.root / "image.png"
        self.image.write_bytes(b"\x89PNG\r\n\x1a\n")

    def provider(self, responses, *, timeout: float = 5.0) -> tuple[WindowsOcrProvider, FakeRunner]:
        runner = FakeRunner(responses)
        provider = WindowsOcrProvider(
            ocr_python=sys.executable,
            helper_path=self.helper,
            vendor_dir=self.root / ".vendor",
            timeout=timeout,
            runner=runner,
        )
        return provider, runner

    def test_check_and_recognize(self):
        provider, runner = self.provider(
            [
                ok_result(json.dumps({"ok": True, "language": "zh-Hans-CN"})),
                ok_result(json.dumps(make_ocr_payload("微 信 朋 友 圈"), ensure_ascii=False)),
            ]
        )
        self.assertTrue(provider.available)
        self.assertEqual(provider.language, "zh-Hans-CN")
        result = provider.recognize(str(self.image))
        self.assertTrue(result.available)
        self.assertEqual(result.text, "微信朋友圈")
        self.assertEqual(len(runner.calls), 2)
        args, env, timeout = runner.calls[0]
        self.assertIn("--check", args)
        self.assertIn(str(self.root / ".vendor"), env["PYTHONPATH"])
        self.assertGreater(timeout, 0)

    def test_unavailable_language_does_not_fake_success(self):
        provider, _runner = self.provider(
            [ok_result(json.dumps({"ok": False, "errorCode": "OCR_UNAVAILABLE", "message": "无中文语言包"}))]
        )
        self.assertFalse(provider.available)
        self.assertIn("无中文语言包", provider.unavailable_reason)
        result = provider.recognize(str(self.image))
        self.assertFalse(result.available)

    def test_timeout_normalized(self):
        provider, _runner = self.provider(
            [
                ok_result(json.dumps({"ok": True, "language": "zh-Hans-CN"})),
                subprocess.TimeoutExpired(cmd="helper", timeout=5),
            ]
        )
        self.assertTrue(provider.available)
        result = provider.recognize(str(self.image))
        self.assertFalse(result.available)
        self.assertEqual(result.error_code, "OCR_TIMEOUT")

    def test_bad_json_normalized(self):
        provider, _runner = self.provider(
            [ok_result(json.dumps({"ok": True})), ok_result("not json", returncode=0)]
        )
        self.assertTrue(provider.available)
        result = provider.recognize(str(self.image))
        self.assertFalse(result.available)
        self.assertEqual(result.error_code, "OCR_FAILED")

    def test_nonzero_exit_normalized(self):
        provider, _runner = self.provider(
            [ok_result(json.dumps({"ok": True})), ok_result("{}", returncode=3, stderr="boom")]
        )
        self.assertTrue(provider.available)
        result = provider.recognize(str(self.image))
        self.assertFalse(result.available)
        self.assertEqual(result.error_code, "OCR_FAILED")

    def test_missing_python_is_unavailable(self):
        runner = FakeRunner([])
        provider = WindowsOcrProvider(
            ocr_python=str(self.root / "missing-python.exe"),
            helper_path=self.helper,
            runner=runner,
        )
        self.assertFalse(provider.available)
        self.assertIn("DSH Python", provider.unavailable_reason)
        self.assertEqual(runner.calls, [])

    def test_default_ocr_python(self):
        path = default_ocr_python()
        if path is not None:
            self.assertTrue(os.path.isfile(path))
        else:
            self.assertIsNone(path)


class FuzzyMatchTest(unittest.TestCase):
    def test_tolerates_real_ocr_character_errors(self):
        expected = (
            "【系统测试】只说一句「我确认」，太轻了，甚至换个对象也照样能用。"
            "外部操作得绑住具体内容，内容指纹对得上，这次批的只管这一次；省事的不是少问一句，是少一次误发。"
        )
        # 来自真实 Windows OCR：内容->囚容、操作->亻乍、绑住->绑任、批->扌比
        visible = (
            "（系统测试〕只说一句「我确认」，太轻了，甚至换个对須也照样能用。"
            "外部亻乍得绑任具体囚容，囚容指纹对得上，这次扌比的只管这一次；省事的不是少问一句，是少一次误发。"
        )
        self.assertFalse(contains_expected_text(visible, expected))
        self.assertTrue(contains_expected_text_fuzzy(visible, expected, mode="all"))

    def test_unrelated_text_does_not_match(self):
        expected = "今天发一条关于代码与阅读的朋友圈，记录一次真实的观察。"
        visible = "系统设置 网络代理 节点状态 流量详情 我的订单 邀请推广"
        self.assertFalse(contains_expected_text_fuzzy(visible, expected, mode="any"))

    def test_short_lines_require_exact_match(self):
        self.assertFalse(contains_expected_text_fuzzy("公开", "发表", mode="all"))
        self.assertTrue(contains_expected_text_fuzzy("公开", "公开", mode="all"))


if __name__ == "__main__":
    unittest.main()
