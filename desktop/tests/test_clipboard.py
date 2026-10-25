"""Exercise the actual ctypes boundary with fake Win32 handles; no desktop writes."""
import ctypes
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch
from desktop import wechat_driver as driver


class ClipboardTest(unittest.TestCase):
    def setUp(self):
        self.buffer = ctypes.create_string_buffer(4096)
        self.owner = 0x100000123
        self.handle = 0x200000456
        self.user = SimpleNamespace(
            CreateWindowExW=Mock(return_value=self.owner), DestroyWindow=Mock(return_value=1),
            OpenClipboard=Mock(return_value=1), CloseClipboard=Mock(return_value=1),
            EmptyClipboard=Mock(return_value=1), SetClipboardData=Mock(return_value=self.handle),
            GetClipboardSequenceNumber=Mock(return_value=42))
        self.kernel = SimpleNamespace(GlobalAlloc=Mock(return_value=self.handle),
            GlobalLock=Mock(return_value=ctypes.addressof(self.buffer)),
            GlobalUnlock=Mock(return_value=0), GlobalFree=Mock(return_value=None))
        for target, value in (('os.name', 'nt'), ('_load_user32', lambda: self.user),
                              ('_load_kernel32', lambda: self.kernel), ('time.sleep', Mock())):
            context = patch('desktop.wechat_driver.' + target, value)
            context.start()
            self.addCleanup(context.stop)
        driver._clipboard_write_state.sequence = None

    def test_unicode_and_64bit_handles_are_not_truncated(self):
        text = '中文剪贴板 🐟\n第二行'
        self.assertTrue(driver._set_clipboard_text(text))
        self.user.OpenClipboard.assert_called_once_with(self.owner)
        self.user.SetClipboardData.assert_called_once_with(13, self.handle)
        self.assertEqual(self.kernel.GlobalAlloc.restype, ctypes.c_void_p)
        self.assertEqual(self.kernel.GlobalLock.restype, ctypes.c_void_p)
        encoded = text.encode('utf-16-le') + b'\x00\x00'
        self.assertEqual(self.buffer.raw[:len(encoded)], encoded)
        self.kernel.GlobalFree.assert_not_called()
        self.user.CloseClipboard.assert_called_once()
        self.user.DestroyWindow.assert_called_once_with(self.owner)

    def test_clipboard_contention_is_retried(self):
        self.user.OpenClipboard.side_effect = [0, 0, 1]
        self.assertTrue(driver._set_clipboard_text('retry'))
        self.assertEqual(self.user.OpenClipboard.call_count, 3)

    def test_permanent_contention_does_not_empty_or_leak(self):
        self.user.OpenClipboard.return_value = 0
        self.assertFalse(driver._set_clipboard_text('busy'))
        self.assertEqual(self.user.OpenClipboard.call_count, 20)
        self.user.EmptyClipboard.assert_not_called()
        self.kernel.GlobalFree.assert_called_once_with(self.handle)
        self.user.CloseClipboard.assert_not_called()

    def test_failed_alloc_does_not_erase_existing_clipboard(self):
        self.kernel.GlobalAlloc.return_value = 0
        self.assertFalse(driver._set_clipboard_text('test'))
        self.user.EmptyClipboard.assert_not_called()

    def test_owner_window_failure_stops_before_allocation(self):
        self.user.CreateWindowExW.return_value = 0
        self.assertFalse(driver._set_clipboard_text('test'))
        self.kernel.GlobalAlloc.assert_not_called()

    def test_lock_empty_and_set_failures_free_the_handle(self):
        for function in (self.kernel.GlobalLock, self.user.EmptyClipboard, self.user.SetClipboardData):
            original = function.return_value
            function.return_value = 0
            self.kernel.GlobalFree.reset_mock()
            self.assertFalse(driver._set_clipboard_text('test'))
            self.kernel.GlobalFree.assert_called_once_with(self.handle)
            function.return_value = original

    def test_clear_only_clears_our_unchanged_content(self):
        self.assertTrue(driver._set_clipboard_text('test'))
        self.user.EmptyClipboard.reset_mock()
        driver._clear_clipboard()
        self.user.EmptyClipboard.assert_called_once()

    def test_clear_preserves_content_copied_by_user(self):
        self.assertTrue(driver._set_clipboard_text('test'))
        self.user.EmptyClipboard.reset_mock()
        self.user.GetClipboardSequenceNumber.return_value = 43
        driver._clear_clipboard()
        self.user.EmptyClipboard.assert_not_called()
