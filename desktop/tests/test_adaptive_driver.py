import tempfile
import unittest
from pathlib import Path
from dataclasses import replace
from test_geometry_driver import GeometryHarness, make_locator, make_ocr, main_window
from test_adaptive_locator import fixture
from desktop.config import ExecutorError


class AdaptiveDriverTest(unittest.TestCase):
    def test_diagnostic_maps_bitmap_to_negative_monitor_origin_without_click(self):
        with tempfile.TemporaryDirectory() as tmp:
            locator=make_locator()
            locator._fake_windows=[main_window(rect=(-1920,40,0,1120))]
            ocr,rows,word=fixture(960,540)
            harness=GeometryHarness(Path(tmp),locator=locator,ocr_responses=[ocr],frames=[(960,540,rows)])
            result=harness.driver.inspect_controls()
            self.assertEqual(harness.input.events,[])
            target=result['targets']['publish']
            self.assertEqual((target['screenX'],target['screenY']),(-1920+word.bbox.center[0]*2,40+word.bbox.center[1]*2))

    def test_window_moves_after_capture_blocks_click(self):
        with tempfile.TemporaryDirectory() as tmp:
            locator=make_locator()
            harness=GeometryHarness(Path(tmp),locator=locator)
            harness.driver._require_geometry_ready()
            rect=harness.driver._window.rect
            locator._fake_windows=[main_window(rect=(140,40,1340,940))]
            with self.assertRaises(ExecutorError):harness.driver._assert_window_unchanged(rect,101)
            self.assertEqual(harness.input.events,[])

    def test_unknown_window_navigation_uses_ocr_target(self):
        with tempfile.TemporaryDirectory() as tmp:
            locator=make_locator();locator._fake_windows=[main_window(rect=(100,200,1700,1200))]
            harness=GeometryHarness(Path(tmp),locator=locator,ocr_responses=[make_ocr('发现',words=(('发现',(50,300,40,20)),))])
            harness.driver._require_geometry_ready()
            harness.driver._click_named('discover')
            self.assertIn(('click',193,544),harness.input.events)

    def test_unknown_icon_layout_does_not_guess_camera(self):
        with tempfile.TemporaryDirectory() as tmp:
            locator=make_locator();locator._fake_windows=[replace(main_window(rect=(0,0,1600,1000)),dpi_scale=1.5)]
            harness=GeometryHarness(Path(tmp),locator=locator,ocr_responses=[make_ocr('朋友圈')])
            harness.driver._require_geometry_ready()
            with self.assertRaises(ExecutorError):harness.driver._camera_screen_point()
            self.assertEqual(harness.input.events,[])
