// ClaudeAdapter：用官方 @anthropic-ai/claude-agent-sdk 的 query() 替代 spawn('claude','-p')。
// 核心能力：通过 canUseTool（async）把权限审批桥接到飞书卡片，Claude 在等待审批时挂起，
// 用户点击后 Promise resolve，Claude 继续执行。全程不碰控制台。
//
// startTask 返回 Promise<{ ok, text, sessionId, error }>：
//   - 内部用 query() 流式消费消息，收集 assistant 文本
//   - 遇 canUseTool 需要审批时，通过 onApprovalRequest 回调通知外部发飞书卡片，
//     然后 await approvalManager 的 Promise 直到用户在飞书点击
//   - 完成后 resolve，sessionId 供后续 resume 续接同一会话
const { classifyTool, describeApproval } = require('../../approvals/permission-policy');

class ClaudeAdapter {
  constructor({ sdk, approvalManager, logger, env, cwd, claudeExecutablePath }) {
    this.sdk = sdk; // require('@anthropic-ai/claude-agent-sdk')
    this.approvalManager = approvalManager;
    this.logger = logger;
    this.env = env || {}; // resolver 注入的 ANTHROPIC_* 等
    this.cwd = cwd || null;
    this.claudeExecutablePath = claudeExecutablePath || null;
    this.onApprovalRequest = null; // 外部注入：发飞书审批卡片
    this.activeQueries = new Map(); // taskId -> { abortController, sessionId }
  }

  // 统一接口 AgentAdapter.startTask
  // opts: { taskId, projectPath, prompt, resumeSessionId? }
  // 返回 Promise<{ ok, text, sessionId, error }>
  async startTask(opts) {
    const { taskId, projectPath, prompt, resumeSessionId } = opts;
    const { query } = this.sdk;

    const abortController = new AbortController();

    const options = {
      cwd: projectPath || this.cwd,
      permissionMode: 'default',
      abortController,
      env: this._buildEnv(),
      // 权限回调：async，返回 Promise<PermissionResult>
      canUseTool: async (toolName, input, context) => {
        return this._handleCanUseTool(taskId, toolName, input, context);
      },
    };

    // SDK 依赖原生 CLI 二进制（optional 依赖）。若缺失，用本机已装的 claude.exe
    if (this.claudeExecutablePath) {
      options.pathToClaudeCodeExecutable = this.claudeExecutablePath;
    }

    // 会话续接
    if (resumeSessionId) {
      options.resume = resumeSessionId;
    }

    const entry = { abortController, sessionId: resumeSessionId || null };
    this.activeQueries.set(taskId, entry);

    return new Promise(async (resolve) => {
      let sessionId = resumeSessionId || null;
      let resultText = '';

      try {
        const q = query({ prompt, options });

        for await (const msg of q) {
          if (msg.session_id) {
            sessionId = msg.session_id;
            entry.sessionId = sessionId;
          }

          if (msg.type === 'assistant' && msg.message?.content) {
            for (const block of msg.message.content) {
              if (block.type === 'text' && block.text) {
                resultText += block.text;
              }
            }
          }

          if (msg.type === 'result') {
            if (msg.subtype === 'success') {
              const text = (msg.result && msg.result.trim()) || resultText.trim();
              resolve({ ok: true, text, sessionId });
              return;
            } else {
              resolve({ ok: false, text: resultText, sessionId, error: msg.result || 'unknown error' });
              return;
            }
          }
        }

        // 流结束但没有 result（异常情况）
        resolve({ ok: !!resultText, text: resultText.trim(), sessionId, error: resultText ? null : 'no result' });
      } catch (e) {
        if (e.name === 'AbortError' || abortController.signal.aborted) {
          resolve({ ok: false, text: resultText.trim(), sessionId, error: 'cancelled', cancelled: true });
        } else {
          this.logger?.error('claude', `query error: ${e.message}`);
          resolve({ ok: false, text: resultText.trim(), sessionId, error: e.message });
        }
      } finally {
        this.activeQueries.delete(taskId);
      }
    });
  }

  // canUseTool 的核心逻辑：SAFE 自动放行，question/approval/high 走飞书审批
  async _handleCanUseTool(taskId, toolName, input, context) {
    const risk = classifyTool(toolName, input);

    // AskUserQuestion 特殊处理：转飞书选择卡
    if (risk === 'question') {
      return this._handleQuestion(taskId, toolName, input);
    }

    // SAFE 直接放行
    if (risk === 'safe') {
      return { behavior: 'allow' };
    }

    // approval / high 走审批
    const desc = describeApproval(toolName, input);
    const { approvalId, promise } = this.approvalManager.requestApproval({
      taskId,
      agent: 'claude',
      type: desc.type,
      payload: input,
      title: desc.title,
      description: desc.description,
      risk: desc.risk,
    });

    // 通知外部发飞书卡片
    if (this.onApprovalRequest) {
      this.onApprovalRequest({
        taskId,
        approvalId,
        agent: 'claude',
        type: desc.type,
        title: desc.title,
        description: desc.description,
        risk: desc.risk,
      });
    }

    const decision = await promise; // 阻塞等待用户在飞书点击
    if (decision.behavior === 'allow') {
      return { behavior: 'allow' };
    }
    return { behavior: 'deny', message: decision.message || '用户拒绝' };
  }

  // AskUserQuestion -> 飞书选择卡
  async _handleQuestion(taskId, toolName, input) {
    const { approvalId, promise } = this.approvalManager.requestApproval({
      taskId,
      agent: 'claude',
      type: 'question',
      payload: input,
      title: 'Claude 提问',
      description: input.question || '',
      risk: 'approval',
    });

    if (this.onApprovalRequest) {
      this.onApprovalRequest({
        taskId,
        approvalId,
        agent: 'claude',
        type: 'question',
        title: 'Claude 提问',
        description: input.question || '',
        question: input,
      });
    }

    const decision = await promise;
    if (decision.behavior === 'allow') {
      return { behavior: 'allow', updatedInput: decision.answer || {} };
    }
    return { behavior: 'deny', message: decision.message || '用户未回答' };
  }

  async cancel(taskId) {
    const entry = this.activeQueries.get(taskId);
    if (entry) {
      entry.abortController.abort();
      return true;
    }
    return false;
  }

  getStatus(taskId) {
    const entry = this.activeQueries.get(taskId);
    return { running: !!entry, sessionId: entry?.sessionId || null };
  }

  _buildEnv() {
    return { ...process.env, ...this.env };
  }
}

module.exports = { ClaudeAdapter };
