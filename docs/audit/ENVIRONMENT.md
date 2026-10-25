# ENVIRONMENT.md — Phase 0 目标环境审计（DSH Moments Agent）

- 审计对象：Windows 桌面版 DeepSeek Harness + 个人微信环境
- 审计时间：2026-10-20 17:35–18:25（Asia/Shanghai）
- 审计方式：只读探测（PowerShell 7.6.7、Node 内置模块、`cordis_inspect_query`）。未修改 profile、未安装插件、未改动 `D:\dsh插插\upstream`。
- 结论先行：**DSH 0.2.1-rc.2 与 Cordis 4.0.5 的运行环境完整可用；但 PATH 上的 node/python 与 DSH 自带运行时不一致，项目代码必须显式使用 DSH 自带运行时路径。微信已安装 4.1.15.13（未运行），GUI 自动化依赖 pywinauto 等未安装且 pip 网络路径存在挂起问题，桌面执行器只能按 NOT_TESTED 处理（见 PHASE0_GATE）。**

## 1. 主机与操作系统

| 项目 | 实测值 | 证据/命令 |
|---|---|---|
| 操作系统 | Windows 10 Pro 25H2，Build 26200，`10.0.26200` | `[System.Environment]::OSVersion.VersionString`；`HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion`（ProductName=Windows 10 Pro，DisplayVersion=25H2，CurrentBuild=26200） |
| 架构 | AMD64 / x64 | `$env:PROCESSOR_ARCHITECTURE` = AMD64；`node -p process.arch` = x64 |
| CPU | 13th Gen Intel Core i5-13600KF | `HKLM:\HARDWARE\DESCRIPTION\System\CentralProcessor\0` |
| 逻辑处理器 | 20 | `[System.Environment]::ProcessorCount` |
| 内存 | 31.8 GiB 总量 / 16.4 GiB 可用（审计时 48% 占用） | Python `ctypes` + `GlobalMemoryStatusEx`（CIM 在本机被策略禁用，`Get-CimInstance` 返回空） |
| 磁盘 C: | 229.5 GB 可用 / 700.9 GB 已用 | `Get-PSDrive C,D` |
| 磁盘 D: | 1712.7 GB 可用 / 150.3 GB 已用 | 同上 |
| PowerShell | 7.6.7，`FullLanguage` | `$PSVersionTable.PSVersion`、`$ExecutionContext.SessionState.LanguageMode` |

> 注意：本机 `Get-CimInstance Win32_*` 静默失败（返回空），后续排障请改用注册表、`.NET` 或 Python `ctypes`，不要依赖 CIM。

## 2. DSH 安装与版本

| 项目 | 实测值 | 证据 |
|---|---|---|
| 安装目录 | `D:\dsh` | `Get-ChildItem D:\dsh` |
| 桌面壳版本 | `0.2.1-rc.2` | `D:\dsh\resources\app.asar\package.json` → `"version": "0.2.1-rc.2"` |
| Electron 版本 | `44.7.0` | `D:\dsh\version` 内容为 `44.7.0`；`DeepSeek Harness.exe -e`（`ELECTRON_RUN_AS_NODE=1`）输出 `electron-node v24.21.0 44.7.0` |
| 运行时描述 | desktop 0.2.1-rc.2 / win32 / x64 / python 3.12.14 / node 24.21.0 / pnpm 11.28.5 | `D:\dsh\resources\runtime\primary-runtime\runtime.json` |
| 桌面构建提交 | `332895e0f7c9d4dbfb29729f5eb367fa263ff986`（dirty=false） | `app.asar/package.json` → `dshBuildCommit`、`dshBuildDirty` |
| runtime 包版本 | 全部 `@deepseek-ai/dsh-*` 为 `0.2.1-rc.2`，`@deepseek-ai/cordis` 4.0.5，`schemastery` 3.18.5 | `D:\dsh\resources\app.asar\dsh\package.json` |
| app.asar 大小 | 182,794,869 字节 | `Get-ChildItem D:\dsh\resources` |
| 正在运行进程 | 3 个 `DeepSeek Harness`（PIDs 6928/11004/19296） | `Get-Process` |

> `app.asar` 是单文件归档：`read` 工具可读其虚拟路径，`PowerShell`/`ripgrep`/`node` 无法直接打开。审计中的所有 asar 证据均来自 `read` 工具。

## 3. 自带运行时（必须使用这些路径）

