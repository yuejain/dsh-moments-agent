/**
 * 发布决策引擎：硬规则（不可被模型绕过）+ 软评分（只用于排序与阈值判断）。
 *
 * 调用顺序：
 * 1. 选题阶段 evaluateCandidate()：决定“是否值得进入草稿”；
 * 2. 草稿阶段 evaluateDraft()：重新检查去重、隐私、来源；
 * 3. 发布阶段由 PublishPolicy 再检查模式、审批、账号、幂等。
 */
import { MomentsError } from '../domain/result.js';
import { detectPrivacyRisks } from '../security/prompt-injection.js';
import type { IdeaScores, PublishDecision, RiskFlag } from '../domain/types.js';
import type { MomentsConfig } from '../config.js';
import type { IdeaCandidate } from './idea-generator.js';
import { maxSimilarity } from './similarity.js';
import { isQuietHours, startOfLocalDay } from '../scheduler/time-policy.js';

export interface DecisionContext {
  readonly config: MomentsConfig;
  readonly now: Date;
  readonly killSwitch: boolean;
  readonly paused: boolean;
  readonly accountId: string | null;
  readonly publishedToday: number;
  readonly lastPublishedAt: string | null;
  readonly recentTexts: readonly string[];
  readonly recentIdeaTopics?: readonly string[];
}

const BLOCKING_FLAGS: readonly RiskFlag[] = [
  'PRIVACY_PERSONAL_INFO',
  'REAL_PERSON_CLAIM',
  'LOCATION_CLAIM',
  'PROMPT_INJECTION_SUSPECTED',
  'SOURCE_MISSING',
  'MISLEADING_IMAGE',
];

export interface CandidateEvaluation {
  readonly decision: PublishDecision;
  readonly flags: readonly RiskFlag[];
  readonly duplicateSimilarity: number;
}

export class DecisionEngine {
  /** 计算软评分（0..1）。重复度惩罚由调用方传入。 */
  computeScore(scores: IdeaScores, duplicatePenalty = 0): number {
    const raw =
      scores.novelty * 0.22 +
      scores.persona * 0.18 +
      scores.relevance * 0.12 +
      scores.expressionValue * 0.2 +
      scores.emotionalValue * 0.12 +
      scores.timeliness * 0.08;
    return Math.min(1, Math.max(0, raw - duplicatePenalty * 0.25));
  }

  /** 选题阶段：硬规则 + 阈值。 */
  evaluateCandidate(candidate: IdeaCandidate, context: DecisionContext): CandidateEvaluation {
    const flags = new Set<RiskFlag>(candidate.riskFlags);
    const recentTopics = context.recentIdeaTopics ?? context.recentTexts;
    const similarity = maxSimilarity(`${candidate.topic}\n${candidate.motivation}`, recentTopics);
    if (similarity.score >= 0.72) flags.add('DUPLICATE_RECENT');
    if (candidate.scores.novelty < 0.25) flags.add('LOW_NOVELTY');
    if (candidate.scores.persona < 0.3) flags.add('LOW_PERSONA_FIT');

    const hard = this.hardRules(context);
    if (hard !== null) {
      return {
        decision: { allowed: false, code: hard.code, reason: hard.reason },
        flags: [...flags],
        duplicateSimilarity: similarity.score,
      };
    }
    for (const flag of flags) {
      if (BLOCKING_FLAGS.includes(flag)) {
        return {
          decision: { allowed: false, code: `RISK_${flag}`, reason: `风险标记阻止自动发布：${flag}` },
          flags: [...flags],
          duplicateSimilarity: similarity.score,
        };
      }
    }
    const score = this.computeScore(candidate.scores, similarity.score >= 0.5 ? similarity.score : 0);
    if (score < context.config.policy.minScoreToPublish) {
      return {
        decision: {
          allowed: false,
          code: 'LOW_SCORE',
          reason: `综合评分 ${score.toFixed(2)} 低于阈值 ${context.config.policy.minScoreToPublish}`,
          scores: candidate.scores,
        },
        flags: [...flags],
        duplicateSimilarity: similarity.score,
      };
    }
    return {
      decision: {
        allowed: true,
        code: 'OK',
        reason: `综合评分 ${score.toFixed(2)}，允许进入草稿`,
        scores: candidate.scores,
      },
      flags: [...flags],
      duplicateSimilarity: similarity.score,
    };
  }

