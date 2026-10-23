"""微信桌面驱动接口。

三层结构：
- ``WechatDriver``：抽象接口，所有 GUI 操作必须经过它，便于测试注入；
- ``RealWechatDriver``：Windows UI Automation 实现。pywinauto 惰性导入，
  缺失时 ``uia_available=False``，所有 GUI 操作返回 ``DESKTOP_UNSUPPORTED``，
  绝不在 import 阶段崩溃；
- ``FakeWechatDriver``：测试用可编程驱动，不访问网络、不启动真实微信。

安全约束：
- 不硬编码屏幕坐标，只按控件 Name/AutomationId/ControlType 定位；
- 不进行 DLL 注入、协议逆向、数据库读写；只使用 UI Automation + 受限键鼠模拟；
- 每一步失败立即抛 ``ExecutorError``，由上层停止后续步骤；
- 所有 GUI 操作都有时间上限（timeout 参数 + deadline 检查）。
"""
from __future__ import annotations

import abc
import ctypes
import logging
import os
import time
from typing import Any, Iterable, Sequence

from .config import (
    ExecutorError,
    VISIBILITY_LABELS,
    VISIBILITIES,
    VERSION,
    Verification,
    WechatInstallation,
    WechatStatus,
    normalize_path,
    normalize_text,
    utc_now,
    utc_now_iso,
)
from .window_locator import WindowInfo, WindowLocator, solid_png

_LOGGER = logging.getLogger("dsh_moments.desktop.driver")

# 允许的界面控件定位候选（名称/AutomationId）。真实控件树尚未验证，因此这里
# 保留多组候选；找不到时立即失败，不做盲目连续点击。
_MOMENTS_ENTRY_NAMES = ("朋友圈", "发现", "Moments")
_MOMENTS_ENTRY_AUTO_IDS = ("MainWnd_Moments", "moments_entry")
_PUBLISH_BUTTON_NAMES = ("发表", "发布", "Publish")
_PUBLISH_BUTTON_AUTO_IDS = ("publish_button", "PublishButton")
_EDITOR_TEXT_CONTROL_TYPES = ("Edit", "Document")
_ADD_IMAGE_NAMES = ("图片", "添加图片", "图片和视频")
_VISIBILITY_ENTRY_NAMES = ("谁可以看", "可见范围", "谁可以看？")
_VISIBILITY_DONE_NAMES = ("完成", "确定")
_IMAGE_LIST_CONTROL_TYPES = ("List", "ListBox")

_LOGIN_CLASS_NAMES = {"wechatloginwndforpc", "wechatlogindlgforpc", "weixinloginwnd"}


class PublishAttemptError(ExecutorError):
    """点击“发表”时发生的异常。

    ``may_have_submitted=True`` 表示点击动作可能已经生效（例如点击后等待超时/崩溃），
    上层必须返回 ``uncertain=True`` 并禁止自动重试。
    """

    def __init__(
        self,
        code: str,
        message: str,
        *,
        may_have_submitted: bool,
        retryable: bool | None = None,
    ) -> None:
        super().__init__(code, message, retryable=retryable)
        self.may_have_submitted = bool(may_have_submitted)


# ---------------------------------------------------------------------------
# 抽象接口
# ---------------------------------------------------------------------------


class WechatDriver(abc.ABC):
    """桌面微信驱动抽象接口。"""

    @property
    @abc.abstractmethod
    def uia_available(self) -> bool:
        """当前环境是否具备可用的 UI Automation 客户端库。"""

    @property
    def driver_name(self) -> str:
        return type(self).__name__

    @abc.abstractmethod
    def get_installation(self) -> WechatInstallation:
        """只读检测客户端安装信息。"""

    @abc.abstractmethod
    def get_status(self, timeout: float | None = None) -> WechatStatus:
        """读取客户端运行/登录/版本/桌面交互状态。"""

    @abc.abstractmethod
    def open_moments_editor(self, timeout: float | None = None) -> None:
        """通过控件身份打开朋友圈发表编辑器（不点击发表）。"""

    @abc.abstractmethod
    def fill_text(self, text: str, timeout: float | None = None) -> None:
        """填写朋友圈正文。"""

    @abc.abstractmethod
    def add_images(self, asset_paths: Sequence[str], timeout: float | None = None) -> None:
        """依次添加图片；任一张失败立即抛 UPLOAD_FAILED。"""

    @abc.abstractmethod
    def read_back(self, timeout: float | None = None) -> tuple[str, int]:
        """读回编辑器正文与图片数量。"""

    @abc.abstractmethod
    def set_visibility(self, visibility: str, timeout: float | None = None) -> None:
        """设置可见范围。"""

    @abc.abstractmethod
    def screenshot(self, dest_path: str, timeout: float | None = None) -> str:
        """把当前编辑窗口截图保存到 dest_path。"""

    @abc.abstractmethod
    def click_publish(self, timeout: float | None = None) -> None:
        """点击“发表”；仅在 server 明确允许发布时调用。"""

    @abc.abstractmethod
    def verify_published(
        self,
        expected_text: str,
        expected_image_count: int,
        *,
        evidence_path: str | None = None,
        timeout: float | None = None,
    ) -> Verification:
        """点击后核验朋友圈列表/详情；无法确认返回 verified=False（不重试）。"""

    def supports_visibility(self, visibility: str) -> bool:
        """当前客户端是否支持该可见范围。"""
        return visibility in VISIBILITIES

    def cancel(self) -> None:
        """请求停止当前操作（默认无状态；真实驱动在步骤间检查）。"""
        self._cancel_requested = True


