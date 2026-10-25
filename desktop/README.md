# DSH Moments Agent —— Windows 桌面执行器（desktop/）

本目录实现 `docs/architecture/desktop-executor-protocol.md` 定义的 Windows 桌面执行器：
在 `127.0.0.1` 上提供受限 HTTP 接口，默认通过 Windows UI Automation 准备朋友圈内容，
**默认绝不点击发表**。TypeScript 插件通过 `src/adapters/types.ts` 中的 `DesktopExecutor`
接口访问本服务。

本目录还提供 **opt-in 的微信 4.x 几何驱动**（`GeometryWechatDriver`）：
使用窗口几何 + 绿色按钮像素检测 + 剪贴板/右键菜单粘贴 + Windows OCR 核验，
并支持有限重试、发布后 OCR 核验与删除/回滚。默认驱动仍是 UIA + `PREPARE_ONLY`，
几何模式必须显式 `--driver geometry` 才启用。

### 1.1.9 关键变化（几何驱动）

- 窗口归一化改为 **1200×900 物理像素**（不再按 DPI 放大到 1800×1350）；已知 profile（1200×900 / 1342×971）按**物理尺寸**匹配。
- 朋友圈编辑器与右键菜单是独立顶层窗口，改为**屏幕捕获**；捕获与点击前必须确认微信在前台，否则 `WINDOW_BLOCKED`。粘贴菜单 fallback 偏移改为 **(40,34)**。
- 进程统一做 Per-Monitor-V2 DPI 感知（独立 Python 执行器与客户端内置执行器都有兜底），`/health`、`/wechat/status` 上报 `processDpiAwareness`。
- 不再无条件要求管理员：默认按微信进程提权状态自动门禁，微信未提权时允许同完整性输入；`--geometry-require-admin` / `desktopExecutor.geometryRequireAdmin` 可强制要求管理员。
- `/health` 与 `/wechat/status` 新增 `geometryRequireAdmin`、`processDpiAwareness`；`/wechat/status` 另新增 `windowNormalization`（`mode=physical-pixels`）等字段。

验收与证据：`docs/audit/GEOMETRY_DPI_1_1_9.md`（只读准备 + 修复细节）、
`docs/audit/AUTO_PUBLISH_LIVE_1_1_9.md`（第三档自动发表真机 E2E，2026-10-25）。
本目录代码随插件 `0.2.7` / 客户端 `1.1.9` 一起打包（`release/dsh-moments-agent-0.2.7.tgz`、
`release/DSH-Moments-Client-1.1.9-win64-exe.zip`）；执行器自身协议版本仍为 `0.1.0`。

## 验收状态（必读）

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| 代码与 Mock 测试 | ✅ 已通过 | `python -X utf8 desktop/tests/run_tests.py`：**271 项，269 通过 / 0 失败 / 2 跳过**（跳过项为需要真实符号链接权限的用例） |
| 默认 UIA 路径 | ✅ 未改变 | 默认驱动仍为 `RealWechatDriver` + `PREPARE_ONLY`，安全门禁未放宽 |
| 几何驱动（单元/Mock） | ✅ 已通过 | 截图、OCR、鼠标、剪贴板、管理员判定、sleep 全部注入，覆盖 prepare/publish/verify/delete/重试上限/非管理员/OCR 失败/物理像素归一化 |
| 真实 OCR（Windows.Media.Ocr） | ✅ 只读验证 | DSH Python 3.12 + winsdk 可用，语言 `zh-Hans-CN`；对第四轮证据图片 OCR 成功（含 bbox） |
| 真实微信几何准备 | ✅ 真机 PASS | 2026-10-25 本机微信 4.1.10.27（150% DPI、非管理员）独立执行器完成窗口物理像素归一化 → 导航 → 长按相机 → 右键粘贴 → OCR 读回，**未点击发表** |
| 真实微信几何发布 | ✅ 真机 E2E PASS | 2026-10-25 第三档 `POLICY_AUTONOMOUS` 自动发表跑通 1 条（humanize 排期 → prepare → 点击发表 → OCR 核验，任务 PUBLISHED / 尝试 VERIFIED / approvalId=null）；见 `docs/audit/AUTO_PUBLISH_LIVE_1_1_9.md` |
| 真实微信几何删除 | ❌ **NOT_TESTED** | 删除/回滚只有 Mock 测试；真实首条动态删除与确认对话框未验收，不得声称已验证 |
| 账号 wxid 读取 | ❌ 几何模式不读取 | 几何驱动绝不猜 wxid；必须用 `--trusted-account-source wechatagent --expected-account ...` 提供已核验账号 |
| 三级发表模式 | 第三档真机 PASS，第一/二档 Mock 回归 | 默认 PREPARE_ONLY 禁止发表；第二档需要审批 ID，第三档允许无审批 ID；独立几何执行器仍需同时启用两项 allow-publish 标志 |
| 路径/Token/回环绑定等安全限制 | ✅ 已验证 | 越界、ADS、junction、超大 body、401/404/405、日志脱敏 |

