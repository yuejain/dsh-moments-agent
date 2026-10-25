# DSH Moments Agent 管理客户端

## 主客户端：现代 Web 客户端（推荐）

`Start-Moments-Client.cmd` 启动的是本地 Web 客户端（`client/server.py` + `client/web/`）：

- 暖白与青绿色界面，七页：概览 / 首次配置 / 创作 / 待审批 / 任务 / 历史 / 设置；
- **社交记忆管理**（设置页卡片）：默认关闭；开启后只读取 WeChatAgent 白名单内的群聊，私聊需单独开启「包含私聊」。可查看会话与人物印象（别名 / 本机昵称 / 摘要 / 标签 / 证据数 / 状态），编辑或删除成员印象、清除整个会话，并立即同步显示新消息数、印象更新数与跳过原因；聊天原文与真实昵称不进入提示词或朋友圈，管理面只在本机可用；
- **首次配置教程**：8 步从零到第一条真实朋友圈，含环境自检、可复制命令、错误速查；进度保存在 `client/setup-state.json`（无凭据）；
- **首次启动自动配置引导**：`client/moments-client.json` 缺失或首次配置未完成时，概览页弹出「欢迎 / 自动配置」Modal；只读检测 DSH profile、WeChatAgent、dataDir、Reader/Hook、账号（掩码）、模型与 warnings，「一键自动配置（先备份）」必须再勾选二次确认才会写入，「按教程手动配置」跳到第 06 步，「稍后」按客户端版本写入 localStorage 不再自动弹出；检测在后台线程计算（端点最多等待约 5 秒），失败降级为手工教程，不阻塞进入应用，绝不静默写文件；
- 本地服务 `http://127.0.0.1:18770/`，自动用 Edge/Chrome 应用窗口打开；
- 浏览器只访问本地客户端服务，管理令牌由服务端注入 `/proxy/api/*`，前端拿不到 token；
- 关闭应用窗口后，心跳停止，客户端服务自动退出；
- **管理员模式**：普通入口 `Start-Moments-Client.cmd` 与兼容入口 `Start-Moments-Client-Admin.cmd` 均自动请求 UAC，客户端与 geometry 执行器共用一个 Python 进程。注意：1.1.9 起几何驱动本身不再强制管理员——微信进程未提权时允许同完整性输入（独立 Python 执行器可非管理员运行，见 `desktop/README.md`）；客户端仍默认提权启动，属启动器选择而非协议要求；
- **三级发表模式**：设置页选择「仅准备不发表 / 审批后发表 / 不审批直接发表」，应用后同步插件与内置执行器并持久保存；需要 0.2.7 插件与 1.1.9 客户端，失败时降为仅准备。第三档的任务按钮直接执行准备和发表，显式开启的拟人化发送调度也可处理已审核内容；
- 打包件已包含 `desktop/` 执行器源码；执行器是客户端服务内的线程，关闭客户端时一起停止，不再拉起独立执行器进程。OCR 依赖用 `scripts/install-desktop-deps.ps1` 安装；
- 前端说明见 `client/web/README.md`。

```powershell
# 直接运行（不自动开浏览器）
D:\dsh\resources\runtime\primary-runtime\dependencies\python\python.exe client\server.py --port 18770 --no-browser
```

### 1.1.9 变化（配合插件 0.2.7）

- 版本号：客户端 `1.1.9`（`client/server.py` 的 `VERSION`），配套插件 `0.2.7`；模式同步协议不变。
- 内置 geometry 执行器启动时完成 Per-Monitor-V2 DPI 感知；微信窗口按 **1200×900 物理像素**归一化，朋友圈编辑器与右键「粘贴」菜单改用**屏幕捕获**（要求微信在前台，否则 `WINDOW_BLOCKED`），粘贴 fallback 偏移为 **(40,34)**。
- 管理员门禁改为自动：微信进程未提权时允许同完整性输入（1.1.9 EXE 仍默认请求 UAC 启动）；执行器健康状态暴露 `processDpiAwareness` / `geometryRequireAdmin` / `windowNormalization`。
- 第三档 `POLICY_AUTONOMOUS` 自动发表已于 2026-10-25 真机端到端验收通过 1 条，见 `docs/audit/AUTO_PUBLISH_LIVE_1_1_9.md`；真实删除/回滚仍未验收。
- 1.1.9 EXE 使用修复后的 geometry 驱动重新打包：`release/DSH-Moments-Client-1.1.9-win64-exe.zip`（插件包 `release/dsh-moments-agent-0.2.7.tgz`）；校验与签名记录见同目录 `DSH-Moments-Client-1.1.9-verification.json` / `-signature.json`。

