"""prepare / publish 编排测试（直接注入 FakeWechatDriver，不经过 HTTP）。"""
from __future__ import annotations

import hashlib
import pathlib
import shutil
import sys
import tempfile
import threading
import unittest

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent.parent
for search_path in (str(ROOT), str(HERE)):
    if search_path not in sys.path:
        sys.path.insert(0, search_path)

from desktop.account_guard import AccountGuard  # noqa: E402
from desktop.config import ExecutorConfig, ExecutorError  # noqa: E402
from desktop.moments_editor import MomentsEditor  # noqa: E402
from desktop.moments_verifier import MomentsVerifier  # noqa: E402
from desktop.wechat_driver import FakeWechatDriver  # noqa: E402

TEXT = "周末去山里走了走，云很低，风很干净。"


def text_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


class EditorHarness:
    def __init__(
        self,
        *,
        driver: FakeWechatDriver | None = None,
        mode: str = "PREPARE_ONLY",
        allow_publish: bool = False,
        expected_account_id: str | None = None,
        supported_versions: tuple[str, ...] = ("4.1.10.27",),
    ) -> None:
        self.root = pathlib.Path(tempfile.mkdtemp(prefix="dsh-editor-test-"))
        self.screenshot_dir = self.root / "screenshots"
        self.screenshot_dir.mkdir(parents=True, exist_ok=True)
        self.asset_root = self.root / "assets"
        self.asset_root.mkdir(parents=True, exist_ok=True)
        self.config = ExecutorConfig(
            host="127.0.0.1",
            port=0,
            mode=mode,
            allow_publish=allow_publish,
            token="t" * 32,
            screenshot_dir=str(self.screenshot_dir),
            asset_roots=(str(self.asset_root),),
            log_file=None,
            expected_account_id=expected_account_id,
            supported_versions=supported_versions,
            status_timeout=2.0,
            prepare_timeout=2.0,
            click_timeout=2.0,
            verify_timeout=1.5,
            screenshot_timeout=1.5,
        )
        self.driver = driver if driver is not None else FakeWechatDriver()
        self.guard = AccountGuard(
            expected_account_id=expected_account_id,
            supported_versions=supported_versions,
        )
        self.verifier = MomentsVerifier(self.driver, self.config)
        self.editor = MomentsEditor(self.driver, self.guard, self.config, self.verifier)

    def close(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)

    def request(
        self,
        *,
        attempt_id: str = "att_editor_001",
        task_id: str = "task_editor_001",
        text: str = TEXT,
        asset_count: int = 1,
        visibility: str = "PUBLIC",
        account_id: str | None = None,
        content_hash: str | None = None,
    ) -> dict[str, object]:
        assets = []
        for index in range(asset_count):
            path = self.asset_root / f"asset_{index}.png"
            path.write_bytes(b"\x89PNG\r\n\x1a\n")
            assets.append(str(path))
        return {
            "taskId": task_id,
            "attemptId": attempt_id,
            "text": text,
            "assetPaths": assets,
            "visibility": visibility,
            "contentHash": content_hash or text_hash(text),
            "accountId": account_id or (self.driver.account_id or "wxid_fake_account"),
            "screenshotDir": str(self.screenshot_dir),
        }

    def publish_request(self, request: dict[str, object], **overrides: object) -> dict[str, object]:
        payload = {
            "taskId": request["taskId"],
            "attemptId": request["attemptId"],
            "contentHash": request["contentHash"],
            "accountId": request["accountId"],
            "approvalId": "apr_editor_001",
        }
        payload.update(overrides)
        return payload


