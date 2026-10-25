import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTestContext,
  MockLlm,
  MockWechat,
  chatMessage,
  IDEA_JSON,
  COMPOSE_JSON,
  REVIEW_JSON,
} from '../helpers/mock.mjs';
import { makeRuntime } from '../helpers/flow.mjs';

const GROUP_TALKER = 'group_a';
const PRIVATE_TALKER = 'friend_b';
const GROUP_NAME = '示例群';
const PRIVATE_NAME = '示例好友';
const MEMBER_A = '示例成员甲';
const MEMBER_B = '示例成员乙';

const IMPRESSIONS_JSON = JSON.stringify({
  members: [
    {
      alias: '群友A',
      summary: '喜欢分享猫图，说话简短，爱接梗。',
      traits: ['爱玩梗', '表达简短'],
      topics: ['猫', '咖啡'],
      style: '短句、语气轻松',
      confidence: 0.72,
    },
    {
      alias: '群友B',
      summary: '经常提问，讨论时比较认真。',
      traits: ['喜欢提问', '认真讨论'],
      topics: ['工作'],
      style: '直接',
      confidence: 0.61,
    },
  ],
});

function groupMessages() {
  return [
    chatMessage({
      talker: GROUP_TALKER,
      senderWxid: 'wxid_member_a',
      senderName: MEMBER_A,
      text: '今天猫又把杯子推下去了，笑死',
      minutesAgo: 40,
    }),
    chatMessage({
      talker: GROUP_TALKER,
      senderWxid: 'wxid_member_b',
      senderName: MEMBER_B,
      text: '哈哈哈哈，猫就爱这样。你那只猫叫什么来着？',
      minutesAgo: 38,
    }),
    chatMessage({
      talker: GROUP_TALKER,
      senderWxid: 'wxid_member_a',
      senderName: MEMBER_A,
      text: '叫团团。顺便说新买的咖啡豆还挺香',
      minutesAgo: 30,
    }),
    chatMessage({
      talker: GROUP_TALKER,
      senderWxid: 'wxid_member_b',
      senderName: MEMBER_B,
      text: '咖啡豆什么牌子的？我也想换',
      minutesAgo: 28,
    }),
    chatMessage({
      talker: GROUP_TALKER,
      senderWxid: 'wxid_owner',
      senderName: '我',
      text: '我也想知道',
      minutesAgo: 25,
      isSelf: true,
    }),
  ];
}

function privateMessages() {
  return [
    chatMessage({
      talker: PRIVATE_TALKER,
      senderWxid: 'wxid_friend_b',
      senderName: PRIVATE_NAME,
      text: '周末要不要一起去看展',
      minutesAgo: 15,
    }),
  ];
}

function buildWechat() {
  return new MockWechat({
    conversations: [
      { talker: GROUP_TALKER, kind: 'group', displayName: GROUP_NAME },
      { talker: PRIVATE_TALKER, kind: 'private', displayName: PRIVATE_NAME },
    ],
    messages: {
      [GROUP_TALKER]: groupMessages(),
      [PRIVATE_TALKER]: privateMessages(),
    },
  });
}

async function setupChatRuntime(options = {}) {
  const llm = new MockLlm();
  llm.queues.other.push(...(options.extraction ?? [IMPRESSIONS_JSON]));
  const wechat = options.wechat ?? buildWechat();
  const context = await createTestContext({
    config: {
      chatMemory: {
        enabled: true,
        includePrivate: false,
        ...(options.chatMemory ?? {}),
      },
    },
    llm,
  });
  const runtime = makeRuntime(context, { llm, wechat, clock: () => new Date() });
  return { context, runtime, llm, wechat };
}

function callsWithPurpose(llm, purpose) {
  return llm.calls.filter((call) => (call.purpose ?? 'other') === purpose);
}

function promptText(call) {
  const system = typeof call.system === 'string' ? call.system : '';
  const messages = Array.isArray(call.messages) ? call.messages : [];
  return `${system}\n${messages.map((message) => String(message.content ?? '')).join('\n')}`;
}