**模式同步细节**：切换发表模式时，客户端先把内置执行器降为 `PREPARE_ONLY`（先拒绝发表），再调用插件 `POST /api/publish-mode` 取得权威模式，成功后才把 `mode / allow_publish / geometry_allow_publish` 应用到执行器；任一步失败（无令牌、网络/HTTP 错误、插件返回非法模式）都保持 `PREPARE_ONLY`，不会保留宽松权限。执行器 `mode` 必须与插件 `publishMode` 完全相等，否则执行器拒绝请求。

> 下方 Tkinter 说明保留为 legacy 参考；日常使用请用上面的 Web 客户端。

---

Windows 不能原地提升已运行进程；首次启动只重新启动整个客户端取得管理员权限。若启动失败，查看 `data/client-web.log`。端口被占用时明确报错，不会强杀未知进程或报告启动成功。诊断时可加 `--client-only` 仅启动 Web 代理。

## Legacy：Tkinter 客户端（保留）

本目录还保留一个 Tkinter 版本，让所有者不经过 DSH 对话框也能管理朋友圈 Agent：
查看健康状态、创作草稿并提交审批、预览/批准/拒绝、查看任务与发布尝试、查看历史、暂停/恢复/Kill Switch。

> **能力边界**：它是本机管理 API 的桌面壳，不替代 DSH 客户端，不直接读写 SQLite，
> 不绕过审批与发布状态机，不会自动发表，不会自动批准，不会静默重试写操作。

- 项目：`D:\dsh插插\dsh-moments-agent`
- 客户端版本：`0.1.0`（legacy）
- 语言/运行时：Python 3.11/3.12 + Tkinter 8.6，**仅标准库**（Pillow 仅可选，用于图片预览）
- 管理 API 契约：`docs/architecture/admin-api.md`（v1）

---

## 1. 启动

### 前置条件

1. DSH 正在运行，且已加载 `dsh-moments-agent` 插件；
2. 插件配置 `adminServer.enabled: true`（0.2.x bundle 默认已开启，当前发布为 0.2.7；用户可在 profile 补丁中覆盖为 false），管理 API 监听 `127.0.0.1:18766`；
3. 插件已自动生成管理令牌文件 `data/admin-token.txt`（文件不存在时启用/重载插件会自动生成）；
4. 若未启用 `adminServer`，客户端会明确提示“无法连接本机管理 API / 找不到管理令牌文件”，而不是崩溃。

### 方式 A：双击启动器（推荐）

```text
Start-Moments-Client.cmd
```

启动器会：

- `chcp 65001`，优先使用 DSH 自带 Python
  `D:\dsh\resources\runtime\primary-runtime\dependencies\python\python.exe`；
- 如果该路径不存在，回退到 PATH 中的 `python`；
- 启动前检查 `tkinter` 是否可用；
- 启动失败时 `pause` 并打印中文原因。

### 方式 B：直接用 DSH 自带 Python（含 tkinter + Pillow）

```powershell
cd D:\dsh插插\dsh-moments-agent
D:\dsh\resources\runtime\primary-runtime\dependencies\python\python.exe client\app.py
```

### 方式 C：系统 Python（tkinter 8.6，无 Pillow）

```powershell
cd D:\dsh插插\dsh-moments-agent
python client\app.py
```

### 其他参数（验收/排查用）

| 参数 | 说明 |
| --- | --- |
| `--config <路径>` | 使用指定的客户端配置文件（默认 `client/moments-client.json`） |
| `--check` | 只检查配置与连接并打印结果，不打开窗口（不打印令牌） |
| `--tab <0-5>` | 启动时直接打开指定页签：0 概览 / 1 创作 / 2 待审批 / 3 任务 / 4 历史 / 5 设置 |

示例：

```powershell
python client\app.py --check
python client\app.py --tab 3
```

---

