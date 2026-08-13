// ============================================================
//  极简信令封装（Ably）
//  作用：只用于交换 WebRTC 的 offer/answer/ICE，建立点对点连接。
//  注意：位置数据走 WebRTC 数据通道直连，绝不经过这里，
//        所以服务器(Ably)永远看不到分享者的位置。
//        （说明：连接建立时的握手仍经 Ably，但只含连接参数、不含位置）
// ============================================================

function connectSignaling(channelName, onMessage) {
  return new Promise((resolve, reject) => {
    const ably = new Ably.Realtime(CONFIG.ablyKey);
    ably.connection.once("connected", () => {
      const channel = ably.channels.get(channelName);
      channel.subscribe((msg) => {
        try {
          onMessage(JSON.parse(msg.data));
        } catch (e) {
          console.warn("无法解析信令消息", e);
        }
      });
      resolve({
        ably,
        send: (obj) => channel.publish("signal", JSON.stringify(obj)),
        close: () => ably.close(),
      });
    });
    ably.connection.once("failed", (err) => {
      console.error("信令连接失败：请检查 config.js 里的 ablyKey", err);
      reject(err);
    });
  });
}
