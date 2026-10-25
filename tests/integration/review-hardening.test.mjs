import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRuntime, setupApproved, setupPrepared } from '../helpers/flow.mjs';
import { createTestContext, MockLlm, IDEA_JSON, COMPOSE_JSON, REVIEW_JSON } from '../helpers/mock.mjs';
import { recoverInterruptedTasks, expirePendingTasks } from '../../dist/storage/recovery.js';
import { createDedicatedSession } from '../../dist/adapters/dsh/session.js';
import { assertOwnerIdentity } from '../../dist/approval/owner-channels.js';
import { MomentsStore } from '../../dist/storage/store.js';
import { createImageFacade } from '../../dist/image/index.js';
import { makePatternPng } from '../../fixtures/images/png.mjs';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { ContentReviewer } from '../../dist/brain/content-reviewer.js';

test('模型拒绝、未明确通过或不可用均不能被本地通过覆盖', async () => {
  const input = { text: '关于技术的一个想法', idea: { topic: '技术', sourceType: 'manual',
    sourceEvidence: '所有者材料', scores: { persona: 0.8 } }, context: {} };
  const logger = { warn() {} };
  for (const response of [
    '{"passed":false,"flags":["未经核实的事实"]}',
    '{"passed":false,"flags":["攻击歧视"]}', '{}', 'invalid json',
  ]) {
    const llm = new MockLlm({ review: [response] });
    const reviewer = new ContentReviewer({ evaluateDraft: () => ({ allowed: true }) }, llm, logger, { useLlmReview: true });
    assert.equal((await reviewer.review(input)).passed, false);
    assert.match(llm.calls[0].messages[0].content, /所有者材料/);
  }
  const reviewer = new ContentReviewer({ evaluateDraft: () => ({ allowed: true }) }, null, logger, { useLlmReview: true });
  assert.equal((await reviewer.review(input)).passed, false);
});

test('重写撤销旧审批并保留版本；准备后不能再重写', async () => {
  const llm = new MockLlm({ idea: [IDEA_JSON], compose: [COMPOSE_JSON, COMPOSE_JSON],
    review: [REVIEW_JSON, REVIEW_JSON, REVIEW_JSON, REVIEW_JSON] });
  const ctx = await setupApproved({ llm });
  try {
    const draft = ctx.store.requireCurrentDraft(ctx.taskId);
    const result = await ctx.runtime.composeAndReview(ctx.taskId, { feedback: '更简洁' });
    assert.equal(ctx.store.requireApproval(ctx.approvalId).status, 'superseded');
    assert.equal(ctx.store.requireCurrentDraft(ctx.taskId).draftId, draft.draftId);
    assert.equal(ctx.store.listDraftVersions(draft.draftId).length, 2);
    assert.equal(result.review.passed, true);
    assert.notEqual(result.approval.approval.approvalId, ctx.approvalId);
    await assert.rejects(() => ctx.runtime.publish(ctx.taskId, ctx.approvalId));
  } finally { ctx.cleanup(); }
  const prepared = await setupPrepared();
  try { await assert.rejects(() => prepared.runtime.composeDraft(prepared.taskId)); }
  finally { prepared.cleanup(); }
});

test('恢复：发表中进入 UNCERTAIN，禁止补发；准备中安全终止', async () => {
  for (const state of ['PREPARED', 'PUBLISHING']) {
    const setup = await setupPrepared();
    try {
      if (state === 'PUBLISHING') {
        setup.store.transitionTask(setup.taskId, { nextState: state, actor: 'system', reason: '模拟进程崩溃' });
        setup.store.updateAttempt(setup.prepared.attempt.attemptId, { state });
      }
      assert.equal(recoverInterruptedTasks(setup.store), 1);
      assert.equal(setup.store.requireTask(setup.taskId).state, state === 'PUBLISHING' ? 'UNCERTAIN' : 'CANCELLED');
      assert.equal(recoverInterruptedTasks(setup.store), 0);
      await assert.rejects(() => setup.runtime.publish(setup.taskId));
      assert.equal(setup.desktop.calls.some((call) => call.method === 'publish'), false);
    } finally { setup.cleanup(); }
  }
});

test('命令：重建运行时不重复执行；群聊及未验证账号被拒绝', async () => {
  const ctx = await createTestContext();
  try {
    const message = { messageId: 'm1', accountId: 'wxid_test', senderWxid: 'wxid_owner', text: '/moments pause', receivedAt: new Date().toISOString() };
    const first = makeRuntime(ctx);
    assert.equal((await first.processOwnerMessages([message])).handled, 1);
    first.controlAction('resume', '测试');
    const second = makeRuntime(ctx);
    assert.equal((await second.processOwnerMessages([message])).handled, 0);
    assert.equal(second.control.paused, false);
    for (const mutation of [{ isGroup: true }, { accountId: '' }]) {
      assert.throws(() => assertOwnerIdentity({ ...message, ...mutation }, { ownerWxid: 'wxid_owner', accountId: 'wxid_test' }, ctx.logger));
    }
    assert.throws(() => assertOwnerIdentity(message, { ownerWxid: 'wxid_owner', accountId: null }, ctx.logger));
  } finally { ctx.cleanup(); }
});

