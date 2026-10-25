"""client/auto_configure.py 的单元测试。

约束（见 client/tests/README.md）：
- 全部使用工作区内默认权限临时目录（``make_test_tmp``），不使用 tempfile；
- 不联网、不枚举真实进程、不读取真实 profile / WeChatAgent 配置；
- 令牌只在内存中使用测试假值，任何断言输出都不包含令牌正文。
"""

from __future__ import annotations

import codecs
import contextlib
import io
import json
import subprocess
import sys
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from client import auto_configure
from client.auto_configure import (
    AutoConfigError,
    apply_plan,
    build_plan,
    merge_patch_text,
    public_summary,
    read_entry_literals,
    render_block,
)
from client.tests import make_test_tmp

PROJECT_ROOT = Path(__file__).resolve().parents[2]
NOW = datetime(2026, 10, 25, 18, 30, 0)
LATER = NOW + timedelta(hours=1)

READER_TOKEN = "TEST_READER_TOKEN_do_not_leak"
HOOK_TOKEN = "TEST_HOOK_TOKEN_do_not_leak"
OWN_WXID = "wxid_owner1234567890"
ACCOUNT_DIR = "wxid_account1234567890_abcd"
OLD_ACCOUNT = "wxid_oldaccount1234567890"
OTHER_ENTRY = "# 其他插件注释\n- id: other\n  name: other\n  config:\n    enabled: true\n"


def fwd(path) -> str:
    return str(Path(path).resolve()).replace("\\", "/")


def make_plugin_root(root, name: str = "dsh-moments-agent") -> Path:
    plugin = Path(root) / "plugins" / name
    plugin.mkdir(parents=True, exist_ok=True)
    (plugin / "package.json").write_text(
        json.dumps({"name": "dsh-moments-agent", "version": "1.0.0"}), encoding="utf-8"
    )
    return plugin


def make_profile(
    home,
    name: str = "desktop",
    *,
    plugin_root=None,
    register: bool = True,
    patch_text: str | None = None,
) -> Path:
    profile = Path(home) / ".dsh" / "profiles" / name
    profile.mkdir(parents=True, exist_ok=True)
    dependencies: dict = {}
    package: dict = {"name": f"dsh-profile-{name}", "private": True, "dependencies": dependencies}
    if plugin_root is not None:
        dependencies["dsh-moments-agent"] = "link:" + str(plugin_root)
    elif register:
        dependencies["dsh-moments-agent"] = "0.1.0"
    if register:
        package["dsh"] = {"profile": {"bundles": ["@deepseek-ai/dsh-base", "dsh-moments-agent"]}}
    (profile / "package.json").write_text(json.dumps(package), encoding="utf-8")
    if patch_text is None:
        patch_text = "# test profile\n" + OTHER_ENTRY
    (profile / "cordis.patch.yml").write_text(patch_text, encoding="utf-8", newline="")
    return profile


def make_wechat_agent(
    root,
    *,
    reader_url="http://127.0.0.1:5031",
    token=READER_TOKEN,
    hook_base_url="http://127.0.0.1:30001",
    provider="deepseek-account",
    model="deepseek-flash",
    ports=None,
    hook_token: bool = True,
):
    root = Path(root)
    app_dir = root / "wechat" / "app"
    app_dir.mkdir(parents=True, exist_ok=True)
    exe = app_dir / "WeChatAgent.exe"
    exe.touch()
    data = root / "wechat" / "data"
    state = data / "workspace" / "state"
    state.mkdir(parents=True, exist_ok=True)
    io_config: dict = {}
    if reader_url is not None:
        io_config["reader_base_url"] = reader_url
    if token is not None:
        io_config["reader_token"] = token
    (state / "wechat-io-config.json").write_text(json.dumps(io_config), encoding="utf-8")
    config_dir = data / "workspace" / "config"
    config_dir.mkdir(parents=True, exist_ok=True)
    agent_config: dict = {}
    if hook_base_url is not None:
        agent_config["hook"] = {"baseUrl": hook_base_url}
    if provider is not None or model is not None:
        agent_config["dsh"] = {"provider": provider, "model": model}
    if ports is not None:
        agent_config["ports"] = ports
    (config_dir / "wechatagent.json").write_text(json.dumps(agent_config), encoding="utf-8")
    if hook_token:
        hook_dir = state / "hook"
        hook_dir.mkdir(parents=True, exist_ok=True)
        (hook_dir / "native-token.txt").write_text(HOOK_TOKEN, encoding="utf-8")
    return exe, data


def agent_processes(*exes):
    return [SimpleNamespace(name="WeChatAgent.exe", exe_path=str(exe)) for exe in exes]


def reader_reply(payload=None, *, calls=None, exc=None):
    body = payload if payload is not None else {"ownWxid": OWN_WXID, "accountDirectory": ACCOUNT_DIR}

    def fetch(url, headers, timeout):
        if calls is not None:
            calls.append({"url": url, "headers": dict(headers), "timeout": timeout})
        if exc is not None:
            raise exc
        return body

    return fetch


def run_build(root, home, *, profile=None, processes=(), fetch=None, now=NOW, project_root=None):
    return build_plan(
        project_root if project_root is not None else Path(root) / "project",
        profile=profile,
        user_home=home,
        environment={},
        processes=list(processes),
        fetch=fetch,
        now=now,
    )


