# Changelog

## 2.0.2

- Audited the v2.0.1 runtime after real IEEE and ScienceDirect tests downloaded `stamp.htm` and `init.htm`.
- Confirmed the root cause: a PDF could already be open in the browser, but Freepaper then called `chrome.downloads.download()` on the same context-bound publisher URL, creating a second request without the original article-page request context.
- Canonicalizes IEEE `/stamp/stamp.jsp` routes to `/stampPDF/getPDF.jsp` before any automatic attempt.
- Preserves the article tab and opens publisher PDF/verification routes in one managed child tab, enabling authenticated article-page retries after verification.
- Adds page-context PDF retrieval: the article page fetches the PDF with the user's current session, verifies the `%PDF-` signature, and triggers a Blob download in that same page context.
- Blocks IEEE, Wiley, ScienceDirect, and CNKI dynamic PDF endpoints from being sent directly to the downloads API.
- Allows task-scoped page-context Blob downloads to be claimed, renamed into the configured Freepaper subfolder, and counted.
- Falls back to waiting for the built-in PDF viewer download event instead of creating an HTML download when page-context saving is unavailable.
- Added targeted tests for IEEE canonicalization, ScienceDirect candidate priority, context-bound download blocking, and page-context Blob download matching.

## 2.0.1

- Audited the v2.0 publisher workflow before modification and documented the verified root causes.
- Fixed the IEEE refresh loop by replacing document-ID/click-count retry keys with a stable paper-and-authentication-stage key.
- Treats a successfully opened strict Wiley, ScienceDirect, IEEE, or CNKI PDF route as stronger evidence than a second service-worker fetch; browser PDF viewers now proceed directly to automatic saving.
- Filters Edge/Chrome PDF-viewer wrapper URLs and keeps the original HTTPS PDF URL.
- Added task-scoped `onDeterminingFilename`, delayed download reconciliation, and richer matching so CNKI/browser-initiated PDFs can be named into the Freepaper subfolder and counted.
- Generalized authentication states into institutional authentication, publisher-account login, human verification, purchase/access denied, PDF viewer, and browser-download handoff.
- Fixed the page assistant so precise backend guidance is not replaced by a generic “click View PDF” message, and keeps internal diagnostic codes out of normal user guidance.
- Routes onboarding and popup example-CSV downloads through the extension downloads API.
- Added targeted regression tests and `npm run verify`.

## 2.0.0

- Renamed the v1.4.7 release line to Freepaper v2.0 as the first major public milestone; the feature behavior is unchanged.
- Fixed “Show all instructions” so it expands every onboarding section instead of returning to the first page.
- Embedded the example CSV and added direct download/copy actions.
- Automatically tries one clear PDF action, while leaving CAPTCHAs and sign-in to the user.
- Automatically saves confirmed PDF viewers into the configured Freepaper subfolder.
- Added download-event reconciliation for CNKI and other browser-initiated downloads, reducing completion-count mismatches.
- Reduced fixed navigation waits and avoided duplicate full-PDF verification downloads for guided publishers.
- Preserved original input order instead of grouping by publisher, with the design rationale documented in onboarding/help/README.

## 1.4.6

- Added a first-run onboarding and reusable help/diagnostics page.
- Added a dismissible quick-start card and one-click example CSV download.
- Changed ScienceDirect, Wiley, IEEE and CNKI article pages to assisted mode: users click View PDF / Download PDF; Freepaper keeps task state and watches navigation, repeated verification and downloads.
- Added multi-round verification tracking instead of assuming verification only happens once or twice.
- Added safe PDF-action click observation without automating CAPTCHA, mouse movement or security challenges.
- Added stage-specific instructions in the page assistant and download monitor.
- Added a privacy-safe diagnostic report excluding cookies, passwords, tokens and browser profiles.


## [1.4.5] - 2026-08-03

- Added task-scoped observation of user/browser PDF downloads after manual verification, so CNKI and similar flows can finish automatically without remaining stuck on the verification-success page.
- Manual downloads are claimed only while one recoverable task is waiting, and only when the PDF filename, source domain, or publisher matches the active task.
- Changed page-state inspection to prefer the actual DOM over URL-only inference, preventing challenge/login HTML served on a PDF-looking route from being misclassified as a PDF viewer.
- Added a confirmed built-in-viewer fallback for Wiley, IEEE, ScienceDirect, and CNKI PDF endpoints when page injection or preflight fetch is blocked by CORS or temporary tokens.
- Added an IEEE auto-open guard: after a PDF endpoint redirects back to the article page, Freepaper pauses instead of repeatedly refreshing; an explicit Continue action permits one retry.
- Tightened ScienceDirect PDF route matching so `.ico`, image, script, and other static assets on `sciencedirectassets.com` are never selected as PDF targets.
- Preserved the existing batch size and inter-paper timing behavior; no new download restriction was added.

