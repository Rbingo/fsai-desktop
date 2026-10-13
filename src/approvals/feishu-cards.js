// 飞书审批卡片构建器：把 ApprovalManager 的审批请求渲染成飞书 interactive card。
// 使用卡片 v2 结构（schema: "2.0"），按钮直接放 elements（v2 已废弃 action 容器）。
// 按钮 value 用对象（飞书 v2 支持对象，回调时 action.value 还原为对象）。

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
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `⚠️ ${agentLabel} 请求执行` },
      template: risk === 'high' ? 'red' : risk === 'approval' ? 'orange' : 'blue',
    },
    body: {
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
        { tag: 'hr' },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '✅ 允许一次' },
          type: 'primary',
          value: JSON.stringify({ approvalId, decision: 'allow' }),
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '🔓 本会话允许' },
          type: 'default',
          value: JSON.stringify({ approvalId, decision: 'allow_session' }),
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '❌ 拒绝' },
          type: 'danger',
          value: JSON.stringify({ approvalId, decision: 'deny' }),
        },
      ],
    },
  };
}

// 处理后的卡片（按钮替换为纯文本标记，避免重复点击）
function buildResolvedCard(originalCard, decisionText) {
  const card = JSON.parse(JSON.stringify(originalCard));
  const elements = (card.body?.elements || []).filter((el) => el.tag !== 'button');
  elements.push({
    tag: 'div',
    text: { tag: 'lark_md', content: `✅ ${decisionText}` },
  });
  return { ...card, body: { ...card.body, elements } };
}

// AskUserQuestion -> 选择卡
// Claude 的真实输入结构是 { questions: [{ question, header, options:[{label,description}], multiSelect }] }
// 兼容单个 question 对象的旧形态。
function buildQuestionCard({ approvalId, taskId, question }) {
  const questions = Array.isArray(question?.questions)
    ? question.questions
    : (question?.question ? [question] : []);

  const elements = [];

  for (const q of questions) {
    const header = q.header || '';
    const text = q.question || '';
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `${header ? `**${header}**\n\n` : ''}${text}`,
      },
    });

    const options = Array.isArray(q.options) ? q.options : [];
    for (const opt of options) {
      const label = typeof opt === 'string' ? opt : (opt.label || String(opt));
      const desc = (typeof opt === 'object' && opt?.description) ? opt.description : '';
      elements.push({
        tag: 'button',
        text: { tag: 'plain_text', content: label },
        type: 'default',
        // 多问题场景下把问题下标带上，便于区分答案归属
        value: JSON.stringify({
          approvalId,
          decision: 'answer',
          answer: label,
          ...(questions.length > 1 ? { questionIndex: questions.indexOf(q), question: text } : {}),
        }),
      });
      if (desc) {
        elements.push({
          tag: 'note',
          elements: [{ tag: 'plain_text', content: desc.slice(0, 200) }],
        });
      }
    }

    if (questions.length > 1) elements.push({ tag: 'hr' });
  }

  // 兜底：没有任何可选项时，提示用户直接回复
  if (elements.length === 0) {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: '（Claude 发起了提问，但没有可选项，请直接回复消息）' },
    });
  }

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '💬 Claude 提问' },
      template: 'blue',
    },
    body: { elements },
  };
}

module.exports = { buildApprovalCard, buildResolvedCard, buildQuestionCard };
