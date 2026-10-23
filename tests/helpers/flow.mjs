/**
 * 测试流程辅助：把任务推进到“已批准”或“已准备”状态。
 */
import { MomentsRuntime } from '../../dist/runtime.js';
import {
  MockLlm,
  MockOwnerChannel,
  MockDesktop,
  MockImageFacade,
  createTestContext,
  IDEA_JSON,
  COMPOSE_JSON,
  REVIEW_JSON,
} from './mock.mjs';

export const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

export function makeRuntime(context, overrides = {}) {
  return new MomentsRuntime({
    config: context.config,
    store: context.store,
    dataDir: context.dir,
    packageRoot: process.cwd(),
    logger: silentLogger,
    llm: context.llm,
    ownerChannel: context.channel,
    wechat: null,
    desktop: context.desktop,
    image: context.image,
    clock: () => new Date('2026-10-20T04:00:00.000Z'),
    version: 'test',
    ...overrides,
  });
}

export async function setupApproved(options = {}) {
  const context = await createTestContext({
    config: { publishMode: 'APPROVAL_REQUIRED', ...(options.config ?? {}) },
    llm:
      options.llm ??
      new MockLlm({ idea: [IDEA_JSON], compose: [COMPOSE_JSON], review: [REVIEW_JSON, REVIEW_JSON] }),
    desktop: options.desktop ?? new MockDesktop({ health: { allowPublish: true } }),
    image: options.image ?? new MockImageFacade(),
    channel: options.channel ?? new MockOwnerChannel(),
  });
  const runtime = makeRuntime(context, options.runtimeOverrides ?? {});
  const created = await runtime.createIdea({ topic: '为什么本地小模型值得被认真对待' });
  if (created.task === null) throw new Error(`创建想法失败：${created.reason}`);
  const taskId = created.task.taskId;
  await runtime.composeDraft(taskId);
  const reviewed = await runtime.reviewDraft(taskId);
  if (!reviewed.passed) throw new Error(`审核失败：${reviewed.notes.join(';')}`);
  const approval = await runtime.requestApproval(taskId);
  const decided = runtime.decideApproval(approval.approval.approvalId, 'approve', 'wechat_owner');
  return {
    ...context,
    runtime,
    taskId,
    approvalId: approval.approval.approvalId,
    approval: decided,
  };
}

export async function setupPrepared(options = {}) {
  const setup = await setupApproved(options);
  const prepared = await setup.runtime.prepareDesktop(setup.taskId);
  return { ...setup, prepared };
}
