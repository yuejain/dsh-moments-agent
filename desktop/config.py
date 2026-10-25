"""桌面执行器共享配置、错误码、路径安全与脱敏工具。

设计约束：
- 本模块不导入 pywinauto / comtypes，也不在 import 阶段调用 Windows API，
  这样在未安装 UI Automation 依赖的机器上仍可导入、可测试；
- 代码标识符使用英文，用户可见文案使用简体中文；
- 错误码与 docs/architecture/desktop-executor-protocol.md 第 4 节保持一致。
  额外补充三个“传输层/本地扩展”错误码（README 中已说明，不改变协议主表语义）：
  CANCELLED（取消进行中的 prepare）、NOT_FOUND（HTTP 404）、METHOD_NOT_ALLOWED（HTTP 405）。
- 路径安全：只允许访问显式配置的根目录内部；拒绝 ``..`` 逃逸、绝对路径越界、
  符号链接/重解析点、NTFS 备用数据流（ADS）。
"""
from __future__ import annotations

import dataclasses
import datetime as _dt
import json
import logging
import os
import re
import secrets
import stat
import subprocess
import locale
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Mapping

# ---------------------------------------------------------------------------
# 版本与协议常量
# ---------------------------------------------------------------------------

VERSION = "0.1.0"

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 18765
# 协议只允许回环地址；localhost 在内部统一映射为 127.0.0.1 绑定。
ALLOWED_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})
LOOPBACK_BIND_HOST = "127.0.0.1"

# 协议文档表格只列出 PREPARE_ONLY / APPROVAL_REQUIRED；
# POLICY_AUTONOMOUS 是 TypeScript 侧配置枚举的合法值，桌面执行器只把它当作
# “禁止点击发表”的模式（绝不放大权限）。
PUBLISH_MODES = frozenset({"PREPARE_ONLY", "APPROVAL_REQUIRED", "POLICY_AUTONOMOUS"})
CLI_PUBLISH_MODES = ("PREPARE_ONLY", "APPROVAL_REQUIRED", "POLICY_AUTONOMOUS")
PUBLISH_MODE_APPROVAL_REQUIRED = "APPROVAL_REQUIRED"

VISIBILITIES = frozenset({"PUBLIC", "PRIVATE", "PARTIAL"})
# 可见范围到微信中文界面文案的映射；PARTIAL 需要额外名单，真实驱动未实现时会拒绝。
VISIBILITY_LABELS = {
    "PUBLIC": ("公开", "公开可见", "所有朋友"),
    "PRIVATE": ("私密", "仅自己", "仅自己可见"),
    "PARTIAL": ("部分可见", "部分朋友", "指定朋友"),
}

# 契约中的错误码（第 4 节）。
PROTOCOL_ERROR_CODES = frozenset(
    {
        "UNAUTHORIZED",
        "BAD_REQUEST",
        "INTERACTIVE_DESKTOP_UNAVAILABLE",
        "WECHAT_NOT_RUNNING",
        "WECHAT_NOT_LOGGED_IN",
        "ACCOUNT_MISMATCH",
        "CLIENT_VERSION_UNSUPPORTED",
        "WINDOW_NOT_FOUND",
        "WINDOW_BLOCKED",
        "UPLOAD_FAILED",
        "CONTENT_CHANGED",
        "PREVIEW_NOT_FOUND",
        "PUBLISH_MODE_DISABLED",
        "APPROVAL_REQUIRED",
        "ALREADY_SUBMITTED",
        "UNCERTAIN",
        "EXECUTOR_BUSY",
        "INTERNAL_ERROR",
    }
)
EXTRA_ERROR_CODES = frozenset(
    {
        "CANCELLED",
        "NOT_FOUND",
        "METHOD_NOT_ALLOWED",
        # TypeScript 侧错误码：GUI Automation 依赖缺失或控件树未验证时使用。
        "DESKTOP_UNSUPPORTED",
        "UIA_UNAVAILABLE",
        # 几何驱动（opt-in）错误码：管理员权限 / OCR 不可用 / OCR 超时。
        "PRIVILEGE_REQUIRED",
        "OCR_UNAVAILABLE",
        "OCR_TIMEOUT",
    }
)
ALL_ERROR_CODES = PROTOCOL_ERROR_CODES | EXTRA_ERROR_CODES

# 错误码默认是否可重试（与协议表格一致）。
RETRYABLE_ERROR_CODES = frozenset(
    {
        "INTERACTIVE_DESKTOP_UNAVAILABLE",
        "WECHAT_NOT_RUNNING",
        "WECHAT_NOT_LOGGED_IN",
        "WINDOW_NOT_FOUND",
        "WINDOW_BLOCKED",
        "UPLOAD_FAILED",
        "EXECUTOR_BUSY",
        "CANCELLED",
        "OCR_TIMEOUT",
    }
)

# 驱动类型：uia（默认，RealWechatDriver）或 geometry（opt-in，微信 4.x 几何/像素）。
DRIVERS = frozenset({"uia", "geometry"})
GEOMETRY_DRIVER = "geometry"

# 输入边界
MAX_BODY_BYTES = 8 * 1024 * 1024
MAX_TEXT_LENGTH = 2000
MAX_ASSETS = 9
MAX_ID_LENGTH = 128
MAX_PATH_LENGTH = 1024
MAX_WARNINGS = 32
MAX_CONTENT_HASH_LENGTH = 64
TOKEN_MIN_LENGTH = 32

# 允许的标识符（taskId / attemptId / approvalId / accountId 的保守白名单）。
# 中文、空格、路径分隔符一律拒绝，避免拼接截图路径时逃逸或注入。
ID_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{1,%d}$" % MAX_ID_LENGTH)
CONTENT_HASH_PATTERN = re.compile(r"^[a-fA-F0-9]{64}$")
VERSION_PATTERN = re.compile(r"^\d+(?:\.\d+){1,3}$")

# 日志脱敏：以下字段名（或包含这些片段）的值绝不写入日志。
SENSITIVE_KEY_FRAGMENTS = (
    "token",
    "authorization",
    "secret",
    "password",
    "cookie",
    "text",
    "content",
    "body",
    "asset_paths",
    "assetpaths",
    "screenshot_dir",
)
RICH_LOG_TEXT_LIMIT = 120


# ---------------------------------------------------------------------------
# 异常与错误信封
# ---------------------------------------------------------------------------


class ConfigError(ValueError):
    """启动配置不合法（不得开始监听）。"""


class PathGuardError(ValueError):
    """请求中的路径越界或指向不允许的对象。"""


