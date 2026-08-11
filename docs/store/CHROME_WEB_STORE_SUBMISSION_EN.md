# Chrome Web Store — English listing

## Upload package

Upload the runtime store ZIP with `manifest.json` at the ZIP root.

## Product details

- **Name:** Freepaper
- **Category:** Productivity
- **Summary:** Open-source academic PDF downloader with batch DOI/URL import, deduplication, subfolders, task recovery, and assisted verification.

## Detailed description

Freepaper is an open-source academic PDF downloader for students and researchers. Detect a PDF on the current paper page, or import a batch list from DOI entries, paper URLs, CSV, or TXT files.

Duplicate inputs are merged using DOI, arXiv ID, ScienceDirect PII, and other document identifiers. PDFs are saved to a custom subfolder under Downloads. Persistent task state helps recover unfinished work after redirects, verification navigation, or Manifest V3 service-worker suspension.

The popup is the main control center. A separate download monitor provides continuous progress, and a draggable verification assistant appears only when the publisher requires a CAPTCHA, institutional sign-in, or manual PDF action. Pause, resume, skip, stop, or retry only failed/login-required papers. Recent downloads includes only files created by Freepaper or a PDF explicitly associated with the active verification task; unrelated browser downloads are ignored.

Freepaper supports English, Simplified Chinese, and automatic browser-language detection. It does not upload paper lists, browsing history, sign-in information, or download history to a developer-operated server and contains no advertising, analytics, or tracking SDK.

Freepaper does not bypass paywalls, access permissions, CAPTCHAs, or website security measures.

## Single purpose

Help users detect, batch-download, and manage academic PDF download tasks for content they are authorized to access.

## Privacy policy URL

`https://github.com/Panda-of-Axin/freepaper/blob/main/privacy-policy.md`

## Remote code declaration

Freepaper does not load or execute remote JavaScript, WebAssembly, or other program logic. All executable extension logic is included in the submitted Manifest V3 package. Network requests are used only to open user-selected DOI/publisher pages and retrieve requested PDF data.
