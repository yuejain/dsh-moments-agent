# 自动配置（给其他用户用）

> 版本：v1（2026-10-25）
> 目标：新用户装好 DSH 与 WeChatAgent 后，不再手写 `cordis.patch.yml`，用一次「检测 → 预览 → 写入」完成插件配置。

## 使用方式

1. **客户端向导（推荐）**：EXE/`client/server.py` → 首次配置第 06 步「自动配置插件」→ 检测 → 预览 → 写入（自动备份原 profile）。
2. **命令行**（没有客户端时）：
   ```powershell
   cd <项目目录>
   python -X utf8 -m client.auto_configure            # 只检测并打印预览，不写文件
   python -X utf8 -m client.auto_configure --apply    # 写入 profile（先备份）
   python -X utf8 -m client.auto_configure --apply --json
   # 直接运行脚本也可（内部回退 import）：python -X utf8 client/auto_configure.py --json
   ```

默认只预览；写入必须显式 `--apply` 或点击带二次确认的按钮。

## 检测来源（全部只读）

| 信息 | 来源 |
| --- | --- |
| DSH profile 列表 | `~/.dsh/profiles/*/cordis.patch.yml`、`package.json` |
| 当前插件安装位置 | profile `package.json` 依赖 `dsh-moments-agent`（`link:`/版本） |
| 插件默认数据目录 | profile `cordis.patch.yml` 中 `- id: dsh-moments-agent` 的 `dataDir`（受限字面量读取） |
| WeChatAgent 安装与数据目录 | `client/discovery.py` 的进程/已知路径/可移植路径探测 |
| Reader 地址与令牌路径 | `<WeChatAgent data>/workspace/state/wechat-io-config.json`（`reader_base_url`；令牌正文不读出、不复制） |
| Hook 地址 | `<WeChatAgent data>/workspace/config/wechatagent.json` 的 `hook.baseUrl`；缺失时回退 `http://127.0.0.1:11230` |
| Hook 令牌路径 | `<WeChatAgent data>/workspace/state/hook/native-token.txt`（只写路径） |
| 微信账号 | Reader `GET /api/v1/reader/status`（只读，令牌从 io-config 读取）：`ownWxid`、`accountDirectory` |
| 模型 provider/model | `wechatagent.json` 的 `dsh.provider/model`；缺失时沿用 profile 中 `agent-default-model` 的字面量；再缺失用 `deepseek-account` / `deepseek-flash` |

任何一步失败都降级为「该字段不自动填」，写入 `warnings`，不中断整个流程。

## 写入内容

只在选中的 `<profile>/cordis.patch.yml` 中维护一条 `- id: dsh-moments-agent`：

- 已有该条：**整块替换**为本次生成的块（其他插件条目、注释、`!!js` 一律不动）；
- 没有该条：追加到文件末尾（保持顶层数组结构）；
- 写前备份 `cordis.patch.yml.<yyyyMMdd-HHmmss>.bak`；写临时文件后 `os.replace` 原子替换；
- 生成块只包含插件已知字段，安全默认值：
  - `publishMode: PREPARE_ONLY`、`scheduleEnabled: false`、`killSwitch: false`、`desktopExecutor.enabled: false`、`chatMemory.enabled: false`
  - `wechatAgent.enabled: true` 仅当检测到 Reader 配置；`account`/`ownerWxid` 仅在 Reader 状态可读时写入，否则留空并给 warning
  - `adminServer.enabled: true`，端口 18766，令牌文件 `data/admin-token.txt`（插件首次启动自动生成）
  - `llm` 使用检测到的 provider/model
  - `dataDir` 使用绝对路径（正斜杠），默认 `<项目根>/data`
- 可选：若 `data/desktop-account.txt` 不存在或内容相同，写入 Reader 的 `accountDirectory`（供桌面执行器使用）；内容不同则不覆盖，只给 warning。

**绝不写入**：Reader/Hook 令牌正文、密码、Cookie、聊天内容；不修改 WeChatAgent 的任何配置或文件。

## 安全与边界

- 只处理 `127.0.0.1`/`localhost` 的服务器地址；非回环地址直接拒绝该字段并 warning。
- 只允许写入选中的 DSH profile 的 `cordis.patch.yml`，以及项目 `data/desktop-account.txt`；不写用户目录其他位置。
- 不执行 YAML 求值；不解析 `!!js`；用行级匹配定位条目边界，找不到安全边界就拒绝写入并提示手工配置。
- 管理端应用需要本机回环 + `X-Requested-With: DSHMomentsClient`；浏览器拿不到管理令牌。
- 写入后必须**重启 DSH 插件**才生效；报告里明确提示，不假装已生效。
- 已存在配置里的账号/端口如与检测值冲突：默认以检测值为准，但在 warnings 里列出变化（`account`、`baseUrl`、`dataDir`），写入前预览可见。

## 模块契约

`client/auto_configure.py`（纯标准库，可被 CLI 与 `server.py` 复用）：

