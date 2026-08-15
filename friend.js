// ============================================================
//  好友端逻辑：接收 P2P 位置，在高德地图上实时显示
//  位置来自 WebRTC 数据通道（点对点），不经过任何服务器。
//  打开页面时发送 "join" 通知分享者，分享者据此建立连接。
//  功能：
//   1. 分享者位置显示为「圆形 + 方向箭头」实时定位标（随 heading 旋转）
//   2. 「定位分享者」按钮：把分享者位置放中心，并按分享者-好友距离动态缩放
// ============================================================

const $ = (id) => document.getElementById(id);
let pc = null;
let dc = null;
let signaling = null;
let joinTimer = null;
let map = null;
let driverMarker = null; // 分享者定位标
let driverArrowG = null; // 分享者定位标内的三角形指针(<g>)
let driverAvatarImg = null; // 分享者定位标内的头像(<image>)
let driverNameEl = null; // 分享者名字气泡
let driverAvatarData = null; // 分享者头像 data URL（marker 未创建前暂存）
let driverName = null; // 分享者用户名（marker 未创建前暂存）
let myMarker = null; // 好友自己位置（水滴 + 指南针指针）
let myArrowG = null; // 好友自己定位标内的方向指针(<g>)
// 好友自己定位标颜色元素（灰/蓝切换用）
let myGlow = null, myPtr = null, myDisc = null;
// 定位标白/黑边框元素（浅色=白外轮廓+白圆周线，深色=黑，随系统深浅色切换）
let driverWdp = null, driverStroke = null; // 分享者定位标
let myWdp = null, myStroke = null;         // 自己定位标
let myHasCentered = false;
let myPos = null; // 好友自己坐标(GCJ-02)
let myHeading = null; // 好友自己的方向（指南针/GPS 融合，静止也转）
let deviceHeading = null; // 设备指南针朝向
let lastArrowUpdate = 0; // 指南针刷新节流
let lastLocSend = 0; // 方向回传节流
let follow = false; // 是否跟随分享者（定位分享者模式）
// 自己定位信号状态：true=信号不佳（灰色定位标），false=已精确定位（蓝色）。
// 灰色时仍持续回传朝向（灰不影响手机朝向信号发送），信号恢复后自动转回蓝色。
let myGray = false;
let lastFixTime = 0; // 最后一次成功定位的时间戳（信号看门狗用）
// 分享者定位标颜色元素（灰/蓝切换用）
let driverGlow = null, driverPtr = null, driverDisc = null;

// 本好友会话的唯一 ID：分享者据此区分不同好友，支持多好友同时查看
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

// 深色模式边框色：白色外轮廓/圆周线在深色地图上改为黑色（与安卓端一致）
function markerBorderColor() {
  return (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches)
    ? "#000000"
    : "#ffffff";
}

// 深色模式：地图底图自动跟随系统（prefers-color-scheme）
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
    applyMapTheme();          // 首次按系统主题设置地图深色/浅色样式
    setupThemeListener();     // 系统主题变化时实时切换
    map.on("complete", () => setStatus("地图就绪，等待好友分享…"));
  };
  s.onerror = () => {
    $("#map").innerHTML =
      "<p style='padding:20px;color:#f43f5e'>高德地图加载失败：请检查 Key 及安全密钥</p>";
  };
  document.head.appendChild(s);
}