## 2. 配置

默认配置在首次启动时使用内置默认值；在“设置”页点击“保存配置”后会写入：

```text
client/moments-client.json
```

配置字段（示例见 `client/moments-client.example.json`）：

```json
{
  "version": 1,
  "baseUrl": "http://127.0.0.1:18766",
  "tokenFile": "data/admin-token.txt",
  "dataDir": "data",
  "_comment": "本文件不保存管理令牌。"
}
```

- `baseUrl`：管理 API 地址，**只允许 http 回环地址**（`127.0.0.1` / `localhost` / `::1`）；
- `tokenFile`：管理令牌文件路径，相对路径按项目根目录解析；
- `dataDir`：数据目录（用于“打开数据目录”快捷入口）。

### 令牌安全

- 令牌**只在每次请求时**从 `tokenFile` 读取，不缓存、不显示、不保存；
- 令牌不写入 `client/moments-client.json`；即使旧配置里混入 `token` 字段，保存时也会被丢弃；
- 令牌不会出现在日志、异常文本、`--check` 输出或界面中；
- 客户端拒绝把请求发往非回环地址，避免令牌离开本机。

### 自动配置插件（推荐）

新用户不必手写 `cordis.patch.yml`：Web 客户端首次配置第 06 步提供「自动配置插件」卡片，检测 → 预览 → 二次确认 → 备份写入。

- 「检测本机环境」只读探测 DSH profile、插件安装位置、dataDir、WeChatAgent Reader/Hook 地址、微信账号（掩码）与模型，生成预览与 `warnings`；**检测不写任何文件**。
- 「写入配置（先备份）」经 Modal 二次确认（勾选确认后才可提交）：只替换/追加选中 profile 里的 `- id: dsh-moments-agent` 条目，其他插件条目、注释与 `!!js` 原样保留；写前生成 `cordis.patch.yml.<yyyyMMdd-HHmmss>.bak`，写临时文件后 `os.replace` 原子替换。
- **写入后不会立即生效**：必须重启 DSH（或重载 `dsh-moments-agent` 插件）；卡片与提示都明确写「需重启 DSH」，不假装已生效。
- 回退：关闭 DSH，把最近的 `.bak` 复制回 `cordis.patch.yml`（或删除新增的插件条目）后重新启动。重复执行是幂等的，备份照常生成、不会产生重复条目。
- 安全边界：不写入 Reader/Hook 令牌正文、密码、Cookie 或聊天内容，也不修改 WeChatAgent 的任何配置或文件；只处理检测/选中的 profile（多 profile 环境可在卡片里填 profile 名称）。自动配置失败或字段缺失时，下方手工教程完整保留可回退。

没有客户端时也可用命令行（默认只预览，`--apply` 才写）：

```powershell
cd D:\dsh插插\dsh-moments-agent
python -X utf8 -m client.auto_configure                  # 只检测并打印预览
python -X utf8 -m client.auto_configure --apply          # 备份并写入选中 profile
python -X utf8 -m client.auto_configure --apply --json   # 机器可读结果
python -X utf8 -m client.auto_configure --profile work --apply
```

对应本机端点：`GET /api/client/auto-configure`（只读预览）与 `POST /api/client/auto-configure`（body `{profile?, apply?}`，需 `X-Requested-With: DSHMomentsClient`）；模块未就绪返回 503「自动配置模块未就绪」，前置条件错误返回 400 中文说明。完整契约见 `docs/operations/AUTO_SETUP.md`。

#### 首次启动自动配置引导（客户端 / EXE）

- 只读端点 `GET /api/client/first-run`（可加 `?refresh=1` 强制重算）返回
  `{firstRun, setupCompleted, configMissing, needsAutoConfigure, autoConfigure, reason, checkedAt}`：
  `configMissing` = `client/moments-client.json` 不存在；`setupCompleted` = setup-state 的 `completed`；
  `firstRun` = 两者任一不满足。`autoConfigure` 为 `public_summary` 脱敏摘要（不含令牌），检测失败/模块未就绪时为 `null`。
