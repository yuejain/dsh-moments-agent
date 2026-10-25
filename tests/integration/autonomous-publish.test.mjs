/**
 * 免审批自动发布链路（POLICY_AUTONOMOUS）端到端集成测试。
 *
 * 覆盖目标：证明“审核通过 -> 拟人化调度 -> Publisher.prepare -> Publisher.publish
 * -> 桌面执行器（Mock 替身）-> 核验 PUBLISHED”这条最终链路在无逐条审批时可用，
 * 且所有阻断门禁仍然生效。
 *
 * 本测试只使用 Mock LLM / Mock 所有者通道 / Mock 桌面执行器 / 临时 SQLite：
 * 不访问真实模型、微信、GUI 或网络桌面执行器，不发表任何真实内容。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, MockDesktop, MockLlm, MockOwnerChannel, MockImageFacade, deepMerge, IDEA_JSON, COMPOSE_JSON, REVIEW_JSON } from '../helpers/mock.mjs';
import { makeRuntime } from '../helpers/flow.mjs';
import { HUMANIZE_STATE_SETTING } from '../../dist/publishing/humanize-scheduler.js';

/** 2026-10-20T02:30:00Z = 10:30 Asia/Shanghai，落在 09:00-12:00 活跃时段内。 */
const CLOCK_START = '2026-10-20T02:30:00.000Z';

function mutableClock(startIso = CLOCK_START) {
  let current = new Date(startIso);
  return {
    clock: () => new Date(current),
    now: () => new Date(current),
    advance(seconds) {
      current = new Date(current.getTime() + seconds * 1000);
      return new Date(current);
    },
  };
}

/** 与线上一致的第三档配置：开启自动发送、活跃时段 09:00-12:00、默认零延迟便于断言。 */
function autonomousConfig(overrides = {}) {
  return deepMerge(
    {
      publishMode: 'POLICY_AUTONOMOUS',
      policy: {
        dailyLimit: 3,
        minIntervalMinutes: 0,
        quietHours: ['23:00', '08:00'],
        humanize: {
          enabled: true,
          delaySeconds: [0, 0],
          activeHours: ['09:00', '12:00'],
          minIntervalSeconds: 0,
          jitterSeconds: 0,
          maxPublishAttempts: 2,
          backoffSeconds: [60, 60],
        },
      },
    },
    overrides,
  );
}

/** 创建已审核通过（READY_TO_PUBLISH）的第三档任务；默认 Mock 执行器允许发表。 */
async function setupAutonomous(options = {}) {
  const clock = options.clock ?? mutableClock(options.startIso);
  const context = await createTestContext({
    config: autonomousConfig(options.config ?? {}),
    llm: options.llm ?? new MockLlm({ idea: [IDEA_JSON], compose: [COMPOSE_JSON], review: [REVIEW_JSON, REVIEW_JSON] }),
    desktop: options.desktop ?? new MockDesktop({ health: { allowPublish: true } }),
    channel: options.channel ?? new MockOwnerChannel(),
    image: options.image ?? new MockImageFacade(),
  });
  const runtime = makeRuntime(context, { clock: clock.clock });
  const created = await runtime.createIdea({ topic: '为什么本地小模型值得被认真对待' });
  if (created.task === null) throw new Error(`创建想法失败：${created.reason}`);
  const taskId = created.task.taskId;
  await runtime.composeDraft(taskId);
  const reviewed = await runtime.reviewDraft(taskId);
  return { ...context, runtime, clock, taskId, reviewed };
}

/** 记录 Publisher 实际迁移序列（审计按 at DESC 排序，同一注入时钟下顺序不可靠）。 */
function recordTransitions(setup) {
  const transitions = [];
  const original = setup.store.transitionTask.bind(setup.store);
  setup.store.transitionTask = (taskId, input) => {
    const result = original(taskId, input);
    if (taskId === setup.taskId && result.previousState !== input.nextState) {
      transitions.push({ from: result.previousState, to: input.nextState, actor: input.actor });
    }
    return result;
  };
  return transitions;
}

function desktopCalls(setup, method) {
  return setup.desktop.calls.filter((call) => call.method === method);
}

