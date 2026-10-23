"""安全边界测试：回环绑定、token、路径越界/符号链接、配置加载、日志脱敏。"""
from __future__ import annotations

import hashlib
import io
import json
import logging
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
import uuid

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent.parent
for search_path in (str(ROOT), str(HERE)):
    if search_path not in sys.path:
        sys.path.insert(0, search_path)

from desktop import server as desktop_server  # noqa: E402
from desktop.config import (  # noqa: E402
    ConfigError,
    ExecutorConfig,
    PathGuardError,
    describe_config,
    ensure_directory_under,
    is_within,
    load_config_file,
    load_or_create_token,
    normalize_path,
    redact_meta,
    redact_text,
    resolve_under,
    safe_filename_component,
)
from desktop.server import ExecutorApp  # noqa: E402
from desktop.wechat_driver import FakeWechatDriver  # noqa: E402
from desktop.window_locator import solid_png  # noqa: E402
from test_server import TOKEN, HttpHarness  # noqa: E402


class BindHostSecurityTest(unittest.TestCase):
    def test_non_loopback_host_rejected(self) -> None:
        for host in ("0.0.0.0", "192.168.1.10", "example.com", "::"):
            with self.subTest(host=host):
                config = ExecutorConfig(host=host)
                with self.assertRaises(ConfigError):
                    config.validate()

    def test_non_loopback_cli_refuses_to_start(self) -> None:
        for host in ("0.0.0.0", "10.0.0.5"):
            with self.subTest(host=host):
                exit_code = desktop_server.main(["--host", host, "--port", "0"])
                self.assertEqual(exit_code, 2)

    def test_loopback_hosts_accepted(self) -> None:
        for host in ("127.0.0.1", "localhost", "LOCALHOST"):
            with self.subTest(host=host):
                config = ExecutorConfig(host=host)
                config.validate()
                self.assertEqual(config.bind_host, "127.0.0.1")

    def test_invalid_port_and_mode_rejected(self) -> None:
        with self.assertRaises(ConfigError):
            ExecutorConfig(port=70000).validate()
        with self.assertRaises(ConfigError):
            ExecutorConfig(mode="AUTO_PUBLISH").validate()

    def test_allow_publish_requires_approval_mode(self) -> None:
        self.assertFalse(ExecutorConfig(allow_publish=True, mode="PREPARE_ONLY").effective_allow_publish)
        self.assertTrue(ExecutorConfig(allow_publish=True, mode="APPROVAL_REQUIRED").effective_allow_publish)
        self.assertFalse(ExecutorConfig(allow_publish=False, mode="APPROVAL_REQUIRED").effective_allow_publish)


