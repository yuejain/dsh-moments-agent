/**
 * 生成 fixtures/images 下的合成测试图片。
 * 用法：node fixtures/images/generate-fixtures.mjs
 *
 * 这些图片全部由 png.mjs 用几何图案 / 最小头部结构合成，
 * 不含真人照片或第三方素材；JPEG/GIF/WebP 只保证头部可解析。
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  makeBrokenJpeg,
  makeGif,
  makeJpegWithSof,
  makeNotAnImage,
  makePatternPng,
  makeSolidPng,
  makeTruncatedPng,
  makeVariantPatternPng,
  makeWebpVp8x,
} from './png.mjs';

const here = import.meta.dirname;

const files = {
  'pattern-64.png': makePatternPng(64, 64),
  'pattern-64-variant.png': makeVariantPatternPng(64, 64),
  'solid-256.png': makeSolidPng(256, 256, 96),
  'tiny-9x8.png': makePatternPng(9, 8),
  'jpeg-header-64x48.jpg': makeJpegWithSof({ width: 64, height: 48 }),
  'broken.jpeg': makeBrokenJpeg(),
  'gif-header-32x24.gif': makeGif({ width: 32, height: 24 }),
  'webp-vp8x-header-40x30.webp': makeWebpVp8x({ width: 40, height: 30 }),
  'truncated.png': makeTruncatedPng(),
  'not-an-image.txt': makeNotAnImage(),
};

for (const [name, bytes] of Object.entries(files)) {
  writeFileSync(path.join(here, name), bytes);
  console.log(`wrote ${name} (${bytes.length} bytes)`);
}
