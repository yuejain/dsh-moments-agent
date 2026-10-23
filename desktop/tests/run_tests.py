#!/usr/bin/env python3
"""一键运行 DSH Moments Agent 桌面执行器测试。

用法：
    python desktop/tests/run_tests.py
    python desktop/tests/run_tests.py -v

全部测试只使用 Python 标准库 unittest，不联网、不启动真实微信、不点击桌面。
"""
from __future__ import annotations

import argparse
import pathlib
import sys
import unittest

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent.parent
for search_path in (str(ROOT), str(HERE)):
    if search_path not in sys.path:
        sys.path.insert(0, search_path)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="运行桌面执行器单元测试（unittest）")
    parser.add_argument("-v", "--verbose", action="store_true", help="输出每个测试名称")
    parser.add_argument("-p", "--pattern", default="test_*.py", help="测试文件匹配模式")
    args = parser.parse_args(argv)
    loader = unittest.TestLoader()
    suite = loader.discover(str(HERE), pattern=args.pattern)
    runner = unittest.TextTestRunner(verbosity=2 if args.verbose else 1)
    result = runner.run(suite)
    total = result.testsRun
    if result.wasSuccessful():
        print(f"\n全部通过：{total} 个测试（跳过 {len(result.skipped)}）")
        return 0
    print(
        f"\n存在失败：运行 {total}，失败 {len(result.failures)}，"
        f"错误 {len(result.errors)}，跳过 {len(result.skipped)}"
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
