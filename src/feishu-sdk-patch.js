// SDK 补丁：修复 @larksuiteoapi/node-sdk 长连接下卡片回调的两个 bug。
//
// Bug 1：WSClient.handleEventData 里 `if (type !== MessageType.event) return;`
//   把 type='card' 的卡片回调静默丢弃（实际飞书推的是 type='event'，这个补丁先保留诊断）。
//
// Bug 2（真正的根因）：card.action.trigger handler 执行后不返回任何值，
//   而 handleEventData 把 dispatcher.invoke 的返回值作为飞书回调的同步响应。
//   飞书卡片回调是「同步回调」，要求立即返回 toast/卡片内容，否则前端报
//   「目标回调服务超时未响应」。本补丁让 card.action.trigger 返回一个 toast 响应。

function patchFeishuCardCallback(sdk, logger) {
  const WSClient = sdk.WSClient;
  const EventDispatcher = sdk.EventDispatcher;
  if (!WSClient || !WSClient.prototype) return false;

  const originalHandleEventData = WSClient.prototype.handleEventData;
  if (!originalHandleEventData) return false;

  // 已打过补丁则跳过
  if (WSClient.prototype.__fsaiCardPatched) return true;

  // 关键修复：patch EventDispatcher.invoke，让 card.action.trigger 返回 toast 响应
  if (EventDispatcher && EventDispatcher.prototype && !EventDispatcher.prototype.__fsaiInvokePatched) {
    const origInvoke = EventDispatcher.prototype.invoke;
    EventDispatcher.prototype.invoke = async function (data, params) {
      // 先解析 event_type
      let evtType;
      try {
        const parsed = this.requestHandle ? this.requestHandle.parse(data) : null;
        // CEventType 是 Symbol('event-type')，无法直接用 Symbol.for 取，用 requestHandle.parse 的结果
        // parse 返回 { [CEventType]: header.event_type, ... }，这里从 parsed 里找 event_type 字段
        if (parsed) {
          evtType = parsed.event_type || parsed.header?.event_type;
        }
      } catch (e) {
        evtType = null;
      }

      // 调用原始逻辑
      const result = await origInvoke.call(this, data, params);

      // 卡片回调必须返回同步响应（toast），否则飞书超时
      if (evtType === 'card.action.trigger') {
        logger?.info('feishu-sdk-patch', '[invoke] 返回卡片回调 toast 响应，避免飞书超时');
        return {
          toast: {
            type: 'success',
            content: '已处理',
          },
        };
      }

      return result;
    };
    EventDispatcher.prototype.__fsaiInvokePatched = true;
  }

  WSClient.prototype.handleEventData = async function (data) {
    return originalHandleEventData.call(this, data);
  };

  WSClient.prototype.__fsaiCardPatched = true;
  return true;
}

module.exports = { patchFeishuCardCallback };
