# 复用决策：REUSE / WRAP / REIMPLEMENT / REJECT

审计基线：提交 `0e76902a66c7bde6a3f78335284cea7f9be6e1b1`（`sourcepro5/WeChatAgent`，`Release WeChatAgent 0.3.9`，2026-10-20）｜审计日期 2026-10-20｜审计方法：逐模块阅读实现与调用方后给出四选一结论；每个结论必须能在源码中找到“复用点/不可复用点”的行级证据；“朋友圈（Moments）”目标功能在本次审计的源码中**不存在任何实现**（`git grep "朋友圈|moments|sns"` 仅命中一张 PNG 图标），因此所有决定都是“把上游聊天能力迁移/复用到新场景”的工程判断，而非对现成朋友圈代码的取舍。

## 0. 结论速览

| 候选模块 | 决策 | 一句话理由 |
| --- | --- | --- |
| `scripts/text-delivery-store.mjs`（TextDeliveryStore） | **REUSE** + 薄封装 | 纯内容哈希/状态持久化，无聊天语义，改目录与 `kind/target` 命名空间即可 |
| 投递 ID / 回执 / `unconfirmed` 状态机（设计） | **REUSE（设计）+ WRAP（传输）** | ID 与状态语义可迁移；回执依赖微信数据库，朋友圈必须换回执源 |
| `scripts/hook-onebot.mjs` 的发送与回执 | **WRAP** 仅限“状态机外壳” | 发送动作绑定 `/SendTextMsg` 与微信数据库 localId，不能直接用于朋友圈 |
| `components/qq-bridge/src/core/message-buffer.js` | **REIMPLEMENT** | 批处理/未读/待发回复/媒体队列全部按“聊天回复”建模 |
| `components/qq-bridge/src/core/social-engine.js` | **REJECT**（仅借用限流公式） | 依赖 whitelist、wake_words、群聊沉默、回复协议，全部是聊天语义 |
| `core/decision-format.js`（RESPOND/SILENT 协议） | **REIMPLEMENT** | 朋友圈决策是“发布/不发布 + 素材选择”，不存在对某条消息的 RESPOND |
| `core/proactive-engine.js` 主动聊天引擎 | **仅作决策参考（REFERENCE），不 REUSE** | 主动聊天只能作为朋友圈自主决策的参考模型；其调度/发送/记录全部绑定聊天会话 |
| `core/proactive-policy.js` 纯策略函数 | **REUSE** | 时间窗、随机抖动、间隔、拒绝语判定与平台无关 |
| `packages/.../image-input.mjs` 图片入模 | **WRAP** | 依赖读取器 `/api/v1/images/{id}` 与 DSH 原生附件，朋友圈需新来源 |
| `scripts/reader-api.py` 图片登记/解析 | **WRAP** | 值钱的只有“身份绑定 + 哈希 + 有界解码”，定位数据源是微信数据库 |
| `scripts/wechat_sticker_collection.py` + `sticker-pool-review.mjs` 表情池 | **REJECT（跨场景共享）** | 表情池按聊天来源授权、含私密素材；**聊天私密图片池不可直接共享到朋友圈** |
| `packages/.../member-memory.mjs` 群友记忆 | **WRAP** | 设计（稳定 ID/证据/标签上限）可迁移，数据按群隔离，需新命名空间 |
| `packages/.../session-groups.mjs` 会话分组 | **REUSE** | 只依赖 DSH `workspaceRegistry`，与微信/聊天无关 |
| `packages/.../dsh-access.mjs` 按聊天授权 | **REUSE**（需扩展键空间） | 正则/白名单全部以 `wechat:(private\|group)` 为界，扩展到朋友圈需新增键类型 |
| `packages/.../prompt-context.mjs` 指令槽位/迁移 | **REUSE（管道）** | 槽位、去重、迁移是 DSH 会话机制，规则内容需换 |
| `packages/.../local-policy.mjs` 本机人格快照 | **REUSE** | 与聊天/朋友圈无关的“配置即权限”边界 |
| `packages/.../context-policy.mjs` + `core/context-maintenance.js` | **REUSE** | 压缩阈值/空闲判定与平台无关 |
| `native-context.mjs` 会话生命周期（sid/恢复/归档换代） | **REUSE（需新命名空间）** | `sidFor`/`agentFor` 与聊天内容无关；但 key 正则与账号 scope 需扩展 |
| `components/qq-bridge/src/safe-fetch.js` | **REUSE** | SSRF 防护与平台无关 |
| `core/session-router.mjs` | **REJECT** | 全仓库无 import 的死模块 |
| `packages/extension-runtime/*` | **REJECT** | 公开构建中 `extensions()` 返回 null，运行时不可达 |
| 原生 Hook `/SendTextMsg`、`/SendStickerMsg` | **REJECT（朋友圈发布）** | 许可未确认 + 只覆盖聊天发送 + 无朋友圈接口 |

