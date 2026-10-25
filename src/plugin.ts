/**
 * DSH Cordis 插件入口。
 *
 * 已针对 DSH 0.2.1-rc.2 核实：
 * - 入口形式：export const name / inject / apply(ctx, config)；不使用 default export；
 * - ctx.tools.register(definition)、ctx.tools.guard(fn)、ctx.effect(fn) 均为公开接口；
 * - 通过 cordis.patch.yml 的 `- insert:` 行注册本插件。
 *
 * 插件不在 apply 阶段执行任何外部副作用（不点击、不发微信、不调用付费图像 API）。
 */
import path from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MomentsStore } from './storage/store.js';
import { MomentsRuntime } from './runtime.js';
import { parseConfig, describeConfig, type MomentsConfig } from './config.js';
import { buildTools, type ToolDefinitionLike, type ToolRunContextLike } from './tools/index.js';
import { DshLlmClient, type DshAttachmentService } from './adapters/dsh/llm.js';
import type { LlmClient, LlmRequest, LlmResponse, Logger } from './adapters/types.js';
import { WeChatAgentHttpAdapter } from './adapters/wechatagent/adapter.js';
import {
  CompositeOwnerChannel,
  ManualOwnerChannel,
  WechatOwnerChannel,
} from './approval/owner-channels.js';
import { HttpDesktopExecutor } from './adapters/windows/desktop-client.js';
import { createImageFacade } from './image/index.js';
import { AdminServer } from './admin/server.js';
import { MomentsError } from './domain/result.js';
import { redactSecrets, redactValue } from './security/redaction.js';
import { recoverInterruptedTasks } from './storage/recovery.js';
import { createDedicatedSession, type AgentService, type PresetService } from './adapters/dsh/session.js';

export const name = 'dsh-moments-agent';
export const inject = ['tools'] as const;
export const version: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

/** DSH 传入的最小 Cordis 上下文；只声明实际使用的成员，便于测试替身。 */
export interface PluginContextLike {
  readonly logger?: {
    debug?(message: string, ...args: unknown[]): void;
    info?(message: string, ...args: unknown[]): void;
    warn?(message: string, ...args: unknown[]): void;
    error?(message: string, ...args: unknown[]): void;
  };
  get?(name: string): unknown;
  effect?(execute: () => (() => void) | void, label?: string): () => void;
  tools: {
    register(definition: unknown): () => void;
    guard(guard: (execution: { readonly name: string; readonly agent?: { readonly id?: string } }) => string | undefined): () => void;
  };
  timer?: {
    interval(callback: () => void, delay: number): () => void;
  };
}

interface DshLlmServiceLike {
  stream(options: Record<string, unknown>): AsyncIterable<unknown>;
  listProviders(): readonly { id: string; name: string }[];
  resolveModelInfo?(provider: string, model: string, signal?: AbortSignal): Promise<{ id: string }>;
}

function createLogger(ctx: PluginContextLike): Logger {
  const write = (level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>): void => {
    const safeMessage = redactSecrets(message);
    const safeMeta = meta === undefined ? undefined : (redactValue(meta) as Record<string, unknown>);
    try {
      const fn = ctx.logger?.[level] ?? ctx.logger?.info;
      if (typeof fn === 'function') {
        fn.call(ctx.logger, `[dsh-moments-agent] ${safeMessage}`, safeMeta);
      } else {
        // eslint-disable-next-line no-console
        const consoleFn = level === 'debug' ? console.debug : level === 'error' ? console.error : level === 'warn' ? console.warn : console.info;
        consoleFn(`[dsh-moments-agent] ${safeMessage}`, safeMeta ?? '');
      }
    } catch {
      // 日志失败不能影响业务
    }
  };
  return {
    debug: (message, meta) => write('debug', message, meta),
    info: (message, meta) => write('info', message, meta),
    warn: (message, meta) => write('warn', message, meta),
    error: (message, meta) => write('error', message, meta),
  };
}

class UnavailableLlmClient implements LlmClient {
  async complete(_request: LlmRequest): Promise<LlmResponse> {
    throw new MomentsError('LLM_UNAVAILABLE', 'DSH 未提供 llm 服务，无法生成内容');
  }
  async checkCapabilities() {
    return { status: 'unavailable' as const, message: 'DSH 未提供 llm 服务' };
  }
}

