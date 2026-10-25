# Windows 桌面执行器协议（内部 v1）

本文件是 `dsh-moments-agent` 的 TypeScript 插件与 `desktop/server.py` 之间的**唯一接口契约**。
两侧实现必须与此处一致；修改协议必须同时更新本文件、`src/adapters/types.ts` 与两侧测试。

## 1. 安全边界

- 只监听 `127.0.0.1`，端口默认 `18765`，禁止 `0.0.0.0`、局域网与公网。
- 所有请求必须携带 `X-Moments-Token: <token>`；token 从 `--token-file` 或环境变量 `DSH_MOMENTS_DESKTOP_TOKEN` 读取，长度至少 32。
- token 缺失、错误、请求体超过 8 MiB、路径越界、非 JSON、未知端点一律拒绝；错误响应不得回显 token。
- 默认 `mode=PREPARE_ONLY`：`POST /moments/publish` 必须返回 `PUBLISH_MODE_DISABLED`，不执行任何“发表”点击。
- 只有启动参数显式包含 `--allow-publish`（可由配置启用）且 `mode` 为 `APPROVAL_REQUIRED` 或 `POLICY_AUTONOMOUS` 时，`publish` 才允许执行；即使允许，也必须再次校验 `contentHash`、`accountId` 与请求一致，第二档还要求审批 ID 存在且与请求一致。
- 禁止 DLL 注入、未公开协议、数据库篡改、绕过客户端风控；只使用 UI Automation 与受限键鼠模拟。
- geometry 驱动不使用 UIA 控件树，也不做键盘注入（Ctrl+V 被微信 4.x 拦截）：只使用固定物理像素点位、鼠标事件、剪贴板与屏幕/窗口截图 OCR；导航点击只在窗口物理尺寸精确匹配已验证 profile 时使用 profile 点位，发表等关键点击前必须像素/OCR 复核，检测不到目标即停止。
- 执行过程中窗口状态不符合预期（未登录、错账号、锁屏、非交互桌面、弹窗遮挡、微信不在前台）必须立即停止并返回明确错误码，**禁止盲目连续点击**。

## 2. 启动

```bat
python desktop/server.py --port 18765 --token-file data/desktop-token.txt --mode PREPARE_ONLY
```

geometry 驱动（微信 4.x）示例：

```bat
python desktop/server.py --port 18765 --token-file data/desktop-token.txt ^
  --driver geometry --mode APPROVAL_REQUIRED --allow-publish --geometry-allow-publish ^
  --trusted-account-source wechatagent --expected-account wxid_xxx ^
  --assume-client-version 4.1.10.27
```

可选参数：

| 参数 | 说明 |
| --- | --- |
| `--host` | 只允许 `127.0.0.1` / `localhost`，其他值拒绝启动 |
| `--mode` | `PREPARE_ONLY`（默认）、`APPROVAL_REQUIRED` 或 `POLICY_AUTONOMOUS` |
| `--allow-publish` | 显式允许执行发表点击；缺省绝不点击 |
| `--driver` | `uia`（默认）或 `geometry`（微信 4.x 几何/像素，opt-in） |
| `--geometry-allow-publish` | geometry 驱动额外授权发表/删除；仍需 `--allow-publish` 且为第二或第三档 |
| `--geometry-require-admin` | 强制要求执行器具备管理员权限；缺省按微信进程提权状态自动判断（见第 6 节） |
| `--trusted-account-source` / `--expected-account` | 账号来源与预期账号；geometry 必须用 `wechatagent` 并提供已核验 wxid |
| `--assume-client-version` | 已人工确认的运行中客户端版本（必须在 supportedVersions 内） |
| `--token-file` | token 文件；不存在时自动生成 32 字节随机 token 并写入（权限仅当前用户） |
| `--screenshot-dir` | 截图目录，默认 `data/desktop/screenshots` |
| `--log-file` | 日志文件，默认 `data/desktop/executor.log` |

## 3. 端点

所有成功响应为 JSON（`GET /moments/preview/{attemptId}` 除外，返回 PNG 字节）。
失败响应仍使用 HTTP 200，body 带 `ok:false` 与 `errorCode`，便于插件统一处理；认证失败用 401，路径/方法错误用 404/405。

### GET /health

```json
{
  "ok": true,
  "version": "0.1.0",
  "wechatInstalled": false,
  "wechatVersion": null,
  "uiaAvailable": false,
  "driver": "uia",
  "ocrAvailable": false,
  "adminPrivilege": false,
  "geometryRequireAdmin": false,
  "processDpiAwareness": "per-monitor-v2",
  "allowPublish": false,
  "mode": "PREPARE_ONLY",
  "message": "微信客户端未安装或未找到；仅支持 Mock 与准备流程测试"
}
```

