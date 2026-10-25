# 架构复核：聊天消息链路逐层证据

审计基线：提交 `0e76902a66c7bde6a3f78335284cea7f9be6e1b1`（`sourcepro5/WeChatAgent`，`Release WeChatAgent 0.3.9`，2026-10-20）｜审计日期 2026-10-20｜审计方法：按进程边界逐层阅读入口函数与调用点，行号来自 `grep -n`/`read` 实测；结论只覆盖源码可证部分，真实登录/发送未运行验证。

## 0. 进程拓扑与端口

`scripts/manage.ps1` 依次拉起 4 个常驻进程并做健康检查：

| 进程 | 入口 | 绑定地址/端口 | 证据 |
| --- | --- | --- | --- |
| NT 数据库读取器 | `scripts/reader-api.py`（Python） | `127.0.0.1:5031`（`ports.weflow`） | `manage.ps1:201-202`；`reader-api.py:845-848` 强制 `('127.0.0.1', port)` |
| 社交 Bridge | `components/qq-bridge/src/social-bridge.js`（Node） | 反向 WS `127.0.0.1:11229`（`ports.onebot`） | `manage.ps1:236-237`；`social-bridge.js:39,96` |
| OneBot 适配器 | `scripts/hook-onebot.mjs`（Node） | 状态页 `127.0.0.1:8766`（`ports.adapter`） | `manage.ps1:240-241`；`hook-onebot.mjs:514` |
| DSH 插件 RPC | `packages/dsh-social-bridge-plugin/native-context.mjs`（在 DSH 进程内） | `127.0.0.1:11230`（`ports.dshPlugin`） | `manage.ps1:218-235`；`native-context.mjs:101,597` |
| 原生 Hook | `state/hook/native/version.dll` 注入 WeChat 进程 | `127.0.0.1:30001`（`hook.baseUrl`） | `config/wechatagent.example.json:10`；`http_server.cpp:22` |

端口约束在配置校验期强制：`project-config.mjs:48-50` 要求 4 个服务端口互异且 1024-65535，`project-config.mjs:45-46` 要求 Hook 端口不得与项目端口重复。

```text
微信客户端(4.1.10.27)
  └─ version.dll (覆盖层) ── HTTP 127.0.0.1:30001 (Bearer native-token)
        ├─ /WeChatAgent/health, /SendTextMsg, /SendStickerMsg
        └─ Scripts/native-hook/wechatagent_hook.cpp:151-245

reader-api.py (127.0.0.1:5031, Bearer reader_token)
  ├─ SSE /api/v1/push/messages ──► hook-onebot.mjs receiveSse()
  ├─ GET /api/v1/messages (回执轮询)
  └─ GET /api/v1/images/{id}, /api/v1/stickers/*

hook-onebot.mjs (127.0.0.1:8766)
  └─ WebSocket 客户端 ──► social-bridge.js ReverseOneBotServer(127.0.0.1:11229)

social-bridge.js: SocialEngine → DshPluginClient
  └─ HTTP 127.0.0.1:11230 /followup (Bearer social-dsh-token)
        └─ DSH Agent session（preset wechat-social，provider/model 来自 cordis.patch.yml）

回程：模型文本 → parseSocialDecision → adapter.sendText
  └─ WS action send_private_msg/send_group_msg → hook-onebot.action()
        └─ /SendTextMsg（Bearer + X-WeChatAgent-Account）→ 微信 → 数据库回执
```

## 1. 入站第 1 层：数据库读取器（Python，唯一读微信数据的地方）