test('集成：同步社交记忆只读群聊，视图区分所有者与 Agent', async () => {
  const { context, runtime, llm } = await setupChatRuntime();
  try {
    const result = await runtime.syncChatMemory();
    assert.equal(result.conversations, 1);
    assert.equal(result.newMessages, 5);
    assert.ok(result.impressionsUpdated >= 2, '应为两位群成员生成人物印象');
    assert.ok(
      result.skipped.some((item) => item.reason.includes('includePrivate')),
      '默认应跳过私聊',
    );

    const view = runtime.chatMemoryView();
    assert.equal(view.enabled, true);
    const groupView = view.conversations.find((item) => item.conversation.kind === 'group');
    assert.ok(groupView !== undefined, '应记录群聊会话');
    assert.equal(groupView.conversation.displayName, GROUP_NAME);
    assert.equal(groupView.members.length, 2);
    const privateView = view.conversations.find((item) => item.conversation.kind === 'private');
    assert.ok(privateView !== undefined, '私聊会话可以登记但默认不读取');
    assert.equal(privateView.conversation.enabled, false);
    assert.equal(privateView.members.length, 0);

    const agentView = runtime.agentChatMemoryView();
    const agentText = JSON.stringify(agentView);
    assert.equal(agentView.enabled, true);
    assert.ok(agentText.includes('群友A'), 'Agent 视图应包含别名');
    for (const secret of [GROUP_NAME, MEMBER_A, MEMBER_B, 'wxid_', '猫又把杯子']) {
      assert.equal(agentText.includes(secret), false, `Agent 视图不应包含 ${secret}`);
    }
    assert.ok(agentView.signals.length > 0, '应生成匿名聊天信号');
    for (const signal of agentView.signals) {
      for (const secret of [GROUP_NAME, MEMBER_A, MEMBER_B]) {
        assert.equal(signal.includes(secret), false, `聊天信号不应包含 ${secret}`);
      }
    }

    const extractionCalls = callsWithPurpose(llm, 'other');
    assert.ok(extractionCalls.length >= 1, '应有一次人物印象提炼调用');
    for (const call of extractionCalls) {
      const text = promptText(call);
      for (const secret of [GROUP_NAME, MEMBER_A, MEMBER_B, 'wxid_']) {
        assert.equal(text.includes(secret), false, `提炼提示词不应包含 ${secret}`);
      }
    }

    const second = await runtime.syncChatMemory();
    assert.equal(second.newMessages, 0, '重复同步应幂等');
  } finally {
    context.cleanup();
  }
});

test('集成：includePrivate 开启后最多读取显式允许的私聊', async () => {
  const { context, runtime } = await setupChatRuntime({
    chatMemory: { includePrivate: true },
  });
  try {
    const result = await runtime.syncChatMemory();
    assert.equal(result.conversations, 2);
    const view = runtime.chatMemoryView();
    const kinds = view.conversations.map((item) => item.conversation.kind).sort();
    assert.deepEqual(kinds, ['group', 'private']);
    for (const item of view.conversations) {
      assert.match(item.conversation.label, /^(群聊|私聊)[A-Z]$/);
    }
  } finally {
    context.cleanup();
  }
});

