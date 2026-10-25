# 依赖图：模块、运行时进程与外部服务

审计基线：提交 `0e76902a66c7bde6a3f78335284cea7f9be6e1b1`（`sourcepro5/WeChatAgent`，`Release WeChatAgent 0.3.9`，2026-10-20）｜审计日期 2026-10-20｜审计方法：从真实 `import`/`require`/`#include`/`pip` 依赖文件与 `package.json` 解析依赖边，端口和进程来自 `manage.ps1` 与配置样例；未运行 `npm ls`/`pip freeze`（缓存不存在），因此依赖树深度以锁文件与源码引用为界。

## 1. 运行时进程依赖图

```text
┌──────────────┐   spawn    ┌─────────────────┐
│ WeChatAgent  │──────────► │ python reader-api│ 127.0.0.1:5031
│ Console      │            │ (SIGINT/SIGTERM) │
│ (127.0.0.1)  │──spawn──►  │ node social-bridge│ 127.0.0.1:11229 反向 WS
└──────┬───────┘            │ node hook-onebot │ 127.0.0.1:8766
       │ HTTP 反向调用        └───────┬──────────┘
       ▼                            │ WebSocket(client) / HTTP(client)
   reader / plugin / adapter         ▼
                              ┌─────────────────────┐
   DSH(独立安装) ◄── followup ─┤ social-bridge       │
   127.0.0.1:11230             │ SocialEngine        │
   WeChat 4.1.10.27 ◄─ HTTP ──┤ DshPluginClient     │
   127.0.0.1:30001 (version.dll)└─────────────────────┘
```

进程启动顺序（`scripts/manage.ps1`）：`project-config.mjs`（:180）→ reader（:201-202）→ `sync-weflow.cjs`（:209）→ `hook-onebot.mjs --check`（:215）→ DSH 健康校验（:218-235）→ bridge（:236-237）→ adapter（:240-241）。缺少任何一环会抛具体错误码（如 `DSH_NOT_CONFIGURED`、`DSH_PLUGIN_NOT_READY`、`ACCOUNT_SWITCH_REQUIRES_DSH_RESTART`），不会降级为“只读模式”。

## 2. 进程间通信矩阵

| 调用方 | 被调方 | 协议/端口 | 认证 | 证据 |
| --- | --- | --- | --- | --- |
| hook-onebot | reader | HTTP/SSE `127.0.0.1:5031` | `Bearer reader_token`（`state/wechat-io-config.json`） | `hook-onebot.mjs:95-104,474-501` |
| hook-onebot | version.dll | HTTP `127.0.0.1:30001` | `Bearer native-token` + `X-WeChatAgent-Account` | `hook-onebot.mjs:105-111`；`wechatagent_hook.cpp:157-166` |
| hook-onebot | social-bridge | 反向 WebSocket `ws://127.0.0.1:11229/ws` | 默认空令牌，仅回环 | `social-bridge.js:39-40`；`reverse-ws-server.js:18,29-31` |
| social-bridge | DSH 插件 | HTTP `127.0.0.1:11230` | `Bearer SOCIAL_DSH_TOKEN` | `social-bridge.js:30`；`plugin-client.js:4-11` |
| DSH 插件 | reader | HTTP `127.0.0.1:5031` | `Bearer io.reader_token` | `image-input.mjs:25-32`；`sticker-pool-review.mjs:24-27` |
| Console | reader / 插件 / adapter | HTTP `127.0.0.1:{5031,11230,8766}` | 各自 Bearer | `console-server.mjs:135-168` |
| Console 浏览器 | Console | HTTP `127.0.0.1:<随机 20000-60000>/3210` | `X-Console-Token`（CSRF）+ Host/Origin 校验 | `console-server.mjs:352-379,598-602`；`launch-console.ps1:1-15` |

## 3. 模块依赖图（源码级，均为实测 import）

### 3.1 DSH 插件侧（`packages/dsh-social-bridge-plugin/`）