- 配置来源：`Reader.__init__` 读取 `state/weflow/WeFlow-config.json`，`local_secret()` 用 Windows DPAPI 解 `userdpapi:` 前缀凭据（`reader-api.py:88-110`），再用 `nt.verify_passphrase_native` 验证数据库口令（`:176-178`）。
- 入站事件构造：`push_payload()`（`:124-161`）按 `localType` 过滤（`:128-130`），只保留 `1/3/47/49/PAT/转发/引用`；`sender` 与自身 `wxid` 相同则丢弃（`:136`）；对 49 类消息先解析转发记录/引用回复，两者都无内容则丢弃（`:138-142`）；`rawid` 由 `sha256([talker,serverId,localId,createTime])` 生成（`:147-148`），作为后续去重键。
- 推送：`GET /api/v1/push/messages` 以 chunked `text/event-stream` 输出，每 2 秒心跳（`:880-903`）；入站事件进入 `queue.Queue(maxsize=500)`，满则阻塞读取线程（`client.put` 在 poll 侧），形成背压而非丢消息。
- 认证：所有 GET 要求 `Authorization: Bearer` 或 `access_token` 查询参数，`hmac.compare_digest` 比较（`:874-877`）；POST 只认 Header（`:948-951`）。日志函数被置空以避免 URL 里的令牌落日志（`:860-861`）。
- 图片登记：`register_image()`（`:429-451`）为白名单聊天登记 `image_id = sha256([own_wxid,talker,rawid])`，索引最多保留最近 1000 条并删除过期缓存文件（`:436-440`）。表情（localType 47）额外进入表情池 `remember()`（`:444-450`）。
- 失败行为：初始化失败时 stderr 输出错误码并 `sys.exit(1)`（`:1050-1052`）；HTTP 处理异常对图片返回 `IMAGE_*` 具体码，其他只返回异常类型名（`:943-945`）。

## 2. 入站第 2 层：OneBot 适配器（hook-onebot.mjs）

- SSE 消费者 `receiveSse()`（`hook-onebot.mjs:474-501`）：35 秒看门狗 AbortController（`:477,487`），单条缓冲上限 256000 字符（`:489`），断线 1.5 秒重连（`:499`）。
- 事件过滤 `incoming()`（`:401-429`）：只接受 `event==='message.new'` 与 7 种 `type`（`:403`）；拍一拍必须是 `pat.target==self` 且 `pat.actor==talkerId`（`:408`）；群消息按 `project.account.nicknames` 文本匹配补 `at` segment（`:422`）。
- 去重：`seen` Map 记录 `message_id`，最多 5000 条（`:432-435`）；队列上限 200（`:433`）。
- 白名单二次过滤：`flush()` 在转发前重新 `reload()` 并 `allowed()` 检查（`:438-447`），防止配置在缓冲期间变更。
- 生命周期：`connectOneBot()` 循环重连（`:449-473`），HTTP 状态页只监听 `127.0.0.1`（`:514`）；`stop()` 取消 SSE controller、关 WS、关 HTTP（`:528-534`）。
- 输入信任：`textSegments()`（`:46-56`）只接受 `type==='text'`，拒绝 CQ 码原始字符串（`TEXT_SEGMENTS_REQUIRED`）与超过 16000 字节的文本。

## 3. 入站第 3 层：Bridge 反向 WebSocket 与消息缓冲

- `ReverseOneBotServer.start()`（`reverse-ws-server.js:27-98`）：非回环监听必须配置令牌（`:29-31`）；升级请求校验 path、Upgrade、`Sec-WebSocket-Version: 13`、单连接（`:36-44`）；有令牌时用 `crypto.timingSafeEqual`（`:38-42`）；帧必须 masked，单帧上限 1 MiB（`:6,57-65`）。
- `WechatOneBotAdapter.#receive()`（`wechat-onebot-adapter.js:32-48`）：`meta_event` 更新 `selfId`；只接受 `text/image` 类型；`sender_id===selfId` 或 `user_id===selfId` 直接丢弃（`:42`）；`recentOutgoing` 指纹 60 秒防回声（`:43`）；`message_id+fingerprint` 防重（`:44-46`）。
- `social-bridge.js` 组装：白名单集合（`:20-21`），空白名单只告警不放行（`:26`），`onMessage` 中 group/private 分表校验（`:75-84`），未命中记 `denied` 并返回。
- 落缓冲：`MessageBuffer.append()`（`message-buffer.js:66-89`）生成 `id=crypto.randomUUID()`，`text` 截 4000 字符，`images` 只收 64 位 hex id 且最多 4 张；`findIncoming()` 以 `message_id+sender_id+text` 去重（`:91-96`）；整文件原子写（`.tmp` + rename，`mode 0o600`，`:146-152`）。

