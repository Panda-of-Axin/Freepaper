# Reviewer test instructions / 审核测试步骤

## Public workflow (no account required)

1. Install the extension and open the popup.
2. Open **Settings** and switch between English and Simplified Chinese. Confirm the popup, download monitor, and page verification assistant use the selected language.
3. Set a new download subfolder, such as `freepaper_review_test`.
4. Open **Batch download**.
5. Paste:
   - `10.48550/arXiv.2010.08895`
   - `10.48550/arXiv.2109.03697`
6. Add one duplicate DOI and confirm the UI reports fewer unique papers than input records.
7. Start the task and confirm PDFs are saved under the selected subfolder.
8. Confirm Recent downloads contains only Freepaper-created files.
9. Retry failed/login-required items, if any; successful items must not be downloaded again.

## ScienceDirect

ScienceDirect may require the reviewer's own institutional access or security verification. Freepaper displays an assistant but does not bypass access controls. No developer-provided credentials are available or required for the public arXiv workflow.

## 中文简述

审核人员可使用上述公开 arXiv DOI 测试，无需账号。语言切换位于“设置 → 界面语言”。ScienceDirect 可能要求审核人员自己的机构权限，Freepaper 不绕过验证码或访问控制。
