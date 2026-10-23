"""Windows 窗口定位、交互桌面检测与截图。

实现原则：
- 只使用 Python 标准库（ctypes / winreg / zlib / struct），不硬编码任何屏幕坐标；
- 优先通过「进程名 + 窗口类名 + 标题」识别微信窗口，句柄由系统枚举得到；
- 所有 Windows API 调用都做了异常兜底，模块可在非 Windows 上导入（测试友好）；
- 支持注入假数据（窗口列表 / 进程列表 / 安装信息 / 交互桌面状态），
  单元测试不需要真实微信或真实 GUI。
"""
from __future__ import annotations

import ctypes
import os
import struct
import sys
import time
import zlib
from dataclasses import dataclass, field
from typing import Any, Iterable, Sequence

from .config import (
    ExecutorError,
    PathGuardError,
    WechatInstallation,
    ensure_directory_under,
    normalize_path,
    resolve_under,
    utc_now_iso,
)

# ---------------------------------------------------------------------------
# 平台常量与结构体
# ---------------------------------------------------------------------------

_IS_WINDOWS = os.name == "nt"

_PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
_TH32CS_SNAPPROCESS = 0x00000002
_DESKTOP_SWITCHDESKTOP = 0x0100
_SM_REMOTESESSION = 0x1000
_DIB_RGB_COLORS = 0
_PW_RENDERFULLCONTENT = 0x00000002
_WTS_CURRENT_SESSION = 0xFFFFFFFF
_WTS_CONNECT_STATE = 8
_WTS_ACTIVE = 0
_WTS_DISCONNECTED = 4

_ERROR_ACCESS_DENIED = 5
_ERROR_INVALID_HANDLE = 6
_HANDLE_INVALID = ctypes.c_void_p(-1).value

if _IS_WINDOWS:
    try:
        _user32 = ctypes.WinDLL("user32", use_last_error=True)
        _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        _gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)
    except OSError:  # pragma: no cover - 极端环境
        _user32 = _kernel32 = _gdi32 = None
        _IS_WINDOWS = False
else:  # pragma: no cover - 非 Windows 平台仅用于导入健壮性
    _user32 = _kernel32 = _gdi32 = None


class _RECT(ctypes.Structure):
    _fields_ = [
        ("left", ctypes.c_long),
        ("top", ctypes.c_long),
        ("right", ctypes.c_long),
        ("bottom", ctypes.c_long),
    ]


class _PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [
        ("dwSize", ctypes.c_ulong),
        ("cntUsage", ctypes.c_ulong),
        ("th32ProcessID", ctypes.c_ulong),
        ("th32DefaultHeapID", ctypes.c_void_p),
        ("th32ModuleID", ctypes.c_ulong),
        ("cntThreads", ctypes.c_ulong),
        ("th32ParentProcessID", ctypes.c_ulong),
        ("pcPriClassBase", ctypes.c_long),
        ("dwFlags", ctypes.c_ulong),
        ("szExeFile", ctypes.c_wchar * 260),
    ]


class _BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", ctypes.c_ulong),
        ("biWidth", ctypes.c_long),
        ("biHeight", ctypes.c_long),
        ("biPlanes", ctypes.c_ushort),
        ("biBitCount", ctypes.c_ushort),
        ("biCompression", ctypes.c_ulong),
        ("biSizeImage", ctypes.c_ulong),
        ("biXPelsPerMeter", ctypes.c_long),
        ("biYPelsPerMeter", ctypes.c_long),
        ("biClrUsed", ctypes.c_ulong),
        ("biClrImportant", ctypes.c_ulong),
    ]


class _BITMAPINFO(ctypes.Structure):
    _fields_ = [("bmiHeader", _BITMAPINFOHEADER), ("bmiColors", ctypes.c_ulong * 1)]


