# Freepaper release process

The repository is the single source of truth. **Do not publish a new version by uploading an extracted ZIP over the GitHub web UI.** Git records additions, modifications, and deletions together and avoids stale files from older versions.

## One-time setup

Clone the repository once:

```bash
git clone https://github.com/Panda-of-Axin/Freepaper.git
cd Freepaper
```

Future releases use this same working copy.

## Prepare a release

1. Finish code changes and update the new section in `CHANGELOG.md`.
2. Run:

```bash
npm run release -- 2.0.6
```

Replace `2.0.6` with the intended version. The script:

- updates all maintained version surfaces;
- runs `npm run verify`;
- builds Chrome and Edge store ZIPs under `dist/`;
- writes SHA-256 checksums;
- generates release notes from the matching `CHANGELOG.md` section.

3. Inspect the generated files in `dist/`.
4. Commit and push:

```bash
git add -A
git commit -m "release: Freepaper v2.0.6"
git push origin main
```

5. Tag the exact release commit:

```bash
git tag v2.0.6
git push origin v2.0.6
```

## What happens after the tag is pushed

`.github/workflows/release.yml` automatically:

- verifies tag / manifest / package versions match;
- runs the complete test suite;
- rebuilds store packages from the tagged source;
- creates or updates the GitHub Release;
- uploads Chrome ZIP, Edge ZIP, checksums, and generated release notes.

The GitHub repository itself should contain source and documentation, not copied store ZIPs.

## Browser-store submission

Download the corresponding store ZIP from the GitHub Release and upload it to Chrome Web Store / Microsoft Edge Add-ons. Store screenshots and listing text remain manual because the store portals require human review and account access.
