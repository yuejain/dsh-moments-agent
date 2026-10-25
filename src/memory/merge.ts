/**
 * 新旧人物印象合并。
 *
 * 关键规则：
 * - `owner_edited` 的摘要 / 标签 / 风格 / 别名不被自动同步覆盖（所有者修正优先）；
 * - 证据条数累计：< 3 条 → `new`（待观察），≥ 3 条 → `observed`；
 * - 每次合并都刷新 TTL（`expiresAt`）与 `updatedAt`；
 * - 已有别名永远保留，保证提示词里的人物代号稳定。
 */
import type { MemberImpressionRecord } from '../domain/types.js';
import type { MemberImpressionInput } from '../storage/store.js';
import type { ExtractedMemberImpression } from './impression-builder.js';

/** 达到该独立证据条数后，状态从 `new` 升级为 `observed`。 */
export const OBSERVED_EVIDENCE_THRESHOLD = 3;

export interface MergeImpressionInput {
  readonly existing: MemberImpressionRecord | undefined;
  readonly extracted: ExtractedMemberImpression;
  /** 本次为这位成员分配的稳定别名。 */
  readonly alias: string;
  /** 本地昵称，只保存在本机数据库，不进入提示词。 */
  readonly displayName: string;
  /** 本次同步新增的消息条数（仅统计该成员的非本人消息）。 */
  readonly evidenceIncrement: number;
  /** 该成员最近一条消息时间（用于 lastSeenAt）。 */
  readonly lastSeenAt: string | null;
  readonly now: Date;
  readonly impressionTtlDays: number;
}

/** 计算 TTL 到期时间。 */
export function addDaysIso(now: Date, days: number): string {
  const safeDays = Number.isFinite(days) ? days : 0;
  return new Date(now.getTime() + Math.max(0, safeDays) * 24 * 60 * 60 * 1000).toISOString();
}

/** 合并出待写入的人物印象（纯函数，不访问数据库）。 */
export function mergeImpression(input: MergeImpressionInput): MemberImpressionInput {
  const { existing, extracted, now } = input;
  const nowIso = now.toISOString();
  const evidenceIncrement = Number.isFinite(input.evidenceIncrement)
    ? Math.max(0, Math.floor(input.evidenceIncrement))
    : 0;
  const evidenceCount = (existing?.evidenceCount ?? 0) + evidenceIncrement;
  const ownerEdited = existing?.status === 'owner_edited';

  const summary = ownerEdited
    ? existing.summary
    : extracted.summary !== ''
      ? extracted.summary
      : (existing?.summary ?? '');
  const style = ownerEdited
    ? existing.style
    : extracted.style !== ''
      ? extracted.style
      : (existing?.style ?? '');
  const traits = ownerEdited
    ? [...existing.traits]
    : extracted.traits.length > 0
      ? [...extracted.traits]
      : [...(existing?.traits ?? [])];
  const topics = mergeTopics(existing?.topics ?? [], extracted.topics);
  const confidence = ownerEdited
    ? existing.confidence
    : existing === undefined
      ? extracted.confidence
      : Math.max(existing.confidence, extracted.confidence);

  const firstSeenAt = existing?.firstSeenAt ?? nowIso;
  const lastSeenAt = latestIso(existing?.lastSeenAt ?? null, input.lastSeenAt);

  return {
    impressionId: existing?.impressionId ?? '',
    conversationKey: existing?.conversationKey ?? '',
    memberRef: existing?.memberRef ?? extracted.memberRef,
    alias: existing?.alias ?? input.alias,
    displayName: input.displayName !== '' ? input.displayName : (existing?.displayName ?? ''),
    summary,
    traits,
    topics,
    style,
    confidence,
    evidenceCount,
    status: ownerEdited ? 'owner_edited' : evidenceCount >= OBSERVED_EVIDENCE_THRESHOLD ? 'observed' : 'new',
    source: ownerEdited ? existing.source : 'auto',
    firstSeenAt,
    lastSeenAt,
    updatedAt: nowIso,
    expiresAt: addDaysIso(now, input.impressionTtlDays),
  };
}

function mergeTopics(existing: readonly string[], incoming: readonly string[]): string[] {
  const topics: string[] = [];
  for (const topic of [...existing, ...incoming]) {
    const value = topic.trim();
    if (value === '' || topics.includes(value)) continue;
    topics.push(value);
    if (topics.length >= 8) break;
  }
  return topics;
}

function latestIso(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return left >= right ? left : right;
}
