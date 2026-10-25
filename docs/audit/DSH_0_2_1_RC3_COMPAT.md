# DSH 0.2.1-rc.3 兼容性复核报告

- 审计对象：`D:\dsh插插\dsh-moments-agent`（插件版本 **0.2.6**）
- 目标运行时：本机已安装并正在运行的 **DeepSeek Harness Desktop 0.2.1-rc.3**（`D:\dsh`，Electron 44.7.0）
- 对照基线：`D:\dsh插插\upstream\deepseek-harness` = `dsh-v0.2.1-rc.2`（commit `687f282e`，只读）
- 审计日期：2026-10-25（Asia/Shanghai）
- 执行：dsh-compat（Team Lead 子代理）；全程只读探测，未重启 DSH/微信/WeChatAgent，未卸载重装插件，未发表任何内容
- 证据目录：`docs/audit/evidence/compat-rc3/`

## 0. 结论摘要

**rc.3 与插件 0.2.6 的接口契约完全兼容：消费面 0 漂移，无 UNSUPPORTED 项，无需修改 `src/`、`desktop/`、`client/`。**
本轮在**活体 rc.3 进程**中确认：17 个 `moments_*` 工具已注册、工具守卫拒绝链路生效、独立会话**已成功恢复**、
`llm`/`wechatAgent` 健康、`typecheck`/`test`（202 pass + 1 skip）/`verify` 全绿。

唯一需要 Lead 注意的**非阻塞**问题：

| # | 问题 | 性质 | 建议 |
| --- | --- | --- | --- |
| O1 | `moments_health.dshVersion` 活体为 `null`：插件读 `process.env.DSH_DESKTOP_VERSION ?? DSH_VERSION`，但这两个变量名**在 rc.3 asar 与 rc.2 源码中都不存在** | **DRIFT（陈旧钩子，诊断级）**，不影响任何业务能力 | Lead 决定是否把 `src/plugin.ts:195` 改为 `process.env.DSH_CLIENT_VERSION`（rc.3 桌面 Host 环境确有该变量）或删掉该字段；不改也能正常工作 |
| O2 | 桌面版 Host 日志不落盘，`独立会话恢复失败` 等启动错误无法事后检索 | 观测性缺口（rc.2/rc.3 同） | 可选增强：插件写本机诊断日志 / `moments_health` 暴露独立会话状态。本次已用 DB + 投影缓存证据替代验证 |
| O3 | profile `cordis.patch.yml` 写 `publishMode: PREPARE_ONLY`，活体 `/api/health` 却是 `POLICY_AUTONOMOUS`（DB `system_settings.publish_mode` 覆盖） | 插件既有设计（DB 覆盖 config），非 rc.3 问题 | Lead 若期望"仅准备"演示，需确认 DB 里 `publish_mode` 取值 |
| O4 | `tools.restrict({allow:[17 个工具名]})` 对**未知名字会抛错**，一旦未来改工具名会让独立会话恢复失败且只落到日志 | 既有脆性（rc.2/rc.3 语义相同） | 非本轮范围；必要时在 `createDedicatedSession` 内先按已注册工具名求交并 warn |

## 1. 环境身份

| 项 | 值 | 证据 |
| --- | --- | --- |
| DSH 桌面壳 / 运行时 | `0.2.1-rc.3` / `0.2.1-rc.3`（`dshBuildCommit be72761e`） | `app.asar/package.json`、`app.asar/dsh/package.json` |
| Cordis | 4.0.5 | `app.asar/dsh/package.json` |
| Electron / 自带 Node | 44.7.0 / v24.21.0 | `D:\dsh\version`、bundled `node.exe --version` |
| PATH Node / npm | v24.14.1 / 11.11.0 | `node --version`、`npm --version` |
| 安装时间 | 2026-10-23 16:00:56（LastWriteTime） | `Get-Item D:\dsh\resources\app.asar` |
| profile 补丁条目 | `dsh-moments-agent`，`enabled: true`，dataDir `data`，admin 18766，llm `deepseek-account/deepseek-flash` | `C:\Users\10575\.dsh\profiles\desktop\cordis.patch.yml:32-77`（只读） |
| 活体 Host 条目 | `include:dsh-moments-agent`（patchId 匹配），`Config` 投影 `status:"absent"`（插件未导出 schemastery Config，自行 `parseConfig` 校验，rc.3 允许） | `cordis_inspect_query(host, Config, listConfigs, name="dsh-moments-agent")` |