if _IS_WINDOWS and _user32 is not None and _kernel32 is not None and _gdi32 is not None:
    try:
        _WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_ssize_t)
        _user32.EnumWindows.argtypes = [_WNDENUMPROC, ctypes.c_ssize_t]
        _user32.EnumWindows.restype = ctypes.c_bool
        _user32.GetWindowTextLengthW.argtypes = [ctypes.c_void_p]
        _user32.GetWindowTextLengthW.restype = ctypes.c_int
        _user32.GetWindowTextW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_int]
        _user32.GetWindowTextW.restype = ctypes.c_int
        _user32.GetClassNameW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_int]
        _user32.GetClassNameW.restype = ctypes.c_int
        _user32.GetWindowRect.argtypes = [ctypes.c_void_p, ctypes.POINTER(_RECT)]
        _user32.GetWindowRect.restype = ctypes.c_bool
        _user32.GetWindowThreadProcessId.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]
        _user32.GetWindowThreadProcessId.restype = ctypes.c_ulong
        _user32.IsWindowVisible.argtypes = [ctypes.c_void_p]
        _user32.IsWindowVisible.restype = ctypes.c_bool
        _user32.IsIconic.argtypes = [ctypes.c_void_p]
        _user32.IsIconic.restype = ctypes.c_bool
        _user32.GetWindow.argtypes = [ctypes.c_void_p, ctypes.c_uint]
        _user32.GetWindow.restype = ctypes.c_void_p
        _user32.OpenInputDesktop.argtypes = [ctypes.c_ulong, ctypes.c_bool, ctypes.c_ulong]
        _user32.OpenInputDesktop.restype = ctypes.c_void_p
        _user32.CloseDesktop.argtypes = [ctypes.c_void_p]
        _user32.CloseDesktop.restype = ctypes.c_bool
        _user32.GetSystemMetrics.argtypes = [ctypes.c_int]
        _user32.GetSystemMetrics.restype = ctypes.c_int
        _user32.PrintWindow.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint]
        _user32.PrintWindow.restype = ctypes.c_bool
        _user32.GetWindowDC.argtypes = [ctypes.c_void_p]
        _user32.GetWindowDC.restype = ctypes.c_void_p
        _user32.ReleaseDC.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        _user32.ReleaseDC.restype = ctypes.c_int
        if hasattr(_user32, "GetDpiForWindow"):
            _user32.GetDpiForWindow.argtypes = [ctypes.c_void_p]
            _user32.GetDpiForWindow.restype = ctypes.c_uint

        _kernel32.CreateToolhelp32Snapshot.argtypes = [ctypes.c_ulong, ctypes.c_ulong]
        _kernel32.CreateToolhelp32Snapshot.restype = ctypes.c_void_p
        _kernel32.GetLogicalDrives.argtypes = []
        _kernel32.GetLogicalDrives.restype = ctypes.c_ulong
        _kernel32.Process32FirstW.argtypes = [ctypes.c_void_p, ctypes.POINTER(_PROCESSENTRY32W)]
        _kernel32.Process32FirstW.restype = ctypes.c_bool
        _kernel32.Process32NextW.argtypes = [ctypes.c_void_p, ctypes.POINTER(_PROCESSENTRY32W)]
        _kernel32.Process32NextW.restype = ctypes.c_bool
        _kernel32.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_bool, ctypes.c_ulong]
        _kernel32.OpenProcess.restype = ctypes.c_void_p
        _kernel32.QueryFullProcessImageNameW.argtypes = [
            ctypes.c_void_p,
            ctypes.c_ulong,
            ctypes.c_wchar_p,
            ctypes.POINTER(ctypes.c_ulong),
        ]
        _kernel32.QueryFullProcessImageNameW.restype = ctypes.c_bool
        _kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
        _kernel32.CloseHandle.restype = ctypes.c_bool

        _gdi32.CreateCompatibleDC.argtypes = [ctypes.c_void_p]
        _gdi32.CreateCompatibleDC.restype = ctypes.c_void_p
        _gdi32.CreateCompatibleBitmap.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int]
        _gdi32.CreateCompatibleBitmap.restype = ctypes.c_void_p
        _gdi32.SelectObject.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        _gdi32.SelectObject.restype = ctypes.c_void_p
        _gdi32.GetDIBits.argtypes = [
            ctypes.c_void_p,
            ctypes.c_void_p,
            ctypes.c_uint,
            ctypes.c_uint,
            ctypes.c_void_p,
            ctypes.POINTER(_BITMAPINFO),
            ctypes.c_uint,
        ]
        _gdi32.GetDIBits.restype = ctypes.c_int
        _gdi32.DeleteObject.argtypes = [ctypes.c_void_p]
        _gdi32.DeleteObject.restype = ctypes.c_bool
        _gdi32.DeleteDC.argtypes = [ctypes.c_void_p]
        _gdi32.DeleteDC.restype = ctypes.c_bool
    except Exception:  # pragma: no cover - 仅防御异常 ctypes 绑定
        _IS_WINDOWS = False