class ProfileSelectionTest(unittest.TestCase):
    def test_selects_registered_profile_and_derives_plugin_root_from_link(self):
        with make_test_tmp() as tmp:
            root = Path(tmp.name)
            home = root / "home"
            home.mkdir()
            plugin = make_plugin_root(root)
            profile = make_profile(home, "desktop", plugin_root=plugin)
            plan = run_build(root, home)
            self.assertEqual(plan.errors, [])
            self.assertEqual(plan.profile, "desktop")
            self.assertEqual(Path(plan.patchPath), (profile / "cordis.patch.yml").resolve())
            self.assertEqual(plan.dataDir, fwd(plugin / "data"))
            self.assertEqual(plan.detected["dataDirSource"], "profile-package.json-link")
            self.assertFalse(plan.existed)
            self.assertIn("- id: dsh-moments-agent", plan.block)
            self.assertEqual(plan.detected["availableProfiles"], ["desktop"])

    def test_selects_registered_profile_via_bundle_only(self):
        with make_test_tmp() as tmp:
            root = Path(tmp.name)
            home = root / "home"
            home.mkdir()
            plugin = make_plugin_root(root)
            registered = make_profile(home, "alpha", plugin_root=plugin, register=False)
            # 只用 bundles 注册（没有 dependencies 记录）
            (registered / "package.json").write_text(
                json.dumps(
                    {
                        "name": "dsh-profile-alpha",
                        "dsh": {"profile": {"bundles": ["dsh-moments-agent"]}},
                    }
                ),
                encoding="utf-8",
            )
            make_profile(home, "desktop", register=False)
            plan = run_build(root, home)
            self.assertEqual(plan.errors, [])
            self.assertEqual(plan.profile, "alpha")

    def test_multiple_registered_profiles_require_explicit_profile(self):
        with make_test_tmp() as tmp:
            root = Path(tmp.name)
            home = root / "home"
            home.mkdir()
            plugin = make_plugin_root(root)
            make_profile(home, "one", plugin_root=plugin)
            make_profile(home, "two", plugin_root=plugin)
            plan = run_build(root, home)
            self.assertEqual(plan.profile, "")
            self.assertTrue(any("--profile" in item for item in plan.errors))
            self.assertEqual(plan.block, "")

    def test_defaults_to_desktop_when_no_registered_profile(self):
        with make_test_tmp() as tmp:
            root = Path(tmp.name)
            home = root / "home"
            home.mkdir()
            make_profile(home, "alpha", register=False)
            desktop = make_profile(home, "desktop", register=False)
            plan = run_build(root, home)
            self.assertEqual(plan.errors, [])
            self.assertEqual(plan.profile, "desktop")
            self.assertEqual(Path(plan.patchPath), desktop / "cordis.patch.yml")
            self.assertTrue(any("desktop" in item for item in plan.warnings))

    def test_named_profile_that_does_not_exist_reports_error(self):
        with make_test_tmp() as tmp:
            root = Path(tmp.name)
            home = root / "home"
            home.mkdir()
            make_profile(home, "desktop", register=False)
            plan = run_build(root, home, profile="missing")
            self.assertTrue(any("profile 不存在" in item for item in plan.errors))
            self.assertEqual(plan.block, "")

    def test_profile_without_cordis_patch_reports_error(self):
        with make_test_tmp() as tmp:
            root = Path(tmp.name)
            home = root / "home"
            home.mkdir()
            profile = make_profile(home, "desktop", register=False)
            (profile / "cordis.patch.yml").unlink()
            plan = run_build(root, home)
            self.assertTrue(any("cordis.patch.yml" in item for item in plan.errors))
            self.assertEqual(plan.block, "")

    def test_plugin_root_from_node_modules_when_no_link(self):
        with make_test_tmp() as tmp:
            root = Path(tmp.name)
            home = root / "home"
            home.mkdir()
            profile = make_profile(home, "solo", register=False)
            plugin = profile / "node_modules" / "dsh-moments-agent"
            plugin.mkdir(parents=True)
            (plugin / "package.json").write_text('{"name":"dsh-moments-agent"}', encoding="utf-8")
            plan = run_build(root, home)
            self.assertEqual(plan.errors, [])
            self.assertEqual(plan.detected["dataDirSource"], "profile-node_modules")
            self.assertEqual(plan.dataDir, fwd(plugin / "data"))

    def test_fallback_data_dir_uses_project_root_with_warning(self):
        with make_test_tmp() as tmp:
            root = Path(tmp.name)
            home = root / "home"
            home.mkdir()
            make_profile(home, "desktop", register=False)
            project = root / "project"
            project.mkdir()
            plan = run_build(root, home, project_root=project)
            self.assertEqual(plan.errors, [])
            self.assertEqual(plan.detected["dataDirSource"], "project-root-fallback")
            self.assertEqual(plan.dataDir, fwd(project / "data"))
            self.assertTrue(any("回退" in item for item in plan.warnings))


