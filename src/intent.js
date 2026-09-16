// 意图判断：群消息是否有「需要机器人回复」的意图。
//
// 分层策略（先规则后模型，控制成本）：
//   ① 规则预筛（零成本）：被 @ / 回复机器人 / 触发词 / 问句 → 高置信度
//   ② AI 判断：规则不确定时，用轻量 prompt 问一次模型
//
// 设计目标：全局监听群消息用于积累上下文，但只在「需要」时才回复。

// 默认触发词（用户可在 Bot 配置里覆盖）
const DEFAULT_TRIGGERS = [
  '机器人', 'bot', '助手', '小助手', 'ai',
  '帮我', '帮忙', '请问', '帮我看看', '帮我看',
];

// 判定结果
const DECISION = {
  REPLY: 'reply',       // 直接回复
  ASK_AI: 'ask_ai',     // 规则不确定，交给 AI 判断
  IGNORE: 'ignore',     // 静默忽略
};

// ① 规则预筛
// msg: { chatId, content, mentionedBot, replyToMessageId, mentions, chatType }
// ctx: { botName, botMessageIds: Set, triggers }
function ruleGate(msg, ctx = {}) {
  const content = String(msg.content || '').trim();
  if (!content) return { decision: DECISION.IGNORE, reason: 'empty' };

  // 单聊（p2p）：用户直接找机器人说话，每条消息都应回复，不做意图过滤
  // 注意：飞书的单聊 chatType 是 'p2p'，群聊是 'group'
  const chatType = String(msg.chatType || '').toLowerCase();
  if (chatType === 'p2p' || chatType === 'single') {
    return { decision: DECISION.REPLY, reason: 'direct_message' };
  }

  // 直接 @ 机器人 → 一定回复（SDK 默认只推 @ 的消息，全局监听后这里仍生效）
  if (msg.mentionedBot) {
    return { decision: DECISION.REPLY, reason: 'mentioned' };
  }

  // 回复的是机器人发过的消息 → 一定回复
  if (msg.replyToMessageId && ctx.botMessageIds?.has(msg.replyToMessageId)) {
    return { decision: DECISION.REPLY, reason: 'reply_to_bot' };
  }

  // 触发词命中 → 回复
  const lower = content.toLowerCase();
  const triggers = ctx.triggers || DEFAULT_TRIGGERS;
  for (const t of triggers) {
    if (lower.includes(String(t).toLowerCase())) {
      return { decision: DECISION.REPLY, reason: `trigger:${t}` };
    }
  }

  // @ 了所有人 → 不回复（避免刷屏）
  if (msg.mentionAll) {
    return { decision: DECISION.IGNORE, reason: 'mention_all' };
  }

  // 问句 → 交给 AI 判断（可能是问别人，也可能问机器人）
  if (/[?？]$/.test(content) || /^(怎么|为什么|如何|能不能|可不可以|是不是|有没有)/.test(content)) {
    return { decision: DECISION.ASK_AI, reason: 'question' };
  }

  // 其他闲聊 → 静默忽略（但仍会被记录到上下文）
  return { decision: DECISION.IGNORE, reason: 'chitchat' };
}

// ② AI 判断用的轻量 prompt
function buildJudgePrompt(msg, ctx = {}) {
  const botName = ctx.botName || '机器人';
  return [
    `你是一个群聊助手的意图判断器。判断下面这条群消息是否在向「${botName}」提问或请求帮助。`,
    '',
    `群消息：${String(msg.content || '').slice(0, 500)}`,
    '',
    '只回答 YES 或 NO，不要解释：',
    '- 如果消息明显是在向助手提问、请求帮助、或需要助手参与 → YES',
    '- 如果只是群友之间的闲聊、与助手无关的对话 → NO',
  ].join('\n');
}

// 解析 AI 判断结果
function parseJudgeResult(text) {
  const s = String(text || '').trim().toUpperCase();
  if (s.startsWith('YES') || s.includes('YES')) return true;
  return false;
}

module.exports = {
  DECISION,
  DEFAULT_TRIGGERS,
  ruleGate,
  buildJudgePrompt,
  parseJudgeResult,
};
