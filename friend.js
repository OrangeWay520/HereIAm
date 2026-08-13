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
let driverAvatarImg = null; // 司机定位标内的头像(<image>)
let myMarker = null; // 好友自己位置
let myPos = null; // 好友自己坐标(GCJ-02)
let follow = false; // 是否跟随司机（定位司机模式）

// 本好友会话的唯一 ID：司机据此区分不同好友，支持多好友同时查看
const friendId =
  Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

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
//  司机定位标：固定圆盘 + 旋转指针（水滴 = 圆的60°/300°切线围成）
//  —— 固定层：蓝色圆盘(初始圆内，预留头像位) + 白色圆周线，永不旋转
//  —— 旋转层：蓝色指针(圆外切线区域) + 白色外轮廓 + 蓝色发散光晕，
//            绕初始圆圆心整体旋转，指针尖端指向行进方向(heading)
//  角度：0°=北(朝上) / 90°=东 / 180°=南 / 270°=西，顺时针
//  几何规格（圆心 M_CX,M_CY）：
//    基础圆半径 r → 尖顶 = (cx, cy-2r)，切点 = (cx±r·cos30°, cy-r/2)
//    指针 = 尖顶与两切点围成的三角形（圆外部分），底边与圆相切
//    白色外轮廓 r_white = 25.5 (=R+W)，圆盘 r_blue = 22 (=R)
// ============================================================
const M_SCALE = 1 / 3;                    // 整体缩放因子（原尺寸的 1/3，避免在地图上过大）
const M_R = 22 * M_SCALE;                 // 圆半径 ≈ 7.33
const M_WHITE_BORDER = 3.5 * M_SCALE;     // 白边宽 ≈ 1.17
const M_AVATAR_R = M_R - 1.2;             // 头像半径（圆内留白）
const M_R_WHITE = M_R + M_WHITE_BORDER;   // ≈ 8.5
const M_CX = 48 * M_SCALE;                // SVG 圆心 X = 16
const M_CY = 72 * M_SCALE;                // SVG 圆心 Y = 24（偏下给指针留空间）
const M_SVG_W = 96 * M_SCALE;             // 32
const M_SVG_H = 120 * M_SCALE;            // 40
function createDriverMarker(pos, heading) {
  const content = document.createElement("div");
  content.style.cssText = "width:" + M_SVG_W + "px;height:" + M_SVG_H + "px;position:relative;";
  content.innerHTML =
    '<svg width="' + M_SVG_W + '" height="' + M_SVG_H + '" viewBox="0 0 ' + M_SVG_W + " " + M_SVG_H + '" style="position:absolute;inset:0;">' +
    '<defs><filter id="glowF" x="-80%" y="-80%" width="260%" height="260%">' +
    '<feGaussianBlur stdDeviation="' + (2.2 * M_SCALE).toFixed(2) + '"/></filter></defs>' +
    // ========== 旋转层（指针 + 白色外轮廓 + 蓝色发散光）==========
    // 整个旋转层绕初始圆圆心 M_CX,M_CY 旋转
    '<g id="arrowG" transform="rotate(' + (heading || 0) + " " + M_CX + " " + M_CY + ')">' +
    // 1. 蓝色发散光晕（单层淡蓝 + 模糊，隐隐发散，替代灰色阴影）
    '<path d="' + buildWaterdropPathD(M_R_WHITE) + '" fill="none" stroke="rgba(47,134,246,0.28)" stroke-width="' + (5 * M_SCALE).toFixed(2) + '" stroke-linejoin="round" filter="url(#glowF)"/>' +
    // 2. 白色底层水滴（r = R+W = 25.5，外圈白色轮廓，无灰色描边）
    '<path d="' + buildWaterdropPathD(M_R_WHITE) + '" fill="#ffffff"/>' +
    // 3. 蓝色指针（圆外切线区域：尖顶 + 两切点围成的三角形，随旋转层旋转）
    '<path d="' + buildPointerPathD() + '" fill="rgba(47,134,246,0.96)"/>' +
    "</g>" +
    // ========== 固定层（圆盘 + 白色圆周线，永不旋转，预留头像位）==========
    // 4. 蓝色圆盘（初始圆内区域，后续可放个性化头像）
    '<circle cx="' + M_CX + '" cy="' + M_CY + '" r="' + M_R.toFixed(2) + '" fill="rgba(47,134,246,0.96)"/>' +
    // 4b. 司机头像（若有则覆盖在圆盘上，圆形裁剪）
    '<clipPath id="avatarClip"><circle cx="' + M_CX + '" cy="' + M_CY + '" r="' + M_AVATAR_R.toFixed(2) + '"/></clipPath>' +
    '<image id="avatarImg" x="' + (M_CX - M_AVATAR_R).toFixed(2) + '" y="' + (M_CY - M_AVATAR_R).toFixed(2) +
    '" width="' + (M_AVATAR_R * 2).toFixed(2) + '" height="' + (M_AVATAR_R * 2).toFixed(2) +
    '" clip-path="url(#avatarClip)" style="display:none;pointer-events:none;"/>' +
    // 5. 初始圆的白色轮廓（白色圆周线，分隔圆盘与指针）
    '<circle cx="' + M_CX + '" cy="' + M_CY + '" r="' + M_R.toFixed(2) + '" fill="none" stroke="#ffffff" stroke-width="' + M_WHITE_BORDER.toFixed(2) + '"/>' +
    "</svg>";

  const marker = new AMap.Marker({
    position: pos,
    content: content,
    // 让水滴圆心（原圆盘中心）对准坐标点
    offset: new AMap.Pixel(-M_CX, -M_CY),
    zIndex: 120,
  });
  const arrowG = content.querySelector("#arrowG");
  const avatarImg = content.querySelector("#avatarImg");
  return { marker, arrowG, avatarImg };
}

