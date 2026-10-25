# 免审批自动发布链路（POLICY_AUTONOMOUS）审计与线上 E2E 前置条件

- 日期：2026-10-25（Asia/Shanghai），审计时点约 12:42–13:05
- 被测版本：插件 `dsh-moments-agent@0.2.6`（`dist` 由 `npm run build` 生成）、客户端 `client/server.py` VERSION=1.1.8、桌面执行器 `desktop/server.py`；同一份代码随后打包为插件 0.2.7 / 客户端 1.1.9（代码相同、仅版本号提升）
- 责任边界：本审计不驱动微信 GUI、不启动真实桌面执行器/客户端、不发表任何真实内容。真实 GUI 发表由 Lead 执行。
- 行号说明：`src/**` 行号稳定；`desktop/**` 与 `client/**` 正被 Lead 并发编辑，行号采集于上述时点，若漂移请按函数名定位。

## 0. 结论摘要

1. **链路在 Mock/集成层已完整证明**：`POLICY_AUTONOMOUS` 审核通过 → `READY_TO_PUBLISH`（无审批记录）→ `HumanizeScheduler` tick 排期 → tick 执行 `Publisher.prepare` → `Publisher.publish` → 桌面执行器 `POST /moments/prepare` + `POST /moments/publish` → 任务 `PUBLISHED`、尝试 `VERIFIED`、`approvalId=null`。新增 `tests/integration/autonomous-publish.test.mjs` 11 项全部通过；相关 5 个套件合计 **54/54 通过**。
2. **未发现 `src/publishing/**` 或 `client/server.py` 中需要修补的确定性缺陷**。本轮不改生产代码，只新增测试与本文档。
3. **模式同步逻辑自洽**：内置执行器可发表 ⟺ 插件模式为非 `PREPARE_ONLY` 的第二/第三档；客户端把插件返回的 `mode` 原样写入执行器 `mode/allow_publish/geometry_allow_publish`，**执行器 `mode` 必须与插件 `publishMode` 完全相等**（`desktop/server.py:505-506` 的请求模式交叉校验）。任何同步失败（无令牌、网络错误、HTTP 错误、插件返回异常）都保持 `PREPARE_ONLY`。
4. **线上 E2E 的真正风险不在 Policy/状态机，而在几何执行器的 prepare 阶段**：`data/desktop/executor.log` 显示 2026-10-24 至 2026-10-25 共 **8 次**真实 prepare 尝试均以 `CONTENT_CHANGED`（“粘贴后 OCR 读回正文与预期不一致，未点击发表”）失败（10-24 七次、10-25 一次），最近一次为 2026-10-25T04:27:37Z（任务 `task_3473694a-…`，随后任务 FAILED）。**当前处于 `READY_TO_PUBLISH` 的 `task_50f23dfa-…` 是那次失败后新建的内容**；自动链路能否发布，取决于 Lead 的 geometry/OCR 修复 + 管理员权限 + 交互桌面。
5. 线上模式/调度配置已具备第三档条件（`publishMode=POLICY_AUTONOMOUS`、`requireApproval=false`、`humanize.enabled=true`、`scheduleEnabled=true`），但**当前时间不在活跃时段**（live 快照 12:44 本地，`activeHours 09:00–12:00`），且**桌面执行器离线**。E2E 必须临时放宽时段/延迟并先启动模式匹配的执行器；第 5 节给出可直接执行的命令与恢复步骤。

## 1. 链路图（第三档：无逐条审批）

```
[内容生产]
  runtime.createIdea -> composeDraft -> reviewDraft
        │  review.passed && publishMode==='POLICY_AUTONOMOUS'
        ▼
  REVIEWING ──► READY_TO_PUBLISH          （src/runtime.ts:822-832；无审批记录）
        │
        │  每 ≤10s 一次 HumanizeScheduler.tick()（与 scheduleEnabled 无关；src/runtime.ts:1692-1699）
        ▼
  tick#1 scheduleNext: humanize-policy.planHumanizeTick
        │   门禁：humanize.enabled / 模式 / kill / pause / 状态 / 执行器 / 微信 / 账号 /
        │         去重 / dailyLimit / quietHours / activeHours / minInterval
        │   → system_settings.humanize_state 持久化 entry(scheduledAt=now+delay)
        ▼
  tick#2 executeEntry: evaluateHumanizeCandidate（到点复检）
        │
        ├─► Publisher.prepare(taskId, 'humanize')
        │      READY_TO_PUBLISH ─► QUEUED ─► PREPARING
        │      attempt: PLANNED ─► PREPARING
        │      HTTP POST /moments/prepare（text/assets/visibility/contentHash/accountId）
        │      PREPARING ─► PREPARED；attempt ─► PREPARED
        │
        └─► Publisher.publish(taskId, approvalId=null, 'humanize')
               PUBLISHED? 不是；状态必须 PREPARED
               attempt.mode === config.publishMode（准备后换模式会被拒绝）
               snapshot.contentHash === task.contentHash
               policy.evaluatePublish + assertTimeLimits（日上限/最小间隔/安静时段）
               事务：attempt ─► PUBLISHING，任务 ─► PUBLISHING（审批仅在第二档核销）
               HTTP POST /moments/publish（approvalId:'', publishMode:'POLICY_AUTONOMOUS'）
                    │
                    ├─ submitted && verified → published_posts 落库，attempt ─► VERIFIED，任务 ─► PUBLISHED
                    ├─ submitted && !verified → 任务/attempt ─► UNCERTAIN（永不自动重试，通知人工核对）
                    └─ !submitted → attempt/任务 ─► FAILED（未点击；转人工）
```

关键性质（测试已覆盖）：

