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

// 检测浏览器是否支持 WebGL2：支持则用新版 JS API 2.0（矢量瓦片、新风格），
// 不支持（如部分 Edge/远程桌面/虚拟机）则自动降级到 1.4.15（栅格瓦片）。
function canUseWebGL2() {
  try {
    const c = document.createElement("canvas");
    return !!window.WebGL2RenderingContext && !!c.getContext("webgl2");
  } catch (e) {
    return false;
  }
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
  const useV2 = canUseWebGL2();
  const s = document.createElement("script");
  s.src =
    "https://webapi.amap.com/maps?v=" +
    (useV2 ? "2.0" : "1.4.15") +
    "&key=" +
    key;
  s.onload = () => {
    // 移除"地图加载中…"占位文字，避免它一直盖在地图上层
    const ph = document.querySelector("#map p");
    if (ph) ph.remove();
    // 预加载逆地理编码插件（显示"XX路附近"）
    try {
      AMap.plugin("AMap.Geocoder", () => {});
    } catch (e) {}
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

// ============================================================
//  WGS-84 → GCJ-02 坐标转换（高德/国内地图必须）
//  浏览器定位返回 WGS-84（国际 GPS 坐标），高德地图使用
//  GCJ-02（国测局加密坐标）。直接使用会偏移 300-500 米，
//  必须转换后才能在高德上准确显示。
//  参考：标准火星坐标转换算法（公开实现）。
// ============================================================
function wgs84ToGcj02(lng, lat) {
  const a = 6378245.0;
  const ee = 0.00669342162296594323;
  const outOfChina =
    lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
  if (outOfChina) return [lng, lat];
  const transformLat = (x, y) => {
    let ret =
      -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
    ret += ((20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin((y / 3.0) * Math.PI)) * 2.0) / 3.0;
    ret += ((160.0 * Math.sin((y / 12.0) * Math.PI) + 320.0 * Math.sin((y * Math.PI) / 30.0)) * 2.0) / 3.0;
    return ret;
  };
  const transformLng = (x, y) => {
    let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
    ret += ((20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin((x / 3.0) * Math.PI)) * 2.0) / 3.0;
    ret += ((150.0 * Math.sin((x / 12.0) * Math.PI) + 300.0 * Math.sin((x / 30.0) * Math.PI)) * 2.0) / 3.0;
    return ret;
  };
  const radLat = (lat / 180.0) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  const dLat =
    (transformLat(lng - 105.0, lat - 35.0) * 180.0) /
    (((a * (1 - ee)) / (magic * sqrtMagic)) * Math.PI);
  const dLng =
    (transformLng(lng - 105.0, lat - 35.0) * 180.0) /
    ((a / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return [lng + dLng, lat + dLat];
}

function onLocation(m) {
  if (!map) return;
  // 关键：浏览器定位是 WGS-84，高德是 GCJ-02，转换后消除几百米偏移
  const [lng, lat] = wgs84ToGcj02(m.lng, m.lat);
  const pos = new AMap.LngLat(lng, lat);
  if (!marker) {
    marker = new AMap.Marker({ position: pos });
    map.add(marker);
  } else {
    marker.setPosition(pos);
  }
  map.setCenter(pos);
  // 显示位置 + 精度（若司机端传了）
  const accText = m.acc && m.acc > 0 ? "（精度约 " + m.acc + " 米）" : "";
  if (AMap.Geocoder) {
    const geoc = new AMap.Geocoder();
    geoc.getAddress(pos, (st, r) => {
      if (st === "complete" && r.regeocode) {
        $("#addr").innerHTML =
          "<b>司机现在在：</b>" + r.regeocode.formattedAddress + " " + accText;
      }
    });
  }
}

window.addEventListener("beforeunload", () => {
  if (pc) pc.close();
  if (signaling) signaling.close();
});

init();
