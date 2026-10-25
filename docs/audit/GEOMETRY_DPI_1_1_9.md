# 1.1.9 几何驱动修复：物理像素窗口归一化 + 屏幕捕获 + 非管理员同完整性输入

日期：2026-10-25。范围：`desktop/geometry_driver.py`、`desktop/window_locator.py`、`desktop/config.py`、`desktop/server.py`、`client/server.py`、`desktop/tests/*`。
状态：单元/集成 271 项通过（2 跳过）；本机真实微信 4.1.10.27（150% DPI）**只读准备链路已实测 PASS**；真实点击发表由自动发表 E2E 单独验收（见 `docs/audit/AUTOPUBLISH_CHAIN_AUDIT.md` 与本次 E2E 记录）。

## 1. 现象与根因

此前正式执行器的真实 prepare 连续 8 次失败：`CONTENT_CHANGED`“粘贴后 OCR 读回正文与预期不一致（未点击发表）”；1.1.8 的窗口统一日志显示 `logical=1200x900 physical=1800x1350 dpi=1.5`。逐项定位到三个叠加缺陷：

| # | 根因 | 证据 |
| --- | --- | --- |
| 1 | **窗口归一化用“逻辑像素”**：150% DPI 下把窗口设为 1800×1350 物理像素，但微信 4.x Qt 界面按**固定物理像素**布局，`KNOWN_PROFILES`（1200×900 / 1342×971）坐标也是物理像素。窗口变大后所有点位（发现/朋友圈/相机/文本区/发表）都落到错误控件上 | 把窗口设为 **1200×900 物理像素**后，profile 点位 `discover(58,361)`、`moments_entry(180,152)`、`camera(1144,85)`、`editor_text(500,220)` 全部命中：成功进入朋友圈、长按打开纯文字编辑器 |
| 2 | **朋友圈编辑器与右键菜单是独立顶层窗口**：`PrintWindow(主窗口)` 截不到它们。粘贴菜单 OCR 因此永远找不到“粘贴”，编辑器正文读回永远是朋友圈信息流 → 必然 `CONTENT_CHANGED`；绿色“发表”按钮检测同样永远失败 | 同一时刻 `PrintWindow` 截图只有朋友圈信息流，而屏幕 BitBlt 截图能看到“这一刻的想法…/提醒谁看/谁可以看/发表/取消”与右键“粘贴”菜单；屏幕 OCR 定位“粘贴”并点击后，读回正文与期望一致；屏幕截图绿色按钮检测返回 (508,674) |
| 3 | **执行器进程 DPI 感知不确定**：`python desktop/server.py` 默认是 DPI 未感知进程，`GetWindowRect`/`SetCursorPos` 会被系统按 150% 二次缩放；EXE manifest 虽是 PerMonitorV2，但独立 Python 执行器路径没有兜底 | 独立进程未调用 `SetProcessDpiAwarenessContext` 时，同一点击实际落点偏移；调用后窗口矩形/鼠标/截图统一为物理像素 |
| 4 | 非管理员场景被一律拒绝：本机微信进程为**中完整性（未提权）**，同完整性输入受 UIPI 允许；旧逻辑只要执行器不是管理员就 `PRIVILEGE_REQUIRED`，堵死了独立执行器路径 | 进程令牌探测：Weixin.exe/WeChatAgent `elevated=0`；非管理员执行器实测可正常点击/粘贴/读回 |
| 5 | 粘贴菜单 fallback 偏移 (18,16) 从未在真实 150% DPI 布局下校准；菜单实测出现在光标右下方，“粘贴”项中心相对文本区点击点约 **(+40,+34)** | 屏幕 OCR 定位结果：右键点 (500,220)+窗口原点，菜单项 bbox 中心 (540,254) |

## 2. 修复内容

### 2.1 物理像素归一化（`geometry_driver.py`）

- `normalization_plan(work_area, width=1200, height=900)`：只按**物理像素**规划窗口矩形（不再乘 DPI）；可用工作区放不下时明确失败。
- `Win32InputController.normalize_window`：`SetWindowPos` 固定 1200×900 物理像素，DPI 只记录不缩放。
- `_set_geometry`：窗口物理尺寸精确匹配已知 profile（1200×900 / 1342×971）时 1:1 使用 profile 点位；不匹配时保留“最近 profile 比例缩放”的旧 fallback 并告警。
- `_verified_layout`：改为按物理尺寸判断，不再乘 `dpi_scale`。
- `_normalize_window`：校验实际尺寸 == 期望物理尺寸（连续两次）、窗口完整位于工作区。

### 2.2 编辑器/弹窗走屏幕捕获（`geometry_driver.py`、`window_locator.py`）