- 第三档**不创建**任何 `approvals` 记录，`attempt.approvalId === null`，publish 请求 `approvalId === ''`。
- 状态序列严格为 `READY_TO_PUBLISH → QUEUED → PREPARING → PREPARED → PUBLISHING → PUBLISHED`；`prepare` 在 `PREPARING` 时调用、`publish` 在 `PUBLISHING` 时调用（测试在 Mock 执行器回调内读取真实 DB 状态断言）。
- 准备/发表两次调用都携带审核时绑定的 `contentHash` 与账号；执行器侧还要对比自身 prepare 快照（`desktop/moments_editor.py:317`、`:324`）。
- 已发布内容重复请求幂等返回，不再点击（`publisher.ts:373-390`、`:459-480`）。
- `UNCERTAIN` 后：调度器清空可执行队列并 `humanize_failed` 审计（`metadata.uncertain=true`），下一 tick 不重发；直接调用 Publisher 也被拒绝（`publisher.ts:392-395`）。

## 2. 门禁矩阵（按链路顺序）

| # | 门禁 | 代码位置 | 行为（第三档） | 测试证据 |
|---|------|----------|----------------|----------|
| 1 | 审核通过后目标状态 | `src/runtime.ts:822-832`、`:804` | 第三档 → `READY_TO_PUBLISH`；第二档 → `READY_FOR_APPROVAL` | 新测试 (a) |
| 2 | `policy.requireApproval` 与模式一致性 | `src/config.ts:543-546` | `POLICY_AUTONOMOUS` 强制 `requireApproval=false`；与 `APPROVAL_REQUIRED` 冲突时报配置错误 | 配置测试 |
| 3 | 模式持久化/恢复 | `src/runtime.ts:154-158`、`:363-385` | 重启恢复 `publish_mode`；存在 PREPARING/PREPARED/PUBLISHING 任务时拒绝切换 | `publish-modes` 模式持久化用例 |
| 4 | Kill Switch | `publish-policy.ts:52-54`；`humanize-policy.ts:305-307`；`humanize-scheduler.ts:450-452` | 立即拒绝，不排期/不点击 | 新测试 (d) |
| 5 | 暂停 | `publish-policy.ts:55-57`；`humanize-policy.ts:308-310`；`humanize-scheduler.ts:453-455` | 同上 | 新测试 (d) |
| 6 | 拟人化总开关 | `humanize-scheduler.ts:445-449`；`humanize-policy.ts:299-301` | 关闭时 tick 立即返回 `HUMANIZE_DISABLED`，不读队列 | `humanize-flow` |
| 7 | 发布模式（准备阶段） | `publish-policy.ts:99-116` | 第三/二档允许 READY_TO_PUBLISH 准备（第一档只允许 APPROVED/READY_FOR_APPROVAL） | 新测试 (d) |
| 8 | 发布模式（点击前） | `publish-policy.ts:119-127` | `PREPARE_ONLY` 立即 `PUBLISH_MODE_DISABLED` | 新测试 (d)、`publish-modes` |
| 9 | 审核快照哈希（文案+素材+可见范围+账号） | `publisher.ts:224-228`、`publish-policy.ts:67-73` | 任务哈希 ≠ 当前快照 → `CONTENT_CHANGED`，不点击 | `publish-modes` 篡改用例、新测试（篡改→humanize_failed） |
| 10 | 幂等键 / 已发布同哈希 | `publisher.ts:230-248`；`publish-policy.ts:64-66` | 同内容哈希已发布 → `DUPLICATE_PUBLISH`；UNCERTAIN/PUBLISHING 旧尝试 → 拒绝 | `publisher`、`publish-modes` |
| 11 | 审批（仅第二档） | `publisher.ts:218-226`、`:401`；`publish-policy.ts:74-95` | 第三档完全跳过审批创建/核销 | 新测试 (a)(b)、`publisher` |
| 12 | 账号绑定 | `publisher.ts:146-154`；`publish-policy.ts:58-63`、`:152-157` | 任务无 accountId / 桌面报告账号不一致 → `ACCOUNT_MISMATCH` | `publisher` 账号用例、新测试（执行器账号不符） |
| 13 | 准备后模式变化 | `publisher.ts:407-409` | `attempt.mode !== config.publishMode` → `CONFLICT`，不点击 | `publish-modes` |
| 14 | 准备后内容变化 | `publisher.ts:410-412` | `attempt.contentHash !== snapshot.contentHash` → `CONTENT_CHANGED` | `publish-modes` |
| 15 | 执行器健康/允许发表 | `publish-policy.ts:130-142`；`humanize-policy.ts:393-401` | 离线/未 `--allow-publish` → 不排期或 `PUBLISH_MODE_DISABLED` | 新测试（allowPublish=false）、`humanize-policy` |
| 16 | 微信运行/登录/版本/交互/锁屏 | `publish-policy.ts:143-163`；`humanize-policy.ts:402-411` | `DESKTOP_PRECONDITION`/`DESKTOP_UNSUPPORTED`/`WECHAT_NOT_READY`/`ACCOUNT_MISMATCH` | `publisher` 锁屏用例、`humanize-policy` |
| 17 | 几何驱动额外授权 | `desktop/config.py:334-341`；`desktop/server.py:508-521`；`desktop/moments_editor.py:276-297` | 需 `--allow-publish` + 第二/三档；geometry 另需 `--geometry-allow-publish` | 桌面测试（Lead 负责） |
| 18 | 执行器“插件模式 = 执行器模式” | `desktop/server.py:505-506` | 请求 `publishMode` 与执行器 `config.mode` 不等 → `PUBLISH_MODE_DISABLED`（未点击，但任务会被记为 FAILED） | 桌面测试 `test_publish_modes.py` |
| 19 | 执行器要求审批 ID（仅第二档） | `desktop/server.py:522-524`；`desktop/moments_editor.py:310-316` | 第三档允许空 approvalId；第二档必须有 | 桌面测试 |
| 20 | 执行器 prepare 快照比对 | `desktop/server.py:526-551`；`desktop/moments_editor.py:317-330` | `contentHash`/`accountId`/`taskId` 与 prepare 记录不一致 → 未点击拒绝 | 桌面测试 |
| 21 | 每日上限 | `humanize-policy.ts:369-375`；`publisher.ts:117-130` | 到点复检 + Publisher 二次校验，`POLICY_DENIED`，不点击；`nextEligibleAt`=次日活跃开始 | 新测试 (e) |
| 22 | 最小间隔（含 jitter 与 `minIntervalMinutes` 取大） | `humanize-policy.ts:177-185`、`:385-391`；`publisher.ts:123-126` | 未到期拒绝；到期后正常发表 | 新测试 (e) |
| 23 | 安静时段 | `humanize-policy.ts:377-379`；`publisher.ts:127-129` | 永不点击；给出安静时段结束时刻 | `humanize-policy` |
| 24 | 活跃时段（左闭右开） | `humanize-policy.ts:212-219`、`:381-383` | 时段外不排期，`nextEligibleAt`=下一次开始时刻 | `humanize-policy`、live 快照 |
| 25 | 随机延迟 + 整点顺延 | `humanize-scheduler.ts:505-511`、`:560-577` | 延迟落在配置区间；整点前 10s 内顺延 ≤60s | `humanize-flow`、新测试（delay 0） |
| 26 | 相似内容/同哈希去重 | `humanize-policy.ts:356-367` | `DUPLICATE_CONTENT`/`SIMILAR_CONTENT` 不排期 | `humanize-flow` |
| 27 | 重试上限 + 指数退避 | `humanize-policy.ts:346-354`、`:188-193`；`humanize-scheduler.ts:755-879` | 可重试错误按退避重排；达到上限转人工；时间类 `POLICY_DENIED` 不消耗次数 | `humanize-flow`、`humanize-policy` |
| 28 | UNCERTAIN 永不自动重试 | `humanize-policy.ts:319-325`；`humanize-scheduler.ts:612-616`、`:808-813`；`publisher.ts:392-395` | 清空排期、审计 `humanize_failed`、通知人工核对；下一 tick 不重发 | 新测试 (c) |
| 29 | 执行器点击幂等（ALREADY_SUBMITTED） | `desktop/server.py:531-541` | 同一 attempt 二次 publish → `ALREADY_SUBMITTED`，映射 `UNCERTAIN_REQUIRES_MANUAL_CHECK` | 桌面测试 |
| 30 | 状态机只允许合法迁移 | `src/domain/state-machine.ts:20-27` | `QUEUED→PREPARING→PREPARED→PUBLISHING→PUBLISHED`；非法顺序抛 `STATE_TRANSITION_DENIED` | 新测试记录迁移序列 |

