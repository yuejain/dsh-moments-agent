/**
 * 审批通道实现。
 *
 * - wechat_owner：通过 WeChatAgent 给已验证的所有者发送审批请求，并轮询所有者命令；
 * - manual_admin：不主动发微信，审批通过本机管理页（127.0.0.1 + 专用令牌）完成；
 * - composite：同时启用两者，任一通道都不能绕过审批绑定。
 *
 * 所有通道都不允许使用昵称/显示名作为身份依据；唯一身份是已校验的 ownerWxid + 账号。
 */
import { MomentsError } from '../domain/result.js';
import type { AdapterHealth, ApprovalRequestView } from '../domain/types.js';
import type { Logger, OwnerChannel, OwnerMessage, WeChatAgentAdapter, WechatSendResult } from '../adapters/types.js';

export function formatApprovalMessage(request: ApprovalRequestView, excerpt: string): string {
  return [
    '【朋友圈待审批】',
    `任务：${request.taskId}`,
    `审批：${request.approvalId}`,
    `内容：${excerpt}`,
    `可见范围：${request.visibility}`,
    `过期时间：${request.expiresAt}`,
    `内容指纹：${request.contentHash.slice(0, 16)}…`,
    '',
    '回复命令：',
    `/moments approve ${request.approvalId}`,
    `/moments reject ${request.approvalId}`,
    '/moments status',
  ].join('\n');
}

export class WechatOwnerChannel implements OwnerChannel {
  readonly name = 'wechat_owner';

  constructor(
    private readonly adapter: WeChatAgentAdapter,
    private readonly logger: Logger,
  ) {}

  async checkHealth(): Promise<AdapterHealth> {
    return this.adapter.checkHealth();
  }

  async sendApprovalRequest(request: ApprovalRequestView): Promise<{ delivered: boolean; messageId?: string }> {
    const text = formatApprovalMessage(request, '（正文请用 /moments preview 查看，避免在通知中携带隐私内容）');
    try {
      const result = await this.adapter.sendText(text);
      return { delivered: result.delivered, messageId: result.messageId };
    } catch (error) {
      this.logger.warn('审批通知发送失败，审批仍可在管理页完成', {
        error: error instanceof Error ? error.message : 'unknown',
        taskId: request.taskId,
      });
      return { delivered: false };
    }
  }

  async sendText(text: string): Promise<WechatSendResult> {
    return this.adapter.sendText(text);
  }

  async listOwnerMessages(limit: number): Promise<OwnerMessage[]> {
    return this.adapter.listOwnerMessages(limit);
  }

  async currentAccountId(): Promise<string | null> {
    const account = await this.adapter.getAccount();
    return account?.accountId ?? null;
  }
}

/**
 * 本机手动审批通道：不主动发消息，不伪装成微信。
 * 审批只能由持有管理令牌的本机用户完成（见 src/admin/server.ts）。
 */
export class ManualOwnerChannel implements OwnerChannel {
  readonly name = 'manual_admin';
  private readonly inbox: OwnerMessage[] = [];

  constructor(private readonly logger: Logger) {}

  async checkHealth(): Promise<AdapterHealth> {
    return { status: 'ok', message: '手动审批通道可用（本机管理页）' };
  }

  async sendApprovalRequest(request: ApprovalRequestView): Promise<{ delivered: boolean; messageId?: string }> {
    this.logger.info('已创建手动审批请求，等待本机所有者确认', {
      taskId: request.taskId,
      approvalId: request.approvalId,
    });
    return { delivered: false };
  }

  async sendText(text: string): Promise<WechatSendResult> {
    // 手动通道刻意不向微信发送任何内容。
    this.logger.info('手动通道未发送微信消息', { length: text.length });
    return { delivered: false };
  }

  async listOwnerMessages(): Promise<OwnerMessage[]> {
    return this.inbox.splice(0, this.inbox.length);
  }

  async currentAccountId(): Promise<string | null> {
    return null;
  }

  /** 仅供测试/管理页注入“所有者命令”；不会绕过哈希与过期校验。 */
  injectCommand(message: OwnerMessage): void {
    this.inbox.push(message);
  }
}

export class CompositeOwnerChannel implements OwnerChannel {
  readonly name = 'composite';