### 本机真实环境结论（2026-10-23 集成验证）

- 微信已安装：`D:\tencent\Weixin\Weixin.exe`，文件版本 **4.1.15.13**；运行状态以 `/wechat/status` 实时探测为准。
- 注册表仍残留旧版“微信 3.8.0.41”卸载记录，`D:\tencent\WeChat` 是空目录；安装检测以**可执行文件文件版本**为准。
- 执行器桌面端的可选 wheel 位于 `desktop/.vendor/`：`pywinauto 0.6.9`、`comtypes 1.4.17`、
  `pywin32 312`、`winsdk 1.0.0b10`（供 **DSH Python 3.12** 使用）。
- 系统 Python 3.11 只运行标准库实现与全部单元测试；不会 import winsdk/pywinauto/PIL。
- 只读探测结果（未点击、未发布）：
  - geometry `/wechat/status`：`running=true, loggedIn=true, accountId=null, version=4.1.15.13,
    dpiScale=1.5, supported=false`（4.1.15.13 不在几何基线 `4.1.10.27` 内），
    OCR 可用，当前进程非管理员 → 输入类操作会返回 `PRIVILEGE_REQUIRED`。
  - 1.1.9 更新（覆盖上述“非管理员一律拒绝”的结论）：`PRIVILEGE_REQUIRED` 只在微信进程提权/无法确认或显式 `--geometry-require-admin` 时返回；微信未提权时非管理员执行器可正常执行同完整性输入，见 `docs/audit/GEOMETRY_DPI_1_1_9.md`。
  - 正式发布当时仍为 **NOT_TESTED**（2026-10-23 时点；发布已于 2026-10-25 真机 E2E 通过，见上表），不得把本次只读探测当成真实发布验收。
- **不要把 Mock 测试通过理解为真实发布通过。** 真实几何发布/删除必须由 Lead/所有者决定并人工核对。

## 运行

```bat
:: 1) 默认：UIA 驱动 + 仅准备（token 文件不存在时自动生成）
python desktop/server.py --port 18765 --token-file data/desktop-token.txt --mode PREPARE_ONLY

:: 2) 默认 UIA：允许发表（仍需插件侧一次性审批）
python desktop/server.py --port 18765 --token-file data/desktop-token.txt ^
  --mode APPROVAL_REQUIRED --allow-publish ^
  --screenshot-dir data/desktop/screenshots --log-file data/desktop/executor.log

:: 3) 几何驱动：仅准备（opt-in；非管理员可直接运行——微信进程未提权时允许同完整性输入）
python desktop/server.py --port 18765 --token-file data/desktop-token.txt ^
  --driver geometry --mode PREPARE_ONLY ^
  --expected-account wxid_xxx --trusted-account-source wechatagent

:: 4) 几何驱动：允许发布/删除（三重授权，缺一不可）
python desktop/server.py --port 18765 --token-file data/desktop-token.txt ^
  --driver geometry --mode APPROVAL_REQUIRED --allow-publish --geometry-allow-publish ^
  --expected-account wxid_xxx --trusted-account-source wechatagent ^
  --max-publish-click-retries 1 --retry-backoff-seconds 2

:: 5) 强制要求管理员（微信进程已提权或安全加固时；非管理员启动会在输入前返回 PRIVILEGE_REQUIRED）
python desktop/server.py --port 18765 --token-file data/desktop-token.txt ^
  --driver geometry --mode APPROVAL_REQUIRED --allow-publish --geometry-allow-publish ^
  --geometry-require-admin ^
  --expected-account wxid_xxx --trusted-account-source wechatagent
```

