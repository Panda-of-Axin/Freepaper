# Release checklist / 发布检查表

- [ ] Update `manifest.json`, `package.json`, popup version text, and `CHANGELOG.md`.
- [ ] Run `npm run check`.
- [ ] Test Edge in Auto, English, and Simplified Chinese modes.
- [ ] Test Chrome in Auto, English, and Simplified Chinese modes.
- [ ] Verify popup, task monitor, and page verification assistant localization.
- [ ] Verify `_locales/en/messages.json` and `_locales/zh_CN/messages.json` load correctly.
- [ ] Test current-page download, batch download, deduplication, subfolder saving, task recovery, and failed-only retry.
- [ ] Confirm Recent downloads excludes unrelated browser downloads.
- [ ] Capture real English and Chinese store screenshots with no personal information.
- [ ] Replace `<YOUR_GITHUB_USERNAME>` in store documents and manifest homepage URL when available.
- [ ] Create a runtime store ZIP with `manifest.json` at the ZIP root.
- [ ] Create a GitHub source ZIP with documentation and development checks.
- [ ] Calculate and publish SHA-256 checksums.
