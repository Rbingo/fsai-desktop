// Bot Manager：Bot 生命周期编排（创建/启动/停止/重启/复制/删除）
// 把 FeishuAdapter + ModelResolver + ClaudeAdapter/Codex 串起来
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { RuntimeManager } = require('./runtime-manager');
const { FeishuAdapter } = require('./feishu-adapter');
const { resolve } = require('./model-resolver');
const { resolveExecutable } = require('./doctor');
const { newBot, genId } = require('./models');
const { ChatLog } = require('./chat-log');
const { ApprovalManager } = require('./approvals/ApprovalManager');
const { buildApprovalCard, buildQuestionCard, buildResolvedCard } = require('./approvals/feishu-cards');

// 把飞书 chatId（如 oc_xxx）安全化为目录名：确定性 + 路径安全 + 防碰撞
function safeChatId(chatId) {
  const s = String(chatId || '');
  const hash = crypto.createHash('sha1').update(s).digest('hex').slice(0, 8);
  const cleaned = s
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^[._-]+/, '')
    .slice(0, 40);
  return cleaned ? `${cleaned}-${hash}` : `c-${hash}`;
}

// 群工作目录的项目级 CLAUDE.md 模板
// 让 Bot 知道：通用知识在共享层，这个群的专属记忆写到本地 memory/
const CHAT_WORKSPACE_CLAUDE_MD = (botName, chatId) => `# 本群工作区（${botName}）

<!-- 这个文件是「项目级」知识，只对本飞书群生效。
     它与 Bot 的「用户级」共享知识（跨群通用规则）会自动合并。 -->

## 群信息

- 群 ID：\`${chatId}\`
- 这是该群独立的工作目录，改动不会影响其他群

## 记忆约定

- **本群专属**的记忆（项目背景、群内约定、讨论结论）→ 写入 \`memory/\` 目录
  - 例如：\`memory/project-context.md\`、\`memory/decisions.md\`
- **跨群通用**的知识（通用规则、技能、术语表）→ 由用户维护在共享知识库中，不要写这里
- 需要回忆本群之前的内容时，用 Read 工具读 \`memory/\` 下的文件

## 目录说明

- \`memory/\` —— 本群积累的记忆（按主题分文件）
- 其他文件 —— 该群的产出物（代码、文档等）
`;

class BotManager {
  constructor({ store, logger, runtimeBaseDir, claudePath, codexPath, ccSwitchPath, emit, chatLogDir, claudeSdk, knowledge }) {
    this.store = store;
    this.logger = logger;
    this.ccSwitchPath = ccSwitchPath;
    this.emit = emit || (() => {}); // 向 UI 推送状态变化
    this.runtime = new RuntimeManager({ runtimeBaseDir, claudePath, codexPath, logger });
    this.sessions = new Map(); // botId -> { adapter, resolved, claude, sessionId, chatSessions }
    this.chatLog = new ChatLog({ baseDir: chatLogDir || path.join(runtimeBaseDir, '..', 'chatlog'), logger });
    this.approvalManager = new ApprovalManager({ logger });
    this.claudeSdk = claudeSdk || null; // require('@anthropic-ai/claude-agent-sdk')
    this.knowledge = knowledge || null; // KnowledgeManager
    // 记录 approvalId -> { botId, messageId } 用于处理后的卡片更新与答复
    this.approvalCtx = new Map();
  }

  // 初始化群工作目录的脚手架：memory/ + 项目级 CLAUDE.md
  // 这是「记忆按群隔离」的落地点——Claude Code 会读取 cwd 下的 CLAUDE.md（项目级），
  // 与 Bot 级共享 CLAUDE.md（用户级）自动合并。
  _ensureChatWorkspaceScaffold(dir, bot, chatId) {
    try {
      fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
      const md = path.join(dir, 'CLAUDE.md');
      if (!fs.existsSync(md)) {
        fs.writeFileSync(md, CHAT_WORKSPACE_CLAUDE_MD(bot.name || 'Bot', chatId));
        this.logger.info(bot.id, `已为群 ${chatId} 初始化工作目录脚手架`);
      }
    } catch (e) {
      this.logger?.warn(bot.id, `初始化群脚手架失败: ${e.message}`);
    }
  }

