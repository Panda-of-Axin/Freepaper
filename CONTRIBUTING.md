# Contributing to Freepaper

感谢参与 Freepaper。

## 提交 Issue

请说明：

- Freepaper 版本；
- Edge 或 Chrome 版本；
- 出版商或页面类型；
- 可脱敏的 DOI/URL 示例；
- 预期结果与实际结果；
- 控制台错误信息。

不要上传个人 Cookie、登录数据、机构账号、浏览器 Profile、未脱敏下载历史或受版权保护的完整论文文件。

## 提交 Pull Request

1. 从最新主分支创建功能分支；
2. 保持免费版完整可用，不添加下载篇数或次数限制；
3. 不引入远程执行代码、广告或跟踪 SDK；
4. 用户导入内容必须通过 `textContent` 或安全 DOM API 渲染；
5. CSV 导出应防止电子表格公式注入；
6. 下载历史只能记录 Freepaper 自己登记的下载；
7. 运行 `npm run check`；
8. 在 PR 中说明 Edge/Chrome 测试范围和已知限制。

## 合规原则

贡献不得以绕过付费墙、验证码、机构权限或出版商访问控制为目标。验证助手只用于让用户完成网站要求的人工步骤。
