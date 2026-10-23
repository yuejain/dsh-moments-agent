"""DSH Moments Agent 的 Windows 桌面管理客户端（Python Tkinter）。

本包只通过本机管理 API（默认 http://127.0.0.1:18766）与插件交互，
不直接读写 SQLite，也不绕过插件内的审批与发布状态机。
"""

__version__ = "0.1.0"
