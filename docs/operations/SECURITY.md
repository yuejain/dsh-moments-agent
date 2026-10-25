# 安全与隐私说明

## 1. 默认拒绝清单

| 动作 | 默认 | 打开方式 |
| --- | --- | --- |
| 自动创作 | 关闭 | `scheduleEnabled: true` |
| 准备朋友圈 GUI | 关闭 | `desktopExecutor.enabled: true` + 执行器启动 |
| 点击发表 | 禁止 | `APPROVAL_REQUIRED` + 审批 + `--allow-publish` |
| 付费图像 API | 禁止 | `officialApiEnabled: true` + 密钥 + 预算 |
| WeChatAgent 通知/命令 | 关闭 | `wechatAgent.enabled: true` + token + ownerWxid |
| 本机管理页 | 关闭 | `adminServer.enabled: true` |

## 2. 凭据处理

- 微信读取令牌 / Hook 令牌 / 桌面执行器令牌 / 管理令牌都不写入业务数据库。
- 配置只保存令牌文件路径；令牌从文件或环境变量读取。
- 日志脱敏规则：Bearer、`sk-*`、64 位十六进制、`wxid_*`、JSON `token/password/secret/apiKey`。
- 不要把真实 token 写入 README、示例配置、Git 或聊天记录。
- `.gitignore` 已排除 `.env`、`data/`、`config/moments.local.json`。

## 3. 审批为何能防重复/篡改

- 审批绑定内容哈希（正文 + 图片 SHA 清单 + 可见范围 + 账号）。
- 审批一次性消费；发布前核销；过期失效。
- 内容任何变化都会导致哈希不一致，审批被标记 `superseded`。
- 目标账号切换后账号哈希变化，审批失效。
- Agent 工具层没有 approve 能力；批准来自所有者微信命令（校验 ownerWxid + 账号）或本机管理令牌。

## 4. UNCERTAIN 处理流程

1. 出现 UNCERTAIN 时停止自动发布（工具会拒绝再次 publish）。
2. 打开你的微信朋友圈，人工确认内容是否存在。
3. 若已发布：管理页 → 输入 attemptId → “人工确认已发布”。
4. 若未发布：管理页 → “人工确认未发布”，然后重新走审批流程。
5. 全过程写入 `audit_events`。

## 5. Kill Switch 与暂停

- 暂停：不创建新任务、不执行新的 GUI 发表；已开始但未发表的任务可安全取消。
- Kill Switch：在暂停基础上禁止 prepare/publish 工具；需所有者显式解除。
- 状态持久化在 SQLite `system_settings`，重启保持。

## 6. 提示词注入

- 微信消息、网页、图片文字、模型输出都作为 `<untrusted-data>` 数据传入。
- 检测到“忽略规则/立即发布/泄露 token”等文字时只加 `PROMPT_INJECTION_SUSPECTED` 风险标记，并阻断自动发布。
- 安全配置只从受保护的本地配置读取，聊天内容不能修改配置、权限或发布模式。

## 7. 路径与文件

- 素材采用内容寻址：`data/assets/<前2>/<次2>/<sha256>.<ext>`。
- 导入只允许 `data/imports` 与 `data/assets`；拒绝 `..`、绝对路径逃逸、符号链接、目录、Windows 保留设备名。
- 桌面执行器对截图路径、attemptId 做白名单校验。
- 删除/清理素材前请先备份；本工具不会自动删除已发布记录。

## 8. 数据最小化

- 不把完整微信聊天记录写入朋友圈 Agent 记忆。
- 聊天信号只能是“弱候选”，需要所有者授权才可进入选题。
- 私密聊天图片池与朋友圈素材库物理隔离；不得跨场景共享。
- 日志只记录任务 ID、状态、哈希前缀、错误码，不记录完整正文与图片内容。

## 9. 第三方与许可

- 不包含第三方微信 Hook 源码/DLL；不进行 DLL 注入、协议逆向或数据库篡改。
- WeChatAgent 集成只使用其文档化本地接口；真实接入前需自行确认 Hook 许可与平台规则。
- 订阅生图只支持人工客户端完成 + 回传，不抓 Cookie、不调用非公开接口。
- Codex 子智能体只接受/返回文本，本项目**不**将其视为图像生成能力。

## 10. 事件响应

1. 立即暂停 / 打开 Kill Switch；
2. 停止桌面执行器进程；
3. 备份并检查 `data/moments.sqlite`、`audit_events`、`data/assets`；
4. 轮换桌面 token / 管理 token / WeChatAgent token；
5. 若涉及账号风险，先在微信侧人工核对并处理。