class BlockRenderingTest(unittest.TestCase):
    def test_block_contains_safe_defaults(self):
        block = render_block(
            data_dir="D:/data", llm_provider="deepseek-account", llm_model="deepseek-flash",
            wechat_agent={"enabled": False, "hookBaseUrl": auto_configure.DEFAULT_HOOK_BASE_URL},
        )
        for expected in (
            "- id: dsh-moments-agent",
            "    publishMode: PREPARE_ONLY",
            "    killSwitch: false",
            "    scheduleEnabled: false",
            "    ownerChannel: manual",
            "      provider: deepseek-account",
            "      model: deepseek-flash",
            "      enabled: false",
            "      hookBaseUrl: http://127.0.0.1:11230",
            "    desktopExecutor:",
            "      enabled: false",
            "      officialApiEnabled: false",
            "        - manual-subscription",
            "        - local-import",
            "      dailyLimit: 2",
            "      quietHours: ['23:00', '08:00']",
            "      port: 18766",
            "      tokenFile: data/admin-token.txt",
            "    chatMemory:",
            "      enabled: false",
            "      account: ''",
            "      ownerWxid: ''",
        ):
            self.assertIn(expected, block)
        self.assertTrue(block.endswith("\n"))
        self.assertTrue(block.startswith("- id: dsh-moments-agent"))
        self.assertIn("# 由自动配置生成", block)

    def test_block_quotes_paths_with_spaces_and_uses_forward_slashes(self):
        block = render_block(
            data_dir="D:/my plugins/仪表盘/data",
            llm_provider="deepseek-account",
            llm_model="deepseek-flash",
            wechat_agent={"enabled": True, "hookBaseUrl": "http://127.0.0.1:11230"},
        )
        self.assertIn("dataDir: 'D:/my plugins/仪表盘/data'", block)
        self.assertNotIn("\\", block)

    def test_read_entry_literals_reads_scalars_and_never_evaluates(self):
        text = (
            "- id: dsh-moments-agent\n"
            "  name: dsh-moments-agent\n"
            "  config:\n"
            "    dataDir: custom-data\n"
            "    publishMode: APPROVAL_REQUIRED\n"
            "    killSwitch: true\n"
            "    wechatAgent:\n"
            "      enabled: false\n"
            "      readerBaseUrl: \"http://127.0.0.1:5031\"\n"
            "      hookBaseUrl: http://127.0.0.1:30001\n"
            "      readerConfigPath: !!js doNotEval()\n"
            "      account: 'wxid_quoted_123456'\n"
            "      ownerWxid: wxid_plain_123456\n"
            "    adminServer:\n"
            "      port: 18888\n"
        )
        values = read_entry_literals(text)
        self.assertEqual(values["dataDir"], "custom-data")
        self.assertEqual(values["publishMode"], "APPROVAL_REQUIRED")
        self.assertIs(values["killSwitch"], True)
        self.assertIs(values["wechatAgent.enabled"], False)
        self.assertEqual(values["wechatAgent.readerBaseUrl"], "http://127.0.0.1:5031")
        self.assertEqual(values["wechatAgent.hookBaseUrl"], "http://127.0.0.1:30001")
        self.assertEqual(values["wechatAgent.account"], "wxid_quoted_123456")
        self.assertEqual(values["wechatAgent.ownerWxid"], "wxid_plain_123456")
        self.assertEqual(values["adminServer.port"], 18888)
        self.assertNotIn("wechatAgent.readerConfigPath", values)
        self.assertNotIn("doNotEval", json.dumps(values))


