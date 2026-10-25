# DSH Moments Agent · Web 客户端（client/web）

现代桌面级 Web 管理客户端，替代 Tkinter 成为默认图形界面。原生 HTML / CSS / JavaScript，
无框架、无构建、无 npm、无 CDN、无外部图片或字体；图标全部是内联 SVG。

- 页面入口：`http://127.0.0.1:18770/`
- hash 路由：`#/dashboard`、`#/setup`、`#/compose`（兼容 `#/create`）、`#/approvals`、`#/tasks`、`#/history`、`#/settings`
- 管理 API 通过本地服务的 `/proxy/api/*` 访问；管理令牌由服务端从 tokenFile 读取并注入，**前端永远拿不到 token**。
- 首次配置进度通过 `/api/client/setup-state` 持久化到 `client/setup-state.json`（只有步骤布尔值与完成时间，不含凭据）。

## 文件结构

```
client/web/
├── index.html      # SPA 壳：侧边栏、顶栏、内联 SVG 图标 sprite、Toast/Modal 挂载点
├── styles.css      # 设计系统 + 全部页面样式 + 响应式（深色 SaaS / 蓝紫渐变 / 玻璃拟态）
├── app.js          # 路由、API 封装、15s 轮询、页面渲染、Modal/Toast、错误归一化
├── README.md       # 本文件
└── screenshots/    # 验收截图（概览 / 创作 / 待审批 / 任务 / 历史 / 设置 / 首次配置 / 窄窗口 / Modal）
```

## 启动

```powershell
# 使用已配置好的客户端服务（本项目默认 18770）
python client/server.py --no-browser --port 18770

# 然后用 Edge/Chrome 打开
start http://127.0.0.1:18770/
```

也可以直接使用项目根目录的 `Start-Moments-Client.cmd`。

`client/server.py` 是静态服务 + 代理，**不属于前端交付物，本目录不修改它**。
浏览器只访问 `127.0.0.1:18770`，管理 API（默认 `127.0.0.1:18766`）只被服务端以注入令牌的方式访问。

## 页面与功能

### 首次配置 `#/setup`
- 8 步「从零到第一条真实朋友圈」教程：A 插件/管理 API → B WeChatAgent → C 代理规则模式 → D 账号复用 → E 桌面执行器（geometry + OCR，管理员）→ F 插件 token 与发布模式 → G 第一条演练（只准备不发表）→ H 第一条真实发布 + 核验/回滚
- 每步包含：目标、前置条件、可一键复制的完整命令/配置、预期结果、失败排查项、相关错误码、完成勾选
- 顶部「环境自检」并行读取 `client/info`、`health`、`status`、`config`，渲染通过/注意/未通过检查项；每项可展开查看原因与「查看第 X 步」，不伪造通过
- 进度条 + 步骤时间线；勾选即写入 setup-state，刷新/重启保留；全部勾选后可「完成配置」，完成页展示进入概览与安全边界摘要
- 常见错误速查：TOKEN_MISSING、ADMIN_API_UNREACHABLE、ACCOUNT_MISMATCH、CLIENT_VERSION_UNSUPPORTED、PUBLISH_MODE_DISABLED、PRIVILEGE_REQUIRED、OCR_UNAVAILABLE、EDITOR_NOT_OPENED、PUBLISH_UNCERTAIN、CONTENT_CHANGED、微信「文字未发送」等，按「现象 / 原因 / 处理」展示
- 首次启动（`client/moments-client.json` 缺失或 setup-state 未完成）在概览页弹出「欢迎 / 自动配置」Modal：只读检测并预览插件配置，写入必须勾选二次确认（详见下节）；「稍后」按客户端版本写入 localStorage，不再自动弹出，可在本页「自动配置本机环境」重新打开；旧的全屏向导仅在首次启动接口不可用时兜底
- 命令中的项目路径 / DSH Python / wxid 为本机验证值，换机器请替换为实际值；页面只读取健康状态并保存进度，不会批准、准备或发表
- **第 06 步「自动配置插件（推荐）」卡片**：只读检测本机 DSH profile / WeChatAgent 并预览将要写入的 `cordis.patch.yml` 插件条目（折叠只读 `<pre>`，含路径不含令牌），展示 profile、patch 路径、dataDir、Reader/Hook 地址、账号（掩码）、模型、changedFields、warnings / errors；「写入配置（先备份）」经 Modal 二次确认（明确会替换该插件条目、不改其他插件、先自动备份、重启 DSH 后才生效）后才调用写入端点，成功后展示备份路径与重启提醒，失败展示中文原因。检测/预览不写文件，写入不会自动执行；多 profile 环境可在卡片内填 profile 名称重新检测。检测失败或字段缺失时，下方手工教程完整保留可回退

