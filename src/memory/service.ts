/**
 * 社交记忆服务：群聊 / 私聊 → 匿名人物印象 → 朋友圈弱参考。
 *
 * 隐私边界（硬约束）：
 * - 真实昵称 / wxid / 原始会话名只保存在本机数据库与本机所有者视图；
 *   模型提示词只出现 `群聊A` / `群友B` / `对方` 这类匿名别名；
 * - 聊天正文入库前经 `redactChatText` 脱敏，且总是用 `wrapUntrusted` 包裹后送模型；
 * - 模型输出（印象字段）重新校验结构、剥离 URL、扫描注入，再经本地泄漏门禁；
 * - 日志与错误只记录标签、计数、错误码，不写聊天内容 / 昵称。
 *
 * 失败降级：
 * - `enabled=false` 时 `sync` 抛 CHAT_MEMORY_DISABLED，`maybeAutoSync` 静默返回；
 * - WeChatAgent 不可用：同步整体失败（WECHAT_UNAVAILABLE），自动同步只记日志；
 * - 单个会话读取 / 处理失败：记入 `skipped` 并继续，不影响其它会话；
 * - LLM 提炼失败：保留已有印象，本次只入库消息，记入 `errors`。
 */
import type { ChatMemoryConfig } from '../config.js';
import { newId, sha256Hex } from '../domain/ids.js';
import { MomentsError } from '../domain/result.js';
import type {
  ChatConversationRecord,
  ChatMemoryAgentConversationView,
  ChatMemoryAgentView,
  ChatMemorySettingsView,
  ChatMemoryStats,
  ChatMemoryView,
  ChatSyncResult,
  ChatSyncSkip,
  MemberImpressionPatch,
  MemberImpressionRecord,
  MemberImpressionStatus,
} from '../domain/types.js';
import type {
  LlmClient,
  Logger,
  WeChatAgentAdapter,
  WechatChatMessage,
  WechatConversation,
} from '../adapters/types.js';
import type { ChatMessageInput, MemberImpressionInput, MomentsStore } from '../storage/store.js';
import { allocateConversationLabel, allocateMemberAlias } from './alias.js';
import { ChatPrivacyGuard, findChatLeak, type ChatLeakContext } from './guard.js';
import { buildHeuristicImpressions } from './heuristics.js';
import type { ChatExtractionMessage, ExtractedMemberImpression, ExistingImpressionBrief } from './impression-builder.js';
import { ImpressionBuilder, isControlledTrait } from './impression-builder.js';
import { addDaysIso, mergeImpression } from './merge.js';
import { redactChatText } from './redaction.js';

const MAX_CONVERSATIONS = 50;
const MAX_MEMBER_SCAN = 500;
/** 泄漏门禁的全局消息池上限（跨会话最近入库的条数）。 */
const GUARD_MESSAGE_LIMIT = 1000;
const MAX_SIGNALS = 4;
const MAX_SIGNAL_LENGTH = 200;
const MAX_COMPOSE_BRIEF_LENGTH = 2000;
const RECENT_SIGNAL_DAYS = 7;
const MAX_ALIAS_LENGTH = 8;
const ALIAS_PATTERN = /^[\u4e00-\u9fa5A-Za-z0-9_-]{1,8}$/;
const URL_PATTERN = /\b(?:https?:\/\/|www\.)\S+/gi;

/** `conversation_key`：sha256("chat:" + accountId + ":" + talker) 前 24 位。 */
export function chatConversationKey(accountId: string, talker: string): string {
  return sha256Hex(`chat:${accountId}:${talker}`).slice(0, 24);
}

/** `member_ref`：sha256("member:" + talker + ":" + senderWxid) 前 20 位。 */
export function chatMemberRef(talker: string, senderWxid: string): string {
  return sha256Hex(`member:${talker}:${senderWxid}`).slice(0, 20);
}

/** `message_id`：sha256(conversationKey + ":" + 适配器消息 ID) 前 32 位，用于幂等去重。 */
export function chatMessageId(conversationKey: string, adapterMessageId: string): string {
  return sha256Hex(`${conversationKey}:${adapterMessageId}`).slice(0, 32);
}

export interface ChatMemoryServiceDeps {
  readonly store: MomentsStore;
  /** 运行时读取，支持管理页热更新。 */
  readonly config: () => ChatMemoryConfig;
  readonly wechat: () => WeChatAgentAdapter | null;
  readonly llm: LlmClient;
  readonly logger: Logger;
  readonly clock?: () => Date;
}

export interface ChatSyncOptions {
  readonly force?: boolean;
  /** 文档契约字段：只同步指定会话；不传 = 全部白名单内会话。 */
  readonly conversationKeys?: readonly string[];
}

/**
 * 社交记忆门面。所有方法都假定调用方已校验 `chatMemory.enabled`（sync 除外，它自己校验）。
 */
export class ChatMemoryService {
  private readonly store: MomentsStore;
  private readonly config: () => ChatMemoryConfig;
  private readonly wechat: () => WeChatAgentAdapter | null;
  private readonly logger: Logger;
  private readonly clock: () => Date;
  private readonly builder: ImpressionBuilder;
  private readonly guard: ChatPrivacyGuard;

  constructor(deps: ChatMemoryServiceDeps) {
    this.store = deps.store;
    this.config = deps.config;
    this.wechat = deps.wechat;
    this.logger = deps.logger;
    this.clock = deps.clock ?? (() => new Date());
    this.builder = new ImpressionBuilder(deps.llm, deps.logger);
    this.guard = new ChatPrivacyGuard(() => this.leakContext());
  }

