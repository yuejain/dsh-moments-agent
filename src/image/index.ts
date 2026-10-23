/**
 * 图像子系统统一入口。
 *
 * 组合方式（推荐上层只依赖这里）：
 *   const images = createImageSubsystem({ store, dataDir, images: config.images, env, logger });
 *   const facade = createImageFacade({ config: config.images, store, dataDir, packageRoot, logger });
 *
 * 运行时（src/runtime、src/tools）只依赖 adapters/types.ts 的 `ImageFacade`，
 * 因此 `createImageFacade` 是二者之间的稳定接线点。
 */
import path from 'node:path';
import type {
  FetchLike,
  ImageFacade,
  ImageGenerationRequest,
  ImageGenerationResult,
  ImageProvider,
  ImageProviderCapabilities,
  Logger,
  LlmClient,
} from '../adapters/types.js';
import type { ImagesConfig } from '../config.js';
import { MomentsError } from '../domain/result.js';
import type { MediaAssetRecord } from '../domain/types.js';
import { isInside } from '../security/path-guard.js';
import type { MomentsStore } from '../storage/store.js';
import { AssetStore } from './asset-store.js';
import { ImageReviewer } from './image-reviewer.js';
import { reviewImageSemantics } from './semantic-reviewer.js';
import { ImageRouter, type ImageRouteResult } from './image-router.js';
import { createImageProviders, type ImageHttpFetch } from './providers/index.js';

export * from './image-processor.js';
export * from './asset-store.js';
export * from './image-reviewer.js';
export * from './image-router.js';
export * from './providers/index.js';
export type { ImageFacade, ImageReviewOutcome } from '../adapters/types.js';

export interface ImageSubsystemOptions {
  readonly store: MomentsStore;
  readonly dataDir: string;
  readonly images: ImagesConfig;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: ImageHttpFetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly officialMaxUsd?: number;
  readonly officialBudgetUsd?: number;
  readonly now?: () => Date;
  readonly logger?: Logger;
  readonly imageTaskTtlMinutes?: number;
}

export interface ImageSubsystem {
  readonly assetStore: AssetStore;
  readonly reviewer: ImageReviewer;
  readonly router: ImageRouter;
  readonly providers: ReadonlyMap<string, ImageProvider>;
  readonly assetsRoot: string;
  readonly importsRoot: string;
}

/** 组装素材库、审核器、Provider 与路由。所有目录都在 dataDir 内。 */
export function createImageSubsystem(options: ImageSubsystemOptions): ImageSubsystem {
  const assetStore = new AssetStore({
    store: options.store,
    dataDir: options.dataDir,
    maxFileBytes: options.images.maxFileBytes,
    assetDirName: options.images.assetDir,
    now: options.now,
    logger: options.logger,
  });
  const reviewer = new ImageReviewer({
    store: options.store,
    assetsRoot: assetStore.assetsRoot,
    maxFileBytes: options.images.maxFileBytes,
    allowedAspectRatios: options.images.allowedAspectRatios,
    now: options.now,
    logger: options.logger,
  });
  const providers = createImageProviders(options.images, {
    env: options.env,
    fetch: options.fetch,
    sleep: options.sleep,
    officialMaxUsd: options.officialMaxUsd,
    officialBudgetUsd: options.officialBudgetUsd,
  });
  const router = new ImageRouter({
    store: options.store,
    assetStore,
    images: options.images,
    providers,
    env: options.env,
    fetch: options.fetch,
    sleep: options.sleep,
    officialMaxUsd: options.officialMaxUsd,
    officialBudgetUsd: options.officialBudgetUsd,
    now: options.now,
    logger: options.logger,
    imageTaskTtlMinutes: options.imageTaskTtlMinutes,
  });
  return {
    assetStore,
    reviewer,
    router,
    providers,
    assetsRoot: assetStore.assetsRoot,
    importsRoot: assetStore.importsRoot,
  };
}

/** 便于健康检查展示的稳定描述（不含路径隐私与令牌）。 */
export function describeImageSubsystem(subsystem: ImageSubsystem): Record<string, unknown> {
  return {
    providers: [...subsystem.providers.keys()],
    assetsRoot: path.basename(subsystem.assetsRoot),
    importsRoot: path.basename(subsystem.importsRoot),
  };
}

// ---------------------------------------------------------------------------
// ImageFacade：运行时唯一依赖的门面
// ---------------------------------------------------------------------------

export interface CreateImageFacadeOptions {
  readonly llm?: LlmClient;
  /** config.images。 */
  readonly config: ImagesConfig;
  readonly store: MomentsStore;
  /** 插件数据目录（建议传绝对路径）。 */
  readonly dataDir: string;
  /** 包根目录；当前实现不需要，保留以匹配运行时接线签名。 */
  readonly packageRoot: string;
  readonly logger: Logger;
  readonly clock?: () => Date;
  readonly fetchImpl?: FetchLike;
}

function mapRouteStatus(status: ImageRouteResult['status']): ImageGenerationResult['status'] {
  return status;
}

/**
 * 创建运行时使用的图像门面。
 *
 * 语义：
 * - generate 的图片字节一律经 AssetStore 内容寻址落盘，返回 { result, assets }；
 *   `awaiting_user` 时 assets 为空，不会伪造图片；
 * - importFromPath 的 path 是相对 dataDir 的路径，只允许 data/imports 与 data/assets，
 *   绝对路径与 `..` 一律拒绝（IMAGE_PATH_DENIED）；
 * - reviewAsset 会调用 store.saveImageReview 持久化结构化审核报告。
 */
