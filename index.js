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
let voice = null;               // 语音对讲控制器（createVoiceController 创建）

// 自己的位置（进入页面即自动定位，同 App 端）
let myWatchId = null;           // 自己的定位 watch
let myPos = null;               // 最新位置 {lat,lng,heading,acc,t,gray}
let deviceHeading = null;       // 设备指南针朝向（真北，实时更新）
let lastCompassUpdate = 0;      // 指南针刷新节流
let lastCompassSend = 0;        // 方向回传节流
let myMarker = null, myArrowG = null, myHasCentered = false;
let myAvatarImg = null;   // 自己定位标上的头像元素（同安卓端：头像覆盖在蓝色圆盘上）
// 自己定位标颜色元素（灰/蓝切换用）
let myGlow = null, myPtr = null, myDisc = null;
// 自己定位信号状态：true=信号不佳（灰色定位标），false=已精确定位（蓝色）。
// 灰色时仍持续回传朝向（灰不影响手机朝向信号发送），信号恢复后自动转回蓝色。
let myGray = false;
let lastFixTime = 0;            // 最后一次成功定位的时间戳（信号看门狗用）

// 查看模式：好友定位标
let driverMarker = null, driverArrowG = null;
let driverAvatarImg = null, driverNameEl = null;
let driverAvatarData = null, driverName = null; // 分享者资料暂存（marker 未创建前）
let hasCentered = false;
// 对端定位标颜色元素（灰/蓝切换用）
let driverGlow = null, driverPtr = null, driverDisc = null;
// 定位标白/黑边框元素（浅色=白外轮廓+白圆周线，深色=黑，随系统深浅色切换）
let driverWdp = null, driverStroke = null; // 分享者定位标
let myWdp = null, myStroke = null;         // 自己定位标

// 本好友会话唯一 ID（查看模式用）
const friendId = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

// ========== 顶部用户选择器 / 定位按钮状态（同安卓 App） ==========
// 当前跟随目标："me"=自己位置居中 / "friend"=对端好友位置居中 / null=不跟随
let followTarget = "me";
// 定位按钮状态：0=聚焦正北, 1=方向跟随（目标朝向朝上，实时旋转）, 2=总览正北；点击循环切换
let locStep = 0;
// 方向跟随模式：地图实时旋转，使选中用户「当前运动方向/手机朝向」始终朝上（同高德/百度方向跟随）
let followDirection = false;
// 进入方向跟随的时刻：进入后短暂延迟再接管旋转，避免打断「居中+放大」动画（同安卓端 700ms）
let directionFollowSince = 0;
// 总览模式：定位键切到「总览全部」时置 true，暂停自动跟随；不改变用户选择框的选中项
let overviewMode = false;
// 对端好友的最新朝向（方向跟随用，由 showDriverAt 实时更新）
let driverHeading = null;
// 自动跟随去重：仅在位置真正变化时居中，避免指南针 80ms 刷新把地图反复拉回
let lastFollowCenter = null;

// ========== 水滴定位标常量（同安卓端，M_SCALE=8/15）==========
const M_SCALE = 8 / 15;
const M_R = 22 * M_SCALE;
const M_WHITE_BORDER = 3.5 * M_SCALE;
const M_AVATAR_R = M_R;                   // 头像半径 = 圆盘半径（头像外围白色轮廓与水滴外轮廓同宽）
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

// 深色模式边框色：白色外轮廓/圆周线在深色地图上改为黑色（与安卓端一致）
function markerBorderColor() {
  return (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches)
    ? "#000000"
    : "#ffffff";
}

// ============================================================
//  深色模式：地图底图自动跟随系统（prefers-color-scheme）
// ============================================================
function applyMapTheme() {
  if (!map || !map.setMapStyle) return;
  const dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  map.setMapStyle(dark ? "amap://styles/dark" : "amap://styles/normal");
  // 同步水滴标白/黑边框（深色地图上白边框过亮，改黑色，与安卓一致）
  const bc = markerBorderColor();
  if (driverWdp) driverWdp.setAttribute("fill", bc);
  if (driverStroke) driverStroke.setAttribute("stroke", bc);
  if (myWdp) myWdp.setAttribute("fill", bc);
  if (myStroke) myStroke.setAttribute("stroke", bc);
  // 刷新定位键水滴图标（白缝颜色随深浅色）
  setLocateIcon();
}

// 监听系统深浅色切换，实时更新地图底图
function setupThemeListener() {
  const mq = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)");
  if (!mq) return;
  const onChange = () => applyMapTheme();
  if (mq.addEventListener) mq.addEventListener("change", onChange);
  else if (mq.addListener) mq.addListener(onChange);  // 旧浏览器兼容
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
    map = new AMap.Map("map", { zoom: 16, center: [116.397428, 39.90923], rotateEnable: true });
    applyMapTheme();          // 首次按系统主题设置地图深色/浅色样式
    setupThemeListener();     // 系统主题变化时实时切换
    // 手动旋转（鼠标右键/双指）也会改变地图方向：监听旋转事件，同步权威值并刷新指针，
    // 保证指针真实方向始终与地图方向固定一致
    const onMapRotated = () => { syncMapRotFromMap(); refreshAllArrows(); };
    if (map.on) {
      map.on("rotating", onMapRotated);
      map.on("rotate", onMapRotated);
      map.on("viewchange", onMapRotated);
    }
    syncMapRotFromMap();
    refreshAllArrows();
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
  if (mode === "share") {
    // 正在共享 → 直接弹出「分享我的位置」窗口（不加遮罩，保持地图可见可用）
    $("sharePanel").style.display = "block";
    return;
  }
  if (mode === "view") {
    // 正在查看他人 → 直接弹出「查看他人位置」窗口（显示正在查看状态，不加遮罩）
    showViewPanel(true);
    return;
  }
  // 空闲 → 弹出选择面板，配遮罩
  showOverlay();
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
  hideOverlay(); // 进入共享后不再用遮罩压住地图与 HIA 键
  if (!shareCode) {
    shareCode = genCode();
    initShare(shareCode);
  }
  updateUserSelector();
}