- 新增 `window_locator.capture_screen_rgb(left, top, width, height)` / `WindowLocator.capture_screen_rgb(window)` / `capture_screen_png`（BitBlt from screen DC，纯标准库），保留 `PrintWindow` 用于导航页/信息流。
- 驱动新增 `_capture_screen_rgb()`、`_capture_ocr(tag, screen=True)`、`_capture_png(path, screen=True)`；编辑器阶段（右键菜单、正文读回、点击前正文复核、绿色按钮检测、点击后状态、发布后核验、证据截图、删除确认）全部改用屏幕捕获。
- 新增 `_assert_foreground()`：屏幕捕获前确认前台窗口属于微信进程（编辑器/菜单是独立顶层窗口）；失败直接 `WINDOW_BLOCKED`，绝不盲点。
- 新增 `_editor_visible()`：一次屏幕 OCR 同时确认“编辑器已打开”和“粘贴菜单位置”；编辑器未出现时在同一 attempt 内重新导航+长按一次，仍失败才计一次 prepare 重试。

### 2.3 粘贴菜单（`geometry_driver.py`）

- 右键 → 屏幕 OCR 定位“粘贴”（word/line bbox 中心换算屏幕坐标）→ 点击；
- 未找到时重试一次右键；仍找不到且窗口匹配已验证 profile 时，使用校准后的 fallback 偏移 `(40, 34)`，后续仍以正文读回校验为准，不通过不点击发表。

### 2.4 DPI 感知兜底

- `window_locator.ensure_dpi_aware()`：Per-Monitor-V2 → 系统感知 → shcore 逐级回退；`GeometryWechatDriver.__init__`、`desktop/server.py run_server`、`client/server.py run_server` 启动时调用。
- `/health` 与 `/wechat/status` 暴露 `processDpiAwareness`、`geometryRequireAdmin`、`windowNormalizeMode=physical-pixels`。

### 2.5 非管理员同完整性输入（`geometry_driver.py`、`config.py`、`server.py`）

- 新增 `geometry_require_admin: bool = False`（CLI `--geometry-require-admin`，JSON `desktopExecutor.geometryRequireAdmin`）。
- 默认自动：执行器是管理员 → 允许；非管理员 → 探测微信进程是否提权：
  - 微信未提权（`elevated=False`）→ 允许同完整性输入；
  - 微信已提权或无法确认 → `PRIVILEGE_REQUIRED`（不降级盲点）。
- 微信进程探测使用 `OpenProcess + GetTokenInformation(TokenElevation)`；读不到按“无法确认”处理。

### 2.6 其他

- `_capture_png` 相对文件名按截图目录解析（仍走路径边界校验）。
- `geometry_paste_fallback_offset` 默认值 `(18,16) → (40,34)`。
- `_get_status` 备注更新：DPI 感知模式、非管理员同完整性输入说明。
- 客户端内置执行器启动时同样完成 DPI 感知。

## 3. 测试

- 更新 `desktop/tests/test_window_normalization.py`：物理尺寸归一化/拒绝过小屏、profile 按物理尺寸匹配（150% DPI 下 1800×1350 不匹配、1200×900 匹配）、非管理员自动门禁（未提权允许 / 提权或未知拒绝 / 配置强制管理员拒绝）、前台守卫、编辑器不可见不盲点、原生 SetWindowPos 物理参数。
- `python -X utf8 desktop/tests/run_tests.py` → **271 项，通过 269，失败 0，跳过 2**（跳过项为需要真实符号链接权限的用例）。
- 真实只读准备验收（本机微信 4.1.10.27，150% DPI，非管理员，独立执行器驱动）：

```text
进程 DPI 感知：per-monitor-v2
微信窗口已统一为物理像素：1200x900（dpi=1.5）
通过屏幕 OCR 定位到“粘贴”菜单项
OCR 校验粘贴成功（attempt=1）
read_back matched=True images=0
green publish button detected at window-relative (508, 674)
RESULT: PASS   # 仅准备，未点击发表；结束后点击“取消/不保留”清理编辑器
```

证据截图：`data/desktop/screenshots/geometry-validation-prepare.png`、`geometry-validation-after-cancel.png`。

## 4. 边界与残余风险

- 几何坐标只在**已验证客户端版本**（4.1.10.27）与固定物理窗口尺寸下成立；换微信版本/主题/显示器后必须重新测绘，代码会以 `CLIENT_VERSION_UNSUPPORTED` 或“不匹配 profile”告警拒绝盲点。
- 屏幕捕获要求微信窗口在前台且未被遮挡；用户切走窗口时返回 `WINDOW_BLOCKED`（未点击发表）。
- 冷启动首次导航可能落在非朋友圈页：同一 attempt 内自动重导航一次；仍失败才消耗重试次数（最多 3 次，未点击发表）。
- 微信非提权时允许非管理员同完整性输入；若目标进程提权，仍必须管理员运行（`PRIVILEGE_REQUIRED`）。
- 真实点击发表、OCR 发布后核验仍以自动发表 E2E 的现场记录为准，不以本次只读准备验收代替。
