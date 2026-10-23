/**
 * 图像 Provider 单元测试：默认关闭付费/未授权通道、手动通道等待用户、ComfyUI 回环探测与超时取消。
 * 全部使用注入的 Mock fetch，不访问真实网络。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ManualSubscriptionBridge } from '../../dist/image/providers/manual-subscription.js';
import { LocalImportProvider } from '../../dist/image/providers/local-import.js';
import { CodexSubscriptionProvider } from '../../dist/image/providers/codex-subscription.js';
import { OfficialApiImageProvider } from '../../dist/image/providers/official-api.js';
import { LocalGenerationProvider } from '../../dist/image/providers/local-generation.js';
import { makePatternPng } from '../../fixtures/images/png.mjs';

function generationRequest(overrides = {}) {
  return {
    taskId: 'task_image_1',
    prompt: '一只橘猫在窗边晒太阳',
    negativePrompt: '文字，水印',
    aspectRatio: '1:1',
    resolution: '1024x1024',
    referenceImages: [],
    styleProfile: '自然光',
    privacyLevel: 'private',
    targetProvider: 'local_generation',
    maxAttempts: 1,
    ...overrides,
  };
}

function jsonResponse(payload, init = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    async json() {
      return payload;
    },
    async arrayBuffer() {
      return new ArrayBuffer(0);
    },
  };
}

function binaryResponse(bytes) {
  return {
    ok: true,
    status: 200,
    async json() {
      return {};
    },
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

// ---------------------------------------------------------------------------
// 手动 / 本地导入 / 社区订阅
// ---------------------------------------------------------------------------

test('ManualSubscriptionBridge：默认可用但只返回 awaiting_user，不自动生图', async () => {
  const provider = new ManualSubscriptionBridge();
  const capabilities = await provider.checkCapabilities();
  assert.equal(capabilities.available, true);
  assert.equal(capabilities.requiresUserAction, true);
  assert.equal(capabilities.supportsGeneration, false);
  const result = await provider.generate(generationRequest());
  assert.equal(result.status, 'awaiting_user');
  assert.equal(result.requiresUserAction, true);
  assert.equal(result.errorCode, null);
  assert.deepEqual([...result.images], []);
  assert.match(result.message, /moments_import_image/);
  assert.match(result.message, /不会自动登录/);
  assert.equal((await provider.getStatus('task_image_1'))?.status, 'awaiting_user');
  assert.equal(await provider.cancel('task_image_1'), false, '手动通道没有可取消的自动生成');
});

test('LocalImportProvider：返回 awaiting_user 并提示授权要求', async () => {
  const provider = new LocalImportProvider();
  const result = await provider.generate(generationRequest({ targetProvider: 'local_import' }));
  assert.equal(result.status, 'awaiting_user');
  assert.equal(result.requiresUserAction, true);
  assert.equal(result.errorCode, null);
  assert.match(result.message, /moments_import_image/);
  assert.match(result.message, /授权/);
});

test('CodexSubscriptionProvider：永远 unavailable，错误码为 UNSUPPORTED_AUTHORIZATION', async () => {
  const provider = new CodexSubscriptionProvider();
  const capabilities = await provider.checkCapabilities();
  assert.equal(capabilities.available, false);
  const result = await provider.generate(generationRequest({ targetProvider: 'codex_subscription' }));
  assert.equal(result.status, 'unavailable');
  assert.equal(result.errorCode, 'UNSUPPORTED_AUTHORIZATION');
  assert.ok(result.message.includes('Cookie'));
  assert.equal(await provider.getStatus('task_image_1'), null);
  assert.equal(await provider.cancel('task_image_1'), false);
});

// ---------------------------------------------------------------------------
// 官方付费 API
// ---------------------------------------------------------------------------

const png = makePatternPng(64, 64);
const pngBase64 = Buffer.from(png).toString('base64');

function officialMock(payload = { data: [{ b64_json: pngBase64 }] }, responseInit = {}) {
  const calls = [];
  return {
    calls,
    async fetch(url, init) {
      calls.push({ url, init });
      return jsonResponse(payload, responseInit);
    },
  };
}

test('OfficialApi：默认关闭，永远返回 OFFICIAL_API_DISABLED 且不发网络请求', async () => {
  const mock = officialMock();
  const provider = new OfficialApiImageProvider({
    config: { officialApiEnabled: false },
    env: {},
    fetch: mock.fetch,
  });
  const capabilities = await provider.checkCapabilities();
  assert.equal(capabilities.available, false);
  const result = await provider.generate(generationRequest({ targetProvider: 'official_api' }));
  assert.equal(result.status, 'unavailable');
  assert.equal(result.errorCode, 'OFFICIAL_API_DISABLED');
  assert.equal(mock.calls.length, 0, '默认关闭时不得发出任何网络请求');
});

test('OfficialApi：缺少密钥 / 总预算 / 显式 maxUsd 时逐级拒绝', async () => {
  const mock = officialMock();
  const noKey = new OfficialApiImageProvider({
    config: { officialApiEnabled: true },
    env: {},
    fetch: mock.fetch,
    maxUsd: 1,
  });
  assert.match((await noKey.generate(generationRequest())).errorCode ?? '', /OFFICIAL_API_KEY_MISSING/);

  const noBudget = new OfficialApiImageProvider({
    config: { officialApiEnabled: true },
    env: { DSH_MOMENTS_OFFICIAL_IMAGE_API_KEY: 'test-key' },
    fetch: mock.fetch,
    maxUsd: 1,
  });
  assert.equal((await noBudget.generate(generationRequest())).errorCode, 'OFFICIAL_API_BUDGET_REQUIRED');

  const noMaxUsd = new OfficialApiImageProvider({
    config: { officialApiEnabled: true },
    env: { DSH_MOMENTS_OFFICIAL_IMAGE_API_KEY: 'test-key', DSH_MOMENTS_IMAGE_BUDGET_USD: '5' },
    fetch: mock.fetch,
  });
  assert.equal((await noMaxUsd.checkCapabilities()).available, false);
  assert.equal((await noMaxUsd.generate(generationRequest())).errorCode, 'OFFICIAL_API_BUDGET_REQUIRED');
  assert.equal(mock.calls.length, 0, '未显式授权预算时不得产生付费调用');
});

test('OfficialApi：显式启用且预算合法时才生成，并携带 Authorization', async () => {
  const mock = officialMock();
  const provider = new OfficialApiImageProvider({
    config: { officialApiEnabled: true },
    env: { DSH_MOMENTS_OFFICIAL_IMAGE_API_KEY: 'test-key', DSH_MOMENTS_IMAGE_BUDGET_USD: '5' },
    fetch: mock.fetch,
    maxUsd: 0.5,
    model: 'test-image-model',
  });
  const capabilities = await provider.checkCapabilities();
  assert.equal(capabilities.available, true);
  const result = await provider.generate(generationRequest({ targetProvider: 'official_api' }));
  assert.equal(result.status, 'ready');
  assert.equal(result.errorCode, null);
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].mime, 'image/png');
  assert.equal(result.images[0].license, 'official-api-paid');
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0].url, 'https://api.openai.com/v1/images/generations');
  assert.equal(mock.calls[0].init.headers.Authorization, 'Bearer test-key');
  const body = JSON.parse(mock.calls[0].init.body);
  assert.equal(body.model, 'test-image-model');
  assert.equal(body.response_format, 'b64_json');
});

test('OfficialApi：预算耗尽后拒绝继续付费调用', async () => {
  const mock = officialMock();
  const provider = new OfficialApiImageProvider({
    config: { officialApiEnabled: true },
    env: { DSH_MOMENTS_OFFICIAL_IMAGE_API_KEY: 'test-key', DSH_MOMENTS_IMAGE_BUDGET_USD: '1' },
    fetch: mock.fetch,
    maxUsd: 0.6,
    estimatedCostPerImageUsd: 0.6,
  });
  const first = await provider.generate(generationRequest());
  assert.equal(first.status, 'ready');
  const second = await provider.generate(generationRequest({ taskId: 'task_image_2' }));
  assert.equal(second.status, 'unavailable');
  assert.equal(second.errorCode, 'OFFICIAL_API_BUDGET_EXHAUSTED');
  assert.equal(mock.calls.length, 1);
});

test('OfficialApi：HTTP 错误与非法响应都明确失败，不伪造成功', async () => {
  const errorMock = officialMock({}, { ok: false, status: 429 });
  const provider = new OfficialApiImageProvider({
    config: { officialApiEnabled: true },
    env: { DSH_MOMENTS_OFFICIAL_IMAGE_API_KEY: 'test-key', DSH_MOMENTS_IMAGE_BUDGET_USD: '5' },
    fetch: errorMock.fetch,
    maxUsd: 0.5,
  });
  const failed = await provider.generate(generationRequest());
  assert.equal(failed.status, 'failed');
  assert.equal(failed.errorCode, 'OFFICIAL_API_REQUEST_FAILED');
  assert.deepEqual([...failed.images], []);

  const invalidMock = officialMock({ data: [{ url: 'https://example.com/x.png' }] });
  const invalid = new OfficialApiImageProvider({
    config: { officialApiEnabled: true },
    env: { DSH_MOMENTS_OFFICIAL_IMAGE_API_KEY: 'test-key', DSH_MOMENTS_IMAGE_BUDGET_USD: '5' },
    fetch: invalidMock.fetch,
    maxUsd: 0.5,
  });
  const invalidResult = await invalid.generate(generationRequest());
  assert.equal(invalidResult.status, 'failed');
  assert.equal(invalidResult.errorCode, 'OFFICIAL_API_INVALID_RESPONSE', '不接受 url 响应，避免二次请求任意主机');
});

test('OfficialApi：非 https 且非回环的端点被拒绝', async () => {
  const mock = officialMock();
  const provider = new OfficialApiImageProvider({
    config: { officialApiEnabled: true },
    env: { DSH_MOMENTS_OFFICIAL_IMAGE_API_KEY: 'test-key', DSH_MOMENTS_IMAGE_BUDGET_USD: '5' },
    fetch: mock.fetch,
    maxUsd: 0.5,
    apiBaseUrl: 'http://example.com/v1/images',
  });
  assert.equal((await provider.checkCapabilities()).available, false);
  assert.equal((await provider.generate(generationRequest())).status, 'unavailable');
  assert.equal(mock.calls.length, 0);
});

// ---------------------------------------------------------------------------
// 本地 ComfyUI
// ---------------------------------------------------------------------------

function comfyMock(options = {}) {
  const calls = [];
  let historyCallCount = 0;
  const checkpoints = options.checkpoints ?? ['sd15.safetensors'];
  const outputs = options.outputs ?? { '7': { images: [{ filename: 'out-1.png', subfolder: '', type: 'output' }] } };
  const viewBytes = options.viewBytes ?? makePatternPng(32, 32);
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET' });
    if (url.endsWith('/system_stats')) {
      if (options.systemStatsDown === true) throw new Error('ECONNREFUSED');
      return jsonResponse(options.stats ?? { system: { os: 'nt', ram_free: 8 * 1024 ** 3 }, devices: [{ type: 'cpu', vram_total: 16 * 1024 ** 3, vram_free: 8 * 1024 ** 3 }] });
    }
    if (url.endsWith('/object_info')) {
      if (options.objectInfoDown === true) return jsonResponse({});
      if (checkpoints.length === 0) return jsonResponse({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [[]] } } } });
      const nodes = Object.fromEntries(['CLIPTextEncode', 'EmptyLatentImage', 'KSampler', 'VAEDecode', 'SaveImage'].map(name => [name, {}]));
      delete nodes[options.missingNode];
      return jsonResponse({ ...nodes, CheckpointLoaderSimple: { input: { required: { ckpt_name: [checkpoints] } } } });
    }
    if (url.endsWith('/queue')) return jsonResponse(options.queue ?? { queue_running: [], queue_pending: [] }, { ok: !options.queueDown, status: options.queueDown ? 503 : 200 });
    if (url.endsWith('/prompt')) {
      if (options.rejectPrompt === true) return jsonResponse({ error: 'bad workflow' }, { ok: false, status: 400 });
      return jsonResponse({ prompt_id: 'prompt-1' });
    }
    if (url.includes('/history/')) {
      historyCallCount += 1;
      const sequence = options.history ?? [{ 'prompt-1': { outputs } }];
      return jsonResponse(sequence[Math.min(historyCallCount - 1, sequence.length - 1)]);
    }
    if (url.includes('/view?')) return binaryResponse(viewBytes);
    return jsonResponse({});
  };
  return { fetch: fetchImpl, calls, get historyCallCount() { return historyCallCount; } };
}

test('LocalGeneration：预检拒绝缺失节点、资源未知、内存不足及繁忙/异常队列且不提交', async () => {
  const scenarios = [
    [{ missingNode: 'VAEDecode' }, /VAEDecode/],
    [{ stats: {} }, /内存/],
    [{ stats: { system: { ram_free: 100 } } }, /512 MiB/],
    [{ stats: { system: { ram_free: 8 * 1024 ** 3 }, devices: [] } }, /设备/],
    [{ queue: {} }, /队列状态未知/],
    [{ queue: { queue_running: [{}], queue_pending: Array(7).fill({}) } }, /队列繁忙/],
    [{ queueDown: true }, /HTTP 503/],
  ];
  for (const [options, reason] of scenarios) {
    const mock = comfyMock(options);
    const provider = new LocalGenerationProvider({ fetch: mock.fetch });
    const result = await provider.generate(generationRequest());
    assert.equal(result.status, 'unavailable');
    assert.match(result.message, reason);
    assert.ok(!mock.calls.some(call => call.method === 'POST'), '预检失败不能提交任务');
  }
});

test('LocalGeneration：非回环地址直接不可用', async () => {
  const mock = comfyMock();
  const provider = new LocalGenerationProvider({ baseUrl: 'http://10.0.0.5:8188', fetch: mock.fetch });
  const capabilities = await provider.checkCapabilities();
  assert.equal(capabilities.available, false);
  assert.ok(capabilities.reasons.some((reason) => reason.includes('回环')));
  const result = await provider.generate(generationRequest());
  assert.equal(result.status, 'unavailable');
  assert.equal(result.errorCode, 'IMAGE_PROVIDER_UNAVAILABLE');
});

test('LocalGeneration：DSH_MOMENTS_COMFYUI_URL 覆盖默认地址，且只允许回环', async () => {
  const mock = comfyMock();
  const provider = new LocalGenerationProvider({
    env: { DSH_MOMENTS_COMFYUI_URL: 'http://127.0.0.1:9999' },
    fetch: mock.fetch,
  });
  const capabilities = await provider.checkCapabilities();
  assert.equal(capabilities.available, true);
  assert.ok(mock.calls.every((call) => call.url.startsWith('http://127.0.0.1:9999')), '请求必须发往覆盖后的回环地址');

  const bad = new LocalGenerationProvider({ env: { DSH_MOMENTS_COMFYUI_URL: 'http://192.168.1.2:8188' }, fetch: mock.fetch });
  assert.equal((await bad.checkCapabilities()).available, false);
});

test('LocalGeneration：模型不可用时返回 unavailable，不提交生成', async () => {
  const mock = comfyMock({ checkpoints: [] });
  const provider = new LocalGenerationProvider({ baseUrl: 'http://127.0.0.1:8188', fetch: mock.fetch });
  const capabilities = await provider.checkCapabilities();
  assert.equal(capabilities.available, false);
  const result = await provider.generate(generationRequest());
  assert.equal(result.status, 'unavailable');
  assert.ok(!mock.calls.some((call) => call.url.endsWith('/prompt')), '模型不可用时不得提交工作流');
});

test('LocalGeneration：ComfyUI 连接失败时返回 unavailable', async () => {
  const mock = comfyMock({ systemStatsDown: true });
  const provider = new LocalGenerationProvider({ baseUrl: 'http://127.0.0.1:8188', fetch: mock.fetch });
  const result = await provider.generate(generationRequest());
  assert.equal(result.status, 'unavailable');
  assert.match(result.message, /ComfyUI/);
});

test('LocalGeneration：submit + 轮询 /history + 下载 /view 的最小生成路径', async () => {
  const mock = comfyMock();
  const provider = new LocalGenerationProvider({
    baseUrl: 'http://127.0.0.1:8188',
    fetch: mock.fetch,
    sleep: async () => {},
    pollIntervalMs: 10,
    timeoutMs: 2_000,
  });
  const result = await provider.generate(generationRequest());
  assert.equal(result.status, 'ready');
  assert.equal(result.errorCode, null);
  assert.equal(result.model, 'sd15.safetensors');
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].mime, 'image/png');
  assert.equal(result.images[0].license, 'generated-local');
  assert.ok(mock.calls.some((call) => call.url.endsWith('/prompt') && call.method === 'POST'));
  assert.ok(mock.calls.some((call) => call.url.includes('/history/')));
  assert.ok(mock.calls.some((call) => call.url.includes('/view?filename=out-1.png')));
  assert.equal((await provider.getStatus('task_image_1'))?.status, 'ready');
});

test('LocalGeneration：工作流被拒绝时返回 unavailable', async () => {
  const mock = comfyMock({ rejectPrompt: true });
  const provider = new LocalGenerationProvider({
    baseUrl: 'http://127.0.0.1:8188',
    fetch: mock.fetch,
    sleep: async () => {},
    pollIntervalMs: 10,
  });
  const result = await provider.generate(generationRequest());
  assert.equal(result.status, 'unavailable');
  assert.equal(result.errorCode, 'COMFYUI_WORKFLOW_REJECTED');
});

test('LocalGeneration：轮询超时返回 failed + COMFYUI_TIMEOUT', async () => {
  const mock = comfyMock({ history: [{}] });
  const provider = new LocalGenerationProvider({
    baseUrl: 'http://127.0.0.1:8188',
    fetch: mock.fetch,
    sleep: async () => {},
    pollIntervalMs: 10,
    timeoutMs: 1_000,
  });
  const result = await provider.generate(generationRequest());
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'COMFYUI_TIMEOUT');
});

test('LocalGeneration：AbortSignal 取消返回 cancelled', async () => {
  const mock = comfyMock({ history: [{}] });
  const provider = new LocalGenerationProvider({
    baseUrl: 'http://127.0.0.1:8188',
    fetch: mock.fetch,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    pollIntervalMs: 30,
    timeoutMs: 2_000,
  });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 80);
  const result = await provider.generate(generationRequest({ signal: controller.signal }));
  assert.equal(result.status, 'cancelled');
  assert.equal(result.errorCode, 'CANCELLED');
});

test('LocalGeneration：provider.cancel 可中止进行中的生成', async () => {
  const mock = comfyMock({ history: [{}] });
  const provider = new LocalGenerationProvider({
    baseUrl: 'http://127.0.0.1:8188',
    fetch: mock.fetch,
    pollIntervalMs: 30,
    timeoutMs: 2_000,
  });
  const pending = provider.generate(generationRequest({ taskId: 'task_cancel_me' }));
  setTimeout(() => {
    void provider.cancel('task_cancel_me');
  }, 100);
  const result = await pending;
  assert.equal(result.status, 'cancelled');
});
