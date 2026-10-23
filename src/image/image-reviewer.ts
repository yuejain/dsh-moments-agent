/**
 * 图像结构化审核（ImageReviewer）。
 *
 * 职责边界（重要）：
 * - 只做“可解释的本地启发式检查”：文件存在性、签名与声明 MIME 一致性、尺寸可解析性、
 *   大小/长宽比、SHA-256 与感知哈希近重复、来源与许可字段完整性、调用方声明的风险标记；
 * - 不伪造视觉审核：没有 OCR / 多模态模型时 `relevantToText` 必须为 null 并在 notes 说明，
 *   绝不声称“图片与文案相关”；
 * - 感知哈希不可用时显式记录 PERCEPTUAL_HASH_UNAVAILABLE，不当作通过；
 * - 审核与审批 / 任务 ID 无关：报告不读取 approvals，也不要求 imageTaskId 存在。
 */
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Logger } from '../adapters/types.js';
import { sha256Bytes } from '../domain/ids.js';
import { MomentsError } from '../domain/result.js';
import type { ImageReviewReport, MediaAssetRecord, RiskFlag } from '../domain/types.js';
import { isInside } from '../security/path-guard.js';
import type { MomentsStore } from '../storage/store.js';
import { decodeImage } from './pixel-decoder.js';
import {
  aspectRatioValue,
  detectImageSignature,
  formatAspectRatio,
  hammingDistance,
  isAllowedAspectRatio,
  isGenericDeclaredMime,
  normalizeMime,
  parseImageDimensions,
} from './image-processor.js';

/** 会阻止图片进入发布流程的风险标记。 */
const BLOCKING_FLAGS: ReadonlySet<RiskFlag> = new Set<RiskFlag>([
  'DUPLICATE_RECENT',
  'IMAGE_LOW_QUALITY',
  'MISLEADING_IMAGE',
  'IMAGE_REAL_EVENT_MISMATCH',
  'PRIVACY_PERSONAL_INFO',
  'UNVERIFIED_FACT',
  'PROMPT_INJECTION_SUSPECTED',
  'SENSITIVE_TOPIC',
]);

export interface ImageReviewerOptions {
  readonly store: MomentsStore;
  /** 素材根目录；用于拒绝读取素材库之外的路径。 */
  readonly assetsRoot: string;
  readonly maxFileBytes?: number;
  readonly allowedAspectRatios?: readonly string[];
  readonly maxRecentAssets?: number;
  /** 近似重复的汉明距离阈值，默认 8。 */
  readonly nearDuplicateThreshold?: number;
  readonly minWidth?: number;
  readonly minHeight?: number;
  readonly now?: () => Date;
  readonly logger?: Logger;
}

/**
 * 调用方可传入的“声明式”提示。
 * 这些字段全部是调用方/上游声明的语义，本模块不做视觉识别，只做可解释推理。
 */
export interface ReviewHints {
  readonly declaredMime?: string;
  readonly license?: string;
  readonly source?: MediaAssetRecord['source'];
  readonly provider?: string;
  readonly model?: string;
  /** 调用方是否声明“这张图就是真实事件现场照片”。 */
  readonly claimsRealEvent?: boolean;
  /** 调用方是否声明图片包含具体地点。 */
  readonly claimsLocation?: boolean;
  /** 调用方是否声明图片包含个人隐私信息（人脸、证件、住址等）。 */
  readonly containsPersonalInfo?: boolean;
  /** 调用方是否声明图片由 AI 生成。 */
  readonly isAiGenerated?: boolean;
  /** 调用方声明的文案/事实未经核实。 */
  readonly unverifiedFact?: boolean;
  readonly sensitiveTopic?: boolean;
  readonly promptInjectionSuspected?: boolean;
  /** 图片与文案的相关性；未知时必须为 null（默认）。 */
  readonly relevantToText?: boolean | null;
  /** 是否存在配套文案；false 时相关度不适用。 */
  readonly textPresent?: boolean;
  /** 可选的感知哈希覆盖值（例如上层已计算）。 */
  readonly perceptualHash?: string | null;
  /** 可选的近重复比较基准（默认取 store.listRecentAssets）。 */
  readonly recentAssets?: readonly MediaAssetRecord[];
}

