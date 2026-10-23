"""DSH Moments Agent Web 客户端本地服务。

职责：
1. 提供 client/web 下的静态前端（现代 SPA）；
2. 把浏览器请求 /proxy/api/* 代理到本机插件管理 API（127.0.0.1:18766）；
3. 管理令牌只在服务端读取并注入请求头，浏览器永远拿不到 token；
4. 监听 127.0.0.1，启动后自动用 Edge/Chrome 的应用窗口打开；
5. 前端心跳停止（浏览器关闭）后自动退出，避免遗留后台进程。

运行：
    python client/server.py --port 18770
    python client/server.py --port 18770 --no-browser
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
CLIENT_ROOT = PROJECT_ROOT / "client"
WEB_ROOT = CLIENT_ROOT / "web"
CONFIG_PATH = CLIENT_ROOT / "moments-client.json"
DEFAULT_ADMIN_URL = "http://127.0.0.1:18766"
DEFAULT_TOKEN_FILE = PROJECT_ROOT / "data" / "admin-token.txt"
DEFAULT_DATA_DIR = PROJECT_ROOT / "data"
VERSION = "1.0.0"
MAX_BODY = 16 * 1024 * 1024


def _is_loopback_url(value: str) -> bool:
    try:
        parsed = urllib.parse.urlsplit(value)
    except ValueError:
        return False
    return parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost", "::1")


def load_settings() -> dict:
    settings = {
        "baseUrl": DEFAULT_ADMIN_URL,
        "tokenFile": str(DEFAULT_TOKEN_FILE),
        "dataDir": str(DEFAULT_DATA_DIR),
    }
    if CONFIG_PATH.is_file():
        try:
            data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            data = {}
        for key in ("baseUrl", "tokenFile", "dataDir"):
            if isinstance(data.get(key), str) and data[key].strip():
                settings[key] = data[key].strip()
    path = Path(settings["tokenFile"]).expanduser()
    if not path.is_absolute():
        path = PROJECT_ROOT / path
    settings["tokenFile"] = str(path)
    data_dir = Path(settings["dataDir"]).expanduser()
    if not data_dir.is_absolute():
        data_dir = PROJECT_ROOT / data_dir
    settings["dataDir"] = str(data_dir)
    return settings


def save_settings(base_url: str, token_file: str, data_dir: str) -> None:
    payload = {
        "version": 1,
        "baseUrl": base_url,
        "tokenFile": token_file,
        "dataDir": data_dir,
        "_comment": "本文件不保存管理令牌；令牌只从 tokenFile 指向的文件读取。",
    }
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary = CONFIG_PATH.with_name(CONFIG_PATH.name + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, CONFIG_PATH)


class ClientState:
    def __init__(self, admin_url: str, token_file: str, data_dir: str, server: "ThreadingHTTPServer") -> None:
        self.admin_url = admin_url.rstrip("/")
        self.token_file = Path(token_file)
        self.data_dir = Path(data_dir)
        self.server = server
        self.started_at = time.time()
        self.last_ping = 0.0
        self.ping_seen = False
        self.stopping = threading.Event()
        self.lock = threading.Lock()

    def token(self) -> str | None:
        try:
            value = self.token_file.read_text(encoding="utf-8").strip()
        except OSError:
            return None
        return value or None

    def touch(self) -> None:
        with self.lock:
            self.last_ping = time.time()
            self.ping_seen = True


class Handler(BaseHTTPRequestHandler):
    server_version = "DSH Moments Client"
    state: ClientState  # 由 run_server 注入

    def log_message(self, fmt: str, *args) -> None:  # noqa: N802
        # 默认日志会打印 path；不打印 query（可能包含敏感内容）
        path = (self.path or "").split("?", 1)[0]
        print(f"[client] {self.command} {path} -> {args[1] if len(args) > 1 else ''}".strip(), flush=True)

    # -- 基础工具 -------------------------------------------------------

    def _send_json(self, status: int, payload: dict, extra_headers: dict | None = None) -> None:
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if extra_headers:
            for key, value in extra_headers.items():
                self.send_header(key, value)
        self.end_headers()
        self.wfile.write(raw)

    def _send_error_json(self, status: int, message: str, code: str | None = None) -> None:
        payload = {"ok": False, "message": message}
        if code:
            payload["errorCode"] = code
        self._send_json(status, payload)

    def _read_body(self) -> bytes:
        try:
            length = int(self.headers.get("Content-Length", "0") or "0")
        except ValueError:
            raise ValueError("Content-Length 非法")
        if length < 0 or length > MAX_BODY:
            raise ValueError("请求体过大")
        return self.rfile.read(length) if length else b""

    def _is_loopback_request(self) -> bool:
        address = self.client_address[0]
        if address not in ("127.0.0.1", "::1", "::ffff:127.0.0.1"):
            return False
        # 代理持有管理令牌，必须阻断恶意网站跨站请求及 DNS rebinding。
        host = self.headers.get("Host", "")
        allowed = {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}
        if host not in allowed:
            return False
        origin = self.headers.get("Origin")
        if origin and origin not in {f"http://{item}" for item in allowed}:
            return False
        if self.headers.get("Sec-Fetch-Site") == "cross-site":
            return False
        return True

    def do_DELETE(self) -> None:  # noqa: N802
        if not self._is_loopback_request():
            self._send_error_json(403, "拒绝非本机或跨站请求")
            return
        path = self.path.split("?", 1)[0]
        if path.startswith("/proxy/api/memories/"):
            self._proxy("DELETE", path)
        else:
            self._send_error_json(404, "未知端点")

    def _safe_web_path(self, url_path: str) -> Path | None:
        relative = urllib.parse.unquote(url_path).lstrip("/")
        if relative == "" or relative.endswith("/"):
            relative = relative + "index.html"
        candidate = (WEB_ROOT / relative).resolve()
        try:
            candidate.relative_to(WEB_ROOT.resolve())
        except ValueError:
            return None
        return candidate

    # -- 路由 -----------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802
        if not self._is_loopback_request():
            self._send_error_json(403, "只允许本机访问")
            return
        path = self.path.split("?", 1)[0]
        if path.startswith("/proxy/"):
            self._proxy("GET", path)
            return
        if path == "/api/client/info":
            self._client_info()
            return
        if path == "/api/client/config":
            self._client_config()
            return
        if path == "/api/client/ping":
            self.state.touch()
            self._send_json(200, {"ok": True, "time": time.time()})
            return
        self._serve_static(path)

    def do_POST(self) -> None:  # noqa: N802
        if not self._is_loopback_request():
            self._send_error_json(403, "只允许本机访问")
            return
        path = self.path.split("?", 1)[0]
        self.state.touch()
        try:
            if path.startswith("/proxy/"):
                self._proxy("POST", path)
                return
            if path == "/api/client/config":
                self._save_client_config()
                return
            if path == "/api/client/open-data":
                if self.headers.get("X-Requested-With") != "DSHMomentsClient":
                    self._send_error_json(403, "缺少本机客户端标记")
                    return
                os.startfile(str(self.state.data_dir))  # type: ignore[attr-defined]
                self._send_json(200, {"ok": True, "message": "已打开数据目录"})
                return
            if path == "/api/client/shutdown":
                if self.headers.get("X-Requested-With") != "DSHMomentsClient":
                    self._send_error_json(403, "缺少本机客户端标记")
                    return
                self._send_json(200, {"ok": True, "message": "客户端正在退出"})
                threading.Thread(target=self._stop_server, daemon=True).start()
                return
            self._send_error_json(404, "未知端点")
        except ValueError as exc:
            self._send_error_json(400, str(exc))
        except Exception as exc:  # pragma: no cover - 防御
            self._send_error_json(500, f"客户端内部错误：{type(exc).__name__}")

    def _stop_server(self) -> None:
        time.sleep(0.3)
        self.state.stopping.set()
        self.state.server.shutdown()

    # -- 客户端元数据 ----------------------------------------------------

    def _client_info(self) -> None:
        self._send_json(
            200,
            {
                "ok": True,
                "data": {
                    "name": "DSH Moments Agent 客户端",
                    "version": VERSION,
                    "adminUrl": self.state.admin_url,
                    "tokenFile": str(self.state.token_file),
                    "tokenFileExists": self.state.token_file.is_file(),
                    "dataDir": str(self.state.data_dir),
                    "startedAt": self.state.started_at,
                    "now": time.time(),
                    "pid": os.getpid(),
                },
            },
        )

    def _client_config(self) -> None:
        settings = load_settings()
        self._send_json(200, {"ok": True, "data": {"baseUrl": settings["baseUrl"], "tokenFile": settings["tokenFile"], "dataDir": settings["dataDir"]}})

    def _save_client_config(self) -> None:
        body = self._read_body()
        try:
            payload = json.loads(body.decode("utf-8") or "{}")
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ValueError("请求体不是合法 JSON")
        base_url = str(payload.get("baseUrl", "")).strip() or DEFAULT_ADMIN_URL
        token_file = str(payload.get("tokenFile", "")).strip() or str(DEFAULT_TOKEN_FILE)
        data_dir = str(payload.get("dataDir", "")).strip() or str(DEFAULT_DATA_DIR)
        if not _is_loopback_url(base_url):
            raise ValueError("管理 API 地址只允许 http 回环地址")
        save_settings(base_url, token_file, data_dir)
        # 运行时只更新 token/data 路径；admin_url 修改后提示重开客户端。
        self.state.token_file = Path(token_file).expanduser()
        self.state.data_dir = Path(data_dir).expanduser()
        self._send_json(200, {"ok": True, "message": "配置已保存；修改管理 API 地址后请重开客户端"})

    # -- 静态文件 --------------------------------------------------------

    def _serve_static(self, path: str) -> None:
        if path in ("/", "/index.html"):
            target = WEB_ROOT / "index.html"
        else:
            target = self._safe_web_path(path)
        if target is None or not target.is_file():
            # SPA 回退：无扩展名路径返回 index.html
            if "." not in Path(path).name:
                target = WEB_ROOT / "index.html"
            else:
                self._send_error_json(404, "文件不存在")
                return
        try:
            data = target.read_bytes()
        except OSError:
            self._send_error_json(500, "读取前端文件失败")
            return
        mime, _ = mimetypes.guess_type(str(target))
        mime = mime or "application/octet-stream"
        if mime.startswith("text/") or mime in ("application/javascript", "application/json"):
            mime += "; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    # -- 管理 API 代理 ---------------------------------------------------

    def _proxy(self, method: str, path: str) -> None:
        target_path = path[len("/proxy"):]
        if not target_path.startswith("/api/"):
            self._send_error_json(400, "代理只允许 /api/ 端点")
            return
        token = self.state.token()
        if token is None:
            self._send_error_json(
                503,
                f"找不到管理令牌文件：{self.state.token_file}；请确认 DSH 插件已启用 adminServer 并重载",
                "TOKEN_MISSING",
            )
            return
        body = self._read_body() if method == "POST" else None
        url = self.state.admin_url + target_path
        request = urllib.request.Request(url, data=body, method=method)
        request.add_header("X-Moments-Token", token)
        if body is not None:
            request.add_header("Content-Type", self.headers.get("Content-Type", "application/json"))
        timeout = 240 if target_path.startswith("/api/workflow/") else 90
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                payload = response.read()
                self.send_response(response.status)
                self.send_header("Content-Type", response.headers.get("Content-Type", "application/json; charset=utf-8"))
                self.send_header("Content-Length", str(len(payload)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(payload)
        except urllib.error.HTTPError as error:
            payload = error.read()
            self.send_response(error.code)
            self.send_header("Content-Type", error.headers.get("Content-Type", "application/json; charset=utf-8"))
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            self._send_error_json(
                502,
                f"无法连接 DSH Moments 插件管理 API（{self.state.admin_url}）：{getattr(error, 'reason', error)}",
                "ADMIN_API_UNREACHABLE",
            )


class ClientServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def launch_browser(url: str) -> None:
    candidates = [
        Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
        Path(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"),
        Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
        Path(r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"),
    ]
    for browser in candidates:
        if browser.is_file():
            try:
                subprocess.Popen(
                    [str(browser), f"--app={url}", "--window-size=1440,920", "--disable-features=Translate"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                return
            except OSError:
                continue
    webbrowser.open(url)


def watchdog(state: ClientState, server: ClientServer, idle_seconds: int = 60) -> None:
    while not state.stopping.is_set():
        time.sleep(2)
        with state.lock:
            seen = state.ping_seen
            last = state.last_ping
        if seen and time.time() - last > idle_seconds:
            print("[client] 浏览器心跳停止，客户端自动退出", flush=True)
            state.stopping.set()
            server.shutdown()
            return


def run_server(host: str, port: int, admin_url: str, token_file: str, data_dir: str, open_browser: bool) -> int:
    if host not in ("127.0.0.1", "localhost"):
        print("拒绝：客户端只允许监听 127.0.0.1", file=sys.stderr)
        return 2
    if not _is_loopback_url(admin_url):
        print("拒绝：管理 API 只允许 http 回环地址", file=sys.stderr)
        return 2
    if not WEB_ROOT.is_dir():
        print(f"拒绝：前端目录不存在 {WEB_ROOT}", file=sys.stderr)
        return 2
    if port not in (0,):
        for candidate_port in range(port, min(port + 10, 65536)):
            try:
                server = ClientServer((host, candidate_port), Handler)
                port = candidate_port
                break
            except OSError as exc:
                print(f"[client] 端口 {candidate_port} 不可用（{exc}），尝试下一个", flush=True)
        else:
            print("拒绝：找不到可用端口", file=sys.stderr)
            return 3
    else:
        server = ClientServer((host, 0), Handler)
        port = server.server_address[1]
    state = ClientState(admin_url, token_file, data_dir, server)
    Handler.state = state
    url = f"http://127.0.0.1:{port}/"
    print(f"[client] DSH Moments Agent 客户端已启动：{url}", flush=True)
    print(f"[client] 管理 API：{admin_url}；令牌文件：{token_file}", flush=True)
    if open_browser:
        launch_browser(url)
    threading.Thread(target=watchdog, args=(state, server), daemon=True).start()
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        state.stopping.set()
        server.server_close()
        print("[client] 已退出", flush=True)
    return 0


def main(argv: list[str] | None = None) -> int:
    settings = load_settings()
    parser = argparse.ArgumentParser(description="DSH Moments Agent Web 客户端")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18770)
    parser.add_argument("--admin-url", default=settings["baseUrl"])
    parser.add_argument("--token-file", default=settings["tokenFile"])
    parser.add_argument("--data-dir", default=settings["dataDir"])
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--version", action="version", version=f"dsh-moments-client {VERSION}")
    args = parser.parse_args(argv)
    return run_server(
        args.host,
        args.port,
        args.admin_url.rstrip("/"),
        args.token_file,
        args.data_dir,
        not args.no_browser,
    )


if __name__ == "__main__":
    raise SystemExit(main())