// ---------------------------------------------------------------------------
// (a) 审核 -> READY_TO_PUBLISH，且不创建任何审批
// ---------------------------------------------------------------------------

test('免审批链路：POLICY_AUTONOMOUS 审核通过直接进入 READY_TO_PUBLISH，不创建审批', async () => {
  const setup = await setupAutonomous();
  try {
    assert.equal(setup.reviewed.passed, true);
    const task = setup.store.requireTask(setup.taskId);
    assert.equal(task.state, 'READY_TO_PUBLISH');
    assert.equal(task.approvalId, null);
    assert.equal(task.accountId, 'wxid_test');
    assert.equal(typeof task.contentHash, 'string');
    assert.equal(task.contentHash.length, 64);
    assert.equal(typeof task.assetManifestHash, 'string');
    assert.equal(setup.store.listApprovalsForTask(setup.taskId).length, 0, '不得伪造人工审批记录');
    assert.equal(setup.store.listPendingApprovals(10).length, 0);
    assert.ok(setup.store.listOpenTasks(10).some((item) => item.taskId === setup.taskId));

    const audit = setup.store.listAudit({ taskId: setup.taskId, action: 'draft_reviewed' });
    assert.equal(audit.length, 1);
    assert.equal(audit[0].nextState, 'READY_TO_PUBLISH');
    assert.equal(audit[0].metadata.contentHash, task.contentHash);
  } finally {
    setup.cleanup();
  }
});

// ---------------------------------------------------------------------------
// (b) 调度 tick -> prepare -> publish -> PUBLISHED，全程无审批 ID，尝试已核验
// ---------------------------------------------------------------------------