# ---------------------------------------------------------------------------
# 数据模型
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ProcessInfo:
    """正在运行的进程。"""

    pid: int
    name: str
    exe_path: str | None = None


@dataclass(frozen=True)
class WindowInfo:
    """顶层窗口信息；矩形为屏幕坐标，但本执行器不会用固定坐标点击。"""

    hwnd: int
    title: str
    class_name: str
    process_id: int
    process_name: str
    rect: tuple[int, int, int, int] | None = None
    visible: bool = False
    minimized: bool = False
    dpi_scale: float | None = None

    @property
    def width(self) -> int:
        if not self.rect:
            return 0
        return max(0, self.rect[2] - self.rect[0])

    @property
    def height(self) -> int:
        if not self.rect:
            return 0
        return max(0, self.rect[3] - self.rect[1])

    def to_dict(self) -> dict[str, Any]:
        return {
            "hwnd": self.hwnd,
            "title": self.title,
            "className": self.class_name,
            "processId": self.process_id,
            "processName": self.process_name,
            "rect": list(self.rect) if self.rect else None,
            "visible": self.visible,
            "minimized": self.minimized,
            "dpiScale": self.dpi_scale,
        }


# ---------------------------------------------------------------------------
# 注册表 / 安装检测
# ---------------------------------------------------------------------------