class ExecutorError(Exception):
    """带协议错误码的执行器异常；server.py 会把它转换成 JSON 失败信封。"""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        retryable: bool | None = None,
        details: Mapping[str, Any] | None = None,
    ) -> None:
        if code not in ALL_ERROR_CODES:
            # 这是开发期错误：未知错误码说明代码与协议不一致，尽早暴露。
            raise ValueError(f"未知错误码：{code}")
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = RETRYABLE_ERROR_CODES.__contains__(code) if retryable is None else bool(retryable)
        self.details = dict(details or {})

    def to_dict(self) -> dict[str, Any]:
        return {
            "errorCode": self.code,
            "message": self.message,
            "retryable": self.retryable,
        }

    def __str__(self) -> str:  # pragma: no cover - 调试用
        return f"[{self.code}] {self.message}"


# ---------------------------------------------------------------------------
# 共享数据模型（与 src/adapters/types.ts 对齐）
# ---------------------------------------------------------------------------


@dataclass
class WechatInstallation:
    """微信客户端安装信息；未找到可执行文件时 installed=False。"""

    installed: bool = False
    exe_path: str | None = None
    version: str | None = None
    notes: list[str] = field(default_factory=list)


@dataclass
class WechatStatus:
    """GET /wechat/status 的数据模型（camelCase 由 to_dict 输出）。"""

    running: bool = False
    logged_in: bool = False
    account_id: str | None = None
    version: str | None = None
    interactive: bool = True
    locked: bool = False
    supported: bool = False
    window_title: str | None = None
    dpi_scale: float | None = None
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "running": self.running,
            "loggedIn": self.logged_in,
            "accountId": self.account_id,
            "version": self.version,
            "interactive": self.interactive,
            "locked": self.locked,
            "supported": self.supported,
            "windowTitle": self.window_title,
            "dpiScale": self.dpi_scale,
            "notes": list(self.notes),
        }


@dataclass
class Verification:
    """发布后核验结果（对应 PublishVerification）。"""

    verified: bool = False
    method: str = "uia-list-readback"
    published_at: str | None = None
    visible_text: str | None = None
    image_count: int | None = None
    evidence_path: str | None = None
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "verified": self.verified,
            "method": self.method,
            "publishedAt": self.published_at,
            "visibleText": self.visible_text,
            "imageCount": self.image_count,
            "evidencePath": self.evidence_path,
            "notes": list(self.notes),
        }


# ---------------------------------------------------------------------------
# 启动配置
# ---------------------------------------------------------------------------


