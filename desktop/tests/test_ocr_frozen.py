"""Frozen OCR must execute in-process instead of recursively launching the EXE."""
import json
import sys
import time
import unittest
from unittest.mock import patch

from desktop.ocr import WindowsOcrProvider, default_ocr_python


class FrozenOcrTest(unittest.TestCase):
    def test_frozen_uses_executable_as_runtime_marker(self):
        with patch.object(sys, "frozen", True, create=True):
            self.assertEqual(default_ocr_python(), sys.executable)

    def test_helper_emits_json_without_subprocess(self):
        namespace = {}
        exec("def main(args):\n _emit({'ok': True, 'args': args})\n return 0", namespace)
        provider = WindowsOcrProvider(ocr_python=sys.executable)
        with patch.object(sys, "frozen", True, create=True), \
             patch("desktop.ocr.runpy.run_path", return_value=namespace), \
             patch("desktop.ocr.subprocess.run") as spawn:
            result = provider._run([sys.executable, "helper.py", "--check"], timeout=1)
        self.assertEqual(json.loads(result.stdout), {"ok": True, "args": ["--check"]})
        spawn.assert_not_called()

    def test_frozen_helper_respects_timeout(self):
        def slow_main(args):
            time.sleep(0.1)
            return 0
        provider = WindowsOcrProvider(ocr_python=sys.executable)
        with patch.object(sys, "frozen", True, create=True), \
             patch("desktop.ocr.runpy.run_path", return_value={"main": slow_main}):
            self.assertIsNone(provider._run([sys.executable, "helper.py", "--check"], timeout=0.001))
