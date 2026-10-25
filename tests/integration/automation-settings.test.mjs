import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { createTestContext } from '../helpers/mock.mjs';
import { makeRuntime, setupApproved, silentLogger } from '../helpers/flow.mjs';
import { AdminServer } from '../../dist/admin/server.js';

test('调度保存立即生效并在重新创建运行时后恢复，不扩大发表权限', async () => {
  const ctx = await createTestContext();
  try {
    const runtime = makeRuntime(ctx);
    const result = runtime.updateAutomation({ scheduleEnabled: true,
      scheduler: { tickSeconds: 120, ideaProbability: 0.35, jitterSeconds: 30 },
      policy: { dailyLimit: 4, timeZone: 'Asia/Singapore', humanize: { enabled: true, delaySeconds: [20, 60] } } });
    assert.equal(result.scheduler.tickSeconds, 120);
    assert.equal(result.status.enabled, true);
    assert.equal(ctx.config.policy.dailyLimit, 4);
    assert.equal(runtime.publishModeView().mode, 'PREPARE_ONLY');
    assert.ok(result.status.blockedReasons.includes('PUBLISH_MODE_DISABLED'));
    ctx.config.policy.humanize.enabled = false;
    ctx.config.policy.dailyLimit = 3;
    const restored = makeRuntime(ctx).automationView();
    assert.equal(restored.scheduleEnabled, true);
    assert.equal(restored.policy.humanize.enabled, true);
    assert.equal(restored.policy.dailyLimit, 4);
    assert.equal(restored.policy.timeZone, 'Asia/Singapore');
  } finally { ctx.cleanup(); }
});

test('无效调度和越权字段不产生部分保存', async () => {
  const ctx = await createTestContext();
  try {
    const runtime = makeRuntime(ctx);
    for (const value of [ { publishMode: 'POLICY_AUTONOMOUS' }, { policy: { requireApproval: false } },
      { scheduler: null }, { scheduleEnabled: null }, { scheduler: { tickSeconds: 0 } },
      { policy: { timeZone: 'Invalid/Zone' } }, { policy: { humanize: { delaySeconds: [60, 20] } } },
      { policy: { humanize: { activeHours: ['10:00', '10:00'] } } } ]) {
      assert.throws(() => runtime.updateAutomation(value));
      assert.equal(ctx.store.getSetting('publish_schedule_config'), undefined);
      assert.equal(ctx.store.getSetting('schedule_config'), undefined);
    }
  } finally { ctx.cleanup(); }
});

test('调度保存保留已有队列等待、失败次数和耗尽标记', async () => {
  const ctx = await createTestContext();
  try {
    const runtime = makeRuntime(ctx);
    const existing = JSON.stringify({version:1, entries:[{taskId:'existing',scheduledAt:'2030-01-01T00:00:00Z',attempts:2,exhausted:true}]});
    ctx.store.setSetting('humanize_state', existing);
    runtime.updateAutomation({ policy: { dailyLimit: 1 } });
    assert.equal(ctx.store.getSetting('humanize_state'), existing);
    assert.equal(runtime.automationView().policy.humanize.enabled, false);
  } finally { ctx.cleanup(); }
});

test('设置卡开启发送后既有调度器使用新配置，关闭后不继续调度', async () => {
  const ctx = await setupApproved({runtimeOverrides:{clock:()=>new Date('2026-10-20T04:00:30Z')}});
  try {
    ctx.runtime.updateAutomation({policy:{humanize:{enabled:true,delaySeconds:[0,0],jitterSeconds:0,minIntervalSeconds:0}}});
    await ctx.runtime.humanizeTick();
    assert.equal((await ctx.runtime.humanizeTick()).action, 'published');
    ctx.runtime.updateAutomation({policy:{humanize:{enabled:false}}});
    assert.equal((await ctx.runtime.humanizeTick()).action, 'disabled');
    assert.equal(ctx.desktop.calls.filter(c=>c.method==='publish').length,1);
  } finally { ctx.cleanup(); }
});

test('调度 HTTP 接口要求鉴权，保存与读取一致', async () => {
  const ctx = await createTestContext();
  const tokenFile = path.join(ctx.dir, 'admin-token.txt');
  const server = new AdminServer({runtime:makeRuntime(ctx),logger:silentLogger,host:'127.0.0.1',port:0,tokenFile});
  try {
    await server.start();
    const url = `http://127.0.0.1:${server.server.address().port}/api/automation`;
    assert.equal((await fetch(url)).status, 401);
    const headers = {'X-Moments-Token':readFileSync(tokenFile,'utf8').trim(),'Content-Type':'application/json'};
    const update = await fetch(url,{method:'POST',headers,body:JSON.stringify({scheduler:{tickSeconds:180}})});
    assert.equal(update.status,200);
    assert.equal((await update.json()).data.scheduler.tickSeconds,180);
    const get = await fetch(url,{headers});
    assert.equal((await get.json()).data.scheduler.tickSeconds,180);
  } finally { await server.stop(); ctx.cleanup(); }
});