几何模式下**必须**提供已核验账号（`trusted_account_source=wechatagent` + `expected_account_id`）：
几何驱动不读取 UIA wxid；使用默认 `uia` 账号来源会按设计返回 `ACCOUNT_MISMATCH`。

输入注入**不再无条件要求管理员**：默认按微信进程提权状态自动门禁——执行器是管理员 → 允许；
非管理员且微信进程未提权 → 允许同完整性输入；微信进程已提权或无法确认 → `PRIVILEGE_REQUIRED`。
`--geometry-require-admin`（或 `desktopExecutor.geometryRequireAdmin`）可强制要求管理员。
判定结果体现在 `/wechat/status` 的 `adminPrivilege` / `geometryRequireAdmin` 与 notes 中，
不会降级为盲点。

执行器启动时会做 Per-Monitor-V2 DPI 感知；几何 prepare 前会把微信窗口统一为
**1200×900 物理像素**，编辑器与右键菜单通过屏幕捕获识别，因此要求微信在前台
（用户切走窗口会返回 `WINDOW_BLOCKED`，不会盲点）。若安装目录版本与 Hook 实际运行版本不一致
（本机安装 4.1.15.13、Hook 运行 4.1.10.27），必须显式 `--assume-client-version 4.1.10.27`。

也可以使用配置文件（扁平执行器配置，CLI 参数优先）：

```bat
python desktop/server.py --config config/desktop-executor.example.json
```

```json
{
  "host": "127.0.0.1",
  "port": 18765,
  "mode": "PREPARE_ONLY",
  "allowPublish": false,
  "driver": "uia",
  "geometryAllowPublish": false,
  "geometryNormalizeWindow": true,
  "geometryRequireAdmin": false,
  "ocrPython": null,
  "maxPublishClickRetries": 1,
  "retryBackoffSeconds": 2,
  "tokenFile": "data/desktop-token.txt",
  "screenshotDir": "data/desktop/screenshots",
  "assetRoots": ["assets"],
  "logFile": "data/desktop/executor.log",
  "expectedAccountId": "wxid_owner",
  "trustedAccountSource": "wechatagent",
  "supportedVersions": ["4.1.10.27"]
}
```

> 真实 token 文件由执行器生成（`secrets.token_hex(32)`，64 位十六进制），
> 尝试用 `os.chmod` + `icacls` 限制为当前用户；失败只告警、不阻断启动。
> 插件应通过 `desktopExecutor.tokenFile` 读取同一个文件。
> 配置文件内的相对路径按**启动时工作目录**解析（与 CLI 参数一致）。

### CLI 参数

| 参数 | 说明 |
| --- | --- |
| `--host` | 只允许 `127.0.0.1` / `localhost`；其他值拒绝启动（退出码 2） |
| `--port` | 监听端口，默认 `18765`；`0` 仅测试用（系统分配临时端口） |
| `--mode` | `PREPARE_ONLY`（默认）、`APPROVAL_REQUIRED` 或 `POLICY_AUTONOMOUS` |
| `--allow-publish` | 显式允许发表点击；缺省绝不点击 |
| `--driver` | `uia`（默认）或 `geometry`（微信 4.x 几何/像素，opt-in） |
| `--geometry-allow-publish` | geometry 驱动额外授权发表/删除；仍需 `--allow-publish` 且模式为第二或第三档 |
| `--geometry-require-admin` | 强制要求执行器具备管理员权限；缺省按微信进程提权状态自动判断（微信未提权时非管理员可执行同完整性输入） |
| `--ocr-python` | OCR helper 使用的 DSH Python 3.12 路径；默认自动探测 |
| `--max-publish-click-retries` | 点击发表后的有限重试次数（0–2，默认 1） |
| `--retry-backoff-seconds` | 几何重试退避秒数（默认 2） |
| `--token-file` | token 文件；不存在时自动生成并收紧权限 |
| `--screenshot-dir` | 截图目录，默认 `data/desktop/screenshots` |
| `--asset-root` | 允许的素材根目录，可重复；默认 `assets` |
| `--log-file` | 日志文件，默认 `data/desktop/executor.log` |
| `--expected-account` | 预期微信账号；`trusted_account_source=wechatagent` 时必填 |
| `--trusted-account-source` | `uia`（默认）或 `wechatagent`；几何模式应使用后者 |
| `--assume-client-version` | 已人工确认的运行中客户端版本（必须在 supportedVersions 内） |
| `--config` | 扁平执行器 JSON 配置（兼容嵌套 MomentsConfig，但非必需） |