```text
index.js ──► native-context.mjs
native-context.mjs
  ├─ ../../scripts/reader-account-state.mjs      (activeReaderAccount)
  ├─ @deepseek-ai/dsh-llm                         (createUserMessage, BlockAssembler)  ← 外部 npm，0.2.0-rc.2
  ├─ ./sticker-pool-review.mjs ./image-input.mjs ./deadline.mjs ./local-policy.mjs
  ├─ ./web-reader.mjs ./model-search.mjs ./dsh-access.mjs ./conversation-policy.mjs
  ├─ ./meme-library.mjs ./session-groups.mjs
  ├─ 动态：./prompt-context.mjs ./member-memory.mjs ./search-budget.mjs
  │        ./social-tool-policy.mjs ./context-policy.mjs ./dsh-bundled.mjs
dsh-bundled.mjs
  ├─ ../../components/qq-bridge/src/safe-fetch.js
  ├─ ../../extensions/skills/meme-search/index.js
  └─ ../../scripts/reader-account-state.mjs
image-input.mjs ──► ./deadline.mjs；运行时 fetch reader-api
member-memory.mjs ──► ./member-memory-policy.mjs
meme-library.mjs ──► safe-fetch.js（动态 import）
web-reader-fetch.mjs ──► 自带 SSRF 校验（与 safe-fetch 同源设计）
```

注意：`native-context.mjs:116` 的 `async function extensions(){return null;}` 使扩展运行时在该公开插件里成为空实现；真正的“项目内置能力”走 `dsh-bundled.mjs`（`:129`）与各 `bind*` 绑定。

### 3.2 Bridge 侧（`components/qq-bridge/`）

```text
social-bridge.js
  ├─ ./adapters/wechat/wechat-onebot-adapter.js ──► ./onebot/reverse-ws-server.js
  │                                              └─► ./onebot/normalize.js ──► core/wechat-events.js
  ├─ ./core/message-buffer.js ──► core/conversation-key.js, core/wechat-events.js
  ├─ ./core/social-engine.js
  │    ├─ core/chat-policy.js ──► ../../../../packages/.../prompt-context.mjs
  │    ├─ core/decision-format.js ──► core/sticker-policy.js, prompt-context.mjs
  │    ├─ core/media-outbox.js ──► ../../../../packages/.../deadline.mjs
  │    ├─ core/member-memory.mjs（跨目录，packages 侧）
  │    ├─ ../../../../packages/.../web-reader-policy.mjs, search-policy.mjs
  └─ ./core/proactive-engine.js ──► proactive-policy.js, decision-format.js
  ├─ ./core/context-maintenance.js ──► ../../../../packages/.../context-policy.mjs
  ├─ ./dsh/plugin-client.js
  └─ ./role-card.js, core/social-persona.js, core/sticker-policy.js
```

`components/qq-bridge` **反向依赖** `packages/dsh-social-bridge-plugin`（`social-bridge.js:11,31,33,56-58` 直接 `import '../../../packages/...'`），说明“MIT 上游子集”与本项目插件包已耦合，不能把 `components/` 当作独立可替换的上游库。

### 3.3 本机服务侧（`scripts/`）

