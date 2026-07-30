<div align="center">
  <img src="store-assets/freepaper-logo-300.png" width="128" alt="Freepaper icon">
  <h1>Freepaper</h1>
  <p>Open-source academic PDF downloader for Microsoft Edge and Google Chrome.</p>
  <p><strong>English</strong> · <a href="README.zh-CN.md">简体中文</a></p>
</div>

Current version: **v1.4.0**

> Note: Freepaper is now available on Edge and Chrome browsers. The author holds all related rights. This project is for reference purposes only and may not be used for commercial purposes.

> Freepaper helps users download content they are authorized to access. It does not bypass paywalls, institutional permissions, security verification, or website technical measures.

## Features

- Detect PDF candidates on the current paper page;
- Import DOI/URL lists from pasted text, CSV, or TXT files;
- Deduplicate by DOI, arXiv ID, ScienceDirect PII, and other document identifiers;
- Save PDFs to a custom subfolder under the browser Downloads directory;
- Recover task state after a Manifest V3 service worker restart;
- Provide a main control center, a separate download monitor, and a draggable verification assistant;
- Pause, resume, skip, stop, and retry only failed/login-required papers;
- Show only downloads created and registered by Freepaper in Recent downloads;
- Export a basic CSV result report;
- Switch between **English**, **Simplified Chinese**, or **Auto (browser language)**.

## Browser compatibility

Freepaper uses Chromium Manifest V3 and the standard `chrome.*` extension APIs.

- Microsoft Edge 88 or later;
- Google Chrome 88 or later.

The same runtime ZIP can be submitted to Edge Add-ons and the Chrome Web Store. Development and testing are currently focused on Edge, so a complete Chrome regression test is recommended before publishing there.

## Install locally

1. Download or clone this repository;
2. Open `edge://extensions` or `chrome://extensions`;
3. Enable **Developer mode**;
4. Select **Load unpacked**;
5. Select this repository root—the directory that directly contains `manifest.json`.

## Usage

### Current page

Open a paper page, click the Freepaper icon, and use **Current page** to detect a PDF.

### Batch download

Open **Batch download**, paste DOI/URL entries, or import a CSV/TXT file. Freepaper merges duplicate entries that point to the same paper and processes the queue one item at a time.

### Manual verification

When a publisher requires a CAPTCHA, institutional sign-in, or manual confirmation, Freepaper displays a verification assistant. Complete the website's requested action yourself, then click **Continue**.

### Language

Open **Settings → Language** and choose:

- **Auto**: follow the browser UI language;
- **简体中文**;
- **English**.

The in-app language setting controls the popup, task monitor, and page verification assistant. The extension name and short description shown by the browser follow the browser locale through Chromium `_locales`.

## Privacy

Freepaper does not upload paper lists, browsing history, sign-in information, or download history to a developer-operated server. It contains no advertising, analytics, or tracking SDK. The browser directly accesses DOI services, publisher pages, and PDF URLs requested by the user.

See the bilingual [privacy policy](privacy-policy.md).

## Permissions

| Permission | Purpose |
|---|---|
| `downloads` | Start PDF downloads and track downloads created by Freepaper |
| `storage` | Save local settings, queues, recovery state, and Freepaper download history |
| `activeTab` | Scan the current tab after an explicit user action |
| `tabs` | Open paper pages, bind task tabs, and return to the active task |
| `scripting` | Detect PDF links and page state on paper pages |
| `webNavigation` | Follow DOI redirects, verification navigation, and PDF page transitions |
| `alarms` | Recover unfinished tasks after the MV3 service worker is suspended |
| `<all_urls>` | Support DOI and PDF URLs from different academic publishers selected by the user |

## Repository structure

```text
.
├── _locales/              # Manifest localization: English and Simplified Chinese
├── icons/                 # Runtime extension icons
├── store-assets/          # Store logo and promotional tile
├── docs/store/            # Edge and Chrome submission templates
├── examples/              # Sanitized input examples
├── background.js
├── content.js
├── i18n.js                # User-selectable in-app localization
├── popup.html
├── popup.js
├── task-monitor.html
├── task-monitor.js
└── manifest.json
```

## Development check

The project has no npm runtime dependencies. Install Node.js 20 or later and run:

```bash
npm run check
```

The check validates JavaScript syntax, manifest resources, locale files, version consistency, legacy backend markers, and files that must not enter the public repository.



## Known limitations

- Publishers may require institutional credentials, VPN access, or manual verification;
- Freepaper cannot download content the user is not authorized to access;
- Publisher page structures change and may require future adapter updates;
- The browser download API can save only under the configured browser Downloads directory.

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Report security issues privately as described in [SECURITY.md](SECURITY.md), not in a public issue.

## License and trademarks

Source code is licensed under the [Mozilla Public License 2.0](LICENSE). Use of the Freepaper name and icon is governed separately by [TRADEMARKS.md](TRADEMARKS.md).