环境变量 `DSH_MOMENTS_DESKTOP_TOKEN` 可作为 token 来源（token 文件已存在时以文件为准）。

## 端点

所有请求必须携带 `X-Moments-Token`；认证失败返回 HTTP 401。业务失败仍返回 HTTP 200，
body 含 `ok:false` + `errorCode`；未知端点 404，方法错误 405。成功响应为 JSON，
`GET /moments/preview/{attemptId}` 返回 PNG 字节。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 执行器/微信/驱动/OCR/管理员/发表权限健康状态（含 `driver/ocrAvailable/adminPrivilege/geometryRequireAdmin/processDpiAwareness`） |
| GET | `/wechat/status` | 运行、登录、账号、版本、交互桌面、锁屏、DPI；含 `driver/ocrAvailable/maxRetries/adminPrivilege/geometryRequireAdmin/processDpiAwareness/windowNormalization` |
| POST | `/moments/prepare` | 打开编辑器、填正文、加图（几何不支持）、读回比对、设可见范围、截图；不点发表 |
| GET | `/moments/preview/{attemptId}` | 返回该 attempt 的 PNG 截图，否则 404 `PREVIEW_NOT_FOUND` |
| POST | `/moments/publish` | 仅在授权条件下：复检内容→（几何：OCR+像素检测）点击→核验 |
| POST | `/moments/delete` | **新增，仅 geometry**：删除已发布动态（attempt 绑定 + 正文匹配 + OCR 确认消失） |
| GET | `/moments/verify/{attemptId}` | 返回 publish 响应中的 `verification` 结构；无记录 404 |
| POST | `/moments/cancel` | 请求停止进行中的准备；已点击发表返回 `ALREADY_SUBMITTED` |

`POST /moments/delete` 请求：

```json
{
  "taskId": "task_...",
  "attemptId": "att_...",
  "contentHash": "64位十六进制",
  "accountId": "wxid_...",
  "expectedText": "审批快照里的完整正文"
}
```

响应：`{ "ok": true, "deleted": true, "uncertain": false, "screenshotPath": "...",
"errorCode": null, "message": "..." }`。仅当 attempt 已点击发表、contentHash/accountId/taskId
与准备快照一致、`expectedText` 与快照正文一致时才允许删除；否则返回
`BAD_REQUEST` / `CONTENT_CHANGED` / `ACCOUNT_MISMATCH` / `DESKTOP_UNSUPPORTED` /
`PUBLISH_MODE_DISABLED`。删除不匹配的多条动态、无法确认时一律返回 uncertain，不盲删。

请求字段与响应 JSON 字段严格遵循协议文档；`prepare` 的 `screenshotDir` 必须与执行器配置的
截图目录一致（只允许该目录内部，拒绝 `..`、绝对路径逃逸、符号链接/重解析点/ADS）。

### 单实例执行锁

`prepare` / `publish` / `delete` 同一时刻只允许一个执行；已有执行时返回 `EXECUTOR_BUSY`。
prepare 成功后的审批快照只保存在内存中（最多 64 条），**同一 attempt 的 publish/delete 必须在同一执行器进程内完成**；
执行器重启后需要重新 prepare。

## 微信 4.x 几何驱动（opt-in）

### 为什么需要它

微信 4.x 的 Qt 窗口不暴露可用 UIA 控件树（第二轮实测 `descendants` 只有 `TitleBar`），
因此几何模式改用「窗口内相对坐标 + 绿色按钮像素检测 + OCR 交互结果验证」。
坐标测绘与第四轮验证记录见 [`../docs/audit/WECHAT4_CONTROL_MAP.md`](../docs/audit/WECHAT4_CONTROL_MAP.md)
与 [`../docs/audit/VERIFICATION_ROUND4.md`](../docs/audit/VERIFICATION_ROUND4.md)。