class DetectionTest(unittest.TestCase):
    def test_wechat_agent_detection_reader_probe_and_masking(self):
        with make_test_tmp() as tmp:
            root = Path(tmp.name)
            home = root / "home"
            home.mkdir()
            plugin = make_plugin_root(root)
            make_profile(home, "desktop", plugin_root=plugin)
            exe, data = make_wechat_agent(
                root, ports={"weflow": 11231, "onebot": 30001, "adapter": 5030, "dshPlugin": 18766}
            )
            calls: list = []
            plan = run_build(
                root, home, processes=agent_processes(exe), fetch=reader_reply(calls=calls)
            )
            self.assertEqual(plan.errors, [])
            self.assertTrue(plan.detected["wechatAgent"]["enabled"])
            self.assertEqual(plan.detected["wechatAgent"]["readerStatus"], "ok")
            self.assertEqual(
                plan.detected["wechatAgent"]["readerBaseUrl"], "http://127.0.0.1:5031"
            )
            self.assertEqual(plan.detected["wechatAgent"]["hookBaseUrl"], "http://127.0.0.1:30001")
            self.assertEqual(
                plan.detected["wechatAgent"]["ports"],
                {"weflow": 11231, "onebot": 30001, "adapter": 5030, "dshPlugin": 18766},
            )
            self.assertTrue(
                plan.detected["wechatAgent"]["hookTokenFile"].endswith(
                    "state/hook/native-token.txt"
                )
            )
            self.assertEqual(plan.detected["wechatAgent"]["account"], "wxid_a***")
            self.assertEqual(plan.detected["wechatAgent"]["ownerWxid"], "wxid_o***")
            # 配置块里写入真实账号（插件需要），但绝不写令牌正文。
            self.assertIn(f"      account: {ACCOUNT_DIR}", plan.block)
            self.assertIn(f"      ownerWxid: {OWN_WXID}", plan.block)
            self.assertIn(fwd(data / "workspace/state/wechat-io-config.json"), plan.block)
            self.assertNotIn(READER_TOKEN, plan.block)
            self.assertNotIn(HOOK_TOKEN, plan.block)
            self.assertNotIn(READER_TOKEN, json.dumps(plan.detected, ensure_ascii=False))
            # Reader 探测：回环路径、Bearer 令牌、timeout <= 3s。
            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0]["url"], "http://127.0.0.1:5031/api/v1/reader/status")
            self.assertEqual(calls[0]["headers"]["Authorization"], f"Bearer {READER_TOKEN}")
            self.assertGreater(calls[0]["timeout"], 0)
            self.assertLessEqual(calls[0]["timeout"], 3.0)

    def test_reader_status_payload_with_data_wrapper_is_supported(self):
        with make_test_tmp() as tmp:
            root = Path(tmp.name)
            home = root / "home"
            home.mkdir()
            make_profile(home, "desktop", plugin_root=make_plugin_root(root))
            exe, _data = make_wechat_agent(root)
            payload = {"ok": True, "data": {"ownWxid": OWN_WXID, "accountDirectory": ACCOUNT_DIR}}
            plan = run_build(root, home, processes=agent_processes(exe), fetch=reader_reply(payload))
            self.assertEqual(plan.detected["wechatAgent"]["account"], "wxid_a***")
            self.assertEqual(plan.detected["wechatAgent"]["ownerWxid"], "wxid_o***")
            self.assertTrue(plan.detected["wechatAgent"]["enabled"])

    def test_reader_probe_failure_degrades_without_leaking_token(self):
        with make_test_tmp() as tmp:
            root = Path(tmp.name)
            home = root / "home"
            home.mkdir()
            make_profile(home, "desktop", plugin_root=make_plugin_root(root))
            exe, _data = make_wechat_agent(root)
            plan = run_build(
                root,
                home,
                processes=agent_processes(exe),
                fetch=reader_reply(exc=RuntimeError(READER_TOKEN)),
            )
            self.assertEqual(plan.errors, [])
            self.assertTrue(plan.detected["wechatAgent"]["enabled"])
            self.assertEqual(plan.detected["wechatAgent"]["readerStatus"], "unavailable")
            self.assertEqual(plan.detected["wechatAgent"]["account"], "")
            self.assertTrue(any("Reader 状态探测失败" in item for item in plan.warnings))
            dump = json.dumps(public_summary(plan), ensure_ascii=False)
            self.assertNotIn(READER_TOKEN, dump)
            self.assertNotIn(READER_TOKEN, " ".join(plan.warnings))

    def test_non_loopback_reader_url_is_rejected(self):
        with make_test_tmp() as tmp:
            root = Path(tmp.name)
            home = root / "home"
            home.mkdir()
            make_profile(home, "desktop", plugin_root=make_plugin_root(root))
            exe, _data = make_wechat_agent(root, reader_url="http://192.168.1.50:5031")

            def must_not_be_called(*_args, **_kwargs):
                raise AssertionError("非回环 Reader 地址不应发起探测")

            plan = run_build(
                root, home, processes=agent_processes(exe), fetch=must_not_be_called
            )
            self.assertEqual(plan.errors, [])
            self.assertFalse(plan.detected["wechatAgent"]["enabled"])
            self.assertNotIn("readerBaseUrl", plan.block)
            self.assertIn("      enabled: false", plan.block)
            self.assertTrue(
                any("回环" in item for item in plan.warnings),
                msg="应提示非回环地址被拒绝",
            )

    def test_no_wechat_agent_writes_conservative_config(self):
        with make_test_tmp() as tmp:
            root = Path(tmp.name)
            home = root / "home"
            home.mkdir()
            make_profile(home, "desktop", plugin_root=make_plugin_root(root))
            plan = run_build(root, home)
            self.assertEqual(plan.errors, [])
            self.assertIsNone(plan.detected["wechatAgent"])
            self.assertIn("      enabled: false", plan.block)
            self.assertIn("      hookBaseUrl: http://127.0.0.1:11230", plan.block)
            self.assertIn("      account: ''", plan.block)
            self.assertIn("      ownerWxid: ''", plan.block)
            self.assertNotIn("readerConfigPath", plan.block)
            self.assertEqual(plan.desktopAccountAction, "none")
            self.assertTrue(any("WeChatAgent" in item for item in plan.warnings))

    def test_llm_from_wechatagent_config(self):
        with make_test_tmp() as tmp:
            root = Path(tmp.name)
            home = root / "home"
            home.mkdir()
            make_profile(home, "desktop", plugin_root=make_plugin_root(root))
            exe, _data = make_wechat_agent(
                root, provider="custom-provider", model="custom-model"
            )
            plan = run_build(
                root, home, processes=agent_processes(exe), fetch=reader_reply()
            )
            self.assertEqual(plan.detected["llm"]["provider"], "custom-provider")
            self.assertEqual(plan.detected["llm"]["model"], "custom-model")
            self.assertEqual(plan.detected["llm"]["source"], "wechatagent")
            self.assertIn("      provider: custom-provider", plan.block)
            self.assertIn("      model: custom-model", plan.block)

    def test_llm_falls_back_to_profile_agent_default_model(self):
        with make_test_tmp() as tmp:
            root = Path(tmp.name)
            home = root / "home"
            home.mkdir()
            patch_text = (
                OTHER_ENTRY
                + "- id: agent-default-model\n"
                "  name: \"@deepseek-ai/dsh-agent-default-model\"\n"
                "  config:\n"
                "    provider: profile-provider\n"
                "    model: profile-model\n"
            )
            make_profile(home, "desktop", plugin_root=make_plugin_root(root), patch_text=patch_text)
            plan = run_build(root, home)
            self.assertEqual(plan.detected["llm"]["provider"], "profile-provider")
            self.assertEqual(plan.detected["llm"]["model"], "profile-model")
            self.assertEqual(plan.detected["llm"]["source"], "profile-agent-default-model")
            self.assertIn("      provider: profile-provider", plan.block)

    def test_llm_defaults_when_nothing_detected(self):
        with make_test_tmp() as tmp:
            root = Path(tmp.name)
            home = root / "home"
            home.mkdir()
            make_profile(home, "desktop", plugin_root=make_plugin_root(root))
            plan = run_build(root, home)
            self.assertEqual(plan.detected["llm"]["provider"], "deepseek-account")
            self.assertEqual(plan.detected["llm"]["model"], "deepseek-flash")
            self.assertEqual(plan.detected["llm"]["source"], "default")
            self.assertTrue(any("默认值" in item for item in plan.warnings))

    def test_hook_base_url_falls_back_when_missing(self):
        with make_test_tmp() as tmp:
            root = Path(tmp.name)
            home = root / "home"
            home.mkdir()
            make_profile(home, "desktop", plugin_root=make_plugin_root(root))
            exe, _data = make_wechat_agent(root, hook_base_url=None)
            plan = run_build(root, home, processes=agent_processes(exe))
            self.assertEqual(plan.detected["wechatAgent"]["hookBaseUrl"], "http://127.0.0.1:11230")
            self.assertIn("      hookBaseUrl: http://127.0.0.1:11230", plan.block)

    def test_hook_token_file_omitted_when_not_present(self):
        with make_test_tmp() as tmp:
            root = Path(tmp.name)
            home = root / "home"
            home.mkdir()
            make_profile(home, "desktop", plugin_root=make_plugin_root(root))
            exe, _data = make_wechat_agent(root, hook_token=False)
            plan = run_build(root, home, processes=agent_processes(exe))
            self.assertIsNone(plan.detected["wechatAgent"]["hookTokenFile"])
            self.assertNotIn("hookTokenFile", plan.block)

    def test_existing_literals_drive_changed_fields_and_warnings(self):
        with make_test_tmp() as tmp:
            root = Path(tmp.name)
            home = root / "home"
            home.mkdir()
            patch_text = (
                OTHER_ENTRY
                + "- id: dsh-moments-agent\n"
                "  name: dsh-moments-agent\n"
                "  config:\n"
                "    enabled: true\n"
                "    dataDir: old-relative-data\n"
                "    publishMode: APPROVAL_REQUIRED\n"
                "    wechatAgent:\n"
                "      enabled: false\n"
                "      readerBaseUrl: http://127.0.0.1:9999\n"
                "      hookBaseUrl: http://127.0.0.1:9998\n"
                f"      account: '{OLD_ACCOUNT}'\n"
                "      ownerWxid: old-owner\n"
                "    adminServer:\n"
                "      enabled: true\n"
                "      port: 18888\n"
            )
            make_profile(
                home, "desktop", plugin_root=make_plugin_root(root), patch_text=patch_text
            )
            exe, _data = make_wechat_agent(root)
            plan = run_build(
                root, home, processes=agent_processes(exe), fetch=reader_reply()
            )
            self.assertEqual(plan.errors, [])
            self.assertTrue(plan.existed)
            self.assertTrue(
                {
                    "dataDir",
                    "publishMode",
                    "wechatAgent.enabled",
                    "wechatAgent.readerBaseUrl",
                    "wechatAgent.hookBaseUrl",
                    "wechatAgent.account",
                    "wechatAgent.ownerWxid",
                    "adminServer.port",
                }.issubset(set(plan.changedFields))
            )
            warnings = " ".join(plan.warnings)
            self.assertIn("dataDir", warnings)
            self.assertIn("18888", warnings)
            self.assertIn("APPROVAL_REQUIRED", warnings)
            # 旧账号在 warnings 里也必须掩码。
            self.assertNotIn(OLD_ACCOUNT, warnings)
            self.assertIn("wxid_o***", warnings)

    def test_missing_reader_token_skips_probe(self):
        with make_test_tmp() as tmp:
            root = Path(tmp.name)
            home = root / "home"
            home.mkdir()
            make_profile(home, "desktop", plugin_root=make_plugin_root(root))
            exe, _data = make_wechat_agent(root, token=None)

            def must_not_be_called(*_args, **_kwargs):
                raise AssertionError("没有 Reader 令牌时不应发起探测")

            plan = run_build(
                root, home, processes=agent_processes(exe), fetch=must_not_be_called
            )
            self.assertTrue(plan.detected["wechatAgent"]["enabled"])
            self.assertEqual(plan.detected["wechatAgent"]["readerStatus"], "configured")
            self.assertTrue(any("令牌" in item for item in plan.warnings))
            self.assertTrue(any("留空" in item for item in plan.warnings))


