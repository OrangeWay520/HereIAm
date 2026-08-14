// ============================================================
//  HereIAm 网页端首页逻辑 —— 地图 + HIA 按键（分享/查看二合一）
//  位置通过 WebRTC 数据通道点对点直传，不经任何服务器。
//  点击 HIA 按键选择「分享我的位置」或「查看他人位置」。
// ============================================================

const $ = (id) => document.getElementById(id);

// ========== 全局状态 ==========
let map = null;
let mode = "idle";              // "idle" | "share" | "view"
let pc = null, dc = null, signaling = null;
let shareCode = null;           // 分享口令
let viewCode = null;            // 正在查看的口令（查看模式）
let joinTimer = null;           // 查看者重发 join 定时器

// 自己的位置（进入页面即自动定位，同 App 端）
let myWatchId = null;           // 自己的定位 watch
let myPos = null;               // 最新位置 {lat,lng,heading}
let deviceHeading = null;       // 设备指南针朝向（静止时方向指针也转）
let myMarker = null, myArrowG = null, myHasCentered = false;

// 查看模式：好友定位标
let driverMarker = null, driverArrowG = null;
let driverAvatarImg = null, driverNameEl = null;
let driverAvatarData = null, driverName = null; // 分享者资料暂存（marker 未创建前）
let hasCentered = false;

// 本好友会话唯一 ID（查看模式用）
const friendId = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

// ========== 水滴定位标常量（与 friend.js 一致，M_SCALE=8/15）==========
const M_SCALE = 8 / 15;
const M_R = 22 * M_SCALE;
const M_WHITE_BORDER = 3.5 * M_SCALE;
const M_AVATAR_R = M_R - 1.2;
const M_R_WHITE = M_R + M_WHITE_BORDER;
const M_CX = 48 * M_SCALE;
const M_CY = 72 * M_SCALE;
const M_SVG_W = 96 * M_SCALE;
const M_SVG_H = 120 * M_SCALE;

// ============================================================
//  地图初始化
// ============================================================
function canUseWebGL2() {
  try {
    const c = document.createElement("canvas");
    return !!window.WebGL2RenderingContext && !!c.getContext("webgl2");
  } catch (e) { return false; }
}

function initMap() {
  const key = CONFIG.amapKey;
  if (!key || key.startsWith("YOUR")) return;
  window._AMapSecurityConfig = { securityJsCode: CONFIG.amapSecurityCode };
  const s = document.createElement("script");
  s.src = "https://webapi.amap.com/maps?v=" + (canUseWebGL2() ? "2.0" : "1.4.15") + "&key=" + key;
  s.onload = () => {
    const ph = document.querySelector("#map p");
    if (ph) ph.remove();
    map = new AMap.Map("map", { zoom: 16, center: [116.397428, 39.90923] });
  };
  document.head.appendChild(s);
}

// ============================================================
//  UI 交互
// ============================================================
function showOverlay() { $("overlay").style.display = "block"; }
function hideOverlay() { $("overlay").style.display = "none"; }

function hideAllPanels() {
  $("sheet").style.display = "none";
  $("sharePanel").style.display = "none";
  $("viewPanel").style.display = "none";
  hideOverlay();
}

function onHiaClick() {
  // 已有面板打开 → 关闭；否则按当前模式直接弹出对应窗口
  const anyOpen = $("sheet").style.display !== "none" ||
                  $("sharePanel").style.display !== "none" ||
                  $("viewPanel").style.display !== "none";
  if (anyOpen) { hideAllPanels(); return; }
  showOverlay();
  if (mode === "share") {
    // 正在共享 → 直接弹出「分享我的位置」窗口
    $("sharePanel").style.display = "block";
    return;
  }
  if (mode === "view") {
    // 正在查看他人 → 直接弹出「查看他人位置」窗口（显示正在查看状态）
    showViewPanel(true);
    return;
  }
  // 空闲 → 弹出选择面板
  $("sheet").style.display = "block";
}