#### 首次启动自动配置引导（欢迎弹窗）

- 触发：`client/moments-client.json` 缺失或 setup-state 未完成；`server.py` 打开浏览器时给 URL 加 `?firstrun=1`（hash 路由不受影响），前端启动后读取 `GET /api/client/first-run`（只读；`?refresh=1` 强制重算）。
- 弹窗内容：只读检测结果（profile、patch 路径、dataDir、Reader/Hook、微信账号掩码、模型、changedFields、warnings / errors、可展开只读 YAML 预览）；检测 pending 时显示加载态并自动轮询（最多 4 次），不阻塞页面。
- 按钮行为：
  - **一键自动配置（先备份）** → 再弹二次确认 Modal：必须勾选「我已核对预览」才可提交，明确说明会整块替换该 profile 的 `dsh-moments-agent` 条目、不动其他插件/注释/`!!js`、写前自动备份、写入后必须重启 DSH；确认后 `POST /api/client/auto-configure {apply:true}`。成功视图展示备份路径、`clientConfig`（baseUrl / tokenFile / dataDir）与「需重启 DSH」提醒，并记录 dismiss（下次不再自动弹）。
  - **按教程手动配置** → 关闭弹窗并跳到 `#/setup/config`（第 06 步手工教程）。
  - **稍后** → 按客户端版本写入 `localStorage`（`dsh-moments.firstrun-welcome.dismissed.<clientVersion>`），不再自动弹出；首次配置页「自动配置本机环境」可随时重新打开（不受 dismiss 限制）。
  - 检测失败 / 自动配置模块未就绪 / 首次启动接口不可用：显示中文原因并提供手工教程入口，可继续进入应用；接口完全不可用时回退旧全屏向导（setup-state 未完成时）。
- **绝不静默写入**：检测与预览只读；只有勾选二次确认后的 `apply=true` 才会写文件。取消二次确认会回到欢迎弹窗，不发起写请求。

### 概览 `#/dashboard`
- Hero：整体健康状态 + 一句话说明 + 模式徽章 + 「生成草稿 / 查看待审批」快捷入口
- 系统健康：数据库 / 模型 / 微信通道 / 桌面执行器 / 图像 Provider 状态灯与中文说明
- 控制状态：发布模式、暂停、Kill Switch、自主调度、所有者通道、待审批数量
- 任务分布：CSS `conic-gradient` 圆环 + 图例条形，不引第三方图表库
- 最近任务：状态色、主题、草稿版本/语气、相对时间，点击直达任务详情
- 待审批提醒：正文摘要、审批 ID、过期倒计时、快捷核对入口

### 创作 `#/compose`
- 表单：主题、来源类型（与插件 `SOURCE_TYPES` 对齐）、来源依据、创作动机
- 一键工作流进度：选题 → 文案 → 审核 → 申请审批（生成中显示骨架屏与已用时）
- 结果卡：正文全文、语气、字数、审核 notes、风险标记、审批 ID/过期倒计时/完整 contentHash、复制全文、跳转待审批/任务
- 模型返回 `silent=true` 时展示「这次选择沉默」及原因，不创建任务
- 不会准备朋友圈，更不会发表