class MergeTest(unittest.TestCase):
    def _block(self, data_dir="D:/new-data"):
        return render_block(
            data_dir=data_dir,
            llm_provider="deepseek-account",
            llm_model="deepseek-flash",
            wechat_agent={"enabled": False, "hookBaseUrl": auto_configure.DEFAULT_HOOK_BASE_URL},
        )

    def test_replaces_existing_block_preserving_other_entries_comments_and_js(self):
        original = (
            "# header comment\n"
            "- id: other\n"
            "  name: other\n"
            "  config:\n"
            "    enabled: true\n"
            "\n"
            "# 插件条目之前的注释\n"
            "- id: dsh-moments-agent\n"
            "  name: dsh-moments-agent\n"
            "  config:\n"
            "    dataDir: OLD_DATA_DIR\n"
            "    wechatAgent:\n"
            "      enabled: true\n"
            "\n"
            "# next 条目的注释\n"
            "- id: another\n"
            "  name: another\n"
            "  config: !!js doNotEval()\n"
        )
        merged = merge_patch_text(original, self._block())
        self.assertEqual(merged.count("- id: dsh-moments-agent"), 1)
        self.assertNotIn("OLD_DATA_DIR", merged)
        self.assertIn("dataDir: D:/new-data", merged)
        for preserved in (
            "# header comment",
            "- id: other",
            "# 插件条目之前的注释",
            "# next 条目的注释",
            "- id: another",
            "config: !!js doNotEval()",
        ):
            self.assertIn(preserved, merged)
        self.assertLess(merged.index("dataDir: D:/new-data"), merged.index("# next 条目的注释"))

    def test_appends_when_entry_missing(self):
        original = "- id: other\n  config:\n    enabled: true"
        merged = merge_patch_text(original, self._block())
        self.assertTrue(merged.startswith("- id: other"))
        self.assertEqual(merged.count("- id: dsh-moments-agent"), 1)
        self.assertIn("\n\n- id: dsh-moments-agent", merged)
        self.assertTrue(merged.endswith("\n"))

    def test_appends_to_empty_file(self):
        merged = merge_patch_text("", self._block())
        self.assertTrue(merged.startswith("- id: dsh-moments-agent"))
        self.assertEqual(merged.count("- id: dsh-moments-agent"), 1)
        self.assertTrue(merged.endswith("\n"))

    def test_appends_to_comment_only_file(self):
        merged = merge_patch_text("# only a comment\n", self._block())
        self.assertTrue(merged.startswith("# only a comment"))
        self.assertIn("- id: dsh-moments-agent", merged)

    def test_rejects_non_array_structure(self):
        for text in ("foo: bar\n", "{}\n", "[1, 2]\n"):
            with self.assertRaises(AutoConfigError) as raised:
                merge_patch_text(text, self._block())
            self.assertIn("手工配置", str(raised.exception))

    def test_rejects_duplicate_plugin_entries(self):
        original = (
            "- id: dsh-moments-agent\n  config:\n    dataDir: a\n"
            "- id: other\n  config:\n    enabled: true\n"
            "- id: dsh-moments-agent\n  config:\n    dataDir: b\n"
        )
        with self.assertRaises(AutoConfigError) as raised:
            merge_patch_text(original, self._block())
        self.assertIn("条目", str(raised.exception))

    def test_merge_is_idempotent(self):
        original = "# header\n" + OTHER_ENTRY
        first = merge_patch_text(original, self._block())
        second = merge_patch_text(first, self._block())
        self.assertEqual(first, second)
        self.assertEqual(first.count("- id: dsh-moments-agent"), 1)

    def test_preserves_crlf_newlines(self):
        original = "- id: other\r\n  config:\r\n    enabled: true\r\n"
        merged = merge_patch_text(original, self._block())
        self.assertIn("- id: other\r\n", merged)
        self.assertIn("    dataDir: D:/new-data\r\n", merged)
        self.assertEqual(merged.count("\r\n"), merged.count("\n"))


