/**
 * 拟人化自动发送调度器（运行时服务）。
 *
 * 职责边界：
 * 1. 从数据库读取“已批准”的任务，用纯策略（humanize-policy）决定现在能否发；
 * 2. 把计划、失败次数与最后错误持久化到 system_settings，重启后恢复；
 * 3. 到点后调用**现有 Publisher**（prepare -> publish），由既有状态机、
 *    审批核销、内容哈希、账号绑定、Kill Switch 与 UNCERTAIN 保护再校验一遍。
 *
 * 明确不做：
 * - 不自动批准审批、不修改发布模式、不直接改任务状态；
 * - 不重试 UNCERTAIN / 已点击未确认；
 * - 不直接调用桌面执行器（必须经过 Publisher）；
 * - 日志与通知不含令牌、正文或图片内容。
 */
import type { MomentsConfig } from '../config.js';
import type { Logger, OwnerChannel, DesktopExecutor } from '../adapters/types.js';
import type { MomentsStore } from '../storage/store.js';
import type { ControlState } from '../security/kill-switch.js';
import type { PublishAttemptState, TaskRecord } from '../domain/types.js';
import { MomentsError } from '../domain/result.js';
import { redactSecrets } from '../security/redaction.js';
import { todayThreshold } from '../brain/decision-engine.js';
import { isQuietHours, minutesOfDay } from '../scheduler/time-policy.js';
import { Publisher } from './publisher.js';
import { effectivePublishMode } from './publish-policy.js';
import {
  appliedHumanizePolicy,
  evaluateHumanizeCandidate,
  isWithinActiveHours,
  nextTimeEligibleAt,
  planHumanizeTick,
  retryBackoffSeconds,
  type HumanizeCandidate,
  type HumanizeControlState,
  type HumanizeDesktopState,
  type HumanizeEvaluation,
} from './humanize-policy.js';

/** 设置表中的持久化键；不新增数据库迁移。 */
export const HUMANIZE_STATE_SETTING = 'humanize_state';

export type HumanizeAction =
  | 'disabled'
  | 'blocked'
  | 'busy'
  | 'idle'
  | 'scheduled'
  | 'waiting'
  | 'published'
  | 'failed'
  | 'uncertain';

export interface HumanizeTickResult {
  readonly acted: boolean;
  readonly action: HumanizeAction;
  readonly taskId: string | null;
  readonly code: string;
  readonly reason: string;
  readonly delaySeconds: number;
  readonly scheduledAt: string | null;
  readonly nextEligibleAt: string | null;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly uncertain: boolean;
}

interface HumanizeQueueEntry {
  readonly taskId: string;
  readonly approvalId: string | null;
  readonly contentHash: string;
  scheduledAt: string;
  delaySeconds: number;
  readonly createdAt: string;
  attempts: number;
  exhausted: boolean;
  lastError: string | null;
  /** 本调度器上次失败的时间（使用运行时时钟，便于重启后继续指数退避）。 */
  lastFailureAt: string | null;
}

interface HumanizeLastError {
  readonly at: string;
  readonly taskId: string;
  readonly code: string;
  readonly message: string;
}

interface HumanizeLastAction {
  readonly at: string;
  readonly action: string;
  readonly taskId: string | null;
  readonly code: string;
  readonly reason: string;
}

interface HumanizePersistedState {
  readonly version: 1;
  entries: HumanizeQueueEntry[];
  lastError: HumanizeLastError | null;
  lastAction: HumanizeLastAction | null;
}

export interface HumanizeQueueView {
  readonly taskId: string;
  readonly approvalId: string | null;
  readonly scheduledAt: string;
  readonly delaySeconds: number;
  readonly attempts: number;
  readonly exhausted: boolean;
  readonly lastError: string | null;
}

export interface HumanizeStatus {
  readonly enabled: boolean;
  readonly active: boolean;
  readonly publishMode: string;
  readonly effectivePublishMode: string;
  readonly config: {
    readonly delaySeconds: readonly [number, number];
    readonly activeHours: readonly [string, string];
    readonly minIntervalSeconds: number;
    readonly effectiveIntervalSeconds: number;
    readonly jitterSeconds: number;
    readonly maxPublishAttempts: number;
    readonly backoffSeconds: readonly [number, number];
    readonly dailyLimit: number;
    readonly timeZone: string;
    readonly quietHours: readonly [string, string];
  };
  readonly time: {
    readonly now: string;
    readonly localTime: string;
    readonly inActiveHours: boolean;
    readonly inQuietHours: boolean;
  };
  readonly today: { readonly published: number; readonly limit: number; readonly remaining: number };
  readonly lastPublishedAt: string | null;
  readonly nextEligibleAt: string | null;
  readonly nextScheduledAt: string | null;
  readonly queue: readonly HumanizeQueueView[];
  readonly lastError: HumanizeLastError | null;
  readonly lastAction: HumanizeLastAction | null;
  readonly blockedReasons: readonly string[];
  readonly lastTick: HumanizeTickResult | null;
}

