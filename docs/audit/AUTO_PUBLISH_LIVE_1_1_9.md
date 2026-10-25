# 自动发表真实现场验收：拟人化调度 → 微信朋友圈真实发布成功

日期：2026-10-25 12:54–12:55（Asia/Shanghai）。环境：DSH Desktop 0.2.1-rc.3 + 插件 0.2.6（本次几何修复后的 dist；同一份代码随后打包为插件 0.2.7 / 客户端 1.1.9，代码相同、仅版本号提升）＋ 独立 geometry 桌面执行器（非管理员、PerMonitorV2、PolicyAUTONOMOUS）＋ Windows 微信 4.1.10.27（WeChatAgent Hook，本机 150% DPI）。
结论：**第三次模式（POLICY_AUTONOMOUS，免逐条审批）的自动发表链路首次真机端到端跑通**：审核通过的任务由拟人化调度器自动排期、自动准备、自动点击“发表”，并通过朋友圈 OCR 核验成功；任务 `PUBLISHED`、尝试 `VERIFIED`、`approvalId=null`。

## 1. 验收对象与配置

| 项 | 值 |
| --- | --- |
| 任务 | `task_50f23dfa-7c6e-4fce-ba95-d18cf7977e3d`（内容哈希 `b5a5a579…5c28`，公开可见，0 图片） |
| 尝试 | `att_484c9900-b933-4b6d-a784-00e82139742e`，mode=`POLICY_AUTONOMOUS`，approvalId=`null` |
| 插件 | publishMode=`POLICY_AUTONOMOUS`、scheduleEnabled=true、humanize.enabled=true |
| 执行器 | `python desktop/server.py --driver geometry --mode POLICY_AUTONOMOUS --allow-publish --geometry-allow-publish --trusted-account-source wechatagent --expected-account <本机账号已脱敏> --assume-client-version 4.1.10.27`；`GET /health` 自检 `mode/allowPublish/ocrAvailable=true`、`processDpiAwareness=per-monitor-v2`、`adminPrivilege=false`（微信进程未提权，同完整性输入） |
| 微信 | 4.1.10.27 Hook 客户端，已登录，交互桌面未锁屏 |
| 发布内容 | 角色人格自述：「被画成闭眼或者蒙眼，我到现在也没想好这算不算夸奖。…」 |

## 2. 现场时间线（管理 API + 执行器日志，均为真实时间）

| 时间（本地） | 事件 | 证据 |
| --- | --- | --- |
| 12:54:47 | 放宽 E2E 时间窗（全天活跃、0 延迟/抖动/间隔，关闭自主创作避免新建任务） | `POST /api/automation` 成功 |
| 12:54:47 | 拟人化 tick 排期：`humanize_scheduled`，`scheduledAt≈now`，任务仍 READY_TO_PUBLISH | `GET /api/humanize.lastAction`、审计 `humanize_scheduled` |
| 12:54:57 | 第二次 tick 开始执行：任务 `QUEUED → PREPARING`；执行器收到 `POST /moments/prepare` | 执行器日志「收到 prepare 请求 attemptId=att_484c…」 |
| 12:54:57 | 微信窗口统一为 1200×900 **物理像素**（dpi=1.5，PerMonitorV2） | 日志「微信窗口已统一为物理像素」 |
| 12:55:05 | 冷启动首次导航未看到编辑器 → 同一 attempt 内自动重新导航+长按一次（未点击发表） | 日志「首次屏幕 OCR 未看到编辑器（attempt=1），重新导航并长按一次」 |
| 12:55:13 | 屏幕 OCR 定位右键「粘贴」菜单项，纯文字编辑器已打开 | 日志「通过屏幕 OCR 定位到“粘贴”菜单项」 |
| 12:55:17 | 剪贴板粘贴成功，OCR 读回与正文一致 | 日志「OCR 校验粘贴成功」 |
| 12:55:21 | 准备完成（24.0s，未点击发表）；任务 `PREPARED` | 日志「准备完成，未点击发表」「POST /moments/prepare -> 200」 |
| 12:55:21 | 执行器收到 `POST /moments/publish`（approvalId 空 = 免逐条审批） | 日志「收到 publish 请求 attemptId=… approvalId=」 |
| 12:55:24 | 点击前复核通过（正文/账号/版本/桌面），OCR 复核通过 → 点击绿色「发表」 | 任务 `PUBLISHING`；日志「审批通过，点击发表」 |
| 12:55:28 | 绿色按钮点击完成（retry=0） | 日志「已点击绿色发表按钮（retry=0）」 |
| 12:55:36 | 发布后核验：编辑器关闭 + 朋友圈 OCR 匹配到正文 | 日志「已点击发表并核验成功」「POST /moments/publish -> 200 15547ms」 |
| 12:55:41 | 拟人化 tick 落账：`humanize_published`「已按拟人化节奏发表并核验成功」，`queue=[]`，`today.published=1` | `GET /api/humanize` |

## 3. 结构化结果（管理 API / DB / 截图）

