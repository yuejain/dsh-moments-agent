"""Bounded local discovery. Return paths and loopback addresses, never credentials."""
from __future__ import annotations

import json
import os
import ctypes
import re
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit


def read_object(path):
    try:
        if path.stat().st_size > 1024 * 1024:
            return {}
        value = json.loads(path.read_text(encoding="utf-8-sig"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def local_url(value):
    try:
        url = urlsplit(str(value))
        if url.scheme not in ("http", "ws") or url.hostname not in ("127.0.0.1", "localhost", "::1") or url.username or url.password:
            return None
        port = url.port
        host = f"[{url.hostname}]" if ":" in url.hostname else url.hostname
        return urlunsplit(("http", host + (f":{port}" if port else ""), "", "", ""))
    except ValueError:
        return None


def profile_settings(path):
    """Read a small allowlist of literal YAML fields, never evaluate YAML/!!js."""
    try:
        if path.stat().st_size > 1024 * 1024:
            return {}
        text = path.read_text(encoding='utf-8-sig')
        entry = re.search(r'(?m)^- id: [\'\"]?dsh-moments-agent[\'\"]?\s*$',text)
        if not entry:
            return {}
        text = re.split(r'(?m)^- ',text[entry.end():],maxsplit=1)[0]
        output={}
        for key in ('dataDir','readerBaseUrl','hookBaseUrl','readerConfigPath'):
            match=re.search(r'(?m)^\s{4,8}'+key+r':\s*([^\r\n]+)',text)
            if not match: continue
            value=match.group(1).strip()
            if value.startswith('"'):
                try: value=json.loads(value)
                except ValueError: continue
            elif value.startswith("'") and value.endswith("'"):
                value=value[1:-1].replace("''", "'")
            else:
                value=value.split(' #',1)[0].strip()
                if not value or value[0] in '!|>&*{' or value in ('null','~'): continue
            if isinstance(value,str): output[key]=value
        return output
    except (OSError,ValueError):
        return {}


def discover(project_root, *, user_home=None, processes=None, environment=None):
    root = Path(project_root).resolve()
    env = os.environ if environment is None else environment
    home = Path(user_home or Path.home())
    if processes is None:
        from desktop.window_locator import WindowLocator
        processes = WindowLocator().list_processes()
    paths = {"dsh": [], "wechatAgent": [], "plugins": []}

    def add(kind, path, source):
        try:
            path = Path(path).resolve()
            if path.exists() and not any(v["path"] == str(path) for v in paths[kind]):
                paths[kind].append({"path": str(path), "source": source, "exists": True})
        except (OSError, ValueError):
            pass

    for process in processes:
        name = str(getattr(process, "name", "")).casefold()
        exe = getattr(process, "exe_path", None)
        if exe and name in ("deepseek harness.exe", "dsh.exe"):
            add("dsh", exe, "running-process")
        if exe and name == "wechatagent.exe":
            add("wechatAgent", exe, "running-process")
    for parent in (env.get("LOCALAPPDATA"), env.get("PROGRAMFILES"), env.get("PROGRAMFILES(X86)")):
        if parent:
            for name in ("DeepSeek Harness", "dsh"):
                add("dsh", Path(parent) / name / "DeepSeek Harness.exe", "known-install-location")
            for name in ("WeChatAgent", "wechatagent"):
                add("wechatAgent", Path(parent) / name / "WeChatAgent.exe", "known-install-location")
    # Portable installs may have no registry entry and may currently be closed.
    # Check only named directories at mounted drive roots; never recursively scan a drive.
    if os.name == 'nt' and environment is None:
        try:
            drives = ctypes.windll.kernel32.GetLogicalDrives()
            for index in range(26):
                if drives & (1 << index):
                    drive = Path(f'{chr(65 + index)}:/')
                    for folder in ('dsh','DeepSeek Harness'):
                        add('dsh',drive/folder/'DeepSeek Harness.exe','portable-install-location')
                    for folder in ('wechatbot/app','WeChatAgent','WeChatAgent/app'):
                        add('wechatAgent',drive/folder/'WeChatAgent.exe','portable-install-location')
        except (AttributeError,OSError):
            pass
    profiles = []
    profile_dir = home / ".dsh" / "profiles"
    try:
        profiles = sorted(p for p in profile_dir.iterdir() if p.is_dir())[:32]
    except OSError:
        pass
    for profile in profiles:
        plugin = profile / "node_modules" / "dsh-moments-agent"
        if read_object(plugin / "package.json").get("name") == "dsh-moments-agent":
            add("plugins", plugin, "dsh-profile:" + profile.name)
    if read_object(root / "package.json").get("name") == "dsh-moments-agent":
        add("plugins", root, "current-project")
    readers = []
    for app in paths["wechatAgent"]:
        folder = Path(app["path"]).parent
        for data in (folder / "data", folder.parent / "data", folder):
            config = data / "workspace" / "state" / "wechat-io-config.json"
            if not config.is_file() or any(x["readerConfigPath"] == str(config) for x in readers):
                continue
            raw = read_object(config)
            readers.append({"dataDir": str(data), "readerConfigPath": str(config),
                "readerBaseUrl": local_url(raw.get("reader_base_url")),
                "status": "config-found-service-not-verified"})
    configured=[]
    for profile in profiles:
        values=profile_settings(profile/'cordis.patch.yml')
        if values:
            configured.append({"profile":profile.name,"readerBaseUrl":local_url(values.get('readerBaseUrl')),
                "hookBaseUrl":local_url(values.get('hookBaseUrl')), "readerConfigPath": values.get('readerConfigPath')})
    registered = [p for p in paths["plugins"] if p["source"].startswith("dsh-profile:")]
    suggested = None
    if len(registered) == 1:
        profile_name=registered[0]['source'].split(':',1)[1]
        settings=profile_settings(profile_dir/profile_name/'cordis.patch.yml')
        data = Path(registered[0]["path"]) / settings.get('dataDir','data')
        data = data.resolve()
        if (data / "admin-token.txt").is_file():
            suggested = {"baseUrl": "http://127.0.0.1:18766", "tokenFile": str(data / "admin-token.txt"),
                "dataDir": str(data), "source": "registered-plugin-defaults", "verified": False}
    for app in paths["dsh"]:
        python = Path(app["path"]).parent / "resources/runtime/primary-runtime/dependencies/python/python.exe"
        app["pythonPath"] = str(python) if python.is_file() else None
    return {**paths, "profiles": [{"name": p.name, "path": str(p), "patchPath": str(p / "cordis.patch.yml")} for p in profiles],
        "wechatConnections": readers, "configuredWechatConnections":configured, "suggestedClientConfig": suggested,
        "message": "文件存在不代表服务连通；Reader/Hook 地址取自插件明确配置，OneBot WebSocket 不作为 Hook 地址。多份安装请核对当前 profile。"}
