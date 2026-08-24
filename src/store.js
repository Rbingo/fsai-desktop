// 配置存储：JSON 文件持久化（PRD 第 8 节数据模型落地）
const fs = require('fs');
const path = require('path');
const { defaultConfig } = require('./models');

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'config.json');
    this.data = null;
    this.load();
  }

  load() {
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      // 合并默认值，兼容字段缺失
      const def = defaultConfig();
      this.data = {
        ...def,
        ...this.data,
        settings: { ...def.settings, ...this.data.settings,
          general: { ...def.settings.general, ...(this.data.settings?.general || {}) },
          runtime: { ...def.settings.runtime, ...(this.data.settings?.runtime || {}) },
        },
      };
      if (!Array.isArray(this.data.bots)) this.data.bots = [];
      if (!Array.isArray(this.data.workspaces)) this.data.workspaces = [];
      if (!Array.isArray(this.data.directProfiles)) this.data.directProfiles = [];
    } catch (e) {
      this.data = defaultConfig();
      this.save();
    }
  }

  save() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }

  get() { return this.data; }

  // --- Bots ---
  listBots() { return this.data.bots; }
  getBot(id) { return this.data.bots.find((b) => b.id === id) || null; }
  upsertBot(bot) {
    const i = this.data.bots.findIndex((b) => b.id === bot.id);
    if (i >= 0) this.data.bots[i] = bot;
    else this.data.bots.push(bot);
    this.save();
    return bot;
  }
  removeBot(id) {
    this.data.bots = this.data.bots.filter((b) => b.id !== id);
    this.save();
  }

  // --- Workspaces ---
  listWorkspaces() { return this.data.workspaces; }
  getWorkspace(id) { return this.data.workspaces.find((w) => w.id === id) || null; }
  upsertWorkspace(ws) {
    const i = this.data.workspaces.findIndex((w) => w.id === ws.id);
    if (i >= 0) this.data.workspaces[i] = ws;
    else this.data.workspaces.push(ws);
    this.save();
    return ws;
  }
  removeWorkspace(id) {
    this.data.workspaces = this.data.workspaces.filter((w) => w.id !== id);
    this.save();
  }

  // --- Direct profiles ---
  listDirectProfiles() { return this.data.directProfiles; }
  getDirectProfile(id) { return this.data.directProfiles.find((p) => p.id === id) || null; }
  upsertDirectProfile(p) {
    const i = this.data.directProfiles.findIndex((x) => x.id === p.id);
    if (i >= 0) this.data.directProfiles[i] = p;
    else this.data.directProfiles.push(p);
    this.save();
    return p;
  }
  removeDirectProfile(id) {
    this.data.directProfiles = this.data.directProfiles.filter((p) => p.id !== id);
    this.save();
  }

  // --- Settings ---
  updateSettings(patch) {
    this.data.settings = { ...this.data.settings, ...patch };
    this.save();
  }
}

module.exports = { Store };
