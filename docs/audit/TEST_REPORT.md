# 测试报告（本机实测）

> 日期：2026-10-20
> 项目：`D:\dsh插插\dsh-moments-agent`
> Node：24.14.1（PATH）/ 24.21.0（DSH 自带）
> Python：3.11.2（PATH）
> DSH：0.2.1-rc.2，Electron 44.7.0

## 1. 命令

```powershell
cd D:\dsh插插\dsh-moments-agent
npm run typecheck
npm test
node --test --test-isolation=none --experimental-test-coverage "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"
python desktop\tests\run_tests.py
"D:\dsh\resources\runtime\primary-runtime\dependencies\python\python.exe" -m unittest discover -s client\tests
node scripts\verify.mjs
```

> 本沙箱中 Node 测试必须加 `--test-isolation=none`，否则测试运行器为每个文件派生带管道的子进程会 `EPERM`。

## 2. TypeScript

- `tsc -p tsconfig.json --noEmit`：**0 错误**
- 严格模式：`strict`、`noUncheckedIndexedAccess`、`noImplicitOverride`、`noFallthroughCasesInSwitch`、`noEmitOnError`
- 模块：NodeNext / ESM

## 3. JavaScript 测试

| 指标 | 结果 |
| --- | --- |
| 总数 | 106 |
| 通过 | 105 |
| 失败 | 0 |
| 跳过 | 1（Windows 无权限创建符号链接） |

覆盖文件：

- `tests/unit/state-machine.test.mjs`
- `tests/unit/config-security.test.mjs`
- `tests/unit/decision.test.mjs`
- `tests/unit/approval.test.mjs`
- `tests/unit/publisher.test.mjs`
- `tests/unit/tools.test.mjs`
- `tests/unit/adapters.test.mjs`
- `tests/unit/image-*.test.mjs`（图像子系统 5 个文件）
- `tests/integration/runtime-flow.test.mjs`
- `tests/integration/image-pipeline.test.mjs`

覆盖的关键场景：

- 状态迁移合法/非法、终态、审计；
- SQLite 迁移、持久化、重启恢复；
- 选题沉默、来源不足、隐私、注入、重复；
- 审批内容变更、过期、一次性、拒绝；
- PREPARE_ONLY 拒绝发表、账号不一致、重复内容、UNCERTAIN 禁止重试；
- 工具清单/参数校验/返回信封；
- WeChatAgent 健康/账号一致性/发送/令牌缺失；
- 桌面客户端协议与错误码；
- 图片签名/MIME/尺寸/PNG dHash/近重复/路径越界/Provider 拒绝；
- 完整创作→审批→准备→发表→核验链路。

## 4. 覆盖率（Node 内置 V8 覆盖）

`all files`：

| 指标 | 覆盖率 |
| --- | --- |
| Lines | **77.92%** |
| Branches | **66.90%** |
| Functions | **76.38%** |

重点模块：

| 模块 | Lines |
| --- | --- |
| `domain/state-machine.js` | ~100% |
| `storage/store.js` | 91.52% |
| `storage/migrations.js` | 100% |
| `security/redaction.js` | 100% |
| `security/prompt-injection.js` | 97.37% |
| `security/path-guard.js` | 92.11% |
| `scheduler/time-policy.js` | 83.33% |
| `runtime.js` | 56.34% |
| `tools/index.js` | 57.07% |

`runtime.js` 与 `tools/index.js` 未覆盖部分主要是管理页/命令分支与错误路径；后续可补。

## 5. Python 桌面执行器

```powershell
python desktop\tests\run_tests.py
```

- 结果：**121 项，119 通过，2 跳过**（符号链接用例受 Windows 权限限制；另有一项需管理员权限）
- 覆盖：token/回环绑定/路径越界/ADS/junction/超大 body/PREPARE_ONLY 拒绝发表/账号不一致/未运行/未登录/锁屏/窗口找不到/上传失败/内容不匹配/点击后不确定/取消/EXECUTOR_BUSY

真实环境实测（启动真实 server）：

