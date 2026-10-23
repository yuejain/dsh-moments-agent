/**
 * 内容寻址素材库（AssetStore）。
 *
 * 安全与一致性边界：
 * - 只接受 PNG / JPEG / WebP / GIF 的真实文件签名，绝不信任声明 MIME 或扩展名；
 * - 落盘路径完全由 SHA-256 推导：<dataDir>/<assetDir>/<前2>/<次2>/<sha256>.<ext>；
 * - 先写 `<final>.tmp` 再 rename，避免崩溃产生半截素材；
 * - 重复内容（相同 SHA-256）直接复用已有记录，不重复占盘；
 * - importFromPath 只允许 dataDir 下 assets / imports 两个目录内的普通文件，拒绝
 *   `..`、绝对路径逃逸、符号链接、目录、空文件与超大文件；
 * - 日志只记录 SHA 前缀与尺寸，不记录完整本机路径。
 */
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AssetImporter, Logger } from '../adapters/types.js';
import { newId, sha256Bytes } from '../domain/ids.js';
import { MomentsError } from '../domain/result.js';
import type { MediaAssetRecord } from '../domain/types.js';
import { assertRegularFile, isInside, resolveInsideRoot } from '../security/path-guard.js';
import type { MomentsStore } from '../storage/store.js';
import { decodeImage } from './pixel-decoder.js';
import {
  detectImageSignature,
  isGenericDeclaredMime,
  mimeFromFileName,
  normalizeMime,
  parseImageDimensions,
  SUPPORTED_IMAGE_MIME_TYPES,
  type ImageFormat,
} from './image-processor.js';

/** 格式 -> 落盘扩展名。 */
const EXTENSION_BY_FORMAT: Readonly<Record<ImageFormat, string>> = {
  png: 'png',
  jpeg: 'jpg',
  webp: 'webp',
  gif: 'gif',
};

export interface AssetStoreOptions {
  readonly store: MomentsStore;
  /** 插件数据根目录（绝对路径或相对当前工作目录）。 */
  readonly dataDir: string;
  readonly maxFileBytes: number;
  /** assets 子目录名，默认取 config.images.assetDir（'assets'）。 */
  readonly assetDirName?: string;
  readonly now?: () => Date;
  readonly logger?: Logger;
}

/** 与 adapters/types.ts 的 AssetImporter.importBytes 入参保持一致。 */
export type ImportAssetInput = Parameters<AssetImporter['importBytes']>[0];

export interface ImportFromPathInput {
  /** 允许绝对或相对路径，但必须落在 dataDir/assets 或 dataDir/imports 内。 */
  readonly path: string;
  readonly declaredMime?: string;
  readonly source: MediaAssetRecord['source'];
  readonly license: string;
  readonly prompt: string;
  readonly provider: string;
  readonly model: string;
  readonly imageTaskId?: string | null;
}

export interface ImportedAsset {
  readonly asset: MediaAssetRecord;
  readonly duplicate: boolean;
}

function requireNonNegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new MomentsError('INVALID_INPUT', `${label} 必须是正整数`);
  }
  return value;
}

function writeAtomic(target: string, bytes: Uint8Array): void {
  mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, bytes, { flag: 'wx' });
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw new MomentsError('INTERNAL_ERROR', '写入素材文件失败', { cause: error });
  }
}

export class AssetStore implements AssetImporter {
  private readonly store: MomentsStore;
  private readonly dataDir: string;
  private readonly maxFileBytes: number;
  private readonly now: () => Date;
  private readonly logger: Logger | undefined;
  /** 素材根目录：<dataDir>/<assetDirName>。 */
  readonly assetsRoot: string;
  /** 用户手动导入的暂存目录：<dataDir>/imports。 */
  readonly importsRoot: string;

  constructor(options: AssetStoreOptions) {
    this.store = options.store;
    this.dataDir = path.resolve(options.dataDir);
    this.maxFileBytes = requireNonNegativeInteger(options.maxFileBytes, 'images.maxFileBytes');
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger;
    const assetDirName = (options.assetDirName ?? 'assets').trim() || 'assets';
    this.assetsRoot = path.resolve(this.dataDir, assetDirName);
    this.importsRoot = path.resolve(this.dataDir, 'imports');
  }

  /** 创建素材根目录与导入暂存目录（幂等）。 */
  ensureRoots(): void {
    mkdirSync(this.assetsRoot, { recursive: true });
    mkdirSync(this.importsRoot, { recursive: true });
  }