@dataclass
class ExecutorConfig:
    """桌面执行器启动配置。

    路径字段在 CLI 解析后统一转换为绝对路径；测试可直接构造并传临时目录。
    token 使用 repr=False，避免意外打印到日志。
    """

    host: str = DEFAULT_HOST
    port: int = DEFAULT_PORT
    mode: str = "PREPARE_ONLY"
    allow_publish: bool = False
    token: str | None = field(default=None, repr=False)
    token_file: str | None = None
    screenshot_dir: str = os.path.join("data", "desktop", "screenshots")
    asset_roots: tuple[str, ...] = (os.path.join("assets"),)
    log_file: str | None = os.path.join("data", "desktop", "executor.log")
    expected_account_id: str | None = None
    # 账号来源：uia（从微信 UI 读取，默认）或 wechatagent（由插件通过 WeChatAgent
    # Reader/Hook 验证后随请求传入；执行器仍要求与 expected_account_id 完全一致）。
    trusted_account_source: str = "uia"
    # 已人工确认的运行中客户端版本。设置后仅用于支持判定，不改变状态接口的探测结果。
    assumed_client_version: str | None = None
    # 只把真实人工验证过的客户端版本列为支持基线；未验证版本返回 supported=false。
    # 4.1.10.27 为声明基线；本机实测 4.1.15.13 不在列表内，因此 supported=false。
    supported_versions: tuple[str, ...] = ("4.1.10.27",)
    max_text_length: int = MAX_TEXT_LENGTH
    max_images: int = MAX_ASSETS
    # 同时兼容旧版微信（WeChat.exe）与 4.x 微信（Weixin.exe）。
    wechat_exe_names: tuple[str, ...] = ("WeChat.exe", "Weixin.exe")
    wechat_window_titles: tuple[str, ...] = ("微信", "WeChat", "Weixin")
    wechat_window_classes: tuple[str, ...] = (
        "WeChatMainWndForPC",
        "WeChatLoginWndForPC",
        "WeixinMainWndForPC",
        "Qt51514QWindowIcon",
    )
    # -- 微信 4.x 几何驱动（opt-in） --------------------------------------
    # 默认仍使用 UIA 驱动；geometry 必须显式 --driver geometry 才启用。
    driver: str = "uia"
    # geometry 模式点击发表需要额外显式授权，且仍受 allow_publish + 第二或第三档 约束。
    geometry_allow_publish: bool = False
    geometry_normalize_window: bool = True
    # 是否强制要求执行器自身具备管理员权限。默认 False = 自动：只有微信进程本身
    # 提权（UIPI 会拦截同完整性输入）时才要求管理员；微信未提权时允许同完整性驱动。
    geometry_require_admin: bool = False
    # OCR 使用 DSH Python 3.12 + desktop/.vendor（winsdk）；None 表示自动探测。
    ocr_python: str | None = None
    # 发布点击后的重试上限（0-2），仅在“编辑器仍打开且按钮仍存在”时允许。
    max_publish_click_retries: int = 1
    retry_backoff_seconds: float = 2.0
    # prepare 阶段（打开编辑器/粘贴）总尝试上限，<=3，只重试白名单可恢复错误。
    max_prepare_attempts: int = 3
    geometry_long_press_ms: int = 900
    geometry_wait_after_click: float = 1.5
    # 右键上下文菜单「粘贴」的安全 fallback 偏移（相对文本区点击点）。
    # 实测微信 4.1.10.27：菜单出现在光标右下方，「粘贴」项中心约 +(40, 34)。
    geometry_paste_fallback_offset: tuple[int, int] = (40, 34)
    geometry_ocr_timeout: float = 20.0
    status_timeout: float = 8.0
    prepare_timeout: float = 60.0
    click_timeout: float = 20.0
    verify_timeout: float = 15.0
    screenshot_timeout: float = 10.0

    # -- 派生属性 ---------------------------------------------------------

    @property
    def effective_allow_publish(self) -> bool:
        """只有显式 --allow-publish 且 mode 为 APPROVAL_REQUIRED 或 POLICY_AUTONOMOUS 才允许点击发表。"""
        return bool(self.allow_publish) and self.mode in (PUBLISH_MODE_APPROVAL_REQUIRED, "POLICY_AUTONOMOUS")

    @property
    def effective_geometry_publish(self) -> bool:
        """geometry 发布权限：在通用发布权限之上再要求 --geometry-allow-publish。"""
        return self.effective_allow_publish and bool(self.geometry_allow_publish)

    @property
    def bind_host(self) -> str:
        """实际绑定的回环地址；localhost/::1 统一收敛到 127.0.0.1。"""
        return LOOPBACK_BIND_HOST

    def validate(self) -> None:
        """校验配置；不合法时抛 ConfigError，调用方必须拒绝启动。"""
        host = (self.host or "").strip().lower()
        if host not in ALLOWED_HOSTS:
            raise ConfigError(
                f"拒绝绑定非回环地址 {self.host!r}：桌面执行器只允许 127.0.0.1 / localhost"
            )
        if not isinstance(self.port, int) or isinstance(self.port, bool):
            raise ConfigError("端口必须是整数")
        if self.port < 0 or self.port > 65535:
            raise ConfigError("端口必须在 0 到 65535 之间")
        mode = (self.mode or "").strip().upper()
        if mode not in PUBLISH_MODES:
            raise ConfigError(
                f"未知发布模式 {self.mode!r}；只允许 {', '.join(sorted(PUBLISH_MODES))}"
            )
        self.mode = mode
        if self.token is not None:
            validate_token(self.token)
        for name, value in (
            ("screenshot_dir", self.screenshot_dir),
            ("log_file", self.log_file),
        ):
            if value is not None:
                _validate_path_string(value, name)
        if not isinstance(self.asset_roots, (tuple, list)) or not self.asset_roots:
            raise ConfigError("asset_roots 必须是非空列表")
        for root in self.asset_roots:
            _validate_path_string(root, "asset_roots[]")
        if self.expected_account_id is not None:
            account = self.expected_account_id.strip()
            if not account:
                self.expected_account_id = None
            elif len(account) > MAX_ID_LENGTH:
                raise ConfigError("expected_account_id 过长")
            else:
                self.expected_account_id = account
        for version in self.supported_versions:
            if not VERSION_PATTERN.match(version):
                raise ConfigError(f"supported_versions 中的版本号格式非法：{version!r}")
        source = (self.trusted_account_source or "uia").strip().lower()
        if source not in ("uia", "wechatagent"):
            raise ConfigError("trusted_account_source 必须是 uia 或 wechatagent")
        self.trusted_account_source = source
        if source == "wechatagent" and not self.expected_account_id:
            raise ConfigError("trusted_account_source=wechatagent 时必须配置 expected_account_id")
        if self.assumed_client_version is not None:
            assumed = self.assumed_client_version.strip()
            if not assumed:
                self.assumed_client_version = None
            elif not VERSION_PATTERN.match(assumed):
                raise ConfigError(f"assumed_client_version 版本号格式非法：{assumed!r}")
            elif assumed not in tuple(self.supported_versions):
                raise ConfigError("assumed_client_version 必须包含在 supported_versions 中，先完成人工验证")
            else:
                self.assumed_client_version = assumed
        driver = (self.driver or "uia").strip().lower()
        if driver not in DRIVERS:
            raise ConfigError(f"driver 必须是 uia 或 geometry，收到 {self.driver!r}")
        self.driver = driver
        if not isinstance(self.geometry_allow_publish, bool):
            raise ConfigError("geometry_allow_publish 必须是布尔值")
        if not isinstance(self.geometry_normalize_window, bool):
            raise ConfigError("geometry_normalize_window 必须是布尔值")
        if not isinstance(self.geometry_require_admin, bool):
            raise ConfigError("geometry_require_admin 必须是布尔值")
        if self.ocr_python is not None:
            ocr_python = str(self.ocr_python).strip()
            if not ocr_python:
                self.ocr_python = None
            else:
                _validate_path_string(ocr_python, "ocr_python")
                self.ocr_python = ocr_python
        if not isinstance(self.max_publish_click_retries, int) or isinstance(self.max_publish_click_retries, bool):
            raise ConfigError("max_publish_click_retries 必须是整数")
        if not (0 <= self.max_publish_click_retries <= 2):
            raise ConfigError("max_publish_click_retries 必须在 0 到 2 之间")
        if not isinstance(self.retry_backoff_seconds, (int, float)) or isinstance(self.retry_backoff_seconds, bool):
            raise ConfigError("retry_backoff_seconds 必须是数字")
        if not (0.0 <= float(self.retry_backoff_seconds) <= 60.0):
            raise ConfigError("retry_backoff_seconds 必须在 0 到 60 秒之间")
        self.retry_backoff_seconds = float(self.retry_backoff_seconds)
        if not isinstance(self.max_prepare_attempts, int) or isinstance(self.max_prepare_attempts, bool):
            raise ConfigError("max_prepare_attempts 必须是整数")
        if not (1 <= self.max_prepare_attempts <= 3):
            raise ConfigError("max_prepare_attempts 必须在 1 到 3 之间")
        if not isinstance(self.geometry_long_press_ms, int) or isinstance(self.geometry_long_press_ms, bool):
            raise ConfigError("geometry_long_press_ms 必须是整数")
        if not (900 <= self.geometry_long_press_ms <= 5000):
            raise ConfigError("geometry_long_press_ms 必须在 900 到 5000 毫秒之间")
        if not isinstance(self.geometry_wait_after_click, (int, float)) or isinstance(self.geometry_wait_after_click, bool):
            raise ConfigError("geometry_wait_after_click 必须是数字")
        if not (0.2 <= float(self.geometry_wait_after_click) <= 30.0):
            raise ConfigError("geometry_wait_after_click 必须在 0.2 到 30 秒之间")
        self.geometry_wait_after_click = float(self.geometry_wait_after_click)
        offset = self.geometry_paste_fallback_offset
        if not isinstance(offset, (tuple, list)) or len(offset) != 2:
            raise ConfigError("geometry_paste_fallback_offset 必须是 [x, y] 两个整数")
        offset_x, offset_y = offset
        if any(not isinstance(item, int) or isinstance(item, bool) or not (0 <= item <= 500) for item in (offset_x, offset_y)):
            raise ConfigError("geometry_paste_fallback_offset 的坐标必须是 0 到 500 的整数")
        self.geometry_paste_fallback_offset = (int(offset_x), int(offset_y))
        if not isinstance(self.geometry_ocr_timeout, (int, float)) or isinstance(self.geometry_ocr_timeout, bool):
            raise ConfigError("geometry_ocr_timeout 必须是数字")
        if not (1.0 <= float(self.geometry_ocr_timeout) <= 120.0):
            raise ConfigError("geometry_ocr_timeout 必须在 1 到 120 秒之间")
        self.geometry_ocr_timeout = float(self.geometry_ocr_timeout)
        for name, value in (
            ("status_timeout", self.status_timeout),
            ("prepare_timeout", self.prepare_timeout),
            ("click_timeout", self.click_timeout),
            ("verify_timeout", self.verify_timeout),
            ("screenshot_timeout", self.screenshot_timeout),
        ):
            if not isinstance(value, (int, float)) or isinstance(value, bool) or not (0.1 <= value <= 600):
                raise ConfigError(f"{name} 必须是 0.1 到 600 之间的秒数")
        if not (1 <= int(self.max_text_length) <= MAX_TEXT_LENGTH):
            raise ConfigError(f"max_text_length 必须在 1 到 {MAX_TEXT_LENGTH} 之间")
        if not (0 <= int(self.max_images) <= MAX_ASSETS):
            raise ConfigError(f"max_images 必须在 0 到 {MAX_ASSETS} 之间")


