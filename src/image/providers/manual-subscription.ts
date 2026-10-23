/**
 * 手动订阅桥（ManualSubscriptionBridge）。
 *
 * 现实边界：ChatGPT Plus / Gemini 的订阅额度只允许官方客户端使用，没有对第三方
 * 开放“自动生图”的授权 API。因此本 Provider 永远不自动生图，只把任务置为
 * `awaiting_user`，提示用户在自己的客户端里生成图片后，通过 moments_import_image
 * 把本地文件或字节回传，再由 AssetStore 统一落盘。
 */
import type {
  ImageGenerationRequest,
  ImageGenerationResult,
  ImageProvider,
  ImageProviderCapabilities,
} from '../../adapters/types.js';

export const MANUAL_SUBSCRIPTION_NAME = 'manual-subscription';

const PROMPT_INSTRUCTION =
  '请在你的 ChatGPT Plus / Gemini 客户端中，按提示词生成图片并保存到本机，然后调用 moments_import_image 回传。' +
  '本插件不会自动登录、复用会话或调用订阅账号的生图能力。';
const MAX_REMEMBERED_RESULTS = 100;

export class ManualSubscriptionBridge implements ImageProvider {
  readonly id = 'manual_subscription' as const;
  private readonly results = new Map<string, ImageGenerationResult>();

  async checkCapabilities(): Promise<ImageProviderCapabilities> {
    return {
      available: true,
      provider: this.id,
      requiresUserAction: true,
      supportsEdit: true,
      supportsGeneration: false,
      reasons: ['手动订阅通道：需要用户在官方客户端生成图片后回传，不自动调用订阅生图能力'],
    };
  }

  async generate(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    const result: ImageGenerationResult = {
      provider: MANUAL_SUBSCRIPTION_NAME,
      model: 'user-client',
      status: 'awaiting_user',
      images: [],
      errorCode: null,
      requiresUserAction: true,
      usageMetadata: {
        instruction: PROMPT_INSTRUCTION,
        prompt: request.prompt,
        negativePrompt: request.negativePrompt,
        aspectRatio: request.aspectRatio,
        resolution: request.resolution,
        styleProfile: request.styleProfile,
        importTool: 'moments_import_image',
      },
      message: PROMPT_INSTRUCTION,
    };
    this.remember(request.taskId, result);
    return result;
  }

  async getStatus(taskId: string): Promise<ImageGenerationResult | null> {
    return this.results.get(taskId) ?? null;
  }

  async edit(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    if (request.referenceImages.length === 0) {
      return { provider: MANUAL_SUBSCRIPTION_NAME, model: 'user-client', status: 'failed',
        images: [], errorCode: 'REFERENCE_IMAGE_REQUIRED', requiresUserAction: false,
        message: '编辑图片需要显式选择参考素材' };
    }
    const base = await this.generate(request);
    const result: ImageGenerationResult = { ...base,
      message: '请在图像客户端打开指定参考素材并执行编辑，再将结果放入本任务导入目录。',
      usageMetadata: { ...base.usageMetadata, operation: 'edit', referenceImages: request.referenceImages,
        preserveIdentity: true } };
    this.remember(request.taskId, result);
    return result;
  }

  /** 没有正在执行的自动生成流程，因此没有可取消的任务。 */
  async cancel(taskId: string): Promise<boolean> {
    this.results.delete(taskId);
    return false;
  }

  private remember(taskId: string, result: ImageGenerationResult): void {
    this.results.set(taskId, result);
    while (this.results.size > MAX_REMEMBERED_RESULTS) {
      const oldest = this.results.keys().next();
      if (oldest.done === true) break;
      this.results.delete(oldest.value);
    }
  }
}
