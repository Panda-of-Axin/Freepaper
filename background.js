/* This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
 * If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// background.js — Freepaper 扩展后台 Service Worker
'use strict';

// =========================================================================
// ScienceDirect 人工接管：唯一状态源 + 可恢复浮窗
// =========================================================================
const SD_STORAGE_KEY = 'sd_state';
const SD_TERMINAL_STATUSES = new Set(['DONE', 'FAILED', 'STOPPED']);
// 页面浮窗只在确实需要用户介入时出现。处理中、跳转中、自动下载中均由
// 主面板/任务监控窗展示，避免验证助手长期遮挡论文页面。
const SD_OVERLAY_STATUSES = new Set([
  'WAITING_CHALLENGE_1',
  'WAITING_CHALLENGE_2',
  'WAITING_MANUAL_PDF',
  'ACCESS_DENIED',
]);
const SD_MANUAL_STATUSES = new Set([
  'WAITING_CHALLENGE_1',
  'WAITING_CHALLENGE_2',
  'WAITING_MANUAL_PDF',
  'ACCESS_DENIED',
]);
const TASK_MONITOR_WINDOW_KEY = 'freepaper_task_monitor_window_id';
const TASK_MONITOR_URL = chrome.runtime.getURL('task-monitor.html');
const FREEPAPER_DOWNLOAD_REGISTRY_KEY = 'freepaper_download_registry';
const FREEPAPER_RECENT_DOWNLOADS_KEY = 'freepaper_recent_downloads';
const FREEPAPER_RECENT_DOWNLOADS_MAX = 50;
let taskMonitorEnsurePromise = null;
let downloadMetadataQueue = Promise.resolve();
const sdTaskQueues = new Map();

function runSdTaskExclusive(taskId, operation) {
  const previous = sdTaskQueues.get(taskId) || Promise.resolve();
  const queued = previous.catch(() => {}).then(operation);
  sdTaskQueues.set(taskId, queued);
  return queued.finally(() => {
    if (sdTaskQueues.get(taskId) === queued) sdTaskQueues.delete(taskId);
  });
}

async function getFreepaperSettings() {
  const data = await chrome.storage.local.get('freepaper_settings');
  return {
    downloadFolder: 'freepaper',
    autoOpenTaskMonitorOnChallenge: false,
    ...(data.freepaper_settings || {}),
  };
}


function normalizeDownloadFolder(value) {
  const raw = String(value || 'freepaper').trim().replace(/\\/g, '/');
  const parts = raw.split('/')
    .map((part) => part.trim())
    .filter((part) => part && part !== '.' && part !== '..')
    .map((part) => part.replace(/[<>:"|?*\x00-\x1F]/g, '_').replace(/[. ]+$/g, '').slice(0, 80))
    .filter(Boolean);
  return parts.join('/') || 'freepaper';
}

function sanitizePdfFilename(value) {
  let name = String(value || 'paper.pdf').trim().replace(/\\/g, '/').split('/').pop() || 'paper.pdf';
  name = name.replace(/[<>:"|?*\x00-\x1F]/g, '_').replace(/[. ]+$/g, '').slice(0, 170);
  if (!/\.pdf$/i.test(name)) name += '.pdf';
  return name || 'paper.pdf';
}

function buildDownloadRelativePath(folder, filename) {
  return `${normalizeDownloadFolder(folder)}/${sanitizePdfFilename(filename)}`;
}

function withDownloadMetadataLock(operation) {
  const run = downloadMetadataQueue.catch(() => {}).then(operation);
  downloadMetadataQueue = run.catch(() => {});
  return run;
}

async function registerFreepaperDownload(downloadId, metadata = {}) {
  if (!Number.isInteger(downloadId)) return;
  await withDownloadMetadataLock(async () => {
    const data = await chrome.storage.local.get(FREEPAPER_DOWNLOAD_REGISTRY_KEY);
    const registry = data[FREEPAPER_DOWNLOAD_REGISTRY_KEY] || {};
    registry[String(downloadId)] = {
      downloadId,
      relativePath: metadata.relativePath || '',
      sourceUrl: metadata.sourceUrl || '',
      startedAt: metadata.startedAt || Date.now(),
    };

    // 清理七天前未完成或已丢失的旧登记，避免注册表无限增长。
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const [key, value] of Object.entries(registry)) {
      if (!value || Number(value.startedAt || 0) < cutoff) delete registry[key];
    }
    await chrome.storage.local.set({ [FREEPAPER_DOWNLOAD_REGISTRY_KEY]: registry });
  });
}

async function unregisterFreepaperDownload(downloadId) {
  if (!Number.isInteger(downloadId)) return;
  await withDownloadMetadataLock(async () => {
    const data = await chrome.storage.local.get(FREEPAPER_DOWNLOAD_REGISTRY_KEY);
    const registry = data[FREEPAPER_DOWNLOAD_REGISTRY_KEY] || {};
    if (!(String(downloadId) in registry)) return;
    delete registry[String(downloadId)];
    await chrome.storage.local.set({ [FREEPAPER_DOWNLOAD_REGISTRY_KEY]: registry });
  });
}

async function finalizeRegisteredFreepaperDownload(downloadId, suppliedItem = null) {
  if (!Number.isInteger(downloadId)) return false;
  return withDownloadMetadataLock(async () => {
    const data = await chrome.storage.local.get([
      FREEPAPER_DOWNLOAD_REGISTRY_KEY,
      FREEPAPER_RECENT_DOWNLOADS_KEY,
    ]);
    const registry = data[FREEPAPER_DOWNLOAD_REGISTRY_KEY] || {};
    const metadata = registry[String(downloadId)];
    if (!metadata) return false;

    let item = suppliedItem;
    if (!item) {
      try {
        const results = await chrome.downloads.search({ id: downloadId });
        item = results?.[0] || null;
      } catch (_) {
        item = null;
      }
    }
    if (!item || item.state !== 'complete') return false;

    const completedAt = item.endTime ? new Date(item.endTime).getTime() : Date.now();
    const record = {
      downloadId,
      filename: item.filename || metadata.relativePath || '',
      fileSize: item.fileSize || 0,
      url: item.finalUrl || item.url || metadata.sourceUrl || '',
      startTime: item.startTime || new Date(metadata.startedAt || Date.now()).toISOString(),
      endTime: item.endTime || new Date(completedAt).toISOString(),
      timestamp: Number.isFinite(completedAt) ? completedAt : Date.now(),
    };

    const recent = Array.isArray(data[FREEPAPER_RECENT_DOWNLOADS_KEY])
      ? data[FREEPAPER_RECENT_DOWNLOADS_KEY]
      : [];
    const withoutSame = recent.filter((entry) => entry?.downloadId !== downloadId);
    withoutSame.unshift(record);
    withoutSame.sort((a, b) => Number(b?.timestamp || 0) - Number(a?.timestamp || 0));
    if (withoutSame.length > FREEPAPER_RECENT_DOWNLOADS_MAX) {
      withoutSame.length = FREEPAPER_RECENT_DOWNLOADS_MAX;
    }

    delete registry[String(downloadId)];
    await chrome.storage.local.set({
      [FREEPAPER_DOWNLOAD_REGISTRY_KEY]: registry,
      [FREEPAPER_RECENT_DOWNLOADS_KEY]: withoutSame,
    });
    return true;
  });
}

async function downloadVerifiedResource({ url = '', blobUrl = '', folder = 'freepaper', filename = 'paper.pdf' } = {}) {
  const relativePath = buildDownloadRelativePath(folder, filename);
  const candidates = [...new Set([blobUrl, url].filter((item) => typeof item === 'string' && item))];
  let lastError = '没有可下载的 URL';

  for (const candidate of candidates) {
    let downloadId = null;
    try {
      downloadId = await chrome.downloads.download({
        url: candidate,
        filename: relativePath,
        conflictAction: 'uniquify',
        saveAs: false,
      });
      await registerFreepaperDownload(downloadId, {
        relativePath,
        sourceUrl: url || candidate,
        startedAt: Date.now(),
      });
      const completed = await waitForDownloadId(downloadId, DOWNLOAD_WAIT_TIMEOUT_MS);
      if (completed) {
        await finalizeRegisteredFreepaperDownload(downloadId);
        return {
          ok: true,
          downloadId,
          filename: completed.filename || relativePath,
          fileSize: completed.fileSize || 0,
          finalUrl: completed.url || url || candidate,
        };
      }
      lastError = 'DOWNLOAD_TIMEOUT';
      try { await chrome.downloads.cancel(downloadId); } catch (_) {}
      await unregisterFreepaperDownload(downloadId);
    } catch (error) {
      lastError = error.message || 'DOWNLOAD_API_FAILED';
      if (Number.isInteger(downloadId)) {
        try { await chrome.downloads.cancel(downloadId); } catch (_) {}
        await unregisterFreepaperDownload(downloadId);
      }
    }
  }

  return { ok: false, reason: 'DOWNLOAD_API_FAILED', error: lastError, relativePath };
}

async function getSdTask() {
  const data = await chrome.storage.local.get(SD_STORAGE_KEY);
  return data[SD_STORAGE_KEY] || null;
}

function sdStatusMessage(task) {
  const messages = {
    OPENING: '正在打开论文页面…',
    ARTICLE_READY: '文章页已就绪，正在打开 PDF…',
    OPENING_PDF: '正在打开 PDF 页面…',
    PDF_PAGE_READY: 'PDF 页面已就绪，正在验证并下载…',
    DOWNLOADING_PDF: '已锁定当前 PDF，正在下载，请勿重复操作…',
    CHECKING_AFTER_CHALLENGE: '正在等待页面跳转稳定并重新检测，请不要重复点击。',
    WAITING_CHALLENGE_1: '请完成第一次安全验证，然后点击“我已完成，继续”。',
    WAITING_CHALLENGE_2: 'PDF 页面出现第二次安全验证，请完成后点击“我已完成，继续”。',
    WAITING_MANUAL_PDF: '自动下载未成功。请手动点击页面中的 View PDF / Download PDF，然后点击继续。',
    ACCESS_DENIED: '访问被拒绝。请检查机构登录、VPN 或访问权限，然后点击继续重试；也可以跳过此篇。',
    DONE: 'PDF 已下载，正在继续下一篇。',
    FAILED: '当前论文下载失败。',
    STOPPED: '当前论文已停止。',
  };
  return messages[task?.status] || '处理中…';
}

function sdOverlayPayload(task) {
  if (!task || !SD_OVERLAY_STATUSES.has(task.status)) return null;
  return {
    taskId: task.id,
    status: task.status,
    phase: task.status === 'WAITING_CHALLENGE_2' || task.challengePhase === 2 ? 2 : 1,
    doi: task.doi || '',
    message: sdStatusMessage(task),
    updatedAt: task.updatedAt || Date.now(),
  };
}

function isTaskTab(task, tabId) {
  if (!task || tabId == null) return false;
  return [task.activeTabId, task.articleTabId, task.pdfTabId].filter(Number.isInteger).includes(tabId);
}

async function getOverlayStateForTab(tabId) {
  const task = await getSdTask();
  const payload = sdOverlayPayload(task);
  return {
    show: Boolean(payload && isTaskTab(task, tabId)),
    payload,
  };
}

async function pushOverlayState(tabId, retry = true) {
  if (!Number.isInteger(tabId)) return;
  const state = await getOverlayStateForTab(tabId);
  const message = state.show
    ? { type: 'SHOW_OVERLAY', payload: state.payload }
    : { type: 'HIDE_OVERLAY' };
  const delays = retry ? [0, 250, 900] : [0];
  for (const delay of delays) {
    if (delay) await sleep(delay);
    try {
      await chrome.tabs.sendMessage(tabId, message);
      return;
    } catch (_) {
      // 新文档的 content script 可能尚未完成 document_start 初始化；后续重试，
      // 同时 content.js 会在启动时主动请求状态，因此消息丢失也能恢复。
    }
  }
}

async function getTaskMonitorWindowId() {
  const data = await chrome.storage.local.get(TASK_MONITOR_WINDOW_KEY);
  return Number.isInteger(data[TASK_MONITOR_WINDOW_KEY]) ? data[TASK_MONITOR_WINDOW_KEY] : null;
}

function isTaskMonitorWindow(win) {
  return Boolean(win?.tabs?.some((tab) => {
    const url = tab.pendingUrl || tab.url || '';
    const normalized = url.split('#')[0].split('?')[0];
    return normalized === TASK_MONITOR_URL;
  }));
}

async function findTaskMonitorWindows() {
  try {
    const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['popup'] });
    return windows.filter(isTaskMonitorWindow);
  } catch (_) {
    return [];
  }
}

async function resolveSingleTaskMonitorWindow() {
  const storedId = await getTaskMonitorWindowId();
  const monitorWindows = await findTaskMonitorWindows();

  let canonical = null;
  if (Number.isInteger(storedId)) {
    canonical = monitorWindows.find((win) => win.id === storedId) || null;
  }
  if (!canonical && monitorWindows.length > 0) canonical = monitorWindows[0];

  if (canonical) {
    const duplicates = monitorWindows.filter((win) => win.id !== canonical.id);
    if (duplicates.length > 0) {
      console.warn('[Freepaper] 检测到重复任务监控窗，正在合并:', duplicates.map((win) => win.id));
      await Promise.allSettled(duplicates.map((win) => chrome.windows.remove(win.id)));
    }
    if (storedId !== canonical.id) {
      await chrome.storage.local.set({ [TASK_MONITOR_WINDOW_KEY]: canonical.id });
    }
    return canonical.id;
  }

  if (Number.isInteger(storedId)) {
    await chrome.storage.local.remove(TASK_MONITOR_WINDOW_KEY);
  }
  return null;
}

async function createTaskMonitorWindow() {
  try {
    // 创建前最后再查一次，覆盖“前一个并发分支刚完成创建但还没写入 ID”的极窄窗口。
    const existingId = await resolveSingleTaskMonitorWindow();
    if (Number.isInteger(existingId)) return existingId;

    const created = await chrome.windows.create({
      url: TASK_MONITOR_URL,
      type: 'popup',
      width: 390,
      height: 560,
      focused: true,
    });
    if (Number.isInteger(created?.id)) {
      await chrome.storage.local.set({ [TASK_MONITOR_WINDOW_KEY]: created.id });
      // 首次自动弹出时，webNavigation、tabs.onUpdated 和 storage 恢复可能同时到达。
      // 等窗口登记完成后再全量扫描一次，只保留一个真实窗口。
      await sleep(180);
      return (await resolveSingleTaskMonitorWindow()) || created.id;
    }
  } catch (error) {
    console.warn('[Freepaper] 无法创建任务监控窗:', error.message);
  }
  return null;
}

async function ensureTaskMonitorWindow({ focus = false } = {}) {
  // 首次进入人工验证状态时，onUpdated/webNavigation/saveSdTask 可能几乎同时触发。
  // 用 single-flight 锁把“查找/创建窗口”串行化，避免每个并发分支都创建一个 popup。
  if (!taskMonitorEnsurePromise) {
    taskMonitorEnsurePromise = (async () => {
      const existingId = await resolveSingleTaskMonitorWindow();
      return Number.isInteger(existingId) ? existingId : createTaskMonitorWindow();
    })().finally(() => {
      taskMonitorEnsurePromise = null;
    });
  }

  let windowId = await taskMonitorEnsurePromise;
  // 即使 Service Worker 恰好在创建过程中被唤醒/恢复，也在返回前做一次最终去重。
  windowId = (await resolveSingleTaskMonitorWindow()) || windowId;
  if (focus && Number.isInteger(windowId)) {
    try {
      await chrome.windows.update(windowId, { focused: true });
    } catch (_) {
      // 窗口恰好被用户关闭时，下次调用会重新创建。
    }
  }
  return windowId;
}

async function focusTaskTab() {
  const task = await getSdTask();
  const batch = await loadBatchState().catch(() => null);
  const tabId = [
    task?.activeTabId, task?.pdfTabId, task?.articleTabId, batch?.activeTabId,
  ].find(Number.isInteger);
  if (!Number.isInteger(tabId)) return { ok: false, reason: 'task_tab_missing' };
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    if (Number.isInteger(tab.windowId)) await chrome.windows.update(tab.windowId, { focused: true });
    return { ok: true, tabId };
  } catch (_) {
    return { ok: false, reason: 'task_tab_missing' };
  }
}

async function saveSdTask(task) {
  if (!task) {
    await chrome.storage.local.remove([SD_STORAGE_KEY, 'sd_notification']);
    return;
  }
  task.updatedAt = Date.now();
  await chrome.storage.local.set({
    [SD_STORAGE_KEY]: task,
    sd_notification: {
      taskId: task.id,
      doi: task.doi || '',
      message: sdStatusMessage(task),
      status: task.status,
      activeTabId: task.activeTabId ?? null,
      timestamp: task.updatedAt,
    },
  });
  if (Number.isInteger(task.activeTabId)) {
    void pushOverlayState(task.activeTabId);
  }
  // 下载进程窗默认只由主面板显式调出。用户可在设置中开启
  // “遇到人工验证时自动打开”，但同一验证状态只自动聚焦一次。
  if (SD_MANUAL_STATUSES.has(task.status)) {
    const settings = await getFreepaperSettings();
    const shouldAutoOpen = settings.autoOpenTaskMonitorOnChallenge === true;
    const isNewManualState = task.monitorOpenedForStatus !== task.status;
    if (shouldAutoOpen && isNewManualState) {
      const monitorId = await ensureTaskMonitorWindow({ focus: true });
      if (Number.isInteger(monitorId)) {
        task.monitorOpenedForStatus = task.status;
        await chrome.storage.local.set({ [SD_STORAGE_KEY]: task });
      }
    }
  }
}

function detectSdPageState() {
  const host = location.hostname.toLowerCase();
  const url = location.href;
  const title = document.title.toLowerCase();
  const bodyText = document.body?.innerText || '';
  const body = bodyText.slice(0, 40000).toLowerCase();
  const readyState = document.readyState;

  const hasCaptcha = [...document.querySelectorAll('iframe[src]')].some((frame) => {
    const src = (frame.src || '').toLowerCase();
    return src.includes('challenges.cloudflare.com') || src.includes('captcha');
  });
  const challengeWords = [
    'verify you are human', 'checking your browser', 'just a moment',
    'are you a robot', 'security verification', 'complete the security check',
    'unusual traffic', 'robot check', 'human verification',
    'performing security verification', 'press and hold', 'ray id',
    'please stand by while we are checking your browser',
  ];
  if (hasCaptcha || challengeWords.some(k => title.includes(k) || body.includes(k))) {
    return { type: 'CHALLENGE', title: document.title, host, url, readyState, bodyLength: bodyText.length };
  }

  if (['access denied', 'temporarily blocked', 'request rejected', 'your access has been blocked']
      .some(k => body.includes(k))) {
    return { type: 'DENIED', title: document.title, host, url, readyState, bodyLength: bodyText.length };
  }

  if (host === 'pdf.sciencedirectassets.com' || /\/pdfft(?:$|[?#])/i.test(url) ||
      document.querySelector('embed[type="application/pdf"],object[type="application/pdf"]')) {
    return { type: 'PDF_VIEWER', title: document.title, host, url, readyState, bodyLength: bodyText.length };
  }

  if (host.includes('sciencedirect.com') && /\/science\/article\//i.test(url)) {
    const citationPdf = document.querySelector('meta[name="citation_pdf_url"]')?.content || '';
    return { type: 'ARTICLE', title: document.title, host, url, citationPdf, readyState, bodyLength: bodyText.length };
  }

  return { type: 'UNKNOWN', title: document.title, host, url, readyState, bodyLength: bodyText.length };
}

function isScienceDirectPdfAssetUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const path = url.pathname.toLowerCase();
    return host.endsWith('.sciencedirectassets.com') &&
      (path.endsWith('.pdf') || path.includes('/main.pdf') || /\/pdfft(?:$|[?#])/i.test(url.href));
  } catch (_) {
    return false;
  }
}

function inferSdStateFromTab(tab, fallbackUrl = '') {
  const url = tab?.url || tab?.pendingUrl || fallbackUrl || '';
  if (!url) return null;
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch (_) {}
  if (isScienceDirectPdfAssetUrl(url) || /\/pdfft(?:$|[?#])/i.test(url)) {
    return {
      type: 'PDF_VIEWER',
      title: tab?.title || '',
      host,
      url,
      readyState: tab?.status || 'unknown',
      bodyLength: 0,
      inferredFromTabUrl: true,
    };
  }
  return null;
}

function isSdUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.endsWith('sciencedirect.com') || host.endsWith('.sciencedirectassets.com');
  } catch (_) {
    return false;
  }
}

async function inspectSdTab(tabId) {
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: detectSdPageState,
    });
    return result?.[0]?.result || null;
  } catch (_) {
    return null;
  }
}

function isSecondSdPhase(task, state, tabId) {
  return task.stage === 'OPENING_PDF' || task.stage === 'PDF' ||
    task.pdfTabId === tabId || state.host === 'pdf.sciencedirectassets.com';
}

async function handleSdState(task, state, tabId, context = {}) {
  if (!task || !state || !Number.isInteger(tabId)) return;
  return runSdTaskExclusive(task.id, async () => {
    const fresh = await getSdTask();
    if (!fresh || fresh.id !== task.id || SD_TERMINAL_STATUSES.has(fresh.status)) return;
    await handleSdStateExclusive(fresh, state, tabId, context);
  });
}

async function handleSdStateExclusive(task, state, tabId, context = {}) {
  task.activeTabId = tabId;
  task.lastUrl = state.url || task.lastUrl || '';
  if (context.documentId) task.activeDocumentId = context.documentId;

  if (state.type === 'DENIED') {
    task.status = 'ACCESS_DENIED';
    task.lastError = 'ScienceDirect 返回访问拒绝页面';
    await saveSdTask(task);
    return;
  }

  if (state.type === 'CHALLENGE') {
    const phase2 = isSecondSdPhase(task, state, tabId);
    task.challengePhase = phase2 ? 2 : 1;
    task.stage = phase2 ? 'PDF' : 'ARTICLE';
    if (phase2) task.pdfTabId = tabId;
    else task.articleTabId = tabId;
    task.status = phase2 ? 'WAITING_CHALLENGE_2' : 'WAITING_CHALLENGE_1';
    await saveSdTask(task);
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setBadgeBackgroundColor({ color: '#D97706' });
    return;
  }

  const documentKey = context.documentId || task.activeDocumentId || `${state.type}:${state.url || ''}`;

  if (state.type === 'ARTICLE') {
    if (!context.force && task.lastArticleDocumentKey === documentKey) {
      await pushOverlayState(tabId, false);
      return;
    }
    task.lastArticleDocumentKey = documentKey;
    task.stage = 'ARTICLE';
    task.status = 'ARTICLE_READY';
    task.challengePhase = 1;
    task.citationPdf = state.citationPdf || task.citationPdf || '';
    task.articleTabId = tabId;
    task.activeTabId = tabId;
    await saveSdTask(task);
    await autoOpenPdf(task, tabId);
    return;
  }

  if (state.type === 'PDF_VIEWER') {
    const attemptStillActive = task.status === 'DOWNLOADING_PDF' &&
      Number.isFinite(task.downloadStartedAt) && Date.now() - task.downloadStartedAt < 120000;
    if (attemptStillActive) return;
    if (!context.force && task.lastPdfDocumentKey === documentKey) {
      await pushOverlayState(tabId, false);
      return;
    }

    task.lastPdfDocumentKey = documentKey;
    task.stage = 'PDF';
    task.status = 'DOWNLOADING_PDF';
    task.challengePhase = 2;
    task.pdfTabId = tabId;
    task.activeTabId = tabId;
    task.downloadAttemptId = `sd_download_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    task.downloadStartedAt = Date.now();
    await saveSdTask(task);
    await autoVerifyAndDownload(task, tabId, task.downloadAttemptId);
    return;
  }

  await pushOverlayState(tabId, false);
}

async function autoOpenPdf(task, articleTabId) {
  task.stage = 'OPENING_PDF';
  task.status = 'OPENING_PDF';
  task.activeTabId = articleTabId;
  await saveSdTask(task);

  let result;
  try {
    [result] = await chrome.scripting.executeScript({
      target: { tabId: articleTabId, frameIds: [0] },
      func: (citationPdfUrl) => {
        if (citationPdfUrl) {
          location.assign(citationPdfUrl);
          return { ok: true, method: 'citation_url' };
        }
        const controls = [...document.querySelectorAll('a[href],button,[role="button"]')]
          .filter((el) => {
            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
          });
        let best = null;
        let bestScore = 0;
        for (const el of controls) {
          const text = (el.innerText || el.textContent || '').toLowerCase().trim();
          const href = (el.href || el.getAttribute('href') || '').toLowerCase();
          let score = 0;
          if (text === 'view pdf' || text === 'download pdf') score = 100;
          else if (text === 'pdf') score = 90;
          else if (text.includes('pdf')) score = 40;
          if (text.includes('download')) score += 20;
          if (href.includes('pdf.sciencedirectassets.com')) score += 120;
          if (score > bestScore) {
            bestScore = score;
            best = el;
          }
        }
        if (best && bestScore >= 40) {
          best.click();
          return { ok: true, method: 'click', score: bestScore };
        }
        return { ok: false, reason: 'no_pdf_button' };
      },
      args: [task.citationPdf || ''],
    });
  } catch (error) {
    result = { result: { ok: false, reason: error.message } };
  }

  if (!result?.result?.ok) {
    task.stage = 'ARTICLE';
    task.status = 'WAITING_MANUAL_PDF';
    task.activeTabId = articleTabId;
    await saveSdTask(task);
  }
}

async function verifyRemotePdfHeader(url) {
  try {
    const response = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      redirect: 'follow',
      cache: 'no-store',
      headers: {
        Accept: 'application/pdf,*/*;q=0.8',
        Range: 'bytes=0-4095',
      },
    });
    if (!response.ok && response.status !== 206) {
      return { ok: false, reason: `HTTP_${response.status}` };
    }
    let bytes;
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      const chunks = [];
      let total = 0;
      while (total < 4096) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value?.length) {
          chunks.push(value);
          total += value.length;
        }
      }
      try { await reader.cancel(); } catch (_) {}
      bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        const part = chunk.slice(0, Math.min(chunk.length, total - offset));
        bytes.set(part, offset);
        offset += part.length;
        if (offset >= total) break;
      }
    } else {
      bytes = new Uint8Array(await response.arrayBuffer());
    }
    const isPdf = bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 &&
      bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2D;
    if (isPdf) return { ok: true, finalUrl: response.url };

    const preview = new TextDecoder().decode(bytes.slice(0, 4096)).toLowerCase();
    if (preview.includes('captcha') || preview.includes('verify you are human') ||
        preview.includes('security check') || preview.includes('performing security verification') ||
        preview.includes('press and hold')) {
      return { ok: false, reason: 'ROBOT_CHALLENGE' };
    }
    if (preview.includes('sign in') || preview.includes('login') ||
        preview.includes('authentication') || preview.includes('shibboleth') ||
        preview.includes('access denied')) {
      return { ok: false, reason: 'AUTH_REQUIRED' };
    }
    return { ok: false, reason: 'NOT_PDF' };
  } catch (error) {
    return { ok: false, reason: 'WORKER_FETCH_FAILED', error: error.message };
  }
}

