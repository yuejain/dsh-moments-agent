/**
 * 拟人化自动发送：Runtime + Publisher + 数据库集成测试。
 *
 * 使用 Mock LLM / MockOwnerChannel / MockDesktop / 临时 SQLite，不访问真实
 * 模型、微信或桌面执行器。所有时间由可变时钟控制。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupApproved, makeRuntime } from '../helpers/flow.mjs';
import { MockDesktop } from '../helpers/mock.mjs';
import { MomentsStore } from '../../dist/storage/store.js';
import { HUMANIZE_STATE_SETTING } from '../../dist/publishing/humanize-scheduler.js';

function mutableClock(startIso = '2026-10-20T04:00:30.000Z') {
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

function humanizeConfig(overrides = {}) {
  return {
    publishMode: 'APPROVAL_REQUIRED',
    policy: {
      dailyLimit: 3,
      minIntervalMinutes: 0,
      humanize: {
        enabled: true,
        delaySeconds: [0, 0],
        minIntervalSeconds: 0,
        jitterSeconds: 0,
        maxPublishAttempts: 2,
        backoffSeconds: [60, 60],
        ...overrides,
      },
    },
  };
}

function desktopCalls(setup, method) {
  return setup.desktop.calls.filter((call) => call.method === method).length;
}

test('拟人化：默认关闭时不读队列、不调用执行器、不出现在审计里', async () => {
  const clock = mutableClock();
  const setup = await setupApproved({ runtimeOverrides: { clock: clock.clock } });
  try {
    const result = await setup.runtime.humanizeTick();
    assert.equal(result.acted, false);
    assert.equal(result.action, 'disabled');
    assert.equal(result.code, 'HUMANIZE_DISABLED');
    assert.equal(setup.store.getSetting(HUMANIZE_STATE_SETTING), undefined);
    assert.equal(desktopCalls(setup, 'prepare'), 0);
    assert.equal(desktopCalls(setup, 'publish'), 0);

    const status = setup.runtime.humanizeStatus();
    assert.equal(status.enabled, false);
    assert.equal(status.active, false);
    assert.equal(status.blockedReasons.includes('HUMANIZE_DISABLED'), true);
    assert.equal(status.queue.length, 0);

    const full = await setup.runtime.status();
    assert.equal(full.humanize.enabled, false);
  } finally {
    setup.cleanup();
  }
});

test('拟人化：显式开启且 PREPARE_ONLY 时仍拒绝自动发表', async () => {
  const clock = mutableClock();
  const setup = await setupApproved({
    config: { publishMode: 'PREPARE_ONLY', policy: humanizeConfig().policy },
    runtimeOverrides: { clock: clock.clock },
  });
  try {
    const result = await setup.runtime.humanizeTick();
    assert.equal(result.action, 'blocked');
    assert.equal(result.code, 'PUBLISH_MODE_DISABLED');
    assert.equal(setup.store.getSetting(HUMANIZE_STATE_SETTING), undefined);
    assert.equal(desktopCalls(setup, 'prepare'), 0);
    assert.equal(desktopCalls(setup, 'publish'), 0);
  } finally {
    setup.cleanup();
  }
});

test('拟人化：排期 -> 到点通过 Publisher 自动发表并核销审批', async () => {
  const clock = mutableClock();
  const setup = await setupApproved({
    config: humanizeConfig({ delaySeconds: [120, 120] }),
    runtimeOverrides: { clock: clock.clock },
  });
  try {
    const scheduled = await setup.runtime.humanizeTick();
    assert.equal(scheduled.acted, true);
    assert.equal(scheduled.action, 'scheduled');
    assert.equal(scheduled.taskId, setup.taskId);
    assert.equal(scheduled.delaySeconds, 120);
    assert.equal(setup.store.requireTask(setup.taskId).state, 'APPROVED');
    assert.equal(desktopCalls(setup, 'prepare'), 0);
    assert.equal(desktopCalls(setup, 'publish'), 0);

    const status = setup.runtime.humanizeStatus();
    assert.equal(status.enabled, true);
    assert.equal(status.active, true);
    assert.equal(status.queue.length, 1);
    assert.equal(status.queue[0].taskId, setup.taskId);
    assert.equal(status.nextScheduledAt, scheduled.scheduledAt);
    assert.equal(status.nextEligibleAt, scheduled.scheduledAt);
    assert.equal(status.today.published, 0);
    assert.equal(status.today.limit, 3);

    // 未到延迟时间：不执行。
    clock.advance(119);
    const waiting = await setup.runtime.humanizeTick();
    assert.equal(waiting.action, 'waiting');
    assert.equal(desktopCalls(setup, 'prepare'), 0);

    clock.advance(2);
    const published = await setup.runtime.humanizeTick();
    assert.equal(published.acted, true);
    assert.equal(published.action, 'published');
    assert.equal(setup.store.requireTask(setup.taskId).state, 'PUBLISHED');
    assert.equal(setup.store.requireApproval(setup.approvalId).status, 'consumed');
    assert.equal(setup.store.listPublished(10).length, 1);
    assert.equal(desktopCalls(setup, 'prepare'), 1);
    assert.equal(desktopCalls(setup, 'publish'), 1);

    const actions = setup.store.listAudit({}).map((event) => event.action);
    assert.equal(actions.includes('humanize_scheduled'), true);
    assert.equal(actions.includes('humanize_published'), true);

    const finalStatus = setup.runtime.humanizeStatus();
    assert.equal(finalStatus.queue.length, 0);
    assert.equal(finalStatus.today.published, 1);
    assert.equal(finalStatus.lastAction.action, 'humanize_published');
    assert.equal(finalStatus.lastError, null);
  } finally {
    setup.cleanup();
  }
});

test('拟人化：已点击但无法核验进入 UNCERTAIN，之后永不自动重试', async () => {
  const desktop = new MockDesktop({
    health: { allowPublish: true },
    publishResult: {
      submitted: true,
      verified: false,
      uncertain: true,
      verification: null,
      errorCode: 'UNCERTAIN',
      message: '已点击但无法核验',
    },
  });
  const clock = mutableClock();
  const setup = await setupApproved({ desktop, config: humanizeConfig(), runtimeOverrides: { clock: clock.clock } });
  try {
    await setup.runtime.humanizeTick(); // 排期
    const result = await setup.runtime.humanizeTick(); // 执行
    assert.equal(result.acted, true);
    assert.equal(result.action, 'uncertain');
    assert.equal(result.uncertain, true);
    assert.equal(setup.store.requireTask(setup.taskId).state, 'UNCERTAIN');
    assert.equal(desktopCalls(setup, 'publish'), 1);

    clock.advance(3600);
    const later = await setup.runtime.humanizeTick();
    assert.notEqual(later.action, 'published');
    assert.equal(desktopCalls(setup, 'publish'), 1, 'UNCERTAIN 后不得再次点击');
    assert.equal(setup.store.requireTask(setup.taskId).state, 'UNCERTAIN');

    const attempts = setup.store.listAttemptsForTask(setup.taskId);
    assert.equal(attempts.some((attempt) => attempt.state === 'UNCERTAIN'), true);
    const failed = setup.store.listAudit({ action: 'humanize_failed' });
    assert.equal(failed.length, 1);
    assert.equal(failed[0].metadata.uncertain, true);
    assert.equal(
      setup.channel.sent.some((item) => String(item.text).includes('人工核对')),
      true,
      '必须通知所有者人工核对',
    );
  } finally {
    setup.cleanup();
  }
});

test('拟人化：准备失败按指数退避重试，超过 maxPublishAttempts 后停止并标记错误', async () => {
  const desktop = new MockDesktop({ health: { allowPublish: true } });
  let prepareCalls = 0;
  desktop.prepare = async () => {
    prepareCalls += 1;
    return {
      ok: false,
      prepared: false,
      screenshotPath: null,
      textMatched: false,
      imageCount: 0,
      warnings: [],
      errorCode: 'WECHAT_NOT_RUNNING',
      message: '微信未运行',
    };
  };
  const clock = mutableClock();
  const setup = await setupApproved({ desktop, config: humanizeConfig(), runtimeOverrides: { clock: clock.clock } });
  try {
    await setup.runtime.humanizeTick(); // 排期
    const first = await setup.runtime.humanizeTick(); // 第 1 次失败
    assert.equal(first.action, 'failed');
    assert.equal(first.attempts, 1);
    assert.equal(setup.store.requireTask(setup.taskId).state, 'QUEUED');

    clock.advance(61);
    const second = await setup.runtime.humanizeTick(); // 第 2 次失败 -> 达到上限
    assert.equal(second.action, 'failed');
    assert.equal(second.attempts, 2);

    clock.advance(3600);
    const idle = await setup.runtime.humanizeTick();
    assert.notEqual(idle.action, 'published');
    assert.equal(prepareCalls, 2, '达到上限后不得再次调用桌面执行器');

    const task = setup.store.requireTask(setup.taskId);
    assert.equal(task.state, 'QUEUED');
    assert.equal(task.errorCode, 'DESKTOP_PRECONDITION');
    assert.match(task.errorMessage ?? '', /失败/);
    assert.equal(setup.store.listAudit({ action: 'humanize_failed' }).length >= 2, true);
    assert.equal(setup.channel.sent.some((item) => String(item.text).includes('自动发送失败')), true);
  } finally {
    setup.cleanup();
  }
});

test('拟人化：相同内容哈希已发布时拒绝排期', async () => {
  const clock = mutableClock();
  const setup = await setupApproved({ config: humanizeConfig(), runtimeOverrides: { clock: clock.clock } });
  try {
    const task = setup.store.requireTask(setup.taskId);
    setup.store.insertPublished({
      postId: 'post_existing',
      taskId: 'task_existing',
      attemptId: 'att_existing',
      text: '一篇完全不同的历史内容，仅用于占用内容哈希',
      visibility: 'PUBLIC',
      accountId: 'wxid_test',
      contentHash: task.contentHash,
      publishedAt: clock.now().toISOString(),
      verified: true,
    });
    const result = await setup.runtime.humanizeTick();
    assert.equal(result.action, 'blocked');
    assert.equal(result.code, 'DUPLICATE_CONTENT');
    const persisted = setup.store.getSetting(HUMANIZE_STATE_SETTING);
    assert.equal(persisted === undefined || JSON.parse(persisted).entries.length === 0, true, '不应产生排期');
    assert.equal(JSON.parse(persisted).lastAction.code, 'DUPLICATE_CONTENT');
    assert.equal(desktopCalls(setup, 'prepare'), 0);
    assert.equal(desktopCalls(setup, 'publish'), 0);
  } finally {
    setup.cleanup();
  }
});

test('拟人化：Kill Switch 与暂停优先，不执行任何排期/点击', async () => {
  const clock = mutableClock();
  const setup = await setupApproved({ config: humanizeConfig(), runtimeOverrides: { clock: clock.clock } });
  try {
    setup.runtime.controlAction('pause', 'test');
    const paused = await setup.runtime.humanizeTick();
    assert.equal(paused.action, 'blocked');
    assert.equal(paused.code, 'PAUSED');
    assert.equal(setup.store.getSetting(HUMANIZE_STATE_SETTING), undefined);

    setup.runtime.controlAction('resume', 'test');
    setup.runtime.controlAction('kill', 'test');
    const killed = await setup.runtime.humanizeTick();
    assert.equal(killed.action, 'blocked');
    assert.equal(killed.code, 'KILL_SWITCH_ACTIVE');
    assert.equal(desktopCalls(setup, 'prepare'), 0);
    assert.equal(desktopCalls(setup, 'publish'), 0);
  } finally {
    setup.cleanup();
  }
});

test('拟人化：排期持久化到数据库，重启后按原计划继续且不提前补发', async () => {
  const clock = mutableClock();
  const setup = await setupApproved({
    config: humanizeConfig({ delaySeconds: [600, 600] }),
    runtimeOverrides: { clock: clock.clock },
  });
  const store1 = setup.store;
  try {
    const scheduled = await setup.runtime.humanizeTick();
    assert.equal(scheduled.action, 'scheduled');
    assert.equal(scheduled.delaySeconds, 600);
    const persisted = JSON.parse(store1.getSetting(HUMANIZE_STATE_SETTING));
    assert.equal(persisted.entries.length, 1);
    assert.equal(persisted.entries[0].scheduledAt, scheduled.scheduledAt);

    // 模拟进程重启：关闭并重新打开同一个 SQLite。
    store1.close();
    const reopened = await MomentsStore.open(setup.dbPath);
    const runtime2 = makeRuntime({ ...setup, store: reopened }, { clock: clock.clock });
    try {
      clock.advance(599);
      const waiting = await runtime2.humanizeTick();
      assert.equal(waiting.action, 'waiting');
      assert.equal(reopened.listPublished(10).length, 0);

      clock.advance(2);
      const published = await runtime2.humanizeTick();
      assert.equal(published.action, 'published');
      assert.equal(reopened.requireTask(setup.taskId).state, 'PUBLISHED');
      assert.equal(reopened.listPublished(10).length, 1);
    } finally {
      reopened.close();
    }
  } finally {
    setup.cleanup();
  }
});