class PrepareFlowTest(unittest.TestCase):
    def make(self, **kwargs: object) -> EditorHarness:
        harness = EditorHarness(**kwargs)  # type: ignore[arg-type]
        self.addCleanup(harness.close)
        return harness

    def test_prepare_success_never_clicks_publish(self) -> None:
        harness = self.make()
        request = harness.request()
        outcome = harness.editor.prepare(request)
        self.assertTrue(outcome.ok, msg=outcome.message)
        self.assertTrue(outcome.prepared)
        self.assertTrue(outcome.text_matched)
        self.assertEqual(outcome.image_count, 1)
        self.assertIsNone(outcome.error_code)
        self.assertIsNotNone(outcome.snapshot)
        screenshot = pathlib.Path(outcome.screenshot_path or "")
        self.assertTrue(screenshot.is_file())
        self.assertEqual(screenshot.parent.resolve(), harness.screenshot_dir.resolve())
        self.assertFalse(harness.driver.clicked)
        self.assertNotIn("click_publish", harness.driver.calls)
        # 顺序：打开编辑器 → 填正文 → 加图 → 读回 → 可见范围 → 截图
        self.assertLess(harness.driver.calls.index("open_moments_editor"), harness.driver.calls.index("fill_text"))
        self.assertLess(harness.driver.calls.index("fill_text"), harness.driver.calls.index("add_images"))
        self.assertLess(harness.driver.calls.index("add_images"), harness.driver.calls.index("read_back"))
        self.assertLess(harness.driver.calls.index("read_back"), harness.driver.calls.index("set_visibility"))
        self.assertLess(harness.driver.calls.index("set_visibility"), harness.driver.calls.index("screenshot"))

    def test_prepare_failures_stop_immediately(self) -> None:
        cases = [
            ("WECHAT_NOT_RUNNING", FakeWechatDriver(running=False), "get_status"),
            ("WECHAT_NOT_LOGGED_IN", FakeWechatDriver(logged_in=False), "get_status"),
            ("INTERACTIVE_DESKTOP_UNAVAILABLE", FakeWechatDriver(interactive=False), None),
            ("WINDOW_NOT_FOUND", FakeWechatDriver(window_found=False), "open_moments_editor"),
            ("UPLOAD_FAILED", FakeWechatDriver(upload_fail=True), "add_images"),
            ("CONTENT_CHANGED", FakeWechatDriver(text_match=False), "read_back"),
            ("CLIENT_VERSION_UNSUPPORTED", FakeWechatDriver(supported=False), None),
            ("WINDOW_NOT_FOUND", FakeWechatDriver(screenshot_fail=True), "screenshot"),
        ]
        for expected_code, driver, last_stage in cases:
            with self.subTest(code=expected_code):
                harness = self.make(driver=driver)
                request = harness.request()
                outcome = harness.editor.prepare(request)
                self.assertFalse(outcome.ok)
                self.assertFalse(outcome.prepared)
                self.assertEqual(outcome.error_code, expected_code)
                self.assertFalse(driver.clicked)
                if last_stage is not None:
                    self.assertIn(last_stage, driver.calls)
                    # 失败后不得继续后续步骤
                    later = {
                        "get_status": (
                            "open_moments_editor",
                            "fill_text",
                            "add_images",
                            "read_back",
                            "set_visibility",
                            "screenshot",
                        ),
                        "open_moments_editor": ("fill_text", "add_images", "read_back", "set_visibility", "screenshot"),
                        "add_images": ("read_back", "set_visibility", "screenshot"),
                        "read_back": ("set_visibility", "screenshot"),
                        "screenshot": (),
                    }[last_stage]
                    for stage in later:
                        self.assertNotIn(stage, driver.calls, msg=f"{expected_code} 失败后不应继续 {stage}")

    def test_prepare_account_mismatch(self) -> None:
        harness = self.make(driver=FakeWechatDriver(account_id="wxid_actual"))
        request = harness.request(account_id="wxid_other")
        outcome = harness.editor.prepare(request)
        self.assertEqual(outcome.error_code, "ACCOUNT_MISMATCH")
        self.assertEqual(harness.driver.calls[:1], ["get_status"])

    def test_prepare_content_change_reports_content_changed(self) -> None:
        harness = self.make()
        request = harness.request()
        harness.driver.text_override = "另一段正文"
        harness.driver.text_match = False
        outcome = harness.editor.prepare(request)
        self.assertEqual(outcome.error_code, "CONTENT_CHANGED")
        self.assertIn("read_back", harness.driver.calls)

    def test_prepare_image_count_mismatch(self) -> None:
        class DropImageDriver(FakeWechatDriver):
            def add_images(self, asset_paths, timeout=None):  # type: ignore[no-untyped-def]
                self.calls.append("add_images")  # 故意不记录图片，模拟上传未生效
                if self.upload_fail:
                    raise ExecutorError("UPLOAD_FAILED", "图片添加失败")

        harness = self.make(driver=DropImageDriver())
        request = harness.request(asset_count=1)
        outcome = harness.editor.prepare(request)
        self.assertEqual(outcome.error_code, "UPLOAD_FAILED")
        self.assertIn("不一致", outcome.message)

    def test_prepare_invalid_attempt_id(self) -> None:
        harness = self.make()
        request = harness.request(attempt_id="../escape")
        outcome = harness.editor.prepare(request)
        self.assertEqual(outcome.error_code, "BAD_REQUEST")
        self.assertEqual(harness.driver.calls, [])

    def test_prepare_cancelled_before_start(self) -> None:
        harness = self.make()
        event = threading.Event()
        event.set()
        outcome = harness.editor.prepare(harness.request(), cancel_event=event)
        self.assertFalse(outcome.ok)
        self.assertEqual(outcome.error_code, "CANCELLED")
        self.assertFalse(harness.driver.clicked)

    def test_prepare_visibility_failure(self) -> None:
        harness = self.make(driver=FakeWechatDriver(set_visibility_fail=True))
        outcome = harness.editor.prepare(harness.request())
        self.assertEqual(outcome.error_code, "DESKTOP_UNSUPPORTED")
        self.assertNotIn("screenshot", harness.driver.calls)

    def test_prepare_partial_visibility_unsupported_by_driver(self) -> None:
        harness = self.make(driver=FakeWechatDriver(supports_partial=False))
        outcome = harness.editor.prepare(harness.request(visibility="PARTIAL"))
        self.assertEqual(outcome.error_code, "DESKTOP_UNSUPPORTED")


