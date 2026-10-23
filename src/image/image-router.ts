/**
 * 图像路由（ImageRouter）。
 *
 * 职责：
 * - 按 config.images.providers 顺序解析 Provider 名称、探测能力、选择可用通道；
 * - 生成结果中的字节统一交给 AssetStore 落盘（内容寻址），Router 只返回 assetIds；
 * - `awaiting_user`（手动订阅 / 本地导入）不是失败：创建/更新 image task 为 AWAITING_USER；
 * - 全部通道不可用时返回明确 errorCode（IMAGE_PROVIDER_UNAVAILABLE），并记录每个通道的原因；
 * - 不自动回退到付费或未授权通道：official-api 必须显式配置且显式预算，
 *   codex-subscription 永远不可用。
 */
import type {
  ImageGenerationRequest,
  ImageGenerationResult,
  ImageProvider,
  ImageProviderCapabilities,
} from '../adapters/types.js';
import type { Logger } from '../adapters/types.js';
import type { ImagesConfig } from '../config.js';
import { newId } from '../domain/ids.js';
import { MomentsError, isMomentsError } from '../domain/result.js';
import type { ImageProviderKind, ImageTaskRecord, ImageTaskStatus, MediaAssetRecord } from '../domain/types.js';
import type { MomentsStore } from '../storage/store.js';
import type { AssetStore } from './asset-store.js';
import {
  createImageProviders,
  PROVIDER_NAME_TO_KIND,
  type ImageHttpFetch,
} from './providers/index.js';

export interface ImageRouterOptions {
  readonly store: MomentsStore;
  readonly assetStore: AssetStore;
  readonly images: ImagesConfig;
  /** 可注入的 Provider 集合（测试 / 高级集成）；省略时按工厂创建全量 Provider。 */
  readonly providers?: ReadonlyMap<string, ImageProvider>;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: ImageHttpFetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly officialMaxUsd?: number;
  readonly officialBudgetUsd?: number;
  readonly localGenerationBaseUrl?: string;
  readonly localGenerationTimeoutMs?: number;
  readonly localGenerationPollIntervalMs?: number;
  readonly localGenerationCheckpoint?: string;
  readonly now?: () => Date;
  readonly logger?: Logger;
  /** image task 过期时间（分钟），默认 120。 */
  readonly imageTaskTtlMinutes?: number;
}

export interface ImageRouteRequest {
  readonly operation?: 'generate' | 'edit';
  readonly taskId: string;
  readonly imageTaskId?: string;
  readonly draftId?: string;
  readonly prompt: string;
  readonly negativePrompt?: string;
  readonly aspectRatio?: string;
  readonly resolution?: string;
  readonly styleProfile?: string;
  readonly referenceImages?: readonly string[];
  readonly privacyLevel?: 'public' | 'private';
  readonly maxAttempts?: number;
  /** 官方付费通道必须显式给出单次预算。 */
  readonly maxUsd?: number;
  readonly targetProvider?: ImageProviderKind;
  readonly signal?: AbortSignal;
}

export type ImageRouteStatus = 'ready' | 'awaiting_user' | 'unavailable' | 'failed' | 'cancelled';

export interface ImageRouteAttempt {
  readonly name: string;
  readonly kind: ImageProviderKind | null;
  readonly status: 'skipped' | 'unavailable' | 'awaiting_user' | 'ready' | 'failed' | 'cancelled';
  readonly errorCode: string | null;
  readonly message: string;
}

export interface ImageRouteResult {
  readonly status: ImageRouteStatus;
  readonly taskId: string;
  readonly imageTaskId: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly assetIds: readonly string[];
  readonly records: readonly MediaAssetRecord[];
  readonly requiresUserAction: boolean;
  readonly errorCode: string | null;
  readonly message: string;
  readonly attempts: readonly ImageRouteAttempt[];
  readonly usageMetadata?: Record<string, unknown>;
}

export interface ImageProviderHealth {
  readonly name: string;
  readonly kind: ImageProviderKind | null;
  readonly available: boolean;
  readonly requiresUserAction: boolean;
  readonly supportsGeneration: boolean;
  readonly supportsEdit: boolean;
  readonly reasons: readonly string[];
  readonly error: string | null;
  readonly checkedAt: string;
}

