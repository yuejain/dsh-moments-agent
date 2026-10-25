"""纯标准库绿色「发表」按钮检测测试（不依赖 PIL / 真实微信）。"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from desktop.wechat4_geometry import (  # noqa: E402
    Point,
    detect_publish_button,
    detect_publish_button_rgb,
)

BACKGROUND = (245, 245, 245)
PUBLISH_GREEN = (43, 197, 124)


def make_rows(width: int = 1200, height: int = 900, rects=()) -> list[bytes]:
    """构造自上而下的 RGB 行；rects 为绿色矩形 (left, top, right, bottom)。"""
    rows: list[list[bytes]] = []
    for y in range(height):
        row = bytearray(bytes(BACKGROUND) * width)
        for left, top, right, bottom in rects:
            if top <= y <= bottom:
                row[left * 3 : (right + 1) * 3] = bytes(PUBLISH_GREEN) * (right - left + 1)
        rows.append(bytes(row))
    return rows


class FakePixelAccess:
    def __init__(self, image: "FakeImage") -> None:
        self.image = image

    def __getitem__(self, xy):
        return self.image.pixels.get(xy, self.image.background)


class FakeImage:
    """PIL.Image 的最小假接口，用于验证保留的 PIL 检测路径。"""

    def __init__(self, width: int, height: int, buttons=()) -> None:
        self.size = (width, height)
        self.background = BACKGROUND
        self.pixels: dict[tuple[int, int], tuple[int, int, int]] = {}
        for left, top, right, bottom in buttons:
            for y in range(top, bottom + 1):
                for x in range(left, right + 1):
                    self.pixels[(x, y)] = PUBLISH_GREEN

    def convert(self, _mode):
        return self

    def load(self):
        return FakePixelAccess(self)


class RgbPublishButtonTest(unittest.TestCase):
    def test_detects_green_button_center(self):
        rows = make_rows(rects=[(426, 654, 594, 697)])
        point = detect_publish_button_rgb(1200, 900, rows)
        self.assertIsNotNone(point)
        assert point is not None
        self.assertAlmostEqual(point.x, 510, delta=3)
        self.assertAlmostEqual(point.y, 675, delta=3)

    def test_returns_none_without_button(self):
        self.assertIsNone(detect_publish_button_rgb(1200, 900, make_rows()))

    def test_ignores_sidebar_green_selection(self):
        rows = make_rows(rects=[(100, 127, 462, 179), (426, 654, 594, 697)])
        point = detect_publish_button_rgb(1200, 900, rows)
        self.assertIsNotNone(point)
        assert point is not None
        self.assertGreater(point.x, 400)

    def test_returns_none_for_tiny_green_speck(self):
        rows = make_rows(rects=[(500, 650, 520, 660)])
        self.assertIsNone(detect_publish_button_rgb(1200, 900, rows))

    def test_row_count_mismatch_rejected(self):
        with self.assertRaises(ValueError):
            detect_publish_button_rgb(1200, 900, make_rows(1200, 899))

    def test_short_row_rejected(self):
        with self.assertRaises(ValueError):
            detect_publish_button_rgb(1200, 2, [b"\x00" * 10, b"\x00" * 10])

    def test_zero_size_returns_none(self):
        self.assertIsNone(detect_publish_button_rgb(0, 0, []))
        self.assertIsNone(detect_publish_button_rgb(1200, 0, []))

    def test_rgb_and_pil_paths_agree(self):
        rows = make_rows(rects=[(426, 654, 594, 697)])
        rgb_point = detect_publish_button_rgb(1200, 900, rows)
        image = FakeImage(1200, 900, buttons=[(426, 654, 594, 697)])
        pil_point = detect_publish_button(image)
        self.assertIsNotNone(rgb_point)
        self.assertIsNotNone(pil_point)
        assert rgb_point is not None and pil_point is not None
        self.assertAlmostEqual(rgb_point.x, pil_point.x, delta=3)
        self.assertAlmostEqual(rgb_point.y, pil_point.y, delta=3)
        self.assertIsInstance(rgb_point, Point)


if __name__ == "__main__":
    unittest.main()