  constructor(
    private readonly channels: readonly OwnerChannel[],
    private readonly logger: Logger,
  ) {}

  async checkHealth(): Promise<AdapterHealth> {
    const results = await Promise.all(this.channels.map((channel) => channel.checkHealth()));
    const ok = results.filter((item) => item.status === 'ok').length;
    return {
      status: ok > 0 ? 'ok' : results.some((item) => item.status === 'degraded') ? 'degraded' : 'unavailable',
      message: `可用审批通道：${ok}/${results.length}`,
      details: { channels: results.map((item) => item.status) },
    };
  }

  async sendApprovalRequest(request: ApprovalRequestView): Promise<{ delivered: boolean; messageId?: string }> {
    let delivered = false;
    let messageId: string | undefined;
    for (const channel of this.channels) {
      try {
        const result = await channel.sendApprovalRequest(request);
        delivered = delivered || result.delivered;
        messageId ??= result.messageId;
      } catch (error) {
        this.logger.warn('审批通道发送失败', {
          channel: channel.name,
          error: error instanceof Error ? error.message : 'unknown',
        });
      }
    }
    return { delivered, messageId };
  }

  async sendText(text: string): Promise<WechatSendResult> {
    let result: WechatSendResult = { delivered: false };
    for (const channel of this.channels) {
      try {
        const current = await channel.sendText(text);
        result = current.delivered ? current : result;
      } catch {
        // 单个通道失败不影响其他通道
      }
    }
    return result;
  }

  async listOwnerMessages(limit: number): Promise<OwnerMessage[]> {
    const all: OwnerMessage[] = [];
    for (const channel of this.channels) {
      try {
        all.push(...(await channel.listOwnerMessages(limit)));
      } catch (error) {
        this.logger.warn('审批通道轮询失败', {
          channel: channel.name,
          error: error instanceof Error ? error.message : 'unknown',
        });
      }
    }
    return all;
  }

  async currentAccountId(): Promise<string | null> {
    for (const channel of this.channels) {
      const account = await channel.currentAccountId();
      if (account !== null) return account;
    }
    return null;
  }
}

/** 解析 `/moments <command> [args...]`，只接受固定命令集合。 */
export function parseOwnerCommand(raw: string): { command: string; args: string[] } | null {
  const trimmed = raw.trim();
  const match = /^\/moments(?:\s+|$)([\s\S]*)$/i.exec(trimmed);
  if (match === null) return null;
  const rest = (match[1] ?? '').trim();
  if (rest === '') return { command: 'help', args: [] };
  const parts = rest.split(/\s+/);
  const command = (parts.shift() ?? '').toLowerCase();
  const allowed = new Set([
    'status',
    'draft',
    'preview',
    'approve',
    'reject',
    'history',
    'pause',
    'resume',
    'image',
    'cancel',
    'help',
  ]);
  if (!allowed.has(command)) return { command: 'unknown', args: parts };
  return { command, args: parts.map((item) => item.trim()).filter((item) => item !== '') };
}

export function assertOwnerIdentity(
  message: OwnerMessage,
  expected: { ownerWxid: string; accountId: string | null },
  logger: Logger,
): void {
  if (expected.ownerWxid === '') {
    throw new MomentsError('WECHAT_ACCOUNT_NOT_VERIFIED', '未配置所有者 wxid，拒绝执行命令');
  }
  if (!expected.accountId || !message.accountId || message.isGroup === true || expected.ownerWxid.endsWith('@chatroom')) {
    throw new MomentsError('WECHAT_ACCOUNT_NOT_VERIFIED', '账号未验证或消息来自群聊，拒绝执行命令');
  }
  if (message.senderWxid !== expected.ownerWxid) {
    logger.warn('拒绝非所有者命令', { sender: message.senderWxid === '' ? '' : `${message.senderWxid.slice(0, 8)}***` });
    throw new MomentsError('POLICY_DENIED', '命令发送者不是已验证的所有者');
  }
  if (expected.accountId !== null && message.accountId !== expected.accountId) {
    logger.warn('拒绝跨账号命令');
    throw new MomentsError('ACCOUNT_MISMATCH', '命令来自其他微信账号');
  }
}
