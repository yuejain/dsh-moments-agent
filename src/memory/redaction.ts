/**
 * 聊天文本脱敏（社交记忆专用）。
 *
 * 入库前把可识别个人身份的内容替换为 `[已脱敏]`：
 * 手机号 / 身份证 / 银行卡 / 邮箱 / URL / wxid / @昵称。
 *
 * 约束：
 * - 结果不超过 500 字（保留截断标记 `…`）；
 * - 幂等：`redactChatText(redactChatText(x)) === redactChatText(x)`；
 * - 只做机械替换，不做任何语义推断，绝不把原文写进日志。
 *
 * 该模块与 `src/security/redaction.ts` 职责不同：后者负责日志/错误信息中的密钥兜底，
 * 这里负责聊天正文入库前的隐私脱敏。
 */

/** 聊天正文入库的最大长度。 */
export const MAX_CHAT_TEXT_LENGTH = 500;

/** 统一替换标记。 */
export const REDACTION_PLACEHOLDER = '[已脱敏]';

/** 脱敏顺序有讲究：先长模式，再短模式，避免大段数字被拆碎后残留。 */
const REDACTION_PATTERNS: readonly RegExp[] = [
  // URL（先于邮箱/@昵称处理，避免链接内片段被误判）
  /\b(?:https?:\/\/|www\.)[^\s<>"'）】]+/gi,
  // 邮箱
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  // 微信 wxid
  /\bwxid_[A-Za-z0-9_-]{4,}\b/gi,
  // 身份证（18 位，末位可为 X）
  /(?<!\d)\d{17}[\dXx](?!\d)/g,
  // 银行卡（16~19 位连续数字）
  /(?<!\d)\d{16,19}(?!\d)/g,
  // 手机号（允许 3-4-4 的分隔符）
  /(?<!\d)1[3-9]\d[\s-]?\d{4}[\s-]?\d{4}(?!\d)/g,
  // @昵称（此时邮箱已处理完）
  /@[\u4e00-\u9fa5A-Za-z0-9_.-]{1,32}/g,
];

/**
 * 脱敏一条聊天文本。
 *
 * 传入自定义 `maxLength` 时结果不会超过该长度（最小 4）。
 * 先归一化空白，再反复「脱敏 + 截断」直到结果稳定，保证幂等。
 */
export function redactChatText(input: string, maxLength = MAX_CHAT_TEXT_LENGTH): string {
  const limit = Math.max(4, Math.floor(maxLength));
  let output = sanitizeChatText(input);
  for (let round = 0; round < 4; round += 1) {
    const next = truncateChatText(redactOnce(output), limit);
    if (next === output) return output;
    output = next;
  }
  return output;
}

function redactOnce(text: string): string {
  let output = text;
  for (const pattern of REDACTION_PATTERNS) {
    output = output.replace(pattern, REDACTION_PLACEHOLDER);
  }
  return output;
}

function truncateChatText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(1, limit - 1))}…`;
}

/** 去控制字符、零宽字符并压缩空白；保持换行结构，最多两连换行。 */
function sanitizeChatText(input: string): string {
  return input
    // NFKC：全角数字/字母/兼容字符归一，避免「１３８…」这类全角写法绕过脱敏。
    .normalize('NFKC')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