async function downloadPdfThroughDownloadsApi(task, pdfUrl) {
  const verified = await verifyRemotePdfHeader(pdfUrl);
  if (verified.ok) {
    return downloadVerifiedResource({
      url: verified.finalUrl || pdfUrl,
      folder: task.folder || 'freepaper',
      filename: `${sanitizeFilename(task.doi || 'paper')}.pdf`,
    });
  }

  // Edge/Chrome 的内置 PDF 查看器能够显示带 X-Amz 签名的 ScienceDirect PDF，
  // 但 Service Worker 的预检 fetch 偶尔会因临时令牌、CORS 或网络栈差异失败。
  // 对已经明确落在 ScienceDirect PDF 资产域且路径为 PDF 的 URL，允许直接交给
  // downloads API；真正的验证码/登录响应仍不会进入这个兜底分支。
  const canUseTrustedAssetFallback = isScienceDirectPdfAssetUrl(pdfUrl) &&
    !['ROBOT_CHALLENGE', 'AUTH_REQUIRED', 'NOT_PDF'].includes(verified.reason);
  if (canUseTrustedAssetFallback) {
    const direct = await downloadVerifiedResource({
      url: pdfUrl,
      folder: task.folder || 'freepaper',
      filename: `${sanitizeFilename(task.doi || 'paper')}.pdf`,
    });
    if (direct.ok) return { ...direct, trustedAssetFallback: true };
  }
  return verified;
}