## 1. 发送可靠性：TextDeliveryStore 系列

### 1.1 `scripts/text-delivery-store.mjs` — REUSE（薄封装）

证据与可复用点：
- 键 = `sha256(JSON.stringify([kind, String(target), id || 'legacy:'+sha256(text)]))`（`text-delivery-store.mjs:11`），纯函数、无 IO、无聊天字段依赖。
- 状态枚举固定为 `dispatching/accepted/unconfirmed/rejected/confirmed`（`:15`），与具体平台无关。
- 写入是原子替换：临时文件 + `renameSync`，且 `mode 0o600`（`:21-26`），加载时做严格 schema 校验（`:12-20`）。
- 拒绝原因白名单 `NATIVE_SEND_REJECTED|API_HTTP_(400|401|403|409|429)`（`:6-8`）可按朋友圈 API 的 HTTP 码扩展，但**不要照搬“重试”语义**（见 1.2）。

复用方式：保留文件不改，外层 `MomentsDeliveryStore` 用 `kind='moments'`、`target=朋友圈发布目标`、`id=操作 ID`，并把状态文件放到独立目录（如 `state/moments-deliveries/`）。不得与聊天投递共用目录，避免聊天投递状态被打断。

### 1.2 投递 ID / 回执 / 未确认 — REUSE 设计，WRAP 传输

可直接迁移的语义（来自聊天链路实证）：
- 一个回复批次一个稳定 `deliveryId`：`social-engine.js:297` 由 `sha256([key,target.self_id,throughId])` 生成；DSH 侧再次用 `job.id`（`proactive-engine.js:91`）。
- 提交前先落盘再发：`hook-onebot.mjs:183-185`（`dispatching` 后 `put` 再 POST）。
- 同 ID 重试只查回执/返回已确认：`hook-onebot.mjs:166-168`（`reused:true`）。
- 明确拒绝与不确定分离：HTTP 400/401/403/409/429 → `rejected`；网络/超时 → `unconfirmed`（`:193-200,223-224`）。
- 未确认不冒充送达，也不无限重发：`social-engine.js:402-406`；`docs/TEXT_DELIVERY.md:11`。

不可迁移的部分（朋友圈必须重写）：
- 回执来源是微信数据库：`hook-onebot.mjs:206-218` 用 `localType`、`localId`、`createTime`、`serverId`、`fullText` 精确匹配。朋友圈没有等价的“数据库消息行”，也不存在 `serverId`。
- 匹配基线依赖“发送前已有 localId 集合”（`:182`）和 30 秒时钟偏差假设（`:209`）。
- 因此推荐：**沿用状态机与 ID 规则，替换回执探测器**（例如朋友圈列表接口返回的新 feed id / 服务端 id）；在拿到稳定的服务端回执前，状态必须停在 `unconfirmed`，不得自动重发。

### 1.3 `hook-onebot.mjs` 发送/回执 — WRAP（只借用外壳）

`send()`（`:155-226`）里的 `/SendTextMsg`（`:192`）、`resolveTarget()`（`:142-149`）、`X-WeChatAgent-Account`（`:105-111`）、`assertProactive()`（`:227-240`）全部是聊天专用。**结论：状态机壳可参考，代码不可直接调用**。

## 2. 消息与会话层

### 2.1 `message-buffer.js` — REIMPLEMENT

理由（逐条对应聊天语义）：
- 行模型包含 `kind/sender_id/conversation_name/direct_mention/processed`（`:69-77`），朋友圈发布没有“发送者/未读/direct mention”。
- `pendingReplies` 按会话键保存“已生成待发送回复”（`:97-103`），并绑定 `throughId` 处理边界（`:122-130`）——这是聊天“回复到哪条消息”的概念。
- `mediaReplies` 是表情投递专用队列（`:54-62`），朋友圈需要的是“发布附件”，语义不同。
- 唯一值得照抄的是**持久化手法**：临时文件 + rename、0600、加载时全量 schema 校验（`:33-63,146-152`）。

