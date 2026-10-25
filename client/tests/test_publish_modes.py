import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from client import server
from desktop.config import ExecutorConfig


class ModeSynchronizationTest(unittest.TestCase):
    def state(self):
        app = SimpleNamespace(config=ExecutorConfig(mode="POLICY_AUTONOMOUS", allow_publish=True, geometry_allow_publish=True), _exec_lock=threading.Lock())
        return SimpleNamespace(executor=SimpleNamespace(app=app))

    def test_each_mode_updates_both_permissions(self):
        for mode in server.PUBLISH_MODES:
            state = self.state()
            with patch.object(server, "plugin_mode_request", return_value={"mode": mode}):
                result = server.change_publish_mode(state, {"mode": mode})
            self.assertTrue(result["synchronized"])
            self.assertEqual(state.executor.app.config.effective_allow_publish, mode != "PREPARE_ONLY")
            self.assertEqual(state.executor.app.config.effective_geometry_publish, mode != "PREPARE_ONLY")

    def test_uncertain_network_result_retains_prepare_only(self):
        state = self.state()
        with patch.object(server, "plugin_mode_request", side_effect=OSError("network")):
            with self.assertRaises(OSError):
                server.change_publish_mode(state, {"mode": "APPROVAL_REQUIRED"})
        self.assertEqual(state.executor.app.config.mode, "PREPARE_ONLY")
        self.assertFalse(state.executor.app.config.effective_allow_publish)
        self.assertTrue(state.executor.app._exec_lock.acquire(blocking=False))
        state.executor.app._exec_lock.release()

    def test_busy_executor_does_not_change_permissions(self):
        state = self.state()
        state.executor.app._exec_lock.acquire()
        with patch.object(server, "plugin_mode_request") as request:
            with self.assertRaises(ValueError):
                server.change_publish_mode(state, {"mode": "PREPARE_ONLY"})
            request.assert_not_called()
        self.assertEqual(state.executor.app.config.mode, "POLICY_AUTONOMOUS")
        state.executor.app._exec_lock.release()

    def test_invalid_mode_is_rejected(self):
        state = self.state()
        with self.assertRaises(ValueError):
            server.change_publish_mode(state, {"mode": "INVALID"})
        self.assertEqual(state.executor.app.config.mode, "POLICY_AUTONOMOUS")
