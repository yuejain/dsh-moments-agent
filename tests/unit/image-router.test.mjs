/**
 * ImageRouter 单元测试：配置顺序、能力探测、回退、任务状态、落盘与错误码。
 * 使用真实 MomentsStore + 自定义 Provider Stub，不发起任何网络请求。
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { AssetStore } from '../../dist/image/asset-store.js';
import { ImageRouter } from '../../dist/image/image-router.js';
import { CodexSubscriptionProvider } from '../../dist/image/providers/codex-subscription.js';
import { LocalImportProvider } from '../../dist/image/providers/local-import.js';
import { ManualSubscriptionBridge } from '../../dist/image/providers/manual-subscription.js';
import { MomentsStore } from '../../dist/storage/store.js';
import { makePatternPng } from '../../fixtures/images/png.mjs';

const projectRoot = path.resolve(import.meta.dirname, '../..');
const tempRoots = [];

function makeTempDir(prefix) {
  const base = path.join(projectRoot, '.tmp');
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(path.join(base, prefix));
  tempRoots.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
});

function makeImagesConfig(providers, overrides = {}) {
  return {
    providers,
    officialApiEnabled: false,
    allowNetworkSearch: false,
    maxFileBytes: 12 * 1024 * 1024,
    allowedAspectRatios: ['1:1', '4:3'],
    assetDir: 'assets',
    ...overrides,
  };
}

function providerStub(kind, options = {}) {
  return {
    id: kind,
    async checkCapabilities() {
      return {
        available: options.available ?? true,
        provider: kind,
        requiresUserAction: false,
        supportsEdit: false,
        supportsGeneration: options.available ?? true,
        reasons: options.reasons ?? [],
      };
    },
    async generate() {
      if (options.generate !== undefined) return options.generate();
      return {
        provider: kind,
        model: 'stub',
        status: 'unavailable',
        images: [],
        errorCode: 'IMAGE_PROVIDER_UNAVAILABLE',
        requiresUserAction: false,
        message: 'stub 不可用',
      };
    },
    async getStatus() {
      return null;
    },
    async cancel() {
      return false;
    },
  };
}

function readyResult(kind, bytes) {
  return {
    provider: kind,
    model: 'stub-model',
    status: 'ready',
    images: [
      {
        bytes,
        mime: 'image/png',
        prompt: '测试提示词',
        provider: kind,
        model: 'stub-model',
        license: 'CC0-1.0',
      },
    ],
    errorCode: null,
    requiresUserAction: false,
    message: 'stub 生成成功',
  };
}

async function openEnv(options = {}) {
  const dir = makeTempDir('router-');
  const dataDir = path.join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const store = await MomentsStore.open(path.join(dataDir, 'moments.db'));
  const now = new Date().toISOString();
  store.createTask('task_route');
  if (options.withDraft !== false) {
    store.createDraft(
      {
        draftId: 'draft_route',
        taskId: 'task_route',
        ideaId: 'idea_route',
        version: 1,
        text: '这是用于图片路由测试的文案。',
        tone: 'neutral',
        createdAt: now,
        updatedAt: now,
      },
      'content-hash',
    );
  }
  const assetStore = new AssetStore({ store, dataDir, maxFileBytes: 12 * 1024 * 1024 });
  return {
    dir,
    dataDir,
    store,
    assetStore,
    close() {
      store.close();
    },
  };
}

function makeRouter(env, providers, overrides = {}) {
  return new ImageRouter({
    store: env.store,
    assetStore: env.assetStore,
    images: makeImagesConfig(providers, overrides.images),
    providers: overrides.providers,
  });
}

function routeRequest(overrides = {}) {
  return {
    taskId: 'task_route',
    prompt: '一只橘猫在窗边晒太阳',
    negativePrompt: '',
    aspectRatio: '1:1',
    resolution: '1024x1024',
    styleProfile: '',
    ...overrides,
  };
}

test('generate：manual 通道返回 awaiting_user，并创建 AWAITING_USER 图片任务', async () => {
  const env = await openEnv();
  try {
    const router = makeRouter(env, ['manual-subscription', 'local-import'], {
      providers: new Map([
        ['manual-subscription', new ManualSubscriptionBridge()],
        ['local-import', new LocalImportProvider()],
      ]),
    });
    const result = await router.generate(routeRequest());
    assert.equal(result.status, 'awaiting_user');
    assert.equal(result.provider, 'manual-subscription');
    assert.equal(result.requiresUserAction, true);
    assert.equal(result.errorCode, null);
    assert.deepEqual([...result.assetIds], []);
    assert.match(result.imageTaskId ?? '', /^imgtask_/);
    const imageTask = env.store.getImageTask(result.imageTaskId);
    assert.ok(imageTask !== undefined);
    assert.equal(imageTask.status, 'AWAITING_USER');
    assert.equal(imageTask.requiresUserAction, true);
    assert.equal(imageTask.draftId, 'draft_route');
    assert.equal(imageTask.provider, 'manual_subscription');
    assert.equal(imageTask.attempts, 1);
    assert.match(imageTask.expiresAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    env.close();
  }
});

test('generate：按配置顺序回退，并记录每个通道的尝试结果', async () => {
  const env = await openEnv();
  try {
    const router = makeRouter(env, ['local-generation', 'manual-subscription'], {
      providers: new Map([
        ['local-generation', providerStub('local_generation', { available: false, reasons: ['ComfyUI 未启动'] })],
        ['manual-subscription', new ManualSubscriptionBridge()],
      ]),
    });
    const result = await router.generate(routeRequest());
    assert.equal(result.status, 'awaiting_user');
    assert.equal(result.provider, 'manual-subscription');
    assert.equal(result.attempts.length, 2);
    assert.equal(result.attempts[0].name, 'local-generation');
    assert.equal(result.attempts[0].status, 'unavailable');
    assert.equal(result.attempts[1].name, 'manual-subscription');
    assert.equal(result.attempts[1].status, 'awaiting_user');
  } finally {
    env.close();
  }
});

test('generate：全部通道不可用时返回 IMAGE_PROVIDER_UNAVAILABLE', async () => {
  const env = await openEnv();
  try {
    const router = makeRouter(env, ['local-generation', 'official-api'], {
      providers: new Map([
        ['local-generation', providerStub('local_generation', { available: false, reasons: ['无模型'] })],
        ['official-api', providerStub('official_api', { available: false, reasons: ['默认关闭'] })],
      ]),
    });
    const result = await router.generate(routeRequest());
    assert.equal(result.status, 'unavailable');
    assert.equal(result.errorCode, 'IMAGE_PROVIDER_UNAVAILABLE');
    assert.equal(result.attempts.length, 2);
    assert.match(result.message, /所有图像 Provider 均不可用/);
    assert.equal(env.store.listImageTasksByTask('task_route').length, 0);
  } finally {
    env.close();
  }
});

test('generate：ready 结果经 AssetStore 内容寻址落盘，并更新图片任务为 READY', async () => {
  const env = await openEnv();
  try {
    const bytes = makePatternPng(64, 64);
    const router = makeRouter(env, ['manual-subscription', 'local-import'], {
      providers: new Map([
        ['manual-subscription', providerStub('manual_subscription', { available: false, reasons: ['跳过'] })],
        ['local-import', providerStub('local_import', { generate: () => readyResult('local-import', bytes) })],
      ]),
    });
    const result = await router.generate(routeRequest());
    assert.equal(result.status, 'ready');
    assert.equal(result.errorCode, null);
    assert.equal(result.provider, 'local-import');
    assert.equal(result.model, 'stub-model');
    assert.equal(result.assetIds.length, 1);
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].mime, 'image/png');
    assert.match(result.records[0].path.replaceAll('\\', '/'), /assets\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}\.png$/);
    assert.equal(env.store.countAssets(), 1);
    const imageTask = env.store.getImageTask(result.imageTaskId);
    assert.equal(imageTask.status, 'READY');
    assert.equal(imageTask.requiresUserAction, false);
  } finally {
    env.close();
  }
});

test('generate：重复内容复用素材并提示重复', async () => {
  const env = await openEnv();
  try {
    const bytes = makePatternPng(64, 64);
    const router = makeRouter(env, ['local-import'], {
      providers: new Map([['local-import', providerStub('local_import', { generate: () => readyResult('local-import', bytes) })]]),
    });
    const first = await router.generate(routeRequest());
    const second = await router.generate(routeRequest());
    assert.equal(second.status, 'ready');
    assert.deepEqual(second.assetIds, first.assetIds);
    assert.match(second.message, /重复素材/);
    assert.equal(env.store.countAssets(), 1);
  } finally {
    env.close();
  }
});

test('generate：前一个通道失败后回退，未知通道名被跳过并记录', async () => {
  const env = await openEnv();
  try {
    const bytes = makePatternPng(64, 64);
    const router = makeRouter(env, ['not-a-real-provider', 'local-generation', 'local-import'], {
      providers: new Map([
        [
          'local-generation',
          providerStub('local_generation', {
            generate: () => ({
              provider: 'local-generation',
              model: 'stub',
              status: 'failed',
              images: [],
              errorCode: 'COMFYUI_TIMEOUT',
              requiresUserAction: false,
              message: 'ComfyUI 超时',
            }),
          }),
        ],
        ['local-import', providerStub('local_import', { generate: () => readyResult('local-import', bytes) })],
      ]),
    });
    const result = await router.generate(routeRequest());
    assert.equal(result.status, 'ready');
    assert.equal(result.attempts[0].name, 'not-a-real-provider');
    assert.equal(result.attempts[0].status, 'skipped');
    assert.equal(result.attempts[0].errorCode, 'UNKNOWN_IMAGE_PROVIDER');
    assert.equal(result.attempts[1].status, 'failed');
    assert.equal(result.attempts[2].status, 'ready');
  } finally {
    env.close();
  }
});

test('generate：ready 但图片字节非法时不伪造成功，继续回退', async () => {
  const env = await openEnv();
  try {
    const router = makeRouter(env, ['local-import'], {
      providers: new Map([
        [
          'local-import',
          providerStub('local_import', { generate: () => readyResult('local-import', Buffer.from('not an image', 'utf8')) }),
        ],
      ]),
    });
    const result = await router.generate(routeRequest());
    assert.equal(result.status, 'unavailable');
    assert.equal(result.attempts.at(-1).status, 'failed');
    assert.equal(result.attempts.at(-1).errorCode, 'IMAGE_INVALID');
    assert.deepEqual([...result.assetIds], []);
    assert.equal(env.store.countAssets(), 0);
  } finally {
    env.close();
  }
});

test('generate：targetProvider 只尝试指定通道', async () => {
  const env = await openEnv();
  try {
    const router = makeRouter(env, ['manual-subscription', 'local-import'], {
      providers: new Map([
        ['manual-subscription', new ManualSubscriptionBridge()],
        ['local-import', new LocalImportProvider()],
      ]),
    });
    const result = await router.generate(routeRequest({ targetProvider: 'local_import' }));
    assert.equal(result.status, 'awaiting_user');
    assert.equal(result.provider, 'local-import');
    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0].name, 'local-import');
  } finally {
    env.close();
  }
});

test('generate：参数校验与缺少草稿的明确错误', async () => {
  const env = await openEnv({ withDraft: false });
  try {
    const router = makeRouter(env, ['local-import'], {
      providers: new Map([['local-import', new LocalImportProvider()]]),
    });
    await assert.rejects(router.generate(routeRequest({ prompt: '   ' })), (error) => error.code === 'INVALID_INPUT');
    await assert.rejects(router.generate(routeRequest({ aspectRatio: '5:4' })), (error) => error.code === 'INVALID_INPUT');
    await assert.rejects(router.generate(routeRequest({ resolution: 'huge' })), (error) => error.code === 'INVALID_INPUT');
    await assert.rejects(router.generate(routeRequest()), (error) => error.code === 'NOT_FOUND');
  } finally {
    env.close();
  }
});

test('generate：携带已有 imageTaskId 时更新而非新建任务', async () => {
  const env = await openEnv();
  try {
    const router = makeRouter(env, ['manual-subscription'], {
      providers: new Map([['manual-subscription', new ManualSubscriptionBridge()]]),
    });
    const first = await router.generate(routeRequest());
    const second = await router.generate(routeRequest({ imageTaskId: first.imageTaskId }));
    assert.equal(second.imageTaskId, first.imageTaskId);
    const imageTask = env.store.getImageTask(first.imageTaskId);
    assert.equal(imageTask.attempts, 2);
    assert.equal(imageTask.status, 'AWAITING_USER');
    assert.equal(env.store.listImageTasksByTask('task_route').length, 1);
  } finally {
    env.close();
  }
});

test('listCapabilities：按配置顺序返回能力与原因', async () => {
  const env = await openEnv();
  try {
    const router = makeRouter(env, ['manual-subscription', 'codex-subscription', 'local-generation'], {
      providers: new Map([
        ['manual-subscription', new ManualSubscriptionBridge()],
        ['codex-subscription', new CodexSubscriptionProvider()],
        ['local-generation', providerStub('local_generation', { available: false, reasons: ['ComfyUI 未启动'] })],
      ]),
    });
    const health = await router.listCapabilities();
    assert.equal(health.length, 3);
    assert.equal(health[0].name, 'manual-subscription');
    assert.equal(health[0].available, true);
    assert.equal(health[0].requiresUserAction, true);
    assert.equal(health[1].available, false);
    assert.equal(health[1].kind, 'codex_subscription');
    assert.equal(health[2].available, false);
    assert.deepEqual([...health[2].reasons], ['ComfyUI 未启动']);
  } finally {
    env.close();
  }
});

test('cancel：取消等待中的图片任务并更新为 CANCELLED', async () => {
  const env = await openEnv();
  try {
    const router = makeRouter(env, ['manual-subscription'], {
      providers: new Map([['manual-subscription', new ManualSubscriptionBridge()]]),
    });
    const result = await router.generate(routeRequest());
    assert.equal(result.status, 'awaiting_user');
    assert.equal(await router.cancel(result.imageTaskId), true);
    assert.equal(env.store.getImageTask(result.imageTaskId).status, 'CANCELLED');
    assert.equal(await router.cancel('imgtask_missing'), false);
  } finally {
    env.close();
  }
});
