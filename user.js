// ============================================================
//  HereIAm 浏览器用户中心 —— 用户名 + 头像（localStorage 持久化）
//  首次使用自动分配随机用户名「浏览器用户-XXXX」；
//  用户可在左上角用户中心修改头像/用户名。
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

// 选择头像文件 → 压缩到 128px 内 → 存为 data URL（控制 WebRTC 消息体积）
function pickAvatarFromInput(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      const max = 128;
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      // 居中裁剪为正方形，避免拉伸变形
      const side = Math.min(w, h);
      ctx.drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, side, side);
      userProfile.avatar = canvas.toDataURL("image/jpeg", 0.8);
      const preview = document.getElementById("ucAvatarPreview");
      preview.src = userProfile.avatar;
      preview.style.display = "block";
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
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
}