## 4. 决策层：SocialEngine 批处理与限流

- 入口 `SocialEngine.receive()`（`social-engine.js:125-139`）：重复检查 → `direct = private || pat || isDirectMention()`（`:129`，mention 规则见 `:38-44`：引用本账号也算）→ 群聊 `mention` 模式下非 direct 不处理（`:132`）→ direct 立即跑，非 direct 等 `batchMs`(3000) 合批（`:136-138`）。
- 单会话串行：`#run` 以 `this.running` Set 保证同一会话只有一个决策在飞（`:151-153`），完成后若期间有新消息则重新排队（`:317-326`）。
- 输入上限：未读最多 20 行、图片最多 4 张、prompt 文本累计 12000 字符（`:163-169`）。
- 行为变更阻断：`chatRows = rows.filter(row => !isBehaviorChangeCommand(row.text))`（`:182`），规则在 `chat-policy.js:5-9`，命中者不进入本批模型输入并记 `behavior_change_blocked`。
- 频率限制：`replyCooldown()`（`:75-84`）同时计算 `reply_interval`、`minute_quota`、`ten_minute_quota`，私聊间隔默认 1000 ms、群聊 15000 ms、每分钟 3 条、每 10 分钟 10 条（`social-bridge.js:48-52`）。
- 上下文：`buildSocialPrompt`/`buildPrivatePrompt`（`:53-73`）把聊天原文包进 `<untrusted_chat>`，并附加拍一拍、转发、引用说明（`:26-36`）；只带一条上一条 AI 回复作接话参考（`:46-51,216`）。
- 元数据 `batchId`：`sha256([key,rowids,policyKey,searchKey,stickerChoices,decisionImages,knownLabels,noticeId,'dsh-native-only-v1',wakeMode,'output-format-v2'])`（`:248`），用于 DSH 侧结果缓存与重放。
- 决策解析：`resolveSocialDecision()`（`decision-format.js:95-116`）先 `splitStickerLabels()` 去掉标签行，失败时最多一次“格式校正”模型调用（`:99-114`），校正用 `batchId + '\0format-repair-v4'` 派生新 ID 以避免缓存污染（`:103`）。

## 5. 模型层：DSH 插件 RPC（native-context.mjs）