interface UpsertPatch {
  readonly status: ImageTaskStatus;
  readonly requiresUserAction: boolean;
  readonly lastError: string | null;
}

function safeMessage(error: unknown, fallback: string): string {
  if (isMomentsError(error)) return error.message;
  if (error instanceof Error && error.message !== '') return error.message;
  return fallback;
}

export class ImageRouter {
  private readonly store: MomentsStore;
  private readonly assetStore: AssetStore;
  private readonly images: ImagesConfig;
  private readonly providers: ReadonlyMap<string, ImageProvider>;
  private readonly now: () => Date;
  private readonly logger: Logger | undefined;
  private readonly imageTaskTtlMinutes: number;

  constructor(options: ImageRouterOptions) {
    this.store = options.store;
    this.assetStore = options.assetStore;
    this.images = options.images;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger;
    this.imageTaskTtlMinutes = Math.max(5, options.imageTaskTtlMinutes ?? 120);
    this.providers =
      options.providers ??
      createImageProviders(options.images, {
        env: options.env,
        fetch: options.fetch,
        sleep: options.sleep,
        officialMaxUsd: options.officialMaxUsd,
        officialBudgetUsd: options.officialBudgetUsd,
        localGenerationBaseUrl: options.localGenerationBaseUrl,
        localGenerationTimeoutMs: options.localGenerationTimeoutMs,
        localGenerationPollIntervalMs: options.localGenerationPollIntervalMs,
        localGenerationCheckpoint: options.localGenerationCheckpoint,
      });
  }

  /** 供健康检查使用：按配置顺序返回每个通道的能力与原因。 */
  async listCapabilities(): Promise<ImageProviderHealth[]> {
    const health: ImageProviderHealth[] = [];
    const seen = new Set<string>();
    for (const rawName of this.images.providers) {
      const name = rawName.trim();
      if (seen.has(name)) continue;
      seen.add(name);
      const kind = PROVIDER_NAME_TO_KIND[name];
      const provider = this.providers.get(name);
      const checkedAt = this.now().toISOString();
      if (kind === undefined || provider === undefined) {
        health.push({
          name,
          kind: kind ?? null,
          available: false,
          requiresUserAction: false,
          supportsGeneration: false,
          supportsEdit: false,
          reasons: [`未知的图像 Provider 名称：${name}`],
          error: 'UNKNOWN_IMAGE_PROVIDER',
          checkedAt,
        });
        continue;
      }
      try {
        const capabilities = await provider.checkCapabilities();
        health.push({
          name,
          kind,
          available: capabilities.available,
          requiresUserAction: capabilities.requiresUserAction,
          supportsGeneration: capabilities.supportsGeneration,
          supportsEdit: capabilities.supportsEdit,
          reasons: capabilities.reasons,
          error: null,
          checkedAt,
        });
      } catch (error) {
        health.push({
          name,
          kind,
          available: false,
          requiresUserAction: false,
          supportsGeneration: false,
          supportsEdit: false,
          reasons: [safeMessage(error, '能力探测失败')],
          error: 'CAPABILITY_PROBE_FAILED',
          checkedAt,
        });
      }
    }
    return health;
  }

