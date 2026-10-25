/** 重启恢复不重放任何外部操作；无法确定的发表必须人工核对。 */
import type { MomentsStore } from './store.js';
import { canTransition } from '../domain/state-machine.js';

export function recoverInterruptedTasks(store: MomentsStore): number {
  let recovered = 0;
  for (;;) {
    const tasks = store.listTasks(['DRAFTING', 'REVIEWING', 'QUEUED', 'PREPARING', 'PREPARED', 'PUBLISHING'], 500);
    if (!tasks.length) break;
    for (const task of tasks) {
      store.runInTransaction(() => {
        const next = task.state === 'PUBLISHING' ? 'UNCERTAIN'
          : canTransition(task.state, 'FAILED') ? 'FAILED' : 'CANCELLED';
        for (const attempt of store.listAttemptsForTask(task.taskId)) {
          if (['PLANNED', 'PREPARING', 'PREPARED', 'PUBLISHING'].includes(attempt.state)) {
            store.updateAttempt(attempt.attemptId, {
              state: next === 'UNCERTAIN' ? 'UNCERTAIN' : 'CANCELLED',
              errorCode: 'RESTART_INTERRUPTED',
            });
          }
        }
        store.supersedePendingApprovals(task.taskId, new Date().toISOString());
        store.transitionTask(task.taskId, {
          nextState: next, actor: 'system',
          reason: next === 'UNCERTAIN' ? '重启时发表结果未知，禁止补发，请人工核对' : '重启时操作未完成，已安全终止；请重新创建任务',
          patch: { errorCode: 'RESTART_INTERRUPTED' },
        });
        recovered++;
      });
    }
  }
  return recovered;
}

/** 只过期未执行的内容；绝不把 UNCERTAIN 当作可删除草稿。 */
export function expirePendingTasks(store: MomentsStore, now = new Date(), draftTtlMs = 7 * 86400_000, requireApproval = true): number {
  let expired = 0;
  for (const task of store.listOpenTasks(500)) {
    if (!canTransition(task.state, 'EXPIRED') || task.state === 'PREPARED') continue;
    const approvals = store.listApprovalsForTask(task.taskId);
    const approvalExpired = requireApproval && approvals.some((item) =>
      ['pending', 'approved'].includes(item.status) && new Date(item.expiresAt).getTime() <= now.getTime());
    const stale = new Date(task.updatedAt).getTime() + draftTtlMs <= now.getTime();
    if (!stale && !approvalExpired) continue;
    store.runInTransaction(() => {
      for (const approval of approvals) {
        store.decideApproval(approval.approvalId, 'expired', ['pending', 'approved'], now.toISOString());
      }
      for (const image of store.listImageTasksByTask(task.taskId)) {
        if (['PENDING', 'AWAITING_USER', 'GENERATING', 'REVIEWING'].includes(image.status)) {
          store.updateImageTask(image.imageTaskId, { status: 'EXPIRED' });
        }
      }
      store.transitionTask(task.taskId, { nextState: 'EXPIRED', actor: 'system', reason: '审批或草稿保存期限已到' });
      expired++;
    });
  }
  return expired;
}
