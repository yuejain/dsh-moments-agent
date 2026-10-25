# 已知限制与未验证项

审计基线：提交 `0e76902a66c7bde6a3f78335284cea7f9be6e1b1`（`sourcepro5/WeChatAgent`，`Release WeChatAgent 0.3.9`，2026-10-20）｜审计日期 2026-10-20｜审计方法：静态源码审计 + 本机 git 事实核对；无法运行的部分（真实微信、DSH、Hook、安装器、上游回归测试）在文中逐条标注“未运行验证”，绝不把 README/RELEASE_NOTES 的自述当作已验证事实。

## 1. 本次审计自身的限制

1. **只能做到源码级**：本机没有 DSH 0.2.0-rc.2、没有与项目匹配的微信 4.1.10.27、没有 `components/WeChat-Hook` 源码、没有 `wx_key.dll`、没有安装器，因此无法复现任何真实收发、Hook 加载、数据库解密、图片解码。
   - 交叉核对：同工作区的环境审计记录（`docs/audit/ENVIRONMENT.md`，另一任务产出）实测本机微信为 **4.1.15.13（未运行）**，与本项目精确要求的 `4.1.10.27`（`project-config.mjs:40`、`components.json:43`）不一致。即使装好 Hook，按源码逻辑也会在版本校验处拒绝（`wechatagent_hook.cpp:227`、`wechat-account-check.mjs:15`），因此本环境**不能**直接用于真实收发验证。
2. **上游回归测试无法执行**：`package.json:32-41` 声明了 `test:*` 脚本、`scripts/` 下有 30 个 `test-*.mjs`，但本会话沙箱禁止子进程 stdio 管道；实测 `node --test scripts/test-reply-protocol.mjs` 与 `node --test scripts/test-prompt-policy.mjs` 均以 `Error: spawn EPERM` 失败（Node v24.14.1，2026-10-20）。**因此所有“N 项回归通过”的自述（`docs/TEXT_DELIVERY.md:23`、`docs/DSH_SESSIONS.md:112,114,118`、`docs/IMAGE_INPUT.md:76` 等）在本次审计中均未验证。**
3. **无法审计二进制**：`version.dll`、`wx_key.dll`、微信客户端、DSH 桌面端均不在源码中；覆盖层源码可读，但其编译产物与上游 Hook 主体行为未知。
4. **动态行为未验证**：回执时序、WebSocket 分片、图片解码、模型输出的实际格式、DSH preset 实际挂载等均按代码推断，未做运行时观测。

## 2. 上游功能缺口（源码/文档一致确认）

| 缺口 | 证据 |
| --- | --- |
| **完全没有朋友圈（Moments）实现** | 全仓库 `git grep "朋友圈\|moments\|sns"` 仅命中一张 PNG 图标（二进制匹配），`scripts/*.py` 中无任何朋友圈接口/表名/解析 |
| 不支持主动拍回、文件发送、语音/视频理解 | `README.md:31` |
| 发送端只回复文字，不向微信发图片 | `docs/IMAGE_INPUT.md:9`；`wechat-onebot-adapter.js:52-76` 只有 text 发送 |
| 表情池容量 50，超出需 DS 模型评选 | `wechat_sticker_collection.py:6`（`MAX_ENTRIES=50`）；`docs/STICKER_COLLECTION.md:9,14` |
| 表情池只在“同一微信账号的已允许好友/群聊”内共享 | `docs/STICKER_COLLECTION.md:3`；`wechat_sticker_collection.py:72-83` |
| 联网搜索/主动聊天默认关闭 | `config/wechatagent.example.json:48-57,58-68` |
| 只支持 Windows x64 + 微信 4.1.10.27 | `project-config.mjs:40`（精确版本校验）；`README.md:24,90` |
| 单实例/单账号 | 多账号数据库会被拒绝：`wechat-account-check.mjs:19`（`HOOK_MULTIPLE_ACCOUNT_DATABASES`） |
| DSH 版本窗口窄 | `packages/dsh-social-bridge-plugin/package.json:9-15`（`>=0.2.0-rc.2 <0.3.0`） |
| 源码副本不含任何可执行/私有组件 | 见 `UPSTREAM_SOURCES.md` §5 |

