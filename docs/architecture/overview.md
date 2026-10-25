# 架构总览

## 1. 设计目标

1. **独立产品**：朋友圈业务不进入 WeChatAgent 的 `native-context.mjs`，不修改微信 Hook 原生代码。
2. **可测试**：业务层不依赖 Windows GUI、真实微信或真实模型；所有外部边界都有接口与 Mock。
3. **可升级**：不导入 DSH 内部包；只依赖 `ctx` 服务与结构化接口。
4. **默认安全**：默认不自动发布、不自动付费、不跨账号、不越权读取路径。
5. **可恢复**：SQLite 持久化状态机 + 审计；重启后恢复未完成任务，但不补发错过内容。

## 2. 模块依赖（简化）

```
index.ts -> plugin.ts
plugin.ts -> config.ts
          -> storage/store.ts (node:sqlite + migrations)
          -> adapters/dsh/llm.ts (ctx.llm)
          -> adapters/wechatagent/adapter.ts (可选)
          -> approval/owner-channels.ts
          -> adapters/windows/desktop-client.ts
          -> image/index.ts (createImageFacade)
          -> runtime.ts
          -> tools/index.ts
          -> admin/server.ts (可选)
runtime.ts -> brain/{persona,idea-generator,content-composer,content-reviewer,decision-engine}
           -> memory/service.ts (社交记忆：群聊/私聊 → 匿名人物印象；默认关闭)
           -> approval/approval-service.ts
           -> publishing/publisher.ts -> publishing/publish-policy.ts
           -> scheduler/time-policy.ts
           -> security/{kill-switch,path-guard,redaction,prompt-injection}.ts
           -> image facade (接口)
```

方向性约束：

- `domain/` 不依赖任何适配器；
- `brain/` 不直接访问 store，只通过运行时传入的上下文；
- `memory/` 只能通过 `WeChatAgentAdapter.listConversations/listConversationMessages` 读取白名单内会话，不直接读微信数据库；
- `publishing/` 不直接访问 GUI/网络，只依赖 `DesktopExecutor` 接口；
- `tools/` 只做参数校验和结果信封，不承载业务规则。

## 3. 一次完整发布的时序

```
用户/调度器
  -> moments_create_idea        LLM 选题；决策引擎硬规则 + 软评分；可沉默
  -> moments_compose_draft      LLM 文案；本地硬规则复核
  -> [moments_generate_image_task / moments_import_image]
  -> moments_review_draft       隐私/重复/来源/模型复核 -> READY_FOR_APPROVAL
  -> moments_request_approval   生成 contentHash 绑定的一次性审批
  -> 所有者批准（微信命令 / 管理页）
  -> moments_prepare_desktop    桌面执行器打开编辑窗口、填文、传图、截图（不点击）
  -> moments_publish            重新校验快照 + 核销审批 + 点击 + 核验
  -> moments_verify / 人工核对   UNCERTAIN 收敛
```

## 4. 关键不变量

1. 状态只能通过 `transitionTask` 迁移，并必写审计。
2. 审批绑定 `contentHash + assetManifestHash + visibility + accountId`。
3. 发布前必须重新计算快照；旧审批不能用于新内容。
4. 幂等键 = `sha256(taskId + contentHash + accountId + mode)`；一个键只有一个尝试。
5. 已点击的发表不可取消；结果不明 → UNCERTAIN；UNCERTAIN 禁止自动重试。
6. 任意路径进入文件系统前都经过 `resolveInsideRoot` / `assertRegularFile`。
7. 外部输入（聊天/网页/模型输出）只作为数据，不改变权限。
8. 社交记忆只进匿名信号：提示词里没有真实昵称/wxid/原文摘句；草稿命中泄漏门禁直接拒绝（`CHAT_PRIVACY_LEAK`）。

## 5. 与 WeChatAgent 的边界

- 使用其 **Reader API**（账号、消息、图片）与 **Hook API**（`/SendTextMsg`、`/WeChatAgent/health`）。
- 不修改 WeChatAgent 源码；不依赖其未公开的 `sendImage`/`publishMoments` 等不存在的方法。
- 不共享其聊天私密图片池；朋友圈素材库独立。
- 上游没有朋友圈实现，所以朋友圈准备/发表完全由本项目负责。

## 6. 与 DSH 的边界

- 插件通过 `cordis.patch.yml` 的 `insert` 行加载。
- 使用 `ctx.tools.register()` / `ctx.tools.guard()` / `ctx.effect()` / `ctx.llm`。
- 定时由 Host 进程内的 `setInterval`（unref）驱动；到点执行 `runtime.autonomousCycle()`。
- 不写入 Session 事件流，不创建自定义 Session 事件类型；业务数据在 SQLite。
- 不使用 `subagent` 作为朋友圈发布通道。

## 7. 失败与降级

| 失败 | 行为 |
| --- | --- |
| LLM 不可用 | 工具返回 `LLM_UNAVAILABLE`；不伪造内容 |
| SQLite 不可用 | 插件显式降级（`SQLITE_UNAVAILABLE`），不静默丢数据 |
| WeChatAgent 不可用 | 审批走管理页；工具返回明确错误 |
| 桌面执行器不可用 | 准备/发表失败；已准备任务可重试或取消 |
| 图片 Provider 不可用 | 返回明确错误码；人工桥仍可用 |
| 发表结果不明 | UNCERTAIN + 审计 + 人工核对；不重试 |
| 插件卸载 | 停止 timer、关闭管理页、关闭数据库 |

## 8. 测试策略

| 层次 | 方式 | 覆盖 |
| --- | --- | --- |
| 单元 | node:test + Mock | 状态机、决策、审批、策略、路径、安全、工具 |
| 集成 | 真实 SQLite + Mock 适配器 | 完整创作→审批→准备→发表→核验、暂停、重启恢复 |
| 桌面 | Python unittest + FakeWechatDriver | 121 项：鉴权、路径、PREPARE_ONLY、各 GUI 失败分支 |
| 实机 | DSH Host | 安装、加载、工具注册、桌面执行器 HTTP 启动 |
| 未测 | 人工验收 | 真实微信 GUI、真实 WeChatAgent、真实模型/生图 |
