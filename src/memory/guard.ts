/**
 * 聊天隐私泄漏门禁（硬门禁）。
 *
 * 选题、草稿、提示词摘要进入下一环节前必须通过本门禁。命中任一条件即抛
 * `MomentsError('CHAT_PRIVACY_LEAK')`，拒绝进入草稿 / 审批，而不是降级继续：
 *
 * 1. 包含任一真实昵称 / 群名（长度 ≥ 2，空白归一化后比较）；
 * 2. 包含任一入库聊天消息的 ≥ 8 字连续片段（防原话搬运）；
 * 3. 既有 `detectPrivacyRisks` 规则（手机号 / 证件 / 地址等）。
 *
 * 错误信息只保留 `where` 与命中的「原因类别」，绝不回显命中的昵称或片段。
 */
import { MomentsError } from '../domain/result.js';
import { detectPrivacyRisks } from '../security/prompt-injection.js';

/** 判定为「原文搬运」的最短连续片段长度。 */
export const MIN_COPY_FRAGMENT_LENGTH = 8;

export interface ChatLeakContext {
  /** 真实昵称 / 群名等本地身份信息（只在本机内存使用）。 */
  readonly realNames: readonly string[];
  /** 已脱敏入库的聊天文本（用于检测连续片段搬运）。 */
  readonly messageTexts: readonly string[];
  /**
   * 本地记忆上下文读取失败（数据库异常等）。为 true 时门禁 fail-closed：
   * 一律视为不可安全判断，阻止内容进入草稿/审批。
   */
  readonly degraded?: boolean;
}

/**
 * 返回命中的原因类别列表；空数组表示通过。
 * 只返回类别，不回显具体命中内容，便于安全地写日志与错误详情。
 */
export function findChatLeak(text: string, context: ChatLeakContext): string[] {
  if (text.trim() === '') return [];
  // fail-closed：连「真实昵称/原文」都读不到时，不能假装干净。
  if (context.degraded === true) return ['本地社交记忆上下文不可用'];
  const reasons: string[] = [];
  const normalized = normalizeForLeak(text);

  let nameHit = false;
  for (const name of context.realNames) {
    const normalizedName = normalizeForLeak(name);
    if (normalizedName.length < 2) continue;
    if (normalized.includes(normalizedName)) {
      nameHit = true;
      break;
    }
  }
  if (nameHit) reasons.push('真实昵称或会话名');

  if (sharesChatFragment(normalized, context.messageTexts)) reasons.push('聊天原文连续片段');

  for (const risk of detectPrivacyRisks(text)) reasons.push(`隐私信息:${risk}`);

  if (/\bwxid_[A-Za-z0-9_-]{4,}\b/i.test(text)) reasons.push('wxid');
  if (/@chatroom\b|@openim\b/i.test(text)) reasons.push('会话 ID');

  return reasons;
}

/** 硬门禁：命中即抛 CHAT_PRIVACY_LEAK。 */
export function assertNoChatLeak(text: string, context: ChatLeakContext, where: string): void {
  const reasons = findChatLeak(text, context);
  if (reasons.length === 0) return;
  throw new MomentsError('CHAT_PRIVACY_LEAK', `内容包含聊天隐私信息（${where}），已阻止进入草稿/审批`, {
    details: { where, reasons },
  });
}

/** 带上下文提供者的门禁对象：服务层用它保证每次检查都读到最新本地数据。 */
export class ChatPrivacyGuard {
  constructor(private readonly contextProvider: () => ChatLeakContext) {}

  /** 返回命中的原因类别（空数组 = 通过）。 */
  findings(text: string): string[] {
    return findChatLeak(text, this.contextProvider());
  }

  /** 命中即抛 `MomentsError('CHAT_PRIVACY_LEAK')`。 */
  assertNoLeak(text: string, where: string): void {
    assertNoChatLeak(text, this.contextProvider(), where);
  }
}

function normalizeForLeak(text: string): string {
  // NFKC：把全角字母/数字、兼容字符归一，避免「Ｌｉｓａ ↔ Lisa」「１３８… ↔ 138…」绕过。
  return text
    .normalize('NFKC')
    .replace(/[\s\u200b-\u200d\ufeff]+/g, '')
    .toLowerCase();
}

/**
 * 检测 `normalizedText` 是否包含任一聊天消息的 ≥ 8 字连续片段。
 * 双重窗口匹配：先收集待检文本的窗口集合，再扫描消息窗口，避免 O(n*m) 全量比较。
 */
function sharesChatFragment(normalizedText: string, messageTexts: readonly string[]): boolean {
  if (normalizedText.length < MIN_COPY_FRAGMENT_LENGTH) return false;
  const windows = new Set<string>();
  for (let index = 0; index <= normalizedText.length - MIN_COPY_FRAGMENT_LENGTH; index += 1) {
    windows.add(normalizedText.slice(index, index + MIN_COPY_FRAGMENT_LENGTH));
  }
  for (const raw of messageTexts) {
    const messageText = normalizeForLeak(raw);
    if (messageText.length < MIN_COPY_FRAGMENT_LENGTH) continue;
    for (let index = 0; index <= messageText.length - MIN_COPY_FRAGMENT_LENGTH; index += 1) {
      const fragment = messageText.slice(index, index + MIN_COPY_FRAGMENT_LENGTH);
      // 跳过含脱敏标记的窗口，避免把占位符当成「原文」。
      if (fragment.includes('[') || fragment.includes(']')) continue;
      if (windows.has(fragment)) return true;
    }
  }
  return false;
}
