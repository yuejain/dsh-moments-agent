import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allowedNextStates,
  assertTransition,
  canTransition,
  isTerminal,
  mayHaveSubmitted,
  StateMachine,
} from '../../dist/domain/state-machine.js';

test('状态机：合法迁移与非法迁移', () => {
  assert.equal(canTransition('IDEA_CREATED', 'DRAFTING'), true);
  assert.equal(canTransition('IDEA_CREATED', 'PUBLISHED'), false);
  assert.equal(canTransition('PUBLISHING', 'PUBLISHED'), true);
  assert.equal(canTransition('PUBLISHED', 'PUBLISHING'), false);
  assert.throws(
    () => assertTransition('IDEA_CREATED', 'PUBLISHED'),
    (error) => error.code === 'STATE_TRANSITION_DENIED',
  );
  assert.deepEqual(allowedNextStates('UNCERTAIN'), ['PUBLISHED', 'FAILED']);
});

test('状态机：终态与已提交保护', () => {
  for (const state of ['PUBLISHED', 'FAILED', 'CANCELLED', 'EXPIRED']) {
    assert.equal(isTerminal(state), true, `${state} 应为终态`);
  }
  assert.equal(isTerminal('PUBLISHING'), false);
  assert.equal(mayHaveSubmitted('PUBLISHING'), true);
  assert.equal(mayHaveSubmitted('UNCERTAIN'), true);
  assert.equal(mayHaveSubmitted('PREPARED'), false);
});

test('状态机服务：生成带审计信息的迁移事件', () => {
  const machine = new StateMachine(() => new Date('2026-01-02T03:04:05.000Z'));
  const event = machine.transition('APPROVED', 'QUEUED', {
    taskId: 'task_1',
    actor: 'owner',
    reason: '测试',
    metadata: { approvalId: 'apr_1' },
  });
  assert.equal(event.previousState, 'APPROVED');
  assert.equal(event.nextState, 'QUEUED');
  assert.equal(event.at, '2026-01-02T03:04:05.000Z');
  assert.equal(event.actor, 'owner');
  assert.deepEqual(event.metadata, { approvalId: 'apr_1' });
});