- **检测不阻塞启动**：自动配置检测（Reader 探测可能 3s 超时）在后台线程计算，结果缓存 10 分钟；
  端点最多等待约 5 秒，超时返回 `needsAutoConfigure: null` + `reason: "检测中"`，前端显示加载态并轮询。
  `run_server` 在首次启动时给浏览器 URL 加 `?firstrun=1` 标记（hash 路由不受影响），并在打开浏览器时预触发检测；
  `--no-browser` / 诊断模式不做预触发。
- **欢迎弹窗**：前端启动后展示检测结果（profile、patch 路径、dataDir、Reader/Hook、微信账号（掩码）、模型、warnings / changedFields 与只读 YAML 预览）。
  - 主按钮「一键自动配置（先备份）」→ 复用二次确认 Modal（说明会整块替换该插件条目、不动其他插件/注释/`!!js`、先自动备份、必须重启 DSH）→
    `POST /api/client/auto-configure {apply:true}`；成功后展示备份路径、「需重启 DSH」提醒，并记录 dismiss。
  - 次按钮「按教程手动配置」→ 关闭弹窗并跳转 `#/setup/config`（第 06 步手工教程）。
  - 「稍后」→ 按客户端版本写入 localStorage（`dsh-moments.firstrun-welcome.dismissed.<version>`），不再自动弹出；
    可在「首次配置」页点「自动配置本机环境」重新打开。
  - 检测失败 / 模块未就绪 / 接口不可用时降级为教程提示，可继续进入应用；旧的全屏教程向导仅在首次启动接口不可用时兜底。
  - **绝不静默写入**：检测与预览只读；只有勾选二次确认后的 `apply=true` 才写文件。
- **写入后同步客户端连接配置**：`apply` 成功且从检测结果得到插件 `dataDir` 时，服务端把
  `client/moments-client.json` 更新为 `{baseUrl: 当前管理地址, tokenFile: <dataDir>/admin-token.txt, dataDir: <dataDir>}`
  （真实绝对路径，`~` 会展开），并同步 `ClientState` 的 `token_file` / `data_dir`，代理立即从新位置读取管理令牌；
  响应增加 `clientConfig: {updated, baseUrl, tokenFile, dataDir}`。该步骤失败只在 `warnings` 里提示，不影响已写入的插件配置。

---

## 3. 功能页

### 3.1 顶栏

连接状态灯/文本、当前微信账号、发布模式、暂停/Kill Switch 状态、刷新按钮、管理页快捷入口、数据目录快捷入口。
连接失败时显示红色“连接失败”，并在概览页给出中文排查提示。

### 3.2 概览

`GET /api/health` + `GET /api/status` 摘要：

- 数据库、LLM、WeChatAgent、桌面执行器、图像 Provider 的状态与关键详情；
- 控制状态（暂停、Kill Switch、发布模式、生效发布模式、调度、所有者通道）；
- 当前账号、任务计数、待审批数、未结束任务数。

### 3.3 创作

可选输入：主题、来源类型、来源依据、创作动机。点击“生成草稿并提交审批”调用
`POST /api/workflow/draft`（选题 → 文案 → 审核 → 申请审批，**不会**准备/发表）。

- 长任务在后台线程执行，窗口不冻结；按钮禁用并显示“生成中…”，进度条动画提示；
- 显示 `silent=true` 的原因，或草稿正文、审核结果（notes/flags）、审批 ID 与过期时间；
- 模型调用通常 30~120 秒；请求超时 120 秒，超时会提示“长任务可能仍在服务端执行，请刷新查看，不要重复提交”。

### 3.4 待审批

- 列表：任务 / 正文摘要 / 哈希前缀 / 过期时间；
- 选中后显示完整正文、内容哈希（完整）、素材清单哈希、可见范围、账号、过期时间，
  以及 GET `/api/assets/{id}/raw` 的图片缩略图；
  - DSH 自带 Python 有 Pillow，正常显示 PNG/JPEG；
  - Pillow 缺失时 PNG/GIF 使用 Tk 内置解码，JPEG 降级为文字占位；
- “批准/拒绝”必须二次确认；批准前的确认框会显示**完整内容哈希**与
  “批准后正文/图片/可见范围/账号任一变化都会使审批失效（CONTENT_CHANGED）”提示；
- 批准/拒绝均写入审计，不可撤销。

### 3.5 任务