### 流程与安全约束

1. **prepare**：检查交互桌面/进程/登录/账号/管理员门禁（默认按微信进程提权状态自动判断）
   → `SetForegroundWindow` 置前 → **物理像素归一化为 1200×900**（连续两次校验尺寸、并确认在工作区内）
   → 点击「发现→朋友圈」→ 长按相机 ≥900ms 进入纯文字编辑器 → 右键文本区，**屏幕 OCR** 查找「粘贴」菜单项
   （找不到时使用**相对文本区**的 (40,34) 安全 fallback 偏移，不盲点全局坐标）→ 点击粘贴 → 屏幕 OCR 读回正文；
   编辑器与右键菜单是独立顶层窗口：屏幕捕获前必须确认微信在前台，否则 `WINDOW_BLOCKED`；
   首次屏幕 OCR 未看到编辑器时自动重新导航+长按一次；最多 3 次总尝试，只重试
   `WINDOW_NOT_FOUND` / `WINDOW_BLOCKED` / `OCR_TIMEOUT` 白名单错误。
2. **publish**：屏幕捕获重新 OCR 校验正文（微信不在前台即 `WINDOW_BLOCKED`，不点击）
   → `detect_publish_button_rgb` 检测绿色「发表」按钮；
   **检测不到时禁止点击** → 点击 → 等待 → 截图 + OCR 判断状态：
   - 编辑器关闭 → 进入核验；
   - 错误 toast（“文字未发送/发送失败”等）→ 立即 `UNCERTAIN`，禁止二次点击；
   - 仍无法确认 → `UNCERTAIN`；
   - 只有「编辑器仍打开且按钮仍存在」才允许最多 `--max-publish-click-retries` 次有限重试。
3. **verify**：发布后截图 + OCR，匹配审批正文的规范化片段；出现错误 toast、匹配不到正文、
   证据截图缺失时返回 `verified=false`，由上层转成 `uncertain=true`，禁止自动重试。
4. **delete/回滚**：仅 geometry 模式；OCR 在朋友圈定位匹配正文 → 只允许已测绘的首条动态区域 →
   hover 后点击删除图标 → OCR 确认对话框里出现**词级完全匹配**的「删除」按钮才点击 →
   再次截图/OCR 确认正文消失；匹配不到、多条匹配、区域未知、确认按钮缺失或正文仍存在时返回 uncertain，杜绝误删。
5. **限制**：几何模式仅支持**纯文字 + PUBLIC**；图片和 PRIVATE/PARTIAL 明确返回
   `DESKTOP_UNSUPPORTED`，不做猜测。OCR 不可用/超时时返回 `OCR_UNAVAILABLE` / `OCR_TIMEOUT`。

### OCR 架构

- `desktop/ocr.py`：`OcrProvider` 抽象 + `WindowsOcrProvider`（subprocess 调 helper，超时/错误归一化）
  + `NullProvider`；中文 OCR 空格规范化、`contains_expected_text`、`locate_token`、错误 toast 识别。
- `desktop/ocr/win_helper.py`：必须在 **DSH Python 3.12 + `desktop/.vendor`** 下运行；
  输入图片路径，输出 UTF-8 JSON（`text/lines/words` 带 bbox）。优先 RapidOCR
  （`rapidocr_onnxruntime`，中文准确率更高），失败回退 Windows.Media.Ocr（winsdk）；
  两者都不可用时输出 `{"ok": false, "errorCode": "OCR_UNAVAILABLE", ...}`，不伪造成功。
- 默认自动探测 DSH Python；也可 `--ocr-python` 指定。
- 几何 OCR 临时截图写在配置的 `screenshot-dir` 下并在识别后删除；发布证据保留在同一目录。

### 状态字段

`GET /wechat/status` 在协议字段之外新增：

