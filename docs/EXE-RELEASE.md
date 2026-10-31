> 当前配套版本：客户端 1.2.3 / 插件 0.3.2。升级时将旧包 client/moments-client.json 和 client/setup-state.json 复制到新包的 client 目录，保留连接和首次配置进度。1.2.3 的发表等待提示尚未完成真实发表复测；1.2.2 曾完成实机纯文字发表。详见 [0.3.2 发布说明](https://github.com/yuejain/dsh-moments-agent/blob/main/docs/releases/v0.3.2.md)。

# Windows EXE 1.2.0

本版配套 **DSH 插件 0.3.0**，在保留 1.1.9 几何发布链路的基础上，重点解决"新用户第一次打开怎么配置"，并接入社交记忆管理。

## 本版关键变化

1. **首次启动自动配置**：全新解压第一次启动时，浏览器地址带 `?firstrun=1`，页面弹出「首次启动」引导——自动只读检测 DSH profile、插件安装/数据目录、WeChatAgent 的 Reader/Hook 地址与令牌**文件路径**、微信账号（掩码）、模型 provider/model；点「一键自动配置（先备份）」并勾选二次确认后，才会写入选中 profile 的 `- id: dsh-moments-agent` 条目（写前自动 `.bak` 备份、其他插件条目/注释/`!!js` 原样保留），并把客户端连接配置改写为检测到的插件 data 目录。写入后必须重启 DSH 插件生效。检测失败可回退到原有分步教程。
2. **社交记忆管理**：设置页新增「社交记忆」卡片（默认关闭）——只读 WeChatAgent 聊天范围内白名单会话，提炼匿名人物印象（`群友A`/`群聊A`），用于朋友圈选题/创作弱参考；真实昵称只存本机、可编辑/删除，草稿含真实昵称或原文片段会被硬门禁拒绝。开启前请阅读 [社交记忆](https://github.com/yuejain/dsh-moments-agent/blob/main/docs/architecture/chat-memory.md)。
3. **配套插件 0.3.0**：新增 3 个工具（共 20 个：`moments_sync_chat_memory` / `moments_get_chat_memory` / `moments_update_member_impression`）、6 个社交记忆管理端点；SQLite 自动迁移 v3，启用社交记忆不需要清库。
4. **首次启动端点**：客户端 `GET /api/client/first-run`（只读，后台检测 + 缓存 + `?refresh=1`），供安装包首次启动流程使用；`POST /api/client/auto-configure` 成功后新增 `clientConfig` 字段。
5. **保留 1.1.9 能力**：物理像素窗口归一、编辑器/右键菜单屏幕捕获、Per-Monitor-V2 DPI、非管理员同完整性输入、三级发表模式、拟人化自动发送、内置执行器与客户端同进程。

## 使用方式

完整解压到**可写目录**（首次启动会生成 `client/moments-client.json`、`client/setup-state.json` 等；不要放在 Program Files 等只读位置），双击 `DSH-Moments-Client.exe` 并在 Windows UAC 中允许管理员运行。该 EXE 声明管理员权限；普通权限同完整性输入是独立 Python 执行器的能力。需要保留旁边的 `_internal` 目录，无需安装 Python；OCR 使用包内 RapidOCR，可回退到 Windows OCR。

启动前退出旧版客户端和旧版独立执行器，释放 18770 / 18765 端口。运行中的 DSH 插件（0.3.0）负责模型、管理 API 与审批状态；本 EXE 是客户端与执行器，不包含 DSH 主程序。

## 首次启动流程

1. 装好并启用 DSH 插件 `dsh-moments-agent 0.3.0`，登录 DSH 模型账号，启动并登录 WeChatAgent。
2. 首次双击 EXE：页面弹出「首次启动」引导，显示检测到的 profile、配置路径、dataDir、Reader/Hook、账号（掩码）、模型与 warnings；可展开查看将要写入的 YAML（只含路径与安全默认值，不含任何令牌）。
3. 点「一键自动配置（先备份）」→ 勾选确认 → 写入 profile 并备份；客户端 `client/moments-client.json` 同步指向检测到的插件 data 目录；页面显示备份路径与「重启 DSH 后生效」。
4. 重启 DSH 插件，回到客户端点「环境自检」，确认插件、模型、WeChatAgent、账号一致后继续首次配置教程。
5. 选择「稍后」会按客户端版本记住，不再自动弹出；可在「首次配置 → 第 06 步 → 自动配置本机环境」重新打开。

自动配置失败（未找到 WeChatAgent、没有 profile、无权限写 profile 等）不会阻塞进入应用，可继续使用分步教程手工配置。**程序不会静默修改 profile，也不会把令牌正文写入配置、日志或界面。**

## 首次配置与发表模式

首次运行默认「仅准备不发表」。先安装/重载 **0.3.0** 插件，再进入客户端「设置 → 发表模式」选择并应用：

| 选项 | 实际行为 |
| --- | --- |
| 仅准备不发表 | 审核通过后可填入微信编辑器，任何发表请求均被禁止，不点击发表。 |
| 审批后发表 | 每条内容需要有效、未使用的一次性审批；准备和发表均校验账号、正文、图片与可见范围。 |
| 不审批直接发表 | 审核通过后可直接发表，无逐条人工审批和发表确认弹窗；仍校验内容快照、账号、额度、时段与桌面状态。 |

应用操作会同步插件和本 EXE 的执行器权限并持久保存；重启后恢复。无需增加 `--allow-publish` 启动参数。同步失败时执行器降为「仅准备不发表」。准备中、已准备或发表中的任务会阻止切换。

## 社交记忆

- 默认关闭；在「设置 → 社交记忆」或插件配置 `chatMemory.enabled=true` 开启，私聊需单独开启 `includePrivate`。
- 只读 WeChatAgent「聊天范围」白名单内的会话；消息默认保留 30 天、人物印象 90 天，可随时清除会话或删除印象。
- 提示词只使用别名；真实昵称/原文只存本机；关闭后不读取微信消息（本地已存历史仍用于泄漏门禁比对）。
- 详细说明与配置见 [社交记忆](https://github.com/yuejain/dsh-moments-agent/blob/main/docs/architecture/chat-memory.md)、[自动配置](https://github.com/yuejain/dsh-moments-agent/blob/main/docs/operations/AUTO_SETUP.md)。

## 设置、调度与日志

- 「自主创作」设置检查间隔、每次创作概率与随机延迟。
- 「自动发送」独立设置开关、每日上限、最小间隔、随机等待范围、活跃时段、静默时段与时区；更多设置可调整额外间隔、抖动与失败退避。
- 保存时校验全部字段，成功后立即生效并持久保存在插件数据库，重载插件后恢复。
- 关闭浏览器应用窗口后，心跳停止约 60 秒，客户端与内置执行器一起退出。日志位于插件 data 目录下 `client-web.log` 与 `desktop/executor.log`。

## 升级与兼容

- 升级必须同时更新插件与 EXE：安装随交付的 `dsh-moments-agent-0.3.0.tgz`（或源项目 `npm run build` 后在 DSH 中重载插件），再替换 EXE 目录。
- 从 1.1.9 升级时，保留解压目录中的 `client/moments-client.json`（连接配置）与 `client/setup-state.json`（教程进度）；直接覆盖 EXE/`_internal` 即可。缺失时会重新进入首次启动引导。
- 插件数据库自动迁移 v3（社交记忆表），无需清库；社交记忆默认关闭，不影响原有发布链路。
- 发表模式来自插件数据库 `system_settings.publish_mode`，EXE 启动时会向插件同步；插件不可达时保持仅准备。
- 几何坐标只在已验证客户端版本（4.1.10.27）与固定物理窗口/显示器配置下成立；升级微信或更换缩放/多屏后需重新测绘验收。
- 真实"删除/回滚"仍未做真机验收；历史测试动态需人工删除。

## 签名与重建

当前交付的便携包使用本地自签名证书做 SHA256 Authenticode 签名并附加 DigiCert 时间戳。签名主体为 `DSH Moments Agent Local Build`，公钥证书随包提供；私钥只保留在构建用户的证书库，未随包分发。自签名证书不自动获得 Windows 或其他电脑的信任，分发时请保留完整目录或 ZIP。

重建：使用 Python 3.12 创建 `.tmp/exe-build-env` 虚拟环境，安装 `scripts/exe-requirements-lock.txt`，再运行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/package-exe.ps1 -SigningThumbprint D54E26CAE38C7C302FE583A7C3360A93C5C1EA5B
```

签名前先退出正在运行的 EXE。省略签名参数生成未签名构建；单独签名使用 `scripts/sign-exe.ps1`。