// ============================================================
//  分享者定位标：固定圆盘 + 旋转指针（水滴 = 圆的60°/300°切线围成）
//  —— 固定层：蓝色圆盘(初始圆内，预留头像位) + 白色圆周线，永不旋转
//  —— 旋转层：蓝色指针(圆外切线区域) + 白色外轮廓 + 蓝色发散光晕，
//            绕初始圆圆心整体旋转，指针尖端指向行进方向(heading)
//  角度：0°=北(朝上) / 90°=东 / 180°=南 / 270°=西，顺时针
//  几何规格（圆心 M_CX,M_CY）：
//    基础圆半径 r → 尖顶 = (cx, cy-2r)，切点 = (cx±r·cos30°, cy-r/2)
//    指针 = 尖顶与两切点围成的三角形（圆外部分），底边与圆相切
//    白色外轮廓 r_white = 25.5 (=R+W)，圆盘 r_blue = 22 (=R)
// ============================================================
const M_SCALE = 8 / 15;                   // 整体缩放因子（= 2/3 × 80%，缩小到上一版 80%）
const M_R = 22 * M_SCALE;                 // 圆半径 ≈ 7.33
const M_WHITE_BORDER = 3.5 * M_SCALE;     // 白边宽 ≈ 1.17
const M_AVATAR_R = M_R;                   // 头像半径 = 圆盘半径（头像外围白色轮廓与水滴外轮廓同宽）
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
    '<path id="glowPath" d="' + buildWaterdropPathD(M_R_WHITE) + '" fill="none" stroke="rgba(47,134,246,0.28)" stroke-width="' + (5 * M_SCALE).toFixed(2) + '" stroke-linejoin="round" filter="url(#glowF)"/>' +
    // 2. 白色底层水滴（r = R+W = 25.5，外圈白色轮廓，无灰色描边；深色模式下改黑色）
    '<path id="wdPath" d="' + buildWaterdropPathD(M_R_WHITE) + '" fill="' + markerBorderColor() + '"/>' +
    // 3. 蓝色指针（圆外切线区域：尖顶 + 两切点围成的三角形，随旋转层旋转）
    '<path id="ptrPath" d="' + buildPointerPathD() + '" fill="rgba(47,134,246,0.96)"/>' +
    "</g>" +
    // ========== 固定层（圆盘 + 白色圆周线，永不旋转，预留头像位）==========
    // 4. 蓝色圆盘（初始圆内区域，后续可放个性化头像）
    '<circle id="discPath" cx="' + M_CX + '" cy="' + M_CY + '" r="' + M_R.toFixed(2) + '" fill="rgba(47,134,246,0.96)"/>' +
    // 4b. 分享者头像（若有则覆盖在圆盘上，圆形裁剪）
    '<clipPath id="avatarClip"><circle cx="' + M_CX + '" cy="' + M_CY + '" r="' + M_AVATAR_R.toFixed(2) + '"/></clipPath>' +
    '<image id="avatarImg" x="' + (M_CX - M_AVATAR_R).toFixed(2) + '" y="' + (M_CY - M_AVATAR_R).toFixed(2) +
    '" width="' + (M_AVATAR_R * 2).toFixed(2) + '" height="' + (M_AVATAR_R * 2).toFixed(2) +
    '" clip-path="url(#avatarClip)" style="display:none;pointer-events:none;"/>' +
    // 5. 初始圆的白色轮廓（白色圆周线，分隔圆盘与指针；有头像时隐藏，白边由头像外圈提供；深色模式下改黑色）
    '<circle id="avatarStroke" cx="' + M_CX + '" cy="' + M_CY + '" r="' + M_R.toFixed(2) + '" fill="none" stroke="' + markerBorderColor() + '" stroke-width="' + M_WHITE_BORDER.toFixed(2) + '"/>' +
    "</svg>";

  const marker = new AMap.Marker({
    position: pos,
    content: content,
    // 让水滴圆心（原圆盘中心）对准坐标点
    offset: new AMap.Pixel(-M_CX, -M_CY),
    zIndex: 120,
  });
  // 分享者名字气泡（显示在地标上方，指向水滴尖端）
  const nameEl = document.createElement("div");
  nameEl.id = "driverName";
  nameEl.style.cssText =
    "position:absolute;top:-16px;left:50%;transform:translateX(-50%);" +
    "max-width:140px;padding:2px 8px;border-radius:10px;background:rgba(26,26,46,0.75);" +
    "color:#fff;font-size:11px;line-height:16px;white-space:nowrap;overflow:hidden;" +
    "text-overflow:ellipsis;display:none;pointer-events:none;";
  content.appendChild(nameEl);
  const arrowG = content.querySelector("#arrowG");
  const avatarImg = content.querySelector("#avatarImg");
  // 白色外轮廓水滴 path + 白色圆周线 circle（深浅色切换时更新颜色）
  const wdp = content.querySelector("#wdPath");
  const strokeCircle = content.querySelector("#avatarStroke");
  return {
    marker, arrowG, avatarImg, nameEl,
    glowPath: content.querySelector("#glowPath"),
    ptrPath: content.querySelector("#ptrPath"),
    discPath: content.querySelector("#discPath"),
    wdp, strokeCircle,
  };
}

// 切换分享者定位标颜色（蓝/灰与分享者定位信号状态同步）
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
}

// 把自己的资料（用户名 + 头像）推送给分享者，让分享者端显示我的名字/头像
function sendMyProfile() {
  if (!dc || dc.readyState !== "open") return;
  try {
    const p = getUserProfile();
    const msg = { type: "profile", name: p.name };
    if (p.avatar) msg.avatar = p.avatar;
    dc.send(JSON.stringify(msg));
  } catch (e) {}
}
// 用户中心修改资料后：重新推送
onUserProfileChanged = sendMyProfile;

