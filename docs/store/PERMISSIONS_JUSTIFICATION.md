# Permissions justification / 权限说明

| Permission | English justification | 中文说明 |
|---|---|---|
| `downloads` | Start PDF downloads and track downloads created by Freepaper. | 发起 PDF 下载并跟踪由 Freepaper 创建的下载。 |
| `storage` | Store settings, language choice, queues, recovery state, and Freepaper download history locally. | 在本地保存设置、语言、队列、恢复状态和 Freepaper 下载历史。 |
| `activeTab` | Scan the current page only after the user explicitly opens the extension or starts an action. | 用户主动打开扩展或发起操作后检测当前页面。 |
| `tabs` | Open paper pages, bind the active task to its tab, and return the user to the task page. | 打开论文页面、绑定任务标签页并回到当前任务页。 |
| `scripting` | Detect PDF candidates and publisher page state needed for the requested download. | 检测用户请求的 PDF 候选和出版商页面状态。 |
| `webNavigation` | Track DOI redirects, verification navigation, and transitions to PDF pages. | 跟踪 DOI 重定向、验证跳转和 PDF 页面切换。 |
| `alarms` | Recover unfinished tasks after the Manifest V3 service worker is suspended. | 在 Manifest V3 后台被回收后恢复未完成任务。 |
| `<all_urls>` | Users may import DOI and paper URLs from many publishers. Cross-site access is used only for user-requested paper detection and PDF download. | 用户可能导入不同出版商的 DOI、论文和 PDF 地址；跨站权限只用于用户主动发起的检测和下载。 |