  enabled(): boolean {
    return this.config().enabled;
  }

  // -------------------------------------------------------------------------
  // 同步
  // -------------------------------------------------------------------------

  async sync(options: ChatSyncOptions = {}): Promise<ChatSyncResult> {
    const config = this.config();
    if (!config.enabled) {
      throw new MomentsError('CHAT_MEMORY_DISABLED', '社交记忆未启用（chatMemory.enabled=false）');
    }
    const wechat = this.wechat();
    if (wechat === null) {
      throw new MomentsError('WECHAT_UNAVAILABLE', '微信读取通道不可用，无法同步社交记忆', { retryable: true });
    }

    const now = this.clock();
    const nowIso = now.toISOString();
    const skipped: ChatSyncSkip[] = [];
    const errors: string[] = [];
    let conversations = 0;
    let newMessages = 0;
    let impressionsUpdated = 0;

    const pruned = this.cleanupExpired(nowIso);
    if (pruned > 0) this.logger.debug('社交记忆已清理过期数据', { removed: pruned });

    let account: { accountId: string; ownWxid: string } | null;
    try {
      account = await wechat.getAccount();
    } catch (error) {
      throw new MomentsError('WECHAT_UNAVAILABLE', '微信账号读取失败，无法同步社交记忆', {
        retryable: true,
        cause: error,
      });
    }
    if (account === null) {
      throw new MomentsError('WECHAT_ACCOUNT_NOT_VERIFIED', '微信账号未验证，无法同步社交记忆');
    }
    const accountId = account.accountId;

    let upstream: readonly WechatConversation[];
    try {
      upstream = await wechat.listConversations(MAX_CONVERSATIONS);
    } catch (error) {
      throw new MomentsError('WECHAT_UNAVAILABLE', '读取微信会话列表失败，无法同步社交记忆', {
        retryable: true,
        cause: error,
      });
    }

    const storedConversations = this.store.listChatConversations();
    const known = new Map(storedConversations.map((conversation) => [conversation.conversationKey, conversation]));
    const usedLabels = storedConversations.map((conversation) => conversation.label);
    const requestedKeys = options.conversationKeys === undefined ? null : new Set(options.conversationKeys);

    for (const remote of upstream.slice(0, MAX_CONVERSATIONS)) {
      const conversationKey = chatConversationKey(accountId, remote.talker);
      const existingConversation = known.get(conversationKey);
      if (!matchesWhitelist(config.conversations, remote.displayName, conversationKey)) {
        skipped.push({
          label: existingConversation?.label ?? '未匹配白名单的会话',
          reason: '不在 chatMemory.conversations 白名单内',
        });
        continue;
      }
      if (requestedKeys !== null && !requestedKeys.has(conversationKey)) {
        skipped.push({
          label: existingConversation?.label ?? '未指定的会话',
          reason: '不在本次同步范围内',
        });
        continue;
      }

      const label = existingConversation?.label ?? allocateConversationLabel(remote.kind, usedLabels);
      const enabled = remote.kind === 'private' ? config.includePrivate : true;
      let stored: ChatConversationRecord;
      try {
        stored = this.store.upsertChatConversation({
          conversationKey,
          kind: remote.kind,
          label,
          displayName: remote.displayName,
          talker: remote.talker,
          accountId,
          enabled,
        });
      } catch (error) {
        skipped.push({ label, reason: '会话入库失败' });
        this.logger.warn('社交记忆会话入库失败', { label, errorCode: errorCodeOf(error) });
        continue;
      }
      usedLabels.push(stored.label);
      known.set(conversationKey, stored);

      if (!enabled) {
        skipped.push({ label: stored.label, reason: '私聊未开启（chatMemory.includePrivate=false）' });
        continue;
      }

      let fetched: readonly WechatChatMessage[];
      try {
        fetched = await wechat.listConversationMessages(remote.talker, config.maxMessagesPerConversation);
      } catch (error) {
        skipped.push({ label: stored.label, reason: '读取会话消息失败' });
        this.logger.warn('社交记忆读取会话消息失败', { label: stored.label, errorCode: errorCodeOf(error) });
        continue;
      }

      try {
        const prepared = fetched
          .map((message) => this.prepareMessage(stored, message, now))
          .filter((message): message is ChatMessageInput => message !== null);
        conversations += 1;

        const previousIds = new Set(
          this.store
            .listChatMessages(stored.conversationKey, config.maxMessagesPerConversation)
            .map((message) => message.messageId),
        );
        const newOnes = prepared.filter((message) => !previousIds.has(message.messageId));
        const inserted = this.store.insertChatMessages(prepared);
        newMessages += inserted;

        if (inserted > 0) {
          const evidence = countEvidence(newOnes);
          impressionsUpdated += await this.updateConversationImpressions(stored, evidence, now, errors, config);
        }

        const lastMessageAt = prepared.reduce<string | null>(
          (latest, message) => (latest === null || message.sentAt > latest ? message.sentAt : latest),
          null,
        );
        this.store.markChatConversationSynced(stored.conversationKey, nowIso, lastMessageAt);
      } catch (error) {
        skipped.push({ label: stored.label, reason: '会话数据处理失败' });
        this.logger.warn('社交记忆会话数据处理失败', {
          label: stored.label,
          errorCode: errorCodeOf(error),
        });
      }
    }

    const result: ChatSyncResult = { conversations, newMessages, impressionsUpdated, skipped, errors };

    try {
      this.store.appendAudit({
        at: nowIso,
        actor: 'agent',
        action: 'chat_memory_synced',
        taskId: null,
        previousState: null,
        nextState: null,
        reason: '社交记忆同步完成',
        metadata: {
          conversations,
          newMessages,
          impressionsUpdated,
          skipped: skipped.length,
          errors: errors.length,
          pruned,
        },
      });
    } catch (error) {
      this.logger.warn('社交记忆同步审计写入失败', { errorCode: errorCodeOf(error) });
    }

    return result;
  }

