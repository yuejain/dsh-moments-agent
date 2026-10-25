/**
 * 拟人化自动发送策略（纯函数，无副作用）。
 *
 * 安全边界（必须保持）：
 * - 默认关闭：`policy.humanize.enabled=false` 时任何候选都返回 HUMANIZE_DISABLED；
 * - 只在发布模式允许时生效（PREPARE_ONLY 永远拒绝）；
 * - 审批模式只处理有效批准的候选；直接模式处理审核通过的候选，Publisher 复检内容哈希；
 * - Kill Switch / 暂停 / 安静时段 / 活跃时段 / 每日上限 / 最小间隔 优先于发送；
 * - UNCERTAIN（已点击未确认）永不重试，直接转人工；
 * - 失败次数达到 maxPublishAttempts 后不再自动尝试。
 *
 * 本模块不读时钟、不访问数据库、不发网络请求；所有时间来自输入，便于穷举测试。
 */
import type { MomentState, PublishAttemptState } from '../domain/types.js';
import type { MomentsConfig } from '../config.js';
import { maxSimilarity } from '../brain/similarity.js';
import {
  deterministicJitter,
  isQuietHours,
  minutesOfDay,
  parseHhMm,
  timeZoneOffsetMs,
  zonedParts,
} from '../scheduler/time-policy.js';
import { effectivePublishMode } from './publish-policy.js';

/** 与 decision-engine 保持一致：相似度达到该阈值视为重复内容，不自动发送。 */
export const HUMANIZE_DUPLICATE_SIMILARITY = 0.72;

/** 允许拟人化自动发送的任务状态；QUEUED 仅用于“准备失败后重试”。 */
const HUMANIZE_ALLOWED_STATES: readonly MomentState[] = ['APPROVED', 'QUEUED'];

export interface HumanizeControlState {
  readonly killSwitch: boolean;
  readonly paused: boolean;
}

export interface HumanizeDesktopState {
  readonly ok: boolean;
  readonly allowPublish: boolean;
  readonly wechatInstalled: boolean;
  readonly wechatReady: boolean;
  readonly accountId: string | null;
}

/** 候选：只包含调度器从数据库读取的最小快照，不含正文全文以外的敏感信息。 */
export interface HumanizeCandidate {
  readonly taskId: string;
  readonly state: MomentState;
  readonly contentHash: string;
  readonly accountId: string;
  readonly approvalId: string | null;
  readonly approvalStatus: string | null;
  readonly approvalExpiresAt: string | null;
  readonly approvalContentHash: string | null;
  /** 仅用于相似度去重；不写入日志/审计。 */
  readonly text: string;
  /** 本调度器已自动尝试失败的次数（不是历史发布尝试总数）。 */
  readonly attempts: number;
  readonly lastAttemptAt: string | null;
  readonly lastAttemptState: PublishAttemptState | null;
}

export interface HumanizeAppliedPolicy {
  readonly publishMode: string;
  readonly delaySeconds: readonly [number, number];
  readonly activeHours: readonly [string, string];
  readonly minIntervalSeconds: number;
  readonly jitterSeconds: number;
  readonly maxPublishAttempts: number;
  readonly backoffSeconds: readonly [number, number];
  readonly dailyLimit: number;
  readonly timeZone: string;
}

export interface HumanizeBlockingReason {
  readonly code: string;
  readonly reason: string;
  readonly nextEligibleAt: string | null;
}

export interface HumanizeEvaluationInput {
  readonly now: Date;
  readonly config: MomentsConfig;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly control: HumanizeControlState;
  readonly desktop: HumanizeDesktopState | null;
  readonly candidate: HumanizeCandidate;
  readonly lastPublishedAt: string | null;
  readonly todayCount: number;
  readonly recentTexts: readonly string[];
  readonly publishedContentHashes: readonly string[];
  readonly random?: () => number;
}

export interface HumanizeEvaluation {
  readonly allowed: boolean;
  readonly code: string;
  readonly reason: string;
  readonly reasons: readonly HumanizeBlockingReason[];
  readonly codes: readonly string[];
  readonly taskId: string;
  /** 仅 allowed=true 时有意义：本次计划使用的随机延迟（秒）。 */
  readonly delaySeconds: number;
  readonly nextEligibleAt: string | null;
  readonly appliedPolicy: HumanizeAppliedPolicy;
}

