/**
 * 社交记忆服务单元测试：同步 / 幂等 / 匿名提示词 / 视图 / 修正 / 清理 / 降级。
 * 使用 MockLlm + 自建 fake WeChat 适配器与内存 SQLite，不访问网络与真实微信。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, MockLlm } from '../helpers/mock.mjs';
import { ChatMemoryService, chatConversationKey } from '../../dist/memory/service.js';
import { MomentsError } from '../../dist/domain/result.js';

const ACCOUNT_ID = 'wxid_owner_account';
const GROUP_TALKER = '12345678@chatroom';
const GROUP_NAME = '周末爬山群';
const PRIVATE_TALKER = 'wxid_private_friend';
const PRIVATE_NAME = '私聊好友';
const GROUP2_TALKER = '87654321@chatroom';
const GROUP2_NAME = '工作交流群';
// 使用「当前时间」作为基准，保证服务注入时钟与 store 内部时钟一致；
// 消息时间相对基准偏移，便于测试近 7 天窗口与过期清理。
const NOW = new Date();
const BASE_TIME = NOW.getTime() - 3 * 60 * 60 * 1000;

function messageTime(offsetMinutes) {
  return new Date(BASE_TIME + offsetMinutes * 60 * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// 测试替身
// ---------------------------------------------------------------------------

function chatConfig(overrides = {}) {
  return {
    enabled: true,
    includePrivate: false,
    conversations: [],
    syncIntervalMinutes: 60,
    maxMessagesPerConversation: 100,
    retentionDays: 30,
    impressionTtlDays: 90,
    maxMembersPerConversation: 50,
    anonymizeInPrompts: true,
    useLlmExtraction: true,
    ...overrides,
  };
}

function makeLogger() {
  const records = [];
  const push = (level) => (message, meta) => records.push({ level, message, meta });
  return {
    records,
    impl: {
      debug: push('debug'),
      info: push('info'),
      warn: push('warn'),
      error: push('error'),
    },
  };
}

class FakeWechat {
  constructor(options = {}) {
    this.account = options.account === undefined
      ? { accountId: options.accountId ?? ACCOUNT_ID, ownWxid: 'wxid_self' }
      : options.account;
    this.conversations = options.conversations ?? [];
    this.messagesByTalker = options.messagesByTalker ?? {};
    this.failConversations = options.failConversations ?? false;
    this.failTalkers = options.failTalkers ?? [];
    this.calls = [];
  }

  async checkHealth() {
    return { status: 'ok', message: 'fake' };
  }

  async getAccount() {
    return this.account;
  }

  async sendText() {
    return { delivered: true };
  }

  async listOwnerMessages() {
    return [];
  }

  async fetchImage() {
    throw new Error('fake 适配器不支持图片');
  }

  async listConversations(limit) {
    this.calls.push({ method: 'listConversations', limit });
    if (this.failConversations) throw new Error('mock listConversations failure');
    return this.conversations.slice(0, limit);
  }

  async listConversationMessages(talker, limit) {
    this.calls.push({ method: 'listConversationMessages', talker, limit });
    if (this.failTalkers.includes(talker)) throw new Error('mock messages failure');
    return (this.messagesByTalker[talker] ?? []).slice(0, limit);
  }
}

function groupConversation() {
  return { talker: GROUP_TALKER, kind: 'group', displayName: GROUP_NAME };
}

function privateConversation() {
  return { talker: PRIVATE_TALKER, kind: 'private', displayName: PRIVATE_NAME };
}

function groupMessages() {
  return [
    {
      talker: GROUP_TALKER,
      messageId: 'm1',
      sentAt: messageTime(0),
      senderWxid: 'wxid_zhangsan',
      senderName: '张三',
      text: '周末去爬山吗？我新买了登山杖',
      isSelf: false,
    },
    {
      talker: GROUP_TALKER,
      messageId: 'm2',
      sentAt: messageTime(1),
      senderWxid: 'wxid_lisi',
      senderName: '李四',
      text: '哈哈哈 我上周刚去过 累死了',
      isSelf: false,
    },
    {
      talker: GROUP_TALKER,
      messageId: 'm3',
      sentAt: messageTime(2),
      senderWxid: 'wxid_self',
      senderName: '本人',
      text: '我这周有事，下周吧',
      isSelf: true,
    },
    {
      talker: GROUP_TALKER,
      messageId: 'm4',
      sentAt: messageTime(3),
      senderWxid: 'wxid_zhangsan',
      senderName: '张三',
      text: '手机号 13800138000，回头联系',
      isSelf: false,
    },
  ];
}

function extractionMembers(overrides = {}) {
  return [
    {
      alias: '群友A',
      summary: '在群里比较活跃，常用短句接话并主动约活动。',
      traits: ['爱玩梗', '表达简短'],
      topics: ['爬山', '装备'],
      style: '短句、轻松',
      confidence: 0.7,
      ...(overrides.A ?? {}),
    },
    {
      alias: '群友B',
      summary: '喜欢分享自己的经历和感受。',
      traits: ['乐于分享', '语气温和'],
      topics: ['旅行'],
      style: '口语化',
      confidence: 0.5,
      ...(overrides.B ?? {}),
    },
  ];
}

function queueExtraction(mockLlm, members = extractionMembers()) {
  mockLlm.queues.other.push(JSON.stringify({ members }));
}

async function setup(options = {}) {
  const mockLlm = options.llm ?? new MockLlm();
  const ctx = await createTestContext({ llm: mockLlm });
  const config = chatConfig(options.chat ?? {});
  const logger = makeLogger();
  const state = { adapter: options.adapter ?? new FakeWechat() };
  const service = new ChatMemoryService({
    store: ctx.store,
    config: () => config,
    wechat: () => state.adapter,
    llm: mockLlm,
    logger: logger.impl,
    clock: options.clock ?? (() => NOW),
  });
  return {
    store: ctx.store,
    config,
    logger,
    service,
    state,
    mockLlm,
    cleanup: () => ctx.cleanup(),
  };
}

function promptText(mockLlm) {
  return mockLlm.calls
    .map((call) => `${call.system ?? ''}\n${(call.messages ?? []).map((message) => message.content).join('\n')}`)
    .join('\n');
}

function loggerText(logger) {
  return JSON.stringify(logger.records);
}

function captureError(fn, expectedCode) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof MomentsError, '应抛出 MomentsError');
    if (expectedCode !== undefined) assert.equal(error.code, expectedCode);
    return error;
  }
  assert.fail(`预期抛出 ${expectedCode ?? '错误'}，但没有抛出`);
}

// ---------------------------------------------------------------------------
// 同步基础
// ---------------------------------------------------------------------------

test('同步：匿名提示词、幂等、所有者/Agent 视图隔离', async (t) => {
  const env = await setup({
    adapter: new FakeWechat({
      conversations: [groupConversation()],
      messagesByTalker: { [GROUP_TALKER]: groupMessages() },
    }),
  });
  t.after(() => env.cleanup());
  queueExtraction(env.mockLlm);

  const first = await env.service.sync();
  assert.deepEqual(first.skipped, []);
  assert.deepEqual(first.errors, []);
  assert.equal(first.conversations, 1);
  assert.equal(first.newMessages, 4);
  assert.equal(first.impressionsUpdated, 2);

  // 提示词匿名化：真实昵称 / wxid / 群名 / 原始 talker / 手机号都不得出现
  const prompts = promptText(env.mockLlm);
  for (const secret of ['张三', '李四', 'wxid_zhangsan', 'wxid_lisi', GROUP_NAME, GROUP_TALKER, '13800138000']) {
    assert.equal(prompts.includes(secret), false, `提示词不得包含 ${secret}`);
  }
  assert.ok(prompts.includes('<untrusted-data'), '聊天文本必须用 wrapUntrusted 包裹');
  assert.ok(prompts.includes('群友A'));
  assert.ok(prompts.includes('群聊A'));

  // 本地数据库保留真实昵称（仅供所有者视图）
  const impressions = env.store.listMemberImpressions(chatConversationKey(ACCOUNT_ID, GROUP_TALKER));
  assert.equal(impressions.length, 2);
  const byAlias = new Map(impressions.map((item) => [item.alias, item]));
  assert.equal(byAlias.get('群友A')?.displayName, '张三');
  assert.equal(byAlias.get('群友A')?.evidenceCount, 2);
  assert.equal(byAlias.get('群友B')?.evidenceCount, 1);
  assert.equal(byAlias.get('群友A')?.status, 'new');
  assert.ok(byAlias.get('群友A')?.summary.length > 0);

  // 所有者视图含真实昵称；Agent 视图不含
  const view = env.service.view();
  assert.equal(view.enabled, true);
  assert.equal(view.conversations.length, 1);
  assert.equal(view.conversations[0]?.conversation.displayName, GROUP_NAME);
  assert.equal(view.conversations[0]?.members.length, 2);
  const agentView = env.service.agentView();
  assert.equal(agentView.enabled, true);
  assert.equal(agentView.conversations[0]?.label, '群聊A');
  const agentJson = JSON.stringify(agentView);
  for (const secret of ['张三', '李四', 'wxid_zhangsan', GROUP_NAME, GROUP_TALKER, '13800138000']) {
    assert.equal(agentJson.includes(secret), false, `Agent 视图不得包含 ${secret}`);
  }

  // 重复同步幂等：没有新消息就不再调用模型
  const llmCallsAfterFirst = env.mockLlm.calls.length;
  const second = await env.service.sync();
  assert.equal(second.newMessages, 0);
  assert.equal(second.impressionsUpdated, 0);
  assert.equal(env.mockLlm.calls.length, llmCallsAfterFirst);

  // 审计只记录计数
  const audits = env.store.listAudit({ action: 'chat_memory_synced', limit: 10 });
  assert.equal(audits.length, 2);
  assert.equal(JSON.stringify(audits).includes('张三'), false);

  // 日志不含聊天内容 / 昵称
  const logs = loggerText(env.logger);
  for (const secret of ['张三', '李四', GROUP_NAME, '13800138000', '爬山']) {
    assert.equal(logs.includes(secret), false, `日志不得包含 ${secret}`);
  }
});

test('同步：私聊默认跳过，但会话记录落库且标记为未启用', async (t) => {
  const env = await setup({
    adapter: new FakeWechat({
      conversations: [groupConversation(), privateConversation()],
      messagesByTalker: {
        [GROUP_TALKER]: groupMessages(),
        [PRIVATE_TALKER]: [
          {
            talker: PRIVATE_TALKER,
            messageId: 'p1',
            sentAt: messageTime(30),
            senderWxid: 'wxid_private_friend',
            senderName: '私聊好友',
            text: '晚上一起吃饭吗',
            isSelf: false,
          },
        ],
      },
    }),
  });
  t.after(() => env.cleanup());
  queueExtraction(env.mockLlm);

  const result = await env.service.sync();
  assert.equal(result.conversations, 1);
  assert.equal(result.newMessages, 4);
  const privateSkip = result.skipped.find((item) => item.label === '私聊B');
  assert.ok(privateSkip);
  assert.ok(privateSkip.reason.includes('私聊'));

  const privateKey = chatConversationKey(ACCOUNT_ID, PRIVATE_TALKER);
  assert.equal(env.store.countChatMessages(privateKey), 0, '未开启私聊时不得读取/入库私聊消息');
  const conversations = env.store.listChatConversations();
  assert.equal(conversations.length, 2);
  assert.equal(conversations.find((item) => item.conversationKey === privateKey)?.enabled, false);
});

test('同步：conversations 白名单只同步命中会话', async (t) => {
  const env = await setup({
    chat: { conversations: [GROUP_NAME] },
    adapter: new FakeWechat({
      conversations: [
        groupConversation(),
        { talker: GROUP2_TALKER, kind: 'group', displayName: GROUP2_NAME },
      ],
      messagesByTalker: {
        [GROUP_TALKER]: groupMessages(),
        [GROUP2_TALKER]: groupMessages().map((message) => ({ ...message, talker: GROUP2_TALKER })),
      },
    }),
  });
  t.after(() => env.cleanup());
  queueExtraction(env.mockLlm);

  const result = await env.service.sync();
  assert.equal(result.conversations, 1);
  const skipped = result.skipped.find((item) => item.reason.includes('白名单'));
  assert.ok(skipped);
  const otherKey = chatConversationKey(ACCOUNT_ID, GROUP2_TALKER);
  assert.equal(env.store.countChatMessages(otherKey), 0);
  assert.equal(env.store.getChatConversation(otherKey), undefined, '白名单外会话不落库');
});

test('同步：单个会话读取失败只跳过，不中断其它会话', async (t) => {
  const env = await setup({
    adapter: new FakeWechat({
      conversations: [
        groupConversation(),
        { talker: GROUP2_TALKER, kind: 'group', displayName: GROUP2_NAME },
      ],
      messagesByTalker: {
        [GROUP2_TALKER]: groupMessages().map((message) => ({ ...message, talker: GROUP2_TALKER })),
      },
      failTalkers: [GROUP_TALKER],
    }),
  });
  t.after(() => env.cleanup());
  queueExtraction(env.mockLlm);

  const result = await env.service.sync();
  assert.equal(result.conversations, 1);
  assert.equal(result.newMessages, 4);
  const skip = result.skipped.find((item) => item.label === '群聊A');
  assert.ok(skip);
  assert.ok(skip.reason.includes('读取会话消息失败'));
  assert.equal(env.store.countChatMessages(chatConversationKey(ACCOUNT_ID, GROUP_TALKER)), 0);
  assert.equal(env.store.countChatMessages(chatConversationKey(ACCOUNT_ID, GROUP2_TALKER)), 4);
});

test('同步：禁用 / 微信不可用 / 账号未验证的错误码', async (t) => {
  const disabled = await setup({ chat: { enabled: false } });
  t.after(() => disabled.cleanup());
  await assert.rejects(
    () => disabled.service.sync(),
    (error) => error instanceof MomentsError && error.code === 'CHAT_MEMORY_DISABLED',
  );
  assert.throws(
    () => disabled.service.updateMember('imp_x', { summary: 'x' }, 'owner'),
    (error) => error instanceof MomentsError && error.code === 'CHAT_MEMORY_DISABLED',
  );
  await disabled.service.maybeAutoSync(); // 静默返回

  const noWechat = await setup();
  t.after(() => noWechat.cleanup());
  noWechat.state.adapter = null;
  await assert.rejects(
    () => noWechat.service.sync(),
    (error) => error instanceof MomentsError && error.code === 'WECHAT_UNAVAILABLE',
  );
  await noWechat.service.maybeAutoSync(); // 静默返回

  const unverified = await setup({ adapter: new FakeWechat({ account: null }) });
  t.after(() => unverified.cleanup());
  await assert.rejects(
    () => unverified.service.sync(),
    (error) => error instanceof MomentsError && error.code === 'WECHAT_ACCOUNT_NOT_VERIFIED',
  );

  const brokenList = await setup({ adapter: new FakeWechat({ failConversations: true }) });
  t.after(() => brokenList.cleanup());
  await assert.rejects(
    () => brokenList.service.sync(),
    (error) => error instanceof MomentsError && error.code === 'WECHAT_UNAVAILABLE',
  );
});

test('同步：LLM 提炼失败只记 errors，保留已有印象与本次消息', async (t) => {
  const adapter = new FakeWechat({
    conversations: [groupConversation()],
    messagesByTalker: { [GROUP_TALKER]: groupMessages() },
  });
  const env = await setup({ adapter });
  t.after(() => env.cleanup());
  queueExtraction(env.mockLlm);
  const first = await env.service.sync();
  assert.equal(first.impressionsUpdated, 2);
  const key = chatConversationKey(ACCOUNT_ID, GROUP_TALKER);
  const before = env.store.listMemberImpressions(key);
  const summaryBefore = before.find((item) => item.alias === '群友A')?.summary;

  adapter.messagesByTalker[GROUP_TALKER] = [
    ...groupMessages(),
    {
      talker: GROUP_TALKER,
      messageId: 'm5',
      sentAt: messageTime(10),
      senderWxid: 'wxid_zhangsan',
      senderName: '张三',
      text: '那就下周六吧',
      isSelf: false,
    },
  ];
  env.mockLlm.fail = true;
  const second = await env.service.sync();
  assert.equal(second.errors.length, 1);
  assert.ok(second.errors[0].includes('群聊A'));
  assert.equal(second.errors[0].includes('张三'), false);
  assert.ok(second.newMessages >= 1);

  const after = env.store.listMemberImpressions(key);
  assert.equal(after.length, before.length);
  assert.equal(after.find((item) => item.alias === '群友A')?.summary, summaryBefore);
});

test('同步：useLlmExtraction=false 时只做确定性统计，不调用模型', async (t) => {
  const env = await setup({
    chat: { useLlmExtraction: false },
    adapter: new FakeWechat({
      conversations: [groupConversation()],
      messagesByTalker: { [GROUP_TALKER]: groupMessages() },
    }),
  });
  t.after(() => env.cleanup());

  const result = await env.service.sync();
  assert.equal(result.impressionsUpdated, 2);
  assert.equal(env.mockLlm.calls.length, 0, '确定性降级不得调用 LLM');
  const impressions = env.store.listMemberImpressions(chatConversationKey(ACCOUNT_ID, GROUP_TALKER));
  for (const impression of impressions) {
    assert.ok(impression.confidence <= 0.35);
    assert.ok(impression.summary.includes('群聊A'));
    assert.equal(impression.summary.includes('张三'), false);
  }
});

test('同步：消息与印象按保留期 / TTL 过期清理', async (t) => {
  let now = NOW;
  const adapter = new FakeWechat({
    conversations: [groupConversation()],
    messagesByTalker: { [GROUP_TALKER]: groupMessages() },
  });
  const env = await setup({
    chat: { retentionDays: 1, impressionTtlDays: 1 },
    adapter,
    clock: () => now,
  });
  t.after(() => env.cleanup());
  queueExtraction(env.mockLlm);
  await env.service.sync();
  assert.equal(env.store.countChatMessages(), 4);
  assert.equal(env.store.countMemberImpressions(), 2);

  now = new Date(NOW.getTime() + 2 * 24 * 60 * 60 * 1000);
  adapter.messagesByTalker[GROUP_TALKER] = [];
  const second = await env.service.sync();
  assert.equal(second.newMessages, 0);
  assert.deepEqual(
    { messages: env.store.countChatMessages(), members: env.store.countMemberImpressions() },
    { messages: 0, members: 0 },
  );
});

test('maybeAutoSync：按 syncIntervalMinutes 限制频率，禁用/不可用时静默', async (t) => {
  let now = NOW;
  const adapter = new FakeWechat({
    conversations: [groupConversation()],
    messagesByTalker: { [GROUP_TALKER]: groupMessages() },
  });
  const env = await setup({ adapter, clock: () => now });
  t.after(() => env.cleanup());

  queueExtraction(env.mockLlm);
  await env.service.maybeAutoSync();
  assert.equal(env.store.countChatMessages(), 4);
  const callsAfterFirst = env.mockLlm.calls.length;

  adapter.messagesByTalker[GROUP_TALKER] = [
    ...groupMessages(),
    {
      talker: GROUP_TALKER,
      messageId: 'm5',
      sentAt: messageTime(10),
      senderWxid: 'wxid_zhangsan',
      senderName: '张三',
      text: '下周六见',
      isSelf: false,
    },
  ];
  await env.service.maybeAutoSync();
  assert.equal(env.store.countChatMessages(), 4, '未到同步间隔不得再次同步');
  assert.equal(env.mockLlm.calls.length, callsAfterFirst);

  now = new Date(NOW.getTime() + 61 * 60 * 1000);
  queueExtraction(env.mockLlm);
  await env.service.maybeAutoSync();
  assert.equal(env.store.countChatMessages(), 5);

  env.config.enabled = false;
  await env.service.maybeAutoSync();
  env.config.enabled = true;
  env.state.adapter = null;
  await env.service.maybeAutoSync();
});

// ---------------------------------------------------------------------------
// 泄漏门禁 / 弱参考
// ---------------------------------------------------------------------------

test('泄漏门禁：草稿含真实昵称或 8 字原文片段被拒绝', async (t) => {
  const env = await setup({
    adapter: new FakeWechat({
      conversations: [groupConversation()],
      messagesByTalker: { [GROUP_TALKER]: groupMessages() },
    }),
  });
  t.after(() => env.cleanup());
  queueExtraction(env.mockLlm);
  await env.service.sync();

  for (const draft of ['今天和群里的张三聊了聊', `${GROUP_NAME}又热闹起来了`]) {
    const error = captureError(() => env.service.assertNoLeak(draft, '草稿'), 'CHAT_PRIVACY_LEAK');
    assert.equal(error.message.includes('张三'), false);
  }
  const fragmentError = captureError(
    () => env.service.assertNoLeak('他说我上周刚去过累死', '草稿'),
    'CHAT_PRIVACY_LEAK',
  );
  assert.ok(fragmentError.details.reasons.length > 0);

  assert.doesNotThrow(() => env.service.assertNoLeak('端侧推理成本正在变化', '草稿'));
});

test('弱参考：ideaSignals ≤4 匿名、composeBrief ≤2000 匿名、禁用时为空', async (t) => {
  const env = await setup({
    adapter: new FakeWechat({
      conversations: [groupConversation()],
      messagesByTalker: { [GROUP_TALKER]: groupMessages() },
    }),
  });
  t.after(() => env.cleanup());
  queueExtraction(env.mockLlm);
  await env.service.sync();

  const signals = env.service.ideaSignals();
  assert.ok(signals.length >= 1 && signals.length <= 4);
  assert.ok(signals.some((signal) => signal.includes('群聊A')));
  for (const signal of signals) {
    assert.ok(signal.length <= 200);
    for (const secret of ['张三', '李四', GROUP_NAME, GROUP_TALKER]) {
      assert.equal(signal.includes(secret), false, `信号不得包含 ${secret}`);
    }
  }

  const brief = env.service.composeBrief();
  assert.ok(brief.length > 0);
  assert.ok(brief.length <= 2000);
  assert.ok(brief.includes('群聊A'));
  for (const secret of ['张三', '李四', GROUP_NAME, GROUP_TALKER, '13800138000']) {
    assert.equal(brief.includes(secret), false, `composeBrief 不得包含 ${secret}`);
  }

  env.config.enabled = false;
  assert.deepEqual(env.service.ideaSignals(), []);
  assert.equal(env.service.composeBrief(), '');
  const disabledView = env.service.agentView();
  assert.equal(disabledView.enabled, false);
  assert.deepEqual(disabledView.conversations, []);
  assert.deepEqual(disabledView.signals, []);
});

// ---------------------------------------------------------------------------
// 所有者 / Agent 修正
// ---------------------------------------------------------------------------

test('updateMember：owner 修正受保护，agent 只能改摘要/标签/话题/风格', async (t) => {
  const env = await setup({
    adapter: new FakeWechat({
      conversations: [groupConversation()],
      messagesByTalker: { [GROUP_TALKER]: groupMessages() },
    }),
  });
  t.after(() => env.cleanup());
  queueExtraction(env.mockLlm);
  await env.service.sync();
  const key = chatConversationKey(ACCOUNT_ID, GROUP_TALKER);
  const [first] = env.store.listMemberImpressions(key);
  assert.ok(first);
  const impressionId = first.impressionId;

  const ownerUpdated = env.service.updateMember(impressionId, { summary: '所有者写的摘要' }, 'owner');
  assert.equal(ownerUpdated.summary, '所有者写的摘要');
  assert.equal(ownerUpdated.status, 'owner_edited');
  assert.equal(ownerUpdated.source, 'owner');

  const aliasUpdated = env.service.updateMember(impressionId, { alias: '老张' }, 'owner');
  assert.equal(aliasUpdated.alias, '老张');
  assert.equal(env.service.agentView().conversations[0]?.members.some((item) => item.alias === '老张'), true);

  // Agent 更新：alias / status / evidenceCount 被忽略
  const agentUpdated = env.service.updateMember(
    impressionId,
    {
      alias: '不该生效',
      status: 'new',
      evidenceCount: 999,
      summary: 'Agent 补充的观察',
      traits: ['认真讨论'],
      style: '更克制',
    },
    'agent',
  );
  assert.equal(agentUpdated.alias, '老张');
  assert.equal(agentUpdated.status, 'owner_edited');
  assert.equal(agentUpdated.evidenceCount, aliasUpdated.evidenceCount);
  assert.equal(agentUpdated.summary, 'Agent 补充的观察');
  assert.equal(agentUpdated.source, 'agent');

  assert.throws(
    () => env.service.updateMember(impressionId, { traits: ['随便编的标签'] }, 'agent'),
    (error) => error instanceof MomentsError && error.code === 'INVALID_INPUT',
  );
  assert.throws(
    () => env.service.updateMember(impressionId, { summary: '张三今天又在群里约爬山' }, 'agent'),
    (error) => error instanceof MomentsError && error.code === 'CHAT_PRIVACY_LEAK',
  );

  // 所有者把别名改成别的成员已用的别名 → 冲突
  const [, second] = env.store.listMemberImpressions(key);
  assert.ok(second);
  assert.throws(
    () => env.service.updateMember(second.impressionId, { alias: '老张' }, 'owner'),
    (error) => error instanceof MomentsError && error.code === 'INVALID_INPUT',
  );
  assert.throws(
    () => env.service.updateMember('imp_missing', { summary: 'x' }, 'owner'),
    (error) => error instanceof MomentsError && error.code === 'NOT_FOUND',
  );
});

test('owner_edited 印象不被后续自动同步覆盖，证据仍可累计', async (t) => {
  const adapter = new FakeWechat({
    conversations: [groupConversation()],
    messagesByTalker: { [GROUP_TALKER]: groupMessages() },
  });
  const env = await setup({ adapter });
  t.after(() => env.cleanup());
  queueExtraction(env.mockLlm);
  await env.service.sync();
  const key = chatConversationKey(ACCOUNT_ID, GROUP_TALKER);
  const target = env.store.listMemberImpressions(key).find((item) => item.alias === '群友A');
  assert.ok(target);
  env.service.updateMember(target.impressionId, { summary: '所有者确认的摘要' }, 'owner');

  adapter.messagesByTalker[GROUP_TALKER] = [
    ...groupMessages(),
    {
      talker: GROUP_TALKER,
      messageId: 'm5',
      sentAt: messageTime(12),
      senderWxid: 'wxid_zhangsan',
      senderName: '张三',
      text: '下周六早上八点集合',
      isSelf: false,
    },
  ];
  queueExtraction(
    env.mockLlm,
    extractionMembers({
      A: { summary: '自动同步试图覆盖的摘要' },
      B: { summary: 'B 的新摘要' },
    }),
  );
  const second = await env.service.sync();
  assert.ok(second.impressionsUpdated >= 1);

  const afterTarget = env.store
    .listMemberImpressions(key)
    .find((item) => item.impressionId === target.impressionId);
  assert.ok(afterTarget);
  assert.equal(afterTarget.summary, '所有者确认的摘要');
  assert.equal(afterTarget.status, 'owner_edited');
  assert.equal(afterTarget.evidenceCount, 3);
});

// ---------------------------------------------------------------------------
// 清理
// ---------------------------------------------------------------------------

test('deleteMember / purgeConversation：删除印象与清除会话', async (t) => {
  const env = await setup({
    adapter: new FakeWechat({
      conversations: [groupConversation()],
      messagesByTalker: { [GROUP_TALKER]: groupMessages() },
    }),
  });
  t.after(() => env.cleanup());
  queueExtraction(env.mockLlm);
  await env.service.sync();
  const key = chatConversationKey(ACCOUNT_ID, GROUP_TALKER);
  const [first] = env.store.listMemberImpressions(key);
  assert.ok(first);

  env.service.deleteMember(first.impressionId);
  assert.equal(env.store.getMemberImpression(first.impressionId), undefined);
  assert.throws(
    () => env.service.deleteMember(first.impressionId),
    (error) => error instanceof MomentsError && error.code === 'NOT_FOUND',
  );

  const removed = env.service.purgeConversation(key);
  assert.deepEqual(removed, { messages: 4, members: 1 });
  assert.equal(env.store.getChatConversation(key), undefined);
  assert.equal(env.store.countChatMessages(key), 0);
  assert.equal(env.store.countMemberImpressions(key), 0);
});

test('purgeAll：清空全部社交记忆数据', async (t) => {
  const env = await setup({
    adapter: new FakeWechat({
      conversations: [groupConversation()],
      messagesByTalker: { [GROUP_TALKER]: groupMessages() },
    }),
  });
  t.after(() => env.cleanup());
  queueExtraction(env.mockLlm);
  await env.service.sync();
  assert.ok(env.store.chatMemoryCounts().messages > 0);

  env.service.purgeAll();
  assert.deepEqual(env.store.chatMemoryCounts(), { conversations: 0, messages: 0, members: 0 });
  assert.equal(env.service.view().conversations.length, 0);
  assert.deepEqual(env.service.ideaSignals(), []);
  assert.equal(env.service.composeBrief(), '');
});
