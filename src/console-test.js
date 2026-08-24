// 内置测试控制台：在没有真实飞书 App ID/Secret 时，用于离线验证
// 「消息 → 解析模型 → Claude Code 执行 → 回复」的完整链路。
// 复用与 FeishuAdapter 相同的消息处理回调，只是输入来自 stdin、输出到 stdout。
const readline = require('readline');

function startConsoleTest(onMessage, onReply) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'you> ',
  });
  console.log('[FSAI console] 输入消息模拟飞书 @Bot，输入 /quit 退出');
  rl.prompt();
  rl.on('line', async (line) => {
    const text = line.trim();
    if (!text) return rl.prompt();
    if (text === '/quit' || text === '/exit') {
      rl.close();
      return;
    }
    const chatId = 'console';
    const msg = { chatId, content: text, messageId: `console-${Date.now()}` };
    try {
      const reply = await onMessage(msg);
      onReply(chatId, reply);
      console.log(`bot> ${reply}`);
    } catch (e) {
      console.log(`bot> [error] ${e.message}`);
    }
    rl.prompt();
  });
  return rl;
}

module.exports = { startConsoleTest };