```python
@dataclass
class AutoConfigPlan:
    profile: str                 # profile 名
    patchPath: str               # cordis.patch.yml 绝对路径
    existed: bool                # 是否已有插件条目
    block: str                   # 生成的 YAML 条目块（含注释）
    changedFields: list[str]     # 与现有配置不同的字段（不含令牌）
    detected: dict               # 非敏感检测摘要（地址/路径/账号掩码）
    warnings: list[str]
    errors: list[str]
    backupPath: str | None       # 仅 apply 后

def build_plan(project_root, *, profile=None, user_home=None, environment=None,
               processes=None, fetch=None, now=None) -> AutoConfigPlan
def apply_plan(plan, *, backup=True) -> AutoConfigPlan       # 备份 + 原子写 + 可选账号文件
def public_summary(plan) -> dict                              # JSON 安全：不返回令牌/完整 home
def main(argv=None) -> int                                     # CLI：默认 dry-run；--apply 写入；--json
```

`server.py` 端点：

- `GET /api/client/auto-configure` → `{ok, data: public_summary(build_plan(...))}`（只检测）
- `POST /api/client/auto-configure`（body `{profile?: string, apply?: bool}`，需 `X-Requested-With: DSHMomentsClient`）
  - `apply=false` → 与 GET 相同（允许指定 profile 重新检测）
  - `apply=true` → 备份并写入，返回 `{ok, data: public_summary(plan) + {applied, backupPath, clientConfig}}`
    - `clientConfig = {updated, baseUrl, tokenFile, dataDir}`：写入成功后自动把客户端连接配置指向检测到的插件 data 目录（`<dataDir>/admin-token.txt`），并立即更新客户端代理读取的令牌路径；该步骤失败只追加 warning，不影响已写入的插件配置。HTTP 响应中的路径按 `home→~` 脱敏，磁盘写入的是真实绝对路径。
- `GET /api/client/first-run[?refresh=1]` → `{ok, data: {firstRun, setupCompleted, configMissing, needsAutoConfigure, autoConfigure, reason, checkedAt}}`
  - `firstRun = configMissing || !setupCompleted`；`needsAutoConfigure = firstRun && build_plan 无 errors && 检测到 profile/patch`。
  - 检测在后台线程执行并缓存 10 分钟（`refresh=1` 重算），端点最多等待约 5 秒；pending 时 `needsAutoConfigure=null + reason="检测中"`，不阻塞客户端启动；检测异常降级为 `autoConfigure=null` + 中文原因（不返回 500）。
  - `autoConfigure` 为 `public_summary`（已脱敏，不含令牌）。

错误：profile 不存在 / 无 `cordis.patch.yml` / 条目边界不可识别 / 非回环地址 → HTTP 400 + 中文 message；不产生部分写入。

## 安装包首次启动流程（EXE / 客户端）

- `client/server.py` 首次启动（`configMissing || !setupCompleted`）时：后台预触发检测，打开浏览器 URL 带 `?firstrun=1`；页面弹出「首次启动」欢迎弹窗，展示检测结果与只读 YAML 预览，**不会自动写入**。
- 主按钮「一键自动配置（先备份）」→ 二次确认（替换该插件条目、不动其他插件、先备份、需重启 DSH）→ `POST apply=true`；成功后展示备份路径与重启提醒，并同步客户端连接配置。
- 次按钮「按教程手动配置」→ 跳到首次配置第 06 步手工教程；「稍后」按客户端版本记录 `localStorage`，不再自动弹，可在首次配置页重新打开。
- 检测模块未就绪 / 接口不可用时，回退到原有分步教程，不阻塞进入应用。
- 全新便携包自带相对路径的 `client/moments-client.json`（`dataDir: data`、`tokenFile: data/admin-token.txt`，按 EXE 所在目录解析）；首次自动配置成功后改写为检测到的插件 data 绝对路径。

## 客户端向导

`client/web/app.js` 首次配置第 06 步新增「自动配置插件」卡片：

- 按钮「检测本机环境」→ 展示 profile、插件路径、dataDir、Reader/Hook 地址、账号（掩码）、模型；
- 折叠展示将要写入的配置块（只读 `<pre>`，含路径但不含令牌）；
- 「写入配置（先备份）」→ 二次确认 Modal（说明会覆盖该插件条目并需要重启 DSH）→ 调 POST → 成功展示备份路径与重启提醒；失败展示中文原因；
- 检测失败/字段缺失时保留手工教程作为回退。

## 验收

1. 默认只预览、不写文件；`--apply`/确认按钮才写，且一定产生 `.bak`。
2. 重复执行幂等：第二次生成相同块，备份照常产生，不产生重复条目。
3. 其他插件条目、注释与 `!!js` 原样保留。
4. 令牌正文不出现于 CLI 输出、JSON、日志、HTTP 响应、配置块。
5. 无 WeChatAgent 时仍能写保守配置 + warnings，不伪造账号。
6. 单测覆盖：渲染/合并/替换/追加/边界拒绝/备份/原子写/dry-run/掩码；集成覆盖两个 HTTP 端点与写入结果。
7. 首次启动：无客户端配置/教程未完成时 `firstRun=true`、后台检测可 pending 可刷新、不自动写入；确认后才 `apply`；apply 成功后客户端连接配置指向检测 dataDir；`needsAutoConfigure` 判定与 dismiss 行为有测试。
8. EXE 冻结环境：新前端与 `client.auto_configure`/`client.discovery` 已进 PyInstaller 包；`client/moments-client.json`、`client/setup-state.json` 写到 EXE 目录 `client/`（目录必须可写）；安装包不携带真实 profile 备份或令牌。