```json
GET /health:
{"ok":true,"version":"0.1.0","wechatInstalled":true,"wechatVersion":"4.1.15.13",
 "uiaAvailable":false,"allowPublish":false,"mode":"PREPARE_ONLY",
 "message":"微信客户端已安装（4.1.15.13），但 Windows UI Automation 客户端库缺失..."}

GET /wechat/status:
{"ok":true,"running":false,"loggedIn":false,"accountId":null,"version":"4.1.15.13",
 "interactive":true,"locked":false,"supported":false,...}

POST /moments/publish:
{"ok":false,"submitted":false,"verified":false,"uncertain":false,
 "errorCode":"PUBLISH_MODE_DISABLED","message":"未开启发表权限..."}

GET /health（无 token）: HTTP 401
```

结论：真实服务端、鉴权、默认拒绝、环境探测 **VERIFIED**；真实 GUI 操作 **NOT_TESTED**。

## 6. 插件安装/卸载/加载（DSH 实机）

| 操作 | 返回 | 判定 |
| --- | --- | --- |
| `install_bundle`（首次） | `application: applied`，17 个 `moments_*` 工具可见 | ✅ |
| `remove_bundle` | `application: applied`，`moments_*` 工具消失 | ✅ |
| `install_bundle`（重装） | `application: applied`，`moments_*` 工具重新出现 | ✅ |
| 进程内 `apply()` | 17 工具 + 1 guard，health/status 正常，卸载清理 | ✅ |

## 7. 第二轮实机验证（2026-10-20 18:16–18:36）

详细记录：[VERIFICATION_ROUND2.md](VERIFICATION_ROUND2.md)。

| 项目 | 结果 |
| --- | --- |
| WeChatAgent Reader/Hook 真实 health | ✅ `status=ok`，4.1.10.27，账号一致 |
| WeChatAgent 账号识别 | ✅ `accountId=<本机账号已脱敏>` |
| DeepSeek 真实草稿 | ✅ 2 条，约 12s/条，模型复核 passed |
| 真实审批（管理 API） | ✅ `apv` pending → approved；任务 `APPROVED` |
| 管理 API | ✅ 18766 监听、401、status/tasks/persona/config 正常 |
| UIA 库 | ✅ pywinauto 0.6.9 / comtypes 1.4.17 / pywin32 312 可导入 |
| 微信窗口/登录检测 | ✅ running/loggedIn 检测成功（窗口 `Qt51514QWindowIcon`） |
| 真实 GUI 准备 | ❌ NOT_TESTED：UIA 只有 TitleBar、wxid 不可读 → 安全返回 `ACCOUNT_MISMATCH`，未点击/未填文 |
| 真实发表 | 🚫 DISABLED / NOT_TESTED |
| 真实微信通知发送 | ❌ NOT_TESTED（未向真实账号发消息） |
| 客户端测试 | ✅ 51 项 Tkinter `OK`（DSH Python 3.12） |
| 客户端真实联调 | ✅ `--check` + GUI 连接 18766，6 张真实截图 |
| 客户端打包件 | ✅ `release/DSH-Moments-Client-0.2.0-win64.zip`（已被 1.0.0 Web 客户端取代） |

## 8. 第三轮：账号复用、真实发布尝试、Web 客户端（2026-10-20 18:40–19:30）

详细记录：[VERIFICATION_ROUND3.md](VERIFICATION_ROUND3.md)。

| 项目 | 结果 |
| --- | --- |
| 账号复用 | ✅ `trusted_account_source=wechatagent` + `assume_client_version`；7 项新测试通过；桌面执行器共 128 项 |
| 小鲸鱼人设 | ✅ SOUL/VISUAL_STYLE 已更新；真实草稿生成 + 模型复核通过 |
| 真实朋友圈 | ⚠️ 长按相机 → 纯文字编辑器 → 右键粘贴已审批文案 → 点击发表；微信返回“文字未发送”，未产生公开内容；用户确认该环节验证通过 |
| Web 客户端服务 | ✅ `client/server.py` 11 项测试通过（代理注入 token、401/503、静态/路径越界、二进制透传、配置校验） |
| Web 前端 | ✅ 原生 SPA，9 张真实页面截图（1440×1000 + 1024×800），浏览器控制台 0 errors |
| 页面截图 | `client/web/screenshots/`（概览/创作/待审批/任务/历史/设置/窄窗口/批准 Modal） |
| 打包件 | `release/DSH-Moments-Client-1.0.0-win64.zip` |

