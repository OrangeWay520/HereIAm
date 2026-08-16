# HereIAm · 点对点实时位置共享（Web）

实时位置共享网页端。基于高德地图，无需注册账号，通过分享链接 / 分享码即可实现**点对点**的实时位置共享，与安卓 App（`HereIAm-Android`）完全互通。

## 在线地址

**https://orangeway520.github.io/HereIAm/**

## 功能特性

- **分享我的位置**：一键生成分享链接 + 二维码，好友点开即可实时查看
- **查看好友位置**：输入分享码，实时追踪好友位置
- **定位键三态循环**：聚焦（居中 + 正北）→ 方向跟随（实时同步运动方向）→ 全部总览
- **地图旋转交互**：右键 / 双指拖拽旋转，最短路径动画
- **顶部用户选择器**：在自己与共享好友间快速切换
- **深色模式**：自动跟随系统，与安卓端视觉一致

## 页面入口

| 页面 | 说明 |
| --- | --- |
| `index.html` | 主页面（分享 / 查看，桌面与手机通用） |
| `friend.html` | 好友查看端（分享链接落地页） |
| `driver.html` | 司机端（专注导航查看） |

## 技术栈

- 高德地图 JS API（GCJ-02 坐标系）
- Ably 实时信令（受限 Key + `hereiam:*` 命名空间白名单）
- WebRTC DataChannel（位置数据直连）
- 原生 HTML / CSS / JavaScript，零框架依赖

## 本地运行

```bash
# 任意静态服务器即可，例如：
python -m http.server 8080
# 或使用仓库根目录的 https-server.js（本地 HTTPS 测试）
node https-server.js
```

打开 `http://localhost:8080/`（本地使用需允许高德 Key 的测试域名白名单）。

## 目录结构

```
web/
├── index.html / index.js    # 主页面
├── friend.html / friend.js  # 好友查看端
├── driver.html / driver.js  # 司机端
├── signaling.js             # Ably 信令封装
├── config.js                # 密钥配置
└── user.js                  # 用户 / 头像逻辑
```

## 隐私与安全

- Ably 使用**受限 Key**：仅 publish/subscribe，且频道限制在 `hereiam:*` 命名空间
- 高德 Web 端 Key 使用**安全密钥**并绑定域名白名单
- 问题反馈代理运行于 Cloudflare Worker，Token 存放于环境变量，不打包进前端
