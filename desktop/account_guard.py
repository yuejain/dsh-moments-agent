"""微信账号、客户端版本与交互桌面校验。

协议 §3.1-3.4 的顺序：
1. 交互桌面 → ``INTERACTIVE_DESKTOP_UNAVAILABLE``
2. 微信进程 → ``WECHAT_NOT_RUNNING``
3. 登录状态 → ``WECHAT_NOT_LOGGED_IN``
4. 账号比对 → ``ACCOUNT_MISMATCH``
5. UI Automation 能力 → ``DESKTOP_UNSUPPORTED``（真实 GUI 不可用；本地扩展码）
6. 客户端版本支持 → ``CLIENT_VERSION_UNSUPPORTED``

原则：读不到账号时绝不猜测“就是配置里的账号”，而是要求人工重新核对/审批。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

from .config import ExecutorError, WechatStatus


@dataclass
class GuardConfig:
    """账号校验相关配置。"""

    expected_account_id: str | None = None
    supported_versions: tuple[str, ...] = ()
    require_account: bool = True
    trusted_account_source: str = "uia"
    assumed_client_version: str | None = None


class AccountGuard:
    """执行前的账号/版本/桌面守卫；任何异常都抛带协议错误码的 ExecutorError。"""

    def __init__(
        self,
        *,
        expected_account_id: str | None = None,
        supported_versions: Sequence[str] = (),
        require_account: bool = True,
        trusted_account_source: str = "uia",
        assumed_client_version: str | None = None,
    ) -> None:
        self._expected = (expected_account_id or "").strip() or None
        self._supported_versions = tuple(supported_versions)
        self._require_account = require_account
        self._trusted_account_source = (trusted_account_source or "uia").strip().lower()
        self._assumed_client_version = (assumed_client_version or "").strip() or None

    @property
    def expected_account_id(self) -> str | None:
        return self._expected

    # -- 单项检查 ---------------------------------------------------------

    def check_desktop(self, status: WechatStatus) -> None:
        if not status.interactive or status.locked:
            reason = "锁屏" if status.locked else "没有可交互桌面（RDP 断开或服务会话）"
            raise ExecutorError("INTERACTIVE_DESKTOP_UNAVAILABLE", f"当前{reason}，已停止操作，请人工解锁后重试")

    def check_process(self, status: WechatStatus) -> None:
        if not status.running:
            raise ExecutorError("WECHAT_NOT_RUNNING", "微信客户端未运行，请人工启动微信后重试")

    def check_login(self, status: WechatStatus) -> None:
        if not status.logged_in:
            raise ExecutorError("WECHAT_NOT_LOGGED_IN", "微信未登录，请人工登录后重试")

    def check_account(self, status: WechatStatus, requested_account: str | None) -> None:
        """账号必须同时满足：配置的审批账号、请求账号、UI 实际登录账号三者一致。

        当 trusted_account_source=wechatagent 时，账号由插件通过 WeChatAgent
        Reader/Hook 验证后随请求传入；执行器只比对“请求账号 == 配置的 expected
        账号”，不再要求 UIA 能读取 wxid。该模式必须显式配置 expected_account_id，
        令牌保护的本机接口仍是信任边界。
        """
        if not self._require_account and not requested_account and not self._expected:
            return
        requested = (requested_account or "").strip() or None
        if self._trusted_account_source == "wechatagent":
            if self._expected is None:
                raise ExecutorError(
                    "ACCOUNT_MISMATCH",
                    "trusted_account_source=wechatagent 但未配置 expected_account_id，拒绝执行",
                )
            if requested is None or requested != self._expected:
                raise ExecutorError(
                    "ACCOUNT_MISMATCH",
                    "请求账号与配置的 WeChatAgent 已验证账号不一致，已停止操作，需重新审批",
                )
            return
        if self._expected and requested and requested != self._expected:
            raise ExecutorError(
                "ACCOUNT_MISMATCH",
                "请求中的 accountId 与配置的审批账号不一致，已停止操作，需重新审批",
            )
        actual = (status.account_id or "").strip() or None
        if actual is None:
            raise ExecutorError(
                "ACCOUNT_MISMATCH",
                "无法通过 UI Automation 确认当前登录的微信账号，不能安全执行，需人工核对后重新审批",
            )
        if self._expected and actual != self._expected:
            raise ExecutorError(
                "ACCOUNT_MISMATCH",
                "当前登录的微信账号与配置的审批账号不一致，已停止操作，需重新审批",
            )
        target = requested or self._expected
        if target is None:
            raise ExecutorError(
                "ACCOUNT_MISMATCH",
                "缺少可核对的账号标识，不能安全执行，需重新审批",
            )
        if actual != target:
            raise ExecutorError(
                "ACCOUNT_MISMATCH",
                "当前登录的微信账号与请求/审批账号不一致，已停止操作，需重新审批",
            )

    def check_uia(self, uia_available: bool) -> None:
        """缺少 UI Automation 客户端库时如实返回 DESKTOP_UNSUPPORTED。"""
        if not uia_available:
            raise ExecutorError(
                "DESKTOP_UNSUPPORTED",
                "当前环境缺少 Windows UI Automation 客户端库（pywinauto），"
                "真实微信界面操作不可用；仅支持 Mock 准备流程测试",
            )

    def check_client_version(self, status: WechatStatus) -> None:
        if self._assumed_client_version is not None and self._assumed_client_version in self._supported_versions:
            return
        if not status.supported:
            version = status.version or "未知"
            supported = ", ".join(self._supported_versions) or "无"
            raise ExecutorError(
                "CLIENT_VERSION_UNSUPPORTED",
                f"微信客户端版本 {version} 不在已验证列表（{supported}）内，或 UI 控件树未验证，已停止操作",
            )

    # -- 组合检查 ---------------------------------------------------------

    def ensure_prepare_ready(
        self,
        status: WechatStatus,
        requested_account: str | None,
        *,
        uia_available: bool = True,
    ) -> None:
        """prepare 前置检查：顺序与协议 §3 一致，任一步失败立即停止。"""
        self.check_desktop(status)
        self.check_process(status)
        self.check_login(status)
        self.check_account(status, requested_account)
        self.check_uia(uia_available)
        self.check_client_version(status)

    def ensure_publish_ready(
        self,
        status: WechatStatus,
        requested_account: str | None,
        *,
        uia_available: bool = True,
    ) -> None:
        """publish 点击前的复检：账号/桌面/版本任一变化都必须阻止点击。"""
        self.check_desktop(status)
        self.check_process(status)
        self.check_login(status)
        self.check_account(status, requested_account)
        self.check_uia(uia_available)
        self.check_client_version(status)