def validate_token(token: str) -> str:
    """token 至少 32 个字符；缺失/过短一律拒绝（不回显内容）。"""
    if not isinstance(token, str):
        raise ConfigError("token 必须是字符串")
    value = token.strip()
    if len(value) < TOKEN_MIN_LENGTH:
        raise ConfigError(f"token 长度不足 {TOKEN_MIN_LENGTH} 个字符，拒绝启动")
    if any(ch.isspace() for ch in value):
        raise ConfigError("token 不允许包含空白字符")
    return value


def _validate_path_string(value: str, name: str) -> None:
    if not isinstance(value, str) or not value.strip():
        raise ConfigError(f"{name} 不能为空")
    if len(value) > MAX_PATH_LENGTH:
        raise ConfigError(f"{name} 过长（最多 {MAX_PATH_LENGTH} 字符）")
    if "\x00" in value:
        raise ConfigError(f"{name} 包含非法空字符")
    if _has_alternate_data_stream(value):
        raise ConfigError(f"{name} 不允许包含 NTFS 备用数据流（ADS）")


# ---------------------------------------------------------------------------
# 路径安全
# ---------------------------------------------------------------------------


def _has_alternate_data_stream(path: str) -> bool:
    """检测 Windows 备用数据流语法（如 ``C:\\a\\b:evil``）。"""
    if os.name != "nt":
        return False
    drive, rest = os.path.splitdrive(path)
    if not drive:
        return False
    return ":" in rest


def normalize_path(path: str) -> str:
    """把路径规范化为绝对路径；不解析符号链接（解析会掩盖越界目标）。"""
    if not isinstance(path, str):
        raise PathGuardError("路径必须是字符串")
    if not path.strip():
        raise PathGuardError("路径不能为空")
    if len(path) > MAX_PATH_LENGTH:
        raise PathGuardError(f"路径过长（最多 {MAX_PATH_LENGTH} 字符）")
    if "\x00" in path:
        raise PathGuardError("路径包含非法空字符")
    if _has_alternate_data_stream(path):
        raise PathGuardError("路径包含不允许的 NTFS 备用数据流")
    try:
        return os.path.abspath(os.path.normpath(path))
    except (OSError, ValueError) as exc:  # pragma: no cover - 极端平台差异
        raise PathGuardError(f"路径无法规范化：{exc}") from exc


def _normcase(path: str) -> str:
    return os.path.normcase(os.path.abspath(path))


def is_within(root: str, candidate: str) -> bool:
    """candidate 是否位于 root 内部（含 root 本身），Windows 下大小写不敏感。"""
    try:
        root_n = _normcase(normalize_path(root))
        cand_n = _normcase(normalize_path(candidate))
    except PathGuardError:
        return False
    if cand_n == root_n:
        return True
    try:
        return os.path.commonpath([root_n, cand_n]) == root_n
    except ValueError:  # 不同驱动器
        return False


def _exists(path: str) -> bool:
    try:
        os.lstat(path)
        return True
    except OSError:
        return False


def _is_reparse_point(path: str) -> bool:
    """符号链接 / 目录联接 / 其他重解析点一律视为不安全。"""
    try:
        os.lstat(path)
    except OSError:
        return False
    if os.path.islink(path):
        return True
    if os.name != "nt":
        return False
    try:
        attrs = getattr(os.lstat(path), "st_file_attributes", 0)
    except OSError:
        return False
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return bool(attrs & reparse_flag)


def assert_no_reparse_chain(root: str, candidate: str) -> None:
    """从 root 到 candidate 逐层检查重解析点；存在即拒绝。"""
    root_abs = normalize_path(root)
    target = normalize_path(candidate)
    if not is_within(root_abs, target):
        raise PathGuardError("路径越界：不在允许的根目录内")
    current = target
    while True:
        if _is_reparse_point(current):
            raise PathGuardError("拒绝访问符号链接/重解析点路径")
        if _normcase(current) == _normcase(root_abs):
            return
        parent = os.path.dirname(current)
        if parent == current:  # 到达根仍未遇到配置根目录，说明不在其内
            raise PathGuardError("路径越界：不在允许的根目录内")
        current = parent


def resolve_under(
    roots: Iterable[str],
    candidate: str,
    *,
    must_exist_file: bool = False,
    must_exist_dir: bool = False,
) -> str:
    """把 candidate 解析到某个允许根目录内部，并做存在性/类型/重解析点校验。

    返回绝对路径；任何越界或非法对象抛 PathGuardError。
    """
    roots = tuple(roots)
    if not roots:
        raise PathGuardError("未配置任何允许的根目录")
    target = normalize_path(candidate)
    matched: str | None = None
    for root in roots:
        try:
            if is_within(root, target):
                matched = normalize_path(root)
                break
        except PathGuardError:
            continue
    if matched is None:
        raise PathGuardError("路径越界：不在允许的根目录内")
    # candidate 自身若不存在，仍需检查已存在的父目录，避免中间层符号链接。
    probe = target
    while not _exists(probe) and os.path.dirname(probe) != probe:
        probe = os.path.dirname(probe)
    assert_no_reparse_chain(matched, probe)
    if must_exist_file and not os.path.isfile(target):
        raise PathGuardError("目标文件不存在或不是普通文件")
    if must_exist_dir and not os.path.isdir(target):
        raise PathGuardError("目标目录不存在")
    return target


