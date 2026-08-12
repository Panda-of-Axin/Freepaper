# Freepaper validation plan

This is the reusable validation plan for the current release. It intentionally does not contain a hard-coded version number.

## Automated validation

```bash
npm run verify
```

This runs repository checks plus targeted regression tests.

## Required manual smoke tests before a store submission

1. Load the unpacked extension in the latest Edge and Chrome.
2. Confirm the popup, task monitor, onboarding/help page, and page assistant open without console errors.
3. Confirm Auto / English / Simplified Chinese language modes.
4. Run a public arXiv DOI/URL download and confirm the file is saved to the configured Freepaper subfolder.
5. Run duplicate input and confirm only unique papers are processed.
6. Confirm failed/login-required retry does not redownload already successful papers.
7. Test at least one authentication-required publisher flow with an account/institution the tester is authorized to use; the task must wait for the user rather than bypass authentication.
8. Verify a dynamic publisher challenge page is not saved as `stamp.htm`, `init.htm`, or a fake `.pdf`.
9. For CNKI, verify DOI resolver handoff and recoverable login using an authorized institutional session when available.
10. Close/reopen the popup and allow the service worker to suspend; unfinished task state should recover.

## Store-specific checks

Use `docs/store/REVIEWER_TEST_INSTRUCTIONS.md` and `docs/store/STORE_ASSETS_CHECKLIST.md`.
