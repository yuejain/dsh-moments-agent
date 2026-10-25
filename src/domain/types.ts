/**
 * Moments 领域模型。
 *
 * 命名约束：代码标识符、数据库字段使用英文；用户可见文案使用简体中文。
 * 所有时间字段为 ISO-8601 UTC 字符串，便于 SQLite 排序与跨时区换算。
 */

/** 发布工作流状态（持久化状态机唯一合法状态集合）。 */
export const MOMENT_STATES = [
  'IDEA_CREATED',
  'DRAFTING',
  'DRAFT_READY',
  'IMAGE_REQUIRED',
  'IMAGE_PENDING',
  'IMAGE_READY',
  'REVIEWING',
  'READY_FOR_APPROVAL',
  'READY_TO_PUBLISH',
  'APPROVED',
  'QUEUED',
  'PREPARING',
  'PREPARED',
  'PUBLISHING',
  'PUBLISHED',
  'UNCERTAIN',
  'FAILED',
  'CANCELLED',
  'EXPIRED',
] as const;

export type MomentState = (typeof MOMENT_STATES)[number];

/** 终态：不会再有普通状态迁移。 */
export const TERMINAL_STATES: readonly MomentState[] = [
  'PUBLISHED',
  'FAILED',
  'CANCELLED',
  'EXPIRED',
];

/** 允许人工核对后从 UNCERTAIN 收敛到的状态。 */
export type ManualResolution = 'PUBLISHED' | 'FAILED';

export type SourceType =
  | 'owner_topic'
  | 'saved_opinion'
  | 'public_news'
  | 'owner_article'
  | 'owner_image'
  | 'book_review'
  | 'film_review'
  | 'science_reflection'
  | 'history_extension'
  | 'creative_expression'
  | 'chat_signal'
  | 'manual';

export const SOURCE_TYPES: readonly SourceType[] = [
  'owner_topic',
  'saved_opinion',
  'public_news',
  'owner_article',
  'owner_image',
  'book_review',
  'film_review',
  'science_reflection',
  'history_extension',
  'creative_expression',
  'chat_signal',
  'manual',
];

/** 朋友圈可见范围。PARTIAL 需要单独的名单，MVP 仅在桌面执行器支持时启用。 */
export type Visibility = 'PUBLIC' | 'PRIVATE' | 'PARTIAL';
export const VISIBILITIES: readonly Visibility[] = ['PUBLIC', 'PRIVATE', 'PARTIAL'];

export type PublishMode = 'PREPARE_ONLY' | 'APPROVAL_REQUIRED' | 'POLICY_AUTONOMOUS';
export const PUBLISH_MODES: readonly PublishMode[] = [
  'PREPARE_ONLY',
  'APPROVAL_REQUIRED',
  'POLICY_AUTONOMOUS',
];

export type ApprovalStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'consumed'
  | 'superseded';

export type ApprovalChannel = 'wechat_owner' | 'manual_admin' | 'cli';

export type ImageTaskStatus =
  | 'PENDING'
  | 'AWAITING_USER'
  | 'GENERATING'
  | 'READY'
  | 'REVIEWING'
  | 'FAILED'
  | 'CANCELLED'
  | 'EXPIRED';

export type ImageProviderKind =
  | 'manual_subscription'
  | 'local_import'
  | 'local_generation'
  | 'official_api'
  | 'codex_subscription';

export type PublishAttemptState =
  | 'PLANNED'
  | 'PREPARING'
  | 'PREPARED'
  | 'PUBLISHING'
  | 'PUBLISHED'
  | 'UNCERTAIN'
  | 'VERIFIED'
  | 'FAILED'
  | 'CANCELLED';

