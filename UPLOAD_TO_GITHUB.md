# Upload Freepaper v2.0.2 to GitHub

This folder is the cleaned public repository package for Freepaper v2.0.2.
It intentionally omits old intermediate patch files and obsolete per-version test documents.

## Recommended repository name

Use `Freepaper` as the repository name. Keep software versions in Git tags/releases such as `v2.0.2` rather than in the repository name.

## Method A — GitHub web upload

1. Open your existing GitHub repository.
2. Rename the repository to `Freepaper` first if desired.
3. Open the branch you want to update, normally `main`.
4. Choose **Add file → Upload files**.
5. Upload the CONTENTS of this folder, not this ZIP file itself.
6. Existing files with the same paths will be replaced after you commit the upload; files that you want removed from the old repository should be deleted separately in GitHub or by using Git locally.
7. Use a commit message such as `Release Freepaper v2.0.2`.
8. After the files are updated, create a GitHub Release/Tag named `v2.0.2`.

### Important limitation of browser-only replacement

Uploading new files through the web interface does not automatically remove every obsolete file that existed in the old repository. If the old repository contains files that are absent from this package, delete them separately. Git is cleaner for large replacements because `git add -A` records additions, modifications, and deletions together.

## Method B — Git (recommended for preserving a clean history)

```bash
git clone <YOUR_REPOSITORY_URL>
cd Freepaper
# Copy the contents of this package over the cloned repository, but keep .git/
git status
git add -A
git commit -m "Release Freepaper v2.0.2"
git push origin main
```

Then create the `v2.0.2` Release on GitHub.

## Files intentionally excluded

- Historical `.patch` files from v1.4.x and v2.0.x development iterations
- Obsolete version-specific test documents and regression CSVs
- Local browser profiles, cookies, logs, downloaded papers, `.env` files, keys, and credentials

The retained `CHANGELOG.md` is the public version history.
