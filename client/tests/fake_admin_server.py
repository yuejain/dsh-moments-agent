"""假的本机管理 API（unittest 与界面截图演示用）。

只绑定 127.0.0.1 的随机端口，不访问网络、不接触真实数据库/凭据。
令牌由测试运行时随机生成，不写入仓库。

用法::

    server = FakeAdminServer()
    server.start()
    client = AdminApiClient(server.base_url, token_file)
    ...
    server.stop()

故障注入（用于验证客户端错误映射）：
- ``server.fail_next_status = 500``：下一个 /api 请求返回该 HTTP 状态；
- ``server.business_error = {"message": "...", "errorCode": "..."}``：
  下一个 /api 请求返回 HTTP 200 + ``ok=false``；
- ``server.delay_seconds = 0.5``：每个请求延迟响应（验证超时映射）。
"""

from __future__ import annotations

import json
import secrets
import struct
import threading
import time
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlsplit

PNG_MIME = "image/png"


# ----------------------------------------------------------------------
# 示例数据（故意包含中文与真实 API 字段，便于界面截图验收）
# ----------------------------------------------------------------------
def _approval(**overrides: Any) -> dict[str, Any]:
    record: dict[str, Any] = {
        "approvalId": "approval_demo_0001",
        "taskId": "task_demo_0001",
        "ownerId": "owner",
        "contentHash": "9f2c1d4b7a6e8f0c3b5d7e9a1c2f4b6d8e0a2c4f6b8d0e2a4c6f8b0d2e4a6c8f",
        "assetManifestHash": "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809",
        "visibility": "PUBLIC",
        "accountId": "wxid_demo_account",
        "nonce": "demo-nonce-0001",
        "status": "pending",
        "channel": "manual_admin",
        "createdAt": "2026-10-20T09:30:00.000Z",
        "expiresAt": "2026-10-20T11:30:00.000Z",
        "decidedAt": None,
        "consumedAt": None,
    }
    record.update(overrides)
    return record


def sample_health() -> dict[str, Any]:
    return {
        "ok": True,
        "plugin": "dsh-moments-agent",
        "version": "0.1.0",
        "dshVersion": "0.2.1-rc.2",
        "database": "ok",
        "killSwitch": False,
        "paused": False,
        "publishMode": "PREPARE_ONLY",
        "scheduleEnabled": False,
        "wechatAgent": {"status": "not_configured", "message": "未启用 WeChatAgent 适配器"},
        "desktopExecutor": {
            "status": "unavailable",
            "message": "桌面执行器不可用（示例数据）",
            "details": {
                "version": "4.1.15.13",
                "wechatInstalled": True,
                "wechatVersion": "4.1.15.13",
                "uiaAvailable": False,
                "allowPublish": False,
                "mode": "PREPARE_ONLY",
            },
        },
        "llm": {"status": "ok", "message": "DeepSeek 模型可用（示例数据）"},
        "images": {
            "status": "degraded",
            "message": "可用 Provider：manual-subscription, local-import",
            "details": {
                "capabilities": [
                    {"provider": "manual-subscription", "available": True},
                    {"provider": "local-import", "available": True},
                    {"provider": "local-generation", "available": False},
                ]
            },
        },
        "counts": {
            "DRAFT_READY": 1,
            "READY_FOR_APPROVAL": 1,
            "APPROVED": 1,
            "PUBLISHED": 2,
            "assets": 3,
        },
        "checkedAt": "2026-10-20T10:00:00.000Z",
    }


def sample_task() -> dict[str, Any]:
    return {
        "taskId": "task_demo_0001",
        "state": "READY_FOR_APPROVAL",
        "ideaId": "idea_demo_0001",
        "draftId": "draft_demo_0001",
        "visibility": "PUBLIC",
        "contentHash": "9f2c1d4b7a6e8f0c3b5d7e9a1c2f4b6d8e0a2c4f6b8d0e2a4c6f8b0d2e4a6c8f",
        "assetManifestHash": "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809",
        "accountId": "wxid_demo_account",
        "approvalId": "approval_demo_0001",
        "errorCode": None,
        "errorMessage": None,
        "createdAt": "2026-10-20T09:20:00.000Z",
        "updatedAt": "2026-10-20T09:30:00.000Z",
    }