test('免审批链路：调度 tick 触发 prepare->publish，状态 QUEUED->PREPARING->PREPARED->PUBLISHING->PUBLISHED', async () => {
  const setup = await setupAutonomous();
  try {
    const transitions = recordTransitions(setup);

    // 在桌面执行器被调用的瞬间记录当时的任务/尝试状态，证明调用时序而非事后推断。
    const atDesktopCall = [];
    const desktop = setup.desktop;
    const originalPrepare = desktop.prepare.bind(desktop);
    const originalPublish = desktop.publish.bind(desktop);
    desktop.prepare = async (request) => {
      atDesktopCall.push({
        phase: 'prepare',
        taskState: setup.store.requireTask(setup.taskId).state,
        attemptStates: setup.store.listAttemptsForTask(setup.taskId).map((attempt) => attempt.state),
        request,
      });
      return originalPrepare(request);
    };
    desktop.publish = async (request) => {
      atDesktopCall.push({
        phase: 'publish',
        taskState: setup.store.requireTask(setup.taskId).state,
        attemptStates: setup.store.listAttemptsForTask(setup.taskId).map((attempt) => attempt.state),
        request,
      });
      return originalPublish(request);
    };

    // tick 1：只排期，不改变任务状态、不触碰桌面执行器。
    const scheduled = await setup.runtime.humanizeTick();
    assert.equal(scheduled.acted, true);
    assert.equal(scheduled.action, 'scheduled');
    assert.equal(scheduled.taskId, setup.taskId);
    assert.equal(setup.store.requireTask(setup.taskId).state, 'READY_TO_PUBLISH');
    assert.equal(setup.desktop.calls.length, 0);
    assert.equal(setup.store.listAttemptsForTask(setup.taskId).length, 0);
    const queue = setup.runtime.humanizeStatus().queue;
    assert.equal(queue.length, 1);
    assert.equal(queue[0].taskId, setup.taskId);
    assert.equal(queue[0].approvalId, null);

    // tick 2：到点执行 prepare + publish。
    const published = await setup.runtime.humanizeTick();
    assert.equal(published.acted, true);
    assert.equal(published.action, 'published');
    assert.equal(published.uncertain, false);
    assert.equal(published.taskId, setup.taskId);

    // 状态序列必须逐级经过 QUEUED（准备前入队）-> PREPARING -> PREPARED -> PUBLISHING -> PUBLISHED。
    assert.deepEqual(
      transitions.map((item) => `${item.from}->${item.to}`),
      ['READY_TO_PUBLISH->QUEUED', 'QUEUED->PREPARING', 'PREPARING->PREPARED', 'PREPARED->PUBLISHING', 'PUBLISHING->PUBLISHED'],
    );
    assert.equal(transitions[1].actor, 'humanize');
    assert.equal(transitions[3].actor, 'humanize');
    assert.equal(transitions[2].actor, 'desktop');
    assert.equal(transitions[4].actor, 'desktop');

    // prepare / publish 的调用顺序与时序状态。
    assert.deepEqual(atDesktopCall.map((item) => item.phase), ['prepare', 'publish']);
    assert.equal(atDesktopCall[0].taskState, 'PREPARING');
    assert.deepEqual(atDesktopCall[0].attemptStates, ['PREPARING']);
    assert.equal(atDesktopCall[1].taskState, 'PUBLISHING');
    assert.deepEqual(atDesktopCall[1].attemptStates, ['PUBLISHING']);

    // 免审批：publish 请求 approvalId 为空串、模式为第三档；准备请求携带审核快照哈希与绑定账号。
    const publishRequest = atDesktopCall[1].request;
    assert.equal(publishRequest.approvalId, '');
    assert.equal(publishRequest.publishMode, 'POLICY_AUTONOMOUS');
    assert.equal(publishRequest.contentHash, setup.store.requireTask(setup.taskId).contentHash);
    assert.equal(publishRequest.accountId, 'wxid_test');
    assert.equal(atDesktopCall[0].request.contentHash, publishRequest.contentHash);
    assert.equal(atDesktopCall[0].request.accountId, 'wxid_test');

    // 最终任务 / 尝试 / 已发布记录。
    const task = setup.store.requireTask(setup.taskId);
    assert.equal(task.state, 'PUBLISHED');
    const attempts = setup.store.listAttemptsForTask(setup.taskId);
    assert.equal(attempts.length, 1);
    const attempt = attempts[0];
    assert.equal(attempt.state, 'VERIFIED');
    assert.equal(attempt.approvalId, null);
    assert.equal(attempt.mode, 'POLICY_AUTONOMOUS');
    assert.equal(attempt.contentHash, task.contentHash);
    assert.equal(attempt.accountId, 'wxid_test');
    assert.equal(attempt.verification?.verified, true);

    const posts = setup.store.listPublished(10);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].taskId, setup.taskId);
    assert.equal(posts[0].attemptId, attempt.attemptId);
    assert.equal(posts[0].contentHash, task.contentHash);
    assert.equal(posts[0].accountId, 'wxid_test');
    assert.equal(posts[0].verified, true);
    assert.equal(setup.store.listApprovalsForTask(setup.taskId).length, 0, '免审批不应产生审批记录');
    assert.equal(setup.desktop.calls.filter((call) => call.method === 'publish').length, 1);

    // 重复调用：核验幂等、再次 tick / 再次 publish 都不会重复点击。
    assert.equal((await setup.runtime.verify(attempt.attemptId)).verification.verified, true);
    assert.equal((await setup.runtime.publish(setup.taskId)).verified, true);
    const idle = await setup.runtime.humanizeTick();
    assert.notEqual(idle.action, 'published');
    assert.equal(setup.desktop.calls.filter((call) => call.method === 'publish').length, 1);
    assert.equal(setup.store.listPublished(10).length, 1);
    assert.equal(setup.runtime.humanizeStatus().today.published, 1);
  } finally {
    setup.cleanup();
  }
});

// ---------------------------------------------------------------------------
// (c) UNCERTAIN：已点击未确认，下一 tick 永不重发
// ---------------------------------------------------------------------------