## 3. 客户端 ↔ 插件 ↔ 桌面执行器 模式同步审计

### 3.1 接口契约

| 环节 | 位置 | 行为 |
|------|------|------|
| 插件只读 | `src/admin/server.ts:205-206` `GET /api/publish-mode` | 返回 `{ok:true,data:{mode,requireApproval}}`，`requireApproval === (mode==='APPROVAL_REQUIRED')`（`src/runtime.ts:359-361`） |
| 插件写入 | `src/admin/server.ts:217-219` `POST /api/publish-mode` | `runtime.updatePublishMode()`：校验三级枚举/`expectedMode`、拒绝执行器忙或存在 PREPARING/PREPARED/PUBLISHING 任务、持久化并审计 |
| 鉴权 | `src/admin/server.ts:61-75` | 仅回环 + `X-Moments-Token`（或 Bearer）常量时间比较 |
| 客户端读/写 | `client/server.py:61-72` `plugin_mode_request()` | GET/POST 同一 URL；令牌来自 tokenFile；校验 `ok` 且 `data.mode ∈ PUBLISH_MODES`，否则 `ValueError` |
| 客户端映射 | `client/server.py:53-58` `apply_executor_mode()` | `config.mode=mode`；`allow_publish = mode!='PREPARE_ONLY'`；`geometry_allow_publish = mode!='PREPARE_ONLY'` |
| 客户端切换 | `client/server.py:75-92` `change_publish_mode()` | 先抢执行器 `_exec_lock` → **先降为 PREPARE_ONLY** → POST 插件 → 成功后才应用插件返回的 `mode`；任何异常都停在 PREPARE_ONLY |
| 客户端启动同步 | `client/server.py:781-794` | 执行器创建后 GET 插件模式并应用；异常 → `apply_executor_mode('PREPARE_ONLY')` + 告警日志 |
| 客户端改连接 | `client/server.py:473-512` | 连接地址/令牌变化时先降 PREPARE_ONLY，返回 `modeSyncRequired:true`，由界面提示重新应用模式 |
| 执行器生效 | `desktop/config.py:334-341` | `effective_allow_publish = allow_publish && mode∈{APPROVAL_REQUIRED,POLICY_AUTONOMOUS}`；geometry 再叠 `geometry_allow_publish` |
| 执行器点击前交叉校验 | `desktop/server.py:505-506` | 请求 `publishMode` 与执行器 `config.mode` **不完全相等** → 拒绝（未点击） |
| 执行器审批 ID | `desktop/server.py:522-524` | 仅 `mode==='APPROVAL_REQUIRED'` 要求非空 approvalId |
| 前端 | `client/web/app.js:695`、`:4291-4319` | 三级单选项；点击“应用并同步模式”→ `POST /api/client/publish-mode {mode, expectedMode}` |

### 3.2 结论逐条核对

