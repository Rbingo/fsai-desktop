// Bot Manager：Bot 生命周期编排（创建/启动/停止/重启/复制/删除）
// 把 FeishuAdapter + ModelResolver + RuntimeManager 串起来
const path = require('path');
const { RuntimeManager } = require('./runtime-manager');
const { FeishuAdapter } = require('./feishu-adapter');
const { resolve } = require('./model-resolver');
const { newBot, genId } = require('./models');
const { ChatLog } = require('./chat-log');

class BotManager {
  constructor({ store, logger, runtimeBaseDir, claudePath, codexPath, ccSwitchPath, emit, chatLogDir }) {
    this.store = store;
    this.logger = logger;
    this.ccSwitchPath = ccSwitchPath;
    this.emit = emit || (() => {}); // 向 UI 推送状态变化
    this.runtime = new RuntimeManager({ runtimeBaseDir, claudePath, codexPath, logger });
    this.sessions = new Map(); // botId -> { adapter, resolved }
    this.chatLog = new ChatLog({ baseDir: chatLogDir || path.join(runtimeBaseDir, '..', 'chatlog'), logger });
  }

  // 按 runtime.type 分派执行（claude / codex）
  _runResolved(runtimeBot, prompt, resolved) {
    if (resolved.runtime === 'codex') {
      return this.runtime.runCodexOnce(runtimeBot, prompt, resolved.codex);
    }
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

      await adapter.connect(async (msg) => {
        await this._handleMessage(botId, runtimeBot, msg);
      });

      this.sessions.set(botId, { adapter, resolved: v.resolved });
      this._setStatus(botId, 'running');
      this.logger.info(bot.id, `started (model: ${v.resolved.detail.name})`);
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