## 3. 文档与源码不一致（本次实测，影响信任度）

> 这些不是“文档没写清楚”，而是**描述与当前提交的代码/元数据不符**，下游引用时必须以此表为准。

| 编号 | 文档声明 | 源码实测 | 证据 |
| --- | --- | --- | --- |
| L1 | `docs/DSH_SESSIONS.md:15,17`：健康接口 `coherencePolicy: single-persona-v1` | 实际返回 `COHERENCE_POLICY = PROMPT_POLICY = 'stable-instructions-v3'` | `prompt-context.mjs:9`；`native-context.mjs:31,480` |
| L2 | `release-profile.json:343`：`promptContext.policy = stable-instructions-v2` | 同上，代码为 v3；且 `release-profile.json` 整体是 0.3.6 数据 | `release-profile.json` `version=0.3.6` |
| L3 | `docs/WECHAT_HOOK.md:36`：“最多等待 30 秒” | `deferred_init.cpp:15,32-38`：30 秒只打印 `module_wait_delayed` 警告，**之后继续无限等待**；`build-hook.ps1:69` 写的 `moduleWaitTimeoutMs=0` 也表示无超时 | `deferred_init.cpp:16-56` |
| L4 | `README.md:116`：“公开副本不附带开发回归测试” | 实际附带 30 个 `scripts/test-*.mjs`，`package.json:32-41` 仍保留 `test:*` 脚本 | `git ls-files 'scripts/test-*'` = 30 |
| L5 | `components.json:3,34`：项目版本 `0.3.6`、桌面组件 `0.3.5` | `package.json:3` 与 `apps/console-desktop/package.json:3` 均为 `0.3.9` | 三个文件实测 |
| L6 | `release-profile.json`：`version 0.3.6`、`tag v0.3.6`、安装器 `WeChatAgent-Setup-0.3.6-x64.exe`、`date 2026-10-16` | HEAD 是 0.3.9（2026-10-20）；0.3.9 的 profile 不存在 | `release-profile.json`；`git log -1` |
| L7 | `release-profile.json`：`sourceFileCount=202`、`sourceBytes=3177875` | 实际 269 个跟踪文件、约 3.68 MB | `git ls-files` 计数 |
| L8 | `README.md:61`：“每轮 1–3 次检索” | 配置样例 `search.maxSearchesPerTurn=1`（默认），代码另有 `search-budget.mjs` 的每轮计数，未见“1–3”默认 | `config/wechatagent.example.json:53` |
| L9 | `docs/STICKER_COLLECTION.md:31`：来源 `auto` 先 Bing、失败 Openverse，可切 `imgflip` | 具体实现依 `extensions/skills/meme-search/index.js` 与配置，本次只读入口文件，未逐行审计三个 provider 的失败切换 | 未完整验证 |
| L10 | `docs/ACCOUNT_SWITCH.md:14`：切换后“请从托盘完整退出并重开 DSH” | 插件侧确实在账号变化时返回 409 要求重启（`native-context.mjs:481`），但“聊天范围/人格/表情池按账号恢复”依赖 `applyReaderAccount()` 的文件搬迁（`reader-account-state.mjs:66-130`），其失败回滚与 Windows 联接场景未运行验证 | 静态可读，未运行 |
| L11 | 根 `LICENSE:94` 自述“源码中没有 telemetry” | 本次 `git grep` 未见上报代码，但无法排除二进制组件（Hook/微信/DSH）的行为 | 仅源码范围成立 |

补充：`docs/` 中多份文档写有“完整回归 N 项通过”“已在真实微信/DSH 验收”等历史结论，均属于**维护者自述**，本次审计不具备复现条件（见 §1.2）。

## 4. 平台与部署限制

