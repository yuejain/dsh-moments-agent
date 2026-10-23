"""DSH Moments Agent —— Windows 桌面执行器 HTTP 服务。

只监听 127.0.0.1，所有请求必须携带 ``X-Moments-Token``。端点、JSON 字段与
错误码见 ``docs/architecture/desktop-executor-protocol.md``。

安全边界：
- 默认 PREPARE_ONLY 且绝不点击发表；只有同时 ``--allow-publish`` 与
  ``mode=APPROVAL_REQUIRED`` 时才允许；
- 请求体上限 8 MiB；token 缺失/错误返回 401；未知端点 404；方法错误 405；
- 所有资产路径与截图目录必须位于配置的根目录内，拒绝 ``..``、绝对路径逃逸、
  符号链接/重解析点；
- token 与正文不写入日志；错误响应不回显 token。
"""
from __future__ import annotations

import argparse
import dataclasses
import hmac
import json
import logging
import os
import signal
import sys
import threading
import time
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import unquote, urlsplit

if __package__ in (None, ""):  # 允许 ``python desktop/server.py`` 直接运行
    _REPO_ROOT = Path(__file__).resolve().parent.parent
    if str(_REPO_ROOT) not in sys.path:
        sys.path.insert(0, str(_REPO_ROOT))
    from desktop.account_guard import AccountGuard
    from desktop.config import (
        DEFAULT_PORT,
        MAX_ASSETS,
        MAX_BODY_BYTES,
        MAX_ID_LENGTH,
        MAX_PATH_LENGTH,
        MAX_TEXT_LENGTH,
        VERSION,
        ConfigError,
        ExecutorConfig,
        ExecutorError,
        PathGuardError,
        Verification,
        describe_config,
        is_within,
        load_config_file,
        load_or_create_token,
        normalize_path,
        read_token_file,
        require_content_hash,
        require_id_field,
        require_visibility,
        resolve_under,
        safe_filename_component,
        utc_now_iso,
        validate_token,
        write_token_file,
    )
    from desktop.moments_editor import MomentsEditor, PreparedSnapshot
    from desktop.moments_verifier import MomentsVerifier
    from desktop.wechat_driver import RealWechatDriver, WechatDriver
    from desktop.window_locator import WindowLocator
else:
    from .account_guard import AccountGuard
    from .config import (
        DEFAULT_PORT,
        MAX_ASSETS,
        MAX_BODY_BYTES,
        MAX_ID_LENGTH,
        MAX_PATH_LENGTH,
        MAX_TEXT_LENGTH,
        VERSION,
        ConfigError,
        ExecutorConfig,
        ExecutorError,
        PathGuardError,
        Verification,
        describe_config,
        is_within,
        load_config_file,
        load_or_create_token,
        normalize_path,
        read_token_file,
        require_content_hash,
        require_id_field,
        require_visibility,
        resolve_under,
        safe_filename_component,
        utc_now_iso,
        validate_token,
        write_token_file,
    )
    from .moments_editor import MomentsEditor, PreparedSnapshot
    from .moments_verifier import MomentsVerifier
    from .wechat_driver import RealWechatDriver, WechatDriver
    from .window_locator import WindowLocator

_LOGGER = logging.getLogger("dsh_moments.desktop.server")

DEFAULT_TOKEN_FILE = os.path.join("data", "desktop-token.txt")
MAX_PREPARED_ATTEMPTS = 64
MAX_REQUEST_LOG_PATH = 200


# ---------------------------------------------------------------------------
# 日志
# ---------------------------------------------------------------------------


def configure_logging(log_file: str | None, *, level: int = logging.INFO, logger: logging.Logger | None = None) -> logging.Logger:
    """配置执行器日志；token 与正文不会写入日志。"""
    target = logger or _LOGGER
    target.setLevel(level)
    target.handlers.clear()
    formatter = logging.Formatter(
        fmt="%(asctime)s %(levelname)s %(name)s %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
    )
    stream = logging.StreamHandler(sys.stderr)
    stream.setFormatter(formatter)
    stream.setLevel(level)
    target.addHandler(stream)
    if log_file:
        try:
            parent = os.path.dirname(os.path.abspath(log_file))
            if parent:
                os.makedirs(parent, exist_ok=True)
            file_handler = logging.FileHandler(log_file, encoding="utf-8")
            file_handler.setFormatter(formatter)
            file_handler.setLevel(level)
            target.addHandler(file_handler)
        except OSError as exc:
            target.warning("无法打开日志文件（%s），仅输出到 stderr", type(exc).__name__)
    return target


# ---------------------------------------------------------------------------
# 应用层（与 HTTP 解耦，便于直接单元测试）
# ---------------------------------------------------------------------------