def ensure_directory_under(roots: Iterable[str], candidate: str) -> str:
    """在允许的根目录内创建目录（含父目录）；返回绝对路径。"""
    target = resolve_under(roots, candidate)
    # 创建前再次确认父链无重解析点；创建后再校验一次，防御 TOCTOU 简单场景。
    assert_no_reparse_chain(next(iter(_normalized_roots(roots))), target if _exists(target) else os.path.dirname(target) or target)
    try:
        os.makedirs(target, exist_ok=True)
    except OSError as exc:
        raise PathGuardError(f"无法创建目录：{exc}") from exc
    if not os.path.isdir(target):
        raise PathGuardError("目标路径不是目录")
    return target


def _normalized_roots(roots: Iterable[str]) -> tuple[str, ...]:
    return tuple(normalize_path(root) for root in roots)


def safe_filename_component(value: str, *, name: str = "attemptId") -> str:
    """校验并返回可安全用于文件名的标识符。"""
    if not isinstance(value, str) or not ID_PATTERN.match(value):
        raise PathGuardError(f"{name} 不合法（只允许字母、数字、._:-，最长 {MAX_ID_LENGTH}）")
    return value


# ---------------------------------------------------------------------------
# token 文件
# ---------------------------------------------------------------------------


def _current_user_principal() -> str | None:
    """返回 ``DOMAIN\\user`` 形式的当前用户，用于 icacls 授权。"""
    try:
        result = subprocess.run(
            ["whoami"],
            capture_output=True,
            text=True,
            encoding=locale.getencoding(), errors="replace",
            timeout=5,
            check=False,
        )
        value = (result.stdout or "").strip().splitlines()
        if value and value[0]:
            return value[0].strip()
    except (OSError, subprocess.SubprocessError):
        pass
    return os.environ.get("USERNAME") or None


def restrict_file_permissions(path: str, *, logger: logging.Logger | None = None) -> None:
    """把文件权限限制为当前用户：Windows 用 icacls，其他平台用 chmod。

    失败只记录日志，不阻断启动（协议要求“失败仅记录不阻断”）。
    """
    log = logger or logging.getLogger(__name__)
    try:
        os.chmod(path, 0o600)
    except OSError as exc:
        log.warning("无法通过 os.chmod 收紧文件权限：%s", exc)
    if os.name != "nt":
        return
    principal = _current_user_principal()
    if not principal:
        log.warning("无法确定当前 Windows 用户，跳过 icacls 权限收紧")
        return
    try:
        result = subprocess.run(
            ["icacls", path, "/inheritance:r", "/grant:r", f"{principal}:F"],
            capture_output=True,
            text=True,
            encoding=locale.getencoding(), errors="replace",
            timeout=10,
            check=False,
        )
        if result.returncode != 0:
            log.warning("icacls 收紧权限失败（returncode=%s），继续启动", result.returncode)
    except (OSError, subprocess.SubprocessError) as exc:
        log.warning("调用 icacls 失败（%s），继续启动", exc)


def read_token_file(path: str) -> str:
    try:
        raw = Path(path).read_text(encoding="utf-8-sig")
    except OSError as exc:
        raise ConfigError(f"无法读取 token 文件：{exc}") from exc
    return validate_token(raw)


def write_token_file(path: str, token: str, *, logger: logging.Logger | None = None) -> None:
    target = Path(path)
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(token + "\n", encoding="utf-8")
    except OSError as exc:
        raise ConfigError(f"无法写入 token 文件：{exc}") from exc
    restrict_file_permissions(str(target), logger=logger)


def load_or_create_token(
    token_file: str | None,
    *,
    env_token: str | None = None,
    logger: logging.Logger | None = None,
) -> str:
    """读取或生成 token。

    优先级：已存在的 token 文件 > 环境变量 > 生成并写入 token 文件。
    若显式给了 token_file 且文件不存在，则自动生成写入（协议要求）。
    """
    log = logger or logging.getLogger(__name__)
    if token_file and os.path.exists(token_file):
        return read_token_file(token_file)
    if env_token:
        return validate_token(env_token)
    if not token_file:
        raise ConfigError("未提供 token 文件，也没有 DSH_MOMENTS_DESKTOP_TOKEN 环境变量")
    token = secrets.token_hex(32)  # 32 字节随机数 -> 64 位十六进制
    write_token_file(token_file, token, logger=log)
    log.info("已自动生成桌面执行器 token 文件（内容不写入日志）")
    return token


# ---------------------------------------------------------------------------
# 脱敏与日志
# ---------------------------------------------------------------------------