  // 计算并确保某群的工作目录（per-chat 模式）。非 per-chat 或没有 chatId 时返回 null（走共享目录）
  resolveChatWorkspace(bot, chatId) {
    if (!bot || bot.workspaceMode !== 'per-chat' || !chatId) return null;
    const ws = this.store.getWorkspace(bot.workspaceId);
    if (!ws?.path) return null;
    const dir = path.join(ws.path, safeChatId(chatId));
    try {
      fs.mkdirSync(dir, { recursive: true });
      // 初始化群专属的记忆目录与项目级 CLAUDE.md（每群一份，记忆按群隔离）
      this._ensureChatWorkspaceScaffold(dir, bot, chatId);
    } catch (e) {
      this.logger.warn(bot.id, `创建群工作目录失败: ${e.message}`);
      return null;
    }
    if (!bot.chatWorkspaces) bot.chatWorkspaces = {};
    if (!bot.chatWorkspaces[chatId]) {
      bot.chatWorkspaces[chatId] = { path: dir, createdAt: Date.now() };
      this.store.upsertBot(bot);
      this.logger.info(bot.id, `为群 ${chatId} 创建独立工作目录: ${dir}`);
    }
    return dir;
  }

  // 会话与路径一致性：工作目录变了就重置该群的会话，避免 resume 到错误目录
  _reconcileSession(botId, sess, chatId, workspacePath) {
    if (!chatId || !workspacePath) return;
    if (!sess.lastPathByChat) sess.lastPathByChat = new Map();
    const prev = sess.lastPathByChat.get(chatId);
    if (prev && prev !== workspacePath && sess.chatSessions?.has(chatId)) {
      this.logger.info(botId, `群 ${chatId} 工作目录变更 ${prev} → ${workspacePath}，重置会话`);
      sess.chatSessions.delete(chatId);
      const bot = this.store.getBot(botId);
      if (bot?.chatSessions) {
        delete bot.chatSessions[chatId];
        this.store.upsertBot(bot);
      }
    }
    sess.lastPathByChat.set(chatId, workspacePath);
  }

  // 列出某 Bot 的所有群工作目录（供 UI）
  listChatWorkspaces(botId) {
    const bot = this.store.getBot(botId);
    if (!bot) return [];
    const reg = bot.chatWorkspaces || {};
    return Object.entries(reg).map(([chatId, info]) => {
      const dir = info?.path || '';
      // 统计该群的记忆文件（按群隔离的产物）
      let memories = [];
      try {
        const memDir = path.join(dir, 'memory');
        if (dir && fs.existsSync(memDir)) {
          memories = fs.readdirSync(memDir, { withFileTypes: true })
            .filter((d) => d.isFile())
            .map((d) => d.name);
        }
      } catch (e) { /* ignore */ }
      return {
        chatId,
        path: dir,
        createdAt: info?.createdAt || null,
        exists: dir ? fs.existsSync(dir) : false,
        memories,
      };
    });
  }

  // 移除某群的工作目录（只删空目录或强制删除，绝不误删用户数据）
  async removeChatWorkspace(botId, chatId, { force = false } = {}) {
    const bot = this.store.getBot(botId);
    if (!bot?.chatWorkspaces?.[chatId]) return { ok: true, removed: false };
    const info = bot.chatWorkspaces[chatId];
    const dir = info.path;
    let dirty = false;
    try {
      if (dir && fs.existsSync(dir)) {
        const entries = fs.readdirSync(dir);
        if (entries.length > 0 && !force) {
          return { ok: false, dirty: true, error: '该群工作目录非空，强制移除会丢失其中的文件' };
        }
        if (entries.length > 0) dirty = true;
      }
    } catch (e) { /* ignore */ }
    try {
      if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      return { ok: false, error: `删除失败: ${e.message}` };
    }
    delete bot.chatWorkspaces[chatId];
    // 同时清理该群会话，避免残留
    if (bot.chatSessions?.[chatId]) delete bot.chatSessions[chatId];
    this.store.upsertBot(bot);
    this.logger.info(botId, `已移除群 ${chatId} 工作目录`);
    return { ok: true, removed: true, dirty };
  }