class TokenTest(unittest.TestCase):
    def test_auto_generation_and_reuse(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            token_file = os.path.join(tmp, "desktop-token.txt")
            token = load_or_create_token(token_file)
            self.assertRegex(token, r"^[0-9a-f]{64}$")
            self.assertTrue(os.path.isfile(token_file))
            self.assertEqual(load_or_create_token(token_file), token)

    def test_env_token_used_when_no_file(self) -> None:
        token = load_or_create_token(None, env_token="e" * 40)
        self.assertEqual(token, "e" * 40)
        with self.assertRaises(ConfigError):
            load_or_create_token(None, env_token="short")

    def test_short_token_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            token_file = os.path.join(tmp, "bad-token.txt")
            pathlib.Path(token_file).write_text("too-short", encoding="utf-8")
            with self.assertRaises(ConfigError):
                load_or_create_token(token_file)

    def test_missing_token_source_raises(self) -> None:
        with self.assertRaises(ConfigError):
            load_or_create_token(None)


class ConfiguredPathsTest(unittest.TestCase):
    def test_flat_config_file_loaded(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config_path = os.path.join(tmp, "desktop-executor.example.json")
            payload = {
                "host": "127.0.0.1",
                "port": 18765,
                "mode": "APPROVAL_REQUIRED",
                "allowPublish": False,
                "tokenFile": "token.txt",
                "screenshotDir": "shots",
                "assetRoots": ["assets"],
                "logFile": "desktop.log",
                "expectedAccountId": "wxid_example",
                "supportedVersions": ["4.1.10.27"],
            }
            pathlib.Path(config_path).write_text(json.dumps(payload), encoding="utf-8")
            config = load_config_file(config_path)
            self.assertEqual(config.mode, "APPROVAL_REQUIRED")
            self.assertFalse(config.effective_allow_publish)
            # 配置内相对路径按启动时工作目录解析（与 CLI 一致）。
            self.assertEqual(config.token_file, os.path.join(os.getcwd(), "token.txt"))
            self.assertEqual(config.screenshot_dir, os.path.join(os.getcwd(), "shots"))
            self.assertEqual(config.asset_roots, (os.path.join(os.getcwd(), "assets"),))
            self.assertEqual(config.expected_account_id, "wxid_example")
            self.assertEqual(config.supported_versions, ("4.1.10.27",))

    def test_nested_moments_config_supported(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config_path = os.path.join(tmp, "moments.local.json")
            payload = {
                "publishMode": "PREPARE_ONLY",
                "dataDir": "data",
                "desktopExecutor": {
                    "enabled": True,
                    "baseUrl": "http://127.0.0.1:19000",
                    "tokenFile": "data/desktop-token.txt",
                },
                "wechatAgent": {"account": "wxid_nested"},
                "images": {"assetDir": "assets"},
                "policy": {"maxTextLength": 500, "maxImages": 3},
            }
            pathlib.Path(config_path).write_text(json.dumps(payload), encoding="utf-8")
            config = load_config_file(config_path)
            self.assertEqual(config.port, 19000)
            self.assertEqual(config.mode, "PREPARE_ONLY")
            self.assertEqual(config.expected_account_id, "wxid_nested")
            self.assertEqual(config.max_text_length, 500)
            self.assertEqual(config.max_images, 3)
            self.assertTrue(config.screenshot_dir.endswith(os.path.join("data", "desktop", "screenshots")))

    def test_cli_overrides_config_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config_path = os.path.join(tmp, "cfg.json")
            pathlib.Path(config_path).write_text(
                json.dumps({"port": 19001, "mode": "PREPARE_ONLY"}), encoding="utf-8"
            )
            parser = desktop_server.build_parser()
            args = parser.parse_args(["--config", config_path, "--port", "0", "--mode", "APPROVAL_REQUIRED"])
            config = desktop_server.build_config(args)
            self.assertEqual(config.port, 0)
            self.assertEqual(config.mode, "APPROVAL_REQUIRED")

    def test_non_loopback_config_file_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config_path = os.path.join(tmp, "cfg.json")
            pathlib.Path(config_path).write_text(json.dumps({"host": "0.0.0.0"}), encoding="utf-8")
            with self.assertRaises(ConfigError):
                load_config_file(config_path)


class PathGuardTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp(prefix="dsh-path-test-")
        self.addCleanup(lambda: shutil.rmtree(self.tmp, ignore_errors=True))
        self.root = pathlib.Path(self.tmp) / "allowed"
        self.root.mkdir()
        self.outside = pathlib.Path(self.tmp) / "outside"
        self.outside.mkdir()
        self.asset = self.root / "a.png"
        self.asset.write_bytes(b"\x89PNG\r\n\x1a\n")
        self.outside_asset = self.outside / "b.png"
        self.outside_asset.write_bytes(b"\x89PNG\r\n\x1a\n")

    def test_inside_root_allowed(self) -> None:
        resolved = resolve_under((str(self.root),), str(self.asset), must_exist_file=True)
        self.assertEqual(resolved, os.path.abspath(str(self.asset)))
        self.assertTrue(is_within(str(self.root), resolved))

    def test_parent_escape_rejected(self) -> None:
        with self.assertRaises(PathGuardError):
            resolve_under((str(self.root),), str(self.root / ".." / "outside" / "b.png"))

    def test_absolute_outside_rejected(self) -> None:
        with self.assertRaises(PathGuardError):
            resolve_under((str(self.root),), str(self.outside_asset))

    def test_dotdot_in_raw_path_rejected(self) -> None:
        with self.assertRaises(PathGuardError):
            resolve_under((str(self.root),), str(self.root / ".." / ".." / "etc" / "passwd"))

    def test_missing_file_rejected(self) -> None:
        with self.assertRaises(PathGuardError):
            resolve_under((str(self.root),), str(self.root / "missing.png"), must_exist_file=True)

    def test_symlink_rejected(self) -> None:
        link = self.root / "link.png"
        try:
            os.symlink(str(self.outside_asset), str(link))
        except (OSError, NotImplementedError):
            self.skipTest("当前环境不允许创建符号链接")
        with self.assertRaises(PathGuardError):
            resolve_under((str(self.root),), str(link), must_exist_file=True)

    def test_symlink_parent_rejected(self) -> None:
        link_dir = self.root / "linked-dir"
        try:
            os.symlink(str(self.outside), str(link_dir), target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("当前环境不允许创建目录符号链接")
        with self.assertRaises(PathGuardError):
            resolve_under((str(self.root),), str(link_dir / "b.png"), must_exist_file=True)

    def test_directory_junction_rejected(self) -> None:
        """目录联接（junction）同样是重解析点，必须拒绝；创建无需管理员权限。"""
        if os.name != "nt":
            self.skipTest("junction 是 Windows 特性")
        junction = self.root / "junction-dir"
        result = subprocess.run(
            ["cmd", "/c", "mklink", "/J", str(junction), str(self.outside)],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode != 0 or not junction.exists():
            self.skipTest(f"当前环境不允许创建目录联接：{result.stderr or result.stdout}")
        self.addCleanup(lambda: shutil.rmtree(str(junction), ignore_errors=True))
        with self.assertRaises(PathGuardError):
            resolve_under((str(self.root),), str(junction / "b.png"), must_exist_file=True)

    def test_alternate_data_stream_rejected(self) -> None:
        if os.name != "nt":
            self.skipTest("ADS 是 Windows 特性")
        with self.assertRaises(PathGuardError):
            normalize_path(str(self.asset) + ":evil")

    def test_ensure_directory_inside_root(self) -> None:
        target = os.path.join(str(self.root), "screenshots", "nested")
        created = ensure_directory_under((str(self.root),), target)
        self.assertTrue(os.path.isdir(created))
        with self.assertRaises(PathGuardError):
            ensure_directory_under((str(self.root),), str(self.outside / "nested"))

    def test_safe_filename_component(self) -> None:
        self.assertEqual(safe_filename_component("att_2026-01-01"), "att_2026-01-01")
        for value in ("../escape", "a/b", "a\\b", "", "x" * 129, "中文"):
            with self.subTest(value=value):
                with self.assertRaises(PathGuardError):
                    safe_filename_component(value)

    def test_http_prepare_rejects_symlinked_or_junction_asset(self) -> None:
        harness = HttpHarness()
        self.addCleanup(harness.close)
        link = harness.asset_root / "link.png"
        linked = False
        try:
            os.symlink(str(self.outside_asset), str(link))
            linked = True
        except (OSError, NotImplementedError):
            linked = False
        if not linked and os.name == "nt":
            # 无符号链接权限时退回目录联接（junction），同样是重解析点。
            junction = harness.asset_root / "linked-dir"
            result = subprocess.run(
                ["cmd", "/c", "mklink", "/J", str(junction), str(self.outside)],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if result.returncode == 0 and junction.exists():
                self.addCleanup(lambda: shutil.rmtree(str(junction), ignore_errors=True))
                link = junction / "b.png"
                linked = True
        if not linked:
            self.skipTest("当前环境不允许创建符号链接或目录联接")
        payload = harness.prepare_payload(asset_count=0)
        payload["assetPaths"] = [str(link)]
        status, body = harness.http_json("POST", "/moments/prepare", payload)
        self.assertEqual(status, 200)
        self.assertEqual(body["errorCode"], "BAD_REQUEST")


class RedactionTest(unittest.TestCase):
    def test_meta_redaction(self) -> None:
        token = "a" * 64
        redacted = redact_meta(
            {
                "token": token,
                "text": "很私密的朋友圈正文",
                "content": "正文",
                "accountId": "wxid_visible",
                "attemptId": "att_1",
            }
        )
        self.assertEqual(redacted["token"], "***")
        self.assertEqual(redacted["text"], "***")
        self.assertEqual(redacted["content"], "***")
        self.assertEqual(redacted["attemptId"], "att_1")
        self.assertNotIn(token, json.dumps(redacted))

    def test_redact_text_removes_token(self) -> None:
        token = "b" * 64
        self.assertNotIn(token, redact_text(f"错误：{token}", token))

    def test_describe_config_has_no_token(self) -> None:
        config = ExecutorConfig(token="secret-token-" + "c" * 40)
        description = describe_config(config)
        serialized = json.dumps(description, ensure_ascii=False)
        self.assertNotIn("secret-token", serialized)
        self.assertNotIn("token", serialized.lower().replace("tokenfile", ""))

    def test_unauthorized_response_does_not_echo_token(self) -> None:
        harness = HttpHarness()
        self.addCleanup(harness.close)
        response = harness.request("GET", "/health", token="z" * 64)
        self.assertEqual(response.status, 401)
        self.assertNotIn("z" * 64, response.text)
        self.assertNotIn(TOKEN, response.text)

    def test_business_error_does_not_echo_token(self) -> None:
        harness = HttpHarness()
        self.addCleanup(harness.close)
        payload = harness.prepare_payload(asset_count=0)
        payload["assetPaths"] = [str(harness.root / "missing.png")]
        _, body = harness.http_json("POST", "/moments/prepare", payload)
        self.assertNotIn(TOKEN, json.dumps(body))

    def test_runtime_logs_do_not_contain_token_or_text(self) -> None:
        """执行器运行日志不得包含 token 或朋友圈正文。"""
        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        handler.setFormatter(logging.Formatter("%(message)s"))
        logger = logging.getLogger("test-desktop-redaction")
        logger.handlers.clear()
        logger.addHandler(handler)
        logger.setLevel(logging.DEBUG)
        logger.propagate = False

        with tempfile.TemporaryDirectory() as tmp:
            screenshot_dir = pathlib.Path(tmp) / "screenshots"
            screenshot_dir.mkdir()
            asset_root = pathlib.Path(tmp) / "assets"
            asset_root.mkdir()
            asset = asset_root / "a.png"
            asset.write_bytes(solid_png(2, 2))
            config = ExecutorConfig(
                token=None,
                log_file=None,
                screenshot_dir=str(screenshot_dir),
                asset_roots=(str(asset_root),),
                supported_versions=("4.1.10.27",),
                status_timeout=2.0,
                prepare_timeout=2.0,
                verify_timeout=1.0,
            )
            secret_text = "非常私密的正文内容ABC123"
            app = ExecutorApp(config, driver=FakeWechatDriver(), token=TOKEN, logger=logger)
            payload = {
                "taskId": "task_log_001",
                "attemptId": "att_log_001",
                "text": secret_text,
                "assetPaths": [str(asset)],
                "visibility": "PUBLIC",
                "contentHash": hashlib.sha256(secret_text.encode("utf-8")).hexdigest(),
                "accountId": "wxid_fake_account",
                "screenshotDir": str(screenshot_dir),
            }
            result = app.prepare(payload)
            self.assertTrue(result["ok"], msg=str(result))
        output = stream.getvalue()
        self.assertNotIn(TOKEN, output)
        self.assertNotIn(secret_text, output)
        self.assertNotIn("非常私密", output)
        self.assertIn("att_log_001", output)


if __name__ == "__main__":
    unittest.main(verbosity=2)
