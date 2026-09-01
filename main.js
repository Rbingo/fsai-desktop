// FSAI Desktop 主进程
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const { Store } = require('./src/store');
const { Logger } = require('./src/logger');
const { runDoctor } = require('./src/doctor');
const { BotManager } = require('./src/bot-manager');
const { discover, discoverCodex } = require('./src/cc-switch');

let mainWindow = null;
let store, logger, botManager;

// 单实例锁：飞书长连接是集群模式，同一飞书应用只能有一个客户端稳定连接，
// 多个 FSAI 实例会抢连接导致 WebSocket handshake 超时 / bot identity 解析失败。
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 用户又点了一次图标：聚焦已有窗口，而不是再开一个实例
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function dataDir() {
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

function emit(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function registerIpc() {
  const handle = (channel, fn) => {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        return { ok: true, data: await fn(...args) };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    });
  };

  // --- 状态快照 ---
  handle('get-state', () => {
    const s = store.get();
    const settings = s.settings;
    const doctor = runDoctor({
      claudePath: settings.runtime.claudePath,
      ccSwitchPath: settings.runtime.ccSwitchPath,
      codexPath: settings.runtime.codexPath,
    });
    const ccSwitch = discover(settings.runtime.ccSwitchPath);
    const ccSwitchCodex = discoverCodex(settings.runtime.ccSwitchPath);
    // 剥离原始 apiKey，只暴露 keyHint，避免 key 泄露到 renderer
    const strip = (profiles) => profiles.map(({ apiKey, ...p }) => p);
    const ccSwitchSafe = ccSwitch.found ? { ...ccSwitch, profiles: strip(ccSwitch.profiles) } : ccSwitch;
    const ccSwitchCodexSafe = ccSwitchCodex.found ? { ...ccSwitchCodex, profiles: strip(ccSwitchCodex.profiles) } : ccSwitchCodex;
    return {
      bots: s.bots.map((b) => ({ ...b, feishu: { ...b.feishu, appSecret: '' } })),
      workspaces: s.workspaces,
      directProfiles: s.directProfiles.map(({ apiKey, ...p }) => ({ ...p, apiKey: '' })),
      settings,
      doctor,
      ccSwitch: ccSwitchSafe,
      ccSwitchCodex: ccSwitchCodexSafe,
      running: [...botManager.sessions.keys()],
    };
  });

  // --- Bots ---
  handle('save-bot', (bot) => {
    // UI 拿到的 appSecret 是空字符串（已脱敏）；空值表示「不改动」，回填已存值
    const existing = store.getBot(bot.id);
    if (existing && bot.feishu && bot.feishu.appSecret === '') {
      bot = { ...bot, feishu: { ...bot.feishu, appSecret: existing.feishu.appSecret } };
    }
    return botManager.store.upsertBot(bot);
  });
  handle('delete-bot', (id) => botManager.remove(id));
  handle('duplicate-bot', (id) => botManager.duplicate(id));
  handle('start-bot', (id) => botManager.start(id));
  handle('stop-bot', (id) => botManager.stop(id));
  handle('restart-bot', (id) => botManager.restart(id));
  handle('test-bot', (id, text) => botManager.testMessage(id, text));
  handle('validate-bot', (bot) => botManager.validate(bot));

  // --- Workspaces ---
  handle('save-workspace', (ws) => store.upsertWorkspace(ws));
  handle('delete-workspace', (id) => store.removeWorkspace(id));
  handle('choose-folder', async () => {
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('open-folder', async (p) => { if (p) shell.openPath(p); });

  // --- Direct profiles ---
  handle('save-direct-profile', (p) => {
    const existing = store.getDirectProfile(p.id);
    if (existing && p.apiKey === '') {
      p = { ...p, apiKey: existing.apiKey };
    }
    return store.upsertDirectProfile(p);
  });
  handle('delete-direct-profile', (id) => store.removeDirectProfile(id));

  // --- Settings ---
  handle('update-settings', (patch) => store.updateSettings(patch));

  // --- Logs ---
  handle('get-logs', (filter) => logger.getLogs(filter || {}));

  // --- Doctor ---
  handle('run-doctor', () => {
    const s = store.get().settings;
    return runDoctor({ claudePath: s.runtime.claudePath, ccSwitchPath: s.runtime.ccSwitchPath, codexPath: s.runtime.codexPath });
  });
  handle('refresh-ccswitch', () => discover(store.get().settings.runtime.ccSwitchPath));
  handle('refresh-ccswitch-codex', () => discoverCodex(store.get().settings.runtime.ccSwitchPath));
}

app.whenReady().then(() => {
  store = new Store(dataDir());
  logger = new Logger(dataDir());

  const settings = store.get().settings;
  // 应用刚启动，没有任何运行中的 session，把上次遗留的 running/starting 状态重置为 stopped
  // （否则强杀进程后 lastStatus 仍为 running，UI 会误显示绿色）
  for (const b of store.listBots()) {
    if (b.lastStatus === 'running' || b.lastStatus === 'starting') {
      b.lastStatus = 'stopped';
      store.upsertBot(b);
    }
  }

  // 自动检测 Claude Code / Codex 路径（首次）
  const { detectClaude, detectCodex } = require('./src/doctor');
  const claude = detectClaude(settings.runtime.claudePath);
  const claudePath = claude.path || 'claude';
  const codex = detectCodex(settings.runtime.codexPath);
  const codexPath = codex.path || 'codex';

  botManager = new BotManager({
    store,
    logger,
    runtimeBaseDir: path.join(dataDir(), 'runtime'),
    claudePath,
    codexPath,
    ccSwitchPath: settings.runtime.ccSwitchPath,
    emit,
  });

  registerIpc();
  createWindow();

  // 自动启动配置的 Bot（PRD 第 36 节）
  const autoBots = store.listBots().filter((b) => b.autoStart);
  for (const b of autoBots) {
    botManager.start(b.id).catch(() => {});
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