- **“插件 POLICY_AUTONOMOUS + requireApproval=false ⟹ 内置执行器可发表”**：✅ 客户端把插件 mode 原样写入执行器；`apply_executor_mode` 对两个非 PREPARE_ONLY 档都置 `allow_publish=true`、`geometry_allow_publish=true`，执行器 `effective_allow_publish/effective_geometry_publish` 随之为 true；publish 请求 `publishMode='POLICY_AUTONOMOUS'` 与执行器 mode 相等，`approvalId=''` 被第三档接受。
- **“插件 APPROVAL_REQUIRED + requireApproval=true ⟹ 执行器可发表但必须有审批 ID”**：✅ 同一同步路径；执行器 mode=APPROVAL_REQUIRED，publish 时强制非空 approvalId（`publisher.ts:401` 传入真实 approvalId）。
- **“任一同步失败保持 PREPARE_ONLY”**：✅ 覆盖无令牌、网络错误、HTTP 错误、返回体非法、启动同步失败、改连接六类路径（`test_publish_modes.py` 验证网络失败与忙时不变；其余由代码审阅确认）。
- **`requireApproval` 字段本身**：客户端不读取，仅使用 `mode`。因插件由 `mode` 派生该字段，当前不存在不一致；但它是冗余契约，若未来变更需同步（见 6.2 建议）。
- **执行器“可发表”的严格条件是 mode 完全相等，而非仅“非 PREPARE_ONLY”**。因此任何“只改插件模式、不改执行器模式”的操作都会在点击前被拒。

### 3.3 未构成“需修补缺陷”的差异（记录 + 建议）

| # | 差异/边界 | 影响 | 处置 |
|---|-----------|------|------|
| D1 | 内置执行器模式只在启动/切换/改连接时同步一次，无周期性漂移检测 | 若直接 `POST /api/publish-mode`（不经过客户端）改插件模式，执行器保持旧模式：点击前被拒（安全），但任务 `PUBLISHING→FAILED`（终态），需新建内容 | 文档约束 + 6.2 建议 |
| D2 | 切换模式的 HTTP 4xx（如存在 PREPARED 任务被插件拒绝）与网络失败同处理：执行器停在 PREPARE_ONLY，而插件模式未变 | 链路暂停（安全方向），需重新应用模式 | 文档约束 |
| D3 | 启动同步/改连接后不自动重试，需用户重新应用模式 | 插件尚未就绪时启动客户端 → 整场会话 PREPARE_ONLY | 文档约束 + 6.2 建议 |
| D4 | 独立启动 `desktop/server.py` 时没有“同步通道”，必须 `--mode` 与插件模式完全一致 | 不一致 → 未点击拒绝 + 任务 FAILED | 第 5 节命令显式传入 `--mode POLICY_AUTONOMOUS` |
| D5 | 客户端测试未显式断言“启动同步成功后的执行器 mode/allowPublish” | 覆盖缺口（代码路径简单且已被生命周期测试间接执行） | 6.2 建议补测试 |

## 4. 测试证据（本轮新增/执行）

新增文件：`tests/integration/autonomous-publish.test.mjs`（11 项，Mock LLM / MockOwnerChannel / MockDesktop / 临时 SQLite，无 GUI、无网络桌面执行器）。

```powershell
cd D:\dsh插插\dsh-moments-agent
npm run build            # tsc 通过（exit 0）
node --test --test-isolation=none `
  tests/integration/autonomous-publish.test.mjs `
  tests/unit/publisher.test.mjs `
  tests/unit/humanize-policy.test.mjs `
  tests/integration/publish-modes.test.mjs `
  tests/integration/humanize-flow.test.mjs
```

结果：`tests 54 / pass 54 / fail 0 / skipped 0`（新文件 11、publisher 6、humanize-policy 19、publish-modes 10、humanize-flow 8）。

新测试覆盖矩阵：

| 用例 | 断言要点 |
|------|----------|
| (a) 审核即 READY_TO_PUBLISH | `approvalId=null`；`approvals=0`；contentHash/assetManifestHash/accountId 绑定；审计 `draft_reviewed.nextState` |
| (b) 调度全链路 | 排期不改状态；`prepare`→`publish` 顺序；迁移序列 `READY_TO_PUBLISH→QUEUED→PREPARING→PREPARED→PUBLISHING→PUBLISHED`；调用时真实状态分别是 PREPARING/PUBLISHING；`approvalId=''`、`publishMode='POLICY_AUTONOMOUS'`；attempt `VERIFIED`、`approvalId=null`、`verification.verified=true`；`published_posts` 一行；重复 publish/humanizeTick 不再点击 |
| (c) UNCERTAIN | `action=uncertain`；任务/尝试 UNCERTAIN；无 published 行；无待执行排期；`humanize_failed.metadata.uncertain=true`；通知含“人工核对”；+24h 后仍不重发；直接 publish 被拒 |
| (d) PREPARE_ONLY / 暂停 / Kill Switch | 三种情况 tick 均 blocked 且零排期/零桌面调用；PREPARE_ONLY 允许 prepare 但 publish 拒绝；暂停恢复、Kill 解除后链路继续 |
| (e) dailyLimit / minInterval | 上限时 `DAILY_LIMIT` + `nextEligibleAt` 次日 09:00；绕过调度直接准备后 Publisher 仍 `POLICY_DENIED`；最小间隔未到 `MIN_INTERVAL`，到期后成功发表 |
| 附加 | `allowPublish=false`→`PUBLISH_MODE_DISABLED`；微信未就绪→`WECHAT_NOT_READY`；账号不一致→`ACCOUNT_MISMATCH`；准备后内容篡改→`humanize_failed(code=CONTENT_CHANGED)` 且零点击 |

模式同步既有测试（本轮复跑）：

```powershell
python -X utf8 -m unittest client.tests.test_publish_modes -v
# Ran 4 tests ... OK（三档双向权限映射；网络失败保持 PREPARE_ONLY；执行器忙不改权限；非法模式拒绝）
```

## 5. 线上 E2E 前置条件（交由 Lead 执行）

> 目标：让 `task_50f23dfa-7c6e-4fce-ba95-d18cf7977e3d`（READY_TO_PUBLISH，已审核、文本无图、contentHash 已绑定）由 `HumanizeScheduler` **自动**完成 prepare+publish，全程不得人工审批。

### 5.1 前置检查（只读，必须全部满足）

| 项 | 检查方式 | 期望 |
|----|----------|------|
| 插件模式 | `GET /api/publish-mode` | `{"mode":"POLICY_AUTONOMOUS","requireApproval":false}` |
| 自动发送 | `GET /api/humanize` | `enabled=true, active=true`；当前 `blockedReasons=[]` |
| 调度/暂停 | `GET /api/status` | `killSwitch=false, paused=false, scheduleEnabled=true` |
| 目标任务 | `GET /api/status` / `GET /api/tasks/<taskId>` | `state=READY_TO_PUBLISH`、`contentHash`、`accountId` 非空、`attempts=[]`、无审批 |
| 执行器在线 | `GET http://127.0.0.1:18765/health`（`X-Moments-Token: data/desktop-token.txt` 内容） | `ok=true`；`mode` **等于**插件 `publishMode`；`allowPublish=true`；`driver=geometry`；`wechatInstalled=true`；`ocrAvailable=true`（prepare 读回需要）；需要管理员时 `adminPrivilege=true` |
| 微信状态 | 执行器 `GET /wechat/status` | `running=true, loggedIn=true, interactive=true, locked=false, supported=true` |
| 账号一致性 | 插件 `GET /api/status` 的 `accountId` = 任务 `accountId` = 微信当前账号 | 一致；geometry 的 `accountId` 由插件用 Reader/Hook 实时校验补齐（`src/adapters/windows/verified-account.ts:4-28`），因此本机 **Reader 5031 / Hook 30001 必须在运行** |
| 微信客户端前台 | 人工确认 | 微信主窗口存在、已登录、桌面未锁屏（几何驱动要求交互桌面） |
| 数据备份 | 复制 `data/moments.sqlite*`（含 `-wal/-shm`）到备份目录 | 建议，真实发表不可撤销 |

