"""几何驱动测试：全注入（截图/OCR/鼠标/剪贴板/管理员判定/sleep），不触碰真实微信。

覆盖：status、prepare 导航/长按/粘贴（OCR 与 fallback）、OCR 读回、
图片模式拒绝、可见范围、点击发表（缺按钮/有限重试/错误 toast/超时）、
发布后 OCR 核验、删除/回滚、非管理员 PRIVILEGE_REQUIRED、OCR 不可用、
server /moments/delete 端点与 status 扩展字段、MomentsEditor 全链路。
"""
from __future__ import annotations

import pathlib
import shutil
import socket
import sys
import tempfile
import threading
import unittest

PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[2]
TESTS_DIR = pathlib.Path(__file__).resolve().parent
for search_path in (str(PROJECT_ROOT), str(TESTS_DIR)):
    if search_path not in sys.path:
        sys.path.insert(0, search_path)

from desktop.account_guard import AccountGuard  # noqa: E402
from desktop.config import (  # noqa: E402
    ExecutorConfig,
    ExecutorError,
    Verification,
    WechatInstallation,
)
from desktop.geometry_driver import (  # noqa: E402
    ClipboardController,
    DeleteOutcome,
    GeometryWechatDriver,
    InputController,
)
from desktop.moments_editor import MomentsEditor  # noqa: E402
from desktop.moments_verifier import MomentsVerifier  # noqa: E402
from desktop.ocr import OcrBBox, OcrLine, OcrProvider, OcrResult, OcrWord  # noqa: E402
from desktop.wechat_driver import FakeWechatDriver, PublishAttemptError  # noqa: E402
from desktop.window_locator import (  # noqa: E402
    ProcessInfo,
    WindowInfo,
    WindowLocator,
    solid_png,
)
from test_geometry_rgb import make_rows  # noqa: E402
from test_server import TOKEN, HttpHarness  # noqa: E402

TEXT = "【系统测试】这是一条用于几何驱动单元测试的纯文字朋友圈正文，不进行任何真实发布。"


def spaced_text(text: str) -> str:
    """模拟 OCR 在每个字符之间插入空格。"""
    return " ".join(text)


TEXT_SPACED = spaced_text(TEXT)


# ---------------------------------------------------------------------------
# 假实现
# ---------------------------------------------------------------------------


def make_ocr(
    text: str = "",
    *,
    words: tuple[tuple[str, tuple[int, int, int, int]], ...] = (),
    lines: tuple[tuple[str, tuple[int, int, int, int]], ...] = (),
) -> OcrResult:
    """构造可用 OCR 结果；lines 可指定每行文本与 bbox，words 指定词级 bbox。"""
    if lines:
        line_objects = tuple(
            OcrLine(
                text=line_text,
                bbox=OcrBBox(*line_bbox),
                words=tuple(
                    OcrWord(word_text, OcrBBox(*word_bbox))
                    for word_text, word_bbox in words
                ),
            )
            for line_text, line_bbox in lines
        )
        words_objects = tuple(
            OcrWord(word_text, OcrBBox(*word_bbox)) for word_text, word_bbox in words
        )
    else:
        line_objects = tuple(
            OcrLine(
                text=line_text,
                bbox=OcrBBox(100, 200 + index * 40, 500, 30),
                words=tuple(
                    OcrWord(word_text, OcrBBox(*word_bbox))
                    for word_text, word_bbox in words
                )
                if index == 0
                else (),
            )
            for index, line_text in enumerate(text.split("\n") if text else [])
        )
        words_objects = tuple(
            OcrWord(word_text, OcrBBox(*word_bbox)) for word_text, word_bbox in words
        )
    return OcrResult(
        available=True,
        text=text,
        lines=list(line_objects),
        words=list(words_objects),
        engine="fake",
        language="zh-Hans-CN",
    )


def editor_hint_text() -> str:
    """编辑器特征文案（编辑器是独立顶层窗口，屏幕 OCR 才能看到）。"""
    return "这一刻的想法...\n提醒谁看\n谁可以看\n公开"


def editor_only_ocr() -> OcrResult:
    return make_ocr(editor_hint_text())


def paste_ocr() -> OcrResult:
    # 屏幕捕获同时包含编辑器与右键菜单：一次 OCR 就能确认编辑器已打开并定位“粘贴”。
    return make_ocr(
        editor_hint_text() + "\n粘 贴",
        words=(("粘 贴", (500, 240, 60, 24)),),
    )


def token_ocr(token: str, bbox: tuple[int, int, int, int]) -> OcrResult:
    return make_ocr(token, words=((token, bbox),))


class FakeOcr(OcrProvider):
    def __init__(self, responses=None, *, available: bool = True, reason: str = "测试 OCR 不可用") -> None:
        self.responses = list(responses or [])
        self._available = available
        self.reason = reason
        self.calls: list[str] = []

    @property
    def available(self) -> bool:
        return self._available

    @property
    def unavailable_reason(self) -> str:
        return self.reason

    def recognize(self, image_path: str) -> OcrResult:
        self.calls.append(image_path)
        if not self._available:
            return OcrResult.unavailable(self.reason)
        if not self.responses:
            return OcrResult.unavailable("测试脚本未配置 OCR 响应")
        return self.responses.pop(0)


class FakeInput(InputController):
    def __init__(self, *, available: bool = True) -> None:
        self._available = available
        self.events: list[tuple] = []

    @property
    def available(self) -> bool:
        return self._available

    def focus_window(self, hwnd: int, *, minimized: bool = False) -> None:
        self.events.append(("focus", hwnd, minimized))

    def normalize_window(self, hwnd, width, height):
        self.events.append(('normalize',hwnd,width,height))
        return {'physicalSize':[width,height],'dpiScale':1.0,'workArea':[-10000,-10000,10000,10000],
            'logicalSize':[width,height],'rect':[40,40,width,height]}

    def move(self, x: int, y: int) -> None:
        self.events.append(("move", x, y))

    def click(self, x: int, y: int) -> None:
        self.events.append(("click", x, y))

    def right_click(self, x: int, y: int) -> None:
        self.events.append(("right_click", x, y))

    def long_press(self, x: int, y: int, duration_ms: int) -> None:
        self.events.append(("long_press", x, y, duration_ms))

    def clicks(self) -> list[tuple[int, int]]:
        return [(event[1], event[2]) for event in self.events if event[0] == "click"]

    def count(self, kind: str) -> int:
        return sum(1 for event in self.events if event[0] == kind)