- 启动：`apply(ctx, config)`（`:93`）读取 `state/social-dsh-token.txt`（`:99-100`），校验 provider/model/端口/宿主均为本机（`:103`），HTTP 服务只监听 `host=127.0.0.1`（`:101,597`）。
- 认证：每个请求用 `crypto.timingSafeEqual` 比较 Bearer（`:478-479`）；HTTP 方法+路径白名单（`:509`）。
- 请求解析：POST body 上限 65536（`:514`），`conversationKey` 必须匹配 `KEY` 正则（`:28,516`），`message` ≤18000。
- 会话映射：`sidFor()` 生成 `social-<sha256(scope?key)[:32]>`（`:29`），账号切换时 scope 变化（`:95-98`）→ 强制重建会话；映射持久化在 `state/accounts/<id>/dsh-sessions.json` 或 DSH home（`:104`），原子写 0600（`:131-135`）。
- 会话创建/恢复：`agentFor()`（`:229-286`）要求 preset 精确为 `wechat-social`（`:230-231`），归档则换代（`:236-247`），否则 `agents.resume` 或 `agents.create`，`setup` 里再次 `agentPresets.mount` 校验（`:250-254`）；仅 `system/message requires a protected first surface head` 一种错误允许换会话（`:263-268`）。
- 人格注入：`configure()`（`:342-382`）从 `state/bridge-config.json` 读本机人格快照（`local-policy.mjs:7-14`），请求里的人格字段只做一致性校验，不一致抛 `BEHAVIOR_CHANGE_NOT_ALLOWED`（`local-policy.mjs:16-18`）→ HTTP 403（`:591`）；`reconcilePersona()` 用 `surfaceOp:'replace'` 只保留一份有效初始化（`:57-74`）。
- 上下文装配：`agent/pre-step` 瀑布在原生压缩之后（`:401-415`）注入初始化（`:413`）、搜索证据（`:411`）、扩展说明槽位（`:396`）；`agent/request` 处理单步重试与搜索预算（`:418-444`）。
- 回合生命周期：`pending` Map + 120 s 定时器（`:566`），`turn/end` 取最后一次 assistant 文本（`:445-474`，`assistantReplyText()` 拒绝带 tool call 的消息，`:35-39`），超时取消原生轮次并卸载图片（`:554-565`）。
- 失败语义：`account_changed` 409（`:481`）、`session_busy`（`:522`）、`turn_timeout` → 502（`:468,590`）、行为变更 403（`:591`）。

## 6. 出站：决策 → 文字投递 → 原生发送 → 回执

1. `SocialEngine.#run` 把决策写成 `pending`（`social-engine.js:295-305`），`replyDeliveryParts()` 把多段文字拆成最多 3 个 part，每个 part 有独立 `deliveryId`（`message-buffer.js:7-11`）。
2. `#deliverReply()`（`social-engine.js:329-410`）逐段提交：先检查队列中残留协议标记（`:342-345`），`stickerId` 交给 `MediaOutbox`（`:353-356`），文字走 `this.send()`，15 秒超时（`:367`）。
3. `WechatOneBotAdapter.sendText()`（`wechat-onebot-adapter.js:52-76`）拒绝非数字/非安全整数目标（`:56-58`），把 `wechatagent_delivery_id`、主动聊天来源放进 OneBot 参数（`:61-62`），只有收到 `result.data.receipt==='wechat-server-id'` 才返回 `delivered:'database-confirmed'`（`:72-75`）。
4. `hook-onebot.action()`（`hook-onebot.mjs:346-400`）校验参数（delivery id 64 hex、receipt-only/abandon/deadline 组合，`:359-368`），`send()`（`:155-226`）：
   - `checkNative()` 复核版本/账号/回执能力（`:113-128`）；
   - `resolveTarget()` 用读取器 `/api/v1/sessions` 把合成数字 ID 映射回 wxid（`:142-149`）；
   - `TextDeliveryStore.key()` 由 `sha256([kind,target,deliveryId||'legacy:'+sha256(text)])` 生成（`:162`；`text-delivery-store.mjs:11`）；
   - `baseline` 保存发送前已有的 localId 列表（`:182`）；
   - 发送前先落盘 `dispatching`（`:185`），再 POST `/SendTextMsg`（`:192`）；
   - 回执循环每 400 ms 拉 `/api/v1/messages?talker=...&limit=100`，条件：`isSend`、`localType∈{1,undefined}`、`localId` 不在 baseline、`createTime>=startedAt/1000-30`、文本完全一致（`:206-212`）；命中后要求 `serverId>0` 才记 `confirmed`（`:214-218`）；
   - 18 秒无回执 → `unconfirmed` 并抛 `TEXT_DELIVERY_UNCONFIRMED`（`:223-224`），不自动重发。
5. 已确认结果复用：`attempt.state==='confirmed'` 且有 deliveryId 或 60 秒内 → 直接返回 `{...response,reused:true}`，不再调用原生发送（`:166-168`）。
6. 拒绝语义：HTTP 400/401/403/409/429 视为未提交的确定性拒绝并落盘 `rejected`（`:193-197`）；`ret!==0` 记 `NATIVE_SEND_REJECTED`（`:201`）。

