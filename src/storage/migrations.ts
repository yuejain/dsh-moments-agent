/**
 * 数据库迁移。
 *
 * 版本 1：完整初始 schema。所有状态字段使用 TEXT + CHECK 约束，
 * 关键唯一索引保证幂等：一个幂等键只能有一个发布尝试，一篇已发布内容只能有一条记录。
 */
export interface Migration {
  readonly version: number;
  readonly sql: string;
}

const V1 = `
CREATE TABLE moment_tasks (
  task_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  idea_id TEXT,
  draft_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'PUBLIC',
  content_hash TEXT,
  asset_manifest_hash TEXT,
  account_id TEXT,
  approval_id TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_moment_tasks_state ON moment_tasks(state);
CREATE INDEX idx_moment_tasks_updated ON moment_tasks(updated_at);

CREATE TABLE ideas (
  idea_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE,
  topic TEXT NOT NULL,
  motivation TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_evidence TEXT NOT NULL,
  novelty_score REAL NOT NULL,
  persona_score REAL NOT NULL,
  relevance_score REAL NOT NULL,
  risk_flags TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES moment_tasks(task_id) ON DELETE CASCADE
);

CREATE TABLE drafts (
  draft_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  idea_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  text TEXT NOT NULL,
  tone TEXT NOT NULL DEFAULT '',
  is_current INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES moment_tasks(task_id) ON DELETE CASCADE
);
CREATE INDEX idx_drafts_task ON drafts(task_id);
CREATE UNIQUE INDEX idx_drafts_current ON drafts(task_id) WHERE is_current = 1;

CREATE TABLE draft_versions (
  draft_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (draft_id, version)
);

CREATE TABLE image_tasks (
  image_task_id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  negative_prompt TEXT NOT NULL DEFAULT '',
  aspect_ratio TEXT NOT NULL DEFAULT '1:1',
  resolution TEXT NOT NULL DEFAULT '1024x1024',
  style_profile TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  requires_user_action INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES moment_tasks(task_id) ON DELETE CASCADE
);
CREATE INDEX idx_image_tasks_task ON image_tasks(task_id);
CREATE INDEX idx_image_tasks_status ON image_tasks(status);

CREATE TABLE media_assets (
  asset_id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL,
  mime TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  source TEXT NOT NULL,
  license TEXT NOT NULL DEFAULT 'unknown',
  prompt TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  image_task_id TEXT,
  perceptual_hash TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_media_assets_task ON media_assets(image_task_id);

CREATE TABLE task_assets (
  task_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (task_id, asset_id),
  FOREIGN KEY (task_id) REFERENCES moment_tasks(task_id) ON DELETE CASCADE,
  FOREIGN KEY (asset_id) REFERENCES media_assets(asset_id) ON DELETE CASCADE
);
CREATE INDEX idx_task_assets_task ON task_assets(task_id, position);

CREATE TABLE image_reviews (
  asset_id TEXT PRIMARY KEY,
  passed INTEGER NOT NULL,
  flags TEXT NOT NULL DEFAULT '[]',
  report TEXT NOT NULL,
  reviewed_at TEXT NOT NULL
);

CREATE TABLE approvals (
  approval_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  asset_manifest_hash TEXT NOT NULL,
  visibility TEXT NOT NULL,
  account_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  status TEXT NOT NULL,
  channel TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  consumed_at TEXT
);
CREATE INDEX idx_approvals_task ON approvals(task_id);
CREATE INDEX idx_approvals_status ON approvals(status);

CREATE TABLE publish_attempts (
  attempt_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  approval_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  content_hash TEXT NOT NULL,
  asset_manifest_hash TEXT NOT NULL,
  account_id TEXT NOT NULL,
  state TEXT NOT NULL,
  mode TEXT NOT NULL,
  screenshot_path TEXT,
  verification TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES moment_tasks(task_id) ON DELETE CASCADE
);
CREATE INDEX idx_attempts_task ON publish_attempts(task_id);

CREATE TABLE published_posts (
  post_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL UNIQUE,
  text TEXT NOT NULL,
  visibility TEXT NOT NULL,
  account_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  published_at TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_published_published_at ON published_posts(published_at);
CREATE INDEX idx_published_content_hash ON published_posts(content_hash);

CREATE TABLE persona_memories (
  memory_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (kind, key)
);

CREATE TABLE user_preferences (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE schedules (
  schedule_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  spec TEXT NOT NULL DEFAULT '{}',
  last_run_at TEXT,
  next_run_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE audit_events (
  event_id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  task_id TEXT,
  previous_state TEXT,
  next_state TEXT,
  reason TEXT NOT NULL DEFAULT '',
  metadata TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_audit_at ON audit_events(at);
CREATE INDEX idx_audit_task ON audit_events(task_id);

CREATE TABLE system_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, sql: V1 },
  { version: 2, sql: `
CREATE TABLE owner_command_receipts (
  command_key TEXT PRIMARY KEY,
  claimed_at TEXT NOT NULL
);
CREATE INDEX idx_command_receipts_at ON owner_command_receipts(claimed_at);
` },
];