| 字段 | 含义 |
| --- | --- |
| `driver` | `uia` / `geometry` / `fake`（测试） |
| `ocrAvailable` | OCR helper 是否可用（惰性探测并缓存） |
| `maxRetries` | 几何发表点击重试上限 |
| `adminPrivilege` | 当前进程是否具备管理员权限 |
| `geometryRequireAdmin` | 是否强制要求管理员（`--geometry-require-admin`） |
| `processDpiAwareness` | 进程实际生效的 DPI 感知模式（`per-monitor-v2` 等） |
| `windowNormalization` | `enabled`、`mode="physical-pixels"`、`windowSize=[1200,900]`、`lastResult`（最近一次归一化计划/实际矩形） |

## 安全边界

- 只绑定 `127.0.0.1`；拒绝 `0.0.0.0`、局域网、公网。
- token 至少 32 字符，恒定时间比较；错误响应绝不回显 token。
- 请求体上限 8 MiB；非 JSON、字段类型/长度非法一律 `BAD_REQUEST`。
- 资产路径与截图路径必须位于配置根目录内；拒绝 `..` 逃逸、绝对路径越界、
  符号链接/目录联接（reparse point）、NTFS 备用数据流（ADS）。
- 默认 `PREPARE_ONLY`：`POST /moments/publish` 直接返回 `PUBLISH_MODE_DISABLED`。
  几何模式还要求 `--geometry-allow-publish`，三重条件缺一不可，任何调用路径都不绕过
  `config.effective_allow_publish`。
- 非管理员不再一律拒绝：默认按微信进程提权状态自动门禁（微信未提权 → 同完整性输入可执行；
  微信已提权或无法确认、或显式 `--geometry-require-admin` → `PRIVILEGE_REQUIRED`）；
  OCR 不可用 → `OCR_UNAVAILABLE`；屏幕捕获前发现微信不在前台 → `WINDOW_BLOCKED`；绝不降级为盲点。
- publish 前重新读取编辑器正文与图片数量，与 prepare 快照比对；不一致返回 `CONTENT_CHANGED`，**不点击**。
- 点击后无法确认 → `submitted=true, uncertain=true, errorCode=UNCERTAIN`，**禁止自动重试**。
- 删除只在 attempt 已发表、哈希/账号/正文匹配、OCR 唯一匹配首条动态且确认对话框词级匹配时执行。
- 不进行 DLL 注入、不逆向未公开协议、不读写微信数据库、不绕过客户端风控；
  不进行键盘注入（Ctrl+V 被微信 4.x 拦截），只使用受限鼠标事件 + 剪贴板。
- 日志脱敏：不记录 token、正文、请求体；文件/素材路径只记录必要标识。

## 测试

```bat
python desktop/tests/run_tests.py
python desktop/tests/run_tests.py -v
```

全部测试使用标准库 `unittest`，不联网、不启动真实微信、不点击桌面、不依赖 PIL/winsdk；
HTTP 测试在 `127.0.0.1` 临时端口启动真实 server，几何测试全部注入假截图/OCR/鼠标/剪贴板/管理员判定。

本机实测（2026-10-25，几何 1.1.9 修复后）：`python -X utf8 desktop/tests/run_tests.py`
→ **271 项，通过 269，失败 0，跳过 2**（跳过项为需要真实符号链接权限的用例）。
测试执行环境：系统 Python 3.11 运行全部测试通过；DSH Python 3.12 完成语法与模块导入检查
（DSH 3.12 受限沙箱不允许测试进程写临时目录，故测试用 Python 3.11 执行）。
另用 DSH Python 3.12 + winsdk 对第四轮证据图片做过**只读 OCR**验证（`zh-Hans-CN`，含 bbox）。

覆盖矩阵：

