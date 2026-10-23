/**
 * Moments 运行时：把领域服务、适配器和持久化组装成可被 DSH 工具调用的应用层。
 *
 * 该文件不导入任何 DSH 内部包，只依赖结构化接口；测试可以用 Mock 适配器
 * 完整驱动“选题 -> 文案 -> 审核 -> 审批 -> 准备 -> 发布 -> 核验”链路。
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { MomentsError, type ToolResultEnvelope } from './domain/result.js';
import {
  computeAssetManifestHash,
  computeContentHash,
  newId,
} from './domain/ids.js';
import type {
  AdapterHealth,
  ApprovalRequestView,
  ImageTaskRecord,
  MediaAssetRecord,
  PreviewPackage,
  PublishAttemptRecord,
  PublishMode,
  TaskRecord,
} from './domain/types.js';
import { parseConfig, type MomentsConfig } from './config.js';
import type {
  ImageFacade,
  LlmClient,
  Logger,
  OwnerChannel,
  OwnerMessage,
  WeChatAgentAdapter,
  DesktopExecutor,
} from './adapters/types.js';
import type { MomentsStore } from './storage/store.js';
import { ControlState } from './security/kill-switch.js';
import { PersonaLoader, type PersonaDocument } from './brain/persona.js';
import { IdeaGenerator, assertKnownSourceType, type IdeaCandidate } from './brain/idea-generator.js';
import { ContentComposer } from './brain/content-composer.js';
import { ContentReviewer } from './brain/content-reviewer.js';
import { DecisionEngine, todayThreshold, type DecisionContext } from './brain/decision-engine.js';
import { ApprovalService } from './approval/approval-service.js';
import { assertOwnerIdentity, parseOwnerCommand } from './approval/owner-channels.js';
import { Publisher } from './publishing/publisher.js';
import { effectivePublishMode } from './publishing/publish-policy.js';
import { redactSecrets } from './security/redaction.js';
import { resolveInsideRoot } from './security/path-guard.js';
import { extractJsonObject } from './security/prompt-injection.js';
import { expirePendingTasks } from './storage/recovery.js';
import { PROVIDER_NAME_TO_KIND, PROVIDER_KIND_TO_NAME } from './image/providers/index.js';

export interface RuntimeDeps {
  readonly config: MomentsConfig;
  readonly store: MomentsStore;
  readonly dataDir: string;
  readonly packageRoot: string;
  readonly logger: Logger;
  readonly llm: LlmClient;
  readonly ownerChannel: OwnerChannel;
  readonly wechat: WeChatAgentAdapter | null;
  readonly desktop: DesktopExecutor;
  readonly image: ImageFacade;
  readonly clock?: () => Date;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly version: string;
  readonly dshVersion?: string | null;
}

export interface RuntimeStatus {
  readonly control: {
    killSwitch: boolean;
    paused: boolean;
    pauseReason: string;
    publishMode: PublishMode;
    effectivePublishMode: PublishMode;
    scheduleEnabled: boolean;
    ownerChannel: string;
  };
  readonly accountId: string | null;
  readonly task: TaskRecord | null;
  readonly attempts: readonly PublishAttemptRecord[];
  readonly approvals: readonly ReturnType<MomentsStore['listApprovalsForTask']>[number][];
  readonly imageTasks: readonly ImageTaskRecord[];
  readonly openTasks: readonly TaskRecord[];
  readonly pendingApprovals: readonly ReturnType<MomentsStore['listPendingApprovals']>[number][];
  readonly counts: Record<string, number>;
}

const MAX_COMMAND_MESSAGES_PER_POLL = 20;

export class MomentsRuntime {
  readonly control: ControlState;
  readonly approvalService: ApprovalService;
  readonly publisher: Publisher;
  readonly decision: DecisionEngine;
  private readonly personaLoader: PersonaLoader;
  private personaCache: PersonaDocument | null = null;
  private readonly ideaGenerator: IdeaGenerator;
  private readonly composer: ContentComposer;
  private readonly reviewer: ContentReviewer;
  private commandTimerDisposer: (() => void) | null = null;
  private scheduleTimerDisposer: (() => void) | null = null;
  private readonly seenCommandIds = new Set<string>();
  private lastCommandAt = '';
  private lastAutonomousAt: string | null = null;
  private readonly clock: () => Date;
  private readonly env: Readonly<Record<string, string | undefined>>;
  private stopped = false;
  private autonomousRunning = false;
  private commandRunning = false;
  private importsRunning = false;
  private readonly composingTasks = new Set<string>();
  private readonly pending = new Set<Promise<void>>();
  private readonly abort = new AbortController();

  private assertActive(): void {
    if (this.stopped) throw new MomentsError('POLICY_DENIED', '运行时已停止');
    if (this.control.killSwitch || this.deps.config.killSwitch) throw new MomentsError('KILL_SWITCH_ACTIVE', '全局 Kill Switch 已启用');
    if (this.control.paused) throw new MomentsError('PAUSED', '系统已暂停');
  }

  private memoryTexts(): string[] {
    return this.deps.store.listMemories(undefined, 20)
      .filter((entry) => entry.kind !== 'operational')
      .map((entry) => `${entry.kind}/${entry.key}: ${entry.value}`.slice(0, 600));
  }

  listMemories() { return this.deps.store.listMemories(undefined, 100); }

  saveMemory(input: { kind: string; key: string; value: string }) {
    if (!['persona', 'episodic', 'semantic', 'operational'].includes(input.kind) ||
        !input.key?.trim() || input.key.length > 120 || !input.value?.trim() || input.value.length > 2000) {
      throw new MomentsError('INVALID_INPUT', '记忆类型、键或内容无效（键最多 120 字，内容最多 2000 字）');
    }
    return this.deps.store.upsertMemory(
      input.kind as 'persona' | 'episodic' | 'semantic' | 'operational', input.key.trim(), redactSecrets(input.value.trim()),
    );
  }

  deleteMemory(memoryId: string): void { this.deps.store.deleteMemory(memoryId); }

  constructor(private readonly deps: RuntimeDeps) {
    this.clock = deps.clock ?? (() => new Date());
    this.env = deps.env ?? process.env;
    this.control = new ControlState(deps.store);
    this.decision = new DecisionEngine();
    this.approvalService = new ApprovalService(deps.store, deps.config, deps.logger, this.clock);
    this.publisher = new Publisher(
      deps.store,
      this.approvalService,
      deps.desktop,
      deps.config,
      this.control,
      deps.logger,
      deps.dataDir,
      this.clock,
      this.env,
    );
    this.personaLoader = new PersonaLoader(
      deps.packageRoot,
      { soul: deps.config.workspace.personaFile, visualStyle: deps.config.workspace.visualStyleFile },
      deps.logger,
      this.clock,
    );
    const cancellableLlm: LlmClient = {
      checkCapabilities: () => deps.llm.checkCapabilities(),
      complete: (request) => {
        this.abort.signal.throwIfAborted();
        return deps.llm.complete({ ...request, signal: AbortSignal.any(
          [this.abort.signal, ...(request.signal ? [request.signal] : [])],
        ) });
      },
    };
    this.ideaGenerator = new IdeaGenerator(
      cancellableLlm,
      () => this.persona(),
      deps.logger,
      {
        maxTextLength: deps.config.policy.maxTextLength,
        minScoreToPublish: deps.config.policy.minScoreToPublish,
      },
      this.clock,
    );
    this.composer = new ContentComposer(cancellableLlm, () => this.persona(), deps.logger, {
      maxTextLength: deps.config.policy.maxTextLength,
    });
    this.reviewer = new ContentReviewer(this.decision, cancellableLlm, deps.logger, {
      useLlmReview: true,
    });
  }

  persona(): PersonaDocument {
    this.personaCache ??= this.personaLoader.load();
    return {
      ...this.personaCache,
      soul: this.deps.store.getSetting('persona_soul') ?? this.personaCache.soul,
      visualStyle: this.deps.store.getSetting('persona_visual_style') ?? this.personaCache.visualStyle,
    };
  }

  updatePersona(input: { soul: string; visualStyle: string }): void {
    if (!input.soul.trim() || !input.visualStyle.trim() || input.soul.length > 32000 || input.visualStyle.length > 16000) {
      throw new MomentsError('INVALID_INPUT', '人格或配图风格为空或过长');
    }
    this.deps.store.runInTransaction(() => {
      this.deps.store.setSetting('persona_soul', input.soul);
      this.deps.store.setSetting('persona_visual_style', input.visualStyle);
      this.deps.store.upsertMemory('operational', 'persona_updated', this.iso());
    });
  }

  scheduleView() {
    const saved = this.deps.store.getSetting('schedule_config');
    if (saved) {
      const value = JSON.parse(saved) as Record<string, unknown>;
      const validated = parseConfig({ ...this.deps.config, ...value });
      return { scheduleEnabled: validated.scheduleEnabled, scheduler: validated.scheduler };
    }
    return { scheduleEnabled: this.deps.config.scheduleEnabled, scheduler: this.deps.config.scheduler };
  }

  updateSchedule(input: Record<string, unknown>): ReturnType<MomentsRuntime['scheduleView']> {
    if (Object.keys(input).some((key) => !['scheduleEnabled', 'scheduler'].includes(key))) {
      throw new MomentsError('INVALID_INPUT', '只能修改自主创作调度，不允许修改发布权限或账号');
    }
    const validated = parseConfig({ ...this.deps.config, ...this.scheduleView(), ...input });
    const settings = { scheduleEnabled: validated.scheduleEnabled, scheduler: validated.scheduler };
    this.deps.store.setSetting('schedule_config', JSON.stringify(settings));
    this.deps.store.upsertMemory('operational', 'schedule_updated', this.iso());
    return settings;
  }

  private now(): Date {
    return this.clock();
  }

  private iso(): string {
    return this.now().toISOString();
  }

  /** 目标微信账号：优先 WeChatAgent 实时校验结果，其次桌面执行器状态，最后配置值。 */
  async resolveAccountId(): Promise<string | null> {
    if (this.deps.wechat !== null && this.deps.config.wechatAgent.enabled) {
      const account = await this.deps.wechat.getAccount();
      if (account !== null) return account.accountId;
    }
    if (this.deps.config.desktopExecutor.enabled) {
      try {
        const status = await this.deps.desktop.status();
        if (status.loggedIn && status.accountId !== null) return status.accountId;
      } catch {
        // 桌面不可用时回退到配置
      }
    }
    if (this.deps.config.wechatAgent.account !== '') return this.deps.config.wechatAgent.account.toLowerCase();
    return null;
  }

  private async decisionContext(extra: { recentIdeaTopics?: readonly string[] } = {}): Promise<DecisionContext> {
    const now = this.now();
    const accountId = await this.resolveAccountId();
    return {
      config: this.deps.config,
      now,
      killSwitch: this.control.killSwitch || this.deps.config.killSwitch,
      paused: this.control.paused,
      accountId,
      publishedToday: this.deps.store.countPublishedSince(todayThreshold(now, this.deps.config.policy.timeZone)),
      lastPublishedAt: this.deps.store.latestPublishedAt(),
      recentTexts: this.deps.store.recentPublishedTexts(20).map((item) => item.text),
      recentIdeaTopics: extra.recentIdeaTopics,
    };
  }

  // -------------------------------------------------------------------------
  // 健康与状态
  // -------------------------------------------------------------------------

  async health(): Promise<import('./domain/types.js').HealthSnapshot> {
    const [llmHealth, ownerHealth, imageCaps, desktopHealth] = await Promise.all([
      this.deps.llm.checkCapabilities(),
      this.deps.ownerChannel.checkHealth(),
      this.deps.image.listCapabilities().catch(() => []),
      this.deps.desktop.health().catch(() => null),
    ]);
    const wechatHealth: AdapterHealth =
      this.deps.wechat === null
        ? { status: 'not_configured', message: '未启用 WeChatAgent 适配器' }
        : await this.deps.wechat.checkHealth();
    const desktop: AdapterHealth =
      desktopHealth === null
        ? { status: 'unavailable', message: '桌面执行器不可用' }
        : {
            status: !desktopHealth.ok ? 'unavailable' : desktopHealth.wechatInstalled ? 'degraded' : 'not_configured',
            message: desktopHealth.message,
            details: {
              version: desktopHealth.version,
              wechatInstalled: desktopHealth.wechatInstalled,
              wechatVersion: desktopHealth.wechatVersion,
              uiaAvailable: desktopHealth.uiaAvailable,
              allowPublish: desktopHealth.allowPublish,
              mode: desktopHealth.mode,
            },
          };
    const counts = this.deps.store.countTasksByState();
    counts.assets = this.deps.store.countAssets();
    const images: AdapterHealth = {
      status: imageCaps.length === 0 ? 'unavailable' : 'degraded',
      message:
        imageCaps.length === 0
          ? '没有可用的图像 Provider'
          : `可用 Provider：${imageCaps.filter((item) => item.available).map((item) => item.provider).join(', ') || '无（都需用户操作或未授权）'}`,
      details: { capabilities: imageCaps },
    };
    const okStatus =
      !this.control.killSwitch &&
      (llmHealth.status === 'ok' || llmHealth.status === 'degraded') &&
      images.status !== 'unavailable';
    return {
      ok: okStatus,
      plugin: 'dsh-moments-agent',
      version: this.deps.version,
      dshVersion: this.deps.dshVersion ?? null,
      database: 'ok',
      killSwitch: this.control.killSwitch,
      paused: this.control.paused,
      publishMode: this.deps.config.publishMode,
      scheduleEnabled: this.scheduleView().scheduleEnabled,
      wechatAgent: wechatHealth,
      desktopExecutor: desktop,
      llm: llmHealth,
      images,
      counts,
      checkedAt: this.iso(),
    };
  }

  async status(taskId?: string): Promise<RuntimeStatus> {
    const task = taskId === undefined ? null : this.deps.store.requireTask(taskId);
    return {
      control: {
        killSwitch: this.control.killSwitch,
        paused: this.control.paused,
        pauseReason: this.control.pauseReason,
        publishMode: this.deps.config.publishMode,
        effectivePublishMode: effectivePublishMode(this.deps.config, this.env),
        scheduleEnabled: this.scheduleView().scheduleEnabled,
        ownerChannel: this.deps.ownerChannel.name,
      },
      accountId: await this.resolveAccountId(),
      task,
      attempts: task === null ? [] : this.deps.store.listAttemptsForTask(task.taskId),
      approvals: task === null ? [] : this.deps.store.listApprovalsForTask(task.taskId),
      imageTasks: task === null ? [] : this.deps.store.listImageTasksByTask(task.taskId),
      openTasks: this.deps.store.listOpenTasks(20),
      pendingApprovals: this.deps.store.listPendingApprovals(20),
      counts: this.deps.store.countTasksByState(),
    };
  }

  getConfig(): MomentsConfig {
    return { ...this.deps.config, ...this.scheduleView() };
  }

  getLogger(): Logger {
    return this.deps.logger;
  }

  // -------------------------------------------------------------------------
  // 选题与草稿
  // -------------------------------------------------------------------------

  private async contextFor(): Promise<DecisionContext> {
    return this.decisionContext();
  }

  /**
   * 创建候选想法。若模型判断没有值得表达的内容，返回 silent=true，而不是硬造一条。
   */
  async createIdea(input: {
    topic?: string;
    sourceType?: string;
    sourceEvidence?: string;
    motivation?: string;
  }): Promise<{ task: TaskRecord | null; idea: IdeaCandidate | null; silent: boolean; reason: string }> {
    if (this.control.killSwitch) throw new MomentsError('KILL_SWITCH_ACTIVE', '全局 Kill Switch 已启用，禁止创建新任务');
    if (this.control.paused) throw new MomentsError('PAUSED', '系统已暂停，禁止创建新任务');
    const context = await this.decisionContext();
    const canCreate = this.decision.canCreateNow(context);
    if (!canCreate.allowed) {
      return { task: null, idea: null, silent: true, reason: canCreate.reason };
    }
    const ownerTopics = input.topic === undefined ? [] : [input.topic];
    const result = await this.ideaGenerator.generate({
      ownerTopics,
      savedOpinions: this.memoryTexts(),
      recentTexts: context.recentTexts,
      count: input.topic === undefined ? 3 : 1,
    });
    if (result.candidates.length === 0) {
      this.deps.store.appendAudit({
        at: this.iso(),
        actor: 'agent',
        action: 'idea_silence',
        taskId: null,
        previousState: null,
        nextState: null,
        reason: result.silentReason ?? '没有值得表达的内容',
        metadata: {},
      });
      return { task: null, idea: null, silent: true, reason: result.silentReason ?? '没有值得表达的内容' };
    }
    let chosen: IdeaCandidate | null = null;
    let bestScore = -1;
    let rejectionReason = '';
    for (const candidate of result.candidates) {
      const evaluation = this.decision.evaluateCandidate(candidate, context);
      const score = evaluation.decision.allowed ? this.decision.computeScore(candidate.scores, evaluation.duplicateSimilarity) : -1;
      if (evaluation.decision.allowed && score > bestScore) {
        chosen = candidate;
        bestScore = score;
      } else if (!evaluation.decision.allowed) {
        rejectionReason = evaluation.decision.reason;
      }
    }
    if (chosen === null) {
      this.deps.store.appendAudit({
        at: this.iso(),
        actor: 'agent',
        action: 'idea_rejected',
        taskId: null,
        previousState: null,
        nextState: null,
        reason: rejectionReason || '候选想法未通过决策规则',
        metadata: { candidates: result.candidates.map((candidate) => candidate.topic) },
      });
      return { task: null, idea: null, silent: true, reason: rejectionReason || '候选想法未通过决策规则' };
    }
    this.assertActive();
    const taskId = newId('task');
    const task = this.deps.store.runInTransaction(() => {
      this.deps.store.createTask(taskId, 'PUBLIC');
      const idea: IdeaCandidate = {
        ...chosen,
        sourceType: input.sourceType === undefined ? chosen.sourceType : assertKnownSourceType(input.sourceType),
        sourceEvidence: input.sourceEvidence ?? chosen.sourceEvidence,
        motivation: input.motivation ?? chosen.motivation,
      };
      this.deps.store.insertIdea({
        ideaId: idea.ideaId,
        taskId,
        topic: idea.topic,
        motivation: idea.motivation,
        sourceType: idea.sourceType,
        sourceEvidence: idea.sourceEvidence,
        noveltyScore: idea.scores.novelty,
        personaScore: idea.scores.persona,
        relevanceScore: idea.scores.relevance,
        riskFlags: idea.riskFlags,
        createdAt: idea.createdAt,
      });
      this.deps.store.updateTaskFields(taskId, { ideaId: idea.ideaId });
      this.deps.store.appendAudit({
        at: this.iso(),
        actor: 'agent',
        action: 'idea_created',
        taskId,
        previousState: null,
        nextState: 'IDEA_CREATED',
        reason: '候选想法通过决策规则',
        metadata: { topic: idea.topic, score: bestScore },
      });
      return this.deps.store.requireTask(taskId);
    });
    return { task, idea: chosen, silent: false, reason: '已创建候选想法' };
  }

  async composeDraft(taskId: string, options: { tone?: string; feedback?: string } = {}): Promise<{
    task: TaskRecord;
    draftText: string;
    review: Awaited<ReturnType<ContentReviewer['review']>>;
  }> {
    this.assertActive();
    if (this.composingTasks.has(taskId)) throw new MomentsError('CONFLICT', '该任务正在创作');
    this.composingTasks.add(taskId);
    try {
      return await this.composeDraftInner(taskId, options);
    } finally {
      this.composingTasks.delete(taskId);
    }
  }

  private async composeDraftInner(taskId: string, options: { tone?: string; feedback?: string }): Promise<{
    task: TaskRecord;
    draftText: string;
    review: Awaited<ReturnType<ContentReviewer['review']>>;
  }> {
    const task = this.deps.store.requireTask(taskId);
    if (!['IDEA_CREATED', 'DRAFTING', 'DRAFT_READY', 'IMAGE_READY', 'READY_FOR_APPROVAL', 'APPROVED'].includes(task.state)) {
      throw new MomentsError('CONFLICT', `任务状态 ${task.state} 不允许创作草稿`);
    }
    const ideaRecord = this.deps.store.getIdeaByTask(taskId);
    if (ideaRecord === undefined) throw new MomentsError('NOT_FOUND', '任务没有候选想法');
    const idea: IdeaCandidate = {
      ideaId: ideaRecord.ideaId,
      topic: ideaRecord.topic,
      motivation: ideaRecord.motivation,
      sourceType: ideaRecord.sourceType,
      sourceEvidence: ideaRecord.sourceEvidence,
      scores: {
        novelty: ideaRecord.noveltyScore,
        persona: ideaRecord.personaScore,
        relevance: ideaRecord.relevanceScore,
        expressionValue: 0.6,
        emotionalValue: 0.5,
        timeliness: 0.4,
        duplicatePenalty: 0,
      },
      riskFlags: ideaRecord.riskFlags,
      createdAt: ideaRecord.createdAt,
    };
    const previousDraft = this.deps.store.getCurrentDraftForTask(taskId);
    if (task.state !== 'DRAFTING') {
      this.deps.store.runInTransaction(() => {
        for (const approval of this.deps.store.listApprovalsForTask(taskId)) {
          this.deps.store.decideApproval(approval.approvalId, 'superseded', ['pending', 'approved'], this.iso());
        }
        this.deps.store.transitionTask(taskId, {
        nextState: 'DRAFTING',
        actor: 'agent',
        reason: '开始创作草稿',
        metadata: {},
        patch: { approvalId: null, contentHash: null, assetManifestHash: null },
        });
      });
    }
    const context = await this.contextFor();
    const composed = await this.composer.compose({
      idea,
      tone: options.tone,
      recentTexts: context.recentTexts,
      feedback: options.feedback,
      memories: this.memoryTexts(),
    });
    this.assertActive();
    if (this.deps.store.requireTask(taskId).state !== 'DRAFTING') {
      throw new MomentsError('CONFLICT', '创作期间任务状态已变化');
    }
    const draftHash = computeContentHash({ text: composed.text, assetHashes: [], visibility: task.visibility, accountId: '' });
    const draft = previousDraft
      ? this.deps.store.updateDraftText(previousDraft.draftId, composed.text, draftHash, composed.tone)
      : this.deps.store.createDraft(
      {
        draftId: newId('draft'),
        taskId,
        ideaId: idea.ideaId,
        version: 1,
        text: composed.text,
        tone: composed.tone,
        createdAt: this.iso(),
        updatedAt: this.iso(),
      },
      draftHash,
    );
    const updated = this.deps.store.transitionTask(taskId, {
      nextState: 'DRAFT_READY',
      actor: 'agent',
      reason: '草稿创作完成',
      metadata: { draftId: draft.draftId, tone: composed.tone },
      patch: { draftId: draft.draftId },
    });
    const review = await this.reviewer.review({ text: composed.text, idea, context });
    return { task: updated.task, draftText: composed.text, review };
  }

  async reviewDraft(taskId: string): Promise<{
    task: TaskRecord;
    passed: boolean;
    notes: readonly string[];
    flags: readonly string[];
  }> {
    this.assertActive();
    const task = this.deps.store.requireTask(taskId);
    if (!['DRAFT_READY', 'IMAGE_READY', 'REVIEWING'].includes(task.state)) {
      throw new MomentsError('CONFLICT', `任务状态 ${task.state} 不允许审核`);
    }
    const draft = this.deps.store.requireCurrentDraft(taskId);
    const ideaRecord = this.deps.store.getIdeaByTask(taskId);
    if (ideaRecord === undefined) throw new MomentsError('NOT_FOUND', '任务没有候选想法');
    const idea: IdeaCandidate = {
      ideaId: ideaRecord.ideaId,
      topic: ideaRecord.topic,
      motivation: ideaRecord.motivation,
      sourceType: ideaRecord.sourceType,
      sourceEvidence: ideaRecord.sourceEvidence,
      scores: {
        novelty: ideaRecord.noveltyScore,
        persona: ideaRecord.personaScore,
        relevance: ideaRecord.relevanceScore,
        expressionValue: 0.6,
        emotionalValue: 0.5,
        timeliness: 0.4,
        duplicatePenalty: 0,
      },
      riskFlags: ideaRecord.riskFlags,
      createdAt: ideaRecord.createdAt,
    };
    if (task.state !== 'REVIEWING') {
      this.deps.store.transitionTask(taskId, {
        nextState: 'REVIEWING',
        actor: 'agent',
        reason: '开始审核草稿',
        metadata: { draftId: draft.draftId },
      });
    }
    const context = await this.contextFor();
    const review = await this.reviewer.review({ text: draft.text, idea, context });
    this.assertActive();
    if (this.deps.store.requireTask(taskId).state !== 'REVIEWING') {
      throw new MomentsError('CONFLICT', '审核期间任务状态已变化');
    }
    const assets = this.deps.store.listTaskAssets(taskId);
    const accountId = (await this.resolveAccountId()) ?? '';
    this.assertActive();
    const contentHash = computeContentHash({
      text: draft.text,
      assetHashes: assets.map((asset) => asset.sha256),
      visibility: task.visibility,
      accountId,
    });
    const assetManifestHash = computeAssetManifestHash(assets.map((asset) => asset.sha256));
    this.deps.store.appendAudit({
      at: this.iso(),
      actor: 'agent',
      action: 'draft_reviewed',
      taskId,
      previousState: 'REVIEWING',
      nextState: review.passed ? 'READY_FOR_APPROVAL' : 'DRAFTING',
      reason: review.passed ? '审核通过' : '审核未通过',
      metadata: {
        flags: review.flags,
        llmReviewed: review.llmReviewed,
        notes: review.notes,
        contentHash,
      },
    });
    if (!review.passed) {
      this.deps.store.transitionTask(taskId, {
        nextState: 'DRAFTING',
        actor: 'agent',
        reason: `审核未通过：${review.notes[0] ?? ''}`,
        metadata: { flags: review.flags },
      });
      return { task: this.deps.store.requireTask(taskId), passed: false, notes: review.notes, flags: review.flags };
    }
    const updated = this.deps.store.transitionTask(taskId, {
      nextState: 'READY_FOR_APPROVAL',
      actor: 'agent',
      reason: '审核通过，等待所有者审批',
      metadata: { flags: review.flags, llmReviewed: review.llmReviewed },
      patch: {
        contentHash,
        assetManifestHash,
        accountId: accountId === '' ? null : accountId,
      },
    });
    return { task: updated.task, passed: true, notes: review.notes, flags: review.flags };
  }

  // -------------------------------------------------------------------------
  // 图片
  // -------------------------------------------------------------------------

  private async ensureImageState(task: TaskRecord, target: 'IMAGE_PENDING' | 'IMAGE_READY'): Promise<TaskRecord> {
    let current = task;
    if (current.state === 'DRAFT_READY' || (current.state === 'IMAGE_READY' && target === 'IMAGE_PENDING')) {
      current = this.deps.store.transitionTask(current.taskId, {
        nextState: 'IMAGE_REQUIRED',
        actor: 'agent',
        reason: '需要图片素材',
        metadata: {},
      }).task;
    }
    if (current.state === 'IMAGE_REQUIRED' && target === 'IMAGE_PENDING') {
      current = this.deps.store.transitionTask(current.taskId, {
        nextState: 'IMAGE_PENDING',
        actor: 'agent',
        reason: '图片任务等待用户操作',
        metadata: {},
      }).task;
    }
    if ((current.state === 'IMAGE_REQUIRED' || current.state === 'IMAGE_PENDING') && target === 'IMAGE_READY') {
      current = this.deps.store.transitionTask(current.taskId, {
        nextState: 'IMAGE_READY',
        actor: 'agent',
        reason: '图片素材已就绪',
        metadata: {},
      }).task;
    }
    return current;
  }

  async generateImageTask(input: {
    taskId: string;
    operation?: 'generate' | 'edit';
    referenceAssetIds?: readonly string[];
    prompt?: string;
    aspectRatio?: string;
    styleProfile?: string;
    provider?: string;
  }): Promise<{
    task: TaskRecord;
    imageTask: ImageTaskRecord;
    assets: readonly MediaAssetRecord[];
    requiresUserAction: boolean;
    message: string;
    errorCode: string | null;
  }> {
    const task = this.deps.store.requireTask(input.taskId);
    if (!['DRAFT_READY', 'IMAGE_REQUIRED', 'IMAGE_PENDING', 'IMAGE_READY'].includes(task.state)) {
      throw new MomentsError('CONFLICT', `任务状态 ${task.state} 不允许生成图片`);
    }
    const draft = this.deps.store.requireCurrentDraft(task.taskId);
    const references = input.referenceAssetIds ?? [];
    if (input.operation !== undefined && !['generate', 'edit'].includes(input.operation)) throw new MomentsError('INVALID_INPUT', '未知图片操作');
    if (references.length > 9 || (input.operation === 'edit' && references.length === 0)) throw new MomentsError('INVALID_INPUT', '编辑需要 1 至 9 个参考素材');
    for (const assetId of references) this.deps.store.requireAsset(assetId);
    const aspectRatio = input.aspectRatio ?? '1:1';
    if (!this.deps.config.images.allowedAspectRatios.includes(aspectRatio)) {
      throw new MomentsError('INVALID_INPUT', `不支持的图片比例：${aspectRatio}`);
    }
    let prompt = input.prompt?.trim() ?? '';
    if (prompt === '') prompt = await this.buildImagePrompt(draft.text, input.styleProfile);
    this.assertActive();
    if (input.operation === 'edit') prompt = `编辑参考素材 ${references.join(', ')}，保持人物身份特征。\n${prompt}`;
    if (prompt.length > 2000) throw new MomentsError('INVALID_INPUT', '图片提示词过长（最多 2000 字符）');
    const providerName = input.provider ?? this.deps.config.images.providers[0] ?? 'manual-subscription';
    const provider = PROVIDER_NAME_TO_KIND[providerName] ??
      (Object.hasOwn(PROVIDER_KIND_TO_NAME, providerName) ? providerName as ImageTaskRecord['provider'] : null);
    if (provider === null) throw new MomentsError('INVALID_INPUT', '未知的图片 Provider');
    const now = this.now();
    const imageTask: ImageTaskRecord = {
      imageTaskId: newId('imgtask'),
      draftId: draft.draftId,
      taskId: task.taskId,
      prompt,
      negativePrompt: '',
      aspectRatio,
      resolution: '1024x1024',
      styleProfile: input.styleProfile ?? '',
      provider,
      status: 'PENDING',
      requiresUserAction: false,
      attempts: 1,
      lastError: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
    };
    this.deps.store.insertImageTask(imageTask);
    let current = await this.ensureImageState(task, 'IMAGE_PENDING');
    const generation = await this.deps.image.generate({
      operation: input.operation,
      taskId: imageTask.imageTaskId,
      prompt,
      negativePrompt: '',
      aspectRatio,
      resolution: imageTask.resolution,
      referenceImages: references,
      styleProfile: imageTask.styleProfile,
      privacyLevel: 'private',
      targetProvider: provider,
      maxAttempts: 2,
      signal: this.abort.signal,
    });
    this.assertActive();
    if (generation.result.status === 'awaiting_user' || generation.result.requiresUserAction) {
      this.deps.store.updateImageTask(imageTask.imageTaskId, {
        status: 'AWAITING_USER',
        requiresUserAction: true,
        lastError: null,
        updatedAt: this.iso(),
      });
      await mkdir(resolveInsideRoot(this.deps.dataDir, path.join('imports', imageTask.imageTaskId)), { recursive: true });
      await this.deps.ownerChannel.sendText([
        '【朋友圈配图任务】', `任务：${imageTask.imageTaskId}`, `正文任务：${task.taskId}`,
        prompt, input.operation === 'edit' ? `编辑参考素材：${references.join(', ')}；保持人物身份特征。请在客户端手动选择这些素材。` : '请在已授权的图像客户端生图，再显式指定该图片任务 ID 导入。不会关联任意最近图片。',
        `本地导入目录：imports/${imageTask.imageTaskId}/`,
      ].join('\n')).catch((error: unknown) => {
        this.deps.logger.warn('配图通知发送失败', { error: redactSecrets(String(error)) });
      });
      return {
        task: current,
        imageTask: this.deps.store.requireImageTask(imageTask.imageTaskId),
        assets: [],
        requiresUserAction: true,
        message: generation.result.message,
        errorCode: null,
      };
    }
    if (generation.result.status !== 'ready' || generation.assets.length === 0) {
      this.deps.store.updateImageTask(imageTask.imageTaskId, {
        status: generation.result.status === 'cancelled' ? 'CANCELLED' : 'FAILED',
        lastError: generation.result.errorCode ?? generation.result.message,
        updatedAt: this.iso(),
      });
      try {
        this.deps.store.transitionTask(task.taskId, {
          nextState: 'FAILED',
          actor: 'agent',
          reason: generation.result.message,
          metadata: { imageTaskId: imageTask.imageTaskId, errorCode: generation.result.errorCode },
          patch: { errorCode: generation.result.errorCode, errorMessage: generation.result.message },
        });
      } catch {
        // 保持原状态
      }
      return {
        task: this.deps.store.requireTask(task.taskId),
        imageTask: this.deps.store.requireImageTask(imageTask.imageTaskId),
        assets: [],
        requiresUserAction: false,
        message: generation.result.message,
        errorCode: generation.result.errorCode,
      };
    }
    const reviewed: MediaAssetRecord[] = [];
    for (const asset of generation.assets) {
      const review = await this.deps.image.reviewAsset(asset.assetId, { text: draft.text });
      if (review.passed) reviewed.push(asset);
    }
    if (reviewed.length === 0) {
      this.deps.store.updateImageTask(imageTask.imageTaskId, {
        status: 'REVIEWING',
        lastError: 'IMAGE_REVIEW_FAILED',
        updatedAt: this.iso(),
      });
      return {
        task: current,
        imageTask: this.deps.store.requireImageTask(imageTask.imageTaskId),
        assets: [],
        requiresUserAction: false,
        message: '图片审核未通过，未加入朋友圈素材',
        errorCode: 'IMAGE_REVIEW_FAILED',
      };
    }
    this.deps.store.replaceTaskAssets(task.taskId, reviewed.map((asset) => asset.assetId));
    this.deps.store.updateImageTask(imageTask.imageTaskId, { status: 'READY', updatedAt: this.iso() });
    current = await this.ensureImageState(this.deps.store.requireTask(task.taskId), 'IMAGE_READY');
    return {
      task: current,
      imageTask: this.deps.store.requireImageTask(imageTask.imageTaskId),
      assets: reviewed,
      requiresUserAction: false,
      message: generation.result.message,
      errorCode: null,
    };
  }

  private async buildImagePrompt(draftText: string, styleProfile?: string): Promise<string> {
    const persona = this.persona();
    try {
      const response = await this.deps.llm.complete({
        system: [
          persona.visualStyle,
          '你是朋友圈配图提示词作者。只输出 JSON：{"prompt":"英文或中文提示词","aspectRatio":"1:1|4:3|3:4|16:9|9:16"}。',
          '禁止生成真实新闻现场、真实人物肖像或误导性对比图；不要求每条都配图。',
        ].join('\n'),
        messages: [
          {
            role: 'user',
            content: `为这段朋友圈正文设计一张配图提示词：\n${draftText.slice(0, 800)}\n风格偏好：${styleProfile ?? '自然、低饱和、留白'}`,
          },
        ],
        temperature: 0.7,
        purpose: 'image-prompt',
      });
      const parsed = extractJsonObject<{ prompt?: unknown }>(response.text);
      if (typeof parsed.prompt === 'string' && parsed.prompt.trim() !== '') return parsed.prompt.trim().slice(0, 2000);
    } catch (error) {
      this.deps.logger.warn('配图提示词生成失败，使用文案摘要作为提示词', {
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
    return `为一条个人朋友圈配图，主题与下列文字相关，自然光、低饱和、留白、真实质感，不出现真实人物肖像：${draftText.slice(0, 300)}`;
  }

  async importImage(input: {
    taskId?: string;
    imageTaskId?: string;
    path?: string;
    base64?: string;
    mime?: string;
    license?: string;
    source?: MediaAssetRecord['source'];
  }): Promise<{ task: TaskRecord | null; asset: MediaAssetRecord; duplicate: boolean; review: Awaited<ReturnType<ImageFacade['reviewAsset']>> }> {
    if (input.path === undefined && input.base64 === undefined) {
      throw new MomentsError('INVALID_INPUT', '必须提供图片路径或 base64 数据');
    }
    let task: TaskRecord | null = null;
    let imageTask: ImageTaskRecord | null = null;
    if (input.taskId !== undefined) {
      task = this.deps.store.requireTask(input.taskId);
      if (['PUBLISHED', 'CANCELLED', 'FAILED', 'EXPIRED'].includes(task.state)) {
        throw new MomentsError('CONFLICT', `任务状态 ${task.state} 不允许导入图片`);
      }
    }
    if (input.imageTaskId !== undefined) {
      imageTask = this.deps.store.requireImageTask(input.imageTaskId);
      if (task !== null && imageTask.taskId !== task.taskId) {
        throw new MomentsError('IMAGE_TASK_NOT_FOUND', '图片任务与目标任务不匹配');
      }
      if (imageTask.status === 'EXPIRED' || new Date(imageTask.expiresAt).getTime() <= this.now().getTime()) {
        throw new MomentsError('IMAGE_TASK_EXPIRED', '图片任务已过期');
      }
      task ??= this.deps.store.requireTask(imageTask.taskId);
    }
    if (task !== null && !['DRAFT_READY', 'IMAGE_REQUIRED', 'IMAGE_PENDING', 'IMAGE_READY'].includes(task.state)) {
      throw new MomentsError('CONFLICT', '仅未审批的草稿可导入图片，请重新创建草稿后审批');
    }
    const license = input.license ?? 'owner-authorized';
    let imported;
    if (input.base64 !== undefined) {
      const bytes = Buffer.from(input.base64, 'base64');
      if (bytes.length === 0) throw new MomentsError('IMAGE_INVALID', 'base64 图片数据为空');
      imported = await this.deps.image.importBytes({
        bytes,
        declaredMime: input.mime ?? 'image/png',
        source: input.source ?? 'owner_upload',
        license,
        prompt: '',
        provider: 'local-import',
        model: '',
        imageTaskId: imageTask?.imageTaskId ?? null,
        originalFileName: 'import.png',
      });
    } else {
      imported = await this.deps.image.importFromPath({
        path: input.path as string,
        source: input.source ?? 'owner_upload',
        license,
        prompt: '',
        provider: 'local-import',
        model: '',
        imageTaskId: imageTask?.imageTaskId ?? null,
      });
    }
    const review = await this.deps.image.reviewAsset(imported.asset.assetId, {
      text: task === null ? undefined : this.deps.store.requireCurrentDraft(task.taskId).text,
      declaredMime: input.mime,
    });
    if (task !== null) {
      this.assertActive();
      task = this.deps.store.requireTask(task.taskId);
      if (!['DRAFT_READY', 'IMAGE_REQUIRED', 'IMAGE_PENDING', 'IMAGE_READY'].includes(task.state)) {
        throw new MomentsError('CONFLICT', '图片审核期间任务已取消或进入审批，拒绝关联');
      }
      if (!review.passed) {
        throw new MomentsError('IMAGE_REVIEW_FAILED', `图片未通过审核：${review.notes.join('；') || '未知原因'}`, {
          details: { flags: review.flags, assetId: imported.asset.assetId },
        });
      }
      const existing = this.deps.store.listTaskAssets(task.taskId);
      if (existing.length >= this.deps.config.policy.maxImages) {
        throw new MomentsError('INVALID_INPUT', `图片数量超过上限 ${this.deps.config.policy.maxImages}`);
      }
      this.deps.store.replaceTaskAssets(task.taskId, [...new Set([...existing.map((asset) => asset.assetId), imported.asset.assetId])]);
      if (task.state === 'DRAFT_READY') {
        this.deps.store.transitionTask(task.taskId, {
          nextState: 'IMAGE_REQUIRED',
          actor: 'agent',
          reason: '导入图片素材',
          metadata: { assetId: imported.asset.assetId },
        });
      }
      if (['IMAGE_REQUIRED', 'IMAGE_PENDING'].includes(this.deps.store.requireTask(task.taskId).state)) {
        task = await this.ensureImageState(this.deps.store.requireTask(task.taskId), 'IMAGE_READY');
      } else {
        task = this.deps.store.requireTask(task.taskId);
      }
      if (imageTask !== null) {
        this.deps.store.updateImageTask(imageTask.imageTaskId, { status: 'READY', updatedAt: this.iso() });
      }
    }
    return { task, asset: imported.asset, duplicate: imported.duplicate, review };
  }

  async selectImages(taskId: string, assetIds: readonly string[]): Promise<{ task: TaskRecord; assets: readonly MediaAssetRecord[] }> {
    const task = this.deps.store.requireTask(taskId);
    if (!['DRAFT_READY', 'IMAGE_REQUIRED', 'IMAGE_PENDING', 'IMAGE_READY'].includes(task.state)) {
      throw new MomentsError('CONFLICT', `任务状态 ${task.state} 不允许选择图片`);
    }
    if (assetIds.length > this.deps.config.policy.maxImages) {
      throw new MomentsError('INVALID_INPUT', `图片数量超过上限 ${this.deps.config.policy.maxImages}`);
    }
    const assets: MediaAssetRecord[] = [];
    for (const assetId of assetIds) {
      const asset = this.deps.store.requireAsset(assetId);
      const review = this.deps.store.getImageReview(assetId);
      if (review === undefined || !review.passed) {
        throw new MomentsError('IMAGE_REVIEW_FAILED', `图片 ${assetId} 尚未通过审核，不能加入朋友圈`);
      }
      assets.push(asset);
    }
    this.deps.store.replaceTaskAssets(taskId, assetIds);
    let current = task;
    if (current.state === 'DRAFT_READY') {
      current = this.deps.store.transitionTask(taskId, {
        nextState: 'IMAGE_REQUIRED',
        actor: 'agent',
        reason: '选择图片素材',
        metadata: {},
      }).task;
    }
    if (['IMAGE_REQUIRED', 'IMAGE_PENDING'].includes(current.state)) {
      current = this.deps.store.transitionTask(taskId, {
        nextState: 'IMAGE_READY',
        actor: 'agent',
        reason: '图片素材已选定',
        metadata: { count: assetIds.length },
      }).task;
    }
    return { task: current, assets };
  }

  // -------------------------------------------------------------------------
  // 预览与审批
  // -------------------------------------------------------------------------

  async preview(taskId: string): Promise<PreviewPackage & { assetsCount: number }> {
    const preview = this.deps.store.buildPreview(taskId);
    return { ...preview, assetsCount: preview.assets.length };
  }

  async requestApproval(taskId: string): Promise<{
    approval: ReturnType<MomentsStore['requireApproval']>;
    request: ApprovalRequestView;
    delivered: boolean;
  }> {
    const task = this.deps.store.requireTask(taskId);
    if (task.state !== 'READY_FOR_APPROVAL') {
      throw new MomentsError('CONFLICT', `任务状态 ${task.state} 不允许申请审批`, {
        details: { taskId, state: task.state },
      });
    }
    const channel = this.deps.ownerChannel;
    const result = await this.approvalService.createForTask({
      taskId,
      channel,
      approvalChannel: channel.name === 'wechat_owner' ? 'wechat_owner' : channel.name === 'composite' ? 'wechat_owner' : 'manual_admin',
    });
    return {
      approval: result.approval,
      request: result.request,
      delivered: result.delivered,
    };
  }

  decideApproval(
    approvalId: string,
    action: 'approve' | 'reject',
    actor: 'wechat_owner' | 'manual_admin',
    reason?: string,
  ): ReturnType<ApprovalService['decide']> {
    const approval = this.deps.store.requireApproval(approvalId);
    this.approvalService.validateOwner(approval, actor, this.approvalService.ownerId());
    const result = this.approvalService.decide({ approvalId, action, actor, reason });
    this.deps.store.upsertMemory('episodic', `approval:${approvalId}`,
      JSON.stringify({ taskId: approval.taskId, action, feedback: redactSecrets(reason ?? '').slice(0, 500) }));
    return result;
  }

  // -------------------------------------------------------------------------
  // 发布
  // -------------------------------------------------------------------------

  async prepareDesktop(taskId: string): Promise<ReturnType<Publisher['prepare']>> {
    return this.publisher.prepare(taskId, 'agent');
  }

  async publish(taskId: string, approvalId?: string): Promise<ReturnType<Publisher['publish']>> {
    return this.publisher.publish(taskId, approvalId ?? null, 'owner');
  }

  async verify(attemptId: string): Promise<ReturnType<Publisher['verify']>> {
    return this.publisher.verify(attemptId);
  }

  resolveUncertain(attemptId: string, resolution: 'PUBLISHED' | 'FAILED', note: string): ReturnType<Publisher['resolveUncertain']> {
    return this.publisher.resolveUncertain(attemptId, resolution, 'owner', note);
  }

  async cancelTask(taskId: string, reason: string, actor: 'owner' | 'agent' | 'system' = 'agent'): Promise<TaskRecord> {
    this.deps.store.supersedePendingApprovals(taskId, this.iso());
    return this.publisher.cancelTask(taskId, actor, reason);
  }

  async history(limit = 20): Promise<{ published: ReturnType<MomentsStore['listPublished']>; ideas: ReturnType<MomentsStore['listIdeas']> }> {
    return {
      published: this.deps.store.listPublished(limit),
      ideas: this.deps.store.listIdeas(limit),
    };
  }

  /** 管理客户端使用：任务列表摘要（含最新草稿、审批与尝试）。 */
  async listTaskSummaries(limit = 100): Promise<unknown[]> {
    const tasks = this.deps.store.listTasks(undefined, limit);
    return tasks.map((task) => this.taskSummary(task));
  }

  private taskSummary(task: TaskRecord): Record<string, unknown> {
    const idea = this.deps.store.getIdeaByTask(task.taskId) ?? null;
    const draft = this.deps.store.getCurrentDraftForTask(task.taskId) ?? null;
    const assets = this.deps.store.listTaskAssets(task.taskId);
    const approvals = this.deps.store.listApprovalsForTask(task.taskId);
    const attempts = this.deps.store.listAttemptsForTask(task.taskId);
    return {
      task,
      idea,
      draft,
      assets: assets.map((asset) => ({
        assetId: asset.assetId,
        sha256: asset.sha256,
        mime: asset.mime,
        width: asset.width,
        height: asset.height,
        source: asset.source,
        license: asset.license,
      })),
      approval: approvals[0] ?? null,
      approvals,
      attempts,
      attempt: attempts[attempts.length - 1] ?? null,
    };
  }

  /** 管理客户端使用：任务详情（含图片任务、草稿版本与审计）。 */
  async taskDetail(taskId: string): Promise<Record<string, unknown>> {
    const task = this.deps.store.requireTask(taskId);
    const summary = this.taskSummary(task);
    let preview: unknown = null;
    try {
      preview = this.deps.store.buildPreview(taskId);
    } catch {
      preview = null;
    }
    return {
      ...summary,
      preview,
      imageTasks: this.deps.store.listImageTasksByTask(taskId),
      draftVersions: summary.draft === null ? [] : this.deps.store.listDraftVersions((summary.draft as { draftId: string }).draftId),
      audit: this.deps.store.listAudit({ taskId, limit: 100 }),
    };
  }

  /**
   * 客户端“一键创作”：选题 -> 文案 -> 审核 -> 申请审批。
   * 只创建候选内容，绝不准备/发表。可能产生一次真实模型调用。
   */
  async generateDraftWorkflow(input: {
    topic?: string;
    sourceType?: string;
    sourceEvidence?: string;
    motivation?: string;
    imagePrompt?: string;
  }): Promise<Record<string, unknown>> {
    const created = await this.createIdea(input);
    if (created.silent || created.task === null) {
      return { silent: true, reason: created.reason, taskId: null };
    }
    const taskId = created.task.taskId;
    await this.composeDraft(taskId);
    if (input.imagePrompt?.trim()) {
      const image = await this.generateImageTask({ taskId, prompt: input.imagePrompt.trim() });
      if (image.requiresUserAction || image.errorCode) {
        return { silent: false, taskId, imagePending: image.requiresUserAction, image,
          detail: await this.taskDetail(taskId) };
      }
    }
    const review = await this.reviewDraft(taskId);
    let approval: Awaited<ReturnType<MomentsRuntime['requestApproval']>> | null = null;
    if (review.passed) approval = await this.requestApproval(taskId);
    return {
      silent: false,
      taskId,
      review,
      approval,
      detail: await this.taskDetail(taskId),
    };
  }

  async composeAndReview(taskId: string, options: { tone?: string; feedback?: string } = {}): Promise<Record<string, unknown>> {
    const composed = await this.composeDraft(taskId, options);
    const review = await this.reviewDraft(taskId);
    let approval: Awaited<ReturnType<MomentsRuntime['requestApproval']>> | null = null;
    if (review.passed) approval = await this.requestApproval(taskId);
    return { composed, review, approval, detail: await this.taskDetail(taskId) };
  }

  /** 客户端：只审核（不重写）当前草稿。 */
  async reviewTask(taskId: string): Promise<Record<string, unknown>> {
    const review = await this.reviewDraft(taskId);
    let approval: Awaited<ReturnType<MomentsRuntime['requestApproval']>> | null = null;
    if (review.passed) approval = await this.requestApproval(taskId);
    return { review, approval, detail: await this.taskDetail(taskId) };
  }

  /** 读取媒体素材原始字节（仅供本机管理客户端，需管理令牌）。 */
  async assetBytes(assetId: string): Promise<{ bytes: Uint8Array; mime: string; asset: MediaAssetRecord }> {
    const asset = this.deps.store.requireAsset(assetId);
    const file = resolveInsideRoot(this.deps.dataDir, asset.path, '素材文件');
    const bytes = await readFile(file);
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (hash !== asset.sha256) {
      throw new MomentsError('IMAGE_INVALID', '素材文件内容与数据库 SHA-256 不一致，已拒绝读取', {
        details: { assetId },
      });
    }
    return { bytes, mime: asset.mime, asset };
  }

  personaView(): { soul: string; visualStyle: string; source: string; loadedAt: string } {
    const persona = this.persona();
    return { soul: persona.soul, visualStyle: persona.visualStyle, source: persona.source, loadedAt: persona.loadedAt };
  }

  controlAction(action: 'pause' | 'resume' | 'kill' | 'unkill', reason: string, actor = 'owner'): void {
    if (action === 'pause') this.control.setPaused(true, actor, reason);
    else if (action === 'resume') this.control.setPaused(false, actor, reason);
    else if (action === 'kill') this.control.setKillSwitch(true, actor, reason);
    else this.control.setKillSwitch(false, actor, reason);
  }

  // -------------------------------------------------------------------------
  // 自主创作循环（不自动发表）
  // -------------------------------------------------------------------------

  async autonomousCycle(): Promise<{ created: boolean; reason: string; taskId?: string }> {
    if (this.autonomousRunning) return { created: false, reason: '自主创作循环正在运行' };
    this.autonomousRunning = true;
    try { return await this.runAutonomousCycle(); }
    finally { this.autonomousRunning = false; }
  }

  private async runAutonomousCycle(): Promise<{ created: boolean; reason: string; taskId?: string }> {
    if (this.stopped) return { created: false, reason: '运行时已停止' };
    if (!this.deps.config.enabled || !this.scheduleView().scheduleEnabled) {
      return { created: false, reason: '自主调度未启用' };
    }
    if (this.control.killSwitch || this.control.paused) return { created: false, reason: '系统暂停或 Kill Switch 生效' };
    const open = this.deps.store.listOpenTasks(20);
    if (open.length > 0) {
      return { created: false, reason: `仍有 ${open.length} 个未结束任务，暂不创建新内容` };
    }
    const context = await this.decisionContext();
    const canCreate = this.decision.canCreateNow(context);
    if (!canCreate.allowed) return { created: false, reason: canCreate.reason };
    this.lastAutonomousAt = this.iso();
    const generated = await this.ideaGenerator.generate({
      savedOpinions: this.memoryTexts(),
      recentTexts: context.recentTexts,
      count: 3,
    });
    if (generated.candidates.length === 0) {
      return { created: false, reason: generated.silentReason ?? '模型选择沉默' };
    }
    let chosen: IdeaCandidate | null = null;
    for (const candidate of generated.candidates) {
      const evaluation = this.decision.evaluateCandidate(candidate, context);
      if (evaluation.decision.allowed) {
        chosen = candidate;
        break;
      }
    }
    if (chosen === null) return { created: false, reason: '候选主题未通过决策规则' };
    this.assertActive();
    const taskId = newId('task');
    this.deps.store.createTask(taskId, 'PUBLIC');
    this.deps.store.insertIdea({
      ideaId: chosen.ideaId,
      taskId,
      topic: chosen.topic,
      motivation: chosen.motivation,
      sourceType: chosen.sourceType,
      sourceEvidence: chosen.sourceEvidence,
      noveltyScore: chosen.scores.novelty,
      personaScore: chosen.scores.persona,
      relevanceScore: chosen.scores.relevance,
      riskFlags: chosen.riskFlags,
      createdAt: chosen.createdAt,
    });
    this.deps.store.updateTaskFields(taskId, { ideaId: chosen.ideaId });
    try {
      await this.composeDraft(taskId);
      const reviewed = await this.reviewDraft(taskId);
      if (!reviewed.passed) {
        return { created: false, reason: `草稿审核未通过：${reviewed.notes[0] ?? ''}` };
      }
      await this.requestApproval(taskId);
      return { created: true, reason: '已创作并提交审批', taskId };
    } catch (error) {
      this.deps.store.appendAudit({
        at: this.iso(),
        actor: 'scheduler',
        action: 'autonomous_cycle_failed',
        taskId,
        previousState: null,
        nextState: null,
        reason: error instanceof Error ? error.message : 'unknown',
        metadata: {},
      });
      return { created: false, reason: error instanceof Error ? error.message : '自主创作失败' };
    }
  }

  // -------------------------------------------------------------------------
  // 微信所有者命令
  // -------------------------------------------------------------------------

  /** 处理一批消息（测试可直接调用）；返回处理摘要。 */
  async processOwnerMessages(messages: readonly OwnerMessage[]): Promise<{ handled: number; ignored: number }> {
    if (this.commandRunning) return { handled: 0, ignored: messages.length };
    this.commandRunning = true;
    try { return await this.runOwnerMessages(messages); }
    finally { this.commandRunning = false; }
  }

  private async runOwnerMessages(messages: readonly OwnerMessage[]): Promise<{ handled: number; ignored: number }> {
    const sorted = [...messages].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
    let handled = 0;
    let ignored = 0;
    const expectedAccount = await this.resolveAccountId();
    // 暂停/恢复优先于其他命令。
    for (const message of sorted) {
      const parsed = parseOwnerCommand(message.text);
      if (parsed === null || (parsed.command !== 'pause' && parsed.command !== 'resume')) continue;
      const key = `${message.messageId}:${message.receivedAt}`;
      if (this.seenCommandIds.has(key)) continue;
      try {
        assertOwnerIdentity(message, { ownerWxid: this.deps.config.wechatAgent.ownerWxid, accountId: expectedAccount }, this.deps.logger);
        if (!this.deps.store.claimOwnerCommand(createHash('sha256').update(`${message.accountId}:${key}`).digest('hex'))) continue;
        this.controlAction(parsed.command === 'pause' ? 'pause' : 'resume', '所有者微信命令');
        this.seenCommandIds.add(key);
        handled += 1;
      } catch {
        ignored += 1;
      }
    }
    for (const message of sorted) {
      const key = `${message.messageId}:${message.receivedAt}`;
      if (this.seenCommandIds.has(key)) continue;
      const parsed = parseOwnerCommand(message.text);
      if (parsed === null) {
        ignored += 1;
        continue;
      }
      if (parsed.command === 'pause' || parsed.command === 'resume') {
        // 已由第一轮优先处理；此处不重复执行，避免身份校验失败后二次尝试。
        ignored += 1;
        continue;
      }
      try {
        assertOwnerIdentity(message, { ownerWxid: this.deps.config.wechatAgent.ownerWxid, accountId: expectedAccount }, this.deps.logger);
        if (!this.deps.store.claimOwnerCommand(createHash('sha256').update(`${message.accountId}:${key}`).digest('hex'))) continue;
        await this.executeOwnerCommand(parsed.command, parsed.args);
        this.seenCommandIds.add(key);
        this.lastCommandAt = message.receivedAt;
        handled += 1;
      } catch (error) {
        this.deps.store.appendAudit({
          at: this.iso(),
          actor: 'owner',
          action: 'owner_command_failed',
          taskId: null,
          previousState: null,
          nextState: null,
          reason: `${parsed.command}: ${error instanceof Error ? error.message : 'unknown'}`,
          metadata: {},
        });
        ignored += 1;
      }
    }
    return { handled, ignored };
  }

  private async executeOwnerCommand(command: string, args: readonly string[]): Promise<void> {
    const send = async (text: string): Promise<void> => {
      try {
        await this.deps.ownerChannel.sendText(text);
      } catch (error) {
        this.deps.logger.warn('所有者命令回复发送失败', { error: error instanceof Error ? error.message : 'unknown' });
      }
    };
    switch (command) {
      case 'status': {
        const status = await this.status();
        await send(
          [
            '【Moments 状态】',
            `暂停：${status.control.paused ? '是' : '否'}；Kill Switch：${status.control.killSwitch ? '是' : '否'}`,
            `发布模式：${status.control.effectivePublishMode}`,
            `未结束任务：${status.openTasks.length}；待审批：${status.pendingApprovals.length}`,
            status.accountId === null ? '账号：未确认' : `账号：${status.accountId}`,
          ].join('\n'),
        );
        return;
      }
      case 'preview': {
        const taskId = args[0];
        if (taskId === undefined) throw new MomentsError('INVALID_INPUT', '用法：/moments preview <taskId>');
        const preview = await this.preview(taskId);
        await send(
          [
            '【朋友圈预览】',
            `任务：${preview.taskId}`,
            `状态：${preview.state}`,
            `可见：${preview.visibility}`,
            `指纹：${preview.contentHash.slice(0, 16)}…`,
            `图片：${preview.assetsCount} 张`,
            preview.warnings.length === 0 ? '' : `提示：${preview.warnings.join('；')}`,
            '',
            preview.text.slice(0, 500),
          ]
            .filter((line) => line !== '')
            .join('\n'),
        );
        return;
      }
      case 'approve':
      case 'reject': {
        const approvalId = args[0];
        if (approvalId === undefined) throw new MomentsError('INVALID_INPUT', '缺少审批 ID');
        this.decideApproval(approvalId, command === 'approve' ? 'approve' : 'reject', 'wechat_owner');
        await send(command === 'approve' ? `已批准审批 ${approvalId}。请在管理页/工具中完成准备与发表授权。` : `已拒绝审批 ${approvalId}。`);
        return;
      }
      case 'pause':
        this.controlAction('pause', '所有者微信命令');
        await send('已暂停：不会创建新的发布任务，也不会执行新的 GUI 发表。');
        return;
      case 'resume':
        this.controlAction('resume', '所有者微信命令');
        await send('已恢复。');
        return;
      case 'cancel': {
        const taskId = args[0];
        if (taskId === undefined) throw new MomentsError('INVALID_INPUT', '用法：/moments cancel <taskId>');
        await this.cancelTask(taskId, '所有者微信命令', 'owner');
        await send(`已取消任务 ${taskId}。`);
        return;
      }
      case 'history': {
        const history = await this.history(5);
        await send(
          ['【最近发布】', ...history.published.map((post) => `- ${post.publishedAt.slice(0, 10)} ${post.text.slice(0, 40)}`)].join('\n'),
        );
        return;
      }
      case 'image':
        await send('图片导入请使用 moments_import_image 工具（本地路径或 base64），或把图片放进 data/imports 后由所有者确认导入。不会自动关联最近收到的任意图片。');
        return;
      case 'draft': {
        const result = await this.generateDraftWorkflow(args.length ? { topic: args.join(' ').slice(0, 120) } : {});
        await send(result.silent ? `本次选择沉默：${String(result.reason)}` : `草稿已生成并审核，任务：${String(result.taskId)}。请查看审批预览。`);
        return;
      }
      case 'help':
      default:
        await send('可用命令：status / preview <taskId> / approve <approvalId> / reject <approvalId> / pause / resume / cancel <taskId> / history / image');
    }
  }

  /** 启动后台轮询与调度；所有 timer 由调用方提供的 disposer 回收。 */
  start(): { stop: () => void } {
    if (this.commandTimerDisposer !== null) return { stop: () => this.stop() };
    const poll = async (): Promise<void> => {
      if (this.stopped) return;
      try {
        const messages = await this.deps.ownerChannel.listOwnerMessages(MAX_COMMAND_MESSAGES_PER_POLL);
        if (messages.length > 0) await this.processOwnerMessages(messages);
      } catch (error) {
        this.deps.logger.debug('所有者命令轮询失败', { error: error instanceof Error ? error.message : 'unknown' });
      }
    };
    const schedule = async (): Promise<void> => {
      if (this.stopped) return;
      try {
        expirePendingTasks(this.deps.store, this.now());
        await this.scanImageImports();
        const settings = this.scheduleView();
        if (!settings.scheduleEnabled) return;
        const next = Number(this.deps.store.getSetting('scheduler_next_at') ?? 0);
        if (Date.now() < next) return;
        this.deps.store.setSetting('scheduler_next_at', String(Date.now() +
          settings.scheduler.tickSeconds * 1000 +
          Math.random() * settings.scheduler.jitterSeconds * 1000));
        if (Math.random() >= settings.scheduler.ideaProbability) return;
        await this.autonomousCycle();
      } catch (error) {
        this.deps.logger.warn('自主创作循环失败', { error: error instanceof Error ? error.message : 'unknown' });
      }
    };
    this.commandTimerDisposer = this.setInterval(poll, this.deps.config.wechatAgent.pollIntervalMs);
    this.scheduleTimerDisposer = this.setInterval(schedule, Math.min(10, this.deps.config.scheduler.tickSeconds) * 1000);
    return { stop: () => this.stop() };
  }

  private setInterval(callback: () => void | Promise<void>, delayMs: number): () => void {
    const handle = setInterval(() => {
      const operation = Promise.resolve().then(callback).catch((error: unknown) => {
        if (!this.stopped) this.deps.logger.warn('后台操作失败', { error: redactSecrets(String(error)) });
      });
      this.pending.add(operation);
      void operation.finally(() => this.pending.delete(operation));
    }, delayMs);
    if (typeof handle.unref === 'function') handle.unref();
    return () => clearInterval(handle);
  }

  stop(): void {
    this.stopped = true;
    this.abort.abort();
    this.commandTimerDisposer?.();
    this.scheduleTimerDisposer?.();
    this.commandTimerDisposer = null;
    this.scheduleTimerDisposer = null;
  }

  async drain(): Promise<void> { await Promise.allSettled([...this.pending]); }

  async trackTool<T>(operation: () => Promise<T>): Promise<T> {
    if (this.stopped) throw new MomentsError('POLICY_DENIED', '插件正在停止');
    const result = operation();
    const settled = result.then(() => {}, () => {});
    this.pending.add(settled);
    try { return await result; } finally { this.pending.delete(settled); }
  }

  /** 目录名必须是显式图片任务 ID；只处理仍在等待用户的任务。 */
  async scanImageImports(): Promise<number> {
    if (this.importsRunning) return 0;
    this.importsRunning = true;
    try { return await this.scanImageImportsExclusive(); }
    finally { this.importsRunning = false; }
  }

  private async scanImageImportsExclusive(): Promise<number> {
    if (this.stopped || this.control.paused || this.control.killSwitch) return 0;
    let imported = 0;
    for (const task of this.deps.store.listTasks(['IMAGE_PENDING'], 500)) {
      for (const imageTask of this.deps.store.listImageTasksByTask(task.taskId)) {
        if (imageTask.status !== 'AWAITING_USER') continue;
        if (new Date(imageTask.expiresAt).getTime() <= this.now().getTime()) {
          this.deps.store.updateImageTask(imageTask.imageTaskId, { status: 'EXPIRED' });
          continue;
        }
        const relative = path.join('imports', imageTask.imageTaskId);
        const directory = resolveInsideRoot(this.deps.dataDir, relative, '图片任务目录');
        const files = await readdir(directory).catch(() => [] as string[]);
        for (const file of files.filter((name) => /\.(png|jpe?g|webp)$/i.test(name)).sort()) {
          this.assertActive();
          try {
            await this.importImage({ imageTaskId: imageTask.imageTaskId, path: path.join(relative, file) });
            imported++;
            await this.reviewTask(task.taskId);
            break;
          } catch (error) {
            this.deps.logger.warn('图片任务目录导入失败', { imageTaskId: imageTask.imageTaskId, error: redactSecrets(String(error)) });
          }
        }
      }
    }
    return imported;
  }

  /** 测试/管理页使用：上次自主循环时间。 */
  get lastAutonomous(): string | null {
    return this.lastAutonomousAt;
  }

  /** 所有者命令处理游标（诊断用）。 */
  get commandCursor(): string {
    return this.lastCommandAt;
  }
}
