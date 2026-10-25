"""HTTP 服务端到端测试（临时 127.0.0.1 端口 + 真实 HTTP server + urllib）。

全部使用 FakeWechatDriver，不启动真实微信、不访问外网、不点击桌面。
"""
from __future__ import annotations

import hashlib
import json
import logging
import pathlib
import shutil
import socket
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from typing import Any, Mapping

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent.parent
for search_path in (str(ROOT), str(HERE)):
    if search_path not in sys.path:
        sys.path.insert(0, search_path)

from desktop.config import MAX_BODY_BYTES, ExecutorConfig  # noqa: E402
from desktop.server import ExecutorApp, create_server  # noqa: E402
from desktop.wechat_driver import ExecutorError, FakeWechatDriver  # noqa: E402
from desktop.window_locator import solid_png  # noqa: E402

TOKEN = "0123456789abcdef" * 4  # 64 字符，满足 >=32 要求
WRONG_TOKEN = "ffffffffffffffff" * 4


def _silence_logs() -> None:
    # 测试不关心日志输出；同时避免千行 stderr 干扰结果。
    logging.getLogger("dsh_moments.desktop").setLevel(logging.CRITICAL + 10)


class HttpResponse:
    def __init__(self, status: int, headers: Mapping[str, str], body: bytes) -> None:
        self.status = status
        self.headers = dict(headers)
        self.body = body

    @property
    def text(self) -> str:
        return self.body.decode("utf-8", errors="replace")

    def json(self) -> dict[str, Any]:
        return json.loads(self.body.decode("utf-8"))


