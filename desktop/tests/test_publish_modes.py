import unittest
from desktop.tests.test_server import HttpHarness


class ThreePublishModesTest(unittest.TestCase):
    def harness(self, mode):
        harness = HttpHarness(mode=mode, allow_publish=True)
        self.addCleanup(harness.close)
        return harness

    def test_direct_mode_publishes_without_approval_id_and_blocks_replay(self):
        h = self.harness("POLICY_AUTONOMOUS")
        payload, _ = h.prepare_ok(asset_count=0)
        request = h.publish_payload(payload, approval_id="")
        request["publishMode"] = "POLICY_AUTONOMOUS"
        _, result = h.http_json("POST", "/moments/publish", request)
        self.assertTrue(result["submitted"])
        _, replay = h.http_json("POST", "/moments/publish", request)
        self.assertEqual(replay["errorCode"], "ALREADY_SUBMITTED")

    def test_approval_mode_requires_nonempty_approval(self):
        h = self.harness("APPROVAL_REQUIRED")
        payload, _ = h.prepare_ok(asset_count=0)
        _, result = h.http_json("POST", "/moments/publish", h.publish_payload(payload, approval_id=""))
        self.assertFalse(result["submitted"])
        self.assertEqual(result["errorCode"], "APPROVAL_REQUIRED")

    def test_prepare_mode_cannot_publish_even_with_allow_flag(self):
        h = self.harness("PREPARE_ONLY")
        payload, _ = h.prepare_ok(asset_count=0)
        _, result = h.http_json("POST", "/moments/publish", h.publish_payload(payload))
        self.assertEqual(result["errorCode"], "PUBLISH_MODE_DISABLED")
        self.assertFalse(result["submitted"])

    def test_mismatched_mode_never_clicks(self):
        h = self.harness("POLICY_AUTONOMOUS")
        payload, _ = h.prepare_ok(asset_count=0)
        request = h.publish_payload(payload, approval_id="")
        request["publishMode"] = "APPROVAL_REQUIRED"
        _, result = h.http_json("POST", "/moments/publish", request)
        self.assertEqual(result["errorCode"], "PUBLISH_MODE_DISABLED")
        self.assertFalse(result["submitted"])