export function createImageFacade(options: CreateImageFacadeOptions): ImageFacade {
  const subsystem = createImageSubsystem({
    store: options.store,
    dataDir: options.dataDir,
    images: options.config,
    logger: options.logger,
    now: options.clock,
    fetch: options.fetchImpl,
  });
  const { assetStore, reviewer, router } = subsystem;
  const dataDir = path.resolve(options.dataDir);

  const resolveImportPath = (candidate: string): string => {
    if (typeof candidate !== 'string' || candidate.trim() === '') {
      throw new MomentsError('IMAGE_PATH_DENIED', '导入路径不能为空');
    }
    if (candidate.includes('\0')) {
      throw new MomentsError('IMAGE_PATH_DENIED', '导入路径包含非法字符');
    }
    if (path.isAbsolute(candidate)) {
      throw new MomentsError('IMAGE_PATH_DENIED', '只接受相对 dataDir 的导入路径，绝对路径已拒绝');
    }
    if (candidate.split(/[\\/]/).includes('..')) {
      throw new MomentsError('IMAGE_PATH_DENIED', '导入路径不允许包含 `..`');
    }
    const absolute = path.resolve(dataDir, candidate);
    const allowed = [assetStore.importsRoot, assetStore.assetsRoot].some((root) => isInside(root, absolute));
    if (!allowed) {
      throw new MomentsError('IMAGE_PATH_DENIED', '只允许导入 dataDir/imports 与 dataDir/assets 目录内的文件');
    }
    return absolute;
  };

  return {
    async listCapabilities(): Promise<ImageProviderCapabilities[]> {
      const health = await router.listCapabilities();
      const capabilities: ImageProviderCapabilities[] = [];
      for (const item of health) {
        if (item.kind === null) continue;
        capabilities.push({
          available: item.available,
          provider: item.kind,
          requiresUserAction: item.requiresUserAction,
          supportsEdit: item.supportsEdit,
          supportsGeneration: item.supportsGeneration,
          reasons: item.reasons,
        });
      }
      return capabilities;
    },

    async generate(
      request: ImageGenerationRequest,
    ): Promise<{ result: ImageGenerationResult; assets: readonly MediaAssetRecord[] }> {
      // 运行时传图片任务 ID；路由器需要正文任务 ID，并显式复用图片任务。
      const imageTask = options.store.getImageTask(request.taskId);
      const routed = await router.generate({
        operation: request.operation,
        taskId: imageTask?.taskId ?? request.taskId,
        ...(imageTask ? { imageTaskId: imageTask.imageTaskId, draftId: imageTask.draftId } : {}),
        prompt: request.prompt,
        negativePrompt: request.negativePrompt,
        aspectRatio: request.aspectRatio,
        resolution: request.resolution,
        styleProfile: request.styleProfile,
        referenceImages: request.referenceImages,
        privacyLevel: request.privacyLevel,
        maxAttempts: request.maxAttempts,
        targetProvider: request.targetProvider,
        ...(request.signal !== undefined ? { signal: request.signal } : {}),
      });
      const images: ImageGenerationResult['images'] = routed.records.map((record) => {
        const bytes = assetStore.readAssetFile(record);
        return {
          bytes,
          mime: record.mime,
          prompt: record.prompt,
          provider: record.provider,
          model: record.model,
          license: record.license,
          metadata: { assetId: record.assetId, sha256: record.sha256 },
        };
      });
      const result: ImageGenerationResult = {
        provider: routed.provider ?? 'none',
        model: routed.model ?? '',
        status: mapRouteStatus(routed.status),
        images,
        errorCode: routed.errorCode,
        requiresUserAction: routed.requiresUserAction,
        usageMetadata: {
          ...(routed.usageMetadata ?? {}),
          imageTaskId: routed.imageTaskId,
          assetIds: routed.assetIds,
          attempts: routed.attempts,
        },
        message: routed.message,
      };
      return { result, assets: routed.records };
    },

    async importFromPath(input): Promise<{ asset: MediaAssetRecord; duplicate: boolean }> {
      const absolute = resolveImportPath(input.path);
      return assetStore.importFromPath({
        path: absolute,
        declaredMime: input.declaredMime,
        source: input.source,
        license: input.license,
        prompt: input.prompt,
        provider: input.provider,
        model: input.model,
        imageTaskId: input.imageTaskId ?? null,
      });
    },

    async importBytes(input): Promise<{ asset: MediaAssetRecord; duplicate: boolean }> {
      return assetStore.importBytes(input);
    },

    async reviewAsset(assetId, reviewOptions) {
      const review = await reviewer.reviewAsset(assetId, {
        ...(reviewOptions?.declaredMime !== undefined ? { declaredMime: reviewOptions.declaredMime } : {}),
        ...(reviewOptions?.text !== undefined ? { textPresent: reviewOptions.text.trim() !== '' } : {}),
      });
      if (options.config.semanticReviewEnabled && review.passed) {
        const asset = options.store.requireAsset(assetId);
        const semantic = await reviewImageSemantics(options.llm, { bytes: assetStore.readAssetFile(asset),
          mime: asset.mime, text: reviewOptions?.text ?? '', source: asset.source, license: asset.license });
        const flags = [...new Set([...review.flags, ...semantic.flags])];
        const report = { ...review.report, relevantToText: semantic.relevantToText,
          qualityScore: semantic.qualityScore ?? review.report.qualityScore,
          notes: [...review.report.notes.filter((note) => !note.includes('未进行视觉语义理解')), ...semantic.notes.map((note) => `视觉审核：${note}`)], semantic };
        options.store.saveImageReview(assetId, { passed: semantic.passed, flags, report }, new Date().toISOString());
        return { assetId, passed: semantic.passed, flags, notes: report.notes, report };
      }
      return {
        assetId,
        passed: review.passed,
        flags: [...review.flags],
        notes: review.report.notes,
        report: { ...review.report },
      };
    },
  };
}