| 文件 | 覆盖内容 |
| --- | --- |
| `tests/test_server.py` | 协议端点、401/404/405、超大 body、PREPARE_ONLY 拒绝发表、批准后发布、重复 publish、内容/账号/哈希不一致、点击超时 uncertain、取消、EXECUTOR_BUSY、参数校验 |
| `tests/test_driver.py` | Fake 驱动、真实驱动 UIA 缺失降级、真实安装检测、窗口注入选择、PNG 编码、账号守卫 |
| `tests/test_editor.py` | prepare 编排与失败即停、上传失败、内容不一致、取消、截图路径安全、publish 防御与 UNCERTAIN |
| `tests/test_verifier.py` | 核验成功/不确定/异常、证据目录限制、正文/图片数不一致降级、不自动重试 |
| `tests/test_security.py` | 非回环拒绝、token 生成、配置加载、路径越界、符号链接/junction/ADS、日志脱敏 |
| `tests/test_wechat4_geometry.py` | 已知窗口 profile、坐标缩放、PIL 像素检测 |
| `tests/test_geometry_rgb.py` | 纯标准库 RGB 绿色按钮检测（含误报/尺寸校验/与 PIL 路径一致性） |
| `tests/test_ocr.py` | helper JSON 解析、中文空格规范化、文本匹配、token/toast、Provider 超时/坏 JSON/不可用 |
| `tests/test_geometry_driver.py` | 几何 status、导航/长按/粘贴 OCR+fallback、prepare 重试、图片/可见范围拒绝、发布缺按钮不点、有限重试、toast/unknown uncertain、OCR 核验、删除/回滚、非管理员门禁、OCR 不可用、server delete 端点、CLI/config、MomentsEditor 全链路 |
| `tests/test_window_normalization.py` | 物理像素窗口归一化、150% DPI 下按物理尺寸匹配 profile、非管理员自动门禁（未提权允许 / 提权或未知拒绝 / 配置强制拒绝）、前台守卫、编辑器不可见不盲点、原生 SetWindowPos 物理参数 |
| `tests/test_account_trust.py` | WeChatAgent 账号来源、assumed client version |

## 协议扩展（与协议文档的差异说明）

以下错误码/行为是桌面执行器对协议的必要补充，**不改变**协议主表语义：

| 扩展 | 用途 |
| --- | --- |
| `CANCELLED` | `POST /moments/cancel` 生效后，进行中的 `prepare` 返回 `ok:false, errorCode:"CANCELLED"`（HTTP 200） |
| `DESKTOP_UNSUPPORTED` | UIA/几何能力缺失、图片模式/非公开可见范围未实现等（来自 `src/domain/result.ts` 已有码） |
| `UIA_UNAVAILABLE` | 预留：底层 UIA 调用不可用（当前实现统一用 `DESKTOP_UNSUPPORTED`） |
| `PRIVILEGE_REQUIRED` | geometry 无法安全执行鼠标输入：显式要求管理员但当前非管理员，或微信进程已提权/无法确认提权状态（默认自动门禁，微信未提权时非管理员允许同完整性输入） |
| `OCR_UNAVAILABLE` | OCR helper/winsdk/语言不可用，无法核验界面内容 |
| `OCR_TIMEOUT` | OCR helper 超时（可重试） |
| `NOT_FOUND` / `METHOD_NOT_ALLOWED` | HTTP 404/405 响应体中的错误码（传输层） |

`uncertain` 状态永远禁止自动重试；`OCR_TIMEOUT`/`WINDOW_NOT_FOUND` 等白名单错误仅在
prepare 阶段有限重试；点击发表后只有「编辑器仍打开且按钮仍存在」才允许有限重试。

## 目录结构

```
desktop/
├─ __init__.py            包入口
├─ config.py              常量、错误码、配置、路径安全、脱敏
├─ window_locator.py      窗口/进程枚举、安装检测、交互桌面、RGB/PNG 截图（ctypes）
├─ wechat4_geometry.py    微信 4.x 坐标 profile、PIL/RGB 绿色按钮检测
├─ wechat_driver.py       WechatDriver 抽象 / RealWechatDriver（惰性 UIA）/ FakeWechatDriver
├─ geometry_driver.py     GeometryWechatDriver（opt-in 几何/像素/OCR/重试/删除）
├─ account_guard.py       交互桌面/进程/登录/账号/版本校验
├─ moments_editor.py      prepare / publish 编排
├─ moments_verifier.py    发布后核验（证据不足即 uncertain）
├─ ocr.py                 OcrProvider/WindowsOcrProvider/NullProvider + 中文规范化
├─ ocr/
│  └─ win_helper.py       DSH Python 3.12 + RapidOCR/winsdk OCR 辅助脚本（独立进程）
├─ server.py              HTTP 服务、token、路由、delete、单实例锁、CLI
├─ requirements.txt       无硬依赖；UIA/OCR 可选依赖说明
├─ README.md              本文件
└─ tests/                 unittest 测试与一键运行脚本
```

