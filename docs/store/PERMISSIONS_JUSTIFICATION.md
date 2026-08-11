# Permissions justification / 权限说明

| Permission | English justification | 中文说明 |
|---|---|---|
| `downloads` | Start and track Freepaper downloads. While one task is explicitly waiting for verification or a manual PDF action, observe new download events only to associate a PDF that clearly matches the active task by publisher/source or filename/title; unrelated downloads are ignored. | 发起并跟踪 Freepaper 下载；仅在一个任务明确等待验证或手动 PDF 操作时，观察新建下载事件，并只关联出版商/来源或文件名/标题与当前任务明确匹配的 PDF；无关下载会被忽略。 |
| `storage` | Store settings, language choice, queues, recovery state, and Freepaper download history locally. | 在本地保存设置、语言、队列、恢复状态和 Freepaper 下载历史。 |
| `activeTab` | Scan the current page only after the user explicitly opens the extension or starts an action. | 用户主动打开扩展或发起操作后检测当前页面。 |
| `tabs` | Open paper pages, bind the active task to its tab, and return the user to the task page. | 打开论文页面、绑定任务标签页并回到当前任务页。 |
| `scripting` | Detect PDF candidates and clearly identified verification/login states on the user-requested task page. | 在用户请求处理的任务页中检测 PDF 候选及明确的验证/登录状态。 |
| `webNavigation` | Track DOI redirects, verification navigation, and transitions to PDF pages. | 跟踪 DOI 重定向、验证跳转和 PDF 页面切换。 |
| `alarms` | Recover unfinished tasks after the Manifest V3 service worker is suspended. | 在 Manifest V3 后台被回收后恢复未完成任务。 |
| `<all_urls>` | Users may import DOI and paper URLs from many publishers. Cross-site access is used only for user-requested paper detection, PDF download, and displaying the page-action assistant on the actual task page when verification or login is required. | 用户可能导入不同出版商的 DOI、论文和 PDF 地址；跨站权限只用于用户主动发起的检测、下载，以及在实际任务页需要验证或登录时显示操作助手。 |