- `version` 是**执行器协议版本**（`desktop/config.py` 的 `VERSION`，当前 `0.1.0`），与插件 `0.2.7` / 客户端 `1.1.9` 的版本号无关。
- `driver=geometry` 为 opt-in 的微信 4.x 几何/像素驱动；默认 `uia`。
- `ocrAvailable` 表示 Windows OCR helper（DSH Python + winsdk/RapidOCR）是否可用；不可用时几何发布核验会返回 `OCR_UNAVAILABLE`，不会伪造成功。
- `adminPrivilege` 表示执行器进程**当前**是否具备管理员权限；它不代表输入被允许——geometry 默认按微信进程提权状态自动门禁（第 6.3 节）。
- `geometryRequireAdmin` 表示是否通过 `--geometry-require-admin` / `desktopExecutor.geometryRequireAdmin` 强制要求管理员。
- `processDpiAwareness` 是进程实际生效的 DPI 感知模式（`per-monitor-v2` / `per-monitor` / `system-aware` / `unknown`，服务启动时未初始化则为 `null`）；geometry 的坐标与截图解析依赖它为物理像素语义。
- 点击重试上限 `maxRetries` 只在 `/wechat/status` 暴露，不在 `/health` 中。

### GET /wechat/status

```json
{
  "ok": true,
  "running": false,
  "loggedIn": false,
  "accountId": null,
  "version": null,
  "interactive": true,
  "locked": false,
  "supported": false,
  "windowTitle": null,
  "dpiScale": 1.0,
  "driver": "uia",
  "windowNormalization": {"enabled": false, "mode": "physical-pixels", "windowSize": [1200, 900], "lastResult": null},
  "processDpiAwareness": "per-monitor-v2",
  "geometryRequireAdmin": false,
  "adminPrivilege": false,
  "ocrAvailable": false,
  "maxRetries": 1,
  "notes": ["WeChat 未安装：找不到 WeChat.exe"]
}
```

`interactive` 表示当前会话有可交互桌面（锁屏、RDP 断开、服务会话均为 false）。
`supported` 表示客户端版本在已验证范围内且 UI 结构匹配。未验证版本返回 false，不猜测。

除基础字段外，`/wechat/status` 还暴露（均为只读、不含凭据）：

| 字段 | 含义 |
| --- | --- |
| `driver` | `uia` / `geometry` / `fake`（测试） |
| `windowNormalization` | 窗口归一化状态：`enabled`（仅 geometry 且未关闭归一化时为 true）、`mode="physical-pixels"`、`windowSize=[1200,900]`、`lastResult`（本次会话最近一次归一化计划与实际矩形，未执行时为 null） |
| `processDpiAwareness` | 进程实际生效的 DPI 感知模式 |
| `geometryRequireAdmin` | 是否强制要求管理员 |
| `adminPrivilege` | 当前进程是否具备管理员权限 |
| `ocrAvailable` | OCR helper 是否可用（惰性探测并缓存） |
| `maxRetries` | 几何点击发表的最大重试次数（0–2），仅在“编辑器仍打开且按钮仍存在”时允许 |

`dpiScale` 仅作为显示器缩放的**记录值**上报；geometry 的窗口归一化与 profile 点位**不做** DPI 乘法，见第 6 节。

### POST /moments/prepare

请求：

```json
{
  "taskId": "task_...",
  "attemptId": "att_...",
  "text": "朋友圈正文",
  "assetPaths": ["D:\\...\\assets\\ab\\cd\\<sha256>.png"],
  "visibility": "PUBLIC",
  "contentHash": "64位十六进制",
  "accountId": "wxid_...",
  "screenshotDir": "D:\\...\\data\\desktop\\screenshots"
}
```

响应：

```json
{
  "ok": true,
  "prepared": true,
  "screenshotPath": "D:\\...\\screenshots\\att_....png",
  "textMatched": true,
  "imageCount": 1,
  "warnings": [],
  "errorCode": null,
  "message": "已在朋友圈编辑窗口完成图文准备，未点击发表"
}
```

流程（每一步失败立即停止）：

