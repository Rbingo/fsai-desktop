// FSAI 数据模型定义与默认值

// 数据目录默认在 Electron 的 userData 下，也可通过 Store 显式指定
// 用于非 Electron 场景（如 smoke test）回退到项目 ./data

function genId(prefix) {
  const t = Math.floor(Date.now() / 1000).toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${t}${r}`;
}

function newWorkspace({ id, name, path }) {
  return {
    id: id || genId('ws'),
    name: name || '',
    path: path || '',
  };
}

// Direct API 模型 Profile（PRD 第 13 节：后续 Direct API 来源，这里提前实现作为 cc-switch 兜底）
function newDirectProfile({ id, name, provider, baseUrl, apiKey, model }) {
  return {
    id: id || genId('mp'),
    name: name || '',
    provider: provider || '',
    baseUrl: baseUrl || '',
    apiKey: apiKey || '',
    model: model || '',
  };
}

// Bot 定义（对应 PRD 第 8 节数据模型）
function newBot({ id, name }) {
  return {
    id: id || genId('bot'),
    name: name || '',
    feishu: {
      appId: '',
      appSecret: '',
    },
    model: {
      source: 'cc-switch', // 'cc-switch' | 'direct'
      profile: '', // cc-switch 时填 profile 名；direct 时填 direct profile id
    },
    runtime: {
      type: 'claude-code',
    },
    workspaceId: '',
    autoStart: false,
    skipPermissions: false, // 是否追加 --dangerously-skip-permissions
    lastStatus: 'stopped', // stopped | starting | running | error
  };
}

function defaultConfig() {
  return {
    version: 1,
    bots: [],
    workspaces: [],
    directProfiles: [],
    settings: {
      general: {
        startOnLogin: false,
        minimizeToTray: false,
        autoStartBots: false,
      },
      runtime: {
        claudePath: '', // 留空 = 自动检测
        codexPath: '', // 留空 = 自动检测
        ccSwitchPath: '',
        extraArgs: [],
      },
    },
  };
}

module.exports = {
  genId,
  newWorkspace,
  newDirectProfile,
  newBot,
  defaultConfig,
};