test('集成：选题与草稿使用匿名社交记忆，不含真实昵称', async () => {
  const { context, runtime, llm } = await setupChatRuntime();
  try {
    await runtime.syncChatMemory();
    llm.queues.idea.push(IDEA_JSON);
    const created = await runtime.createIdea({});
    assert.notEqual(created.task, null);

    const ideaCall = callsWithPurpose(llm, 'idea').at(-1);
    assert.ok(ideaCall !== undefined, '应有选题调用');
    const ideaPrompt = promptText(ideaCall);
    assert.ok(ideaPrompt.includes('chat-signal'), '选题提示词应带聊天信号边界');
    assert.ok(ideaPrompt.includes('群聊A'), '选题提示词应带匿名会话标签');
    for (const secret of [GROUP_NAME, MEMBER_A, MEMBER_B, 'wxid_']) {
      assert.equal(ideaPrompt.includes(secret), false, `选题提示词不应包含 ${secret}`);
    }

    llm.queues.compose.push(COMPOSE_JSON);
    llm.queues.review.push(REVIEW_JSON);
    const composed = await runtime.composeDraft(created.task.taskId);
    assert.ok(composed.draftText.length > 0);

    const composeCall = callsWithPurpose(llm, 'compose').at(-1);
    assert.ok(composeCall !== undefined, '应有文案调用');
    const composePrompt = promptText(composeCall);
    assert.ok(composePrompt.includes('social-memory'), '文案提示词应带社交记忆边界');
    assert.ok(composePrompt.includes('群友A'), '文案提示词应带匿名人物印象');
    for (const secret of [GROUP_NAME, MEMBER_A, MEMBER_B, 'wxid_']) {
      assert.equal(composePrompt.includes(secret), false, `文案提示词不应包含 ${secret}`);
    }
  } finally {
    context.cleanup();
  }
});

test('集成：草稿包含真实昵称时被硬门禁拒绝并写审计', async () => {
  const { context, runtime, llm } = await setupChatRuntime();
  try {
    await runtime.syncChatMemory();
    llm.queues.idea.push(IDEA_JSON);
    const created = await runtime.createIdea({});
    assert.notEqual(created.task, null);

    llm.queues.compose.push(
      JSON.stringify({
        text: `今天${MEMBER_A}说猫把杯子推下去了，我笑了好久。`,
        tone: '轻松',
      }),
    );
    await assert.rejects(
      () => runtime.composeDraft(created.task.taskId),
      (error) => error.code === 'CHAT_PRIVACY_LEAK',
    );
    assert.equal(context.store.getCurrentDraftForTask(created.task.taskId), undefined);
    const audit = context.store.listAudit({ taskId: created.task.taskId });
    assert.equal(audit.some((event) => event.action === 'draft_privacy_blocked'), true);
  } finally {
    context.cleanup();
  }
});

test('集成：社交记忆关闭时不读取聊天，也不影响正常选题', async () => {
  const llm = new MockLlm();
  const context = await createTestContext({
    config: { chatMemory: { enabled: false } },
    llm,
  });
  const wechat = buildWechat();
  const runtime = makeRuntime(context, { llm, wechat, clock: () => new Date() });
  try {
    await assert.rejects(
      () => runtime.syncChatMemory(),
      (error) => error.code === 'CHAT_MEMORY_DISABLED',
    );
    assert.equal(context.store.chatMemoryCounts().conversations, 0);
    assert.equal(wechat.calls.some((call) => call.method === 'listConversations'), false);

    llm.queues.idea.push(IDEA_JSON);
    const created = await runtime.createIdea({});
    assert.notEqual(created.task, null);
    const ideaPrompt = promptText(callsWithPurpose(llm, 'idea').at(-1));
    assert.equal(ideaPrompt.includes('chat-signal'), false);
  } finally {
    context.cleanup();
  }
});

test('集成：清除会话会同时删除消息与人物印象', async () => {
  const { context, runtime } = await setupChatRuntime();
  try {
    await runtime.syncChatMemory();
    const view = runtime.chatMemoryView();
    const groupView = view.conversations.find((item) => item.conversation.kind === 'group');
    assert.ok(groupView !== undefined);
    const conversationKey = groupView.conversation.conversationKey;
    assert.ok(view.stats.messages >= 5);

    const removed = runtime.purgeChatConversation(conversationKey);
    assert.ok(removed.messages >= 5);
    assert.ok(removed.members >= 2);
    const after = runtime.chatMemoryView();
    assert.equal(after.conversations.some((item) => item.conversation.conversationKey === conversationKey), false);
    assert.equal(after.conversations.every((item) => item.members.length === 0), true);
    assert.equal(after.stats.messages, 0);
    assert.equal(after.stats.members, 0);
  } finally {
    context.cleanup();
  }
});