审计时点 live 快照（2026-10-25 12:44–12:49 +08）：

- `/api/publish-mode` = `POLICY_AUTONOMOUS` / `requireApproval=false`；`/api/humanize.enabled=true, active=true`。
- 当前本地 12:44，`activeHours=["09:00","12:00"]` → `lastTick.code=OUTSIDE_ACTIVE_HOURS`，`nextEligibleAt=2026-10-26T01:00:00Z`（次日 09:00），这是**当前自动链路未触发的主要原因**。
- `humanize` 实际参数：`delaySeconds=[90,900]`、`minIntervalSeconds=3600`、`policy.minIntervalMinutes=180`（生效间隔 10800s）、`jitterSeconds=600`、`dailyLimit=2`、`quietHours=["01:00","08:00"]`、`timeZone=Asia/Shanghai`。
- 执行器离线（18765 无监听，`/api/health` 显示“桌面执行器不可达”）；Reader 5031、Hook 30001 在监听；微信进程运行且主窗口“微信”存在。
- 历史真实 prepare 全部失败（见 0.4），`task_50f23dfa-…` 为失败后重建的内容、尚无 attempt。

### 5.2 启动“模式完全匹配”的桌面执行器（二选一）

**方案 A（推荐，权限同步最直接）：独立执行器**（管理员终端；须与插件模式完全一致）

```powershell
cd D:\dsh插插\dsh-moments-agent
# accountId 从 GET /api/status 读取；微信 Hook 基线版本为 4.1.10.27
python -X utf8 desktop/server.py --port 18765 `
  --token-file data/desktop-token.txt `
  --driver geometry --mode POLICY_AUTONOMOUS `
  --allow-publish --geometry-allow-publish `
  --trusted-account-source wechatagent `
  --expected-account <accountId> `
  --assume-client-version 4.1.10.27 `
  --max-publish-click-retries 1 --retry-backoff-seconds 2
# 若 /health 的 ocrAvailable=false 且自动探测失败，再加：
#   --ocr-python <DSH Python 3.12 路径>
```

> 独立执行器是独立进程、无模式同步通道：`--mode` 必须是 `POLICY_AUTONOMOUS`（= 插件当前模式），否则 publish 请求在 `desktop/server.py:505-506` 被拒且任务会变 FAILED（终态）。执行器 token 必须与插件 `desktopExecutor.tokenFile` 指向的 `data/desktop-token.txt` 一致。
> 另注意：`desktop/server.py` **不会**自动读取 `data/desktop-account.txt`（该行为只存在于内置客户端的 `build_executor_config`），`--trusted-account-source wechatagent` 要求显式 `--expected-account`，否则启动即 `ConfigError`。取值可用 `data/desktop-account.txt` 内容或 `GET /api/status` 的 `accountId`。

**方案 B：内置执行器（客户端 EXE/脚本）**

1. 启动客户端（`Start-Moments-Client-Admin.cmd` 或 `python -X utf8 client/server.py ...`），在“设置 → 发表模式”点击**应用并同步模式**（等同 `POST /api/client/publish-mode`，客户端会先把执行器降为 PREPARE_ONLY，再同步为插件模式）。
2. 用 `GET http://127.0.0.1:18765/health` 复核 `mode=POLICY_AUTONOMOUS, allowPublish=true`。
3. 注意 **浏览器心跳停止 60s 后客户端连同内置执行器退出**（`client/server.py:652-661`）——长窗口 E2E 期间保持页面/心跳存活，或改用方案 A。

### 5.3 临时放宽时间/延迟窗口（E2E 必需）

当前配置在活跃时段外且随机延迟 90–900s、间隔 3h，真实 E2E 必须临时放宽。使用管理 API（会自动持久化，便于恢复；只接受白名单字段）：

