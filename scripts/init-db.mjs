#!/usr/bin/env node
/**
 * 数据库初始化/迁移命令。
 *
 * 用法：
 *   node scripts/init-db.mjs                       # 默认 data/moments.sqlite
 *   node scripts/init-db.mjs --db path/to/file.db  # 指定路径
 *
 * 该命令只创建/迁移表结构，不会写入任何示例内容。
 */
import path from 'node:path';
import { loadSqliteDriver, migrate } from '../dist/storage/database.js';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
let dbPath = path.join(root, 'data', 'moments.sqlite');
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--db' && args[index + 1] !== undefined) {
    dbPath = path.resolve(args[index + 1]);
    index += 1;
  }
}

const driver = await loadSqliteDriver(dbPath);
try {
  const version = migrate(driver);
  const applied = driver.prepare('SELECT version, applied_at FROM schema_migrations ORDER BY version').all();
  const tables = driver
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all();
  console.log(`[init-db] 数据库：${dbPath}`);
  console.log(`[init-db] 迁移版本：${version}`);
  console.log(`[init-db] 已应用：${applied.map((row) => `v${row.version}@${row.applied_at}`).join(', ')}`);
  console.log(`[init-db] 表（${tables.length}）：${tables.map((row) => row.name).join(', ')}`);
} finally {
  driver.close();
}
