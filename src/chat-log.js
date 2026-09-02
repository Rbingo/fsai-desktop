// 聊天记录审计：为每个 Bot 持久化完整的问答记录，供审计/回溯
// 存储：JSONL 文件，每行一条消息事件。按 Bot 分文件存。
const fs = require('fs');
const path = require('path');

class ChatLog {
  constructor({ baseDir, logger }) {
    this.baseDir = baseDir; // 聊天记录根目录，每个 bot 一个子目录
    this.logger = logger;
  }

  _botFile(botId) {
    return path.join(this.baseDir, botId, 'chat.jsonl');
  }

  // 写入一条消息事件。type: 'user' | 'reply' | 'error'
  // record: { botId, chatId, messageId, content, ... }
  append(botId, type, record) {
    const file = this._botFile(botId);
    const entry = {
      ts: Date.now(),
      type,
      chatId: record.chatId || '',
      messageId: record.messageId || '',
      content: this.logger ? this.logger.redact(record.content || '') : (record.content || ''),
      durationMs: record.durationMs || null,
      ok: record.ok !== undefined ? record.ok : true,
      error: record.error ? (this.logger ? this.logger.redact(record.error) : record.error) : null,
    };
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify(entry) + '\n');
    } catch (e) {
      this.logger?.warn('chatlog', `append failed: ${e.message}`);
    }
    return entry;
  }

  // 记录一条用户消息（进站）
  logUser(botId, { chatId, messageId, content }) {
    return this.append(botId, 'user', { chatId, messageId, content });
  }

  // 记录一条回复（出站）
  logReply(botId, { chatId, messageId, content, durationMs, ok, error }) {
    return this.append(botId, 'reply', { chatId, messageId, content, durationMs, ok, error });
  }

  // 查询某个 Bot 的聊天记录（按时间正序返回，可选限制条数）
  query(botId, { limit = 500 } = {}) {
    const file = this._botFile(botId);
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const records = [];
    for (const line of lines) {
      try { records.push(JSON.parse(line)); } catch (e) { /* 跳过损坏行 */ }
    }
    // 取最后 limit 条
    return records.slice(-limit);
  }
}

module.exports = { ChatLog };
