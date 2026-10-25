# PHASE0_GATE.md — Phase 0 门禁结论与降级路径

- 项目：DSH Moments Agent（DeepSeek Harness 插件 + Windows 微信朋友圈）
- 审计对象：DSH 桌面版 **0.2.1-rc.2**（`D:\dsh`），profile `desktop`，Windows 10 Pro 25H2（26200）
- 审计时间：2026-10-20（Asia/Shanghai）
- 依据文档：[ENVIRONMENT.md](ENVIRONMENT.md)、[COMPATIBILITY_MATRIX.md](COMPATIBILITY_MATRIX.md)
- 一句话结论：**GATE = CONDITIONAL GO。插件/工具/Codex 文本/调度接口可进入实现；图像生成与"自动发朋友圈"不可进入实现，必须降级为"人工确认 + Mock 执行器"；微信桌面执行器状态为 NOT_TESTED。**

## 1. Gate 记分板

| Gate | 主题 | 结论 | 状态依据 |
|---|---|---|---|
| G0 | 目标环境（OS/运行时/网络/SQLite） | **PASS** | 自带 Node 24.21.0、pnpm 11.28.5、Python 3.12.14 实测可用；`node:sqlite` 通过；Node/Python 网络 200。注意 PATH 上的 node/python 与之不同 |
| G1 | 插件入口与工具注册接口 | **PASS（接口级）** | `apply(ctx, config)`、`export const inject`、`export const Config` 均有已装真实样例；`ctx.tools.register(ToolDefinition)` 精确契约；Host 活体注册了 40+ 工具 |
| G1b | 本插件工具安装后端到端 | **DEFERRED → Phase 1** | 本会话 approval 被禁用、任务禁止安装插件；`plugin_manager.install_bundle` 未执行 |
| G2 | 定时/调度与后台唤醒 | **CONDITIONAL PASS** | `ctx.timer`、`ctx.schedule` 契约完整；但实测**委派子代理会话不能创建提醒**（`subagent_session`）；到点唤醒链路未实测 |
| G3 | Codex 子智能体 | **PASS（仅文本）/ UNSUPPORTED（图像）** | 已装 provider + `subagent_codex` 工具；只接受文本、返回文本、可取消、cwd 明确；无任何图像生成能力 |
| G4 | Agent Preset 与独立会话/工作区 | **PASS（接口级）** | `agentPresets` 12 方法、4 个 shipped preset 活体行、`agent/created` serial 事件、`CreateAgentOptions.meta.cwd/agentPreset`、`workingDirectory.set` |
| G5 | Windows 微信与 GUI 自动化 | **FAIL / NOT_TESTED → 必须降级** | 微信 4.1.15.13 已安装但未运行；pywinauto/uiautomation/comtypes 未装；pip 通道挂起；微信 4.x UIA 树未验证 |
| G6 | 网络与外部依赖 | **PASS（有约束）** | Node fetch / Python urllib 正常；curl/Invoke-WebRequest 因 schannel 失败，不能作判据；pip 不可用 |

**门禁裁决：允许开工，但交付物边界如下：**

- 允许：Host 插件骨架、Config、工具注册、persona/session 设计、Codex 文本子任务、PREPARE_ONLY 的内容生成与审批界面。
- 允许但不承诺：`ctx.schedule` 后台唤醒（需在根会话验证）、自动发布（需人工确认）。
- 禁止：宣称"已能自动发朋友圈"；宣称"Codex 能生成配图"；在未授权 profile 中安装插件或改 profile 配置。

## 2. 最小可用代码骨架（Host 插件 + 工具注册）

### 2.1 bundle 包清单

`package.json`（关键字段；完整格式见 `host-plugin.md:9-18`）：

```json
{
  "name": "dsh-moments-agent",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.js", "./cordis.patch.yml": "./cordis.patch.yml" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.5",
    "@deepseek-ai/schemastery": "^3.18.5"
  }
}
```

`cordis.patch.yml`（insert 语法，来自已装样例 `dsh-posterflow-ai/cordis.patch.yml:13-23`、`@deepseek-ai/dsh-subagent-codex/cordis.patch.yml:1-9`）：

```yaml
- insert:
    - id: dsh-moments-agent
      name: dsh-moments-agent
      config:
        enabled: true
        publishMode: PREPARE_ONLY
```

