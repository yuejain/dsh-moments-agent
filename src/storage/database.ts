/**
 * SQLite 封装（Node 内置 node:sqlite）。
 *
 * 为什么用 node:sqlite：DSH 运行在 Electron/Node 24 上，内置 SQLite 不需要原生编译，
 * 不会出现 better-sqlite3 与 Electron ABI 不匹配的问题。插件加载时会探测可用性，
 * 不可用时进入显式降级（工具返回 SQLITE_UNAVAILABLE），而不是静默丢数据。
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { MomentsError } from '../domain/result.js';
import { MIGRATIONS } from './migrations.js';

export interface SqlRunResult {
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}

export interface SqlStatement {
  run(...params: unknown[]): SqlRunResult;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

export interface SqlDriver {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
}

interface NodeSqliteModule {
  DatabaseSync: new (location: string) => {
    exec(sql: string): void;
    prepare(sql: string): SqlStatement;
    close(): void;
  };
}

/**
 * 加载 node:sqlite。使用 createRequire 而非静态 import，
 * 这样在不支持的运行时插件仍能加载并返回可诊断错误，而不是整个插件崩溃。
 */
export async function loadSqliteDriver(dbPath: string): Promise<SqlDriver> {
  let mod: NodeSqliteModule;
  try {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('node:sqlite') as NodeSqliteModule;
  } catch (error) {
    throw new MomentsError('SQLITE_UNAVAILABLE', '当前 Node/Electron 运行时不支持 node:sqlite', {
      cause: error,
      details: { hint: '需要 Node >= 22.5 且未被 --no-experimental-sqlite 禁用' },
    });
  }
  if (typeof mod.DatabaseSync !== 'function') {
    throw new MomentsError('SQLITE_UNAVAILABLE', 'node:sqlite 缺少 DatabaseSync');
  }
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new mod.DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');
  return {
    exec: (sql) => db.exec(sql),
    prepare: (sql) => db.prepare(sql),
    close: () => db.close(),
  };
}

export interface TransactionOptions {
  /** immediate 用于写事务，避免并发写升级锁失败。 */
  readonly mode?: 'immediate' | 'deferred';
}

/**
 * 迁移执行器。版本表与业务表在同一个事务内更新，失败整体回滚。
 */
export function migrate(driver: SqlDriver, now: () => Date = () => new Date()): number {
  driver.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);
  const rows = driver.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
  const applied = new Set(rows.map((row) => Number(row.version)));
  let latest = 0;
  for (const migration of MIGRATIONS) {
    latest = Math.max(latest, migration.version);
    if (applied.has(migration.version)) continue;
    driver.exec('BEGIN IMMEDIATE');
    try {
      driver.exec(migration.sql);
      driver.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        migration.version,
        now().toISOString(),
      );
      driver.exec('COMMIT');
    } catch (error) {
      driver.exec('ROLLBACK');
      throw new MomentsError('INTERNAL_ERROR', `数据库迁移 ${migration.version} 失败`, { cause: error });
    }
  }
  return latest;
}

/** 事务包装：嵌套调用会复用外层事务（不允许真正嵌套）。 */
export class TransactionScope {
  private depth = 0;

  constructor(private readonly driver: SqlDriver) {}

  run<T>(fn: () => T, options: TransactionOptions = {}): T {
    const mode = options.mode === 'deferred' ? 'BEGIN DEFERRED' : 'BEGIN IMMEDIATE';
    if (this.depth > 0) {
      this.depth += 1;
      try {
        return fn();
      } finally {
        this.depth -= 1;
      }
    }
    this.driver.exec(mode);
    this.depth = 1;
    try {
      const result = fn();
      this.driver.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.driver.exec('ROLLBACK');
      } catch {
        // 回滚失败不覆盖原始错误
      }
      throw error;
    } finally {
      this.depth = 0;
    }
  }

  get inTransaction(): boolean {
    return this.depth > 0;
  }
}