function startView() {
  $("sheet").style.display = "none";
  hideOverlay(); // 进入查看后同样不压遮罩
  showViewPanel(false);
  $("viewPanel").style.display = "block";
}

function stopShare() {
  // 注意：不清除 myWatchId —— 全局定位持续运行，地图继续显示自己的定位标
  // 先发 bye 通知所有对端「分享已结束」，对方才能停止重连并清除定位标
  if (signaling) { try { signaling.send({ type: "bye" }); } catch (e) {} }
  // 关闭语音对讲（停麦克风、广播收声给对端）
  if (voice) { try { voice.disable(); } catch (e) {} }
  hideVoice(); // 隐藏语音按钮
  if (pc) { try { pc.close(); } catch (e) {} pc = null; }
  if (signaling) { try { signaling.close(); } catch (e) {} signaling = null; }
  shareCode = null;
  mode = "idle";
  setShareStatus("已停止共享", false);
  setIndicator(false);
  $("stopBtn").style.display = "none";
  $("code").textContent = "------";
  $("qrcode").src = "";
  // 停止共享后收起分享面板
  hideAllPanels();
  // 移除对端（查看者）定位标并跳回自己（同安卓端 clearAllFriends 行为）
  removeDriverMarker();
  revertToMe();
}

// ============================================================
//  分享逻辑（分享者端）
// ============================================================
function genCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function shareLink(code) {
  // 统一用 index.html 作为分享落地页（不再区分好友端/发起端）。
  // 以当前 URL 去掉 query/hash 后指向同目录下的 index.html，再拼上 channel 参数。
  const base = location.href.split("?")[0].split("#")[0]
    .replace(/[^/]*$/, "");   // 去掉文件名，保留目录
  return base + "index.html" + "?channel=" + code;
}

async function initShare(code) {
  mode = "share";
  $("code").textContent = code;
  const link = shareLink(code);
  $("qrcode").src =
    "https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=" +
    encodeURIComponent(link);
  setShareStatus("正在建立点对点连接…", false);
  // 共享开始即显示「停止共享」按钮，随时可退出（无需等好友连接）
  $("stopBtn").style.display = "block";

  try {
    signaling = await connectSignaling("hereiam:" + code, onSignalShare);
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
  // 接收好友的音频轨道（语音对讲）
  if (voice) pc.ontrack = (e) => { try { voice.handleRemoteTrack(e); } catch (err) {} };
  dc = pc.createDataChannel("location");
  dc.onopen = () => {
    // 连接建立后把自己的资料（用户名+头像）推送给好友端
    sendMyProfile();
    startLocationStream();
    // 新连接：重置语音状态并亮出对讲按钮
    if (voice) { try { voice.reset(); } catch (e) {} }
    showVoice();
  };
  // 双向共享：接收查看者（安卓 App）回传的位置/资料，在地图上显示（对称协议：收到 WGS-84，转 GCJ-02 显示）
  dc.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m && m.type === "profile") {
      setDriverProfile(m.name, m.avatar);
    } else if (m && m.type === "voice") {
      // 语音对讲控制消息（静音/说话中/关闭）
      if (voice) { try { voice.handleControl(m); } catch (e) {} }
    } else if (m && m.lat !== undefined) {
      onLocation(m);
    }
  };

  pc.onicecandidate = (e) => {
    if (e.candidate && signaling)
      signaling.send({ type: "candidate", candidate: e.candidate, id: friendId });
  };
  pc.onconnectionstatechange = () => {
    if (!pc) return;
    const s = pc.connectionState;
    if (s === "connected") {
      setShareStatus("已点对点直连，正在实时上报位置", true);
      setIndicator(true);
      $("stopBtn").style.display = "block";
      showVoice(); // 点对点直连后才显示语音对讲入口
    } else if (s === "failed" || s === "disconnected") {
      setShareStatus("连接断开，等待好友重新加入…", false);
      setIndicator(false);
      hideVoice();
    }
  };

  (async () => {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (signaling) signaling.send({ type: "offer", sdp: offer, id: friendId });
  })();
}

