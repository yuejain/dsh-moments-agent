import test from 'node:test';
import assert from 'node:assert/strict';
import { withVerifiedWechatAccount } from '../../dist/adapters/windows/verified-account.js';
import { setupPrepared } from '../helpers/flow.mjs';
import { MockDesktop } from '../helpers/mock.mjs';

function harness({ id = null, running = true, loggedIn = true, health = 'ok', accounts = ['wxid_test', 'wxid_test'], error = false } = {}) {
  let calls = 0;
  const desktop = { status: async () => ({ running, loggedIn, accountId: id, notes: [], supported: false, locked: true }) };
  const wechat = { getAccount: async () => { calls++; if(error) throw Error('unavailable'); const accountId=accounts.shift(); return accountId ? { accountId, ownWxid: accountId } : null; }, checkHealth: async () => ({ status: health }) };
  return { wrapped: withVerifiedWechatAccount(desktop, wechat), calls: () => calls };
}
test('geometry uses live account only after Reader/Hook health succeeds', async () => {
  const status = await harness().wrapped.status();
  assert.equal(status.accountId, 'wxid_test');
  assert.equal(status.supported, false);
  assert.equal(status.locked, true);
});
for (const health of ['degraded', 'unavailable']) test(`unverified ${health} health cannot fill account`, async () => {
  assert.equal((await harness({ health }).wrapped.status()).accountId, null);
});
test('account changes during verification fail closed', async () => {
  assert.equal((await harness({ accounts: ['wxid_a', 'wxid_b'] }).wrapped.status()).accountId, null);
});
test('missing identity and network failures do not use static config', async () => {
  assert.equal((await harness({ accounts: [null] }).wrapped.status()).accountId, null);
  assert.equal((await harness({ error: true }).wrapped.status()).accountId, null);
});
test('existing desktop account and logged-out session are never overwritten', async () => {
  const current = harness({ id: 'wxid_desktop' });
  assert.equal((await current.wrapped.status()).accountId, 'wxid_desktop');
  assert.equal(current.calls(), 0);
  const loggedOut = harness({ loggedIn: false });
  assert.equal((await loggedOut.wrapped.status()).accountId, null);
  assert.equal(loggedOut.calls(), 0);
});

test('runtime Publisher can publish approved geometry content with verified Reader/Hook identity', async () => {
  const desktop = new MockDesktop({ health: { allowPublish: true }, status: { accountId: null } });
  const wechat = { getAccount: async () => ({ accountId: 'wxid_test', ownWxid: 'wxid_test' }), checkHealth: async () => ({ status: 'ok' }) };
  const flow = await setupPrepared({ desktop, config: { wechatAgent: { enabled: true } }, runtimeOverrides: { wechat } });
  try { assert.equal((await flow.runtime.publish(flow.taskId)).verified, true); }
  finally { flow.cleanup(); }
});

test('runtime Publisher blocks a degraded Reader/Hook identity before clicking publish', async () => {
  const desktop = new MockDesktop({ health: { allowPublish: true }, status: { accountId: null } });
  let healthy = true;
  const wechat = { getAccount: async () => ({ accountId: 'wxid_test', ownWxid: 'wxid_test' }), checkHealth: async () => ({ status: healthy ? 'ok' : 'degraded' }) };
  const flow = await setupPrepared({ desktop, config: { wechatAgent: { enabled: true } }, runtimeOverrides: { wechat } });
  try {
    healthy = false;
    await assert.rejects(flow.runtime.publish(flow.taskId), (error) => error.code === 'ACCOUNT_MISMATCH');
    assert.equal(desktop.calls.filter((call) => call.method === 'publish').length, 0);
  } finally { flow.cleanup(); }
});
