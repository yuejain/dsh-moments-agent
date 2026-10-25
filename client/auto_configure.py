"""DSH Moments Agent 自动配置核心。

给「其他用户的机器」用：检测本机 DSH profile / WeChatAgent / Reader 环境，
生成一条 ``- id: dsh-moments-agent`` 的 YAML 配置块，预览后由用户显式确认写入。

安全边界（与 ``docs/operations/AUTO_SETUP.md`` 一致）：

- 纯标准库；不执行 YAML 求值、不解析 ``!!js``；只做行级定位与受限字面量读取；
- 令牌正文**只在内存中**用于一次回环 GET，不进入计划、警告、日志、JSON 或配置块；
- 默认 dry-run；只有 ``apply_plan`` / ``--apply`` 才写文件，写前备份、临时文件 +
  ``os.replace`` 原子替换；
- 只允许写入选中的 DSH profile 的 ``cordis.patch.yml`` 与插件数据目录下的
  ``desktop-account.txt``；不写用户目录其他位置；
- 服务器地址只接受 ``127.0.0.1`` / ``localhost`` / ``::1`` 回环 http 地址。

CLI::

    python -X utf8 -m client.auto_configure            # 只预览
    python -X utf8 -m client.auto_configure --apply    # 备份并写入
    python -X utf8 -m client.auto_configure --apply --json
    python -X utf8 client/auto_configure.py ...        # 直接运行也支持

``server.py`` / 客户端向导可以复用 ``build_plan`` / ``apply_plan`` /
``public_summary`` / ``AutoConfigError``，不要自己解析 YAML。
"""

from __future__ import annotations

import argparse
import codecs
import json
import os
import re
import sys
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

try:  # ``python -m client.auto_configure`` 或作为包被 server.py 导入
    from .discovery import discover, local_url, read_object
except ImportError:  # pragma: no cover - ``python client/auto_configure.py`` 直接运行
    from discovery import discover, local_url, read_object


PLUGIN_ID = "dsh-moments-agent"
PATCH_FILE_NAME = "cordis.patch.yml"
PROJECT_ROOT = Path(__file__).resolve().parent.parent

DEFAULT_PUBLISH_MODE = "PREPARE_ONLY"
DEFAULT_OWNER_CHANNEL = "manual"
DEFAULT_LLM_PROVIDER = "deepseek-account"
DEFAULT_LLM_MODEL = "deepseek-flash"
DEFAULT_HOOK_BASE_URL = "http://127.0.0.1:11230"
DEFAULT_DESKTOP_EXECUTOR_BASE_URL = "http://127.0.0.1:18765"
DEFAULT_ADMIN_PORT = 18766
DEFAULT_ADMIN_TOKEN_FILE = "data/admin-token.txt"
READER_STATUS_PATH = "/api/v1/reader/status"
READER_TIMEOUT_SECONDS = 3.0
MAX_PATCH_BYTES = 2 * 1024 * 1024
MAX_JSON_BYTES = 1024 * 1024
MAX_TEXT_FIELD = 512

_ENTRY_ID_TEMPLATE = r"^- id: ['\"]?{entry_id}['\"]?[ \t]*(?:#.*)?$"
_LITERAL_LINE_RE = re.compile(r"^( +)([A-Za-z][A-Za-z0-9_]*):(.*)$")
_WXID_RE = re.compile(r"wxid_[A-Za-z0-9_-]+")


class AutoConfigError(ValueError):
    """自动配置前置条件 / 写入错误（中文 message，可直接展示；绝不含令牌）。

    继承 ``ValueError``：客户端服务端现有「ValueError → HTTP 400」映射可直接复用。
    写入失败时保证原文件不产生部分写入。
    """

    def user_message(self) -> str:
        return str(self)


# ---------------------------------------------------------------------------
# 计划对象
# ---------------------------------------------------------------------------


@dataclass
class AutoConfigPlan:
    """一次自动配置的检测结果与待写入内容。

    契约字段见 docs/operations/AUTO_SETUP.md；另外几个带默认值的字段只供
    ``apply_plan`` / ``public_summary`` 内部使用（客户端不要构造本对象）。
    """

    profile: str = ""
    patchPath: str = ""
    existed: bool = False
    block: str = ""
    changedFields: list[str] = field(default_factory=list)
    detected: dict = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    backupPath: str | None = None

    # -- 内部字段：不直接返回给浏览器，经 public_summary 脱敏后输出 --
    dataDir: str = ""
    desktopAccountPath: str | None = None
    desktopAccountValue: str = ""
    desktopAccountAction: str = "none"
    generatedAt: datetime | None = None
    projectRoot: str = ""
    userHome: str = ""
    applied: bool = False


# ---------------------------------------------------------------------------
# 可注入的本机访问封装（测试全部注入，不联网、不碰真实进程）
# ---------------------------------------------------------------------------


def _home_dir() -> Path:
    return Path.home()


