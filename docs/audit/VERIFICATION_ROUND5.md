# 第五轮实现验证：正式执行器几何发布、OCR、重试/回滚、拟人化自动发送、首次配置教程

> 时间：2026-10-23 19:50–20:30（Asia/Shanghai）
> 环境：DSH 0.2.1（插件 0.2.1）、微信 4.1.10.27（WeChatAgent Hook）、Windows 10/11 x64、Python 3.11.2（执行器）/ 3.12.14（OCR helper）
> 状态：代码与单元/集成测试完成；OCR 已升级为 RapidOCR 并实图验证；管理员启动器已交付但真实 UAC 提权/几何 prepare/publish/delete 未做人工点击验收，文档中仍标 NOT_TESTED。

## 1. 本轮交付

### 1.1 几何驱动接入正式执行器

- `desktop/geometry_driver.py`：`GeometryWechatDriver`，opt-in（`--driver geometry`）
  - 导航「发现→朋友圈」、长按相机 ≥900ms、右键剪贴板粘贴（OCR 定位「粘贴」+ 相对安全 fallback）
  - 绿色「发表」按钮像素检测；检测不到时拒绝点击
  - 点击后 OCR/像素判定 `closed/toast/editor_open/unknown`；仅 `editor_open` 允许有限重试
  - `verify_published` 用 OCR 匹配朋友圈正文并检测错误 toast
  - `delete_published` 用 OCR 匹配自己的动态、删除、再次确认正文消失；无法确认返回 uncertain
  - 非管理员、OCR 不可用、版本不支持等均明确失败，不降级盲点
- `desktop/server.py`：按 `--driver` 选择驱动；`/health`/`/wechat/status` 暴露 `driver/ocrAvailable/adminPrivilege/maxRetries`；新增 `POST /moments/delete`
- `desktop/config.py`：`driver/geometry_allow_publish/ocr_python/max_publish_click_retries/retry_backoff_seconds/max_prepare_attempts` 等配置与 CLI
- `desktop/window_locator.py`：`capture_window_rgb`（纯标准库）
- `desktop/wechat4_geometry.py`：`detect_publish_button_rgb`（纯标准库，保留 PIL 接口）
- `desktop/moments_editor.py` / `moments_verifier.py`：适配几何 OCR 片段比对与免 UIA 流程
- 三重发布/删除授权：`--driver geometry` + `--geometry-allow-publish` + `--allow-publish` + `mode=APPROVAL_REQUIRED`，缺一不可；默认仍是 UIA/PREPARE_ONLY。

命令示例：

```powershell
# 只准备（管理员终端；不会点击发表）
python desktop/server.py --port 18765 --token-file data/desktop-token.txt `
  --driver geometry --mode PREPARE_ONLY `
  --trusted-account-source wechatagent `
  --expected-account wxid_... `
  --assume-client-version 4.1.10.27

# 授权发布/删除（三重条件）
python desktop/server.py --port 18765 --token-file data/desktop-token.txt `
  --driver geometry --mode APPROVAL_REQUIRED `
  --allow-publish --geometry-allow-publish `
  --trusted-account-source wechatagent `
  --expected-account wxid_... `
  --assume-client-version 4.1.10.27 `
  --max-publish-click-retries 1 --retry-backoff-seconds 2
```

### 1.2 OCR 核验

- `desktop/ocr/win_helper.py`：DSH Python 3.12 子进程 OCR；**优先 RapidOCR（PP-OCR 中文模型）**，失败回退 `Windows.Media.Ocr`（winsdk / zh-Hans-CN）
- `desktop/ocr.py`：`WindowsOcrProvider`（subprocess、超时、错误归一化）、`NullProvider`、中文 CJK 空格规范化、token/toast 定位、模糊匹配
- 安装依赖：`desktop/.vendor/winsdk` + `desktop/.vendor/rapidocr_onnxruntime`（仅 DSH Python 3.12；系统 Python 3.11 不要求）
- 真实只读验证（2026-10-23）：对第四轮编辑器证据截图 OCR：
  - RapidOCR：正文 4 行全部正确（含“内容/操作/绑住/批”），score 0.98–0.999；引擎 `rapidocr_onnxruntime`
  - 旧 winsdk：存在“内容→囚容”“操作→亻乍”等误识别
- 因此新增行级相似度模糊匹配，兼容少量 OCR 误差；真实发布核验仍需人工截图复核。
- 不可用时返回 `OCR_UNAVAILABLE`，绝不伪造核验成功。

### 1.3 重试上限

- 准备阶段最多 3 次（白名单可恢复错误）
- 点击发表后最多 `max_publish_click_retries`（0–2，默认 1），且仅在“编辑器仍打开 + 按钮仍存在”时允许
- 编辑器关闭/错误 toast/unknown 一律 `UNCERTAIN`，立即停止，禁止二次点击
- `maxPublishClickRetries`/`retryBackoffSeconds` 在 health/status 暴露

### 1.4 拟人化自动发送（默认关闭）

- `src/config.ts`：`policy.humanize`（enabled=false、delaySeconds=[90,900]、activeHours=['09:00','22:00']、minIntervalSeconds=3600、jitterSeconds=600、maxPublishAttempts=2、backoffSeconds=[60,180]）
- `src/publishing/humanize-policy.ts`：纯函数策略层；审批/内容哈希/账号/执行器前置检查、活跃时段/安静时段、每日上限、最小间隔+抖动、相似内容去重、重试上限+退避、UNCERTAIN 永不重试
- `src/publishing/humanize-scheduler.ts`：队列持久化（system_settings）、重启恢复、并发锁、一次一条；到点经现有 `Publisher.prepare→publish`，不绕过状态机
- `src/runtime.ts`：独立 humanize tick + `humanizeStatus()`；`src/admin/server.ts` 只读 `GET /api/humanize`
- 默认配置不产生任何自动发送副作用；显式开启需 `publishMode=APPROVAL_REQUIRED` + humanize.enabled=true + 审批有效 + 执行器 allowPublish。
- Mock 测试 27 项；**真实端到端未验收**。