### 2.2 `index.js`（最小注册，已按 0.2.1-rc.2 契约书写）

```js
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-moments-agent'
/** 只声明硬依赖；可选服务用 ctx.get('svc') 判空。 */
export const inject = ['tools']

/** 部署期配置；对应 patch 里的 config 行，整行替换、按默认值补全。 */
export const Config = z.object({
  enabled: z.boolean().default(true),
  publishMode: z.union([z.const('PREPARE_ONLY'), z.const('MANUAL')]).default('PREPARE_ONLY'),
  dataDir: z.string().default('data'),
  maxCandidatesPerRun: z.number().step(1).min(0).max(10).default(2),
})

/** 诊断用工具：先证明"注册 → 模型可见 → 可执行"整条链路。 */
export function apply(ctx, config) {
  if (!config.enabled) return

  ctx.effect(() => ctx.tools.register({
    name: 'moments_probe',
    description: '读取 Moments Agent 当前模式并回显，用于验证插件工具注册链路。',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: '任意回显文本' } },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { mode: { type: 'string' }, echo: { type: 'string' } },
        required: ['mode', 'echo'],
        additionalProperties: false,
      },
      // ContentBlock[]：文本块形状为 { type: 'text', text }（dsh-llm TextBlock）
      render: (_args, value) => [{ type: 'text', text: `${value.mode}: ${value.echo}` }],
    },
    async execute(args, exec) {
      // exec: ToolRunContext（含 signal、deferContext、concludeTurn）
      exec.signal?.throwIfAborted?.()
      return { mode: config.publishMode, echo: String(args.text) }
    },
  }), 'moments-probe-tool')
}
```

要点（全部有契约依据）：

- 函数插件必须 `named export name/inject/Config/apply`，**不要 default export**（upstream `packages/AGENTS.md` 插件导出规则；`host-plugin.md:57-64`）。
- `ctx.effect(() => ctx.tools.register(...))` 返回 disposer，fiber 卸载即清理（`fiber.ts:402-418`；posterflow `:223`）。
- `parameters` 是普通 JSON Schema 对象（`ToolSchema.parameters: Record<string, unknown>`），不是 zod。
- `output` 必填：`{ schema: JsonSchemaNode; render(args, value): ContentBlock[] }`（`ToolOutputDefinition`）。
- 工具名不可用保留名 `run_code`；同名重复注册会失败（`tools.register` 契约）。

### 2.3 Config 写法与校验

1. 只写 `z.object(...)`，字段默认值即"未配置时的行为"。
2. patch 的 `config` 与 schema 字段一一对应；**整行替换、不深合并**（`cordis-composition-reference`、`host-plugin.md:3`），覆盖时重述全部字段。
3. 安全敏感字段默认关闭：`publishMode: PREPARE_ONLY`、`killSwitch: false`、`officialApiEnabled: false`、`desktopExecutor.enabled: false`（与仓库 `dsh-moments-agent/cordis.patch.yml` 一致）。
4. 安装后用 `cordis_inspect_query(host, Config, listConfigs, {name:"dsh-moments-agent"})` 取投影 schema 核对，别猜。

## 3. 调度与后台唤醒的 Gate 结论（G2）

已验证：

- `ctx.schedule.create(sessionId, request, signal?)`、`list/catalog/history/delete/update` 契约完整；`ScheduleCreateRequest` 支持 `after_seconds/at/every_seconds/daily/weekly/cron`。
- 活体工具 `schedule_create/list/update/delete` 存在，说明调度管线在运行。

关键限制（本次实测）：

```text
schedule_create(after_seconds=1800, ...) ->
{"code":"subagent_session","message":"A delegated subagent cannot use reminders."}
```

- **委派子代理（teammate/subagent）会话不能创建提醒**：调度必须由根会话或 Host 服务发起。若把定时器做在 teammate 会话里，运行期必然失败。
- 到点投递依赖 `ctx.sessions.flush()` 的持久化监听；"后台唤醒一个已休眠会话"本次未观测。

降级路径：

