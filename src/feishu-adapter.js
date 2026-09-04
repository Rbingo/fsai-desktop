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
    // 卡片按钮点击回调
    if (this.onCardAction) {
      this.channel.on('cardAction', async (evt) => {
        try {
          await this.onCardAction(evt);
        } catch (e) {
          this.logger?.error('feishu', `onCardAction error: ${e.message}`);
        }
      });
    }
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

  // 发送 interactive card（审批卡/选择卡）
  async sendCard(chatId, card, { replyTo } = {}) {
    if (!this.channel || !this.connected) {
      throw new Error('Feishu not connected');
    }
    return this.channel.send(chatId, { card }, { replyTo });
  }

  // 更新卡片（审批处理后把按钮置灰/标记已处理）
  async updateCard(messageId, card) {
    if (!this.channel || !this.connected) {
      throw new Error('Feishu not connected');
    }
    return this.channel.updateCard(messageId, card);
  }

  // 设置卡片点击回调（在 connect 之前调用）
  onCardActionHandler(handler) {
    this.onCardAction = handler;
    // 若已连接，立即绑定
    if (this.connected && this.channel) {
      this.channel.on('cardAction', handler);
    }
  }

  async disconnect() {
    if (this.channel && typeof this.channel.disconnect === 'function') {
      await this.channel.disconnect();
    }
    this.connected = false;
  }
}

module.exports = { FeishuAdapter };
