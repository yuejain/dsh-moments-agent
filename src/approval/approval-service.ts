/**
 * 审批服务：把不可变内容快照与一次性审批令牌绑定。
 *
 * 关键安全性质：
 * - 审批与 contentHash（文案 + 图片清单 + 可见范围 + 目标账号）绑定；
 * - 审批一次性使用，过期不可复用；
 * - 审批后任何内容变化都必须重新审批；
 * - Agent 不能调用任何“自我批准”方法；批准只能来自所有者命令或本机管理令牌。
 */
import { MomentsError } from '../domain/result.js';
import {
  computeAssetManifestHash,
  computeContentHash,
  newId,
  newNonce,
  sha256Hex,
} from '../domain/ids.js';
import type {
  ApprovalChannel,
  ApprovalRecord,
  ApprovalRequestView,
  MediaAssetRecord,
  MomentState,
  TaskRecord,
  Visibility,
} from '../domain/types.js';
import type { MomentsStore } from '../storage/store.js';
import type { MomentsConfig } from '../config.js';
import type { Logger, OwnerChannel } from '../adapters/types.js';
import { assertOwnerIdentity, formatApprovalMessage } from './owner-channels.js';

export interface ApprovalSnapshot {
  readonly text: string;
  readonly assets: readonly MediaAssetRecord[];
  readonly visibility: Visibility;
  readonly accountId: string;
  readonly contentHash: string;
  readonly assetManifestHash: string;
}

export interface CreateApprovalOptions {
  readonly taskId: string;
  readonly channel: OwnerChannel;
  readonly approvalChannel: ApprovalChannel;
  readonly now?: Date;
}

export interface CreateApprovalResult {
  readonly approval: ApprovalRecord;
  readonly request: ApprovalRequestView;
  readonly delivered: boolean;
}

export interface DecideApprovalOptions {
  readonly approvalId: string;
  readonly action: 'approve' | 'reject';
  readonly actor: 'wechat_owner' | 'manual_admin';
  readonly now?: Date;
  readonly reason?: string;
}

export interface ConsumeApprovalOptions {
  readonly approvalId: string;
  readonly taskId: string;
  readonly snapshot: ApprovalSnapshot;
  readonly now?: Date;
}

const APPROVAL_REVIEW_STATES: readonly MomentState[] = ['READY_FOR_APPROVAL'];

export function buildSnapshot(
  task: TaskRecord,
  text: string,
  assets: readonly MediaAssetRecord[],
  accountId: string,
): ApprovalSnapshot {
  const assetHashes = assets.map((asset) => asset.sha256);
  return {
    text,
    assets,
    visibility: task.visibility,
    accountId,
    contentHash: computeContentHash({
      text,
      assetHashes,
      visibility: task.visibility,
      accountId,
    }),
    assetManifestHash: computeAssetManifestHash(assetHashes),
  };
}