## 7. 失败行为汇总（源码可证）

| 场景 | 行为 | 证据 |
| --- | --- | --- |
| 发送端忙（同一目标/并发>4） | 抛 `SENDER_BUSY`，Bridge 指数退避重试（500 ms×2^n，上限 5 s，最多 6 次，30 s 截止） | `social-engine.js:101-102,374-380`；`hook-onebot.mjs:157` |
| 原生 HTTP 响应丢失 | 记 `unconfirmed`，不重发，后续以“未确认接话参考”出现在提示词 | `hook-onebot.mjs:198-199,223`；`social-engine.js:369-373` |
| 回执超时 | 文字直接 `unconfirmed`；表情最多核对 2 次后终结 | `social-engine.js:402-406` |
| 状态文件损坏 | 拒绝新的提交（`TEXT_DELIVERY_STATE_INVALID`），不靠清空记录重发 | `text-delivery-store.mjs:15-18`；`hook-onebot.mjs:222` |
| 模型输出无协议 | 一次格式校正；仍失败抛 `INVALID_DECISION_FORMAT`，未读消息保留 | `decision-format.js:95-116`；`social-engine.js:286` |
| DSH 回合超时 | 取消原生回合、卸载图片、返回 502 | `native-context.mjs:554-566,590` |
| 账号切换 | 插件返回 409 `ACCOUNT_SWITCH_REQUIRES_DSH_RESTART`，Bridge 发送前逐次核对账号 | `native-context.mjs:481`；`hook-onebot.mjs:160-164` |

## 8. 生命周期与恢复

- Bridge 每 30 秒对未处理缓冲重放（`social-bridge.js:97-99`）；主动聊天每 60 秒 tick（`:100`）；上下文维护每 30 秒（`:101`）。
- 待发回复持久化在 `state/social-messages.json` 的 `pendingReplies`；重启后 `SocialEngine` 构造时恢复未完成决策并做合法性校验（`social-engine.js:103-106`；`message-buffer.js:40-49`）。
- 收尾：`stop()` 依次清定时器、停媒体队列、停适配器（`social-bridge.js:102-104`；`social-engine.js:426`）。
- 会话归档：DSH 侧检测 `workspaceRegistry.archivedSessionIds` 后换代（`native-context.mjs:233-247`）。

## 9. 是否稳定公开接口（结论）

上游没有发布任何 API 契约文档或版本化接口，社交链路整体是**内部实现**：

- 对 DSH 的接口只有 `GET /health` 与 `POST /followup`、`/configure`、`/compact`、`/context-maintenance`（`native-context.mjs:476-509`），版本信息仅靠 health 里的标记字符串（`:480`）表达，属于“载荷级版本探测”而非 schema 版本。
- 对微信侧只通过 `version.dll` 自定义路由通信（`wechatagent_hook.cpp:151-253`），没有任何上游稳定性承诺，且依赖微信内部偏移（`offset::send_message` 等，`:38-41`）。
- 因此本项目复用这些能力时必须自行封装边界（见 `REUSE_DECISIONS.md`），不能把它们当稳定依赖直接调用。

## 10. 逐层接口契约表（任务要求维度）