  /** 自动同步：未启用 / 未配置微信 / 未到间隔时直接返回，任何错误只记日志。 */
  async maybeAutoSync(): Promise<void> {
    try {
      const config = this.config();
      if (!config.enabled) return;
      if (this.wechat() === null) return;
      const now = this.clock();
      const lastSyncedAt = this.latestSyncedAt();
      if (lastSyncedAt !== null) {
        const elapsed = now.getTime() - Date.parse(lastSyncedAt);
        if (Number.isFinite(elapsed) && elapsed < config.syncIntervalMinutes * 60 * 1000) return;
      }
      await this.sync();
    } catch (error) {
      this.logger.warn('社交记忆自动同步失败', { errorCode: errorCodeOf(error) });
    }
  }

  // -------------------------------------------------------------------------
  // 视图
  // -------------------------------------------------------------------------

  /** 所有者视图：含真实昵称，只允许本机管理面使用。 */
  view(): ChatMemoryView {
    const config = this.config();
    const nowIso = this.clock().toISOString();
    const conversations = this.store.listChatConversations().map((conversation) => ({
      conversation,
      members: this.store.listMemberImpressions(conversation.conversationKey, MAX_MEMBER_SCAN, { nowIso }),
    }));
    return {
      enabled: config.enabled,
      settings: this.settingsView(config),
      stats: this.stats(),
      conversations,
    };
  }

  /** Agent 视图：只有会话标签、别名、摘要/标签/话题，不含真实昵称、wxid 与聊天原文。 */
  agentView(): ChatMemoryAgentView {
    const config = this.config();
    const stats = this.stats();
    if (!config.enabled) {
      return { enabled: false, stats, conversations: [], signals: [] };
    }
    const now = this.clock();
    const nowIso = now.toISOString();
    const context = this.leakContext();
    const conversations: ChatMemoryAgentConversationView[] = [];
    for (const conversation of this.store.listChatConversations({ enabledOnly: true })) {
      const members = this.store
        .listMemberImpressions(conversation.conversationKey, MAX_MEMBER_SCAN, { nowIso })
        .slice(0, config.maxMembersPerConversation)
        .map((member) => ({
          impressionId: member.impressionId,
          ...this.sanitizeAgentBrief(
            {
              alias: member.alias,
              summary: member.summary,
              traits: member.traits,
              topics: member.topics,
              style: member.style,
            },
            context,
            member.impressionId,
          ),
          confidence: member.confidence,
          evidenceCount: member.evidenceCount,
          status: member.status,
        }));
      conversations.push({
        conversationKey: conversation.conversationKey,
        label: conversation.label,
        kind: conversation.kind,
        lastSyncedAt: conversation.lastSyncedAt,
        members,
      });
    }
    return { enabled: true, stats, conversations, signals: this.ideaSignals(now) };
  }

  // -------------------------------------------------------------------------
  // 人物印象修正 / 删除
  // -------------------------------------------------------------------------

  updateMember(
    impressionId: string,
    patch: MemberImpressionPatch,
    actor: 'owner' | 'agent',
  ): MemberImpressionRecord {
    if (!this.config().enabled) {
      throw new MomentsError('CHAT_MEMORY_DISABLED', '社交记忆未启用（chatMemory.enabled=false）');
    }
    const existing = this.store.getMemberImpression(impressionId);
    if (existing === undefined) throw new MomentsError('NOT_FOUND', '人物印象不存在');
    const now = this.clock();
    const nowIso = now.toISOString();
    const expiresAt = addDaysIso(now, this.config().impressionTtlDays);

    const updated =
      actor === 'owner'
        ? this.buildOwnerUpdate(existing, patch, nowIso, expiresAt)
        : this.buildAgentUpdate(existing, patch, nowIso, expiresAt);
    if (updated === null) return existing;
    return this.store.upsertMemberImpression(updated);
  }

  deleteMember(impressionId: string): void {
    const existing = this.store.getMemberImpression(impressionId);
    if (existing === undefined) throw new MomentsError('NOT_FOUND', '人物印象不存在');
    this.store.deleteMemberImpression(impressionId);
  }

  // -------------------------------------------------------------------------
  // 数据清理
  // -------------------------------------------------------------------------

  purgeConversation(conversationKey: string): { messages: number; members: number } {
    const messages = this.store.countChatMessages(conversationKey);
    const members = this.store.countMemberImpressions(conversationKey);
    this.store.deleteChatConversation(conversationKey);
    return { messages, members };
  }

  purgeAll(): void {
    this.store.purgeChatMemory();
  }

  // -------------------------------------------------------------------------
  // 弱参考注入
  // -------------------------------------------------------------------------

