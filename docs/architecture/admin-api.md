# 本机管理 API（客户端契约 v1）

`dsh-moments-agent` 在启用 `adminServer.enabled` 时，于 `127.0.0.1:<port>`（默认 18766）提供本机管理 API。
Windows 客户端 `client/` 只使用这些端点，不直接读写 SQLite，不绕过状态机与审批门禁。

## 认证与安全

- 所有 `/api/*` 请求必须携带：`X-Moments-Token: <token>`（也可用 `Authorization: Bearer <token>`）。
- token 来自插件配置 `adminServer.tokenFile`（默认 `<项目>/data/admin-token.txt`），不存在时插件自动生成。
- 服务只绑定 `127.0.0.1`；非回环来源拒绝。
- token 不写入客户端配置文件；客户端只保存 token 文件路径。
- 审批模式要求一次性人工批准；第三档无需逐条人工审批。模式选择本身需在设置页确认应用，所有模式继续执行内容与账号校验。

## 通用响应

成功：`{ "ok": true, "data": ... }`
业务失败：HTTP 400（`NOT_FOUND` 为 404）+ `{ "ok": false, "errorCode": "...", "message": "中文错误" }`
认证失败：HTTP 401。
未知端点：HTTP 404。

## 端点

### GET /api/publish-mode

返回 `{mode, requireApproval}`，mode 为 `PREPARE_ONLY` / `APPROVAL_REQUIRED` / `POLICY_AUTONOMOUS`。

### POST /api/publish-mode

请求 `{mode, expectedMode?}`。保存选择并写审计，重启后恢复；expectedMode 不匹配、Publisher 忙碌或存在准备中/已准备/发表中的任务时拒绝切换。仅改变模式，不创建任务或立即发表。

完整客户端应调用本地协调端点 `POST /api/client/publish-mode`，携带 `X-Requested-With: DSHMomentsClient`。协调器获取执行器锁，先降为仅准备，再调用插件接口并同步执行器权限。网络结果不确定时保持仅准备；重新应用同一模式可恢复同步。直接调用插件端点只修改插件，不能替代客户端权限同步。

### GET /api/automation 与 POST /api/automation

GET 返回 `{scheduleEnabled, scheduler, policy, status}`；policy 仅包含 `dailyLimit`、`minIntervalMinutes`、`quietHours`、`timeZone` 和 `humanize`。POST 接受这三类设置字段，校验并原子保存，重启后恢复；status 只读，不能写入。

禁止通过此接口修改发表模式、账号、审批要求、暂停与 Kill Switch。Publisher 忙碌时拒绝保存；现有队列的等待时间与重试预算保留，后续执行使用新的限额与时段检查。

### GET /api/health

返回 `runtime.health()`：数据库、模型、WeChatAgent、桌面执行器、图像 Provider、发布模式、计数。
客户端顶栏用它显示连接状态。

### GET /api/status

返回 `RuntimeStatus`：控制状态（暂停/Kill Switch/模式/调度）、账号、打开任务、待审批、计数。
可选 `?taskId=` 附带单任务状态。

### GET /api/tasks?limit=100

返回任务摘要数组，每项：

```json
{
  "task": { "taskId": "...", "state": "READY_FOR_APPROVAL", "visibility": "PUBLIC", "accountId": "...", ... },
  "idea": { "ideaId": "...", "topic": "...", "motivation": "...", ... } | null,
  "draft": { "draftId": "...", "version": 1, "text": "...", "tone": "..." } | null,
  "assets": [{ "assetId": "...", "sha256": "...", "mime": "image/png", "width": 1024, "height": 1024 }],
  "approval": { "approvalId": "...", "status": "pending|approved|...", "expiresAt": "...", "contentHash": "..." } | null,
  "approvals": [...],
  "attempts": [...],
  "attempt": {...} | null
}
```

### GET /api/tasks/{taskId}

返回任务详情：上述摘要 + `preview`（contentHash/assetManifestHash/正文/素材）+ `imageTasks` + `draftVersions` + `audit`。

### GET /api/persona

返回 `{ soul, visualStyle, source, loadedAt }`（只读）。

### GET /api/config

返回脱敏后的配置摘要（不含 token），用于设置页展示。

### GET /api/approvals

返回 pending 审批数组（`ApprovalRecord`）。

### POST /api/approvals/{approvalId}/approve

```json
{ "reason": "可选" }
```

批准后任务进入 `APPROVED`；文案/图片/可见范围/账号任一变化都会失败（`CONTENT_CHANGED`）。

### POST /api/approvals/{approvalId}/reject

```json
{ "reason": "可选" }
```

拒绝后任务 `CANCELLED`。

### POST /api/workflow/draft

客户端「一键创作」，执行：选题 → 文案 → 审核 → 申请审批（**不会**准备/发表）。

