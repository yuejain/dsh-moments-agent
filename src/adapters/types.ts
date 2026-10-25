/**
 * 适配器边界：WeChatAgent、DSH LLM、桌面执行器、图像 Provider、审批通道。
 *
 * 业务层只依赖这些接口，不直接依赖 WeChatAgent 内部对象或 Windows GUI 细节，
 * 以便 Mock、替换与上游升级。
 */
import type {
  AdapterHealth,
  ApprovalRequestView,
  ImageProviderKind,
  MediaAssetRecord,
  PublishVerification,
  Visibility,
} from '../domain/types.js';

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export type Clock = () => Date;

/** 可注入的 fetch，便于 Mock 测试（不改变全局 fetch）。 */
export interface FetchLike {
  (input: string, init?: RequestInit): Promise<Response>;
}

// ---------------------------------------------------------------------------
// LLM
// ---------------------------------------------------------------------------

export interface LlmMessage {
  readonly images?: readonly { bytes: Uint8Array; mediaType: string }[];
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface LlmRequest {
  readonly system?: string;
  readonly messages: readonly LlmMessage[];
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
  readonly purpose?: 'idea' | 'compose' | 'review' | 'image-prompt' | 'image-review' | 'other';
}

export interface LlmResponse {
  readonly text: string;
  readonly model: string;
  readonly provider: string;
  readonly usage?: { inputTokens?: number; outputTokens?: number };
}

/** DSH ctx.llm 的薄封装；测试中用 MockLlmClient 替代。 */
export interface LlmClient {
  complete(request: LlmRequest): Promise<LlmResponse>;
  checkCapabilities(): Promise<AdapterHealth>;
}

// ---------------------------------------------------------------------------
// WeChatAgent
// ---------------------------------------------------------------------------

export interface OwnerMessage {
  readonly isGroup?: boolean;
  readonly messageId: string;
  readonly senderWxid: string;
  readonly accountId: string;
  readonly text: string;
  readonly receivedAt: string;
  readonly imageIds?: readonly string[];
}

export interface WechatSendResult {
  readonly delivered: boolean;
  readonly messageId?: string;
  readonly reused?: boolean;
}

export interface WechatImagePayload {
  readonly sha256: string;
  readonly mime: string;
  readonly bytes: Uint8Array;
}

/** Reader 会话（仅上游白名单内可见）。talker 是原始 ID，只用于本机同步。 */
export interface WechatConversation {
  readonly talker: string;
  readonly kind: 'group' | 'private';
  readonly displayName: string;
}

/** Reader 纯文本消息；已由适配器做基础清洗，未做隐私脱敏（由记忆层负责）。 */
export interface WechatChatMessage {
  readonly talker: string;
  readonly messageId: string;
  readonly sentAt: string;
  readonly senderWxid: string;
  readonly senderName: string;
  readonly text: string;
  readonly isSelf: boolean;
}

/**
 * WeChatAgent 适配器。
 *
 * 只依赖其公开文档化的本机接口：
 * - Reader API: /api/v1/reader/status、/api/v1/sessions、/api/v1/messages、/api/v1/images/<sha256>（Bearer token）
 * - Hook API: /WeChatAgent/health、/SendTextMsg（Bearer token + X-WeChatAgent-Account）
 * 不假设存在 sendImage / publishMoments 等未公开方法。
 */
export interface WeChatAgentAdapter {
  checkHealth(): Promise<AdapterHealth>;
  /** 当前微信账号；未验证时返回 null，绝不返回配置里“声称”的账号。 */
  getAccount(): Promise<{ accountId: string; ownWxid: string } | null>;
  sendText(text: string, options?: { signal?: AbortSignal }): Promise<WechatSendResult>;
  listOwnerMessages(limit: number): Promise<OwnerMessage[]>;
  fetchImage(sha256: string): Promise<WechatImagePayload>;
  /** 读取 Chat 范围白名单内的会话（含群聊/私聊），用于社交记忆同步。 */
  listConversations(limit: number): Promise<WechatConversation[]>;
  /** 读取单个会话的纯文本消息；上游会拒绝白名单外会话。 */
  listConversationMessages(talker: string, limit: number): Promise<WechatChatMessage[]>;
}

// ---------------------------------------------------------------------------
// 桌面执行器
// ---------------------------------------------------------------------------

export interface DesktopHealth {
  readonly ok: boolean;
  readonly version: string;
  readonly wechatInstalled: boolean;
  readonly wechatVersion: string | null;
  readonly uiaAvailable: boolean;
  readonly allowPublish: boolean;
  readonly mode: string;
  readonly message: string;
}

export interface WechatClientStatus {
  readonly running: boolean;
  readonly loggedIn: boolean;
  readonly accountId: string | null;
  readonly version: string | null;
  readonly interactive: boolean;
  readonly locked: boolean;
  readonly supported: boolean;
  readonly windowTitle: string | null;
  readonly dpiScale: number | null;
  readonly notes: readonly string[];
}

export interface DesktopPrepareRequest {
  readonly taskId: string;
  readonly attemptId: string;
  readonly text: string;
  readonly assetPaths: readonly string[];
  readonly visibility: Visibility;
  readonly contentHash: string;
  readonly accountId: string;
  readonly screenshotDir: string;
}

export interface DesktopPrepareResult {
  readonly ok: boolean;
  readonly prepared: boolean;
  readonly screenshotPath: string | null;
  readonly textMatched: boolean;
  readonly imageCount: number;
  readonly warnings: readonly string[];
  readonly errorCode: string | null;
  readonly message: string;
}

export interface DesktopPublishRequest {
  readonly publishMode?: import('../domain/types.js').PublishMode;
  readonly taskId: string;
  readonly attemptId: string;
  readonly contentHash: string;
  readonly accountId: string;
  readonly approvalId: string;
}

export interface DesktopPublishResult {
  readonly submitted: boolean;
  readonly verified: boolean;
  readonly uncertain: boolean;
  readonly screenshotPath: string | null;
  readonly verification: PublishVerification | null;
  readonly errorCode: string | null;
  readonly message: string;
}

export interface DesktopExecutor {
  health(): Promise<DesktopHealth>;
  status(): Promise<WechatClientStatus>;
  prepare(request: DesktopPrepareRequest): Promise<DesktopPrepareResult>;
  publish(request: DesktopPublishRequest): Promise<DesktopPublishResult>;
  verify(attemptId: string): Promise<PublishVerification>;
  cancel(attemptId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// 图像 Provider
// ---------------------------------------------------------------------------

export interface ImageGenerationRequest {
  readonly operation?: 'generate' | 'edit';
  readonly taskId: string;
  readonly prompt: string;
  readonly negativePrompt: string;
  readonly aspectRatio: string;
  readonly resolution: string;
  readonly referenceImages: readonly string[];
  readonly styleProfile: string;
  readonly privacyLevel: 'public' | 'private';
  readonly targetProvider: ImageProviderKind;
  readonly maxAttempts: number;
  readonly signal?: AbortSignal;
}

export interface GeneratedImage {
  readonly bytes: Uint8Array;
  readonly mime: string;
  readonly prompt: string;
  readonly provider: string;
  readonly model: string;
  readonly license: string;
  readonly metadata?: Record<string, unknown>;
}

export interface ImageGenerationResult {
  readonly provider: string;
  readonly model: string;
  readonly status: 'ready' | 'awaiting_user' | 'unavailable' | 'failed' | 'cancelled';
  readonly images: readonly GeneratedImage[];
  readonly errorCode: string | null;
  readonly requiresUserAction: boolean;
  readonly usageMetadata?: Record<string, unknown>;
  readonly message: string;
}

export interface ImageProviderCapabilities {
  readonly available: boolean;
  readonly provider: ImageProviderKind;
  readonly requiresUserAction: boolean;
  readonly supportsEdit: boolean;
  readonly supportsGeneration: boolean;
  readonly reasons: readonly string[];
}

export interface ImageProvider {
  readonly id: ImageProviderKind;
  checkCapabilities(): Promise<ImageProviderCapabilities>;
  generate(request: ImageGenerationRequest): Promise<ImageGenerationResult>;
  edit(request: ImageGenerationRequest): Promise<ImageGenerationResult>;
  getStatus(taskId: string): Promise<ImageGenerationResult | null>;
  cancel(taskId: string): Promise<boolean>;
}

/** 素材落盘与审核。Provider 只返回字节，持久化由 AssetStore 统一完成。 */
export interface AssetImporter {
  importBytes(input: {
    bytes: Uint8Array;
    declaredMime: string;
    source: MediaAssetRecord['source'];
    license: string;
    prompt: string;
    provider: string;
    model: string;
    imageTaskId?: string | null;
    originalFileName?: string;
  }): Promise<{ asset: MediaAssetRecord; duplicate: boolean }>;
}

export interface ImageReviewOutcome {
  readonly assetId: string;
  readonly passed: boolean;
  readonly flags: readonly string[];
  readonly notes: readonly string[];
  readonly report: Record<string, unknown>;
}

/**
 * 图像子系统门面。运行时只依赖该接口，便于用 Fake 实现做集成测试。
 * 真实实现由 src/image/index.ts 组装。
 */
export interface ImageFacade {
  listCapabilities(): Promise<ImageProviderCapabilities[]>;
  generate(request: ImageGenerationRequest): Promise<{
    result: ImageGenerationResult;
    assets: readonly MediaAssetRecord[];
  }>;
  importFromPath(input: {
    path: string;
    source: MediaAssetRecord['source'];
    license: string;
    prompt: string;
    provider: string;
    model: string;
    declaredMime?: string;
    imageTaskId?: string | null;
  }): Promise<{ asset: MediaAssetRecord; duplicate: boolean }>;
  importBytes(input: {
    bytes: Uint8Array;
    declaredMime: string;
    source: MediaAssetRecord['source'];
    license: string;
    prompt: string;
    provider: string;
    model: string;
    imageTaskId?: string | null;
    originalFileName?: string;
  }): Promise<{ asset: MediaAssetRecord; duplicate: boolean }>;
  reviewAsset(
    assetId: string,
    options?: { text?: string; declaredMime?: string },
  ): Promise<ImageReviewOutcome>;
}

// ---------------------------------------------------------------------------
// 审批通道
// ---------------------------------------------------------------------------

export interface OwnerCommand {
  readonly raw: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly message: OwnerMessage;
}

export interface OwnerChannel {
  readonly name: string;
  checkHealth(): Promise<AdapterHealth>;
  /** 发送审批请求（文案 + 任务 ID + 过期时间），不包含图片二进制。 */
  sendApprovalRequest(request: ApprovalRequestView): Promise<{ delivered: boolean; messageId?: string }>;
  sendText(text: string): Promise<WechatSendResult>;
  listOwnerMessages(limit: number): Promise<OwnerMessage[]>;
  /** 当前通道对应的账号标识；必须与审批绑定的 accountId 一致。 */
  currentAccountId(): Promise<string | null>;
}
