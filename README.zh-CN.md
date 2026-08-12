<div align="center">

  <img src="store-assets/freepaper-logo-300.png" width="128" alt="Freepaper 图标">
  <h1>Freepaper</h1>
  <p>面向 Microsoft Edge 和 Google Chrome 的开源学术论文 PDF 下载扩展。</p>
  <p><a href="README.md">English</a> · <strong>简体中文</strong></p>
</div>

> 当前变更与历史版本统一维护在 [CHANGELOG.md](CHANGELOG.md) 和 GitHub Releases 中。

> Freepaper 只帮助用户处理自己有权访问的内容，不绕过付费墙、机构权限、安全验证或网站技术措施。

> **知网实验性支持：** 当前仅识别知网页面或知网技术支持期刊门户已经公开提供的下载/PDF 入口，不绕过登录、机构权限、验证码或付费控制。

## 主要功能

- 检测当前论文页面中的 PDF 候选；
- 导入 DOI、URL、CSV、TSV 或 TXT 批量任务；
- 按 DOI、arXiv ID、ScienceDirect PII 等文献标识去重；
- 将 PDF 保存到浏览器下载目录下的自定义子文件夹；
- 对明确、唯一的 PDF 链接或按钮自动尝试一次，避免盲目点击广告、购买入口或静态图片；
- 登录或验证完成后继续恢复 PDF 流程，并优先从论文详情页上下文验证和保存 PDF；
- 对当前任务相关的浏览器下载进行补充对账，减少下载完成但进度未更新的问题；
- 在 Manifest V3 Service Worker 被回收后恢复任务状态；
- 提供主面板、唯一可复用的下载进程窗，以及可拖动的网页操作助手；
- 支持暂停、继续、跳过、终止和仅重试失败/需登录项目；
- “最近下载”只显示由 Freepaper 发起，或明确关联到当前 Freepaper 任务的下载；
- 内嵌示例 CSV，可直接下载或复制；
- 导出基础下载结果 CSV；
- 支持 **简体中文、English、自动跟随浏览器语言**。

## 为什么这样设计

Freepaper 没有把“全自动”理解为无限重试或集中抓取，而是尽量减少无效页面、重复请求和误操作：

1. **保持用户输入顺序，不按数据库重新分组。** 将同一数据库的论文集中处理，可能让单位时间内对同一站点的访问更加密集，因此当前队列保持原始顺序。
2. **严格串行。** 同一浏览器一次只处理一篇，避免同时打开大量论文页面。
3. **自动打开仅限明确 PDF 入口。** 程序优先读取 `citation_pdf_url`、明确 PDF 路由或清晰的 View PDF / Download PDF 按钮；同一页面自动尝试一次，不无限刷新。
4. **验证码和机构登录由用户完成。** Freepaper 不模拟鼠标、不自动操作验证码，也不绕过权限；完成后继续识别后续页面。
5. **真实 PDF 由 Freepaper 保存。** 一旦确认进入 PDF 查看器，程序尽量直接保存到用户设定的子文件夹，而不是依赖用户点击浏览器保存按钮。
6. **避免动态 PDF 地址被二次请求。** IEEE、Wiley、ScienceDirect、知网的 PDF 端点可能依赖当前页面的 Cookie、Referrer、机构认证或一次性令牌。Freepaper 不再把这类地址直接交给 `chrome.downloads.download()`，而是优先在论文页面上下文中获取 PDF 字节，再由同一页面触发 Blob 下载，防止下载出 `stamp.htm`、`init.htm` 等验证页面。

不同数据库和学校的许可规则不同。请勿用于整卷、整期、系统性全文获取或其他违反平台/机构规定的用途。

## 浏览器兼容性

Freepaper 使用 Chromium Manifest V3 和标准 `chrome.*` 扩展 API：

- Microsoft Edge 88 或更高版本；
- Google Chrome 88 或更高版本。

Edge 和 Chrome 可以使用同一份运行包。当前开发和完整测试主要在 Edge 上进行，提交 Chrome Web Store 前建议在最新版 Chrome 中跑一次完整回归测试。

## 本地安装

1. 下载或克隆本仓库；
2. 打开 `edge://extensions` 或 `chrome://extensions`；
3. 开启“开发人员模式”；
4. 选择“加载解压缩的扩展”；
5. 选择本仓库根目录，也就是直接包含 `manifest.json` 的目录。

## 使用说明

### 当前页面

打开论文页面后点击 Freepaper 图标，使用“当前页面”检测 PDF。

### 批量下载

在“批量下载”中粘贴 DOI/URL，或导入 CSV、TSV、TXT 文件。Freepaper 会合并重复入口，并按照**原始输入顺序**逐篇处理。

