"""WeChat 4.x 几何测绘与像素检测测试（不依赖真实微信）。"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from desktop.wechat4_geometry import (  # noqa: E402
    KNOWN_PROFILES,
    Point,
    WeChat4Geometry,
    WindowRect,
    detect_publish_button,
)


class GeometryTest(unittest.TestCase):
    def test_known_1200_profile(self):
        geo = WeChat4Geometry(WindowRect(40, 40, 1200, 900))
        self.assertEqual(geo.camera_point(), Point(1144, 85))
        self.assertEqual(geo.to_screen(geo.camera_point()), Point(1184, 125))
        self.assertEqual(geo.publish_point(), Point(510, 675))
        self.assertEqual(geo.screen_point("publish"), Point(550, 715))

    def test_known_1342_profile_matches_real_click(self):
        geo = WeChat4Geometry(WindowRect(220, 1073, 1342, 971))
        # 第二轮真实点击点 (799,1834) 对应窗口内 (579,761)
        self.assertEqual(geo.screen_point("publish"), Point(799, 1834))
        self.assertEqual(geo.profile, (1342, 971))

    def test_unknown_size_scales_nearest_profile(self):
        geo = WeChat4Geometry(WindowRect(0, 0, 1600, 1000), profile=(1200, 900))
        self.assertEqual(geo.point("publish"), Point(680, 750))
        self.assertEqual(geo.point("camera"), Point(1525, 94))

    def test_as_dict_is_json_safe(self):
        geo = WeChat4Geometry(WindowRect(10, 20, 1200, 900))
        data = geo.as_dict()
        self.assertEqual(data["window"]["left"], 10)
        self.assertIn("publish", data["points"])
        self.assertEqual(data["points"]["publish"], {"x": 510, "y": 675})

    def test_profiles_contain_expected_keys(self):
        keys = set(KNOWN_PROFILES[(1200, 900)])
        self.assertTrue({"camera", "editor_text", "publish", "cancel"} <= keys)


class FakePixelAccess:
    def __init__(self, image: "FakeImage"):
        self.image = image

    def __getitem__(self, xy):
        return self.image.pixels.get(xy, self.image.background)


class FakeImage:
    """轻量假图，避免测试依赖 Pillow；接口与 PIL.Image 的最小子集一致。"""

    def __init__(self, width: int, height: int, buttons=()):
        self.size = (width, height)
        self.background = (245, 245, 245)
        self.pixels: dict[tuple[int, int], tuple[int, int, int]] = {}
        for left, top, right, bottom in buttons:
            for y in range(top, bottom + 1):
                for x in range(left, right + 1):
                    self.pixels[(x, y)] = (43, 197, 124)

    def convert(self, _mode):
        return self

    def load(self):
        return FakePixelAccess(self)


class PublishButtonDetectionTest(unittest.TestCase):
    @staticmethod
    def _image(width=1200, height=900, buttons=()):
        return FakeImage(width, height, buttons)

    def test_detects_green_button_center(self):
        image = self._image(buttons=[(426, 654, 594, 697)])
        point = detect_publish_button(image)
        self.assertIsNotNone(point)
        self.assertAlmostEqual(point.x, 510, delta=3)
        self.assertAlmostEqual(point.y, 675, delta=3)

    def test_ignores_sidebar_green_selection(self):
        image = self._image(buttons=[(100, 127, 462, 179), (426, 654, 594, 697)])
        point = detect_publish_button(image)
        self.assertIsNotNone(point)
        self.assertGreater(point.x, 400)

    def test_returns_none_without_button(self):
        self.assertIsNone(detect_publish_button(self._image()))

    def test_returns_none_for_tiny_green_speck(self):
        self.assertIsNone(detect_publish_button(self._image(buttons=[(500, 650, 520, 660)])))


if __name__ == "__main__":
    unittest.main()
