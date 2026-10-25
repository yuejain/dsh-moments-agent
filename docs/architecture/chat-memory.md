# 社交记忆（群聊 / 私聊 → 人物印象 → 朋友圈）

> 版本：v1（2026-10-25）
> 状态：已实现。默认关闭（`chatMemory.enabled=false`），只在所有者显式开启后读取聊天。

## 目标

把朋友圈创作从「只有人设 + 所有者保存的观点」升级为「有社交上下文」：

1. 从 WeChatAgent Reader 读取**所有者已加入聊天范围**的群聊 / 私聊消息；
2. 提炼每个会话的近期气氛，给每个发言成员一份**可修正的人物印象**；
3. 在选题与创作时以**弱参考**注入，让朋友圈更像一个在过日子的人写的；
4. 全程不把聊天原文、真实昵称、wxid 带进公开朋友圈，也不让聊天内容获得任何权限。

## 数据来源与边界

- 只用 WeChatAgent 公开文档化的 Reader 本机接口：
  - `GET /api/v1/sessions`：只返回所有者白名单内的会话；
  - `GET /api/v1/messages?talker=...`：只允许白名单内会话，否则上游直接 `403`。
- 不读取微信原始数据库、不调用未公开接口、不修改 WeChatAgent 源码。
- 上游已做白名单强制；本插件再做一层：
  - `chatMemory.enabled` 默认 `false`；
  - `chatMemory.includePrivate` 默认 `false`（私聊需显式开启）；
  - `chatMemory.conversations` 可选名字白名单（空 = 上游白名单内全部）。
- 不保存图片、文件、语音、链接卡片；只保留纯文本（localType=1）。
- 数据库（`data/moments.sqlite`）属于本机敏感数据，与 DSH 数据目录同级保护；不随发布包分发。
- 日志、错误信息、管理 API 返回中不出现 wxid / 原始 talker / 聊天原文全文；管理页只在所有者本机展示昵称。

## 匿名化与提示词隔离

模型（选题 / 创作 / 印象提炼）**永远拿不到真实昵称和 wxid**：

- 成员：按会话内出现顺序分配稳定别名 `群友A`、`群友B`…（私聊为 `对方`），由本地映射表维护；
- 会话：`群聊A`、`私聊B`；真实群名只存本地，供所有者管理页查看；
- 消息文本入库前脱敏：手机号 / 身份证 / 银行卡 / 邮箱 / URL / `wxid_xxx` / `@昵称` → `[已脱敏]`；
- 批量太长时按时间窗截断；模型输出再经结构校验 + 注入扫描。

硬门禁 `assertNoLeak(text)`：选题与草稿在入库前检查

1. 是否包含任一真实昵称（长度 ≥ 2；会话名、现有印象昵称与最近 1000 条消息发送者名）；
2. 是否包含最近 1000 条入库消息（跨会话）的 ≥ 8 字连续片段（防原话搬运）；
3. 既有 `detectPrivacyRisks` 规则（手机号 / 证件 / 地址等）。

命中即拒绝（`CHAT_PRIVACY_LEAK`），不进入草稿 / 审批；审核记录保留原因。

## 数据模型（migration v3）

### chat_conversations

| 列 | 说明 |
| --- | --- |
| conversation_key PK | `sha256("chat:" + accountId + ":" + talker)` 前 24 位，稳定且不含原始 ID |
| kind | `group` / `private` |
| label | 匿名标签：`群聊A` / `私聊B` |
| display_name | 真实群名/昵称，**仅本地管理页展示** |
| talker | 原始会话 ID，仅同步时使用，不进入提示词与 API |
| account_id | 所属微信账号，切换账号不串数据 |
| enabled | 是否参与同步 |
| last_synced_at / last_message_at / created_at / updated_at | 同步状态与计数来源 |

### chat_messages

| 列 | 说明 |
| --- | --- |
| message_id PK | `sha256(conversation_key + ":" + localId + ":" + createTime)` 前 32 位，幂等去重 |
| conversation_key | 所属会话 |
| member_ref | `sha256("member:" + talker + ":" + senderWxid)` 前 20 位 |
| sender_name | 本地昵称（仅管理页） |
| text | 脱敏后文本，≤ 500 字 |
| sent_at / is_self / ingested_at / expires_at | 时间与保留期 |

索引：`(conversation_key, sent_at)`、`(expires_at)`。

### member_impressions