1. **系统**：仅 Windows 10/11 x64；`apps/console-desktop` 依赖 Electron 41（devDependency），源码模式需 `npm ci` 后构建。
2. **Node/Python**：Node `>=22.13.0`（`package.json:8-10`；本机 24.14.1 可运行脚本语法检查）；Python 3.10+ 与 6 个固定依赖（`scripts/reader-requirements.txt`）。
3. **端口**：4 个项目端口必须互异且 1024–65535（`project-config.mjs:48-50`）；Hook 端口不得与项目端口重复（`:45-46`）；控制台默认端口 3210，被占用时自动换 20000–60000 随机端口（`console-server.mjs:598-602`）。
4. **文件系统**：数据目录支持迁移，但**不支持软链接/目录联接**穿过 `state/` 边界（`reader-account-state.mjs:46-57`；`member-memory.mjs:21`）；迁移失败会整体回滚（`reader-account-state.mjs:120-129`）。
5. **权限语义**：代码用 `mode:0o600` 表达“仅本用户”，但 Windows 上不构成 ACL 保证（见 `SECURITY_REVIEW.md` S4）。
6. **多实例**：`pin-hook-client.ps1`/`launch-hook-wechat.ps1:15-24,44` 明确不结束其他微信实例，端口占用时直接报错；一个微信账号同时只允许一个匹配客户端进程。

## 5. 安全与合规限制（无法在本项目内解决）

1. **代码签名缺失**：`release-profile.json` 的 `validationLimits.codeSigned=false`；安装器/DLL 无签名，用户只能靠 SHA256 清单（而清单本身在 0.3.9 缺失，见 L6）。
2. **第三方 Hook 许可未确认**：`components.json:45`；本项目在构建期修改其源码（`build-hook.ps1:29-39`），再分发/再编译的授权基础不明确。
3. **根 LICENSE 授权范围不清**：根 LICENSE 是 qq-bridge MIT 文本（`LICENSE:1-3`），不是本项目自有代码的授权声明；`LICENSES.md` 的“维护者已确认授权”是自述，无授权文本。
4. **数据外发不可关闭**：使用云端模型即意味着聊天内容/图片/人格会发送到模型服务（`README.md:132`）；文档已声明，但不提供本地模型替代路径的内置开关。
5. **平台条款**：非官方 Hook 接入微信可能违反平台条款（根 `LICENSE:77` 的上游提示同样适用于本项目）；项目自述“仅供学习/个人实验”（`README.md:140-142`），但不构成法律授权。
6. **私域数据默认落盘**：`state/social-messages.json`（聊天原文）、`state/media/`（图片）、`state/member-memory/`（群友标签）均在本机明文（0600 提示）；`docs/TEXT_DELIVERY.md:17`、`docs/DSH_CHAT_ACCESS.md` 等均要求“不应发布”，但无加密存储。

## 6. 复用/移植到朋友圈前的硬性前置条件

1. 朋友圈发布通道必须重新获得（当前源码零实现，见 §2）；
2. 发送回执不能沿用微信数据库匹配（`REUSE_DECISIONS.md` §1.2）；
3. 不能复用聊天私密表情池/图片池做公开发布（`REUSE_DECISIONS.md` §3.3、§6）；
4. 主动聊天的调度条件（聊天白名单/空闲/未读）不适用于朋友圈（`REUSE_DECISIONS.md` §2.3）；
5. 必须先解决第三方 Hook 许可与签名问题，再考虑把“自动发布”接入真实账号（`SECURITY_REVIEW.md` S1/S2/S3）。

## 7. 未验证结论清单（引用时请标注）

- 所有“N 项回归通过”“真实 DSH/微信验收”类历史结论（§1.2）。
- Hook 延迟初始化在不同加载时序下的行为（30 s 后继续等待是代码事实，但 30 s 内的 `startupState` 观测未做）。
- `assertProactive()` 在真实微信数据库上的快照匹配（`hook-onebot.mjs:227-240`）：依赖 `state/social-messages.json` 与真实 `createTime`，未运行验证。
- 表情池 DS 评审在真实模型上的输出（`sticker-pool-review.mjs`）：未运行。
- 图片解码（AES/XOR、WXGF、GIF 采样）在真实数据上的效果：未运行。
- 安装/升级/卸载与数据迁移（`DATA_STORAGE.md`、`apps/console-desktop/storage-location.cjs`）：未运行。
- 控制台 CSRF/Host 防护在真实浏览器中的表现：按代码可读，未做动态验证。