async function autoVerifyAndDownload(task, pdfTabId, attemptId = '') {
  let tabUrl = task.lastUrl || '';
  try {
    const tab = await chrome.tabs.get(pdfTabId);
    tabUrl = tab.url || tab.pendingUrl || tabUrl;
  } catch (_) {}

  let result;
  try {
    [result] = await chrome.scripting.executeScript({
      target: { tabId: pdfTabId, frameIds: [0] },
      world: 'MAIN',
      func: async () => {
        const getUrl = () => {
          if (location.hostname === 'pdf.sciencedirectassets.com') return location.href;
          const embed = document.querySelector('embed[type="application/pdf"]');
          if (embed?.src) return new URL(embed.src, location.href).href;
          const object = document.querySelector('object[type="application/pdf"]');
          if (object?.data) return new URL(object.data, location.href).href;
          const meta = document.querySelector('meta[name="citation_pdf_url"]');
          if (meta?.content) return new URL(meta.content, location.href).href;
          return location.href;
        };
        try {
          const response = await fetch(getUrl(), {
            credentials: 'include',
            redirect: 'follow',
            cache: 'no-store',
            headers: { Accept: 'application/pdf,*/*;q=0.8' },
          });
          if (!response.ok) return { ok: false, reason: `HTTP_${response.status}`, pdfUrl: getUrl() };
          const blob = await response.blob();
          const bytes = new Uint8Array(await blob.slice(0, 5).arrayBuffer());
          const isPdf = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 &&
            bytes[3] === 0x46 && bytes[4] === 0x2D;
          if (!isPdf) {
            const preview = (await blob.slice(0, 4096).text()).toLowerCase();
            if (preview.includes('captcha') || preview.includes('verify you are human') ||
                preview.includes('security check') || preview.includes('performing security verification') ||
                preview.includes('press and hold')) {
              return { ok: false, reason: 'ROBOT_CHALLENGE', pdfUrl: getUrl() };
            }
            if (preview.includes('sign in') || preview.includes('login') ||
                preview.includes('authentication') || preview.includes('shibboleth')) {
              return { ok: false, reason: 'AUTH_REQUIRED', pdfUrl: getUrl() };
            }
            return { ok: false, reason: 'NOT_PDF', pdfUrl: getUrl() };
          }
          const blobUrl = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }));
          setTimeout(() => URL.revokeObjectURL(blobUrl), 120000);
          return {
            ok: true,
            blobUrl,
            pdfUrl: getUrl(),
            fileSize: blob.size,
            finalUrl: response.url,
          };
        } catch (error) {
          return { ok: false, reason: 'FETCH_FAILED', error: error.message, pdfUrl: getUrl() };
        }
      },
    });
  } catch (error) {
    result = { result: { ok: false, reason: 'INJECTION_FAILED', error: error.message, pdfUrl: tabUrl } };
  }

  let download = result?.result;

  if (download?.ok) {
    download = await downloadVerifiedResource({
      url: download.finalUrl || download.pdfUrl || tabUrl,
      blobUrl: download.blobUrl || '',
      folder: task.folder || 'freepaper',
      filename: `${sanitizeFilename(task.doi || 'paper')}.pdf`,
    });
  }

  // Chrome 内置 PDF 查看器、扩展页或导航切换期间通常无法注入脚本。
  // 此时不能把“无法注入”误判为失败，改由 service worker 验证文件头并调用 downloads API。
  if (!download?.ok && ['INJECTION_FAILED', 'FETCH_FAILED', 'NO_RESULT'].includes(download?.reason) &&
      (download?.pdfUrl || tabUrl)) {
    download = await downloadPdfThroughDownloadsApi(task, download?.pdfUrl || tabUrl);
  }

  let currentTask = await getSdTask();
  if (!currentTask || currentTask.id !== task.id) return;
  if (attemptId && currentTask.downloadAttemptId !== attemptId) return;
  task = currentTask;

  if (download?.ok) {
    task.status = 'DONE';
    task.stage = 'DONE';
    task.challengePhase = 0;
    task.filename = download.filename;
    task.fileSize = download.fileSize;
    task.completedAt = Date.now();
    task.downloadFinishedAt = Date.now();
    delete task.downloadStartedAt;
    await saveSdTask(task);
    await chrome.action.setBadgeText({ text: '' });
    return;
  }

  if (download?.reason === 'ROBOT_CHALLENGE') {
    task.stage = 'PDF';
    task.challengePhase = 2;
    task.status = 'WAITING_CHALLENGE_2';
  } else if (download?.reason === 'AUTH_REQUIRED') {
    task.status = 'ACCESS_DENIED';
  } else {
    task.stage = 'PDF';
    task.status = 'WAITING_MANUAL_PDF';
    task.lastError = download?.reason || download?.error || 'PDF verification failed';
  }
  task.pdfTabId = pdfTabId;
  task.activeTabId = pdfTabId;
  task.downloadFinishedAt = Date.now();
  delete task.downloadStartedAt;
  await saveSdTask(task);
}

