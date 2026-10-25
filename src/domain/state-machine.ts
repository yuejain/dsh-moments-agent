/**
 * 发布工作流状态机。
 *
 * 唯一的迁移入口，所有业务代码都必须经过 `assertTransition` 或 `StateMachine.transition`。
 * 禁止直接 UPDATE moment_tasks.state 绕过状态机。
 */
import { MomentsError } from './result.js';
import { MOMENT_STATES, TERMINAL_STATES, type MomentState } from './types.js';

/** 合法迁移表。空数组表示终态。 */
const TRANSITIONS: Record<MomentState, readonly MomentState[]> = {
  IDEA_CREATED: ['DRAFTING', 'CANCELLED', 'EXPIRED'],
  DRAFTING: ['DRAFT_READY', 'FAILED', 'CANCELLED'],
  DRAFT_READY: ['DRAFTING', 'IMAGE_REQUIRED', 'REVIEWING', 'CANCELLED', 'EXPIRED'],
  IMAGE_REQUIRED: ['IMAGE_PENDING', 'IMAGE_READY', 'FAILED', 'CANCELLED', 'EXPIRED'],
  IMAGE_PENDING: ['IMAGE_READY', 'FAILED', 'CANCELLED', 'EXPIRED'],
  IMAGE_READY: ['DRAFTING', 'IMAGE_REQUIRED', 'REVIEWING', 'CANCELLED', 'EXPIRED'],
  REVIEWING: ['READY_FOR_APPROVAL', 'READY_TO_PUBLISH', 'DRAFTING', 'FAILED', 'CANCELLED'],
  READY_FOR_APPROVAL: ['DRAFTING', 'APPROVED', 'QUEUED', 'CANCELLED', 'EXPIRED'],
  READY_TO_PUBLISH: ['DRAFTING', 'READY_FOR_APPROVAL', 'QUEUED', 'CANCELLED', 'EXPIRED'],
  APPROVED: ['DRAFTING', 'QUEUED', 'CANCELLED', 'EXPIRED'],
  QUEUED: ['PREPARING', 'CANCELLED'],
  PREPARING: ['PREPARED', 'FAILED', 'QUEUED', 'CANCELLED'],
  PREPARED: ['PUBLISHING', 'CANCELLED', 'EXPIRED'],
  PUBLISHING: ['PUBLISHED', 'UNCERTAIN', 'FAILED'],
  PUBLISHED: [],
  UNCERTAIN: ['PUBLISHED', 'FAILED'],
  FAILED: [],
  CANCELLED: [],
  EXPIRED: [],
};

export type TransitionActor = 'owner' | 'agent' | 'scheduler' | 'desktop' | 'system';

export interface TransitionContext {
  readonly taskId: string;
  readonly actor: TransitionActor;
  readonly reason: string;
  readonly metadata?: Record<string, unknown>;
}

export interface TransitionEvent {
  readonly taskId: string;
  readonly previousState: MomentState;
  readonly nextState: MomentState;
  readonly at: string;
  readonly actor: TransitionActor;
  readonly reason: string;
  readonly metadata: Record<string, unknown>;
}

export function isMomentState(value: unknown): value is MomentState {
  return typeof value === 'string' && (MOMENT_STATES as readonly string[]).includes(value);
}

export function isTerminal(state: MomentState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function canTransition(from: MomentState, to: MomentState): boolean {
  if (from === to) return false;
  return TRANSITIONS[from].includes(to);
}

export function allowedNextStates(from: MomentState): readonly MomentState[] {
  return TRANSITIONS[from];
}

/**
 * 校验一次迁移；非法迁移抛出 STATE_TRANSITION_DENIED。
 * 该错误不可重试：状态机拒绝意味着调用顺序或持久化状态有误。
 */
export function assertTransition(from: MomentState, to: MomentState): void {
  if (!canTransition(from, to)) {
    throw new MomentsError(
      'STATE_TRANSITION_DENIED',
      `不允许的状态迁移：${from} -> ${to}`,
      { details: { from, to, allowed: TRANSITIONS[from] } },
    );
  }
}

/** 判断某状态是否已经产生过实际发布点击（用于 UNCERTAIN 保护）。 */
export function mayHaveSubmitted(state: MomentState): boolean {
  return state === 'PUBLISHING' || state === 'PUBLISHED' || state === 'UNCERTAIN';
}

/** 状态机服务：纯函数 + 事件构造，持久化由 Store 负责。 */
export class StateMachine {
  constructor(private readonly now: () => Date = () => new Date()) {}

  transition(current: MomentState, next: MomentState, context: TransitionContext): TransitionEvent {
    assertTransition(current, next);
    return {
      taskId: context.taskId,
      previousState: current,
      nextState: next,
      at: this.now().toISOString(),
      actor: context.actor,
      reason: context.reason,
      metadata: context.metadata ?? {},
    };
  }
}