  /** 草稿阶段：对最终文案重新检查隐私、重复与长度。 */
  evaluateDraft(text: string, context: DecisionContext): PublishDecision {
    const normalized = text.trim();
    if (normalized === '') {
      return { allowed: false, code: 'EMPTY_DRAFT', reason: '草稿为空' };
    }
    if (normalized.length > context.config.policy.maxTextLength) {
      return {
        allowed: false,
        code: 'TEXT_TOO_LONG',
        reason: `文案长度 ${normalized.length} 超过上限 ${context.config.policy.maxTextLength}`,
      };
    }
    const hard = this.hardRules(context);
    if (hard !== null) return { allowed: false, code: hard.code, reason: hard.reason };
    const privacy = detectPrivacyRisks(normalized);
    if (privacy.length > 0) {
      return {
        allowed: false,
        code: 'PRIVACY_RISK',
        reason: `文案包含疑似隐私信息：${privacy.join('、')}`,
      };
    }
    const similarity = maxSimilarity(normalized, context.recentTexts);
    if (similarity.score >= 0.72) {
      return {
        allowed: false,
        code: 'DUPLICATE_RECENT',
        reason: `与近期已发布内容相似度 ${(similarity.score * 100).toFixed(0)}%，需要换一个表达`,
      };
    }
    if (similarity.score >= 0.55) {
      return {
        allowed: true,
        code: 'OK_REPETITIVE',
        reason: `允许但接近重复（相似度 ${(similarity.score * 100).toFixed(0)}%），建议调整表达`,
      };
    }
    return { allowed: true, code: 'OK', reason: '草稿通过硬规则检查' };
  }

  /** 调度是否允许现在唤醒创作。 */
  canCreateNow(context: DecisionContext): PublishDecision {
    const hard = this.hardRules(context);
    if (hard !== null) return { allowed: false, code: hard.code, reason: hard.reason };
    if (isQuietHours(context.now, context.config.policy.quietHours, context.config.policy.timeZone)) {
      return { allowed: false, code: 'QUIET_HOURS', reason: '当前处于安静时段' };
    }
    return { allowed: true, code: 'OK', reason: '允许创作' };
  }

  private hardRules(context: DecisionContext): { code: string; reason: string } | null {
    if (context.killSwitch || context.config.killSwitch) {
      return { code: 'KILL_SWITCH_ACTIVE', reason: '全局 Kill Switch 已启用' };
    }
    if (context.paused) return { code: 'PAUSED', reason: '系统已暂停' };
    if (context.accountId === null || context.accountId === '') {
      return { code: 'ACCOUNT_MISMATCH', reason: '目标微信账号未确认' };
    }
    if (context.publishedToday >= context.config.policy.dailyLimit) {
      return {
        code: 'DAILY_LIMIT',
        reason: `今日已发布 ${context.publishedToday} 条，达到上限 ${context.config.policy.dailyLimit}`,
      };
    }
    if (context.lastPublishedAt !== null) {
      const elapsedMs = context.now.getTime() - new Date(context.lastPublishedAt).getTime();
      const minGapMs = context.config.policy.minIntervalMinutes * 60_000;
      if (Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs < minGapMs) {
        return {
          code: 'MIN_INTERVAL',
          reason: `距离上一条发布不足 ${context.config.policy.minIntervalMinutes} 分钟`,
        };
      }
    }
    if (isQuietHours(context.now, context.config.policy.quietHours, context.config.policy.timeZone)) {
      return { code: 'QUIET_HOURS', reason: '当前处于安静时段' };
    }
    return null;
  }
}

/** 今日已发布计数所需的时间下界。 */
export function todayThreshold(now: Date, timeZone: string): string {
  return startOfLocalDay(now, timeZone).toISOString();
}

export function assertDecision(decision: PublishDecision, errorCode = 'POLICY_DENIED'): void {
  if (!decision.allowed) {
    throw new MomentsError(errorCode as MomentsError['code'], decision.reason, {
      details: { decisionCode: decision.code },
    });
  }
}
