// cc-switch 发现与解析（PRD 第 19、20、21 节）
// cc-switch 是一个 Claude Code 供应商切换器。它的 Provider 和 API Key 存在 SQLite 数据库
// ~/.cc-switch/cc-switch.db 的 providers 表里（app_type='claude' 的是给 Claude Code 用的），
// settings_config 字段的 env.ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL / ANTHROPIC_MODEL 即模型配置。
// 某些老 fork 也用 JSON 文件存 profiles，这里做容错：优先 SQLite，回退 JSON。
const fs = require('fs');
const path = require('path');
const os = require('os');

function home() {
  return os.homedir();
}

function dbPath() {
  return path.join(home(), '.cc-switch', 'cc-switch.db');
}

function jsonCandidateFiles() {
  const h = home();
  return [
    path.join(h, '.cc-switch', 'config.json'),
    path.join(h, '.cc-switch', 'profiles.json'),
    path.join(h, '.config', 'cc-switch', 'config.json'),
    path.join(h, '.config', 'cc-switch', 'profiles.json'),
    path.join(h, '.cc-switch.json'),
  ];
}

// 从 baseUrl 推导友好的 provider 名（用于 UI 展示，非必须）
function providerLabelFromUrl(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname.replace(/^api\./, '');
    const map = {
      'openrouter.ai': 'OpenRouter',
      'deepseek.com': 'DeepSeek',
      'moonshot.cn': 'Kimi',
      'integrate.api.nvidia.com': 'Nvidia',
      'ark.cn-beijing.volces.com': '火山方舟',
      'anthropic.com': 'Anthropic',
      'z.ai': '智谱',
    };
    return map[host] || host;
  } catch (e) {
    return '';
  }
}

// 把一个 settings_config 的 env 对象规范化为 profile
function normalizeEnvProfile(name, settingsConfig) {
  let cfg = settingsConfig;
  if (typeof cfg === 'string') {
    try { cfg = JSON.parse(cfg); } catch (e) { cfg = {}; }
  }
  const env = cfg?.env || {};
  const apiKey = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY_V2 || '';
  const baseUrl = env.ANTHROPIC_BASE_URL || '';
  const model = env.ANTHROPIC_MODEL || '';
  return {
    name,
    provider: providerLabelFromUrl(baseUrl),
    baseUrl,
    model,
    hasKey: !!apiKey,
    apiKey,
    keyHint: apiKey && typeof apiKey === 'string'
      ? `${apiKey.slice(0, 2)}-****${apiKey.slice(-4)}`
      : '',
  };
}

// 从 SQLite 读取 providers（app_type='claude'）
function profilesFromDb(dbFile) {
  let DatabaseSync;
  try {
    DatabaseSync = require('node:sqlite').DatabaseSync;
  } catch (e) {
    return null; // 不支持 node:sqlite
  }
  let db;
  try {
    db = new DatabaseSync(dbFile, { readOnly: true });
  } catch (e) {
    return null; // 库打不开（可能被 cc-switch 独占），回退 JSON
  }
  try {
    const rows = db.prepare(
      "SELECT name, settings_config FROM providers WHERE app_type='claude' ORDER BY is_current DESC, sort_index ASC"
    ).all();
    const profiles = rows
      .map((r) => normalizeEnvProfile(r.name, r.settings_config))
      .filter((p) => p.name && p.name !== 'Claude Official' && p.name !== 'OpenAI Official' && p.name !== 'Google Official');
    return profiles.length > 0 ? profiles : [];
  } catch (e) {
    return [];
  } finally {
    try { db.close(); } catch (e) { /* ignore */ }
  }
}