```text
hook-onebot.mjs
  ├─ core/wechat-events.js, core/sticker-policy.js, core/proactive-policy.js（跨目录引用 qq-bridge）
  ├─ ./text-delivery-store.mjs
  ├─ ./wechat-account-check.mjs ──► ./reader-account-state.mjs
  └─ node:http/crypto/ws(WebSocket 全局)
project-config.mjs
  ├─ components/qq-bridge/src/role-card.js
  ├─ migrate-io-config.mjs, sticker-policy.js, search-policy.mjs, proactive-policy.js
  ├─ context-policy.mjs, web-reader-policy.mjs, meme-library-policy.mjs, member-memory-policy.mjs
  └─ conversation-policy.mjs, dsh-migration.mjs
console-server.mjs
  ├─ update-check.mjs, extension-status.mjs, bundled-extensions.mjs, project-config.mjs
  ├─ hook-onebot.mjs（仅 conversationId）, console-process.mjs
  ├─ ../public/console/persona-files.mjs, conversation-settings.mjs
  ├─ reader-setup.mjs, dsh-configuration.mjs, process-recovery.mjs
  └─ reader-account-state.mjs, wechat-account-check.mjs
reader-api.py
  ├─ wechat_media.py, wechat_forwarded.py, wechat_quote.py
  ├─ wechat_sticker_send.py, wechat_sticker.py, wechat_sticker_labels.py
  ├─ wechat_sticker_collection.py, wechat_sticker_manager.py, wechat_meme_library.py
  ├─ wechat_group_bindings.py
  └─ components/weflow-cli/scripts/nt_decrypt.py（第四层 sys.path 注入，:61-63）
apps/console-desktop/main.cjs
  ├─ electron（devDependency，运行时由安装包提供）
  ├─ desktop-policy.cjs, deployment.cjs, appearance.cjs, shutdown.cjs, storage-location.cjs
  └─ loading-preload.cjs / preload.cjs
```

### 3.4 原生 Hook 依赖（编译期）

`scripts/native-hook/wechatagent_hook.cpp` 的 `#include`（:15-21）依赖上游 Hook 提供的 `httplib.h`、`json.hpp`、`wx_send.h`、`global.h` 与 `offset::*` 偏移表；`sticker_sender.h/.cpp`、`sticker_trace.cpp`、`deferred_init.*`、`http_server.*` 由本仓库提供。`build-hook.ps1:40-46` 把这些文件复制进 `state/hook/build-source`，并把上游 `http_routes.cpp` 覆写为 `RegisterWeChatAgentRoutes(server)`（:39）。因此原生依赖分为：**本仓库可审计覆盖层** 与 **不可审计的上游 Hook 主体**。

## 4. Node 依赖

### 4.1 根 `package.json`

- `devDependencies`（固定版本，`:44-49`）：`@electron/asar 3.4.1`、`7zip-bin 5.2.0`、`electron 41.1.1`、`electron-builder 26.8.1`、`sharp 0.34.5`、`resedit 1.7.2`。
- `engines.node = ">=22.13.0"`（`:8-10`）；本机实测 Node `v24.14.1`。
- 无 `dependencies`；运行时代码只用 Node 内置模块（`node:fs/path/http/crypto/net/child_process/worker_threads` 等），唯一运行时第三方为 `WebSocket` 全局（Node 22+ 内置）。

### 4.2 插件 `packages/dsh-social-bridge-plugin/package.json`

- `dependencies`：`@deepseek-ai/dsh-llm 0.2.0-rc.2`、`htmlparser2 10.0.0`（`:5-8`）。
- `peerDependencies`：`@deepseek-ai/dsh >=0.2.0-rc.2 <0.3.0`（可选，`:9-15`）。
- 锁文件 `package-lock.json`（9203 B）存在，但 `node_modules` 不随源码分发（`LICENSES.md:13`）。

### 4.3 `components/qq-bridge/package.json`

`version 0.1.7`、`license MIT`、`private true`，**无任何 dependencies**（上游被裁剪为纯内置模块实现）；`components/weflow-cli/package.json` 同样为纯元数据（无 `scripts`、无 `dependencies`）。这说明第三方运行时依赖集中在 DSH 插件包，qq-bridge 子集本身零 npm 依赖。

## 5. Python 依赖

`scripts/reader-requirements.txt`（6 项固定版本）：

| 包 | 版本 | 用途 |
| --- | --- | --- |
| `sqlcipher3` | 0.6.2 | 打开加密的 WeChat NT 消息库 |
| `cryptography` | 50.0.2 | 密钥/数据库相关密码学原语 |
| `zstandard` | 0.25.0 | DSH 会话日志压缩（工具链） |
| `pycryptodome` | 3.23.0 | 图片 AES-ECB 解密（`wechat_media.py:73-84`） |
| `Pillow` | 12.3.0 | 图片归一化（`wechat_image_normalize.py:3`） |
| `imageio-ffmpeg` | 0.6.0 | WXGF 动画解码（`LICENSES.md:11`，BSD-2-Clause） |

