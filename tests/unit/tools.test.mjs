import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTools } from '../../dist/tools/index.js';
import { setupPrepared, makeRuntime } from '../helpers/flow.mjs';
import { createTestContext, MockLlm, IDEA_JSON, COMPOSE_JSON, REVIEW_JSON } from '../helpers/mock.mjs';

test('工具：注册清单包含全部必需工具且名称唯一', async () => {
  const context = await createTestContext();
  try {
    const runtime = makeRuntime(context);
    const tools = buildTools(runtime);
    const names = tools.map((tool) => tool.name);
    const required = [
      'moments_create_idea',
      'moments_compose_draft',
      'moments_select_images',
      'moments_generate_image_task',
      'moments_import_image',
      'moments_review_draft',
      'moments_get_history',
      'moments_preview',
      'moments_request_approval',
      'moments_get_status',
      'moments_cancel_task',
      'moments_prepare_desktop',
      'moments_publish',
      'moments_verify',
    ];
    for (const name of required) assert.equal(names.includes(name), true, `缺少工具 ${name}`);
    assert.equal(new Set(names).size, names.length);
    for (const tool of tools) {
      assert.equal(typeof tool.description, 'string');
      assert.equal(tool.parameters.type, 'object');
      assert.equal(typeof tool.output.render, 'function');
      const rendered = tool.output.render({}, { success: true, message: 'ok', retryable: false });
      assert.equal(Array.isArray(rendered), true);
      assert.equal(rendered[0].type, 'text');
    }
  } finally {
    context.cleanup();
  }
});

test('工具：非法参数返回 INVALID_INPUT 信封而非抛异常', async () => {
  const context = await createTestContext();
  try {
    const runtime = makeRuntime(context);
    const tools = buildTools(runtime);
    const status = tools.find((tool) => tool.name === 'moments_get_status');
    const result = await status.execute({ taskId: 123 }, {});
    assert.equal(result.success, false);
    assert.equal(result.errorCode, 'INVALID_INPUT');
    assert.equal(result.retryable, false);
  } finally {
    context.cleanup();
  }
});

test('工具：PREPARE_ONLY 下 moments_publish 返回明确错误码', async () => {
  const llm = new MockLlm({ idea: [IDEA_JSON], compose: [COMPOSE_JSON], review: [REVIEW_JSON, REVIEW_JSON] });
  const setup = await setupPrepared({ config: { publishMode: 'PREPARE_ONLY' }, llm });
  try {
    const tools = buildTools(setup.runtime);
    const publish = tools.find((tool) => tool.name === 'moments_publish');
    const result = await publish.execute({ taskId: setup.taskId }, {});
    assert.equal(result.success, false);
    assert.equal(result.errorCode, 'PUBLISH_MODE_DISABLED');
    assert.equal(setup.desktop.calls.filter((call) => call.method === 'publish').length, 0);
  } finally {
    setup.cleanup();
  }
});

test('工具：moments_get_status 与 moments_preview 返回结构化数据', async () => {
  const llm = new MockLlm({ idea: [IDEA_JSON], compose: [COMPOSE_JSON], review: [REVIEW_JSON, REVIEW_JSON] });
  const setup = await setupPrepared({ llm });
  try {
    const tools = buildTools(setup.runtime);
    const statusTool = tools.find((tool) => tool.name === 'moments_get_status');
    const status = await statusTool.execute({ taskId: setup.taskId }, {});
    assert.equal(status.success, true);
    assert.equal(status.data.task.taskId, setup.taskId);
    assert.equal(Array.isArray(status.data.pendingApprovals), true);

    const previewTool = tools.find((tool) => tool.name === 'moments_preview');
    const preview = await previewTool.execute({ taskId: setup.taskId }, {});
    assert.equal(preview.success, true);
    assert.equal(preview.data.taskId, setup.taskId);
    assert.equal(preview.data.approvalId, setup.approvalId);
    assert.equal(preview.data.contentHash.length, 64);
  } finally {
    setup.cleanup();
  }
});
