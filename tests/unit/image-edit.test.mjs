import test from 'node:test';
import assert from 'node:assert/strict';
import { ManualSubscriptionBridge } from '../../dist/image/providers/manual-subscription.js';
import { createImageFacade } from '../../dist/image/index.js';
import { makeRuntime } from '../helpers/flow.mjs';
import { createTestContext, MockLlm, IDEA_JSON, COMPOSE_JSON, REVIEW_JSON } from '../helpers/mock.mjs';
import { makePatternPng } from '../../fixtures/images/png.mjs';

test('人工编辑桥必须显式引用素材，并返回等待人工而非伪造编辑完成', async () => {
  const provider = new ManualSubscriptionBridge();
  const request = { taskId: 'image-task', referenceImages: [], prompt: '调整背景', operation: 'edit' };
  assert.equal((await provider.edit(request)).errorCode, 'REFERENCE_IMAGE_REQUIRED');
  const result = await provider.edit({ ...request, referenceImages: ['asset-test'] });
  assert.equal(result.status, 'awaiting_user');
  assert.deepEqual(result.usageMetadata.referenceImages, ['asset-test']);
  assert.equal((await provider.getStatus('image-task')).usageMetadata.operation, 'edit');
});

test('编辑从运行时到真实 Router 保留任务、参考素材和人工等待状态', async () => {
  const ctx = await createTestContext({ llm: new MockLlm({ idea: [IDEA_JSON], compose: [COMPOSE_JSON], review: [REVIEW_JSON] }) });
  try {
    const facade = createImageFacade({ config: ctx.config.images, store: ctx.store, dataDir: ctx.dir, packageRoot: process.cwd(), logger: ctx.logger });
    const runtime = makeRuntime(ctx, { image: facade });
    const created = await runtime.createIdea({ topic: '图像测试' });
    await runtime.composeDraft(created.task.taskId);
    const { asset } = await facade.importBytes({ bytes: makePatternPng(64, 64), declaredMime: 'image/png', source: 'owner_upload', license: 'owner', prompt: '', provider: 'local-import', model: '' });
    await assert.rejects(() => runtime.generateImageTask({ taskId: created.task.taskId, operation: 'edit', prompt: '编辑', referenceAssetIds: ['missing'] }));
    const result = await runtime.generateImageTask({ taskId: created.task.taskId, operation: 'edit', prompt: '调整背景', referenceAssetIds: [asset.assetId], provider: 'manual-subscription' });
    assert.equal(result.task.state, 'IMAGE_PENDING');
    assert.equal(result.requiresUserAction, true);
    assert.match(result.imageTask.prompt, new RegExp(asset.assetId));
  } finally { ctx.cleanup(); }
});
