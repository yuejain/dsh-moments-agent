"""发布后核验器测试：只有证据齐全才 verified=True，否则降级 uncertain。"""
from __future__ import annotations

import os
import pathlib
import shutil
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent.parent
for search_path in (str(ROOT), str(HERE)):
    if search_path not in sys.path:
        sys.path.insert(0, search_path)

from desktop.config import ExecutorConfig, Verification  # noqa: E402
from desktop.moments_verifier import MomentsVerifier  # noqa: E402
from desktop.wechat_driver import FakeWechatDriver  # noqa: E402

TEXT = "测试正文：一条用于核验的朋友圈内容。"


class VerifierHarness:
    def __init__(self, driver: FakeWechatDriver | None = None) -> None:
        self.root = pathlib.Path(tempfile.mkdtemp(prefix="dsh-verifier-test-"))
        self.screenshot_dir = self.root / "screenshots"
        self.screenshot_dir.mkdir(parents=True, exist_ok=True)
        self.config = ExecutorConfig(
            token="t" * 32,
            log_file=None,
            screenshot_dir=str(self.screenshot_dir),
            asset_roots=(str(self.root / "assets"),),
            verify_timeout=1.5,
        )
        self.driver = driver if driver is not None else FakeWechatDriver()
        self.verifier = MomentsVerifier(self.driver, self.config)

    def evidence(self, name: str = "att_1-published.png") -> str:
        return str(self.screenshot_dir / name)

    def close(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)


class VerifierTest(unittest.TestCase):
    def make(self, driver: FakeWechatDriver | None = None) -> VerifierHarness:
        harness = VerifierHarness(driver)
        self.addCleanup(harness.close)
        return harness

    def test_verified_success(self) -> None:
        harness = self.make()
        harness.driver.open_moments_editor()
        harness.driver.click_publish()
        evidence = harness.evidence()
        verification = harness.verifier.verify(
            attempt_id="att_1",
            expected_text=TEXT,
            expected_image_count=0,
            evidence_path=evidence,
        )
        self.assertTrue(verification.verified)
        self.assertEqual(verification.visible_text, TEXT)
        self.assertEqual(verification.image_count, 0)
        self.assertIsNotNone(verification.published_at)
        self.assertEqual(verification.evidence_path, os.path.abspath(evidence))
        self.assertTrue(pathlib.Path(evidence).is_file())
        self.assertEqual(harness.driver.verify_count, 1)

    def test_uncertain_outcome(self) -> None:
        harness = self.make(FakeWechatDriver(publish_outcome="uncertain"))
        harness.driver.open_moments_editor()
        harness.driver.click_publish()
        verification = harness.verifier.verify(
            attempt_id="att_2",
            expected_text=TEXT,
            expected_image_count=0,
            evidence_path=harness.evidence("att_2-published.png"),
        )
        self.assertFalse(verification.verified)
        self.assertIsNone(verification.published_at)
        self.assertTrue(verification.notes)
        self.assertEqual(harness.driver.verify_count, 1)

    def test_driver_exception_becomes_unverified(self) -> None:
        harness = self.make(FakeWechatDriver(publish_outcome="verify_error"))
        harness.driver.open_moments_editor()
        harness.driver.click_publish()
        verification = harness.verifier.verify(
            attempt_id="att_3",
            expected_text=TEXT,
            expected_image_count=0,
            evidence_path=harness.evidence("att_3-published.png"),
        )
        self.assertFalse(verification.verified)
        self.assertTrue(any("核验失败" in note for note in verification.notes))
        self.assertEqual(harness.driver.verify_count, 1)

    def test_evidence_outside_allowed_root_is_rejected(self) -> None:
        class OutsideEvidenceDriver(FakeWechatDriver):
            def verify_published(self, expected_text, expected_image_count, *, evidence_path=None, timeout=None):  # type: ignore[no-untyped-def]
                self.verify_count += 1
                outside = str(harness.root / "outside.png")
                pathlib.Path(outside).write_bytes(b"\x89PNG\r\n\x1a\n")
                return Verification(
                    verified=True,
                    method="fake",
                    published_at="2026-01-01T00:00:00Z",
                    visible_text=expected_text,
                    image_count=expected_image_count,
                    evidence_path=outside,
                )

        harness = self.make(OutsideEvidenceDriver())
        harness.driver.open_moments_editor()
        harness.driver.click_publish()
        verification = harness.verifier.verify(
            attempt_id="att_4",
            expected_text=TEXT,
            expected_image_count=0,
        )
        self.assertFalse(verification.verified)
        self.assertTrue(any("截图" in note for note in verification.notes))

    def test_missing_visible_text_is_not_verified(self) -> None:
        class MissingTextDriver(FakeWechatDriver):
            def verify_published(self, expected_text, expected_image_count, *, evidence_path=None, timeout=None):  # type: ignore[no-untyped-def]
                self.verify_count += 1
                if evidence_path:
                    self.screenshot(evidence_path)
                return Verification(
                    verified=True,
                    method="fake",
                    published_at="2026-01-01T00:00:00Z",
                    visible_text=None,
                    image_count=expected_image_count,
                    evidence_path=evidence_path,
                )

        harness = self.make(MissingTextDriver())
        harness.driver.open_moments_editor()
        harness.driver.click_publish()
        verification = harness.verifier.verify(
            attempt_id="att_5",
            expected_text=TEXT,
            expected_image_count=0,
            evidence_path=harness.evidence("att_5-published.png"),
        )
        self.assertFalse(verification.verified)
        self.assertTrue(any("正文" in note for note in verification.notes))

    def test_image_count_mismatch_is_not_verified(self) -> None:
        class WrongImageCountDriver(FakeWechatDriver):
            def verify_published(self, expected_text, expected_image_count, *, evidence_path=None, timeout=None):  # type: ignore[no-untyped-def]
                self.verify_count += 1
                if evidence_path:
                    self.screenshot(evidence_path)
                return Verification(
                    verified=True,
                    method="fake",
                    published_at="2026-01-01T00:00:00Z",
                    visible_text=expected_text,
                    image_count=expected_image_count + 1,
                    evidence_path=evidence_path,
                )

        harness = self.make(WrongImageCountDriver())
        harness.driver.open_moments_editor()
        harness.driver.click_publish()
        verification = harness.verifier.verify(
            attempt_id="att_6",
            expected_text=TEXT,
            expected_image_count=0,
            evidence_path=harness.evidence("att_6-published.png"),
        )
        self.assertFalse(verification.verified)
        self.assertTrue(any("图片数量" in note for note in verification.notes))

    def test_invalid_attempt_id_does_not_call_driver(self) -> None:
        harness = self.make()
        verification = harness.verifier.verify(
            attempt_id="../evil",
            expected_text=TEXT,
            expected_image_count=0,
        )
        self.assertFalse(verification.verified)
        self.assertEqual(harness.driver.verify_count, 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
