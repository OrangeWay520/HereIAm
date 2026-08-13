// ============================================================
//  好友端逻辑：接收 P2P 位置，在高德地图上实时显示
//  位置来自 WebRTC 数据通道（点对点），不经过任何服务器。
//  打开页面时发送 "join" 通知司机，司机据此建立连接。
//  功能：
//   1. 司机位置显示为「圆形 + 方向箭头」实时定位标（随 heading 旋转）
//   2. 「定位司机」按钮：把司机位置放中心，并按司机-好友距离动态缩放
// ============================================================

const $ = (id) => document.getElementById(id);
let pc = null;
let dc = null;
let signaling = null;
let joinTimer = null;
let map = null;
let driverMarker = null; // 司机定位标
let driverArrowG = null; // 司机定位标内的三角形指针(<g>)
let myMarker = null; // 好友自己位置
let myPos = null; // 好友自己坐标(GCJ-02)
let follow = false; // 是否跟随司机（定位司机模式）

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

// ============================================================
//  司机定位标：高德风格 —— 半透明外晕 + 实心圆 + 中心白点
//  + 白色三角形指针绕中心旋转指向行进方向(heading)。
//  静止时(heading 为 null)保持最后已知方向，避免箭头乱转。
// ============================================================
function createDriverMarker(pos, heading) {
  const content = document.createElement("div");
  content.style.cssText = "width:48px;height:48px;position:relative;";
  content.innerHTML =
    '<svg width="48" height="48" viewBox="0 0 48 48" style="position:absolute;inset:0;">' +
    // 外圈半透明晕
    '<circle cx="24" cy="24" r="23" fill="rgba(64,158,255,0.18)" stroke="#409EFF" stroke-width="2"/>' +
    // 实心圆
    '<circle cx="24" cy="24" r="15" fill="#409EFF"/>' +
    // 中心白点（盖在三角底部）
    '<circle cx="24" cy="24" r="3.6" fill="#fff"/>' +
    // 三角形指针：尖端朝上(北)，绕中心旋转指向行进方向
    '<g transform="rotate(' +
    (heading || 0) +
    ' 24 24)">' +
    '<polygon points="24,9 28.5,21 19.5,21" fill="#fff"/>' +
    "</g>" +
    "</svg>";
  content.style.cssText += "filter:drop-shadow(0 1px 3px rgba(0,0,0,.25));";

  const arrowG = content.querySelector("g");
  const marker = new AMap.Marker({
    position: pos,
    content: content,
    offset: new AMap.Pixel(-24, -24), // 让定位标中心对准坐标点
    zIndex: 120,
  });
  return { marker, arrowG };
}

// 更新三角形指针方向；heading 为 null（静止）时保持原方向
function updateDriverArrow(heading) {
  if (driverArrowG && heading != null) {
    driverArrowG.setAttribute("transform", "rotate(" + heading + " 24 24)");
  }
}

// ============================================================
//  好友自己的位置（用于计算司机-好友距离做动态缩放）
//  好友可拒绝定位：拒绝则退化为固定缩放
// ============================================================
function locateMe() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const [lng, lat] = wgs84ToGcj02(pos.coords.longitude, pos.coords.latitude);
      myPos = new AMap.LngLat(lng, lat);
      if (!map) return;
      if (!myMarker) {
        myMarker = new AMap.Marker({
          position: myPos,
          content: '<div style="width:14px;height:14px;border-radius:50%;' +
            'background:#22c55e;border:2px solid #fff;box-shadow:0 0 4px rgba(0,0,0,.3);"></div>',
          offset: new AMap.Pixel(-7, -7),
          zIndex: 110,
        });
        map.add(myMarker);
      } else {
        myMarker.setPosition(myPos);
      }
    },
    () => {}, // 好友拒绝定位：不显示自己，退化为固定缩放
    { enableHighAccuracy: true, maximumAge: 0, timeout: 8000 }
  );
}

// 两点球面距离（米）
function distanceM(a, b) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.sqrt(s));
}

// 滴滴式：按司机-好友距离动态决定缩放级别
// 越近 zoom 越大（看得清细节），越远 zoom 越小（看得全路线）
function zoomForDistance(dist) {
  if (dist < 100) return 17;
  if (dist < 300) return 16;
  if (dist < 600) return 15;
  if (dist < 1200) return 14;
  if (dist < 2500) return 13;
  if (dist < 5000) return 12;
  if (dist < 10000) return 11;
  return 10;
}

// 「定位司机」按钮：切换跟随模式
function toggleFollow() {
  follow = !follow;
  const btn = $("locBtn");
  btn.classList.toggle("active", follow);
  $("locTip").classList.toggle("show", follow);
  if (follow && map) {
    // 切换时立即把司机位置放中心并更新缩放
    if (driverMarker) {
      const p = driverMarker.getPosition();
      map.setCenter(p);
      applyZoom();
    }
  }
}

// 跟随模式下按司机-好友距离设置缩放；无好友位置则用固定缩放
function applyZoom() {
  if (!map) return;
  if (myPos && driverMarker) {
    const dp = driverMarker.getPosition();
    const dist = distanceM(
      { lat: dp.lat, lng: dp.lng },
      { lat: myPos.lat, lng: myPos.lng }
    );
    map.setZoom(zoomForDistance(dist));
  } else {
    map.setZoom(15);
  }
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
  // 获取好友自己位置（可选，用于动态缩放）
  locateMe();
  $("locBtn").addEventListener("click", toggleFollow);

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
  if (!driverMarker) {
    const created = createDriverMarker(pos, m.heading);
    driverMarker = created.marker;
    driverArrowG = created.arrowG;
    map.add(driverMarker);
  } else {
    driverMarker.setPosition(pos);
    updateDriverArrow(m.heading);
  }

  // 跟随模式下：司机位置放中心 + 按距离动态缩放
  if (follow) {
    map.setCenter(pos);
    applyZoom();
  }

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
