"""本机管理 API v1 客户端（requests 不可用，仅使用标准库）。

对应契约：``docs/architecture/admin-api.md``。

设计要点：
- UI 不直接拼 HTTP；所有网络访问都经过本模块。
- 管理令牌只在发起请求时从令牌文件读取，不保存在内存以外的任何地方，
  也绝不写入配置、日志、异常文本或界面。
- 只允许回环地址（127.0.0.1 / localhost / ::1），避免令牌被发送到远程服务。
- 错误统一映射为 :class:`ApiError`，``kind`` 区分
  config / connection / timeout / auth / http / business / protocol，
  ``user_message()`` 给出简体中文提示。
- 所有请求显式设置超时：普通 20s，创作/重写/审核 120s，准备 150s，发表 180s。

注意：``POST /api/attempts/{attemptId}/verify`` 已由插件实现（``runtime.verify``），
用于 UNCERTAIN 的自动核验；不会重试发表。UNCERTAIN 的人工核对仍走
``POST /api/uncertain/{attemptId}/resolve``。
"""

from __future__ import annotations

import json
import socket
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

TOKEN_HEADER = "X-Moments-Token"

DEFAULT_TIMEOUT = 20.0
WORKFLOW_TIMEOUT = 120.0
PREPARE_TIMEOUT = 150.0
PUBLISH_TIMEOUT = 180.0

_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})
_SAFE_SCHEMES = frozenset({"http"})


def redact_secret(text: object, secret: str) -> str:
    """把令牌从任意文本中抹掉（防御性措施，正常情况下不会发生）。"""
    value = "" if text is None else str(text)
    if secret:
        value = value.replace(secret, "***")
    return value


def normalize_base_url(value: object) -> str:
    """校验并规范化管理 API 地址：必须是 http 回环地址且带端口。"""
    raw = "" if value is None else str(value).strip()
    if raw == "":
        raise ApiError("管理 API 地址为空：请在设置页填写 http://127.0.0.1:18766。", kind="config")
    parsed = urllib.parse.urlsplit(raw)
    if parsed.scheme.lower() not in _SAFE_SCHEMES:
        raise ApiError("管理 API 只支持 http:// 回环地址（例如 http://127.0.0.1:18766）。", kind="config")
    host = (parsed.hostname or "").lower()
    if host not in _LOOPBACK_HOSTS:
        raise ApiError(
            "管理 API 只允许回环地址（127.0.0.1 / localhost / ::1），"
            "请勿把管理令牌发送到其他主机。",
            kind="config",
        )
    try:
        port = parsed.port
    except ValueError as exc:
        raise ApiError(f"管理 API 地址端口非法：{raw}", kind="config") from exc
    if port is None:
        raise ApiError("管理 API 地址缺少端口，请填写类似 http://127.0.0.1:18766 的地址。", kind="config")
    if not (1 <= port <= 65535):
        raise ApiError(f"管理 API 地址端口超出范围：{raw}", kind="config")
    if parsed.path not in ("", "/") or parsed.query or parsed.fragment:
        raise ApiError("管理 API 地址不能包含路径、查询参数或片段，请只填写 http://主机:端口。", kind="config")
    if host == "::1":
        return f"http://[::1]:{port}"
    return f"http://{host}:{port}"


