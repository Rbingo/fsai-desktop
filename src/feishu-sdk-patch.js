// SDK 补丁：修复 @larksuiteoapi/node-sdk 长连接下卡片回调的两个问题。
//
// 问题1：飞书卡片回调要求 3 秒内响应（否则报 200341 超时），而 SDK 的
//   handleEventData 是 `await dispatcher.invoke(...)`，一旦 handler 内部有
//   阻塞操作（updateCard/sendReply 网络请求），invoke 迟迟不返回 → 飞书超时。
//
// 问题2：SDK 的 pushAction 有 lock 去重机制，第一次点击如果 handler 卡住，
//   后续所有点击都被 `drop in-flight action` 丢弃。
//
// 方案：patch EventDispatcher.invoke，对 card.action.trigger 直接：
//   1. 解析出 action.value（approvalId + decision）
//   2. 立即返回 toast 响应（满足 3 秒内响应）
//   3. 后台调用全局注册的 cardAction 处理器（绕过 pushAction/lock）

// 全局注册表：botManager 启动时把各 bot 的 cardAction 处理器注册进来
if (!global.__fsaiCardActionHandlers) {
  global.__fsaiCardActionHandlers = [];
}

function patchFeishuCardCallback(sdk, logger) {
  const EventDispatcher = sdk.EventDispatcher;
  if (!EventDispatcher || !EventDispatcher.prototype) return false;

  if (EventDispatcher.prototype.__fsaiInvokePatched) return true;

  const origInvoke = EventDispatcher.prototype.invoke;
  EventDispatcher.prototype.invoke = function (data, params) {
    let evtType;
    try {
      const parsed = this.requestHandle ? this.requestHandle.parse(data) : null;
      evtType = parsed ? (parsed.event_type || parsed.header?.event_type) : null;
    } catch (e) {
      evtType = null;
    }

    if (evtType === 'card.action.trigger') {
      // 解析出标准化的卡片回调事件
      let normalized;
      try {
        const parsed = this.requestHandle.parse(data);
        const evt = parsed.event || parsed;
        // value 双重转义，递归 parse
        let value = evt.action?.value;
        let depth = 0;
        while (typeof value === 'string' && depth < 5) {
          try { value = JSON.parse(value); } catch (e) { break; }
          depth++;
        }
        normalized = {
          chatId: evt.context?.open_chat_id,
          messageId: evt.context?.open_message_id,
          operator: { openId: evt.operator?.open_id, userId: evt.operator?.user_id },
          action: { ...evt.action, value },
        };
        logger?.info('feishu-sdk-patch', `[invoke] 解析卡片回调: decision=${value?.decision}, approvalId=${value?.approvalId}`);
      } catch (e) {
        logger?.error('feishu-sdk-patch', `[invoke] 解析卡片回调失败: ${e.message}`);
      }

      // 后台调用全局注册的处理器（fire-and-forget，不阻塞响应）
      if (normalized) {
        const handlers = global.__fsaiCardActionHandlers || [];
        for (const h of handlers) {
          Promise.resolve(h(normalized)).catch((e) => {
            logger?.error('feishu-sdk-patch', `cardAction handler 出错: ${e && e.message}`);
          });
        }
      }

      // 立即返回 toast，满足 3 秒响应
      return Promise.resolve({
        toast: { type: 'success', content: '已处理' },
      });
    }

    return origInvoke.call(this, data, params);
  };
  EventDispatcher.prototype.__fsaiInvokePatched = true;
  return true;
}

module.exports = { patchFeishuCardCallback };
