"""client/api_client.py 的 unittest。

使用 127.0.0.1 随机端口的假管理 API，不访问网络、不依赖真实插件。
运行：``<DSH python> -m unittest discover -s client/tests -v``
"""

from __future__ import annotations

import json
import secrets
import unittest
from pathlib import Path

from client.api_client import (
    DEFAULT_TIMEOUT,
    PREPARE_TIMEOUT,
    PUBLISH_TIMEOUT,
    WORKFLOW_TIMEOUT,
    AdminApiClient,
    ApiError,
    normalize_base_url,
)
from client.tests import make_test_tmp
from client.tests.fake_admin_server import FakeAdminServer


class ApiClientTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = make_test_tmp("moments-client-test-")
        self.addCleanup(self._tmp.cleanup)
        self.server = FakeAdminServer().start()
        self.addCleanup(self.server.stop)
        self.token_file = Path(self._tmp.name) / "admin-token.txt"
        self._write_token(self.server.token)
        self.client = AdminApiClient(self.server.base_url, self.token_file)

    # -- 辅助 ----------------------------------------------------------
    def _write_token(self, token: str) -> None:
        self.token_file.write_text(token + "\n", encoding="utf-8")

    def _client(self, **kwargs: object) -> AdminApiClient:
        return AdminApiClient(self.server.base_url, self.token_file, **kwargs)  # type: ignore[arg-type]

    def assert_no_token(self, text: str, token: str) -> None:
        self.assertNotIn(token, text)
        self.assertNotIn(token[:16], text)

    def assert_api_error(self, error: ApiError, *, kind: str, status: int | None = None) -> None:
        self.assertIsInstance(error, ApiError)
        self.assertEqual(error.kind, kind, msg=str(error))
        if status is not None:
            self.assertEqual(error.status, status)


class TestTokenHandling(ApiClientTestBase):
    def test_reads_token_from_file_and_sends_header(self) -> None:
        health = self.client.health()
        self.assertEqual(health["plugin"], "dsh-moments-agent")
        request = self.server.last_request
        assert request is not None
        self.assertEqual(request["method"], "GET")
        self.assertEqual(request["path"], "/api/health")
        self.assertEqual(request["headers"]["x-moments-token"], self.server.token)

    def test_missing_token_file_is_config_error_and_sends_no_request(self) -> None:
        missing = Path(self._tmp.name) / "does-not-exist.txt"
        client = AdminApiClient(self.server.base_url, missing)
        with self.assertRaises(ApiError) as ctx:
            client.health()
        self.assert_api_error(ctx.exception, kind="config")
        self.assertIn("令牌文件", ctx.exception.user_message())
        self.assertEqual(self.server.requests, [])

    def test_empty_token_file_is_config_error(self) -> None:
        self._write_token("   ")
        with self.assertRaises(ApiError) as ctx:
            self.client.health()
        self.assert_api_error(ctx.exception, kind="config")
        self.assertIn("为空", str(ctx.exception))

    def test_short_token_file_is_config_error(self) -> None:
        self._write_token("short-token")
        with self.assertRaises(ApiError) as ctx:
            self.client.health()
        self.assert_api_error(ctx.exception, kind="config")
        self.assertIn("过短", str(ctx.exception))

    def test_token_file_is_read_on_every_request(self) -> None:
        self.client.health()
        other = secrets.token_hex(32)
        self._write_token(other)
        with self.assertRaises(ApiError) as ctx:
            self.client.health()
        self.assert_api_error(ctx.exception, kind="auth", status=401)
        self._write_token(self.server.token)
        self.assertEqual(self.client.health()["plugin"], "dsh-moments-agent")

    def test_token_never_appears_in_errors_or_client_state(self) -> None:
        wrong = secrets.token_hex(32)
        self._write_token(wrong)
        with self.assertRaises(ApiError) as ctx:
            self.client.health()
        error = ctx.exception
        self.assert_no_token(str(error), wrong)
        self.assert_no_token(error.user_message(), wrong)
        self.assert_no_token(repr(error), wrong)
        self.assert_no_token(repr(self.client.__dict__), wrong)
        # 请求体里也不应该出现令牌
        request = self.server.last_request
        assert request is not None
        self.assertNotIn(wrong.encode("utf-8"), request["body_raw"])
        self.assertNotIn(wrong, json.dumps(request["body"], ensure_ascii=False))