// ========== 指南针（设备朝向）：让方向指针实时指向手机朝向 ==========
// 关键：Android 用 deviceorientationabsolute 才能拿到「真北」绝对角度；
// iOS 用 deviceorientation 的 webkitCompassHeading（已是真北方位角）。
// 指南针可用时作为首选方向来源，GPS 行进方向仅作兜底。
function initCompass() {
  if (typeof DeviceOrientationEvent === "undefined") return;
  const addListener = () => {
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
        if (myHeading != null) {
          let diff = deg - myHeading;
          if (diff > 180) diff -= 360;
          else if (diff < -180) diff += 360;
          myHeading = (myHeading + diff * 0.3 + 360) % 360;
        } else {
          myHeading = deg;
        }
        deviceHeading = myHeading;
        // 节流驱动自己定位标指针旋转 + 定期回传方向给分享者
        const now = Date.now();
        if (now - lastArrowUpdate >= 80) {
          lastArrowUpdate = now;
          updateMyArrow(myHeading);
        }
        if (now - lastLocSend >= 500) {
          lastLocSend = now;
          if (dc && dc.readyState === "open") sendMyLocation();
        }
      },
      true
    );
  };
  // iOS 13+ 必须在用户手势中调用，首次点击页面任意处时请求
  if (DeviceOrientationEvent.requestPermission) {
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

// 更新自己定位标的方向指针（与分享者定位标同规格）
function updateMyArrow(heading) {
  if (myArrowG && heading != null) {
    myArrowG.setAttribute(
      "transform",
      "rotate(" + heading + " " + M_CX + " " + M_CY + ")"
    );
  }
}

// ============================================================
//  好友自己的位置（用于计算分享者-好友距离做动态缩放 + 双向共享）
//  用 watchPosition 持续监听：不仅拿到首次定位，还会随移动持续更新，
//  并通过数据通道实时回传给分享者（分享者首页地图同步显示好友位置）。
//  好友可拒绝定位：拒绝则退化为固定缩放、不再回传位置。
// ============================================================
let locationWatchId = null;
let myPosWgs = null; // 自己坐标（WGS-84 原始值，对称协议：回传时统一发 WGS-84）
function locateMe() {
  if (!navigator.geolocation) return;
  let retries = 0;
  const startWatch = () => {
    locationWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        retries = 0;
        // 记录定位时间：信号看门狗据此判定「定位信号不佳」（5 秒无新位置 → 灰色）
        lastFixTime = Date.now();
        myGray = false;
        // 定位恢复 → 自己的定位标转回蓝色（未创建前标记在创建时应用）
        if (myMarker) setMyLocated(false);
        myPosWgs = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        const [lng, lat] = wgs84ToGcj02(pos.coords.longitude, pos.coords.latitude);
        myPos = new AMap.LngLat(lng, lat);
        // 方向：指南针优先（实时、静止也转）；指南针未就绪时退回 GPS 行进方向
        if (deviceHeading == null && pos.coords.heading != null) {
          myHeading = Math.round(pos.coords.heading);
        }
        if (!map) return;
        if (!myMarker) {
          // 自己的定位标：水滴 + 指南针指针（与安卓端一致）
          const created = createDriverMarker(myPos, myHeading || 0);
          myMarker = created.marker;
          myArrowG = created.arrowG;
          myGlow = created.glowPath;
          myPtr = created.ptrPath;
          myDisc = created.discPath;
          myWdp = created.wdp;
          myStroke = created.strokeCircle;
          map.add(myMarker);
          setMyLocated(myGray);
          if (!myHasCentered) { myHasCentered = true; map.setCenter(myPos); }
        } else {
          myMarker.setPosition(myPos);
          updateMyArrow(myHeading);
          setMyLocated(myGray);
        }
      },
      () => {
        // 定位失败（权限未授予 / 瞬时失败）：稍后重试，最多 5 次
        retries++;
        if (retries <= 5) {
          if (locationWatchId != null) navigator.geolocation.clearWatch(locationWatchId);
          locationWatchId = null;
          setTimeout(startWatch, 3000);
        }
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 8000 }
    );
  };
  startWatch();
}

