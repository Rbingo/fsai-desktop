// Runtime Manager：为每个 Bot 准备独立 HOME，并用 claude -p / codex exec 执行消息
// PRD 第 22、23 节 Runtime Isolation；第 24 节启动流程
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { resolveExecutable } = require('./doctor');

const CLAUDE_TIMEOUT_MS = 10 * 60 * 1000; // 单条消息执行超时

// 净化子进程环境：清除 cc-switch 本地代理/托管标记等会污染的继承变量，
// 规范化非法 proxy（缺 scheme 时补 http://），只保留主动注入的值。
function sanitizeEnv(extraEnv = {}) {
  const env = { ...process.env };
  // 1. 删除所有继承的 ANTHROPIC_* 变量（cc-switch 的 BASE_URL=127.0.0.1:15721、
  //    AUTH_TOKEN=PROXY_MANAGED 等会导致请求发到已死的本地代理上而卡住）
  for (const k of Object.keys(env)) {
    if (/^ANTHROPIC_/i.test(k)) delete env[k];
  }
  // 2. 规范化 proxy：Windows 上常设成 "127.0.0.1:7897" 这种缺 scheme 的值，
  //    会被 Claude Code 报 Invalid proxy URL。补 http:// 修复。
  const proxyKeys = ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'all_proxy'];
  for (const k of proxyKeys) {
    const v = env[k];
    if (!v || v.includes('://')) continue;
    env[k] = 'http://' + v;
  }
  // 3. 应用 resolver 主动注入的正确值
  Object.assign(env, extraEnv);
  return env;
}

class RuntimeManager {
  constructor({ runtimeBaseDir, claudePath, codexPath, logger }) {
    this.runtimeBaseDir = runtimeBaseDir;
    this.claudePath = claudePath; // 空则用 'claude'
    this.codexPath = codexPath; // 空则用 'codex'
    this.logger = logger;
  }

  botHomeDir(botId) {
    return path.join(this.runtimeBaseDir, botId, 'home');
  }

