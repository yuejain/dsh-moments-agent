/**
 * 拟人化自动发送策略（纯函数）单元测试。
 *
 * 覆盖：默认关闭、发布模式门禁、活跃时段/安静时段/时区边界、每日上限、
 * 最小间隔与抖动范围、延迟区间、相似/相同内容去重、审批与内容哈希绑定、
 * UNCERTAIN 永不重试、重试上限与指数退避、Kill Switch/暂停优先。
 * 全部使用固定时钟与固定随机数，不访问真实模型/微信/桌面执行器。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../../dist/config.js';
import {
  HUMANIZE_DUPLICATE_SIMILARITY,
  appliedHumanizePolicy,
  effectiveIntervalSeconds,
  evaluateHumanizeCandidate,
  humanizeDelaySeconds,
  humanizeGapMs,
  isWithinActiveHours,
  nextActiveWindowStart,
  nextQuietHoursEnd,
  nextTimeEligibleAt,
  planHumanizeTick,
  retryBackoffSeconds,
} from '../../dist/publishing/humanize-policy.js';

/** 12:00 Asia/Shanghai，位于默认活跃时段内、非安静时段。 */
const NOW = new Date('2026-10-20T04:00:00.000Z');
const TZ = 'Asia/Shanghai';

function deepMerge(base, overrides) {
  const out = { ...base };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = deepMerge(base[key] ?? {}, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function makeConfig(overrides = {}) {
  return parseConfig(
    deepMerge(
      {
        publishMode: 'APPROVAL_REQUIRED',
        policy: {
          dailyLimit: 3,
          minIntervalMinutes: 0,
          quietHours: ['23:00', '08:00'],
          timeZone: TZ,
          humanize: {
            enabled: true,
            delaySeconds: [90, 900],
            activeHours: ['09:00', '22:00'],
            minIntervalSeconds: 0,
            jitterSeconds: 0,
            maxPublishAttempts: 2,
            backoffSeconds: [60, 180],
          },
        },
      },
      overrides,
    ),
  );
}

function makeCandidate(overrides = {}) {
  const base = {
    taskId: 'task_1',
    state: 'APPROVED',
    contentHash: 'hash_1',
    accountId: 'wxid_test',
    approvalId: 'apr_1',
    approvalStatus: 'approved',
    approvalExpiresAt: new Date(NOW.getTime() + 3600_000).toISOString(),
    approvalContentHash: 'hash_1',
    text: '端侧模型真正改变的不是参数表，而是你愿不愿意把一件小事交给它。',
    attempts: 0,
    lastAttemptAt: null,
    lastAttemptState: null,
  };
  const merged = { ...base, ...overrides };
  // 覆盖内容哈希时默认同步审批哈希，除非测试显式制造“审批后内容变化”。
  if (overrides.contentHash !== undefined && overrides.approvalContentHash === undefined) {
    merged.approvalContentHash = overrides.contentHash;
  }
  return merged;
}

function makeInput(overrides = {}) {
  const now = overrides.now ?? NOW;
  const candidate =
    overrides.candidate ??
    makeCandidate({ approvalExpiresAt: new Date(now.getTime() + 3600_000).toISOString() });
  return {
    now,
    config: makeConfig(),
    control: { killSwitch: false, paused: false },
    desktop: { ok: true, allowPublish: true, wechatInstalled: true, wechatReady: true, accountId: 'wxid_test' },
    candidate,
    lastPublishedAt: null,
    todayCount: 0,
    recentTexts: [],
    publishedContentHashes: [],
    random: () => 0,
    ...overrides,
  };
}

test('配置：humanize 默认关闭且默认值安全', () => {
  const config = parseConfig({});
  assert.equal(config.policy.humanize.enabled, false);
  assert.deepEqual(config.policy.humanize.delaySeconds, [90, 900]);
  assert.deepEqual(config.policy.humanize.activeHours, ['09:00', '22:00']);
  assert.equal(config.policy.humanize.minIntervalSeconds, 3600);
  assert.equal(config.policy.humanize.jitterSeconds, 600);
  assert.equal(config.policy.humanize.maxPublishAttempts, 2);
  assert.deepEqual(config.policy.humanize.backoffSeconds, [60, 180]);

  // 默认配置下即使候选完全合法也不允许自动发送。
  const evaluation = evaluateHumanizeCandidate(makeInput({ config }));
  assert.equal(evaluation.allowed, false);
  assert.equal(evaluation.code, 'HUMANIZE_DISABLED');
});

test('配置：支持 snake/camel 两种写法，并拒绝危险或非法区间', () => {
  const snake = parseConfig({
    policy: {
      humanize: {
        enabled: true,
        delay_seconds: [10, 20],
        active_hours: ['08:00', '21:00'],
        min_interval_seconds: 120,
        jitter_seconds: 30,
        max_publish_attempts: 3,
        backoff_seconds: [5, 9],
      },
    },
  });
  assert.deepEqual(snake.policy.humanize.delaySeconds, [10, 20]);
  assert.deepEqual(snake.policy.humanize.activeHours, ['08:00', '21:00']);
  assert.equal(snake.policy.humanize.minIntervalSeconds, 120);
  assert.equal(snake.policy.humanize.maxPublishAttempts, 3);
  assert.deepEqual(snake.policy.humanize.backoffSeconds, [5, 9]);

  assert.throws(() => parseConfig({ policy: { humanize: { delaySeconds: [900, 90] } } }), /不能大于/);
  assert.throws(() => parseConfig({ policy: { humanize: { delaySeconds: [0, 3601] } } }), /之间/);
  assert.throws(() => parseConfig({ policy: { humanize: { activeHours: ['09:00', '09:00'] } } }), /不能相同/);
  assert.throws(() => parseConfig({ policy: { humanize: { maxPublishAttempts: 0 } } }), /之间/);
  assert.throws(() => parseConfig({ policy: { humanize: { maxPublishAttempts: 2.5 } } }), /整数/);
  assert.throws(() => parseConfig({ policy: { humanize: { backoffSeconds: 'x' } } }), /必须是/);
});

test('门禁：PREPARE_ONLY / Kill Switch / 暂停 时一律不自动发送', () => {
  const prepareOnly = evaluateHumanizeCandidate(makeInput({ config: makeConfig({ publishMode: 'PREPARE_ONLY' }) }));
  assert.equal(prepareOnly.allowed, false);
  assert.equal(prepareOnly.codes.includes('PUBLISH_MODE_DISABLED'), true);

  const killed = evaluateHumanizeCandidate(makeInput({ control: { killSwitch: true, paused: false } }));
  assert.equal(killed.allowed, false);
  assert.equal(killed.codes.includes('KILL_SWITCH_ACTIVE'), true);

  const paused = evaluateHumanizeCandidate(makeInput({ control: { killSwitch: false, paused: true } }));
  assert.equal(paused.allowed, false);
  assert.equal(paused.codes.includes('PAUSED'), true);
});

test('时间：活跃时段内允许，且延迟落在配置区间内', () => {
  const evaluation = evaluateHumanizeCandidate(makeInput({ random: () => 0 }));
  assert.equal(evaluation.allowed, true);
  assert.equal(evaluation.code, 'OK');
  assert.equal(evaluation.delaySeconds, 90);
  assert.equal(evaluation.nextEligibleAt, new Date(NOW.getTime() + 90_000).toISOString());

  const maxDelay = evaluateHumanizeCandidate(makeInput({ random: () => 0.999999 }));
  assert.equal(maxDelay.delaySeconds, 900);

  // 纯延迟函数：任意随机数都在 [min,max] 内。
  const config = makeConfig();
  for (const random of [0, 0.1, 0.5, 0.999]) {
    const delay = humanizeDelaySeconds(config, () => random);
    assert.equal(delay >= 90 && delay <= 900, true);
  }
  const fixed = makeConfig({ policy: { humanize: { delaySeconds: [120, 120] } } });
  assert.equal(humanizeDelaySeconds(fixed, () => 0.42), 120);
});

test('时间：活跃时段外（22:30）拒绝并给出次日 09:00', () => {
  const now = new Date('2026-10-20T14:30:00.000Z'); // 22:30 Asia/Shanghai
  const evaluation = evaluateHumanizeCandidate(makeInput({ now }));
  assert.equal(evaluation.allowed, false);
  assert.equal(evaluation.code, 'OUTSIDE_ACTIVE_HOURS');
  assert.equal(evaluation.nextEligibleAt, '2026-10-21T01:00:00.000Z'); // 次日 09:00 本地
});

test('时间：活跃时段边界左闭右开', () => {
  const atStart = new Date('2026-10-20T01:00:00.000Z'); // 09:00 本地
  assert.equal(isWithinActiveHours(atStart, makeConfig()), true);
  assert.equal(evaluateHumanizeCandidate(makeInput({ now: atStart })).allowed, true);

  const atEnd = new Date('2026-10-20T14:00:00.000Z'); // 22:00 本地
  assert.equal(isWithinActiveHours(atEnd, makeConfig()), false);
  const evaluation = evaluateHumanizeCandidate(makeInput({ now: atEnd }));
  assert.equal(evaluation.allowed, false);
  assert.equal(evaluation.codes.includes('OUTSIDE_ACTIVE_HOURS'), true);
});

test('时间：安静时段优先于活跃时段，且下一个可发时间晚于安静时段结束', () => {
  const now = new Date('2026-10-20T16:30:00.000Z'); // 次日 00:30 Asia/Shanghai
  const evaluation = evaluateHumanizeCandidate(makeInput({ now }));
  assert.equal(evaluation.allowed, false);
  assert.equal(evaluation.codes.includes('QUIET_HOURS'), true);
  assert.equal(evaluation.nextEligibleAt, '2026-10-21T01:00:00.000Z'); // 09:00 本地
  const quietEnd = nextQuietHoursEnd(now, makeConfig());
  assert.equal(quietEnd.toISOString(), '2026-10-21T00:00:00.000Z'); // 08:00 本地
  const nextActive = nextActiveWindowStart(now, makeConfig());
  assert.equal(nextActive.toISOString(), '2026-10-21T01:00:00.000Z'); // 09:00 本地
});

test('时区：使用 config.policy.timeZone 而不是宿主时区', () => {
  const utc = makeConfig({ policy: { timeZone: 'UTC' } });
  const atNineUtc = new Date('2026-10-20T09:00:00.000Z');
  assert.equal(evaluateHumanizeCandidate(makeInput({ now: atNineUtc, config: utc })).allowed, true);

  const outside = new Date('2026-10-20T22:30:00.000Z');
  const evaluation = evaluateHumanizeCandidate(makeInput({ now: outside, config: utc }));
  assert.equal(evaluation.allowed, false);
  assert.equal(evaluation.nextEligibleAt, '2026-10-21T09:00:00.000Z');
});

test('每日上限：达到 dailyLimit 后拒绝并指向次日活跃时段开始', () => {
  const evaluation = evaluateHumanizeCandidate(makeInput({ todayCount: 3 }));
  assert.equal(evaluation.allowed, false);
  assert.equal(evaluation.code, 'DAILY_LIMIT');
  assert.equal(evaluation.nextEligibleAt, '2026-10-21T01:00:00.000Z');
  // 未达上限仍可发送。
  assert.equal(evaluateHumanizeCandidate(makeInput({ todayCount: 2 })).allowed, true);
});

test('间隔：小于最小间隔时拒绝，且提示精确的下次可发时间', () => {
  const config = makeConfig({ policy: { humanize: { minIntervalSeconds: 600, jitterSeconds: 0 } } });
  const lastPublishedAt = new Date(NOW.getTime() - 300_000).toISOString();
  const blocked = evaluateHumanizeCandidate(makeInput({ config, lastPublishedAt }));
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.codes.includes('MIN_INTERVAL'), true);
  assert.equal(blocked.nextEligibleAt, new Date(new Date(lastPublishedAt).getTime() + 600_000).toISOString());

  const second = makeConfig({ policy: { humanize: { minIntervalSeconds: 600, jitterSeconds: 0 } } });
  const past = new Date(NOW.getTime() - 601_000).toISOString();
  assert.equal(evaluateHumanizeCandidate(makeInput({ config: second, lastPublishedAt: past })).allowed, true);
});

test('间隔：抖动有界，且与 policy.minIntervalMinutes 取较大值', () => {
  const config = makeConfig({
    policy: {
      minIntervalMinutes: 10,
      humanize: { minIntervalSeconds: 60, jitterSeconds: 300 },
    },
  });
  assert.equal(effectiveIntervalSeconds(config), 600);
  for (const now of [NOW, new Date('2026-10-20T05:00:00.000Z'), new Date('2026-10-20T06:30:00.000Z')]) {
    const gap = humanizeGapMs(config, 'task_1', now);
    assert.equal(gap >= 600_000, true);
    assert.equal(gap <= 900_000, true);
  }
});

test('重试：指数退避区间、上限与尝试次数封顶', () => {
  const config = makeConfig({ policy: { humanize: { backoffSeconds: [60, 180], maxPublishAttempts: 3 } } });
  assert.equal(retryBackoffSeconds(config, 1), 60);
  assert.equal(retryBackoffSeconds(config, 2), 120);
  assert.equal(retryBackoffSeconds(config, 3), 180);
  assert.equal(retryBackoffSeconds(config, 8), 180);

  const justFailed = new Date(NOW.getTime() - 30_000).toISOString();
  const cooling = makeInput({
    config,
    candidate: makeCandidate({ attempts: 1, lastAttemptAt: justFailed, lastAttemptState: 'FAILED' }),
  });
  const coolingEvaluation = evaluateHumanizeCandidate(cooling);
  assert.equal(coolingEvaluation.allowed, false);
  assert.equal(coolingEvaluation.code, 'RETRY_BACKOFF');
  assert.equal(coolingEvaluation.nextEligibleAt, new Date(new Date(justFailed).getTime() + 60_000).toISOString());

  const cooled = makeInput({
    config,
    candidate: makeCandidate({
      attempts: 1,
      lastAttemptAt: new Date(NOW.getTime() - 61_000).toISOString(),
      lastAttemptState: 'FAILED',
    }),
  });
  assert.equal(evaluateHumanizeCandidate(cooled).allowed, true);

  const capped = makeInput({ config, candidate: makeCandidate({ attempts: 3, lastAttemptAt: NOW.toISOString() }) });
  const cappedEvaluation = evaluateHumanizeCandidate(capped);
  assert.equal(cappedEvaluation.allowed, false);
  assert.equal(cappedEvaluation.code, 'RETRY_LIMIT_REACHED');
});

test('重试：UNCERTAIN / 已点击未确认 永不自动重试', () => {
  const uncertain = evaluateHumanizeCandidate(
    makeInput({ candidate: makeCandidate({ state: 'UNCERTAIN', lastAttemptState: 'UNCERTAIN' }) }),
  );
  assert.equal(uncertain.allowed, false);
  assert.equal(uncertain.codes.includes('UNCERTAIN_REQUIRES_MANUAL_CHECK'), true);

  const publishing = evaluateHumanizeCandidate(makeInput({ candidate: makeCandidate({ lastAttemptState: 'PUBLISHING' }) }));
  assert.equal(publishing.codes.includes('UNCERTAIN_REQUIRES_MANUAL_CHECK'), true);
});

test('审批绑定：未批准/被消费/过期/内容变化 都拒绝自动发送', () => {
  const notApproved = evaluateHumanizeCandidate(makeInput({ candidate: makeCandidate({ approvalStatus: 'pending' }) }));
  assert.equal(notApproved.allowed, false);
  assert.equal(notApproved.codes.includes('APPROVAL_REQUIRED'), true);

  const consumed = evaluateHumanizeCandidate(makeInput({ candidate: makeCandidate({ approvalStatus: 'consumed' }) }));
  assert.equal(consumed.codes.includes('APPROVAL_REQUIRED'), true);

  const expired = evaluateHumanizeCandidate(makeInput({ candidate: makeCandidate({ approvalExpiresAt: NOW.toISOString() }) }));
  assert.equal(expired.codes.includes('APPROVAL_EXPIRED'), true);

  const changed = evaluateHumanizeCandidate(makeInput({ candidate: makeCandidate({ approvalContentHash: 'other_hash' }) }));
  assert.equal(changed.codes.includes('CONTENT_CHANGED'), true);

  const noApproval = evaluateHumanizeCandidate(makeInput({ candidate: makeCandidate({ approvalId: null }) }));
  assert.equal(noApproval.codes.includes('APPROVAL_REQUIRED'), true);
});

test('去重：相同内容哈希与高相似度文案都不自动发送', () => {
  const duplicate = evaluateHumanizeCandidate(
    makeInput({ publishedContentHashes: ['hash_1'] }),
  );
  assert.equal(duplicate.allowed, false);
  assert.equal(duplicate.code, 'DUPLICATE_CONTENT');

  const candidate = makeCandidate();
  const similar = evaluateHumanizeCandidate(makeInput({ recentTexts: [candidate.text] }));
  assert.equal(similar.allowed, false);
  assert.equal(similar.code, 'SIMILAR_CONTENT');
  assert.equal(HUMANIZE_DUPLICATE_SIMILARITY, 0.72);

  const different = evaluateHumanizeCandidate(makeInput({ recentTexts: ['今天读了一本关于分布式系统的书，记一句'] }));
  assert.equal(different.allowed, true);
});

test('执行器：不可用/未允许发表/微信未就绪/账号不一致 时拒绝', () => {
  const unavailable = evaluateHumanizeCandidate(makeInput({ desktop: null }));
  assert.equal(unavailable.codes.includes('EXECUTOR_UNAVAILABLE'), true);

  const noAllow = evaluateHumanizeCandidate(
    makeInput({ desktop: { ok: true, allowPublish: false, wechatInstalled: true, wechatReady: true, accountId: 'wxid_test' } }),
  );
  assert.equal(noAllow.codes.includes('PUBLISH_MODE_DISABLED'), true);

  const wechatDown = evaluateHumanizeCandidate(
    makeInput({ desktop: { ok: true, allowPublish: true, wechatInstalled: true, wechatReady: false, accountId: null } }),
  );
  assert.equal(wechatDown.codes.includes('WECHAT_NOT_READY'), true);

  const mismatch = evaluateHumanizeCandidate(
    makeInput({ desktop: { ok: true, allowPublish: true, wechatInstalled: true, wechatReady: true, accountId: 'wxid_other' } }),
  );
  assert.equal(mismatch.codes.includes('ACCOUNT_MISMATCH'), true);
});

test('计划：跳过被阻塞候选，选中第一条可发送候选', () => {
  const plan = planHumanizeTick({
    now: NOW,
    config: makeConfig(),
    control: { killSwitch: false, paused: false },
    desktop: { ok: true, allowPublish: true, wechatInstalled: true, wechatReady: true, accountId: 'wxid_test' },
    lastPublishedAt: null,
    todayCount: 0,
    candidates: [
      makeCandidate({ taskId: 'task_dup', contentHash: 'hash_dup' }),
      makeCandidate({ taskId: 'task_ok', contentHash: 'hash_ok' }),
    ],
    recentTexts: [],
    publishedContentHashes: ['hash_dup'],
    random: () => 0,
  });
  assert.equal(plan.allowed, true);
  assert.equal(plan.taskId, 'task_ok');
  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.skipped[0].taskId, 'task_dup');
  assert.equal(plan.skipped[0].code, 'DUPLICATE_CONTENT');
});