| 组件 | 路径 | 版本 |
|---|---|---|
| Node | `D:\dsh\resources\runtime\primary-runtime\dependencies\node\bin\node.exe` | v24.21.0（x64/win32，V8 13.6.233.17-node.53） |
| pnpm（脚本） | `D:\dsh\resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.cjs` | 11.28.5（用自带 node 执行 `pnpm.cjs --version` 实测） |
| Python | `D:\dsh\resources\runtime\primary-runtime\dependencies\python\python.exe` | 3.12.14（64bit） |
| Electron-as-Node | `D:\dsh\DeepSeek Harness.exe` + `ELECTRON_RUN_AS_NODE=1` | node v24.21.0 / electron 44.7.0 |
| pnpm 启动脚本 | `D:\dsh\resources\runtime\bin\node.cmd`、`bin\node` | 设置 `ELECTRON_RUN_AS_NODE=1` 后转发 |

自带 Python 已装库（`runtime.json` 声明）：numpy 2.3.5、pandas 3.0.1、python-dateutil 2.9.0.post0、six 1.17.0、tzdata 2025.2、python-docx 1.2.0、python-pptx 1.0.2、openpyxl 3.1.5、Pillow 12.3.0、lxml 6.1.3、XlsxWriter 3.2.9、typing_extensions 4.16.0、et_xmlfile 2.0.0。

实测：

```text
D:\dsh\...\python.exe --version        -> Python 3.12.14
python3.12 内置: import PIL           -> True (Pillow 12.3.0)；ImageGrab 可导入
python3.12 内置: pywinauto/uiautomation/comtypes/pyautogui/win32gui -> False
```

## 4. PATH 环境与 DSH 自带运行时的差异（重要坑）

| 组件 | PATH 上实际解析到 | 版本 | 风险 |
|---|---|---|---|
| `node` | 系统安装的 Node | **v24.14.1**（npm 11.11.0） | 与 DSH 自带 24.21.0 不同；插件代码若被 shell 直接 `node` 加载会与 Host 模块解析不一致 |
| `pnpm` | 未找到（`Get-Command pnpm` 空） | — | 必须用自带 `pnpm.cjs` + 自带 node |
| `python` | `C:\Users\10575\AppData\Local\hermes\hermes-agent\venv\Scripts\python.exe` | **Python 3.11.2** | 不是 DSH 的 3.12.14；GUI 依赖也都不在该 venv |
| `python`（py launcher） | Python 3.11 + uv 的 CPython 3.12.13 | 3.11 / 3.12.13 | 均非 DSH 自带 3.12.14 |
| `git` | `C:\Program Files\Git\...` | 2.39.2.windows.1 | 可用 |

> 与 Lead 初始环境事实的差异：实际 PATH 的 node 是 24.14.1、默认 python 是 3.11.2；24.21.0/3.12.14 只存在于 DSH 自带 runtime。审计文档与实现均以自带 runtime 为准。

## 5. 环境变量（DSH profile 启动的 shell 内）

实测存在：`DSH_HOME=C:\Users\10575\.dsh`、`DSH_PROFILE=desktop`、`DSH_PROFILE_DIR=C:\Users\10575\.dsh\profiles\desktop`、`DSH_SESSION_ID=65f8c158-...`、`DSH_SHELL=1`、`DSH_WEB_URL=http://127.0.0.1:53796`、`ELECTRON_RUN_AS_NODE=1`、`HERMES_HOME=C:\Users\10575\AppData\Local\hermes`。
未设置：`DSH_DESKTOP_NODE_EXECUTABLE`（`bin\node.cmd` 依赖它，直接调用会失败，应改用自带 runtime 绝对路径）。

## 6. profile 与已装插件

