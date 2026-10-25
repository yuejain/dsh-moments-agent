"""微信 4.x 几何/像素驱动（opt-in，默认不启用）。

背景
----
微信 4.1.10.27 的 Qt 窗口不暴露可用 UIA 控件树，已验证的发布路径是
「窗口几何 + 绿色按钮像素检测 + 剪贴板/右键菜单粘贴 + OCR 读回」。

2026-10-25 实测修正（150% DPI 环境）：
- 微信 4.x 的 Qt 界面按**物理像素**布局，KNOWN_PROFILES 坐标也是物理像素；
  因此窗口归一化目标是 **1200×900 物理像素**（不是逻辑像素）。按 DPI 放大到
  1800×1350 会让所有点位落在错误控件上（1.1.8 的回归）。
- 朋友圈文字编辑器与右键菜单是**独立顶层窗口**：PrintWindow(主窗口) 截不到它们，
  必须在窗口置前时用屏幕 BitBlt 捕获窗口矩形（``_capture_screen_rgb``）再做 OCR/
  绿色按钮检测/读回核验。
- 执行器进程必须 Per-Monitor-V2 DPI 感知，否则 SetCursorPos / GetWindowRect
  会被系统二次缩放；``ensure_dpi_aware()`` 在驱动构造时兜底。
- 管理员权限：微信进程未提权时，同完整性（非管理员）输入是允许的；默认按目标
  进程提权状态自动判断（``geometry_require_admin=False``），只有微信本身提权时
  才要求管理员。

安全边界
--------
- 不进行键盘注入（Ctrl+V 被微信 4.x 拦截）；文本只通过剪贴板 + 鼠标右键菜单；
- 所有点击前必须用像素检测确认绿色「发表」按钮；检测不到时绝不盲点；
- 所有屏幕捕获前必须确认前台窗口属于微信进程，且微信窗口矩形未被移动/缩放；
- OCR 不可用/超时：返回 ``OCR_UNAVAILABLE`` / ``OCR_TIMEOUT``，不伪造成功；
- 点击后无法确认（编辑器关闭状态未知、出现错误 toast、按钮仍在）：
  返回 uncertain，禁止自动二次点击（仅白名单条件下允许有限重试）；
- 删除只针对 OCR 匹配到的首条动态，匹配不到/多条匹配/区域未知时拒绝删除。

测试
----
所有副作用（截图、OCR、鼠标、剪贴板、管理员判定、sleep）均可注入，
单元测试不需要真实微信、不需要 PIL/winsdk。
"""
from __future__ import annotations

import abc
import ctypes
from ctypes import wintypes
import logging
import os
import time
from dataclasses import dataclass
from typing import Any, Callable, Iterable, Sequence

from .config import (
    ExecutorConfig,
    ExecutorError,
    Verification,
    WechatInstallation,
    WechatStatus,
    ensure_directory_under,
    normalize_path,
    resolve_under,
    safe_filename_component,
    utc_now_iso,
)
from .ocr import (
    OcrBBox,
    OcrProvider,
    OcrResult,
    contains_expected_text_fuzzy,
    create_ocr_provider,
    find_error_toast,
    line_similarity,
    locate_token,
    normalize_ocr_text,
)
from .wechat4_geometry import WeChat4Geometry, WindowRect, detect_publish_button_rgb
from .adaptive_locator import locate_controls
from .wechat_driver import PublishAttemptError, WechatDriver
from .window_locator import (
    WindowInfo,
    WindowLocator,
    encode_png_rgb,
    ensure_dpi_aware,
    foreground_window,
    process_is_elevated,
    window_process_id,
)

_LOGGER = logging.getLogger("dsh_moments.desktop.geometry")

# 几何流程等待时间（真实 UI 操作需要给客户端渲染时间；测试通过注入 sleep 跳过）。
_NAV_WAIT = 0.7
_MOMENTS_WAIT = 1.4
_EDITOR_WAIT = 1.3
_MENU_WAIT = 0.5
_PASTE_WAIT = 0.8
_HOVER_WAIT = 0.4
_DIALOG_WAIT = 0.8
_AFTER_DELETE_WAIT = 1.0

# prepare 阶段可重试的错误码白名单（其余错误立即停止）。
_RETRYABLE_PREPARE_CODES = frozenset({"WINDOW_NOT_FOUND", "WINDOW_BLOCKED", "OCR_TIMEOUT"})

# 删除只允许在已测绘的首条动态区域（避免误删其他动态）。
_DELETE_TOP_REGION_RATIO = 0.45

# 已知窗口 profile 尺寸（**物理像素**，与 wechat4_geometry.KNOWN_PROFILES 对齐）。
_STANDARD_WINDOW_SIZE = (1200, 900)
_FALLBACK_WINDOW_SIZE = (1342, 971)
_PROFILE_SIZES = (_STANDARD_WINDOW_SIZE, _FALLBACK_WINDOW_SIZE)

# 纯文字朋友圈编辑器的 OCR 特征（编辑器是独立顶层窗口，只能屏幕捕获）。
# 只使用编辑器独有的文案，避免把朋友圈信息流误判成编辑器。
_EDITOR_HINT_TOKENS = ("这一刻的想法", "谁可以看", "提醒谁看")


def normalization_plan(work_area, width: int = _STANDARD_WINDOW_SIZE[0], height: int = _STANDARD_WINDOW_SIZE[1]):
    """把微信主窗口调整为固定**物理像素**外框尺寸（不低于已知 profile 尺寸）。

    微信 4.x 的 Qt 界面按物理像素布局，profile 坐标也是物理像素；窗口尺寸必须
    以物理像素匹配 profile，才能复用已验证的点击点位。这里不修改显示器分辨率、
    系统缩放或发布权限，只调整微信窗口。
    """
    width, height = int(width), int(height)
    if width <= 0 or height <= 0:
        raise ExecutorError("WINDOW_BLOCKED", "标准窗口尺寸非法，已停止尺寸调整")
    left, top, right, bottom = work_area
    avail_w, avail_h = right - left, bottom - top
    if width > avail_w or height > avail_h:
        raise ExecutorError(
            "WINDOW_BLOCKED",
            f"当前显示器可用区域 {avail_w}×{avail_h} 物理像素无法容纳标准微信窗口 "
            f"{width}×{height}；请使用分辨率足够的显示器后重试",
        )
    x = left + (avail_w - width) // 2
    y = top + (avail_h - height) // 2
    return {
        "windowSize": [width, height],
        "physicalSize": [width, height],
        "workArea": list(work_area),
        "rect": [x, y, width, height],
    }


# ---------------------------------------------------------------------------
# 可注入的输入 / 剪贴板 / 截图
# ---------------------------------------------------------------------------


class InputController(abc.ABC):
    """鼠标输入抽象（不提供任何键盘注入接口）。"""

    @property
    @abc.abstractmethod
    def available(self) -> bool: ...

    @abc.abstractmethod
    def focus_window(self, hwnd: int, *, minimized: bool = False) -> None: ...

    @abc.abstractmethod
    def move(self, x: int, y: int) -> None: ...

    @abc.abstractmethod
    def click(self, x: int, y: int) -> None: ...

    @abc.abstractmethod
    def right_click(self, x: int, y: int) -> None: ...

    @abc.abstractmethod
    def long_press(self, x: int, y: int, duration_ms: int) -> None: ...

    def normalize_window(self, hwnd: int, logical_width: int, logical_height: int) -> dict:
        raise ExecutorError("DESKTOP_UNSUPPORTED", "当前输入控制器不支持统一微信窗口尺寸")


class _MonitorInfo(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.DWORD), ("rcMonitor", wintypes.RECT),
                ("rcWork", wintypes.RECT), ("dwFlags", wintypes.DWORD)]


