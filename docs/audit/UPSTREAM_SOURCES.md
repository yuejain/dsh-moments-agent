# 上游源码与版本基线（WeChatAgent 0.3.9）

审计基线：提交 `0e76902a66c7bde6a3f78335284cea7f9be6e1b1`（`sourcepro5/WeChatAgent`，提交信息 `Release WeChatAgent 0.3.9`，提交时间 `2026-10-20 15:59:32 +0800`）｜审计日期 2026-10-20｜审计方法：在本机 `D:\dsh插插\upstream\WeChatAgent` 完成真实 git clone 后，逐文件读取源码 / 文档 / 构建脚本，用 `grep -n` 回填行号，用 `git ls-tree`、`git log`、`git tag` 核对提交与文件清单，全文不使用文件名或 README 描述代替代码证据。

## 1. 审计对象的 Git 事实

| 项目 | 实测值 | 证据 |
| --- | --- | --- |
| 工作副本路径 | `D:\dsh插插\upstream\WeChatAgent` | 本机目录 |
| remote origin | `https://github.com/sourcepro5/WeChatAgent.git` | `git remote -v` |
| 默认/当前分支 | `main`（`origin/HEAD -> origin/main`） | `git branch -a` |
| HEAD SHA | `0e76902a66c7bde6a3f78335284cea7f9be6e1b1` | `git rev-parse HEAD` |
| HEAD 提交信息 | `Release WeChatAgent 0.3.9`，作者 `sourcepro5`，`2026-10-20 15:59:32 +0800` | `git log -1 --format='%H%n%an%n%ad%n%s'` |
| 标签 | `v0.2.0` … `v0.3.8`、`v0.3.7-fix`、`v0.3.9` | `git tag -l` |
| 已跟踪文件数 | 269 | `git ls-files \| Measure-Object` |
| 跟踪源码体量 | 约 3.68 MB（含 `QQ.jpg` 456 KB、`public/console/*` 约 190 KB） | `git ls-tree -r -l HEAD` 汇总 |
| 文件类型分布 | `.js/.mjs/.cjs` 134 个、`.py` 19 个、`.md` 45 个 | `git ls-files` 计数 |

工作副本在审计时为 clean 状态（`git status --short` 无输出），审计全程只读，未修改 `upstream/WeChatAgent` 内任何文件。

## 2. 两个（实际为多个）上游来源

本仓库不是单一来源项目，`components.json`（第 5-72 行）与 `LICENSES.md`（第 5-15 行）显式声明了多个上游。审计以本仓库 0.3.9 提交为主对象，同时记录它内嵌的第三方源码子集。

| 上游仓库 | 引用位置 | 版本/提交 | 许可声明 | 是否随本仓库分发 |
| --- | --- | --- | --- | --- |
| `https://github.com/sourcepro5/WeChatAgent` | 本仓库自身 | `0.3.9`，提交 `0e76902…` | `SEE LICENSES.md`（`package.json:7`） | 是（本审计对象） |
| `https://github.com/Derpyu520/qq-bridge` | `components/qq-bridge`（`components.json:9`） | `0.1.7`（`components/qq-bridge/package.json:3`） | MIT（`components/qq-bridge/LICENSE:1-3`，版权 `Derpyu520 and qq-bridge / QSH contributors`） | 是（源码子集） |
| `https://github.com/zhuobichen/weflow-cli` | `components/weflow-cli`（`components.json:18`） | `1.8.2`，来源提交 `3d56da9b91ab46f610ca811029e5782c528a58ec`（`components/weflow-cli/README.md:3`） | MIT（`components/weflow-cli/LICENSE`） | 是（数据库读取源码子集） |
| `https://github.com/aixed/WeChat-Hook` | `components.json:41`、`scripts/build-hook.ps1:19` | 来源提交 `e905d07ade50d2c6472e4eb3bd4f3fe19cf662c6`，目标微信 `4.1.10.27` | `"Overall license not confirmed"`（`components.json:45`） | **否**（源码副本不含 Hook 源码/DLL） |
| `https://github.com/hicccc77/WeFlow` | `components.json:48` | 未记录版本 | `CC-BY-NC-SA-4.0`（`components.json:50`） | 否 |
| `https://github.com/Nixer-2301/WeFlowBackup` | `components.json:54` | 未记录版本 | 未声明 | 否 |
| DeepSeek Harness（`@deepseek-ai/dsh*`） | 插件 SDK 依赖（`packages/dsh-social-bridge-plugin/package.json:5-9`） | `0.2.0-rc.2`（`README.md:23`、`components.json:28`） | MIT（根 `LICENSE:32` 的第三方表） | 否（外部安装） |