# ---------------------------------------------------------------------------
# 真实驱动（Windows UI Automation）
# ---------------------------------------------------------------------------


class RealWechatDriver(WechatDriver):
    """基于 Windows UI Automation 的真实驱动。

    重要说明（诚实声明）：
    - pywinauto/comtypes 缺失时只做只读状态检测，所有 GUI 操作返回
      ``DESKTOP_UNSUPPORTED``；
    - 即使依赖可用，本机微信 4.1.15.13 的控件树尚未人工验证，相关控件定位
      代码属于“未测试实现”，README 中标记 NOT_TESTED，不能据此声称支持 4.x。
    """

    def __init__(
        self,
        config: Any,
        *,
        locator: WindowLocator | None = None,
        logger: logging.Logger | None = None,
    ) -> None:
        self._config = config
        self._locator = locator or WindowLocator()
        self._logger = logger or _LOGGER
        self._uia_backend: str | None = None
        self._uia_error: str | None = None
        self._comtypes_available = False
        self._pywinauto_version: str | None = None
        self._app: Any | None = None
        self._window: WindowInfo | None = None
        self._editor: Any | None = None
        self._submitted = False
        self._cancel_requested = False
        self._probe_uia()

    # -- 依赖探测 ---------------------------------------------------------

    def _probe_uia(self) -> None:
        try:
            import pywinauto  # type: ignore[import-not-found]

            self._uia_backend = "pywinauto"
            self._pywinauto_version = getattr(pywinauto, "__version__", "unknown")
            self._logger.info("UI Automation 后端可用：pywinauto %s", self._pywinauto_version)
        except Exception as exc:  # ImportError 或其他装载失败都不允许崩溃
            self._uia_backend = None
            self._uia_error = f"{type(exc).__name__}: {exc}"
            self._logger.info("pywinauto 不可用（%s），真实 GUI 操作将返回 DESKTOP_UNSUPPORTED", self._uia_error)
        try:
            import comtypes  # type: ignore[import-not-found]  # noqa: F401

            self._comtypes_available = True
        except Exception:
            self._comtypes_available = False

    @property
    def uia_available(self) -> bool:
        return self._uia_backend is not None

    def _require_uia(self) -> None:
        if not self.uia_available:
            detail = "未安装 pywinauto（Windows UI Automation 客户端库缺失）"
            if self._comtypes_available:
                detail += "；仅检测到 comtypes，但未实现直接 UIA 封装"
            raise ExecutorError("DESKTOP_UNSUPPORTED", detail + "，无法执行真实 GUI 操作；仅支持 Mock 测试")

    # -- 安装与状态 -------------------------------------------------------

    def get_installation(self) -> WechatInstallation:
        return self._locator.detect_installation(self._config.wechat_exe_names)

    def _wechat_processes(self) -> list[Any]:
        exe_lower = {name.lower() for name in self._config.wechat_exe_names}
        return [process for process in self._locator.list_processes() if process.name.lower() in exe_lower]

    def get_status(self, timeout: float | None = None) -> WechatStatus:
        deadline = _deadline(timeout if timeout is not None else self._config.status_timeout)
        installation = self.get_installation()
        interactive, locked, notes = self._locator.is_interactive_desktop()
        notes = list(notes)
        processes = self._wechat_processes() if installation.installed else []
        window: WindowInfo | None = None
        login_window: WindowInfo | None = None
        if installation.installed:
            # 进程枚举可能因完整性级别/ACL 看不到高权限微信进程；
            # 窗口存在同样说明客户端在运行，不能仅凭进程列表判定“未运行”。
            window = self._locator.find_main_window(
                self._config.wechat_exe_names,
                self._config.wechat_window_titles,
                self._config.wechat_window_classes,
            )
            login_window = self._locator.find_login_window(self._config.wechat_exe_names)
        running = bool(processes) or window is not None or login_window is not None
        logged_in = False
        account_id: str | None = None
        version = installation.version if installation.installed else None
        if not installation.installed:
            notes.append("未找到微信客户端（WeChat.exe / Weixin.exe）")
        if running:
            if window is not None:
                logged_in = True
            elif login_window is not None:
                window = login_window
                logged_in = False
                notes.append("检测到微信登录窗口，当前未登录")
            else:
                notes.append("微信进程存在，但未找到主窗口（可能仍在启动或已最小化到托盘）")
            if logged_in and self.uia_available:
                account_id = self.read_account_id(timeout=_remaining(deadline))
                if account_id is None:
                    notes.append("无法通过 UI Automation 可靠读取登录 wxid，账号需人工确认")
            elif logged_in and not self.uia_available:
                notes.append("UI Automation 库缺失，无法读取登录账号")
        else:
            notes.append("微信客户端未运行")
        supported = bool(
            installation.installed
            and version is not None
            and self.uia_available
            and version in tuple(self._config.supported_versions)
        )
        assumed_version = getattr(self._config, "assumed_client_version", None)
        if assumed_version:
            # 已由人工确认当前运行的是该版本（高权限进程路径不可读时，文件版本探测
            # 可能来自另一个安装）。仅在显式配置时覆盖，且版本必须在支持列表内。
            version = assumed_version
            supported = bool(
                installation.installed and self.uia_available and assumed_version in tuple(self._config.supported_versions)
            )
            notes.append(f"使用已配置的假定客户端版本 {assumed_version}（已人工确认），supported={supported}")
        if installation.installed and version and version not in tuple(self._config.supported_versions):
            notes.append(
                f"客户端版本 {version} 未在已验证列表 {list(self._config.supported_versions)} 内，supported=false"
            )
        if installation.installed and not self.uia_available:
            notes.append("UI Automation 客户端库缺失（pywinauto/comtypes 均不可用），真实发布未测试")
        window_title = window.title if window is not None else None
        dpi_scale = window.dpi_scale if window is not None else None
        return WechatStatus(
            running=running,
            logged_in=logged_in,
            account_id=account_id,
            version=version,
            interactive=interactive,
            locked=locked,
            supported=supported,
            window_title=window_title,
            dpi_scale=dpi_scale,
            notes=_limit_notes(notes),
        )

    def read_account_id(self, timeout: float | None = None) -> str | None:
        """尝试从 UI Automation 控件文本中读取 wxid；读不到返回 None，绝不猜测。"""
        if not self.uia_available:
            return None
        try:
            window = self._locator.find_main_window(
                self._config.wechat_exe_names,
                self._config.wechat_window_titles,
                self._config.wechat_window_classes,
            )
            if window is None:
                return None
            app = self._connect(window.hwnd, timeout)
            main = app.window(handle=window.hwnd)
            pattern = r"wxid_[A-Za-z0-9_-]+"
            for control in main.descendants():
                try:
                    name = control.window_text()
                except Exception:
                    continue
                if name and name.startswith("wxid_"):
                    return name.strip()
            return None
        except Exception as exc:
            self._logger.info("读取微信账号失败（已按未验证处理）：%s", type(exc).__name__)
            return None

    # -- 就绪检查与 UIA 基础工具 -----------------------------------------

    def _require_ready(self, timeout: float | None = None) -> WechatStatus:
        self._require_uia()
        status = self.get_status(timeout)
        if not status.interactive:
            raise ExecutorError("INTERACTIVE_DESKTOP_UNAVAILABLE", "当前没有可交互桌面（锁屏或会话断开），已停止操作")
        if not status.running:
            raise ExecutorError("WECHAT_NOT_RUNNING", "微信客户端未运行，已停止操作")
        if not status.logged_in:
            raise ExecutorError("WECHAT_NOT_LOGGED_IN", "微信未登录，已停止操作")
        window = self._locator.find_main_window(
            self._config.wechat_exe_names,
            self._config.wechat_window_titles,
            self._config.wechat_window_classes,
        )
        if window is None:
            raise ExecutorError("WINDOW_NOT_FOUND", "未找到微信主窗口，已停止操作")
        self._window = window
        return status

    def _connect(self, hwnd: int, timeout: float | None = None) -> Any:
        self._require_uia()
        try:
            from pywinauto import Application  # type: ignore[import-not-found]
        except Exception as exc:  # pragma: no cover - 惰性导入兜底
            raise ExecutorError("DESKTOP_UNSUPPORTED", "pywinauto 不可用，无法连接微信窗口") from exc
        try:
            app = Application(backend="uia").connect(
                handle=hwnd,
                timeout=timeout if timeout is not None else self._config.status_timeout,
            )
            self._app = app
            return app
        except Exception as exc:
            raise ExecutorError("WINDOW_NOT_FOUND", f"无法连接微信窗口：{type(exc).__name__}") from exc

    def _main_window(self, timeout: float | None = None) -> Any:
        self._require_ready(timeout)
        assert self._window is not None
        app = self._connect(self._window.hwnd, timeout)
        try:
            return app.window(handle=self._window.hwnd)
        except Exception as exc:
            raise ExecutorError("WINDOW_NOT_FOUND", "无法定位微信主窗口控件") from exc

    def _find_descendant(
        self,
        root: Any,
        *,
        names: Iterable[str] = (),
        auto_ids: Iterable[str] = (),
        control_types: Iterable[str] = (),
        timeout: float | None = None,
    ) -> Any | None:
        """按 Name / AutomationId / ControlType 组合定位子控件，找不到返回 None。"""
        deadline = _deadline(timeout if timeout is not None else self._config.status_timeout)
        name_list = list(names)
        auto_id_list = list(auto_ids)
        type_list = list(control_types)
        while True:
            for name in name_list:
                for control_type in type_list or (None,):
                    try:
                        spec = {"title": name}
                        if control_type:
                            spec["control_type"] = control_type
                        return root.child_window(**spec).wait("exists", timeout=0.5)
                    except Exception:
                        continue
            for auto_id in auto_id_list:
                try:
                    return root.child_window(auto_id=auto_id).wait("exists", timeout=0.5)
                except Exception:
                    continue
            # 只给 ControlType（例如编辑器正文 Edit）时直接按类型找第一个可见控件。
            for control_type in (() if name_list or auto_id_list else type_list):
                try:
                    candidate = root.child_window(control_type=control_type).wait("exists", timeout=0.5)
                    if candidate is not None:
                        return candidate
                except Exception:
                    continue
            if _remaining(deadline) <= 0:
                return None
            time.sleep(0.1)

    def _find_in_editor(self, names: Iterable[str], auto_ids: Iterable[str], control_types: Iterable[str]) -> Any:
        if self._editor is None:
            raise ExecutorError("WINDOW_NOT_FOUND", "朋友圈编辑窗口未打开，已停止操作")
        control = self._find_descendant(
            self._editor,
            names=names,
            auto_ids=auto_ids,
            control_types=control_types,
            timeout=self._config.status_timeout,
        )
        if control is None:
            raise ExecutorError("WINDOW_NOT_FOUND", "未找到朋友圈编辑器控件，已停止操作")
        return control

    # -- 打开编辑器 -------------------------------------------------------

    def open_moments_editor(self, timeout: float | None = None) -> None:
        self._require_uia()
        status = self._require_ready(timeout)
        if not status.supported:
            raise ExecutorError(
                "CLIENT_VERSION_UNSUPPORTED",
                f"客户端版本 {status.version or '未知'} 未在已验证列表内，或 UI 控件树未验证，已停止操作",
            )
        deadline = _deadline(timeout if timeout is not None else self._config.prepare_timeout)
        main = self._main_window(timeout)
        entry = self._find_descendant(main, names=_MOMENTS_ENTRY_NAMES, auto_ids=_MOMENTS_ENTRY_AUTO_IDS)
        if entry is None:
            raise ExecutorError("WINDOW_NOT_FOUND", "未找到朋友圈入口控件，已停止操作")
        clicked = 0
        try:
            entry.click_input()
            clicked += 1
        except Exception as exc:
            raise ExecutorError("WINDOW_BLOCKED", "点击朋友圈入口失败（控件被遮挡或不可用）") from exc
        # 等朋友圈窗口出现，再点一次“发表”（最多一次，避免盲目连续点击）。
        moments_window = self._wait_window_by_title(("朋友圈", "发表", "Moments"), deadline)
        if moments_window is None:
            raise ExecutorError("WINDOW_NOT_FOUND", "未找到朋友圈窗口，已停止操作")
        publish_entry = self._find_descendant(moments_window, names=_PUBLISH_BUTTON_NAMES, control_types=("Button", "Text"))
        if publish_entry is None:
            raise ExecutorError("WINDOW_NOT_FOUND", "未找到“发表”入口控件，已停止操作")
        if clicked >= 2:  # 防御性保护：本流程最多两次入口点击
            raise ExecutorError("WINDOW_BLOCKED", "界面响应异常，已停止点击")
        try:
            publish_entry.click_input()
        except Exception as exc:
            raise ExecutorError("WINDOW_BLOCKED", "打开朋友圈编辑器失败（控件被遮挡或不可用）") from exc
        editor = self._wait_editor(deadline)
        if editor is None:
            raise ExecutorError("WINDOW_NOT_FOUND", "未找到朋友圈编辑窗口，已停止操作")
        self._editor = editor
        # 新一次编辑会话重置“已点击”标记；跨 attempt 不允许复用上一次的点击状态。
        self._submitted = False

    def _wait_window_by_title(self, titles: Sequence[str], deadline: float) -> Any | None:
        assert self._app is not None
        while _remaining(deadline) > 0:
            try:
                for window in self._app.windows():
                    try:
                        title = window.window_text()
                    except Exception:
                        continue
                    if any(hint in (title or "") for hint in titles):
                        return window
            except Exception:
                pass
            time.sleep(0.2)
        return None

    def _wait_editor(self, deadline: float) -> Any | None:
        while _remaining(deadline) > 0:
            try:
                assert self._app is not None
                for window in self._app.windows():
                    try:
                        if window.child_window(control_type="Edit").exists(timeout=0.2):
                            return window
                    except Exception:
                        continue
            except Exception:
                pass
            time.sleep(0.2)
        return None

    # -- 填写正文 ---------------------------------------------------------

    def fill_text(self, text: str, timeout: float | None = None) -> None:
        self._require_uia()
        control = self._find_in_editor((), (), _EDITOR_TEXT_CONTROL_TYPES)
        deadline = _deadline(timeout if timeout is not None else self._config.prepare_timeout)
        try:
            # 优先 ValuePattern；失败回退“点击 + 剪贴板粘贴”，剪贴板用完立即清空。
            try:
                control.set_edit_text(text)
            except Exception:
                control.click_input()
                if not _set_clipboard_text(text):
                    raise ExecutorError("DESKTOP_UNSUPPORTED", "无法写入剪贴板，不能回退粘贴正文")
                try:
                    _send_ctrl_v()
                finally:
                    _clear_clipboard()
        except ExecutorError:
            raise
        except Exception as exc:
            raise ExecutorError("WINDOW_NOT_FOUND", f"填写正文失败：{type(exc).__name__}") from exc
        if _remaining(deadline) <= 0:
            raise ExecutorError("WINDOW_BLOCKED", "填写正文超时，已停止操作")

    # -- 添加图片 ---------------------------------------------------------

    def add_images(self, asset_paths: Sequence[str], timeout: float | None = None) -> None:
        self._require_uia()
        deadline = _deadline(timeout if timeout is not None else self._config.prepare_timeout)
        for path in asset_paths:
            if _remaining(deadline) <= 0:
                raise ExecutorError("WINDOW_BLOCKED", "添加图片超时，已停止操作")
            self._add_one_image(path, deadline)

    def _add_one_image(self, path: str, deadline: float) -> None:
        if self._editor is None:
            raise ExecutorError("WINDOW_NOT_FOUND", "朋友圈编辑窗口未打开，已停止操作")
        try:
            add_button = self._find_descendant(
                self._editor, names=_ADD_IMAGE_NAMES, control_types=("Button", "Text", "ListItem")
            )
            if add_button is None:
                raise ExecutorError("WINDOW_NOT_FOUND", "未找到“图片”按钮，已停止操作")
            add_button.click_input()
            dialog = self._wait_file_dialog(deadline)
            if dialog is None:
                raise ExecutorError("WINDOW_NOT_FOUND", "文件选择对话框未出现，已停止操作")
            filename_edit = self._find_descendant(
                dialog, names=("文件名", "File name"), auto_ids=("1148", "1001"), control_types=("Edit", "ComboBox")
            )
            if filename_edit is None:
                # 一些版本的文件对话框可直接通过 UIA 的 Edit 输入路径。
                filename_edit = self._find_descendant(dialog, names=(), auto_ids=(), control_types=("Edit",))
            if filename_edit is None:
                raise ExecutorError("UPLOAD_FAILED", "无法定位文件对话框输入框，添加图片失败")
            filename_edit.set_edit_text(normalize_path(path))
            open_button = self._find_descendant(
                dialog, names=("打开", "Open"), auto_ids=("1",), control_types=("Button",)
            )
            if open_button is None:
                raise ExecutorError("UPLOAD_FAILED", "无法定位文件对话框“打开”按钮，添加图片失败")
            open_button.click_input()
            if not self._wait_image_loaded(deadline):
                raise ExecutorError("UPLOAD_FAILED", "图片未成功加入编辑器，已停止操作")
        except ExecutorError:
            raise
        except Exception as exc:
            raise ExecutorError("UPLOAD_FAILED", f"添加图片失败：{type(exc).__name__}") from exc

    def _wait_file_dialog(self, deadline: float) -> Any | None:
        assert self._app is not None
        while _remaining(deadline) > 0:
            try:
                for window in self._app.windows():
                    try:
                        if window.window_text() in ("打开", "Open") or window.class_name() == "#32770":
                            return window
                    except Exception:
                        continue
            except Exception:
                pass
            time.sleep(0.2)
        return None

    def _wait_image_loaded(self, deadline: float) -> bool:
        if self._editor is None:
            return False
        while _remaining(deadline) > 0:
            try:
                for control in self._editor.descendants(control_type="Image"):
                    if control.is_visible():
                        return True
            except Exception:
                pass
            time.sleep(0.2)
        return False

    # -- 读回 / 可见范围 --------------------------------------------------

    def read_back(self, timeout: float | None = None) -> tuple[str, int]:
        self._require_uia()
        control = self._find_in_editor((), (), _EDITOR_TEXT_CONTROL_TYPES)
        try:
            text = ""
            for getter in ("get_value", "window_text"):
                try:
                    value = getattr(control, getter)()
                    if isinstance(value, str):
                        text = value
                        break
                except Exception:
                    continue
            image_count = self._count_editor_images()
            return text, image_count
        except Exception as exc:
            raise ExecutorError("WINDOW_NOT_FOUND", f"读取编辑窗口内容失败：{type(exc).__name__}") from exc

    def _count_editor_images(self) -> int:
        if self._editor is None:
            return 0
        try:
            images: list[Any] = []
            for control_type in _IMAGE_LIST_CONTROL_TYPES:
                try:
                    lists = self._editor.descendants(control_type=control_type)
                except Exception:
                    continue
                for candidate in lists:
                    try:
                        images.extend(candidate.descendants(control_type="Image"))
                    except Exception:
                        continue
            if images:
                return len({_control_identity(item) for item in images})
            return len(self._editor.descendants(control_type="Image"))
        except Exception:
            return 0

    def set_visibility(self, visibility: str, timeout: float | None = None) -> None:
        self._require_uia()
        if visibility not in VISIBILITIES:
            raise ExecutorError("BAD_REQUEST", "未知的可见范围")
        if visibility == "PARTIAL":
            raise ExecutorError("DESKTOP_UNSUPPORTED", "当前实现不支持“部分可见”名单设置，已停止操作")
        self._configure_visibility(visibility, timeout)

    def _configure_visibility(self, visibility: str, timeout: float | None) -> None:
        if self._editor is None:
            raise ExecutorError("WINDOW_NOT_FOUND", "朋友圈编辑窗口未打开，已停止操作")
        deadline = _deadline(timeout if timeout is not None else self._config.prepare_timeout)
        try:
            entry = self._find_descendant(self._editor, names=_VISIBILITY_ENTRY_NAMES, control_types=("Button", "Text"))
            if entry is None:
                raise ExecutorError("WINDOW_NOT_FOUND", "未找到可见范围入口，已停止操作")
            entry.click_input()
            option = None
            for label in VISIBILITY_LABELS[visibility]:
                option = self._find_descendant(self._editor, names=(label,), control_types=("RadioButton", "ListItem", "Text"))
                if option is not None:
                    break
            if option is None:
                raise ExecutorError("WINDOW_NOT_FOUND", "未找到可见范围选项，已停止操作")
            option.click_input()
            done = self._find_descendant(self._editor, names=_VISIBILITY_DONE_NAMES, control_types=("Button",))
            if done is not None:
                done.click_input()
        except ExecutorError:
            raise
        except Exception as exc:
            raise ExecutorError("WINDOW_BLOCKED", f"设置可见范围失败：{type(exc).__name__}") from exc
        if _remaining(deadline) <= 0:
            raise ExecutorError("WINDOW_BLOCKED", "设置可见范围超时，已停止操作")

    # -- 截图 -------------------------------------------------------------

    def screenshot(self, dest_path: str, timeout: float | None = None) -> str:
        self._require_uia()
        if self._editor is None:
            raise ExecutorError("WINDOW_NOT_FOUND", "朋友圈编辑窗口未打开，无法截图")
        try:
            hwnd = int(self._editor.handle)
        except Exception as exc:
            raise ExecutorError("WINDOW_NOT_FOUND", "无法获取编辑窗口句柄，截图失败") from exc
        return self._locator.capture_window_png(
            hwnd,
            dest_path,
            timeout=timeout if timeout is not None else self._config.screenshot_timeout,
        )

    # -- 点击发表 ---------------------------------------------------------

    def click_publish(self, timeout: float | None = None) -> None:
        self._require_uia()
        if self._submitted:
            raise ExecutorError("ALREADY_SUBMITTED", "本次执行已经点击过发表，禁止重复点击")
        if self._editor is None:
            raise ExecutorError("WINDOW_NOT_FOUND", "朋友圈编辑窗口未打开，已停止操作")
        button = self._find_descendant(self._editor, names=_PUBLISH_BUTTON_NAMES, auto_ids=_PUBLISH_BUTTON_AUTO_IDS, control_types=("Button",))
        if button is None:
            raise ExecutorError("WINDOW_NOT_FOUND", "未找到“发表”按钮，已停止操作")
        try:
            if hasattr(button, "is_enabled") and not button.is_enabled():
                raise ExecutorError("WINDOW_BLOCKED", "“发表”按钮不可用，已停止操作")
        except ExecutorError:
            raise
        except Exception:
            pass
        try:
            button.click_input()
        except Exception as exc:
            # 点击动作可能已经送达客户端：按“可能已发表”处理，返回 UNCERTAIN 禁止重试。
            raise PublishAttemptError(
                "UNCERTAIN",
                "点击“发表”后等待界面响应失败，无法确认是否已发布",
                may_have_submitted=True,
            ) from exc
        self._submitted = True

    # -- 核验 -------------------------------------------------------------

    def verify_published(
        self,
        expected_text: str,
        expected_image_count: int,
        *,
        evidence_path: str | None = None,
        timeout: float | None = None,
    ) -> Verification:
        self._require_uia()
        deadline = _deadline(timeout if timeout is not None else self._config.verify_timeout)
        notes: list[str] = []
        visible_text: str | None = None
        image_count: int | None = None
        verified = False
        try:
            window = self._wait_window_by_title(("朋友圈", "Moments"), deadline)
            if window is None:
                notes.append("点击发表后未找到朋友圈窗口")
            else:
                matched = self._find_published_item(window, expected_text, deadline)
                if matched is not None:
                    visible_text, image_count = matched
                    verified = normalize_text(visible_text) == normalize_text(expected_text)
                    if not verified:
                        notes.append("朋友圈列表中的正文与预期不一致")
                    if image_count != expected_image_count:
                        notes.append(f"朋友圈图片数量 {image_count} 与预期 {expected_image_count} 不一致")
                        verified = False
                else:
                    notes.append("未能在朋友圈列表中找到与预期正文匹配的内容")
        except Exception as exc:
            notes.append(f"核验过程异常：{type(exc).__name__}")
            verified = False

        evidence: str | None = None
        if evidence_path:
            try:
                window_hwnd = None
                if self._app is not None:
                    for candidate in self._app.windows():
                        try:
                            if "朋友圈" in (candidate.window_text() or ""):
                                window_hwnd = int(candidate.handle)
                                break
                        except Exception:
                            continue
                if window_hwnd is None and self._window is not None:
                    window_hwnd = self._window.hwnd
                if window_hwnd is not None:
                    evidence = self._locator.capture_window_png(window_hwnd, evidence_path)
            except Exception as exc:
                notes.append(f"证据截图失败：{type(exc).__name__}")
        if evidence is None and evidence_path and os.path.isfile(evidence_path):
            evidence = evidence_path
        return Verification(
            verified=verified,
            method="uia-list-readback",
            published_at=utc_now_iso() if verified else None,
            visible_text=visible_text,
            image_count=image_count,
            evidence_path=evidence,
            notes=_limit_notes(notes),
        )

    def _find_published_item(self, window: Any, expected_text: str, deadline: float) -> tuple[str, int] | None:
        target = normalize_text(expected_text)
        while _remaining(deadline) > 0:
            try:
                for item in window.descendants(control_type="ListItem"):
                    try:
                        texts = [control.window_text() for control in item.descendants(control_type="Text")]
                    except Exception:
                        continue
                    for value in texts:
                        if normalize_text(value) == target:
                            try:
                                images = item.descendants(control_type="Image")
                            except Exception:
                                images = []
                            return value, len(images)
            except Exception:
                pass
            time.sleep(0.3)
        return None