// 查看面板双态：true=正在查看（口令+停止），false=输入口令
function showViewPanel(isViewing) {
  $("inputSection").style.display = isViewing ? "none" : "block";
  $("viewingSection").style.display = isViewing ? "block" : "none";
  if (isViewing && viewCode) $("viewingCode").textContent = viewCode;
}

function startShare() {
  $("sheet").style.display = "none";
  $("sharePanel").style.display = "block";
  if (!shareCode) {
    shareCode = genCode();
    initShare(shareCode);
  }
}

function startView() {
  $("sheet").style.display = "none";
  showViewPanel(false);
  $("viewPanel").style.display = "block";
}

function stopShare() {
  // 注意：不清除 myWatchId —— 全局定位持续运行，地图继续显示自己的定位标
  if (pc) { try { pc.close(); } catch (e) {} pc = null; }
  if (signaling) { try { signaling.close(); } catch (e) {} signaling = null; }
  shareCode = null;
  mode = "idle";
  setShareStatus("已停止共享", false);
  setIndicator(false);
  $("stopBtn").style.display = "none";
  $("code").textContent = "------";
  $("qrcode").src = "";
}

// ============================================================
//  分享逻辑（分享者端）
// ============================================================
function genCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function shareLink(code) {
  const here = location.href;
  const friendUrl = here.replace(/index\.html.*$/, "friend.html");
  return friendUrl + "?channel=" + code;
}

async function initShare(code) {
  mode = "share";
  $("code").textContent = code;
  const link = shareLink(code);
  $("qrcode").src =
    "https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=" +
    encodeURIComponent(link);
  setShareStatus("正在建立点对点连接…", false);

  try {
    signaling = await connectSignaling("hereiam_" + code, onSignalShare);
    setShareStatus("等待好友打开链接加入…", false);
    setIndicator(true);
  } catch (e) {
    setShareStatus("信令连接失败，请检查网络", false);
  }
}

// 分享者：收到好友 join → 创建 WebRTC 连接并发 offer
function createConnection() {
  if (pc) { try { pc.close(); } catch (e) {} }
  pc = new RTCPeerConnection({ iceServers: CONFIG.stunServers });
  dc = pc.createDataChannel("location");
  dc.onopen = () => {
    // 连接建立后把自己的资料（用户名+头像）推送给好友端
    sendMyProfile();
    startLocationStream();
  };

  pc.onicecandidate = (e) => {
    if (e.candidate && signaling)
      signaling.send({ type: "candidate", candidate: e.candidate });
  };
  pc.onconnectionstatechange = () => {
    if (!pc) return;
    const s = pc.connectionState;
    if (s === "connected") {
      setShareStatus("已点对点直连，正在实时上报位置", true);
      setIndicator(true);
      $("stopBtn").style.display = "block";
    } else if (s === "failed" || s === "disconnected") {
      setShareStatus("连接断开，等待好友重新加入…", false);
      setIndicator(false);
    }
  };

  (async () => {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (signaling) signaling.send({ type: "offer", sdp: offer });
  })();
}

async function onSignalShare(msg) {
  if (msg.type === "join") {
    // 好友加入/重连：重建连接并发 offer
    if (pc && pc.connectionState !== "failed" && pc.connectionState !== "closed") return;
    createConnection();
  } else if (msg.type === "answer") {
    if (pc) { try { await pc.setRemoteDescription(msg.sdp); } catch (e) {} }
  } else if (msg.type === "candidate") {
    if (pc) { try { await pc.addIceCandidate(msg.candidate); } catch (e) {} }
  } else if (msg.type === "leave" || msg.type === "bye") {
    setShareStatus("好友已退出查看", false);
  }
}

