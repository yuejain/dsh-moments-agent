/**
 * 测试替身：Mock LLM / Chat 通道 / 桌面执行器 / 图像门面。
 * 仅用于单元与集成测试，不访问真实微信、模型或 GUI。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MomentsStore } from '../../dist/storage/store.js';
import { parseConfig } from '../../dist/config.js';

export class MockLlm {
  constructor({ idea = [], compose = [], review = [], imagePrompt = [] } = {}) {
    this.queues = {
      idea: [...idea],
      compose: [...compose],
      review: [...review],
      'image-prompt': [...imagePrompt],
      other: [],
    };
    this.calls = [];
    this.fail = false;
  }

  async complete(request) {
    this.calls.push(request);
    if (this.fail) throw new Error('mock llm failure');
    const purpose = request.purpose ?? 'other';
    const queue = this.queues[purpose] ?? this.queues.other;
    const next = queue.shift();
    if (next === undefined) throw new Error(`mock llm queue empty for ${purpose}`);
    return { text: next, provider: 'mock', model: 'mock-model' };
  }

  async checkCapabilities() {
    return { status: 'ok', message: 'Mock LLM 可用' };
  }
}

export class MockOwnerChannel {
  constructor({ accountId = 'wxid_test' } = {}) {
    this.accountId = accountId;
    this.name = 'wechat_owner';
    this.sent = [];
    this.messages = [];
    this.inbox = [];
    this.counter = 0;
  }

  async checkHealth() {
    return { status: 'ok', message: 'Mock 所有者通道' };
  }

  async sendApprovalRequest(request) {
    this.sent.push(request);
    return { delivered: true, messageId: `mock-${this.sent.length}` };
  }

  async sendText(text) {
    this.sent.push({ text });
    return { delivered: true, messageId: `mock-text-${this.sent.length}` };
  }

  async listOwnerMessages() {
    const messages = this.messages.splice(0, this.messages.length);
    return [...this.inbox.splice(0, this.inbox.length), ...messages];
  }

  async currentAccountId() {
    return this.accountId;
  }

  push(message) {
    this.counter += 1;
    this.inbox.push({
      messageId: message.messageId ?? `msg-${this.counter}`,
      senderWxid: message.senderWxid ?? 'wxid_owner',
      accountId: message.accountId ?? this.accountId,
      text: message.text,
      receivedAt: message.receivedAt ?? new Date(Date.now() + this.counter).toISOString(),
    });
  }
}

export class MockDesktop {
  constructor({ health = {}, status = {}, publishResult = {} } = {}) {
    this.calls = [];
    this.healthValue = {
      ok: true,
      version: 'mock-desktop',
      wechatInstalled: true,
      wechatVersion: '4.1.15.13',
      uiaAvailable: false,
      allowPublish: false,
      mode: 'PREPARE_ONLY',
      message: 'mock',
      ...health,
    };
    this.statusValue = {
      running: true,
      loggedIn: true,
      accountId: 'wxid_test',
      version: '4.1.15.13',
      interactive: true,
      locked: false,
      supported: true,
      windowTitle: '微信',
      dpiScale: 1,
      notes: [],
      ...status,
    };
    this.publishValue = {
      submitted: true,
      verified: true,
      uncertain: false,
      screenshotPath: null,
      verification: {
        verified: true,
        method: 'mock-uia',
        publishedAt: new Date().toISOString(),
        visibleText: null,
        imageCount: null,
        evidencePath: null,
        notes: [],
      },
      errorCode: null,
      message: 'mock published',
      ...publishResult,
    };
  }

  async health() {
    return this.healthValue;
  }
  async status() {
    return this.statusValue;
  }
  async prepare(request) {
    this.calls.push({ method: 'prepare', request });
    return {
      ok: true,
      prepared: true,
      screenshotPath: 'C:/tmp/mock.png',
      textMatched: true,
      imageCount: request.assetPaths.length,
      warnings: [],
      errorCode: null,
      message: 'mock prepared',
    };
  }
  async publish(request) {
    this.calls.push({ method: 'publish', request });
    return this.publishValue;
  }
  async verify() {
    this.calls.push({ method: 'verify' });
    return this.publishValue.verification;
  }
  async cancel() {
    this.calls.push({ method: 'cancel' });
  }
}

export class MockImageFacade {
  constructor(store = null) {
    this.store = store;
    this.assets = [];
    this.generated = [];
    this.capabilities = [
      {
        available: true,
        provider: 'manual_subscription',
        requiresUserAction: true,
        supportsEdit: false,
        supportsGeneration: false,
        reasons: [],
      },
    ];
    this.reviewPassed = true;
  }

  async listCapabilities() {
    return this.capabilities;
  }

  async generate(request) {
    this.generated.push(request);
    return {
      result: {
        provider: 'manual_subscription',
        model: 'none',
        status: 'awaiting_user',
        images: [],
        errorCode: null,
        requiresUserAction: true,
        message: '请用 ChatGPT Plus/Gemini 客户端生成后导入',
      },
      assets: [],
    };
  }

  async importFromPath(input) {
    return this.importBytes({ ...input, bytes: new Uint8Array([137, 80, 78, 71]), declaredMime: 'image/png' });
  }

  async importBytes(input) {
    const sha256 =
      input.sha256 ??
      'a'.repeat(64);
    const asset = {
      assetId: `asset_${this.assets.length + 1}`,
      sha256,
      path: `/tmp/${sha256}.png`,
      mime: input.declaredMime ?? 'image/png',
      width: 64,
      height: 64,
      bytes: input.bytes?.length ?? 4,
      source: input.source ?? 'owner_upload',
      license: input.license ?? 'test',
      prompt: input.prompt ?? '',
      provider: input.provider ?? 'local-import',
      model: input.model ?? '',
      imageTaskId: input.imageTaskId ?? null,
      perceptualHash: null,
      createdAt: new Date().toISOString(),
    };
    if (this.store !== null && typeof this.store.insertAsset === 'function') {
      const saved = this.store.insertAsset(asset);
      this.assets.push(saved.asset);
      return saved;
    }
    this.assets.push(asset);
    return { asset, duplicate: false };
  }

  async reviewAsset(assetId) {
    return {
      assetId,
      passed: this.reviewPassed,
      flags: [],
      notes: this.reviewPassed ? [] : ['mock review failed'],
      report: {},
    };
  }
}

export function makeConfig(overrides = {}) {
  const base = {
    enabled: true,
    dataDir: 'data',
    publishMode: 'PREPARE_ONLY',
    killSwitch: false,
    scheduleEnabled: false,
    ownerChannel: 'wechat',
    llm: { provider: 'mock', model: 'mock-model' },
    wechatAgent: { enabled: false, account: 'wxid_test', ownerWxid: 'wxid_owner' },
    desktopExecutor: { enabled: true, baseUrl: 'http://127.0.0.1:18765' },
    images: { providers: ['manual-subscription', 'local-import'] },
    policy: {
      dailyLimit: 3,
      minIntervalMinutes: 0,
      quietHours: ['23:00', '08:00'],
      requireApproval: true,
      approvalTtlMinutes: 60,
      minScoreToPublish: 0.4,
      timeZone: 'Asia/Shanghai',
      maxTextLength: 2000,
      maxImages: 9,
    },
    scheduler: { tickSeconds: 60, ideaProbability: 1 },
    adminServer: { enabled: false },
    workspace: {
      personaFile: 'persona/SOUL.md',
      visualStyleFile: 'persona/VISUAL_STYLE.md',
    },
  };
  return deepMerge(base, overrides);
}

export function deepMerge(base, overrides) {
  const out = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = deepMerge(base[key] ?? {}, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export async function createTestContext(options = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'moments-test-'));
  const dbPath = path.join(dir, 'moments.sqlite');
  const store = await MomentsStore.open(dbPath);
  const config = parseConfig(makeConfig(options.config ?? {}));
  const llm = options.llm ?? new MockLlm();
  const channel = options.channel ?? new MockOwnerChannel();
  const desktop = options.desktop ?? new MockDesktop();
  const image = options.image ?? new MockImageFacade(store);
  return {
    dir,
    dbPath,
    store,
    config,
    llm,
    channel,
    desktop,
    image,
    cleanup() {
      try {
        store.close();
      } catch {
        // ignore
      }
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

export const IDEA_JSON = JSON.stringify({
  ideas: [
    {
      topic: '为什么本地小模型值得被认真对待',
      motivation: '观察到端侧推理成本下降，但讨论仍停留在参数竞赛',
      source_type: 'science_reflection',
      source_evidence: '公开论文与厂商发布资料（示例）',
      scores: {
        novelty: 0.8,
        persona: 0.85,
        relevance: 0.7,
        expression: 0.8,
        emotion: 0.6,
        timeliness: 0.5,
      },
    },
  ],
  silentReason: null,
});

export const COMPOSE_JSON = JSON.stringify({
  text: '端侧模型真正改变的不是参数表，而是你愿不愿意把一件小事交给它。',
  tone: '克制、略带观察',
});

export const REVIEW_JSON = JSON.stringify({
  passed: true,
  flags: [],
  notes: ['无明显隐私或事实风险'],
  personaFit: 0.82,
});