async function onSignalShare(msg) {
  if (msg.type === "join") {
    // 好友加入/重连：重建连接并发 offer
    if (pc && pc.connectionState !== "failed" && pc.connectionState !== "closed") return;
    createConnection();
  } else if (msg.type === "answer") {
    if (pc) {
      try { await pc.setRemoteDescription(msg.sdp); } catch (e) {}
    }
  } else if (msg.type === "offer") {
    // 连接已建立时收到的 offer = 好友发起的语音重协商 → 就地应答
    if (pc && pc.connectionState === "connected" && pc.signalingState === "stable") {
      await answerVoiceRenegotiation(voice, pc, signaling, msg.sdp, function (o) {
        if (o) o.id = friendId; // 应答须带本端 friendId，安卓端认得出路由
        if (signaling) { try { signaling.send(o); } catch (e) {} }
      });
    }
  } else if (msg.type === "candidate") {
    if (pc) { try { await pc.addIceCandidate(msg.candidate); } catch (e) {} }
  } else if (msg.type === "leave" || msg.type === "bye") {
    setShareStatus("好友已退出查看", false);
    // 好友退出：立即移除其定位标（避免残留最后位置在地图上）并自动跳回自己
    if (voice) { try { voice.reset(); } catch (e) {} }
    removeDriverMarker();
    revertToMe();
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
        // 记录定位时间：信号看门狗据此判定「定位信号不佳」（5 秒无新位置 → 灰色）
        lastFixTime = Date.now();
        myGray = false;
        // 定位恢复 → 自己的定位标转回蓝色（未创建前标记在 updateMyMarker 里应用）
        if (myMarker) setMyLocated(false);
        // 方向：指南针优先（实时、静止也转）；无指南针时退回 GPS 行进方向
        let heading = deviceHeading != null
          ? Math.round(deviceHeading)
          : (pos.coords.heading != null ? Math.round(pos.coords.heading) : null);
        myPos = {
          type: "loc",   // 携带类型，安卓端/好友端统一按 type=="loc" 解析
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          heading: heading,
          acc: Math.round(pos.coords.accuracy || 0),
          t: Date.now(),
          gray: myGray,
        };
        // 地图上更新自己的水滴定位标
        updateMyMarker();
        // 双向共享：数据通道打开时把自己的位置实时回传对方
        // （对称协议：一律携带 type:"loc"，发送 WGS-84，接收端统一转 GCJ-02；含 gray 字段）
        if (dc && dc.readyState === "open") {
          dc.send(JSON.stringify(myPos));
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

// ========== 定位信号看门狗（同安卓端）==========
// 持续 5 秒无新位置 → 判定定位信号不佳，把自己的定位标置灰并回传灰色给对端。
// 灰色时指南针(initCompass)仍在持续回传朝向（sendMyLocationNow 每 500ms 一次），
// 因此灰色只影响定位标颜色，不影响朝向指针转动；恢复定位后立即转回蓝色。
function startGrayWatchdog() {
  setInterval(() => {
    if (!myPos || lastFixTime <= 0) return;
    if (!myGray && Date.now() - lastFixTime > 5000) {
      myGray = true;
      myPos.gray = true;
      // 自己的定位标同步变灰（灰不影响朝向指针转动，指针仍按指南针旋转）
      setMyLocated(true);
      // 变灰瞬间回传一次灰色定位（含最后位置 + 当前朝向），对方同步显示灰色定位标
      sendMyLocationNow();
    }
  }, 3000);
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
    myAvatarImg = created.avatarImg;
    myGlow = created.glowPath;
    myPtr = created.ptrPath;
    myDisc = created.discPath;
    myWdp = created.wdp;
    myStroke = created.strokeCircle;
    map.add(myMarker);
    setMyLocated(myGray);
    applyMyAvatar();   // 自己的定位标显示头像（同安卓端），无头像则保持蓝圆盘
    // 首次定位成功后自动把地图焦点移到当前位置
    if (!myHasCentered) { myHasCentered = true; map.setCenter(pos); }
  } else {
    myMarker.setPosition(pos);
    updateArrowG(myArrowG, myPos.heading);   // 方向跟随自己时恒朝上，否则按 heading+旋转补偿
    setMyLocated(myGray);
  }
  // 跟随自己：位置真正变化时自动居中（保留当前缩放，总览模式下暂停，同安卓 App）
  if (followTarget === "me" && !overviewMode) {
    if (!lastFollowCenter ||
        Math.abs(pos.lng - lastFollowCenter.lng) > 1e-7 ||
        Math.abs(pos.lat - lastFollowCenter.lat) > 1e-7) {
      lastFollowCenter = { lng: pos.lng, lat: pos.lat };
      map.setCenter(pos);
    }
  }
}

// ============================================================
//  定位按钮（右下角）：点击循环切换「聚焦正北」/「方向跟随」/「总览正北」（同安卓 App）
//  点击①聚焦正北：居中到选中的人 + 放大 + 朝正北
//  点击②方向跟随：居中到选中的人 + 放大 + 目标朝向朝上（持续同步地图旋转）
//  点击③总览正北：缩小显示所有人（自己+对端好友）+ 朝正北
//  注意：聚焦/总览/方向跟随都不改变用户选择框的选中项（followTarget 仅由选择器修改）
// ============================================================
// ========== 定位键图标：十字准星 ↔ 水滴标（方向跟随模式） ==========
// 十字准星（聚焦/总览模式，同 App）
const LOCATE_ICON_CROSS =
  '<svg viewBox="0 0 24 24" fill="none" stroke="#4b3fe3" stroke-width="2" stroke-linecap="round">' +
  '<circle cx="12" cy="12" r="6"/>' +
  '<circle cx="12" cy="12" r="2" fill="#4b3fe3" stroke="none"/>' +
  '<line x1="12" y1="1.5" x2="12" y2="5"/>' +
  '<line x1="12" y1="19" x2="12" y2="22.5"/>' +
  '<line x1="1.5" y1="12" x2="5" y2="12"/>' +
  '<line x1="19" y1="12" x2="22.5" y2="12"/>' +
  '</svg>';
// 水滴标（方向跟随模式：蓝圆盘+白缝+外凸水滴箭头朝正北，同地图定位标画法；白缝深色模式下改黑色）
function buildLocateIconWaterdrop() {
  return (
  '<svg viewBox="0 0 24 24" fill="none">' +
  '<path d="M13 1 L19.02 9.53 A6.95 6.95 0 1 1 6.98 9.53 Z" fill="none" stroke="#2F86F6" stroke-opacity="0.28" stroke-width="1.3"/>' +
  '<path d="M13 1 L19.02 9.53 A6.95 6.95 0 1 1 6.98 9.53 Z" fill="' + markerBorderColor() + '"/>' +
  '<path d="M13 1 L18.2 10 L7.8 10 Z" fill="#2F86F6"/>' +
  '<circle cx="13" cy="13" r="6" fill="#2F86F6"/>' +
  '<circle cx="13" cy="13" r="6" fill="none" stroke="' + markerBorderColor() + '" stroke-width="1.2"/>' +
  '</svg>'
  );
}

// 根据当前定位键状态刷新图标：locStep=1（方向跟随）显示水滴标，其余显示十字准星
function setLocateIcon() {
  const btn = $("locateBtn");
  if (!btn) return;
  btn.innerHTML = locStep === 1 ? buildLocateIconWaterdrop() : LOCATE_ICON_CROSS;
}

function onLocateClick() {
  if (!map) return;
  locStep = (locStep + 1) % 3;
  if (locStep === 0) {
    // 聚焦正北：将选中的人居中放大 + 地图调回正北
    followDirection = false;
    overviewMode = false;
    let target = null;
    if (followTarget === "friend" && driverMarker) {
      target = driverMarker.getPosition();
    } else if (myPos) {
      const [lng, lat] = wgs84ToGcj02(myPos.lng, myPos.lat);
      target = new AMap.LngLat(lng, lat);
    }
    if (target) {
      setCameraNorth(17, target); // 同安卓 FOCUS_ZOOM=17
    }
  } else if (locStep === 1) {
    // 方向跟随：居中放大 + 目标朝向朝上（后续由 updateDirectionFollow 持续同步旋转）
    followDirection = true;
    overviewMode = false;
    directionFollowSince = Date.now(); // 短暂延迟后再接管旋转，避免打断居中动画
    let target = null;
    if (followTarget === "friend" && driverMarker) {
      target = driverMarker.getPosition();
    } else if (myPos) {
      const [lng, lat] = wgs84ToGcj02(myPos.lng, myPos.lat);
      target = new AMap.LngLat(lng, lat);
    }
    if (target) {
      const h = getDirectionHeading();
      const rot = h != null ? (360 - h) % 360 : 0;
      if (typeof map.setTilt === "function") map.setTilt(0);
      if (typeof map.setZoomAndCenter === "function") {
        map.setZoomAndCenter(17, target);
      } else {
        if (map.setCenter) map.setCenter(target);
        if (map.setZoom) map.setZoom(17);
      }
      rotateMapShortest(rot, 300); // 最短路径旋转到「目标朝向朝上」，避免绕大圈
      refreshAllArrows(); // 进入方向跟随立即刷新箭头：目标指针 = heading + rotation = 0（朝上）
    }
  } else {
    // 总览正北：缩小显示全部 + 地图调回正北（不改变 followTarget，让用户选择框保持选中状态）
    followDirection = false;
    overviewMode = true;
    fitAllPositions(); // 内部已复位正北
  }
  setLocateIcon(); // 方向跟随（locStep=1）显示水滴标，其余显示十字准星
}

// 方向跟随用：获取选中目标的最新朝向（自己=手机朝向/指南针；对端=对端回传朝向，兜底用指南针）
function getDirectionHeading() {
  if (followTarget === "friend" && driverMarker) {
    if (driverHeading != null) return driverHeading;
    if (deviceHeading != null) return deviceHeading;
    return null;
  }
  if (deviceHeading != null) return deviceHeading;
  if (myPos && myPos.heading != null) return myPos.heading;
  return null;
}

// ========== 地图旋转工具（最短路径 + 固定时长动画） ==========
// 高德 setRotation(rot) 默认按「绝对值差」线性动画，角度差>180° 时会绕一大圈且动画时长
// 由内部自动计算（偏长）。这里用手动 rAF 补间：只旋转最短角度差，固定 300ms，平滑不绕圈。
let rotAnimId = null;         // 旋转补间 rAF id
let rotAnimFrom = 0;          // 起始旋转角
let rotAnimDelta = 0;         // 最短有符号角度差（-180, 180]

// 地图当前旋转角「权威值」：程序旋转时与本变量同步更新；手动旋转由 rotating/rotate 事件同步。
// 定位标是屏幕方向的 HTML 覆盖物，不随地图旋转，指针角度 = heading + 地图旋转角，
// 因此必须用本权威值（而不是 getRotation()，它可能不即时反映 setRotation）保证指针与地图方向严格一致。
let currentMapRot = 0;

function syncMapRotFromMap() {
  if (map && typeof map.getRotation === "function") {
    currentMapRot = ((map.getRotation() || 0) % 360 + 360) % 360;
  }
  return currentMapRot;
}

function setMapRot(rot) {
  const r = ((rot % 360) + 360) % 360;
  if (map && map.setRotation) map.setRotation(r, true); // 先瞬时旋转地图
  currentMapRot = r; // 再写权威值（即使旋转事件已异步同步，也以本目标值为准）
  return currentMapRot;
}

function cancelRotAnim() {
  if (rotAnimId) { cancelAnimationFrame(rotAnimId); rotAnimId = null; }
}

/**
 * 最短路径旋转：把地图旋转角平滑过渡到 target（[0,360)），默认 300ms。
 * 计算当前角与目标角的最小有符号差，沿最短方向旋转，避免高德绕大圈。
 */
function rotateMapShortest(targetRot, duration) {
  if (!map || typeof map.setRotation !== "function") return;
  cancelRotAnim();
  const cur = currentMapRot; // 用权威值，避免 getRotation() 延迟
  const target = ((targetRot % 360) + 360) % 360;
  let delta = target - cur;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  if (Math.abs(delta) < 0.01) { setMapRot(target); refreshAllArrows(); return; } // 已到位
  const dur = (typeof duration === "number" && duration > 0) ? duration : 300;
  const start = performance.now();
  rotAnimFrom = cur;
  rotAnimDelta = delta;
  const step = (now) => {
    const t = Math.min(1, (now - start) / dur);
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; // easeInOutCubic
    const angle = ((rotAnimFrom + rotAnimDelta * e) % 360 + 360) % 360;
    setMapRot(angle); // 同步权威值 + 旋转地图
    refreshAllArrows(); // 每帧刷新指针，与地图旋转严格同步
    if (t < 1) {
      rotAnimId = requestAnimationFrame(step);
    } else {
      rotAnimId = null;
      setMapRot(rotAnimFrom + rotAnimDelta); // 精确落位
      refreshAllArrows();
    }
  };
  rotAnimId = requestAnimationFrame(step);
}

// 方向跟随：把地图旋转到「目标朝向朝上」（map.setRotation 为顺时针，heading 为逆时针 → 用 360-heading）
function updateDirectionFollow() {
  if (!map || !followDirection) return;
  if (Date.now() - directionFollowSince < 700) return; // 等待「居中+旋转」动画播完，同安卓端 700ms
  cancelRotAnim(); // 接管前取消任何残留的补间动画
  const h = getDirectionHeading();
  if (h == null) return;
  const rot = (360 - h) % 360;
  setMapRot(rot); // 同步权威值 + 瞬时旋转（50ms 一轮已足够平滑）
  refreshAllArrows(); // 旋转后立即刷新箭头：方向跟随下目标指针 = heading + rotation = 0（朝上）
}

// 方向跟随持续循环：每 50ms 同步一次地图旋转 + 刷新箭头（仅 followDirection=true 时生效）
setInterval(updateDirectionFollow, 50);

// 聚焦/总览都带「朝正北」：同时设置中心、缩放、朝向归零（旋转走最短路径快速回正）
function setCameraNorth(zoom, center) {
  if (!map) return;
  if (typeof map.setTilt === "function") map.setTilt(0);
  if (typeof map.setZoomAndCenter === "function") {
    map.setZoomAndCenter(zoom, center);
  } else {
    if (map.setCenter) map.setCenter(center);
    if (map.setZoom) map.setZoom(zoom);
  }
  rotateMapShortest(0, 300); // 最短路径快速回正北
  refreshAllArrows(); // 复位正北后刷新箭头（rotation 归零）
}

// 总览：把所有位置点纳入视野（自己 + 对端好友），并保证恢复正北（同安卓 App）
function fitAllPositions() {
  if (!map) return;
  const mks = [];
  if (myMarker) mks.push(myMarker);
  if (driverMarker) mks.push(driverMarker);
  if (mks.length === 0) {
    locStep = 0; // 无任何位置，退回聚焦态
    setLocateIcon();
    return;
  }
  if (mks.length === 1) {
    setCameraNorth(14, mks[0].getPosition());
    return;
  }
  // 多人：先复位正北再适配视野（setFitView/setBounds 会保留当前旋转角，必须先归零）
  resetMapNorth();
  if (typeof map.setFitView === "function") {
    map.setFitView(mks, false, [90, 90, 140, 90]);
  } else {
    // 高德 1.4 降级：用包含所有点的包围盒
    const b = new AMap.Bounds(mks[0].getPosition(), mks[0].getPosition());
    mks.forEach((mk) => b.extend(mk.getPosition()));
    map.setBounds(b);
  }
}

// 复位朝北：rotation/tilt 归零（走最短路径快速回正，保留当前中心与缩放）
function resetMapNorth() {
  if (!map) return;
  if (typeof map.setTilt === "function") map.setTilt(0);
  rotateMapShortest(0, 300); // 最短路径快速回正北
  refreshAllArrows(); // 复位正北后刷新箭头（rotation 归零）
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
    signaling = await connectSignaling("hereiam:" + code, onSignalView);
    setViewStatus("等待好友分享…", false);
    signaling.send({ type: "join", id: friendId });
    startJoinTimer();
    updateUserSelector();   // 进入查看模式 → 显示「停止查看」项
  } catch (e) {
    setViewStatus("信令连接失败，请检查网络", false);
  }
}

// 停止查看：断开连接、移除好友定位标、回到空闲
function stopView() {
  mode = "idle";
  viewCode = null;
  if (joinTimer) { clearInterval(joinTimer); joinTimer = null; }
  // 关闭语音对讲
  if (voice) { try { voice.disable(); } catch (e) {} }
  hideVoice();
  if (pc) { try { pc.close(); } catch (e) {} pc = null; dc = null; }
  if (signaling) { try { signaling.close(); } catch (e) {} signaling = null; }
  removeDriverMarker();
  setIndicator(false);
  setViewStatus("已停止查看", false);
  $("viewPanel").style.display = "none";
  hideOverlay();
  // 停止查看 → 自动跳回自己并刷新选择器（同安卓 App）
  revertToMe();
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
    // 连接已建立且 stable 时收到的 offer = 对方发起的语音重协商 → 就地应答；
    // 否则是全新的位置共享连接 offer → 走正常建连
    if (pc && pc.connectionState === "connected" && pc.signalingState === "stable") {
      await answerVoiceRenegotiation(voice, pc, signaling, msg.sdp, function (o) {
        if (o) o.id = friendId; // 应答须带本端 friendId，安卓端认得出路由
        if (signaling) { try { signaling.send(o); } catch (e) {} }
      });
    } else {
      await handleOffer(msg.sdp);
    }
  } else if (msg.type === "answer") {
    // 我方发起语音重协商后，对方返回 answer → 应用远端描述
    if (pc) { try { await pc.setRemoteDescription(msg.sdp); } catch (e) {} }
  } else if (msg.type === "candidate") {
    if (pc) { try { await pc.addIceCandidate(msg.candidate); } catch (e) {} }
  } else if (msg.type === "bye") {
    setViewStatus("对方已结束共享，可关闭", false);
    setIndicator(false);
    mode = "idle";
    viewCode = null;
    if (joinTimer) { clearInterval(joinTimer); joinTimer = null; }
    if (voice) { try { voice.reset(); } catch (e) {} }
    hideVoice();
    if (pc) { try { pc.close(); } catch (e) {} pc = null; dc = null; }
    removeDriverMarker();
    // 对方结束共享 → 自动跳回自己并刷新选择器
    revertToMe();
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
  driverHeading = null;   // 清除对端朝向缓存（方向跟随用）
  driverGlow = null;
  driverPtr = null;
  driverDisc = null;
  driverWdp = null;
  driverStroke = null;
  hasCentered = false;
}

async function handleOffer(offer) {
  if (pc) { try { pc.close(); } catch (e) {} }
  pc = new RTCPeerConnection({ iceServers: CONFIG.stunServers });
  // 接收分享者的音频轨道（语音对讲）
  if (voice) pc.ontrack = (e) => { try { voice.handleRemoteTrack(e); } catch (err) {} };
  pc.onicecandidate = (e) => {
    if (e.candidate && signaling)
      signaling.send({ type: "candidate", candidate: e.candidate, id: friendId });
  };
  pc.ondatachannel = (e) => {
    dc = e.channel;
    dc.onopen = () => {
      // 连接建立后把自己的资料（用户名+头像）推送给分享者（安卓端显示）
      sendMyProfile();
      // 新连接：重置语音状态并亮出对讲按钮
      if (voice) { try { voice.reset(); } catch (e) {} }
      showVoice();
    };
    dc.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m && m.type === "profile") {
        setDriverProfile(m.name, m.avatar);
      } else if (m && m.type === "voice") {
        // 语音对讲控制消息（静音/说话中/关闭）
        if (voice) { try { voice.handleControl(m); } catch (e) {} }
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
      showVoice(); // 点对点直连后才显示语音对讲入口
    } else if (st === "disconnected" || st === "failed") {
      setViewStatus("连接中断，正在自动重连…", false);
      setIndicator(false);
      hideVoice();
      startJoinTimer();
    }
  };
  await pc.setRemoteDescription(offer);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  signaling.send({ type: "answer", sdp: answer, id: friendId });
}