  /** 按配置顺序尝试 Provider；返回落盘后的 assetIds。 */
  async generate(request: ImageRouteRequest): Promise<ImageRouteResult> {
    if (request.operation === 'edit' && !request.referenceImages?.length) throw new MomentsError('INVALID_INPUT', '编辑必须选择参考素材');
    const task = this.store.requireTask(request.taskId);
    if (typeof request.prompt !== 'string' || request.prompt.trim() === '') {
      throw new MomentsError('INVALID_INPUT', '图像提示词不能为空');
    }
    const aspectRatio = (request.aspectRatio ?? '1:1').trim();
    if (!/^\d{1,2}:\d{1,2}$/.test(aspectRatio)) {
      throw new MomentsError('INVALID_INPUT', `宽高比格式非法：${aspectRatio}（应为 "宽:高"）`);
    }
    if (this.images.allowedAspectRatios.length > 0 && !this.images.allowedAspectRatios.includes(aspectRatio)) {
      throw new MomentsError('INVALID_INPUT', `宽高比 ${aspectRatio} 不在允许列表（${this.images.allowedAspectRatios.join(' / ')}）中`);
    }
    const resolution = (request.resolution ?? '1024x1024').trim();
    if (!/^\d{2,5}x\d{2,5}$/.test(resolution)) {
      throw new MomentsError('INVALID_INPUT', `分辨率格式非法：${resolution}（应为 "宽x高"）`);
    }
    const negativePrompt = request.negativePrompt ?? '';
    const styleProfile = request.styleProfile ?? '';
    const referenceImages = request.referenceImages ?? [];
    const privacyLevel = request.privacyLevel ?? 'private';
    const maxAttempts = Math.max(1, Math.min(request.maxAttempts ?? 1, 5));
    const providerKey = request.imageTaskId ?? task.taskId;

    const names = this.configuredNames(request.targetProvider);
    if (names.length === 0) {
      return {
        status: 'unavailable',
        taskId: task.taskId,
        imageTaskId: request.imageTaskId ?? null,
        provider: null,
        model: null,
        assetIds: [],
        records: [],
        requiresUserAction: false,
        errorCode: 'IMAGE_PROVIDER_UNAVAILABLE',
        message: '没有可用的图像 Provider：请检查 config.images.providers 配置',
        attempts: [],
      };
    }

    const attempts: ImageRouteAttempt[] = [];
    let lastMessage = '所有图像 Provider 均不可用';

    for (const name of names) {
      const kind = PROVIDER_NAME_TO_KIND[name];
      if (kind === undefined) {
        attempts.push({ name, kind: null, status: 'skipped', errorCode: 'UNKNOWN_IMAGE_PROVIDER', message: `未知的图像 Provider 名称：${name}` });
        continue;
      }
      const provider = this.providers.get(name);
      if (provider === undefined) {
        attempts.push({ name, kind, status: 'skipped', errorCode: 'UNKNOWN_IMAGE_PROVIDER', message: `Provider 未注册：${name}` });
        continue;
      }
      let capabilities: ImageProviderCapabilities;
      try {
        capabilities = await provider.checkCapabilities();
      } catch (error) {
        const message = safeMessage(error, '能力探测失败');
        attempts.push({ name, kind, status: 'unavailable', errorCode: 'CAPABILITY_PROBE_FAILED', message });
        lastMessage = message;
        continue;
      }
      if (!capabilities.available || (request.operation === 'edit' && !capabilities.supportsEdit)) {
        const message = capabilities.reasons.join('；') || '通道不可用';
        attempts.push({ name, kind, status: 'unavailable', errorCode: 'IMAGE_PROVIDER_UNAVAILABLE', message });
        lastMessage = message;
        continue;
      }
      // 官方付费通道必须显式授权单次预算，绝不自动产生付费调用。
      if (kind === 'official_api' && (request.maxUsd === undefined || !(request.maxUsd > 0))) {
        const message = '官方付费图像通道需要显式 maxUsd 预算，已跳过';
        attempts.push({ name, kind, status: 'unavailable', errorCode: 'OFFICIAL_API_BUDGET_REQUIRED', message });
        lastMessage = message;
        continue;
      }

      const generationRequest: ImageGenerationRequest = {
        operation: request.operation,
        taskId: providerKey,
        prompt: request.prompt,
        negativePrompt,
        aspectRatio,
        resolution,
        referenceImages,
        styleProfile,
        privacyLevel,
        targetProvider: kind,
        maxAttempts,
        ...(request.signal !== undefined ? { signal: request.signal } : {}),
      };
      let result: ImageGenerationResult;
      try {
        result = request.operation === 'edit' ? await provider.edit(generationRequest) : await provider.generate(generationRequest);
      } catch (error) {
        const message = safeMessage(error, '生成调用失败');
        attempts.push({ name, kind, status: 'failed', errorCode: 'IMAGE_PROVIDER_UNAVAILABLE', message });
        lastMessage = message;
        continue;
      }

      if (result.status === 'ready') {
        if (result.images.length === 0) {
          const message = result.message || 'Provider 声称成功但没有返回图片字节，已拒绝伪造成功';
          attempts.push({ name, kind, status: 'failed', errorCode: 'IMAGE_INVALID', message });
          lastMessage = message;
          continue;
        }
        const imported: MediaAssetRecord[] = [];
        let duplicates = 0;
        let importError: string | null = null;
        for (const image of result.images) {
          try {
            const outcome = await this.assetStore.importBytes({
              bytes: image.bytes,
              declaredMime: image.mime,
              source: kind,
              license: image.license,
              prompt: image.prompt || request.prompt,
              provider: image.provider || name,
              model: image.model || result.model,
              imageTaskId: request.imageTaskId ?? null,
            });
            if (outcome.duplicate) duplicates += 1;
            if (!imported.some((item) => item.assetId === outcome.asset.assetId)) imported.push(outcome.asset);
          } catch (error) {
            importError = safeMessage(error, '生成图片落盘失败');
            break;
          }
        }
        if (importError !== null || imported.length === 0) {
          const message = importError ?? 'Provider 返回的图片全部无法落盘';
          attempts.push({ name, kind, status: 'failed', errorCode: 'IMAGE_INVALID', message });
          lastMessage = message;
          continue;
        }
        const imageTask = this.upsertImageTask(request, task.taskId, kind, {
          status: 'READY',
          requiresUserAction: false,
          lastError: null,
        });
        attempts.push({ name, kind, status: 'ready', errorCode: null, message: result.message });
        this.logger?.info('图像生成完成并已落盘', {
          taskId: task.taskId,
          imageTaskId: imageTask?.imageTaskId ?? null,
          provider: name,
          assetCount: imported.length,
          duplicateCount: duplicates,
        });
        return {
          status: 'ready',
          taskId: task.taskId,
          imageTaskId: imageTask?.imageTaskId ?? request.imageTaskId ?? null,
          provider: name,
          model: result.model,
          assetIds: imported.map((item) => item.assetId),
          records: imported,
          requiresUserAction: false,
          errorCode: null,
          message: duplicates > 0 ? `${result.message}（${duplicates} 张为重复素材，已复用）` : result.message,
          attempts,
          ...(result.usageMetadata !== undefined ? { usageMetadata: result.usageMetadata } : {}),
        };
      }

      if (result.status === 'awaiting_user') {
        const imageTask = this.upsertImageTask(request, task.taskId, kind, {
          status: 'AWAITING_USER',
          requiresUserAction: true,
          lastError: null,
        });
        attempts.push({ name, kind, status: 'awaiting_user', errorCode: null, message: result.message });
        this.logger?.info('图像任务等待用户操作', {
          taskId: task.taskId,
          imageTaskId: imageTask?.imageTaskId ?? null,
          provider: name,
        });
        return {
          status: 'awaiting_user',
          taskId: task.taskId,
          imageTaskId: imageTask?.imageTaskId ?? request.imageTaskId ?? null,
          provider: name,
          model: result.model,
          assetIds: [],
          records: [],
          requiresUserAction: true,
          errorCode: null,
          message: result.message,
          attempts,
          ...(result.usageMetadata !== undefined ? { usageMetadata: result.usageMetadata } : {}),
        };
      }

      if (result.status === 'cancelled') {
        if (request.imageTaskId !== undefined) {
          this.upsertImageTask(request, task.taskId, kind, {
            status: 'CANCELLED',
            requiresUserAction: false,
            lastError: null,
          });
        }
        attempts.push({ name, kind, status: 'cancelled', errorCode: result.errorCode ?? 'CANCELLED', message: result.message });
        return {
          status: 'cancelled',
          taskId: task.taskId,
          imageTaskId: request.imageTaskId ?? null,
          provider: name,
          model: result.model,
          assetIds: [],
          records: [],
          requiresUserAction: false,
          errorCode: result.errorCode ?? 'CANCELLED',
          message: result.message,
          attempts,
        };
      }

      // unavailable / failed：记录原因并按配置顺序回退到下一个通道。
      const attemptStatus = result.status;
      attempts.push({ name, kind, status: attemptStatus, errorCode: result.errorCode, message: result.message });
      lastMessage = result.message;
    }

    if (request.imageTaskId !== undefined) {
      this.upsertImageTask(request, task.taskId, this.fallbackKind(names), {
        status: 'FAILED',
        requiresUserAction: false,
        lastError: lastMessage,
      });
    }
    return {
      status: 'unavailable',
      taskId: task.taskId,
      imageTaskId: request.imageTaskId ?? null,
      provider: null,
      model: null,
      assetIds: [],
      records: [],
      requiresUserAction: false,
      errorCode: 'IMAGE_PROVIDER_UNAVAILABLE',
      message: `所有图像 Provider 均不可用：${lastMessage}`,
      attempts,
    };
  }