// ============================================================
//  自己的位置：进入页面即自动定位（同 App 端），显示自己的水滴标
// ============================================================
function startMyLocation() {
  if (!navigator.geolocation) { setIndicator(false); return; }
  let retries = 0;
  const startWatch = () => {
    myWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        retries = 0;
        // 方向：GPS 行进方向优先（移动时准确）；静止时用设备指南针（initCompass 融合）
        let heading = pos.coords.heading != null ? Math.round(pos.coords.heading) : null;
        if (heading == null && deviceHeading != null) heading = Math.round(deviceHeading);
        myPos = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          heading: heading,
          acc: Math.round(pos.coords.accuracy || 0),
          t: Date.now(),
        };
        // 地图上更新自己的水滴定位标
        updateMyMarker();
        // 双向共享：数据通道打开时把自己的位置实时回传对方
        if (dc && dc.readyState === "open") {
          if (mode === "share") {
            // 分享模式：发送 WGS-84，好友端(friend.js)统一转 GCJ-02
            dc.send(JSON.stringify(myPos));
          } else if (mode === "view") {
            // 查看模式：分享者是安卓 App，其直接按 GCJ-02 显示，需先转换
            const [lng, lat] = wgs84ToGcj02(myPos.lng, myPos.lat);
            dc.send(JSON.stringify({
              type: "loc", lat, lng,
              heading: myPos.heading, acc: myPos.acc, t: Date.now(),
            }));
          }
        }
      },
      (err) => {
        retries++;
        if (retries <= 5) {
          setIndicator(false);
          setTimeout(startWatch, 3000);
        } else {
          setIndicator(false);
        }
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 8000 }
    );
  };
  startWatch();
}

// 在地图上显示/更新自己的水滴定位标
function updateMyMarker() {
  if (!map || !myPos) return;
  const [lng, lat] = wgs84ToGcj02(myPos.lng, myPos.lat);
  const pos = new AMap.LngLat(lng, lat);
  if (!myMarker) {
    const created = createDriverMarker(pos, myPos.heading);
    myMarker = created.marker;
    myArrowG = created.arrowG;
    map.add(myMarker);
    // 首次定位成功后自动把地图焦点移到当前位置
    if (!myHasCentered) { myHasCentered = true; map.setCenter(pos); }
  } else {
    myMarker.setPosition(pos);
    updateArrowG(myArrowG, myPos.heading);
  }
}

// 定位按钮：回到自己位置
function goToMyLocation() {
  if (!map) return;
  if (myPos) {
    const [lng, lat] = wgs84ToGcj02(myPos.lng, myPos.lat);
    map.setZoomAndCenter(16, new AMap.LngLat(lng, lat));
  } else {
    // 尚未定位成功，重新请求一次
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        myPos = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          heading: pos.coords.heading != null ? Math.round(pos.coords.heading) : null,
          t: Date.now(),
        };
        updateMyMarker();
        const [lng, lat] = wgs84ToGcj02(myPos.lng, myPos.lat);
        map.setZoomAndCenter(16, new AMap.LngLat(lng, lat));
      },
      () => { setIndicator(false); },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 8000 }
    );
  }
}

// 分享者：数据通道打开后立即上报当前定位（后续由 myWatch 实时驱动）
function startLocationStream() {
  if (!myPos) return;
  const accText = myPos.acc > 0 ? " · 精度约" + myPos.acc + "米" : "";
  setShareStatus("已连接，正在实时上报位置" + accText, true);
  if (dc && dc.readyState === "open") dc.send(JSON.stringify(myPos));
}

// ============================================================
//  查看逻辑（查看者端）
// ============================================================
async function joinView() {
  const code = $("viewCode").value.trim();
  if (code.length !== 6) return;
  mode = "view";
  viewCode = code;
  hideOverlay();
  $("viewPanel").style.display = "none";
  setViewStatus("正在连接…", false);

  try {
    signaling = await connectSignaling("hereiam_" + code, onSignalView);
    setViewStatus("等待好友分享…", false);
    signaling.send({ type: "join", id: friendId });
    startJoinTimer();
  } catch (e) {
    setViewStatus("信令连接失败，请检查网络", false);
  }
}

// 停止查看：断开连接、移除好友定位标、回到空闲
function stopView() {
  mode = "idle";
  viewCode = null;
  if (joinTimer) { clearInterval(joinTimer); joinTimer = null; }
  if (pc) { try { pc.close(); } catch (e) {} pc = null; dc = null; }
  if (signaling) { try { signaling.close(); } catch (e) {} signaling = null; }
  removeDriverMarker();
  setIndicator(false);
  setViewStatus("已停止查看", false);
  $("viewPanel").style.display = "none";
  hideOverlay();
}