// 收到分享者位置（WGS-84）→ 转 GCJ-02 后在地图上显示水滴标记
function onLocation(m) {
  const [lng, lat] = wgs84ToGcj02(m.lng, m.lat);
  showDriverAt(new AMap.LngLat(lng, lat), m.heading, !!m.gray);
}

// 在地图上放置/更新对方定位标（对方 = 被查看的分享者 或 查看者）
// @param gray true=对方定位信号不佳（灰色定位标），false=已精确定位（蓝色）；灰色时指针仍按 heading 转动
function showDriverAt(pos, heading, gray) {
  if (!map) return;
  // 记录对端最新朝向（方向跟随用，实时更新）
  if (heading != null) driverHeading = heading;
  if (!driverMarker) {
    const created = createDriverMarker(pos, heading);
    driverMarker = created.marker;
    driverArrowG = created.arrowG;
    driverAvatarImg = created.avatarImg;
    driverNameEl = created.nameEl;
    driverGlow = created.glowPath;
    driverPtr = created.ptrPath;
    driverDisc = created.discPath;
    driverWdp = created.wdp;
    driverStroke = created.strokeCircle;
    map.add(driverMarker);
    setDriverLocated(gray);
    // 若资料在位置之前到达，此处补上名字/头像
    applyDriverProfile();
    if (!hasCentered) { hasCentered = true; map.setCenter(pos); }
  } else {
    driverMarker.setPosition(pos);
    updateArrowG(driverArrowG, heading);   // 方向跟随对端时恒朝上，否则按 heading+旋转补偿
    setDriverLocated(gray);
  }
  // 跟随好友：位置更新自动居中（保留当前缩放，总览模式下暂停，同安卓 App）
  if (followTarget === "friend" && !overviewMode) {
    if (!lastFollowCenter ||
        Math.abs(pos.lng - lastFollowCenter.lng) > 1e-7 ||
        Math.abs(pos.lat - lastFollowCenter.lat) > 1e-7) {
      lastFollowCenter = { lng: pos.lng, lat: pos.lat };
      map.setCenter(pos);
    }
  }
  // 对端定位标出现/更新时刷新用户选择器（好友项名字/头像/勾选态）
  updateUserSelector();
}

