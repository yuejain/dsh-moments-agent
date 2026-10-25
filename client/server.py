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
import ctypes
import contextlib
import json
import logging
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

FROZEN = bool(getattr(sys, "frozen", False))
RESOURCE_ROOT = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))
PROJECT_ROOT = Path(sys.executable).resolve().parent if FROZEN else RESOURCE_ROOT
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))
CLIENT_ROOT = PROJECT_ROOT / "client"
WEB_ROOT = RESOURCE_ROOT / "client" / "web"
CONFIG_PATH = CLIENT_ROOT / "moments-client.json"
SETUP_STATE_PATH = CLIENT_ROOT / "setup-state.json"
DEFAULT_ADMIN_URL = "http://127.0.0.1:18766"
DEFAULT_TOKEN_FILE = PROJECT_ROOT / "data" / "admin-token.txt"
DEFAULT_DATA_DIR = PROJECT_ROOT / "data"
VERSION = "1.2.0"
_discovery_cache = None
_discovery_cache_at = 0.0
MAX_BODY = 16 * 1024 * 1024
PUBLISH_MODES = ("PREPARE_ONLY", "APPROVAL_REQUIRED", "POLICY_AUTONOMOUS")
AUTO_CONFIGURE_PATH = "/api/client/auto-configure"
AUTO_CONFIGURE_FIELDS = ("profile", "apply")
FIRST_RUN_PATH = "/api/client/first-run"
# 首次启动自动配置检测：后台线程计算，结果缓存 10 分钟；HTTP 端点最多等待约 5 秒。
# 超时后返回 needsAutoConfigure=None + reason="检测中"，前端显示加载态并轮询；
# 检测本身绝不写文件，run_server 也不会因为检测阻塞启动。
FIRST_RUN_CACHE_TTL_SECONDS = 600.0
FIRST_RUN_WAIT_SECONDS = 5.0
# 自动配置写入串行化：同一进程只允许一个 apply，避免并发写坏 cordis.patch.yml。
_auto_configure_apply_lock = threading.Lock()


class AutoConfigureUnavailable(RuntimeError):
    """自动配置核心模块尚未落地或导入失败；运行时映射为 503，不影响客户端启动。"""


def load_auto_configure():
    """按需导入 client.auto_configure；模块缺失时抛 AutoConfigureUnavailable。

    不能放在模块顶层导入：核心模块由独立任务并行开发，缺失时客户端仍必须能启动。
    """
    try:
        from client import auto_configure  # noqa: WPS433 - 运行期导入以容忍模块暂缺
    except ImportError as exc:
        raise AutoConfigureUnavailable("自动配置模块未就绪") from exc
    for name in ("build_plan", "apply_plan", "public_summary"):
        if not callable(getattr(auto_configure, name, None)):
            raise AutoConfigureUnavailable("自动配置模块未就绪")
    return auto_configure


def auto_configure_error_message(exc: BaseException) -> str:
    message = str(exc).strip()
    return message or "自动配置前置条件不满足，请检查 DSH profile 与 WeChatAgent 配置"


def apply_executor_mode(executor, mode):
    if mode not in PUBLISH_MODES:
        raise ValueError("无效发表模式")
    executor.app.config.mode = mode
    executor.app.config.allow_publish = mode != "PREPARE_ONLY"
    executor.app.config.geometry_allow_publish = mode != "PREPARE_ONLY"


