/**
 * DSH 工具定义。
 *
 * 约束：
 * - 参数使用 JSON Schema 声明，执行前再做严格运行时校验；
 * - 返回统一结果信封（success/taskId/status/data/errorCode/message/retryable）；
 * - 外部副作用工具（prepare/publish）不自动重试；retryable 只描述“调用方可否重新发起一次新的、经过重新校验的请求”；
 * - 不提供任何“批准自己”的工具；审批只能来自所有者命令或本机管理令牌。
 */
import { MomentsError, errorToEnvelope, type ToolResultEnvelope } from '../domain/result.js';
import type { MomentsRuntime } from '../runtime.js';

export interface ToolRunContextLike {
  readonly callId?: string;
  readonly agent?: { readonly id?: string };
  readonly signal?: AbortSignal;
}

export interface ToolDefinitionLike {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly output: {
    readonly schema: Record<string, unknown>;
    render(args: unknown, value: unknown): readonly { type: 'text'; text: string }[];
  };
  readonly timeoutMs?: number;
  execute(args: unknown, exec: ToolRunContextLike): Promise<unknown>;
}

const envelopeSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    taskId: { type: 'string' },
    status: { type: 'string' },
    data: {},
    errorCode: { type: 'string' },
    message: { type: 'string' },
    retryable: { type: 'boolean' },
  },
  required: ['success', 'message', 'retryable'],
  additionalProperties: false,
};

function renderEnvelope(_args: unknown, value: unknown): readonly { type: 'text'; text: string }[] {
  if (value !== null && typeof value === 'object') {
    const envelope = value as ToolResultEnvelope;
    const summary = [envelope.success ? '✅' : '❌', envelope.message];
    if (envelope.taskId !== undefined) summary.push(`taskId=${envelope.taskId}`);
    if (envelope.status !== undefined) summary.push(`status=${envelope.status}`);
    if (envelope.errorCode !== undefined) summary.push(`errorCode=${envelope.errorCode}`);
    const detail = envelope.data === undefined ? '' : `\n${JSON.stringify(envelope.data, null, 2)}`;
    return [{ type: 'text', text: `${summary.join(' ')}${detail}`.slice(0, 8000) }];
  }
  return [{ type: 'text', text: String(value).slice(0, 4000) }];
}

function objectArgs(args: unknown): Record<string, unknown> {
  if (args === null || args === undefined) return {};
  if (typeof args !== 'object' || Array.isArray(args)) {
    throw new MomentsError('INVALID_INPUT', '工具参数必须是 JSON 对象');
  }
  return args as Record<string, unknown>;
}

function requiredString(args: Record<string, unknown>, key: string, maxLength = 500): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new MomentsError('INVALID_INPUT', `参数 ${key} 必须是非空字符串`);
  }
  return value.trim().slice(0, maxLength);
}

function optionalString(args: Record<string, unknown>, key: string, maxLength = 500): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new MomentsError('INVALID_INPUT', `参数 ${key} 必须是字符串`);
  return value.trim().slice(0, maxLength);
}

function optionalNumber(args: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new MomentsError('INVALID_INPUT', `参数 ${key} 必须是 ${min} 到 ${max} 的数字`);
  }
  return value;
}

function stringArray(args: Record<string, unknown>, key: string, maxItems = 9): string[] {
  const value = args[key];
  if (!Array.isArray(value) || value.length === 0) throw new MomentsError('INVALID_INPUT', `参数 ${key} 必须是非空数组`);
  if (value.length > maxItems) throw new MomentsError('INVALID_INPUT', `参数 ${key} 最多 ${maxItems} 项`);
  return value.map((item, index) => {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new MomentsError('INVALID_INPUT', `参数 ${key}[${index}] 必须是非空字符串`);
    }
    return item.trim();
  });
}