// ============================================================
//  水滴定位标（固定圆盘 + 旋转指针，同安卓端）
// ============================================================
function createDriverMarker(pos, heading) {
  const content = document.createElement("div");
  content.style.cssText = "width:" + M_SVG_W + "px;height:" + M_SVG_H + "px;position:relative;";
  content.innerHTML =
    '<svg width="' + M_SVG_W + '" height="' + M_SVG_H + '" viewBox="0 0 ' + M_SVG_W + " " + M_SVG_H + '" style="position:absolute;inset:0;">' +
    '<defs><filter id="glowF" x="-80%" y="-80%" width="260%" height="260%">' +
    '<feGaussianBlur stdDeviation="' + (2.2 * M_SCALE).toFixed(2) + '"/></filter></defs>' +
    '<g id="arrowG" transform="rotate(' + (markerArrowAngle(heading) || 0) + " " + M_CX + " " + M_CY + ')">' +
    '<path id="glowPath" d="' + buildWaterdropPathD(M_R_WHITE) + '" fill="none" stroke="rgba(47,134,246,0.28)" stroke-width="' + (5 * M_SCALE).toFixed(2) + '" stroke-linejoin="round" filter="url(#glowF)"/>' +
    '<path id="wdPath" d="' + buildWaterdropPathD(M_R_WHITE) + '" fill="' + markerBorderColor() + '"/>' +
    '<path id="ptrPath" d="' + buildPointerPathD() + '" fill="rgba(47,134,246,0.96)"/>' +
    "</g>" +
    '<circle id="discPath" cx="' + M_CX + '" cy="' + M_CY + '" r="' + M_R.toFixed(2) + '" fill="rgba(47,134,246,0.96)"/>' +
    // 分享者头像（覆盖在圆盘上，圆形裁剪）
    '<clipPath id="avatarClip"><circle cx="' + M_CX + '" cy="' + M_CY + '" r="' + M_AVATAR_R.toFixed(2) + '"/></clipPath>' +
    '<image id="avatarImg" x="' + (M_CX - M_AVATAR_R).toFixed(2) + '" y="' + (M_CY - M_AVATAR_R).toFixed(2) +
    '" width="' + (M_AVATAR_R * 2).toFixed(2) + '" height="' + (M_AVATAR_R * 2).toFixed(2) +
    '" clip-path="url(#avatarClip)" style="display:none;pointer-events:none;"/>' +
    // 5. 初始圆的白色轮廓（白色圆周线，分隔圆盘与指针；有头像时隐藏，白边由头像外圈提供；深色模式下改黑色）
    '<circle id="avatarStroke" cx="' + M_CX + '" cy="' + M_CY + '" r="' + M_R.toFixed(2) + '" fill="none" stroke="' + markerBorderColor() + '" stroke-width="' + M_WHITE_BORDER.toFixed(2) + '"/>' +
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
  // 白色外轮廓水滴 path + 白色圆周线 circle（深浅色切换时更新颜色）
  const wdp = content.querySelector("#wdPath");
  const strokeCircle = content.querySelector("#avatarStroke");
  return {
    marker,
    arrowG: content.querySelector("#arrowG"),
    avatarImg: content.querySelector("#avatarImg"),
    nameEl: nameEl,
    glowPath: content.querySelector("#glowPath"),
    ptrPath: content.querySelector("#ptrPath"),
    discPath: content.querySelector("#discPath"),
    wdp, strokeCircle,
  };
}

