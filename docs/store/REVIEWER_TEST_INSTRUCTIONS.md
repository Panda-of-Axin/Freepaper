# Reviewer test instructions / 审核测试步骤

Target version: **Freepaper v2.0.2**

## Public workflow (no account required)

1. Install the extension. Confirm the first-run guide opens and that **Show all instructions** expands all guide sections on the same page.
2. Download or copy the embedded example CSV from the guide or popup. No external server is required.
3. Open **Settings** and switch between English and Simplified Chinese. Confirm the popup, download monitor, and page verification assistant use the selected language.
4. Set a new download subfolder, such as `freepaper_review_test`.
5. Open **Batch download**.
6. Paste:
   - `10.48550/arXiv.2010.08895`
   - `10.48550/arXiv.2109.03697`
7. Add one duplicate DOI and confirm the UI reports fewer unique papers than input records.
8. Start the task and confirm PDFs are saved under the selected subfolder.
9. Confirm Recent downloads contains only Freepaper-created files or the PDF explicitly downloaded from the active assisted-verification task; unrelated downloads remain absent.
10. Retry failed/login-required items, if any; successful items must not be downloaded again.

## ScienceDirect

ScienceDirect may require the reviewer's own institutional access or security verification. Freepaper may automatically open one clearly identified View PDF / Download PDF action, but it never automates CAPTCHA or institutional sign-in. It pauses for the reviewer and resumes after the reviewer completes the required step. Freepaper displays an assistant but does not bypass access controls. No developer-provided credentials are available or required for the public arXiv workflow.

## 中文简述

审核人员可使用上述公开 arXiv DOI 测试，无需账号。语言切换位于“设置 → 界面语言”。ScienceDirect 可能要求审核人员自己的机构权限，Freepaper 不绕过验证码或访问控制。


## v2.0.2 dynamic-PDF guard

Dynamic IEEE, Wiley, ScienceDirect and CNKI PDF endpoints are not re-requested directly through the downloads API. Freepaper first verifies the `%PDF-` signature in the authenticated article-page context. Tests must not create `stamp.htm` or `init.htm`. If the site blocks page-context saving, the PDF viewer remains open and the extension waits for its download event.