def sample_assets() -> list[dict[str, Any]]:
    return [
        {
            "assetId": "asset_demo_0001",
            "sha256": "4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c",
            "mime": PNG_MIME,
            "width": 512,
            "height": 512,
            "source": "local_import",
            "license": "owner-authorized",
        },
        {
            "assetId": "asset_demo_0002",
            "sha256": "5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d",
            "mime": PNG_MIME,
            "width": 512,
            "height": 512,
            "source": "manual_subscription",
            "license": "owner-authorized",
        },
    ]


def sample_task_summary() -> dict[str, Any]:
    task = sample_task()
    return {
        "task": task,
        "idea": {
            "ideaId": "idea_demo_0001",
            "taskId": "task_demo_0001",
            "topic": "周二傍晚在河边走路的十分钟",
            "motivation": "记录一次无需刻意安排的散步，让注意力回到身体和环境。",
            "sourceType": "owner_topic",
            "sourceEvidence": "所有者指定主题：散步与城市噪音",
            "noveltyScore": 0.74,
            "personaScore": 0.81,
            "relevanceScore": 0.69,
            "riskFlags": [],
            "createdAt": "2026-10-20T09:20:00.000Z",
        },
        "draft": {
            "draftId": "draft_demo_0001",
            "taskId": "task_demo_0001",
            "ideaId": "idea_demo_0001",
            "version": 2,
            "text": (
                "河边那段路今天格外安静。\n\n"
                "走到桥下时，城市的噪音突然被水声盖住了一半。"
                "我没有戴耳机，也没有想事情，只是看着远处的灯一盏盏亮起来。\n\n"
                "有些放松不是计划出来的，是你刚好走到那里，刚好愿意停一会儿。"
            ),
            "tone": "克制、具体、不煽情",
            "createdAt": "2026-10-20T09:24:00.000Z",
            "updatedAt": "2026-10-20T09:28:00.000Z",
        },
        "assets": sample_assets(),
        "approval": _approval(),
        "approvals": [_approval()],
        "attempts": [
            {
                "attemptId": "attempt_demo_0001",
                "taskId": "task_demo_0001",
                "approvalId": "approval_demo_0001",
                "idempotencyKey": "idem_demo_0001",
                "contentHash": "9f2c1d4b7a6e8f0c3b5d7e9a1c2f4b6d8e0a2c4f6b8d0e2a4c6f8b0d2e4a6c8f",
                "assetManifestHash": "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809",
                "accountId": "wxid_demo_account",
                "state": "PLANNED",
                "mode": "PREPARE_ONLY",
                "createdAt": "2026-10-20T09:35:00.000Z",
                "updatedAt": "2026-10-20T09:35:00.000Z",
                "screenshotPath": None,
                "verification": None,
                "errorCode": None,
            }
        ],
        "attempt": None,
    }


