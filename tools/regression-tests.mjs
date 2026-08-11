import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const noopListener = { addListener() {} };
const storage = {};
let downloadCalls = 0;
const chrome = {
  runtime: {
    id: 'freepaper-test',
    getURL: (p) => `chrome-extension://freepaper-test/${p}`,
    onMessage: noopListener,
    onInstalled: noopListener,
    onStartup: noopListener,
  },
  storage: {
    local: {
      async get(keys) {
        if (typeof keys === 'string') return { [keys]: storage[keys] };
        if (Array.isArray(keys)) return Object.fromEntries(keys.map((k) => [k, storage[k]]));
        return { ...storage };
      },
      async set(values) { Object.assign(storage, values); },
      async remove(keys) { for (const key of (Array.isArray(keys) ? keys : [keys])) delete storage[key]; },
    },
  },
  action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
  tabs: {
    async get() { return null; }, async create() { return { id: 1 }; }, async update() {}, async remove() {},
    async sendMessage() {}, onUpdated: noopListener, onCreated: noopListener, onRemoved: noopListener,
  },
  scripting: { async executeScript() { return []; } },
  downloads: {
    async download() { downloadCalls += 1; return 1; }, async search() { return []; }, async cancel() {}, async erase() {}, async removeFile() {},
    onCreated: noopListener, onChanged: noopListener, onDeterminingFilename: noopListener,
  },
  windows: {
    async getAll() { return []; }, async create() { return { id: 1 }; }, async update() {}, async remove() {},
    onCreated: noopListener, onRemoved: noopListener,
  },
  alarms: { create() {}, onAlarm: noopListener },
  webNavigation: {
    onCreatedNavigationTarget: noopListener, onBeforeNavigate: noopListener, onCommitted: noopListener,
    onDOMContentLoaded: noopListener, onCompleted: noopListener,
  },
};
const context = vm.createContext({
  chrome, console, URL, URLSearchParams, TextDecoder, TextEncoder, Uint8Array, Blob,
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval, fetch: async () => { throw new Error('disabled in tests'); },
  location: { hostname: '', href: '', pathname: '', search: '', protocol: 'https:' },
  document: {
    title: '', readyState: 'complete', body: { innerText: '' },
    querySelector: () => null, querySelectorAll: () => [],
  },
});
vm.runInContext(source, context, { filename: 'background.js' });

assert.equal(context.isPublisherPdfEndpoint('https://ieeexplore.ieee.org/stampPDF/getPDF.jsp?tp=&arnumber=9282004', 'ieee'), true);

assert.equal(
  context.canonicalizePublisherPdfUrl('https://ieeexplore.ieee.org/stamp/stamp.jsp?tp=&arnumber=9282004', 'ieee'),
  'https://ieeexplore.ieee.org/stampPDF/getPDF.jsp?tp=&arnumber=9282004',
  'IEEE viewer route must be canonicalized to the real getPDF endpoint',
);
assert.equal(context.isContextBoundPublisherPdfUrl(
  'https://ieeexplore.ieee.org/stampPDF/getPDF.jsp?tp=&arnumber=9282004', 'ieee'), true);
assert.equal(context.isContextBoundPublisherPdfUrl(
  'https://pdf.sciencedirectassets.com/x/main.pdf?token=1', 'sciencedirect'), true);
assert.equal(context.isSafeStandalonePdfUrl(
  'https://pdf.sciencedirectassets.com/x/main.pdf?token=1', 'sciencedirect'), false,
  'signed ScienceDirect assets must not be re-requested through downloads API',
);
const orderedSd = context.publisherContextDownloadCandidates({
  provider: 'sciencedirect',
  url: 'https://www.sciencedirect.com/science/article/pii/S0021999118307125',
  citationPdf: 'https://www.sciencedirect.com/science/article/pii/S0021999118307125/pdfft?download=true',
}, 'https://pdf.sciencedirectassets.com/x/main.pdf?token=1');
assert.match(orderedSd[0], /\/pdfft/i, 'ScienceDirect article-context pdfft endpoint must be preferred over signed main.pdf');

const beforeBlockedDownload = downloadCalls;
const blockedDynamic = await context.downloadVerifiedResource({
  url: 'https://ieeexplore.ieee.org/stampPDF/getPDF.jsp?tp=&arnumber=9282004',
  folder: 'freepaper', filename: 'paper.pdf',
});
assert.equal(blockedDynamic.ok, false);
assert.equal(blockedDynamic.reason, 'CONTEXT_BOUND_PDF_URL');
assert.equal(downloadCalls, beforeBlockedDownload,
  'context-bound publisher endpoints must never reach chrome.downloads.download directly');

