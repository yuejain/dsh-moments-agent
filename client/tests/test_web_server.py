"""Web 客户端本地服务测试（不依赖真实 DSH 插件/浏览器）。"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import time
import unittest
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


class WebServerTest(unittest.TestCase):
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
        client_server.WEB_ROOT = cls.web_root
        client_server.CONFIG_PATH = cls.tmp / "moments-client.json"
        cls.addClassCleanup(lambda: setattr(client_server, "WEB_ROOT", original_web_root))
        cls.addClassCleanup(lambda: setattr(client_server, "CONFIG_PATH", original_config))

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

    def test_ping_updates_heartbeat(self):
        status, _headers, body = http_json(self.base + "/api/client/ping")
        self.assertEqual(status, 200)
        self.assertTrue(self.state.ping_seen)


if __name__ == "__main__":
    unittest.main()
