// 日志模块：分级日志 + Secret 脱敏（PRD 第 32 节）
const fs = require('fs');
const path = require('path');

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

class Logger {
  constructor(baseDir) {
    this.baseDir = baseDir;
    this.ring = []; // 内存环形缓冲，供 UI 查询
    this.maxRing = 1000;
    this.secrets = new Set(); // 需要脱敏的敏感值
    this.file = path.join(baseDir, 'fsai.log');
  }

  registerSecret(v) {
    if (v && typeof v === 'string' && v.length >= 6) this.secrets.add(v);
  }

  _redact(text) {
    if (!text) return text;
    let out = String(text);
    for (const s of this.secrets) {
      if (!s) continue;
      // sk-1234567890abcdef -> sk-****cdef
      const visible = s.slice(-4);
      const masked = `${s.slice(0, 2)}-****${visible}`;
      out = out.split(s).join(masked);
    }
    return out;
  }

  log(level, source, message, meta) {
    const lvl = LEVELS[level] != null ? level : 'info';
    const entry = {
      ts: Date.now(),
      level: lvl,
      source: source || 'app',
      message: this._redact(message),
      meta: meta ? this._redact(JSON.stringify(meta)) : undefined,
    };
    this.ring.push(entry);
    if (this.ring.length > this.maxRing) this.ring.shift();

    // 落盘（尽力而为，失败不阻塞）
    try {
      fs.mkdirSync(this.baseDir, { recursive: true });
      const line = `${new Date(entry.ts).toISOString()} [${entry.level.toUpperCase()}] [${entry.source}] ${entry.message}${entry.meta ? ' ' + entry.meta : ''}\n`;
      fs.appendFileSync(this.file, line);
    } catch (e) {
      /* ignore */
    }
    return entry;
  }

  debug(source, msg, meta) { return this.log('debug', source, msg, meta); }
  info(source, msg, meta) { return this.log('info', source, msg, meta); }
  warn(source, msg, meta) { return this.log('warn', source, msg, meta); }
  error(source, msg, meta) { return this.log('error', source, msg, meta); }

  // 查询日志（支持按 bot / level / 时间过滤）
  getLogs({ bot, level, since } = {}) {
    let logs = this.ring.slice();
    if (bot) logs = logs.filter((l) => l.source === bot || l.meta?.includes(bot));
    if (level) logs = logs.filter((l) => l.level === level);
    if (since) logs = logs.filter((l) => l.ts >= since);
    return logs;
  }

  clear() {
    this.ring = [];
  }
}

module.exports = { Logger, LEVELS };