### 1.5 首次配置教程（客户端）

- 新路由 `#/setup`，左侧「首次配置」，8 步 A–H：
  - 插件与管理 API → WeChatAgent → 代理规则模式 → 账号复用 → 执行器（geometry+OCR）→ token/发布模式 → 演练（只准备）→ 真实发布+核验/回滚
  - 每步含可复制命令、预期结果、排查项、完成勾选
- 环境自检：并行读取 `/api/client/info`、`/proxy/api/health`、`/proxy/api/status`、`/proxy/api/config`，13 项通过/注意/未通过，不伪造通过
- 首次运行自动全屏向导（可稍后/Esc，下次启动仍出现），设置页可重开
- 进度通过 `/api/client/setup-state` 持久化（仅步骤布尔值 + 完成时间，无凭据）
- 错误速查覆盖 TOKEN_MISSING、ADMIN_API_UNREACHABLE、ACCOUNT_MISMATCH、CLIENT_VERSION_UNSUPPORTED、PUBLISH_MODE_DISABLED、PRIVILEGE_REQUIRED、OCR_UNAVAILABLE、EDITOR_NOT_OPENED、PUBLISH_UNCERTAIN、文字未发送等
- 截图：`client/web/screenshots/10–15`，0 console errors；真实客户端 v1.1.0 页面。

### 1.6 管理员启动器（客户端提权）

- 新增 `Start-Moments-Client-Admin.cmd` + `scripts/start-client-admin.ps1`：
  - UAC 自提权；同时启动本地客户端（18770）与 geometry 执行器（18765，默认 PREPARE_ONLY）
  - 账号：参数 > `DSH_MOMENTS_EXPECTED_ACCOUNT` > `data/desktop-account.txt`
  - 只有显式 `-AllowPublish` 才以 APPROVAL_REQUIRED + `--allow-publish + --geometry-allow-publish` 启动
  - 执行器使用 geometry + OCR，管理员权限即“底层鼠标输入”前提
- 已验证：PowerShell 语法、打包内含两个文件、release 包可解析；**真实 UAC 提权未执行**（本轮会话无法完成 UAC 交互，adminPrivilege=true 未实测）
- OCR 修复：RapidOCR 优先（真实编辑器截图识别正确），Windows OCR 回退；真实 OCR 结果见 1.2

## 2. 测试结果

| 套件 | 结果 |
| --- | --- |
| TypeScript 类型检查 | ✅ 0 错误 |
| JS 单元/集成 | ✅ **156 项 / 155 通过 / 1 跳过**（新增 humanize 27 项） |
| Python 桌面执行器 | ✅ **231 项 / 全部通过 / 2 跳过**（新增几何/OCR/RGB/模糊匹配 93 项） |
| Python 客户端 | ✅ **65 项 / 全部通过**（Tkinter 51 + Web 14） |
| 浏览器截图 | ✅ 15 张（主页面 9 + 教程 6），0 console errors |
| 真实 OCR（只读） | ✅ winsdk + zh-Hans-CN，证据图片 OCR 成功 |
| 真实几何驱动 health/status | ✅ 只读：driver=geometry、ocrAvailable=true、adminPrivilege=false、version=4.1.15.13/supported=false |
| 真实几何 prepare/publish/delete | ❌ **NOT_TESTED**（未做真实点击；需管理员 + 4.1.10.27 基线 + 人工在场） |
| 拟人化真实发送 | ❌ **NOT_TESTED**（仅 Mock/集成测试） |

## 3. 未验证与风险

1. **真实几何 prepare/publish/delete**：删除对话框位置、右键菜单 OCR、PrintWindow 在 4.1.15.13 的表现、真实 OCR 稳定性均需人工验收；当前几何基线仅 4.1.10.27。
2. **OCR 依赖**：DSH Python 3.12 + `desktop/.vendor/winsdk` + 系统中文语言包；换机/重装后需复验；缺依赖时明确失败。
3. **拟人化自动发送**：只做了 Mock；真实自动发送还依赖执行器真实可用、审批有效、代理规则模式；上线前必须小流量人工验收。
4. **删除/回滚**：只允许已测绘首条动态区域 + 词级“删除”匹配；其余返回 uncertain，避免误删。真实删除未执行。
5. **系统测试动态**：第四轮发布的 `【系统测试】` 朋友圈仍在，需所有者手动删除；自动删除未验收。
6. **几何仅支持纯文字 + PUBLIC**；图片/PRIVATE/PARTIAL 明确 `DESKTOP_UNSUPPORTED`。
7. **客户端 v1.1.0 打包件**：需要更新后重新打包并独立启动验证。

## 4. 下一步（建议真实验收顺序）

1. 以管理员启动执行器（PREPARE_ONLY + geometry），先做一次**只准备**：确认 OCR 读回、按钮检测、截图，随后人工取消编辑器；
2. 用一条带【测试】标识的正文走 `APPROVAL_REQUIRED + --allow-publish + --geometry-allow-publish`，确认发布 + OCR 核验；
3. 再用 `/moments/delete` 删除该测试动态，确认删除/回滚；
4. 最后再小流量开启 humanize，观察 1–2 天；任何 UNCERTAIN 立即人工处理，不自动重试。
