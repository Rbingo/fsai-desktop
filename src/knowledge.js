// 知识内核管理：每个 Bot 一份「跨群共享」的知识层，升级一次所有群受益。
//
// 存储位置 = 该 Bot 隔离 HOME 下的 .claude 目录（即 Claude Code 的 CLAUDE_CONFIG_DIR）：
//   runtime/<botId>/home/.claude/
//     ├── CLAUDE.md     手动维护的共享知识（用户可编辑，Claude 自动读取）
//     ├── memory/       自动积累的记忆（Bot 自己写）
//     └── skills/       自动沉淀的技能（Bot 自己写；Claude Code 会自动加载）
//
// 因为所有群共用同一个 CLAUDE_CONFIG_DIR，所以这里的知识天然跨群共享。
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_KNOWLEDGE = `# Bot 知识库

<!-- 这是跨群共享的知识内核。所有群都会读到这份内容。
     你可以手动编辑，也可以让 Bot 把经验写进 memory/ 目录。 -->

## 通用规则

<!-- 例：回答用中文；改代码前先跑测试；不确定时先问 -->

## 项目背景

<!-- 例：这是一个电商后端，技术栈 Node + Postgres -->

## 已知偏好

<!-- 例：用户偏好简洁回答，不喜欢长篇解释 -->

## 记忆索引

<!-- Bot 自动积累的记忆在 memory/ 目录，可在此维护索引 -->
`;

class KnowledgeManager {
  constructor({ store, runtimeBaseDir, logger }) {
    this.store = store;
    this.runtimeBaseDir = runtimeBaseDir; // <userData>/runtime
    this.logger = logger;
  }

  // 该 Bot 的隔离 HOME（与 RuntimeManager.botHomeDir 保持一致）
  botHomeDir(botId) {
    return path.join(this.runtimeBaseDir, botId, 'home');
  }

  // 知识内核根目录 = 隔离 HOME 下的 .claude（即 CLAUDE_CONFIG_DIR）
  botConfigDir(botId) {
    return path.join(this.botHomeDir(botId), '.claude');
  }

  // 确保知识目录骨架存在；首次创建时写入 CLAUDE.md 模板
  ensure(botId) {
    const dir = this.botConfigDir(botId);
    try {
      fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'skills'), { recursive: true });
      const claudeMd = path.join(dir, 'CLAUDE.md');
      if (!fs.existsSync(claudeMd)) {
        fs.writeFileSync(claudeMd, DEFAULT_KNOWLEDGE);
        this.logger?.info('knowledge', `已为 ${botId} 创建知识内核模板`);
      }
      return dir;
    } catch (e) {
      this.logger?.warn('knowledge', `创建知识目录失败: ${e.message}`);
      return dir;
    }
  }

  // 读取共享知识（CLAUDE.md）
  readKnowledge(botId) {
    this.ensure(botId);
    const file = path.join(this.botConfigDir(botId), 'CLAUDE.md');
    try {
      return fs.readFileSync(file, 'utf8');
    } catch (e) {
      return '';
    }
  }

  // 写入共享知识
  writeKnowledge(botId, content) {
    this.ensure(botId);
    const file = path.join(this.botConfigDir(botId), 'CLAUDE.md');
    try {
      fs.writeFileSync(file, String(content ?? ''));
      this.logger?.info('knowledge', `${botId} 知识库已更新`);
      return { ok: true };
    } catch (e) {
      this.logger?.warn('knowledge', `写入知识库失败: ${e.message}`);
      return { ok: false, error: e.message };
    }
  }

  // 列出 Bot 自动积累的记忆文件
  listMemory(botId) {
    return this._listDir(path.join(this.botConfigDir(botId), 'memory'));
  }

  // 列出 Bot 自动沉淀的技能
  listSkills(botId) {
    return this._listDir(path.join(this.botConfigDir(botId), 'skills'));
  }

  _listDir(dir) {
    try {
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir, { withFileTypes: true }).map((d) => {
        const full = path.join(dir, d.name);
        let size = 0;
        try { size = d.isDirectory() ? 0 : fs.statSync(full).size; } catch (e) { /* ignore */ }
        return { name: d.name, isDir: d.isDirectory(), size };
      });
    } catch (e) {
      return [];
    }
  }

  // 从真实 ~/.claude 同步 skills / plugins（播种后真实目录新增的内容不会自动进来）
  syncFromRealHome(botId) {
    const real = path.join(os.homedir(), '.claude');
    const target = this.botConfigDir(botId);
    this.ensure(botId);
    let copied = 0;
    for (const name of ['skills', 'plugins']) {
      const src = path.join(real, name);
      const dst = path.join(target, name);
      if (!fs.existsSync(src)) continue;
      try {
        fs.cpSync(src, dst, { recursive: true, force: true });
        copied++;
      } catch (e) {
        this.logger?.warn('knowledge', `同步 ${name} 失败: ${e.message}`);
      }
    }
    this.logger?.info('knowledge', `${botId} 已从真实 ~/.claude 同步 ${copied} 项`);
    return { ok: true, copied };
  }
}

module.exports = { KnowledgeManager, DEFAULT_KNOWLEDGE };
