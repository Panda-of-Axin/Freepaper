# Localization guide / 商店多语言说明

## Extension interface

- `_locales/en/messages.json` and `_locales/zh_CN/messages.json` localize the manifest name, description, and action title according to the browser locale.
- `i18n.js` provides an in-app switch: Auto, Simplified Chinese, or English.
- The in-app override does not change the browser's extension-management language; it changes the Freepaper popup, monitor, and verification assistant.

## Microsoft Edge Add-ons

In Partner Center, open **Store listings → Add a language** and add both English and Simplified Chinese. Complete the required description and assets for each language. The language declared in the store must have a reasonably equivalent localized product experience.

## Chrome Web Store

After uploading a package with `_locales/en` and `_locales/zh_CN`, the Store Listing page provides a locale selector. Enter a detailed description for each locale and upload localized screenshots where useful.

## GitHub

GitHub does not provide a built-in README language switch. This repository uses linked files instead:

- `README.md` — English default;
- `README.zh-CN.md` — Simplified Chinese;
- language links at the top of both files.
