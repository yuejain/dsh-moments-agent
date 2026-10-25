/**
 * 管理 API「社交记忆」集成测试。
 *
 * 不连接真实微信 / 模型：用 MockWechat + MockLlm 驱动运行时，
 * AdminServer 绑定 127.0.0.1 随机高位端口 + 临时令牌文件，全部通过本机 HTTP 验证。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { MockLlm, MockWechat, createTestContext, chatMessage } from '../helpers/mock.mjs';
import { makeRuntime, silentLogger } from '../helpers/flow.mjs';
import { AdminServer } from '../../dist/admin/server.js';

const TOKEN_ENV = 'DSH_MOMENTS_ADMIN_TOKEN';
const TEST_TOKEN = `test-admin-token-${'x'.repeat(40)}`;

function tokenFromFile(tokenFile) {
  const fromEnv = process.env[TOKEN_ENV];
  if (fromEnv !== undefined && fromEnv.trim().length >= 32) return fromEnv.trim();
  return readFileSync(tokenFile, 'utf8').trim();
}

/** 写死测试令牌，避免依赖运行环境里的管理令牌。 */
function writeTestToken(tokenFile) {
  writeFileSync(tokenFile, `${TEST_TOKEN}\n`, { encoding: 'utf8' });
}

async function startAdminServer(runtime, tokenFile) {
  let lastError = new Error('无法启动管理服务');
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = 20000 + Math.floor(Math.random() * 30000);
    const server = new AdminServer({
      runtime,
      host: '127.0.0.1',
      port,
      tokenFile,
      logger: silentLogger,
    });
    try {
      await server.start();
      return { server, baseUrl: `http://127.0.0.1:${port}` };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      try {
        await server.stop();
      } catch {
        // 忽略未监听服务器的关闭错误
      }
    }
  }
  throw lastError;
}

function headersFor(token) {
  return { 'X-Moments-Token': token, 'Content-Type': 'application/json' };
}

async function requestJson(url, init) {
  const response = await fetch(url, init);
  return { status: response.status, body: await response.json() };
}

function findMember(view, impressionId) {
  for (const entry of view.conversations ?? []) {
    for (const member of entry.members ?? []) {
      if (member.impressionId === impressionId) return member;
    }
  }
  return null;
}

/** 1 个群聊 + 1 个私聊的 MockWechat；消息时间相对当前时钟，落在保留期内。 */
function createMockWechat() {
  return new MockWechat({
    accountId: 'wxid_test',
    ownWxid: 'wxid_owner',
    conversations: [
      { talker: 'talker_group_a', kind: 'group', displayName: '示例群' },
      { talker: 'talker_private_b', kind: 'private', displayName: '联系人C' },
    ],
    messages: {
      talker_group_a: [
        chatMessage({
          talker: 'talker_group_a',
          senderWxid: 'wxid_member_a',
          senderName: '联系人A',
          text: '这个本地模型的推理速度还可以吗？',
          minutesAgo: 30,
        }),
        chatMessage({
          talker: 'talker_group_a',
          senderWxid: 'wxid_member_b',
          senderName: '联系人B',
          text: '我觉得端侧已经够用了，延迟低不少',
          minutesAgo: 25,
        }),
        chatMessage({
          talker: 'talker_group_a',
          senderWxid: 'wxid_member_a',
          senderName: '联系人A',
          text: '嗯，那我周末也试试看效果如何',
          minutesAgo: 20,
        }),
        chatMessage({
          talker: 'talker_group_a',
          senderWxid: 'wxid_owner',
          senderName: '我',
          text: '好，回头把测试结果发群里',
          minutesAgo: 15,
          isSelf: true,
        }),
      ],
      talker_private_b: [
        chatMessage({
          talker: 'talker_private_b',
          senderWxid: 'wxid_friend_c',
          senderName: '联系人C',
          text: '周末有空一起吃饭吗？',
          minutesAgo: 10,
        }),
        chatMessage({
          talker: 'talker_private_b',
          senderWxid: 'wxid_friend_c',
          senderName: '联系人C',
          text: '顺便聊聊你最近在写的东西',
          minutesAgo: 8,
        }),
      ],
    },
  });
}

