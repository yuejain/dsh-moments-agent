# Phase 1+ 交付 Gate 记录

> 前置：`docs/audit/PHASE0_GATE.md` 结论为 **CONDITIONAL GO**。
> 本文件记录 Phase 1–7 实际完成情况与“是否可声明 MVP”。

## 1. 允许范围 vs 实际完成

| Phase 0 Gate 允许项 | 实际完成 | 证据 |
| --- | --- | --- |
| 插件骨架 / Config / 工具注册 | ✅ | `src/plugin.ts`、`src/tools/index.ts`、安装后 17 工具可见（`LIVE_VERIFICATION.md`） |
| persona + 独立任务隔离 | ✅（任务级） | `persona/`、SQLite `moment_tasks`；**未创建 DSH Agent Preset/Session** |
| LLM 文案 | ✅（代码 + Mock） | `src/brain/*`；真实模型调用未执行 |
| Codex 文本评审 | ⚠️ 未采用 | 未把 Codex 子智能体接入内容链；评审使用 `ctx.llm` |
| 根会话/Host 调度 | ✅（Timer） | `MomentsRuntime.start()` + `autonomousCycle()`；真实 Host 调度触发未实测 |
| 人工图像导入 | ✅ | `src/image/asset-store.ts` + 单测 |
| Mock 执行器 | ✅ | `desktop/` FakeWechatDriver + 121 项 Python 测试 |
| 禁止自动发朋友圈 | ✅ | 默认 PREPARE_ONLY + 双层开关 + 测试 |
| 禁止 Codex 出图 | ✅ | `CodexSubscriptionProvider` 永远 `UNSUPPORTED_AUTHORIZATION` |
| 禁止子代理建 schedule | ✅ | 调度器在 Host 插件内，不使用子代理会话 |
| 受控 install_bundle | ✅（已获用户授权） | 安装/卸载/重装均 `application: applied` |

## 2. Phase 1–7 完成度

| Phase | 目标 | 状态 |
| --- | --- | --- |
| 0 | 审计与兼容性 | ✅ 11 份审计/验证文档 |
| 1 | 插件基础设施（Config/SQLite/状态机/工具/健康/单测） | ✅ |
| 2 | WeChatAgent 适配（账号/命令/通知/审批/图片/隔离） | ✅ 代码 + Mock HTTP；实机 NOT_TESTED |
| 3 | 自主创作与记忆（模型/人格/选题/文案/评估/去重/日志） | ✅ 代码 + Mock；真实模型 NOT_TESTED |
| 4 | 图片桥接（Router/本地/人工桥/ComfyUI/官方/审核/素材） | ✅ 代码 + 单测；真实服务 NOT_TESTED |
| 5 | Windows GUI 准备（检测/编辑/填文/传图/可见范围/截图/回退） | ✅ 代码 + Mock；真实 GUI NOT_TESTED |
| 6 | 审批与发布（绑定/账号/发表/核验/状态/不确定） | ✅ 代码 + Mock 全流程；真实发表 DISABLED/NOT_TESTED |
| 7 | 稳定性与交付（恢复/迁移/文档/安装/日志/安全/README） | ✅ |

## 3. 强制测试对照

| 类别 | 结果 |
| --- | --- |
| 兼容性（插件启停/接口变化/客户端版本） | ✅ 安装/卸载/重装实测；版本不匹配返回 `DESKTOP_UNSUPPORTED` |
| 自主决策（沉默/重复/隐私/来源/暂停） | ✅ 单测 |
| 图像（导入/损坏/重复/格式/任务不匹配/不可用/超时/审核/越界） | ✅ 单测 |
| 审批（过期/重复/伪造/改文案/改图/改可见范围/换账号/取消） | ✅ 单测（伪造由 owner 校验 + 管理令牌覆盖） |
| 发布（窗口/未登录/锁屏/上传/内容不符/超时/崩溃/重复/不确定/恢复） | ✅ Mock + 单测；真实 GUI NOT_TESTED |
| 安全（群聊/网页注入/越权工具/跨账号/脱敏/令牌/Kill Switch/接口暴露） | ✅ 单测 + 回环校验 |

## 4. MVP 验收判定

按提示词第十八部分逐条：

1. 插件在验证版本加载：✅（DSH 0.2.1-rc.2 实测）
2. 独立任务会话建立与恢复：✅（SQLite 任务/审计/重启测试）；⚠️ 非 DSH Agent Session
3. DeepSeek 生成草稿：✅ 代码路径；⏳ 真实模型未调用
4. 不适合时沉默：✅
5. 图片通过至少一种 Provider/人工桥：✅ 人工桥 + 本地导入
6. 图片持久化/去重/审核：✅
7. 完整图文发布包：✅（preview + prepare request）
8. 用户可查看/批准/取消：✅（管理页 + 工具）
9. Windows 执行器准备图文且发表前停止：✅ Mock；❌ 真实 GUI NOT_TESTED
10. 状态可追踪/恢复：✅
11. 无跨账号/越权/重复发布：✅ 代码 + 单测
12. 自动化测试通过：✅ JS 105/106（1 跳过）、Python 119/121（2 跳过）
13. README 安装步骤：✅ 本机验证
14. 实测/模拟/未完成区分：✅（README §10、本文件）

**结论：可声明“Mock/准备级 MVP 完成”；不得声明“真实朋友圈发布完成”。**
正式发表能力是独立里程碑，满足下方 Re-gate 后重新验收。

## 5. Re-gate 条件（真实发表前必须全部满足）

1. 微信客户端版本与 `desktop/` 已验证基线一致，或完成 4.1.15.13 控件树人工测绘；
2. 安装 UIA 客户端库（pywinauto/comtypes）并验证控件树读取/写入；
3. 真实测试账号完成：打开朋友圈 → 填文 → 传图 → 可见范围 → 截图 → 取消（不发）；
4. 使用隔离测试账号完成一次真实发表，核验内容/账号/幂等/UNCERTAIN；
5. 确认 WeChatAgent Hook 许可与平台规则允许；
6. 确认 token 文件 ACL 与运行账户隔离；
7. 重新跑全部测试并更新 `LIVE_VERIFICATION.md` / `TEST_REPORT.md`。