test('调度：并发唤醒只创建一个草稿，模型等待期间暂停不创建任务', async () => {
  const llm = new MockLlm({ idea: [IDEA_JSON], compose: [COMPOSE_JSON], review: [REVIEW_JSON, REVIEW_JSON] });
  const ctx = await createTestContext({ llm, config: { scheduleEnabled: true } });
  try {
    const runtime = makeRuntime(ctx);
    const results = await Promise.all([runtime.autonomousCycle(), runtime.autonomousCycle()]);
    assert.equal(results.filter((r) => r.created).length, 1);
    assert.equal(ctx.store.listTasks().length, 1);
  } finally { ctx.cleanup(); }
  const ctx2 = await createTestContext();
  try {
    let release;
    const blocked = { complete: () => new Promise((resolve) => { release = resolve; }), checkCapabilities: async () => ({ status: 'ok' }) };
    const runtime = makeRuntime(ctx2, { llm: blocked });
    const pending = runtime.createIdea({});
    while (!release) await new Promise((resolve) => setImmediate(resolve));
    runtime.controlAction('pause', '模型运行中暂停');
    release({ text: IDEA_JSON });
    await assert.rejects(pending, (error) => error.code === 'PAUSED');
    assert.equal(ctx2.store.listTasks().length, 0);
  } finally { ctx2.cleanup(); }
});

test('记忆：保存后进入创作上下文，配置持久化但不能更改发表权限', async () => {
  const llm = new MockLlm({ idea: [IDEA_JSON], compose: [COMPOSE_JSON], review: [REVIEW_JSON] });
  const ctx = await createTestContext({ llm });
  try {
    const runtime = makeRuntime(ctx);
    const memory = runtime.saveMemory({ kind: 'persona', key: '偏好', value: '喜欢简洁的科学比喻' });
    runtime.updatePersona({ soul: '喜欢科学，不编造事实', visualStyle: '蓝白配色' });
    runtime.updateSchedule({ scheduleEnabled: true, scheduler: { tickSeconds: 90, ideaProbability: 0.3, jitterSeconds: 10 } });
    assert.throws(() => runtime.updateSchedule({ publishMode: 'POLICY_AUTONOMOUS' }));
    const idea = await runtime.createIdea({});
    await runtime.composeDraft(idea.task.taskId);
    assert.match(llm.calls.find((call) => call.purpose === 'compose').system, /喜欢简洁的科学比喻/);
    const restored = makeRuntime(ctx);
    assert.equal(restored.personaView().visualStyle, '蓝白配色');
    assert.equal(restored.scheduleView().scheduler.tickSeconds, 90);
    runtime.deleteMemory(memory.memoryId);
    assert.equal(runtime.listMemories().some((entry) => entry.memoryId === memory.memoryId), false);
  } finally { ctx.cleanup(); }
});

test('图片：不能通过图片任务 ID 向已取消任务导入', async () => {
  const ctx = await createTestContext({ llm: new MockLlm({ idea: [IDEA_JSON], compose: [COMPOSE_JSON], review: [REVIEW_JSON] }) });
  try {
    const runtime = makeRuntime(ctx);
    const created = await runtime.createIdea({});
    await runtime.composeDraft(created.task.taskId);
    const image = await runtime.generateImageTask({ taskId: created.task.taskId, prompt: '蓝白鲸鱼' });
    await runtime.cancelTask(created.task.taskId, '取消');
    await assert.rejects(() => runtime.importImage({ imageTaskId: image.imageTask.imageTaskId, base64: 'cG5n' }),
      (error) => error.code === 'CONFLICT');
  } finally { ctx.cleanup(); }
});

test('独立会话：重启恢复同一 ID、卸载释放、恢复失败不偷偷新建', async () => {
  const ctx = await createTestContext();
  try {
    const calls = [];
    const agents = {
      create: async (input) => { calls.push(['create', input]); return { agent: { id: input.sessionId }, dispose: async () => calls.push(['dispose']) }; },
      resume: async (input) => { calls.push(['resume', input]); return { agent: { id: input.resumeSessionId }, dispose: async () => calls.push(['dispose']) }; },
    };
    const presets = { register: async () => async () => calls.push(['unregister']) };
    const first = await createDedicatedSession(agents, presets, ctx.store, ctx.dir);
    await first.dispose();
    const second = await createDedicatedSession(agents, presets, ctx.store, ctx.dir);
    assert.equal(second.sessionId, first.sessionId);
    assert.match(calls[0][1].meta.cwd, /workspace$/);
    await second.dispose();
    agents.resume = async () => { throw new Error('恢复失败'); };
    await assert.rejects(() => createDedicatedSession(agents, presets, ctx.store, ctx.dir));
    assert.equal(calls.filter(([name]) => name === 'create').length, 1);
  } finally { ctx.cleanup(); }
});