详见 `evidence/compat-rc3/environment-identity.md`。

## 2. 契约矩阵（rc.3 精确契约 vs 插件用法）

状态词：`VERIFIED`＝在活体 rc.3 或源码级确认一致且可用；`DRIFT`＝仍有差异但非阻塞；`UNSUPPORTED`＝rc.3 无此能力；`UNKNOWN`＝本次未验证。
「用法」列给出插件侧位置。

### 2.1 插件装载与生命周期

| # | 能力项 | rc.3 精确契约 | 插件用法 | 状态 | 证据 |
| --- | --- | --- | --- | --- | --- |
| 1.1 | 函数插件入口 | 具名 `name/inject/apply`（可含 `Config`），**禁** default export（rc.3 `packages/AGENTS.md`） | `src/plugin.ts:34-36`、`src/index.ts` | **VERIFIED** | 活体条目激活、17 工具已注册 |
| 1.2 | `inject: ['tools']` 硬依赖 | `inject` 声明硬依赖，就绪后 apply | `src/plugin.ts:35` | **VERIFIED** | 工具已注册 → `tools` 服务已就绪 |
| 1.3 | `ctx.effect(execute, label?)` | `effect(execute: () => (() => void) \| void, label?: string): () => void`（Cordis 4.0.5） | `src/plugin.ts:97-103`（`applyEffect`） | **VERIFIED** | 契约目录 IDENTICAL；工具/guard/生命周期均经 effect 注册成功 |
| 1.4 | `ctx.timer.interval(callback, delay)` | `interval(callback: () => void, delay: number): () => void` | `src/runtime.ts`（调度 tick） | **VERIFIED（活体）** | DB `scheduler_next_at` 在本轮审计期间被刷新（12:46:06） |
| 1.5 | `ctx.logger.<level>(msg, meta?)` | Cordis logger 4 级 + 内存环形缓冲 | `src/plugin.ts:63-86` | **VERIFIED** | 契约 IDENTICAL；防御式可选调用 |
| 1.6 | `ctx.get(name)` 可选服务 | `ctx.get("svc")`，可能 undefined | `agents/agentPresets/llm/attachments` 全部经 `ctx.get` | **VERIFIED** | 与 rc.3 `packages/AGENTS.md`「可选服务用 ctx.get」一致 |

### 2.2 工具注册 / 守卫 / 权限收敛

| # | 能力项 | rc.3 精确契约 | 插件用法 | 状态 | 证据 |
| --- | --- | --- | --- | --- | --- |
| 2.1 | `ctx.tools.register(ToolDefinition)` | `ToolDefinition extends ToolSchema { output: ToolOutputDefinition; execute(args, exec: ToolRunContext): Promise<unknown>; timeoutMs?; projectContent?; finalizeContent?; isConcurrencySafe?; presentCall?; presentResult? }`；`ToolSchema { deferLoading?; name; description; parameters: Record<string,unknown> }` | `src/plugin.ts:105-114, 210-245`（`toDshTool`） | **VERIFIED（活体）** | 17 个 `moments_*` 出现在活体 `Tool.listTools` |
| 2.2 | `ToolOutputDefinition` | `{ schema: JsonSchemaNode; render(args, value): ContentBlock[]; presentationMeta?(...) }` | `src/tools/index.ts:19-29`、`renderEnvelope` | **VERIFIED（契约）/ UNKNOWN（真实渲染）** | 注册被接受即 `output` 必填项齐备；render 实际输出需模型轮次触发，本次未触发（守卫在 execute 前拒绝） |
| 2.3 | `ctx.tools.guard(ToolGuard)` | `ToolGuard = (execution: Readonly<ToolExecution>) => string \| undefined`；挂在 `tools/pre-execute` 之后；plain ctx 全局；字符串即拒绝 | `src/plugin.ts:260-282` | **VERIFIED（活体）** | 本审计 Agent 调用 `moments_health` → `POLICY_DENIED：仅独立朋友圈会话可调用此工具` |
| 2.4 | `ctx.tools.restrict(ToolRestriction)` | `{ allow?: readonly string[]; deny?: readonly string[] }`；**要求 scoped ctx**（agent.ctx）；空 filter/未知名/`run_code` 抛错 | `src/adapters/dsh/session.ts:33-38`（在 setup 内） | **VERIFIED（活体）** | `setup` 收到 agent 作用域 ctx（rc.3 `agent-loop:1931`）；resume 成功证明 restrict 未抛错 |
| 2.5 | 工具名唯一/非保留 | 同层重复名与保留 `run_code` 注册失败 | 17 个唯一 `moments_*` 名 | **VERIFIED** | `Tool.listTools` 17 个唯一名 |

