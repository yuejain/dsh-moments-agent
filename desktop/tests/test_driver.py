"""驱动层与窗口定位测试：Fake 驱动、真实驱动降级、注入式窗口数据、账号守卫。"""
from __future__ import annotations

import importlib.util
import os
import pathlib
import re
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent.parent
for search_path in (str(ROOT), str(HERE)):
    if search_path not in sys.path:
        sys.path.insert(0, search_path)

from desktop.account_guard import AccountGuard  # noqa: E402
from desktop.config import (  # noqa: E402
    ExecutorConfig,
    ExecutorError,
    Verification,
    WechatInstallation,
    WechatStatus,
)
from desktop.wechat_driver import (  # noqa: E402
    FakeWechatDriver,
    PublishAttemptError,
    RealWechatDriver,
)
from desktop.window_locator import (  # noqa: E402
    ProcessInfo,
    WindowInfo,
    WindowLocator,
    encode_png_rgb,
    solid_png,
)

WEIXIN_EXE = pathlib.Path(r"D:\tencent\Weixin\Weixin.exe")


def _base_config(**overrides: object) -> ExecutorConfig:
    values: dict[str, object] = {
        "token": "t" * 32,
        "log_file": None,
        "supported_versions": ("4.1.10.27",),
    }
    values.update(overrides)
    return ExecutorConfig(**values)  # type: ignore[arg-type]


class FakeDriverTest(unittest.TestCase):
    def test_default_status(self) -> None:
        driver = FakeWechatDriver()
        status = driver.get_status()
        self.assertTrue(status.running)
        self.assertTrue(status.logged_in)
        self.assertEqual(status.account_id, "wxid_fake_account")
        self.assertTrue(status.interactive)
        self.assertFalse(status.locked)
        self.assertTrue(status.supported)

    def test_read_back_mismatch(self) -> None:
        driver = FakeWechatDriver(text_match=False, text_override="被修改的正文")
        driver.open_moments_editor()
        driver.fill_text("原始正文")
        text, images = driver.read_back()
        self.assertEqual(text, "被修改的正文")
        self.assertEqual(images, 0)

    def test_upload_failure(self) -> None:
        driver = FakeWechatDriver(upload_fail=True)
        driver.open_moments_editor()
        with self.assertRaises(ExecutorError) as context:
            driver.add_images(["C:/x.png"])
        self.assertEqual(context.exception.code, "UPLOAD_FAILED")

    def test_window_not_found(self) -> None:
        driver = FakeWechatDriver(window_found=False)
        with self.assertRaises(ExecutorError) as context:
            driver.open_moments_editor()
        self.assertEqual(context.exception.code, "WINDOW_NOT_FOUND")

    def test_click_timeout_marks_may_have_submitted(self) -> None:
        driver = FakeWechatDriver(publish_outcome="click_timeout")
        driver.open_moments_editor()
        with self.assertRaises(PublishAttemptError) as context:
            driver.click_publish()
        self.assertTrue(context.exception.may_have_submitted)
        self.assertEqual(context.exception.code, "UNCERTAIN")

    def test_click_error_is_not_submitted(self) -> None:
        driver = FakeWechatDriver(publish_outcome="click_error")
        driver.open_moments_editor()
        with self.assertRaises(ExecutorError) as context:
            driver.click_publish()
        self.assertFalse(isinstance(context.exception, PublishAttemptError))

    def test_verify_outcomes(self) -> None:
        driver = FakeWechatDriver(publish_outcome="verified")
        driver.open_moments_editor()
        driver.click_publish()
        verification = driver.verify_published("正文", 0)
        self.assertTrue(verification.verified)
        self.assertEqual(verification.visible_text, "正文")

        uncertain = FakeWechatDriver(publish_outcome="uncertain")
        uncertain.open_moments_editor()
        uncertain.click_publish()
        result = uncertain.verify_published("正文", 0)
        self.assertFalse(result.verified)

    def test_screenshot_writes_png(self) -> None:
        driver = FakeWechatDriver()
        with tempfile.TemporaryDirectory() as tmp:
            target = os.path.join(tmp, "shot.png")
            saved = driver.screenshot(target)
            self.assertEqual(saved, os.path.abspath(target))
            data = pathlib.Path(saved).read_bytes()
            self.assertTrue(data.startswith(b"\x89PNG\r\n\x1a\n"))