function wrap(
  handler: (args: Record<string, unknown>, exec: ToolRunContextLike) => Promise<ToolResultEnvelope<unknown>>,
  toolName: string,
): (rawArgs: unknown, exec: ToolRunContextLike) => Promise<ToolResultEnvelope<unknown>> {
  return async (rawArgs: unknown, exec: ToolRunContextLike): Promise<ToolResultEnvelope<unknown>> => {
    try {
      return await handler(objectArgs(rawArgs), exec);
    } catch (error) {
      if (error instanceof MomentsError) return errorToEnvelope(error);
      const message = error instanceof Error ? error.message : '工具执行失败';
      return errorToEnvelope(new MomentsError('INTERNAL_ERROR', `${toolName} 执行失败：${message}`));
    }
  };
}

export function buildTools(runtime: MomentsRuntime): ToolDefinitionLike[] {
  const tools: ToolDefinitionLike[] = [];

  tools.push({
    name: 'moments_create_idea',
    description: '生成一个朋友圈候选主题。模型可以判断没有值得表达的内容并选择沉默；不会自动发布。',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: '所有者明确指定的主题（可选）；不填则由模型自主选题' },
        sourceType: { type: 'string', description: '来源类型，默认由模型判断' },
        sourceEvidence: { type: 'string', description: '来源依据（事实性主题必须提供）' },
        motivation: { type: 'string', description: '为什么值得表达' },
      },
      additionalProperties: false,
    },
    output: { schema: envelopeSchema, render: renderEnvelope },
    timeoutMs: 120_000,
    execute: wrap(async (args) => {
      const input: { topic?: string; sourceType?: string; sourceEvidence?: string; motivation?: string } = {};
      const topic = optionalString(args, 'topic', 120);
      const sourceType = optionalString(args, 'sourceType', 40);
      const sourceEvidence = optionalString(args, 'sourceEvidence', 2000);
      const motivation = optionalString(args, 'motivation', 400);
      if (topic !== undefined) input.topic = topic;
      if (sourceType !== undefined) input.sourceType = sourceType;
      if (sourceEvidence !== undefined) input.sourceEvidence = sourceEvidence;
      if (motivation !== undefined) input.motivation = motivation;
      const result = await runtime.createIdea(input);
      if (result.silent || result.task === null) {
        return {
          success: true,
          status: 'SILENT',
          message: `选择沉默：${result.reason}`,
          retryable: false,
          data: { silent: true },
        };
      }
      return {
        success: true,
        taskId: result.task.taskId,
        status: result.task.state,
        message: '已创建候选主题（未发布）',
        retryable: false,
        data: { idea: result.idea, task: result.task },
      };
    }, 'moments_create_idea'),
  });

  tools.push({
    name: 'moments_compose_draft',
    description: '基于候选主题创作朋友圈文案草稿；只产生草稿，不审核、不发布。',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        tone: { type: 'string', description: '期望语气（可选）' },
        feedback: { type: 'string', description: '需要吸收的所有者反馈（可选）' },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
    output: { schema: envelopeSchema, render: renderEnvelope },
    timeoutMs: 120_000,
    execute: wrap(async (args) => {
      const taskId = requiredString(args, 'taskId', 120);
      const options: { tone?: string; feedback?: string } = {};
      const tone = optionalString(args, 'tone', 80);
      const feedback = optionalString(args, 'feedback', 1000);
      if (tone !== undefined) options.tone = tone;
      if (feedback !== undefined) options.feedback = feedback;
      const result = await runtime.composeDraft(taskId, options);
      return {
        success: true,
        taskId,
        status: result.task.state,
        message: '草稿已生成，尚未审核或发布',
        retryable: false,
        data: {
          draftText: result.draftText,
          review: {
            passed: result.review.passed,
            flags: result.review.flags,
            notes: result.review.notes,
            llmReviewed: result.review.llmReviewed,
          },
        },
      };
    }, 'moments_compose_draft'),
  });

  tools.push({
    name: 'moments_select_images',
    description: '把已通过审核的图片素材关联到朋友圈任务；不会上传或发布。',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        assetIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 9 },
      },
      required: ['taskId', 'assetIds'],
      additionalProperties: false,
    },
    output: { schema: envelopeSchema, render: renderEnvelope },
    execute: wrap(async (args) => {
      const taskId = requiredString(args, 'taskId', 120);
      const assetIds = stringArray(args, 'assetIds', 9);
      const result = await runtime.selectImages(taskId, assetIds);
      return {
        success: true,
        taskId,
        status: result.task.state,
        message: `已关联 ${result.assets.length} 张已审核图片`,
        retryable: false,
        data: { state: result.task.state, assets: result.assets.map((asset) => ({ assetId: asset.assetId, sha256: asset.sha256 })) },
      };
    }, 'moments_select_images'),
  });

  tools.push({
    name: 'moments_generate_image_task',
    description:
      '创建配图任务。默认走人工订阅桥（ChatGPT Plus/Gemini 客户端生成后回传）或本地图片；不会自动调用未授权/付费图像 API。',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        prompt: { type: 'string', description: '配图提示词；不填则由模型根据文案生成' },
        operation: { type: 'string', enum: ['generate', 'edit'] },
        referenceAssetIds: { type: 'array', items: { type: 'string' }, maxItems: 9 },
        aspectRatio: { type: 'string', description: '1:1 / 4:3 / 3:4 / 16:9 / 9:16' },
        styleProfile: { type: 'string' },
        provider: { type: 'string', description: 'manual-subscription / local-import / local-generation / official-api / codex-subscription' },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
    output: { schema: envelopeSchema, render: renderEnvelope },
    timeoutMs: 180_000,
    execute: wrap(async (args) => {
      const taskId = requiredString(args, 'taskId', 120);
      const input: Parameters<MomentsRuntime['generateImageTask']>[0] = { taskId };
      const operation = optionalString(args, 'operation', 20);
      if (operation !== undefined && operation !== 'generate' && operation !== 'edit') throw new MomentsError('INVALID_INPUT', '未知图片操作');
      if (operation !== undefined) input.operation = operation;
      if (args.referenceAssetIds !== undefined) input.referenceAssetIds = stringArray(args, 'referenceAssetIds', 9);
      const prompt = optionalString(args, 'prompt', 2000);
      const aspectRatio = optionalString(args, 'aspectRatio', 10);
      const styleProfile = optionalString(args, 'styleProfile', 300);
      const provider = optionalString(args, 'provider', 60);
      if (prompt !== undefined) input.prompt = prompt;
      if (aspectRatio !== undefined) input.aspectRatio = aspectRatio;
      if (styleProfile !== undefined) input.styleProfile = styleProfile;
      if (provider !== undefined) input.provider = provider;
      const result = await runtime.generateImageTask(input);
      if (result.errorCode !== null) {
        return {
          success: false,
          taskId,
          status: result.task.state,
          message: result.message,
          errorCode: 'IMAGE_REVIEW_FAILED',
          retryable: false,
          data: { imageTaskId: result.imageTask.imageTaskId, requiresUserAction: result.requiresUserAction },
        };
      }
      return {
        success: true,
        taskId,
        status: result.task.state,
        message: result.message,
        retryable: false,
        data: {
          imageTaskId: result.imageTask.imageTaskId,
          requiresUserAction: result.requiresUserAction,
          assets: result.assets.map((asset) => ({ assetId: asset.assetId, sha256: asset.sha256 })),
          instruction: result.requiresUserAction
            ? '请用你自己的 ChatGPT Plus/Gemini 客户端生成图片，然后调用 moments_import_image 回传；不会自动抓取会话或调用非公开接口。'
            : undefined,
        },
      };
    }, 'moments_generate_image_task'),
  });

  tools.push({
    name: 'moments_import_image',
    description:
      '导入一张已获授权的本地图片（路径必须在 data/imports 或 data/assets 内）或 base64 数据；会校验格式、去重与审核，不自动关联最近收到的任意图片。',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: '关联的朋友圈任务（可选）' },
        imageTaskId: { type: 'string', description: '关联的配图任务（可选，必须与 taskId 一致）' },
        path: { type: 'string', description: '相对 data 目录的路径' },
        base64: { type: 'string' },
        mime: { type: 'string' },
        license: { type: 'string', description: '使用许可，默认 owner-authorized' },
        source: { type: 'string', enum: ['owner_upload', 'local_import'] },
      },
      additionalProperties: false,
    },
    output: { schema: envelopeSchema, render: renderEnvelope },
    timeoutMs: 120_000,
    execute: wrap(async (args) => {
      const input: {
        taskId?: string;
        imageTaskId?: string;
        path?: string;
        base64?: string;
        mime?: string;
        license?: string;
        source?: 'owner_upload' | 'local_import';
      } = {};
      const taskId = optionalString(args, 'taskId', 120);
      const imageTaskId = optionalString(args, 'imageTaskId', 120);
      const filePath = optionalString(args, 'path', 1000);
      const base64 = optionalString(args, 'base64', 16 * 1024 * 1024);
      const mime = optionalString(args, 'mime', 100);
      const license = optionalString(args, 'license', 200);
      const source = optionalString(args, 'source', 40);
      if (taskId !== undefined) input.taskId = taskId;
      if (imageTaskId !== undefined) input.imageTaskId = imageTaskId;
      if (filePath !== undefined) input.path = filePath;
      if (base64 !== undefined) input.base64 = base64;
      if (mime !== undefined) input.mime = mime;
      if (license !== undefined) input.license = license;
      if (source === 'owner_upload' || source === 'local_import') input.source = source;
      const result = await runtime.importImage(input);
      return {
        success: true,
        taskId: result.task?.taskId,
        status: result.task?.state,
        message: result.duplicate ? '图片已存在（按 SHA-256 去重）并通过审核' : '图片已导入并通过审核',
        retryable: false,
        data: {
          assetId: result.asset.assetId,
          sha256: result.asset.sha256,
          mime: result.asset.mime,
          width: result.asset.width,
          height: result.asset.height,
          duplicate: result.duplicate,
          review: { passed: result.review.passed, flags: result.review.flags, notes: result.review.notes },
        },
      };
    }, 'moments_import_image'),
  });

  tools.push({
    name: 'moments_review_draft',
    description: '审核当前草稿（隐私、重复、来源、模型复核）；通过后进入待审批，未通过退回修改。',
    parameters: {
      type: 'object',
      properties: { taskId: { type: 'string' } },
      required: ['taskId'],
      additionalProperties: false,
    },
    output: { schema: envelopeSchema, render: renderEnvelope },
    timeoutMs: 120_000,
    execute: wrap(async (args) => {
      const taskId = requiredString(args, 'taskId', 120);
      const result = await runtime.reviewDraft(taskId);
      return {
        success: result.passed,
        taskId,
        status: result.task.state,
        message: result.passed ? '审核通过，等待所有者审批' : `审核未通过：${result.notes[0] ?? '未知原因'}`,
        ...(result.passed ? {} : { errorCode: 'POLICY_DENIED' as const }),
        retryable: false,
        data: { flags: result.flags, notes: result.notes },
      };
    }, 'moments_review_draft'),
  });

  tools.push({
    name: 'moments_get_history',
    description: '读取已发布记录与近期候选主题，用于去重与长期记忆。',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'number', minimum: 1, maximum: 50 } },
      additionalProperties: false,
    },
    output: { schema: envelopeSchema, render: renderEnvelope },
    execute: wrap(async (args) => {
      const limit = optionalNumber(args, 'limit', 1, 50) ?? 10;
      const history = await runtime.history(limit);
      return {
        success: true,
        message: `已读取 ${history.published.length} 条发布记录、${history.ideas.length} 条候选主题`,
        retryable: false,
        data: history,
      };
    }, 'moments_get_history'),
  });

  tools.push({
    name: 'moments_preview',
    description: '生成待发布图文预览包（正文、图片、可见范围、内容哈希、审批状态）；不发送、不发表。',
    parameters: {
      type: 'object',
      properties: { taskId: { type: 'string' } },
      required: ['taskId'],
      additionalProperties: false,
    },
    output: { schema: envelopeSchema, render: renderEnvelope },
    execute: wrap(async (args) => {
      const taskId = requiredString(args, 'taskId', 120);
      const preview = await runtime.preview(taskId);
      return {
        success: true,
        taskId,
        status: preview.state,
        message: '预览包已生成（未发布）',
        retryable: false,
        data: preview,
      };
    }, 'moments_preview'),
  });

  tools.push({
    name: 'moments_request_approval',
    description:
      '为待审批任务创建一次性审批请求。审批与文案、图片清单、可见范围、目标账号绑定；Agent 不能自行批准。',
    parameters: {
      type: 'object',
      properties: { taskId: { type: 'string' } },
      required: ['taskId'],
      additionalProperties: false,
    },
    output: { schema: envelopeSchema, render: renderEnvelope },
    timeoutMs: 60_000,
    execute: wrap(async (args) => {
      const taskId = requiredString(args, 'taskId', 120);
      const result = await runtime.requestApproval(taskId);
      return {
        success: true,
        taskId,
        status: 'READY_FOR_APPROVAL',
        message: result.delivered
          ? '审批请求已发送给所有者，等待明确批准；Agent 无权自行批准'
          : '审批请求已创建，等待所有者在本机管理页或微信命令中批准；Agent 无权自行批准',
        retryable: false,
        data: {
          approvalId: result.approval.approvalId,
          contentHash: result.approval.contentHash,
          assetManifestHash: result.approval.assetManifestHash,
          visibility: result.approval.visibility,
          expiresAt: result.approval.expiresAt,
          ownerId: result.approval.ownerId,
        },
      };
    }, 'moments_request_approval'),
  });

  tools.push({
    name: 'moments_get_status',
    description: '读取系统状态、任务队列、待审批、图片任务与账号确认状态。',
    parameters: {
      type: 'object',
      properties: { taskId: { type: 'string' } },
      additionalProperties: false,
    },
    output: { schema: envelopeSchema, render: renderEnvelope },
    execute: wrap(async (args) => {
      const taskId = optionalString(args, 'taskId', 120);
      const status = await runtime.status(taskId);
      return {
        success: true,
        taskId,
        status: status.task?.state,
        message: '状态已读取',
        retryable: false,
        data: status,
      };
    }, 'moments_get_status'),
  });

  tools.push({
    name: 'moments_cancel_task',
    description: '取消未发表的发布任务；已点击发表的 UNCERTAIN 任务不可取消，必须先人工核对。',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
    output: { schema: envelopeSchema, render: renderEnvelope },
    execute: wrap(async (args) => {
      const taskId = requiredString(args, 'taskId', 120);
      const reason = optionalString(args, 'reason', 500) ?? 'Agent 请求取消';
      const task = await runtime.cancelTask(taskId, reason, 'agent');
      return {
        success: true,
        taskId,
        status: task.state,
        message: '任务已取消（未发表）',
        retryable: false,
        data: task,
      };
    }, 'moments_cancel_task'),
  });

  tools.push({
    name: 'moments_prepare_desktop',
    description:
      '在 Windows 微信中打开朋友圈编辑界面、填入已审批图文并截图，但绝不点击发表。需要审批通过且桌面执行器可用。',
    parameters: {
      type: 'object',
      properties: { taskId: { type: 'string' } },
      required: ['taskId'],
      additionalProperties: false,
    },
    output: { schema: envelopeSchema, render: renderEnvelope },
    timeoutMs: 180_000,
    execute: wrap(async (args) => {
      const taskId = requiredString(args, 'taskId', 120);
      const result = await runtime.prepareDesktop(taskId);
      return {
        success: true,
        taskId,
        status: result.task.state,
        message: result.idempotent ? '任务已准备完成（幂等）' : '图文准备完成，未点击发表',
        retryable: false,
        data: {
          attemptId: result.attempt.attemptId,
          screenshotPath: result.screenshotPath,
          textMatched: result.textMatched,
          imageCount: result.imageCount,
          warnings: result.warnings,
        },
      };
    }, 'moments_prepare_desktop'),
  });

  tools.push({
    name: 'moments_publish',
    description:
      '在所有者有效审批前提下执行发表。默认 PREPARE_ONLY 会拒绝；UNCERTAIN 禁止自动重试。只有所有者在管理页/命令中批准后才允许。',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        approvalId: { type: 'string', description: '可选的审批 ID；不填则使用该任务已批准的审批' },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
    output: { schema: envelopeSchema, render: renderEnvelope },
    timeoutMs: 240_000,
    execute: wrap(async (args) => {
      const taskId = requiredString(args, 'taskId', 120);
      const approvalId = optionalString(args, 'approvalId', 120);
      const result = await runtime.publish(taskId, approvalId);
      return {
        success: !result.uncertain,
        taskId,
        status: result.task.state,
        message: result.uncertain
          ? '已点击发表但无法确认结果，进入 UNCERTAIN；禁止自动重试，请人工核对朋友圈'
          : result.message,
        errorCode: result.uncertain ? 'UNCERTAIN_REQUIRES_MANUAL_CHECK' : undefined,
        retryable: false,
        data: {
          attemptId: result.attempt.attemptId,
          submitted: result.submitted,
          verified: result.verified,
          uncertain: result.uncertain,
        },
      };
    }, 'moments_publish'),
  });

  tools.push({
    name: 'moments_verify',
    description: '核验一次已点击的发布结果；确认成功才把 UNCERTAIN 收敛为 PUBLISHED。',
    parameters: {
      type: 'object',
      properties: { attemptId: { type: 'string' } },
      required: ['attemptId'],
      additionalProperties: false,
    },
    output: { schema: envelopeSchema, render: renderEnvelope },
    timeoutMs: 120_000,
    execute: wrap(async (args) => {
      const attemptId = requiredString(args, 'attemptId', 120);
      const result = await runtime.verify(attemptId);
      return {
        success: result.verification.verified,
        status: result.task.state,
        message: result.verification.verified ? '核验确认已发布' : '暂未核验到发布结果（保持原状态，不自动重试）',
        errorCode: result.verification.verified ? undefined : 'UNCERTAIN_REQUIRES_MANUAL_CHECK',
        retryable: false,
        data: { attemptId, verification: result.verification, taskState: result.task.state },
      };
    }, 'moments_verify'),
  });

  tools.push({
    name: 'moments_pause',
    description: '暂停系统：不创建新任务、不执行新的 GUI 发表；已开始但未发表的任务安全停止。',
    parameters: {
      type: 'object',
      properties: { reason: { type: 'string' } },
      additionalProperties: false,
    },
    output: { schema: envelopeSchema, render: renderEnvelope },
    execute: wrap(async (args) => {
      const reason = optionalString(args, 'reason', 300) ?? 'Agent 请求暂停';
      runtime.controlAction('pause', reason, 'owner');
      return { success: true, status: 'PAUSED', message: '已暂停（该操作由所有者意图发起；重新开始需显式恢复）', retryable: false };
    }, 'moments_pause'),
  });

  tools.push({
    name: 'moments_resume',
    description: '恢复被暂停的系统；Kill Switch 需要单独解除。',
    parameters: {
      type: 'object',
      properties: { reason: { type: 'string' } },
      additionalProperties: false,
    },
    output: { schema: envelopeSchema, render: renderEnvelope },
    execute: wrap(async (args) => {
      const reason = optionalString(args, 'reason', 300) ?? 'Agent 请求恢复';
      if (runtime.control.killSwitch) {
        throw new MomentsError('KILL_SWITCH_ACTIVE', 'Kill Switch 生效时不能恢复，请先由所有者解除');
      }
      runtime.controlAction('resume', reason, 'owner');
      return { success: true, status: 'RUNNING', message: '已恢复', retryable: false };
    }, 'moments_resume'),
  });

  return tools;
}