  // 按 runtime.type 分派执行（claude / codex）
  // claude 若已启用 Agent SDK（ClaudeAdapter），走 canUseTool 审批闭环；否则回退旧 CLI
  // workspacePath：该群的工作目录（per-chat 模式下每群不同），为空则用 bot 默认
  async _runResolved(runtimeBot, prompt, resolved, chatId, workspacePath) {
    const cwd = workspacePath || runtimeBot.workspacePath;
    if (resolved.runtime === 'codex') {
      return this.runtime.runCodexOnce({ ...runtimeBot, workspacePath: cwd }, prompt, resolved.codex);
    }
    // claude：优先 Agent SDK
    const sess = this.sessions.get(runtimeBot.id);
    if (sess?.claude) {
      const taskId = `task-${runtimeBot.id}`;
      // 按 chatId 隔离会话上下文：同一 Bot 在不同群有独立的 Claude session
      const sessionId = chatId ? sess.chatSessions?.get(chatId) : sess.sessionId;
      const r = await sess.claude.startTask({
        taskId,
        projectPath: cwd,
        prompt,
        resumeSessionId: sessionId || undefined,
      });
      // 保存该群对应的 sessionId（同时持久化到 bot 对象）
      if (r.ok && r.sessionId) {
        if (chatId) {
          if (!sess.chatSessions) sess.chatSessions = new Map();
          sess.chatSessions.set(chatId, r.sessionId);
          // 持久化到 store（跨重启恢复）
          const bot = this.store.getBot(runtimeBot.id);
          if (bot) {
            if (!bot.chatSessions) bot.chatSessions = {};
            bot.chatSessions[chatId] = r.sessionId;
            this.store.upsertBot(bot);
          }
        } else {
          sess.sessionId = r.sessionId;
        }
      }
      return r;
    }
    // 回退：旧 CLI
    return this.runtime.runOnce(runtimeBot, prompt, resolved.env || {});
  }

  _runtimeErrorLabel(resolved) {
    return resolved.runtime === 'codex' ? 'Codex error' : 'Claude Code error';
  }

  // 启动校验流程（PRD 第 24 节）
  validate(bot) {
    const errors = [];
    if (!bot.name) errors.push('Bot name is empty');
    if (!bot.feishu?.appId || !bot.feishu?.appSecret) errors.push('Feishu App ID/Secret missing');
    const ws = this.store.getWorkspace(bot.workspaceId);
    if (!ws || !ws.path) errors.push('Workspace not set or missing path');
    const resolved = resolve(bot, this.store, { ccSwitchPath: this.ccSwitchPath });
    if (!resolved.ok) errors.push(resolved.error);
    return { ok: errors.length === 0, errors, resolved };
  }