结论：任务描述中的“两个上游仓库”在源码中实际对应 **至少 6 个来源**（本仓库 + qq-bridge + weflow-cli + WeChat-Hook + WeFlow/WeFlowBackup 参考 + DSH SDK）；其中 4 个不随源码分发。

## 3. 版本号一致性核对（存在实测不一致）

| 文件 | 声明版本 | 行号 |
| --- | --- | --- |
| `package.json` | `0.3.9` | 第 3 行 |
| `packages/dsh-social-bridge-plugin/package.json` | `0.3.9` | 第 3 行 |
| `README.md` | `WeChatAgent 0.3.9` | 第 1、23 行 |
| `RELEASE_NOTES.md` | `WeChatAgent 0.3.9` | 第 1 行 |
| `components.json` | **`0.3.6`**，桌面组件 `0.3.5` | 第 3、34 行 |
| `release-profile.json` | **`0.3.6`**，`tag=v0.3.6`，`date=2026-10-16`，安装器 `WeChatAgent-Setup-0.3.6-x64.exe` | `version`/`tag`/`installer.file` 字段 |

即：代码与面向用户的 README/RELEASE_NOTES 已升到 0.3.9，但 **`components.json` 与 `release-profile.json` 停留在 0.3.6**，`release-profile.json` 记录的哈希清单、安装器 SHA256、验证时间也都是 0.3.6 的。0.3.9 发布提交没有同步这两个清单文件，因此不能把 `release-profile.json` 当作 0.3.9 的发行证据。该结论直接影响 `KNOWN_LIMITATIONS.md` 与 `REUSE_DECISIONS.md` 中对“发行元数据可用性”的判断。

另：`release-profile.json` 记录的 `sourceFileCount=202`、`sourceBytes=3177875`、`nativeBinariesIncluded=false`、`privateRuntimeDataIncluded=false`、`nestedGitIncluded=false`；当前 HEAD 实际 269 个跟踪文件、约 3.68 MB。文件计数差异（+67）主要来自 0.3.7–0.3.9 新增的会话分组、表情池、DSH 插件模块，说明该 profile 未随版本更新。

## 4. 关键文件清单（全部实际存在并被读取）

### 4.1 根目录

| 文件 | 字节 | 审计用途 |
| --- | --- | --- |
| `README.md` | 16012 | 功能声明、构建命令、数据/许可声明 |
| `RELEASE_NOTES.md` | 5418 | 0.3.9 变更、验证范围与免责 |
| `LICENSE` | 12733 | **上游 qq-bridge 的 MIT 文本**（`Copyright (c) 2026 Derpyu520 and qq-bridge / QSH contributors`，第 3 行），后附第三方许可说明与 SnowLuma 讨论（第 25-149 行） |
| `LICENSES.md` | 3876 | 组件来源表、外部内容声明、天气/网页许可 |
| `components.json` | 2438 | 组件与外部组件清单（版本停留在 0.3.6） |
| `package.json` / `package-lock.json` | 3324 / 158206 | 根依赖与构建脚本 |
| `components/qq-bridge/LICENSE` | 12733 | 与根 `LICENSE` 完全同尺寸，实为同一份文本 |
| `release-profile.json` | 28093 | 0.3.6 的发行/验证清单（含文件哈希） |
| `config/wechatagent.example.json` | 2143 | 配置 schema 唯一可核对样本 |

### 4.2 `packages/dsh-social-bridge-plugin/`（DSH 侧插件）

