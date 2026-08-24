// 飞书长连接适配器（PRD 第 24 节 "Connect Feishu"）
// 使用官方 @larksuiteoapi/node-sdk 的 createLarkChannel，WebSocket 长连接，本地无需公网。
// onMessage 回调：(message) => message = { chatId, content, messageId }
// sendReply 用于把 Claude Code 结果发回飞书。

class FeishuAdapter {
  constructor({ appId, appSecret, logger }) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.logger = logger;
    this.channel = null;
    this.connected = false;
  }

  async connect(onMessage) {
    if (this.connected) return;
    const { createLarkChannel } = require('@larksuiteoapi/node-sdk');
    this.channel = createLarkChannel({ appId: this.appId, appSecret: this.appSecret });
    this.channel.on('message', async (msg) => {
      const normalized = {
        chatId: msg.chatId,
        content: msg.content || '',
        messageId: msg.messageId || '',
      };
      try {
        await onMessage(normalized);
      } catch (e) {
        this.logger?.error('feishu', `onMessage error: ${e.message}`);
      }
    });
    await this.channel.connect();
    this.connected = true;
    this.logger?.info('feishu', 'Feishu channel connected');
  }

  async sendReply(chatId, text, { replyTo } = {}) {
    if (!this.channel || !this.connected) {
      throw new Error('Feishu not connected');
    }
    await this.channel.send(chatId, { text }, { replyTo });
  }

  async disconnect() {
    if (this.channel && typeof this.channel.disconnect === 'function') {
      await this.channel.disconnect();
    }
    this.connected = false;
  }
}

module.exports = { FeishuAdapter };