1. 检查交互桌面（`interactive`）。
2. 检查微信进程。
3. UI Automation 读取登录账号；`accountId` 与请求不一致 → `ACCOUNT_MISMATCH`。
4. 检查客户端版本支持状态；不支持 → `CLIENT_VERSION_UNSUPPORTED`。
5. 检查是否已有进行中的执行（单实例锁）。
6. 通过控件身份打开“朋友圈”入口与“发表”编辑窗口（不依赖固定屏幕坐标）。
7. 填写正文（UI Automation ValuePattern / 剪贴板回退，剪贴板内容使用后清空）。
8. 依次添加图片（文件对话框或控件支持的方式）。
9. 读回正文并比对 `textMatched`；统计图片数量 `imageCount`。
10. 设置/校验可见范围。
11. 截图保存到 `screenshotDir`。
12. 返回，**不点击发表**。

> geometry 驱动（`--driver geometry`）不走第 3、6–8 步的 UIA 路径：账号由 `--trusted-account-source wechatagent` 与请求 `accountId` 交叉校验（不读控件树、不猜 wxid）；编辑流程为物理像素窗口归一化 → 置前 → 点击「发现→朋友圈」→ 长按相机打开纯文字编辑器 → 右键菜单粘贴 → 屏幕 OCR 读回。朋友圈编辑器与右键菜单是**独立顶层窗口**，只能屏幕捕获且要求微信在前台（第 6.2 节）。

失败响应示例：

```json
{
  "ok": false,
  "prepared": false,
  "screenshotPath": null,
  "textMatched": false,
  "imageCount": 0,
  "warnings": ["未找到朋友圈入口控件"],
  "errorCode": "WINDOW_NOT_FOUND",
  "message": "未找到朋友圈入口，已停止操作"
}
```

### GET /moments/preview/{attemptId}

- 若存在该 attempt 的截图：返回 `image/png` 字节（`Content-Type: image/png`）。
- 否则 404 JSON：`{ "ok": false, "errorCode": "PREVIEW_NOT_FOUND", "message": "..." }`。

### POST /moments/publish

请求：

```json
{
  "taskId": "task_...",
  "attemptId": "att_...",
  "contentHash": "64位十六进制",
  "accountId": "wxid_...",
  "approvalId": "apr_..."
}
```

响应：

```json
{
  "ok": true,
  "submitted": true,
  "verified": true,
  "uncertain": false,
  "screenshotPath": "D:\\...\\published.png",
  "verification": {
    "verified": true,
    "method": "uia-list-readback",
    "publishedAt": "2026-...Z",
    "visibleText": "朋友圈正文",
    "imageCount": 1,
    "evidencePath": "D:\\...\\published.png",
    "notes": []
  },
  "errorCode": null,
  "message": "已点击发表并核验到新内容"
}
```

关键语义：

- 只有 `--allow-publish` 且 `mode` 为 `APPROVAL_REQUIRED` 或 `POLICY_AUTONOMOUS` 时才允许点击；否则 `errorCode=PUBLISH_MODE_DISABLED`，`submitted=false`。geometry 驱动还额外要求 `--geometry-allow-publish`（三重条件缺一不可）。
- 点击前必须重新读取编辑窗口正文与图片数量，与 prepare 记录比对；不一致 → `CONTENT_CHANGED`，不点击。
- 点击后等待 UI 响应并核验；若已点击但无法确认结果 → `submitted=true, uncertain=true, errorCode=UNCERTAIN`，**禁止自动重试**。
- 进程崩溃/超时发生在点击之后同样返回 `uncertain=true`。
- geometry 驱动在 click 前的屏幕捕获/质检发现微信不在前台、窗口被移动或尺寸变化时返回 `WINDOW_BLOCKED`，不点击。

### GET /moments/verify/{attemptId}

返回与 publish 响应中的 `verification` 相同结构；无记录时 404。

### POST /moments/delete（仅 geometry）

用于发布后的删除/回滚。必须满足：

- 执行器以 `--driver geometry` 启动，且 `--geometry-allow-publish` + `--allow-publish` + `mode` 为第二或第三档全部满足；
- `attemptId` 在当前进程内已准备且已点击发表（`_submitted`）；
- `taskId/contentHash/accountId` 与准备快照一致，`expectedText` 规范化后包含/等于快照正文；
- OCR 在朋友圈定位到匹配的自己动态，且只操作已测绘的首条动态区域；删除后再次 OCR 确认正文消失。

请求：

```json
{
  "taskId": "task_...",
  "attemptId": "att_...",
  "contentHash": "64位十六进制",
  "accountId": "wxid_...",
  "expectedText": "已发布正文"
}
```