class HttpHarness:
    """在临时端口启动真实 HTTP server；每个测试结束必须 close()。"""

    def __init__(
        self,
        *,
        driver: FakeWechatDriver | None = None,
        mode: str = "PREPARE_ONLY",
        allow_publish: bool = False,
        supported_versions: tuple[str, ...] = ("4.1.10.27",),
        expected_account_id: str | None = None,
        max_images: int = 9,
        max_text_length: int = 2000,
        config_overrides: Mapping[str, Any] | None = None,
    ) -> None:
        _silence_logs()
        self.root = pathlib.Path(tempfile.mkdtemp(prefix="dsh-desktop-test-"))
        self.screenshot_dir = self.root / "screenshots"
        self.screenshot_dir.mkdir(parents=True, exist_ok=True)
        self.asset_root = self.root / "assets"
        self.asset_root.mkdir(parents=True, exist_ok=True)
        config_kwargs: dict[str, Any] = dict(
            host="127.0.0.1",
            port=0,
            mode=mode,
            allow_publish=allow_publish,
            token=TOKEN,
            screenshot_dir=str(self.screenshot_dir),
            asset_roots=(str(self.asset_root),),
            log_file=None,
            expected_account_id=expected_account_id,
            supported_versions=supported_versions,
            max_images=max_images,
            max_text_length=max_text_length,
            status_timeout=3.0,
            prepare_timeout=3.0,
            click_timeout=3.0,
            verify_timeout=2.0,
            screenshot_timeout=2.0,
        )
        if config_overrides:
            config_kwargs.update(config_overrides)
        self.config = ExecutorConfig(**config_kwargs)
        self.driver = driver if driver is not None else FakeWechatDriver()
        self.server, self.app = create_server(self.config, driver=self.driver, token=TOKEN)
        self.thread = threading.Thread(
            target=self.server.serve_forever,
            kwargs={"poll_interval": 0.02},
            name="desktop-test-server",
            daemon=True,
        )
        self.thread.start()
        host, port = self.server.server_address[0], self.server.server_address[1]
        self.base_url = f"http://{host}:{port}"
        self._asset_index = 0

    def close(self) -> None:
        try:
            self.server.shutdown()
            self.server.server_close()
        finally:
            self.thread.join(timeout=5)
            shutil.rmtree(self.root, ignore_errors=True)

    # -- 请求工具 ---------------------------------------------------------

    def request(
        self,
        method: str,
        path: str,
        payload: Mapping[str, Any] | None = None,
        *,
        token: str | None = TOKEN,
        raw_body: bytes | None = None,
        headers: Mapping[str, str] | None = None,
        timeout: float = 10.0,
    ) -> HttpResponse:
        data: bytes | None
        if raw_body is not None:
            data = raw_body
        elif payload is not None:
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        else:
            data = None
        request = urllib.request.Request(self.base_url + path, data=data, method=method)
        if token is not None:
            request.add_header("X-Moments-Token", token)
        if data is not None:
            request.add_header("Content-Type", "application/json; charset=utf-8")
        for key, value in (headers or {}).items():
            request.add_header(key, value)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return HttpResponse(response.status, dict(response.headers), response.read())
        except urllib.error.HTTPError as error:
            return HttpResponse(error.code, dict(error.headers), error.read())

    def http_json(
        self,
        method: str,
        path: str,
        payload: Mapping[str, Any] | None = None,
        **kwargs: Any,
    ) -> tuple[int, dict[str, Any]]:
        response = self.request(method, path, payload, **kwargs)
        return response.status, response.json()

    def raw_http(self, request_bytes: bytes, *, timeout: float = 10.0) -> bytes:
        """直接 socket 发送原始 HTTP 请求（用于超大 body 等测试）。"""
        host, port = self.server.server_address[0], self.server.server_address[1]
        with socket.create_connection((host, port), timeout=timeout) as sock:
            sock.settimeout(timeout)
            sock.sendall(request_bytes)
            chunks: list[bytes] = []
            while True:
                try:
                    chunk = sock.recv(65536)
                except socket.timeout:
                    break
                if not chunk:
                    break
                chunks.append(chunk)
            return b"".join(chunks)

    # -- 数据构造 ---------------------------------------------------------

    def make_asset(self, name: str | None = None, data: bytes | None = None) -> str:
        self._asset_index += 1
        filename = name or f"asset_{self._asset_index}.png"
        path = self.asset_root / filename
        path.write_bytes(data if data is not None else solid_png(3, 3, (10, 20, 30)))
        return str(path)

    def prepare_payload(
        self,
        *,
        attempt_id: str = "att_test_001",
        task_id: str = "task_test_001",
        text: str = "今天读了一本书，记录一点想法。",
        asset_count: int = 1,
        visibility: str = "PUBLIC",
        account_id: str | None = None,
        content_hash: str | None = None,
        screenshot_dir: str | None = None,
    ) -> dict[str, Any]:
        if account_id is None:
            account_id = self.driver.account_id or "wxid_fake_account"
        content = content_hash if content_hash is not None else hashlib.sha256(text.encode("utf-8")).hexdigest()
        return {
            "taskId": task_id,
            "attemptId": attempt_id,
            "text": text,
            "assetPaths": [self.make_asset() for _ in range(asset_count)],
            "visibility": visibility,
            "contentHash": content,
            "accountId": account_id,
            "screenshotDir": screenshot_dir or str(self.screenshot_dir),
        }

    def publish_payload(
        self,
        prepared: Mapping[str, Any],
        *,
        approval_id: str = "apr_test_001",
        content_hash: str | None = None,
        account_id: str | None = None,
    ) -> dict[str, Any]:
        return {
            "taskId": prepared["taskId"],
            "attemptId": prepared["attemptId"],
            "contentHash": content_hash or prepared["contentHash"],
            "accountId": account_id or prepared["accountId"],
            "approvalId": approval_id,
        }

    def prepare_ok(self, **kwargs: Any) -> tuple[dict[str, Any], dict[str, Any]]:
        payload = self.prepare_payload(**kwargs)
        status, body = self.http_json("POST", "/moments/prepare", payload)
        if status != 200 or not body.get("ok"):
            raise AssertionError(f"prepare 失败：status={status} body={body}")
        return payload, body


class ExecutorAppTestBase(unittest.TestCase):
    def make_harness(self, **kwargs: Any) -> HttpHarness:
        harness = HttpHarness(**kwargs)
        self.addCleanup(harness.close)
        return harness

    def assert_prepare_error(self, body: Mapping[str, Any], code: str) -> None:
        self.assertFalse(body.get("ok"), msg=str(body))
        self.assertFalse(body.get("prepared"), msg=str(body))
        self.assertEqual(body.get("errorCode"), code, msg=str(body))