  /** 匿名聊天信号（≤4 条）：只用会话标签 + 活跃度/氛围 + 话题/标签。 */
  ideaSignals(now: Date = this.clock()): string[] {
    const config = this.config();
    if (!config.enabled) return [];
    const nowIso = now.toISOString();
    const sinceIso = new Date(now.getTime() - RECENT_SIGNAL_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const context = this.leakContext();
    const conversations = this.store.listChatConversations({ enabledOnly: true });
    const labelByKey = new Map(conversations.map((conversation) => [conversation.conversationKey, conversation.label]));
    const signals: string[] = [];

    for (const conversation of conversations) {
      const messages = this.store
        .listChatMessages(conversation.conversationKey, config.maxMessagesPerConversation)
        .filter((message) => message.sentAt >= sinceIso && message.sentAt <= nowIso);
      if (messages.length === 0) continue;
      const activeMembers = new Set(messages.filter((message) => !message.isSelf).map((message) => message.memberRef)).size;
      const selfCount = messages.filter((message) => message.isSelf).length;
      const parts = [`${conversation.label} 近 ${RECENT_SIGNAL_DAYS} 天有 ${messages.length} 条交流`];
      if (activeMembers > 0) parts.push(`${activeMembers} 位成员参与`);
      if (selfCount > 0) parts.push(`其中本人 ${selfCount} 条`);
      parts.push(describeAtmosphere(messages));
      signals.push(clampSignal(parts.join('，')));
    }

    for (const impression of this.store.listTopMemberImpressions(nowIso, 8)) {
      const label = labelByKey.get(impression.conversationKey);
      if (label === undefined) continue;
      const focus = impression.topics.length > 0 ? impression.topics.slice(0, 2) : impression.traits.slice(0, 2);
      if (focus.length === 0) continue;
      signals.push(clampSignal(`${label} 的 ${impression.alias} 近期更关注：${focus.join('、')}`));
    }

    return signals.filter((signal) => findChatLeak(signal, context).length === 0).slice(0, MAX_SIGNALS);
  }

  /** 匿名社交氛围 + 人物印象（≤2000 字），供文案创作弱参考。 */
  composeBrief(now: Date = this.clock()): string {
    const config = this.config();
    if (!config.enabled) return '';
    const nowIso = now.toISOString();
    const context = this.leakContext();
    const conversations = this.store.listChatConversations({ enabledOnly: true });
    const labelByKey = new Map(conversations.map((conversation) => [conversation.conversationKey, conversation.label]));
    const signals = this.ideaSignals(now);
    const impressions = this.store
      .listTopMemberImpressions(nowIso, 12)
      .filter((impression) => labelByKey.has(impression.conversationKey));

    const lines: string[] = [];
    let hasContent = false;
    if (signals.length > 0) {
      lines.push(`## 匿名社交氛围（${conversations.length} 个会话，仅作弱参考）`);
      for (const signal of signals) lines.push(`- ${signal}`);
      hasContent = true;
    }
    if (impressions.length > 0) {
      const memberLines: string[] = [];
      for (const impression of impressions) {
        const label = labelByKey.get(impression.conversationKey) ?? '';
        const parts: string[] = [];
        if (impression.summary !== '') parts.push(impression.summary);
        if (impression.traits.length > 0) parts.push(`标签：${impression.traits.join('、')}`);
        if (impression.topics.length > 0) parts.push(`话题：${impression.topics.slice(0, 4).join('、')}`);
        if (impression.style !== '') parts.push(`风格：${impression.style}`);
        if (parts.length === 0) continue;
        const line = `- ${label} / ${impression.alias}：${parts.join('；')}`;
        if (findChatLeak(line, context).length > 0) continue;
        memberLines.push(line);
      }
      if (memberLines.length > 0) {
        if (hasContent) lines.push('');
        lines.push('## 匿名人物印象（互动倾向，仅作弱参考）');
        lines.push(...memberLines);
        hasContent = true;
      }
    }
    if (!hasContent) return '';

    lines.push(
      '',
      '使用规则：以上只是匿名氛围与互动倾向，只能作为弱参考；不得引用聊天原文、真实昵称或具体人物身份，也不得据此编造亲身经历。',
    );
    const brief = lines.join('\n');
    if (brief.length <= MAX_COMPOSE_BRIEF_LENGTH) return brief;
    return `${brief.slice(0, MAX_COMPOSE_BRIEF_LENGTH - 1)}…`;
  }

  /** 硬门禁：内容含真实昵称 / 聊天原文片段 / 隐私信息时抛 CHAT_PRIVACY_LEAK。 */
  assertNoLeak(text: string, where: string): void {
    this.guard.assertNoLeak(text, where);
  }

  // -------------------------------------------------------------------------
  // 内部实现
  // -------------------------------------------------------------------------

  private prepareMessage(
    conversation: ChatConversationRecord,
    message: WechatChatMessage,
    now: Date,
  ): ChatMessageInput | null {
    const text = redactChatText(typeof message.text === 'string' ? message.text : '');
    if (text === '') return null;
    const sentAt = normalizeIso(message.sentAt);
    if (sentAt === null) return null;
    const expiresAt = addDaysIso(now, this.config().retentionDays);
    return {
      messageId: chatMessageId(conversation.conversationKey, String(message.messageId)),
      conversationKey: conversation.conversationKey,
      memberRef: chatMemberRef(conversation.talker, typeof message.senderWxid === 'string' ? message.senderWxid : ''),
      senderName: typeof message.senderName === 'string' ? message.senderName.trim().slice(0, 64) : '',
      text,
      sentAt,
      isSelf: message.isSelf === true,
      ingestedAt: now.toISOString(),
      expiresAt,
    };
  }

  private async updateConversationImpressions(
    conversation: ChatConversationRecord,
    evidence: ReadonlyMap<string, number>,
    now: Date,
    errors: string[],
    config: ChatMemoryConfig,
  ): Promise<number> {
    const recent = [
      ...this.store.listChatMessages(conversation.conversationKey, config.maxMessagesPerConversation),
    ].reverse();
    if (recent.length === 0) return 0;

    const memberOrder: string[] = [];
    const memberInfo = new Map<string, { senderName: string; texts: string[]; lastSentAt: string | null }>();
    for (const message of recent) {
      if (message.isSelf) continue;
      const info = memberInfo.get(message.memberRef);
      if (info === undefined) {
        if (memberInfo.size >= config.maxMembersPerConversation) continue;
        memberInfo.set(message.memberRef, {
          senderName: message.senderName,
          texts: [message.text],
          lastSentAt: message.sentAt,
        });
        memberOrder.push(message.memberRef);
      } else {
        info.texts.push(message.text);
        if (info.senderName === '' && message.senderName !== '') info.senderName = message.senderName;
        if (info.lastSentAt === null || message.sentAt > info.lastSentAt) info.lastSentAt = message.sentAt;
      }
    }
    const targets = memberOrder.filter((memberRef) => (evidence.get(memberRef) ?? 0) > 0);
    if (targets.length === 0) return 0;

    const existingList = this.store.listMemberImpressions(conversation.conversationKey, MAX_MEMBER_SCAN, {
      includeExpired: true,
    });
    const existingByRef = new Map(existingList.map((item) => [item.memberRef, item]));

    // 稳定别名：已有印象保留原别名，新成员按最大序号 +1 分配。
    const usedAliases = existingList.map((item) => item.alias);
    const aliasByRef = new Map<string, string>();
    for (const memberRef of memberOrder) {
      const existingAlias = existingByRef.get(memberRef)?.alias;
      if (existingAlias !== undefined) {
        aliasByRef.set(memberRef, existingAlias);
        continue;
      }
      const alias = allocateMemberAlias(conversation.kind, usedAliases);
      usedAliases.push(alias);
      aliasByRef.set(memberRef, alias);
    }

    const extractionMessages: ChatExtractionMessage[] = [];
    for (const message of recent) {
      if (message.isSelf) {
        extractionMessages.push({
          memberRef: message.memberRef,
          alias: '',
          text: message.text,
          sentAt: message.sentAt,
          isSelf: true,
        });
        continue;
      }
      const alias = aliasByRef.get(message.memberRef);
      if (alias === undefined) continue;
      extractionMessages.push({
        memberRef: message.memberRef,
        alias,
        text: message.text,
        sentAt: message.sentAt,
        isSelf: false,
      });
    }

    // 提炼提示词只使用通过泄漏检查的既有摘要/标签：owner 手填或历史数据里的真实身份不喂给模型。
    const localContext: ChatLeakContext = {
      realNames: [
        conversation.displayName,
        ...[...memberInfo.values()].map((info) => info.senderName),
        ...existingList.map((item) => item.displayName),
      ].filter((name) => name.trim().length >= 2),
      messageTexts: recent.map((message) => message.text),
    };
    const existingBriefs: ExistingImpressionBrief[] = targets
      .map((memberRef) => existingByRef.get(memberRef))
      .filter((item): item is MemberImpressionRecord => item !== undefined)
      .slice(0, 12)
      .map((item) => ({
        alias: this.isBriefSafe(item.alias, localContext) ? item.alias : `成员${item.impressionId.slice(-4)}`,
        summary: this.isBriefSafe(item.summary, localContext) ? item.summary : '',
        traits: item.traits.filter((trait) => this.isBriefSafe(trait, localContext)),
      }))
      .filter((item) => item.summary !== '' || item.traits.length > 0);

    const heuristicMembers = targets
      .map((memberRef) => ({
        memberRef,
        alias: aliasByRef.get(memberRef) ?? '',
        texts: memberInfo.get(memberRef)?.texts ?? [],
      }))
      .filter((member) => member.alias !== '');
    const heuristicByRef = new Map(
      buildHeuristicImpressions({
        conversationLabel: conversation.label,
        kind: conversation.kind,
        members: heuristicMembers,
      }).map((item) => [item.memberRef, item]),
    );

    let llmResults: ExtractedMemberImpression[] = [];
    if (config.useLlmExtraction) {
      try {
        llmResults = await this.builder.build({
          conversationLabel: conversation.label,
          kind: conversation.kind,
          messages: extractionMessages,
          existing: existingBriefs,
        });
      } catch (error) {
        errors.push(`人物印象提炼失败（${conversation.label}）`);
        this.logger.warn('社交记忆人物印象提炼失败，保留既有印象', {
          label: conversation.label,
          errorCode: errorCodeOf(error),
        });
        return 0;
      }
    }
    const llmByRef = new Map<string, ExtractedMemberImpression>();
    for (const item of llmResults) {
      if (!llmByRef.has(item.memberRef)) llmByRef.set(item.memberRef, item);
    }

    let updated = 0;
    for (const memberRef of targets) {
      const info = memberInfo.get(memberRef);
      const alias = aliasByRef.get(memberRef);
      if (info === undefined || alias === undefined) continue;
      const existing = existingByRef.get(memberRef);
      const fallback = heuristicByRef.get(memberRef);
      let candidate = llmByRef.get(memberRef) ?? fallback;
      if (candidate === undefined) continue;
      const candidateText = `${candidate.summary}\n${candidate.style}\n${candidate.topics.join('\n')}`;
      if (findChatLeak(candidateText, localContext).length > 0) {
        if (fallback === undefined) continue;
        this.logger.debug('人物印象疑似包含隐私内容，回退为确定性统计', { label: conversation.label });
        candidate = fallback;
      }

      const merged = mergeImpression({
        existing,
        extracted: candidate,
        alias,
        displayName: info.senderName,
        evidenceIncrement: evidence.get(memberRef) ?? 0,
        lastSeenAt: info.lastSentAt,
        now,
        impressionTtlDays: config.impressionTtlDays,
      });
      const record: MemberImpressionInput = {
        ...merged,
        impressionId: existing?.impressionId ?? newId('imp'),
        conversationKey: conversation.conversationKey,
        memberRef,
      };
      this.store.upsertMemberImpression(record);
      updated += 1;
    }
    return updated;
  }

  private buildOwnerUpdate(
    existing: MemberImpressionRecord,
    patch: MemberImpressionPatch,
    nowIso: string,
    expiresAt: string,
  ): MemberImpressionInput | null {
    let alias = existing.alias;
    let summary = existing.summary;
    let traits = [...existing.traits];
    let topics = [...existing.topics];
    let style = existing.style;
    let status = existing.status;
    let evidenceCount = existing.evidenceCount;
    let changed = false;

    if (patch.alias !== undefined) {
      const value = normalizeAliasInput(patch.alias);
      if (value !== existing.alias) {
        this.assertAliasAvailable(existing, value);
        alias = value;
        changed = true;
      }
    }
    if (patch.summary !== undefined) {
      const value = normalizeTextInput(patch.summary, 300, '印象摘要', false);
      if (value !== summary) {
        summary = value;
        changed = true;
      }
    }
    if (patch.style !== undefined) {
      const value = normalizeTextInput(patch.style, 120, '说话风格', true);
      if (value !== style) {
        style = value;
        changed = true;
      }
    }
    if (patch.traits !== undefined) {
      const value = normalizeStringArray(patch.traits, 6, 12, '标签');
      if (!arraysEqual(value, traits)) {
        traits = value;
        changed = true;
      }
    }
    if (patch.topics !== undefined) {
      const value = normalizeStringArray(patch.topics, 8, 16, '话题');
      if (!arraysEqual(value, topics)) {
        topics = value;
        changed = true;
      }
    }
    if (patch.status !== undefined) {
      const value = normalizeStatus(patch.status);
      if (value !== status) {
        status = value;
        changed = true;
      }
    }
    if (patch.evidenceCount !== undefined) {
      const value = normalizeEvidenceCount(patch.evidenceCount);
      if (value !== evidenceCount) {
        evidenceCount = value;
        changed = true;
      }
    }
    if (!changed) return null;
    const findings = this.findLeak([alias, summary, style, ...traits, ...topics].join('\n'));
    if (findings.length > 0) {
      // 所有者手填内容同样不能把真实昵称/聊天原文带进提示词与工具返回值。
      throw new MomentsError('CHAT_PRIVACY_LEAK', '人物印象包含聊天隐私信息，已拒绝保存', {
        details: { reasons: findings },
      });
    }
    if (patch.status === undefined) status = 'owner_edited';

    return {
      impressionId: existing.impressionId,
      conversationKey: existing.conversationKey,
      memberRef: existing.memberRef,
      alias,
      displayName: existing.displayName,
      summary,
      traits,
      topics,
      style,
      confidence: existing.confidence,
      evidenceCount,
      status,
      source: 'owner',
      firstSeenAt: existing.firstSeenAt,
      lastSeenAt: existing.lastSeenAt,
      updatedAt: nowIso,
      expiresAt,
    };
  }

  private buildAgentUpdate(
    existing: MemberImpressionRecord,
    patch: MemberImpressionPatch,
    nowIso: string,
    expiresAt: string,
  ): MemberImpressionInput | null {
    // Agent 只能追加摘要 / 标签 / 话题 / 风格；alias / status / evidenceCount 一律忽略。
    let summary = existing.summary;
    let traits = [...existing.traits];
    let topics = [...existing.topics];
    let style = existing.style;
    let changed = false;

    if (patch.summary !== undefined) {
      const value = sanitizeAgentText(patch.summary, 300, '印象摘要', false);
      if (value !== summary) {
        summary = value;
        changed = true;
      }
    }
    if (patch.style !== undefined) {
      const value = sanitizeAgentText(patch.style, 120, '说话风格', true);
      if (value !== style) {
        style = value;
        changed = true;
      }
    }
    if (patch.traits !== undefined) {
      const value = sanitizeAgentTraits(patch.traits);
      if (!arraysEqual(value, traits)) {
        traits = value;
        changed = true;
      }
    }
    if (patch.topics !== undefined) {
      const value = sanitizeAgentTopics(patch.topics);
      if (!arraysEqual(value, topics)) {
        topics = value;
        changed = true;
      }
    }
    if (!changed) return null;

    const findings = this.findLeak([summary, style, ...traits, ...topics].join('\n'));
    if (findings.length > 0) {
      throw new MomentsError('CHAT_PRIVACY_LEAK', 'Agent 提交的印象包含聊天隐私信息，已拒绝', {
        details: { reasons: findings },
      });
    }

    return {
      impressionId: existing.impressionId,
      conversationKey: existing.conversationKey,
      memberRef: existing.memberRef,
      alias: existing.alias,
      displayName: existing.displayName,
      summary,
      traits,
      topics,
      style,
      confidence: existing.confidence,
      evidenceCount: existing.evidenceCount,
      status: existing.status,
      source: 'agent',
      firstSeenAt: existing.firstSeenAt,
      lastSeenAt: existing.lastSeenAt,
      updatedAt: nowIso,
      expiresAt,
    };
  }

  private assertAliasAvailable(existing: MemberImpressionRecord, alias: string): void {
    const others = this.store.listMemberImpressions(existing.conversationKey, MAX_MEMBER_SCAN, { includeExpired: true });
    const conflict = others.find((item) => item.memberRef !== existing.memberRef && item.alias === alias);
    if (conflict !== undefined) {
      throw new MomentsError('INVALID_INPUT', '该别名已被同一会话中的其他成员占用');
    }
  }

  private findLeak(text: string): string[] {
    return findChatLeak(text, this.leakContext());
  }

  private cleanupExpired(nowIso: string): number {
    let removed = 0;
    try {
      removed += this.store.pruneChatMessages(nowIso);
    } catch (error) {
      this.logger.warn('清理过期聊天消息失败', { errorCode: errorCodeOf(error) });
    }
    try {
      const expired = this.store
        .listMemberImpressions(undefined, MAX_MEMBER_SCAN, { includeExpired: true })
        .filter((item) => item.expiresAt < nowIso);
      for (const item of expired) {
        try {
          this.store.deleteMemberImpression(item.impressionId);
          removed += 1;
        } catch {
          // 单条清理失败不打断同步
        }
      }
    } catch (error) {
      this.logger.warn('清理过期人物印象失败', { errorCode: errorCodeOf(error) });
    }
    return removed;
  }

  /**
   * 泄漏门禁的本地上下文。
   *
   * 文本池用「跨会话最近 GUARD_MESSAGE_LIMIT 条」而不是按会话各取一段，避免老会话的
   * 独特原话因截断而漏检。读取失败时返回 degraded=true，让门禁 fail-closed。
   */
  private leakContext(): ChatLeakContext {
    const names = new Set<string>();
    const texts: string[] = [];
    let degraded = false;
    try {
      for (const conversation of this.store.listChatConversations()) {
        addName(names, conversation.displayName);
        if (conversation.talker.length >= 10) addName(names, conversation.talker);
      }
      for (const message of this.store.listRecentChatMessages(GUARD_MESSAGE_LIMIT)) {
        addName(names, message.senderName);
        if (message.text !== '') texts.push(message.text);
      }
      for (const impression of this.store.listMemberImpressions(undefined, MAX_MEMBER_SCAN, { includeExpired: true })) {
        addName(names, impression.displayName);
      }
    } catch (error) {
      degraded = true;
      this.logger.warn('读取社交记忆泄漏门禁数据失败，门禁将 fail-closed', { errorCode: errorCodeOf(error) });
    }
    return {
      realNames: [...names].filter((name) => name.trim().length >= 2),
      messageTexts: texts.slice(0, GUARD_MESSAGE_LIMIT),
      ...(degraded ? { degraded: true } : {}),
    };
  }

  /** 字段是否可安全喂给模型：空字符串视为安全，非空且命中泄漏则不安全。 */
  private isBriefSafe(value: string, context: ChatLeakContext): boolean {
    return value === '' || findChatLeak(value, context).length === 0;
  }

  /**
   * Agent 可见摘要的字段级过滤：历史数据或所有者手填内容若含真实昵称/原文片段，
   * 从 Agent 视图（工具返回值）里剔除，避免模型看到身份信息。
   * 真实昵称/原文仍保留在本地所有者视图，供管理页辨认与修正。
   */
  private sanitizeAgentBrief(
    fields: {
      alias: string;
      summary: string;
      traits: readonly string[];
      topics: readonly string[];
      style: string;
    },
    context: ChatLeakContext,
    impressionId: string,
  ): { alias: string; summary: string; traits: string[]; topics: string[]; style: string } {
    return {
      alias: this.isBriefSafe(fields.alias, context) ? fields.alias : `成员${impressionId.slice(-4)}`,
      summary: this.isBriefSafe(fields.summary, context) ? fields.summary : '',
      style: this.isBriefSafe(fields.style, context) ? fields.style : '',
      traits: fields.traits.filter((item) => item !== '' && this.isBriefSafe(item, context)),
      topics: fields.topics.filter((item) => item !== '' && this.isBriefSafe(item, context)),
    };
  }

  private settingsView(config: ChatMemoryConfig): ChatMemorySettingsView {
    return {
      enabled: config.enabled,
      includePrivate: config.includePrivate,
      conversations: [...config.conversations],
      syncIntervalMinutes: config.syncIntervalMinutes,
      maxMessagesPerConversation: config.maxMessagesPerConversation,
      retentionDays: config.retentionDays,
      impressionTtlDays: config.impressionTtlDays,
      maxMembersPerConversation: config.maxMembersPerConversation,
      anonymizeInPrompts: config.anonymizeInPrompts,
      useLlmExtraction: config.useLlmExtraction,
    };
  }

  private stats(): ChatMemoryStats {
    const counts = this.store.chatMemoryCounts();
    let lastSyncedAt: string | null = null;
    for (const conversation of this.store.listChatConversations()) {
      if (conversation.lastSyncedAt === null) continue;
      if (lastSyncedAt === null || conversation.lastSyncedAt > lastSyncedAt) {
        lastSyncedAt = conversation.lastSyncedAt;
      }
    }
    return { ...counts, lastSyncedAt };
  }

  private latestSyncedAt(): string | null {
    let latest: string | null = null;
    for (const conversation of this.store.listChatConversations()) {
      if (conversation.lastSyncedAt === null) continue;
      if (latest === null || conversation.lastSyncedAt > latest) latest = conversation.lastSyncedAt;
    }
    return latest;
  }
}

// ---------------------------------------------------------------------------
// 纯函数工具
// ---------------------------------------------------------------------------

function matchesWhitelist(whitelist: readonly string[], displayName: string, conversationKey: string): boolean {
  if (whitelist.length === 0) return true;
  const name = displayName.trim();
  return whitelist.some((item) => {
    const value = item.trim();
    return value !== '' && (value === conversationKey || value === name);
  });
}

function countEvidence(messages: readonly ChatMessageInput[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const message of messages) {
    if (message.isSelf || message.memberRef === '') continue;
    counts.set(message.memberRef, (counts.get(message.memberRef) ?? 0) + 1);
  }
  return counts;
}

function describeAtmosphere(messages: readonly { text: string; isSelf: boolean }[]): string {
  const texts = messages.filter((message) => !message.isSelf).map((message) => message.text);
  if (texts.length === 0) return '以本人发言为主';
  const questions = texts.filter((text) => /[?？]|吗|怎么|为什么|如何/.test(text)).length;
  const playful = texts.filter((text) => /哈|233|笑死|😂|🤣/.test(text)).length;
  if (questions * 2 >= texts.length) return '提问与讨论较多';
  if (playful * 2 >= texts.length) return '气氛轻松、玩梗较多';
  return '以日常闲聊为主';
}

function clampSignal(signal: string): string {
  const compact = signal.replace(/\s+/g, ' ').trim();
  if (compact.length <= MAX_SIGNAL_LENGTH) return compact;
  return `${compact.slice(0, MAX_SIGNAL_LENGTH - 1)}…`;
}

function normalizeIso(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function addName(names: Set<string>, value: string): void {
  const name = value.trim();
  if (name !== '') names.add(name);
}

function errorCodeOf(error: unknown): string {
  if (error instanceof MomentsError) return error.code;
  if (error instanceof Error) return error.name;
  return 'unknown';
}

function normalizeAliasInput(value: unknown): string {
  if (typeof value !== 'string') throw new MomentsError('INVALID_INPUT', '别名必须是字符串');
  const alias = value.trim();
  if (!ALIAS_PATTERN.test(alias) || alias.length > MAX_ALIAS_LENGTH) {
    throw new MomentsError('INVALID_INPUT', '别名只能是 1~8 个中文/字母/数字/下划线');
  }
  return alias;
}

function normalizeTextInput(value: unknown, maxLength: number, label: string, allowEmpty: boolean): string {
  if (typeof value !== 'string') throw new MomentsError('INVALID_INPUT', `${label}必须是字符串`);
  const text = value.trim();
  if (!allowEmpty && text === '') throw new MomentsError('INVALID_INPUT', `${label}不能为空`);
  if (text.length > maxLength) throw new MomentsError('INVALID_INPUT', `${label}最多 ${maxLength} 字`);
  return text;
}

function normalizeStringArray(
  value: unknown,
  maxItems: number,
  maxItemLength: number,
  label: string,
): string[] {
  if (!Array.isArray(value)) throw new MomentsError('INVALID_INPUT', `${label}必须是字符串数组`);
  if (value.length > maxItems) throw new MomentsError('INVALID_INPUT', `${label}最多 ${maxItems} 个`);
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') throw new MomentsError('INVALID_INPUT', `${label}必须是字符串数组`);
    const text = item.trim();
    if (text === '' || text.length > maxItemLength) {
      throw new MomentsError('INVALID_INPUT', `${label}每项需为 1~${maxItemLength} 字`);
    }
    if (!items.includes(text)) items.push(text);
  }
  return items;
}

function normalizeStatus(value: unknown): MemberImpressionStatus {
  if (value === 'new' || value === 'observed' || value === 'owner_edited') return value;
  throw new MomentsError('INVALID_INPUT', '人物印象状态无效');
}

function normalizeEvidenceCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100_000) {
    throw new MomentsError('INVALID_INPUT', '证据条数必须是非负整数');
  }
  return value;
}