function applyEffect(ctx: PluginContextLike, execute: () => (() => void) | void, label: string): () => void {
  if (typeof ctx.effect === 'function') {
    return ctx.effect(execute, label);
  }
  const dispose = execute();
  return typeof dispose === 'function' ? dispose : () => undefined;
}

function toDshTool(definition: ToolDefinitionLike): Record<string, unknown> {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    output: definition.output,
    ...(definition.timeoutMs === undefined ? {} : { timeoutMs: definition.timeoutMs }),
    execute: (args: unknown, exec: ToolRunContextLike) => definition.execute(args, exec),
  };
}

export async function apply(ctx: PluginContextLike, rawConfig: unknown): Promise<void> {
  const logger = createLogger(ctx);
  let config: MomentsConfig;
  try {
    config = parseConfig(rawConfig);
  } catch (error) {
    logger.error('插件配置无效，拒绝加载', { error: error instanceof Error ? error.message : 'unknown' });
    throw error;
  }
  if (!config.enabled) {
    logger.info('插件已禁用（enabled=false），不注册任何工具');
    return;
  }
  const packageRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..');
  const dataDir = path.isAbsolute(config.dataDir) ? config.dataDir : path.join(packageRoot, config.dataDir);
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(path.join(dataDir, 'imports'), { recursive: true });
  mkdirSync(path.join(dataDir, 'assets'), { recursive: true });

  logger.info('正在启动 DSH Moments Agent', describeConfig(config));
  const store = await MomentsStore.open(path.join(dataDir, 'moments.sqlite'));
  recoverInterruptedTasks(store);
  const cleanup: (() => void)[] = [];
  let dedicated: Awaited<ReturnType<typeof createDedicatedSession>> | null = null;
  const agents = ctx.get?.('agents') as AgentService | undefined;
  const presets = ctx.get?.('agentPresets') as PresetService | undefined;
  let sessionId: string | undefined;

  // LLM（可选依赖：缺失时工具返回 LLM_UNAVAILABLE，而不是整个插件失败）
  const llmService = ctx.get?.('llm') as DshLlmServiceLike | undefined;
  const llm: LlmClient =
    llmService === undefined
      ? new UnavailableLlmClient()
      : new DshLlmClient({
          attachments: ctx.get?.('attachments') as DshAttachmentService | undefined,
          service: llmService as never,
          provider: config.llm.provider,
          model: config.llm.model,
          reasoningEffort: config.llm.reasoningEffort,
          temperature: config.llm.temperature,
          maxTokens: config.llm.maxTokens,
          timeoutMs: config.llm.timeoutMs,
        });

  // WeChatAgent 适配器（默认关闭）
  const wechatAdapter =
    config.wechatAgent.enabled
      ? new WeChatAgentHttpAdapter({ config: config.wechatAgent })
      : null;
  const manualChannel = new ManualOwnerChannel(logger);
  const wechatChannel = wechatAdapter === null ? null : new WechatOwnerChannel(wechatAdapter, logger);
  let ownerChannel;
  if (config.ownerChannel === 'wechat' && wechatChannel !== null) ownerChannel = wechatChannel;
  else if (config.ownerChannel === 'both' && wechatChannel !== null) {
    ownerChannel = new CompositeOwnerChannel([wechatChannel, manualChannel], logger);
  } else ownerChannel = manualChannel;

  const desktop = new HttpDesktopExecutor(config.desktopExecutor);
  const image = createImageFacade({
    llm,
    config: config.images,
    store,
    dataDir,
    packageRoot,
    logger,
  });

  const runtime = new MomentsRuntime({
    config,
    store,
    dataDir,
    packageRoot,
    logger,
    llm,
    ownerChannel,
    wechat: wechatAdapter,
    desktop,
    image,
    version,
    // DSH 0.2.1-rc.3 桌面 Host 注入 DSH_CLIENT_VERSION；旧变量名保留兜底。
    dshVersion:
      process.env.DSH_CLIENT_VERSION ?? process.env.DSH_DESKTOP_VERSION ?? process.env.DSH_VERSION ?? null,
  });

  // 注册工具
  const tools = buildTools(runtime);
  tools.push({
    name: 'moments_health',
    description: '读取 DSH Moments Agent 健康状态（数据库、模型、WeChatAgent、桌面执行器、图像 Provider、发布模式）。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2).slice(0, 8000) }],
    },
    execute: async () => runtime.health(),
  });
  cleanup.push(
    applyEffect(
      ctx,
      () => {
        const disposers: (() => void)[] = [];
        try {
          for (const tool of tools) {
            const secured = { ...tool, execute: async (args: unknown, exec: ToolRunContextLike) => {
              if (!sessionId || exec.agent?.id !== sessionId) {
                return { success: false, errorCode: 'POLICY_DENIED', message: '仅独立朋友圈会话可调用此工具，请使用本机管理页', retryable: false };
              }
              exec.signal?.throwIfAborted();
              return runtime.trackTool(() => tool.execute(args, exec));
            } };
            disposers.push(ctx.tools.register(toDshTool(secured)));
          }
        } catch (error) {
          for (const dispose of disposers.reverse()) dispose();
          runtime.stop();
          store.close();
          awaitDedicatedDispose();
          throw error;
        }
        return () => {
          for (const dispose of disposers) {
            try {
              dispose();
            } catch {
              // 忽略单个工具卸载失败
            }
          }
        };
      },
      'moments-tools',
    ),
  );

  if (agents && presets) {
    try {
      dedicated = await createDedicatedSession(agents, presets, store, dataDir, {
        toolNames: tools.map((tool) => tool.name), persona: () => runtime.persona().soul,
        model: { provider: config.llm.provider, model: config.llm.model },
      });
      sessionId = dedicated.sessionId;
    } catch (error) {
      logger.error('独立会话恢复失败，Agent 工具将拒绝访问；本机管理仍可用', { error: String(error) });
    }
  }

  // 工具守卫：即使模型误调用，也在调度层阻止 Kill Switch / PREPARE_ONLY 下的发表。
  cleanup.push(
    applyEffect(
      ctx,
      () =>
        ctx.tools.guard((execution) => {
          if (sessionId && execution.agent?.id === sessionId && execution.name !== 'run_code' && !execution.name.startsWith('moments_')) {
            return 'POLICY_DENIED：朋友圈会话只允许专用 Moments 工具';
          }
          if (execution.name.startsWith('moments_') && (!sessionId || execution.agent?.id !== sessionId)) {
            return 'POLICY_DENIED：仅独立朋友圈会话可调用此工具';
          }
          if (execution.name === 'moments_publish' || execution.name === 'moments_prepare_desktop') {
            if (runtime.control.killSwitch) return 'KILL_SWITCH_ACTIVE：全局 Kill Switch 已启用，禁止任何外部操作';
            if (runtime.control.paused) return 'PAUSED：系统已暂停';
          }
          if (execution.name === 'moments_publish' && config.publishMode === 'PREPARE_ONLY') {
            return 'PUBLISH_MODE_DISABLED：当前为 PREPARE_ONLY，禁止点击发表';
          }
          return undefined;
        }),
      'moments-tool-guard',
    ),
  );

  runtime.start();
  cleanup.push(() => runtime.stop());

  if (config.adminServer.enabled) {
    try {
      const adminTokenFile =
        config.adminServer.tokenFile === null
          ? path.join(dataDir, 'admin-token.txt')
          : path.isAbsolute(config.adminServer.tokenFile)
            ? config.adminServer.tokenFile
            : path.join(packageRoot, config.adminServer.tokenFile);
      const admin = new AdminServer({
        runtime,
        host: '127.0.0.1',
        port: config.adminServer.port,
        tokenFile: adminTokenFile,
        logger,
      });
      await admin.start();
      cleanup.push(() => admin.stop());
      logger.info('本机管理页已启动', { port: config.adminServer.port });
    } catch (error) {
      logger.error('本机管理页启动失败（不影响 Agent）', {
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

  function awaitDedicatedDispose(): void {
    void dedicated?.dispose().catch((error: unknown) => logger.warn('独立会话关闭失败', { error: String(error) }));
  }
  applyEffect(
    ctx,
    () => async () => {
      runtime.stop();
      await runtime.drain();
      for (const dispose of cleanup.reverse()) {
        try {
          await dispose();
        } catch {
          // 清理失败不能阻止插件卸载
        }
      }
      try { await dedicated?.dispose(); } finally { store.close(); }
      logger.info('DSH Moments Agent 已停止');
    },
    'moments-lifecycle',
  );
}

export { parseConfig };
