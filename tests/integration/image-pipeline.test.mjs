/**
 * 图像子系统集成测试：ImageFacade + ImageRouter + AssetStore + ImageReviewer 全链路。
 * 使用真实 MomentsStore 与工作区内临时目录；manual/local-import 通道不访问网络。
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createImageFacade, createImageSubsystem } from '../../dist/image/index.js';
import { MomentsStore } from '../../dist/storage/store.js';
import { encodePng, makePatternPng, makeTruncatedPng, variantPatternPixels } from '../../fixtures/images/png.mjs';

const projectRoot = path.resolve(import.meta.dirname, '../..');
const fixtures = path.join(projectRoot, 'fixtures', 'images');
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

const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function makeImagesConfig(providers, overrides = {}) {
  return {
    providers,
    officialApiEnabled: false,
    allowNetworkSearch: false,
    maxFileBytes: 12 * 1024 * 1024,
    allowedAspectRatios: ['1:1', '4:3', '16:9'],
    assetDir: 'assets',
    ...overrides,
  };
}

async function openEnv() {
  const dir = makeTempDir('pipeline-');
  const dataDir = path.join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const store = await MomentsStore.open(path.join(dataDir, 'moments.db'));
  const now = new Date().toISOString();
  store.createTask('task_pipeline');
  store.createDraft(
    {
      draftId: 'draft_pipeline',
      taskId: 'task_pipeline',
      ideaId: 'idea_pipeline',
      version: 1,
      text: '周末在巷口看到一只晒太阳的橘猫，想起小时候院子里的那只。',
      tone: 'warm',
      createdAt: now,
      updatedAt: now,
    },
    'content-hash',
  );
  return {
    dir,
    dataDir,
    store,
    close() {
      store.close();
    },
  };
}

function imageGenerationRequest(overrides = {}) {
  return {
    taskId: 'task_pipeline',
    prompt: '巷口一只晒太阳的橘猫，自然光，真实摄影风格',
    negativePrompt: '文字，水印，畸形',
    aspectRatio: '1:1',
    resolution: '1024x1024',
    referenceImages: [],
    styleProfile: '自然光',
    privacyLevel: 'private',
    targetProvider: 'manual_subscription',
    maxAttempts: 1,
    ...overrides,
  };
}

test('全链路：等待用户手动生成 -> 导入授权图片 -> 审核通过 -> 近重复拦截', async () => {
  const env = await openEnv();
  try {
    const config = makeImagesConfig(['manual-subscription', 'local-import']);
    const subsystem = createImageSubsystem({
      store: env.store,
      dataDir: env.dataDir,
      images: config,
      env: {},
      logger: silentLogger,
    });
    const facade = createImageFacade({
      config,
      store: env.store,
      dataDir: env.dataDir,
      packageRoot: projectRoot,
      logger: silentLogger,
    });

    // 1) 能力探测：默认通道可用，但都需要用户操作
    const capabilities = await facade.listCapabilities();
    assert.deepEqual(
      capabilities.map((item) => item.provider),
      ['manual_subscription', 'local_import'],
    );
    assert.ok(capabilities.every((item) => item.available === true));
    assert.ok(capabilities.every((item) => item.requiresUserAction === true));

    // 2) 生成请求：不自动生图，返回 awaiting_user 并落一个 AWAITING_USER 任务
    const generated = await facade.generate(imageGenerationRequest());
    assert.equal(generated.result.status, 'awaiting_user');
    assert.equal(generated.result.requiresUserAction, true);
    assert.equal(generated.result.errorCode, null);
    assert.deepEqual([...generated.assets], []);
    const imageTaskId = generated.result.usageMetadata.imageTaskId;
    assert.match(imageTaskId, /^imgtask_/);
    const imageTask = env.store.getImageTask(imageTaskId);
    assert.equal(imageTask.status, 'AWAITING_USER');
    assert.equal(imageTask.taskId, 'task_pipeline');
    assert.equal(imageTask.draftId, 'draft_pipeline');

    // 3) 用户把官方客户端生成的图片保存到 dataDir/imports，并通过门面导入
    mkdirSync(path.join(env.dataDir, 'imports'), { recursive: true });
    writeFileSync(path.join(env.dataDir, 'imports', 'chatgpt-output.png'), readFileSync(path.join(fixtures, 'pattern-64.png')));
    const imported = await facade.importFromPath({
      path: 'imports/chatgpt-output.png',
      source: 'manual_subscription',
      license: 'user-authorized',
      prompt: imageGenerationRequest().prompt,
      provider: 'manual-subscription',
      model: 'user-client',
      imageTaskId,
    });
    assert.equal(imported.duplicate, false);
    assert.equal(imported.asset.source, 'manual_subscription');
    assert.match(path.basename(imported.asset.path), /^[0-9a-f]{64}\.png$/);
    assert.ok(imported.asset.path.startsWith(subsystem.assetsRoot));
    env.store.updateImageTask(imageTaskId, { status: 'READY', requiresUserAction: false });

    // 4) 审核：结构化报告，passed=true，且结果已持久化
    const review = await facade.reviewAsset(imported.asset.assetId, { text: imageTask.prompt });
    assert.equal(review.passed, true, `审核标记：${review.flags.join(',')}`);
    assert.deepEqual([...review.flags], []);
    assert.ok(Array.isArray(review.notes) && review.notes.length > 0);
    assert.equal(review.report.perceptualHash.length, 16);
    assert.ok(env.store.getImageReview(imported.asset.assetId) !== undefined);

    // 5) 近似重复：内容不同但感知哈希相同 -> 审核阻断
    const variantBytes = encodePng({ width: 64, height: 64, pixels: variantPatternPixels });
    const variant = await facade.importBytes({
      bytes: variantBytes,
      declaredMime: 'image/png',
      source: 'manual_subscription',
      license: 'user-authorized',
      prompt: imageGenerationRequest().prompt,
      provider: 'manual-subscription',
      model: 'user-client',
      imageTaskId,
    });
    assert.notEqual(variant.asset.sha256, imported.asset.sha256);
    const duplicateReview = await facade.reviewAsset(variant.asset.assetId);
    assert.equal(duplicateReview.passed, false);
    assert.ok(duplicateReview.flags.includes('DUPLICATE_RECENT'));
    assert.equal(duplicateReview.report.nearDuplicateOf, imported.asset.sha256);
    assert.equal(env.store.countAssets(), 2);
    assert.equal(env.store.listRecentAssets(10).length, 2);

    // 6) 审核报告不伪造视觉结论
    assert.equal(review.report.relevantToText, null);
  } finally {
    env.close();
  }
});

test('安全边界：路径越界、绝对路径、损坏文件与默认拒绝的官方通道', async () => {
  const env = await openEnv();
  try {
    const config = makeImagesConfig(['manual-subscription', 'official-api']);
    const facade = createImageFacade({
      config,
      store: env.store,
      dataDir: env.dataDir,
      packageRoot: projectRoot,
      logger: silentLogger,
    });

    await assert.rejects(
      facade.importFromPath({
        path: '../package.json',
        source: 'owner_upload',
        license: 'CC0-1.0',
        prompt: '',
        provider: 'local-import',
        model: 'user-file',
      }),
      (error) => error.code === 'IMAGE_PATH_DENIED',
    );
    await assert.rejects(
      facade.importFromPath({
        path: path.join(projectRoot, 'package.json'),
        source: 'owner_upload',
        license: 'CC0-1.0',
        prompt: '',
        provider: 'local-import',
        model: 'user-file',
      }),
      (error) => error.code === 'IMAGE_PATH_DENIED',
    );
    await assert.rejects(
      facade.importFromPath({
        path: 'assets/../imports/x.png',
        source: 'owner_upload',
        license: 'CC0-1.0',
        prompt: '',
        provider: 'local-import',
        model: 'user-file',
      }),
      (error) => error.code === 'IMAGE_PATH_DENIED',
    );
    await assert.rejects(
      facade.importBytes({
        bytes: makeTruncatedPng(),
        declaredMime: 'image/png',
        source: 'owner_upload',
        license: 'CC0-1.0',
        prompt: '',
        provider: 'local-import',
        model: 'user-file',
      }),
      (error) => error.code === 'IMAGE_INVALID',
    );

    // official-api 默认关闭：即使配置里包含也不可用，不产生网络调用
    const capabilities = await facade.listCapabilities();
    const official = capabilities.find((item) => item.provider === 'official_api');
    assert.ok(official !== undefined);
    assert.equal(official.available, false);
    assert.match(official.reasons.join(''), /默认关闭/);
  } finally {
    env.close();
  }
});

test('全部通道不可用：明确 errorCode，不伪造生成结果', async () => {
  const env = await openEnv();
  try {
    const config = makeImagesConfig(['codex-subscription']);
    const facade = createImageFacade({
      config,
      store: env.store,
      dataDir: env.dataDir,
      packageRoot: projectRoot,
      logger: silentLogger,
    });
    const generated = await facade.generate(imageGenerationRequest({ targetProvider: 'codex_subscription' }));
    assert.equal(generated.result.status, 'unavailable');
    assert.equal(generated.result.errorCode, 'IMAGE_PROVIDER_UNAVAILABLE');
    assert.deepEqual([...generated.result.images], []);
    assert.deepEqual([...generated.assets], []);
    assert.equal(generated.result.requiresUserAction, false);
    const attempts = generated.result.usageMetadata.attempts;
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].errorCode, 'IMAGE_PROVIDER_UNAVAILABLE');
    assert.match(attempts[0].message, /UNSUPPORTED_AUTHORIZATION|未验证.*授权/);
  } finally {
    env.close();
  }
});
