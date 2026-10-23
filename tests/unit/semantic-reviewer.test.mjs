import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewImageSemantics } from '../../dist/image/semantic-reviewer.js';
import { DshLlmClient } from '../../dist/adapters/dsh/llm.js';
import { makePatternPng } from '../../fixtures/images/png.mjs';

const input = { bytes: makePatternPng(64, 64), mime: 'image/png', text: '合成几何图案', source: 'owner_upload', license: 'owner' };
const accepted = { passed: true, relevantToText: true, containsPersonalInfo: false, misleading: false, qualityScore: 0.9, ocrText: '', notes: ['几何图案'] };
test('视觉审核保留明确结论；隐私、图文不符、低质量、拒绝及错误均不能通过', async () => {
  for (const [patch, expected] of [[{}, true], [{ passed: false }, false], [{ containsPersonalInfo: true }, false],
    [{ relevantToText: false }, false], [{ misleading: true }, false], [{ qualityScore: 0.1 }, false], [{ passed: null }, false]]) {
    const result = await reviewImageSemantics({ complete: async (request) => {
      assert.equal(request.messages[0].images[0].bytes, input.bytes);
      return { text: JSON.stringify({ ...accepted, ...patch }), model: 'mock-vision' };
    } }, input);
    assert.equal(result.passed, expected);
  }
  assert.equal((await reviewImageSemantics(undefined, input)).status, 'unavailable');
});

test('DSH 图片经附件服务接入，仅支持文本的模型不保存或上传图片', async () => {
  let modality = ['text', 'image']; let saved = 0; let calls = 0;
  const ref = { attachmentId: 'test-ref', mediaType: 'image/png', bytes: input.bytes.length, width: 64, height: 64 };
  const service = { listProviders: () => [{ id: 'test' }], resolveModelInfo: async () => ({ id: 'model', inputModalities: modality }),
    async *stream(request) { calls++; assert.deepEqual(request.messages[0].content[1], { type: 'image', attachment: ref });
      yield { type: 'text-delta', text: '{}' }; yield { type: 'finish', reason: { kind: 'stop' } }; } };
  const llm = new DshLlmClient({ service, provider: 'test', model: 'model', temperature: 0.1, maxTokens: 100, timeoutMs: 1000,
    attachments: { saveImages: async (images) => { saved++; assert.equal(images[0].data, input.bytes); return [ref]; } } });
  const request = { messages: [{ role: 'user', content: '审核', images: [{ bytes: input.bytes, mediaType: input.mime }] }] };
  await llm.complete(request);
  modality = ['text'];
  await assert.rejects(() => llm.complete(request));
  assert.equal(saved, 1); assert.equal(calls, 1);
});