## 9. 第四轮：网络修复、真实发布、WeChat 4 控件测绘（2026-10-23 19:30–19:50）

详细记录：[VERIFICATION_ROUND4.md](VERIFICATION_ROUND4.md)；控件测绘：[WECHAT4_CONTROL_MAP.md](WECHAT4_CONTROL_MAP.md)。

| 项目 | 结果 |
| --- | --- |
| 网络根因 | ✅ 定位 FengWo 全局代理 + Fake-IP 导致微信 MMTLS 失败 |
| 网络修复 | ✅ 切换规则模式，`qq.com/tencent.com/gtimg.com` DIRECT；重连后朋友圈正常 |
| 真实发布（规则模式） | ✅ 系统测试动态发布成功，朋友圈可见，无“文字未发送” toast |
| 已审批第一条文案 | ✅ 已出现在朋友圈（约 19:33–19:35） |
| 控件测绘 | ✅ `desktop/wechat4_geometry.py`；9 项测试通过；真实点击坐标复现 |
| 桌面执行器测试 | ✅ **138 项通过 / 2 跳过** |
| 临时提权操作器 | ✅ 仅验证使用，验证后删除，不随交付包发布 |

## 10. 第五轮：几何驱动/OCR/回滚/拟人化/首次配置教程（2026-10-23 19:50–20:30）

详细记录：[VERIFICATION_ROUND5.md](VERIFICATION_ROUND5.md)。

| 项目 | 结果 |
| --- | --- |
| 几何驱动接入执行器 | ✅ `--driver geometry` + OCR + 重试 + `/moments/delete`；默认仍 UIA/PREPARE_ONLY |
| Windows OCR | ✅ winsdk + zh-Hans-CN；证据图 OCR 成功；缺失时 `OCR_UNAVAILABLE` |
| 重试上限 | ✅ 准备 ≤3；点击后仅编辑器仍打开时 ≤1（可配 0–2）；UNCERTAIN 禁止重试 |
| 删除/回滚 | ✅ 代码 + 单测；真实删除 NOT_TESTED |
| 拟人化自动发送 | ✅ 默认关闭；策略/队列/审计 27 项测试；真实发送 NOT_TESTED |
| 首次配置教程 | ✅ 8 步 + 自检 + 首次向导 + setup-state；6 张真实截图、0 console errors |
| TypeScript | ✅ 0 错误 |
| JS 测试 | ✅ **156 项 / 155 通过 / 1 跳过** |
| Python 桌面执行器 | ✅ **231 项 / 全部通过 / 2 跳过** |
| Python 客户端 | ✅ **65 项 / 全部通过**（Tkinter 51 + Web 14） |
| 真实几何 prepare/publish/delete | ❌ **NOT_TESTED**（未做真实点击） |
| 真实拟人化发送 | ❌ **NOT_TESTED**（仅 Mock） |

## 11. 未覆盖/未验证

- 真实 DSH 对话内调用工具并写入同一个 Host SQLite；
- 微信 4.x 正式执行器的真实 prepare/publish/delete（几何驱动已接入但未做人工点击验收；仍默认 PREPARE_ONLY）；
- 拟人化自动发送真实端到端（仅 Mock/集成测试）；
- 删除 `【系统测试】` 动态的真实回滚；
- 向真实微信账号发送审批通知；
- 订阅生图/ComfyUI/官方 API 真实调用；
- 客户端“批准/准备/发表”按钮的真实鼠标点击（写 API 已真实验证，UI 确认逻辑由测试与代码路径覆盖）；
- `desktop/tests/.test-tmp`、`client/tests/.tmp`：受限 Python 沙箱创建的隐藏 ACL 目录，需 Host 完全权限清理。