test('管理 API 暴露社交记忆：鉴权、同步、设置、修正与删除', async () => {
  const ctx = await createTestContext({
    // 关闭 LLM 提炼，走确定性降级，保证测试不依赖 MockLlm 队列。
    config: { chatMemory: { enabled: true, includePrivate: false, useLlmExtraction: false } },
    llm: new MockLlm(),
  });
  const tokenFile = path.join(ctx.dir, 'admin-token.txt');
  writeTestToken(tokenFile);
  const wechat = createMockWechat();
  const runtime = makeRuntime(ctx, { wechat, clock: () => new Date() });
  const { server, baseUrl } = await startAdminServer(runtime, tokenFile);
  const token = tokenFromFile(tokenFile);
  const headers = headersFor(token);
  try {
    // 内嵌管理页不需要令牌（令牌只保护 /api/*），但必须包含社交记忆区块且脚本可解析。
    const pageResponse = await fetch(`${baseUrl}/`);
    assert.equal(pageResponse.status, 200);
    const html = await pageResponse.text();
    assert.ok(html.includes('社交记忆'), '管理页应包含社交记忆区块');
    const scriptMatch = /<script>([\s\S]*)<\/script>/.exec(html);
    assert.ok(scriptMatch !== null, '管理页应有内嵌脚本');
    assert.doesNotThrow(() => new Function(scriptMatch[1]), '内嵌脚本必须是合法 JavaScript');

    // 无令牌访问一律 401，即使请求方法/路径正确。
    assert.equal((await fetch(`${baseUrl}/api/chat-memory`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/chat-memory/sync`, { method: 'POST' })).status, 401);

    // GET：启用状态 + 默认设置 + 空统计。
    const initial = await requestJson(`${baseUrl}/api/chat-memory`, { headers });
    assert.equal(initial.status, 200);
    assert.equal(initial.body.ok, true);
    assert.equal(initial.body.data.enabled, true);
    assert.equal(initial.body.data.settings.includePrivate, false);
    assert.equal(initial.body.data.settings.useLlmExtraction, false);
    assert.deepEqual(initial.body.data.stats, {
      conversations: 0,
      messages: 0,
      members: 0,
      lastSyncedAt: null,
    });
    assert.deepEqual(initial.body.data.conversations, []);

    // POST sync（includePrivate=false）：只同步群聊，私聊进入 skipped。
    const sync = await requestJson(`${baseUrl}/api/chat-memory/sync`, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    });
    assert.equal(sync.status, 200);
    assert.equal(sync.body.ok, true);
    assert.equal(sync.body.data.conversations, 1);
    assert.ok(sync.body.data.newMessages >= 3, '群聊消息应入库');
    assert.ok(sync.body.data.impressionsUpdated >= 1, '应有群成员人物印象');
    assert.ok(
      sync.body.data.skipped.some((skip) => /私聊|private/i.test(`${skip.label}${skip.reason}`)),
      '未开启 includePrivate 时私聊应被跳过',
    );
    assert.deepEqual(sync.body.data.errors, []);

    // GET：群聊已入库并带人物印象；未开启私聊的会话被记录为停用、且没有成员印象。
    const afterSync = await requestJson(`${baseUrl}/api/chat-memory`, { headers });
    const view = afterSync.body.data;
    assert.equal(view.conversations.length, 2, '群聊 + 待启用的私聊都会记录在所有者视图');
    const groupEntry = view.conversations.find((entry) => entry.conversation.kind === 'group');
    assert.ok(groupEntry, '群聊会话应存在');
    assert.equal(groupEntry.conversation.displayName, '示例群');
    assert.equal(groupEntry.conversation.label.length > 0, true);
    assert.equal(groupEntry.conversation.enabled, true);
    // 管理 API 不返回原始 talker / accountId（隐私边界由管理面兜底）。
    assert.equal(Object.hasOwn(groupEntry.conversation, 'talker'), false);
    assert.equal(Object.hasOwn(groupEntry.conversation, 'accountId'), false);
    assert.ok(groupEntry.members.length >= 1);
    const privateBefore = view.conversations.find((entry) => entry.conversation.kind === 'private');
    assert.ok(privateBefore, '私聊会话应被记录（enabled=false）');
    assert.equal(privateBefore.conversation.enabled, false);
    assert.equal(privateBefore.members.length, 0);
    assert.equal(view.stats.conversations, 2);
    assert.ok(view.stats.messages >= 3);
    assert.ok(view.stats.members >= 1);
    assert.equal(typeof view.stats.lastSyncedAt, 'string');
    const target = groupEntry.members[0];
    assert.ok(target.impressionId.startsWith('imp_'));
    assert.ok(target.alias.length > 0);
    assert.ok(target.displayName.length > 0);
    assert.ok(target.summary.length > 0);

    // POST settings：保存后立即生效，并影响后续同步。
    const saved = await requestJson(`${baseUrl}/api/chat-memory/settings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ includePrivate: true }),
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.data.includePrivate, true);
    assert.equal(runtime.getConfig().chatMemory.includePrivate, true);

    const secondSync = await requestJson(`${baseUrl}/api/chat-memory/sync`, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    });
    assert.equal(secondSync.status, 200);
    assert.equal(secondSync.body.data.conversations, 2, '开启 includePrivate 后应同步私聊');
    const afterSecondSync = await requestJson(`${baseUrl}/api/chat-memory`, { headers });
    const view2 = afterSecondSync.body.data;
    assert.equal(view2.conversations.length, 2);
    const privateEntry = view2.conversations.find((entry) => entry.conversation.kind === 'private');
    assert.ok(privateEntry, '私聊会话应出现在所有者视图');
    assert.equal(privateEntry.conversation.displayName, '联系人C');
    assert.ok(privateEntry.members.length >= 1);

    // 非法设置字段整体拒绝，不产生部分保存。
    const badSettings = await requestJson(`${baseUrl}/api/chat-memory/settings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ bogus: true }),
    });
    assert.equal(badSettings.status, 400);
    assert.equal(badSettings.body.errorCode, 'INVALID_INPUT');
    const settingsAfter = (await requestJson(`${baseUrl}/api/chat-memory`, { headers })).body.data.settings;
    assert.equal(settingsAfter.includePrivate, true);

    // PATCH：所有者修正摘要后 GET 可见且状态为 owner_edited。
    const patched = await requestJson(
      `${baseUrl}/api/chat-memory/members/${encodeURIComponent(target.impressionId)}`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ summary: '所有者修正后的测试摘要' }),
      },
    );
    assert.equal(patched.status, 200);
    assert.equal(patched.body.ok, true);
    assert.equal(patched.body.data.summary, '所有者修正后的测试摘要');
    assert.equal(patched.body.data.status, 'owner_edited');
    const afterPatch = (await requestJson(`${baseUrl}/api/chat-memory`, { headers })).body.data;
    const patchedMember = findMember(afterPatch, target.impressionId);
    assert.ok(patchedMember !== null);
    assert.equal(patchedMember.summary, '所有者修正后的测试摘要');
    assert.equal(patchedMember.status, 'owner_edited');

    // PATCH：非法别名 -> 400 INVALID_INPUT；未知 ID -> 404 NOT_FOUND。
    const badAlias = await requestJson(
      `${baseUrl}/api/chat-memory/members/${encodeURIComponent(target.impressionId)}`,
      { method: 'PATCH', headers, body: JSON.stringify({ alias: '这个别名明显超过了八个字符' }) },
    );
    assert.equal(badAlias.status, 400);
    assert.equal(badAlias.body.errorCode, 'INVALID_INPUT');
    const missingPatch = await requestJson(
      `${baseUrl}/api/chat-memory/members/imp_missing`,
      { method: 'PATCH', headers, body: JSON.stringify({ summary: '不存在的人物' }) },
    );
    assert.equal(missingPatch.status, 404);
    assert.equal(missingPatch.body.errorCode, 'NOT_FOUND');

    // DELETE member：删除后 GET 不可见，重复删除 -> 404。
    const deleted = await requestJson(
      `${baseUrl}/api/chat-memory/members/${encodeURIComponent(target.impressionId)}`,
      { method: 'DELETE', headers },
    );
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.ok, true);
    const afterDelete = (await requestJson(`${baseUrl}/api/chat-memory`, { headers })).body.data;
    assert.equal(findMember(afterDelete, target.impressionId), null);
    const deletedAgain = await requestJson(
      `${baseUrl}/api/chat-memory/members/${encodeURIComponent(target.impressionId)}`,
      { method: 'DELETE', headers },
    );
    assert.equal(deletedAgain.status, 404);
    assert.equal(deletedAgain.body.errorCode, 'NOT_FOUND');

    // DELETE conversation：清除私聊消息与印象，统计回落。
    const purged = await requestJson(
      `${baseUrl}/api/chat-memory/conversations/${encodeURIComponent(privateEntry.conversation.conversationKey)}`,
      { method: 'DELETE', headers },
    );
    assert.equal(purged.status, 200);
    assert.equal(purged.body.ok, true);
    assert.ok(purged.body.data.messages >= 2);
    assert.ok(purged.body.data.members >= 1);
    const finalView = (await requestJson(`${baseUrl}/api/chat-memory`, { headers })).body.data;
    assert.equal(finalView.conversations.length, 1);
    assert.equal(finalView.conversations.some((entry) => entry.conversation.kind === 'private'), false);
    assert.equal(finalView.stats.conversations, 1);
  } finally {
    await server.stop();
    ctx.cleanup();
  }
});

test('社交记忆未启用时管理 API 明确拒绝同步与修正', async () => {
  const ctx = await createTestContext();
  const tokenFile = path.join(ctx.dir, 'admin-token.txt');
  writeTestToken(tokenFile);
  // 默认 chatMemory.enabled=false，且不提供 WeChatAgent。
  const runtime = makeRuntime(ctx);
  const { server, baseUrl } = await startAdminServer(runtime, tokenFile);
  const token = tokenFromFile(tokenFile);
  const headers = headersFor(token);
  try {
    // 禁用时 GET 仍可读，返回 enabled=false 与空统计（管理页据此展示引导）。
    const initial = await requestJson(`${baseUrl}/api/chat-memory`, { headers });
    assert.equal(initial.status, 200);
    assert.equal(initial.body.data.enabled, false);
    assert.equal(initial.body.data.stats.conversations, 0);
    assert.deepEqual(initial.body.data.conversations, []);

    const sync = await requestJson(`${baseUrl}/api/chat-memory/sync`, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    });
    assert.equal(sync.status, 400);
    assert.equal(sync.body.errorCode, 'CHAT_MEMORY_DISABLED');

    const patch = await requestJson(`${baseUrl}/api/chat-memory/members/imp_missing`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ summary: '未启用时的修正' }),
    });
    assert.equal(patch.status, 400);
    assert.equal(patch.body.errorCode, 'CHAT_MEMORY_DISABLED');

    // 打开开关但 WeChatAgent 不可用：同步返回 WECHAT_UNAVAILABLE，不静默成功。
    const enabled = await requestJson(`${baseUrl}/api/chat-memory/settings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ enabled: true, useLlmExtraction: false }),
    });
    assert.equal(enabled.status, 200);
    assert.equal(enabled.body.data.enabled, true);
    const syncUnavailable = await requestJson(`${baseUrl}/api/chat-memory/sync`, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    });
    assert.equal(syncUnavailable.status, 400);
    assert.equal(syncUnavailable.body.errorCode, 'WECHAT_UNAVAILABLE');
  } finally {
    await server.stop();
    ctx.cleanup();
  }
});