class ExecutorApp:
    """桌面执行器应用状态与业务端点实现。"""

    def __init__(
        self,
        config: ExecutorConfig,
        *,
        driver: WechatDriver | None = None,
        token: str,
        logger: logging.Logger | None = None,
    ) -> None:
        config.validate()
        self.config = config
        self._token = token
        self.logger = logger or _LOGGER
        self._screenshot_dir = normalize_path(config.screenshot_dir)
        self._asset_roots = tuple(normalize_path(root) for root in config.asset_roots)
        self._driver = driver or RealWechatDriver(config, locator=WindowLocator(), logger=self.logger)
        self._guard = AccountGuard(
            expected_account_id=config.expected_account_id,
            supported_versions=config.supported_versions,
            trusted_account_source=config.trusted_account_source,
            assumed_client_version=config.assumed_client_version,
        )
        self._verifier = MomentsVerifier(self._driver, config, logger=self.logger)
        self._editor = MomentsEditor(
            self._driver,
            self._guard,
            config,
            self._verifier,
            logger=self.logger,
        )
        self._exec_lock = threading.Lock()
        self._state_lock = threading.Lock()
        self._prepared: OrderedDict[str, PreparedSnapshot] = OrderedDict()
        self._verifications: dict[str, Verification] = {}
        self._submitted: set[str] = set()
        self._cancelled: set[str] = set()
        self._cancel_events: dict[str, threading.Event] = {}
        self._active_attempt: str | None = None
        self._active_kind: str | None = None
        self._shutdown_hook: Any | None = None
        self._stopping = threading.Event()
        self.started_at = utc_now_iso()
        self.logger.info(
            "桌面执行器初始化：%s",
            json.dumps(describe_config(config), ensure_ascii=False),
        )
        if not self._driver.uia_available:
            self.logger.warning("UI Automation 客户端库不可用，真实 GUI 操作将被拒绝（DESKTOP_UNSUPPORTED）")

    # -- 生命周期 ---------------------------------------------------------

    def attach_shutdown(self, hook: Any) -> None:
        self._shutdown_hook = hook

    def request_shutdown(self) -> None:
        self._stopping.set()
        with self._state_lock:
            for event in self._cancel_events.values():
                event.set()
        hook = self._shutdown_hook
        if hook is not None:
            hook()

    @property
    def stopping(self) -> bool:
        return self._stopping.is_set()

    @property
    def driver(self) -> WechatDriver:
        return self._driver

    # -- 认证 -------------------------------------------------------------

    def authorize(self, candidate: str | None) -> bool:
        if not candidate:
            return False
        try:
            return hmac.compare_digest(candidate.encode("utf-8"), self._token.encode("utf-8"))
        except (UnicodeError, TypeError):
            return False

    # -- 健康 / 状态 ------------------------------------------------------

    def health(self) -> dict[str, Any]:
        installation = self._driver.get_installation()
        uia_available = bool(self._driver.uia_available)
        effective_allow_publish = self.config.effective_allow_publish
        if not installation.installed:
            message = "微信客户端未安装或未找到；仅支持 Mock 与准备流程测试，禁止发表"
        elif not uia_available:
            message = (
                f"微信客户端已安装（{installation.version or '版本未知'}），"
                "但 Windows UI Automation 客户端库缺失，真实 GUI 操作不可用；"
                "仅支持准备流程的 Mock 测试，真实发布未测试"
            )
        elif not effective_allow_publish:
            message = (
                f"微信客户端已安装（{installation.version or '版本未知'}）；"
                "当前为只准备模式，禁止点击发表"
            )
        else:
            message = (
                f"微信客户端已安装（{installation.version or '版本未知'}）；"
                "控件树尚未验证，发表前必须人工确认，禁止自动重试"
            )
        return {
            "ok": True,
            "version": VERSION,
            "wechatInstalled": bool(installation.installed),
            "wechatVersion": installation.version if installation.installed else None,
            "uiaAvailable": uia_available,
            "allowPublish": effective_allow_publish,
            "mode": self.config.mode,
            "message": message,
        }

    def status(self) -> dict[str, Any]:
        try:
            client_status = self._driver.get_status(timeout=self.config.status_timeout)
            payload = {"ok": True}
            payload.update(client_status.to_dict())
            return payload
        except ExecutorError as exc:
            payload = {"ok": False, "errorCode": exc.code, "message": exc.message}
            payload.update(
                {
                    "running": False,
                    "loggedIn": False,
                    "accountId": None,
                    "version": None,
                    "interactive": False,
                    "locked": False,
                    "supported": False,
                    "windowTitle": None,
                    "dpiScale": None,
                    "notes": [exc.message],
                }
            )
            return payload
        except Exception as exc:  # 保持响应结构稳定，避免插件解析崩溃
            self.logger.exception("读取微信状态未预期异常")
            payload = {
                "ok": False,
                "errorCode": "INTERNAL_ERROR",
                "message": f"读取微信状态失败（{type(exc).__name__}）",
                "running": False,
                "loggedIn": False,
                "accountId": None,
                "version": None,
                "interactive": False,
                "locked": False,
                "supported": False,
                "windowTitle": None,
                "dpiScale": None,
                "notes": ["读取状态异常"],
            }
            return payload

    # -- prepare ----------------------------------------------------------

    def _validate_prepare_payload(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        if not isinstance(payload, Mapping):
            raise ExecutorError("BAD_REQUEST", "请求体必须是 JSON 对象")
        task_id = require_id_field(payload, "taskId")
        attempt_id = require_id_field(payload, "attemptId")
        raw_text = payload.get("text")
        if not isinstance(raw_text, str):
            raise ExecutorError("BAD_REQUEST", "字段 text 必须是字符串")
        max_text = min(int(self.config.max_text_length), MAX_TEXT_LENGTH)
        if len(raw_text) > max_text:
            raise ExecutorError("BAD_REQUEST", f"text 过长（最多 {max_text} 字符）")
        raw_assets = payload.get("assetPaths")
        if not isinstance(raw_assets, list):
            raise ExecutorError("BAD_REQUEST", "assetPaths 必须是字符串数组")
        max_images = min(int(self.config.max_images), MAX_ASSETS)
        if len(raw_assets) > max_images:
            raise ExecutorError("BAD_REQUEST", f"assetPaths 数量超过上限 {max_images}")
        resolved_assets: list[str] = []
        for index, item in enumerate(raw_assets):
            if not isinstance(item, str) or not item.strip():
                raise ExecutorError("BAD_REQUEST", f"assetPaths[{index}] 必须是非空字符串")
            if len(item) > MAX_PATH_LENGTH:
                raise ExecutorError("BAD_REQUEST", f"assetPaths[{index}] 过长")
            try:
                resolved = resolve_under(self._asset_roots, item, must_exist_file=True)
            except PathGuardError as exc:
                raise ExecutorError("BAD_REQUEST", f"assetPaths[{index}] 非法：{exc}") from exc
            resolved_assets.append(resolved)
        visibility = require_visibility(payload)
        content_hash = require_content_hash(payload)
        account_id = require_id_field(payload, "accountId")
        raw_screenshot_dir = payload.get("screenshotDir")
        if not isinstance(raw_screenshot_dir, str) or not raw_screenshot_dir.strip():
            raise ExecutorError("BAD_REQUEST", "screenshotDir 必须是非空字符串")
        try:
            screenshot_dir = resolve_under((self._screenshot_dir,), raw_screenshot_dir)
        except PathGuardError as exc:
            raise ExecutorError("BAD_REQUEST", f"screenshotDir 非法：{exc}") from exc
        if os.path.normcase(screenshot_dir) != os.path.normcase(self._screenshot_dir):
            raise ExecutorError("BAD_REQUEST", "screenshotDir 必须与执行器配置的截图目录一致")
        return {
            "taskId": task_id,
            "attemptId": attempt_id,
            "text": raw_text,
            "assetPaths": resolved_assets,
            "visibility": visibility,
            "contentHash": content_hash,
            "accountId": account_id,
            "screenshotDir": screenshot_dir,
        }

    def prepare(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        try:
            request = self._validate_prepare_payload(payload)
        except ExecutorError as exc:
            return self._prepare_failure(exc.code, exc.message)
        except Exception as exc:
            self.logger.exception("prepare 请求校验未预期异常")
            return self._prepare_failure("INTERNAL_ERROR", f"请求校验失败（{type(exc).__name__}）")

        attempt_id = request["attemptId"]
        if not self._exec_lock.acquire(blocking=False):
            return self._prepare_failure("EXECUTOR_BUSY", "已有执行中的任务，请稍后重试")
        cancel_event = threading.Event()
        try:
            with self._state_lock:
                self._active_attempt = attempt_id
                self._active_kind = "prepare"
                self._cancel_events[attempt_id] = cancel_event
                self._cancelled.discard(attempt_id)
            self.logger.info("收到 prepare 请求 attemptId=%s", attempt_id)
            outcome = self._editor.prepare(request, cancel_event=cancel_event)
            if outcome.snapshot is not None:
                with self._state_lock:
                    self._prepared[attempt_id] = outcome.snapshot
                    while len(self._prepared) > MAX_PREPARED_ATTEMPTS:
                        self._prepared.popitem(last=False)
            return outcome.to_dict()
        except Exception as exc:  # editor 已捕获业务异常，这里是最后一道防线
            self.logger.exception("prepare 未预期异常 attemptId=%s", attempt_id)
            return self._prepare_failure("INTERNAL_ERROR", f"准备流程发生未预期异常（{type(exc).__name__}）")
        finally:
            with self._state_lock:
                self._cancel_events.pop(attempt_id, None)
                self._active_attempt = None
                self._active_kind = None
            self._exec_lock.release()

    @staticmethod
    def _prepare_failure(code: str, message: str, *, text_matched: bool = False, image_count: int = 0) -> dict[str, Any]:
        return {
            "ok": False,
            "prepared": False,
            "screenshotPath": None,
            "textMatched": text_matched,
            "imageCount": image_count,
            "warnings": [message] if message else [],
            "errorCode": code,
            "message": message,
        }

    # -- publish ----------------------------------------------------------

    def _validate_publish_payload(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        if not isinstance(payload, Mapping):
            raise ExecutorError("BAD_REQUEST", "请求体必须是 JSON 对象")
        task_id = require_id_field(payload, "taskId")
        attempt_id = require_id_field(payload, "attemptId")
        content_hash = require_content_hash(payload)
        account_id = require_id_field(payload, "accountId")
        approval_raw = payload.get("approvalId")
        if approval_raw is not None and not isinstance(approval_raw, str):
            raise ExecutorError("BAD_REQUEST", "approvalId 必须是字符串")
        approval_id = (approval_raw or "").strip()
        if len(approval_id) > MAX_ID_LENGTH:
            raise ExecutorError("BAD_REQUEST", "approvalId 过长")
        return {
            "taskId": task_id,
            "attemptId": attempt_id,
            "contentHash": content_hash,
            "accountId": account_id,
            "approvalId": approval_id,
        }

    def publish(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        try:
            request = self._validate_publish_payload(payload)
        except ExecutorError as exc:
            return self._publish_failure(exc.code, exc.message)
        except Exception as exc:
            self.logger.exception("publish 请求校验未预期异常")
            return self._publish_failure("INTERNAL_ERROR", f"请求校验失败（{type(exc).__name__}）")

        # 1) 发布权限：默认 PREPARE_ONLY 或未显式 --allow-publish 时，这里是死路。
        if not self.config.effective_allow_publish:
            return self._publish_failure(
                "PUBLISH_MODE_DISABLED",
                "未开启发表权限（需要 --allow-publish 且 mode=APPROVAL_REQUIRED），未点击发表",
            )
        # 2) 审批 ID
        if not request["approvalId"]:
            return self._publish_failure("APPROVAL_REQUIRED", "缺少审批 ID，未点击发表")
        attempt_id = request["attemptId"]
        with self._state_lock:
            snapshot = self._prepared.get(attempt_id)
            already_submitted = attempt_id in self._submitted
            verification = self._verifications.get(attempt_id)
            cancelled = attempt_id in self._cancelled
        if already_submitted:
            return {
                "ok": False,
                "submitted": True,
                "verified": bool(verification.verified) if verification is not None else False,
                "uncertain": bool(verification is None or not verification.verified),
                "screenshotPath": verification.evidence_path if verification is not None else None,
                "verification": verification.to_dict() if verification is not None else None,
                "errorCode": "ALREADY_SUBMITTED",
                "message": "该 attempt 已经点击过发表，禁止重复点击",
            }
        if cancelled:
            return self._publish_failure("CANCELLED", "该 attempt 已取消，未点击发表")
        if snapshot is None:
            return self._publish_failure(
                "BAD_REQUEST",
                "没有该 attempt 的准备记录，必须先在同一执行器进程内完成 prepare",
            )
        # 3) contentHash / accountId 必须与 prepare 记录一致
        if request["contentHash"].lower() != snapshot.content_hash.lower():
            return self._publish_failure("CONTENT_CHANGED", "contentHash 与准备记录不一致，未点击发表，需重新审批")
        if request["accountId"] != snapshot.account_id:
            return self._publish_failure("ACCOUNT_MISMATCH", "accountId 与准备记录不一致，未点击发表，需重新审批")
        if request["taskId"] != snapshot.task_id:
            return self._publish_failure("BAD_REQUEST", "taskId 与准备记录不一致，未点击发表")

        if not self._exec_lock.acquire(blocking=False):
            return self._publish_failure("EXECUTOR_BUSY", "已有执行中的任务，请稍后重试")
        cancel_event = threading.Event()
        try:
            with self._state_lock:
                self._active_attempt = attempt_id
                self._active_kind = "publish"
                self._cancel_events[attempt_id] = cancel_event
            self.logger.info("收到 publish 请求 attemptId=%s approvalId=%s", attempt_id, request["approvalId"])
            outcome = self._editor.publish(
                snapshot,
                request,
                allow_publish=True,
                cancel_event=cancel_event,
            )
            with self._state_lock:
                if outcome.submitted:
                    self._submitted.add(attempt_id)
                if outcome.verification is not None:
                    self._verifications[attempt_id] = outcome.verification
            return outcome.to_dict()
        except Exception as exc:
            # 已进入 publish 且无法确定点击是否发生：保守返回 uncertain。
            self.logger.exception("publish 未预期异常 attemptId=%s", attempt_id)
            with self._state_lock:
                self._submitted.add(attempt_id)
            return {
                "ok": False,
                "submitted": True,
                "verified": False,
                "uncertain": True,
                "screenshotPath": snapshot.screenshot_path,
                "verification": None,
                "errorCode": "UNCERTAIN",
                "message": f"发布流程发生未预期异常（{type(exc).__name__}），无法确认结果，禁止自动重试",
            }
        finally:
            with self._state_lock:
                self._cancel_events.pop(attempt_id, None)
                self._active_attempt = None
                self._active_kind = None
            self._exec_lock.release()

    @staticmethod
    def _publish_failure(
        code: str,
        message: str,
        *,
        submitted: bool = False,
        uncertain: bool = False,
        verification: Verification | None = None,
        screenshot_path: str | None = None,
    ) -> dict[str, Any]:
        return {
            "ok": False,
            "submitted": submitted,
            "verified": bool(verification.verified) if verification is not None else False,
            "uncertain": uncertain,
            "screenshotPath": screenshot_path,
            "verification": verification.to_dict() if verification is not None else None,
            "errorCode": code,
            "message": message,
        }

    # -- verify / preview / cancel ---------------------------------------

    def verify(self, attempt_id: str) -> tuple[int, dict[str, Any]]:
        try:
            safe_filename_component(attempt_id, name="attemptId")
        except PathGuardError:
            return 404, {"ok": False, "errorCode": "NOT_FOUND", "message": "attemptId 非法或核验记录不存在"}
        with self._state_lock:
            verification = self._verifications.get(attempt_id)
        if verification is None:
            return 404, {"ok": False, "errorCode": "NOT_FOUND", "message": "没有该 attempt 的核验记录"}
        return 200, verification.to_dict()

    def preview(self, attempt_id: str) -> tuple[int, Any, str]:
        """返回 (HTTP 状态码, PNG 字节或 JSON 字典, Content-Type)。"""
        try:
            safe_filename_component(attempt_id, name="attemptId")
        except PathGuardError:
            return 404, {"ok": False, "errorCode": "PREVIEW_NOT_FOUND", "message": "attemptId 非法"}, "application/json"
        candidates: list[str] = []
        with self._state_lock:
            snapshot = self._prepared.get(attempt_id)
            verification = self._verifications.get(attempt_id)
        # 发布后的核验证据优先于 prepare 阶段截图。
        if verification is not None and verification.evidence_path:
            candidates.append(verification.evidence_path)
        if snapshot is not None and snapshot.screenshot_path:
            candidates.append(snapshot.screenshot_path)
        for suffix in (".png", "-prepared.png", "-published.png"):
            candidates.append(os.path.join(self._screenshot_dir, f"{attempt_id}{suffix}"))
        for candidate in candidates:
            try:
                resolved = resolve_under((self._screenshot_dir,), candidate, must_exist_file=True)
            except PathGuardError:
                continue
            if not is_within(self._screenshot_dir, resolved):
                continue
            try:
                data = Path(resolved).read_bytes()
            except OSError:
                continue
            if not data.startswith(b"\x89PNG\r\n\x1a\n"):
                continue
            return 200, data, "image/png"
        return 404, {"ok": False, "errorCode": "PREVIEW_NOT_FOUND", "message": "该 attempt 没有可用截图"}, "application/json"

    def cancel(self, payload: Mapping[str, Any]) -> tuple[int, dict[str, Any]]:
        try:
            attempt_id = require_id_field(payload, "attemptId")
        except ExecutorError as exc:
            return 200, {"ok": False, "cancelled": False, "errorCode": exc.code, "message": exc.message}
        except Exception:
            return 200, {"ok": False, "cancelled": False, "errorCode": "BAD_REQUEST", "message": "取消请求非法"}
        with self._state_lock:
            submitted = attempt_id in self._submitted
            event = self._cancel_events.get(attempt_id)
            active_kind = self._active_kind if self._active_attempt == attempt_id else None
            self._cancelled.add(attempt_id)
        if submitted:
            return 200, {
                "ok": True,
                "cancelled": False,
                "errorCode": "ALREADY_SUBMITTED",
                "message": "已点击发表，无法取消；请人工核对朋友圈",
            }
        if event is not None:
            event.set()
            message = "已请求停止；未点击发表" if active_kind == "prepare" else "已请求停止；发表点击结果请以 publish 响应为准"
            return 200, {"ok": True, "cancelled": True, "message": message}
        return 200, {"ok": True, "cancelled": True, "message": "已请求停止；未点击发表"}

    # -- 调试用 -----------------------------------------------------------

    def snapshot_summary(self) -> dict[str, Any]:
        """仅用于测试/诊断，不含正文与 token。"""
        with self._state_lock:
            return {
                "preparedAttempts": list(self._prepared.keys()),
                "submittedAttempts": sorted(self._submitted),
                "verificationAttempts": list(self._verifications.keys()),
                "activeAttempt": self._active_attempt,
                "activeKind": self._active_kind,
            }


# ---------------------------------------------------------------------------
# HTTP 层
# ---------------------------------------------------------------------------


class _HttpError(Exception):
    def __init__(
        self,
        status: int,
        payload: dict[str, Any],
        *,
        headers: Mapping[str, str] | None = None,
        close: bool = False,
    ) -> None:
        super().__init__(payload.get("message", ""))
        self.status = status
        self.payload = payload
        self.headers = dict(headers or {})
        self.close = close


_EXACT_ROUTES: dict[str, tuple[frozenset[str], str]] = {
    "/health": (frozenset({"GET"}), "health"),
    "/wechat/status": (frozenset({"GET"}), "status"),
    "/moments/prepare": (frozenset({"POST"}), "prepare"),
    "/moments/publish": (frozenset({"POST"}), "publish"),
    "/moments/cancel": (frozenset({"POST"}), "cancel"),
}
_PREFIX_ROUTES: tuple[tuple[str, frozenset[str], str], ...] = (
    ("/moments/preview/", frozenset({"GET"}), "preview"),
    ("/moments/verify/", frozenset({"GET"}), "verify"),
)


class ExecutorRequestHandler(BaseHTTPRequestHandler):
    """受限 JSON over HTTP 的请求处理器。"""

    server_version = f"DSHMomentsDesktop/{VERSION}"
    sys_version = ""
    protocol_version = "HTTP/1.1"

    # 避免把默认访问日志写到 stderr 且不受脱敏控制。
    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - 覆盖父类签名
        app = getattr(self.server, "app", None)
        if app is not None:
            app.logger.debug("http %s - %s", format % args, getattr(self, "address_string", lambda: "-")())

    # -- 入口 -------------------------------------------------------------

    def setup(self) -> None:
        super().setup()
        try:
            self.connection.settimeout(30.0)
        except OSError:  # pragma: no cover
            pass

    def do_GET(self) -> None:  # noqa: N802 - 父类约定
        self._dispatch()

    def do_POST(self) -> None:  # noqa: N802
        self._dispatch()

    def do_PUT(self) -> None:  # noqa: N802
        self._dispatch()

    def do_DELETE(self) -> None:  # noqa: N802
        self._dispatch()

    def do_PATCH(self) -> None:  # noqa: N802
        self._dispatch()

    def do_OPTIONS(self) -> None:  # noqa: N802
        self._dispatch()

    def do_HEAD(self) -> None:  # noqa: N802
        self._dispatch()

    # -- 路由与分发 -------------------------------------------------------

    def _dispatch(self) -> None:
        app: ExecutorApp = self.server.app  # type: ignore[attr-defined]
        started = time.monotonic()
        method = self.command.upper()
        path, malformed = self._parse_target()
        status = 500
        try:
            if malformed:
                raise _HttpError(404, {"ok": False, "errorCode": "NOT_FOUND", "message": "请求路径非法"})
            if not app.authorize(self.headers.get("X-Moments-Token")):
                raise _HttpError(
                    401,
                    {"ok": False, "errorCode": "UNAUTHORIZED", "message": "token 缺失或错误"},
                )
            resolved = self._resolve_route(path)
            if resolved is None:
                raise _HttpError(404, {"ok": False, "errorCode": "NOT_FOUND", "message": "未知端点"})
            allowed, handler, parameter = resolved
            if method not in allowed:
                raise _HttpError(
                    405,
                    {"ok": False, "errorCode": "METHOD_NOT_ALLOWED", "message": "该端点不支持此 HTTP 方法"},
                    headers={"Allow": ", ".join(sorted(allowed))},
                )
            if handler in ("health", "status"):
                payload = app.health() if handler == "health" else app.status()
                self._send_json(200, payload)
                status = 200
            elif handler in ("prepare", "publish", "cancel"):
                body = self._read_json_body()
                if handler == "prepare":
                    payload = app.prepare(body)
                elif handler == "publish":
                    payload = app.publish(body)
                else:
                    code, payload = app.cancel(body)
                    self._send_json(code, payload)
                    status = code
                    return
                self._send_json(200, payload)
                status = 200
            elif handler == "preview":
                code, body, content_type = app.preview(parameter or "")
                status = code
                if content_type == "image/png":
                    self._send_bytes(code, body, content_type)
                else:
                    self._send_json(code, body)
            elif handler == "verify":
                code, payload = app.verify(parameter or "")
                self._send_json(code, payload)
                status = code
            else:  # pragma: no cover - 路由表与分发不一致属于编码错误
                raise _HttpError(404, {"ok": False, "errorCode": "NOT_FOUND", "message": "未知端点"})
        except _HttpError as error:
            status = error.status
            # 错误响应统一关闭连接：未知端点/鉴权失败时请求体未读取，保持长连接会破坏下一次请求解析。
            self._send_json(error.status, error.payload, extra_headers=error.headers, close=True)
        except (BrokenPipeError, ConnectionResetError):
            status = 0
            app.logger.debug("客户端提前断开连接 path=%s", _safe_log_path(path))
        except Exception as exc:
            app.logger.exception("HTTP 处理器未预期异常 path=%s", _safe_log_path(path))
            status = 200
            try:
                self._send_json(
                    200,
                    {"ok": False, "errorCode": "INTERNAL_ERROR", "message": f"内部错误（{type(exc).__name__}）"},
                )
            except (BrokenPipeError, ConnectionResetError):
                pass
        finally:
            app.logger.info(
                "http %s %s -> %s %.0fms",
                method,
                _safe_log_path(path),
                status,
                (time.monotonic() - started) * 1000,
            )

    def _parse_target(self) -> tuple[str, bool]:
        raw = self.path or "/"
        try:
            split = urlsplit(raw)
        except ValueError:
            return raw, True
        path = unquote(split.path or "/")
        if not path.startswith("/") or "\x00" in path:
            return path, True
        return path, False

    def _resolve_route(self, path: str) -> tuple[frozenset[str], str, str | None] | None:
        exact = _EXACT_ROUTES.get(path)
        if exact is not None:
            return exact[0], exact[1], None
        for prefix, allowed, handler in _PREFIX_ROUTES:
            if path.startswith(prefix):
                return allowed, handler, path[len(prefix):]
        return None

    # -- 请求体 -----------------------------------------------------------

    def _read_json_body(self) -> Mapping[str, Any]:
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            raise _HttpError(
                200,
                {"ok": False, "errorCode": "BAD_REQUEST", "message": "缺少 Content-Length"},
                close=True,
            )
        try:
            length = int(raw_length)
        except (TypeError, ValueError):
            raise _HttpError(
                200,
                {"ok": False, "errorCode": "BAD_REQUEST", "message": "Content-Length 非法"},
                close=True,
            )
        if length < 0 or length > MAX_BODY_BYTES:
            raise _HttpError(
                200,
                {"ok": False, "errorCode": "BAD_REQUEST", "message": f"请求体超过上限 {MAX_BODY_BYTES} 字节"},
                close=True,
            )
        try:
            raw = self.rfile.read(length)
        except OSError:
            raise _HttpError(
                200,
                {"ok": False, "errorCode": "BAD_REQUEST", "message": "读取请求体失败"},
                close=True,
            )
        if len(raw) != length:
            raise _HttpError(
                200,
                {"ok": False, "errorCode": "BAD_REQUEST", "message": "请求体不完整"},
                close=True,
            )
        try:
            parsed = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise _HttpError(200, {"ok": False, "errorCode": "BAD_REQUEST", "message": "请求体不是合法 JSON"})
        if not isinstance(parsed, Mapping):
            raise _HttpError(200, {"ok": False, "errorCode": "BAD_REQUEST", "message": "请求体必须是 JSON 对象"})
        return parsed

    # -- 响应 -------------------------------------------------------------

    def _send_json(
        self,
        status: int,
        payload: Mapping[str, Any],
        *,
        extra_headers: Mapping[str, str] | None = None,
        close: bool = False,
    ) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self._send_bytes(status, body, "application/json; charset=utf-8", extra_headers=extra_headers, close=close)

    def _send_bytes(
        self,
        status: int,
        body: bytes,
        content_type: str,
        *,
        extra_headers: Mapping[str, str] | None = None,
        close: bool = False,
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if extra_headers:
            for key, value in extra_headers.items():
                self.send_header(key, value)
        if close:
            self.close_connection = True
            self.send_header("Connection", "close")
        self.end_headers()
        if self.command != "HEAD":
            try:
                self.wfile.write(body)
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                self.close_connection = True


class ExecutorHTTPServer(ThreadingHTTPServer):
    """带应用状态的多线程 HTTP 服务；只应绑定回环地址。"""

    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, server_address: tuple[str, int], app: ExecutorApp) -> None:
        self.app = app
        super().__init__(server_address, ExecutorRequestHandler)


def create_server(
    config: ExecutorConfig,
    *,
    driver: WechatDriver | None = None,
    token: str,
    logger: logging.Logger | None = None,
) -> tuple[ExecutorHTTPServer, ExecutorApp]:
    """创建（但不启动）HTTP 服务；测试可用 port=0 取临时端口。"""
    config.validate()
    config.token = validate_token(token)
    app = ExecutorApp(config, driver=driver, token=token, logger=logger)
    server = ExecutorHTTPServer((config.bind_host, config.port), app)

    def _shutdown() -> None:
        if not getattr(server, "_shutdown_started", False):
            server._shutdown_started = True  # type: ignore[attr-defined]
            threading.Thread(target=server.shutdown, name="desktop-shutdown", daemon=True).start()

    app.attach_shutdown(_shutdown)
    return server, app


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="DSH Moments Agent Windows 桌面执行器（仅监听 127.0.0.1）",
    )
    parser.add_argument("--config", default=None, help="扁平执行器 JSON 配置文件路径（可选）")
    parser.add_argument("--host", default=None, help="只允许 127.0.0.1 / localhost")
    parser.add_argument("--port", type=int, default=None, help=f"监听端口，默认 {DEFAULT_PORT}")
    parser.add_argument(
        "--mode",
        choices=("PREPARE_ONLY", "APPROVAL_REQUIRED"),
        default=None,
        help="PREPARE_ONLY（默认，禁止发表）或 APPROVAL_REQUIRED",
    )
    parser.add_argument("--allow-publish", action="store_true", help="显式允许点击发表（仍需 APPROVAL_REQUIRED）")
    parser.add_argument("--token-file", default=None, help="token 文件；不存在则自动生成")
    parser.add_argument("--screenshot-dir", default=None, help="截图目录")
    parser.add_argument("--asset-root", action="append", default=None, help="允许的素材根目录，可重复")
    parser.add_argument("--log-file", default=None, help="日志文件")
    parser.add_argument(
        "--expected-account",
        default=None,
        help="预期的微信账号；trusted_account_source=wechatagent 时必填",
    )
    parser.add_argument(
        "--trusted-account-source",
        choices=("uia", "wechatagent"),
        default=None,
        help="账号验证来源：uia（默认，从微信界面读取）或 wechatagent（插件验证后传入）",
    )
    parser.add_argument(
        "--assume-client-version",
        default=None,
        help="已人工确认的运行中客户端版本（必须同时出现在 supportedVersions 中）",
    )
    parser.add_argument("--version", action="version", version=f"dsh-moments-desktop {VERSION}")
    return parser


def build_config(args: argparse.Namespace) -> ExecutorConfig:
    """按“默认值 → 配置文件 → CLI 参数”的优先级构建配置。"""
    base = load_config_file(args.config) if args.config else ExecutorConfig()
    overrides: dict[str, Any] = {}
    if args.host is not None:
        overrides["host"] = args.host.strip()
    if args.port is not None:
        overrides["port"] = args.port
    if args.mode is not None:
        overrides["mode"] = args.mode.upper()
    if args.allow_publish:
        overrides["allow_publish"] = True
    if args.token_file is not None:
        overrides["token_file"] = os.path.abspath(args.token_file)
    if args.screenshot_dir is not None:
        overrides["screenshot_dir"] = os.path.abspath(args.screenshot_dir)
    if args.log_file is not None:
        overrides["log_file"] = os.path.abspath(args.log_file)
    if args.asset_root:
        overrides["asset_roots"] = tuple(os.path.abspath(root) for root in args.asset_root)
    if args.expected_account is not None:
        overrides["expected_account_id"] = args.expected_account.strip()
    if args.trusted_account_source is not None:
        overrides["trusted_account_source"] = args.trusted_account_source
    if args.assume_client_version is not None:
        overrides["assumed_client_version"] = args.assume_client_version.strip()
    config = dataclasses.replace(base, **overrides)
    config.validate()
    return config


def resolve_runtime_token(config: ExecutorConfig, *, logger: logging.Logger) -> str:
    """读取/生成 token；token 内容绝不写日志，也不出现在错误响应里。"""
    if config.token:
        return validate_token(config.token)
    env_token = os.environ.get("DSH_MOMENTS_DESKTOP_TOKEN")
    token_file = config.token_file
    if token_file and os.path.exists(token_file):
        token = read_token_file(token_file)
        logger.info("已从 token 文件读取 token（内容不写入日志）：%s", token_file)
        return token
    if token_file:
        if env_token:
            token = validate_token(env_token)
        else:
            import secrets

            token = secrets.token_hex(32)
        write_token_file(token_file, token, logger=logger)
        logger.info("已生成 token 文件（内容不写入日志）：%s", token_file)
        return token
    if env_token:
        return validate_token(env_token)
    default_file = os.path.abspath(DEFAULT_TOKEN_FILE)
    import secrets

    token = secrets.token_hex(32)
    write_token_file(default_file, token, logger=logger)
    logger.info("未指定 token 文件，已生成默认 token 文件（内容不写入日志）：%s", default_file)
    return token


def _install_signal_handlers(server: ExecutorHTTPServer, app: ExecutorApp, logger: logging.Logger) -> None:
    def _handler(signum: int, _frame: Any) -> None:
        logger.info("收到信号 %s，准备优雅关闭桌面执行器", signum)
        app.request_shutdown()

    signals = [signal.SIGINT, signal.SIGTERM]
    # Windows 控制台 Ctrl+Break 映射为 SIGBREAK；也纳入优雅关闭。
    sigbreak = getattr(signal, "SIGBREAK", None)
    if sigbreak is not None:
        signals.append(sigbreak)
    for sig in signals:
        try:
            signal.signal(sig, _handler)
        except (ValueError, OSError, AttributeError):  # 非主线程或平台不支持
            continue


def run_server(config: ExecutorConfig, *, driver: WechatDriver | None = None, logger: logging.Logger | None = None) -> int:
    """启动并阻塞运行服务；供 main 与测试复用。"""
    log = logger or _LOGGER
    token = resolve_runtime_token(config, logger=log)
    try:
        server, app = create_server(config, driver=driver, token=token, logger=log)
    except OSError as exc:
        log.error("无法绑定 %s:%s：%s", config.bind_host, config.port, exc)
        return 2
    _install_signal_handlers(server, app, log)
    host, port = server.server_address[0], server.server_address[1]
    log.info(
        "桌面执行器已启动：http://%s:%s mode=%s allowPublish=%s",
        host,
        port,
        config.mode,
        config.effective_allow_publish,
    )
    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:  # pragma: no cover - 交互式终端
        log.info("收到键盘中断，正在关闭")
    finally:
        app.request_shutdown()
        server.server_close()
        log.info("桌面执行器已停止")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        config = build_config(args)
    except ConfigError as exc:
        print(f"配置错误：{exc}", file=sys.stderr)
        return 2
    except Exception as exc:  # pragma: no cover - 防御性
        print(f"启动失败：{type(exc).__name__}: {exc}", file=sys.stderr)
        return 2
    logger = configure_logging(config.log_file)
    try:
        return run_server(config, logger=logger)
    except ConfigError as exc:
        logger.error("配置错误：%s", exc)
        print(f"配置错误：{exc}", file=sys.stderr)
        return 2
    except Exception as exc:  # pragma: no cover - 顶层兜底
        logger.exception("桌面执行器异常退出")
        print(f"桌面执行器异常退出：{type(exc).__name__}", file=sys.stderr)
        return 1


def _safe_log_path(path: str | None) -> str:
    """日志只保留路径的安全短形式，避免换行/控制字符注入日志。"""
    if not path:
        return "-"
    cleaned = "".join(ch if ch.isprintable() and ch not in "\r\n" else "?" for ch in path)
    return cleaned[:MAX_REQUEST_LOG_PATH]


if __name__ == "__main__":
    raise SystemExit(main())
