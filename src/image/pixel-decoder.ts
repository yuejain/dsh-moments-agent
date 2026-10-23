import sharp from 'sharp';
import { MomentsError } from '../domain/result.js';
import { detectImageSignature } from './image-processor.js';

const MAX_PIXELS = 16 * 1024 * 1024;

/** Decode every pixel, not just the header. Inputs and outputs stay local. */
export async function decodeImage(bytes: Uint8Array): Promise<{
  width: number; height: number; perceptualHash: string;
}> {
  if (detectImageSignature(bytes) === null) throw new MomentsError('IMAGE_INVALID', '不支持的图片格式');
  try {
    const decoder = sharp(bytes, { failOn: 'warning', limitInputPixels: MAX_PIXELS });
    const metadata = await decoder.metadata();
    if ((metadata.pages ?? 1) > 1) {
      throw new Error('动画/多帧图片需要先明确选择单帧，不能只审核首帧');
    }
    const { data, info } = await decoder.toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    // Same area-average RGB luminance dHash as the legacy PNG implementation,
    // so existing stored hashes remain comparable across formats.
    const cells: number[] = [];
    for (let row = 0; row < 8; row++) {
      const y0 = Math.floor(row * height / 8);
      const y1 = Math.min(height, Math.max(y0 + 1, Math.floor((row + 1) * height / 8)));
      for (let col = 0; col < 9; col++) {
        const x0 = Math.floor(col * width / 9);
        const x1 = Math.min(width, Math.max(x0 + 1, Math.floor((col + 1) * width / 9)));
        let sum = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
          const index = (y * width + x) * channels;
          sum += 0.299 * data[index]! + 0.587 * data[index + 1]! + 0.114 * data[index + 2]!;
        }
        cells.push(sum / ((y1 - y0) * (x1 - x0)));
      }
    }
    let hash = 0n;
    for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) {
      hash = (hash << 1n) | (cells[row * 9 + col]! > cells[row * 9 + col + 1]! ? 1n : 0n);
    }
    return { width, height, perceptualHash: hash.toString(16).padStart(16, '0') };
  } catch (error) {
    throw new MomentsError('IMAGE_INVALID', '图片像素解码失败、元数据损坏、超过像素上限或包含多个帧', { cause: error });
  }
}