export interface HumanizePlanSkipped {
  readonly taskId: string;
  readonly code: string;
  readonly reason: string;
  readonly nextEligibleAt: string | null;
}

export interface HumanizePlanInput {
  readonly now: Date;
  readonly config: MomentsConfig;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly control: HumanizeControlState;
  readonly desktop: HumanizeDesktopState | null;
  readonly lastPublishedAt: string | null;
  readonly todayCount: number;
  readonly candidates: readonly HumanizeCandidate[];
  readonly recentTexts: readonly string[];
  readonly publishedContentHashes: readonly string[];
  readonly random?: () => number;
}

export interface HumanizePlan {
  readonly allowed: boolean;
  readonly taskId: string | null;
  readonly code: string;
  readonly reason: string;
  readonly delaySeconds: number;
  readonly nextEligibleAt: string | null;
  readonly evaluation: HumanizeEvaluation | null;
  readonly skipped: readonly HumanizePlanSkipped[];
}

// ---------------------------------------------------------------------------
// 配置快照与随机/时间工具
// ---------------------------------------------------------------------------

export function appliedHumanizePolicy(
  config: MomentsConfig,
  env: Readonly<Record<string, string | undefined>> = process.env,
): HumanizeAppliedPolicy {
  const humanize = config.policy.humanize;
  return {
    publishMode: effectivePublishMode(config, env),
    delaySeconds: humanize.delaySeconds,
    activeHours: humanize.activeHours,
    minIntervalSeconds: humanize.minIntervalSeconds,
    jitterSeconds: humanize.jitterSeconds,
    maxPublishAttempts: humanize.maxPublishAttempts,
    backoffSeconds: humanize.backoffSeconds,
    dailyLimit: config.policy.dailyLimit,
    timeZone: config.policy.timeZone,
  };
}

/** 在 [min,max] 秒内均匀取整；两者相等时返回固定值。 */
export function humanizeDelaySeconds(config: MomentsConfig, random: () => number = Math.random): number {
  const [min, max] = config.policy.humanize.delaySeconds;
  const low = Math.max(0, Math.min(min, max));
  const high = Math.max(low, max);
  if (high <= low) return low;
  return low + Math.floor(random() * (high - low + 1));
}

/**
 * 实际生效的发布间隔：拟人间隔与既有 policy.minIntervalMinutes 取较大者。
 * 必须这样做，否则 humanize 可能把任务交给 publisher 后因“最小间隔”被拒绝，
 * 白白消耗自动尝试次数。
 */
export function effectiveIntervalSeconds(config: MomentsConfig): number {
  return Math.max(config.policy.humanize.minIntervalSeconds, config.policy.minIntervalMinutes * 60);
}

/** 上一篇文章的最小等待：间隔 + 确定性抖动（同一任务/同一小时稳定）。 */
export function humanizeGapMs(config: MomentsConfig, taskId: string, now: Date): number {
  const jitter = deterministicJitter(`interval:${taskId}`, config.policy.humanize.jitterSeconds, now);
  return effectiveIntervalSeconds(config) * 1000 + jitter * 1000;
}

/** 指数退避：base*2^(attempts-1)，上限为 backoffSeconds[1]；attempts 从 1 开始。 */
export function retryBackoffSeconds(config: MomentsConfig, attempts: number): number {
  if (attempts <= 0) return 0;
  const [base, cap] = config.policy.humanize.backoffSeconds;
  const grown = base * 2 ** (attempts - 1);
  return Math.max(0, Math.min(grown, cap));
}

/** 本地墙钟（HH:mm）换算成真实 UTC 时刻；DST 边界做一次偏移校正。 */
function localWallClockToDate(now: Date, timeZone: string, dayOffset: number, minuteOfDay: number): Date {
  const parts = zonedParts(now, timeZone);
  const wallMs = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day + dayOffset,
    Math.floor(minuteOfDay / 60),
    minuteOfDay % 60,
    0,
    0,
  );
  const guessed = new Date(wallMs - timeZoneOffsetMs(now, timeZone));
  const refined = timeZoneOffsetMs(guessed, timeZone);
  return new Date(wallMs - refined);
}