## 8. 维护建议

1. 发布 0.3.9 时同步 `components.json`、`release-profile.json`（版本、文件数、哈希、安装器 SHA256），否则发行元数据不可信。
2. 把 `docs/DSH_SESSIONS.md` 的 `single-persona-v1` 更新为实际策略名，或让 health 同时返回 `promptContext` 与 `coherencePolicy` 两个独立字段（当前二者混用同一常量：`native-context.mjs:31`）。
3. 修正 `docs/WECHAT_HOOK.md` 的“最多等待 30 秒”，明确“30 秒后记录警告并继续等待，无超时上限”。
4. 在 README 区分“本次公开副本包含的 30 个回归脚本”与“不包含的开发数据/合成数据生成器”，避免 L4 类歧义。
5. 若继续分发，补一份覆盖本项目自有代码的 LICENSE/NOTICE，并把 qq-bridge 的 MIT 文本只用于组件目录。

## 9. 重点文件逐项核对状态（任务清单对照）

下表是本次审计对任务点名文件的**实际读取状态**；“已读”表示逐行读取并据此产出结论，“不可运行”表示文件已读但依赖缺失组件，无法执行。

| 任务点名文件 | 存在 | 本次读取 | 关键结论位置 |
| --- | --- | --- | --- |
| `README.md` | 是（16012 B） | 已读全文 162 行 | 版本声明、构建命令、私有组件声明、dev 测试声明（L4） |
| `RELEASE_NOTES.md` | 是（5418 B） | 已读全文 36 行 | 0.3.9 变更与验证范围自述 |
| `LICENSE` | 是（12733 B） | 已读全文 149 行 | 实为 qq-bridge MIT 文本（S2） |
| `LICENSES.md` | 是（3876 B） | 已读全文 30 行 | 组件来源表与外部内容声明 |
| `components.json` | 是（2438 B） | 已读全文 72 行 | 版本落后 0.3.6（L5）、Hook 许可未确认（S1） |
| `package.json` | 是（3324 B） | 已读全文 51 行 | 版本 0.3.9、devDependencies、test 脚本（L4） |
| `docs/EXTERNAL_DSH.md` | 是（1740 B） | 已读全文 16 行 | DSH 独立安装与 `dshBundled:false` |
| `docs/WECHAT_HOOK.md` | 是（2905 B） | 已读全文 40 行 | 契约、错误码、30 秒表述（L3） |
| `docs/DSH_CHAT_ACCESS.md` | 是（4315 B） | 已读全文 47 行 | 按聊天技能/工具授权流程 |
| `docs/PROACTIVE_CHAT.md` | 是（3483 B） | 已读全文 35 行 | 主动聊天契约（与代码核对通过，除 L8 类默认值差异） |
| `docs/SESSION_GROUPS.md` | 是（2739 B） | 已读全文 32 行 | 工作区分组与跨目录移动 |
| `docs/STICKER_COLLECTION.md` | 是（4439 B） | 已读全文 37 行 | 50 张池、共享边界（REUSE §3.3） |
| `docs/ACCOUNT_SWITCH.md` | 是（1907 B） | 已读全文 16 行 | 账号切换与错误码 |
| `docs/DATA_STORAGE.md` | 是（3038 B） | 已读全文 26 行 | app/data 分离与迁移 |
| `packages/.../index.js` | 是（1 行） | 已读 | 仅转发 `native-context.mjs` |
| `packages/.../native-context.mjs` | 是（608 行） | 已读全文 | 插件 HTTP、会话、人格、工具绑定 |
| `packages/.../cordis.patch.yml` | 是（34 行） | 已读全文 | preset `wechat-social` 与工具守卫 |
| `packages/.../dsh-access.mjs` | 是（41 行） | 已读全文 | 授权工具白名单与 skill 资源限制 |
| `packages/.../social-tool-restrict.mjs` | 是（18 行） | 已读全文 | 工具 guard 与 prompt 裁剪 |
| `packages/.../image-input.mjs` | 是（79 行） | 已读全文 | 图片完整性校验与卸载 |
| `packages/.../member-memory.mjs` | 是（95 行） | 已读全文 | 群友记忆工具与文件校验 |
| `packages/.../context-policy.mjs` | 是（31 行） | 已读全文 | 压缩阈值与空闲判定 |
| `components/qq-bridge/src/social-bridge.js` | 是（104 行） | 已读全文 | 进程装配与定时器 |
| `scripts/text-delivery-store.mjs` | 是（27 行） | 已读全文 | 投递状态机（REUSE） |
| `scripts/hook-onebot.mjs` | 是（548 行） | 已读全文 | 发送/回执/令牌/OneBot 适配 |
| `scripts/project-config.mjs` | 是（134 行） | 已读全文 | 配置校验、令牌、patch 修订号 |
| `scripts/reader-account-state.mjs` | 是（130 行） | 已读全文 | 账号隔离与迁移 |
| `scripts/wechat_image_normalize.py` | 是（43 行） | 已读全文 | 有界图片归一化 |
| `scripts/safe-fetch.js`（任务给出的路径） | **不存在** | — | 实际在 `components/qq-bridge/src/safe-fetch.js`（332 行），已读前 120 行并核对 SSRF 规则 |
| `packages/.../meme-library.mjs` | 是（137 行） | 读入口与 policy，未逐行 | 与 `meme-library-policy.mjs` 联审 |
| `packages/.../model-search.mjs` / `web-reader*.mjs` / `search-*.mjs` | 是 | 读接口签名与部分实现 | 联网搜索受预算限制（`search-budget.mjs`） |
| `components/qq-bridge/src/core/session-router.mjs` | 是（623 行） | 已读全文 | 死模块（REJECT） |
| `scripts/reader-api.py` | 是（1052 行） | 读关键区段（1-200、380-640、840-1052） | HTTP 认证、图片解析、表情池、路由表 |
| `scripts/native-hook/*.cpp\|h` | 是 | 已读 `wechatagent_hook.cpp`、`http_server.cpp`、`deferred_init.cpp`；`sticker_sender/trace` 仅按构建脚本与调用点核对 | 原生覆盖层风险（S1） |
| `apps/console-desktop/*` | 是 | 读 `main.cjs` 前 40 行、`package.json` | 桌面壳与数据目录 |
| `public/console/*` | 是（24 文件） | 未逐文件读；仅核对控制台服务端如何引用 | UI 层不在本次审计重点 |