class FakeClipboard(ClipboardController):
    def __init__(self, *, ok: bool = True) -> None:
        self.ok = ok
        self.sets: list[str] = []
        self.clears = 0

    def set_text(self, text: str) -> bool:
        self.sets.append(text)
        return self.ok

    def clear(self) -> None:
        self.clears += 1


class FakeScreen:
    def __init__(
        self,
        rgb_frames=None,
        *,
        width: int = 1200,
        height: int = 900,
        fail_rgb_times: int = 0,
    ) -> None:
        self.frames = list(rgb_frames or [])
        self.width = width
        self.height = height
        self.fail_rgb_times = fail_rgb_times
        self.rgb_calls = 0
        self.png_calls: list[str] = []
        # OCR 截图与按钮检测共用 capture_rgb；只在显式 arm 后消费脚本帧，
        # 避免 prepare 阶段的 OCR 截图把发布按钮帧提前用掉。
        self.armed = bool(rgb_frames)

    def arm(self, *frames) -> None:
        self.frames = list(frames)
        self.armed = True

    def capture_rgb(self):
        self.rgb_calls += 1
        if self.fail_rgb_times > 0:
            self.fail_rgb_times -= 1
            raise ExecutorError("WINDOW_NOT_FOUND", "注入的截图失败")
        if self.armed and self.frames:
            return self.frames.pop(0)
        return self.width, self.height, make_rows(self.width, self.height)

    def capture_png(self, dest: str) -> str:
        self.png_calls.append(dest)
        path = pathlib.Path(dest)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(solid_png(3, 3, (10, 20, 30)))
        return str(path)


def main_window(*, visible: bool = True, minimized: bool = False, rect=(40, 40, 1240, 940)) -> WindowInfo:
    return WindowInfo(
        hwnd=101,
        title="微信",
        class_name="Qt51514QWindowIcon",
        process_id=900,
        process_name="Weixin.exe",
        rect=rect,
        visible=visible,
        minimized=minimized,
        dpi_scale=1.0,
    )


def login_window() -> WindowInfo:
    return WindowInfo(
        hwnd=202,
        title="微信登录",
        class_name="WeChatLoginWndForPC",
        process_id=900,
        process_name="Weixin.exe",
        rect=(200, 200, 900, 800),
        visible=True,
        minimized=False,
        dpi_scale=1.0,
    )


def make_locator(*, logged_in: bool = True, running: bool = True, version: str = "4.1.10.27") -> WindowLocator:
    windows: list[WindowInfo] = [main_window()] if running and logged_in else []
    if running and not logged_in:
        windows = [login_window()]
    processes = [ProcessInfo(pid=900, name="Weixin.exe")] if running else []
    installation = WechatInstallation(
        installed=running,
        exe_path=r"C:\fake\Weixin\Weixin.exe" if running else None,
        version=version if running else None,
    )
    return WindowLocator(
        windows=windows,
        processes=processes,
        installation=installation,
        interactive=True,
        locked=False,
    )


def make_config(tmp: pathlib.Path, **overrides) -> ExecutorConfig:
    values: dict = dict(
        token="t" * 32,
        log_file=None,
        screenshot_dir=str(tmp / "screenshots"),
        asset_roots=(str(tmp / "assets"),),
        driver="geometry",
        mode="APPROVAL_REQUIRED",
        allow_publish=True,
        geometry_allow_publish=True,
        expected_account_id="wxid_test",
        trusted_account_source="wechatagent",
        supported_versions=("4.1.10.27",),
        max_publish_click_retries=1,
        retry_backoff_seconds=0.0,
        max_prepare_attempts=3,
        geometry_long_press_ms=900,
        geometry_wait_after_click=0.2,
        status_timeout=2.0,
        prepare_timeout=2.0,
        click_timeout=2.0,
        verify_timeout=2.0,
        screenshot_timeout=2.0,
    )
    values.update(overrides)
    config = ExecutorConfig(**values)
    (tmp / "assets").mkdir(parents=True, exist_ok=True)
    (tmp / "screenshots").mkdir(parents=True, exist_ok=True)
    return config


class GeometryHarness:
    """组装一个全注入的 GeometryWechatDriver。"""

    def __init__(
        self,
        tmp: pathlib.Path,
        *,
        ocr_responses=None,
        ocr_available: bool = True,
        frames=None,
        admin: bool = True,
        config_overrides: dict | None = None,
        locator: WindowLocator | None = None,
        clipboard_ok: bool = True,
        fail_rgb_times: int = 0,
        input_available: bool = True,
    ) -> None:
        self.tmp = tmp
        self.config = make_config(tmp, **(config_overrides or {}))
        self.ocr = FakeOcr(ocr_responses, available=ocr_available)
        self.screen = FakeScreen(frames, fail_rgb_times=fail_rgb_times)
        self.input = FakeInput(available=input_available)
        self.clipboard = FakeClipboard(ok=clipboard_ok)
        self.sleeps: list[float] = []
        self.driver = GeometryWechatDriver(
            self.config,
            locator=locator or make_locator(),
            ocr=self.ocr,
            input_controller=self.input,
            clipboard=self.clipboard,
            capture_rgb=self.screen.capture_rgb,
            capture_png=self.screen.capture_png,
            admin_check=lambda: admin,
            sleep_fn=self.sleeps.append,
        )

    def open_and_fill(self, text: str = TEXT) -> None:
        """执行打开编辑器 + 填字，要求 ocr_responses 已按顺序准备好。"""
        self.driver.open_moments_editor()
        self.driver.fill_text(text)

    def arm_frames(self, *frames) -> None:
        """在准备完成后为 publish 按钮检测装载截图帧。"""
        self.screen.arm(*frames)