  /** 查询某个 image task / moment task 的生成状态。 */
  async getStatus(taskId: string): Promise<ImageGenerationResult | null> {
    for (const name of this.routingNames()) {
      const provider = this.providers.get(name);
      if (provider === undefined) continue;
      try {
        const status = await provider.getStatus(taskId);
        if (status !== null) return status;
      } catch {
        // 单通道状态查询失败不影响其他通道
      }
    }
    return null;
  }

  /** 取消进行中的生成；返回是否有通道接受了取消。 */
  async cancel(taskId: string): Promise<boolean> {
    let cancelled = false;
    for (const name of this.routingNames()) {
      const provider = this.providers.get(name);
      if (provider === undefined) continue;
      try {
        if (await provider.cancel(taskId)) cancelled = true;
      } catch {
        // 忽略单通道取消失败
      }
    }
    const imageTask = this.store.getImageTask(taskId);
    if (imageTask !== undefined && (imageTask.status === 'PENDING' || imageTask.status === 'GENERATING' || imageTask.status === 'AWAITING_USER')) {
      this.store.updateImageTask(taskId, {
        status: 'CANCELLED',
        requiresUserAction: false,
        lastError: null,
        updatedAt: this.now().toISOString(),
      });
      cancelled = true;
    }
    return cancelled;
  }