class Win32InputController(InputController):
    """ctypes 实现的鼠标输入（SetForegroundWindow/ShowWindow/SetWindowPos/鼠标事件）。"""

    _SW_RESTORE = 9
    _SW_SHOW = 5
    _HWND_TOP = 0
    _SWP_NOSIZE = 0x0001
    _SWP_NOMOVE = 0x0002
    _SWP_SHOWWINDOW = 0x0040
    _MOUSEEVENTF_LEFTDOWN = 0x0002
    _MOUSEEVENTF_LEFTUP = 0x0004
    _MOUSEEVENTF_RIGHTDOWN = 0x0008
    _MOUSEEVENTF_RIGHTUP = 0x0010

    def __init__(self, *, sleep_fn: Callable[[float], None] = time.sleep) -> None:
        self._sleep = sleep_fn
        self._user32 = None
        if os.name == "nt":
            try:
                self._user32 = ctypes.WinDLL("user32", use_last_error=True)
                self._user32.SetCursorPos.argtypes = [ctypes.c_int, ctypes.c_int]
                self._user32.SetCursorPos.restype = ctypes.c_bool
                self._user32.mouse_event.argtypes = [
                    ctypes.c_ulong,
                    ctypes.c_long,
                    ctypes.c_long,
                    ctypes.c_ulong,
                    ctypes.c_void_p,
                ]
                self._user32.SetForegroundWindow.argtypes = [ctypes.c_void_p]
                self._user32.SetForegroundWindow.restype = ctypes.c_bool
                self._user32.ShowWindow.argtypes = [ctypes.c_void_p, ctypes.c_int]
                self._user32.ShowWindow.restype = ctypes.c_bool
                self._user32.SetWindowPos.argtypes = [
                    ctypes.c_void_p,
                    ctypes.c_void_p,
                    ctypes.c_int,
                    ctypes.c_int,
                    ctypes.c_int,
                    ctypes.c_int,
                    ctypes.c_uint,
                ]
                self._user32.SetWindowPos.restype = ctypes.c_bool
                self._user32.MonitorFromWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
                self._user32.MonitorFromWindow.restype = ctypes.c_void_p
                self._user32.GetMonitorInfoW.argtypes = [ctypes.c_void_p, ctypes.POINTER(_MonitorInfo)]
                self._user32.GetMonitorInfoW.restype = ctypes.c_bool
                self._user32.GetDpiForWindow.argtypes = [ctypes.c_void_p]
                self._user32.GetDpiForWindow.restype = ctypes.c_uint
            except OSError:  # pragma: no cover - 极端环境
                self._user32 = None

    @property
    def available(self) -> bool:
        return self._user32 is not None

    def _require(self) -> Any:
        if self._user32 is None:
            raise ExecutorError("DESKTOP_UNSUPPORTED", "非 Windows 平台或 user32 不可用，无法执行鼠标输入")
        return self._user32

    def normalize_window(self, hwnd: int, logical_width: int, logical_height: int) -> dict:
        """把主窗口调整为已知 profile 的物理像素尺寸（DPI 只记录，不缩放）。"""
        user32 = self._require()
        user32.ShowWindow(hwnd, self._SW_RESTORE)
        monitor = user32.MonitorFromWindow(hwnd, 2)
        info = _MonitorInfo(); info.cbSize = ctypes.sizeof(info)
        if not monitor or not user32.GetMonitorInfoW(monitor, ctypes.byref(info)):
            raise ExecutorError("WINDOW_BLOCKED", "无法读取微信所在显示器的可用区域，未调整窗口")
        dpi = int(user32.GetDpiForWindow(hwnd)) if hasattr(user32, "GetDpiForWindow") else 0
        plan = normalization_plan(
            (info.rcWork.left, info.rcWork.top, info.rcWork.right, info.rcWork.bottom),
            logical_width,
            logical_height,
        )
        plan["dpi"] = dpi
        plan["dpiScale"] = round(dpi / 96.0, 3) if dpi else 1.0
        if not user32.SetWindowPos(hwnd, None, *plan["rect"], 0x0004 | 0x0010 | self._SWP_SHOWWINDOW):
            raise ExecutorError("WINDOW_BLOCKED", "微信拒绝调整窗口尺寸，已停止后续操作")
        return plan

    def focus_window(self, hwnd: int, *, minimized: bool = False) -> None:
        user32 = self._require()
        try:
            if minimized:
                user32.ShowWindow(hwnd, self._SW_RESTORE)
            else:
                user32.ShowWindow(hwnd, self._SW_SHOW)
            user32.SetForegroundWindow(hwnd)
            user32.SetWindowPos(
                hwnd,
                self._HWND_TOP,
                0,
                0,
                0,
                0,
                self._SWP_NOMOVE | self._SWP_NOSIZE | self._SWP_SHOWWINDOW,
            )
        except OSError as exc:
            raise ExecutorError("WINDOW_BLOCKED", "无法把微信窗口置前，已停止操作") from exc
        # SetForegroundWindow 可能被前台锁拒绝：用 AttachThreadInput 再试一次并验证。
        if not self._is_foreground(hwnd):
            self._attach_thread_input_foreground(hwnd)
        if not self._is_foreground(hwnd):
            raise ExecutorError(
                "WINDOW_BLOCKED",
                "微信窗口未能切到前台（可能被系统前台锁或其他窗口占用），已停止操作；未点击发表",
            )

    @staticmethod
    def _is_foreground(hwnd: int) -> bool:
        handle = foreground_window()
        return bool(handle) and int(handle) == int(hwnd)

    def _attach_thread_input_foreground(self, hwnd: int) -> None:
        user32 = self._require()
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        foreground = foreground_window()
        if not foreground:
            return
        try:
            foreground_thread = user32.GetWindowThreadProcessId(ctypes.c_void_p(int(foreground)), None)
            current_thread = kernel32.GetCurrentThreadId()
            user32.AttachThreadInput(current_thread, foreground_thread, True)
            try:
                user32.BringWindowToTop(ctypes.c_void_p(int(hwnd)))
                user32.SetForegroundWindow(ctypes.c_void_p(int(hwnd)))
                user32.SetActiveWindow(ctypes.c_void_p(int(hwnd)))
            finally:
                user32.AttachThreadInput(current_thread, foreground_thread, False)
        except OSError:  # pragma: no cover - 尽力而为，由调用方验证结果
            return

    def move(self, x: int, y: int) -> None:
        user32 = self._require()
        if not user32.SetCursorPos(int(x), int(y)):
            raise ExecutorError("WINDOW_BLOCKED", "鼠标移动失败（可能被 UAC/安全桌面拦截）")

    def _button(self, down_flag: int, up_flag: int) -> None:
        user32 = self._require()
        user32.mouse_event(down_flag, 0, 0, 0, None)
        user32.mouse_event(up_flag, 0, 0, 0, None)

    def click(self, x: int, y: int) -> None:
        self.move(x, y)
        self._button(self._MOUSEEVENTF_LEFTDOWN, self._MOUSEEVENTF_LEFTUP)

    def right_click(self, x: int, y: int) -> None:
        self.move(x, y)
        self._button(self._MOUSEEVENTF_RIGHTDOWN, self._MOUSEEVENTF_RIGHTUP)

    def long_press(self, x: int, y: int, duration_ms: int) -> None:
        if duration_ms < 900:
            raise ExecutorError("BAD_REQUEST", "长按时间不得少于 900ms（单击会打开图片模式）")
        self.move(x, y)
        user32 = self._require()
        user32.mouse_event(self._MOUSEEVENTF_LEFTDOWN, 0, 0, 0, None)
        try:
            self._sleep(duration_ms / 1000.0)
        finally:
            user32.mouse_event(self._MOUSEEVENTF_LEFTUP, 0, 0, 0, None)


class ClipboardController(abc.ABC):
    """剪贴板抽象（只用于纯文字粘贴）。"""

    @abc.abstractmethod
    def set_text(self, text: str) -> bool: ...

    @abc.abstractmethod
    def clear(self) -> None: ...


class Win32Clipboard(ClipboardController):
    """ctypes 剪贴板实现；复用 wechat_driver 中的 CF_UNICODETEXT 逻辑。"""

    def set_text(self, text: str) -> bool:
        from .wechat_driver import _set_clipboard_text

        return bool(_set_clipboard_text(text))

    def clear(self) -> None:
        from .wechat_driver import _clear_clipboard

        _clear_clipboard()