### 2.3 模型（LLM）与附件

| # | 能力项 | rc.3 精确契约 | 插件用法 | 状态 | 证据 |
| --- | --- | --- | --- | --- | --- |
| 3.1 | `ctx.get('llm').stream(GenerateOptions)` | `GenerateOptions { provider; model; reasoningEffort?: ReasoningEffortId; messages: RequestMessage[]; system?; tools?; toolHistory?; temperature?; maxTokens?; stop?; signal?; sessionId?; purpose? }`；`RequestMessage = Message \| RequestUserInput` | `src/adapters/dsh/llm.ts:118-137` | **VERIFIED（活体）** | 上一次 rc.3 启动完成「选题→文案→复核→审批」（DB 04:29:07–04:29:15）；`/api/health` llm ok |
| 3.2 | `llm.listProviders()` | `@Remote listProviders(): LlmProviderInfo[]`（`{id,name}`） | `src/adapters/dsh/llm.ts:60-66` | **VERIFIED（活体）** | health `模型可用：deepseek-account/deepseek-flash` |
| 3.3 | `llm.resolveModelInfo(provider, model, signal?)` | `async resolveModelInfo(...): Promise<LlmResolvedModelInfo>`（含 `inputModalities?`） | `src/adapters/dsh/llm.ts:68-77` | **VERIFIED（活体）** | health `inputModalities:["text","image"]` |
| 3.4 | `StreamChunk` 形状 | `block-start/text-delta/reasoning-delta/tool-call-delta/block-end/usage/finish{reason:{kind,failure?}}` | `src/adapters/dsh/llm.ts:14-21,128-137` | **VERIFIED** | 类型目录 IDENTICAL |
| 3.5 | `ctx.get('attachments').saveImages(inputs)` | `async saveImages(inputs: readonly SaveImageAttachment[]): Promise<readonly ImageAttachmentRef[]>`；`SaveImageAttachment { data: Uint8Array; mediaType: ImageMediaType; name? }` | `src/adapters/dsh/llm.ts:24-26,105` | **VERIFIED（契约）/ UNKNOWN（活体实例调用）** | 类型/方法 IDENTICAL；本次未发起带图模型请求。插件对 attachments 缺失有降级（见 4.4） |
| 3.6 | `ImageMediaType` 取值 | `'image/png' \| 'image/jpeg' \| 'image/webp' \| 'image/gif'` | 插件以 `string` 声明，运行时由素材导入校验保证 | **VERIFIED** | 目录 IDENTICAL |

### 2.4 Agent / Preset / SystemPrompt