  async start(botId) {
    const bot = this.store.getBot(botId);
    if (!bot) return { ok: false, error: 'Bot not found' };
    if (this.sessions.has(botId)) return { ok: true, alreadyRunning: true };

    const v = this.validate(bot);
    if (!v.ok) {
      this._setStatus(botId, 'error');
      this.logger.error(bot.id, `validation failed: ${v.errors.join('; ')}`);
      return { ok: false, errors: v.errors };
    }

    this._setStatus(botId, 'starting');

    // 注册 Secret 用于日志脱敏
    this.logger.registerSecret(bot.feishu.appSecret);
    const directP = this.store.getDirectProfile(bot.model.profile);
    if (directP) this.logger.registerSecret(directP.apiKey);
    if (v.resolved?.codex?.apiKey) this.logger.registerSecret(v.resolved.codex.apiKey);
    if (v.resolved?.env?.ANTHROPIC_API_KEY) this.logger.registerSecret(v.resolved.env.ANTHROPIC_API_KEY);

    try {
      const ws = this.store.getWorkspace(bot.workspaceId);
      // 把 workspace 路径注入 runtime 的 cwd
      const runtimeBot = { ...bot, workspacePath: ws.path };

      const adapter = new FeishuAdapter({
        appId: bot.feishu.appId,
        appSecret: bot.feishu.appSecret,
        logger: this.logger,
      });

      // 卡片按钮回调（审批）—— 双通道：
      // 1. 注册到全局表，供 feishu-sdk-patch 直接调用（绕过 SDK pushAction/lock 卡住问题）
      // 2. 保留 adapter.onCardActionHandler 作为兜底
      if (!global.__fsaiCardActionHandlers) global.__fsaiCardActionHandlers = [];
      global.__fsaiCardActionHandlers.push(async (evt) => {
        await this._handleCardAction(botId, adapter, evt);
      });
      adapter.onCardActionHandler(async (evt) => {
        await this._handleCardAction(botId, adapter, evt);
      });

      await adapter.connect(async (msg) => {
        await this._handleMessage(botId, runtimeBot, msg);
      }, { listenAll: !!(bot.listen?.enabled) });

      // 为 claude runtime 准备 ClaudeAdapter（Agent SDK 模式）
      let claude = null;
      if (v.resolved.runtime === 'claude' && this.claudeSdk) {
        const { ClaudeAdapter } = require('./agents/claude/ClaudeAdapter');
        // 解析出真实的 claude.exe（SDK 需要可执行文件路径，而非 .cmd shim）
        const resolvedClaude = resolveExecutable(this.runtime.claudePath) || { cmd: this.runtime.claudePath };
        // Runtime 隔离：Bot 专属 HOME + 知识内核目录（claude 配置目录）
        const botHome = this.runtime.ensureBotHome(botId);
        const knowledgeDir = path.join(botHome, '.claude');
        if (this.knowledge) this.knowledge.ensure(botId);
        claude = new ClaudeAdapter({
          sdk: this.claudeSdk,
          approvalManager: this.approvalManager,
          logger: this.logger,
          env: v.resolved.env || {},
          cwd: ws.path,
          claudeExecutablePath: resolvedClaude.cmd,
          homeDir: botHome,
          configDir: knowledgeDir,
        });
        // 审批请求 → 发飞书卡片
        claude.onApprovalRequest = (req) => {
          this._sendApprovalCard(botId, adapter, runtimeBot, req);
        };
      }

      // 从持久化的 bot.chatSessions 恢复各群会话（跨重启续接）
      const persistedSessions = new Map();
      if (bot.chatSessions && typeof bot.chatSessions === 'object') {
        for (const [chatId, sessionId] of Object.entries(bot.chatSessions)) {
          persistedSessions.set(chatId, sessionId);
        }
      }
      this.sessions.set(botId, { adapter, resolved: v.resolved, claude, sessionId: null, chatSessions: persistedSessions });
      this._setStatus(botId, 'running');
      this.logger.info(bot.id, `started (model: ${v.resolved.detail.name}, runtime: ${v.resolved.runtime}), 恢复 ${persistedSessions.size} 个群会话`);
      return { ok: true };
    } catch (e) {
      this._setStatus(botId, 'error');
      this.logger.error(bot.id, `start failed: ${e.message}`);
      return { ok: false, error: e.message };
    }
  }

  // 知识投喂：识别「带附件的消息」或「记住：xxx」指令，存入知识库
  // 返回 null 表示不是投喂消息（继续走正常流程），否则返回回执文本
  async _tryIngest(botId, bot, sess, msg) {
    if (!this.knowledge) return null;
    const content = String(msg.content || '').trim();
    const resources = Array.isArray(msg.resources) ? msg.resources : [];
    const files = resources.filter((r) => r.type === 'file');

    // 情形 1：消息带文件附件 → 投喂文件
    if (files.length > 0) {
      this.knowledge.ensure(botId);
      const results = [];
      for (const f of files) {
        try {
          const buf = await sess.adapter.downloadResource(f.fileKey, 'file');
          const r = this.knowledge.ingestFile(botId, f.fileName || f.fileKey, buf);
          results.push(r.ok ? `✅ ${r.fileName}（${(r.size / 1024).toFixed(1)}KB）` : `❌ ${f.fileName}: ${r.error}`);
        } catch (e) {
          results.push(`❌ ${f.fileName || f.fileKey}: 下载失败 ${e.message}`);
        }
      }
      const reply = `📚 已存入知识库（所有群共享）：\n${results.join('\n')}`;
      this._trackBotMessage(sess, (await sess.adapter.sendReply(msg.chatId, reply, { replyTo: msg.messageId }))?.messageId);
      this.logger.info(botId, `投喂 ${files.length} 个文件`);
      return reply;
    }

    // 情形 2：「记住：xxx」/「记住这个：xxx」指令 → 投喂文本
    const m = content.match(/^(?:@\S+\s*)?记住(?:这个)?[：:]\s*([\s\S]+)$/);
    if (m && m[1].trim()) {
      const r = this.knowledge.ingestText(botId, m[1].trim(), { title: `note-${Date.now().toString(36)}` });
      const reply = r.ok
        ? `📚 已记住（所有群共享）：\n${m[1].trim().slice(0, 200)}`
        : `❌ 保存失败：${r.error}`;
      this._trackBotMessage(sess, (await sess.adapter.sendReply(msg.chatId, reply, { replyTo: msg.messageId }))?.messageId);
      this.logger.info(botId, `投喂文本 ${r.fileName || ''}`);
      return reply;
    }

    return null;
  }