def _scan_uninstall_registry() -> tuple[list[str], str | None, list[str], list[str]]:
    """扫描卸载注册表，返回（候选安装目录, 版本, 备注, 遗留提示）。"""
    install_dirs: list[str] = []
    versions: list[str] = []
    notes: list[str] = []
    leftovers: list[str] = []
    if not _IS_WINDOWS:
        return [], None, notes, leftovers
    try:
        import winreg
    except ImportError:  # pragma: no cover
        return [], None, notes, leftovers

    roots = [
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall", winreg.KEY_WOW64_64KEY),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall", winreg.KEY_WOW64_32KEY),
        (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall", 0),
    ]
    matched_display: list[str] = []
    for hive, path, flags in roots:
        try:
            access = winreg.KEY_READ | flags
            with winreg.OpenKey(hive, path, 0, access) as root:
                index = 0
                while True:
                    try:
                        sub_name = winreg.EnumKey(root, index)
                    except OSError:
                        break
                    index += 1
                    try:
                        with winreg.OpenKey(root, sub_name) as sub:
                            display = _read_reg_value(winreg, sub, "DisplayName")
                            if not isinstance(display, str) or not _is_wechat_display_name(display):
                                continue
                            matched_display.append(display)
                            version = _read_reg_value(winreg, sub, "DisplayVersion")
                            if isinstance(version, str) and version.strip():
                                versions.append(version.strip())
                            location = _read_reg_value(winreg, sub, "InstallLocation")
                            if isinstance(location, str) and location.strip():
                                install_dirs.append(_strip_quotes(location.strip()))
                            icon = _read_reg_value(winreg, sub, "DisplayIcon")
                            if isinstance(icon, str) and icon.strip():
                                icon_path = _strip_quotes(icon.strip().split(",")[0])
                                if icon_path.lower().endswith(".exe"):
                                    install_dirs.append(os.path.dirname(icon_path))
                    except OSError:
                        continue
        except OSError:
            continue

    # 腾讯自己的软件配置项也可能记录安装路径（旧版 WeChat 与 4.x Weixin 都要查）。
    for hive, path in (
        (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Tencent\Weixin"),
        (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Tencent\WeChat"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Tencent\Weixin"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Tencent\WeChat"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Tencent\Weixin"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Tencent\WeChat"),
    ):
        try:
            with winreg.OpenKey(hive, path) as key:
                for value_name in ("InstallPath", "InstallDir", "FileSavePath"):
                    try:
                        value, _ = winreg.QueryValueEx(key, value_name)
                    except OSError:
                        continue
                    if isinstance(value, str) and value.strip():
                        candidate = _strip_quotes(value.strip())
                        if os.path.splitext(candidate)[1].lower() == ".exe":
                            candidate = os.path.dirname(candidate)
                        install_dirs.append(candidate)
        except OSError:
            continue

    version = versions[0] if versions else None
    if matched_display and not install_dirs:
        leftovers.append("注册表存在微信安装记录，但未记录安装目录")
    return install_dirs, version, notes, leftovers


def _read_reg_value(winreg_module: Any, key: Any, name: str) -> Any:
    try:
        value, _ = winreg_module.QueryValueEx(key, name)
        return value
    except OSError:
        return None


def _strip_quotes(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    return value


def _is_wechat_display_name(display: str) -> bool:
    lowered = display.lower().replace(" ", "")
    return ("微信" in display) or ("wechat" in lowered) or ("weixin" in lowered)


def _default_install_candidates() -> list[str]:
    bases = [
        os.environ.get("ProgramFiles"),
        os.environ.get("ProgramFiles(x86)"),
        os.environ.get("LOCALAPPDATA"),
        os.environ.get("ProgramData"),
        os.environ.get("APPDATA"),
    ]
    subdirs = [
        os.path.join("Tencent", "WeChat"),
        os.path.join("Tencent", "Weixin"),
        os.path.join("Tencent", "WeChat"),
        "WeChat",
        "Weixin",
    ]
    candidates: list[str] = []
    for base in bases:
        if not base:
            continue
        for sub in subdirs:
            candidates.append(os.path.join(base, sub))
    # 非默认盘符的装机目录：逐个已存在的逻辑盘查 tencent/Weixin 与 tencent/WeChat。
    for drive in _logical_drive_roots():
        for name in ("Weixin", "WeChat"):
            candidates.append(os.path.join(drive, "tencent", name))
    return candidates


def _logical_drive_roots() -> list[str]:
    if not _IS_WINDOWS or _kernel32 is None:
        return []
    try:
        bitmask = int(_kernel32.GetLogicalDrives())
    except (OSError, AttributeError):
        return []
    return [f"{chr(ord('A') + index)}:\\" for index in range(26) if bitmask & (1 << index)]


def _file_version(path: str) -> str | None:
    """读取可执行文件版本号（version.dll），失败返回 None。"""
    if not _IS_WINDOWS:
        return None
    try:
        version_dll = ctypes.WinDLL("version", use_last_error=True)
        size = version_dll.GetFileVersionInfoSizeW(path, None)
        if not size:
            return None
        buffer = ctypes.create_string_buffer(size)
        if not version_dll.GetFileVersionInfoW(path, 0, size, buffer):
            return None
        pointer = ctypes.c_void_p()
        length = ctypes.c_uint()
        if not version_dll.VerQueryValueW(buffer, "\\", ctypes.byref(pointer), ctypes.byref(length)):
            return None
        if not pointer.value:
            return None
        info = ctypes.cast(pointer, ctypes.POINTER(ctypes.c_ulong * 4)).contents
        ms, ls = info[2], info[3]
        return f"{ms >> 16}.{ms & 0xFFFF}.{ls >> 16}.{ls & 0xFFFF}"
    except Exception:
        return None


def _path_exists_file(path: str) -> bool:
    try:
        return os.path.isfile(path)
    except OSError:
        return False


# ---------------------------------------------------------------------------
# 窗口定位器
# ---------------------------------------------------------------------------


class WindowLocator:
    """窗口枚举与微信窗口定位。

    所有 ``*_fake`` 参数只用于测试注入；生产环境保持默认 None 即使用真实
    Windows API。测试可这样构造：

        WindowLocator(windows=[WindowInfo(...)], installation=WechatInstallation(...),
                      interactive=True, locked=False, processes=[ProcessInfo(...)])
    """

    def __init__(
        self,
        *,
        windows: Sequence[WindowInfo] | None = None,
        processes: Sequence[ProcessInfo] | None = None,
        installation: WechatInstallation | None = None,
        interactive: bool | None = None,
        locked: bool | None = None,
        dpi_scale: float | None = 1.0,
    ) -> None:
        self._fake_windows = list(windows) if windows is not None else None
        self._fake_processes = list(processes) if processes is not None else None
        self._fake_installation = installation
        self._fake_interactive = interactive
        self._fake_locked = locked
        self._fake_dpi = dpi_scale

    # -- 平台能力 ---------------------------------------------------------

    @property
    def backend_available(self) -> bool:
        return _IS_WINDOWS

    def is_interactive_desktop(self) -> tuple[bool, bool, list[str]]:
        """返回 (interactive, locked, notes)；锁屏 / RDP 断开 / 服务会话均为不可交互。"""
        if self._fake_interactive is not None:
            interactive = bool(self._fake_interactive)
            locked = bool(self._fake_locked) if self._fake_locked is not None else not interactive
            notes = [] if interactive else ["当前会话不是可交互桌面（测试注入）"]
            return interactive, locked, notes
        if not _IS_WINDOWS or _user32 is None:
            # 非 Windows 平台不能做真实 GUI 自动化；返回不可交互并说明原因。
            return False, False, ["非 Windows 平台：不支持微信桌面自动化"]
        notes: list[str] = []
        interactive = True
        locked = False
        try:
            desktop = _user32.OpenInputDesktop(0, False, _DESKTOP_SWITCHDESKTOP)
            if not desktop:
                interactive = False
                locked = True
                notes.append("当前输入桌面不可用，可能已锁屏或处于安全桌面")
            else:
                _user32.CloseDesktop(desktop)
        except OSError:
            interactive = False
            notes.append("无法访问输入桌面（OpenInputDesktop 失败）")

        connect_state = _query_session_connect_state()
        if connect_state is not None and connect_state != _WTS_ACTIVE:
            interactive = False
            if connect_state == _WTS_DISCONNECTED:
                notes.append("远程桌面/会话已断开，无法执行 GUI 操作")
            else:
                notes.append(f"当前会话连接状态为 {connect_state}，不是活动会话")
        try:
            if _user32.GetSystemMetrics(_SM_REMOTESESSION):
                notes.append("当前处于远程桌面会话")
        except OSError:  # pragma: no cover
            pass
        return interactive, locked, notes

    # -- 进程枚举 ---------------------------------------------------------

    def list_processes(self) -> list[ProcessInfo]:
        if self._fake_processes is not None:
            return list(self._fake_processes)
        if not _IS_WINDOWS or _kernel32 is None:
            return []
        result: list[ProcessInfo] = []
        try:
            snapshot = _kernel32.CreateToolhelp32Snapshot(_TH32CS_SNAPPROCESS, 0)
        except OSError:
            return result
        if not snapshot or snapshot == _HANDLE_INVALID:
            return result
        try:
            entry = _PROCESSENTRY32W()
            entry.dwSize = ctypes.sizeof(_PROCESSENTRY32W)
            if not _kernel32.Process32FirstW(snapshot, ctypes.byref(entry)):
                return result
            while True:
                pid = int(entry.th32ProcessID)
                name = entry.szExeFile
                if pid > 0 and name:
                    result.append(ProcessInfo(pid=pid, name=name, exe_path=self._process_path(pid)))
                entry.dwSize = ctypes.sizeof(_PROCESSENTRY32W)
                if not _kernel32.Process32NextW(snapshot, ctypes.byref(entry)):
                    break
        except OSError:
            pass
        finally:
            try:
                _kernel32.CloseHandle(snapshot)
            except OSError:  # pragma: no cover
                pass
        return result

    def _process_path(self, pid: int) -> str | None:
        if not _IS_WINDOWS or _kernel32 is None:
            return None
        handle = None
        try:
            handle = _kernel32.OpenProcess(_PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
            if not handle:
                return None
            size = ctypes.c_ulong(1024)
            buffer = ctypes.create_unicode_buffer(size.value)
            if _kernel32.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size)):
                return buffer.value
            return None
        except OSError:
            return None
        finally:
            if handle:
                try:
                    _kernel32.CloseHandle(handle)
                except OSError:  # pragma: no cover
                    pass

    # -- 窗口枚举 ---------------------------------------------------------

    def list_windows(self) -> list[WindowInfo]:
        if self._fake_windows is not None:
            return list(self._fake_windows)
        if not _IS_WINDOWS or _user32 is None:
            return []
        process_names: dict[int, str] = {}
        try:
            for process in self.list_processes():
                process_names[process.pid] = process.name
        except OSError:  # pragma: no cover
            process_names = {}
        windows: list[WindowInfo] = []

        def _callback(hwnd: int, _lparam: int) -> bool:  # noqa: ANN001 - ctypes 回调
            try:
                windows.append(self._describe_window(hwnd, process_names))
            except OSError:
                pass
            return True

        callback = _WNDENUMPROC(_callback)
        try:
            _user32.EnumWindows(callback, 0)
        except OSError:  # pragma: no cover
            pass
        return windows

    def _describe_window(self, hwnd: int, process_names: dict[int, str]) -> WindowInfo:
        title_buffer = ctypes.create_unicode_buffer(512)
        class_buffer = ctypes.create_unicode_buffer(256)
        _user32.GetWindowTextW(hwnd, title_buffer, 512)  # type: ignore[union-attr]
        _user32.GetClassNameW(hwnd, class_buffer, 256)  # type: ignore[union-attr]
        pid = ctypes.c_ulong(0)
        _user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))  # type: ignore[union-attr]
        rect = _RECT()
        got_rect = bool(_user32.GetWindowRect(hwnd, ctypes.byref(rect)))  # type: ignore[union-attr]
        return WindowInfo(
            hwnd=int(hwnd),
            title=title_buffer.value or "",
            class_name=class_buffer.value or "",
            process_id=int(pid.value),
            process_name=process_names.get(int(pid.value), ""),
            rect=(rect.left, rect.top, rect.right, rect.bottom) if got_rect else None,
            visible=bool(_user32.IsWindowVisible(hwnd)),  # type: ignore[union-attr]
            minimized=bool(_user32.IsIconic(hwnd)),  # type: ignore[union-attr]
            dpi_scale=self.get_dpi_scale(hwnd),
        )

    def get_dpi_scale(self, hwnd: int | None) -> float:
        if self._fake_dpi is not None and (hwnd is None or self._fake_windows is not None):
            return float(self._fake_dpi)
        if not _IS_WINDOWS or _user32 is None or hwnd is None:
            return 1.0
        try:
            if hasattr(_user32, "GetDpiForWindow"):
                dpi = int(_user32.GetDpiForWindow(hwnd))
                if dpi > 0:
                    return round(dpi / 96.0, 3)
        except OSError:
            pass
        return 1.0

    # -- 微信窗口定位 -----------------------------------------------------

    def find_main_window(
        self,
        exe_names: Iterable[str] = ("WeChat.exe", "Weixin.exe"),
        titles: Iterable[str] = ("微信", "WeChat", "Weixin"),
        class_names: Iterable[str] = (
            "WeChatMainWndForPC",
            "WeixinMainWndForPC",
            "Qt51514QWindowIcon",
        ),
    ) -> WindowInfo | None:
        """按“进程名 + 类名 + 标题”打分选择微信主窗口，不使用固定坐标。

        登录窗口不是主窗口，直接排除（登录状态由 ``find_login_window`` 判断）。
        """
        exe_lower = {name.lower() for name in exe_names}
        title_list = [title.lower() for title in titles]
        class_set = {name.lower() for name in class_names}
        best: tuple[int, WindowInfo] | None = None
        for window in self.list_windows():
            if _looks_like_login_window(window):
                continue
            score = 0
            if window.process_name.lower() in exe_lower:
                score += 5
            if window.class_name.lower() in class_set:
                score += 4
            if any(title and title.lower() in window.title.lower() for title in title_list):
                score += 2
            if window.visible:
                score += 1
            if not window.minimized:
                score += 1
            if window.width > 0 and window.height > 0:
                score += 1
            if score < 5:
                continue
            if best is None or score > best[0]:
                best = (score, window)
        return best[1] if best else None

    def find_login_window(self, exe_names: Iterable[str] = ("WeChat.exe", "Weixin.exe")) -> WindowInfo | None:
        exe_lower = {name.lower() for name in exe_names}
        for window in self.list_windows():
            if window.process_name.lower() not in exe_lower:
                continue
            if _looks_like_login_window(window):
                return window
        return None

    # -- 安装检测 ---------------------------------------------------------

    def detect_installation(self, exe_names: Iterable[str] = ("WeChat.exe", "Weixin.exe")) -> WechatInstallation:
        """只读检测微信是否安装；找不到可执行文件时诚实返回 installed=False。"""
        if self._fake_installation is not None:
            return WechatInstallation(
                installed=self._fake_installation.installed,
                exe_path=self._fake_installation.exe_path,
                version=self._fake_installation.version,
                notes=list(self._fake_installation.notes),
            )
        if not _IS_WINDOWS:
            return WechatInstallation(installed=False, notes=["非 Windows 平台：不支持微信桌面自动化"])

        install_dirs, registry_version, notes, leftovers = _scan_uninstall_registry()
        notes = list(notes) + list(leftovers)
        candidates: list[str] = []
        for directory in install_dirs + _default_install_candidates():
            if directory and directory not in candidates:
                candidates.append(directory)

        for directory in candidates:
            for exe_name in exe_names:
                candidate = os.path.join(directory, exe_name)
                if _path_exists_file(candidate):
                    # 版本以可执行文件版本信息为准（注册表可能残留旧版本）。
                    version = _file_version(candidate) or registry_version
                    return WechatInstallation(
                        installed=True,
                        exe_path=normalize_path(candidate),
                        version=version,
                        notes=[f"已找到微信客户端：{candidate}"],
                    )
        if install_dirs:
            notes.append("注册表记录了微信安装目录，但其中没有找到 WeChat.exe/Weixin.exe（可能已卸载残留）")
        else:
            notes.append("未找到微信客户端安装")
        return WechatInstallation(installed=False, notes=notes)

    # -- 截图 -------------------------------------------------------------

    def capture_window_png(self, hwnd: int, dest_path: str, *, timeout: float = 10.0) -> str:
        """用 PrintWindow 截取窗口并编码为 PNG；失败抛 ExecutorError。"""
        target = normalize_path(dest_path)
        started = time.monotonic()
        if not _IS_WINDOWS or _user32 is None or _gdi32 is None:
            raise ExecutorError("DESKTOP_UNSUPPORTED", "当前环境不支持窗口截图（非 Windows）")
        if timeout <= 0 or time.monotonic() - started > timeout:
            raise ExecutorError("WINDOW_NOT_FOUND", "截图超时，已停止操作")
        rect = _RECT()
        if not _user32.GetWindowRect(hwnd, ctypes.byref(rect)):  # type: ignore[union-attr]
            raise ExecutorError("WINDOW_NOT_FOUND", "无法读取微信窗口位置，截图失败")
        width = max(0, rect.right - rect.left)
        height = max(0, rect.bottom - rect.top)
        if width <= 0 or height <= 0:
            raise ExecutorError("WINDOW_BLOCKED", "微信窗口尺寸为 0（可能已最小化），截图失败")

        window_dc = _user32.GetWindowDC(hwnd)  # type: ignore[union-attr]
        if not window_dc:
            raise ExecutorError("WINDOW_NOT_FOUND", "无法获取微信窗口设备上下文，截图失败")
        memory_dc = 0
        bitmap = 0
        old_object = 0
        try:
            memory_dc = _gdi32.CreateCompatibleDC(window_dc)  # type: ignore[union-attr]
            if not memory_dc:
                raise ExecutorError("WINDOW_NOT_FOUND", "无法创建截图缓冲区")
            bitmap = _gdi32.CreateCompatibleBitmap(window_dc, width, height)  # type: ignore[union-attr]
            if not bitmap:
                raise ExecutorError("WINDOW_NOT_FOUND", "无法创建截图位图")
            old_object = _gdi32.SelectObject(memory_dc, bitmap)  # type: ignore[union-attr]
            printed = bool(_user32.PrintWindow(hwnd, memory_dc, _PW_RENDERFULLCONTENT))  # type: ignore[union-attr]
            if not printed:
                printed = bool(_user32.PrintWindow(hwnd, memory_dc, 0))  # type: ignore[union-attr]
            if not printed:
                raise ExecutorError("WINDOW_NOT_FOUND", "PrintWindow 截图失败（窗口可能被遮挡）")

            buffer_size = width * height * 4
            raw = (ctypes.c_ubyte * buffer_size)()
            info = _BITMAPINFO()
            info.bmiHeader.biSize = ctypes.sizeof(_BITMAPINFOHEADER)
            info.bmiHeader.biWidth = width
            info.bmiHeader.biHeight = -height  # 负数表示自上而下
            info.bmiHeader.biPlanes = 1
            info.bmiHeader.biBitCount = 32
            info.bmiHeader.biCompression = 0
            scanned = _gdi32.GetDIBits(  # type: ignore[union-attr]
                memory_dc, bitmap, 0, height, ctypes.byref(raw), ctypes.byref(info), _DIB_RGB_COLORS
            )
            if scanned == 0:
                raise ExecutorError("WINDOW_NOT_FOUND", "读取窗口像素失败")
            rows = []
            for row_index in range(height):
                start = row_index * width * 4
                row = bytes(raw[start : start + width * 4])
                rgb = bytearray(width * 3)
                rgb[0::3] = row[2::4]
                rgb[1::3] = row[1::4]
                rgb[2::3] = row[0::4]
                rows.append(bytes(rgb))
            if time.monotonic() - started > timeout:
                raise ExecutorError("WINDOW_NOT_FOUND", "截图超时，已停止操作")
            png = encode_png_rgb(width, height, rows)
            parent = os.path.dirname(target)
            if parent:
                os.makedirs(parent, exist_ok=True)
            with open(target, "wb") as handle:
                handle.write(png)
        except ExecutorError:
            raise
        except OSError as exc:
            raise ExecutorError("INTERNAL_ERROR", f"写入截图失败：{exc}") from exc
        finally:
            try:
                if old_object:
                    _gdi32.SelectObject(memory_dc, old_object)  # type: ignore[union-attr]
                if bitmap:
                    _gdi32.DeleteObject(bitmap)  # type: ignore[union-attr]
                if memory_dc:
                    _gdi32.DeleteDC(memory_dc)  # type: ignore[union-attr]
                _user32.ReleaseDC(hwnd, window_dc)  # type: ignore[union-attr]
            except OSError:  # pragma: no cover
                pass
        if not os.path.isfile(target):
            raise ExecutorError("INTERNAL_ERROR", "截图文件未生成")
        return target


