/**
 * 官方付费图像 API Provider。
 *
 * 默认关闭，且默认永远返回 unavailable（OFFICIAL_API_DISABLED）。只有同时满足：
 * 1) config.images.officialApiEnabled === true；
 * 2) 环境变量 DSH_MOMENTS_OFFICIAL_IMAGE_API_KEY 存在；
 * 3) 环境变量 DSH_MOMENTS_IMAGE_BUDGET_USD > 0；
 * 4) 构造时显式传入单次调用预算 maxUsd（且不超过总预算）；
 * 才允许生成。默认不产生任何付费调用，也不会在能力探测阶段访问网络。
 *
 * 说明：单次费用只能估算，`estimatedCostUsd` 仅用于预算守卫，不是账单金额。
 */
import type {
  ImageGenerationRequest,
  ImageGenerationResult,
  ImageProvider,
  ImageProviderCapabilities,
} from '../../adapters/types.js';
import type { ImagesConfig } from '../../config.js';
import { detectImageSignature } from '../image-processor.js';

export const OFFICIAL_API_NAME = 'official-api';

const DEFAULT_ENDPOINT = 'https://api.openai.com/v1/images/generations';
const DEFAULT_MODEL = 'gpt-image-1';
const DEFAULT_ESTIMATED_COST_USD = 0.04;
const MAX_REMEMBERED_RESULTS = 50;

export interface OfficialApiFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export type OfficialApiFetch = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<OfficialApiFetchResponse>;

export interface OfficialApiOptions {
  readonly config: Pick<ImagesConfig, 'officialApiEnabled'>;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: OfficialApiFetch;
  /** 单次调用显式预算（美元）；未显式传入时永不启用。 */
  readonly maxUsd?: number;
  /** 总预算（美元），默认读取 DSH_MOMENTS_IMAGE_BUDGET_USD。 */
  readonly budgetUsd?: number;
  readonly apiBaseUrl?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly estimatedCostPerImageUsd?: number;
  readonly maxImageBytes?: number;
}

interface Availability {
  readonly available: boolean;
  readonly errorCode: string;
  readonly reason: string;
}

function readEnv(env: Readonly<Record<string, string | undefined>> | undefined, key: string): string | undefined {
  if (env !== undefined) return env[key];
  return process.env[key];
}

function readNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export class OfficialApiImageProvider implements ImageProvider {
  readonly id = 'official_api' as const;
  private readonly config: Pick<ImagesConfig, 'officialApiEnabled'>;
  private readonly env: Readonly<Record<string, string | undefined>> | undefined;
  private readonly fetchImpl: OfficialApiFetch | null;
  private readonly maxUsd: number | null;
  private readonly budgetUsd: number | null;
  private readonly apiBaseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly estimatedCostPerImageUsd: number;
  private readonly maxImageBytes: number;
  private readonly results = new Map<string, ImageGenerationResult>();
  private readonly controllers = new Map<string, AbortController>();
  private spentUsd = 0;
  private endpointError: string | null = null;

  constructor(options: OfficialApiOptions) {
    this.config = options.config;
    this.env = options.env;
    this.fetchImpl = options.fetch ?? (typeof globalThis.fetch === 'function' ? (globalThis.fetch as unknown as OfficialApiFetch) : null);
    this.maxUsd = options.maxUsd !== undefined && Number.isFinite(options.maxUsd) ? options.maxUsd : null;
    this.budgetUsd = options.budgetUsd ?? readNumber(readEnv(options.env, 'DSH_MOMENTS_IMAGE_BUDGET_USD'));
    this.apiBaseUrl = options.apiBaseUrl ?? DEFAULT_ENDPOINT;
    this.model = options.model ?? DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.estimatedCostPerImageUsd = options.estimatedCostPerImageUsd ?? DEFAULT_ESTIMATED_COST_USD;
    this.maxImageBytes = options.maxImageBytes ?? 12 * 1024 * 1024;
    this.endpointError = this.validateEndpoint(this.apiBaseUrl);
  }

  private validateEndpoint(endpoint: string): string | null {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      return '官方图像 API 端点不是合法 URL';
    }
    if (url.protocol === 'https:') return null;
    if (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return null;
    return '官方图像 API 端点必须是 https（仅本机回环测试允许 http）';
  }

  private evaluate(): Availability {
    if (this.config.officialApiEnabled !== true) {
      return {
        available: false,
        errorCode: 'OFFICIAL_API_DISABLED',
        reason: '官方付费图像 API 默认关闭（config.images.officialApiEnabled=false），不产生任何付费调用',
      };
    }
    const apiKey = (readEnv(this.env, 'DSH_MOMENTS_OFFICIAL_IMAGE_API_KEY') ?? '').trim();
    if (apiKey === '') {
      return {
        available: false,
        errorCode: 'OFFICIAL_API_KEY_MISSING',
        reason: '未配置 DSH_MOMENTS_OFFICIAL_IMAGE_API_KEY，官方图像 API 不可用',
      };
    }
    if (this.endpointError !== null) {
      return { available: false, errorCode: 'OFFICIAL_API_DISABLED', reason: this.endpointError };
    }
    if (this.budgetUsd === null || this.budgetUsd <= 0) {
      return {
        available: false,
        errorCode: 'OFFICIAL_API_BUDGET_REQUIRED',
        reason: '未配置有效总预算 DSH_MOMENTS_IMAGE_BUDGET_USD（必须 > 0）',
      };
    }
    if (this.maxUsd === null || this.maxUsd <= 0) {
      return {
        available: false,
        errorCode: 'OFFICIAL_API_BUDGET_REQUIRED',
        reason: '官方付费图像 API 需要显式单次预算 maxUsd（> 0），未显式授权时不会调用',
      };
    }
    if (this.maxUsd > this.budgetUsd) {
      return {
        available: false,
        errorCode: 'OFFICIAL_API_BUDGET_REQUIRED',
        reason: `单次预算 maxUsd=${this.maxUsd} 超过总预算 budgetUsd=${this.budgetUsd}`,
      };
    }
    if (this.spentUsd + this.estimatedCostPerImageUsd > this.budgetUsd) {
      return {
        available: false,
        errorCode: 'OFFICIAL_API_BUDGET_EXHAUSTED',
        reason: `总预算已耗尽（已用约 ${round4(this.spentUsd)} 美元，预算 ${this.budgetUsd} 美元）`,
      };
    }
    if (this.fetchImpl === null) {
      return { available: false, errorCode: 'OFFICIAL_API_DISABLED', reason: '当前运行时不支持 fetch' };
    }
    return {
      available: true,
      errorCode: '',
      reason: '官方付费图像 API 已显式启用：调用会产生费用，单次预算与总预算均已校验',
    };
  }

  async checkCapabilities(): Promise<ImageProviderCapabilities> {
    const evaluation = this.evaluate();
    return {
      available: evaluation.available,
      provider: this.id,
      requiresUserAction: false,
      supportsEdit: false,
      supportsGeneration: evaluation.available,
      reasons: [evaluation.reason],
    };
  }

  async edit(_request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    return { provider: 'official-api', model: 'unknown', status: 'unavailable', images: [],
      errorCode: 'IMAGE_EDIT_UNSUPPORTED', requiresUserAction: false, message: '此适配器尚未接入付费编辑接口，不会产生费用' };
  }

  async generate(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    if (request.operation === 'edit') return this.edit(request);
    if (request.signal?.aborted === true) return this.cancelledResult();
    const evaluation = this.evaluate();
    if (!evaluation.available || this.fetchImpl === null) {
      return {
        provider: OFFICIAL_API_NAME,
        model: this.model,
        status: 'unavailable',
        images: [],
        errorCode: evaluation.errorCode,
        requiresUserAction: false,
        message: evaluation.reason,
      };
    }

    const key = request.taskId;
    if (this.controllers.has(key)) {
      return this.failedResult('同一任务已有官方图像 API 调用在执行中，已拒绝重复付费调用', 'CONFLICT');
    }
    const controller = new AbortController();
    this.controllers.set(key, controller);
    const onAbort = (): void => controller.abort();
    request.signal?.addEventListener('abort', onAbort, { once: true });
    let timer: NodeJS.Timeout | undefined;
    try {
      const body = JSON.stringify({
        model: this.model,
        prompt: request.prompt,
        n: 1,
        size: this.resolveSize(request.resolution, request.aspectRatio),
        response_format: 'b64_json',
      });
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('timeout'));
        }, this.timeoutMs);
      });
      const apiKey = (readEnv(this.env, 'DSH_MOMENTS_OFFICIAL_IMAGE_API_KEY') ?? '').trim();
      const response = await Promise.race([
        this.fetchImpl(this.apiBaseUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body,
          signal: controller.signal,
        }),
        timeout,
      ]);
      if (!response.ok) {
        return this.failedResult(`官方图像 API 返回 HTTP ${response.status}，未生成图片`, 'OFFICIAL_API_REQUEST_FAILED');
      }
      const payload = await response.json();
      const base64 = this.extractBase64(payload);
      if (base64 === null) {
        return this.failedResult('官方图像 API 响应缺少 b64_json 图像数据，未产生可核验结果', 'OFFICIAL_API_INVALID_RESPONSE');
      }
      const bytes = Buffer.from(base64, 'base64');
      if (bytes.length === 0) {
        return this.failedResult('官方图像 API 返回了空图片数据', 'OFFICIAL_API_INVALID_RESPONSE');
      }
      if (bytes.length > this.maxImageBytes) {
        return this.failedResult(`官方图像 API 返回图片超过大小上限（${this.maxImageBytes} 字节）`, 'IMAGE_INVALID');
      }
      const signature = detectImageSignature(bytes);
      if (signature === null) {
        return this.failedResult('官方图像 API 返回的数据不是受支持的图像格式', 'OFFICIAL_API_INVALID_RESPONSE');
      }
      this.spentUsd = round4(this.spentUsd + this.estimatedCostPerImageUsd);
      const result: ImageGenerationResult = {
        provider: OFFICIAL_API_NAME,
        model: this.model,
        status: 'ready',
        images: [
          {
            bytes: new Uint8Array(bytes),
            mime: signature.mime,
            prompt: request.prompt,
            provider: OFFICIAL_API_NAME,
            model: this.model,
            license: 'official-api-paid',
            metadata: {
              size: this.resolveSize(request.resolution, request.aspectRatio),
              estimatedCostUsd: this.estimatedCostPerImageUsd,
            },
          },
        ],
        errorCode: null,
        requiresUserAction: false,
        usageMetadata: {
          estimatedCostUsd: this.estimatedCostPerImageUsd,
          spentUsd: this.spentUsd,
          budgetUsd: this.budgetUsd,
          maxUsd: this.maxUsd,
        },
        message: '官方付费图像 API 已生成 1 张图片（费用为估算值，以账单为准）',
      };
      this.remember(key, result);
      return result;
    } catch (error) {
      if (controller.signal.aborted && (request.signal?.aborted ?? false)) return this.cancelledResult();
      const message = error instanceof Error && error.message === 'timeout' ? '官方图像 API 调用超时' : '官方图像 API 请求失败';
      return this.failedResult(`${message}（未产生可核验的成功结果）`, 'OFFICIAL_API_REQUEST_FAILED');
    } finally {
      if (timer !== undefined) clearTimeout(timer);
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
    this.controllers.delete(taskId);
    return true;
  }

  private extractBase64(payload: unknown): string | null {
    if (payload === null || typeof payload !== 'object') return null;
    const data = (payload as Record<string, unknown>).data;
    if (!Array.isArray(data) || data.length === 0) return null;
    const first = data[0];
    if (first === null || typeof first !== 'object') return null;
    const value = (first as Record<string, unknown>).b64_json;
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  private resolveSize(resolution: string, aspectRatio: string): string {
    const matched = /^(\d{2,5})\s*[x×]\s*(\d{2,5})$/i.exec(resolution.trim());
    if (matched !== null) {
      const width = Number(matched[1]);
      const height = Number(matched[2]);
      if (width > 0 && height > 0) return `${width}x${height}`;
    }
    const ratio = /^(\d{1,2}):(\d{1,2})$/.exec(aspectRatio.trim());
    if (ratio !== null) {
      const w = Number(ratio[1]);
      const h = Number(ratio[2]);
      if (w > 0 && h > 0) {
        const align = (value: number): number => Math.max(256, Math.round(value / 8) * 8);
        if (w >= h) return `1024x${align((1024 * h) / w)}`;
        return `${align((1024 * w) / h)}x1024`;
      }
    }
    return '1024x1024';
  }

  private remember(taskId: string, result: ImageGenerationResult): void {
    this.results.set(taskId, result);
    while (this.results.size > MAX_REMEMBERED_RESULTS) {
      const oldest = this.results.keys().next();
      if (oldest.done === true) break;
      this.results.delete(oldest.value);
    }
  }

  private cancelledResult(): ImageGenerationResult {
    return {
      provider: OFFICIAL_API_NAME,
      model: this.model,
      status: 'cancelled',
      images: [],
      errorCode: 'CANCELLED',
      requiresUserAction: false,
      message: '官方图像 API 调用已被取消',
    };
  }

  private failedResult(message: string, errorCode: string): ImageGenerationResult {
    return {
      provider: OFFICIAL_API_NAME,
      model: this.model,
      status: 'failed',
      images: [],
      errorCode,
      requiresUserAction: false,
      message,
    };
  }
}