function sanitizeAgentText(value: unknown, maxLength: number, label: string, allowEmpty: boolean): string {
  if (typeof value !== 'string') throw new MomentsError('INVALID_INPUT', `${label}必须是字符串`);
  const compact = value
    .replace(URL_PATTERN, ' ')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!allowEmpty && compact === '') throw new MomentsError('INVALID_INPUT', `${label}不能为空`);
  if (compact.length > maxLength) throw new MomentsError('INVALID_INPUT', `${label}最多 ${maxLength} 字`);
  return compact;
}

function sanitizeAgentTraits(value: unknown): string[] {
  if (!Array.isArray(value)) throw new MomentsError('INVALID_INPUT', '标签必须是字符串数组');
  const traits: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trait = item.trim();
    if (!isControlledTrait(trait)) continue;
    if (!traits.includes(trait)) traits.push(trait);
    if (traits.length >= 6) break;
  }
  if (traits.length === 0 && value.length > 0) {
    throw new MomentsError('INVALID_INPUT', 'Agent 标签必须来自受控标签列表');
  }
  return traits;
}

function sanitizeAgentTopics(value: unknown): string[] {
  if (!Array.isArray(value)) throw new MomentsError('INVALID_INPUT', '话题必须是字符串数组');
  const topics: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const topic = item
      .replace(URL_PATTERN, ' ')
      .replace(/[\r\n]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, 16);
    if (topic === '' || topics.includes(topic)) continue;
    if (findChatLeakSignature(topic)) continue;
    topics.push(topic);
    if (topics.length >= 8) break;
  }
  return topics;
}

/** 轻量注入特征检查：不做完整门禁（话题类字段），只排除明显的注入样式。 */
function findChatLeakSignature(text: string): boolean {
  return /<\/?(?:system|assistant|tool|untrusted-data)[^>]*>|忽略(?:之前|以上|所有)/i.test(text);
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((item, index) => item === right[index]);
}