def _list_processes():
    """默认进程枚举；失败由 build_plan 降级处理。"""
    from desktop.window_locator import WindowLocator

    return WindowLocator().list_processes()


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Reader 请求禁止重定向：避免回环服务把 Bearer 令牌带到其他地址。"""

    def redirect_request(self, *args, **kwargs):  # noqa: D401 - urllib 接口
        return None


def _default_fetch(url: str, headers: dict, timeout: float):
    """默认 Reader 状态探测：GET 回环地址，响应解析为 JSON 对象。

    异常信息只保留 HTTP 状态 / 类型，不读取响应正文（正文可能含账号信息）。
    """
    effective_timeout = min(float(timeout), READER_TIMEOUT_SECONDS)
    request = urllib.request.Request(url, headers=headers, method="GET")
    opener = urllib.request.build_opener(_NoRedirect)
    with opener.open(request, timeout=effective_timeout) as response:
        status = getattr(response, "status", 200)
        if status < 200 or status >= 300:
            raise OSError(f"HTTP {status}")
        raw = response.read(MAX_JSON_BYTES + 1)
    if len(raw) > MAX_JSON_BYTES:
        raise ValueError("响应过大")
    payload = json.loads(raw.decode("utf-8-sig") or "{}")
    if not isinstance(payload, dict):
        raise ValueError("响应不是 JSON 对象")
    return payload


# ---------------------------------------------------------------------------
# 受限字面量读取 / 结构检查 / 配置块渲染 / 行级合并
# ---------------------------------------------------------------------------


def _entry_indexes(lines: list[str], entry_id: str = PLUGIN_ID) -> list[int]:
    pattern = re.compile(_ENTRY_ID_TEMPLATE.format(entry_id=re.escape(entry_id)))
    return [index for index, line in enumerate(lines) if pattern.match(line)]


def _entry_end(lines: list[str], start: int) -> int:
    """条目边界 = 下一条顶层 ``- `` 或 EOF。"""
    end = start + 1
    while end < len(lines) and not lines[end].startswith("- "):
        end += 1
    return end


def _structure_error(lines: list[str]) -> str | None:
    """确认文件是「顶层 YAML 数组」；识别不了就拒绝自动写入。"""
    content_seen = False
    for index, line in enumerate(lines, start=1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if line.startswith("- "):
            content_seen = True
            continue
        if line.startswith((" ", "\t")):
            if not content_seen:
                return f"第 {index} 行不是顶层数组条目"
            continue
        if stripped == "---" or stripped.startswith("--- "):
            continue
        return f"第 {index} 行不是顶层数组条目"
    return None


def _looks_like_special(raw: str) -> bool:
    return raw.startswith(("!", "|", ">", "&", "*", "{", "["))


def _literal_value(raw: str):
    """把受限 YAML 标量读成 str/bool/int；求值语义（!!js 等）一律返回 None。"""
    raw = raw.strip()
    if not raw:
        return None
    if raw.startswith('"'):
        try:
            value = json.loads(raw)
        except ValueError:
            return None
        return value if isinstance(value, str) else None
    if raw.startswith("'"):
        if len(raw) >= 2 and raw.endswith("'"):
            return raw[1:-1].replace("''", "'")
        return None
    raw = raw.split(" #", 1)[0].strip()
    if not raw or _looks_like_special(raw):
        return None
    lowered = raw.casefold()
    if lowered in ("null", "~"):
        return None
    if lowered == "true":
        return True
    if lowered == "false":
        return False
    if re.fullmatch(r"-?[0-9]+", raw):
        return int(raw)
    return raw


def read_entry_literals(text: str, entry_id: str = PLUGIN_ID) -> dict:
    """读取某个顶层条目内白名单风格的简单标量（不执行 YAML 求值）。

    只识别 4 空格缩进的 config 键与 6 空格缩进的二级键；
    返回 ``{"dataDir": ..., "wechatAgent.enabled": ...}`` 这类扁平键。
    文件里有重复条目或结构不可读时返回 ``{}``（调用方跳过对比，不报错）。
    """
    lines = text.splitlines()
    entries = _entry_indexes(lines, entry_id)
    if len(entries) != 1:
        return {}
    start = entries[0]
    end = _entry_end(lines, start)
    section = None
    output: dict = {}
    for line in lines[start + 1 : end]:
        match = _LITERAL_LINE_RE.match(line)
        if not match:
            continue
        indent = len(match.group(1))
        key = match.group(2)
        raw = match.group(3)
        has_value = bool(raw.strip()) and not raw.strip().startswith("#")
        if indent == 4:
            if has_value:
                section = None
                value = _literal_value(raw)
                if value is not None:
                    output[key] = value
            else:
                section = key
        elif indent == 6 and section:
            value = _literal_value(raw)
            if value is not None:
                output[f"{section}.{key}"] = value
    return output


def _yaml_scalar(value: str) -> str:
    """渲染一个 YAML 标量：安全字符直接写，含空格/特殊字符用单引号转义。"""
    if value == "":
        return "''"
    if re.fullmatch(r"[A-Za-z0-9_./\\:@+=-]+", value) and not re.fullmatch(
        r"[-+]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)", value
    ):
        return value
    return "'" + value.replace("'", "''") + "'"


def render_block(
    *,
    data_dir: str,
    llm_provider: str,
    llm_model: str,
    wechat_agent: dict,
    admin_port: int = DEFAULT_ADMIN_PORT,
    admin_token_file: str = DEFAULT_ADMIN_TOKEN_FILE,
) -> str:
    """生成插件条目块（含注释；不含任何令牌正文）。"""
    agent = wechat_agent or {}
    enabled = bool(agent.get("enabled"))
    lines = [
        f"- id: {PLUGIN_ID}",
        "  # 由自动配置生成：只包含本机路径与安全默认值，不含任何令牌正文；写入后需重启 DSH 插件生效。",
        f"  name: {PLUGIN_ID}",
        "  config:",
        "    enabled: true",
        f"    dataDir: {_yaml_scalar(data_dir)}",
        f"    publishMode: {DEFAULT_PUBLISH_MODE}",
        "    killSwitch: false",
        "    scheduleEnabled: false",
        f"    ownerChannel: {DEFAULT_OWNER_CHANNEL}",
        "    llm:",
        f"      provider: {_yaml_scalar(llm_provider)}",
        f"      model: {_yaml_scalar(llm_model)}",
        "    wechatAgent:",
        f"      enabled: {'true' if enabled else 'false'}",
    ]
    reader_base_url = agent.get("readerBaseUrl")
    if enabled and reader_base_url:
        lines.append(f"      readerBaseUrl: {_yaml_scalar(str(reader_base_url))}")
    hook_base_url = agent.get("hookBaseUrl") or DEFAULT_HOOK_BASE_URL
    lines.append(f"      hookBaseUrl: {_yaml_scalar(str(hook_base_url))}")
    if enabled and agent.get("readerConfigPath"):
        lines.append(f"      readerConfigPath: {_yaml_scalar(str(agent['readerConfigPath']))}")
    if enabled and agent.get("hookTokenFile"):
        lines.append(f"      hookTokenFile: {_yaml_scalar(str(agent['hookTokenFile']))}")
    lines.append(f"      account: {_yaml_scalar(str(agent.get('account') or ''))}")
    lines.append(f"      ownerWxid: {_yaml_scalar(str(agent.get('ownerWxid') or ''))}")
    lines.extend(
        [
            "    desktopExecutor:",
            "      enabled: false",
            f"      baseUrl: {_yaml_scalar(DEFAULT_DESKTOP_EXECUTOR_BASE_URL)}",
            "    images:",
            "      providers:",
            "        - manual-subscription",
            "        - local-import",
            "      officialApiEnabled: false",
            "    policy:",
            "      dailyLimit: 2",
            "      minIntervalMinutes: 180",
            "      quietHours: ['23:00', '08:00']",
            "      requireApproval: true",
            "      approvalTtlMinutes: 120",
            "      minScoreToPublish: 0.62",
            "    adminServer:",
            "      enabled: true",
            f"      port: {int(admin_port)}",
            f"      tokenFile: {_yaml_scalar(admin_token_file)}",
            "    chatMemory:",
            "      enabled: false",
        ]
    )
    return "\n".join(lines) + "\n"


def merge_patch_text(text: str, block: str) -> str:
    """把配置块合并进 patch 文本：已有条目整块替换，没有则追加。

    - 只按行定位 ``^- id: dsh-moments-agent``；条目边界 = 下一条顶层 ``- `` 或 EOF；
    - 其他条目、注释、``!!js`` 原样保留；条目尾部与下一条之间的空行/注释保留；
    - 文件结构不是顶层数组、或条目重复时抛 ``AutoConfigError``（拒绝写入）。
    """
    if not isinstance(text, str) or not isinstance(block, str):
        raise AutoConfigError("配置结构内部错误：patch/block 不是文本")
    block_text = block.replace("\r\n", "\n").replace("\r", "\n")
    block_lines = block_text.rstrip("\n").split("\n")
    if not block_lines or not block_lines[0].strip():
        raise AutoConfigError("生成的配置块为空，已取消写入")

    lines = text.splitlines()
    structure_error = _structure_error(lines)
    if structure_error:
        raise AutoConfigError(
            f"{structure_error}；文件结构无法安全识别，请按 docs/operations/AUTO_SETUP.md 手工配置"
        )
    entries = _entry_indexes(lines)
    if len(entries) > 1:
        raise AutoConfigError(
            f"profile 中存在 {len(entries)} 个 {PLUGIN_ID} 条目，无法确定替换哪一个；请先手工合并"
        )

    crlf = text.count("\r\n")
    lf_only = text.count("\n") - crlf
    newline = "\r\n" if crlf > lf_only else "\n"

    if entries:
        start = entries[0]
        end = _entry_end(lines, start)
        boundary = end
        # 保留条目与下一条之间的空行/注释（属于分隔区，不属于被替换的条目）。
        while end > start + 1 and (
            not lines[end - 1].strip() or lines[end - 1].lstrip().startswith("#")
        ):
            end -= 1
        new_lines = lines[:start] + block_lines + lines[end:boundary] + lines[boundary:]
    else:
        new_lines = list(lines)
        while new_lines and not new_lines[-1].strip():
            new_lines.pop()
        if new_lines:
            new_lines.append("")
        new_lines.extend(block_lines)

    merged = newline.join(new_lines)
    if not merged.endswith("\n"):
        merged += newline
    return merged


# ---------------------------------------------------------------------------
# 环境检测（全部只读、全部可注入）
# ---------------------------------------------------------------------------


def _forward_slashes(path) -> str:
    return str(path).replace("\\", "/")


def _safe_text(value, max_length: int = MAX_TEXT_FIELD) -> str:
    if not isinstance(value, str):
        return ""
    value = value.strip()
    if not value or len(value) > max_length:
        return ""
    return value


def _first_text(mapping: dict, *keys: str) -> str:
    for key in keys:
        value = _safe_text(mapping.get(key))
        if value:
            return value
    return ""


def _profile_is_registered(profile_dir: Path) -> bool:
    package = read_object(profile_dir / "package.json")
    dependencies = package.get("dependencies")
    if isinstance(dependencies, dict) and PLUGIN_ID in dependencies:
        return True
    dsh = package.get("dsh")
    profile = dsh.get("profile") if isinstance(dsh, dict) else None
    bundles = profile.get("bundles") if isinstance(profile, dict) else None
    return isinstance(bundles, list) and PLUGIN_ID in bundles


def _profile_dependency(profile_dir: Path) -> object:
    package = read_object(profile_dir / "package.json")
    dependencies = package.get("dependencies")
    return dependencies.get(PLUGIN_ID) if isinstance(dependencies, dict) else None


def _resolve_plugin_root(profile_dir: Path, project_root: Path, warnings: list[str]):
    """推导插件安装根目录：profile 依赖 link: > node_modules > 传入的项目根。"""
    dependency = _profile_dependency(profile_dir)
    if isinstance(dependency, str) and dependency.strip().lower().startswith("link:"):
        raw_path = dependency.strip()[len("link:") :].strip()
        if raw_path:
            candidate = Path(raw_path).expanduser()
            if not candidate.is_absolute():
                candidate = profile_dir / candidate
            try:
                candidate = candidate.resolve()
            except OSError:
                candidate = None
            if candidate is not None and candidate.is_dir():
                return candidate, "profile-package.json-link"
            warnings.append(
                f"profile 依赖中的 {PLUGIN_ID} 链接路径不存在（{raw_path}），继续尝试其他位置。"
            )
    plugin_dir = profile_dir / "node_modules" / PLUGIN_ID
    if plugin_dir.is_dir():
        package = read_object(plugin_dir / "package.json")
        if package.get("name") == PLUGIN_ID:
            try:
                return plugin_dir.resolve(), "profile-node_modules"
            except OSError:
                pass
    root = project_root
    warnings.append(
        "未在 profile 中找到插件注册路径，dataDir 回退为传入的项目目录 data"
        "（可能不正确，请在写入前确认）。"
    )
    return root, "project-root-fallback"


def _select_profile(
    profiles: list[dict], requested: str | None, warnings: list[str]
) -> tuple[dict | None, str | None]:
    by_name: dict[str, dict] = {}
    for item in profiles:
        if isinstance(item, dict) and isinstance(item.get("name"), str):
            by_name[item["name"]] = item
    if requested:
        selected = by_name.get(requested)
        if selected is None:
            return None, f"DSH profile 不存在：{requested}"
        return selected, None
    if not by_name:
        return None, "未找到 DSH profile（~/.dsh/profiles 为空）；请先安装并启动 DSH"
    names = sorted(by_name)
    registered = []
    for name in names:
        path_text = by_name[name].get("path")
        if isinstance(path_text, str) and path_text:
            if _profile_is_registered(Path(path_text)):
                registered.append(by_name[name])
    if len(registered) == 1:
        return registered[0], None
    if len(registered) > 1:
        names_text = "、".join(str(item.get("name")) for item in registered)
        return None, f"检测到多个已注册 {PLUGIN_ID} 的 profile（{names_text}），请使用 --profile 指定"
    if "desktop" in by_name:
        warnings.append("未检测到已注册 dsh-moments-agent 的 profile，默认使用 desktop profile。")
        return by_name["desktop"], None
    if len(names) == 1:
        warnings.append(f"未检测到已注册 dsh-moments-agent 的 profile，使用唯一的 profile：{names[0]}。")
        return by_name[names[0]], None
    return None, f"检测到多个 profile（{'、'.join(names)}）但都未注册 {PLUGIN_ID}，请使用 --profile 指定"


def _probe_reader_status(
    base_url: str, token: str, fetch, warnings: list[str]
) -> dict:
    """只读探测 Reader 状态，返回 ownWxid/accountDirectory；失败只 warning。"""
    url = base_url.rstrip("/") + READER_STATUS_PATH
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    fetch = fetch or _default_fetch
    try:
        payload = fetch(url, headers, READER_TIMEOUT_SECONDS)
    except Exception as exc:  # 不拼接异常原文：自定义 fetch 的异常可能含敏感信息
        warnings.append(
            f"Reader 状态探测失败（{type(exc).__name__}）：account/ownerWxid 留空，不影响写入。"
        )
        return {}
    finally:
        headers.clear()
        token = ""  # noqa: F841 - 令牌不保留在计划里
    if not isinstance(payload, dict):
        warnings.append("Reader 状态响应不是 JSON 对象：account/ownerWxid 留空。")
        return {}
    if payload.get("ok") is False:
        warnings.append("Reader 状态接口返回未就绪：account/ownerWxid 留空。")
        return {}
    data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    own_wxid = _first_text(data, "ownWxid", "own_wxid")
    account_directory = _first_text(data, "accountDirectory", "account_directory")
    if not own_wxid and not account_directory:
        warnings.append("Reader 状态未返回 ownWxid/accountDirectory：账号信息留空。")
        return {}
    return {"ownWxid": own_wxid, "accountDirectory": account_directory}


def _detect_wechat_agent(discovered: dict, fetch, warnings: list[str]) -> dict:
    """从 discovery 结果读取 WeChatAgent 配置；任何失败都降级，不中断。"""
    result = {
        "found": False,
        "enabled": False,
        "dataDir": None,
        "readerConfigPath": None,
        "readerBaseUrl": None,
        "hookBaseUrl": DEFAULT_HOOK_BASE_URL,
        "hookTokenFile": None,
        "account": "",
        "ownerWxid": "",
        "accountDirectory": "",
        "readerStatus": "not-configured",
        "llmProvider": "",
        "llmModel": "",
        "ports": {},
    }
    connections = discovered.get("wechatConnections")
    if not isinstance(connections, list) or not connections:
        warnings.append(
            "未检测到 WeChatAgent 数据目录：wechatAgent 保持关闭，Hook 地址使用默认值 "
            f"{DEFAULT_HOOK_BASE_URL}；可稍后在 DSH 中手工填写。"
        )
        return result
    if len(connections) > 1:
        warnings.append(f"检测到 {len(connections)} 个 WeChatAgent 数据目录，仅使用第一个。")
    connection = connections[0] if isinstance(connections[0], dict) else {}
    data_dir_text = _safe_text(connection.get("dataDir"), 1024)
    if not data_dir_text:
        warnings.append("WeChatAgent 数据目录信息不完整：wechatAgent 保持关闭。")
        return result
    data_dir = Path(data_dir_text)
    result["found"] = True
    result["dataDir"] = _forward_slashes(data_dir)

    # ---- wechatagent.json：Hook 地址 / dsh provider,model ----
    agent_config = read_object(data_dir / "workspace" / "config" / "wechatagent.json")
    if not agent_config:
        warnings.append(
            "未找到或无法解析 wechatagent.json：Hook 地址使用默认值，模型使用 profile 中的 "
            "agent-default-model 或默认值。"
        )
    else:
        hook = agent_config.get("hook")
        hook_raw = hook.get("baseUrl") if isinstance(hook, dict) else None
        hook_url = local_url(hook_raw) if hook_raw else None
        if hook_url:
            result["hookBaseUrl"] = hook_url
        elif hook_raw:
            warnings.append("wechatagent.json 中 hook.baseUrl 无效或不是本机回环地址，已回退默认值。")
        dsh = agent_config.get("dsh")
        if isinstance(dsh, dict):
            result["llmProvider"] = _safe_text(dsh.get("provider"), 120)
            result["llmModel"] = _safe_text(dsh.get("model"), 120)
        ports = agent_config.get("ports")
        if isinstance(ports, dict):
            safe_ports = {}
            for name in ("weflow", "onebot", "adapter", "dshPlugin"):
                value = ports.get(name)
                if isinstance(value, int) and 1 <= value <= 65535:
                    safe_ports[name] = value
            result["ports"] = safe_ports

    hook_token_path = data_dir / "workspace" / "state" / "hook" / "native-token.txt"
    try:
        if hook_token_path.is_file():
            result["hookTokenFile"] = _forward_slashes(hook_token_path.resolve())
    except OSError:
        pass

    # ---- wechat-io-config.json：Reader 地址 / 令牌（正文只用于一次探测）----
    reader_path_text = _safe_text(connection.get("readerConfigPath"), 1024)
    if not reader_path_text:
        warnings.append("未找到 wechat-io-config.json：wechatAgent 保持关闭。")
        return result
    reader_path = Path(reader_path_text)
    reader_config = read_object(reader_path)
    if not reader_config:
        warnings.append("wechat-io-config.json 无法读取或为空：wechatAgent 保持关闭。")
        return result
    raw_base_url = reader_config.get("reader_base_url")
    reader_base_url = local_url(raw_base_url) if raw_base_url else None
    if not reader_base_url:
        if raw_base_url in (None, ""):
            warnings.append("wechat-io-config.json 缺少 reader_base_url：wechatAgent 保持关闭。")
        else:
            warnings.append(
                "wechat-io-config.json 的 reader_base_url 不是本机回环地址，已拒绝该字段："
                "wechatAgent 保持关闭。"
            )
        return result

    result["enabled"] = True
    result["readerConfigPath"] = _forward_slashes(reader_path.resolve())
    result["readerBaseUrl"] = reader_base_url
    result["readerStatus"] = "configured"

    token = _safe_text(reader_config.get("reader_token"), 4096)
    if not token:
        warnings.append(
            "wechat-io-config.json 未提供 Reader 令牌：跳过账号探测，account/ownerWxid 留空。"
        )
        return result
    status = _probe_reader_status(reader_base_url, token, fetch, warnings)
    token = ""  # noqa: F841 - 令牌正文不保留在计划/摘要里
    if status:
        # 与插件 adapter 的校验语义保持一致：account 存 Reader 的 accountDirectory
        # （微信数据目录名 / 账号 id），ownerWxid 存 ownWxid（审批人 wxid）。
        own_wxid = _safe_text(status.get("ownWxid"), MAX_TEXT_FIELD)
        account_directory = _safe_text(status.get("accountDirectory"), MAX_TEXT_FIELD)
        result["readerStatus"] = "ok"
        result["account"] = account_directory or own_wxid
        result["ownerWxid"] = own_wxid
        result["accountDirectory"] = account_directory
    elif result["readerStatus"] == "configured":
        result["readerStatus"] = "unavailable"
    return result


def _detect_llm(wechat: dict, patch_text: str | None, warnings: list[str]) -> dict:
    """provider/model 优先级：wechatagent.json → profile agent-default-model → 默认。"""
    profile_provider = profile_model = ""
    if patch_text:
        settings = read_entry_literals(patch_text, "agent-default-model")
        profile_provider = _safe_text(settings.get("provider"), 120)
        profile_model = _safe_text(settings.get("model"), 120)

    def pick(detected: str, profile_value: str, fallback: str, label: str) -> tuple[str, str]:
        if detected:
            return detected, "wechatagent"
        if profile_value:
            return profile_value, "profile-agent-default-model"
        warnings.append(f"未检测到 {label}，使用默认值。")
        return fallback, "default"

    provider, provider_source = pick(
        _safe_text(wechat.get("llmProvider"), 120),
        profile_provider,
        DEFAULT_LLM_PROVIDER,
        "LLM provider",
    )
    model, model_source = pick(
        _safe_text(wechat.get("llmModel"), 120),
        profile_model,
        DEFAULT_LLM_MODEL,
        "LLM model",
    )
    source = provider_source if provider_source == model_source else "mixed"
    return {"provider": provider, "model": model, "source": source}


# ---------------------------------------------------------------------------
# 脱敏 / 公开摘要
# ---------------------------------------------------------------------------


def _mask_wxid(value: str) -> str:
    def replace(match: re.Match) -> str:
        raw = match.group(0)
        # 已经掩码过的（wxid_xxx***）不再二次掩码，保证摘要幂等。
        if value[match.end() :].startswith("***"):
            return raw
        return raw[:6] + "***" if len(raw) > 6 else "***"

    return _WXID_RE.sub(replace, value)


def _mask_identifier(value) -> str:
    text = _safe_text(value)
    if not text:
        return ""
    if text.startswith("wxid_"):
        return _mask_wxid(text)
    if len(text) > 2:
        return text[:2] + "***"
    return text[0] + "***"


def _redact_home(text: str, home: str) -> str:
    if not home:
        return text
    variants = {home, home.replace("\\", "/"), home.replace("/", "\\")}
    for variant in sorted(variants, key=len, reverse=True):
        if not variant:
            continue
        text = re.sub(
            re.escape(variant) + r"(?=$|[\\/])", "~", text, flags=re.IGNORECASE
        )
    return text


def _sanitize_value(value, home: str):
    if isinstance(value, str):
        return _mask_wxid(_redact_home(value, home))
    if isinstance(value, list):
        return [_sanitize_value(item, home) for item in value]
    if isinstance(value, tuple):
        return [_sanitize_value(item, home) for item in value]
    if isinstance(value, dict):
        return {str(key): _sanitize_value(item, home) for key, item in value.items()}
    return value


def public_summary(plan: AutoConfigPlan) -> dict:
    """JSON 安全、脱敏后的计划摘要（供 CLI / HTTP 返回）。

    home 目录替换为 ``~``；wxid 只保留前 6 位 + ``***``；令牌正文从不出现在任何字段。
    """
    home = plan.userHome or ""
    summary = {
        "profile": plan.profile,
        "patchPath": plan.patchPath,
        "existed": bool(plan.existed),
        "block": plan.block,
        "changedFields": list(plan.changedFields),
        "detected": plan.detected,
        "warnings": list(plan.warnings),
        "errors": list(plan.errors),
        "backupPath": plan.backupPath,
        "dataDir": plan.dataDir,
        "desktopAccountPath": plan.desktopAccountPath,
        "desktopAccountAction": plan.desktopAccountAction,
        "applied": bool(plan.applied),
        "restartRequired": bool(plan.applied),
    }
    return _sanitize_value(summary, home)


# ---------------------------------------------------------------------------
# 检测主体
# ---------------------------------------------------------------------------


def _changed_fields(existing: dict, generated: dict) -> list[str]:
    changed = []
    for name, value in generated.items():
        if value is None:
            continue
        if name in existing and existing[name] != value:
            changed.append(name)
    return changed


def _display_generated_value(name: str, value) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if name in ("wechatAgent.account", "wechatAgent.ownerWxid"):
        return _mask_identifier(value)
    return str(value)


def _display_existing_value(name: str, value) -> str:
    return _display_generated_value(name, value)


def _desktop_account_plan(plan: AutoConfigPlan) -> None:
    """预先判断 desktop-account.txt 的处理方式（真正写入在 apply_plan 里复核）。"""
    if not plan.desktopAccountValue:
        plan.desktopAccountAction = "none"
        return
    path = Path(plan.desktopAccountPath or "")
    try:
        if path.is_file():
            existing = _safe_text(path.read_text(encoding="utf-8-sig"), 1024)
            if existing == plan.desktopAccountValue:
                plan.desktopAccountAction = "unchanged"
            else:
                plan.desktopAccountAction = "keep"
                plan.warnings.append(
                    "已有 desktop-account.txt 内容与检测到的账号目录不同，将保留现有文件不覆盖。"
                )
            return
        if path.exists():
            plan.desktopAccountAction = "keep"
            plan.warnings.append("desktop-account.txt 路径已存在但不是普通文件，将不写入账号目录。")
            return
        plan.desktopAccountAction = "create"
    except (OSError, UnicodeDecodeError):
        plan.desktopAccountAction = "keep"
        plan.warnings.append("无法检查 desktop-account.txt 状态，将不写入账号目录。")


def _build_detected(
    *,
    profile_name: str,
    available_profiles: list[str],
    plugin_root: str,
    data_dir: str,
    data_dir_source: str,
    existed: bool,
    llm: dict,
    wechat: dict,
    admin_port: int,
    admin_token_file: str,
    desktop_account_path: str | None,
    desktop_account_action: str,
) -> dict:
    wechat_summary = None
    if wechat.get("found"):
        wechat_summary = {
            "enabled": bool(wechat.get("enabled")),
            "dataDir": wechat.get("dataDir"),
            "readerBaseUrl": wechat.get("readerBaseUrl"),
            "hookBaseUrl": wechat.get("hookBaseUrl"),
            "readerConfigPath": wechat.get("readerConfigPath"),
            "hookTokenFile": wechat.get("hookTokenFile"),
            "account": _mask_identifier(wechat.get("account")),
            "ownerWxid": _mask_identifier(wechat.get("ownerWxid")),
            "accountDirectory": _mask_identifier(wechat.get("accountDirectory")),
            "readerStatus": wechat.get("readerStatus"),
            "ports": dict(wechat.get("ports") or {}),
        }
    return {
        "profile": profile_name,
        "availableProfiles": available_profiles,
        "patchExisted": bool(existed),
        "pluginRoot": plugin_root,
        "dataDir": data_dir,
        "dataDirSource": data_dir_source,
        "llm": dict(llm),
        "wechatAgent": wechat_summary,
        "adminServer": {"port": int(admin_port), "tokenFile": admin_token_file},
        "desktopAccountPath": desktop_account_path,
        "desktopAccountAction": desktop_account_action,
    }


def build_plan(
    project_root,
    *,
    profile: str | None = None,
    user_home=None,
    environment=None,
    processes=None,
    fetch=None,
    now=None,
) -> AutoConfigPlan:
    """检测本机环境并生成计划；预期内的失败写入 ``plan.errors``，不抛异常。

    ``processes`` / ``environment`` / ``fetch`` / ``now`` 仅用于测试注入；
    真实调用传 ``None``（本机进程、真实环境变量、真实回环探测、当前时间）。
    """
    try:
        root = Path(project_root).expanduser().resolve()
    except (OSError, ValueError, TypeError):
        root = PROJECT_ROOT
    home_path = Path(user_home).expanduser() if user_home is not None else _home_dir()
    try:
        home_path = home_path.resolve()
    except OSError:
        pass
    plan = AutoConfigPlan(
        projectRoot=_forward_slashes(root),
        userHome=str(home_path),
        generatedAt=now if isinstance(now, datetime) else datetime.now(),
    )
    warnings = plan.warnings

    process_list = None if processes is None else list(processes)
    if process_list is None:
        try:
            process_list = list(_list_processes())
        except Exception as exc:  # 进程枚举失败不阻断（已知安装位置仍可检测）
            process_list = []
            warnings.append(
                f"无法枚举本机进程（{type(exc).__name__}），继续使用已知安装位置检测。"
            )
    try:
        discovered = discover(
            root, user_home=home_path, processes=process_list, environment=environment
        )
    except Exception as exc:
        discovered = {}
        plan.errors.append(f"本机环境探测失败（{type(exc).__name__}），无法生成配置。")
    if not isinstance(discovered, dict):
        discovered = {}
        plan.errors.append("本机环境探测返回了无效结果，无法生成配置。")

    discovered_profiles = discovered.get("profiles")
    profile_items = (
        [item for item in discovered_profiles if isinstance(item, dict)]
        if isinstance(discovered_profiles, list)
        else []
    )
    available_profiles = sorted(
        str(item.get("name")) for item in profile_items if isinstance(item.get("name"), str)
    )
    selected, selection_error = _select_profile(profile_items, profile, warnings)
    if selection_error:
        plan.errors.append(selection_error)
    if selected is None:
        plan.detected = {
            "availableProfiles": available_profiles,
            "profile": "",
        }
        if not available_profiles:
            plan.detected["hint"] = "请先安装并启动 DSH，确保 ~/.dsh/profiles/<profile>/ 存在。"
        return plan

    profile_name = str(selected.get("name"))
    plan.profile = profile_name
    profile_path_text = _safe_text(selected.get("path"), 2048)
    if not profile_path_text:
        plan.errors.append("选中的 profile 路径无效，无法定位 cordis.patch.yml。")
        return plan
    profile_dir = Path(profile_path_text)
    patch_path = profile_dir / PATCH_FILE_NAME
    plan.patchPath = _forward_slashes(patch_path)

    if not patch_path.is_file():
        plan.errors.append(
            f"profile {profile_name} 缺少 cordis.patch.yml：{patch_path}；"
            "请先启动一次 DSH 生成该文件，或按 docs/operations/AUTO_SETUP.md 手工创建。"
        )
        return plan

    patch_text: str | None = None
    try:
        if patch_path.stat().st_size > MAX_PATCH_BYTES:
            plan.errors.append("cordis.patch.yml 过大（超过 2MB），为安全起见拒绝自动修改。")
        else:
            patch_text = patch_path.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeDecodeError) as exc:
        plan.errors.append(f"无法读取 cordis.patch.yml（{type(exc).__name__}），已取消自动配置。")

    if patch_text is not None:
        lines = patch_text.splitlines()
        structure_error = _structure_error(lines)
        if structure_error:
            plan.errors.append(
                f"{structure_error}；文件结构无法安全识别，请按 docs/operations/AUTO_SETUP.md 手工配置。"
            )
        entries = _entry_indexes(lines)
        plan.existed = len(entries) > 0
        if len(entries) > 1:
            plan.errors.append(
                f"profile 中存在 {len(entries)} 个 {PLUGIN_ID} 条目，无法确定替换哪一个；请先手工合并。"
            )
        existing = read_entry_literals(patch_text)

    plugin_root, data_dir_source = _resolve_plugin_root(profile_dir, root, warnings)
    try:
        plugin_root = plugin_root.resolve()
    except OSError:
        pass
    data_dir = (plugin_root / "data").resolve()
    data_dir_display = _forward_slashes(data_dir)
    plan.dataDir = data_dir_display

    wechat = _detect_wechat_agent(discovered, fetch, warnings)
    llm = _detect_llm(wechat, patch_text, warnings)

    block = render_block(
        data_dir=data_dir_display,
        llm_provider=llm["provider"],
        llm_model=llm["model"],
        wechat_agent=wechat,
        admin_port=DEFAULT_ADMIN_PORT,
        admin_token_file=DEFAULT_ADMIN_TOKEN_FILE,
    )
    plan.block = block

    generated = {
        "dataDir": data_dir_display,
        "publishMode": DEFAULT_PUBLISH_MODE,
        "wechatAgent.enabled": bool(wechat.get("enabled")),
        "wechatAgent.readerBaseUrl": wechat.get("readerBaseUrl"),
        "wechatAgent.hookBaseUrl": wechat.get("hookBaseUrl"),
        "wechatAgent.account": str(wechat.get("account") or ""),
        "wechatAgent.ownerWxid": str(wechat.get("ownerWxid") or ""),
        "adminServer.port": DEFAULT_ADMIN_PORT,
    }
    if plan.existed:
        plan.changedFields = _changed_fields(existing, generated)
        for name in plan.changedFields:
            old_value = existing.get(name)
            new_value = generated.get(name)
            warnings.append(
                f"现有配置中的 {name} 为 {_display_existing_value(name, old_value)}，"
                f"本次将按检测值写为 {_display_generated_value(name, new_value)}。"
            )
    else:
        plan.changedFields = [name for name, value in generated.items() if value is not None]

    if wechat.get("enabled") and not wechat.get("account"):
        warnings.append(
            "Reader 状态不可读：account/ownerWxid 留空；可等 WeChatAgent/Reader 启动后重新运行自动配置。"
        )
    plan.desktopAccountPath = _forward_slashes(data_dir / "desktop-account.txt")
    plan.desktopAccountValue = str(wechat.get("accountDirectory") or "")
    _desktop_account_plan(plan)

    plan.detected = _build_detected(
        profile_name=profile_name,
        available_profiles=available_profiles,
        plugin_root=_forward_slashes(plugin_root),
        data_dir=data_dir_display,
        data_dir_source=data_dir_source,
        existed=plan.existed,
        llm=llm,
        wechat=wechat,
        admin_port=DEFAULT_ADMIN_PORT,
        admin_token_file=DEFAULT_ADMIN_TOKEN_FILE,
        desktop_account_path=plan.desktopAccountPath,
        desktop_account_action=plan.desktopAccountAction,
    )
    return plan


# ---------------------------------------------------------------------------
# 写入（备份 + 原子替换 + 可选 desktop-account.txt）
# ---------------------------------------------------------------------------


def _backup_path_for(patch_path: Path, when: datetime | None) -> Path:
    stamp = (when or datetime.now()).strftime("%Y%m%d-%H%M%S")
    candidate = patch_path.with_name(f"{patch_path.name}.{stamp}.bak")
    if not candidate.exists():
        return candidate
    for index in range(1, 100):
        alternative = patch_path.with_name(f"{patch_path.name}.{stamp}-{index}.bak")
        if not alternative.exists():
            return alternative
    raise AutoConfigError("备份文件过多，已取消写入；请清理旧的 .bak 文件后重试。")


def _atomic_write_bytes(path: Path, data: bytes) -> None:
    temporary = path.with_name(f"{path.name}.tmp-{os.getpid()}")
    try:
        with open(temporary, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except OSError as exc:
        try:
            if temporary.exists():
                temporary.unlink()
        except OSError:
            pass
        raise AutoConfigError(
            f"写入 {path.name} 失败（{type(exc).__name__}），原文件未修改。"
        ) from None


def _apply_desktop_account(plan: AutoConfigPlan) -> None:
    """可选写入 <data>/desktop-account.txt；已有不同内容不覆盖，只 warning。"""
    if not plan.desktopAccountValue or not plan.desktopAccountPath:
        plan.desktopAccountAction = "none"
        return
    path = Path(plan.desktopAccountPath)
    try:
        if path.is_file():
            existing = _safe_text(path.read_text(encoding="utf-8-sig"), 1024)
            if existing == plan.desktopAccountValue:
                plan.desktopAccountAction = "unchanged"
            else:
                plan.desktopAccountAction = "keep"
                plan.warnings.append(
                    "已有 desktop-account.txt 内容与检测到的账号目录不同，已保留现有文件（未覆盖）。"
                )
            return
        if path.exists():
            plan.desktopAccountAction = "keep"
            plan.warnings.append("desktop-account.txt 路径已存在但不是普通文件，未写入账号目录。")
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        _atomic_write_bytes(path, (plan.desktopAccountValue + "\n").encode("utf-8"))
        plan.desktopAccountAction = "created"
    except (OSError, UnicodeDecodeError, AutoConfigError):
        # 账号文件是可选项：失败不推翻已经写入成功的插件配置。
        plan.desktopAccountAction = "keep"
        plan.warnings.append("无法写入 desktop-account.txt（权限或路径问题），已跳过；不影响插件配置。")


def apply_plan(plan: AutoConfigPlan, *, backup: bool = True) -> AutoConfigPlan:
    """备份并原子写入计划；前置条件错误抛 ``AutoConfigError``，绝不部分写入。"""
    if not isinstance(plan, AutoConfigPlan):
        raise AutoConfigError("内部错误：无效的自动配置计划")
    if plan.errors:
        raise AutoConfigError("；".join(str(item) for item in plan.errors))
    if not plan.block:
        raise AutoConfigError("没有可写入的配置块，请先重新检测。")
    patch_path = Path(plan.patchPath)
    if not patch_path.is_file():
        raise AutoConfigError(f"profile 配置文件不存在：{patch_path}")
    try:
        original_bytes = patch_path.read_bytes()
        original_text = original_bytes.decode("utf-8-sig")
    except (OSError, UnicodeDecodeError) as exc:
        raise AutoConfigError(
            f"无法读取 profile 配置文件（{type(exc).__name__}），已取消写入。"
        ) from None
    merged = merge_patch_text(original_text, plan.block)

    backup_path: Path | None = None
    if backup:
        backup_path = _backup_path_for(patch_path, plan.generatedAt)
        _atomic_write_bytes(backup_path, original_bytes)

    has_bom = original_bytes.startswith(codecs.BOM_UTF8)
    output = merged.encode("utf-8")
    if has_bom:
        output = codecs.BOM_UTF8 + output
    _atomic_write_bytes(patch_path, output)

    plan.backupPath = _forward_slashes(backup_path) if backup_path else None
    plan.applied = True
    _apply_desktop_account(plan)
    plan.warnings.append("配置已写入；请重启 DSH 插件（或重启 DSH）后生效。")
    return plan


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _format_plan(summary: dict) -> str:
    lines: list[str] = []
    if summary.get("applied"):
        lines.append("DSH Moments Agent 自动配置（已写入）")
    else:
        lines.append("DSH Moments Agent 自动配置（预览模式，未写入任何文件）")
    lines.append(f"profile: {summary.get('profile') or '（未确定）'}")
    lines.append(f"profile 配置: {summary.get('patchPath') or '（未确定）'}")
    lines.append(f"已有插件条目: {'是' if summary.get('existed') else '否'}")
    detected = summary.get("detected") or {}
    if detected.get("dataDir"):
        lines.append(f"dataDir: {detected.get('dataDir')}（来源：{detected.get('dataDirSource')}）")
    if detected.get("pluginRoot"):
        lines.append(f"插件目录: {detected.get('pluginRoot')}")
    llm = detected.get("llm") or {}
    if llm:
        lines.append(f"LLM: {llm.get('provider')} / {llm.get('model')}（来源：{llm.get('source')}）")
    wechat = detected.get("wechatAgent")
    if isinstance(wechat, dict):
        lines.append(f"Reader: {wechat.get('readerBaseUrl') or '（未检测到）'}")
        lines.append(f"Hook: {wechat.get('hookBaseUrl') or '（默认值）'}")
        account = wechat.get("account") or "（未读取到）"
        lines.append(f"账号: {account}（已掩码）")
    else:
        lines.append("WeChatAgent: 未检测到（将写入保守配置）")
    if summary.get("changedFields"):
        lines.append("变更字段: " + "、".join(summary["changedFields"]))
    if summary.get("warnings"):
        lines.append("警告:")
        lines.extend(f" - {item}" for item in summary["warnings"])
    if summary.get("errors"):
        lines.append("错误:")
        lines.extend(f" - {item}" for item in summary["errors"])
    if summary.get("block"):
        lines.append("")
        lines.append("将写入以下配置块（其他条目、注释与 !!js 保持不变）：")
        lines.append(summary["block"].rstrip("\n"))
    lines.append("")
    if summary.get("errors"):
        lines.append("存在前置条件错误：未写入任何文件。")
    elif summary.get("applied"):
        backup = summary.get("backupPath") or "（未备份）"
        lines.append(f"已写入：{summary.get('patchPath')}")
        lines.append(f"已备份：{backup}")
        lines.append("请重启 DSH 插件（或重启 DSH）后生效。")
        if summary.get("desktopAccountAction") in ("created", "unchanged", "keep"):
            lines.append(f"desktop-account.txt: {summary.get('desktopAccountAction')}")
    else:
        lines.append("这是预览：确认无误后加 --apply 才会备份并写入；写入后需重启 DSH 插件。")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    """CLI 入口：默认 dry-run；``--apply`` 才写入；``--json`` 输出 JSON。"""
    parser = argparse.ArgumentParser(
        description="DSH Moments Agent 自动配置（默认只预览，不写文件）"
    )
    parser.add_argument("--profile", default=None, help="指定 DSH profile 名称（默认自动选择）")
    parser.add_argument(
        "--apply", action="store_true", help="备份并写入选中 profile 的 cordis.patch.yml"
    )
    parser.add_argument("--json", action="store_true", help="输出 JSON（供客户端/脚本使用）")
    args = parser.parse_args(list(sys.argv[1:] if argv is None else argv))

    plan = build_plan(PROJECT_ROOT, profile=args.profile)
    exit_code = 2 if plan.errors else 0
    if args.apply and not plan.errors:
        try:
            plan = apply_plan(plan)
        except AutoConfigError as exc:
            plan.errors.append(exc.user_message())
            exit_code = 2
    summary = public_summary(plan)
    if args.json:
        print(json.dumps(summary, ensure_ascii=False, indent=2))
    else:
        print(_format_plan(summary))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
