/**
 * 确定性降级印象（不调用 LLM）。
 *
 * 用于 `chatMemory.useLlmExtraction=false`、或 LLM 遗漏了某个新发言成员时：
 * 只根据可观察统计（发言条数、平均长度、问句比例、表情/语气词）生成低置信度印象。
 * 不猜测话题，不做心理推断，输出结构必须与 LLM 提炼结果一致。
 */
import type { ChatConversationKind } from '../domain/types.js';
import type { ExtractedMemberImpression } from './impression-builder.js';
import { MAX_STYLE_LENGTH, MAX_SUMMARY_LENGTH } from './impression-builder.js';

export interface HeuristicMemberInput {
  readonly memberRef: string;
  readonly alias: string;
  /** 该成员在近期窗口内的脱敏文本（按时间升序）。 */
  readonly texts: readonly string[];
}

export interface HeuristicBuildInput {
  readonly conversationLabel: string;
  readonly kind: ChatConversationKind;
  readonly members: readonly HeuristicMemberInput[];
}

const PLAYFUL_PATTERN = /哈|嘿|嘻|233|hhh|lol|笑死|😂|🤣/gi;
const EMOJI_PATTERN = /[\u{1f300}-\u{1faff}\u2600-\u27bf]/gu;
const POLITE_PATTERN = /谢谢|感谢|辛苦|麻烦你|拜托/g;
const QUESTION_PATTERN = /[?？]|吗|呢|怎么|为什么|如何/g;

/** 生成确定性印象；输入为空返回空数组。 */
export function buildHeuristicImpressions(input: HeuristicBuildInput): ExtractedMemberImpression[] {
  const impressions: ExtractedMemberImpression[] = [];
  for (const member of input.members) {
    const nonEmpty = member.texts.filter((text) => text.trim() !== '');
    if (nonEmpty.length === 0) continue;
    const count = nonEmpty.length;
    const totalLength = nonEmpty.reduce((sum, text) => sum + text.length, 0);
    const averageLength = totalLength / count;
    const questionCount = countMatches(nonEmpty, QUESTION_PATTERN);
    const playfulCount = countMatches(nonEmpty, PLAYFUL_PATTERN);
    const emojiCount = countMatches(nonEmpty, EMOJI_PATTERN);
    const politeCount = countMatches(nonEmpty, POLITE_PATTERN);
    const questionRatio = questionCount / count;

    const traits: string[] = [];
    if (count >= 5 && averageLength <= 8) traits.push('表达简短');
    if (averageLength >= 45) traits.push('偏好详细解释');
    if (questionRatio >= 0.2) traits.push('喜欢提问');
    if (playfulCount >= 2) traits.push('爱玩梗');
    if (emojiCount >= 2) traits.push('爱发表情');
    if (politeCount >= 2) traits.push('语气温和');
    if (questionRatio >= 0.35) traits.push('喜欢接话');
    const controlledTraits = traits.slice(0, 6);

    const description = controlledTraits.length > 0
      ? `互动倾向：${controlledTraits.join('、')}。`
      : '发言较少，尚待观察。';
    const summary = clamp(
      `最近在${input.conversationLabel}发言 ${count} 条，平均每次约 ${Math.round(averageLength)} 字；${description}`,
      MAX_SUMMARY_LENGTH,
    );
    const style = clamp(
      `平均每次约 ${Math.round(averageLength)} 字，${questionRatio >= 0.2 ? '常用提问与对话推进' : '以陈述为主'}`,
      MAX_STYLE_LENGTH,
    );

    impressions.push({
      memberRef: member.memberRef,
      alias: member.alias,
      summary,
      traits: controlledTraits,
      topics: [],
      style,
      confidence: Math.min(0.35, Math.round((0.12 + count * 0.02) * 100) / 100),
    });
  }
  return impressions;
}

function countMatches(texts: readonly string[], pattern: RegExp): number {
  let matches = 0;
  for (const text of texts) {
    const found = text.match(pattern);
    if (found !== null) matches += found.length;
  }
  return matches;
}

function clamp(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, Math.max(1, maxLength - 1));
}
