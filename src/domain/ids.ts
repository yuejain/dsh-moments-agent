/**
 * 基础工具：ID、稳定序列化、内容哈希。
 *
 * 设计约束：
 * - 所有对外可见的 ID 都带业务前缀，便于日志与人工核对；
 * - 内容哈希必须稳定（键排序、去除 undefined），否则审批绑定会不稳定；
 * - 不引入第三方依赖，保证插件在 DSH Host 内可独立加载。
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';

export type PrefixedId<Prefix extends string> = string & { readonly __prefix?: Prefix };

export function newId<Prefix extends string>(prefix: Prefix): PrefixedId<Prefix> {
  return `${prefix}_${randomUUID()}` as PrefixedId<Prefix>;
}

export function newNonce(): string {
  return randomBytes(16).toString('hex');
}

export function isoNow(now: Date = new Date()): string {
  return now.toISOString();
}

/** 把时间字符串或 Date 统一成 ISO 字符串。 */
export function toIso(value: Date | string): string {
  return (typeof value === 'string' ? new Date(value) : value).toISOString();
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * 稳定 JSON 序列化：对象键排序，忽略 undefined 值。
 * 审批、幂等键与内容哈希都依赖它，不能替换成 JSON.stringify。
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new TypeError('stableStringify 不支持非有限数字');
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : sortValue(item)));
  }
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const item = source[key];
    if (item === undefined) continue;
    out[key] = sortValue(item);
  }
  return out;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** 媒体文件的 SHA-256，用于内容寻址与去重。 */
export function sha256Bytes(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export interface ContentSnapshotInput {
  readonly text: string;
  readonly assetHashes: readonly string[];
  readonly visibility: string;
  readonly accountId: string;
}

/**
 * 审批绑定的内容快照。
 * 文案、图片清单、可见范围、目标账号任一变化都会产生不同哈希。
 */
export function computeContentHash(input: ContentSnapshotInput): string {
  return sha256Hex(
    stableStringify({
      version: 1,
      text: normalizeText(input.text),
      assets: [...input.assetHashes].sort(),
      visibility: input.visibility,
      accountId: input.accountId,
    }),
  );
}

export function computeAssetManifestHash(assetHashes: readonly string[]): string {
  return sha256Hex(stableStringify({ version: 1, assets: [...assetHashes].sort() }));
}

/**
 * 幂等键：不可变的内容版本 + 目标身份 + 发布模式。
 * 相同幂等键只允许存在一个发布尝试。
 */
export function computeIdempotencyKey(input: {
  taskId: string;
  contentHash: string;
  accountId: string;
  mode: string;
}): string {
  return sha256Hex(
    stableStringify({
      version: 1,
      taskId: input.taskId,
      contentHash: input.contentHash,
      accountId: input.accountId,
      mode: input.mode,
    }),
  );
}

/** 文案归一化：仅统一换行与首尾空白，不改变作者可见内容。 */
export function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim();
}

/** 判断两个文案在归一化后是否一致。 */
export function sameText(a: string, b: string): boolean {
  return normalizeText(a) === normalizeText(b);
}

export function assertNever(value: never, message = 'unexpected value'): never {
  throw new Error(`${message}: ${String(value)}`);
}