| 文件 | 行数/字节 | 说明 |
| --- | --- | --- |
| `index.js` | 1 行 | 仅 `export { name, inject, apply } from './native-context.mjs'` |
| `native-context.mjs` | 608 行 / 49055 B | 插件入口：本机 HTTP（默认 `127.0.0.1:11230`）、会话映射、人格初始化、压缩、工具绑定 |
| `cordis.patch.yml` | 34 行 | 插件安装补丁与 `wechat-social` preset（含 `social-tool-restrict`） |
| `dsh-access.mjs` | 41 行 | 按聊天授权的技能/工具访问控制 |
| `social-tool-restrict.mjs` | 18 行 | 工具守卫 + `system-prompt/assemble` 裁剪 |
| `image-input.mjs` | 79 行 | 图片引用 → 读取器 → DSH 原生附件 |
| `member-memory.mjs` | 95 行 | 群友记忆读写与工具绑定 |
| `context-policy.mjs` | 31 行 | 上下文压缩策略与空闲判定 |
| 其他 | `prompt-context.mjs` 139 行、`sticker-pool-review.mjs` 63 行、`session-groups.mjs` 70 行、`meme-library.mjs` 137 行、`dsh-bundled.mjs` 20 行、`model-search.mjs`、`web-reader*.mjs`、`search-*.mjs`、`dsh-migration.mjs` | 与任务清单存在偏差时以本表为准 |

### 4.3 `components/qq-bridge/`（微信社交运行子集）

| 文件 | 行数 | 说明 |
| --- | --- | --- |
| `src/social-bridge.js` | 104 | Node 进程入口：装配 buffer/engine/proactive/context/adapter |
| `src/core/social-engine.js` | 427 | 消息批处理、限流、决策、投递核心 |
| `src/core/proactive-engine.js` | 140 | 主动聊天调度 |
| `src/core/proactive-policy.js` | 39 | 主动策略校验与时间窗 |
| `src/core/message-buffer.js` | 153 | 持久缓冲、待发回复、媒体队列 |
| `src/core/decision-format.js` | 116 | `RESPOND:/SILENT/[STICKER:..]` 解析与格式修复 |
| `src/core/media-outbox.js` | 87 | 表情媒体独立投递通道 |
| `src/core/session-router.mjs` | 623 | **孤立模块**：全仓库无 import（仅 `release-profile.json` 哈希表引用） |
| `src/core/web-search.js` | 151 | 仅被 `scripts/test-native-session.mjs:11` 引用，主链路不加载 |
| `src/adapters/wechat/wechat-onebot-adapter.js` | 101 | 反向 WS 适配器、合成数字 ID、回执校验 |
| `src/onebot/reverse-ws-server.js` | 136 | 手写 WebSocket 服务端、令牌校验、10 s 动作超时 |
| `src/dsh/plugin-client.js` | 67 | 调用 DSH 插件 `/followup`、`/context-maintenance` |
| `src/safe-fetch.js` | 332 | SSRF 防护抓取（被 `dsh-bundled.mjs`、`meme-library.mjs`、`extension-runtime/index.mjs` 复用） |

### 4.4 `scripts/`（本机服务与原生覆盖层）

| 文件 | 行数 | 说明 |
| --- | --- | --- |
| `text-delivery-store.mjs` | 27 | `TextDeliveryStore`：投递 ID/状态持久化（0600、临时文件 rename） |
| `hook-onebot.mjs` | 548 | Hook HTTP 客户端 + OneBot 适配器 + 回执轮询 + 令牌 |
| `project-config.mjs` | 134 | 生成 `bridge-config.json`、令牌、`cordis.patch.yml` 修订号 |
| `reader-account-state.mjs` | 130 | 账号目录归一、凭据切换、状态目录迁移 |
| `wechat_image_normalize.py` | 43 | 有界图片归一化（8 MiB / 4000 万像素 / 768 KiB） |
| `reader-api.py` | 1052 | 本机读取 API：Loopback HTTP、SSE 推送、图片解析、表情池 |
| `native-hook/*.cpp` | 244+45+93+47+99 | 注入式 `version.dll` 覆盖层（HTTP 路由、延迟初始化、表情发送） |
| `wechat_media.py` | 153 | WeChat V2 图片 AES/XOR 解码（key 不落盘） |
| `wechat_sticker.py` / `wechat_sticker_collection.py` | 262 / 250 | 表情解码/CDN 白名单 / 50 张池与去重 |
| `update-check.mjs` | 38 | GitHub Releases 更新检查（无签名校验） |

### 4.5 `docs/` 被审计文档

