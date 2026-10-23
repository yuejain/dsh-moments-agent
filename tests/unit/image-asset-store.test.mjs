/**
 * AssetStore 单元测试：内容寻址、去重、签名校验、大小限制、路径边界、原子写入。
 * 使用真实 MomentsStore（node:sqlite）+ 工作区内临时目录，不访问网络、不写工作区外。
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { sha256Bytes } from '../../dist/domain/ids.js';
import { AssetStore } from '../../dist/image/asset-store.js';
import { MomentsStore } from '../../dist/storage/store.js';
import {
  makeNotAnImage,
  makePatternPng,
  makeTruncatedPng,
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
  const dir = makeTempDir('asset-store-');
  const dataDir = path.join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const store = await MomentsStore.open(path.join(dataDir, 'moments.db'));
  const assetStore = new AssetStore({
    store,
    dataDir,
    maxFileBytes: options.maxFileBytes ?? 12 * 1024 * 1024,
    ...(options.assetDirName !== undefined ? { assetDirName: options.assetDirName } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
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

function listFiles(root) {
  if (!existsSync(root)) return [];
  const out = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

test('importBytes：正常导入、内容寻址路径、元数据与字节一致', async () => {
  const env = await openEnv();
  try {
    const bytes = readFileSync(path.join(fixtures, 'pattern-64.png'));
    const { asset, duplicate } = await env.assetStore.importBytes(importInput(bytes));
    assert.equal(duplicate, false);
    assert.match(asset.assetId, /^asset_/);
    assert.equal(asset.sha256, sha256Bytes(bytes));
    assert.equal(asset.mime, 'image/png');
    assert.equal(asset.width, 64);
    assert.equal(asset.height, 64);
    assert.equal(asset.bytes, bytes.length);
    assert.equal(asset.source, 'owner_upload');
    assert.equal(asset.license, 'CC0-1.0');
    assert.equal(asset.provider, 'local-import');
    assert.equal(asset.model, 'user-file');
    assert.equal(asset.imageTaskId, null);
    assert.match(asset.perceptualHash, /^[0-9a-f]{16}$/);
    assert.ok(existsSync(asset.path), '素材文件应已落盘');
    assert.ok(lstatSync(asset.path).isFile());
    assert.match(
      asset.path.replaceAll('\\', '/'),
      new RegExp(`/assets/[0-9a-f]{2}/[0-9a-f]{2}/${asset.sha256}\\.png$`),
      '落盘路径必须为 assets/<前2>/<次2>/<sha256>.png',
    );
    assert.deepEqual(Buffer.from(env.assetStore.readAssetBytes(asset.assetId)), Buffer.from(bytes));
    assert.equal(env.store.getAssetBySha(asset.sha256)?.assetId, asset.assetId);
    assert.equal(env.store.listRecentAssets(10).length, 1);
    assert.equal(env.store.countAssets(), 1);
    const leftovers = listFiles(env.assetStore.assetsRoot).filter((file) => file.endsWith('.tmp'));
    assert.deepEqual(leftovers, [], '原子写入后不应残留 .tmp 文件');
  } finally {
    env.close();
  }
});

test('importBytes：相同内容去重，返回已有素材且不重复占盘', async () => {
  const env = await openEnv();
  try {
    const bytes = readFileSync(path.join(fixtures, 'pattern-64.png'));
    const first = await env.assetStore.importBytes(importInput(bytes));
    const second = await env.assetStore.importBytes(importInput(bytes, { license: 'other-license' }));
    assert.equal(second.duplicate, true);
    assert.equal(second.asset.assetId, first.asset.assetId);
    assert.equal(second.asset.license, 'CC0-1.0', '重复导入应复用首次记录的元数据');
    assert.equal(env.store.countAssets(), 1);
    assert.equal(listFiles(env.assetStore.assetsRoot).length, 1);
  } finally {
    env.close();
  }
});

test('importBytes：拒绝空文件、伪造格式、损坏 PNG、声明 MIME 不一致', async () => {
  const env = await openEnv();
  try {
    await assert.rejects(
      env.assetStore.importBytes(importInput(new Uint8Array(0))),
      (error) => error.code === 'IMAGE_INVALID',
    );
    await assert.rejects(
      env.assetStore.importBytes(importInput(makeNotAnImage())),
      (error) => error.code === 'IMAGE_INVALID',
    );
    await assert.rejects(
      env.assetStore.importBytes(importInput(makeTruncatedPng())),
      (error) => error.code === 'IMAGE_INVALID',
    );
    const png = makePatternPng(16, 16);
    await assert.rejects(
      env.assetStore.importBytes(importInput(png, { declaredMime: 'image/jpeg' })),
      (error) => error.code === 'IMAGE_INVALID' && /不一致/.test(error.message),
    );
    await assert.rejects(
      env.assetStore.importBytes(importInput(png, { declaredMime: 'text/plain' })),
      (error) => error.code === 'IMAGE_INVALID',
    );
    assert.equal(env.store.countAssets(), 0);
  } finally {
    env.close();
  }
});

test('importBytes：声明通用 MIME 时以文件签名为准；超出大小上限拒绝', async () => {
  const env = await openEnv({ maxFileBytes: 100 });
  try {
    const bytes = readFileSync(path.join(fixtures, 'pattern-64.png'));
    assert.ok(bytes.length > 100);
    await assert.rejects(
      env.assetStore.importBytes(importInput(bytes, { declaredMime: 'application/octet-stream' })),
      (error) => error.code === 'IMAGE_INVALID' && /大小上限/.test(error.message),
    );
  } finally {
    env.close();
  }

  const env2 = await openEnv();
  try {
    const png = makePatternPng(16, 16);
    const { asset } = await env2.assetStore.importBytes(importInput(png, { declaredMime: 'application/octet-stream' }));
    assert.equal(asset.mime, 'image/png');
  } finally {
    env2.close();
  }
});

test('importFromPath：允许 imports 与 assets 目录内的普通文件', async () => {
  const env = await openEnv();
  try {
    mkdirSync(path.join(env.dataDir, 'imports'), { recursive: true });
    const bytes = readFileSync(path.join(fixtures, 'pattern-64.png'));
    writeFileSync(path.join(env.dataDir, 'imports', 'photo.png'), bytes);
    const relative = await env.assetStore.importFromPath({
      path: 'photo.png',
      source: 'owner_upload',
      license: 'CC0-1.0',
      prompt: '用户导入',
      provider: 'local-import',
      model: 'user-file',
    });
    assert.equal(relative.asset.mime, 'image/png');
    assert.equal(relative.asset.originalFileName, undefined, 'originalFileName 只作为导入提示，不写入记录');

    mkdirSync(env.assetStore.assetsRoot, { recursive: true });
    const assetsCopy = path.join(env.assetStore.assetsRoot, 'existing.png');
    copyFileSync(path.join(fixtures, 'solid-256.png'), assetsCopy);
    const absolute = await env.assetStore.importFromPath({
      path: assetsCopy,
      source: 'owner_upload',
      license: 'CC0-1.0',
      prompt: '素材目录导入',
      provider: 'local-import',
      model: 'user-file',
    });
    assert.equal(absolute.asset.width, 256);
  } finally {
    env.close();
  }
});

test('importFromPath：拒绝 .. 越界、绝对路径越界、目录、缺失文件与非图像文件', async () => {
  const env = await openEnv();
  try {
    await assert.rejects(
      env.assetStore.importFromPath({
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
      env.assetStore.importFromPath({
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
      env.assetStore.importFromPath({
        path: 'bad\0name.png',
        source: 'owner_upload',
        license: 'CC0-1.0',
        prompt: '',
        provider: 'local-import',
        model: 'user-file',
      }),
      (error) => error.code === 'IMAGE_PATH_DENIED',
    );

    mkdirSync(path.join(env.dataDir, 'imports', 'a-directory'), { recursive: true });
    await assert.rejects(
      env.assetStore.importFromPath({
        path: 'a-directory',
        source: 'owner_upload',
        license: 'CC0-1.0',
        prompt: '',
        provider: 'local-import',
        model: 'user-file',
      }),
      (error) => error.code === 'IMAGE_PATH_DENIED',
    );

    await assert.rejects(
      env.assetStore.importFromPath({
        path: 'missing.png',
        source: 'owner_upload',
        license: 'CC0-1.0',
        prompt: '',
        provider: 'local-import',
        model: 'user-file',
      }),
      (error) => error.code === 'NOT_FOUND',
    );

    writeFileSync(path.join(env.dataDir, 'imports', 'fake.png'), makeNotAnImage());
    await assert.rejects(
      env.assetStore.importFromPath({
        path: 'fake.png',
        source: 'owner_upload',
        license: 'CC0-1.0',
        prompt: '',
        provider: 'local-import',
        model: 'user-file',
      }),
      (error) => error.code === 'IMAGE_INVALID',
    );
  } finally {
    env.close();
  }
});

test('importFromPath：拒绝指向工作区外的符号链接（无权限创建时跳过）', async (t) => {
  const env = await openEnv();
  try {
    const outsideDir = makeTempDir('outside-');
    const outsideFile = path.join(outsideDir, 'outside.png');
    writeFileSync(outsideFile, readFileSync(path.join(fixtures, 'pattern-64.png')));
    mkdirSync(path.join(env.dataDir, 'imports'), { recursive: true });
    const linkPath = path.join(env.dataDir, 'imports', 'link.png');
    try {
      symlinkSync(outsideFile, linkPath, 'file');
    } catch {
      t.skip('当前 Windows 环境不允许创建符号链接（需要开发者模式/管理员），跳过符号链接用例');
      return;
    }
    await assert.rejects(
      env.assetStore.importFromPath({
        path: 'link.png',
        source: 'owner_upload',
        license: 'CC0-1.0',
        prompt: '',
        provider: 'local-import',
        model: 'user-file',
      }),
      (error) => error.code === 'IMAGE_PATH_DENIED',
    );
  } finally {
    env.close();
  }
});

test('readAssetBytes：数据库中被篡改的越界路径拒绝读取', async () => {
  const env = await openEnv();
  try {
    const sha = 'a'.repeat(64);
    env.store.insertAsset({
      assetId: 'asset_tampered',
      sha256: sha,
      path: path.join(projectRoot, 'package.json'),
      mime: 'image/png',
      width: 1,
      height: 1,
      bytes: 10,
      source: 'owner_upload',
      license: 'CC0-1.0',
      prompt: '',
      provider: '',
      model: '',
      imageTaskId: null,
      perceptualHash: null,
      createdAt: new Date().toISOString(),
    });
    assert.throws(() => env.assetStore.readAssetBytes('asset_tampered'), (error) => error.code === 'IMAGE_PATH_DENIED');
  } finally {
    env.close();
  }
});

test('importBytes：素材文件被删除后再次导入会按内容寻址路径重建', async () => {
  const env = await openEnv();
  try {
    const bytes = readFileSync(path.join(fixtures, 'pattern-64.png'));
    const first = await env.assetStore.importBytes(importInput(bytes));
    unlinkSync(first.asset.path);
    assert.equal(existsSync(first.asset.path), false);
    const second = await env.assetStore.importBytes(importInput(bytes));
    assert.equal(second.duplicate, true);
    assert.equal(second.asset.assetId, first.asset.assetId);
    assert.equal(existsSync(first.asset.path), true, '缺失的素材文件应被重建');
    assert.deepEqual(Buffer.from(readFileSync(first.asset.path)), Buffer.from(bytes));
  } finally {
    env.close();
  }
});

test('自定义 assetDirName 与 createdAt 时钟注入', async () => {
  const fixed = new Date('2026-01-02T03:04:05.000Z');
  const env = await openEnv({ assetDirName: 'media', now: () => fixed });
  try {
    assert.match(env.assetStore.assetsRoot.replaceAll('\\', '/'), /\/data\/media$/);
    const { asset } = await env.assetStore.importBytes(importInput(makePatternPng(16, 16)));
    assert.equal(asset.createdAt, fixed.toISOString());
    assert.ok(asset.path.startsWith(env.assetStore.assetsRoot));
  } finally {
    env.close();
  }
});
