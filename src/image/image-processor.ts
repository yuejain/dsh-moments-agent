/**
 * 图像解析与感知哈希（纯函数，无文件系统 / 网络副作用）。
 *
 * 设计边界：
 * - 只做“读头部 + 解码 PNG 像素”这一层，不生成、不修改、不保存图片；
 * - 只接受受支持的四种格式（PNG / JPEG / WebP / GIF），格式判断以文件签名为准，
 *   绝不信任扩展名或声明 MIME；
 * - PNG 感知哈希使用 dHash（9x8 灰度差分），失败时返回 null 由审核层显式标记
 *   PERCEPTUAL_HASH_UNAVAILABLE，而不是伪造一个“通过”的哈希；
 * - 本模块不依赖第三方库，PNG 解码使用 node:zlib。
 */
import { inflateSync } from 'node:zlib';
import { MomentsError } from '../domain/result.js';

export type ImageFormat = 'png' | 'jpeg' | 'webp' | 'gif';

export interface ImageSignature {
  readonly format: ImageFormat;
  readonly mime: string;
}

export interface ImageDimensions {
  readonly format: ImageFormat;
  readonly mime: string;
  readonly width: number;
  readonly height: number;
}

export const IMAGE_MIME_BY_FORMAT: Readonly<Record<ImageFormat, string>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

export const SUPPORTED_IMAGE_MIME_TYPES: readonly string[] = Object.values(IMAGE_MIME_BY_FORMAT);

/** 单边像素上限：超过即认为尺寸异常，避免解码炸弹。 */
const MAX_DIMENSION = 100_000;

/** PNG 解码后的最大像素字节数（约 64 MiB），防止压缩炸弹。 */
const MAX_DECODED_BYTES = 64 * 1024 * 1024;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const JPEG_SOI = [0xff, 0xd8, 0xff] as const;

function u8(bytes: Uint8Array, index: number): number {
  return bytes[index] ?? 0;
}

function be16(bytes: Uint8Array, offset: number): number {
  return (u8(bytes, offset) << 8) | u8(bytes, offset + 1);
}

function be32(bytes: Uint8Array, offset: number): number {
  return ((u8(bytes, offset) << 24) | (u8(bytes, offset + 1) << 16) | (u8(bytes, offset + 2) << 8) | u8(bytes, offset + 3)) >>> 0;
}

function le16(bytes: Uint8Array, offset: number): number {
  return u8(bytes, offset) | (u8(bytes, offset + 1) << 8);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(u8(bytes, offset + i));
  return out;
}

function matches(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  if (bytes.length < offset + expected.length) return false;
  for (let i = 0; i < expected.length; i += 1) {
    if (u8(bytes, offset + i) !== expected[i]) return false;
  }
  return true;
}

function createSignature(format: ImageFormat): ImageSignature {
  return { format, mime: IMAGE_MIME_BY_FORMAT[format] };
}

/** 归一化 MIME：兼容 image/jpg、image/pjpeg、image/x-png 等常见别名。 */
export function normalizeMime(mime: string): string {
  const lower = mime.trim().toLowerCase();
  if (lower === 'image/jpg' || lower === 'image/pjpeg') return 'image/jpeg';
  if (lower === 'image/x-png') return 'image/png';
  return lower;
}

/** 允许“通用二进制声明”，此时以文件签名为准；其余声明必须与签名一致。 */
export function isGenericDeclaredMime(mime: string): boolean {
  const normalized = normalizeMime(mime);
  return normalized === '' || normalized === 'application/octet-stream' || normalized === 'binary/octet-stream';
}

/** 根据文件扩展名推断 MIME（仅用于导入时给可选声明，不参与安全判断）。 */
export function mimeFromFileName(fileName: string): string | null {
  const offset = fileName.lastIndexOf('.');
  if (offset < 0) return null;
  const extension = fileName.slice(offset + 1).toLowerCase();
  if (extension === 'png') return 'image/png';
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'webp') return 'image/webp';
  if (extension === 'gif') return 'image/gif';
  return null;
}

