# Chrome Web Store — 简体中文商店信息

## 上传文件

上传商店运行包 ZIP，`manifest.json` 必须直接位于 ZIP 根目录。

## 产品信息

- **名称：** Freepaper
- **类别：** Productivity / 生产力
- **摘要：** 开源学术论文 PDF 下载扩展，支持批量 DOI/URL、文献去重、下载子文件夹、任务恢复与人工验证接管。

## 详细说明

Freepaper 是面向学生和研究人员的开源学术论文 PDF 下载扩展。用户可以检测当前论文页面中的 PDF，也可以批量导入 DOI、论文 URL、CSV 或 TXT 清单。

扩展会按 DOI、arXiv ID、ScienceDirect PII 等文献标识合并重复入口，将 PDF 保存到浏览器下载目录下的自定义子文件夹，并在重定向、人工验证跳转或 Manifest V3 后台被回收后恢复未完成任务。

主面板是最高级总控台；独立下载进程窗用于持续查看进度；可拖动验证助手只在网站确实要求用户完成验证码、机构登录或手动打开 PDF 时出现。用户可以暂停、继续、跳过、终止任务，也可以只重试失败和需要登录的论文。“最近下载”只记录由 Freepaper 发起，或在人工验证期间与当前任务明确匹配并关联的 PDF；无关浏览器下载会被忽略。

Freepaper 支持简体中文、English 和自动跟随浏览器语言。它不向开发者运营的服务器上传论文清单、浏览记录、登录信息或下载历史，不使用广告、分析或跟踪 SDK。

Freepaper 不绕过付费墙、验证码、机构权限或网站技术措施。

## 单一用途

帮助用户在已有合法访问权限范围内，检测、批量下载并管理学术论文 PDF 下载任务。

## Privacy policy URL

`https://github.com/Panda-of-Axin/freepaper/blob/main/privacy-policy.md`

## 远程代码声明

Freepaper 不从远程服务器加载或执行 JavaScript、WebAssembly 或其他程序逻辑。全部扩展功能逻辑均包含在提交的 Manifest V3 包中。网络访问仅用于打开用户选择的 DOI/论文页面和获取用户请求的 PDF 数据。