### 2.2 `social-engine.js` — REJECT（可借用 `replyCooldown` 公式）

不可复用的核心原因：
- `receive()` 的入站/重复/直呼判定依赖 `message_id`、`sender_id`、`@`、唤醒词（`:125-139`；`isDirectMention` `:38-44`）。
- `#run()` 的提示词、图片、表情候选、搜索、行为变更过滤、`RESPOND/SILENT` 解析全部面向“回复某条聊天消息”（`:151-310`）。
- 投递以“回复分段”为单位（`:329-410`），朋友圈发布没有“分段回复”（最多是多图 + 正文）。
- 可迁移的只有 `replyCooldown()`（`:75-84`）：三档限额（间隔/分钟/十分钟）是通用发布频率控制。

### 2.3 `proactive-engine.js` — 仅作“自主决策”参考

任务特别要求：**主动聊天只能作为朋友圈自主决策的参考**。证据与边界：
- 调度输入是聊天白名单：`tick()` 用 `wechat.whitelist.private/groups` 生成 key（`proactive-engine.js:68`），`eligible()` 检查缓冲最近消息、未读、待发回复、空闲分钟数、被明确拒绝（`:51-56`）。朋友圈决策需要的输入是“自己的时间/意图/素材/近期已发布内容”，不是“某会话是否安静”。
- 生成提示词明确写“本机定时安排的一次主动发言机会，不是好友的新消息”（`buildProactivePrompt` `:18-34`），并带聊天历史与来源摘要；这套“避免伪造新消息”的约束可以借用到朋友圈（避免把定时发布伪装成互动），但历史/上下文必须换成朋友圈自己的数据。
- 执行与发送完全绑定聊天：`send(job.message, job.text, {deliveryId,source:'proactive',contextId})`（`:129`），`assertProactive()` 又在发送端复核聊天白名单/时间窗/空闲/快照（`hook-onebot.mjs:227-240`）。朋友圈没有“空闲判定”，也不存在“向聊天发送”的动作。
- **可借鉴的设计点**（作为朋友圈自主决策的参考）：一次机会只调用一次模型（`:111`）、模型可决定沉默（`:113`）、草稿过期 10 分钟不补发（`:91,77`）、发送前二次复核（`:123-126`）、执行锁（`:79`）、持久化历史去重（`:137`）、取消草稿留下本机状态说明（`:57`）。
- **不可直接复用**：调度条件（聊天空闲/未读）、提示词（聊天历史/`SILENT`）、发送通道（聊天适配器）、记录模型（`wechat:*` key）。

### 2.4 `proactive-policy.js` — REUSE（纯函数）

`validateProactiveSettings()`（`:6-17`）、`withinProactiveWindow()`（`:25-28`，手写北京时区 `now+8h`）、`nextProactiveAt()`（`:29-34`，含跨午夜回退）、`conversationSnapshot()`（`:35`）都是纯函数、无平台字段。朋友圈可复用时间窗与抖动算法；`proactivePolicy()`（`:18-22`）里的 `chats` 白名单结构需换成朋友圈发布目标/scope。

### 2.5 `decision-format.js` — REIMPLEMENT

- `RESPOND:`/`SILENT`/`[STICKER:..]` 是“聊天回复协议”（`:7-9,29-93`），朋友圈发布没有“回复某条消息”，也没有向聊天发表情编号的动作。
- 但其中两项可迁移：`hasReasoningControl()`（`:11-13`，拒绝把内部思考当正文）与 `outsideCodeLines()` 的协议标记清理思路（`:17-35`）；以及 `resolveSocialDecision()` 的“格式校验失败最多一次校正”模式（`:95-116`）。
- 朋友圈应定义自己的决策格式（例如 `{"publish":true,"text":...,"media":[...]}`），不要复用 `RESPOND` 前缀，否则会和聊天链路混淆。

## 3. 图片与媒体

### 3.1 `image-input.mjs` — WRAP

- 入模流程：校验 4 张/64 hex → 读 `state/wechat-io-config.json` → 要求 reader 是 `127.0.0.1` → `GET /api/v1/images/{id}` 带 Bearer → 校验 `imageId/conversationKey/mime/b64/sha256` → `attachments.saveImage`（`image-input.mjs:6-55`）。
- 这套“引用而不是路径/密钥 + 完整性校验 + DSH 原生附件 + 轮次后卸载”的**设计**可完整复用到朋友圈素材（`offloadCompletedImages` `:57-79`），但数据源要换成朋友圈图片服务；`conversationKey` 概念要换成“朋友圈发布 scope”。

