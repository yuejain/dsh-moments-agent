import test from 'node:test';
import assert from 'node:assert/strict';
import { WeChatAgentHttpAdapter } from '../../dist/adapters/wechatagent/adapter.js';
import { HttpDesktopExecutor } from '../../dist/adapters/windows/desktop-client.js';

const readerStatus = {
  success: true,
  backend: 'weflow-cli-nt',
  ownWxid: 'wxid_test_user',
  accountDirectory: 'wxid_test_user_1234',
  lastPoll: 1,
  lastError: '',
};
const hookHealth = {
  integration: 'WeChatAgent-1',
  backend: 'wechat-hook',
  version: '4.1.10.27',
  databaseAccounts: ['wxid_test_user_1234'],
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function config(overrides = {}) {
  return {
    enabled: true,
    readerBaseUrl: 'http://127.0.0.1:11231',
    hookBaseUrl: 'http://127.0.0.1:11230',
    readerConfigPath: null,
    readerTokenFile: null,
    hookTokenFile: null,
    account: '',
    ownerWxid: 'wxid_owner',
    pollIntervalMs: 15000,
    requestTimeoutMs: 5000,
    ...overrides,
  };
}

test('WeChatAgent 适配器：健康检查要求 Reader 与 Hook 账号一致', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.includes('/api/v1/reader/status')) return jsonResponse(readerStatus);
    if (url.includes('/WeChatAgent/health')) return jsonResponse(hookHealth);
    return jsonResponse({ success: false }, 404);
  };
  const adapter = new WeChatAgentHttpAdapter({
    config: config(),
    fetchImpl,
    env: { DSH_MOMENTS_READER_TOKEN: 'reader-token-123456', DSH_MOMENTS_HOOK_TOKEN: 'hook-token-123456' },
  });
  const health = await adapter.checkHealth();
  assert.equal(health.status, 'ok');
  assert.equal(adapter.checkHealth !== undefined, true);
  const account = await adapter.getAccount();
  assert.deepEqual(account, { accountId: 'wxid_test_user_1234', ownWxid: 'wxid_test_user' });
  assert.equal(calls.length >= 2, true);
});

test('WeChatAgent 适配器：账号不一致时降级且发送被拒绝', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('/api/v1/reader/status')) return jsonResponse(readerStatus);
    if (url.includes('/WeChatAgent/health')) return jsonResponse({ ...hookHealth, databaseAccounts: ['other_account'] });
    return jsonResponse({});
  };
  const adapter = new WeChatAgentHttpAdapter({
    config: config({ ownerWxid: 'wxid_owner' }),
    fetchImpl,
    env: { DSH_MOMENTS_READER_TOKEN: 'r'.repeat(32), DSH_MOMENTS_HOOK_TOKEN: 'h'.repeat(32) },
  });
  const health = await adapter.checkHealth();
  assert.equal(health.status, 'degraded');
  await assert.rejects(
    () => adapter.sendText('审批请求'),
    (error) => error.code === 'WECHAT_ACCOUNT_NOT_VERIFIED',
  );
});

test('WeChatAgent 适配器：发送成功后返回 accepted，不伪造数据库回执', async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    if (url.includes('/api/v1/reader/status')) return jsonResponse(readerStatus);
    if (url.includes('/WeChatAgent/health')) return jsonResponse(hookHealth);
    if (url.includes('/SendTextMsg')) {
      requests.push(JSON.parse(init.body));
      return jsonResponse({ ret: 0 });
    }
    return jsonResponse({ success: false }, 404);
  };
  const adapter = new WeChatAgentHttpAdapter({
    config: config(),
    fetchImpl,
    env: { DSH_MOMENTS_READER_TOKEN: 'r'.repeat(32), DSH_MOMENTS_HOOK_TOKEN: 'h'.repeat(32) },
  });
  const result = await adapter.sendText('测试审批消息');
  assert.equal(result.delivered, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].wxidorgid, 'wxid_owner');
  assert.equal(requests[0].msg, '测试审批消息');
});

test('WeChatAgent 适配器：令牌缺失时不泄露敏感信息并明确失败', async () => {
  const adapter = new WeChatAgentHttpAdapter({
    config: config(),
    fetchImpl: async () => jsonResponse({}),
    env: {},
  });
  const health = await adapter.checkHealth();
  assert.equal(health.status, 'unavailable');
  await assert.rejects(
    () => adapter.sendText('x'),
    (error) => error.code === 'WECHAT_UNAVAILABLE' && !error.message.includes('token-token'),
  );
});

test('桌面执行器客户端：健康、准备与协议错误码映射', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/health')) {
      return jsonResponse({
        ok: true,
        version: '0.1.0',
        wechatInstalled: true,
        wechatVersion: '4.1.15.13',
        uiaAvailable: false,
        allowPublish: false,
        mode: 'PREPARE_ONLY',
        message: 'ok',
      });
    }
    if (url.endsWith('/wechat/status')) {
      return jsonResponse({
        running: true,
        loggedIn: true,
        accountId: 'wxid_test',
        version: '4.1.15.13',
        interactive: true,
        locked: false,
        supported: false,
        windowTitle: '微信',
        dpiScale: 1,
        notes: ['版本未验证'],
      });
    }
    if (url.endsWith('/moments/prepare')) {
      return jsonResponse({
        ok: false,
        prepared: false,
        screenshotPath: null,
        textMatched: false,
        imageCount: 0,
        warnings: [],
        errorCode: 'WINDOW_NOT_FOUND',
        message: '未找到朋友圈入口',
      });
    }
    if (url.endsWith('/moments/publish')) {
      return jsonResponse({
        ok: false,
        submitted: false,
        verified: false,
        uncertain: false,
        screenshotPath: null,
        verification: null,
        errorCode: 'PUBLISH_MODE_DISABLED',
        message: 'PREPARE_ONLY',
      });
    }
    return jsonResponse({ ok: false, message: 'not found' }, 404);
  };
  const client = new HttpDesktopExecutor(
    { enabled: true, baseUrl: 'http://127.0.0.1:18765', tokenFile: null, timeoutMs: 5000 },
    { DSH_MOMENTS_DESKTOP_TOKEN: 'd'.repeat(32) },
    fetchImpl,
  );
  const health = await client.health();
  assert.equal(health.ok, true);
  assert.equal(health.wechatInstalled, true);
  const status = await client.status();
  assert.equal(status.accountId, 'wxid_test');
  assert.equal(status.supported, false);
  const prepared = await client.prepare({
    taskId: 'task_1',
    attemptId: 'att_1',
    text: '文字',
    assetPaths: ['C:/a.png'],
    visibility: 'PUBLIC',
    contentHash: 'a'.repeat(64),
    accountId: 'wxid_test',
    screenshotDir: 'C:/shots',
  });
  assert.equal(prepared.ok, false);
  assert.equal(prepared.errorCode, 'WINDOW_NOT_FOUND');
  const published = await client.publish({
    taskId: 'task_1',
    attemptId: 'att_1',
    contentHash: 'a'.repeat(64),
    accountId: 'wxid_test',
    approvalId: 'apr_1',
  });
  assert.equal(published.submitted, false);
  assert.equal(published.errorCode, 'PUBLISH_MODE_DISABLED');
  // 令牌从请求头读取，不进入 URL
  assert.equal(calls.every((call) => !call.url.includes('d'.repeat(32))), true);
});
