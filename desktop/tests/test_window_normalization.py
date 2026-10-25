"""窗口归一化 / DPI / 管理员自动判定测试（全注入，不触碰真实微信）。"""
import tempfile
import unittest
from pathlib import Path
from dataclasses import replace
from unittest import mock

from desktop.geometry_driver import (
    GeometryWechatDriver,
    Win32InputController,
    normalization_plan,
)
from desktop.config import ExecutorError, ExecutorConfig, ConfigError
from test_geometry_driver import (
    GeometryHarness,
    TEXT_SPACED,
    editor_only_ocr,
    make_ocr,
    make_locator,
    main_window,
    paste_ocr,
)


def assert_raises_privilege(testcase, harness):
    with testcase.assertRaises(ExecutorError) as context:
        harness.driver.open_moments_editor()
    testcase.assertEqual(context.exception.code, "PRIVILEGE_REQUIRED")
    testcase.assertEqual(harness.input.events, [])


class NormalizationTest(unittest.TestCase):
    def test_plans_fixed_physical_size_for_any_monitor(self):
        for area in (
            (-3840, 0, 0, 2160),
            (0, 0, 3840, 2160),
            (0, 0, 1920, 1040),
            (-1707, 0, 2560, 1440),
        ):
            with self.subTest(area=area):
                plan = normalization_plan(area)
                # 微信 4.x Qt 界面按物理像素布局：归一化目标固定为 1200×900 物理像素。
                self.assertEqual(plan["physicalSize"], [1200, 900])
                self.assertEqual(plan["windowSize"], [1200, 900])
                x, y, w, h = plan["rect"]
                self.assertEqual((w, h), (1200, 900))
                self.assertTrue(area[0] <= x and x + w <= area[2])
                self.assertTrue(area[1] <= y and y + h <= area[3])

    def test_screen_too_small_is_rejected(self):
        for area in ((0, 0, 1366, 728), (0, 0, 1024, 768), (-800, 0, 400, 600)):
            with self.subTest(area=area), self.assertRaises(ExecutorError):
                normalization_plan(area)
        with self.assertRaises(ExecutorError):
            normalization_plan((0, 0, 1920, 1040), 0, 0)

    def test_prepare_normalizes_before_navigation_and_guards_later_movement(self):
        with tempfile.TemporaryDirectory() as tmp:
            locator = make_locator()
            locator._fake_windows = [main_window(rect=(100, 100, 1700, 1100))]
            harness = GeometryHarness(Path(tmp), locator=locator, ocr_responses=[paste_ocr(), make_ocr(TEXT_SPACED)])
            original = harness.input.normalize_window

            def resize(hwnd, w, h):
                locator._fake_windows = [main_window()]
                return original(hwnd, w, h)

            harness.input.normalize_window = resize
            harness.open_and_fill()
            events = [event[0] for event in harness.input.events]
            self.assertLess(events.index("normalize"), events.index("click"))
            self.assertTrue(harness.driver._normalization["verified"])
            self.assertEqual(harness.driver._normalization["physicalSize"], [1200, 900])
            locator._fake_windows = [main_window(rect=(140, 40, 1340, 940))]
            clicks = harness.input.count("click")
            with self.assertRaises(ExecutorError):
                harness.driver.click_publish()
            self.assertEqual(harness.input.count("click"), clicks)

    def test_profile_is_matched_by_physical_pixels_not_dpi(self):
        with tempfile.TemporaryDirectory() as tmp:
            locator = make_locator()
            # 同一个 1800×1350（150% DPI 下的逻辑 1200×900）不是已验证 profile。
            locator._fake_windows = [replace(main_window(rect=(0, 0, 1800, 1350)), dpi_scale=1.5)]
            harness = GeometryHarness(Path(tmp), locator=locator)
            harness.driver._require_geometry_ready(require_admin=False)
            self.assertFalse(harness.driver._verified_layout())

    def test_physical_1200_profile_used_even_at_high_dpi(self):
        with tempfile.TemporaryDirectory() as tmp:
            locator = make_locator()
            locator._fake_windows = [replace(main_window(rect=(0, 0, 1200, 900)), dpi_scale=1.5)]
            harness = GeometryHarness(Path(tmp), locator=locator)
            harness.driver._require_geometry_ready()
            self.assertEqual(harness.driver._geometry.profile, (1200, 900))
            self.assertTrue(harness.driver._verified_layout())
            # 物理像素 profile：camera (1144,85) + 窗口原点 (40,40)？
            # 这里窗口原点为 (0,0)，所以就是 profile 坐标本身。
            self.assertEqual(harness.driver._camera_screen_point(), (1144, 85))

    def test_1342_profile_is_supported(self):
        with tempfile.TemporaryDirectory() as tmp:
            locator = make_locator()
            locator._fake_windows = [main_window(rect=(10, 20, 1352, 991))]
            harness = GeometryHarness(Path(tmp), locator=locator)
            harness.driver._require_geometry_ready(require_admin=False)
            self.assertEqual(harness.driver._geometry.profile, (1342, 971))
            self.assertTrue(harness.driver._verified_layout())

    def test_resize_refused_does_not_navigate(self):
        with tempfile.TemporaryDirectory() as tmp:
            locator = make_locator()
            locator._fake_windows = [main_window(rect=(40, 40, 1640, 1040))]
            harness = GeometryHarness(
                Path(tmp), locator=locator, config_overrides={"max_prepare_attempts": 1}
            )

            def refuse(hwnd, w, h):
                raise ExecutorError("WINDOW_BLOCKED", "测试：拒绝调整窗口")

            harness.input.normalize_window = refuse
            with self.assertRaises(ExecutorError):
                harness.driver.open_moments_editor()
            self.assertEqual(harness.input.count("click"), 0)

    def test_readonly_diagnostic_never_normalizes(self):
        with tempfile.TemporaryDirectory() as tmp:
            harness = GeometryHarness(Path(tmp), ocr_responses=[make_ocr("朋友圈")])
            harness.driver.inspect_controls()
            self.assertEqual(harness.input.events, [])

    def test_normalization_can_be_disabled_and_validated(self):
        with tempfile.TemporaryDirectory() as tmp:
            harness = GeometryHarness(
                Path(tmp),
                ocr_responses=[paste_ocr()],
                config_overrides={"geometry_normalize_window": False},
            )
            harness.driver.open_moments_editor()
            self.assertEqual(harness.input.count("normalize"), 0)
        with self.assertRaises(ConfigError):
            ExecutorConfig(geometry_normalize_window="yes").validate()
        with self.assertRaises(ConfigError):
            ExecutorConfig(geometry_require_admin="yes").validate()

    def test_native_controller_applies_physical_plan(self):
        class NativeDouble:
            def ShowWindow(self, *args):
                pass

            def MonitorFromWindow(self, *args):
                return 900

            def GetMonitorInfoW(self, monitor, info):
                info._obj.rcWork.left = -2560
                info._obj.rcWork.top = 0
                info._obj.rcWork.right = 0
                info._obj.rcWork.bottom = 1400
                return True

            def GetDpiForWindow(self, *args):
                return 120

            def SetWindowPos(self, *args):
                self.called = args
                return True

        controller = Win32InputController.__new__(Win32InputController)
        controller._user32 = NativeDouble()
        result = controller.normalize_window(101, 1200, 900)
        # 150% DPI 下仍使用 1200×900 物理像素（不是 1800×1350）。
        self.assertEqual(result["physicalSize"], [1200, 900])
        self.assertEqual(result["dpiScale"], 1.25)
        self.assertEqual(controller._user32.called[0], 101)
        self.assertEqual(controller._user32.called[4:6], (1200, 900))
        self.assertEqual(result["rect"][0], -1880)
        self.assertEqual(result["rect"][1], 250)


