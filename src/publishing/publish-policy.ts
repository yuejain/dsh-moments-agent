/**
 * 发布策略：在状态机之外再设一道“外部副作用门禁”。
 *
 * 状态机只保证流程合法；本策略保证：
 * - 默认 PREPARE_ONLY，绝不自动点击发表；
 * - 审批模式要求有效审批；直接模式要求内容与审核快照一致；
 * - 必须确认桌面执行器允许发布、当前微信账号与任务绑定账号一致；
 * - 幂等键相同的内容不得重复发布。
 */
import type {
  ApprovalRecord,
  PublishAttemptRecord,
  PublishDecision,
  PublishMode,
  TaskRecord,
} from '../domain/types.js';
import { MomentsError } from '../domain/result.js';
import type { MomentsConfig } from '../config.js';
import type { ApprovalSnapshot } from '../approval/approval-service.js';
import type { ControlState } from '../security/kill-switch.js';
import type { DesktopHealth, WechatClientStatus } from '../adapters/types.js';

export interface PublishPolicyContext {
  readonly config: MomentsConfig;
  readonly control: ControlState;
  readonly task: TaskRecord;
  readonly snapshot: ApprovalSnapshot;
  readonly approval: ApprovalRecord | null;
  readonly desktopHealth: DesktopHealth | null;
  readonly wechatStatus: WechatClientStatus | null;
  readonly duplicateContentHash: boolean;
  readonly now: Date;
}

/** 旧版环境变量读取工具保留兼容；三级模式由所有者配置控制，不再隐式降级。 */
export function autonomousPublishDeploymentAllowed(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.DSH_MOMENTS_ALLOW_AUTONOMOUS_PUBLISH === '1';
}

export function effectivePublishMode(
  config: MomentsConfig,
  env: Readonly<Record<string, string | undefined>> = process.env,
): PublishMode {
  // The owner-selected mode is authoritative; no hidden environment downgrade.
  return config.publishMode;
}

export class PublishPolicy {
  constructor(private readonly env: Readonly<Record<string, string | undefined>> = process.env) {}

  private baseChecks(context: PublishPolicyContext): { code: string; reason: string } | null {
    if (context.control.killSwitch || context.config.killSwitch) {
      return { code: 'KILL_SWITCH_ACTIVE', reason: '全局 Kill Switch 已启用，停止一切外部操作' };
    }
    if (context.control.paused) {
      return { code: 'PAUSED', reason: `系统已暂停：${context.control.pauseReason || '所有者暂停'}` };
    }
    if (context.task.accountId === null || context.task.accountId === '') {
      return { code: 'ACCOUNT_MISMATCH', reason: '任务没有绑定目标微信账号' };
    }
    if (context.snapshot.accountId !== context.task.accountId) {
      return { code: 'ACCOUNT_MISMATCH', reason: '当前账号与任务绑定账号不一致' };
    }
    if (context.duplicateContentHash) {
      return { code: 'DUPLICATE_PUBLISH', reason: '相同内容已经发布过，禁止重复发布' };
    }
    if (effectivePublishMode(context.config, this.env) !== 'APPROVAL_REQUIRED') {
      if (context.task.contentHash !== context.snapshot.contentHash ||
          context.task.assetManifestHash !== context.snapshot.assetManifestHash) {
        return { code: 'CONTENT_CHANGED', reason: '内容与审核通过时的快照不一致，需重新审核' };
      }
      return null;
    }
    if (context.approval === null) {
      return { code: 'APPROVAL_REQUIRED', reason: '没有已批准的审批记录' };
    }
    if (context.approval.status !== 'approved') {
      return { code: 'APPROVAL_REQUIRED', reason: `审批状态为 ${context.approval.status}` };
    }
    if (new Date(context.approval.expiresAt).getTime() <= context.now.getTime()) {
      return { code: 'APPROVAL_EXPIRED', reason: '审批已过期' };
    }
    if (context.approval.contentHash !== context.snapshot.contentHash) {
      return { code: 'CONTENT_CHANGED', reason: '审批后文案或图片发生变化' };
    }
    if (context.approval.assetManifestHash !== context.snapshot.assetManifestHash) {
      return { code: 'CONTENT_CHANGED', reason: '审批后图片清单发生变化' };
    }
    if (context.approval.visibility !== context.snapshot.visibility) {
      return { code: 'CONTENT_CHANGED', reason: '审批后可见范围发生变化' };
    }
    if (context.approval.accountId !== context.snapshot.accountId) {
      return { code: 'ACCOUNT_MISMATCH', reason: '审批绑定的账号与当前账号不一致' };
    }
    return null;
  }