- profile 目录：`C:\Users\10575\.dsh\profiles\desktop`
- `package.json` 依赖：`@deepseek-ai/dsh-subagent-codex@0.2.1-rc.2`、`dsh-posterflow-ai@github:Something11235/dsh-posterflow-ai`、`dsh-whale-widget@github:MeteorNOX/DeepSeek-Balance-Whale-Widget`
- `dsh.profile.bundles`（9 个）：`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`@deepseek-ai/dsh-experimental-agent-team-profile`、`@deepseek-ai/dsh-experimental-inspector-profile`、`@deepseek-ai/dsh-experimental-terminal-bundle`、`@deepseek-ai/dsh-experimental-plugin-market-bundle`、`@deepseek-ai/dsh-subagent-codex`、`dsh-whale-widget`、`dsh-posterflow-ai`
- profile 自身 patch：`cordis.patch.yml`（4 行 override：`agent-default-model` = deepseek-account/deepseek-flash/reasoningEffort high；`ui-settings-account`；`ui-chat`；`ui-settings`）
- `pnpm-workspace.yaml`：`packages: ['.']`，`nodeLinker: hoisted`，`autoInstallPeers: false`
- `DSH_HOME` 体积：约 392.4 MB（含 sessions/storages/whale-* 等）

已装第三方包实测版本：

| 包 | 版本 | 证据 |
|---|---|---|
| `@deepseek-ai/dsh-subagent-codex` | 0.2.1-rc.2 | 包内 `package.json` |
| `dsh-posterflow-ai` | 0.1.1 | 包内 `package.json` |
| `dsh-whale-widget` | 0.4.2 | 包内 `package.json` |
| `@deepseek-ai/cordis`（Host 内） | 4.0.5 | `app.asar/dsh/node_modules/@deepseek-ai/cordis/package.json` |
| `@deepseek-ai/schemastery`（Host 内） | 3.18.5 | `app.asar/dsh/package.json` |

profile 的 `node_modules` 可直接用 shell 读取（与 asar 不同）；`@deepseek-ai/dsh-subagent-codex/lib/index.js` 等已逐行核对。

## 7. 网络

| 目标 | 结果 | 证据 |
|---|---|---|
| npm registry | 200 | Node `fetch('https://registry.npmjs.org/-/ping')` |
| npmmirror | 200 | Node `fetch('https://registry.npmmirror.com/-/ping')`；npm 配置 registry=`https://registry.npmmirror.com` |
| PyPI | 200，`pywinauto` 最新 0.6.9 | Python 3.12.14 `urllib.request` + JSON API |
| GitHub | 200 | Node `fetch('https://github.com')` |
| harness.deepseek.com | 404（可达） | Node `fetch` |
| api.deepseek.com | 401（可达，未带凭据） | Node `fetch` |
| DNS | `registry.npmjs.org -> 198.18.0.89`（fake-IP，TUN/代理特征） | `Resolve-DnsName` |
| 系统代理 | `127.0.0.1:17980`（IE 设置开启），WinHTTP 为 Direct；proxy 端口 TCP 可连 | 注册表 `Internet Settings`；`netsh winhttp show proxy` |

网络工具差异（重要）：
- `curl.exe`/`Invoke-WebRequest` 因 schannel 凭据限制报 `SEC_E_NO_CREDENTIALS`，不能作为网络判据。
- Node `fetch`/`https` 与 Python `urllib` 正常。
- `pip 26.2.1`（自带 Python）：`pip index versions` / `pip install --dry-run` / `pip download pywinauto` 均挂起（>90 s 无输出，重复两次），**pip 通道在本机未被证明可用**。

## 8. node:sqlite

自带 node 24.21.0 实测通过：

```js
const { DatabaseSync } = require('node:sqlite')
const db = new DatabaseSync(':memory:')
db.exec('create table t(a)')
db.prepare('insert into t values(?)').run(42)
console.log(db.prepare('select a from t').get()) // [Object: null prototype] { a: 42 }
```

结论：`node:sqlite` 可用（仅实验性警告），可用于本地审计/记忆库；但根会话与插件运行在 Host，注意使用同一 node 版本。

## 9. 微信 / GUI 自动化

### 9.1 安装情况

| 项目 | 实测值 | 证据 |
|---|---|---|
| 主程序 | `D:\tencent\Weixin\Weixin.exe`，文件版本 4.1.15.13，产品名 Weixin，Tencent，2,939,440 字节，修改时间 2026-09-22 | `(Get-Item).VersionInfo` |
| 版本目录 | `D:\tencent\Weixin\4.1.15.13`（914,741,795 字节，含 `Weixin.dll` 201 MB、`RadiumWMPF.bin` 432 MB 等） | `Get-ChildItem -Recurse` |
| 运行状态 | **未运行**（无 `Weixin`/`WeChat` 进程） | `Get-Process` |
| 旧版残留 | 卸载注册表项 `微信 3.8.0.41` 指向 `D:\tencent\WeChat\WeChat.exe`，但该 exe 与目录内容缺失（空目录） | Uninstall 注册表 + `Test-Path` |
| 注册表 | `HKCU:\SOFTWARE\Tencent\WeChat`、`HKCU:\SOFTWARE\Tencent\Weixin` 均存在 | `Test-Path` |
| 用户数据 | `C:\Users\10575\Documents\WeChat Files`（含 `<本机账号已脱敏>`、`<本机账号已脱敏>`）；`%APPDATA%\Tencent\xwechat` | `Get-ChildItem` |
| Appx | 无微信 UWP 包 | `Get-AppxPackage` 无匹配 |