class PublishFlowTest(unittest.TestCase):
    def make(self, **kwargs: object) -> EditorHarness:
        defaults: dict[str, object] = {"mode": "APPROVAL_REQUIRED", "allow_publish": True}
        defaults.update(kwargs)
        harness = EditorHarness(**defaults)  # type: ignore[arg-type]
        self.addCleanup(harness.close)
        return harness

    def test_publish_disabled_in_prepare_only_mode(self) -> None:
        harness = self.make(mode="PREPARE_ONLY")
        request = harness.request()
        outcome = harness.editor.prepare(request)
        self.assertTrue(outcome.ok)
        assert outcome.snapshot is not None
        published = harness.editor.publish(
            outcome.snapshot, harness.publish_request(request), allow_publish=True
        )
        self.assertEqual(published.error_code, "PUBLISH_MODE_DISABLED")
        self.assertFalse(published.submitted)
        self.assertFalse(harness.driver.clicked)

    def test_publish_disabled_without_allow_publish(self) -> None:
        harness = self.make(allow_publish=False)
        request = harness.request()
        outcome = harness.editor.prepare(request)
        assert outcome.snapshot is not None
        published = harness.editor.publish(
            outcome.snapshot, harness.publish_request(request), allow_publish=False
        )
        self.assertEqual(published.error_code, "PUBLISH_MODE_DISABLED")
        self.assertEqual(harness.driver.click_count, 0)

    def test_publish_success(self) -> None:
        harness = self.make()
        request = harness.request()
        outcome = harness.editor.prepare(request)
        self.assertTrue(outcome.ok)
        assert outcome.snapshot is not None
        published = harness.editor.publish(
            outcome.snapshot, harness.publish_request(request), allow_publish=True
        )
        self.assertTrue(published.ok, msg=published.message)
        self.assertTrue(published.submitted)
        self.assertTrue(published.verified)
        self.assertFalse(published.uncertain)
        self.assertIsNotNone(published.verification)
        self.assertTrue(published.verification.verified)
        self.assertEqual(published.verification.visible_text, TEXT)
        self.assertEqual(published.verification.image_count, 1)
        self.assertEqual(harness.driver.click_count, 1)

    def test_publish_approval_missing(self) -> None:
        harness = self.make()
        request = harness.request()
        outcome = harness.editor.prepare(request)
        assert outcome.snapshot is not None
        published = harness.editor.publish(
            outcome.snapshot, harness.publish_request(request, approvalId=""), allow_publish=True
        )
        self.assertEqual(published.error_code, "APPROVAL_REQUIRED")
        self.assertEqual(harness.driver.click_count, 0)

    def test_publish_hash_mismatch(self) -> None:
        harness = self.make()
        request = harness.request()
        outcome = harness.editor.prepare(request)
        assert outcome.snapshot is not None
        published = harness.editor.publish(
            outcome.snapshot, harness.publish_request(request, contentHash="c" * 64), allow_publish=True
        )
        self.assertEqual(published.error_code, "CONTENT_CHANGED")
        self.assertFalse(published.submitted)

    def test_publish_account_mismatch(self) -> None:
        harness = self.make()
        request = harness.request()
        outcome = harness.editor.prepare(request)
        assert outcome.snapshot is not None
        published = harness.editor.publish(
            outcome.snapshot, harness.publish_request(request, accountId="wxid_other"), allow_publish=True
        )
        self.assertEqual(published.error_code, "ACCOUNT_MISMATCH")
        self.assertFalse(published.submitted)

    def test_publish_content_changed_after_prepare(self) -> None:
        harness = self.make()
        request = harness.request()
        outcome = harness.editor.prepare(request)
        assert outcome.snapshot is not None
        harness.driver.text_match = False
        harness.driver.text_override = "内容被修改了"
        published = harness.editor.publish(
            outcome.snapshot, harness.publish_request(request), allow_publish=True
        )
        self.assertEqual(published.error_code, "CONTENT_CHANGED")
        self.assertFalse(published.submitted)
        self.assertEqual(harness.driver.click_count, 0)

    def test_publish_desktop_locked_after_prepare(self) -> None:
        harness = self.make()
        request = harness.request()
        outcome = harness.editor.prepare(request)
        assert outcome.snapshot is not None
        harness.driver.interactive = False
        harness.driver.locked = True
        published = harness.editor.publish(
            outcome.snapshot, harness.publish_request(request), allow_publish=True
        )
        self.assertEqual(published.error_code, "INTERACTIVE_DESKTOP_UNAVAILABLE")
        self.assertEqual(harness.driver.click_count, 0)

    def test_publish_click_timeout_uncertain(self) -> None:
        driver = FakeWechatDriver(publish_outcome="click_timeout")
        harness = self.make(driver=driver)
        request = harness.request()
        outcome = harness.editor.prepare(request)
        assert outcome.snapshot is not None
        published = harness.editor.publish(
            outcome.snapshot, harness.publish_request(request), allow_publish=True
        )
        self.assertFalse(published.ok)
        self.assertTrue(published.submitted)
        self.assertTrue(published.uncertain)
        self.assertEqual(published.error_code, "UNCERTAIN")
        self.assertEqual(driver.click_count, 1)
        self.assertEqual(driver.verify_count, 0)

    def test_publish_verify_uncertain(self) -> None:
        driver = FakeWechatDriver(publish_outcome="uncertain")
        harness = self.make(driver=driver)
        request = harness.request()
        outcome = harness.editor.prepare(request)
        assert outcome.snapshot is not None
        published = harness.editor.publish(
            outcome.snapshot, harness.publish_request(request), allow_publish=True
        )
        self.assertTrue(published.submitted)
        self.assertTrue(published.uncertain)
        self.assertEqual(published.error_code, "UNCERTAIN")
        self.assertEqual(driver.verify_count, 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