async function startSdTask(paper, folder, batchJobId = null, batchIndex = null) {
  const existing = await getSdTask();
  if (existing && !SD_TERMINAL_STATUSES.has(existing.status)) {
    const sameBatchPaper = existing.batchJobId === batchJobId && existing.batchIndex === batchIndex;
    if (sameBatchPaper) return true;
    return false;
  }

  const task = {
    id: `sd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    doi: paper.doi || '',
    url: paper.url || `https://doi.org/${paper.doi}`,
    status: 'OPENING',
    stage: 'ARTICLE',
    folder: folder || 'freepaper',
    batchJobId,
    batchIndex,
    createdAt: Date.now(),
  };
  const tab = await chrome.tabs.create({ url: task.url, active: true });
  task.activeTabId = tab.id;
  task.articleTabId = tab.id;
  await saveSdTask(task);
  return true;
}

async function continueSdTask() {
  let task = await getSdTask();
  if (!task || SD_TERMINAL_STATUSES.has(task.status)) {
    return { ok: false, reason: 'no_active_sd_task' };
  }
  await chrome.action.setBadgeText({ text: '' });

  const previousStatus = task.status;
  task.challengePhase = previousStatus === 'WAITING_CHALLENGE_2' ? 2 : (task.challengePhase || 1);
  task.status = 'CHECKING_AFTER_CHALLENGE';
  task.retryRequestedAt = Date.now();
  await saveSdTask(task);

  const candidates = [task.activeTabId, task.pdfTabId, task.articleTabId]
    .filter((id, index, arr) => Number.isInteger(id) && arr.indexOf(id) === index);
  const delays = [120, 450, 1000, 2000, 3400];
  let lastChallenge = null;
  let sawUnstablePage = false;

  for (const delay of delays) {
    await sleep(delay);
    task = await getSdTask();
    if (!task || SD_TERMINAL_STATUSES.has(task.status)) return { ok: true };

    const tabs = [];
    for (const tabId of candidates) {
      try {
        const tab = await chrome.tabs.get(tabId);
        tabs.push({ tabId, tab });
      } catch (_) {}
    }

    // 先依据标签页 URL 判断。内置 PDF 查看器通常禁止脚本注入，因此不能等
    // inspectSdTab() 成功后才承认 PDF 已经打开。只要真实 PDF 资产页存在，
    // 就应优先于旧文章页中残留的验证码状态。
    for (const { tabId, tab } of tabs) {
      const inferred = inferSdStateFromTab(tab);
      if (inferred?.type === 'PDF_VIEWER') {
        await handleSdState(task, inferred, tabId, {
          force: true,
          reason: 'user_continue_pdf_url',
        });
        return { ok: true, recoveredFromPdfUrl: true };
      }
    }

    for (const { tabId, tab } of tabs) {
      const state = await inspectSdTab(tabId);
      if (!state) {
        if (tab.status !== 'complete') sawUnstablePage = true;
        continue;
      }
      if (state.type === 'PDF_VIEWER') {
        await handleSdState(task, state, tabId, { force: true, reason: 'user_continue_pdf_viewer' });
        return { ok: true };
      }
      if (state.type === 'CHALLENGE') {
        // 只作为最后兜底保留；不能让旧文章标签页的验证码覆盖已打开的 PDF 标签页。
        lastChallenge = { state, tabId };
        continue;
      }
      if (state.type === 'UNKNOWN' && state.readyState !== 'complete') {
        sawUnstablePage = true;
        continue;
      }
      await handleSdState(task, state, tabId, { force: true, reason: 'user_continue' });
      return { ok: true };
    }
  }

  task = await getSdTask();
  if (!task || SD_TERMINAL_STATUSES.has(task.status)) return { ok: true };
  if (lastChallenge) {
    await handleSdState(task, lastChallenge.state, lastChallenge.tabId, {
      force: true,
      reason: 'challenge_still_present',
    });
    return { ok: false, reason: 'challenge_still_present' };
  }

  task.status = 'WAITING_MANUAL_PDF';
  task.lastError = sawUnstablePage
    ? '页面仍在跳转。请等待 PDF 页面稳定后再次点击继续。'
    : '未找到可用的 PDF 页面。请回到任务页点击 View PDF / Download PDF 后再继续。';
  await saveSdTask(task);
  return { ok: false, reason: sawUnstablePage ? 'page_not_stable' : 'pdf_tab_missing' };
}

async function stopSdTask(reason = '用户跳过当前论文') {
  const task = await getSdTask();
  if (!task || SD_TERMINAL_STATUSES.has(task.status)) return;
  task.status = 'STOPPED';
  task.stage = 'STOPPED';
  task.challengePhase = 0;
  task.reason = reason;
  task.completedAt = Date.now();
  await saveSdTask(task);
  await chrome.action.setBadgeText({ text: '' });
}

async function clearConsumedSdTask(taskId) {
  const task = await getSdTask();
  if (!task || task.id !== taskId) return;
  const tabIds = [task.activeTabId, task.pdfTabId, task.articleTabId]
    .filter((id, index, all) => Number.isInteger(id) && all.indexOf(id) === index);
  await chrome.storage.local.remove([SD_STORAGE_KEY, 'sd_notification']);
  await Promise.allSettled(tabIds.map((tabId) => chrome.tabs.sendMessage(tabId, { type: 'HIDE_OVERLAY' })));
}


// =========================================================================
// 下载跟踪
// =========================================================================

