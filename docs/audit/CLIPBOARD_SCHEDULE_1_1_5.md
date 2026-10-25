# 1.1.5 剪贴板与自主调度修复验证

日期：2026-10-24。客户端 1.1.5，插件 0.2.3。

## 剪贴板

日志复现：已打开朋友圈编辑器后返回「无法写入剪贴板，拒绝盲粘贴」。旧实现没有声明 GlobalAlloc / GlobalLock / SetClipboardData 等 Win32 API 的参数和返回类型，ctypes 默认 int32 会截断 64 位指针；同时使用 OpenClipboard(NULL) 后 EmptyClipboard，没有有效所有者。

修复为显式指针类型、当前线程内的隐藏消息窗口所有者、短暂占用重试、正确移交及释放 HGLOBAL。粘贴结束时按剪贴板序列号判断内容是否仍属于程序，保留用户在期间新复制的内容。隐藏窗口与 HTTP 执行器共用本进程，没有增加独立执行器进程。

API 契约依据：[微软 OpenClipboard 文档](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-openclipboard)、[SetClipboardData 文档](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setclipboarddata)。

新增八项自动化测试：Unicode/emoji、64 位句柄、占用重试、持久占用、窗口/内存失败、Empty/Set 失败释放及避免清除用户新内容。原生 Windows 探测确认 64 位窗口创建、Unicode 内存往返和带所有者打开剪贴板成功。该探测没有调用 EmptyClipboard 或 SetClipboardData，没有修改原有剪贴板；不将其表述为真实微信粘贴或发表验收。

## 自主调度

设置页顶部独立显示「自主调度」卡，自动读取服务器设置；长期记忆保留独立卡片。提供自主创作开关、检查间隔、概率、随机延迟，以及自动发送开关、每日限额、最小间隔、等待范围、活跃/静默时段、时区与高级退避选项。

新增带原有管理鉴权的 GET/POST /api/automation。验证白名单字段、范围、时间格式、时区，原子持久化并在运行时恢复；不允许修改发表模式、账号、审批权限或解除暂停。Publisher 忙碌时拒绝保存。旧队列的等待时间与失败预算保留，每次发送复检新时段和限额。

浏览器验收使用隔离的 Mock 后台，设置 120 秒、35%、10 秒随机延迟、Asia/Singapore 后保存并刷新读回；开启创作与发送仍保持 PREPARE_ONLY。延迟下限大于上限时拒绝保存并保留编辑内容；纠正后成功保存，最后关闭两个调度开关。后台刷新不会覆盖未保存的修改。没有开启生产账号自动发送，没有向微信发消息或发朋友圈。

截图：`release/DSH-Moments-1.1.5-schedule-preview.png`，为 Mock 测试环境。

## 回归与交付

| 检查 | 结果 |
| --- | --- |
| Node 构建、单元与集成 | 182 项，181 通过，1 跳过 |
| Python 桌面执行器 | 246 项，244 通过，2 跳过 |
| Python 客户端 | 76 项通过 |
| 合计 | 504 项，501 通过，3 跳过 |
| Windows 原生组件探测 | 窗口、64 位内存、Unicode、打开剪贴板通过；未修改剪贴板 |

最终 EXE/ZIP/插件包及签名、内容摘要核验结果见 `release/DSH-Moments-Client-1.1.5-verification.json`。最新日志集中在 `docs/audit/evidence/1.1.5/`。签名使用已有本地自签名证书，不代表 Windows 自动信任发布者。

升级时同时更新插件与 EXE，并在 DSH 中重载插件；旧运行进程不会自动获得源码更新。未完成当前版本的真实微信粘贴、发表验收，未将 Mock 结果计作实机发表成功。