```powershell
$token = (Get-Content -Raw data\admin-token.txt).Trim()
$h = @{ "X-Moments-Token" = $token; "Content-Type" = "application/json" }

# 放宽：关闭自主创作（避免 E2E 期间新建任务）→ 活跃时段全天 → 零延迟/零抖动/零间隔
$relax = @{
  scheduleEnabled = $false
  policy = @{
    minIntervalMinutes = 0
    humanize = @{
      enabled = $true
      delaySeconds = @(0, 0)
      activeHours = @("00:00", "23:59")
      minIntervalSeconds = 0
      jitterSeconds = 0
    }
  }
} | ConvertTo-Json -Depth 6
Invoke-RestMethod -Uri "http://127.0.0.1:18766/api/automation" -Method Post -Headers $h -Body $relax
```

说明：

- `scheduleEnabled=false` 只关闭“自主创作”，**不影响 humanize tick**；humanize tick 固定每 10s 一次（`Math.min(10, scheduler.tickSeconds)*1000`，`src/runtime.ts:1692-1699`）。
- 若 E2E 时间落在 01:00–08:00，还需把 `policy.quietHours` 改为远离当前的区间（如 `["23:58","23:59"]`）。
- humanize 生效间隔 = `max(humanize.minIntervalSeconds, policy.minIntervalMinutes*60)`，两处都要放宽（上例已置 0）。
- 整点前 10 秒内排期会被 `avoidWholeHour` 顺延 ≤60s（`humanize-scheduler.ts:505-511`），属正常现象。
- `POST /api/automation` 在 Publisher 忙时会返回 CONFLICT，稍后重试即可。
- 上述 relax/restore 载荷已在 Mock 运行时上以 `runtime.updateAutomation` 验证可接受：relax 后 `blockedReasons=[]`、`nextEligibleAt≈now`；restore 后恢复为 live 原值。两种设置均持久化到 `system_settings`（`schedule_config` / `publish_schedule_config`），插件重启后仍生效，因此**恢复步骤不可省略**。

**恢复原配置**（成功或失败都必须执行；值来自 2026-10-25 live 快照）：

```powershell
$restore = @{
  scheduleEnabled = $true
  scheduler = @{ tickSeconds = 60; ideaProbability = 0.05; jitterSeconds = 0 }
  policy = @{
    dailyLimit = 2
    minIntervalMinutes = 180
    quietHours = @("01:00", "08:00")
    timeZone = "Asia/Shanghai"
    humanize = @{
      enabled = $true
      delaySeconds = @(90, 900)
      activeHours = @("09:00", "12:00")
      minIntervalSeconds = 3600
      jitterSeconds = 600
      maxPublishAttempts = 2
      backoffSeconds = @(60, 180)
    }
  }
} | ConvertTo-Json -Depth 6
Invoke-RestMethod -Uri "http://127.0.0.1:18766/api/automation" -Method Post -Headers $h -Body $restore
```

### 5.4 触发后的时间线与观察点

| 时间 | 动作 | 观察 |
|------|------|------|
| t0 | 放宽配置成功 | `GET /api/humanize`：`nextEligibleAt` 变为当前时刻附近 |
| +0–10s | 第一次 tick 排期 | `queue[0]` 出现 `task_50f23dfa-…`；`scheduledAt`≈now；`lastAction.action=humanize_scheduled`；任务仍 READY_TO_PUBLISH |
| +≤10s 起 | 第二次 tick 执行 | 任务 `QUEUED→PREPARING→PREPARED→PUBLISHING→PUBLISHED`；真实 GUI 过程可能 1–3 分钟（prepare 最长约 60s，publish 点击+核验 180s 超时上限） |
| 成功 | — | `GET /api/humanize`: `lastAction.action=humanize_published`、`queue=[]`、`today.published=1`；`GET /api/tasks/<id>`: `task.state=PUBLISHED`、`attempt.state=VERIFIED`、`attempt.verification.verified=true`、`attempt.approvalId=null`；`published_posts` 一行 |
| UNCERTAIN | 点击后无法核验 | 任务/尝试 `UNCERTAIN`；`humanize_failed(metadata.uncertain=true)`；“自动发送-需人工核对”通知（`ownerChannel=manual` 时写入插件日志）；**严禁再次 publish**；人工看朋友圈后用 `POST /api/uncertain/<attemptId>/resolve` `{resolution:"PUBLISHED"\|"FAILED", note:"..."}` 收敛 |
| 失败 | prepare/publish 未点击即失败 | 任务 `FAILED`（终态）+ `errorCode`；`humanize_failed` 审计；需新建内容才能再发 |

日志/DB 观察点：

- 执行器日志 `data/desktop/executor.log`：`收到 prepare 请求 attemptId=...`、`几何驱动已打开朋友圈纯文字编辑器`、`http POST /moments/prepare -> 200`、`http POST /moments/publish -> 200`、`准备失败 ... errorCode=...`。
- 执行器截图目录 `data/desktop/screenshots/`（prepare/verify 证据 PNG）。
- 插件审计（经管理 API，最方便）：`GET /api/tasks/<taskId>` 的 `audit` 字段应含 `humanize_scheduled`、`humanize_published`，以及 `state_transition` 链；`GET /api/humanize` 的 `lastTick/lastAction/lastError`。
- 只读 DB 查询（若需要直接证据，**不要写库**）：

```powershell
node -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('data/moments.sqlite',{readOnly:true});console.log(db.prepare('select attempt_id,state,approval_id,mode,error_code from publish_attempts order by created_at desc limit 5').all());console.log(db.prepare('select post_id,task_id,verified,published_at from published_posts order by published_at desc limit 3').all())"
```

（若提示 SQLite 实验性警告属正常；只读打开不会写入 live 数据库。）

### 5.5 常见阻塞码 → 处置