class HealthStatusTest(ExecutorAppTestBase):
    def test_health_prepare_only(self) -> None:
        harness = self.make_harness()
        status, body = harness.http_json("GET", "/health")
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(body["version"], "0.1.0")
        self.assertTrue(body["wechatInstalled"])
        self.assertTrue(body["uiaAvailable"])  # FakeWechatDriver 模拟 UIA 可用
        self.assertFalse(body["allowPublish"])
        self.assertEqual(body["mode"], "PREPARE_ONLY")
        self.assertIn("禁止", body["message"])
        self.assertNotIn(TOKEN, json.dumps(body))

    def test_health_allow_publish_requires_approval_mode(self) -> None:
        harness = self.make_harness(allow_publish=True, mode="PREPARE_ONLY")
        _, body = harness.http_json("GET", "/health")
        self.assertFalse(body["allowPublish"])
        harness2 = self.make_harness(allow_publish=True, mode="APPROVAL_REQUIRED")
        _, body2 = harness2.http_json("GET", "/health")
        self.assertTrue(body2["allowPublish"])

    def test_wechat_status_shape(self) -> None:
        harness = self.make_harness()
        status, body = harness.http_json("GET", "/wechat/status")
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        expected_keys = {
            "running",
            "loggedIn",
            "accountId",
            "version",
            "interactive",
            "locked",
            "supported",
            "windowTitle",
            "dpiScale",
            "notes",
        }
        self.assertTrue(expected_keys.issubset(body.keys()), msg=str(body))
        self.assertTrue(body["running"])
        self.assertTrue(body["loggedIn"])
        self.assertEqual(body["accountId"], "wxid_fake_account")

    def test_status_not_running_is_reported(self) -> None:
        harness = self.make_harness(driver=FakeWechatDriver(running=False))
        _, body = harness.http_json("GET", "/wechat/status")
        self.assertTrue(body["ok"])
        self.assertFalse(body["running"])
        self.assertFalse(body["loggedIn"])


class AuthAndRoutingTest(ExecutorAppTestBase):
    def test_missing_token_rejected(self) -> None:
        harness = self.make_harness()
        response = harness.request("GET", "/health", token=None)
        self.assertEqual(response.status, 401)
        body = response.json()
        self.assertFalse(body["ok"])
        self.assertEqual(body["errorCode"], "UNAUTHORIZED")
        self.assertNotIn(TOKEN, response.text)

    def test_wrong_token_rejected_without_echo(self) -> None:
        harness = self.make_harness()
        response = harness.request("GET", "/health", token=WRONG_TOKEN)
        self.assertEqual(response.status, 401)
        self.assertEqual(response.json()["errorCode"], "UNAUTHORIZED")
        self.assertNotIn(WRONG_TOKEN, response.text)
        self.assertNotIn(TOKEN, response.text)

    def test_token_in_query_is_not_enough(self) -> None:
        harness = self.make_harness()
        response = harness.request("GET", f"/health?token={TOKEN}", token=None)
        self.assertEqual(response.status, 401)

    def test_unknown_endpoint_returns_404(self) -> None:
        harness = self.make_harness()
        status, body = harness.http_json("POST", "/unknown/endpoint", {})
        self.assertEqual(status, 404)
        self.assertFalse(body["ok"])
        self.assertEqual(body["errorCode"], "NOT_FOUND")

    def test_wrong_method_returns_405(self) -> None:
        harness = self.make_harness()
        response = harness.request("GET", "/moments/prepare", token=TOKEN)
        self.assertEqual(response.status, 405)
        self.assertEqual(response.json()["errorCode"], "METHOD_NOT_ALLOWED")
        self.assertIn("POST", response.headers.get("Allow", ""))
        response2 = harness.request("PUT", "/health", payload={})
        self.assertEqual(response2.status, 405)

    def test_non_json_body_rejected(self) -> None:
        harness = self.make_harness()
        response = harness.request("POST", "/moments/prepare", raw_body=b"not json")
        self.assertEqual(response.status, 200)
        self.assertEqual(response.json()["errorCode"], "BAD_REQUEST")
        response2 = harness.request("POST", "/moments/prepare", raw_body=b"[1,2,3]")
        self.assertEqual(response2.json()["errorCode"], "BAD_REQUEST")


