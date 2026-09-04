// PermissionPolicy：把工具/命令分成 SAFE / APPROVAL / HIGH_RISK 三级。
// SAFE 走 SDK 的 allowedTools 自动放行；APPROVAL/HIGH_RISK 走 canUseTool 发飞书审批。
// 采用「白名单 + 危险模式匹配」双轨：SAFE 精确白名单，HIGH_RISK 用正则黑名单优先判断。

const SAFE_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch']);

// 安全命令前缀/精确匹配（只读、可复现、无副作用）
const SAFE_COMMANDS = [
  /^git\s+status\b/,
  /^git\s+diff\b/,
  /^git\s+log\b/,
  /^git\s+branch\b/,
  /^git\s+show\b/,
  /^git\s+remote\s+-v\b/,
  /^npm\s+(run\s+)?(test|lint)\b/,
  /^pnpm\s+(run\s+)?(test|lint)\b/,
  /^yarn\s+(test|lint)\b/,
  /^npx\s+tsc\s+--noEmit\b/,
  /^tsc\s+--noEmit\b/,
  /^node\s+.*(--test|\.test\.)\b/,
  /^ls\b/,
  /^dir\b/,
  /^cat\b/,
  /^type\b/,
  /^echo\b/,
  /^pwd\b/,
  /^which\b/,
  /^where\b/,
  /^printenv\b/,
  /^head\b/,
  /^tail\b/,
  /^grep\b/,
  /^find\b/,
  /^wc\b/,
  /^tree\b/,
];

// 高风险命令：优先判断，命中即标红
const HIGH_RISK_PATTERNS = [
  /\brm\s+-rf\b/,
  /\brm\s+-fr\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-f[d]+\b/,
  /\bgit\s+push\s+.*--force\b/,
  /\bgit\s+push\s+.*-f\b/,
  /\bDROP\s+(TABLE|DATABASE)\b/i,
  /\bTRUNCATE\b/i,
  /\bDEL\s+.*\/[SFQ]\b/i, // windows del /s /f /q
  /\brmdir\s+\/s\b/i,
  /\bsudo\b/,
  /\bfs\.rmSync\b/,
  /\bforce\s+push\b/i,
  /\b:>.*production\b/i,
];

// 需要审批的命令（安装/提交/推送/网络/修改）
const APPROVAL_PATTERNS = [
  /\bnpm\s+(install|i|add|update|uninstall|remove)\b/,
  /\bpnpm\s+(install|add|update|remove)\b/,
  /\byarn\s+(add|remove|upgrade)\b/,
  /\bgit\s+(commit|push|pull|merge|rebase|checkout|stash|tag)\b/,
  /\bdocker\b/,
  /\bcurl\b/,
  /\bwget\b/,
  /\bnpx\b/,
  /\bpip\s+install\b/,
  /\bcargo\s+(install|add)\b/,
  /\bgo\s+(get|install)\b/,
  /\bmigrate\b/i,
  /\bterraform\b/,
  /\bkubectl\b/,
  /\bssh\b/,
  /\bscp\b/,
  /\bchmod\b/,
  /\bchown\b/,
  /\bmv\b/,
  /\bcp\b/,
];

// 判断工具名（toolName）的风险等级。input 为工具入参。
function classifyTool(toolName, input = {}) {
  // 纯只读工具直接 SAFE
  if (SAFE_TOOLS.has(toolName)) return 'safe';

  if (toolName === 'Bash') {
    const command = extractCommand(input);
    return classifyCommand(command);
  }

  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') {
    // 文件写入属于需要审批（修改项目文件）
    return 'approval';
  }

  if (toolName === 'AskUserQuestion') {
    return 'question';
  }

  // 其他工具（如 Agent/Task/WebFetch 之外的）默认审批
  return 'approval';
}

function classifyCommand(command) {
  if (!command) return 'approval';
  const c = String(command).trim();

  // 高风险优先
  for (const re of HIGH_RISK_PATTERNS) {
    if (re.test(c)) return 'high';
  }

  // 安全命令
  for (const re of SAFE_COMMANDS) {
    if (re.test(c)) return 'safe';
  }

  // 需审批命令
  for (const re of APPROVAL_PATTERNS) {
    if (re.test(c)) return 'approval';
  }

  // 无法确定风险 → 审批
  return 'approval';
}

// 从 Bash 工具入参里提取命令文本
function extractCommand(input = {}) {
  if (typeof input === 'string') return input;
  if (input.command) return String(input.command);
  if (input.description) return ''; // 只有描述没有命令
  // 有的 SDK 版本 command 可能叫别的字段
  return input.cmd || input.shell || '';
}

// 生成审批卡片的展示字段
function describeApproval(toolName, input = {}) {
  if (toolName === 'Bash') {
    const command = extractCommand(input);
    return {
      type: 'Bash',
      title: '执行命令',
      description: command,
      risk: classifyCommand(command),
    };
  }
  if (toolName === 'Write') {
    return {
      type: 'Write',
      title: '写入文件',
      description: input.file_path || input.filePath || '(文件)',
      risk: 'approval',
    };
  }
  if (toolName === 'Edit') {
    return {
      type: 'Edit',
      title: '修改文件',
      description: input.file_path || input.filePath || '(文件)',
      risk: 'approval',
    };
  }
  return {
    type: toolName,
    title: toolName,
    description: '(工具调用)',
    risk: 'approval',
  };
}

module.exports = {
  SAFE_TOOLS,
  classifyTool,
  classifyCommand,
  describeApproval,
  extractCommand,
};