test('免审批链路：发表结果 UNCERTAIN 后下一 tick 不重发，转人工核对', async () => {
  const desktop = new MockDesktop({
    health: { allowPublish: true },
    publishResult: {
      submitted: true,
      verified: false,
      uncertain: true,
      screenshotPath: null,
      verification: null,
      errorCode: 'UNCERTAIN',
      message: '已点击但无法核验',
    },
  });
  const setup = await setupAutonomous({ desktop });
  try {
    await setup.runtime.humanizeTick(); // 排期
    const result = await setup.runtime.humanizeTick(); // 执行 -> UNCERTAIN
    assert.equal(result.acted, true);
    assert.equal(result.action, 'uncertain');
    assert.equal(result.uncertain, true);
    assert.equal(setup.store.requireTask(setup.taskId).state, 'UNCERTAIN');
    assert.equal(desktopCalls(setup, 'publish').length, 1);
    assert.equal(setup.store.listPublished(10).length, 0);
    assert.equal(setup.store.listAttemptsForTask(setup.taskId)[0].state, 'UNCERTAIN');
    const queueAfterUncertain = setup.runtime.humanizeStatus().queue;
    assert.equal(
      queueAfterUncertain.filter((entry) => !entry.exhausted).length,
      0,
      'UNCERTAIN 后不得保留可执行的排期',
    );
    assert.equal(
      setup.channel.sent.some((item) => String(item.text).includes('人工核对')),
      true,
      '必须通知所有者人工核对',
    );

    // 下一 tick（跨过活跃时段与一个完整周期）不得再次准备/点击。
    setup.clock.advance(24 * 3600);
    const later = await setup.runtime.humanizeTick();
    assert.notEqual(later.action, 'published');
    assert.equal(desktopCalls(setup, 'publish').length, 1, 'UNCERTAIN 后永不自动重试');
    assert.equal(desktopCalls(setup, 'prepare').length, 1);
    assert.equal(setup.store.requireTask(setup.taskId).state, 'UNCERTAIN');
    assert.equal(
      setup.store.listAudit({ taskId: setup.taskId, action: 'humanize_published' }).length,
      0,
    );
    const failed = setup.store.listAudit({ taskId: setup.taskId, action: 'humanize_failed' });
    assert.equal(failed.length, 1);
    assert.equal(failed[0].metadata.uncertain, true);

    // 防御纵深：直接调用 Publisher 也拒绝再次发表。
    await assert.rejects(
      () => setup.runtime.publish(setup.taskId),
      (error) => error.code === 'UNCERTAIN_REQUIRES_MANUAL_CHECK',
    );
    assert.equal(desktopCalls(setup, 'publish').length, 1);
  } finally {
    setup.cleanup();
  }
});

// ---------------------------------------------------------------------------
// (d) PREPARE_ONLY / 暂停 / Kill Switch 阻断
// ---------------------------------------------------------------------------

test('免审批链路：切回 PREPARE_ONLY 后调度与直接发表均被拒绝', async () => {
  const setup = await setupAutonomous();
  try {
    setup.runtime.updatePublishMode({ mode: 'PREPARE_ONLY' });
    assert.equal(setup.runtime.publishModeView().mode, 'PREPARE_ONLY');

    const tick = await setup.runtime.humanizeTick();
    assert.equal(tick.acted, false);
    assert.equal(tick.action, 'blocked');
    assert.equal(tick.code, 'PUBLISH_MODE_DISABLED');
    assert.equal(setup.store.getSetting(HUMANIZE_STATE_SETTING), undefined, '不得产生排期');
    assert.equal(setup.desktop.calls.length, 0);

    // 仅准备模式仍允许准备，但发表请求必须被拒绝且不触碰点击端点。
    const prepared = await setup.runtime.prepareDesktop(setup.taskId);
    assert.equal(prepared.prepared, true);
    assert.equal(setup.store.requireTask(setup.taskId).state, 'PREPARED');
    await assert.rejects(
      () => setup.runtime.publish(setup.taskId),
      (error) => error.code === 'PUBLISH_MODE_DISABLED',
    );
    assert.equal(desktopCalls(setup, 'publish').length, 0);
    assert.equal(setup.store.requireTask(setup.taskId).state, 'PREPARED');
  } finally {
    setup.cleanup();
  }
});

