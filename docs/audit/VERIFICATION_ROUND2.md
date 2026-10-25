# 第二轮实机验证（WeChatAgent / DeepSeek / UIA / 管理 API）

> 时间：2026-10-20 18:16–18:26（Asia/Shanghai）
> 环境：Windows，DSH Desktop 0.2.1-rc.2，插件 v0.2.0
> 目标：继续第一轮未完成的验证，并为 Windows 客户端提供真实后端。

## 1. WeChatAgent 服务实机

WeChatAgent 已安装并运行：

| 组件 | 实测 |
| --- | --- |
| 安装目录 | `D:\wechatbot`（app + data/workspace） |
| 版本 | 0.3.9（Electron 41.1.1） |
| Reader | `127.0.0.1:5031`，`backend=weflow-cli-nt` |
| OneBot | `127.0.0.1:8766` / reverse WS `11229` |
| Hook | `127.0.0.1:30001`，`integration=WeChatAgent-1`，`version=4.1.10.27`，`startupState=ready` |
| 账号一致性 | `databaseAccounts` 与 Reader `accountDirectory` 一致 |
| 微信进程 | 固定版本 `Weixin`（pid 7132）在运行；`D:\tencent\Weixin\Weixin.exe` 为 4.1.15.13 |

插件 `WeChatAgentHttpAdapter` 对真实服务实测（只读）：

```text
checkHealth() = {"status":"ok","message":"WeChatAgent Reader 与 Hook 账号一致",
                 "details":{"version":"4.1.10.27","account":"wxid_1***m12"}}
getAccount()  = {"accountId":"<本机账号已脱敏>","ownWxid":"wxid_1***"}
```

结论：
- **真实 WeChatAgent 健康检查与账号识别：VERIFIED**
- 未发送任何微信消息；`sendText()` 实机路径 **NOT_TESTED**（避免向你的真实账号发送测试消息；Mock HTTP 已覆盖）
- 未读取聊天内容；仅调用 status/health 两个只读接口

配置已写入你的 DSH profile 补丁（备份：`cordis.patch.yml.bak-20261020181616`）：
`wechatAgent.enabled=true`、Reader/Hook 地址、token 文件路径、真实 account 与 ownerWxid。
token 本身没有写入配置或文档，只保存文件引用。

## 2. DeepSeek 真实生成（通过插件 runtime）

通过本机管理 API 发起一次真实创作（`POST /api/workflow/draft`）：

- 耗时：**12.5 s**
- 结果：`silent=false`，任务 `task_ef99fd17-7502-4bea-83bc-aa0edc7421e3`
- 流程：选题 → 文案（约 300 字）→ 本地硬规则 → 模型复核
- 模型复核：`passed=true`，notes 为“无隐私、无可核实事实断言、无编造经历、语气克制”
- 审批：`apr_98132155-f8c3-4e44-bd8e-42841455b0f1`，`pending`，2 小时过期
- 任务状态：`READY_FOR_APPROVAL`
- 未准备、未发表；`published_posts` 为空

结论：**DeepSeek V4.1 Flash 真实文案生成 + 内容审核 + 审批创建：VERIFIED（单次样本）**。
模型能力探测返回 `inputModalities=["text","image"]`，但视觉审核仍按配置使用文本复核，未做真实图片视觉验收。

## 3. 本机管理 API（客户端后端）

插件已启用 `adminServer`（默认 bundle 配置）：

- 监听：`127.0.0.1:18766`（仅本机）
- token：`data/admin-token.txt`（64 位，自动生成；不写入文档）
- 无 token：HTTP 401
- `/api/health`：数据库 ok、WeChatAgent ok、LLM ok、发布模式 PREPARE_ONLY、调度关闭
- `/api/status`：accountId 已解析、ownerChannel=manual_admin
- 新增：`POST /api/attempts/{attemptId}/verify`、`GET /api/preview/{taskId}`、任务/审批/素材/配置/persona 端点
- 契约：`docs/architecture/admin-api.md`

## 4. UIA 与真实桌面执行器复验

### 4.1 安装 UIA 依赖（workspace 内 vendor）

pip 直装受沙箱临时目录权限限制，改为从 PyPI 直接下载 wheel 并解压到 `desktop/.vendor`：

- `pywinauto 0.6.9`
- `comtypes 1.4.17`
- `pywin32 312 (cp312)`
- `six 1.17.0`

并添加 `desktop/.vendor/sitecustomize.py` 修正 pywin32 DLL 搜索路径。

结果：`uiaAvailable=true`，`pywinauto` 可导入、可创建 UIA Desktop。

### 4.2 真实微信状态与安全拒绝

- `/wechat/status`：`running=true, loggedIn=true, version=4.1.15.13, supported=false, windowTitle="Weixin", dpiScale=1.5`
  - 进程枚举看不到高权限 `Weixin.exe`；已修正为“窗口存在即视为运行”
- `POST /moments/prepare`（真实、PREPARE_ONLY）：
  - 返回 `ACCOUNT_MISMATCH`：“无法通过 UI Automation 确认当前登录的微信账号”
  - 未点击、未填文、未截图
- 直接 UIA 探查微信窗口（hwnd `0x1b0aee`，class `Qt51514QWindowIcon`）：
  - `descendants` 只有 `TitleBar` 一个元素
  - 朋友圈/发表/可见范围等控件不暴露在 UIA 树中（微信 4.x Qt 自绘）

结论：
- **UIA 库可用 + 环境探测 + 安全拒绝：VERIFIED**
- **真实 GUI 准备/发表：NOT_TESTED**，阻塞原因从“库缺失”变为“微信 4.x Qt 控件树不可由 UIA 枚举 + 登录 wxid 不可读”

### 4.3 版本探测限制

当前执行器从安装路径检测到 4.1.15.13，而实际运行的是 WeChatAgent 固定的 4.1.10.27 客户端。
由于高权限进程路径不可读，版本判定显示 `supported=false`。这是**保守且正确**的：
在控件树完成测绘前，不应把任何 4.x 客户端标为支持。

## 5. 第二轮结论

| 项目 | 状态 |
| --- | --- |
| WeChatAgent Reader/Hook 实机健康 | ✅ VERIFIED |
| WeChatAgent 账号识别/一致性 | ✅ VERIFIED |
| DeepSeek 真实文案 + 审核 + 审批 | ✅ VERIFIED（1 条样本） |
| 本机管理 API（含鉴权/401） | ✅ VERIFIED |
| pywinauto/UIA 安装与导入 | ✅ VERIFIED |
| 微信窗口存在/登录检测 | ✅ VERIFIED（受限条件下） |
| 朋友圈编辑器准备（真实） | ❌ NOT_TESTED（Qt 控件树不可枚举、wxid 不可读；已安全拒绝） |
| 真实发表 | 🚫 DISABLED / NOT_TESTED |
| 向真实微信发送审批消息 | ❌ NOT_TESTED（未发送，避免打扰真实账号） |
| 订阅生图/ComfyUI | ❌ NOT_TESTED（无真实服务） |

## 6. 后续解除真实 GUI 阻塞的路径

1. 针对微信 4.x Qt 窗口做控件测绘：优先官方无障碍接口/键盘快捷键路径，而不是纯坐标；
2. 账号确认改由 WeChatAgent 的 Reader/Hook 已文档化接口提供（本插件已能读取），
   执行器只接受与 WeChatAgent 报告一致的账号，避免 UIA 读 wxid；
3. 在隔离测试账号上完成一次“准备但取消”，再做一次真实发表 + 核验；
4. 更新 `desktop/README.md` 与 `docs/audit/PHASE1_GATE.md` 的 Re-gate 记录。
