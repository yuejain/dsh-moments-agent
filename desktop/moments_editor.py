"""朋友圈准备与发布编排。

职责边界：
- prepare：按协议 §3 的 1-12 步执行，任何一步失败立即停止，**绝不点击发表**；
- publish：仅在 server 确认 ``--allow-publish`` + ``APPROVAL_REQUIRED`` 后调用，
  点击前重新读取编辑器内容比对，点击后核验；已点击但无法确认时返回 uncertain
  并禁止自动重试。

本模块不直接操作 Windows API，全部 GUI 动作委托给 ``WechatDriver``，
因此单元测试可注入 ``FakeWechatDriver``。
"""
from __future__ import annotations

import logging
import os
import threading
from dataclasses import dataclass, field
from typing import Any, Mapping

from .account_guard import AccountGuard
from .config import (
    ExecutorError,
    ExecutorConfig,
    Verification,
    WechatStatus,
    ensure_directory_under,
    normalize_path,
    normalize_text,
    redact_meta,
    resolve_under,
    safe_filename_component,
    utc_now_iso,
)
from .moments_verifier import MomentsVerifier
from .wechat_driver import PublishAttemptError, WechatDriver

_LOGGER = logging.getLogger("dsh_moments.desktop.editor")


@dataclass
class PreparedSnapshot:
    """prepare 成功后保存在内存里的审批快照，publish 前必须与编辑器内容一致。"""

    task_id: str
    attempt_id: str
    text: str
    image_count: int
    visibility: str
    content_hash: str
    account_id: str
    screenshot_path: str | None
    prepared_at: str
    asset_paths: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "taskId": self.task_id,
            "attemptId": self.attempt_id,
            "text": self.text,
            "imageCount": self.image_count,
            "visibility": self.visibility,
            "contentHash": self.content_hash,
            "accountId": self.account_id,
            "screenshotPath": self.screenshot_path,
            "preparedAt": self.prepared_at,
        }


@dataclass
class PrepareOutcome:
    """POST /moments/prepare 的结果；字段名与协议一致（camelCase 在 to_dict）。"""

    ok: bool = False
    prepared: bool = False
    screenshot_path: str | None = None
    text_matched: bool = False
    image_count: int = 0
    warnings: list[str] = field(default_factory=list)
    error_code: str | None = None
    message: str = ""
    snapshot: PreparedSnapshot | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "prepared": self.prepared,
            "screenshotPath": self.screenshot_path,
            "textMatched": self.text_matched,
            "imageCount": self.image_count,
            "warnings": list(self.warnings),
            "errorCode": self.error_code,
            "message": self.message,
        }


@dataclass
class PublishOutcome:
    """POST /moments/publish 的结果。"""

    ok: bool = False
    submitted: bool = False
    verified: bool = False
    uncertain: bool = False
    screenshot_path: str | None = None
    verification: Verification | None = None
    error_code: str | None = None
    message: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "submitted": self.submitted,
            "verified": self.verified,
            "uncertain": self.uncertain,
            "screenshotPath": self.screenshot_path,
            "verification": self.verification.to_dict() if self.verification is not None else None,
            "errorCode": self.error_code,
            "message": self.message,
        }


