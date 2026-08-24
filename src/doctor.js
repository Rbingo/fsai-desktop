// 环境检测（PRD 第 37、38 节 Doctor）
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function which(cmd) {
  const isWin = process.platform === 'win32';
  const exts = isWin
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = path.join(dir, cmd + ext);
      try {
        if (fs.existsSync(p)) return p;
      } catch (e) { /* ignore */ }
    }
  }
  return null;
}

function tryVersion(cmdPath) {
  if (!cmdPath) return null;
  try {
    const out = execFileSync(cmdPath, ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim().split('\n')[0];
  } catch (e) {
    return null;
  }
}

// 探测 Claude Code（先从常见位置找，再由设置覆盖）
function detectClaude(configuredPath) {
  let p = configuredPath || which('claude');
  return { found: !!p, path: p, version: tryVersion(p) };
}

// 把 Windows 的 .cmd/.bat shim 解析成底层真实可执行文件（.exe 或 .js）
// 例如 claude.cmd -> node_modules/@anthropic-ai/claude-code/bin/claude.exe
// 返回 { cmd, args }：cmd 是可直接 spawn 的命令，args 是前置参数（.js 时返回 node 路径）
function resolveExecutable(cmdPath) {
  if (!cmdPath) return null;
  if (!/\.(cmd|bat)$/i.test(cmdPath)) {
    // 直接可执行（.exe 或已在 PATH 的裸命令）
    return { cmd: cmdPath, args: [] };
  }
  let target = null;
  try {
    const content = fs.readFileSync(cmdPath, 'utf8');
    const dir = path.dirname(cmdPath);
    for (const line of content.split(/\r?\n/)) {
      const quoted = line.match(/"([^"]+)"/g);
      if (!quoted) continue;
      for (const q of quoted) {
        let p = q.slice(1, -1);
        p = p.replace(/%dp0%/g, dir + path.sep);
        p = p.replace(/%\*/g, '');
        if (/\.(exe|js)$/i.test(p) && fs.existsSync(p)) {
          target = p;
          break;
        }
      }
      if (target) break;
    }
  } catch (e) { /* ignore */ }
  if (!target) {
    // 解析失败，回退到 shell 执行原 .cmd（会丢 stdin，但至少能跑）
    return { cmd: cmdPath, args: [], shell: true };
  }
  if (/\.js$/i.test(target)) {
    // node 脚本：用 node 执行
    return { cmd: process.execPath, args: [target] };
  }
  return { cmd: target, args: [] };
}

function detectCcSwitch(configuredPath) {
  let p = configuredPath || which('cc-switch') || which('cc-switch.exe');
  return { found: !!p, path: p, version: tryVersion(p) };
}

function detectCodex(configuredPath) {
  let p = configuredPath || which('codex');
  return { found: !!p, path: p, version: tryVersion(p) };
}

function detectGit() {
  const p = which('git');
  return { found: !!p, path: p, version: tryVersion(p) };
}

function runDoctor({ claudePath, ccSwitchPath, codexPath } = {}) {
  const osInfo = `${os.platform()} ${os.arch()} (${os.release()})`;
  return {
    system: { ok: true, detail: osInfo },
    runtime: detectClaude(claudePath),
    codex: detectCodex(codexPath),
    models: detectCcSwitch(ccSwitchPath),
    git: detectGit(),
  };
}

module.exports = { which, runDoctor, detectClaude, detectCcSwitch, detectCodex, detectGit, resolveExecutable };