/**
 * 通过文件签名识别图像格式。
 * 返回 null 表示不是受支持的真实图像（包括空字节、损坏头、伪造扩展名）。
 */
export function detectImageSignature(bytes: Uint8Array): ImageSignature | null {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return null;
  if (matches(bytes, 0, PNG_SIGNATURE)) return createSignature('png');
  if (matches(bytes, 0, JPEG_SOI)) return createSignature('jpeg');
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    return createSignature('webp');
  }
  if (bytes.length >= 6) {
    const gif = ascii(bytes, 0, 6);
    if (gif === 'GIF87a' || gif === 'GIF89a') return createSignature('gif');
  }
  return null;
}

function validDimensions(width: number, height: number): boolean {
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width <= MAX_DIMENSION && height <= MAX_DIMENSION;
}

function parsePngDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 33 || ascii(bytes, 12, 4) !== 'IHDR' || be32(bytes, 8) !== 13) return null;
  const width = be32(bytes, 16);
  const height = be32(bytes, 20);
  if (!validDimensions(width, height)) return null;
  return { format: 'png', mime: IMAGE_MIME_BY_FORMAT.png, width, height };
}

function isJpegSofMarker(marker: number): boolean {
  return (
    marker === 0xc0 ||
    marker === 0xc1 ||
    marker === 0xc2 ||
    marker === 0xc3 ||
    marker === 0xc5 ||
    marker === 0xc6 ||
    marker === 0xc7 ||
    marker === 0xc9 ||
    marker === 0xca ||
    marker === 0xcb ||
    marker === 0xcd ||
    marker === 0xce ||
    marker === 0xcf
  );
}

/** 解析 JPEG 尺寸：只扫描段头直到 SOFn，不做完整熵解码。 */
function parseJpegDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (!matches(bytes, 0, JPEG_SOI)) return null;
  let offset = 2;
  let guard = 0;
  while (offset + 1 < bytes.length) {
    guard += 1;
    if (guard > 4096) return null;
    if (u8(bytes, offset) !== 0xff) {
      offset += 1;
      continue;
    }
    let marker = u8(bytes, offset + 1);
    let head = offset;
    while (marker === 0xff) {
      head += 1;
      marker = u8(bytes, head + 1);
      if (head + 1 >= bytes.length) return null;
    }
    offset = head + 2;
    if (marker === 0xd8 || marker === 0x01) continue;
    if (marker === 0xd9 || marker === 0xda) return null;
    if (offset + 2 > bytes.length) return null;
    const length = be16(bytes, offset);
    if (length < 2) return null;
    if (isJpegSofMarker(marker)) {
      if (offset + 7 > bytes.length) return null;
      const height = be16(bytes, offset + 3);
      const width = be16(bytes, offset + 5);
      if (!validDimensions(width, height)) return null;
      return { format: 'jpeg', mime: IMAGE_MIME_BY_FORMAT.jpeg, width, height };
    }
    offset += length;
  }
  return null;
}

/** 解析 WebP 尺寸：支持 VP8（有损）、VP8L（无损）、VP8X（扩展画布）。 */
function parseWebpDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 30 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') return null;
  const chunk = ascii(bytes, 12, 4);
  let width: number;
  let height: number;
  if (chunk === 'VP8 ') {
    if (u8(bytes, 23) !== 0x9d || u8(bytes, 24) !== 0x01 || u8(bytes, 25) !== 0x2a) return null;
    width = le16(bytes, 26) & 0x3fff;
    height = le16(bytes, 28) & 0x3fff;
  } else if (chunk === 'VP8L') {
    if (u8(bytes, 20) !== 0x2f) return null;
    const bits = (u8(bytes, 21) | (u8(bytes, 22) << 8) | (u8(bytes, 23) << 16) | (u8(bytes, 24) << 24)) >>> 0;
    width = (bits & 0x3fff) + 1;
    height = ((bits >>> 14) & 0x3fff) + 1;
  } else if (chunk === 'VP8X') {
    width = 1 + (u8(bytes, 24) | (u8(bytes, 25) << 8) | (u8(bytes, 26) << 16));
    height = 1 + (u8(bytes, 27) | (u8(bytes, 28) << 8) | (u8(bytes, 29) << 16));
  } else {
    return null;
  }
  if (!validDimensions(width, height)) return null;
  return { format: 'webp', mime: IMAGE_MIME_BY_FORMAT.webp, width, height };
}

