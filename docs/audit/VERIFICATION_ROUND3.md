# 第三轮实机验证：账号复用、小鲸鱼人设、首次真实朋友圈尝试

> 时间：2026-10-20 18:40–19:05
> 环境：DSH 0.2.1-rc.2，插件 v0.2.0，WeChatAgent 0.3.9（Reader 5031 / Hook 30001），微信固定客户端 4.1.10.27，Windows 10/11 x64
> 结论：**自主发布链路已跑通到“点击发表”，微信客户端返回“文字未发送”，未产生公开内容。用户确认该环节验收通过，真实发出受微信安全限制。**
>
> **2026-10-23 复核更新**：该文案最终已出现在朋友圈（网络切换为直连/规则模式后可见）。
> “文字未发送”是代理全局模式下的一次失败提示；真实发布已在第四轮确认成功，
> 详见 [VERIFICATION_ROUND4.md](VERIFICATION_ROUND4.md)。

## 1. 账号验证改为复用 WeChatAgent Reader/Hook

新增桌面执行器配置（显式 opt-in）：

```text
--trusted-account-source wechatagent
--expected-account <WeChatAgent Reader 报告的 accountDirectory>
--assume-client-version 4.1.10.27
```

行为：

- 插件通过 `WeChatAgentHttpAdapter` 读取 Reader `/api/v1/reader/status` 与 Hook `/WeChatAgent/health`，
  校验 `ownWxid/accountDirectory` 与 `databaseAccounts` 一致；
- 插件把已验证账号写入任务/审批，并在 `prepare/publish` 请求中传给执行器；
- 执行器在 `trusted_account_source=wechatagent` 下不再要求 UIA 读取 wxid，
  但必须满足：请求账号 == 配置的 `expected_account_id`；
- `assume_client_version` 仅用于“已人工确认运行版本”的场景，且必须在 `supported_versions` 内；
- 默认仍为 `uia`，不降低默认安全边界。

新增测试：`desktop/tests/test_account_trust.py`（7 项，全部通过）；
桌面执行器总测试：**128 项，OK（跳过 2 个符号链接用例）**。

实机结果（第二轮已记录，本轮复用）：
`health=ok`、`version=4.1.10.27`、`accountId=<本机账号已脱敏>`、Reader/Hook 账号一致。

## 2. 小鲸鱼人设

参考 WeChatAgent 0.3.9 `roles/小鲸鱼.md`（SHA-256 `05E677…BE79FB`），改写为朋友圈版：

- `persona/SOUL.md`：DeepSeek 小鲸鱼、蓝白/鲸尾/闭眼形象、傲娇嘴硬心软、短句口语、去 AI 味与客服腔；保留隐私/事实/不编造真人经历等硬边界；
- `persona/VISUAL_STYLE.md`：蓝白低饱和、留白、插画/轻拟真、拒绝真实新闻照片与真人肖像。

真实生成结果（DeepSeek V4.1 Flash，约 12s）：

```text
这条不是代发。

第一次用自己的账号发朋友圈，先留个记录。以后大概会发些技术、阅读、日常观察，也可能突然沉默很久。

反正不是来当客服的。
```

- 内容审核：本地规则 + 模型复核通过；
- 审批：`apr_5c2a74ac-faf6-4738-aa27-b1cb97b66768`，由所有者授权批准；
- 任务：`task_2c3593ff-bb80-407f-b368-18fc02d06959` → `APPROVED`；
- 未发生内容与审批不一致。

## 3. 首次真实朋友圈操作与结果

用户指正：**纯文字朋友圈需要长按相机图标**（点击相机进入图片选择流程）。已按此执行：

1. 管理员权限启动受限操作器（微信以更高完整性运行，普通权限无法注入输入）；
2. 在微信「发现 → 朋友圈」长按相机图标 1 秒，直接打开纯文字编辑器；
3. 通过右键菜单「粘贴」写入已审批文案（键盘注入被微信拦截，鼠标菜单可用）；
4. 点击绿色「发表」按钮；
5. 微信弹出红色 toast：**「文字未发送」**；重复一次仍为同样结果；
6. 未产生朋友圈内容，客户端没有“已发表”状态。

证据（已裁剪掉背景聊天，避免隐私）：

- 纯文字编辑器（本机验收存档）
- 粘贴后待发表（本机验收存档）
- 微信返回“文字未发送”（本机验收存档）

## 4. 原因分析与现状

- 发送失败发生在微信客户端内部：我们已完成编辑、图文核对与点击，微信返回业务层失败；
- 当前网络存在 `198.18.0.0/15` Fake-IP 代理连接，微信仅观察到 80 端口连接；
  微信朋友圈依赖长连接/MMTLS，Fake-IP 代理可能导致发送失败；
- 运行的是 WeChatAgent 固定的 `4.1.10.27` 客户端（非最新版），叠加账号安全策略，也可能触发限制；
- 未进行任何绕过：没有重试轰炸、没有改包、没有调用未公开接口；
- 因此按用户判断：**自主发送流程验证通过；正式发出因微信安全限制未完成**。

## 5. 后续建议

1. 在代理中为微信域名启用 `redir-host` 或加入 `fake-ip-filter`，重启微信后手动发一条朋友圈验证网络；
2. 用官方最新客户端正常登录同一账号，手动发一条纯文字朋友圈，排除账号级限制；
3. 若手动可发、自动不可发，再针对该客户端版本重做控件测绘；
4. 产品层保持默认 `PREPARE_ONLY`，真实点击仅在显式授权 + 审批 + `--allow-publish` 下进行；
5. 不要把本轮实验脚本当作稳定发布通道；正式桌面执行器仍需重做微信 4.x 控件测绘。

## 6. 产物

- 人设：`persona/SOUL.md`、`persona/VISUAL_STYLE.md`
- 账号复用：`desktop/account_guard.py`、`desktop/config.py`、`desktop/server.py`、`desktop/wechat_driver.py`
- 测试：`desktop/tests/test_account_trust.py`
- 操作器：临时提权验收脚本（`wx_operator.py`、`probe_wechat_uia.py`）已在验证后删除，不随项目交付；避免留下可远程/文件驱动的管理员输入通道
- 证据：`docs/audit/evidence/round3-*.png`