def sample_task_detail() -> dict[str, Any]:
    summary = sample_task_summary()
    return {
        **summary,
        "preview": {
            "taskId": "task_demo_0001",
            "state": "READY_FOR_APPROVAL",
            "text": summary["draft"]["text"],
            "visibility": "PUBLIC",
            "accountId": "wxid_demo_account",
            "contentHash": summary["task"]["contentHash"],
            "assetManifestHash": summary["task"]["assetManifestHash"],
            "assets": [
                {
                    **asset,
                    "path": f"assets/demo/{asset['assetId']}.png",
                    "bytes": 4096,
                    "prompt": "",
                    "provider": "owner_upload",
                    "model": "",
                    "imageTaskId": None,
                    "perceptualHash": "0f0f0f0f0f0f0f0f",
                    "createdAt": "2026-10-20T09:25:00.000Z",
                }
                for asset in summary["assets"]
            ],
            "approvalRequired": True,
            "approvalId": "approval_demo_0001",
            "warnings": [],
        },
        "imageTasks": [
            {
                "imageTaskId": "image_task_demo_0001",
                "draftId": "draft_demo_0001",
                "taskId": "task_demo_0001",
                "prompt": "傍晚河边的散步视角，克制的城市光线",
                "negativePrompt": "不要出现人脸、文字",
                "aspectRatio": "1:1",
                "resolution": "1024x1024",
                "styleProfile": "静观、低饱和",
                "provider": "local_import",
                "status": "READY",
                "requiresUserAction": False,
                "attempts": 0,
                "lastError": None,
                "createdAt": "2026-10-20T09:22:00.000Z",
                "updatedAt": "2026-10-20T09:25:00.000Z",
                "expiresAt": "2026-10-21T09:22:00.000Z",
            }
        ],
        "draftVersions": [
            {
                "draftId": "draft_demo_0001",
                "version": 1,
                "text": "初稿示例：河边的灯亮起来，我停下来看了一会儿。",
                "contentHash": "aa11bb22cc33dd44ee55ff6600112233445566778899aabbccddeeff00112233",
                "createdAt": "2026-10-20T09:24:00.000Z",
            },
            {
                "draftId": "draft_demo_0001",
                "version": 2,
                "text": summary["draft"]["text"],
                "contentHash": "9f2c1d4b7a6e8f0c3b5d7e9a1c2f4b6d8e0a2c4f6b8d0e2a4c6f8b0d2e4a6c8f",
                "createdAt": "2026-10-20T09:28:00.000Z",
            },
        ],
        "audit": [
            {
                "eventId": "event_demo_0002",
                "at": "2026-10-20T09:30:00.000Z",
                "actor": "agent",
                "action": "request_approval",
                "taskId": "task_demo_0001",
                "previousState": "READY_FOR_APPROVAL",
                "nextState": "READY_FOR_APPROVAL",
                "reason": "等待所有者批准",
                "metadata": {"approvalId": "approval_demo_0001"},
            },
            {
                "eventId": "event_demo_0001",
                "at": "2026-10-20T09:20:00.000Z",
                "actor": "agent",
                "action": "task_created",
                "taskId": "task_demo_0001",
                "previousState": None,
                "nextState": "IDEA_CREATED",
                "reason": "示例任务",
                "metadata": {},
            },
        ],
    }


def sample_status() -> dict[str, Any]:
    return {
        "control": {
            "killSwitch": False,
            "paused": False,
            "pauseReason": "",
            "publishMode": "PREPARE_ONLY",
            "effectivePublishMode": "PREPARE_ONLY",
            "scheduleEnabled": False,
            "ownerChannel": "manual",
        },
        "accountId": "wxid_demo_account",
        "task": None,
        "attempts": [],
        "approvals": [],
        "imageTasks": [],
        "openTasks": [sample_task()],
        "pendingApprovals": [_approval()],
        "counts": {"DRAFT_READY": 1, "READY_FOR_APPROVAL": 1, "APPROVED": 1, "PUBLISHED": 2},
    }