test('集成：所有者手填印象含真实昵称被拒绝，历史泄漏字段不进入 Agent 视图', async () => {
  const { context, runtime } = await setupChatRuntime();
  try {
    await runtime.syncChatMemory();
    const view = runtime.chatMemoryView();
    const groupView = view.conversations.find((item) => item.conversation.kind === 'group');
    assert.ok(groupView !== undefined);
    const member = groupView.members[0];
    assert.ok(member !== undefined);
    assert.throws(
      () =>
        runtime.updateChatMemberImpression(
          member.impressionId,
          { summary: `${MEMBER_A}最近常聊爬山和装备` },
          'owner',
        ),
      (error) => error.code === 'CHAT_PRIVACY_LEAK',
    );

    // 模拟旧版本或直接入库留下的泄漏摘要：Agent 视图与工具返回值必须剔掉。
    const now = new Date();
    context.store.upsertMemberImpression({
      impressionId: 'imp_legacy',
      conversationKey: groupView.conversation.conversationKey,
      memberRef: 'legacy_member_ref',
      alias: '群友Z',
      displayName: MEMBER_A,
      summary: `${MEMBER_A}最近在聊爬山和装备`,
      traits: ['爱玩梗'],
      topics: ['爬山'],
      style: '',
      confidence: 0.5,
      evidenceCount: 3,
      status: 'owner_edited',
      source: 'owner',
      firstSeenAt: now.toISOString(),
      lastSeenAt: null,
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
    });
    const agentView = runtime.agentChatMemoryView();
    const legacy = agentView.conversations
      .flatMap((conversation) => conversation.members)
      .find((item) => item.impressionId === 'imp_legacy');
    assert.ok(legacy !== undefined);
    assert.equal(legacy.summary, '', '含真实昵称的摘要不应进入 Agent 视图');
    // 真实昵称仍保留在所有者视图，供管理页修正。
    const ownerView = runtime.chatMemoryView();
    const legacyOwner = ownerView.conversations
      .flatMap((conversation) => conversation.members)
      .find((item) => item.impressionId === 'imp_legacy');
    assert.ok(legacyOwner !== undefined);
    assert.equal(legacyOwner.displayName, MEMBER_A);
  } finally {
    context.cleanup();
  }
});

test('集成：泄漏门禁文本池覆盖跨会话最近消息，不按单会话截断', async () => {
  const llm = new MockLlm();
  const context = await createTestContext({
    config: { chatMemory: { enabled: true, useLlmExtraction: false } },
    llm,
  });
  const runtime = makeRuntime(context, { llm, clock: () => new Date() });
  try {
    const now = Date.now();
    const leakedText = '只有这句话才是独一无二的原文证据';
    for (let c = 0; c < 3; c += 1) {
      const conversationKey = `conv_${c}`;
      context.store.upsertChatConversation({
        conversationKey,
        kind: 'group',
        label: `群聊${'ABC'[c]}`,
        displayName: `示例群${c}`,
        talker: `talker_${c}`,
        accountId: 'wxid_test',
      });
      const messages = [];
      for (let i = 0; i < 205; i += 1) {
        messages.push({
          messageId: `m_${c}_${i}`,
          conversationKey,
          memberRef: `ref_${c}`,
          senderName: `成员${c}`,
          text: i === 0 && c === 0 ? leakedText : `会话${c}第${i}条普通占位内容`,
          sentAt: new Date(now - (205 - i) * 60_000).toISOString(),
          isSelf: false,
          ingestedAt: new Date(now - (3 - c) * 100_000 - (205 - i) * 1_000).toISOString(),
          expiresAt: new Date(now + 86_400_000).toISOString(),
        });
      }
      context.store.insertChatMessages(messages);
    }

    llm.queues.idea.push(IDEA_JSON);
    const created = await runtime.createIdea({});
    assert.notEqual(created.task, null);
    llm.queues.compose.push(JSON.stringify({ text: `今天又听到有人说${leakedText}。`, tone: '观察' }));
    await assert.rejects(
      () => runtime.composeDraft(created.task.taskId),
      (error) => error.code === 'CHAT_PRIVACY_LEAK',
    );
  } finally {
    context.cleanup();
  }
});
