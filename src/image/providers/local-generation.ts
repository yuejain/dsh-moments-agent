/**
 * 本地生成 Provider（ComfyUI 兼容）。
 *
 * 安全边界：
 * - 只允许回环地址（默认 http://127.0.0.1:8188，可用 DSH_MOMENTS_COMFYUI_URL 覆盖），
 *   配置层与 Provider 双重校验，避免把请求发往局域网/公网；
 * - 默认不启用：只有 config.images.providers 明确包含 local-generation 时 Router 才会调用；
 * - 生成前先探测 /system_stats 与 /object_info，模型/资源不可用时明确返回 unavailable，
 *   绝不伪造生成成功；
 * - 超时与取消可中止轮询；Provider 只返回字节，落盘由 AssetStore 统一完成。
 */
import type {
  GeneratedImage,
  ImageGenerationRequest,
  ImageGenerationResult,
  ImageProvider,
  ImageProviderCapabilities,
} from '../../adapters/types.js';
import { assertLoopbackHttpUrl } from '../../config.js';
import { isMomentsError } from '../../domain/result.js';
import { detectImageSignature } from '../image-processor.js';

export const LOCAL_GENERATION_NAME = 'local-generation';
const DEFAULT_BASE_URL = 'http://127.0.0.1:8188';
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_REMEMBERED_RESULTS = 50;

export interface ComfyFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type ComfyFetch = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<ComfyFetchResponse>;

export interface LocalGenerationOptions {
  /** 默认取 DSH_MOMENTS_COMFYUI_URL，再回退 http://127.0.0.1:8188。 */
  readonly baseUrl?: string;
  readonly fetch?: ComfyFetch;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
  readonly probeTimeoutMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly maxImageBytes?: number;
  /** 指定 checkpoint 名称；省略时使用 /object_info 中的第一个可用 checkpoint。 */
  readonly checkpoint?: string;
  readonly clientId?: string;
}