class ApplyTest(unittest.TestCase):
    def _fixture(self, root: Path):
        home = root / "home"
        home.mkdir()
        plugin = make_plugin_root(root)
        profile = make_profile(home, "desktop", plugin_root=plugin)
        exe, _data = make_wechat_agent(root)
        return home, plugin, profile, agent_processes(exe)

    def test_apply_writes_block_backup_and_desktop_account(self):
        with make_test_tmp() as tmp:
            root = Path(tmp.name)
            home, _plugin, profile, processes = self._fixture(root)
            patch = profile / "cordis.patch.yml"
            original = patch.read_bytes()
            plan = run_build(root, home, processes=processes, fetch=reader_reply())
            self.assertEqual(plan.errors, [])
            self.assertEqual(plan.desktopAccountAction, "create")
            applied = apply_plan(plan)
            self.assertIs(applied, plan)
            self.assertTrue(plan.applied)
            current = patch.read_text(encoding="utf-8")
            expected = merge_patch_text(original.decode("utf-8"), plan.block)
            self.assertEqual(current, expected)
            self.assertEqual(current.count("- id: dsh-moments-agent"), 1)
            # 其他条目与注释保持原样。
            self.assertIn("- id: other", current)
            self.assertIn("# 其他插件注释", current)
            self.assertEqual(current.count("- id: other"), 1)
            backup = Path(plan.backupPath)
            self.assertTrue(backup.is_file())
            self.assertEqual(backup.name, "cordis.patch.yml.20261025-183000.bak")
            self.assertEqual(backup.read_bytes(), original)
            account_file = Path(plan.desktopAccountPath)
            self.assertEqual(account_file.read_text(encoding="utf-8"), ACCOUNT_DIR + "\n")
            self.assertEqual(plan.desktopAccountAction, "created")
            self.assertTrue(any("重启 DSH" in item for item in plan.warnings))
            self.assertEqual(list(profile.glob("*.tmp-*")), [])
            self.assertFalse(list(profile.glob("*.tmp")))

    def test_build_alone_never_writes(self):
        with make_test_tmp() as tmp:
            root = Path(tmp.name)
            home, _plugin, profile, processes = self._fixture(root)
            patch = profile / "cordis.patch.yml"
            original = patch.read_bytes()
            plan = run_build(root, home, processes=processes, fetch=reader_reply())
            self.assertEqual(plan.errors, [])
            self.assertFalse(plan.applied)
            self.assertIsNone(plan.backupPath)
            self.assertEqual(patch.read_bytes(), original)
            self.assertEqual(list(profile.glob("*.bak")), [])
            self.assertFalse(Path(plan.desktopAccountPath).exists())

    def test_second_apply_is_idempotent_and_backs_up_again(self):
        with make_test_tmp() as tmp:
            root = Path(tmp.name)
            home, _plugin, profile, processes = self._fixture(root)
            patch = profile / "cordis.patch.yml"
            first = run_build(root, home, processes=processes, fetch=reader_reply(), now=NOW)
            apply_plan(first)
            content_after_first = patch.read_bytes()
            second = run_build(
                root, home, processes=processes, fetch=reader_reply(), now=LATER
            )
            self.assertEqual(second.errors, [])
            self.assertEqual(second.changedFields, [])
            apply_plan(second)
            self.assertEqual(patch.read_bytes(), content_after_first)
            self.assertEqual(
                patch.read_text(encoding="utf-8").count("- id: dsh-moments-agent"), 1
            )
            backups = sorted(profile.glob("cordis.patch.yml.*.bak"))
            self.assertEqual(len(backups), 2)
            self.assertEqual(
                sorted(item.name for item in backups),
                [
                    "cordis.patch.yml.20261025-183000.bak",
                    "cordis.patch.yml.20261025-193000.bak",
                ],
            )

    def test_same_timestamp_backups_do_not_overwrite(self):
        with make_test_tmp() as tmp:
            root = Path(tmp.name)
            home, _plugin, profile, processes = self._fixture(root)
            first = run_build(root, home, processes=processes, fetch=reader_reply(), now=NOW)
            apply_plan(first)
            second = run_build(root, home, processes=processes, fetch=reader_reply(), now=NOW)
            apply_plan(second)
            names = sorted(item.name for item in profile.glob("cordis.patch.yml.*.bak"))
            self.assertEqual(len(names), 2)
            self.assertIn("cordis.patch.yml.20261025-183000.bak", names)
            self.assertIn("cordis.patch.yml.20261025-183000-1.bak", names)

    def test_apply_refuses_plan_with_errors(self):
        with make_test_tmp() as tmp:
            root = Path(tmp.name)
            home = root / "home"
            home.mkdir()
            make_profile(home, "desktop", register=False)
            plan = run_build(root, home, profile="missing")
            self.assertTrue(plan.errors)
            with self.assertRaises(AutoConfigError):
                apply_plan(plan)

    def test_atomic_write_failure_keeps_original_intact(self):
        with make_test_tmp() as tmp:
            root = Path(tmp.name)
            home, _plugin, profile, processes = self._fixture(root)
            patch = profile / "cordis.patch.yml"
            original = patch.read_bytes()
            plan = run_build(root, home, processes=processes, fetch=reader_reply())
            with mock.patch.object(auto_configure.os, "replace", side_effect=OSError("disk full")):
                with self.assertRaises(AutoConfigError):
                    apply_plan(plan)
            self.assertEqual(patch.read_bytes(), original)
            self.assertEqual(list(profile.glob("*.tmp-*")), [])
            self.assertFalse(plan.applied)

    def test_apply_preserves_bom(self):
        with make_test_tmp() as tmp:
            root = Path(tmp.name)
            home, _plugin, profile, processes = self._fixture(root)
            patch = profile / "cordis.patch.yml"
            text = "# bom profile\n" + OTHER_ENTRY
            patch.write_bytes(codecs.BOM_UTF8 + text.encode("utf-8"))
            plan = run_build(root, home, processes=processes, fetch=reader_reply())
            self.assertEqual(plan.errors, [])
            apply_plan(plan)
            data = patch.read_bytes()
            self.assertTrue(data.startswith(codecs.BOM_UTF8))
            self.assertIn("- id: dsh-moments-agent", data.decode("utf-8-sig"))

    def test_desktop_account_unchanged_when_content_matches(self):
        with make_test_tmp() as tmp:
            root = Path(tmp.name)
            home, _plugin, profile, processes = self._fixture(root)
            probe = run_build(root, home, processes=processes, fetch=reader_reply())
            account_file = Path(probe.desktopAccountPath)
            account_file.parent.mkdir(parents=True, exist_ok=True)
            account_file.write_text(ACCOUNT_DIR + "\n", encoding="utf-8")
            plan = run_build(root, home, processes=processes, fetch=reader_reply())
            self.assertEqual(plan.desktopAccountAction, "unchanged")
            apply_plan(plan)
            self.assertEqual(account_file.read_text(encoding="utf-8"), ACCOUNT_DIR + "\n")
            self.assertEqual(plan.desktopAccountAction, "unchanged")

    def test_desktop_account_different_content_is_kept(self):
        with make_test_tmp() as tmp:
            root = Path(tmp.name)
            home, _plugin, profile, processes = self._fixture(root)
            probe = run_build(root, home, processes=processes, fetch=reader_reply())
            account_file = Path(probe.desktopAccountPath)
            account_file.parent.mkdir(parents=True, exist_ok=True)
            account_file.write_text("other-account\n", encoding="utf-8")
            plan = run_build(root, home, processes=processes, fetch=reader_reply())
            self.assertEqual(plan.desktopAccountAction, "keep")
            self.assertTrue(any("不覆盖" in item for item in plan.warnings))
            apply_plan(plan)
            self.assertEqual(account_file.read_text(encoding="utf-8"), "other-account\n")
            self.assertEqual(plan.desktopAccountAction, "keep")
            self.assertTrue(any("保留" in item for item in plan.warnings))

    def test_desktop_account_skipped_without_reader(self):
        with make_test_tmp() as tmp:
            root = Path(tmp.name)
            home = root / "home"
            home.mkdir()
            make_profile(home, "desktop", plugin_root=make_plugin_root(root))
            plan = run_build(root, home)
            self.assertEqual(plan.desktopAccountAction, "none")
            apply_plan(plan)
            self.assertEqual(plan.desktopAccountAction, "none")
            self.assertFalse(Path(plan.desktopAccountPath).exists())