  /** 由 SHA-256 推导的内容寻址落盘路径。 */
  assetPathFor(sha256: string, format: ImageFormat): string {
    if (!/^[a-f0-9]{64}$/.test(sha256)) {
      throw new MomentsError('INTERNAL_ERROR', '内部错误：非法 SHA-256，无法推导素材路径');
    }
    const extension = EXTENSION_BY_FORMAT[format];
    return path.join(this.assetsRoot, sha256.slice(0, 2), sha256.slice(2, 4), `${sha256}.${extension}`);
  }

  /**
   * 导入图片字节：校验 -> 计算 SHA-256 -> 落盘 -> 记录元数据。
   * 相同内容已存在时返回已有素材（duplicate=true），不会重复写入。
   */
  async importBytes(input: ImportAssetInput): Promise<ImportedAsset> {
    const bytes = input.bytes;
    if (!(bytes instanceof Uint8Array)) {
      throw new MomentsError('INVALID_INPUT', '图像字节必须是 Uint8Array');
    }
    if (bytes.length === 0) {
      throw new MomentsError('IMAGE_INVALID', '图像文件为空，已拒绝导入');
    }
    if (bytes.length > this.maxFileBytes) {
      throw new MomentsError('IMAGE_INVALID', `图像文件超过大小上限（最大 ${this.maxFileBytes} 字节，实际 ${bytes.length} 字节）`, {
        details: { maxFileBytes: this.maxFileBytes, actualBytes: bytes.length },
      });
    }
    const signature = detectImageSignature(bytes);
    if (signature === null) {
      throw new MomentsError('IMAGE_INVALID', '不是受支持的图像格式：只允许 PNG / JPEG / WebP / GIF（以文件签名为准）');
    }
    const declaredMime = normalizeMime(input.declaredMime ?? '');
    if (declaredMime !== '' && !isGenericDeclaredMime(declaredMime) && !SUPPORTED_IMAGE_MIME_TYPES.includes(declaredMime)) {
      throw new MomentsError('IMAGE_INVALID', `声明 MIME 不是受支持的图像类型：${input.declaredMime}`);
    }
    if (declaredMime !== '' && !isGenericDeclaredMime(declaredMime) && declaredMime !== signature.mime) {
      throw new MomentsError('IMAGE_INVALID', `声明 MIME（${declaredMime}）与文件签名（${signature.mime}）不一致`, {
        details: { declaredMime: input.declaredMime ?? '', signatureMime: signature.mime },
      });
    }
    const dimensions = parseImageDimensions(bytes);
    if (dimensions === null) {
      throw new MomentsError('IMAGE_INVALID', '图像头损坏，无法解析宽高');
    }

    const sha256 = sha256Bytes(bytes);
    const decoded = await decodeImage(bytes);
    const perceptualHash = decoded.perceptualHash;
    const target = this.assetPathFor(sha256, signature.format);
    const existing = this.store.getAssetBySha(sha256);
    if (existing !== undefined) {
      this.ensureStoredFile(existing, bytes);
      return { asset: existing, duplicate: true };
    }

    this.ensureRoots();
    writeAtomic(target, bytes);

    const asset: MediaAssetRecord = {
      assetId: newId('asset'),
      sha256,
      path: target,
      mime: signature.mime,
      width: dimensions.width,
      height: dimensions.height,
      bytes: bytes.length,
      source: input.source,
      license: (input.license ?? '').trim() || 'unknown',
      prompt: input.prompt ?? '',
      provider: input.provider ?? '',
      model: input.model ?? '',
      imageTaskId: input.imageTaskId ?? null,
      perceptualHash,
      createdAt: this.now().toISOString(),
    };
    const inserted = this.store.insertAsset(asset);
    this.logger?.info('素材已导入', {
      assetId: inserted.asset.assetId,
      sha256Prefix: sha256.slice(0, 12),
      mime: inserted.asset.mime,
      width: inserted.asset.width,
      height: inserted.asset.height,
      bytes: inserted.asset.bytes,
      duplicate: inserted.duplicate,
    });
    return inserted;
  }