const DOWNLOAD_WAIT_TIMEOUT_MS = 60000;
const pendingDownloads = {};

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state?.current) return;
  const entry = pendingDownloads[delta.id];

  if (delta.state.current === 'complete') {
    chrome.downloads.search({ id: delta.id }).then(async (results) => {
      const item = results?.[0];
      if (!item) return;
      if (entry) {
        clearTimeout(entry.timer);
        delete pendingDownloads[delta.id];
        entry.resolve({
          filename: item.filename || '',
          fileSize: item.fileSize || 0,
          url: item.url || '',
        });
      }
      // 即使 Service Worker 在下载期间重启，持久化登记仍能确保
      // “最近下载”只记录 Freepaper 自己创建的下载。
      await finalizeRegisteredFreepaperDownload(delta.id, item);
    }).catch(() => {});
    return;
  }

  if (delta.state.current === 'interrupted') {
    if (entry) {
      clearTimeout(entry.timer);
      delete pendingDownloads[delta.id];
      entry.resolve(null);
    }
    void unregisterFreepaperDownload(delta.id);
  }
});

/**
 * 等待指定 downloadId 完成。
 * 返回 { filename, fileSize, url }，超时或中断时返回 null。
 */
function waitForDownloadId(downloadId, timeoutMs = DOWNLOAD_WAIT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      delete pendingDownloads[downloadId];
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);

    pendingDownloads[downloadId] = {
      timer,
      resolve: finish,
    };

    // 小文件可能在监听注册前已经完成，立即补查一次。
    chrome.downloads.search({ id: downloadId }).then((items) => {
      const item = items?.[0];
      if (!item || item.state !== 'complete') return;
      finish({
        filename: item.filename || '',
        fileSize: item.fileSize || 0,
        url: item.url || '',
      });
    }).catch(() => {});
  });
}

// =========================================================================
// 独立批量下载（唯一持久状态；Service Worker 重启后可恢复）
// =========================================================================
const BATCH_STORAGE_KEY = 'batch_state';
const BATCH_RESUME_ALARM = 'freepaper_batch_resume';
let batchRunnerPromise = null;
let batchRunnerJobId = null;

async function loadBatchState() {
  const data = await chrome.storage.local.get(BATCH_STORAGE_KEY);
  return data[BATCH_STORAGE_KEY] || null;
}

function recalculateBatchCounts(state) {
  state.done = state.papers.filter(p => p.status === 'done').length;
  state.failed = state.papers.filter(p => p.status === 'failed' || p.status === 'needs_login').length;
  state.total = state.papers.length;
  return state;
}

async function saveBatchState(state, { allowControlOverride = false } = {}) {
  if (!state) return;
  const persisted = await loadBatchState();
  if (!allowControlOverride && persisted?.jobId === state.jobId) {
    // 停止/暂停命令一旦写入 storage，任何仍在运行的旧闭包都不能把控制状态覆盖回去。
    if (persisted.running === false && state.running !== false) {
      state.running = false;
      state.stopReason = persisted.stopReason || state.stopReason;
    }
    if (persisted.paused === true && state.paused !== true) {
      state.paused = true;
      state.pausedAt = persisted.pausedAt || state.pausedAt;
    }
  }
  state.updatedAt = Date.now();
  recalculateBatchCounts(state);
  await chrome.storage.local.set({ [BATCH_STORAGE_KEY]: state });
  if (state.running) {
    await chrome.action.setBadgeText({ text: state.paused ? 'Ⅱ' : String(state.done || 0) });
    await chrome.action.setBadgeBackgroundColor({ color: state.paused ? '#D97706' : '#6c5ce7' });
  } else {
    await chrome.action.setBadgeText({ text: '' });
  }
}

async function isBatchJobRunning(jobId) {
  const state = await loadBatchState();
  return Boolean(state?.running && state.jobId === jobId);
}

async function waitWhileBatchRunning(jobId, milliseconds) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (!(await isBatchJobRunning(jobId))) return false;
    await sleep(Math.min(500, deadline - Date.now()));
  }
  return isBatchJobRunning(jobId);
}

function normalizeBatchDoi(value) {
  if (!value) return '';
  const text = String(value).trim()
    .replace(/^doi\s*:\s*/i, '')
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
  const match = text.match(/10\.\d{4,9}\/[^\s\'\"<>]+/i);
  if (!match) return '';
  return match[0]
    .replace(/[\s,;:.]+$/g, '')
    .replace(/^(10\.48550\/arxiv\.[^\s]+?)v\d+$/i, '$1')
    .toLowerCase();
}

function normalizeBatchUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(String(value).trim());
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|spm$|ref$|source$|campaign$)/i.test(key)) url.searchParams.delete(key);
    }
    return url.href;
  } catch (_) {
    return '';
  }
}

function normalizeBatchArxivId(value) {
  const match = String(value || '').match(/(?:arxiv(?:\.org)?[\/:.]|\/(?:abs|pdf)\/)(\d{4}\.\d{4,5}|[a-z-]+\/\d{7})(?:v\d+)?/i);
  return match ? match[1].toLowerCase() : '';
}

function canonicalBatchDocumentKey(doi, urls) {
  const normalizedDoi = normalizeBatchDoi(doi);
  if (normalizedDoi) return `doi:${normalizedDoi}`;
  for (const value of urls || []) {
    try {
      const url = new URL(value);
      const arxivId = normalizeBatchArxivId(url.href);
      if (arxivId) return `arxiv:${arxivId}`;
      const host = url.hostname.toLowerCase();
      if (host.endsWith('sciencedirect.com')) {
        const pii = url.pathname.match(/\/pii\/([a-z0-9]+)/i)?.[1];
        if (pii) return `sd-pii:${pii.toLowerCase()}`;
      }
      if (host.includes('ieee.org')) {
        const arnumber = url.searchParams.get('arnumber') || url.pathname.match(/document\/(\d+)/i)?.[1];
        if (arnumber) return `ieee:${arnumber}`;
      }
    } catch (_) {}
  }
  return urls?.[0] ? `url:${urls[0].toLowerCase()}` : '';
}

function scoreBatchInputUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const path = url.pathname.toLowerCase();
    const full = `${host}${path}${url.search.toLowerCase()}`;
    if (host.endsWith('arxiv.org') && path.startsWith('/pdf/')) return 190;
    if (host.endsWith('arxiv.org') && path.startsWith('/abs/')) return 170;
    if (host.endsWith('sciencedirect.com') && /\/science\/article\/pii\//.test(path) &&
        !path.includes('/abs/') && !path.includes('/pdfft')) return 185;
    if (host === 'doi.org') return 160;
    if (host.endsWith('sciencedirect.com') && path.includes('/pdfft')) return 145;
    if (host.endsWith('sciencedirect.com') && path.includes('/abs/')) return 130;
    if (path.endsWith('.pdf') || full.includes('download=pdf')) return 175;
    if (full.includes('/pdf')) return 150;
    return 100;
  } catch (_) {
    return 0;
  }
}

function deduplicateBatchPapers(inputPapers) {
  const groups = new Map();
  const input = Array.isArray(inputPapers) ? inputPapers : [];
  for (const source of input) {
    const urls = [source?.url, ...(Array.isArray(source?.candidateUrls) ? source.candidateUrls : [])]
      .map(normalizeBatchUrl)
      .filter(Boolean);
    let doi = normalizeBatchDoi(source?.doi);
    if (!doi) {
      for (const url of urls) {
        doi = normalizeBatchDoi(url);
        if (doi) break;
        try {
          const parsed = new URL(url);
          if (parsed.hostname.toLowerCase().endsWith('arxiv.org')) {
            const arxivId = normalizeBatchArxivId(parsed.href);
            if (arxivId) {
              doi = `10.48550/arxiv.${arxivId}`.toLowerCase();
              break;
            }
          }
        } catch (_) {}
      }
    }
    if (!doi && urls.length === 0) continue;
    const key = canonicalBatchDocumentKey(doi, urls);
    if (!key) continue;
    let group = groups.get(key);
    if (!group) {
      group = {
        ...source,
        doi: doi || source?.doi || urls[0],
        candidateUrls: [],
        sourceCount: 0,
        status: source?.status === 'done' ? 'done' : 'pending',
        caseIds: [],
        urlTypes: [],
        expectedResults: [],
      };
      groups.set(key, group);
    }
    group.sourceCount += Number(source?.sourceCount) || 1;
    if (source?.status === 'done') group.status = 'done';
    if (!group.title && source?.title) group.title = source.title;
    for (const field of ['caseIds', 'urlTypes', 'expectedResults']) {
      const values = Array.isArray(source?.[field]) ? source[field] : [];
      for (const value of values) {
        if (value && !group[field].includes(value)) group[field].push(value);
      }
    }
    for (const url of urls) {
      if (!group.candidateUrls.includes(url)) group.candidateUrls.push(url);
    }
  }

  const papers = [...groups.values()].map((group) => {
    const candidates = [...group.candidateUrls].sort((a, b) => scoreBatchInputUrl(b) - scoreBatchInputUrl(a));
    return {
      ...group,
      url: candidates[0] || (normalizeBatchDoi(group.doi) ? `https://doi.org/${normalizeBatchDoi(group.doi)}` : ''),
      candidateUrls: candidates,
      duplicateCount: Math.max(0, group.sourceCount - 1),
    };
  });
  const inputCount = input.reduce((sum, paper) => sum + (Number(paper?.sourceCount) || 1), 0);
  return {
    papers,
    inputCount,
    duplicatesRemoved: Math.max(0, inputCount - papers.length),
  };
}