class GeometryTestBase(unittest.TestCase):
    def make_harness(self, **kwargs) -> GeometryHarness:
        tmp = pathlib.Path(tempfile.mkdtemp(prefix="dsh-geometry-test-"))
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        return GeometryHarness(tmp, **kwargs)

    def empty_ocr(self) -> OcrResult:
        return make_ocr("")


# ---------------------------------------------------------------------------
# status / 能力
# ---------------------------------------------------------------------------


class GeometryStatusTest(GeometryTestBase):
    def test_status_reports_geometry_capabilities(self):
        harness = self.make_harness()
        status = harness.driver.get_status()
        self.assertTrue(status.running)
        self.assertTrue(status.logged_in)
        self.assertIsNone(status.account_id)  # 绝不猜测 wxid
        self.assertEqual(status.version, "4.1.10.27")
        self.assertTrue(status.supported)
        self.assertEqual(harness.driver.driver_kind, "geometry")
        self.assertFalse(harness.driver.requires_uia)
        self.assertTrue(harness.driver.supports_delete)
        self.assertTrue(harness.driver.ocr_available)
        self.assertTrue(harness.driver.admin_privilege)
        joined = " ".join(status.notes)
        self.assertIn("geometry", joined)
        self.assertIn("OCR 可用", joined)

    def test_status_warns_when_not_admin(self):
        harness = self.make_harness(admin=False)
        status = harness.driver.get_status()
        self.assertFalse(harness.driver.admin_privilege)
        self.assertIn("管理员", " ".join(status.notes))

    def test_status_reports_ocr_unavailable(self):
        harness = self.make_harness(ocr_available=False)
        status = harness.driver.get_status()
        self.assertFalse(harness.driver.ocr_available)
        self.assertIn("OCR 不可用", " ".join(status.notes))

    def test_status_unsupported_version(self):
        harness = self.make_harness(locator=make_locator(version="4.1.15.13"))
        status = harness.driver.get_status()
        self.assertEqual(status.version, "4.1.15.13")
        self.assertFalse(status.supported)

    def test_status_not_running_and_not_logged_in(self):
        not_running = self.make_harness(locator=make_locator(running=False))
        status = not_running.driver.get_status()
        self.assertFalse(status.running)
        self.assertIn("未运行", " ".join(status.notes))

        not_logged = self.make_harness(locator=make_locator(logged_in=False))
        status2 = not_logged.driver.get_status()
        self.assertTrue(status2.running)
        self.assertFalse(status2.logged_in)


# ---------------------------------------------------------------------------
# prepare：导航 / 长按 / 粘贴 / OCR 读回
# ---------------------------------------------------------------------------


class GeometryPrepareTest(GeometryTestBase):
    def test_open_editor_uses_geometry_clicks_and_long_press(self):
        harness = self.make_harness(ocr_responses=[paste_ocr()])
        harness.driver.open_moments_editor()
        self.assertTrue(harness.driver._editor_open)
        long_presses = [event for event in harness.input.events if event[0] == "long_press"]
        self.assertEqual(len(long_presses), 1)
        self.assertEqual(long_presses[0][3], 900)
        # 发现(58,361)+窗口原点 -> (98,401)；朋友圈入口(180,152) -> (220,192)
        self.assertIn((98, 401), harness.input.clicks())
        self.assertIn((220, 192), harness.input.clicks())
        self.assertEqual(harness.input.count("right_click"), 1)
        # OCR 定位粘贴：bbox(500,240,60,24) 中心 (530,252) + 窗口原点 (40,40)
        self.assertEqual(harness.driver._paste_point, (570, 292))

    def test_paste_menu_fallback_offset(self):
        # 两次屏幕 OCR 都看不到“粘贴”，但能看到编辑器 → 使用实测 fallback 偏移并继续。
        harness = self.make_harness(
            ocr_responses=[editor_only_ocr(), editor_only_ocr(), make_ocr(TEXT_SPACED)]
        )
        harness.open_and_fill()
        text_point = (500 + 40, 220 + 40)  # editor_text profile + 窗口原点
        offset = harness.config.geometry_paste_fallback_offset
        expected = (text_point[0] + offset[0], text_point[1] + offset[1])
        self.assertEqual(harness.driver._paste_point, expected)
        # 粘贴点击（fill_text 的第一次 click）应落在 fallback 点
        clicks = harness.input.clicks()
        self.assertIn(expected, clicks)
        self.assertEqual(harness.clipboard.sets, [TEXT])
        self.assertEqual(harness.clipboard.clears, 1)
        self.assertEqual(harness.input.count("right_click"), 2)

    def test_open_editor_retries_on_window_not_found(self):
        harness = self.make_harness(
            ocr_responses=[paste_ocr(), paste_ocr()],
            fail_rgb_times=1,
        )
        # 第一次 _capture_ocr 的 capture_rgb 抛 WINDOW_NOT_FOUND -> 白名单重试
        harness.driver.open_moments_editor()
        self.assertTrue(harness.driver._editor_open)
        self.assertEqual(harness.input.count("long_press"), 2)
        self.assertTrue(any(s > 0 for s in harness.sleeps))

    def test_fill_text_retries_then_succeeds(self):
        harness = self.make_harness(
            ocr_responses=[
                paste_ocr(),  # open_moments_editor 的粘贴菜单 OCR
                make_ocr("错 误 的 内 容"),  # 第一次粘贴后 OCR 不匹配
                paste_ocr(),  # 重新打开粘贴菜单
                make_ocr(TEXT_SPACED),  # 第二次粘贴后匹配
            ]
        )
        harness.open_and_fill()
        self.assertEqual(harness.driver._editor_text, TEXT)
        self.assertEqual(harness.clipboard.clears, 1)
        self.assertEqual(harness.input.count("right_click"), 2)

    def test_fill_text_all_attempts_mismatch(self):
        harness = self.make_harness(
            ocr_responses=[
                paste_ocr(),
                make_ocr("错 误 一"),
                paste_ocr(),
                make_ocr("错 误 二"),
                paste_ocr(),
                make_ocr("错 误 三"),
            ]
        )
        harness.driver.open_moments_editor()
        with self.assertRaises(ExecutorError) as context:
            harness.driver.fill_text(TEXT)
        self.assertEqual(context.exception.code, "CONTENT_CHANGED")
        self.assertEqual(harness.clipboard.clears, 1)

    def test_fill_text_clipboard_failure_does_not_paste(self):
        harness = self.make_harness(ocr_responses=[paste_ocr()], clipboard_ok=False)
        harness.driver.open_moments_editor()
        with self.assertRaises(ExecutorError) as context:
            harness.driver.fill_text(TEXT)
        self.assertEqual(context.exception.code, "DESKTOP_UNSUPPORTED")
        self.assertEqual(harness.input.clicks()[-1] in [(570, 292)], False)  # 未执行粘贴点击

    def test_read_back_returns_ocr_text_and_image_count_zero(self):
        harness = self.make_harness(ocr_responses=[paste_ocr(), make_ocr(TEXT_SPACED), make_ocr(TEXT_SPACED)])
        harness.open_and_fill()
        visible, images = harness.driver.read_back()
        self.assertTrue(harness.driver.matches_expected_text(visible, TEXT))
        self.assertIn("系统", visible.replace(" ", ""))
        self.assertEqual(images, 0)

    def test_add_images_unsupported(self):
        harness = self.make_harness(ocr_responses=[paste_ocr()])
        with self.assertRaises(ExecutorError) as context:
            harness.driver.add_images(["a.png"])
        self.assertEqual(context.exception.code, "DESKTOP_UNSUPPORTED")

    def test_visibility_only_public(self):
        harness = self.make_harness(ocr_responses=[paste_ocr()])
        harness.driver.set_visibility("PUBLIC")
        self.assertTrue(harness.driver.supports_visibility("PUBLIC"))
        with self.assertRaises(ExecutorError) as context:
            harness.driver.set_visibility("PRIVATE")
        self.assertEqual(context.exception.code, "DESKTOP_UNSUPPORTED")

    def test_non_admin_prepare_requires_privilege(self):
        harness = self.make_harness(admin=False, ocr_responses=[])
        with self.assertRaises(ExecutorError) as context:
            harness.driver.open_moments_editor()
        self.assertEqual(context.exception.code, "PRIVILEGE_REQUIRED")
        self.assertEqual(harness.input.events, [])

    def test_ocr_unavailable_prepare(self):
        harness = self.make_harness(ocr_available=False, ocr_responses=[])
        with self.assertRaises(ExecutorError) as context:
            harness.driver.open_moments_editor()
        self.assertEqual(context.exception.code, "OCR_UNAVAILABLE")