export interface HumanizeSchedulerDeps {
  readonly config: MomentsConfig;
  readonly store: MomentsStore;
  readonly control: ControlState;
  readonly publisher: Publisher;
  readonly desktop: DesktopExecutor;
  readonly ownerChannel: OwnerChannel;
  readonly logger: Logger;
  readonly clock: () => Date;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly random?: () => number;
}

/** 这些阻塞原因需要所有者介入，调度器放弃当前条目而不是反复轮询。 */
const NO_RETRY_CODES = new Set([
  'UNCERTAIN_REQUIRES_MANUAL_CHECK',
  'APPROVAL_REQUIRED',
  'APPROVAL_EXPIRED',
  'APPROVAL_CONSUMED',
  'APPROVAL_INVALID',
  'CONTENT_CHANGED',
  'ACCOUNT_MISMATCH',
  'DUPLICATE_CONTENT',
  'SIMILAR_CONTENT',
  'RETRY_LIMIT_REACHED',
  'PUBLISH_MODE_DISABLED',
  'KILL_SWITCH_ACTIVE',
  'PAUSED',
  'TASK_NOT_APPROVED',
  'DUPLICATE_PUBLISH',
]);

const TERMINAL_TASK_STATES = new Set(['PUBLISHED', 'FAILED', 'CANCELLED', 'EXPIRED']);

function defaultState(): HumanizePersistedState {
  return { version: 1, entries: [], lastError: null, lastAction: null };
}

export class HumanizeScheduler {
  private readonly clock: () => Date;
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly random: () => number;
  private running = false;
  private lastTick: HumanizeTickResult | null = null;

  constructor(private readonly deps: HumanizeSchedulerDeps) {
    this.clock = deps.clock;
    this.env = deps.env ?? process.env;
    this.random = deps.random ?? Math.random;
  }

  // -------------------------------------------------------------------------
  // 持久化
  // -------------------------------------------------------------------------

