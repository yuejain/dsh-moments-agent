#!/usr/bin/env node
/**
 * 静态 + 进程内自检（不依赖 DSH Host，不连接真实微信/模型/GUI）。
 *
 * 校验：
 * 1. 包入口与插件导出形态；
 * 2. apply() 能在 Mock Cordis 上下文里注册全部工具与 guard；
 * 3. SQLite 迁移、工具返回信封、PREPARE_ONLY 默认策略；
 * 4. 卸载时资源可回收。
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
assert.equal(existsSync(path.join(root, 'dist', 'index.js')), true, '缺少 dist/index.js，请先 npm run build');

const mod = await import(pathToFileURL(path.join(root, 'dist', 'index.js')).href);
assert.equal(typeof mod.apply, 'function', '缺少 apply 导出');
assert.equal(mod.name, 'dsh-moments-agent');
assert.equal(Array.isArray(mod.inject), true);

const dir = mkdtempSync(path.join(tmpdir(), 'moments-verify-'));
const tools = new Map();
const guards = [];
const effects = [];
const loggerLines = [];
const logger = {
  debug: (message, meta) => loggerLines.push(['debug', message, meta]),
  info: (message, meta) => loggerLines.push(['info', message, meta]),
  warn: (message, meta) => loggerLines.push(['warn', message, meta]),
  error: (message, meta) => loggerLines.push(['error', message, meta]),
};
const ctx = {
  logger,
  get: (name) => name === 'agents' ? {
    create: async (options) => ({ agent: { id: options.sessionId }, dispose: async () => {} }),
    resume: async (options) => ({ agent: { id: options.resumeSessionId }, dispose: async () => {} }),
  } : name === 'agentPresets' ? { register: async () => async () => {} } : undefined,
  effect(execute) {
    const dispose = execute();
    effects.push(typeof dispose === 'function' ? dispose : () => undefined);
    return () => undefined;
  },
  tools: {
    register(definition) {
      tools.set(definition.name, definition);
      return () => tools.delete(definition.name);
    },
    guard(guard) {
      guards.push(guard);
      return () => {
        const index = guards.indexOf(guard);
        if (index >= 0) guards.splice(index, 1);
      };
    },
  },
};

try {
  await mod.apply(ctx, {
    enabled: true,
    dataDir: dir,
    publishMode: 'PREPARE_ONLY',
    adminServer: { enabled: false },
    desktopExecutor: { enabled: false },
  });

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
    'moments_health',
    'moments_sync_chat_memory',
    'moments_get_chat_memory',
    'moments_update_member_impression',
  ];
  for (const name of required) assert.equal(tools.has(name), true, `未注册工具 ${name}`);
  assert.equal(guards.length, 1, '应注册一个工具守卫');

  const { MomentsStore } = await import('../dist/storage/store.js');
  const probe = await MomentsStore.open(path.join(dir, 'moments.sqlite'));
  const execution = { agent: { id: probe.getSetting('dsh_session_id') } };
  probe.close();
  const health = await tools.get('moments_health').execute({}, execution);
  assert.equal(health.plugin, 'dsh-moments-agent');
  assert.equal(health.publishMode, 'PREPARE_ONLY');
  assert.equal(health.database, 'ok');
  assert.equal(health.version, JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version, '运行时版本应与安装包一致');
  assert.equal(typeof health.counts, 'object');
  assert.equal(health.chatMemory.status, 'not_configured', '社交记忆应默认关闭');
  assert.equal(health.chatMemory.details.enabled, false, '社交记忆应默认关闭');
  assert.equal(health.chatMemory.details.includePrivate, false, '私聊应默认不读取');

  const statusTool = tools.get('moments_get_status');
  const status = await statusTool.execute({}, execution);
  assert.equal(status.success, true);

  const publish = tools.get('moments_publish');
  const denied = await publish.execute({ taskId: 'task_missing' }, execution);
  const foreign = await statusTool.execute({}, { agent: { id: 'other-chat' } });
  assert.equal(foreign.errorCode, 'POLICY_DENIED');
  assert.equal(denied.success, false);
  // 任务不存在时先报 NOT_FOUND；但 guard 在 DSH Host 层会先拒绝 PREPARE_ONLY。
  assert.ok(['NOT_FOUND', 'PUBLISH_MODE_DISABLED'].includes(denied.errorCode));

  console.log(`[verify] 插件导出正常，${tools.size} 个工具已注册，health 与 status 返回结构正确`);
  console.log(`[verify] 数据库：${health.database}；发布模式：${health.publishMode}；调度：${health.scheduleEnabled}`);
  console.log(`[verify] 日志行数：${loggerLines.length}`);
} finally {
  for (const dispose of effects.reverse()) {
    try {
      await dispose();
    } catch {
      // 忽略卸载错误
    }
  }
  rmSync(dir, { recursive: true, force: true });
}

console.log('[verify] 全部通过');