| 层 | 模块/入口 | 输入 | 输出 | 认证 | 失败行为 | 生命周期 | 稳定公开接口？ |
| --- | --- | --- | --- | --- | --- | --- | --- |
| L0 微信客户端 | 外部程序 + `version.dll` 代理 | 注入后的进程内调用 | Hook HTTP | 无（进程内） | DLL 加载失败 → 客户端无发送能力 | 随微信进程 | 否 |
| L1 Hook HTTP | `RegisterWeChatAgentRoutes()`（`wechatagent_hook.cpp:151`） | JSON：`wxidorgid`、`msg`/`sticker` | `{ret,retmsg}` | `Bearer native-token`（64 hex） | 401/409（版本/账号不符）/429（忙）/400（参数） | 进程内 HTTP 线程；`HttpServer::Start` 失败即不可用（`http_server.cpp:22-31`） | 否，本项目自定义路由 |
| L2 数据库读取 | `reader-api.py` `Reader` + `serve()`（`:856`） | 数据库路径、`decryptKey`、白名单 | JSON/SSE | `Bearer reader_token` 或 `access_token` 查询 | 401 / 403（会话未选）/503（`IMAGE_*` 等） | `serve_forever` + poll 线程；退出清理（`:1028-1037`） | 否，内部 API |
| L3 适配器 | `hook-onebot.mjs` `HookOneBot`（`:58`） | SSE 事件、OneBot action | OneBot v11 响应；WS 事件流 | 无（回环）；令牌用于 Hook 调用 | `AdapterError` 码；`retcode:1407`；队列满 `EVENT_QUEUE_FULL` | `start()` 起 2 个循环任务 + 5 s 健康定时器；`stop()` 全部取消（`:528-534`） | 否 |
| L4 Bridge | `social-bridge.js`（`main` 顶层） | `bridge-config.json` + WS 消息 | WS action 响应、`social-messages.json` | 可选 `SOCIAL_ONEBOT_TOKEN`（默认空） | 白名单外记 `denied`；入站异常记 `inbound error` | 常驻进程；3 个 `setInterval`（30 s/60 s/30 s）；信号量收尾（`:97-104`） | 否 |
| L5 决策引擎 | `SocialEngine`（`social-engine.js:87`） | `message` 对象 + 配置 | 决策结果 + 待发回复 | 无（进程内） | 冷却等待、`INVALID_DECISION_FORMAT`、`SENDER_BUSY` 重试、`unconfirmed` | 每会话 running/timers；`stop()` 清全部定时器（`:426`） | 否 |
| L6 模型 RPC | `DshPluginClient`（`plugin-client.js:3`） | `conversationKey`、prompt、metadata | `{text,sessionId}` 或错误 | `Bearer social-dsh-token` | 125 s 超时（图片 +80 s）、`agent_unavailable`、`session_busy` 重试 | 每请求 fetch；DSH 侧 `pending` Map + 120 s 定时器 | 否（仅 health 标记） |
| L7 DSH 会话 | `native-context.mjs` `apply()`（`:93`） | `/followup`、`/configure`、`/compact`、`/context-maintenance` | JSON | `timingSafeEqual` Bearer | 400（非法 key/message 过大）/403（行为变更）/409（账号变化）/502（回合失败）/503 | 插件生命周期 `ctx.effect` 释放（`:598-607`）；会话持久化 `dsh-sessions.json` | 否，内部契约 |
| L8 人格与提示 | `prompt-context.mjs` + `local-policy.mjs` | `state/bridge-config.json`、配置 | `messages` 注入 surface | 本机文件即权限 | `LOCAL_PERSONA_CONFIG_REQUIRED`、403 | 每次 `configure`/`pre-step` 重建 | 否 |
| L9 投递 | `TextDeliveryStore` + `send()`（`hook-onebot.mjs:155`） | 文本/表情、`deliveryId` | `{message_id,receipt:'wechat-server-id',delivered:'database-confirmed'}` | Hook 令牌 + 账号头 | 见 §7 失败表 | 状态文件持久化，进程重启可续 | 否 |
| L10 主动聊天 | `ProactiveEngine`（`proactive-engine.js:35`） | `state/proactive/state.json` + 白名单 | 一次 `send` | 无（进程内） | 失败记 `send_pending`，过期/取消留 notice | 60 s tick；执行锁 `busy` | 否 |
| L11 控制台 | `console-server.mjs` `http.createServer`（`:352`） | 浏览器请求 | 静态页 + JSON | CSRF `X-Console-Token` + Host/Origin | 403/401/404/409/410 | 长驻；`api/quit` 关闭（`:500`） | 否（内部 UI） |