// 切换对端定位标颜色（蓝/灰与对端定位信号状态同步）
// 蓝色 rgba(47,134,246,…)（高德定位指针），灰色 rgba(154,163,175,…)（与安卓 #9AA3AF 一致）
function setDriverLocated(gray) {
  const rgb = gray ? "154,163,175" : "47,134,246";
  if (driverGlow) driverGlow.setAttribute("stroke", "rgba(" + rgb + ",0.28)");
  if (driverPtr) driverPtr.setAttribute("fill", "rgba(" + rgb + ",0.96)");
  if (driverDisc) driverDisc.setAttribute("fill", "rgba(" + rgb + ",0.96)");
}

// 切换自己定位标颜色（蓝/灰与自己的定位信号状态同步；灰不影响朝向指针转动）
function setMyLocated(gray) {
  const rgb = gray ? "154,163,175" : "47,134,246";
  if (myGlow) myGlow.setAttribute("stroke", "rgba(" + rgb + ",0.28)");
  if (myPtr) myPtr.setAttribute("fill", "rgba(" + rgb + ",0.96)");
  if (myDisc) myDisc.setAttribute("fill", "rgba(" + rgb + ",0.96)");
}

// 应用自己的头像到自己的水滴定位标（同安卓端：头像覆盖在蓝色圆盘上）
function applyMyAvatar() {
  if (!myAvatarImg) return;
  const avatarData = getUserAvatar();
  if (avatarData) {
    // 同时设置 href 与 xlink:href，兼容新旧浏览器
    myAvatarImg.setAttribute("href", avatarData);
    myAvatarImg.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", avatarData);
    myAvatarImg.style.display = "block";
  }
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
    // 头像外圈白色圆周线保持显示（与水滴外轮廓同宽），与经典模式大小一致
  }
}