| # | 能力项 | rc.3 精确契约 | 插件用法 | 状态 | 证据 |
| --- | --- | --- | --- | --- | --- |
| 4.1 | `ctx.get('agents').create(CreateAgentOptions)` | `{ sessionId; parentAgent?; meta?: { cwd?; parentSession?; isSeeded?; origin?; delegationDepth?; agentPreset? }; inheritedEventCount?; seed?; agentOptions?: AgentOptions; signal?; setup?: AgentSetup }`；`AgentOptions { provider?; model?; reasoningEffort?; maxTokens? }` | `src/adapters/dsh/session.ts:8, 45`（首次创建分支） | **VERIFIED（契约）** | 目录 IDENTICAL；本轮走 resume 分支，create 分支未触发（代码路径不变） |
| 4.2 | `ctx.get('agents').resume(ResumeAgentOptions)` | `{ resumeSessionId; parentAgent?; agentOptions?; signal?; setup?: AgentSetup }` | `src/adapters/dsh/session.ts:9, 43-44` | **VERIFIED（活体）** | 独立会话恢复成功（见 §3） |
| 4.3 | `AgentHandle` | `{ agent: { id: SessionId }; dispose(): Promise<void> }` | `src/adapters/dsh/session.ts:13, 46-47` | **VERIFIED（活体）** | resume 返回 handle，`handle.agent.id` 已写 DB |
| 4.4 | `AgentSetup` | `(agentCtx: Context, agent: Agent) => AgentSetupCommit \| Promise<AgentSetupCommit\|void> \| void` | `SessionSetup = (context)=>void`（少参、void，结构兼容） | **VERIFIED（活体）** | setup 实际执行且未抛错（§3） |
| 4.5 | `ctx.get('agentPresets').register(PresetDefinition)` | `{ id; name?; description?; order?; plugins: readonly (EntryOptions & …)[] }` → `Promise<() => Promise<void>>` | `src/adapters/dsh/session.ts:14-15, 23-27`（`plugins: []`） | **VERIFIED（活体）** | preset `dsh-moments` 已落到会话 header 与 projcache |
| 4.6 | `ctx.get('systemPrompt').section(PromptSection)` | `{ name; order; text: string \| ((ctx: AssembleContext)=>string); interpolate?; complete? }` | `src/adapters/dsh/session.ts:34-36, 39-40` | **VERIFIED（活体）** | section 在 setup 内注册成功 |

## 3. 独立会话恢复：**VERIFIED（本轮 rc.3 启动已恢复）**

`dsh_session_id = b77442db-93cb-47a0-930d-3138e3d454a2` 的会话在本轮启动**成功恢复**，非新建。证据链：

1. **DB 决定性证据**：`moments.sqlite` 的 `system_settings.dsh_session_id.updated_at = 2026-10-25T04:29:56.084Z`（本地 12:29:56），而本轮 DSH 主进程启动于本地 **12:29:51**。插件 `src/adapters/dsh/session.ts:46` 只在 `await agents.resume(...)`/`create(...)` **成功后**才 `setSetting`；值仍是原 session id（不是新随机 UUID）→ 走 resume 且成功。（只读复制 sqlite+`-wal`+`-shm` 后用 `node:sqlite` 读取；WAL 模式下漏读 `-wal` 会看到旧值。）
2. **投影缓存**：`~\.dsh\storages\session_projcache\sessions\b77442db-….json` mtime = 12:29:56，`identity.cwd = D:\dsh插插\dsh-moments-agent\data\workspace`，`agentPreset = "dsh-moments"`，`formatVersion = 4`。
3. **会话日志**：`~\.dsh\sessions\--D-dsh~63D2~63D2-dsh-moments-agent-data-workspace--\b77442db-…\session.v4.jsonl.zstd` 解压后仅 header（`version: 4`、`agentPreset:"dsh-moments"`、`isSeeded:false`、0 事件），mtime 保持 10-20 —— 与 rc.3 resume 语义一致：只有「中断的最后一轮」才会追加 synthetic closers，本会话无事件故不追加。
4. **格式迁移**：rc.3 `dsh-session-format-catalog` 的 `currentVersion = 4`，codecs v0–v4，migrations v0→v1→v2→v3→v4；本会话 header v4 = 当前版本 → **直接读取，无需迁移**。
5. **失败日志通道**：rc.3 桌面版无持久化 Host 日志（`app.getPath('logs')` 仅 crash report 且为空；Cordis logger 只有内存环形缓冲；app-boot 的 diagnostics exporter 只收集到 `StartupError`）。因此「是否打印过 *独立会话恢复失败*」**无法事后检索（UNKNOWN）**；但第 1–3 条直接证明恢复成功，不依赖日志。

