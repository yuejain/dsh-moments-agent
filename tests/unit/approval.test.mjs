import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MomentsStore } from '../../dist/storage/store.js';
import { parseConfig } from '../../dist/config.js';
import { ApprovalService } from '../../dist/approval/approval-service.js';
import { MockOwnerChannel } from '../helpers/mock.mjs';
import { computeAssetManifestHash, computeContentHash } from '../../dist/domain/ids.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} };

async function setupTask(options = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'moments-approval-'));
  const store = await MomentsStore.open(path.join(dir, 'db.sqlite'));
  let now = options.now ?? new Date('2026-01-01T00:00:00.000Z');
  const clock = () => now;
  const config = parseConfig({
    policy: { approvalTtlMinutes: options.ttl ?? 60 },
    wechatAgent: { ownerWxid: 'wxid_owner', account: 'wxid_test' },
  });
  const channel = new MockOwnerChannel({ accountId: 'wxid_test' });
  const service = new ApprovalService(store, config, logger, clock);
  const taskId = 'task_1';
  store.createTask(taskId);
  store.transitionTask(taskId, { nextState: 'DRAFTING', actor: 'agent', reason: 'x' });
  const text = options.text ?? '第一条测试文案';
  const contentHash = computeContentHash({ text, assetHashes: [], visibility: 'PUBLIC', accountId: 'wxid_test' });
  const draftId = 'draft_1';
  store.createDraft(
    {
      draftId,
      taskId,
      ideaId: 'idea_1',
      version: 1,
      text,
      tone: '',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
    contentHash,
  );
  store.transitionTask(taskId, {
    nextState: 'DRAFT_READY',
    actor: 'agent',
    reason: 'x',
    patch: { draftId },
  });
  store.transitionTask(taskId, { nextState: 'REVIEWING', actor: 'agent', reason: 'x' });
  store.transitionTask(taskId, {
    nextState: 'READY_FOR_APPROVAL',
    actor: 'agent',
    reason: 'x',
    patch: {
      accountId: 'wxid_test',
      contentHash,
      assetManifestHash: computeAssetManifestHash([]),
    },
  });
  return {
    dir,
    store,
    config,
    channel,
    service,
    taskId,
    draftId,
    contentHash,
    setNow(value) {
      now = value;
    },
    cleanup() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('审批：创建后绑定内容哈希与账号，批准进入 APPROVED', async () => {
  const ctx = await setupTask();
  try {
    const created = await ctx.service.createForTask({
      taskId: ctx.taskId,
      channel: ctx.channel,
      approvalChannel: 'wechat_owner',
    });
    assert.equal(created.approval.status, 'pending');
    assert.equal(created.approval.contentHash, ctx.contentHash);
    assert.equal(created.approval.accountId, 'wxid_test');
    assert.equal(created.delivered, true);
    assert.equal(ctx.channel.sent.length, 1);
    const approved = ctx.service.decide({ approvalId: created.approval.approvalId, action: 'approve', actor: 'wechat_owner' });
    assert.equal(approved.status, 'approved');
    assert.equal(ctx.store.requireTask(ctx.taskId).state, 'APPROVED');
  } finally {
    ctx.cleanup();
  }
});

test('审批：批准后修改文案必须重新审批', async () => {
  const ctx = await setupTask();
  try {
    const created = await ctx.service.createForTask({
      taskId: ctx.taskId,
      channel: ctx.channel,
      approvalChannel: 'wechat_owner',
    });
    ctx.store.updateDraftText(ctx.draftId, '被修改后的文案', 'x'.repeat(64));
    assert.throws(
      () => ctx.service.decide({ approvalId: created.approval.approvalId, action: 'approve', actor: 'wechat_owner' }),
      (error) => error.code === 'CONTENT_CHANGED',
    );
    assert.equal(ctx.store.requireApproval(created.approval.approvalId).status, 'superseded');
    assert.equal(ctx.store.requireTask(ctx.taskId).state, 'READY_FOR_APPROVAL');
  } finally {
    ctx.cleanup();
  }
});

test('审批：过期后拒绝批准', async () => {
  const ctx = await setupTask({ ttl: 10 });
  try {
    const created = await ctx.service.createForTask({
      taskId: ctx.taskId,
      channel: ctx.channel,
      approvalChannel: 'wechat_owner',
    });
    ctx.setNow(new Date('2026-01-01T00:11:00.000Z'));
    assert.throws(
      () => ctx.service.decide({ approvalId: created.approval.approvalId, action: 'approve', actor: 'wechat_owner' }),
      (error) => error.code === 'APPROVAL_EXPIRED',
    );
    assert.equal(ctx.store.requireApproval(created.approval.approvalId).status, 'expired');
  } finally {
    ctx.cleanup();
  }
});

test('审批：一次性核销，第二次使用被拒绝', async () => {
  const ctx = await setupTask();
  try {
    const created = await ctx.service.createForTask({
      taskId: ctx.taskId,
      channel: ctx.channel,
      approvalChannel: 'wechat_owner',
    });
    ctx.service.decide({ approvalId: created.approval.approvalId, action: 'approve', actor: 'wechat_owner' });
    assert.equal(ctx.store.requireTask(ctx.taskId).state, 'APPROVED');
    const snapshot = {
      text: '第一条测试文案',
      assets: [],
      visibility: 'PUBLIC',
      accountId: 'wxid_test',
      contentHash: ctx.contentHash,
      assetManifestHash: computeAssetManifestHash([]),
    };
    const consumed = ctx.service.consumeForPublish({
      approvalId: created.approval.approvalId,
      taskId: ctx.taskId,
      snapshot,
      now: new Date('2026-01-01T00:00:10.000Z'),
    });
    assert.equal(consumed.status, 'consumed');
    assert.throws(
      () =>
        ctx.service.consumeForPublish({
          approvalId: created.approval.approvalId,
          taskId: ctx.taskId,
          snapshot,
          now: new Date('2026-01-01T00:00:20.000Z'),
        }),
      (error) => error.code === 'APPROVAL_CONSUMED',
    );
  } finally {
    ctx.cleanup();
  }
});

test('审批：拒绝会取消任务且不可复用', async () => {
  const ctx = await setupTask();
  try {
    const created = await ctx.service.createForTask({
      taskId: ctx.taskId,
      channel: ctx.channel,
      approvalChannel: 'wechat_owner',
    });
    ctx.service.decide({ approvalId: created.approval.approvalId, action: 'reject', actor: 'wechat_owner' });
    assert.equal(ctx.store.requireApproval(created.approval.approvalId).status, 'rejected');
    assert.equal(ctx.store.requireTask(ctx.taskId).state, 'CANCELLED');
    assert.throws(
      () => ctx.service.decide({ approvalId: created.approval.approvalId, action: 'approve', actor: 'wechat_owner' }),
      (error) => error.code === 'APPROVAL_CONSUMED',
    );
  } finally {
    ctx.cleanup();
  }
});