class SummaryTest(unittest.TestCase):
    def _summary(self, root: Path):
        home = root / "home"
        home.mkdir()
        plugin = make_plugin_root(home / "tools")
        make_profile(home, "desktop", plugin_root=plugin)
        exe, _data = make_wechat_agent(root)
        plan = run_build(root, home, processes=agent_processes(exe), fetch=reader_reply())
        self.assertEqual(plan.errors, [])
        return plan, public_summary(plan)

    def test_public_summary_redacts_home_wxid_and_tokens(self):
        with make_test_tmp() as tmp:
            root = Path(tmp.name)
            plan, summary = self._summary(root)
            raw = json.dumps(summary, ensure_ascii=False)
            home = Path(plan.userHome)
            self.assertNotIn(str(home), raw)
            self.assertNotIn(str(home).replace("\\", "/"), raw)
            self.assertNotIn(OWN_WXID, raw)
            self.assertNotIn(ACCOUNT_DIR, raw)
            self.assertNotIn(READER_TOKEN, raw)
            self.assertNotIn(HOOK_TOKEN, raw)
            self.assertTrue(str(summary["dataDir"]).startswith("~"))
            self.assertIn("~/", summary["dataDir"])
            self.assertEqual(summary["detected"]["wechatAgent"]["account"], "wxid_a***")
            self.assertEqual(summary["detected"]["wechatAgent"]["ownerWxid"], "wxid_o***")
            # 默认 ensure_ascii 也必须可序列化（JSON 安全）。
            json.dumps(summary)
            for key in (
                "profile",
                "patchPath",
                "existed",
                "block",
                "changedFields",
                "detected",
                "warnings",
                "errors",
                "backupPath",
                "dataDir",
                "desktopAccountPath",
                "desktopAccountAction",
                "applied",
                "restartRequired",
            ):
                self.assertIn(key, summary)

    def test_changed_fields_are_only_field_names(self):
        with make_test_tmp() as tmp:
            root = Path(tmp.name)
            _plan, summary = self._summary(root)
            self.assertTrue(summary["changedFields"])
            for name in summary["changedFields"]:
                self.assertIsInstance(name, str)
                self.assertNotIn("wxid", name)
                self.assertNotIn("/", name)

    def test_summary_after_apply_reports_backup_and_restart(self):
        with make_test_tmp() as tmp:
            root = Path(tmp.name)
            home = root / "home"
            home.mkdir()
            plugin = make_plugin_root(root)
            make_profile(home, "desktop", plugin_root=plugin)
            exe, _data = make_wechat_agent(root)
            plan = run_build(
                root, home, processes=agent_processes(exe), fetch=reader_reply()
            )
            apply_plan(plan)
            summary = public_summary(plan)
            self.assertTrue(summary["applied"])
            self.assertTrue(summary["restartRequired"])
            self.assertTrue(summary["backupPath"])
            self.assertNotIn(str(home), json.dumps(summary, ensure_ascii=False))


