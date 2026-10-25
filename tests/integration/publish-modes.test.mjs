import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, MockDesktop, MockLlm, IDEA_JSON, COMPOSE_JSON, REVIEW_JSON } from '../helpers/mock.mjs';
import { makeRuntime } from '../helpers/flow.mjs';
import { expirePendingTasks } from '../../dist/storage/recovery.js';

async function reviewed(mode, extra = {}) {
  const ctx = await createTestContext({ config: { publishMode: mode, ...extra },
    desktop: new MockDesktop({ health: { allowPublish: true } }),
    llm: new MockLlm({ idea: [IDEA_JSON], compose: [COMPOSE_JSON], review: [REVIEW_JSON, REVIEW_JSON] }) });
  ctx.runtime = makeRuntime(ctx, { clock: () => new Date('2026-10-20T04:00:30.000Z') });
  const idea = await ctx.runtime.createIdea({ topic: '科学与想象力' });
  ctx.taskId = idea.task.taskId;
  await ctx.runtime.composeDraft(ctx.taskId);
  await ctx.runtime.reviewDraft(ctx.taskId);
  return ctx;
}

test('仅准备：无审批可准备，任何发表请求均不得点击', async () => {
  const ctx = await reviewed('PREPARE_ONLY');
  try {
    assert.equal((await ctx.runtime.prepareDesktop(ctx.taskId)).prepared, true);
    await assert.rejects(ctx.runtime.publish(ctx.taskId), (e) => e.code === 'PUBLISH_MODE_DISABLED');
    assert.equal(ctx.store.listApprovalsForTask(ctx.taskId).length, 0);
    assert.equal(ctx.desktop.calls.filter((c) => c.method === 'publish').length, 0);
  } finally { ctx.cleanup(); }
});

test('审批后发表：必须逐条批准并在发表前核销审批', async () => {
  const ctx = await reviewed('APPROVAL_REQUIRED');
  try {
    await assert.rejects(ctx.runtime.prepareDesktop(ctx.taskId));
    const result = await ctx.runtime.requestApproval(ctx.taskId);
    ctx.runtime.decideApproval(result.approval.approvalId, 'approve', 'wechat_owner');
    await ctx.runtime.prepareDesktop(ctx.taskId);
    assert.equal((await ctx.runtime.publish(ctx.taskId)).verified, true);
    assert.equal(ctx.store.requireApproval(result.approval.approvalId).status, 'consumed');
  } finally { ctx.cleanup(); }
});

test('不审批直接发表：经审核后自动准备并发表，不伪造人工审批', async () => {
  const ctx = await reviewed('POLICY_AUTONOMOUS');
  try {
    assert.equal(ctx.store.requireTask(ctx.taskId).state, 'READY_TO_PUBLISH');
    assert.ok(ctx.store.listOpenTasks().some((task) => task.taskId === ctx.taskId));
    assert.equal((await ctx.runtime.publish(ctx.taskId)).verified, true);
    assert.equal(ctx.store.listApprovalsForTask(ctx.taskId).length, 0);
    assert.equal(ctx.store.listAttemptsForTask(ctx.taskId)[0].approvalId, null);
    const calls = ctx.desktop.calls.filter((c) => c.method === 'publish');
    assert.equal(calls.length, 1);
    await ctx.runtime.publish(ctx.taskId);
    assert.equal(ctx.desktop.calls.filter((c) => c.method === 'publish').length, 1);
  } finally { ctx.cleanup(); }
});

test('切换到免审批后不再依赖旧审批期限，草稿保存期限仍有效', async () => {
  const ctx = await reviewed('APPROVAL_REQUIRED');
  try {
    const { approval } = await ctx.runtime.requestApproval(ctx.taskId);
    ctx.runtime.updatePublishMode({ mode: 'POLICY_AUTONOMOUS' });
    const afterApproval = new Date(new Date(approval.expiresAt).getTime() + 1);
    assert.equal(expirePendingTasks(ctx.store, afterApproval, 7 * 86400_000, false), 0);
    assert.equal((await ctx.runtime.publish(ctx.taskId)).verified, true);
  } finally { ctx.cleanup(); }
  const stale = await reviewed('POLICY_AUTONOMOUS');
  try {
    assert.equal(expirePendingTasks(stale.store, new Date('2030-01-01T00:00:00Z'), 7 * 86400_000, false), 1);
    assert.equal(stale.store.requireTask(stale.taskId).state, 'EXPIRED');
  } finally { stale.cleanup(); }
});

