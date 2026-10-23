import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { decodeImage } from '../../dist/image/pixel-decoder.js';
import { perceptualHashDhashPng, hammingDistance } from '../../dist/image/image-processor.js';
import { makePatternPng, makeGif, makePngHeaderOnly } from '../../fixtures/images/png.mjs';

test('完整像素解码支持 PNG/JPEG/WebP/GIF，并保持旧 PNG 哈希兼容', async () => {
  const png = makePatternPng(128, 128);
  const decoded = await decodeImage(png);
  assert.equal(decoded.perceptualHash, perceptualHashDhashPng(png));
  for (const format of ['jpeg', 'webp', 'gif']) {
    const bytes = await sharp(png).toFormat(format).toBuffer();
    const actual = await decodeImage(bytes);
    assert.equal(actual.width, 128);
    assert.equal(actual.height, 128);
    assert.match(actual.perceptualHash, /^[a-f0-9]{16}$/);
    assert.ok(hammingDistance(actual.perceptualHash, decoded.perceptualHash) <= 8);
    await assert.rejects(() => decodeImage(bytes.subarray(0, Math.floor(bytes.length / 2))));
  }
  for (const options of [{ palette: true }, { progressive: true }]) {
    const bytes = await sharp(png).png(options).toBuffer();
    assert.equal((await decodeImage(bytes)).width, 128);
  }
});

test('伪造头部、过大图片和多帧动画均不可绕过完整解码', async () => {
  await assert.rejects(() => decodeImage(makeGif({ width: 64, height: 64 })));
  await assert.rejects(() => decodeImage(makePngHeaderOnly({ width: 100000, height: 100000 })));
  // Use different frames so the encoder cannot collapse the animation.
  const pixels = Buffer.alloc(64 * 128 * 3, 0);
  pixels.fill(255, 64 * 64 * 3);
  const twoFrames = await sharp(pixels, { raw: { width: 64, height: 128, channels: 3, pageHeight: 64 } }).gif().toBuffer();
  assert.equal((await sharp(twoFrames).metadata()).pages, 2);
  await assert.rejects(() => decodeImage(twoFrames));
});