// 双向共享：把自己的位置（WGS-84，对称协议）定期通过数据通道回传给分享者，
// 让分享者首页地图也能实时看到好友（接收端）的位置。含 gray 字段（灰不影响朝向发送）。
function sendMyLocation() {
  if (!dc || dc.readyState !== "open" || !myPosWgs) return;
  try {
    dc.send(
      JSON.stringify({
        type: "loc",
        lat: myPosWgs.lat,
        lng: myPosWgs.lng,
        heading: myHeading != null ? Math.round(myHeading) : null,
        acc: 0,
        t: Date.now(),
        gray: myGray,
      })
    );
  } catch (e) {}
}
setInterval(sendMyLocation, 3000);

// 定位信号看门狗：持续 5 秒无新位置 → 判定定位信号不佳，回传灰色给分享者。
// 灰色时指南针(initCompass)仍在持续回传朝向（sendMyLocation 每 500ms 一次），
// 因此灰色只影响定位标颜色，不影响朝向指针转动；恢复定位后立即转回蓝色。
function startGrayWatchdog() {
  setInterval(() => {
    if (!myPosWgs || lastFixTime <= 0) return;
    if (!myGray && Date.now() - lastFixTime > 5000) {
      myGray = true;
      // 自己的定位标同步变灰（灰不影响朝向指针转动，指针仍按指南针旋转）
      setMyLocated(true);
      // 变灰瞬间回传一次灰色定位（含最后位置 + 当前朝向），分享者同步显示灰色定位标
      sendMyLocation();
    }
  }, 3000);
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

// 滴滴式：按分享者-好友距离动态决定缩放级别
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

// 「定位分享者」按钮：切换跟随模式
function toggleFollow() {
  follow = !follow;
  const btn = $("locBtn");
  btn.classList.toggle("active", follow);
  $("locTip").classList.toggle("show", follow);
  if (follow && map) {
    // 切换时立即把分享者位置放中心并更新缩放
    if (driverMarker) {
      const p = driverMarker.getPosition();
      map.setCenter(p);
      applyZoom();
    }
  }
}

// 跟随模式下按分享者-好友距离设置缩放；无好友位置则用固定缩放
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
  // 定位信号看门狗：无新位置 5 秒 → 置灰并回传灰色（灰不影响朝向信号发送）
  startGrayWatchdog();
  // 指南针：静止时方向指针也能转动
  initCompass();
  // 用户中心：左上角入口 + 改名/改头像
  renderUserEntry();
  bindUserCenterEvents();
  $("locBtn").addEventListener("click", toggleFollow);

  // HIA 圆形按键：弹出/收起「退出位置共享」面板（同安卓 App）
  $("hiaBtn").addEventListener("click", () => {
    if ($("exitPanel").style.display !== "none") {
      $("exitPanel").style.display = "none";
      $("exitOverlay").style.display = "none";
      return;
    }
    updateExitPanel();
    $("exitOverlay").style.display = "block";
    $("exitPanel").style.display = "block";
  });
  $("exitOverlay").addEventListener("click", () => {
    $("exitPanel").style.display = "none";
    $("exitOverlay").style.display = "none";
  });
  $("exitClose").addEventListener("click", () => {
    $("exitPanel").style.display = "none";
    $("exitOverlay").style.display = "none";
  });
  $("exitBtn").addEventListener("click", stopSharing);

  signaling = await connectSignaling("hereiam_" + code, onSignal);
  setStatus("等待好友分享…");
  // 通知分享者有好友加入，分享者据此建立 P2P 连接（携带本好友唯一 ID）
  // 分享者可能还没点"开始"（信令通道尚未建立），会收不到这次 join。
  // 因此每 2 秒重发一次 join，直到连接建立为止；断开后也会重启。
  signaling.send({ type: "join", id: friendId });
  startJoinTimer();
}

// 每 2 秒重发一次 join，直到与分享者直连成功
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
  } else if (msg.type === "bye") {
    // 对方主动结束了共享：停止重连，清除定位标，明确提示（区别于网络断连）
    setStatus("对方已结束共享，可关闭此页面", false);
    if (joinTimer) {
      clearInterval(joinTimer);
      joinTimer = null;
    }
    if (pc) {
      try {
        pc.close();
      } catch (e) {}
      pc = null;
      dc = null;
    }
    removeDriverMarker();
    if ($("exitStatus")) $("exitStatus").textContent = "对方已结束共享";
  }
}

