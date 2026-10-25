/**
 * 发布执行器：准备 -> 审批核销 -> 点击发表 -> 核验。
 *
 * 关键安全性质：
 * - 默认 PREPARE_ONLY：不允许调用桌面执行器的发表端点；
 * - 发布前重新计算内容快照并与审批比对；
 * - 审批一次性核销；点击后任何无法确认的结果都进入 UNCERTAIN，禁止自动重试；
 * - 重复内容哈希直接拒绝（幂等键 + 已发布表双重保护）。
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { MomentsError } from '../domain/result.js';
import {
  computeIdempotencyKey,
  newId,
} from '../domain/ids.js';
import type {
  MomentsErrorCode,
} from '../domain/result.js';
import type {
  ApprovalRecord,
  PublishedPostRecord,
  PublishAttemptRecord,
  PublishVerification,
  TaskRecord,
} from '../domain/types.js';
import type { MomentsStore } from '../storage/store.js';
import type { MomentsConfig } from '../config.js';
import type { ControlState } from '../security/kill-switch.js';
import type { ApprovalService, ApprovalSnapshot } from '../approval/approval-service.js';
import { buildSnapshot } from '../approval/approval-service.js';
import type { DesktopExecutor, Logger } from '../adapters/types.js';
import {
  PublishPolicy,
  assertPublishDecision,
  effectivePublishMode,
  type PublishPolicyContext,
} from './publish-policy.js';
import { todayThreshold } from '../brain/decision-engine.js';
import { isQuietHours } from '../scheduler/time-policy.js';

export interface PrepareOutcome {
  readonly attempt: PublishAttemptRecord;
  readonly task: TaskRecord;
  readonly prepared: boolean;
  readonly screenshotPath: string | null;
  readonly textMatched: boolean;
  readonly imageCount: number;
  readonly warnings: readonly string[];
  readonly idempotent: boolean;
}

export interface PublishOutcome {
  readonly attempt: PublishAttemptRecord;
  readonly task: TaskRecord;
  readonly submitted: boolean;
  readonly verified: boolean;
  readonly uncertain: boolean;
  readonly message: string;
}

const RETRYABLE_DESKTOP_CODES = new Set([
  'INTERACTIVE_DESKTOP_UNAVAILABLE',
  'WECHAT_NOT_RUNNING',
  'WECHAT_NOT_LOGGED_IN',
  'WINDOW_NOT_FOUND',
  'WINDOW_BLOCKED',
  'UPLOAD_FAILED',
  'EXECUTOR_BUSY',
]);

export function mapDesktopErrorCode(code: string | null): MomentsErrorCode {
  switch (code) {
    case 'INTERACTIVE_DESKTOP_UNAVAILABLE':
    case 'WECHAT_NOT_RUNNING':
    case 'WECHAT_NOT_LOGGED_IN':
    case 'WINDOW_NOT_FOUND':
    case 'WINDOW_BLOCKED':
    case 'UPLOAD_FAILED':
    case 'EXECUTOR_BUSY':
    case 'PREVIEW_NOT_FOUND':
      return 'DESKTOP_PRECONDITION';
    case 'ACCOUNT_MISMATCH':
      return 'ACCOUNT_MISMATCH';
    case 'CONTENT_CHANGED':
      return 'CONTENT_CHANGED';
    case 'CLIENT_VERSION_UNSUPPORTED':
      return 'DESKTOP_UNSUPPORTED';
    case 'PUBLISH_MODE_DISABLED':
      return 'PUBLISH_MODE_DISABLED';
    case 'APPROVAL_REQUIRED':
      return 'APPROVAL_REQUIRED';
    case 'UNAUTHORIZED':
    case 'BAD_REQUEST':
    case 'INTERNAL_ERROR':
      return 'DESKTOP_UNAVAILABLE';
    case 'ALREADY_SUBMITTED':
      return 'UNCERTAIN_REQUIRES_MANUAL_CHECK';
    case 'UNCERTAIN':
      return 'UNCERTAIN_REQUIRES_MANUAL_CHECK';
    default:
      return 'DESKTOP_UNAVAILABLE';
  }
}

export class Publisher {
  private readonly policy: PublishPolicy;
  private busy = false;
  get isBusy(): boolean { return this.busy; }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy) throw new MomentsError('CONFLICT', '桌面执行中，请等待当前操作结束');
    this.busy = true;
    try { return await operation(); } finally { this.busy = false; }
  }

  private assertTimeLimits(): void {
    const now = this.clock();
    const policy = this.config.policy;
    if (this.store.countPublishedSince(todayThreshold(now, policy.timeZone)) >= policy.dailyLimit) {
      throw new MomentsError('POLICY_DENIED', '已达到今日发布上限');
    }
    const last = this.store.latestPublishedAt();
    if (last && now.getTime() - new Date(last).getTime() < policy.minIntervalMinutes * 60_000) {
      throw new MomentsError('POLICY_DENIED', '距离上次发表未达到最小间隔');
    }
    if (isQuietHours(now, policy.quietHours, policy.timeZone)) {
      throw new MomentsError('POLICY_DENIED', '当前处于安静时段，禁止发表');
    }
  }

  constructor(
    private readonly store: MomentsStore,
    private readonly approvalService: ApprovalService,
    private readonly desktop: DesktopExecutor,
    private readonly config: MomentsConfig,
    private readonly control: ControlState,
    private readonly logger: Logger,
    private readonly dataDir: string,
    private readonly clock: () => Date = () => new Date(),
    private readonly env: Readonly<Record<string, string | undefined>> = process.env,
  ) {
    this.policy = new PublishPolicy(env);
  }

  private snapshotFor(task: TaskRecord): ApprovalSnapshot {
    const draft = this.store.requireCurrentDraft(task.taskId);
    const assets = this.store.listTaskAssets(task.taskId);
    const accountId = task.accountId;
    if (accountId === null || accountId === '') {
      throw new MomentsError('ACCOUNT_MISMATCH', '任务未绑定目标微信账号');
    }
    return buildSnapshot(task, draft.text, assets, accountId);
  }

  private findApproval(taskId: string, approvalId: string | null): ApprovalRecord {
    if (approvalId !== null) return this.store.requireApproval(approvalId);
    const approvals = this.store.listApprovalsForTask(taskId);
    const approved = approvals.find((item) => item.status === 'approved');
    if (approved === undefined) {
      throw new MomentsError('APPROVAL_REQUIRED', '任务没有已批准的审批记录');
    }
    return approved;
  }

  private async policyContext(
    task: TaskRecord,
    snapshot: ApprovalSnapshot,
    approval: ApprovalRecord | null,
  ): Promise<PublishPolicyContext> {
    const desktopHealth = await this.desktop.health();
    let wechatStatus = null;
    try {
      wechatStatus = await this.desktop.status();
    } catch {
      wechatStatus = null;
    }
    return {
      config: this.config,
      control: this.control,
      task,
      snapshot,
      approval,
      desktopHealth,
      wechatStatus,
      duplicateContentHash: this.store.getPublishedByContentHash(snapshot.contentHash) !== undefined,
      now: this.clock(),
    };
  }

  private currentAttemptForPrepare(taskId: string): PublishAttemptRecord | undefined {
    const attempts = this.store.listAttemptsForTask(taskId);
    return attempts.find((attempt) => attempt.state === 'PREPARED' || attempt.state === 'PLANNED' || attempt.state === 'PREPARING');
  }

  /** 准备朋友圈编辑界面；绝不点击发表。 */
  async prepare(taskId: string, actor = 'agent'): Promise<PrepareOutcome> {
    return this.exclusive(() => this.prepareExclusive(taskId, actor));
  }

  private async prepareExclusive(taskId: string, actor: string): Promise<PrepareOutcome> {
    const task = this.store.requireTask(taskId);
    if (task.state === 'PREPARED') {
      const prepared = this.store.listAttemptsForTask(taskId).find((attempt) => attempt.state === 'PREPARED');
      if (prepared !== undefined) {
        return {
          attempt: prepared,
          task,
          prepared: true,
          screenshotPath: prepared.screenshotPath,
          textMatched: true,
          imageCount: 0,
          warnings: ['任务已经准备完成，返回既有结果（幂等）'],
          idempotent: true,
        };
      }
    }
    const requiresApproval = this.config.publishMode === 'APPROVAL_REQUIRED';
    if (!(requiresApproval ? ['APPROVED', 'QUEUED'] : ['READY_FOR_APPROVAL', 'READY_TO_PUBLISH', 'APPROVED', 'QUEUED']).includes(task.state)) {
      throw new MomentsError('CONFLICT', `任务状态 ${task.state} 不允许准备`, {
        details: { taskId, state: task.state },
      });
    }
    const snapshot = this.snapshotFor(task);
    const approval = requiresApproval ? this.findApproval(taskId, null) : null;
    if (approval) this.approvalService.validateOwner(approval, 'manual_admin', approval.ownerId);
    const context = await this.policyContext(task, snapshot, approval);
    assertPublishDecision(this.policy.evaluatePrepare(context));

    const idempotencyKey = computeIdempotencyKey({
      taskId,
      contentHash: snapshot.contentHash,
      accountId: snapshot.accountId,
      mode: effectivePublishMode(this.config, this.env),
    });
    const existing = this.store.findAttemptByIdempotencyKey(idempotencyKey);
    if (existing !== undefined) {
      if (existing.state === 'UNCERTAIN' || existing.state === 'PUBLISHING') {
        throw new MomentsError('UNCERTAIN_REQUIRES_MANUAL_CHECK', '已有发布结果不确定的尝试，必须先人工核对', {
          details: { attemptId: existing.attemptId, state: existing.state },
        });
      }
      if (existing.state === 'VERIFIED' || existing.state === 'PUBLISHED') {
        throw new MomentsError('DUPLICATE_PUBLISH', '相同内容已经发布过，禁止重复准备/发表', {
          details: { attemptId: existing.attemptId },
        });
      }
    }
    const { attempt } = this.store.createAttempt({
      attemptId: newId('att'),
      taskId,
      approvalId: approval?.approvalId ?? null,
      idempotencyKey,
      contentHash: snapshot.contentHash,
      assetManifestHash: snapshot.assetManifestHash,
      accountId: snapshot.accountId,
      mode: effectivePublishMode(this.config, this.env),
      now: this.clock(),
    });
    this.store.updateAttempt(attempt.attemptId, { state: 'PREPARING' });

    if (task.state !== 'QUEUED') {
      this.store.transitionTask(taskId, {
        nextState: 'QUEUED',
        actor,
        reason: '进入发布准备队列',
        metadata: { attemptId: attempt.attemptId },
      });
    }
    this.store.transitionTask(taskId, {
      nextState: 'PREPARING',
      actor,
      reason: '开始准备朋友圈编辑界面（不会发表）',
      metadata: { attemptId: attempt.attemptId, idempotencyKey },
      patch: {
        approvalId: approval?.approvalId ?? null,
        contentHash: snapshot.contentHash,
        assetManifestHash: snapshot.assetManifestHash,
        accountId: snapshot.accountId,
      },
    });

    const screenshotDir = path.join(this.dataDir, 'desktop', 'screenshots');
    mkdirSync(screenshotDir, { recursive: true });
    const assetPaths = snapshot.assets.map((asset) => asset.path);
    let result;
    try {
      result = await this.desktop.prepare({
        taskId,
        attemptId: attempt.attemptId,
        text: snapshot.text,
        assetPaths,
        visibility: snapshot.visibility,
        contentHash: snapshot.contentHash,
        accountId: snapshot.accountId,
        screenshotDir,
      });
    } catch (error) {
      // 准备阶段调用失败：桌面执行器可能部分完成编辑，但绝未点击发表。
      this.store.updateAttempt(attempt.attemptId, { state: 'FAILED', errorCode: error instanceof Error ? error.name : 'DESKTOP_UNAVAILABLE' });
      try {
        this.store.transitionTask(taskId, {
          nextState: 'QUEUED',
          actor,
          reason: '准备阶段调用失败，可重试（未发表）',
          metadata: { error: error instanceof Error ? error.message : 'unknown' },
        });
      } catch {
        // 状态可能已被取消
      }
      throw error instanceof MomentsError
        ? error
        : new MomentsError('DESKTOP_UNAVAILABLE', error instanceof Error ? error.message : '桌面执行器调用失败', {
            retryable: true,
          });
    }
    if (result.ok && result.prepared) {
      this.store.updateAttempt(attempt.attemptId, {
        state: 'PREPARED',
        screenshotPath: result.screenshotPath,
      });
      const updated = this.store.transitionTask(taskId, {
        nextState: 'PREPARED',
        actor: 'desktop',
        reason: '图文准备完成，等待所有者发表授权',
        metadata: { attemptId: attempt.attemptId, screenshotPath: result.screenshotPath },
      });
      this.store.appendAudit({
        at: this.clock().toISOString(),
        actor: 'desktop',
        action: 'desktop_prepared',
        taskId,
        previousState: 'PREPARING',
        nextState: 'PREPARED',
        reason: result.message,
        metadata: { attemptId: attempt.attemptId, imageCount: result.imageCount },
      });
      return {
        attempt: this.store.requireAttempt(attempt.attemptId),
        task: updated.task,
        prepared: true,
        screenshotPath: result.screenshotPath,
        textMatched: result.textMatched,
        imageCount: result.imageCount,
        warnings: result.warnings,
        idempotent: false,
      };
    }

    const retryable = result.errorCode !== null && RETRYABLE_DESKTOP_CODES.has(result.errorCode);
    this.store.updateAttempt(attempt.attemptId, { state: 'FAILED', errorCode: result.errorCode });
    try {
      this.store.transitionTask(taskId, {
        nextState: retryable ? 'QUEUED' : 'FAILED',
        actor: 'desktop',
        reason: result.message,
        metadata: { attemptId: attempt.attemptId, errorCode: result.errorCode },
        patch: { errorCode: result.errorCode, errorMessage: result.message },
      });
    } catch {
      // 状态已变化时保持审计与错误返回
    }
    throw new MomentsError(mapDesktopErrorCode(result.errorCode), result.message, {
      retryable,
      details: { attemptId: attempt.attemptId, errorCode: result.errorCode, warnings: result.warnings },
    });
  }

  /**
   * 执行发表。必须先 prepare（状态 PREPARED）。
   * 任何“可能已经点击”的异常都进入 UNCERTAIN，绝不自动重试。
   */
  async publish(taskId: string, approvalId: string | null, actor = 'owner'): Promise<PublishOutcome> {
    return this.exclusive(() => this.publishExclusive(taskId, approvalId, actor));
  }

  private async publishExclusive(taskId: string, approvalId: string | null, actor: string): Promise<PublishOutcome> {
    const task = this.store.requireTask(taskId);
    if (task.state === 'PUBLISHED') {
      const published = this.store.listAttemptsForTask(taskId).find((attempt) => attempt.state === 'VERIFIED' || attempt.state === 'PUBLISHED');
      if (published !== undefined) {
        return {
          attempt: published,
          task,
          submitted: true,
          verified: true,
          uncertain: false,
          message: '任务已发布（幂等返回）',
        };
      }
    }
    if (task.state === 'UNCERTAIN') {
      throw new MomentsError('UNCERTAIN_REQUIRES_MANUAL_CHECK', '任务处于 UNCERTAIN，禁止再次自动发表');
    }
    if (task.state !== 'PREPARED') {
      throw new MomentsError('CONFLICT', `任务状态 ${task.state} 不允许发表，请先准备`, {
        details: { taskId, state: task.state },
      });
    }
    const snapshot = this.snapshotFor(task);
    const approval = this.config.publishMode === 'APPROVAL_REQUIRED' ? this.findApproval(taskId, approvalId) : null;
    const attempts = this.store.listAttemptsForTask(taskId);
    const attempt = attempts.find((item) => item.state === 'PREPARED');
    if (attempt === undefined) {
      throw new MomentsError('CONFLICT', '没有已准备完成的发布尝试，请先调用 moments_prepare_desktop');
    }
    if (attempt.mode !== this.config.publishMode) {
      throw new MomentsError('CONFLICT', '准备后发表模式发生变化，请取消旧尝试并重新准备');
    }
    if (attempt.contentHash !== snapshot.contentHash) {
      throw new MomentsError('CONTENT_CHANGED', '准备后内容发生变化，必须重新准备并重新审批');
    }
    const context = await this.policyContext(task, snapshot, approval);
    assertPublishDecision(this.policy.evaluatePublish(context));
    this.assertTimeLimits();

    // 先核销审批，再点击；核销失败则不点击。
    this.store.runInTransaction(() => {
      if (approval) this.approvalService.consumeForPublish({
        approvalId: approval.approvalId,
        taskId,
        snapshot,
        now: this.clock(),
      });
      this.store.updateAttempt(attempt.attemptId, { state: 'PUBLISHING' });
      this.store.transitionTask(taskId, {
        nextState: 'PUBLISHING',
        actor,
        reason: approval ? '所有者授权发表，核销审批' : '按所有者选择的免审批模式发表已审核内容',
        metadata: {
          attemptId: attempt.attemptId,
          approvalId: approval?.approvalId ?? null,
          publishMode: this.config.publishMode,
          contentHash: snapshot.contentHash,
        },
      });
    });

    let result;
    try {
      result = await this.desktop.publish({
        taskId,
        attemptId: attempt.attemptId,
        contentHash: snapshot.contentHash,
        accountId: snapshot.accountId,
        approvalId: approval?.approvalId ?? '',
        publishMode: this.config.publishMode,
      });
    } catch (error) {
      // 请求可能已经到达执行器并点击；无法确认，必须 UNCERTAIN。
      this.markUncertain(taskId, attempt.attemptId, error instanceof Error ? error.message : '桌面执行器调用异常');
      throw new MomentsError(
        'UNCERTAIN_REQUIRES_MANUAL_CHECK',
        '发表请求异常中断，无法确认是否已点击；已标记 UNCERTAIN，禁止自动重试，请人工核对朋友圈',
        { details: { attemptId: attempt.attemptId } },
      );
    }

    if (result.submitted && result.verified) {
      const published = this.recordPublished(taskId, attempt.attemptId, snapshot, result.verification);
      const updated = this.store.transitionTask(taskId, {
        nextState: 'PUBLISHED',
        actor: 'desktop',
        reason: '发表并核验成功',
        metadata: { attemptId: attempt.attemptId, postId: published.postId },
      });
      this.store.updateAttempt(attempt.attemptId, {
        state: 'VERIFIED',
        screenshotPath: result.screenshotPath,
        verification: result.verification,
        errorCode: null,
      });
      return {
        attempt: this.store.requireAttempt(attempt.attemptId),
        task: updated.task,
        submitted: true,
        verified: true,
        uncertain: false,
        message: result.message || '已发表并核验成功',
      };
    }

    if (result.submitted) {
      this.markUncertain(taskId, attempt.attemptId, result.message || '已点击发表但无法核验');
      return {
        attempt: this.store.requireAttempt(attempt.attemptId),
        task: this.store.requireTask(taskId),
        submitted: true,
        verified: false,
        uncertain: true,
        message: result.message || '已点击发表但无法确认结果，进入 UNCERTAIN',
      };
    }

    this.store.updateAttempt(attempt.attemptId, { state: 'FAILED', errorCode: result.errorCode });
    try {
      this.store.transitionTask(taskId, {
        nextState: 'FAILED',
        actor: 'desktop',
        reason: result.message || '发表前停止',
        metadata: { attemptId: attempt.attemptId, errorCode: result.errorCode },
        patch: { errorCode: result.errorCode, errorMessage: result.message },
      });
    } catch {
      // 保持原始失败返回
    }
    throw new MomentsError(mapDesktopErrorCode(result.errorCode), result.message || '发表失败（未点击）', {
      details: { attemptId: attempt.attemptId, errorCode: result.errorCode },
    });
  }

  private markUncertain(taskId: string, attemptId: string, message: string): void {
    this.store.updateAttempt(attemptId, { state: 'UNCERTAIN', errorCode: 'UNCERTAIN' });
    try {
      this.store.transitionTask(taskId, {
        nextState: 'UNCERTAIN',
        actor: 'desktop',
        reason: `发表结果不确定：${message}`,
        metadata: { attemptId },
      });
    } catch (error) {
      this.logger.error('无法将任务标记为 UNCERTAIN', {
        taskId,
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
    this.store.appendAudit({
      at: this.clock().toISOString(),
      actor: 'desktop',
      action: 'publish_uncertain',
      taskId,
      previousState: 'PUBLISHING',
      nextState: 'UNCERTAIN',
      reason: message,
      metadata: { attemptId, instruction: '禁止自动重新发表，必须人工核对朋友圈' },
    });
  }

  private recordPublished(
    taskId: string,
    attemptId: string,
    snapshot: ApprovalSnapshot,
    verification: PublishVerification | null,
  ): PublishedPostRecord {
    const existing = this.store.getPublishedByAttempt(attemptId);
    if (existing !== undefined) return existing;
    const post: PublishedPostRecord = {
      postId: newId('post'),
      taskId,
      attemptId,
      text: snapshot.text,
      visibility: snapshot.visibility,
      accountId: snapshot.accountId,
      contentHash: snapshot.contentHash,
      publishedAt: verification?.publishedAt ?? this.clock().toISOString(),
      verified: verification?.verified === true,
    };
    this.store.insertPublished(post);
    return post;
  }

  /** 核验已点击的发布结果；只有确认成功才把 UNCERTAIN 收敛为 PUBLISHED。 */
  async verify(attemptId: string): Promise<{ attempt: PublishAttemptRecord; verification: PublishVerification; task: TaskRecord }> {
    const attempt = this.store.requireAttempt(attemptId);
    const task = this.store.requireTask(attempt.taskId);
    if (attempt.state === 'VERIFIED' || attempt.state === 'PUBLISHED') {
      const verification = attempt.verification ?? (await this.desktop.verify(attemptId));
      return { attempt, verification, task };
    }
    if (!['UNCERTAIN', 'PUBLISHING'].includes(attempt.state) && task.state !== 'PUBLISHING') {
      throw new MomentsError('CONFLICT', `尝试状态 ${attempt.state} 不允许核验`);
    }
    const verification = await this.desktop.verify(attemptId);
    if (verification.verified && task.state === 'UNCERTAIN') {
      const snapshot = this.snapshotFor(task);
      this.store.runInTransaction(() => {
        this.recordPublished(task.taskId, attemptId, snapshot, verification);
        this.store.updateAttempt(attemptId, { state: 'VERIFIED', verification, errorCode: null });
        this.store.transitionTask(task.taskId, {
          nextState: 'PUBLISHED',
          actor: 'system',
          reason: '人工核对/自动核验确认已发布',
          metadata: { attemptId },
        });
      });
      return {
        attempt: this.store.requireAttempt(attemptId),
        verification,
        task: this.store.requireTask(task.taskId),
      };
    }
    return { attempt, verification, task };
  }

  /**
   * 人工核对 UNCERTAIN：仅允许管理面调用。
   * resolution=PUBLISHED 表示人工在微信朋友圈确认已发布；FAILED 表示确认未发布。
   */
  resolveUncertain(
    attemptId: string,
    resolution: 'PUBLISHED' | 'FAILED',
    actor: 'owner',
    note: string,
  ): { attempt: PublishAttemptRecord; task: TaskRecord } {
    const attempt = this.store.requireAttempt(attemptId);
    const task = this.store.requireTask(attempt.taskId);
    if (attempt.state !== 'UNCERTAIN' || task.state !== 'UNCERTAIN') {
      throw new MomentsError('CONFLICT', '只有 UNCERTAIN 状态的发布尝试可以人工核对');
    }
    const now = this.clock().toISOString();
    return {
      attempt: this.store.runInTransaction(() => {
        if (resolution === 'PUBLISHED') {
          const snapshot = this.snapshotFor(task);
          this.recordPublished(task.taskId, attemptId, snapshot, {
            verified: true,
            method: 'manual-owner-check',
            publishedAt: now,
            visibleText: null,
            imageCount: null,
            evidencePath: null,
            notes: [note],
          });
          this.store.transitionTask(task.taskId, {
            nextState: 'PUBLISHED',
            actor,
            reason: `人工核对确认已发布：${note}`,
            metadata: { attemptId },
          });
          this.store.updateAttempt(attemptId, {
            state: 'VERIFIED',
            verification: {
              verified: true,
              method: 'manual-owner-check',
              publishedAt: now,
              visibleText: null,
              imageCount: null,
              evidencePath: null,
              notes: [note],
            },
          });
        } else {
          this.store.transitionTask(task.taskId, {
            nextState: 'FAILED',
            actor,
            reason: `人工核对确认未发布：${note}`,
            metadata: { attemptId },
          });
          this.store.updateAttempt(attemptId, { state: 'FAILED', errorCode: 'MANUALLY_CONFIRMED_NOT_PUBLISHED' });
        }
        this.store.appendAudit({
          at: now,
          actor,
          action: 'uncertain_resolved',
          taskId: task.taskId,
          previousState: 'UNCERTAIN',
          nextState: resolution,
          reason: note,
          metadata: { attemptId },
        });
        return this.store.requireAttempt(attemptId);
      }),
      task: this.store.requireTask(task.taskId),
    };
  }

  /** 取消任务：已点击的发表不可取消。 */
  async cancelTask(taskId: string, actor: 'owner' | 'agent' | 'system', reason: string): Promise<TaskRecord> {
    const task = this.store.requireTask(taskId);
    if (['PUBLISHED', 'CANCELLED', 'EXPIRED', 'FAILED', 'UNCERTAIN'].includes(task.state)) {
      if (task.state === 'UNCERTAIN') {
        throw new MomentsError('UNCERTAIN_REQUIRES_MANUAL_CHECK', 'UNCERTAIN 任务不能取消，必须先人工核对是否已发布');
      }
      return task;
    }
    const attempts = this.store.listAttemptsForTask(taskId);
    const active = attempts.find((attempt) => ['PLANNED', 'PREPARING', 'PREPARED', 'PUBLISHING'].includes(attempt.state));
    if (active?.state === 'PUBLISHING') {
      throw new MomentsError('UNCERTAIN_REQUIRES_MANUAL_CHECK', '发布点击可能已发出，不能取消，必须核验结果');
    }
    if (active !== undefined) {
      try {
        await this.desktop.cancel(active.attemptId);
      } catch (error) {
        this.logger.warn('桌面执行器取消请求失败', {
          attemptId: active.attemptId,
          error: error instanceof Error ? error.message : 'unknown',
        });
      }
      this.store.updateAttempt(active.attemptId, { state: 'CANCELLED' });
    }
    return this.store.transitionTask(taskId, {
      nextState: 'CANCELLED',
      actor,
      reason,
      metadata: {},
    }).task;
  }
}