def plugin_mode_request(state, payload=None):
    token = state.token()
    if not token:
        raise ValueError("管理令牌不存在，请先连接 DSH 插件")
    request = urllib.request.Request(state.admin_url + "/api/publish-mode",
        data=None if payload is None else json.dumps(payload).encode("utf-8"),
        headers={"X-Moments-Token": token, "Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=5) as response:
        result = json.load(response)
    if not result.get("ok") or result.get("data", {}).get("mode") not in PUBLISH_MODES:
        raise ValueError("插件发表模式接口返回无效结果，请重载新版 DSH 插件")
    return result["data"]


def change_publish_mode(state, payload):
    mode = payload.get("mode")
    if mode not in PUBLISH_MODES:
        raise ValueError("无效发表模式")
    executor = state.executor
    if executor is None:
        raise ValueError("当前是界面预览模式，请使用完整 EXE 切换发表权限")
    if not executor.app._exec_lock.acquire(blocking=False):
        raise ValueError("执行器正在操作微信，暂不能切换模式")
    try:
        # During a cross-service update, deny publishing first. On any uncertain
        # network result retain PREPARE_ONLY, never restore a permissive mode.
        apply_executor_mode(executor, "PREPARE_ONLY")
        result = plugin_mode_request(state, payload)
        apply_executor_mode(executor, result["mode"])
        return {**result, "executorMode": executor.app.config.mode, "synchronized": True}
    finally:
        executor.app._exec_lock.release()


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
            data = json.loads(CONFIG_PATH.read_text(encoding="utf-8-sig"))
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


def load_setup_state() -> dict:
    """首次配置教程的持久化进度；只存布尔步骤与完成时间，不含任何凭据。"""
    default = {"version": 1, "completed": False, "completedAt": None, "steps": {}}
    if not SETUP_STATE_PATH.is_file():
        return default
    try:
        data = json.loads(SETUP_STATE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default
    if not isinstance(data, dict):
        return default
    steps = data.get("steps")
    clean_steps = {}
    if isinstance(steps, dict):
        for key, value in list(steps.items())[:32]:
            if isinstance(key, str) and 0 < len(key) <= 64 and isinstance(value, bool):
                clean_steps[key] = value
    completed_at = data.get("completedAt")
    if not isinstance(completed_at, str):
        completed_at = None
    return {
        "version": 1,
        "completed": bool(data.get("completed", False)),
        "completedAt": completed_at,
        "steps": clean_steps,
    }


def save_setup_state(state: dict) -> None:
    SETUP_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary = SETUP_STATE_PATH.with_name(SETUP_STATE_PATH.name + ".tmp")
    temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, SETUP_STATE_PATH)


# -- 首次启动 ---------------------------------------------------------------


def first_run_status() -> dict:
    """判断是否首次启动；只读取本地配置与教程进度，不触发任何探测。"""
    config_missing = not CONFIG_PATH.is_file()
    setup_completed = bool(load_setup_state().get("completed"))
    return {
        "firstRun": bool(config_missing or not setup_completed),
        "setupCompleted": setup_completed,
        "configMissing": bool(config_missing),
    }


class FirstRunDetectionCache:
    """后台计算首次启动的自动配置检测结果；只缓存脱敏摘要。

    检测可能较慢（Reader 探测 3s 超时、进程枚举等），因此单独线程计算：
    HTTP 端点最多等待 ``FIRST_RUN_WAIT_SECONDS``，超时返回 pending，绝不阻塞服务器启动。
    结果缓存 ``FIRST_RUN_CACHE_TTL_SECONDS``；``refresh=1`` 强制重算。
    """

    def __init__(self, ttl: float = FIRST_RUN_CACHE_TTL_SECONDS) -> None:
        self._ttl = ttl
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._done = threading.Event()
        self._done.set()
        self._generation = 0
        self._checked = False
        self._finished_at: float | None = None
        self._finished_monotonic = 0.0
        self._needs: bool | None = None
        self._summary: dict | None = None
        self._reason = ""
        self._error_code: str | None = None

    def reset(self) -> None:
        """丢弃缓存（测试/写入配置后使用）；不等待仍在跑的旧线程。"""
        with self._lock:
            self._generation += 1
            self._thread = None
            self._done = threading.Event()
            self._done.set()
            self._checked = False
            self._finished_at = None
            self._finished_monotonic = 0.0
            self._needs = None
            self._summary = None
            self._reason = ""
            self._error_code = None

    def start(self, *, force: bool = False) -> None:
        """确保后台检测已开始；缓存仍新鲜时不重复计算。立即返回。"""
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return
            fresh = (
                self._checked
                and self._finished_monotonic > 0
                and time.monotonic() - self._finished_monotonic < self._ttl
            )
            if fresh and not force:
                return
            self._checked = False
            self._done = threading.Event()
            self._generation += 1
            generation = self._generation
            thread = threading.Thread(
                target=self._run,
                args=(generation,),
                name="first-run-auto-configure",
                daemon=True,
            )
            self._thread = thread
            # 在锁内 start：保证其他线程看到 self._thread 时它已经可运行。
            thread.start()

    def wait(self, seconds: float) -> None:
        with self._lock:
            event = self._done
        if seconds and seconds > 0:
            event.wait(seconds)

    def snapshot(self) -> dict:
        with self._lock:
            if not self._checked:
                return {
                    "needsAutoConfigure": None,
                    "autoConfigure": None,
                    "reason": "检测中",
                    "checkedAt": None,
                }
            return {
                "needsAutoConfigure": self._needs,
                "autoConfigure": self._summary,
                "reason": self._reason,
                "checkedAt": self._finished_at,
            }

    def _run(self, generation: int) -> None:
        summary: dict | None = None
        needs: bool | None = False
        reason = ""
        error_code: str | None = None
        try:
            module = load_auto_configure()
            plan = module.build_plan(PROJECT_ROOT)
            raw_summary = module.public_summary(plan)
            if not isinstance(raw_summary, dict):
                raise ValueError("自动配置模块返回了无效的检测结果")
            summary = dict(raw_summary)
            errors = [str(item).strip() for item in (summary.get("errors") or []) if str(item).strip()]
            missing = not summary.get("profile") or not summary.get("patchPath")
            needs = not errors and not missing
            if errors:
                reason = "；".join(errors[:3])
            elif missing:
                reason = "未检测到可写入的 DSH profile 或 cordis.patch.yml"
        except AutoConfigureUnavailable as exc:
            summary = None
            needs = False
            reason = str(exc) + "；请按教程手工配置"
            error_code = "AUTO_CONFIGURE_UNAVAILABLE"
        except Exception as exc:  # 检测失败必须降级，不能拖垮客户端
            summary = None
            needs = False
            reason = f"自动配置检测失败（{type(exc).__name__}），请按教程手工配置"
        with self._lock:
            if generation != self._generation:
                return  # 已被 reset；丢弃过期结果
            self._checked = True
            self._needs = needs
            self._summary = summary
            self._reason = reason
            self._error_code = error_code
            self._finished_at = time.time()
            self._finished_monotonic = time.monotonic()
            self._thread = None
            self._done.set()


_first_run_detection = FirstRunDetectionCache()


def start_first_run_detection() -> None:
    """启动时预触发首次启动检测：只开后台线程，立即返回，绝不写文件。"""
    try:
        if not first_run_status()["firstRun"]:
            return
        _first_run_detection.start()
    except Exception as exc:  # 预触发失败不影响启动；前端请求时会再触发
        print(f"[client] 首次启动检测预触发失败：{type(exc).__name__}", flush=True)


def first_run_payload(*, refresh: bool = False, wait_seconds: float | None = None) -> dict:
    """组装 GET /api/client/first-run 的 `data`；检测 pending 时返回 null 并标记“检测中”。"""
    status = first_run_status()
    payload = {
        **status,
        "needsAutoConfigure": False,
        "autoConfigure": None,
        "reason": "",
        "checkedAt": None,
    }
    if not status["firstRun"]:
        payload["reason"] = "已完成首次配置"
        return payload
    if wait_seconds is None:
        wait_seconds = FIRST_RUN_WAIT_SECONDS
    _first_run_detection.start(force=refresh)
    _first_run_detection.wait(wait_seconds)
    payload.update(_first_run_detection.snapshot())
    return payload


def redact_home_path(value: str | None, home: str | None) -> str:
    """把用户 home 前缀替换为 ``~``（与 auto_configure.public_summary 的脱敏保持一致）。"""
    text = str(value or "")
    if not text or not home:
        return text
    variants = {home, home.replace("\\", "/"), home.replace("/", "\\")}
    for variant in sorted((item for item in variants if item), key=len, reverse=True):
        if text.lower().startswith(variant.lower()):
            return "~" + text[len(variant):]
    return text


def detected_data_dir(plan, summary: dict) -> str | None:
    """从检测结果取插件 dataDir 的真实绝对路径（``~`` 展开；相对路径拒绝）。

    优先用未脱敏的 ``plan.detected.dataDir``；退回 public_summary 中的值并展开 ``~``，
    保证写进客户端配置的是真实路径而不是 ``~``。
    """
    detected = getattr(plan, "detected", None)
    value = detected.get("dataDir") if isinstance(detected, dict) else None
    if not isinstance(value, str) or not value.strip():
        public_detected = summary.get("detected") if isinstance(summary, dict) else None
        value = public_detected.get("dataDir") if isinstance(public_detected, dict) else None
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        path = Path(value.strip()).expanduser()
    except (OSError, RuntimeError, ValueError):
        return None
    if not path.is_absolute():
        return None
    return str(path)


def write_client_config_for_plan(state: "ClientState", plan, summary: dict) -> dict:
    """apply 成功后把客户端连接配置指向检测到的 dataDir/令牌；写盘失败由调用方降级为 warning。"""
    result = {"updated": False, "baseUrl": None, "tokenFile": None, "dataDir": None}
    data_dir = detected_data_dir(plan, summary)
    if not data_dir:
        return result
    base_url = (state.admin_url or DEFAULT_ADMIN_URL).rstrip("/")
    token_file = str(Path(data_dir) / "admin-token.txt")
    save_settings(base_url, token_file, data_dir)
    # 让代理立即从新位置读取管理令牌，不再要求重启客户端。
    state.admin_url = base_url
    state.token_file = Path(token_file)
    state.data_dir = Path(data_dir)
    result.update(updated=True, baseUrl=base_url, tokenFile=token_file, dataDir=data_dir)
    return result


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
        self.executor = None

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

    def _drain_rejected_body(self) -> None:
        """403 前读掉有界请求体：未读的小 body 可能让 Windows 先重置连接。"""
        previous_timeout = self.connection.gettimeout()
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if 0 < length <= 65536:
                self.connection.settimeout(.5)
                self.rfile.read(length)
        except (OSError, ValueError):
            pass
        finally:
            self.connection.settimeout(previous_timeout)

    def _handle_proxy_write(self, method: str) -> None:
        if not self._is_loopback_request():
            self._drain_rejected_body()
            self._send_error_json(403, "拒绝非本机或跨站请求")
            return
        path = self.path.split("?", 1)[0]
        if path.startswith("/proxy/api/"):
            self._proxy(method, path)
        else:
            self._send_error_json(404, "未知端点")

    def do_DELETE(self) -> None:  # noqa: N802
        # 长期记忆与社交记忆的删除端点都由本机管理 API 提供；
        # 仍只接受本机回环请求，令牌只在服务端注入。
        self._handle_proxy_write("DELETE")

    def do_PATCH(self) -> None:  # noqa: N802
        # 社交记忆人物印象修正（PATCH /proxy/api/chat-memory/members/<id>）
        self._handle_proxy_write("PATCH")

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
        if path == "/api/client/executor":
            self._executor_info()
            return
        if path == "/api/client/discovery":
            self._discover_environment()
            return
        if path == "/api/client/locate-controls":
            self._locate_controls()
            return
        if path == "/api/client/setup-state":
            self._setup_state()
            return
        if path == FIRST_RUN_PATH:
            self._first_run()
            return
        if path == AUTO_CONFIGURE_PATH:
            self._auto_configure_preview()
            return
        if path == "/api/client/ping":
            self.state.touch()
            self._send_json(200, {"ok": True, "time": time.time()})
            return
        self._serve_static(path)

    def do_POST(self) -> None:  # noqa: N802
        if not self._is_loopback_request():
            # A small unread POST body can cause Windows to reset the socket
            # before the browser receives our 403. Drain only bounded bodies.
            self._drain_rejected_body()
            self._send_error_json(403, "只允许本机访问")
            return
        path = self.path.split("?", 1)[0]
        self.state.touch()
        try:
            if path == "/api/client/publish-mode":
                if self.headers.get("X-Requested-With") != "DSHMomentsClient":
                    self._send_error_json(403, "缺少本机客户端标记")
                    return
                payload = json.loads(self._read_body().decode("utf-8") or "{}")
                if not isinstance(payload, dict):
                    raise ValueError("请求体必须是对象")
                try:
                    result = change_publish_mode(self.state, payload)
                except urllib.error.HTTPError as exc:
                    body = json.loads(exc.read().decode("utf-8") or "{}")
                    self._send_error_json(exc.code, body.get("message", "请先重载新版 DSH 插件"))
                    return
                except (OSError, urllib.error.URLError) as exc:
                    self._send_error_json(502, "模式同步失败，执行器已保持仅准备；请检查插件并刷新后重试")
                    return
                self._send_json(200, {"ok": True, "data": result})
                return
            if path.startswith("/proxy/"):
                self._proxy("POST", path)
                return
            if path == "/api/client/config":
                self._save_client_config()
                return
            if path == "/api/client/setup-state":
                self._save_setup_state()
                return
            if path == AUTO_CONFIGURE_PATH:
                self._auto_configure_post()
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

    def _executor_info(self) -> None:
        executor = self.state.executor
        if executor is None:
            self._send_json(200, {"ok": True, "data": {"embedded": False}})
            return
        health = executor.app.health()
        status = executor.app.status()
        # 不把原始微信账号或任何令牌返回浏览器。
        status.pop("accountId", None)
        status.pop("notes", None)
        self._send_json(200, {"ok": True, "data": {
            "embedded": True, "pid": os.getpid(), "port": executor.server.server_port,
            "health": health, "status": status,
            "accountConfigured": bool(executor.app.config.expected_account_id),
            "declaredVersion": executor.app.config.assumed_client_version,
        }})

    def _client_config(self) -> None:
        settings = load_settings()
        if not CONFIG_PATH.is_file():
            settings = {"baseUrl": self.state.admin_url, "tokenFile": str(self.state.token_file), "dataDir": str(self.state.data_dir)}
        self._send_json(200, {"ok": True, "data": {"baseUrl": settings["baseUrl"], "tokenFile": settings["tokenFile"], "dataDir": settings["dataDir"]}})

    def _discover_environment(self) -> None:
        from client.discovery import discover, local_url
        global _discovery_cache, _discovery_cache_at
        if _discovery_cache is None or time.monotonic() - _discovery_cache_at > 30 or "refresh=1" in self.path:
            _discovery_cache = discover(PROJECT_ROOT)
            _discovery_cache_at = time.monotonic()
        data = json.loads(json.dumps(_discovery_cache))
        token = self.state.token()
        if token:
            class NoRedirect(urllib.request.HTTPRedirectHandler):
                def redirect_request(self, *args, **kwargs):
                    return None
            try:
                request = urllib.request.Request(self.state.admin_url + "/api/environment", headers={"X-Moments-Token": token})
                with urllib.request.build_opener(NoRedirect).open(request, timeout=2) as response:
                    active = json.loads(response.read(1024 * 1024)).get("data", {})
                if isinstance(active, dict) and Path(str(active.get("packageRoot", ""))).is_dir() and Path(str(active.get("adminTokenFile", ""))).is_file():
                    data["activePlugin"] = {key: active.get(key) for key in ("packageRoot", "dataDir")}
                    data["suggestedClientConfig"] = {"baseUrl": self.state.admin_url, "tokenFile": active["adminTokenFile"],
                        "dataDir": active["dataDir"], "source": "authenticated-running-plugin", "verified": True}
                    wechat = active.get("wechatAgent", {})
                    if isinstance(wechat, dict):
                        data["activeWechatConnection"] = {"readerBaseUrl": local_url(wechat.get("readerBaseUrl")),
                            "hookBaseUrl": local_url(wechat.get("hookBaseUrl")), "readerConfigPath": wechat.get("readerConfigPath")}
            except (OSError, ValueError, TypeError, KeyError):
                pass
        self._send_json(200, {"ok": True, "data": data})

    def _locate_controls(self) -> None:
        executor = self.state.executor
        driver = getattr(executor.app, "_driver", None) if executor is not None else None
        if not hasattr(driver, "inspect_controls"):
            self._send_json(200, {"ok": True, "data": {"supported": False, "message": "需要内置 geometry 执行器；UIA 驱动按控件定位。"}})
            return
        if not executor.app._exec_lock.acquire(blocking=False):
            self._send_error_json(409, "执行器正忙，请等待当前操作完成后再诊断")
            return
        try:
            result = driver.inspect_controls()
            self._send_json(200, {"ok": True, "data": result})
        except Exception as exc:
            self._send_error_json(422, getattr(exc, "message", "无法识别当前微信窗口，请检查窗口与 OCR"))
        finally:
            executor.app._exec_lock.release()

    def _save_client_config(self) -> None:
        body = self._read_body()
        try:
            payload = json.loads(body.decode("utf-8") or "{}")
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ValueError("请求体不是合法 JSON")
        if not isinstance(payload, dict):
            raise ValueError("请求体必须是 JSON 对象")
        base_url = str(payload.get("baseUrl", "")).strip() or DEFAULT_ADMIN_URL
        token_file = str(payload.get("tokenFile", "")).strip() or str(DEFAULT_TOKEN_FILE)
        data_dir = str(payload.get("dataDir", "")).strip() or str(DEFAULT_DATA_DIR)
        if not _is_loopback_url(base_url):
            raise ValueError("管理 API 地址只允许 http 回环地址")
        base_url = base_url.rstrip("/")
        def resolve_setting_path(value):
            path = Path(value).expanduser()
            return (path if path.is_absolute() else PROJECT_ROOT / path).resolve()
        token_path = resolve_setting_path(token_file)
        data_path = resolve_setting_path(data_dir)
        executor = self.state.executor
        changed_connection = base_url != self.state.admin_url or token_path != self.state.token_file.resolve()
        restart_required = executor is not None and data_path != self.state.data_dir.resolve()
        lock = executor.app._exec_lock if executor is not None and changed_connection else None
        if lock is not None and not lock.acquire(blocking=False):
            raise ValueError("桌面执行器正忙，不能切换管理连接；请等待任务结束")
        try:
            if executor is not None and changed_connection:
                apply_executor_mode(executor, "PREPARE_ONLY")
            save_settings(base_url, str(token_path), str(data_path))
            self.state.admin_url = base_url
            self.state.token_file = token_path
            if not restart_required:
                self.state.data_dir = data_path
        finally:
            if lock is not None:
                lock.release()
        self._send_json(200, {"ok": True, "data": {"baseUrl": base_url, "tokenFile": str(token_path),
            "dataDir": str(data_path), "restartRequired": restart_required,
            "modeSyncRequired": bool(executor is not None and changed_connection),
            "message": "连接配置已保存并生效" + ("；数据目录变更需重启客户端" if restart_required else "")}})

    def _setup_state(self) -> None:
        self._send_json(200, {"ok": True, "data": load_setup_state()})

    def _save_setup_state(self) -> None:
        body = self._read_body()
        try:
            payload = json.loads(body.decode("utf-8") or "{}")
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ValueError("请求体不是合法 JSON")
        if not isinstance(payload, dict):
            raise ValueError("请求体必须是 JSON 对象")
        state = load_setup_state()
        if "steps" in payload:
            steps = payload["steps"]
            if not isinstance(steps, dict):
                raise ValueError("steps 必须是对象")
            if len(steps) > 32:
                raise ValueError("steps 数量过多")
            for key, value in steps.items():
                if not isinstance(key, str) or not key or len(key) > 64:
                    raise ValueError("step id 非法")
                if not isinstance(value, bool):
                    raise ValueError("step 值必须是布尔")
                state["steps"][key] = value
        if "completed" in payload:
            if not isinstance(payload["completed"], bool):
                raise ValueError("completed 必须是布尔")
            state["completed"] = payload["completed"]
            if state["completed"]:
                state["completedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
            else:
                state["completedAt"] = None
        save_setup_state(state)
        self._send_json(200, {"ok": True, "data": state})

    # -- 首次启动自动配置引导 --------------------------------------------

    def _first_run(self) -> None:
        """只读：返回是否首次启动 + 后台检测的自动配置摘要；永不写文件。"""
        refresh = "refresh=1" in self.path
        try:
            payload = first_run_payload(refresh=refresh)
        except Exception as exc:  # 首次启动检测失败必须降级，不能阻塞进入应用
            payload = {
                "firstRun": True,
                "setupCompleted": False,
                "configMissing": True,
                "needsAutoConfigure": False,
                "autoConfigure": None,
                "reason": f"首次启动状态检测失败（{type(exc).__name__}），请按教程手工配置",
                "checkedAt": None,
            }
        self._send_json(200, {"ok": True, "data": payload})

    # -- 自动配置（首次配置向导第 06 步） --------------------------------

    def _auto_configure_summary(self, module, plan) -> dict:
        summary = module.public_summary(plan)
        if not isinstance(summary, dict):
            raise ValueError("自动配置模块返回了无效的检测结果")
        return dict(summary)

    def _auto_configure_build(self, module, profile):
        if profile:
            return module.build_plan(PROJECT_ROOT, profile=profile)
        return module.build_plan(PROJECT_ROOT)

    def _auto_configure_plan(self, module, profile):
        """构建计划；计划中的 errors 属于前置条件错误，映射为 400 中文说明。"""
        plan = self._auto_configure_build(module, profile)
        blockers = [str(item).strip() for item in (getattr(plan, "errors", None) or []) if str(item).strip()]
        if blockers:
            message = "；".join(blockers[:4])
            if len(blockers) > 4:
                message += f"；等 {len(blockers)} 项问题"
            raise ValueError(message)
        return plan

    def _auto_configure_preview(self) -> None:
        """只检测、生成预览与摘要；不写任何文件。"""
        try:
            module = load_auto_configure()
            plan = self._auto_configure_plan(module, None)
            self._send_json(200, {"ok": True, "data": self._auto_configure_summary(module, plan)})
        except AutoConfigureUnavailable as exc:
            self._send_error_json(503, str(exc), "AUTO_CONFIGURE_UNAVAILABLE")
        except ValueError as exc:
            self._send_error_json(400, auto_configure_error_message(exc))
        except Exception as exc:  # 检测失败不能拖垮客户端
            self._send_error_json(500, f"自动配置检测失败：{type(exc).__name__}")

    def _auto_configure_payload(self):
        """解析并校验 POST body：只允许 profile/apply 两个字段。"""
        raw = self._read_body()
        try:
            payload = json.loads(raw.decode("utf-8") or "{}")
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ValueError("请求体不是合法 JSON")
        if not isinstance(payload, dict):
            raise ValueError("请求体必须是 JSON 对象")
        unknown = sorted(str(key)[:64] for key in payload if key not in AUTO_CONFIGURE_FIELDS)
        if unknown:
            raise ValueError("未知字段：" + "、".join(unknown[:8]))
        profile = payload.get("profile")
        if profile is not None:
            if not isinstance(profile, str):
                raise ValueError("profile 必须是字符串")
            profile = profile.strip() or None
        apply_requested = payload.get("apply", False)
        if not isinstance(apply_requested, bool):
            raise ValueError("apply 必须是布尔值")
        return profile, apply_requested

    def _sync_client_config_after_apply(self, plan, summary: dict) -> dict:
        """apply 成功后把客户端连接指向插件 dataDir；写失败只 warning，不影响插件配置。"""
        public = {"updated": False, "baseUrl": None, "tokenFile": None, "dataDir": None}
        warnings = summary.get("warnings")
        if not isinstance(warnings, list):
            warnings = []
            summary["warnings"] = warnings
        try:
            written = write_client_config_for_plan(self.state, plan, summary)
        except Exception as exc:  # 客户端配置写失败不能推翻已经写入的插件配置
            warnings.append(
                f"客户端连接配置写入失败（{type(exc).__name__}），插件配置已写入；"
                "请在“设置 → 客户端配置”手动填写。"
            )
            return public
        if not written["updated"]:
            warnings.append(
                "未从检测结果确定插件数据目录，客户端连接配置未自动更新；"
                "请在“设置 → 客户端配置”手动填写。"
            )
            return public
        # 写入完成后旧的首次启动检测缓存已过期（changedFields/configMissing 可能变化）。
        _first_run_detection.reset()
        home = getattr(plan, "userHome", "") or ""
        return {
            "updated": True,
            "baseUrl": written["baseUrl"],
            "tokenFile": redact_home_path(written["tokenFile"], home),
            "dataDir": redact_home_path(written["dataDir"], home),
        }

    def _auto_configure_post(self) -> None:
        if self.headers.get("X-Requested-With") != "DSHMomentsClient":
            self._drain_rejected_body()
            self._send_error_json(403, "缺少本机客户端标记")
            return
        try:
            profile, apply_requested = self._auto_configure_payload()
        except ValueError as exc:
            self._send_error_json(400, str(exc))
            return
        if not apply_requested:
            try:
                module = load_auto_configure()
                plan = self._auto_configure_plan(module, profile)
                self._send_json(200, {"ok": True, "data": self._auto_configure_summary(module, plan)})
            except AutoConfigureUnavailable as exc:
                self._send_error_json(503, str(exc), "AUTO_CONFIGURE_UNAVAILABLE")
            except ValueError as exc:
                self._send_error_json(400, auto_configure_error_message(exc))
            except Exception as exc:
                self._send_error_json(500, f"自动配置检测失败：{type(exc).__name__}")
            return
        # 写入必须串行；构建与写入放在同一把锁内，避免基于过期文件生成计划。
        # 网络响应放在锁外，避免慢客户端拖住下一次写入。
        data = None
        failure = None
        with _auto_configure_apply_lock:
            try:
                module = load_auto_configure()
                plan = self._auto_configure_plan(module, profile)
                result = module.apply_plan(plan)
                summary = self._auto_configure_summary(module, result)
                summary["applied"] = True
                # public_summary 已脱敏备份路径（home→~）；绝不在这里用原始绝对路径覆盖。
                summary.setdefault("backupPath", None)
                summary["clientConfig"] = self._sync_client_config_after_apply(plan, summary)
                data = summary
            except AutoConfigureUnavailable as exc:
                failure = (503, str(exc), "AUTO_CONFIGURE_UNAVAILABLE")
            except ValueError as exc:
                failure = (400, auto_configure_error_message(exc), None)
            except Exception as exc:  # 未预期异常不伪造成功
                failure = (500, f"自动配置写入失败：{type(exc).__name__}", None)
        if data is not None:
            self._send_json(200, {"ok": True, "data": data})
        else:
            status, message, code = failure
            self._send_error_json(status, message, code)

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
        body = self._read_body() if method in ("POST", "PUT", "PATCH") else None
        url = self.state.admin_url + target_path
        request = urllib.request.Request(url, data=body, method=method)
        request.add_header("X-Moments-Token", token)
        if body is not None:
            request.add_header("Content-Type", self.headers.get("Content-Type", "application/json"))
        if target_path.startswith(("/api/workflow/", "/api/chat-memory/sync")):
            timeout = 240
        else:
            timeout = 90
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
    allow_reuse_address = os.name != "nt"


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


def browser_url(port: int, first_run: bool) -> str:
    """浏览器启动 URL；首次启动带 ``?firstrun=1`` 标记（hash 路由不受影响）。"""
    base = f"http://127.0.0.1:{port}/"
    return base + "?firstrun=1" if first_run else base


def watchdog(state: ClientState, server: ClientServer, idle_seconds: int = 60) -> None:
    while not state.stopping.wait(2):
        with state.lock:
            seen = state.ping_seen
            last = state.last_ping
        if seen and time.time() - last > idle_seconds:
            print("[client] 浏览器心跳停止，客户端自动退出", flush=True)
            state.stopping.set()
            server.shutdown()
            return


class EmbeddedExecutor:
    """执行器使用客户端进程内的线程，保留现有回环 HTTP 协议。"""

    def __init__(self, config, *, driver=None):
        from desktop.server import configure_logging, create_server, resolve_runtime_token

        self.logger = configure_logging(config.log_file, logger=logging.getLogger("dsh_moments.desktop.embedded"))
        try:
            token = resolve_runtime_token(config, logger=self.logger)
            self.server, self.app = create_server(config, driver=driver, token=token, logger=self.logger)
        except BaseException:
            self._close_logs()
            raise
        self.thread = threading.Thread(
            target=self.server.serve_forever, kwargs={"poll_interval": 0.2},
            name="embedded-desktop-executor", daemon=True,
        )
        try:
            self.thread.start()
        except BaseException:
            self.server.server_close()
            self._close_logs()
            raise

    def _close_logs(self):
        for handler in list(self.logger.handlers):
            self.logger.removeHandler(handler)
            handler.close()

    def close(self):
        self.app.request_shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()
        self._close_logs()


def is_admin() -> bool:
    return os.name == "nt" and bool(ctypes.windll.shell32.IsUserAnAdmin())


def elevate_client(argv: list[str]) -> int:
    """Windows 无法原地提升现有进程；只重新启动整个客户端，不创建独立执行器。"""
    shell_execute = ctypes.windll.shell32.ShellExecuteW
    shell_execute.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_wchar_p,
                              ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_int]
    shell_execute.restype = ctypes.c_void_p
    result = shell_execute(
        None, "runas", sys.executable,
        subprocess.list2cmdline(argv if FROZEN else ["-X", "utf8", str(Path(__file__).resolve()), *argv]),
        str(PROJECT_ROOT), 0,
    )
    if not result or result <= 32:
        print("管理员启动失败或 UAC 被取消；客户端与执行器均未启动。", file=sys.stderr)
        return 1
    print("[client] 已将启动交给管理员客户端；执行器将在该进程内运行。", flush=True)
    return 0


def build_executor_config(args):
    from desktop.config import ExecutorConfig

    data_dir = Path(args.data_dir).resolve()
    account = args.expected_account or os.environ.get("DSH_MOMENTS_EXPECTED_ACCOUNT", "")
    account_file = data_dir / "desktop-account.txt"
    if not account and account_file.is_file():
        account = account_file.read_text(encoding="utf-8-sig").strip()
    config = ExecutorConfig(
        port=args.executor_port, driver="geometry",
        token_file=str(data_dir / "desktop-token.txt"),
        screenshot_dir=str(data_dir / "desktop" / "screenshots"),
        asset_roots=(str(data_dir / "assets"),),
        log_file=str(data_dir / "desktop" / "executor.log"),
        expected_account_id=account.strip() or None,
        trusted_account_source="wechatagent" if account.strip() else "uia",
        assumed_client_version=args.client_version,
        ocr_python=sys.executable,
        mode="APPROVAL_REQUIRED" if args.allow_publish else "PREPARE_ONLY",
        allow_publish=args.allow_publish, geometry_allow_publish=args.allow_publish,
    )
    config.validate()
    return config


def run_server(host: str, port: int, admin_url: str, token_file: str, data_dir: str, open_browser: bool,
               *, executor_config=None) -> int:
    if host not in ("127.0.0.1", "localhost"):
        print("拒绝：客户端只允许监听 127.0.0.1", file=sys.stderr)
        return 2
    if not _is_loopback_url(admin_url):
        print("拒绝：管理 API 只允许 http 回环地址", file=sys.stderr)
        return 2
    if not WEB_ROOT.is_dir():
        print(f"拒绝：前端目录不存在 {WEB_ROOT}", file=sys.stderr)
        return 2
    # 内置 geometry 执行器使用物理像素坐标：客户端进程也必须先完成 DPI 感知。
    try:
        from desktop.window_locator import ensure_dpi_aware
        print(f"[client] 进程 DPI 感知：{ensure_dpi_aware()}", flush=True)
    except Exception as exc:  # 非 Windows 或导入失败时保持默认行为
        print(f"[client] DPI 感知初始化失败：{exc}", flush=True)
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
    executor = None
    if executor_config is not None:
        try:
            executor = EmbeddedExecutor(executor_config)
            state.executor = executor
            try:
                selected = plugin_mode_request(state)
                apply_executor_mode(executor, selected["mode"])
            except Exception:
                apply_executor_mode(executor, "PREPARE_ONLY")
                print("[client] 无法同步插件发表模式，执行器保持仅准备；请重载 DSH 插件后在设置中选择模式。", flush=True)
        except Exception as exc:
            server.server_close()
            print(f"桌面执行器启动失败：{exc}", file=sys.stderr)
            return 4
    first_run = first_run_status()
    url = browser_url(port, first_run["firstRun"])
    print(f"[client] DSH Moments Agent 客户端已启动：{url}", flush=True)
    print(f"[client] 管理 API：{admin_url}；令牌文件：{token_file}", flush=True)
    try:
        if executor is not None:
            print(f"[client] 桌面执行器已在同一进程启动：127.0.0.1:{executor.server.server_port} PID={os.getpid()}", flush=True)
        if first_run["firstRun"]:
            print("[client] 检测到首次启动：前端会显示自动配置引导（只读检测；写入需二次确认）。", flush=True)
            if open_browser:
                # 只有确实要打开浏览器时才预触发检测；--no-browser/测试进程不做无谓探测。
                start_first_run_detection()
        if open_browser:
            launch_browser(url)
        threading.Thread(target=watchdog, args=(state, server), daemon=True).start()
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        state.stopping.set()
        server.server_close()
        if executor is not None:
            executor.close()
        print("[client] 已退出", flush=True)
    return 0


def main(argv: list[str] | None = None) -> int:
    if os.name == "nt" and not FROZEN:
        try:
            dpi = ctypes.WinDLL("user32", use_last_error=True).SetProcessDpiAwarenessContext
            dpi.argtypes, dpi.restype = [ctypes.c_void_p], ctypes.c_bool
            dpi(ctypes.c_void_p(-4))
        except (AttributeError, OSError):
            pass
    settings = load_settings()
    if not CONFIG_PATH.is_file():
        from client.discovery import discover
        detected = discover(PROJECT_ROOT).get("suggestedClientConfig")
        if detected:
            settings.update({key: detected[key] for key in ("baseUrl", "tokenFile", "dataDir")})
    parser = argparse.ArgumentParser(description="DSH Moments Agent Web 客户端")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18770)
    parser.add_argument("--admin-url", default=settings["baseUrl"])
    parser.add_argument("--token-file", default=settings["tokenFile"])
    parser.add_argument("--data-dir", default=settings["dataDir"])
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--client-only", action="store_true", help="仅运行 Web 代理（诊断用，不启用执行器）")
    parser.add_argument("--executor-port", type=int, default=18765)
    parser.add_argument("--expected-account", default=None)
    parser.add_argument("--client-version", default="4.1.10.27")
    parser.add_argument("--allow-publish", action="store_true")
    parser.add_argument("--version", action="version", version=f"dsh-moments-client {VERSION}")
    argv = list(sys.argv[1:] if argv is None else argv)
    args = parser.parse_args(argv)
    executor_config = None
    if not args.client_only:
        try:
            executor_config = build_executor_config(args)
        except (ValueError, OSError) as exc:
            print(f"执行器配置错误：{exc}", file=sys.stderr)
            return 2
        if os.name == "nt" and not is_admin():
            return elevate_client(argv)
    # UAC 启动的服务不另开控制台，启动错误仍落盘供排查。
    with contextlib.ExitStack() as stack:
        if os.name == "nt" and not args.client_only:
            log_path = Path(args.data_dir) / "client-web.log"
            log_path.parent.mkdir(parents=True, exist_ok=True)
            log = stack.enter_context(log_path.open("a", encoding="utf-8", buffering=1))
            stack.enter_context(contextlib.redirect_stdout(log))
            stack.enter_context(contextlib.redirect_stderr(log))
        return run_server(
            args.host, args.port, args.admin_url.rstrip("/"),
            args.token_file, args.data_dir, not args.no_browser,
            executor_config=executor_config,
        )


if __name__ == "__main__":
    raise SystemExit(main())
