# Freepaper v2.0.5 — Release Notes

**Release title:** Freepaper v2.0.5 — CNKI / CHNDOI DOI-resolution fixes  
**Tag:** `v2.0.5`

## English

Freepaper v2.0.5 improves the CNKI workflow for DOI-driven tasks and keeps authentication recoverable instead of treating it as a terminal failure.

### Highlights

- **Recoverable CNKI login/authentication:** when CNKI requires login or institutional authentication, the current paper now waits for the user and resumes detection after authentication instead of immediately being counted as failed.
- **Safer DOI handoff:** DOI tasks wait until the resolver has actually reached the publisher/article page before PDF detection begins.
- **CHNDOI multi-target resolver support:** pages under `chndoi.org/Resolution/Handler` are recognized as resolver pages rather than article pages. Freepaper extracts the available HURL targets, prefers the domestic `link.cnki.net` route for CNKI records, and continues to the actual paper page.
- **Regression case added:** DOI `10.13250/j.cnki.wndz.25110501` is covered across the `doi.org → chndoi.org → link.cnki.net / CNKI` navigation path.
- **Existing v2.0.2 PDF safety behavior is preserved:** dynamic IEEE, Wiley, ScienceDirect, and CNKI PDF endpoints are handled in authenticated page context where possible, and HTML challenge pages are not intentionally saved as PDFs.

### Upgrade notes

- Browser permissions are unchanged from v2.0.2; only the manifest version changes to 2.0.5.
- CNKI support remains experimental because page structure and institutional authentication flows vary by institution.
- Freepaper does not bypass paywalls, CAPTCHAs, institutional permissions, or publisher access controls.

### Verification

`npm run verify` passed for the packaged source:
- extension checks passed;
- targeted regression tests passed.

---

## 中文

Freepaper v2.0.5 主要修复 **知网 DOI 输入、登录等待以及 CHNDOI 多重解析页面** 的处理流程。

### 本版重点

- **知网登录/机构认证改为可恢复等待状态：** 遇到需要登录时不再直接判定失败，也不会立刻结束当前批量任务；用户完成登录后可以继续检测当前论文。
- **修复 DOI 过早扫描：** DOI 输入会等待解析器真正跳转到出版商/论文页面后，再开始 PDF 检测。
- **支持 CHNDOI 多重解析地址选择页：** `chndoi.org/Resolution/Handler` 不再被误判为论文页。Freepaper 会读取页面提供的 HURL，并对知网记录优先选择境内 `link.cnki.net` 路线，再继续进入真实论文页面。
- **加入针对性回归用例：** DOI `10.13250/j.cnki.wndz.25110501` 已覆盖 `doi.org → chndoi.org → link.cnki.net / CNKI` 跳转流程。
- **保留 v2.0.2 的 PDF 安全策略：** IEEE、Wiley、ScienceDirect、知网等动态 PDF 地址尽量在已认证的论文页面上下文中获取，并避免把 HTML 验证页误保存成 PDF。

### 升级说明

- 与 v2.0.2 相比，浏览器权限没有新增，仅版本号更新为 2.0.5。
- 知网支持仍属于实验性功能，不同学校、机构账号和知网页面结构可能存在差异。
- Freepaper 不绕过付费墙、验证码、机构权限或出版商访问控制。

### 验证结果

打包前已执行 `npm run verify`：
- extension checks passed；
- targeted regression tests passed。