### 待审批 `#/approvals`
- 左列表：状态、审批 ID、正文摘要、内容哈希前 16 位、过期倒计时
- 右详情：正文全文、图片预览（`/proxy/api/assets/{id}/raw`）、完整内容哈希、素材清单哈希、可见范围、目标账号、审批渠道、创建/过期时间
- 批准 / 拒绝都必须二次确认：
  - 批准 Modal 展示**完整 contentHash**，提示「改写文案/图片/可见范围/账号会导致审批失效」，必须勾选「我已核对」后按钮才可用
  - 拒绝 Modal 可填写原因（写入审计）
- 错误码原样展示（例如 HTTP 500 无 errorCode 时展示 `HTTP_500`，不伪造成功）

### 任务 `#/tasks`
- 筛选 chips：全部 / 待审批 / 已批准 / 已准备 / 失败·异常 / 已发表
- 左列表 + 右详情：状态时间线（基于 `audit` 事件，最新一条高亮）、想法、草稿与历史版本、素材缩略图、审批记录、发布尝试/核验结果、图片任务、技术标识
- 操作：重写并审核、只审核、申请审批、准备（不发表）、发表、取消、核验
- 「准备」需要 `APPROVED`；「发表」在 `PREPARE_ONLY` 下为**禁用样式**，悬停提示「当前为 PREPARE_ONLY，仅准备图文，不点击发表」；`APPROVAL_REQUIRED` 等允许模式下才会打开二次确认 Modal，并在其中展示完整 contentHash 与后端错误（如 `PUBLISH_MODE_DISABLED`），不伪造成功

### 历史 `#/history`
- 已发表时间线（正文、可见范围、核验状态、哈希、账号）
- 候选主题列表（来源类型、时间、novelty、跳转任务）
- 空状态文案友好，说明当前发布模式

### 设置 `#/settings`
- 连接与运行：客户端服务/版本、管理 API、插件版本、数据库、令牌文件**路径与是否存在**、数据目录
- 安全说明：**不显示令牌内容，不写入浏览器存储 / 日志 / 截图**
- 客户端配置：`baseUrl` / `tokenFile` / `dataDir`，保存到 `/api/client/config`（写入 `client/moments-client.json`，不含令牌）
- 所有者控制：暂停 / 恢复、Kill Switch 启用 / 解除，全部二次确认；展示策略摘要（每日上限、最小间隔、静默时段、审批有效期等）
- 人格与配图风格：在本地数据库中编辑 SOUL / 视觉风格并保存（POST `/proxy/api/persona`，仅本机回环；内容不会发送到外部服务）
- **社交记忆**：总开关与「包含私聊」开关、会话/消息/人物印象统计、立即同步（展示新消息数、印象更新数、跳过原因）、会话与人物印象列表；成员印象可编辑（别名 / 摘要 / 标签 / 话题 / 风格）或删除，会话可整体清除。默认关闭，只有显式开启后才读取插件白名单内的群聊（私聊需单独开启）；真实昵称只在本机页面展示，不进入提示词或朋友圈；数据来自 `/proxy/api/chat-memory*`（GET / POST settings / POST sync / PATCH·DELETE members / DELETE conversations）
- 配置引导：显示首次配置进度与百分比，可「重新打开配置教程」或「打开首次向导」
- 本地操作：打开数据目录、退出客户端（调用 `shutdown` 后显示「客户端已退出」）

## 技术约定

- **渲染安全**：所有动态数据只用 `textContent` / 文本节点；`app.js` 中没有任何 `innerHTML` 拼接（仅 index.html 内含静态 SVG sprite）。
- **错误归一化**：`fetch` + `AbortController` 超时（普通 20s、工作流 245s、compose/review 95s、社交记忆同步 245s），区分
  `network` / `timeout` / `auth(401 / TOKEN_MISSING)` / `proxy(ADMIN_API_UNREACHABLE)` / `server(5xx)` / `business(ok=false)`，
  业务错误码原样显示。
