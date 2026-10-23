#!/usr/bin/env python3
"""DSH Moments Agent 的 Windows 桌面管理客户端（Tkinter）。

启动：``Start-Moments-Client.cmd`` 或
``<DSH python> client/app.py [--config 客户端配置路径]``。

安全边界：
- 只调用本机管理 API（``docs/architecture/admin-api.md``），不直接读写 SQLite；
- 管理令牌在每次请求时从 ``data/admin-token.txt`` 读取，绝不写入配置文件、
  日志、异常文本或界面；
- 批准/发表/准备/取消/暂停/Kill Switch 等写操作都有二次确认；
- 发表不会静默重试，后端错误码（如 ``PUBLISH_MODE_DISABLED``）原样展示。
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import os
import queue
import sys
import threading
import traceback
import webbrowser
from datetime import datetime, timezone
from pathlib import Path

# 支持 `python client/app.py` 直接运行（此时 sys.path 只有 client/）。
if __package__ in (None, ""):
    _PROJECT_ROOT = Path(__file__).resolve().parent.parent
    if str(_PROJECT_ROOT) not in sys.path:
        sys.path.insert(0, str(_PROJECT_ROOT))

import tkinter as tk  # noqa: E402
import tkinter.font as tkfont  # noqa: E402
from tkinter import filedialog, messagebox, ttk  # noqa: E402

from client import __version__ as CLIENT_VERSION  # noqa: E402
from client.api_client import AdminApiClient, ApiError  # noqa: E402
from client.config import (  # noqa: E402
    PROJECT_ROOT,
    ClientSettings,
    ConfigError,
    load_settings,
    masked_settings,
    save_settings,
    token_file_state,
)

try:  # Pillow 仅用于图片预览，缺失时降级
    from PIL import Image, ImageTk

    PIL_AVAILABLE = True
    PIL_ERROR = ""
except Exception as _pillow_exc:  # pragma: no cover - 取决于运行环境
    Image = None  # type: ignore[assignment]
    ImageTk = None  # type: ignore[assignment]
    PIL_AVAILABLE = False
    PIL_ERROR = str(_pillow_exc)


APP_TITLE = "DSH Moments Agent 管理客户端"
JOB_POLL_MS = 90
KILL_SWITCH_WARNING = (
    "Kill Switch 会阻止所有新的创作、准备与发表操作，并持久化到数据库。\n"
    "只有确认需要停机维护时才启用。"
)

STATE_ZH = {
    "IDEA_CREATED": "已选题",
    "DRAFTING": "写稿中",
    "DRAFT_READY": "草稿就绪",
    "IMAGE_REQUIRED": "需要配图",
    "IMAGE_PENDING": "配图等待中",
    "IMAGE_READY": "配图就绪",
    "REVIEWING": "审核中",
    "READY_FOR_APPROVAL": "待审批",
    "APPROVED": "已批准",
    "QUEUED": "排队中",
    "PREPARING": "准备中",
    "PREPARED": "已准备",
    "PUBLISHING": "发表中",
    "PUBLISHED": "已发表",
    "UNCERTAIN": "结果不确定",
    "FAILED": "失败",
    "CANCELLED": "已取消",
    "EXPIRED": "已过期",
}

ATTEMPT_STATE_ZH = {
    "PLANNED": "已计划",
    "PREPARING": "准备中",
    "PREPARED": "已准备",
    "PUBLISHING": "发表中",
    "PUBLISHED": "已发表",
    "UNCERTAIN": "结果不确定",
    "VERIFIED": "已核验",
    "FAILED": "失败",
    "CANCELLED": "已取消",
}

APPROVAL_STATUS_ZH = {
    "pending": "待审批",
    "approved": "已批准",
    "rejected": "已拒绝",
    "expired": "已过期",
    "consumed": "已核销",
    "superseded": "已失效",
}

ADAPTER_STATUS_ZH = {
    "ok": "正常",
    "degraded": "降级",
    "unavailable": "不可用",
    "not_configured": "未配置",
    "not_tested": "未测试",
}

SOURCE_TYPE_OPTIONS: list[tuple[str, str]] = [
    ("自动判断（推荐）", ""),
    ("所有者主题 owner_topic", "owner_topic"),
    ("收藏观点 saved_opinion", "saved_opinion"),
    ("公开新闻 public_news", "public_news"),
    ("所有者文章 owner_article", "owner_article"),
    ("所有者图片 owner_image", "owner_image"),
    ("书评 book_review", "book_review"),
    ("影评 film_review", "film_review"),
    ("科学思考 science_reflection", "science_reflection"),
    ("历史延伸 history_extension", "history_extension"),
    ("创作表达 creative_expression", "creative_expression"),
    ("聊天信号 chat_signal", "chat_signal"),
    ("手动 manual", "manual"),
]

TERMINAL_STATES = {"PUBLISHED", "FAILED", "CANCELLED", "EXPIRED"}


# ----------------------------------------------------------------------
# 格式化与通用小工具
# ----------------------------------------------------------------------
def state_text(state: object) -> str:
    value = "" if state is None else str(state)
    if value == "":
        return "—"
    zh = STATE_ZH.get(value)
    return f"{value}（{zh}）" if zh else value


def state_short(state: object) -> str:
    """列表里用中文状态名，详情里用 state_text（含英文状态码）。"""
    value = "" if state is None else str(state)
    if value == "":
        return "—"
    return STATE_ZH.get(value, value)


def attempt_state_text(state: object) -> str:
    value = "" if state is None else str(state)
    if value == "":
        return "—"
    zh = ATTEMPT_STATE_ZH.get(value)
    return f"{value}（{zh}）" if zh else value


def approval_status_text(status: object) -> str:
    value = "" if status is None else str(status)
    zh = APPROVAL_STATUS_ZH.get(value)
    return f"{value}（{zh}）" if zh else value


def adapter_status_text(status: object) -> str:
    value = "" if status is None else str(status)
    zh = ADAPTER_STATUS_ZH.get(value)
    return f"{value}（{zh}）" if zh else value


def local_time(value: object) -> str:
    if value is None or value == "":
        return "—"
    text = str(value)
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return text
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    try:
        return parsed.astimezone().strftime("%Y-%m-%d %H:%M:%S")
    except (OverflowError, OSError):
        return text


def shorten(value: object, length: int = 40) -> str:
    text = "" if value is None else str(value).replace("\r", " ").replace("\n", " ").strip()
    return text if len(text) <= length else text[:length] + "…"


def short_time(value: object) -> str:
    """列表里用紧凑时间（月-日 时:分），详情里仍用完整本地时间。"""
    parsed = local_time(value)
    if parsed == "—":
        return parsed
    try:
        return datetime.strptime(parsed, "%Y-%m-%d %H:%M:%S").strftime("%m-%d %H:%M")
    except (ValueError, TypeError):
        return parsed


def short_hash(value: object, length: int = 12) -> str:
    text = "" if value is None else str(value)
    return text[:length] if text else "—"


def pretty_json(value: object) -> str:
    try:
        return json.dumps(value, ensure_ascii=False, indent=2)
    except (TypeError, ValueError):
        return str(value)


def make_text_area(parent: tk.Misc, *, height: int = 8, width: int = 20) -> tuple[ttk.Frame, tk.Text]:
    frame = ttk.Frame(parent)
    text = tk.Text(
        frame,
        height=height,
        width=width,
        wrap="word",
        borderwidth=1,
        relief="solid",
        font=("Microsoft YaHei UI", 9),
        padx=6,
        pady=4,
    )
    scroll = ttk.Scrollbar(frame, orient="vertical", command=text.yview)
    text.configure(yscrollcommand=scroll.set)
    text.grid(row=0, column=0, sticky="nsew")
    scroll.grid(row=0, column=1, sticky="ns")
    frame.rowconfigure(0, weight=1)
    frame.columnconfigure(0, weight=1)
    text.configure(state="disabled")
    return frame, text


def set_text(widget: tk.Text, content: object) -> None:
    widget.configure(state="normal")
    widget.delete("1.0", "end")
    widget.insert("1.0", "" if content is None else str(content))
    widget.see("1.0")
    widget.yview_moveto(0.0)
    widget.configure(state="disabled")


def make_tree(
    parent: tk.Misc,
    columns: list[tuple[str, str, int, str]],
    *,
    height: int = 12,
) -> tuple[ttk.Frame, ttk.Treeview]:
    frame = ttk.Frame(parent)
    keys = [item[0] for item in columns]
    tree = ttk.Treeview(frame, columns=keys, show="headings", height=height, selectmode="browse")
    for key, title, width, anchor in columns:
        tree.heading(key, text=title)
        tree.column(key, width=width, anchor=anchor, stretch=False)
    vertical = ttk.Scrollbar(frame, orient="vertical", command=tree.yview)
    horizontal = ttk.Scrollbar(frame, orient="horizontal", command=tree.xview)
    tree.configure(yscrollcommand=vertical.set, xscrollcommand=horizontal.set)
    tree.grid(row=0, column=0, sticky="nsew")
    vertical.grid(row=0, column=1, sticky="ns")
    horizontal.grid(row=1, column=0, sticky="ew")
    frame.rowconfigure(0, weight=1)
    frame.columnconfigure(0, weight=1)
    return frame, tree


def clear_tree(tree: ttk.Treeview) -> None:
    for item in tree.get_children():
        tree.delete(item)


def set_widgets_enabled(widgets: list[tk.Misc], enabled: bool) -> None:
    for widget in widgets:
        try:
            if widget.winfo_class().startswith("T"):
                widget.state(["!disabled"] if enabled else ["disabled"])
            else:
                widget.configure(state="normal" if enabled else "disabled")
        except tk.TclError:
            pass


# ----------------------------------------------------------------------
# 后台任务：工作线程只做网络/IO，结果通过 queue 回到主线程
# ----------------------------------------------------------------------
class AsyncJobs:
    """把耗时 API 调用放到后台线程，结果用 ``after`` 轮询回主线程。"""

    def __init__(self, root: tk.Misc, error_handler) -> None:
        self.root = root
        self.error_handler = error_handler
        self._queue: queue.Queue[tuple[str, bool, object]] = queue.Queue()
        self._callbacks: dict[str, tuple[object, object, object]] = {}
        self._running: set[str] = set()
        self.root.after(JOB_POLL_MS, self._poll)

    @property
    def running(self) -> set[str]:
        return set(self._running)

    def submit(self, job_id: str, work, on_success, on_error=None, on_finish=None) -> bool:
        if job_id in self._running:
            return False
        self._running.add(job_id)
        self._callbacks[job_id] = (on_success, on_error, on_finish)

        def runner() -> None:
            try:
                result = work()
            except BaseException as exc:  # noqa: BLE001 - 统一交给 UI 处理
                self._queue.put((job_id, False, exc))
            else:
                self._queue.put((job_id, True, result))

        threading.Thread(target=runner, name=f"moments-client-{job_id}", daemon=True).start()
        return True

    def _poll(self) -> None:
        try:
            while True:
                job_id, ok, payload = self._queue.get_nowait()
                self._running.discard(job_id)
                on_success, on_error, on_finish = self._callbacks.pop(job_id, (None, None, None))
                try:
                    if ok:
                        if on_success is not None:
                            on_success(payload)  # type: ignore[operator]
                    else:
                        if on_error is not None:
                            on_error(payload)  # type: ignore[operator]
                        else:
                            self.error_handler(job_id, payload)
                except Exception:  # noqa: BLE001
                    traceback.print_exc()
                    self.error_handler(job_id, RuntimeError("界面回调异常（详情见控制台）"))
                finally:
                    if on_finish is not None:
                        try:
                            on_finish()  # type: ignore[operator]
                        except Exception:  # noqa: BLE001
                            traceback.print_exc()
        except queue.Empty:
            pass
        try:
            self.root.after(JOB_POLL_MS, self._poll)
        except tk.TclError:
            # 窗口已关闭
            pass


# ----------------------------------------------------------------------
# 主窗口
# ----------------------------------------------------------------------
class MomentsClientApp(tk.Tk):
    def __init__(self, settings: ClientSettings, config_path: Path | None = None, initial_tab: int = 0) -> None:
        super().__init__()
        self.settings = settings
        self.config_path = Path(config_path) if config_path is not None else settings.config_path
        self.api: AdminApiClient | None = None

        self.health: dict[str, object] | None = None
        self.status: dict[str, object] | None = None
        self.task_summaries: list[dict[str, object]] = []
        self.task_detail: dict[str, object] | None = None
        self.selected_task_id: str | None = None
        self.approval_rows: list[dict[str, object]] = []
        self.selected_approval_id: str | None = None
        self.history_data: dict[str, object] | None = None
        self.persona_data: dict[str, object] | None = None
        self.config_data: dict[str, object] | None = None

        self._suppress_selection = False
        self._settings_loaded = False
        self._thumb_refs: list[object] = []
        self._busy_widgets: dict[str, list[tk.Misc]] = {}
        self._closing = False

        self.title(APP_TITLE)
        self.geometry("1180x760")
        self.minsize(1000, 640)

        self._init_style()
        self._build_topbar()
        self._build_statusbar()
        self._build_tabs()
        self.jobs = AsyncJobs(self, self._handle_async_error)
        self.protocol("WM_DELETE_WINDOW", self._on_close)
        if 0 <= initial_tab < len(self.notebook.tabs()):
            self.notebook.select(initial_tab)
        self.after(250, self.refresh_all)

    # ------------------------------------------------------------------
    # 基础构建
    # ------------------------------------------------------------------
    def _init_style(self) -> None:
        style = ttk.Style(self)
        try:
            style.configure("TNotebook.Tab", padding=(12, 6))
        except tk.TclError:
            pass
        for name in ("TkDefaultFont", "TkTextFont", "TkMenuFont", "TkHeadingFont"):
            try:
                tkfont.nametofont(name).configure(family="Microsoft YaHei UI", size=10)
            except (tk.TclError, ValueError):
                pass

    def _build_topbar(self) -> None:
        bar = ttk.Frame(self, padding=(10, 8, 10, 4))
        bar.pack(fill="x")

        right = ttk.Frame(bar)
        right.pack(side="right")
        ttk.Button(right, text="刷新", command=self.refresh_all).pack(side="left", padx=(0, 4))
        ttk.Button(right, text="管理页", command=self._open_admin_page).pack(side="left", padx=(0, 4))
        ttk.Button(right, text="数据目录", command=self._open_data_dir).pack(side="left")

        left = ttk.Frame(bar)
        left.pack(side="left", fill="x", expand=True)

        self.conn_dot = tk.Label(left, text="●", fg="#8a8a8a", font=("Segoe UI", 13))
        self.conn_dot.pack(side="left")
        self.conn_text = ttk.Label(left, text="未连接")
        self.conn_text.pack(side="left", padx=(2, 8))
        ttk.Separator(left, orient="vertical").pack(side="left", fill="y", padx=6)

        self.account_label = ttk.Label(left, text="账号：—")
        self.account_label.pack(side="left", padx=(0, 12))
        self.mode_label = ttk.Label(left, text="发布模式：—")
        self.mode_label.pack(side="left", padx=(0, 12))
        self.control_label = ttk.Label(left, text="控制：—")
        self.control_label.pack(side="left")

    def _build_statusbar(self) -> None:
        bar = ttk.Frame(self, padding=(10, 3, 10, 5))
        bar.pack(fill="x", side="bottom")
        self.status_var = tk.StringVar(value="就绪")
        ttk.Label(bar, textvariable=self.status_var, anchor="w").pack(side="left", fill="x", expand=True)
        pillow_text = "Pillow 可用" if PIL_AVAILABLE else "Pillow 不可用（图片预览降级）"
        ttk.Label(bar, text=f"客户端 v{CLIENT_VERSION} · {pillow_text}").pack(side="right")

    def _build_tabs(self) -> None:
        self.notebook = ttk.Notebook(self)
        self.notebook.pack(fill="both", expand=True, padx=10, pady=(0, 4))
        self._build_overview_tab()
        self._build_create_tab()
        self._build_approvals_tab()
        self._build_tasks_tab()
        self._build_history_tab()
        self._build_settings_tab()
        self.notebook.bind("<<NotebookTabChanged>>", self._on_tab_changed)

    # ------------------------------------------------------------------
    # 顶栏/状态栏
    # ------------------------------------------------------------------
    def _set_connection(self, state: str, text: str) -> None:
        colors = {"ok": "#2e9e5b", "warn": "#c98512", "error": "#c0392b", "loading": "#8a8a8a", "idle": "#8a8a8a"}
        self.conn_dot.configure(fg=colors.get(state, "#8a8a8a"))
        self.conn_text.configure(text=text)

    def _render_topbar(self) -> None:
        health = self.health or {}
        status = self.status or {}
        control = status.get("control") or {}
        health_control = {
            "paused": health.get("paused"),
            "killSwitch": health.get("killSwitch"),
        }
        paused = control.get("paused", health_control["paused"])
        kill = control.get("killSwitch", health_control["killSwitch"])
        mode = control.get("publishMode") or health.get("publishMode") or "—"
        effective = control.get("effectivePublishMode") or mode
        account = status.get("accountId") or "—"

        self.account_label.configure(text=f"账号：{account}")
        if effective and effective != mode:
            self.mode_label.configure(text=f"发布模式：{mode}（生效：{effective}）")
        else:
            self.mode_label.configure(text=f"发布模式：{mode}")
        state_parts = []
        state_parts.append("已暂停" if paused else "运行中")
        state_parts.append("Kill Switch 开启" if kill else "Kill Switch 关闭")
        self.control_label.configure(text="控制：" + " · ".join(state_parts))

        if kill:
            self._set_connection("error", "已连接（Kill Switch 开启）")
        elif paused:
            self._set_connection("warn", "已连接（系统已暂停）")
        elif health.get("ok"):
            self._set_connection("ok", "已连接")
        else:
            self._set_connection("warn", "已连接（降级）")

    # ------------------------------------------------------------------
    # 概览页
    # ------------------------------------------------------------------
    def _build_overview_tab(self) -> None:
        tab = ttk.Frame(self.notebook, padding=8)
        self.notebook.add(tab, text="概览")
        self.overview_tab = tab

        top = ttk.Frame(tab)
        top.pack(fill="x")
        ttk.Button(top, text="刷新概览", command=self.refresh_overview).pack(side="left")
        ttk.Button(top, text="刷新全部", command=self.refresh_all).pack(side="left", padx=(6, 0))
        self.overview_hint = ttk.Label(top, text="连接状态：—")
        self.overview_hint.pack(side="right")

        body = ttk.Frame(tab)
        body.pack(fill="both", expand=True, pady=(6, 0))
        body.columnconfigure(0, weight=3)
        body.columnconfigure(1, weight=2)
        body.rowconfigure(0, weight=1)

        health_frame = ttk.LabelFrame(body, text="系统健康（/api/health）", padding=6)
        health_frame.grid(row=0, column=0, sticky="nsew", padx=(0, 6))
        health_frame.rowconfigure(0, weight=1)
        health_frame.columnconfigure(0, weight=1)
        health_body, self.overview_health_text = make_text_area(health_frame, height=18)
        health_body.grid(row=0, column=0, sticky="nsew")

        right = ttk.Frame(body)
        right.grid(row=0, column=1, sticky="nsew")
        right.columnconfigure(0, weight=1)
        right.rowconfigure(0, weight=1)
        right.rowconfigure(1, weight=1)

        control_frame = ttk.LabelFrame(right, text="控制、账号与调度（/api/status）", padding=6)
        control_frame.grid(row=0, column=0, sticky="nsew", pady=(0, 6))
        control_frame.rowconfigure(0, weight=1)
        control_frame.columnconfigure(0, weight=1)
        control_body, self.overview_control_text = make_text_area(control_frame, height=9)
        control_body.grid(row=0, column=0, sticky="nsew")

        counts_frame = ttk.LabelFrame(right, text="任务计数与待审批", padding=6)
        counts_frame.grid(row=1, column=0, sticky="nsew")
        counts_frame.rowconfigure(0, weight=1)
        counts_frame.columnconfigure(0, weight=1)
        counts_body, self.overview_counts_text = make_text_area(counts_frame, height=9)
        counts_body.grid(row=0, column=0, sticky="nsew")

        set_text(self.overview_health_text, "尚未加载：点击“刷新概览”。")
        set_text(self.overview_control_text, "尚未加载。")
        set_text(self.overview_counts_text, "尚未加载。")

    def refresh_overview(self) -> None:
        def work() -> dict[str, object]:
            api = self._client()
            return {"health": api.health(), "status": api.status()}

        submitted = self._submit(
            "overview",
            work,
            self._on_overview_success,
            self._on_overview_error,
            busy_message="正在读取 health / status…",
        )
        if submitted and self.health is None:
            self._set_connection("loading", "连接中…")

    def _on_overview_success(self, data: object) -> None:
        payload = data if isinstance(data, dict) else {}
        self.health = payload.get("health") if isinstance(payload.get("health"), dict) else {}
        self.status = payload.get("status") if isinstance(payload.get("status"), dict) else {}
        self._render_topbar()
        self._render_overview()
        checked = (self.health or {}).get("checkedAt")
        self.set_status(f"已刷新（{local_time(checked)}）：连接正常")

    def _on_overview_error(self, exc: object) -> None:
        health = self.health or {}
        self._set_connection("error", "连接失败")
        self.overview_hint.configure(text="连接失败")
        message = self._user_error(exc)
        set_text(self.overview_health_text, f"无法读取系统健康信息。\n\n{message}")
        set_text(self.overview_control_text, "无法读取控制状态。")
        set_text(self.overview_counts_text, "无法读取任务计数。")
        self.set_status(f"连接失败：{shorten(message, 160)}")

    def _render_overview(self) -> None:
        health = self.health or {}
        status = self.status or {}
        control = status.get("control") or {}

        lines = [
            f"插件：{health.get('plugin', '—')}  v{health.get('version', '—')}",
            f"DSH：{health.get('dshVersion') or '—'}",
            f"数据库：{health.get('database', '—')}",
            f"检查时间：{local_time(health.get('checkedAt'))}",
            "",
        ]
        for key, label in (
            ("llm", "LLM"),
            ("wechatAgent", "WeChatAgent"),
            ("desktopExecutor", "桌面执行器"),
            ("images", "图像 Provider"),
        ):
            adapter = health.get(key)
            if isinstance(adapter, dict):
                lines.append(f"{label}：{adapter_status_text(adapter.get('status'))}")
                detail = adapter.get("message")
                if detail:
                    lines.append(f"    {detail}")
                details = adapter.get("details")
                if isinstance(details, dict):
                    notable = []
                    for field in ("version", "wechatVersion", "uiaAvailable", "allowPublish", "mode"):
                        if field in details and details[field] not in (None, ""):
                            notable.append(f"{field}={details[field]}")
                    if notable:
                        lines.append("    " + "，".join(notable))
            else:
                lines.append(f"{label}：—")
        lines.append("")
        lines.append(f"整体状态：{'正常' if health.get('ok') else '降级/不可用'}")
        set_text(self.overview_health_text, "\n".join(lines))

        control_lines = [
            f"连接：{'已连接' if health else '—'}",
            f"当前账号：{status.get('accountId') or '—'}",
            f"暂停：{'是' if control.get('paused', health.get('paused')) else '否'}"
            + (f"（原因：{control.get('pauseReason')}）" if control.get("pauseReason") else ""),
            f"Kill Switch：{'开启' if control.get('killSwitch', health.get('killSwitch')) else '关闭'}",
            f"发布模式：{control.get('publishMode') or health.get('publishMode') or '—'}",
            f"生效发布模式：{control.get('effectivePublishMode') or '—'}",
            f"调度：{'启用' if control.get('scheduleEnabled', health.get('scheduleEnabled')) else '关闭'}",
            f"所有者通道：{control.get('ownerChannel') or '—'}",
        ]
        set_text(self.overview_control_text, "\n".join(control_lines))

        counts = health.get("counts")
        count_lines = []
        if isinstance(counts, dict) and counts:
            for key in sorted(counts.keys()):
                count_lines.append(f"{key}：{counts[key]}")
        else:
            count_lines.append("（无任务计数）")
        pending = status.get("pendingApprovals")
        open_tasks = status.get("openTasks")
        count_lines.append("")
        count_lines.append(f"待审批：{len(pending) if isinstance(pending, list) else 0} 条")
        count_lines.append(f"未结束任务：{len(open_tasks) if isinstance(open_tasks, list) else 0} 个")
        set_text(self.overview_counts_text, "\n".join(count_lines))
        self.overview_hint.configure(
            text=f"发布模式：{control.get('effectivePublishMode') or health.get('publishMode') or '—'}"
        )

    # ------------------------------------------------------------------
    # 创作页
    # ------------------------------------------------------------------
    def _build_create_tab(self) -> None:
        tab = ttk.Frame(self.notebook, padding=8)
        self.notebook.add(tab, text="创作")
        self.create_tab = tab

        form = ttk.LabelFrame(tab, text="创作参数（全部可选，留空由 Agent 自主决策）", padding=8)
        form.pack(fill="x")
        form.columnconfigure(1, weight=3)
        form.columnconfigure(3, weight=2)

        ttk.Label(form, text="主题：").grid(row=0, column=0, sticky="e", padx=(0, 4), pady=3)
        self.create_topic_var = tk.StringVar()
        ttk.Entry(form, textvariable=self.create_topic_var).grid(row=0, column=1, sticky="ew", pady=3)
        ttk.Label(form, text="来源类型：").grid(row=0, column=2, sticky="e", padx=(12, 4), pady=3)
        self.create_source_var = tk.StringVar(value=SOURCE_TYPE_OPTIONS[0][0])
        ttk.Combobox(
            form,
            textvariable=self.create_source_var,
            values=[label for label, _value in SOURCE_TYPE_OPTIONS],
            state="readonly",
            width=28,
        ).grid(row=0, column=3, sticky="w", pady=3)

        ttk.Label(form, text="来源依据：").grid(row=1, column=0, sticky="ne", padx=(0, 4), pady=3)
        evidence_frame = ttk.Frame(form)
        evidence_frame.grid(row=1, column=1, columnspan=3, sticky="ew", pady=3)
        evidence_frame.columnconfigure(0, weight=1)
        self.create_evidence_text = tk.Text(
            evidence_frame, height=3, wrap="word", font=("Microsoft YaHei UI", 9), padx=4, pady=3
        )
        evidence_scroll = ttk.Scrollbar(evidence_frame, orient="vertical", command=self.create_evidence_text.yview)
        self.create_evidence_text.configure(yscrollcommand=evidence_scroll.set)
        self.create_evidence_text.grid(row=0, column=0, sticky="ew")
        evidence_scroll.grid(row=0, column=1, sticky="ns")

        ttk.Label(form, text="创作动机：").grid(row=2, column=0, sticky="e", padx=(0, 4), pady=3)
        self.create_motivation_var = tk.StringVar()
        ttk.Entry(form, textvariable=self.create_motivation_var).grid(
            row=2, column=1, columnspan=3, sticky="ew", pady=3
        )

        actions = ttk.Frame(tab)
        actions.pack(fill="x", pady=(8, 4))
        self.create_generate_btn = ttk.Button(
            actions, text="生成草稿并提交审批", command=self._generate_draft
        )
        self.create_generate_btn.pack(side="left")
        self.create_clear_btn = ttk.Button(actions, text="清空", command=self._clear_create_form)
        self.create_clear_btn.pack(side="left", padx=(6, 0))
        self.create_progress = ttk.Progressbar(actions, mode="indeterminate", length=160)
        self.create_progress.pack(side="left", padx=(12, 0))
        self.create_status_var = tk.StringVar(value="")
        ttk.Label(actions, textvariable=self.create_status_var).pack(side="left", padx=(12, 0))

        result_frame = ttk.LabelFrame(tab, text="结果（silent 原因 / 草稿正文 / 审核 / 审批 ID）", padding=6)
        result_frame.pack(fill="both", expand=True, pady=(4, 0))
        result_frame.rowconfigure(0, weight=1)
        result_frame.columnconfigure(0, weight=1)
        result_body, self.create_result_text = make_text_area(result_frame, height=18)
        result_body.grid(row=0, column=0, sticky="nsew")
        set_text(
            self.create_result_text,
            "点击“生成草稿并提交审批”后，客户端会调用 POST /api/workflow/draft：\n"
            "选题 → 文案 → 审核 → 申请审批（不会准备或发表）。\n\n"
            "长任务在后台线程执行，窗口不会冻结；模型调用通常需要 30~120 秒。",
        )

    def _clear_create_form(self) -> None:
        self.create_topic_var.set("")
        self.create_motivation_var.set("")
        self.create_source_var.set(SOURCE_TYPE_OPTIONS[0][0])
        self.create_evidence_text.delete("1.0", "end")
        set_text(self.create_result_text, "已清空输入。")

    def _selected_source_type(self) -> str:
        label = self.create_source_var.get()
        for option_label, value in SOURCE_TYPE_OPTIONS:
            if option_label == label:
                return value
        return ""

    def _generate_draft(self) -> None:
        if not messagebox.askyesno(
            "确认生成",
            "将调用模型生成一条朋友圈草稿并自动提交审批（只生成候选内容，不会准备或发表）。\n\n"
            "这可能会产生一次真实模型调用，通常需要 30~120 秒。继续？",
            icon="question",
        ):
            return
        topic = self.create_topic_var.get().strip()
        motivation = self.create_motivation_var.get().strip()
        evidence = self.create_evidence_text.get("1.0", "end").strip()
        source_type = self._selected_source_type()

        def work() -> dict[str, object]:
            return self._client().workflow_draft(
                topic=topic or None,
                source_type=source_type or None,
                source_evidence=evidence or None,
                motivation=motivation or None,
            )

        self.create_progress.start(12)
        self.create_status_var.set("生成中…（模型调用 30~120 秒，请勿关闭窗口）")
        self.set_status("正在生成草稿并提交审批…")
        submitted = self._submit(
            "create",
            work,
            self._on_create_success,
            self._on_create_error,
            busy_widgets=[self.create_generate_btn, self.create_clear_btn],
            on_finish=self._finish_create,
        )
        if not submitted:
            self.create_progress.stop()
            self.create_status_var.set("已有生成任务在进行，请稍候…")

    def _finish_create(self) -> None:
        self.create_progress.stop()
        self.create_status_var.set("")

    def _on_create_success(self, data: object) -> None:
        payload = data if isinstance(data, dict) else {}
        if payload.get("silent"):
            reason = payload.get("reason") or "模型判断没有值得表达的内容"
            text = f"模型选择沉默（未创建任务）：\n\n{reason}"
            set_text(self.create_result_text, text)
            self.set_status("模型选择沉默，未创建任务")
            messagebox.showinfo("本次没有创作任务", f"模型选择沉默：\n\n{reason}")
            return

        task_id = payload.get("taskId") or "—"
        review = payload.get("review") or {}
        approval = payload.get("approval") or {}
        detail = payload.get("detail") or {}
        draft = (detail.get("draft") if isinstance(detail, dict) else None) or {}
        idea = (detail.get("idea") if isinstance(detail, dict) else None) or {}

        lines = [
            f"任务：{task_id}",
            f"状态：{state_text((detail.get('task') or {}).get('state') if isinstance(detail, dict) else None)}",
            f"审核：{'通过' if review.get('passed') else '未通过'}",
        ]
        notes = review.get("notes")
        if isinstance(notes, list) and notes:
            lines.append("审核备注：")
            for note in notes:
                lines.append(f"  · {note}")
        flags = review.get("flags")
        if isinstance(flags, list) and flags:
            lines.append(f"风险标记：{', '.join(str(item) for item in flags)}")
        if isinstance(approval, dict) and approval:
            approval_record = approval.get("approval") or {}
            lines.append(f"审批 ID：{approval_record.get('approvalId', '—')}")
            lines.append(f"审批过期：{local_time(approval_record.get('expiresAt'))}")
            lines.append(f"审批通知已发送：{'是' if approval.get('delivered') else '否'}")
        else:
            lines.append("审批：未创建（审核未通过，或后端要求先人工处理）")
        topic = idea.get("topic") if isinstance(idea, dict) else None
        if topic:
            lines.append(f"主题：{topic}")
        lines.append("")
        lines.append("草稿正文：")
        lines.append(str(draft.get("text") or "（暂无草稿）"))
        set_text(self.create_result_text, "\n".join(lines))

        self.set_status(f"草稿已生成并提交审批：{task_id}")
        self.refresh_tasks()
        self.refresh_approvals()
        self.refresh_overview()
        messagebox.showinfo(
            "创作完成",
            f"任务 {task_id}\n"
            f"审核：{'通过' if review.get('passed') else '未通过'}\n"
            + (
                f"审批 ID：{(approval.get('approval') or {}).get('approvalId')}\n"
                if isinstance(approval, dict) and approval
                else "审批：未创建\n"
            )
            + "\n请在“待审批”或“任务”页确认内容。",
        )

    def _on_create_error(self, exc: object) -> None:
        self.create_progress.stop()
        self.create_status_var.set("生成失败")
        message = self._user_error(exc)
        set_text(self.create_result_text, f"生成失败：\n\n{message}")
        self._action_failed("生成草稿", exc)

    # ------------------------------------------------------------------
    # 待审批页
    # ------------------------------------------------------------------
    def _build_approvals_tab(self) -> None:
        tab = ttk.Frame(self.notebook, padding=8)
        self.notebook.add(tab, text="待审批")
        self.approvals_tab = tab

        pane = ttk.Panedwindow(tab, orient="horizontal")
        pane.pack(fill="both", expand=True)
        left = ttk.Frame(pane, padding=(0, 0, 6, 0))
        right = ttk.Frame(pane, padding=(6, 0, 0, 0))
        pane.add(left, weight=2)
        pane.add(right, weight=3)

        left_top = ttk.Frame(left)
        left_top.pack(fill="x")
        self.approvals_refresh_btn = ttk.Button(left_top, text="刷新待审批", command=self.refresh_approvals)
        self.approvals_refresh_btn.pack(side="left")
        ttk.Label(left_top, text="（批准前请核对正文、哈希与过期时间）").pack(side="left", padx=(8, 0))

        tree_frame, self.approval_tree = make_tree(
            left,
            [
                ("task", "任务", 115, "w"),
                ("summary", "正文摘要", 130, "w"),
                ("hash", "哈希前缀", 85, "w"),
                ("expires", "过期时间", 125, "w"),
            ],
            height=16,
        )
        tree_frame.pack(fill="both", expand=True, pady=(6, 0))
        self.approval_tree.bind("<<TreeviewSelect>>", self._on_approval_select)

        detail_frame = ttk.LabelFrame(right, text="批准的完整内容", padding=6)
        detail_frame.pack(fill="both", expand=True)
        detail_frame.rowconfigure(0, weight=3)
        detail_frame.rowconfigure(1, weight=2)
        detail_frame.columnconfigure(0, weight=1)
        body, self.approval_detail_text = make_text_area(detail_frame, height=10)
        body.grid(row=0, column=0, sticky="nsew")

        thumbs_frame = ttk.LabelFrame(detail_frame, text="图片预览（GET /api/assets/{id}/raw）", padding=6)
        thumbs_frame.grid(row=1, column=0, sticky="nsew", pady=(6, 0))
        self.approval_thumbs = ttk.Frame(thumbs_frame)
        self.approval_thumbs.pack(fill="both", expand=True)
        ttk.Label(
            self.approval_thumbs,
            text="选中一条待审批后加载图片；Pillow 不可用时降级为文字占位。",
        ).pack(anchor="w")

        actions = ttk.Frame(right)
        actions.pack(fill="x", pady=(6, 0))
        self.approve_btn = ttk.Button(actions, text="批准（需二次确认）", command=lambda: self._decide_approval("approve"))
        self.approve_btn.pack(side="left")
        self.reject_btn = ttk.Button(actions, text="拒绝（需二次确认）", command=lambda: self._decide_approval("reject"))
        self.reject_btn.pack(side="left", padx=(6, 0))
        self.approval_hint_var = tk.StringVar(value="未选择审批")
        ttk.Label(actions, textvariable=self.approval_hint_var).pack(side="left", padx=(12, 0))

        set_text(self.approval_detail_text, "尚未加载待审批列表。")

    def refresh_approvals(self) -> None:
        def work() -> list[dict[str, object]]:
            api = self._client()
            approvals = api.approvals()
            rows: list[dict[str, object]] = []
            for approval in approvals[:20]:
                task_id = approval.get("taskId")
                detail: dict[str, object] | None = None
                row_error = ""
                if isinstance(task_id, str) and task_id:
                    try:
                        detail = api.task_detail(task_id)
                    except ApiError as exc:
                        row_error = exc.user_message()
                rows.append({"approval": approval, "detail": detail, "error": row_error})
            return rows

        self._submit(
            "approvals",
            work,
            self._on_approvals_success,
            self._on_approvals_error,
            busy_widgets=[self.approvals_refresh_btn],
            busy_message="正在读取待审批列表…",
        )

    def _on_approvals_success(self, rows: object) -> None:
        self.approval_rows = rows if isinstance(rows, list) else []
        clear_tree(self.approval_tree)
        for row in self.approval_rows:
            approval = row.get("approval") or {}
            detail = row.get("detail") or {}
            draft = (detail.get("draft") if isinstance(detail, dict) else None) or {}
            approval_id = str(approval.get("approvalId") or "")
            if approval_id == "":
                continue
            self.approval_tree.insert(
                "",
                "end",
                iid=approval_id,
                values=(
                    approval.get("taskId") or "—",
                    shorten(draft.get("text"), 36) if isinstance(draft, dict) else "（未加载正文）",
                    short_hash(approval.get("contentHash"), 12),
                    short_time(approval.get("expiresAt")),
                ),
            )
        if not self.approval_rows:
            self.selected_approval_id = None
            set_text(self.approval_detail_text, "当前没有待审批内容。")
            self._clear_thumbnails("当前没有待审批内容。")
            self.approval_hint_var.set("没有待审批")
            self.set_status("待审批列表为空")
            return
        self._suppress_selection = True
        try:
            self.approval_tree.selection_set(str(self.approval_rows[0]["approval"].get("approvalId")))
        except (tk.TclError, KeyError):
            pass
        self._suppress_selection = False
        first = self.approval_rows[0]
        approval_id = str((first.get("approval") or {}).get("approvalId") or "")
        if approval_id:
            self.selected_approval_id = approval_id
            self._render_approval_selection(approval_id)
            self._load_approval_thumbnails(approval_id)
        self.set_status(f"待审批 {len(self.approval_rows)} 条")

    def _on_approvals_error(self, exc: object) -> None:
        self.approval_rows = []
        self.selected_approval_id = None
        clear_tree(self.approval_tree)
        message = self._user_error(exc)
        set_text(self.approval_detail_text, f"待审批列表加载失败：\n\n{message}")
        self._clear_thumbnails("列表加载失败")
        self.approval_hint_var.set("加载失败")
        self.set_status(f"待审批加载失败：{shorten(message, 120)}")

    def _on_approval_select(self, _event: object = None) -> None:
        if self._suppress_selection:
            return
        selection = self.approval_tree.selection()
        if not selection:
            return
        approval_id = str(selection[0])
        if approval_id == self.selected_approval_id:
            return
        self.selected_approval_id = approval_id
        self._render_approval_selection(approval_id)
        self._load_approval_thumbnails(approval_id)

    def _find_approval_row(self, approval_id: str | None) -> dict[str, object] | None:
        if approval_id is None:
            return None
        for row in self.approval_rows:
            approval = row.get("approval")
            if isinstance(approval, dict) and str(approval.get("approvalId")) == approval_id:
                return row
        return None

    def _render_approval_selection(self, approval_id: str) -> None:
        row = self._find_approval_row(approval_id)
        if row is None:
            set_text(self.approval_detail_text, "未找到该审批。请点击“刷新待审批”。")
            return
        approval = row.get("approval") or {}
        detail = row.get("detail") or {}
        draft = (detail.get("draft") if isinstance(detail, dict) else None) or {}
        preview = (detail.get("preview") if isinstance(detail, dict) else None) or {}
        task = (detail.get("task") if isinstance(detail, dict) else None) or {}
        assets = (detail.get("assets") if isinstance(detail, dict) else None) or []

        task_hash = preview.get("contentHash") or task.get("contentHash")
        consistency = "一致"
        if task_hash and approval.get("contentHash") and task_hash != approval.get("contentHash"):
            consistency = "不一致（批准可能失败：CONTENT_CHANGED）"

        lines = [
            f"审批 ID：{approval.get('approvalId', '—')}",
            f"任务：{approval.get('taskId', '—')}",
            f"审批状态：{approval_status_text(approval.get('status'))}",
            f"渠道：{approval.get('channel', '—')}",
            f"可见范围：{approval.get('visibility', '—')}    目标账号：{approval.get('accountId', '—')}",
            f"创建：{local_time(approval.get('createdAt'))}",
            f"过期：{local_time(approval.get('expiresAt'))}",
            "",
            f"内容哈希（完整）：{approval.get('contentHash', '—')}",
            f"素材清单哈希：{approval.get('assetManifestHash', '—')}",
            f"与当前任务内容哈希：{consistency}",
            "",
            "正文：",
            str(draft.get("text") or "（未加载正文）"),
            "",
            f"图片素材：{len(assets)} 个",
        ]
        for asset in assets:
            if isinstance(asset, dict):
                lines.append(
                    f"  · {asset.get('assetId')}  {asset.get('mime')}  "
                    f"{asset.get('width')}x{asset.get('height')}  sha256={short_hash(asset.get('sha256'), 16)}"
                )
        if row.get("error"):
            lines.append("")
            lines.append(f"任务详情加载错误：{row.get('error')}")
        set_text(self.approval_detail_text, "\n".join(lines))
        self.approval_hint_var.set(f"哈希 {short_hash(approval.get('contentHash'))}")

    def _load_approval_thumbnails(self, approval_id: str) -> None:
        row = self._find_approval_row(approval_id)
        if row is None:
            return
        detail = row.get("detail") or {}
        assets = (detail.get("assets") if isinstance(detail, dict) else None) or []
        items = [asset for asset in assets if isinstance(asset, dict)][:6]
        if not items:
            self._clear_thumbnails("该审批没有图片素材。")
            return

        def work() -> list[dict[str, object]]:
            api = self._client()
            results: list[dict[str, object]] = []
            for asset in items:
                asset_id = str(asset.get("assetId") or "")
                record: dict[str, object] = {"asset": asset, "data": None, "mime": "", "error": ""}
                try:
                    data, mime = api.asset_raw(asset_id)
                except ApiError as exc:
                    record["error"] = exc.user_message()
                else:
                    record["data"] = data
                    record["mime"] = mime
                results.append(record)
            return results

        self._submit(
            "approval-assets",
            work,
            lambda result: self._render_thumbnails(result, approval_id),
            lambda exc: self._clear_thumbnails(f"图片加载失败：{shorten(self._user_error(exc), 80)}"),
            busy_message="正在加载图片预览…",
        )

    def _clear_thumbnails(self, message: str) -> None:
        for child in self.approval_thumbs.winfo_children():
            child.destroy()
        self._thumb_refs.clear()
        ttk.Label(self.approval_thumbs, text=message).pack(anchor="w")

    def _render_thumbnails(self, result: object, approval_id: str) -> None:
        if self.selected_approval_id != approval_id:
            return
        items = result if isinstance(result, list) else []
        for child in self.approval_thumbs.winfo_children():
            child.destroy()
        self._thumb_refs.clear()
        if not items:
            ttk.Label(self.approval_thumbs, text="该审批没有图片素材。").pack(anchor="w")
            return
        row = ttk.Frame(self.approval_thumbs)
        row.pack(anchor="w")
        for record in items:
            asset = record.get("asset") or {}
            data = record.get("data")
            mime = str(record.get("mime") or "")
            box = ttk.Frame(row, padding=3)
            box.pack(side="left", anchor="n")
            photo = self._make_photo(data, mime)
            if photo is not None:
                label = ttk.Label(box, image=photo)
                label.image = photo  # type: ignore[attr-defined]
                self._thumb_refs.append(photo)
                label.pack()
            else:
                hint = "图片预览不可用"
                if not PIL_AVAILABLE:
                    hint += "\n（未安装 Pillow）"
                if record.get("error"):
                    hint += "\n" + shorten(record.get("error"), 40)
                ttk.Label(box, text=hint, justify="center", width=18).pack()
            ttk.Label(
                box,
                text=f"{asset.get('width')}x{asset.get('height')}",
                justify="center",
            ).pack()
        if not PIL_AVAILABLE:
            ttk.Label(
                self.approval_thumbs,
                text="提示：当前 Python 没有 Pillow；PNG/GIF 用 Tk 内置解码，JPEG 会降级为文字占位。",
            ).pack(anchor="w", pady=(4, 0))

    def _make_photo(self, data: object, mime: str) -> object | None:
        if not isinstance(data, (bytes, bytearray)) or len(data) == 0:
            return None
        if PIL_AVAILABLE and Image is not None and ImageTk is not None:
            try:
                image = Image.open(io.BytesIO(bytes(data)))
                image.thumbnail((140, 140))
                return ImageTk.PhotoImage(image)
            except Exception:  # noqa: BLE001
                pass
        if mime in ("image/png", "image/gif", "image/ppm"):
            try:
                encoded = base64.b64encode(bytes(data)).decode("ascii")
                return tk.PhotoImage(data=encoded)
            except tk.TclError:
                return None
        return None

    def _decide_approval(self, action: str) -> None:
        row = self._find_approval_row(self.selected_approval_id)
        if row is None:
            messagebox.showwarning("未选择审批", "请先在左侧列表选择一条待审批内容。")
            return
        approval = row.get("approval") or {}
        detail = row.get("detail") or {}
        draft = (detail.get("draft") if isinstance(detail, dict) else None) or {}
        approval_id = str(approval.get("approvalId") or "")
        content_hash = str(approval.get("contentHash") or "")
        if approval.get("status") != "pending":
            messagebox.showwarning(
                "状态已变化",
                f"该审批当前状态为 {approval_status_text(approval.get('status'))}，不能再批准或拒绝。\n请点击“刷新待审批”。",
            )
            return
        action_zh = "批准" if action == "approve" else "拒绝"
        if action == "approve":
            prompt = (
                f"确认批准该朋友圈审批？\n\n"
                f"任务：{approval.get('taskId')}\n"
                f"正文摘要：{shorten(draft.get('text'), 60)}\n"
                f"可见范围：{approval.get('visibility')}    账号：{approval.get('accountId')}\n"
                f"过期时间：{local_time(approval.get('expiresAt'))}\n\n"
                f"内容哈希（完整）：\n{content_hash}\n\n"
                "批准后这份内容快照被锁定：之后修改正文、图片、可见范围或切换账号"
                "都会导致审批失效（CONTENT_CHANGED），必须重新申请审批。\n\n"
                "该操作会写入审计，无法撤销。确认批准？"
            )
        else:
            prompt = (
                f"确认拒绝该朋友圈审批？\n\n"
                f"任务：{approval.get('taskId')}\n"
                f"正文摘要：{shorten(draft.get('text'), 60)}\n\n"
                "拒绝后任务将进入 CANCELLED，且会写入审计。确认拒绝？"
            )
        if not messagebox.askyesno(f"二次确认：{action_zh}", prompt, icon="warning"):
            return

        def work() -> dict[str, object]:
            api = self._client()
            return api.approve(approval_id) if action == "approve" else api.reject(approval_id)

        def on_success(_result: object) -> None:
            self.set_status(f"已{action_zh}审批 {approval_id}")
            messagebox.showinfo("操作成功", f"已{action_zh}审批 {approval_id}。")
            self.refresh_approvals()
            self.refresh_tasks()
            self.refresh_overview()

        self._submit(
            "approval-action",
            work,
            on_success,
            lambda exc: self._action_failed(action_zh, exc),
            busy_widgets=[self.approve_btn, self.reject_btn, self.approvals_refresh_btn],
            busy_message=f"正在{action_zh}审批…",
        )

    # ------------------------------------------------------------------
    # 任务页
    # ------------------------------------------------------------------
    def _build_tasks_tab(self) -> None:
        tab = ttk.Frame(self.notebook, padding=8)
        self.notebook.add(tab, text="任务")
        self.tasks_tab = tab

        pane = ttk.Panedwindow(tab, orient="horizontal")
        pane.pack(fill="both", expand=True)
        left = ttk.Frame(pane, padding=(0, 0, 6, 0))
        right = ttk.Frame(pane, padding=(6, 0, 0, 0))
        pane.add(left, weight=2)
        pane.add(right, weight=3)

        left_top = ttk.Frame(left)
        left_top.pack(fill="x")
        self.tasks_refresh_btn = ttk.Button(left_top, text="刷新任务", command=self.refresh_tasks)
        self.tasks_refresh_btn.pack(side="left")
        ttk.Button(left_top, text="查看详情", command=self._reload_selected_task).pack(side="left", padx=(6, 0))

        tree_frame, self.tasks_tree = make_tree(
            left,
            [
                ("task", "任务", 190, "w"),
                ("state", "状态", 120, "w"),
                ("updated", "更新时间", 120, "w"),
            ],
            height=17,
        )
        tree_frame.pack(fill="both", expand=True, pady=(6, 0))
        self.tasks_tree.bind("<<TreeviewSelect>>", self._on_task_select)

        action_bar = ttk.Frame(right)
        action_bar.pack(fill="x")
        action_row_one = ttk.Frame(action_bar)
        action_row_one.pack(fill="x")
        action_row_two = ttk.Frame(action_bar)
        action_row_two.pack(fill="x", pady=(4, 0))
        action_row_three = ttk.Frame(action_bar)
        action_row_three.pack(fill="x", pady=(4, 0))
        self.task_action_widgets: dict[str, ttk.Button] = {}

        def add_action(row: ttk.Frame, key: str, text: str, command) -> None:
            button = ttk.Button(row, text=text, command=command)
            button.pack(side="left", padx=(0, 4))
            self.task_action_widgets[key] = button

        add_action(action_row_one, "compose", "重写并审核", self._action_compose)
        add_action(action_row_one, "review", "只审核", self._action_review)
        add_action(action_row_one, "request_approval", "申请审批", self._action_request_approval)
        add_action(action_row_two, "prepare", "准备朋友圈（不发表）", self._action_prepare)
        add_action(action_row_two, "publish", "发表（需二次确认）", self._action_publish)
        add_action(action_row_three, "cancel", "取消", self._action_cancel)
        add_action(action_row_three, "verify", "核验尝试", self._action_verify)
        add_action(action_row_three, "resolve", "人工核对 UNCERTAIN", self._action_resolve_uncertain)

        self.task_hint_var = tk.StringVar(value="请选择任务")
        ttk.Label(right, textvariable=self.task_hint_var, wraplength=640, justify="left").pack(
            fill="x", pady=(4, 0)
        )

        detail_frame = ttk.LabelFrame(right, text="任务详情（状态 / idea / 草稿 / 素材 / 审批 / attempts）", padding=6)
        detail_frame.pack(fill="both", expand=True, pady=(6, 0))
        detail_frame.rowconfigure(0, weight=1)
        detail_frame.columnconfigure(0, weight=1)
        body, self.task_detail_text = make_text_area(detail_frame, height=20)
        body.grid(row=0, column=0, sticky="nsew")
        set_text(self.task_detail_text, "尚未加载任务详情。")
        self._set_task_actions_enabled(False)

    def _set_task_actions_enabled(self, enabled: bool) -> None:
        for button in self.task_action_widgets.values():
            set_widgets_enabled([button], enabled)

    def refresh_tasks(self) -> None:
        self._submit(
            "tasks",
            lambda: self._client().tasks(100),
            self._on_tasks_success,
            self._on_tasks_error,
            busy_widgets=[self.tasks_refresh_btn],
            busy_message="正在读取任务列表…",
        )

    def _on_tasks_success(self, rows: object) -> None:
        self.task_summaries = rows if isinstance(rows, list) else []
        clear_tree(self.tasks_tree)
        for row in self.task_summaries:
            if not isinstance(row, dict):
                continue
            task = row.get("task") or {}
            task_id = str(task.get("taskId") or "")
            if task_id == "":
                continue
            self.tasks_tree.insert(
                "",
                "end",
                iid=task_id,
                values=(
                    task_id,
                    state_short(task.get("state")),
                    short_time(task.get("updatedAt")),
                ),
            )
        chosen = self.selected_task_id
        if chosen is None or chosen not in [str((row.get("task") or {}).get("taskId")) for row in self.task_summaries if isinstance(row, dict)]:
            chosen = None
            for row in self.task_summaries:
                if isinstance(row, dict) and row.get("task"):
                    chosen = str((row.get("task") or {}).get("taskId"))
                    break
        if chosen is not None:
            self._suppress_selection = True
            try:
                self.tasks_tree.selection_set(chosen)
                self.tasks_tree.see(chosen)
            except tk.TclError:
                pass
            self._suppress_selection = False
            self.selected_task_id = chosen
            self._load_task_detail(chosen)
        else:
            self.selected_task_id = None
            self.task_detail = None
            set_text(self.task_detail_text, "当前没有任务。\n\n可在“创作”页生成草稿并提交审批。")
            self._set_task_actions_enabled(False)
            self.task_hint_var.set("当前没有任务")
        self.set_status(f"任务 {len(self.task_summaries)} 个")

    def _on_tasks_error(self, exc: object) -> None:
        self.task_summaries = []
        clear_tree(self.tasks_tree)
        set_text(self.task_detail_text, f"任务列表加载失败：\n\n{self._user_error(exc)}")
        self._set_task_actions_enabled(False)
        self.task_hint_var.set("任务列表加载失败")
        self.set_status("任务列表加载失败")

    def _on_task_select(self, _event: object = None) -> None:
        if self._suppress_selection:
            return
        selection = self.tasks_tree.selection()
        if not selection:
            return
        task_id = str(selection[0])
        if task_id == self.selected_task_id:
            return
        self.selected_task_id = task_id
        self._load_task_detail(task_id)

    def _reload_selected_task(self) -> None:
        if self.selected_task_id is None:
            messagebox.showwarning("未选择任务", "请先在左侧列表选择任务。")
            return
        self._load_task_detail(self.selected_task_id)

    def _load_task_detail(self, task_id: str) -> None:
        target = task_id

        def work() -> dict[str, object]:
            return self._client().task_detail(target)

        self._submit(
            "task-detail",
            work,
            lambda detail: self._on_task_detail(target, detail),
            lambda exc: self._on_task_detail_error(target, exc),
        )

    def _on_task_detail(self, task_id: str, detail: object) -> None:
        if self.selected_task_id != task_id:
            return
        self.task_detail = detail if isinstance(detail, dict) else {}
        self._render_task_detail(self.task_detail)
        self._update_task_action_states(self.task_detail)

    def _on_task_detail_error(self, task_id: str, exc: object) -> None:
        if self.selected_task_id != task_id:
            return
        self.task_detail = None
        set_text(self.task_detail_text, f"任务详情加载失败：\n\n{self._user_error(exc)}")
        self._set_task_actions_enabled(False)
        self.task_hint_var.set("详情加载失败")
        self.set_status(f"任务详情加载失败：{shorten(self._user_error(exc), 120)}")

    def _render_task_detail(self, detail: dict[str, object]) -> None:
        task = detail.get("task") or {}
        idea = detail.get("idea") or {}
        draft = detail.get("draft") or {}
        assets = detail.get("assets") or []
        approvals = detail.get("approvals") or []
        attempts = detail.get("attempts") or []
        image_tasks = detail.get("imageTasks") or []
        preview = detail.get("preview") or {}
        audit = detail.get("audit") or []

        lines = [
            f"任务：{task.get('taskId', '—')}",
            f"状态：{state_text(task.get('state'))}",
            f"可见范围：{task.get('visibility', '—')}    账号：{task.get('accountId') or '—'}",
            f"内容哈希：{task.get('contentHash') or '—'}",
            f"素材清单哈希：{task.get('assetManifestHash') or '—'}",
            f"审批 ID：{task.get('approvalId') or '—'}",
            f"创建：{local_time(task.get('createdAt'))}    更新：{local_time(task.get('updatedAt'))}",
        ]
        if task.get("errorCode"):
            lines.append(f"错误：{task.get('errorCode')}  {task.get('errorMessage') or ''}")
        lines.append("")
        lines.append("【想法 idea】")
        if isinstance(idea, dict) and idea:
            lines += [
                f"主题：{idea.get('topic', '—')}",
                f"动机：{idea.get('motivation', '—')}",
                f"来源：{idea.get('sourceType', '—')}    依据：{shorten(idea.get('sourceEvidence'), 120)}",
                f"评分：novelty={idea.get('noveltyScore')} persona={idea.get('personaScore')} relevance={idea.get('relevanceScore')}",
                f"风险标记：{', '.join(str(item) for item in (idea.get('riskFlags') or [])) or '无'}",
            ]
        else:
            lines.append("（暂无想法记录）")
        lines.append("")
        lines.append("【草稿 draft】")
        if isinstance(draft, dict) and draft:
            lines += [
                f"版本：v{draft.get('version')}    语气：{draft.get('tone') or '—'}",
                "",
                str(draft.get("text") or "（空）"),
            ]
        else:
            lines.append("（暂无草稿）")
        lines.append("")
        lines.append(f"【图片素材 assets】共 {len(assets)} 个")
        for asset in assets if isinstance(assets, list) else []:
            if isinstance(asset, dict):
                lines.append(
                    f"  · {asset.get('assetId')}  {asset.get('mime')}  {asset.get('width')}x{asset.get('height')}  "
                    f"sha256={short_hash(asset.get('sha256'), 16)}  source={asset.get('source')}"
                )
        lines.append("")
        lines.append(f"【审批 approvals】共 {len(approvals)} 条")
        for approval in approvals if isinstance(approvals, list) else []:
            if isinstance(approval, dict):
                lines.append(
                    f"  · {approval.get('approvalId')}  {approval_status_text(approval.get('status'))}  "
                    f"渠道={approval.get('channel')}  过期={local_time(approval.get('expiresAt'))}  "
                    f"哈希={short_hash(approval.get('contentHash'), 16)}"
                )
        lines.append("")
        lines.append(f"【发布尝试 attempts】共 {len(attempts)} 条")
        for attempt in attempts if isinstance(attempts, list) else []:
            if isinstance(attempt, dict):
                verification = attempt.get("verification") or {}
                verified_text = ""
                if isinstance(verification, dict) and verification:
                    verified_text = f"  核验={verification.get('verified')}"
                lines.append(
                    f"  · {attempt.get('attemptId')}  {attempt_state_text(attempt.get('state'))}  "
                    f"模式={attempt.get('mode')}  创建={local_time(attempt.get('createdAt'))}"
                    f"{verified_text}"
                )
                if attempt.get("errorCode"):
                    lines.append(f"      错误码：{attempt.get('errorCode')}")
        lines.append("")
        lines.append(f"【图片任务 imageTasks】共 {len(image_tasks)} 条")
        for image_task in image_tasks if isinstance(image_tasks, list) else []:
            if isinstance(image_task, dict):
                lines.append(
                    f"  · {image_task.get('imageTaskId')}  provider={image_task.get('provider')}  "
                    f"status={image_task.get('status')}  需要用户操作={image_task.get('requiresUserAction')}"
                )
        if isinstance(preview, dict) and preview:
            lines.append("")
            lines.append("【预览 preview】")
            lines.append(f"contentHash：{preview.get('contentHash') or '—'}")
            lines.append(f"assetManifestHash：{preview.get('assetManifestHash') or '—'}")
            warnings = preview.get("warnings")
            if isinstance(warnings, list) and warnings:
                lines.append("警告：" + "；".join(str(item) for item in warnings))
        if isinstance(audit, list) and audit:
            lines.append("")
            lines.append("【最近审计】")
            for event in audit[:5]:
                if isinstance(event, dict):
                    lines.append(
                        f"  · {local_time(event.get('at'))}  {event.get('action')}  "
                        f"{event.get('previousState')} → {event.get('nextState')}  {shorten(event.get('reason'), 60)}"
                    )
        set_text(self.task_detail_text, "\n".join(lines))

    def _update_task_action_states(self, detail: dict[str, object]) -> None:
        task = detail.get("task") or {}
        state = str(task.get("state") or "")
        attempts = detail.get("attempts") or []
        latest_attempt = attempts[-1] if isinstance(attempts, list) and attempts else None
        latest_state = str((latest_attempt or {}).get("state") or "")
        publish_mode = ""
        control = (self.status or {}).get("control") or {}
        if isinstance(control, dict):
            publish_mode = str(control.get("publishMode") or "")
        if not publish_mode:
            publish_mode = str((self.health or {}).get("publishMode") or "")

        enabled = {
            "compose": state not in TERMINAL_STATES and state != "UNCERTAIN",
            "review": state not in TERMINAL_STATES and state != "UNCERTAIN",
            "request_approval": state == "READY_FOR_APPROVAL",
            "prepare": state == "APPROVED",
            "publish": bool(state),
            "cancel": state not in TERMINAL_STATES and state != "UNCERTAIN",
            "verify": bool(latest_attempt),
            "resolve": latest_state == "UNCERTAIN",
        }
        for key, button in self.task_action_widgets.items():
            set_widgets_enabled([button], enabled.get(key, False))

        hints = [f"当前状态：{state_text(state)}"]
        if state == "READY_FOR_APPROVAL":
            hints.append("可申请审批；批准后才可以准备朋友圈。")
        elif state == "APPROVED":
            hints.append("已批准：可准备朋友圈（只填图文，不点击发表）。")
        else:
            hints.append("“准备朋友圈”需要任务已批准（APPROVED）。")
        if publish_mode and publish_mode != "APPROVAL_REQUIRED":
            hints.append(
                f"当前发布模式为 {publish_mode}：点击“发表”会被后端明确拒绝（PUBLISH_MODE_DISABLED），不会真的发表。"
            )
        if latest_state == "UNCERTAIN":
            hints.append("最新尝试为 UNCERTAIN：禁止重复发表，请先“核验尝试”或“人工核对 UNCERTAIN”。")
        self.task_hint_var.set("  ".join(hints))

    # -- 任务动作 --------------------------------------------------------
    def _current_task_id(self) -> str | None:
        if self.selected_task_id:
            return self.selected_task_id
        return None

    def _task_action_work(self, action: str, task_id: str):
        api = self._client()
        if action == "compose":
            return lambda: api.compose(task_id)
        if action == "review":
            return lambda: api.review(task_id)
        if action == "request_approval":
            return lambda: api.request_approval(task_id)
        if action == "prepare":
            return lambda: api.prepare(task_id)
        if action == "cancel":
            return lambda: api.cancel(task_id)
        raise ValueError(action)

    def _run_task_action(self, action: str, label: str, confirm_text: str, on_success) -> None:
        task_id = self._current_task_id()
        if task_id is None:
            messagebox.showwarning("未选择任务", "请先在左侧列表选择任务。")
            return
        if not messagebox.askyesno(f"二次确认：{label}", confirm_text, icon="warning"):
            return
        self._submit(
            "task-action",
            self._task_action_work(action, task_id),
            on_success,
            lambda exc: self._action_failed(label, exc),
            busy_widgets=list(self.task_action_widgets.values()) + [self.tasks_refresh_btn],
            busy_message=f"{label}中…（长任务最长约 180 秒，请勿关闭窗口）",
            on_finish=self._reapply_task_action_states,
        )

    def _reapply_task_action_states(self) -> None:
        if self.task_detail:
            self._update_task_action_states(self.task_detail)
        else:
            self._set_task_actions_enabled(False)

    def _task_action_success_refresh(self) -> None:
        self.refresh_tasks()
        self.refresh_approvals()
        self.refresh_overview()

    def _action_compose(self) -> None:
        task_id = self._current_task_id()
        if task_id is None:
            messagebox.showwarning("未选择任务", "请先在左侧列表选择任务。")
            return
        self._run_task_action(
            "compose",
            "重写并审核",
            f"将重写任务 {task_id} 的草稿并重新审核；通过后会自动申请审批。\n\n"
            "原草稿会保留为历史版本。该操作可能调用模型（30~120 秒）。继续？",
            self._on_compose_success,
        )

    def _on_compose_success(self, data: object) -> None:
        payload = data if isinstance(data, dict) else {}
        review = payload.get("review") or {}
        detail = payload.get("detail") or {}
        approval = payload.get("approval") or {}
        if isinstance(detail, dict) and detail:
            self.task_detail = detail
            self._render_task_detail(detail)
            self._update_task_action_states(detail)
        lines = [f"重写并审核完成。", f"审核：{'通过' if review.get('passed') else '未通过'}"]
        for note in review.get("notes") or []:
            lines.append(f"  · {note}")
        if isinstance(approval, dict) and approval:
            lines.append(f"审批 ID：{(approval.get('approval') or {}).get('approvalId')}")
        self.set_status("重写并审核完成")
        messagebox.showinfo("操作成功", "\n".join(lines))
        self._task_action_success_refresh()

    def _action_review(self) -> None:
        task_id = self._current_task_id()
        if task_id is None:
            messagebox.showwarning("未选择任务", "请先在左侧列表选择任务。")
            return
        self._run_task_action(
            "review",
            "只审核",
            f"将只重新审核任务 {task_id} 的当前草稿（不重写），通过后自动申请审批。继续？",
            self._on_review_success,
        )

    def _on_review_success(self, data: object) -> None:
        payload = data if isinstance(data, dict) else {}
        review = payload.get("review") or {}
        detail = payload.get("detail") or {}
        approval = payload.get("approval") or {}
        if isinstance(detail, dict) and detail:
            self.task_detail = detail
            self._render_task_detail(detail)
            self._update_task_action_states(detail)
        lines = [f"审核完成。", f"结果：{'通过' if review.get('passed') else '未通过'}"]
        for note in review.get("notes") or []:
            lines.append(f"  · {note}")
        if isinstance(approval, dict) and approval:
            lines.append(f"审批 ID：{(approval.get('approval') or {}).get('approvalId')}")
        self.set_status("审核完成")
        messagebox.showinfo("审核结果", "\n".join(lines))
        self._task_action_success_refresh()

    def _action_request_approval(self) -> None:
        task_id = self._current_task_id()
        if task_id is None:
            messagebox.showwarning("未选择任务", "请先在左侧列表选择任务。")
            return
        self._run_task_action(
            "request_approval",
            "申请审批",
            f"将为任务 {task_id} 创建一次性审批（仅当任务处于待审批状态）。\n\n"
            "审批绑定当前正文、图片清单、可见范围与账号；之后任一项变化都会使审批失效。继续？",
            self._on_request_approval_success,
        )

    def _on_request_approval_success(self, data: object) -> None:
        payload = data if isinstance(data, dict) else {}
        approval = payload.get("approval") or {}
        request = payload.get("request") or {}
        approval_id = (approval.get("approvalId") if isinstance(approval, dict) else None) or (
            request.get("approvalId") if isinstance(request, dict) else None
        )
        self.set_status(f"已申请审批：{approval_id}")
        messagebox.showinfo(
            "审批已创建",
            f"审批 ID：{approval_id or '—'}\n"
            f"过期时间：{local_time((approval or {}).get('expiresAt'))}\n"
            f"通过微信通道发送：{'是' if payload.get('delivered') else '否（请在本机客户端批准）'}",
        )
        self._task_action_success_refresh()

    def _action_prepare(self) -> None:
        task_id = self._current_task_id()
        if task_id is None:
            messagebox.showwarning("未选择任务", "请先在左侧列表选择任务。")
            return
        self._run_task_action(
            "prepare",
            "准备朋友圈（不发表）",
            f"将调用桌面执行器打开微信朋友圈编辑界面，填入任务 {task_id} 的正文与图片。\n\n"
            "此操作不会点击发表；需要任务已批准（APPROVED）且桌面执行器可用。继续？",
            self._on_prepare_success,
        )

    def _on_prepare_success(self, data: object) -> None:
        payload = data if isinstance(data, dict) else {}
        prepared = payload.get("prepared")
        warnings = payload.get("warnings") or []
        lines = [
            f"准备结果：{'成功（未发表）' if prepared else '未完成'}",
            f"文字匹配：{payload.get('textMatched')}",
            f"图片数量：{payload.get('imageCount')}",
            f"截图：{payload.get('screenshotPath') or '—'}",
        ]
        for warning in warnings:
            lines.append(f"  · {warning}")
        lines.append("")
        lines.append("提醒：准备阶段不会点击发表；真实发表需另行操作并二次确认。")
        self.set_status("准备朋友圈完成（未发表）")
        messagebox.showinfo("准备完成", "\n".join(lines))
        self._task_action_success_refresh()

    def _action_cancel(self) -> None:
        task_id = self._current_task_id()
        if task_id is None:
            messagebox.showwarning("未选择任务", "请先在左侧列表选择任务。")
            return
        self._run_task_action(
            "cancel",
            "取消任务",
            f"确认取消任务 {task_id}？\n\n取消会作废该任务的待审批；UNCERTAIN 状态不可取消。继续？",
            self._on_cancel_success,
        )

    def _on_cancel_success(self, data: object) -> None:
        payload = data if isinstance(data, dict) else {}
        task = payload.get("task") if isinstance(payload.get("task"), dict) else payload
        state = task.get("state") if isinstance(task, dict) else None
        task_id = task.get("taskId") if isinstance(task, dict) else None
        self.set_status(f"任务已取消：{task_id or ''} {state_text(state)}")
        messagebox.showinfo("已取消", f"任务状态：{state_text(state)}")
        self._task_action_success_refresh()

    def _action_publish(self) -> None:
        task_id = self._current_task_id()
        if task_id is None:
            messagebox.showwarning("未选择任务", "请先在左侧列表选择任务。")
            return
        detail = self.task_detail or {}
        task = detail.get("task") or {}
        preview = detail.get("preview") or {}
        content_hash = task.get("contentHash") or (preview.get("contentHash") if isinstance(preview, dict) else None) or "—"
        approval_id = task.get("approvalId") or ""
        control = (self.status or {}).get("control") or {}
        publish_mode = (control.get("publishMode") if isinstance(control, dict) else None) or (self.health or {}).get(
            "publishMode"
        ) or "—"
        first = messagebox.askyesno(
            "二次确认：发表到微信朋友圈",
            f"你正在尝试真实发表一条朋友圈。\n\n"
            f"任务：{task_id}\n"
            f"当前状态：{state_text(task.get('state'))}\n"
            f"当前发布模式：{publish_mode}\n\n"
            f"内容哈希：\n{content_hash}\n\n"
            "后端只有在“发布模式 APPROVAL_REQUIRED + 有效一次性审批 + 桌面执行器允许发表 + "
            "账号/版本/桌面状态全部通过”时才会真正点击发表；默认 PREPARE_ONLY 会返回 "
            "PUBLISH_MODE_DISABLED 并且不会发表。\n\n继续？",
            icon="warning",
        )
        if not first:
            return
        second = messagebox.askyesno(
            "最终确认：马上调用发表接口",
            f"请最后一次确认：\n\n任务 {task_id}\n内容哈希：{short_hash(content_hash, 32)}…\n\n"
            "点击“是”后客户端会调用 POST /api/tasks/{taskId}/publish。\n"
            "若返回 PUBLISH_MODE_DISABLED 或任何错误码，客户端只展示结果，绝不静默重试。\n\n确定继续？",
            icon="warning",
        )
        if not second:
            return

        def work() -> dict[str, object]:
            return self._client().publish(task_id, approval_id or None)

        self._submit(
            "task-action",
            work,
            self._on_publish_success,
            lambda exc: self._action_failed("发表", exc),
            busy_widgets=list(self.task_action_widgets.values()) + [self.tasks_refresh_btn],
            busy_message="正在调用发表接口…（最长约 180 秒）",
            on_finish=self._reapply_task_action_states,
        )

    def _on_publish_success(self, data: object) -> None:
        payload = data if isinstance(data, dict) else {}
        uncertain = bool(payload.get("uncertain"))
        message = str(payload.get("message") or "")
        lines = [
            f"submitted：{payload.get('submitted')}",
            f"verified：{payload.get('verified')}",
            f"uncertain：{uncertain}",
        ]
        for line in message.splitlines() if message else []:
            lines.append(line)
        lines.append("")
        if uncertain:
            lines.append("已点击发表但无法确认结果（UNCERTAIN）：禁止自动重试。请先“核验尝试”或人工核对朋友圈。")
            self.set_status("发表结果不确定（UNCERTAIN）")
            messagebox.showwarning("结果不确定（UNCERTAIN）", "\n".join(lines))
        else:
            lines.append("提醒：只有 verified=true 才表示核验成功；uncertain 时不要重复发表。")
            self.set_status("发表接口调用完成")
            messagebox.showinfo("发表结果", "\n".join(lines))
        self._task_action_success_refresh()
        self.refresh_history()

    def _action_verify(self) -> None:
        detail = self.task_detail or {}
        attempts = detail.get("attempts") or []
        if not isinstance(attempts, list) or not attempts:
            messagebox.showinfo("没有尝试", "当前任务没有发布尝试记录，无法核验。")
            return
        attempt = attempts[-1]
        attempt_id = str((attempt or {}).get("attemptId") or "")
        state = (attempt or {}).get("state")
        if attempt_id == "":
            messagebox.showwarning("缺少 attemptId", "最新尝试缺少 attemptId，无法核验。")
            return
        if not messagebox.askyesno(
            "二次确认：核验发布尝试",
            f"将对尝试 {attempt_id}\n当前状态：{attempt_state_text(state)}\n\n"
            "核验调用 POST /api/attempts/{attemptId}/verify，只读取真实结果，不会重试发表。继续？",
            icon="question",
        ):
            return

        def work() -> dict[str, object]:
            return self._client().verify_attempt(attempt_id)

        self._submit(
            "verify",
            work,
            self._on_verify_success,
            lambda exc: self._action_failed("核验尝试", exc),
            busy_widgets=list(self.task_action_widgets.values()),
            busy_message="正在核验发布尝试…",
            on_finish=self._reapply_task_action_states,
        )

    def _on_verify_success(self, data: object) -> None:
        payload = data if isinstance(data, dict) else {}
        attempt = payload.get("attempt") or {}
        verification = payload.get("verification") or {}
        task = payload.get("task") or {}
        notes = verification.get("notes") if isinstance(verification, dict) else None
        lines = [
            f"尝试：{attempt.get('attemptId', '—')}",
            f"尝试状态：{attempt_state_text(attempt.get('state'))}",
            f"核验通过：{verification.get('verified') if isinstance(verification, dict) else '—'}",
            f"核验方式：{verification.get('method') if isinstance(verification, dict) else '—'}",
            f"发表时间：{local_time(verification.get('publishedAt')) if isinstance(verification, dict) else '—'}",
            f"任务状态：{state_text(task.get('state'))}",
        ]
        if isinstance(notes, list):
            for note in notes:
                lines.append(f"  · {note}")
        self.set_status(f"核验完成：verified={verification.get('verified') if isinstance(verification, dict) else '—'}")
        messagebox.showinfo("核验结果", "\n".join(lines))
        self._task_action_success_refresh()
        self.refresh_history()

    def _action_resolve_uncertain(self) -> None:
        detail = self.task_detail or {}
        attempts = detail.get("attempts") or []
        latest = attempts[-1] if isinstance(attempts, list) and attempts else None
        attempt_id = str((latest or {}).get("attemptId") or "")
        if attempt_id == "" or str((latest or {}).get("state")) != "UNCERTAIN":
            messagebox.showinfo("无需人工核对", "最新发布尝试不是 UNCERTAIN。")
            return
        resolution, note = self._ask_manual_resolution(attempt_id)
        if resolution is None:
            return
        if not messagebox.askyesno(
            "二次确认：人工核对 UNCERTAIN",
            f"确认将该尝试标记为 {resolution}？\n\n"
            f"尝试：{attempt_id}\n说明：{note or '（无）'}\n\n"
            "该操作会写入审计，且不可撤销。只有你在微信朋友圈人工确认后才能这样操作。继续？",
            icon="warning",
        ):
            return

        def work() -> dict[str, object]:
            return self._client().resolve_uncertain(attempt_id, resolution, note or "所有者在本机客户端人工核对朋友圈")

        self._submit(
            "verify",
            work,
            lambda result: self._on_resolve_success(result, resolution),
            lambda exc: self._action_failed("人工核对", exc),
            busy_widgets=list(self.task_action_widgets.values()),
            busy_message="正在提交人工核对结果…",
            on_finish=self._reapply_task_action_states,
        )

    def _on_resolve_success(self, _result: object, resolution: str) -> None:
        self.set_status(f"人工核对已提交：{resolution}")
        messagebox.showinfo("已提交", f"人工核对结果已提交：{resolution}")
        self._task_action_success_refresh()

    def _ask_manual_resolution(self, attempt_id: str) -> tuple[str | None, str]:
        dialog = tk.Toplevel(self)
        dialog.title("人工核对 UNCERTAIN")
        dialog.transient(self)
        dialog.resizable(False, False)
        dialog.grab_set()
        frame = ttk.Frame(dialog, padding=14)
        frame.pack(fill="both", expand=True)
        ttk.Label(
            frame,
            text=(
                f"尝试：{attempt_id}\n\n"
                "请先打开微信朋友圈，人工确认这次发表是否已经成功。\n"
                "UNCERTAIN 禁止自动重试；确认后才可在此收敛。"
            ),
            wraplength=460,
            justify="left",
        ).pack(anchor="w")
        ttk.Label(frame, text="核对说明（会写入审计）：").pack(anchor="w", pady=(10, 2))
        note_var = tk.StringVar(value="已人工核对微信朋友圈")
        ttk.Entry(frame, textvariable=note_var, width=56).pack(fill="x")
        result: dict[str, str | None] = {"value": None}
        buttons = ttk.Frame(frame)
        buttons.pack(fill="x", pady=(12, 0))

        def finish(value: str) -> None:
            result["value"] = value
            dialog.destroy()

        ttk.Button(buttons, text="确认已发布（PUBLISHED）", command=lambda: finish("PUBLISHED")).pack(side="left")
        ttk.Button(buttons, text="确认未发布（FAILED）", command=lambda: finish("FAILED")).pack(side="left", padx=6)
        ttk.Button(buttons, text="取消", command=dialog.destroy).pack(side="right")
        dialog.wait_window()
        return result["value"], note_var.get().strip()

    # ------------------------------------------------------------------
    # 历史页
    # ------------------------------------------------------------------
    def _build_history_tab(self) -> None:
        tab = ttk.Frame(self.notebook, padding=8)
        self.notebook.add(tab, text="历史")
        self.history_tab = tab
        top = ttk.Frame(tab)
        top.pack(fill="x")
        self.history_refresh_btn = ttk.Button(top, text="刷新历史", command=self.refresh_history)
        self.history_refresh_btn.pack(side="left")
        ttk.Label(top, text="（已发布记录与候选主题只读）").pack(side="left", padx=(8, 0))

        pane = ttk.Panedwindow(tab, orient="vertical")
        pane.pack(fill="both", expand=True, pady=(6, 0))

        published_frame = ttk.LabelFrame(pane, text="已发布（/api/history published）", padding=6)
        published_body, self.published_tree = make_tree(
            published_frame,
            [
                ("time", "发表时间", 140, "w"),
                ("account", "账号", 150, "w"),
                ("visibility", "可见范围", 80, "w"),
                ("verified", "已核验", 70, "w"),
                ("text", "正文摘要", 360, "w"),
                ("post", "postId", 180, "w"),
            ],
            height=8,
        )
        published_body.pack(fill="both", expand=True)
        pane.add(published_frame, weight=1)

        ideas_frame = ttk.LabelFrame(pane, text="候选主题（/api/history ideas）", padding=6)
        ideas_body, self.ideas_tree = make_tree(
            ideas_frame,
            [
                ("time", "创建时间", 140, "w"),
                ("topic", "主题", 360, "w"),
                ("source", "来源", 130, "w"),
                ("scores", "评分", 200, "w"),
                ("task", "任务", 180, "w"),
            ],
            height=7,
        )
        ideas_body.pack(fill="both", expand=True)
        pane.add(ideas_frame, weight=1)

    def refresh_history(self) -> None:
        self._submit(
            "history",
            lambda: self._client().history(20),
            self._on_history_success,
            self._on_history_error,
            busy_widgets=[self.history_refresh_btn],
            busy_message="正在读取历史记录…",
        )

    def _on_history_success(self, data: object) -> None:
        payload = data if isinstance(data, dict) else {}
        self.history_data = payload
        clear_tree(self.published_tree)
        clear_tree(self.ideas_tree)
        published = payload.get("published") or []
        ideas = payload.get("ideas") or []
        for post in published if isinstance(published, list) else []:
            if isinstance(post, dict):
                self.published_tree.insert(
                    "",
                    "end",
                    values=(
                        local_time(post.get("publishedAt")),
                        post.get("accountId") or "—",
                        post.get("visibility") or "—",
                        "是" if post.get("verified") else "否",
                        shorten(post.get("text"), 60),
                        post.get("postId") or "—",
                    ),
                )
        for idea in ideas if isinstance(ideas, list) else []:
            if isinstance(idea, dict):
                self.ideas_tree.insert(
                    "",
                    "end",
                    values=(
                        local_time(idea.get("createdAt")),
                        idea.get("topic") or "—",
                        idea.get("sourceType") or "—",
                        f"n={idea.get('noveltyScore')} p={idea.get('personaScore')} r={idea.get('relevanceScore')}",
                        idea.get("taskId") or "—",
                    ),
                )
        self.set_status(f"历史：已发布 {len(published)} 条，候选主题 {len(ideas)} 条")

    def _on_history_error(self, exc: object) -> None:
        clear_tree(self.published_tree)
        clear_tree(self.ideas_tree)
        self.set_status(f"历史加载失败：{shorten(self._user_error(exc), 120)}")

    # ------------------------------------------------------------------
    # 设置页
    # ------------------------------------------------------------------
    def _build_settings_tab(self) -> None:
        tab = ttk.Frame(self.notebook, padding=8)
        self.notebook.add(tab, text="设置")
        self.settings_tab = tab
        tab.columnconfigure(0, weight=1)
        tab.columnconfigure(1, weight=1)
        tab.rowconfigure(0, weight=1)

        left = ttk.Frame(tab)
        left.grid(row=0, column=0, sticky="nsew", padx=(0, 6))
        right = ttk.Frame(tab)
        right.grid(row=0, column=1, sticky="nsew", padx=(6, 0))
        right.rowconfigure(0, weight=1)
        right.rowconfigure(1, weight=1)
        right.columnconfigure(0, weight=1)

        conn = ttk.LabelFrame(left, text="连接设置（令牌只从文件读取，不写入配置）", padding=8)
        conn.pack(fill="x")
        conn.columnconfigure(1, weight=1)
        ttk.Label(conn, text="管理 API 地址：").grid(row=0, column=0, sticky="e", padx=(0, 4), pady=3)
        self.settings_base_var = tk.StringVar(value=self.settings.base_url)
        ttk.Entry(conn, textvariable=self.settings_base_var).grid(row=0, column=1, columnspan=2, sticky="ew", pady=3)
        ttk.Label(conn, text="令牌文件：").grid(row=1, column=0, sticky="e", padx=(0, 4), pady=3)
        self.settings_token_var = tk.StringVar(value=str(self.settings.token_file))
        ttk.Entry(conn, textvariable=self.settings_token_var).grid(row=1, column=1, sticky="ew", pady=3)
        ttk.Button(conn, text="浏览…", command=self._browse_token_file).grid(row=1, column=2, padx=(4, 0), pady=3)
        button_row = ttk.Frame(conn)
        button_row.grid(row=2, column=0, columnspan=3, sticky="w", pady=(6, 0))
        self.settings_save_btn = ttk.Button(button_row, text="保存配置", command=self._save_client_settings)
        self.settings_save_btn.pack(side="left")
        self.settings_test_btn = ttk.Button(button_row, text="测试连接", command=self._test_connection)
        self.settings_test_btn.pack(side="left", padx=(6, 0))
        ttk.Button(button_row, text="打开数据目录", command=self._open_data_dir).pack(side="left", padx=(6, 0))

        status = ttk.LabelFrame(left, text="本地状态（不含令牌内容）", padding=8)
        status.pack(fill="x", pady=(8, 0))
        self.token_state_var = tk.StringVar(value="")
        self.data_dir_var = tk.StringVar(value="")
        self.config_path_var = tk.StringVar(value="")
        ttk.Label(status, textvariable=self.token_state_var, wraplength=520, justify="left").pack(anchor="w")
        ttk.Label(status, textvariable=self.data_dir_var, wraplength=520, justify="left").pack(anchor="w", pady=(3, 0))
        ttk.Label(status, textvariable=self.config_path_var, wraplength=520, justify="left").pack(anchor="w", pady=(3, 0))

        controls = ttk.LabelFrame(left, text="所有者控制（均需二次确认）", padding=8)
        controls.pack(fill="x", pady=(8, 0))
        self.control_buttons: list[ttk.Button] = []
        for text, action in (
            ("暂停", "pause"),
            ("恢复", "resume"),
            ("启用 Kill Switch", "kill"),
            ("解除 Kill Switch", "unkill"),
        ):
            button = ttk.Button(controls, text=text, command=lambda a=action: self._control_action(a))
            button.pack(side="left", padx=(0, 6))
            self.control_buttons.append(button)
        ttk.Label(
            controls,
            text=KILL_SWITCH_WARNING,
            wraplength=520,
            justify="left",
        ).pack(anchor="w", pady=(6, 0))

        readonly = ttk.LabelFrame(right, text="脱敏配置摘要（/api/config，只读）", padding=6)
        readonly.grid(row=0, column=0, sticky="nsew")
        readonly.rowconfigure(1, weight=1)
        readonly.columnconfigure(0, weight=1)
        read_top = ttk.Frame(readonly)
        read_top.grid(row=0, column=0, sticky="ew")
        ttk.Button(read_top, text="刷新只读信息", command=self._load_settings_info).pack(side="left")
        read_body, self.config_text = make_text_area(readonly, height=10)
        read_body.grid(row=1, column=0, sticky="nsew", pady=(6, 0))
        set_text(self.config_text, "尚未加载。点击“刷新只读信息”。")

        persona = ttk.LabelFrame(right, text="人格只读预览（/api/persona）", padding=6)
        persona.grid(row=1, column=0, sticky="nsew", pady=(8, 0))
        persona.rowconfigure(1, weight=1)
        persona.columnconfigure(0, weight=1)
        persona_top = ttk.Frame(persona)
        persona_top.grid(row=0, column=0, sticky="ew")
        ttk.Button(persona_top, text="人格 SOUL", command=lambda: self._show_persona("soul")).pack(side="left")
        ttk.Button(persona_top, text="视觉风格", command=lambda: self._show_persona("visualStyle")).pack(
            side="left", padx=(6, 0)
        )
        persona_body, self.persona_text = make_text_area(persona, height=10)
        persona_body.grid(row=1, column=0, sticky="nsew", pady=(6, 0))
        set_text(self.persona_text, "尚未加载。点击“刷新只读信息”。")

        self._refresh_settings_display()

    def _refresh_settings_display(self) -> None:
        exists, message = token_file_state(self.settings)
        self.token_state_var.set(f"令牌文件：{message}")
        self.data_dir_var.set(f"数据目录：{self.settings.data_dir}")
        self.config_path_var.set(f"客户端配置文件：{self.config_path}")
        self.settings_base_var.set(self.settings.base_url)
        self.settings_token_var.set(str(self.settings.token_file))
        self._settings_loaded = False

    def _browse_token_file(self) -> None:
        initial = Path(self.settings_token_file).parent
        path = filedialog.askopenfilename(
            title="选择管理令牌文件",
            initialdir=str(initial) if initial.exists() else str(Path.home()),
            filetypes=[("令牌文件", "*.txt"), ("所有文件", "*.*")],
        )
        if path:
            self.settings_token_var.set(path)

    def _save_client_settings(self) -> None:
        base_url = self.settings_base_var.get().strip()
        token_file_text = self.settings_token_var.get().strip()
        if token_file_text == "":
            messagebox.showwarning("令牌文件路径为空", "请填写管理令牌文件路径（默认 <项目>/data/admin-token.txt）。")
            return
        token_file = Path(token_file_text).expanduser()
        if not token_file.is_absolute():
            token_file = (PROJECT_ROOT / token_file).resolve()
        new_settings = ClientSettings(
            base_url=base_url,
            token_file=token_file,
            data_dir=self.settings.data_dir,
            config_path=self.config_path,
        )
        try:
            save_settings(new_settings, self.config_path)
        except ConfigError as exc:
            messagebox.showerror("保存失败", str(exc))
            return
        except Exception as exc:  # noqa: BLE001
            messagebox.showerror("保存失败", f"无法保存客户端配置：{exc}")
            return
        self.settings = load_settings(self.config_path)
        self.api = None
        self._refresh_settings_display()
        self.set_status(f"客户端配置已保存：{self.config_path}")
        messagebox.showinfo(
            "已保存",
            f"客户端配置已保存到：\n{self.config_path}\n\n"
            "配置中不包含管理令牌；令牌只从令牌文件读取。\n"
            "点击“测试连接”或“刷新”验证连接。",
        )
        self.refresh_overview()

    def _test_connection(self) -> None:
        self._submit(
            "test-connection",
            lambda: self._client().health(),
            self._on_test_connection_success,
            lambda exc: self._action_failed("测试连接", exc),
            busy_widgets=[self.settings_test_btn],
            busy_message="正在测试连接…",
        )

    def _on_test_connection_success(self, health: object) -> None:
        data = health if isinstance(health, dict) else {}
        lines = [
            f"插件：{data.get('plugin', '—')} v{data.get('version', '—')}",
            f"数据库：{data.get('database', '—')}",
            f"LLM：{adapter_status_text((data.get('llm') or {}).get('status'))}",
            f"发布模式：{data.get('publishMode', '—')}",
            f"调度：{'启用' if data.get('scheduleEnabled') else '关闭'}",
            f"检查时间：{local_time(data.get('checkedAt'))}",
        ]
        self.set_status("连接正常")
        messagebox.showinfo("连接成功", "\n".join(lines))

    def _load_settings_info(self) -> None:
        def work() -> dict[str, object]:
            api = self._client()
            return {"config": api.config_summary(), "persona": api.persona()}

        self._submit(
            "settings-info",
            work,
            self._on_settings_info_success,
            self._on_settings_info_error,
            busy_message="正在读取脱敏配置与人格预览…",
        )

    def _on_settings_info_success(self, data: object) -> None:
        payload = data if isinstance(data, dict) else {}
        config = payload.get("config")
        persona = payload.get("persona")
        self.config_data = config if isinstance(config, dict) else {}
        self.persona_data = persona if isinstance(persona, dict) else {}
        self._settings_loaded = True
        masked = masked_settings(self.settings)
        lines = ["客户端本地设置（脱敏）：", pretty_json(masked), "", "插件配置摘要（GET /api/config）：", pretty_json(self.config_data)]
        set_text(self.config_text, "\n".join(lines))
        self._show_persona("soul")
        self.set_status("已加载脱敏配置与人格预览")

    def _on_settings_info_error(self, exc: object) -> None:
        message = self._user_error(exc)
        set_text(self.config_text, f"读取配置摘要失败：\n\n{message}")
        set_text(self.persona_text, f"读取人格预览失败：\n\n{message}")
        self.set_status(f"读取设置信息失败：{shorten(message, 120)}")

    def _show_persona(self, key: str) -> None:
        if not self.persona_data:
            set_text(self.persona_text, "尚未加载人格预览。请点击“刷新只读信息”。")
            return
        title = "人格 SOUL（只读）" if key == "soul" else "视觉风格 VISUAL_STYLE（只读）"
        content = self.persona_data.get(key) or "（空）"
        source = self.persona_data.get("source") or "—"
        loaded_at = local_time(self.persona_data.get("loadedAt"))
        set_text(
            self.persona_text,
            f"{title}\n来源：{source}\n加载时间：{loaded_at}\n\n{content}",
        )

    def _control_action(self, action: str) -> None:
        labels = {
            "pause": ("暂停系统", "暂停后不会创建新任务，也不会开始新的 GUI 发表。"),
            "resume": ("恢复系统", "恢复后按配置继续运行；若 Kill Switch 开启，仍需单独解除。"),
            "kill": ("启用 Kill Switch", KILL_SWITCH_WARNING),
            "unkill": ("解除 Kill Switch", "解除后系统恢复接受创作/准备/发表请求（仍受审批与发布模式约束）。"),
        }
        label, description = labels[action]
        if not messagebox.askyesno(
            f"二次确认：{label}",
            f"{description}\n\n确认执行“{label}”？该操作会写入审计。",
            icon="warning",
        ):
            return

        def work() -> dict[str, object]:
            api = self._client()
            if action == "pause":
                return api.pause("所有者在本机客户端暂停")
            if action == "resume":
                return api.resume("所有者在本机客户端恢复")
            if action == "kill":
                return api.kill("所有者在本机客户端启用 Kill Switch")
            return api.unkill("所有者在本机客户端解除 Kill Switch")

        def on_success(result: object) -> None:
            payload = result if isinstance(result, dict) else {}
            self.set_status(f"{label}已执行")
            messagebox.showinfo("操作成功", f"{label}已执行。\n返回：{pretty_json(payload)}")
            self.refresh_overview()

        self._submit(
            "control",
            work,
            on_success,
            lambda exc: self._action_failed(label, exc),
            busy_widgets=self.control_buttons,
            busy_message=f"正在执行：{label}…",
        )

    # ------------------------------------------------------------------
    # 通用提交/错误/刷新
    # ------------------------------------------------------------------
    def _submit(
        self,
        job_id: str,
        work,
        on_success,
        on_error=None,
        *,
        busy_widgets: list[tk.Misc] | None = None,
        busy_message: str | None = None,
        on_finish=None,
    ) -> bool:
        widgets = list(busy_widgets or [])
        previous = self._busy_widgets.get(job_id)
        if previous:
            widgets = list(dict.fromkeys(previous + widgets))

        def finish() -> None:
            set_widgets_enabled(widgets, True)
            self._busy_widgets.pop(job_id, None)
            if on_finish is not None:
                on_finish()

        submitted = self.jobs.submit(job_id, work, on_success, on_error, finish)
        if not submitted:
            self.set_status("已有同类后台任务在执行，请稍候…")
            return False
        if widgets:
            self._busy_widgets[job_id] = widgets
            set_widgets_enabled(widgets, False)
        if busy_message:
            self.set_status(busy_message)
        return True

    def _handle_async_error(self, job_id: str, exc: object) -> None:
        message = self._user_error(exc)
        self.set_status(f"后台任务 {job_id} 失败：{shorten(message, 140)}")

    def _user_error(self, exc: object) -> str:
        if isinstance(exc, ApiError):
            return exc.user_message()
        if isinstance(exc, ConfigError):
            return str(exc)
        if isinstance(exc, BaseException):
            return f"客户端内部错误：{exc}"
        return str(exc)

    def _action_failed(self, label: str, exc: object) -> None:
        message = self._user_error(exc)
        if isinstance(exc, ApiError) and exc.error_code:
            message += f"\n\n错误码：{exc.error_code}"
        if isinstance(exc, ApiError) and exc.kind in ("auth", "connection", "timeout", "config"):
            self._set_connection("error" if exc.kind != "timeout" else "warn", "连接异常")
        self.set_status(f"{label}失败：{shorten(message, 150)}")
        messagebox.showerror(f"{label}失败", message)

    def set_status(self, message: str) -> None:
        text = "" if message is None else str(message)
        if len(text) > 400:
            text = text[:400] + "…"
        self.status_var.set(text)

    # ------------------------------------------------------------------
    # 快捷入口
    # ------------------------------------------------------------------
    def _open_admin_page(self) -> None:
        url = self.settings.base_url.rstrip("/") + "/"
        try:
            webbrowser.open(url)
            self.set_status(f"已尝试在浏览器打开管理页：{url}")
        except Exception as exc:  # noqa: BLE001
            messagebox.showerror("打开管理页失败", f"无法打开浏览器：{exc}")

    def _open_data_dir(self) -> None:
        data_dir = Path(self.settings.data_dir)
        if not data_dir.exists():
            messagebox.showwarning("数据目录不存在", f"数据目录不存在：\n{data_dir}\n\n请确认插件 dataDir 配置。")
            return
        try:
            os.startfile(str(data_dir))  # type: ignore[attr-defined]
        except AttributeError:
            messagebox.showinfo("无法打开", f"当前平台不支持自动打开目录，请手动打开：\n{data_dir}")
        except OSError as exc:
            messagebox.showerror("打开数据目录失败", f"{data_dir}\n\n{exc}")

    # ------------------------------------------------------------------
    # 生命周期
    # ------------------------------------------------------------------
    def _client(self) -> AdminApiClient:
        if self.api is None:
            self.api = AdminApiClient(self.settings.base_url, self.settings.token_file)
        return self.api

    def refresh_all(self) -> None:
        self.refresh_overview()
        self.refresh_tasks()
        self.refresh_approvals()
        self.refresh_history()
        if self._settings_loaded:
            self._load_settings_info()

    def _on_tab_changed(self, _event: object = None) -> None:
        try:
            current = self.notebook.tab(self.notebook.select(), "text")
        except tk.TclError:
            return
        if current == "设置" and not self._settings_loaded:
            self._load_settings_info()

    def _on_close(self) -> None:
        self._closing = True
        try:
            self.destroy()
        except tk.TclError:
            pass


# ----------------------------------------------------------------------
# 入口
# ----------------------------------------------------------------------
def _enable_dpi_awareness() -> None:
    if sys.platform != "win32":
        return
    try:
        import ctypes

        ctypes.windll.shcore.SetProcessDpiAwareness(1)
    except Exception:  # noqa: BLE001
        pass


def _check_connection(settings: ClientSettings) -> int:
    print("客户端配置（脱敏）：")
    print(pretty_json(masked_settings(settings)))
    try:
        client = AdminApiClient(settings.base_url, settings.token_file)
    except ApiError as exc:
        print(f"\n配置错误：{exc.user_message()}")
        return 2
    try:
        health = client.health()
    except ApiError as exc:
        print(f"\n连接失败：{exc.user_message()}")
        return 1
    print("\n连接成功：")
    print(pretty_json(health))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=APP_TITLE)
    parser.add_argument("--config", default=None, help="客户端配置文件路径（默认 client/moments-client.json）")
    parser.add_argument("--check", action="store_true", help="只检查配置与连接，不打开窗口")
    parser.add_argument("--tab", type=int, default=0, help="启动时打开的页签序号（0 概览 / 1 创作 / 2 待审批 / 3 任务 / 4 历史 / 5 设置）")
    args = parser.parse_args(argv)
    config_path = Path(args.config).expanduser() if args.config else None
    try:
        settings = load_settings(config_path)
    except ConfigError as exc:
        print(f"加载客户端配置失败：{exc}")
        return 2
    if args.check:
        return _check_connection(settings)
    _enable_dpi_awareness()
    app = MomentsClientApp(settings, settings.config_path, initial_tab=args.tab)
    app.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