/** 解析 GIF 逻辑屏尺寸（GIF87a / GIF89a）。 */
function parseGifDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 10) return null;
  const version = ascii(bytes, 0, 6);
  if (version !== 'GIF87a' && version !== 'GIF89a') return null;
  const width = le16(bytes, 6);
  const height = le16(bytes, 8);
  if (!validDimensions(width, height)) return null;
  return { format: 'gif', mime: IMAGE_MIME_BY_FORMAT.gif, width, height };
}

/**
 * 解析图像宽高与真实格式。
 * 只做头部解析，不保证完整像素可解码；PNG 的完整解码由 perceptualHashDhashPng 负责。
 */
export function parseImageDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return null;
  const signature = detectImageSignature(bytes);
  if (signature === null) return null;
  switch (signature.format) {
    case 'png':
      return parsePngDimensions(bytes);
    case 'jpeg':
      return parseJpegDimensions(bytes);
    case 'webp':
      return parseWebpDimensions(bytes);
    case 'gif':
      return parseGifDimensions(bytes);
    default:
      return null;
  }
}

function paeth(left: number, up: number, upLeft: number): number {
  const p = left + up - upLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - upLeft);
  if (pa <= pb && pa <= pc) return left;
  if (pb <= pc) return up;
  return upLeft;
}

function channelsForColorType(colorType: number): number | null {
  switch (colorType) {
    case 0:
      return 1;
    case 2:
      return 3;
    case 4:
      return 2;
    case 6:
      return 4;
    default:
      return null;
  }
}

/**
 * 计算 PNG 的 dHash（64 位，16 位十六进制字符串）。
 *
 * 限制（返回 null，不伪造）：
 * - 非 PNG、调色板 PNG（color type 3）、位深非 8、隔行扫描；
 * - IDAT 缺失 / zlib 解压失败 / 过滤器类型非法 / 尺寸超出安全上限。
 */
