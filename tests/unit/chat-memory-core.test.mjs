/**
 * 社交记忆核心纯模块单元测试：脱敏 / 别名 / 合并 / 确定性降级 / 泄漏门禁。
 * 不访问网络、不读真实微信。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_CHAT_TEXT_LENGTH, redactChatText } from '../../dist/memory/redaction.js';
import {
  allocateConversationLabel,
  allocateMemberAlias,
  allocateMemberAliases,
  letterSuffix,
} from '../../dist/memory/alias.js';
import { OBSERVED_EVIDENCE_THRESHOLD, addDaysIso, mergeImpression } from '../../dist/memory/merge.js';
import { buildHeuristicImpressions } from '../../dist/memory/heuristics.js';
import { assertNoChatLeak, findChatLeak } from '../../dist/memory/guard.js';
import { MomentsError } from '../../dist/domain/result.js';

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
// 脱敏
// ---------------------------------------------------------------------------

test('聊天脱敏：手机号/证件/银行卡/邮箱/URL/wxid/@昵称 → [已脱敏]', () => {
  const cases = [
    ['电话 13800138000 找我', '13800138000'],
    ['身份证 110101199003071234', '110101199003071234'],
    ['银行卡 6222021234567890123', '6222021234567890123'],
    ['邮箱 zhangsan@example.com', 'zhangsan@example.com'],
    ['链接 https://example.com/a?b=1 里', 'example.com'],
    ['wxid_abc123456 说的', 'wxid_abc123456'],
    ['@张三 你看下', '张三'],
  ];
  for (const [input, secret] of cases) {
    const output = redactChatText(input);
    assert.ok(output.includes('[已脱敏]'), `${input} 应被脱敏`);
    assert.equal(output.includes(secret), false, `${input} 不应保留 ${secret}`);
  }
});

test('聊天脱敏：≤500 字、幂等、无敏感内容时保持原样', () => {
  const long = redactChatText('今天天气不错'.repeat(120));
  assert.ok(long.length <= MAX_CHAT_TEXT_LENGTH);

  const mixed = redactChatText('张三 13800138000 https://a.example.com/x @李四 今天爬山吗');
  assert.equal(redactChatText(mixed), mixed, '脱敏必须幂等');
  assert.equal(redactChatText('周末一起爬山吗'), '周末一起爬山吗');
});

// ---------------------------------------------------------------------------
// 别名
// ---------------------------------------------------------------------------

test('别名：Excel 列名式序号与稳定分配', () => {
  assert.equal(letterSuffix(0), 'A');
  assert.equal(letterSuffix(25), 'Z');
  assert.equal(letterSuffix(26), 'AA');

  assert.equal(allocateConversationLabel('group', []), '群聊A');
  assert.equal(allocateConversationLabel('private', ['群聊A']), '私聊B', '跨会话共享序号');
  assert.equal(allocateConversationLabel('group', ['群聊A', '私聊B']), '群聊C');

  assert.equal(allocateMemberAlias('group', []), '群友A');
  assert.equal(allocateMemberAlias('group', ['群友A', '群友B']), '群友C');
  assert.equal(allocateMemberAlias('group', ['群友B']), '群友C', '按最大序号 +1，不复用旧别名');
  assert.equal(allocateMemberAlias('private', []), '对方');
  assert.equal(allocateMemberAlias('private', ['对方']), '对方2');

  assert.deepEqual(allocateMemberAliases('group', ['群友A'], 2), ['群友B', '群友C']);
});

// ---------------------------------------------------------------------------
// 合并
// ---------------------------------------------------------------------------

function existingImpression(overrides = {}) {
  return {
    impressionId: 'imp_1',
    conversationKey: 'conv_1',
    memberRef: 'member_1',
    alias: '群友A',
    displayName: '张三',
    summary: '旧摘要',
    traits: ['爱玩梗'],
    topics: ['旧话题'],
    style: '旧风格',
    confidence: 0.4,
    evidenceCount: 2,
    status: 'new',
    source: 'auto',
    firstSeenAt: '2026-05-01T00:00:00.000Z',
    lastSeenAt: '2026-05-02T00:00:00.000Z',
    updatedAt: '2026-05-02T00:00:00.000Z',
    expiresAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

const extractedImpression = {
  memberRef: 'member_1',
  alias: '群友A',
  summary: '新摘要',
  traits: ['表达简短'],
  topics: ['新话题'],
  style: '新风格',
  confidence: 0.7,
};

test('合并：证据阈值 → new/observed，话题并集，TTL 刷新，别名稳定', () => {
  const now = new Date('2026-07-02T00:00:00.000Z');
  const merged = mergeImpression({
    existing: existingImpression(),
    extracted: extractedImpression,
    alias: '群友A',
    displayName: '张三',
    evidenceIncrement: 1,
    lastSeenAt: '2026-07-01T03:00:00.000Z',
    now,
    impressionTtlDays: 90,
  });
  assert.equal(merged.evidenceCount, 2 + 1);
  assert.equal(merged.status, 'observed');
  assert.equal(merged.summary, '新摘要');
  assert.deepEqual([...merged.traits], ['表达简短']);
  assert.deepEqual([...merged.topics], ['旧话题', '新话题']);
  assert.equal(merged.confidence, 0.7);
  assert.equal(merged.updatedAt, now.toISOString());
  assert.equal(merged.expiresAt, addDaysIso(now, 90));
  assert.equal(merged.lastSeenAt, '2026-07-01T03:00:00.000Z');
  assert.equal(merged.alias, '群友A');

  const belowThreshold = mergeImpression({
    existing: existingImpression({ evidenceCount: 0, summary: '', traits: [], topics: [], style: '' }),
    extracted: extractedImpression,
    alias: '群友A',
    displayName: '张三',
    evidenceIncrement: 1,
    lastSeenAt: null,
    now,
    impressionTtlDays: 90,
  });
  assert.equal(belowThreshold.evidenceCount, 1);
  assert.equal(belowThreshold.status, 'new');
  assert.ok(OBSERVED_EVIDENCE_THRESHOLD > 1);

  const stableAlias = mergeImpression({
    existing: existingImpression({ alias: '群友B' }),
    extracted: extractedImpression,
    alias: '群友A',
    displayName: '张三',
    evidenceIncrement: 1,
    lastSeenAt: null,
    now,
    impressionTtlDays: 90,
  });
  assert.equal(stableAlias.alias, '群友B', '已有别名必须保留');
});

test('合并：owner_edited 的摘要/标签/风格/别名不被自动覆盖', () => {
  const merged = mergeImpression({
    existing: existingImpression({
      status: 'owner_edited',
      source: 'owner',
      alias: '老张',
      summary: '所有者修正的摘要',
      traits: ['语气温和'],
      style: '所有者修正的风格',
      confidence: 0.8,
    }),
    extracted: extractedImpression,
    alias: '群友A',
    displayName: '张三',
    evidenceIncrement: 2,
    lastSeenAt: '2026-07-01T03:00:00.000Z',
    now: new Date('2026-07-02T00:00:00.000Z'),
    impressionTtlDays: 90,
  });
  assert.equal(merged.summary, '所有者修正的摘要');
  assert.deepEqual([...merged.traits], ['语气温和']);
  assert.equal(merged.style, '所有者修正的风格');
  assert.equal(merged.alias, '老张');
  assert.equal(merged.status, 'owner_edited');
  assert.equal(merged.source, 'owner');
  assert.equal(merged.confidence, 0.8);
  assert.equal(merged.evidenceCount, 4);
  assert.deepEqual([...merged.topics], ['旧话题', '新话题'], '话题仍可累积');
});

// ---------------------------------------------------------------------------
// 确定性降级
// ---------------------------------------------------------------------------

test('确定性降级：短句+提问+玩梗生成受控标签与低置信度', () => {
  const impressions = buildHeuristicImpressions({
    conversationLabel: '群聊A',
    kind: 'group',
    members: [
      {
        memberRef: 'm1',
        alias: '群友A',
        texts: ['今天去吗？', '很快', '哈哈哈', '为什么', '走吗？'],
      },
    ],
  });
  assert.equal(impressions.length, 1);
  const [impression] = impressions;
  assert.ok(impression);
  assert.equal(impression.alias, '群友A');
  assert.ok(impression.summary.includes('群聊A'));
  assert.ok(impression.confidence <= 0.35);
  assert.ok(impression.traits.includes('喜欢提问') || impression.traits.includes('表达简短'));
  assert.equal(impression.summary.includes('张三'), false);
  assert.equal(impression.topics.length, 0);
  assert.ok(impression.style.length <= 120);
});

// ---------------------------------------------------------------------------
// 泄漏门禁
// ---------------------------------------------------------------------------

test('泄漏门禁：真实昵称 / 8 字原文片段 / 隐私信息 / wxid 命中即拒绝', () => {
  const context = {
    realNames: ['张三', '周末爬山群'],
    messageTexts: ['我上周刚去过 累死了'],
  };
  assert.deepEqual(findChatLeak('今天天气不错，端侧模型很有意思', context), []);
  assert.ok(findChatLeak('张三今天说要去爬山', context).includes('真实昵称或会话名'));
  assert.ok(findChatLeak('周末爬山群里很热闹', context).includes('真实昵称或会话名'));
  assert.ok(findChatLeak('他说我上周刚去过累死', context).includes('聊天原文连续片段'));
  assert.ok(findChatLeak('身份证 110101199003071234', context).some((reason) => reason.startsWith('隐私信息')));
  assert.ok(findChatLeak('wxid_abc123456', context).includes('wxid'));

  const error = captureError(() => assertNoChatLeak('张三今天来了', context, '草稿'), 'CHAT_PRIVACY_LEAK');
  assert.equal(error.message.includes('张三'), false, '错误信息不得回显真实昵称');
  assert.deepEqual(error.details.reasons.length > 0, true);

  assert.doesNotThrow(() => assertNoChatLeak('端侧推理成本正在变化', context, '草稿'));
});

test('泄漏门禁：短片段不误伤（<8 字）且空文本直接通过', () => {
  const context = { realNames: [], messageTexts: ['今天爬山'] };
  assert.deepEqual(findChatLeak('今天爬山去不去', context), []);
  assert.doesNotThrow(() => assertNoChatLeak('', context, '选题'));
});

test('泄漏门禁：全半角归一后仍能命中昵称与原文片段', () => {
  const context = { realNames: ['Lisa', '张三'], messageTexts: ['电话13800138000打不通'] };
  assert.ok(findChatLeak('Ｌｉｓａ 今天没来', context).includes('真实昵称或会话名'));
  assert.ok(findChatLeak('ＬＩＳＡ 今天没来', context).includes('真实昵称或会话名'));
  assert.ok(
    findChatLeak('他说电话１３８００１３８０００打不通', context).includes('聊天原文连续片段'),
    '全角数字也应归一到同一原文片段',
  );
  assert.ok(findChatLeak('１３８００１３８０００', context).some((reason) => reason.startsWith('隐私信息')));
});

test('泄漏门禁：本地上下文读取失败时 fail-closed', () => {
  const context = { realNames: [], messageTexts: [], degraded: true };
  assert.ok(findChatLeak('今天天气不错', context).includes('本地社交记忆上下文不可用'));
  assert.throws(() => assertNoChatLeak('今天天气不错', context, '草稿'), (error) => error.code === 'CHAT_PRIVACY_LEAK');
});

test('聊天脱敏：全角手机号/全角字母也会被归一后脱敏', () => {
  const fullWidthPhone = redactChatText('电话１３８００１３８０００找我');
  assert.ok(fullWidthPhone.includes('[已脱敏]'));
  assert.equal(fullWidthPhone.includes('13800138000'), false);
  const fullWidthMail = redactChatText('邮箱ｌｉｓａ＠example.com');
  assert.ok(fullWidthMail.includes('[已脱敏]'));
  assert.equal(fullWidthMail.includes('lisa@example.com'), false);
});