function startJoinTimer() {
  if (joinTimer) return;
  joinTimer = setInterval(() => {
    if (pc && pc.connectionState === "connected") {
      clearInterval(joinTimer); joinTimer = null; return;
    }
    if (signaling) signaling.send({ type: "join", id: friendId });
  }, 2000);
}

async function onSignalView(msg) {
  if (msg.type === "offer") {
    await handleOffer(msg.sdp);
  } else if (msg.type === "candidate") {
    if (pc) { try { await pc.addIceCandidate(msg.candidate); } catch (e) {} }
  } else if (msg.type === "bye") {
    setViewStatus("对方已结束共享，可关闭", false);
    setIndicator(false);
    mode = "idle";
    viewCode = null;
    if (joinTimer) { clearInterval(joinTimer); joinTimer = null; }
    if (pc) { try { pc.close(); } catch (e) {} pc = null; dc = null; }
    removeDriverMarker();
  }
}

// 移除分享者定位标（对方结束共享 / 停止查看时调用）
function removeDriverMarker() {
  if (driverMarker) {
    try { driverMarker.setMap(null); } catch (e) {}
    driverMarker = null;
  }
  driverArrowG = null;
  driverAvatarImg = null;
  driverNameEl = null;
  driverAvatarData = null;
  driverName = null;
  hasCentered = false;
}

async function handleOffer(offer) {
  if (pc) { try { pc.close(); } catch (e) {} }
  pc = new RTCPeerConnection({ iceServers: CONFIG.stunServers });
  pc.onicecandidate = (e) => {
    if (e.candidate && signaling)
      signaling.send({ type: "candidate", candidate: e.candidate, id: friendId });
  };
  pc.ondatachannel = (e) => {
    dc = e.channel;
    dc.onopen = () => {
      // 连接建立后把自己的资料（用户名+头像）推送给分享者（安卓端显示）
      sendMyProfile();
    };
    dc.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m && m.type === "profile") {
        setDriverProfile(m.name, m.avatar);
      } else if (m && m.lat !== undefined) {
        onLocation(m);
      }
    };
  };
  pc.onconnectionstatechange = () => {
    if (!pc) return;
    const st = pc.connectionState;
    if (st === "connected") {
      setViewStatus("已点对点直连", true);
      setIndicator(true);
    } else if (st === "disconnected" || st === "failed") {
      setViewStatus("连接中断，正在自动重连…", false);
      setIndicator(false);
      startJoinTimer();
    }
  };
  await pc.setRemoteDescription(offer);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  signaling.send({ type: "answer", sdp: answer, id: friendId });
}

// 收到分享者位置 → 在地图上显示水滴标记
function onLocation(m) {
  if (!map) return;
  const [lng, lat] = wgs84ToGcj02(m.lng, m.lat);
  const pos = new AMap.LngLat(lng, lat);
  if (!driverMarker) {
    const created = createDriverMarker(pos, m.heading);
    driverMarker = created.marker;
    driverArrowG = created.arrowG;
    driverAvatarImg = created.avatarImg;
    driverNameEl = created.nameEl;
    map.add(driverMarker);
    // 若资料在位置之前到达，此处补上名字/头像
    applyDriverProfile();
    if (!hasCentered) { hasCentered = true; map.setCenter(pos); }
  } else {
    driverMarker.setPosition(pos);
    updateArrowG(driverArrowG, m.heading);
  }
}

