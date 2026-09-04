// 飞书审批卡片构建器：把 ApprovalManager 的审批请求渲染成飞书 interactive card。
// 按钮 value 只带 approvalId + decision，不携带命令原文（安全要求第 6 条）。

const RISK_TEXT = {
  safe: '🟢 低风险',
  approval: '🟡 会修改项目或访问外部',
  high: '🔴 高风险，请谨慎',
};

const RISK_COLOR = {
  safe: 'green',
  approval: 'orange',
  high: 'red',
};

function buildApprovalCard({ approvalId, taskId, agent, type, title, description, risk }) {
  const riskText = RISK_TEXT[risk] || RISK_TEXT.approval;
  const riskColor = RISK_COLOR[risk] || 'orange';
  const agentLabel = agent === 'claude' ? 'Claude' : agent === 'codex' ? 'Codex' : 'Agent';

  return {
    header: {
      title: { tag: 'plain_text', content: `⚠️ ${agentLabel} 请求执行` },
      template: risk === 'high' ? 'red' : risk === 'approval' ? 'orange' : 'blue',
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**任务**\n#${taskId || '-'}\n\n**类型**\n${type || '工具'}\n\n**详情**\n${description || '(无)'}`,
        },
      },
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**风险**\n<font color='${riskColor}'>${riskText}</font>`,
        },
      },
      {
        tag: 'hr',
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '✅ 允许一次' },
            type: 'primary',
            value: { approvalId, decision: 'allow' },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🔓 本会话允许' },
            type: 'default',
            value: { approvalId, decision: 'allow_session' },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '❌ 拒绝' },
            type: 'danger',
            value: { approvalId, decision: 'deny' },
          },
        ],
      },
    ],
  };
}

// 处理后的卡片（按钮置灰，标记已处理）
function buildResolvedCard(originalCard, decisionText) {
  const card = JSON.parse(JSON.stringify(originalCard));
  // 替换 action 为纯文本标记
  const elements = card.elements || [];
  const newElements = [];
  for (const el of elements) {
    if (el.tag === 'action') {
      newElements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: `✅ ${decisionText}` },
      });
    } else {
      newElements.push(el);
    }
  }
  return { ...card, elements: newElements };
}

// AskUserQuestion -> 单选卡
function buildQuestionCard({ approvalId, taskId, question }) {
  const options = question.options || [];
  const multiSelect = !!question.multiSelect;

  const actions = options.map((opt) => ({
    tag: 'button',
    text: { tag: 'plain_text', content: opt.label || String(opt) },
    type: 'default',
    value: { approvalId, decision: 'answer', answer: opt.label || String(opt) },
  }));

  return {
    header: {
      title: { tag: 'plain_text', content: '💬 Claude 提问' },
      template: 'blue',
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**${question.header || '请选择'}**\n\n${question.question || ''}`,
        },
      },
      ...(multiSelect
        ? [{ tag: 'note', elements: [{ tag: 'plain_text', content: '（多选暂以单选实现，可多次点击）' }] }]
        : []),
      { tag: 'hr' },
      { tag: 'action', actions },
    ],
  };
}

module.exports = { buildApprovalCard, buildResolvedCard, buildQuestionCard };
