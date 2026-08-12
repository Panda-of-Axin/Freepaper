# Release checklist / 发布检查表

## Before preparing

- [ ] Code changes are complete and manually smoke-tested.
- [ ] Add the new `## X.Y.Z` section to `CHANGELOG.md`; do not leave `TODO` in the release section.
- [ ] Confirm no credentials, cookies, browser profiles, downloaded papers, or local logs are tracked.

## Automated preparation

```bash
npm run release -- X.Y.Z
```

The command updates maintained version surfaces, runs the full validation suite, packages Chrome/Edge ZIPs, writes checksums, and generates release notes in `dist/`.

- [ ] `npm run release -- X.Y.Z` exits successfully.
- [ ] `dist/Freepaper_vX.Y.Z_Chrome_Web_Store_Upload.zip` exists.
- [ ] `dist/Freepaper_vX.Y.Z_Edge_Addons_Upload.zip` exists.
- [ ] `dist/SHA256SUMS.txt` exists.
- [ ] `dist/RELEASE_NOTES.md` contains the intended changelog section.

## Git / GitHub

- [ ] `git add -A` includes additions, modifications, **and deletions**.
- [ ] Commit: `release: Freepaper vX.Y.Z`.
- [ ] Push `main`.
- [ ] Tag the same commit as `vX.Y.Z` and push the tag.
- [ ] Confirm the GitHub Release workflow succeeds and assets are attached.

## Store smoke test

- [ ] Test the exact generated package in latest Edge.
- [ ] Test the exact generated package in latest Chrome.
- [ ] Confirm English / Simplified Chinese / Auto localization.
- [ ] Confirm current-page download, batch download, deduplication, subfolder saving, task recovery, and failed-only retry.
- [ ] Confirm dynamic publisher HTML challenge pages are not saved as PDFs.
- [ ] Capture store screenshots from the current release build with personal/institutional information hidden.