响应：`ok:true, deleted:true, verification:{...}`；无法确认时 `deleted:false, uncertain:true`，禁止自动重试。该端点不删除任何不匹配的动态；失败不会尝试“猜坐标”。

### POST /moments/cancel

请求：`{ "attemptId": "att_..." }`

响应：`{ "ok": true, "cancelled": true, "message": "已请求停止；未点击发表" }`。
若已点击发表，则 `cancelled=false, errorCode=ALREADY_SUBMITTED`，不得声称已撤销。

## 4. 错误码

| errorCode | 含义 | 是否可重试 |
| --- | --- | --- |
| `UNAUTHORIZED` | token 缺失/错误 | 否 |
| `BAD_REQUEST` | JSON/字段非法 | 否 |
| `INTERACTIVE_DESKTOP_UNAVAILABLE` | 锁屏 / RDP 断开 / 无交互桌面 | 可，人工解锁后 |
| `WECHAT_NOT_RUNNING` | 微信进程不存在 | 可，人工启动后 |
| `WECHAT_NOT_LOGGED_IN` | 未登录 | 可，人工登录后 |
| `ACCOUNT_MISMATCH` | 登录账号与请求/审批不一致 | 否，需重新审批 |
| `CLIENT_VERSION_UNSUPPORTED` | 客户端版本未验证 | 否 |
| `WINDOW_NOT_FOUND` | 窗口/控件未找到 | 可，人工检查后 |
| `WINDOW_BLOCKED` | 窗口被遮挡/弹窗；geometry 下还包括微信不在前台、屏幕捕获尺寸为 0、归一化后尺寸不符或超出工作区、准备后窗口位置/尺寸变化 | 可，人工处理后 |
| `UPLOAD_FAILED` | 图片添加失败 | 可（准备阶段） |
| `CONTENT_CHANGED` | 编辑窗口内容与审批快照不一致 | 否，需重新审批 |
| `PREVIEW_NOT_FOUND` | 截图不存在 | 否 |
| `PUBLISH_MODE_DISABLED` | 未开启发表权限 | 否 |
| `APPROVAL_REQUIRED` | 缺少审批 ID | 否 |
| `PRIVILEGE_REQUIRED` | geometry 无法安全执行鼠标输入：显式要求管理员但当前非管理员，或微信进程已提权/无法确认提权状态（第 6.3 节） | 否，提权后重启或确认微信未提权 |
| `OCR_UNAVAILABLE` | Windows OCR helper/语言/依赖不可用 | 否，修复 OCR 后 |
| `OCR_TIMEOUT` | OCR helper 超时 | 可（白名单，人工确认后） |
| `ALREADY_SUBMITTED` | 已点击发表，无法取消 | 否 |
| `UNCERTAIN` | 已点击但无法确认结果 | **禁止自动重试**，人工核对 |
| `EXECUTOR_BUSY` | 已有执行中的任务 | 可，稍后 |
| `INTERNAL_ERROR` | 未预期异常 | 视情况 |

## 5. 测试要求

- 所有 GUI 调用必须通过可注入的驱动接口（`WechatDriver`），测试使用 `FakeWechatDriver`，普通 CI 不启动真实微信。
- 至少覆盖：未登录、锁屏、窗口未找到、上传失败、内容不匹配、网络/客户端超时、已点击后不确定、PREPARE_ONLY 拒绝发表、账号不匹配、路径越界、token 错误、非回环绑定拒绝。
- Python 测试使用标准库 `unittest`，不依赖 pytest，不访问网络。
- 真实 Windows 微信验收状态必须在 README 中明确标注；不得把 Mock 通过写成真实发布通过。

## 6. geometry 驱动附加语义（1.1.9）

本节是 geometry 驱动（`--driver geometry`）在协议之上的**实现语义**；默认 UIA 驱动路径不受影响。事实依据：`desktop/geometry_driver.py`、`desktop/window_locator.py`、`desktop/config.py`、`desktop/server.py`，验收记录见 `docs/audit/GEOMETRY_DPI_1_1_9.md`。

### 6.1 物理像素窗口归一化