另需 `wx_key.dll`（不在源码中）与已授权微信客户端；`scripts/reader_setup.py:207` 会把该 DLL 复制到读取器运行目录。

## 6. 外部服务与网络出口（源码可证）

| 目的地 | 触发条件 | 代码证据 |
| --- | --- | --- |
| DSH 本机插件 `127.0.0.1:11230` | 每条消息回复 | `social-bridge.js:30`；`plugin-client.js:4-11` |
| 微信 CDN `wxapp.tc.qq.com` / `vweixinf.tc.qq.com` | 仅当 `wechat.media.allowStickerCdn`/`AllowStickerCdnAlias` 为 true 且本机缓存缺失 | `wechat_sticker.py:23,108-134` |
| GitHub Releases `api.github.com` | 启动/手动“检查更新”，6 小时缓存 | `update-check.mjs:3-24,37` |
| Open-Meteo / GeoNames | 天气问题（经 DSH 网页搜索后再由 weather 模块解析） | `LICENSES.md:28`；`weather-source.mjs` |
| Bing / Openverse / imgflip | 仅当 `meme-search__search` 被授权并调用 | `extensions/skills/meme-search/index.js`；`docs/STICKER_COLLECTION.md:31` |
| 模型提供方（经 DSH） | 每条需回复的消息 | `native-context.mjs:254`（`agentOptions:{provider,model}`） |
| 本地控制台 | 浏览器访问 | `console-server.mjs:598-602` |

源码内**没有**遥测/统计上报（根 `LICENSE:94` 自述、`public-source-check.mjs` 亦未发现可疑上报代码）；但注意模型侧数据外发是必然路径（`README.md:132`、`LICENSES.md:28`）。

## 7. 孤立/半死模块（影响复用判断）

| 模块 | 状态 | 证据 |
| --- | --- | --- |
| `components/qq-bridge/src/core/session-router.mjs` | **完全孤立**，无任何 import，仅出现在 `release-profile.json` 哈希表 | `git grep -n "session-router"` 只命中 release-profile |
| `components/qq-bridge/src/core/web-search.js` | 仅测试引用，主链路不加载 | `scripts/test-native-session.mjs:11` |
| `packages/extension-runtime/*` | 运行时出口被 `native-context.mjs:116` 的 `extensions()===null` 禁用，仅 `scripts/bundled-extensions.mjs` 与安装器使用 | `git grep -n "extension-runtime"` |
| `apps/console-desktop/*` | 仅 Electron 桌面壳（安装器态），源码模式下通过 `WeChatAgent.cmd`/Console 提供界面 | `package.json:12-16` |
| `roles/README.md` 与 5 个人格 MD | 生效路径为 `selectRoleText(...,'v2')`，五份文件均无〔一代〕/〔二代〕标记 | `social-bridge.js:41-44`；`project-config.mjs:86`；实测 modeTags=0 |

## 8. 依赖风险小结

1. **单点强依赖 DSH 0.2.0-rc.2**：`@deepseek-ai/dsh-llm` 精确版本 + peer `<0.3.0`，插件用 `ctx.agents/agentPresets/sessions/tokenMeter` 等未公开稳定契约（`native-context.mjs:27` 注入表），DSH 升级会直接破坏插件。
2. **单点强依赖微信 4.1.10.27 内存布局**：原生覆盖层通过 `offset::send_message` 等偏移读写（`wechatagent_hook.cpp:38-41`），微信版本变化即失效，且无回退路径。
3. **跨目录循环依赖**：qq-bridge ↔ packages 双向引用，使 MIT 子集无法独立升级/替换。
4. **不可审计二进制依赖**：`wx_key.dll`、上游 Hook、微信客户端均不提供源码，静态审计只能覆盖覆盖层。

