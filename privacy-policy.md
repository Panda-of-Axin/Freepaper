# Freepaper Privacy Policy / Freepaper 隐私政策

**Last updated / 最后更新：2026-07-27**

[English](#english) · [简体中文](#简体中文)

## English

### Scope

This policy applies to the Freepaper browser extension for Microsoft Edge and Google Chrome.

### Core principle

Freepaper does not upload paper lists, browsing history, sign-in information, cookies, passwords, or download history to a developer-operated server. It contains no advertising, analytics, or user-tracking SDK.

### Network access

To perform a download explicitly requested by the user, Freepaper directly accesses:

- DOI and URL entries entered or imported by the user;
- academic publisher pages;
- PDF URLs provided by publishers or open-access platforms.

These requests are sent by the user's browser directly to the relevant website. The website may process the request under its own privacy policy, cookies, and terms. Freepaper does not relay these requests through a developer server.

### Data stored locally

Freepaper stores data required to perform the user's request in browser extension storage, including:

- the download subfolder and interface language;
- active queues, failure state, and recovery state;
- DOI or URL entries explicitly imported by the user;
- the current assisted-verification task;
- recent downloads created by Freepaper, plus a PDF download that the browser starts from the active task page while Freepaper is explicitly waiting for the user to complete verification or a manual PDF action.

While one assisted task is waiting, Freepaper observes newly created browser downloads only long enough to determine whether a PDF clearly matches that task by publisher/source or filename/title. Matching task downloads are registered so the task can finish; unrelated downloads are ignored and are not displayed.

### Page content and browsing activity

Freepaper processes URLs, page titles, links, and page state only when needed to perform a paper-detection, redirect-tracking, verification, or PDF-download action explicitly requested by the user. This processing occurs locally on the user's device and is not sent to the developer.

### Sign-in information and cookies

Freepaper does not read, export, or upload passwords or cookies. When the browser accesses a publisher page or PDF, the browser may send an existing sign-in session to that same website under normal web rules. Freepaper does not send that session to another domain or to the developer.

### Permissions

| Permission | Purpose |
|---|---|
| `downloads` | Start and track Freepaper downloads; while one assisted task is waiting, associate a new PDF download only when its publisher/source or filename/title clearly matches the active task |
| `storage` | Save local settings, queues, recovery state, and Freepaper download history |
| `activeTab` | Scan the active tab after an explicit user action |
| `tabs` | Open paper pages, bind task tabs, and return to the current task |
| `scripting` | Detect PDF links and page state on relevant paper pages |
| `webNavigation` | Follow DOI redirects, verification navigation, and PDF page transitions |
| `alarms` | Recover unfinished tasks after the Manifest V3 service worker is suspended |
| `<all_urls>` | Support DOI, publisher, and PDF URLs selected or imported by the user |

### Sharing and sale

Freepaper does not sell, rent, or provide user data to advertisers. The developer and third parties cannot remotely inspect the user's paper list, browsing history, or download history through Freepaper.

### Retention and deletion

Settings and task state are stored locally by the browser. Users can clear relevant records in the extension or uninstall the extension to remove its extension storage. PDFs and CSV reports already saved to the computer are not deleted when the extension is uninstalled.

### Third-party websites

Freepaper contains no third-party advertising, analytics, or tracking SDK. DOI services, publishers, and PDF hosting sites visited by the user are independent third parties governed by their own terms and privacy policies.

### Contact and security reports

General questions may be submitted through GitHub Issues. Security vulnerabilities should be reported privately as described in `SECURITY.md` and should not be disclosed in a public issue before a fix is available.

---

## 简体中文

### 适用范围

本隐私政策适用于 Freepaper 在 Microsoft Edge 和 Google Chrome 中运行的浏览器扩展版本。

### 核心原则

Freepaper 不向开发者运营的服务器上传用户的论文清单、浏览记录、登录信息、Cookie、密码或下载历史，也不集成广告、分析或用户跟踪服务。

### 扩展如何联网

为了完成用户主动发起的论文访问和 PDF 下载，Freepaper 会直接访问：

- 用户输入或导入的 DOI、URL；
- 学术出版商的论文页面；
- 出版商或开放获取平台提供的 PDF 资源地址。

这些请求由用户的 Edge 或 Chrome 浏览器直接发送给对应网站。相关网站可能依据其自身隐私政策、Cookie 设置和访问条款处理请求。Freepaper 不会把这些请求转发到开发者服务器。

### 本地处理的数据

Freepaper 会在浏览器本地保存完成用户请求所必需的数据，例如：

- 下载子文件夹和界面语言；
- 当前批量任务、失败状态和恢复信息；
- 用户主动导入的 DOI 或 URL；
- 人工验证流程的当前任务状态；
- 由 Freepaper 发起的下载，以及在当前任务明确等待用户完成验证或手动 PDF 操作期间，由任务页面触发并与当前论文明确匹配的 PDF 下载记录。

当且仅当存在一个正在等待人工操作的任务时，Freepaper 会短暂观察新建下载事件，并根据出版商/来源或文件名/论文标题判断 PDF 是否属于当前任务。只有明确匹配的任务下载才会被登记并用于结束任务；无关下载会被忽略，也不会显示。

### 页面内容和浏览活动

Freepaper 只在实现用户明确请求的论文检测、重定向跟踪、人工验证和 PDF 下载功能时处理相关页面的 URL、标题、链接和页面状态。上述信息在用户设备本地处理，不会发送给开发者。

### 登录信息和 Cookie

Freepaper 不读取、导出或上传用户的密码和 Cookie。浏览器访问出版商页面或 PDF 时，可能按照正常网页访问规则向相应域名携带用户已有的登录会话。Freepaper 不会把登录会话发送给其他域名或开发者服务器。

### 权限用途

| 权限 | 用途 |
|---|---|
| `downloads` | 发起 PDF 下载；跟踪由 Freepaper 创建的下载；并在人工验证任务期间识别由当前任务页面触发、且与当前论文明确匹配的 PDF 下载，以记录任务完成 |
| `storage` | 在本地保存设置、队列、恢复状态和 Freepaper 下载历史 |
| `activeTab` | 用户主动操作后检测当前页面 |
| `tabs` | 打开论文页面、绑定任务标签页并回到当前任务 |
| `scripting` | 在相关论文页面检测 PDF 链接和页面状态 |
| `webNavigation` | 跟踪 DOI 重定向、验证跳转和 PDF 页面切换 |
| `alarms` | 在 Manifest V3 后台被回收后恢复未完成任务 |
| `<all_urls>` | 支持用户选择或导入的不同 DOI、出版商和 PDF 地址 |

### 数据共享与出售

Freepaper 不出售、出租或向广告商提供用户数据，开发者和第三方也无法通过 Freepaper 远程查看用户的论文清单、浏览记录或下载历史。

### 数据保留与删除

扩展设置和任务状态保存在浏览器本地。用户可以通过扩展界面清理相关记录，也可以通过卸载扩展删除浏览器为 Freepaper 保存的扩展数据。已经下载到电脑中的 PDF 和 CSV 报告不会因卸载扩展而自动删除。

### 第三方网站

Freepaper 不集成第三方广告、分析或跟踪 SDK。用户访问的 DOI 服务、学术出版商和 PDF 托管网站属于独立第三方，其服务条款和隐私政策由对应网站负责。

### 联系与安全报告

一般问题可以通过 GitHub Issues 提交。安全漏洞请按照仓库中的 `SECURITY.md` 私下报告，不要在公开 Issue 中披露尚未修复的安全问题。