export interface ReviewBytesInput extends ReviewHints {
  readonly bytes: Uint8Array;
  readonly originalFileName?: string;
}

export interface ImageReviewResult {
  readonly assetId: string | null;
  readonly passed: boolean;
  readonly flags: readonly RiskFlag[];
  readonly blockingFlags: readonly RiskFlag[];
  readonly report: ImageReviewReport;
  readonly reviewedAt: string;
  readonly persisted: boolean;
  /** 硬失败（文件不存在、损坏、超限等），此时 flags 可能为空但 passed=false。 */
  readonly hardFailure: string | null;
}

interface BuildInput {
  readonly assetId: string | null;
  readonly bytes: Uint8Array | null;
  readonly exists: boolean;
  readonly declaredMime: string;
  readonly license: string;
  readonly source: MediaAssetRecord['source'] | undefined;
  readonly provider: string;
  readonly model: string;
  readonly perceptualHash: string | null | undefined;
  readonly recentAssets: readonly MediaAssetRecord[];
  readonly hints: ReviewHints;
  readonly readError: string | null;
}

interface BuildOutput {
  readonly passed: boolean;
  readonly flags: readonly RiskFlag[];
  readonly report: ImageReviewReport;
  readonly hardFailure: string | null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function emptyReport(declaredMime: string, bytes: number, notes: readonly string[]): ImageReviewReport {
  return {
    exists: false,
    signatureMime: null,
    declaredMime,
    mimeMatched: false,
    width: 0,
    height: 0,
    aspectRatio: 0,
    bytes,
    sha256: '',
    perceptualHash: null,
    nearDuplicateOf: null,
    relevantToText: null,
    qualityScore: 0,
    notes,
  };
}

function scoreQuality(input: {
  width: number;
  height: number;
  bytes: number;
  decodeOk: boolean;
  mimeMatched: boolean;
  aspectRatioAllowed: boolean;
}): number {
  let score = 0.4;
  if (input.width >= 512 && input.height >= 512) score += 0.25;
  else if (input.width >= 256 && input.height >= 256) score += 0.15;
  else if (input.width >= 128 && input.height >= 128) score += 0.05;
  if (input.bytes >= 8 * 1024) score += 0.1;
  if (input.bytes >= 64 * 1024) score += 0.05;
  if (input.mimeMatched) score += 0.1;
  if (input.aspectRatioAllowed) score += 0.1;
  if (!input.decodeOk) score = Math.min(score, 0.2);
  return round2(Math.max(0, Math.min(1, score)));
}

export class ImageReviewer {
  private readonly store: MomentsStore;
  private readonly assetsRoot: string;
  private readonly maxFileBytes: number;
  private readonly allowedAspectRatios: readonly string[];
  private readonly maxRecentAssets: number;
  private readonly nearDuplicateThreshold: number;
  private readonly minWidth: number;
  private readonly minHeight: number;
  private readonly now: () => Date;
  private readonly logger: Logger | undefined;

  constructor(options: ImageReviewerOptions) {
    this.store = options.store;
    this.assetsRoot = path.resolve(options.assetsRoot);
    this.maxFileBytes = options.maxFileBytes ?? 12 * 1024 * 1024;
    this.allowedAspectRatios = options.allowedAspectRatios ?? [];
    this.maxRecentAssets = Math.min(Math.max(options.maxRecentAssets ?? 50, 1), 200);
    this.nearDuplicateThreshold = Math.max(0, Math.min(options.nearDuplicateThreshold ?? 8, 64));
    this.minWidth = options.minWidth ?? 64;
    this.minHeight = options.minHeight ?? 64;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger;
  }