class PrepareEndpointTest(ExecutorAppTestBase):
    def test_prepare_success_preview_and_no_publish_click(self) -> None:
        harness = self.make_harness()
        payload, body = harness.prepare_ok()
        self.assertTrue(body["prepared"])
        self.assertTrue(body["textMatched"])
        self.assertEqual(body["imageCount"], 1)
        self.assertIsNone(body["errorCode"])
        screenshot = pathlib.Path(body["screenshotPath"])
        self.assertTrue(screenshot.is_file())
        self.assertEqual(screenshot.parent.resolve(), harness.screenshot_dir.resolve())
        self.assertFalse(harness.driver.clicked)
        self.assertNotIn("click_publish", harness.driver.calls)
        self.assertLess(
            harness.driver.calls.index("read_back"),
            harness.driver.calls.index("set_visibility"),
        )

        # 预览返回真实 PNG 字节
        response = harness.request("GET", f"/moments/preview/{payload['attemptId']}")
        self.assertEqual(response.status, 200)
        self.assertEqual(response.headers.get("Content-Type"), "image/png")
        self.assertTrue(response.body.startswith(b"\x89PNG\r\n\x1a\n"))

    def test_prepare_preview_missing_returns_404(self) -> None:
        harness = self.make_harness()
        status, body = harness.http_json("GET", "/moments/preview/att_missing")
        self.assertEqual(status, 404)
        self.assertEqual(body["errorCode"], "PREVIEW_NOT_FOUND")

    def test_prepare_validation_errors(self) -> None:
        harness = self.make_harness()
        base = harness.prepare_payload()
        cases: list[tuple[str, dict[str, Any]]] = []

        missing_task = dict(base)
        missing_task.pop("taskId")
        cases.append(("缺少 taskId", missing_task))

        bad_hash = dict(base, contentHash="xyz")
        cases.append(("contentHash 非法", bad_hash))

        bad_visibility = dict(base, visibility="FRIENDS")
        cases.append(("visibility 非法", bad_visibility))

        too_long_text = dict(base, text="很" * 2001)
        cases.append(("正文过长", too_long_text))

        too_many_assets = dict(base, assetPaths=[harness.make_asset() for _ in range(10)])
        cases.append(("图片过多", too_many_assets))

        outside_asset = dict(base, assetPaths=[str(harness.root / "outside.png")])
        cases.append(("素材越界", outside_asset))

        outside_screenshot = dict(base, screenshotDir=str(harness.root / "elsewhere"))
        cases.append(("截图目录越界", outside_screenshot))

        bad_asset_type = dict(base, assetPaths=[""])
        cases.append(("素材类型非法", bad_asset_type))

        for name, payload in cases:
            with self.subTest(case=name):
                status, body = harness.http_json("POST", "/moments/prepare", payload)
                self.assertEqual(status, 200, msg=name)
                self.assertEqual(body["errorCode"], "BAD_REQUEST", msg=f"{name}: {body}")

    def test_prepare_failure_codes(self) -> None:
        cases = [
            ("WECHAT_NOT_RUNNING", FakeWechatDriver(running=False)),
            ("WECHAT_NOT_LOGGED_IN", FakeWechatDriver(logged_in=False)),
            ("INTERACTIVE_DESKTOP_UNAVAILABLE", FakeWechatDriver(interactive=False)),
            ("INTERACTIVE_DESKTOP_UNAVAILABLE", FakeWechatDriver(locked=True)),
            ("WINDOW_NOT_FOUND", FakeWechatDriver(window_found=False)),
            ("UPLOAD_FAILED", FakeWechatDriver(upload_fail=True)),
            ("CONTENT_CHANGED", FakeWechatDriver(text_match=False)),
            ("CONTENT_CHANGED", FakeWechatDriver(text_match=False, text_override="完全不同的正文")),
            ("WINDOW_NOT_FOUND", FakeWechatDriver(screenshot_fail=True)),
            ("CLIENT_VERSION_UNSUPPORTED", FakeWechatDriver(supported=False)),
            ("ACCOUNT_MISMATCH", FakeWechatDriver(account_id="wxid_actual")),
        ]
        for expected_code, driver in cases:
            with self.subTest(code=expected_code, driver=repr(driver)):
                harness = self.make_harness(driver=driver)
                request_account = "wxid_fake_account"
                if driver.account_id != "wxid_fake_account":
                    request_account = "wxid_other"
                payload = harness.prepare_payload(account_id=request_account)
                _, body = harness.http_json("POST", "/moments/prepare", payload)
                self.assert_prepare_error(body, expected_code)
                self.assertFalse(driver.clicked)

    def test_prepare_without_uia_returns_desktop_unsupported(self) -> None:
        class NoUiaDriver(FakeWechatDriver):
            @property
            def uia_available(self) -> bool:
                return False

        driver = NoUiaDriver()
        harness = self.make_harness(driver=driver)
        payload = harness.prepare_payload()
        _, body = harness.http_json("POST", "/moments/prepare", payload)
        self.assert_prepare_error(body, "DESKTOP_UNSUPPORTED")

    def test_prepare_invalid_attempt_id_rejected(self) -> None:
        harness = self.make_harness()
        payload = harness.prepare_payload(attempt_id="../escape")
        _, body = harness.http_json("POST", "/moments/prepare", payload)
        self.assert_prepare_error(body, "BAD_REQUEST")

    def test_executor_busy(self) -> None:
        driver = FakeWechatDriver(delay_seconds=0.6, delay_stage="fill_text")
        harness = self.make_harness(driver=driver)
        first_payload = harness.prepare_payload(attempt_id="att_first")
        results: dict[str, Any] = {}

        def _first() -> None:
            results["first"] = harness.http_json("POST", "/moments/prepare", first_payload)

        thread = threading.Thread(target=_first, daemon=True)
        thread.start()
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if harness.app.snapshot_summary()["activeKind"] == "prepare":
                break
            time.sleep(0.02)
        second_payload = harness.prepare_payload(attempt_id="att_second")
        _, busy = harness.http_json("POST", "/moments/prepare", second_payload)
        self.assertEqual(busy["errorCode"], "EXECUTOR_BUSY")
        thread.join(timeout=10)
        self.assertFalse(thread.is_alive())
        self.assertTrue(results["first"][1]["ok"], msg=str(results["first"][1]))


