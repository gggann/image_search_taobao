# 淘宝以图搜同款助手 (image_search_taobao)

一个 Chrome / Edge 浏览器扩展(Manifest V3),在任意网页的商品图片上**右键**,即可用**淘宝以图搜同款**;并在 JD / 淘宝 / 天猫商品详情页注入「淘宝搜同款」「mapi 搜同款」按钮,方便快速比价找同款。

## 功能特性

- 🖱️ **右键搜同款**:在任意 `<img>` 上右键 →「用淘宝以图搜同款」,自动跳转淘宝图片搜索结果页。
- 🛒 **商品页注入按钮**:在京东(JD / JD.hk / 360buy)、淘宝、天猫商品详情页自动注入「淘宝搜同款」按钮。
- 🔌 **mapi 接口测试入口**:通过淘宝 h5api(mtop)接口直接调用 `relationrecommend` 以图搜同款,返回结果在新页面展示,用于调试 / 对比接口效果。
- 🍪 **自动复用登录态**:通过 `cookies` 权限读取淘宝域名 cookie,提升搜索结果的相关性。

## 安装方式(开发者模式)

1. 下载 / clone 本仓库到本地。
2. 打开 Chrome,进入 `chrome://extensions/`。
3. 右上角开启「开发者模式 (Developer mode)」。
4. 点击「加载已解压的扩展程序 (Load unpacked)」,选择本仓库根目录(含 `manifest.json` 的文件夹)。
5. 扩展图标出现在工具栏,即可使用。

> Edge 用户:进入 `edge://extensions/`,同样开启开发者模式后「加载解压缩的扩展」。

## 使用方法

### 方式一:右键菜单(任意网页)

在任意商品图片上**右键** → 选择「**用淘宝以图搜同款**」,扩展会自动在新标签页打开淘宝搜索结果。

### 方式二:商品详情页按钮

打开京东 / 淘宝 / 天猫的商品详情页,页面会自动出现「**淘宝搜同款**」按钮(以及 mapi 测试按钮),点击即可。

### 方式三:工具栏弹窗

点击扩展图标 →「打开淘宝搜索页」,可手动进入淘宝搜索。

## 目录结构

```
image_search_taobao/
├── manifest.json              # 扩展清单(MV3)
├── background.js              # Service Worker:右键菜单、图片上传、mapi 调用、DNR 规则
├── content_jd.js              # 注入 JD / 天猫 / 淘宝商品页的「搜同款」按钮
├── content_taobao.js          # 注入淘宝 / 天猫域的搜索浮层逻辑
├── content.css                # 注入按钮 / 浮层的样式
├── popup.html / .css / .js    # 工具栏弹窗
├── mapi_results.html / .css / .js  # mapi 接口结果展示页
└── 淘宝mapi以图搜同款API复用文档.md  # mapi 接口复用说明文档
```

## 权限说明

| 权限 | 用途 |
| --- | --- |
| `contextMenus` | 注册图片右键菜单 |
| `cookies` | 读取淘宝登录态,提升搜索相关性 |
| `declarativeNetRequest` | 为 mapi 请求附加签名 / 请求头 |
| `storage` | 暂存待上传图片 payload、mapi 结果 |
| `tabs` | 打开 / 监听搜索结果标签页 |
| `<all_urls>` (host) | 在任意网页图片上提供右键搜同款 |

## 技术栈

- Chrome Extension **Manifest V3**
- 原生 JavaScript(无构建步骤、无依赖)
- Chrome Extensions API:`contextMenus` / `declarativeNetRequest` / `storage` / `cookies` / `tabs`

## 许可证

MIT