class TestReadEndpoints(ApiClientTestBase):
    def test_health(self) -> None:
        health = self.client.health()
        self.assertTrue(health["ok"])
        self.assertEqual(health["database"], "ok")
        self.assertIn("counts", health)

    def test_status(self) -> None:
        status = self.client.status()
        self.assertEqual(status["accountId"], "wxid_demo_account")
        self.assertIn("control", status)

    def test_status_with_task_id_query(self) -> None:
        self.client.status("task_demo_0001")
        request = self.server.last_request
        assert request is not None
        self.assertEqual(request["path"], "/api/status")
        self.assertIn("taskId=task_demo_0001", request["raw_path"])

    def test_tasks(self) -> None:
        tasks = self.client.tasks(50)
        self.assertEqual(len(tasks), 1)
        self.assertEqual(tasks[0]["task"]["taskId"], "task_demo_0001")
        request = self.server.last_request
        assert request is not None
        self.assertIn("limit=50", request["raw_path"])

    def test_task_detail(self) -> None:
        detail = self.client.task_detail("task_demo_0001")
        self.assertEqual(detail["task"]["state"], "READY_FOR_APPROVAL")
        self.assertIn("preview", detail)
        self.assertEqual(detail["preview"]["contentHash"], detail["task"]["contentHash"])

    def test_approvals(self) -> None:
        approvals = self.client.approvals()
        self.assertEqual(len(approvals), 1)
        self.assertEqual(approvals[0]["approvalId"], "approval_demo_0001")

    def test_history(self) -> None:
        history = self.client.history()
        self.assertEqual(len(history["published"]), 1)
        self.assertEqual(len(history["ideas"]), 2)

    def test_persona_and_config(self) -> None:
        persona = self.client.persona()
        self.assertIn("soul", persona)
        self.assertIn("visualStyle", persona)
        config = self.client.config_summary()
        self.assertEqual(config["publishMode"], "PREPARE_ONLY")
        self.assertNotIn("token", json.dumps(config, ensure_ascii=False).lower())

    def test_asset_raw_returns_bytes_and_mime(self) -> None:
        data, mime = self.client.asset_raw("asset_demo_0001")
        self.assertEqual(mime, "image/png")
        self.assertTrue(data.startswith(b"\x89PNG\r\n\x1a\n"))
        request = self.server.last_request
        assert request is not None
        self.assertEqual(request["path"], "/api/assets/asset_demo_0001/raw")
        self.assertEqual(request["headers"]["x-moments-token"], self.server.token)

    def test_attempt_status_uses_status_endpoint(self) -> None:
        status = self.client.attempt_status("task_demo_0001")
        self.assertIn("attempts", status)
        request = self.server.last_request
        assert request is not None
        self.assertEqual(request["path"], "/api/status")


