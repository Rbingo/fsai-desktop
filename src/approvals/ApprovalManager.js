// ApprovalManager：统一的审批/提问管理器。
// ClaudeAdapter / CodexAdapter 调用 requestApproval() 拿到一个 Promise，
// 飞书卡片按钮点击后由 FeishuGateway 调用 resolveApproval()/rejectApproval()，
// Promise 随即 resolve，Agent 继续执行。
// 本模块不依赖任何具体 Agent，Claude/Codex 可复用。
const crypto = require('crypto');

class ApprovalManager {
  constructor({ logger, defaultTimeoutMs = 10 * 60 * 1000 }) {
    this.logger = logger;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.pending = new Map(); // approvalId -> PendingApproval
  }

  _genId() {
    return 'apv_' + crypto.randomBytes(16).toString('hex');
  }

  // 请求一次审批，返回 Promise。用户在飞书点击后 resolve。
  // opts: { taskId, agent, type, payload, title, description, risk, allowForSession? }
  requestApproval(opts) {
    const approvalId = this._genId();
    const now = Date.now();
    let resolve, reject, timer;

    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });

    const entry = {
      approvalId,
      taskId: opts.taskId || null,
      agent: opts.agent || 'generic',
      type: opts.type || 'unknown',
      payload: opts.payload || null,
      title: opts.title || '',
      description: opts.description || '',
      risk: opts.risk || 'unknown', // safe | approval | high
      createdAt: now,
      expiresAt: now + (opts.timeoutMs || this.defaultTimeoutMs),
      allowForSession: !!opts.allowForSession,
      resolved: false,
      resolve,
      reject,
      timer,
    };

    entry.timer = setTimeout(() => {
      this._finish(approvalId, { behavior: 'deny', message: '审批超时' }, true);
    }, opts.timeoutMs || this.defaultTimeoutMs);

    this.pending.set(approvalId, entry);
    this.logger?.info('approval', `request approval ${approvalId} type=${entry.type} risk=${entry.risk}`);

    return { approvalId, promise, entry };
  }

  // 用户点击「允许一次」/「本会话允许」
  resolveApproval(approvalId, { allowForSession = false } = {}) {
    const entry = this.pending.get(approvalId);
    if (!entry) return { ok: false, reason: '该审批已经处理或已失效' };
    if (entry.resolved) return { ok: false, reason: '该审批已经处理或已失效' };
    entry.allowForSession = entry.allowForSession || allowForSession;
    this._finish(approvalId, { behavior: 'allow' }, false);
    return { ok: true, allowForSession: entry.allowForSession };
  }

  // 用户点击「拒绝」
  rejectApproval(approvalId, message = '用户拒绝') {
    const entry = this.pending.get(approvalId);
    if (!entry) return { ok: false, reason: '该审批已经处理或已失效' };
    if (entry.resolved) return { ok: false, reason: '该审批已经处理或已失效' };
    this._finish(approvalId, { behavior: 'deny', message }, false);
    return { ok: true };
  }

  // 取消某 task 的所有待处理审批
  cancelTaskApprovals(taskId) {
    let n = 0;
    for (const [id, entry] of this.pending) {
      if (entry.taskId === taskId && !entry.resolved) {
        this._finish(id, { behavior: 'deny', message: '任务已取消' }, true);
        n++;
      }
    }
    return n;
  }

  // 是否还有待处理审批
  pendingCount(taskId) {
    if (!taskId) return this.pending.size;
    let n = 0;
    for (const entry of this.pending.values()) {
      if (entry.taskId === taskId && !entry.resolved) n++;
    }
    return n;
  }

  // 列出某 task 的待处理审批（供 UI/调试）
  listPending(taskId) {
    const out = [];
    for (const entry of this.pending.values()) {
      if (!entry.resolved && (taskId ? entry.taskId === taskId : true)) {
        out.push({
          approvalId: entry.approvalId,
          taskId: entry.taskId,
          agent: entry.agent,
          type: entry.type,
          title: entry.title,
          description: entry.description,
          risk: entry.risk,
          createdAt: entry.createdAt,
          expiresAt: entry.expiresAt,
        });
      }
    }
    return out;
  }

  _finish(approvalId, result, isTimeout) {
    const entry = this.pending.get(approvalId);
    if (!entry || entry.resolved) return;
    entry.resolved = true;
    if (entry.timer) clearTimeout(entry.timer);
    this.pending.delete(approvalId);
    if (isTimeout) {
      entry.reject(new Error(result.message || '审批超时'));
    } else {
      entry.resolve(result);
    }
    this.logger?.info('approval', `resolved ${approvalId} -> ${result.behavior}${isTimeout ? ' (timeout)' : ''}`);
  }
}

module.exports = { ApprovalManager };
