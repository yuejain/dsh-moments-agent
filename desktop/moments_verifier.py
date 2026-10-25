"""发布后核验。

判定规则（宁可不确认，也不谎报成功）：
- 只有驱动返回 verified=True，且可见正文与预期一致、图片数量一致、
  截图证据落在允许的截图目录内，才认为发布成功；
- 任何读取失败、超时、证据不足都返回 ``verified=False``，由上层转成
  ``uncertain=True, errorCode=UNCERTAIN``；
- 已点击发表后禁止自动重试，本模块只做一次核验。
"""
from __future__ import annotations

import logging
import os
from typing import Any

from .config import (
    ExecutorConfig,
    ExecutorError,
    Verification,
    ensure_directory_under,
    normalize_path,
    redact_meta,
    resolve_under,
    safe_filename_component,
    utc_now_iso,
)
from .wechat_driver import WechatDriver

_LOGGER = logging.getLogger("dsh_moments.desktop.verifier")


class MomentsVerifier:
    """点击“发表”之后的核验器。"""

    def __init__(
        self,
        driver: WechatDriver,
        config: ExecutorConfig,
        *,
        logger: logging.Logger | None = None,
    ) -> None:
        self._driver = driver
        self._config = config
        self._logger = logger or _LOGGER
        self._screenshot_dir = normalize_path(config.screenshot_dir)

    def verify(
        self,
        *,
        attempt_id: str,
        expected_text: str,
        expected_image_count: int,
        evidence_path: str | None = None,
        timeout: float | None = None,
    ) -> Verification:
        """执行一次核验；返回 Verification（verified=False 表示无法确认）。"""
        try:
            safe_filename_component(attempt_id, name="attemptId")
        except Exception:
            return Verification(verified=False, notes=["attemptId 非法，无法核验"])
        if not isinstance(expected_image_count, int) or expected_image_count < 0:
            return Verification(verified=False, notes=["预期图片数量非法，无法核验"])

        resolved_evidence = self._resolve_evidence(attempt_id, evidence_path)
        self._log(
            "开始核验发布结果",
            attemptId=attempt_id,
            expectedImages=expected_image_count,
            hasEvidencePath=bool(resolved_evidence),
        )
        try:
            verification = self._driver.verify_published(
                expected_text,
                expected_image_count,
                evidence_path=resolved_evidence,
                timeout=timeout if timeout is not None else self._config.verify_timeout,
            )
        except ExecutorError as exc:
            self._logger.warning(
                "核验失败 attemptId=%s errorCode=%s message=%s", attempt_id, exc.code, exc.message
            )
            return Verification(
                verified=False,
                method="uia-list-readback",
                notes=[f"核验失败（{exc.code}）：{exc.message}"],
            )
        except Exception as exc:  # 核验阶段任何异常都不能声称成功
            self._logger.exception("核验未预期异常 attemptId=%s", attempt_id)
            return Verification(
                verified=False,
                method="uia-list-readback",
                notes=[f"核验过程发生未预期异常（{type(exc).__name__}）"],
            )

        return self._validate(verification, expected_text, expected_image_count, resolved_evidence)

    # -- 内部工具 ---------------------------------------------------------

    def _validate(
        self,
        verification: Verification,
        expected_text: str,
        expected_image_count: int,
        resolved_evidence: str | None,
    ) -> Verification:
        if not isinstance(verification, Verification):
            return Verification(verified=False, notes=["驱动返回的核验结构非法"])
        notes = list(verification.notes or [])
        verified = bool(verification.verified)

        if verified:
            # 证据不足以证明“正文与图片都匹配”时，降级为不确定。
            if verification.visible_text is None:
                verified = False
                notes.append("驱动声称核验成功，但没有返回可见正文证据")
            elif not self._driver.matches_verified_text(verification.visible_text, expected_text):
                verified = False
                notes.append("朋友圈可见正文与预期不一致")
            if verification.image_count is None:
                verified = False
                notes.append("驱动声称核验成功，但没有返回图片数量证据")
            elif int(verification.image_count) != expected_image_count:
                verified = False
                notes.append(
                    f"朋友圈图片数量（{verification.image_count}）与预期（{expected_image_count}）不一致"
                )

        verify_evidence_path = resolved_evidence or verification.evidence_path
        evidence = None
        if verify_evidence_path:
            try:
                evidence = resolve_under(
                    (self._screenshot_dir,), verify_evidence_path, must_exist_file=True
                )
            except Exception:
                notes.append("核验截图证据不在允许的截图目录内或不存在")
                if verified:
                    verified = False
        elif verified:
            notes.append("缺少发布成功截图证据，降级为不确定")
            verified = False

        published_at = verification.published_at if verified else None
        if verified and not published_at:
            published_at = utc_now_iso()
        return Verification(
            verified=verified,
            method=verification.method or "uia-list-readback",
            published_at=published_at,
            visible_text=verification.visible_text,
            image_count=verification.image_count,
            evidence_path=evidence,
            notes=notes[:32],
        )

    def _resolve_evidence(self, attempt_id: str, evidence_path: str | None) -> str | None:
        """把证据截图路径限制在配置的截图目录内部。"""
        try:
            ensure_directory_under((self._screenshot_dir,), self._screenshot_dir)
        except Exception as exc:
            self._logger.warning("无法确保截图目录存在：%s", type(exc).__name__)
            return None
        if evidence_path is None:
            candidate = os.path.join(self._screenshot_dir, f"{attempt_id}-published.png")
        else:
            candidate = evidence_path
        try:
            return resolve_under((self._screenshot_dir,), candidate)
        except Exception:
            self._logger.warning("发布核验截图路径越界，已忽略 evidencePath")
            return None

    def _log(self, message: str, **meta: Any) -> None:
        self._logger.info(message, extra={"desktop": redact_meta(meta)})
