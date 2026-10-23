"""客户端测试包的公共辅助。"""

from __future__ import annotations

import os
import secrets
import shutil
from pathlib import Path

# 测试临时目录必须位于工作区内：DSH 沙箱只允许写工作区和部分平台临时区，
# 系统 %TEMP% 下的目录可能创建成功但写入被拒绝。
TEST_TMP_ROOT = Path(__file__).resolve().parent / ".tmp"


class WorkspaceTempDir:
    """工作区内的临时目录。

    注意：不要使用 ``tempfile.TemporaryDirectory`` / ``tempfile.mkdtemp``。
    DSH 自带 Python 3.12 + 沙箱下，以 mode=0o700 创建的目录会被 ACL 限制，
    之后连当前进程都无法写入/删除；这里用默认 mode 的 ``os.makedirs``。
    """

    def __init__(self, prefix: str = "moments-client-") -> None:
        TEST_TMP_ROOT.mkdir(parents=True, exist_ok=True)
        self.name = str(TEST_TMP_ROOT / f"{prefix}{secrets.token_hex(4)}")
        os.makedirs(self.name)
        self._cleaned = False

    def cleanup(self) -> None:
        if self._cleaned:
            return
        self._cleaned = True
        shutil.rmtree(self.name, ignore_errors=True)

    def __enter__(self) -> "WorkspaceTempDir":
        return self

    def __exit__(self, *_exc: object) -> None:
        self.cleanup()


def make_test_tmp(prefix: str = "moments-client-") -> WorkspaceTempDir:
    return WorkspaceTempDir(prefix)


__all__ = ["TEST_TMP_ROOT", "WorkspaceTempDir", "make_test_tmp"]