| 列 | 说明 |
| --- | --- |
| impression_id PK | `imp_` + id |
| conversation_key + member_ref | 唯一键 |
| alias | 稳定别名（群友A / 对方…） |
| display_name | 本地昵称 |
| summary | 1~2 句人物印象，≤ 300 字 |
| traits | 受控标签数组，≤ 6 个（见下） |
| topics | 关心的话题，≤ 8 个 |
| style | 说话风格，≤ 120 字 |
| confidence / evidence_count | 置信度与独立证据条数 |
| status | `new`（<3 条证据，待观察）/ `observed` / `owner_edited` |
| source | `auto` / `owner` / `agent` |
| first_seen_at / last_seen_at / updated_at / expires_at | TTL 默认 90 天 |

受控标签：`爱玩梗`、`表达简短`、`偏好详细解释`、`表达直接`、`语气温和`、`喜欢提问`、`乐于分享`、`喜欢接话`、`认真讨论`、`爱发表情`、`热心`、`话多`、`潜水`、`毒舌`。
标签只描述可观察的互动倾向，不做心理诊断；健康、政治、年龄、收入等敏感推断一律不记录。

## 模块 API 契约

### 适配器（`WeChatAgentAdapter` 新增）

```ts
interface WechatConversation {
  talker: string;                 // 原始 ID，只在内存/DB 使用
  kind: 'group' | 'private';
  displayName: string;
}
interface WechatChatMessage {
  messageId: string;              // 由 localId + createTime 组合
  sentAt: string;                 // ISO
  senderWxid: string;
  senderName: string;
  text: string;
  isSelf: boolean;
}
listConversations(limit: number): Promise<WechatConversation[]>;
listConversationMessages(talker: string, limit: number): Promise<WechatChatMessage[]>;
```

### 记忆服务（`src/memory/service.ts`）

```ts
class ChatMemoryService {
  constructor(deps: {
    store: MomentsStore;
    config: () => ChatMemoryConfig;   // 运行时可被管理页修改
    wechat: () => WeChatAgentAdapter | null;
    llm: LlmClient;
    logger: Logger;
    clock?: () => Date;
  });

  enabled(): boolean;
  sync(options?: { force?: boolean }): Promise<ChatSyncResult>;  // force 保留字段；显式 sync 总是立即执行
  maybeAutoSync(): Promise<void>;                 // 不满足间隔/未启用时直接返回，错误只记日志
  view(): ChatMemoryView;                         // 所有者视图：含真实昵称
  agentView(): ChatMemoryAgentView;               // Agent 视图：只含别名、摘要、标签
  updateMember(impressionId: string, patch: MemberImpressionPatch, actor: 'owner' | 'agent'): MemberImpressionRecord;
  deleteMember(impressionId: string): void;
  purgeConversation(conversationKey: string): { messages: number; members: number };
  purgeAll(): void;
  ideaSignals(now?: Date): string[];              // 匿名聊天信号（≤4 条，供选题弱参考）
  composeBrief(now?: Date): string;               // 匿名社交氛围 + 人物印象（≤2000 字）
  assertNoLeak(text: string, where: string): void; // CHAT_PRIVACY_LEAK
}
```

### 运行时（`MomentsRuntime` 新增/接入）

```ts
chatMemoryView(): ChatMemoryView;                       // 所有者
agentChatMemoryView(): ChatMemoryAgentView;             // 工具返回
updateChatMemorySettings(input): ChatMemoryConfig;      // 持久化 system_settings.chat_memory_config
syncChatMemory(): Promise<ChatSyncResult>;
updateChatMemberImpression(id, input): MemberImpressionRecord;
deleteChatMemberImpression(id): void;
purgeChatConversation(key): { messages: number; members: number };
```

接入点：

1. `createIdea` / `runAutonomousCycle`：`maybeAutoSync()` → `ideaGenerator.generate({ chatSignals: service.ideaSignals() })`；
2. `composeDraftInner`：`composer.compose({ socialContext: service.composeBrief() })`；
3. 选题候选与草稿文本落库前：`service.assertNoLeak(...)`；
4. 失败只影响本能力，不影响发布主链路。

### 工具（`moments_*`，仍只允许独立朋友圈会话调用）

| 工具 | 说明 |
| --- | --- |
| `moments_sync_chat_memory` | 手动同步一次；返回会话数、新消息数、印象更新数；失败原因结构化 |
| `moments_get_chat_memory` | 读取匿名视图（别名 + 摘要 + 标签 + 会话标签），供创作参考 |
| `moments_update_member_impression` | 追加/修正印象（摘要、标签、话题、风格；别名/状态/证据数只有所有者能改），写入 source=agent |

