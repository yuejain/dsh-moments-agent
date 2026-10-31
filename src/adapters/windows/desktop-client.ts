/**
 * Windows 桌面执行器客户端。
 *
 * 只访问本机回环 HTTP 服务（见 docs/architecture/desktop-executor-protocol.md），
 * 使用专用令牌；令牌只保存在内存/文件中，不进入数据库与日志。
 * 该客户端不包含任何 GUI 操作逻辑；GUI 全部在 desktop/ Python 侧实现。
 */
import { readFile } from 'node:fs/promises';
import { MomentsError } from '../../domain/result.js';
import type { PublishVerification, Visibility } from '../../domain/types.js';
import type {
  DesktopExecutor,
  DesktopHealth,
  DesktopPrepareRequest,
  DesktopPrepareResult,
  DesktopPublishRequest,
  DesktopPublishResult,
  FetchLike,
  WechatClientStatus,
} from '../types.js';
import type { DesktopExecutorConfig } from '../../config.js';

interface RawPrepareResponse extends Partial<DesktopPrepareResult> {
  ok?: boolean;
  errorCode?: string | null;
  message?: string;
}

interface RawPublishResponse extends Partial<DesktopPublishResult> {
  ok?: boolean;
  errorCode?: string | null;
  message?: string;
}

export class HttpDesktopExecutor implements DesktopExecutor {
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly config: DesktopExecutorConfig,
    private readonly env: Readonly<Record<string, string | undefined>> = process.env,
    fetchImpl?: FetchLike,
  ) {
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  private async token(): Promise<string | undefined> {
    const fromEnv = this.env.DSH_MOMENTS_DESKTOP_TOKEN;
    if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv.trim();
    if (this.config.tokenFile === null || this.config.tokenFile === '') return undefined;
    try {
      const value = (await readFile(this.config.tokenFile, 'utf8')).trim();
      return value === '' ? undefined : value;
    } catch {
      return undefined;
    }
  }

  private async call<T>(path: string, init: RequestInit = {}, timeoutMs = this.config.timeoutMs): Promise<T> {
    if (!this.config.enabled) {
      throw new MomentsError('DESKTOP_UNAVAILABLE', '桌面执行器未启用（desktopExecutor.enabled=false）');
    }
    const token = await this.token();
    if (token === undefined) {
      throw new MomentsError('DESKTOP_UNAVAILABLE', '未配置桌面执行器令牌', {
        details: { hint: '设置 DSH_MOMENTS_DESKTOP_TOKEN 或 desktopExecutor.tokenFile' },
      });
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.baseUrl}${path}`, {
        ...init,
        redirect: 'error',
        headers: {
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          'X-Moments-Token': token,
          ...(init.headers ?? {}),
        },
        signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(init.signal ? [init.signal] : [])]),
      });
    } catch (error) {
      throw new MomentsError('DESKTOP_UNAVAILABLE', '桌面执行器不可达', {
        retryable: true,
        cause: error,
        details: { hint: '请启动完整 EXE，并确认插件连接地址、数据目录与内置执行器一致' },
      });
    }
    if (response.status === 401) {
      throw new MomentsError('DESKTOP_UNAVAILABLE', '桌面执行器令牌无效');
    }
    if (!response.ok && response.status !== 404) {
      throw new MomentsError('DESKTOP_UNAVAILABLE', `桌面执行器返回 HTTP ${response.status}`, {
        retryable: response.status >= 500,
      });
    }
    try {
      return (await response.json()) as T;
    } catch (error) {
      throw new MomentsError('DESKTOP_UNAVAILABLE', '桌面执行器返回非 JSON 数据', { cause: error });
    }
  }

  async health(): Promise<DesktopHealth> {
    if (!this.config.enabled) {
      return {
        ok: false,
        version: '',
        wechatInstalled: false,
        wechatVersion: null,
        uiaAvailable: false,
        allowPublish: false,
        mode: 'PREPARE_ONLY',
        message: '插件未启用桌面连接（desktopExecutor.enabled=false）；请在设置 → 桌面执行器连接中启用。EXE 内置服务可能已正常运行，这不是管理员权限错误。',
      };
    }
    try {
      const raw = await this.call<DesktopHealth & { ok?: boolean }>('/health', { method: 'GET' }, 10_000);
      return {
        ok: raw.ok === true,
        version: String(raw.version ?? ''),
        wechatInstalled: raw.wechatInstalled === true,
        wechatVersion: typeof raw.wechatVersion === 'string' ? raw.wechatVersion : null,
        uiaAvailable: raw.uiaAvailable === true,
        allowPublish: raw.allowPublish === true,
        mode: String(raw.mode ?? 'PREPARE_ONLY'),
        message: String(raw.message ?? ''),
        driver: typeof raw.driver === 'string' ? raw.driver : 'uia',
        ocrAvailable: raw.ocrAvailable === true,
        adminPrivilege: raw.adminPrivilege === true,
        geometryRequireAdmin: raw.geometryRequireAdmin === true,
        processDpiAwareness: typeof raw.processDpiAwareness === 'string' ? raw.processDpiAwareness : null,
      };
    } catch (error) {
      return {
        ok: false,
        version: '',
        wechatInstalled: false,
        wechatVersion: null,
        uiaAvailable: false,
        allowPublish: false,
        mode: 'PREPARE_ONLY',
        message: error instanceof Error ? error.message : '桌面执行器健康检查失败',
      };
    }
  }

  async status(): Promise<WechatClientStatus> {
    const raw = await this.call<WechatClientStatus & { ok?: boolean; errorCode?: string }>('/wechat/status', {
      method: 'GET',
    });
    return {
      running: raw.running === true,
      loggedIn: raw.loggedIn === true,
      accountId: typeof raw.accountId === 'string' ? raw.accountId : null,
      version: typeof raw.version === 'string' ? raw.version : null,
      interactive: raw.interactive === true,
      locked: raw.locked === true,
      supported: raw.supported === true,
      windowTitle: typeof raw.windowTitle === 'string' ? raw.windowTitle : null,
      dpiScale: typeof raw.dpiScale === 'number' ? raw.dpiScale : null,
      notes: Array.isArray(raw.notes) ? raw.notes.map(String) : [],
    };
  }

  async prepare(request: DesktopPrepareRequest): Promise<DesktopPrepareResult> {
    const raw = await this.call<RawPrepareResponse>('/moments/prepare', {
      method: 'POST',
      body: JSON.stringify(request),
    });
    if (raw.errorCode !== null && raw.errorCode !== undefined) {
      return {
        ok: false,
        prepared: false,
        screenshotPath: typeof raw.screenshotPath === 'string' ? raw.screenshotPath : null,
        textMatched: false,
        imageCount: typeof raw.imageCount === 'number' ? raw.imageCount : 0,
        warnings: Array.isArray(raw.warnings) ? raw.warnings.map(String) : [],
        errorCode: raw.errorCode,
        message: String(raw.message ?? '准备失败'),
      };
    }
    return {
      ok: raw.ok === true,
      prepared: raw.prepared === true,
      screenshotPath: typeof raw.screenshotPath === 'string' ? raw.screenshotPath : null,
      textMatched: raw.textMatched === true,
      imageCount: typeof raw.imageCount === 'number' ? raw.imageCount : 0,
      warnings: Array.isArray(raw.warnings) ? raw.warnings.map(String) : [],
      errorCode: null,
      message: String(raw.message ?? ''),
    };
  }

  async publish(request: DesktopPublishRequest): Promise<DesktopPublishResult> {
    const raw = await this.call<RawPublishResponse>(
      '/moments/publish',
      { method: 'POST', body: JSON.stringify(request) },
      Math.max(this.config.timeoutMs, 180_000),
    );
    const verification =
      raw.verification !== null && raw.verification !== undefined
        ? (raw.verification as PublishVerification)
        : null;
    return {
      submitted: raw.submitted === true,
      verified: raw.verified === true,
      uncertain: raw.uncertain === true,
      screenshotPath: typeof raw.screenshotPath === 'string' ? raw.screenshotPath : null,
      verification,
      errorCode: typeof raw.errorCode === 'string' ? raw.errorCode : null,
      message: String(raw.message ?? ''),
    };
  }

  async verify(attemptId: string): Promise<PublishVerification> {
    const raw = await this.call<Partial<PublishVerification> & { errorCode?: string; message?: string }>(
      `/moments/verify/${encodeURIComponent(attemptId)}`,
      { method: 'GET' },
    );
    return {
      verified: raw.verified === true,
      method: String(raw.method ?? 'unknown'),
      publishedAt: typeof raw.publishedAt === 'string' ? raw.publishedAt : null,
      visibleText: typeof raw.visibleText === 'string' ? raw.visibleText : null,
      imageCount: typeof raw.imageCount === 'number' ? raw.imageCount : null,
      evidencePath: typeof raw.evidencePath === 'string' ? raw.evidencePath : null,
      notes: Array.isArray(raw.notes) ? raw.notes.map(String) : [],
    };
  }

  async cancel(attemptId: string): Promise<void> {
    await this.call<{ ok?: boolean }>('/moments/cancel', {
      method: 'POST',
      body: JSON.stringify({ attemptId }),
    });
  }
}

/** 可见范围与协议字段的映射（为将来 PARTIAL 扩展保留显式位置）。 */
export function visibilityToDesktop(visibility: Visibility): string {
  return visibility;
}