### 3.2 `reader-api.py` 图片登记/解析 — WRAP

- `register_image()`（`:429-451`）的价值是：用 `sha256([own_wxid,talker,rawid])` 生成不可猜测 ID、索引截断到 1000、删除过期缓存；`resolve_image()`（`:453-515`）的价值是：会话授权检查、`account` 匹配、跨进程解码（`scripts/resolve-wechat-image.py`）、11 秒限时、最多 4 个并发、`IMAGE_*` 错误码。
- 但“定位原始图片消息”完全依赖微信数据库（`image_row()` `:404-427` 用 `Msg_<md5(talker)>` 表 + localId/createTime/serverId）。朋友圈素材不在消息库，需另写来源解析。

### 3.3 表情池 — REJECT（跨场景共享），仅可参考评选设计

任务特别要求：**聊天私密图片池不可直接共享**。证据：
- 池的准入按“聊天范围”授权：`StickerCollection.allowed()/can_collect()` 读取 `config/wechatagent.json` 的白名单（`wechat_sticker_collection.py:72-83`）；`register_image()` 只在 `image_talker_allowed()` 为真时登记（`reader-api.py:429-431`）。
- 素材来源于私聊/群聊收到的表情（`reader-api.py:444-450`），本身是第三方用户内容；`sticker_source()` 发送前还校验“当前会话 == 来源会话且来源仍被允许”（`:579-594`）。
- 共享池的边界是“同一微信账号的已允许好友和群聊”（`docs/STICKER_COLLECTION.md:3`），即**私域内共享**；把它扩到朋友圈（对外可见）会改变可见范围，违反“来源权限”前提（`:22` 明确“来源聊天被移出允许范围后不再用于共享”）。
- 评选机制（`sticker-pool-review.mjs`）：DS 模型只看预览+标签+使用次数，不看聊天原文/群名/昵称/CDN 凭据（`:42`），且独立审计 session（`:45-46`）。这个“模型评审 + 独立性证明”的设计值得借鉴，但**必须为朋友圈建立独立素材池与独立同意流程**，不能复用聊天池内容。
- 结论：**REJECT 跨场景共享**；如果朋友圈要发表情素材，应新建 `moments-media` 池，来源仅限用户显式选择的本地文件/已授权素材，并单独做发布前确认。

## 4. 人格、会话与权限

### 4.1 `local-policy.mjs` — REUSE

`localPersona()` 从 `state/bridge-config.json` 读人格（`:7-14`）；`assertLocalPersona()` 让请求中的 `persona` 只做一致性校验（`:16-18`）。这与“聊天/朋友圈不能改人格”一致，可直接复用；朋友圈需要新增“发布内容不能修改配置”的同类断言（这部分聊天侧由 `chat-policy.js:5-9` 实现，逻辑可移植）。

### 4.2 `native-context.mjs` 会话生命周期 — REUSE（需扩展键空间）

- `sidFor(key, generation, scope)` 纯哈希（`:29`）、`agentFor()` 的创建/恢复/归档换代/仅一种恢复错误白名单（`:229-286`）都与聊天内容无关。
- 但 `KEY` 正则只接受 `^(qq|wechat):(private|group):…`（`:28`），`sessionGroups`/`dshAccess`/`contextPolicy`/`proactivePolicy` 全部用同一键空间；朋友圈需要新键类型（如 `moments:feed`）并逐一放宽校验。
- 建议：REUSE 代码结构与 `statePath` 分账号逻辑（`:104`），但**不要**把朋友圈会话混进 `dsh-sessions.json` 的 `conversations` 映射，以免聊天归档/换代逻辑误伤。

### 4.3 `session-groups.mjs` — REUSE

只依赖 `ctx.get('workspaceRegistry')` 的 list/get/create（`:12-18`）与路径合法性检查（`:42-52`），没有微信字段。可直接复用为“朋友圈内容分组/工作区”。

### 4.4 `dsh-access.mjs` — REUSE（扩展键空间）

- 能力分配模型（技能/工具白名单、`reserved` 与 `controlTool` 拒绝表、按聊天读取策略）与平台无关（`:4-8,15-34`）。
- 但 `readPolicy()` 固定读 `config/wechatagent.json` 的 `wechat.dshAccess`（`:8`），`conversationAccess()` 的 `KEY` 只接受 `wechat:(private\|group)`（`conversation-policy.mjs:1`）。朋友圈复用需新增配置节与键类型，且默认拒绝（保持 fail-closed）。