任务点名的 13 份文档全部存在：`EXTERNAL_DSH.md`(16 行)、`WECHAT_HOOK.md`(40)、`DSH_CHAT_ACCESS.md`(47)、`PROACTIVE_CHAT.md`(35)、`SESSION_GROUPS.md`(32)、`STICKER_COLLECTION.md`(37)、`ACCOUNT_SWITCH.md`(16)、`DATA_STORAGE.md`(26)、`TEXT_DELIVERY.md`(25)、`IMAGE_INPUT.md`(82)、`DSH_SESSIONS.md`(118)、`MEMBER_MEMORY.md`(40)、`PROMPT_POLICY.md`(11)。另有 `REPLY_PROTOCOL.md`、`SESSION_RECOVERY.md`、`MEDIA_RECOVERY.md`、`SEND_QUEUE_RECOVERY.md`、`DSH_MEME.md` 等 31 份。

## 5. 源码副本中确认缺失的私有组件

以下内容在 0.3.9 源码副本中 **不存在**，审计不得假设其可用：

1. `components/WeChat-Hook/` 整个目录（`scripts/build-hook.ps1:7` 要求存在 `x64_Version_dll.vcxproj` 才能构建，否则直接抛错）。仓库内只有本项目覆盖层 `scripts/native-hook/*.cpp|h` 与构建脚本，没有上游 Hook 源码、MinHook、`httplib.h`、`json.hpp`、`wx_send.h`、`global.h`、`offset` 定义等（这些由 `#include` 引用但不在仓库中）。
2. `components/weflow-cli/resources/key/win32/x64/wx_key.dll`（`README.md:99`、`scripts/check-runtime.py:25`、`scripts/reader_setup.py:207`、`scripts/build-installer.mjs:71`）。读取密钥仍需用户自备已授权组件。
3. 任何 `.dll/.exe/.node/.db` 文件：`git ls-files` 中为零；`state/` 目录在 clone 中不存在（本机不产出运行数据）。
4. 安装器 `WeChatAgent-Setup-0.3.9-x64.exe`、`SHA256SUMS.txt`、`VERIFICATION.json`：`README.md:11`、`RELEASE_NOTES.md:32` 说明只放 Releases，源码目录没有。
5. `node_modules/`、Python 解释器/依赖、DSH 程序、微信客户端、`ffmpeg` 二进制（`LICENSES.md:11` 声明不分发）。

因此本审计只能做 **静态源码级审计**：无法在本机完成真实登录、真实发送、真实 Hook 加载与安装器验证，相关结论均标注“未运行验证”。

## 6. 与任务提示词预设不一致的发现（来源层面）

1. **任务称“两个上游仓库”**：实际源码声明 6 个来源（见 §2），且其中 WeChat-Hook 的许可状态在 `components.json:45` 明确写作 `Overall license not confirmed`。
2. **任务点名 `components/qq-bridge/src/core/session-router.mjs` 之外的清单基本齐全**，但 `session-router.mjs` 是孤立模块（无任何 import），不应被视为社交链路组件。
3. **任务点名 `scripts/safe-fetch.js` 不存在**；实际路径为 `components/qq-bridge/src/safe-fetch.js`（332 行），另有 `packages/dsh-social-bridge-plugin/web-reader-fetch.mjs` 为同类实现。
4. **根 `LICENSE` 不是 WeChatAgent 作者自有的 MIT**，而是 qq-bridge 上游 MIT 文本（第 1-3 行），其后 149 行是 qq-bridge README/许可讨论（含 SnowLuma、Bing 搜索、`mcp-web-search-safe` 等本子集并不存在的组件）。以根 LICENSE 判断本仓库授权范围会得出错误结论。
5. **`release-profile.json` / `components.json` 版本落后**（0.3.6 vs 0.3.9），不能作为 0.3.9 的校验清单。

## 7. 可复现的核对命令

```powershell
Set-Location 'D:\dsh插插\upstream\WeChatAgent'
git rev-parse HEAD                     # 0e76902a66c7bde6a3f78335284cea7f9be6e1b1
git log -1 --format='%H | %an | %ad | %s' --date=iso
git remote -v; git tag -l; git branch -a
git ls-files | Measure-Object          # 269
git ls-tree -r -l HEAD | Select-String 'native-context.mjs|text-delivery-store.mjs|hook-onebot.mjs'
git grep -n "Overall license not confirmed" -- components.json
git grep -n "session-router" -- ':!components/qq-bridge/src/core/session-router.mjs'
```

以上命令均可复现本文件中的数字与结论。