export function perceptualHashDhashPng(bytes: Uint8Array): string | null {
  if (!(bytes instanceof Uint8Array) || bytes.length < 33) return null;
  if (!matches(bytes, 0, PNG_SIGNATURE)) return null;
  if (ascii(bytes, 12, 4) !== 'IHDR' || be32(bytes, 8) !== 13) return null;
  const width = be32(bytes, 16);
  const height = be32(bytes, 20);
  const bitDepth = u8(bytes, 24);
  const colorType = u8(bytes, 25);
  const compression = u8(bytes, 26);
  const filterMethod = u8(bytes, 27);
  const interlace = u8(bytes, 28);
  if (!validDimensions(width, height) || width < 2 || height < 1) return null;
  if (bitDepth !== 8 || compression !== 0 || filterMethod !== 0 || interlace !== 0) return null;
  const channels = channelsForColorType(colorType);
  if (channels === null) return null;
  const bytesPerPixel = channels;
  const rowBytes = width * bytesPerPixel;
  const decodedBytes = height * (1 + rowBytes);
  if (decodedBytes > MAX_DECODED_BYTES) return null;

  const idatParts: Buffer[] = [];
  let offset = 8;
  let sawIhdr = false;
  while (offset + 8 <= bytes.length) {
    const length = be32(bytes, offset);
    const type = ascii(bytes, offset + 4, 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (length > bytes.length || dataEnd + 4 > bytes.length) return null;
    if (type === 'IHDR') sawIhdr = true;
    if (type === 'IDAT' && length > 0) {
      idatParts.push(Buffer.from(bytes.buffer as ArrayBuffer, bytes.byteOffset + dataStart, length));
    }
    if (type === 'IEND') break;
    offset = dataEnd + 4;
  }
  if (!sawIhdr || idatParts.length === 0) return null;

  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idatParts), { maxOutputLength: decodedBytes });
  } catch {
    return null;
  }
  if (raw.length < decodedBytes) return null;

  const pixels = Buffer.alloc(height * rowBytes);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + rowBytes);
    const filter = u8(raw, rowStart);
    const source = rowStart + 1;
    const target = y * rowBytes;
    const previous = target - rowBytes;
    for (let x = 0; x < rowBytes; x += 1) {
      const value = u8(raw, source + x);
      const left = x >= bytesPerPixel ? u8(pixels, target + x - bytesPerPixel) : 0;
      const up = y > 0 ? u8(pixels, previous + x) : 0;
      const upLeft = y > 0 && x >= bytesPerPixel ? u8(pixels, previous + x - bytesPerPixel) : 0;
      let reconstructed: number;
      switch (filter) {
        case 0:
          reconstructed = value;
          break;
        case 1:
          reconstructed = value + left;
          break;
        case 2:
          reconstructed = value + up;
          break;
        case 3:
          reconstructed = value + ((left + up) >> 1);
          break;
        case 4:
          reconstructed = value + paeth(left, up, upLeft);
          break;
        default:
          return null;
      }
      pixels[target + x] = reconstructed & 0xff;
    }
  }

  const gray = new Float64Array(width * height);
  for (let i = 0; i < width * height; i += 1) {
    const base = i * bytesPerPixel;
    if (colorType === 0 || colorType === 4) {
      gray[i] = u8(pixels, base);
    } else {
      const r = u8(pixels, base);
      const g = u8(pixels, base + 1);
      const b = u8(pixels, base + 2);
      gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    }
  }

  const columns = new Float64Array(8 * 9);
  for (let row = 0; row < 8; row += 1) {
    const y0 = Math.floor((row * height) / 8);
    const y1 = Math.min(height, Math.max(y0 + 1, Math.floor(((row + 1) * height) / 8)));
    for (let column = 0; column < 9; column += 1) {
      const x0 = Math.floor((column * width) / 9);
      const x1 = Math.min(width, Math.max(x0 + 1, Math.floor(((column + 1) * width) / 9)));
      let sum = 0;
      let count = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          sum += gray[y * width + x] ?? 0;
          count += 1;
        }
      }
      columns[row * 9 + column] = count === 0 ? 0 : sum / count;
    }
  }

  let hex = '';
  for (let row = 0; row < 8; row += 1) {
    let high = 0;
    let low = 0;
    for (let column = 0; column < 8; column += 1) {
      const left = columns[row * 9 + column] ?? 0;
      const right = columns[row * 9 + column + 1] ?? 0;
      const bit = left > right ? 1 : 0;
      if (column < 4) high = (high << 1) | bit;
      else low = (low << 1) | bit;
    }
    hex += high.toString(16);
    hex += low.toString(16);
  }
  return hex;
}

/** 计算两个十六进制感知哈希的汉明距离；输入非法时抛 INVALID_INPUT。 */
export function hammingDistance(a: string, b: string): number {
  const left = typeof a === 'string' ? a.trim().toLowerCase() : '';
  const right = typeof b === 'string' ? b.trim().toLowerCase() : '';
  if (!/^[0-9a-f]+$/.test(left) || !/^[0-9a-f]+$/.test(right)) {
    throw new MomentsError('INVALID_INPUT', '感知哈希必须是非空十六进制字符串');
  }
  if (left.length !== right.length) {
    throw new MomentsError('INVALID_INPUT', '感知哈希长度不一致，无法比较', {
      details: { leftLength: left.length, rightLength: right.length },
    });
  }
  let distance = 0;
  for (let i = 0; i < left.length; i += 1) {
    let xor = parseInt(left[i] ?? '0', 16) ^ parseInt(right[i] ?? '0', 16);
    while (xor !== 0) {
      distance += xor & 1;
      xor >>= 1;
    }
  }
  return distance;
}

