#!/usr/bin/env node
/**
 * Mock 演示：不访问真实微信/模型/GUI，完整走一遍
 * 选题 -> 文案 -> 审核 -> 审批 -> 准备 -> 发表 -> 核验，并输出每一步状态。
 *
 * 运行：node scripts/demo-mock.mjs
 */
import { setupApproved } from '../tests/helpers/flow.mjs';

console.log('=== DSH Moments Agent · Mock 演示 ===');
console.log('（全部适配器为 Mock；不会向真实微信发送消息，也不会点击任何界面）\n');

const setup = await setupApproved();
try {
  const idea = setup.store.getIdeaByTask(setup.taskId);
  console.log(`1. 选题完成：任务 ${setup.taskId}，主题「${idea.topic}」`);

  const draft = setup.store.getCurrentDraftForTask(setup.taskId);
  console.log(`2. 草稿完成：v${draft.version}「${draft.text.slice(0, 40)}…」`);

  console.log(`3. 审核 + 审批：审批 ${setup.approvalId} 已由所有者批准，任务状态=${setup.store.requireTask(setup.taskId).state}`);

  const prepared = await setup.runtime.prepareDesktop(setup.taskId);
  console.log(`4. 桌面准备（未点击发表）：状态=${prepared.task.state} 截图=${prepared.screenshotPath}`);

  const published = await setup.runtime.publish(setup.taskId);
  console.log(`5. 发表：submitted=${published.submitted} verified=${published.verified} 状态=${published.task.state}`);

  const verification = await setup.runtime.verify(published.attempt.attemptId);
  console.log(`6. 核验：${verification.verification.method} verified=${verification.verification.verified}`);

  const history = await setup.runtime.history(5);
  console.log(`7. 历史：已发布 ${history.published.length} 条`);
  console.log(`\n审计事件数：${setup.store.listAudit({ taskId: setup.taskId }).length}`);
  console.log('=== 演示完成（Mock）===');
} finally {
  setup.cleanup();
}