- **写操作代理**：`client/server.py` 对 `/proxy/api/*` 的 GET / POST / PATCH / DELETE 统一注入管理令牌（PATCH 转发 JSON 请求体），仍只接受本机回环请求并拦截跨站/rebinding；浏览器始终拿不到令牌。社交记忆的设置、修正、删除、清除会话走这些代理端点。
- **自动配置端点**：`GET /api/client/auto-configure` 只读检测并返回脱敏摘要；`POST /api/client/auto-configure`（body `{profile?, apply?}`，必须带 `X-Requested-With: DSHMomentsClient`）在 `apply=false` 时只重新检测、`apply=true` 时由服务端串行备份并原子写入选中 profile。模块缺失返回 503「自动配置模块未就绪」，前置条件错误返回 400 中文说明；页面不接触 `cordis.patch.yml` 文件本身，也不显示任何令牌正文。写入成功且检测到插件 `dataDir` 时，响应还会带 `clientConfig: {updated, baseUrl, tokenFile, dataDir}`（服务端同时更新 `client/moments-client.json` 与 `ClientState`，代理立即从新令牌路径读取）；该步骤失败只进 `warnings`，不影响插件配置。
- **首次启动端点**：`GET /api/client/first-run[?refresh=1]` 返回 `{firstRun, setupCompleted, configMissing, needsAutoConfigure, autoConfigure, reason, checkedAt}`；`needsAutoConfigure` 在首次启动且 `build_plan` 无 errors 并检测到 profile/patch 时为 `true`。自动配置检测在后台线程计算并缓存 10 分钟，端点最多等待约 5 秒，pending 时返回 `needsAutoConfigure: null` + `reason: "检测中"`；`autoConfigure` 只用 `public_summary` 脱敏摘要（不含令牌）。
- **轮询**：概览 / 待审批 / 任务每 15s 刷新；`document.hidden` 时停止轮询，回到可见时立即刷新；刷新为静默渲染，不打断阅读、不重放页面进入动画。
- **危险操作**：批准、拒绝、准备、发表、取消、暂停、恢复、Kill Switch、退出客户端全部走 Modal 二次确认；Esc 关闭、焦点陷阱、点击遮罩关闭（请求进行中禁止关闭）。`PREPARE_ONLY` 下发表按钮被禁用，不会发起提交；允许发表的模式下仍需二次确认并核对 contentHash。
- **审批决策条**：待审批详情底部的「拒绝 / 批准并锁定」为吸底操作条，正文与哈希滚动阅读时始终可见，不遮挡顶部标题与正文。
- **路由**：hash 路由，刷新保持当前页面；任务/审批选中项用 `history.replaceState` 同步到 URL（`#/tasks/<taskId>`、`#/approvals/<approvalId>`）；首次配置步骤同步为 `#/setup/<stepId>`。
- **首次配置状态**：`GET /api/client/setup-state` 返回 `{version,completed,completedAt,steps}`；`POST /api/client/setup-state` 支持 `{steps:{id:boolean}}` 与 `{completed:boolean}`，保存到 `client/setup-state.json`。前端只写这个端点（保存进度/完成），不调用批准、发表、取消、暂停等业务写接口；保存失败会回退勾选并原样展示错误码，不伪造成功。
- **自动向导**：`completed=false` 时，在概览页（`#/dashboard`）首次加载自动打开全屏向导；「稍后再说」只在本会话跳过，下次启动仍出现；完成或 `completed=true` 后不再自动打开。设置页与左侧导航可随时重新打开。**新版首次启动流程接管自动弹出**：`GET /api/client/first-run` 可用时由「欢迎 / 自动配置」Modal 负责（含 localStorage dismiss），只有该接口不可用时才回退到本全屏向导。
- **心跳**：浏览器首次产生用户交互后，每 20s 请求 `/api/client/ping`；服务端在心跳停止 60s 后自动退出（见 `server.py` watchdog）。
  未交互的纯自动化加载不会触发心跳，避免截图/巡检误关服务。
- **无外部依赖**：不使用 npm 包、CDN、外部字体或图片；字体使用系统 UI（Segoe UI / 微软雅黑）。

## 设计系统

`styles.css` 顶部用 CSS 变量集中管理主题：

