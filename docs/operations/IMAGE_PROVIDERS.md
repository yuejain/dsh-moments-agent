# 图像 Provider 接入指南

## 0. 统一接口

```ts
interface ImageProvider {
  id: ImageProviderKind;
  checkCapabilities(): Promise<ImageProviderCapabilities>;
  generate(request: ImageGenerationRequest): Promise<ImageGenerationResult>;
  getStatus(taskId: string): Promise<ImageGenerationResult | null>;
  cancel(taskId: string): Promise<boolean>;
}
```

Provider 只返回图片字节与元数据；落盘、去重、审核由 `AssetStore` / `ImageReviewer` 统一完成。
业务层只依赖 `ImageFacade`（`src/adapters/types.ts`）。

## 1. 人工订阅桥（默认启用，推荐）

流程：

1. `moments_generate_image_task` → 返回 `awaiting_user` + 提示词；
2. 用户在自己的 **ChatGPT Plus / Gemini 客户端**手工生成图片；
3. 把图片放进 `data/imports/`，或通过客户端保存后由用户提供 base64；
4. `moments_import_image`（`path` 相对于 `data/`，或 `base64` + `mime`）；
5. 自动校验签名/尺寸/SHA-256/重复/质量，通过后关联任务。

禁止：

- 抓取浏览器 Cookie / localStorage / 会话 token；
- 调用 ChatGPT/Gemini 非公开接口或逆向订阅端点；
- 把个人订阅伪装成官方 API；
- 自动把“最近收到的任意图片”关联到最近任务 —— 必须显式提供 taskId/imageTaskId。

## 2. 本地导入

- 允许目录：`data/imports`、`data/assets`；
- 支持 PNG / JPEG / WebP / GIF；
- 拒绝损坏、空文件、伪造 MIME、目录、符号链接、越界路径；
- 记录 license / source / prompt / provider / model / SHA-256 / 尺寸。

## 3. ComfyUI（可选，本地自动生成）

- 默认地址 `http://127.0.0.1:8188`，可用 `DSH_MOMENTS_COMFYUI_URL` 覆盖；
- 只允许回环地址；
- 先探测 `/system_stats` 与 `/object_info`，模型/资源不可用直接返回 `unavailable`；
- submit → 轮询 `/history` → 下载 `/view`，支持超时与取消；
- 本机没有 ComfyUI 服务，真实路径 NOT_TESTED；单测用 Mock fetch 覆盖。

启用：把 `local-generation` 加入 `images.providers`，并保证 ComfyUI 正在运行。

## 4. 官方付费图像 API（默认关闭）

启用条件（全部满足）：

1. `images.officialApiEnabled: true`；
2. 环境变量 `DSH_MOMENTS_OFFICIAL_IMAGE_API_KEY`；
3. `DSH_MOMENTS_IMAGE_BUDGET_USD > 0`；
4. 请求显式给出 `maxUsd` 预算，且不超过剩余预算；
5. 端点必须是 https，或本机回环。

默认情况下 Provider 直接返回 `OFFICIAL_API_DISABLED`，**不会产生任何网络请求或费用**。
预算耗尽后拒绝继续调用。

## 5. Codex 订阅桥（明确拒绝）

已安装的官方 `@deepseek-ai/dsh-subagent-codex` 只接受文本、只返回文本，**没有图像生成能力**。
社区订阅插件（如 `dsh-codex`、`dsh-codex-subscription`）属于第三方实验性实现，本项目：

- 不将其视为官方授权；
- 不抓取/复用其登录令牌；
- 不调用其非公开端点；
- Provider 永远返回 `UNSUPPORTED_AUTHORIZATION`。

如未来官方开放图像生成 API，应新增独立 Provider，并补充授权、计费、审计测试。

## 6. 新增 Provider 的步骤

1. 在 `src/image/providers/` 新建类，实现 `ImageProvider`；
2. 在 `providers/index.ts` 注册名称映射；
3. 加入 `config.images.providers` 顺序；
4. 所有网络请求必须可注入 `fetch`，便于 Mock 测试；
5. 加入超时、取消、预算、错误码；
6. 写单元测试：不可用、超时、非法响应、预算耗尽、取消；
7. 更新本文档与 README 的 Provider 表。

## 7. 素材版权与真实性

- 每条素材记录 `license`、`source`、`prompt`、`provider`、`model`；
- 生成图片不得冒充新闻现场、真实照片或他人肖像；
- 现实事件/人物必须有可核对来源，且不得用生成图替代真实照片；
- 涉及他人肖像/隐私的图片必须获得授权。