class ApiError(Exception):
    """管理 API 调用失败。

    ``kind`` 取值：
    - ``config``     本地配置/令牌文件问题（请求未发出）
    - ``connection`` 网络不可达/连接被拒绝
    - ``timeout``    请求超时
    - ``auth``       HTTP 401（令牌缺失或错误）
    - ``http``       其他非 2xx HTTP 状态
    - ``business``   HTTP 200 且 ``ok=false``（带 errorCode）
    - ``protocol``   响应不是约定的 JSON 结构
    """

    def __init__(
        self,
        message: str,
        *,
        kind: str = "error",
        status: int | None = None,
        error_code: str | None = None,
        details: dict[str, object] | None = None,
    ) -> None:
        super().__init__(message)
        self.kind = kind
        self.status = status
        self.error_code = error_code
        self.details = details or {}

    def user_message(self) -> str:
        """给用户看的中文提示（调用方直接放进 messagebox）。"""
        message = str(self)
        if self.kind == "auth":
            return (
                message
                + "\n\n请确认：\n"
                "1. DSH 已加载 dsh-moments-agent 插件，且配置 adminServer.enabled: true；\n"
                "2. 设置页里的令牌文件路径指向 <项目>/data/admin-token.txt；\n"
                "3. 若刚重新启用插件，令牌文件可能已重新生成，请重新读取。"
            )
        if self.kind == "connection":
            return (
                message
                + "\n\n请确认：\n"
                "1. DSH 正在运行且插件已启用 adminServer；\n"
                "2. 设置页的管理 API 地址与端口（默认 18766）正确；\n"
                "3. 管理 API 只绑定 127.0.0.1，必须在本机运行客户端。"
            )
        if self.kind == "timeout":
            return message + "\n\n长任务可能仍在服务端执行：请稍后点刷新查看任务状态，不要重复提交写操作。"
        if self.kind == "config":
            return message + "\n\n可在“设置”页修改管理 API 地址与令牌文件路径；令牌内容不会显示或保存。"
        if self.kind == "business" and self.error_code:
            return f"{message}\n\n错误码：{self.error_code}"
        return message