async function migrateLegacyBatchState(reason = 'startup') {
  const state = await loadBatchState();
  if (!state || Number(state.schemaVersion || 0) >= 4) return state;

  // 旧版队列可能包含同 DOI 的多条入口，而且升级前的 Service Worker
  // 仍可能在后台续跑。升级时先停止旧队列，再对状态做一次后台级去重，
  // 避免正确代码安装后仍继续执行旧的重复任务。
  const deduped = deduplicateBatchPapers(state.papers || []);
  const migratedJobId = state.jobId || `legacy_${Date.now()}`;
  const papers = deduped.papers.map((paper, index) => {
    const done = paper.status === 'done';
    return {
      ...paper,
      id: paper.id || `${migratedJobId}_migrated_${index}`,
      status: done ? 'done' : 'pending',
      filename: done ? (paper.filename || '') : '',
      error: '',
    };
  });

  const migrated = {
    ...state,
    schemaVersion: 4,
    papers,
    total: papers.length,
    inputTotal: deduped.inputCount,
    duplicatesRemoved: deduped.duplicatesRemoved,
    running: false,
    paused: false,
    activeIndex: -1,
    activeTabId: null,
    nextIndex: 0,
    current: 0,
    stopReason: '升级后已停止旧队列，防止继续重复下载。请重新导入并开始任务。',
    migrationNotice: `已合并 ${deduped.duplicatesRemoved} 条重复记录（${reason}）`,
    migratedAt: Date.now(),
  };
  await saveBatchState(migrated, { allowControlOverride: true });

  const sdTask = await getSdTask();
  if (sdTask && sdTask.batchJobId === state.jobId && !SD_TERMINAL_STATUSES.has(sdTask.status)) {
    await stopSdTask('版本升级：已停止旧批量任务，防止重复下载');
  }
  return migrated;
}

function isDirectNonSciencePdfUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const path = url.pathname.toLowerCase();
    if (isSdUrl(value)) return false;
    return path.endsWith('.pdf') ||
      (host.endsWith('arxiv.org') && path.startsWith('/pdf/')) ||
      /(?:^|[?&])(download|type)=pdf(?:&|$)/i.test(url.search);
  } catch (_) {
    return false;
  }
}

async function startBatchJob(papers, folder, options = {}) {
  const existing = await loadBatchState();
  if (existing?.running) {
    return { ok: false, reason: 'batch_already_running', state: existing };
  }
  const deduped = deduplicateBatchPapers(papers);
  if (deduped.papers.length === 0) {
    return { ok: false, reason: 'no_valid_papers' };
  }
  papers = deduped.papers;
  const jobId = `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const state = {
    schemaVersion: 5,
    jobId,
    papers: papers.map((paper, index) => ({
      ...paper,
      id: `${jobId}_${index}`,
      status: 'pending',
      filename: '',
      fileSize: 0,
      error: '',
      completedAt: null,
      retryCount: Number(paper.retryCount || 0),
    })),
    nextIndex: 0,
    current: 0,
    activeIndex: -1,
    activeTabId: null,
    total: papers.length,
    inputTotal: deduped.inputCount,
    duplicatesRemoved: deduped.duplicatesRemoved,
    done: 0,
    failed: 0,
    running: true,
    paused: false,
    folder: folder || 'freepaper',
    retryOfJobId: options.retryOfJobId || null,
    retrySourceTotal: Number(options.retrySourceTotal || 0),
    retryOnly: options.retryOnly === true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await saveBatchState(state);
  void runBatch(state);
  return { ok: true, jobId, state };
}

async function retryFailedBatchJob(folderOverride = '') {
  const previous = await loadBatchState();
  if (!previous) return { ok: false, reason: 'no_batch_state' };
  if (previous.running) return { ok: false, reason: 'batch_already_running', state: previous };

  const failedOnly = (previous.papers || [])
    .filter((paper) => paper.status === 'failed' || paper.status === 'needs_login')
    .map((paper) => ({
      ...paper,
      status: 'pending',
      filename: '',
      fileSize: 0,
      error: '',
      completedAt: null,
      retryCount: Number(paper.retryCount || 0) + 1,
      retriedFromJobId: previous.jobId || '',
    }));
  if (failedOnly.length === 0) {
    return { ok: false, reason: 'no_failed_papers', state: previous };
  }

  // 重试是一个只包含失败项的新批次。绝不把已成功论文带入新队列，
  // 从后台层面保证“重试 1 篇”不会再次下载其余 4 篇。
  return startBatchJob(failedOnly, folderOverride || previous.folder || 'freepaper', {
    retryOfJobId: previous.jobId || null,
    retrySourceTotal: previous.total || previous.papers?.length || 0,
    retryOnly: true,
  });
}

async function stopBatchJob(reason = '用户终止') {
  const state = await loadBatchState();
  if (!state) return { ok: true, state: null };
  state.running = false;
  state.stopReason = reason;
  state.activeIndex = -1;
  await saveBatchState(state, { allowControlOverride: true });

  const sdTask = await getSdTask();
  if (sdTask && sdTask.batchJobId === state.jobId && !SD_TERMINAL_STATUSES.has(sdTask.status)) {
    await stopSdTask(reason);
  }
  return { ok: true, state };
}

async function pauseBatchJob() {
  const state = await loadBatchState();
  if (!state?.running) return { ok: false, reason: 'no_running_batch', state };
  if (state.paused) return { ok: true, state };
  state.paused = true;
  state.pausedAt = Date.now();
  state.pauseReason = '用户暂停';
  await saveBatchState(state, { allowControlOverride: true });
  return { ok: true, state };
}

async function resumeBatchJob() {
  const state = await loadBatchState();
  if (!state?.running) return { ok: false, reason: 'no_paused_batch', state };
  state.paused = false;
  state.resumedAt = Date.now();
  delete state.pauseReason;
  await saveBatchState(state, { allowControlOverride: true });
  void runBatch(state);
  return { ok: true, state };
}

async function waitForSdResult(jobId, batchIndex) {
  while (await isBatchJobRunning(jobId)) {
    const task = await getSdTask();
    if (!task || task.batchJobId !== jobId || task.batchIndex !== batchIndex) {
      await sleep(500);
      continue;
    }
    if (SD_TERMINAL_STATUSES.has(task.status)) {
      let result;
      if (task.status === 'DONE') {
        result = { status: 'done', filename: task.filename || '', fileSize: task.fileSize || 0 };
      } else if (task.status === 'STOPPED') {
        result = { status: 'needs_login', error: task.reason || sdStatusMessage(task) };
      } else {
        result = { status: 'failed', error: task.lastError || sdStatusMessage(task) };
      }
      // 批量队列已经拿到结果后清理本篇 SD 状态，避免任务监控窗在后续论文
      // 已经运行/完成时仍显示上一篇“第二级验证”或“已停止”的陈旧信息。
      await clearConsumedSdTask(task.id);
      return result;
    }
    await sleep(800);
  }
  return { status: 'stopped' };
}

async function verifyPdfCandidateInTab(tabId, candidateUrl) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      world: 'MAIN',
      func: async (url) => {
        try {
          const response = await fetch(url, {
            method: 'GET',
            credentials: 'include',
            redirect: 'follow',
            cache: 'no-store',
            headers: { Accept: 'application/pdf,*/*;q=0.8' },
          });
          const contentType = (response.headers.get('content-type') || '').toLowerCase();
          if (!response.ok) return { ok: false, reason: `HTTP_${response.status}` };
          if (contentType.includes('text/html')) return { ok: false, reason: 'HTML_CONTENT_TYPE' };
          const blob = await response.blob();
          const bytes = new Uint8Array(await blob.slice(0, 5).arrayBuffer());
          const isPdf = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 &&
            bytes[3] === 0x46 && bytes[4] === 0x2D;
          if (!isPdf) return { ok: false, reason: 'NOT_PDF' };
          const blobUrl = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }));
          setTimeout(() => URL.revokeObjectURL(blobUrl), 120000);
          return {
            ok: true,
            blobUrl,
            pdfUrl: url,
            fileSize: blob.size,
            finalUrl: response.url,
          };
        } catch (error) {
          return { ok: false, reason: 'FETCH_FAILED', error: error.message };
        }
      },
      args: [candidateUrl],
    });
    return results?.[0]?.result || { ok: false, reason: 'NO_RESULT' };
  } catch (error) {
    return { ok: false, reason: 'INJECTION_FAILED', error: error.message };
  }
}

async function downloadPagePdf(tabId, candidateUrl, folder, filename) {
  if (!Number.isInteger(tabId) || !candidateUrl) {
    return { ok: false, reason: 'invalid_download_request' };
  }
  const verified = await verifyPdfCandidateInTab(tabId, candidateUrl);
  if (!verified.ok) return verified;
  return downloadVerifiedResource({
    url: verified.finalUrl || verified.pdfUrl || candidateUrl,
    blobUrl: verified.blobUrl || '',
    folder: folder || 'freepaper',
    filename: filename || 'paper.pdf',
  });
}

async function processBatchPaper(state, paper, index) {
  const jobId = state.jobId;
  const folder = state.folder || 'freepaper';
  const candidates = [paper.url, ...(Array.isArray(paper.candidateUrls) ? paper.candidateUrls : [])]
    .map(normalizeBatchUrl)
    .filter((url, position, all) => url && all.indexOf(url) === position);
  let inputUrl = candidates[0] || `https://doi.org/${paper.doi}`;
  let probeTab = null;

  // Service Worker 恢复后，如果该篇已有未结束的 SD 任务，继续等待，不重复打开页面。
  const existingSd = await getSdTask();
  if (existingSd && existingSd.batchJobId === jobId && existingSd.batchIndex === index &&
      !SD_TERMINAL_STATUSES.has(existingSd.status)) {
    return waitForSdResult(jobId, index);
  }

  // 对 arXiv / 公开 PDF 直链先由 Service Worker 校验文件头并通过 downloads API 下载，
  // 避免进入浏览器内置 PDF 查看器后无法注入脚本。
  for (const candidate of candidates) {
    if (!isDirectNonSciencePdfUrl(candidate)) continue;
    if (!(await isBatchJobRunning(jobId))) return { status: 'stopped' };
    const direct = await downloadPdfThroughDownloadsApi({
      doi: paper.doi || 'paper',
      folder,
    }, candidate);
    if (direct.ok) {
      return { status: 'done', filename: direct.filename, fileSize: direct.fileSize || 0 };
    }
  }
  const nonDirectCandidate = candidates.find((candidate) => !isDirectNonSciencePdfUrl(candidate));
  if (nonDirectCandidate) inputUrl = nonDirectCandidate;

  try {
    probeTab = await chrome.tabs.create({ url: inputUrl, active: false });
    state.activeTabId = probeTab.id;
    await saveBatchState(state);
    if (!(await waitWhileBatchRunning(jobId, 4500))) return { status: 'stopped' };

    const finalTab = await chrome.tabs.get(probeTab.id).catch(() => null);
    const finalUrl = finalTab?.url || inputUrl;

    if (isSdUrl(finalUrl)) {
      try { await chrome.tabs.remove(probeTab.id); } catch (_) {}
      probeTab = null;
      paper.url = finalUrl;
      const started = await startSdTask(paper, folder, jobId, index);
      if (!started) return { status: 'failed', error: '另一个 ScienceDirect 任务仍在运行' };
      return waitForSdResult(jobId, index);
    }

    if (!(await waitWhileBatchRunning(jobId, 3500))) return { status: 'stopped' };
    let pdfUrls = [];
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: probeTab.id, frameIds: [0] },
        func: detectPdfsInPage,
      });
      pdfUrls = results?.[0]?.result || [];
    } catch (error) {
      return { status: 'failed', error: `页面扫描失败：${error.message}` };
    }

    for (const pdfUrl of pdfUrls) {
      if (!(await isBatchJobRunning(jobId))) return { status: 'stopped' };
      const verified = await verifyPdfCandidateInTab(probeTab.id, pdfUrl);
      if (verified.ok) {
        const saved = await downloadVerifiedResource({
          url: verified.finalUrl || verified.pdfUrl || pdfUrl,
          blobUrl: verified.blobUrl || '',
          folder,
          filename: `${sanitizeFilename(paper.doi || 'paper')}.pdf`,
        });
        if (saved.ok) {
          return { status: 'done', filename: saved.filename, fileSize: saved.fileSize || 0 };
        }
      }
    }
    return { status: 'needs_login', error: '未找到可验证的 PDF，可能需要登录或人工操作' };
  } catch (error) {
    return { status: 'failed', error: error.message };
  } finally {
    if (probeTab?.id && index < state.total - 1) {
      try { await chrome.tabs.remove(probeTab.id); } catch (_) {}
    }
  }
}