# ---------------------------------------------------------------------------
# 会话状态查询
# ---------------------------------------------------------------------------

_LOGIN_WINDOW_CLASSES = {
    "wechatloginwndforpc",
    "wechatlogindlgforpc",
    "weixinloginwnd",
    "weixinlogindlg",
}
_LOGIN_TITLE_HINTS = ("登录", "log in", "login")


def _looks_like_login_window(window: WindowInfo) -> bool:
    """登录窗口 / 登录提示窗口不是“已登录主窗口”。"""
    if window.class_name.lower() in _LOGIN_WINDOW_CLASSES:
        return True
    title = (window.title or "").lower()
    return any(hint in title for hint in _LOGIN_TITLE_HINTS)


def _query_session_connect_state() -> int | None:
    """查询当前 WTS 会话连接状态；失败返回 None（不阻断）。"""
    if not _IS_WINDOWS:
        return None
    try:
        wtsapi = ctypes.WinDLL("wtsapi32", use_last_error=True)
        buffer = ctypes.c_void_p()
        size = ctypes.c_ulong(0)
        wtsapi.WTSQuerySessionInformationW.argtypes = [
            ctypes.c_void_p,
            ctypes.c_ulong,
            ctypes.c_int,
            ctypes.POINTER(ctypes.c_void_p),
            ctypes.POINTER(ctypes.c_ulong),
        ]
        wtsapi.WTSQuerySessionInformationW.restype = ctypes.c_bool
        wtsapi.WTSFreeMemory.argtypes = [ctypes.c_void_p]
        if not wtsapi.WTSQuerySessionInformationW(None, _WTS_CURRENT_SESSION, _WTS_CONNECT_STATE, ctypes.byref(buffer), ctypes.byref(size)):
            return None
        if not buffer.value:
            return None
        try:
            return int(ctypes.cast(buffer, ctypes.POINTER(ctypes.c_int)).contents.value)
        finally:
            wtsapi.WTSFreeMemory(buffer)
    except Exception:
        return None