# ---------------------------------------------------------------------------
# publish：像素检测 / 有限重试 / uncertain
# ---------------------------------------------------------------------------


def button_frame():
    return 1200, 900, make_rows(1200, 900, [(426, 654, 594, 697)])


def no_button_frame():
    return 1200, 900, make_rows(1200, 900)


def publish_frames(iterations: int = 1, *, last_state: str = "closed"):
    """构造点击循环所需的截图帧：每轮 OCR 前/按钮检测/OCR 后/状态检测。"""
    frames = []
    for index in range(iterations):
        frames.extend([no_button_frame(), button_frame(), no_button_frame()])
        frames.append(no_button_frame() if (index == iterations - 1 and last_state == "closed") else button_frame())
    return frames


class GeometryPublishTest(GeometryTestBase):
    def test_publish_success_clicks_detected_button(self):
        harness = self.make_harness(
            ocr_responses=[paste_ocr(), make_ocr(TEXT_SPACED), make_ocr(TEXT_SPACED), make_ocr(TEXT_SPACED)],
        )
        harness.open_and_fill()
        harness.arm_frames(*publish_frames(1))
        rgb_before = harness.screen.rgb_calls
        harness.driver.click_publish()
        self.assertTrue(harness.driver._submitted)
        clicks = harness.input.clicks()
        # 绿色按钮中心 ~(510,675)+窗口原点(40,40)
        self.assertTrue(any(abs(x - 550) <= 6 and abs(y - 715) <= 6 for x, y in clicks), clicks)
        # 新一轮：点击前 OCR 截图 + 按钮检测 + 点击后 OCR 截图 + 状态检测
        self.assertEqual(harness.screen.rgb_calls - rgb_before, 4)

    def test_publish_missing_button_never_clicks(self):
        harness = self.make_harness(
            ocr_responses=[paste_ocr(), make_ocr(TEXT_SPACED), make_ocr(TEXT_SPACED)],
        )
        harness.open_and_fill()
        harness.arm_frames(no_button_frame(), no_button_frame())
        before_click_count = harness.input.count("click")
        with self.assertRaises(ExecutorError) as context:
            harness.driver.click_publish()
        self.assertEqual(context.exception.code, "WINDOW_NOT_FOUND")
        self.assertEqual(harness.input.count("click"), before_click_count)
        self.assertFalse(harness.driver._submitted)

    def test_new_editor_session_resets_submitted_flag(self):
        harness = self.make_harness(
            ocr_responses=[paste_ocr(), make_ocr(TEXT_SPACED), make_ocr(TEXT_SPACED), make_ocr(TEXT_SPACED)],
        )
        harness.open_and_fill()
        harness.arm_frames(*publish_frames(1))
        harness.driver.click_publish()
        self.assertTrue(harness.driver._submitted)
        # 新的 prepare/编辑会话必须允许后续 attempt 再次点击发表。
        harness.ocr.responses.append(paste_ocr())
        harness.driver.open_moments_editor()
        self.assertFalse(harness.driver._submitted)

    def test_publish_retry_limit_then_uncertain(self):
        harness = self.make_harness(
            ocr_responses=[
                paste_ocr(),
                make_ocr(TEXT_SPACED),
                make_ocr(TEXT_SPACED),  # 第 1 次点击前 OCR
                make_ocr(TEXT_SPACED),  # 第 1 次点击后 OCR（按钮仍在）
                make_ocr(TEXT_SPACED),  # 第 2 次点击前 OCR
                make_ocr(TEXT_SPACED),  # 第 2 次点击后 OCR（按钮仍在）
            ],
            config_overrides={"max_publish_click_retries": 1},
        )
        harness.open_and_fill()
        harness.arm_frames(*publish_frames(2, last_state="open"))
        click_count_before = harness.input.count("click")
        rgb_before = harness.screen.rgb_calls
        with self.assertRaises(PublishAttemptError) as context:
            harness.driver.click_publish()
        self.assertTrue(context.exception.may_have_submitted)
        self.assertEqual(context.exception.code, "UNCERTAIN")
        # 1 次首点 + 1 次重试 = 2 次发表点击
        self.assertEqual(harness.input.count("click") - click_count_before, 2)
        # 两轮点击各 4 次截图
        self.assertEqual(harness.screen.rgb_calls - rgb_before, 8)

    def test_publish_zero_retries_stops_after_one_click(self):
        harness = self.make_harness(
            ocr_responses=[paste_ocr(), make_ocr(TEXT_SPACED), make_ocr(TEXT_SPACED), make_ocr(TEXT_SPACED)],
            config_overrides={"max_publish_click_retries": 0},
        )
        harness.open_and_fill()
        harness.arm_frames(*publish_frames(1, last_state="open"))
        before = harness.input.count("click")
        with self.assertRaises(PublishAttemptError):
            harness.driver.click_publish()
        self.assertEqual(harness.input.count("click") - before, 1)

    def test_publish_error_toast_after_click_is_uncertain(self):
        harness = self.make_harness(
            ocr_responses=[paste_ocr(), make_ocr(TEXT_SPACED), make_ocr(TEXT_SPACED), make_ocr("文 字 未 发 送")],
        )
        harness.open_and_fill()
        harness.arm_frames(*publish_frames(1))
        rgb_before = harness.screen.rgb_calls
        with self.assertRaises(PublishAttemptError) as context:
            harness.driver.click_publish()
        self.assertEqual(context.exception.code, "UNCERTAIN")
        self.assertTrue(context.exception.may_have_submitted)
        # 点击前 OCR + 按钮检测 + 点击后 OCR（检测到 toast 立即停止，不再检测按钮）
        self.assertEqual(harness.screen.rgb_calls - rgb_before, 3)

    def test_publish_unknown_state_after_click_is_uncertain(self):
        harness = self.make_harness(
            ocr_responses=[
                paste_ocr(),
                make_ocr(TEXT_SPACED),
                make_ocr(TEXT_SPACED),
                OcrResult.unavailable("OCR 挂了"),  # 点击后 OCR 失败 -> unknown
            ],
        )
        harness.open_and_fill()
        harness.arm_frames(no_button_frame(), button_frame(), no_button_frame())
        with self.assertRaises(PublishAttemptError) as context:
            harness.driver.click_publish()
        self.assertEqual(context.exception.code, "UNCERTAIN")
        self.assertTrue(context.exception.may_have_submitted)

    def test_publish_toast_before_first_click_blocks(self):
        harness = self.make_harness(
            ocr_responses=[paste_ocr(), make_ocr(TEXT_SPACED), make_ocr("文 字 未 发 送")],
        )
        harness.open_and_fill()
        before = harness.input.count("click")
        with self.assertRaises(ExecutorError) as context:
            harness.driver.click_publish()
        self.assertEqual(context.exception.code, "WINDOW_BLOCKED")
        self.assertEqual(harness.input.count("click"), before)
        self.assertFalse(harness.driver._submitted)

    def test_publish_content_changed_before_click(self):
        harness = self.make_harness(
            ocr_responses=[paste_ocr(), make_ocr(TEXT_SPACED), make_ocr("完 全 不 同 的 正 文 内 容")],
        )
        harness.open_and_fill()
        before = harness.input.count("click")
        with self.assertRaises(ExecutorError) as context:
            harness.driver.click_publish()
        self.assertEqual(context.exception.code, "CONTENT_CHANGED")
        self.assertEqual(harness.input.count("click"), before)

    def test_publish_disabled_without_geometry_allow_publish(self):
        harness = self.make_harness(
            ocr_responses=[paste_ocr(), make_ocr(TEXT_SPACED)],
            config_overrides={"geometry_allow_publish": False},
        )
        harness.open_and_fill()
        with self.assertRaises(ExecutorError) as context:
            harness.driver.click_publish()
        self.assertEqual(context.exception.code, "PUBLISH_MODE_DISABLED")

    def test_second_click_without_new_prepare_rejected(self):
        harness = self.make_harness(
            ocr_responses=[paste_ocr(), make_ocr(TEXT_SPACED), make_ocr(TEXT_SPACED), make_ocr(TEXT_SPACED)],
        )
        harness.open_and_fill()
        harness.arm_frames(*publish_frames(1))
        harness.driver.click_publish()
        with self.assertRaises(ExecutorError) as context:
            harness.driver.click_publish()
        self.assertEqual(context.exception.code, "ALREADY_SUBMITTED")


