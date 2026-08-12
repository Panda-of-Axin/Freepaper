# Freepaper v2.0.2 代码审计与修复说明

## 1. 本轮实测现象

- IEEE 已经在浏览器 PDF 查看器中显示论文，但下载栏先出现 `stamp.htm`；
- ScienceDirect 已经显示签名 `main.pdf`，下载栏却先出现 `init.htm`；
- HTML 下载失败后，Freepaper 再退回“请手动下载”的提示。

这些现象证明：浏览器标签页成功显示 PDF，与扩展通过 `chrome.downloads.download()` 再次请求同一 URL，是两个不同的网络请求。第二次请求不一定继承第一次导航时的 Referrer、页面上下文、验证跳转和一次性会话条件。

## 2. 对 v2.0.1 源码的核查结果

### 2.1 `autoVerifyAndDownload()` 直接重请求动态 PDF URL

v2.0.1 将 IEEE、Wiley、ScienceDirect、知网的严格 PDF 路由视为可信查看器地址。进入查看器后，`autoVerifyAndDownload()` 会把该 HTTPS URL 交给 `downloadVerifiedResource()`。

这意味着：

```text
浏览器导航请求成功并显示 PDF
→ Freepaper 再调用 chrome.downloads.download(同一URL)
→ 出版商收到第二个脱离论文页面上下文的请求
→ 返回 stamp.htm / init.htm / 验证HTML
```

### 2.2 HTML 只在下载完成后才被删除

`downloadVerifiedResource()` 原先先创建浏览器下载，等待下载完成后再检查 MIME。若 MIME 是 `text/html`，再删除文件和记录。

因此用户一定会先在下载栏看到 `.htm`，即使程序随后将其清理。

### 2.3 IEEE 同时把 `stamp.jsp` 与 `getPDF.jsp` 当作 PDF 路由

v2.0.1 的端点识别同时接受：

```text
/stamp/stamp.jsp
/stampPDF/getPDF.jsp
```

但 `stamp.jsp` 更接近浏览器展示入口，并不是适合直接下载 API 重请求的稳定文件地址。若页面候选排序先命中 `stamp.jsp`，扩展就可能下载到 `stamp.htm`。

### 2.4 ScienceDirect 签名 `main.pdf` 依赖当前访问上下文

ScienceDirect 的 `pdf.sciencedirectassets.com/.../main.pdf?...Token...` 可以在已经完成验证的标签页中显示，但第二次独立下载请求可能被送往初始化或验证 HTML，浏览器据此命名为 `init.htm`。

## 3. v2.0.2 的针对性修复

### 3.1 动态出版商端点禁止直接交给下载 API

以下站点的动态 PDF 路由不再直接调用 `chrome.downloads.download(url)`：

- IEEE；
- Wiley；
- ScienceDirect；
- 知网。

`downloadVerifiedResource()` 和 `downloadPdfThroughDownloadsApi()` 均增加了 `CONTEXT_BOUND_PDF_URL` 防线。

### 3.2 在论文页面上下文中获取 PDF

Freepaper 现在优先在仍保留的论文详情页中执行：

```text
fetch(PDF地址, credentials: include)
→ 检查 HTTP / 登录 / 验证状态
→ 检查文件头 %PDF-
→ 在同一页面创建 Blob URL
→ 同一页面触发下载
```

这样会复用该页面当前的 Cookie、Referrer、机构认证和验证状态。

Blob URL 不会传回 Service Worker 再下载，因为跨页面/扩展来源使用 Blob URL 可能受到存储分区限制。下载动作在创建 Blob 的同一网页上下文完成。

### 3.3 IEEE 路由规范化

所有 IEEE：

```text
/stamp/stamp.jsp?...
```

在自动流程中统一转换为：

```text
/stampPDF/getPDF.jsp?...
```

并保持 `arnumber` 等参数。

### 3.4 保留论文详情页，PDF/验证使用唯一子标签页

v2.0.1 会直接把论文详情标签页更新成 PDF 路由。v2.0.2 改为：

- 保留原论文详情页，作为已登录页面上下文；
- 使用一个任务管理的 PDF/验证子标签页；
- 后续完成机构登录或验证码后，可以再次从原详情页上下文自动获取 PDF；
- 同一任务复用一个 PDF 子标签页，避免页面堆积。

### 3.5 页面内 Blob 下载纳入任务统计和自定义文件夹

页面上下文下载开始前，任务先进入 `WAITING_BROWSER_DOWNLOAD`，并设置 `contextDownloadPending`。

`downloads.onDeterminingFilename` 会将高置信度匹配的 Blob PDF：

- 重命名为论文标题；
- 放入用户设置的 Freepaper 子目录；
- 通过下载事件更新任务成功数。

### 3.6 自动保存不可用时不再制造 HTM

若网站阻止页面上下文 `fetch`，且浏览器内置 PDF 查看器又无法被扩展控制，Freepaper 会：

- 停止自动二次请求；
- 保持 PDF 页面打开；
- 等待用户点击查看器下载按钮；
- 继续监听、重命名、移动并记录该下载。

这比“为了全自动而下载一个 HTML 验证页”更可靠。

## 4. 本轮没有采用的方案

- 不模拟鼠标操作验证码；
- 不控制浏览器 PDF 查看器工具栏；
- 不申请 `debugger` 权限抓取响应正文；
- 不使用严重影响审核与隐私观感的高权限方案；
- 不把同一数据库论文集中处理。

## 5. 需要真实环境验证的部分

静态测试可以确认“不再把动态端点直接交给下载 API”，但以下行为仍取决于实际出版商响应：

- ScienceDirect `/pdfft` 是否允许论文页上下文读取最终 PDF；
- Wiley `/pdfdirect/` 在当前机构网络下是否允许页面内 `fetch`；
- IEEE `getPDF.jsp` 是否在完成认证后直接返回 `%PDF-`；
- 知网下载事件的来源 URL、文件名和 MIME 是否足以完成任务关联。

请按照配套回归文档逐项测试。
