# Freepaper v2.0.2 — Page-context PDF download and HTML-download guard

This release fixes a request-context bug confirmed by real IEEE and ScienceDirect tests:

- IEEE PDF viewers could be followed by a `stamp.htm` download;
- ScienceDirect signed `main.pdf` viewers could be followed by an `init.htm` download.

The browser viewer navigation and `chrome.downloads.download(url)` are separate requests. Dynamic publisher endpoints may require the original article-page Referrer, cookies, institutional session, verification transition, or a one-time token. Re-requesting them through the downloads API can return an HTML initialization or challenge page instead of the PDF.

v2.0.2 therefore:

1. blocks IEEE, Wiley, ScienceDirect and CNKI dynamic PDF endpoints from direct downloads-API requests;
2. preserves the article tab as the authenticated retrieval context;
3. verifies `%PDF-` and starts a Blob download in that same page context;
4. canonicalizes IEEE `stamp/stamp.jsp` to `stampPDF/getPDF.jsp`;
5. keeps at most one managed PDF/verification child tab per task;
6. falls back to observing the built-in viewer download instead of creating an HTML file.

See:

- `docs/CODE_AUDIT_v2.0.2_ZH.md`
- `docs/VALIDATION_v2.0.2_ZH.md`
- `examples/regression-page-context-v2.0.2.csv`
