# Freepaper v2.0.2 功能验证与回归测试文档

## 1. 安装准备

1. 终止旧版本中仍在运行的批量任务；
2. 解压 `Freepaper_v2.0.2_本地完整替换包.zip`；
3. 用其中 `extension` 文件夹覆盖旧目录；
4. 在 `edge://extensions` 或 `chrome://extensions` 点击“重新加载”；
5. 确认版本为 `2.0.2`；
6. 浏览器下载目录中先删除本轮旧的 `stamp.htm`、`init.htm`，便于观察。

## 2. 必须满足的总体验收标准

- IEEE 测试过程中不得创建 `stamp.htm`；
- ScienceDirect 测试过程中不得创建 `init.htm`；
- 动态 PDF 地址自动保存失败时，只能进入等待查看器下载，不得再产生 HTML 下载；
- 页面上下文自动下载成功时，PDF 应进入设置的 Freepaper 子文件夹；
- PDF 实际完成后，任务成功数必须增加；
- 同一篇论文只保留一个论文详情页和最多一个 PDF/验证子标签页；
- 验证码、学校认证和出版商账号登录仍由用户本人完成。

## 3. IEEE 测试

测试论文：`https://ieeexplore.ieee.org/document/9282004`

### 预期流程

```text
IEEE详情页
→ Freepaper规范化为 stampPDF/getPDF.jsp
→ 优先从IEEE详情页上下文验证PDF
→ 成功：直接生成PDF下载并进入Freepaper文件夹
→ 需要认证：打开一个PDF/验证子标签页
→ 用户完成认证
→ Freepaper再次从详情页上下文尝试下载
```

### 检查项

- 地址候选不能以 `/stamp/stamp.jsp` 直接进入下载 API；
- 下载栏不得出现 `stamp.htm`；
- 不得在详情页与 PDF 页之间无限刷新；
- 成功文件必须是 `%PDF-` 开头的 PDF；
- 文件名优先使用论文标题。

## 4. Wiley 测试

测试论文：`https://onlinelibrary.wiley.com/doi/full/10.1002/inf2.12028`

### 检查项

- 优先尝试 `/doi/pdfdirect/`；
- 页面上下文下载成功时，不应先打开一个 HTML 文件；
- 若 PDF 查看器已打开但页面内保存被网站阻止，界面应明确进入“等待浏览器下载”；
- 用户点击查看器下载后，文件应进入 Freepaper 子目录并计数。

## 5. ScienceDirect 测试

测试论文：`https://www.sciencedirect.com/science/article/pii/S0021999118307125`

### 检查项

- 优先使用详情页公开的 `/pdfft` 或 `citation_pdf_url`；
- `main.pdf` 可以作为 PDF 查看器证据，但不得直接交给下载 API进行第二次请求；
- 下载栏不得出现 `init.htm`；
- 若出现验证，完成验证后应自动恢复；
- 页面上下文保存成功时，PDF进入 Freepaper 子目录；
- 页面上下文保存失败时，保留 PDF 查看器并等待用户点击下载，不再尝试下载 HTML。

## 6. 知网测试

使用自己在校园网或机构账号下有权限下载的知网文献。

### 检查项

- 登录或验证必须由用户本人完成；
- 下载开始前，任务界面应显示等待浏览器下载；
- 用户或页面触发 PDF 下载后，Freepaper 应在文件名确定阶段将其放入子目录；
- 下载完成后任务成功数增加；
- 不得把其他同时进行的无关 PDF 下载误认领为当前文献。

## 7. 普通 PDF 对照测试

使用 CSV 中的 arXiv 文献。

预期：普通稳定 PDF 直链继续由扩展正常下载，不受动态端点保护逻辑影响。

## 8. 失败信息收集

若仍失败，请保留：

- 当前论文网址；
- 下载栏文件名和大小；
- Freepaper 任务状态与提示；
- 是否出现登录/验证；
- 导出的任务 CSV；
- 脱敏诊断报告。

不要提交 Cookie、密码、浏览器 Profile 或机构登录令牌。