class MomentsEditor:
    """朋友圈编辑/发布编排器。"""

    def __init__(
        self,
        driver: WechatDriver,
        guard: AccountGuard,
        config: ExecutorConfig,
        verifier: MomentsVerifier,
        *,
        logger: logging.Logger | None = None,
    ) -> None:
        self._driver = driver
        self._guard = guard
        self._config = config
        self._verifier = verifier
        self._logger = logger or _LOGGER
        self._screenshot_dir = normalize_path(config.screenshot_dir)

    # -- 公共入口 ---------------------------------------------------------

    def prepare(
        self,
        request: Mapping[str, Any],
        *,
        cancel_event: threading.Event | None = None,
    ) -> PrepareOutcome:
        """执行准备流程；返回结构化结果（不抛业务异常）。"""
        attempt_id = str(request.get("attemptId", ""))
        task_id = str(request.get("taskId", ""))
        text = str(request.get("text", ""))
        image_count = 0
        text_matched = False
        warnings: list[str] = []
        try:
            try:
                safe_filename_component(attempt_id, name="attemptId")
            except Exception as exc:
                raise ExecutorError("BAD_REQUEST", f"attemptId 非法：{exc}") from exc
            asset_paths = tuple(str(path) for path in request.get("assetPaths", ()) or ())
            visibility = str(request.get("visibility", ""))
            content_hash = str(request.get("contentHash", ""))
            account_id = str(request.get("accountId", ""))
            self._check_cancel(cancel_event)

            # 1-4. 交互桌面 / 进程 / 登录 / 账号 / UIA / 版本
            status = self._status()
            self._guard.ensure_prepare_ready(
                status,
                account_id,
                uia_available=self._driver.uia_available,
            )
            self._check_cancel(cancel_event)
            self._log("开始准备朋友圈内容", attemptId=attempt_id, taskId=task_id, images=len(asset_paths))

            # 6. 通过控件身份打开朋友圈编辑器（不依赖屏幕坐标）
            self._driver.open_moments_editor(timeout=self._config.prepare_timeout)
            self._check_cancel(cancel_event)

            # 7. 填写正文
            self._driver.fill_text(text, timeout=self._config.prepare_timeout)
            self._check_cancel(cancel_event)

            # 8. 依次添加图片；任一张失败立即停止，不继续后续图片
            for index, asset_path in enumerate(asset_paths):
                self._check_cancel(cancel_event)
                self._driver.add_images([asset_path], timeout=self._config.prepare_timeout)
                self._log("已添加图片", attemptId=attempt_id, index=index)

            self._check_cancel(cancel_event)

            # 9. 读回正文与图片数量
            read_text, read_image_count = self._driver.read_back(timeout=self._config.prepare_timeout)
            text_matched = normalize_text(read_text) == normalize_text(text)
            image_count = int(read_image_count)
            if not text_matched:
                raise ExecutorError("CONTENT_CHANGED", "编辑器读回的正文与审批内容不一致，已停止操作")
            if image_count != len(asset_paths):
                raise ExecutorError(
                    "UPLOAD_FAILED",
                    f"编辑器中的图片数量（{image_count}）与预期（{len(asset_paths)}）不一致，已停止操作",
                )

            # 10. 设置/校验可见范围
            self._driver.set_visibility(visibility, timeout=self._config.prepare_timeout)
            self._check_cancel(cancel_event)

            # 11. 截图存证
            screenshot_path = self._artifact_path(attempt_id, "-prepared.png")
            saved_path = self._driver.screenshot(screenshot_path, timeout=self._config.screenshot_timeout)
            saved_path = self._assert_artifact(saved_path)
            # 截图后再次确认是否已被取消，避免取消请求在最后一步丢失。
            self._check_cancel(cancel_event)

            # 12. 返回，不点击发表
            snapshot = PreparedSnapshot(
                task_id=task_id,
                attempt_id=attempt_id,
                text=text,
                image_count=image_count,
                visibility=visibility,
                content_hash=content_hash,
                account_id=account_id,
                screenshot_path=saved_path,
                prepared_at=utc_now_iso(),
                asset_paths=asset_paths,
            )
            message = "已在朋友圈编辑窗口完成图文准备，未点击发表"
            self._log("准备完成，未点击发表", attemptId=attempt_id, textMatched=text_matched, imageCount=image_count)
            return PrepareOutcome(
                ok=True,
                prepared=True,
                screenshot_path=saved_path,
                text_matched=True,
                image_count=image_count,
                warnings=warnings,
                error_code=None,
                message=message,
                snapshot=snapshot,
            )
        except ExecutorError as exc:
            self._log_error("准备失败", attempt_id, exc)
            return PrepareOutcome(
                ok=False,
                prepared=False,
                screenshot_path=None,
                text_matched=text_matched,
                image_count=image_count,
                warnings=self._with_warning(warnings, exc.message),
                error_code=exc.code,
                message=exc.message,
            )
        except Exception as exc:  # 未预期异常：不泄漏堆栈，标记 INTERNAL_ERROR
            self._logger.exception("准备流程未预期异常 attemptId=%s", attempt_id)
            return PrepareOutcome(
                ok=False,
                prepared=False,
                screenshot_path=None,
                text_matched=text_matched,
                image_count=image_count,
                warnings=self._with_warning(warnings, "内部异常，已停止操作"),
                error_code="INTERNAL_ERROR",
                message=f"准备流程发生未预期异常（{type(exc).__name__}），已停止操作",
            )

    def publish(
        self,
        snapshot: PreparedSnapshot,
        request: Mapping[str, Any],
        *,
        allow_publish: bool,
        cancel_event: threading.Event | None = None,
    ) -> PublishOutcome:
        """在服务端已确认发布权限后执行：复检 → 点击 → 核验。"""
        # 防御性双保险：即使调用方误用，也绝不在未授权时点击发表。
        if not allow_publish or self._config.mode != "APPROVAL_REQUIRED" or not self._config.allow_publish:
            return PublishOutcome(
                ok=False,
                submitted=False,
                verified=False,
                uncertain=False,
                error_code="PUBLISH_MODE_DISABLED",
                message="未开启发表权限（需要 --allow-publish 且 mode=APPROVAL_REQUIRED），未点击发表",
            )
        attempt_id = snapshot.attempt_id
        if self._check_cancelled(cancel_event):
            return PublishOutcome(
                ok=False,
                submitted=False,
                error_code="CANCELLED",
                message="操作已取消，未点击发表",
            )
        try:
            requested_hash = str(request.get("contentHash", ""))
            requested_account = str(request.get("accountId", ""))
            approval_id = str(request.get("approvalId", ""))
            if not approval_id:
                return PublishOutcome(
                    ok=False,
                    submitted=False,
                    error_code="APPROVAL_REQUIRED",
                    message="缺少审批 ID，未点击发表",
                )
            if requested_hash.lower() != snapshot.content_hash.lower():
                return PublishOutcome(
                    ok=False,
                    submitted=False,
                    error_code="CONTENT_CHANGED",
                    message="发布请求的 contentHash 与准备记录不一致，未点击发表，需重新审批",
                )
            if requested_account != snapshot.account_id:
                return PublishOutcome(
                    ok=False,
                    submitted=False,
                    error_code="ACCOUNT_MISMATCH",
                    message="发布请求的 accountId 与准备记录不一致，未点击发表，需重新审批",
                )

            # 点击前复检：桌面/进程/登录/账号/UIA/版本
            status = self._status()
            self._guard.ensure_publish_ready(
                status,
                snapshot.account_id,
                uia_available=self._driver.uia_available,
            )
            if self._check_cancelled(cancel_event):
                return PublishOutcome(
                    ok=False,
                    submitted=False,
                    error_code="CANCELLED",
                    message="操作已取消，未点击发表",
                )

            # 点击前重新读取编辑器正文与图片数量，与 prepare 快照比对。
            current_text, current_images = self._driver.read_back(timeout=self._config.prepare_timeout)
            if normalize_text(current_text) != normalize_text(snapshot.text):
                return PublishOutcome(
                    ok=False,
                    submitted=False,
                    error_code="CONTENT_CHANGED",
                    message="编辑窗口正文与审批快照不一致，未点击发表，需重新审批",
                )
            if int(current_images) != snapshot.image_count:
                return PublishOutcome(
                    ok=False,
                    submitted=False,
                    error_code="CONTENT_CHANGED",
                    message="编辑窗口图片数量与审批快照不一致，未点击发表，需重新审批",
                )

            self._log("审批通过，点击发表", attemptId=attempt_id, taskId=snapshot.task_id)
            try:
                self._driver.click_publish(timeout=self._config.click_timeout)
            except PublishAttemptError as exc:
                if exc.may_have_submitted:
                    return self._uncertain_after_click(snapshot, str(exc.message))
                return PublishOutcome(
                    ok=False,
                    submitted=False,
                    error_code=exc.code,
                    message=exc.message,
                )
            except ExecutorError as exc:
                return PublishOutcome(
                    ok=False,
                    submitted=False,
                    error_code=exc.code,
                    message=exc.message,
                )
            except Exception as exc:  # 点击调用本身抛未知异常：保守按“可能已点击”处理
                self._logger.exception("点击发表未预期异常 attemptId=%s", attempt_id)
                return self._uncertain_after_click(
                    snapshot,
                    f"点击发表时发生未预期异常（{type(exc).__name__}），无法确认是否已发布",
                )

            # 已成功执行点击动作：从这里开始只做核验，任何异常都返回 uncertain。
            try:
                evidence_path = self._artifact_path(attempt_id, "-published.png")
                verification = self._verifier.verify(
                    attempt_id=attempt_id,
                    expected_text=snapshot.text,
                    expected_image_count=snapshot.image_count,
                    evidence_path=evidence_path,
                    timeout=self._config.verify_timeout,
                )
            except Exception as exc:
                self._logger.exception("发布后核验未预期异常 attemptId=%s", attempt_id)
                return self._uncertain_after_click(
                    snapshot,
                    f"已点击发表但核验过程异常（{type(exc).__name__}），无法确认结果",
                )
            if verification.verified:
                screenshot = verification.evidence_path or snapshot.screenshot_path
                self._log("已点击发表并核验成功", attemptId=attempt_id)
                return PublishOutcome(
                    ok=True,
                    submitted=True,
                    verified=True,
                    uncertain=False,
                    screenshot_path=screenshot,
                    verification=verification,
                    error_code=None,
                    message="已点击发表并核验到新内容",
                )
            return self._uncertain_after_click(
                snapshot,
                "已点击发表但无法在朋友圈列表确认新内容，禁止自动重试，请人工核对",
                verification=verification,
            )
        except ExecutorError as exc:
            # 点击前检查失败：尚未点击，可安全返回明确错误码。
            self._log_error("发布前检查失败，未点击发表", attempt_id, exc)
            return PublishOutcome(
                ok=False,
                submitted=False,
                error_code=exc.code,
                message=exc.message,
            )

    # -- 内部工具 ---------------------------------------------------------

    def _status(self) -> WechatStatus:
        return self._driver.get_status(timeout=self._config.status_timeout)

    def _uncertain_after_click(
        self,
        snapshot: PreparedSnapshot,
        message: str,
        verification: Verification | None = None,
    ) -> PublishOutcome:
        """已点击发表后无法确认：保留证据，标记 uncertain，绝不自动重试。"""
        evidence = verification.evidence_path if verification is not None else None
        if evidence is None:
            try:
                fallback = self._artifact_path(snapshot.attempt_id, "-published.png")
                evidence = self._driver.screenshot(fallback, timeout=self._config.screenshot_timeout)
                evidence = self._assert_artifact(evidence)
            except Exception:  # 证据截图失败不能再影响 uncertain 结论
                evidence = snapshot.screenshot_path
        self._log("发布结果不确定，需要人工核对", attemptId=snapshot.attempt_id)
        return PublishOutcome(
            ok=False,
            submitted=True,
            verified=False,
            uncertain=True,
            screenshot_path=evidence,
            verification=verification,
            error_code="UNCERTAIN",
            message=message,
        )

    def _artifact_path(self, attempt_id: str, suffix: str) -> str:
        """在截图目录内生成安全路径（拒绝 attemptId 路径注入）。"""
        safe_filename_component(attempt_id, name="attemptId")
        ensure_directory_under((self._screenshot_dir,), self._screenshot_dir)
        candidate = os.path.join(self._screenshot_dir, f"{attempt_id}{suffix}")
        return resolve_under((self._screenshot_dir,), candidate)

    def _assert_artifact(self, path: str | None) -> str | None:
        if not path:
            return None
        try:
            resolved = resolve_under((self._screenshot_dir,), path, must_exist_file=True)
        except Exception:
            raise ExecutorError("INTERNAL_ERROR", "截图路径越界或文件不存在，已停止操作")
        return resolved

    @staticmethod
    def _check_cancel(cancel_event: threading.Event | None) -> None:
        if cancel_event is not None and cancel_event.is_set():
            raise ExecutorError("CANCELLED", "操作已取消，未点击发表")

    @staticmethod
    def _check_cancelled(cancel_event: threading.Event | None) -> bool:
        return cancel_event is not None and cancel_event.is_set()

    def _log(self, message: str, **meta: Any) -> None:
        self._logger.info(message, extra={"desktop": redact_meta(meta)})

    def _log_error(self, message: str, attempt_id: str, exc: ExecutorError) -> None:
        self._logger.warning(
            "%s attemptId=%s errorCode=%s message=%s",
            message,
            attempt_id,
            exc.code,
            exc.message,
        )

    @staticmethod
    def _with_warning(warnings: list[str], message: str) -> list[str]:
        items = list(warnings)
        if message and message not in items:
            items.append(message)
        return items[:32]