// 从 SQLite 读取 codex 类型 providers（app_type='codex'）
// settings_config: { auth: { OPENAI_API_KEY }, config: "TOML...", modelCatalog: {...} }
// 规范化为 codex profile：{ name, baseUrl, model, configToml, hasKey, apiKey, keyHint }
function codexProfilesFromDb(dbFile) {
  let DatabaseSync;
  try {
    DatabaseSync = require('node:sqlite').DatabaseSync;
  } catch (e) {
    return null;
  }
  let db;
  try {
    db = new DatabaseSync(dbFile, { readOnly: true });
  } catch (e) {
    return null;
  }
  try {
    const rows = db.prepare(
      "SELECT name, settings_config FROM providers WHERE app_type='codex' ORDER BY is_current DESC, sort_index ASC"
    ).all();
    const profiles = [];
    for (const r of rows) {
      let cfg;
      try { cfg = typeof r.settings_config === 'string' ? JSON.parse(r.settings_config) : r.settings_config; }
      catch (e) { cfg = {}; }
      if (!cfg || typeof cfg !== 'object') continue;
      const apiKey = cfg?.auth?.OPENAI_API_KEY || '';
      const configToml = cfg?.config || '';
      // 从 TOML 里抠 model / base_url / name（简单解析，够用）
      const model = (configToml.match(/^model\s*=\s*"([^"]+)"/m) || [])[1]
        || (cfg?.modelCatalog?.models?.[0]?.model)
        || '';
      const baseUrl = (configToml.match(/^base_url\s*=\s*"([^"]+)"/m) || [])[1] || '';
      const providerName = (configToml.match(/^name\s*=\s*"([^"]+)"/m) || [])[1] || providerLabelFromUrl(baseUrl);
      profiles.push({
        name: r.name,
        provider: providerName,
        baseUrl,
        model,
        configToml,
        hasKey: !!apiKey,
        apiKey,
        keyHint: apiKey && typeof apiKey === 'string'
          ? `${apiKey.slice(0, 2)}-****${apiKey.slice(-4)}`
          : '',
      });
    }
    return profiles.filter((p) => p.name && p.name !== 'OpenAI Official' && p.name !== 'Claude Official' && p.name !== 'Google Official');
  } catch (e) {
    return [];
  } finally {
    try { db.close(); } catch (e) { /* ignore */ }
  }
}

// JSON 回退：解析老 fork 的配置文件
function parseProfiles(file) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return [];
  }
  const profiles = [];
  const push = (name, p) => {
    if (!name || name === 'localMigrations') return;
    const env = p?.env || p?.environment || {};
    const apiKey = p?.apiKey || p?.api_key || env?.ANTHROPIC_AUTH_TOKEN || env?.ANTHROPIC_API_KEY;
    const baseUrl = p?.baseUrl || p?.base_url || env?.ANTHROPIC_BASE_URL;
    const model = p?.model || env?.ANTHROPIC_MODEL || '';
    profiles.push({
      name,
      provider: p?.provider || p?.vendor || providerLabelFromUrl(baseUrl),
      baseUrl: baseUrl || '',
      model: model || '',
      hasKey: !!apiKey,
      apiKey: apiKey || '',
      keyHint: apiKey && typeof apiKey === 'string'
        ? `${apiKey.slice(0, 2)}-****${apiKey.slice(-4)}`
        : '',
    });
  };

  const list = raw.profiles || raw.configs || raw.providers;
  if (Array.isArray(list)) {
    for (const p of list) push(p.name || p.id || p.profileName, p);
    return profiles;
  }
  if (raw.profiles && typeof raw.profiles === 'object' && !Array.isArray(raw.profiles)) {
    for (const [name, p] of Object.entries(raw.profiles)) push(name, p);
    return profiles;
  }
  for (const [name, p] of Object.entries(raw)) {
    if (name === 'localMigrations') continue;
    if (p && typeof p === 'object' && !Array.isArray(p) && (p.env || p.apiKey || p.baseUrl)) {
      push(name, p);
    }
  }
  return profiles;
}

function discover(configuredPath) {
  const result = { found: false, path: null, profiles: [] };

  // 1. SQLite（现代 cc-switch 主路径）
  const dbf = configuredPath && /\.db$/i.test(configuredPath) ? configuredPath : dbPath();
  if (fs.existsSync(dbf)) {
    const profiles = profilesFromDb(dbf);
    if (profiles && profiles.length > 0) {
      result.found = true;
      result.path = dbf;
      result.profiles = profiles;
      return result;
    }
  }

  // 2. JSON 回退
  const candidates = configuredPath && !/\.db$/i.test(configuredPath)
    ? [configuredPath]
    : jsonCandidateFiles();
  for (const f of candidates) {
    if (f && fs.existsSync(f)) {
      const profiles = parseProfiles(f);
      if (profiles.length > 0) {
        result.found = true;
        result.path = f;
        result.profiles = profiles;
        return result;
      }
    }
  }

  return result;
}

// 发现 Codex 类型 provider（供 Runtime=Codex 的 Bot 使用）
function discoverCodex(configuredPath) {
  const result = { found: false, path: null, profiles: [] };
  const dbf = configuredPath && /\.db$/i.test(configuredPath) ? configuredPath : dbPath();
  if (fs.existsSync(dbf)) {
    const profiles = codexProfilesFromDb(dbf);
    if (profiles && profiles.length > 0) {
      result.found = true;
      result.path = dbf;
      result.profiles = profiles;
    }
  }
  return result;
}

module.exports = { discover, discoverCodex, candidateFiles: jsonCandidateFiles, parseProfiles, dbPath };