## 未完成项与风险

1. **真实发布已真机验收，真实删除仍未验收**：2026-10-25 第三档自动发表 E2E 完成 1 条
   （`docs/audit/AUTO_PUBLISH_LIVE_1_1_9.md`，任务 PUBLISHED / 尝试 VERIFIED），
   但只代表该微信版本与显示环境；**真实删除/回滚仍 NOT_TESTED**，不得把 Mock 删除测试写成真实删除已验证。
2. **控件测绘基线**：几何 profile 只对 4.1.10.27 的人工测绘负责；本机安装的是 4.1.15.13，
   `/wechat/status` 因此 `supported=false`，不会自动声称支持 4.1.15.13。
3. **入口验证仍是启发式**：几何驱动靠「长按相机 → 右键菜单 OCR/fallback」进入编辑器。
   1.1.9 起右键菜单可通过屏幕捕获看到，只有 OCR 定位不到时才用相对文本区的 (40,34) fallback；
   编辑器是否真正打开由 `_editor_visible` 再次 OCR 判定，未打开时同一 attempt 内重导航一次，
   仍失败才停止，不会发布错误内容。
4. **OCR 依赖环境**：需要 DSH Python 3.12 + `desktop/.vendor`（优先 RapidOCR，回退 winsdk）
   + 系统中文 OCR 语言包；系统 Python 3.11 不能加载这些 wheel（不影响单元测试）。
5. **wxid 不可读**：几何模式绝不猜账号，必须 `--trusted-account-source wechatagent`
   与 `--expected-account`；否则 `ACCOUNT_MISMATCH`。
6. **删除仅在已测绘首条区域生效**：为避免误删，匹配动态不在首条区域、匹配多条、确认按钮
   非词级匹配时一律 uncertain；真实删除对话框位置未验收。
7. **图片/可见范围**：几何模式仅支持纯文字 + PUBLIC；其他情况返回 `DESKTOP_UNSUPPORTED`。
8. **审批快照仅内存**：执行器重启后需重新 prepare；publish/delete 必须与 prepare 同一进程。
9. **token 文件 ACL**：受限环境下 `icacls` 可能失败（本机返回 5），按协议只告警不阻断；
   生产部署应确认 token 文件 ACL。
10. **HTTP 失败语义**：业务失败返回 HTTP 200（含超大 body 的 `BAD_REQUEST`）；如需 413 需协议同步修改。

## 可选依赖与本机 vendor

- `desktop/.vendor/`（本机验证用，不随源码发布）：pywin32/pywinauto/comtypes/winsdk，
  供 DSH Python 3.12 使用；UIA 驱动示例：

```bat
set PYTHONPATH=D:\dsh插插\dsh-moments-agent\desktop\.vendor
python desktop\server.py --port 18765 --token-file data\desktop-token.txt --mode PREPARE_ONLY
```

- OCR helper 由 `WindowsOcrProvider` 自动把 `desktop/.vendor` 加入子进程 `PYTHONPATH`，
  无需手动设置。
- 真实 UIA 4.x 控件树仍不可用（`descendants` 只有 `TitleBar`），所以默认 UIA 驱动的
  真实 prepare/publish 仍按设计拒绝（`ACCOUNT_MISMATCH` / `CLIENT_VERSION_UNSUPPORTED`）。

参考文档：[`../docs/audit/WECHAT4_CONTROL_MAP.md`](../docs/audit/WECHAT4_CONTROL_MAP.md)、
[`../docs/audit/VERIFICATION_ROUND4.md`](../docs/audit/VERIFICATION_ROUND4.md)、
[`../docs/audit/GEOMETRY_DPI_1_1_9.md`](../docs/audit/GEOMETRY_DPI_1_1_9.md)、
[`../docs/audit/AUTO_PUBLISH_LIVE_1_1_9.md`](../docs/audit/AUTO_PUBLISH_LIVE_1_1_9.md)、
[`../docs/architecture/desktop-executor-protocol.md`](../docs/architecture/desktop-executor-protocol.md)。
