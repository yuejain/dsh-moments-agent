/**
 * WeChatAgent 适配器：只使用其公开文档化的本机 HTTP 边界。
 *
 * 已验证的公开契约（源码审计见 docs/audit/ARCHITECTURE_REVIEW.md）：
 * - Reader API（Python 本地服务，Bearer token）：
 *   GET /api/v1/reader/status -> { backend, ownWxid, accountDirectory, lastPoll, lastError }
 *   GET /api/v1/messages?talker=<wxid>&limit=N -> { messages: [...] }
 *   GET /api/v1/images/<sha256> -> { imageId, conversationKey, b64, mime, sha256 }
 * - Hook API（原生发送后端，Bearer token + X-WeChatAgent-Account）：
 *   GET  /WeChatAgent/health -> { version, databaseAccounts, ... }
 *   POST /SendTextMsg { wxidorgid, msg } -> { ret: 0 }
 *
 * 不假设存在 sendImage / publishMoments / 朋友圈接口。
 */
import { readFile } from 'node:fs/promises';
import { MomentsError, isMomentsError } from '../../domain/result.js';
import type { AdapterHealth } from '../../domain/types.js';
import type {
  FetchLike,
  OwnerMessage,
  WeChatAgentAdapter,
  WechatChatMessage,
  WechatConversation,
  WechatImagePayload,
  WechatSendResult,
} from '../types.js';
import type { WeChatAgentConfig } from '../../config.js';
import { maskWxid } from '../../security/redaction.js';

export interface WechatAdapterOptions {
  readonly config: WeChatAgentConfig;
  readonly fetchImpl?: FetchLike;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

interface ReaderStatus {
  backend?: string;
  ownWxid?: string;
  accountDirectory?: string;
  lastError?: string;
  lastPoll?: number;
}

interface HookHealth {
  version?: string;
  databaseAccounts?: unknown;
  account?: string;
  accountDirectory?: string;
}

interface RawMessageRow {
  localId?: number | string;
  serverId?: number | string;
  createTime?: number | string;
  isSend?: boolean;
  senderUsername?: string;
  senderDisplay?: string;
  fullText?: string;
  content?: string;
  parsedContent?: string;
  localType?: number;
}

interface RawSessionRow {
  username?: string;
  displayName?: string;
  conversationId?: string;
  type?: number;
}

export class WeChatAgentHttpAdapter implements WeChatAgentAdapter {
  private readonly fetchImpl: FetchLike;
  private readonly env: Readonly<Record<string, string | undefined>>;
  private cachedReaderToken: { value: string; at: number } | null = null;
  private cachedHookToken: { value: string; at: number } | null = null;

  constructor(private readonly options: WechatAdapterOptions) {
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.env = options.env ?? process.env;
  }

  private get config(): WeChatAgentConfig {
    return this.options.config;
  }

  private async readToken(kind: 'reader' | 'hook'): Promise<string | undefined> {
    const envName = kind === 'reader' ? 'DSH_MOMENTS_READER_TOKEN' : 'DSH_MOMENTS_HOOK_TOKEN';
    const fromEnv = this.env[envName];
    if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv.trim();
    const file = kind === 'reader' ? this.config.readerTokenFile : this.config.hookTokenFile;
    if (file === null || file === '') return undefined;
    try {
      const text = (await readFile(file, 'utf8')).trim();
      return text === '' ? undefined : text;
    } catch {
      return undefined;
    }
  }

  /**
   * 读取 WeChatAgent 的 wechat-io-config.json（可选）。
   * 只提取 reader_base_url / reader_token，不把整个文件内容写入日志。
   */
  private async loadReaderConfig(): Promise<{ baseUrl?: string; token?: string }> {
    if (this.config.readerConfigPath === null) return {};
    try {
      const raw = await readFile(this.config.readerConfigPath, 'utf8');
      const parsed = JSON.parse(raw.replace(/^\uFEFF/, '')) as {
        reader_base_url?: unknown;
        reader_token?: unknown;
      };
      return {
        baseUrl: typeof parsed.reader_base_url === 'string' ? parsed.reader_base_url : undefined,
        token: typeof parsed.reader_token === 'string' ? parsed.reader_token : undefined,
      };
    } catch {
      return {};
    }
  }

