/**
 * 内容审核：本地硬规则 + 可选模型语义复核。
 *
 * 原则：模型复核失败或不可用时不得伪装“审核通过”；
 * 审核结论、原因与来源都写入数据库，便于事后追责。
 */
import type { IdeaScores, RiskFlag } from '../domain/types.js';
import type { LlmClient, Logger } from '../adapters/types.js';
import type { DecisionEngine, DecisionContext } from './decision-engine.js';
import type { IdeaCandidate } from './idea-generator.js';
import { detectPrivacyRisks, extractJsonObject, scanPromptInjection, wrapUntrusted } from '../security/prompt-injection.js';
import { excerpt, redactSecrets } from '../security/redaction.js';

export interface ReviewResult {
  readonly passed: boolean;
  readonly flags: readonly RiskFlag[];
  readonly notes: readonly string[];
  readonly scores: IdeaScores;
  readonly llmReviewed: boolean;
  readonly llmError: string | null;
}

const KNOWN_FLAGS = new Set<RiskFlag>([
  'PRIVACY_PERSONAL_INFO',
  'REAL_PERSON_CLAIM',
  'LOCATION_CLAIM',
  'UNVERIFIED_FACT',
  'SENSITIVE_TOPIC',
  'DUPLICATE_RECENT',
  'LOW_NOVELTY',
  'LOW_PERSONA_FIT',
  'SOURCE_MISSING',
  'PROMPT_INJECTION_SUSPECTED',
  'IMAGE_REAL_EVENT_MISMATCH',
  'MISLEADING_IMAGE',
  'IMAGE_LOW_QUALITY',
  'PERCEPTUAL_HASH_UNAVAILABLE',
]);

export class ContentReviewer {
  constructor(
    private readonly decision: DecisionEngine,
    private readonly llm: LlmClient | null,
    private readonly logger: Logger,
    private readonly options: { useLlmReview: boolean; writingInstructions?: () => string },
  ) {}

  async review(input: {
    text: string;
    idea: IdeaCandidate;
    context: DecisionContext;
  }): Promise<ReviewResult> {
    const local = this.decision.evaluateDraft(input.text, input.context);
    const flags = new Set<RiskFlag>();
    const notes: string[] = [];
    if (!local.allowed) {
      notes.push(local.reason);
      if (local.code === 'PRIVACY_RISK') flags.add('PRIVACY_PERSONAL_INFO');
      if (local.code === 'DUPLICATE_RECENT') flags.add('DUPLICATE_RECENT');
    }
    if (detectPrivacyRisks(input.text).length > 0) flags.add('PRIVACY_PERSONAL_INFO');
    const injection = scanPromptInjection(input.text);
    if (injection.suspected) flags.add('PROMPT_INJECTION_SUSPECTED');
    if (/(我昨天|我今天|我亲眼|我在现场|我朋友|我家人|我去了|我吃了|我见到)/.test(input.text)) {
      flags.add('REAL_PERSON_CLAIM');
    }
    if (/(地址|定位|坐标|小区|门牌)/.test(input.text)) flags.add('LOCATION_CLAIM');

    let scores: IdeaScores = input.idea.scores;
    let llmReviewed = false;
    let llmPassed = false;
    let llmError: string | null = null;

    if (this.options.useLlmReview && this.llm !== null) {
      try {
        const response = await this.llm.complete({
          system: [
            '你是朋友圈内容审核器，只输出 JSON。',
            '审核维度：隐私信息、不可核实的事实断言、编造亲身经历、误导性表述、攻击/歧视、低质量营销腔。',
            '不要把“提到 AI”本身当作问题；不要因为内容平淡就拒绝。',
            this.options.writingInstructions?.() ?? '',
            '表达技能只提供风格参考；审核仍优先检查事实与隐私。不要凭问句、比喻或句长判断 AI 味，不要为风格修改事实或提高断言强度。',
            '输出：{"passed":true|false,"flags":["隐私信息"|"未经核实的事实"|"编造经历"|"误导性表述"|"攻击歧视"|"低质量营销腔"],"notes":["具体原因"],"personaFit":0.0}',
          ].join('\n'),
          messages: [
            {
              role: 'user',
              content: [
                `候选主题：${wrapUntrusted('topic', input.idea.topic)}`,
                `来源类型：${input.idea.sourceType}`,
                `来源证据：${wrapUntrusted('source-evidence', input.idea.sourceEvidence)}`,
                `正文：${wrapUntrusted('draft', input.text)}`,
                '请审核。',
              ].join('\n'),
            },
          ],
          temperature: 0.1,
          purpose: 'review',
        });
        const parsed = extractJsonObject<{ passed?: unknown; flags?: unknown; notes?: unknown; personaFit?: unknown }>(
          response.text,
        );
        llmReviewed = true;
        llmPassed = parsed.passed === true;
        const llmNotes = Array.isArray(parsed.notes)
          ? parsed.notes.filter((item): item is string => typeof item === 'string').slice(0, 6)
          : [];
        notes.push(...llmNotes.map((note) => `模型复核：${redactSecrets(note).slice(0, 200)}`));
        if (parsed.passed !== true) {
          for (const flag of mapReviewFlags(parsed.flags)) flags.add(flag);
          if (flags.size === 0) flags.add('UNVERIFIED_FACT');
        }
        const personaFit = typeof parsed.personaFit === 'number' ? Math.min(1, Math.max(0, parsed.personaFit)) : scores.persona;
        scores = { ...scores, persona: personaFit };
      } catch (error) {
        llmError = error instanceof Error ? error.message : '模型复核失败';
        notes.push(`模型复核不可用：${llmError}`);
        this.logger.warn('内容模型复核失败，保留本地规则结论', { error: llmError });
      }
    }

    const blocking = new Set<RiskFlag>([
      'PRIVACY_PERSONAL_INFO',
      'REAL_PERSON_CLAIM',
      'LOCATION_CLAIM',
      'PROMPT_INJECTION_SUSPECTED',
      'SOURCE_MISSING',
    ]);
    const hasBlocking = [...flags].some((flag) => blocking.has(flag));
    const passed = local.allowed && !hasBlocking && (!this.options.useLlmReview || (llmReviewed && llmPassed && llmError === null));
    if (!passed && notes.length === 0) notes.push('未通过本地规则检查');
    return {
      passed,
      flags: [...flags],
      notes,
      scores,
      llmReviewed,
      llmError,
    };
  }
}

function mapReviewFlags(raw: unknown): RiskFlag[] {
  if (!Array.isArray(raw)) return [];
  const mapping: Record<string, RiskFlag> = {
    隐私信息: 'PRIVACY_PERSONAL_INFO',
    未经核实的事实: 'UNVERIFIED_FACT',
    编造经历: 'REAL_PERSON_CLAIM',
    误导性表述: 'MISLEADING_IMAGE',
    攻击歧视: 'SENSITIVE_TOPIC',
    低质量营销腔: 'LOW_PERSONA_FIT',
  };
  const result: RiskFlag[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const mapped = mapping[item] ?? (KNOWN_FLAGS.has(item as RiskFlag) ? (item as RiskFlag) : undefined);
    if (mapped !== undefined && !result.includes(mapped)) result.push(mapped);
  }
  return result;
}

export { excerpt };