  ensureBotHome(botId) {
    const dir = this.botHomeDir(botId);
    fs.mkdirSync(dir, { recursive: true });
    const claudeDir = path.join(dir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    // 首次播种：把真实 ~/.claude 复制进隔离 HOME，保留登录态与 cc-switch 管理的 settings.json，
    // 之后该 Bot 的 provider 配置只在副本上叠加，互不覆盖（PRD 第 4.3、23 节）
    this._seedFromRealHome(claudeDir);
    return dir;
  }

  // 仅当隔离 .claude 目录为空时，从真实 ~/.claude 复制基础配置（凭据 + settings）
  _seedFromRealHome(claudeDir) {
    try {
      const realClaude = path.join(os.homedir(), '.claude');
      if (!fs.existsSync(realClaude)) return;
      const files = fs.readdirSync(claudeDir);
      if (files.length > 0) return; // 已初始化过，不覆盖
      for (const name of fs.readdirSync(realClaude)) {
        const src = path.join(realClaude, name);
        const dst = path.join(claudeDir, name);
        try {
          const st = fs.statSync(src);
          if (st.isDirectory()) fs.cpSync(src, dst, { recursive: true });
          else fs.copyFileSync(src, dst);
        } catch (e) { /* 单个文件失败不阻塞 */ }
      }
    } catch (e) {
      this.logger?.warn('runtime', `seed from ~/.claude failed: ${e.message}`);
    }
  }

  // 执行一次 Claude Code 消息，返回 { ok, text, error }
  // prompt 通过 stdin 传入，避免 Windows 下命令行参数被 cmd.exe 按空格/引号拆坏（尤其中文与空格）
  runOnce(bot, prompt, env = {}) {
    const home = this.ensureBotHome(bot.id);
    const args = ['-p', '--output-format', 'text'];
    if (bot.skipPermissions) args.push('--dangerously-skip-permissions');

    const cmd = this.claudePath || 'claude';
    // 把 .cmd/.bat shim 解析到底层真实可执行文件（.exe 或 node 脚本），避免 shell 吞 stdin/argv
    const resolved = resolveExecutable(cmd) || { cmd, args: [] };
    const spawnCmd = resolved.cmd;
    const spawnArgs = [...resolved.args, ...args];
    const childEnv = sanitizeEnv(env);
    childEnv.HOME = home;
    childEnv.USERPROFILE = home; // Windows
    childEnv.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
    // 隔离 HOME 下若播种过 settings.json，Claude Code 会用它；再应用 resolver 注入的 env
    Object.assign(childEnv, env);

    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(spawnCmd, spawnArgs, {
          env: childEnv,
          cwd: bot.workspacePath || home, // workspace 作为工作目录
          windowsHide: true,
          shell: resolved.shell || false,
        });
      } catch (e) {
        return resolve({ ok: false, error: `Failed to spawn claude: ${e.message}` });
      }

      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        try { child.kill(); } catch (e) { /* ignore */ }
        resolve({ ok: false, error: `Claude Code timed out after ${CLAUDE_TIMEOUT_MS / 60000}min` });
      }, CLAUDE_TIMEOUT_MS);

      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({ ok: false, error: `Failed to start claude: ${e.message}` });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const text = stdout.trim();
        if (code === 0 && text) {
          resolve({ ok: true, text });
        } else {
          resolve({ ok: false, error: stderr.trim() || `Claude Code exited with code ${code}` });
        }
      });

      // 把 prompt 写入 stdin，然后关闭 stdin 表示输入结束
      child.stdin.on('error', () => {});
      child.stdin.write(prompt);
      child.stdin.end();
    });
  }

  // ---------- Codex Runtime ----------
  // 为每个 codex Bot 准备独立 CODEX_HOME，播种 ~/.codex + 覆盖 provider 配置
  botCodexHomeDir(botId) {
    return path.join(this.runtimeBaseDir, botId, 'codex-home');
  }

  ensureBotCodexHome(botId, { apiKey, configToml } = {}) {
    const dir = this.botCodexHomeDir(botId);
    fs.mkdirSync(dir, { recursive: true });
    // 首次播种：把真实 ~/.codex 复制进隔离 CODEX_HOME，保留 model_catalog_json 等依赖文件
    this._seedCodexHome(dir);
    // 用该 provider 的 config.toml 覆盖（切换 provider 时需更新）
    if (configToml) {
      fs.writeFileSync(path.join(dir, 'config.toml'), configToml);
    }
    if (apiKey) {
      fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: apiKey }));
    }
    return dir;
  }

  _seedCodexHome(dir) {
    try {
      const real = path.join(os.homedir(), '.codex');
      if (!fs.existsSync(real)) return;
      const marker = path.join(dir, '.fsai-seeded');
      if (fs.existsSync(marker)) return; // 已播种过
      fs.cpSync(real, dir, { recursive: true });
      fs.writeFileSync(marker, '1');
    } catch (e) {
      this.logger?.warn('runtime', `seed from ~/.codex failed: ${e.message}`);
    }
  }

  // 执行一次 Codex 消息，返回 { ok, text, error }
  // codexConfig: { apiKey, configToml, model }
  runCodexOnce(bot, prompt, codexConfig = {}) {
    const codexHome = this.ensureBotCodexHome(bot.id, codexConfig);
    // codex exec：prompt 走 stdin（"-"），-C 指定工作目录，-o 输出最后消息到文件（避免 JSONL 解析）
    const args = ['exec', '-C', bot.workspacePath || codexHome];
    if (codexConfig.model) args.push('-m', codexConfig.model);
    args.push('--skip-git-repo-check'); // 允许在非 git 仓库目录运行
    if (bot.skipPermissions) args.push('--dangerously-bypass-approvals-and-sandbox');
    args.push('-', '--color', 'never');

    const cmd = this.codexPath || 'codex';
    const resolved = resolveExecutable(cmd) || { cmd, args: [] };
    const spawnCmd = resolved.cmd;
    const spawnArgs = [...resolved.args, ...args];

    const childEnv = sanitizeEnv();
    childEnv.CODEX_HOME = codexHome;

    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(spawnCmd, spawnArgs, {
          env: childEnv,
          cwd: bot.workspacePath || codexHome,
          windowsHide: true,
          shell: resolved.shell || false,
        });
      } catch (e) {
        return resolve({ ok: false, error: `Failed to spawn codex: ${e.message}` });
      }

      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        try { child.kill(); } catch (e) { /* ignore */ }
        resolve({ ok: false, error: `Codex timed out after ${CLAUDE_TIMEOUT_MS / 60000}min` });
      }, CLAUDE_TIMEOUT_MS);

      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({ ok: false, error: `Failed to start codex: ${e.message}` });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const text = stdout.trim();
        if (code === 0 && text) {
          resolve({ ok: true, text });
        } else {
          resolve({ ok: false, error: stderr.trim() || `Codex exited with code ${code}` });
        }
      });

      child.stdin.on('error', () => {});
      child.stdin.write(prompt);
      child.stdin.end();
    });
  }
}

module.exports = { RuntimeManager, CLAUDE_TIMEOUT_MS };
