"""client/config.py 的 unittest：配置读写、相对路径、令牌不落盘。"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from client.api_client import ApiError
from client.config import (
    DEFAULT_BASE_URL,
    ClientSettings,
    ConfigError,
    load_settings,
    masked_settings,
    save_settings,
    token_file_state,
)
from client.tests import make_test_tmp


class TestClientSettings(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = make_test_tmp("moments-client-config-")
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name)
        self.config_path = self.tmp / "moments-client.json"

    def test_missing_config_file_uses_defaults(self) -> None:
        settings = load_settings(self.config_path)
        self.assertEqual(settings.base_url, DEFAULT_BASE_URL)
        self.assertTrue(settings.token_file.name.endswith("admin-token.txt"))
        self.assertTrue(settings.token_file.is_absolute())
        self.assertEqual(settings.config_path, self.config_path)

    def test_relative_paths_resolve_against_project_root(self) -> None:
        self.config_path.write_text(
            json.dumps({"baseUrl": "http://127.0.0.1:18766", "tokenFile": "data/admin-token.txt"}),
            encoding="utf-8",
        )
        settings = load_settings(self.config_path)
        self.assertTrue(settings.token_file.is_absolute())
        self.assertEqual(settings.token_file.name, "admin-token.txt")
        self.assertEqual(settings.token_file.parent.name, "data")

    def test_invalid_json_raises_config_error(self) -> None:
        self.config_path.write_text("{not json", encoding="utf-8")
        with self.assertRaises(ConfigError):
            load_settings(self.config_path)

    def test_non_loopback_base_url_raises_config_error(self) -> None:
        self.config_path.write_text(json.dumps({"baseUrl": "http://10.0.0.1:18766"}), encoding="utf-8")
        with self.assertRaises(ConfigError) as ctx:
            load_settings(self.config_path)
        self.assertIn("回环", str(ctx.exception))

    def test_save_and_reload_roundtrip(self) -> None:
        settings = ClientSettings(
            base_url="http://127.0.0.1:18766",
            token_file=self.tmp / "data" / "admin-token.txt",
            data_dir=self.tmp / "data",
            config_path=self.config_path,
        )
        saved = save_settings(settings, self.config_path)
        self.assertEqual(saved, self.config_path)
        payload = json.loads(self.config_path.read_text(encoding="utf-8"))
        self.assertEqual(payload["baseUrl"], "http://127.0.0.1:18766")
        self.assertEqual(payload["tokenFile"], str(self.tmp / "data" / "admin-token.txt"))
        reloaded = load_settings(self.config_path)
        self.assertEqual(reloaded.base_url, settings.base_url)
        self.assertEqual(reloaded.token_file, settings.token_file)

    def test_saving_never_writes_token_even_if_old_file_contains_it(self) -> None:
        fake_token = "deadbeef" * 8
        self.config_path.write_text(
            json.dumps(
                {
                    "baseUrl": "http://127.0.0.1:18766",
                    "tokenFile": str(self.tmp / "admin-token.txt"),
                    "token": fake_token,
                    "adminToken": fake_token,
                }
            ),
            encoding="utf-8",
        )
        settings = load_settings(self.config_path)
        save_settings(settings, self.config_path)
        text = self.config_path.read_text(encoding="utf-8")
        self.assertNotIn(fake_token, text)
        self.assertNotIn('"token"', text)
        self.assertNotIn("adminToken", text)

    def test_masked_settings_does_not_contain_token(self) -> None:
        token_file = self.tmp / "admin-token.txt"
        token_file.write_text("a" * 64 + "\n", encoding="utf-8")
        settings = ClientSettings(
            base_url="http://127.0.0.1:18766",
            token_file=token_file,
            data_dir=self.tmp,
            config_path=self.config_path,
        )
        masked = masked_settings(settings)
        serialized = json.dumps(masked, ensure_ascii=False)
        self.assertNotIn("a" * 64, serialized)
        self.assertTrue(masked["tokenFileExists"])
        self.assertIn("不显示", str(masked["token"]))
        self.assertEqual(masked["baseUrl"], "http://127.0.0.1:18766")

    def test_token_file_state_reports_existence_without_content(self) -> None:
        settings = ClientSettings(
            token_file=self.tmp / "missing.txt",
            config_path=self.config_path,
        )
        exists, message = token_file_state(settings)
        self.assertFalse(exists)
        self.assertIn("不存在", message)
        (self.tmp / "missing.txt").write_text("b" * 64, encoding="utf-8")
        exists, message = token_file_state(settings)
        self.assertTrue(exists)
        self.assertNotIn("b" * 64, message)

    def test_api_error_and_config_error_are_distinct(self) -> None:
        self.assertTrue(issubclass(ConfigError, Exception))
        self.assertTrue(issubclass(ApiError, Exception))
        self.assertFalse(issubclass(ConfigError, ApiError))


if __name__ == "__main__":
    unittest.main(verbosity=2)