详见 `evidence/compat-rc3/dedicated-session-evidence.md`、`evidence/compat-rc3/host-log-channel.md`。

## 4. rc.2 → rc.3 契约漂移表（机器比对）

方法：两侧 `@deepseek-ai/dsh-tool-cordis` 的 `api-catalog`（由 `scripts/gen-cordis-api.ts` 从源码 AST 生成）逐条目精确文本比对；rc.3 侧只读提取自 `app.asar`。
完整结果：`evidence/compat-rc3/contract-catalog-diff.md`；取证细节：`evidence/compat-rc3/api-contract-evidence.md`。

| 比对范围 | 结果 |
| --- | --- |
| **插件消费的 34 个类型声明**（CreateAgentOptions / ResumeAgentOptions / AgentHandle / AgentSetup / AgentOptions / AgentFactory / ToolDefinition / ToolSchema / ToolOutputDefinition / ToolRunContext / ToolExecution / ToolGuard / ToolRestriction / ToolExecutionInput / GenerateOptions / RequestMessage / RequestUserInput / Message / StreamChunk / FinishReason / FinishReasonMap / LlmFailure / TokenUsage / LlmProviderInfo / LlmResolvedModelInfo / PromptSection / PromptContext / AssembleContext / PresetDefinition / SaveImageAttachment / ImageAttachmentRef / ImageMediaType / SessionId / SessionEvent） | **IDENTICAL 34 / DIFFERS 0 / rc.3 缺失 0** |
| **插件消费的 7 个服务**：`tools` `agents` `agentPresets` `llm` `attachments` `systemPrompt` `timer` | 方法表 **7/7 IDENTICAL**（方法数分别 8/14/14/16/14/9/6） |
| 上述服务的方法条目（签名 + 描述文本，81 条） | **81/81 IDENTICAL** |
| `ctx.effect`、`ctx.get/set/provide`、`ctx.logger`、`ctx.timer` 继承 API 说明 | IDENTICAL |
| 全目录（非仅消费面） | 98 服务（数量相同）；共享类型 1053 个，仅 **`ProductEventMap`** 不同（产品遥测事件表，插件未用）；rc.3 新增 **1** 个类型 `AnalyticsPreset`（插件未用）；rc.2 独有 0 |
| 语义实现（restrict / guard / resume / llm messages） | 逐行等价，见 §4.1 |

### 4.1 语义漂移检查（逐项）

| 检查点 | rc.2 | rc.3 | 结论 |
| --- | --- | --- | --- |
| `tools.restrict` 必须在 agent 作用域 | 要求 scoped ctx，否则抛错；未知名抛错；`run_code` 抛错 | 同（`dsh-tools/lib/index.js:2991-3006` 与 rc.2 `src/index.ts:1105-1132` 等价） | **无漂移**；插件在 setup 内调用，合法 |
| `tools.guard` 语义 | 单调拒绝；global → scope chain；字符串即拒绝 | 同（`:3017-3032`） | **无漂移**；活体实测拒绝生效 |
| `agents.create/resume` 的工厂流 | open(write)→冷读→补齐中断轮→prepare→setup→publish | 同（`dsh-agent-loop/lib/index.js:1963-2020`） | **无漂移** |
| setup 拿到的 ctx 是 agent 作用域 | 是 | 是（`:1931` → `tools.restrict` 前提） | **无漂移** |
| `llm.stream` 消息形态 | `RequestMessage = Message \| RequestUserInput`；`forAdapter()` 对 assistant 消息读 `source.replayState` | 同（`dsh-llm/lib/index.js:2267-2289,2349`；rc.2 `src/index.ts:1023-1027,1118`） | **无漂移**；插件仅发 `user` 消息，不触发 assistant 分支 |
| 附件服务缺失时的行为 | 插件在 `complete()` 内判空 → `LLM_UNAVAILABLE`（仅图片请求） | 同（可选依赖，`ctx.get('attachments')` 可能 undefined） | **无漂移**，且插件有防御 |
| 会话格式版本 | v4 | v4（currentVersion 4，含 v0–v4 codecs 与 v3→v4 迁移） | **无漂移** |
| 版本自检钩子 `DSH_DESKTOP_VERSION`/`DSH_VERSION` | 不存在这两个环境变量 | 不存在（asar 全文搜索 0 命中；存在的是 `DSH_CLIENT_VERSION`） | **DRIFT（诊断级，非阻塞）** → 见 O1 |

