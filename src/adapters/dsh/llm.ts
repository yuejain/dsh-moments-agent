/**
 * DSH LLM 适配器：把插件对文本生成的需求映射到 `ctx.llm.stream()`。
 *
 * 约束：
 * - 只使用已安装 DSH 版本的公开 Service 接口（见 docs/audit/COMPATIBILITY_MATRIX.md）；
 * - 模型能力以实际 resolveModelInfo 结果为准，不根据模型名假设多模态支持；
 * - 超时、取消、provider 错误都转换为可诊断的 MomentsError。
 */
import { MomentsError } from '../../domain/result.js';
import type { AdapterHealth } from '../../domain/types.js';
import type { LlmClient, LlmRequest, LlmResponse } from '../types.js';

/** DSH 流式块的最小结构（与 0.2.1-rc.2 的 StreamChunk 对齐）。 */
type StreamChunk =
  | { type: 'block-start'; index: number; blockType: string }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: string; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: unknown }
  | { type: 'usage'; usage: { inputTokens?: number; outputTokens?: number } }
  | { type: 'finish'; reason: { kind: string; failure?: { message?: string; code?: string } } };

export interface DshImageRef { attachmentId: string; mediaType: string; bytes: number; width: number; height: number }
export interface DshAttachmentService {
  saveImages(inputs: readonly { data: Uint8Array; mediaType: string }[]): Promise<readonly DshImageRef[]>;
}
type ContentPart = { type: 'text'; text: string } | { type: 'image'; attachment: DshImageRef };

export interface DshLlmService {
  stream(options: {
    provider: string;
    model: string;
    reasoningEffort?: string;
    messages: readonly { role: 'user' | 'assistant'; content: readonly ContentPart[] }[];
    system?: string;
    temperature?: number;
    maxTokens?: number;
    signal?: AbortSignal;
  }): AsyncIterable<StreamChunk>;
  listProviders(): readonly { id: string; name: string }[];
  resolveModelInfo?(provider: string, model: string, signal?: AbortSignal): Promise<{ id: string; inputModalities?: readonly string[] }>;
}

export interface DshLlmClientOptions {
  readonly attachments?: DshAttachmentService;
  readonly service: DshLlmService;
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string;
  readonly temperature: number;
  readonly maxTokens: number;
  readonly timeoutMs: number;
}

export class DshLlmClient implements LlmClient {
  constructor(private readonly options: DshLlmClientOptions) {}

  async checkCapabilities(): Promise<AdapterHealth> {
    try {
      const providers = this.options.service.listProviders();
      if (!providers.some((item) => item.id === this.options.provider)) {
        return {
          status: 'unavailable',
          message: `DSH 未注册模型提供方 ${this.options.provider}`,
          details: { providers: providers.map((item) => item.id) },
        };
      }
      if (this.options.service.resolveModelInfo !== undefined) {
        const info = await this.options.service.resolveModelInfo(this.options.provider, this.options.model);
        const modalities = info.inputModalities ?? ['text'];
        return {
          status: 'ok',
          message: `模型可用：${this.options.provider}/${info.id}`,
          details: { inputModalities: modalities },
        };
      }
      return { status: 'degraded', message: '模型可用，但当前 DSH 版本不支持能力探测' };
    } catch (error) {
      return {
        status: 'unavailable',
        message: error instanceof Error ? error.message : '模型能力探测失败',
      };
    }
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const signals: AbortSignal[] = [AbortSignal.timeout(this.options.timeoutMs)];
    if (request.signal !== undefined) signals.push(request.signal);
    const signal = AbortSignal.any(signals);
    const hasImages = request.messages.some((message) => (message.images?.length ?? 0) > 0);
    if (hasImages) {
      const health = await this.checkCapabilities();
      const modalities = health.details?.inputModalities;
      if (health.status !== 'ok' || !Array.isArray(modalities) || !modalities.includes('image') || !this.options.attachments) {
        throw new MomentsError('LLM_UNAVAILABLE', '模型图像输入或 DSH 附件服务不可用');
      }
    }
    const messages = await Promise.all(request.messages
      .filter((message) => message.role !== 'system')
      .map(async (message) => {
        signal.throwIfAborted();
        const content: ContentPart[] = [{ type: 'text', text: message.content }];
        if (message.images?.length) {
          if (message.role !== 'user' || message.images.length > 9) throw new MomentsError('INVALID_INPUT', '图片只能附在用户消息中，最多 9 张');
          const refs = await this.options.attachments!.saveImages(message.images.map((image) => ({ data: image.bytes, mediaType: image.mediaType })));
          if (refs.length !== message.images.length) throw new MomentsError('LLM_UNAVAILABLE', '附件服务返回的图片数不匹配');
          for (const attachment of refs) content.push({ type: 'image', attachment });
        }
        return { role: message.role as 'user' | 'assistant', content };
      }));
    if (messages.length === 0) throw new MomentsError('INVALID_INPUT', 'LLM 请求缺少用户消息');

    let text = '';
    let usage: { inputTokens?: number; outputTokens?: number } | undefined;
    let finishKind: string | null = null;
    let failure: string | null = null;
    try {
      const stream = this.options.service.stream({
        provider: this.options.provider,
        model: this.options.model,
        reasoningEffort: this.options.reasoningEffort,
        messages,
        system: request.system,
        temperature: request.temperature ?? this.options.temperature,
        maxTokens: request.maxTokens ?? this.options.maxTokens,
        signal,
      });
      for await (const chunk of stream) {
        if (chunk.type === 'text-delta') text += chunk.text;
        else if (chunk.type === 'usage') usage = chunk.usage;
        else if (chunk.type === 'finish') {
          finishKind = chunk.reason.kind;
          if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
            failure = chunk.reason.failure?.message ?? chunk.reason.kind;
          }
        }
      }
    } catch (error) {
      if (signal.aborted) {
        throw new MomentsError('LLM_UNAVAILABLE', '模型调用超时或被取消', { retryable: true, cause: error });
      }
      throw new MomentsError('LLM_UNAVAILABLE', error instanceof Error ? error.message : '模型调用失败', {
        retryable: true,
        cause: error,
      });
    }
    if (finishKind === 'error' || finishKind === 'aborted') {
      throw new MomentsError('LLM_UNAVAILABLE', failure ?? '模型调用未正常结束', { retryable: true });
    }
    if (text.trim() === '') {
      throw new MomentsError('LLM_INVALID_OUTPUT', '模型返回空文本', { retryable: true });
    }
    return {
      text,
      provider: this.options.provider,
      model: this.options.model,
      usage,
    };
  }
}