| 观测 | 含义 | 处置 |
|------|------|------|
| `EXECUTOR_UNAVAILABLE` / 插件 health `desktopExecutor unavailable` | 18765 未监听/令牌不匹配 | 启动 5.2 的执行器；核对 `data/desktop-token.txt` |
| `PUBLISH_MODE_DISABLED`（调度阶段） | 执行器 `allowPublish=false`：未 `--allow-publish` 或模式为 PREPARE_ONLY | 用 5.2 重新启动/同步 |
| `PUBLISH_MODE_DISABLED`（publish 阶段，执行器拒绝） | 插件模式 ≠ 执行器 mode（`desktop/server.py:505-506`） | 重同步；任务可能已 FAILED，需新建内容 |
| `WECHAT_NOT_READY` | 微信未运行/未登录/锁屏 | 前台登录解锁后重试 |
| `ACCOUNT_MISMATCH` | 桌面/Reader 账号 ≠ 任务绑定账号 | 切回绑定账号，或重建内容 |
| `OUTSIDE_ACTIVE_HOURS` / `QUIET_HOURS` | 时段限制 | 按 5.3 放宽 |
| `DAILY_LIMIT` / `MIN_INTERVAL` | 配额/间隔 | 放宽或等下一个窗口 |
| `CONTENT_CHANGED`（prepare 阶段，来自执行器） | **本次 E2E 最可能的失败点**：粘贴后 OCR 读回与预期不一致（历史 8 次） | 修 geometry/OCR（Lead），用新任务重试；旧任务已 FAILED 不可复用 |
| `UNCERTAIN` | 已点击但无法核验 | 人工核对朋友圈后 resolve；**绝不重发** |

## 6. 残余风险与建议

### 6.1 已识别残余风险

| # | 风险 | 说明 | 缓解 |
|---|------|------|------|
| R1 | **UNCERTAIN 处理** | 点击后无法核验 → 任务/尝试 UNCERTAIN，自动链路永久停止该内容，只能人工 resolve；不会重复点击 | E2E 前保持微信前台、避免锁屏/弹窗遮挡；发生 UNCERTAIN 立即人工核对，禁止再 publish；`POST /api/uncertain/.../resolve` 或管理页按钮 |
| R2 | **内置客户端 60s 空闲退出** | 浏览器心跳停止 60s 后客户端 shutdown，内置执行器同步退出（`client/server.py:652-661`），自动发送中断 | 长窗口用独立执行器；或保持页面存活 |
| R3 | **模式同步时机/一次性** | 启动、切换、改连接才同步；直接调插件 `/api/publish-mode` 或执行器先于插件启动会导致“插件非 PREPARE_ONLY、执行器 PREPARE_ONLY”的安全停滞 | 只经客户端“应用并同步模式”切模式；E2E 前按 5.1 用 `/health` 核对 mode 相等 |
| R4 | **模式不一致会消耗任务** | publish 请求模式 ≠ 执行器 mode 时执行器未点击但返回 `PUBLISH_MODE_DISABLED`，Publisher 把任务记为 FAILED（终态，不可复用旧内容） | 严格按 5.2 启动；先 `/health` 自检 |
| R5 | **publish 阶段未点击失败也转 FAILED** | 与 prepare 阶段不同（prepare 白名单错误可 QUEUED 重试），publish 阶段非提交失败直接 FAILED（`publisher.ts:495-509`），不自动重试 | 保证执行器/微信稳定；失败需新建内容 |
| R6 | **最小间隔/每日上限在 tick 与 Publisher 之间的竞态** | Publisher 二次校验 `POLICY_DENIED` 时任务已 PREPARED，调度器 +60s 重排但下一 tick 的候选状态检查会放弃条目（`TASK_NOT_APPROVED`），任务停在 PREPARED 需人工处理（单进程内概率极低） | 已由 `effectiveIntervalSeconds` 与到点复检把窗口压到最小；E2E 时放宽限额即可避免 |
| R7 | **真实 prepare 的几何 OCR 稳定性** | live 证据显示粘贴读回反复失败（`CONTENT_CHANGED`），是当前真实 E2E 的头号阻塞点 | 见 0.4/5.5；属 Lead 的 desktop geometry 范畴 |
| R8 | **人类可见副作用** | 真实发布会写入 `published_posts` 并在微信朋友圈产生公开内容，不可撤回 | E2E 前备份 DB、确认任务文案/可见范围（当前 PUBLIC、纯文字）、时间窗内不操作微信 |
| R9 | **版本基线** | geometry 基线仅 4.1.10.27；本机安装的微信为 4.1.15.13，需 `--assume-client-version 4.1.10.27` 才 `supported=true`；升级后需重新验收 | 按 5.2 传入该参数；版本变化后不要直接沿用结论 |
| R10 | **管理令牌/回环限制** | 所有管理调用需 `X-Moments-Token` 且仅 127.0.0.1；E2E 脚本需从 `data/admin-token.txt` 读取，勿写入文档/日志 | 按 5.3/5.4 的命令执行 |

### 6.2 建议（本轮未实施，避免与 Lead 并发编辑冲突）

1. **点击前模式一致性预检**：在 `publish-policy.evaluatePublish` 增加 `desktopHealth.mode === effectivePublishMode(config)` 校验，把“模式不一致”从“点击后 FAILED”提前为“点击前拒绝、任务保持 PREPARED 可修复”。会波及 `tests/helpers/mock.mjs` 的 `MockDesktop.health.mode` 默认值（当前为 PREPARE_ONLY）与多个既有用例，需 Lead 同意后统一改。
2. **客户端切换失败后的自动回读**：`change_publish_mode` 在插件返回明确 HTTP 4xx（插件模式未变）时，可再 GET `/api/publish-mode` 并用该权威模式恢复执行器（网络不确定时仍保持 PREPARE_ONLY），减少“安全停滞”。
3. **启动同步重试/漂移检测**：客户端启动同步失败或运行期检测到 `executor.health.mode != 插件 mode` 时，自动重试一次并提示，而非仅告警。
4. **补一个客户端启动同步测试**：断言 `plugin_mode_request` 成功返回 POLICY_AUTONOMOUS/APPROVAL_REQUIRED/PREPARE_ONLY 时执行器 health 的 `mode/allowPublish` 与之一致，失败时 PREPARE_ONLY（覆盖 D5）。