test('审批后等待到安静时段：发表门禁再次拒绝', async () => {
  const setup = await setupPrepared();
  try {
    setup.config.policy.quietHours = ['00:00', '23:59'];
    await assert.rejects(() => setup.runtime.publish(setup.taskId), (error) => error.code === 'POLICY_DENIED');
    assert.equal(setup.store.requireTask(setup.taskId).state, 'PREPARED');
  } finally { setup.cleanup(); }
});

test('迁移：持久化命令领取跨数据库重开有效', async () => {
  const ctx = await createTestContext();
  try {
    assert.equal(ctx.store.claimOwnerCommand('test-receipt'), true);
    const second = await MomentsStore.open(ctx.dbPath);
    try { assert.equal(second.claimOwnerCommand('test-receipt'), false); }
    finally { second.close(); }
  } finally { ctx.cleanup(); }
});

test('人工配图：明确任务目录导入真实 PNG 后自动审核并申请审批', async () => {
  const llm = new MockLlm({ idea: [IDEA_JSON], compose: [COMPOSE_JSON], review: [REVIEW_JSON, REVIEW_JSON] });
  const ctx = await createTestContext({ llm, config: { publishMode: 'APPROVAL_REQUIRED' } });
  try {
    const logger = { info() {}, debug() {}, warn() {}, error() {} };
    const image = createImageFacade({ config: ctx.config.images, store: ctx.store, dataDir: ctx.dir, packageRoot: process.cwd(), logger });
    const runtime = makeRuntime(ctx, { image });
    const result = await runtime.generateDraftWorkflow({ topic: '科学与想象力', imagePrompt: '蓝色抽象几何' });
    assert.equal(result.imagePending, true);
    const imageTaskId = result.image.imageTask.imageTaskId;
    writeFileSync(path.join(ctx.dir, 'imports', imageTaskId, 'image.png'), makePatternPng(256, 256));
    assert.equal(await runtime.scanImageImports(), 1);
    assert.equal(ctx.store.requireTask(result.taskId).state, 'READY_FOR_APPROVAL');
    assert.equal(ctx.store.listTaskAssets(result.taskId).length, 1);
    assert.equal(await runtime.scanImageImports(), 0);
    assert.equal(ctx.store.listPendingApprovals().length, 1);
  } finally { ctx.cleanup(); }
});

test('维护：过期审批终止未执行任务，保留 UNCERTAIN 供人工核对', async () => {
  const ctx = await setupApproved();
  try {
    assert.equal(expirePendingTasks(ctx.store, new Date('2030-01-01T00:00:00Z')), 1);
    assert.equal(ctx.store.requireTask(ctx.taskId).state, 'EXPIRED');
    assert.equal(ctx.store.requireApproval(ctx.approvalId).status, 'expired');
  } finally { ctx.cleanup(); }
  const prepared = await setupPrepared();
  try {
    prepared.store.transitionTask(prepared.taskId, { nextState: 'PUBLISHING', actor: 'system', reason: '测试' });
    recoverInterruptedTasks(prepared.store);
    assert.equal(expirePendingTasks(prepared.store, new Date('2030-01-01T00:00:00Z')), 0);
    assert.equal(prepared.store.requireTask(prepared.taskId).state, 'UNCERTAIN');
  } finally { prepared.cleanup(); }
});

test('独立会话：创建时应用白名单、动态人格与指定模型', async () => {
  const ctx = await createTestContext();
  try {
    let captured;
    let names;
    let section;
    let persona = '初始人格';
    const agents = { async create(input) {
      captured = input;
      input.setup({ get: (name) => name === 'tools'
        ? { restrict: (filter) => { names = filter.allow; return () => {}; } }
        : { section: (value) => { section = value; return () => {}; } } });
      return { agent: { id: input.sessionId }, dispose: async () => {} };
    }};
    const session = await createDedicatedSession(agents, { register: async () => async () => {} }, ctx.store, ctx.dir,
      { toolNames: ['moments_get_status'], persona: () => persona, model: { provider: 'mock', model: 'mock' } });
    assert.deepEqual(names, ['moments_get_status']);
    assert.equal(captured.agentOptions.model, 'mock');
    assert.match(section.text(), /初始人格/);
    persona = '新人格';
    assert.match(section.text(), /新人格/);
    assert.equal(section.interpolate, false);
    await session.dispose();
  } finally { ctx.cleanup(); }
});