### 4.5 `prompt-context.mjs` — REUSE（管道），内容需换

- `syncInstructionSlot()`（`:119-135`）、`migrateChatContext()`（`:87-114`）、`dedupePreviousReply()`（`:53-74`）是 DSH 会话表面操作，通用。
- 但 `SOCIAL_PROTOCOL_NOTICE`/`CHAT_MESSAGE_LAYOUT_NOTICE`（`:7-9`）是聊天回复规则，朋友圈必须换成“发布内容规则”，不能沿用 `RESPOND:`。

### 4.6 `context-policy.mjs` + `core/context-maintenance.js` — REUSE

- 阈值校验（4000–2000000 token、空闲 15–3600 秒，`context-policy.mjs:7-14`）、`contextRowsIdle()`（`:26-31`）、`contextBufferVersion()`（`:25`）与聊天无强绑定。
- `ContextMaintenance.tick()` 用 `wechat.whitelist` 枚举会话（`context-maintenance.js:17`），朋友圈需换枚举源。

## 5. 其他

| 模块 | 决策 | 证据/理由 |
| --- | --- | --- |
| `role-card.js`（人格 MD 分节） | **REUSE** | `parseRoleSections/selectRoleText` 与平台无关（`:43-75`），朋友圈人格可复用同一 MD 格式 |
| `safe-fetch.js` | **REUSE** | SSRF 防护纯网络层（`:68-120`） |
| `hook-onebot.mjs` 的 `onebotId()`/`conversationId()` | **REUSE** | 只是稳定数字 ID 派生（`:15-22`），可用于朋友圈内好友/评论者 ID 映射 |
| `wechat-account-check.mjs` + `reader-account-state.mjs` | **REUSE** | 账号身份校验与按账号隔离（`:11-21`；`reader-account-state.mjs:66-130`），朋友圈也应做到“一个微信账号一套发布状态” |
| `core/session-router.mjs` | **REJECT** | 无任何 import（`git grep -n session-router` 仅命中 release-profile 哈希表） |
| `packages/extension-runtime/*` | **REJECT** | `native-context.mjs:116` `extensions(){return null}`，公开构建运行时不可达 |
| 原生 Hook 发送 | **REJECT（朋友圈发布）** | 只有 `/SendTextMsg`、`/SendStickerMsg`（`wechatagent_hook.cpp:174-245`），没有朋友圈发布接口；许可未确认（`components.json:45`）；聊天发送语义（wxid 目标、数据库回执）不可直接用于朋友圈 |
| `core/media-outbox.js` | **REIMPLEMENT** | 队列/退避/回执检查结构可参考（`:4-87`），但“表情”语义与朋友圈图片发布不同，且依赖 `stickerId` |

## 6. 三条硬性禁止（供下游实现直接引用）

1. **主动聊天只能作为朋友圈自主决策的参考**：可借鉴“一次机会一次模型调用/可沉默/前置条件复核/草稿过期/持久化去重”，但不得复用其聊天白名单、聊天历史提示词、`SILENT` 协议与聊天发送通道（证据见 §2.3）。
2. **聊天发送语义不可直接用于朋友圈**：`RESPOND:`/分段回复/回复配额/`SendTextMsg`/微信数据库回执都是“对某聊天的一条回复”，朋友圈发布是“对可见范围的一次发布”，两者的目标、回执与撤销语义均不同（§1.3、§2.2、§5）。
3. **聊天私密图片池不可直接共享**：表情池按来源聊天授权、来源可被撤销、内容来自第三方聊天（§3.3）；跨到朋友圈等于把私域素材公开发布，必须新建独立素材池与显式同意流程。

## 7. 落地建议（供 Phase 1 设计输入）

- 新建 `moments/` 命名空间：独立 `sessionId` 前缀、独立 `state/moments-*`、独立 delivery 目录、独立媒体池。
- 优先复用：`TextDeliveryStore`、`proactive-policy` 纯函数、`safe-fetch`、`session-groups`、`local-policy`、`prompt-context` 槽位、`context-policy`、账号隔离状态机。
- 明确重写：发布决策格式、发布传输与回执、朋友圈内容采集、素材池、发布频率限制（可借 `replyCooldown` 公式）。
- 明确拒绝：聊天 `SocialEngine`、`message-buffer` 行模型、`session-router`、`extension-runtime`、原生 Hook 发送通道（直到许可与朋友圈接口都具备）。