  private loadState(): HumanizePersistedState {
    try {
      const raw = this.deps.store.getSetting(HUMANIZE_STATE_SETTING);
      if (raw === undefined || raw.trim() === '') return defaultState();
      const parsed = JSON.parse(raw) as Partial<HumanizePersistedState>;
      if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) return defaultState();
      return {
        version: 1,
        entries: parsed.entries
          .filter((entry): entry is HumanizeQueueEntry => {
            return (
              entry !== null &&
              typeof entry === 'object' &&
              typeof (entry as HumanizeQueueEntry).taskId === 'string' &&
              typeof (entry as HumanizeQueueEntry).scheduledAt === 'string'
            );
          })
          .map((entry) => ({
            ...entry,
            lastFailureAt: typeof entry.lastFailureAt === 'string' ? entry.lastFailureAt : null,
          })),
        lastError:
          parsed.lastError !== null && typeof parsed.lastError === 'object'
            ? (parsed.lastError as HumanizeLastError)
            : null,
        lastAction:
          parsed.lastAction !== null && typeof parsed.lastAction === 'object'
            ? (parsed.lastAction as HumanizeLastAction)
            : null,
      };
    } catch (error) {
      this.deps.logger.warn('拟人化状态读取失败，使用空状态', {
        error: error instanceof Error ? error.message : 'unknown',
      });
      return defaultState();
    }
  }

  private saveState(state: HumanizePersistedState): void {
    try {
      this.deps.store.setSetting(HUMANIZE_STATE_SETTING, JSON.stringify(state));
    } catch (error) {
      this.deps.logger.warn('拟人化状态写入失败', {
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

  private audit(action: string, taskId: string | null, reason: string, metadata: Record<string, unknown>): void {
    try {
      this.deps.store.appendAudit({
        at: this.clock().toISOString(),
        actor: 'scheduler',
        action,
        taskId,
        previousState: null,
        nextState: null,
        reason: redactSecrets(reason).slice(0, 500),
        metadata,
      });
    } catch (error) {
      this.deps.logger.warn('拟人化审计写入失败', {
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

  private async notify(text: string): Promise<void> {
    try {
      await this.deps.ownerChannel.sendText(text);
    } catch (error) {
      this.deps.logger.warn('拟人化通知发送失败', {
        error: redactSecrets(error instanceof Error ? error.message : 'unknown'),
      });
    }
  }

  // -------------------------------------------------------------------------
  // 从数据库读取上下文
  // -------------------------------------------------------------------------

  private controlState(): HumanizeControlState {
    return { killSwitch: this.deps.control.killSwitch || this.deps.config.killSwitch, paused: this.deps.control.paused };
  }

  private buildCandidate(task: TaskRecord, attempts: number, lastFailureAt: string | null = null): HumanizeCandidate {
    const approvals = this.deps.store.listApprovalsForTask(task.taskId);
    const approval =
      (task.approvalId === null ? undefined : approvals.find((item) => item.approvalId === task.approvalId)) ??
      approvals.find((item) => item.status === 'approved') ??
      null;
    let text = '';
    try {
      text = this.deps.store.requireCurrentDraft(task.taskId).text;
    } catch {
      text = '';
    }
    const attemptsList = this.deps.store.listAttemptsForTask(task.taskId);
    const lastAttempt = attemptsList.length === 0 ? null : (attemptsList[attemptsList.length - 1] as (typeof attemptsList)[number]);
    return {
      taskId: task.taskId,
      state: task.state,
      contentHash: task.contentHash ?? '',
      accountId: task.accountId ?? '',
      approvalId: approval?.approvalId ?? null,
      approvalStatus: approval?.status ?? null,
      approvalExpiresAt: approval?.expiresAt ?? null,
      approvalContentHash: approval?.contentHash ?? null,
      text,
      attempts,
      // 失败时间优先用调度器自己的运行时时钟（可测试/可重启），
      // 避免宿主真实时间与注入时钟不一致导致退避计算漂移。
      lastAttemptAt: lastFailureAt ?? lastAttempt?.updatedAt ?? null,
      lastAttemptState: (lastAttempt?.state ?? null) as PublishAttemptState | null,
    };
  }

  private approvedCandidates(state: HumanizePersistedState): HumanizeCandidate[] {
    const exhausted = new Set(state.entries.filter((entry) => entry.exhausted).map((entry) => entry.taskId));
    return this.deps.store
      .listTasks(this.deps.config.publishMode === 'POLICY_AUTONOMOUS' ? ['READY_TO_PUBLISH', 'READY_FOR_APPROVAL', 'APPROVED'] : ['APPROVED'], 20)
      .filter((task) => !exhausted.has(task.taskId))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((task) => this.buildCandidate(task, 0));
  }

  private contextData(now: Date): {
    lastPublishedAt: string | null;
    todayCount: number;
    recentTexts: readonly string[];
    publishedContentHashes: readonly string[];
  } {
    return {
      lastPublishedAt: this.deps.store.latestPublishedAt(),
      todayCount: this.deps.store.countPublishedSince(todayThreshold(now, this.deps.config.policy.timeZone)),
      recentTexts: this.deps.store.recentPublishedTexts(20).map((item) => item.text),
      publishedContentHashes: this.deps.store.listPublished(200).map((post) => post.contentHash),
    };
  }

  private async desktopState(): Promise<HumanizeDesktopState | null> {
    if (!this.deps.config.desktopExecutor.enabled) return null;
    try {
      const health = await this.deps.desktop.health();
      let status = null;
      try {
        status = await this.deps.desktop.status();
      } catch {
        status = null;
      }
      return {
        ok: health.ok,
        allowPublish: health.allowPublish,
        wechatInstalled: health.wechatInstalled,
        wechatReady:
          status !== null &&
          status.running &&
          status.loggedIn &&
          status.accountId !== null &&
          status.supported &&
          status.interactive &&
          !status.locked,
        accountId: status?.accountId ?? null,
      };
    } catch (error) {
      this.deps.logger.debug('拟人化读取执行器状态失败', {
        error: error instanceof Error ? error.message : 'unknown',
      });
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Tick
  // -------------------------------------------------------------------------

  private base(overrides: Partial<HumanizeTickResult> = {}): HumanizeTickResult {
    return {
      acted: false,
      action: 'idle',
      taskId: null,
      code: 'OK',
      reason: '',
      delaySeconds: 0,
      scheduledAt: null,
      nextEligibleAt: null,
      attempts: 0,
      maxAttempts: this.deps.config.policy.humanize.maxPublishAttempts,
      uncertain: false,
      ...overrides,
    };
  }

  private remember(result: HumanizeTickResult): HumanizeTickResult {
    this.lastTick = result;
    return result;
  }

  private prune(state: HumanizePersistedState): { state: HumanizePersistedState; changed: boolean } {
    let changed = false;
    const kept: HumanizeQueueEntry[] = [];
    for (const entry of state.entries) {
      const task = this.deps.store.getTask(entry.taskId);
      if (task === undefined) {
        changed = true;
        this.audit('humanize_skipped', entry.taskId, '任务已不存在，取消拟人化排期', { code: 'TASK_MISSING' });
        continue;
      }
      if (!(this.deps.config.publishMode === 'POLICY_AUTONOMOUS' ? ['READY_TO_PUBLISH', 'READY_FOR_APPROVAL', 'APPROVED', 'QUEUED'] : ['APPROVED', 'QUEUED']).includes(task.state)) {
        changed = true;
        this.audit('humanize_skipped', entry.taskId, `任务状态变为 ${task.state}，取消拟人化排期`, {
          code: `TASK_${task.state}`,
        });
        if (task.state === 'UNCERTAIN' && !entry.exhausted) {
          void this.notify(
            `【朋友圈自动发送-需人工核对】任务 ${entry.taskId} 进入 UNCERTAIN。系统不会自动重试，请人工核对朋友圈。`,
          );
        }
        continue;
      }
      if (!entry.exhausted && (task.approvalId !== entry.approvalId || task.contentHash !== entry.contentHash)) {
        changed = true;
        this.audit('humanize_skipped', entry.taskId, '审批或内容哈希已变化，取消旧排期', {
          code: 'CONTENT_CHANGED',
        });
        continue;
      }
      if (entry.exhausted && task.state === 'APPROVED' && task.approvalId !== entry.approvalId) {
        // 所有者重新审批了新内容：允许新内容重新排期，旧失败记录不再阻塞。
        changed = true;
        this.audit('humanize_skipped', entry.taskId, '已获得新的审批，清理旧的失败排期', { code: 'RETRY_RESET' });
        continue;
      }
      kept.push(entry);
    }
    state.entries = kept;
    return { state, changed };
  }

  async tick(): Promise<HumanizeTickResult> {
    const now = this.clock();
    const humanize = this.deps.config.policy.humanize;
    if (!humanize.enabled) {
      return this.remember(
        this.base({ action: 'disabled', code: 'HUMANIZE_DISABLED', reason: '拟人化自动发送未开启（policy.humanize.enabled=false）' }),
      );
    }
    if (this.deps.control.killSwitch || this.deps.config.killSwitch) {
      return this.remember(this.base({ action: 'blocked', code: 'KILL_SWITCH_ACTIVE', reason: '全局 Kill Switch 已启用' }));
    }
    if (this.deps.control.paused) {
      return this.remember(this.base({ action: 'blocked', code: 'PAUSED', reason: '系统已暂停' }));
    }
    if (effectivePublishMode(this.deps.config, this.env) === 'PREPARE_ONLY') {
      return this.remember(
        this.base({ action: 'blocked', code: 'PUBLISH_MODE_DISABLED', reason: '发布模式为 PREPARE_ONLY，禁止自动发表' }),
      );
    }
    if (this.running) {
      return this.remember(this.base({ action: 'busy', code: 'HUMANIZE_BUSY', reason: '上一次拟人化 tick 尚未结束' }));
    }
    this.running = true;
    try {
      let state = this.loadState();
      const pruned = this.prune(state);
      state = pruned.state;
      if (pruned.changed) this.saveState(state);

      const due = state.entries
        .filter((entry) => !entry.exhausted && Date.parse(entry.scheduledAt) <= now.getTime())
        .sort((left, right) => left.scheduledAt.localeCompare(right.scheduledAt))[0];
      if (due !== undefined) return this.remember(await this.executeEntry(state, due, now));

      const pending = state.entries.filter((entry) => !entry.exhausted).sort((left, right) => left.scheduledAt.localeCompare(right.scheduledAt))[0];
      if (pending !== undefined) {
        return this.remember(
          this.base({
            action: 'waiting',
            taskId: pending.taskId,
            code: 'WAITING',
            reason: '已排期，等待拟人化延迟',
            scheduledAt: pending.scheduledAt,
            nextEligibleAt: pending.scheduledAt,
            attempts: pending.attempts,
            delaySeconds: pending.delaySeconds,
          }),
        );
      }
      return this.remember(await this.scheduleNext(state, now));
    } finally {
      this.running = false;
    }
  }

  // -------------------------------------------------------------------------
  // 排期
  // -------------------------------------------------------------------------

  /**
   * 避免正好卡在整点（HH:00:00）附近发送：命中时往后顺延到整点之后。
   * 只做小范围平移（不超过一分钟），不影响“随机延迟区间”的整体分布。
   */
  private avoidWholeHour(scheduledAt: Date): Date | null {
    const minutes = minutesOfDay(scheduledAt, this.deps.config.policy.timeZone);
    const seconds = scheduledAt.getUTCSeconds();
    if (minutes % 60 !== 0 || seconds >= 10) return null;
    const shiftSeconds = 60 - seconds + 5 + Math.floor(this.random() * 50);
    return new Date(scheduledAt.getTime() + shiftSeconds * 1000);
  }

  private async scheduleNext(state: HumanizePersistedState, now: Date): Promise<HumanizeTickResult> {
    const candidates = this.approvedCandidates(state);
    if (candidates.length === 0) {
      return this.base({ action: 'idle', code: 'NO_CANDIDATE', reason: '没有等待自动发送的已批准任务' });
    }
    const desktop = await this.desktopState();
    const plan = planHumanizeTick({
      now,
      config: this.deps.config,
      env: this.env,
      control: this.controlState(),
      desktop,
      candidates,
      ...this.contextData(now),
      random: this.random,
    });
    if (!plan.allowed || plan.taskId === null || plan.nextEligibleAt === null) {
      const blockedTaskId = plan.skipped[0]?.taskId ?? null;
      // 只在阻塞原因发生变化时写审计，避免调度器每 10 秒刷一条 skip。
      if (state.lastAction?.code !== plan.code || state.lastAction?.taskId !== blockedTaskId) {
        state.lastAction = {
          at: now.toISOString(),
          action: 'humanize_skipped',
          taskId: blockedTaskId,
          code: plan.code,
          reason: plan.reason,
        };
        this.audit('humanize_skipped', blockedTaskId, `当前不自动发送：${plan.reason}`, {
          code: plan.code,
          nextEligibleAt: plan.nextEligibleAt,
          candidateCodes: plan.skipped.map((item) => item.code),
        });
        this.saveState(state);
      }
      return this.base({
        action: 'blocked',
        taskId: blockedTaskId,
        code: plan.code,
        reason: plan.reason,
        nextEligibleAt: plan.nextEligibleAt,
        attempts: 0,
      });
    }
    const candidate = candidates.find((item) => item.taskId === plan.taskId);
    if (candidate === undefined) {
      return this.base({ action: 'idle', code: 'NO_CANDIDATE', reason: '候选任务在排期时消失' });
    }
    const entry: HumanizeQueueEntry = {
      taskId: candidate.taskId,
      approvalId: candidate.approvalId,
      contentHash: candidate.contentHash,
      scheduledAt: plan.nextEligibleAt,
      delaySeconds: plan.delaySeconds,
      createdAt: now.toISOString(),
      attempts: 0,
      exhausted: false,
      lastError: null,
      lastFailureAt: null,
    };
    const scheduledDate = new Date(plan.nextEligibleAt);
    const shifted = this.avoidWholeHour(scheduledDate);
    if (shifted !== null) {
      entry.scheduledAt = shifted.toISOString();
      entry.delaySeconds = Math.max(1, Math.round((shifted.getTime() - now.getTime()) / 1000));
    }
    state.entries.push(entry);
    state.lastAction = {
      at: now.toISOString(),
      action: 'humanize_scheduled',
      taskId: entry.taskId,
      code: 'OK',
      reason: `计划 ${entry.delaySeconds} 秒后自动发送`,
    };
    this.audit('humanize_scheduled', entry.taskId, `已排期拟人化自动发送（延迟 ${entry.delaySeconds} 秒）`, {
      scheduledAt: entry.scheduledAt,
      delaySeconds: entry.delaySeconds,
      appliedPolicy: appliedHumanizePolicy(this.deps.config, this.env),
    });
    this.saveState(state);
    return this.base({
      acted: true,
      action: 'scheduled',
      taskId: entry.taskId,
      code: 'OK',
      reason: `已排期拟人化自动发送（延迟 ${entry.delaySeconds} 秒）`,
      delaySeconds: entry.delaySeconds,
      scheduledAt: entry.scheduledAt,
      nextEligibleAt: entry.scheduledAt,
    });
  }

  // -------------------------------------------------------------------------
  // 执行
  // -------------------------------------------------------------------------

  private removeEntry(state: HumanizePersistedState, taskId: string): void {
    state.entries = state.entries.filter((entry) => entry.taskId !== taskId);
  }

  private hasUncertainAttempt(taskId: string): boolean {
    return this.deps.store
      .listAttemptsForTask(taskId)
      .some((attempt) => attempt.state === 'UNCERTAIN' || attempt.state === 'PUBLISHING');
  }

  private async executeEntry(
    state: HumanizePersistedState,
    entry: HumanizeQueueEntry,
    now: Date,
  ): Promise<HumanizeTickResult> {
    const task = this.deps.store.getTask(entry.taskId);
    if (task === undefined) {
      this.removeEntry(state, entry.taskId);
      this.saveState(state);
      return this.base({ action: 'blocked', taskId: entry.taskId, code: 'TASK_MISSING', reason: '任务已不存在' });
    }
    const candidate = this.buildCandidate(task, entry.attempts, entry.lastFailureAt ?? null);
    const desktop = await this.desktopState();
    const evaluation = evaluateHumanizeCandidate({
      now,
      config: this.deps.config,
      env: this.env,
      control: this.controlState(),
      desktop,
      candidate,
      ...this.contextData(now),
      random: this.random,
    });
    if (!evaluation.allowed) {
      return this.handleBlockedEntry(state, entry, now, evaluation);
    }
    entry.lastError = null;
    try {
      await this.deps.publisher.prepare(entry.taskId, 'humanize');
      const outcome = await this.deps.publisher.publish(entry.taskId, entry.approvalId, 'humanize');
      if (outcome.uncertain || outcome.task.state === 'UNCERTAIN') {
        return await this.handleFailure(
          state,
          entry,
          now,
          new MomentsError('UNCERTAIN_REQUIRES_MANUAL_CHECK', outcome.message || '已点击发表但无法确认结果'),
        );
      }
      this.removeEntry(state, entry.taskId);
      state.lastError = null;
      state.lastAction = {
        at: now.toISOString(),
        action: 'humanize_published',
        taskId: entry.taskId,
        code: 'OK',
        reason: '已按拟人化节奏发表并核验成功',
      };
      this.audit('humanize_published', entry.taskId, '已按拟人化节奏发表并核验成功', {
        attempts: entry.attempts + 1,
        delaySeconds: entry.delaySeconds,
        verified: outcome.verified,
      });
      this.saveState(state);
      return this.base({
        acted: true,
        action: 'published',
        taskId: entry.taskId,
        code: 'OK',
        reason: '已按拟人化节奏发表并核验成功',
        delaySeconds: entry.delaySeconds,
        scheduledAt: entry.scheduledAt,
        attempts: entry.attempts + 1,
      });
    } catch (error) {
      return this.handleFailure(state, entry, now, error);
    }
  }

  /** 到点时条件已不满足：需要人工的放弃；时间/执行器类条件则顺延。 */
  private handleBlockedEntry(
    state: HumanizePersistedState,
    entry: HumanizeQueueEntry,
    now: Date,
    evaluation: HumanizeEvaluation,
  ): HumanizeTickResult {
    if (NO_RETRY_CODES.has(evaluation.code)) {
      this.removeEntry(state, entry.taskId);
      state.lastError = {
        at: now.toISOString(),
        taskId: entry.taskId,
        code: evaluation.code,
        message: evaluation.reason,
      };
      state.lastAction = {
        at: now.toISOString(),
        action: 'humanize_skipped',
        taskId: entry.taskId,
        code: evaluation.code,
        reason: evaluation.reason,
      };
      this.audit('humanize_skipped', entry.taskId, `放弃拟人化自动发送：${evaluation.reason}`, {
        code: evaluation.code,
        codes: evaluation.codes,
        attempts: entry.attempts,
      });
      if (evaluation.code === 'UNCERTAIN_REQUIRES_MANUAL_CHECK') {
        void this.notify(
          `【朋友圈自动发送-需人工核对】任务 ${entry.taskId} 可能已点击但无法确认。系统不会自动重试，请人工核对朋友圈。`,
        );
      } else if (evaluation.code === 'PUBLISH_MODE_DISABLED' || evaluation.code === 'ACCOUNT_MISMATCH') {
        void this.notify(
          `【朋友圈自动发送已放弃】任务 ${entry.taskId}：${evaluation.reason}。请到本机管理页查看状态，不会自动重试。`,
        );
      }
      this.saveState(state);
      return this.base({
        action: 'blocked',
        taskId: entry.taskId,
        code: evaluation.code,
        reason: evaluation.reason,
        attempts: entry.attempts,
        uncertain: evaluation.code === 'UNCERTAIN_REQUIRES_MANUAL_CHECK',
      });
    }
    const nextAt = evaluation.nextEligibleAt ?? new Date(now.getTime() + 60_000).toISOString();
    const changedReason = entry.lastError !== `${evaluation.code}:${evaluation.reason}`;
    entry.lastError = `${evaluation.code}:${evaluation.reason}`;
    entry.scheduledAt = nextAt;
    if (changedReason) {
      this.audit('humanize_skipped', entry.taskId, `拟人化自动发送顺延：${evaluation.reason}`, {
        code: evaluation.code,
        nextScheduledAt: nextAt,
        attempts: entry.attempts,
      });
    }
    this.saveState(state);
    return this.base({
      action: 'blocked',
      taskId: entry.taskId,
      code: evaluation.code,
      reason: `顺延：${evaluation.reason}`,
      scheduledAt: nextAt,
      nextEligibleAt: nextAt,
      attempts: entry.attempts,
    });
  }

  private async handleFailure(
    state: HumanizePersistedState,
    entry: HumanizeQueueEntry,
    now: Date,
    error: unknown,
  ): Promise<HumanizeTickResult> {
    const code = error instanceof MomentsError ? error.code : 'INTERNAL_ERROR';
    const message = redactSecrets(error instanceof Error ? error.message : '未知错误').slice(0, 300);
    const newAttempts = Math.min(entry.attempts + 1, this.deps.config.policy.humanize.maxPublishAttempts);
    const task = this.deps.store.getTask(entry.taskId);
    const uncertain =
      code === 'UNCERTAIN_REQUIRES_MANUAL_CHECK' ||
      task?.state === 'UNCERTAIN' ||
      this.hasUncertainAttempt(entry.taskId);
    entry.lastError = `${code}: ${message}`;

    const exhaust = (action: HumanizeAction, reason: string, extra: Partial<HumanizeTickResult> = {}): HumanizeTickResult => {
      entry.attempts = newAttempts;
      entry.exhausted = true;
      entry.lastFailureAt = now.toISOString();
      state.lastError = { at: now.toISOString(), taskId: entry.taskId, code, message };
      state.lastAction = { at: now.toISOString(), action: 'humanize_failed', taskId: entry.taskId, code, reason };
      const current = this.deps.store.getTask(entry.taskId);
      if (current !== undefined && !TERMINAL_TASK_STATES.has(current.state) && current.state !== 'PUBLISHED') {
        try {
          this.deps.store.updateTaskFields(entry.taskId, {
            errorCode: code,
            errorMessage: `拟人化自动发送失败：${message}`,
          });
        } catch {
          // 忽略：错误字段只是可观测性，不影响安全边界。
        }
      }
      this.audit('humanize_failed', entry.taskId, reason, {
        code,
        attempts: newAttempts,
        maxAttempts: this.deps.config.policy.humanize.maxPublishAttempts,
        uncertain,
        exhausted: true,
      });
      this.saveState(state);
      return this.base({
        acted: true,
        action,
        taskId: entry.taskId,
        code,
        reason,
        attempts: newAttempts,
        uncertain,
        ...extra,
      });
    };

    if (uncertain) {
      void this.notify(
        `【朋友圈自动发送-需人工核对】任务 ${entry.taskId} 可能已点击发表但无法确认结果。系统不会自动重试，请人工核对后处理 UNCERTAIN。`,
      );
      return exhaust('uncertain', '发表结果不确定，已停止自动重试，等待人工核对', { uncertain: true });
    }

    if (code === 'POLICY_DENIED') {
      // 发布前的时间/策略校验在 tick 之间发生变化：不消耗自动尝试，稍后重新评估。
      entry.scheduledAt = new Date(now.getTime() + 60_000).toISOString();
      this.audit('humanize_skipped', entry.taskId, `发布策略在到点时拒绝，稍后重新评估：${message}`, {
        code,
        nextScheduledAt: entry.scheduledAt,
      });
      this.saveState(state);
      return this.base({
        action: 'blocked',
        taskId: entry.taskId,
        code,
        reason: `发布策略拒绝：${message}`,
        scheduledAt: entry.scheduledAt,
        nextEligibleAt: entry.scheduledAt,
        attempts: entry.attempts,
      });
    }

    const taskIsTerminal = task !== undefined && TERMINAL_TASK_STATES.has(task.state);
    const retryable = (error instanceof MomentsError && error.retryable) || code === 'DESKTOP_UNAVAILABLE' || code === 'DESKTOP_PRECONDITION';
    if (!taskIsTerminal && retryable && newAttempts < this.deps.config.policy.humanize.maxPublishAttempts) {
      entry.attempts = newAttempts;
      entry.lastFailureAt = now.toISOString();
      const backoff = retryBackoffSeconds(this.deps.config, newAttempts);
      entry.scheduledAt = new Date(now.getTime() + backoff * 1000).toISOString();
      state.lastError = { at: now.toISOString(), taskId: entry.taskId, code, message };
      state.lastAction = {
        at: now.toISOString(),
        action: 'humanize_failed',
        taskId: entry.taskId,
        code,
        reason: `第 ${newAttempts} 次失败，${backoff} 秒后重试`,
      };
      this.audit('humanize_failed', entry.taskId, `拟人化自动发送第 ${newAttempts} 次失败，${backoff} 秒后重试：${message}`, {
        code,
        attempts: newAttempts,
        maxAttempts: this.deps.config.policy.humanize.maxPublishAttempts,
        retryBackoffSeconds: backoff,
        nextScheduledAt: entry.scheduledAt,
        uncertain: false,
      });
      this.saveState(state);
      return this.base({
        acted: true,
        action: 'failed',
        taskId: entry.taskId,
        code,
        reason: `第 ${newAttempts} 次失败，${backoff} 秒后重试`,
        attempts: newAttempts,
        scheduledAt: entry.scheduledAt,
        nextEligibleAt: entry.scheduledAt,
      });
    }

    void this.notify(
      `【朋友圈自动发送失败】任务 ${entry.taskId} 自动发送失败（${code}），已停止自动尝试，请到本机管理页查看并手动处理。`,
    );
    return exhaust(
      'failed',
      newAttempts >= this.deps.config.policy.humanize.maxPublishAttempts
        ? `达到自动尝试上限 ${this.deps.config.policy.humanize.maxPublishAttempts} 次，转人工处理`
        : '遇到不可自动重试的错误，转人工处理',
    );
  }

  // -------------------------------------------------------------------------
  // 状态（只读，供 status / 管理 API 使用）
  // -------------------------------------------------------------------------

  status(): HumanizeStatus {
    const now = this.clock();
    const config = this.deps.config;
    const humanize = config.policy.humanize;
    const timeZone = config.policy.timeZone;
    const state = this.loadState();
    const effective = effectivePublishMode(config, this.env);
    const lastPublishedAt = this.deps.store.latestPublishedAt();
    const todayCount = this.deps.store.countPublishedSince(todayThreshold(now, timeZone));
    const blockedReasons: string[] = [];
    if (!humanize.enabled) blockedReasons.push('HUMANIZE_DISABLED');
    if (effective === 'PREPARE_ONLY') blockedReasons.push('PUBLISH_MODE_DISABLED');
    if (this.deps.control.killSwitch || config.killSwitch) blockedReasons.push('KILL_SWITCH_ACTIVE');
    if (this.deps.control.paused) blockedReasons.push('PAUSED');

    const queue = state.entries
      .slice()
      .sort((left, right) => left.scheduledAt.localeCompare(right.scheduledAt))
      .map<HumanizeQueueView>((entry) => ({
        taskId: entry.taskId,
        approvalId: entry.approvalId,
        scheduledAt: entry.scheduledAt,
        delaySeconds: entry.delaySeconds,
        attempts: entry.attempts,
        exhausted: entry.exhausted,
        lastError: entry.lastError,
      }));
    const pending = queue.filter((entry) => !entry.exhausted);
    const nextScheduledAt = pending[0]?.scheduledAt ?? null;
    const timeEligible = nextTimeEligibleAt(now, config, lastPublishedAt, todayCount);
    let nextEligibleAt: string | null = null;
    if (blockedReasons.length === 0) {
      const candidateTimes = [timeEligible.getTime(), nextScheduledAt === null ? 0 : Date.parse(nextScheduledAt)];
      nextEligibleAt = new Date(Math.max(...candidateTimes)).toISOString();
    }
    const localNow = now.toISOString();
    const minutes = minutesOfDay(now, timeZone);
    const localTime = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    return {
      enabled: humanize.enabled,
      active: blockedReasons.length === 0,
      publishMode: config.publishMode,
      effectivePublishMode: effective,
      config: {
        delaySeconds: humanize.delaySeconds,
        activeHours: humanize.activeHours,
        minIntervalSeconds: humanize.minIntervalSeconds,
        effectiveIntervalSeconds: Math.max(humanize.minIntervalSeconds, config.policy.minIntervalMinutes * 60),
        jitterSeconds: humanize.jitterSeconds,
        maxPublishAttempts: humanize.maxPublishAttempts,
        backoffSeconds: humanize.backoffSeconds,
        dailyLimit: config.policy.dailyLimit,
        timeZone,
        quietHours: config.policy.quietHours,
      },
      time: {
        now: localNow,
        localTime,
        inActiveHours: this.inActiveHours(now),
        inQuietHours: this.inQuietHours(now),
      },
      today: {
        published: todayCount,
        limit: config.policy.dailyLimit,
        remaining: Math.max(0, config.policy.dailyLimit - todayCount),
      },
      lastPublishedAt,
      nextEligibleAt,
      nextScheduledAt,
      queue,
      lastError: state.lastError,
      lastAction: state.lastAction,
      blockedReasons,
      lastTick: this.lastTick,
    };
  }

  private inActiveHours(now: Date): boolean {
    // 直接复用策略模块的时间窗口判断，避免两份实现漂移。
    return isWithinActiveHours(now, this.deps.config);
  }

  private inQuietHours(now: Date): boolean {
    return isQuietHours(now, this.deps.config.policy.quietHours, this.deps.config.policy.timeZone);
  }
}