async function runBatch(initialState) {
  const jobId = typeof initialState === 'string' ? initialState : initialState?.jobId;
  if (!jobId) return;
  if (batchRunnerPromise && batchRunnerJobId === jobId) return batchRunnerPromise;

  batchRunnerJobId = jobId;
  batchRunnerPromise = (async () => {
    while (true) {
      let state = await loadBatchState();
      if (!state || state.jobId !== jobId || !state.running) return;
      // 暂停采取“安全边界”语义：正在处理的当前篇允许收尾，
      // 但不会再启动下一篇。恢复后从 nextIndex 精确续跑。
      if (state.paused) return;

      const index = Number.isInteger(state.nextIndex) ? state.nextIndex : (state.current || 0);
      if (index >= state.papers.length) {
        state.running = false;
        state.current = state.papers.length;
        state.activeIndex = -1;
        state.activeTabId = null;
        state.completedAt = Date.now();
        await saveBatchState(state);
        return;
      }

      const paper = state.papers[index];
      paper.status = 'downloading';
      paper.error = '';
      state.activeIndex = index;
      state.current = index + 1;
      await saveBatchState(state);

      const result = await processBatchPaper(state, paper, index);
      state = await loadBatchState();
      if (!state || state.jobId !== jobId) return;
      if (!state.running || result.status === 'stopped') return;

      const currentPaper = state.papers[index];
      currentPaper.status = result.status;
      currentPaper.filename = result.filename || '';
      currentPaper.fileSize = result.fileSize || 0;
      currentPaper.error = result.error || '';
      currentPaper.completedAt = Date.now();
      state.nextIndex = index + 1;
      state.current = index + 1;
      state.activeIndex = -1;
      state.activeTabId = null;
      await saveBatchState(state);

      if (state.nextIndex < state.papers.length) {
        if (!(await waitWhileBatchRunning(jobId, 1500))) return;
      }
    }
  })().finally(() => {
    if (batchRunnerJobId === jobId) {
      batchRunnerJobId = null;
      batchRunnerPromise = null;
    }
  });
  return batchRunnerPromise;
}

async function recoverActiveBatch(reason = 'startup') {
  const state = await loadBatchState();
  if (!state?.running || state.paused || !state.jobId) return;
  console.log(`[Freepaper] 恢复批量任务 (${reason}):`, state.jobId, state.nextIndex ?? state.current);
  void runBatch(state);
}


// Injected into tabs for PDF detection (batch mode)
function detectPdfsInPage() {
  const out = [];
  const push = (url) => { if (url && typeof url === 'string' && !url.startsWith('javascript:') && !url.startsWith('#')) out.push(url.trim()); };

  document.querySelectorAll('meta').forEach(m => {
    const k = (m.getAttribute('name')||m.getAttribute('property')||'').toLowerCase();
    const c = m.getAttribute('content');
    if (c && (k.includes('citation_pdf_url')||k.includes('pdf_url'))) push(c);
  });
  document.querySelectorAll('a[href],link[href],iframe[src],embed[src],object[data]').forEach(el => {
    push(el.getAttribute('href')||el.getAttribute('src')||el.getAttribute('data'));
  });
  // IEEE stamp
  if (location.hostname.includes('ieee.org') && location.pathname.includes('stamp.jsp')) {
    const p = new URLSearchParams(location.search);
    if (p.get('arnumber')) push(`https://ieeexplore.ieee.org/stampPDF/getPDF.jsp?tp=&arnumber=${p.get('arnumber')}`);
  }
  // ScienceDirect
  if (location.hostname.includes('sciencedirect.com')) {
    const m = location.pathname.match(/\/pii\/([A-Za-z0-9]+)/);
  // pdf.sciencedirectassets.com：URL 即 PDF
  if (location.hostname === 'pdf.sciencedirectassets.com') push(location.href);
  // embed/object PDF
  document.querySelectorAll('embed[type="application/pdf"],object[type="application/pdf"]').forEach(el => push(el.src || el.data));
  }

  // Score + filter
  const candidates = [];
  const seen = new Set();
  for (const raw of out) {
    let url; try { url = new URL(raw, location.href).href; } catch(_) { continue; }
    const l = url.toLowerCase();
    if (l.includes('.css')||l.includes('.js')||l.includes('.woff')||l.includes('.svg')||l.includes('.png')||l.includes('.jpg')) continue;
    if (seen.has(url)) continue;
    seen.add(url);

    let s = 0;
    if (l.endsWith('.pdf')) s += 60;
    if (l.includes('stamppdf/getpdf.jsp')) s += 90;
    if (l.includes('/doi/pdf/')||l.includes('/doi/pdfdirect/')) s += 75;
    if (l.includes('download=true')||l.includes('download=pdf')) s += 50;
    if (l.includes('/pdf')) s += 30;
    if (l.includes('download')) s += 20;
    if (l.includes('citation_pdf_url')) s += 50;
    if (l.includes('.ris')||l.includes('.bib')||l.includes('citation')) s -= 50;
    if (s >= 30) candidates.push({ url, score: s });
  }
  candidates.sort((a,b) => b.score - a.score);
  return candidates.map(c => c.url);
}

// =========================================================================
// Popup 命令
// =========================================================================

function setupMessageRouter() {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const action = msg?.command || msg?.type;
    if (!action) return false;

    (async () => {
      switch (action) {

        case 'OVERLAY_SYNC_REQUEST':
          return getOverlayStateForTab(sender.tab?.id);

        case 'GET_BATCH_STATE':
          return { ok: true, state: await loadBatchState() };

        case 'GET_TASK_SNAPSHOT': {
          const monitorWindowId = await resolveSingleTaskMonitorWindow();
          return {
            ok: true,
            batch: await loadBatchState(),
            sd: await getSdTask(),
            monitorOpen: Number.isInteger(monitorWindowId),
            monitorWindowId,
          };
        }

        case 'OPEN_TASK_MONITOR': {
          const windowId = await ensureTaskMonitorWindow({ focus: true });
          return { ok: Number.isInteger(windowId), windowId, monitorOpen: Number.isInteger(windowId) };
        }

        case 'TASK_MONITOR_READY': {
          if (Number.isInteger(sender.tab?.windowId)) {
            const currentId = await getTaskMonitorWindowId();
            if (!Number.isInteger(currentId)) {
              await chrome.storage.local.set({ [TASK_MONITOR_WINDOW_KEY]: sender.tab.windowId });
            }
          }
          const canonicalId = await resolveSingleTaskMonitorWindow();
          return { ok: true, windowId: canonicalId };
        }

        case 'FOCUS_TASK_TAB':
          return focusTaskTab();

        case 'DOWNLOAD_PAGE_PDF':
          return downloadPagePdf(
            Number.isInteger(msg.tabId) ? msg.tabId : sender.tab?.id,
            msg.url || '',
            msg.folder || 'freepaper',
            msg.filename || 'paper.pdf',
          );

        case 'settings_updated':
          console.log('[Freepaper] 设置已更新:', msg.settings || { folder: msg.folder });
          return { ok: true };

        case 'batch_start':
          return startBatchJob(msg.papers || [], msg.folder || 'freepaper');

        case 'BATCH_RETRY_FAILED':
          return retryFailedBatchJob(msg.folder || '');

        case 'batch_stop':
        case 'BATCH_STOP':
          return stopBatchJob('用户终止批量任务');

        case 'BATCH_PAUSE':
          return pauseBatchJob();

        case 'BATCH_RESUME':
          return resumeBatchJob();

        case 'SD_CONTINUE':
          return continueSdTask();

        case 'SD_SKIP':
          await stopSdTask('用户跳过当前论文');
          return { ok: true };

        default:
          return { ok: false, reason: `unknown_action:${action}` };
      }
    })().then(sendResponse).catch((error) => {
      console.error('[Freepaper] 消息处理失败:', action, error);
      sendResponse({ ok: false, error: error.message });
    });

    // 保持消息通道，兼容 Chrome 88；不要使用 async onMessage listener。
    return true;
  });
}

