// ============================================================
//  HereIAm 配置中心 —— 只需在这里填入两个免费 Key 即可
// ============================================================

const CONFIG = {
  // 1) 信令服务：Ably（免费档）。
  //    注册：https://ably.com/signup （免费账号，不用绑卡）
  //    创建 App 后，复制 App 的 API Key（形如 "xxxx.yyyy:zzzz"）
  ablyKey: "gOCoqA.LyruUQ:-DhLNHnwAl0wndwzdTU57-7X3ksPA6M3Y_s8dwRMXvo",

  // 2) 高德 JS 地图 Key + 安全密钥（免费）。
  //    注册：https://lbs.amap.com （个人开发者实名即可）
  //    amapSecurityCode 是「安全密钥」，用它就不需要配置域名白名单，
  //    本地调试（localhost）和正式部署（HTTPS）都能直接使用。
  //    地图使用 JS API 1.4.15（经典版，栅格瓦片，不依赖 WebGL）。
  amapKey: "338c0eae4960a50d77c8c8da70d87c8f",
  amapSecurityCode: "62bcab5fdbd550709d73af09a56190ce",

  // 3) 免费公共 STUN（Google），用于内网穿透打洞
  stunServers: [{ urls: "stun:stun.l.google.com:19302" }],
};