1. 调度器作为 **Host 插件服务**（`apply` 内用 `ctx.schedule` + 持有目标 sessionId），不接受子代理调用。
2. Phase 1 先在根会话做一次 `after_seconds≈60` 的冒烟，观测 `schedule/changed` 事件与投递；未通过前，默认 `scheduleEnabled: false`（与现有 patch 默认一致）。
3. 进程内失败兜底：`ctx.timer.interval` 轮询 + 手动"立即生成"按钮；不把唯一触发路径押在 schedule 上。

## 4. Codex 使用边界（G3）

- 能力：文本任务 → 全新 Codex 进程/线程/单轮 → 返回所选回答文本；支持 `cwd`、`model`、`permissionMode`、`env`；取消以 `aborted` 结算；完成走 `subagent/end` 通知。
- 限制：一次性（不支持追加输入/恢复/池化/进度流）；子级与父级共享 workspace 写入；**没有任何图像生成能力**。
- 项目用法：只用它做"文案起草/评审/结构化文本"子任务；配图必须走独立图像通道（manual-subscription / local-import，默认 officialApiEnabled=false）。
- 失败处理：区分 `limit/access-policy/service/transport/product-error/invalid-result/unknown/process`；无宿主 CLI 回退，失败即降级为本地模板文案。

## 5. Windows 微信与桌面执行器（G5）— 明确降级

### 5.1 事实

- 已安装：`D:\tencent\Weixin\Weixin.exe` **4.1.15.13**（用户数据在 `Documents\WeChat Files`，2 个 wxid）。
- 运行态：未运行；旧 3.8 卸载注册项指向不存在的 `D:\tencent\WeChat\WeChat.exe`（目录为空）。
- 自动化依赖：`pywinauto/uiautomation/comtypes/pyautogui` 在自带 Python 3.12.14 与 PATH Python 3.11.2 中**均未安装**；PyPI 可达但 `pip download/dry-run` 挂起 >90 s（两次）。
- UIA 运行时存在（`UIAutomationCore.dll` 7.2.26100.8875），但微信 4.x 的控件树未验证。

### 5.2 Gate 结论

**桌面自动发布 = NOT_TESTED，不允许作为 Phase 1 的交付承诺。**

### 5.3 降级交付（Phase 1 默认）

1. `publishMode` 默认 `PREPARE_ONLY`：内容生成 → 审批卡片 → 用户在朋友圈手动发布（复制文案/图片）。
2. `desktopExecutor.enabled` 默认 `false`；执行器接口与 Mock 先交付：
   - 接口：`prepare(post) -> { body, images[], target }`、`publish(prepared) -> receipt`。
   - Mock：本地 HTTP（默认 `http://127.0.0.1:18765`）记录调用、返回成功回执；不接触真实微信。
   - 契约测试：只断言"请求结构/状态机/审批留痕"，不断言微信行为。
3. 微信读取（朋友圈/聊天）同样按 NOT_TESTED：WeChatAgent 侧车结论由独立审计任务给出；DSH 侧只定义 `ReaderPort` 接口 + Mock。
4. 解除条件（全部满足才允许打开真实执行器）：
   - pywinauto（或等效 UIA 客户端）可用，且 `pip` 或离线 wheel 安装成功并被记录；
   - 微信运行态窗口/控件树被实际枚举（附 class/name 证据）；
   - 在测试账号上完成一次"读取 → 生成 → 人工确认 → 发布"的端到端演练；
   - 有 kill switch 与每日上限/静默时段/审批 TTL 的实证。

## 6. 允许进入实现的功能清单（Phase 1 白名单）

| 功能 | 依赖 | 验证方式 |
|---|---|---|
| Host 插件骨架 + Config | G1 | `Config.listConfigs` 投影 + `Tool.listTools` 出现 `moments_probe` |
| persona/人设 prompt | G4 | 独立 preset 声明 + 新会话 transcript 核对 |
| 独立会话/工作区 | G4 | `ctx.agents.create({meta:{cwd,agentPreset}})` + `workingDirectory.set` |
| 文案生成（LLM） | G6 | `ctx.llm.stream` 包装，收集 text-delta 至 finish |
| Codex 文案评审 | G3 | 文本任务，记录 childId 与最终文本 |
| 内容审批（人工） | G1/G2 | 工具/命令 + `ctx.approval` 仅作记录，不作自动放行 |
| 调度（根会话） | G2 | 根会话 `schedule_create` → 到点事件 → 生成 |
| 图像人工/本地导入 | G3 降级 | 文件选择/路径校验，不走 Codex、默认不走官方 API |
| PREPARE_ONLY 发布包 | G5 降级 | 生成可复制文案 + 图片路径 + 审批留痕 |
| Mock 桌面执行器 | G5 降级 | 本地 HTTP 契约测试 |

