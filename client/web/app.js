/* ============================================================================
 * DSH Moments Agent · Web 客户端
 * 纯原生 ES2020，无框架、无构建、无外部请求。
 *
 * 分区：
 *   1. 常量与字典          2. DOM / 图标工具      3. API 封装
 *   4. 格式化工具          5. 全局状态            6. Toast / Modal
 *   7. 顶栏 / 侧栏 / 连接   8. 路由与轮询          9. 概览页
 *  10. 创作页             11. 待审批页           12. 任务页
 *  13. 历史页             14. 设置页             15. 启动与生命周期
 *
 * 安全约定：
 *   - 所有动态数据只用 textContent / 文本节点写入，绝不 innerHTML 拼接；
 *   - app.js 不用 innerHTML：图标由 index.html 的静态 SVG sprite + createElementNS 使用；
 *   - 不保存、不打印、不在界面上显示管理令牌（令牌只存在于服务端）。
 * ========================================================================== */
'use strict';

(() => {
  /* ==========================================================================
   * 1. 常量与字典
   * ======================================================================== */
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const STATE_ZH = {
    IDEA_CREATED: '已选题',
    DRAFTING: '写稿中',
    DRAFT_READY: '草稿就绪',
    IMAGE_REQUIRED: '需要配图',
    IMAGE_PENDING: '配图等待中',
    IMAGE_READY: '配图就绪',
    REVIEWING: '审核中',
    READY_FOR_APPROVAL: '待审批',
    APPROVED: '已批准',
    QUEUED: '排队中',
    PREPARING: '准备中',
    PREPARED: '已准备',
    PUBLISHING: '发表中',
    PUBLISHED: '已发表',
    UNCERTAIN: '结果不确定',
    FAILED: '失败',
    CANCELLED: '已取消',
    EXPIRED: '已过期',
  };

  const STATE_TONE = {
    IDEA_CREATED: 'info',
    DRAFTING: 'info',
    DRAFT_READY: 'info',
    IMAGE_REQUIRED: 'warn',
    IMAGE_PENDING: 'warn',
    IMAGE_READY: 'info',
    REVIEWING: 'info',
    READY_FOR_APPROVAL: 'warn',
    APPROVED: 'primary',
    QUEUED: 'primary',
    PREPARING: 'primary',
    PREPARED: 'info',
    PUBLISHING: 'warn',
    PUBLISHED: 'ok',
    UNCERTAIN: 'warn',
    FAILED: 'danger',
    CANCELLED: 'muted',
    EXPIRED: 'muted',
  };

  const TERMINAL_STATES = new Set(['PUBLISHED', 'FAILED', 'CANCELLED', 'EXPIRED']);

  const APPROVAL_STATUS_ZH = {
    pending: '待审批',
    approved: '已批准',
    rejected: '已拒绝',
    expired: '已过期',
    consumed: '已核销',
    superseded: '已失效',
  };

  const APPROVAL_STATUS_TONE = {
    pending: 'warn',
    approved: 'ok',
    rejected: 'danger',
    expired: 'muted',
    consumed: 'info',
    superseded: 'muted',
  };

  const ATTEMPT_STATE_ZH = {
    PLANNED: '已计划',
    PREPARING: '准备中',
    PREPARED: '已准备',
    PUBLISHING: '发表中',
    PUBLISHED: '已发表',
    UNCERTAIN: '结果不确定',
    VERIFIED: '已核验',
    FAILED: '失败',
    CANCELLED: '已取消',
  };

  const ATTEMPT_TONE = {
    PLANNED: 'muted',
    PREPARING: 'info',
    PREPARED: 'info',
    PUBLISHING: 'warn',
    PUBLISHED: 'ok',
    UNCERTAIN: 'warn',
    VERIFIED: 'ok',
    FAILED: 'danger',
    CANCELLED: 'muted',
  };

  const ADAPTER_ZH = {
    ok: '正常',
    degraded: '降级',
    unavailable: '不可用',
    not_configured: '未配置',
    not_tested: '未测试',
  };

  const ADAPTER_TONE = {
    ok: 'ok',
    degraded: 'warn',
    unavailable: 'error',
    not_configured: 'muted',
    not_tested: 'muted',
  };

  const SOURCE_TYPE_ZH = {
    owner_topic: '所有者主题',
    saved_opinion: '收藏观点',
    public_news: '公开新闻',
    owner_article: '所有者文章',
    owner_image: '所有者图片',
    book_review: '书评',
    film_review: '影评',
    science_reflection: '科学思考',
    history_extension: '历史延伸',
    creative_expression: '创作表达',
    chat_signal: '聊天信号',
    manual: '手动',
  };

  const SOURCE_TYPE_OPTIONS = [
    { value: '', label: '自动判断（推荐）' },
    { value: 'owner_topic', label: '所有者主题 owner_topic' },
    { value: 'saved_opinion', label: '收藏观点 saved_opinion' },
    { value: 'public_news', label: '公开新闻 public_news' },
    { value: 'owner_article', label: '所有者文章 owner_article' },
    { value: 'owner_image', label: '所有者图片 owner_image' },
    { value: 'book_review', label: '书评 book_review' },
    { value: 'film_review', label: '影评 film_review' },
    { value: 'science_reflection', label: '科学思考 science_reflection' },
    { value: 'history_extension', label: '历史延伸 history_extension' },
    { value: 'creative_expression', label: '创作表达 creative_expression' },
    { value: 'chat_signal', label: '聊天信号 chat_signal' },
    { value: 'manual', label: '手动 manual' },
  ];

  const PUBLISH_MODE_ZH = {
    PREPARE_ONLY: '仅准备 · 不发表',
    APPROVAL_REQUIRED: '审批后发表',
    POLICY_AUTONOMOUS: '策略自动发表',
  };

  const VISIBILITY_ZH = { PUBLIC: '公开', PRIVATE: '私密', PARTIAL: '部分可见' };

  const CHANNEL_ZH = { manual_admin: '本机管理', wechat_owner: '微信所有者', cli: '命令行', manual: '本机管理' };

  const ACTOR_ZH = {
    owner: '所有者',
    agent: '智能体',
    manual_admin: '本机管理',
    wechat_owner: '微信所有者',
    scheduler: '调度器',
    system: '系统',
  };

  const AUDIT_ACTION_ZH = {
    state_transition: '状态流转',
    idea_created: '生成候选想法',
    idea_rejected: '候选未通过',
    idea_silence: '选择沉默',
    draft_reviewed: '草稿审核',
    approval_requested: '申请审批',
    approval_approved: '批准审批',
    approval_rejected: '拒绝审批',
    approval_consumed: '核销审批',
    desktop_prepared: '准备朋友圈界面',
    publish_uncertain: '发表结果不确定',
    uncertain_resolved: '人工核对结果',
    autonomous_cycle_failed: '自主创作失败',
    owner_command_failed: '所有者命令失败',
  };

  const TASK_GROUPS = [
    { key: 'approval', label: '待审批', color: '#ffb547', states: ['READY_FOR_APPROVAL'] },
    { key: 'approved', label: '已批准', color: '#5b8cff', states: ['APPROVED', 'QUEUED', 'PREPARING', 'PREPARED'] },
    { key: 'published', label: '已发表', color: '#3ddc97', states: ['PUBLISHED'] },
    { key: 'abnormal', label: '失败 / 取消', color: '#ff5d73', states: ['FAILED', 'UNCERTAIN', 'EXPIRED', 'CANCELLED'] },
    {
      key: 'drafting',
      label: '创作中',
      color: '#8b93a8',
      states: ['IDEA_CREATED', 'DRAFTING', 'DRAFT_READY', 'IMAGE_REQUIRED', 'IMAGE_PENDING', 'IMAGE_READY', 'REVIEWING'],
    },
  ];

  const ROUTES = {
    dashboard: { title: '概览', subtitle: '系统状态与最近活动' },
    compose: { title: '创作', subtitle: '生成草稿并提交审批（不会准备或发表）' },
    approvals: { title: '待审批', subtitle: '逐条核对正文、内容哈希与可见范围' },
    tasks: { title: '任务', subtitle: '跟踪每个任务的状态时间线与发布尝试' },
    history: { title: '历史', subtitle: '已发表记录与候选主题' },
    settings: { title: '设置', subtitle: '连接信息、人格预览与所有者控制' },
  };

  const POLLABLE = new Set(['dashboard', 'approvals', 'tasks']);
  const POLL_INTERVAL_MS = 15000;

  /* ==========================================================================
   * 2. DOM / 图标工具
   * ======================================================================== */
  const $ = (selector, root = document) => root.querySelector(selector);

  function appendChildren(parent, children) {
    for (const child of children) {
      if (child === null || child === undefined || child === false) continue;
      if (Array.isArray(child)) appendChildren(parent, child);
      else if (child instanceof Node) parent.appendChild(child);
      else parent.appendChild(document.createTextNode(String(child)));
    }
  }

  /** replaceChildren 会把 null 转成字符串 "null"，这里统一安全替换。 */
  function setChildren(node, ...children) {
    node.replaceChildren();
    appendChildren(node, children);
  }

  /** 创建元素：class / text / style / dataset / on* / 普通属性。 */
  function h(tag, props, ...children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value === null || value === undefined || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'value') node.value = value;
        else if (key === 'checked') node.checked = Boolean(value);
        else if (key === 'disabled') node.disabled = Boolean(value);
        else if (key === 'dataset') Object.assign(node.dataset, value);
        else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
        else if (key.startsWith('on') && typeof value === 'function') {
          node.addEventListener(key.slice(2).toLowerCase(), value);
        } else if (value === true) node.setAttribute(key, '');
        else node.setAttribute(key, String(value));
      }
    }
    appendChildren(node, children);
    return node;
  }

  /** 图标：只使用本文件静态 SVG sprite 的 id。 */
  function icon(name, size = 18) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', '#i-' + name);
    svg.appendChild(use);
    return svg;
  }

  function badge(label, tone = 'muted', withDot = true) {
    return h('span', { class: `badge badge-${tone}` }, withDot ? h('span', { class: 'dot' }) : null, label);
  }

  function stateBadge(stateValue) {
    const value = stateValue ? String(stateValue) : '';
    return h(
      'span',
      { class: `badge badge-${STATE_TONE[value] || 'muted'}`, title: value || '未知状态' },
      h('span', { class: 'dot' }),
      STATE_ZH[value] || value || '未知',
    );
  }

  function approvalStatusBadge(status) {
    const value = status ? String(status) : '';
    return badge(APPROVAL_STATUS_ZH[value] || value || '未知', APPROVAL_STATUS_TONE[value] || 'muted');
  }

  function attemptStateBadge(stateValue) {
    const value = stateValue ? String(stateValue) : '';
    return badge(ATTEMPT_STATE_ZH[value] || value || '未知', ATTEMPT_TONE[value] || 'muted');
  }

  function adapterTone(status) {
    return ADAPTER_TONE[status] || 'muted';
  }

  function statusDot(tone) {
    return h('span', { class: `status-dot ${tone === 'error' ? 'error' : tone}` });
  }

  function pageSkeleton(kind = 'default') {
    const root = h('div', { class: 'page' });
    if (kind === 'dashboard') {
      root.appendChild(h('div', { class: 'skeleton', style: { height: '168px', borderRadius: '20px' } }));
      const grid = h('div', { class: 'grid' });
      for (let i = 0; i < 3; i += 1) {
        grid.appendChild(h('div', { class: 'col-4' }, h('div', { class: 'skeleton sk-card' })));
      }
      root.appendChild(grid);
      const grid2 = h('div', { class: 'grid' });
      grid2.appendChild(h('div', { class: 'col-7' }, h('div', { class: 'skeleton sk-card', style: { height: '260px' } })));
      grid2.appendChild(h('div', { class: 'col-5' }, h('div', { class: 'skeleton sk-card', style: { height: '260px' } })));
      root.appendChild(grid2);
      return root;
    }
    const card = h('div', { class: 'card' }, h('div', { class: 'card-body' },
      h('div', { class: 'skeleton sk-line w40 lg' }),
      h('div', { class: 'skeleton sk-line w80' }),
      h('div', { class: 'skeleton sk-line w60' }),
      h('div', { class: 'skeleton sk-line w80' }),
      h('div', { class: 'skeleton sk-block', style: { marginTop: '18px' } }),
    ));
    root.appendChild(card);
    root.appendChild(h('div', { class: 'skeleton sk-card' }));
    return root;
  }

  function emptyState({ iconName = 'info', title = '暂无内容', text = '', action = null }) {
    return h('div', { class: 'empty' },
      h('div', { class: 'empty-art' }, icon(iconName, 25)),
      h('h3', {}, title),
      text ? h('p', {}, text) : null,
      action || null,
    );
  }

  function summaryTile(key, valueNode) {
    return h('div', { class: 'summary-tile' },
      h('div', { class: 'summary-key' }, key),
      h('div', { class: `summary-val${typeof valueNode === 'string' ? '' : ''}` }, valueNode),
    );
  }

  function copyButton(getText, { label = '复制', size = 'sm' } = {}) {
    const btn = h('button', { class: `btn ${size === 'sm' ? 'btn-ghost btn-sm' : 'btn-outline'}`, type: 'button', title: label }, icon('copy'), label);
    btn.addEventListener('click', async (event) => {
      event.stopPropagation();
      await copyText(getText());
    });
    return btn;
  }

  async function copyText(text) {
    const value = String(text ?? '');
    if (!value) {
      toast('没有可复制的内容', '', 'warn');
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      toast('已复制到剪贴板', value.length > 64 ? `${value.slice(0, 64)}…` : value, 'success');
    } catch {
      // 剪贴板权限不可用时的兜底：临时 textarea + execCommand（仅本机回环页面）
      const area = h('textarea', { style: { position: 'fixed', left: '-9999px', top: '0', opacity: '0' } });
      area.value = value;
      document.body.appendChild(area);
      area.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      area.remove();
      if (ok) toast('已复制到剪贴板', '', 'success');
      else toast('复制失败', '浏览器拒绝了剪贴板访问，请手动选择文本复制。', 'error');
    }
  }

  function shortId(value, head = 12) {
    const text = value ? String(value) : '';
    if (text.length <= head + 8) return text || '—';
    return `${text.slice(0, head)}…${text.slice(-4)}`;
  }

  function shortHash(value, length = 16) {
    const text = value ? String(value) : '';
    if (!text) return '—';
    return text.length <= length ? text : `${text.slice(0, length)}…`;
  }

  function hashBlock(label, hashValue) {
    const value = hashValue ? String(hashValue) : '';
    return h('div', {},
      label ? h('div', { class: 'hash-label' }, label) : null,
      h('div', { class: 'hash-block' },
        h('code', {}, value || '—'),
        value ? copyButton(() => value, { label: '复制哈希', size: 'sm' }) : null,
      ),
    );
  }

  /* ==========================================================================
   * 3. API 封装
   * ======================================================================== */
  class ApiError extends Error {
    constructor(code, message, { status = 0, kind = 'business' } = {}) {
      super(message);
      this.name = 'ApiError';
      this.code = code;
      this.status = status;
      this.kind = kind;
    }
  }

  async function request(path, { method = 'GET', body, timeout = 20000, headers = {} } = {}) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeout);
    let response;
    try {
      response = await fetch(path, {
        method,
        cache: 'no-store',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw new ApiError('TIMEOUT', `请求超时（${Math.round(timeout / 1000)} 秒）：${path}`, { kind: 'timeout' });
      }
      throw new ApiError('NETWORK', '无法连接本地客户端服务，请确认 client/server.py 仍在运行。', { kind: 'network' });
    } finally {
      window.clearTimeout(timer);
    }

    let raw = '';
    try { raw = await response.text(); } catch { raw = ''; }
    let payload = null;
    if (raw !== '') {
      try { payload = JSON.parse(raw); } catch { payload = null; }
    }

    if (response.status === 401) {
      throw new ApiError(payload && payload.errorCode ? payload.errorCode : 'AUTH_REQUIRED',
        (payload && payload.message) || '管理令牌缺失或错误（HTTP 401）', { status: 401, kind: 'auth' });
    }
    if (!response.ok) {
      const code = (payload && payload.errorCode) || `HTTP_${response.status}`;
      const kind = code === 'ADMIN_API_UNREACHABLE' ? 'proxy'
        : code === 'TOKEN_MISSING' ? 'auth'
          : response.status >= 500 ? 'server' : 'business';
      throw new ApiError(code, (payload && payload.message) || `请求失败（HTTP ${response.status}）`, { status: response.status, kind });
    }
    if (!payload || payload.ok !== true) {
      throw new ApiError(
        (payload && payload.errorCode) || 'UNEXPECTED_RESPONSE',
        (payload && payload.message) || '后端返回了未预期的响应（ok !== true）',
        { status: response.status, kind: 'business' },
      );
    }
    return payload.data;
  }

  const api = {
    clientInfo: () => request('/api/client/info', { timeout: 8000 }),
    clientConfig: () => request('/api/client/config', { timeout: 8000 }),
    saveClientConfig: (payload) => request('/api/client/config', { method: 'POST', body: payload }),
    openData: () => request('/api/client/open-data', { method: 'POST', headers: { 'X-Requested-With': 'DSHMomentsClient' } }),
    shutdown: () => request('/api/client/shutdown', { method: 'POST', headers: { 'X-Requested-With': 'DSHMomentsClient' }, timeout: 8000 }),

    health: () => request('/proxy/api/health'),
    status: () => request('/proxy/api/status'),
    tasks: (limit = 100) => request(`/proxy/api/tasks?limit=${encodeURIComponent(limit)}`),
    task: (taskId) => request(`/proxy/api/tasks/${encodeURIComponent(taskId)}`),
    approvals: () => request('/proxy/api/approvals'),
    history: (limit = 20) => request(`/proxy/api/history?limit=${encodeURIComponent(limit)}`),
    persona: () => request('/proxy/api/persona'),
    config: () => request('/proxy/api/config'),
    preview: (taskId) => request(`/proxy/api/preview/${encodeURIComponent(taskId)}`),

    approve: (approvalId, reason) => request(`/proxy/api/approvals/${encodeURIComponent(approvalId)}/approve`, { method: 'POST', body: { reason: reason || '' } }),
    reject: (approvalId, reason) => request(`/proxy/api/approvals/${encodeURIComponent(approvalId)}/reject`, { method: 'POST', body: { reason: reason || '' } }),

    workflowDraft: (input) => request('/proxy/api/workflow/draft', { method: 'POST', body: input, timeout: 245000 }),
    compose: (taskId, options = {}) => request(`/proxy/api/tasks/${encodeURIComponent(taskId)}/compose`, { method: 'POST', body: options, timeout: 95000 }),
    review: (taskId) => request(`/proxy/api/tasks/${encodeURIComponent(taskId)}/review`, { method: 'POST', body: {}, timeout: 95000 }),
    requestApproval: (taskId) => request(`/proxy/api/tasks/${encodeURIComponent(taskId)}/request-approval`, { method: 'POST', body: {} }),
    prepare: (taskId) => request(`/proxy/api/tasks/${encodeURIComponent(taskId)}/prepare`, { method: 'POST', body: {}, timeout: 95000 }),
    publish: (taskId, approvalId) => request(`/proxy/api/tasks/${encodeURIComponent(taskId)}/publish`, { method: 'POST', body: approvalId ? { approvalId } : {} }),
    cancelTask: (taskId) => request(`/proxy/api/tasks/${encodeURIComponent(taskId)}/cancel`, { method: 'POST', body: {} }),
    verify: (attemptId) => request(`/proxy/api/attempts/${encodeURIComponent(attemptId)}/verify`, { method: 'POST', body: {} }),

    pause: (reason) => request('/proxy/api/pause', { method: 'POST', body: { reason: reason || '客户端暂停' } }),
    resume: (reason) => request('/proxy/api/resume', { method: 'POST', body: { reason: reason || '客户端恢复' } }),
    kill: (reason) => request('/proxy/api/kill', { method: 'POST', body: { reason: reason || '客户端启用 Kill Switch' } }),
    unkill: (reason) => request('/proxy/api/unkill', { method: 'POST', body: { reason: reason || '客户端解除 Kill Switch' } }),
  };

  /* ==========================================================================
   * 4. 格式化工具
   * ======================================================================== */
  const pad2 = (value) => String(value).padStart(2, '0');

  function toDate(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function fmtDateTime(value) {
    const date = toDate(value);
    if (!date) return '—';
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  }

  function fmtClock(value) {
    const date = toDate(value);
    if (!date) return '—';
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
  }

  function fmtRelative(value) {
    const date = toDate(value);
    if (!date) return '—';
    const diff = Date.now() - date.getTime();
    const seconds = Math.floor(diff / 1000);
    if (seconds < 0) return '刚刚';
    if (seconds < 60) return '刚刚';
    if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
    if (seconds < 86400 * 7) return `${Math.floor(seconds / 86400)} 天前`;
    return fmtDateTime(value);
  }

  function fmtMinutes(totalMinutes) {
    const minutes = Number(totalMinutes);
    if (!Number.isFinite(minutes)) return '—';
    if (minutes < 60) return `${minutes} 分钟`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分`;
  }

  function textSnippet(text, length = 80) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    return value.length > length ? `${value.slice(0, length)}…` : value;
  }

  function sourceTypeText(value) {
    const key = value ? String(value) : '';
    return SOURCE_TYPE_ZH[key] || key || '—';
  }

  function visibilityText(value) {
    const key = value ? String(value) : '';
    return VISIBILITY_ZH[key] || key || '—';
  }

  function channelText(value) {
    const key = value ? String(value) : '';
    return CHANNEL_ZH[key] || key || '—';
  }

  function actorText(value) {
    const key = value ? String(value) : '';
    return ACTOR_ZH[key] || key || '系统';
  }

  function modeText(value) {
    const key = value ? String(value) : '';
    return PUBLISH_MODE_ZH[key] || key || '未知模式';
  }

  function countdownNode(expiresAt) {
    const node = h('span', { class: 'countdown', dataset: { expires: expiresAt || '' } });
    updateCountdownNode(node);
    return node;
  }

  function updateCountdownNode(node) {
    const iso = node.dataset.expires;
    if (!iso) { node.textContent = '—'; return; }
    const target = toDate(iso);
    if (!target) { node.textContent = '时间未知'; return; }
    const ms = target.getTime() - Date.now();
    if (ms <= 0) {
      node.textContent = '已过期';
      node.classList.add('expired');
      node.classList.remove('urgent');
      return;
    }
    node.classList.remove('expired');
    const total = Math.floor(ms / 1000);
    const hours = pad2(Math.floor(total / 3600));
    const minutes = pad2(Math.floor((total % 3600) / 60));
    const seconds = pad2(total % 60);
    node.textContent = `${hours}:${minutes}:${seconds}`;
    node.classList.toggle('urgent', total < 1800);
  }

  function taskById(taskId) {
    return state.tasks.find((item) => item && item.task && item.task.taskId === taskId) || null;
  }

  function approvalById(approvalId) {
    return state.approvals.find((item) => item && item.approvalId === approvalId) || null;
  }

  function groupCounts(tasks) {
    const counts = {};
    for (const group of TASK_GROUPS) counts[group.key] = 0;
    for (const item of tasks) {
      const stateValue = item && item.task ? item.task.state : '';
      const group = TASK_GROUPS.find((candidate) => candidate.states.includes(stateValue));
      if (group) counts[group.key] += 1;
    }
    return counts;
  }

  function healthIssues(health) {
    if (!health) return [];
    const issues = [];
    const adapters = [
      ['database', '数据库', health.database],
      ['llm', '模型', health.llm && health.llm.status],
      ['wechat', '微信通道', health.wechatAgent && health.wechatAgent.status],
      ['desktop', '桌面执行器', health.desktopExecutor && health.desktopExecutor.status],
      ['images', '图像 Provider', health.images && health.images.status],
    ];
    for (const [, label, value] of adapters) {
      if (value && value !== 'ok') issues.push(label);
    }
    return issues;
  }

  /* ==========================================================================
   * 5. 全局状态
   * ======================================================================== */
  const state = {
    client: null,
    health: null,
    status: null,
    tasks: [],
    approvals: [],
    persona: null,
    config: null,
    clientConfig: null,
    history: null,
    lastSyncAt: 0,
    route: { name: 'dashboard', params: [] },
    approvalSel: null,
    taskSel: null,
    taskFilter: 'all',
    exited: false,
    create: { form: { topic: '', sourceType: '', sourceEvidence: '', motivation: '' }, result: null, error: null, running: false, stage: 0, startedAt: 0, timers: [] },
    settingsForm: { baseUrl: '', tokenFile: '', dataDir: '' },
  };

  let renderSeq = 0;
  let currentRoute = null;
  let pollTimer = null;
  let countdownTimer = null;
  let applying = false;
  let modalSeq = 0;
  let activeModal = null;
  let heartbeat = { activated: false, timer: null };

  /* ==========================================================================
   * 6. Toast / Modal / 错误展示
   * ======================================================================== */
  function toast(title, text = '', tone = 'info', { duration = 4800 } = {}) {
    const stack = $('#toast-stack');
    if (!stack) return;
    const iconName = tone === 'success' ? 'check' : tone === 'error' ? 'alert' : tone === 'warn' ? 'alert' : 'info';
    const node = h('div', { class: `toast ${tone}`, role: 'alert' },
      h('div', { class: 'toast-icon' }, icon(iconName, 15)),
      h('div', { class: 'toast-body' },
        h('div', { class: 'toast-title' }, title),
        text ? h('p', { class: 'toast-text' }, text) : null,
      ),
      h('button', { class: 'toast-close', type: 'button', 'aria-label': '关闭通知' }, icon('x', 13)),
    );
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      node.classList.add('leaving');
      window.setTimeout(() => node.remove(), 220);
    };
    node.querySelector('.toast-close').addEventListener('click', close);
    stack.appendChild(node);
    window.setTimeout(close, duration);
  }

  function describeError(error) {
    const err = error instanceof ApiError
      ? error
      : new ApiError('UNKNOWN', (error && error.message) || '未知错误', { kind: 'business' });
    switch (err.kind) {
      case 'network':
        return {
          title: '无法连接本地客户端服务',
          detail: err.message,
          hint: '请确认 DSH Moments 客户端服务仍在运行（默认 http://127.0.0.1:18770/），然后点击重试。',
          code: err.code,
          warn: false,
        };
      case 'timeout':
        return {
          title: '请求超时',
          detail: err.message,
          hint: '管理 API 可能正在执行模型调用或桌面操作。请稍后到任务页查看结果，再决定是否重试。',
          code: err.code,
          warn: true,
        };
      case 'auth':
        return {
          title: '管理令牌不可用',
          detail: err.message,
          hint: '客户端只从 tokenFile 读取令牌并在服务端注入；请确认 DSH 插件已启用 adminServer、令牌文件存在。',
          code: err.code,
          warn: true,
        };
      case 'proxy':
        return {
          title: '插件管理 API 不可达',
          detail: err.message,
          hint: '本地客户端服务正常，但代理到插件管理 API（默认 127.0.0.1:18766）失败。请确认 DSH Moments 插件在运行。',
          code: err.code,
          warn: true,
        };
      case 'server':
        return {
          title: '管理 API 返回错误',
          detail: err.message,
          hint: '错误来自插件后端（HTTP 5xx）。客户端不会把失败当作成功，请核对任务详情或插件日志。',
          code: err.code,
          warn: false,
        };
      default:
        return {
          title: '操作未完成',
          detail: err.message,
          hint: '后端返回业务错误（ok=false）。错误码原样展示，未执行任何成功假设。',
          code: err.code,
          warn: false,
        };
    }
  }

  function isConnError(error) {
    return error instanceof ApiError && ['network', 'timeout', 'auth', 'proxy'].includes(error.kind);
  }

  function buildErrorCard(error, { onRetry = null, retryLabel = '重试' } = {}) {
    const info = describeError(error);
    const card = h('div', { class: 'card error-card' },
      h('div', { class: 'card-body' },
        h('div', { class: 'error-head' },
          h('div', { class: 'error-icon' }, icon('alert', 17)),
          h('div', {},
            h('h3', { class: 'error-title' }, info.title),
            h('p', { class: 'error-msg' }, info.detail || '没有更多错误信息。'),
            h('div', { class: 'error-meta' },
              info.code ? h('code', { class: 'error-code' }, String(info.code)) : null,
              error instanceof ApiError && error.status ? h('span', { class: 'badge badge-muted' }, `HTTP ${error.status}`) : null,
            ),
            h('p', { class: 'error-hint' }, info.hint),
            h('div', { class: 'error-actions' },
              onRetry ? h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: onRetry }, icon('refresh'), retryLabel) : null,
            ),
          ),
        ),
      ),
    );
    return card;
  }

  function renderModalError(host, error) {
    const info = describeError(error);
    host.replaceChildren(
      h('div', { class: 'modal-error' },
        h('div', { class: 'modal-error-title' }, icon('alert', 14), info.title),
        h('p', { class: 'modal-error-msg' }, info.detail || '没有更多错误信息。'),
        info.code ? h('code', { class: 'modal-error-code' }, String(info.code)) : null,
        h('p', { class: 'modal-error-msg' }, info.hint),
      ),
    );
  }

  /**
   * 通用 Modal。危险操作必须通过这里二次确认。
   * @param {object} config
   *  title/subtitle/iconName/tone/content/confirmText/cancelText/danger/requireCheckText
   *  onConfirm: async () => result  抛错时 Modal 保持打开并原样展示错误
   *  after: (result) => void        成功关闭后执行
   */
  function openModal(config) {
    const root = $('#modal-root');
    if (!root) return null;
    const previousFocus = document.activeElement;
    const titleId = `modal-title-${modalSeq += 1}`;
    let busy = false;
    let checked = false;

    const overlay = h('div', { class: 'modal-overlay' });
    const closeBtn = h('button', { class: 'modal-close', type: 'button', 'aria-label': '关闭' }, icon('x', 14));
    const errorSlot = h('div');
    const confirmBtn = h('button', {
      class: `btn ${config.danger ? 'btn-danger' : 'btn-primary'}`,
      type: 'button',
      disabled: Boolean(config.requireCheckText),
    }, config.confirmIcon ? icon(config.confirmIcon, 16) : null, config.confirmText || '确认');
    const cancelBtn = h('button', { class: 'btn btn-ghost', type: 'button' }, config.cancelText || '取消');

    let checkInput = null;
    let checkWrap = null;
    if (config.requireCheckText) {
      checkInput = h('input', { type: 'checkbox', 'aria-label': config.requireCheckText });
      checkWrap = h('label', { class: 'modal-check' }, checkInput, h('span', {}, config.requireCheckText));
      checkInput.addEventListener('change', () => {
        checked = checkInput.checked;
        checkWrap.classList.toggle('checked', checked);
        confirmBtn.disabled = busy || !checked;
      });
    }

    const bodyChildren = [];
    if (Array.isArray(config.content)) bodyChildren.push(...config.content);
    else if (config.content) bodyChildren.push(config.content);
    bodyChildren.push(checkWrap);
    bodyChildren.push(errorSlot);

    const panel = h('div', {
      class: 'modal-panel',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': titleId,
    },
      h('div', { class: 'modal-head' },
        h('div', { class: `modal-icon ${config.danger ? 'danger' : config.tone === 'warn' ? 'warn' : ''}` }, icon(config.iconName || 'alert', 18)),
        h('div', { class: 'modal-head-text' },
          h('h2', { class: 'modal-title', id: titleId }, config.title || '确认操作'),
          config.subtitle ? h('p', { class: 'modal-sub' }, config.subtitle) : null,
        ),
        closeBtn,
      ),
      h('div', { class: 'modal-body' }, bodyChildren),
      h('div', { class: 'modal-foot' },
        config.footerNote ? h('span', { class: 'modal-foot-note' }, config.footerNote) : null,
        cancelBtn,
        confirmBtn,
      ),
    );

    function setBusy(nextBusy) {
      busy = nextBusy;
      confirmBtn.disabled = nextBusy || Boolean(config.requireCheckText && !checked);
      cancelBtn.disabled = nextBusy;
      closeBtn.disabled = nextBusy;
      if (nextBusy) {
        setChildren(confirmBtn, h('span', { class: 'spinner' }), config.confirmText || '确认');
      } else {
        setChildren(confirmBtn, config.confirmIcon ? icon(config.confirmIcon, 16) : null, config.confirmText || '确认');
      }
    }

    function close() {
      busy = false;
      root.classList.remove('open');
      root.replaceChildren();
      activeModal = null;
      if (previousFocus && typeof previousFocus.focus === 'function') {
        try { previousFocus.focus(); } catch { /* 忽略 */ }
      }
    }

    function trapFocus(event) {
      const focusables = Array.from(panel.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href]'));
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    async function handleConfirm() {
      if (busy) return;
      if (config.requireCheckText && !checked) return;
      setBusy(true);
      errorSlot.replaceChildren();
      try {
        const result = config.onConfirm ? await config.onConfirm() : undefined;
        close();
        if (typeof config.after === 'function') {
          try { config.after(result); } catch (error) { console.error('afterModal 回调失败', error); }
        }
      } catch (error) {
        setBusy(false);
        renderModalError(errorSlot, error);
      }
    }

    confirmBtn.addEventListener('click', handleConfirm);
    cancelBtn.addEventListener('click', () => { if (!busy) close(); });
    closeBtn.addEventListener('click', () => { if (!busy) close(); });
    overlay.addEventListener('click', () => { if (!busy) close(); });

    activeModal = { close: () => { if (!busy) close(); }, isBusy: () => busy, trapFocus };
    root.classList.add('open');
    root.replaceChildren(overlay, panel);
    window.requestAnimationFrame(() => {
      if (config.requireCheckText) cancelBtn.focus();
      else {
        const firstField = panel.querySelector('input, textarea, select');
        (firstField || cancelBtn).focus();
      }
    });
    return { close, setBusy };
  }

  function modalRow(key, valueNode) {
    return h('div', { class: 'modal-row' },
      h('span', { class: 'k' }, key),
      h('span', { class: 'v' }, valueNode),
    );
  }

  function modalSection(label, ...children) {
    return h('div', { class: 'modal-section' },
      label ? h('p', { class: 'modal-label' }, label) : null,
      ...children,
    );
  }

  /* ==========================================================================
   * 7. 顶栏 / 侧栏 / 连接状态
   * ======================================================================== */
  function setConnection(kind, text) {
    const pill = $('#conn-pill');
    const sideDot = $('#side-conn-dot');
    const sideText = $('#side-conn-text');
    const connText = $('#conn-text');
    const pillClass = kind === 'ok' ? 'ok' : kind === 'warn' ? 'warn' : kind === 'error' ? 'error' : 'connecting';
    if (pill) { pill.className = `conn-pill ${pillClass}`; }
    if (connText) connText.textContent = text;
    if (sideDot) sideDot.className = `status-dot ${kind === 'ok' ? 'ok' : kind === 'warn' ? 'warn' : kind === 'error' ? 'error' : 'connecting'}`;
    if (sideText) sideText.textContent = text;
  }

  function buildBannerNode(error, { onRetry = () => refreshCurrent(true), dismissible = true } = {}) {
    const info = describeError(error);
    const retry = h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: onRetry }, icon('refresh'), '重试');
    const dismiss = dismissible
      ? h('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'aria-label': '关闭提示', onclick: (event) => { const banner = event.currentTarget.closest('.banner'); if (banner) banner.remove(); } }, icon('x', 14))
      : null;
    return h('div', { class: `banner${info.warn ? ' warn' : ''}` },
      icon('alert', 16),
      h('div', { class: 'banner-text' },
        h('div', { class: 'banner-title' }, info.title),
        h('div', { class: 'banner-detail' }, `${info.detail}${info.code ? `（${info.code}）` : ''}`),
      ),
      h('div', { class: 'banner-actions' }, retry, dismiss),
    );
  }

  function setBanner(error) {
    const slot = $('#banner-slot');
    if (!slot) return;
    slot.replaceChildren();
    if (!error || !isConnError(error)) return;
    slot.appendChild(buildBannerNode(error));
  }

  function updateChromeData() {
    const status = state.status || {};
    const control = status.control || {};
    const health = state.health || {};
    const accountId = status.accountId || '';
    const accountLabel = $('#account-label');
    if (accountLabel) {
      accountLabel.textContent = accountId || '账号未确认';
      const chip = $('#account-chip');
      if (chip) chip.title = accountId ? `当前朋友圈账号：${accountId}` : '尚未确认朋友圈账号';
    }
    const mode = control.publishMode || health.publishMode || '';
    const modeBadge = $('#mode-badge');
    if (modeBadge) {
      modeBadge.textContent = mode ? modeText(mode) : '模式 —';
      modeBadge.title = mode ? `发布模式：${mode}（${modeText(mode)}）` : '发布模式未知';
    }
    const badge = $('#nav-approval-badge');
    const pendingCount = Array.isArray(state.approvals) ? state.approvals.length : 0;
    if (badge) {
      badge.textContent = String(pendingCount);
      badge.hidden = pendingCount === 0;
    }
    if (state.client && state.client.version) {
      const version = $('#side-version');
      if (version) version.textContent = String(state.client.version);
    }
  }

  function setChrome(route) {
    const meta = ROUTES[route.name] || ROUTES.dashboard;
    document.querySelectorAll('.nav-item').forEach((item) => {
      item.classList.toggle('active', item.dataset.nav === route.name);
    });
    const title = $('#page-title');
    const subtitle = $('#page-subtitle');
    if (title) title.textContent = meta.title;
    if (subtitle) subtitle.textContent = meta.subtitle;
    document.title = `${meta.title} · DSH Moments`;
  }

  function refreshButtonSpin(active) {
    const btn = $('#refresh-btn');
    if (!btn) return;
    btn.classList.toggle('is-spinning', active);
  }

  /* ==========================================================================
   * 8. 路由与轮询
   * ======================================================================== */
  function parseRoute() {
    const raw = String(location.hash || '').replace(/^#\/?/, '');
    const parts = raw.split('/').filter(Boolean);
    const rawName = parts[0] || 'dashboard';
    // 兼容旧链接：#/create 与 #/compose 等价
    const name = ROUTES[rawName] ? rawName : rawName === 'create' ? 'compose' : 'dashboard';
    return { name, params: parts.slice(1) };
  }

  function routeParam(route, index = 0) {
    if (!route || !route.params) return null;
    const value = route.params[index];
    if (!value) return null;
    try { return decodeURIComponent(value); } catch { return value; }
  }

  async function applyRoute(route, { silent = false } = {}) {
    if (state.exited) return;
    const token = ++renderSeq;
    currentRoute = route;
    state.route = route;
    setChrome(route);
    if (!silent) {
      stopPolling();
      const page = $('#page');
      if (page) {
        page.classList.remove('page-enter');
        page.replaceChildren();
        page.scrollTop = 0;
        // 仅页面切换时播放一次进入动画，15s 静默刷新不闪烁
        void page.offsetWidth;
        page.classList.add('page-enter');
        window.setTimeout(() => { if (page.isConnected) page.classList.remove('page-enter'); }, 420);
      }
      refreshButtonSpin(true);
    }
    try {
      if (route.name === 'compose') await renderCreate(token);
      else if (route.name === 'approvals') await renderApprovals(token);
      else if (route.name === 'tasks') await renderTasks(token);
      else if (route.name === 'history') await renderHistory(token);
      else if (route.name === 'settings') await renderSettings(token);
      else await renderDashboard(token);
    } catch (error) {
      if (token !== renderSeq) return;
      const page = $('#page');
      if (page) page.replaceChildren(h('div', { class: 'page' }, buildErrorCard(error, { onRetry: () => refreshCurrent(true) })));
    } finally {
      if (token === renderSeq) {
        refreshButtonSpin(false);
        if (POLLABLE.has(route.name) && !state.exited) startPolling();
      }
    }
  }

  function startPolling() {
    stopPolling();
    pollTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && currentRoute && !state.exited) refreshCurrent(false);
    }, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (pollTimer !== null) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function refreshCurrent(manual = false) {
    if (state.exited || applying) return;
    if (manual) {
      refreshButtonSpin(true);
      if (currentRoute && currentRoute.name === 'compose' && state.create.running) {
        toast('创作进行中', '一键创作仍在执行，请等待结果返回。', 'info');
        refreshButtonSpin(false);
        return;
      }
    }
    // 以地址栏 hash 为准，避免 replaceState 后的选择状态被旧 route 参数覆盖
    const route = parseRoute();
    try {
      applying = true;
      await applyRoute(route, { silent: true });
    } finally {
      applying = false;
      refreshButtonSpin(false);
    }
  }

  async function loadCore() {
    const results = await Promise.allSettled([api.health(), api.status(), api.tasks(100), api.approvals()]);
    const errors = [];
    const failed = { health: false, status: false, tasks: false, approvals: false };
    const [healthResult, statusResult, tasksResult, approvalsResult] = results;
    if (healthResult.status === 'fulfilled' && healthResult.value) state.health = healthResult.value;
    else if (healthResult.status === 'rejected') { errors.push(healthResult.reason); failed.health = true; }
    if (statusResult.status === 'fulfilled' && statusResult.value) state.status = statusResult.value;
    else if (statusResult.status === 'rejected') { errors.push(statusResult.reason); failed.status = true; }
    if (tasksResult.status === 'fulfilled' && Array.isArray(tasksResult.value)) state.tasks = tasksResult.value;
    else if (tasksResult.status === 'rejected') { errors.push(tasksResult.reason); failed.tasks = true; }
    if (approvalsResult.status === 'fulfilled' && Array.isArray(approvalsResult.value)) state.approvals = approvalsResult.value;
    else if (approvalsResult.status === 'rejected') { errors.push(approvalsResult.reason); failed.approvals = true; }

    state.lastSyncAt = Date.now();
    const connError = errors.find(isConnError) || null;
    if (connError) {
      setBanner(connError);
      const info = describeError(connError);
      setConnection('error', info.title);
    } else if (errors.length > 0) {
      setBanner(null);
      setConnection('warn', '部分数据异常');
    } else {
      setBanner(null);
      setConnection('ok', '已连接');
    }
    updateChromeData();
    const allFailed = results.every((item) => item.status === 'rejected');
    return { errors, failed, allFailed };
  }

  /** 页面级刷新失败提示：明确说明可能展示的是旧数据，不隐藏错误。 */
  function buildFailureNotice(errors) {
    if (!Array.isArray(errors) || errors.length === 0) return null;
    const first = errors[0];
    const info = describeError(first);
    return h('div', { class: `banner${info.warn ? ' warn' : ''}`, style: { margin: '0' } },
      icon('alert', 16),
      h('div', { class: 'banner-text' },
        h('div', { class: 'banner-title' }, `数据刷新失败：${info.title}`),
        h('div', { class: 'banner-detail' }, `${info.detail}${info.code ? `（${info.code}）` : ''} · 页面可能显示上次成功加载的数据。`),
      ),
      h('div', { class: 'banner-actions' },
        h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => refreshCurrent(true) }, icon('refresh'), '重试'),
      ),
    );
  }

  async function loadClientInfo() {
    try {
      const info = await api.clientInfo();
      if (!info) return;
      state.client = info;
      const version = $('#side-version');
      if (version) version.textContent = String(info.version || '—');
    } catch {
      // 客户端元信息失败不阻塞业务页面；连接状态由业务请求决定。
    }
  }

  /* ==========================================================================
   * 9. 概览页
   * ======================================================================== */
  async function renderDashboard(token) {
    const page = $('#page');
    const hadContent = page.childElementCount > 0;
    if (!hadContent) page.appendChild(pageSkeleton('dashboard'));
    const { errors, allFailed } = await loadCore();
    if (token !== renderSeq) return;
    if (allFailed) {
      page.replaceChildren(h('div', { class: 'page' },
        buildErrorCard(errors[0], { onRetry: () => refreshCurrent(true), retryLabel: '重新连接' }),
      ));
      return;
    }
    const root = h('div', { class: 'page' });
    if (errors.length > 0) {
      const notice = buildFailureNotice(errors);
      if (notice) root.appendChild(notice);
    }
    root.appendChild(buildHero());
    const grid = h('div', { class: 'grid' });
    grid.appendChild(h('div', { class: 'col-4' }, buildHealthCard()));
    grid.appendChild(h('div', { class: 'col-4' }, buildControlCard()));
    grid.appendChild(h('div', { class: 'col-4' }, buildDistributionCard()));
    root.appendChild(grid);
    const grid2 = h('div', { class: 'grid' });
    grid2.appendChild(h('div', { class: 'col-7' }, buildRecentTasksCard()));
    grid2.appendChild(h('div', { class: 'col-5' }, buildReminderCard()));
    root.appendChild(grid2);
    page.replaceChildren(root);
  }

  function buildHero() {
    const health = state.health;
    const control = (state.status && state.status.control) || {};
    const pending = state.approvals.length;
    const killSwitch = control.killSwitch ?? (health && health.killSwitch) ?? false;
    const paused = control.paused ?? (health && health.paused) ?? false;
    const issues = healthIssues(health);
    const groups = groupCounts(state.tasks);
    let title = '系统正常，等待你的下一次表达。';
    if (killSwitch) title = 'Kill Switch 已生效，创作与发表全部暂停。';
    else if (paused) title = '系统已暂停，恢复后才会继续创作。';
    else if (!health) title = '健康状态暂不可读取，其他数据仍可查看。';
    else if (!health.ok) title = '系统存在异常，需要你检查健康状态。';
    else if (pending > 0) title = `系统正常，有 ${pending} 条内容等你核对。`;
    else if (issues.length > 0) title = `系统可用，但有 ${issues.length} 项能力未就绪。`;

    const descParts = [];
    if (!health) descParts.push('健康接口本轮不可用');
    if (health && health.database === 'ok') descParts.push('数据库可用');
    if (health && health.llm && health.llm.status === 'ok') descParts.push('模型可用');
    if (issues.length > 0) descParts.push(`${issues.join('、')} 未就绪`);
    const mode = control.publishMode || (health && health.publishMode) || '';
    if (mode) descParts.push(`发布模式为「${modeText(mode)}」`);
    if (groups.approved > 0) descParts.push(`${groups.approved} 条已批准内容等待准备`);
    const desc = `${descParts.join('；')}。${mode === 'PREPARE_ONLY' ? '任何发表都需要你手动确认，客户端不会替你点击。' : '危险操作都会二次确认后才提交。'}`;

    const meta = [];
    if (state.status && state.status.accountId) {
      meta.push(h('span', { class: 'meta-pill', title: state.status.accountId }, icon('user', 13), shortId(state.status.accountId, 16)));
    }
    if (mode) meta.push(h('span', { class: 'meta-pill' }, icon('shield', 13), modeText(mode)));
    meta.push(h('span', { class: 'meta-pill' }, icon('calendar', 13), control.scheduleEnabled ? '自主调度已启用' : '自主调度未启用'));
    if (health && health.checkedAt) {
      meta.push(h('span', { class: 'meta-pill', title: fmtDateTime(health.checkedAt) }, icon('clock', 13), `检查于 ${fmtRelative(health.checkedAt)}`));
    }

    return h('section', { class: 'hero' },
      h('div', { class: 'hero-main' },
        h('div', { class: 'hero-eyebrow' }, statusDot(killSwitch || paused ? 'warn' : issues.length > 0 ? 'warn' : 'ok'), '系统运行状态'),
        h('h2', { class: 'hero-title' }, title),
        h('p', { class: 'hero-desc' }, desc),
        h('div', { class: 'hero-meta' }, meta),
      ),
      h('div', { class: 'hero-actions' },
        h('a', { class: 'btn btn-primary btn-lg', href: '#/compose' }, icon('spark', 17), '生成草稿'),
        h('a', { class: 'btn btn-outline btn-lg', href: '#/approvals' },
          icon('inbox', 16),
          '查看待审批',
          pending > 0 ? h('span', { class: 'hero-count' }, String(pending)) : null,
        ),
      ),
    );
  }

  function buildHealthCard() {
    const health = state.health || {};
    const adapters = [
      { key: 'database', name: '数据库', iconName: 'database', status: health.database, message: health.database === 'ok' ? 'SQLite 本地数据库可用' : '数据库状态异常' },
      { key: 'llm', name: '模型', iconName: 'cpu', status: health.llm && health.llm.status, message: (health.llm && health.llm.message) || '模型状态未知' },
      { key: 'wechat', name: '微信通道', iconName: 'message', status: health.wechatAgent && health.wechatAgent.status, message: (health.wechatAgent && health.wechatAgent.message) || '微信通道状态未知' },
      { key: 'desktop', name: '桌面执行器', iconName: 'monitor', status: health.desktopExecutor && health.desktopExecutor.status, message: (health.desktopExecutor && health.desktopExecutor.message) || '桌面执行器状态未知' },
      { key: 'images', name: '图像 Provider', iconName: 'image', status: health.images && health.images.status, message: (health.images && health.images.message) || '图像能力状态未知' },
    ];
    const list = h('div', { class: 'health-list' });
    for (const adapter of adapters) {
      const tone = adapterTone(adapter.status);
      list.appendChild(h('div', { class: 'health-row' },
        h('span', { class: `hr-dot ${tone}` }),
        h('span', { class: 'hr-name' }, adapter.name),
        h('span', { class: 'hr-state' }, ADAPTER_ZH[adapter.status] || adapter.status || '未知'),
        h('span', { class: 'hr-msg', title: adapter.message }, adapter.message),
      ));
    }
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        h('div', {}, h('h3', { class: 'card-title' }, icon('shield'), '系统健康'), h('p', { class: 'card-sub' }, '各能力适配器的实时状态')),
        h('span', { class: `badge badge-${health.ok ? 'ok' : 'warn'}` }, h('span', { class: 'dot' }), health.ok ? '整体可用' : '整体降级'),
      ),
      h('div', { class: 'card-body tight' }, list),
    );
  }

  function buildControlCard() {
    const control = (state.status && state.status.control) || {};
    const health = state.health || {};
    const mode = control.publishMode || health.publishMode || '';
    const rows = [
      { icon: 'shield', name: '发布模式', value: modeText(mode), tone: mode === 'PREPARE_ONLY' ? 'primary' : 'info' },
      { icon: 'pause', name: '暂停状态', value: control.paused ? '已暂停' : '未暂停', tone: control.paused ? 'warn' : 'ok' },
      { icon: 'power', name: 'Kill Switch', value: control.killSwitch ? '已启用' : '关闭', tone: control.killSwitch ? 'danger' : 'ok' },
      { icon: 'calendar', name: '自主调度', value: control.scheduleEnabled ? '已启用' : '未启用', tone: control.scheduleEnabled ? 'ok' : 'muted' },
      { icon: 'user', name: '所有者通道', value: channelText(control.ownerChannel), tone: 'info' },
      { icon: 'inbox', name: '待审批', value: `${state.approvals.length} 条`, tone: state.approvals.length ? 'warn' : 'muted' },
    ];
    const list = h('div', { class: 'kv-list' });
    for (const row of rows) {
      list.appendChild(h('div', { class: 'kv-row' },
        h('span', { class: 'kv-name' }, icon(row.icon, 14), row.name),
        h('span', { class: 'kv-value' }, badge(row.value, row.tone, row.tone !== 'muted')),
      ));
    }
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        h('div', {}, h('h3', { class: 'card-title' }, icon('pause'), '控制状态'), h('p', { class: 'card-sub' }, '暂停 / 调度 / 所有者通道')),
        h('a', { class: 'card-link', href: '#/settings' }, '去设置', icon('arrow-right', 12)),
      ),
      h('div', { class: 'card-body tight' }, list),
    );
  }

  function buildDistributionCard() {
    const groups = groupCounts(state.tasks);
    const total = state.tasks.length;
    const activeGroups = TASK_GROUPS.map((group) => ({ ...group, count: groups[group.key] || 0 })).filter((group) => group.count > 0);
    const donut = h('div', { class: 'donut' },
      h('div', { class: 'donut-center' }, h('strong', {}, String(total)), h('span', {}, '任务')),
    );
    if (total > 0) {
      let accumulated = 0;
      const segments = [];
      for (const group of activeGroups) {
        const from = (accumulated / total) * 360;
        accumulated += group.count;
        const to = (accumulated / total) * 360;
        segments.push(`${group.color} ${from.toFixed(2)}deg ${to.toFixed(2)}deg`);
      }
      if (segments.length > 0) donut.style.background = `conic-gradient(from -90deg, ${segments.join(', ')})`;
    }
    const legend = h('div', { class: 'legend' });
    for (const group of TASK_GROUPS) {
      const count = groups[group.key] || 0;
      const percent = total > 0 ? (count / total) * 100 : 0;
      legend.appendChild(h('div', { class: 'legend-item' },
        h('div', { class: 'legend-top' },
          h('span', { class: 'legend-dot', style: { background: group.color } }),
          h('span', {}, group.label),
          h('span', { class: 'legend-count' }, String(count)),
        ),
        h('div', { class: 'legend-bar' }, h('i', { style: { width: `${percent}%`, background: group.color } })),
      ));
    }
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        h('div', {}, h('h3', { class: 'card-title' }, icon('trend'), '任务分布'), h('p', { class: 'card-sub' }, `共 ${total} 个任务 · 按状态聚合`)),
        h('a', { class: 'card-link', href: '#/tasks' }, '全部任务', icon('arrow-right', 12)),
      ),
      h('div', { class: 'card-body' }, h('div', { class: 'donut-wrap' }, donut, legend)),
    );
  }

  function buildRecentTasksCard() {
    const sorted = [...state.tasks]
      .filter((item) => item && item.task)
      .sort((a, b) => new Date(b.task.updatedAt || 0) - new Date(a.task.updatedAt || 0))
      .slice(0, 5);
    const body = h('div', { class: 'card-body tight' });
    if (sorted.length === 0) {
      body.appendChild(emptyState({
        iconName: 'layers',
        title: '还没有任务',
        text: '去创作页生成第一条草稿；通过审核后会自动进入待审批。',
        action: h('a', { class: 'btn btn-primary btn-sm', href: '#/compose' }, icon('spark', 14), '开始创作'),
      }));
    } else {
      const list = h('div', { class: 'list' });
      for (const item of sorted) {
        const task = item.task;
        const topic = (item.idea && item.idea.topic) || (item.draft && textSnippet(item.draft.text, 40)) || '未命名任务';
        list.appendChild(h('a', { class: 'task-row', href: `#/tasks/${encodeURIComponent(task.taskId)}` },
          stateBadge(task.state),
          h('div', { class: 'task-main' },
            h('div', { class: 'task-topic', title: topic }, topic),
            h('div', { class: 'task-sub' },
              h('span', { class: 'mono' }, shortId(task.taskId, 14)),
              h('span', {}, item.draft ? `v${item.draft.version} · ${textSnippet(item.draft.tone, 24)}` : '暂无草稿'),
            ),
          ),
          h('span', { class: 'task-time', title: fmtDateTime(task.updatedAt) }, fmtRelative(task.updatedAt)),
        ));
      }
      body.appendChild(list);
    }
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        h('div', {}, h('h3', { class: 'card-title' }, icon('layers'), '最近任务'), h('p', { class: 'card-sub' }, '按最近更新时间排序')),
        h('a', { class: 'card-link', href: '#/tasks' }, '查看全部', icon('arrow-right', 12)),
      ),
      body,
    );
  }

  function buildReminderCard() {
    const pending = [...state.approvals].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    const first = pending[0];
    if (!first) {
      return h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('div', {}, h('h3', { class: 'card-title' }, icon('inbox'), '待审批提醒'))),
        h('div', { class: 'card-body' }, emptyState({
          iconName: 'shield',
          title: '所有内容都已处理',
          text: '当前没有待审批内容。新草稿通过审核后，会在这里提醒你核对。',
        })),
      );
    }
    const summary = taskById(first.taskId);
    const text = (summary && summary.draft && summary.draft.text) || '';
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        h('div', {}, h('h3', { class: 'card-title' }, icon('inbox'), '待审批提醒'), h('p', { class: 'card-sub' }, `还有 ${pending.length} 条内容等待核对`)),
      ),
      h('div', { class: 'card-body' },
        h('div', { class: 'reminder' },
          h('div', { class: 'reminder-top' },
            h('div', { class: 'reminder-icon' }, icon('alert', 18)),
            h('div', { style: { minWidth: '0' } },
              h('h4', { class: 'reminder-title' }, '有一条内容已锁定，等待你批准'),
              h('p', { class: 'reminder-text' }, textSnippet(text, 96) || `审批 ${shortId(first.approvalId, 14)} 等待处理`),
            ),
          ),
          h('div', { class: 'reminder-meta' },
            h('span', { class: 'mono' }, shortId(first.approvalId, 16)),
            h('span', {}, '剩余'),
            countdownNode(first.expiresAt),
          ),
          h('div', { class: 'reminder-actions' },
            h('a', { class: 'btn btn-primary btn-sm', href: '#/approvals' }, icon('inbox', 14), '查看并核对'),
            h('a', { class: 'btn btn-ghost btn-sm', href: `#/tasks/${encodeURIComponent(first.taskId)}` }, '任务详情'),
          ),
        ),
      ),
    );
  }

  /* ==========================================================================
   * 10. 创作页
   * ======================================================================== */
  const CREATE_STEPS = [
    { name: '选题', desc: '读取主题、来源与创作动机，判断是否值得表达' },
    { name: '文案', desc: '按人格设定生成草稿；可选配图任务等待人工回传' },
    { name: '审核', desc: '隐私、来源与语气的模型复核' },
    { name: '申请审批', desc: '通过后创建一次性审批并锁定内容哈希' },
  ];

  function clearCreateTimers() {
    for (const timer of state.create.timers) window.clearTimeout(timer);
    state.create.timers = [];
  }

  async function renderCreate(token) {
    if (token !== renderSeq) return;
    const page = $('#page');
    const root = h('div', { class: 'page' });
    const layout = h('div', { class: 'create-layout' });
    layout.appendChild(buildCreateFormCard());
    layout.appendChild(buildCreateSideCard());
    root.appendChild(layout);
    const resultSlot = h('div', { id: 'create-result' });
    root.appendChild(resultSlot);
    page.replaceChildren(root);
    renderCreateResult();
    if (state.create.running) scheduleCreateStageTimers();
  }

  function buildCreateFormCard() {
    const form = state.create.form;
    const formCard = h('section', { class: 'card' });
    const head = h('div', { class: 'card-head' },
      h('div', {},
        h('h3', { class: 'card-title' }, icon('spark'), '创作指令'),
        h('p', { class: 'card-sub' }, '留空的字段由模型自行判断；事实性主题必须提供可核对来源。'),
      ),
      badge('一键工作流', 'primary', false),
    );

    const topic = h('input', { class: 'input', type: 'text', id: 'create-topic', maxlength: '120', placeholder: '例如：第一次用自己的账号发朋友圈', value: form.topic });
    topic.addEventListener('input', () => { form.topic = topic.value; });
    const sourceType = h('select', { class: 'select', id: 'create-source' });
    for (const option of SOURCE_TYPE_OPTIONS) {
      const item = h('option', { value: option.value }, option.label);
      if (form.sourceType === option.value) item.selected = true;
      sourceType.appendChild(item);
    }
    sourceType.addEventListener('change', () => { form.sourceType = sourceType.value; });
    const evidence = h('textarea', { class: 'textarea', id: 'create-evidence', maxlength: '2000', placeholder: '例如：本机 DSH Moments Agent 实机验证记录；或文章 / 新闻链接与标题', value: form.sourceEvidence });
    evidence.addEventListener('input', () => { form.sourceEvidence = evidence.value; });
    const motivation = h('textarea', { class: 'textarea', id: 'create-motivation', rows: '2', maxlength: '400', placeholder: '例如：记录一次人机协作的边界观察', value: form.motivation });
    motivation.addEventListener('input', () => { form.motivation = motivation.value; });
    const imagePrompt = h('textarea', { class: 'textarea', rows: '2', maxlength: '2000', placeholder: '可选：配图描述。填写后会等待图片回传，再申请审批。', 'aria-label': '配图描述', value: form.imagePrompt || '' });
    imagePrompt.addEventListener('input', () => { form.imagePrompt = imagePrompt.value; });

    const submitBtn = h('button', { class: 'btn btn-primary btn-lg', type: 'button', id: 'create-submit' },
      state.create.running ? h('span', { class: 'spinner' }) : icon('sparkles', 17),
      state.create.running ? '正在生成…' : '生成草稿并提交审批',
    );
    submitBtn.disabled = state.create.running;
    submitBtn.addEventListener('click', submitCreate);

    formCard.appendChild(head);
    formCard.appendChild(h('div', { class: 'card-body' },
      h('div', { class: 'field' },
        h('label', { class: 'field-label', for: 'create-topic' }, h('span', {}, '主题'), h('span', { class: 'field-hint' }, '可留空')),
        topic,
      ),
      h('div', { class: 'field' },
        h('label', { class: 'field-label', for: 'create-source' }, h('span', {}, '来源类型'), h('span', { class: 'field-hint' }, '决定内容的表达方式')),
        h('div', { class: 'select-wrap' }, sourceType),
      ),
      h('div', { class: 'field' },
        h('label', { class: 'field-label', for: 'create-evidence' }, h('span', {}, '来源依据'), h('span', { class: 'field-hint' }, '事实性内容必须给')),
        evidence,
      ),
      h('div', { class: 'field' },
        h('label', { class: 'field-label', for: 'create-motivation' }, h('span', {}, '创作动机'), h('span', { class: 'field-hint' }, '为什么值得说')),
        motivation,
      ),
      h('div', { class: 'field' }, h('label', { class: 'field-label' }, '配图描述（可选）'), imagePrompt),
      h('div', { class: 'form-footer' },
        h('p', { class: 'form-note' }, '生成会调用一次模型（通常 10–60 秒）。流程只创建草稿并提交审批，不会准备或发表；配图需要单独处理。'),
        submitBtn,
      ),
    ));
    return formCard;
  }

  function buildCreateSideCard() {
    const stepsHost = h('div', { class: 'steps', id: 'create-steps' });
    updateCreateSteps(stepsHost);
    const statusHost = h('div', { id: 'create-status' });
    updateCreateSideStatus(statusHost);
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        h('div', {}, h('h3', { class: 'card-title' }, icon('terminal'), '工作流进度'), h('p', { class: 'card-sub' }, '选题 → 文案 → 审核 → 申请审批')),
      ),
      h('div', { class: 'card-body' }, stepsHost, statusHost),
    );
  }

  function createStepStates() {
    const info = state.create;
    if (info.running) {
      return CREATE_STEPS.map((_, index) => (index < info.stage ? 'done' : index === info.stage ? 'active' : 'idle'));
    }
    if (info.error) {
      return CREATE_STEPS.map((_, index) => (index < info.stage ? 'done' : index === info.stage ? 'fail' : 'idle'));
    }
    const result = info.result;
    if (!result) return CREATE_STEPS.map(() => 'idle');
    if (result.silent) return CREATE_STEPS.map((_, index) => (index === 0 ? 'done' : 'idle'));
    if (result.imagePending) return ['done', 'active', 'idle', 'idle'];
    const reviewPassed = result.review && result.review.passed;
    if (!reviewPassed) {
      return CREATE_STEPS.map((_, index) => (index < 2 ? 'done' : index === 2 ? 'fail' : 'idle'));
    }
    return CREATE_STEPS.map(() => 'done');
  }

  function updateCreateSteps(host) {
    if (!host) return;
    const states = createStepStates();
    host.replaceChildren();
    CREATE_STEPS.forEach((step, index) => {
      const stepState = states[index];
      const dotContent = stepState === 'done' ? icon('check', 13)
        : stepState === 'fail' ? icon('x', 13)
          : stepState === 'active' ? icon('spark', 13)
            : String(index + 1);
      host.appendChild(h('div', { class: `step ${stepState === 'idle' ? '' : stepState}` },
        h('div', { class: 'step-dot' }, dotContent),
        h('div', {},
          h('p', { class: 'step-name' }, step.name),
          h('p', { class: 'step-desc' }, step.desc),
        ),
      ));
    });
  }

  function updateCreateSideStatus(host) {
    if (!host) return;
    const info = state.create;
    host.replaceChildren();
    if (info.running) {
      const seconds = Math.max(0, Math.floor((Date.now() - info.startedAt) / 1000));
      host.appendChild(h('div', { class: 'notice', style: { marginTop: '16px' } },
        icon('info', 15),
        h('span', {}, `正在执行一键工作流，已用时 ${seconds} 秒。模型调用可能需要 10–60 秒，请勿关闭页面；不会执行任何发表操作。`),
      ));
    } else if (info.error) {
      host.appendChild(h('div', { class: 'notice danger', style: { marginTop: '16px' } },
        icon('alert', 15),
        h('span', {}, '工作流失败，结果区会展示后端返回的原始错误码与说明。'),
      ));
    } else if (info.result && info.result.silent) {
      host.appendChild(h('div', { class: 'notice warn', style: { marginTop: '16px' } },
        icon('info', 15),
        h('span', {}, '模型判断这次没有值得表达的内容，选择沉默，没有创建任务。'),
      ));
    } else if (info.result) {
      host.appendChild(h('div', { class: 'notice', style: { marginTop: '16px' } },
        icon('check', 15),
        h('span', {}, '工作流已返回结果。草稿与审批信息见下方结果卡；批准需要你到待审批页手动确认。'),
      ));
    } else {
      host.appendChild(h('div', { class: 'notice', style: { marginTop: '16px' } },
        icon('info', 15),
        h('span', {}, '点击左侧按钮后开始。整个流程只做「写 + 审 + 申请审批」，不会准备朋友圈界面，更不会发表。'),
      ));
    }
  }

  function refreshCreatePanels() {
    const stepsHost = $('#create-steps');
    const statusHost = $('#create-status');
    if (stepsHost) updateCreateSteps(stepsHost);
    if (statusHost) updateCreateSideStatus(statusHost);
    const submitBtn = $('#create-submit');
    if (submitBtn) {
      submitBtn.disabled = state.create.running;
      submitBtn.replaceChildren(
        state.create.running ? h('span', { class: 'spinner' }) : icon('sparkles', 17),
        state.create.running ? '正在生成…' : '生成草稿并提交审批',
      );
    }
    renderCreateResult();
  }

  function scheduleCreateStageTimers() {
    clearCreateTimers();
    const advance = (stage, delay) => {
      const timer = window.setTimeout(() => {
        if (!state.create.running) return;
        state.create.stage = Math.max(state.create.stage, stage);
        refreshCreatePanels();
      }, delay);
      state.create.timers.push(timer);
    };
    advance(1, 6000);
    advance(2, 18000);
    advance(3, 40000);
  }

  async function submitCreate() {
    if (state.create.running) return;
    state.create.running = true;
    state.create.stage = 0;
    state.create.startedAt = Date.now();
    state.create.result = null;
    state.create.error = null;
    refreshCreatePanels();
    scheduleCreateStageTimers();
    const form = state.create.form;
    const input = {};
    if (form.topic.trim()) input.topic = form.topic.trim();
    if (form.sourceType) input.sourceType = form.sourceType;
    if (form.sourceEvidence.trim()) input.sourceEvidence = form.sourceEvidence.trim();
    if (form.motivation.trim()) input.motivation = form.motivation.trim();
    if (form.imagePrompt?.trim()) input.imagePrompt = form.imagePrompt.trim();
    try {
      const result = await api.workflowDraft(input);
      state.create.result = result || { silent: true, reason: '后端没有返回结果' };
      state.create.running = false;
      state.create.stage = 3;
      clearCreateTimers();
      refreshCreatePanels();
      if (state.create.result.silent) {
        toast('模型选择沉默', state.create.result.reason || '这次没有值得表达的内容。', 'info');
      } else if (state.create.result.imagePending) {
        toast('等待配图回传', `将图片放入 data/imports/${state.create.result.image.imageTask.imageTaskId}/ 后自动继续审核。`, 'info');
      } else if (state.create.result.review && state.create.result.review.passed) {
        toast('草稿已生成并提交审批', '请到待审批页逐条核对正文与内容哈希。', 'success');
      } else {
        toast('草稿已生成，但审核未通过', '请查看审核说明，并按需重写。', 'warn');
      }
      await loadCore();
      if (currentRoute && currentRoute.name === 'compose') refreshCreatePanels();
    } catch (error) {
      state.create.running = false;
      state.create.error = error;
      clearCreateTimers();
      refreshCreatePanels();
      const info = describeError(error);
      toast('生成未完成', `${info.title}：${info.detail}${info.code ? `（${info.code}）` : ''}`, 'error');
    }
  }

  function renderCreateResult() {
    const slot = $('#create-result');
    if (!slot) return;
    slot.replaceChildren();
    const info = state.create;
    if (info.running) {
      slot.appendChild(h('section', { class: 'card result-card' },
        h('div', { class: 'card-head' },
          h('div', {}, h('h3', { class: 'card-title' }, icon('spark'), '正在生成草稿'), h('p', { class: 'card-sub' }, '模型返回前会显示骨架占位，不会假装成功')),
        ),
        h('div', { class: 'card-body' },
          h('div', { class: 'skeleton sk-line w40 lg' }),
          h('div', { class: 'skeleton sk-line w80' }),
          h('div', { class: 'skeleton sk-line w60' }),
          h('div', { class: 'skeleton sk-block', style: { marginTop: '16px' } }),
          h('div', { class: 'skeleton sk-line w80' }),
          h('div', { class: 'skeleton sk-line w60' }),
          h('div', { class: 'skeleton sk-line w40' }),
        ),
      ));
      return;
    }
    if (info.error) {
      slot.appendChild(buildErrorCard(info.error, { onRetry: submitCreate, retryLabel: '重试一键创作' }));
      return;
    }
    const result = info.result;
    if (!result) return;
    if (result.silent) {
      slot.appendChild(h('section', { class: 'card' },
        h('div', { class: 'card-head' },
          h('div', {}, h('h3', { class: 'card-title' }, icon('info'), '这次选择沉默'), h('p', { class: 'card-sub' }, '模型判断没有值得表达的内容，未创建任务')),
        ),
        h('div', { class: 'card-body' },
          h('div', { class: 'warning-box' }, icon('info'), h('span', {}, result.reason || '没有给出原因。')),
          h('div', { class: 'result-actions' },
            h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => { state.create.result = null; refreshCreatePanels(); } }, icon('refresh'), '重新填写'),
          ),
        ),
      ));
      return;
    }
    const detail = result.detail || null;
    const task = (detail && detail.task) || null;
    const draft = (detail && detail.draft) || null;
    const review = result.review || {};
    const approvalWrapper = result.approval || null;
    const approval = (approvalWrapper && approvalWrapper.approval) || (detail && detail.approval) || null;
    const passed = Boolean(review.passed);

    const card = h('section', { class: 'card result-card' });
    card.appendChild(h('div', { class: 'card-head' },
      h('div', {},
        h('h3', { class: 'card-title' }, icon(passed ? 'check' : 'alert'), passed ? '草稿已生成并提交审批' : '草稿已生成，但审核未通过'),
        h('p', { class: 'card-sub' }, passed
          ? '内容已锁定为一次性审批；批准后改写任何字段都会让审批失效。'
          : '审核说明见下方；可以到任务详情里重写并重新审核。'),
      ),
      h('div', { class: 'result-status' },
        task ? stateBadge(task.state) : null,
        passed ? badge('审核通过', 'ok') : badge('审核未通过', 'warn'),
      ),
    ));

    const body = h('div', { class: 'card-body' });
    if (draft && draft.text) {
      body.appendChild(h('div', { class: 'draft-box' },
        h('div', { class: 'draft-box-head' },
          h('span', {}, `v${draft.version || 1}`),
          h('span', {}, '语气：'),
          h('span', {}, draft.tone || '未指定'),
          h('span', { class: 'task-time' }, fmtRelative(draft.updatedAt || draft.createdAt)),
        ),
        h('p', { class: 'content-body' }, draft.text),
      ));
      body.appendChild(h('div', { class: 'result-meta' },
        h('span', { class: 'badge badge-muted' }, `${String(draft.text).length} 字`),
        h('span', { class: 'badge badge-muted' }, `任务 ${shortId(task && task.taskId, 14)}`),
      ));
    }
    if (Array.isArray(review.notes) && review.notes.length > 0) {
      const notes = h('div', { class: 'review-notes' });
      for (const note of review.notes) {
        notes.appendChild(h('div', { class: `review-note${passed ? '' : ' warn'}` }, icon(passed ? 'check' : 'alert', 14), h('span', {}, String(note))));
      }
      body.appendChild(notes);
    }
    if (Array.isArray(review.flags) && review.flags.length > 0) {
      body.appendChild(h('div', { class: 'warning-box', style: { marginTop: '12px' } }, icon('alert'), h('span', {}, `风险标记：${review.flags.map(String).join('、')}`)));
    }
    if (approval) {
      body.appendChild(h('div', { class: 'approval-summary' },
        h('div', { class: 'summary-tile' }, h('div', { class: 'summary-key' }, '审批 ID'), h('div', { class: 'summary-val mono' }, approval.approvalId || '—')),
        h('div', { class: 'summary-tile' }, h('div', { class: 'summary-key' }, '过期倒计时'), h('div', { class: 'summary-val' }, countdownNode(approval.expiresAt))),
        h('div', { class: 'summary-tile' }, h('div', { class: 'summary-key' }, '可见范围'), h('div', { class: 'summary-val' }, visibilityText(approval.visibility))),
        h('div', { class: 'summary-tile' }, h('div', { class: 'summary-key' }, '内容哈希（前 16 位）'), h('div', { class: 'summary-val mono' }, shortHash(approval.contentHash, 16))),
      ));
      body.appendChild(h('div', { style: { marginTop: '14px' } }, hashBlock('内容哈希 · SHA-256（完整）', approval.contentHash)));
    }
    const actions = h('div', { class: 'result-actions' });
    if (draft && draft.text) {
      actions.appendChild(copyButton(() => draft.text, { label: '复制全文', size: 'md' }));
    }
    if (approval) {
      actions.appendChild(h('a', { class: 'btn btn-primary btn-sm', href: `#/approvals/${encodeURIComponent(approval.approvalId)}` }, icon('inbox', 14), '前往待审批'));
    }
    if (task) {
      actions.appendChild(h('a', { class: 'btn btn-outline btn-sm', href: `#/tasks/${encodeURIComponent(task.taskId)}` }, icon('arrow-right', 14), '查看任务'));
    }
    actions.appendChild(h('button', {
      class: 'btn btn-ghost btn-sm',
      type: 'button',
      onclick: () => {
        state.create.result = null;
        state.create.stage = 0;
        refreshCreatePanels();
      },
    }, icon('sparkles', 14), '再生成一次'));
    if (actions.childElementCount > 0) body.appendChild(actions);
    card.appendChild(body);
    slot.appendChild(card);
  }

  /* ==========================================================================
   * 11. 待审批页
   * ======================================================================== */
  let approvalsUI = null;

  async function renderApprovals(token) {
    const page = $('#page');
    const hadContent = page.childElementCount > 0;
    if (!hadContent) page.appendChild(pageSkeleton());
    const { errors, failed, allFailed } = await loadCore();
    if (token !== renderSeq) return;
    if (allFailed) {
      page.replaceChildren(h('div', { class: 'page' }, buildErrorCard(errors[0], { onRetry: () => refreshCurrent(true), retryLabel: '重新连接' })));
      return;
    }
    const routeApprovalId = routeParam(state.route, 0);
    const approvals = [...state.approvals].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    if (routeApprovalId && approvalById(routeApprovalId) && state.approvalSel !== routeApprovalId) {
      state.approvalSel = routeApprovalId;
    }
    if (!state.approvalSel || !approvalById(state.approvalSel)) {
      state.approvalSel = approvals.length > 0 ? approvals[0].approvalId : null;
    }

    const root = h('div', { class: 'page' });
    if (errors.length > 0) {
      const notice = buildFailureNotice(errors);
      if (notice) root.appendChild(notice);
    }
    root.appendChild(h('div', { class: 'toolbar' },
      h('div', { class: 'chips' },
        badge(`${approvals.length} 条待审批`, approvals.length ? 'warn' : 'ok'),
        h('span', { class: 'toolbar-hint' }, '批准会把当前正文、图片、可见范围与目标账号一起锁定；任何改写都会让审批失效。'),
      ),
      h('span', { class: 'toolbar-hint' }, '每 15 秒自动刷新 · 页面隐藏时暂停'),
    ));

    const layout = h('div', { class: 'approvals-layout' });
    const listCard = h('section', { class: 'card' });
    listCard.appendChild(h('div', { class: 'card-head' },
      h('div', {}, h('h3', { class: 'card-title' }, icon('inbox'), '审批队列'), h('p', { class: 'card-sub' }, '按创建时间倒序')),
      approvals.length ? h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => refreshCurrent(true) }, icon('refresh', 14), '刷新') : null,
    ));
    const listHost = h('div', { class: 'approval-list' });
    if (failed.approvals && approvals.length === 0) {
      listHost.appendChild(buildErrorCard(errors.find((item) => isConnError(item)) || errors[0], { onRetry: () => refreshCurrent(true) }));
    } else if (approvals.length === 0) {
      listHost.appendChild(emptyState({
        iconName: 'shield',
        title: '没有待审批内容',
        text: '新草稿通过审核后会自动出现在这里；也可以去创作页生成一条新的候选内容。',
        action: h('a', { class: 'btn btn-primary btn-sm', href: '#/compose' }, icon('spark', 14), '去创作'),
      }));
    } else {
      for (const approval of approvals) listHost.appendChild(buildApprovalListItem(approval));
    }
    listCard.appendChild(listHost);
    layout.appendChild(listCard);

    const detailHost = h('div', { id: 'approval-detail' });
    layout.appendChild(detailHost);
    root.appendChild(layout);
    page.replaceChildren(root);

    approvalsUI = { detailHost, approvals };
    const selected = state.approvalSel ? approvalById(state.approvalSel) : null;
    if (selected) await renderApprovalDetail(detailHost, selected);
    else detailHost.appendChild(h('section', { class: 'card' }, h('div', { class: 'card-body' }, emptyState({ iconName: 'inbox', title: '选择一条审批', text: '左侧列表会展示待审批的正文摘要、哈希前缀与过期倒计时。' }))));
  }

  function buildApprovalListItem(approval) {
    const summary = taskById(approval.taskId);
    const text = (summary && summary.draft && summary.draft.text) || '';
    const selected = state.approvalSel === approval.approvalId;
    const item = h('button', {
      class: `approval-item${selected ? ' selected' : ''}`,
      type: 'button',
      'aria-pressed': selected ? 'true' : 'false',
    },
      h('div', { class: 'approval-item-top' },
        approvalStatusBadge(approval.status),
        h('span', { class: 'approval-item-id', title: approval.approvalId }, shortId(approval.approvalId, 16)),
      ),
      h('p', { class: 'approval-snippet' }, textSnippet(text, 76) || '（没有可读取的正文摘要）'),
      h('div', { class: 'approval-item-meta' },
        h('span', { class: 'mono', title: approval.contentHash }, `哈希 ${shortHash(approval.contentHash, 16)}`),
        countdownNode(approval.expiresAt),
      ),
    );
    item.addEventListener('click', () => selectApproval(approval.approvalId));
    return item;
  }

  function selectApproval(approvalId) {
    if (!approvalsUI) return;
    state.approvalSel = approvalId;
    const approval = approvalById(approvalId);
    document.querySelectorAll('.approval-item').forEach((node) => {
      const idNode = node.querySelector('.approval-item-id');
      const isSelected = Boolean(idNode && idNode.getAttribute('title') === approvalId);
      node.classList.toggle('selected', isSelected);
      node.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
    });
    try { history.replaceState(null, '', `#/approvals/${encodeURIComponent(approvalId)}`); } catch { /* 忽略 */ }
    approvalsUI.detailHost.replaceChildren(h('section', { class: 'card' }, h('div', { class: 'card-body' }, h('div', { class: 'skeleton sk-line w40 lg' }), h('div', { class: 'skeleton sk-block' }))));
    if (approval) renderApprovalDetail(approvalsUI.detailHost, approval);
  }

  async function renderApprovalDetail(host, approval) {
    const requestedId = approval.approvalId;
    let preview = null;
    let previewError = null;
    try {
      preview = await api.preview(approval.taskId);
    } catch (error) {
      previewError = error;
    }
    if (state.approvalSel !== requestedId || !host.isConnected) return;
    host.replaceChildren();
    if (previewError) {
      host.appendChild(buildErrorCard(previewError, { onRetry: () => { if (approvalsUI && approvalsUI.detailHost) renderApprovalDetail(approvalsUI.detailHost, approval); } }));
      return;
    }
    host.appendChild(buildApprovalDetail(approval, preview || {}));
  }

  function buildApprovalDetail(approval, preview) {
    const isPending = approval.status === 'pending';
    const text = preview.text || '';
    const assets = Array.isArray(preview.assets) ? preview.assets : [];
    const card = h('section', { class: 'card approval-detail-card' });

    card.appendChild(h('div', { class: 'detail-head' },
      h('div', { class: 'detail-heading' },
        h('div', { class: 'result-status' }, approvalStatusBadge(approval.status), badge('内容已锁定', 'primary', false)),
        h('h2', { class: 'detail-title' }, textSnippet(text, 46) || '待批准内容'),
        h('div', { class: 'detail-sub' },
          h('span', { class: 'mono' }, shortId(approval.approvalId, 20)),
          h('span', {}, `任务 ${shortId(approval.taskId, 16)}`),
          h('span', {}, `创建于 ${fmtRelative(approval.createdAt)}`),
        ),
      ),
    ));

    const bodySection = h('div', { class: 'detail-section' });
    bodySection.appendChild(h('h4', { class: 'section-title' }, icon('spark', 14), '正文预览'));
    if (text) bodySection.appendChild(h('p', { class: 'content-body' }, text));
    else bodySection.appendChild(h('div', { class: 'notice warn' }, icon('alert', 15), h('span', {}, '预览没有返回正文；请到任务详情确认内容，避免在缺少正文时批准。')));
    card.appendChild(bodySection);

    const assetsSection = h('div', { class: 'detail-section' });
    assetsSection.appendChild(h('h3', { class: 'section-title' }, icon('image', 14), `素材（${assets.length}）`));
    if (assets.length === 0) {
      assetsSection.appendChild(h('p', { class: 'card-sub' }, '本条内容没有配图，发表时会只发文字。'));
    } else {
      assetsSection.appendChild(buildAssetGrid(assets));
    }
    card.appendChild(assetsSection);

    const hashSection = h('div', { class: 'detail-section' });
    hashSection.appendChild(h('h3', { class: 'section-title' }, icon('hash', 14), '内容指纹'));
    hashSection.appendChild(hashBlock('内容哈希 · SHA-256（完整，批准即锁定）', preview.contentHash || approval.contentHash));
    hashSection.appendChild(h('div', { style: { marginTop: '12px' } }, hashBlock('素材清单哈希', preview.assetManifestHash || approval.assetManifestHash)));
    card.appendChild(hashSection);

    const metaSection = h('div', { class: 'detail-section' });
    metaSection.appendChild(h('h3', { class: 'section-title' }, icon('info', 14), '审计信息'));
    metaSection.appendChild(h('div', { class: 'meta-grid' },
      metaItem('可见范围', `${visibilityText(preview.visibility || approval.visibility)} · ${preview.visibility || approval.visibility || '—'}`),
      metaItem('目标账号', preview.accountId || approval.accountId || '—', true),
      metaItem('审批渠道', channelText(approval.channel)),
      metaItem('审批 ID', approval.approvalId || '—', true),
      metaItem('创建时间', `${fmtDateTime(approval.createdAt)}（${fmtRelative(approval.createdAt)}）`),
      metaItemNode('过期时间', h('span', {}, `${fmtDateTime(approval.expiresAt)} · 剩余 `, countdownNode(approval.expiresAt))),
      metaItem('审批状态', APPROVAL_STATUS_ZH[approval.status] || approval.status || '—'),
      metaItem('决策时间', approval.decidedAt ? fmtDateTime(approval.decidedAt) : '尚未决策'),
    ));
    card.appendChild(metaSection);

    const actions = h('div', { class: 'detail-actions' });
    actions.appendChild(h('p', { class: 'detail-actions-hint' },
      isPending
        ? '批准会锁定当前正文、图片、可见范围与目标账号；任何改写都会使审批失效。'
        : '该审批已不再是 pending 状态，不能再批准或拒绝，请刷新列表。',
    ));
    const buttons = h('div', { class: 'detail-actions-buttons' });
    if (isPending) {
      const rejectBtn = h('button', { class: 'btn btn-danger btn-lg', type: 'button' }, icon('x', 16), '拒绝');
      rejectBtn.addEventListener('click', () => openRejectModal(approval));
      const approveBtn = h('button', { class: 'btn btn-primary btn-lg', type: 'button' }, icon('shield', 17), '批准并锁定');
      approveBtn.addEventListener('click', () => openApproveModal(approval, preview));
      buttons.append(rejectBtn, approveBtn);
    } else {
      buttons.appendChild(h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => refreshCurrent(true) }, icon('refresh', 14), '刷新状态'));
    }
    actions.appendChild(buttons);
    card.appendChild(actions);
    return card;
  }

  function metaItem(key, value, mono = false) {
    return h('div', { class: 'meta-item' }, h('span', { class: 'meta-key' }, key), h('span', { class: `meta-val${mono ? ' mono' : ''}` }, value));
  }

  function metaItemNode(key, valueNode) {
    return h('div', { class: 'meta-item' }, h('span', { class: 'meta-key' }, key), h('span', { class: 'meta-val' }, valueNode));
  }

  function buildAssetGrid(assets) {
    const grid = h('div', { class: 'asset-grid' });
    for (const asset of assets) {
      const assetId = asset.assetId || '';
      const img = h('img', {
        src: `/proxy/api/assets/${encodeURIComponent(assetId)}/raw`,
        alt: '朋友圈配图素材',
        loading: 'lazy',
        referrerpolicy: 'no-referrer',
      });
      const fallback = h('div', { class: 'asset-fallback', style: { display: 'none' } }, icon('image', 22), h('span', {}, '素材不可预览'));
      img.addEventListener('error', () => { img.style.display = 'none'; fallback.style.display = 'grid'; });
      grid.appendChild(h('div', { class: 'asset-tile' }, img, fallback));
    }
    return grid;
  }

  function openApproveModal(approval, preview) {
    const contentHash = (preview && preview.contentHash) || approval.contentHash || '';
    const modalContent = [
      modalSection('审批摘要',
        h('div', { class: 'modal-rows' },
          modalRow('任务', h('span', { class: 'mono' }, shortId(approval.taskId, 22))),
          modalRow('可见范围', visibilityText(preview.visibility || approval.visibility)),
          modalRow('目标账号', h('span', { class: 'mono' }, approval.accountId || '—')),
          modalRow('审批 ID', h('span', { class: 'mono' }, approval.approvalId)),
          modalRow('失效倒计时', countdownNode(approval.expiresAt)),
        ),
      ),
      modalSection('内容哈希 · SHA-256（完整）', hashBlock('', contentHash)),
      h('div', { class: 'modal-warning' }, icon('alert', 14),
        h('span', {}, '批准后，改写正文、更换图片、修改可见范围或目标账号中的任意一项，都会使本次批准失效，需要重新申请审批。'),
      ),
    ];
    openModal({
      title: '批准这条朋友圈内容？',
      subtitle: '批准会把任务推进到 APPROVED，并把当前内容哈希锁定为发表依据。',
      iconName: 'shield',
      content: modalContent,
      confirmText: '确认批准',
      confirmIcon: 'shield',
      requireCheckText: '我已核对正文、图片与可见范围，确认批准。',
      footerNote: '批准会写入审计记录',
      onConfirm: async () => api.approve(approval.approvalId, '所有者在本机客户端核对后批准'),
      after: () => {
        toast('已批准', '任务已进入 APPROVED；本次批准已锁定当前内容。', 'success');
        refreshCurrent(true);
      },
    });
  }

  function openRejectModal(approval) {
    const reasonInput = h('textarea', { class: 'textarea modal-textarea', maxlength: '300', placeholder: '例如：这条太像广告 / 语气不像我 / 事实依据不足（可选）' });
    const modalContent = [
      h('div', { class: 'modal-warning danger' }, icon('alert', 14),
        h('span', {}, '拒绝会作废本次审批，并把任务推进到 CANCELLED。已经锁定的内容不会被发表。'),
      ),
      modalSection('拒绝原因（可选，写入审计）', reasonInput),
    ];
    openModal({
      title: '拒绝这条内容？',
      subtitle: `审批 ${shortId(approval.approvalId, 18)} 将被作废，任务进入已取消。`,
      iconName: 'x',
      danger: true,
      content: modalContent,
      confirmText: '确认拒绝',
      onConfirm: async () => api.reject(approval.approvalId, reasonInput.value.trim()),
      after: () => {
        toast('已拒绝', '审批已作废，任务已取消。', 'success');
        refreshCurrent(true);
      },
    });
  }

  /* ==========================================================================
   * 12. 任务页
   * ======================================================================== */
  let tasksUI = null;

  const TASK_FILTERS = [
    { key: 'all', label: '全部', match: () => true },
    { key: 'approval', label: '待审批', match: (stateValue) => stateValue === 'READY_FOR_APPROVAL' },
    { key: 'approved', label: '已批准', match: (stateValue) => stateValue === 'APPROVED' },
    { key: 'prepared', label: '已准备', match: (stateValue) => ['PREPARED', 'PREPARING', 'QUEUED'].includes(stateValue) },
    { key: 'failed', label: '失败 / 异常', match: (stateValue) => ['FAILED', 'UNCERTAIN', 'EXPIRED'].includes(stateValue) },
    { key: 'published', label: '已发表', match: (stateValue) => stateValue === 'PUBLISHED' },
  ];

  async function renderTasks(token) {
    const page = $('#page');
    const hadContent = page.childElementCount > 0;
    if (!hadContent) page.appendChild(pageSkeleton());
    const { errors, failed, allFailed } = await loadCore();
    if (token !== renderSeq) return;
    if (allFailed) {
      page.replaceChildren(h('div', { class: 'page' }, buildErrorCard(errors[0], { onRetry: () => refreshCurrent(true), retryLabel: '重新连接' })));
      return;
    }
    const routeTaskId = routeParam(state.route, 0);
    if (routeTaskId) state.taskSel = routeTaskId;
    const tasks = [...state.tasks].filter((item) => item && item.task)
      .sort((a, b) => new Date(b.task.updatedAt || 0) - new Date(a.task.updatedAt || 0));
    const filter = TASK_FILTERS.find((item) => item.key === state.taskFilter) || TASK_FILTERS[0];
    const filtered = tasks.filter((item) => filter.match(item.task.state));
    if (!state.taskSel || !tasks.some((item) => item.task.taskId === state.taskSel)) {
      const preferred = filtered[0] || tasks[0];
      state.taskSel = preferred ? preferred.task.taskId : null;
    }

    const root = h('div', { class: 'page' });
    if (errors.length > 0) {
      const notice = buildFailureNotice(errors);
      if (notice) root.appendChild(notice);
    }
    const toolbar = h('div', { class: 'toolbar' });
    const chips = h('div', { class: 'chips' });
    for (const filterItem of TASK_FILTERS) {
      const count = tasks.filter((item) => filterItem.match(item.task.state)).length;
      const chip = h('button', { class: `chip${filterItem.key === state.taskFilter ? ' active' : ''}`, type: 'button' },
        filterItem.label,
        h('span', { class: 'chip-count' }, String(count)),
      );
      chip.addEventListener('click', () => {
        state.taskFilter = filterItem.key;
        renderTaskList();
        renderTaskToolbarCounts();
      });
      chips.appendChild(chip);
    }
    toolbar.append(chips, h('span', { class: 'toolbar-hint', id: 'task-toolbar-hint' }, ''));
    root.appendChild(toolbar);

    const layout = h('div', { class: 'tasks-layout' });
    const listCard = h('section', { class: 'card' });
    listCard.appendChild(h('div', { class: 'card-head' },
      h('div', {}, h('h3', { class: 'card-title' }, icon('layers'), '任务列表'), h('p', { class: 'card-sub', id: 'task-list-sub' }, '')),
      h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => refreshCurrent(true) }, icon('refresh', 14), '刷新'),
    ));
    const listHost = h('div', { class: 'task-list', id: 'task-list' });
    listCard.appendChild(listHost);
    layout.appendChild(listCard);

    const detailHost = h('div', { id: 'task-detail' });
    layout.appendChild(detailHost);
    root.appendChild(layout);
    page.replaceChildren(root);

    tasksUI = { listHost, detailHost, tasks, filtered };
    renderTaskList();
    renderTaskToolbarCounts();
    if (failed.tasks && tasks.length === 0) {
      tasksUI.listHost.replaceChildren(buildErrorCard(errors[0], { onRetry: () => refreshCurrent(true) }));
      detailHost.replaceChildren(buildErrorCard(errors[0], { onRetry: () => refreshCurrent(true) }));
      return;
    }
    if (state.taskSel) {
      try { history.replaceState(null, '', `#/tasks/${encodeURIComponent(state.taskSel)}`); } catch { /* 忽略 */ }
      await renderTaskDetail(detailHost, state.taskSel);
    } else {
      detailHost.appendChild(h('section', { class: 'card' }, h('div', { class: 'card-body' }, emptyState({
        iconName: 'layers',
        title: '还没有任务',
        text: '去创作页生成第一条草稿；生成后会在这里看到状态时间线。',
        action: h('a', { class: 'btn btn-primary btn-sm', href: '#/compose' }, icon('spark', 14), '去创作'),
      }))));
    }
  }

  function renderTaskList() {
    if (!tasksUI) return;
    const filter = TASK_FILTERS.find((item) => item.key === state.taskFilter) || TASK_FILTERS[0];
    const filtered = tasksUI.tasks.filter((item) => filter.match(item.task.state));
    tasksUI.filtered = filtered;
    const host = tasksUI.listHost;
    host.replaceChildren();
    if (filtered.length === 0) {
      host.appendChild(emptyState({ iconName: 'layers', title: '这个筛选下没有任务', text: '切换筛选条件，或去创作页生成一条新内容。' }));
      return;
    }
    for (const item of filtered) {
      const task = item.task;
      const topic = (item.idea && item.idea.topic) || (item.draft && textSnippet(item.draft.text, 40)) || '未命名任务';
      const selected = state.taskSel === task.taskId;
      const node = h('button', { class: `task-item${selected ? ' selected' : ''}`, type: 'button', 'aria-pressed': selected ? 'true' : 'false' },
        h('div', { class: 'task-item-top' },
          stateBadge(task.state),
          h('span', { class: 'task-item-sub', title: fmtDateTime(task.updatedAt) }, fmtRelative(task.updatedAt)),
        ),
        h('div', { class: 'task-item-title', title: topic }, topic),
        h('div', { class: 'task-item-sub' },
          h('span', { class: 'mono' }, shortId(task.taskId, 16)),
          h('span', {}, item.approval ? `审批 ${shortId(item.approval.approvalId, 10)}` : '无审批'),
        ),
      );
      node.addEventListener('click', () => selectTask(task.taskId));
      host.appendChild(node);
    }
  }

  function renderTaskToolbarCounts() {
    const hint = $('#task-toolbar-hint');
    if (hint) hint.textContent = `共 ${state.tasks.length} 个任务 · 每 15 秒自动刷新 · 页面隐藏时暂停`;
    const sub = $('#task-list-sub');
    if (sub) {
      const filter = TASK_FILTERS.find((item) => item.key === state.taskFilter) || TASK_FILTERS[0];
      sub.textContent = `${filter.label} · ${tasksUI ? tasksUI.filtered.length : 0} 个`;
    }
    document.querySelectorAll('.chip').forEach((chip, index) => {
      const filterItem = TASK_FILTERS[index];
      if (filterItem) chip.classList.toggle('active', filterItem.key === state.taskFilter);
    });
  }

  function selectTask(taskId) {
    state.taskSel = taskId;
    try { history.replaceState(null, '', `#/tasks/${encodeURIComponent(taskId)}`); } catch { /* 忽略 */ }
    document.querySelectorAll('.task-item').forEach((node) => {
      const active = node.querySelector('.task-item-sub .mono') && node.querySelector('.task-item-sub .mono').textContent === shortId(taskId, 16);
      node.classList.toggle('selected', Boolean(active));
      node.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    if (!tasksUI) return;
    tasksUI.detailHost.replaceChildren(h('section', { class: 'card' }, h('div', { class: 'card-body' },
      h('div', { class: 'skeleton sk-line w40 lg' }),
      h('div', { class: 'skeleton sk-block' }),
      h('div', { class: 'skeleton sk-block', style: { height: '180px' } }),
    )));
    renderTaskDetail(tasksUI.detailHost, taskId);
  }

  async function renderTaskDetail(host, taskId) {
    let detail = null;
    let detailError = null;
    try {
      detail = await api.task(taskId);
    } catch (error) {
      detailError = error;
    }
    if (state.taskSel !== taskId || !host.isConnected) return;
    host.replaceChildren();
    if (detailError) {
      host.appendChild(buildErrorCard(detailError, { onRetry: () => renderTaskDetail(host, taskId) }));
      return;
    }
    host.appendChild(buildTaskDetail(detail));
  }

  function buildTaskDetail(detail) {
    const task = detail.task || {};
    const idea = detail.idea || null;
    const draft = detail.draft || null;
    const approvals = Array.isArray(detail.approvals) ? detail.approvals : [];
    const attempts = Array.isArray(detail.attempts) ? detail.attempts : [];
    const imageTasks = Array.isArray(detail.imageTasks) ? detail.imageTasks : [];
    const assets = Array.isArray(detail.assets) && detail.assets.length > 0 ? detail.assets
      : (detail.preview && Array.isArray(detail.preview.assets) ? detail.preview.assets : []);
    const stateValue = task.state || '';
    const terminal = TERMINAL_STATES.has(stateValue);
    const publishMode = (state.status && state.status.control && state.status.control.publishMode)
      || (state.health && state.health.publishMode) || '';
    const latestAttempt = attempts.length > 0 ? attempts[attempts.length - 1] : null;

    const card = h('section', { class: 'card' });
    card.appendChild(h('div', { class: 'detail-head' },
      h('div', { class: 'detail-heading' },
        h('div', { class: 'result-status' }, stateBadge(stateValue), terminal ? badge('终态', 'muted', false) : null),
        h('h2', { class: 'detail-title' }, (idea && idea.topic) || (draft && textSnippet(draft.text, 46)) || '未命名任务'),
        h('div', { class: 'detail-sub' },
          h('span', { class: 'mono' }, task.taskId || '—'),
          h('span', {}, `创建 ${fmtDateTime(task.createdAt)}`),
          h('span', {}, `更新 ${fmtRelative(task.updatedAt)}`),
        ),
      ),
      h('div', { class: 'result-status' },
        approvals.some((approval) => approval.status === 'pending')
          ? h('a', { class: 'btn btn-outline btn-sm', href: '#/approvals' }, icon('inbox', 14), '去核对审批')
          : null,
      ),
    ));

    if (task.errorCode) {
      card.appendChild(h('div', { class: 'detail-section' },
        h('div', { class: 'warning-box danger' }, icon('alert', 15),
          h('div', {}, h('div', {}, `任务错误：${task.errorCode}`), h('div', { class: 'mono' }, task.errorMessage || '（无错误说明）')),
        ),
      ));
    }

    const actions = h('div', { class: 'action-bar', id: 'task-actions' });
    const actionDefs = buildTaskActionDefs({ stateValue, terminal, approvals, latestAttempt, publishMode });
    for (const def of actionDefs) {
      const btn = h('button', {
        class: `btn ${def.danger ? 'btn-danger' : def.tone === 'warn' ? 'btn-warn' : def.primary ? 'btn-primary' : 'btn-outline'} btn-sm`,
        type: 'button',
        title: def.enabled ? (def.title || '') : def.disabledReason,
        disabled: !def.enabled,
      }, icon(def.icon, 14), def.label);
      btn.addEventListener('click', def.run);
      // 原生 disabled 按钮在部分浏览器上不显示 title 提示，外包一层确保 tooltip 可见
      actions.appendChild(def.enabled ? btn : h('span', { class: 'btn-tip-wrap', title: def.disabledReason }, btn));
    }
    const note = h('span', { class: 'action-note' }, buildActionNote({ stateValue, publishMode, latestAttempt }));
    actions.appendChild(note);
    card.appendChild(actions);

    card.appendChild(buildTimelineSection(detail.audit || []));
    card.appendChild(buildIdeaSection(idea));
    card.appendChild(buildDraftSection(draft, detail.draftVersions || []));
    card.appendChild(buildAssetsSection(assets));
    card.appendChild(buildTaskApprovalsSection(approvals));
    card.appendChild(buildAttemptsSection(attempts));
    if (imageTasks.length > 0) card.appendChild(buildImageTasksSection(imageTasks));
    card.appendChild(buildTechnicalSection(task, detail.preview));
    return card;
  }

  function buildTaskActionDefs({ stateValue, terminal, latestAttempt, publishMode }) {
    const taskId = state.taskSel;
    const publishBlocked = publishMode !== 'APPROVAL_REQUIRED';
    const publishBlockedReason = publishMode === 'PREPARE_ONLY'
      ? '当前为 PREPARE_ONLY，仅准备图文，不点击发表'
      : publishMode
        ? `当前发布模式为 ${publishMode}，发表会被后端拒绝`
        : '发布模式未知，暂不启用发表';
    return [
      {
        label: '重写并审核', icon: 'spark', enabled: ['IDEA_CREATED', 'DRAFTING', 'DRAFT_READY', 'IMAGE_READY', 'READY_FOR_APPROVAL', 'APPROVED'].includes(stateValue),
        disabledReason: '仅创作和审批阶段可以重写；图片处理中或发布流程中的任务请先完成或取消',
        run: () => openComposeTaskModal(taskId),
      },
      {
        label: '只审核', icon: 'shield', enabled: !terminal && stateValue !== 'UNCERTAIN',
        disabledReason: terminal ? '终态任务不能再审核' : '结果不确定的任务不能审核',
        run: () => openReviewTaskModal(taskId),
      },
      {
        label: '申请审批', icon: 'inbox', enabled: stateValue === 'READY_FOR_APPROVAL',
        disabledReason: '仅待审批（READY_FOR_APPROVAL）任务可申请审批',
        run: () => openRequestApprovalModal(taskId),
      },
      {
        label: '准备（不发表）', icon: 'monitor', enabled: stateValue === 'APPROVED',
        disabledReason: '仅已批准（APPROVED）任务可准备朋友圈界面',
        run: () => openPrepareModal(taskId),
      },
      {
        // PREPARE_ONLY 下禁用「发表」，避免让人误以为可以真的发布；
        // openPublishModal 里的后端错误展示路径保持不变（APPROVAL_REQUIRED 等模式下仍会使用）。
        label: '发表', icon: 'send', enabled: Boolean(stateValue) && !publishBlocked,
        tone: 'warn',
        disabledReason: publishBlockedReason,
        run: () => openPublishModal(taskId),
      },
      {
        label: '取消', icon: 'x', enabled: !terminal && stateValue !== 'UNCERTAIN', danger: true,
        disabledReason: terminal ? '终态任务不可取消' : '结果不确定（UNCERTAIN）不可取消',
        run: () => openCancelModal(taskId),
      },
      {
        label: '核验', icon: 'check', enabled: Boolean(latestAttempt),
        disabledReason: '没有发布尝试可核验',
        run: () => openVerifyModal(taskId, latestAttempt),
      },
    ];
  }

  function buildActionNote({ stateValue, publishMode, latestAttempt }) {
    const parts = [`当前状态：${STATE_ZH[stateValue] || stateValue || '未知'}`];
    if (stateValue === 'READY_FOR_APPROVAL') parts.push('可申请审批；批准后才能准备朋友圈。');
    else if (stateValue === 'APPROVED') parts.push('已批准：可准备朋友圈（只填图文，不点击发表）。');
    else if (stateValue === 'PREPARED') parts.push('图文已准备，等待所有者授权发表。');
    if (publishMode === 'PREPARE_ONLY') parts.push('当前为 PREPARE_ONLY：发表已禁用，仅准备图文，不点击发表。');
    else if (publishMode && publishMode !== 'APPROVAL_REQUIRED') parts.push(`发布模式为 ${publishMode}：点击发表会被后端明确拒绝（PUBLISH_MODE_DISABLED），不会真的发表。`);
    if (latestAttempt && latestAttempt.state === 'UNCERTAIN') parts.push('最新尝试结果不确定：禁止重复发表，请先核验。');
    return parts.join(' ');
  }

  const AUDIT_TONE = {
    approval_approved: 'ok',
    approval_rejected: 'danger',
    approval_consumed: 'info',
    desktop_prepared: 'ok',
    publish_uncertain: 'warn',
    uncertain_resolved: 'info',
    autonomous_cycle_failed: 'danger',
    owner_command_failed: 'danger',
    draft_reviewed: 'info',
    approval_requested: 'info',
    idea_created: 'ok',
  };

  const AUDIT_ICON = {
    state_transition: 'arrow-right',
    idea_created: 'spark',
    idea_rejected: 'x',
    idea_silence: 'info',
    draft_reviewed: 'shield',
    approval_requested: 'inbox',
    approval_approved: 'check',
    approval_rejected: 'x',
    approval_consumed: 'check',
    desktop_prepared: 'monitor',
    publish_uncertain: 'alert',
    uncertain_resolved: 'info',
    autonomous_cycle_failed: 'alert',
    owner_command_failed: 'alert',
  };

  function auditTone(event) {
    const explicit = AUDIT_TONE[event.action];
    if (explicit) return explicit;
    if (event.action === 'state_transition') {
      if (event.nextState === 'PUBLISHED') return 'ok';
      if (event.nextState === 'FAILED') return 'danger';
      if (event.nextState === 'CANCELLED' || event.nextState === 'EXPIRED') return 'muted';
      if (event.nextState === 'READY_FOR_APPROVAL') return 'warn';
    }
    return 'muted';
  }

  function buildTimelineSection(audit) {
    const section = h('div', { class: 'detail-section' });
    section.appendChild(h('h3', { class: 'section-title' }, icon('clock', 14), `状态时间线（${audit.length}）`));
    if (!Array.isArray(audit) || audit.length === 0) {
      section.appendChild(h('p', { class: 'card-sub' }, '还没有审计事件。'));
      return section;
    }
    const timeline = h('div', { class: 'timeline' });
    audit.forEach((event, index) => {
      const tone = auditTone(event);
      const transition = event.previousState || event.nextState
        ? h('span', { class: 'tl-transition' },
          event.previousState ? (STATE_ZH[event.previousState] || event.previousState) : '—',
          icon('arrow-right', 10),
          event.nextState ? (STATE_ZH[event.nextState] || event.nextState) : '—',
        )
        : null;
      timeline.appendChild(h('div', { class: `tl-item${index === 0 ? ' latest' : ''}`, dataset: { tone } },
        h('div', { class: 'tl-dot' }, icon(AUDIT_ICON[event.action] || 'info', 11)),
        h('div', {},
          h('div', { class: 'tl-head' },
            h('span', {}, AUDIT_ACTION_ZH[event.action] || event.action || '事件'),
            h('span', { class: 'tl-action-code' }, event.action || ''),
            transition,
            h('span', { class: 'tl-time', title: fmtDateTime(event.at) }, fmtClock(event.at)),
            h('span', { class: 'tl-actor' }, actorText(event.actor)),
          ),
          event.reason ? h('p', { class: 'tl-reason' }, event.reason) : null,
        ),
      ));
    });
    section.appendChild(timeline);
    return section;
  }

  function buildIdeaSection(idea) {
    const section = h('div', { class: 'detail-section' });
    section.appendChild(h('h3', { class: 'section-title' }, icon('spark', 14), '想法 idea'));
    if (!idea) {
      section.appendChild(h('p', { class: 'card-sub' }, '该任务没有想法记录。'));
      return section;
    }
    section.appendChild(h('div', { class: 'meta-grid' },
      metaItem('主题', idea.topic || '—'),
      metaItem('来源类型', `${sourceTypeText(idea.sourceType)} · ${idea.sourceType || '—'}`),
      metaItem('来源依据', idea.sourceEvidence || '—'),
      metaItem('创作动机', idea.motivation || '—'),
    ));
    section.appendChild(h('div', { class: 'idea-scores' },
      scoreChip('新颖度 novelty', idea.noveltyScore),
      scoreChip('人格一致性 persona', idea.personaScore),
      scoreChip('相关性 relevance', idea.relevanceScore),
      scoreChip('风险标记', Array.isArray(idea.riskFlags) && idea.riskFlags.length > 0 ? idea.riskFlags.join('、') : '无'),
    ));
    return section;
  }

  function scoreChip(label, value) {
    const display = typeof value === 'number' ? value.toFixed(2) : String(value ?? '—');
    return h('span', { class: 'score-chip' }, `${label} `, h('b', {}, display));
  }

  function buildDraftSection(draft, versions) {
    const section = h('div', { class: 'detail-section' });
    section.appendChild(h('h3', { class: 'section-title' }, icon('sparkles', 14), '草稿 draft'));
    if (!draft) {
      section.appendChild(h('p', { class: 'card-sub' }, '还没有草稿。'));
      return section;
    }
    const box = h('div', { class: 'draft-box' });
    box.appendChild(h('div', { class: 'draft-box-head' },
      badge(`v${draft.version || 1}`, 'muted', false),
      h('span', {}, `语气：${draft.tone || '未指定'}`),
      h('span', { class: 'task-time' }, fmtRelative(draft.updatedAt || draft.createdAt)),
    ));
    box.appendChild(h('p', { class: 'content-body' }, draft.text || '（空草稿）'));
    box.appendChild(h('div', { class: 'result-actions' },
      copyButton(() => draft.text || '', { label: '复制草稿', size: 'md' }),
      draft.text ? h('span', { class: 'badge badge-muted' }, `${String(draft.text).length} 字`) : null,
    ));
    section.appendChild(box);
    if (Array.isArray(versions) && versions.length > 1) {
      const details = h('details', { class: 'versions' },
        h('summary', {}, icon('chevron', 12), `历史版本（${versions.length}）`),
      );
      for (const version of versions) {
        details.appendChild(h('div', { class: 'version-item' },
          h('div', { class: 'version-meta' },
            h('span', {}, `v${version.version}`),
            h('span', {}, fmtDateTime(version.createdAt)),
            h('span', { class: 'mono', title: version.contentHash }, `哈希 ${shortHash(version.contentHash, 12)}`),
          ),
          h('p', { class: 'version-text' }, version.text || ''),
        ));
      }
      section.appendChild(details);
    }
    return section;
  }

  function buildAssetsSection(assets) {
    const section = h('div', { class: 'detail-section' });
    section.appendChild(h('h3', { class: 'section-title' }, icon('image', 14), `素材（${assets.length}）`));
    if (!Array.isArray(assets) || assets.length === 0) {
      section.appendChild(h('p', { class: 'card-sub' }, '该任务没有配图素材；发表时只会发送文字。'));
      return section;
    }
    section.appendChild(buildAssetGrid(assets));
    const meta = h('div', { class: 'asset-meta' });
    for (const asset of assets) {
      meta.appendChild(h('span', {},
        h('span', { class: 'mono' }, shortId(asset.assetId, 14)),
        ' · ', asset.mime || 'image', ' · ', `${asset.width || '?'}×${asset.height || '?'}`,
        ' · ', `sha256 ${shortHash(asset.sha256, 12)}`,
        asset.source ? ` · ${asset.source}` : '',
      ));
    }
    section.appendChild(meta);
    return section;
  }

  function buildTaskApprovalsSection(approvals) {
    const section = h('div', { class: 'detail-section' });
    section.appendChild(h('h3', { class: 'section-title' }, icon('inbox', 14), `审批（${approvals.length}）`));
    if (approvals.length === 0) {
      section.appendChild(h('p', { class: 'card-sub' }, '该任务还没有审批记录。'));
      return section;
    }
    const list = h('div', { class: 'approval-chip-list' });
    for (const approval of approvals) {
      list.appendChild(h('div', { class: 'approval-chip' },
        approvalStatusBadge(approval.status),
        h('span', { class: 'mono', title: approval.approvalId }, shortId(approval.approvalId, 22)),
        h('div', { class: 'approval-chip-meta' },
          h('span', {}, `到期 ${fmtDateTime(approval.expiresAt)}`),
          h('span', { class: 'mono', title: approval.contentHash }, `哈希 ${shortHash(approval.contentHash, 12)}`),
        ),
      ));
    }
    section.appendChild(list);
    const latest = approvals[approvals.length - 1];
    if (latest && latest.contentHash) {
      section.appendChild(h('div', { style: { marginTop: '12px' } }, hashBlock('最近一次审批的内容哈希', latest.contentHash)));
    }
    return section;
  }

  function buildAttemptsSection(attempts) {
    const section = h('div', { class: 'detail-section' });
    section.appendChild(h('h3', { class: 'section-title' }, icon('send', 14), `发布尝试（${attempts.length}）`));
    if (attempts.length === 0) {
      section.appendChild(h('p', { class: 'card-sub' }, '还没有发布尝试。准备朋友圈界面不会自动产生发布尝试。'));
      return section;
    }
    const list = h('div', { class: 'attempt-list' });
    for (const attempt of attempts) {
      const item = h('div', { class: 'attempt-item' });
      item.appendChild(h('div', { class: 'attempt-head' },
        attemptStateBadge(attempt.state),
        h('span', { class: 'mono' }, shortId(attempt.attemptId, 24)),
        h('span', { class: 'badge badge-muted' }, attempt.mode || '—'),
      ));
      item.appendChild(h('div', { class: 'attempt-meta' },
        h('span', {}, `创建 ${fmtDateTime(attempt.createdAt)}`),
        h('span', {}, `更新 ${fmtRelative(attempt.updatedAt)}`),
        attempt.errorCode ? h('span', { class: 'error-code' }, attempt.errorCode) : null,
      ));
      if (attempt.verification) {
        item.appendChild(h('div', { class: 'attempt-verify' },
          h('div', { class: 'verify-tile' }, '核验结果', h('b', {}, attempt.verification.verified ? '已确认发表' : '未确认')),
          h('div', { class: 'verify-tile' }, '核验方式', h('b', {}, attempt.verification.method || '—')),
          h('div', { class: 'verify-tile' }, '发表时间', h('b', {}, attempt.verification.publishedAt ? fmtDateTime(attempt.verification.publishedAt) : '—')),
          h('div', { class: 'verify-tile' }, '证据文件', h('b', { class: 'mono' }, attempt.verification.evidencePath || '—')),
        ));
      }
      const actions = h('div', { class: 'attempt-actions' });
      const verifyBtn = h('button', { class: 'btn btn-outline btn-sm', type: 'button' }, icon('check', 13), '核验这次尝试');
      verifyBtn.addEventListener('click', () => openVerifyModal(state.taskSel, attempt));
      actions.appendChild(verifyBtn);
      item.appendChild(actions);
      list.appendChild(item);
    }
    section.appendChild(list);
    return section;
  }

  function buildImageTasksSection(imageTasks) {
    const section = h('div', { class: 'detail-section' });
    section.appendChild(h('h3', { class: 'section-title' }, icon('image', 14), `图片任务（${imageTasks.length}）`));
    const list = h('div', { class: 'image-task-list' });
    for (const task of imageTasks) {
      list.appendChild(h('div', { class: 'image-task' },
        h('p', { class: 'image-task-prompt' }, task.prompt || '（没有提示词）'),
        h('div', { class: 'image-task-meta' },
          h('span', {}, `provider ${task.provider || '—'}`),
          h('span', {}, `状态 ${task.status || '—'}`),
          h('span', {}, task.requiresUserAction ? '需要用户操作' : '自动处理'),
          h('span', {}, `比例 ${task.aspectRatio || '—'}`),
          task.lastError ? h('span', { class: 'error-code' }, task.lastError) : null,
        ),
      ));
    }
    section.appendChild(list);
    return section;
  }

  function buildTechnicalSection(task, preview) {
    const section = h('div', { class: 'detail-section' });
    section.appendChild(h('h3', { class: 'section-title' }, icon('hash', 14), '技术标识'));
    section.appendChild(h('div', { class: 'meta-grid' },
      metaItem('任务 ID', task.taskId || '—', true),
      metaItem('可见范围', `${visibilityText(task.visibility)} · ${task.visibility || '—'}`),
      metaItem('目标账号', task.accountId || '—', true),
      metaItem('审批 ID', task.approvalId || '—', true),
      metaItem('创建时间', fmtDateTime(task.createdAt)),
      metaItem('更新时间', fmtDateTime(task.updatedAt)),
    ));
    const hashHost = h('div', { style: { marginTop: '14px', display: 'flex', flexDirection: 'column', gap: '10px' } });
    hashHost.appendChild(hashBlock('内容哈希 contentHash', (preview && preview.contentHash) || task.contentHash));
    hashHost.appendChild(hashBlock('素材清单哈希 assetManifestHash', (preview && preview.assetManifestHash) || task.assetManifestHash));
    section.appendChild(hashHost);
    return section;
  }

  function openComposeTaskModal(taskId) {
    const toneInput = h('input', { class: 'input', type: 'text', maxlength: '80', placeholder: '例如：更短、更口语、少一点判断' });
    const feedbackInput = h('textarea', { class: 'textarea modal-textarea', maxlength: '1000', placeholder: '例如：第二段太满，删掉总结句；不要用括号内心戏' });
    const content = [
      modalSection('重写参数',
        h('div', { class: 'field' }, h('label', { class: 'field-label' }, h('span', {}, '语气'), h('span', { class: 'field-hint' }, '可选')), toneInput),
        h('div', { class: 'field', style: { marginBottom: '0' } }, h('label', { class: 'field-label' }, h('span', {}, '修改反馈'), h('span', { class: 'field-hint' }, '可选')), feedbackInput),
      ),
      h('div', { class: 'modal-warning' }, icon('info', 14), h('span', {}, '会调用模型重写草稿并重新审核；审核通过后自动申请审批。不会准备或发表。')),
    ];
    openModal({
      title: '重写并重新审核？',
      subtitle: `任务 ${shortId(taskId, 18)} 的当前草稿会被新版本替换（旧版本保留在草稿历史中）。`,
      iconName: 'spark',
      content,
      confirmText: '重写并审核',
      confirmIcon: 'spark',
      onConfirm: async () => {
        const options = {};
        if (toneInput.value.trim()) options.tone = toneInput.value.trim();
        if (feedbackInput.value.trim()) options.feedback = feedbackInput.value.trim();
        const result = await api.compose(taskId, options);
        return result;
      },
      after: (result) => {
        const review = result && result.review ? result.review : {};
        if (review.passed) toast('已重写并通过审核', '新草稿已提交审批，请到待审批页核对。', 'success');
        else toast('已重写，但审核未通过', (review.notes && review.notes[0]) || '请查看审核说明。', 'warn');
        refreshCurrent(true);
      },
    });
  }

  function openReviewTaskModal(taskId) {
    openModal({
      title: '只重新审核当前草稿？',
      subtitle: '不会重写正文；审核通过后自动申请审批。',
      iconName: 'shield',
      confirmText: '开始审核',
      confirmIcon: 'shield',
      onConfirm: async () => api.review(taskId),
      after: (result) => {
        const review = result && result.review ? result.review : {};
        if (review.passed) toast('审核通过', '已自动申请审批，请到待审批页核对。', 'success');
        else toast('审核未通过', (review.notes && review.notes[0]) || '请查看审核说明。', 'warn');
        refreshCurrent(true);
      },
    });
  }

  function openRequestApprovalModal(taskId) {
    openModal({
      title: '为这个任务创建审批？',
      subtitle: '只会为待审批状态的任务创建一次性审批，不会准备或发表。',
      iconName: 'inbox',
      confirmText: '创建审批',
      confirmIcon: 'inbox',
      onConfirm: async () => api.requestApproval(taskId),
      after: (result) => {
        const approval = result && result.approval ? result.approval : null;
        toast('已创建审批', approval ? `审批 ${shortId(approval.approvalId, 18)} 等待你核对。` : '请到待审批页查看。', 'success');
        refreshCurrent(true);
      },
    });
  }

  function openPrepareModal(taskId) {
    const detail = taskById(taskId);
    const summary = detail && detail.task ? detail.task : {};
    const content = [
      h('div', { class: 'modal-warning' }, icon('monitor', 14),
        h('span', {}, '准备会打开微信朋友圈编辑界面并填入已批准的图文，但不会点击发表。需要桌面执行器启用且健康；未启用时后端会返回错误码。'),
      ),
      modalSection('任务摘要',
        h('div', { class: 'modal-rows' },
          modalRow('任务', h('span', { class: 'mono' }, shortId(taskId, 22))),
          modalRow('当前状态', STATE_ZH[summary.state] || summary.state || '—'),
          modalRow('内容哈希', h('span', { class: 'mono' }, shortHash(summary.contentHash, 24))),
        ),
      ),
    ];
    openModal({
      title: '准备朋友圈编辑界面？',
      subtitle: '只填图文并截图，绝不点击发表。',
      iconName: 'monitor',
      tone: 'warn',
      content,
      confirmText: '准备（不发表）',
      onConfirm: async () => api.prepare(taskId),
      after: (result) => {
        toast('准备请求已返回', (result && (result.message || result.status)) || '请到任务详情查看准备结果。', 'success');
        refreshCurrent(true);
      },
    });
  }

  function openPublishModal(taskId) {
    const summary = taskById(taskId);
    const task = (summary && summary.task) || {};
    const approval = (summary && summary.approval) || null;
    const contentHash = (approval && approval.contentHash) || task.contentHash || '';
    const publishMode = (state.status && state.status.control && state.status.control.publishMode)
      || (state.health && state.health.publishMode) || '';
    const content = [
      h('div', { class: 'modal-warning danger' }, icon('alert', 14),
        h('span', {}, '发表会真实写入你的朋友圈，无法从客户端撤回。当前客户端不会自动重试；如果结果不确定，必须先核验，不能重复发表。'),
      ),
      modalSection('发表摘要',
        h('div', { class: 'modal-rows' },
          modalRow('任务', h('span', { class: 'mono' }, shortId(taskId, 22))),
          modalRow('发布模式', `${publishMode || '未知'}${publishMode === 'PREPARE_ONLY' ? '（后端会拒绝发表）' : ''}`),
          modalRow('目标账号', h('span', { class: 'mono' }, task.accountId || '—')),
          modalRow('可见范围', visibilityText(task.visibility)),
          modalRow('审批', h('span', { class: 'mono' }, approval ? shortId(approval.approvalId, 20) : '无有效审批')),
        ),
      ),
      modalSection('内容哈希 · SHA-256（完整）', hashBlock('', contentHash)),
      publishMode === 'PREPARE_ONLY'
        ? h('div', { class: 'modal-warning' }, icon('info', 14), h('span', {}, '预期结果：后端返回 PUBLISH_MODE_DISABLED。客户端会原样展示错误码，不会伪造成功。'))
        : null,
    ];
    openModal({
      title: '确认发表这条朋友圈？',
      subtitle: '这是不可逆操作，需要你再次确认内容哈希。',
      iconName: 'send',
      danger: true,
      content,
      confirmText: '确认发表',
      onConfirm: async () => api.publish(taskId, approval ? approval.approvalId : undefined),
      after: (result) => {
        toast('发表调用已返回', (result && (result.message || (result.attempt && result.attempt.state))) || '请到任务详情核验结果，不要重复发表。', 'success', { duration: 7000 });
        refreshCurrent(true);
      },
    });
  }

  function openCancelModal(taskId) {
    openModal({
      title: '取消这个任务？',
      subtitle: '取消会作废该任务所有待审批，任务进入 CANCELLED；已发表内容不受影响。',
      iconName: 'x',
      danger: true,
      confirmText: '确认取消',
      onConfirm: async () => api.cancelTask(taskId),
      after: (result) => {
        toast('任务已取消', result && result.state ? `当前状态：${STATE_ZH[result.state] || result.state}` : '', 'success');
        refreshCurrent(true);
      },
    });
  }

  function openVerifyModal(taskId, attempt) {
    if (!attempt || !attempt.attemptId) {
      toast('没有可核验的发布尝试', '', 'warn');
      return;
    }
    const content = [
      h('div', { class: 'modal-warning' }, icon('check', 14),
        h('span', {}, '核验只读取发表结果并确认成功，不会重试发表。用于结果不确定（UNCERTAIN）的尝试。'),
      ),
      modalSection('尝试摘要',
        h('div', { class: 'modal-rows' },
          modalRow('尝试 ID', h('span', { class: 'mono' }, shortId(attempt.attemptId, 24))),
          modalRow('尝试状态', ATTEMPT_STATE_ZH[attempt.state] || attempt.state || '—'),
          modalRow('发布模式', attempt.mode || '—'),
          modalRow('内容哈希', h('span', { class: 'mono' }, shortHash(attempt.contentHash, 24))),
        ),
      ),
    ];
    openModal({
      title: '核验这次发布尝试？',
      subtitle: '核验成功才会把任务收敛为 PUBLISHED。',
      iconName: 'check',
      content,
      confirmText: '开始核验',
      onConfirm: async () => api.verify(attempt.attemptId),
      after: (result) => {
        const verification = result && result.verification ? result.verification : null;
        if (verification && verification.verified) toast('核验成功', '已确认发表，任务会收敛为 PUBLISHED。', 'success');
        else toast('核验未确认发表', (verification && verification.method) ? `方式：${verification.method}` : '请人工核对朋友圈后再处理。', 'warn');
        refreshCurrent(true);
      },
    });
  }

  /* ==========================================================================
   * 13. 历史页
   * ======================================================================== */
  async function renderHistory(token) {
    const page = $('#page');
    if (page.childElementCount === 0) page.appendChild(pageSkeleton());
    const results = await Promise.allSettled([api.history(20), loadClientInfo()]);
    const historyResult = results[0];
    if (token !== renderSeq) return;
    if (historyResult.status === 'rejected') {
      page.replaceChildren(h('div', { class: 'page' }, buildErrorCard(historyResult.reason, { onRetry: () => refreshCurrent(true) })));
      return;
    }
    const history = historyResult.value || { published: [], ideas: [] };
    state.history = history;
    const published = Array.isArray(history.published) ? history.published : [];
    const ideas = Array.isArray(history.ideas) ? history.ideas : [];
    const root = h('div', { class: 'page' });
    const layout = h('div', { class: 'history-layout' });

    const publishedCard = h('section', { class: 'card' });
    publishedCard.appendChild(h('div', { class: 'card-head' },
      h('div', {}, h('h3', { class: 'card-title' }, icon('clock'), '发表历史'), h('p', { class: 'card-sub' }, `已发表 ${published.length} 条`)),
      h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => refreshCurrent(true) }, icon('refresh', 14), '刷新'),
    ));
    const publishedBody = h('div', { class: 'card-body' });
    if (published.length === 0) {
      publishedBody.appendChild(emptyState({
        iconName: 'send',
        title: '还没有已发表的朋友圈',
        text: '当一条内容真正发表并通过核验后，会出现在这里。当前发布模式为「仅准备」，不会自动发表。',
        action: h('a', { class: 'btn btn-outline btn-sm', href: '#/tasks' }, icon('layers', 14), '查看批准中的任务'),
      }));
    } else {
      const list = h('div', { class: 'published-list' });
      for (const post of published) {
        list.appendChild(h('div', { class: 'published-item' },
          h('div', { class: 'published-dot' }, icon('check', 11)),
          h('div', { class: 'published-card' },
            h('div', { class: 'published-head' },
              h('span', {}, fmtDateTime(post.publishedAt)),
              post.verified ? badge('已核验', 'ok') : badge('未核验', 'warn'),
              h('span', {}, visibilityText(post.visibility)),
              h('span', { class: 'mono', title: post.contentHash }, `哈希 ${shortHash(post.contentHash, 12)}`),
            ),
            h('p', { class: 'published-text' }, post.text || ''),
            h('div', { class: 'published-meta' },
              h('span', {}, `账号 ${post.accountId || '—'}`),
              h('span', { class: 'mono' }, post.taskId || '—'),
              h('span', { class: 'mono' }, `attempt ${shortId(post.attemptId, 14)}`),
            ),
          ),
        ));
      }
      publishedBody.appendChild(list);
    }
    publishedCard.appendChild(publishedBody);
    layout.appendChild(publishedCard);

    const ideasCard = h('section', { class: 'card' });
    ideasCard.appendChild(h('div', { class: 'card-head' },
      h('div', {}, h('h3', { class: 'card-title' }, icon('spark'), '候选主题'), h('p', { class: 'card-sub' }, `最近 ${ideas.length} 条想法记录`)),
    ));
    const ideasBody = h('div', { class: 'card-body' });
    if (ideas.length === 0) {
      ideasBody.appendChild(emptyState({ iconName: 'spark', title: '还没有候选主题', text: '去创作页生成第一条候选内容；模型也可能选择沉默。' }));
    } else {
      const list = h('div', { class: 'idea-list' });
      for (const idea of ideas) {
        const linkedTask = state.tasks.find((item) => item.task && item.task.taskId === idea.taskId);
        list.appendChild(h('div', { class: 'idea-card' },
          h('p', { class: 'idea-topic' }, idea.topic || '未命名想法'),
          h('p', { class: 'idea-motivation' }, idea.motivation || ''),
          h('div', { class: 'idea-meta' },
            h('span', {}, sourceTypeText(idea.sourceType)),
            h('span', {}, fmtRelative(idea.createdAt)),
            typeof idea.noveltyScore === 'number' ? h('span', {}, `novelty ${idea.noveltyScore.toFixed(2)}`) : null,
            linkedTask ? h('a', { class: 'idea-link', href: `#/tasks/${encodeURIComponent(idea.taskId)}` }, '查看任务', icon('arrow-right', 11)) : null,
          ),
        ));
      }
      ideasBody.appendChild(list);
    }
    ideasCard.appendChild(ideasBody);
    layout.appendChild(ideasCard);

    root.appendChild(layout);
    page.replaceChildren(root);
  }

  /* ==========================================================================
   * 14. 设置页
   * ======================================================================== */
  async function renderSettings(token) {
    const page = $('#page');
    if (page.childElementCount === 0) page.appendChild(pageSkeleton());
    const results = await Promise.allSettled([
      loadClientInfo(),
      api.clientConfig(),
      api.persona(),
      api.config(),
      api.health(),
      api.status(),
    ]);
    if (token !== renderSeq) return;
    const [clientInfoResult, clientConfigResult, personaResult, configResult, healthResult, statusResult] = results;
    if (clientInfoResult.status === 'fulfilled') {
      // loadClientInfo 已写入 state.client
    }
    if (clientConfigResult.status === 'fulfilled' && clientConfigResult.value) {
      state.clientConfig = clientConfigResult.value;
      const cfg = clientConfigResult.value;
      if (!state.settingsForm.baseUrl && cfg.baseUrl) state.settingsForm.baseUrl = cfg.baseUrl;
      if (!state.settingsForm.tokenFile && cfg.tokenFile) state.settingsForm.tokenFile = cfg.tokenFile;
      if (!state.settingsForm.dataDir && cfg.dataDir) state.settingsForm.dataDir = cfg.dataDir;
    }
    if (personaResult.status === 'fulfilled' && personaResult.value) state.persona = personaResult.value;
    if (configResult.status === 'fulfilled' && configResult.value) state.config = configResult.value;
    if (healthResult.status === 'fulfilled' && healthResult.value) state.health = healthResult.value;
    if (statusResult.status === 'fulfilled' && statusResult.value) state.status = statusResult.value;
    updateChromeData();

    const errors = results.filter((item) => item.status === 'rejected').map((item) => item.reason);
    const connError = errors.find(isConnError);
    if (connError) { setConnection('error', describeError(connError).title); setBanner(connError); }
    else if (errors.length > 0) { setConnection('warn', '部分数据异常'); setBanner(null); }
    else { setConnection('ok', '已连接'); setBanner(null); }

    const root = h('div', { class: 'page' });
    const layout = h('div', { class: 'settings-layout' });
    const leftCol = h('div', { class: 'settings-col' });
    const rightCol = h('div', { class: 'settings-col' });

    if (connError) {
      root.appendChild(buildErrorCard(connError, { onRetry: () => refreshCurrent(true), retryLabel: '重新连接' }));
    }

    leftCol.appendChild(buildConnectionInfoCard(clientInfoResult));
    leftCol.appendChild(buildClientConfigCard());
    rightCol.appendChild(buildControlPanelCard());
    rightCol.appendChild(buildPersonaCard(personaResult));
    rightCol.appendChild(buildMemoryScheduleCard());
    rightCol.appendChild(buildLocalActionsCard());
    layout.append(leftCol, rightCol);
    root.appendChild(layout);
    page.replaceChildren(root);
  }

  function buildConnectionInfoCard(clientInfoResult) {
    const info = state.client || {};
    const health = state.health || {};
    const configOk = clientInfoResult.status === 'fulfilled';
    const startedAt = info.startedAt ? new Date(info.startedAt * 1000) : null;
    const startupText = startedAt ? fmtDateTime(startedAt.toISOString()) : '—';
    const rows = [
      ['客户端服务', '本机回环静态服务 + /proxy/api/* 代理', true],
      ['客户端版本', info.version ? `v${info.version}` : (configOk ? '—' : '不可读取'), true],
      ['管理 API', info.adminUrl || '—', true],
      ['插件版本', health.version ? `v${health.version}` : '—', true],
      ['数据库', health.database ? `${health.database}（${ADAPTER_ZH[health.database] || health.database}）` : '—', true],
      ['客户端启动', `${startupText}（${fmtRelative(startedAt ? startedAt.toISOString() : null)}）`, true],
      ['令牌文件', info.tokenFile || '—', true],
      ['令牌文件存在', info.tokenFileExists ? '是' : '否', false],
      ['数据目录', info.dataDir || '—', true],
    ];
    const list = h('div', { class: 'info-list' });
    for (const [key, value, mono] of rows) {
      let valueNode;
      if (key === '令牌文件存在') {
        valueNode = h('span', { class: 'info-val' }, info.tokenFileExists ? badge('存在', 'ok') : badge('缺失', 'danger'));
      } else {
        valueNode = h('span', { class: `info-val${mono ? ' mono' : ''}` }, value || '—');
      }
      list.appendChild(h('div', { class: 'info-row' }, h('span', { class: 'info-key' }, key), valueNode));
    }
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        h('div', {}, h('h3', { class: 'card-title' }, icon('wifi'), '连接与运行'), h('p', { class: 'card-sub' }, '本机服务与插件管理 API 的只读信息')),
      ),
      h('div', { class: 'card-body' },
        list,
        h('div', { class: 'notice' }, icon('lock', 15),
          h('span', {}, '管理令牌只由本地客户端服务从 tokenFile 读取并注入请求头。本页面不显示令牌内容，也不会把令牌写入浏览器存储、日志或截图。'),
        ),
      ),
    );
  }

  function buildClientConfigCard() {
    const form = state.settingsForm;
    const baseUrlInput = h('input', { class: 'input', type: 'text', value: form.baseUrl, placeholder: 'http://127.0.0.1:18766', spellcheck: 'false' });
    const tokenFileInput = h('input', { class: 'input', type: 'text', value: form.tokenFile, placeholder: 'D:\\...\\data\\admin-token.txt', spellcheck: 'false' });
    const dataDirInput = h('input', { class: 'input', type: 'text', value: form.dataDir, placeholder: 'D:\\...\\data', spellcheck: 'false' });
    baseUrlInput.addEventListener('input', () => { form.baseUrl = baseUrlInput.value; });
    tokenFileInput.addEventListener('input', () => { form.tokenFile = tokenFileInput.value; });
    dataDirInput.addEventListener('input', () => { form.dataDir = dataDirInput.value; });
    const errorSlot = h('div');
    const saveBtn = h('button', { class: 'btn btn-primary', type: 'button' }, icon('check', 16), '保存客户端配置');
    saveBtn.addEventListener('click', async () => {
      errorSlot.replaceChildren();
      const baseUrl = baseUrlInput.value.trim();
      if (baseUrl && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?(\/.*)?$/i.test(baseUrl)) {
        renderModalError(errorSlot, new ApiError('INVALID_BASE_URL', '管理 API 地址只允许 http 回环地址（127.0.0.1 / localhost / ::1）。', { kind: 'business' }));
        return;
      }
      const previousBaseUrl = (state.clientConfig && state.clientConfig.baseUrl) || '';
      saveBtn.disabled = true;
      saveBtn.replaceChildren(h('span', { class: 'spinner' }), '保存中…');
      try {
        const result = await api.saveClientConfig({ baseUrl, tokenFile: tokenFileInput.value.trim(), dataDir: dataDirInput.value.trim() });
        const nextConfig = await api.clientConfig();
        state.clientConfig = nextConfig;
        toast('客户端配置已保存', (result && result.message) || '配置写入 client/moments-client.json（不含令牌）。', 'success');
        if (baseUrl && previousBaseUrl && baseUrl !== previousBaseUrl) {
          toast('管理 API 地址已修改', '需要重开客户端后生效，当前会话仍连接旧地址。', 'warn', { duration: 7000 });
        }
      } catch (error) {
        renderModalError(errorSlot, error);
      } finally {
        saveBtn.disabled = false;
        saveBtn.replaceChildren(icon('check', 16), '保存客户端配置');
      }
    });
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        h('div', {}, h('h3', { class: 'card-title' }, icon('settings'), '客户端配置'), h('p', { class: 'card-sub' }, '写入 client/moments-client.json；不保存令牌')),
      ),
      h('div', { class: 'card-body' },
        h('div', { class: 'field' }, h('label', { class: 'field-label' }, h('span', {}, '管理 API 地址 baseUrl')), baseUrlInput),
        h('div', { class: 'field' }, h('label', { class: 'field-label' }, h('span', {}, '令牌文件 tokenFile')), tokenFileInput),
        h('div', { class: 'field' }, h('label', { class: 'field-label' }, h('span', {}, '数据目录 dataDir')), dataDirInput),
        errorSlot,
        h('div', { class: 'form-footer' },
          h('p', { class: 'form-note' }, '地址只允许 http 回环地址。修改管理 API 地址后需要重开客户端；令牌文件路径只保存路径，不保存内容。'),
          saveBtn,
        ),
      ),
    );
  }

  function buildControlPanelCard() {
    const control = (state.status && state.status.control) || {};
    const config = state.config || {};
    const policy = config.policy || {};
    const rows = [];

    function controlRow({ iconName, name, desc, badgeTone, badgeLabel, actionLabel, actionTone, onAction, disabled }) {
      const btn = h('button', {
        class: `btn ${actionTone === 'danger' ? 'btn-danger' : actionTone === 'primary' ? 'btn-primary' : 'btn-outline'} btn-sm`,
        type: 'button',
        disabled: Boolean(disabled),
      }, icon(actionTone === 'danger' ? 'power' : actionTone === 'primary' ? 'play' : 'pause', 14), actionLabel);
      btn.addEventListener('click', onAction);
      rows.push(h('div', { class: 'control-row' },
        h('div', { class: 'control-icon' }, icon(iconName, 16)),
        h('div', { class: 'control-text' }, h('div', { class: 'control-name' }, name), h('div', { class: 'control-desc' }, desc)),
        h('div', { class: 'control-action' }, badge(badgeLabel, badgeTone, true)),
        btn,
      ));
    }

    controlRow({
      iconName: 'pause',
      name: '暂停系统',
      desc: '暂停后不会创建新任务，也不会执行新的 GUI 发表；已开始但未发表的任务会安全停止。',
      badgeTone: control.paused ? 'warn' : 'ok',
      badgeLabel: control.paused ? '已暂停' : '未暂停',
      actionLabel: control.paused ? '恢复' : '暂停',
      actionTone: control.paused ? 'primary' : 'outline',
      onAction: () => openPauseModal(!control.paused),
    });

    controlRow({
      iconName: 'power',
      name: 'Kill Switch',
      desc: '阻止所有新的创作、准备与发表操作，并持久化到数据库。只有停机维护时才应启用。',
      badgeTone: control.killSwitch ? 'danger' : 'ok',
      badgeLabel: control.killSwitch ? '已启用' : '关闭',
      actionLabel: control.killSwitch ? '解除' : '启用',
      actionTone: control.killSwitch ? 'outline' : 'danger',
      onAction: () => openKillModal(!control.killSwitch),
    });

    const policyTiles = h('div', { class: 'policy-grid', style: { marginTop: '14px' } },
      policyTile('发布模式', modeText(control.publishMode || config.publishMode || '')),
      policyTile('自主调度', control.scheduleEnabled ? '已启用' : '未启用'),
      policyTile('每日上限', policy.dailyLimit !== undefined ? `${policy.dailyLimit} 条` : '—'),
      policyTile('最小间隔', policy.minIntervalMinutes !== undefined ? fmtMinutes(policy.minIntervalMinutes) : '—'),
      policyTile('静默时段', Array.isArray(policy.quietHours) ? policy.quietHours.join(' – ') : '—'),
      policyTile('审批有效期', policy.approvalTtlMinutes !== undefined ? fmtMinutes(policy.approvalTtlMinutes) : '—'),
      policyTile('最低发布分', policy.minScoreToPublish !== undefined ? String(policy.minScoreToPublish) : '—'),
      policyTile('时区', policy.timeZone || '—'),
    );

    return h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        h('div', {}, h('h3', { class: 'card-title' }, icon('shield'), '所有者控制'), h('p', { class: 'card-sub' }, '危险操作都会二次确认并记录审计（actor=owner）')),
      ),
      h('div', { class: 'card-body' }, rows, policyTiles,
        h('div', { class: 'notice warn', style: { marginTop: '14px' } }, icon('alert', 15),
          h('span', {}, '暂停与 Kill Switch 只影响本机自动流程；审批与发表始终需要你手动确认。客户端不会自行恢复被暂停的系统。'),
        ),
      ),
    );
  }

  function policyTile(key, value) {
    return h('div', { class: 'policy-tile' }, h('div', { class: 'policy-key' }, key), h('div', { class: 'policy-val' }, value || '—'));
  }

  function openPauseModal(shouldPause) {
    const reasonInput = h('textarea', { class: 'textarea modal-textarea', maxlength: '300', placeholder: '例如：需要停机维护（可选，写入审计）' });
    const content = [
      h('div', { class: `modal-warning${shouldPause ? '' : ''}` }, icon('alert', 14),
        h('span', {}, shouldPause
          ? '暂停后不会创建新任务，也不会执行新的 GUI 发表；已开始但未发表的任务会安全停止。恢复前系统保持暂停。'
          : '恢复后自主调度与手动操作会重新可用；不会自动补发暂停期间的内容。'),
      ),
      modalSection('操作原因（可选，写入审计）', reasonInput),
    ];
    openModal({
      title: shouldPause ? '暂停系统？' : '恢复系统？',
      subtitle: shouldPause ? '所有新的创作与发表会被阻止，直到你手动恢复。' : '恢复不会触发任何自动发表。',
      iconName: shouldPause ? 'pause' : 'play',
      tone: shouldPause ? 'warn' : 'primary',
      content,
      confirmText: shouldPause ? '确认暂停' : '确认恢复',
      onConfirm: async () => (shouldPause ? api.pause(reasonInput.value.trim()) : api.resume(reasonInput.value.trim())),
      after: () => {
        toast(shouldPause ? '系统已暂停' : '系统已恢复', '', 'success');
        refreshCurrent(true);
      },
    });
  }

  function openKillModal(shouldKill) {
    const reasonInput = h('textarea', { class: 'textarea modal-textarea', maxlength: '300', placeholder: '例如：停机维护（可选，写入审计）' });
    const content = [
      h('div', { class: 'modal-warning danger' }, icon('alert', 14),
        h('span', {}, shouldKill
          ? 'Kill Switch 会阻止所有新的创作、准备与发表操作，并持久化到数据库。只有确认需要停机维护时才启用。'
          : '解除后系统会回到正常控制状态；请确认维护已经结束。'),
      ),
      modalSection('操作原因（可选，写入审计）', reasonInput),
    ];
    openModal({
      title: shouldKill ? '启用 Kill Switch？' : '解除 Kill Switch？',
      subtitle: shouldKill ? '这是一个会持久化的全局熔断开关。' : '解除前请确认没有正在进行的人工发表。',
      iconName: 'power',
      danger: shouldKill,
      content,
      confirmText: shouldKill ? '确认启用' : '确认解除',
      onConfirm: async () => (shouldKill ? api.kill(reasonInput.value.trim()) : api.unkill(reasonInput.value.trim())),
      after: () => {
        toast(shouldKill ? 'Kill Switch 已启用' : 'Kill Switch 已解除', '', 'success');
        refreshCurrent(true);
      },
    });
  }

  function buildPersonaCard(personaResult) {
    const persona = state.persona;
    if (personaResult.status === 'rejected' || !persona) {
      return h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('div', {}, h('h3', { class: 'card-title' }, icon('sparkles'), '人格预览（只读）'))),
        h('div', { class: 'card-body' }, buildErrorCard(personaResult.reason || new ApiError('PERSONA_UNAVAILABLE', '人格文件不可读取', { kind: 'business' }), {
          onRetry: () => refreshCurrent(true),
        })),
      );
    }
    const soulPre = h('textarea', { class: 'persona-pre', rows: 16, 'aria-label': '人格设定' });
    soulPre.value = persona.soul || '';
    const visualPre = h('textarea', { class: 'persona-pre', rows: 10, 'aria-label': '配图风格' });
    visualPre.value = persona.visualStyle || '';
    const save = h('button', { class: 'btn btn-primary', type: 'button' }, '保存人格与配图风格');
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        await request('/proxy/api/persona', { method: 'POST', body: { soul: soulPre.value, visualStyle: visualPre.value } });
        toast('已保存', '后续创作使用新设定，既有审批内容保持原样', 'success');
      } catch (error) { toast('保存失败', describeError(error).detail, 'error'); }
      finally { save.disabled = false; }
    });
    const soulChevron = icon('chevron', 14);
    soulChevron.classList.add('chev');
    const visualChevron = icon('chevron', 14);
    visualChevron.classList.add('chev');
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        h('div', {}, h('h3', { class: 'card-title' }, icon('sparkles'), '人格与配图风格'), h('p', { class: 'card-sub' }, '所有者设置保存在本地数据库，供后续创作使用')),
      ),
      h('div', { class: 'card-body' },
        h('div', { class: 'persona-meta' },
          h('span', {}, `来源 ${persona.source || '—'}`),
          h('span', {}, `加载于 ${fmtDateTime(persona.loadedAt)}`),
        ),
        h('details', { class: 'persona' },
          h('summary', {}, icon('spark', 14), 'SOUL · 表达设定', soulChevron),
          soulPre,
        ),
        h('details', { class: 'persona' },
          h('summary', {}, icon('image', 14), '视觉风格 · 配图审美与边界', visualChevron),
          visualPre,
        ),
        h('div', { class: 'notice' }, icon('lock', 15),
          h('span', {}, '这些设定会作为模型创作上下文。请勿填写凭据或私人聊天记录；发布仍需独立审批。'),
        ),
        save,
      ),
    );
  }

  function buildMemoryScheduleCard() {
    const output = h('div', { class: 'persona-pre' }, '点击刷新查看已保存的记忆与调度。');
    const kind = h('select', { class: 'select', 'aria-label': '记忆类型' },
      ...Object.entries({persona:'人格偏好',episodic:'经历与反馈',semantic:'已核实的知识',operational:'运行记录'})
        .map(([value,label]) => h('option', { value }, label)));
    const key = h('input', { class: 'input', placeholder: '记忆名称', 'aria-label': '记忆名称', maxLength: 120 });
    const value = h('textarea', { class: 'textarea', placeholder: '明确授权保存的观点或偏好', 'aria-label': '记忆内容', rows: 4, maxLength: 2000 });
    const enabled = h('input', { type: 'checkbox', 'aria-label': '启用自主创作' });
    const interval = h('input', { class: 'input', type: 'number', min: 15, max: 3600, value: 60, 'aria-label': '检查间隔（秒）' });
    const probability = h('input', { class: 'input', type: 'number', min: 0, max: 100, value: 5, 'aria-label': '每次创作概率（%）' });
    const jitter = h('input', { class: 'input', type: 'number', min: 0, max: 3600, value: 0, 'aria-label': '随机延迟（秒）' });
    const action = (label, fn) => {
      const button = h('button', { type: 'button', class: 'btn btn-outline btn-sm' }, label);
      button.addEventListener('click', async () => {
        button.disabled = true;
        try { await fn(); } catch (error) { toast('操作失败', describeError(error).detail || String(error), 'error'); }
        finally { button.disabled = false; }
      });
      return button;
    };
    const refresh = async () => {
      const [memories, settings] = await Promise.all([request('/proxy/api/memories'), request('/proxy/api/schedule')]);
      output.replaceChildren(...memories.filter((memory) => memory.kind !== 'operational').map((memory) =>
        h('div', { class: 'field' }, h('strong', {}, memory.key), h('p', {}, memory.value),
          action('删除这条记忆', async () => {
            await request('/proxy/api/memories/' + encodeURIComponent(memory.memoryId), { method: 'DELETE' });
            await refresh();
          }))));
      if (!output.childElementCount) output.textContent = '暂无内容记忆。';
      enabled.checked = settings.scheduleEnabled;
      interval.value = settings.scheduler.tickSeconds;
      probability.value = settings.scheduler.ideaProbability * 100;
      jitter.value = settings.scheduler.jitterSeconds;
    };
    const field = (label, control) => h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), control);
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', { class: 'card-title' }, '长期记忆与自主创作调度')),
      h('div', { class: 'card-body' },
        action('刷新', refresh), output, field('记忆类型', kind), field('记忆名称', key), field('记忆内容', value),
        action('保存记忆', async () => {
          await request('/proxy/api/memories', { method: 'POST', body: { kind: kind.value, key: key.value, value: value.value } });
          await refresh();
        }),
        h('p', {}, '调度仅生成候选草稿，不自动发表。修改前先刷新当前设置。'),
        field('启用自主创作', enabled), field('检查间隔（秒）', interval),
        field('每次创作概率（%）', probability), field('随机延迟（秒）', jitter),
        action('保存调度', async () => {
          await request('/proxy/api/schedule', { method: 'POST', body: {
            scheduleEnabled: enabled.checked, scheduler: {
              tickSeconds: Number(interval.value), ideaProbability: Number(probability.value) / 100,
              jitterSeconds: Number(jitter.value),
            },
          } });
          await refresh();
        }),
      ));
  }

  function buildLocalActionsCard() {
    const openDataBtn = h('button', { class: 'btn btn-outline btn-sm', type: 'button' }, icon('folder', 14), '打开数据目录');
    openDataBtn.addEventListener('click', async () => {
      openDataBtn.disabled = true;
      try {
        const result = await api.openData();
        toast('已请求打开数据目录', (result && result.message) || '', 'success');
      } catch (error) {
        const info = describeError(error);
        toast('打开数据目录失败', `${info.detail}${info.code ? `（${info.code}）` : ''}`, 'error');
      } finally {
        openDataBtn.disabled = false;
      }
    });
    const exitBtn = h('button', { class: 'btn btn-danger btn-sm', type: 'button' }, icon('power', 14), '退出客户端');
    exitBtn.addEventListener('click', () => {
      openModal({
        title: '退出本地客户端？',
        subtitle: '退出会停止本地静态服务与代理；浏览器页面会失去连接。DSH 插件与数据库不会受影响。',
        iconName: 'power',
        danger: true,
        confirmText: '确认退出',
        footerNote: '不会停止 DSH 插件管理 API',
        onConfirm: async () => api.shutdown(),
        after: () => {
          state.exited = true;
          stopPolling();
          setConnection('error', '客户端已退出');
          setBanner(null);
          closeAllToasts();
          showExitState();
        },
      });
    });
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        h('div', {}, h('h3', { class: 'card-title' }, icon('terminal'), '本地操作'), h('p', { class: 'card-sub' }, '只影响本机客户端，不改变插件数据')),
      ),
      h('div', { class: 'card-body' },
        h('div', { class: 'local-actions' },
          h('div', { class: 'local-action' },
            h('div', { class: 'control-text' },
              h('div', { class: 'control-name' }, '打开数据目录'),
              h('div', { class: 'control-desc' }, '调用本机文件管理器打开 dataDir，便于查看素材与日志。'),
            ),
            openDataBtn,
          ),
          h('div', { class: 'local-action' },
            h('div', { class: 'control-text' },
              h('div', { class: 'control-name' }, '退出客户端'),
              h('div', { class: 'control-desc' }, '停止本地客户端服务；已打开的页面需要重新启动客户端才能使用。'),
            ),
            exitBtn,
          ),
        ),
      ),
    );
  }

  function closeAllToasts() {
    const stack = $('#toast-stack');
    if (stack) stack.replaceChildren();
  }

  function showExitState() {
    const page = $('#page');
    if (!page) return;
    page.replaceChildren(h('div', { class: 'page' },
      h('section', { class: 'card' },
        h('div', { class: 'exit-overlay' },
          h('div', { class: 'exit-icon' }, icon('power', 28)),
          h('h2', {}, '客户端已退出'),
          h('p', {}, '本地客户端服务已停止，可以关闭这个标签页。DSH Moments 插件与数据库仍在运行；需要继续管理时，重新启动客户端即可。'),
          h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'center' } },
            h('span', { class: 'badge badge-muted' }, '本地服务已停止'),
            h('span', { class: 'badge badge-muted' }, '连接状态：不可用'),
          ),
        ),
      ),
    ));
    document.querySelectorAll('.nav-item').forEach((item) => { item.classList.add('disabled'); });
  }

  /* ==========================================================================
   * 15. 启动与生命周期
   * ======================================================================== */
  function bindGlobalEvents() {
    window.addEventListener('hashchange', () => {
      if (state.exited) return;
      const route = parseRoute();
      if (currentRoute && route.name === currentRoute.name && route.params.join('/') === currentRoute.params.join('/')) return;
      applyRoute(route);
    });

    document.addEventListener('keydown', (event) => {
      if (!activeModal) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        activeModal.close();
        return;
      }
      if (event.key === 'Tab') activeModal.trapFocus(event);
    });

    document.addEventListener('visibilitychange', () => {
      if (!currentRoute || state.exited) return;
      if (document.hidden) {
        stopPolling();
      } else {
        if (POLLABLE.has(currentRoute.name)) {
          startPolling();
          refreshCurrent(false);
        }
        if (heartbeat.activated) ping();
      }
    });

    const refreshBtn = $('#refresh-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        if (state.exited) return;
        refreshCurrent(true);
      });
    }

    window.addEventListener('pointerdown', activateHeartbeat, { passive: true });
    window.addEventListener('keydown', activateHeartbeat);
  }

  /**
   * 心跳：server.py 在浏览器心跳停止后自动退出，避免遗留后台进程。
   * 只在用户第一次交互后启动，避免纯自动化截图/预览误触发自动退出。
   */
  function activateHeartbeat() {
    if (heartbeat.activated || state.exited) return;
    heartbeat.activated = true;
    ping();
    heartbeat.timer = window.setInterval(() => {
      if (state.exited) {
        window.clearInterval(heartbeat.timer);
        return;
      }
      // 无论页面是否可见都保持心跳：服务端在心跳停止 60s 后自动退出，
      // 隐藏/最小化窗口时仍需证明浏览器还开着。
      ping();
    }, 20000);
  }

  async function ping() {
    try {
      await fetch('/api/client/ping', { cache: 'no-store', credentials: 'same-origin' });
    } catch {
      // 心跳失败不影响业务；连接状态由业务请求负责。
    }
  }

  function startCountdownTicker() {
    if (countdownTimer !== null) window.clearInterval(countdownTimer);
    countdownTimer = window.setInterval(() => {
      document.querySelectorAll('.countdown[data-expires]').forEach((node) => updateCountdownNode(node));
    }, 1000);
  }

  async function boot() {
    bindGlobalEvents();
    startCountdownTicker();
    await loadClientInfo();
    const route = parseRoute();
    // 非概览页也预取一次核心快照，保证顶栏账号 / 模式 / 待审批角标可用
    if (route.name !== 'dashboard') await loadCore();
    await applyRoute(route);
  }

  boot().catch((error) => {
    console.error('客户端启动失败', error);
    const page = $('#page');
    if (page) {
      page.replaceChildren(h('div', { class: 'page' }, buildErrorCard(error, { onRetry: () => location.reload(), retryLabel: '重新加载' })));
    }
    setConnection('error', '启动失败');
  });
})();