# ---------------------------------------------------------------------------
# verify_published
# ---------------------------------------------------------------------------


class GeometryVerifyTest(GeometryTestBase):
    def test_verify_success_from_feed_ocr(self):
        harness = self.make_harness(ocr_responses=[make_ocr(TEXT_SPACED)])
        evidence = str(harness.config.screenshot_dir) + "/att-verify.png"
        verification = harness.driver.verify_published(TEXT, 0, evidence_path=evidence)
        self.assertTrue(verification.verified)
        self.assertEqual(verification.method, "geometry-ocr")
        self.assertEqual(verification.image_count, 0)
        self.assertIsNotNone(verification.published_at)
        self.assertTrue(pathlib.Path(evidence).is_file())

    def test_verify_error_toast(self):
        harness = self.make_harness(ocr_responses=[make_ocr("文 字 未 发 送")])
        verification = harness.driver.verify_published(TEXT, 0)
        self.assertFalse(verification.verified)
        self.assertTrue(any("发送失败" in note for note in verification.notes))

    def test_verify_text_absent(self):
        harness = self.make_harness(ocr_responses=[make_ocr("朋友圈里的其他内容")])
        verification = harness.driver.verify_published(TEXT, 0)
        self.assertFalse(verification.verified)
        self.assertTrue(any("匹配" in note for note in verification.notes))

    def test_verifier_accepts_feed_fragment_match(self):
        expected = "第一行比较长的正文内容\n第二行比较长的正文内容"
        feed = make_ocr("第一行比较长的正文内容")
        harness = self.make_harness(ocr_responses=[feed])
        verifier = MomentsVerifier(harness.driver, harness.config)
        evidence = str(harness.config.screenshot_dir) + "/att-fragment.png"
        verification = verifier.verify(
            attempt_id="att_fragment",
            expected_text=expected,
            expected_image_count=0,
            evidence_path=evidence,
        )
        self.assertTrue(verification.verified, msg=str(verification.notes))
        self.assertEqual(verification.method, "geometry-ocr")

    def test_verify_image_count_nonzero_rejected(self):
        harness = self.make_harness(ocr_responses=[])
        verification = harness.driver.verify_published(TEXT, 1)
        self.assertFalse(verification.verified)
        self.assertEqual(harness.ocr.calls, [])

    def test_verify_ocr_unavailable(self):
        harness = self.make_harness(ocr_available=False)
        verification = harness.driver.verify_published(TEXT, 0)
        self.assertFalse(verification.verified)
        self.assertTrue(any("OCR_UNAVAILABLE" in note for note in verification.notes))


