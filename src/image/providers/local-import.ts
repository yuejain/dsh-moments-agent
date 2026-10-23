/**
 * 本地导入 Provider（LocalImportProvider）。
 *
 * 适用于三类素材：
 * 1) 用户自己拍摄/绘制的图片（需要用户确认授权）；
 * 2) 用户在官方订阅客户端生成后保存到本机的图片；
 * 3) 已获得明确授权的图库素材（license 字段必须由调用方填写）。
 *
 * 本 Provider 不会读取任意用户路径——实际读取只允许经 AssetStore.importFromPath
 * 访问 dataDir/assets 与 dataDir/imports；这里只返回 `awaiting_user`。
 */
import type {
  ImageGenerationRequest,
  ImageGenerationResult,
  ImageProvider,
  ImageProviderCapabilities,
} from '../../adapters/types.js';

export const LOCAL_IMPORT_NAME = 'local-import';

const IMPORT_INSTRUCTION =
  '请把图片放到 dataDir/imports 目录（或直接上传图片字节），然后调用 moments_import_image 完成导入；' +
  '仅允许导入你本人拍摄、创作或已获得明确授权的图片，不要导入任意他人路径或未授权素材。';
const MAX_REMEMBERED_RESULTS = 100;

export class LocalImportProvider implements ImageProvider {
  readonly id = 'local_import' as const;
  private readonly results = new Map<string, ImageGenerationResult>();

  async checkCapabilities(): Promise<ImageProviderCapabilities> {
    return {
      available: true,
      provider: this.id,
      requiresUserAction: true,
      supportsEdit: false,
      supportsGeneration: false,
      reasons: ['本地导入通道：需要用户提供已授权的本地图片文件'],
    };
  }

  async generate(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    const result: ImageGenerationResult = {
      provider: LOCAL_IMPORT_NAME,
      model: 'local-file',
      status: 'awaiting_user',
      images: [],
      errorCode: null,
      requiresUserAction: true,
      usageMetadata: {
        instruction: IMPORT_INSTRUCTION,
        prompt: request.prompt,
        aspectRatio: request.aspectRatio,
        resolution: request.resolution,
        importTool: 'moments_import_image',
      },
      message: IMPORT_INSTRUCTION,
    };
    this.results.set(request.taskId, result);
    while (this.results.size > MAX_REMEMBERED_RESULTS) {
      const oldest = this.results.keys().next();
      if (oldest.done === true) break;
      this.results.delete(oldest.value);
    }
    return result;
  }

  async getStatus(taskId: string): Promise<ImageGenerationResult | null> {
    return this.results.get(taskId) ?? null;
  }

  async edit(_request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    return { provider: LOCAL_IMPORT_NAME, model: 'local-file', status: 'unavailable', images: [],
      errorCode: 'IMAGE_EDIT_UNSUPPORTED', requiresUserAction: false, message: '本地导入不是图片编辑器，请选择人工编辑桥' };
  }

  async cancel(taskId: string): Promise<boolean> {
    this.results.delete(taskId);
    return false;
  }
}