  private async readerEndpoint(): Promise<{ baseUrl: string; token: string }> {
    const loaded = await this.loadReaderConfig();
    const token = (await this.readToken('reader')) ?? loaded.token;
    const baseUrl = loaded.baseUrl ?? this.config.readerBaseUrl;
    if (token === undefined) {
      throw new MomentsError('WECHAT_UNAVAILABLE', '未配置 Reader token（环境变量或 token 文件）', {
        retryable: false,
      });
    }
    return { baseUrl: baseUrl.replace(/\/$/, ''), token };
  }

  private async hookEndpoint(): Promise<{ baseUrl: string; token: string }> {
    const token = await this.readToken('hook');
    if (token === undefined) {
      throw new MomentsError('WECHAT_UNAVAILABLE', '未配置 Hook token（环境变量或 token 文件）', {
        retryable: false,
      });
    }
    return { baseUrl: this.config.hookBaseUrl.replace(/\/$/, ''), token };
  }

  private async requestJson<T>(url: string, init: RequestInit, timeoutMs: number): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new MomentsError('WECHAT_UNAVAILABLE', 'WeChatAgent 本机接口不可达', {
        retryable: true,
        cause: error,
        details: { hint: '请检查 WeChatAgent 服务是否启动、端口与令牌是否正确' },
      });
    }
    if (!response.ok) {
      throw new MomentsError('WECHAT_UNAVAILABLE', `WeChatAgent 本机接口返回 HTTP ${response.status}`, {
        retryable: response.status >= 500,
        details: { status: response.status },
      });
    }
    try {
      return (await response.json()) as T;
    } catch (error) {
      throw new MomentsError('WECHAT_UNAVAILABLE', 'WeChatAgent 本机接口返回非 JSON 数据', {
        retryable: true,
        cause: error,
      });
    }
  }

  private async readerStatus(): Promise<ReaderStatus> {
    const { baseUrl, token } = await this.readerEndpoint();
    const result = await this.requestJson<ReaderStatus & { success?: boolean }>(
      `${baseUrl}/api/v1/reader/status`,
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      this.config.requestTimeoutMs,
    );
    return result;
  }

  private async hookHealth(): Promise<HookHealth> {
    const { baseUrl, token } = await this.hookEndpoint();
    return this.requestJson<HookHealth>(
      `${baseUrl}/WeChatAgent/health`,
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      this.config.requestTimeoutMs,
    );
  }

  async checkHealth(): Promise<AdapterHealth> {
    if (!this.config.enabled) {
      return { status: 'not_configured', message: 'WeChatAgent 适配器未启用（wechatAgent.enabled=false）' };
    }
    if (this.config.ownerWxid === '') {
      return { status: 'degraded', message: '未配置 ownerWxid，无法绑定审批人' };
    }
    try {
      const reader = await this.readerStatus();
      if (reader.ownWxid === undefined || reader.accountDirectory === undefined) {
        return { status: 'unavailable', message: 'Reader 未返回账号元数据（ownWxid/accountDirectory）' };
      }
      if (this.config.account !== '') {
        const same =
          this.config.account.toLowerCase() === String(reader.accountDirectory).toLowerCase() ||
          this.config.account === reader.ownWxid;
        if (!same) {
          return {
            status: 'unavailable',
            message: '当前 Reader 账号与配置账号不一致',
            details: { expectedConfigured: true },
          };
        }
      }
      let hook: HookHealth;
      try {
        hook = await this.hookHealth();
      } catch (error) {
        return {
          status: 'degraded',
          message: error instanceof Error ? error.message : 'Hook 健康检查失败',
          details: { account: maskWxid(reader.ownWxid) },
        };
      }
      const accounts = Array.isArray(hook.databaseAccounts) ? hook.databaseAccounts.map((item) => String(item).toLowerCase()) : null;
      const accountVerified =
        accounts === null ? false : accounts.includes(String(reader.accountDirectory).toLowerCase());
      return {
        status: accountVerified ? 'ok' : 'degraded',
        message: accountVerified
          ? 'WeChatAgent Reader 与 Hook 账号一致'
          : 'Hook 可用，但无法确认数据库账号与当前登录账号一致',
        details: {
          version: hook.version ?? null,
          account: maskWxid(reader.ownWxid),
          lastError: typeof reader.lastError === 'string' ? reader.lastError : '',
        },
      };
    } catch (error) {
      return {
        status: 'unavailable',
        message: isMomentsError(error) ? error.message : 'WeChatAgent 健康检查失败',
      };
    }
  }

  async getAccount(): Promise<{ accountId: string; ownWxid: string } | null> {
    if (!this.config.enabled) return null;
    try {
      const reader = await this.readerStatus();
      if (reader.ownWxid === undefined || reader.accountDirectory === undefined) return null;
      if (this.config.account !== '') {
        const same =
          this.config.account.toLowerCase() === String(reader.accountDirectory).toLowerCase() ||
          this.config.account === reader.ownWxid;
        if (!same) return null;
      }
      return { accountId: String(reader.accountDirectory).toLowerCase(), ownWxid: reader.ownWxid };
    } catch {
      return null;
    }
  }

  private async assertReadyToSend(): Promise<{ accountId: string; ownWxid: string }> {
    if (!this.config.enabled) {
      throw new MomentsError('WECHAT_UNAVAILABLE', 'WeChatAgent 适配器未启用');
    }
    const health = await this.checkHealth();
    if (health.status !== 'ok') {
      if (health.status === 'degraded') {
        throw new MomentsError('WECHAT_ACCOUNT_NOT_VERIFIED', `发送前账号校验未通过：${health.message}`, {
          retryable: true,
        });
      }
      throw new MomentsError('WECHAT_UNAVAILABLE', health.message, { retryable: true });
    }
    const account = await this.getAccount();
    if (account === null) {
      throw new MomentsError('WECHAT_ACCOUNT_NOT_VERIFIED', '无法确认当前微信账号');
    }
    return account;
  }

  async sendText(text: string, options: { signal?: AbortSignal } = {}): Promise<WechatSendResult> {
    if (text.trim() === '') throw new MomentsError('INVALID_INPUT', '发送内容不能为空');
    if (this.config.ownerWxid === '') {
      throw new MomentsError('WECHAT_ACCOUNT_NOT_VERIFIED', '未配置 ownerWxid，禁止发送');
    }
    const account = await this.assertReadyToSend();
    const { baseUrl, token } = await this.hookEndpoint();
    const started = Date.now();
    let response: Response;
    try {
      response = await this.fetchImpl(`${baseUrl}/SendTextMsg`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-WeChatAgent-Account': account.accountId,
        },
        body: JSON.stringify({ wxidorgid: this.config.ownerWxid, msg: text }),
        redirect: 'error',
        signal: AbortSignal.any([
          AbortSignal.timeout(this.config.requestTimeoutMs * 2),
          ...(options.signal === undefined ? [] : [options.signal]),
        ]),
      });
    } catch (error) {
      throw new MomentsError('WECHAT_UNAVAILABLE', '发送请求失败，未确认是否送达', {
        retryable: true,
        cause: error,
      });
    }
    if (!response.ok) {
      throw new MomentsError('WECHAT_UNAVAILABLE', `发送接口返回 HTTP ${response.status}`, {
        retryable: response.status === 429 || response.status >= 500,
      });
    }
    const body = (await response.json().catch(() => ({}))) as { ret?: number; error?: string };
    if (typeof body.ret === 'number' && body.ret !== 0) {
      throw new MomentsError('WECHAT_UNAVAILABLE', `原生发送被拒绝（ret=${body.ret}）`, { retryable: false });
    }
    return {
      delivered: true,
      messageId: `hook-send-${started}`,
    };
  }

  async listOwnerMessages(limit: number): Promise<OwnerMessage[]> {
    if (!this.config.enabled || this.config.ownerWxid === '') return [];
    const { baseUrl, token } = await this.readerEndpoint();
    const account = await this.getAccount();
    const capped = Math.min(Math.max(limit, 1), 200);
    const payload = await this.requestJson<{ messages?: RawMessageRow[] }>(
      `${baseUrl}/api/v1/messages?talker=${encodeURIComponent(this.config.ownerWxid)}&limit=${capped}`,
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      this.config.requestTimeoutMs,
    );
    const rows = Array.isArray(payload.messages) ? payload.messages : [];
    const accountId = account?.accountId ?? '';
    return rows
      .filter((row) => row.isSend !== true)
      .map((row) => {
        const localId = row.localId === undefined ? '' : String(row.localId);
        const serverId = row.serverId === undefined ? '' : String(row.serverId);
        const receivedAt = Number.isFinite(Number(row.createTime))
          ? new Date(Number(row.createTime) * 1000).toISOString()
          : new Date(0).toISOString();
        return {
          messageId: localId !== '' ? `local:${localId}` : `server:${serverId}`,
          senderWxid: typeof row.senderUsername === 'string' ? row.senderUsername : this.config.ownerWxid,
          accountId,
          text: String(row.fullText ?? row.content ?? row.parsedContent ?? ''),
          receivedAt,
        };
      })
      .filter((message) => message.text.trim() !== '');
  }

  /**
   * 读取白名单内的会话列表（Reader /api/v1/sessions）。
   * 上游只返回“聊天范围”内允许的会话；本方法不做额外放宽。
   */
  async listConversations(limit: number): Promise<WechatConversation[]> {
    if (!this.config.enabled) return [];
    const { baseUrl, token } = await this.readerEndpoint();
    const capped = Math.min(Math.max(limit, 1), 200);
    const payload = await this.requestJson<{ sessions?: RawSessionRow[] }>(
      `${baseUrl}/api/v1/sessions?limit=${capped}`,
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      this.config.requestTimeoutMs,
    );
    const rows = Array.isArray(payload.sessions) ? payload.sessions : [];
    const seen = new Set<string>();
    const conversations: WechatConversation[] = [];
    for (const row of rows) {
      const talker = typeof row.username === 'string' ? row.username : '';
      if (talker === '' || seen.has(talker)) continue;
      // 与所有者自己的单聊不属于“社交观察”范围。
      if (this.config.ownerWxid !== '' && talker === this.config.ownerWxid) continue;
      seen.add(talker);
      conversations.push({
        talker,
        kind: row.type === 1 || talker.includes('@chatroom') ? 'group' : 'private',
        displayName: typeof row.displayName === 'string' ? row.displayName.trim() : '',
      });
      if (conversations.length >= capped) break;
    }
    return conversations;
  }

  /**
   * 读取单个会话的纯文本消息（Reader /api/v1/messages）。
   * 白名单由上游强制；非文本消息（图片/文件/语音/表情）不进入记忆。
   */
  async listConversationMessages(talker: string, limit: number): Promise<WechatChatMessage[]> {
    if (!this.config.enabled || talker === '') return [];
    const { baseUrl, token } = await this.readerEndpoint();
    const capped = Math.min(Math.max(limit, 1), 500);
    const payload = await this.requestJson<{ messages?: RawMessageRow[] }>(
      `${baseUrl}/api/v1/messages?talker=${encodeURIComponent(talker)}&limit=${capped}`,
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      this.config.requestTimeoutMs,
    );
    const rows = Array.isArray(payload.messages) ? payload.messages : [];
    const messages: WechatChatMessage[] = [];
    for (const row of rows) {
      if (row.localType !== 1) continue;
      const text = String(row.fullText ?? row.content ?? row.parsedContent ?? '').trim();
      if (text === '') continue;
      const createTime = Number(row.createTime);
      if (!Number.isFinite(createTime) || createTime <= 0) continue;
      const localId = row.localId === undefined ? '' : String(row.localId);
      const serverId = row.serverId === undefined ? '' : String(row.serverId);
      messages.push({
        talker,
        messageId: `${localId}:${createTime}:${serverId}`,
        sentAt: new Date(createTime * 1000).toISOString(),
        senderWxid: typeof row.senderUsername === 'string' ? row.senderUsername : '',
        senderName: typeof row.senderDisplay === 'string' ? row.senderDisplay.trim() : '',
        text,
        isSelf: row.isSend === true,
      });
    }
    return messages;
  }

  async fetchImage(sha256: string): Promise<WechatImagePayload> {
    if (!/^[a-f0-9]{64}$/i.test(sha256)) {
      throw new MomentsError('IMAGE_INVALID', '图片 ID 必须是 64 位十六进制 SHA-256');
    }
    const { baseUrl, token } = await this.readerEndpoint();
    const payload = await this.requestJson<{ b64?: string; mime?: string; sha256?: string }>(
      `${baseUrl}/api/v1/images/${sha256}`,
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      this.config.requestTimeoutMs,
    );
    if (typeof payload.b64 !== 'string' || typeof payload.mime !== 'string') {
      throw new MomentsError('WECHAT_UNAVAILABLE', 'Reader 未返回图片数据');
    }
    const bytes = Buffer.from(payload.b64, 'base64');
    const actual = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
    if (payload.sha256 !== undefined && payload.sha256.toLowerCase() !== actual) {
      throw new MomentsError('IMAGE_INVALID', '图片内容与声明的 SHA-256 不一致');
    }
    return { sha256: actual, mime: payload.mime, bytes };
  }
}