> 结论：**微信已安装（Weixin 4.1.15.13），但审计时未运行**。4.x 与旧 3.8 的注册表/目录并存，任何自动化必须先按 exe 实际路径与版本判定，不能依赖卸载项。

### 9.2 GUI 自动化依赖

| 依赖 | 自带 Python 3.12.14 | PATH Python 3.11.2 | 说明 |
|---|---|---|---|
| `pywinauto` | 未安装 | 未安装 | 主用 UIA 封装 |
| `uiautomation` | 未安装 | 未安装 | 备选 UIA 封装 |
| `comtypes` | 未安装 | 未安装 | pywinauto 的 COM 基础 |
| `pyautogui` | 未安装 | 未安装 | 键鼠/截图备选 |
| `Pillow` | 已安装 12.3.0（ImageGrab 可导入） | 未安装 | 截图可行（未实测抓屏） |

系统 UIA 运行时存在：`C:\Windows\System32\UIAutomationCore.dll` 7.2.26100.8875、`oleacc.dll` 7.2.26100.9549。

pip 可行性：PyPI 可达、`pywinauto` 最新 0.6.9，但 `pip download/dry-run` 在本机挂起（见 §7）。**因此"pywinauto 可安装"未获验证；且微信 4.x 的 UIA 控件树未在运行态验证。** 两项均记 NOT_TESTED。

### 9.3 GUI 自动化结论

- 静态条件：UIA API 运行时存在，Python 3.12.14 + Pillow 可用；具备"写自动化代码"的条件。
- 动态条件：pywinauto/uiautomation 未装、pip 通道挂起、微信未运行、4.x 控件树未验证 → **不能宣称桌面自动化可用**。
- 微信 4.x 为 Chromium/Radium 架构，控件可访问性与其 3.x 差异大；需在真实运行实例上单独验证 UIA 树与窗口类名。

## 10. Source checkout（只读参考）

| 项目 | 实测值 |
|---|---|
| 路径 | `D:\dsh插插\upstream\deepseek-harness` |
| HEAD | `687f282e8625c6b8d11ff58211a90524be2e4317`（2026-10-17 15:22:43 +0800，Merge release-dsh-0.2.1-rc.2） |
| tag | `dsh-v0.2.1-rc.2` |
| 浅克隆 | 是（`rev-parse --is-shallow-repository` = true） |
| 工作区 | clean（`status --porcelain` 无输出） |
| 用途 | 仅作 Cordis 4.0.5 / preset / schedule 源码对照；不修改 |

> 已安装桌面壳的 `dshBuildCommit` 是 `332895e0…`，与 upstream tag merge commit `687f282e…` 不同：前者是桌面打包构建号，后者是 release 合并点；运行时包版本一致（0.2.1-rc.2）。引用证据时以 asar/profile 实物为准，upstream 只作源码解释。

## 11. 关键命令输出摘要

```text
node -v                                   -> v24.14.1        (PATH)
D:\dsh\...\node\bin\node.exe -v           -> v24.21.0        (bundled)
pnpm -v                                   -> (not found)     (PATH)
node pnpm.cjs --version                   -> 11.28.5         (bundled)
python --version                          -> Python 3.11.2   (PATH, hermes venv)
D:\dsh\...\python\python.exe --version    -> Python 3.12.14  (bundled)
node:sqlite in-memory insert/select       -> OK
Get-Process Weixin/WeChat                 -> (none)
D:\tencent\Weixin\Weixin.exe FileVersion  -> 4.1.15.13
UIAutomationCore.dll                      -> 7.2.26100.8875
```

## 12. 环境层面的实现约束（交给后续 Phase）

1. 插件/脚本启动 node、pnpm、python 时必须用 §3 的绝对路径；不要依赖 PATH（24.14.1 / 3.11.2 / 无 pnpm）。
2. 网络客户端不要用 curl/Invoke-WebRequest 做健康检查；用 Node `fetch` 或 Python `urllib`；pip 通道在修复前不要进入关键路径。
3. 微信相关自动化在 pywinauto 与 UIA 树验证前，一律按 NOT_TESTED 处理；不得以"已安装微信"推导"可自动发朋友圈"。
4. 所有 asar 内文档/类型用 `read` 工具读取；shell 对 asar 必然失败，不要据此判定文件不存在。