  // -------------------------------------------------------------------------
  // 内部实现
  // -------------------------------------------------------------------------

  private routingNames(): string[] {
    const out: string[] = [];
    for (const raw of this.images.providers) {
      const name = raw.trim();
      if (name !== '' && !out.includes(name)) out.push(name);
    }
    return out;
  }

  private configuredNames(target?: ImageProviderKind): string[] {
    const names = this.routingNames();
    if (target === undefined) return names;
    return names.filter((name) => PROVIDER_NAME_TO_KIND[name] === target);
  }

  private fallbackKind(names: readonly string[]): ImageProviderKind {
    for (const name of names) {
      const kind = PROVIDER_NAME_TO_KIND[name];
      if (kind !== undefined) return kind;
    }
    return 'manual_subscription';
  }

  private resolveDraftId(request: ImageRouteRequest, taskId: string): string {
    if (request.draftId !== undefined && request.draftId !== '') return request.draftId;
    const draft = this.store.getCurrentDraftForTask(taskId);
    if (draft !== undefined) return draft.draftId;
    const task = this.store.requireTask(taskId);
    if (task.draftId !== null && task.draftId !== '') return task.draftId;
    throw new MomentsError('NOT_FOUND', `任务 ${taskId} 没有当前草稿，无法创建图片任务`);
  }

  private upsertImageTask(
    request: ImageRouteRequest,
    taskId: string,
    kind: ImageProviderKind,
    patch: UpsertPatch,
  ): ImageTaskRecord | null {
    const updatedAt = this.now().toISOString();
    if (request.imageTaskId !== undefined) {
      const existing = this.store.requireImageTask(request.imageTaskId);
      if (existing.taskId !== taskId) {
        throw new MomentsError('CONFLICT', `图片任务 ${existing.imageTaskId} 不属于任务 ${taskId}`);
      }
      return this.store.updateImageTask(existing.imageTaskId, {
        status: patch.status,
        requiresUserAction: patch.requiresUserAction,
        lastError: patch.lastError,
        attempts: existing.attempts + 1,
        updatedAt,
      });
    }
    const draftId = this.resolveDraftId(request, taskId);
    const now = this.now();
    const record: ImageTaskRecord = {
      imageTaskId: newId('imgtask'),
      draftId,
      taskId,
      prompt: request.prompt,
      negativePrompt: request.negativePrompt ?? '',
      aspectRatio: (request.aspectRatio ?? '1:1').trim(),
      resolution: (request.resolution ?? '1024x1024').trim(),
      styleProfile: request.styleProfile ?? '',
      provider: kind,
      status: patch.status,
      requiresUserAction: patch.requiresUserAction,
      attempts: 1,
      lastError: patch.lastError,
      createdAt: now.toISOString(),
      updatedAt,
      expiresAt: new Date(now.getTime() + this.imageTaskTtlMinutes * 60_000).toISOString(),
    };
    this.store.insertImageTask(record);
    return record;
  }
}