test('免审批链路：系统暂停时调度与发表门禁生效，恢复后链路继续', async () => {
  const setup = await setupAutonomous();
  try {
    setup.runtime.controlAction('pause', 'test');
    const paused = await setup.runtime.humanizeTick();
    assert.equal(paused.acted, false);
    assert.equal(paused.action, 'blocked');
    assert.equal(paused.code, 'PAUSED');
    assert.equal(setup.store.getSetting(HUMANIZE_STATE_SETTING), undefined);
    assert.equal(setup.desktop.calls.length, 0);
    await assert.rejects(
      () => setup.runtime.prepareDesktop(setup.taskId),
      (error) => error.code === 'PAUSED',
    );

    setup.runtime.controlAction('resume', 'test');
    await setup.runtime.humanizeTick();
    const published = await setup.runtime.humanizeTick();
    assert.equal(published.action, 'published');
    assert.equal(setup.store.requireTask(setup.taskId).state, 'PUBLISHED');
    assert.equal(desktopCalls(setup, 'publish').length, 1);
  } finally {
    setup.cleanup();
  }
});

test('免审批链路：Kill Switch 生效时绝不排期或点击，解除后恢复', async () => {
  const setup = await setupAutonomous();
  try {
    setup.runtime.controlAction('kill', 'test');
    const killed = await setup.runtime.humanizeTick();
    assert.equal(killed.action, 'blocked');
    assert.equal(killed.code, 'KILL_SWITCH_ACTIVE');
    assert.equal(setup.desktop.calls.length, 0);
    assert.equal(setup.store.getSetting(HUMANIZE_STATE_SETTING), undefined);

    setup.runtime.controlAction('unkill', 'test');
    await setup.runtime.humanizeTick();
    const published = await setup.runtime.humanizeTick();
    assert.equal(published.action, 'published');
    assert.equal(desktopCalls(setup, 'publish').length, 1);
  } finally {
    setup.cleanup();
  }
});

// ---------------------------------------------------------------------------
// (e) 每日上限 / 最小间隔（含 Publisher 侧的二次校验）
// ---------------------------------------------------------------------------

test('免审批链路：达到每日上限时不排期，Publisher 二次校验也拒绝点击', async () => {
  const setup = await setupAutonomous({ config: { policy: { dailyLimit: 1 } } });
  try {
    const now = setup.clock.now();
    setup.store.insertPublished({
      postId: 'post_preexisting',
      taskId: 'task_preexisting',
      attemptId: 'att_preexisting',
      text: '一条与本次候选无关的历史内容，仅用于占满今日额度与间隔',
      visibility: 'PUBLIC',
      accountId: 'wxid_test',
      contentHash: 'f'.repeat(64),
      publishedAt: now.toISOString(),
      verified: true,
    });

    const tick = await setup.runtime.humanizeTick();
    assert.equal(tick.acted, false);
    assert.equal(tick.action, 'blocked');
    assert.equal(tick.code, 'DAILY_LIMIT');
    assert.equal(JSON.parse(setup.store.getSetting(HUMANIZE_STATE_SETTING)).entries.length, 0, '不得产生排期');
    assert.equal(setup.desktop.calls.length, 0);
    // 下一次可发时间应指向次日活跃时段开始（09:00 Asia/Shanghai）。
    assert.equal(tick.nextEligibleAt, '2026-10-21T01:00:00.000Z');

    // 即使绕过调度器直接准备并发表，Publisher 的 assertTimeLimits 也必须拒绝。
    const prepared = await setup.runtime.prepareDesktop(setup.taskId);
    assert.equal(prepared.prepared, true);
    await assert.rejects(
      () => setup.runtime.publish(setup.taskId),
      (error) => error.code === 'POLICY_DENIED',
    );
    assert.equal(desktopCalls(setup, 'publish').length, 0);
    assert.equal(setup.store.requireTask(setup.taskId).state, 'PREPARED');
  } finally {
    setup.cleanup();
  }
});

