<div align="center">
  <img src="store-assets/freepaper-logo-300.png" width="128" alt="Freepaper 图标">
  <h1>Freepaper</h1>
  <p>面向 Microsoft Edge 和 Google Chrome 的开源学术论文 PDF 下载扩展。</p>
  <p><a href="README.md">English</a> · <strong>简体中文</strong></p>
</div>

当前版本：**v1.4.0**

> 注意：Freepaper已经上架Edge浏览器和chrome浏览器，作者享有相关权利，本项目只供使用者参考，不允许商用。

> Freepaper 只帮助用户处理自己有权访问的内容，不绕过付费墙、机构权限、安全验证或网站技术措施。

## 主要功能

- 检测当前论文页面中的 PDF 候选；
- 导入 DOI、URL、CSV 或 TXT 批量任务；
- 按 DOI、arXiv ID、ScienceDirect PII 等文献标识去重；
- 将 PDF 保存到浏览器下载目录下的自定义子文件夹；
- 在 Manifest V3 Service Worker 被回收后恢复任务状态；
- 提供主面板总控台、独立下载进程窗和可拖动验证助手；
- 支持暂停、继续、跳过、终止和仅重试失败/需登录项目；
- “最近下载”只显示由 Freepaper 发起并登记的下载；
- 导出基础下载结果 CSV；
- 支持 **简体中文、English、自动跟随浏览器语言**。

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

在“批量下载”中粘贴 DOI/URL，或导入 CSV/TXT 文件。Freepaper 会合并指向同一篇论文的重复入口，并按照队列逐篇处理。

### 人工验证

出版商要求验证码、机构登录或人工确认时，Freepaper 会显示验证助手。请由用户本人完成网站要求的操作，然后点击“继续检测”。

### 语言切换

打开“设置 → 界面语言”，可以选择：

- **自动**：跟随浏览器界面语言；
- **简体中文**；
- **English**。

程序内的选项控制主面板、下载进程窗和网页验证助手。浏览器扩展管理页显示的名称与简短说明由 Chromium `_locales` 根据浏览器语言选择，不受程序内手动选项控制。

## 隐私

Freepaper 不向开发者运营的服务器上传论文清单、浏览记录、登录信息或下载历史，也不包含广告、分析或跟踪 SDK。扩展会按照用户操作直接访问 DOI 服务、学术出版商页面和 PDF 资源地址。

详细说明见双语版 [隐私政策](privacy-policy.md)。

## 权限说明

| 权限 | 用途 |
|---|---|
| `downloads` | 发起 PDF 下载并跟踪由 Freepaper 创建的下载任务 |
| `storage` | 在本地保存设置、队列、恢复状态和 Freepaper 下载历史 |
| `activeTab` | 用户主动操作后检测当前页面 |
| `tabs` | 打开论文页面、绑定任务标签页并回到当前任务 |
| `scripting` | 在论文页面检测 PDF 链接和页面状态 |
| `webNavigation` | 跟踪 DOI 重定向、验证跳转和 PDF 页面切换 |
| `alarms` | 在 MV3 后台被回收后恢复未完成任务 |
| `<all_urls>` | 支持用户选择的不同学术出版商、DOI 和 PDF 地址 |

## 项目结构

```text
.
├── _locales/              # Manifest 中英文语言资源
├── icons/                 # 扩展运行图标
├── store-assets/          # 商店 Logo 和宣传图
├── docs/store/            # Edge/Chrome 中英文上架模板
├── examples/              # 脱敏输入示例
├── background.js
├── content.js
├── i18n.js                # 程序内可切换的中英文资源
├── popup.html
├── popup.js
├── task-monitor.html
├── task-monitor.js
└── manifest.json
```

## 开发检查

项目没有 npm 运行时依赖。安装 Node.js 20 或更高版本后运行：

```bash
npm run check
```

检查内容包括 JavaScript 语法、Manifest 资源、语言文件、版本一致性、旧本地后端残留和不应进入公开仓库的文件。



## 已知限制

- 出版商可能要求机构账号、VPN 或人工验证；
- Freepaper 不能下载用户没有访问权限的内容；
- 出版商页面结构可能变化，需要后续适配；
- 浏览器下载 API 只能保存到浏览器配置的下载目录及其子目录。

## 贡献与安全

提交问题或代码前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请按照 [SECURITY.md](SECURITY.md) 私下报告，不要在公开 Issue 中披露未修复漏洞。

## 许可证与品牌

源代码采用 [Mozilla Public License 2.0](LICENSE)。Freepaper 名称和图标的使用边界见 [TRADEMARKS.md](TRADEMARKS.md)。