# ---------------------------------------------------------------------------
# delete / 回滚
# ---------------------------------------------------------------------------


class GeometryDeleteTest(GeometryTestBase):
    def _delete_config(self, **overrides):
        return {"max_text_length": 2000, **overrides}

    def test_delete_matching_first_post(self):
        find = make_ocr(
            TEXT_SPACED,
            lines=((TEXT_SPACED, (100, 250, 800, 40)),),
        )
        dialog = token_ocr("删 除", (600, 500, 60, 30))
        after = make_ocr("朋友圈里的其他内容")
        harness = self.make_harness(ocr_responses=[find, dialog, after])
        evidence = str(harness.config.screenshot_dir) + "/att-delete.png"
        outcome = harness.driver.delete_published(TEXT, evidence_path=evidence)
        self.assertTrue(outcome.deleted, msg=outcome.message)
        self.assertFalse(outcome.uncertain)
        self.assertTrue(pathlib.Path(evidence).is_file())
        clicks = harness.input.clicks()
        # 首条动态删除图标 (682,733)+窗口原点
        self.assertIn((722, 773), clicks)

    def test_delete_no_match_does_not_click(self):
        harness = self.make_harness(ocr_responses=[make_ocr("只有别人的动态")])
        before = harness.input.count("click")
        outcome = harness.driver.delete_published(TEXT)
        self.assertFalse(outcome.deleted)
        self.assertTrue(outcome.uncertain)
        # 只允许“发现→朋友圈”两次导航点击；没有点垃圾桶/确认删除
        self.assertEqual(harness.input.count("click") - before, 2)

    def test_delete_multiple_matches_refused(self):
        find = make_ocr(
            TEXT_SPACED,
            lines=((TEXT_SPACED, (100, 250, 800, 40)), (TEXT_SPACED, (100, 300, 800, 40))),
        )
        harness = self.make_harness(ocr_responses=[find])
        before = harness.input.count("click")
        outcome = harness.driver.delete_published(TEXT)
        self.assertTrue(outcome.uncertain)
        self.assertIn("多条", outcome.message)
        self.assertEqual(harness.input.count("click") - before, 2)

    def test_delete_bottom_region_refused(self):
        find = make_ocr(TEXT_SPACED, lines=((TEXT_SPACED, (100, 700, 800, 40)),))
        harness = self.make_harness(ocr_responses=[find])
        before = harness.input.count("click")
        outcome = harness.driver.delete_published(TEXT)
        self.assertTrue(outcome.uncertain)
        self.assertIn("区域", outcome.message)
        self.assertEqual(harness.input.count("click") - before, 2)

    def test_delete_without_confirm_dialog_does_not_confirm(self):
        find = make_ocr(TEXT_SPACED, lines=((TEXT_SPACED, (100, 250, 800, 40)),))
        dialog_without_token = make_ocr("确认删除这条朋友圈吗？")
        harness = self.make_harness(ocr_responses=[find, dialog_without_token])
        outcome = harness.driver.delete_published(TEXT)
        self.assertTrue(outcome.uncertain)
        self.assertIn("删除", outcome.message)
        # 只点了导航 + 垃圾桶，没有点确认删除
        self.assertEqual(harness.input.count("click"), 3)

    def test_delete_not_confirmed_after_click(self):
        find = make_ocr(TEXT_SPACED, lines=((TEXT_SPACED, (100, 250, 800, 40)),))
        dialog = token_ocr("删 除", (600, 500, 60, 30))
        after_still = make_ocr(TEXT_SPACED, lines=((TEXT_SPACED, (100, 250, 800, 40)),))
        harness = self.make_harness(ocr_responses=[find, dialog, after_still])
        outcome = harness.driver.delete_published(TEXT)
        self.assertFalse(outcome.deleted)
        self.assertTrue(outcome.uncertain)

    def test_delete_short_text_refused(self):
        harness = self.make_harness(ocr_responses=[])
        outcome = harness.driver.delete_published("短")
        self.assertTrue(outcome.uncertain)
        self.assertEqual(harness.ocr.calls, [])

    def test_delete_permission_disabled(self):
        harness = self.make_harness(ocr_responses=[], config_overrides={"geometry_allow_publish": False})
        outcome = harness.driver.delete_published(TEXT)
        self.assertFalse(outcome.deleted)
        self.assertFalse(outcome.uncertain)
        self.assertEqual(outcome.error_code, "PUBLISH_MODE_DISABLED")

    def test_delete_non_admin(self):
        harness = self.make_harness(ocr_responses=[], admin=False)
        outcome = harness.driver.delete_published(TEXT)
        self.assertTrue(outcome.uncertain)
        self.assertEqual(outcome.error_code, "PRIVILEGE_REQUIRED")

    def test_delete_ocr_unavailable(self):
        harness = self.make_harness(ocr_available=False)
        outcome = harness.driver.delete_published(TEXT)
        self.assertTrue(outcome.uncertain)
        self.assertEqual(outcome.error_code, "OCR_UNAVAILABLE")


