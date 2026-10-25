# COMPATIBILITY_MATRIX.md — DSH 0.2.1-rc.3 兼容性矩阵（Phase 0）

> **基线更新（2026-10-25）**：已安装并正在运行的桌面版为 **0.2.1-rc.3**（`D:\dsh`，build `be72761e`）。
> Phase 0 原文按 rc.2 编写，作为历史证据保留（正文未改）；rc.3 复核结论见文末
> [§9](#9-2026-10-25-rc3-复核) 与 [DSH_0_2_1_RC3_COMPAT.md](DSH_0_2_1_RC3_COMPAT.md)。

- 基线：已安装 DeepSeek Harness 桌面版 **0.2.1-rc.3**（`D:\dsh`；Phase 0 编写时为 rc.2），Host 内 `@deepseek-ai/cordis` **4.0.5**，`schemastery` 3.18.5，profile `C:\Users\10575\.dsh\profiles\desktop`。
- 证据优先级：① 已安装 Host 的 `cordis_inspect_query` 实时契约；② 已安装包源码（profile `node_modules`、asar 内 `read`）；③ upstream `dsh-v0.2.1-rc.2`（`687f282e`）源码（rc.2 对照基线）；④ 本次实测命令。
- 状态词定义：
  - `VERIFIED`：接口/文件/行为在本次审计中被实际读取或实测确认。**接口契约验证不等于本插件注册行为已验证**，逐项注明验证范围。
  - `COMPATIBLE_WITH_ADAPTER`：需要本项目写适配层/包装代码才能满足目标，底层能力存在。
  - `EXPERIMENTAL`：能力存在但未在本目标环境走通完整业务路径，或依赖实验性特性。
  - `UNSUPPORTED`：明确不具备该能力（含源码级证据）。
  - `NOT_TESTED`：因权限/环境限制本次未验证，**不得**视为可用。

## 1. 插件装载与入口形式

| # | 能力项 | 状态 | 证据（路径 + 接口/命令） | 风险 | 解决方式 |
|---|---|---|---|---|---|
| 1.1 | `apply(ctx, config)` 函数插件入口 | VERIFIED | 已装样例 `C:\Users\10575\.dsh\profiles\desktop\node_modules\dsh-posterflow-ai\lib\index.js:210` `function apply(ctx, config)`，`:244` 导出 `apply, inject, name`；文档 `app.asar\dsh\node_modules\@deepseek-ai\dsh-agent-preset\skills\cordis-plugin-development\references\host-plugin.md:57-64` 明确三种入口：`export function apply(ctx, config)` + 可选 `export const inject/Config`，或 default 导出 Service 类 | 混用入口形式会导致 loader 报错 | 固定用 `apply + inject + Config` 三件套；不要 default 导出类 |
| 1.2 | `export const inject` 声明依赖 | VERIFIED | posterflow `lib/index.js:121-123`（`const name`、`const inject = []`）；`@deepseek-ai/dsh-subagent-codex/lib/types/index.d.ts:11-12` `export declare const name = "subagent-codex"; export declare const inject: string[]`；Cordis `vendor/cordis/src/registry.ts:19-24`（`Inject` 类型）、`:100-111`（`Plugin.Base.inject`） | 声明了未挂载服务会永久 pending，插件不激活且无显式报错 | 只声明硬依赖；可选服务用 `ctx.get('svc')` + undefined 判空（posterflow 的 `webServer` 即此模式，`:218-222`） |
| 1.3 | `export const Config`（schemastery） | VERIFIED | posterflow `lib/index.js:139-148` `const Config = z.object({ targetUrl: z.string().default(...), ... })`；subagent-codex `lib/types/index.d.ts:14-29` `export interface Config` + `export declare const Config: z<Config>`；实时投影见 `cordis_inspect_query(host, Config, listConfigs, entry="include:subagent-codex")` 返回完整 JSON Schema（含 `default`、`$defs/loaderExpression`） | schema 与 patch 配置不一致时行加载失败；`config` 整行替换不深合并 | 在 patch 中只写需要覆盖的字段；用 `Config.listConfigs` 核对投影；敏感开关默认关闭 |
| 1.4 | `ctx.effect(callback, label?)` | VERIFIED | `vendor/cordis/src/fiber.ts:402-418`：`effect(execute: () => SyncEffect, label?: string): Disposable<Promise<void>>` / 异步重载；posterflow `:223`、`:236` 用 `ctx.effect(() => webServer.register(...))` 注册路由 | 清理函数未返回会泄漏注册 | 所有注册（route/tool/listener）包在 `ctx.effect` 内并返回 disposer |
| 1.5 | `ctx.on(event, listener, options?)` | VERIFIED | `vendor/cordis/src/events.ts:277-302`：`on(name: string \| symbol, listener: (...args) => any, options?: boolean \| EventOptions)`；事件模式由 `cordis_inspect_query(host, Event)` 实时列出（`emit` / `serial` / `parallel` / `waterfall` / `bail`） | waterfall 监听器不调用 `next()` 会截断整条链 | 监听 waterfall 事件必须 `return next()`；用 `Event` inspect 核对签名 |
| 1.6 | `ctx.plugin(plugin, config?)` | VERIFIED | `vendor/cordis/src/registry.ts:293-335`：`inject(inject, callback)` 与 `plugin(plugin, config?)`，返回可 await 的 fiber；注释说明返回 disposer/awaitable | 误传非法插件立即抛错；fiber 未 await 时错误时机不确定 | 需要错误隔离时 `await ctx.plugin(...)`；不要拿 `ctx.plugin` 做热替换 |
| 1.7 | `ctx.inject(deps, callback)` | VERIFIED | `registry.ts:300-302`：`inject(inject: Inject, callback: Plugin.Function<void>)` = `plugin({ inject, apply: callback, name: callback.name })`；依赖就绪后才启动 | 依赖永不到达时永不执行（无超时） | 对可选能力改 `ctx.get`；对必须能力在 `inject` 中声明并接受"不满足就不激活" |

## 2. 工具与运行时扩展点

### 2.1 `ctx.tools`（已安装 dsh-tools 0.2.1-rc.2）

| # | 能力项 | 状态 | 证据 | 风险 | 解决方式 |
|---|---|---|---|---|---|
| 2.1 | `ctx.tools.register(definition: ToolDefinition): () => void` | **VERIFIED（接口）** | `cordis_inspect_query(host, Service, listService, service="tools")` 返回精确契约；活体 `Tool.listTools` 返回 40+ 已注册工具（`read/write/edit/pwsh/terminal_*/schedule_*/subagent_codex/...`），证明注册管线在运行 | 本 Phase 禁止安装插件，**"本插件自定义 tool 被模型看到"未实测** | 实现后用独立 bundle 安装并在 `Tool.listTools` 中确认名字出现 |
| 2.2 | `ToolDefinition` 字段 | VERIFIED（接口） | 同 2.1，精确声明：`interface ToolDefinition extends ToolSchema { readonly output: ToolOutputDefinition; execute(args: unknown, exec: ToolRunContext): Promise<unknown>; projectContent?(...); finalizeContent?(...); timeoutMs?: number; isConcurrencySafe?(args: unknown): boolean; presentCall?(args): ToolCallView \| undefined; presentResult?(args, result: ToolResult): ToolResultView \| undefined }`；`ToolSchema { deferLoading?: true; name: string; description: string; parameters: Record<string, unknown> }`；`ToolOutputDefinition { readonly schema: JsonSchemaNode; render(args: unknown, value: JsonValue): ContentBlock[]; presentationMeta?(...) }`；`ToolRunContext extends ToolExecution { deferContext(context: UserMessage): void; concludeTurn(): void }` | `parameters` 是普通 JSON Schema 对象（非 zod）；`output.render` 返回 `ContentBlock[]`，写错会导致结果展示为空 | 用最小骨架（见 PHASE0_GATE §2）先注册一个 echo 工具验证；`output.schema` 与 `render` 必须同时提供 |
| 2.3 | `ctx.tools.guard(guard: ToolGuard): () => void` | VERIFIED（接口） | `ToolGuard = (execution: Readonly<ToolExecution>) => string \| undefined`；在 `tools/pre-execute` waterfall 之后执行，返回字符串即拒绝；plain ctx 全局、`agent.ctx` 仅该 agent | **guard 拒绝路径未实测**；顺序/作用域易误用 | 安全开关（如"禁止自动发布"）用 guard 兜底；并配 `tools/pre-execute` waterfall 记录原因 |
| 2.4 | `ctx.tools.restrict(filter: ToolRestriction): () => void` | VERIFIED（接口） | `ToolRestriction { readonly allow?: readonly string[]; readonly deny?: readonly string[] }`；空过滤器/未知名字/保留 `run_code` 会失败；restriction 之间取交集 | 作用于全局工具；对作用域内注册的工具无效 | preset 内最小权限用 `restrict({ allow: [...] })`；不依赖它隐藏插件私有工具 |
| 2.5 | `ctx.tools.presentAs(mode)` / `schemas` / `get` / `execute` | VERIFIED（接口） | 同一契约：`presentAs(mode: 'native' \| 'ptc')`、`schemas(scope?)`、`get(name, scope?)`、`execute(exec)` | 直接 `execute` 会绕过 agent 级策略 | 不要自己调 `ctx.tools.execute` 走业务；让模型/调用方走统一管线 |

### 2.2 定时与调度

| # | 能力项 | 状态 | 证据 | 风险 | 解决方式 |
|---|---|---|---|---|---|
| 2.6 | `ctx.timer.timeout` / `interval` | VERIFIED（接口） | `Service.listService(timer)`：`timeout(callback, delay): () => void`、`timeout(delay): Promise<void>`、`interval(callback, delay): () => void`、`interval(delay): AsyncIterableIterator<void>`、`throttle/debounce`；Host 配置中有 `include:timer`（`cordis-plugin-timer`）行 | 长延时 timer 在 Host 重启后丢失（非持久化） | 跨重启需求用 `ctx.schedule`；timer 只做进程内节流/超时 |
| 2.7 | `ctx.schedule`（持久化提醒） | VERIFIED（接口） | `Service.listService(schedule)`：`create(sessionId, ScheduleCreateRequest, signal?): Promise<ScheduleRecord>`、`list(request)`、`catalog()`、`history(request)`、`delete(request)`、`update(request)`；工具 `schedule_create/list/update/delete` 在活体 `Tool.listTools` 中可见；服务 JSDoc 说明投递仅在 `ctx.sessions.flush()` 有持久化监听时提交 | **委派子代理（delegated subagent）会话无法创建提醒**：本次实测 `schedule_create` 返回 `{"code":"subagent_session","message":"A delegated subagent cannot use reminders."}`；后台唤醒的完整"到点唤醒"链路未实测（本审计禁止长期留下提醒） | 调度必须由**根会话**（或 Host 侧服务）执行，不能在 teammate/subagent 会话内创建；投递目标固定绑定创建时的 sessionId |
| 2.8 | `ctx.schedule` 时间选择器 | VERIFIED（接口） | `ScheduleCreateRequest { prompt; title; after_seconds?; at?; every_seconds?; daily?; weekly?; cron? }`；记录联合类型 `After/At/Every/Daily/Weekly/CronScheduleRecord`；错误码含 `not_future`、`frequency_too_high`、`time_out_of_range`、`invalid_time_zone` | title 缺失/空白/超长直接 `invalid_prompt`；频率过高拒绝 | 业务层先做校验与预算（每日上限/静默时段），不要让模型直接乱传 cron |

### 2.3 LLM

| # | 能力项 | 状态 | 证据 | 风险 | 解决方式 |
|---|---|---|---|---|---|
| 2.9 | `ctx.llm.stream(options: GenerateOptions): AsyncIterable<StreamChunk>` | VERIFIED（接口） | `Service.listService(llm)` 精确签名；`GenerateOptions { provider; model; reasoningEffort?; messages: RequestMessage[]; system?; tools?: ToolSchema[]; toolHistory?; temperature?; maxTokens?; stop?; signal?; sessionId?; purpose?: 'compaction' \| 'session-title' }`；`StreamChunk` = `block-start \| text-delta \| reasoning-delta \| tool-call-delta \| block-end \| usage \| finish` 联合 | 文本生成本身未在本插件内实测；`provider="deepseek-account"` 依赖已登录账户（profile patch 已配 deepseek-account/deepseek-flash）；流式错误以终态 `finish.error/aborted` 出现而非抛出 | 业务里做"收集 text-delta 直到 finish"的包装；配超时 AbortController；图像生成不要走 ctx.llm（见 3.4） |
| 2.10 | `llm/stream` waterfall | VERIFIED（接口） | `Event.listEvents`：`'llm/stream'(this: LlmRuntime, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk>` | 监听器不 `next()` 会吞掉所有模型调用 | 只在确有路由/录制需求时挂；默认不改 |

### 2.4 存储、系统提示、审批、文件、子进程

| # | 能力项 | 状态 | 证据 | 风险 | 解决方式 |
|---|---|---|---|---|---|
| 2.11 | `ctx.storage` | VERIFIED（接口） | `Service.listService(storage)`：`readonly backend: BackendRegistry`、`mount(form, facility): () => void`、`form(form)`；`StorageBackend { kv?: KvFacet; close() }`、`KvUnit.loadAll/putRecord/deleteRecord/setGlobal/close`；Host 有 `include:storage-json`、`include:storage-domain` 行 | `StorageForms` 为空接口，具体 form 由 domain 插件扩展；直接依赖 `ctx.storage.kv` 属于绕过 domain 语义 | 业务状态优先用 `storageDomain.open(spec)`；小配置可用 `storage-json` 路径（需再核对具体 form 名） |
| 2.12 | `ctx.systemPrompt` | VERIFIED（接口） | `Service.listService(systemPrompt)`：`section(section: PromptSection): () => void`、`context(context: PromptContext): () => void`、`tools(provider)`、`variable(name, provider)`、`suppressRuntimeContext()`、`refreshContext(assembly, context?)`、`assemble(context?)`；`Event.listEvents` 有 `'system-prompt/assemble'` waterfall | section/context 顺序由 order 决定，乱序会导致人格提示词被系统段覆盖 | persona 用 preset 的 `@deepseek-ai/dsh-persona`（prefix/complete/includeRuntimeContext，见 3.1 样例）；动态上下文用 `ctx.systemPrompt.context` 并设 order |
| 2.13 | `ctx.approval` | VERIFIED（接口） | `Service.listService(approval)`：`setPolicy(agent, policy: 'ask' \| 'never'): void`、`request(req: ApprovalRequest): Promise<ApprovalOutcome>`、`overrideOf(session)`；`ApprovalOutcome = 'allowed-once' \| 'rejected' \| 'cancelled' \| 'unavailable'`；`ApprovalRequest { agent; toolName; callId?; reason?; signal?; displayReason? }`；要求有打开的 turn，否则 reject | 本次会话 approval prompts 被禁用（自动拒绝），`request()` 实际会走 `unavailable`；插件不能自行"批准" | 发布类动作必须设计为显式人工审批（Web UI/独立确认通道），不能用 approval 服务兜底自动放行 |
| 2.14 | `ctx.fs` | VERIFIED（接口） | `Service.listService(fs)`：`resolve(path, opts?): Promise<FsTarget>`、`processPath(target)`、`fileUrl`、`contains`、`stat/lstat/readText/streamText/readBytes/readByteRange/listDir`、`writeText(target, content, expected?, signal?, sandboxPolicy?)`、`editText(...)`；`FsTarget { targetKey; displayPath }`；`SandboxExecutionPolicy { mode: 'read-only' \| 'workspace-write' \| 'danger-full-access'; workspaceRoot; sessionId? }`；Host 有 `include:fs-sandbox` 行 | 必须用 `fs.resolve` 得到 target，不能自己拼 OS 路径再当 target；写受 sandboxPolicy 限制（本会话 workspace-write） | 所有读写走 `ctx.fs`；跨进程边界用 `processPath(target)` |
| 2.15 | `ctx.subprocess` | VERIFIED（接口） | `Service.listService(subprocess)`：`resolveExecutable(command, env?, signal?)`、`terminalEnvironment(signal?)`、`spawn(spec: SubprocessSpawnSpec): SubprocessHandle`、`spawnTerminal(spec)`；`SubprocessSpawnSpec { argv; cwd; stdio; graceMs; signal?; env? }`；`SubprocessHandle { stdin/stdout/stderr/control; collected; done; terminate(); waitForExit(signal?) }` | Windows 下 argv 需要是真实可执行文件路径；`cwd` 必须存在；收集模式有 `maxBytes` 截断与 spill 文件 | 桌面执行器走 `spawn` + `collected` 读输出；长进程用 `listen` 流 + `terminate`；Python 路径用自带 3.12.14 绝对路径 |
| 2.16 | `ctx.subagents` | VERIFIED（接口） | `Service.listService(subagents)`：`registerProvider(provider): () => void`、`getProvider(name)`、`list()`、`startActivation(...)`、`sendMessage(sender, targetId, content, options)`、`interrupt(targetSessionId, authority)`、`listChildren/listDescendants`、`prompt/interruptByParent`（@Remote） | 深度与生命周期由 provider 决定；本地 in-process 与 Codex 行为不同 | 需要可控子任务用 `subagent_fork`/`subagent` 工具；需要 Codex 用 3.x；不要在插件里重复实现 |

## 3. Agent Preset 与独立会话

| # | 能力项 | 状态 | 证据 | 风险 | 解决方式 |
|---|---|---|---|---|---|
| 3.1 | `agentPresets` 服务 | VERIFIED | `Service.listService(agentPresets)` 12 个方法：`register(definition: PresetDefinition)`、`list()`、`resolve(id?)`、`readDocument(agentPreset)`、`mount(ctx, id?)`、`composeFrom(ctx, parent)`、`composedPreset(ctx)`、`serviceFor(agent, name)`、`recompose(ctx, id)`、`select(agent, agentPreset)`、`acquireScope(id?)`、`compositionInventory()`；`PresetDefinition { id; name?; description?; order?; plugins: EntryOptions[] }` | 声明失败会留在 roster 并带 broken 诊断，不能组合会话 | 新增 preset 必须用 bundle patch 声明 + `install_bundle`；不能手写用户目录（旧 `.agent-presets` 已不读） |
| 3.2 | preset YAML 装载（真实样例） | VERIFIED | 已装 `app.asar\dsh\node_modules\@deepseek-ai\dsh-web-app\presets\minimal.patch.yml:1-78`（`- insert: - id: preset-minimal / name: '@deepseek-ai/dsh-agent-preset' / config: { id: minimal, order: 3, plugins: [...] }`）；活体 `Config.listConfigs` 返回 4 行：`include:preset-standard`、`preset-ptc`、`preset-minimal`、`preset-cordis` | `config` 整行替换、不深合并；override 必须重述完整 plugins 列表 | 新增 preset：bundle 内 `- insert: - id: preset-<id> / name: '@deepseek-ai/dsh-agent-preset'`；改 shipped preset：`- id: preset-standard` + 完整 config |
| 3.3 | `agent/created` 事件 | VERIFIED | `Event.listEvents`：`'agent/created'(this: Scoped<Agent>, payload: { agent: Agent; source: SessionStartSource; signal?: AbortSignal }): undefined \| Promise<undefined>`，模式 `serial` | serial 监听器抛错会拒绝创建；监听器里等待自身会死锁 | 初始化 agent 级资源用 `agent/created`；保持幂等与快速返回 |
| 3.4 | 独立 persona / session / workspace | **COMPATIBLE_WITH_ADAPTER** | `CreateAgentOptions { sessionId; parentAgent?; meta?: { cwd?; parentSession?; isSeeded?; origin?; delegationDepth?; agentPreset? }; seed?; agentOptions?; setup? }`（`Service.listService(agents)`）；`workingDirectory.set(agent, path, signal?)`；preset `@deepseek-ai/dsh-persona` 提供 prefix/complete；`agentPresets.mount/select/recompose` | 本次未实际创建独立 agent（需要安装 bundle / 根会话驱动），组合行为未实测；`meta.cwd` 是会话头信息，运行时目录仍以 `workingDirectory` 为准 | 适配层：`ctx.agents.create({ sessionId, meta: { cwd, agentPreset }, setup })` + `ctx.workingDirectory.set(agent, workspace)`；persona 用独立 preset 声明，不靠系统提示词字符串拼接 |
| 3.5 | 仓库内已存在的项目 patch | VERIFIED（文件存在） | `D:\dsh插插\dsh-moments-agent\cordis.patch.yml:1-43`（`insert: dsh-moments-agent`，`publishMode: PREPARE_ONLY`、`killSwitch: false`、`wechatAgent.enabled: false`、`desktopExecutor.enabled: false`、`images.officialApiEnabled: false`、`policy.requireApproval: true`）；`package.json` 声明 `dsh.bundle.patch: ./cordis.patch.yml` | 该插件尚未构建/安装；schema 与实现一致性未验证 | Phase 1 先跑 `npm run build`，再按 bundle 流程安装；安全开关默认关闭 |

## 4. Codex 子智能体（已装 `@deepseek-ai/dsh-subagent-codex@0.2.1-rc.2`）

| # | 能力项 | 状态 | 证据 | 风险 | 解决方式 |
|---|---|---|---|---|---|
| 4.1 | 提供方注册 + 全局工具 | VERIFIED | 包 `cordis.patch.yml:1-9`：`insert: subagent-codex`（`@deepseek-ai/dsh-subagent-codex`）+ `tool-subagent-codex`（`@deepseek-ai/dsh-tool-subagent`，`provider: codex`、`toolName: subagent_codex`、`maxDepth: provider-managed`）；活体 `Config.listConfigs` 有 `include:subagent-codex`；`Tool.listTools` 有 `subagent_codex`（描述：文本任务、独立上下文、返回结果） | 实际委派运行未实测（会启动真实 Codex 进程） | 需要时用工具直接委派；不要在插件里 import 该包内部实现 |
| 4.2 | 只接受文本任务 | **VERIFIED** | `lib/types/run.d.ts:50-54`：`textTask(prompt: readonly ContentBlock[]): string[]`；`lib/index.js:598-601`："the one-shot task must contain only text blocks"，逐块检查非文本即拒绝；README.zh.md:110"只接受非空的文本块序列" | 传入 image/file block 直接失败 | 图片/文件先转成路径或 base64 文本提示，或走本地工具 |
| 4.3 | 返回文本结果 | VERIFIED | README.zh.md:110-112（选择 `phase: final_answer` → `partial_answer` → `phase: null` 的最后一条 `agentMessage`）；`lib/index.js:765-798` 只返回 `terminal` 结果；README.zh.md:173："assistant 载荷仅包含所选回答文本" | 推理、工具活动、stderr、diff 不进入父会话 | 需要结构化结果时让 Codex 输出 JSON 文本并在父侧解析，不要期待原生结构 |
| 4.4 | 图像生成能力 | **UNSUPPORTED** | 包代码无 image 相关接口：`lib/types/run.d.ts` 仅文本；`lib/index.js` grep `image` 无匹配；`Config` 只有 providerName/model/env/permissionMode/disposeGraceMs；工具只接收 `prompt/description/cwd`（`Tool.listTools`） | 若把朋友圈配图交给 Codex，会得到文本而非图片，且无工具可发图 | 图像由 `images.providers = manual-subscription / local-import` 在 DSH 侧实现；或调用独立图像 API（默认关闭） |
| 4.5 | 取消 | VERIFIED | `lib/index.js:108-127`（`abortError` / `raceAbort`）、`:702-709`（runAbort 与 request.signal 双通道）、`:643`、`:733` `aborted before publication`；README.zh.md:81"被取消的运行以 `aborted` 结算"；`subagents.interrupt(targetSessionId, authority)` 可中断 | 取消后已改的文件不恢复；无按实际耗时超时 | 父侧必须显式 `interrupt`；记录开始/结束并做超时看门狗；不要假设可回滚 |
| 4.6 | 结果回传 | VERIFIED | 工具描述"完成通知包含最终答案"；README.zh.md:73"工具接受任务后返回 child id；任务完成后向父 agent 发送结果通知"、:150"父模型先收到 child id，随后收到所选 Codex 答案或失败通知"；`subagent/start`、`subagent/end` 事件可观测 | 一次性运行：不支持追加输入/恢复/池化；每任务新进程 | 长任务拆小；父会话侧维护任务-结果映射，不依赖 Codex 线程状态 |
| 4.7 | 工作目录边界 | VERIFIED | `lib/types/run.d.ts:33-37` `CodexRunSpec.cwd`（"Selected child working directory, also supplied to thread/start"）；`lib/index.js:835-843` 取 `request.cwd` 并 `assertUsableCwd`，无效即拒绝；README.zh.md:110 子级工作区为"所选子级工作目录"；工具 `cwd` 参数省略时继承当前目录 | 子级与父级共享同一 workspace 写入；无 git worktree 隔离 | 需要隔离时父侧给独立 `cwd`（如 worktree 或临时目录），并限制其写权限；不要假设子级只读 |
| 4.8 | 运行能力（真实 Codex 进程） | NOT_TESTED | 本次未执行 `subagent_codex`；README.zh.md:81 说明载荷/平台/认证缺失会在 `initialize` 失败；本机 PATH 上无 `codex`（包内自带 `@openai/codex` 0.153.4 依赖） | 首次真实运行可能因认证/载荷/权限失败 | Phase 1 用 `cwd` 指向临时目录做最小冒烟，记录 stderr；失败按 `unknown`/`process` 分类处理，不做宿主 CLI 回退 |

## 5. 插件 bundle 注册与安装

| # | 能力项 | 状态 | 证据 | 风险 | 解决方式 |
|---|---|---|---|---|---|
| 5.1 | `package.json` → `dsh.bundle.patch` | VERIFIED | `dsh-posterflow-ai/package.json:50-57` `"dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { "platform": "web" } }`；`dsh-whale-widget/package.json:31-35`；`dsh-subagent-codex/package.json:34-38`；`dsh-moments-agent/package.json:32-36` | 路径写错会静默不合并（loader 只 warn） | patch 文件必须真实存在于 `files` 列表 |
| 5.2 | `cordis.patch.yml` `insert` 语法 | VERIFIED | 真实样例：posterflow `cordis.patch.yml:13-23`（`- insert: - id: dsh-posterflow-ai / name: dsh-posterflow-ai / config: {...}`）；whale `:13-15`；subagent-codex `:1-9`；minimal preset `:4-78`；skill 文档 `cordis-composition-reference`：`insert` 追加，带 `id` 指向已存在 `group: true` 行则插入其 `config` 列表；非 insert 且无 `id` 会被 warn 跳过 | `config` 整行替换而非深合并；`name` 与包名不一致只 warn 跳过 | 覆盖已有行时重述完整 config；新增行 id 全局唯一 |
| 5.3 | `plugin_manager.install_bundle` 行为 | NOT_TESTED | 工具自述：执行包安装与 bundle 选择、支持本地目录、失败返回 `application/warnings`；skill `host-plugin.md:66-70`。**本会话 approval 被禁用，任何 `plugin_manager` 调用都会被自动拒绝**，且任务禁止安装插件 | 本 Phase 无法端到端验证"安装→激活→工具出现" | Phase 1 在获授权的 profile 中安装；以 `application: applied` 与 `Tool.listTools` 为准，不以日志为准 |
| 5.4 | profile 覆盖层（用户 patch） | VERIFIED | `C:\Users\10575\.dsh\profiles\desktop\cordis.patch.yml`（4 行 override）；`package.json` 的 `dsh.profile.bundles` 9 项 | 用户层覆盖会整行替换 config，可能覆盖插件默认安全开关 | 项目文档明确"如需改配置在 profile patch 按 id 覆盖"，不要改插件默认值 |

## 6. Windows 微信与 GUI 自动化

| # | 能力项 | 状态 | 证据 | 风险 | 解决方式 |
|---|---|---|---|---|---|
| 6.1 | 微信安装 | VERIFIED | `D:\tencent\Weixin\Weixin.exe` FileVersion/ProductVersion 4.1.15.13（Tencent，2,939,440 B）；版本目录 `4.1.15.13` 914.7 MB；注册表 `HKCU\SOFTWARE\Tencent\Weixin` 存在；用户数据 `Documents\WeChat Files`（2 个 wxid） | 旧 3.8 卸载项指向不存在的 `D:\tencent\WeChat\WeChat.exe`；4.x 与旧数据并存 | 版本探测以 `Weixin.exe` 文件版本为准；清理旧卸载项属用户侧操作，本项目不改注册表 |
| 6.2 | 微信运行态 | NOT_TESTED | `Get-Process Weixin/WeChat` 无结果；未启动用户微信（避免干扰用户会话） | 未运行无法验证窗口/控件 | 需要 GUI 验证时由用户手动启动，或经审批后启动 |
| 6.3 | UIA 运行时 | VERIFIED | `UIAutomationCore.dll` 7.2.26100.8875、`oleacc.dll` 7.2.26100.9549 | 系统接口存在不等于微信 4.x 暴露控件树 | 运行态用 `Inspect.exe`/UIA 枚举验证微信窗口类名与控件 |
| 6.4 | `pywinauto` / `uiautomation` 可用性 | **NOT_TESTED** | 自带 Python 3.12.14 与 PATH Python 3.11.2 均未安装 pywinauto/uiautomation/comtypes/pyautogui；PyPI 可达（`pywinauto` 最新 0.6.9，urllib 实测），但 `pip download/dry-run` 挂起 >90 s（两次） | pip 通道不可用 → 无法按常规安装 | Phase 1 用离线 wheel/TUN 修复 pip 后安装；或改用 Node + PowerShell UIA COM 方案；在此之前 GUI 执行器只交付代码 + Mock |
| 6.5 | 截图/Pillow | VERIFIED（导入级） | 自带 Python `PIL` 12.3.0 可导入，`ImageGrab` 可导入；实际抓屏未跑 | 多显示器/DPI 缩放可能偏移 | 抓屏前记录缩放与窗口 rect；用相对坐标 |
| 6.6 | 朋友圈发布/读取（微信侧） | NOT_TESTED | 依赖 6.4；另见 WeChatAgent 审计（独立任务） | 微信 4.x 与 3.x 协议/控件差异大；封号风险 | 采用人工确认发布（PREPARE_ONLY）；桌面执行器默认 disabled |

## 7. 环境能力

| # | 能力项 | 状态 | 证据 | 风险 | 解决方式 |
|---|---|---|---|---|---|
| 7.1 | DSH 自带 Node 24.21.0 | VERIFIED | 自带 `node.exe -v` = v24.21.0；`versions.json`；Electron-as-Node 输出 v24.21.0 | PATH 的 node 是 24.14.1 | 用绝对路径调用 |
| 7.2 | DSH 自带 pnpm 11.28.5 | VERIFIED | `node pnpm.cjs --version` = 11.28.5；PATH 无 pnpm | 误用 PATH 会失败 | 命令中写全路径 |
| 7.3 | DSH 自带 Python 3.12.14 | VERIFIED | `python.exe --version` = 3.12.14；`runtime.json`；Pillow 等已装 | PATH 默认 python 是 3.11.2 | 用绝对路径；GUI 依赖装到自带 3.12 |
| 7.4 | `node:sqlite` | VERIFIED | in-memory create/insert/select 实测通过 | 实验性 API，未来版本可能变更 | 只在本地缓存/审计用；升级 DSH 时回归 |
| 7.5 | 网络（Node/Python） | VERIFIED | Node fetch：npm 200、npmmirror 200、github 200、pypi 200、harness 404、api.deepseek 401；Python urllib pypi 200 | curl/PowerShell HTTPS 因 schannel 失败；pip 挂起 | 健康检查用 Node fetch/Python urllib；curl 结果不作判据 |
| 7.6 | 上游代码对照（只读） | VERIFIED | `D:\dsh插插\upstream\deepseek-harness` HEAD `687f282e…`，tag `dsh-v0.2.1-rc.2`，shallow，clean | 浅克隆缺少历史，不能做 blame/回溯 | 需要历史时另行 `git fetch --unshallow`（需用户同意，且不改 upstream） |
| 7.7 | 插件注册工具（本插件） | NOT_TESTED | 本 Phase 禁止安装插件；见 2.1 | 未验证 | Phase 1 用最小 bundle 安装并核对 `Tool.listTools` |

## 8. 未验证项汇总（禁止在 Phase 1 之前当作可用）

1. 本插件自定义 `ctx.tools.register` 工具在模型侧可见（2.1/2.2/7.7）。
2. `guard` 拒绝路径、`restrict` 实际权限收敛（2.3/2.4）。
3. `ctx.schedule` 的到点唤醒/投递链路（仅接口 + 子代理拒绝已验证，2.7）。
4. `ctx.llm.stream` 在 `deepseek-account` 路由下的真实流式调用（2.9）。
5. `ctx.storage` / `systemPrompt` / `approval` / `fs` / `subprocess` 的业务级用法（2.11–2.15）。
6. 独立 persona/session/workspace 的组合创建（3.4）。
7. Codex 真实委派运行与取消（4.8）。
8. `plugin_manager.install_bundle` 端到端（5.3）。
9. 微信运行态、pywinauto 安装、UIA 控件树、朋友圈读写（6.2/6.4/6.6）。

## 9. 2026-10-25 rc.3 复核

基线从已安装 **0.2.1-rc.2** 升级为**正在运行的 0.2.1-rc.3**（`D:\dsh`，build `be72761e`，Electron 44.7.0，Cordis 4.0.5）。
完整报告：[DSH_0_2_1_RC3_COMPAT.md](DSH_0_2_1_RC3_COMPAT.md)；证据目录：evidence/compat-rc3/（本机验收存档）。

**结论：插件 0.2.6 的消费面契约 0 漂移，无 UNSUPPORTED，无需改代码。**

| 复核项 | rc.3 结论 | 证据 |
| --- | --- | --- |
| 入口形式 `name/inject/apply`（无 default export） | VERIFIED（活体插件条目已激活） | `cordis_inspect_query(host, Config, listConfigs, name="dsh-moments-agent")` → `include:dsh-moments-agent` |
| `ctx.tools.register`（ToolDefinition/ToolOutputDefinition/ToolSchema） | VERIFIED（活体 17 个 `moments_*` 工具在 `Tool.listTools`） | `evidence/compat-rc3/live-tool-registry.txt` |
| `ctx.tools.guard` 拒绝路径（Phase 0 未验证项 2） | **VERIFIED（活体拒绝）**：外部会话调用 `moments_health` → `POLICY_DENIED：仅独立朋友圈会话可调用此工具` | `evidence/compat-rc3/live-runtime-evidence.md` §3 |
| `ctx.tools.restrict({allow})`（Phase 0 未验证项 2） | **VERIFIED（活体）**：setup 内 restrict 未抛错（rc.3 要求 scoped ctx、未知名抛错） | `evidence/compat-rc3/dedicated-session-evidence.md` §6 |
| `ctx.llm.stream` 真实流式调用（Phase 0 未验证项 4） | **VERIFIED**：上一次 rc.3 启动完成 选题→文案→模型复核→审批（DB 2026-10-25T04:29:07–04:29:15Z），`/api/health` llm ok（text+image） | `evidence/compat-rc3/live-runtime-evidence.md` §4 |
| 独立 persona/session/workspace 组合创建（Phase 0 未验证项 6） | **VERIFIED**：`b77442db-…` 会话在本轮 rc.3 启动被 `agents.resume()` 成功恢复（DB 写入时刻=启动+5 s；会话 header v4；preset `dsh-moments` 已绑定） | `evidence/compat-rc3/dedicated-session-evidence.md` |
| `agents.create/resume` 契约（CreateAgentOptions/ResumeAgentOptions/AgentHandle） | IDENTICAL（rc.2↔rc.3 目录机器比对） | `evidence/compat-rc3/contract-catalog-diff.md` |
| `agentPresets.register(PresetDefinition)` | IDENTICAL + VERIFIED（preset 落到会话 header/projcache） | 同上 |
| `systemPrompt.section(PromptSection)` | IDENTICAL + VERIFIED（setup 内注册成功） | 同上 |
| `attachments.saveImages` | 契约 IDENTICAL；**活体调用 UNKNOWN**（本次未发带图请求，`/api/health` 显示模型支持 image） | `contract-catalog-diff.md`、`live-runtime-evidence.md` |
| 会话格式 v4 / 迁移路径 | rc.3 `currentVersion=4`，codecs v0–v4，migrations v0→v4；本会话 header v4 → 无需迁移 | `evidence/compat-rc3/dedicated-session-evidence.md` §4 |
| 全目录漂移（非消费面） | 98 服务数量相同；共享类型 1053 中仅 `ProductEventMap` 不同（遥测）；rc.3 新增 `AnalyticsPreset`（均未被插件使用） | `contract-catalog-diff.md` |
| `DSH_DESKTOP_VERSION`/`DSH_VERSION` 版本自检钩子 | **DRIFT（诊断级，非阻塞）**：两个环境变量在 rc.2/rc.3 均不存在，活体 `moments_health.dshVersion = null`；rc.3 实际注入的是 `DSH_CLIENT_VERSION` | `evidence/compat-rc3/environment-identity.md`、`DSH_0_2_1_RC3_COMPAT.md` §0 O1 |
| Host 启动日志落盘 | 无持久化 sink（`app.getPath('logs')` 仅 crash report 且为空）→ 插件启动错误无法事后检索（UNKNOWN，需行为反证） | `evidence/compat-rc3/host-log-channel.md` |
| Node 测试基线（插件 0.2.6） | typecheck 0 错；`tests 203 / pass 202 / fail 0 / skipped 1`；verify 17 工具全通过 | `evidence/compat-rc3/baseline-commands.md` |

未被本次复核提升的 Phase 0 未验证项：`ctx.schedule`（本插件未使用，改用 `ctx.timer`）、`ctx.storage`/`approval`/`fs`/`subprocess` 业务级用法、
Codex 子智能体、`plugin_manager.install_bundle`、微信运行态与朋友圈读写（6.2/6.4/6.6）——这些与本插件 rc.3 兼容性判定无关，仍按原状态保留。