# ---------------------------------------------------------------------------
# PNG 编码（纯标准库，供截图与 Fake 驱动共用）
# ---------------------------------------------------------------------------


def _png_chunk(tag: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


def encode_png_rgb(width: int, height: int, rows: Iterable[bytes]) -> bytes:
    """把 RGB 行数据编码为 PNG；不依赖 Pillow。"""
    if width <= 0 or height <= 0:
        raise ValueError("PNG 尺寸必须为正数")
    raw = bytearray()
    count = 0
    for row in rows:
        if len(row) != width * 3:
            raise ValueError("RGB 行长度与宽度不匹配")
        raw.append(0)  # 过滤类型 0（None）
        raw.extend(row)
        count += 1
    if count != height:
        raise ValueError("RGB 行数与高度不匹配")
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + _png_chunk(b"IHDR", header)
        + _png_chunk(b"IDAT", zlib.compress(bytes(raw), 6))
        + _png_chunk(b"IEND", b"")
    )


def solid_png(width: int = 2, height: int = 2, color: tuple[int, int, int] = (255, 255, 255)) -> bytes:
    """生成纯色 PNG，用于 Fake 驱动与测试（不访问屏幕）。"""
    row = bytes(color) * width
    return encode_png_rgb(width, height, [row for _ in range(height)])
