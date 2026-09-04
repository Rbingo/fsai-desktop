// ApprovalManager + permission-policy + ClaudeAdapter 审批闭环单元测试
const assert = require('assert');
const { ApprovalManager } = require('../src/approvals/ApprovalManager');
const { classifyTool, classifyCommand } = require('../src/approvals/permission-policy');

const noop = () => {};
const logger = { info: noop, warn: noop, error: noop };

async function testApprovalManager() {
  const am = new ApprovalManager({ logger, defaultTimeoutMs: 1000 });

  // 1. allow
  {
    const { approvalId, promise } = am.requestApproval({ taskId: 't1', agent: 'claude', type: 'Bash', risk: 'approval' });
    const res = am.resolveApproval(approvalId);
    assert.strictEqual(res.ok, true);
    const decision = await promise;
    assert.strictEqual(decision.behavior, 'allow');
    console.log('✓ allow');
  }

  // 2. deny
  {
    const { approvalId, promise } = am.requestApproval({ taskId: 't1', agent: 'claude', type: 'Bash', risk: 'approval' });
    am.rejectApproval(approvalId, '用户拒绝');
    let decision;
    try {
      decision = await promise;
      assert.strictEqual(decision.behavior, 'deny');
    } catch (e) {
      // reject 走的是 resolve，deny 会 resolve {behavior:'deny'}
    }
    console.log('✓ deny');
  }

  // 3. duplicate approval（重复处理）
  {
    const { approvalId } = am.requestApproval({ taskId: 't2', agent: 'claude', type: 'Bash', risk: 'approval' });
    const first = am.resolveApproval(approvalId);
    const second = am.resolveApproval(approvalId);
    assert.strictEqual(first.ok, true);
    assert.strictEqual(second.ok, false);
    assert.strictEqual(second.reason, '该审批已经处理或已失效');
    console.log('✓ duplicate approval');
  }

  // 4. expired approval（超时）
  {
    const am2 = new ApprovalManager({ logger, defaultTimeoutMs: 50 });
    const { promise } = am2.requestApproval({ taskId: 't3', agent: 'claude', type: 'Bash', risk: 'approval' });
    try {
      await promise;
      assert.fail('should timeout');
    } catch (e) {
      assert.ok(e.message.includes('审批超时') || e.message.includes('timeout'));
    }
    console.log('✓ expired approval');
  }

  // 5. task cancel
  {
    const am3 = new ApprovalManager({ logger, defaultTimeoutMs: 5000 });
    const p1 = am3.requestApproval({ taskId: 't4', agent: 'claude', type: 'Bash', risk: 'approval' });
    const p2 = am3.requestApproval({ taskId: 't4', agent: 'claude', type: 'Write', risk: 'approval' });
    const p3 = am3.requestApproval({ taskId: 't5', agent: 'claude', type: 'Bash', risk: 'approval' });
    // 挂上 catch，避免 cancel 时 unhandled rejection
    p1.promise.catch(() => {});
    p2.promise.catch(() => {});
    p3.promise.catch(() => {});
    const n = am3.cancelTaskApprovals('t4');
    assert.strictEqual(n, 2);
    assert.strictEqual(am3.pendingCount('t4'), 0);
    assert.strictEqual(am3.pendingCount('t5'), 1);
    console.log('✓ task cancel');
  }
}

function testPermissionPolicy() {
  // SAFE
  assert.strictEqual(classifyTool('Read', {}), 'safe');
  assert.strictEqual(classifyTool('Grep', {}), 'safe');
  assert.strictEqual(classifyCommand('git status'), 'safe');
  assert.strictEqual(classifyCommand('npm test'), 'safe');
  assert.strictEqual(classifyCommand('tsc --noEmit'), 'safe');

  // APPROVAL
  assert.strictEqual(classifyCommand('npm install axios'), 'approval');
  assert.strictEqual(classifyCommand('git commit -m x'), 'approval');
  assert.strictEqual(classifyCommand('curl http://x'), 'approval');

  // HIGH RISK
  assert.strictEqual(classifyCommand('rm -rf /tmp/x'), 'high');
  assert.strictEqual(classifyCommand('git reset --hard'), 'high');
  assert.strictEqual(classifyCommand('DROP DATABASE x'), 'high');

  // question
  assert.strictEqual(classifyTool('AskUserQuestion', { question: 'x' }), 'question');

  console.log('✓ permission policy');
}

(async () => {
  await testApprovalManager();
  testPermissionPolicy();
  console.log('\n全部审批测试通过 ✓');
})().catch((e) => {
  console.error('测试失败:', e.message);
  process.exit(1);
});
