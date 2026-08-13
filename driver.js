// ============================================================
//  司机端逻辑：定位 + 生成分享口令 + 发起 P2P + 实时上报位置
//  位置通过 WebRTC 数据通道直连好友，不经任何服务器。
//  设计要点：好友每次加入都会发 "join"，司机据此重建连接，
//  因此好友断开重开后也能自动重新连上。
// ============================================================

const $ = (id) => document.getElementById(id);
let pc = null;
let dc = null;
let signaling = null;
let watchId = null;

function genCode() {
  const n = Math.floor(100000 + Math.random() * 900000);
  return String(n);
}

function setStatus(text, on = false) {
  const el = $("status");
  el.textContent = text;
  el.className = "status" + (on ? " on" : "");
}

async function init() {
  const code = genCode();
  $("code").textContent = code;
  const link = shareLink(code);
  $("link").value = link;
  $("qrcode").src =
    "https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=" +
    encodeURIComponent(link);
  $("start").onclick = start;
}

// 生成好友打开的链接。本地调试用相对路径；正式托管时改成你的线上地址。
function shareLink(code) {
  const here = location.href;
  const friendUrl = here.replace(/driver\.html.*$/, "friend.html");
  return friendUrl + "?channel=" + code;
}

async function start() {
  const code = $("code").textContent;
  $("start").disabled = true;
  setStatus("正在建立点对点连接…");

  signaling = await connectSignaling("hereiam_" + code, onSignal);
  setStatus("等待好友打开链接加入…");
  // 连接由好友的 "join" 信号触发建立
}

// 建立（或重建）P2P 连接，并向好友发送 offer
function createConnection() {
  if (pc) {
    try {
      pc.close();
    } catch (e) {}
  }
  pc = new RTCPeerConnection({ iceServers: CONFIG.stunServers });

  // 数据通道：用于传输位置（点对点直连，不经服务器）
  dc = pc.createDataChannel("location");
  dc.onopen = startLocationStream;

  pc.onicecandidate = (e) => {
    if (e.candidate && signaling)
      signaling.send({ type: "candidate", candidate: e.candidate });
  };
  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === "connected") setStatus("已点对点直连，正在实时上报位置", true);
    else if (s === "failed") {
      setStatus("连接断开，等待好友重新加入…");
      pc = null;
    }
  };

  const doOffer = async () => {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (signaling) signaling.send({ type: "offer", sdp: offer });
  };
  doOffer();
}

async function onSignal(msg) {
  if (msg.type === "join") {
    // 好友加入/重连：重建连接并发 offer。
    // 好友端会周期重发 join，已连接/正在连接时忽略，避免反复重建。
    if (pc && pc.connectionState !== "failed" && pc.connectionState !== "closed") {
      return;
    }
    createConnection();
  } else if (msg.type === "answer") {
    if (pc) {
      try {
        await pc.setRemoteDescription(msg.sdp);
      } catch (e) {}
    }
  } else if (msg.type === "candidate") {
    if (pc) {
      try {
        await pc.addIceCandidate(msg.candidate);
      } catch (e) {}
    }
  }
}

function startLocationStream() {
  setStatus("已连接，正在实时上报位置", true);
  if (navigator.geolocation) {
    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const m = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          t: Date.now(),
        };
        if (dc && dc.readyState === "open") dc.send(JSON.stringify(m));
      },
      (err) => setStatus("定位失败：" + err.message),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 5000 }
    );
  } else {
    setStatus("当前浏览器不支持定位");
  }
}

window.addEventListener("beforeunload", () => {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  if (pc) pc.close();
  if (signaling) signaling.close();
});

init();
