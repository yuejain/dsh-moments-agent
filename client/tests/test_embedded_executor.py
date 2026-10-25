"""真实 HTTP 生命周期回归；驱动使用 FakeWechatDriver，不操作微信。"""
import argparse
import json
import os
from pathlib import Path
import socket
import tempfile
import threading
import time
import unittest
import urllib.request
from unittest.mock import patch

from client import server
from desktop.wechat_driver import FakeWechatDriver


class EmbeddedExecutorTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.args = argparse.Namespace(
            data_dir=self.tmp.name, expected_account="wxid_test", executor_port=0,
            client_version="4.1.10.27", allow_publish=False,
        )

    def test_default_config_preserves_account_and_publish_guard(self):
        self.args.expected_account = None
        with patch.dict(os.environ, {"DSH_MOMENTS_EXPECTED_ACCOUNT": ""}):
            config = server.build_executor_config(self.args)
            self.assertEqual(config.trusted_account_source, "uia")
            account = Path(self.tmp.name) / "desktop-account.txt"
            account.write_text("wxid_file\n", encoding="utf-8-sig")
            config = server.build_executor_config(self.args)
        self.assertEqual(config.expected_account_id, "wxid_file")
        self.assertEqual(config.trusted_account_source, "wechatagent")
        self.assertFalse(config.effective_allow_publish)
        self.assertFalse(config.effective_geometry_publish)
        self.assertEqual(config.asset_roots, (str(Path(self.tmp.name) / "assets"),))
        self.args.allow_publish = True
        config = server.build_executor_config(self.args)
        self.assertTrue(config.effective_geometry_publish)

    def test_client_and_executor_share_lifecycle_without_child_process(self):
        config = server.build_executor_config(self.args)
        created = []
        original = server.EmbeddedExecutor

        def create(config):
            embedded = original(config, driver=FakeWechatDriver())
            created.append(embedded)
            return embedded

        result = []
        with patch.object(server, "EmbeddedExecutor", side_effect=create), \
             patch.object(server.subprocess, "Popen", wraps=server.subprocess.Popen) as popen:
            runner = threading.Thread(target=lambda: result.append(server.run_server(
                "127.0.0.1", 0, server.DEFAULT_ADMIN_URL, str(Path(self.tmp.name) / "admin-token.txt"),
                self.tmp.name, False, executor_config=config,
            )), daemon=True)
            runner.start()
            try:
                deadline = time.monotonic() + 10
                while not created and runner.is_alive() and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertTrue(created, "执行器未完成启动")
                token = Path(config.token_file).read_text().strip()
                port = created[0].server.server_port
                request = urllib.request.Request(f"http://127.0.0.1:{port}/health", headers={"X-Moments-Token": token})
                with urllib.request.urlopen(request, timeout=5) as response:
                    self.assertTrue(json.load(response)["ok"])
                client_port = server.Handler.state.server.server_port
                with urllib.request.urlopen(f"http://127.0.0.1:{client_port}/api/client/executor", timeout=5) as response:
                    diagnostics = json.load(response)["data"]
                self.assertTrue(diagnostics["embedded"])
                self.assertEqual(diagnostics["pid"], os.getpid())
                self.assertTrue(diagnostics["accountConfigured"])
                self.assertNotIn("accountId", diagnostics["status"])
                self.assertNotIn("wxid_", json.dumps(diagnostics))
                request = urllib.request.Request(
                    f"http://127.0.0.1:{client_port}/api/client/shutdown", data=b"{}", method="POST",
                    headers={"X-Requested-With": "DSHMomentsClient"},
                )
                with urllib.request.urlopen(request, timeout=5) as response:
                    self.assertEqual(response.status, 200)
                runner.join(8)
                self.assertFalse(runner.is_alive())
                self.assertEqual(result, [0])
                self.assertFalse(created[0].thread.is_alive())
                for closed_port in (port, client_port):
                    with socket.socket() as probe:
                        self.assertNotEqual(probe.connect_ex(("127.0.0.1", closed_port)), 0)
                self.assertFalse(any("server.py" in str(call) for call in popen.call_args_list))
            finally:
                if runner.is_alive():
                    server.Handler.state.server.shutdown()
                    runner.join(8)
                if created:
                    for handler in list(created[0].app.logger.handlers):
                        created[0].app.logger.removeHandler(handler)
                        handler.close()

    def test_executor_bind_failure_aborts_client_and_releases_socket(self):
        from desktop.server import create_server as real_create_server
        config = server.build_executor_config(self.args)
        with socket.socket() as occupied:
            occupied.bind(("127.0.0.1", 0))
            occupied.listen()
            config.port = occupied.getsockname()[1]
            def create(config, **kwargs):
                kwargs["driver"] = FakeWechatDriver()
                return real_create_server(config, **kwargs)
            with patch("desktop.server.create_server", side_effect=create), \
                 patch.object(server, "launch_browser") as browser:
                result = server.run_server("127.0.0.1", 0, server.DEFAULT_ADMIN_URL,
                                           "unused", self.tmp.name, True, executor_config=config)
            self.assertEqual(result, 4)
            self.assertEqual(server.Handler.state.server.fileno(), -1)
            browser.assert_not_called()
        import logging
        logger = logging.getLogger("dsh_moments.desktop.server")
        for handler in list(logger.handlers):
            logger.removeHandler(handler)
            handler.close()

    @unittest.skipUnless(os.name == "nt", "Windows UAC")
    def test_non_admin_hands_off_whole_client_before_binding(self):
        with patch.object(server, "is_admin", return_value=False), \
             patch.object(server, "elevate_client", return_value=1) as elevate, \
             patch.object(server, "run_server") as run:
            args = ["--no-browser", "--data-dir", self.tmp.name]
            self.assertEqual(server.main(args), 1)
            elevate.assert_called_once_with(args)
            run.assert_not_called()

    def test_client_only_does_not_elevate_or_start_executor(self):
        with patch.object(server, "elevate_client") as elevate, \
             patch.object(server, "run_server", return_value=0) as run:
            self.assertEqual(server.main(["--client-only", "--no-browser"]), 0)
            self.assertIsNone(run.call_args.kwargs["executor_config"])
            elevate.assert_not_called()

    @unittest.skipUnless(os.name == "nt", "Windows UAC")
    def test_uac_cancel_and_quoted_arguments(self):
        with patch.object(server.ctypes.windll.shell32, "ShellExecuteW", return_value=5) as execute:
            self.assertEqual(server.elevate_client(["--data-dir", r"D:\中文 空格\data"]), 1)
            args = execute.call_args.args
            self.assertEqual(args[1], "runas")
            self.assertIn('"D:\\中文 空格\\data"', args[3])
            self.assertIn(str(Path(server.__file__).resolve()), args[3])
            self.assertEqual(args[5], 0)


if __name__ == "__main__":
    unittest.main()