class AdminApiClient:
    """本机管理 API 客户端。

    用法::

        client = AdminApiClient("http://127.0.0.1:18766", Path("data/admin-token.txt"))
        health = client.health()
        client.approve(approval_id)
    """

    def __init__(
        self,
        base_url: str,
        token_file: str | Path,
        *,
        timeout: float = DEFAULT_TIMEOUT,
        workflow_timeout: float = WORKFLOW_TIMEOUT,
        prepare_timeout: float = PREPARE_TIMEOUT,
        publish_timeout: float = PUBLISH_TIMEOUT,
    ) -> None:
        self.base_url = normalize_base_url(base_url)
        self.token_file = Path(token_file).expanduser()
        self.timeout = float(timeout)
        self.workflow_timeout = float(workflow_timeout)
        self.prepare_timeout = float(prepare_timeout)
        self.publish_timeout = float(publish_timeout)

    # ------------------------------------------------------------------
    # 令牌与底层请求
    # ------------------------------------------------------------------
    def _read_token(self) -> str:
        """每次请求前从令牌文件读取令牌；不缓存、不记录、不返回给 UI。"""
        path = self.token_file
        try:
            raw = path.read_text(encoding="utf-8")
        except FileNotFoundError as exc:
            raise ApiError(
                f"找不到管理令牌文件：{path}",
                kind="config",
                details={"token_file": str(path)},
            ) from exc
        except IsADirectoryError as exc:
            raise ApiError(f"管理令牌路径是目录而不是文件：{path}", kind="config") from exc
        except OSError as exc:
            raise ApiError(f"无法读取管理令牌文件：{path}（{exc.strerror or exc}）", kind="config") from exc
        token = raw.strip()
        if token == "":
            raise ApiError(f"管理令牌文件内容为空：{path}", kind="config")
        if len(token) < 32:
            raise ApiError(
                f"管理令牌文件内容过短（{len(token)} 字符）：{path}；"
                "服务端要求至少 32 位，请重新启用插件以生成有效令牌。",
                kind="config",
            )
        return token

    def _request(
        self,
        method: str,
        path: str,
        *,
        query: dict[str, object] | None = None,
        body: dict[str, object] | None = None,
        timeout: float | None = None,
    ) -> tuple[bytes, int, str]:
        url = self.base_url + path
        if query:
            filtered = {key: value for key, value in query.items() if value is not None}
            if filtered:
                url = url + "?" + urllib.parse.urlencode(filtered)
        token = self._read_token()
        headers = {
            TOKEN_HEADER: token,
            "Accept": "application/json",
            "User-Agent": "dsh-moments-client/0.1.0",
        }
        data: bytes | None = None
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json; charset=utf-8"
        request = urllib.request.Request(url, data=data, headers=headers, method=method.upper())
        effective_timeout = self.timeout if timeout is None else float(timeout)

        try:
            with urllib.request.urlopen(request, timeout=effective_timeout) as response:
                raw = response.read()
                status = int(getattr(response, "status", 200))
                content_type = response.headers.get("Content-Type", "") or ""
            return raw, status, content_type
        except urllib.error.HTTPError as exc:
            raw = b""
            try:
                raw = exc.read()
            except OSError:
                raw = b""
            raise self._http_error(exc.code, raw, path, token) from None
        except (TimeoutError, socket.timeout) as exc:
            raise ApiError(
                f"请求超时（{effective_timeout:.0f} 秒）：{path}",
                kind="timeout",
                details={"path": path, "timeout": effective_timeout},
            ) from exc
        except urllib.error.URLError as exc:
            reason = exc.reason
            if isinstance(reason, (TimeoutError, socket.timeout)):
                raise ApiError(
                    f"请求超时（{effective_timeout:.0f} 秒）：{path}",
                    kind="timeout",
                    details={"path": path, "timeout": effective_timeout},
                ) from exc
            detail = redact_secret(reason, token)
            raise ApiError(
                f"无法连接本机管理 API（{self.base_url}）：{detail}",
                kind="connection",
                details={"base_url": self.base_url, "reason": detail},
            ) from exc
        except (ConnectionError, OSError) as exc:
            detail = redact_secret(exc, token)
            raise ApiError(
                f"无法连接本机管理 API（{self.base_url}）：{detail}",
                kind="connection",
                details={"base_url": self.base_url, "reason": detail},
            ) from exc

    def _http_error(self, status: int, raw: bytes, path: str, token: str) -> ApiError:
        message = ""
        error_code = ""
        if raw:
            try:
                payload = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                payload = None
            if isinstance(payload, dict):
                if isinstance(payload.get("message"), str):
                    message = redact_secret(payload["message"], token)
                if isinstance(payload.get("errorCode"), str):
                    error_code = payload["errorCode"]
        if status == 401:
            return ApiError("认证失败（HTTP 401）：管理令牌缺失或不正确。", kind="auth", status=status)
        if status == 403:
            return ApiError("请求被拒绝（HTTP 403）：管理 API 只允许本机回环访问。", kind="http", status=status)
        if status == 404:
            return ApiError(
                f"端点不存在（HTTP 404）：{path}。当前插件版本可能不支持该操作。",
                kind="http",
                status=status,
            )
        detail = f"服务端消息：{message}" if message else "服务端未返回中文消息"
        code_text = f"；错误码：{error_code}" if error_code else ""
        return ApiError(
            f"服务端返回 HTTP {status}。{detail}{code_text}",
            kind="http",
            status=status,
            error_code=error_code or None,
        )

    def _api(
        self,
        method: str,
        path: str,
        *,
        query: dict[str, object] | None = None,
        body: dict[str, object] | None = None,
        timeout: float | None = None,
    ) -> object:
        raw, status, _content_type = self._request(method, path, query=query, body=body, timeout=timeout)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ApiError(
                f"服务端返回的不是合法 JSON（{path}）。",
                kind="protocol",
                status=status,
            ) from exc
        if not isinstance(payload, dict):
            raise ApiError(f"服务端返回结构异常（{path}）：顶层必须是 JSON 对象。", kind="protocol", status=status)
        if payload.get("ok") is True:
            return payload.get("data")
        if payload.get("ok") is False:
            message = payload.get("message")
            error_code = payload.get("errorCode")
            message_text = message if isinstance(message, str) and message.strip() else "后端返回业务失败"
            code_text = error_code if isinstance(error_code, str) and error_code.strip() else None
            prefix = f"后端拒绝（错误码 {code_text}）：" if code_text else "后端拒绝："
            raise ApiError(prefix + message_text, kind="business", status=status, error_code=code_text)
        # 兼容没有 ok 信封的响应（例如直接返回数组）。
        return payload.get("data", payload)

    # ------------------------------------------------------------------
    # 只读端点
    # ------------------------------------------------------------------
    def health(self) -> dict[str, object]:
        data = self._api("GET", "/api/health")
        return data if isinstance(data, dict) else {}

    def status(self, task_id: str | None = None) -> dict[str, object]:
        data = self._api("GET", "/api/status", query={"taskId": task_id})
        return data if isinstance(data, dict) else {}

    def tasks(self, limit: int = 100) -> list[dict[str, object]]:
        data = self._api("GET", "/api/tasks", query={"limit": int(limit)})
        return data if isinstance(data, list) else []

    def task_detail(self, task_id: str) -> dict[str, object]:
        data = self._api("GET", f"/api/tasks/{urllib.parse.quote(str(task_id), safe='')}")
        return data if isinstance(data, dict) else {}

    def preview(self, task_id: str) -> dict[str, object]:
        data = self._api("GET", f"/api/preview/{urllib.parse.quote(str(task_id), safe='')}")
        return data if isinstance(data, dict) else {}

    def persona(self) -> dict[str, object]:
        data = self._api("GET", "/api/persona")
        return data if isinstance(data, dict) else {}

    def config_summary(self) -> dict[str, object]:
        data = self._api("GET", "/api/config")
        return data if isinstance(data, dict) else {}

    def approvals(self) -> list[dict[str, object]]:
        data = self._api("GET", "/api/approvals")
        return data if isinstance(data, list) else []

    def history(self, limit: int = 20) -> dict[str, object]:
        data = self._api("GET", "/api/history", query={"limit": int(limit)})
        return data if isinstance(data, dict) else {}

    def asset_raw(self, asset_id: str) -> tuple[bytes, str]:
        """读取素材原始字节；返回 (bytes, mime)。"""
        raw, _status, content_type = self._request(
            "GET",
            f"/api/assets/{urllib.parse.quote(str(asset_id), safe='')}/raw",
        )
        mime = content_type.split(";")[0].strip() if content_type else "application/octet-stream"
        return raw, mime

    # ------------------------------------------------------------------
    # 写入/长任务端点
    # ------------------------------------------------------------------
    def workflow_draft(
        self,
        *,
        topic: str | None = None,
        source_type: str | None = None,
        source_evidence: str | None = None,
        motivation: str | None = None,
    ) -> dict[str, object]:
        """一键创作：选题 -> 文案 -> 审核 -> 申请审批（绝不准备/发表）。"""
        body: dict[str, object] = {}
        if topic is not None and topic.strip():
            body["topic"] = topic.strip()
        if source_type is not None and source_type.strip():
            body["sourceType"] = source_type.strip()
        if source_evidence is not None and source_evidence.strip():
            body["sourceEvidence"] = source_evidence.strip()
        if motivation is not None and motivation.strip():
            body["motivation"] = motivation.strip()
        data = self._api("POST", "/api/workflow/draft", body=body, timeout=self.workflow_timeout)
        return data if isinstance(data, dict) else {}

    def compose(self, task_id: str, *, tone: str | None = None, feedback: str | None = None) -> dict[str, object]:
        """重写草稿并重新审核。"""
        body: dict[str, object] = {}
        if tone is not None and tone.strip():
            body["tone"] = tone.strip()
        if feedback is not None and feedback.strip():
            body["feedback"] = feedback.strip()
        path = f"/api/tasks/{urllib.parse.quote(str(task_id), safe='')}/compose"
        data = self._api("POST", path, body=body, timeout=self.workflow_timeout)
        return data if isinstance(data, dict) else {}

    def review(self, task_id: str) -> dict[str, object]:
        """只重新审核当前草稿（不重写）。"""
        path = f"/api/tasks/{urllib.parse.quote(str(task_id), safe='')}/review"
        data = self._api("POST", path, body={}, timeout=self.workflow_timeout)
        return data if isinstance(data, dict) else {}

    def request_approval(self, task_id: str) -> dict[str, object]:
        path = f"/api/tasks/{urllib.parse.quote(str(task_id), safe='')}/request-approval"
        data = self._api("POST", path, body={}, timeout=self.workflow_timeout)
        return data if isinstance(data, dict) else {}

    def prepare(self, task_id: str) -> dict[str, object]:
        """打开朋友圈编辑界面并填入图文（不点击发表）。"""
        path = f"/api/tasks/{urllib.parse.quote(str(task_id), safe='')}/prepare"
        data = self._api("POST", path, body={}, timeout=self.prepare_timeout)
        return data if isinstance(data, dict) else {}

    def publish(self, task_id: str, approval_id: str | None = None) -> dict[str, object]:
        """真实发表；默认配置下后端返回 PUBLISH_MODE_DISABLED。"""
        body: dict[str, object] = {}
        if approval_id is not None and str(approval_id).strip():
            body["approvalId"] = str(approval_id).strip()
        path = f"/api/tasks/{urllib.parse.quote(str(task_id), safe='')}/publish"
        data = self._api("POST", path, body=body, timeout=self.publish_timeout)
        return data if isinstance(data, dict) else {}

    def cancel(self, task_id: str) -> dict[str, object]:
        path = f"/api/tasks/{urllib.parse.quote(str(task_id), safe='')}/cancel"
        data = self._api("POST", path, body={}, timeout=self.timeout)
        return data if isinstance(data, dict) else {}

    def approve(self, approval_id: str, reason: str | None = None) -> dict[str, object]:
        body: dict[str, object] = {}
        if reason is not None and reason.strip():
            body["reason"] = reason.strip()
        path = f"/api/approvals/{urllib.parse.quote(str(approval_id), safe='')}/approve"
        data = self._api("POST", path, body=body, timeout=self.timeout)
        return data if isinstance(data, dict) else {}

    def reject(self, approval_id: str, reason: str | None = None) -> dict[str, object]:
        body: dict[str, object] = {}
        if reason is not None and reason.strip():
            body["reason"] = reason.strip()
        path = f"/api/approvals/{urllib.parse.quote(str(approval_id), safe='')}/reject"
        data = self._api("POST", path, body=body, timeout=self.timeout)
        return data if isinstance(data, dict) else {}

    def resolve_uncertain(self, attempt_id: str, resolution: str, note: str) -> dict[str, object]:
        """人工核对 UNCERTAIN：resolution 只能是 PUBLISHED 或 FAILED。"""
        if resolution not in ("PUBLISHED", "FAILED"):
            raise ApiError("resolution 必须是 PUBLISHED 或 FAILED。", kind="config")
        path = f"/api/uncertain/{urllib.parse.quote(str(attempt_id), safe='')}/resolve"
        data = self._api("POST", path, body={"resolution": resolution, "note": note}, timeout=self.timeout)
        return data if isinstance(data, dict) else {}

    # ------------------------------------------------------------------
    # 所有者控制
    # ------------------------------------------------------------------
    def pause(self, reason: str | None = None) -> dict[str, object]:
        return self._control("/api/pause", reason)

    def resume(self, reason: str | None = None) -> dict[str, object]:
        return self._control("/api/resume", reason)

    def kill(self, reason: str | None = None) -> dict[str, object]:
        return self._control("/api/kill", reason)

    def unkill(self, reason: str | None = None) -> dict[str, object]:
        return self._control("/api/unkill", reason)

    def _control(self, path: str, reason: str | None) -> dict[str, object]:
        body: dict[str, object] = {}
        if reason is not None and reason.strip():
            body["reason"] = reason.strip()
        data = self._api("POST", path, body=body, timeout=self.timeout)
        return data if isinstance(data, dict) else {}

    # ------------------------------------------------------------------
    # 发布尝试核验
    # ------------------------------------------------------------------
    def verify_attempt(self, attempt_id: str) -> dict[str, object]:
        """核验一次发布尝试（调用 ``POST /api/attempts/{attemptId}/verify``）。

        返回 ``{ attempt, verification, task }``。确认成功才会把任务收敛为
        ``PUBLISHED``；不会重试发表。
        """
        path = f"/api/attempts/{urllib.parse.quote(str(attempt_id), safe='')}/verify"
        data = self._api("POST", path, body={}, timeout=self.workflow_timeout)
        return data if isinstance(data, dict) else {}

    def attempt_status(self, task_id: str) -> dict[str, object]:
        """读取任务及其发布尝试的当前状态（只读，用于展示）。

        真正的核验请使用 :meth:`verify_attempt`。
        """
        return self.status(task_id)

    def test_connection(self) -> dict[str, object]:
        """设置页“测试连接”：返回 health 摘要。"""
        return self.health()
