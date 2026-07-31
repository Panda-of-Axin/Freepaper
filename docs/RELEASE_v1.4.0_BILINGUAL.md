# Freepaper v1.4.0 bilingual release guide / 中英文发布说明

## What changed / 本次改动

- Replaced the runtime and store icons with the new high-resolution Freepaper icon.
- Added **Settings → Language** with Auto, Simplified Chinese, and English.
- Localized the popup, control center, task monitor, and page verification assistant.
- Added Chromium `_locales/en` and `_locales/zh_CN` for the browser-visible extension name, short description, and action title.
- Added `README.md` (English default) and `README.zh-CN.md` with language links at the top.
- Added English and Chinese store-listing templates and promotional assets.

## Language behavior / 语言行为

- **Auto** follows the browser UI language.
- A manual selection changes the Freepaper popup, monitor, and verification assistant immediately.
- The extension name and short description shown by the browser use Chromium `_locales` and therefore follow the browser locale.
- The Edge Add-ons and Chrome Web Store descriptions are configured separately in each store dashboard; the in-app language switch cannot change a store page before installation.

## Upload packages / 上传包

- Store upload ZIP: upload separately to Microsoft Edge Add-ons and the Chrome Web Store.
- GitHub repository ZIP: extract and upload its contents to the repository root.
- Store submission documents ZIP: use the bilingual templates, reviewer instructions, privacy guidance, and assets when filling each store dashboard.