# ---------------------------------------------------------------------------
# MomentsEditor 全链路（几何驱动）
# ---------------------------------------------------------------------------


class GeometryEditorIntegrationTest(GeometryTestBase):
    def test_prepare_then_publish_then_verify(self):
        harness = self.make_harness(
            ocr_responses=[
                paste_ocr(),  # open_moments_editor
                make_ocr(TEXT_SPACED),  # fill_text OCR 校验
                make_ocr(TEXT_SPACED),  # prepare read_back
                make_ocr(TEXT_SPACED),  # publish 前 read_back
                make_ocr(TEXT_SPACED),  # click 前 OCR
                make_ocr(TEXT_SPACED),  # click 后状态 OCR
                make_ocr(TEXT_SPACED),  # verify feed OCR
            ],
        )
        config = harness.config
        guard = AccountGuard(
            expected_account_id=config.expected_account_id,
            supported_versions=config.supported_versions,
            trusted_account_source=config.trusted_account_source,
            assumed_client_version=config.assumed_client_version,
        )
        verifier = MomentsVerifier(harness.driver, config)
        editor = MomentsEditor(harness.driver, guard, config, verifier)
        request = {
            "taskId": "task_geo_1",
            "attemptId": "att_geo_1",
            "text": TEXT,
            "assetPaths": [],
            "visibility": "PUBLIC",
            "contentHash": "a" * 64,
            "accountId": "wxid_test",
            "screenshotDir": str(config.screenshot_dir),
        }
        prepare = editor.prepare(request)
        self.assertTrue(prepare.ok, msg=prepare.message)
        self.assertTrue(prepare.prepared)
        self.assertTrue(prepare.text_matched)
        self.assertIsNotNone(prepare.snapshot)
        self.assertFalse(harness.driver._submitted)  # prepare 不点击发表

        # prepare 阶段的 OCR 截图会使用默认截图；发布前再装载按钮/关闭帧。
        # editor.publish 会先做一次 read_back OCR，因此多准备一帧默认截图。
        harness.arm_frames(no_button_frame(), *publish_frames(1))
        publish_request = {
            "taskId": "task_geo_1",
            "attemptId": "att_geo_1",
            "contentHash": "a" * 64,
            "accountId": "wxid_test",
            "approvalId": "apr_geo_1",
        }
        published = editor.publish(
            prepare.snapshot, publish_request, allow_publish=True
        )
        self.assertTrue(published.ok, msg=published.message)
        self.assertTrue(published.submitted)
        self.assertTrue(published.verified)
        self.assertFalse(published.uncertain)
        self.assertIsNotNone(published.verification)


# ---------------------------------------------------------------------------
# server /moments/delete 与 status 扩展字段（stub 驱动）
# ---------------------------------------------------------------------------


class StubGeometryDriver(FakeWechatDriver):
    """只用于 server 端点测试的几何驱动 stub（不进行任何 GUI 操作）。"""

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self.delete_calls: list[tuple[str, str | None]] = []

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
        return True

    @property
    def admin_privilege(self) -> bool:
        return True

    def delete_published(self, expected_text, *, evidence_path=None, timeout=None):  # type: ignore[no-untyped-def]
        self.delete_calls.append((expected_text, evidence_path))
        if evidence_path:
            pathlib.Path(evidence_path).parent.mkdir(parents=True, exist_ok=True)
            pathlib.Path(evidence_path).write_bytes(solid_png(2, 2))
        return DeleteOutcome(
            deleted=True,
            uncertain=False,
            error_code=None,
            message="stub 删除成功",
            evidence_path=evidence_path,
        )


