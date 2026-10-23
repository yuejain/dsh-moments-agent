# DSH Moments Agent

基于 DeepSeek Harness 的 Windows 朋友圈创作、配图、审核与审批插件。当前为 **0.2.0 预发布版本**，不是已完成实机验收的自动发布产品。

## 能力

- 独立 DSH 会话、17 个工具、人格及长期记忆、选题与文案审核。
- SQLite 状态机、一次性审批、内容哈希绑定、崩溃恢复及 UNCERTAIN 禁止自动重试。
- PNG/JPEG/WebP/GIF 完整解码、感知哈希、重复检测；拒绝损坏及多帧图片。
- 人工订阅生图/编辑桥，以明确的任务 ID 导入图片；本地 ComfyUI 和显式预算下的官方 API 适配。
- 可选多模态语义审核/OCR，通过 DSH 附件服务传递图片。`images.semanticReviewEnabled` 默认关闭；启用会向所配置模型发送任务图片。
- 本机管理 Web 客户端、人格/记忆/调度设置、暂停和 Kill Switch。

## 运行与测试

需要 Windows、Node.js 24、Python 3.11+。目标 DSH 契约为 0.2.1-rc.2。

```powershell
npm ci
npm test
npm run verify
npm run test:desktop
npm run test:client
npm run build
```

插件入口为 `dist/index.js`，bundle 配置为 `cordis.patch.yml`。将构建后的本目录作为本地包安装到 DSH profile，按 `config/moments.example.yaml` 配置。真实账号及令牌只保存在本机，不提交 Git。

```powershell
# 桌面服务：默认禁止发表
python desktop/server.py --port 18765 --token-file data/desktop-token.txt --mode PREPARE_ONLY
# 管理客户端：要求 DSH 插件管理 API 已在 18766 启动
python client/server.py --admin-url http://127.0.0.1:18766 --token-file data/admin-token.txt --data-dir data
```

默认 `PREPARE_ONLY`，自主调度关闭。启用外部服务前需配置自身授权信息。人工图片放入通知中的 `data/imports/<imageTaskId>/`，不能把任意最近图片自动关联到任务。

## 已知限制

- 微信 4.x Qt 控件树可能不可访问；真实 prepare/publish/verify 尚未完成可靠验收。Mock 测试通过不代表真实朋友圈发表成功。
- 多模态审图已实现并通过 Mock 测试，尚未完成真实模型准确性验收；不能保证检测所有隐私或误导内容。
- 图片编辑目前通过人工桥；ComfyUI/官方 API 自动编辑未接入。
- 公开许可图片检索、正式 Codex 文本子任务委派、本地生成完整资源预检仍未完成。
- 社区订阅图像适配器未完成授权验证，返回 UNSUPPORTED_AUTHORIZATION；不读取 Cookie 或调用私有端点。
- 本仓库不包含真实账号、聊天记录、数据库、实机截图、Hook 二进制或本地历史验收档案。

## 许可

本项目代码采用 [MIT](LICENSE)，允许修改、分发和商业使用，保留版权与许可声明。第三方依赖及上游项目保留各自许可，见 [第三方说明](THIRD_PARTY_NOTICES.md)。本项目不是微信、DeepSeek 或 OpenAI 的官方产品；代码许可不授予第三方账号或服务使用权。