export type RiskFlag =
  | 'PRIVACY_PERSONAL_INFO'
  | 'REAL_PERSON_CLAIM'
  | 'LOCATION_CLAIM'
  | 'UNVERIFIED_FACT'
  | 'SENSITIVE_TOPIC'
  | 'DUPLICATE_RECENT'
  | 'LOW_NOVELTY'
  | 'LOW_PERSONA_FIT'
  | 'SOURCE_MISSING'
  | 'PROMPT_INJECTION_SUSPECTED'
  | 'IMAGE_REAL_EVENT_MISMATCH'
  | 'MISLEADING_IMAGE'
  | 'IMAGE_LOW_QUALITY'
  | 'PERCEPTUAL_HASH_UNAVAILABLE';

export interface TaskRecord {
  readonly taskId: string;
  state: MomentState;
  readonly ideaId: string | null;
  draftId: string | null;
  visibility: Visibility;
  contentHash: string | null;
  assetManifestHash: string | null;
  accountId: string | null;
  approvalId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  readonly createdAt: string;
  updatedAt: string;
}

export interface IdeaRecord {
  readonly ideaId: string;
  readonly taskId: string;
  readonly topic: string;
  readonly motivation: string;
  readonly sourceType: SourceType;
  readonly sourceEvidence: string;
  readonly noveltyScore: number;
  readonly personaScore: number;
  readonly relevanceScore: number;
  readonly riskFlags: readonly RiskFlag[];
  readonly createdAt: string;
}

export interface IdeaScores {
  novelty: number;
  persona: number;
  relevance: number;
  expressionValue: number;
  emotionalValue: number;
  timeliness: number;
  duplicatePenalty: number;
}

export interface DraftRecord {
  readonly draftId: string;
  readonly taskId: string;
  readonly ideaId: string;
  version: number;
  text: string;
  tone: string;
  readonly createdAt: string;
  updatedAt: string;
}

export interface DraftVersionRecord {
  readonly draftId: string;
  readonly version: number;
  readonly text: string;
  readonly contentHash: string;
  readonly createdAt: string;
}

