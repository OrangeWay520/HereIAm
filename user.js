// ============================================================
//  HereIAm 浏览器用户中心 —— 用户名 + 头像（localStorage 持久化）
//  首次使用自动分配随机用户名「浏览器用户-XXXX」；
//  用户可在左上角用户中心修改头像/用户名。
//  头像支持「选区裁剪」：选图后可在裁剪框中拖动/缩放选择区域。
//  两处页面共用：index.html（首页）与 friend.html（好友端）。
// ============================================================

const USER_STORE_KEY = "hereiam_user_profile";

// 读取当前用户资料；首次使用自动生成随机用户名并保存
function getUserProfile() {
  try {
    const raw = localStorage.getItem(USER_STORE_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (p && typeof p.name === "string" && p.name.trim()) return p;
    }
  } catch (e) {}
  // 首次使用：分配随机用户名（尽量唯一，简短）
  const profile = {
    name: "浏览器用户-" + Math.floor(1000 + Math.random() * 9000),
    avatar: null,
  };
  saveUserProfile(profile);
  return profile;
}

function saveUserProfile(profile) {
  try {
    localStorage.setItem(USER_STORE_KEY, JSON.stringify(profile));
  } catch (e) {}
}

// 当前用户资料（全局，页面加载即初始化）
let userProfile = getUserProfile();

function getUserName() {
  return userProfile.name;
}
function getUserAvatar() {
  return userProfile.avatar;
}

// 渲染左上角用户中心入口（仅头像，与安卓 App 一致不显示用户名）
function renderUserEntry() {
  const avatarEl = document.getElementById("userAvatar");
  if (avatarEl) {
    if (userProfile.avatar) {
      avatarEl.style.backgroundImage = "url('" + userProfile.avatar + "')";
      avatarEl.style.backgroundSize = "cover";
      avatarEl.textContent = "";
    } else {
      avatarEl.style.backgroundImage = "";
      avatarEl.textContent = userProfile.name.slice(0, 1);
    }
  }
}

// ========== 用户中心面板 ==========
function openUserCenter() {
  const panel = document.getElementById("ucPanel");
  const overlay = document.getElementById("ucOverlay");
  const nameInput = document.getElementById("ucName");
  const preview = document.getElementById("ucAvatarPreview");
  nameInput.value = userProfile.name;
  preview.src = userProfile.avatar || "";
  preview.style.display = userProfile.avatar ? "block" : "none";
  if (panel) panel.style.display = "block";
  if (overlay) overlay.style.display = "block";
}

function closeUserCenter() {
  const panel = document.getElementById("ucPanel");
  const overlay = document.getElementById("ucOverlay");
  if (panel) panel.style.display = "none";
  if (overlay) overlay.style.display = "none";
}

function saveUserCenter() {
  const nameInput = document.getElementById("ucName");
  const name = (nameInput.value || "").trim();
  if (name) userProfile.name = name.slice(0, 12);
  saveUserProfile(userProfile);
  renderUserEntry();
  // 资料变更后重发 profile 给当前已连接的对端（分享/查看中）
  if (typeof onUserProfileChanged === "function") onUserProfileChanged();
  closeUserCenter();
}

// ============================================================
//  头像裁剪：选图 → 拖动/缩放选区 → 裁剪为 128x128
// ============================================================
let cropState = null; // {nw,nh,dw,dh,dx,dy,fx,fy,fs}

function openCropStage() {
  const o = document.getElementById("cropOverlay");
  const panel = document.getElementById("ucPanel");
  if (panel) panel.style.display = "none";
  if (o) o.style.display = "flex";
}

function closeCropStage() {
  const o = document.getElementById("cropOverlay");
  const panel = document.getElementById("ucPanel");
  if (o) o.style.display = "none";
  if (panel) panel.style.display = "block";
  cropState = null;
}

