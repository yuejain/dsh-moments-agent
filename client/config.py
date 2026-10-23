"""客户端本地配置。

安全约束：管理令牌**永不**写入本配置。配置里只有管理 API 地址、令牌文件路径
与数据目录；令牌在每次请求时从令牌文件读取（见 api_client.py）。

配置文件默认位置：``<项目>/client/moments-client.json``。
相对路径按项目根目录解析，便于把整个项目搬到其他盘符。
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

from client.api_client import ApiError, normalize_base_url

PROJECT_ROOT = Path(__file__).resolve().parent.parent
CLIENT_DIR = PROJECT_ROOT / "client"
DEFAULT_CONFIG_PATH = CLIENT_DIR / "moments-client.json"
DEFAULT_BASE_URL = "http://127.0.0.1:18766"
DEFAULT_DATA_DIR = PROJECT_ROOT / "data"
DEFAULT_TOKEN_FILE = DEFAULT_DATA_DIR / "admin-token.txt"
CONFIG_VERSION = 1

CONFIG_COMMENT = (
    "本文件由 DSH Moments Agent 客户端保存；不包含管理令牌。"
    "令牌只从 tokenFile 指向的文件读取，绝不写入本配置、日志或截图。"
)


class ConfigError(Exception):
    """客户端配置错误（文件名、JSON 结构、路径等）。"""


@dataclass(frozen=True)
class ClientSettings:
    """客户端运行配置。"""

    base_url: str = DEFAULT_BASE_URL
    token_file: Path = DEFAULT_TOKEN_FILE
    data_dir: Path = DEFAULT_DATA_DIR
    config_path: Path = DEFAULT_CONFIG_PATH


def project_root() -> Path:
    return PROJECT_ROOT


def _resolve_local_path(value: str) -> Path:
    """把配置中的相对路径按项目根目录展开为绝对路径。"""
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = PROJECT_ROOT / path
    return path


def load_settings(config_path: Path | str | None = None) -> ClientSettings:
    """读取客户端配置；文件不存在时使用默认值（首次启动不报错）。"""
    path = Path(config_path).expanduser() if config_path is not None else DEFAULT_CONFIG_PATH

    data: dict[str, object] = {}
    if path.is_file():
        try:
            raw = path.read_text(encoding="utf-8")
        except OSError as exc:
            raise ConfigError(f"无法读取客户端配置文件：{path}（{exc}）") from exc
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ConfigError(f"客户端配置文件不是合法 JSON：{path}（{exc}）") from exc
        if not isinstance(parsed, dict):
            raise ConfigError(f"客户端配置文件顶层必须是 JSON 对象：{path}")
        data = parsed

    base_url_raw = data.get("baseUrl")
    base_url = base_url_raw.strip() if isinstance(base_url_raw, str) and base_url_raw.strip() else DEFAULT_BASE_URL
    # 地址非法时立即给出中文错误，避免把令牌发送到非回环地址。
    try:
        base_url = normalize_base_url(base_url)
    except ApiError as exc:
        raise ConfigError(exc.user_message()) from exc

    token_raw = data.get("tokenFile")
    token_file = _resolve_local_path(token_raw.strip()) if isinstance(token_raw, str) and token_raw.strip() else DEFAULT_TOKEN_FILE

    data_dir_raw = data.get("dataDir")
    data_dir = _resolve_local_path(data_dir_raw.strip()) if isinstance(data_dir_raw, str) and data_dir_raw.strip() else DEFAULT_DATA_DIR

    return ClientSettings(base_url=base_url, token_file=token_file, data_dir=data_dir, config_path=path)


def save_settings(settings: ClientSettings, config_path: Path | str | None = None) -> Path:
    """保存客户端配置（原子写入）。

    只写入 baseUrl / tokenFile / dataDir 等非敏感字段；即使旧文件里混入了
    ``token`` 之类的键，也会在重写时被丢弃。
    """
    path = Path(config_path).expanduser() if config_path is not None else settings.config_path
    try:
        base_url = normalize_base_url(settings.base_url)
    except ApiError as exc:
        raise ConfigError(exc.user_message()) from exc
    payload = {
        "version": CONFIG_VERSION,
        "baseUrl": base_url,
        "tokenFile": str(Path(settings.token_file).expanduser()),
        "dataDir": str(Path(settings.data_dir).expanduser()),
        "_comment": CONFIG_COMMENT,
    }
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = path.with_name(path.name + ".tmp")
        temp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(temp_path, path)
    except OSError as exc:
        raise ConfigError(f"无法保存客户端配置文件：{path}（{exc}）") from exc
    return path


def masked_settings(settings: ClientSettings) -> dict[str, object]:
    """给设置页展示的脱敏配置（不含令牌内容，也不含令牌任何片段）。"""
    token_path = Path(settings.token_file)
    token_exists = token_path.is_file()
    masked: dict[str, object] = {
        "baseUrl": settings.base_url,
        "tokenFile": str(token_path),
        "tokenFileExists": token_exists,
        "token": "（不显示、不保存；只在请求时从令牌文件读取）",
        "dataDir": str(settings.data_dir),
        "configPath": str(settings.config_path),
        "projectRoot": str(PROJECT_ROOT),
    }
    if token_exists:
        try:
            masked["tokenFileBytes"] = token_path.stat().st_size
        except OSError:
            masked["tokenFileBytes"] = None
    return masked


def token_file_state(settings: ClientSettings) -> tuple[bool, str]:
    """返回 (是否存在, 中文状态描述)。不读取令牌内容。"""
    token_path = Path(settings.token_file)
    if not token_path.exists():
        return False, f"令牌文件不存在：{token_path}"
    if not token_path.is_file():
        return False, f"令牌路径不是普通文件：{token_path}"
    try:
        size = token_path.stat().st_size
    except OSError as exc:
        return False, f"无法读取令牌文件信息：{exc}"
    if size <= 0:
        return False, f"令牌文件为空：{token_path}"
    return True, f"令牌文件已就绪（{size} 字节，内容不显示）"


def example_config_dict() -> dict[str, object]:
    """配置模板内容（README/示例文件使用）。"""
    return {
        "version": CONFIG_VERSION,
        "baseUrl": DEFAULT_BASE_URL,
        "tokenFile": "data/admin-token.txt",
        "dataDir": "data",
        "_comment": CONFIG_COMMENT,
    }