export class ApprovalService {
  constructor(
    private readonly store: MomentsStore,
    private readonly config: MomentsConfig,
    private readonly logger: Logger,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** 所有者身份：微信模式使用已校验 ownerWxid；本机手动模式使用 local-owner。 */
  ownerId(): string {
    return this.config.wechatAgent.ownerWxid !== '' ? this.config.wechatAgent.ownerWxid : 'local-owner';
  }

  /**
   * 为处于 READY_FOR_APPROVAL 的任务创建审批。
   * 快照实时重算，不能使用旧草稿或旧素材清单。
   */
  async createForTask(options: CreateApprovalOptions): Promise<CreateApprovalResult> {
    const task = this.store.requireTask(options.taskId);
    if (!APPROVAL_REVIEW_STATES.includes(task.state)) {
      throw new MomentsError('CONFLICT', `任务当前状态 ${task.state} 不允许申请审批`, {
        details: { taskId: task.taskId, state: task.state },
      });
    }
    const draft = this.store.requireCurrentDraft(task.taskId);
    if (draft.text.trim() === '') throw new MomentsError('INVALID_INPUT', '草稿正文为空，不能申请审批');
    const assets = this.store.listTaskAssets(task.taskId);
    const accountId = task.accountId ?? (await options.channel.currentAccountId());
    if (accountId === null || accountId === '') {
      throw new MomentsError('WECHAT_ACCOUNT_NOT_VERIFIED', '目标微信账号未确认，不能创建审批');
    }
    const snapshot = buildSnapshot(task, draft.text, assets, accountId);
    const now = options.now ?? this.clock();
    const ttlMs = this.config.policy.approvalTtlMinutes * 60_000;
    const approval: ApprovalRecord = {
      approvalId: newId('apr'),
      taskId: task.taskId,
      ownerId: this.ownerId(),
      contentHash: snapshot.contentHash,
      assetManifestHash: snapshot.assetManifestHash,
      visibility: snapshot.visibility,
      accountId,
      nonce: newNonce(),
      status: 'pending',
      channel: options.approvalChannel,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      decidedAt: null,
      consumedAt: null,
    };
    this.store.runInTransaction(() => {
      this.store.supersedePendingApprovals(task.taskId, now.toISOString());
      this.store.insertApproval(approval);
      this.store.updateTaskFields(task.taskId, {
        contentHash: snapshot.contentHash,
        assetManifestHash: snapshot.assetManifestHash,
        accountId,
        approvalId: approval.approvalId,
        visibility: snapshot.visibility,
      });
      this.store.appendAudit({
        at: now.toISOString(),
        actor: 'agent',
        action: 'approval_requested',
        taskId: task.taskId,
        previousState: task.state,
        nextState: task.state,
        reason: '创建审批请求',
        metadata: {
          approvalId: approval.approvalId,
          contentHash: snapshot.contentHash,
          assetManifestHash: snapshot.assetManifestHash,
          ttlMinutes: this.config.policy.approvalTtlMinutes,
        },
      });
    });
    const excerpt = draft.text.replace(/\s+/g, ' ').slice(0, 60);
    const request: ApprovalRequestView = {
      approvalId: approval.approvalId,
      taskId: task.taskId,
      contentHash: snapshot.contentHash,
      visibility: snapshot.visibility,
      expiresAt: approval.expiresAt,
      ownerMessage: formatApprovalMessage(
        {
          approvalId: approval.approvalId,
          taskId: task.taskId,
          contentHash: snapshot.contentHash,
          visibility: snapshot.visibility,
          expiresAt: approval.expiresAt,
          ownerMessage: '',
        },
        excerpt,
      ),
    };
    let delivered = false;
    try {
      const result = await options.channel.sendApprovalRequest(request);
      delivered = result.delivered;
    } catch (error) {
      this.logger.warn('审批通知发送失败，审批仍保持 pending', {
        taskId: task.taskId,
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
    return { approval: this.store.requireApproval(approval.approvalId), request, delivered };
  }

  /**
   * 所有者批准/拒绝。调用方必须先完成身份验证（见 assertOwnerIdentity / 管理令牌）。
   * 内容哈希、可见范围、目标账号任一变化都拒绝批准。
   */
  decide(options: DecideApprovalOptions): ApprovalRecord {
    const now = options.now ?? this.clock();
    // 先做只读校验；失败时把审批标记为 expired/superseded 并提交，
    // 不能把“标记失败原因”也放进随后抛错的事务里回滚。
    const approval = this.store.requireApproval(options.approvalId);
    if (approval.status !== 'pending') {
      throw new MomentsError(
        approval.status === 'expired' ? 'APPROVAL_EXPIRED' : 'APPROVAL_CONSUMED',
        `审批状态为 ${approval.status}，不能再次决定`,
        { details: { approvalId: approval.approvalId, status: approval.status } },
      );
    }
    if (new Date(approval.expiresAt).getTime() <= now.getTime()) {
      this.store.decideApproval(approval.approvalId, 'expired', ['pending'], now.toISOString());
      throw new MomentsError('APPROVAL_EXPIRED', '审批已过期，请重新申请');
    }
    const task = this.store.requireTask(approval.taskId);
    const draft = this.store.requireCurrentDraft(task.taskId);
    const assets = this.store.listTaskAssets(task.taskId);
    const snapshot = buildSnapshot(task, draft.text, assets, approval.accountId);
    if (
      snapshot.contentHash !== approval.contentHash ||
      snapshot.assetManifestHash !== approval.assetManifestHash ||
      snapshot.visibility !== approval.visibility ||
      snapshot.accountId !== approval.accountId
    ) {
      this.store.decideApproval(approval.approvalId, 'superseded', ['pending'], now.toISOString());
      throw new MomentsError('CONTENT_CHANGED', '审批后内容或账号发生变化，必须重新申请审批', {
        details: {
          approvalId: approval.approvalId,
          expectedHash: approval.contentHash,
          actualHash: snapshot.contentHash,
        },
      });
    }
    if (!APPROVAL_REVIEW_STATES.includes(task.state)) {
      throw new MomentsError('CONFLICT', `任务状态 ${task.state} 不允许审批决定`, {
        details: { taskId: task.taskId, state: task.state },
      });
    }
    return this.store.runInTransaction(() => {
      if (options.action === 'approve') {
        this.store.decideApproval(approval.approvalId, 'approved', ['pending'], now.toISOString());
        this.store.transitionTask(task.taskId, {
          nextState: 'APPROVED',
          actor: options.actor,
          reason: options.reason ?? '所有者批准',
          metadata: { approvalId: approval.approvalId, contentHash: approval.contentHash },
          patch: { approvalId: approval.approvalId },
        });
      } else {
        this.store.decideApproval(approval.approvalId, 'rejected', ['pending'], now.toISOString());
        this.store.transitionTask(task.taskId, {
          nextState: 'CANCELLED',
          actor: options.actor,
          reason: options.reason ?? '所有者拒绝',
          metadata: { approvalId: approval.approvalId },
        });
      }
      return this.store.requireApproval(approval.approvalId);
    });
  }

  /**
   * 发布前核销审批：一次性、未过期、哈希与账号一致。
   * 在真正点击发表前调用；核销后即使发布失败也不能复用。
   */
  consumeForPublish(options: ConsumeApprovalOptions): ApprovalRecord {
    const now = options.now ?? this.clock();
    return this.store.runInTransaction(() => {
      const approval = this.store.requireApproval(options.approvalId);
      if (approval.status === 'consumed') throw new MomentsError('APPROVAL_CONSUMED', '审批已被使用，不能重复发布');
      if (approval.status !== 'approved') {
        throw new MomentsError('APPROVAL_INVALID', `审批状态为 ${approval.status}，不能发布`, {
          details: { approvalId: approval.approvalId, status: approval.status },
        });
      }
      if (new Date(approval.expiresAt).getTime() <= now.getTime()) {
        this.store.decideApproval(approval.approvalId, 'expired', ['approved'], now.toISOString());
        throw new MomentsError('APPROVAL_EXPIRED', '审批已过期，不能发布');
      }
      if (approval.taskId !== options.taskId) {
        throw new MomentsError('APPROVAL_INVALID', '审批与任务不匹配');
      }
      if (approval.contentHash !== options.snapshot.contentHash) {
        throw new MomentsError('CONTENT_CHANGED', '审批绑定的内容哈希与当前内容不一致');
      }
      if (approval.assetManifestHash !== options.snapshot.assetManifestHash) {
        throw new MomentsError('CONTENT_CHANGED', '审批绑定的图片清单与当前素材不一致');
      }
      if (approval.accountId !== options.snapshot.accountId) {
        throw new MomentsError('ACCOUNT_MISMATCH', '审批绑定的微信账号与当前账号不一致');
      }
      if (approval.visibility !== options.snapshot.visibility) {
        throw new MomentsError('CONTENT_CHANGED', '审批绑定的可见范围与当前不一致');
      }
      const changes = this.store.runInTransaction(() =>
        this.store.decideApproval(approval.approvalId, 'consumed', ['approved'], now.toISOString()),
      );
      if (changes === undefined || changes.status !== 'consumed') {
        throw new MomentsError('APPROVAL_CONSUMED', '审批核销失败或已被使用');
      }
      this.store.appendAudit({
        at: now.toISOString(),
        actor: 'system',
        action: 'approval_consumed',
        taskId: options.taskId,
        previousState: null,
        nextState: null,
        reason: '发布前核销一次性审批',
        metadata: { approvalId: approval.approvalId, contentHash: approval.contentHash },
      });
      return changes;
    });
  }

  /** 清理过期审批（由调度器周期调用）。 */
  expireStale(now: Date = this.clock()): number {
    const pending = this.store.listPendingApprovals(200);
    let expired = 0;
    for (const approval of pending) {
      if (new Date(approval.expiresAt).getTime() > now.getTime()) continue;
      this.store.decideApproval(approval.approvalId, 'expired', ['pending'], now.toISOString());
      const task = this.store.getTask(approval.taskId);
      if (task !== undefined && task.state === 'READY_FOR_APPROVAL') {
        try {
          this.store.transitionTask(task.taskId, {
            nextState: 'EXPIRED',
            actor: 'system',
            reason: '审批过期',
            metadata: { approvalId: approval.approvalId },
          });
        } catch {
          // 状态可能已被其他操作迁移，保持审批已过期即可。
        }
      }
      expired += 1;
    }
    return expired;
  }

  validateOwner(approval: ApprovalRecord, actor: 'wechat_owner' | 'manual_admin', expectedOwner: string): void {
    if (approval.ownerId !== expectedOwner) {
      throw new MomentsError('APPROVAL_INVALID', '审批所有者与当前操作者不一致');
    }
    if (actor === 'wechat_owner' && approval.channel !== 'wechat_owner') {
      throw new MomentsError('APPROVAL_INVALID', '该审批不是通过微信所有者通道创建的');
    }
    if (actor === 'manual_admin' && approval.channel === 'wechat_owner') {
      // 本机管理页可以处理微信通道审批，但要求管理令牌已通过验证；此处仅记录审计。
      this.logger.info('本机管理页处理微信通道审批', { approvalId: approval.approvalId });
    }
  }
}

export { assertOwnerIdentity, sha256Hex };