// 选择头像文件 → 进入裁剪
function pickAvatarFromInput(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => setupCrop(img, e.target.result);
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

// 初始化裁剪舞台：图片适配显示 + 默认选区（中央 70%）
function setupCrop(img, dataUrl) {
  const stage = document.getElementById("cropStage");
  const imgEl = document.getElementById("cropImg");
  if (!stage || !imgEl) return;
  imgEl.src = dataUrl;
  openCropStage(); // 必须先显示舞台再测量，否则 display:none 下 clientWidth/Height 为 0
  const sw = stage.clientWidth;
  const sh = stage.clientHeight;
  const pad = 20;
  const scale = Math.min((sw - pad * 2) / img.naturalWidth, (sh - pad * 2) / img.naturalHeight);
  const dw = img.naturalWidth * scale;
  const dh = img.naturalHeight * scale;
  const dx = (sw - dw) / 2;
  const dy = (sh - dh) / 2;
  imgEl.style.left = dx + "px";
  imgEl.style.top = dy + "px";
  imgEl.style.width = dw + "px";
  imgEl.style.height = dh + "px";
  cropState = { nw: img.naturalWidth, nh: img.naturalHeight, dw: dw, dh: dh, dx: dx, dy: dy, srcImg: img };
  const fs = Math.min(dw, dh) * 0.7;
  setFrame(dx + (dw - fs) / 2, dy + (dh - fs) / 2, fs);
}

// 设置/约束选区（限制在图片显示区域内）
function setFrame(x, y, s) {
  if (!cropState) return;
  const st = cropState;
  const frame = document.getElementById("cropFrame");
  x = Math.max(st.dx, Math.min(x, st.dx + st.dw - s));
  y = Math.max(st.dy, Math.min(y, st.dy + st.dh - s));
  frame.style.left = x + "px";
  frame.style.top = y + "px";
  frame.style.width = s + "px";
  frame.style.height = s + "px";
  st.fx = x;
  st.fy = y;
  st.fs = s;
}

// 确定裁剪：按选区生成 128x128 头像
function confirmCrop() {
  if (!cropState) return;
  const st = cropState;
  const imgScale = st.nw / st.dw;
  const sx = (st.fx - st.dx) * imgScale;
  const sy = (st.fy - st.dy) * imgScale;
  const ss = st.fs * imgScale;
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  // 用预加载好的原图绘制，避免依赖 DOM 中 <img> 的解码状态
  ctx.drawImage(st.srcImg, sx, sy, ss, ss, 0, 0, 128, 128);
  userProfile.avatar = canvas.toDataURL("image/jpeg", 0.8);
  const preview = document.getElementById("ucAvatarPreview");
  preview.src = userProfile.avatar;
  preview.style.display = "block";
  closeCropStage();
}

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

// 绑定裁剪手势：拖动选区移动 / 拖四角手柄缩放（对边固定，同主流裁剪 App）
function bindCropGestures() {
  const frame = document.getElementById("cropFrame");
  if (!frame) return;
  let drag = null;
  const end = () => { drag = null; frame.classList.remove("active"); };

  frame.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const corner = e.target.closest(".crop-corner");
    frame.setPointerCapture(e.pointerId);
    const rect = frame.parentElement.getBoundingClientRect(); // 舞台在视口中的位置
    if (corner) {
      const c = corner.classList.contains("tl") ? "tl" :
                corner.classList.contains("tr") ? "tr" :
                corner.classList.contains("bl") ? "bl" : "br";
      drag = { mode: "resize", corner: c, left: rect.left, top: rect.top };
    } else {
      drag = { mode: "move", sx: e.clientX, sy: e.clientY, ox: cropState.fx, oy: cropState.fy, left: rect.left, top: rect.top };
    }
    frame.classList.add("active");
  });

  frame.addEventListener("pointermove", (e) => {
    if (!drag || !cropState) return;
    const st = cropState;
    if (drag.mode === "move") {
      setFrame(drag.ox + (e.clientX - drag.sx), drag.oy + (e.clientY - drag.sy), st.fs);
      return;
    }
    // 缩放：对边角固定，按拖拽角当前位置计算新边长（保持正方形）
    let fxc, fyc; // 固定角坐标
    if (drag.corner === "br") { fxc = st.fx; fyc = st.fy; }
    else if (drag.corner === "tl") { fxc = st.fx + st.fs; fyc = st.fy + st.fs; }
    else if (drag.corner === "tr") { fxc = st.fx; fyc = st.fy + st.fs; }
    else { fxc = st.fx + st.fs; fyc = st.fy; } // bl
    const cx = clamp(e.clientX - drag.left, st.dx, st.dx + st.dw);
    const cy = clamp(e.clientY - drag.top, st.dy, st.dy + st.dh);
    const s = clamp(Math.max(Math.abs(cx - fxc), Math.abs(cy - fyc)), 48, Math.min(st.dw, st.dh));
    let x = fxc, y = fyc;
    if (drag.corner === "br") { /* x,y 不变 */ }
    else if (drag.corner === "tl") { x = fxc - s; y = fyc - s; }
    else if (drag.corner === "tr") { x = fxc; y = fyc - s; }
    else { x = fxc - s; y = fyc; } // bl
    setFrame(x, y, s);
  });

  frame.addEventListener("pointerup", end);
  frame.addEventListener("pointercancel", end);
}

// 绑定用户中心面板事件（页面 onload 后调用）
function bindUserCenterEvents() {
  const entry = document.getElementById("userEntry");
  if (entry) entry.addEventListener("click", openUserCenter);
  const close = document.getElementById("ucClose");
  if (close) close.addEventListener("click", closeUserCenter);
  const overlay = document.getElementById("ucOverlay");
  if (overlay) overlay.addEventListener("click", closeUserCenter);
  const save = document.getElementById("ucSave");
  if (save) save.addEventListener("click", saveUserCenter);
  const input = document.getElementById("ucAvatarInput");
  if (input) input.addEventListener("change", () => pickAvatarFromInput(input));
  // 裁剪面板
  const cancel = document.getElementById("cropCancel");
  if (cancel) cancel.addEventListener("click", closeCropStage);
  const confirm = document.getElementById("cropConfirm");
  if (confirm) confirm.addEventListener("click", confirmCrop);
  bindCropGestures();
}