class CliTest(unittest.TestCase):
    def _fixture(self, root: Path):
        home = root / "home"
        home.mkdir()
        plugin = make_plugin_root(root)
        profile = make_profile(home, "desktop", plugin_root=plugin)
        discovery = {
            "profiles": [
                {
                    "name": "desktop",
                    "path": str(profile),
                    "patchPath": str(profile / "cordis.patch.yml"),
                }
            ],
            "wechatConnections": [],
        }
        return home, profile, discovery

    def _run_cli(self, root: Path, home: Path, discovery: dict, argv):
        output = io.StringIO()
        with contextlib.ExitStack() as stack:
            stack.enter_context(
                mock.patch.object(auto_configure, "PROJECT_ROOT", root / "project")
            )
            stack.enter_context(mock.patch.object(auto_configure, "_home_dir", return_value=home))
            stack.enter_context(
                mock.patch.object(auto_configure, "discover", return_value=discovery)
            )
            stack.enter_context(
                mock.patch.object(auto_configure, "_list_processes", return_value=[])
            )
            stack.enter_context(contextlib.redirect_stdout(output))
            code = auto_configure.main(argv)
        return code, output.getvalue()

    def test_cli_json_dry_run_is_parseable_and_writes_nothing(self):
        with make_test_tmp() as tmp:
            root = Path(tmp.name)
            home, profile, discovery = self._fixture(root)
            patch = profile / "cordis.patch.yml"
            original = patch.read_bytes()
            code, output = self._run_cli(root, home, discovery, ["--json"])
            self.assertEqual(code, 0)
            summary = json.loads(output)
            self.assertEqual(summary["profile"], "desktop")
            self.assertFalse(summary["applied"])
            self.assertIsNone(summary["backupPath"])
            self.assertIn("- id: dsh-moments-agent", summary["block"])
            self.assertEqual(patch.read_bytes(), original)
            self.assertEqual(list(profile.glob("*.bak")), [])

    def test_cli_apply_writes_and_reports_applied(self):
        with make_test_tmp() as tmp:
            root = Path(tmp.name)
            home, profile, discovery = self._fixture(root)
            patch = profile / "cordis.patch.yml"
            original = patch.read_bytes()
            code, output = self._run_cli(root, home, discovery, ["--apply", "--json"])
            self.assertEqual(code, 0)
            summary = json.loads(output)
            self.assertTrue(summary["applied"])
            self.assertTrue(summary["restartRequired"])
            self.assertTrue(summary["backupPath"])
            backups = list(profile.glob("cordis.patch.yml.*.bak"))
            self.assertEqual(len(backups), 1)
            self.assertTrue(summary["backupPath"].endswith(backups[0].name))
            self.assertTrue(Path(backups[0]).is_file())
            self.assertNotEqual(patch.read_bytes(), original)
            self.assertEqual(
                patch.read_text(encoding="utf-8").count("- id: dsh-moments-agent"), 1
            )

    def test_cli_json_error_exits_2_with_parseable_errors(self):
        with make_test_tmp() as tmp:
            root = Path(tmp.name)
            home = root / "empty-home"
            home.mkdir()
            code, output = self._run_cli(
                root, home, {"profiles": [], "wechatConnections": []}, ["--json"]
            )
            self.assertEqual(code, 2)
            summary = json.loads(output)
            self.assertTrue(summary["errors"])
            self.assertFalse(summary["applied"])

    def test_cli_human_dry_run_mentions_preview(self):
        with make_test_tmp() as tmp:
            root = Path(tmp.name)
            home, profile, discovery = self._fixture(root)
            original = (profile / "cordis.patch.yml").read_bytes()
            code, output = self._run_cli(root, home, discovery, [])
            self.assertEqual(code, 0)
            self.assertIn("预览模式", output)
            self.assertIn("--apply", output)
            self.assertEqual((profile / "cordis.patch.yml").read_bytes(), original)

    def test_cli_profile_argument_missing_profile_exits_2(self):
        with make_test_tmp() as tmp:
            root = Path(tmp.name)
            home, _profile, discovery = self._fixture(root)
            code, output = self._run_cli(
                root, home, discovery, ["--profile", "nope", "--json"]
            )
            self.assertEqual(code, 2)
            summary = json.loads(output)
            self.assertTrue(any("不存在" in item for item in summary["errors"]))

    def test_module_and_script_help_exit_zero(self):
        script = PROJECT_ROOT / "client" / "auto_configure.py"
        commands = [
            [sys.executable, "-X", "utf8", "-m", "client.auto_configure", "--help"],
            [sys.executable, "-X", "utf8", str(script), "--help"],
        ]
        for command in commands:
            completed = subprocess.run(
                command,
                cwd=PROJECT_ROOT,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=120,
            )
            self.assertEqual(completed.returncode, 0, msg=completed.stderr)
            self.assertIn("自动配置", completed.stdout)


if __name__ == "__main__":
    unittest.main()