- 任务列表默认打开最新任务，显示状态、草稿摘要、更新时间；
- 详情包含状态、idea（主题/动机/来源/评分/风险）、草稿正文、图片素材、
  审批记录、发布尝试 attempts、图片任务、预览与最近审计；
- 操作按钮（写操作均二次确认）：
  - 重写并审核（`POST /api/tasks/{id}/compose`）；
  - 只审核（`POST /api/tasks/{id}/review`）；
  - 申请审批（`POST /api/tasks/{id}/request-approval`）；
  - 准备朋友圈（不发表，`POST /api/tasks/{id}/prepare`）；
  - 发表（`POST /api/tasks/{id}/publish`，两次确认并显示内容哈希）；
  - 取消（`POST /api/tasks/{id}/cancel`）；
  - 核验尝试（`POST /api/attempts/{attemptId}/verify`，只读取结果，不重试发表）；
  - 人工核对 UNCERTAIN（`POST /api/uncertain/{attemptId}/resolve`，仅手动选择 PUBLISHED/FAILED）。
- 发表按钮**始终可见可点**，不会用“禁用”隐藏原因：确认框和后端错误都会明确显示
  `PUBLISH_MODE_DISABLED` 等错误码。默认 `PREPARE_ONLY` 下后端拒绝发表，客户端不会静默重试。
- UNCERTAIN 尝试禁止重复发表；必须先核验或人工核对。

### 3.6 历史

`GET /api/history`：已发布列表（时间/账号/可见范围/是否核验/正文/postId）与候选主题
（时间/主题/来源/评分/任务）。

### 3.7 设置

- 管理 API 地址、令牌文件路径可编辑并保存到 `client/moments-client.json`（**不保存令牌**）；
- “浏览…”选择令牌文件；“测试连接”显示 health 摘要；
- 显示脱敏本地状态（令牌文件是否存在/大小，不显示内容）、数据目录、配置路径；
- 脱敏配置摘要（`GET /api/config`）与人格只读预览（`GET /api/persona`，SOUL / 视觉风格）；
- **社交记忆**（`GET /api/chat-memory`，经 `/proxy/api/chat-memory*`）：总开关与「包含私聊」开关、会话/消息/人物印象统计、立即同步（显示新消息数、印象更新数、跳过原因）、会话与人物印象列表；成员印象可编辑（别名 / 摘要 / 标签 / 话题 / 风格）或删除，会话可整体清除。**默认关闭**：只有所有者显式开启后才读取插件白名单内的群聊，私聊需单独开启；真实昵称只在本机设置页展示，不进入提示词或朋友圈；
- 暂停 / 恢复 / 启用 Kill Switch / 解除 Kill Switch 均需二次确认；
- “打开数据目录”使用 `os.startfile`。

---

## 4. 错误处理与超时

| 场景 | 客户端行为 |
| --- | --- |
| HTTP 401 | 中文提示“认证失败（HTTP 401）”，指引检查 adminServer 与令牌文件 |
| HTTP 500 | 显示服务端中文消息与错误码（若有）；不崩溃 |
| 网络不可达 | “无法连接本机管理 API（地址）：原因”，附排查步骤 |
| 超时 | 中文提示，并提醒长任务可能仍在服务端，先刷新不要重复提交 |
| HTTP 200 + `ok=false` | 显示“后端拒绝（错误码 X）：消息”，如 `PUBLISH_MODE_DISABLED` |
| 配置/令牌文件问题 | 中文提示路径与修复方法；不会发起请求 |

所有请求都有显式超时：普通 20s；创作/重写/审核/核验 120s；准备 150s；发表 180s。
长任务使用后台线程 + 主线程 `after` 轮询回调，UI 不会冻结。

---

## 5. 截图（验收）

- `client/screenshots/01-overview-live.png`：真实管理 API 的概览页（已连接）
- `client/screenshots/02-create.png`：创作页
- `client/screenshots/03-approvals-live.png`：待审批页（真实 pending 审批：正文摘要、完整内容哈希、过期时间）
- `client/screenshots/04-tasks-live.png`：任务页（真实任务：待审批 / 已批准两种状态，详情/审计/操作按钮）
- `client/screenshots/05-history-live.png`：历史页
- `client/screenshots/06-unconnected.png`：管理 API 不可达时的明确错误提示（不是崩溃）

