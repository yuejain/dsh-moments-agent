/**
 * 社区订阅（Codex / 第三方订阅插件）Provider。
 *
 * 当前工程未完成第三方订阅插件的授权及调用路径审计。
 * 抓取 Cookie 或逆向私有端点超出本项目明确允许的范围。
 * 因此本 Provider 永远返回 unavailable + UNSUPPORTED_AUTHORIZATION，
 * 不做任何网络请求、不读取任何凭据。
 */
import type {
  ImageGenerationRequest,
  ImageGenerationResult,
  ImageProvider,
  ImageProviderCapabilities,
} from '../../adapters/types.js';

export const CODEX_SUBSCRIPTION_NAME = 'codex-subscription';

const REASON =
  '当前未验证社区订阅插件的图像能力与授权；本插件禁止抓取 Cookie 或逆向私有端点。' +
  '请改用 ChatGPT Plus / Gemini 官方客户端手动生成后通过 moments_import_image 回传。';

export class CodexSubscriptionProvider implements ImageProvider {
  readonly id = 'codex_subscription' as const;

  async checkCapabilities(): Promise<ImageProviderCapabilities> {
    return {
      available: false,
      provider: this.id,
      requiresUserAction: false,
      supportsEdit: false,
      supportsGeneration: false,
      reasons: [REASON],
    };
  }

  async generate(_request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    return {
      provider: CODEX_SUBSCRIPTION_NAME,
      model: 'unknown',
      status: 'unavailable',
      images: [],
      errorCode: 'UNSUPPORTED_AUTHORIZATION',
      requiresUserAction: false,
      message: REASON,
    };
  }

  async getStatus(_taskId: string): Promise<ImageGenerationResult | null> {
    return null;
  }

  async edit(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    return this.generate(request);
  }

  async cancel(_taskId: string): Promise<boolean> {
    return false;
  }
}