def sample_history() -> dict[str, Any]:
    return {
        "published": [
            {
                "postId": "post_demo_0001",
                "taskId": "task_demo_0000",
                "attemptId": "attempt_demo_0000",
                "text": "雨停之后，楼下那家修表店的灯还亮着。老板说这块表再戴十年也没问题。",
                "visibility": "PUBLIC",
                "accountId": "wxid_demo_account",
                "contentHash": "bb22cc33dd44ee55ff6600112233445566778899aabbccddeeff00112233aa11",
                "publishedAt": "2026-10-19T12:10:00.000Z",
                "verified": True,
            }
        ],
        "ideas": [
            {
                "ideaId": "idea_demo_0001",
                "taskId": "task_demo_0001",
                "topic": "周二傍晚在河边走路的十分钟",
                "motivation": "记录一次无需刻意安排的散步。",
                "sourceType": "owner_topic",
                "sourceEvidence": "所有者指定主题",
                "noveltyScore": 0.74,
                "personaScore": 0.81,
                "relevanceScore": 0.69,
                "riskFlags": [],
                "createdAt": "2026-10-20T09:20:00.000Z",
            },
            {
                "ideaId": "idea_demo_0000",
                "taskId": "task_demo_0000",
                "topic": "旧物修理店与时间的刻度",
                "motivation": "从一次修表经历写耐心与工具。",
                "sourceType": "saved_opinion",
                "sourceEvidence": "个人笔记",
                "noveltyScore": 0.68,
                "personaScore": 0.77,
                "relevanceScore": 0.72,
                "riskFlags": ["UNVERIFIED_FACT"],
                "createdAt": "2026-10-19T11:40:00.000Z",
            },
        ],
    }


def sample_persona() -> dict[str, Any]:
    return {
        "soul": (
            "# 人格示例（只读）\n\n"
            "这是一个演示用的数字人格文本。真实内容来自 persona/SOUL.md。\n\n"
            "## 表达倾向\n"
            "- 克制、具体，优先写真实的观察与细节。\n"
            "- 不虚构现场、不冒充亲历、不使用夸张的排比。\n"
            "- 有不确定的地方就承认不确定。\n"
        ),
        "visualStyle": (
            "# 视觉风格示例（只读）\n\n"
            "- 低饱和、自然光、静物优先。\n"
            "- 避免出现可识别人脸与真实事件现场。\n"
            "- 1:1 与 4:3 为主。\n"
        ),
        "source": "persona/SOUL.md",
        "loadedAt": "2026-10-20T09:00:00.000Z",
    }


def sample_config() -> dict[str, Any]:
    return {
        "publishMode": "PREPARE_ONLY",
        "scheduleEnabled": False,
        "killSwitch": False,
        "ownerChannel": "manual",
        "llm": {"provider": "deepseek-account", "model": "deepseek-flash"},
        "wechatAgent": {
            "enabled": False,
            "readerBaseUrl": "http://127.0.0.1:11231",
            "hookBaseUrl": "http://127.0.0.1:11230",
            "ownerConfigured": False,
            "accountConfigured": False,
        },
        "desktopExecutor": {"enabled": False, "baseUrl": "http://127.0.0.1:18765"},
        "images": {"providers": ["manual-subscription", "local-import"], "officialApiEnabled": False},
        "policy": {
            "dailyLimit": 2,
            "minIntervalMinutes": 180,
            "quietHours": ["23:00", "08:00"],
            "requireApproval": True,
            "approvalTtlMinutes": 120,
            "minScoreToPublish": 0.62,
            "timeZone": "Asia/Shanghai",
        },
    }


DRAFT_WORKFLOW_RESULT: dict[str, Any] = {
    "silent": False,
    "taskId": "task_demo_0002",
    "review": {
        "passed": True,
        "notes": ["示例数据：隐私与来源检查通过"],
        "flags": [],
    },
    "approval": {
        "approval": _approval(approvalId="approval_demo_0002", taskId="task_demo_0002"),
        "request": {
            "approvalId": "approval_demo_0002",
            "taskId": "task_demo_0002",
            "contentHash": "9f2c1d4b7a6e8f0c3b5d7e9a1c2f4b6d8e0a2c4f6b8d0e2a4c6f8b0d2e4a6c8f",
            "visibility": "PUBLIC",
            "expiresAt": "2026-10-20T11:30:00.000Z",
            "ownerMessage": "请在所有者的管理客户端中批准这条朋友圈。",
        },
        "delivered": False,
    },
    "detail": sample_task_detail(),
}