  /** 审核已入库素材：读取文件、生成结构化报告并持久化到 image_reviews。 */
  async reviewAsset(assetId: string, hints: ReviewHints = {}): Promise<ImageReviewResult> {
    const asset = this.store.getAsset(assetId);
    if (asset === undefined) {
      throw new MomentsError('NOT_FOUND', `媒体素材不存在：${assetId}`);
    }
    const resolved = path.resolve(asset.path);
    if (!isInside(this.assetsRoot, resolved)) {
      throw new MomentsError('IMAGE_PATH_DENIED', '素材记录路径不在素材库目录内，已拒绝审核', { details: { assetId } });
    }
    let bytes: Uint8Array | null = null;
    let exists = false;
    let readError: string | null = null;
    try {
      const stat = lstatSync(resolved);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        readError = '素材路径不是普通文件';
      } else if (stat.size === 0) {
        readError = '素材文件为空';
      } else {
        bytes = readFileSync(resolved);
        exists = true;
      }
    } catch {
      readError = '素材文件不存在或不可读';
    }
    const recentAssets =
      hints.recentAssets ?? this.store.listRecentAssets(this.maxRecentAssets).filter((item) => item.sha256 !== asset.sha256);
    const built = await this.buildReview({
      assetId,
      bytes,
      exists,
      declaredMime: hints.declaredMime ?? asset.mime,
      license: hints.license ?? asset.license,
      source: hints.source ?? asset.source,
      provider: hints.provider ?? asset.provider,
      model: hints.model ?? asset.model,
      perceptualHash: hints.perceptualHash !== undefined ? hints.perceptualHash : asset.perceptualHash,
      recentAssets,
      hints,
      readError,
    });
    const reviewedAt = this.now().toISOString();
    this.store.saveImageReview(assetId, { passed: built.passed, flags: built.flags, report: built.report }, reviewedAt);
    this.logger?.info('素材审核完成', {
      assetId,
      sha256Prefix: built.report.sha256.slice(0, 12),
      passed: built.passed,
      flags: built.flags,
    });
    return {
      assetId,
      passed: built.passed,
      flags: built.flags,
      blockingFlags: built.flags.filter((flag) => BLOCKING_FLAGS.has(flag)),
      report: built.report,
      reviewedAt,
      persisted: true,
      hardFailure: built.hardFailure,
    };
  }

  /** 审核任意字节（不落盘、不持久化），用于导入前的预检。 */
  async reviewBytes(input: ReviewBytesInput): Promise<ImageReviewResult> {
    const bytes = input.bytes;
    const isBytes = bytes instanceof Uint8Array;
    const length = isBytes ? bytes.length : 0;
    const built = await this.buildReview({
      assetId: null,
      bytes: isBytes && length > 0 ? bytes : null,
      exists: isBytes && length > 0,
      declaredMime: input.declaredMime ?? '',
      license: input.license ?? '',
      source: input.source,
      provider: input.provider ?? '',
      model: input.model ?? '',
      perceptualHash: input.perceptualHash,
      recentAssets: input.recentAssets ?? [],
      hints: input,
      readError: isBytes ? (length === 0 ? '图像字节为空' : null) : '图像字节不是 Uint8Array',
    });
    return {
      assetId: null,
      passed: built.passed,
      flags: built.flags,
      blockingFlags: built.flags.filter((flag) => BLOCKING_FLAGS.has(flag)),
      report: built.report,
      reviewedAt: this.now().toISOString(),
      persisted: false,
      hardFailure: built.hardFailure,
    };
  }

