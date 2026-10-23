/**
 * ImageReviewer 单元测试：结构化报告、风险标记、近重复、失败语义与持久化。
 * 不访问网络、不写工作区外；审核结论必须可解释，不得伪造视觉审核通过。
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { AssetStore } from '../../dist/image/asset-store.js';
import { ImageReviewer } from '../../dist/image/image-reviewer.js';
import { MomentsStore } from '../../dist/storage/store.js';
import {
  encodePng,
  makeGif,
  makePatternPng,
  makePngHeaderOnly,
  makeTruncatedPng,
  variantPatternPixels,
} from '../../fixtures/images/png.mjs';

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

async function openEnv(options = {}) {
  const dir = makeTempDir('review-');
  const dataDir = path.join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const store = await MomentsStore.open(path.join(dataDir, 'moments.db'));
  const assetStore = new AssetStore({ store, dataDir, maxFileBytes: 12 * 1024 * 1024 });
  const reviewer = new ImageReviewer({
    store,
    assetsRoot: assetStore.assetsRoot,
    maxFileBytes: 12 * 1024 * 1024,
    allowedAspectRatios: options.allowedAspectRatios ?? ['1:1', '4:3'],
    minWidth: options.minWidth ?? 64,
    minHeight: options.minHeight ?? 64,
  });
  return {
    dir,
    dataDir,
    store,
    assetStore,
    reviewer,
    close() {
      store.close();
    },
  };
}

function importInput(bytes, overrides = {}) {
  return {
    bytes,
    declaredMime: 'image/png',
    source: 'owner_upload',
    license: 'CC0-1.0',
    prompt: '测试用合成图片',
    provider: 'local-import',
    model: 'user-file',
    ...overrides,
  };
}

test('reviewAsset：正常图片通过并持久化结构化报告', async () => {
  const env = await openEnv();
  try {
    const bytes = readFileSync(path.join(fixtures, 'pattern-64.png'));
    const { asset } = await env.assetStore.importBytes(importInput(bytes));
    const result = await env.reviewer.reviewAsset(asset.assetId);
    assert.equal(result.persisted, true);
    assert.equal(result.passed, true, `正常素材应通过审核，flags=${result.flags.join(',')}`);
    assert.equal(result.hardFailure, null);
    assert.deepEqual([...result.flags], []);
    const report = result.report;
    assert.equal(report.exists, true);
    assert.equal(report.signatureMime, 'image/png');
    assert.equal(report.declaredMime, 'image/png');
    assert.equal(report.mimeMatched, true);
    assert.equal(report.width, 64);
    assert.equal(report.height, 64);
    assert.equal(report.aspectRatio, 1);
    assert.equal(report.bytes, bytes.length);
    assert.equal(report.sha256, asset.sha256);
    assert.match(report.perceptualHash, /^[0-9a-f]{16}$/);
    assert.equal(report.nearDuplicateOf, null);
    assert.equal(report.relevantToText, null, '没有视觉模型时相关度必须为 null，不得伪造');
    assert.ok(report.qualityScore > 0 && report.qualityScore <= 1);
    assert.ok(report.notes.some((note) => note.includes('未进行视觉语义理解')));
    const stored = env.store.getImageReview(asset.assetId);
    assert.ok(stored !== undefined, '审核结果必须写入 store.saveImageReview');
    assert.equal(stored.passed, true);
    assert.equal(stored.report.sha256, asset.sha256);
    assert.ok(stored.reviewedAt.length > 0);
  } finally {
    env.close();
  }
});

test('reviewAsset：分辨率过低与质量评分低会阻断', async () => {
  const env = await openEnv();
  try {
    const { asset } = await env.assetStore.importBytes(importInput(makePatternPng(32, 32)));
    const result = await env.reviewer.reviewAsset(asset.assetId);
    assert.equal(result.passed, false);
    assert.ok(result.flags.includes('IMAGE_LOW_QUALITY'));
    assert.ok(result.blockingFlags.includes('IMAGE_LOW_QUALITY'));
    assert.ok(result.report.notes.some((note) => note.includes('分辨率')));
  } finally {
    env.close();
  }
});

test('reviewAsset：与最近素材感知哈希近似重复（汉明距离 <= 8）', async () => {
  const env = await openEnv();
  try {
    const baseBytes = makePatternPng(64, 64);
    const base = await env.assetStore.importBytes(importInput(baseBytes));
    const baseReview = await env.reviewer.reviewAsset(base.asset.assetId);
    assert.equal(baseReview.passed, true);

    const variantBytes = encodePng({ width: 64, height: 64, pixels: variantPatternPixels });
    const variant = await env.assetStore.importBytes(importInput(variantBytes));
    assert.notEqual(variant.asset.sha256, base.asset.sha256);
    const result = await env.reviewer.reviewAsset(variant.asset.assetId);
    assert.equal(result.passed, false);
    assert.ok(result.flags.includes('DUPLICATE_RECENT'));
    assert.equal(result.report.nearDuplicateOf, base.asset.sha256);
    assert.ok(result.report.notes.some((note) => note.includes('近似重复')));
  } finally {
    env.close();
  }
});

test('reviewBytes：只有头部的 GIF 必须拒绝，不能以宽高可读代替解码', async () => {
  const env = await openEnv();
  try {
    const result = await env.reviewer.reviewBytes({
      bytes: makeGif({ width: 64, height: 64 }),
      declaredMime: 'image/gif',
      source: 'owner_upload',
      license: 'CC0-1.0',
    });
    assert.equal(result.report.perceptualHash, null);
    assert.equal(result.report.relevantToText, null);
    assert.ok(result.flags.includes('PERCEPTUAL_HASH_UNAVAILABLE'));
    assert.notEqual(result.hardFailure, null);
    assert.equal(result.passed, false);
    assert.equal(result.persisted, false, 'reviewBytes 不落盘');
    assert.ok(result.report.notes.some((note) => note.includes('解码失败')));
  } finally {
    env.close();
  }
});

test('reviewBytes：损坏图片、空字节与声明 MIME 不一致', async () => {
  const env = await openEnv();
  try {
    const truncated = await env.reviewer.reviewBytes({ bytes: makeTruncatedPng(), declaredMime: 'image/png' });
    assert.equal(truncated.passed, false);
    assert.notEqual(truncated.hardFailure, null);
    assert.equal(truncated.report.exists, true);

    const empty = await env.reviewer.reviewBytes({ bytes: new Uint8Array(0), declaredMime: 'image/png' });
    assert.equal(empty.passed, false);
    assert.equal(empty.report.exists, false);

    const mismatch = await env.reviewer.reviewBytes({ bytes: makePatternPng(64, 64), declaredMime: 'image/jpeg' });
    assert.equal(mismatch.report.mimeMatched, false);
    assert.equal(mismatch.report.signatureMime, 'image/png');
    assert.equal(mismatch.passed, false);
    assert.ok(mismatch.flags.includes('MISLEADING_IMAGE'));
  } finally {
    env.close();
  }
});

test('reviewBytes：仅有调色板 PNG 头、没有像素数据时拒绝', async () => {
  const env = await openEnv();
  try {
    const palette = await env.reviewer.reviewBytes({
      bytes: makePngHeaderOnly({ width: 64, height: 64, colorType: 3 }),
      declaredMime: 'image/png',
      source: 'owner_upload',
      license: 'CC0-1.0',
    });
    assert.equal(palette.passed, false);
    assert.ok(palette.flags.includes('PERCEPTUAL_HASH_UNAVAILABLE'));
    assert.match(palette.hardFailure ?? '', /解码失败/);
    assert.equal(palette.persisted, false);
  } finally {
    env.close();
  }
});

test('reviewAsset：素材文件缺失时 exists=false 且仍记录审核结果', async () => {
  const env = await openEnv();
  try {
    const bytes = readFileSync(path.join(fixtures, 'pattern-64.png'));
    const { asset } = await env.assetStore.importBytes(importInput(bytes));
    unlinkSync(asset.path);
    const result = await env.reviewer.reviewAsset(asset.assetId);
    assert.equal(result.passed, false);
    assert.equal(result.report.exists, false);
    assert.notEqual(result.hardFailure, null);
    assert.equal(result.persisted, true);
    assert.ok(env.store.getImageReview(asset.assetId) !== undefined);
  } finally {
    env.close();
  }
});

test('reviewAsset：审核与审批/任务 ID 不关联，不伪造 approval 数据', async () => {
  const env = await openEnv();
  try {
    const bytes = readFileSync(path.join(fixtures, 'pattern-64.png'));
    const { asset } = await env.assetStore.importBytes(importInput(bytes, { imageTaskId: 'imgtask_does_not_exist' }));
    assert.equal(env.store.getImageTask('imgtask_does_not_exist'), undefined);
    const result = await env.reviewer.reviewAsset(asset.assetId);
    assert.equal(result.passed, true);
    assert.equal(env.store.listPendingApprovals(10).length, 0, '审核不得创建或依赖审批');
    assert.deepEqual(
      Object.keys(result.report).sort(),
      [
        'aspectRatio',
        'bytes',
        'declaredMime',
        'exists',
        'height',
        'mimeMatched',
        'nearDuplicateOf',
        'notes',
        'perceptualHash',
        'qualityScore',
        'relevantToText',
        'sha256',
        'signatureMime',
        'width',
      ].sort(),
    );
    assert.equal(env.store.listApprovalsForTask('task_missing').length, 0);
  } finally {
    env.close();
  }
});

test('reviewBytes：调用方声明的风险提示可解释地映射为 RiskFlag', async () => {
  const env = await openEnv();
  try {
    const bytes = makePatternPng(64, 64);
    const aiReal = await env.reviewer.reviewBytes({
      bytes,
      declaredMime: 'image/png',
      source: 'local_generation',
      license: 'CC0-1.0',
      claimsRealEvent: true,
      isAiGenerated: true,
    });
    assert.ok(aiReal.flags.includes('REAL_PERSON_CLAIM'));
    assert.ok(aiReal.flags.includes('IMAGE_REAL_EVENT_MISMATCH'));
    assert.equal(aiReal.passed, false);

    const privacy = await env.reviewer.reviewBytes({
      bytes,
      declaredMime: 'image/png',
      source: 'owner_upload',
      license: 'CC0-1.0',
      containsPersonalInfo: true,
    });
    assert.ok(privacy.flags.includes('PRIVACY_PERSONAL_INFO'));
    assert.equal(privacy.passed, false);
    assert.ok(privacy.report.notes.some((note) => note.includes('隐私')));

    const mismatched = await env.reviewer.reviewBytes({
      bytes,
      declaredMime: 'image/png',
      source: 'owner_upload',
      license: 'CC0-1.0',
      relevantToText: false,
    });
    assert.ok(mismatched.flags.includes('MISLEADING_IMAGE'));
    assert.equal(mismatched.passed, false);
  } finally {
    env.close();
  }
});

test('reviewAsset：来源/许可缺失会给出 SOURCE_MISSING 提示（不静默通过）', async () => {
  const env = await openEnv();
  try {
    const { asset } = await env.assetStore.importBytes(
      importInput(makePatternPng(64, 64), { license: 'unknown', source: 'owner_upload' }),
    );
    const result = await env.reviewer.reviewAsset(asset.assetId);
    assert.ok(result.flags.includes('SOURCE_MISSING'));
    assert.ok(result.report.notes.some((note) => note.includes('许可')));
  } finally {
    env.close();
  }
});