  // 全局监听模式：判断群消息是否需要回复（分层：规则预筛 → AI 判断）
  async _shouldReply(bot, sess, msg) {
    const { ruleGate, buildJudgePrompt, parseJudgeResult, DECISION } = require('./intent');

    const gate = ruleGate(msg, {
      botName: bot.name,
      botMessageIds: sess.botMessageIds,
      triggers: (bot.listen?.triggers || []).length ? bot.listen.triggers : undefined,
    });

    if (gate.decision === DECISION.REPLY) {
      this.logger.debug(bot.id, `意图判断: 回复（${gate.reason}）`);
      return true;
    }
    if (gate.decision === DECISION.IGNORE) {
      this.logger.debug(bot.id, `意图判断: 忽略（${gate.reason}）`);
      return false;
    }

    // ASK_AI：规则不确定，交给模型判断（可关闭）
    if (!bot.listen?.useAIJudge) {
      this.logger.debug(bot.id, `意图判断: 忽略（${gate.reason} 且未启用 AI 判断）`);
      return false;
    }
    try {
      const prompt = buildJudgePrompt(msg, { botName: bot.name });
      const r = await this._runResolved({ ...bot, workspacePath: this.store.getWorkspace(bot.workspaceId)?.path },
        prompt, sess.resolved, msg.chatId, undefined);
      const yes = r.ok && parseJudgeResult(r.text);
      this.logger.debug(bot.id, `意图判断: AI 判定 ${yes ? '回复' : '忽略'}（${gate.reason}）`);
      return yes;
    } catch (e) {
      this.logger.warn(bot.id, `意图判断 AI 调用失败，保守忽略: ${e.message}`);
      return false;
    }
  }

  // 记录机器人自己发出的消息 ID（用于「回复机器人」意图识别）
  _trackBotMessage(sess, messageId) {
    if (!messageId) return;
    if (!sess.botMessageIds) sess.botMessageIds = new Set();
    sess.botMessageIds.add(messageId);
    // 限制集合大小，避免内存无限增长
    if (sess.botMessageIds.size > 500) {
      const first = sess.botMessageIds.values().next().value;
      sess.botMessageIds.delete(first);
    }
  }