  private async buildReview(input: BuildInput): Promise<BuildOutput> {
    const hints = input.hints;
    const declaredMime = normalizeMime(input.declaredMime);
    const notes: string[] = [];
    const flags: RiskFlag[] = [];
    let hardFailure: string | null = null;

    if (!input.exists || input.bytes === null) {
      const reason = input.readError ?? '素材不存在';
      notes.push(`审核未通过：${reason}`);
      return {
        passed: false,
        flags,
        report: emptyReport(declaredMime, 0, notes),
        hardFailure: reason,
      };
    }

    const bytes = input.bytes;
    const signature = detectImageSignature(bytes);
    const signatureMime = signature?.mime ?? null;
    const declaredIsSupported = declaredMime !== '' && !isGenericDeclaredMime(declaredMime);
    const mimeMatched = signatureMime !== null && (declaredMime === '' || isGenericDeclaredMime(declaredMime) || declaredMime === signatureMime);
    if (signatureMime === null) {
      hardFailure = '不是受支持的图像格式（PNG / JPEG / WebP / GIF）';
      notes.push('文件签名无法识别：可能是损坏文件或伪造扩展名');
    } else if (declaredIsSupported && !mimeMatched) {
      flags.push('MISLEADING_IMAGE');
      notes.push(`文件签名（${signatureMime}）与声明 MIME（${declaredMime}）不一致`);
    }

    const bytesOverLimit = bytes.length > this.maxFileBytes;
    if (bytesOverLimit) {
      hardFailure = hardFailure ?? `文件超过大小上限（最大 ${this.maxFileBytes} 字节）`;
      notes.push(`文件大小 ${bytes.length} 字节，超过上限 ${this.maxFileBytes} 字节`);
    }

    const dimensions = parseImageDimensions(bytes);
    let decoded: Awaited<ReturnType<typeof decodeImage>> | null = null;
    if (!bytesOverLimit && signature !== null && dimensions !== null) {
      try { decoded = await decodeImage(bytes); }
      catch { notes.push('完整像素解码失败：文件损坏、动画多帧或超过像素上限'); }
    }
    const decodeOk = dimensions !== null && decoded !== null;
    if (!decodeOk) {
      hardFailure = hardFailure ?? '图像完整解码失败';
      notes.push('无法完成全部像素检查，审核拒绝');
    }
    const width = dimensions?.width ?? 0;
    const height = dimensions?.height ?? 0;
    const aspectRatio = aspectRatioValue(width, height);
    const ratioAllowed =
      dimensions === null ? false : this.allowedAspectRatios.length === 0 || isAllowedAspectRatio(width, height, this.allowedAspectRatios);
    if (dimensions !== null && !ratioAllowed) {
      notes.push(`宽高比 ${formatAspectRatio(width, height)} 不在允许列表（${this.allowedAspectRatios.join(' / ')}）中，发布前建议裁剪`);
    }

    const perceptualHash = decoded?.perceptualHash ?? null;
    if (perceptualHash === null) {
      flags.push('PERCEPTUAL_HASH_UNAVAILABLE');
      hardFailure = hardFailure ?? '像素解码失败，无法计算感知哈希';
    }

    const sha256 = sha256Bytes(bytes);
    let nearDuplicateOf: string | null = null;
    for (const candidate of input.recentAssets) {
      if (candidate.sha256 === sha256) {
        nearDuplicateOf = candidate.sha256;
        flags.push('DUPLICATE_RECENT');
        notes.push(`与已有素材内容完全一致（assetId=${candidate.assetId}）`);
        break;
      }
      if (perceptualHash === null || candidate.perceptualHash === null) continue;
      let distance: number;
      try {
        distance = hammingDistance(perceptualHash, candidate.perceptualHash);
      } catch {
        notes.push(`已有素材 ${candidate.assetId} 的感知哈希格式异常，已跳过近重复比较`);
        continue;
      }
      if (distance <= this.nearDuplicateThreshold) {
        nearDuplicateOf = candidate.sha256;
        flags.push('DUPLICATE_RECENT');
        notes.push(
          `与最近素材 ${candidate.assetId} 近似重复（感知哈希汉明距离 ${distance} ≤ ${this.nearDuplicateThreshold}），建议更换`,
        );
        break;
      }
    }

    const license = (input.license ?? '').trim();
    if (license === '' || license.toLowerCase() === 'unknown') {
      flags.push('SOURCE_MISSING');
      notes.push('来源/许可字段缺失：发布前必须补充图片授权信息');
    }
    if (input.source === undefined || input.source === null) {
      if (!flags.includes('SOURCE_MISSING')) flags.push('SOURCE_MISSING');
      notes.push('来源类型缺失：无法判断图片来自用户上传、订阅客户端还是本地生成');
    }

    const isAiGenerated =
      hints.isAiGenerated ?? (input.source === 'local_generation' || /generation|comfyui|official_api/i.test(input.provider));
    if (hints.claimsRealEvent === true) {
      flags.push('REAL_PERSON_CLAIM');
      notes.push('调用方声明图片对应真实事件/真实人物：需要人工核对来源与授权');
      if (isAiGenerated) {
        flags.push('IMAGE_REAL_EVENT_MISMATCH');
        notes.push('图片被标记为 AI 生成，却声明为真实事件现场照片：疑似误导，禁止直接发布');
      }
    }
    if (hints.claimsLocation === true) {
      flags.push('LOCATION_CLAIM');
      notes.push('图片包含/声明具体地点：发布前需核对地点信息');
    }
    if (hints.containsPersonalInfo === true) {
      flags.push('PRIVACY_PERSONAL_INFO');
      notes.push('调用方声明图片含个人隐私信息：未经当事人同意不得发布');
    }
    if (hints.unverifiedFact === true) flags.push('UNVERIFIED_FACT');
    if (hints.sensitiveTopic === true) flags.push('SENSITIVE_TOPIC');
    if (hints.promptInjectionSuspected === true) flags.push('PROMPT_INJECTION_SUSPECTED');
    if (hints.relevantToText === false) {
      flags.push('MISLEADING_IMAGE');
      notes.push('调用方声明图片与文案不相关：图文不符，禁止直接发布');
    } else if (hints.relevantToText === true) {
      notes.push('调用方声明图片与文案相关（声明式，非视觉模型结论）');
    } else if (hints.textPresent === false) {
      notes.push('没有配套文案，相关度不适用');
    } else {
      notes.push('未进行视觉语义理解（无 OCR / 多模态模型），相关度未知，不伪造视觉审核通过');
    }

    if (dimensions !== null && (width < this.minWidth || height < this.minHeight)) {
      flags.push('IMAGE_LOW_QUALITY');
      notes.push(`分辨率 ${width}x${height} 低于建议下限 ${this.minWidth}x${this.minHeight}`);
    }
    const qualityScore = scoreQuality({
      width,
      height,
      bytes: bytes.length,
      decodeOk,
      mimeMatched,
      aspectRatioAllowed: ratioAllowed,
    });
    if (qualityScore < 0.45 && !flags.includes('IMAGE_LOW_QUALITY')) {
      flags.push('IMAGE_LOW_QUALITY');
      notes.push(`质量评分 ${qualityScore} 偏低（尺寸/体积/声明一致性综合评估）`);
    }

    const blockingFlags = flags.filter((flag) => BLOCKING_FLAGS.has(flag));
    const passed =
      input.exists && decodeOk && mimeMatched && hardFailure === null && blockingFlags.length === 0;
    if (!passed && hardFailure === null && blockingFlags.length > 0) {
      notes.push(`审核未通过，阻断标记：${blockingFlags.join(', ')}`);
    }
    const report: ImageReviewReport = {
      exists: true,
      signatureMime,
      declaredMime,
      mimeMatched,
      width,
      height,
      aspectRatio: round2(aspectRatio),
      bytes: bytes.length,
      sha256,
      perceptualHash,
      nearDuplicateOf,
      relevantToText: hints.relevantToText ?? null,
      qualityScore,
      notes,
    };
    return { passed, flags, report, hardFailure };
  }
}