// =========================================================================
// 工具函数
// =========================================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sanitizeFilename(input) {
  if (!input) return 'paper';
  return input.replace(/[<>:"/\\|?*]/g, '_').replace(/\.+/g, '_').slice(0, 100);
}

// =========================================================================
// 生命周期与页面导航恢复
// =========================================================================
const sdInspectionTimers = new Map();

async function inspectAndHandleSdTab(tabId, context = {}) {
  let task = await getSdTask();
  if (!task || SD_TERMINAL_STATUSES.has(task.status) || !Number.isInteger(tabId)) return;

  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (_) {
    return;
  }
  const tabUrl = tab.url || tab.pendingUrl || context.url || '';

  if (!isTaskTab(task, tabId)) {
    // 只允许由任务页打开的新导航目标加入任务，绝不接管用户手动打开的其他 SD 标签页。
    if (!context.fromTaskNavigation) return;
    task.activeTabId = tabId;
    task.pdfTabId = tabId;
    task.stage = 'OPENING_PDF';
    task.status = 'OPENING_PDF';
    task.lastUrl = tabUrl;
    await saveSdTask(task);
    task = await getSdTask();
  }

  const inferred = inferSdStateFromTab(tab, tabUrl);
  if (inferred?.type === 'PDF_VIEWER') {
    // URL 级判断优先：内置 PDF 查看器不可注入时也能立即进入下载流程。
    await handleSdState(task, inferred, tabId, context);
  } else {
    const state = await inspectSdTab(tabId);
    if (state) await handleSdState(task, state, tabId, context);
  }
  await pushOverlayState(tabId, false);
}

function scheduleSdInspection(tabId, context = {}) {
  if (!Number.isInteger(tabId)) return;
  const oldTimers = sdInspectionTimers.get(tabId) || [];
  oldTimers.forEach(clearTimeout);

  const delays = context.fast ? [0, 250, 800, 1800] : [120, 500, 1400, 3000];
  const timers = delays.map((delay, index) => setTimeout(() => {
    void inspectAndHandleSdTab(tabId, {
      ...context,
      reason: `${context.reason || 'navigation'}_${index}`,
      force: Boolean(context.force && index === delays.length - 1),
    });
    if (index === delays.length - 1) sdInspectionTimers.delete(tabId);
  }, delay));
  sdInspectionTimers.set(tabId, timers);
}

async function bindCreatedNavigationTarget(details) {
  if (!details || !Number.isInteger(details.tabId) || !Number.isInteger(details.sourceTabId)) return;
  const task = await getSdTask();
  if (!task || SD_TERMINAL_STATUSES.has(task.status) || !isTaskTab(task, details.sourceTabId)) return;

  task.activeTabId = details.tabId;
  task.pdfTabId = details.tabId;
  task.stage = 'OPENING_PDF';
  task.status = 'OPENING_PDF';
  task.challengePhase = 2;
  task.lastUrl = details.url || '';
  task.openedFromTabId = details.sourceTabId;
  await saveSdTask(task);
  scheduleSdInspection(details.tabId, {
    reason: 'created_navigation_target',
    url: details.url || '',
    fromTaskNavigation: true,
    fast: true,
  });
}

async function recoverSdUi(reason) {
  const task = await getSdTask();
  if (!task) return;
  if (SD_TERMINAL_STATUSES.has(task.status)) {
    // v1.3.4 及更早版本会把批量任务已经消费过的 STOPPED/DONE 状态长期留在
    // sd_state，导致监控窗在整批结束后仍展示上一篇论文。升级/唤醒时自动清理。
    if (task.batchJobId) await clearConsumedSdTask(task.id);
    return;
  }
  // Service Worker 恢复只恢复网页验证助手和任务检测，不应擅自创建下载进程窗。
  // 只有用户开启了自动打开选项时才恢复辅助监控窗。
  if (SD_MANUAL_STATUSES.has(task.status)) {
    const settings = await getFreepaperSettings();
    if (settings.autoOpenTaskMonitorOnChallenge === true) {
      void ensureTaskMonitorWindow({ focus: false });
    }
  }
  const tabId = [task.activeTabId, task.pdfTabId, task.articleTabId].find(Number.isInteger);
  if (Number.isInteger(tabId)) scheduleSdInspection(tabId, { reason, fast: true });
}

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[Freepaper] 扩展已安装/更新:', details?.reason || 'unknown');
  await chrome.storage.local.set({
    freepaper_build_info: { version: '1.3.7', build: 'github-ready-extension-only', installedAt: Date.now() },
  });
  await migrateLegacyBatchState(`onInstalled:${details?.reason || 'unknown'}`);
  chrome.alarms.create(BATCH_RESUME_ALARM, { periodInMinutes: 1 });
  await recoverActiveBatch('installed');
  await recoverSdUi('installed');
});

chrome.runtime.onStartup.addListener(async () => {
  await chrome.storage.local.set({
    freepaper_build_info: { version: '1.3.7', build: 'github-ready-extension-only', startedAt: Date.now() },
  });
  await migrateLegacyBatchState('browser_startup');
    chrome.alarms.create(BATCH_RESUME_ALARM, { periodInMinutes: 1 });
  await recoverActiveBatch('browser_startup');
  await recoverSdUi('browser_startup');
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BATCH_RESUME_ALARM) {
    void recoverActiveBatch('alarm');
    void recoverSdUi('alarm');
  }
});

chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
  void bindCreatedNavigationTarget(details);
});

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return;
  void (async () => {
    const task = await getSdTask();
    if (!task || SD_TERMINAL_STATUSES.has(task.status) || !isTaskTab(task, details.tabId)) return;
    task.activeTabId = details.tabId;
    task.lastUrl = details.url || task.lastUrl || '';
    if (details.tabId === task.pdfTabId || task.stage === 'OPENING_PDF' ||
        (() => { try { return new URL(details.url).hostname.toLowerCase() === 'pdf.sciencedirectassets.com'; } catch (_) { return false; } })()) {
      task.pdfTabId = details.tabId;
      task.stage = 'OPENING_PDF';
      task.status = 'OPENING_PDF';
      task.challengePhase = 2;
    }
    await saveSdTask(task);
  })();
});

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  void (async () => {
    const task = await getSdTask();
    if (!task || SD_TERMINAL_STATUSES.has(task.status) || !isTaskTab(task, details.tabId)) return;
    task.activeTabId = details.tabId;
    task.activeDocumentId = details.documentId || null;
    task.lastUrl = details.url || task.lastUrl || '';
    await saveSdTask(task);
    scheduleSdInspection(details.tabId, {
      reason: 'committed',
      documentId: details.documentId,
      url: details.url,
      fast: true,
    });
  })();
});

chrome.webNavigation.onDOMContentLoaded.addListener((details) => {
  if (details.frameId !== 0) return;
  scheduleSdInspection(details.tabId, {
    reason: 'dom_content_loaded',
    documentId: details.documentId,
    url: details.url,
    fast: true,
  });
});

chrome.webNavigation.onCompleted.addListener((details) => {
  if (details.frameId !== 0) return;
  scheduleSdInspection(details.tabId, {
    reason: 'navigation_completed',
    documentId: details.documentId,
    url: details.url,
    fast: true,
  });
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (!info.url && info.status !== 'loading' && info.status !== 'complete') return;
  void (async () => {
    const task = await getSdTask();
    if (!task || SD_TERMINAL_STATUSES.has(task.status)) return;
    if (!isTaskTab(task, tabId)) return;
    scheduleSdInspection(tabId, {
      reason: `tabs_${info.status || 'url'}`,
      url: info.url || tab.url || '',
      fast: info.status === 'complete',
    });
  })();
});

chrome.tabs.onCreated.addListener((tab) => {
  if (!Number.isInteger(tab.id) || !Number.isInteger(tab.openerTabId)) return;
  void (async () => {
    const task = await getSdTask();
    if (!task || SD_TERMINAL_STATUSES.has(task.status) || !isTaskTab(task, tab.openerTabId)) return;
    task.activeTabId = tab.id;
    task.pdfTabId = tab.id;
    task.stage = 'OPENING_PDF';
    task.status = 'OPENING_PDF';
    task.challengePhase = 2;
    task.openedFromTabId = tab.openerTabId;
    task.lastUrl = tab.pendingUrl || tab.url || '';
    await saveSdTask(task);
    scheduleSdInspection(tab.id, {
      reason: 'tabs_created_with_opener',
      url: tab.pendingUrl || tab.url || '',
      fromTaskNavigation: true,
      fast: true,
    });
  })();
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const task = await getSdTask();
  if (!task || SD_TERMINAL_STATUSES.has(task.status) || !isTaskTab(task, tabId)) return;
  const remaining = [task.pdfTabId, task.articleTabId, task.activeTabId]
    .filter(id => Number.isInteger(id) && id !== tabId);
  task.activeTabId = remaining[0] ?? null;
  if (!task.activeTabId) {
    task.status = 'WAITING_MANUAL_PDF';
    task.lastError = '任务页面已关闭；请在任务监控窗中跳过或终止。';
  }
  await saveSdTask(task);
});

chrome.windows.onCreated.addListener((win) => {
  if (win?.type !== 'popup') return;
  // task-monitor 页刚创建时 tabs 可能尚未填充，稍后按 URL 统一去重。
  setTimeout(() => void resolveSingleTaskMonitorWindow(), 350);
});

chrome.windows.onRemoved.addListener((windowId) => {
  void (async () => {
    const monitorId = await getTaskMonitorWindowId();
    if (monitorId === windowId) await chrome.storage.local.remove(TASK_MONITOR_WINDOW_KEY);
  })();
});

setupMessageRouter();
chrome.alarms.create(BATCH_RESUME_ALARM, { periodInMinutes: 1 });
void recoverActiveBatch('service_worker_start');
void recoverSdUi('service_worker_start');

console.log('[Freepaper] Background Service Worker 已启动');
