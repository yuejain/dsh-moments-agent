# 常见故障处理

## 插件已安装但工具不可见

1. 确认 DSH 版本为 0.2.1-rc.3（rc.2 亦兼容）附近，且 profile 是 `desktop`。
2. 查看插件行状态是否 `failed`；若失败，查看 DSH 日志中的 `[dsh-moments-agent]` 行。
3. 确认 `dist/index.js` 存在且比 `src` 新：`npm run build`。
4. 重载插件；必要时重启 DSH。
5. 执行 `npm run verify` 排除代码/依赖问题。

## `SQLITE_UNAVAILABLE`

- 当前运行时缺少 `node:sqlite`。需要 Node ≥ 22.5 且未禁用实验特性。
- 插件会显式进入降级并返回错误码，不会静默丢数据。
- DSH 0.2.1-rc.3 自带 Node 24.21 实测可用。

## 配置无效 / 插件拒绝加载

- 配置在 `apply()` 内严格校验，错误会写日志并拒绝加载。
- 常见原因：非回环 URL、`quietHours` 格式错误、`publishMode` 非法、`requireApproval=false` 与 `APPROVAL_REQUIRED` 冲突。
- 修正 profile `cordis.patch.yml` 后重载。

## 审批一直 pending

- `ownerChannel: manual` 时不会主动发微信；需要打开管理页批准，或在 DSH 中显式走管理接口。
- `ownerChannel: wechat` 需要 WeChatAgent 已启动、token 正确、`ownerWxid` 配置正确。
- 检查 `moments_get_status` 的 `pendingApprovals` 与 `wechatAgent` 健康。

## 审批批准时报 `CONTENT_CHANGED`

- 批准前文案/图片/可见范围/账号发生了变化。
- 重新调用 `moments_request_approval` 生成新审批，再批准。

## `moments_publish` 返回 `PUBLISH_MODE_DISABLED`

这是默认保护，不是 bug。需要同时满足：

1. `publishMode` 为 `APPROVAL_REQUIRED`（需一次性审批）或 `POLICY_AUTONOMOUS`（免逐条审批）；
2. 审批 `approved` 且内容哈希一致（第三档免逐条审批，但仍需审核通过并绑定内容哈希）；
3. 桌面执行器以 `--allow-publish` 启动（geometry 驱动还需 `--geometry-allow-publish`，两者缺一不可）；
4. `desktopExecutor.enabled: true` 且 token 正确；
5. 微信已运行、已登录、账号匹配、版本 supported、桌面可交互；geometry 还要求微信在前台。

## `PRIVILEGE_REQUIRED`（几何驱动无法安全执行输入）

geometry 驱动自 1.1.9 起**不再无条件要求管理员**，而是按微信进程提权状态自动判断。出现该错误通常说明：

- 执行器显式配置了 `--geometry-require-admin` / `desktopExecutor.geometryRequireAdmin: true`，但当前进程不是管理员；
- 或微信进程本身已提权（UIPI 会拦截同完整性输入）；
- 或无法确认微信进程提权状态（权限不足、进程已退出）。

处理：

1. 用管理员终端（或 `Start-Moments-Client-Admin.cmd`）重启执行器/客户端；或
2. 确认微信以普通权限运行（不要勾选“以管理员身份运行”），重新探测后再试；
3. 查看 `/wechat/status` 的 `adminPrivilege`、`geometryRequireAdmin` 与 notes，确认当前判定；
4. 不要用“跳过管理员检查”的方式绕过——驱动不会降级为盲点，仍会拒绝输入。

## 窗口尺寸/DPI 异常：`WINDOW_BLOCKED` 或点位偏移

geometry 驱动的坐标是**物理像素**：窗口归一化目标为 **1200×900 物理像素**（不做 DPI 乘法），已知 profile 为 1200×900 / 1342×971，按物理尺寸 1:1 匹配。

- 确认 `/health` 的 `processDpiAwareness` 不是 `unknown`/`null`：独立 Python 执行器与客户端启动时都会做 Per-Monitor-V2 感知；未生效时鼠标/窗口矩形会被系统二次缩放，应重启执行器。
- 工作区放不下 1200×900 物理像素（小屏或高缩放）时，驱动返回 `WINDOW_BLOCKED` 而不会缩小窗口硬套旧坐标；请改用分辨率足够的显示器。
- 出现点位偏移或 `CONTENT_CHANGED` 时，先检查微信窗口实际物理尺寸是否等于某个已知 profile；非 profile 尺寸会触发“最近 profile 比例缩放”告警，稳定性下降，应先把窗口恢复为 1200×900。
- 微信不在前台、被其他窗口遮挡或弹窗打断时，屏幕捕获返回 `WINDOW_BLOCKED` 并停止（不点击发表）；把微信保持在前台后重试。
- 屏幕捕获依赖真实交互桌面：锁屏、RDP 断开、服务会话下不可用（`INTERACTIVE_DESKTOP_UNAVAILABLE`）。

## 桌面执行器 `DESKTOP_UNSUPPORTED`

- 本机微信 4.1.15.13 不在已验证列表（4.1.10.27），且 pywinauto/comtypes 未安装。
- 当前只能使用 Mock/准备流程代码；真实 GUI 操作需在匹配环境安装 UIA 客户端库并重新验收。
- geometry 驱动下，图片发布与非 `PUBLIC` 可见范围也会返回 `DESKTOP_UNSUPPORTED`（只支持纯文字 + 公开）。
- 不要为了“跑通”把版本检查改成允许未知版本。

## `WECHAT_ACCOUNT_NOT_VERIFIED`

- Reader 与 Hook 的账号不一致、Hook 未返回 `databaseAccounts`、或未配置 token。
- 只有账号一致时才允许发送/发布；切换微信账号后必须重新确认并重新审批。

## `UNCERTAIN`

- 说明可能已经点击发表但无法确认。
- **不要重复点击**；打开微信朋友圈人工核对，然后在管理页选择“人工确认已发布/未发布”。

## 图片导入被拒绝

- 路径必须在 `data/imports` 或 `data/assets` 内；
- 拒绝符号链接、目录、损坏文件、MIME 与文件签名不一致、超过大小上限；
- PNG 调色板/隔行/16 位像素的 dHash 不可用，审核会保守拒绝；请先转换为标准 8 位非隔行 PNG。
- 任意用户绝对路径不会被接受，这是防越权读取。

## 管理页打不开 / 401

- 确认 `adminServer.enabled: true` 且端口未被占用；
- 只允许 `127.0.0.1` 访问；
- 令牌在 `data/admin-token.txt`（或 `DSH_MOMENTS_ADMIN_TOKEN`）；
- 不要把令牌放进 URL 或截图。

## 测试无法运行 / `spawn EPERM`

本沙箱/受限环境中 Node 测试默认会为每个测试文件派生带管道的子进程，可能 EPERM。使用：

```powershell
node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"
```

项目的 `npm test` 已使用该参数。

## 需要更多日志

- 插件日志：DSH 日志中的 `[dsh-moments-agent]`。
- 桌面执行器：`data/desktop/executor.log`。
- 审计：`audit_events` 表（不要直接修改）。
- 提交问题时请脱敏：不要附带 token、wxid、正文原文或截图原图。