```json
{ "topic": "可选，指定主题", "sourceType": "可选", "sourceEvidence": "可选", "motivation": "可选" }
```

返回：

```json
{
  "silent": false,
  "taskId": "task_...",
  "review": { "passed": true, "notes": [], "flags": [] },
  "approval": { "approval": {...}, "request": {...}, "delivered": false } | null,
  "detail": { ...任务详情... }
}
```

模型判断没有值得表达的内容时 `silent=true`、`reason` 给出原因，不创建任务。

### POST /api/tasks/{taskId}/compose

```json
{ "tone": "可选", "feedback": "可选" }
```

重写草稿并重新审核；通过则自动申请审批。

### POST /api/tasks/{taskId}/review

只重新审核当前草稿；通过则自动申请审批。

### POST /api/tasks/{taskId}/request-approval

为 `READY_FOR_APPROVAL` 任务创建一次性审批（若客户端没有走一键创作）。

### POST /api/tasks/{taskId}/prepare

调用桌面执行器准备朋友圈编辑界面（不点击发表）。
需要：任务 `APPROVED`、桌面执行器启用且健康、执行器 token 正确。

### POST /api/tasks/{taskId}/publish

```json
{ "approvalId": "可选" }
```

真实发表。需要：`APPROVAL_REQUIRED` + 有效审批 + 执行器 `--allow-publish` + 账号/版本/桌面状态全部通过。
客户端必须二次确认；默认配置下会返回 `PUBLISH_MODE_DISABLED`。

### POST /api/tasks/{taskId}/cancel

取消未发表任务；`UNCERTAIN` 不可取消。

### GET /api/history?limit=20

返回 `{ published: [...], ideas: [...] }`。

### GET /api/preview/{taskId}

返回 `store.buildPreview(taskId)`：正文/素材/contentHash/assetManifestHash/审批状态/警告。

### POST /api/attempts/{attemptId}/verify

调用 `runtime.verify(attemptId)`，返回 `{ attempt, verification, task }`。
用于 UNCERTAIN 的自动核验；确认成功才会把任务收敛为 `PUBLISHED`。不会重试发表。

### GET /api/assets/{assetId}/raw

返回图片原始字节（需要 token）；客户端用于预览。
会校验数据库 SHA-256 与文件内容一致。

### POST /api/pause / /api/resume / /api/kill / /api/unkill

本机所有者控制；body 可选 `{ "reason": "..." }`。

### POST /api/uncertain/{attemptId}/resolve

```json
{ "resolution": "PUBLISHED" | "FAILED", "note": "人工核对说明" }
```

只处理 `UNCERTAIN` 尝试；必须由所有者在客户端确认。

## 社交记忆（群聊 / 私聊 → 人物印象）

最小可用契约见 [社交记忆](chat-memory.md)。以下端点只服务本机所有者：绑定 `127.0.0.1` + 管理令牌；
返回**含真实群名/昵称**，仅供本机管理页展示与手工修正，禁止客户端缓存、导出或上传。
不提供原始聊天正文读取、批量导出或关闭审计的接口。

### GET /api/chat-memory

返回所有者视图（`ChatMemoryView`）：

```json
{
  "enabled": true,
  "settings": {
    "enabled": true,
    "includePrivate": false,
    "conversations": [],
    "syncIntervalMinutes": 60,
    "maxMessagesPerConversation": 200,
    "retentionDays": 30,
    "impressionTtlDays": 90,
    "maxMembersPerConversation": 100,
    "anonymizeInPrompts": true,
    "useLlmExtraction": true
  },
  "stats": {
    "conversations": 1,
    "messages": 12,
    "members": 3,
    "lastSyncedAt": "2026-10-25T09:00:00.000Z"
  },
  "conversations": [
    {
      "conversation": {
        "conversationKey": "……",
        "kind": "group",
        "label": "群聊A",
        "displayName": "示例群",
        "enabled": true,
        "lastSyncedAt": "2026-10-25T09:00:00.000Z",
        "lastMessageAt": "2026-10-25T08:55:00.000Z",
        "createdAt": "2026-10-24T09:00:00.000Z",
        "updatedAt": "2026-10-25T09:00:00.000Z"
      },
      "members": [
        {
          "impressionId": "imp_……",
          "conversationKey": "……",
          "memberRef": "……",
          "alias": "群友A",
          "displayName": "联系人A",
          "summary": "经常参与技术讨论，表达直接",
          "traits": ["表达直接", "认真讨论"],
          "topics": ["本地模型"],
          "style": "句子短，常用反问",
          "confidence": 0.6,
          "evidenceCount": 4,
          "status": "observed",
          "source": "auto",
          "firstSeenAt": "2026-10-24T09:00:00.000Z",
          "lastSeenAt": "2026-10-25T08:55:00.000Z",
          "updatedAt": "2026-10-25T09:00:00.000Z",
          "expiresAt": "2027-01-23T09:00:00.000Z"
        }
      ]
    }
  ]
}
```