## [1.4.4] - 2026-08-03

- Added a universal manual-handoff flow for clearly detected captcha, login, institutional authentication, access-denied, and manual-PDF states across academic sites.
- Added generic provider routing for CNKI, Springer, Taylor & Francis, ACS, RSC, and other HTTP(S) article pages without bypassing access controls.
- Changed the content-script scope to all user-visited web pages so the verification assistant can appear on the actual task page when needed.
- Restored the singleton download-monitor window: one window opens when a batch starts, is reused throughout the batch, and is focused rather than duplicated when user action is required.
- Preserved the existing batch size and inter-paper timing behavior; no new download restrictions were introduced.
- Added a CNKI subscription-access regression case and privacy checks confirming no cookies, browser profiles, or user credentials are included in the GitHub package.

## [1.4.3] - 2026-08-03

- Unified the recoverable manual-verification flow for ScienceDirect, Wiley, and IEEE.
- Replaced generic ScienceDirect PDF-button clicking with same-tab navigation to concrete `citation_pdf_url`, `pdfft`, or PDF asset routes.
- Added URL classification so purchase pages and unrelated child tabs are not mistaken for PDF tabs.
- Track and close all task-managed publisher tabs after completion, skip, or batch termination.
- Preserve imported paper titles over challenge, waiting, login, and purchase-page titles such as “请稍候…” or “Purchase Research article”.
- Added Wiley `/doi/epdf/` support alongside `/doi/pdfdirect/` and `/doi/pdf/`.
- Added single-case and full regression test documents; the quick suite avoids duplicate publisher cases during first-pass diagnosis.
- Retained the existing serial workflow and timing without adding a new batch-size or frequency limit.

## [1.4.2] - 2026-08-01

- Added experimental CNKI/CNKI-supported journal PDF link detection.
- Added recognition for official CNKI download and PDF preview endpoints exposed by the current page.
- Added Chinese authentication, access-denied, captcha, and frequency-warning classification.
- Added CNKI deduplication keys and title cleanup.
- Kept the existing serial download behavior without adding a new batch limit or delay.

## 1.4.1

- Fixed IEEE `.jsp` links being incorrectly rejected by the `.js` static-resource rule;
- improved IEEE PDF discovery by prioritizing real `citation_pdf_url`, existing PDF links, and the `stampPDF/getPDF.jsp` endpoint;
- added Wiley DOI-to-PDF candidate construction with `/doi/pdfdirect/` and `/doi/pdf/`, preventing HTML detail pages from being misreported as login-required PDFs;
- batch filenames and task lists now prefer article titles, falling back to DOI only when no title is available;
- ScienceDirect now tries PDF links found directly on the article detail page before entering the manual verification flow;
- batch-created ScienceDirect and probe tabs close automatically after completion;
- retained the existing serial workflow and download timing; no new batch-size or frequency limit was added in this release.

## 1.4.0

- Replaced runtime and store icons with the new high-resolution Freepaper artwork;
- added English and Simplified Chinese manifest localization through `_locales`;
- added an in-app language selector with Auto, 简体中文, and English modes;
- localized the popup, control center, task monitor, and draggable verification assistant;
- added English and Chinese GitHub READMEs and bilingual privacy/store-submission documents;
- retained the v1.3.8 Freepaper-only Recent downloads mechanism.

## 1.3.8

- “最近下载”改为 Freepaper 专属下载登记机制；
- 只显示由 Freepaper 创建并跟踪的下载任务；
- 不再读取或混入浏览器全局 PDF 下载历史；
- Service Worker 重启后仍可恢复已登记的下载 ID；
- 保留 1.3.7 的开源清理、安全 DOM 渲染、CSV 公式注入防护和无本地后端架构。

## 1.3.7

- 删除不再使用的 Python/桌面后端轮询与消息协议；
- 删除历史实现和停用适配器；
- 导入内容、URL、文件名和任务列表改用安全 DOM API 渲染；
- CSV 报告增加电子表格公式注入防护；
- 添加 MPL-2.0、品牌政策、安全政策、贡献指南和 GitHub CI。

