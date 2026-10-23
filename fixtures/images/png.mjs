/**
 * 测试用图像 fixture 生成器（纯 JS，无第三方依赖）。
 *
 * 说明：
 * - 只生成合成的几何图案 / 纯色图，不使用任何真人照片或第三方素材；
 * - PNG 按真实规范编码（IHDR / IDAT / IEND + CRC32），可被本项目的解析器与感知哈希读取；
 * - JPEG / GIF / WebP 只生成“头部可解析”的最小结构，用于验证尺寸解析与损坏拒绝路径，
 *   不代表完整可显示的图片，禁止把它们当作真实图片使用。
 */
import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

/**
 * 生成合法 PNG。
 * @param {object} options
 * @param {number} options.width
 * @param {number} options.height
 * @param {0|2|4|6} [options.colorType]
 * @param {8|16} [options.bitDepth]
 * @param {0|1|2|3|4} [options.filterType] 统一使用的扫描行过滤器类型
 * @param {0|1} [options.interlace]
 * @param {(x:number, y:number)=>number[]} [options.pixels] 返回该像素的通道值
 */
export function encodePng(options) {
  const { width, height, colorType = 6, bitDepth = 8, filterType = 0, interlace = 0 } = options;
  const channels = CHANNELS[colorType];
  if (channels === undefined) throw new Error(`helper 不支持的 colorType: ${colorType}`);
  const bytesPerPixel = channels * (bitDepth / 8);
  const pixels = options.pixels ?? defaultPatternPixels;

  const reconstructed = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(width * bytesPerPixel);
    for (let x = 0; x < width; x += 1) {
      const values = pixels(x, y);
      for (let channel = 0; channel < channels; channel += 1) {
        const value = Math.max(0, Math.min(255, Math.round(values[channel] ?? 0)));
        const offset = x * bytesPerPixel + channel * (bitDepth / 8);
        if (bitDepth === 8) row[offset] = value;
        else {
          row[offset] = 0;
          row[offset + 1] = value;
        }
      }
    }
    reconstructed.push(row);
  }

  const raw = Buffer.alloc(height * (1 + width * bytesPerPixel));
  for (let y = 0; y < height; y += 1) {
    const target = reconstructed[y];
    const previous = y > 0 ? reconstructed[y - 1] : undefined;
    const rowStart = y * (1 + width * bytesPerPixel);
    raw[rowStart] = filterType;
    for (let x = 0; x < width * bytesPerPixel; x += 1) {
      const value = target[x];
      const left = x >= bytesPerPixel ? target[x - bytesPerPixel] : 0;
      const up = previous === undefined ? 0 : previous[x];
      const upLeft = previous !== undefined && x >= bytesPerPixel ? previous[x - bytesPerPixel] : 0;
      let predictor = 0;
      if (filterType === 1) predictor = left;
      else if (filterType === 2) predictor = up;
      else if (filterType === 3) predictor = (left + up) >> 1;
      else if (filterType === 4) predictor = paeth(left, up, upLeft);
      raw[rowStart + 1 + x] = (value - predictor) & 0xff;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = interlace;
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 只包含 IHDR 的 PNG 头，用于测试不受支持的位深 / 调色板 / 隔行扫描。 */
export function makePngHeaderOnly(options) {
  const { width, height, colorType = 6, bitDepth = 8, interlace = 0 } = options;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = interlace;
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IEND', Buffer.alloc(0))]);
}

function paeth(left, up, upLeft) {
  const p = left + up - upLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - upLeft);
  if (pa <= pb && pa <= pc) return left;
  if (pb <= pc) return up;
  return upLeft;
}

/** 合成棋盘格（8x8 块）灰度图，用于感知哈希与近重复测试。 */
export function defaultPatternPixels(x, y) {
  const on = ((x >> 3) ^ (y >> 3)) & 1;
  const value = on === 1 ? 235 : 20;
  return [value, value, value, 255];
}

/** 与 defaultPatternPixels 只有 (8,0) 一个像素不同，用于“近似重复”测试。 */
export function variantPatternPixels(x, y) {
  if (x === 8 && y === 0) return [20, 20, 20, 255];
  return defaultPatternPixels(x, y);
}

export function makePatternPng(width = 64, height = 64, options = {}) {
  return encodePng({ width, height, colorType: 6, pixels: defaultPatternPixels, ...options });
}

export function makeVariantPatternPng(width = 64, height = 64) {
  return encodePng({ width, height, colorType: 6, pixels: variantPatternPixels });
}

export function makeSolidPng(width = 64, height = 64, value = 128) {
  return encodePng({ width, height, colorType: 6, pixels: () => [value, value, value, 255] });
}

/** 生成符合 JPEG 段结构（含 SOF0）的“头部图片”，只用于尺寸解析测试。 */
export function makeJpegWithSof(options) {
  const { width = 64, height = 48 } = options ?? {};
  const app0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  ]);
  const sofPayload = Buffer.from([
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03,
    0x01,
    0x11,
    0x00,
    0x02,
    0x11,
    0x01,
    0x03,
    0x11,
    0x01,
  ]);
  const sofHeader = Buffer.from([0xff, 0xc0, (sofPayload.length + 2) >> 8, (sofPayload.length + 2) & 0xff]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sofHeader, sofPayload, Buffer.from([0xff, 0xd9])]);
}