class DeleteEndpointTest(GeometryTestBase):
    def make_http_harness(self, *, driver, geometry_allow_publish=True) -> HttpHarness:
        harness = HttpHarness(
            driver=driver,
            mode="APPROVAL_REQUIRED",
            allow_publish=True,
            config_overrides={
                "driver": "geometry",
                "geometry_allow_publish": geometry_allow_publish,
                "expected_account_id": "wxid_fake_account",
                "trusted_account_source": "wechatagent",
            },
        )
        self.addCleanup(harness.close)
        return harness

    def test_status_exposes_driver_and_capabilities(self):
        driver = StubGeometryDriver()
        harness = self.make_http_harness(driver=driver)
        _, status = harness.http_json("GET", "/wechat/status")
        self.assertEqual(status["driver"], "geometry")
        self.assertTrue(status["ocrAvailable"])
        self.assertTrue(status["adminPrivilege"])
        self.assertEqual(status["maxRetries"], 1)
        _, health = harness.http_json("GET", "/health")
        self.assertEqual(health["driver"], "geometry")
        self.assertTrue(health["ocrAvailable"])

    def test_delete_success_after_publish(self):
        driver = StubGeometryDriver()
        harness = self.make_http_harness(driver=driver)
        prepared, _ = harness.prepare_ok()
        _, published = harness.http_json("POST", "/moments/publish", harness.publish_payload(prepared))
        self.assertTrue(published["submitted"], msg=str(published))
        delete_payload = {
            "taskId": prepared["taskId"],
            "attemptId": prepared["attemptId"],
            "contentHash": prepared["contentHash"],
            "accountId": prepared["accountId"],
            "expectedText": prepared["text"],
        }
        _, body = harness.http_json("POST", "/moments/delete", delete_payload)
        self.assertTrue(body["ok"], msg=str(body))
        self.assertTrue(body["deleted"])
        self.assertFalse(body["uncertain"])
        self.assertTrue(driver.delete_calls)
        self.assertTrue(pathlib.Path(body["screenshotPath"]).is_file())

    def test_delete_requires_geometry_driver(self):
        harness = HttpHarness(driver=FakeWechatDriver(), mode="APPROVAL_REQUIRED", allow_publish=True)
        self.addCleanup(harness.close)
        prepared, _ = harness.prepare_ok()
        _, body = harness.http_json(
            "POST",
            "/moments/delete",
            {
                "taskId": prepared["taskId"],
                "attemptId": prepared["attemptId"],
                "contentHash": prepared["contentHash"],
                "accountId": prepared["accountId"],
                "expectedText": prepared["text"],
            },
        )
        self.assertEqual(body["errorCode"], "DESKTOP_UNSUPPORTED")

    def test_delete_requires_geometry_publish_permission(self):
        driver = StubGeometryDriver()
        harness = self.make_http_harness(driver=driver, geometry_allow_publish=False)
        prepared, _ = harness.prepare_ok()
        _, body = harness.http_json(
            "POST",
            "/moments/delete",
            {
                "taskId": prepared["taskId"],
                "attemptId": prepared["attemptId"],
                "contentHash": prepared["contentHash"],
                "accountId": prepared["accountId"],
                "expectedText": prepared["text"],
            },
        )
        self.assertEqual(body["errorCode"], "PUBLISH_MODE_DISABLED")

    def test_delete_rejects_wrong_expected_text(self):
        driver = StubGeometryDriver()
        harness = self.make_http_harness(driver=driver)
        prepared, _ = harness.prepare_ok()
        harness.http_json("POST", "/moments/publish", harness.publish_payload(prepared))
        _, body = harness.http_json(
            "POST",
            "/moments/delete",
            {
                "taskId": prepared["taskId"],
                "attemptId": prepared["attemptId"],
                "contentHash": prepared["contentHash"],
                "accountId": prepared["accountId"],
                "expectedText": "另一条不同的正文内容，不应该匹配",
            },
        )
        self.assertEqual(body["errorCode"], "CONTENT_CHANGED")
        self.assertFalse(driver.delete_calls)

    def test_delete_without_publish_rejected(self):
        driver = StubGeometryDriver()
        harness = self.make_http_harness(driver=driver)
        prepared, _ = harness.prepare_ok()
        _, body = harness.http_json(
            "POST",
            "/moments/delete",
            {
                "taskId": prepared["taskId"],
                "attemptId": prepared["attemptId"],
                "contentHash": prepared["contentHash"],
                "accountId": prepared["accountId"],
                "expectedText": prepared["text"],
            },
        )
        self.assertEqual(body["errorCode"], "BAD_REQUEST")
        self.assertFalse(driver.delete_calls)

    def test_delete_unknown_attempt_rejected(self):
        driver = StubGeometryDriver()
        harness = self.make_http_harness(driver=driver)
        _, body = harness.http_json(
            "POST",
            "/moments/delete",
            {
                "taskId": "task_x",
                "attemptId": "att_x",
                "contentHash": "a" * 64,
                "accountId": "wxid_fake_account",
                "expectedText": "任意正文",
            },
        )
        self.assertEqual(body["errorCode"], "BAD_REQUEST")
        self.assertFalse(driver.delete_calls)




class GeometryConfigTest(GeometryTestBase):
    def test_cli_geometry_flags(self):
        from desktop.server import build_config, build_parser

        parser = build_parser()
        args = parser.parse_args(
            [
                "--driver",
                "geometry",
                "--geometry-allow-publish",
                "--mode",
                "APPROVAL_REQUIRED",
                "--allow-publish",
                "--ocr-python",
                sys.executable,
                "--max-publish-click-retries",
                "2",
                "--retry-backoff-seconds",
                "1.5",
                "--port",
                "0",
            ]
        )
        config = build_config(args)
        self.assertEqual(config.driver, "geometry")
        self.assertTrue(config.geometry_allow_publish)
        self.assertTrue(config.effective_geometry_publish)
        self.assertEqual(config.ocr_python, str(pathlib.Path(sys.executable)))
        self.assertEqual(config.max_publish_click_retries, 2)
        self.assertEqual(config.retry_backoff_seconds, 1.5)

    def test_geometry_publish_flag_does_not_bypass_approval_mode(self):
        config = ExecutorConfig(
            driver="geometry",
            mode="PREPARE_ONLY",
            allow_publish=True,
            geometry_allow_publish=True,
            token="t" * 32,
            log_file=None,
        )
        config.validate()
        self.assertFalse(config.effective_geometry_publish)

    def test_config_rejects_invalid_geometry_values(self):
        from desktop.config import ConfigError

        base = dict(token="t" * 32, log_file=None)
        cases = [
            dict(driver="unknown"),
            dict(max_publish_click_retries=3),
            dict(max_publish_click_retries=-1),
            dict(retry_backoff_seconds=-1),
            dict(max_prepare_attempts=4),
            dict(geometry_long_press_ms=500),
            dict(geometry_paste_fallback_offset=(1,)),
        ]
        for overrides in cases:
            with self.subTest(overrides=overrides):
                config = ExecutorConfig(**{**base, **overrides})
                with self.assertRaises(ConfigError):
                    config.validate()

    def test_flat_config_mapping_supports_geometry_fields(self):
        from desktop.config import config_from_mapping

        config = config_from_mapping(
            {
                "driver": "geometry",
                "geometryAllowPublish": True,
                "ocrPython": "D:/dsh/python.exe",
                "maxPublishClickRetries": 2,
                "retryBackoffSeconds": 0.5,
                "maxPrepareAttempts": 2,
                "geometryLongPressMs": 1000,
                "geometryWaitAfterClick": 1.0,
                "geometryPasteFallbackOffset": [10, 12],
            }
        )
        config.validate()
        self.assertEqual(config.driver, "geometry")
        self.assertTrue(config.geometry_allow_publish)
        self.assertEqual(config.ocr_python, "D:/dsh/python.exe")
        self.assertEqual(config.max_publish_click_retries, 2)
        self.assertEqual(config.geometry_paste_fallback_offset, (10, 12))

    def test_build_driver_selects_geometry(self):
        import logging

        from desktop.server import build_driver

        harness = self.make_harness()
        driver = build_driver(harness.config, logging.getLogger("geometry-config-test"))
        self.assertIsInstance(driver, GeometryWechatDriver)
        self.assertEqual(driver.driver_kind, "geometry")


if __name__ == "__main__":
    unittest.main()
