/**
 * 稳定别名分配（社交记忆匿名化）。
 *
 * 模型永远拿不到真实昵称 / wxid / 原始会话名，只看到：
 * - 会话标签：`群聊A`、`私聊B`…（跨会话共享序号，按首次收录顺序递增）；
 * - 群成员别名：`群友A`、`群友B`…（Excel 列名式，超过 26 个为 `群友AA`）；
 * - 私聊对方：`对方`（极端情况下多人私聊用 `对方2`、`对方3`）。
 *
 * 已经存在过的别名一律保留，新别名只在「已有最大序号 + 1」处分配。
 * 注意：本实现不维护「已删除别名」的墓碑；如果某会话只剩 `群友A`（`群友B` 已被删除或过期），
 * 下一个新成员仍会拿到 `群友B`。别名只在同一会话内唯一，不代表跨时间的固定身份。
 */
import type { ChatConversationKind } from '../domain/types.js';

export const GROUP_MEMBER_PREFIX = '群友';
export const PRIVATE_MEMBER_ALIAS = '对方';
const GROUP_LABEL_PREFIX = '群聊';
const PRIVATE_LABEL_PREFIX = '私聊';

/** 0 → A、25 → Z、26 → AA，与 Excel 列名一致；负数按 A 处理。 */
export function letterSuffix(index: number): string {
  if (!Number.isFinite(index) || index < 0) return 'A';
  let value = Math.floor(index);
  let output = '';
  do {
    output = `${String.fromCharCode(65 + (value % 26))}${output}`;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return output;
}

/** `A` → 0、`AA` → 26；非法输入返回 -1。 */
export function parseLetterSuffix(suffix: string): number {
  if (!/^[A-Z]+$/.test(suffix)) return -1;
  let value = 0;
  for (const char of suffix) {
    value = value * 26 + (char.charCodeAt(0) - 64);
  }
  return value - 1;
}

export function conversationLabelPrefix(kind: ChatConversationKind): string {
  return kind === 'group' ? GROUP_LABEL_PREFIX : PRIVATE_LABEL_PREFIX;
}

/** 分配新的会话匿名标签，避免与已有标签冲突。 */
export function allocateConversationLabel(kind: ChatConversationKind, existingLabels: readonly string[]): string {
  let maxIndex = -1;
  for (const label of existingLabels) {
    const match = /^(?:群聊|私聊)([A-Z]+)$/.exec(label);
    if (match === null) continue;
    const index = parseLetterSuffix(match[1] ?? '');
    if (index > maxIndex) maxIndex = index;
  }
  return `${conversationLabelPrefix(kind)}${letterSuffix(maxIndex + 1)}`;
}

/** 分配一个新的成员匿名别名，避免与已有别名冲突。 */
export function allocateMemberAlias(kind: ChatConversationKind, existingAliases: readonly string[]): string {
  if (kind === 'private') {
    if (!existingAliases.includes(PRIVATE_MEMBER_ALIAS)) return PRIVATE_MEMBER_ALIAS;
    let maxIndex = 1;
    for (const alias of existingAliases) {
      const match = /^对方(\d+)$/.exec(alias);
      if (match === null) continue;
      const index = Number(match[1]);
      if (Number.isFinite(index) && index > maxIndex) maxIndex = index;
    }
    return `对方${maxIndex + 1}`;
  }
  let maxIndex = -1;
  for (const alias of existingAliases) {
    const match = /^群友([A-Z]+)$/.exec(alias);
    if (match === null) continue;
    const index = parseLetterSuffix(match[1] ?? '');
    if (index > maxIndex) maxIndex = index;
  }
  return `${GROUP_MEMBER_PREFIX}${letterSuffix(maxIndex + 1)}`;
}

/** 批量分配别名（内部维护已用集合，保证同批不重复）。 */
export function allocateMemberAliases(
  kind: ChatConversationKind,
  existingAliases: readonly string[],
  count: number,
): string[] {
  const used = [...existingAliases];
  const output: string[] = [];
  const total = Math.max(0, Math.floor(count));
  for (let index = 0; index < total; index += 1) {
    const alias = allocateMemberAlias(kind, used);
    used.push(alias);
    output.push(alias);
  }
  return output;
}