/** 计算最简宽高比字符串，例如 1920x1080 -> "16:9"。 */
export function formatAspectRatio(width: number, height: number): string {
  if (!validDimensions(width, height)) return '0:0';
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
}

/** 数值宽高比（宽 / 高）。 */
export function aspectRatioValue(width: number, height: number): number {
  if (!validDimensions(width, height)) return 0;
  return width / height;
}

/** 判断宽高比是否命中允许列表（容差 1%）。 */
export function isAllowedAspectRatio(width: number, height: number, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return true;
  const actual = aspectRatioValue(width, height);
  if (actual <= 0) return false;
  return allowed.some((item) => {
    const [rawWidth, rawHeight] = item.split(':');
    const w = Number(rawWidth);
    const h = Number(rawHeight);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return false;
    return Math.abs(actual - w / h) / (w / h) <= 0.01;
  });
}

export interface DimensionSuggestion {
  readonly width: number;
  readonly height: number;
  readonly aspectRatio: string;
  readonly changed: boolean;
  readonly note: string;
}

export interface StandardizeOptions {
  /** 期望宽高比，例如 "16:9"；省略时只做最大边收缩。 */
  readonly preferredAspectRatio?: string;
  /** 最大边像素；省略默认 2048。 */
  readonly maxSide?: number;
  /** 边长的 8 像素对齐；默认 true。 */
  readonly alignTo8?: boolean;
}

function alignSide(value: number, alignTo8: boolean): number {
  const rounded = Math.max(16, Math.round(value));
  if (!alignTo8) return rounded;
  return Math.max(16, Math.round(rounded / 8) * 8);
}

/**
 * 只给出“建议尺寸”，绝不修改原图。
 * 供提示词/生成参数使用，调用方自行决定是否采纳。
 */
export function standardizeDimensions(width: number, height: number, options: StandardizeOptions = {}): DimensionSuggestion {
  if (!validDimensions(width, height)) {
    throw new MomentsError('INVALID_INPUT', '标准尺寸建议需要有效宽高');
  }
  const alignTo8 = options.alignTo8 ?? true;
  const maxSide = Math.max(64, Math.min(options.maxSide ?? 2048, MAX_DIMENSION));
  let targetWidth = width;
  let targetHeight = height;
  if (options.preferredAspectRatio !== undefined) {
    const [rawWidth, rawHeight] = options.preferredAspectRatio.split(':');
    const ratioWidth = Number(rawWidth);
    const ratioHeight = Number(rawHeight);
    if (!Number.isFinite(ratioWidth) || !Number.isFinite(ratioHeight) || ratioWidth <= 0 || ratioHeight <= 0) {
      throw new MomentsError('INVALID_INPUT', `无效的宽高比：${options.preferredAspectRatio}`);
    }
    const ratio = ratioWidth / ratioHeight;
    const longSide = Math.min(Math.max(width, height), maxSide);
    if (ratio >= 1) {
      targetWidth = longSide;
      targetHeight = longSide / ratio;
    } else {
      targetHeight = longSide;
      targetWidth = longSide * ratio;
    }
  }
  const largest = Math.max(targetWidth, targetHeight);
  if (largest > maxSide) {
    const scale = maxSide / largest;
    targetWidth *= scale;
    targetHeight *= scale;
  }
  const finalWidth = alignSide(targetWidth, alignTo8);
  const finalHeight = alignSide(targetHeight, alignTo8);
  return {
    width: finalWidth,
    height: finalHeight,
    aspectRatio: formatAspectRatio(finalWidth, finalHeight),
    changed: finalWidth !== width || finalHeight !== height,
    note: '仅为尺寸建议，不修改原图；落地前需由调用方重新确认',
  };
}