- 归一化目标是 **1200×900 物理像素**，**不做 DPI 乘法**：150% DPI 下仍然是 1200×900 物理像素（不再换算成 1800×1350）。`normalization_plan(work_area, 1200, 900)` 只按物理像素规划居中矩形；工作区放不下时明确返回 `WINDOW_BLOCKED`，不缩小窗口硬套旧坐标。
- 归一化后连续两次校验“实际物理尺寸 == 期望物理尺寸”，并确认窗口完整位于显示器工作区；否则 `WINDOW_BLOCKED`，不导航、不点击。
- 已知 profile 为 **1200×900** 与 **1342×971**，profile 点位本身即物理像素；窗口物理尺寸精确匹配某个 profile 时 1:1 使用其点位，不匹配时回退到“最近 profile 比例缩放”并告警。
- `windowNormalizeMode` 固定为 `physical-pixels`：`/wechat/status` 的 `windowNormalization.mode`、只读诊断 `inspect_controls` 的 `windowNormalizeMode` 与启动日志中的配置摘要都报告该值。`geometry_normalize_window=false` 只关闭归一化，不改变“profile 按物理尺寸匹配”的语义。
- 进程必须完成 DPI 感知（Per-Monitor-V2 优先，回退 per-monitor/system-aware）：`desktop/server.py` 启动、`client/server.py` 启动与 `GeometryWechatDriver` 构造时都会调用 `ensure_dpi_aware()`；未生效时 status 会告警，坐标仍按物理像素解释。生效模式通过 `processDpiAwareness` 上报。

### 6.2 屏幕捕获与前台守卫

- 朋友圈纯文字编辑器与右键「粘贴」菜单是**独立顶层窗口**：`PrintWindow(主窗口)` 截不到它们。因此编辑器阶段（右键菜单定位、正文读回、点击前正文复核、绿色按钮检测、点击后状态、发布后核验、证据截图、删除确认）全部改用**屏幕 BitBlt** 捕获主窗口矩形。
- 屏幕捕获前必须先确认前台窗口属于微信进程（编辑器/菜单是独立窗口，可能不属于主窗口句柄）：不满足时直接 `WINDOW_BLOCKED`，不截图、不点击；用户切走窗口时不会盲点。
- 只读诊断 `inspect_controls` 只截主窗口（`PrintWindow`）并明确说明“编辑器/右键菜单需前景屏幕捕获，不在只读诊断范围”。
- 粘贴 fallback 偏移为 **(40,34)**（相对文本区点击点，默认 `geometry_paste_fallback_offset`）：仅在窗口匹配已验证 profile 且屏幕 OCR 定位「粘贴」失败时使用；点击后仍以正文读回校验为准，读回不一致返回 `CONTENT_CHANGED` 且不点击发表。
- 环境前提：微信主窗口存在、已登录、交互桌面未锁屏、无弹窗遮挡。屏幕捕获依赖真实桌面，RDP 断开/服务会话下不可用。

### 6.3 非管理员同完整性输入（`PRIVILEGE_REQUIRED` 语义）

- **默认不无条件要求管理员**（`geometry_require_admin=false`）：执行器是管理员 → 允许输入；非管理员 → 探测微信进程是否提权（`OpenProcess` + `GetTokenInformation(TokenElevation)`）：
  - 微信进程未提权（`elevated=false`）→ 允许同完整性输入；
  - 微信进程已提权 → UIPI 会拦截，返回 `PRIVILEGE_REQUIRED`，不降级盲点；
  - 无法确认（无权限/进程已退出/探测失败）→ 同样返回 `PRIVILEGE_REQUIRED`。
- 配置 `geometry_require_admin=true`（CLI `--geometry-require-admin`，JSON `desktopExecutor.geometryRequireAdmin`）时**强制**要求执行器自身是管理员，否则返回 `PRIVILEGE_REQUIRED`。
- 只读诊断（`inspect_controls`、截图）不要求管理员；真正执行鼠标输入前才做管理员门禁。
- 状态备注会如实说明当前判定：已具备管理员 / 配置要求管理员 / 微信未提权走同完整性输入 / 无法确认将拒绝。

### 6.4 其它错误与行为

- `_editor_visible`：一次屏幕 OCR 同时确认编辑器是否打开；冷启动首次未看到编辑器时在同一 attempt 内重新导航+长按一次，仍失败才消耗一次 prepare 重试（最多 3 次，未点击发表）。
- `OCR_TIMEOUT` / `WINDOW_NOT_FOUND` / `WINDOW_BLOCKED` 属于 prepare 阶段可重试白名单；点击发表后只有“编辑器仍打开且绿色按钮仍存在”才允许最多 `--max-publish-click-retries` 次有限重试。
- `POST /moments/delete` 只会针对 OCR 唯一匹配的已测绘首条动态执行；真实删除/回滚未在 1.1.9 验收，Mock 测试通过不等同于真实删除已验证。
