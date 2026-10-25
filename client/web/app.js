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
    READY_TO_PUBLISH: '待直接发表',
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
    READY_TO_PUBLISH: 'primary',
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
    PREPARE_ONLY: '仅准备不发表',
    APPROVAL_REQUIRED: '审批后发表',
    POLICY_AUTONOMOUS: '不审批直接发表',
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
    { key: 'approved', label: '待执行', color: '#5b8cff', states: ['READY_TO_PUBLISH', 'APPROVED', 'QUEUED', 'PREPARING', 'PREPARED'] },
    { key: 'published', label: '已发表', color: '#3ddc97', states: ['PUBLISHED'] },
    { key: 'abnormal', label: '失败 / 取消', color: '#ff5d73', states: ['FAILED', 'UNCERTAIN', 'EXPIRED', 'CANCELLED'] },
    {
      key: 'drafting',
      label: '创作中',
      color: '#8b93a8',
      states: ['IDEA_CREATED', 'DRAFTING', 'DRAFT_READY', 'IMAGE_REQUIRED', 'IMAGE_PENDING', 'IMAGE_READY', 'REVIEWING'],
    },
  ];

  /* --------------------------------------------------------------------------
   * 首次配置教程数据
   * 说明：命令/路径按本机已验证环境写死为“可复制”的形式；换机器时替换项目根、
   * DSH Python 路径、wxid 与 WeChatAgent 安装路径即可。所有命令只做读取/启动，
   * 教程页面本身从不调用批准/发表/取消/暂停等写 API。
   * ------------------------------------------------------------------------ */
  // 首次配置：按当前 EXE 与服务端契约编写，不包含网络代理设置。
  const SETUP_ROOT = 'D:\\dsh插插\\dsh-moments-agent';
  const SETUP_DSH_PYTHON = 'D:\\dsh\\resources\\runtime\\primary-runtime\\dependencies\\python\\python.exe';
  const SETUP_PROFILE_PATCH = '%USERPROFILE%\\.dsh\\profiles\\desktop\\cordis.patch.yml';
  const SETUP_WECHATBOT = 'D:\\wechatbot';
  const SETUP_ACCOUNT = '你的真实 wxid';
  const SETUP_CLIENT_VERSION = '4.1.10.27';
  const SETUP_STEP_IDS = ['plugin', 'model', 'wechatagent', 'account', 'executor', 'config', 'approval', 'firstpost'];

  const SETUP_STEPS = [
    {
      id: 'plugin', letter: '01', title: '准备程序与数据目录',
      summary: '确认 EXE、DSH 插件、配置文件分别放在哪里。',
      goal: 'EXE 提供管理界面和内置桌面执行器；DSH 插件负责模型、任务、审批和数据库。两者需要同时运行，并读取同一个项目数据目录。',
      prereqs: ['使用完整解压的 1.1.9 或更新 EXE 包，保留旁边的 _internal 目录。', '已安装 DSH 并启用 dsh-moments-agent 插件；先登录 DSH 的模型账号。', '准备好已登录的 Windows 微信；首次先验证纯文字内容。'],
      blocks: [
        { type: 'ul', items: ['先打开 DSH，确认插件列表中 dsh-moments-agent 为已启用。EXE 不会替你启动 DSH。', '关闭旧版客户端与旧版独立执行器，再双击 DSH-Moments-Client.exe，在 Windows UAC 中允许管理员运行。', '先看「设置 → 本机地址自动发现」，核对 DSH、WeChatAgent、已注册插件及 profile。可点击「填入检测到的连接」，再核对客户端配置卡并保存。检测不到时手填：管理 API 示例 http://127.0.0.1:18766，令牌文件与数据目录以实际运行插件为准。', '插件目录示例 D:\\dsh插插\\dsh-moments-agent；本教程会尽量替换为自动读取的本机位置。多份安装时应核对当前 profile。', '地址和令牌路径保存后即时生效。内置执行器的数据目录变更需要完整退出并重启 EXE；界面会提示。可从客户端退出按钮立即停止。'] },
        { type: 'cmd', label: '只检查路径是否存在（不读取令牌）', code: String.raw`$project = 'D:\dsh插插\dsh-moments-agent'
Test-Path "$project\dist\index.js"
Test-Path "$project\data\admin-token.txt"
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object LocalPort -in 18765,18766,18770 | Select-Object LocalPort,OwningProcess`, note: '18766 属于 DSH；18765 与 18770 应属于同一个 EXE 进程。项目已安装的用户不需要重新执行 npm install/build。' },
        { type: 'callout', tone: 'info', title: '三个配置位置', text: 'EXE 目录/client/moments-client.json：客户端连接；DSH profile 的 cordis.patch.yml：插件完整配置；项目 data/desktop-account.txt：执行器预期账号。进度勾选只记录阅读情况，不会替你修改这些配置。' },
      ],
      expected: ['客户端页面可打开，顶栏显示已连接。', '管理令牌文件存在；环境自检中的插件与数据库正常。', '18765、18770 同 PID，18766 单独由 DSH 提供。'],
      troubleshoot: [{ problem: '页面可打开但无法连接插件', action: '检查 DSH 是否正在运行、插件是否启用，以及管理 API 和令牌路径。客户端设置页只管理连接，不会启动或修改 DSH 插件。' }, { problem: '端口被占用', action: '先核对 OwningProcess 对应的程序，仅退出本项目旧客户端/旧执行器。不要结束所有 Python 或 DSH 进程。' }],
      codes: ['TOKEN_MISSING', 'ADMIN_API_UNREACHABLE', 'DESKTOP_UNAVAILABLE'],
    },
    {
      id: 'model', letter: '02', title: '连接模型与设置人格',
      summary: '模型健康、人格可读，先验证一条普通草稿。',
      goal: '文字生成和审核由 DSH 的模型完成。先确保模型可用，再配置表达习惯；模型健康不等于微信已具备发表条件。',
      prereqs: ['第 01 步已连接到插件管理 API。', 'DSH 模型账号已登录，或你已配置可用的模型提供方。'],
      blocks: [
        { type: 'ul', items: ['在 DSH 的模型设置中确认可调用的提供方与模型。本机配置为 provider=deepseek-account、model=deepseek-flash；只有你的 DSH 也提供这些名称时才使用。', '在「设置 → 人格」填写立场、表达方式、禁区和希望少用的措辞，并保存。不要写入账号密码或令牌。', '回到本页点击环境自检，确认「模型 / LLM」为可用。若失败，先在 DSH 内解决登录、额度或模型名称问题。', '进入「创作」，使用一段普通测试主题生成草稿，检查文风与审核结果。不提交审批、不点击准备或发表也可以验证生成能力。'] },
        { type: 'callout', tone: 'info', title: '先完成纯文字链路', text: '首次使用选择纯文字、默认公开范围。当前几何驱动的图片选择和部分可见范围存在支持限制。图片 Provider 可用不代表微信图文发送已验收；配图应在文字链路通过后单独验证。' },
      ],
      expected: ['环境自检模型状态为可用。', '人格内容保存并能重新读取。', '普通主题能生成草稿，正文与审核结果可查看；微信尚未发生任何操作。'],
      troubleshoot: [{ problem: 'LLM_NOT_CONFIGURED / 模型不可用', action: '核对 DSH 模型账号登录和 llm.provider/model；修改插件配置后重载插件，再重新检查。' }, { problem: '模型选择沉默或审核未通过', action: '先看具体理由。缺少内容、重复表达或触发禁区时不一定是配置故障；换一个具体、普通的主题重试生成。' }],
      codes: [],
    },
    {
      id: 'wechatagent', letter: '03', title: '连接 WeChatAgent 与微信',
      summary: '读取真实服务地址，确认 Reader 与 Hook 指向同一账号。',
      goal: '插件通过 WeChatAgent 核对当前微信账号。使用已安装版本的服务管理入口，不在教程里自动执行注入、升级或降级。',
      prereqs: ['已安装并按 WeChatAgent 自身文档配置 Reader / Hook。', '微信已登录，且处于当前 Windows 用户的交互桌面。'],
      blocks: [
        { type: 'ul', items: ['打开 WeChatAgent 面板，按该版本的服务说明启动 Reader 与 Hook，确认微信已登录。', '记录面板实际显示的 Reader 与 Hook 地址。本机使用 http://127.0.0.1:5031 与 http://127.0.0.1:30001；它们不是所有安装环境的默认端口。', '需要鉴权时，从该安装的配置中找到 readerConfigPath 或 readerTokenFile/hookTokenFile 的真实路径。只填路径，不将令牌正文粘贴到界面、截图或 YAML。', '第 06 步把地址与令牌路径写入插件配置并重载。之后回到环境自检，确认 Reader/Hook 健康且账号一致。'] },
        { type: 'cmd', label: '检查服务端口是否监听（将端口替换为面板显示值）', code: String.raw`Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object LocalPort -in 5031,30001 | Select-Object LocalPort,OwningProcess`, note: '监听只证明服务存在；是否鉴权成功、账号是否一致，以插件 WeChatAgent 健康结果为准。' },
      ],
      expected: ['Reader 与 Hook 服务均正常，插件 WeChatAgent 状态为正常。', '插件报告两端账号一致；仅有端口监听不算完成。'],
      troubleshoot: [{ problem: 'Reader / Hook 未连接', action: '核对实际地址、端口、对应安装的令牌文件与服务状态；不要混用另一个 WeChatAgent 安装目录的配置。' }, { problem: 'Reader 与 Hook 账号不一致', action: '停止准备与发表，重新核对两端登录会话。切换微信账号后，应重启相关服务并重新审批内容。' }],
      codes: ['WECHAT_ACCOUNT_NOT_VERIFIED'],
    },
    {
      id: 'account', letter: '04', title: '绑定你自己的微信账号',
      summary: '插件、执行器、当前微信会话三处使用同一真实 wxid。',
      goal: '使用 WeChatAgent 确认的 wxid，而不是昵称、手机号或微信号。账号绑定错误时，程序应该阻止操作；不要通过修改检查结果来跳过。',
      prereqs: ['第 03 步已确认 Reader / Hook 的真实登录账号。', '已确认 EXE 设置中的 dataDir，与第 01 步的项目 data 目录一致。'],
      blocks: [
        { type: 'ul', items: ['从 WeChatAgent 的 Reader 状态核对 accountDirectory 与 ownWxid。accountDirectory 是任务与执行器使用的账号标识；ownWxid 是所有者标识。两者可能不同，按各自字段填写并留在本机。', '用下面命令写入数据目录中的 desktop-account.txt。命令会要求你输入已核实的 wxid。', '插件 account 与 desktop-account.txt 使用 Reader 确认的 accountDirectory（可能带目录后缀）；ownerWxid 填真实审批所有者的 ownWxid。当前健康检查即使使用 manual 审批也要求 ownerWxid 非空，不能留空。', '写入后完全退出并重启 EXE。执行器只在启动时读取账号文件；刷新浏览器不会重新读取。', '切换账号后，重新执行本步、重启 EXE/相关微信服务，再为新账号的内容申请新审批。'] },
        { type: 'cmd', label: '输入自己的 wxid 并写入账号文件', code: String.raw`$dataDir = 'D:\dsh插插\dsh-moments-agent\data'
$account = (Read-Host '输入 WeChatAgent 已核实的 wxid').Trim()
if ($account -notmatch '^wxid_[A-Za-z0-9_]+$') { throw 'wxid 格式不正确，请重新核实' }
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
[IO.File]::WriteAllText((Join-Path $dataDir 'desktop-account.txt'), $account, [Text.UTF8Encoding]::new($false))`, note: '不要打印或分享这个文件。目录必须与 EXE 的 dataDir 一致。' },
      ],
      expected: ['执行器诊断显示预期账号已配置。', '插件可读取当前账号，Reader/Hook 一致，且第 07 步准备时没有 ACCOUNT_MISMATCH。'],
      troubleshoot: [{ problem: 'ACCOUNT_MISMATCH', action: '逐一核对当前微信会话、插件 account 和 desktop-account.txt；检查是否改错了另一个 data 目录。修复后重新启动 EXE、重新审批。' }],
      codes: ['ACCOUNT_MISMATCH'],
    },
    {
      id: 'executor', letter: '05', title: '验收管理员执行器与 OCR',
      summary: '同进程、管理员、OCR、桌面和版本条件逐项核对。',
      goal: 'EXE 已内置执行器和 OCR，不需要另开 Python 执行器。接口能响应只表示服务启动，仍需要验证微信界面与版本适配。',
      prereqs: ['第 04 步账号文件已保存，并已重启 EXE。', '微信在当前桌面登录，桌面未锁定、远程桌面未断开。'],
      blocks: [
        { type: 'ul', items: ['启动 EXE 并允许 UAC。环境自检应显示内置执行器、driver=geometry、管理员=true、OCR=true。', '18765 和 18770 必须属于同一个 EXE 进程；不要另外运行 desktop/server.py。', '把微信恢复为可见窗口，尽量使用已验证的窗口布局和缩放。当前几何导航基线为约 1200×900，仍需通过下一步真实准备截图验收。', '查看「检测版本」与「声明基线」。目前代码基线是 4.1.10.27；本机曾检测到 4.1.15.13。两者不一致时不能把健康通过当成界面适配完成。', '若版本或窗口结构不一致，应先完成对应版本的只准备验收；不要把 --client-version 改成旧版号来宣称新版本已支持。'] },
        { type: 'callout', tone: 'warn', title: '准备成功才是界面操作的证据', text: '管理员与 OCR 自检通过，不能证明点击位置、朋友圈编辑器和发布按钮都匹配。保留 PREPARE_ONLY，先检查第 07 步的真实截图与正文匹配，再决定是否启用发表。' },
        { type: 'cmd', label: '必要时检查执行器日志', code: String.raw`Get-Content 'D:\dsh插插\dsh-moments-agent\data\desktop\executor.log' -Tail 40`, note: '日志路径随 dataDir 改变。分享日志前检查其中的本机路径、账号或正文信息。' },
      ],
      expected: ['管理员=true、OCR=true，内置执行器端口可达且与客户端同 PID。', '微信运行、已登录、桌面可交互且未锁定。', '检测到的微信版本已核对；版本差异在真实准备前保持为待验收。'],
      troubleshoot: [{ problem: 'PRIVILEGE_REQUIRED', action: '完整退出 EXE 后重新启动，在 UAC 中允许。微信与执行器应在同一 Windows 用户会话。' }, { problem: 'OCR_UNAVAILABLE', action: '使用完整解压的新包，保留 _internal 与 OCR 模型。先查看日志中 DLL/模型缺失提示；系统 OCR 回退还依赖 Windows 语言包。' }, { problem: 'CLIENT_VERSION_UNSUPPORTED / EDITOR_NOT_OPENED', action: '核对真实微信版本、窗口尺寸和布局。需要版本适配时先停止发表，在准备模式中修复与验收。' }],
      codes: ['PRIVILEGE_REQUIRED', 'OCR_UNAVAILABLE', 'CLIENT_VERSION_UNSUPPORTED', 'EDITOR_NOT_OPENED'],
    },
    {
      id: 'config', letter: '06', title: '保存完整插件配置并重载',
      summary: '填入自己的地址、路径、模型与账号；先保持只准备。',
      goal: 'DSH profile 的 config 按整行替换，不会深合并。下面是首轮纯文字验收的完整配置骨架；保留你已验证的服务鉴权字段与模型配置。',
      prereqs: ['已记录真实模型、Reader/Hook 地址、账号和 dataDir。', '先备份当前 profile；不要覆盖其中其他插件的配置。'],
      blocks: [
        { type: 'auto-config' },
        { type: 'cmd', label: '备份并打开当前 profile（以 DSH 实际使用的 profile 为准）', code: String.raw`$patch = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\cordis.patch.yml'
Copy-Item -LiteralPath $patch -Destination ($patch + '.' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.bak')
notepad.exe $patch`, note: '使用的不是 desktop profile 时，先在 DSH 设置确认实际配置位置。只编辑 id=dsh-moments-agent 的那一行。' },
        { type: 'cmd', label: '插件行完整骨架：替换占位值后再保存', code: String.raw`- id: dsh-moments-agent
  name: dsh-moments-agent
  config:
    enabled: true
    dataDir: 'D:/dsh插插/dsh-moments-agent/data'
    publishMode: PREPARE_ONLY
    killSwitch: false
    scheduleEnabled: false
    ownerChannel: manual
    llm:
      provider: deepseek-account
      model: deepseek-flash
      timeoutMs: 90000
    wechatAgent:
      enabled: true
      readerBaseUrl: 'http://127.0.0.1:5031'
      hookBaseUrl: 'http://127.0.0.1:30001'
      readerConfigPath: null
      readerTokenFile: null
      hookTokenFile: null
      account: '替换为第04步核实的wxid'
      ownerWxid: '替换为审批所有者的真实ownWxid'
    desktopExecutor:
      enabled: true
      baseUrl: 'http://127.0.0.1:18765'
      tokenFile: 'D:/dsh插插/dsh-moments-agent/data/desktop-token.txt'
      timeoutMs: 120000
    adminServer:
      enabled: true
      port: 18766
      tokenFile: 'D:/dsh插插/dsh-moments-agent/data/admin-token.txt'
    images:
      providers: [manual-subscription, local-import]
      officialApiEnabled: false
      allowNetworkSearch: false
    policy:
      dailyLimit: 2
      minIntervalMinutes: 180
      quietHours: ['23:00', '08:00']
      timeZone: Asia/Singapore
      requireApproval: true
      approvalTtlMinutes: 120
      minScoreToPublish: 0.62
      humanize:
        enabled: false`, note: '替换 account、ownerWxid、模型、路径与服务地址；需要鉴权时用实际 tokenFile 或 readerConfigPath，不能照抄 null。这里 scheduleEnabled=false、humanize.enabled=false，避免配置过程中出现后台创作或自动发送。' },
        { type: 'ul', items: ['保存 YAML，在 DSH 中重载插件或重启 DSH，确认日志没有配置解析错误。本次更新还包含几何驱动的实时账号源适配，必须重载插件让新构建生效；只更新 EXE 不会更新 DSH 内存中的代码。', '回到 EXE 的「设置」，核对读取到的配置：publishMode=PREPARE_ONLY、desktopExecutor 已启用、两个自动化开关均关闭。', '点击本页环境自检。纯文字演练期间「仅准备」是正确模式；不是要求所有项目都变成允许发表。', '如果修改了 EXE 的 dataDir、令牌文件或预期账号，完整重启 EXE；只刷新页面不够。'] },
      ],
      expected: ['DSH 插件重载成功，数据库和模型可用。', 'PREPARE_ONLY 已生效，执行器可达，令牌路径匹配。', '首次手动演练时自主创作与拟人化自动发送都关闭。'],
      troubleshoot: [{ problem: '修改后原有功能消失', action: 'config 是整行替换；从备份合并恢复模型、WeChatAgent 鉴权、人格路径等已有字段。' }, { problem: '界面仍显示旧值', action: '确认编辑的是当前 DSH profile，并已重载插件。客户端连接设置不能修改插件发布模式。' }],
      codes: ['DESKTOP_UNAVAILABLE', 'PUBLISH_MODE_DISABLED'],
    },
    {
      id: 'approval', letter: '07', title: '完成第一条只准备演练',
      summary: '生成 → 审核 → 一次性审批 → 准备 → 人工核对截图。',
      goal: '用一条普通、公开的纯文字内容验证整条链路，停在微信编辑器内。首次配置的关键验收是准备内容正确，不能仅勾选清单。',
      prereqs: ['插件和 EXE 均保持 PREPARE_ONLY，自动发送关闭。', '处于允许操作的时间段，未触发暂停、Kill Switch、每日条数或最小间隔限制。'],
      blocks: [
        { type: 'ul', items: ['在「创作」中输入普通测试主题，生成纯文字草稿。检查生成正文、内容审核结论与公开可见范围。', '仅准备档：审核通过后可以直接准备；审批档：先在「待审批」页核对正文、账号、图片数量、范围与哈希并批准；第三档不创建逐条审批。', '进入该任务详情，点击「准备（不发表）」。保持微信窗口可交互，执行期间不要移动窗口或手动输入。', '查看准备结果和最新截图：微信编辑器已打开，正文逐字匹配，目标账号正确，没有发表。', '确认任务停在 PREPARED。演练结束可以从任务页取消，并在微信里关闭测试编辑器。不要将测试编辑器留给后续自动流程。'] },
        { type: 'callout', tone: 'warn', title: '未通过时停在这里', text: '截图缺失、文字不一致、位置偏移、账号错误或版本未适配时，先修复并重新审批。不要把“服务健康”或“已勾选”当成真实准备成功，也不要为了通过检查关闭 OCR。' },
      ],
      expected: ['任务达到 PREPARED，正文匹配且有可复核截图。', '朋友圈没有产生测试动态，尚未执行发表。', '失败可从具体错误码定位并修复；同一审批不用于修改后的内容。'],
      troubleshoot: [{ problem: '准备被时间策略阻止', action: '核对 Asia/Singapore 或你配置的时区、quietHours、每日上限和最近一条发布时间；等到允许时间，不要临时绕过审批。' }, { problem: 'CONTENT_CHANGED', action: '正文、图片、可见范围或账号改变后重新申请审批。' }, { problem: 'EDITOR_NOT_OPENED / OCR 不匹配', action: '返回第 05 步核对窗口、DPI、微信版本及 OCR；保留截图证据，不进入发表。' }],
      codes: ['CONTENT_CHANGED', 'EDITOR_NOT_OPENED', 'ACCOUNT_MISMATCH'],
    },
    {
      id: 'firstpost', letter: '08', title: '启用发表并完成最终验收',
      summary: '手动确认一条真实内容，再决定是否启用后台调度。',
      goal: '只准备通过后，才能有计划地启用真实发表。配置清单完成不等于已完成真实发布验收；请使用你确实愿意发表的内容。',
      prereqs: ['第 07 步已在当前微信版本、当前窗口布局上验证通过。', '本人能现场核对第一条真实内容及其发表结果。'],
      blocks: [
        { type: 'ul', items: ['完成新版插件重载后，在设置页的「发表模式」选择：仅准备不发表、审批后发表、不审批直接发表。首次真实验收建议选审批档；明确需要免逐条审批时才选第三档。', '点击「应用并同步模式」，确认选项。插件和同进程执行器会同步更新，模式保存在数据库，重启后继续生效；配置文件的默认值不会覆盖已保存的选择。', '环境自检应确认：插件模式与执行器一致。第二/三档 allowPublish=true，第一档 false；账号、OCR、管理员与交互桌面均就绪。', '用你愿意发表的内容完成审核。审批档先批准再发表；免审批档在任务页点击「直接发表」，程序准备并发送该条已审核内容，不再弹出逐条审批。', '同时核对微信朋友圈真实内容、任务/历史记录与截图证据。只有结果被确认，才记录为真实发布验收完成。', '出现 UNCERTAIN 时停止所有重试，先去微信检查，再在任务页核验或人工确认。需撤回时先在微信手动删除已确认的那一条。'] },
        { type: 'cmd', label: '完全退出旧实例后，以允许发表模式启动 EXE', code: String.raw`# 在解压后的 EXE 所在目录打开 PowerShell
Start-Process -FilePath '.\DSH-Moments-Client.exe' -Verb RunAs`, note: '启动后读取插件保存的三级模式并同步执行器；无法同步时保持仅准备。无需单独启动执行器。' },
        { type: 'callout', tone: 'info', title: '日常使用与退出', text: '保持 DSH 和管理员 EXE 运行，微信登录且桌面可交互。每次更新微信、切换账号或修改窗口布局后重新做只准备验收。静默自主发送的现有能力与后续方案见本页下方；本教程不会替你启用；三级模式可在设置中选择。' },
      ],
      expected: ['插件和执行器的发表开关同时正确，审批绑定当前内容与账号。', '第一条真实动态在微信与历史中一致，失败或不确定状态得到人工处理。', '若本次不准备真实发表，保留只准备模式并暂不标记本步通过。'],
      troubleshoot: [{ problem: 'PUBLISH_MODE_DISABLED', action: '在设置页重新应用三级模式，核对插件和执行器模式同步；先重载新版插件。' }, { problem: 'PUBLISH_UNCERTAIN', action: '禁止重复发表。先去微信核对，使用任务页的核验/人工确认收敛。' }, { problem: '微信提示文字未发送', action: '确认微信本身能正常使用、当前会话和客户端版本符合要求；先人工核对是否已发表，再处理失败原因。' }],
      codes: ['PUBLISH_MODE_DISABLED', 'PUBLISH_UNCERTAIN'],
    },
  ];

  const SETUP_ERROR_ROWS = [
    { code: 'TOKEN_MISSING', symptom: '能打开页面但无法读取数据', cause: '客户端管理令牌路径缺失或不可读', fix: '第 01 步核对 tokenFile 与 DSH adminServer.tokenFile；只填写路径，重载插件后重启 EXE。' },
    { code: 'ADMIN_API_UNREACHABLE', symptom: '插件管理 API 无响应', cause: 'DSH 未运行、插件未加载或地址错误', fix: '先打开 DSH 并确认插件启用，检查 18766 与管理地址。' },
    { code: 'WECHAT_ACCOUNT_NOT_VERIFIED', symptom: 'WeChatAgent 无法确认账号', cause: 'Reader/Hook 未就绪、鉴权失败或账号不一致', fix: '第 03 步检查真实服务地址与鉴权文件，第 04 步核对账号。' },
    { code: 'ACCOUNT_MISMATCH', symptom: '准备或发表被账号校验阻止', cause: '当前登录会话、审批账号与预期账号不一致', fix: '修复第 04 步绑定，重启 EXE，再重新审批。' },
    { code: 'DESKTOP_UNAVAILABLE', symptom: '执行器不可用', cause: '未启动、插件未启用执行器或令牌路径不一致', fix: '确认只运行一个管理员 EXE，检查第 05、06 步及 18765。' },
    { code: 'PRIVILEGE_REQUIRED', symptom: '输入操作被拒绝', cause: '未取得管理员权限或不在同一用户会话', fix: '完整退出后允许 UAC，保持微信与 EXE 在同一交互桌面。' },
    { code: 'OCR_UNAVAILABLE', symptom: 'OCR 健康失败', cause: '运行库、模型或系统语言组件缺失', fix: '保留完整 _internal 目录，检查执行器日志；修复后重新准备验收。' },
    { code: 'CLIENT_VERSION_UNSUPPORTED', symptom: '微信界面操作不受支持', cause: '真实版本或界面布局尚未验证', fix: '停用发表，先做对应版本的只准备适配；声明旧基线不代表新版本已经支持。' },
    { code: 'EDITOR_NOT_OPENED', symptom: '没有正确打开编辑器', cause: '窗口、DPI、锁屏、会话或版本不匹配', fix: '保持微信可见、桌面解锁，返回第 05 步核对布局与截图。' },
    { code: 'CONTENT_CHANGED', symptom: '已批准内容校验不通过', cause: '正文、图片、范围或账号已变化', fix: '废弃旧审批，重新核对当前内容并审批。' },
    { code: 'PUBLISH_MODE_DISABLED', symptom: '无法发表', cause: '插件或 EXE 仍为只准备模式', fix: '完成只准备验收后，按第 08 步在设置页应用并同步第二或第三档模式。' },
    { code: 'PUBLISH_UNCERTAIN', symptom: '点击后无法确认结果', cause: '发表结果缺少可靠证据', fix: '停止重试，人工查看朋友圈，再核验或人工确认；不要重复点击。' },
  ];
  const SETUP_SAFETY = [
    '勾选表示你已执行并核对该步骤；服务自检、只准备验收和真实发布验收分别记录，不互相替代。',
    '默认只准备。请在设置中显式选择三级发表模式；审批档保留逐条审批，免审批档仅跳过人工审批。',
    '修改正文、图片、可见范围或账号后重新审批；遇到 UNCERTAIN 先人工核对，不自动重发。',
    '暂停与 Kill Switch 随时可用；每日上限、时间段与间隔按插件配置生效。',
    '令牌与账号文件只保留在本机；教程不会自动批准、发表、删除或开启后台发送。',
    '几何驱动需要登录、解锁的交互桌面；“后台调度”不意味着锁屏也能发或完全不占用鼠标。',
  ];


  // 让“复制命令”在 Windows 剪贴板里保留换行与反斜杠（原样写入）。
  function setupCommandText(step) {
    return (step.blocks || [])
      .filter((block) => block.type === 'cmd')
      .map((block) => block.code)
      .join('\n\n');
  }

  // 首次启动自动配置引导：检测/预览可以自动开始，写入必须二次确认。
  // 主动关闭后按客户端版本记录 localStorage，升级版本后才会再次自动弹出。
  const FIRST_RUN_DISMISS_PREFIX = 'dsh-moments.firstrun-welcome.dismissed.';
  const FIRST_RUN_POLL_INTERVAL_MS = 1500;
  const FIRST_RUN_POLL_LIMIT = 4;

  const ROUTES = {
    dashboard: { title: '概览', subtitle: '系统状态与最近活动' },
    setup: { title: '首次配置', subtitle: '从连接、演练到发表，每一步都有验收依据' },
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
    let raw = '';
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
      raw = await response.text();
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw new ApiError('TIMEOUT', `请求超时（${Math.round(timeout / 1000)} 秒）：${path}`, { kind: 'timeout' });
      }
      throw new ApiError('NETWORK', '无法连接本地客户端服务，请确认 client/server.py 仍在运行。', { kind: 'network' });
    } finally {
      window.clearTimeout(timer);
    }

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
    discovery: (refresh = false) => request('/api/client/discovery' + (refresh ? '?refresh=1' : ''), {timeout:10000}),
    locateControls: () => request('/api/client/locate-controls', {timeout:45000}),
    executorInfo: () => request('/api/client/executor', { timeout: 20000 }),
    setPublishMode: (mode, expectedMode) => request('/api/client/publish-mode', { method: 'POST', headers: { 'X-Requested-With': 'DSHMomentsClient' }, body: { mode, expectedMode }, timeout: 12000 }),
    clientConfig: () => request('/api/client/config', { timeout: 8000 }),
    saveClientConfig: (payload) => request('/api/client/config', { method: 'POST', body: payload }),
    setupState: () => request('/api/client/setup-state', { timeout: 8000 }),
    saveSetupState: (payload) => request('/api/client/setup-state', { method: 'POST', body: payload, timeout: 8000 }),
    autoConfigurePreview: () => request('/api/client/auto-configure', { timeout: 30000 }),
    autoConfigure: (payload) => request('/api/client/auto-configure', { method: 'POST', headers: { 'X-Requested-With': 'DSHMomentsClient' }, body: payload, timeout: 60000 }),
    firstRun: (refresh = false) => request('/api/client/first-run' + (refresh ? '?refresh=1' : ''), { timeout: 15000 }),
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
    automation: () => request('/proxy/api/automation'),
    saveAutomation: (payload) => request('/proxy/api/automation', { method: 'POST', body: payload }),
    writingSkills: () => request('/proxy/api/writing-skills'),
    saveWritingSkills: (payload) => request('/proxy/api/writing-skills', {method:'POST',body:payload}),
    preview: (taskId) => request(`/proxy/api/preview/${encodeURIComponent(taskId)}`),

    chatMemory: () => request('/proxy/api/chat-memory', { timeout: 30000 }),
    saveChatMemorySettings: (payload) => request('/proxy/api/chat-memory/settings', { method: 'POST', body: payload }),
    syncChatMemory: () => request('/proxy/api/chat-memory/sync', { method: 'POST', body: {}, timeout: 245000 }),
    updateChatMember: (impressionId, payload) => request(`/proxy/api/chat-memory/members/${encodeURIComponent(impressionId)}`, { method: 'PATCH', body: payload }),
    deleteChatMember: (impressionId) => request(`/proxy/api/chat-memory/members/${encodeURIComponent(impressionId)}`, { method: 'DELETE' }),
    purgeChatConversation: (conversationKey) => request(`/proxy/api/chat-memory/conversations/${encodeURIComponent(conversationKey)}`, { method: 'DELETE' }),

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
    automationDraft: null,
    automationDirty: false,
    clientSettingsDirty: false,
    personaDraft: null,
    personaDirty: false,
    writingSkillsDirty: false,
    writingSkillsDraft: null,
    setup: {
      data: null,
      available: null,
      error: null,
      loading: false,
      saving: false,
      activeStep: null,
      sessionSkip: false,
      autoOpened: false,
      wizardOpen: false,
      wizardIndex: 0,
      check: { status: 'idle', data: null, error: null, at: 0 },
    },
    firstrun: {
      info: null,
      error: null,
      loading: false,
      promise: null,
      autoOpened: false,
      urlMarker: false,
      applied: null,
      modal: null,
      modalOpen: false,
      pollTimer: null,
      pollCount: 0,
      dismissedThisSession: false,
    },
  };

  let renderSeq = 0;
  let currentRoute = null;
  let pollTimer = null;
  let countdownTimer = null;
  let applying = false;
  let refreshPromise = null;
  let refreshAgain = false;
  let refreshManualQueued = false;
  let settingsWritePromise = null;
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
    // 自定义底部按钮（例如首次启动引导的「稍后 / 手工教程 / 一键自动配置」）。
    // onClick({ close }) 默认在回调后关闭；返回 false 可保持打开。
    const actionButtons = (Array.isArray(config.actions) ? config.actions : []).map((action) => ({
      action,
      node: h('button', {
        class: action.class || 'btn btn-outline',
        type: 'button',
        disabled: Boolean(action.disabled),
        title: action.title || null,
      }, action.iconName ? icon(action.iconName, 16) : null, action.label || ''),
    }));

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
        actionButtons.map((entry) => entry.node),
        config.cancelText === false ? null : cancelBtn,
        config.confirmText === false ? null : confirmBtn,
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

    let closed = false;
    let confirmed = false;
    function close() {
      if (closed) return;
      closed = true;
      busy = false;
      root.classList.remove('open');
      root.replaceChildren();
      activeModal = null;
      if (previousFocus && typeof previousFocus.focus === 'function') {
        try { previousFocus.focus(); } catch { /* 忽略 */ }
      }
      if (!confirmed && typeof config.onCancel === 'function') {
        try { config.onCancel(); } catch (error) { console.error('modal onCancel 回调失败', error); }
      }
      if (typeof config.onClose === 'function') {
        try { config.onClose(); } catch (error) { console.error('modal onClose 回调失败', error); }
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
        confirmed = true;
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
    for (const entry of actionButtons) {
      entry.node.addEventListener('click', () => {
        if (busy) return;
        let keepOpen = false;
        try {
          keepOpen = entry.action.onClick && entry.action.onClick({ close, setBusy }) === false;
        } catch (error) {
          console.error('modal action 回调失败', error);
        }
        if (!keepOpen) close();
      });
    }

    activeModal = { close: () => { if (!busy) close(); }, isBusy: () => busy, trapFocus };
    root.classList.add('open');
    root.replaceChildren(overlay, panel);
    window.requestAnimationFrame(() => {
      let focusTarget = null;
      if (config.requireCheckText) focusTarget = cancelBtn;
      else {
        focusTarget = panel.querySelector('input, textarea, select')
          || (config.cancelText === false ? null : cancelBtn)
          || (actionButtons[0] && actionButtons[0].node)
          || (config.confirmText === false ? null : confirmBtn);
      }
      if (focusTarget) focusTarget.focus();
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
      accountLabel.textContent = accountId ? `${accountId.slice(0, 7)}…${accountId.slice(-4)}` : '账号未确认';
      const chip = $('#account-chip');
      if (chip) chip.title = accountId ? `当前朋友圈账号：${accountId.slice(0, 7)}…${accountId.slice(-4)}` : '尚未确认朋友圈账号';
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
    btn.setAttribute('aria-busy', String(active));
    btn.title = active ? '正在刷新；再次点击会在完成后重新读取' : '重新读取当前页面';
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
      else if (route.name === 'setup') await renderSetup(token);
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

  function hasSettingsEdits() {
    return state.automationDirty || state.clientSettingsDirty || state.personaDirty || state.writingSkillsDirty;
  }

  function discardSettingsEdits() {
    state.automationDraft = null; state.automationDirty = false;
    state.settingsForm = { baseUrl: '', tokenFile: '', dataDir: '' }; state.clientSettingsDirty = false;
    state.personaDraft = null; state.personaDirty = false; state.writingSkillsDirty = false; state.writingSkillsDraft = null;
  }

  function settingsEqual(left, right) {
    if (Object.is(left, right)) return true;
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
    if (Array.isArray(left) !== Array.isArray(right)) return false;
    const keys = Object.keys(left).sort();
    return keys.length === Object.keys(right).length && keys.every((key) =>
      Object.prototype.hasOwnProperty.call(right, key) && settingsEqual(left[key], right[key]));
  }

  async function saveAndReadBack(write, read, matches) {
    if (settingsWritePromise) throw new Error('另一个设置正在保存，请稍后重试');
    ++renderSeq;
    settingsWritePromise = (async () => {
      const result = await write();
      const saved = await read();
      if (!matches(saved, result)) throw new Error('保存后的读回值不一致，请重新读取核对；未报告保存成功');
      return { saved, result };
    })();
    try { return await settingsWritePromise; }
    finally { settingsWritePromise = null; refreshButtonSpin(false); }
  }

  async function refreshCurrent(manual = false, { discardSettings = false } = {}) {
    if (state.exited) return;
    if (settingsWritePromise) {
      if (!manual) return;
      await settingsWritePromise.catch(() => {});
    }
    if (!manual && currentRoute?.name === 'settings' && hasSettingsEdits()) return;
    if (discardSettings && currentRoute?.name === 'settings') discardSettingsEdits();
    if (manual) {
      refreshButtonSpin(true);
      if (currentRoute && currentRoute.name === 'compose' && state.create.running) {
        toast('创作进行中', '一键创作仍在执行，请等待结果返回。', 'info');
        refreshButtonSpin(false);
        return;
      }
    }
    if (refreshPromise) {
      if (manual) {
        refreshAgain = true; refreshManualQueued = true;
        ++renderSeq; // A pre-save response must not overwrite newly saved settings.
      }
      return refreshPromise;
    }
    refreshPromise = (async () => {
      do {
        const explicit = manual || refreshManualQueued;
        refreshAgain = false; refreshManualQueued = false;
        applying = true;
        if (explicit) refreshButtonSpin(true);
        try { await applyRoute(parseRoute(), { silent: true }); }
        finally { applying = false; refreshButtonSpin(false); }
      } while (refreshAgain && !state.exited);
    })().finally(() => { refreshPromise = null; });
    return refreshPromise;
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
      state.create.running ? '正在生成…' : '生成并审核草稿',
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
        state.create.running ? '正在生成…' : '生成并审核草稿',
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
        toast(state.create.result.approval ? '草稿已生成并提交审批' : '草稿审核通过', state.create.result.approval ? '请到待审批页核对正文。' : '可到任务页准备；免审批模式可直接发表。', 'success');
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
    { key: 'approved', label: '待执行', match: (stateValue) => stateValue === 'APPROVED' },
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
    const publishBlocked = !['APPROVAL_REQUIRED', 'POLICY_AUTONOMOUS'].includes(publishMode);
    const publishBlockedReason = publishMode === 'PREPARE_ONLY'
      ? '当前为 PREPARE_ONLY，仅准备图文，不点击发表'
      : publishMode
        ? `当前发布模式为 ${publishMode}，发表会被后端拒绝`
        : '发布模式未知，暂不启用发表';
    return [
      {
        label: '重写并审核', icon: 'spark', enabled: ['IDEA_CREATED', 'DRAFTING', 'DRAFT_READY', 'IMAGE_READY', 'READY_FOR_APPROVAL', 'READY_TO_PUBLISH', 'APPROVED'].includes(stateValue),
        disabledReason: '仅创作和审批阶段可以重写；图片处理中或发布流程中的任务请先完成或取消',
        run: () => openComposeTaskModal(taskId),
      },
      {
        label: '只审核', icon: 'shield', enabled: !terminal && stateValue !== 'UNCERTAIN',
        disabledReason: terminal ? '终态任务不能再审核' : '结果不确定的任务不能审核',
        run: () => openReviewTaskModal(taskId),
      },
      {
        label: '申请审批', icon: 'inbox', enabled: publishMode === 'APPROVAL_REQUIRED' && ['READY_FOR_APPROVAL', 'READY_TO_PUBLISH'].includes(stateValue),
        disabledReason: '仅待审批（READY_FOR_APPROVAL）任务可申请审批',
        run: () => openRequestApprovalModal(taskId),
      },
      {
        label: '准备（不发表）', icon: 'monitor', enabled: stateValue === 'APPROVED' || (publishMode !== 'APPROVAL_REQUIRED' && ['READY_FOR_APPROVAL', 'READY_TO_PUBLISH'].includes(stateValue)),
        disabledReason: '仅已批准（APPROVED）任务可准备朋友圈界面',
        run: () => openPrepareModal(taskId),
      },
      {
        // PREPARE_ONLY 下禁用「发表」，避免让人误以为可以真的发布；
        // openPublishModal 里的后端错误展示路径保持不变（APPROVAL_REQUIRED 等模式下仍会使用）。
        label: publishMode === 'POLICY_AUTONOMOUS' ? '直接发表' : '发表', icon: 'send', enabled: !publishBlocked && (stateValue === 'PREPARED' || (publishMode === 'POLICY_AUTONOMOUS' && ['READY_FOR_APPROVAL', 'READY_TO_PUBLISH', 'APPROVED', 'QUEUED'].includes(stateValue))),
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
    if (stateValue === 'READY_FOR_APPROVAL') parts.push(publishMode === 'APPROVAL_REQUIRED' ? '批准后可准备朋友圈。' : '审核通过，可直接准备。');
    else if (stateValue === 'APPROVED') parts.push('已批准：可准备朋友圈（只填图文，不点击发表）。');
    else if (stateValue === 'PREPARED') parts.push('图文已准备，等待所有者授权发表。');
    if (publishMode === 'PREPARE_ONLY') parts.push('当前为 PREPARE_ONLY：发表已禁用，仅准备图文，不点击发表。');
    else if (publishMode === 'POLICY_AUTONOMOUS') parts.push('当前为不审批直接发表：已审核内容无需逐条审批；仍核对账号、内容哈希与限额。');
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
      h('div', { class: 'modal-warning' }, icon('info', 14), h('span', {}, '会调用模型重写草稿并重新审核；审核通过后按所选发表模式继续。不会准备或发表。')),
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
        if (review.passed) toast('已重写并通过审核', '请按当前发表模式到任务页继续。', 'success');
        else toast('已重写，但审核未通过', (review.notes && review.notes[0]) || '请查看审核说明。', 'warn');
        refreshCurrent(true);
      },
    });
  }

  function openReviewTaskModal(taskId) {
    openModal({
      title: '只重新审核当前草稿？',
      subtitle: '不会重写正文；审核通过后按所选发表模式继续。',
      iconName: 'shield',
      confirmText: '开始审核',
      confirmIcon: 'shield',
      onConfirm: async () => api.review(taskId),
      after: (result) => {
        const review = result && result.review ? result.review : {};
        if (review.passed) toast('审核通过', '请到任务页按当前发表模式继续。', 'success');
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
    const selectedMode = (state.config && state.config.publishMode) || (state.health && state.health.publishMode);
    if (selectedMode === 'POLICY_AUTONOMOUS') {
      api.publish(taskId).then((result) => {
        toast('直接发表已返回', result.message || '请核对发表结果', result.uncertain ? 'warn' : 'success');
        refreshCurrent(true);
      }).catch((error) => { toast('直接发表未完成', describeError(error).detail, 'error'); refreshCurrent(true); });
      return;
    }
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
        text: '当一条内容真正发表并通过核验后，会出现在这里。是否允许发表由设置页的三级模式决定。',
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
   * 13.5 首次配置教程 + 首次运行引导
   * ======================================================================== */
  function emptySetupData() {
    const steps = {};
    for (const id of SETUP_STEP_IDS) steps[id] = false;
    return { version: 1, completed: false, completedAt: null, steps };
  }

  function normalizeSetupData(raw) {
    const base = emptySetupData();
    if (!raw || typeof raw !== 'object') return base;
    base.completed = raw.completed === true;
    base.completedAt = typeof raw.completedAt === 'string' && raw.completedAt !== '' ? raw.completedAt : null;
    const steps = raw.steps && typeof raw.steps === 'object' ? raw.steps : {};
    for (const id of SETUP_STEP_IDS) base.steps[id] = steps[id] === true;
    base.completed = base.completed && SETUP_STEP_IDS.every((id) => base.steps[id]);
    if (!base.completed) base.completedAt = null;
    return base;
  }

  function setupStepById(stepId) {
    return SETUP_STEPS.find((step) => step.id === stepId) || SETUP_STEPS[0];
  }

  function setupStepDone(stepId) {
    return Boolean(state.setup.data && state.setup.data.steps && state.setup.data.steps[stepId] === true);
  }

  function setupDoneCount() {
    if (!state.setup.data) return 0;
    return SETUP_STEP_IDS.filter((id) => state.setup.data.steps[id] === true).length;
  }

  function setupAllDone() {
    return setupDoneCount() >= SETUP_STEP_IDS.length;
  }

  async function loadSetupState({ quiet = true } = {}) {
    if (state.setup.loading) return state.setup.data;
    state.setup.loading = true;
    try {
      const raw = await api.setupState();
      state.setup.data = normalizeSetupData(raw);
      state.setup.available = true;
      state.setup.error = null;
    } catch (error) {
      state.setup.available = false;
      state.setup.error = error;
      if (!state.setup.data) state.setup.data = normalizeSetupData(null);
      if (!quiet) {
        const info = describeError(error);
        toast('配置进度接口不可用', `${info.title}：${info.detail}${info.code ? `（${info.code}）` : ''}`, 'warn');
      }
    } finally {
      state.setup.loading = false;
    }
    return state.setup.data;
  }

  function setupPersistErrorToast(error) {
    const info = describeError(error);
    toast('进度保存失败', `${info.title}：${info.detail}${info.code ? `（${info.code}）` : ''} · 勾选状态已回退，未伪造成功。`, 'error', { duration: 7000 });
  }

  async function toggleSetupStep(stepId, next) {
    if (state.setup.saving || !state.setup.data) return;
    if (!SETUP_STEP_IDS.includes(stepId)) return;
    const previous = {
      steps: { ...state.setup.data.steps },
      completed: state.setup.data.completed,
      completedAt: state.setup.data.completedAt,
    };
    state.setup.data.steps[stepId] = Boolean(next);
    if (!next) state.setup.data.completed = false;
    state.setup.saving = true;
    paintSetupPage();
    renderSetupWizard();
    try {
      const payload = { steps: { [stepId]: Boolean(next) } };
      if (!next && previous.completed) payload.completed = false;
      const saved = await api.saveSetupState(payload);
      state.setup.data = normalizeSetupData(saved);
      state.setup.available = true;
      state.setup.error = null;
      if (next) toast('已记录本步完成', `进度 ${setupDoneCount()}/${SETUP_STEP_IDS.length} 已写入 client/setup-state.json。`, 'success', { duration: 2600 });
    } catch (error) {
      state.setup.data = { ...state.setup.data, ...previous, steps: previous.steps };
      setupPersistErrorToast(error);
    } finally {
      state.setup.saving = false;
      paintSetupPage();
      renderSetupWizard();
    }
  }

  async function markSetupComplete() {
    if (state.setup.saving) return;
    if (!setupAllDone()) {
      toast('还有步骤没有勾选', `当前完成 ${setupDoneCount()}/${SETUP_STEP_IDS.length}，完成全部步骤后才能标记教程完成。`, 'warn');
      return;
    }
    state.setup.saving = true;
    paintSetupPage();
    renderSetupWizard();
    try {
      const saved = await api.saveSetupState({ completed: true });
      state.setup.data = normalizeSetupData(saved);
      state.setup.available = true;
      state.setup.error = null;
      state.setup.wizardIndex = 9;
      state.setup.sessionSkip = true;
      toast('配置教程已完成', '以后启动不会再自动弹出；可以随时从左侧「首次配置」重新打开。', 'success', { duration: 6000 });
    } catch (error) {
      setupPersistErrorToast(error);
    } finally {
      state.setup.saving = false;
      paintSetupPage();
      renderSetupWizard();
    }
  }

  function setupActiveStep() {
    const requested = state.setup.activeStep;
    if (requested && SETUP_STEP_IDS.includes(requested)) return setupStepById(requested);
    const firstUndone = SETUP_STEPS.find((step) => !setupStepDone(step.id));
    return firstUndone || SETUP_STEPS[0];
  }

  function selectSetupStep(stepId, { scroll = false } = {}) {
    if (!SETUP_STEP_IDS.includes(stepId)) return;
    state.setup.activeStep = stepId;
    try { history.replaceState(null, '', `#/setup/${encodeURIComponent(stepId)}`); } catch { /* 忽略 */ }
    paintSetupPage();
    if (scroll) {
      const target = $('.setup-step-detail');
      if (target && typeof target.scrollIntoView === 'function') target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function setupRouteStepId() {
    if (!currentRoute || currentRoute.name !== 'setup') return null;
    const param = routeParam(currentRoute, 0);
    return param && SETUP_STEP_IDS.includes(param) ? param : null;
  }

  function paintSetupPage() {
    if (!currentRoute || currentRoute.name !== 'setup') return;
    const page = $('#page');
    if (!page) return;
    const root = h('div', { class: 'page' });
    root.appendChild(buildSetupHero());
    if (state.setup.data && state.setup.data.completed) root.appendChild(buildSetupCompleteCard());
    const checkHost = h('div', { id: 'setup-check-slot' });
    root.appendChild(checkHost);
    root.appendChild(buildSetupLayout());
    root.appendChild(buildAutonomyPlanCard());
    root.appendChild(buildSetupErrorsCard());
    page.replaceChildren(root);
    renderSetupCheckSlot();
  }

  async function renderSetup(token) {
    const page = $('#page');
    if (page.childElementCount === 0) page.appendChild(pageSkeleton());
    await loadSetupState({ quiet: true });
    if (token !== renderSeq) return;
    const routeStepId = setupRouteStepId();
    if (routeStepId) state.setup.activeStep = routeStepId;
    else if (state.setup.activeStep && !SETUP_STEP_IDS.includes(state.setup.activeStep)) state.setup.activeStep = null;
    paintSetupPage();
    if (state.setup.check.status === 'idle') runSetupSelfCheck();
  }

  function buildSetupHero() {
    const data = state.setup.data || normalizeSetupData(null);
    const done = setupDoneCount();
    const total = SETUP_STEP_IDS.length;
    const percent = Math.round((done / total) * 100);
    const completed = data.completed;
    const available = state.setup.available !== false;
    const actions = h('div', { class: 'setup-hero-actions' });
    const checkBtn = h('button', { class: 'btn btn-outline btn-lg', type: 'button', disabled: state.setup.check.status === 'loading' },
      state.setup.check.status === 'loading' ? h('span', { class: 'spinner' }) : icon('refresh', 16),
      state.setup.check.status === 'loading' ? '检测中…' : '环境自检');
    checkBtn.addEventListener('click', () => runSetupSelfCheck());
    actions.appendChild(checkBtn);
    // 「稍后」只关闭本次引导；任何时候都可以从这里重新打开自动配置引导。
    const autoConfigBtn = h('button', {
      class: 'btn btn-outline btn-lg',
      type: 'button',
      title: '重新打开首次启动引导（只读检测；写入需二次确认）',
    }, icon('sparkles', 16), '自动配置本机环境');
    autoConfigBtn.addEventListener('click', () => { openFirstRunWelcomeManual(); });
    actions.appendChild(autoConfigBtn);
    if (!completed) {
      const completeBtn = h('button', {
        class: 'btn btn-primary btn-lg',
        type: 'button',
        disabled: !setupAllDone() || state.setup.saving,
        title: setupAllDone() ? '标记全部步骤完成' : `还有 ${total - done} 步未勾选`,
      }, state.setup.saving ? h('span', { class: 'spinner' }) : icon('check', 16), '完成配置');
      completeBtn.addEventListener('click', markSetupComplete);
      actions.appendChild(completeBtn);
    } else {
      actions.appendChild(h('a', { class: 'btn btn-primary btn-lg', href: '#/dashboard' }, icon('arrow-right', 16), '进入概览'));
    }

    const eyebrow = h('div', { class: 'hero-eyebrow' }, statusDot(completed ? 'ok' : 'warn'), completed ? 'ONBOARDING · COMPLETED' : 'GET STARTED · 8 STEPS');
    const title = h('h2', { class: 'hero-title' }, completed ? '配置清单已完成，请以验收结果为准。' : '把每一步配置，落到可验证的结果。');
    const desc = h('p', { class: 'hero-desc' }, completed
      ? `全部 ${total} 步已完成${data.completedAt ? `（${fmtDateTime(data.completedAt)}）` : ''}。随时可以回来复习命令与排查方法；真实发布仍受一次性审批与执行器开关约束。`
      : '准备程序 → 模型与人格 → WeChatAgent → 账号绑定 → 执行器验收 → 完整配置 → 只准备演练 → 真实发表。逐步操作、核对，再进入下一步。');

    const progress = h('div', { class: 'setup-progress' },
      h('div', { class: 'setup-progress-head' },
        h('span', {}, completed ? '进度已完成' : '整体进度'),
        h('strong', {}, `${done} / ${total}`),
        h('span', { class: 'setup-progress-percent' }, `${percent}%`),
      ),
      h('div', { class: 'setup-progress-track', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(done) },
        h('i', { style: { width: `${percent}%` } }),
      ),
      h('div', { class: 'setup-progress-meta' },
        completed ? badge('已完成', 'ok') : badge(done === 0 ? '未开始' : '进行中', done === 0 ? 'muted' : 'primary'),
        available ? null : h('span', { class: 'setup-inline-error' }, '进度接口不可用，勾选不会被保存'),
        data.completedAt ? h('span', {}, `完成于 ${fmtDateTime(data.completedAt)}`) : null,
      ),
    );

    const hero = h('section', { class: 'hero setup-hero' },
      h('div', { class: 'hero-main' },
        eyebrow,
        title,
        desc,
        h('div', { class: 'setup-hero-meta' },
          h('span', { class: 'meta-pill' }, icon('terminal', 13), '命令均可一键复制'),
          h('span', { class: 'meta-pill' }, icon('shield', 13), '教程不执行批准/发表等业务写操作'),
          h('span', { class: 'meta-pill' }, icon('layers', 13), '进度保存到 setup-state.json'),
        ),
        progress,
      ),
      actions,
    );
    if (available) return hero;
    const wrap = h('div', { class: 'setup-hero-wrap' }, hero);
    wrap.appendChild(h('div', { class: 'notice danger', style: { marginTop: '14px' } }, icon('alert', 15),
      h('span', {}, `配置进度接口不可用：${describeError(state.setup.error).title}（${describeError(state.setup.error).code || 'UNKNOWN'}）。勾选与完成状态不会被保存，但仍可阅读教程。`),
    ));
    return wrap;
  }

  function buildSetupCompleteCard() {
    const actions = h('div', { class: 'setup-complete-actions' },
      h('a', { class: 'btn btn-primary btn-sm', href: '#/dashboard' }, icon('arrow-right', 14), '进入概览'),
      h('button', {
        class: 'btn btn-outline btn-sm',
        type: 'button',
        onclick: () => selectSetupStep(SETUP_STEPS[0].id, { scroll: true }),
      }, '重看步骤'),
    );
    return h('section', { class: 'card setup-complete-card' },
      h('div', { class: 'card-head' },
        h('div', {}, h('h3', { class: 'card-title' }, icon('shield'), '发表前检查（完成后再读一遍）'), h('p', { class: 'card-sub' }, '教程完成不会开启发送；实际行为由三级发表模式和独立调度开关决定')),
        badge('已完成', 'ok'),
      ),
      h('div', { class: 'card-body' },
        buildSetupList(SETUP_SAFETY, 'setup-expect'),
        actions,
      ),
    );
  }

  function buildSetupLayout() {
    const layout = h('div', { class: 'setup-layout' });
    layout.appendChild(buildSetupStepsCard());
    layout.appendChild(h('div', { class: 'setup-detail-host' }, buildSetupStepDetail(setupActiveStep())));
    return layout;
  }

  function buildSetupStepsCard() {
    const card = h('section', { class: 'card setup-steps-card' });
    const done = setupDoneCount();
    card.appendChild(h('div', { class: 'card-head' },
      h('div', {}, h('h3', { class: 'card-title' }, icon('compass'), '配置步骤'), h('p', { class: 'card-sub' }, `按顺序完成 · ${done}/${SETUP_STEP_IDS.length} 已完成`)),
    ));
    const list = h('div', { class: 'setup-step-list' });
    for (const step of SETUP_STEPS) {
      const isDone = setupStepDone(step.id);
      const isActive = setupActiveStep().id === step.id;
      const item = h('button', {
        class: `setup-step-item${isDone ? ' done' : ''}${isActive ? ' active' : ''}`,
        type: 'button',
        'aria-current': isActive ? 'step' : 'false',
      },
        h('span', { class: 'setup-step-letter' }, isDone ? icon('check', 13) : step.letter),
        h('span', { class: 'setup-step-meta' },
          h('span', { class: 'setup-step-title' }, step.title),
          h('span', { class: 'setup-step-summary' }, step.summary),
        ),
        h('span', { class: `badge badge-${isDone ? 'ok' : isActive ? 'primary' : 'muted'}` }, isDone ? '已完成' : isActive ? '进行中' : '待开始'),
      );
      item.addEventListener('click', () => selectSetupStep(step.id));
      list.appendChild(item);
    }
    card.appendChild(list);
    card.appendChild(h('div', { class: 'setup-step-foot' },
      h('span', {}, '全部勾选后可标记完成'),
      h('div', { class: 'setup-step-foot-actions' },
        !setupAllDone() ? h('button', {
          class: 'btn btn-ghost btn-sm',
          type: 'button',
          onclick: () => {
            const next = SETUP_STEPS.find((step) => !setupStepDone(step.id));
            if (next) selectSetupStep(next.id, { scroll: true });
          },
        }, '跳到下一步') : null,
        h('button', { class: 'btn btn-outline btn-sm', type: 'button', disabled: !setupAllDone() || state.setup.saving, onclick: markSetupComplete }, icon('check', 14), '标记完成'),
      ),
    ));
    return card;
  }

  function buildSetupStepDetail(step) {
    const done = setupStepDone(step.id);
    const index = SETUP_STEPS.findIndex((item) => item.id === step.id);
    const prev = index > 0 ? SETUP_STEPS[index - 1] : null;
    const next = index < SETUP_STEPS.length - 1 ? SETUP_STEPS[index + 1] : null;

    const card = h('section', { class: 'card setup-step-detail' });
    const toggle = h('button', {
      class: `setup-toggle${done ? ' done' : ''}`,
      type: 'button',
      'aria-pressed': done ? 'true' : 'false',
      disabled: state.setup.saving,
      title: done ? '点击取消本步完成标记' : '标记本步已完成',
    }, done ? icon('check', 15) : h('span', { class: 'setup-toggle-dot' }), done ? '已完成' : '标记本步完成');
    toggle.addEventListener('click', () => toggleSetupStep(step.id, !done));

    card.appendChild(h('div', { class: 'setup-detail-head' },
      h('div', { class: 'setup-detail-title-wrap' },
        h('div', { class: 'setup-letter-badge' }, step.letter),
        h('div', {},
          h('div', { class: 'setup-detail-eyebrow' }, `第 ${index + 1} / ${SETUP_STEPS.length} 步`),
          h('h2', { class: 'setup-detail-title' }, step.title),
          h('p', { class: 'setup-detail-summary' }, step.summary),
        ),
      ),
      toggle,
    ));

    const body = h('div', { class: 'setup-detail-body' });
    body.appendChild(h('div', { class: 'setup-goal' }, icon('info', 15), h('p', {}, step.goal)));
    if (Array.isArray(step.prereqs) && step.prereqs.length > 0) {
      body.appendChild(h('div', { class: 'setup-section' },
        h('h4', { class: 'setup-section-title' }, '前置条件'),
        buildSetupList(step.prereqs, 'setup-prereq'),
      ));
    }
    body.appendChild(h('div', { class: 'setup-section' },
      h('h4', { class: 'setup-section-title' }, '操作步骤'),
      (step.blocks || []).map((block) => buildSetupBlock(block)),
    ));
    if (Array.isArray(step.expected) && step.expected.length > 0) {
      body.appendChild(h('div', { class: 'setup-section' },
        h('h4', { class: 'setup-section-title' }, icon('check', 14), '预期的结果'),
        buildSetupList(step.expected, 'setup-expect'),
      ));
    }
    if (Array.isArray(step.troubleshoot) && step.troubleshoot.length > 0) {
      const rows = h('div', { class: 'setup-trouble-list' });
      for (const item of step.troubleshoot) {
        rows.appendChild(h('div', { class: 'setup-trouble-item' },
          h('div', { class: 'setup-trouble-problem' }, icon('alert', 13), h('span', {}, item.problem)),
          h('p', { class: 'setup-trouble-action' }, item.action),
        ));
      }
      body.appendChild(h('div', { class: 'setup-section' },
        h('h4', { class: 'setup-section-title' }, icon('alert', 14), '失败时排查'),
        rows,
      ));
    }
    if (Array.isArray(step.codes) && step.codes.length > 0) {
      body.appendChild(h('div', { class: 'setup-section setup-code-links' },
        h('span', { class: 'setup-code-label' }, '相关错误码'),
        step.codes.map((code) => h('button', {
          class: 'badge badge-muted setup-code-chip',
          type: 'button',
          title: '查看错误速查',
          onclick: () => {
            const details = document.querySelector(`#setup-error-${SETUP_ERROR_ROWS.findIndex((row) => row.code === code)}`);
            if (details) details.open = true;
            if (details && typeof details.scrollIntoView === 'function') details.scrollIntoView({ behavior: 'smooth', block: 'center' });
          },
        }, code)),
      ));
    }
    card.appendChild(body);

    card.appendChild(h('div', { class: 'setup-detail-foot' },
      prev ? h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => selectSetupStep(prev.id, { scroll: true }) }, `← ${prev.letter} ${prev.title}`) : h('span', {}),
      h('div', { class: 'setup-detail-foot-right' },
        h('a', { class: 'btn btn-ghost btn-sm', href: '#/setup', onclick: (event) => { event.preventDefault(); selectSetupStep(SETUP_STEPS[0].id); } }, '回到第一页'),
        next ? h('button', { class: 'btn btn-outline', type: 'button', onclick: () => selectSetupStep(next.id, { scroll: true }) }, `${next.letter} ${next.title}`, icon('chevron', 14)) : null,
      ),
    ));
    return card;
  }

  function buildSetupList(items, className) {
    const list = h('ul', { class: `setup-list ${className}` });
    for (const item of items) {
      list.appendChild(h('li', {}, icon(className === 'setup-expect' ? 'check' : 'chevron', 12), h('span', {}, item)));
    }
    return list;
  }

  function buildSetupBlock(block) {
    if (!block || typeof block !== 'object') return null;
    if (block.type === 'p') return h('p', { class: 'setup-text' }, block.text);
    if (block.type === 'ul') return buildSetupList(block.items || [], 'setup-bullet');
    if (block.type === 'cmd') return buildSetupCmd(block);
    if (block.type === 'auto-config') return buildAutoConfigCard();
    if (block.type === 'callout') {
      const tone = block.tone === 'danger' ? 'danger' : block.tone === 'warn' ? 'warn' : 'info';
      return h('div', { class: `setup-callout ${tone}` },
        icon(tone === 'info' ? 'info' : 'alert', 15),
        h('div', {},
          block.title ? h('strong', {}, block.title) : null,
          h('p', {}, block.text),
        ),
      );
    }
    return null;
  }

  function buildSetupCmd(block) {
    const codeNode = h('code', {});
    codeNode.textContent = block.code;
    const pre = h('pre', { class: 'setup-code' }, codeNode);
    return h('div', { class: 'setup-cmd' },
      h('div', { class: 'setup-cmd-head' },
        h('span', { class: 'setup-cmd-label' }, icon('terminal', 13), block.label || '命令'),
        copyButton(() => block.code, { label: '复制命令', size: 'sm' }),
      ),
      pre,
      block.note ? h('p', { class: 'setup-cmd-note' }, block.note) : null,
    );
  }

  /* -------------------------- 自动配置插件（推荐） --------------------------
   * 首次配置第 06 步的卡片：
   * - 「检测本机环境」只调用只读预览端点（GET；指定 profile 时用 apply=false），不写文件；
   * - 「写入配置（先备份）」必须经过 openModal 二次确认，由后端串行备份 + 原子写入；
   * - 状态只服务这张卡片（含未提交的 profile 输入），不写入 setup-state，也不自动执行；
   * - 所有动态数据只用 h()/textContent 渲染，禁止 innerHTML 拼接。
   * ---------------------------------------------------------------------- */
  const autoConfigView = {
    status: 'idle', // idle | loading | ready | error
    summary: null,
    error: null,
    result: null,
    profileName: '',
  };

  // 核心模块 public_summary 中可能新增的探测字段，只做展示用中文标签。
  const AUTO_CONFIG_EXTRA_LABELS = {
    availableProfiles: '可用 profile',
    patchExisted: '已有配置文件',
    dataDirSource: 'dataDir 来源',
    desktopAccountAction: '执行器账号文件动作',
    pluginRoot: '插件位置',
  };

  function autoConfigModelText(detected) {
    const llm = autoConfigPlainObject(detected.llm);
    const provider = detected.provider || llm.provider || '';
    const model = detected.model || llm.model || '';
    if (provider && model) return `${provider} / ${model}`;
    return model || provider || null;
  }

  const AUTO_CONFIG_FACTS = [
    { key: 'profile', label: 'DSH profile', pick: (summary, detected) => summary.profile || detected.profile },
    { key: 'patchPath', label: '配置文件', pick: (summary) => summary.patchPath },
    {
      key: 'existed',
      label: '插件条目',
      pick: (summary) => {
        if (summary.existed === true) return '已有条目 → 整块替换';
        if (summary.existed === false) return '没有条目 → 追加到末尾';
        return null;
      },
    },
    { key: 'pluginRoot', label: '插件位置', pick: (_summary, detected) => detected.pluginRoot || detected.pluginPath || detected.packageRoot },
    { key: 'dataDir', label: '数据目录', pick: (summary, detected) => detected.dataDir || summary.dataDir },
    {
      key: 'readerBaseUrl',
      label: 'Reader 地址',
      pick: (_summary, detected) => detected.readerBaseUrl
        || (detected.wechatAgent && detected.wechatAgent.readerBaseUrl) || detected.readerUrl || detected.readerURL,
    },
    {
      key: 'hookBaseUrl',
      label: 'Hook 地址',
      pick: (_summary, detected) => detected.hookBaseUrl
        || (detected.wechatAgent && detected.wechatAgent.hookBaseUrl) || detected.hookUrl || detected.hookURL,
    },
    {
      key: 'account',
      label: '微信账号（掩码）',
      pick: (_summary, detected) => detected.account
        || (detected.wechatAgent && (detected.wechatAgent.account || detected.wechatAgent.ownerWxid)) || detected.ownerWxid,
    },
    { key: 'model', label: '模型', pick: (_summary, detected) => autoConfigModelText(detected) },
    { key: 'desktopAccountPath', label: '执行器账号文件', pick: (summary, detected) => detected.desktopAccountPath || summary.desktopAccountPath },
  ];

  function autoConfigText(value) {
    if (value === null || value === undefined || value === '') return '—';
    if (typeof value === 'boolean') return value ? '是' : '否';
    if (Array.isArray(value)) return value.length ? value.map((item) => autoConfigText(item)).join('、') : '—';
    if (typeof value === 'object') {
      try { return JSON.stringify(value); } catch { return '—'; }
    }
    return String(value);
  }

  function autoConfigPlainObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function autoConfigFacts(summary) {
    const detected = autoConfigPlainObject(summary && summary.detected);
    const rows = [];
    const used = new Set();
    for (const fact of AUTO_CONFIG_FACTS) {
      let value = null;
      try { value = fact.pick(summary, detected); } catch { value = null; }
      used.add(fact.key);
      const text = autoConfigText(value);
      if (text !== '—') rows.push({ label: fact.label, value: text });
    }
    // 契约外新增的检测字段也展示出来；嵌套对象不铺开，避免界面被长 JSON 淹没。
    for (const [key, value] of Object.entries(detected)) {
      if (used.has(key)) continue;
      if (value && typeof value === 'object' && !Array.isArray(value)) continue;
      const text = autoConfigText(value);
      if (text !== '—') rows.push({ label: AUTO_CONFIG_EXTRA_LABELS[key] || key, value: text });
    }
    return rows;
  }

  function autoConfigStatusBadge() {
    const view = autoConfigView;
    if (view.status === 'loading') return badge('检测中', 'primary');
    if (view.status === 'error') return badge('检测失败', 'danger');
    const summary = autoConfigPlainObject(view.summary);
    const errors = Array.isArray(summary.errors) ? summary.errors : [];
    if (Object.keys(autoConfigPlainObject(view.result)).length > 0) return badge('已写入 · 待重启', 'warn');
    if (Object.keys(summary).length > 0) return badge(errors.length > 0 ? '需要处理' : '检测完成 · 未写入', errors.length > 0 ? 'danger' : 'ok');
    return badge('未检测', 'muted');
  }

  function buildAutoConfigGrid(rows) {
    return h('div', { class: 'auto-config-grid' },
      rows.map((row) => h('div', { class: 'auto-config-row' },
        h('span', { class: 'auto-config-key' }, row.label),
        h('span', { class: 'auto-config-val' }, row.value),
      )));
  }

  function buildAutoConfigMessages(items, tone, label) {
    const values = (Array.isArray(items) ? items : []).map((item) => autoConfigText(item)).filter((text) => text !== '—');
    if (values.length === 0) return null;
    return h('div', { class: `auto-config-messages ${tone}` },
      h('div', { class: 'auto-config-messages-title' }, icon(tone === 'danger' ? 'alert' : 'info', 13), label),
      h('ul', {}, values.map((text) => h('li', {}, text))),
    );
  }

  function buildAutoConfigBlock(summary) {
    const block = typeof summary.block === 'string' ? summary.block : '';
    if (!block) return null;
    const pre = h('pre', { class: 'auto-config-pre' });
    pre.textContent = block; // 只读文本预览；不解析 YAML，也不拼 HTML
    return h('details', { class: 'auto-config-block' },
      h('summary', {}, '展开将要写入的 YAML 条目（只读；含路径，不含令牌）'),
      pre,
    );
  }

  function buildAutoConfigApplied(result = autoConfigView.result, summary = autoConfigView.summary) {
    const applied = autoConfigPlainObject(result);
    const summaryBackup = autoConfigPlainObject(summary).backupPath;
    const rawBackup = applied.backupPath || summaryBackup || '';
    const backupPath = autoConfigText(rawBackup) !== '—' ? String(rawBackup) : '';
    const clientConfig = autoConfigPlainObject(applied.clientConfig);
    return h('div', { class: 'auto-config-applied' },
      h('div', { class: 'auto-config-applied-head' }, icon('check', 16),
        h('strong', {}, '配置已写入，但还没有生效'),
        badge('需重启 DSH', 'warn')),
      h('p', { class: 'auto-config-applied-text' }, '请完全退出并重新启动 DSH（或在 DSH 中重载 dsh-moments-agent 插件）后，新配置才会被读取。本向导不会替你重启 DSH，也不会假装已生效。'),
      backupPath
        ? h('div', { class: 'auto-config-backup' },
          h('span', { class: 'auto-config-backup-label' }, '备份文件'),
          h('code', {}, backupPath),
          copyButton(() => backupPath, { label: '复制路径', size: 'sm' }))
        : h('p', { class: 'auto-config-warn-text' }, '后端没有返回备份路径；请先到 profile 目录确认 .bak 文件存在，再重启 DSH。'),
      clientConfig.updated === true
        ? modalSection('客户端连接配置（已自动更新）', h('div', { class: 'modal-rows' },
          modalRow('baseUrl', h('span', { class: 'mono' }, autoConfigText(clientConfig.baseUrl))),
          modalRow('tokenFile', h('span', { class: 'mono' }, autoConfigText(clientConfig.tokenFile))),
          modalRow('dataDir', h('span', { class: 'mono' }, autoConfigText(clientConfig.dataDir))),
        ))
        : null,
      clientConfig.updated === false
        ? h('p', { class: 'auto-config-warn-text' }, '客户端连接配置没有自动更新（没有从检测结果确定插件 dataDir）；请到「设置 → 客户端配置」手动填写令牌路径与数据目录。')
        : null,
      h('p', { class: 'auto-config-hint' }, icon('info', 13),
        h('span', {}, '回退方式：先关闭 DSH，把上面这个 .bak 文件复制回 cordis.patch.yml（或删掉新增的插件条目），再重新启动 DSH。')),
    );
  }

  /** 自动配置写入的统一二次确认 Modal；首次启动引导与第 06 步卡片共用。 */
  function confirmAutoConfigureApply({ summary, profileName = '', onApplied = null, onCancel = null }) {
    const detected = autoConfigPlainObject(summary.detected);
    const patchPath = autoConfigText(summary.patchPath) !== '—' ? String(summary.patchPath) : '检测结果中的 profile 配置文件';
    const content = [
      h('div', { class: 'modal-warning' }, icon('alert', 14),
        h('span', {}, '写入会替换该 profile 中 dsh-moments-agent 的整条配置；其他插件条目、注释与 !!js 不会被改动。写入前会自动备份原文件，但必须重启 DSH 后才生效。')),
      modalSection('写入摘要', h('div', { class: 'modal-rows' },
        modalRow('DSH profile', autoConfigText(summary.profile || profileName)),
        modalRow('配置文件', h('span', { class: 'mono' }, patchPath)),
        modalRow('插件条目', autoConfigText(summary.existed === true ? '已有条目 → 整块替换'
          : summary.existed === false ? '没有条目 → 追加到文件末尾' : null)),
        modalRow('数据目录', autoConfigText(detected.dataDir || detected.data_dir || summary.dataDir)),
        modalRow('模型', autoConfigText(autoConfigModelText(detected))),
      )),
      h('div', { class: 'modal-warning' }, icon('shield', 14),
        h('span', {}, '不会写入 Reader/Hook 令牌正文、密码或聊天内容，也不会修改 WeChatAgent 的任何配置或文件。写入成功后，客户端连接配置也会指向检测到的 dataDir 与 admin-token.txt。')),
      profileName && !summary.profile
        ? h('p', { class: 'field-help' }, `将按 profile「${profileName}」重新检测后写入。`)
        : null,
    ];
    openModal({
      title: '写入插件配置（先备份）？',
      subtitle: '写入后需要重启 DSH 或重载插件才会生效。',
      iconName: 'shield',
      tone: 'warn',
      content,
      confirmText: '备份并写入',
      confirmIcon: 'check',
      requireCheckText: '我已核对预览，确认写入该 profile 的 dsh-moments-agent 条目。',
      onConfirm: async () => {
        const payload = { apply: true };
        const profile = summary.profile || String(profileName || '').trim();
        if (profile) payload.profile = profile;
        return api.autoConfigure(payload);
      },
      after: (data) => {
        const result = autoConfigPlainObject(data);
        if (typeof onApplied === 'function') onApplied(result);
      },
      onCancel: typeof onCancel === 'function' ? onCancel : null,
    });
  }

  function openAutoConfigApplyModal(render) {
    const summary = autoConfigPlainObject(autoConfigView.summary);
    if (Object.keys(summary).length === 0) {
      toast('请先检测本机环境', '没有可写入的预览结果，未执行任何写入。', 'warn');
      return;
    }
    confirmAutoConfigureApply({
      summary,
      profileName: autoConfigView.profileName,
      onApplied: (result) => {
        autoConfigView.result = result;
        autoConfigView.summary = { ...autoConfigPlainObject(autoConfigView.summary), ...autoConfigView.result };
        autoConfigView.status = 'ready';
        render();
        const backup = autoConfigText(autoConfigView.result.backupPath) !== '—'
          ? `备份：${autoConfigView.result.backupPath}` : '请到 profile 目录核对 .bak 备份。';
        toast('配置已写入', `${backup}；重启 DSH 后生效。`, 'success', { duration: 9000 });
      },
    });
  }

  async function detectAutoConfig(render) {
    if (autoConfigView.status === 'loading') return;
    autoConfigView.status = 'loading';
    autoConfigView.error = null;
    autoConfigView.result = null;
    render();
    try {
      const profileName = String(autoConfigView.profileName || '').trim();
      // 默认 GET（只读检测）；指定 profile 时用 apply=false 重新检测，两者都绝不写文件。
      const data = profileName
        ? await api.autoConfigure({ profile: profileName, apply: false })
        : await api.autoConfigurePreview();
      autoConfigView.summary = autoConfigPlainObject(data);
      autoConfigView.status = 'ready';
      toast('检测完成（未写文件）', `profile：${autoConfigText(autoConfigView.summary.profile)}。请先核对预览，再决定是否写入。`, 'success', { duration: 6000 });
    } catch (error) {
      autoConfigView.status = 'error';
      autoConfigView.error = error;
      autoConfigView.summary = null;
      const info = describeError(error);
      toast('自动配置检测失败', `${info.title}：${info.detail}${info.code ? `（${info.code}）` : ''}`, 'error', { duration: 8000 });
    } finally {
      render();
    }
  }

  function buildAutoConfigError() {
    const info = describeError(autoConfigView.error);
    return h('div', { class: 'auto-config-error' },
      h('div', { class: 'auto-config-error-title' }, icon('alert', 14), info.title),
      h('p', { class: 'auto-config-error-msg' }, info.detail || '没有更多错误信息。'),
      info.code ? h('code', { class: 'auto-config-error-code' }, String(info.code)) : null,
      h('p', { class: 'auto-config-hint' }, icon('info', 13),
        h('span', {}, '自动配置依赖 DSH profile 与 WeChatAgent 探测；失败时不会写入任何文件，可以继续按下方手工教程完成配置。')),
    );
  }

  function buildAutoConfigCard() {
    const card = h('div', { class: 'auto-config-card' });
    const host = h('div', { class: 'auto-config-content' });
    card.appendChild(host);

    const render = () => {
      const view = autoConfigView;
      const summary = autoConfigPlainObject(view.summary);
      const hasSummary = Object.keys(summary).length > 0;
      const errors = Array.isArray(summary.errors) ? summary.errors.filter((item) => autoConfigText(item) !== '—') : [];
      const loading = view.status === 'loading';
      const applied = Object.keys(autoConfigPlainObject(view.result)).length > 0;

      const profileInput = h('input', {
        class: 'input auto-config-profile-input',
        type: 'text',
        placeholder: 'profile（留空自动检测）',
        value: view.profileName || '',
        autocomplete: 'off',
        spellcheck: 'false',
        'aria-label': 'DSH profile 名称（可选）',
      });
      profileInput.addEventListener('input', () => { autoConfigView.profileName = profileInput.value; });

      const detectBtn = h('button', {
        class: 'btn btn-outline btn-sm',
        type: 'button',
        disabled: loading,
        onclick: () => detectAutoConfig(render),
      }, loading ? h('span', { class: 'spinner' }) : icon('refresh', 14),
        loading ? '检测中…' : hasSummary ? '重新检测' : '检测本机环境');

      const writeBtn = h('button', {
        class: 'btn btn-primary btn-sm',
        type: 'button',
        disabled: loading || !hasSummary || errors.length > 0,
        title: !hasSummary ? '请先检测本机环境并核对预览'
          : errors.length > 0 ? '预览中存在未解决的问题，已禁止写入' : '二次确认后自动备份并写入',
        onclick: () => openAutoConfigApplyModal(render),
      }, icon('shield', 14), '写入配置（先备份）');

      const head = h('div', { class: 'auto-config-head' },
        h('div', { class: 'auto-config-head-main' },
          h('h4', { class: 'auto-config-title' }, icon('sparkles', 17), '自动配置插件（推荐）'),
          h('p', { class: 'auto-config-sub' }, '只读检测本机 DSH profile 与 WeChatAgent，生成并预览 cordis.patch.yml 的插件条目；写入前自动备份，只有二次确认后才会执行。'),
        ),
        h('div', { class: 'auto-config-actions' },
          h('label', { class: 'auto-config-profile' }, 'profile', profileInput),
          h('span', {}, autoConfigStatusBadge()),
          detectBtn,
          writeBtn,
        ),
      );

      const bodyChildren = [];
      if (loading) {
        bodyChildren.push(h('div', { class: 'auto-config-loading' }, h('span', { class: 'spinner' }), '正在检测本机环境（只读，不会写文件）…'));
      } else if (view.status === 'error') {
        bodyChildren.push(buildAutoConfigError());
      } else if (!hasSummary) {
        bodyChildren.push(h('p', { class: 'auto-config-hint' }, icon('info', 13),
          h('span', {}, '点击「检测本机环境」先预览将要写入的配置；检测和预览都不会修改任何文件。多 profile 环境可在左上角输入 profile 名称后重新检测。')));
      } else {
        if (applied) bodyChildren.push(buildAutoConfigApplied());
        bodyChildren.push(h('div', { class: 'auto-config-status-line' },
          badge(applied ? '已写入 · 待重启 DSH' : '只读预览 · 未写入', applied ? 'warn' : 'ok', false),
          h('span', { class: 'auto-config-muted' }, applied ? '写入成功后请重启 DSH，再继续第 07 步演练。' : '以下内容尚未写入任何文件；核对无误后再点击「写入配置（先备份）」。'),
        ));
        bodyChildren.push(buildAutoConfigGrid(autoConfigFacts(summary)));
        if (Array.isArray(summary.changedFields) && summary.changedFields.length > 0) {
          bodyChildren.push(h('div', { class: 'auto-config-changed' },
            h('span', { class: 'auto-config-changed-label' }, '相对现有配置的变化'),
            summary.changedFields.map((field) => h('span', { class: 'auto-config-chip' }, autoConfigText(field))),
          ));
        } else {
          bodyChildren.push(h('p', { class: 'auto-config-muted' }, '没有检测到相对现有配置的变化字段；写入仍会按本次生成的条目整块重建。'));
        }
        const warnNode = buildAutoConfigMessages(summary.warnings, 'warn', 'warnings · 警告（不中断流程，但需要你确认）');
        const errorNode = buildAutoConfigMessages(summary.errors, 'danger', 'errors · 错误（存在阻断性问题，修复前不能写入）');
        if (warnNode) bodyChildren.push(warnNode);
        if (errorNode) bodyChildren.push(errorNode);
        const blockNode = buildAutoConfigBlock(summary);
        if (blockNode) bodyChildren.push(blockNode);
        bodyChildren.push(h('p', { class: 'auto-config-hint' }, icon('shield', 13),
          h('span', {}, '预览与写入都不包含 Reader/Hook 令牌正文、密码或聊天内容；只修改选中的 profile，不碰其他插件条目。')));
      }
      if (hasSummary || view.status === 'error') {
        bodyChildren.push(h('p', { class: 'auto-config-hint' }, icon('terminal', 13),
          h('span', {}, '自动配置失败或字段缺失时，可继续使用下方手工教程完成配置；手工教程始终完整保留。')));
      }

      host.replaceChildren(head, h('div', { class: 'auto-config-body' }, bodyChildren));
    };

    render();
    return card;
  }

  /* -------------------- 首次启动自动配置引导（欢迎 Modal） -------------------- */
  // 只读检测可以自动开始并自动弹出；任何写入都必须经过 confirmAutoConfigureApply 的二次确认。
  // 接口不可用时降级为手工教程提示，不阻塞进入应用，也不静默写文件。

  function firstRunDismissKey() {
    const version = (state.client && state.client.version) || 'unknown';
    return `${FIRST_RUN_DISMISS_PREFIX}${version}`;
  }

  function firstRunWelcomeDismissed() {
    try { return window.localStorage.getItem(firstRunDismissKey()) === '1'; } catch { return false; }
  }

  function rememberFirstRunDismiss() {
    state.firstrun.dismissedThisSession = true;
    try { window.localStorage.setItem(firstRunDismissKey(), '1'); } catch { /* 隐私模式：仅本次会话不再弹 */ }
  }

  async function loadFirstRunInfo({ refresh = false } = {}) {
    if (state.firstrun.loading && state.firstrun.promise) return state.firstrun.promise;
    state.firstrun.loading = true;
    const promise = (async () => {
      try {
        const payload = await api.firstRun(refresh);
        state.firstrun.info = autoConfigPlainObject(payload);
        state.firstrun.error = null;
        return state.firstrun.info;
      } catch (error) {
        state.firstrun.error = error;
        return null;
      } finally {
        state.firstrun.loading = false;
        state.firstrun.promise = null;
      }
    })();
    state.firstrun.promise = promise;
    return promise;
  }

  function firstRunPending(info) {
    const hasApplied = Object.keys(autoConfigPlainObject(state.firstrun.applied)).length > 0;
    return Boolean(info && info.firstRun === true && info.needsAutoConfigure === null && !hasApplied);
  }

  function firstRunApplyEnabled(info) {
    const summary = autoConfigPlainObject(info && info.autoConfigure);
    const errors = Array.isArray(summary.errors) ? summary.errors : [];
    return Boolean(
      info && info.firstRun === true && info.needsAutoConfigure === true
      && errors.length === 0 && Object.keys(summary).length > 0,
    );
  }

  function stopFirstRunPolling() {
    if (state.firstrun.pollTimer !== null) {
      window.clearTimeout(state.firstrun.pollTimer);
      state.firstrun.pollTimer = null;
    }
  }

  // 检测 pending 时前端自动重试（最多 FIRST_RUN_POLL_LIMIT 次）；期间弹窗保持加载态。
  function scheduleFirstRunPoll() {
    if (state.firstrun.pollTimer !== null) return;
    if (state.firstrun.pollCount >= FIRST_RUN_POLL_LIMIT) return;
    state.firstrun.pollTimer = window.setTimeout(async () => {
      state.firstrun.pollTimer = null;
      state.firstrun.pollCount += 1;
      if (!state.firstrun.modal || !state.firstrun.modalOpen) return;
      await loadFirstRunInfo();
      if (!state.firstrun.modal || !state.firstrun.modalOpen) return;
      if (firstRunPending(state.firstrun.info) && state.firstrun.pollCount < FIRST_RUN_POLL_LIMIT) {
        scheduleFirstRunPoll();
        return;
      }
      state.firstrun.pollCount = 0;
      renderFirstRunWelcome();
    }, FIRST_RUN_POLL_INTERVAL_MS);
  }

  function closeFirstRunModal() {
    stopFirstRunPolling();
    const modal = state.firstrun.modal;
    state.firstrun.modal = null;
    state.firstrun.modalOpen = false;
    if (modal) modal.close();
  }

  function goToManualConfigTutorial() {
    const target = '#/setup/config';
    if (String(location.hash || '') === target && currentRoute && currentRoute.name === 'setup') {
      selectSetupStep('config', { scroll: true });
      return;
    }
    location.hash = target;
  }

  function buildFirstRunBody(info) {
    const body = h('div', { class: 'firstrun-body' });
    const summary = autoConfigPlainObject(info && info.autoConfigure);
    const applied = autoConfigPlainObject(state.firstrun.applied);
    if (Object.keys(applied).length > 0) {
      body.appendChild(buildAutoConfigApplied(applied, applied));
      body.appendChild(h('p', { class: 'auto-config-hint' }, icon('info', 13),
        h('span', {}, '客户端连接配置已指向检测到的 dataDir 与管理令牌路径；若「设置 → 客户端配置」仍显示旧值，刷新页面即可。')));
      return body;
    }
    if (state.firstrun.error) {
      const errorInfo = describeError(state.firstrun.error);
      body.appendChild(h('div', { class: 'notice warn' }, icon('alert', 15),
        h('span', {}, `首次启动接口不可用：${errorInfo.title}${errorInfo.code ? `（${errorInfo.code}）` : ''}。可以先继续使用应用，或按手工教程完成配置；不会静默写入任何文件。`)));
      body.appendChild(h('p', { class: 'auto-config-hint' }, icon('terminal', 13),
        h('span', {}, '自动配置失败不影响手动配置；第 06 步「自动配置插件」卡片与完整手工教程仍然可用。')));
      return body;
    }
    if (!info || Object.keys(info).length === 0) {
      body.appendChild(h('div', { class: 'auto-config-loading' }, h('span', { class: 'spinner' }), '正在读取首次启动状态…'));
      return body;
    }
    if (info.firstRun !== true) {
      body.appendChild(h('div', { class: 'notice' }, icon('check', 15),
        h('span', {}, '首次配置已完成。如需重新写入插件配置，可到第 06 步「完整配置」使用自动配置卡片重新检测；检测与预览不会写文件。')));
      return body;
    }
    if (firstRunPending(info)) {
      body.appendChild(h('div', { class: 'auto-config-loading' }, h('span', { class: 'spinner' }),
        '正在后台检测本机 DSH profile 与 WeChatAgent（只读，不会写入任何文件）…'));
      body.appendChild(h('p', { class: 'auto-config-hint' }, icon('info', 13),
        h('span', {}, '检测最多约 5 秒；较慢时会先返回加载态，本弹窗会自动重试。你也可以先点「按教程手动配置」。')));
      return body;
    }
    if (Object.keys(summary).length === 0 || info.needsAutoConfigure !== true) {
      const reason = autoConfigText(info.reason) !== '—' ? String(info.reason) : '检测结果不完整';
      body.appendChild(h('div', { class: 'notice warn' }, icon('alert', 15),
        h('span', {}, `自动配置暂不可用：${reason}。可以继续使用应用，或按手工教程完成配置；不会静默写入任何文件。`)));
      body.appendChild(h('p', { class: 'auto-config-hint' }, icon('terminal', 13),
        h('span', {}, '第 06 步的完整手工教程始终保留，可随时回退。')));
      return body;
    }

    body.appendChild(h('p', { class: 'firstrun-lead' },
      '这台机器还没有完成首次配置。下面是只读检测结果，',
      h('strong', {}, '还没有写入任何文件'),
      '；点「一键自动配置（先备份）」后会先弹出二次确认，勾选确认后才备份并写入。'));
    body.appendChild(buildAutoConfigGrid(autoConfigFacts(summary)));
    if (Array.isArray(summary.changedFields) && summary.changedFields.length > 0) {
      body.appendChild(h('div', { class: 'auto-config-changed' },
        h('span', { class: 'auto-config-changed-label' }, '相对现有配置的变化'),
        summary.changedFields.map((field) => h('span', { class: 'auto-config-chip' }, autoConfigText(field))),
      ));
    }
    const warnNode = buildAutoConfigMessages(summary.warnings, 'warn', 'warnings · 警告（不中断流程，但需要你确认）');
    const errorNode = buildAutoConfigMessages(summary.errors, 'danger', 'errors · 错误（存在阻断性问题，修复前不能写入）');
    if (warnNode) body.appendChild(warnNode);
    if (errorNode) body.appendChild(errorNode);
    const blockNode = buildAutoConfigBlock(summary);
    if (blockNode) body.appendChild(blockNode);
    body.appendChild(h('div', { class: 'modal-warning' }, icon('alert', 14),
      h('span', {}, '写入只替换该 profile 里 dsh-moments-agent 的整条配置，其他插件条目、注释与 !!js 不动；写前自动备份，写入后必须重启 DSH 才生效。不会写入 Reader/Hook 令牌正文。')));
    return body;
  }

  function renderFirstRunWelcome() {
    stopFirstRunPolling();
    const previous = state.firstrun.modal;
    state.firstrun.modal = null;
    state.firstrun.modalOpen = false;
    if (previous) previous.close();

    const info = state.firstrun.info;
    const applied = Object.keys(autoConfigPlainObject(state.firstrun.applied)).length > 0;
    const pending = firstRunPending(info);
    const completed = Boolean(info && info.firstRun !== true);
    const applyEnabled = firstRunApplyEnabled(info);
    const actions = [];
    if (applied) {
      actions.push({ label: '查看手工教程', class: 'btn btn-outline', iconName: 'terminal', onClick: goToManualConfigTutorial });
      actions.push({ label: '关闭', class: 'btn btn-primary', iconName: 'check' });
    } else if (completed) {
      actions.push({ label: '前往第 06 步', class: 'btn btn-outline', iconName: 'terminal', onClick: goToManualConfigTutorial });
      actions.push({ label: '关闭', class: 'btn btn-primary' });
    } else {
      actions.push({
        label: '稍后',
        class: 'btn btn-ghost',
        onClick: () => {
          rememberFirstRunDismiss();
          toast('可以先跳过', '下次启动不会再自动弹出；可随时在「首次配置」页重新打开自动配置引导。', 'info', { duration: 5000 });
        },
      });
      actions.push({ label: '按教程手动配置', class: 'btn btn-outline', iconName: 'terminal', onClick: goToManualConfigTutorial });
      if (pending) {
        actions.push({
          label: '重新检测',
          class: 'btn btn-outline',
          iconName: 'refresh',
          onClick: () => {
            state.firstrun.pollCount = 0;
            loadFirstRunInfo({ refresh: true }).then(() => {
              if (state.firstrun.modalOpen) renderFirstRunWelcome();
            });
            return false; // 保持弹窗，检测完成后原地替换
          },
        });
      } else {
        actions.push({
          label: '一键自动配置（先备份）',
          class: 'btn btn-primary',
          iconName: 'shield',
          disabled: !applyEnabled,
          title: applyEnabled
            ? '先弹出二次确认；确认后才备份并写入，绝不静默写文件'
            : '当前检测结果不满足自动写入条件，请按手工教程配置',
          onClick: () => {
            closeFirstRunModal();
            openFirstRunApplyConfirm();
            return false;
          },
        });
      }
    }

    const modal = openModal({
      title: applied ? '自动配置已完成' : completed ? '本机自动配置' : '欢迎使用 DSH Moments Agent',
      subtitle: applied ? '配置已写入；重启 DSH 后生效' : '首次启动 · 只读检测，写入前必须二次确认',
      iconName: applied ? 'check' : 'sparkles',
      tone: applied ? undefined : 'warn',
      content: [buildFirstRunBody(info)],
      actions,
      cancelText: false,
      confirmText: false,
      footerNote: applied ? '不会自动重启 DSH' : '检测与预览不会写文件',
      onClose: () => {
        state.firstrun.modalOpen = false;
        state.firstrun.modal = null;
        stopFirstRunPolling();
      },
    });
    state.firstrun.modal = modal;
    state.firstrun.modalOpen = Boolean(modal);
    if (pending && modal) scheduleFirstRunPoll();
  }

  function maybeOpenFirstRunWelcome() {
    const info = state.firstrun.info;
    if (!info || info.firstRun !== true) return false;
    if (firstRunWelcomeDismissed() || state.firstrun.dismissedThisSession) return false;
    if (state.firstrun.autoOpened) return false;
    if (currentRoute && currentRoute.name !== 'dashboard') return false;
    state.firstrun.autoOpened = true;
    renderFirstRunWelcome();
    return true;
  }

  async function openFirstRunWelcomeManual() {
    state.firstrun.dismissedThisSession = false;
    const needsRefresh = !state.firstrun.info || Boolean(state.firstrun.error);
    await loadFirstRunInfo({ refresh: needsRefresh });
    renderFirstRunWelcome();
  }

  function openFirstRunApplyConfirm() {
    const info = state.firstrun.info || {};
    const summary = autoConfigPlainObject(info.autoConfigure);
    if (!firstRunApplyEnabled(info)) {
      toast('自动配置不可用', '没有可写入的检测结果，未执行任何写入；请按教程手动配置。', 'warn');
      return;
    }
    confirmAutoConfigureApply({
      summary,
      profileName: '',
      // 取消/关闭二次确认时回到欢迎引导，不静默写入任何文件。
      onCancel: () => renderFirstRunWelcome(),
      onApplied: (result) => {
        state.firstrun.applied = autoConfigPlainObject(result);
        state.firstrun.pollCount = 0;
        // 已写入后不再每次启动自动弹出；仍可从「首次配置」页重新打开。
        rememberFirstRunDismiss();
        const backup = autoConfigText(state.firstrun.applied.backupPath) !== '—'
          ? `备份：${state.firstrun.applied.backupPath}` : '请到 profile 目录核对 .bak 备份。';
        toast('配置已写入', `${backup}；请重启 DSH 后生效。`, 'success', { duration: 9000 });
        renderFirstRunWelcome();
      },
    });
  }

  function renderSetupCheckSlot() {
    const host = $('#setup-check-slot');
    if (!host) return;
    host.replaceChildren(buildSetupSelfCheckCard());
  }

  async function runSetupSelfCheck() {
    const check = state.setup.check;
    if (check.status === 'loading') return;
    check.status = 'loading';
    check.error = null;
    renderSetupCheckSlot();
    const results = await Promise.allSettled([api.clientInfo(), api.health(), api.status(), api.config(), api.executorInfo()]);
    const [infoRes, healthRes, statusRes, configRes, executorRes] = results;
    const errors = results.filter((item) => item.status === 'rejected').map((item) => item.reason);
    const info = infoRes.status === 'fulfilled' ? infoRes.value : null;
    const health = healthRes.status === 'fulfilled' ? healthRes.value : null;
    const status = statusRes.status === 'fulfilled' ? statusRes.value : null;
    const config = configRes.status === 'fulfilled' ? configRes.value : null;
    if (info) state.client = info;
    if (health) state.health = health;
    if (status) state.status = status;
    if (config) state.config = config;
    updateChromeData();
    check.status = 'ready';
    check.at = Date.now();
    check.error = errors.find(isConnError) || null;
    check.data = computeSetupChecks({ info, health, status, config, errors, executor: executorRes.status === 'fulfilled' ? executorRes.value : null });
    renderSetupCheckSlot();
    if (state.setup.check.error) {
      const infoText = describeError(state.setup.check.error);
      toast('环境自检发现连接问题', `${infoText.title}：${infoText.detail}${infoText.code ? `（${infoText.code}）` : ''}`, 'warn', { duration: 6000 });
    }
  }

  function computeSetupChecks({ info, health, status, config, errors, executor }) {
    const checks = [];
    const add = (check) => checks.push(check);
    const control = (status && status.control) || {};
    const desktop = (health && health.desktopExecutor) || {};
    const desktopDetails = { ...(desktop.details || {}), ...((executor && executor.health) || {}) };
    const desktopConfig = (config && config.desktopExecutor) || {};
    const wechat = (health && health.wechatAgent) || {};
    const wechatConfig = (config && config.wechatAgent) || {};
    const mode = control.publishMode || control.effectivePublishMode || (health && health.publishMode) || '';

    add({
      id: 'client', name: '本地客户端服务', tone: info ? 'ok' : 'fail',
      summary: info ? `v${info.version || '—'}` : '不可读取',
      reason: info ? `服务运行于 ${info.adminUrl || '本机'}；页面服务正常。` : '无法读取 /api/client/info，页面可能来自缓存或本地服务异常。',
      facts: info ? [`数据目录：${info.dataDir || '—'}`, `启动时间：${info.startedAt ? fmtDateTime(new Date(info.startedAt * 1000).toISOString()) : '—'}`] : [],
      stepId: 'plugin',
    });
    add({
      id: 'token', name: '管理令牌文件', tone: info ? (info.tokenFileExists ? 'ok' : 'fail') : 'fail',
      summary: info ? (info.tokenFileExists ? '存在' : '缺失') : '不可读取',
      reason: info ? (info.tokenFileExists ? '客户端只从文件读取令牌并在服务端注入；浏览器拿不到 token。' : 'tokenFile 指向的文件不存在，连接请求会返回 TOKEN_MISSING。') : '无法读取客户端信息。',
      facts: info ? [`路径：${info.tokenFile || '—'}`] : [],
      stepId: 'plugin',
    });
    add({
      id: 'admin', name: '插件管理 API', tone: health ? 'ok' : 'fail',
      summary: health ? `v${health.version || '—'}` : '不可用',
      reason: health ? `插件 ${health.plugin || 'dsh-moments-agent'} 已响应；管理 API 已连接。` : '无法读取 /proxy/api/health；检查插件是否加载、18766 是否监听。',
      facts: health ? [`DSH 版本：${health.dshVersion || '未上报'}`, `检查时间：${fmtRelative(health.checkedAt)}`] : [],
      stepId: 'plugin',
    });
    const dbStatus = health && health.database ? health.database : 'unknown';
    add({
      id: 'database', name: '数据库', tone: dbStatus === 'ok' ? 'ok' : dbStatus === 'unknown' ? 'fail' : 'fail',
      summary: dbStatus === 'ok' ? '正常' : dbStatus,
      reason: dbStatus === 'ok' ? 'SQLite 本地数据库可用，任务与审计可持久化。' : '数据库不可用；检查 Node 版本（需支持 node:sqlite）与 data/moments.sqlite 权限。',
      stepId: 'plugin',
    });
    const llmStatus = health && health.llm ? health.llm.status : 'unavailable';
    add({
      id: 'llm', name: '模型 / LLM', tone: llmStatus === 'ok' ? 'ok' : llmStatus === 'degraded' ? 'warn' : 'fail',
      summary: llmStatus === 'ok' ? '可用' : llmStatus,
      reason: (health && health.llm && health.llm.message) || '模型状态未知；创作/审核会失败。',
      stepId: 'model',
    });
    const wechatStatus = wechat.status || 'unavailable';
    const wechatTone = wechatStatus === 'ok' ? 'ok' : wechatStatus === 'degraded' ? 'warn' : 'fail';
    add({
      id: 'wechat', name: 'WeChatAgent / 账号', tone: wechatStatus === 'ok' ? 'ok' : (wechatConfig.enabled === false ? 'warn' : wechatTone),
      summary: wechatStatus === 'ok' ? '账号一致' : (wechatConfig.enabled === false ? '未启用，需配置' : wechatStatus),
      reason: wechatStatus === 'ok'
        ? 'Reader 与 Hook 健康，插件可校验账号；这是真实发布的前置条件。'
        : (wechatConfig.enabled === false
          ? 'wechatAgent.enabled=false：此几何发布流程需要完成第 03 步的账号校验。'
          : (wechat.message || 'WeChatAgent 不可用，检查实际 Reader/Hook 地址与登录状态。')),
      facts: [wechat.details && wechat.details.version ? `Hook 版本：${wechat.details.version}` : '', wechatConfig.readerBaseUrl ? `Reader：${wechatConfig.readerBaseUrl}` : '', wechatConfig.hookBaseUrl ? `Hook：${wechatConfig.hookBaseUrl}` : ''].filter(Boolean),
      stepId: 'wechatagent',
    });
    const desktopEnabled = desktopConfig.enabled === true;
    const desktopStatus = desktop.status || 'unavailable';
    let desktopTone = 'fail';
    if (!desktopEnabled) desktopTone = 'warn';
    else if (desktopStatus === 'ok' || desktopStatus === 'degraded') desktopTone = 'ok';
    add({
      id: 'executor', name: '桌面执行器', tone: desktopTone,
      summary: !desktopEnabled ? '未启用' : (desktopStatus === 'unavailable' ? '不可用' : `${desktopDetails.mode || '—'}${desktopDetails.allowPublish ? ' · 允许发表' : ' · 仅准备'}`),
      reason: !desktopEnabled
        ? 'desktopExecutor.enabled=false：无法准备朋友圈，也无法真实发布。'

        : (desktopStatus === 'unavailable'
          ? (desktop.message || '执行器不可达，检查 18765 与 tokenFile。')
          : `${desktop.message || '执行器已响应'}${desktopDetails.wechatInstalled === false ? '；微信未检测到' : ''}`),
      facts: desktopEnabled ? [
        `mode：${desktopDetails.mode || '—'}`,
        `allowPublish：${desktopDetails.allowPublish ? 'true' : 'false'}`,
        `wechatInstalled：${desktopDetails.wechatInstalled ? 'true' : 'false'}`,
        executor && executor.embedded ? `内置服务 PID：${executor.pid}；端口：${executor.port}` : '内置诊断不可用，请更新并重启 EXE；不据此判断管理员/OCR 已就绪。',
      ] : ['设置 desktopExecutor.enabled=true 后，重启客户端刷新本项。'],
      stepId: 'executor',
    });
    const direct = executor && executor.embedded ? executor.health || {} : null;
    const wechatDesktop = executor && executor.status || {};
    add({ id: 'desktop-input', name: '管理员与 OCR',
      tone: direct ? (direct.adminPrivilege && direct.ocrAvailable ? 'ok' : 'fail') : 'warn',
      summary: direct ? `管理员=${Boolean(direct.adminPrivilege)} · OCR=${Boolean(direct.ocrAvailable)}` : '等待新版内置诊断',
      reason: '从客户端同进程执行器读取真实状态；不会点击、输入或打开微信编辑器。',
      facts: direct ? [`驱动：${direct.driver || '未知'}`, `预期账号已配置：${Boolean(executor.accountConfigured)}`] : [], stepId: 'executor' });
    const interactive = wechatDesktop.running && wechatDesktop.loggedIn && wechatDesktop.interactive && !wechatDesktop.locked;
    add({ id: 'desktop-session', name: '微信与交互桌面', tone: direct ? (interactive ? 'ok' : 'fail') : 'warn',
      summary: direct ? (interactive ? '已登录、可交互' : '运行/登录/锁屏条件未满足') : '未知',
      reason: '后台调度仍需要微信登录且桌面未锁定；此项不代表真实准备验收。', stepId: 'executor' });
    const actualVersion = direct && direct.wechatVersion;
    const versionMatches = actualVersion && actualVersion === executor.declaredVersion;
    add({ id: 'desktop-version', name: '微信版本适配', tone: 'warn',
      summary: actualVersion ? `检测：${actualVersion}` : '待检测',
      reason: versionMatches ? '版本号与声明基线一致，仍需第 07 步的真实准备验收。' : '检测版本与声明基线不一致或缺失；先做版本适配与只准备验收，不把声明值当成支持证据。',
      facts: direct ? [`声明基线：${executor.declaredVersion || '未设置'}`] : [], stepId: 'executor' });
    add({
      id: 'publish-mode', name: '发布模式', tone: ['APPROVAL_REQUIRED', 'POLICY_AUTONOMOUS'].includes(mode) ? 'ok' : mode === 'PREPARE_ONLY' ? 'warn' : 'fail',
      summary: mode ? modeText(mode) : '未知',
      reason: mode === 'APPROVAL_REQUIRED'
        ? '审批后发表：每条内容需要有效审批。' : mode === 'POLICY_AUTONOMOUS' ? '不审批直接发表：已审核内容无需逐条审批；保留其他发表门禁。'
        : mode === 'PREPARE_ONLY'
          ? '仅准备：可以演练准备流程，发表按钮被禁用，不会真实发布。'
          : '当前发布模式不允许真实发布；请按第 06 步检查配置。',
      stepId: 'config',
    });
    add({
      id: 'control', name: '暂停 / Kill Switch', tone: control.killSwitch ? 'fail' : control.paused ? 'warn' : 'ok',
      summary: control.killSwitch ? 'Kill Switch 启用' : control.paused ? '已暂停' : '正常',
      reason: control.killSwitch ? '所有创作、准备与发表被阻止；先解除 Kill Switch。' : control.paused ? '系统暂停中；恢复后才能继续准备/发表。' : '控制状态正常，无全局熔断。',
      stepId: 'approval',
    });
    add({
      id: 'account', name: '当前账号', tone: status && status.accountId ? 'ok' : 'warn',
      summary: status && status.accountId ? `${status.accountId.slice(0, 7)}…${status.accountId.slice(-4)}` : '未确认',
      reason: status && status.accountId ? '审批与发布尝试会绑定该账号；切换账号后必须重新审批。' : '没有读取到账号；真实发布前必须确认 WeChatAgent / 执行器账号一致。',
      stepId: 'account',
    });
    if (state.setup.available === false) {
      add({
        id: 'setup-state', name: '配置进度接口', tone: 'fail',
        summary: '不可用',
        reason: `GET /api/client/setup-state 失败：${describeError(state.setup.error).detail}`,
        stepId: 'plugin',
      });
    } else {
      add({
        id: 'setup-state', name: '配置进度接口', tone: 'ok',
        summary: '可用',
        reason: 'setup-state 可读写；勾选进度会持久化到 client/setup-state.json。',
        stepId: 'plugin',
      });
    }
    return checks;
  }

  function buildSetupSelfCheckCard() {
    const check = state.setup.check;
    const card = h('section', { class: 'card setup-check-card', id: 'setup-self-check' });
    const headActions = h('div', { class: 'setup-check-actions' });
    if (check.status === 'ready' && check.at) {
      headActions.appendChild(h('span', { class: 'setup-check-at' }, `检测于 ${fmtRelative(new Date(check.at).toISOString())}`));
    }
    const rerun = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', disabled: check.status === 'loading' },
      check.status === 'loading' ? h('span', { class: 'spinner' }) : icon('refresh', 14), '重新检测');
    rerun.addEventListener('click', runSetupSelfCheck);
    headActions.appendChild(rerun);
    card.appendChild(h('div', { class: 'card-head' },
      h('div', {}, h('h3', { class: 'card-title' }, icon('shield'), '环境自检'), h('p', { class: 'card-sub' }, '读取插件、账号和内置执行器的真实状态；点击检查项查看原因与下一步')),
      headActions,
    ));
    const body = h('div', { class: 'card-body' });
    if (check.status === 'idle' || check.status === 'loading') {
      const sk = h('div', { class: 'setup-check-loading' });
      for (let i = 0; i < 6; i += 1) sk.appendChild(h('div', { class: 'skeleton sk-line' }));
      body.appendChild(sk);
      card.appendChild(body);
      return card;
    }
    if (check.error) {
      body.appendChild(h('div', { class: 'notice danger' }, icon('alert', 15),
        h('span', {}, `${describeError(check.error).title}：${describeError(check.error).detail}${describeError(check.error).code ? `（${describeError(check.error).code}）` : ''}。下面的关卡按真实结果展示，不会补成通过。`),
      ));
    }
    const checks = Array.isArray(check.data) ? check.data : [];
    const okCount = checks.filter((item) => item.tone === 'ok').length;
    const warnCount = checks.filter((item) => item.tone === 'warn').length;
    const failCount = checks.filter((item) => item.tone === 'fail').length;
    body.appendChild(h('div', { class: 'setup-check-summary' },
      h('span', { class: 'badge badge-ok' }, `通过 ${okCount}`),
      h('span', { class: 'badge badge-warn' }, `需注意 ${warnCount}`),
      h('span', { class: 'badge badge-danger' }, `未通过 ${failCount}`),
      h('span', { class: 'setup-check-note' }, '「需人工确认」的项不会被自动判定为通过。'),
    ));
    const grid = h('div', { class: 'setup-check-grid' });
    for (const item of checks) grid.appendChild(buildSetupCheckItem(item));
    body.appendChild(grid);
    card.appendChild(body);
    return card;
  }

  function buildSetupCheckItem(item) {
    const iconName = item.tone === 'ok' ? 'check' : item.tone === 'warn' ? 'alert' : 'x';
    return h('details', { class: `setup-check-item tone-${item.tone}` },
      h('summary', {},
        h('span', { class: 'setup-check-item-head' },
          h('span', { class: 'setup-check-icon' }, icon(iconName, 14)),
          h('span', { class: 'setup-check-name' }, item.name),
          h('span', { class: `badge badge-${item.tone === 'ok' ? 'ok' : item.tone === 'warn' ? 'warn' : 'danger'}` }, item.tone === 'ok' ? '通过' : item.tone === 'warn' ? '注意' : '未通过'),
          icon('chevron', 12),
        ),
        h('span', { class: 'setup-check-summary-text' }, item.summary || '—'),
      ),
      h('div', { class: 'setup-check-more' },
        h('p', { class: 'setup-check-reason' }, item.reason || ''),
        (item.facts && item.facts.length > 0) ? h('ul', { class: 'setup-check-facts' }, item.facts.map((fact) => h('li', {}, fact))) : null,
        item.stepId ? h('button', {
          class: 'setup-check-link',
          type: 'button',
          onclick: () => {
            if (state.setup.wizardOpen) closeSetupWizard({ skipped: false });
            selectSetupStep(item.stepId, { scroll: true });
          },
        }, `查看 ${setupStepById(item.stepId).letter} 步`, icon('arrow-right', 12)) : null,
      ),
    );
  }

  function buildSetupErrorsCard() {
    const card = h('section', { class: 'card setup-error-card' });
    card.appendChild(h('div', { class: 'card-head' },
      h('div', {}, h('h3', { class: 'card-title' }, icon('alert'), '常见错误速查'), h('p', { class: 'card-sub' }, '现象 / 原因 / 处理；错误码原样展示，不美化')),
    ));
    const list = h('div', { class: 'setup-error-list' });
    SETUP_ERROR_ROWS.forEach((row, index) => {
      const details = h('details', { class: 'setup-error-item', id: `setup-error-${index}` },
        h('summary', {},
          h('span', { class: 'setup-error-code' }, row.code),
          h('span', { class: 'setup-error-symptom' }, row.symptom),
          icon('chevron', 13),
        ),
        h('div', { class: 'setup-error-body' },
          h('p', {}, h('strong', {}, '原因：'), row.cause),
          h('p', {}, h('strong', {}, '处理：'), row.fix),
        ),
      );
      list.appendChild(details);
    });
    card.appendChild(list);
    return card;
  }

  function buildAutonomyPlanCard() {
    const levels = [
      ['已具备 · 按模式定时发送', '显式开启 policy.humanize.enabled 后，审批模式从有效批准的任务中选择候选；第三档直接从审核通过的任务中选择，不再逐条申请或等待人工审批。两者都等待活跃时段、最小间隔与随机延迟，再调用同一个 Publisher。仅准备模式始终禁止自动发表。'],
      ['待扩展 · 更细的自主内容范围', '第三档已支持无需逐条人工审批。后续可以增加账号、主题、纯文字、公开范围与有效期的独立授权策略，限制哪些内容可以进入队列；当前版本依照现有内容审核与发布规则执行，不宣称已经具备独立的主题授权模型。'],
      ['必须区分 · 后台调度与桌面静默', '当前 geometry 驱动会置前微信、操作鼠标与剪贴板，要求登录且未锁屏的桌面。可做到少打扰地安排发送，不能承诺锁屏发送或完全不占用输入设备。严格的无界面发送需要另行验证受支持的发布接口。'],
    ];
    return h('section', { class: 'card setup-autonomy', id: 'autonomy-plan' },
      h('div', { class: 'card-head' }, h('div', {},
        h('h3', { class: 'card-title' }, icon('clock'), '静默自主发送 · 实现路线'),
        h('p', { class: 'card-sub' }, '当前能力、缺口与下一步；阅读此方案不会开启发送'))),
      h('div', { class: 'card-body' },
        h('div', { class: 'setup-autonomy-grid' }, levels.map(([title, text]) =>
          h('article', { class: 'setup-autonomy-level' }, h('h4', {}, title), h('p', {}, text)))),
        buildSetupList([
          '第一阶段：手动发布验收通过后，显式开启 policy.humanize.enabled。DSH 的 scheduleEnabled 只控制自主创作，两者不是同一个开关。',
          '第二阶段：同一 EXE 增加托盘与常驻开关；浏览器关闭只关闭界面，执行器继续运行，托盘退出才停止。当前版本仍会在页面心跳停止后退出。',
          '第三阶段：输入空闲检测、单任务租约、重启恢复与发布前复检；用户正在使用微信或桌面不可交互时延后。',
          '第四阶段：单独实现有限期的策略授权、审计记录和撤销机制；默认关闭，用仿真、影子运行和受控人工验收逐级放开。',
          '结果不确定、已核销审批、账号切换、暂停或 Kill Switch 都阻止再次发送；自动化只报告需要处理的异常。',
          '配置生效不等于真实发送验收：现有调度已经过 Mock 回归，仍需在目标微信版本上验证真实流程。',
        ], 'setup-bullet'),
        h('a', { class: 'btn btn-outline', href: '#/settings' }, '查看当前自动化配置', icon('arrow-right', 14))),
    );
  }

  /* -------------------------- 首次运行向导（全屏） -------------------------- */
  function maybeAutoOpenSetupWizard() {
    const setup = state.setup;
    if (!setup.data || setup.data.completed || setup.sessionSkip || setup.autoOpened) return;
    if (currentRoute && currentRoute.name !== 'dashboard') return;
    // 首次启动自动配置引导接管自动弹出（含 localStorage dismiss 语义）；
    // 只有首次启动接口不可用时，才回退到旧的全屏教程向导。
    if (state.firstrun.info) return;
    setup.autoOpened = true;
    openSetupWizard(0);
  }

  function openSetupWizard(index = 0) {
    state.setup.wizardOpen = true;
    state.setup.wizardIndex = Math.min(Math.max(index, 0), SETUP_STEPS.length + 1);
    renderSetupWizard();
    window.setTimeout(() => {
      const wizard = $('#setup-wizard');
      const focusTarget = wizard && wizard.querySelector('button, a[href]');
      if (focusTarget) focusTarget.focus();
    }, 30);
  }

  function closeSetupWizard({ skipped = false } = {}) {
    state.setup.wizardOpen = false;
    if (skipped && !(state.setup.data && state.setup.data.completed)) {
      state.setup.sessionSkip = true;
      toast('可以先跳过', '已打开「首次配置」页面；下次启动还会自动提醒，也可以随时从左侧进入。', 'info', { duration: 5000 });
    }
    renderSetupWizard();
  }

  function renderSetupWizard() {
    const root = $('#setup-wizard');
    if (!root) return;
    if (!state.setup.wizardOpen) {
      root.hidden = true;
      root.replaceChildren();
      return;
    }
    root.hidden = false;
    const data = state.setup.data || normalizeSetupData(null);
    const done = setupDoneCount();
    const wizardIndex = state.setup.wizardIndex;
    const overlay = h('div', { class: 'setup-wizard-overlay' });
    overlay.addEventListener('click', () => closeSetupWizard({ skipped: true }));
    const panel = h('div', { class: 'setup-wizard-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': '首次配置向导' });

    const head = h('div', { class: 'setup-wizard-head' },
      h('div', { class: 'setup-wizard-brand' },
        h('span', { class: 'setup-wizard-logo' }, icon('compass', 18)),
        h('div', {},
          h('strong', {}, '第一次配置'),
          h('span', {}, '从零到第一条真实朋友圈 · 8 步'),
        ),
      ),
      h('div', { class: 'setup-wizard-progress' },
        h('span', {}, `${done}/${SETUP_STEP_IDS.length}`),
        h('div', { class: 'setup-wizard-track' }, h('i', { style: { width: `${Math.round((done / SETUP_STEP_IDS.length) * 100)}%` } })),
      ),
      h('button', {
        class: 'btn btn-ghost btn-sm',
        type: 'button',
        onclick: () => closeSetupWizard({ skipped: true }),
        title: '稍后再说（Esc）',
      }, icon('x', 14), '稍后再说'),
    );
    panel.appendChild(head);
    const body = h('div', { class: 'setup-wizard-body' });
    if (state.setup.available === false) {
      const info = describeError(state.setup.error);
      body.appendChild(h('div', { class: 'notice danger', style: { marginBottom: '14px' } }, icon('alert', 15),
        h('span', {}, `进度接口不可用：${info.title}${info.code ? `（${info.code}）` : ''}。教程可阅读，但勾选与完成状态不会被保存；修复后刷新页面重试。`),
      ));
    }
    if (wizardIndex === 0) body.appendChild(buildSetupWizardIntro());
    else if (wizardIndex >= 1 && wizardIndex <= SETUP_STEPS.length) body.appendChild(buildSetupWizardStep(wizardIndex - 1));
    else body.appendChild(buildSetupWizardDone());
    panel.appendChild(body);
    panel.appendChild(buildSetupWizardFoot());
    root.replaceChildren(overlay, panel);
    window.setTimeout(() => {
      if (!state.setup.wizardOpen) return;
      const first = panel.querySelector('.setup-wizard-foot button:not([disabled]), .setup-wizard-body button:not([disabled])');
      if (first) first.focus();
    }, 30);
  }

  function buildSetupWizardIntro() {
    const list = h('div', { class: 'setup-wizard-steps-preview' });
    SETUP_STEPS.forEach((step, index) => {
      const isDone = setupStepDone(step.id);
      const item = h('button', { class: 'setup-wizard-preview-item', type: 'button' },
        h('span', { class: `setup-wizard-preview-index${isDone ? ' done' : ''}` }, isDone ? icon('check', 12) : String(index + 1)),
        h('span', {},
          h('strong', {}, `${step.letter} · ${step.title}`),
          h('span', {}, step.summary),
        ),
        isDone ? badge('已完成', 'ok', false) : null,
      );
      item.addEventListener('click', () => { state.setup.wizardIndex = index + 1; renderSetupWizard(); });
      list.appendChild(item);
    });
    return h('div', { class: 'setup-wizard-intro' },
      h('h2', {}, '这台机器还差几步，才能真正发第一条朋友圈。'),
      h('p', { class: 'setup-wizard-lead' }, '本向导读取本机健康状态并保存勾选进度，不会批准、准备或发表内容。配置完成后到设置页选择三级发表模式：仅准备、审批后发表，或审核通过后直接发表。'),
      h('div', { class: 'setup-wizard-safety' },
        icon('shield', 16),
        h('ul', {}, SETUP_SAFETY.slice(0, 3).map((text) => h('li', {}, text))),
      ),
      list,
    );
  }

  function buildSetupWizardStep(stepIndex) {
    const step = SETUP_STEPS[stepIndex];
    const done = setupStepDone(step.id);
    const commands = (step.blocks || []).filter((block) => block.type === 'cmd');
    const firstCommand = commands[0];
    const toggle = h('button', {
      class: `setup-toggle${done ? ' done' : ''}`,
      type: 'button',
      'aria-pressed': done ? 'true' : 'false',
      disabled: state.setup.saving,
      onclick: () => toggleSetupStep(step.id, !done),
    }, done ? icon('check', 15) : h('span', { class: 'setup-toggle-dot' }), done ? '本步已完成' : '标记本步完成');

    const wrap = h('div', { class: 'setup-wizard-step' },
      h('div', { class: 'setup-wizard-step-eyebrow' }, `第 ${stepIndex + 1} / ${SETUP_STEPS.length} 步 · ${step.letter}`),
      h('h2', {}, step.title),
      h('p', { class: 'setup-wizard-lead' }, step.goal),
      h('div', { class: 'setup-wizard-facts' },
        h('span', { class: 'meta-pill' }, icon('info', 13), step.summary),
        h('span', { class: 'meta-pill' }, icon('layers', 13), `${step.prereqs ? step.prereqs.length : 0} 个前置条件`),
      ),
      firstCommand ? buildSetupCmd(firstCommand) : null,
      h('div', { class: 'setup-wizard-expected' },
        h('strong', {}, '完成后应看到'),
        buildSetupList(step.expected || [], 'setup-expect'),
      ),
      h('div', { class: 'setup-wizard-toggle-row' }, toggle,
        h('a', {
          class: 'btn btn-ghost btn-sm',
          href: `#/setup/${encodeURIComponent(step.id)}`,
          onclick: (event) => { event.preventDefault(); closeSetupWizard({ skipped: false }); selectSetupStep(step.id, { scroll: true }); },
        }, '在完整教程里查看排查项', icon('arrow-right', 13)),
      ),
      step.codes && step.codes.length > 0 ? h('div', { class: 'setup-wizard-codes' },
        h('span', {}, '相关错误：'),
        step.codes.map((code) => h('span', { class: 'badge badge-muted' }, code)),
      ) : null,
    );
    return wrap;
  }

  function buildSetupWizardDone() {
    return h('div', { class: 'setup-wizard-done' },
      h('div', { class: 'setup-wizard-done-icon' }, icon('check', 28)),
      h('h2', {}, '配置清单已完成，请以验收结果为准。'),
      h('p', { class: 'setup-wizard-lead' }, '以后启动不会再自动弹出这套向导；你可以在左侧「首次配置」或设置页重新打开。'),
      h('div', { class: 'setup-wizard-safety' },
        icon('shield', 16),
        h('ul', {}, SETUP_SAFETY.slice(0, 4).map((text) => h('li', {}, text))),
      ),
      h('div', { class: 'setup-wizard-done-actions' },
        h('a', { class: 'btn btn-primary', href: '#/dashboard', onclick: () => closeSetupWizard({ skipped: false }) }, '进入概览', icon('arrow-right', 15)),
        h('a', { class: 'btn btn-outline', href: '#/setup', onclick: (event) => { event.preventDefault(); closeSetupWizard({ skipped: false }); selectSetupStep(SETUP_STEPS[0].id); } }, '查看完整教程'),
      ),
    );
  }

  function buildSetupWizardFoot() {
    const index = state.setup.wizardIndex;
    const foot = h('div', { class: 'setup-wizard-foot' });
    if (index === 0) {
      foot.appendChild(h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => closeSetupWizard({ skipped: true }) }, '稍后再说'));
      foot.appendChild(h('button', { class: 'btn btn-primary', type: 'button', onclick: () => { state.setup.wizardIndex = 1; renderSetupWizard(); } }, '开始配置', icon('arrow-right', 15)));
      return foot;
    }
    if (index >= 1 && index <= SETUP_STEPS.length) {
      foot.appendChild(h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { state.setup.wizardIndex = Math.max(0, index - 1); renderSetupWizard(); } }, '上一步'));
      foot.appendChild(h('span', { class: 'setup-wizard-foot-note' }, setupAllDone() ? '全部步骤已完成，可以完成配置' : `还差 ${SETUP_STEP_IDS.length - setupDoneCount()} 步；可先关闭，在教程页继续`));
      if (index === SETUP_STEPS.length) {
        foot.appendChild(h('button', {
          class: 'btn btn-primary',
          type: 'button',
          disabled: !setupAllDone() || state.setup.saving,
          onclick: markSetupComplete,
        }, state.setup.saving ? h('span', { class: 'spinner' }) : icon('check', 15), setupAllDone() ? '完成配置' : '还有步骤未完成'));
      } else {
        foot.appendChild(h('button', {
          class: 'btn btn-primary',
          type: 'button',
          onclick: () => { state.setup.wizardIndex = Math.min(SETUP_STEPS.length, index + 1); renderSetupWizard(); },
        }, '下一步', icon('arrow-right', 15)));
      }
      return foot;
    }
    foot.appendChild(h('button', { class: 'btn btn-primary', type: 'button', onclick: () => closeSetupWizard({ skipped: false }) }, '关闭向导'));
    return foot;
  }

  function setupWizardTrapFocus(event) {
    const root = $('#setup-wizard');
    if (!root) return;
    const focusables = Array.from(root.querySelectorAll('button:not([disabled]), a[href], input:not([disabled])'));
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
      api.setupState(),
      api.automation(),
      api.writingSkills(),
      api.discovery(),
      api.chatMemory(),
    ]);
    if (token !== renderSeq) return;
    const [clientInfoResult, clientConfigResult, personaResult, configResult, healthResult, statusResult, setupResult, automationResult, writingSkillsResult, discoveryResult, chatMemoryResult] = results;
    if (clientInfoResult.status === 'fulfilled') {
      // loadClientInfo 已写入 state.client
    }
    if (setupResult.status === 'fulfilled') {
      state.setup.data = normalizeSetupData(setupResult.value);
      state.setup.available = true;
      state.setup.error = null;
    } else {
      state.setup.available = false;
      state.setup.error = setupResult.reason;
      if (!state.setup.data) state.setup.data = normalizeSetupData(null);
    }
    if (clientConfigResult.status === 'fulfilled' && clientConfigResult.value) {
      state.clientConfig = clientConfigResult.value;
      const cfg = clientConfigResult.value;
      if (!state.clientSettingsDirty) state.settingsForm = { baseUrl: cfg.baseUrl || '', tokenFile: cfg.tokenFile || '', dataDir: cfg.dataDir || '' };
    }
    if (personaResult.status === 'fulfilled' && personaResult.value) state.persona = personaResult.value;
    if (configResult.status === 'fulfilled' && configResult.value) state.config = configResult.value;
    if (healthResult.status === 'fulfilled' && healthResult.value) state.health = healthResult.value;
    if (statusResult.status === 'fulfilled' && statusResult.value) state.status = statusResult.value;
    updateChromeData();

    // setup-state 失败不参与“连接异常”判断，避免可选能力失败被误报为断线
    const errors = results.slice(0, 6).filter((item) => item.status === 'rejected').map((item) => item.reason);
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

    root.appendChild(buildAutonomyScheduleCard(automationResult));
    root.appendChild(buildWritingSkillsCard(writingSkillsResult));
    root.appendChild(buildDiscoveryCard(discoveryResult));
    leftCol.appendChild(buildConnectionInfoCard(clientInfoResult));
    leftCol.appendChild(buildClientConfigCard());
    leftCol.appendChild(buildSetupEntryCard());
    rightCol.appendChild(buildPublishModeCard());
    rightCol.appendChild(buildControlPanelCard());
    rightCol.appendChild(buildPersonaCard(personaResult));
    rightCol.appendChild(buildChatMemoryCard(chatMemoryResult));
    rightCol.appendChild(buildMemoryCard());
    rightCol.appendChild(buildLocalActionsCard());
    layout.append(leftCol, rightCol);
    root.appendChild(layout);
    page.replaceChildren(root);
  }

  function buildPublishModeCard() {
    const current = (state.config && state.config.publishMode) || 'PREPARE_ONLY';
    let selected = current;
    const descriptions = [
      ['PREPARE_ONLY', '仅准备不发表', '审核通过即可准备微信编辑器和截图；所有发表请求被阻止。'],
      ['APPROVAL_REQUIRED', '审批后发表', '每条内容需要有效的一次性人工审批，发表前核销审批并复核内容。'],
      ['POLICY_AUTONOMOUS', '不审批直接发表', '内容审核通过后可直接发表，不创建逐条人工审批。已开启的定时发送也按此模式执行。'],
    ];
    const options = h('div', { class: 'publish-mode-options', role: 'radiogroup', 'aria-label': '发表模式三级选项' });
    for (const [value, title, description] of descriptions) {
      const input = h('input', { type: 'radio', name: 'publish-mode', value, checked: current === value, 'aria-label': title });
      input.addEventListener('change', () => { selected = value; });
      options.appendChild(h('label', { class: 'publish-mode-option' }, input,
        h('span', {}, h('strong', {}, title), h('small', {}, description))));
    }
    const save = h('button', { class: 'btn btn-primary', type: 'button' }, '应用并同步模式');
    save.addEventListener('click', () => openModal({
      title: `切换为「${modeText(selected)}」？`,
      subtitle: selected === 'POLICY_AUTONOMOUS' ? '此模式下后续已审核内容无需逐条人工审批。' : '选择后会同步更新插件与本进程执行器。',
      content: [h('p', {}, '账号核对、内容审核、去重、限额、暂停、Kill Switch 和不确定结果保护仍然生效。已准备或正在发表的任务须先完成或取消。')],
      danger: selected === 'POLICY_AUTONOMOUS', confirmText: '确认应用',
      onConfirm: () => api.setPublishMode(selected, current),
      after: () => { toast('发表模式已同步', modeText(selected), 'success'); refreshCurrent(true); },
    }));
    return h('section', { class: 'card', id: 'publish-mode-settings' },
      h('div', { class: 'card-head' }, h('div', {}, h('h3', { class: 'card-title' }, icon('send'), '发表模式'),
        h('p', { class: 'card-sub' }, state.config ? `当前：${modeText(current)} · 保存后持久化，重启继续生效` : '尚未读取插件模式，请先连接新版 DSH 插件；当前选项仅为界面默认值'))),
      h('div', { class: 'card-body' }, options,
        h('p', { class: 'field-help' }, '切换模式不创建或立即发表内容。定时发送需另行开启；免审批也必须先通过内容审核。需要完整 EXE 与已重载的新版 DSH 插件。'), save));
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
    baseUrlInput.addEventListener('input', () => { form.baseUrl = baseUrlInput.value; state.clientSettingsDirty = true; });
    tokenFileInput.addEventListener('input', () => { form.tokenFile = tokenFileInput.value; state.clientSettingsDirty = true; });
    dataDirInput.addEventListener('input', () => { form.dataDir = dataDirInput.value; state.clientSettingsDirty = true; });
    const errorSlot = h('div');
    const saveBtn = h('button', { class: 'btn btn-primary', type: 'button' }, icon('check', 16), '保存客户端配置');
    saveBtn.addEventListener('click', async () => {
      errorSlot.replaceChildren();
      const baseUrl = baseUrlInput.value.trim();
      if (baseUrl && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?(\/.*)?$/i.test(baseUrl)) {
        renderModalError(errorSlot, new ApiError('INVALID_BASE_URL', '管理 API 地址只允许 http 回环地址（127.0.0.1 / localhost / ::1）。', { kind: 'business' }));
        return;
      }
      saveBtn.disabled = true;
      saveBtn.replaceChildren(h('span', { class: 'spinner' }), '保存中…');
      try {
        const {result, saved:nextConfig} = await saveAndReadBack(
          () => api.saveClientConfig({ baseUrl, tokenFile: tokenFileInput.value.trim(), dataDir: dataDirInput.value.trim() }),
          () => api.clientConfig(), (saved, response) => response && ['baseUrl','tokenFile','dataDir'].every(key => saved[key] === response[key]));
        state.clientConfig = nextConfig;
        state.settingsForm = { baseUrl: nextConfig.baseUrl, tokenFile: nextConfig.tokenFile, dataDir: nextConfig.dataDir };
        state.clientSettingsDirty = false;
        toast('客户端配置已保存', (result && result.message) || '配置写入 client/moments-client.json（不含令牌）。', 'success');
        if (result?.restartRequired) toast('数据目录将在重启后启用', '已保存新路径；当前执行器继续使用原数据目录，请退出并重新启动客户端。', 'warn', { duration: 7000 });
        if (result?.modeSyncRequired) toast('请同步发表模式', '连接已切换，执行器保持仅准备；请在发表模式卡重新应用所需模式。', 'warn');
        await refreshCurrent(true);
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
          h('p', { class: 'form-note' }, '地址和令牌路径保存后立即用于后续请求；内置执行器的数据目录变更需重启。此处只保存令牌路径。'),
          saveBtn,
        ),
      ),
    );
  }

  function buildSetupEntryCard() {
    const data = state.setup.data || normalizeSetupData(null);
    const done = setupDoneCount();
    const total = SETUP_STEP_IDS.length;
    const percent = Math.round((done / total) * 100);
    const available = state.setup.available !== false;
    const card = h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        h('div', {}, h('h3', { class: 'card-title' }, icon('compass'), '配置引导'), h('p', { class: 'card-sub' }, '从零到第一条真实朋友圈 · 8 步可复制教程')),
        data.completed ? badge('已完成', 'ok') : badge(`${done}/${total}`, 'primary'),
      ),
      h('div', { class: 'card-body' },
        h('div', { class: 'setup-entry-progress' },
          h('div', { class: 'setup-progress-track', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(done) },
            h('i', { style: { width: `${percent}%` } }),
          ),
          h('span', {}, `${percent}%`),
        ),
        h('p', { class: 'card-sub', style: { marginTop: '8px' } }, data.completed
          ? `上次完成于 ${data.completedAt ? fmtDateTime(data.completedAt) : '—'}。可以随时重看命令与错误速查。`
          : '首次启动会自动弹出向导；也可以现在打开完整教程：程序 / 模型 / WeChatAgent / 账号 / 执行器 / 完整配置 / 演练 / 发表。'),
        h('div', { class: 'setup-entry-actions' },
          h('a', { class: 'btn btn-outline btn-sm', href: '#/setup' }, icon('compass', 14), '重新打开配置教程'),
          h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => openSetupWizard(0) }, icon('play', 14), '打开首次向导'),
        ),
        available ? null : h('div', { class: 'notice warn', style: { marginTop: '12px' } }, icon('alert', 15),
          h('span', {}, `配置进度接口不可用：${describeError(state.setup.error).title}。教程可阅读，但勾选进度暂时无法保存。`),
        ),
      ),
    );
    return card;
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
          h('span', {}, '暂停与 Kill Switch 会阻止新的自动操作。第三档无需逐条人工审批；已开启的发送调度可直接发送已审核内容。客户端不会自行恢复被暂停的系统。'),
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
    if (!state.personaDirty || !state.personaDraft) state.personaDraft = { soul: persona.soul || '', visualStyle: persona.visualStyle || '' };
    soulPre.value = state.personaDraft.soul;
    const visualPre = h('textarea', { class: 'persona-pre', rows: 10, 'aria-label': '配图风格' });
    visualPre.value = state.personaDraft.visualStyle;
    soulPre.addEventListener('input', () => { state.personaDraft.soul = soulPre.value; state.personaDirty = true; });
    visualPre.addEventListener('input', () => { state.personaDraft.visualStyle = visualPre.value; state.personaDirty = true; });
    const save = h('button', { class: 'btn btn-primary', type: 'button' }, '保存人格与配图风格');
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        const payload = { soul: soulPre.value, visualStyle: visualPre.value };
        const {saved} = await saveAndReadBack(
          () => request('/proxy/api/persona', { method:'POST', body:payload }), () => api.persona(),
          value => value.soul === payload.soul && value.visualStyle === payload.visualStyle);
        state.persona = saved; state.personaDraft = null; state.personaDirty = false;
        toast('已保存', '后续创作使用新设定，既有审批内容保持原样', 'success');
        await refreshCurrent(true);
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
          h('span', {}, '这些设定会作为模型创作上下文。请勿填写凭据或私人聊天记录；发表流程遵循当前选定的三级模式。'),
        ),
        save,
      ),
    );
  }

  function chatMemoryStatusBadge(status) {
    const map = {
      new: ['待观察', 'muted'],
      observed: ['已观察', 'ok'],
      owner_edited: ['已修正', 'info'],
    };
    const [label, tone] = map[status] || ['未知', 'muted'];
    return badge(label, tone, false);
  }

  function chatMemoryKindText(kind) {
    return kind === 'private' ? '私聊' : '群聊';
  }

  function splitChatTags(value) {
    return String(value || '')
      .split(/[,，、]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  /**
   * 设置页「社交记忆」卡片：总开关 / 私聊开关 / 统计 / 立即同步 / 会话与人物印象管理。
   * 默认关闭；只有所有者显式开启后才读取 WeChatAgent 白名单内的会话。
   * 所有写操作只影响本机记忆数据，不修改微信聊天记录，也不批准、准备或发表内容。
   */
  function buildChatMemoryCard(chatMemoryResult) {
    const card = h('section', { class: 'card chat-memory-card', id: 'chat-memory-settings' });
    const body = h('div', { class: 'card-body' });
    card.append(
      h('div', { class: 'card-head' },
        h('div', {},
          h('h3', { class: 'card-title' }, icon('message'), '社交记忆'),
          h('p', { class: 'card-sub' }, '从白名单内的聊天提炼人物印象，作为创作的弱参考；默认关闭，只在本机可见。'),
        ),
      ),
      body,
    );

    let view = chatMemoryResult && chatMemoryResult.status === 'fulfilled' ? (chatMemoryResult.value || {}) : null;
    let loadError = chatMemoryResult && chatMemoryResult.status === 'rejected' ? chatMemoryResult.reason : null;
    let lastSync = null;
    let busy = false;

    const settingsOf = () => (view && view.settings) || {};
    const isEnabled = () => Boolean(settingsOf().enabled ?? (view && view.enabled));
    const dash = (value) => (value === null || value === undefined || value === '' ? '—' : value);
    const readError = (error) => describeError(error).detail || String(error);

    const reload = async () => {
      try {
        view = await api.chatMemory();
        loadError = null;
      } catch (error) {
        loadError = error;
      }
      render();
    };

    /** 保存设置并读回核对；不匹配时抛错，不报告保存成功。 */
    const persistSettings = async (patch) => {
      await api.saveChatMemorySettings(patch);
      const fresh = await api.chatMemory();
      const saved = (fresh && fresh.settings) || {};
      const mismatched = Object.entries(patch).some(([key, value]) => JSON.stringify(saved[key]) !== JSON.stringify(value));
      if (mismatched) throw new Error('保存后的读回值不一致，请重新读取核对；未报告保存成功。');
      view = fresh;
      loadError = null;
      return saved;
    };

    const saveSettings = async (patch, successTitle, successText) => {
      await persistSettings(patch);
      toast(successTitle, successText || '', 'success');
      render();
    };

    const syncNow = async (button) => {
      if (busy) return;
      busy = true;
      button.disabled = true;
      setChildren(button, h('span', { class: 'spinner' }), '同步中…');
      try {
        lastSync = (await api.syncChatMemory()) || {};
        const skipped = Array.isArray(lastSync.skipped) ? lastSync.skipped : [];
        const errors = Array.isArray(lastSync.errors) ? lastSync.errors : [];
        toast(
          '社交记忆已同步',
          `会话 ${dash(lastSync.conversations)} 个 · 新消息 ${dash(lastSync.newMessages)} 条 · 印象更新 ${dash(lastSync.impressionsUpdated)} 条${skipped.length ? ` · 跳过 ${skipped.length} 个` : ''}`,
          skipped.length || errors.length ? 'warn' : 'success',
          { duration: 7000 },
        );
      } catch (error) {
        const info = describeError(error);
        lastSync = { error: info };
        toast('同步失败', `${info.detail}${info.code ? `（${info.code}）` : ''}`, 'error', { duration: 7000 });
      } finally {
        busy = false;
      }
      await reload();
    };

    const openMemberEditor = (member) => {
      const aliasInput = h('input', { class: 'input', type: 'text', value: member.alias || '', maxLength: 8, 'aria-label': '成员别名' });
      const summaryInput = h('textarea', { class: 'textarea', rows: 4, maxLength: 300, 'aria-label': '人物摘要' });
      summaryInput.value = member.summary || '';
      const traitsInput = h('input', { class: 'input', type: 'text', value: (Array.isArray(member.traits) ? member.traits : []).join('、'), placeholder: '例如：爱玩梗、表达直接', 'aria-label': '人物标签' });
      const topicsInput = h('input', { class: 'input', type: 'text', value: (Array.isArray(member.topics) ? member.topics : []).join('、'), placeholder: '例如：周末计划、美食', 'aria-label': '关注话题' });
      const styleInput = h('input', { class: 'input', type: 'text', value: member.style || '', maxLength: 120, 'aria-label': '说话风格' });
      const field = (label, control, help) => h('label', { class: 'field' },
        h('span', { class: 'field-label' }, label),
        control,
        help ? h('span', { class: 'field-help' }, help) : null,
      );
      openModal({
        title: `编辑人物印象：${member.alias || '未命名'}`,
        subtitle: '修正只保存在本机；真实昵称不会写入提示词或朋友圈。',
        iconName: 'user',
        content: [
          field('别名', aliasInput, '1~8 个中文 / 字母 / 数字 / 下划线；创作上下文只使用别名。'),
          field('摘要', summaryInput, '必填，1~300 字；请勿填写健康、收入等敏感推断。'),
          field('标签', traitsInput, '受控互动标签，用顿号或逗号分隔，最多 6 个（每个 ≤12 字）。'),
          field('关注话题', topicsInput, '用顿号或逗号分隔，最多 8 个（每个 ≤16 字）。'),
          field('说话风格', styleInput, '最多 120 字，例如「短句、语气轻松」。'),
        ],
        confirmText: '保存印象',
        onConfirm: () => {
          const alias = aliasInput.value.trim();
          const summary = summaryInput.value.trim();
          const style = styleInput.value.trim();
          const traits = splitChatTags(traitsInput.value);
          const topics = splitChatTags(topicsInput.value);
          if (alias && !/^[\u4e00-\u9fa5A-Za-z0-9_]{1,8}$/.test(alias)) {
            throw new ApiError('INVALID_INPUT', '别名只能是 1~8 个中文 / 字母 / 数字 / 下划线。', { kind: 'business' });
          }
          if (!summary) {
            throw new ApiError('INVALID_INPUT', '摘要必须是非空字符串（最多 300 字）；如需移除该人物印象请使用「删除」。', { kind: 'business' });
          }
          if (summary.length > 300) throw new ApiError('INVALID_INPUT', '摘要最多 300 字。', { kind: 'business' });
          if (traits.length > 6 || traits.some((item) => item.length > 12)) {
            throw new ApiError('INVALID_INPUT', '标签最多 6 个，每个不超过 12 字。', { kind: 'business' });
          }
          if (topics.length > 8 || topics.some((item) => item.length > 16)) {
            throw new ApiError('INVALID_INPUT', '话题最多 8 个，每个不超过 16 字。', { kind: 'business' });
          }
          if (style.length > 120) throw new ApiError('INVALID_INPUT', '说话风格最多 120 字。', { kind: 'business' });
          const payload = { summary, style, traits, topics };
          if (alias) payload.alias = alias;
          return api.updateChatMember(member.impressionId, payload);
        },
        after: () => {
          toast('人物印象已保存', '后续创作会使用修正后的印象；本次修正只保存在本机。', 'success');
          reload();
        },
      });
    };

    const buildMember = (member) => {
      const traits = Array.isArray(member.traits) ? member.traits : [];
      const topics = Array.isArray(member.topics) ? member.topics : [];
      const canEdit = isEnabled();
      const editBtn = h('button', {
        class: 'btn btn-outline btn-sm',
        type: 'button',
        disabled: !canEdit,
        title: canEdit ? '修正别名 / 摘要 / 标签 / 话题 / 风格' : '开启社交记忆后才能修正印象',
      }, '编辑印象');
      editBtn.addEventListener('click', () => openMemberEditor(member));
      const deleteBtn = h('button', { class: 'btn btn-ghost btn-sm chat-danger-btn', type: 'button' }, icon('x', 13), '删除');
      deleteBtn.addEventListener('click', () => openModal({
        title: `删除人物印象「${member.alias || '未命名'}」？`,
        subtitle: '只删除本机保存的印象，不修改微信聊天记录；下次同步可能重新生成。',
        iconName: 'alert',
        danger: true,
        confirmText: '确认删除',
        content: [h('p', {}, '删除后不会再作为创作参考；该会话内其他成员印象不受影响。')],
        onConfirm: () => api.deleteChatMember(member.impressionId),
        after: () => {
          toast('人物印象已删除', '只影响本机记忆数据。', 'success');
          reload();
        },
      }));
      return h('div', { class: 'chat-member' },
        h('div', { class: 'chat-member-head' },
          h('strong', { class: 'chat-member-alias' }, member.alias || '未命名'),
          chatMemoryStatusBadge(member.status),
          member.displayName ? h('span', { class: 'chat-member-real' }, `本机昵称：${member.displayName}`) : null,
        ),
        h('p', { class: `chat-member-summary${member.summary ? '' : ' empty'}` }, member.summary || '暂无摘要'),
        traits.length || topics.length
          ? h('div', { class: 'chat-tags' },
            ...traits.map((text) => h('span', { class: 'chat-tag trait' }, text)),
            ...topics.map((text) => h('span', { class: 'chat-tag topic' }, `#${text}`)),
          )
          : null,
        h('div', { class: 'chat-member-meta' },
          h('span', {}, `证据 ${Number(member.evidenceCount) || 0} 条`),
          member.confidence !== null && member.confidence !== undefined
            ? h('span', {}, `置信度 ${Math.round(Number(member.confidence) * 100)}%`)
            : null,
          h('span', {}, `更新于 ${fmtRelative(member.updatedAt)}`),
        ),
        h('div', { class: 'chat-member-actions' }, editBtn, deleteBtn),
      );
    };

    const buildConversation = (item) => {
      const conversation = (item && item.conversation) || {};
      const members = Array.isArray(item && item.members) ? item.members : [];
      const label = conversation.label || '未命名会话';
      const purgeBtn = h('button', { class: 'btn btn-ghost btn-sm chat-danger-btn', type: 'button' }, icon('x', 13), '清除该会话');
      purgeBtn.addEventListener('click', () => openModal({
        title: `清除会话「${label}」？`,
        subtitle: '会删除本机保存的该会话消息与全部人物印象；不可撤销。',
        iconName: 'alert',
        danger: true,
        confirmText: '确认清除',
        content: [
          h('p', {}, `该会话当前有 ${members.length} 个人物印象。清除后需要重新同步才会再次生成；微信聊天记录不会被删除或修改。`),
          conversation.displayName ? h('p', { class: 'field-help' }, `本机名称：${conversation.displayName}`) : null,
        ],
        footerNote: '不会删除或修改微信聊天记录',
        onConfirm: () => api.purgeChatConversation(conversation.conversationKey),
        after: (result) => {
          toast(
            '会话已清除',
            `删除消息 ${dash(result && result.messages)} 条、人物印象 ${dash(result && result.members)} 个。`,
            'success',
          );
          reload();
        },
      }));
      const memberGrid = h('div', { class: 'chat-member-grid' });
      if (members.length === 0) memberGrid.append(h('p', { class: 'field-help' }, '暂无人物印象。同步产生足够证据后会自动生成，也可稍后手动修正。'));
      for (const member of members) memberGrid.append(buildMember(member));
      return h('div', { class: 'chat-conversation' },
        h('div', { class: 'chat-conversation-top' },
          h('div', {},
            h('div', { class: 'chat-conversation-title' },
              h('strong', {}, label),
              badge(chatMemoryKindText(conversation.kind), conversation.kind === 'private' ? 'info' : 'muted', false),
              conversation.enabled === false ? badge('未参与同步', 'warn', false) : null,
            ),
            h('div', { class: 'chat-conversation-meta' },
              h('span', {}, `成员 ${members.length}`),
              h('span', {}, `最后消息 ${conversation.lastMessageAt ? fmtRelative(conversation.lastMessageAt) : '—'}`),
              h('span', {}, `上次同步 ${conversation.lastSyncedAt ? fmtRelative(conversation.lastSyncedAt) : '尚未同步'}`),
              conversation.displayName ? h('span', {}, `本机名称 ${conversation.displayName}`) : null,
            ),
          ),
          conversation.conversationKey ? purgeBtn : null,
        ),
        memberGrid,
      );
    };

    const render = () => {
      body.replaceChildren();
      if (loadError) {
        body.append(
          h('p', { class: 'field-help' }, '当前插件没有提供社交记忆管理接口；请更新并重载新版 DSH 插件后重试。'),
          buildErrorCard(loadError, { onRetry: () => reload(), retryLabel: '重新读取社交记忆' }),
        );
        return;
      }
      const currentSettings = settingsOf();
      const stats = (view && view.stats) || {};
      const conversations = view && Array.isArray(view.conversations) ? view.conversations : [];
      const enabled = isEnabled();

      const masterInput = h('input', { type: 'checkbox', checked: enabled, 'aria-label': '启用社交记忆' });
      masterInput.addEventListener('change', () => {
        const next = Boolean(masterInput.checked);
        masterInput.checked = !next;
        if (next) {
          openModal({
            title: '开启社交记忆？',
            subtitle: '开启后才会读取插件白名单内的群聊；私聊需要单独开启。',
            iconName: 'message',
            content: [
              h('p', {}, '插件会按同步间隔读取 WeChatAgent 白名单内会话的近期纯文本消息，并在本机生成人物印象；关闭时不会读取任何聊天。'),
              h('p', {}, '聊天原文与真实昵称不会进入模型提示词或朋友圈；人物印象可在本卡片编辑或删除。'),
            ],
            confirmText: '确认开启',
            onConfirm: () => persistSettings({ enabled: true }),
            after: () => {
              toast('社交记忆已开启', '可点击「立即同步」读取白名单内的会话。', 'success');
              render();
            },
          });
          return;
        }
        saveSettings({ enabled: false }, '社交记忆已关闭', '已停止读取新的聊天；本机已保存的印象仍可查看或删除。')
          .catch((error) => { render(); toast('关闭失败', readError(error), 'error'); });
      });

      const privateInput = h('input', {
        type: 'checkbox',
        checked: Boolean(currentSettings.includePrivate),
        disabled: !enabled,
        'aria-label': '包含私聊',
      });
      privateInput.addEventListener('change', () => {
        if (!enabled) return;
        const next = Boolean(privateInput.checked);
        privateInput.checked = !next;
        if (!next) {
          saveSettings({ includePrivate: false }, '已停止读取私聊', '群聊同步不受影响。')
            .catch((error) => { render(); toast('保存失败', readError(error), 'error'); });
          return;
        }
        openModal({
          title: '允许读取私聊？',
          subtitle: '私聊内容更敏感：开启后白名单内的一对一会话也会被同步。',
          iconName: 'lock',
          tone: 'warn',
          content: [h('p', {}, '只读取 WeChatAgent 白名单内、已获上游授权的私聊纯文本；不会读取图片、语音、文件或链接卡片。')],
          confirmText: '确认开启私聊',
          onConfirm: () => persistSettings({ includePrivate: true }),
          after: () => {
            toast('已允许读取私聊', '下一次同步会包含白名单内的私聊会话。', 'success');
            render();
          },
        });
      });

      const syncBtn = h('button', {
        class: 'btn btn-outline btn-sm',
        type: 'button',
        disabled: !enabled,
        title: enabled ? '立即从 WeChatAgent 同步白名单内会话' : '请先开启社交记忆',
      }, icon('refresh'), enabled ? '立即同步' : '开启后可同步');
      syncBtn.addEventListener('click', () => syncNow(syncBtn));

      body.append(h('div', { class: 'chat-memory-toolbar' },
        h('div', { class: 'chat-memory-switches' },
          h('label', { class: 'chat-memory-switch' }, masterInput, h('span', {}, '启用社交记忆')),
          h('label', { class: `chat-memory-switch${enabled ? '' : ' is-disabled'}`, title: enabled ? null : '请先开启社交记忆' },
            privateInput, h('span', {}, '包含私聊'), h('span', { class: 'chat-memory-hint' }, '私聊需单独开启')),
        ),
        syncBtn,
      ));

      body.append(enabled
        ? h('div', { class: 'notice' }, icon('shield', 15),
          h('span', {}, '已开启：只读取 WeChatAgent 白名单内的会话；聊天原文与真实昵称不会进入提示词或朋友圈。人物印象仅保存在本机，可随时编辑或删除。'))
        : h('div', { class: 'notice warn' }, icon('lock', 15),
          h('span', {}, '社交记忆默认关闭。只有在插件配置（chatMemory.enabled）或本卡片中显式开启后，才会读取插件白名单内的群聊消息；私聊需要单独开启「包含私聊」。关闭时不会读取微信聊天；已保存的会话仍可查看，可清除会话或删除印象（修正印象需先开启）。')));

      body.append(h('div', { class: 'policy-grid chat-memory-stats' },
        policyTile('会话', dash(stats.conversations ?? conversations.length)),
        policyTile('消息', dash(stats.messages)),
        policyTile('人物印象', dash(stats.members)),
        policyTile('上次同步', stats.lastSyncedAt ? fmtRelative(stats.lastSyncedAt) : '尚未同步'),
      ));

      const whitelist = Array.isArray(currentSettings.conversations) ? currentSettings.conversations : [];
      body.append(h('p', { class: 'field-help' },
        `自动同步间隔 ${fmtMinutes(currentSettings.syncIntervalMinutes)} · 每会话最多 ${dash(currentSettings.maxMessagesPerConversation)} 条消息 · 消息保留 ${dash(currentSettings.retentionDays)} 天 · 印象有效期 ${dash(currentSettings.impressionTtlDays)} 天 · 每会话最多 ${dash(currentSettings.maxMembersPerConversation)} 位成员 · 白名单：${whitelist.length ? whitelist.join('、') : '上游白名单内全部'} · 提示词匿名化：始终开启`));

      if (lastSync) {
        if (lastSync.error) {
          body.append(h('div', { class: 'notice danger' }, icon('alert', 15),
            h('span', {}, `上次同步失败：${lastSync.error.detail || '未知错误'}${lastSync.error.code ? `（${lastSync.error.code}）` : ''}`)));
        } else {
          const skipped = Array.isArray(lastSync.skipped) ? lastSync.skipped : [];
          const errors = Array.isArray(lastSync.errors) ? lastSync.errors : [];
          body.append(h('div', { class: `notice${skipped.length || errors.length ? ' warn' : ''}` },
            icon(skipped.length || errors.length ? 'alert' : 'check', 15),
            h('div', {},
              h('strong', {}, '上次同步结果'),
              h('p', {}, `会话 ${dash(lastSync.conversations)} 个 · 新消息 ${dash(lastSync.newMessages)} 条 · 印象更新 ${dash(lastSync.impressionsUpdated)} 条 · 跳过 ${skipped.length} 个会话`),
              skipped.length
                ? h('ul', { class: 'chat-skip-list' },
                  ...skipped.map((entry) => h('li', {},
                    h('span', { class: 'chat-skip-label' }, (entry && entry.label) || '未知会话'),
                    '：',
                    (entry && entry.reason) || '未说明原因',
                  )))
                : null,
              errors.length
                ? h('ul', { class: 'chat-skip-list' },
                  ...errors.map((entry) => h('li', {}, `错误：${typeof entry === 'string' ? entry : JSON.stringify(entry)}`)))
                : null,
            )));
        }
      }

      const list = h('div', { class: 'chat-memory-list' });
      if (conversations.length === 0) {
        list.append(h('p', { class: 'field-help' }, enabled
          ? '暂无会话数据：点击「立即同步」读取白名单内的群聊。'
          : '开启社交记忆并同步后，这里会显示白名单内的会话与人物印象。'));
      }
      for (const item of conversations) list.append(buildConversation(item));
      body.append(
        h('div', { class: 'chat-memory-section-head' },
          h('strong', {}, '会话与人物印象'),
          h('span', { class: 'field-help' }, '真实昵称只在本机展示；可编辑别名、摘要、标签，或删除单条印象'),
        ),
        list,
        h('p', { class: 'field-help' }, '所有操作只影响本机保存的社交记忆，不会修改或删除微信聊天记录，也不会批准、准备或发表朋友圈。'),
      );
    };

    render();
    return card;
  }

  function buildWritingSkillsCard(result) {
    const card = h('section', {class:'card',id:'writing-skills-settings'},
      h('div',{class:'card-head'},h('div',{},h('h3',{class:'card-title'},icon('sparkles'),'表达技能 · 去 AI 味'),
        h('p',{class:'card-sub'},'用于后续创作与内容复核，保留事实、人格与发布规则'))));
    if(result.status !== 'fulfilled') {
      card.appendChild(h('div',{class:'card-body'},h('p',{class:'field-help'},'请更新并重载 0.2.7 或更新的插件以读取表达技能。'),
        buildErrorCard(result.reason,{onRetry:()=>refreshCurrent(true)})));
      return card;
    }
    const data=result.value;
    if(!state.writingSkillsDirty || !state.writingSkillsDraft) state.writingSkillsDraft=[...data.enabledIds];
    const enabled=new Set(state.writingSkillsDraft);
    const body=h('div',{class:'card-body'});
    const options=h('div',{class:'writing-skills-options'});
    const message=h('p',{class:'field-help',role:'status'},'已读取服务器保存的技能选择。');
    for(const skill of data.skills) {
      const input=h('input',{type:'checkbox',checked:enabled.has(skill.id),disabled:!skill.available,'aria-label':skill.name});
      input.addEventListener('change',()=>{
        if(input.checked) enabled.add(skill.id);else enabled.delete(skill.id);
        state.writingSkillsDraft=[...enabled];state.writingSkillsDirty=true;message.textContent='技能选择尚未保存。';
      });
      options.appendChild(h('div',{class:'writing-skill-option'},h('label',{class:'schedule-toggle'},input,h('strong',{},skill.name)),
        h('p',{class:'field-help'},skill.description),h('small',{class:'field-help'},skill.available?'已安装 · '+skill.license:'文件缺失，请重新安装完整插件'),
        skill.source.startsWith('https://github.com/')?h('a',{class:'skill-source',href:skill.source,target:'_blank',rel:'noopener noreferrer'},'查看来源'):null));
    }
    const save=h('button',{class:'btn btn-primary',type:'button'},'保存表达技能');
    save.addEventListener('click',async()=>{
      save.disabled=true;
      try {
        const ids=[...enabled];
        await saveAndReadBack(()=>api.saveWritingSkills({enabledIds:ids}),()=>api.writingSkills(),
          saved=>settingsEqual([...saved.enabledIds].sort(),[...ids].sort()));
        state.writingSkillsDirty=false;state.writingSkillsDraft=null;
        toast('表达技能已保存','后续创作即时使用；已有草稿、审批和发表任务不会被改写。','success');
        await refreshCurrent(true);
      } catch(error) {message.textContent=describeError(error).detail||String(error);toast('技能保存失败',message.textContent,'error');}
      finally {save.disabled=false;}
    });
    body.append(options,h('p',{class:'field-help'},'默认启用两项。上游技能用于明确规则内的成稿清理，朋友圈技能补充短文表达约束；不执行仓库脚本，不增加模型调用次数。'),message,save);
    card.appendChild(body);return card;
  }

  function buildDiscoveryCard(result) {
    const card=h('section',{class:'card',id:'local-environment-settings'},
      h('div',{class:'card-head'},h('div',{},h('h3',{class:'card-title'},icon('search'),'本机地址自动发现'),
        h('p',{class:'card-sub'},'读取 DSH、WeChatAgent 和本机插件位置；多份安装会分别列出'))));
    const body=h('div',{class:'card-body'});
    if(result.status==='fulfilled') {
      const data=result.value;
      const rows=h('div',{class:'info-list'});
      const add=(label,value)=>rows.appendChild(h('div',{class:'info-row'},h('span',{class:'info-key'},label),h('span',{class:'info-val mono'},value||'未发现')));
      add('DSH 程序',(data.dsh||[]).map(x=>x.path).join('\n'));
      add('DSH Python',(data.dsh||[]).map(x=>x.pythonPath).filter(Boolean).join('\n'));
      add('WeChatAgent 程序',(data.wechatAgent||[]).map(x=>x.path).join('\n'));
      add('本机插件',(data.plugins||[]).map(x=>x.path+' ['+x.source+']').join('\n'));
      add('当前插件目录',data.activePlugin?.packageRoot);
      add('DSH 配置',(data.profiles||[]).map(x=>x.patchPath).join('\n'));
      const connection=data.activeWechatConnection||(data.configuredWechatConnections||[])[0]||(data.wechatConnections||[])[0];
      add('Reader 地址',connection?.readerBaseUrl);
      add('Hook 地址',connection?.hookBaseUrl);
      add('Reader 配置文件',connection?.readerConfigPath);
      body.append(rows,h('p',{class:'field-help'},data.message));
      const detected=data.suggestedClientConfig;
      if(detected) {
        body.appendChild(h('p',{class:'field-help'},detected.verified?'已通过当前管理令牌读取运行中插件的目录。':'从已注册插件的默认目录推导；服务地址尚未连通验证。'));
        body.appendChild(h('button',{class:'btn btn-outline',type:'button',onclick:async()=>{
          state.settingsForm={baseUrl:detected.baseUrl,tokenFile:detected.tokenFile,dataDir:detected.dataDir};
          state.clientSettingsDirty=true;
          await refreshCurrent(true);
          toast('检测结果已填入','请核对客户端配置卡，然后点击保存客户端配置。','info');
        }},'填入检测到的连接'));
      }
    } else body.appendChild(h('p',{class:'field-help'},'本机发现暂时不可用：'+describeError(result.reason).title));
    const scan=h('button',{class:'btn btn-outline',type:'button'},'重新检测本机地址');
    scan.addEventListener('click',async()=>{
      scan.disabled=true;
      try {card.replaceWith(buildDiscoveryCard({status:'fulfilled',value:await api.discovery(true)}));}
      catch(error){toast('检测失败',describeError(error).detail||String(error),'error');}
      finally{scan.disabled=false;}
    });
    const diagnostic=h('pre',{class:'diagnostic-result',role:'status'},'定位诊断只读取当前微信窗口，不导航、不粘贴、不点击发表。');
    const locate=h('button',{class:'btn btn-ghost',type:'button'},'只读诊断微信按钮定位');
    locate.addEventListener('click',async()=>{
      locate.disabled=true;diagnostic.textContent='正在识别当前窗口…';
      try {diagnostic.textContent=JSON.stringify(await api.locateControls(),null,2);}
      catch(error){diagnostic.textContent=describeError(error).detail||String(error);}
      finally{locate.disabled=false;}
    });
    body.append(h('div',{class:'form-footer'},scan,locate),diagnostic);
    card.appendChild(body);return card;
  }

  function buildAutonomyScheduleCard(result) {
    const card = h('section', { class: 'card autonomy-schedule-card', id: 'autonomy-schedule' },
      h('div', { class: 'card-head' }, h('div', {},
        h('h3', { class: 'card-title' }, icon('clock'), '自主调度'),
        h('p', { class: 'card-sub' }, '自主创作与自动发送分别控制 · 自动读取当前设置，保存后生效并持久保留'))));
    if (result.status !== 'fulfilled') {
      card.appendChild(h('div', { class: 'card-body' },
        h('p', { class: 'field-help' }, '未读取到调度设置，已禁止保存。请更新并重载 0.2.7 或更新的 DSH 插件。'),
        buildErrorCard(result.reason, { onRetry: () => refreshCurrent(true), retryLabel: '重新读取调度' })));
      return card;
    }
    const saved = result.value;
    if (!state.automationDirty || !state.automationDraft) {
      state.automationDraft = JSON.parse(JSON.stringify({ scheduleEnabled: saved.scheduleEnabled,
        scheduler: saved.scheduler, policy: saved.policy }));
    }
    const draft = state.automationDraft;
    const humanize = draft.policy.humanize;
    const notice = h('p', { class: 'field-help', role: 'status' }, state.automationDirty ? '有未保存的修改。' : '已载入服务器保存的设置。');
    const dirty = () => { state.automationDirty = true; notice.textContent = '有未保存的修改；后台刷新不会覆盖正在编辑的内容。'; };
    const field = (title, input) => h('label', { class: 'field' }, h('span', { class: 'field-label' }, title), input);
    const input = (title, target, key, options = {}) => {
      const node = h('input', { class: 'input', 'aria-label': title, type: 'number', required: true,
        step: options.type === 'time' ? 60 : 1, value: target[key], ...options });
      node.addEventListener('input', () => { target[key] = node.type === 'number' ? Number(node.value) : node.value; dirty(); });
      return field(title, node);
    };
    const toggle = (title, target, key) => {
      const node = h('input', { type: 'checkbox', checked: target[key], 'aria-label': title });
      node.addEventListener('change', () => { target[key] = node.checked; dirty(); });
      return h('label', { class: 'schedule-toggle' }, node, h('strong', {}, title));
    };
    const grid = (...items) => h('div', { class: 'schedule-fields' }, ...items);
    const form = h('form', { class: 'card-body' });
    form.append(
      h('section', { class: 'schedule-section' }, h('h4', {}, '自主创作'),
        toggle('启用自主创作', draft, 'scheduleEnabled'),
        h('p', { class: 'field-help' }, '定期判断有没有值得表达的内容；可选择沉默。存在未结束任务时等待处理，不会不断堆积草稿。'),
        grid(input('检查间隔（秒）', draft.scheduler, 'tickSeconds', { min: 15, max: 3600 }),
          input('每次创作概率（%）', { get value() { return Number((draft.scheduler.ideaProbability * 100).toFixed(2)); },
            set value(value) { draft.scheduler.ideaProbability = value / 100; } }, 'value', { min: 0, max: 100, step: 0.01 }),
          input('创作随机延迟（秒）', draft.scheduler, 'jitterSeconds', { min: 0, max: 3600 }))),
      h('section', { class: 'schedule-section' }, h('h4', {}, '自动发送'),
        toggle('启用自动发送', humanize, 'enabled'),
        h('p', { class: 'field-help' }, '仅准备模式始终不发表；审批模式只发送有效批准的内容；第三档可发送审核通过的内容，无逐条人工审批。'),
        grid(input('每日发表上限（条）', draft.policy, 'dailyLimit', { min: 0, max: 20 }),
          input('最小发表间隔（分钟）', draft.policy, 'minIntervalMinutes', { min: 0, max: 10080 }),
          input('发送随机延迟下限（秒）', humanize.delaySeconds, 0, { min: 0, max: 3600 }),
          input('发送随机延迟上限（秒）', humanize.delaySeconds, 1, { min: 0, max: 3600 }),
          input('活跃时段开始', humanize.activeHours, 0, { type: 'time' }),
          input('活跃时段结束', humanize.activeHours, 1, { type: 'time' }),
          input('静默时段开始', draft.policy.quietHours, 0, { type: 'time' }),
          input('静默时段结束', draft.policy.quietHours, 1, { type: 'time' }),
          input('调度时区', draft.policy, 'timeZone', { type: 'text', placeholder: 'Asia/Singapore' })),
        h('details', {}, h('summary', {}, '更多发送设置'), grid(
          input('额外发送间隔（秒）', humanize, 'minIntervalSeconds', { min: 0, max: 604800 }),
          input('发送时刻抖动（秒）', humanize, 'jitterSeconds', { min: 0, max: 3600 }),
          input('最大自动尝试次数', humanize, 'maxPublishAttempts', { min: 1, max: 5 }),
          input('失败退避下限（秒）', humanize.backoffSeconds, 0, { min: 0, max: 86400 }),
          input('失败退避上限（秒）', humanize.backoffSeconds, 1, { min: 0, max: 86400 }))),
        h('p', { class: 'field-help' }, '时段可跨午夜，静默优先。所有发表共用限额与静默时段；实际间隔取两项间隔中的较大值。已排队任务保留原随机等待时间与重试预算，执行前复检时段和限额；不确定结果不自动重发。')));
    const mode = state.config?.publishMode;
    const status = saved.status || {};
    form.append(h('div', { class: 'schedule-status', 'aria-label': '调度运行状态' },
      h('strong', {}, mode === 'PREPARE_ONLY' ? '当前仅准备，不会自动发表' : `当前：${modeText(mode)}`),
      h('p', {}, `创作${saved.scheduleEnabled ? '已开启' : '已关闭'} · 自动发送${saved.policy.humanize.enabled ? '已开启' : '已关闭'} · 队列 ${(status.queue || []).length} 条`),
      h('p', {}, `下次可发送：${status.nextEligibleAt ? fmtDateTime(status.nextEligibleAt) : '等待条件满足'}`),
      status.lastError ? h('p', {}, `最近错误：${status.lastError.message || status.lastError.code}`) : null));
    const save = h('button', { type: 'submit', class: 'btn btn-primary' }, '保存自主调度');
    const reset = h('button', { type: 'button', class: 'btn btn-outline', onclick: () => {
      state.automationDirty = false; state.automationDraft = null; refreshCurrent(true);
    } }, '重载已保存设置');
    const saveVerified = async (payload) => {
      const {saved} = await saveAndReadBack(() => api.saveAutomation(payload), () => api.automation(),
        value => settingsEqual({ scheduleEnabled:value.scheduleEnabled, scheduler:value.scheduler, policy:value.policy }, payload));
      return saved;
    };
    const afterSave = () => {
      state.automationDirty = false; state.automationDraft = null;
      toast('自主调度已保存', '配置已生效，重启后保留。发表仍受当前模式、暂停和 Kill Switch 约束。', 'success');
      refreshCurrent(true);
    };
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const payload = JSON.parse(JSON.stringify(draft));
      if (payload.policy.humanize.enabled || (payload.scheduleEnabled && !saved.scheduleEnabled)) {
        openModal({ title: '保存并启用自主调度？',
          subtitle: payload.policy.humanize.enabled ? '已审核或已批准的队列内容可能按新设置自动发送。' : '后台可能调用模型自主创作内容。',
          content: [h('p', {}, `当前发表模式：${modeText(mode)}。本操作不修改发表模式，也不解除暂停或 Kill Switch。`)],
          confirmText: '确认保存', onConfirm: () => saveVerified(payload), after: afterSave });
        return;
      }
      save.disabled = true;
      try { await saveVerified(payload); afterSave(); }
      catch (error) { notice.textContent = `保存失败：${describeError(error).detail || String(error)}；修改尚未保存。`; toast('调度保存失败', notice.textContent, 'error'); }
      finally { save.disabled = false; }
    });
    form.append(notice, h('div', { class: 'schedule-actions' }, save, reset));
    card.appendChild(form);
    return card;
  }

  function buildMemoryCard() {
    const output = h('div', { class: 'persona-pre' }, '点击刷新查看已保存的记忆。');
    const kind = h('select', { class: 'select', 'aria-label': '记忆类型' },
      ...Object.entries({persona:'人格偏好',episodic:'经历与反馈',semantic:'已核实的知识',operational:'运行记录'})
        .map(([value,label]) => h('option', { value }, label)));
    const key = h('input', { class: 'input', placeholder: '记忆名称', 'aria-label': '记忆名称', maxLength: 120 });
    const value = h('textarea', { class: 'textarea', placeholder: '明确授权保存的观点或偏好', 'aria-label': '记忆内容', rows: 4, maxLength: 2000 });
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
      const memories = await request('/proxy/api/memories');
      output.replaceChildren(...memories.filter((memory) => memory.kind !== 'operational').map((memory) =>
        h('div', { class: 'field' }, h('strong', {}, memory.key), h('p', {}, memory.value),
          action('删除这条记忆', async () => {
            await request('/proxy/api/memories/' + encodeURIComponent(memory.memoryId), { method: 'DELETE' });
            await refresh();
          }))));
      if (!output.childElementCount) output.textContent = '暂无内容记忆。';
    };
    const field = (label, control) => h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), control);
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', { class: 'card-title' }, '长期记忆')),
      h('div', { class: 'card-body' },
        action('刷新', refresh), output, field('记忆类型', kind), field('记忆名称', key), field('记忆内容', value),
        action('保存记忆', async () => {
          await request('/proxy/api/memories', { method: 'POST', body: { kind: kind.value, key: key.value, value: value.value } });
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
      // 首次配置向导优先响应 Esc / Tab（它不是通用 Modal）
      if (state.setup.wizardOpen) {
        if (event.key === 'Escape') {
          event.preventDefault();
          closeSetupWizard({ skipped: true });
          return;
        }
        if (event.key === 'Tab') {
          setupWizardTrapFocus(event);
          return;
        }
        return;
      }
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
        refreshCurrent(true, { discardSettings: true });
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
    // run_server 首次启动会在 URL 带 ?firstrun=1（前端 hash 路由不受影响），仅作显式标记。
    try { state.firstrun.urlMarker = new URLSearchParams(location.search).get('firstrun') === '1'; } catch { state.firstrun.urlMarker = false; }
    // 首次启动状态与自动配置检测并行读取；接口最多等待约 5 秒后返回 pending，不阻塞页面渲染。
    const firstRunPromise = loadFirstRunInfo();
    const setupPromise = loadSetupState({ quiet: true });
    await loadClientInfo();
    try {
      const detected=await api.discovery();
      const pluginRoot=detected.activePlugin?.packageRoot||(detected.plugins?.length===1?detected.plugins[0].path:null);
      const pythonPath=(detected.dsh||[]).find(x=>x.pythonPath)?.pythonPath;
      const patches=detected.profiles||[];
      const replacements=[[SETUP_ROOT,pluginRoot],[SETUP_DSH_PYTHON,pythonPath],
        [SETUP_PROFILE_PATCH,patches.length===1?patches[0].patchPath:null]];
      const replaceText=value=>{
        if(Array.isArray(value))return value.map(replaceText);
        if(value&&typeof value==='object') {for(const key of Object.keys(value))value[key]=replaceText(value[key]);return value;}
        if(typeof value==='string')for(const [before,after] of replacements)if(after)value=value.split(before).join(after);
        return value;
      };
      SETUP_STEPS.forEach(replaceText);
    } catch { /* Discovery is optional; the tutorial remains readable offline. */ }
    await setupPromise;
    const route = parseRoute();
    // 非概览页也预取一次核心快照，保证顶栏账号 / 模式 / 待审批角标可用
    if (route.name !== 'dashboard') await loadCore();
    await applyRoute(route);
    // 首次启动：概览页弹出「欢迎 / 自动配置」Modal（只读检测；写入必须二次确认）。
    // 旧的全屏教程向导仅在首次启动接口不可用时兜底；直接深链到其它页面时不打断。
    await firstRunPromise.catch(() => null);
    const firstRunShown = maybeOpenFirstRunWelcome();
    if (!firstRunShown) maybeAutoOpenSetupWizard();
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
