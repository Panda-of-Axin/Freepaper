# Freepaper code-audit guardrails

This document describes the **current** repository guardrails. Historical version-specific audits live under `docs/history/`.

## Runtime safety invariants

- Dynamic publisher PDF endpoints must not be blindly re-requested through `chrome.downloads.download()` when they depend on cookies, Referrer, institutional authentication, or one-time tokens.
- Confirmed PDF bytes should be verified in the authenticated article-page context where possible.
- HTML login/challenge pages must not be intentionally saved with a `.pdf` filename.
- Login, institutional authentication, and CAPTCHA states are recoverable manual states; Freepaper does not bypass them.
- The batch queue remains serial and preserves the user's input order.
- Task state must survive Manifest V3 service-worker suspension.

## Repository checks

Run:

```bash
npm run verify
```

The check suite verifies required runtime files, localization, manifest/package version consistency, JavaScript syntax, key publisher-routing markers, and targeted regressions.

## Historical audits

- `docs/history/v2.0.2/` — page-context PDF download / HTML-download guard audit and validation.
- `docs/history/v2.0.5/` — CNKI/CHNDOI release notes and PR #2 assessment.