test('免审批链路：最小间隔（含与 humanize 取较大值）未到时不发送，到期后正常发表', async () => {
  const setup = await setupAutonomous({ config: { policy: { minIntervalMinutes: 60 } } });
  try {
    const now = setup.clock.now();
    const lastPublishedAt = new Date(now.getTime() - 30 * 60_000).toISOString();
    setup.store.insertPublished({
      postId: 'post_recent',
      taskId: 'task_recent',
      attemptId: 'att_recent',
      text: '上一条已发布内容，用于验证最小间隔门禁（与候选文本不相同）',
      visibility: 'PUBLIC',
      accountId: 'wxid_test',
      contentHash: 'e'.repeat(64),
      publishedAt: lastPublishedAt,
      verified: true,
    });

    const blocked = await setup.runtime.humanizeTick();
    assert.equal(blocked.action, 'blocked');
    assert.equal(blocked.code, 'MIN_INTERVAL');
    assert.equal(setup.desktop.calls.length, 0);
    assert.equal(JSON.parse(setup.store.getSetting(HUMANIZE_STATE_SETTING)).entries.length, 0, '不得产生排期');

    // 间隔（60 分钟）到期后：排期 -> 发表成功。
    setup.clock.advance(61 * 60);
    assert.equal(setup.store.requireTask(setup.taskId).state, 'READY_TO_PUBLISH');
    const scheduled = await setup.runtime.humanizeTick();
    assert.equal(scheduled.action, 'scheduled');
    const published = await setup.runtime.humanizeTick();
    assert.equal(published.action, 'published');
    assert.equal(desktopCalls(setup, 'publish').length, 1);
    assert.equal(setup.store.listPublished(10).length, 2, '历史已发布记录 + 本次发布');
  } finally {
    setup.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 额外门禁：执行器未授权 / 微信未就绪 / 账号不一致 / 内容被篡改
// ---------------------------------------------------------------------------

test('免审批链路：执行器未 --allow-publish 或微信未就绪时不排期', async () => {
  const noPublish = await setupAutonomous({ desktop: new MockDesktop({ health: { allowPublish: false } }) });
  try {
    const result = await noPublish.runtime.humanizeTick();
    assert.equal(result.action, 'blocked');
    assert.equal(result.code, 'PUBLISH_MODE_DISABLED');
    assert.equal(noPublish.desktop.calls.length, 0);
  } finally {
    noPublish.cleanup();
  }

  const wechatDown = await setupAutonomous({
    desktop: new MockDesktop({ health: { allowPublish: true }, status: { running: false, loggedIn: false, accountId: null } }),
  });
  try {
    const result = await wechatDown.runtime.humanizeTick();
    assert.equal(result.action, 'blocked');
    assert.equal(result.code, 'WECHAT_NOT_READY');
    assert.equal(wechatDown.desktop.calls.length, 0);
  } finally {
    wechatDown.cleanup();
  }
});

test('免审批链路：桌面登录账号与任务绑定账号不一致时不排期', async () => {
  const desktop = new MockDesktop({ health: { allowPublish: true } });
  const setup = await setupAutonomous({ desktop });
  try {
    desktop.statusValue = { ...desktop.statusValue, accountId: 'wxid_other' };
    const result = await setup.runtime.humanizeTick();
    assert.equal(result.action, 'blocked');
    assert.equal(result.code, 'ACCOUNT_MISMATCH');
    assert.equal(setup.desktop.calls.length, 0);
    assert.equal(setup.store.listPublished(10).length, 0);
  } finally {
    setup.cleanup();
  }
});

test('免审批链路：审核后内容被篡改时到点拒绝点击并转人工', async () => {
  const setup = await setupAutonomous();
  try {
    await setup.runtime.humanizeTick(); // 排期
    const draft = setup.store.requireCurrentDraft(setup.taskId);
    setup.store.updateDraftText(draft.draftId, `${draft.text}（被篡改）`, 'c'.repeat(64), draft.tone);

    const result = await setup.runtime.humanizeTick();
    assert.notEqual(result.action, 'published');
    assert.equal(desktopCalls(setup, 'publish').length, 0);
    assert.equal(setup.store.requireTask(setup.taskId).state, 'READY_TO_PUBLISH');
    assert.equal(setup.store.listPublished(10).length, 0);
    const failed = setup.store.listAudit({ taskId: setup.taskId, action: 'humanize_failed' });
    assert.equal(failed.length, 1);
    assert.equal(failed[0].metadata.code, 'CONTENT_CHANGED');
    assert.equal(setup.runtime.humanizeStatus().queue.filter((entry) => !entry.exhausted).length, 0, '内容变化后旧排期必须清除');
  } finally {
    setup.cleanup();
  }
});