工具不提供：原始消息读取、真实昵称读取、批量导出、关闭审计。

### 管理 API（本机 127.0.0.1 + Bearer 管理令牌）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/chat-memory` | 设置 + 会话 + 印象 + 统计（含真实昵称，仅本机） |
| POST | `/api/chat-memory/settings` | 修改开关/白名单/保留期等（走 config 校验） |
| POST | `/api/chat-memory/sync` | 立即同步（`{ force?: boolean }`） |
| PATCH | `/api/chat-memory/members/:id` | 所有者修正印象（别名/摘要/标签/状态） |
| DELETE | `/api/chat-memory/members/:id` | 删除单条印象 |
| DELETE | `/api/chat-memory/conversations/:key` | 清除该会话消息与印象 |

## 配置

```yaml
chatMemory:
  enabled: false            # 总开关，默认关闭
  includePrivate: false     # 私聊需显式开启
  conversations: []         # 会话名或 conversationKey；空 = 上游白名单内全部
  syncIntervalMinutes: 60   # 自动同步最小间隔
  maxMessagesPerConversation: 200
  retentionDays: 30         # 消息保留期
  impressionTtlDays: 90     # 印象有效期
  maxMembersPerConversation: 100
  anonymizeInPrompts: true  # 保留字段：实现始终匿名，设为 false 也不会关闭匿名化
  useLlmExtraction: true    # LLM 提炼；false 时只做确定性统计（标签/频率）
```

## 失败与降级

- WeChatAgent 不可用 / 会话不在白名单：同步跳过并记 `skipped` 原因，不反复重试；
- LLM 提炼失败：保留已有印象，本次只入库消息，记日志；`useLlmExtraction=false` 时用确定性统计生成低置信度印象；
- 数据库损坏 / 迁移失败：插件启动失败并明确报错，不静默降级；
- 印象过期：查询与提示词自动过滤；过期数据由同步时顺带清理。

## 已知限制（有意为之）

- **误拦**：泄漏门禁按「真实昵称/群名 ≥2 字」做子串匹配，昵称与常用词重合时（例如群名包含「工作」）可能误拦正常草稿；此时可以选择换表达，或在管理页清除该会话记忆。宁可误拦，不放过泄漏。
- **门禁覆盖有界**：昵称集合来自会话名、最近 1000 条入库消息的发送者名与全部现存印象；原文片段池为跨会话最近 1000 条消息。超出这个窗口的极老消息不会被逐字比对（但仍受昵称/隐私规则约束）。
- **只做 NFKC 归一**：全角/半角、兼容字母数字会被归一后比较与脱敏；更复杂的同形字（形近汉字、谐音、拼音缩写）不做推断，需审核与人工判断兜底。
- **所有者手填内容同样过滤**：所有者修正印象时，摘要/标签/话题/风格/别名若命中真实昵称或原文片段会被拒绝（`CHAT_PRIVACY_LEAK`）；历史版本留下的泄漏字段在 Agent 视图与提炼提示词中剔除，但仍保留在所有者视图供修正。
- **门禁 fail-closed**：本地社交记忆库读取失败时，涉及创作的隐私门禁会拒绝内容进入草稿/审批，而不是静默放行。
- **私聊会话会登记但默认不同步**：`includePrivate=false` 时私聊会话以 `enabled=false` 落库，便于管理页识别并显式开启；不会读取其消息。
- **LLM 提炼失败不回退启发式**：保留既有印象并记 `errors`，避免用低质量结果覆盖；新成员要等下一次成功提炼。
- **别名可能复用**：别名只在同一会话内唯一；某成员印象被删除/过期后，下一个新成员可能再次拿到该别名（不做墓碑），因此别名不代表跨时间的固定身份。
- **一次手动同步产生两条审计**：`chat_memory_sync_requested`（所有者触发）与 `chat_memory_synced`（同步结果），便于区分意图与结果。

## 验收

1. 默认配置下不读取任何聊天（`enabled=false`），工具返回明确说明；
2. 开启群聊后：同步幂等、消息可过期、印象有空/有证据两种状态；
3. 提示词中不出现真实昵称、wxid、原始会话名；
4. 草稿若包含真实昵称或 8 字以上原文片段 → 拒绝并给出 `CHAT_PRIVACY_LEAK`；
5. 关闭 `chatMemory` 后，朋友圈主链路与现有测试不受影响。