## 5. 活体验证（本轮 rc.3 进程）

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 17 个 `moments_*` 工具注册 | **VERIFIED** | `Tool.listTools`；`live-tool-registry.txt` |
| 插件 admin（127.0.0.1:18766） | **VERIFIED** | `/` 200（8326 B）；`/api/health` 200；`/api/status` 200；`admin-health.json`、`admin-status.json` |
| `llm` 能力 | **VERIFIED** | health `llm.ok`（deepseek-account/deepseek-flash，text+image） |
| WeChatAgent | **VERIFIED** | health `wechatAgent.ok`（4.1.10.27，Reader/Hook 账号一致） |
| 工具守卫 | **VERIFIED** | 外部会话调用 `moments_health` → `POLICY_DENIED：仅独立朋友圈会话可调用此工具` |
| 独立会话 | **VERIFIED** | 见 §3 |
| runtime 调度 tick | **VERIFIED** | DB `scheduler_next_at` 本轮被刷新 |
| 桌面执行器 | 未启动（`unavailable`，健康页如实报告） | 按边界要求本审计**不启动**执行器；由 Lead 后续 GUI 验证 |

## 6. 测试基线（Node）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npm run typecheck` | **0** | 无类型错误 |
| `npm test` | **0** | **tests 203 / pass 202 / fail 0 / skipped 1**（Windows 无符号链接权限跳过符号链接用例）/ duration 20437.83 ms |
| `npm run verify` | **0** | `17 个工具已注册，health 与 status 返回结构正确`、`全部通过` |

日志：`evidence/compat-rc3/{typecheck.log,test.log,verify.log,run-summary.txt,node-version.txt}`。
说明：`npm test` 会重建 `dist/`（本轮已重建）；插件以 junction 装在 live profile，重建不影响已加载内存的插件，未重启 DSH。

## 7. 未验证项（不得当作可用）

1. 受守卫保护的**工具真实执行 + `output.render` 渲染**：独立会话从未跑过模型轮次，本审计的外部调用在 guard 阶段即被拒绝。
2. `attachments.saveImages()` 的**活体调用**（带图模型请求）——契约层已验证，运行路径未触发。
3. 管理面 **POST** 写接口（发布/审批/准备）的 rc.3 行为——超出本审计范围，且按边界不得触碰发布链路（由其他 teammate/Lead 覆盖）。
4. Electron/桌面壳层（窗口、GUI 交互）——本审计未操作 GUI。

## 8. 本次变更文件

仅文档（未改代码）：

| 文件 | 变更 |
| --- | --- |
| `docs/audit/DSH_0_2_1_RC3_COMPAT.md` | **新增**：本报告 |
| `docs/audit/COMPATIBILITY_MATRIX.md` | 基线标题 rc.2→rc.3；追加「## 9. 2026-10-25 rc.3 复核」小节（保留全部历史） |
| `README.md` | 目标 DSH 行（`:28`）与依赖表 DSH 行（`:119`）从 `0.2.1-rc.2` 更新为 `0.2.1-rc.3`（仅版本字样，其余未动） |
| `docs/audit/evidence/compat-rc3/` | 新增证据：`contract-catalog-diff.md`、`environment-identity.md`、`live-runtime-evidence.md`、`dedicated-session-evidence.md`、`host-log-channel.md`、`api-contract-evidence.md`、`baseline-commands.md`、`admin-health.json`、`admin-status.json`、`live-tool-registry.txt`、`moments-db-system-settings.txt`、`moments-db-recent-rows.txt`、`dedicated-session-file.txt`、`typecheck.log`、`test.log`、`verify.log`、`run-summary.txt`、`node-version.txt` |

**无需修改的代码**：`src/`、`desktop/`、`client/`、`scripts/`、`tests/`、`cordis.patch.yml` 全部保持原样（本审计无写权限，也未发现真实代码不兼容）。