`kind` 只有 `group` / `private`；`status` 为 `new`（证据不足待观察）/ `observed` / `owner_edited`。
`conversationKey` 是稳定哈希，不含原始 talker；管理 API 在服务端剥离原始 `talker` / `accountId`（wxid），
不返回聊天正文。`conversation.enabled=false` 表示该会话未参与同步（私聊未开启或已停用），管理页会标注。
默认关闭时仍返回 `enabled=false`、当前设置与本地已有数据（从未同步则为空统计），管理页据此展示引导文案。

### POST /api/chat-memory/settings

请求体是设置子集，只允许下列字段（携带其它字段返回 `INVALID_INPUT`，不会部分保存）：

```json
{
  "enabled": true,
  "includePrivate": false,
  "conversations": [],
  "syncIntervalMinutes": 60,
  "maxMessagesPerConversation": 200,
  "retentionDays": 30,
  "impressionTtlDays": 90,
  "maxMembersPerConversation": 100,
  "anonymizeInPrompts": true,
  "useLlmExtraction": true
}
```

响应为**完整** settings（`ChatMemorySettingsView`）。保存到 `system_settings.chat_memory_config` 并写审计，
重启后恢复；只改配置，不触发同步、不改变发表权限与审批要求。字段范围由 `config.chatMemory` 校验
（例如 `syncIntervalMinutes` 5~1440、`retentionDays` 1~180）。

### POST /api/chat-memory/sync

请求体可省略或为 `{}`。立即同步一次（忽略自动同步间隔），只读 WeChatAgent 白名单内的群聊/私聊，
不发送任何微信消息。响应（`ChatSyncResult`）：

```json
{
  "conversations": 1,
  "newMessages": 8,
  "impressionsUpdated": 2,
  "skipped": [{ "label": "私聊B", "reason": "未开启 includePrivate" }],
  "errors": []
}
```

- `skipped`：被整体跳过的会话原因（私聊未开启、不在 `conversations` 白名单、上游不可用等）；
- `errors`：单个会话同步/提炼失败的原因，不中断其它会话；
- 重复同步幂等：相同消息不会重复入库，`newMessages=0`。

未启用时返回 `CHAT_MEMORY_DISABLED`；WeChatAgent 不可用或读取失败返回 `WECHAT_UNAVAILABLE`；
微信账号未验证返回 `WECHAT_ACCOUNT_NOT_VERIFIED`。

### PATCH /api/chat-memory/members/{impressionId}

所有者修正单条人物印象（写审计，`status` 变为 `owner_edited`）：

```json
{
  "alias": "群友A",
  "summary": "所有者修正后的印象",
  "traits": ["表达直接"],
  "topics": ["本地模型"],
  "style": "句子短",
  "status": "owner_edited"
}
```

所有字段可选；别名 1~8 个中文/字母/数字/下划线，摘要 ≤300 字，标签 ≤6 个（每个 ≤12 字），
话题 ≤8 个（每个 ≤16 字），风格 ≤120 字，`status` 只能是 `new` / `observed` / `owner_edited`。
成功返回更新后的印象对象；未知 ID → `NOT_FOUND`；非法字段或值 → `INVALID_INPUT`；
社交记忆未启用 → `CHAT_MEMORY_DISABLED`。

### DELETE /api/chat-memory/members/{impressionId}

删除一条人物印象（写审计），返回 `{ "ok": true }`；未知 ID → `NOT_FOUND`。

### DELETE /api/chat-memory/conversations/{conversationKey}

清除该会话的全部消息与人物印象（写审计），返回：

```json
{ "ok": true, "data": { "messages": 12, "members": 3 } }
```

会话不存在时返回 `{ "messages": 0, "members": 0 }`（幂等，不报错）。

## 隐私说明（社交记忆）

- 以上端点只允许回环来源 + 有效管理令牌；`displayName` 是真实昵称，只在本机管理页展示；
- 真实昵称、wxid、原始 talker、聊天原文不进入提示词与朋友圈，也不会经本 API 返回消息正文；
- 管理页只做展示与手工修正；客户端不得把响应写盘、导出或上传；
- 关闭 `chatMemory.enabled` 后不再读取聊天；已存数据由所有者通过删除成员/清除会话移除。

## 客户端验收要求

1. 连接失败/令牌错误给出中文提示，不崩溃；
2. 所有列表可刷新；
3. 待审批可预览正文/图片/哈希后批准或拒绝（二次确认）；
4. 发表按钮在没有满足条件时展示后端错误码，不静默；
5. 不显示/记录 token；不把 token 写入日志；
6. 窗口截图可用于验收，但不得包含 token。