class RealDriverTest(unittest.TestCase):
    def test_missing_installation_returns_status_for_clean_windows(self) -> None:
        for directories in ([], ['C:/missing-wechat']):
            with self.subTest(directories=directories), \
                patch('desktop.window_locator._IS_WINDOWS', True), \
                patch('desktop.window_locator._scan_uninstall_registry', return_value=(directories, None, [], [])), \
                patch('desktop.window_locator._default_install_candidates', return_value=[]), \
                patch('desktop.window_locator._path_exists_file', return_value=False):
                installation = WindowLocator().detect_installation()
                self.assertIsInstance(installation, WechatInstallation)
                self.assertFalse(installation.installed)
                self.assertIsNone(installation.exe_path)
                self.assertTrue(installation.notes)

    def setUp(self) -> None:
        self.config = _base_config()
        self.driver = RealWechatDriver(self.config)

    def test_uia_availability_matches_environment(self) -> None:
        available = importlib.util.find_spec("pywinauto") is not None
        self.assertEqual(self.driver.uia_available, available)

    def test_status_never_crashes_and_is_honest(self) -> None:
        status = self.driver.get_status()
        self.assertIsInstance(status, WechatStatus)
        installation = self.driver.get_installation()
        if installation.installed:
            self.assertIsNotNone(status.version)
            self.assertEqual(status.version, installation.version)
        else:
            self.assertIsNone(status.version)
        expected_supported = bool(
            self.driver.uia_available
            and installation.installed
            and status.version in self.config.supported_versions
        )
        self.assertEqual(status.supported, expected_supported)
        self.assertIsInstance(status.notes, list)
        self.assertIsInstance(status.interactive, bool)
        self.assertIsInstance(status.locked, bool)

    def test_installation_detection(self) -> None:
        installation = self.driver.get_installation()
        self.assertIsInstance(installation, WechatInstallation)
        if WEIXIN_EXE.is_file():
            # 本机实测已安装 Weixin 4.x；版本以文件版本为准。
            self.assertTrue(installation.installed)
            self.assertIsNotNone(installation.exe_path)
            self.assertTrue(os.path.isfile(installation.exe_path or ""))
            self.assertRegex(installation.version or "", r"^\d+\.\d+\.\d+\.\d+$")
            self.assertEqual(installation.version, "4.1.15.13")
        else:
            self.assertFalse(installation.installed)
            self.assertTrue(installation.notes)

    def test_gui_operations_raise_desktop_unsupported_without_uia(self) -> None:
        if self.driver.uia_available:
            self.skipTest("本机已安装 pywinauto，无法测试 UIA 缺失降级路径")
        with tempfile.TemporaryDirectory() as tmp:
            operations = [
                ("open_moments_editor", lambda: self.driver.open_moments_editor()),
                ("fill_text", lambda: self.driver.fill_text("正文")),
                ("add_images", lambda: self.driver.add_images([])),
                ("read_back", lambda: self.driver.read_back()),
                ("set_visibility", lambda: self.driver.set_visibility("PUBLIC")),
                ("screenshot", lambda: self.driver.screenshot(os.path.join(tmp, "x.png"))),
                ("click_publish", lambda: self.driver.click_publish()),
                ("verify_published", lambda: self.driver.verify_published("正文", 0)),
            ]
            for name, operation in operations:
                with self.subTest(operation=name):
                    with self.assertRaises(ExecutorError) as context:
                        operation()
                    self.assertEqual(context.exception.code, "DESKTOP_UNSUPPORTED")

    def test_real_driver_health_reflects_environment(self) -> None:
        from desktop.server import ExecutorApp

        app = ExecutorApp(self.config, driver=self.driver, token="t" * 32)
        health = app.health()
        installation = self.driver.get_installation()
        self.assertEqual(health["wechatInstalled"], installation.installed)
        self.assertEqual(health["uiaAvailable"], self.driver.uia_available)
        if installation.installed:
            self.assertEqual(health["wechatVersion"], installation.version)
        else:
            self.assertIsNone(health["wechatVersion"])
        self.assertFalse(health["allowPublish"])
        self.assertEqual(health["mode"], "PREPARE_ONLY")


class WindowLocatorInjectionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.main_window = WindowInfo(
            hwnd=101,
            title="微信",
            class_name="WeixinMainWndForPC",
            process_id=900,
            process_name="Weixin.exe",
            rect=(0, 0, 1200, 800),
            visible=True,
            minimized=False,
            dpi_scale=1.25,
        )
        self.login_window = WindowInfo(
            hwnd=202,
            title="微信登录",
            class_name="WeChatLoginWndForPC",
            process_id=900,
            process_name="Weixin.exe",
            rect=(200, 200, 700, 600),
            visible=True,
            minimized=False,
            dpi_scale=1.0,
        )
        self.other_window = WindowInfo(
            hwnd=303,
            title="其他应用",
            class_name="Notepad",
            process_id=901,
            process_name="notepad.exe",
            rect=(0, 0, 400, 300),
            visible=True,
            minimized=False,
            dpi_scale=1.0,
        )

    def test_find_main_window_prefers_wechat(self) -> None:
        locator = WindowLocator(windows=[self.other_window, self.login_window, self.main_window])
        found = locator.find_main_window()
        self.assertIsNotNone(found)
        self.assertEqual(found.hwnd, self.main_window.hwnd)

    def test_find_login_window(self) -> None:
        locator = WindowLocator(windows=[self.other_window, self.login_window])
        login = locator.find_login_window()
        self.assertIsNotNone(login)
        self.assertEqual(login.hwnd, self.login_window.hwnd)

    def test_fake_installation_and_interactive(self) -> None:
        installation = WechatInstallation(installed=True, exe_path=r"C:\fake\Weixin.exe", version="4.1.10.27")
        locator = WindowLocator(installation=installation, interactive=False, locked=True)
        self.assertTrue(locator.detect_installation().installed)
        interactive, locked, notes = locator.is_interactive_desktop()
        self.assertFalse(interactive)
        self.assertTrue(locked)
        self.assertTrue(notes)

    def test_process_list_injection(self) -> None:
        locator = WindowLocator(processes=[ProcessInfo(pid=1, name="Weixin.exe")])
        processes = locator.list_processes()
        self.assertEqual(processes[0].name, "Weixin.exe")

    def test_png_encoding(self) -> None:
        png = solid_png(3, 2, (255, 0, 0))
        self.assertTrue(png.startswith(b"\x89PNG\r\n\x1a\n"))
        self.assertIn(b"IHDR", png)
        rows = [b"\x00\x00\x00" * 2 for _ in range(2)]
        png2 = encode_png_rgb(2, 2, rows)
        self.assertIn(b"IDAT", png2)


class AccountGuardTest(unittest.TestCase):
    def status(self, **overrides: object) -> WechatStatus:
        values: dict[str, object] = {
            "running": True,
            "logged_in": True,
            "account_id": "wxid_ok",
            "version": "4.1.10.27",
            "interactive": True,
            "locked": False,
            "supported": True,
        }
        values.update(overrides)
        return WechatStatus(**values)  # type: ignore[arg-type]

    def test_desktop_locked(self) -> None:
        guard = AccountGuard()
        with self.assertRaises(ExecutorError) as context:
            guard.ensure_prepare_ready(self.status(interactive=False, locked=True), "wxid_ok")
        self.assertEqual(context.exception.code, "INTERACTIVE_DESKTOP_UNAVAILABLE")

    def test_not_running(self) -> None:
        guard = AccountGuard()
        with self.assertRaises(ExecutorError) as context:
            guard.ensure_prepare_ready(self.status(running=False), "wxid_ok")
        self.assertEqual(context.exception.code, "WECHAT_NOT_RUNNING")

    def test_not_logged_in(self) -> None:
        guard = AccountGuard()
        with self.assertRaises(ExecutorError) as context:
            guard.ensure_prepare_ready(self.status(logged_in=False), "wxid_ok")
        self.assertEqual(context.exception.code, "WECHAT_NOT_LOGGED_IN")

    def test_account_unknown(self) -> None:
        guard = AccountGuard()
        with self.assertRaises(ExecutorError) as context:
            guard.ensure_prepare_ready(self.status(account_id=None), "wxid_ok")
        self.assertEqual(context.exception.code, "ACCOUNT_MISMATCH")

    def test_account_mismatch(self) -> None:
        guard = AccountGuard(expected_account_id="wxid_expected")
        with self.assertRaises(ExecutorError) as context:
            guard.ensure_prepare_ready(self.status(account_id="wxid_actual"), "wxid_actual")
        self.assertEqual(context.exception.code, "ACCOUNT_MISMATCH")

    def test_expected_account_mismatch_with_request(self) -> None:
        guard = AccountGuard(expected_account_id="wxid_expected")
        with self.assertRaises(ExecutorError) as context:
            guard.ensure_prepare_ready(self.status(account_id="wxid_expected"), "wxid_other")
        self.assertEqual(context.exception.code, "ACCOUNT_MISMATCH")

    def test_uia_missing(self) -> None:
        guard = AccountGuard()
        with self.assertRaises(ExecutorError) as context:
            guard.ensure_prepare_ready(self.status(), "wxid_ok", uia_available=False)
        self.assertEqual(context.exception.code, "DESKTOP_UNSUPPORTED")

    def test_version_unsupported(self) -> None:
        guard = AccountGuard(supported_versions=("4.1.10.27",))
        with self.assertRaises(ExecutorError) as context:
            guard.ensure_prepare_ready(self.status(supported=False, version="4.1.15.13"), "wxid_ok")
        self.assertEqual(context.exception.code, "CLIENT_VERSION_UNSUPPORTED")

    def test_all_checks_pass(self) -> None:
        guard = AccountGuard(expected_account_id="wxid_ok", supported_versions=("4.1.10.27",))
        guard.ensure_prepare_ready(self.status(), "wxid_ok")
        guard.ensure_publish_ready(self.status(), "wxid_ok")


if __name__ == "__main__":
    unittest.main(verbosity=2)