# ---------------------------------------------------------------------------
# 测试用 Fake 驱动
# ---------------------------------------------------------------------------


class FakeWechatDriver(WechatDriver):
    """可编程假驱动：只用于单元测试，不访问网络、不启动微信、不点击桌面。"""

    def __init__(
        self,
        *,
        installed: bool = True,
        exe_path: str = r"C:\fake\Weixin\Weixin.exe",
        version: str = "4.1.10.27",
        supported: bool = True,
        running: bool = True,
        logged_in: bool = True,
        account_id: str | None = "wxid_fake_account",
        interactive: bool = True,
        locked: bool = False,
        window_found: bool = True,
        text_match: bool = True,
        text_override: str | None = None,
        upload_fail: bool = False,
        set_visibility_fail: bool = False,
        screenshot_fail: bool = False,
        publish_outcome: str = "verified",
        status_error: ExecutorError | None = None,
        delay_seconds: float = 0.0,
        delay_stage: str = "",
        supports_partial: bool = True,
    ) -> None:
        self.installed = installed
        self.exe_path = exe_path
        self.version = version
        self.supported = supported
        self.running = running and installed
        self.logged_in = logged_in
        self.account_id = account_id
        self.interactive = interactive
        self.locked = locked
        self.window_found = window_found
        self.text_match = text_match
        self.text_override = text_override
        self.upload_fail = upload_fail
        self.set_visibility_fail = set_visibility_fail
        self.screenshot_fail = screenshot_fail
        self.publish_outcome = publish_outcome
        self.status_error = status_error
        self.delay_seconds = float(delay_seconds)
        self.delay_stage = delay_stage
        self.supports_partial = supports_partial

        self.calls: list[str] = []
        self.editor_open = False
        self.prepared_text = ""
        self.prepared_images: list[str] = []
        self.visibility = "PUBLIC"
        self.clicked = False
        self.click_count = 0
        self.verify_count = 0
        self.screenshot_paths: list[str] = []
        self._cancel_requested = False

    @property
    def uia_available(self) -> bool:
        return True

    def _stage(self, name: str) -> None:
        self.calls.append(name)
        if self.delay_seconds > 0 and self.delay_stage == name:
            time.sleep(self.delay_seconds)
        if self._cancel_requested:
            raise ExecutorError("CANCELLED", "操作已取消")

    def get_installation(self) -> WechatInstallation:
        return WechatInstallation(
            installed=self.installed,
            exe_path=self.exe_path if self.installed else None,
            version=self.version if self.installed else None,
            notes=[] if self.installed else ["未找到微信客户端"],
        )

    def get_status(self, timeout: float | None = None) -> WechatStatus:
        self._stage("get_status")
        if self.status_error is not None:
            raise self.status_error
        running = bool(self.installed and self.running)
        logged_in = bool(running and self.logged_in)
        notes: list[str] = []
        if not self.installed:
            notes.append("未找到微信客户端")
        if self.installed and not running:
            notes.append("微信客户端未运行")
        if running and not logged_in:
            notes.append("微信未登录")
        return WechatStatus(
            running=running,
            logged_in=logged_in,
            account_id=self.account_id if logged_in else None,
            version=self.version if self.installed else None,
            interactive=self.interactive,
            locked=self.locked,
            supported=self.supported,
            window_title="微信" if self.window_found and logged_in else None,
            dpi_scale=1.0,
            notes=notes,
        )

    def open_moments_editor(self, timeout: float | None = None) -> None:
        self._stage("open_moments_editor")
        if not self.window_found:
            raise ExecutorError("WINDOW_NOT_FOUND", "未找到微信主窗口，已停止操作")
        if self.locked or not self.interactive:
            raise ExecutorError("INTERACTIVE_DESKTOP_UNAVAILABLE", "当前没有可交互桌面，已停止操作")
        self.editor_open = True

    def fill_text(self, text: str, timeout: float | None = None) -> None:
        self._stage("fill_text")
        if not self.editor_open:
            raise ExecutorError("WINDOW_NOT_FOUND", "朋友圈编辑窗口未打开，已停止操作")
        self.prepared_text = text

    def add_images(self, asset_paths: Sequence[str], timeout: float | None = None) -> None:
        self._stage("add_images")
        if self.upload_fail:
            raise ExecutorError("UPLOAD_FAILED", "图片添加失败，已停止操作")
        self.prepared_images = list(asset_paths)

    def read_back(self, timeout: float | None = None) -> tuple[str, int]:
        self._stage("read_back")
        if self.text_match:
            return self.prepared_text, len(self.prepared_images)
        changed = self.text_override if self.text_override is not None else self.prepared_text + "（内容已变化）"
        return changed, len(self.prepared_images)

    def set_visibility(self, visibility: str, timeout: float | None = None) -> None:
        self._stage("set_visibility")
        if self.set_visibility_fail:
            raise ExecutorError("DESKTOP_UNSUPPORTED", "当前客户端不支持设置可见范围")
        if visibility == "PARTIAL" and not self.supports_partial:
            raise ExecutorError("DESKTOP_UNSUPPORTED", "当前客户端不支持“部分可见”")
        self.visibility = visibility

    def supports_visibility(self, visibility: str) -> bool:
        return visibility != "PARTIAL" or self.supports_partial

    def screenshot(self, dest_path: str, timeout: float | None = None) -> str:
        self._stage("screenshot")
        if self.screenshot_fail:
            raise ExecutorError("WINDOW_NOT_FOUND", "截图失败，已停止操作")
        target = normalize_path(dest_path)
        parent = os.path.dirname(target)
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(target, "wb") as handle:
            handle.write(solid_png(4, 4, (30, 120, 200)))
        self.screenshot_paths.append(target)
        return target

    def click_publish(self, timeout: float | None = None) -> None:
        self._stage("click_publish")
        self.click_count += 1
        if self.publish_outcome == "click_error":
            raise ExecutorError("WINDOW_BLOCKED", "“发表”按钮不可用，已停止操作")
        if self.publish_outcome == "click_timeout":
            raise PublishAttemptError(
                "UNCERTAIN",
                "点击“发表”后等待界面响应超时，无法确认是否已发布",
                may_have_submitted=True,
            )
        self.clicked = True

    def verify_published(
        self,
        expected_text: str,
        expected_image_count: int,
        *,
        evidence_path: str | None = None,
        timeout: float | None = None,
    ) -> Verification:
        self._stage("verify_published")
        self.verify_count += 1
        if self.publish_outcome == "verify_error":
            raise ExecutorError("WINDOW_NOT_FOUND", "读取朋友圈列表失败，无法确认发布结果")
        if not self.clicked:
            return Verification(verified=False, method="fake-uia-list-readback", notes=["未检测到发表点击"])
        if self.publish_outcome != "verified":
            return Verification(
                verified=False,
                method="fake-uia-list-readback",
                visible_text=expected_text,
                image_count=expected_image_count,
                notes=["无法确认新内容已出现在朋友圈列表"],
            )
        evidence: str | None = None
        if evidence_path:
            try:
                evidence = self.screenshot(evidence_path)
            except ExecutorError:
                evidence = None
        return Verification(
            verified=True,
            method="fake-uia-list-readback",
            published_at=utc_now_iso(),
            visible_text=expected_text,
            image_count=expected_image_count,
            evidence_path=evidence,
            notes=[],
        )