export function isWithinActiveHours(now: Date, config: MomentsConfig): boolean {
  const [startRaw, endRaw] = config.policy.humanize.activeHours;
  const start = parseHhMm(startRaw);
  const end = parseHhMm(endRaw);
  const current = minutesOfDay(now, config.policy.timeZone);
  if (start < end) return current >= start && current < end;
  return current >= start || current < end;
}

/** 下一次进入活跃时段的时刻；当前已在活跃时段时返回 now。 */
export function nextActiveWindowStart(now: Date, config: MomentsConfig): Date {
  if (isWithinActiveHours(now, config)) return now;
  const [startRaw, endRaw] = config.policy.humanize.activeHours;
  const start = parseHhMm(startRaw);
  const end = parseHhMm(endRaw);
  const current = minutesOfDay(now, config.policy.timeZone);
  const timeZone = config.policy.timeZone;
  // start < end 且已过结束时间 -> 明天；其余情况 -> 今天的开始时间。
  const dayOffset = start < end && current >= end ? 1 : 0;
  return localWallClockToDate(now, timeZone, dayOffset, start);
}

/** 下一次活跃时段开始（严格晚于 now），用于每日上限重置后的首发时间。 */
export function nextActiveStartAfter(now: Date, config: MomentsConfig): Date {
  const start = parseHhMm(config.policy.humanize.activeHours[0]);
  return localWallClockToDate(now, config.policy.timeZone, 1, start);
}

/** 安静时段结束时刻；当前不在安静时段时返回 now。 */
export function nextQuietHoursEnd(now: Date, config: MomentsConfig): Date {
  const quietHours = config.policy.quietHours;
  const start = parseHhMm(quietHours[0]);
  const end = parseHhMm(quietHours[1]);
  if (start === end || !isQuietHours(now, quietHours, config.policy.timeZone)) return now;
  const current = minutesOfDay(now, config.policy.timeZone);
  const dayOffset = start < end ? 0 : current >= start ? 1 : 0;
  const target = end === 0 ? 0 : end;
  const result = localWallClockToDate(now, config.policy.timeZone, dayOffset, target);
  // end=00:00 时 localWallClockToDate 的 dayOffset 已指向下一天。
  return result;
}

/**
 * 只考虑时间类限制时的下一次可发送时刻（用于 status 展示，不涉及执行器健康）。
 * 无明显时间限制时返回 now。
 */
export function nextTimeEligibleAt(
  now: Date,
  config: MomentsConfig,
  lastPublishedAt: string | null,
  todayCount: number,
): Date {
  let next = now;
  const consider = (value: Date | null): void => {
    if (value === null) return;
    if (value.getTime() > next.getTime()) next = value;
  };
  if (todayCount >= config.policy.dailyLimit) consider(nextActiveStartAfter(now, config));
  consider(nextQuietHoursEnd(now, config).getTime() > now.getTime() ? nextQuietHoursEnd(now, config) : null);
  if (!isWithinActiveHours(now, config)) consider(nextActiveWindowStart(now, config));
  if (lastPublishedAt !== null) {
    const readyAt = new Date(new Date(lastPublishedAt).getTime() + humanizeGapMs(config, 'status', now));
    if (readyAt.getTime() > now.getTime()) consider(readyAt);
  }
  return next;
}

// ---------------------------------------------------------------------------
// 候选评估
// ---------------------------------------------------------------------------

