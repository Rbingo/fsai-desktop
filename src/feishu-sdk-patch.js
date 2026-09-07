// SDK 补丁：修复 @larksuiteoapi/node-sdk 长连接下卡片回调超时的问题。
//
// 根因：飞书卡片回调（card.action.trigger）是「同步回调」，要求 handler 立即返回
// 响应内容（toast / 更新卡片）。而 SDK 的 handleEventData 是：
//   const result = await dispatcher.invoke(...)  // 等 handler 完全执行完
//   respPayload.data = JSON.stringify(result)
// 一旦 handler 内部有任何阻塞操作（如 updateCard/sendReply 的网络请求），
// invoke 迟迟不返回，飞书前端等不到响应就报「目标回调服务超时未响应」。
//
// 本补丁让 card.action.trigger 走 fire-and-forget：立即返回 toast 响应，
// handler 在后台异步继续执行（resolve 审批、更新卡片等），不阻塞飞书响应。

function patchFeishuCardCallback(sdk, logger) {
  const WSClient = sdk.WSClient;
  const EventDispatcher = sdk.EventDispatcher;
  if (!WSClient || !WSClient.prototype) return false;

  // 已打过补丁则跳过
  if (WSClient.prototype.__fsaiCardPatched) return true;

  // 关键修复：patch EventDispatcher.invoke，让 card.action.trigger 立即返回 toast
  if (EventDispatcher && EventDispatcher.prototype && !EventDispatcher.prototype.__fsaiInvokePatched) {
    const origInvoke = EventDispatcher.prototype.invoke;
    EventDispatcher.prototype.invoke = function (data, params) {
      // 解析 event_type（parse 后 event_type 是普通字段，因 v2 分支把 header 展开了）
      let evtType;
      try {
        const parsed = this.requestHandle ? this.requestHandle.parse(data) : null;
        evtType = parsed ? (parsed.event_type || parsed.header?.event_type) : null;
      } catch (e) {
        evtType = null;
      }

      if (evtType === 'card.action.trigger') {
        // fire-and-forget：不 await handler，立即返回 toast 响应
        origInvoke.call(this, data, params).catch((e) => {
          logger?.error('feishu-sdk-patch', `card.action.trigger handler 后台执行出错: ${e && e.message}`);
        });
        logger?.info('feishu-sdk-patch', '[invoke] 卡片回调立即返回 toast（handler 后台异步执行）');
        return Promise.resolve({
          toast: { type: 'success', content: '已处理' },
        });
      }

      return origInvoke.call(this, data, params);
    };
    EventDispatcher.prototype.__fsaiInvokePatched = true;
  }

  WSClient.prototype.__fsaiCardPatched = true;
  return true;
}

module.exports = { patchFeishuCardCallback };