// 显示分享者资料（数据通道推送的 profile 消息）
function setDriverProfile(name, dataUrl) {
  if (name) driverName = name;
  if (dataUrl) driverAvatarData = dataUrl;
  applyDriverProfile();
  updateUserSelector();   // 资料到达后刷新用户选择器里好友项的名字/头像
}

// ============================================================
//  顶部用户选择器（同安卓 App）：选择「我」/「对端好友」使其位置保持居中
// ============================================================
function initUserSelector() {
  const selector = $("userSelector");
  const menu = $("usMenu");
  if (!selector || !menu) return;
  selector.addEventListener("click", (e) => {
    e.stopPropagation();
    menu.style.display = menu.style.display === "block" ? "none" : "block";
  });
  document.addEventListener("click", () => { menu.style.display = "none"; });

  // 我
  $("usItemMe").addEventListener("click", (e) => {
    e.stopPropagation();
    followTarget = followTarget === "me" ? null : "me";
    overviewMode = false;
    followDirection = false;   // 选择某人即退出方向跟随（同安卓端）
    locStep = 0;               // 定位键回到聚焦态
    setLocateIcon();
    if (followTarget === "me" && myPos) {
      const [lng, lat] = wgs84ToGcj02(myPos.lng, myPos.lat);
      map.setZoomAndCenter(16, new AMap.LngLat(lng, lat));
    }
    updateUserSelector();
    menu.style.display = "none";
  });

  // 对端好友（地图上显示的分享者/查看者）
  $("usItemFriend").addEventListener("click", (e) => {
    e.stopPropagation();
    if (!driverMarker) return;
    followTarget = followTarget === "friend" ? null : "friend";
    overviewMode = false;
    followDirection = false;   // 选择某人即退出方向跟随（同安卓端）
    locStep = 0;               // 定位键回到聚焦态
    setLocateIcon();
    if (followTarget === "friend") {
      map.setZoomAndCenter(16, driverMarker.getPosition());
    }
    updateUserSelector();
    menu.style.display = "none";
  });

  // 停止查看
  $("usItemStop").addEventListener("click", (e) => {
    e.stopPropagation();
    if (mode !== "view") return;
    stopView();
    menu.style.display = "none";
  });
}

// 刷新用户选择器：显示框（名字/头像）、勾选态、菜单项可见性
function updateUserSelector() {
  const selector = $("userSelector");
  const menu = $("usMenu");
  if (!selector || !menu) return;
  // 显示框：头像 + 名字
  if (followTarget === "friend" && driverMarker) {
    $("usName").textContent = driverName || "好友";
    renderCircleAvatar($("usAvatar"), driverAvatarData, (driverName || "好").slice(0, 1));
  } else {
    $("usName").textContent = "我";
    renderCircleAvatar($("usAvatar"), userProfile.avatar, userProfile.name.slice(0, 1));
  }
  // 勾选状态
  $("usCheckMe").textContent = followTarget === "me" ? "✓" : "";
  $("usCheckFriend").textContent = followTarget === "friend" && driverMarker ? "✓" : "";
  // 菜单项可见性：有对端定位标才显示「好友」；查看模式才显示「停止查看」
  $("usItemFriend").style.display = driverMarker ? "flex" : "none";
  $("usItemStop").style.display = mode === "view" ? "flex" : "none";
  // 菜单项里的头像/名字
  renderCircleAvatar($("usAvMe"), userProfile.avatar, userProfile.name.slice(0, 1));
  $("usTxtMe").textContent = "我";
  renderCircleAvatar($("usAvFriend"), driverAvatarData, (driverName || "好").slice(0, 1));
  $("usTxtFriend").textContent = driverName || "好友";
}

// 圆形头像：有头像用背景图，无头像显示首字符
function renderCircleAvatar(el, dataUrl, fallbackChar) {
  if (!el) return;
  if (dataUrl) {
    el.style.backgroundImage = "url('" + dataUrl + "')";
    el.style.backgroundSize = "cover";
    el.style.backgroundPosition = "center";
    el.textContent = "";
  } else {
    el.style.backgroundImage = "";
    el.textContent = fallbackChar || "?";
  }
}

