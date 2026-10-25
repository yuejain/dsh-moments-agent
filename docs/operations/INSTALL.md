# 安装与部署

## 1. 环境矩阵

| 组件 | 已验证 | 备注 |
| --- | --- | --- |
| Windows | 10/11 x64 | 桌面执行器平台 |
| DeepSeek Harness Desktop | 0.2.1-rc.3 | 已安装到 `D:\dsh`（rc.3 复核见 `docs/audit/DSH_0_2_1_RC3_COMPAT.md`） |
| Node.js | 24.14（PATH）/ 24.21（DSH 自带） | 构建用 PATH，运行时由 Host 提供 |
| Python | 3.11.2（PATH） | 桌面执行器只需标准库 |
| Windows 微信 | 4.1.15.13 已安装 | 验证基线为 4.1.10.27；4.1.15.13 未验证 |
| 本插件 / Windows 客户端 | **0.3.0 / 1.2.0** | 见 [GitHub Release](https://github.com/yuejain/dsh-moments-agent/releases/tag/v0.3.0)；插件和客户端成对升级 |

## 2. 构建与自检

```powershell
cd D:\dsh插插\dsh-moments-agent
npm install --no-audit --no-fund
npm run typecheck
npm run build
npm run verify
npm test
python desktop\tests\run_tests.py
```

若 `npm install` 因缓存目录权限失败，可指定工作区内缓存：

```powershell
$env:npm_config_cache='D:\dsh插插\.npm-cache'
npm install --no-audit --no-fund
```

## 3. 安装插件

### 方式 A：DSH 插件页面

1. 打开 DSH 设置 → 插件 / 插件市场；
2. 选择“从本地目录安装”；
3. 目录填 `D:\dsh插插\dsh-moments-agent`；
4. 安装后确认插件行启用。

### 方式 B：`plugin_manager`（本机已验证）

```
action: install_bundle
target: D:\dsh插插\dsh-moments-agent
```

成功判据：

- 返回 `application: "applied"`；
- profile 的 `package.json` 出现 `"dsh-moments-agent": "link:..."`；
- `Tool.listTools` 出现 `moments_*`；
- 项目下生成 `data/moments.sqlite`。

安装过程会运行 pnpm；本机实测 `exitCode: 0`。

## 4. 配置

默认配置即最保守配置：

- `publishMode: PREPARE_ONLY`
- `scheduleEnabled: false`
- `desktopExecutor.enabled: false`
- `wechatAgent.enabled: false`
- `images.officialApiEnabled: false`
- `adminServer.enabled: false`

按需把 `config/moments.example.yaml` 中对应字段合并到：

```
C:\Users\<你>\.dsh\profiles\desktop\cordis.patch.yml
```

> patch 的 `config` 是整行替换，不深合并；只写要覆盖的字段即可（未写字段用代码默认值）。

## 5. 桌面执行器

```powershell
cd D:\dsh插插\dsh-moments-agent
python desktop\server.py --port 18765 --token-file data\desktop-token.txt --mode PREPARE_ONLY
```

- 必须只绑定 `127.0.0.1`；
- token 文件首次自动生成；
- 插件侧配置 `desktopExecutor.enabled: true` 与 `tokenFile`（或环境变量 `DSH_MOMENTS_DESKTOP_TOKEN`）；
- 默认不允许发表；真实发表需 `--allow-publish`，且模式为 `APPROVAL_REQUIRED`（需有效一次性审批）
  或 `POLICY_AUTONOMOUS`（免逐条审批，仍需审核通过并绑定内容哈希）；geometry 驱动还需
  `--geometry-allow-publish`（第二/第三档 + 两项 allow-publish 缺一不可）。
- 账号验证可复用 WeChatAgent（显式 opt-in）：

```powershell
python desktop\server.py --port 18765 --token-file data\desktop-token.txt `
  --mode PREPARE_ONLY `
  --trusted-account-source wechatagent `
  --expected-account wxid_xxx `
  --assume-client-version 4.1.10.27
```

## 6. Windows Web 客户端（推荐）

```powershell
# 项目根目录
.\Start-Moments-Client.cmd
```

或直接运行：

```powershell
D:\dsh\resources\runtime\primary-runtime\dependencies\python\python.exe client\server.py --port 18770
```

- 本地服务只监听 `127.0.0.1:18770`，自动用 Edge/Chrome 应用窗口打开；
- 管理令牌只由本地服务读取并注入 `/proxy/api/*`，浏览器拿不到 token；
- 关闭应用窗口后心跳停止，客户端服务自动退出；
- 打包版：`release\DSH-Moments-Client-1.1.9-win64-exe.zip`（解压后双击 `DSH-Moments-Client.exe`，内置 Python 与依赖）；
  插件包：`release\dsh-moments-agent-0.2.7.tgz`；版本、SHA-256 与签名记录见
  `release\DSH-Moments-Client-1.1.9-verification.json`、`release\DSH-Moments-Client-1.1.9-signature.json`；
- 若令牌文件路径不同，在客户端「设置 → 客户端配置」中修改并保存，然后重开客户端。
- **首次配置**：首次打开会自动出现 8 步教程（也可点左侧「首次配置」），按 A–H 操作：
  插件/API → WeChatAgent → 代理规则模式 → 账号复用 → geometry+OCR 执行器 → token/发布模式 → 演练（只准备）→ 真实发布/回滚。
  每步都有可复制命令、预期结果与故障排查；「环境自检」实时读取本机状态，不伪造通过。
- 教程进度保存在 `client/setup-state.json`，只含步骤布尔值与完成时间，不含凭据。
- **管理员启动**：双击 `Start-Moments-Client-Admin.cmd`，会请求 UAC，并以管理员权限同时启动客户端与 geometry 执行器（默认 PREPARE_ONLY）。首次使用先创建 `data/desktop-account.txt`（写入你的 wxid），或传 `-ExpectedAccount`。
- 需要开放真实发表/删除时，显式加参数：`powershell -ExecutionPolicy Bypass -File scripts\start-client-admin.ps1 -AllowPublish`；这仍受发布模式、一次性审批（第二档）与内容哈希校验。
- OCR 引擎：优先 RapidOCR（`desktop/.vendor/rapidocr_onnxruntime`），失败回退 Windows OCR；都不满足时返回 `OCR_UNAVAILABLE`，不伪造成功。

## 7. 几何执行器与拟人化自动发送（新）

只准备（**可在普通终端运行**；微信进程未提权时允许非管理员同完整性输入；不会点击发表）：

```powershell
python desktop/server.py --port 18765 --token-file data/desktop-token.txt `
  --driver geometry --mode PREPARE_ONLY `
  --trusted-account-source wechatagent `
  --expected-account wxid_... `
  --assume-client-version 4.1.10.27
```

授权发布/删除（三重条件）：

```powershell
python desktop/server.py --port 18765 --token-file data/desktop-token.txt `
  --driver geometry --mode APPROVAL_REQUIRED `
  --allow-publish --geometry-allow-publish `
  --trusted-account-source wechatagent --expected-account wxid_... `
  --assume-client-version 4.1.10.27 `
  --max-publish-click-retries 1 --retry-backoff-seconds 2
```

强制要求管理员（微信进程已提权或安全加固时；非管理员启动会在输入前返回 `PRIVILEGE_REQUIRED`）：

```powershell
python desktop/server.py --port 18765 --token-file data/desktop-token.txt `
  --driver geometry --mode PREPARE_ONLY --geometry-require-admin `
  --trusted-account-source wechatagent --expected-account wxid_... `
  --assume-client-version 4.1.10.27
```

- 管理员门禁自 1.1.9 起**默认自动**：执行器是管理员 → 允许；非管理员且微信进程未提权 → 允许同完整性输入；
  微信已提权或提权状态无法确认 → `PRIVILEGE_REQUIRED`。`--geometry-require-admin` 强制要求管理员。
- 窗口按 **1200×900 物理像素**归一化（不做 DPI 乘法），朋友圈编辑器与右键菜单用屏幕捕获，
  因此要求微信在前台（否则 `WINDOW_BLOCKED`，不点击）；粘贴菜单 fallback 偏移为 (40,34)。
- 需要 Windows OCR（DSH Python 3.12 + `desktop/.vendor` 的 RapidOCR/回退 winsdk + 中文语言包）；
  默认仍是 UIA/PREPARE_ONLY；OCR 不可用返回 `OCR_UNAVAILABLE`，不伪造成功。
- 拟人化自动发送默认关闭；显式 `policy.humanize.enabled=true` + `publishMode` 为 `APPROVAL_REQUIRED`
  或 `POLICY_AUTONOMOUS` 才工作：活跃时段/每日上限/间隔/抖动/相似去重/重试上限；`UNCERTAIN` 永不自动重试。
  第三档自动发表已于 2026-10-25 真机 E2E 验证 1 条（`docs/audit/AUTO_PUBLISH_LIVE_1_1_9.md`），删除/回滚仍未验收。
- 详见 `config/moments.example.yaml` 的 `policy.humanize` 段和 `docs/audit/VERIFICATION_ROUND5.md`。

## 8. 卸载与清理

1. `plugin_manager` `remove_bundle`，`target: dsh-moments-agent`；
2. 如需清理数据：先备份 `data/moments.sqlite` 与 `data/assets`，再删除 `data/`；
3. 删除桌面执行器 token：`data/desktop-token.txt`；
4. 删除测试临时数据：`tests/` 运行时使用系统临时目录，测试结束自动清理。

**卸载不会自动删除你的数据库/素材**，这是有意的防误删设计。

## 9. 升级

1. 备份 `data/`；
2. 拉取/替换代码；
3. `npm install && npm run build && npm run verify`；
4. 在 DSH 中重载插件（必要时重启 DSH）；
5. 运行 `npm test` 与 `python desktop\tests\run_tests.py`；
6. 查看 `data/moments.sqlite` 的 `schema_migrations` 版本。

> 本版本只有迁移 v1；新增迁移必须保持向前兼容并写测试。