class TestWriteEndpoints(ApiClientTestBase):
    def test_workflow_draft_posts_json(self) -> None:
        result = self.client.workflow_draft(
            topic="测试主题",
            source_type="owner_topic",
            source_evidence="所有者指定",
            motivation="记录一下",
        )
        self.assertFalse(result["silent"])
        self.assertEqual(result["taskId"], "task_demo_0002")
        request = self.server.last_request
        assert request is not None
        self.assertEqual(request["method"], "POST")
        self.assertEqual(request["path"], "/api/workflow/draft")
        self.assertEqual(
            request["body"],
            {
                "topic": "测试主题",
                "sourceType": "owner_topic",
                "sourceEvidence": "所有者指定",
                "motivation": "记录一下",
            },
        )
        self.assertTrue(request["headers"]["content-type"].startswith("application/json"))

    def test_workflow_draft_empty_body(self) -> None:
        self.client.workflow_draft()
        request = self.server.last_request
        assert request is not None
        self.assertEqual(request["body"], {})

    def test_workflow_draft_silent(self) -> None:
        result = self.client.workflow_draft(topic="触发沉默")
        self.assertTrue(result["silent"])
        self.assertIn("reason", result)

    def test_compose_and_review(self) -> None:
        composed = self.client.compose("task_demo_0001", tone="克制", feedback="更具体一点")
        self.assertEqual(composed["review"]["passed"], True)
        request = self.server.last_request
        assert request is not None
        self.assertEqual(request["path"], "/api/tasks/task_demo_0001/compose")
        self.assertEqual(request["body"], {"tone": "克制", "feedback": "更具体一点"})
        reviewed = self.client.review("task_demo_0001")
        self.assertTrue(reviewed["review"]["passed"])
        request = self.server.last_request
        assert request is not None
        self.assertEqual(request["path"], "/api/tasks/task_demo_0001/review")

    def test_request_approval(self) -> None:
        result = self.client.request_approval("task_demo_0001")
        self.assertIn("approval", result)
        self.assertIn("request", result)
        request = self.server.last_request
        assert request is not None
        self.assertEqual(request["path"], "/api/tasks/task_demo_0001/request-approval")

    def test_prepare_posts(self) -> None:
        result = self.client.prepare("task_demo_0001")
        self.assertTrue(result["prepared"])
        self.assertFalse(result["task"]["state"] == "PUBLISHED")
        request = self.server.last_request
        assert request is not None
        self.assertEqual(request["path"], "/api/tasks/task_demo_0001/prepare")

    def test_publish_returns_business_error_code(self) -> None:
        with self.assertRaises(ApiError) as ctx:
            self.client.publish("task_demo_0001")
        error = ctx.exception
        self.assert_api_error(error, kind="business", status=200)
        self.assertEqual(error.error_code, "PUBLISH_MODE_DISABLED")
        self.assertIn("PUBLISH_MODE_DISABLED", error.user_message())
        request = self.server.last_request
        assert request is not None
        self.assertEqual(request["path"], "/api/tasks/task_demo_0001/publish")

    def test_cancel(self) -> None:
        result = self.client.cancel("task_demo_0001")
        self.assertEqual(result["state"], "CANCELLED")
        request = self.server.last_request
        assert request is not None
        self.assertEqual(request["path"], "/api/tasks/task_demo_0001/cancel")

    def test_approve_and_reject(self) -> None:
        approved = self.client.approve("approval_demo_0001", reason="同意")
        self.assertEqual(approved["status"], "approved")
        request = self.server.last_request
        assert request is not None
        self.assertEqual(request["path"], "/api/approvals/approval_demo_0001/approve")
        self.assertEqual(request["body"], {"reason": "同意"})
        rejected = self.client.reject("approval_demo_0001")
        self.assertEqual(rejected["status"], "rejected")
        request = self.server.last_request
        assert request is not None
        self.assertEqual(request["body"], {})

    def test_resolve_uncertain(self) -> None:
        result = self.client.resolve_uncertain("attempt_demo_0001", "PUBLISHED", "已在朋友圈人工核对")
        self.assertIn("attempt", result)
        request = self.server.last_request
        assert request is not None
        self.assertEqual(request["path"], "/api/uncertain/attempt_demo_0001/resolve")
        self.assertEqual(
            request["body"],
            {"resolution": "PUBLISHED", "note": "已在朋友圈人工核对"},
        )

    def test_resolve_uncertain_rejects_invalid_resolution_without_request(self) -> None:
        with self.assertRaises(ApiError) as ctx:
            self.client.resolve_uncertain("attempt_demo_0001", "MAYBE", "note")
        self.assert_api_error(ctx.exception, kind="config")
        self.assertEqual(self.server.requests, [])

    def test_verify_attempt_posts_to_new_endpoint(self) -> None:
        result = self.client.verify_attempt("attempt_demo_0001")
        self.assertTrue(result["verification"]["verified"])
        self.assertEqual(result["task"]["state"], "PUBLISHED")
        request = self.server.last_request
        assert request is not None
        self.assertEqual(request["method"], "POST")
        self.assertEqual(request["path"], "/api/attempts/attempt_demo_0001/verify")
        self.assertEqual(request["body"], {})

    def test_verify_missing_attempt_maps_to_http_error(self) -> None:
        with self.assertRaises(ApiError) as ctx:
            self.client.verify_attempt("attempt_missing")
        error = ctx.exception
        self.assert_api_error(error, kind="http", status=500)
        self.assertIn("发布尝试不存在", str(error))

    def test_control_actions(self) -> None:
        paused = self.client.pause(reason="测试暂停")
        self.assertTrue(paused["paused"])
        request = self.server.last_request
        assert request is not None
        self.assertEqual(request["path"], "/api/pause")
        self.assertEqual(request["body"], {"reason": "测试暂停"})
        resumed = self.client.resume()
        self.assertFalse(resumed["paused"])
        killed = self.client.kill()
        self.assertTrue(killed["killSwitch"])
        unkilled = self.client.unkill()
        self.assertFalse(unkilled["killSwitch"])