### 自动 PDF 与人工验证

通常流程如下：

```text
论文详情页
→ Freepaper 自动尝试一次明确 PDF 入口
→ 若出现登录/验证，则暂停等待用户完成
→ 验证后继续检测，必要时再次恢复 PDF 流程
→ 在论文页面上下文中验证 PDF 并自动保存
→ 若网站禁止页面内保存，则等待 PDF 查看器下载事件
→ 更新任务统计
```

找不到足够明确的 PDF 入口时，网页助手才会请用户手动操作。验证码、账号登录和机构认证必须由用户本人完成。

认证流程由一套共享状态机统一管理：论文详情页、明确 PDF 入口、机构认证、出版商账号登录、人机验证、购买/无权限页面、PDF 查看器和浏览器下载分别处理；ScienceDirect、Wiley、IEEE、知网等站点适配器只负责识别页面和 PDF 入口。界面会区分“需要机构账号”“需要出版商账号”“需要人机验证”和“可能没有全文权限”，不会再统一提示点击 View PDF。

### 示例 CSV

首次引导和主面板快速开始区都提供内嵌示例。支持直接下载或复制内容。当前支持 CSV、TSV 和 TXT，暂不直接导入 XLSX。

### 语言切换

打开“设置 → 界面语言”，可以选择自动、简体中文或 English。

## 隐私

Freepaper 不向开发者运营的服务器上传论文清单、浏览记录、登录信息或下载历史，也不包含广告、分析或跟踪 SDK。扩展会按照用户操作直接访问 DOI 服务、学术出版商页面和 PDF 资源地址。

详细说明见双语版 [隐私政策](privacy-policy.md)。

## 权限说明

| 权限 | 用途 |
|---|---|
| `downloads` | 发起 PDF 下载并跟踪 Freepaper 创建或明确关联的下载任务 |
| `storage` | 在本地保存设置、队列、恢复状态和下载历史 |
| `activeTab` | 用户主动操作后检测当前页面 |
| `tabs` | 打开论文页面、绑定任务标签页并回到当前任务 |
| `scripting` | 检测 PDF 链接、明确 PDF 按钮和页面状态 |
| `webNavigation` | 跟踪 DOI 重定向、验证跳转和 PDF 页面切换 |
| `alarms` | 在 MV3 后台被回收后恢复未完成任务 |
| `<all_urls>` | 支持用户选择的不同学术出版商、DOI 和 PDF 地址 |

## 项目结构

```text
.
├── _locales/
├── icons/
├── store-assets/
├── docs/store/
├── examples/
├── background.js
├── content.js
├── i18n.js
├── popup.html
├── popup.js
├── onboarding.html
├── onboarding.js
├── task-monitor.html
├── task-monitor.js
└── manifest.json
```

## 开发检查

项目没有 npm 运行时依赖。安装 Node.js 20 或更高版本后运行：

```bash
npm run verify
```

## 发布与验证

- 商店上架模板：[`docs/store/`](docs/store/)
- 发布检查表：[`docs/RELEASE_CHECKLIST.md`](docs/RELEASE_CHECKLIST.md)
- 当前代码审计约束：[`docs/CODE_AUDIT.md`](docs/CODE_AUDIT.md)
- 通用验证方案：[`docs/VALIDATION.md`](docs/VALIDATION.md)
- 自动发布流程：[`docs/RELEASE_PROCESS.md`](docs/RELEASE_PROCESS.md)
- 商店素材：[`store-assets/`](store-assets/)

## 已知限制

- 出版商可能要求机构账号、VPN 或人工验证；
- Freepaper 不能下载用户没有访问权限的内容；
- 页面结构变化可能需要后续适配；
- 浏览器下载 API 只能保存到浏览器配置的下载目录及其子目录；
- 浏览器已经完成且未被 Freepaper 在文件名确定阶段识别的外部下载，扩展无法事后移动；Freepaper 会在页面内触发下载之前先进入任务等待状态，并在文件名确定阶段关联到 Freepaper 子目录。
- 某些浏览器内置 PDF 查看器不允许扩展控制其工具栏。如果出版商同时阻止页面上下文 `fetch`，Freepaper 会停止自动二次请求并等待用户点击查看器下载按钮，以避免生成 HTM 假文件。

## 贡献、安全、许可证与品牌

提交问题或代码前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请按照 [SECURITY.md](SECURITY.md) 私下报告。源代码采用 [Mozilla Public License 2.0](LICENSE)，品牌使用边界见 [TRADEMARKS.md](TRADEMARKS.md)。