// 显示司机头像（数据通道推送的 data URL）
function setDriverAvatar(dataUrl) {
  if (!dataUrl) return;
  if (!driverAvatarImg) return;
  driverAvatarImg.setAttribute("href", dataUrl);
  driverAvatarImg.style.display = "block";
}

// 构建水滴外轮廓 Path d 字符串
// 几何：尖顶(cx, cy-2r) → 右下切点(cx+r·cos30°, cy-r/2)
//      → 顺时针大圆弧(经正南，240°) → 左下切点 → 闭合
function buildWaterdropPathD(r) {
  var cx = M_CX, cy = M_CY;
  var cos30 = Math.cos(Math.PI / 6);   // √3/2 ≈ 0.8660
  var tipY = cy - 2 * r;
  var tanY = cy - r * 0.5;             // 切点 y：圆心上方 r/2
  var tanX = r * cos30;                // 切点 x 偏移：r·cos30°
  // A r r 0 large-arc(1) sweep(1=顺时针) end-x end-y
  return "M" + cx + "," + tipY.toFixed(2) +
         " L" + (cx + tanX).toFixed(2) + "," + tanY.toFixed(2) +
         " A " + r + "," + r + " 0 1 1 " + (cx - tanX).toFixed(2) + "," + tanY.toFixed(2) +
         " Z";
}

// 构建蓝色指针 Path d 字符串（圆外切线区域）
// 几何：尖顶(cx, cy-2r) → 右切点 → 左切点 → 闭合（底边 = 切点连线，与圆相切）
function buildPointerPathD() {
  var cx = M_CX, cy = M_CY, r = M_R;
  var cos30 = Math.cos(Math.PI / 6);   // √3/2 ≈ 0.8660
  var tipY = cy - 2 * r;
  var tanY = cy - r * 0.5;
  var tanX = r * cos30;
  return "M" + cx + "," + tipY.toFixed(2) +
         " L" + (cx + tanX).toFixed(2) + "," + tanY.toFixed(2) +
         " L" + (cx - tanX).toFixed(2) + "," + tanY.toFixed(2) +
         " Z";
}

// 更新方向箭头指向；heading 为 null（静止）时保持最后已知方向
function updateDriverArrow(heading) {
  if (driverArrowG && heading != null) {
    driverArrowG.setAttribute(
      "transform",
      "rotate(" + heading + " " + M_CX + " " + M_CY + ")"
    );
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
  // 通知司机有好友加入，司机据此建立 P2P 连接（携带本好友唯一 ID）
  // 司机可能还没点"开始"（信令通道尚未建立），会收不到这次 join。
  // 因此每 2 秒重发一次 join，直到连接建立为止；断开后也会重启。
  signaling.send({ type: "join", id: friendId });
  startJoinTimer();
}

// 每 2 秒重发一次 join，直到与司机直连成功
function startJoinTimer() {
  if (joinTimer) return; // 已有定时器在跑，不重复
  joinTimer = setInterval(() => {
    if (pc && pc.connectionState === "connected") {
      clearInterval(joinTimer);
      joinTimer = null;
      return;
    }
    signaling.send({ type: "join", id: friendId });
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
      signaling.send({ type: "candidate", candidate: e.candidate, id: friendId });
  };
  pc.ondatachannel = (e) => {
    dc = e.channel;
    dc.onmessage = (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      if (m && m.type === "avatar") {
        setDriverAvatar(m.data);
      } else if (m && m.type === "loc") {
        onLocation(m);
      } else if (m && m.lat !== undefined) {
        // 兼容旧版司机端（无 type 字段的纯位置消息）
        onLocation(m);
      }
    };
  };
  pc.onconnectionstatechange = () => {
    if (!pc) return;
    const st = pc.connectionState;
    if (st === "connected") {
      setStatus("已点对点直连", true);
    } else if (st === "disconnected" || st === "failed") {
      setStatus("连接中断，正在自动重连…");
      // 司机端也会自动重连；这里同时重启 join 定时器，双保险
      startJoinTimer();
    }
  };

  await pc.setRemoteDescription(offer);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  signaling.send({ type: "answer", sdp: answer, id: friendId });
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
    driverAvatarImg = created.avatarImg;
    map.add(driverMarker);
    // 连接成功后自动把地图焦点移到司机所在区域，不用好友自己找
    map.setCenter(pos);
    applyZoom();
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
  if (joinTimer) clearInterval(joinTimer);
  // 通知司机本好友离开，司机立即释放对应连接并更新好友数
  if (signaling) signaling.send({ type: "leave", id: friendId });
  if (pc) pc.close();
  if (signaling) signaling.close();
});

init();
