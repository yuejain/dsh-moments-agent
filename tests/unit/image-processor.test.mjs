/**
 * image-processor 单元测试：格式签名、尺寸解析、PNG dHash、汉明距离、尺寸建议。
 * 全部使用 memory 中的合成图片与 fixtures/images 的自制小图，不访问网络、不写工作区外。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  aspectRatioValue,
  detectImageSignature,
  formatAspectRatio,
  hammingDistance,
  isAllowedAspectRatio,
  normalizeMime,
  parseImageDimensions,
  perceptualHashDhashPng,
  standardizeDimensions,
} from '../../dist/image/image-processor.js';
import {
  encodePng,
  makeBrokenJpeg,
  makeGif,
  makeJpegWithSof,
  makeNotAnImage,
  makePatternPng,
  makePngHeaderOnly,
  makeWebpVp8x,
} from '../../fixtures/images/png.mjs';

const fixtures = path.resolve(import.meta.dirname, '../../fixtures/images');

test('detectImageSignature：按文件签名识别 PNG/JPEG/GIF/WebP，拒绝伪造格式', () => {
  assert.equal(detectImageSignature(makePatternPng(16, 16))?.mime, 'image/png');
  assert.equal(detectImageSignature(makeJpegWithSof({ width: 16, height: 16 }))?.mime, 'image/jpeg');
  assert.equal(detectImageSignature(makeGif({ width: 16, height: 16 }))?.mime, 'image/gif');
  assert.equal(detectImageSignature(makeWebpVp8x({ width: 16, height: 16 }))?.mime, 'image/webp');
  assert.equal(detectImageSignature(makeNotAnImage()), null);
  assert.equal(detectImageSignature(new Uint8Array(0)), null);
  // 截断 PNG 仍带合法签名（签名识别是头部判断），但尺寸解析必须拒绝：
  assert.equal(detectImageSignature(readFileSync(path.join(fixtures, 'truncated.png')))?.mime, 'image/png');
  assert.equal(parseImageDimensions(readFileSync(path.join(fixtures, 'truncated.png'))), null);
});

test('parseImageDimensions：解析四种格式的宽高', () => {
  assert.deepEqual(
    (({ width, height, mime }) => ({ width, height, mime }))(parseImageDimensions(makePatternPng(37, 21))),
    { width: 37, height: 21, mime: 'image/png' },
  );
  assert.deepEqual(
    (({ width, height, mime }) => ({ width, height, mime }))(parseImageDimensions(makeJpegWithSof({ width: 64, height: 48 }))),
    { width: 64, height: 48, mime: 'image/jpeg' },
  );
  assert.deepEqual(
    (({ width, height, mime }) => ({ width, height, mime }))(parseImageDimensions(makeGif({ width: 32, height: 24 }))),
    { width: 32, height: 24, mime: 'image/gif' },
  );
  assert.deepEqual(
    (({ width, height, mime }) => ({ width, height, mime }))(parseImageDimensions(makeWebpVp8x({ width: 40, height: 30 }))),
    { width: 40, height: 30, mime: 'image/webp' },
  );
  assert.equal(parseImageDimensions(makeBrokenJpeg()), null, '无 SOF 的 JPEG 不能报出尺寸');
  assert.equal(parseImageDimensions(makeNotAnImage()), null);
  assert.equal(parseImageDimensions(new Uint8Array(0)), null);
});

test('normalizeMime：兼容常见别名', () => {
  assert.equal(normalizeMime('image/jpg'), 'image/jpeg');
  assert.equal(normalizeMime('IMAGE/PNG'), 'image/png');
  assert.equal(normalizeMime('image/x-png'), 'image/png');
  assert.equal(normalizeMime('image/webp'), 'image/webp');
});

test('PNG dHash：确定性、16 位十六进制、过滤器 0-4 解码结果一致', () => {
  const base = perceptualHashDhashPng(makePatternPng(64, 64));
  assert.match(base, /^[0-9a-f]{16}$/);
  assert.equal(perceptualHashDhashPng(makePatternPng(64, 64)), base, '同一内容哈希必须稳定');
  for (const filterType of [0, 1, 2, 3, 4]) {
    const filtered = encodePng({ width: 64, height: 64, colorType: 6, filterType });
    assert.equal(perceptualHashDhashPng(filtered), base, `过滤器类型 ${filterType} 解码后哈希应一致`);
  }
});

test('PNG dHash：支持 color type 0/2/4/6，拒绝不支持的编码', () => {
  for (const colorType of [0, 2, 4, 6]) {
    const png = encodePng({ width: 32, height: 32, colorType });
    assert.match(perceptualHashDhashPng(png) ?? '', /^[0-9a-f]{16}$/, `colorType=${colorType}`);
  }
  assert.equal(perceptualHashDhashPng(makePngHeaderOnly({ width: 32, height: 32, colorType: 3 })), null, '调色板 PNG 不支持');
  assert.equal(perceptualHashDhashPng(makePngHeaderOnly({ width: 32, height: 32, bitDepth: 16 })), null, '16 位 PNG 不支持');
  assert.equal(perceptualHashDhashPng(makePngHeaderOnly({ width: 32, height: 32, interlace: 1 })), null, '隔行 PNG 不支持');
  assert.equal(perceptualHashDhashPng(makeJpegWithSof({ width: 16, height: 16 })), null, '非 PNG 返回 null');
  assert.equal(perceptualHashDhashPng(new Uint8Array(0)), null);
});

test('PNG dHash：损坏 IDAT 返回 null 而不是伪造哈希', () => {
  const png = Buffer.from(makePatternPng(32, 32));
  const idat = png.indexOf('IDAT', 0, 'ascii');
  assert.ok(idat > 0);
  for (let i = idat + 4; i < idat + 12; i += 1) png[i] = 0xff;
  assert.equal(perceptualHashDhashPng(png), null);
});

test('hammingDistance：同图为 0，反相为 64，非法输入抛 INVALID_INPUT', () => {
  const hash = perceptualHashDhashPng(makePatternPng(64, 64));
  assert.equal(hammingDistance(hash, hash), 0);
  const inverted = hash
    .split('')
    .map((char) => (15 - parseInt(char, 16)).toString(16))
    .join('');
  assert.equal(hammingDistance(hash, inverted), 64);
  assert.equal(hammingDistance('00', '01'), 1);
  assert.throws(() => hammingDistance('zz', '00'), (error) => error.code === 'INVALID_INPUT');
  assert.throws(() => hammingDistance('00', '0000'), (error) => error.code === 'INVALID_INPUT');
});

test('近重复检测所需性质：单像素变化汉明距离很小，图案反相距离大', () => {
  const base = perceptualHashDhashPng(makePatternPng(64, 64));
  const variant = perceptualHashDhashPng(makePatternPng(64, 64, { pixels: (x, y) => (x === 0 && y === 0 ? [20, 20, 20, 255] : [((x >> 3) ^ (y >> 3)) & 1 ? 235 : 20, 235, 20, 255]) }));
  assert.ok(variant !== null);
  assert.ok(hammingDistance(base, variant) <= 8, `单像素变化应视为近似重复，实际距离 ${hammingDistance(base, variant)}`);
  const invertedPng = encodePng({
    width: 64,
    height: 64,
    pixels: (x, y) => {
      const on = ((x >> 3) ^ (y >> 3)) & 1;
      const value = on === 1 ? 20 : 235;
      return [value, value, value, 255];
    },
  });
  const inverted = perceptualHashDhashPng(invertedPng);
  assert.ok(inverted !== null);
  assert.ok(hammingDistance(base, inverted) > 8, '反相图案不应被判为近似重复');
});

test('standardizeDimensions：只给建议，8 像素对齐，不修改原图', () => {
  const suggestion = standardizeDimensions(1000, 999);
  assert.equal(suggestion.changed, true);
  assert.equal(suggestion.width % 8, 0);
  assert.equal(suggestion.height % 8, 0);
  assert.equal(suggestion.aspectRatio, formatAspectRatio(suggestion.width, suggestion.height));
  const square = standardizeDimensions(1024, 1024);
  assert.equal(square.changed, false);
  const wide = standardizeDimensions(1000, 500, { preferredAspectRatio: '16:9' });
  // 8 像素对齐会带来轻微比例误差，建议尺寸只保证接近目标比例（1% 内）。
  assert.ok(Math.abs(aspectRatioValue(wide.width, wide.height) - 16 / 9) / (16 / 9) < 0.01, `实际比例 ${wide.aspectRatio}`);
  assert.ok(Math.max(wide.width, wide.height) <= 2048);
  assert.throws(() => standardizeDimensions(0, 100), (error) => error.code === 'INVALID_INPUT');
});

test('宽高比工具函数', () => {
  assert.equal(formatAspectRatio(1920, 1080), '16:9');
  assert.equal(formatAspectRatio(64, 64), '1:1');
  assert.equal(aspectRatioValue(0, 0), 0);
  assert.equal(isAllowedAspectRatio(1600, 900, ['16:9', '1:1']), true);
  assert.equal(isAllowedAspectRatio(1600, 900, ['1:1', '4:3']), false);
  assert.equal(isAllowedAspectRatio(1600, 900, []), true);
});
