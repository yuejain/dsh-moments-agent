/**
 * 持久化仓储。所有写操作走事务；状态迁移只允许经由 transitionTask。
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { MomentsError } from '../domain/result.js';
import { newId, sha256Hex, stableStringify } from '../domain/ids.js';
import { assertTransition } from '../domain/state-machine.js';
import type {
  ApprovalChannel,
  ApprovalRecord,
  ApprovalStatus,
  AuditEventRecord,
  DraftRecord,
  DraftVersionRecord,
  IdeaRecord,
  ImageReviewRecord,
  ImageReviewReport,
  ImageTaskRecord,
  ImageTaskStatus,
  MediaAssetRecord,
  MomentState,
  PersonaMemoryRecord,
  PreviewPackage,
  PublishedPostRecord,
  PublishAttemptRecord,
  PublishAttemptState,
  PublishMode,
  PublishVerification,
  RiskFlag,
  SourceType,
  TaskRecord,
  UserPreferenceRecord,
  Visibility,
} from '../domain/types.js';
import { computeContentHash } from '../domain/ids.js';
import { isTerminal } from '../domain/state-machine.js';
import { migrate, loadSqliteDriver, TransactionScope, type SqlDriver } from './database.js';

const TASK_STATES_OPEN = [
  'IDEA_CREATED',
  'DRAFTING',
  'DRAFT_READY',
  'IMAGE_REQUIRED',
  'IMAGE_PENDING',
  'IMAGE_READY',
  'REVIEWING',
  'READY_FOR_APPROVAL',
  'APPROVED',
  'QUEUED',
  'PREPARING',
  'PREPARED',
  'PUBLISHING',
  'UNCERTAIN',
] as const;

export interface TaskPatch {
  ideaId?: string | null;
  draftId?: string | null;
  visibility?: Visibility;
  contentHash?: string | null;
  assetManifestHash?: string | null;
  accountId?: string | null;
  approvalId?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}

export interface TransitionInput {
  readonly nextState: MomentState;
  readonly actor: string;
  readonly reason: string;
  readonly metadata?: Record<string, unknown>;
  readonly patch?: TaskPatch;
}

export interface TransitionResult {
  readonly task: TaskRecord;
  readonly previousState: MomentState;
}

export interface CreateAttemptInput {
  readonly attemptId: string;
  readonly taskId: string;
  readonly approvalId: string | null;
  readonly idempotencyKey: string;
  readonly contentHash: string;
  readonly assetManifestHash: string;
  readonly accountId: string;
  readonly mode: PublishMode;
  readonly now: Date;
}

export interface AuditFilter {
  readonly taskId?: string;
  readonly action?: string;
  readonly limit?: number;
}

function str(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === 'string' ? value : String(value ?? '');
}

function nstr(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' ? value : null;
}

function nnum(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  return typeof value === 'number' ? value : null;
}

function num(row: Record<string, unknown>, key: string): number {
  return nnum(row, key) ?? 0;
}

function bool(row: Record<string, unknown>, key: string): boolean {
  return num(row, key) !== 0;
}

function json<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function mapTask(row: Record<string, unknown>): TaskRecord {
  return {
    taskId: str(row, 'task_id'),
    state: str(row, 'state') as MomentState,
    ideaId: nstr(row, 'idea_id'),
    draftId: nstr(row, 'draft_id'),
    visibility: (nstr(row, 'visibility') ?? 'PUBLIC') as Visibility,
    contentHash: nstr(row, 'content_hash'),
    assetManifestHash: nstr(row, 'asset_manifest_hash'),
    accountId: nstr(row, 'account_id'),
    approvalId: nstr(row, 'approval_id'),
    errorCode: nstr(row, 'error_code'),
    errorMessage: nstr(row, 'error_message'),
    createdAt: str(row, 'created_at'),
    updatedAt: str(row, 'updated_at'),
  };
}

function mapIdea(row: Record<string, unknown>): IdeaRecord {
  return {
    ideaId: str(row, 'idea_id'),
    taskId: str(row, 'task_id'),
    topic: str(row, 'topic'),
    motivation: str(row, 'motivation'),
    sourceType: str(row, 'source_type') as SourceType,
    sourceEvidence: str(row, 'source_evidence'),
    noveltyScore: num(row, 'novelty_score'),
    personaScore: num(row, 'persona_score'),
    relevanceScore: num(row, 'relevance_score'),
    riskFlags: json<RiskFlag[]>(row.risk_flags, []),
    createdAt: str(row, 'created_at'),
  };
}

function mapDraft(row: Record<string, unknown>): DraftRecord {
  return {
    draftId: str(row, 'draft_id'),
    taskId: str(row, 'task_id'),
    ideaId: str(row, 'idea_id'),
    version: num(row, 'version'),
    text: str(row, 'text'),
    tone: str(row, 'tone'),
    createdAt: str(row, 'created_at'),
    updatedAt: str(row, 'updated_at'),
  };
}

function mapImageTask(row: Record<string, unknown>): ImageTaskRecord {
  return {
    imageTaskId: str(row, 'image_task_id'),
    draftId: str(row, 'draft_id'),
    taskId: str(row, 'task_id'),
    prompt: str(row, 'prompt'),
    negativePrompt: str(row, 'negative_prompt'),
    aspectRatio: str(row, 'aspect_ratio'),
    resolution: str(row, 'resolution'),
    styleProfile: str(row, 'style_profile'),
    provider: str(row, 'provider') as ImageTaskRecord['provider'],
    status: str(row, 'status') as ImageTaskStatus,
    requiresUserAction: bool(row, 'requires_user_action'),
    attempts: num(row, 'attempts'),
    lastError: nstr(row, 'last_error'),
    createdAt: str(row, 'created_at'),
    updatedAt: str(row, 'updated_at'),
    expiresAt: str(row, 'expires_at'),
  };
}

function mapAsset(row: Record<string, unknown>): MediaAssetRecord {
  return {
    assetId: str(row, 'asset_id'),
    sha256: str(row, 'sha256'),
    path: str(row, 'path'),
    mime: str(row, 'mime'),
    width: num(row, 'width'),
    height: num(row, 'height'),
    bytes: num(row, 'bytes'),
    source: str(row, 'source') as MediaAssetRecord['source'],
    license: str(row, 'license'),
    prompt: str(row, 'prompt'),
    provider: str(row, 'provider'),
    model: str(row, 'model'),
    imageTaskId: nstr(row, 'image_task_id'),
    perceptualHash: nstr(row, 'perceptual_hash'),
    createdAt: str(row, 'created_at'),
  };
}

function mapReview(row: Record<string, unknown>): ImageReviewRecord {
  return {
    assetId: str(row, 'asset_id'),
    passed: bool(row, 'passed'),
    flags: json<RiskFlag[]>(row.flags, []),
    report: json<ImageReviewReport>(row.report, {
      exists: false,
      signatureMime: null,
      declaredMime: '',
      mimeMatched: false,
      width: 0,
      height: 0,
      aspectRatio: 0,
      bytes: 0,
      sha256: '',
      perceptualHash: null,
      nearDuplicateOf: null,
      relevantToText: null,
      qualityScore: 0,
      notes: [],
    }),
    reviewedAt: str(row, 'reviewed_at'),
  };
}

function mapApproval(row: Record<string, unknown>): ApprovalRecord {
  return {
    approvalId: str(row, 'approval_id'),
    taskId: str(row, 'task_id'),
    ownerId: str(row, 'owner_id'),
    contentHash: str(row, 'content_hash'),
    assetManifestHash: str(row, 'asset_manifest_hash'),
    visibility: str(row, 'visibility') as Visibility,
    accountId: str(row, 'account_id'),
    nonce: str(row, 'nonce'),
    status: str(row, 'status') as ApprovalStatus,
    channel: str(row, 'channel') as ApprovalChannel,
    createdAt: str(row, 'created_at'),
    expiresAt: str(row, 'expires_at'),
    decidedAt: nstr(row, 'decided_at'),
    consumedAt: nstr(row, 'consumed_at'),
  };
}

function mapAttempt(row: Record<string, unknown>): PublishAttemptRecord {
  return {
    attemptId: str(row, 'attempt_id'),
    taskId: str(row, 'task_id'),
    approvalId: nstr(row, 'approval_id'),
    idempotencyKey: str(row, 'idempotency_key'),
    contentHash: str(row, 'content_hash'),
    assetManifestHash: str(row, 'asset_manifest_hash'),
    accountId: str(row, 'account_id'),
    state: str(row, 'state') as PublishAttemptState,
    mode: str(row, 'mode') as PublishMode,
    createdAt: str(row, 'created_at'),
    updatedAt: str(row, 'updated_at'),
    screenshotPath: nstr(row, 'screenshot_path'),
    verification: json<PublishVerification | null>(row.verification, null),
    errorCode: nstr(row, 'error_code'),
  };
}

function mapPublished(row: Record<string, unknown>): PublishedPostRecord {
  return {
    postId: str(row, 'post_id'),
    taskId: str(row, 'task_id'),
    attemptId: str(row, 'attempt_id'),
    text: str(row, 'text'),
    visibility: str(row, 'visibility') as Visibility,
    accountId: str(row, 'account_id'),
    contentHash: str(row, 'content_hash'),
    publishedAt: str(row, 'published_at'),
    verified: bool(row, 'verified'),
  };
}

function mapAudit(row: Record<string, unknown>): AuditEventRecord {
  return {
    eventId: str(row, 'event_id'),
    at: str(row, 'at'),
    actor: str(row, 'actor'),
    action: str(row, 'action'),
    taskId: nstr(row, 'task_id'),
    previousState: nstr(row, 'previous_state'),
    nextState: nstr(row, 'next_state'),
    reason: str(row, 'reason'),
    metadata: json<Record<string, unknown>>(row.metadata, {}),
  };
}

const TASK_PATCH_FIELDS: Record<keyof TaskPatch, string> = {
  ideaId: 'idea_id',
  draftId: 'draft_id',
  visibility: 'visibility',
  contentHash: 'content_hash',
  assetManifestHash: 'asset_manifest_hash',
  accountId: 'account_id',
  approvalId: 'approval_id',
  errorCode: 'error_code',
  errorMessage: 'error_message',
};

export class MomentsStore {
  private readonly tx: TransactionScope;

  private constructor(
    private readonly driver: SqlDriver,
    readonly dbPath: string,
    private readonly now: () => Date,
  ) {
    this.tx = new TransactionScope(driver);
  }

  static async open(dbPath: string, options: { now?: () => Date } = {}): Promise<MomentsStore> {
    const now = options.now ?? (() => new Date());
    mkdirSync(path.dirname(dbPath), { recursive: true });
    const driver = await loadSqliteDriver(dbPath);
    migrate(driver, now);
    return new MomentsStore(driver, dbPath, now);
  }

  close(): void {
    this.driver.close();
  }

  /** 供需要跨仓储原子性的服务使用（例如审批决定 + 任务状态迁移）。 */
  runInTransaction<T>(fn: () => T): T {
    return this.tx.run(fn);
  }

  private at(): string {
    return this.now().toISOString();
  }

  // ---------------------------------------------------------------------------
  // 任务与状态机
  // ---------------------------------------------------------------------------

  createTask(taskId: string, visibility: Visibility = 'PUBLIC'): TaskRecord {
    const at = this.at();
    this.driver
      .prepare(
        `INSERT INTO moment_tasks (task_id, state, visibility, created_at, updated_at)
         VALUES (?, 'IDEA_CREATED', ?, ?, ?)`,
      )
      .run(taskId, visibility, at, at);
    return this.requireTask(taskId);
  }

  getTask(taskId: string): TaskRecord | undefined {
    const row = this.driver.prepare('SELECT * FROM moment_tasks WHERE task_id = ?').get(taskId);
    return row === undefined ? undefined : mapTask(row);
  }

  requireTask(taskId: string): TaskRecord {
    const task = this.getTask(taskId);
    if (task === undefined) {
      throw new MomentsError('NOT_FOUND', `任务不存在：${taskId}`, { details: { taskId } });
    }
    return task;
  }

  listTasks(states?: readonly MomentState[], limit = 50): TaskRecord[] {
    const capped = Math.min(Math.max(limit, 1), 500);
    if (states === undefined || states.length === 0) {
      return this.driver
        .prepare('SELECT * FROM moment_tasks ORDER BY updated_at DESC LIMIT ?')
        .all(capped)
        .map(mapTask);
    }
    const placeholders = states.map(() => '?').join(',');
    return this.driver
      .prepare(`SELECT * FROM moment_tasks WHERE state IN (${placeholders}) ORDER BY updated_at DESC LIMIT ?`)
      .all(...states, capped)
      .map(mapTask);
  }

  listOpenTasks(limit = 100): TaskRecord[] {
    return this.listTasks(TASK_STATES_OPEN, limit);
  }

  countTasksByState(): Record<string, number> {
    const rows = this.driver.prepare('SELECT state, COUNT(*) AS n FROM moment_tasks GROUP BY state').all();
    const counts: Record<string, number> = {};
    for (const row of rows) counts[str(row, 'state')] = num(row, 'n');
    return counts;
  }

  /**
   * 唯一合法的状态迁移入口：读取当前状态 -> 校验 -> 写状态/字段 -> 写审计事件。
   * 使用事务 + 乐观并发保护（WHERE state = ?）避免并发重复迁移。
   */
  transitionTask(taskId: string, input: TransitionInput): TransitionResult {
    return this.tx.run(() => {
      const current = this.requireTask(taskId);
      assertTransition(current.state, input.nextState);
      const at = this.at();
      const patch = input.patch ?? {};
      const assignments: string[] = ['state = ?', 'updated_at = ?'];
      const values: unknown[] = [input.nextState, at];
      for (const [key, column] of Object.entries(TASK_PATCH_FIELDS)) {
        const value = patch[key as keyof TaskPatch];
        if (value === undefined) continue;
        assignments.push(`${column} = ?`);
        values.push(value);
      }
      const changes = this.driver
        .prepare(`UPDATE moment_tasks SET ${assignments.join(', ')} WHERE task_id = ? AND state = ?`)
        .run(...values, taskId, current.state).changes;
      if (changes !== 1) {
        throw new MomentsError('CONFLICT', '任务状态已被其他操作修改，请重新读取后重试', {
          retryable: false,
          details: { taskId, expectedState: current.state },
        });
      }
      this.insertAuditInternal({
        eventId: newId('evt'),
        at,
        actor: input.actor,
        action: 'state_transition',
        taskId,
        previousState: current.state,
        nextState: input.nextState,
        reason: input.reason,
        metadata: input.metadata ?? {},
      });
      return { task: this.requireTask(taskId), previousState: current.state };
    });
  }

  /** 仅更新非状态字段；不得用于状态迁移。 */
  updateTaskFields(taskId: string, patch: TaskPatch): TaskRecord {
    const assignments: string[] = ['updated_at = ?'];
    const values: unknown[] = [this.at()];
    for (const [key, column] of Object.entries(TASK_PATCH_FIELDS)) {
      const value = patch[key as keyof TaskPatch];
      if (value === undefined) continue;
      assignments.push(`${column} = ?`);
      values.push(value);
    }
    this.driver.prepare(`UPDATE moment_tasks SET ${assignments.join(', ')} WHERE task_id = ?`).run(...values, taskId);
    return this.requireTask(taskId);
  }

  // ---------------------------------------------------------------------------
  // 想法
  // ---------------------------------------------------------------------------

  insertIdea(idea: IdeaRecord): void {
    this.driver
      .prepare(
        `INSERT INTO ideas (idea_id, task_id, topic, motivation, source_type, source_evidence,
          novelty_score, persona_score, relevance_score, risk_flags, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        idea.ideaId,
        idea.taskId,
        idea.topic,
        idea.motivation,
        idea.sourceType,
        idea.sourceEvidence,
        idea.noveltyScore,
        idea.personaScore,
        idea.relevanceScore,
        JSON.stringify(idea.riskFlags),
        idea.createdAt,
      );
  }

  getIdea(ideaId: string): IdeaRecord | undefined {
    const row = this.driver.prepare('SELECT * FROM ideas WHERE idea_id = ?').get(ideaId);
    return row === undefined ? undefined : mapIdea(row);
  }

  getIdeaByTask(taskId: string): IdeaRecord | undefined {
    const row = this.driver.prepare('SELECT * FROM ideas WHERE task_id = ?').get(taskId);
    return row === undefined ? undefined : mapIdea(row);
  }

  listIdeas(limit = 20): IdeaRecord[] {
    return this.driver
      .prepare('SELECT * FROM ideas ORDER BY created_at DESC LIMIT ?')
      .all(Math.min(Math.max(limit, 1), 200))
      .map(mapIdea);
  }

  /** 近期已发布文案，用于去重与重复度评分。 */
  recentPublishedTexts(limit = 20): { text: string; publishedAt: string }[] {
    return this.driver
      .prepare('SELECT text, published_at FROM published_posts ORDER BY published_at DESC LIMIT ?')
      .all(Math.min(Math.max(limit, 1), 100))
      .map((row) => ({ text: str(row, 'text'), publishedAt: str(row, 'published_at') }));
  }

  // ---------------------------------------------------------------------------
  // 草稿
  // ---------------------------------------------------------------------------

  createDraft(draft: DraftRecord, contentHash: string): DraftRecord {
    return this.tx.run(() => {
      this.driver.prepare('UPDATE drafts SET is_current = 0 WHERE task_id = ? AND is_current = 1').run(draft.taskId);
      this.driver
        .prepare(
          `INSERT INTO drafts (draft_id, task_id, idea_id, version, text, tone, is_current, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(draft.draftId, draft.taskId, draft.ideaId, draft.version, draft.text, draft.tone, draft.createdAt, draft.updatedAt);
      this.driver
        .prepare('INSERT INTO draft_versions (draft_id, version, text, content_hash, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(draft.draftId, draft.version, draft.text, contentHash, draft.createdAt);
      this.driver.prepare('UPDATE moment_tasks SET draft_id = ?, updated_at = ? WHERE task_id = ?').run(
        draft.draftId,
        draft.updatedAt,
        draft.taskId,
      );
      return this.requireDraft(draft.draftId);
    });
  }

  getDraft(draftId: string): DraftRecord | undefined {
    const row = this.driver.prepare('SELECT * FROM drafts WHERE draft_id = ?').get(draftId);
    return row === undefined ? undefined : mapDraft(row);
  }

  requireDraft(draftId: string): DraftRecord {
    const draft = this.getDraft(draftId);
    if (draft === undefined) throw new MomentsError('NOT_FOUND', `草稿不存在：${draftId}`);
    return draft;
  }

  getCurrentDraftForTask(taskId: string): DraftRecord | undefined {
    const row = this.driver.prepare('SELECT * FROM drafts WHERE task_id = ? AND is_current = 1').get(taskId);
    return row === undefined ? undefined : mapDraft(row);
  }

  requireCurrentDraft(taskId: string): DraftRecord {
    const draft = this.getCurrentDraftForTask(taskId);
    if (draft === undefined) throw new MomentsError('NOT_FOUND', `任务没有当前草稿：${taskId}`);
    return draft;
  }

  updateDraftText(draftId: string, text: string, contentHash: string, tone?: string): DraftRecord {
    return this.tx.run(() => {
      const draft = this.requireDraft(draftId);
      const version = draft.version + 1;
      const at = this.at();
      this.driver
        .prepare('UPDATE drafts SET version = ?, text = ?, tone = ?, updated_at = ? WHERE draft_id = ?')
        .run(version, text, tone ?? draft.tone, at, draftId);
      this.driver
        .prepare('INSERT INTO draft_versions (draft_id, version, text, content_hash, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(draftId, version, text, contentHash, at);
      this.driver.prepare('UPDATE moment_tasks SET updated_at = ? WHERE task_id = ?').run(at, draft.taskId);
      return this.requireDraft(draftId);
    });
  }

  listDraftVersions(draftId: string): DraftVersionRecord[] {
    return this.driver
      .prepare('SELECT * FROM draft_versions WHERE draft_id = ? ORDER BY version')
      .all(draftId)
      .map((row) => ({
        draftId: str(row, 'draft_id'),
        version: num(row, 'version'),
        text: str(row, 'text'),
        contentHash: str(row, 'content_hash'),
        createdAt: str(row, 'created_at'),
      }));
  }

  // ---------------------------------------------------------------------------
  // 图片任务
  // ---------------------------------------------------------------------------

  insertImageTask(task: ImageTaskRecord): void {
    this.driver
      .prepare(
        `INSERT INTO image_tasks (image_task_id, draft_id, task_id, prompt, negative_prompt, aspect_ratio,
          resolution, style_profile, provider, status, requires_user_action, attempts, last_error,
          created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.imageTaskId,
        task.draftId,
        task.taskId,
        task.prompt,
        task.negativePrompt,
        task.aspectRatio,
        task.resolution,
        task.styleProfile,
        task.provider,
        task.status,
        task.requiresUserAction ? 1 : 0,
        task.attempts,
        task.lastError,
        task.createdAt,
        task.updatedAt,
        task.expiresAt,
      );
  }

  getImageTask(imageTaskId: string): ImageTaskRecord | undefined {
    const row = this.driver.prepare('SELECT * FROM image_tasks WHERE image_task_id = ?').get(imageTaskId);
    return row === undefined ? undefined : mapImageTask(row);
  }

  requireImageTask(imageTaskId: string): ImageTaskRecord {
    const task = this.getImageTask(imageTaskId);
    if (task === undefined) throw new MomentsError('IMAGE_TASK_NOT_FOUND', `图片任务不存在：${imageTaskId}`);
    return task;
  }

  listImageTasksByTask(taskId: string): ImageTaskRecord[] {
    return this.driver
      .prepare('SELECT * FROM image_tasks WHERE task_id = ? ORDER BY created_at')
      .all(taskId)
      .map(mapImageTask);
  }

  updateImageTask(
    imageTaskId: string,
    patch: Partial<Pick<ImageTaskRecord, 'status' | 'requiresUserAction' | 'attempts' | 'lastError' | 'updatedAt'>>,
  ): ImageTaskRecord {
    const assignments: string[] = ['updated_at = ?'];
    const values: unknown[] = [patch.updatedAt ?? this.at()];
    if (patch.status !== undefined) {
      assignments.push('status = ?');
      values.push(patch.status);
    }
    if (patch.requiresUserAction !== undefined) {
      assignments.push('requires_user_action = ?');
      values.push(patch.requiresUserAction ? 1 : 0);
    }
    if (patch.attempts !== undefined) {
      assignments.push('attempts = ?');
      values.push(patch.attempts);
    }
    if (patch.lastError !== undefined) {
      assignments.push('last_error = ?');
      values.push(patch.lastError);
    }
    this.driver.prepare(`UPDATE image_tasks SET ${assignments.join(', ')} WHERE image_task_id = ?`).run(
      ...values,
      imageTaskId,
    );
    return this.requireImageTask(imageTaskId);
  }

  // ---------------------------------------------------------------------------
  // 媒体与审核
  // ---------------------------------------------------------------------------

  /** 按 SHA-256 去重插入；返回是否命中已有素材。 */
  insertAsset(asset: MediaAssetRecord): { asset: MediaAssetRecord; duplicate: boolean } {
    return this.tx.run(() => {
      const existing = this.getAssetBySha(asset.sha256);
      if (existing !== undefined) return { asset: existing, duplicate: true };
      this.driver
        .prepare(
          `INSERT INTO media_assets (asset_id, sha256, path, mime, width, height, bytes, source,
            license, prompt, provider, model, image_task_id, perceptual_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          asset.assetId,
          asset.sha256,
          asset.path,
          asset.mime,
          asset.width,
          asset.height,
          asset.bytes,
          asset.source,
          asset.license,
          asset.prompt,
          asset.provider,
          asset.model,
          asset.imageTaskId,
          asset.perceptualHash,
          asset.createdAt,
        );
      return { asset, duplicate: false };
    });
  }

  getAsset(assetId: string): MediaAssetRecord | undefined {
    const row = this.driver.prepare('SELECT * FROM media_assets WHERE asset_id = ?').get(assetId);
    return row === undefined ? undefined : mapAsset(row);
  }

  requireAsset(assetId: string): MediaAssetRecord {
    const asset = this.getAsset(assetId);
    if (asset === undefined) throw new MomentsError('NOT_FOUND', `媒体素材不存在：${assetId}`);
    return asset;
  }

  getAssetBySha(sha256: string): MediaAssetRecord | undefined {
    const row = this.driver.prepare('SELECT * FROM media_assets WHERE sha256 = ?').get(sha256);
    return row === undefined ? undefined : mapAsset(row);
  }

  linkAssetToTask(taskId: string, assetId: string, position: number): void {
    this.driver
      .prepare(
        `INSERT INTO task_assets (task_id, asset_id, position) VALUES (?, ?, ?)
         ON CONFLICT(task_id, asset_id) DO UPDATE SET position = excluded.position`,
      )
      .run(taskId, assetId, position);
  }

  replaceTaskAssets(taskId: string, assetIds: readonly string[]): void {
    this.tx.run(() => {
      this.driver.prepare('DELETE FROM task_assets WHERE task_id = ?').run(taskId);
      assetIds.forEach((assetId, index) => this.linkAssetToTask(taskId, assetId, index));
    });
  }

  listTaskAssets(taskId: string): MediaAssetRecord[] {
    return this.driver
      .prepare(
        `SELECT a.* FROM media_assets a JOIN task_assets t ON t.asset_id = a.asset_id
         WHERE t.task_id = ? ORDER BY t.position`,
      )
      .all(taskId)
      .map(mapAsset);
  }

  listRecentAssets(limit = 30): MediaAssetRecord[] {
    return this.driver
      .prepare('SELECT * FROM media_assets ORDER BY created_at DESC LIMIT ?')
      .all(Math.min(Math.max(limit, 1), 200))
      .map(mapAsset);
  }

  saveImageReview(assetId: string, review: { passed: boolean; flags: readonly RiskFlag[]; report: ImageReviewReport }, at = this.at()): void {
    this.driver
      .prepare(
        `INSERT INTO image_reviews (asset_id, passed, flags, report, reviewed_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(asset_id) DO UPDATE SET passed = excluded.passed, flags = excluded.flags,
           report = excluded.report, reviewed_at = excluded.reviewed_at`,
      )
      .run(assetId, review.passed ? 1 : 0, JSON.stringify(review.flags), JSON.stringify(review.report), at);
  }

  getImageReview(assetId: string): ImageReviewRecord | undefined {
    const row = this.driver.prepare('SELECT * FROM image_reviews WHERE asset_id = ?').get(assetId);
    return row === undefined ? undefined : mapReview(row);
  }

  // ---------------------------------------------------------------------------
  // 审批
  // ---------------------------------------------------------------------------

  insertApproval(approval: ApprovalRecord): void {
    this.driver
      .prepare(
        `INSERT INTO approvals (approval_id, task_id, owner_id, content_hash, asset_manifest_hash,
          visibility, account_id, nonce, status, channel, created_at, expires_at, decided_at, consumed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        approval.approvalId,
        approval.taskId,
        approval.ownerId,
        approval.contentHash,
        approval.assetManifestHash,
        approval.visibility,
        approval.accountId,
        approval.nonce,
        approval.status,
        approval.channel,
        approval.createdAt,
        approval.expiresAt,
        approval.decidedAt,
        approval.consumedAt,
      );
  }

  getApproval(approvalId: string): ApprovalRecord | undefined {
    const row = this.driver.prepare('SELECT * FROM approvals WHERE approval_id = ?').get(approvalId);
    return row === undefined ? undefined : mapApproval(row);
  }

  requireApproval(approvalId: string): ApprovalRecord {
    const approval = this.getApproval(approvalId);
    if (approval === undefined) throw new MomentsError('APPROVAL_INVALID', `审批不存在：${approvalId}`);
    return approval;
  }

  listApprovalsForTask(taskId: string): ApprovalRecord[] {
    return this.driver
      .prepare('SELECT * FROM approvals WHERE task_id = ? ORDER BY created_at DESC')
      .all(taskId)
      .map(mapApproval);
  }

  listPendingApprovals(limit = 50): ApprovalRecord[] {
    return this.driver
      .prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at DESC LIMIT ?")
      .all(Math.min(Math.max(limit, 1), 200))
      .map(mapApproval);
  }

  /** CAS 更新审批状态；只有当前状态在 allowedFrom 中才成功。 */
  decideApproval(
    approvalId: string,
    next: ApprovalStatus,
    allowedFrom: readonly ApprovalStatus[],
    at = this.at(),
  ): ApprovalRecord | undefined {
    return this.tx.run(() => {
      const current = this.getApproval(approvalId);
      if (current === undefined) return undefined;
      if (!allowedFrom.includes(current.status)) return current;
      const decidedAt = next === 'approved' || next === 'rejected' ? at : current.decidedAt;
      const changes = this.driver
        .prepare('UPDATE approvals SET status = ?, decided_at = ? WHERE approval_id = ? AND status = ?')
        .run(next, decidedAt, approvalId, current.status).changes;
      if (changes !== 1) return this.getApproval(approvalId);
      this.insertAuditInternal({
        eventId: newId('evt'),
        at,
        actor: 'owner',
        action: `approval_${next}`,
        taskId: current.taskId,
        previousState: null,
        nextState: null,
        reason: `审批 ${approvalId} -> ${next}`,
        metadata: { approvalId, from: current.status },
      });
      return this.getApproval(approvalId);
    });
  }

  supersedePendingApprovals(taskId: string, at = this.at()): number {
    return this.driver
      .prepare("UPDATE approvals SET status = 'superseded', decided_at = ? WHERE task_id = ? AND status = 'pending'")
      .run(at, taskId).changes;
  }

  // ---------------------------------------------------------------------------
  // 发布尝试与已发布记录
  // ---------------------------------------------------------------------------

  createAttempt(input: CreateAttemptInput): { attempt: PublishAttemptRecord; created: boolean } {
    return this.tx.run(() => {
      const existing = this.findAttemptByIdempotencyKey(input.idempotencyKey);
      if (existing !== undefined) return { attempt: existing, created: false };
      const at = input.now.toISOString();
      this.driver
        .prepare(
          `INSERT INTO publish_attempts (attempt_id, task_id, approval_id, idempotency_key, content_hash,
            asset_manifest_hash, account_id, state, mode, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'PLANNED', ?, ?, ?)`,
        )
        .run(
          input.attemptId,
          input.taskId,
          input.approvalId,
          input.idempotencyKey,
          input.contentHash,
          input.assetManifestHash,
          input.accountId,
          input.mode,
          at,
          at,
        );
      return { attempt: this.requireAttempt(input.attemptId), created: true };
    });
  }

  getAttempt(attemptId: string): PublishAttemptRecord | undefined {
    const row = this.driver.prepare('SELECT * FROM publish_attempts WHERE attempt_id = ?').get(attemptId);
    return row === undefined ? undefined : mapAttempt(row);
  }

  requireAttempt(attemptId: string): PublishAttemptRecord {
    const attempt = this.getAttempt(attemptId);
    if (attempt === undefined) throw new MomentsError('NOT_FOUND', `发布尝试不存在：${attemptId}`);
    return attempt;
  }

  findAttemptByIdempotencyKey(idempotencyKey: string): PublishAttemptRecord | undefined {
    const row = this.driver.prepare('SELECT * FROM publish_attempts WHERE idempotency_key = ?').get(idempotencyKey);
    return row === undefined ? undefined : mapAttempt(row);
  }

  listAttemptsForTask(taskId: string): PublishAttemptRecord[] {
    return this.driver
      .prepare('SELECT * FROM publish_attempts WHERE task_id = ? ORDER BY created_at')
      .all(taskId)
      .map(mapAttempt);
  }

  updateAttempt(
    attemptId: string,
    patch: {
      state?: PublishAttemptState;
      screenshotPath?: string | null;
      verification?: PublishVerification | null;
      errorCode?: string | null;
    },
  ): PublishAttemptRecord {
    const assignments: string[] = ['updated_at = ?'];
    const values: unknown[] = [this.at()];
    if (patch.state !== undefined) {
      assignments.push('state = ?');
      values.push(patch.state);
    }
    if (patch.screenshotPath !== undefined) {
      assignments.push('screenshot_path = ?');
      values.push(patch.screenshotPath);
    }
    if (patch.verification !== undefined) {
      assignments.push('verification = ?');
      values.push(patch.verification === null ? null : JSON.stringify(patch.verification));
    }
    if (patch.errorCode !== undefined) {
      assignments.push('error_code = ?');
      values.push(patch.errorCode);
    }
    this.driver.prepare(`UPDATE publish_attempts SET ${assignments.join(', ')} WHERE attempt_id = ?`).run(...values, attemptId);
    return this.requireAttempt(attemptId);
  }

  insertPublished(post: PublishedPostRecord): void {
    this.driver
      .prepare(
        `INSERT INTO published_posts (post_id, task_id, attempt_id, text, visibility, account_id,
          content_hash, published_at, verified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        post.postId,
        post.taskId,
        post.attemptId,
        post.text,
        post.visibility,
        post.accountId,
        post.contentHash,
        post.publishedAt,
        post.verified ? 1 : 0,
      );
  }

  getPublishedByAttempt(attemptId: string): PublishedPostRecord | undefined {
    const row = this.driver.prepare('SELECT * FROM published_posts WHERE attempt_id = ?').get(attemptId);
    return row === undefined ? undefined : mapPublished(row);
  }

  getPublishedByContentHash(contentHash: string): PublishedPostRecord | undefined {
    const row = this.driver.prepare('SELECT * FROM published_posts WHERE content_hash = ?').get(contentHash);
    return row === undefined ? undefined : mapPublished(row);
  }

  listPublished(limit = 20): PublishedPostRecord[] {
    return this.driver
      .prepare('SELECT * FROM published_posts ORDER BY published_at DESC LIMIT ?')
      .all(Math.min(Math.max(limit, 1), 200))
      .map(mapPublished);
  }

  countPublishedSince(isoThreshold: string): number {
    const row = this.driver
      .prepare('SELECT COUNT(*) AS n FROM published_posts WHERE published_at >= ?')
      .get(isoThreshold);
    return row === undefined ? 0 : num(row, 'n');
  }

  latestPublishedAt(): string | null {
    const row = this.driver.prepare('SELECT MAX(published_at) AS at FROM published_posts').get();
    return row === undefined ? null : nstr(row, 'at');
  }

  // ---------------------------------------------------------------------------
  // 设置、偏好、记忆、审计
  // ---------------------------------------------------------------------------

  getSetting(key: string): string | undefined {
    const row = this.driver.prepare('SELECT value FROM system_settings WHERE key = ?').get(key);
    return row === undefined ? undefined : str(row, 'value');
  }

  /** 先持久化领取，再执行命令；崩溃后不重放。失败由所有者重新发送新消息。 */
  claimOwnerCommand(key: string): boolean {
    return this.driver.prepare(
      'INSERT OR IGNORE INTO owner_command_receipts(command_key, claimed_at) VALUES (?, ?)',
    ).run(key, this.at()).changes === 1;
  }

  deleteMemory(memoryId: string): void {
    this.driver.prepare('DELETE FROM persona_memories WHERE memory_id = ?').run(memoryId);
  }

  setSetting(key: string, value: string): void {
    this.driver
      .prepare(
        `INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, this.at());
  }

  getPreference(key: string): UserPreferenceRecord | undefined {
    const row = this.driver.prepare('SELECT * FROM user_preferences WHERE key = ?').get(key);
    return row === undefined
      ? undefined
      : { key: str(row, 'key'), value: str(row, 'value'), updatedAt: str(row, 'updated_at') };
  }

  setPreference(key: string, value: string): void {
    this.driver
      .prepare(
        `INSERT INTO user_preferences (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, this.at());
  }

  upsertMemory(kind: PersonaMemoryRecord['kind'], key: string, value: string): PersonaMemoryRecord {
    const at = this.at();
    this.driver
      .prepare(
        `INSERT INTO persona_memories (memory_id, kind, key, value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(kind, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(newId('mem'), kind, key, value, at, at);
    const row = this.driver.prepare('SELECT * FROM persona_memories WHERE kind = ? AND key = ?').get(kind, key);
    return {
      memoryId: str(row ?? {}, 'memory_id'),
      kind,
      key,
      value,
      createdAt: str(row ?? {}, 'created_at'),
      updatedAt: str(row ?? {}, 'updated_at'),
    };
  }

  listMemories(kind?: PersonaMemoryRecord['kind'], limit = 50): PersonaMemoryRecord[] {
    const rows =
      kind === undefined
        ? this.driver.prepare('SELECT * FROM persona_memories ORDER BY updated_at DESC LIMIT ?').all(limit)
        : this.driver
            .prepare('SELECT * FROM persona_memories WHERE kind = ? ORDER BY updated_at DESC LIMIT ?')
            .all(kind, limit);
    return rows.map((row) => ({
      memoryId: str(row, 'memory_id'),
      kind: str(row, 'kind') as PersonaMemoryRecord['kind'],
      key: str(row, 'key'),
      value: str(row, 'value'),
      createdAt: str(row, 'created_at'),
      updatedAt: str(row, 'updated_at'),
    }));
  }

  appendAudit(event: Omit<AuditEventRecord, 'eventId'>): AuditEventRecord {
    return this.tx.run(() => {
      const record: AuditEventRecord = { ...event, eventId: newId('evt') };
      this.insertAuditInternal(record);
      return record;
    });
  }

  private insertAuditInternal(event: AuditEventRecord): void {
    this.driver
      .prepare(
        `INSERT INTO audit_events (event_id, at, actor, action, task_id, previous_state, next_state, reason, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.eventId,
        event.at,
        event.actor,
        event.action,
        event.taskId,
        event.previousState,
        event.nextState,
        event.reason,
        JSON.stringify(event.metadata),
      );
  }

  listAudit(filter: AuditFilter = {}): AuditEventRecord[] {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (filter.taskId !== undefined) {
      conditions.push('task_id = ?');
      values.push(filter.taskId);
    }
    if (filter.action !== undefined) {
      conditions.push('action = ?');
      values.push(filter.action);
    }
    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
    return this.driver
      .prepare(`SELECT * FROM audit_events ${where} ORDER BY at DESC LIMIT ?`)
      .all(...values, limit)
      .map(mapAudit);
  }

  // ---------------------------------------------------------------------------
  // 组合查询
  // ---------------------------------------------------------------------------

  /**
   * 生成预览包：文案 + 素材 + 当前哈希。审批与发布前都必须实时重算，避免旧快照。
   */
  buildPreview(taskId: string): PreviewPackage {
    const task = this.requireTask(taskId);
    const draft = this.getCurrentDraftForTask(taskId);
    const assets = this.listTaskAssets(taskId);
    const assetHashes = assets.map((asset) => asset.sha256);
    const text = draft?.text ?? '';
    const contentHash = computeContentHash({
      text,
      assetHashes,
      visibility: task.visibility,
      accountId: task.accountId ?? '',
    });
    const approval = this.listApprovalsForTask(taskId).find((item) => item.status === 'approved') ?? null;
    const warnings: string[] = [];
    if (draft === undefined) warnings.push('草稿不存在');
    if (task.accountId === null) warnings.push('目标微信账号未确认');
    if (!isTerminal(task.state) && approval === null) warnings.push('尚未获得有效审批');
    return {
      taskId,
      state: task.state,
      text,
      visibility: task.visibility,
      accountId: task.accountId,
      contentHash,
      assetManifestHash: sha256Hex(stableStringify({ version: 1, assets: [...assetHashes].sort() })),
      assets,
      approvalRequired: true,
      approvalId: approval?.approvalId ?? null,
      warnings,
    };
  }

  countAssets(): number {
    const row = this.driver.prepare('SELECT COUNT(*) AS n FROM media_assets').get();
    return row === undefined ? 0 : num(row, 'n');
  }

  assertState(taskId: string, expected: readonly MomentState[]): TaskRecord {
    const task = this.requireTask(taskId);
    if (!expected.includes(task.state)) {
      throw new MomentsError('CONFLICT', `任务 ${taskId} 当前状态为 ${task.state}，期望 ${expected.join('/')}`, {
        details: { taskId, state: task.state, expected },
      });
    }
    return task;
  }
}