def is_admin() -> bool:
    """当前进程是否具备管理员权限（Windows）。"""
    if os.name != "nt":
        return False
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


# ---------------------------------------------------------------------------
# 结果模型
# ---------------------------------------------------------------------------


@dataclass
class DeleteOutcome:
    """删除已发布朋友圈的结果。"""

    deleted: bool = False
    uncertain: bool = False
    error_code: str | None = None
    message: str = ""
    evidence_path: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.deleted and not self.uncertain,
            "deleted": self.deleted,
            "uncertain": self.uncertain,
            "screenshotPath": self.evidence_path,
            "errorCode": self.error_code,
            "message": self.message,
        }


class _CapturedOcr:
    """一次窗口截图 + OCR 结果，附带截图尺寸用于坐标换算。"""

    __slots__ = ("result", "width", "height")

    def __init__(self, result: OcrResult, width: int, height: int) -> None:
        self.result = result
        self.width = width
        self.height = height


# ---------------------------------------------------------------------------
# 几何驱动
# ---------------------------------------------------------------------------


class GeometryWechatDriver(WechatDriver):
    """微信 4.x 几何/像素驱动（opt-in，需要管理员权限 + 显式发布授权）。"""

    def __init__(
        self,
        config: ExecutorConfig,
        *,
        locator: WindowLocator | None = None,
        ocr: OcrProvider | None = None,
        input_controller: InputController | None = None,
        clipboard: ClipboardController | None = None,
        capture_rgb: Callable[[], tuple[int, int, list[bytes]]] | None = None,
        capture_png: Callable[[str], str] | None = None,
        admin_check: Callable[[], bool] | None = None,
        sleep_fn: Callable[[float], None] = time.sleep,
        logger: logging.Logger | None = None,
    ) -> None:
        self._config = config
        self._locator = locator or WindowLocator()
        self._logger = logger or _LOGGER
        self._sleep_fn = sleep_fn
        # 几何点位的坐标是物理像素：必须在任何窗口/鼠标调用前完成 DPI 感知。
        self._dpi_awareness = ensure_dpi_aware()
        if self._dpi_awareness not in ("per-monitor-v2", "per-monitor", "system-aware"):
            self._logger.warning("进程 DPI 感知未生效（%s），鼠标/窗口坐标可能被系统缩放", self._dpi_awareness)
        self._ocr = ocr if ocr is not None else create_ocr_provider(
            ocr_python=getattr(config, "ocr_python", None),
            timeout=float(getattr(config, "geometry_ocr_timeout", 20.0)),
            logger=self._logger,
        )
        self._input = input_controller or Win32InputController(sleep_fn=sleep_fn)
        self._clipboard = clipboard or Win32Clipboard()
        self._capture_rgb_fn = capture_rgb
        self._capture_png_fn = capture_png
        self._admin_check = admin_check or is_admin

        self._window: WindowInfo | None = None
        self._geometry: WeChat4Geometry | None = None
        self._editor_open = False
        self._editor_text = ""
        self._last_visible_text = ""
        self._paste_point: tuple[int, int] | None = None
        self._submitted = False
        self._cancel_requested = False
        self._admin_cached: bool | None = None
        self._ocr_available_cached: bool | None = None
        self._temp_counter = 0
        self._normalization = None
        self._screenshot_dir = normalize_path(config.screenshot_dir)

    # -- 驱动能力标识 -----------------------------------------------------

    @property
    def uia_available(self) -> bool:
        # 几何驱动不依赖 UIA；health 仍会如实显示 UIA 库探测结果（Real 驱动）。
        return False

    @property
    def driver_kind(self) -> str:
        return "geometry"

    @property
    def requires_uia(self) -> bool:
        return False

    @property
    def supports_delete(self) -> bool:
        return True

    @property
    def ocr_available(self) -> bool:
        if self._ocr_available_cached is None:
            try:
                self._ocr_available_cached = bool(self._ocr.available)
            except Exception:
                self._ocr_available_cached = False
        return bool(self._ocr_available_cached)

    @property
    def admin_privilege(self) -> bool:
        if self._admin_cached is None:
            try:
                self._admin_cached = bool(self._admin_check())
            except Exception:
                self._admin_cached = False
        return bool(self._admin_cached)

    # -- 安装 / 状态 ------------------------------------------------------

    def get_installation(self) -> WechatInstallation:
        return self._locator.detect_installation(self._config.wechat_exe_names)

    def _wechat_processes(self) -> list[Any]:
        exe_lower = {name.lower() for name in self._config.wechat_exe_names}
        return [process for process in self._locator.list_processes() if process.name.lower() in exe_lower]

    def get_status(self, timeout: float | None = None) -> WechatStatus:
        installation = self.get_installation()
        interactive, locked, notes = self._locator.is_interactive_desktop()
        notes = list(notes)
        window: WindowInfo | None = None
        login_window: WindowInfo | None = None
        if installation.installed:
            window = self._locator.find_main_window(
                self._config.wechat_exe_names,
                self._config.wechat_window_titles,
                self._config.wechat_window_classes,
            )
            login_window = self._locator.find_login_window(self._config.wechat_exe_names)
        processes = self._wechat_processes() if installation.installed else []
        running = bool(processes) or window is not None or login_window is not None
        logged_in = window is not None
        if not installation.installed:
            notes.append("未找到微信客户端（WeChat.exe / Weixin.exe）")
        if running and window is None:
            notes.append("未找到微信主窗口（可能未登录或最小化到托盘）")
        elif not running:
            notes.append("微信客户端未运行")
        version = installation.version if installation.installed else None
        assumed_version = getattr(self._config, "assumed_client_version", None)
        if assumed_version:
            version = assumed_version
            notes.append(f"使用已配置的假定客户端版本 {assumed_version}（已人工确认）")
        supported = bool(
            installation.installed
            and version is not None
            and version in tuple(self._config.supported_versions)
        )
        if installation.installed and version and version not in tuple(self._config.supported_versions):
            notes.append(
                f"客户端版本 {version} 未在 geometry 已验证列表 {list(self._config.supported_versions)} 内，supported=false"
            )
        notes.append("geometry 模式：窗口几何 + 像素/OCR，不是 UIA 控件树（opt-in）")
        notes.append(f"进程 DPI 感知：{self._dpi_awareness}（物理像素坐标）")
        if self.ocr_available:
            notes.append("OCR 可用（DSH Python 3.12 + winsdk）")
        else:
            reason = getattr(self._ocr, "unavailable_reason", "")
            notes.append(f"OCR 不可用：{reason or '未找到 DSH Python/winsdk'}")
        target_elevated = self._wechat_target_elevated()
        if self.admin_privilege:
            notes.append("已具备管理员权限，可执行鼠标输入")
        elif getattr(self._config, "geometry_require_admin", False):
            notes.append("未以管理员身份运行且配置要求管理员：prepare/publish/delete 返回 PRIVILEGE_REQUIRED")
        elif target_elevated is False:
            notes.append("微信进程未提权：使用同完整性输入（非管理员）执行；不会降级为盲点")
        else:
            notes.append(
                "未以管理员身份运行且无法确认微信进程未提权：prepare/publish/delete 返回 PRIVILEGE_REQUIRED"
            )
        if getattr(self._config, "trusted_account_source", "uia") != "wechatagent":
            notes.append(
                "geometry 无法从 UIA 读取 wxid；请配置 --trusted-account-source wechatagent "
                "与 --expected-account，否则账号校验会拒绝执行"
            )
        return WechatStatus(
            running=running,
            logged_in=logged_in,
            account_id=None,  # 几何驱动绝不猜测 wxid
            version=version,
            interactive=interactive,
            locked=locked,
            supported=supported,
            window_title=window.title if window is not None else None,
            dpi_scale=window.dpi_scale if window is not None else None,
            notes=notes[:32],
        )

    # -- 取消 -------------------------------------------------------------

    def cancel(self) -> None:
        self._cancel_requested = True

    def _check_cancel(self) -> None:
        if self._cancel_requested:
            raise ExecutorError("CANCELLED", "操作已取消，未点击发表")

    # -- 就绪检查 ---------------------------------------------------------

    def _wechat_process_ids(self) -> list[int]:
        return [int(process.pid) for process in self._wechat_processes()]

    def _wechat_target_elevated(self) -> bool | None:
        """微信进程是否提权。None = 无法确认（调用方按需拒绝）。"""
        pids = self._wechat_process_ids()
        if not pids:
            return None
        elevated = [process_is_elevated(pid) for pid in pids]
        if any(value is None for value in elevated):
            return None
        return any(bool(value) for value in elevated)

    def _admin_gate_error(self, *, require_admin: bool) -> str | None:
        """返回需要拒绝的原因；None 表示可以继续执行鼠标输入。"""
        if not require_admin or self.admin_privilege:
            return None
        if getattr(self._config, "geometry_require_admin", False):
            return "几何驱动配置为必须管理员运行；请以管理员身份启动执行器（不会降级为盲点）"
        target_elevated = self._wechat_target_elevated()
        if target_elevated is False:
            return None
        state = "无法确认（权限不足或进程已退出）" if target_elevated is None else "已提权"
        return (
            f"微信进程{state}，非管理员进程无法安全执行鼠标输入（UIPI 限制）；"
            "请以管理员身份启动执行器，或确认微信未提权后重试"
        )

    def _require_geometry_ready(self, *, require_admin: bool = True) -> WechatStatus:
        self._check_cancel()
        if not self._input.available:
            raise ExecutorError("DESKTOP_UNSUPPORTED", "鼠标输入控制器不可用（非 Windows 平台）")
        status = self.get_status()
        if not status.interactive or status.locked:
            reason = "锁屏" if status.locked else "没有可交互桌面（RDP 断开或服务会话）"
            raise ExecutorError("INTERACTIVE_DESKTOP_UNAVAILABLE", f"当前{reason}，已停止操作")
        if not status.running:
            raise ExecutorError("WECHAT_NOT_RUNNING", "微信客户端未运行，请人工启动微信后重试")
        if not status.logged_in:
            raise ExecutorError("WECHAT_NOT_LOGGED_IN", "微信未登录或未找到主窗口，请人工登录后重试")
        if not status.supported:
            raise ExecutorError(
                "CLIENT_VERSION_UNSUPPORTED",
                f"客户端版本 {status.version or '未知'} 未在 geometry 已验证列表 "
                f"{list(self._config.supported_versions)} 内，已停止操作",
            )
        admin_error = self._admin_gate_error(require_admin=require_admin)
        if admin_error is not None:
            raise ExecutorError("PRIVILEGE_REQUIRED", admin_error)
        window = self._locator.find_main_window(
            self._config.wechat_exe_names,
            self._config.wechat_window_titles,
            self._config.wechat_window_classes,
        )
        if window is None or window.rect is None:
            raise ExecutorError("WINDOW_NOT_FOUND", "未找到微信主窗口或无法读取窗口矩形，已停止操作")
        self._window = window
        self._set_geometry(window)
        return status

    def _focus_window(self) -> None:
        if self._window is None:
            raise ExecutorError("WINDOW_NOT_FOUND", "微信窗口未定位，已停止操作")
        self._input.focus_window(self._window.hwnd, minimized=bool(self._window.minimized))
        self._sleep(0.2)
        self._refresh_window_geometry()

    def _refresh_window_geometry(self) -> None:
        window = self._locator.find_main_window(self._config.wechat_exe_names,
            self._config.wechat_window_titles, self._config.wechat_window_classes)
        if window is None or window.rect is None:
            raise ExecutorError("WINDOW_NOT_FOUND", "当前微信窗口已变化，请重新识别")
        self._window = window
        self._set_geometry(window)

    def _set_geometry(self, window):
        left,top,right,bottom = window.rect
        width, height = right-left, bottom-top
        # profile 坐标是物理像素：尺寸精确匹配已知 profile 时按 1:1 映射。
        profile = next(
            (size for size in _PROFILE_SIZES if abs(width - size[0]) <= 1 and abs(height - size[1]) <= 1),
            None,
        )
        if profile is None:
            self._logger.warning(
                "微信窗口 %sx%s 不匹配任何已验证 profile %s；使用最近 profile 比例缩放（点击前仍做像素复核）",
                width,
                height,
                list(_PROFILE_SIZES),
            )
        self._geometry = WeChat4Geometry(WindowRect(left, top, width, height), profile=profile)

    def _normalize_window(self):
        if not self._config.geometry_normalize_window:
            self._normalization = None
            return
        self._normalization = None
        if self._window is None:
            raise ExecutorError("WINDOW_NOT_FOUND", "微信窗口未定位，已停止操作")
        plan = self._input.normalize_window(self._window.hwnd, *_STANDARD_WINDOW_SIZE)
        self._sleep(.3)
        expected = plan['physicalSize']
        matches = 0
        actual = [0, 0]
        for _ in range(8):
            self._refresh_window_geometry()
            actual = [self._window.width, self._window.height]
            if all(abs(a-b) <= 1 for a, b in zip(actual, expected)):
                matches += 1
                if matches >= 2:
                    break
            else:
                matches = 0
            self._sleep(.1)
        if matches < 2:
            raise ExecutorError(
                "WINDOW_BLOCKED",
                f"窗口尺寸调整未生效：期望 {expected} 物理像素，实际 {actual}；已停止操作",
            )
        l,t,r,b = self._window.rect
        wl,wt,wr,wb = plan['workArea']
        if l < wl or t < wt or r > wr or b > wb:
            raise ExecutorError("WINDOW_BLOCKED", "调整后的微信窗口超出显示器可用区域，已停止操作")
        self._normalization = {**plan, 'actualRect': list(self._window.rect), 'verified': True}
        self._logger.info(
            "微信窗口已统一为物理像素：%sx%s（dpi=%s，进程 DPI 感知=%s）",
            actual[0],
            actual[1],
            plan.get('dpiScale'),
            self._dpi_awareness,
        )

    def _assert_normalized_session(self):
        if self._normalization is not None and list(self._window.rect) != self._normalization['actualRect']:
            raise ExecutorError("WINDOW_BLOCKED", "准备后的微信窗口位置或尺寸已变化，请重新准备；未继续输入或发表")

    def _assert_window_unchanged(self, rect, hwnd) -> None:
        self._refresh_window_geometry()
        if self._window.rect != rect or self._window.hwnd != hwnd:
            raise ExecutorError("WINDOW_BLOCKED", "识别期间微信窗口位置或大小改变，已停止点击，请重新准备")

    def _assert_foreground(self) -> None:
        """屏幕捕获前确认前台输入焦点属于微信进程（编辑器/菜单是独立顶层窗口）。"""
        if self._capture_rgb_fn is not None:
            # 单元测试注入的截图源不代表真实屏幕，不做前台校验。
            return
        if self._window is None:
            raise ExecutorError("WINDOW_NOT_FOUND", "微信窗口未定位，已停止操作")
        handle = foreground_window()
        if handle and window_process_id(handle) == int(self._window.process_id):
            return
        raise ExecutorError(
            "WINDOW_BLOCKED",
            "微信窗口不在前台（用户可能切换了窗口），已停止屏幕捕获与后续输入；未点击发表",
        )

    def inspect_controls(self) -> dict:
        """Capture current window only; never focus, type, navigate or click."""
        self._require_geometry_ready(require_admin=False)
        rect, hwnd = self._window.rect, self._window.hwnd
        width, height, rows = self._capture_rgb()
        captured = self._ocr_for_frame(width, height, rows)
        targets = locate_controls(captured, width, height, rows)
        self._assert_window_unchanged(rect,hwnd)
        for target in targets.values():
            target["screenX"], target["screenY"] = self._bitmap_to_screen(target["x"], target["y"], width, height)
        return {"supported": True, "windowSize": [self._geometry.window.width, self._geometry.window.height],
            "normalizationEnabled":self._config.geometry_normalize_window,"standardWindowSize":list(_STANDARD_WINDOW_SIZE),
            "windowNormalizeMode": "physical-pixels",
            "lastNormalization":self._normalization,
            "bitmapSize": [width, height], "dpiScale": self._window.dpi_scale,
            "processDpiAwareness": self._dpi_awareness, "targets": targets,
            "missing": [name for name in ("discover", "moments_entry", "camera", "publish", "cancel", "paste") if name not in targets],
            "message": "只识别主窗口可见控件；朋友圈编辑器/右键菜单是独立窗口，需前景屏幕捕获，不在本只读诊断范围内。"}

    def _click_named(self, name: str) -> None:
        """点击几何 profile 中的命名点位（窗口内坐标 -> 屏幕坐标）。"""
        if self._geometry is None:
            raise ExecutorError("WINDOW_NOT_FOUND", "微信窗口未定位，已停止操作")
        if name in ("discover", "moments_entry") and not self._verified_layout():
            width, height, rows = self._capture_rgb()
            rect, hwnd = self._window.rect, self._window.hwnd
            targets = locate_controls(self._ocr_for_frame(width,height,rows),width,height,rows)
            if name in targets:
                target = targets[name]
                self._assert_window_unchanged(rect,hwnd)
                self._input.click(*self._bitmap_to_screen(target["x"],target["y"],width,height))
                return
            raise ExecutorError("WINDOW_NOT_FOUND", "当前尺寸未识别到唯一导航按钮，已停止猜测位置")
        point = self._geometry.screen_point(name)
        self._input.click(point.x, point.y)

    def _verified_layout(self) -> bool:
        """窗口物理像素尺寸是否精确匹配已知 profile（profile 坐标即物理像素）。"""
        return any(
            abs(self._window.width - size[0]) <= 1 and abs(self._window.height - size[1]) <= 1
            for size in _PROFILE_SIZES
        )

    def _camera_screen_point(self):
        if self._verified_layout():
            point = self._geometry.screen_point("camera")
            return point.x, point.y
        rect, hwnd = self._window.rect, self._window.hwnd
        width,height,rows = self._capture_rgb()
        target = locate_controls(self._ocr_for_frame(width,height,rows),width,height,rows).get("camera")
        if target is None:
            raise ExecutorError("WINDOW_NOT_FOUND", "当前窗口未识别相机入口；无文字图标需验证布局，不使用比例猜测")
        self._assert_window_unchanged(rect,hwnd)
        return self._bitmap_to_screen(target["x"],target["y"],width,height)

    def _sleep(self, seconds: float) -> None:
        self._check_cancel()
        if seconds > 0:
            self._sleep_fn(seconds)

    # -- 截图 / OCR -------------------------------------------------------

    def _capture_rgb(self) -> tuple[int, int, list[bytes]]:
        """PrintWindow 截取主窗口自身绘制的内容（导航页/朋友圈信息流）。"""
        if self._capture_rgb_fn is not None:
            width, height, rows = self._capture_rgb_fn()
        else:
            if self._window is None:
                raise ExecutorError("WINDOW_NOT_FOUND", "微信窗口未定位，无法截图")
            width, height, rows = self._locator.capture_window_rgb(
                self._window.hwnd, timeout=self._config.screenshot_timeout
            )
        if width <= 0 or height <= 0:
            raise ExecutorError("WINDOW_BLOCKED", "截图尺寸为 0，无法继续")
        return width, height, rows

    def _capture_screen_rgb(self) -> tuple[int, int, list[bytes]]:
        """屏幕捕获窗口矩形（含朋友圈编辑器、右键菜单等独立顶层窗口）。

        必须先确认前台窗口属于微信进程；否则弹窗/编辑器可能不在捕获结果里，
        继续点击会变成“盲点”，因此直接失败。
        """
        if self._capture_rgb_fn is not None:
            width, height, rows = self._capture_rgb_fn()
        else:
            if self._window is None:
                raise ExecutorError("WINDOW_NOT_FOUND", "微信窗口未定位，无法屏幕捕获")
            self._assert_foreground()
            width, height, rows = self._locator.capture_screen_rgb(
                self._window, timeout=self._config.screenshot_timeout
            )
        if width <= 0 or height <= 0:
            raise ExecutorError("WINDOW_BLOCKED", "屏幕捕获尺寸为 0，无法继续")
        return width, height, rows

    def _capture_png(self, dest_path: str, *, screen: bool = False) -> str:
        """保存截图；``screen=True`` 时保存屏幕捕获（包含编辑器/菜单）。"""
        # 相对文件名按截图目录解析，仍走路径边界校验；绝对路径必须位于截图目录内。
        if not os.path.isabs(dest_path):
            dest_path = os.path.join(self._screenshot_dir, safe_filename_component(os.path.basename(dest_path)))
        target = resolve_under((self._screenshot_dir,), dest_path)
        if self._capture_png_fn is not None:
            saved = self._capture_png_fn(target)
            return normalize_path(saved or target)
        if self._window is None:
            raise ExecutorError("WINDOW_NOT_FOUND", "微信窗口未定位，无法截图")
        if screen:
            self._assert_foreground()
            return self._locator.capture_screen_png(
                self._window, target, timeout=self._config.screenshot_timeout
            )
        return self._locator.capture_window_png(
            self._window.hwnd, target, timeout=self._config.screenshot_timeout
        )

    def _write_ocr_image(self, width: int, height: int, rows: Iterable[bytes]) -> str:
        """把本次截图写到 screenshot_dir 下的临时 PNG，供 OCR helper 读取。"""
        ensure_directory_under((self._screenshot_dir,), self._screenshot_dir)
        self._temp_counter += 1
        filename = f"_ocr-{os.getpid()}-{self._temp_counter}.png"
        target = resolve_under((self._screenshot_dir,), os.path.join(self._screenshot_dir, filename))
        try:
            with open(target, "wb") as handle:
                handle.write(encode_png_rgb(width, height, rows))
        except OSError as exc:
            raise ExecutorError("INTERNAL_ERROR", f"写入 OCR 临时截图失败：{exc}") from exc
        return target

    def _capture_ocr(self, tag: str, *, screen: bool = True) -> _CapturedOcr:
        """OCR 当前界面；默认使用屏幕捕获，以包含独立弹出的编辑器/菜单。"""
        self._check_cancel()
        if not self.ocr_available:
            reason = getattr(self._ocr, "unavailable_reason", "")
            raise ExecutorError("OCR_UNAVAILABLE", f"OCR 不可用，无法确认界面内容：{reason or '未找到 DSH Python/winsdk'}")
        width, height, rows = self._capture_screen_rgb() if screen else self._capture_rgb()
        return _CapturedOcr(self._ocr_for_frame(width,height,rows),width,height)

    def _ocr_for_frame(self, width, height, rows):
        if not self.ocr_available:
            raise ExecutorError("OCR_UNAVAILABLE", "OCR 不可用，不能识别当前窗口按钮")
        path = self._write_ocr_image(width, height, rows)
        try:
            result = self._ocr.recognize(path)
        finally:
            try:
                os.remove(path)
            except OSError:
                pass
        if not result.available:
            code = result.error_code if result.error_code in ("OCR_UNAVAILABLE", "OCR_TIMEOUT") else "OCR_UNAVAILABLE"
            raise ExecutorError(code, result.message or "OCR 识别失败，无法确认界面内容")
        return result

    # -- 坐标换算 ---------------------------------------------------------

    def _bitmap_to_screen(self, x: int, y: int, bitmap_width: int, bitmap_height: int) -> tuple[int, int]:
        if self._window is None or self._window.rect is None:
            raise ExecutorError("WINDOW_NOT_FOUND", "微信窗口未定位，无法换算坐标")
        left, top, right, bottom = self._window.rect
        width = max(1, right - left)
        height = max(1, bottom - top)
        return (
            int(left + x * width / max(1, bitmap_width)),
            int(top + y * height / max(1, bitmap_height)),
        )

    def _line_screen_point(self, bbox: OcrBBox, captured: _CapturedOcr) -> tuple[int, int]:
        x, y = bbox.center
        return self._bitmap_to_screen(x, y, captured.width, captured.height)

    # -- 打开编辑器 -------------------------------------------------------

    def _geometry_publish_allowed(self) -> bool:
        """几何发布/删除权限：必须同时满足通用发布权限与几何显式授权。

        显式读取 ``effective_allow_publish``，确保几何驱动不会以任何方式绕过
        ``--allow-publish + APPROVAL_REQUIRED`` 的全局门禁。
        """
        general = bool(getattr(self._config, "effective_allow_publish", False))
        geometry = bool(getattr(self._config, "geometry_allow_publish", False))
        return general and geometry

    @staticmethod
    def _editor_visible(result: OcrResult) -> bool:
        text = normalize_ocr_text(result.text or "")
        return any(normalize_ocr_token in text for normalize_ocr_token in (
            normalize_ocr_text(token) for token in _EDITOR_HINT_TOKENS
        ))

    def open_moments_editor(self, timeout: float | None = None) -> None:
        """导航「发现→朋友圈」并长按相机，打开纯文字编辑器；不点击发表。"""
        self._require_geometry_ready()
        # 新一轮编辑会话：允许同一执行器进程在后续 attempt 再次点击发表，
        # 同时清除上一次取消请求；真正的发布权限仍由 server/审批门禁校验。
        self._submitted = False
        self._editor_text = ""
        self._editor_open = False
        self._cancel_requested = False
        attempts = int(getattr(self._config, "max_prepare_attempts", 3))
        last_error: ExecutorError | None = None
        for attempt in range(1, attempts + 1):
            self._check_cancel()
            try:
                self._focus_window()
                self._normalize_window()
                assert self._geometry is not None
                self._click_named("discover")
                self._sleep(_NAV_WAIT)
                self._click_named("moments_entry")
                self._sleep(_MOMENTS_WAIT)
                camera_x, camera_y = self._camera_screen_point()
                self._input.long_press(
                    camera_x,
                    camera_y,
                    int(getattr(self._config, "geometry_long_press_ms", 900)),
                )
                self._sleep(_EDITOR_WAIT)
                try:
                    self._open_paste_menu()
                except ExecutorError as exc:
                    # 冷启动时首次导航可能落在非朋友圈页（或编辑器未及时渲染）：
                    # 在同一 attempt 内重新导航+长按一次，避免立刻消耗一整轮重试。
                    if exc.code != "WINDOW_NOT_FOUND" or "编辑器" not in exc.message:
                        raise
                    self._logger.warning(
                        "首次屏幕 OCR 未看到编辑器（attempt=%s），重新导航并长按一次", attempt
                    )
                    self._click_named("discover")
                    self._sleep(_NAV_WAIT)
                    self._click_named("moments_entry")
                    self._sleep(_MOMENTS_WAIT)
                    camera_x, camera_y = self._camera_screen_point()
                    self._input.long_press(
                        camera_x,
                        camera_y,
                        int(getattr(self._config, "geometry_long_press_ms", 900)),
                    )
                    self._sleep(_EDITOR_WAIT)
                    self._open_paste_menu()
                self._editor_open = True
                self._logger.info("几何驱动已打开朋友圈纯文字编辑器（attempt=%s）", attempt)
                return
            except ExecutorError as exc:
                last_error = exc
                self._editor_open = False
                if exc.code not in _RETRYABLE_PREPARE_CODES or attempt >= attempts:
                    raise
                self._logger.warning(
                    "打开编辑器失败 attempt=%s code=%s message=%s，准备重试", attempt, exc.code, exc.message
                )
                self._sleep(float(getattr(self._config, "retry_backoff_seconds", 2.0)))
        if last_error is not None:
            raise last_error
        raise ExecutorError("WINDOW_NOT_FOUND", "无法打开朋友圈编辑器，已停止操作")

    def _find_paste_point(self) -> tuple[int, int] | None:
        """右键文本区并返回「粘贴」菜单项屏幕坐标；找不到返回 None。

        屏幕捕获会同时包含独立弹出的右键菜单和编辑器窗口，因此一次 OCR 就能
        同时确认“编辑器已打开”和“菜单项位置”。
        """
        captured = self._capture_ocr("paste-menu", screen=True)
        if not self._editor_visible(captured.result):
            raise ExecutorError(
                "WINDOW_NOT_FOUND",
                "右键后未在屏幕中检测到朋友圈文字编辑器（OCR 无编辑器特征），已停止操作（未点击发表）",
            )
        boxes = locate_token(captured.result, "粘贴")
        if len(boxes) == 1:
            self._logger.info("通过屏幕 OCR 定位到“粘贴”菜单项")
            return self._line_screen_point(boxes[0], captured)
        if len(boxes) > 1:
            raise ExecutorError("WINDOW_NOT_FOUND", "识别到多个“粘贴”菜单项，停止操作")
        return None

    def _open_paste_menu(self) -> None:
        """右键文本区，屏幕 OCR 找「粘贴」；优先 OCR 定位，最后才用安全 fallback。"""
        if self._geometry is None:
            raise ExecutorError("WINDOW_NOT_FOUND", "微信窗口未定位，已停止操作")
        self._assert_foreground()
        text_screen = self._geometry.screen_point("editor_text")
        if not self._verified_layout():
            rect, hwnd = self._window.rect, self._window.hwnd
            width, height, rows = self._capture_screen_rgb()
            target = locate_controls(self._ocr_for_frame(width, height, rows), width, height, rows).get("editor_text")
            if target is None:
                raise ExecutorError("WINDOW_NOT_FOUND", "未识别到编辑框提示文字，不使用缩放坐标猜测")
            self._assert_window_unchanged(rect, hwnd)
            from .wechat4_geometry import Point
            text_screen = Point(*self._bitmap_to_screen(target["x"], target["y"], width, height))

        paste_point: tuple[int, int] | None = None
        for menu_attempt in range(1, 3):
            self._assert_foreground()
            self._input.right_click(text_screen.x, text_screen.y)
            self._sleep(_MENU_WAIT)
            paste_point = self._find_paste_point()
            if paste_point is not None:
                self._paste_point = paste_point
                return
            self._logger.warning("屏幕 OCR 未找到“粘贴”菜单项（attempt=%s）", menu_attempt)
            # 点击文本区关闭可能残留的菜单，然后重试一次右键。
            self._input.click(text_screen.x, text_screen.y)
            self._sleep(0.3)

        if not self._verified_layout():
            raise ExecutorError("WINDOW_NOT_FOUND", "未识别到唯一粘贴菜单项，停止操作")
        offset = getattr(self._config, "geometry_paste_fallback_offset", (40, 34))
        self._paste_point = (text_screen.x + int(offset[0]), text_screen.y + int(offset[1]))
        self._logger.warning("OCR 未找到“粘贴”，使用实测 fallback 偏移 %s（仍需读回核验）", tuple(offset))

    # -- 填写正文 ---------------------------------------------------------

    def fill_text(self, text: str, timeout: float | None = None) -> None:
        """剪贴板 + 右键粘贴，然后用屏幕 OCR 读回校验；最多 max_prepare_attempts 次。"""
        self._require_geometry_ready()
        self._assert_normalized_session()
        if not self._editor_open or self._paste_point is None:
            raise ExecutorError("WINDOW_NOT_FOUND", "朋友圈编辑器未打开，已停止操作")
        if not self._clipboard.set_text(text):
            raise ExecutorError("DESKTOP_UNSUPPORTED", "无法写入剪贴板，拒绝盲粘贴")
        attempts = int(getattr(self._config, "max_prepare_attempts", 3))
        try:
            for attempt in range(1, attempts + 1):
                self._check_cancel()
                self._assert_foreground()
                self._input.click(*self._paste_point)
                self._sleep(_PASTE_WAIT)
                captured = self._capture_ocr("editor-text", screen=True)
                if self._text_matches(captured.result.text, text):
                    self._editor_text = text
                    self._last_visible_text = captured.result.text
                    self._logger.info("OCR 校验粘贴成功（attempt=%s）", attempt)
                    return
                if attempt < attempts:
                    self._logger.warning("OCR 读回与预期不一致，重新打开粘贴菜单（attempt=%s）", attempt)
                    self._open_paste_menu()
                    self._sleep(float(getattr(self._config, "retry_backoff_seconds", 2.0)))
            raise ExecutorError(
                "CONTENT_CHANGED",
                "粘贴后 OCR 读回正文与预期不一致，已停止操作（未点击发表）",
            )
        finally:
            self._clipboard.clear()

    # -- 图片 / 可见范围 --------------------------------------------------

    def add_images(self, asset_paths: Sequence[str], timeout: float | None = None) -> None:
        # 几何流程只验证了纯文字发布；图片模式未测绘，禁止猜测。
        raise ExecutorError(
            "DESKTOP_UNSUPPORTED",
            "geometry 驱动仅支持纯文字朋友圈（图片模式未测绘），拒绝执行",
        )

    def supports_visibility(self, visibility: str) -> bool:
        return visibility == "PUBLIC"

    def set_visibility(self, visibility: str, timeout: float | None = None) -> None:
        if visibility != "PUBLIC":
            raise ExecutorError(
                "DESKTOP_UNSUPPORTED",
                f"geometry 驱动仅验证了公开（PUBLIC）可见范围，不支持 {visibility}",
            )
        # 纯文字编辑器默认即公开；不做无法验证的点击。
        self._logger.info("geometry 模式使用默认公开可见范围")

    # -- 读回 / 截图 ------------------------------------------------------

    def read_back(self, timeout: float | None = None) -> tuple[str, int]:
        self._require_geometry_ready()
        self._assert_normalized_session()
        if not self._editor_open:
            raise ExecutorError("WINDOW_NOT_FOUND", "朋友圈编辑器未打开，无法读回正文")
        captured = self._capture_ocr("read-back", screen=True)
        self._last_visible_text = captured.result.text
        return captured.result.text, 0

    def screenshot(self, dest_path: str, timeout: float | None = None) -> str:
        self._require_geometry_ready(require_admin=False)
        return self._capture_png(dest_path, screen=True)

    def matches_expected_text(self, visible_text: str, expected_text: str) -> bool:
        return self._text_matches(visible_text, expected_text)

    def matches_verified_text(self, visible_text: str, expected_text: str) -> bool:
        # 朋友圈信息流可能只显示正文的一部分，核验允许任意一个长片段匹配。
        return contains_expected_text_fuzzy(visible_text, expected_text, mode="any")

    @staticmethod
    def _text_matches(visible_text: str, expected_text: str) -> bool:
        # OCR 对中文可能有个别字符误识别，用行级相似度而不是整段精确相等。
        return contains_expected_text_fuzzy(visible_text, expected_text, mode="all")

    # -- 点击发表（含有限重试） -------------------------------------------

    def click_publish(self, timeout: float | None = None) -> None:
        """OCR 复核正文 + 像素检测绿色按钮后点击；有限重试，无法确认即 uncertain。"""
        self._require_geometry_ready()
        self._assert_normalized_session()
        # 双保险：不绕过 effective_allow_publish；几何模式还需要 geometry_allow_publish。
        if not self._geometry_publish_allowed():
            raise ExecutorError(
                "PUBLISH_MODE_DISABLED",
                "几何驱动未开启发表权限（需要 --geometry-allow-publish + --allow-publish + 第二/第三档），未点击发表",
            )
        if not self._editor_open:
            raise ExecutorError("WINDOW_NOT_FOUND", "朋友圈编辑器未打开，禁止点击发表")
        if self._submitted:
            raise ExecutorError("ALREADY_SUBMITTED", "本次执行已经点击过发表，禁止重复点击")
        expected = self._editor_text
        if not expected:
            raise ExecutorError("WINDOW_NOT_FOUND", "尚未通过 OCR 读回编辑器正文，禁止点击发表")
        max_retries = int(getattr(self._config, "max_publish_click_retries", 1))
        retries_used = 0
        while True:
            self._check_cancel()
            self._assert_foreground()
            before = self._capture_ocr("before-click", screen=True)
            toast = find_error_toast(before.result)
            if toast:
                if self._submitted:
                    raise PublishAttemptError(
                        "UNCERTAIN",
                        f"点击后检测到发送失败提示“{toast}”，无法确认是否已发布，已停止重试",
                        may_have_submitted=True,
                    )
                raise ExecutorError("WINDOW_BLOCKED", f"编辑器检测到“{toast}”提示，未点击发表")
            if not contains_expected_text_fuzzy(before.result.text, expected, mode="all"):
                raise ExecutorError("CONTENT_CHANGED", "编辑窗口 OCR 正文与预期不一致，未点击发表")

            rect, hwnd = self._window.rect, self._window.hwnd
            width, height, rows = self._capture_screen_rgb()
            targets = {}
            if not self._verified_layout():
                frame_ocr = self._ocr_for_frame(width,height,rows)
                if not contains_expected_text_fuzzy(frame_ocr.text,expected,mode='all'):
                    raise ExecutorError("CONTENT_CHANGED", "当前按钮截图的正文已改变，未点击发表")
                targets = locate_controls(frame_ocr,width,height,rows)
            target = targets.get("publish")
            point = detect_publish_button_rgb(width, height, rows) if self._verified_layout() else None
            if target is not None:
                from .wechat4_geometry import Point
                point = Point(target["x"],target["y"])
            if point is None:
                if self._submitted:
                    raise PublishAttemptError(
                        "UNCERTAIN",
                        "点击后未检测到绿色“发表”按钮，无法确认结果，已停止重试",
                        may_have_submitted=True,
                    )
                raise ExecutorError("WINDOW_NOT_FOUND", "未检测到绿色“发表”按钮，禁止点击（不盲点）")
            screen_point = self._bitmap_to_screen(point.x, point.y, width, height)
            self._assert_window_unchanged(rect,hwnd)
            self._assert_foreground()
            self._input.click(screen_point[0], screen_point[1])
            self._submitted = True
            self._logger.info("已点击绿色发表按钮（retry=%s）", retries_used)
            self._sleep(float(getattr(self._config, "geometry_wait_after_click", 1.5)))

            state = self._inspect_after_click()
            if state == "closed":
                return
            if state == "toast":
                raise PublishAttemptError(
                    "UNCERTAIN",
                    "点击发表后检测到发送失败提示，无法确认是否已发布，已停止重试（禁止二次点击）",
                    may_have_submitted=True,
                )
            if state == "unknown":
                raise PublishAttemptError(
                    "UNCERTAIN",
                    "点击发表后无法确认编辑器状态，已停止重试（禁止二次点击）",
                    may_have_submitted=True,
                )
            # state == "editor_open"：仅当编辑器仍打开且按钮仍存在才允许有限重试。
            if retries_used >= max_retries:
                raise PublishAttemptError(
                    "UNCERTAIN",
                    "点击发表后编辑器仍在且按钮仍存在，已达重试上限，已停止（禁止继续点击）",
                    may_have_submitted=True,
                )
            retries_used += 1
            self._logger.warning("发表点击后编辑器仍打开，进行第 %s 次有限重试", retries_used)
            self._sleep(float(getattr(self._config, "retry_backoff_seconds", 2.0)))

    def _inspect_after_click(self) -> str:
        """返回 closed / toast / editor_open / unknown；任何异常都视为 unknown。"""
        try:
            captured = self._capture_ocr("after-click", screen=True)
        except ExecutorError as exc:
            self._logger.warning("点击后 OCR 状态检查失败：%s", exc.code)
            return "unknown"
        toast = find_error_toast(captured.result)
        if toast:
            return "toast"
        try:
            width, height, rows = self._capture_screen_rgb()
        except ExecutorError:
            return "unknown"
        if detect_publish_button_rgb(width, height, rows) is not None:
            return "editor_open"
        return "closed"

    # -- 发布后核验 -------------------------------------------------------

    def verify_published(
        self,
        expected_text: str,
        expected_image_count: int,
        *,
        evidence_path: str | None = None,
        timeout: float | None = None,
    ) -> Verification:
        method = "geometry-ocr"
        if expected_image_count != 0:
            return Verification(
                verified=False,
                method=method,
                notes=["geometry 模式仅支持纯文字朋友圈，图片数量应为 0"],
            )
        evidence = self._save_evidence(evidence_path)
        try:
            captured = self._capture_ocr("feed", screen=True)
        except ExecutorError as exc:
            return Verification(
                verified=False,
                method=method,
                evidence_path=evidence,
                notes=[f"发布后核验失败（{exc.code}）：{exc.message}"],
            )
        toast = find_error_toast(captured.result)
        if toast:
            return Verification(
                verified=False,
                method=method,
                visible_text=captured.result.text[:500],
                image_count=0,
                evidence_path=evidence,
                notes=[f"检测到发送失败提示“{toast}”，无法确认发布成功"],
            )
        if contains_expected_text_fuzzy(captured.result.text, expected_text, mode="any"):
            matched = self._matched_visible(captured.result.text, expected_text)
            return Verification(
                verified=True,
                method=method,
                published_at=utc_now_iso(),
                visible_text=matched or expected_text,
                image_count=0,
                evidence_path=evidence,
                notes=["OCR 朋友圈匹配成功（geometry）"],
            )
        return Verification(
            verified=False,
            method=method,
            visible_text=captured.result.text[:500],
            image_count=0,
            evidence_path=evidence,
            notes=["无法在朋友圈 OCR 中匹配到预期正文，返回 uncertain"],
        )

    def _matched_visible(self, visible_text: str, expected_text: str) -> str:
        expected = normalize_ocr_text(expected_text)
        fragments = [line for line in expected.split("\n") if len(line) >= 8] or ([expected] if expected else [])
        visible_lines = normalize_ocr_text(visible_text).split("\n")
        matched = [
            line
            for line in visible_lines
            if any(fragment and fragment in line for fragment in fragments)
        ]
        return "\n".join(matched)[:500]

    def _save_evidence(self, evidence_path: str | None) -> str | None:
        if not evidence_path:
            return None
        try:
            ensure_directory_under((self._screenshot_dir,), self._screenshot_dir)
            saved = self._capture_png(evidence_path, screen=True)
            return resolve_under((self._screenshot_dir,), saved, must_exist_file=True)
        except (ExecutorError, OSError, ValueError) as exc:
            self._logger.warning("发布证据截图失败：%s", type(exc).__name__)
            return None

    # -- 删除 / 回滚 ------------------------------------------------------

    def delete_published(
        self,
        expected_text: str,
        *,
        evidence_path: str | None = None,
        timeout: float | None = None,
    ) -> DeleteOutcome:
        """删除 OCR 匹配到的自己首条动态；无法确认/不匹配时拒绝删除。"""
        self._check_cancel()
        if not self._geometry_publish_allowed():
            return DeleteOutcome(
                deleted=False,
                uncertain=False,
                error_code="PUBLISH_MODE_DISABLED",
                message="几何驱动未开启删除权限（需要 --geometry-allow-publish + --allow-publish + 第二/第三档）",
            )
        expected_norm = normalize_ocr_text(expected_text)
        if len(expected_norm) < 8:
            return DeleteOutcome(
                deleted=False,
                uncertain=True,
                error_code="UNCERTAIN",
                message="预期正文过短（<8 字符），无法安全匹配动态，拒绝删除",
            )
        try:
            self._require_geometry_ready()
            self._focus_window()
            assert self._geometry is not None
            # 刷新朋友圈信息流
            self._click_named("discover")
            self._sleep(_NAV_WAIT)
            self._click_named("moments_entry")
            self._sleep(_MOMENTS_WAIT)
            captured = self._capture_ocr("delete-find", screen=True)
        except ExecutorError as exc:
            return DeleteOutcome(
                deleted=False,
                uncertain=True,
                error_code=exc.code,
                message=exc.message,
            )
        matches = self._match_delete_candidates(captured, expected_norm)
        if not matches:
            return DeleteOutcome(
                deleted=False,
                uncertain=True,
                error_code="UNCERTAIN",
                message="朋友圈 OCR 未找到匹配正文（可能已删除或未加载完整），无法确认",
            )
        if len(matches) > 1:
            return DeleteOutcome(
                deleted=False,
                uncertain=True,
                error_code="UNCERTAIN",
                message=f"匹配到多条动态（{len(matches)} 条），拒绝删除以避免误删",
            )
        match = matches[0]
        if match.center[1] > int(captured.height * _DELETE_TOP_REGION_RATIO):
            return DeleteOutcome(
                deleted=False,
                uncertain=True,
                error_code="UNCERTAIN",
                message="匹配动态不在已测绘的首条动态区域，拒绝盲点删除",
            )
        if self._geometry is None:
            return DeleteOutcome(False, True, "WINDOW_NOT_FOUND", "微信窗口未定位，无法删除")
        try:
            # hover 匹配动态后点击首条动态删除垃圾桶
            hover = self._line_screen_point(match, captured)
            self._input.move(hover[0], hover[1])
            self._sleep(_HOVER_WAIT)
            self._click_named("first_post_trash")
            self._sleep(_DIALOG_WAIT)
            dialog = self._capture_ocr("delete-dialog", screen=True)
        except ExecutorError as exc:
            return DeleteOutcome(False, True, exc.code, exc.message)
        confirm_boxes = self._locate_token_words(dialog.result, "删除")
        if not confirm_boxes:
            return DeleteOutcome(
                deleted=False,
                uncertain=True,
                error_code="UNCERTAIN",
                message="未在确认对话框中找到“删除”按钮，已停止，未执行删除",
            )
        try:
            confirm = self._line_screen_point(confirm_boxes[0], dialog)
            self._input.click(confirm[0], confirm[1])
            self._sleep(_AFTER_DELETE_WAIT)
            after = self._capture_ocr("delete-after", screen=True)
        except ExecutorError as exc:
            return DeleteOutcome(False, True, exc.code, f"删除确认后无法核验：{exc.message}")
        evidence = self._save_evidence(evidence_path)
        if self._match_delete_candidates(after, expected_norm):
            return DeleteOutcome(
                deleted=False,
                uncertain=True,
                error_code="UNCERTAIN",
                message="删除后仍能在朋友圈 OCR 到匹配正文，无法确认删除成功",
                evidence_path=evidence,
            )
        return DeleteOutcome(
            deleted=True,
            uncertain=False,
            error_code=None,
            message="已删除匹配的朋友圈动态，并通过 OCR 确认正文消失",
            evidence_path=evidence,
        )

    @staticmethod
    def _match_delete_candidates(captured: _CapturedOcr, expected_norm: str) -> list[OcrBBox]:
        fragments = [line for line in expected_norm.split("\n") if len(line) >= 8] or [expected_norm]
        boxes: list[OcrBBox] = []
        for line in captured.result.lines:
            line_norm = normalize_ocr_text(line.text)
            if any(
                fragment and line_similarity(fragment, line_norm) >= 0.72
                for fragment in fragments
            ):
                boxes.append(line.bbox)
        return boxes

    @staticmethod
    def _locate_token_words(result: OcrResult, token: str) -> list[OcrBBox]:
        """只接受“词级完全匹配”，避免把对话框正文里的「删除」误当成按钮点击。"""
        target = normalize_ocr_text(token)
        if not target or not result.available:
            return []
        return [
            word.bbox
            for word in result.words
            if normalize_ocr_text(word.text) == target
        ]


# ---------------------------------------------------------------------------
# 便捷构造
# ---------------------------------------------------------------------------


def create_geometry_driver(
    config: ExecutorConfig,
    *,
    locator: WindowLocator | None = None,
    ocr: OcrProvider | None = None,
    logger: logging.Logger | None = None,
) -> GeometryWechatDriver:
    return GeometryWechatDriver(config, locator=locator, ocr=ocr, logger=logger)