- 背景 `#07080f`，主色渐变 `#5b8cff → #a06bff`；面板为半透明 + `backdrop-filter` 玻璃拟态
- 状态色：成功 `#3ddc97`、警告 `#ffb547`、危险 `#ff5d73`、信息 `#6aa6ff`、紫色 `#b18cff`
- 圆角 18px（卡片）/ 11px（按钮、输入）；细边框 `rgba(255,255,255,.085)`；柔和阴影
- 断点：`1280px`（卡片换行）、`1180px`（侧栏折叠为图标）、`980px`（双栏改单栏）、`760px`（紧凑顶栏）
- 动效克制：仅页面进入、Modal/Toast、骨架 shimmer；`prefers-reduced-motion` 下全部关闭

## 截图（验收）

以下截图由 Edge headless + CDP 生成（视口 1440×1000 / 窄窗口 1024×800），`screenshots/capture-report.json`
记录了标题、URL hash 与 `consoleErrors: []`（0 errors）；截图不包含管理令牌。

| 文件 | 页面 |
| --- | --- |
| `screenshots/01-dashboard.png` | `#/dashboard` 概览 |
| `screenshots/02-compose.png` | `#/compose` 创作 |
| `screenshots/03-approvals.png` | `#/approvals` 待审批列表 + 详情 |
| `screenshots/04-tasks.png` | `#/tasks/<真实任务 ID>` 任务详情（状态时间线 / 操作按钮） |
| `screenshots/05-history.png` | `#/history` 历史 |
| `screenshots/06-settings.png` | `#/settings` 设置（连接信息、令牌文件是否存在、控制、人格预览） |
| `screenshots/07-narrow-dashboard.png` | 1024×800 窄窗口概览，侧栏折叠为图标 |
| `screenshots/08-narrow-tasks.png` | 1024×800 窄窗口任务页 |
| `screenshots/09-approve-modal.png` | 待审批「批准并锁定」二次确认 Modal（完整 contentHash、核对勾选、未勾选时按钮禁用） |
| `screenshots/10-setup-overview.png` | `#/setup` 首次配置首屏（Hero + 环境自检 + 步骤时间线） |
| `screenshots/11-setup-step-executor.png` | `#/setup/executor` 某一步详情（完整命令 / 预期结果 / 排查） |
| `screenshots/12-setup-self-check.png` | 环境自检结果（检查项展开，显示真实通过与未通过项） |
| `screenshots/13-setup-complete.png` | 全部步骤完成后的完成页（安全边界摘要 + 进入概览） |
| `screenshots/14-setup-wizard.png` | 首次启动自动打开的全屏向导（概览页触发） |
| `screenshots/15-setup-narrow.png` | 1024×800 窄窗口首次配置页 |

截图不得包含管理令牌：本客户端从不把令牌写入 DOM，设置页只显示令牌文件路径与「存在/缺失」；配置教程命令只从文件读取令牌，不在截图里输出 token。

## 已验证 / 限制

已验证（对着 Live 管理 API 只读联调 + Node DOM 仿真跑通全部路由与关键交互）：

