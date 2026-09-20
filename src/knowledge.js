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

const DEFAULT_KNOWLEDGE = `# Bot 知识库（跨群共享）

<!-- 这是「用户级」知识，该 Bot 的所有群都会读到。
     你可以手动编辑，也可以让 Bot 把经验写进 memory/ 目录。

     分层说明：
     - 这里（共享层）：跨群通用的规则、术语、技能 —— 改一次所有群生效
     - 各群工作目录的 CLAUDE.md（项目级）：该群专属的背景与记忆
     Claude Code 会自动合并读取这两层。 -->

## 通用规则

<!-- 例：回答用中文；改代码前先跑测试；不确定时先问 -->

## 项目背景

<!-- 例：这是一个电商后端，技术栈 Node + Postgres -->

## 已知偏好

<!-- 例：用户偏好简洁回答，不喜欢长篇解释 -->

## 记忆索引

<!-- 跨群通用的记忆可以放这里；群专属记忆由各群工作目录的 memory/ 管理 -->

## 已投喂文档

<!-- 投喂进 docs/ 的文档索引。需要时用 Read 工具读取对应文件。 -->
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
      fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
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

  // ---------- 知识投喂 ----------

  // 把文件存入 docs/ 并在 CLAUDE.md 里登记索引（Claude 才能读到）
  // 返回 { ok, fileName, size, path }
  ingestFile(botId, fileName, buffer) {
    this.ensure(botId);
    const docsDir = path.join(this.botConfigDir(botId), 'docs');
    const safeName = this._safeFileName(fileName);
    const target = path.join(docsDir, safeName);
    try {
      fs.writeFileSync(target, buffer);
      this._appendIndex(botId, safeName, buffer.length);
      this.logger?.info('knowledge', `${botId} 投喂文件: ${safeName} (${buffer.length}B)`);
      return { ok: true, fileName: safeName, size: buffer.length, path: target };
    } catch (e) {
      this.logger?.warn('knowledge', `投喂失败: ${e.message}`);
      return { ok: false, error: e.message };
    }
  }

  // 把一段文本作为知识存入（用户在群里说「记住：xxx」）
  ingestText(botId, text, { title } = {}) {
    this.ensure(botId);
    const docsDir = path.join(this.botConfigDir(botId), 'docs');
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const name = title ? `${this._safeFileName(title)}.md` : `note-${stamp}.md`;
    const target = path.join(docsDir, name);
    try {
      fs.writeFileSync(target, String(text || ''));
      this._appendIndex(botId, name, Buffer.byteLength(String(text || '')));
      this.logger?.info('knowledge', `${botId} 投喂文本: ${name}`);
      return { ok: true, fileName: name, path: target };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // 在 CLAUDE.md 的知识索引区登记一个文档，让 Claude 知道它的存在
  _appendIndex(botId, fileName, size) {
    const claudeMd = path.join(this.botConfigDir(botId), 'CLAUDE.md');
    let content = '';
    try { content = fs.readFileSync(claudeMd, 'utf8'); } catch (e) { content = DEFAULT_KNOWLEDGE; }

    const line = `- docs/${fileName}（${(size / 1024).toFixed(1)}KB，${new Date().toISOString().slice(0, 10)}）`;
    if (content.includes(line)) return; // 已登记，避免重复

    const marker = '## 已投喂文档';
    if (content.includes(marker)) {
      // 追加到该区段末尾
      const idx = content.indexOf(marker);
      const after = content.slice(idx);
      const nextSection = after.indexOf('\n## ', 1);
      if (nextSection >= 0) {
        const insertAt = idx + nextSection;
        content = content.slice(0, insertAt) + '\n' + line + content.slice(insertAt);
      } else {
        content = content.replace(/\s*$/, '') + '\n' + line + '\n';
      }
    } else {
      content = content.replace(/\s*$/, '') + `\n\n${marker}\n\n<!-- 投喂进 docs/ 的文档索引。需要时用 Read 工具读取对应文件。 -->\n${line}\n`;
    }
    fs.writeFileSync(claudeMd, content);
  }

  // 列出已投喂的文档
  listDocs(botId) {
    return this._listDir(path.join(this.botConfigDir(botId), 'docs'));
  }

  // 删除已投喂的文档（同时从索引移除）
  removeDoc(botId, fileName) {
    const safeName = this._safeFileName(fileName);
    const target = path.join(this.botConfigDir(botId), 'docs', safeName);
    try {
      if (fs.existsSync(target)) fs.unlinkSync(target);
      const claudeMd = path.join(this.botConfigDir(botId), 'CLAUDE.md');
      let content = fs.readFileSync(claudeMd, 'utf8');
      content = content.split('\n').filter((l) => !l.includes(`docs/${safeName}`)).join('\n');
      fs.writeFileSync(claudeMd, content);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // 文件名安全化（防止路径穿越）
  _safeFileName(name) {
    const base = path.basename(String(name || 'untitled'));
    const cleaned = base.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^\.+/, '').slice(0, 120);
    return cleaned || `doc-${Date.now()}`;
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
