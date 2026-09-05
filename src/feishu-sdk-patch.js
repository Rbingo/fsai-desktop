// SDK 补丁：修复 @larksuiteoapi/node-sdk 长连接不处理卡片回调（type=card）的 bug。
//
// 根因：WSClient.prototype.handleEventData 里有 `if (type !== MessageType.event) return;`
// 导致飞书推送的卡片回调（WS 层 type='card'）被静默丢弃，卡片按钮点击永远收不到。
// 本补丁把该判断放宽为同时接受 'event' 和 'card' 两种类型，其余逻辑不变。

function patchFeishuCardCallback(sdk, logger) {
  const WSClient = sdk.WSClient;
  if (!WSClient || !WSClient.prototype) return false;

  const original = WSClient.prototype.handleEventData;
  if (!original) return false;

  // 已打过补丁则跳过
  if (WSClient.prototype.__fsaiCardPatched) return true;

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

    // 记录所有 incoming 消息类型（诊断用）
    if (logger) {
      logger.debug('feishu-sdk-patch', `[ws] incoming message type=${type}`);
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