# ---------------------------------------------------------------------------
# 私有工具
# ---------------------------------------------------------------------------


def _deadline(timeout: float | None) -> float:
    seconds = 5.0 if timeout is None else max(0.05, float(timeout))
    return time.monotonic() + seconds


def _remaining(deadline: float) -> float:
    return deadline - time.monotonic()


def _limit_notes(notes: Iterable[str]) -> list[str]:
    result: list[str] = []
    for note in notes:
        if note and note not in result:
            result.append(note)
        if len(result) >= 32:
            break
    return result


def _is_login_window(window: WindowInfo) -> bool:
    if window.class_name.lower() in _LOGIN_CLASS_NAMES:
        return True
    title = (window.title or "").lower()
    return "登录" in title or "log in" in title or "login" in title


def _control_identity(control: Any) -> Any:
    for attribute in ("handle", "element_info"):
        try:
            value = getattr(control, attribute)
        except Exception:
            continue
        if value is not None:
            try:
                return int(value)
            except (TypeError, ValueError):
                return str(value)
    return id(control)


# ---------------------------------------------------------------------------
# 受限键鼠模拟（只用于“粘贴正文”这一条回退路径）
# ---------------------------------------------------------------------------


def _set_clipboard_text(text: str) -> bool:
    """把文本写入剪贴板；失败返回 False（调用方必须停止，不得继续输入）。"""
    if os.name != "nt":
        return False
    user32 = _load_user32()
    kernel32 = _load_kernel32()
    if user32 is None or kernel32 is None:
        return False
    CF_UNICODETEXT = 13
    GMEM_MOVEABLE = 0x0002
    opened = False
    try:
        if not user32.OpenClipboard(None):
            return False
        opened = True
        user32.EmptyClipboard()
        data = text.encode("utf-16-le") + b"\x00\x00"
        handle = kernel32.GlobalAlloc(GMEM_MOVEABLE, len(data))
        if not handle:
            return False
        pointer = kernel32.GlobalLock(handle)
        if not pointer:
            kernel32.GlobalFree(handle)
            return False
        try:
            ctypes.memmove(pointer, data, len(data))
        finally:
            kernel32.GlobalUnlock(handle)
        if not user32.SetClipboardData(CF_UNICODETEXT, handle):
            kernel32.GlobalFree(handle)
            return False
        return True
    except OSError:
        return False
    finally:
        if opened:
            try:
                user32.CloseClipboard()
            except OSError:  # pragma: no cover
                pass


