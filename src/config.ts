/**
 * 插件配置。
 *
 * 安全原则：
 * - 所有本机 HTTP 适配器只允许 http + 127.0.0.1 / localhost，禁止把令牌发往局域网或公网；
 * - 默认 PREPARE_ONLY、默认不启用调度、默认不启用付费图像 API；
 * - 凭据优先从环境变量或受保护的令牌文件读取，配置对象只保存引用，不写入数据库。
 */
import { MomentsError } from './domain/result.js';
import { PUBLISH_MODES, type PublishMode } from './domain/types.js';

export interface LlmConfig {
  provider: string;
  model: string;
  reasoningEffort: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
}

export interface WeChatAgentConfig {
  enabled: boolean;
  readerBaseUrl: string;
  hookBaseUrl: string;
  readerConfigPath: string | null;
  readerTokenFile: string | null;
  hookTokenFile: string | null;
  account: string;
  ownerWxid: string;
  pollIntervalMs: number;
  requestTimeoutMs: number;
}

export interface DesktopExecutorConfig {
  enabled: boolean;
  baseUrl: string;
  tokenFile: string | null;
  timeoutMs: number;
}

export interface ImagesConfig {
  semanticReviewEnabled: boolean;
  providers: string[];
  officialApiEnabled: boolean;
  allowNetworkSearch: boolean;
  maxFileBytes: number;
  allowedAspectRatios: string[];
  assetDir: string;
}

export interface PolicyConfig {
  dailyLimit: number;
  minIntervalMinutes: number;
  quietHours: readonly [string, string];
  requireApproval: boolean;
  approvalTtlMinutes: number;
  minScoreToPublish: number;
  timeZone: string;
  maxTextLength: number;
  maxImages: number;
}

export interface SchedulerConfig {
  tickSeconds: number;
  ideaProbability: number;
  jitterSeconds: number;
}

export interface AdminServerConfig {
  enabled: boolean;
  port: number;
  tokenFile: string | null;
}

export interface WorkspaceConfig {
  personaFile: string;
  visualStyleFile: string;
}

export interface MomentsConfig {
  enabled: boolean;
  dataDir: string;
  publishMode: PublishMode;
  killSwitch: boolean;
  scheduleEnabled: boolean;
  ownerChannel: 'manual' | 'wechat' | 'both';
  llm: LlmConfig;
  wechatAgent: WeChatAgentConfig;
  desktopExecutor: DesktopExecutorConfig;
  images: ImagesConfig;
  policy: PolicyConfig;
  scheduler: SchedulerConfig;
  adminServer: AdminServerConfig;
  workspace: WorkspaceConfig;
  /** 未识别的配置字段原样保留，便于向前兼容与诊断。 */
  readonly extra: Readonly<Record<string, unknown>>;
}

const DEFAULTS = {
  enabled: true,
  dataDir: 'data',
  publishMode: 'PREPARE_ONLY' as PublishMode,
  killSwitch: false,
  scheduleEnabled: false,
  ownerChannel: 'manual' as const,
  llm: {
    provider: 'deepseek-account',
    model: 'deepseek-flash',
    reasoningEffort: 'high',
    temperature: 0.8,
    maxTokens: 4096,
    timeoutMs: 90_000,
  },
  wechatAgent: {
    enabled: false,
    readerBaseUrl: 'http://127.0.0.1:11231',
    hookBaseUrl: 'http://127.0.0.1:11230',
    readerConfigPath: null,
    readerTokenFile: null,
    hookTokenFile: null,
    account: '',
    ownerWxid: '',
    pollIntervalMs: 15_000,
    requestTimeoutMs: 8_000,
  },
  desktopExecutor: {
    enabled: false,
    baseUrl: 'http://127.0.0.1:18765',
    tokenFile: null,
    timeoutMs: 120_000,
  },
  images: {
    semanticReviewEnabled: false,
    providers: ['manual-subscription', 'local-import'],
    officialApiEnabled: false,
    allowNetworkSearch: false,
    maxFileBytes: 12 * 1024 * 1024,
    allowedAspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16'],
    assetDir: 'assets',
  },
  policy: {
    dailyLimit: 2,
    minIntervalMinutes: 180,
    quietHours: ['23:00', '08:00'] as const,
    requireApproval: true,
    approvalTtlMinutes: 120,
    minScoreToPublish: 0.62,
    timeZone: 'Asia/Shanghai',
    maxTextLength: 2000,
    maxImages: 9,
  },
  scheduler: { tickSeconds: 60, ideaProbability: 0.05, jitterSeconds: 0 },
  adminServer: { enabled: false, port: 18766, tokenFile: null },
  workspace: { personaFile: 'persona/SOUL.md', visualStyleFile: 'persona/VISUAL_STYLE.md' },
};