export interface ImageTaskRecord {
  readonly imageTaskId: string;
  readonly draftId: string;
  readonly taskId: string;
  readonly prompt: string;
  readonly negativePrompt: string;
  readonly aspectRatio: string;
  readonly resolution: string;
  readonly styleProfile: string;
  readonly provider: ImageProviderKind;
  status: ImageTaskStatus;
  requiresUserAction: boolean;
  attempts: number;
  lastError: string | null;
  readonly createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface MediaAssetRecord {
  readonly assetId: string;
  readonly sha256: string;
  readonly path: string;
  readonly mime: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly source: ImageProviderKind | 'owner_upload';
  readonly license: string;
  readonly prompt: string;
  readonly provider: string;
  readonly model: string;
  readonly imageTaskId: string | null;
  readonly perceptualHash: string | null;
  readonly createdAt: string;
}

export interface ImageReviewRecord {
  readonly assetId: string;
  readonly passed: boolean;
  readonly flags: readonly RiskFlag[];
  readonly report: ImageReviewReport;
  readonly reviewedAt: string;
}

export interface ImageReviewReport {
  readonly exists: boolean;
  readonly signatureMime: string | null;
  readonly declaredMime: string;
  readonly mimeMatched: boolean;
  readonly width: number;
  readonly height: number;
  readonly aspectRatio: number;
  readonly bytes: number;
  readonly sha256: string;
  readonly perceptualHash: string | null;
  readonly nearDuplicateOf: string | null;
  readonly relevantToText: boolean | null;
  readonly qualityScore: number;
  readonly notes: readonly string[];
}

export interface ApprovalRecord {
  readonly approvalId: string;
  readonly taskId: string;
  readonly ownerId: string;
  readonly contentHash: string;
  readonly assetManifestHash: string;
  readonly visibility: Visibility;
  readonly accountId: string;
  readonly nonce: string;
  status: ApprovalStatus;
  readonly channel: ApprovalChannel;
  readonly createdAt: string;
  readonly expiresAt: string;
  decidedAt: string | null;
  consumedAt: string | null;
}

export interface PublishAttemptRecord {
  readonly attemptId: string;
  readonly taskId: string;
  readonly approvalId: string | null;
  readonly idempotencyKey: string;
  readonly contentHash: string;
  readonly assetManifestHash: string;
  readonly accountId: string;
  state: PublishAttemptState;
  readonly mode: PublishMode;
  readonly createdAt: string;
  updatedAt: string;
  screenshotPath: string | null;
  verification: PublishVerification | null;
  errorCode: string | null;
}

export interface PublishVerification {
  readonly verified: boolean;
  readonly method: string;
  readonly publishedAt: string | null;
  readonly visibleText: string | null;
  readonly imageCount: number | null;
  readonly evidencePath: string | null;
  readonly notes: readonly string[];
}

export interface PublishedPostRecord {
  readonly postId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly text: string;
  readonly visibility: Visibility;
  readonly accountId: string;
  readonly contentHash: string;
  readonly publishedAt: string;
  readonly verified: boolean;
}

export interface PersonaMemoryRecord {
  readonly memoryId: string;
  readonly kind: 'persona' | 'episodic' | 'semantic' | 'operational';
  readonly key: string;
  readonly value: string;
  readonly createdAt: string;
  updatedAt: string;
}

export interface UserPreferenceRecord {
  readonly key: string;
  readonly value: string;
  readonly updatedAt: string;
}

// ---------------------------------------------------------------------------
// 社交记忆：群聊 / 私聊 → 人物印象
// ---------------------------------------------------------------------------

export type ChatConversationKind = 'group' | 'private';

/** 人物印象状态：证据不足待观察 / 已观察 / 所有者手工修正。 */
export type MemberImpressionStatus = 'new' | 'observed' | 'owner_edited';

export type MemberImpressionSource = 'auto' | 'owner' | 'agent';

export interface ChatConversationRecord {
  readonly conversationKey: string;
  readonly kind: ChatConversationKind;
  /** 匿名标签：群聊A / 私聊B，只用于提示词。 */
  readonly label: string;
  /** 真实群名或昵称，只在本地管理页展示。 */
  readonly displayName: string;
  /** 原始会话 ID，仅同步时使用；不进入提示词与管理 API。 */
  readonly talker: string;
  readonly accountId: string;
  readonly enabled: boolean;
  readonly lastSyncedAt: string | null;
  readonly lastMessageAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ChatMessageRecord {
  readonly messageId: string;
  readonly conversationKey: string;
  readonly memberRef: string;
  readonly senderName: string;
  /** 已脱敏文本；不保留图片、文件、语音。 */
  readonly text: string;
  readonly sentAt: string;
  readonly isSelf: boolean;
  readonly ingestedAt: string;
  readonly expiresAt: string;
}

export interface MemberImpressionRecord {
  readonly impressionId: string;
  readonly conversationKey: string;
  readonly memberRef: string;
  /** 提示词里使用的稳定别名。 */
  readonly alias: string;
  readonly displayName: string;
  readonly summary: string;
  readonly traits: readonly string[];
  readonly topics: readonly string[];
  readonly style: string;
  readonly confidence: number;
  readonly evidenceCount: number;
  readonly status: MemberImpressionStatus;
  readonly source: MemberImpressionSource;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string | null;
  readonly updatedAt: string;
  readonly expiresAt: string;
}

/** 社交记忆设置的可序列化视图（与 config.ChatMemoryConfig 结构一致，避免循环依赖）。 */
export interface ChatMemorySettingsView {
  readonly enabled: boolean;
  readonly includePrivate: boolean;
  readonly conversations: readonly string[];
  readonly syncIntervalMinutes: number;
  readonly maxMessagesPerConversation: number;
  readonly retentionDays: number;
  readonly impressionTtlDays: number;
  readonly maxMembersPerConversation: number;
  readonly anonymizeInPrompts: boolean;
  readonly useLlmExtraction: boolean;
}

export interface ChatSyncSkip {
  readonly label: string;
  readonly reason: string;
}

export interface ChatSyncResult {
  readonly conversations: number;
  readonly newMessages: number;
  readonly impressionsUpdated: number;
  readonly skipped: readonly ChatSyncSkip[];
  readonly errors: readonly string[];
}

export interface ChatMemoryStats {
  readonly conversations: number;
  readonly messages: number;
  readonly members: number;
  readonly lastSyncedAt: string | null;
}

export interface ChatMemoryConversationView {
  readonly conversation: ChatConversationRecord;
  readonly members: readonly MemberImpressionRecord[];
}

/** 所有者视图：含真实昵称，只用于本机管理页。 */
export interface ChatMemoryView {
  readonly enabled: boolean;
  readonly settings: ChatMemorySettingsView;
  readonly stats: ChatMemoryStats;
  readonly conversations: readonly ChatMemoryConversationView[];
}

export interface ChatMemoryAgentMemberView {
  readonly impressionId: string;
  readonly alias: string;
  readonly summary: string;
  readonly traits: readonly string[];
  readonly topics: readonly string[];
  readonly style: string;
  readonly confidence: number;
  readonly evidenceCount: number;
  readonly status: MemberImpressionStatus;
}

export interface ChatMemoryAgentConversationView {
  readonly conversationKey: string;
  readonly label: string;
  readonly kind: ChatConversationKind;
  readonly lastSyncedAt: string | null;
  readonly members: readonly ChatMemoryAgentMemberView[];
}

/** Agent 视图：只有别名与摘要，不含真实昵称、wxid、聊天原文。 */
export interface ChatMemoryAgentView {
  readonly enabled: boolean;
  readonly stats: ChatMemoryStats;
  readonly conversations: readonly ChatMemoryAgentConversationView[];
  readonly signals: readonly string[];
}

export interface MemberImpressionPatch {
  readonly alias?: string;
  readonly summary?: string;
  readonly traits?: readonly string[];
  readonly topics?: readonly string[];
  readonly style?: string;
  readonly status?: MemberImpressionStatus;
  /** 证据条数（owner 手工修正时可传；Agent 不允许）。 */
  readonly evidenceCount?: number;
}

export interface AuditEventRecord {
  readonly eventId: string;
  readonly at: string;
  readonly actor: string;
  readonly action: string;
  readonly taskId: string | null;
  readonly previousState: string | null;
  readonly nextState: string | null;
  readonly reason: string;
  readonly metadata: Record<string, unknown>;
}

export interface HealthSnapshot {
  readonly ok: boolean;
  readonly plugin: string;
  readonly version: string;
  readonly dshVersion: string | null;
  readonly database: 'ok' | 'degraded' | 'unavailable';
  readonly killSwitch: boolean;
  readonly paused: boolean;
  readonly publishMode: PublishMode;
  readonly scheduleEnabled: boolean;
  readonly wechatAgent: AdapterHealth;
  readonly desktopExecutor: AdapterHealth;
  readonly llm: AdapterHealth;
  readonly images: AdapterHealth;
  /** 社交记忆状态（可选：旧快照没有该字段）。 */
  readonly chatMemory?: AdapterHealth;
  readonly counts: Record<string, number>;
  readonly checkedAt: string;
}

export interface AdapterHealth {
  readonly status: 'ok' | 'degraded' | 'unavailable' | 'not_configured' | 'not_tested';
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

export interface PreviewPackage {
  readonly taskId: string;
  readonly state: MomentState;
  readonly text: string;
  readonly visibility: Visibility;
  readonly accountId: string | null;
  readonly contentHash: string;
  readonly assetManifestHash: string;
  readonly assets: readonly MediaAssetRecord[];
  readonly approvalRequired: boolean;
  readonly approvalId: string | null;
  readonly warnings: readonly string[];
}

export interface PublishDecision {
  readonly allowed: boolean;
  readonly code: string;
  readonly reason: string;
  readonly scores?: IdeaScores;
}

export interface ApprovalRequestView {
  readonly approvalId: string;
  readonly taskId: string;
  readonly contentHash: string;
  readonly visibility: Visibility;
  readonly expiresAt: string;
  readonly ownerMessage: string;
}
