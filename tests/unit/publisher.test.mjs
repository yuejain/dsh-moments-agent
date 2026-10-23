import test from 'node:test';
import assert from 'node:assert/strict';
import { setupApproved, setupPrepared, makeRuntime, silentLogger } from '../helpers/flow.mjs';
import { MockDesktop, createTestContext, MockLlm, MockOwnerChannel, MockImageFacade, IDEA_JSON, COMPOSE_JSON, REVIEW_JSON } from '../helpers/mock.mjs';

test('发布：PREPARE_ONLY 允许准备但拒绝发表', async () => {
  const setup = await setupApproved({
    config: { publishMode: 'PREPARE_ONLY' },
  });
  try {
    const prepared = await setup.runtime.prepareDesktop(setup.taskId);
    assert.equal(prepared.task.state, 'PREPARED');
    assert.equal(prepared.prepared, true);
    await assert.rejects(
      () => setup.runtime.publish(setup.taskId),
      (error) => error.code === 'PUBLISH_MODE_DISABLED',
    );
    // 未点击发表，任务仍停留在 PREPARED，可取消。
    assert.equal(setup.store.requireTask(setup.taskId).state, 'PREPARED');
    const desktopPublishCalls = setup.desktop.calls.filter((call) => call.method === 'publish');
    assert.equal(desktopPublishCalls.length, 0);
  } finally {
    setup.cleanup();
  }
});

test('发布：有审批且执行器允许时完整发布并写入已发布记录', async () => {
  const setup = await setupPrepared();
  try {
    const result = await setup.runtime.publish(setup.taskId);
    assert.equal(result.submitted, true);
    assert.equal(result.verified, true);
    assert.equal(result.uncertain, false);
    assert.equal(result.task.state, 'PUBLISHED');
    const published = setup.store.listPublished(10);
    assert.equal(published.length, 1);
    assert.equal(published[0].taskId, setup.taskId);
    assert.equal(published[0].verified, true);
    const approval = setup.store.requireApproval(setup.approvalId);
    assert.equal(approval.status, 'consumed');
    const attempts = setup.store.listAttemptsForTask(setup.taskId);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].state, 'VERIFIED');
  } finally {
    setup.cleanup();
  }
});

test('发布：点击后无法核验进入 UNCERTAIN，禁止自动重试', async () => {
  const desktop = new MockDesktop({
    health: { allowPublish: true },
    publishResult: {
      submitted: true,
      verified: false,
      uncertain: true,
      errorCode: 'UNCERTAIN',
      message: '已点击但无法核验',
      verification: null,
    },
  });
  const setup = await setupPrepared({ desktop });
  try {
    const result = await setup.runtime.publish(setup.taskId);
    assert.equal(result.submitted, true);
    assert.equal(result.uncertain, true);
    assert.equal(result.task.state, 'UNCERTAIN');
    assert.equal(setup.store.listPublished(10).length, 0);
    await assert.rejects(
      () => setup.runtime.publish(setup.taskId),
      (error) => error.code === 'UNCERTAIN_REQUIRES_MANUAL_CHECK',
    );
    const attempts = setup.store.listAttemptsForTask(setup.taskId);
    assert.equal(attempts[0].state, 'UNCERTAIN');
    const publishCalls = desktop.calls.filter((call) => call.method === 'publish');
    assert.equal(publishCalls.length, 1);
  } finally {
    setup.cleanup();
  }
});

test('发布：账号不一致时拒绝点击', async () => {
  const desktop = new MockDesktop({ health: { allowPublish: true } });
  const setup = await setupApproved({ desktop });
  try {
    const prepared = await setup.runtime.prepareDesktop(setup.taskId);
    assert.equal(prepared.task.state, 'PREPARED');
    // 准备后切换微信登录账号：必须在点击前发现并拒绝。
    desktop.statusValue = { ...desktop.statusValue, accountId: 'wxid_other' };
    await assert.rejects(
      () => setup.runtime.publish(setup.taskId),
      (error) => error.code === 'ACCOUNT_MISMATCH',
    );
    assert.equal(desktop.calls.filter((call) => call.method === 'publish').length, 0);
  } finally {
    setup.cleanup();
  }
});

test('发布：执行器未允许发表时拒绝，即使审批有效', async () => {
  const desktop = new MockDesktop({ health: { allowPublish: false } });
  const setup = await setupApproved({ desktop });
  try {
    const prepared = await setup.runtime.prepareDesktop(setup.taskId);
    assert.equal(prepared.task.state, 'PREPARED');
    await assert.rejects(
      () => setup.runtime.publish(setup.taskId),
      (error) => error.code === 'PUBLISH_MODE_DISABLED',
    );
    assert.equal(desktop.calls.filter((call) => call.method === 'publish').length, 0);
  } finally {
    setup.cleanup();
  }
});

test('发布：内容哈希重复时策略拒绝', async () => {
  const setup = await setupApproved();
  try {
    const snapshot = {
      text: '第一条测试文案',
      assets: [],
      visibility: 'PUBLIC',
      accountId: 'wxid_test',
      contentHash: 'hash',
      assetManifestHash: 'manifest',
    };
    const prepared = await setup.runtime.prepareDesktop(setup.taskId);
    assert.equal(prepared.task.state, 'PREPARED');
    // 伪造已发布记录后再次尝试发表，应被重复内容保护拒绝。
    setup.store.insertPublished({
      postId: 'post_dup',
      taskId: 'task_other',
      attemptId: 'att_other',
      text: '第一条测试文案',
      visibility: 'PUBLIC',
      accountId: 'wxid_test',
      contentHash: prepared.attempt.contentHash,
      publishedAt: new Date().toISOString(),
      verified: true,
    });
    await assert.rejects(
      () => setup.runtime.publish(setup.taskId),
      (error) => error.code === 'DUPLICATE_PUBLISH',
    );
    assert.equal(setup.desktop.calls.filter((call) => call.method === 'publish').length, 0);
    void snapshot;
  } finally {
    setup.cleanup();
  }
});
