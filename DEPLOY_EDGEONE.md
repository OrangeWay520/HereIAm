# 用 EdgeOne Pages 替代 GitHub Pages 部署 HereIAm 网页版

> 目标：把这套纯静态网页（`web/` 目录）托管到 **腾讯云 EdgeOne Pages**，
> 绑定自己的域名 `hereiam.orangeway.top`，替代原来的 GitHub Pages。

> ⚠️ 更正（重要）：EdgeOne Pages **不是**「EdgeOne 网站安全加速」那个需要兑换码的免费版。
> Pages 是腾讯云 EdgeOne 旗下的**独立静态托管服务**，**免费套餐在控制台一键开通，无需兑换码**。

---

## 0. 方案总览

| 对比项 | GitHub Pages（现状） | EdgeOne Pages（目标） |
|---|---|---|
| 费用 | 免费 | 免费（一键开通） |
| 自定义域名 | 支持 | 支持，自动/手动配 HTTPS 证书 |
| 国内访问 | 不稳定（github.io 常被墙） | 有国内节点，大陆访问流畅 |
| 部署方式 | Git 仓库 | Git 集成（GitHub/Gitee）/ 直接上传 / CLI |
| 每次更新 | 推仓库自动发布 | 推仓库自动构建部署 |

这套网页版是**纯静态 HTML/CSS/JS**，无任何构建步骤，EdgeOne Pages 开箱即用。

---

## 1. 前置条件核对

| 项目 | 要求 | 你的状态 |
|---|---|---|
| 腾讯云账号 | 需**实名认证** | 待确认 |
| 主域名 ICP 备案（工信部） | 必须已通过 | ✅ 你已备案 |
| DNS 解析权限 | 能给 `orangeway.top` 加 `hereiam` 子域记录 | 看域名在哪个服务商 |
| 代码仓库（可选） | 若用 Git 集成，需有 GitHub 或 Gitee 仓库 | 你有 Gitee/GitHub |

> **备案结论**：加速区域选「全球可用区（含中国大陆）」绑定 `hereiam.orangeway.top`，
> 需要的是**工信部 ICP 备案**（你已有，子域名复用主域备案，无需单独备案）。
> 这与公安备案是两回事，见末尾「合规提醒」。

---

## 2. 开通 EdgeOne Pages

1. 登录 [腾讯云控制台](https://console.cloud.tencent.com) → 搜索 **EdgeOne** → 进入。
2. 左侧菜单点 **Pages** → 按提示**立即开通**免费用量套餐（无需兑换码）。
3. 开通后在首页「用量概览」可看到每月免费的构建次数 / 函数调用 / KV 存储配额。

---

## 3. 创建项目并上传网页（二选一）

### 方式 A：Git 集成（推荐，自动部署，符合"少手动"习惯）

1. 把 `web/` 目录初始化为独立 Git 仓库并推送到 **Gitee**（国内可达、你有账号）：
   ```bash
   cd f:/Software-Development/HereIAm/web
   git init -b main
   git add -A
   git commit -m "HereIAm web v1.0"
   git remote add origin https://gitee.com/<你的用户名>/HereIAm-Web.git
   git push -u origin main
   ```
   > 仓库里应包含：`index.html`、`driver.html`、
   > `index.js`、`driver.js`、`signaling.js`、`user.js`、`config.js`
   > 以及 `favicon.png`、`hereiam_logo.png`、`bar_logo1.png`、`apple-touch-icon.png` 等图片。
2. EdgeOne Pages 控制台 → **创建 Pages 项目** → 选「从 Git 仓库导入」→ 授权 Gitee。
3. 选择 `HereIAm-Web` 仓库与分支 `main`。
4. 因为**没有构建命令**：在「构建配置」里把构建命令留空或填 `echo "no build"`，**输出目录填 `.`**（根目录）。
5. 点「开始部署」，成功后生成预览地址（3 小时内可访问，仅用于验证）。

### 方式 B：直接上传（最简单，更新需手动）

1. EdgeOne Pages 控制台 → **创建 Pages 项目** → 选「直接上传」。
2. 把 `web/` 目录下的全部文件（保持目录结构）拖拽上传。
3. 部署即完成，同样生成临时预览地址。

> 两种方式最终都要**绑定自定义域名**才能长期稳定访问（自带项目域名仅 3 小时预览）。

---

## 4. 选择加速区域

在项目设置里选择**加速区域**：

- ✅ **全球可用区（含中国大陆）** ← 推荐（你已 ICP 备案，大陆访问走国内节点，最流畅）
- ⚠️ 若选「全球可用区（不含中国大陆）」则大陆网络返回 401，**不要选**。

---

## 5. 绑定自定义域名 `hereiam.orangeway.top`

1. 项目设置 → **域名管理** → **添加自定义域名**。
2. 输入 `hereiam.orangeway.top`（子域名复用主域备案）。
3. 平台给出 **CNAME 记录**（形如 `xxx.pages.edgeone.app`），到域名解析服务商添加：
   - 主机记录：`hereiam`
   - 类型：`CNAME`
   - 记录值：平台给的地址（删除同名的 A 记录，避免冲突）
4. 回到控制台点「验证」，等 DNS 生效（一般几分钟，最长 48 小时）。
5. **HTTPS 证书**：Pages 默认自动签发免费证书；也可在「配置证书」选腾讯云 SSL 的证书。
   > 注意：个别教程提示「添加域名后不会自动生成证书，需手动完善 HTTPS」，
   > 若验证通过后证书未自动签发，在域名管理里手动「配置证书」触发一次即可。
6. 验证成功 → 站点获得稳定域名 + 自动 CDN 与防护。

---

## 6. 验证并下线 GitHub Pages

1. 访问 `https://hereiam.orangeway.top/`，确认：
   - 页面正常、地图能显示（高德 Key 无需改动）；
   - 分享/查看/二维码功能正常（二维码走外部 `api.qrserver.com`，与托管无关）；
   - 分享链接能正确跳转到 `index.html`（`index.js` 用 `location.href` 拼链接，同目录结构即可，无需改代码）。
2. HTTPS 锁标正常。
3. 确认无误后，可关闭原 GitHub Pages（或保留做冗余）。

---

## 7. 合规提醒（公安备案）

- 工信部 ICP 备案：你的主域已通过，子域名复用即可，**无需新增备案**。
- **公安备案**（`beian.mps.gov.cn`）：若仍在办理中，建议**通过后再对外正式上线**；
  上线后按规则在 30 日内于公安备案平台**如实补录** `hereiam.orangeway.top` 及
  「点对点实时位置共享工具」用途，避免"备案未完成即运营"风险。
- 页面底部建议展示 ICP 备案号与公安备案号。

---

## 常见问题

- **为什么要绑自定义域名？** 自带项目/部署域名在大陆区域仅提供 3 小时预览链接，超时 401；必须绑自定义域名才能稳定长期访问。
- **网页版有后端吗？** 没有。信令走 Ably、地图走高德、点对点走 WebRTC，全部在浏览器端完成，EdgeOne 只负责托管静态文件，不参与任何位置/信令转发。
- **以后想加后端怎么办？** Pages 支持 Pages Functions（Serverless），可直接在项目里加函数做账号、历史、推送等，不必另买服务器。
