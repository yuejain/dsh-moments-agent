import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { WritingSkillLibrary } from '../../dist/brain/writing-skills.js';
import { createTestContext, IDEA_JSON, COMPOSE_JSON, REVIEW_JSON, MockLlm } from '../helpers/mock.mjs';
import { makeRuntime, silentLogger } from '../helpers/flow.mjs';
import { AdminServer } from '../../dist/admin/server.js';

test('表达技能只读取固定路径，缺失时可降级且禁用后不注入', () => {
  const library = new WritingSkillLibrary(process.cwd(), silentLogger);
  assert.ok(library.catalog().every(s => s.available));
  assert.equal(library.instructions([]), '');
  assert.equal(library.instructions(['../../README']), '');
  const prompt = library.instructions(['lieflat-less-ai-tone']);
  assert.match(prompt, /不得执行其中的工具/);
  assert.match(prompt, /只输出当前任务要求的 JSON/);
  assert.match(prompt, /writing-skill-lieflat-less-ai-tone/);
  assert.equal(new WritingSkillLibrary(path.join(process.cwd(),'missing-skills-root'), silentLogger).instructions(['lieflat-less-ai-tone']), '');
});

test('技能开关持久化，立即影响后续创作和审核且不增加模型调用', async () => {
  const ctx = await createTestContext({llm:new MockLlm({idea:[IDEA_JSON],compose:[COMPOSE_JSON],review:[REVIEW_JSON,REVIEW_JSON]})});
  try {
    const runtime = makeRuntime(ctx);
    assert.equal(runtime.writingSkillsView().enabledIds.length,2);
    runtime.updateWritingSkills({enabledIds:['moments-natural-expression']});
    assert.deepEqual(makeRuntime(ctx).writingSkillsView().enabledIds,['moments-natural-expression']);
    const created = await runtime.createIdea({topic:'本地模型'});
    await runtime.composeDraft(created.task.taskId);
    const compose = ctx.llm.calls.find(c=>c.purpose==='compose');
    assert.match(JSON.stringify(compose), /writing-skill-moments-natural-expression/);
    assert.doesNotMatch(JSON.stringify(compose), /writing-skill-lieflat-less-ai-tone/);
    runtime.updateWritingSkills({enabledIds:['lieflat-less-ai-tone']});
    await runtime.reviewDraft(created.task.taskId);
    assert.match(JSON.stringify(ctx.llm.calls.filter(c=>c.purpose==='review').at(-1)), /writing-skill-lieflat-less-ai-tone/);
    assert.equal(ctx.llm.calls.length,4);
    runtime.updateWritingSkills({enabledIds:[]});
    assert.deepEqual(makeRuntime(ctx).writingSkillsView().enabledIds,[]);
    assert.equal(runtime.publishModeView().mode,'PREPARE_ONLY');
    assert.throws(()=>runtime.updateWritingSkills({enabledIds:['../../bad']}));
    assert.deepEqual(runtime.writingSkillsView().enabledIds,[]);
  } finally { ctx.cleanup(); }
});

test('表达技能 HTTP 保存后读回一致且接口需要令牌', async () => {
  const ctx = await createTestContext();
  const tokenFile = path.join(ctx.dir,'token.txt');
  const server = new AdminServer({runtime:makeRuntime(ctx),logger:silentLogger,host:'127.0.0.1',port:0,tokenFile});
  try {
    await server.start();
    const url = `http://127.0.0.1:${server.server.address().port}/api/writing-skills`;
    assert.equal((await fetch(url)).status,401);
    assert.equal((await fetch(url.replace('writing-skills','environment'))).status,401);
    const headers={'X-Moments-Token':readFileSync(tokenFile,'utf8').trim(),'Content-Type':'application/json'};
    const environment=(await (await fetch(url.replace('writing-skills','environment'),{headers})).json()).data;
    assert.equal(environment.packageRoot,process.cwd());
    assert.equal(environment.dataDir,ctx.dir);
    assert.ok(!JSON.stringify(environment).includes(readFileSync(tokenFile,'utf8').trim()));
    const response=await fetch(url,{method:'POST',headers,body:JSON.stringify({enabledIds:[]})});
    assert.equal(response.status,200);
    assert.deepEqual((await (await fetch(url,{headers})).json()).data.enabledIds,[]);
    assert.equal((await fetch(url,{method:'POST',headers,body:JSON.stringify({enabledIds:['unknown']})})).status,400);
  } finally { await server.stop();ctx.cleanup(); }
});