interface RequestInitLite {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

type PollOutcome =
  | { readonly kind: 'ready'; readonly images: readonly GeneratedImage[] }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'timeout' };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readEnv(env: Readonly<Record<string, string | undefined>> | undefined, key: string): string | undefined {
  if (env !== undefined) return env[key];
  return process.env[key];
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class LocalGenerationProvider implements ImageProvider {
  readonly id = 'local_generation' as const;
  private readonly baseUrl: string;
  private readonly baseUrlError: string | null;
  private readonly fetchImpl: ComfyFetch | null;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly probeTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxImageBytes: number;
  private readonly requestedCheckpoint: string | undefined;
  private readonly clientId: string;
  private checkpointName = '';
  private readonly results = new Map<string, ImageGenerationResult>();
  private readonly controllers = new Map<string, AbortController>();

  constructor(options: LocalGenerationOptions = {}) {
    const rawBaseUrl = (options.baseUrl ?? readEnv(options.env, 'DSH_MOMENTS_COMFYUI_URL') ?? DEFAULT_BASE_URL).trim();
    let resolvedBaseUrl = rawBaseUrl;
    let baseUrlError: string | null = null;
    if (rawBaseUrl === '') {
      baseUrlError = 'ComfyUI 地址为空';
    } else {
      try {
        resolvedBaseUrl = assertLoopbackHttpUrl(rawBaseUrl, 'images.localGeneration.baseUrl');
      } catch (error) {
        baseUrlError = isMomentsError(error) ? error.message : 'ComfyUI 地址必须是 http 回环地址';
      }
    }
    this.baseUrl = resolvedBaseUrl;
    this.baseUrlError = baseUrlError;
    this.fetchImpl = options.fetch ?? (typeof globalThis.fetch === 'function' ? (globalThis.fetch as unknown as ComfyFetch) : null);
    this.pollIntervalMs = Math.max(50, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    this.timeoutMs = Math.max(1_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.probeTimeoutMs = Math.max(500, options.probeTimeoutMs ?? 5_000);
    this.sleep = options.sleep ?? defaultSleep;
    this.maxImageBytes = options.maxImageBytes ?? 12 * 1024 * 1024;
    this.requestedCheckpoint = options.checkpoint;
    this.clientId = options.clientId ?? 'dsh-moments-agent';
  }

  async checkCapabilities(signal?: AbortSignal): Promise<ImageProviderCapabilities> {
    const unavailable = (reasons: readonly string[]): ImageProviderCapabilities => ({
      available: false,
      provider: this.id,
      requiresUserAction: false,
      supportsEdit: false,
      supportsGeneration: false,
      reasons,
    });
    if (this.baseUrlError !== null) return unavailable([this.baseUrlError]);
    if (this.fetchImpl === null) return unavailable(['当前运行时不支持 fetch，无法连接本机 ComfyUI']);
    try {
      const stats = record(await this.requestJson(`${this.baseUrl}/system_stats`, { method: 'GET' }, this.probeTimeoutMs, signal));
      const ramFree = record(stats?.system)?.ram_free;
      if (typeof ramFree !== 'number' || !Number.isFinite(ramFree) || ramFree < 512 * 1024 * 1024) {
        return unavailable(['ComfyUI 可用内存未知或低于 512 MiB，暂不提交生成']);
      }
      const devices = stats?.devices;
      if (!Array.isArray(devices) || !devices.some((item) => {
        const device = record(item);
        return typeof device?.type === 'string' && device.type.length > 0 &&
          typeof device.vram_total === 'number' && Number.isFinite(device.vram_total) && device.vram_total > 0 &&
          typeof device.vram_free === 'number' && Number.isFinite(device.vram_free) && device.vram_free >= 0;
      })) return unavailable(['ComfyUI 未报告有效 CPU/GPU 设备及显存/内存状态']);
      const objectInfo = await this.requestJson(`${this.baseUrl}/object_info`, { method: 'GET' }, this.probeTimeoutMs, signal);
      const checkpoints = this.extractCheckpoints(objectInfo);
      if (checkpoints.length === 0) {
        return unavailable(['ComfyUI 未暴露可用的 checkpoint 模型（CheckpointLoaderSimple.ckpt_name 为空），无法生成']);
      }
      const chosen = this.requestedCheckpoint ?? checkpoints[0] ?? '';
      if (!checkpoints.includes(chosen)) {
        return unavailable([`ComfyUI 未找到指定 checkpoint：${chosen}；可用模型：${checkpoints.join(', ')}`]);
      }
      const nodes = record(objectInfo);
      const missing = ['CLIPTextEncode', 'EmptyLatentImage', 'KSampler', 'VAEDecode', 'SaveImage']
        .filter((name) => record(nodes?.[name]) === null);
      if (missing.length > 0) return unavailable([`ComfyUI 缺少工作流节点：${missing.join(', ')}`]);
      const queue = record(await this.requestJson(`${this.baseUrl}/queue`, { method: 'GET' }, this.probeTimeoutMs, signal));
      if (!Array.isArray(queue?.queue_running) || !Array.isArray(queue?.queue_pending)) {
        return unavailable(['ComfyUI 任务队列状态未知，暂不提交生成']);
      }
      if (queue.queue_running.length + queue.queue_pending.length >= 8) {
        return unavailable(['ComfyUI 任务队列繁忙（至少 8 项），请稍后重试']);
      }
      this.checkpointName = chosen;
      return {
        available: true,
        provider: this.id,
        requiresUserAction: false,
        supportsEdit: false,
        supportsGeneration: true,
        reasons: [`ComfyUI 就绪（${this.baseUrl}，checkpoint=${chosen}）`],
      };
    } catch (error) {
      const detail = isMomentsError(error) ? error.message : error instanceof Error ? error.message : '未知错误';
      return unavailable([`无法连接本机 ComfyUI（${this.baseUrl}）：${detail}`]);
    }
  }

  async edit(_request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    return this.unavailableResult('当前 ComfyUI 工作流仅支持文生图，编辑请使用人工桥', 'IMAGE_EDIT_UNSUPPORTED');
  }

  async generate(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    if (request.operation === 'edit') return this.edit(request);
    const key = request.taskId;
    if (request.signal?.aborted === true) return this.cancelledResult();
    if (this.controllers.has(key)) {
      return this.failedResult('同一任务已有 ComfyUI 生成在执行中，已拒绝重复提交', 'CONFLICT');
    }
    const controller = new AbortController();
    this.controllers.set(key, controller);
    let abortedByUser = false;
    const onAbort = (): void => {
      abortedByUser = true;
      controller.abort();
    };
    request.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const capabilities = await this.checkCapabilities(controller.signal);
      if (controller.signal.aborted) {
        const result = this.cancelledResult();
        this.remember(key, result);
        return result;
      }
      if (!capabilities.available) {
        const result = this.unavailableResult(capabilities.reasons.join('；'), 'IMAGE_PROVIDER_UNAVAILABLE');
        this.remember(key, result);
        return result;
      }
      const size = this.resolveSize(request.resolution, request.aspectRatio);
      const workflow = this.buildWorkflow(request, size);
      const promptId = await this.submit(workflow, controller.signal);
      if (promptId === null) {
        const result = this.unavailableResult('ComfyUI 拒绝了生成请求：工作流节点或模型不可用', 'COMFYUI_WORKFLOW_REJECTED');
        this.remember(key, result);
        return result;
      }
      const outcome = await this.poll(promptId, request, controller.signal);
      if (outcome.kind === 'cancelled' || abortedByUser) {
        const result = this.cancelledResult();
        this.remember(key, result);
        return result;
      }
      if (outcome.kind === 'timeout') {
        const result = this.failedResult('ComfyUI 生成超时，未获得完整结果（可人工检查队列后重试）', 'COMFYUI_TIMEOUT');
        this.remember(key, result);
        return result;
      }
      if (outcome.images.length === 0) {
        const result = this.failedResult('ComfyUI 返回空结果，未生成任何图片', 'COMFYUI_INVALID_RESPONSE');
        this.remember(key, result);
        return result;
      }
      const result: ImageGenerationResult = {
        provider: LOCAL_GENERATION_NAME,
        model: this.checkpointName,
        status: 'ready',
        images: outcome.images,
        errorCode: null,
        requiresUserAction: false,
        usageMetadata: { promptId, endpoint: this.baseUrl, count: outcome.images.length },
        message: `ComfyUI 已生成 ${outcome.images.length} 张图片`,
      };
      this.remember(key, result);
      return result;
    } catch (error) {
      if (controller.signal.aborted || abortedByUser || (request.signal?.aborted ?? false)) {
        const result = this.cancelledResult();
        this.remember(key, result);
        return result;
      }
      const detail = isMomentsError(error) ? error.message : error instanceof Error ? error.message : '未知错误';
      const result = this.failedResult(`ComfyUI 生成失败：${detail}`, 'IMAGE_PROVIDER_UNAVAILABLE');
      this.remember(key, result);
      return result;
    } finally {
      request.signal?.removeEventListener('abort', onAbort);
      this.controllers.delete(key);
    }
  }

  async getStatus(taskId: string): Promise<ImageGenerationResult | null> {
    return this.results.get(taskId) ?? null;
  }

  async cancel(taskId: string): Promise<boolean> {
    const controller = this.controllers.get(taskId);
    if (controller === undefined) return false;
    controller.abort();
    return true;
  }

  // -------------------------------------------------------------------------
  // 内部实现
  // -------------------------------------------------------------------------

  private buildWorkflow(request: ImageGenerationRequest, size: { width: number; height: number }): Record<string, unknown> {
    const seed = Math.floor(Math.random() * 2 ** 32);
    return {
      '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: this.checkpointName } },
      '2': { class_type: 'CLIPTextEncode', inputs: { text: request.prompt, clip: ['1', 1] } },
      '3': { class_type: 'CLIPTextEncode', inputs: { text: request.negativePrompt, clip: ['1', 1] } },
      '4': { class_type: 'EmptyLatentImage', inputs: { width: size.width, height: size.height, batch_size: 1 } },
      '5': {
        class_type: 'KSampler',
        inputs: {
          seed,
          steps: 20,
          cfg: 7,
          sampler_name: 'euler',
          scheduler: 'normal',
          denoise: 1,
          model: ['1', 0],
          positive: ['2', 0],
          negative: ['3', 0],
          latent_image: ['4', 0],
        },
      },
      '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
      '7': { class_type: 'SaveImage', inputs: { filename_prefix: 'dsh_moments', images: ['6', 0] } },
    };
  }

  private async submit(workflow: Record<string, unknown>, signal: AbortSignal): Promise<string | null> {
    const response = await this.request(
      `${this.baseUrl}/prompt`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: workflow, client_id: this.clientId }),
      },
      this.probeTimeoutMs,
      signal,
    );
    if (!response.ok) return null;
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return null;
    }
    const recordValue = record(payload);
    if (recordValue === null) return null;
    const promptId = recordValue.prompt_id;
    return typeof promptId === 'string' && promptId.length > 0 ? promptId : null;
  }

  private async poll(
    promptId: string,
    request: ImageGenerationRequest,
    signal: AbortSignal,
  ): Promise<PollOutcome> {
    const deadline = Date.now() + this.timeoutMs;
    const historyUrl = `${this.baseUrl}/history/${encodeURIComponent(promptId)}`;
    while (Date.now() < deadline) {
      if (signal.aborted) return { kind: 'cancelled' };
      await this.sleep(this.pollIntervalMs);
      if (signal.aborted) return { kind: 'cancelled' };
      const payload = await this.requestJson(historyUrl, { method: 'GET' }, this.probeTimeoutMs, signal);
      const entry = record(record(payload)?.[promptId]);
      if (entry === null) continue;
      const outputs = record(entry.outputs);
      if (outputs === null) continue;
      const references: { filename: string; subfolder: string; type: string }[] = [];
      for (const nodeValue of Object.values(outputs)) {
        const node = record(nodeValue);
        const images = node?.images;
        if (!Array.isArray(images)) continue;
        for (const imageValue of images) {
          const image = record(imageValue);
          if (image === null) continue;
          const filename = image.filename;
          if (typeof filename !== 'string' || filename.length === 0) continue;
          references.push({
            filename,
            subfolder: typeof image.subfolder === 'string' ? image.subfolder : '',
            type: typeof image.type === 'string' ? image.type : 'output',
          });
        }
      }
      if (references.length === 0) continue;
      const images: GeneratedImage[] = [];
      for (const reference of references) {
        const bytes = await this.downloadImage(reference, signal);
        if (bytes === null) continue;
        const signature = detectImageSignature(bytes);
        images.push({
          bytes,
          mime: signature?.mime ?? 'image/png',
          prompt: request.prompt,
          provider: LOCAL_GENERATION_NAME,
          model: this.checkpointName,
          license: 'generated-local',
          metadata: { promptId, filename: reference.filename, source: 'comfyui' },
        });
      }
      return { kind: 'ready', images };
    }
    return { kind: 'timeout' };
  }

  private async downloadImage(
    reference: { filename: string; subfolder: string; type: string },
    signal: AbortSignal,
  ): Promise<Uint8Array | null> {
    const url =
      `${this.baseUrl}/view?filename=${encodeURIComponent(reference.filename)}` +
      `&subfolder=${encodeURIComponent(reference.subfolder)}&type=${encodeURIComponent(reference.type)}`;
    const response = await this.request(url, { method: 'GET' }, this.probeTimeoutMs, signal);
    if (!response.ok) return null;
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength === 0) return null;
    if (buffer.byteLength > this.maxImageBytes) {
      throw new Error(`ComfyUI 输出图片超过大小上限（${this.maxImageBytes} 字节）`);
    }
    return new Uint8Array(buffer);
  }

  private async requestJson(
    url: string,
    init: RequestInitLite,
    timeoutMs: number,
    externalSignal?: AbortSignal,
  ): Promise<unknown> {
    const response = await this.request(url, init, timeoutMs, externalSignal);
    if (!response.ok) throw new Error(`ComfyUI HTTP ${response.status}`);
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  private async request(
    url: string,
    init: RequestInitLite,
    timeoutMs: number,
    externalSignal?: AbortSignal,
  ): Promise<ComfyFetchResponse> {
    const fetchImpl = this.fetchImpl;
    if (fetchImpl === null) throw new Error('当前运行时不支持 fetch');
    if (externalSignal?.aborted) throw new Error('cancelled');
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    externalSignal?.addEventListener('abort', onAbort, { once: true });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('timeout'));
      }, timeoutMs);
    });
    try {
      const response = await Promise.race([
        fetchImpl(url, { ...init, signal: controller.signal }),
        timeout,
      ]);
      return response;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onAbort);
    }
  }

  private extractCheckpoints(objectInfo: unknown): string[] {
    const nodes = record(objectInfo);
    if (nodes === null) return [];
    const loader = record(nodes['CheckpointLoaderSimple']);
    if (loader === null) return [];
    const input = record(loader.input);
    const required = record(input?.required);
    const ckptName = required?.ckpt_name;
    if (!Array.isArray(ckptName)) return [];
    const options = ckptName[0];
    if (!Array.isArray(options)) return [];
    return options.filter((item): item is string => typeof item === 'string' && item.length > 0);
  }

  private resolveSize(resolution: string, aspectRatio: string): { width: number; height: number } {
    const matched = /^(\d{2,5})\s*[x×]\s*(\d{2,5})$/i.exec(resolution.trim());
    if (matched !== null) {
      return this.clampSize(Number(matched[1]), Number(matched[2]));
    }
    const ratio = /^(\d{1,2}):(\d{1,2})$/.exec(aspectRatio.trim());
    if (ratio !== null) {
      const w = Number(ratio[1]);
      const h = Number(ratio[2]);
      if (w > 0 && h > 0) {
        return w >= h ? this.clampSize(1024, (1024 * h) / w) : this.clampSize((1024 * w) / h, 1024);
      }
    }
    return { width: 1024, height: 1024 };
  }

  private clampSize(width: number, height: number): { width: number; height: number } {
    const align = (value: number): number => Math.min(2048, Math.max(64, Math.round(value / 8) * 8));
    return { width: align(width), height: align(height) };
  }

  private remember(taskId: string, result: ImageGenerationResult): void {
    this.results.set(taskId, result);
    while (this.results.size > MAX_REMEMBERED_RESULTS) {
      const oldest = this.results.keys().next();
      if (oldest.done === true) break;
      this.results.delete(oldest.value);
    }
  }

  private unavailableResult(message: string, errorCode: string): ImageGenerationResult {
    return {
      provider: LOCAL_GENERATION_NAME,
      model: this.checkpointName,
      status: 'unavailable',
      images: [],
      errorCode,
      requiresUserAction: false,
      message,
    };
  }

  private cancelledResult(): ImageGenerationResult {
    return {
      provider: LOCAL_GENERATION_NAME,
      model: this.checkpointName,
      status: 'cancelled',
      images: [],
      errorCode: 'CANCELLED',
      requiresUserAction: false,
      message: 'ComfyUI 生成已取消',
    };
  }

  private failedResult(message: string, errorCode: string): ImageGenerationResult {
    return {
      provider: LOCAL_GENERATION_NAME,
      model: this.checkpointName,
      status: 'failed',
      images: [],
      errorCode,
      requiresUserAction: false,
      message,
    };
  }
}
