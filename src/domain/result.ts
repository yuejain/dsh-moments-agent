/**
 * 领域错误与统一结果信封。
 *
 * 工具层必须把异常转换为 { success, taskId, status, data, errorCode, message, retryable }，
 * 便于模型与用户区分“可重试的本地失败”和“禁止自动重试的发布不确定状态”。
 */

export type MomentsErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'STATE_TRANSITION_DENIED'
  | 'POLICY_DENIED'
  | 'KILL_SWITCH_ACTIVE'
  | 'PAUSED'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_INVALID'
  | 'APPROVAL_EXPIRED'
  | 'APPROVAL_CONSUMED'
  | 'CONTENT_CHANGED'
  | 'ACCOUNT_MISMATCH'
  | 'PUBLISH_MODE_DISABLED'
  | 'DUPLICATE_PUBLISH'
  | 'UNCERTAIN_REQUIRES_MANUAL_CHECK'
  | 'WECHAT_UNAVAILABLE'
  | 'WECHAT_ACCOUNT_NOT_VERIFIED'
  | 'DESKTOP_UNAVAILABLE'
  | 'DESKTOP_UNSUPPORTED'
  | 'DESKTOP_PRECONDITION'
  | 'IMAGE_PROVIDER_UNAVAILABLE'
  | 'IMAGE_TASK_NOT_FOUND'
  | 'IMAGE_TASK_EXPIRED'
  | 'IMAGE_REVIEW_FAILED'
  | 'IMAGE_INVALID'
  | 'IMAGE_DUPLICATE'
  | 'IMAGE_PATH_DENIED'
  | 'LLM_UNAVAILABLE'
  | 'LLM_INVALID_OUTPUT'
  | 'CHAT_MEMORY_DISABLED'
  | 'CHAT_PRIVACY_LEAK'
  | 'SQLITE_UNAVAILABLE'
  | 'NOT_IMPLEMENTED'
  | 'INTERNAL_ERROR';

export class MomentsError extends Error {
  readonly code: MomentsErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: MomentsErrorCode,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'MomentsError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export function isMomentsError(error: unknown): error is MomentsError {
  return error instanceof MomentsError;
}

export interface ToolResultEnvelope<T = unknown> {
  readonly success: boolean;
  readonly taskId?: string;
  readonly status?: string;
  readonly data?: T;
  readonly errorCode?: MomentsErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

export function ok<T>(
  message: string,
  options: { taskId?: string; status?: string; data?: T } = {},
): ToolResultEnvelope<T> {
  const result: ToolResultEnvelope<T> = {
    success: true,
    message,
    retryable: false,
  };
  if (options.taskId !== undefined) return { ...result, taskId: options.taskId, status: options.status, data: options.data };
  return { ...result, status: options.status, data: options.data };
}

export function fail(
  code: MomentsErrorCode,
  message: string,
  options: { taskId?: string; status?: string; retryable?: boolean; data?: unknown } = {},
): ToolResultEnvelope {
  const result: ToolResultEnvelope = {
    success: false,
    message,
    errorCode: code,
    retryable: options.retryable ?? false,
  };
  return {
    ...result,
    ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
    ...(options.status === undefined ? {} : { status: options.status }),
    ...(options.data === undefined ? {} : { data: options.data }),
  };
}

/** 把任意异常转换为统一结果；未知异常不外泄堆栈与敏感信息。 */
export function errorToEnvelope(error: unknown, fallbackMessage = '内部错误'): ToolResultEnvelope {
  if (isMomentsError(error)) {
    return fail(error.code, error.message, { retryable: error.retryable, data: error.details });
  }
  const message = error instanceof Error && error.message ? error.message : fallbackMessage;
  return fail('INTERNAL_ERROR', message);
}