class AdminGateTest(unittest.TestCase):
    """非管理员允许同完整性输入；但配置要求或目标提权时必须拒绝。"""

    def _prepare_with_elevation(self, elevated, *, admin=False, require_admin=None):
        kwargs = {}
        if require_admin is not None:
            kwargs["config_overrides"] = {"geometry_require_admin": require_admin}
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        harness = GeometryHarness(Path(tmp.name), admin=admin, ocr_responses=[paste_ocr()], **kwargs)
        target = "desktop.geometry_driver.process_is_elevated"
        with mock.patch(target, return_value=elevated):
            harness.driver.open_moments_editor()
        return harness

    def test_non_admin_allowed_when_target_not_elevated(self):
        harness = self._prepare_with_elevation(False)
        self.assertTrue(harness.driver._editor_open)

    def test_non_admin_rejected_when_target_elevated_or_unknown(self):
        for elevated in (True, None):
            with self.subTest(elevated=elevated):
                with self.assertRaises(ExecutorError) as context:
                    self._prepare_with_elevation(elevated)
                self.assertEqual(context.exception.code, "PRIVILEGE_REQUIRED")

    def test_config_can_force_admin(self):
        with self.assertRaises(ExecutorError) as context:
            self._prepare_with_elevation(False, require_admin=True)
        self.assertEqual(context.exception.code, "PRIVILEGE_REQUIRED")

    def test_admin_always_allowed(self):
        harness = self._prepare_with_elevation(True, admin=True)
        self.assertTrue(harness.driver._editor_open)


class ForegroundGuardTest(unittest.TestCase):
    def test_screen_capture_requires_wechat_foreground(self):
        with tempfile.TemporaryDirectory() as tmp:
            harness = GeometryHarness(Path(tmp), ocr_responses=[])
            harness.driver._window = main_window()
            harness.driver._capture_rgb_fn = None
            with mock.patch("desktop.geometry_driver.foreground_window", return_value=123), mock.patch(
                "desktop.geometry_driver.window_process_id", return_value=900
            ):
                harness.driver._assert_foreground()
            with mock.patch("desktop.geometry_driver.foreground_window", return_value=123), mock.patch(
                "desktop.geometry_driver.window_process_id", return_value=999
            ):
                with self.assertRaises(ExecutorError) as context:
                    harness.driver._assert_foreground()
                self.assertEqual(context.exception.code, "WINDOW_BLOCKED")


class EditorVisibilityTest(unittest.TestCase):
    def test_editor_must_be_visible_in_screen_ocr(self):
        with tempfile.TemporaryDirectory() as tmp:
            harness = GeometryHarness(
                Path(tmp),
                # 两次屏幕 OCR 都看不到编辑器特征 -> 停止，不盲点。
                ocr_responses=[make_ocr("朋友圈里的正文内容"), make_ocr("朋友圈里的正文内容")],
                config_overrides={"max_prepare_attempts": 1},
            )
            with self.assertRaises(ExecutorError) as context:
                harness.driver.open_moments_editor()
            self.assertEqual(context.exception.code, "WINDOW_NOT_FOUND")
            self.assertFalse(harness.driver._editor_open)
            # 未点击发表
            self.assertEqual(harness.input.count("right_click"), 2)