// ============================================================
//  水滴定位标（固定圆盘 + 旋转指针，与 friend.js 一致）
// ============================================================
function createDriverMarker(pos, heading) {
  const content = document.createElement("div");
  content.style.cssText = "width:" + M_SVG_W + "px;height:" + M_SVG_H + "px;position:relative;";
  content.innerHTML =
    '<svg width="' + M_SVG_W + '" height="' + M_SVG_H + '" viewBox="0 0 ' + M_SVG_W + " " + M_SVG_H + '" style="position:absolute;inset:0;">' +
    '<defs><filter id="glowF" x="-80%" y="-80%" width="260%" height="260%">' +
    '<feGaussianBlur stdDeviation="' + (2.2 * M_SCALE).toFixed(2) + '"/></filter></defs>' +
    '<g id="arrowG" transform="rotate(' + (heading || 0) + " " + M_CX + " " + M_CY + ')">' +
    '<path d="' + buildWaterdropPathD(M_R_WHITE) + '" fill="none" stroke="rgba(47,134,246,0.28)" stroke-width="' + (5 * M_SCALE).toFixed(2) + '" stroke-linejoin="round" filter="url(#glowF)"/>' +
    '<path d="' + buildWaterdropPathD(M_R_WHITE) + '" fill="#ffffff"/>' +
    '<path d="' + buildPointerPathD() + '" fill="rgba(47,134,246,0.96)"/>' +
    "</g>" +
    '<circle cx="' + M_CX + '" cy="' + M_CY + '" r="' + M_R.toFixed(2) + '" fill="rgba(47,134,246,0.96)"/>' +
    // 分享者头像（覆盖在圆盘上，圆形裁剪）
    '<clipPath id="avatarClip"><circle cx="' + M_CX + '" cy="' + M_CY + '" r="' + M_AVATAR_R.toFixed(2) + '"/></clipPath>' +
    '<image id="avatarImg" x="' + (M_CX - M_AVATAR_R).toFixed(2) + '" y="' + (M_CY - M_AVATAR_R).toFixed(2) +
    '" width="' + (M_AVATAR_R * 2).toFixed(2) + '" height="' + (M_AVATAR_R * 2).toFixed(2) +
    '" clip-path="url(#avatarClip)" style="display:none;pointer-events:none;"/>' +
    '<circle cx="' + M_CX + '" cy="' + M_CY + '" r="' + M_R.toFixed(2) + '" fill="none" stroke="#ffffff" stroke-width="' + M_WHITE_BORDER.toFixed(2) + '"/>' +
    "</svg>";
  // 分享者名字气泡（显示在地标上方）
  const nameEl = document.createElement("div");
  nameEl.id = "driverName";
  nameEl.style.cssText =
    "position:absolute;top:-16px;left:50%;transform:translateX(-50%);" +
    "max-width:140px;padding:2px 8px;border-radius:10px;background:rgba(26,26,46,0.75);" +
    "color:#fff;font-size:11px;line-height:16px;white-space:nowrap;overflow:hidden;" +
    "text-overflow:ellipsis;display:none;pointer-events:none;";
  content.appendChild(nameEl);
  const marker = new AMap.Marker({
    position: pos, content: content,
    offset: new AMap.Pixel(-M_CX, -M_CY), zIndex: 120,
  });
  return {
    marker,
    arrowG: content.querySelector("#arrowG"),
    avatarImg: content.querySelector("#avatarImg"),
    nameEl: nameEl,
  };
}

// 应用分享者资料（用户名 + 头像）到定位标
function applyDriverProfile() {
  if (driverNameEl && driverName) {
    driverNameEl.textContent = driverName;
    driverNameEl.style.display = "block";
  }
  if (driverAvatarImg && driverAvatarData) {
    // 同时设置 href 与 xlink:href，兼容新旧浏览器
    driverAvatarImg.setAttribute("href", driverAvatarData);
    driverAvatarImg.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", driverAvatarData);
    driverAvatarImg.style.display = "block";
  }
}

// 显示分享者资料（数据通道推送的 profile 消息）
function setDriverProfile(name, dataUrl) {
  if (name) driverName = name;
  if (dataUrl) driverAvatarData = dataUrl;
  applyDriverProfile();
}