  /**
   * 从 dataDir/assets 或 dataDir/imports 内导入本地文件。
   * 这是唯一允许读本机文件的入口，绝不接受任意用户路径。
   */
  async importFromPath(input: ImportFromPathInput): Promise<ImportedAsset> {
    const realPath = this.resolveImportPath(input.path);
    assertRegularFile(realPath, '导入文件');
    const stat = lstatSync(realPath);
    if (stat.size === 0) {
      throw new MomentsError('IMAGE_INVALID', '导入文件为空，已拒绝');
    }
    if (stat.size > this.maxFileBytes) {
      throw new MomentsError('IMAGE_INVALID', `导入文件超过大小上限（最大 ${this.maxFileBytes} 字节，实际 ${stat.size} 字节）`, {
        details: { maxFileBytes: this.maxFileBytes, actualBytes: stat.size },
      });
    }
    const bytes = readFileSync(realPath);
    const declaredMime = input.declaredMime ?? mimeFromFileName(realPath) ?? 'application/octet-stream';
    return this.importBytes({
      bytes,
      declaredMime,
      source: input.source,
      license: input.license,
      prompt: input.prompt,
      provider: input.provider,
      model: input.model,
      imageTaskId: input.imageTaskId ?? null,
      originalFileName: path.basename(realPath),
    });
  }

  /** 读取素材字节（审核用）。只允许读取 assets 根目录内的文件。 */
  readAssetBytes(assetId: string): Uint8Array {
    const asset = this.store.requireAsset(assetId);
    return this.readAssetFile(asset);
  }

  /** 按素材记录读取文件并做路径边界校验，供 ImageReviewer 复用。 */
  readAssetFile(asset: MediaAssetRecord, maxBytes = this.maxFileBytes): Uint8Array {
    const resolved = path.resolve(asset.path);
    if (!isInside(this.assetsRoot, resolved)) {
      throw new MomentsError('IMAGE_PATH_DENIED', '素材记录路径不在素材库目录内，已拒绝读取', { details: { assetId: asset.assetId } });
    }
    let stat;
    try {
      stat = lstatSync(resolved);
    } catch {
      throw new MomentsError('NOT_FOUND', `素材文件不存在：${asset.sha256.slice(0, 12)}`, { details: { assetId: asset.assetId } });
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new MomentsError('IMAGE_PATH_DENIED', '素材文件不是普通文件，已拒绝读取', { details: { assetId: asset.assetId } });
    }
    if (stat.size === 0) {
      throw new MomentsError('IMAGE_INVALID', '素材文件为空', { details: { assetId: asset.assetId } });
    }
    if (stat.size > maxBytes) {
      throw new MomentsError('IMAGE_INVALID', `素材文件超过大小上限（最大 ${maxBytes} 字节）`, {
        details: { assetId: asset.assetId, actualBytes: stat.size },
      });
    }
    return readFileSync(resolved);
  }

  /**
   * 把候选路径解析为 assets / imports 目录内的真实路径。
   * - 相对路径只按 imports 目录解析；
   * - 绝对路径必须词法上位于两个根目录之一，再用 realpath 防符号链接逃逸。
   */
  private resolveImportPath(candidate: string): string {
    if (typeof candidate !== 'string' || candidate.trim() === '') {
      throw new MomentsError('IMAGE_PATH_DENIED', '导入路径不能为空');
    }
    if (candidate.includes('\0')) {
      throw new MomentsError('IMAGE_PATH_DENIED', '导入路径包含非法字符');
    }
    this.ensureRoots();
    if (path.isAbsolute(candidate)) {
      const resolved = path.resolve(candidate);
      const root = [this.assetsRoot, this.importsRoot].find((item) => isInside(item, resolved));
      if (root === undefined) {
        throw new MomentsError('IMAGE_PATH_DENIED', '只允许导入 dataDir/assets 与 dataDir/imports 目录内的文件');
      }
      return resolveInsideRoot(root, path.relative(root, resolved), '导入文件');
    }
    if (candidate.split(/[\\/]/).includes('..')) {
      throw new MomentsError('IMAGE_PATH_DENIED', '导入路径不允许包含 `..`');
    }
    return resolveInsideRoot(this.importsRoot, candidate, '导入文件');
  }

  /** 命中已有记录但文件缺失（例如被手动删除）时，按内容重新写回。 */
  private ensureStoredFile(asset: MediaAssetRecord, bytes: Uint8Array): void {
    const resolved = path.resolve(asset.path);
    if (!isInside(this.assetsRoot, resolved)) {
      throw new MomentsError('IMAGE_PATH_DENIED', '素材记录路径不在素材库目录内，已拒绝写入', { details: { assetId: asset.assetId } });
    }
    if (existsSync(resolved) && lstatSync(resolved).isFile()) return;
    writeAtomic(resolved, bytes);
    this.logger?.warn('素材文件缺失，已按内容寻址路径重建', { assetId: asset.assetId, sha256Prefix: asset.sha256.slice(0, 12) });
  }
}
