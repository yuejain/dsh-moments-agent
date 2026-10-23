"""账号来源复用（WeChatAgent 验证账号）与版本假定测试。"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from desktop.account_guard import AccountGuard  # noqa: E402
from desktop.config import ConfigError, ExecutorConfig, WechatStatus  # noqa: E402


def status(**overrides) -> WechatStatus:
    data = {
        "running": True,
        "logged_in": True,
        "account_id": None,
        "version": "4.1.10.27",
        "interactive": True,
        "locked": False,
        "supported": True,
    }
    data.update(overrides)
    return WechatStatus(**data)


class TrustedAccountTest(unittest.TestCase):
    def test_wechatagent_account_skips_uia_read(self):
        guard = AccountGuard(
            expected_account_id="wxid_test",
            supported_versions=("4.1.10.27",),
            trusted_account_source="wechatagent",
        )
        # 不依赖 UIA 读 wxid；请求账号与配置一致即可通过
        guard.ensure_prepare_ready(status(account_id=None), "wxid_test", uia_available=True)

    def test_wechatagent_account_mismatch_rejected(self):
        guard = AccountGuard(
            expected_account_id="wxid_test",
            supported_versions=("4.1.10.27",),
            trusted_account_source="wechatagent",
        )
        with self.assertRaises(Exception) as context:
            guard.ensure_prepare_ready(status(), "wxid_other", uia_available=True)
        self.assertEqual(getattr(context.exception, "code", None), "ACCOUNT_MISMATCH")

    def test_uia_mode_still_requires_actual_account(self):
        guard = AccountGuard(expected_account_id="wxid_test", supported_versions=("4.1.10.27",))
        with self.assertRaises(Exception) as context:
            guard.ensure_prepare_ready(status(account_id=None), "wxid_test", uia_available=True)
        self.assertEqual(getattr(context.exception, "code", None), "ACCOUNT_MISMATCH")

    def test_assumed_version_allows_supported_check(self):
        guard = AccountGuard(
            expected_account_id="wxid_test",
            supported_versions=("4.1.10.27",),
            trusted_account_source="wechatagent",
            assumed_client_version="4.1.10.27",
        )
        # 文件探测可能看到别的安装版本，显式假定版本后允许继续
        guard.ensure_prepare_ready(
            status(account_id=None, version="4.1.15.13", supported=False),
            "wxid_test",
            uia_available=True,
        )

    def test_config_requires_expected_account_for_wechatagent_source(self):
        config = ExecutorConfig(trusted_account_source="wechatagent")
        with self.assertRaises(ConfigError):
            config.validate()

    def test_config_assumed_version_must_be_supported(self):
        config = ExecutorConfig(
            expected_account_id="wxid_test",
            trusted_account_source="wechatagent",
            supported_versions=("4.1.10.27",),
            assumed_client_version="4.1.15.13",
        )
        with self.assertRaises(ConfigError):
            config.validate()

    def test_config_valid_combination(self):
        config = ExecutorConfig(
            expected_account_id="wxid_test",
            trusted_account_source="wechatagent",
            supported_versions=("4.1.10.27",),
            assumed_client_version="4.1.10.27",
        )
        config.validate()
        self.assertEqual(config.trusted_account_source, "wechatagent")
        self.assertEqual(config.assumed_client_version, "4.1.10.27")


if __name__ == "__main__":
    unittest.main()