class PublishEndpointTest(ExecutorAppTestBase):
    def _harness(self, **kwargs: Any) -> HttpHarness:
        kwargs.setdefault("mode", "APPROVAL_REQUIRED")
        kwargs.setdefault("allow_publish", True)
        return self.make_harness(**kwargs)

    def test_publish_disabled_in_prepare_only(self) -> None:
        harness = self.make_harness(mode="PREPARE_ONLY", allow_publish=False)
        prepared, _ = harness.prepare_ok()
        _, body = harness.http_json("POST", "/moments/publish", harness.publish_payload(prepared))
        self.assertFalse(body["ok"])
        self.assertFalse(body["submitted"])
        self.assertEqual(body["errorCode"], "PUBLISH_MODE_DISABLED")
        self.assertFalse(harness.driver.clicked)

    def test_publish_disabled_without_allow_publish_flag(self) -> None:
        harness = self.make_harness(mode="APPROVAL_REQUIRED", allow_publish=False)
        prepared, _ = harness.prepare_ok()
        _, body = harness.http_json("POST", "/moments/publish", harness.publish_payload(prepared))
        self.assertEqual(body["errorCode"], "PUBLISH_MODE_DISABLED")
        self.assertEqual(harness.driver.click_count, 0)

    def test_allow_publish_but_prepare_only_mode_still_disabled(self) -> None:
        harness = self.make_harness(mode="PREPARE_ONLY", allow_publish=True)
        prepared, _ = harness.prepare_ok()
        _, body = harness.http_json("POST", "/moments/publish", harness.publish_payload(prepared))
        self.assertEqual(body["errorCode"], "PUBLISH_MODE_DISABLED")
        self.assertFalse(harness.driver.clicked)

    def test_publish_requires_approval_id(self) -> None:
        harness = self._harness()
        prepared, _ = harness.prepare_ok()
        payload = harness.publish_payload(prepared, approval_id="")
        _, body = harness.http_json("POST", "/moments/publish", payload)
        self.assertEqual(body["errorCode"], "APPROVAL_REQUIRED")
        self.assertFalse(body["submitted"])
        self.assertEqual(harness.driver.click_count, 0)

    def test_publish_success_and_verify_endpoint(self) -> None:
        harness = self._harness()
        prepared, _ = harness.prepare_ok()
        status, body = harness.http_json("POST", "/moments/publish", harness.publish_payload(prepared))
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"], msg=str(body))
        self.assertTrue(body["submitted"])
        self.assertTrue(body["verified"])
        self.assertFalse(body["uncertain"])
        self.assertIsNone(body["errorCode"])
        self.assertTrue(harness.driver.clicked)
        self.assertEqual(harness.driver.click_count, 1)
        verification = body["verification"]
        self.assertTrue(verification["verified"])
        self.assertEqual(verification["visibleText"], prepared["text"])
        self.assertEqual(verification["imageCount"], 1)
        self.assertTrue(pathlib.Path(verification["evidencePath"]).is_file())

        status2, stored = harness.http_json("GET", f"/moments/verify/{prepared['attemptId']}")
        self.assertEqual(status2, 200)
        self.assertTrue(stored["verified"])

        # 重复 publish 不得再次点击
        _, duplicate = harness.http_json("POST", "/moments/publish", harness.publish_payload(prepared))
        self.assertEqual(duplicate["errorCode"], "ALREADY_SUBMITTED")
        self.assertTrue(duplicate["submitted"])
        self.assertEqual(harness.driver.click_count, 1)

    def test_publish_unknown_verify_record(self) -> None:
        harness = self._harness()
        status, body = harness.http_json("GET", "/moments/verify/att_never")
        self.assertEqual(status, 404)
        self.assertFalse(body["ok"])

    def test_publish_without_prepare_rejected(self) -> None:
        harness = self._harness()
        payload = {
            "taskId": "task_x",
            "attemptId": "att_x",
            "contentHash": "a" * 64,
            "accountId": "wxid_fake_account",
            "approvalId": "apr_x",
        }
        _, body = harness.http_json("POST", "/moments/publish", payload)
        self.assertEqual(body["errorCode"], "BAD_REQUEST")
        self.assertEqual(harness.driver.click_count, 0)

    def test_publish_content_changed_before_click(self) -> None:
        harness = self._harness()
        prepared, _ = harness.prepare_ok()
        harness.driver.text_match = False
        harness.driver.text_override = "内容已经被其他操作修改"
        _, body = harness.http_json("POST", "/moments/publish", harness.publish_payload(prepared))
        self.assertEqual(body["errorCode"], "CONTENT_CHANGED")
        self.assertFalse(body["submitted"])
        self.assertEqual(harness.driver.click_count, 0)

    def test_publish_hash_mismatch(self) -> None:
        harness = self._harness()
        prepared, _ = harness.prepare_ok()
        payload = harness.publish_payload(prepared, content_hash="b" * 64)
        _, body = harness.http_json("POST", "/moments/publish", payload)
        self.assertEqual(body["errorCode"], "CONTENT_CHANGED")
        self.assertEqual(harness.driver.click_count, 0)

    def test_publish_account_mismatch(self) -> None:
        harness = self._harness()
        prepared, _ = harness.prepare_ok()
        payload = harness.publish_payload(prepared, account_id="wxid_other")
        _, body = harness.http_json("POST", "/moments/publish", payload)
        self.assertEqual(body["errorCode"], "ACCOUNT_MISMATCH")
        self.assertFalse(body["submitted"])
        self.assertEqual(harness.driver.click_count, 0)

    def test_publish_task_mismatch(self) -> None:
        harness = self._harness()
        prepared, _ = harness.prepare_ok()
        payload = harness.publish_payload(prepared)
        payload["taskId"] = "task_other"
        _, body = harness.http_json("POST", "/moments/publish", payload)
        self.assertEqual(body["errorCode"], "BAD_REQUEST")
        self.assertEqual(harness.driver.click_count, 0)

    def test_publish_click_timeout_is_uncertain_and_not_retried(self) -> None:
        driver = FakeWechatDriver(publish_outcome="click_timeout")
        harness = self._harness(driver=driver)
        prepared, _ = harness.prepare_ok()
        _, body = harness.http_json("POST", "/moments/publish", harness.publish_payload(prepared))
        self.assertFalse(body["ok"])
        self.assertTrue(body["submitted"])
        self.assertTrue(body["uncertain"])
        self.assertEqual(body["errorCode"], "UNCERTAIN")
        self.assertEqual(driver.click_count, 1)
        self.assertEqual(driver.verify_count, 0)
        _, second = harness.http_json("POST", "/moments/publish", harness.publish_payload(prepared))
        self.assertEqual(second["errorCode"], "ALREADY_SUBMITTED")
        self.assertEqual(driver.click_count, 1)

    def test_publish_verify_uncertain(self) -> None:
        driver = FakeWechatDriver(publish_outcome="uncertain")
        harness = self._harness(driver=driver)
        prepared, _ = harness.prepare_ok()
        _, body = harness.http_json("POST", "/moments/publish", harness.publish_payload(prepared))
        self.assertTrue(body["submitted"])
        self.assertTrue(body["uncertain"])
        self.assertEqual(body["errorCode"], "UNCERTAIN")
        self.assertEqual(driver.click_count, 1)
        self.assertEqual(driver.verify_count, 1)

    def test_publish_verify_exception_is_uncertain(self) -> None:
        driver = FakeWechatDriver(publish_outcome="verify_error")
        harness = self._harness(driver=driver)
        prepared, _ = harness.prepare_ok()
        _, body = harness.http_json("POST", "/moments/publish", harness.publish_payload(prepared))
        self.assertTrue(body["submitted"])
        self.assertTrue(body["uncertain"])
        self.assertEqual(body["errorCode"], "UNCERTAIN")
        self.assertEqual(driver.click_count, 1)
        self.assertEqual(driver.verify_count, 1)

    def test_publish_click_error_before_submit(self) -> None:
        driver = FakeWechatDriver(publish_outcome="click_error")
        harness = self._harness(driver=driver)
        prepared, _ = harness.prepare_ok()
        _, body = harness.http_json("POST", "/moments/publish", harness.publish_payload(prepared))
        self.assertFalse(body["submitted"])
        self.assertFalse(body["uncertain"])
        self.assertEqual(body["errorCode"], "WINDOW_BLOCKED")
        self.assertEqual(driver.click_count, 1)

    def test_publish_after_cancel_rejected(self) -> None:
        harness = self._harness()
        prepared, _ = harness.prepare_ok()
        _, cancel_body = harness.http_json("POST", "/moments/cancel", {"attemptId": prepared["attemptId"]})
        self.assertTrue(cancel_body["cancelled"])
        _, body = harness.http_json("POST", "/moments/publish", harness.publish_payload(prepared))
        self.assertEqual(body["errorCode"], "CANCELLED")
        self.assertFalse(body["submitted"])
        self.assertEqual(harness.driver.click_count, 0)