function buildWaterdropPathD(r) {
  var cx = M_CX, cy = M_CY;
  var cos30 = Math.cos(Math.PI / 6);
  var tipY = cy - 2 * r;
  var tanY = cy - r * 0.5;
  var tanX = r * cos30;
  return "M" + cx + "," + tipY.toFixed(2) +
    " L" + (cx + tanX).toFixed(2) + "," + tanY.toFixed(2) +
    " A " + r + "," + r + " 0 1 1 " + (cx - tanX).toFixed(2) + "," + tanY.toFixed(2) +
    " Z";
}

function buildPointerPathD() {
  var cx = M_CX, cy = M_CY, r = M_R;
  var cos30 = Math.cos(Math.PI / 6);
  var tipY = cy - 2 * r;
  var tanY = cy - r * 0.5;
  var tanX = r * cos30;
  return "M" + cx + "," + tipY.toFixed(2) +
    " L" + (cx + tanX).toFixed(2) + "," + tanY.toFixed(2) +
    " L" + (cx - tanX).toFixed(2) + "," + tanY.toFixed(2) +
    " Z";
}

function updateArrowG(g, heading) {
  if (g && heading != null) {
    g.setAttribute("transform", "rotate(" + heading + " " + M_CX + " " + M_CY + ")");
  }
}

// ============================================================
//  WGS-84 → GCJ-02 坐标转换
// ============================================================
function wgs84ToGcj02(lng, lat) {
  const a = 6378245.0;
  const ee = 0.00669342162296594323;
  if (lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271) return [lng, lat];
  const transformLat = (x, y) => {
    let r = -100 + 2*x + 3*y + 0.2*y*y + 0.1*x*y + 0.2*Math.sqrt(Math.abs(x));
    r += ((20*Math.sin(6*x*Math.PI)+20*Math.sin(2*x*Math.PI))*2)/3;
    r += ((20*Math.sin(y*Math.PI)+40*Math.sin((y/3)*Math.PI))*2)/3;
    r += ((160*Math.sin((y/12)*Math.PI)+320*Math.sin((y*Math.PI)/30))*2)/3;
    return r;
  };
  const transformLng = (x, y) => {
    let r = 300+x+2*y+0.1*x*x+0.1*x*y+0.1*Math.sqrt(Math.abs(x));
    r += ((20*Math.sin(6*x*Math.PI)+20*Math.sin(2*x*Math.PI))*2)/3;
    r += ((20*Math.sin(x*Math.PI)+40*Math.sin((x/3)*Math.PI))*2)/3;
    r += ((150*Math.sin((x/12)*Math.PI)+300*Math.sin((x/30)*Math.PI))*2)/3;
    return r;
  };
  const radLat = (lat/180)*Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - ee*magic*magic;
  const sm = Math.sqrt(magic);
  const dLat = (transformLat(lng-105, lat-35)*180)/(((a*(1-ee))/(magic*sm))*Math.PI);
  const dLng = (transformLng(lng-105, lat-35)*180)/((a/sm)*Math.cos(radLat)*Math.PI);
  return [lng + dLng, lat + dLat];
}

// ============================================================
//  工具函数
// ============================================================
function setShareStatus(text, on) {
  const el = $("status");
  el.textContent = text;
  el.className = "status" + (on ? " on" : "");
}

function setViewStatus(text, on) {
  const el = $("viewStatus");
  el.textContent = text;
  el.className = "status" + (on ? " on" : "");
}

function setIndicator(on) {
  $("indicator").className = "indicator" + (on ? " on" : "");
}

