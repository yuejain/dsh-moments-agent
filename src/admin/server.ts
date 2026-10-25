/**
 * 本机管理页（127.0.0.1 + 专用令牌）。
 *
 * 这不是微信聊天界面：它只服务本机所有者，用于查看状态、预览、批准/拒绝、
 * 暂停/恢复、处理 UNCERTAIN 以及手动触发准备。前端隐藏按钮不构成权限检查，
 * 所有写操作都由后端令牌验证并调用运行时服务。
 */
import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { MomentsRuntime } from '../runtime.js';
import type { Logger } from '../adapters/types.js';
import { redactSecrets } from '../security/redaction.js';
import { describeConfig } from '../config.js';
import { MomentsError } from '../domain/result.js';

export interface AdminServerOptions {
  readonly runtime: MomentsRuntime;
  readonly host: string;
  readonly port: number;
  readonly tokenFile: string;
  readonly logger: Logger;
}

const TOKEN_ENV = 'DSH_MOMENTS_ADMIN_TOKEN';

export class AdminServer {
  private server: http.Server | null = null;
  private token = '';

  constructor(private readonly options: AdminServerOptions) {}

  private loadToken(): string {
    const fromEnv = process.env[TOKEN_ENV];
    if (fromEnv !== undefined && fromEnv.trim().length >= 32) return fromEnv.trim();
    const file = this.options.tokenFile;
    try {
      if (existsSync(file)) {
        const value = readFileSync(file, 'utf8').trim();
        if (value.length >= 32) return value;
      }
    } catch {
      // 继续生成新令牌
    }
    const generated = randomBytes(32).toString('hex');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${generated}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      // Windows 上 chmod 作用有限；文件位于用户数据目录，权限由 ACL 控制。
      // eslint-disable-next-line no-bitwise
      const mode = 0o600;
      void mode;
    } catch {
      // 忽略
    }
    this.options.logger.info('已生成本机管理令牌文件（请勿提交到 Git）', { file: path.basename(file) });
    return generated;
  }

  private authorized(request: http.IncomingMessage): boolean {
    const header = request.headers['x-moments-token'];
    const authorization = request.headers.authorization;
    const supplied =
      typeof header === 'string' && header !== ''
        ? header.trim()
        : typeof authorization === 'string' && authorization.startsWith('Bearer ')
          ? authorization.slice(7).trim()
          : '';
    if (supplied === '' || this.token === '') return false;
    const expected = Buffer.from(this.token);
    const actual = Buffer.from(supplied);
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  }

  private isLoopback(request: http.IncomingMessage): boolean {
    const address = request.socket.remoteAddress ?? '';
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
  }

  private async readBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      size += buffer.length;
      if (size > 1024 * 1024) throw new Error('请求体过大');
      chunks.push(buffer);
    }
    if (size === 0) return {};
    const text = Buffer.concat(chunks).toString('utf8');
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('body');
      return parsed as Record<string, unknown>;
    } catch {
      throw new Error('请求体不是合法 JSON 对象');
    }
  }

  private send(res: http.ServerResponse, status: number, body: unknown): void {
    const raw = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(raw),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(raw);
  }

  async start(): Promise<void> {
    if (this.options.host !== '127.0.0.1' && this.options.host !== 'localhost') {
      throw new Error('管理页只允许绑定 127.0.0.1');
    }
    this.token = this.loadToken();
    this.server = http.createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.options.port, '127.0.0.1', () => resolve());
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (server === null) return;
    this.server = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    try {
      if (!this.isLoopback(request)) {
        this.send(response, 403, { ok: false, message: '只允许本机访问' });
        return;
      }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const html = renderPage();
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': Buffer.byteLength(html),
          'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
          'X-Frame-Options': 'DENY',
        });
        response.end(html);
        return;
      }
      if (!url.pathname.startsWith('/api/')) {
        this.send(response, 404, { ok: false, message: '未知端点' });
        return;
      }
      if (!this.authorized(request)) {
        this.send(response, 401, { ok: false, message: '缺少或错误的本机管理令牌' });
        return;
      }
      await this.route(request, response, url, this.options.runtime);
    } catch (error) {
      this.options.logger.error('管理页请求失败', {
        error: error instanceof Error ? redactSecrets(error.message) : 'unknown',
      });
      this.send(response, error instanceof MomentsError ? (error.code === 'NOT_FOUND' ? 404 : 400) : 500,
        { ok: false, errorCode: error instanceof MomentsError ? error.code : 'INTERNAL_ERROR',
          message: error instanceof Error ? redactSecrets(error.message) : '内部错误' });
    }
  }

  private async route(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    url: URL,
    runtime: MomentsRuntime,
  ): Promise<void> {
    const method = request.method ?? 'GET';
    const pathname = url.pathname;
    if (method === 'POST' && (pathname === '/api/images/generate' || pathname === '/api/images/edit')) {
      const body = await this.readBody(request);
      if (typeof body.taskId !== 'string') throw new MomentsError('INVALID_INPUT', '缺少正文任务 ID');
      this.send(response, 200, { ok: true, data: await runtime.generateImageTask({
        taskId: body.taskId, prompt: typeof body.prompt === 'string' ? body.prompt : undefined,
        operation: pathname.endsWith('/edit') ? 'edit' : 'generate',
        referenceAssetIds: Array.isArray(body.referenceAssetIds) && body.referenceAssetIds.every((item) => typeof item === 'string') ? body.referenceAssetIds as string[] : [],
        provider: typeof body.provider === 'string' ? body.provider : undefined,
      }) }); return;
    }
    if (method === 'POST' && pathname === '/api/images/import') {
      const body = await this.readBody(request);
      if (typeof body.imageTaskId !== 'string' || typeof body.path !== 'string') {
        throw new MomentsError('INVALID_INPUT', '请提供 imageTaskId 和 data 内的相对路径');
      }
      this.send(response, 200, { ok: true, data: await runtime.importImage({ imageTaskId: body.imageTaskId, path: body.path }) }); return;
    }
    if (method === 'POST' && pathname === '/api/persona') {
      const body = await this.readBody(request);
      if (typeof body.soul !== 'string' || typeof body.visualStyle !== 'string') {
        this.send(response, 400, { ok: false, message: '人格和风格必须为字符串' }); return;
      }
      runtime.updatePersona({ soul: body.soul, visualStyle: body.visualStyle });
      this.send(response, 200, { ok: true, data: runtime.personaView() }); return;
    }
    if (method === 'GET' && pathname === '/api/publish-mode') {
      this.send(response, 200, { ok: true, data: runtime.publishModeView() }); return;
    }
    if (method === 'GET' && pathname === '/api/writing-skills') {
      this.send(response, 200, { ok:true, data:runtime.writingSkillsView() }); return;
    }
    if (method === 'GET' && pathname === '/api/environment') {
      this.send(response, 200, {ok:true,data:runtime.environmentView()}); return;
    }
    if (method === 'POST' && pathname === '/api/writing-skills') {
      this.send(response, 200, { ok:true, data:runtime.updateWritingSkills(await this.readBody(request)) }); return;
    }
    if (method === 'POST' && pathname === '/api/publish-mode') {
      this.send(response, 200, { ok: true, data: runtime.updatePublishMode(await this.readBody(request)) }); return;
    }
    if (method === 'GET' && pathname === '/api/schedule') {
      this.send(response, 200, { ok: true, data: runtime.scheduleView() }); return;
    }
    if (method === 'GET' && pathname === '/api/automation') {
      this.send(response, 200, { ok: true, data: runtime.automationView() }); return;
    }
    if (method === 'POST' && pathname === '/api/automation') {
      this.send(response, 200, { ok: true, data: runtime.updateAutomation(await this.readBody(request)) }); return;
    }
    if (method === 'POST' && pathname === '/api/schedule') {
      this.send(response, 200, { ok: true, data: runtime.updateSchedule(await this.readBody(request)) }); return;
    }
    if (method === 'GET' && pathname === '/api/memories') {
      this.send(response, 200, { ok: true, data: runtime.listMemories() });
      return;
    }
    if (method === 'POST' && pathname === '/api/memories') {
      const body = await this.readBody(request);
      if (typeof body.kind !== 'string' || typeof body.key !== 'string' || typeof body.value !== 'string') {
        this.send(response, 400, { ok: false, message: '请提供 kind、key、value 字符串' }); return;
      }
      this.send(response, 200, { ok: true, data: runtime.saveMemory({ kind: body.kind, key: body.key, value: body.value }) });
      return;
    }
    if (method === 'DELETE' && /^\/api\/memories\/[^/]+$/.test(pathname)) {
      runtime.deleteMemory(decodeURIComponent(pathname.split('/')[3] as string));
      this.send(response, 200, { ok: true }); return;
    }
    // 社交记忆：所有者本机查看与手工修正。返回含真实昵称，只允许 127.0.0.1 + 管理令牌，
    // 不提供原始聊天正文读取、批量导出或关闭审计。
    if (method === 'GET' && pathname === '/api/chat-memory') {
      this.send(response, 200, { ok: true, data: this.ownerChatMemoryView(runtime) });
      return;
    }
    if (method === 'POST' && pathname === '/api/chat-memory/settings') {
      this.send(response, 200, { ok: true, data: runtime.updateChatMemorySettings(await this.readBody(request)) });
      return;
    }
    if (method === 'POST' && pathname === '/api/chat-memory/sync') {
      // body 当前只接受 {}（同步总是立即执行）；读取后忽略，保持请求流可复用连接。
      await this.readBody(request);
      this.send(response, 200, { ok: true, data: await runtime.syncChatMemory() });
      return;
    }
    if (method === 'PATCH' && /^\/api\/chat-memory\/members\/[^/]+$/.test(pathname)) {
      const impressionId = decodeURIComponent(pathname.slice('/api/chat-memory/members/'.length));
      this.send(response, 200, {
        ok: true,
        data: runtime.updateChatMemberImpression(impressionId, await this.readBody(request), 'owner'),
      });
      return;
    }
    if (method === 'DELETE' && /^\/api\/chat-memory\/members\/[^/]+$/.test(pathname)) {
      const impressionId = decodeURIComponent(pathname.slice('/api/chat-memory/members/'.length));
      runtime.deleteChatMemberImpression(impressionId);
      this.send(response, 200, { ok: true });
      return;
    }
    if (method === 'DELETE' && /^\/api\/chat-memory\/conversations\/[^/]+$/.test(pathname)) {
      const conversationKey = decodeURIComponent(pathname.slice('/api/chat-memory/conversations/'.length));
      this.send(response, 200, { ok: true, data: runtime.purgeChatConversation(conversationKey) });
      return;
    }
    if (method === 'GET' && pathname === '/api/health') {
      this.send(response, 200, { ok: true, data: await runtime.health() });
      return;
    }
    if (method === 'GET' && pathname === '/api/status') {
      const taskId = url.searchParams.get('taskId') ?? undefined;
      this.send(response, 200, { ok: true, data: await runtime.status(taskId) });
      return;
    }
    // 只读：拟人化自动发送的状态（配置、下次可发时间、今日计数、队列、最后错误）。
    // 管理面不提供任何“立即发送/跳过审批”的写接口。
    if (method === 'GET' && pathname === '/api/humanize') {
      this.send(response, 200, { ok: true, data: runtime.humanizeStatus() });
      return;
    }
    if (method === 'GET' && pathname === '/api/tasks') {
      const limitRaw = Number(url.searchParams.get('limit') ?? '100');
      const limit = Number.isFinite(limitRaw) ? limitRaw : 100;
      this.send(response, 200, { ok: true, data: await runtime.listTaskSummaries(limit) });
      return;
    }
    if (method === 'GET' && /^\/api\/tasks\/[^/]+$/.test(pathname)) {
      const taskId = decodeURIComponent(pathname.slice('/api/tasks/'.length));
      this.send(response, 200, { ok: true, data: await runtime.taskDetail(taskId) });
      return;
    }
    if (method === 'GET' && pathname === '/api/persona') {
      this.send(response, 200, { ok: true, data: runtime.personaView() });
      return;
    }
    if (method === 'GET' && pathname === '/api/config') {
      this.send(response, 200, { ok: true, data: describeConfig(runtime.getConfig()) });
      return;
    }
    if (method === 'GET' && /^\/api\/assets\/[^/]+\/raw$/.test(pathname)) {
      const assetId = decodeURIComponent(pathname.split('/')[3] as string);
      const asset = await runtime.assetBytes(assetId);
      response.writeHead(200, {
        'Content-Type': asset.mime,
        'Content-Length': asset.bytes.byteLength,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(Buffer.from(asset.bytes));
      return;
    }
    if (method === 'POST' && pathname === '/api/workflow/draft') {
      const body = await this.readBody(request);
      const input: { topic?: string; sourceType?: string; sourceEvidence?: string; motivation?: string; imagePrompt?: string } = {};
      if (typeof body.imagePrompt === 'string') input.imagePrompt = body.imagePrompt.slice(0, 2000);
      if (typeof body.topic === 'string' && body.topic.trim() !== '') input.topic = body.topic.trim().slice(0, 120);
      if (typeof body.sourceType === 'string' && body.sourceType.trim() !== '') input.sourceType = body.sourceType.trim();
      if (typeof body.sourceEvidence === 'string' && body.sourceEvidence.trim() !== '') {
        input.sourceEvidence = body.sourceEvidence.trim().slice(0, 2000);
      }
      if (typeof body.motivation === 'string' && body.motivation.trim() !== '') input.motivation = body.motivation.trim().slice(0, 400);
      const result = await runtime.generateDraftWorkflow(input);
      this.send(response, 200, { ok: true, data: result });
      return;
    }
    if (method === 'POST' && /^\/api\/tasks\/[^/]+\/compose$/.test(pathname)) {
      const taskId = decodeURIComponent(pathname.split('/')[3] as string);
      const body = await this.readBody(request);
      const options: { tone?: string; feedback?: string } = {};
      if (typeof body.tone === 'string') options.tone = body.tone.slice(0, 80);
      if (typeof body.feedback === 'string') options.feedback = body.feedback.slice(0, 1000);
      this.send(response, 200, { ok: true, data: await runtime.composeAndReview(taskId, options) });
      return;
    }
    if (method === 'POST' && /^\/api\/tasks\/[^/]+\/review$/.test(pathname)) {
      const taskId = decodeURIComponent(pathname.split('/')[3] as string);
      this.send(response, 200, { ok: true, data: await runtime.reviewTask(taskId) });
      return;
    }
    if (method === 'POST' && /^\/api\/tasks\/[^/]+\/request-approval$/.test(pathname)) {
      const taskId = decodeURIComponent(pathname.split('/')[3] as string);
      this.send(response, 200, { ok: true, data: await runtime.requestApproval(taskId) });
      return;
    }
    if (method === 'POST' && /^\/api\/tasks\/[^/]+\/prepare$/.test(pathname)) {
      const taskId = decodeURIComponent(pathname.split('/')[3] as string);
      this.send(response, 200, { ok: true, data: await runtime.prepareDesktop(taskId) });
      return;
    }
    if (method === 'POST' && /^\/api\/tasks\/[^/]+\/publish$/.test(pathname)) {
      const taskId = decodeURIComponent(pathname.split('/')[3] as string);
      const body = await this.readBody(request);
      const approvalId = typeof body.approvalId === 'string' ? body.approvalId : undefined;
      this.send(response, 200, { ok: true, data: await runtime.publish(taskId, approvalId) });
      return;
    }
    if (method === 'POST' && /^\/api\/tasks\/[^/]+\/cancel$/.test(pathname)) {
      const taskId = decodeURIComponent(pathname.split('/')[3] as string);
      const task = await runtime.cancelTask(taskId, '所有者从客户端取消', 'owner');
      this.send(response, 200, { ok: true, data: task });
      return;
    }
    if (method === 'GET' && pathname.startsWith('/api/preview/')) {
      const taskId = decodeURIComponent(pathname.slice('/api/preview/'.length));
      this.send(response, 200, { ok: true, data: await runtime.preview(taskId) });
      return;
    }
    if (method === 'GET' && pathname === '/api/approvals') {
      const status = await runtime.status();
      this.send(response, 200, { ok: true, data: status.pendingApprovals });
      return;
    }
    if (method === 'GET' && pathname === '/api/history') {
      const limit = Number(url.searchParams.get('limit') ?? '20');
      this.send(response, 200, { ok: true, data: await runtime.history(Number.isFinite(limit) ? limit : 20) });
      return;
    }
    if (method === 'POST' && /^\/api\/approvals\/[^/]+\/(approve|reject)$/.test(pathname)) {
      const match = /^\/api\/approvals\/([^/]+)\/(approve|reject)$/.exec(pathname);
      if (match === null) return;
      const approvalId = decodeURIComponent(match[1] as string);
      const action = match[2] === 'approve' ? 'approve' : 'reject';
      const body = await this.readBody(request);
      const reason = typeof body.reason === 'string' ? body.reason.slice(0, 300) : undefined;
      const approval = runtime.decideApproval(approvalId, action, 'manual_admin', reason);
      this.send(response, 200, { ok: true, data: approval });
      return;
    }
    if (method === 'POST' && (pathname === '/api/pause' || pathname === '/api/resume')) {
      const body = await this.readBody(request);
      const reason = typeof body.reason === 'string' ? body.reason.slice(0, 300) : '管理页操作';
      runtime.controlAction(pathname === '/api/pause' ? 'pause' : 'resume', reason, 'owner');
      this.send(response, 200, { ok: true, data: { paused: runtime.control.paused } });
      return;
    }
    if (method === 'POST' && (pathname === '/api/kill' || pathname === '/api/unkill')) {
      const body = await this.readBody(request);
      const reason = typeof body.reason === 'string' ? body.reason.slice(0, 300) : '管理页操作';
      runtime.controlAction(pathname === '/api/kill' ? 'kill' : 'unkill', reason, 'owner');
      this.send(response, 200, { ok: true, data: { killSwitch: runtime.control.killSwitch } });
      return;
    }
    if (method === 'POST' && pathname === '/api/prepare') {
      const body = await this.readBody(request);
      const taskId = typeof body.taskId === 'string' ? body.taskId : '';
      if (taskId === '') throw new Error('缺少 taskId');
      const result = await runtime.prepareDesktop(taskId);
      this.send(response, 200, { ok: true, data: result });
      return;
    }
    if (method === 'POST' && pathname === '/api/publish') {
      const body = await this.readBody(request);
      const taskId = typeof body.taskId === 'string' ? body.taskId : '';
      const approvalId = typeof body.approvalId === 'string' ? body.approvalId : undefined;
      if (taskId === '') throw new Error('缺少 taskId');
      const result = await runtime.publish(taskId, approvalId);
      this.send(response, 200, { ok: true, data: result });
      return;
    }
    if (method === 'POST' && pathname === '/api/cancel') {
      const body = await this.readBody(request);
      const taskId = typeof body.taskId === 'string' ? body.taskId : '';
      if (taskId === '') throw new Error('缺少 taskId');
      const task = await runtime.cancelTask(taskId, '所有者从管理页取消', 'owner');
      this.send(response, 200, { ok: true, data: task });
      return;
    }
    if (method === 'POST' && /^\/api\/attempts\/[^/]+\/verify$/.test(pathname)) {
      const attemptId = decodeURIComponent(pathname.split('/')[3] as string);
      this.send(response, 200, { ok: true, data: await runtime.verify(attemptId) });
      return;
    }
    if (method === 'POST' && /^\/api\/uncertain\/[^/]+\/resolve$/.test(pathname)) {
      const attemptId = decodeURIComponent(pathname.split('/')[3] as string);
      const body = await this.readBody(request);
      if (body.resolution !== 'PUBLISHED' && body.resolution !== 'FAILED') {
        throw new Error('resolution 必须是 PUBLISHED 或 FAILED');
      }
      const note = typeof body.note === 'string' ? body.note.slice(0, 500) : '所有者人工核对朋友圈';
      const result = runtime.resolveUncertain(attemptId, body.resolution, note);
      this.send(response, 200, { ok: true, data: result });
      return;
    }
    this.send(response, 404, { ok: false, message: '未知端点或方法' });
  }

  /**
   * 所有者视图脱敏：服务层记录含原始 talker / accountId，管理 API 只回传页面需要的字段。
   * 真实昵称（displayName）仍返回，因为管理页需要让所有者辨认会话；但它只在本机回环 + 令牌下可见。
   */
  private ownerChatMemoryView(runtime: MomentsRuntime): {
    enabled: boolean;
    settings: ReturnType<MomentsRuntime['chatMemoryView']>['settings'];
    stats: ReturnType<MomentsRuntime['chatMemoryView']>['stats'];
    conversations: {
      conversation: {
        conversationKey: string;
        kind: 'group' | 'private';
        label: string;
        displayName: string;
        enabled: boolean;
        lastSyncedAt: string | null;
        lastMessageAt: string | null;
        createdAt: string;
        updatedAt: string;
      };
      members: ReturnType<MomentsRuntime['chatMemoryView']>['conversations'][number]['members'];
    }[];
  } {
    const view = runtime.chatMemoryView();
    return {
      enabled: view.enabled,
      settings: view.settings,
      stats: view.stats,
      conversations: view.conversations.map(({ conversation, members }) => ({
        conversation: {
          conversationKey: conversation.conversationKey,
          kind: conversation.kind,
          label: conversation.label,
          displayName: conversation.displayName,
          enabled: conversation.enabled,
          lastSyncedAt: conversation.lastSyncedAt,
          lastMessageAt: conversation.lastMessageAt,
          createdAt: conversation.createdAt,
          updatedAt: conversation.updatedAt,
        },
        members,
      })),
    };
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function tokenHint(): string {
  return createHash('sha256').update('dsh-moments-admin-hint').digest('hex').slice(0, 8);
}

function renderPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DSH Moments Agent 管理页</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; background: #0f1115; color: #e8e8ea; }
  header { padding: 16px 24px; border-bottom: 1px solid #262a33; display: flex; gap: 16px; align-items: center; }
  header h1 { font-size: 16px; margin: 0; font-weight: 600; }
  main { padding: 20px 24px; display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); }
  section { background: #171a21; border: 1px solid #262a33; border-radius: 10px; padding: 14px 16px; }
  h2 { font-size: 14px; margin: 0 0 10px; color: #a9b1c3; font-weight: 600; }
  input, button, textarea { font: inherit; }
  input[type=text], input[type=password] { width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 6px; border: 1px solid #333a47; background: #0f1115; color: #e8e8ea; }
  button { padding: 6px 12px; border-radius: 6px; border: 1px solid #3a4250; background: #232834; color: #e8e8ea; cursor: pointer; }
  button:hover { background: #2b3140; }
  button.danger { border-color: #6b2b2b; background: #3a1d1d; }
  button.primary { border-color: #2b4a6b; background: #1d2b3a; }
  pre { white-space: pre-wrap; word-break: break-word; background: #0f1115; border: 1px solid #262a33; border-radius: 8px; padding: 10px; max-height: 340px; overflow: auto; font-size: 12px; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 8px 0; }
  .muted { color: #8b93a7; font-size: 12px; }
  .ok { color: #63d18f; } .bad { color: #ff7b7b; }
</style>
</head>
<body>
<header>
  <h1>DSH Moments Agent · 本机管理页</h1>
  <span class="muted">只绑定 127.0.0.1；所有写操作需要管理令牌</span>
</header>
<main>
  <section>
    <h2>管理令牌</h2>
    <div class="row">
      <input id="token" type="password" placeholder="粘贴 data/admin-token.txt 中的令牌">
      <button onclick="saveToken()">保存到本标签页</button>
    </div>
    <div class="muted">令牌只保存在本页 localStorage，不会发送到网络以外。提示：${tokenHint()}</div>
  </section>
  <section>
    <h2>系统状态</h2>
    <div class="row">
      <button onclick="load('status')">刷新状态</button>
      <button onclick="post('/api/pause')">暂停</button>
      <button onclick="post('/api/resume')">恢复</button>
      <button class="danger" onclick="post('/api/kill')">Kill Switch</button>
      <button onclick="post('/api/unkill')">解除 Kill Switch</button>
    </div>
    <pre id="status">尚未加载</pre>
  </section>
  <section>
    <h2>待审批</h2>
    <div class="row"><button onclick="loadApprovals()">刷新审批</button></div>
    <pre id="approvals">尚未加载</pre>
    <div class="row">
      <input id="approvalId" type="text" placeholder="审批 ID">
      <button class="primary" onclick="decide('approve')">批准</button>
      <button class="danger" onclick="decide('reject')">拒绝</button>
    </div>
    <div class="muted">批准绑定当前内容快照；批准后文案/图片/可见范围/账号任一变化都会要求重新审批。</div>
  </section>
  <section>
    <h2>任务预览 / 准备</h2>
    <div class="row">
      <input id="taskId" type="text" placeholder="任务 ID">
      <button onclick="preview()">预览</button>
      <button onclick="prepare()">准备（不发表）</button>
      <button class="danger" onclick="cancelTask()">取消</button>
    </div>
    <pre id="preview">尚未加载</pre>
  </section>
  <section>
    <h2>发布与核验</h2>
    <div class="row">
      <input id="publishTaskId" type="text" placeholder="任务 ID">
      <input id="publishApprovalId" type="text" placeholder="审批 ID（可选）">
      <button class="danger" onclick="publish()">发表（需执行器 --allow-publish）</button>
    </div>
    <div class="row">
      <input id="attemptId" type="text" placeholder="发布尝试 ID">
      <button onclick="verify()">核验</button>
      <button onclick="resolveUncertain('PUBLISHED')">人工确认已发布</button>
      <button onclick="resolveUncertain('FAILED')">人工确认未发布</button>
    </div>
    <pre id="publishResult">尚未操作</pre>
  </section>
  <section>
    <h2>社交记忆</h2>
    <div class="row">
      <label class="muted"><input id="chatMemoryEnabled" type="checkbox"> 启用社交记忆</label>
      <label class="muted"><input id="chatMemoryIncludePrivate" type="checkbox"> 包含私聊</label>
      <button onclick="saveChatMemorySettings()">保存设置</button>
      <button class="primary" onclick="syncChatMemory()">立即同步</button>
      <button onclick="loadChatMemory()">刷新</button>
    </div>
    <div class="muted" id="chatMemoryStats">尚未加载</div>
    <pre id="chatMemoryResult">尚未操作</pre>
    <div id="chatMemoryConversations" class="muted">尚未加载</div>
    <div class="muted">只读 WeChatAgent 白名单内的群聊/私聊；人物印象可在此手工修正，聊天原文不会进入提示词或朋友圈。</div>
  </section>
  <section>
    <h2>历史</h2>
    <div class="row"><button onclick="history()">刷新历史</button></div>
    <pre id="history">尚未加载</pre>
  </section>
</main>
<script>
const $ = (id) => document.getElementById(id);
const tok = () => $('token').value || localStorage.getItem('moments-admin-token') || '';
function saveToken(){ localStorage.setItem('moments-admin-token', $('token').value); $('token').value=''; alert('已保存'); }
async function api(path, method='GET', body){
  const headers = { 'X-Moments-Token': localStorage.getItem('moments-admin-token') || ($('token').value || '') };
  if (body !== undefined) headers['Content-Type']='application/json';
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  try { return { status: res.status, data: JSON.parse(text) }; } catch { return { status: res.status, data: text }; }
}
async function post(path, body){
  const r = await api(path, 'POST', body === undefined ? {} : body);
  alert(JSON.stringify(r.data, null, 2));
  load();
}
async function load(which){
  const r = await api('/api/status');
  $('status').textContent = JSON.stringify(r.data, null, 2);
}
async function loadApprovals(){
  const r = await api('/api/approvals');
  $('approvals').textContent = JSON.stringify(r.data, null, 2);
}
async function decide(action){
  const id = $('approvalId').value.trim();
  if (!id) return alert('请填写审批 ID');
  if (!confirm(action === 'approve' ? '确认批准该审批？批准后内容不可再改。' : '确认拒绝该审批？')) return;
  const r = await api('/api/approvals/' + encodeURIComponent(id) + '/' + action, 'POST', {});
  alert(JSON.stringify(r.data, null, 2));
  loadApprovals();
}
async function preview(){
  const id = $('taskId').value.trim();
  if (!id) return alert('请填写任务 ID');
  const r = await api('/api/preview/' + encodeURIComponent(id));
  $('preview').textContent = JSON.stringify(r.data, null, 2);
}
async function prepare(){
  const id = $('taskId').value.trim();
  if (!id) return alert('请填写任务 ID');
  if (!confirm('将打开微信朋友圈编辑窗口并填入图文，但不会点击发表。继续？')) return;
  const r = await api('/api/prepare','POST',{ taskId: id });
  $('preview').textContent = JSON.stringify(r.data, null, 2);
}
async function cancelTask(){
  const id = $('taskId').value.trim();
  if (!id) return alert('请填写任务 ID');
  if (!confirm('确认取消该任务？')) return;
  const r = await api('/api/cancel','POST',{ taskId: id });
  $('preview').textContent = JSON.stringify(r.data, null, 2);
}
async function publish(){
  const taskId = $('publishTaskId').value.trim();
  if (!taskId) return alert('请填写任务 ID');
  if (!confirm('这会尝试真实发表到你的微信朋友圈。仅在已批准且执行器允许发表时成功。继续？')) return;
  const body = { taskId };
  const approvalId = $('publishApprovalId').value.trim();
  if (approvalId) body.approvalId = approvalId;
  const r = await api('/api/publish','POST',body);
  $('publishResult').textContent = JSON.stringify(r.data, null, 2);
}
async function verify(){
  const id = $('attemptId').value.trim();
  if (!id) return alert('请填写尝试 ID');
  const r = await api('/api/attempts/' + encodeURIComponent(id) + '/verify', 'POST', {});
  $('publishResult').textContent = JSON.stringify(r.data, null, 2);
}
async function resolveUncertain(resolution){
  const id = $('attemptId').value.trim();
  if (!id) return alert('请填写尝试 ID');
  const note = prompt('请描述你在微信朋友圈人工核对的结果');
  if (note === null) return;
  const r = await api('/api/uncertain/' + encodeURIComponent(id) + '/resolve','POST',{ resolution, note });
  $('publishResult').textContent = JSON.stringify(r.data, null, 2);
}
async function history(){
  const r = await api('/api/history');
  $('history').textContent = JSON.stringify(r.data, null, 2);
}
// ---------------------------------------------------------------------------
// 社交记忆：只做展示与手工修正，不提供批量导出。
// ---------------------------------------------------------------------------
let chatMemoryCache = null;
function esc(value){
  return String(value === undefined || value === null ? '' : value).replace(/[&<>"']/g, function(char){
    if (char === '&') return '&amp;';
    if (char === '<') return '&lt;';
    if (char === '>') return '&gt;';
    if (char === '"') return '&quot;';
    return '&#39;';
  });
}
function chatStatusLabel(status){
  if (status === 'owner_edited') return '已人工修正';
  if (status === 'observed') return '已观察';
  return '待观察';
}
async function loadChatMemory(){
  const r = await api('/api/chat-memory');
  if (!r.data || r.data.ok !== true) {
    $('chatMemoryStats').textContent = '';
    $('chatMemoryConversations').textContent = '加载失败：' + JSON.stringify(r.data);
    return;
  }
  chatMemoryCache = r.data.data;
  renderChatMemory();
}
function findChatMember(impressionId){
  if (!chatMemoryCache) return null;
  const conversations = chatMemoryCache.conversations || [];
  for (let i = 0; i < conversations.length; i += 1) {
    const members = conversations[i].members || [];
    for (let j = 0; j < members.length; j += 1) {
      if (members[j].impressionId === impressionId) return members[j];
    }
  }
  return null;
}
function renderChatMemory(){
  const view = chatMemoryCache;
  if (!view) return;
  $('chatMemoryEnabled').checked = view.settings.enabled === true;
  $('chatMemoryIncludePrivate').checked = view.settings.includePrivate === true;
  const stats = view.stats || {};
  $('chatMemoryStats').textContent = '会话 ' + String(stats.conversations || 0)
    + ' 个 · 消息 ' + String(stats.messages || 0)
    + ' 条 · 人物印象 ' + String(stats.members || 0)
    + ' 条 · 最近同步：' + String(stats.lastSyncedAt || '从未同步');
  const container = $('chatMemoryConversations');
  const conversations = view.conversations || [];
  if (conversations.length === 0) {
    container.innerHTML = '<span class="muted">暂无会话数据：开启开关并点击「立即同步」。</span>';
    return;
  }
  const html = [];
  for (let i = 0; i < conversations.length; i += 1) {
    const item = conversations[i] || {};
    const conv = item.conversation || {};
    html.push('<div style="border:1px solid #262a33;border-radius:8px;padding:10px;margin:10px 0;">');
    html.push('<div class="row"><strong>' + esc(conv.displayName || '（无名称）') + '</strong>'
      + '<span class="muted">' + esc(conv.label || '') + ' · '
      + esc(conv.kind === 'group' ? '群聊' : '私聊') + ' · 最近消息：'
      + esc(conv.lastMessageAt || '无')
      + (conv.enabled === false ? ' · 未参与同步（私聊未开启或已停用）' : '')
      + '</span>'
      + '<button class="danger" data-chat-action="purge" data-chat-id="' + esc(conv.conversationKey) + '">清除会话</button>'
      + '</div>');
    const members = item.members || [];
    if (members.length === 0) {
      html.push('<div class="muted">该会话暂无人物印象（证据不足或尚未提炼）。</div>');
    }
    for (let j = 0; j < members.length; j += 1) {
      const member = members[j] || {};
      html.push('<div style="border-top:1px solid #262a33;padding:8px 0;">');
      html.push('<div class="row"><strong>' + esc(member.alias || '（未命名）') + '</strong>'
        + '<span class="muted">本机昵称：' + esc(member.displayName || '未知')
        + ' · 证据 ' + String(member.evidenceCount || 0) + ' 条 · '
        + esc(chatStatusLabel(member.status)) + '</span></div>');
      html.push('<div class="muted">摘要：' + esc(member.summary || '（暂无摘要）') + '</div>');
      html.push('<div class="muted">标签：' + esc((member.traits || []).join('、') || '无')
        + ' · 话题：' + esc((member.topics || []).join('、') || '无')
        + ' · 风格：' + esc(member.style || '无') + '</div>');
      html.push('<div class="row">');
      html.push('<button data-chat-action="edit" data-chat-id="' + esc(member.impressionId)
        + '" data-chat-field="summary">改摘要</button>');
      html.push('<button data-chat-action="edit" data-chat-id="' + esc(member.impressionId)
        + '" data-chat-field="alias">改别名</button>');
      html.push('<button data-chat-action="edit" data-chat-id="' + esc(member.impressionId)
        + '" data-chat-field="traits">改标签</button>');
      html.push('<button data-chat-action="edit" data-chat-id="' + esc(member.impressionId)
        + '" data-chat-field="status">改状态</button>');
      html.push('<button class="danger" data-chat-action="delete" data-chat-id="' + esc(member.impressionId) + '">删除</button>');
      html.push('</div></div>');
    }
    html.push('</div>');
  }
  container.innerHTML = html.join('');
  const actionButtons = container.querySelectorAll('button[data-chat-action]');
  for (let k = 0; k < actionButtons.length; k += 1) {
    const button = actionButtons[k];
    const action = button.getAttribute('data-chat-action');
    const id = button.getAttribute('data-chat-id') || '';
    const field = button.getAttribute('data-chat-field');
    if (action === 'purge') {
      button.addEventListener('click', function(){ purgeChatConversation(id); });
    } else if (action === 'delete') {
      button.addEventListener('click', function(){ deleteChatMember(id); });
    } else if (action === 'edit' && field !== null) {
      button.addEventListener('click', function(){ editChatMember(id, field); });
    }
  }
}
async function saveChatMemorySettings(){
  const body = {
    enabled: $('chatMemoryEnabled').checked,
    includePrivate: $('chatMemoryIncludePrivate').checked,
  };
  const r = await api('/api/chat-memory/settings', 'POST', body);
  $('chatMemoryResult').textContent = JSON.stringify(r.data, null, 2);
  await loadChatMemory();
}
async function syncChatMemory(){
  if (!confirm('立即同步社交记忆？只读取 WeChatAgent 白名单内的会话，不会发送任何微信消息。')) return;
  const r = await api('/api/chat-memory/sync', 'POST', {});
  $('chatMemoryResult').textContent = JSON.stringify(r.data, null, 2);
  await loadChatMemory();
}
async function editChatMember(impressionId, field){
  const member = findChatMember(impressionId);
  const body = {};
  if (field === 'summary') {
    const value = prompt('新的印象摘要（最多 300 字）', member ? member.summary || '' : '');
    if (value === null) return;
    body.summary = value;
  } else if (field === 'alias') {
    const value = prompt('新的匿名别名（1~8 个中文/字母/数字/下划线）', member ? member.alias || '' : '');
    if (value === null) return;
    body.alias = value;
  } else if (field === 'traits') {
    const value = prompt('受控标签，用逗号或顿号分隔（最多 6 个）',
      member ? (member.traits || []).join('、') : '');
    if (value === null) return;
    body.traits = value.split(/[,，、]/).map(function(part){ return part.trim(); })
      .filter(function(part){ return part !== ''; });
  } else if (field === 'status') {
    const value = prompt('状态：new（待观察）/ observed（已观察）/ owner_edited（人工修正）',
      member ? member.status || 'owner_edited' : 'owner_edited');
    if (value === null) return;
    body.status = value.trim();
  } else {
    return;
  }
  const r = await api('/api/chat-memory/members/' + encodeURIComponent(impressionId), 'PATCH', body);
  $('chatMemoryResult').textContent = JSON.stringify(r.data, null, 2);
  await loadChatMemory();
}
async function deleteChatMember(impressionId){
  if (!confirm('确认删除该人物印象？此操作不可撤销。')) return;
  const r = await api('/api/chat-memory/members/' + encodeURIComponent(impressionId), 'DELETE');
  $('chatMemoryResult').textContent = JSON.stringify(r.data, null, 2);
  await loadChatMemory();
}
async function purgeChatConversation(conversationKey){
  if (!confirm('确认清除该会话的全部消息与人物印象？此操作不可撤销。')) return;
  const r = await api('/api/chat-memory/conversations/' + encodeURIComponent(conversationKey), 'DELETE');
  $('chatMemoryResult').textContent = JSON.stringify(r.data, null, 2);
  await loadChatMemory();
}
$('token').value = localStorage.getItem('moments-admin-token') || '';
load();
loadChatMemory();
</script>
</body>
</html>`;
}

export { escapeHtml };