class CancelEndpointTest(ExecutorAppTestBase):
    def test_cancel_idle_attempt(self) -> None:
        harness = self.make_harness()
        status, body = harness.http_json("POST", "/moments/cancel", {"attemptId": "att_unknown"})
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertTrue(body["cancelled"])

    def test_cancel_after_publish_is_rejected(self) -> None:
        harness = self.make_harness(mode="APPROVAL_REQUIRED", allow_publish=True)
        prepared, _ = harness.prepare_ok()
        _, published = harness.http_json("POST", "/moments/publish", harness.publish_payload(prepared))
        self.assertTrue(published["submitted"])
        _, body = harness.http_json("POST", "/moments/cancel", {"attemptId": prepared["attemptId"]})
        self.assertFalse(body["cancelled"])
        self.assertEqual(body["errorCode"], "ALREADY_SUBMITTED")

    def test_cancel_during_prepare(self) -> None:
        driver = FakeWechatDriver(delay_seconds=0.5, delay_stage="fill_text")
        harness = self.make_harness(driver=driver)
        payload = harness.prepare_payload(attempt_id="att_cancel")
        result: dict[str, Any] = {}

        def _run() -> None:
            result["prepare"] = harness.http_json("POST", "/moments/prepare", payload)

        thread = threading.Thread(target=_run, daemon=True)
        thread.start()
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if harness.app.snapshot_summary()["activeKind"] == "prepare":
                break
            time.sleep(0.02)
        _, cancel_body = harness.http_json("POST", "/moments/cancel", {"attemptId": "att_cancel"})
        self.assertTrue(cancel_body["cancelled"])
        thread.join(timeout=10)
        self.assertFalse(thread.is_alive())
        _, body = result["prepare"]
        self.assertFalse(body["ok"])
        self.assertEqual(body["errorCode"], "CANCELLED")
        self.assertFalse(driver.clicked)


class HttpLimitsTest(ExecutorAppTestBase):
    def test_oversized_body_rejected_without_reading(self) -> None:
        harness = self.make_harness()
        request = (
            "POST /moments/prepare HTTP/1.1\r\n"
            f"Host: {harness.server.server_address[0]}:{harness.server.server_address[1]}\r\n"
            f"X-Moments-Token: {TOKEN}\r\n"
            f"Content-Length: {MAX_BODY_BYTES + 1024}\r\n"
            "Content-Type: application/json\r\n\r\n"
        ).encode("ascii")
        raw = harness.raw_http(request, timeout=10)
        self.assertIn(b" 200 ", raw.split(b"\r\n", 1)[0])
        self.assertIn(b"BAD_REQUEST", raw)
        self.assertNotIn(TOKEN.encode("ascii"), raw)


if __name__ == "__main__":
    unittest.main(verbosity=2)