截图使用 `pythonw.exe` + PowerShell `System.Drawing` 截屏；截图不包含令牌，也不会显示设置页的令牌内容。

---

## 6. 测试

```powershell
cd D:\dsh插插\dsh-moments-agent
D:\dsh\resources\runtime\primary-runtime\dependencies\python\python.exe -m unittest discover -s client/tests -v
```

本机实测（2026-10-25，Python 3.11.2）：**177 项全部通过**（同一命令也适用于 DSH 自带 Python 3.12）。

测试使用 `client/tests/fake_admin_server.py` 启动 127.0.0.1 随机端口的假管理 API，
不访问网络、不依赖真实插件、不使用真实令牌（令牌运行时随机生成）。覆盖：

- 令牌读取、鉴权头、每次请求重新读取令牌、令牌缺失/为空/过短、令牌不出现在错误或状态中；
- GET 解析（health/status/tasks/detail/approvals/history/persona/config/assets raw）；
- POST JSON（workflow/draft、compose、review、request-approval、prepare、publish、cancel、approve/reject、pause/resume/kill/unkill、uncertain resolve、attempts verify）；
- 社交记忆（`/api/chat-memory` 读取、设置保存、立即同步含跳过原因、PATCH 修正成员印象、DELETE 单条印象 / 整个会话；假服务状态可交互，便于手工核对界面）；
- 自动配置（`GET/POST /api/client/auto-configure`：只读预览不触发 apply、缺 `X-Requested-With` 403、`apply=false` 不写、`apply=true` 返回 `backupPath`、未知字段/非法 body 400、计划 `errors`（profile 不存在 / 条目边界不可识别等）400 中文说明、模块缺失 503「自动配置模块未就绪」、写入锁释放；测试用假模块整体替换 `client.auto_configure`，不触真实文件系统/网络）；
- 首次启动自动配置（`GET /api/client/first-run`：无配置=needs、已完成=false、`refresh=1` 强制重算、10 分钟缓存复用、检测 pending 不阻塞端点、检测异常/模块缺失/计划 errors 降级、apply 成功后写 `client/moments-client.json` 并同步 `ClientState`、客户端配置写失败只 warning、`browser_url` 首次启动标记；全部用假模块 + 每用例独立临时 CONFIG_PATH/SETUP_STATE_PATH，不读写真实 `~/.dsh`、真实客户端配置和真实网络）；
- Web 代理 DELETE / PATCH（`/proxy/api/*` 注入令牌并转发请求体，跨站/非本机请求仍被拒绝，原 `memories` 删除端点不回归）；
- 401 / 500 / 404 / business error / 连接拒绝 / 超时 / 非法 JSON 的错误映射；
- 非回环地址拒绝、缺失端口、路径、超时时间范围检查；
- 配置加载/保存、相对路径、配置中绝不写入令牌、脱敏视图不含令牌。

---

## 7. 已知限制

1. **不替代 DSH 客户端或管理页**：它只是本机管理 API 的桌面壳；插件卸载/禁用后不可用。
2. **发表默认不可用**：默认 `PREPARE_ONLY`；真实发表需要显式切换到 `APPROVAL_REQUIRED`（一次性审批）
   或 `POLICY_AUTONOMOUS`（免逐条审批），并让内置执行器具备对应发表权限，且账号/版本/桌面状态全部通过。
   第三档已于 2026-10-25 真机验收 1 条，但仍受每日上限、最小间隔、静默时段与 Kill Switch 约束，建议小额度运行并人工抽查。
3. **准备朋友圈依赖桌面执行器**：执行器未启用/微信不可交互时，准备操作返回明确错误码。
4. **Pillow 可选**：系统 Python 无 Pillow 时，JPEG 缩略图降级为文字占位；PNG/GIF 仍可预览。
5. **UNCERTAIN 必须人工处理**：客户端不会自动收敛，只能核验或人工核对；禁止重复发表。
6. **列表上限**：任务 100、待审批 20、历史 20（与 API 契约一致），客户端不做本地缓存。
7. **测试临时目录残留**：早期一次测试使用了 `tempfile.TemporaryDirectory`（mode=0o700）。
   在 DSH Python 3.12 + Windows 沙箱下此模式会创建 ACL 受限目录，后续进程（包括创建者）
   无法删除；因此 `client/tests/.tmp/`（已隐藏）和 `client/tests/` 下可能残留少量空目录。
   这些目录不含源码/凭据/测试数据，也不影响测试。后续测试已改为默认权限的 `os.makedirs`
   （见 `client/tests/__init__.py` 的 `WorkspaceTempDir`）。清理需在 Host 侧完全权限删除。