test('从免审批切回审批模式后必须取得新的有效审批', async () => {
  const ctx = await reviewed('POLICY_AUTONOMOUS');
  try {
    ctx.runtime.updatePublishMode({ mode: 'APPROVAL_REQUIRED' });
    await assert.rejects(ctx.runtime.prepareDesktop(ctx.taskId));
    const { approval } = await ctx.runtime.requestApproval(ctx.taskId);
    ctx.runtime.decideApproval(approval.approvalId, 'approve', 'wechat_owner');
    await ctx.runtime.prepareDesktop(ctx.taskId);
    assert.equal((await ctx.runtime.publish(ctx.taskId)).verified, true);
  } finally { ctx.cleanup(); }
});

test('免审批仍拒绝审核后内容篡改和 Kill Switch', async () => {
  const ctx = await reviewed('POLICY_AUTONOMOUS');
  try {
    ctx.runtime.control.setKillSwitch(true, 'owner', 'test');
    await assert.rejects(ctx.runtime.publish(ctx.taskId), (e) => e.code === 'KILL_SWITCH_ACTIVE');
    ctx.runtime.control.setKillSwitch(false, 'owner', 'test');
    const draft = ctx.store.requireCurrentDraft(ctx.taskId);
    ctx.store.updateDraftText(draft.draftId, draft.text + '篡改', 'x'.repeat(64), draft.tone);
    await assert.rejects(ctx.runtime.publish(ctx.taskId), (e) => e.code === 'CONTENT_CHANGED');
    assert.equal(ctx.desktop.calls.filter((c) => c.method === 'publish').length, 0);
  } finally { ctx.cleanup(); }
});

test('模式选择持久化、拒绝旧窗口覆盖及准备中的切换', async () => {
  const ctx = await reviewed('PREPARE_ONLY');
  try {
    ctx.runtime.updatePublishMode({ mode: 'PREPARE_ONLY' });
    assert.equal(ctx.store.getSetting('publish_mode'), 'PREPARE_ONLY');
    ctx.runtime.updatePublishMode({ mode: 'POLICY_AUTONOMOUS', expectedMode: 'PREPARE_ONLY' });
    assert.equal(makeRuntime(ctx).publishModeView().mode, 'POLICY_AUTONOMOUS');
    await assert.rejects(async () => ctx.runtime.updatePublishMode({ mode: 'APPROVAL_REQUIRED', expectedMode: 'PREPARE_ONLY' }));
    await ctx.runtime.prepareDesktop(ctx.taskId);
    assert.throws(() => ctx.runtime.updatePublishMode({ mode: 'APPROVAL_REQUIRED' }), /先取消或完成/);
    assert.equal(ctx.runtime.publishModeView().mode, 'POLICY_AUTONOMOUS');
  } finally { ctx.cleanup(); }
});

test('免审批定时发送复用审核快照和原 Publisher', async () => {
  const ctx = await reviewed('POLICY_AUTONOMOUS', { policy: { humanize: { enabled: true, delaySeconds: [0, 0], jitterSeconds: 0, minIntervalSeconds: 0 } } });
  try {
    await ctx.runtime.humanizeTick();
    const result = await ctx.runtime.humanizeTick();
    assert.equal(result.action, 'published');
    assert.equal(ctx.store.listApprovalsForTask(ctx.taskId).length, 0);
  } finally { ctx.cleanup(); }
});

test('免审批结果不确定时禁止再次发表', async () => {
  const ctx = await reviewed('POLICY_AUTONOMOUS');
  try {
    ctx.desktop.publishValue = { ...ctx.desktop.publishValue, submitted: true, verified: false, uncertain: true, verification: null };
    assert.equal((await ctx.runtime.publish(ctx.taskId)).uncertain, true);
    await assert.rejects(ctx.runtime.publish(ctx.taskId), (e) => e.code === 'UNCERTAIN_REQUIRES_MANUAL_CHECK');
    assert.equal(ctx.desktop.calls.filter((c) => c.method === 'publish').length, 1);
  } finally { ctx.cleanup(); }
});

test('免审批仍执行每日上限与锁屏保护', async () => {
  const ctx = await reviewed('POLICY_AUTONOMOUS');
  ctx.config.policy.dailyLimit = 0;
  try {
    await assert.rejects(ctx.runtime.publish(ctx.taskId), (e) => e.code === 'POLICY_DENIED');
    assert.equal(ctx.desktop.calls.filter((c) => c.method === 'publish').length, 0);
  } finally { ctx.cleanup(); }
  const locked = await reviewed('POLICY_AUTONOMOUS');
  try {
    locked.desktop.statusValue.locked = true;
    await assert.rejects(locked.runtime.publish(locked.taskId), (e) => e.code === 'DESKTOP_PRECONDITION');
    assert.equal(locked.desktop.calls.filter((c) => c.method === 'publish').length, 0);
  } finally { locked.cleanup(); }
});