// 移除分享者定位标（对方结束共享时调用）
function removeDriverMarker() {
  if (driverMarker) {
    try {
      driverMarker.setMap(null);
    } catch (e) {}
    driverMarker = null;
  }
  driverArrowG = null;
  driverAvatarImg = null;
  driverNameEl = null;
  driverAvatarData = null;
  driverName = null;
  driverWdp = null;
  driverStroke = null;
  follow = false;
  const btn = $("locBtn");
  if (btn) btn.classList.remove("active");
  const tip = $("locTip");
  if (tip) tip.classList.remove("show");
  const addr = $("addr");
  if (addr) addr.innerHTML = "好友位置将在这里显示";
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
    dc.onopen = () => {
      // 连接建立后把自己的资料（用户名+头像）推送给分享者（安卓端显示）
      sendMyProfile();
    };
    dc.onmessage = (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      if (m && m.type === "profile") {
        setDriverProfile(m.name, m.avatar);
      } else if (m && m.type === "loc") {
        onLocation(m);
      } else if (m && m.lat !== undefined) {
        // 兼容旧版分享者端（无 type 字段的纯位置消息）
        onLocation(m);
      }
    };
  };
  pc.onconnectionstatechange = () => {
    if (!pc) return;
    const st = pc.connectionState;
    if (st === "connected") {
      setStatus("已点对点直连", true);
      updateExitPanel();
    } else if (st === "disconnected" || st === "failed") {
      setStatus("连接中断，正在自动重连…");
      updateExitPanel();
      // 分享者端也会自动重连；这里同时重启 join 定时器，双保险
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
  const gray = !!m.gray;   // 分享者定位信号不佳（灰色定位标），灰色时指针仍按 heading 转动
  if (!driverMarker) {
    const created = createDriverMarker(pos, m.heading);
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
    // 连接成功后自动把地图焦点移到分享者所在区域，不用好友自己找
    map.setCenter(pos);
    applyZoom();
  } else {
    driverMarker.setPosition(pos);
    updateDriverArrow(m.heading);
    setDriverLocated(gray);
  }

  // 跟随模式下：分享者位置放中心 + 按距离动态缩放
  if (follow) {
    map.setCenter(pos);
    applyZoom();
  }

  // 显示位置 + 精度（若分享者端传了）
  const accText = m.acc && m.acc > 0 ? "（精度约 " + m.acc + " 米）" : "";
  if (AMap.Geocoder) {
    const geoc = new AMap.Geocoder();
    geoc.getAddress(pos, (st, r) => {
      if (st === "complete" && r.regeocode) {
        $("#addr").innerHTML =
          "<b>好友现在在：</b>" + r.regeocode.formattedAddress + " " + accText;
      }
    });
  }
}

// 更新退出面板的连接状态
function updateExitPanel() {
  const el = $("exitStatus");
  if (!el) return;
  const connected = pc && pc.connectionState === "connected";
  el.textContent = connected
    ? "已连接，正在查看好友位置"
    : "连接中…";
}

// 好友主动退出位置共享（同安卓 App 的 HIA 键 → 停止查看）
function stopSharing() {
  sendLeave();                                   // 通知分享者本好友已退出
  if (joinTimer) { clearInterval(joinTimer); joinTimer = null; }
  if (pc) { try { pc.close(); } catch (e) {} pc = null; dc = null; }
  if (signaling) { try { signaling.close(); } catch (e) {} signaling = null; }
  if (locationWatchId != null) { navigator.geolocation.clearWatch(locationWatchId); locationWatchId = null; }
  removeDriverMarker();
  $("exitPanel").style.display = "none";
  $("exitOverlay").style.display = "none";
  setStatus("已退出位置共享", false);
}

// 好友退出：通知对方释放连接。移动端浏览器 beforeunload 不一定可靠，
// 因此同时监听 pagehide 和页面隐藏，尽量保证 leave 能送达。
function sendLeave() {
  if (!signaling) return;
  try {
    signaling.send({ type: "leave", id: friendId });
  } catch (e) {}
}
window.addEventListener("beforeunload", () => {
  if (joinTimer) clearInterval(joinTimer);
  sendLeave();
  if (pc) pc.close();
  if (signaling) signaling.close();
});
window.addEventListener("pagehide", () => {
  if (joinTimer) clearInterval(joinTimer);
  sendLeave();
  if (pc) pc.close();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") sendLeave();
});

// 重连很久仍失败（对方异常退出/断网）：给出明确提示，避免一直转圈
let reconnectFailCount = 0;
setInterval(() => {
  if (pc && pc.connectionState !== "connected") {
    reconnectFailCount++;
    if (reconnectFailCount >= 12) {
      reconnectFailCount = 0;
      setStatus("对方可能已退出或网络中断，请稍后重试", false);
    }
  } else {
    reconnectFailCount = 0;
  }
}, 5000);

init();