  async _handleMessage(botId, runtimeBot, msg) {
    this.logger.info(botId, `message from ${msg.chatId}: ${msg.content.slice(0, 200)}`);
    // 记录用户消息（审计）
    this.chatLog.logUser(botId, { chatId: msg.chatId, messageId: msg.messageId, content: msg.content });

    // 简单并发控制：同一 Bot 同时只处理一条消息，避免进程混乱
    const sess = this.sessions.get(botId);
    if (!sess) return '[FSAI] bot not running';
    // 记录当前会话，供审批卡片发送时定位
    sess.currentChatId = msg.chatId;

    const bot = this.store.getBot(botId) || runtimeBot;

    // 知识投喂：带附件或「记住」指令的消息，直接存入知识库
    const ingested = await this._tryIngest(botId, bot, sess, msg);
    if (ingested) return ingested;

    // 全局监听模式：先判断这条消息是否需要回复（不需要则静默记录并返回）
    if (bot.listen?.enabled) {
      const shouldReply = await this._shouldReply(bot, sess, msg);
      if (!shouldReply) {
        this.logger.debug(botId, `群消息已记录但按意图忽略: ${msg.content.slice(0, 60)}`);
        return '';
      }
    }

    // 解析该群的工作目录（per-chat 模式下每群独立；shared 模式返回 null 走默认）
    const chatWs = this.resolveChatWorkspace(bot, msg.chatId);
    this._reconcileSession(botId, sess, msg.chatId, chatWs || runtimeBot.workspacePath);

    const startTs = Date.now();
    const result = await this._runResolved(runtimeBot, msg.content, sess.resolved, msg.chatId, chatWs || undefined);
    const durationMs = Date.now() - startTs;

    if (result.ok) {
      this.logger.info(botId, `replied (${result.text.length} chars)`);
      const reply = this._truncate(result.text, 4000);
      // 记录回复（审计）
      this.chatLog.logReply(botId, { chatId: msg.chatId, messageId: msg.messageId, content: reply, durationMs, ok: true });
      try {
        const sent = await sess.adapter.sendReply(msg.chatId, reply, { replyTo: msg.messageId });
        this._trackBotMessage(sess, sent?.messageId);
      } catch (e) {
        this.logger.error(botId, `send reply failed: ${e.message}`);
      }
      return reply;
    } else {
      this.logger.error(botId, `runtime error: ${result.error}`);
      const reply = `[FSAI] ${this._runtimeErrorLabel(sess.resolved)}: ${result.error}`;
      // 记录错误（审计）
      this.chatLog.logReply(botId, { chatId: msg.chatId, messageId: msg.messageId, content: reply, durationMs, ok: false, error: result.error });
      try {
        await sess.adapter.sendReply(msg.chatId, reply, { replyTo: msg.messageId });
      } catch (e) { /* ignore */ }
      return reply;
    }
  }

  _truncate(s, n) {
    return s.length > n ? s.slice(0, n) + '\n…(truncated)' : s;
  }

  // 审批请求 → 发飞书卡片
  async _sendApprovalCard(botId, adapter, runtimeBot, req) {
    try {
      let card;
      if (req.type === 'question') {
        card = buildQuestionCard({ approvalId: req.approvalId, taskId: req.taskId, question: req.question });
      } else {
        card = buildApprovalCard({
          approvalId: req.approvalId,
          taskId: req.taskId,
          agent: req.agent,
          type: req.type,
          title: req.title,
          description: req.description,
          risk: req.risk,
        });
      }
      const result = await adapter.sendCard(req.chatId || runtimeBot.feishuChatId || this.sessions.get(botId)?.currentChatId, card);
      // 记录卡片 messageId 与上下文，便于处理后更新
      this.approvalCtx.set(req.approvalId, {
        botId,
        messageId: result?.messageId || null,
        card,
        taskId: req.taskId,
      });
      this.logger.info(botId, `approval card sent: ${req.approvalId} (${req.type})`);
    } catch (e) {
      this.logger.error(botId, `send approval card failed: ${e.message}`);
      // 发卡失败时直接拒绝，避免 Claude 永久挂起
      this.approvalManager.rejectApproval(req.approvalId, '发送审批卡片失败');
    }
  }

  // 处理飞书卡片按钮点击
  async _handleCardAction(botId, adapter, evt) {
    let value = evt.action?.value;
    if (!value) {
      this.logger.warn(botId, 'card action 缺少 value');
      return;
    }
    // 飞书会把 value 双重 JSON 序列化（字符串里套字符串），递归 parse 直到得到对象
    let depth = 0;
    while (typeof value === 'string' && depth < 5) {
      const trimmed = value.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('"')) {
        try {
          value = JSON.parse(value);
        } catch (e) {
          // 已经是纯字符串，无法继续 parse
          break;
        }
      } else {
        break;
      }
      depth++;
    }
    this.logger.info(botId, `[cardAction] 解析后 value (类型 ${typeof value}): ${JSON.stringify(value).slice(0, 200)}`);
    if (typeof value !== 'object' || value === null) {
      this.logger.warn(botId, `card action value 解析后仍不是对象: ${typeof value}`);
      return;
    }