// ========== 指南针（设备朝向）：静止时也让方向指针转动 ==========
function initCompass() {
  if (typeof DeviceOrientationEvent === "undefined") return;
  const start = () => {
    window.addEventListener(
      "deviceorientation",
      (e) => {
        let deg = null;
        if (e.absolute === false && e.webkitCompassHeading !== undefined) {
          deg = 360 - e.webkitCompassHeading; // iOS：webkitCompassHeading 即方位角
        } else if (e.alpha !== null && e.alpha !== undefined) {
          deg = (360 - e.alpha) % 360;         // Android：alpha 相对北，顺时针
        }
        if (deg == null) return;
        // 指数平滑（0.3），避免指针抖动
        if (deviceHeading != null) {
          let diff = deg - deviceHeading;
          if (diff > 180) diff -= 360;
          else if (diff < -180) diff += 360;
          deviceHeading = (deviceHeading + diff * 0.3 + 360) % 360;
        } else {
          deviceHeading = deg;
        }
        // 静止时（无 GPS heading）用指南针驱动自己的定位标
        if (myPos && myPos.heading == null) {
          myPos.heading = Math.round(deviceHeading);
          updateMyMarker();
          if (dc && dc.readyState === "open") sendMyLocationNow();
        }
      },
      true
    );
  };
  if (DeviceOrientationEvent.requestPermission) {
    DeviceOrientationEvent.requestPermission()
      .then((state) => {
        if (state === "granted") start();
      })
      .catch(() => {});
  } else {
    start();
  }
}

// 把自己的资料（用户名 + 头像）推送给当前对端
function sendMyProfile() {
  if (!dc || dc.readyState !== "open") return;
  try {
    const p = getUserProfile();
    const msg = { type: "profile", name: p.name };
    if (p.avatar) msg.avatar = p.avatar;
    dc.send(JSON.stringify(msg));
  } catch (e) {}
}
// 用户中心修改资料后：重发 profile
onUserProfileChanged = sendMyProfile;

// 立即把当前自己的位置回传给对端（分享模式发 WGS-84，查看模式发 GCJ-02）
function sendMyLocationNow() {
  if (!dc || dc.readyState !== "open" || !myPos) return;
  if (mode === "share") {
    dc.send(JSON.stringify(myPos));
  } else if (mode === "view") {
    const [lng, lat] = wgs84ToGcj02(myPos.lng, myPos.lat);
    dc.send(JSON.stringify({
      type: "loc", lat, lng,
      heading: myPos.heading, acc: myPos.acc, t: Date.now(),
    }));
  }
}

function copyText(text) {
  navigator.clipboard.writeText(text).then(() => {
    alert("已复制：" + text);
  }).catch(() => {
    // 降级方案
    const ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); alert("已复制：" + text); } catch (e) {}
    document.body.removeChild(ta);
  });
}

// ============================================================
//  事件绑定 + 初始化
// ============================================================
function bindEvents() {
  $("hiaBtn").addEventListener("click", onHiaClick);
  $("overlay").addEventListener("click", hideAllPanels);
  $("locateBtn").addEventListener("click", goToMyLocation);

  $("optShare").addEventListener("click", startShare);
  $("optView").addEventListener("click", startView);

  // 分享面板
  $("shareClose").addEventListener("click", () => { $("sharePanel").style.display = "none"; hideOverlay(); });
  $("code").addEventListener("click", () => { if (shareCode) copyText(shareCode); });
  $("copyBtn").addEventListener("click", () => { if (shareCode) copyText(shareCode); });
  $("linkBtn").addEventListener("click", () => { if (shareCode) copyText(shareLink(shareCode)); });
  $("stopBtn").addEventListener("click", stopShare);

  // 查看面板
  $("viewClose").addEventListener("click", () => { $("viewPanel").style.display = "none"; hideOverlay(); });
  $("stopViewBtn").addEventListener("click", stopView);
  $("viewCode").addEventListener("input", (e) => {
    $("joinBtn").disabled = e.target.value.trim().length !== 6;
  });
  $("joinBtn").addEventListener("click", joinView);

  // 页面关闭时清理
  window.addEventListener("beforeunload", () => {
    if (myWatchId != null) navigator.geolocation.clearWatch(myWatchId);
    if (joinTimer) clearInterval(joinTimer);
    if (pc) { try { pc.close(); } catch (e) {} }
    if (signaling) { try { signaling.close(); } catch (e) {} }
  });
}

initMap();
bindEvents();
startMyLocation();   // 进入页面即自动定位，显示自己的定位标
renderUserEntry();   // 用户中心：左上角入口 + 改名/改头像
bindUserCenterEvents();
initCompass();       // 指南针：静止时方向指针也转动