## 7. 附录

### 7.1 本轮读到的 live 证据（只读）

```powershell
$token = (Get-Content -Raw data\admin-token.txt).Trim()
$h = @{ "X-Moments-Token" = $token }
Invoke-RestMethod http://127.0.0.1:18766/api/publish-mode -Headers $h
Invoke-RestMethod http://127.0.0.1:18766/api/humanize     -Headers $h
Invoke-RestMethod http://127.0.0.1:18766/api/status       -Headers $h
Invoke-RestMethod http://127.0.0.1:18766/api/config       -Headers $h
Invoke-RestMethod "http://127.0.0.1:18766/api/tasks/task_50f23dfa-7c6e-4fce-ba95-d18cf7977e3d" -Headers $h
```

关键返回（摘要）：

- `/api/publish-mode`: `{"mode":"POLICY_AUTONOMOUS","requireApproval":false}`
- `/api/humanize`: `enabled=true, active=true, publishMode=POLICY_AUTONOMOUS`；`config.delaySeconds=[90,900]`、`activeHours=["09:00","12:00"]`、`minIntervalSeconds=3600`、`effectiveIntervalSeconds=10800`、`jitterSeconds=600`、`dailyLimit=2`、`quietHours=["01:00","08:00"]`；`time.localTime="12:44"`、`inActiveHours=false`；`lastAction.code=OUTSIDE_ACTIVE_HOURS`、`nextEligibleAt=2026-10-26T01:00:00Z`
- `/api/status`: `killSwitch=false, paused=false, scheduleEnabled=true`；唯一未结束任务 `task_50f23dfa-… state=READY_TO_PUBLISH`，`contentHash=b5a5a579…65c28`、`assetManifestHash=9b5f45c…bf8b`、`accountId` 已绑定、`approvalId=null`；执行器 `desktopExecutor.status=unavailable`（离线）
- `/api/health` counts：`CANCELLED=5, EXPIRED=6, FAILED=7, READY_TO_PUBLISH=1`
- 网络：`127.0.0.1:5031`（Reader）、`127.0.0.1:30001`（Hook）监听；`18765` 无监听；微信进程运行且有主窗口“微信”

### 7.2 历史真实 prepare 失败证据（来自 `data/desktop/executor.log`，非本轮产生）

```
2026-10-25T12:26:16 桌面执行器初始化 ... mode=PREPARE_ONLY allowPublish=false driver=geometry assumedClientVersion=4.1.10.27
2026-10-25T12:27:37 收到 prepare 请求 attemptId=att_102a5e52-8b18-4015-a3c6-246d5ab56d83
2026-10-25T12:27:49 几何驱动已打开朋友圈纯文字编辑器（attempt=1）
2026-10-25T12:28:31 准备失败 ... errorCode=CONTENT_CHANGED message=粘贴后 OCR 读回正文与预期不一致，已停止操作（未点击发表）
```

对应任务 `task_3473694a-cf53-494c-b9f8-7680cbb8d0c0`：`state=FAILED, errorCode=CONTENT_CHANGED`，attempt `att_102a5e52-… state=FAILED`。2026-10-24 另有 7 次同类失败（日志合计 8 次）。**结论：真实性 prepare 尚未通过，自动链路的政策/状态机部分已就绪，GUI/OCR 部分是当前唯一阻塞点。**

### 7.3 相关文件索引

- 新增测试：`tests/integration/autonomous-publish.test.mjs`
- 发布：`src/publishing/publisher.ts`、`publish-policy.ts`、`humanize-policy.ts`、`humanize-scheduler.ts`
- 组装/状态：`src/runtime.ts`、`src/domain/state-machine.ts`、`src/storage/store.ts`
- 管理：`src/admin/server.ts`、`client/server.py`、`client/web/app.js`
- 执行器：`desktop/server.py`、`desktop/config.py`、`desktop/moments_editor.py`、`desktop/geometry_driver.py`
- 既有文档：`docs/QUIET_AUTONOMOUS_PUBLISHING.md`、`docs/audit/THREE_PUBLISH_MODES_2026-10-24.md`、`docs/audit/VERIFICATION_ROUND5.md`、`docs/architecture/desktop-executor-protocol.md`
---

## 附：2026-10-25 真机 E2E 结果（Lead 执行，本审计之后）

本文第 5 节列出的两个硬阻塞已在同日晚间解除并完成现场验收：

1. 几何执行器阻塞由 Lead 的 geometry 修复解决（物理像素窗口归一化 + 屏幕捕获 + PerMonitorV2 DPI 感知 + 非管理员同完整性输入），见 `docs/audit/GEOMETRY_DPI_1_1_9.md`。
2. activeHours 由 `POST /api/automation` 临时放宽（scheduleEnabled=false、全天活跃、0 延迟/抖动/间隔），E2E 完成后已恢复所有者原配置。
3. 结果：任务 `task_50f23dfa-7c6e-4fce-ba95-d18cf7977e3d` 由 humanize tick 自动排期 → 自动 prepare → 自动点击发表 → 朋友圈 OCR 核验成功；任务 `PUBLISHED`、尝试 `VERIFIED`、`approvalId=null`、`published_posts` 新增 1 条。
4. 现场时间线、证据截图与恢复记录见 `docs/audit/AUTO_PUBLISH_LIVE_1_1_9.md`。本文的链路/门禁分析与 mock 测试结论与真机行为一致。