/** 只有 SOI/EOI、没有 SOF 的“损坏 JPEG”。 */
export function makeBrokenJpeg() {
  return Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
}

/** 生成合法 GIF 头（GIF89a + 逻辑屏 + 结束符），用于尺寸解析测试。 */
export function makeGif(options) {
  const { width = 32, height = 24 } = options ?? {};
  const header = Buffer.from('GIF89a', 'ascii');
  const screen = Buffer.alloc(7);
  screen.writeUInt16LE(width, 0);
  screen.writeUInt16LE(height, 2);
  screen[4] = 0x00;
  screen[5] = 0x00;
  screen[6] = 0x00;
  return Buffer.concat([header, screen, Buffer.from([0x3b])]);
}

/** 生成 VP8X 扩展格式 WebP 头，用于尺寸解析测试。 */
export function makeWebpVp8x(options) {
  const { width = 40, height = 30 } = options ?? {};
  const vp8xPayload = Buffer.alloc(10);
  vp8xPayload[0] = 0x00;
  const canvasWidth = width - 1;
  const canvasHeight = height - 1;
  vp8xPayload[4] = canvasWidth & 0xff;
  vp8xPayload[5] = (canvasWidth >> 8) & 0xff;
  vp8xPayload[6] = (canvasWidth >> 16) & 0xff;
  vp8xPayload[7] = canvasHeight & 0xff;
  vp8xPayload[8] = (canvasHeight >> 8) & 0xff;
  vp8xPayload[9] = (canvasHeight >> 16) & 0xff;
  const chunkHeader = Buffer.from('VP8X', 'ascii');
  const chunkSize = Buffer.alloc(4);
  chunkSize.writeUInt32LE(vp8xPayload.length, 0);
  const chunk = Buffer.concat([chunkHeader, chunkSize, vp8xPayload]);
  if (chunk.length % 2 === 1) chunk.push(0);
  const riffSize = Buffer.alloc(4);
  riffSize.writeUInt32LE(4 + chunk.length, 0);
  return Buffer.concat([Buffer.from('RIFF', 'ascii'), riffSize, Buffer.from('WEBP', 'ascii'), chunk]);
}

/** 截断 PNG（只有签名和部分 IHDR），应被判定为损坏。 */
export function makeTruncatedPng() {
  return makePatternPng(16, 16).subarray(0, 20);
}

/** 完全不是图像的数据。 */
export function makeNotAnImage() {
  return Buffer.from('这不是图片，只是一个用于测试的文本文件。\n', 'utf8');
}
