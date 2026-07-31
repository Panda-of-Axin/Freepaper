# Microsoft Edge Add-ons — English listing

## Upload package

Upload the runtime store ZIP. `manifest.json` must be at the ZIP root.

## Listing fields

- **Name:** Freepaper
- **Category:** Productivity
- **Language:** English (United States)
- **Short description:** Open-source academic PDF downloader with batch DOI/URL import, deduplication, subfolders, task recovery, and assisted verification.

## Detailed description

Freepaper is an open-source academic PDF downloader for students and researchers. It can detect PDF candidates on the current paper page or process a batch list imported from DOI entries, paper URLs, CSV, or TXT files.

Freepaper merges duplicate inputs by DOI, arXiv ID, ScienceDirect PII, and other document identifiers. PDFs are saved to a user-defined subfolder under the browser Downloads directory. Persistent task state helps unfinished work recover after page navigation or Manifest V3 service-worker suspension.

The main popup acts as the control center. A separate download monitor provides continuous progress, while the draggable verification assistant appears only when a publisher requires a CAPTCHA, institutional sign-in, or manual PDF action. Users can pause, resume, skip, stop, and retry only failed or login-required papers. Recent downloads shows only downloads created and registered by Freepaper.

The interface supports English, Simplified Chinese, and automatic browser-language detection. Freepaper does not upload paper lists, browsing history, sign-in information, or download history to a developer-operated server and contains no advertising, analytics, or tracking SDK.

Freepaper does not bypass paywalls, institutional permissions, CAPTCHAs, or website security measures. Users may download only content they are authorized to access.

## Website URL

`https://github.com/<YOUR_GITHUB_USERNAME>/freepaper`

## Privacy policy URL

`https://github.com/<YOUR_GITHUB_USERNAME>/freepaper/blob/main/privacy-policy.md`

## Certification notes

Use the reviewer steps in `REVIEWER_TEST_INSTRUCTIONS.md`. No developer-provided account is required for the public arXiv workflow.