def _clear_clipboard() -> None:
    if os.name != "nt":
        return
    user32 = _load_user32()
    if user32 is None:
        return
    try:
        if user32.OpenClipboard(None):
            try:
                user32.EmptyClipboard()
            finally:
                user32.CloseClipboard()
    except OSError:
        pass


def _send_ctrl_v() -> None:
    if os.name != "nt":
        raise ExecutorError("DESKTOP_UNSUPPORTED", "非 Windows 平台不支持键盘模拟")
    user32 = _load_user32()
    if user32 is None:
        raise ExecutorError("DESKTOP_UNSUPPORTED", "无法加载 user32，键盘模拟不可用")
    VK_CONTROL = 0x11
    VK_V = 0x56
    KEYEVENTF_KEYUP = 0x0002
    try:
        user32.keybd_event(VK_CONTROL, 0, 0, 0)
        user32.keybd_event(VK_V, 0, 0, 0)
        user32.keybd_event(VK_V, 0, KEYEVENTF_KEYUP, 0)
        user32.keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, 0)
    except OSError as exc:
        raise ExecutorError("DESKTOP_UNSUPPORTED", "模拟 Ctrl+V 失败") from exc


_user32_module: Any | None = None
_kernel32_module: Any | None = None


def _load_user32() -> Any | None:
    global _user32_module
    if _user32_module is None and os.name == "nt":
        try:
            _user32_module = ctypes.WinDLL("user32", use_last_error=True)
        except OSError:
            _user32_module = False
    return _user32_module or None


def _load_kernel32() -> Any | None:
    global _kernel32_module
    if _kernel32_module is None and os.name == "nt":
        try:
            _kernel32_module = ctypes.WinDLL("kernel32", use_last_error=True)
        except OSError:
            _kernel32_module = False
    return _kernel32_module or None