class TestErrorMapping(ApiClientTestBase):
    def test_401_maps_to_auth_error(self) -> None:
        self._write_token(secrets.token_hex(32))
        with self.assertRaises(ApiError) as ctx:
            self.client.health()
        error = ctx.exception
        self.assert_api_error(error, kind="auth", status=401)
        self.assertIn("认证失败", error.user_message())
        self.assertIn("adminServer", error.user_message())
        self.assert_no_token(str(error), self.client.token_file.read_text(encoding="utf-8"))

    def test_500_maps_to_http_error_with_server_message(self) -> None:
        self.server.fail_next_status = 500
        with self.assertRaises(ApiError) as ctx:
            self.client.health()
        error = ctx.exception
        self.assert_api_error(error, kind="http", status=500)
        self.assertIn("HTTP 500", str(error))
        self.assertIn("模拟内部错误", str(error))
        self.assertEqual(error.error_code, "INTERNAL_ERROR")

    def test_business_error_mapping(self) -> None:
        self.server.business_error = {
            "message": "内容已变化，请重新申请审批",
            "errorCode": "CONTENT_CHANGED",
        }
        with self.assertRaises(ApiError) as ctx:
            self.client.approve("approval_demo_0001")
        error = ctx.exception
        self.assert_api_error(error, kind="business", status=200)
        self.assertEqual(error.error_code, "CONTENT_CHANGED")
        self.assertIn("CONTENT_CHANGED", error.user_message())
        self.assertIn("内容已变化", str(error))

    def test_404_maps_to_http_error(self) -> None:
        with self.assertRaises(ApiError) as ctx:
            self.client.task_detail("task_not_exists")
        self.assert_api_error(ctx.exception, kind="http", status=404)
        self.assertIn("404", str(ctx.exception))

    def test_connection_refused_maps_to_connection_error(self) -> None:
        base_url = self.server.base_url
        self.server.stop()
        client = AdminApiClient(base_url, self.token_file)
        with self.assertRaises(ApiError) as ctx:
            client.health()
        error = ctx.exception
        self.assert_api_error(error, kind="connection")
        self.assertIn("无法连接", error.user_message())
        self.assertIn("adminServer", error.user_message())

    def test_timeout_maps_to_timeout_error(self) -> None:
        self.server.delay_seconds = 0.8
        fast_client = self._client(timeout=0.2)
        with self.assertRaises(ApiError) as ctx:
            fast_client.health()
        error = ctx.exception
        self.assert_api_error(error, kind="timeout")
        self.assertIn("超时", str(error))
        self.assertIn("不要重复提交", error.user_message())

    def test_invalid_json_maps_to_protocol_error(self) -> None:
        self.server.raw_next = (200, b"<html>not json</html>", "text/html; charset=utf-8")
        with self.assertRaises(ApiError) as ctx:
            self.client.health()
        self.assert_api_error(ctx.exception, kind="protocol", status=200)
        self.assertIn("JSON", str(ctx.exception))


class TestConfigurationValidation(unittest.TestCase):
    def test_non_loopback_rejected(self) -> None:
        with self.assertRaises(ApiError) as ctx:
            AdminApiClient("http://example.com:18766", "token-file")
        self.assertEqual(ctx.exception.kind, "config")
        self.assertIn("回环", ctx.exception.user_message())

    def test_missing_port_rejected(self) -> None:
        with self.assertRaises(ApiError) as ctx:
            AdminApiClient("http://127.0.0.1", "token-file")
        self.assertEqual(ctx.exception.kind, "config")

    def test_path_in_base_url_rejected(self) -> None:
        with self.assertRaises(ApiError) as ctx:
            AdminApiClient("http://127.0.0.1:18766/api", "token-file")
        self.assertEqual(ctx.exception.kind, "config")

    def test_normalize_accepts_loopback_forms(self) -> None:
        self.assertEqual(normalize_base_url("http://127.0.0.1:18766/"), "http://127.0.0.1:18766")
        self.assertEqual(normalize_base_url("http://localhost:18766"), "http://localhost:18766")
        self.assertEqual(normalize_base_url("http://[::1]:18766"), "http://[::1]:18766")

    def test_default_timeouts_within_required_range(self) -> None:
        client = AdminApiClient("http://127.0.0.1:18766", "token-file")
        for value in (client.timeout, client.workflow_timeout, client.prepare_timeout, client.publish_timeout):
            self.assertGreaterEqual(value, 10.0)
            self.assertLessEqual(value, 180.0)
        self.assertEqual(DEFAULT_TIMEOUT, 20.0)
        self.assertGreaterEqual(WORKFLOW_TIMEOUT, 90.0)
        self.assertGreaterEqual(PREPARE_TIMEOUT, 120.0)
        self.assertEqual(PUBLISH_TIMEOUT, 180.0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