## 11. 关键数据结构（用于下游数据模型设计）

1. **入站缓冲行**（`message-buffer.js:69-77`）：
   `{id, platform, kind, conversation_id, sender_id, conversation_name, sender_name, message_id, self_id, text(≤4000), timestamp, images[{id,kind?}], direct_mention, outgoing, processed, interaction?('pat'), forwardedRecord?, quoteReply?}`；群聊额外 `sender_key`（`sha256('wechat-member:'+wxid)`，`hook-onebot.mjs:427`）。
2. **待发回复**（`message-buffer.js:97-103` + `:12-22`）：
   `{result{decision,text,textParts?,stickerId?}, throughId, message{...}, policyKey, searchKey, deliveryId(64 hex), sending, noticeId, parts[{text|stickerId, deliveryId, state, retryAt?, busyDeadline?, busyAttempts?, receiptChecks?}], deliveryNotice?}`；`parts` 最多 3 段（`:15`）。
3. **投递状态文件**（`text-delivery-store.mjs:12-20`）：
   `{version:1, key(64 hex), deliveryId, account, wxid, text(≤16000 bytes), baseline[localId], startedAt, state(dispatching|accepted|unconfirmed|rejected|confirmed), confirmedAt?, candidateId?, response?, rejection{code,at,nativeRet?,}, firstRejection?}`。
4. **主动聊天作业**（`proactive-engine.js:89-92`）：
   `{id(64 hex, sha256(key\0nextAt\0cycles)), mode(greeting|news|meme), createdAt, expiresAt(≤600000), snapshot(sha256 of last5 ids), personaDigest, evaluating, text?, message?, topicDigest?, noticeId?, dispatching?}`；每聊天历史最多 12 条（`:43,62`）。
5. **DSH 会话映射**（`native-context.mjs:119-134`）：
   `{version:2, conversations{key→sid}, profiles{key→{persona,digest,instructions,instructionsDigest,personaName,conversationName,generation,initializations,compactions,cache[≤20],context,contextAuto,workspaceId,workspacePath,previousSessions[≤20],recovery?}}}`；sid 形如 `social-<32 hex>`（`:29`）。
6. **图片索引**（`reader-api.py:193-196,432-443`）：
   `state/media/index.json` 为 `{image_id(sha256(own_wxid|talker|rawid)) → {talker,localId,serverId,createTime,localType,account,sender}}`，只保留最近 1000 条；解码结果缓存 `state/media/<id>.json`。

## 12. 调用链中值得注意的 5 个实现细节

1. **入站消息不重放历史**：Bridge 只用缓冲里的未处理行（`social-engine.js:163`），DSH 会话自带历史（`docs/DSH_SESSIONS.md:21`）。这意味着一旦缓冲被清空/损坏，模型侧仍有历史，但 Bridge 不会再补发——两份状态不同步是已知设计。
2. **`throughId` 的语义**：它标记“本批已处理到哪一行”，在失败时会保留未处理（`message-buffer.js:122-144`）；模型输出失败时 `markProcessed` 不执行（`social-engine.js:307`），所以未读消息会被重试而不是丢弃。
3. **格式修复是第二次模型调用**，不是本地修补（`decision-format.js:99-114`）；它会消耗额度，且 `docs/IMAGE_INPUT.md:35` 也承认“没有可识别决定会保留未读消息”。
4. **图片卸载是会话事件**：`image/offload` 在轮次结束后追加（`image-input.mjs:57-79`），不是删除附件；后续轮次靠 `offloaded` 标记跳过（`:63`）。
5. **主动聊天与正常回复共用每聊天锁**：`social.withConversationLock()` 在 `withConversationLock()` 内先检查 `running/timers/decisions/pendingReplies/unread`（`social-engine.js:416-424`），任一不满足直接返回 `false`，所以主动聊天不会插进正在回复的会话。