8. **社交记忆默认关闭并依赖新版插件**：管理卡片需要插件提供 `/api/chat-memory*` 端点（旧版插件会显示“未提供该接口”，不会伪造成功）。只有显式开启后才读取 WeChatAgent 白名单内的群聊，私聊需单独开启；关闭总开关后仍可查看、删除已保存的人物印象或清除会话，但修正印象需先开启（与插件校验一致）。管理面展示的本机昵称仅在本机使用，编辑/删除人物印象只改本地数据，不会修改微信聊天记录，也不会批准或发表内容。
9. **只在本机使用**：客户端拒绝非回环地址，不支持远程管理（符合管理 API 设计）。

---

## 8. 故障排查

| 现象 | 处理 |
| --- | --- |
| “无法连接本机管理 API” | 确认 DSH 正在运行、插件已启用 `adminServer`、端口 18766、插件已重载 |
| “认证失败（HTTP 401）” | 检查 `data/admin-token.txt` 是否存在且为最新；重新启用插件或重载后重试 |
| “找不到管理令牌文件” | 插件尚未生成令牌：启用 `adminServer` 后访问一次管理页/重载插件 |
| 请求超时 | 长任务可能仍在执行：稍后刷新任务列表，不要重复提交写操作 |
| 发表返回 `PUBLISH_MODE_DISABLED` | 当前是 `PREPARE_ONLY`，这是预期保护；真实发表需审批 + 执行器 `--allow-publish` |
| 批准返回 `CONTENT_CHANGED` | 审批后内容被修改，需重新申请审批 |
| 返回 `UNCERTAIN_REQUIRES_MANUAL_CHECK` | 先人工核对朋友圈，再用“核验尝试”或“人工核对 UNCERTAIN” |
| 准备/发表返回 `PRIVILEGE_REQUIRED` | 执行器被配置为 `--geometry-require-admin` 但未提权，或微信进程已提权/提权状态无法确认；用管理员启动客户端，或确认微信以普通权限运行后重试 |
| 准备/发表返回 `WINDOW_BLOCKED` | 微信不在前台、窗口被移出工作区或被弹窗遮挡，屏幕捕获会拒绝继续；把微信窗口保持在前台且不遮挡后重试 |
| 执行器 `ocrAvailable=false` | OCR helper（RapidOCR 或 Windows OCR）不可用；运行 `scripts/install-desktop-deps.ps1` 安装依赖后重启客户端 |
| 图片无法预览 | 系统 Python 无 Pillow：使用 DSH 自带 Python，或接受文字占位降级 |

---

## 9. 目录结构

```text
client/
├─ app.py                       # Tkinter UI（六页 + 后台线程 + 二次确认）
├─ api_client.py                # 管理 API 客户端（urllib，令牌不落盘）
├─ auto_configure.py            # 自动配置核心：检测 profile/WeChatAgent → 预览 → 备份写入（CLI 可独立运行）
├─ config.py                    # 客户端配置读写（脱敏、不保存令牌）
├─ moments-client.example.json  # 配置模板
├─ README.md
├─ tests/
│  ├─ __init__.py               # 工作区临时目录辅助
│  ├─ README.md                 # 测试说明与已知 ACL 残留
│  ├─ fake_admin_server.py      # 假管理 API（随机端口 + 故障注入 + 社交记忆可交互示例）
│  ├─ test_api_client.py        # API/错误映射与社交记忆端点测试
│  ├─ test_auto_configure.py    # 自动配置核心（渲染/合并/备份/原子写/profile/CLI）
│  ├─ test_config.py            # 配置/令牌安全测试
│  └─ test_web_server.py        # 本地 Web 服务（自动配置端点、鉴权、代理、静态文件）
└─ screenshots/                 # 验收截图
Start-Moments-Client.cmd        # 项目根启动器
```