    const approvalId = value.approvalId;
    const decision = value.decision;
    if (!approvalId || !decision) {
      this.logger.warn(botId, `card action 缺少 approvalId/decision: ${JSON.stringify(value).slice(0, 100)}`);
      return;
    }

    const ctx = this.approvalCtx.get(approvalId);
    const pending = this.approvalManager.pending.get(approvalId);

    if (!pending || pending.resolved) {
      // 已处理或失效
      try { await adapter.sendReply(evt.chatId, '该审批已经处理或已失效'); } catch (e) {}
      return;
    }

    // 校验 approval 绑定同一 bot（安全要求第 3 条）
    if (ctx && ctx.botId !== botId) {
      this.logger.warn(botId, `approval ${approvalId} 不属于该 bot`);
      return;
    }

    let decisionText;
    if (decision === 'allow') {
      this.approvalManager.resolveApproval(approvalId, { allowForSession: false });
      decisionText = '已允许';
    } else if (decision === 'allow_session') {
      this.approvalManager.resolveApproval(approvalId, { allowForSession: true });
      decisionText = '已本会话允许';
    } else if (decision === 'deny') {
      this.approvalManager.rejectApproval(approvalId, '用户拒绝');
      decisionText = '已拒绝';
    } else if (decision === 'answer') {
      // AskUserQuestion 的回答
      this.approvalManager.resolveApproval(approvalId, { allowForSession: false, answer: { answer: value.answer } });
      decisionText = `已选择：${value.answer || ''}`;
    }

    this.logger.info(botId, `card action ${decision} on ${approvalId}`);

    // 更新卡片为已处理状态
    if (ctx?.messageId && ctx.card) {
      try {
        const resolvedCard = buildResolvedCard(ctx.card, decisionText);
        await adapter.updateCard(ctx.messageId, resolvedCard);
      } catch (e) {
        this.logger.warn(botId, `update card failed: ${e.message}`);
      }
    }
  }

  async stop(botId) {
    const sess = this.sessions.get(botId);
    if (sess) {
      try { await sess.adapter.disconnect(); } catch (e) { /* ignore */ }
      this.sessions.delete(botId);
    }
    this._setStatus(botId, 'stopped');
    this.logger.info(botId, 'stopped');
    return { ok: true };
  }

  async restart(botId) {
    await this.stop(botId);
    return this.start(botId);
  }

  // 复制（PRD 第 28 节：默认不复制 Feishu Secret）
  duplicate(botId) {
    const bot = this.store.getBot(botId);
    if (!bot) return null;
    const copy = {
      ...JSON.parse(JSON.stringify(bot)),
      id: genId('bot'),
      name: `${bot.name} (copy)`,
      feishu: { appId: '', appSecret: '' },
      lastStatus: 'stopped',
    };
    this.store.upsertBot(copy);
    return copy;
  }

  // 删除（PRD 第 29 节：绝不动 Workspace）
  async remove(botId) {
    await this.stop(botId);
    this.store.removeBot(botId);
    this.emit('bots-changed');
  }

  _setStatus(botId, status) {
    const bot = this.store.getBot(botId);
    if (bot) {
      bot.lastStatus = status;
      this.store.upsertBot(bot);
    }
    this.emit('bot-status', { botId, status });
  }

  // 单发一条消息（供测试控制台 / UI 调试使用），不经过飞书
  async testMessage(botId, text) {
    const bot = this.store.getBot(botId);
    if (!bot) return { ok: false, error: 'Bot not found' };
    const v = this.validate(bot);
    if (!v.ok) return { ok: false, errors: v.errors };
    const ws = this.store.getWorkspace(bot.workspaceId);
    const runtimeBot = { ...bot, workspacePath: ws.path };
    // 测试用：不绑定具体群，用独立上下文（chatId 传 null 走旧 sessionId 逻辑）
    return this._runResolved(runtimeBot, text, v.resolved, null);
  }
}

module.exports = { BotManager };