const contextBlobTask = {
  provider: 'wiley', status: 'WAITING_BROWSER_DOWNLOAD', contextDownloadPending: true,
  title: 'Machine learning in materials science',
  url: 'https://onlinelibrary.wiley.com/doi/full/10.1002/inf2.12028',
  manualStateStartedAt: Date.now() - 1000,
};
const contextBlobItem = {
  id: 9,
  filename: 'Machine learning in materials science.pdf',
  url: 'blob:https://onlinelibrary.wiley.com/test',
  referrer: 'https://onlinelibrary.wiley.com/doi/full/10.1002/inf2.12028',
  mime: 'application/pdf',
  byExtensionId: 'freepaper-test',
  startTime: new Date().toISOString(),
};
assert.equal(context.downloadItemMatchesTask(contextBlobItem, contextBlobTask), true,
  'page-context Blob downloads must be claimable even when Chrome attributes them to the extension');
assert.equal(context.isPublisherPdfEndpoint('https://onlinelibrary.wiley.com/doi/pdfdirect/10.1002/inf2.12028', 'wiley'), true);
assert.equal(context.isPublisherPdfEndpoint('https://pdf.sciencedirectassets.com/x/main.pdf?token=1', 'sciencedirect'), true);
assert.equal(context.isPublisherPdfEndpoint('https://sdfestaticassets-us-east-1.sciencedirectassets.com/shared-assets/103/images/favSD.ico', 'sciencedirect'), false);

const baseTask = {
  provider: 'ieee', url: 'https://ieeexplore.ieee.org/document/9282004',
  verificationRound: 0, accessRecoveryRound: 0, manualRetryRound: 0,
  activeDocumentId: 'doc-a', pdfActionRound: 0,
};
const firstKey = context.autoPdfAttemptKey(baseTask);
assert.equal(context.autoPdfAttemptKey({ ...baseTask, activeDocumentId: 'doc-b', pdfActionRound: 4 }), firstKey,
  'navigation document IDs and PDF click count must not reopen the same IEEE action');
assert.notEqual(context.autoPdfAttemptKey({ ...baseTask, verificationRound: 1 }), firstKey);
assert.notEqual(context.autoPdfAttemptKey({ ...baseTask, accessRecoveryRound: 1 }), firstKey);

context.chrome.scripting.executeScript = async () => [{ result: 'edge-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html' }];
const viewerUrl = 'https://onlinelibrary.wiley.com/doi/pdfdirect/10.1002/inf2.12028';
assert.equal(await context.extractPdfUrlFromViewerTab(1, viewerUrl), viewerUrl,
  'browser PDF viewer wrapper URL must not replace the original HTTPS PDF URL');

const cnkiTask = {
  provider: 'cnki', status: 'WAITING_BROWSER_DOWNLOAD',
  title: '基于物理信息神经网络的平面问题求解',
  url: 'https://kns.cnki.net/kcms/detail/detail.aspx?dbcode=CMFD&filename=1025096474.nh',
  manualStateStartedAt: Date.now() - 1000,
};
const cnkiItem = {
  id: 7, filename: '基于物理信息神经网络的平面问题求解.pdf',
  url: 'https://bar.cnki.net/bar/download.aspx?dflag=pdfdown&filename=1025096474.nh',
  finalUrl: 'https://bar.cnki.net/bar/download.aspx?dflag=pdfdown&filename=1025096474.nh',
  mime: 'application/pdf', startTime: new Date().toISOString(),
};
assert.ok(context.downloadItemMatchScore(cnkiItem, cnkiTask) >= 70);
assert.equal(context.downloadItemMatchesTask(cnkiItem, cnkiTask), true);

context.location = {
  hostname: 'ieeexplore.ieee.org', href: 'https://ieeexplore.ieee.org/document/9282004',
  pathname: '/document/9282004', search: '', protocol: 'https:',
};
context.document = {
  title: 'Physics-Informed Neural Networks for Power Systems | IEEE Xplore', readyState: 'complete',
  body: { innerText: 'Institutional Sign In Need Full-Text access for your organization? CONTACT IEEE TO SUBSCRIBE' },
  querySelector: (selector) => selector.includes('a[href*="institution"') ? {} : null,
  querySelectorAll: () => [],
};
assert.equal(context.detectSdPageState('ieee').type, 'INSTITUTION_AUTH_REQUIRED');

console.log('Freepaper targeted regression tests passed.');
