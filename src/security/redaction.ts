/**
 * 日志与对外错误脱敏。
 *
 * 日志禁止包含：微信读取密钥、Hook 本机令牌、ChatGPT/Gemini 凭据、完整聊天记录、
 * 不必要身份资料、完整隐私图片内容。这里只做“可能含密钥的字符串”兜底，
 * 业务代码仍应主动只记录必要字段。
 */

const SECRET_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  { name: 'bearer', pattern: /(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi },
  { name: 'api-key', pattern: /\b(sk|ak|pk|rk)-[A-Za-z0-9._-]{12,}\b/g },
  { name: 'long-hex', pattern: /\b[a-f0-9]{64}\b/gi },
  { name: 'token-json', pattern: /("(?:token|reader_token|access_token|nativeToken|apiKey|api_key|secret|password)"\s*:\s*")[^"]*(")/gi },
  { name: 'authorization', pattern: /(authorization["'\s:=]+)[^\s,"'}]+/gi },
  { name: 'wxid', pattern: /\bwxid_[A-Za-z0-9_-]{6,}\b/g },
];

/** 对任意字符串做脱敏；保留可诊断的最小上下文。 */
export function redactSecrets(input: string): string {
  let output = input;
  for (const { name, pattern } of SECRET_PATTERNS) {
    output = output.replace(pattern, (match, ...groups: unknown[]) => {
      if (name === 'bearer') return `${String(groups[0] ?? 'Bearer ')}[REDACTED]`;
      if (name === 'token-json') return `${String(groups[0] ?? '')}[REDACTED]${String(groups[1] ?? '')}`;
      if (name === 'authorization') return `${String(groups[0] ?? '')}[REDACTED]`;
      if (name === 'wxid') return maskWxid(match);
      return '[REDACTED]';
    });
  }
  return output;
}

export function maskWxid(wxid: string): string {
  if (wxid.length <= 10) return 'wxid_***';
  return `${wxid.slice(0, 6)}***${wxid.slice(-3)}`;
}

/** 对任意 JSON 值递归脱敏（不改变结构），用于审计元数据与错误详情。 */
export function redactValue<T>(value: T, depth = 0): T {
  if (depth > 6) return '[DEPTH_LIMIT]' as T;
  if (typeof value === 'string') return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1)) as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (/token|secret|password|authorization|credential|api[_-]?key/i.test(key)) {
        out[key] = '[REDACTED]';
      } else {
        out[key] = redactValue(item, depth + 1);
      }
    }
    return out as T;
  }
  return value;
}

/** 文本摘要：日志中只保留前 N 个字符，避免记录完整聊天或隐私文案。 */
export function excerpt(text: string, max = 120): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max)}…`;
}
