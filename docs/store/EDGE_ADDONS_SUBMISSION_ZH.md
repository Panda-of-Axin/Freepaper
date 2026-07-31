# Microsoft Edge Add-ons — 简体中文商店信息

## 上传文件

上传商店运行包 ZIP，`manifest.json` 必须直接位于 ZIP 根目录。

## 商店字段

- **名称：** Freepaper
- **分类：** 生产力
- **语言：** 中文（简体）
- **短描述：** 开源学术论文 PDF 下载扩展，支持批量 DOI/URL、文献去重、下载子文件夹、任务恢复与人工验证接管。

## 详细描述

Freepaper 是一款面向学生和研究人员的开源学术论文 PDF 下载扩展。它可以检测当前论文页面中的 PDF 候选，也可以批量导入 DOI、论文 URL、CSV 或 TXT 清单。

Freepaper 会按照 DOI、arXiv ID、ScienceDirect PII 等文献标识合并重复入口，将 PDF 保存到浏览器下载目录下的自定义子文件夹，并利用持久化状态在页面跳转或 Manifest V3 后台被回收后恢复未完成任务。

扩展主面板是最高级总控台；独立下载进程窗用于持续查看进度；可拖动验证助手只在出版商要求验证码、机构登录或手动打开 PDF 时出现。用户可以暂停、继续、跳过、终止任务，也可以只重试失败或需要登录的论文。“最近下载”只显示由 Freepaper 自己发起并登记的下载。

界面支持简体中文、English 和自动跟随浏览器语言。Freepaper 不向开发者运营的服务器上传论文清单、浏览记录、登录信息或下载历史，也不包含广告、分析或跟踪 SDK。

Freepaper 不绕过付费墙、机构权限、验证码或网站安全措施，用户只能下载自己有权访问的内容。

## Website URL

`https://github.com/<YOUR_GITHUB_USERNAME>/freepaper`

## Privacy policy URL

`https://github.com/<YOUR_GITHUB_USERNAME>/freepaper/blob/main/privacy-policy.md`

## 审核说明

使用 `REVIEWER_TEST_INSTRUCTIONS.md` 中的公开 arXiv 流程测试，不需要开发者提供账号。