- 任务：`GET /api/tasks/task_50f23dfa…` → `state=PUBLISHED`、`approvalId=null`、`errorCode=null`。
- 尝试：`state=VERIFIED`、`mode=POLICY_AUTONOMOUS`、`verification.verified=true`、`method=geometry-ocr`、`visibleText=「被画成闭眼或者蒙眼，我到现在也没想好这算不算夸奖。」`。
- DB（只读）：`publish_attempts` 该行为 `VERIFIED`；`published_posts` 新增 `post_2d1e0df9-…`，accountId=`<本机账号已脱敏>`，published_at=`2026-10-25T04:55:36Z`。
- 截图证据（已归档到 `docs/audit/evidence/auto-publish-2026-10-25/`）：
  - `prepared-editor.png`（原 `att_484c…-prepared.png`）：编辑器内已填好正文（准备完成、未发表）。
  - `published-feed.png`（原 `att_484c…-published.png`）：朋友圈信息流新增该动态（头像/昵称一致、“1分钟前”、自己动态的删除图标），OCR 核验所用。
- 发布后 12:5x 复核：朋友圈顶部可见该动态，公开可见，内容、账号与可见范围与已审核快照一致。

## 4. 本次验收覆盖到的能力

1. 第三档免逐条审批：`approvalId=null` 且执行器 `mode=POLICY_AUTONOMOUS` 下完成点击发表。
2. 拟人化调度：任务无需人工触发，由 humanize tick 自动排期、自动执行 prepare→publish。
3. 真实 GUI 准备：窗口物理像素归一化、发现→朋友圈导航、长按相机打开纯文字编辑器、右键菜单粘贴、OCR 读回校验。
4. 真实点击发表 + 发布后 OCR 核验：绿色按钮像素检测、点击、编辑器关闭判定、朋友圈正文匹配。
5. 账号/内容绑定：任务、尝试、执行器 prepare/publish 记录的 accountId 与 contentHash 全部一致；执行器点击前再次复核。
6. 非管理员同完整性输入：微信进程未提权，独立执行器在非管理员下完成输入（不再强制 UAC）。
7. 失败不盲点：冷启动首次未看到编辑器时自动重导航一次；所有异常路径均在点击前停止（见 `GEOMETRY_DPI_1_1_9.md`）。

## 5. 恢复与当前状态

- **已恢复所有者原调度配置**：`scheduleEnabled=true`、`scheduler={tickSeconds:60, ideaProbability:0.05, jitterSeconds:0}`、`policy={dailyLimit:2, minIntervalMinutes:180, quietHours:["01:00","08:00"], timeZone:"Asia/Shanghai", humanize:{enabled:true, delaySeconds:[90,900], activeHours:["09:00","12:00"], minIntervalSeconds:3600, jitterSeconds:600, maxPublishAttempts:2, backoffSeconds:[60,180]}}`（已通过 `GET /api/status` 复核）。
- 执行器在本机 127.0.0.1:18765 运行（独立进程，无管理员）；若需长期常驻，建议使用 `Start-Moments-Client-Admin.cmd`（内置执行器，托盘常驻）或用户自建计划任务运行 `python desktop/server.py ...`（命令见上）。
- 自动发表仍受所有者配置约束：每日上限 2 条、最小间隔 180 分钟、活跃时段 09:00–12:00、静默时段 01:00–08:00、Kill Switch/暂停、账号/内容/额度/去重门禁。
- 历史遗留：朋友圈中的 `【系统测试】…` 与更早的验证动态仍由所有者手动决定是否删除；`/moments/delete` 只接受已测绘首条动态的精确 OCR 匹配，本次未执行删除。

## 6. 残余风险与后续

1. **发布不可撤回**：本次为真实公开动态（已在现场确认），删除需走微信客户端或几何删除通道；后续自动发表建议保持小额度与人工抽查。
2. **OCR/几何稳定性**：依赖固定物理窗口 1200×900 与已验证客户端 4.1.10.27；换版本/主题/DPI/显示器需重新测绘，不支持时明确拒绝而不是盲点。
3. **冷启动导航**：首次进入朋友圈可能需同一 attempt 内重导航一次（已自动处理）；若微信页面被用户占用/切换窗口，执行器会 `WINDOW_BLOCKED` 并在点击前停止。
4. **UNCERTAIN**：点击后无法核验时进入 UNCERTAIN，**禁止自动重发**；只能人工核对朋友圈后通过 `/api/uncertain/<attemptId>/resolve` 收敛为 PUBLISHED/FAILED。
5. **执行器进程生命周期**：独立 Python 执行器不随 DSH 重启自动恢复；长期运行请用客户端内置执行器或系统级常驻方案（见 `docs/QUIET_AUTONOMOUS_PUBLISHING.md` 第二阶段）。
6. 微信版本探测仍显示安装目录 4.1.15.13；本机 Hook 实际运行 4.1.10.27，执行器必须显式 `--assume-client-version 4.1.10.27`（人工确认基线）。版本升级后需重新验收。