// 对端退出 / 停止查看：自动跳回「我」并居中（同安卓 App 的 revertToMe）
function revertToMe() {
  followTarget = "me";
  overviewMode = false;
  followDirection = false;   // 退出方向跟随（同安卓端 revertToMe）
  locStep = 0;               // 定位键回到聚焦态，下次点击从「放大」开始
  setLocateIcon();
  lastFollowCenter = null;
  if (myPos) {
    const [lng, lat] = wgs84ToGcj02(myPos.lng, myPos.lat);
    map.setCenter(new AMap.LngLat(lng, lat));
  }
  updateUserSelector();
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

// 定位标指针角度：heading + 地图当前旋转角 currentMapRot。
// marker 是屏幕方向的 HTML 覆盖物，不随地图旋转；地图旋转 r 度后真实朝向在屏幕上偏转 r 度，
// 因此指针要加回 r 才始终指向真实朝向（方向跟随里 rotation=(360-heading)，指针=heading+360-heading=0=朝上）
function markerArrowAngle(heading) {
  if (heading == null) return null;
  return (((heading + currentMapRot) % 360) + 360) % 360;
}

function updateArrowG(g, heading) {
  const a = markerArrowAngle(heading);
  if (g && a != null) {
    g.setAttribute("transform", "rotate(" + a + " " + M_CX + " " + M_CY + ")");
  }
}

// 地图旋转角度变化后立即刷新所有定位标箭头。
// marker 是屏幕方向的 HTML 覆盖物，不随地图旋转；指针角度必须 = heading + 地图顺时针旋转角
// 才能始终指向真实朝向（同安卓端 correctedPointerAngle：方向跟随下目标指针 = 0 = 朝上）。
function refreshAllArrows() {
  if (myPos && myPos.heading != null) updateArrowG(myArrowG, myPos.heading);
  if (driverHeading != null) updateArrowG(driverArrowG, driverHeading);
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

// 语音对讲按钮只在点对点连接建立后显示；断连/退出时隐藏
function showVoice() {
  const vb = $("voiceBtn");
  if (vb) vb.classList.add("ready");
}
function hideVoice() {
  const vb = $("voiceBtn");
  if (vb) vb.classList.remove("ready");
}

// ========== 指南针（设备朝向）：让方向指针实时指向手机朝向 ==========
// 关键：Android 用 deviceorientationabsolute 才能拿到「真北」绝对角度；
// iOS 用 deviceorientation 的 webkitCompassHeading（已是真北方位角）。
// 指南针可用时作为首选方向来源（同高德/安卓端），GPS 行进方向仅作兜底。
function initCompass() {
  if (typeof DeviceOrientationEvent === "undefined") return;
  const addListener = () => {
    // Android Chrome 需监听 deviceorientationabsolute（否则 alpha 是相对值，不是真北）
    const useAbsolute = "ondeviceorientationabsolute" in window;
    window.addEventListener(
      useAbsolute ? "deviceorientationabsolute" : "deviceorientation",
      (e) => {
        let deg = null;
        if (e.webkitCompassHeading !== undefined) {
          deg = e.webkitCompassHeading;     // iOS：真北方位角（0=北，顺时针）
        } else if (e.alpha !== null && e.alpha !== undefined) {
          deg = (360 - e.alpha) % 360;      // Android：alpha 相对真北，顺时针
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
        // 用指南针驱动自己的定位标指针旋转 + 定期回传方向（节流）
        if (myPos) {
          myPos.heading = Math.round(deviceHeading);
          const now = Date.now();
          if (now - lastCompassUpdate >= 80) {
            lastCompassUpdate = now;
            updateMyMarker();
          }
          if (now - lastCompassSend >= 500) {
            lastCompassSend = now;
            if (dc && dc.readyState === "open") sendMyLocationNow();
          }
        }
      },
      true
    );
  };
  if (DeviceOrientationEvent.requestPermission) {
    // iOS 13+：必须在用户手势中调用，首次点击页面任意处时请求
    const request = () => {
      DeviceOrientationEvent.requestPermission()
        .then((state) => {
          if (state === "granted") addListener();
        })
        .catch(() => {});
    };
    window.addEventListener("click", request, { once: true });
  } else {
    addListener();
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
// 用户中心修改资料后：刷新自己的定位标头像 + 重发 profile 给对端
onUserProfileChanged = function () {
  applyMyAvatar();
  sendMyProfile();
};

// 立即把当前自己的位置回传给对端（对称协议：一律发 WGS-84，接收端统一转 GCJ-02）
function sendMyLocationNow() {
  if (!dc || dc.readyState !== "open" || !myPos) return;
  if (mode === "share") {
    dc.send(JSON.stringify(myPos));   // 含 gray 字段
  } else if (mode === "view") {
    dc.send(JSON.stringify({
      type: "loc",
      lat: myPos.lat, lng: myPos.lng,
      heading: myPos.heading, acc: myPos.acc, t: Date.now(),
      gray: myPos.gray,
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
// 从分享链接自动进入查看模式：index.html?channel=口令
// 检测到 channel 参数时，填入口令并自动加入直连（无需手动输入）。
function autoJoinFromUrl() {
  try {
    const params = new URLSearchParams(location.search);
    const code = params.get("channel");
    if (code && /^\d{6}$/.test(code)) {
      $("viewCode").value = code;
      joinView();
    }
  } catch (e) { /* 忽略解析失败 */ }
}

function bindEvents() {
  $("hiaBtn").addEventListener("click", onHiaClick);
  $("overlay").addEventListener("click", hideAllPanels);
  $("locateBtn").addEventListener("click", onLocateClick);

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

// 语音对讲：创建控制器并绑定 UI（点对点连接后才显示按钮）
voice = createVoiceController(() => ({ pc: pc, dc: dc, signaling: signaling }));
voice.friendId = friendId; // 语音重协商 offer 须携带本端 friendId，安卓端才认得出并正确路由
bindVoiceUI(voice);

initMap();
bindEvents();
startMyLocation();   // 进入页面即自动定位，显示自己的定位标
startGrayWatchdog(); // 定位信号看门狗：无新位置 5 秒 → 置灰并回传灰色
renderUserEntry();   // 用户中心：左上角入口 + 改名/改头像
bindUserCenterEvents();
initUserSelector();  // 顶部用户选择器（同安卓 App）
updateUserSelector();// 初始默认选中「我」
initCompass();       // 指南针：静止时方向指针也转动
autoJoinFromUrl();   // 分享链接自动进入查看模式（index.html?channel=口令）
