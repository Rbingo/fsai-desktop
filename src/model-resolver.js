// Model Resolver：把 Bot 的 model 绑定解析成 Runtime 可用的配置
// 来源一：cc-switch Profile（PRD 第 19-21 节）；来源二：Direct API（兜底）
// 按 runtime.type 分派：claude 走 ANTHROPIC_* env；codex 走 OPENAI_API_KEY + configToml
const ccSwitch = require('./cc-switch');

// 返回 { ok, runtime, env, codex, detail, error }
//   runtime: 'claude' | 'codex'
//   env: claude 时为 { ANTHROPIC_* }；codex 时为空
//   codex: codex 时为 { apiKey, configToml, model, baseUrl }
function resolve(bot, store, opts = {}) {
  const source = bot.model?.source || 'cc-switch';
  const runtimeType = bot.runtime?.type || 'claude-code';

  // Direct API 目前仅支持 Claude Runtime（Anthropic 兼容协议）
  if (source === 'direct') {
    if (runtimeType !== 'claude-code') {
      return { ok: false, error: 'Direct API 目前仅支持 Claude Code Runtime' };
    }
    const p = store.getDirectProfile(bot.model.profile);
    if (!p) return { ok: false, error: `Direct profile "${bot.model.profile}" not found` };
    if (!p.apiKey) return { ok: false, error: 'Direct profile missing API Key' };
    return {
      ok: true,
      runtime: 'claude',
      env: {
        ANTHROPIC_API_KEY: p.apiKey,
        ANTHROPIC_BASE_URL: p.baseUrl || undefined,
        ANTHROPIC_MODEL: p.model || undefined,
      },
      detail: {
        source: 'direct',
        name: p.name,
        model: p.model || '(default)',
        provider: p.provider || '(direct)',
        keyHint: `${p.apiKey.slice(0, 2)}-****${p.apiKey.slice(-4)}`,
      },
    };
  }

  // cc-switch：按 runtime 分派到 claude 或 codex provider
  if (runtimeType === 'codex') {
    const discovery = ccSwitch.discoverCodex(opts.ccSwitchPath);
    if (!discovery.found) return { ok: false, error: 'cc-switch codex provider not detected' };
    const profile = discovery.profiles.find((p) => p.name === bot.model.profile);
    if (!profile) return { ok: false, error: `cc-switch codex profile "${bot.model.profile}" not found` };
    if (!profile.hasKey) return { ok: false, error: `cc-switch codex profile "${bot.model.profile}" has no API key` };
    return {
      ok: true,
      runtime: 'codex',
      env: {},
      codex: {
        apiKey: profile.apiKey,
        configToml: profile.configToml,
        model: profile.model,
        baseUrl: profile.baseUrl,
      },
      detail: {
        source: 'cc-switch',
        name: profile.name,
        model: profile.model || '(default)',
        provider: profile.provider || '(unknown)',
        keyHint: profile.keyHint,
      },
    };
  }

  // 默认 claude
  const discovery = ccSwitch.discover(opts.ccSwitchPath);
  if (!discovery.found) return { ok: false, error: 'cc-switch not detected' };
  const profile = discovery.profiles.find((p) => p.name === bot.model.profile);
  if (!profile) return { ok: false, error: `cc-switch profile "${bot.model.profile}" not found` };
  if (!profile.hasKey) return { ok: false, error: `cc-switch profile "${bot.model.profile}" has no API key` };

  return {
    ok: true,
    runtime: 'claude',
    env: {
      ANTHROPIC_API_KEY: profile.apiKey || undefined,
      ANTHROPIC_BASE_URL: profile.baseUrl || undefined,
      ANTHROPIC_MODEL: profile.model || undefined,
    },
    detail: {
      source: 'cc-switch',
      name: profile.name,
      model: profile.model || '(default)',
      provider: profile.provider || '(unknown)',
      keyHint: profile.keyHint,
    },
  };
}

module.exports = { resolve };