const KNOWN_KEYS = new Set(Object.keys(DEFAULTS));

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid(`${path} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function invalid(message: string): MomentsError {
  return new MomentsError('INVALID_INPUT', message);
}

function bool(value: unknown, fallback: boolean, path: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw invalid(`${path} 必须是布尔值`);
  return value;
}

function num(value: unknown, fallback: number, path: string, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid(`${path} 必须是数字`);
  if (value < min || value > max) throw invalid(`${path} 必须在 ${min} 到 ${max} 之间`);
  return value;
}

function text(
  value: unknown,
  fallback: string,
  path: string,
  options: { allowEmpty?: boolean; maxLength?: number } = {},
): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw invalid(`${path} 必须是字符串`);
  const trimmed = value.trim();
  if (!options.allowEmpty && trimmed === '') throw invalid(`${path} 不能为空`);
  if (options.maxLength !== undefined && trimmed.length > options.maxLength) {
    throw invalid(`${path} 过长（最多 ${options.maxLength} 字符）`);
  }
  return trimmed;
}

/** 校验本机回环 HTTP 地址，防止 SSRF 与令牌外泄。 */
export function assertLoopbackHttpUrl(value: string, path: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid(`${path} 不是合法 URL`);
  }
  if (url.protocol !== 'http:') throw invalid(`${path} 只允许 http 协议`);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw invalid(`${path} 只允许本机回环地址（127.0.0.1 / localhost）`);
  }
  if (url.username || url.password) throw invalid(`${path} 不允许内嵌用户名或密码`);
  if (url.pathname !== '/' || url.search || url.hash) {
    throw invalid(`${path} 不允许包含路径、查询串或片段`);
  }
  return value.replace(/\/$/, '');
}

function timeOfDay(value: unknown, fallback: string, path: string): string {
  const raw = text(value, fallback, path);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(raw)) throw invalid(`${path} 必须是 HH:mm 格式`);
  return raw;
}

function enumValue<T extends string>(value: unknown, fallback: T, path: string, allowed: readonly T[]): T {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw invalid(`${path} 必须是以下之一：${allowed.join(', ')}`);
  }
  return value as T;
}

/**
 * 把 patch config（未知来源的 JSON）解析成强类型配置。
 * 未识别字段保留在 extra 中，不静默丢弃。
 */
export function parseConfig(raw: unknown): MomentsConfig {
  const root = raw === undefined || raw === null ? {} : asRecord(raw, 'config');
  const llm = asRecord(root.llm ?? {}, 'config.llm');
  const wechat = asRecord(root.wechatAgent ?? {}, 'config.wechatAgent');
  const desktop = asRecord(root.desktopExecutor ?? {}, 'config.desktopExecutor');
  const images = asRecord(root.images ?? {}, 'config.images');
  const policy = asRecord(root.policy ?? {}, 'config.policy');
  const scheduler = asRecord(root.scheduler ?? {}, 'config.scheduler');
  const admin = asRecord(root.adminServer ?? {}, 'config.adminServer');
  const workspace = asRecord(root.workspace ?? {}, 'config.workspace');

  const quietHoursRaw = policy.quietHours;
  let quietHours: readonly [string, string] = DEFAULTS.policy.quietHours;
  if (quietHoursRaw !== undefined) {
    if (!Array.isArray(quietHoursRaw) || quietHoursRaw.length !== 2) {
      throw invalid('config.policy.quietHours 必须是 [开始, 结束] 两个字符串');
    }
    quietHours = [
      timeOfDay(quietHoursRaw[0], '23:00', 'config.policy.quietHours[0]'),
      timeOfDay(quietHoursRaw[1], '08:00', 'config.policy.quietHours[1]'),
    ];
  }

  const providersRaw = images.providers;
  let providers = [...DEFAULTS.images.providers];
  if (providersRaw !== undefined) {
    if (!Array.isArray(providersRaw) || providersRaw.length === 0) {
      throw invalid('config.images.providers 必须是非空数组');
    }
    providers = providersRaw.map((item, index) => {
      if (typeof item !== 'string' || item.trim() === '') {
        throw invalid(`config.images.providers[${index}] 必须是非空字符串`);
      }
      return item.trim();
    });
  }

  const aspectRaw = images.allowedAspectRatios;
  let aspectRatios = [...DEFAULTS.images.allowedAspectRatios];
  if (aspectRaw !== undefined) {
    if (!Array.isArray(aspectRaw) || aspectRaw.length === 0) throw invalid('config.images.allowedAspectRatios 必须是非空数组');
    aspectRatios = aspectRaw.map((item, index) => {
      if (typeof item !== 'string' || !/^\d{1,2}:\d{1,2}$/.test(item)) {
        throw invalid(`config.images.allowedAspectRatios[${index}] 必须是 "宽:高" 格式`);
      }
      return item;
    });
  }

  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(root)) {
    if (!KNOWN_KEYS.has(key)) extra[key] = value;
  }

  const config: MomentsConfig = {
    enabled: bool(root.enabled, DEFAULTS.enabled, 'config.enabled'),
    dataDir: text(root.dataDir, DEFAULTS.dataDir, 'config.dataDir', { maxLength: 260 }),
    publishMode: enumValue(root.publishMode, DEFAULTS.publishMode, 'config.publishMode', PUBLISH_MODES),
    killSwitch: bool(root.killSwitch, DEFAULTS.killSwitch, 'config.killSwitch'),
    scheduleEnabled: bool(root.scheduleEnabled, DEFAULTS.scheduleEnabled, 'config.scheduleEnabled'),
    ownerChannel: enumValue(root.ownerChannel, DEFAULTS.ownerChannel, 'config.ownerChannel', [
      'manual',
      'wechat',
      'both',
    ] as const),
    llm: {
      provider: text(llm.provider, DEFAULTS.llm.provider, 'config.llm.provider', { maxLength: 120 }),
      model: text(llm.model, DEFAULTS.llm.model, 'config.llm.model', { maxLength: 120 }),
      reasoningEffort: text(llm.reasoningEffort, DEFAULTS.llm.reasoningEffort, 'config.llm.reasoningEffort', {
        maxLength: 40,
      }),
      temperature: num(llm.temperature, DEFAULTS.llm.temperature, 'config.llm.temperature', 0, 2),
      maxTokens: num(llm.maxTokens, DEFAULTS.llm.maxTokens, 'config.llm.maxTokens', 256, 32768),
      timeoutMs: num(llm.timeoutMs, DEFAULTS.llm.timeoutMs, 'config.llm.timeoutMs', 5_000, 600_000),
    },
    wechatAgent: {
      enabled: bool(wechat.enabled, DEFAULTS.wechatAgent.enabled, 'config.wechatAgent.enabled'),
      readerBaseUrl: assertLoopbackHttpUrl(
        text(wechat.readerBaseUrl, DEFAULTS.wechatAgent.readerBaseUrl, 'config.wechatAgent.readerBaseUrl'),
        'config.wechatAgent.readerBaseUrl',
      ),
      hookBaseUrl: assertLoopbackHttpUrl(
        text(wechat.hookBaseUrl, DEFAULTS.wechatAgent.hookBaseUrl, 'config.wechatAgent.hookBaseUrl'),
        'config.wechatAgent.hookBaseUrl',
      ),
      readerConfigPath: optionalPath(wechat.readerConfigPath, 'config.wechatAgent.readerConfigPath'),
      readerTokenFile: optionalPath(wechat.readerTokenFile, 'config.wechatAgent.readerTokenFile'),
      hookTokenFile: optionalPath(wechat.hookTokenFile, 'config.wechatAgent.hookTokenFile'),
      account: text(wechat.account, DEFAULTS.wechatAgent.account, 'config.wechatAgent.account', {
        allowEmpty: true,
        maxLength: 200,
      }),
      ownerWxid: text(wechat.ownerWxid, DEFAULTS.wechatAgent.ownerWxid, 'config.wechatAgent.ownerWxid', {
        allowEmpty: true,
        maxLength: 200,
      }),
      pollIntervalMs: num(
        wechat.pollIntervalMs,
        DEFAULTS.wechatAgent.pollIntervalMs,
        'config.wechatAgent.pollIntervalMs',
        5_000,
        300_000,
      ),
      requestTimeoutMs: num(
        wechat.requestTimeoutMs,
        DEFAULTS.wechatAgent.requestTimeoutMs,
        'config.wechatAgent.requestTimeoutMs',
        1_000,
        60_000,
      ),
    },
    desktopExecutor: {
      enabled: bool(desktop.enabled, DEFAULTS.desktopExecutor.enabled, 'config.desktopExecutor.enabled'),
      baseUrl: assertLoopbackHttpUrl(
        text(desktop.baseUrl, DEFAULTS.desktopExecutor.baseUrl, 'config.desktopExecutor.baseUrl'),
        'config.desktopExecutor.baseUrl',
      ),
      tokenFile: optionalPath(desktop.tokenFile, 'config.desktopExecutor.tokenFile'),
      timeoutMs: num(desktop.timeoutMs, DEFAULTS.desktopExecutor.timeoutMs, 'config.desktopExecutor.timeoutMs', 5_000, 600_000),
    },
    images: {
      semanticReviewEnabled: bool(images.semanticReviewEnabled, DEFAULTS.images.semanticReviewEnabled, 'config.images.semanticReviewEnabled'),
      providers,
      officialApiEnabled: bool(images.officialApiEnabled, DEFAULTS.images.officialApiEnabled, 'config.images.officialApiEnabled'),
      allowNetworkSearch: bool(images.allowNetworkSearch, DEFAULTS.images.allowNetworkSearch, 'config.images.allowNetworkSearch'),
      maxFileBytes: num(images.maxFileBytes, DEFAULTS.images.maxFileBytes, 'config.images.maxFileBytes', 1024, 100 * 1024 * 1024),
      allowedAspectRatios: aspectRatios,
      assetDir: text(images.assetDir, DEFAULTS.images.assetDir, 'config.images.assetDir', { maxLength: 260 }),
    },
    policy: {
      dailyLimit: num(policy.dailyLimit, DEFAULTS.policy.dailyLimit, 'config.policy.dailyLimit', 0, 20),
      minIntervalMinutes: num(
        policy.minIntervalMinutes,
        DEFAULTS.policy.minIntervalMinutes,
        'config.policy.minIntervalMinutes',
        0,
        7 * 24 * 60,
      ),
      quietHours,
      requireApproval: bool(policy.requireApproval, DEFAULTS.policy.requireApproval, 'config.policy.requireApproval'),
      approvalTtlMinutes: num(
        policy.approvalTtlMinutes,
        DEFAULTS.policy.approvalTtlMinutes,
        'config.policy.approvalTtlMinutes',
        5,
        7 * 24 * 60,
      ),
      minScoreToPublish: num(
        policy.minScoreToPublish,
        DEFAULTS.policy.minScoreToPublish,
        'config.policy.minScoreToPublish',
        0,
        1,
      ),
      timeZone: text(policy.timeZone, DEFAULTS.policy.timeZone, 'config.policy.timeZone', { maxLength: 80 }),
      maxTextLength: num(policy.maxTextLength, DEFAULTS.policy.maxTextLength, 'config.policy.maxTextLength', 50, 5000),
      maxImages: num(policy.maxImages, DEFAULTS.policy.maxImages, 'config.policy.maxImages', 0, 9),
    },
    scheduler: {
      tickSeconds: num(scheduler.tickSeconds, DEFAULTS.scheduler.tickSeconds, 'config.scheduler.tickSeconds', 15, 3600),
      ideaProbability: num(
        scheduler.ideaProbability,
        DEFAULTS.scheduler.ideaProbability,
        'config.scheduler.ideaProbability',
        0,
        1,
      ),
      jitterSeconds: num(scheduler.jitterSeconds, DEFAULTS.scheduler.jitterSeconds, 'config.scheduler.jitterSeconds', 0, 3600),
    },
    adminServer: {
      enabled: bool(admin.enabled, DEFAULTS.adminServer.enabled, 'config.adminServer.enabled'),
      port: num(admin.port, DEFAULTS.adminServer.port, 'config.adminServer.port', 1024, 65535),
      tokenFile: optionalPath(admin.tokenFile, 'config.adminServer.tokenFile'),
    },
    workspace: {
      personaFile: text(workspace.personaFile, DEFAULTS.workspace.personaFile, 'config.workspace.personaFile', { maxLength: 260 }),
      visualStyleFile: text(
        workspace.visualStyleFile,
        DEFAULTS.workspace.visualStyleFile,
        'config.workspace.visualStyleFile',
        { maxLength: 260 },
      ),
    },
    extra,
  };

  if (config.policy.requireApproval === false && config.publishMode === 'APPROVAL_REQUIRED') {
    throw invalid('config.policy.requireApproval=false 与 publishMode=APPROVAL_REQUIRED 冲突');
  }
  if (config.publishMode === 'POLICY_AUTONOMOUS') {
    // 允许配置，但默认执行器会再次拒绝；此处只做显式提示性校验。
    // 说明：不因为配置里写了 POLICY_AUTONOMOUS 就认为平台规则允许自动发布。
  }

  return config;
}

function optionalPath(value: unknown, path: string): string | null {
  if (value === undefined || value === null) return null;
  const result = text(value, '', path, { allowEmpty: false, maxLength: 1024 });
  return result;
}

/** 日志安全的配置摘要：绝不包含令牌、路径中的用户名等敏感值。 */
export function describeConfig(config: MomentsConfig): Record<string, unknown> {
  return {
    publishMode: config.publishMode,
    scheduleEnabled: config.scheduleEnabled,
    killSwitch: config.killSwitch,
    ownerChannel: config.ownerChannel,
    llm: { provider: config.llm.provider, model: config.llm.model },
    wechatAgent: {
      enabled: config.wechatAgent.enabled,
      readerBaseUrl: config.wechatAgent.readerBaseUrl,
      hookBaseUrl: config.wechatAgent.hookBaseUrl,
      ownerConfigured: config.wechatAgent.ownerWxid !== '',
      accountConfigured: config.wechatAgent.account !== '',
    },
    desktopExecutor: { enabled: config.desktopExecutor.enabled, baseUrl: config.desktopExecutor.baseUrl },
    images: { providers: config.images.providers, officialApiEnabled: config.images.officialApiEnabled },
    policy: {
      dailyLimit: config.policy.dailyLimit,
      minIntervalMinutes: config.policy.minIntervalMinutes,
      quietHours: config.policy.quietHours,
      requireApproval: config.policy.requireApproval,
      approvalTtlMinutes: config.policy.approvalTtlMinutes,
      minScoreToPublish: config.policy.minScoreToPublish,
      timeZone: config.policy.timeZone,
    },
  };
}
