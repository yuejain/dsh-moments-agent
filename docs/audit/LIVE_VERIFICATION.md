# 本机实机验证记录（Phase 1 / 安装与加载）

> 记录时间：2026-10-20 17:5x（Asia/Shanghai）
> 环境：Windows，DSH Desktop 0.2.1-rc.2，Electron 44.7.0，Node 24.21.0（DSH 自带运行时）
> 项目：`D:\dsh插插\dsh-moments-agent`

## 1. 构建

```powershell
cd D:\dsh插插\dsh-moments-agent
.\node_modules\.bin\tsc.cmd -p tsconfig.json
```

- 结果：通过（`strict`、`noEmitOnError`、NodeNext）。
- 产物：`dist/**`（含 `dist/index.js`、`dist/image/**`）。

## 2. 安装到当前 DSH profile

使用 DSH 官方 `plugin_manager`（`install_bundle`）安装本地目录：

- target：`D:\dsh插插\dsh-moments-agent`
- 返回：`application: "applied"`、`enabled: true`、`changed: true`、`version: "0.1.0"`、`warnings: []`
- pnpm 结果：`exitCode: 0`，`+ dsh-moments-agent 0.1.0 <- D:\dsh插插\dsh-moments-agent`
- profile `package.json` 新增：`"dsh-moments-agent": "link:D:/dsh插插/dsh-moments-agent"`
- profile bundle 列表新增：`dsh-moments-agent`

结论：**安装 VERIFIED**。

## 3. 加载与工具注册（Host 进程实测）

安装后 Host 的 Tool 清单中出现以下工具（由 `cordis_inspect_query` `Tool.listTools` 实测）：

- `moments_create_idea`
- `moments_compose_draft`
- `moments_select_images`
- `moments_generate_image_task`
- `moments_import_image`
- `moments_review_draft`
- `moments_get_history`
- `moments_preview`
- `moments_request_approval`
- `moments_get_status`
- `moments_cancel_task`
- `moments_prepare_desktop`
- `moments_publish`
- `moments_verify`
- `moments_pause`
- `moments_resume`
- `moments_health`

同时，插件启动时创建了数据目录与 SQLite（说明 `apply()` 已执行、迁移成功）：

```
data/moments.sqlite
data/moments.sqlite-shm
data/moments.sqlite-wal
data/assets/
data/imports/
```

`cordis_inspect_query` `Config.listConfigs(name="dsh-moments-agent")` 返回该行状态 `absent`：
本插件没有导出 `schemastery` Config schema，配置在 `apply()` 内由自研 `parseConfig()` 严格校验。
这不会阻止加载，但意味着 DSH 的设置界面无法展示字段级表单；配置仍可通过 profile patch 覆盖。
（这是已知限制，不是安装失败。）

结论：**加载与工具注册 VERIFIED**；**工具在 Host 内实际执行** 由同一套 `dist` 在 `node --test` 中覆盖（105 项通过），但“从真实对话调用工具并写入同一个 Host 数据库”本轮未做，记为 NOT_TESTED。

## 4. 自动化测试（与本环境同一份代码）

```powershell
cd D:\dsh插插\dsh-moments-agent
npm test
```

- 结果：106 项，105 通过，0 失败，1 跳过（Windows 无权限创建符号链接的用例）
- 覆盖：状态机、SQLite 迁移/持久化、审批绑定与过期/一次性、发布门禁与 UNCERTAIN、内容决策与去重、提示词注入/隐私、路径越界、WeChatAgent 适配器、桌面执行器客户端、图像素材库/审核/Provider、工具注册与返回信封。

## 5. 未验证/受限项

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 真实微信 GUI 准备/发表 | NOT_TESTED | 微信已安装 4.1.15.13（`D:\tencent\Weixin\Weixin.exe`），但 UIA 客户端库缺失、客户端未运行、控件树未验证 |
| WeChatAgent 实机桥接 | NOT_TESTED | 目标环境未安装 WeChatAgent 服务；适配器仅按源码审计契约实现，并用 Mock HTTP 测试 |
| DeepSeek 实际生成质量 | NOT_TESTED（单测用 Mock LLM） | 插件在真实 Host 中可用 `ctx.llm`，但本轮未发起真实生成调用以避免不可控费用/内容 |
| 自动发表 | DISABLED | 默认 `PREPARE_ONLY`；即使配置 `APPROVAL_REQUIRED`，桌面执行器还需 `--allow-publish` |
| 图像真实生成 | NOT_TESTED | ChatGPT/Gemini 订阅桥为人工回传；ComfyUI 仅 Mock；官方付费 API 默认关闭 |
| 卸载 | ✅ VERIFIED | `remove_bundle` 返回 `application: applied`，工具清单中 `moments_*` 消失；随后重装成功、工具恢复 |

## 6. 复现命令

```powershell
# 安装
# （在 DSH 中通过 plugin_manager install_bundle，target = 绝对路径）

# 查看 profile 是否登记
Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\package.json"

# 查看数据
Get-ChildItem D:\dsh插插\dsh-moments-agent\data

# 运行测试
cd D:\dsh插插\dsh-moments-agent
npm test
```

## 7. 第二轮实机验证（2026-10-20 18:16–18:36）

见 [VERIFICATION_ROUND2.md](VERIFICATION_ROUND2.md)。摘要：

- WeChatAgent 已安装并运行（`D:\wechatbot`），Reader 5031 / Hook 30001 / Hook 4.1.10.27；插件 health=ok、账号一致；
- DeepSeek 真实生成 2 条草稿，模型复核通过，真实审批 pending/approved；
- 管理 API 18766 真实运行；Windows 客户端 51 项测试通过、真实联调/截图完成；
- UIA 库已加载（pywinauto/comtypes/pywin32），微信窗口/登录可检测；
- 但微信 4.x Qt 窗口 UIA 只暴露 TitleBar、wxid 不可读，真实 prepare 安全返回 `ACCOUNT_MISMATCH`，真实发表 NOT_TESTED；
- 客户端打包：`release/DSH-Moments-Client-0.2.0-win64.zip`。

