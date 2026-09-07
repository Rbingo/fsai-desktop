// SDK 补丁：修复 @larksuiteoapi/node-sdk 长连接不处理卡片回调（type=card）的 bug。
//
// 根因：WSClient.prototype.handleEventData 里有 `if (type !== MessageType.event) return;`
// 导致飞书推送的卡片回调（WS 层 type='card'）被静默丢弃，卡片按钮点击永远收不到。
// 本补丁把该判断放宽为同时接受 'event' 和 'card' 两种类型，其余逻辑不变。

function patchFeishuCardCallback(sdk, logger) {
  const WSClient = sdk.WSClient;
  const EventDispatcher = sdk.EventDispatcher;
  if (!WSClient || !WSClient.prototype) return false;

  const original = WSClient.prototype.handleEventData;
  if (!original) return false;

  // 已打过补丁则跳过
  if (WSClient.prototype.__fsaiCardPatched) return true;

  // hook dispatcher.invoke，打印 parse 后的真实 event_type
  if (EventDispatcher && EventDispatcher.prototype && !EventDispatcher.prototype.__fsaiInvokePatched) {
    const origInvoke = EventDispatcher.prototype.invoke;
    EventDispatcher.prototype.invoke = async function (data, params) {
      try {
        // 打印 parse 前 data 的结构和 parse 后的 event_type
        const parsed = this.requestHandle ? this.requestHandle.parse(data) : null;
        const evtType = parsed ? parsed[Symbol.for('event-type')] : '(parse失败)';
        logger?.debug('feishu-sdk-patch', `[invoke] parse后 event_type=${evtType}, hasHandler=${this.handles.has(evtType)}`);
        if (evtType && this.handles.has(evtType)) {
          logger?.info('feishu-sdk-patch', `[invoke] 匹配到 handler: ${evtType}`);
        }
      } catch (e) {
        logger?.debug('feishu-sdk-patch', `[invoke] 诊断失败: ${e.message}`);
      }
      return origInvoke.call(this, data, params);
    };
    EventDispatcher.prototype.__fsaiInvokePatched = true;
  }

  WSClient.prototype.handleEventData = async function (data) {
    // 提取 headers 里的 type（用于诊断 + 判断）
    let type;
    try {
      const headers = data.headers.reduce((acc, cur) => {
        acc[cur.key] = cur.value;
        return acc;
      }, {});
      type = headers.type;
    } catch (e) {
      return original.call(this, data);
    }

    // 诊断：直接调用 mergeData 看返回的完整结构
    try {
      const headers = data.headers.reduce((acc, cur) => { acc[cur.key] = cur.value; return acc; }, {});
      const merged = this.dataCache.mergeData({
        message_id: headers.message_id,
        sum: Number(headers.sum),
        seq: Number(headers.seq),
        trace_id: headers.trace_id,
        data: data.payload,
      });
      if (merged) {
        logger?.info('feishu-sdk-patch', `[merged] schema=${merged.schema}, header.event_type=${merged.header?.event_type}, event.type=${merged.event?.type}, keys=${Object.keys(merged).join(',')}`);
        if (merged.header?.event_type === 'card.action.trigger') {
          logger?.info('feishu-sdk-patch', `[card-event] ${JSON.stringify(merged.event).slice(0, 800)}`);
        }
      }
    } catch (e) {
      logger?.debug('feishu-sdk-patch', `[merged] 诊断失败: ${e.message}`);
    }

    // 记录所有 incoming 消息类型（诊断用）
    if (logger) {
      logger.debug('feishu-sdk-patch', `[ws] incoming message type=${type}`);
    }

    // 诊断：打印原始 payload 的 header.event_type（看飞书到底推了什么）
    if (type === 'card' || type === 'event') {
      try {
        const payload = data.payload;
        const rawStr = new TextDecoder('utf-8').decode(payload);
        let parsed;
        try { parsed = JSON.parse(rawStr); } catch (e) { parsed = null; }
        if (parsed) {
          const evtType = parsed.header?.event_type || parsed.event?.type || '(无)';
          logger?.debug('feishu-sdk-patch', `[ws] payload event_type=${evtType}, schema=${parsed.schema || '(无)'}`);
        } else {
          logger?.debug('feishu-sdk-patch', `[ws] payload 非 JSON，前 200 字符: ${rawStr.slice(0, 200)}`);
        }
      } catch (e) {
        logger?.debug('feishu-sdk-patch', `[ws] payload 解析失败: ${e.message}`);
      }
    }

    // 关键修复：card 类型也放行。构造 type='event' 的副本传给原逻辑，
    // 让原逻辑的 `type !== MessageType.event` 判断通过，后续按 payload 的
    // event_type（如 card.action.trigger）正常分发。
    if (type === 'card') {
      const patchedData = {
        ...data,
        headers: data.headers.map((h) =>
          h.key === 'type' ? { key: h.key, value: 'event' } : h
        ),
      };
      if (logger) logger.info('feishu-sdk-patch', '[ws] card callback forwarded as event');
      return original.call(this, patchedData);
    }

    return original.call(this, data);
  };

  WSClient.prototype.__fsaiCardPatched = true;
  return true;
}

module.exports = { patchFeishuCardCallback };