test('计划：全部被阻塞时不选中任何任务，并给出下次可发时间', () => {
  const plan = planHumanizeTick({
    now: new Date('2026-10-20T14:30:00.000Z'), // 22:30 本地
    config: makeConfig(),
    control: { killSwitch: false, paused: false },
    desktop: { ok: true, allowPublish: true, wechatInstalled: true, wechatReady: true, accountId: 'wxid_test' },
    lastPublishedAt: null,
    todayCount: 0,
    candidates: [makeCandidate()],
    recentTexts: [],
    publishedContentHashes: [],
    random: () => 0,
  });
  assert.equal(plan.allowed, false);
  assert.equal(plan.taskId, null);
  assert.equal(plan.nextEligibleAt, '2026-10-21T01:00:00.000Z');
  assert.equal(appliedHumanizePolicy(makeConfig()).publishMode, 'APPROVAL_REQUIRED');
});

test('状态辅助：nextTimeEligibleAt 汇总时间类限制', () => {
  const config = makeConfig({ policy: { humanize: { minIntervalSeconds: 600, jitterSeconds: 0 } } });
  const lastPublishedAt = new Date(NOW.getTime() - 300_000).toISOString();
  const next = nextTimeEligibleAt(NOW, config, lastPublishedAt, 0);
  assert.equal(next.toISOString(), new Date(new Date(lastPublishedAt).getTime() + 600_000).toISOString());

  const limitReached = nextTimeEligibleAt(NOW, config, null, 3);
  assert.equal(limitReached.toISOString(), '2026-10-21T01:00:00.000Z');
});
