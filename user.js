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

// 渲染左上角用户中心入口（头像 + 名字）
function renderUserEntry() {
  const avatarEl = document.getElementById("userAvatar");
  const nameEl = document.getElementById("userName");
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
  if (nameEl) nameEl.textContent = userProfile.name;
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
  cropState = { nw: img.naturalWidth, nh: img.naturalHeight, dw: dw, dh: dh, dx: dx, dy: dy };
  const fs = Math.min(dw, dh) * 0.7;
  setFrame(dx + (dw - fs) / 2, dy + (dh - fs) / 2, fs);
  openCropStage();
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
  const imgEl = document.getElementById("cropImg");
  const imgScale = st.nw / st.dw;
  const sx = (st.fx - st.dx) * imgScale;
  const sy = (st.fy - st.dy) * imgScale;
  const ss = st.fs * imgScale;
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(imgEl, sx, sy, ss, ss, 0, 0, 128, 128);
  userProfile.avatar = canvas.toDataURL("image/jpeg", 0.8);
  const preview = document.getElementById("ucAvatarPreview");
  preview.src = userProfile.avatar;
  preview.style.display = "block";
  closeCropStage();
}

// 绑定裁剪手势：选区拖动（移动）+ 右下角手柄（缩放）
function bindCropGestures() {
  const frame = document.getElementById("cropFrame");
  const handle = document.getElementById("cropHandle");
  if (!frame || !handle) return;
  let drag = null;
  frame.addEventListener("pointerdown", (e) => {
    if (e.target === handle) return;
    e.preventDefault();
    drag = { mode: "move", sx: e.clientX, sy: e.clientY, ox: cropState.fx, oy: cropState.fy };
    frame.setPointerCapture(e.pointerId);
  });
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    drag = { mode: "resize", sx: e.clientX, sy: e.clientY, os: cropState.fs };
    handle.setPointerCapture(e.pointerId);
  });
  frame.addEventListener("pointermove", (e) => {
    if (!drag || !cropState) return;
    const dx = e.clientX - drag.sx;
    const dy = e.clientY - drag.sy;
    if (drag.mode === "move") {
      setFrame(drag.ox + dx, drag.oy + dy, cropState.fs);
    } else {
      setFrame(cropState.fx, cropState.fy, Math.max(40, drag.os + Math.max(dx, dy)));
    }
  });
  const end = () => { drag = null; };
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
