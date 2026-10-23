/**
 * 文本相似度：用于朋友圈去重与重复度评分。
 *
 * 使用字符二元组 Jaccard + 归一化完全匹配；对中文短文本足够稳定，
 * 不依赖分词库。相似度只用于“拒绝自动发布”，不用于改写用户内容。
 */

export function normalizeForSimilarity(text: string): string {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

export function bigrams(text: string): Set<string> {
  const normalized = normalizeForSimilarity(text);
  const grams = new Set<string>();
  if (normalized.length === 0) return grams;
  if (normalized.length === 1) {
    grams.add(normalized);
    return grams;
  }
  for (let index = 0; index < normalized.length - 1; index += 1) {
    grams.add(normalized.slice(index, index + 2));
  }
  return grams;
}

export function textSimilarity(a: string, b: string): number {
  const left = normalizeForSimilarity(a);
  const right = normalizeForSimilarity(b);
  if (left === '' || right === '') return 0;
  if (left === right) return 1;
  const setA = bigrams(a);
  const setB = bigrams(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const gram of setA) if (setB.has(gram)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** 返回与历史文案最高的相似度以及命中的历史文本索引。 */
export function maxSimilarity(text: string, history: readonly string[]): { score: number; index: number } {
  let best = 0;
  let bestIndex = -1;
  history.forEach((candidate, index) => {
    const score = textSimilarity(text, candidate);
    if (score > best) {
      best = score;
      bestIndex = index;
    }
  });
  return { score: best, index: bestIndex };
}
