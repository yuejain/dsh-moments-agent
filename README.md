# DSH Moments Agent

让 **DeepSeek 更像人，自主发布自己想发布的朋友圈**。

这个项目希望让 DeepSeek 形成持续的个人表达：根据人格、记忆与关注的话题，判断有没有值得说的内容，自主选题、创作文案与配图，也能选择沉默。实际发表遵循所有者选择的模式和调度设置。

项目由 **DSH Cordis 插件 + Windows 客户端及同进程桌面执行器**组成。**前置插件：WeChatAgent**，用于微信账号识别和本机 Reader / Hook 连接；朋友圈编辑与发表由本项目的 Windows GUI 执行器完成。

## 最新下载

当前配套版本：**插件 0.3.0 / Windows 客户端 1.2.0**，发布于 2026-10-25。

| 下载 | 用途 |
| --- | --- |
| [Windows EXE 便携包](https://github.com/yuejain/dsh-moments-agent/releases/download/v0.3.0/DSH-Moments-Client-1.2.0-win64-exe.zip) | 管理界面、首次启动引导、内置桌面执行器、OCR；无需另装 Python |
| [DSH 插件包](https://github.com/yuejain/dsh-moments-agent/releases/download/v0.3.0/dsh-moments-agent-0.3.0.tgz) | 安装到 DSH，负责模型、记忆、任务、审核、审批和调度 |
| [SHA256 校验值](https://github.com/yuejain/dsh-moments-agent/releases/download/v0.3.0/DSH-Moments-Client-1.2.0-SHA256SUMS.txt) | 校验 EXE、ZIP 和插件包 |
| [完整发布页面](https://github.com/yuejain/dsh-moments-agent/releases/tag/v0.3.0) | 更新说明、静态包验证和签名信息 |

**插件和客户端请成对升级。** EXE 不包含 DSH 主程序，也不能替代 DSH 插件。便携包需完整解压，保留 `_internal` 目录。

EXE 使用本地自签名证书进行 SHA256 Authenticode 签名，并附 DigiCert 时间戳；自签名不会自动成为其他电脑信任的发布者。私钥不随包分发。

## 这一版更新了什么

- **首次启动自动配置**：读取本机 DSH profile、插件位置、WeChatAgent 连接、账号和模型，展示预览；所有者确认后先备份，再写入选中插件条目，并同步客户端连接。
- **社交记忆**：显式开启后，在白名单聊天范围内读取群聊/私聊，提炼匿名人物印象，作为选题与创作的弱参考；默认关闭，私聊需单独允许。
- **发表模式与自主调度**：仅准备、审批后发表、不审批直接发表；自主创作和自动发送各有开关，并持久保存。
- **微信 4.x 几何修复**：固定为 **1200×900 物理像素**，修正旧版按逻辑尺寸随 DPI 放大导致的偏移；编辑器和右键菜单改用屏幕捕获，增加前台进程校验。
- **设置与表达技能**：修复保存读回、刷新排队和旧缓存覆盖；内置 Lieflat 去 AI 味与朋友圈自然表达，可分别启用。

详见 [本次更新说明](docs/releases/v0.3.0.md) 和 [更新日志](CHANGELOG.md)。

## 环境要求

| 组件 | 当前基线 |
| --- | --- |
| 系统 | Windows 10/11 x64 |
| DSH Desktop | 0.2.1-rc.3；rc.2 兼容记录见审计文档 |
| WeChatAgent | 0.3.9，需先配置并登录目标微信 |
| 微信 | 4.1.10.27 Hook/geometry 验证基线；其他版本需重新验收 |
| 开发环境 | Node.js ≥22.19、Python 3.11/3.12；EXE 用户无需另装 Python |

上游：[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)、[WeChatAgent](https://github.com/sourcepro5/WeChatAgent)。WeChatAgent 不提供本项目所需的受支持朋友圈发表 API，因此仍需 Windows 桌面执行器操作微信界面。

## 首次使用

1. 安装并启动 DSH，登录可用的模型账号；安装、配置 WeChatAgent，确认目标微信已登录，Reader/Hook 服务正常。
2. 下载插件 `.tgz` 并解压。归档内的 `package` 是插件目录；在 DSH 插件管理页选择从本地目录安装，指向该目录。也可从源码目录安装。
3. 将 EXE ZIP 完整解压到可写目录。退出本项目旧客户端和旧执行器，避免占用 `18770` / `18765`；双击 `DSH-Moments-Client.exe`，按 UAC 提示运行。
4. 首次启动会只读检测本机环境。核对 profile、插件数据目录、Reader/Hook 和掩码账号，查看将要写入的配置；确认后点击自动配置。写入前会备份原 profile，其他插件条目、注释和 `!!js` 保留。
5. 重载或重启 DSH 插件，回到客户端做环境自检。自动配置失败时可使用首次配置分步教程或手工配置。
6. 先保留 **仅准备不发表**，生成并审核一条纯文字内容，确认微信编辑器中粘贴和读回一致。窗口默认统一为 1200×900 **物理像素**；工作区不足、窗口变化、遮挡或切换到其他程序时会停止相关操作。
7. 按需选择发表模式和调度开关。选择模式本身不会立即发送；真实发表前核对账号、内容、可见范围、每日额度和活跃/静默时段。

操作说明：[EXE 使用说明](docs/EXE-RELEASE.md)、[自动配置](docs/operations/AUTO_SETUP.md)、[安装与部署](docs/operations/INSTALL.md)、[故障排查](docs/operations/TROUBLESHOOTING.md)。

自动配置使用保守默认值：仅准备、不启用自主创作和自动发送，社交记忆、私聊读取及付费生图关闭。它不会静默授予发表权限，也不会把令牌正文写入界面或配置。

## 三级发表模式

| 模式 | 行为 |
| --- | --- |
| 仅准备不发表 `PREPARE_ONLY` | 可生成、审核和准备编辑器，所有发表请求被拒绝 |
| 审批后发表 `APPROVAL_REQUIRED` | 每条内容需要有效、未使用的一次性审批，发表前复核账号与内容快照 |
| 不审批直接发表 `POLICY_AUTONOMOUS` | 审核通过后可直接发表，无逐条人工审批；已开启的发送调度可按此模式执行 |

三档均保留账号、内容、可见范围、额度、间隔、时段、暂停及 Kill Switch 等检查。`UNCERTAIN` 表示点击后无法确认结果，禁止自动重发，需人工核对后收敛状态。

设置中的两个调度开关分别控制：

- **自主创作**：定期判断是否有值得表达的内容，允许沉默；有未结束任务时等待处理。
- **自动发送**：按当前模式、审核/审批和拟人化节奏处理可发送任务。仅准备模式始终不发表。

## 记忆与表达

人格、配图风格和长期记忆用于持续表达。新增社交记忆默认关闭；开启后只读白名单会话，私聊还需 `includePrivate=true`。模型使用匿名别名，消息默认保留 30 天、人物印象 90 天过期，支持清除会话。含真实昵称或长度达到门槛的聊天原文片段会被 `CHAT_PRIVACY_LEAK` 门禁拒绝。详见 [社交记忆设计](docs/architecture/chat-memory.md)。

表达技能包括 MIT 许可的 [Lieflat 去 AI 味](https://github.com/larashero3-dotcom/lieflat-less-ai-tone) 和项目内的“朋友圈自然表达”。技能只提供措辞规则，不执行上游脚本、不增加模型调用次数；会增加原有请求的提示上下文。技能开关影响后续创作与审核，不自动改写既有草稿和审批快照。

## 架构

```text
DSH 插件：模型、人格/记忆、20 个工具、SQLite、审核/审批、调度
  └─ 管理 API 127.0.0.1:18766
       ↑ 本机客户端代理（浏览器不接触令牌正文）
Windows 客户端 127.0.0.1:18770
  └─ 同进程桌面执行器 127.0.0.1:18765
       └─ 微信窗口、剪贴板、屏幕捕获与 OCR
WeChatAgent：本机 Reader / Hook 与账号核对
```

管理 API 和执行器只绑定回环地址。配置只保存凭据引用；数据、令牌和账号文件保存在本机数据目录，不在仓库和发布包中分发。

详见 [管理 API](docs/architecture/admin-api.md)、[自动发表链路审计](docs/audit/AUTOPUBLISH_CHAIN_AUDIT.md)、[静默自主发送方案](docs/QUIET_AUTONOMOUS_PUBLISHING.md)。

## 开发与测试

```powershell
npm ci
npm test
npm run verify
python -X utf8 desktop/tests/run_tests.py
python -X utf8 -m unittest discover -s client/tests -v
```

2026-10-25 发布复核，使用 Node 与 Python 3.12：

| 检查 | 结果 |
| --- | --- |
| Node 单元及集成 | 242 项：241 通过、1 跳过 |
| 桌面执行器 | 271 项：268 通过、3 跳过 |
| Windows 客户端 | 177 项全部通过 |
| 插件进程内自检 | 20 个工具注册、health/status、数据库和保守发表策略通过 |
| 总计 | **686 通过、4 跳过** |

这些回归使用 Mock/Fake，不驱动真实微信。发布包另核验 ZIP CRC、源码与归档一致性、内嵌 Python、管理员/PerMonitorV2 清单、敏感文件排除和签名完整性。

已有现场记录显示，1.1.9 修复链路在微信 4.1.10.27、150% DPI、独立 Python 执行器下完成过一次免逐条审批的自动发表与 OCR 核验。**这不是 1.2.0 EXE 的 UAC 启动或真实发表验收，也不代表任意版本、显示器或主题均可复现。** 原始截图和账号记录保留在本机，不随公开源码和插件包分发；公开记录已脱敏。见 [现场验收摘要](docs/audit/AUTO_PUBLISH_LIVE_1_1_9.md)。

当前仍需验收：1.2.0 EXE 在目标环境的 UAC 启动与真实发布、其他微信版本/主题/显示器、真实删除/回滚、微信通知发送、订阅生图。发布使用小额度并保留人工核对。

## 目录与许可

`src/` 为 DSH 插件；`client/` 为管理界面与自动配置；`desktop/` 为执行器；`skills/` 为表达技能；`tests/` 为回归；`docs/` 为设计、部署和脱敏验证说明。

MIT。第三方许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 和各技能目录；EXE 附带 `third-party-licenses`。不分发微信客户端、WeChatAgent Hook 二进制、真实凭据、账号文件、数据库或原始聊天记录。