function parseIso(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function evaluateHumanizeCandidate(input: HumanizeEvaluationInput): HumanizeEvaluation {
  const { config, candidate, now } = input;
  const humanize = config.policy.humanize;
  const timeZone = config.policy.timeZone;
  const mode = effectivePublishMode(config, input.env);
  const reasons: HumanizeBlockingReason[] = [];
  const add = (code: string, reason: string, nextEligibleAt?: Date | null): void => {
    reasons.push({ code, reason, nextEligibleAt: nextEligibleAt === undefined || nextEligibleAt === null ? null : nextEligibleAt.toISOString() });
  };

  if (!humanize.enabled) {
    add('HUMANIZE_DISABLED', '拟人化自动发送未开启（policy.humanize.enabled=false）');
  }
  if (mode === 'PREPARE_ONLY') {
    add('PUBLISH_MODE_DISABLED', '当前发布模式为 PREPARE_ONLY，禁止任何自动点击发表');
  }
  if (input.control.killSwitch || config.killSwitch) {
    add('KILL_SWITCH_ACTIVE', '全局 Kill Switch 已启用，停止一切外部操作');
  }
  if (input.control.paused) {
    add('PAUSED', '系统已暂停');
  }

  const stateAllowed =
    (HUMANIZE_ALLOWED_STATES.includes(candidate.state) || (mode === 'POLICY_AUTONOMOUS' && ['READY_TO_PUBLISH', 'READY_FOR_APPROVAL'].includes(candidate.state))) &&
    (candidate.state !== 'QUEUED' || candidate.attempts > 0);
  if (!stateAllowed) {
    add('TASK_NOT_APPROVED', `任务状态 ${candidate.state} 不允许拟人化自动发送（只处理已批准内容）`);
  }

  if (
    candidate.state === 'UNCERTAIN' ||
    candidate.lastAttemptState === 'UNCERTAIN' ||
    candidate.lastAttemptState === 'PUBLISHING'
  ) {
    add('UNCERTAIN_REQUIRES_MANUAL_CHECK', '上次发表可能已点击但无法确认，禁止自动重试，必须人工核对');
  }

  if (mode === 'APPROVAL_REQUIRED' && candidate.approvalId === null) {
    add('APPROVAL_REQUIRED', '没有与当前内容绑定的审批记录');
  } else if (mode === 'APPROVAL_REQUIRED') {
    if (candidate.approvalStatus !== 'approved') {
      add('APPROVAL_REQUIRED', `审批状态为 ${candidate.approvalStatus ?? 'unknown'}，不能自动发送`);
    }
    const expiresAt = parseIso(candidate.approvalExpiresAt);
    if (expiresAt === null || expiresAt <= now.getTime()) {
      add('APPROVAL_EXPIRED', '审批已过期，必须重新申请审批');
    }
    if (candidate.approvalContentHash !== null && candidate.approvalContentHash !== candidate.contentHash) {
      add('CONTENT_CHANGED', '审批后内容哈希发生变化，必须重新审批');
    }
  }

  if (candidate.accountId === '') {
    add('ACCOUNT_MISMATCH', '任务没有绑定目标微信账号');
  }

  if (candidate.attempts >= humanize.maxPublishAttempts) {
    add('RETRY_LIMIT_REACHED', `已达到自动尝试上限 ${humanize.maxPublishAttempts} 次，转人工处理`);
  } else if (candidate.attempts > 0) {
    const lastFailureAt = parseIso(candidate.lastAttemptAt);
    if (lastFailureAt !== null) {
      const readyAt = lastFailureAt + retryBackoffSeconds(config, candidate.attempts) * 1000;
      if (readyAt > now.getTime()) add('RETRY_BACKOFF', '上一次失败后的指数退避尚未到期', new Date(readyAt));
    }
  }

  const duplicateByHash = input.publishedContentHashes.includes(candidate.contentHash);
  if (duplicateByHash) {
    add('DUPLICATE_CONTENT', '相同内容哈希已经发布过，禁止重复发送');
  } else {
    const similarity = maxSimilarity(candidate.text, input.recentTexts);
    if (similarity.score >= HUMANIZE_DUPLICATE_SIMILARITY) {
      add(
        'SIMILAR_CONTENT',
        `与近期已发布内容相似度 ${(similarity.score * 100).toFixed(0)}%，接近重复，不自动发送`,
      );
    }
  }

  if (input.todayCount >= config.policy.dailyLimit) {
    add(
      'DAILY_LIMIT',
      `今日已发布 ${input.todayCount} 条，达到上限 ${config.policy.dailyLimit}`,
      nextActiveStartAfter(now, config),
    );
  }

  if (isQuietHours(now, config.policy.quietHours, timeZone)) {
    add('QUIET_HOURS', '当前处于安静时段，禁止发表', nextQuietHoursEnd(now, config));
  }

  if (!isWithinActiveHours(now, config)) {
    add('OUTSIDE_ACTIVE_HOURS', '当前不在拟人化活跃时段内', nextActiveWindowStart(now, config));
  }

  const lastPublishedAt = parseIso(input.lastPublishedAt);
  if (lastPublishedAt !== null) {
    const readyAt = lastPublishedAt + humanizeGapMs(config, candidate.taskId, now);
    if (readyAt > now.getTime()) {
      add('MIN_INTERVAL', '距离上一篇已发布内容的间隔不足（含抖动）', new Date(readyAt));
    }
  }

  if (input.desktop === null || !input.desktop.ok) {
    add('EXECUTOR_UNAVAILABLE', '桌面执行器不可用（未启用或健康检查失败）');
  } else {
    if (!input.desktop.wechatInstalled) {
      add('EXECUTOR_UNAVAILABLE', '未检测到 Windows 微信客户端');
    }
    if (!input.desktop.allowPublish) {
      add('PUBLISH_MODE_DISABLED', '桌面执行器未以 --allow-publish 启动，拒绝自动点击发表');
    }
    if (!input.desktop.wechatReady) {
      add('WECHAT_NOT_READY', '微信未运行或未登录，暂不能自动发送');
    } else if (
      input.desktop.accountId !== null &&
      candidate.accountId !== '' &&
      input.desktop.accountId !== candidate.accountId
    ) {
      add('ACCOUNT_MISMATCH', '当前登录微信账号与审批绑定账号不一致');
    }
  }

  const allowed = reasons.length === 0;
  const delaySeconds = allowed ? humanizeDelaySeconds(config, input.random ?? Math.random) : 0;
  const nextEligibleAt = allowed
    ? new Date(now.getTime() + delaySeconds * 1000).toISOString()
    : maxNextEligible(reasons);
  return {
    allowed,
    code: allowed ? 'OK' : (reasons[0] as HumanizeBlockingReason).code,
    reason: allowed ? '允许按拟人化节奏自动发送' : (reasons[0] as HumanizeBlockingReason).reason,
    reasons,
    codes: reasons.map((item) => item.code),
    taskId: candidate.taskId,
    delaySeconds,
    nextEligibleAt,
    appliedPolicy: appliedHumanizePolicy(config, input.env),
  };
}

/** 多个阻塞条件取最晚的“下次可试时间”（所有条件都满足才可发送）。 */
function maxNextEligible(reasons: readonly HumanizeBlockingReason[]): string | null {
  let latest: number | null = null;
  for (const item of reasons) {
    const parsed = parseIso(item.nextEligibleAt);
    if (parsed === null) continue;
    if (latest === null || parsed > latest) latest = parsed;
  }
  return latest === null ? null : new Date(latest).toISOString();
}

/**
 * 一次 tick 的计划：按顺序找第一个可发送候选；否则汇总跳过原因。
 * 不修改任何状态，真正落库/执行由 HumanizeScheduler 负责。
 */
export function planHumanizeTick(input: HumanizePlanInput): HumanizePlan {
  const skipped: HumanizePlanSkipped[] = [];
  for (const candidate of input.candidates) {
    const evaluation = evaluateHumanizeCandidate({
      now: input.now,
      config: input.config,
      ...(input.env === undefined ? {} : { env: input.env }),
      control: input.control,
      desktop: input.desktop,
      candidate,
      lastPublishedAt: input.lastPublishedAt,
      todayCount: input.todayCount,
      recentTexts: input.recentTexts,
      publishedContentHashes: input.publishedContentHashes,
      ...(input.random === undefined ? {} : { random: input.random }),
    });
    if (evaluation.allowed) {
      return {
        allowed: true,
        taskId: candidate.taskId,
        code: 'OK',
        reason: evaluation.reason,
        delaySeconds: evaluation.delaySeconds,
        nextEligibleAt: evaluation.nextEligibleAt,
        evaluation,
        skipped,
      };
    }
    skipped.push({
      taskId: candidate.taskId,
      code: evaluation.code,
      reason: evaluation.reason,
      nextEligibleAt: evaluation.nextEligibleAt,
    });
  }
  const first = skipped[0];
  const timed = skipped
    .map((item) => parseIso(item.nextEligibleAt))
    .filter((value): value is number => value !== null);
  return {
    allowed: false,
    taskId: null,
    code: first?.code ?? 'NO_CANDIDATE',
    reason: first?.reason ?? '没有可自动发送的已批准任务',
    delaySeconds: 0,
    nextEligibleAt: timed.length === 0 ? null : new Date(Math.max(...timed)).toISOString(),
    evaluation: null,
    skipped,
  };
}
