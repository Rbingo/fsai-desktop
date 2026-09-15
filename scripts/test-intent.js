// 意图判断测试：规则预筛 + AI 判断 prompt 构建
const assert = require('assert');
const { ruleGate, DECISION, buildJudgePrompt, parseJudgeResult, DEFAULT_TRIGGERS } = require('../src/intent');

function t(name, fn) {
  try { fn(); console.log('✓', name); }
  catch (e) { console.error('✗', name, '-', e.message); process.exitCode = 1; }
}

const ctx = { botName: 'Bingo', botMessageIds: new Set(['om_bot_reply_1']) };

t('被 @ 机器人 → 直接回复', () => {
  const r = ruleGate({ content: '帮我看看', mentionedBot: true }, ctx);
  assert.strictEqual(r.decision, DECISION.REPLY);
  assert.strictEqual(r.reason, 'mentioned');
});

t('回复机器人的消息 → 直接回复', () => {
  const r = ruleGate({ content: '那这个呢', replyToMessageId: 'om_bot_reply_1' }, ctx);
  assert.strictEqual(r.decision, DECISION.REPLY);
  assert.strictEqual(r.reason, 'reply_to_bot');
});

t('命中触发词 → 直接回复', () => {
  const r = ruleGate({ content: 'Bingo 帮我写个脚本' }, ctx);
  assert.strictEqual(r.decision, DECISION.REPLY);
  assert.ok(r.reason.startsWith('trigger:'));
});

t('自定义触发词生效', () => {
  const r = ruleGate({ content: '小飞小飞' }, { ...ctx, triggers: ['小飞'] });
  assert.strictEqual(r.decision, DECISION.REPLY);
});

t('问句 → 交给 AI 判断', () => {
  const r = ruleGate({ content: '这个要怎么部署？' }, ctx);
  assert.strictEqual(r.decision, DECISION.ASK_AI);
});

t('闲聊 → 忽略', () => {
  const r = ruleGate({ content: '哈哈哈这个梗真好玩' }, ctx);
  assert.strictEqual(r.decision, DECISION.IGNORE);
  assert.strictEqual(r.reason, 'chitchat');
});

t('@所有人 → 忽略（避免刷屏）', () => {
  const r = ruleGate({ content: '@所有人 开会了', mentionAll: true }, ctx);
  assert.strictEqual(r.decision, DECISION.IGNORE);
  assert.strictEqual(r.reason, 'mention_all');
});

t('空消息 → 忽略', () => {
  const r = ruleGate({ content: '   ' }, ctx);
  assert.strictEqual(r.decision, DECISION.IGNORE);
  assert.strictEqual(r.reason, 'empty');
});

t('@机器人 优先级高于触发词', () => {
  const r = ruleGate({ content: '帮我', mentionedBot: true }, ctx);
  assert.strictEqual(r.reason, 'mentioned');
});

t('AI 判断 prompt 包含群消息内容', () => {
  const p = buildJudgePrompt({ content: '这个方案可行吗' }, { botName: 'Bingo' });
  assert.ok(p.includes('Bingo'), 'prompt 含 bot 名');
  assert.ok(p.includes('这个方案可行吗'), 'prompt 含消息内容');
  assert.ok(/YES|NO/.test(p), 'prompt 要求回答 YES/NO');
});

t('AI 判断结果解析', () => {
  assert.strictEqual(parseJudgeResult('YES'), true);
  assert.strictEqual(parseJudgeResult('yes'), true);
  assert.strictEqual(parseJudgeResult('NO'), false);
  assert.strictEqual(parseJudgeResult('无法判断'), false);
  assert.strictEqual(parseJudgeResult(''), false);
});

t('默认触发词表非空', () => {
  assert.ok(Array.isArray(DEFAULT_TRIGGERS) && DEFAULT_TRIGGERS.length > 0);
});

console.log(process.exitCode ? '\n意图测试存在失败 ✗' : '\n全部意图测试通过 ✓');
