"""Web 客户端本地服务测试（不依赖真实 DSH 插件/浏览器）。"""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch
from types import SimpleNamespace
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from client import server as client_server  # noqa: E402

TOKEN = "test-token-" + "a" * 40


class FakeAdminHandler(BaseHTTPRequestHandler):
    token_seen = None
    requests: list[tuple[str, str, bytes]] = []

    def log_message(self, *_args):  # noqa: D401
        return

    def _json(self, status: int, payload: dict):
        raw = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):  # noqa: N802
        FakeAdminHandler.token_seen = self.headers.get("X-Moments-Token")
        FakeAdminHandler.requests.append(("GET", self.path, b""))
        if self.path == "/api/health":
            self._json(200, {"ok": True, "data": {"status": "ok"}, "tokenSeen": bool(FakeAdminHandler.token_seen)})
        elif self.path == "/api/image":
            raw = b"\x89PNG\r\n\x1a\nfake"
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
        elif self.path == "/api/error":
            self._json(500, {"ok": False, "message": "fake business error", "errorCode": "FAKE"})
        else:
            self._json(404, {"ok": False})

    def do_POST(self):  # noqa: N802
        FakeAdminHandler.token_seen = self.headers.get("X-Moments-Token")
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        FakeAdminHandler.requests.append(("POST", self.path, body))
        if self.path == "/api/echo":
            self._json(200, {"ok": True, "body": body.decode("utf-8"), "token": bool(FakeAdminHandler.token_seen)})
        else:
            self._json(404, {"ok": False})

    def do_PATCH(self):  # noqa: N802
        FakeAdminHandler.token_seen = self.headers.get("X-Moments-Token")
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        FakeAdminHandler.requests.append(("PATCH", self.path, body))
        if self.path == "/api/error":
            self._json(500, {"ok": False, "message": "fake business error", "errorCode": "FAKE"})
        elif self.path.startswith("/api/chat-memory/members/"):
            self._json(200, {"ok": True, "data": {"impressionId": self.path.rsplit("/", 1)[-1],
                                                  "body": json.loads(body or b"{}"),
                                                  "tokenSeen": bool(FakeAdminHandler.token_seen)}})
        else:
            self._json(404, {"ok": False})

    def do_DELETE(self):  # noqa: N802
        FakeAdminHandler.token_seen = self.headers.get("X-Moments-Token")
        FakeAdminHandler.requests.append(("DELETE", self.path, b""))
        if self.path == "/api/error":
            self._json(500, {"ok": False, "message": "fake business error", "errorCode": "FAKE"})
        elif self.path.startswith(("/api/chat-memory/", "/api/memories/")):
            self._json(200, {"ok": True, "data": {"deleted": True, "tokenSeen": bool(FakeAdminHandler.token_seen)}})
        else:
            self._json(404, {"ok": False})


def http_json(url: str, method: str = "GET", body: dict | None = None, headers: dict | None = None):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(url, data=data, method=method)
    request.add_header("Content-Type", "application/json")
    for key, value in (headers or {}).items():
        request.add_header(key, value)
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, dict(response.headers), response.read()
    except urllib.error.HTTPError as error:
        return error.code, dict(error.headers), error.read()


def http_raw_json(url: str, raw_body: bytes, headers: dict | None = None):
    """发送未经过 json.dumps 的原始 body，用于验证非法 JSON 的 400 映射。"""
    request = urllib.request.Request(url, data=raw_body, method="POST")
    request.add_header("Content-Type", "application/json")
    request.add_header("X-Requested-With", "DSHMomentsClient")
    for key, value in (headers or {}).items():
        request.add_header(key, value)
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


# -- 自动配置端点用的假模块：完全替换 client.auto_configure，不触真实文件/网络 ----------

AUTO_CONFIGURE_BACKUP = "C:/Users/example/.dsh/profiles/desktop/cordis.patch.yml.20261025-181000.bak"


def auto_configure_plan(*, backup_path=None, errors=None):
    return SimpleNamespace(
        profile="desktop",
        patchPath="C:/Users/example/.dsh/profiles/desktop/cordis.patch.yml",
        existed=True,
        block="- id: dsh-moments-agent\n  name: dsh-moments-agent\n  config:\n    publishMode: PREPARE_ONLY",
        changedFields=["publishMode", "dataDir"],
        detected={
            "pluginPath": "D:/dsh插插/dsh-moments-agent",
            "dataDir": "D:/dsh插插/dsh-moments-agent/data",
            "readerBaseUrl": "http://127.0.0.1:5031",
            "hookBaseUrl": "http://127.0.0.1:30001",
            "account": "wxid_abcdef***",
            "provider": "deepseek-account",
            "model": "deepseek-flash",
        },
        warnings=["未检测到 WeChatAgent，账号留空"],
        errors=list(errors or []),
        backupPath=backup_path,
    )


def auto_configure_summary(plan):
    return {
        "profile": plan.profile,
        "patchPath": plan.patchPath,
        "existed": plan.existed,
        "block": plan.block,
        "changedFields": list(plan.changedFields),
        "detected": dict(plan.detected),
        "warnings": list(plan.warnings),
        "errors": list(plan.errors),
        "backupPath": plan.backupPath,
    }


