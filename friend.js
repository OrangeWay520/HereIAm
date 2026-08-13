// ============================================================
//  好友端逻辑：接收 P2P 位置，在高德地图上实时显示
//  位置来自 WebRTC 数据通道（点对点），不经过任何服务器。
//  打开页面时发送 "join" 通知司机，司机据此建立连接。
// ============================================================

const $ = (id) => document.getElementById(id);
let pc = null;
let dc = null;
let signaling = null;
let joinTimer = null;
let map = null;
let marker = null;

function setStatus(text, on = false) {
  const el = $("status");
  el.textContent = text;
  el.className = "status" + (on ? " on" : "");
}

function initMap() {
  const key = CONFIG.amapKey;
  if (!key || key.startsWith("YOUR")) {
    $("#map").innerHTML =
      "<p style='padding:20px;color:#f43f5e'>请先在 config.js 填入高德JS Key</p>";
    return;
  }
  // 用「安全密钥」方式加载，无需配置域名白名单（本地 localhost 也能用）
  window._AMapSecurityConfig = { securityJsCode: CONFIG.amapSecurityCode };
  const s = document.createElement("script");
  // 使用 JS API 1.4.15（经典版）：栅格瓦片、不依赖 WebGL，
  // 在 Edge/远程桌面/虚拟机等 WebGL2 受限环境下也能正常显示底图。
  // plugin=AMap.Geocoder 用于逆地理编码（显示"XX路附近"）。
  s.src =
    "https://webapi.amap.com/maps?v=1.4.15&key=" +
    key +
    "&plugin=AMap.Geocoder";
  s.onload = () => {
    // 移除"地图加载中…"占位文字，避免它一直盖在地图上层
    const ph = document.querySelector("#map p");
    if (ph) ph.remove();
    // 初始给一个默认视野（北京），避免定位失败时地图停在空白海域
    map = new AMap.Map("map", { zoom: 10, center: [116.397428, 39.90923] });
    map.on("complete", () => setStatus("地图就绪，等待司机连接…"));
  };
  s.onerror = () => {
    $("#map").innerHTML =
      "<p style='padding:20px;color:#f43f5e'>高德地图加载失败：请检查 Key 及安全密钥</p>";
  };
  document.head.appendChild(s);
}

async function init() {
  const params = new URLSearchParams(location.search);
  let code = params.get("channel");
  if (!code) code = prompt("请输入好友分享的口令");
  if (!code) {
    setStatus("未提供口令");
    return;
  }
  initMap();

  signaling = await connectSignaling("hereiam_" + code, onSignal);
  setStatus("等待司机连接…");
  // 通知司机有好友加入，司机据此建立 P2P 连接
  signaling.send({ type: "join" });
  // 司机可能还没点"开始"（信令通道尚未建立），会收不到这次 join。
  // 因此每 2 秒重发一次 join，直到连接建立为止。
  joinTimer = setInterval(() => {
    if (pc && pc.connectionState === "connected") {
      clearInterval(joinTimer);
      joinTimer = null;
      return;
    }
    signaling.send({ type: "join" });
  }, 2000);
}

async function onSignal(msg) {
  if (msg.type === "offer") {
    await handleOffer(msg.sdp);
  } else if (msg.type === "candidate") {
    if (pc) {
      try {
        await pc.addIceCandidate(msg.candidate);
      } catch (e) {}
    }
  }
}

async function handleOffer(offer) {
  // 若已有旧连接，先关闭，避免残留
  if (pc) {
    try {
      pc.close();
    } catch (e) {}
  }
  pc = new RTCPeerConnection({ iceServers: CONFIG.stunServers });
  pc.onicecandidate = (e) => {
    if (e.candidate && signaling)
      signaling.send({ type: "candidate", candidate: e.candidate });
  };
  pc.ondatachannel = (e) => {
    dc = e.channel;
    dc.onmessage = (ev) => onLocation(JSON.parse(ev.data));
  };
  pc.onconnectionstatechange = () => {
    if (pc && pc.connectionState === "connected")
      setStatus("已点对点直连", true);
  };

  await pc.setRemoteDescription(offer);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  signaling.send({ type: "answer", sdp: answer });
  setStatus("已应答，正在直连…");
}

function onLocation(m) {
  if (!map) return;
  const pos = new AMap.LngLat(m.lng, m.lat);
  if (!marker) {
    marker = new AMap.Marker({ position: pos });
    map.add(marker);
  } else {
    marker.setPosition(pos);
  }
  map.setCenter(pos);
  if (AMap.Geocoder) {
    const geoc = new AMap.Geocoder();
    geoc.getAddress(pos, (st, r) => {
      if (st === "complete" && r.regeocode) {
        $("#addr").innerHTML =
          "<b>司机现在在：</b>" + r.regeocode.formattedAddress;
      }
    });
  }
}

window.addEventListener("beforeunload", () => {
  if (pc) pc.close();
  if (signaling) signaling.close();
});

init();