- health / status / tasks / approvals / history / persona / config / preview 均能渲染；
- `#/dashboard`、`#/setup`、`#/compose`（兼容 `#/create`）、`#/approvals`、`#/tasks`、`#/history`、`#/settings` 直接访问与切换均正常；
- 首次配置：8 步渲染、步骤选择与 `#/setup/<stepId>` 深链、环境自检（info/health/status/config 并行、通过/注意/未通过与错误码）、勾选写入 setup-state 并可回读、取消勾选回退、全部完成标记 `completed=true`、完成页、设置页入口、首次自动向导 + Esc/稍后再说；
- 首次启动自动配置引导（Edge headless CDP 实测 50+ 项交互全部通过、控制台 0 errors）：欢迎弹窗展示 profile / patch 路径 / dataDir / Reader / Hook / 掩码账号 / 模型 / warnings；二次确认勾选前不能提交且不产生任何写请求；取消二次确认回到欢迎弹窗；「稍后」写入带客户端版本键的 localStorage；首次配置页可重新打开；「按教程手动配置」跳转 `#/setup/config`；写入成功视图展示备份路径 + `clientConfig` + 「需重启 DSH」提醒；pending 加载态自动轮询转为就绪；检测失败降级为手工教程提示；已完成时不再自动弹窗。写入路径用 stub 拦截，未在真实 profile 上写文件；
- 首次配置第 06 步自动配置卡片：检测预览（未写入、可展开只读 YAML 块）、错误中文提示、写入按钮在检测成功前禁用、二次确认 Modal（核对勾选后才可点击）、写入成功展示备份路径 + 「需重启 DSH」提醒；测试中用假模块覆盖端点，不在真实 profile 上写文件；
- 任务与审批选择、批准 Modal（完整哈希、勾选解锁、Esc 关闭）、重写 Modal、暂停 / Kill Switch Modal；
- `PREPARE_ONLY` 下发表按钮禁用 + tooltip 说明，且不调用发表 API；
- 网络中断、401、`ADMIN_API_UNREACHABLE`、业务 `ok=false` 四类错误的界面区分；
- 社交记忆卡片：默认关闭引导、开关二次确认、统计与会话/人物印象渲染、立即同步结果（新消息/印象更新/跳过原因）、编辑与删除成员印象、清除会话、关闭后同步按钮禁用且修正禁用（删除仍可用）；用假管理 API + Edge headless CDP 实测 24 项交互全部通过（含无 JS 异常、仅假服务缺失的 `automation`/`writing-skills` 返回 404）；
- Edge headless 逐页截图控制台 0 errors；业务写 API（批准/拒绝/准备/发表/取消/暂停/Kill Switch）全程未调用；首次配置只写 `/api/client/setup-state`。

已知限制（前端范围之外或未纳入本版）：

- 社交记忆管理面依赖新版插件的 `/api/chat-memory*` 端点；旧版插件返回 404 时卡片显示明确错误，不伪造数据；
- 社交记忆默认关闭；管理面展示的会话真实名称与成员本机昵称仅在本机页面可见（不进入提示词或朋友圈），编辑/删除人物印象与清除会话只影响本地记忆数据；关闭总开关后仍可查看/删除已保存数据，但修正印象需先开启（与插件校验一致）；
- 首次配置进度依赖新版 `client/server.py` 的 `/api/client/setup-state`；旧版服务返回 404/不可用时，页面会显示明确错误且不伪造保存，仍可阅读教程；
- 首次启动自动配置引导依赖新版 `client/server.py` 的 `/api/client/first-run`；旧版服务不可用时回退旧全屏向导（setup-state 未完成时）或直接进入应用，不会静默写文件；自动配置写入仍依赖 `client/auto_configure.py` 与可写 profile；
- 首次配置自动配置卡片依赖 `client/auto_configure.py` 与新版 `client/server.py`；核心模块未就绪时端点返回 503「自动配置模块未就绪」，卡片显示中文错误且不写文件，手工教程仍可用；
- E 步的 `--driver geometry` / `--ocr-python` / `--geometry-allow-publish` 需要包含 geometry + OCR 的执行器版本；旧版 `desktop/server.py` 没有这些参数，教程已提示不要用旧版本真实发布；
- 教程里的路径、DSH Python、wxid、WeChatAgent 安装路径是本机验证值，换机器需替换；代理规则以 FengWo / FlClash 界面为准（C 步有 CSS 示意，不是真实截图）；
- 不提供图片生成 / 上传 / 素材审核界面（依赖插件与手动订阅桥），任务页只展示已有素材；
- 不提供 `uncertain/resolve` 的人工裁决按钮，仅提供「核验」；H 步给出 resolve 命令供所有者手动执行；
- 修改管理 API 地址后需要重开客户端（与服务端行为一致，界面已有提示）；
- 本地客户端服务被关闭后当前页面无法重连，需要重新启动客户端（错误横幅会给出明确提示）；
- 本仓库主客户端的 `adminServer` 若未启用，代理会返回 `TOKEN_MISSING` / `ADMIN_API_UNREACHABLE`，界面会原样展示。