def fake_auto_configure_module(*, plan=None, applied_plan=None, build_error=None, apply_error=None,
                               applied_summary_backup=None):
    """模拟 client.auto_configure：build_plan/apply_plan/public_summary 全部可断言。"""
    plan = plan if plan is not None else auto_configure_plan()
    applied_plan = applied_plan if applied_plan is not None else auto_configure_plan(backup_path=AUTO_CONFIGURE_BACKUP)
    build_plan = Mock(return_value=plan, side_effect=build_error)
    apply_plan = Mock(return_value=applied_plan, side_effect=apply_error)

    def public_summary(target):
        if target is applied_plan:
            summary = auto_configure_summary(applied_plan)
            if applied_summary_backup is not None:
                summary["backupPath"] = applied_summary_backup
            return summary
        return auto_configure_summary(plan)

    return SimpleNamespace(
        build_plan=build_plan,
        apply_plan=apply_plan,
        public_summary=Mock(side_effect=public_summary),
        applied_plan=applied_plan,
    )


class WebServerTest(unittest.TestCase):
    # 每个用例独立的配置/教程进度路径：绝不读写真实 client 配置，也不让用例互相污染。
    def setUp(self):
        self.case_dir = Path(tempfile.mkdtemp(prefix="case-", dir=str(self.tmp)))
        self._state_backup = (
            self.state.admin_url, self.state.token_file, self.state.data_dir, self.state.executor,
        )
        self._patchers = [
            patch.object(client_server, "CONFIG_PATH", self.case_dir / "moments-client.json"),
            patch.object(client_server, "SETUP_STATE_PATH", self.case_dir / "setup-state.json"),
        ]
        for patcher in self._patchers:
            patcher.start()
        client_server._first_run_detection.reset()

    def tearDown(self):
        for patcher in reversed(self._patchers):
            patcher.stop()
        self.state.admin_url, self.state.token_file, self.state.data_dir, self.state.executor = self._state_backup
        client_server._first_run_detection.reset()
        shutil.rmtree(self.case_dir, ignore_errors=True)

    def _write_setup_state(self, completed: bool):
        client_server.save_setup_state(
            {"version": 1, "completed": completed, "completedAt": None, "steps": {}}
        )

    def _write_client_config_file(self):
        client_server.save_settings(
            "http://127.0.0.1:18766", str(self.tmp / "admin-token.txt"), str(self.tmp)
        )

    def test_readonly_discovery_and_locator_endpoints(self):
        for endpoint in ('/api/client/discovery','/api/client/locate-controls'):
            self.assertEqual(http_json(self.base+endpoint,headers={'Origin':'https://outside.example'})[0],403)
        with patch('client.discovery.discover',return_value={'plugins':[], 'suggestedClientConfig':None}):
            status,_,raw=http_json(self.base+'/api/client/discovery?refresh=1')
            self.assertEqual(status,200)
            self.assertNotIn(TOKEN,raw.decode())
        client_server._discovery_cache = None
        previous=self.state.executor
        self.state.executor=None
        try:
            status,_,raw=http_json(self.base+'/api/client/locate-controls')
            self.assertEqual(status,200)
            self.assertFalse(json.loads(raw)['data']['supported'])
        finally:self.state.executor=previous

    def test_saved_connection_is_applied_without_restart(self):
        previous = (self.state.admin_url, self.state.token_file, self.state.data_dir, self.state.executor)
        self.state.executor = None
        try:
            payload = {"baseUrl": f"http://127.0.0.1:{self.admin.server_address[1]}/", "tokenFile": str(self.token_file), "dataDir": str(self.tmp)}
            status, _, raw = http_json(self.base + "/api/client/config", "POST", payload)
            self.assertEqual(status, 200)
            saved = json.loads(raw)["data"]
            self.assertFalse(saved["restartRequired"])
            self.assertEqual(self.state.admin_url, payload["baseUrl"].rstrip("/"))
            _, _, readback = http_json(self.base + "/api/client/config")
            self.assertEqual(json.loads(readback)["data"]["tokenFile"], saved["tokenFile"])
            self.assertEqual(http_json(self.base + "/proxy/api/health")[0], 200)
        finally:
            self.state.admin_url, self.state.token_file, self.state.data_dir, self.state.executor = previous

    def test_embedded_data_path_requires_restart_and_busy_connection_is_rejected(self):
        previous = (self.state.admin_url, self.state.token_file, self.state.data_dir, self.state.executor)
        lock = threading.Lock()
        from desktop.config import ExecutorConfig
        self.state.executor = SimpleNamespace(app=SimpleNamespace(config=ExecutorConfig(), _exec_lock=lock))
        try:
            payload = {"baseUrl": self.state.admin_url, "tokenFile": str(self.state.token_file), "dataDir": str(self.tmp / "next-data")}
            status, _, raw = http_json(self.base + "/api/client/config", "POST", payload)
            self.assertEqual(status, 200)
            self.assertTrue(json.loads(raw)["data"]["restartRequired"])
            self.assertEqual(self.state.data_dir, previous[2])
            lock.acquire()
            payload["baseUrl"] = "http://127.0.0.1:19799"
            self.assertEqual(http_json(self.base + "/api/client/config", "POST", payload)[0], 400)
            self.assertEqual(self.state.admin_url, previous[0])
        finally:
            if lock.locked(): lock.release()
            self.state.admin_url, self.state.token_file, self.state.data_dir, self.state.executor = previous

    def test_cross_site_and_rebinding_are_rejected(self):
        for headers in ({"Origin": "https://example.org"}, {"Host": "attacker.example"}, {"Sec-Fetch-Site": "cross-site"}):
            before = len(FakeAdminHandler.requests)
            status, _, _ = http_json(self.base + "/proxy/api/echo", method="POST", body={}, headers=headers)
            self.assertEqual(status, 403)
            self.assertEqual(len(FakeAdminHandler.requests), before)

    @classmethod
    def setUpClass(cls):
        # 注意：DSH 自带 Python 的默认 tempfile 目录在沙箱下可能 ACL 受限，
        # 因此测试临时目录放在仓库内（不依赖系统临时目录）。
        cls.tmp = Path(__file__).resolve().parent / ".tmp-web-test"
        if cls.tmp.exists():
            import shutil

            shutil.rmtree(cls.tmp, ignore_errors=True)
        cls.tmp.mkdir(parents=True, exist_ok=True)
        cls.token_file = cls.tmp / "admin-token.txt"
        cls.token_file.write_text(TOKEN, encoding="utf-8")
        cls.web_root = cls.tmp / "web"
        cls.web_root.mkdir()
        (cls.web_root / "index.html").write_text("<!doctype html><title>client</title><h1>ok</h1>", encoding="utf-8")
        (cls.web_root / "app.js").write_text("console.log('ok')", encoding="utf-8")

        cls.admin = ThreadingHTTPServer(("127.0.0.1", 0), FakeAdminHandler)
        cls.admin_thread = threading.Thread(target=cls.admin.serve_forever, daemon=True)
        cls.admin_thread.start()

        original_web_root = client_server.WEB_ROOT
        original_config = client_server.CONFIG_PATH
        original_setup = client_server.SETUP_STATE_PATH
        client_server.WEB_ROOT = cls.web_root
        client_server.CONFIG_PATH = cls.tmp / "moments-client.json"
        client_server.SETUP_STATE_PATH = cls.tmp / "setup-state.json"
        cls.addClassCleanup(lambda: setattr(client_server, "WEB_ROOT", original_web_root))
        cls.addClassCleanup(lambda: setattr(client_server, "CONFIG_PATH", original_config))
        cls.addClassCleanup(lambda: setattr(client_server, "SETUP_STATE_PATH", original_setup))

        cls.server = client_server.ClientServer(("127.0.0.1", 0), client_server.Handler)
        port = cls.server.server_address[1]
        cls.base = f"http://127.0.0.1:{port}"
        cls.state = client_server.ClientState(
            f"http://127.0.0.1:{cls.admin.server_address[1]}",
            str(cls.token_file),
            str(cls.tmp),
            cls.server,
        )
        client_server.Handler.state = cls.state
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        time.sleep(0.15)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.admin.shutdown()
        cls.admin.server_close()
        import shutil

        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_client_info_does_not_expose_token(self):
        status, _headers, body = http_json(self.base + "/api/client/info")
        self.assertEqual(status, 200)
        text = body.decode()
        self.assertIn("DSH Moments Agent", text)
        self.assertNotIn(TOKEN, text)
        self.assertIn("tokenFileExists", text)

    def test_proxy_injects_token(self):
        FakeAdminHandler.requests.clear()
        status, _headers, body = http_json(self.base + "/proxy/api/health")
        self.assertEqual(status, 200)
        payload = json.loads(body)
        self.assertTrue(payload["tokenSeen"])
        self.assertEqual(FakeAdminHandler.requests[0][1], "/api/health")

    def test_proxy_forwards_post_body(self):
        status, _headers, body = http_json(
            self.base + "/proxy/api/echo", method="POST", body={"hello": "世界"}
        )
        self.assertEqual(status, 200)
        payload = json.loads(body)
        self.assertTrue(payload["token"])
        self.assertEqual(json.loads(payload["body"]), {"hello": "世界"})

    def test_proxy_passes_business_error_status(self):
        status, _headers, body = http_json(self.base + "/proxy/api/error")
        self.assertEqual(status, 500)
        self.assertEqual(json.loads(body)["errorCode"], "FAKE")

    def test_proxy_binary_content_type(self):
        status, headers, body = http_json(self.base + "/proxy/api/image")
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("Content-Type"), "image/png")
        self.assertTrue(body.startswith(b"\x89PNG"))

    def test_proxy_delete_forwards_token_and_path(self):
        FakeAdminHandler.requests.clear()
        status, _headers, body = http_json(
            self.base + "/proxy/api/chat-memory/members/imp_demo_0001", method="DELETE"
        )
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)["data"]["tokenSeen"])
        self.assertEqual(FakeAdminHandler.requests[-1], ("DELETE", "/api/chat-memory/members/imp_demo_0001", b""))

    def test_proxy_delete_still_supports_saved_memories(self):
        FakeAdminHandler.requests.clear()
        status, _headers, _body = http_json(self.base + "/proxy/api/memories/mem_demo_0001", method="DELETE")
        self.assertEqual(status, 200)
        self.assertEqual(FakeAdminHandler.requests[-1][0], "DELETE")
        self.assertEqual(FakeAdminHandler.requests[-1][1], "/api/memories/mem_demo_0001")

    def test_proxy_patch_forwards_body_and_token(self):
        FakeAdminHandler.requests.clear()
        status, _headers, body = http_json(
            self.base + "/proxy/api/chat-memory/members/imp_demo_0001",
            method="PATCH",
            body={"alias": "群友C"},
        )
        self.assertEqual(status, 200)
        payload = json.loads(body)["data"]
        self.assertTrue(payload["tokenSeen"])
        self.assertEqual(payload["body"], {"alias": "群友C"})
        method, path, forwarded = FakeAdminHandler.requests[-1]
        self.assertEqual((method, path), ("PATCH", "/api/chat-memory/members/imp_demo_0001"))
        self.assertEqual(json.loads(forwarded), {"alias": "群友C"})

    def test_proxy_write_rejects_cross_site(self):
        cases = (
            ("DELETE", {"Origin": "https://example.org"}),
            ("DELETE", {"Host": "attacker.example"}),
            ("PATCH", {"Sec-Fetch-Site": "cross-site"}),
        )
        for method, headers in cases:
            before = len(FakeAdminHandler.requests)
            status, _headers, _body = http_json(
                self.base + "/proxy/api/chat-memory/members/imp_demo_0001",
                method=method,
                body={} if method == "PATCH" else None,
                headers=headers,
            )
            self.assertEqual(status, 403, (method, headers))
            self.assertEqual(len(FakeAdminHandler.requests), before)

    def test_proxy_write_rejects_non_api_paths(self):
        before = len(FakeAdminHandler.requests)
        self.assertEqual(http_json(self.base + "/proxy/other", method="DELETE")[0], 404)
        self.assertEqual(http_json(self.base + "/proxy/other", method="PATCH", body={})[0], 404)
        self.assertEqual(http_json(self.base + "/api/client/info", method="DELETE")[0], 404)
        self.assertEqual(len(FakeAdminHandler.requests), before)

    def test_proxy_write_passes_business_error_status(self):
        self.assertEqual(http_json(self.base + "/proxy/api/error", method="DELETE")[0], 500)
        self.assertEqual(http_json(self.base + "/proxy/api/error", method="PATCH", body={})[0], 500)

    def test_proxy_write_missing_token_returns_503(self):
        self.state.token_file = Path(self.tmp.name) / "missing-token.txt"
        try:
            status, _headers, body = http_json(
                self.base + "/proxy/api/chat-memory/members/imp_demo_0001", method="DELETE"
            )
            self.assertEqual(status, 503)
            self.assertEqual(json.loads(body)["errorCode"], "TOKEN_MISSING")
        finally:
            self.state.token_file = self.token_file

    def test_missing_token_returns_503(self):
        self.state.token_file = Path(self.tmp.name) / "missing.txt"
        try:
            status, _headers, body = http_json(self.base + "/proxy/api/health")
            self.assertEqual(status, 503)
            self.assertEqual(json.loads(body)["errorCode"], "TOKEN_MISSING")
        finally:
            self.state.token_file = self.token_file

    def test_static_index_and_js(self):
        status, _headers, body = http_json(self.base + "/")
        self.assertEqual(status, 200)
        self.assertIn(b"client", body)
        status, headers, body = http_json(self.base + "/app.js")
        self.assertEqual(status, 200)
        self.assertIn("javascript", headers.get("Content-Type", ""))

    def test_static_traversal_is_rejected(self):
        for path in ("/%2e%2e/client/server.py", "/..%2fclient%2fserver.py", "/%2e%2e%2f%2e%2e%2fWindows%2fwin.ini"):
            status, _headers, body = http_json(self.base + path)
            self.assertIn(status, (404, 403), path)
            self.assertNotIn(b"def run_server", body)
            self.assertNotIn(b"[fonts]", body)

    def test_config_rejects_non_loopback_admin_url(self):
        status, _headers, body = http_json(
            self.base + "/api/client/config",
            method="POST",
            body={"baseUrl": "http://192.168.1.5:18766", "tokenFile": str(self.token_file), "dataDir": self.tmp.name},
        )
        self.assertEqual(status, 400)
        self.assertIn("回环", body.decode())

    def test_open_data_requires_client_header(self):
        status, _headers, body = http_json(self.base + "/api/client/open-data", method="POST", body={})
        self.assertEqual(status, 403)
        self.assertNotIn(TOKEN, body.decode())

    def test_mode_change_requires_client_header(self):
        status, _, _ = http_json(self.base + "/api/client/publish-mode", method="POST", body={"mode": "POLICY_AUTONOMOUS"})
        self.assertEqual(status, 403)

    def test_ping_updates_heartbeat(self):
        status, _headers, body = http_json(self.base + "/api/client/ping")
        self.assertEqual(status, 200)
        self.assertTrue(self.state.ping_seen)

    def test_setup_state_defaults_and_persists(self):
        status, _headers, body = http_json(self.base + "/api/client/setup-state")
        self.assertEqual(status, 200)
        state = json.loads(body)["data"]
        self.assertFalse(state["completed"])
        self.assertEqual(state["steps"], {})

        status, _headers, body = http_json(
            self.base + "/api/client/setup-state",
            method="POST",
            body={"steps": {"plugin": True, "wechatagent": True}, "completed": False},
        )
        self.assertEqual(status, 200)
        state = json.loads(body)["data"]
        self.assertTrue(state["steps"]["plugin"])

        status, _headers, body = http_json(self.base + "/api/client/setup-state")
        state = json.loads(body)["data"]
        self.assertTrue(state["steps"]["wechatagent"])
        self.assertFalse(state["completed"])

        status, _headers, body = http_json(
            self.base + "/api/client/setup-state",
            method="POST",
            body={"completed": True},
        )
        self.assertEqual(status, 200)
        state = json.loads(body)["data"]
        self.assertTrue(state["completed"])
        self.assertIsNotNone(state["completedAt"])

    def test_setup_state_rejects_bad_values(self):
        status, _headers, _body = http_json(
            self.base + "/api/client/setup-state",
            method="POST",
            body={"steps": {"plugin": "yes"}},
        )
        self.assertEqual(status, 400)
        status, _headers, _body = http_json(
            self.base + "/api/client/setup-state",
            method="POST",
            body={"completed": "true"},
        )
        self.assertEqual(status, 400)

    # -- 自动配置端点（client/auto_configure.py 由另一任务实现，这里整体替换模块） ------

    def test_auto_configure_get_returns_readonly_preview(self):
        module = fake_auto_configure_module()
        with patch.object(client_server, "load_auto_configure", return_value=module):
            status, _headers, raw = http_json(self.base + "/api/client/auto-configure")
        self.assertEqual(status, 200)
        text = raw.decode()
        payload = json.loads(text)["data"]
        self.assertEqual(payload["profile"], "desktop")
        self.assertEqual(payload["changedFields"], ["publishMode", "dataDir"])
        self.assertTrue(payload["detected"]["readerBaseUrl"].startswith("http://127.0.0.1:"))
        self.assertIn("warnings", payload)
        self.assertNotIn(TOKEN, text)
        self.assertNotIn("applied", payload)
        module.build_plan.assert_called_once_with(client_server.PROJECT_ROOT)
        module.apply_plan.assert_not_called()

    def test_auto_configure_get_rejects_cross_site(self):
        module = fake_auto_configure_module()
        with patch.object(client_server, "load_auto_configure", return_value=module):
            status, _headers, _raw = http_json(
                self.base + "/api/client/auto-configure",
                headers={"Origin": "https://outside.example"},
            )
        self.assertEqual(status, 403)
        module.build_plan.assert_not_called()
        module.apply_plan.assert_not_called()

    def test_auto_configure_post_requires_client_header(self):
        module = fake_auto_configure_module()
        with patch.object(client_server, "load_auto_configure", return_value=module):
            status, _headers, raw = http_json(self.base + "/api/client/auto-configure", method="POST", body={})
        self.assertEqual(status, 403)
        self.assertIn("本机客户端标记", raw.decode())
        module.build_plan.assert_not_called()
        module.apply_plan.assert_not_called()

    def test_auto_configure_preview_does_not_write(self):
        module = fake_auto_configure_module()
        headers = {"X-Requested-With": "DSHMomentsClient"}
        with patch.object(client_server, "load_auto_configure", return_value=module):
            status, _headers, raw = http_json(
                self.base + "/api/client/auto-configure",
                method="POST",
                body={"apply": False, "profile": "work"},
                headers=headers,
            )
        self.assertEqual(status, 200)
        payload = json.loads(raw)["data"]
        self.assertNotIn("applied", payload)
        module.build_plan.assert_called_once_with(client_server.PROJECT_ROOT, profile="work")
        module.apply_plan.assert_not_called()

    def test_auto_configure_apply_returns_backup_path_and_releases_lock(self):
        module = fake_auto_configure_module()
        headers = {"X-Requested-With": "DSHMomentsClient"}
        with patch.object(client_server, "load_auto_configure", return_value=module):
            status, _headers, raw = http_json(
                self.base + "/api/client/auto-configure",
                method="POST",
                body={"apply": True},
                headers=headers,
            )
        self.assertEqual(status, 200)
        text = raw.decode()
        payload = json.loads(text)["data"]
        self.assertTrue(payload["applied"])
        self.assertEqual(payload["backupPath"], AUTO_CONFIGURE_BACKUP)
        self.assertNotIn(TOKEN, text)
        module.apply_plan.assert_called_once_with(module.build_plan.return_value)
        self.assertFalse(client_server._auto_configure_apply_lock.locked())

    def test_auto_configure_apply_does_not_leak_unmasked_backup_path(self):
        masked = "~/.dsh/profiles/desktop/cordis.patch.yml.20261025-181000.bak"
        raw_home = "D:/secret-home/.dsh/profiles/desktop/cordis.patch.yml.20261025-181000.bak"
        applied = auto_configure_plan(backup_path=raw_home)
        module = fake_auto_configure_module(applied_plan=applied, applied_summary_backup=masked)
        headers = {"X-Requested-With": "DSHMomentsClient"}
        with patch.object(client_server, "load_auto_configure", return_value=module):
            status, _headers, raw = http_json(
                self.base + "/api/client/auto-configure",
                method="POST",
                body={"apply": True},
                headers=headers,
            )
        self.assertEqual(status, 200)
        text = raw.decode()
        self.assertIn(masked, text)
        self.assertNotIn("D:/secret-home", text)

    def test_auto_configure_apply_refuses_plan_with_errors(self):
        plan = auto_configure_plan(errors=["profile 结构不是顶层数组，拒绝写入"])
        module = fake_auto_configure_module(plan=plan)
        headers = {"X-Requested-With": "DSHMomentsClient"}
        with patch.object(client_server, "load_auto_configure", return_value=module):
            status, _headers, raw = http_json(
                self.base + "/api/client/auto-configure",
                method="POST",
                body={"apply": True},
                headers=headers,
            )
        self.assertEqual(status, 400)
        self.assertIn("拒绝写入", raw.decode())
        module.apply_plan.assert_not_called()
        self.assertFalse(client_server._auto_configure_apply_lock.locked())

    def test_auto_configure_post_rejects_invalid_body(self):
        module = fake_auto_configure_module()
        headers = {"X-Requested-With": "DSHMomentsClient"}
        invalid_payloads = [
            {"apply": False, "token": "should-not-be-accepted"},
            {"apply": "true"},
            {"profile": 42},
            [1, 2, 3],
        ]
        with patch.object(client_server, "load_auto_configure", return_value=module):
            for payload in invalid_payloads:
                with self.subTest(payload=payload):
                    status, _headers, _raw = http_json(
                        self.base + "/api/client/auto-configure",
                        method="POST",
                        body=payload,
                        headers=headers,
                    )
                    self.assertEqual(status, 400)
            status, raw = http_raw_json(self.base + "/api/client/auto-configure", b"{not-json")
            self.assertEqual(status, 400)
            self.assertIn("JSON", raw.decode())
        module.apply_plan.assert_not_called()

    def test_auto_configure_preview_reports_plan_errors_as_400(self):
        plan = auto_configure_plan(errors=["DSH profile 不存在：missing"])
        module = fake_auto_configure_module(plan=plan)
        headers = {"X-Requested-With": "DSHMomentsClient"}
        with patch.object(client_server, "load_auto_configure", return_value=module):
            get_status, _headers, get_raw = http_json(self.base + "/api/client/auto-configure")
            post_status, _headers, post_raw = http_json(
                self.base + "/api/client/auto-configure",
                method="POST",
                body={"apply": False, "profile": "missing"},
                headers=headers,
            )
        self.assertEqual(get_status, 400)
        self.assertEqual(post_status, 400)
        for raw in (get_raw, post_raw):
            payload = json.loads(raw)
            self.assertFalse(payload["ok"])
            self.assertIn("DSH profile 不存在", payload["message"])
        module.apply_plan.assert_not_called()

    def test_auto_configure_module_missing_returns_503(self):
        unavailable = client_server.AutoConfigureUnavailable("自动配置模块未就绪")
        headers = {"X-Requested-With": "DSHMomentsClient"}
        with patch.object(client_server, "load_auto_configure", side_effect=unavailable):
            get_status, _headers, get_raw = http_json(self.base + "/api/client/auto-configure")
            post_status, _headers, post_raw = http_json(
                self.base + "/api/client/auto-configure",
                method="POST",
                body={"apply": True},
                headers=headers,
            )
        self.assertEqual(get_status, 503)
        self.assertEqual(post_status, 503)
        for raw in (get_raw, post_raw):
            payload = json.loads(raw)
            self.assertFalse(payload["ok"])
            self.assertEqual(payload["errorCode"], "AUTO_CONFIGURE_UNAVAILABLE")
            self.assertIn("未就绪", payload["message"])

    def test_auto_configure_precondition_errors_map_to_400(self):
        build_error = ValueError("未找到任何 DSH profile，请先启动 DSH 或用 --profile 指定")
        module = fake_auto_configure_module(build_error=build_error)
        with patch.object(client_server, "load_auto_configure", return_value=module):
            status, _headers, raw = http_json(self.base + "/api/client/auto-configure")
        self.assertEqual(status, 400)
        self.assertIn("未找到任何 DSH profile", raw.decode())

        apply_error = ValueError("无法识别 dsh-moments-agent 条目边界，请手工编辑 cordis.patch.yml")
        module = fake_auto_configure_module(apply_error=apply_error)
        headers = {"X-Requested-With": "DSHMomentsClient"}
        with patch.object(client_server, "load_auto_configure", return_value=module):
            status, _headers, raw = http_json(
                self.base + "/api/client/auto-configure",
                method="POST",
                body={"apply": True},
                headers=headers,
            )
        self.assertEqual(status, 400)
        self.assertIn("条目边界", raw.decode())
        self.assertFalse(client_server._auto_configure_apply_lock.locked())


    # -- 首次启动自动配置引导（client/auto_configure.py 整体替换，绝不触真实文件/网络） -----

    def test_version_is_1_2_0(self):
        self.assertEqual(client_server.VERSION, "1.2.0")

    def test_browser_url_marks_first_run_without_changing_route(self):
        self.assertEqual(client_server.browser_url(18770, False), "http://127.0.0.1:18770/")
        self.assertEqual(client_server.browser_url(18770, True), "http://127.0.0.1:18770/?firstrun=1")

    def test_first_run_status_matrix(self):
        status = client_server.first_run_status()
        self.assertTrue(status["firstRun"])
        self.assertTrue(status["configMissing"])
        self.assertFalse(status["setupCompleted"])

        self._write_client_config_file()
        status = client_server.first_run_status()
        self.assertTrue(status["firstRun"])
        self.assertFalse(status["configMissing"])
        self.assertFalse(status["setupCompleted"])

        self._write_setup_state(False)
        self.assertTrue(client_server.first_run_status()["firstRun"])

        self._write_setup_state(True)
        status = client_server.first_run_status()
        self.assertFalse(status["firstRun"])
        self.assertFalse(status["configMissing"])
        self.assertTrue(status["setupCompleted"])

    def test_first_run_endpoint_reports_config_missing_and_detects(self):
        module = fake_auto_configure_module()
        with patch.object(client_server, "load_auto_configure", return_value=module), \
             patch.object(client_server, "FIRST_RUN_WAIT_SECONDS", 2.0):
            status, _headers, raw = http_json(self.base + "/api/client/first-run?refresh=1")
        self.assertEqual(status, 200)
        text = raw.decode()
        self.assertNotIn(TOKEN, text)
        data = json.loads(text)["data"]
        self.assertTrue(data["firstRun"])
        self.assertTrue(data["configMissing"])
        self.assertFalse(data["setupCompleted"])
        self.assertIs(data["needsAutoConfigure"], True)
        self.assertEqual(data["autoConfigure"]["profile"], "desktop")
        self.assertIn("detected", data["autoConfigure"])
        self.assertIsNotNone(data["checkedAt"])
        module.apply_plan.assert_not_called()

    def test_first_run_endpoint_not_first_run_skips_detection(self):
        self._write_client_config_file()
        self._write_setup_state(True)
        module = fake_auto_configure_module()
        with patch.object(client_server, "load_auto_configure", return_value=module):
            status, _headers, raw = http_json(self.base + "/api/client/first-run?refresh=1")
        self.assertEqual(status, 200)
        data = json.loads(raw.decode())["data"]
        self.assertFalse(data["firstRun"])
        self.assertTrue(data["setupCompleted"])
        self.assertFalse(data["configMissing"])
        self.assertIs(data["needsAutoConfigure"], False)
        self.assertIsNone(data["autoConfigure"])
        self.assertIn("已完成", data["reason"])
        module.build_plan.assert_not_called()

    def test_first_run_pending_does_not_block_and_recovers(self):
        release = threading.Event()
        inner = fake_auto_configure_module()
        original_build = inner.build_plan
        inner.build_plan = Mock(side_effect=lambda *args, **kwargs: (release.wait(10), original_build(*args, **kwargs))[1])
        try:
            with patch.object(client_server, "load_auto_configure", return_value=inner), \
                 patch.object(client_server, "FIRST_RUN_WAIT_SECONDS", 0.1):
                started = time.monotonic()
                status, _headers, raw = http_json(self.base + "/api/client/first-run?refresh=1")
                elapsed = time.monotonic() - started
        finally:
            release.set()
        self.assertEqual(status, 200)
        data = json.loads(raw.decode())["data"]
        self.assertIsNone(data["needsAutoConfigure"])
        self.assertIsNone(data["autoConfigure"])
        self.assertEqual(data["reason"], "检测中")
        self.assertLess(elapsed, 2.0, "端点等待检测超时不应超过约 5 秒；测试中缩短为 0.1s")

        deadline = time.monotonic() + 5
        while client_server._first_run_detection.snapshot()["needsAutoConfigure"] is None and time.monotonic() < deadline:
            time.sleep(0.02)
        with patch.object(client_server, "load_auto_configure", return_value=inner), \
             patch.object(client_server, "FIRST_RUN_WAIT_SECONDS", 2.0):
            status, _headers, raw = http_json(self.base + "/api/client/first-run")
        data = json.loads(raw.decode())["data"]
        self.assertIs(data["needsAutoConfigure"], True)
        self.assertEqual(data["autoConfigure"]["profile"], "desktop")

    def test_first_run_detection_failure_degrades_to_tutorial(self):
        module = fake_auto_configure_module(build_error=RuntimeError("boom"))
        with patch.object(client_server, "load_auto_configure", return_value=module), \
             patch.object(client_server, "FIRST_RUN_WAIT_SECONDS", 2.0):
            status, _headers, raw = http_json(self.base + "/api/client/first-run?refresh=1")
        self.assertEqual(status, 200)
        data = json.loads(raw.decode())["data"]
        self.assertTrue(data["firstRun"])
        self.assertIs(data["needsAutoConfigure"], False)
        self.assertIsNone(data["autoConfigure"])
        self.assertIn("检测失败", data["reason"])
        self.assertIsNotNone(data["checkedAt"])

    def test_first_run_module_unavailable_degrades(self):
        unavailable = client_server.AutoConfigureUnavailable("自动配置模块未就绪")
        with patch.object(client_server, "load_auto_configure", side_effect=unavailable), \
             patch.object(client_server, "FIRST_RUN_WAIT_SECONDS", 2.0):
            status, _headers, raw = http_json(self.base + "/api/client/first-run?refresh=1")
        self.assertEqual(status, 200)
        data = json.loads(raw.decode())["data"]
        self.assertIs(data["needsAutoConfigure"], False)
        self.assertIsNone(data["autoConfigure"])
        self.assertIn("未就绪", data["reason"])

    def test_first_run_plan_errors_are_not_offered_for_apply(self):
        plan = auto_configure_plan(errors=["DSH profile 不存在：missing"])
        module = fake_auto_configure_module(plan=plan)
        with patch.object(client_server, "load_auto_configure", return_value=module), \
             patch.object(client_server, "FIRST_RUN_WAIT_SECONDS", 2.0):
            status, _headers, raw = http_json(self.base + "/api/client/first-run?refresh=1")
        self.assertEqual(status, 200)
        data = json.loads(raw.decode())["data"]
        self.assertIs(data["needsAutoConfigure"], False)
        self.assertEqual(data["autoConfigure"]["errors"], ["DSH profile 不存在：missing"])
        self.assertIn("DSH profile 不存在", data["reason"])

    def test_first_run_refresh_recomputes_but_cache_is_reused(self):
        module = fake_auto_configure_module()
        with patch.object(client_server, "load_auto_configure", return_value=module), \
             patch.object(client_server, "FIRST_RUN_WAIT_SECONDS", 2.0):
            http_json(self.base + "/api/client/first-run?refresh=1")
            first = module.build_plan.call_count
            http_json(self.base + "/api/client/first-run")
            cached = module.build_plan.call_count
            http_json(self.base + "/api/client/first-run?refresh=1")
            refreshed = module.build_plan.call_count
        self.assertEqual(first, 1)
        self.assertEqual(cached, 1, "10 分钟缓存内不应重复检测")
        self.assertGreater(refreshed, cached, "refresh=1 应强制重算")

    # -- apply 成功后的客户端连接配置同步（dataDir/令牌路径） --------------------

    def test_auto_configure_apply_writes_client_config_and_updates_state(self):
        data_dir = str(self.case_dir / "plugin-data")
        plan = auto_configure_plan()
        plan.detected = {**plan.detected, "dataDir": data_dir}
        applied = auto_configure_plan(backup_path=AUTO_CONFIGURE_BACKUP)
        applied.detected = {**applied.detected, "dataDir": data_dir}
        module = fake_auto_configure_module(plan=plan, applied_plan=applied)
        headers = {"X-Requested-With": "DSHMomentsClient"}
        with patch.object(client_server, "load_auto_configure", return_value=module):
            status, _headers, raw = http_json(
                self.base + "/api/client/auto-configure", method="POST",
                body={"apply": True}, headers=headers,
            )
        self.assertEqual(status, 200)
        text = raw.decode()
        self.assertNotIn(TOKEN, text)
        data = json.loads(text)["data"]
        self.assertTrue(data["applied"])
        client_config = data["clientConfig"]
        expected_token = str(Path(data_dir) / "admin-token.txt")
        self.assertTrue(client_config["updated"])
        self.assertEqual(client_config["baseUrl"], self.state.admin_url)
        self.assertEqual(client_config["tokenFile"], expected_token)
        self.assertEqual(client_config["dataDir"], data_dir)

        saved_text = client_server.CONFIG_PATH.read_text(encoding="utf-8")
        self.assertNotIn(TOKEN, saved_text)
        saved = json.loads(saved_text)
        self.assertEqual(saved["baseUrl"], self.state.admin_url)
        self.assertEqual(saved["tokenFile"], expected_token)
        self.assertEqual(saved["dataDir"], data_dir)
        # ClientState 立即指向真实路径上的令牌，代理无需重启即可读新令牌。
        self.assertEqual(self.state.token_file, Path(expected_token))
        self.assertEqual(self.state.data_dir, Path(data_dir))

    def test_auto_configure_apply_client_config_failure_is_warning_only(self):
        module = fake_auto_configure_module()
        headers = {"X-Requested-With": "DSHMomentsClient"}
        with patch.object(client_server, "load_auto_configure", return_value=module), \
             patch.object(client_server, "save_settings", side_effect=OSError("disk full")):
            status, _headers, raw = http_json(
                self.base + "/api/client/auto-configure", method="POST",
                body={"apply": True}, headers=headers,
            )
        self.assertEqual(status, 200)
        data = json.loads(raw.decode())["data"]
        self.assertTrue(data["applied"])
        self.assertFalse(data["clientConfig"]["updated"])
        self.assertIsNone(data["clientConfig"]["tokenFile"])
        self.assertTrue(any("客户端连接配置写入失败" in str(item) for item in data["warnings"]))
        module.apply_plan.assert_called_once()
        # 插件配置成功不受影响；ClientState 保持原连接，不指向未写入的路径。
        self.assertEqual(self.state.token_file, self._state_backup[1])
        self.assertEqual(self.state.data_dir, self._state_backup[2])

    def test_auto_configure_apply_without_detected_data_dir_only_warns(self):
        plan = auto_configure_plan()
        plan.detected = {key: value for key, value in plan.detected.items() if key != "dataDir"}
        applied = auto_configure_plan(backup_path=AUTO_CONFIGURE_BACKUP)
        applied.detected = {key: value for key, value in applied.detected.items() if key != "dataDir"}
        module = fake_auto_configure_module(plan=plan, applied_plan=applied)
        headers = {"X-Requested-With": "DSHMomentsClient"}
        with patch.object(client_server, "load_auto_configure", return_value=module):
            status, _headers, raw = http_json(
                self.base + "/api/client/auto-configure", method="POST",
                body={"apply": True}, headers=headers,
            )
        self.assertEqual(status, 200)
        data = json.loads(raw.decode())["data"]
        self.assertTrue(data["applied"])
        self.assertFalse(data["clientConfig"]["updated"])
        self.assertTrue(any("未从检测结果确定插件数据目录" in str(item) for item in data["warnings"]))
        self.assertFalse(client_server.CONFIG_PATH.is_file())


if __name__ == "__main__":
    unittest.main()