## 7. 明确禁止 / 需要 Lead 决策的事项

1. 禁止在未授权 profile 中 `plugin_manager install_bundle`、禁止手写 profile `package.json`/`cordis.patch.yml`（本 Phase 规则）。
2. 禁止把 `subagent_codex` 当图像生成器使用。
3. 禁止在 teammate/subagent 会话内创建 schedule（实测拒绝）。
4. 禁止以"微信已安装"推导"已可自动发朋友圈"；文档与 UI 必须显示 NOT_TESTED/PREPARE_ONLY。
5. 禁止修改 `D:\dsh插插\upstream`；源码只读。
6. 需要 Lead 决策：Phase 1 是否申请一次受控的 `install_bundle`（安装 `dsh-moments-agent` 自身）来关闭 G1b/G4 的验证缺口。

## 8. Phase 1 开工前 15 分钟冒烟清单

1. `node -e` 用自带 Node 24.21.0 跑 `node:sqlite` 冒烟（已通过，回归即可）。
2. `cordis_inspect_query(host, Config, listConfigs, {name:"dsh-moments-agent"})` → 确认插件行 schema 无误。
3. `cordis_inspect_query(host, Tool, listTools)` → 确认 `moments_probe` 出现（安装后）。
4. 根会话 `schedule_create(after_seconds: 60)` → 等 70 s → 确认投递；再 `schedule_delete` 清理。
5. `subagent_codex` 最小文本任务：`cwd` 指向临时目录，断言返回文本非空；记录耗时与 stop reason。
6. Mock 执行器：`pwsh` 起本地 HTTP 服务，跑一次 `prepare/publish` 契约测试。
7. 微信侧：仅做进程/版本探测，不启动、不注入、不自动化。

## 9. Gate 重新打开（Re-gate）条件

- G1b：安装成功且 `Tool.listTools` 出现自定义工具、执行一次并得到预期 `ContentBlock[]` → 可把 2.1/2.2 从"接口 VERIFIED"升级为"运行 VERIFIED"。
- G2：根会话到点投递被观测到（附时间戳/事件）→ 可把"后台唤醒"从 EXPERIMENTAL 升级为 VERIFIED；仍禁止子代理会话创建。
- G4：独立 preset + 独立 cwd 的新 agent 创建成功，transcript 体现 persona 与独立工作区 → 升级 VERIFIED。
- G5：§5.3 四条解除条件全满足 → 才允许打开真实桌面执行器；否则保持 Mock + PREPARE_ONLY。
- G3 图像：只有在 DSH 侧接入独立图像通道并通过一次真实出图后，才可宣称"可生成配图"；Codex 永远不满足该项。

## 10. 审计证据索引（便于复核）

- 环境/运行时/网络/微信：`docs/audit/ENVIRONMENT.md` §1–§11。
- 接口精确签名：`cordis_inspect_query(host, Service, listService, {service})`（tools/timer/schedule/llm/storage/subagents/systemPrompt/approval/fs/subprocess/agentPresets/agents）；`host, Event, listEvents`；`host, Config, listConfigs`；`host, Tool, listTools`。
- 已装插件源码：`C:\Users\10575\.dsh\profiles\desktop\node_modules\dsh-posterflow-ai\lib\index.js`、`...\@deepseek-ai\dsh-subagent-codex\{package.json,README.zh.md,lib/index.js,lib/types/*.d.ts,cordis.patch.yml}`、`...\dsh-whale-widget\cordis.patch.yml`。
- Asar 内文档：`D:\dsh\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-agent-preset\skills\cordis-plugin-development\references\host-plugin.md`；`...\dsh-web-app\presets\minimal.patch.yml`。
- Cordis 4.0.5 源码：`D:\dsh插插\upstream\deepseek-harness\vendor\cordis\src\{context,registry,fiber,events}.ts`（tag `dsh-v0.2.1-rc.2`，HEAD `687f282e`）。
