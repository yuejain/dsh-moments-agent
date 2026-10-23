/**
 * 图像 Provider 注册表与工厂。
 *
 * 名称映射（config.images.providers 中使用的稳定字符串）：
 * - manual-subscription -> manual_subscription（默认启用，需要用户操作）
 * - local-import        -> local_import（默认启用，需要用户导入）
 * - local-generation    -> local_generation（本机 ComfyUI，默认不启用）
 * - official-api        -> official_api（付费，默认关闭）
 * - codex-subscription  -> codex_subscription（永远不可用）
 */
import type { ImageProvider } from '../../adapters/types.js';
import type { ImagesConfig } from '../../config.js';
import type { ImageProviderKind } from '../../domain/types.js';
import { CodexSubscriptionProvider } from './codex-subscription.js';
import { LocalGenerationProvider, type ComfyFetch } from './local-generation.js';
import { LocalImportProvider } from './local-import.js';
import { ManualSubscriptionBridge } from './manual-subscription.js';
import { OfficialApiImageProvider } from './official-api.js';

export { CodexSubscriptionProvider } from './codex-subscription.js';
export { LocalGenerationProvider, type ComfyFetch, type ComfyFetchResponse, type LocalGenerationOptions } from './local-generation.js';
export { LocalImportProvider } from './local-import.js';
export { ManualSubscriptionBridge } from './manual-subscription.js';
export { OfficialApiImageProvider, type OfficialApiFetch, type OfficialApiOptions } from './official-api.js';

/** 统一 HTTP 注入类型（测试用 Mock，生产用 globalThis.fetch）。 */
export type ImageHttpFetch = ComfyFetch;

export const PROVIDER_NAME_TO_KIND: Readonly<Record<string, ImageProviderKind>> = {
  'manual-subscription': 'manual_subscription',
  'local-import': 'local_import',
  'local-generation': 'local_generation',
  'official-api': 'official_api',
  'codex-subscription': 'codex_subscription',
};

export const PROVIDER_KIND_TO_NAME: Readonly<Record<ImageProviderKind, string>> = {
  manual_subscription: 'manual-subscription',
  local_import: 'local-import',
  local_generation: 'local-generation',
  official_api: 'official-api',
  codex_subscription: 'codex-subscription',
};

/** 解析配置里的 Provider 名称；未知名称返回 null（由 Router 记录并跳过）。 */
export function resolveProviderKind(name: string): ImageProviderKind | null {
  return PROVIDER_NAME_TO_KIND[name.trim().toLowerCase()] ?? null;
}

export interface ImageProviderFactoryDeps {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: ImageHttpFetch;
  readonly sleep?: (ms: number) => Promise<void>;
  /** 官方 API 单次显式预算；未传入则 official-api 永远不可用。 */
  readonly officialMaxUsd?: number;
  readonly officialBudgetUsd?: number;
  readonly localGenerationBaseUrl?: string;
  readonly localGenerationTimeoutMs?: number;
  readonly localGenerationPollIntervalMs?: number;
  readonly localGenerationCheckpoint?: string;
}

/**
 * 构造全部 Provider（按名称索引）。
 * 是否被调用由 ImageRouter 按 config.images.providers 顺序决定，
 * 因此这里注册全量 Provider 不会触发 extra 网络请求。
 */
export function createImageProviders(
  images: ImagesConfig,
  deps: ImageProviderFactoryDeps = {},
): Map<string, ImageProvider> {
  const providers = new Map<string, ImageProvider>();
  providers.set('manual-subscription', new ManualSubscriptionBridge());
  providers.set('local-import', new LocalImportProvider());
  providers.set(
    'local-generation',
    new LocalGenerationProvider({
      baseUrl: deps.localGenerationBaseUrl,
      fetch: deps.fetch,
      env: deps.env,
      sleep: deps.sleep,
      timeoutMs: deps.localGenerationTimeoutMs,
      pollIntervalMs: deps.localGenerationPollIntervalMs,
      checkpoint: deps.localGenerationCheckpoint,
    }),
  );
  providers.set(
    'official-api',
    new OfficialApiImageProvider({
      config: { officialApiEnabled: images.officialApiEnabled },
      env: deps.env,
      fetch: deps.fetch,
      maxUsd: deps.officialMaxUsd,
      budgetUsd: deps.officialBudgetUsd,
    }),
  );
  providers.set('codex-subscription', new CodexSubscriptionProvider());
  return providers;
}
