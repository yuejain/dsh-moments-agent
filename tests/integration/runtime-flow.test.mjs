import test from 'node:test';
import assert from 'node:assert/strict';
import { setupApproved, makeRuntime, silentLogger } from '../helpers/flow.mjs';
import {
  createTestContext,
  MockLlm,
  MockOwnerChannel,
  MockDesktop,
  MockImageFacade,
  IDEA_JSON,
  COMPOSE_JSON,
  REVIEW_JSON,
} from '../helpers/mock.mjs';
import { MomentsStore } from '../../dist/storage/store.js';

test('集成：选题 -> 文案 -> 审核 -> 审批 -> 准备 -> 发表 -> 核验', async () => {
  const setup = await setupApproved();
  try {
    const prepared = await setup.runtime.prepareDesktop(setup.taskId);
    assert.equal(prepared.task.state, 'PREPARED');
    const published = await setup.runtime.publish(setup.taskId);
    assert.equal(published.task.state, 'PUBLISHED');
    const preview = await setup.runtime.preview(setup.taskId);
    assert.equal(preview.text.includes('端侧模型'), true);
    const history = await setup.runtime.history(5);
    assert.equal(history.published.length, 1);
    const audit = setup.store.listAudit({ taskId: setup.taskId });
    const actions = audit.map((event) => event.action);
    assert.equal(actions.includes('approval_requested'), true);
    assert.equal(actions.includes('approval_consumed'), true);
  } finally {
    setup.cleanup();
  }
});

test('集成：没有值得表达的内容时选择沉默，不创建任务', async () => {
  const llm = new MockLlm({
    idea: [JSON.stringify({ ideas: [], silentReason: '今天没有值得公开表达的内容' })],
  });
  const context = await createTestContext({ llm });
  try {
    const runtime = makeRuntime(context);
    const result = await runtime.createIdea({});
    assert.equal(result.silent, true);
    assert.equal(result.task, null);
    assert.match(result.reason, /没有值得公开表达/);
    assert.equal(context.store.listTasks().length, 0);
    const audit = context.store.listAudit();
    assert.equal(audit.some((event) => event.action === 'idea_silence'), true);
  } finally {
    context.cleanup();
  }
});

test('集成：所有者暂停优先，非所有者命令被忽略', async () => {
  const context = await createTestContext();
  try {
    const runtime = makeRuntime(context);
    context.channel.push({ text: '/moments pause', senderWxid: 'wxid_attacker' });
    await runtime.processOwnerMessages(await context.channel.listOwnerMessages());
    assert.equal(runtime.control.paused, false);

    context.channel.push({ text: '/moments pause', senderWxid: 'wxid_owner' });
    await runtime.processOwnerMessages(await context.channel.listOwnerMessages());
    assert.equal(runtime.control.paused, true);

    await assert.rejects(
      () => runtime.createIdea({}),
      (error) => error.code === 'PAUSED',
    );

    context.channel.push({ text: '/moments resume', senderWxid: 'wxid_owner' });
    await runtime.processOwnerMessages(await context.channel.listOwnerMessages());
    assert.equal(runtime.control.paused, false);
  } finally {
    context.cleanup();
  }
});

test('集成：所有者通过微信命令批准审批', async () => {
  const llm = new MockLlm({ idea: [IDEA_JSON], compose: [COMPOSE_JSON], review: [REVIEW_JSON, REVIEW_JSON] });
  const context = await createTestContext({ llm, config: { publishMode: 'APPROVAL_REQUIRED' } });
  try {
    const runtime = makeRuntime(context);
    const created = await runtime.createIdea({});
    const taskId = created.task.taskId;
    await runtime.composeDraft(taskId);
    await runtime.reviewDraft(taskId);
    const approval = await runtime.requestApproval(taskId);
    context.channel.push({ text: `/moments approve ${approval.approval.approvalId}`, senderWxid: 'wxid_owner' });
    await runtime.processOwnerMessages(await context.channel.listOwnerMessages());
    assert.equal(context.store.requireApproval(approval.approval.approvalId).status, 'approved');
    assert.equal(context.store.requireTask(taskId).state, 'APPROVED');
  } finally {
    context.cleanup();
  }
});

test('集成：导入图片后进入 IMAGE_READY，审核未通过则拒绝关联', async () => {
  const llm = new MockLlm({ idea: [IDEA_JSON], compose: [COMPOSE_JSON], review: [REVIEW_JSON, REVIEW_JSON] });
  const image = new MockImageFacade();
  const context = await createTestContext({ llm, image });
  image.store = context.store;
  try {
    const runtime = makeRuntime(context);
    const created = await runtime.createIdea({});
    const taskId = created.task.taskId;
    await runtime.composeDraft(taskId);
    const imported = await runtime.importImage({ taskId, base64: Buffer.from('png').toString('base64'), mime: 'image/png' });
    assert.equal(imported.review.passed, true);
    assert.equal(context.store.requireTask(taskId).state, 'IMAGE_READY');
    assert.equal(context.store.listTaskAssets(taskId).length, 1);

    image.reviewPassed = false;
    await assert.rejects(
      () => runtime.importImage({ taskId, base64: Buffer.from('png2').toString('base64'), mime: 'image/png' }),
      (error) => error.code === 'IMAGE_REVIEW_FAILED',
    );
    assert.equal(context.store.listTaskAssets(taskId).length, 1);
  } finally {
    context.cleanup();
  }
});

test('集成：自主循环在没有调度开关时保持沉默', async () => {
  const llm = new MockLlm({ idea: [IDEA_JSON], compose: [COMPOSE_JSON], review: [REVIEW_JSON, REVIEW_JSON] });
  const context = await createTestContext({ llm, config: { scheduleEnabled: false } });
  try {
    const runtime = makeRuntime(context);
    const result = await runtime.autonomousCycle();
    assert.equal(result.created, false);
    assert.match(result.reason, /未启用/);
    assert.equal(llm.calls.length, 0);
  } finally {
    context.cleanup();
  }
});

test('集成：自主循环在启用时生成草稿并提交审批（不发表）', async () => {
  const llm = new MockLlm({ idea: [IDEA_JSON], compose: [COMPOSE_JSON], review: [REVIEW_JSON, REVIEW_JSON] });
  const context = await createTestContext({ llm, config: { scheduleEnabled: true, publishMode: 'APPROVAL_REQUIRED' } });
  try {
    const runtime = makeRuntime(context);
    const result = await runtime.autonomousCycle();
    assert.equal(result.created, true);
    assert.equal(context.store.requireTask(result.taskId).state, 'READY_FOR_APPROVAL');
    assert.equal(context.store.listPendingApprovals().length, 1);
    assert.equal(context.store.listPublished(10).length, 0);
  } finally {
    context.cleanup();
  }
});

test('集成：重启后任务与审计可恢复，且不会自动补发', async () => {
  const setup = await setupApproved();
  try {
    const taskBefore = setup.store.requireTask(setup.taskId);
    const auditBefore = setup.store.listAudit({ taskId: setup.taskId }).length;
    setup.store.close();
    const reopened = await MomentsStore.open(setup.dbPath);
    try {
      assert.equal(reopened.requireTask(setup.taskId).state, taskBefore.state);
      assert.equal(reopened.listAudit({ taskId: setup.taskId }).length, auditBefore);
      assert.equal(reopened.listPublished(10).length, 0);
      const open = reopened.listOpenTasks(10);
      assert.equal(open.some((task) => task.taskId === setup.taskId), true);
    } finally {
      reopened.close();
    }
  } finally {
    // store 已关闭，cleanup 再次 close 会被忽略
    setup.cleanup();
  }
});