## 10. 环境与时间基线（便于复现）

| 事实 | 值 |
| --- | --- |
| 审计执行时间 | 2026-10-20 17:35–18:10（Asia/Singapore） |
| 工作目录 | `D:\dsh插插`（Windows，PowerShell 7） |
| 克隆路径 | `D:\dsh插插\upstream\WeChatAgent`（clone 于 2026-10-20 17:35 完成） |
| Node | `v24.14.1` |
| Python | `3.11.2`（`python --version`） |
| Git | 可用；`upstream` 工作树 clean，HEAD = 审计基线 SHA |
| 网络 | 可用（clone 成功；未访问其他外部站点做源码核验） |
| 上游测试 | **不可运行**：`node --test` 子进程 spawn EPERM（沙箱限制） |
| DSH / 微信 / Hook / 安装器 | 均不存在，无法运行 |

## 11. 下游引用规范（避免二次误导）

1. 引用本项目文档时，必须同时引用本审计的 `KNOWN_LIMITATIONS.md` §3（文档与源码不一致表），否则会把 `single-persona-v1`、0.3.6 发行清单等过期信息当作现状。
2. 任何“上游已实现朋友圈”的说法都不成立：源码零朋友圈代码（§2）。
3. 任何“发送可靠性已被验证”的说法，在本次审计中只达到“源码层状态机自洽”，真实微信回执未验证（§7）。
4. 任何“许可已确认”的说法只对 MIT 组件（qq-bridge、weflow-cli、htmlparser2 等）成立；WeChat-Hook 仍是 `Overall license not confirmed`（`components.json:45`）。
5. 引用行号时以本审计基线 SHA 为准；`main` 分支后续提交会使行号漂移。
