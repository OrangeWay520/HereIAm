// ============================================================
//  极简信令封装（Ably）
//  作用：只用于交换 WebRTC 的 offer/answer/ICE，建立点对点连接。
//  注意：位置数据走 WebRTC 数据通道直连，绝不经过这里，
//        所以服务器(Ably)永远看不到分享者的位置。
//        （说明：连接建立时的握手仍经 Ably，但只含连接参数、不含位置）
// ============================================================

function connectSignaling(channelName, onMessage, clientId) {
  return new Promise((resolve, reject) => {
    const options = { key: CONFIG.ablyKey };
    if (clientId) options.clientId = clientId;
    const ably = new Ably.Realtime(options);
    ably.connection.once("connected", () => {
      const channel = ably.channels.get(channelName);
      channel.subscribe((msg) => {
        // Ably 会把本连接自己发布的消息也回环投递，
        // 若不排除会导致语音重协商等场景把"自己发的 offer"误当成对端消息、
        // 触发重建连接。这里按 connectionId 过滤掉自己的消息。
        if (msg.connectionId && msg.connectionId === ably.connection.id) return;
        try {
          onMessage(JSON.parse(msg.data));
        } catch (e) {
          console.warn("无法解析信令消息", e);
        }
      });
      // presence：本端进入房间 presence（clientId=nodeId），供加入端「房间是否存在/是否在线」判定。
      // 每 15s 发一次 presence.update() 心跳刷新自己的时间戳（对端据此判定本端在线）。
      // 不可用时静默降级，仍由 join 心跳判定房间。
      let presenceTimer = 0;
      try {
        channel.presence.enter();
        presenceTimer = setInterval(() => {
          try { channel.presence.update(); } catch (e) {}
        }, 15000);
      } catch (e) {
        // presence 不可用（key 无权限等）：仍由 join 心跳判定房间
      }
      resolve({
        ably,
        send: (obj) => channel.publish("signal", JSON.stringify(obj)),
        close: () => {
          if (presenceTimer) clearInterval(presenceTimer);
          try { channel.presence.leave(); } catch (e) {}
          ably.close();
        },
      });
    });
    ably.connection.once("failed", (err) => {
      console.error("信令连接失败：请检查 config.js 里的 ablyKey", err);
      reject(err);
    });
  });
}