def redact_value(value: Any, *, key: str = "") -> Any:
    """按字段名/类型脱敏单个日志值。"""
    lowered = key.lower()
    if any(fragment in lowered for fragment in SENSITIVE_KEY_FRAGMENTS):
        return "***"
    if isinstance(value, str):
        # 形似 token 的长十六进制串也脱敏，避免调用方把 token 塞进 message。
        if re.fullmatch(r"[A-Fa-f0-9]{32,}", value):
            return "***"
        if len(value) > RICH_LOG_TEXT_LIMIT:
            return value[:RICH_LOG_TEXT_LIMIT] + "…"
        return value
    if isinstance(value, Mapping):
        return {str(k): redact_value(v, key=str(k)) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [redact_value(item) for item in value]
    return value


def redact_meta(meta: Mapping[str, Any] | None) -> dict[str, Any]:
    if not meta:
        return {}
    return {str(key): redact_value(value, key=str(key)) for key, value in meta.items()}


def redact_text(text: str, token: str | None = None) -> str:
    """从任意文案中移除 token；用于错误消息与日志兜底。"""
    if token:
        text = text.replace(token, "***")
    return text


def describe_config(config: ExecutorConfig) -> dict[str, Any]:
    """安全配置摘要：绝不包含 token 内容。"""
    return {
        "version": VERSION,
        "host": config.host,
        "port": config.port,
        "mode": config.mode,
        "allowPublish": config.allow_publish,
        "effectiveAllowPublish": config.effective_allow_publish,
        "screenshotDir": config.screenshot_dir,
        "assetRoots": list(config.asset_roots),
        "expectedAccountConfigured": bool(config.expected_account_id),
        "trustedAccountSource": config.trusted_account_source,
        "assumedClientVersion": config.assumed_client_version,
        "supportedVersions": list(config.supported_versions),
        "driver": config.driver,
        "geometryAllowPublish": config.geometry_allow_publish,
        "geometryNormalizeWindow":config.geometry_normalize_window,
        "geometryRequireAdmin": config.geometry_require_admin,
        "standardWindowSize": [1200, 900],
        "windowNormalizeMode": "physical-pixels",
        "pasteFallbackOffset": list(config.geometry_paste_fallback_offset),
        "effectiveGeometryPublish": config.effective_geometry_publish,
        "ocrPythonConfigured": bool(config.ocr_python),
        "maxPublishClickRetries": config.max_publish_click_retries,
        "retryBackoffSeconds": config.retry_backoff_seconds,
        "uiaDependency": "未检测（由驱动在运行时惰性导入）",
    }


# ---------------------------------------------------------------------------
# 时间工具
# ---------------------------------------------------------------------------


def utc_now() -> _dt.datetime:
    return _dt.datetime.now(tz=_dt.timezone.utc)


def utc_now_iso() -> str:
    return utc_now().isoformat(timespec="seconds").replace("+00:00", "Z")


def normalize_text(value: str) -> str:
    """正文比对归一化：统一换行、去掉每行尾部空白与首尾空白。

    与 ``src/domain/ids.ts`` 的 ``normalizeText`` 保持一致，避免两侧比对口径不同。
    """
    if not isinstance(value, str):
        return ""
    lines = value.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    return "\n".join(line.rstrip(" \t") for line in lines).strip()


# ---------------------------------------------------------------------------
# 配置文件（JSON）
# ---------------------------------------------------------------------------

_FLAT_KEY_ALIASES = {
    "host": "host",
    "port": "port",
    "mode": "mode",
    "allowpublish": "allow_publish",
    "allow_publish": "allow_publish",
    "tokenfile": "token_file",
    "token_file": "token_file",
    "screenshotdir": "screenshot_dir",
    "screenshot_dir": "screenshot_dir",
    "assetroots": "asset_roots",
    "asset_roots": "asset_roots",
    "assetroot": "asset_roots",
    "asset_root": "asset_roots",
    "logfile": "log_file",
    "log_file": "log_file",
    "expectedaccountid": "expected_account_id",
    "expected_account_id": "expected_account_id",
    "trustedaccountsource": "trusted_account_source",
    "trusted_account_source": "trusted_account_source",
    "assumedclientversion": "assumed_client_version",
    "assumed_client_version": "assumed_client_version",
    "supportedversions": "supported_versions",
    "supported_versions": "supported_versions",
    "maxtextlength": "max_text_length",
    "max_text_length": "max_text_length",
    "maximages": "max_images",
    "max_images": "max_images",
    "statustimeout": "status_timeout",
    "status_timeout": "status_timeout",
    "preparetimeout": "prepare_timeout",
    "prepare_timeout": "prepare_timeout",
    "clicktimeout": "click_timeout",
    "click_timeout": "click_timeout",
    "verifytimeout": "verify_timeout",
    "verify_timeout": "verify_timeout",
    "screenshottimeout": "screenshot_timeout",
    "screenshot_timeout": "screenshot_timeout",
    "wechatexenames": "wechat_exe_names",
    "wechat_exe_names": "wechat_exe_names",
    "wechatwindowtitles": "wechat_window_titles",
    "wechat_window_titles": "wechat_window_titles",
    "wechatwindowclasses": "wechat_window_classes",
    "wechat_window_classes": "wechat_window_classes",
    # 微信 4.x 几何驱动（opt-in）
    "driver": "driver",
    "geometryallowpublish": "geometry_allow_publish",
    "geometry_allow_publish": "geometry_allow_publish",
    "geometrynormalizewindow": "geometry_normalize_window",
    "geometry_normalize_window": "geometry_normalize_window",
    "geometryrequireadmin": "geometry_require_admin",
    "geometry_require_admin": "geometry_require_admin",
    "ocrpython": "ocr_python",
    "ocr_python": "ocr_python",
    "maxpublishclickretries": "max_publish_click_retries",
    "max_publish_click_retries": "max_publish_click_retries",
    "retrybackoffseconds": "retry_backoff_seconds",
    "retry_backoff_seconds": "retry_backoff_seconds",
    "maxprepareattempts": "max_prepare_attempts",
    "max_prepare_attempts": "max_prepare_attempts",
    "geometrylongpressms": "geometry_long_press_ms",
    "geometry_long_press_ms": "geometry_long_press_ms",
    "geometrywaitafterclick": "geometry_wait_after_click",
    "geometry_wait_after_click": "geometry_wait_after_click",
    "geometrypastefallbackoffset": "geometry_paste_fallback_offset",
    "geometry_paste_fallback_offset": "geometry_paste_fallback_offset",
    "geometryocrtimeout": "geometry_ocr_timeout",
    "geometry_ocr_timeout": "geometry_ocr_timeout",
}


def _as_bool(value: Any, name: str) -> bool:
    if isinstance(value, bool):
        return value
    raise ConfigError(f"配置项 {name} 必须是布尔值")


def _as_str(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ConfigError(f"配置项 {name} 必须是非空字符串")
    return value.strip()


def _as_str_list(value: Any, name: str) -> tuple[str, ...]:
    if isinstance(value, str):
        return (value,)
    if not isinstance(value, (list, tuple)):
        raise ConfigError(f"配置项 {name} 必须是字符串数组")
    result: list[str] = []
    for item in value:
        if not isinstance(item, str) or not item.strip():
            raise ConfigError(f"配置项 {name} 的元素必须是非空字符串")
        result.append(item.strip())
    return tuple(result)


def _parse_base_url(url: str) -> int | None:
    """从 desktopExecutor.baseUrl 提取端口；只接受回环 http。"""
    from urllib.parse import urlparse

    parsed = urlparse(url)
    if parsed.scheme != "http":
        raise ConfigError("desktopExecutor.baseUrl 只允许 http 协议")
    if parsed.hostname not in ALLOWED_HOSTS:
        raise ConfigError("desktopExecutor.baseUrl 只允许回环地址")
    try:
        return parsed.port or 80
    except ValueError as exc:
        raise ConfigError("desktopExecutor.baseUrl 端口非法") from exc


def _resolve_config_path(value: str, base_dir: str) -> str:
    if os.path.isabs(value):
        return os.path.abspath(value)
    return os.path.abspath(os.path.join(base_dir, value))


def config_from_mapping(raw: Mapping[str, Any], *, base_dir: str | None = None) -> ExecutorConfig:
    """把 JSON 对象解析为 ExecutorConfig。

    兼容两种形态：
    1. 扁平执行器配置：``{"host": ..., "port": ..., "mode": ...}``；
    2. 插件 MomentsConfig：``{"publishMode": ..., "dataDir": ..., "desktopExecutor": {...},
       "wechatAgent": {"account": ...}, "images": {"assetDir": ...}, "policy": {...}}``。

    配置内的相对路径按**启动时工作目录**解析（与 CLI 参数一致），而不是配置文件所在目录，
    这样 ``--config config/desktop-executor.example.json`` 中的 ``data/...`` 会落到仓库根目录。
    """
    if not isinstance(raw, Mapping):
        raise ConfigError("配置文件根节点必须是 JSON 对象")
    base = os.path.abspath(base_dir or os.getcwd())
    nested = any(key in raw for key in ("desktopExecutor", "publishMode", "wechatAgent", "policy", "dataDir", "images"))
    if nested:
        return _config_from_nested_moments(raw, base)
    return _config_from_flat(raw, base)


def _config_from_flat(raw: Mapping[str, Any], base: str) -> ExecutorConfig:
    values: dict[str, Any] = {}
    for key, value in raw.items():
        alias = _FLAT_KEY_ALIASES.get(str(key).lower())
        if alias is None:
            continue
        if alias == "host":
            values[alias] = _as_str(value, key)
        elif alias == "port":
            if not isinstance(value, int) or isinstance(value, bool):
                raise ConfigError("配置项 port 必须是整数")
            values[alias] = value
        elif alias == "mode":
            values[alias] = _as_str(value, key).upper()
        elif alias == "allow_publish":
            values[alias] = _as_bool(value, key)
        elif alias in ("token_file", "log_file", "screenshot_dir", "expected_account_id", "trusted_account_source", "assumed_client_version", "ocr_python"):
            values[alias] = _as_str(value, key)
        elif alias == "driver":
            values[alias] = _as_str(value, key).lower()
        elif alias in ("geometry_allow_publish", "geometry_normalize_window", "geometry_require_admin"):
            values[alias] = _as_bool(value, key)
        elif alias in ("max_publish_click_retries", "max_prepare_attempts", "geometry_long_press_ms"):
            if not isinstance(value, int) or isinstance(value, bool):
                raise ConfigError(f"配置项 {key} 必须是整数")
            values[alias] = value
        elif alias in ("retry_backoff_seconds", "geometry_wait_after_click"):
            if not isinstance(value, (int, float)) or isinstance(value, bool):
                raise ConfigError(f"配置项 {key} 必须是数字")
            values[alias] = float(value)
        elif alias == "geometry_paste_fallback_offset":
            if not isinstance(value, (list, tuple)) or len(value) != 2:
                raise ConfigError(f"配置项 {key} 必须是 [x, y] 两个整数")
            values[alias] = (int(value[0]), int(value[1]))
        elif alias in ("asset_roots", "supported_versions", "wechat_exe_names", "wechat_window_titles", "wechat_window_classes"):
            values[alias] = _as_str_list(value, key)
        elif alias in ("max_text_length", "max_images"):
            if not isinstance(value, int) or isinstance(value, bool):
                raise ConfigError(f"配置项 {key} 必须是整数")
            values[alias] = value
        elif alias.endswith("_timeout"):
            if not isinstance(value, (int, float)) or isinstance(value, bool):
                raise ConfigError(f"配置项 {key} 必须是数字")
            values[alias] = float(value)
    for key in ("token_file", "screenshot_dir", "log_file"):
        if key in values and values[key]:
            values[key] = _resolve_config_path(values[key], base)
    for key in ("asset_roots",):
        if key in values:
            values[key] = tuple(_resolve_config_path(item, base) for item in values[key])
    return ExecutorConfig(**values)


def _config_from_nested_moments(raw: Mapping[str, Any], base: str) -> ExecutorConfig:
    desktop = raw.get("desktopExecutor")
    if desktop is None:
        desktop = {}
    if not isinstance(desktop, Mapping):
        raise ConfigError("desktopExecutor 必须是 JSON 对象")
    wechat = raw.get("wechatAgent") if isinstance(raw.get("wechatAgent"), Mapping) else {}
    images = raw.get("images") if isinstance(raw.get("images"), Mapping) else {}
    policy = raw.get("policy") if isinstance(raw.get("policy"), Mapping) else {}
    data_dir = raw.get("dataDir") if isinstance(raw.get("dataDir"), str) and raw.get("dataDir").strip() else "data"

    values: dict[str, Any] = {}
    if desktop.get("host") is not None:
        values["host"] = _as_str(desktop["host"], "desktopExecutor.host")
    if desktop.get("port") is not None:
        if not isinstance(desktop["port"], int) or isinstance(desktop["port"], bool):
            raise ConfigError("desktopExecutor.port 必须是整数")
        values["port"] = desktop["port"]
    base_url = desktop.get("baseUrl")
    if isinstance(base_url, str) and "port" not in values:
        port = _parse_base_url(base_url)
        if port is not None:
            values["port"] = port
    if desktop.get("mode") is not None:
        values["mode"] = _as_str(desktop["mode"], "desktopExecutor.mode").upper()
    elif raw.get("publishMode") is not None:
        values["mode"] = _as_str(raw["publishMode"], "publishMode").upper()
    if desktop.get("allowPublish") is not None:
        values["allow_publish"] = _as_bool(desktop["allowPublish"], "desktopExecutor.allowPublish")
    elif raw.get("allowPublish") is not None:
        values["allow_publish"] = _as_bool(raw["allowPublish"], "allowPublish")
    if desktop.get("tokenFile") is not None:
        values["token_file"] = _resolve_config_path(_as_str(desktop["tokenFile"], "desktopExecutor.tokenFile"), base)
    if desktop.get("screenshotDir") is not None:
        values["screenshot_dir"] = _resolve_config_path(
            _as_str(desktop["screenshotDir"], "desktopExecutor.screenshotDir"), base
        )
    else:
        values["screenshot_dir"] = _resolve_config_path(os.path.join(data_dir, "desktop", "screenshots"), base)
    if desktop.get("logFile") is not None:
        values["log_file"] = _resolve_config_path(_as_str(desktop["logFile"], "desktopExecutor.logFile"), base)
    else:
        values["log_file"] = _resolve_config_path(os.path.join(data_dir, "desktop", "executor.log"), base)

    roots: list[str] = []
    if desktop.get("assetRoots") is not None:
        roots.extend(_as_str_list(desktop["assetRoots"], "desktopExecutor.assetRoots"))
    if isinstance(images.get("assetDir"), str) and images["assetDir"].strip():
        roots.append(images["assetDir"].strip())
    if not roots:
        roots = [os.path.join("assets")]
    values["asset_roots"] = tuple(_resolve_config_path(item, base) for item in roots)

    expected = desktop.get("expectedAccountId")
    if expected is None and isinstance(wechat.get("account"), str) and wechat["account"].strip():
        expected = wechat["account"].strip()
    if expected is not None:
        values["expected_account_id"] = _as_str(expected, "expectedAccountId")
    versions = desktop.get("supportedVersions")
    if versions is not None:
        values["supported_versions"] = _as_str_list(versions, "desktopExecutor.supportedVersions")
    if desktop.get("trustedAccountSource") is not None:
        values["trusted_account_source"] = _as_str(
            desktop["trustedAccountSource"], "desktopExecutor.trustedAccountSource"
        ).lower()
    if desktop.get("assumedClientVersion") is not None:
        values["assumed_client_version"] = _as_str(
            desktop["assumedClientVersion"], "desktopExecutor.assumedClientVersion"
        )
    if desktop.get("driver") is not None:
        values["driver"] = _as_str(desktop["driver"], "desktopExecutor.driver").lower()
    if desktop.get("geometryAllowPublish") is not None:
        values["geometry_allow_publish"] = _as_bool(
            desktop["geometryAllowPublish"], "desktopExecutor.geometryAllowPublish"
        )
    if desktop.get("ocrPython") is not None:
        values["ocr_python"] = _as_str(desktop["ocrPython"], "desktopExecutor.ocrPython")
    if desktop.get("geometryNormalizeWindow") is not None:
        values['geometry_normalize_window'] = _as_bool(desktop['geometryNormalizeWindow'],'desktopExecutor.geometryNormalizeWindow')
    if desktop.get("geometryRequireAdmin") is not None:
        values["geometry_require_admin"] = _as_bool(
            desktop["geometryRequireAdmin"], "desktopExecutor.geometryRequireAdmin"
        )
    for source_key, target_key in (
        ("maxPublishClickRetries", "max_publish_click_retries"),
        ("maxPrepareAttempts", "max_prepare_attempts"),
        ("geometryLongPressMs", "geometry_long_press_ms"),
    ):
        if desktop.get(source_key) is not None:
            if not isinstance(desktop[source_key], int) or isinstance(desktop[source_key], bool):
                raise ConfigError(f"desktopExecutor.{source_key} 必须是整数")
            values[target_key] = desktop[source_key]
    for source_key, target_key in (
        ("retryBackoffSeconds", "retry_backoff_seconds"),
        ("geometryWaitAfterClick", "geometry_wait_after_click"),
        ("geometryOcrTimeout", "geometry_ocr_timeout"),
    ):
        if desktop.get(source_key) is not None:
            if not isinstance(desktop[source_key], (int, float)) or isinstance(desktop[source_key], bool):
                raise ConfigError(f"desktopExecutor.{source_key} 必须是数字")
            values[target_key] = float(desktop[source_key])
    if desktop.get("geometryPasteFallbackOffset") is not None:
        offset = desktop["geometryPasteFallbackOffset"]
        if not isinstance(offset, (list, tuple)) or len(offset) != 2:
            raise ConfigError("desktopExecutor.geometryPasteFallbackOffset 必须是 [x, y] 两个整数")
        values["geometry_paste_fallback_offset"] = (int(offset[0]), int(offset[1]))
    if policy.get("maxTextLength") is not None:
        if not isinstance(policy["maxTextLength"], int):
            raise ConfigError("policy.maxTextLength 必须是整数")
        values["max_text_length"] = policy["maxTextLength"]
    if policy.get("maxImages") is not None:
        if not isinstance(policy["maxImages"], int):
            raise ConfigError("policy.maxImages 必须是整数")
        values["max_images"] = policy["maxImages"]
    timeouts = desktop.get("timeouts")
    if isinstance(timeouts, Mapping):
        mapping = {
            "status": "status_timeout",
            "prepare": "prepare_timeout",
            "click": "click_timeout",
            "verify": "verify_timeout",
            "screenshot": "screenshot_timeout",
        }
        for src, dst in mapping.items():
            if timeouts.get(src) is not None:
                if not isinstance(timeouts[src], (int, float)) or isinstance(timeouts[src], bool):
                    raise ConfigError(f"desktopExecutor.timeouts.{src} 必须是数字")
                values[dst] = float(timeouts[src])
    return ExecutorConfig(**values)


def load_config_file(path: str) -> ExecutorConfig:
    """读取 JSON 配置文件；不存在或非法时抛 ConfigError。"""
    candidate = os.path.abspath(path)
    try:
        raw_text = Path(candidate).read_text(encoding="utf-8-sig")
    except OSError as exc:
        raise ConfigError(f"无法读取配置文件 {path}：{exc}") from exc
    try:
        raw = json.loads(raw_text)
    except json.JSONDecodeError as exc:
        raise ConfigError(f"配置文件不是合法 JSON：{exc}") from exc
    config = config_from_mapping(raw, base_dir=os.getcwd())
    config.validate()
    return config


# ---------------------------------------------------------------------------
# 轻量校验（server 与 editor 共用）
# ---------------------------------------------------------------------------


def require_text_field(payload: Mapping[str, Any], key: str, *, required: bool = True) -> str:
    value = payload.get(key)
    if value is None:
        if required:
            raise ExecutorError("BAD_REQUEST", f"缺少必填字段 {key}")
        return ""
    if not isinstance(value, str):
        raise ExecutorError("BAD_REQUEST", f"字段 {key} 必须是字符串")
    if len(value) > MAX_TEXT_LENGTH:
        raise ExecutorError("BAD_REQUEST", f"字段 {key} 过长（最多 {MAX_TEXT_LENGTH} 字符）")
    return value


def require_id_field(payload: Mapping[str, Any], key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ExecutorError("BAD_REQUEST", f"字段 {key} 必须是非空字符串")
    value = value.strip()
    if len(value) > MAX_ID_LENGTH:
        raise ExecutorError("BAD_REQUEST", f"字段 {key} 过长")
    if not ID_PATTERN.match(value):
        raise ExecutorError("BAD_REQUEST", f"字段 {key} 含非法字符（只允许字母、数字、._:-）")
    return value


def require_content_hash(payload: Mapping[str, Any], key: str = "contentHash") -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not CONTENT_HASH_PATTERN.match(value):
        raise ExecutorError("BAD_REQUEST", "contentHash 必须是 64 位十六进制字符串")
    return value.lower()


def require_visibility(payload: Mapping[str, Any], key: str = "visibility") -> str:
    value = payload.get(key)
    if not isinstance(value, str) or value.upper() not in VISIBILITIES:
        raise ExecutorError("BAD_REQUEST", "visibility 必须是 PUBLIC / PRIVATE / PARTIAL")
    return value.upper()


def is_windows() -> bool:
    return sys.platform.startswith("win")