  /** 准备阶段：不点击发表，但仍要求审批绑定正确、桌面可用。 */
  evaluatePrepare(context: PublishPolicyContext): PublishDecision {
    const base = this.baseChecks(context);
    if (base !== null) return { allowed: false, ...base };
    if (!context.config.desktopExecutor.enabled) {
      return { allowed: false, code: 'DESKTOP_UNAVAILABLE', reason: '桌面执行器未启用' };
    }
    if (context.desktopHealth === null || !context.desktopHealth.ok) {
      return {
        allowed: false,
        code: 'DESKTOP_UNAVAILABLE',
        reason: context.desktopHealth?.message ?? '桌面执行器健康检查失败',
      };
    }
    if (!context.desktopHealth.wechatInstalled) {
      return { allowed: false, code: 'DESKTOP_UNSUPPORTED', reason: '未检测到 Windows 微信客户端' };
    }
    return { allowed: true, code: 'OK', reason: '允许进入准备流程（不会点击发表）' };
  }

  /** 发布阶段：额外的模式、执行器与账号校验。 */
  evaluatePublish(context: PublishPolicyContext): PublishDecision {
    const mode = effectivePublishMode(context.config, this.env);
    if (mode === 'PREPARE_ONLY') {
      return {
        allowed: false,
        code: 'PUBLISH_MODE_DISABLED',
        reason: '当前发布模式为 PREPARE_ONLY，禁止点击发表',
      };
    }
    const base = this.baseChecks(context);
    if (base !== null) return { allowed: false, ...base };
    if (!context.config.desktopExecutor.enabled) {
      return { allowed: false, code: 'DESKTOP_UNAVAILABLE', reason: '桌面执行器未启用' };
    }
    if (context.desktopHealth === null || !context.desktopHealth.ok) {
      return { allowed: false, code: 'DESKTOP_UNAVAILABLE', reason: context.desktopHealth?.message ?? '执行器不可用' };
    }
    if (!context.desktopHealth.allowPublish) {
      return {
        allowed: false,
        code: 'PUBLISH_MODE_DISABLED',
        reason: '桌面执行器未以 --allow-publish 启动，拒绝点击发表',
      };
    }
    if (!context.desktopHealth.wechatInstalled) {
      return { allowed: false, code: 'DESKTOP_UNSUPPORTED', reason: '未检测到 Windows 微信客户端' };
    }
    if (context.wechatStatus === null || !context.wechatStatus.running) {
      return { allowed: false, code: 'DESKTOP_PRECONDITION', reason: '微信客户端未运行' };
    }
    if (!context.wechatStatus.loggedIn) {
      return { allowed: false, code: 'DESKTOP_PRECONDITION', reason: '微信客户端未登录' };
    }
    if (context.wechatStatus.accountId === null) {
      return { allowed: false, code: 'ACCOUNT_MISMATCH', reason: '无法确认当前登录账号' };
    }
    if (context.wechatStatus.accountId !== context.task.accountId) {
      return { allowed: false, code: 'ACCOUNT_MISMATCH', reason: '当前登录账号与审批账号不一致' };
    }
    if (!context.wechatStatus.supported) {
      return { allowed: false, code: 'DESKTOP_UNSUPPORTED', reason: '当前微信客户端版本未验证，拒绝自动发表' };
    }
    if (!context.wechatStatus.interactive || context.wechatStatus.locked) {
      return { allowed: false, code: 'DESKTOP_PRECONDITION', reason: '桌面不可交互或处于锁屏状态' };
    }
    return { allowed: true, code: 'OK', reason: '允许执行发表' };
  }

  /** 发布结果核验前置：只有已实际点击的尝试才允许核验。 */
  canVerify(attempt: PublishAttemptRecord, task: TaskRecord): PublishDecision {
    if (!['PUBLISHING', 'PUBLISHED', 'UNCERTAIN'].includes(attempt.state) && task.state !== 'PUBLISHING') {
      return { allowed: false, code: 'CONFLICT', reason: `尝试状态 ${attempt.state} 不需要核验` };
    }
    return { allowed: true, code: 'OK', reason: '允许核验' };
  }
}

export function assertPublishDecision(decision: PublishDecision): void {
  if (decision.allowed) return;
  const code = decision.code;
  const mapping: Record<string, string> = {
    KILL_SWITCH_ACTIVE: 'KILL_SWITCH_ACTIVE',
    PAUSED: 'PAUSED',
    APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
    APPROVAL_EXPIRED: 'APPROVAL_EXPIRED',
    CONTENT_CHANGED: 'CONTENT_CHANGED',
    ACCOUNT_MISMATCH: 'ACCOUNT_MISMATCH',
    DUPLICATE_PUBLISH: 'DUPLICATE_PUBLISH',
    PUBLISH_MODE_DISABLED: 'PUBLISH_MODE_DISABLED',
    DESKTOP_UNAVAILABLE: 'DESKTOP_UNAVAILABLE',
    DESKTOP_UNSUPPORTED: 'DESKTOP_UNSUPPORTED',
    DESKTOP_PRECONDITION: 'DESKTOP_PRECONDITION',
  };
  throw new MomentsError((mapping[code] ?? 'POLICY_DENIED') as MomentsError['code'], decision.reason, {
    details: { decisionCode: code },
  });
}
