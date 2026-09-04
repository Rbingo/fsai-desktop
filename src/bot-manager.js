// Bot Manager：Bot 生命周期编排（创建/启动/停止/重启/复制/删除）
// 把 FeishuAdapter + ModelResolver + ClaudeAdapter/Codex 串起来
const path = require('path');
const { RuntimeManager } = require('./runtime-manager');
const { FeishuAdapter } = require('./feishu-adapter');
const { resolve } = require('./model-resolver');
const { resolveExecutable } = require('./doctor');
const { newBot, genId } = require('./models');
const { ChatLog } = require('./chat-log');
const { ApprovalManager } = require('./approvals/ApprovalManager');
const { buildApprovalCard, buildQuestionCard, buildResolvedCard } = require('./approvals/feishu-cards');

class BotManager {
  constructor({ store, logger, runtimeBaseDir, claudePath, codexPath, ccSwitchPath, emit, chatLogDir, claudeSdk }) {
    this.store = store;
    this.logger = logger;
    this.ccSwitchPath = ccSwitchPath;
    this.emit = emit || (() => {}); // 向 UI 推送状态变化
    this.runtime = new RuntimeManager({ runtimeBaseDir, claudePath, codexPath, logger });
    this.sessions = new Map(); // botId -> { adapter, resolved, claude, sessionId }
    this.chatLog = new ChatLog({ baseDir: chatLogDir || path.join(runtimeBaseDir, '..', 'chatlog'), logger });
    this.approvalManager = new ApprovalManager({ logger });
    this.claudeSdk = claudeSdk || null; // require('@anthropic-ai/claude-agent-sdk')
    // 记录 approvalId -> { botId, messageId } 用于处理后的卡片更新与答复
    this.approvalCtx = new Map();
  }

  // 按 runtime.type 分派执行（claude / codex）
  // claude 若已启用 Agent SDK（ClaudeAdapter），走 canUseTool 审批闭环；否则回退旧 CLI
  async _runResolved(runtimeBot, prompt, resolved) {
    if (resolved.runtime === 'codex') {
      return this.runtime.runCodexOnce(runtimeBot, prompt, resolved.codex);
    }
    // claude：优先 Agent SDK
    const sess = this.sessions.get(runtimeBot.id);
    if (sess?.claude) {
      const taskId = `task-${runtimeBot.id}`;
      const r = await sess.claude.startTask({
        taskId,
        projectPath: runtimeBot.workspacePath,
        prompt,
        resumeSessionId: sess.sessionId || undefined,
      });
      if (r.ok && r.sessionId) sess.sessionId = r.sessionId;
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

      // 卡片按钮回调（审批）
      adapter.onCardActionHandler(async (evt) => {
        await this._handleCardAction(botId, adapter, evt);
      });

      await adapter.connect(async (msg) => {
        await this._handleMessage(botId, runtimeBot, msg);
      });

      // 为 claude runtime 准备 ClaudeAdapter（Agent SDK 模式）
      let claude = null;
      if (v.resolved.runtime === 'claude' && this.claudeSdk) {
        const { ClaudeAdapter } = require('./agents/claude/ClaudeAdapter');
        // 解析出真实的 claude.exe（SDK 需要可执行文件路径，而非 .cmd shim）
        const resolvedClaude = resolveExecutable(this.runtime.claudePath) || { cmd: this.runtime.claudePath };
        claude = new ClaudeAdapter({
          sdk: this.claudeSdk,
          approvalManager: this.approvalManager,
          logger: this.logger,
          env: v.resolved.env || {},
          cwd: ws.path,
          claudeExecutablePath: resolvedClaude.cmd,
        });
        // 审批请求 → 发飞书卡片
        claude.onApprovalRequest = (req) => {
          this._sendApprovalCard(botId, adapter, runtimeBot, req);
        };
      }

      this.sessions.set(botId, { adapter, resolved: v.resolved, claude, sessionId: null });
      this._setStatus(botId, 'running');
      this.logger.info(bot.id, `started (model: ${v.resolved.detail.name}, runtime: ${v.resolved.runtime})`);
      return { ok: true };
    } catch (e) {
      this._setStatus(botId, 'error');
      this.logger.error(bot.id, `start failed: ${e.message}`);
      return { ok: false, error: e.message };
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

    const startTs = Date.now();
    const result = await this._runResolved(runtimeBot, msg.content, sess.resolved);
    const durationMs = Date.now() - startTs;

    if (result.ok) {
      this.logger.info(botId, `replied (${result.text.length} chars)`);
      const reply = this._truncate(result.text, 4000);
      // 记录回复（审计）
      this.chatLog.logReply(botId, { chatId: msg.chatId, messageId: msg.messageId, content: reply, durationMs, ok: true });
      try {
        await sess.adapter.sendReply(msg.chatId, reply, { replyTo: msg.messageId });
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
    const value = evt.action?.value;
    if (!value || typeof value !== 'object') return;

    const approvalId = value.approvalId;
    const decision = value.decision;
    if (!approvalId || !decision) return;

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
    return this._runResolved(runtimeBot, text, v.resolved);
  }
}

module.exports = { BotManager };