# ----------------------------------------------------------------------
# 一张纯 Python 生成的渐变 PNG（无第三方库、无隐私内容）
# ----------------------------------------------------------------------
def make_png(width: int = 240, height: int = 240, seed: int = 0) -> bytes:
    raw = bytearray()
    for y in range(height):
        raw.append(0)  # filter type 0
        for x in range(width):
            r = 40 + (x * 120 // max(1, width - 1))
            g = 70 + (y * 110 // max(1, height - 1))
            b = 120 + ((x + y + seed * 40) * 70 // max(1, width + height - 2))
            raw.extend((min(r, 255), min(g, 255), min(b, 255)))

    def chunk(tag: bytes, payload: bytes) -> bytes:
        body = tag + payload
        return struct.pack(">I", len(payload)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b"")


# ----------------------------------------------------------------------
# HTTP 服务
# ----------------------------------------------------------------------
class FakeAdminServer:
    """可启停的假管理 API。"""

    def __init__(self, token: str | None = None) -> None:
        self.token = token or secrets.token_hex(32)
        self.requests: list[dict[str, Any]] = []
        self.lock = threading.Lock()
        self.fail_next_status: int | None = None
        self.business_error: dict[str, Any] | None = None
        self.raw_next: tuple[int, bytes, str] | None = None
        self.delay_seconds = 0.0
        self._httpd = _FakeHTTPServer(("127.0.0.1", 0), _FakeHandler)
        self._httpd.fake_state = self
        self._thread: threading.Thread | None = None

    # -- 生命周期 ------------------------------------------------------
    @property
    def port(self) -> int:
        return int(self._httpd.server_address[1])

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def start(self) -> "FakeAdminServer":
        self._thread = threading.Thread(target=self._httpd.serve_forever, name="fake-admin-api", daemon=True)
        self._thread.start()
        return self

    def stop(self) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()
        if self._thread is not None:
            self._thread.join(timeout=5)
            self._thread = None

    def __enter__(self) -> "FakeAdminServer":
        return self.start()

    def __exit__(self, *_exc: Any) -> None:
        self.stop()

    # -- 断言辅助 ------------------------------------------------------
    @property
    def last_request(self) -> dict[str, Any] | None:
        with self.lock:
            return self.requests[-1] if self.requests else None

    def requests_for(self, path: str) -> list[dict[str, Any]]:
        with self.lock:
            return [item for item in self.requests if item["path"] == path]

    def record(self, item: dict[str, Any]) -> None:
        with self.lock:
            self.requests.append(item)

    def pop_failure(self) -> tuple[int | None, dict[str, Any] | None, tuple[int, bytes, str] | None]:
        with self.lock:
            status = self.fail_next_status
            self.fail_next_status = None
            business = self.business_error
            self.business_error = None
            raw = self.raw_next
            self.raw_next = None
        return status, business, raw


class _FakeHTTPServer(ThreadingHTTPServer):
    """把 FakeAdminServer 状态挂到 httpd 上供 handler 访问。"""

    daemon_threads = True
    fake_state: "FakeAdminServer"


class _FakeHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "FakeAdminAPI/1.0"

    # 避免把测试请求打印到 stderr
    def log_message(self, *_args: Any) -> None:  # noqa: D102
        return

    @property
    def fake(self) -> FakeAdminServer:
        server = self.server
        assert isinstance(server, _FakeHTTPServer)
        return server.fake_state

    # -- 工具 ----------------------------------------------------------
    def _record(self, method: str, body_raw: bytes) -> Any:
        body_json: Any = None
        if body_raw:
            try:
                body_json = json.loads(body_raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                body_json = None
        self.fake.record(
            {
                "method": method,
                "path": urlsplit(self.path).path,
                "raw_path": self.path,
                "headers": {key.lower(): value for key, value in self.headers.items()},
                "body_raw": body_raw,
                "body": body_json,
            }
        )
        return body_json

    def _read_body(self) -> bytes:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        return self.rfile.read(length) if length > 0 else b""

    def _send_json(self, status: int, payload: Any) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _send_bytes(self, status: int, data: bytes, mime: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _maybe_delay(self) -> None:
        delay = self.fake.delay_seconds
        if delay > 0:
            time.sleep(delay)

    # -- 分发 ----------------------------------------------------------
    def do_GET(self) -> None:  # noqa: N802
        try:
            self._dispatch("GET")
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    def do_POST(self) -> None:  # noqa: N802
        try:
            self._dispatch("POST")
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    def _dispatch(self, method: str) -> None:
        body_raw = self._read_body() if method == "POST" else b""
        body = self._record(method, body_raw)
        self._maybe_delay()

        fail_status, business, raw_next = self.fake.pop_failure()
        if raw_next is not None:
            status, payload_bytes, mime = raw_next
            self.send_response(status)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(payload_bytes)))
            self.end_headers()
            self.wfile.write(payload_bytes)
            return
        if fail_status is not None:
            self._send_json(fail_status, {"ok": False, "message": "模拟内部错误", "errorCode": "INTERNAL_ERROR"})
            return
        if business is not None:
            self._send_json(200, {"ok": False, **business})
            return

        path = urlsplit(self.path).path
        if not path.startswith("/api/"):
            self._send_json(404, {"ok": False, "message": "未知端点"})
            return

        supplied = self.headers.get("X-Moments-Token") or ""
        authorization = self.headers.get("Authorization") or ""
        if authorization.startswith("Bearer "):
            supplied = authorization[7:].strip()
        if supplied != self.fake.token:
            self._send_json(401, {"ok": False, "message": "缺少或错误的本机管理令牌"})
            return

        query = parse_qs(urlsplit(self.path).query)

        if method == "GET" and path == "/api/health":
            self._send_json(200, {"ok": True, "data": sample_health()})
            return
        if method == "GET" and path == "/api/status":
            self._send_json(200, {"ok": True, "data": sample_status()})
            return
        if method == "GET" and path == "/api/tasks":
            self._send_json(200, {"ok": True, "data": [sample_task_summary()]})
            return
        if method == "GET" and path == "/api/tasks/task_demo_0001":
            self._send_json(200, {"ok": True, "data": sample_task_detail()})
            return
        if method == "GET" and path.startswith("/api/tasks/"):
            if "task_demo" not in path:
                self._send_json(404, {"ok": False, "message": "未知端点或方法"})
                return
            self._send_json(200, {"ok": True, "data": sample_task_detail()})
            return
        if method == "GET" and path == "/api/persona":
            self._send_json(200, {"ok": True, "data": sample_persona()})
            return
        if method == "GET" and path == "/api/config":
            self._send_json(200, {"ok": True, "data": sample_config()})
            return
        if method == "GET" and path == "/api/approvals":
            self._send_json(200, {"ok": True, "data": [_approval()]})
            return
        if method == "GET" and path == "/api/history":
            self._send_json(200, {"ok": True, "data": sample_history()})
            return
        if method == "GET" and path.startswith("/api/assets/") and path.endswith("/raw"):
            asset_id = path.split("/")[3]
            seed = 1 if "0002" in asset_id else 0
            self._send_bytes(200, make_png(240, 240, seed=seed), PNG_MIME)
            return
        if method == "GET" and path.startswith("/api/preview/"):
            self._send_json(200, {"ok": True, "data": sample_task_detail()["preview"]})
            return

        if method == "POST" and path == "/api/workflow/draft":
            result = json.loads(json.dumps(DRAFT_WORKFLOW_RESULT))
            if isinstance(body, dict) and body.get("topic") == "触发沉默":
                self._send_json(200, {"ok": True, "data": {"silent": True, "reason": "示例：模型判断没有值得表达的内容", "taskId": None}})
                return
            self._send_json(200, {"ok": True, "data": result})
            return
        if method == "POST" and path.endswith("/compose"):
            self._send_json(
                200,
                {
                    "ok": True,
                    "data": {
                        "composed": sample_task_summary()["draft"],
                        "review": {"passed": True, "notes": ["示例：重写后审核通过"], "flags": []},
                        "approval": DRAFT_WORKFLOW_RESULT["approval"],
                        "detail": sample_task_detail(),
                    },
                },
            )
            return
        if method == "POST" and path.endswith("/review"):
            self._send_json(
                200,
                {
                    "ok": True,
                    "data": {
                        "review": {"passed": True, "notes": ["示例：只审核通过"], "flags": []},
                        "approval": DRAFT_WORKFLOW_RESULT["approval"],
                        "detail": sample_task_detail(),
                    },
                },
            )
            return
        if method == "POST" and path.endswith("/request-approval"):
            self._send_json(200, {"ok": True, "data": DRAFT_WORKFLOW_RESULT["approval"]})
            return
        if method == "POST" and path.endswith("/prepare"):
            self._send_json(
                200,
                {
                    "ok": True,
                    "data": {
                        "attempt": sample_task_summary()["attempts"][0],
                        "task": sample_task(),
                        "prepared": True,
                        "screenshotPath": "data/desktop/screenshots/demo-prepare.png",
                        "textMatched": True,
                        "imageCount": 2,
                        "warnings": ["示例数据：未点击发表"],
                        "idempotent": False,
                    },
                },
            )
            return
        if method == "POST" and path.endswith("/publish"):
            self._send_json(
                200,
                {
                    "ok": False,
                    "message": "当前发布模式为 PREPARE_ONLY，真实发表被拒绝",
                    "errorCode": "PUBLISH_MODE_DISABLED",
                },
            )
            return
        if method == "POST" and path.endswith("/cancel"):
            self._send_json(200, {"ok": True, "data": {**sample_task(), "state": "CANCELLED"}})
            return
        if method == "POST" and "/approvals/" in path and (path.endswith("/approve") or path.endswith("/reject")):
            status = "approved" if path.endswith("/approve") else "rejected"
            self._send_json(200, {"ok": True, "data": _approval(status=status)})
            return
        if method == "POST" and path in ("/api/pause", "/api/resume", "/api/kill", "/api/unkill"):
            paused = path == "/api/pause"
            kill = path == "/api/kill"
            self._send_json(200, {"ok": True, "data": {"paused": paused, "killSwitch": kill}})
            return
        if method == "POST" and path.startswith("/api/uncertain/") and path.endswith("/resolve"):
            self._send_json(
                200,
                {
                    "ok": True,
                    "data": {
                        "attempt": {**sample_task_summary()["attempts"][0], "state": "VERIFIED" if body and body.get("resolution") == "PUBLISHED" else "FAILED"},
                        "verification": {"verified": True, "method": "manual", "notes": ["示例：人工核对"]},
                    },
                },
            )
            return
        if method == "POST" and path.startswith("/api/attempts/") and path.endswith("/verify"):
            attempt_id = path.split("/")[3]
            if "missing" in attempt_id:
                self._send_json(500, {"ok": False, "message": "发布尝试不存在"})
                return
            self._send_json(
                200,
                {
                    "ok": True,
                    "data": {
                        "attempt": {**sample_task_summary()["attempts"][0], "state": "VERIFIED"},
                        "verification": {
                            "verified": True,
                            "method": "desktop_dom",
                            "publishedAt": "2026-10-20T10:10:00.000Z",
                            "visibleText": sample_task_summary()["draft"]["text"][:40],
                            "imageCount": 2,
                            "evidencePath": "data/desktop/screenshots/demo-verify.png",
                            "notes": ["示例：桌面执行器核验通过"],
                        },
                        "task": {**sample_task(), "state": "PUBLISHED"},
                    },
                },
            )
            return

        self._send_json(404, {"ok": False, "message": "未知端点或方法"})
