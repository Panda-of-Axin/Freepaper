/* This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
 * If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// background.js — Freepaper 扩展后台 Service Worker
'use strict';

// =========================================================================
// 全站通用人工接管：统一状态源 + 可恢复浮窗
// 适用于明确识别出的验证码、登录、机构认证、访问拒绝和手动 PDF 操作。
// =========================================================================
const SD_STORAGE_KEY = 'sd_state';
const SD_TERMINAL_STATUSES = new Set(['DONE', 'FAILED', 'STOPPED']);
// 页面浮窗只在确实需要用户介入时出现。处理中、跳转中、自动下载中均由
// 主面板/任务监控窗展示，避免验证助手长期遮挡论文页面。
const SD_OVERLAY_STATUSES = new Set([
  'WAITING_CHALLENGE_1',
  'WAITING_CHALLENGE_2',
  'WAITING_MANUAL_PDF',
  'WAITING_BROWSER_DOWNLOAD',
  'ACCESS_DENIED',
]);
const GUIDED_PUBLISHER_PROVIDERS = new Set(['sciencedirect', 'wiley', 'ieee', 'cnki']);
const ONBOARDING_PAGE = 'onboarding.html';
const EXAMPLE_CSV_PATH = 'examples/freepaper-example.csv';
const EXAMPLE_CSV_TEXT = '\uFEFFdoi,url,title\r\n10.48550/arXiv.2010.08895,https://arxiv.org/pdf/2010.08895,Fourier Neural Operator for Parametric Partial Differential Equations\r\n,https://ieeexplore.ieee.org/document/9282004,Physics-Informed Neural Networks for Power Systems\r\n10.1002/inf2.12028,https://onlinelibrary.wiley.com/doi/full/10.1002/inf2.12028,Machine learning in materials science\r\n';
const SD_MANUAL_STATUSES = new Set([
  'WAITING_CHALLENGE_1',
  'WAITING_CHALLENGE_2',
  'WAITING_MANUAL_PDF',
  'ACCESS_DENIED',
]);
const MANUAL_DOWNLOAD_OBSERVE_STATUSES = new Set([
  ...SD_MANUAL_STATUSES,
  'CHECKING_AFTER_CHALLENGE',
  'OPENING_PDF',
  'DOWNLOADING_PDF',
  'WAITING_BROWSER_DOWNLOAD',
]);
const MANUAL_DOWNLOAD_CLAIM_WINDOW_MS = 15 * 60 * 1000;
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
    autoOpenTaskMonitorOnChallenge: true,
    assistedPublisherMode: false,
    autoOpenClearPdfAction: true,
    preserveInputOrder: true,
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

async function markTaskExtensionDownloadStarted(taskId, attemptId, downloadId) {
  if (!taskId || !Number.isInteger(downloadId)) return;
  const task = await getSdTask();
  if (!task || task.id !== taskId || SD_TERMINAL_STATUSES.has(task.status)) return;
  if (attemptId && task.downloadAttemptId && task.downloadAttemptId !== attemptId) return;
  task.extensionDownloadId = downloadId;
  task.extensionDownloadStartedAt = Date.now();
  await saveSdTask(task);
}

async function removeInvalidDownloadedFile(downloadId) {
  if (!Number.isInteger(downloadId)) return;
  try { await chrome.downloads.removeFile(downloadId); } catch (_) {}
  try { await chrome.downloads.erase({ id: downloadId }); } catch (_) {}
  await unregisterFreepaperDownload(downloadId);
}

async function downloadVerifiedResource({ url = '', blobUrl = '', folder = 'freepaper', filename = 'paper.pdf', taskId = '', attemptId = '' } = {}) {
  const relativePath = buildDownloadRelativePath(folder, filename);
  const candidates = [...new Set([blobUrl, url].filter((item) => typeof item === 'string' && item))];
  let lastError = '没有可下载的 URL';

  let skippedContextBound = false;
  for (const candidate of candidates) {
    let downloadId = null;
    try {
      if (/^https?:/i.test(candidate) && isContextBoundPublisherPdfUrl(candidate)) {
        // IEEE/Wiley/ScienceDirect/CNKI 的动态 PDF 端点往往依赖当前页面的
        // Referrer、验证会话或一次性令牌。直接交给 downloads API 会发起第二次
        // 脱离页面上下文的请求，服务器可能返回 stamp.htm/init.htm 等 HTML。
        skippedContextBound = true;
        lastError = 'CONTEXT_BOUND_PDF_URL';
        continue;
      }
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
      await markTaskExtensionDownloadStarted(taskId, attemptId, downloadId);
      const completed = await waitForDownloadId(downloadId, DOWNLOAD_WAIT_TIMEOUT_MS);
      if (completed) {
        const mime = String(completed.mime || '').toLowerCase();
        if (mime.includes('text/html') || mime.startsWith('text/') || mime.includes('json')) {
          await removeInvalidDownloadedFile(downloadId);
          return { ok: false, reason: 'HTML_CONTENT_TYPE', mime, downloadId, relativePath };
        }
        await finalizeRegisteredFreepaperDownload(downloadId);
        return {
          ok: true,
          downloadId,
          filename: completed.filename || relativePath,
          fileSize: completed.fileSize || 0,
          mime: completed.mime || '',
          finalUrl: completed.finalUrl || completed.url || url || candidate,
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

  return {
    ok: false,
    reason: skippedContextBound ? 'CONTEXT_BOUND_PDF_URL' : 'DOWNLOAD_API_FAILED',
    error: lastError,
    relativePath,
  };
}

async function getSdTask() {
  const data = await chrome.storage.local.get(SD_STORAGE_KEY);
  return data[SD_STORAGE_KEY] || null;
}

function sdStatusMessage(task) {
  const verificationRound = Math.max(1, Number(task?.verificationRound || 1));
  const pdfActionRound = Math.max(0, Number(task?.pdfActionRound || 0));
  const messages = {
    OPENING: '正在打开论文页面…',
    ARTICLE_READY: '论文详情页已就绪。',
    OPENING_PDF: '正在等待 PDF 页面、验证页面或浏览器下载响应…',
    PDF_PAGE_READY: 'PDF 页面已就绪，正在验证并下载…',
    DOWNLOADING_PDF: '已检测到当前 PDF 下载，正在等待下载完成…',
    WAITING_BROWSER_DOWNLOAD: '页面已完成验证，正在等待浏览器下载事件并核对结果…',
    CHECKING_AFTER_CHALLENGE: '正在等待页面跳转稳定并重新检测，请不要重复点击。',
    ACCESS_DENIED: task?.stage === 'PURCHASE'
      ? '当前页面是购买或订阅入口，账号或机构可能没有全文权限。'
      : task?.stage === 'INSTITUTION_AUTH'
        ? '需要通过学校、图书馆或机构账号完成认证。认证结束后 Freepaper 会重新检测并继续 PDF 流程。'
        : task?.stage === 'ACCOUNT_AUTH'
          ? '需要登录当前出版商账号。登录结束后 Freepaper 会重新检测并继续 PDF 流程。'
          : '出版商返回了访问受限页面，请确认当前账号或机构权限。',
    DONE: 'PDF 已下载，正在继续下一篇。',
    FAILED: '当前论文下载失败。',
    STOPPED: '当前论文已停止。',
  };
  if (task?.status === 'WAITING_CHALLENGE_1' || task?.status === 'WAITING_CHALLENGE_2') {
    const afterPdfAction = pdfActionRound > 0 || task.challengePhase === 2;
    return afterPdfAction
      ? `点击 View PDF / Download PDF 后出现第 ${verificationRound} 轮验证。请完成验证；如果验证后仍显示 PDF 按钮，请再次手动点击。`
      : `当前论文页面出现第 ${verificationRound} 轮安全验证。请由你本人完成验证，然后点击“重新检测”。`;
  }
  if (task?.status === 'WAITING_MANUAL_PDF') {
    if (pdfActionRound > 0 || task?.returningFromVerification) {
      return '页面已返回论文详情页，但尚未检测到真实 PDF。请再次手动点击 View PDF / Download PDF；后续如再次出现验证，Freepaper 会继续等待。';
    }
    return '未找到足够明确的 PDF 入口。请手动点击 View PDF / Download PDF；Freepaper 会监听后续跳转、重复验证和浏览器下载。';
  }
  if (task?.status === 'WAITING_BROWSER_DOWNLOAD') {
    return task?.autoSaveFailed
      ? 'PDF 已经打开，但浏览器没有允许 Freepaper 自动保存。请点击 PDF 查看器的下载按钮；Freepaper 会把该下载关联到当前论文并保存到设置的子文件夹。'
      : '已经进入下载交接阶段，正在等待浏览器创建或完成 PDF 下载。';
  }
  return messages[task?.status] || task?.lastError || '处理中…';
}

function sdOverlayPayload(task) {
  if (!task || !SD_OVERLAY_STATUSES.has(task.status)) return null;
  const verificationRound = Math.max(1, Number(task.verificationRound || 1));
  let guidanceType = task.guidanceType || 'action';
  if (task.status === 'WAITING_MANUAL_PDF') guidanceType = 'click_pdf';
  else if (task.status === 'WAITING_BROWSER_DOWNLOAD') guidanceType = 'waiting_download';
  else if (task.status === 'WAITING_CHALLENGE_1' || task.status === 'WAITING_CHALLENGE_2') guidanceType = 'verification';
  else if (task.status === 'ACCESS_DENIED') {
    guidanceType = task.stage === 'PURCHASE'
      ? 'permission'
      : task.stage === 'INSTITUTION_AUTH'
        ? 'institution_login'
        : task.stage === 'ACCOUNT_AUTH'
          ? 'account_login'
          : 'access';
  }
  return {
    taskId: task.id,
    status: task.status,
    phase: task.status === 'WAITING_CHALLENGE_2' || task.challengePhase === 2 ? 2 : 1,
    verificationRound,
    pdfActionRound: Number(task.pdfActionRound || 0),
    guidanceType,
    doi: task.doi || '',
    message: task.lastError || sdStatusMessage(task),
    hint: guidanceType === 'verification'
      ? '验证可能出现多次。请勿关闭任务页；完成当前验证后，页面若仍显示 View PDF / Download PDF，请再次手动点击。'
      : guidanceType === 'click_pdf'
        ? '请由你本人点击明确的 PDF 按钮。Freepaper 不会自动操作验证码或模拟鼠标。'
      : guidanceType === 'waiting_download'
        ? 'PDF 已经打开或下载已经开始。请不要重复刷新；自动保存失败时，可点击浏览器 PDF 查看器中的下载按钮。'
      : guidanceType === 'permission'
          ? '购买页不是 PDF，也不是验证码。请确认机构权限，或跳过当前文献。'
          : guidanceType === 'institution_login'
            ? '请完成学校、图书馆或机构认证。Freepaper 不读取账号、密码或 Cookie。'
            : guidanceType === 'account_login'
              ? '请登录出版商账号。Freepaper 不读取账号、密码或 Cookie。'
              : '请确认当前页面的访问状态，再重新检测。',
    primaryLabel: guidanceType === 'click_pdf'
      ? '重新检测 PDF 入口'
      : guidanceType === 'waiting_download'
        ? '重新核对下载状态'
        : '我已完成，重新检测',
    updatedAt: task.updatedAt || Date.now(),
  };
}

function taskTabIds(task) {
  if (!task) return [];
  return [
    task.activeTabId,
    task.articleTabId,
    task.pdfTabId,
    ...(Array.isArray(task.managedTabIds) ? task.managedTabIds : []),
    ...(Array.isArray(task.pendingChildTabIds) ? task.pendingChildTabIds : []),
    ...(Array.isArray(task.ignoredTabIds) ? task.ignoredTabIds : []),
  ].filter((id, index, all) => Number.isInteger(id) && all.indexOf(id) === index);
}

function rememberTaskTab(task, tabId, pending = false) {
  if (!task || !Number.isInteger(tabId)) return;
  const key = pending ? 'pendingChildTabIds' : 'managedTabIds';
  const values = Array.isArray(task[key]) ? task[key] : [];
  if (!values.includes(tabId)) values.push(tabId);
  task[key] = values;
}

function forgetPendingTaskTab(task, tabId) {
  if (!task || !Array.isArray(task.pendingChildTabIds)) return;
  task.pendingChildTabIds = task.pendingChildTabIds.filter((id) => id !== tabId);
}

function markIgnoredTaskTab(task, tabId) {
  if (!task || !Number.isInteger(tabId)) return;
  const values = Array.isArray(task.ignoredTabIds) ? task.ignoredTabIds : [];
  if (!values.includes(tabId)) values.push(tabId);
  task.ignoredTabIds = values;
}

function unmarkIgnoredTaskTab(task, tabId) {
  if (!task || !Array.isArray(task.ignoredTabIds)) return;
  task.ignoredTabIds = task.ignoredTabIds.filter((id) => id !== tabId);
}

function isTaskTab(task, tabId) {
  if (!task || tabId == null) return false;
  if (Array.isArray(task.ignoredTabIds) && task.ignoredTabIds.includes(tabId)) return false;
  return taskTabIds(task).includes(tabId);
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

async function createTaskMonitorWindow({ focused = true } = {}) {
  try {
    // 创建前最后再查一次，覆盖“前一个并发分支刚完成创建但还没写入 ID”的极窄窗口。
    const existingId = await resolveSingleTaskMonitorWindow();
    if (Number.isInteger(existingId)) return existingId;

    const created = await chrome.windows.create({
      url: TASK_MONITOR_URL,
      type: 'popup',
      width: 390,
      height: 560,
      focused: focused === true,
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
      return Number.isInteger(existingId) ? existingId : createTaskMonitorWindow({ focused: focus });
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

async function syncBatchPaperWaitingState(task) {
  if (!task?.batchJobId || !Number.isInteger(task.batchIndex) || SD_TERMINAL_STATUSES.has(task.status)) return;
  const batch = await loadBatchState().catch(() => null);
  if (!batch || batch.jobId !== task.batchJobId || !batch.running) return;
  const paper = batch.papers?.[task.batchIndex];
  if (!paper) return;

  let paperStatus = 'downloading';
  if (task.status === 'ACCESS_DENIED' && ['ACCOUNT_AUTH', 'INSTITUTION_AUTH'].includes(task.stage)) {
    paperStatus = 'waiting_login';
  } else if (['WAITING_CHALLENGE_1', 'WAITING_CHALLENGE_2', 'WAITING_MANUAL_PDF', 'WAITING_BROWSER_DOWNLOAD', 'ACCESS_DENIED'].includes(task.status)) {
    paperStatus = 'waiting_user';
  }

  paper.status = paperStatus;
  paper.error = paperStatus.startsWith('waiting_') ? sdStatusMessage(task) : '';
  batch.activeIndex = task.batchIndex;
  batch.activeTabId = Number.isInteger(task.activeTabId) ? task.activeTabId : batch.activeTabId;
  batch.current = Math.max(Number(batch.current || 0), task.batchIndex + 1);
  await saveBatchState(batch);
}

async function saveSdTask(task) {
  if (!task) {
    await chrome.storage.local.remove([SD_STORAGE_KEY, 'sd_notification']);
    return;
  }
  if (SD_MANUAL_STATUSES.has(task.status)) {
    if (task.lastManualStatus !== task.status) task.manualStateStartedAt = Date.now();
    task.lastManualStatus = task.status;
  } else if (SD_TERMINAL_STATUSES.has(task.status)) {
    delete task.manualStateStartedAt;
    delete task.lastManualStatus;
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
  // 将人工验证/登录等待同步到批量状态。这样“需要登录”不会被当作失败，
  // 批次保持 running，用户完成登录后可从同一篇继续。
  await syncBatchPaperWaitingState(task);
  if (Number.isInteger(task.activeTabId)) {
    void pushOverlayState(task.activeTabId);
  }
  // 批量任务开始时默认创建唯一下载进程窗；进入人工验证状态时，
  // 同一状态只自动聚焦一次，避免重复弹窗和抢焦点。
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

function detectSdPageState(providerHint = '') {
  const host = location.hostname.toLowerCase();
  const url = location.href;
  const parsedPath = location.pathname.toLowerCase();
  const titleText = document.title || '';
  const title = titleText.toLowerCase();
  const bodyText = document.body?.innerText || '';
  const body = bodyText.slice(0, 50000).toLowerCase();
  const readyState = document.readyState;

  const inferredProvider = providerHint || (
    host.endsWith('sciencedirect.com') || host.endsWith('.sciencedirectassets.com') || host.endsWith('.elsevier.com')
      ? 'sciencedirect'
      : host.endsWith('onlinelibrary.wiley.com') || host.endsWith('.wiley.com')
        ? 'wiley'
        : host.includes('ieee.org')
          ? 'ieee'
          : host === 'cnki.net' || host.endsWith('.cnki.net') || parsedPath.includes('/kcms/') || parsedPath.includes('/kcms2/')
            ? 'cnki'
            : host === 'link.springer.com' || host.endsWith('.springer.com') || host.endsWith('.springernature.com')
              ? 'springer'
              : host.endsWith('tandfonline.com') || host.endsWith('.taylorfrancis.com')
                ? 'taylorfrancis'
                : location.protocol === 'http:' || location.protocol === 'https:'
                  ? 'generic'
                  : ''
  );

  const hasCaptcha = [...document.querySelectorAll('iframe[src]')].some((frame) => {
    const src = (frame.src || '').toLowerCase();
    return src.includes('challenges.cloudflare.com') || src.includes('captcha') ||
      src.includes('arkoselabs') || src.includes('recaptcha');
  });
  const challengeWords = [
    'verify you are human', 'checking your browser', 'just a moment',
    'are you a robot', 'security verification', 'complete the security check',
    'unusual traffic', 'robot check', 'human verification',
    'performing security verification', 'press and hold', 'ray id',
    'please stand by while we are checking your browser',
    '请稍候', '安全验证', '机器人验证', '访问过于频繁', '操作过于频繁',
  ];
  if (hasCaptcha || challengeWords.some((word) => title.includes(word) || body.includes(word))) {
    return {
      type: 'CHALLENGE', provider: inferredProvider, title: titleText,
      host, url, readyState, bodyLength: bodyText.length,
    };
  }

  if (inferredProvider === 'cnki' &&
      (/\/bar\/verify\/verifysuccess\.html/i.test(parsedPath) ||
       (body.includes('验证完成') && (body.includes('进入下载') || body.includes('下载完成后'))))) {
    return {
      type: 'DOWNLOAD_HANDOFF', provider: inferredProvider, title: titleText,
      host, url, readyState, bodyLength: bodyText.length,
    };
  }

  const deniedWords = [
    'access denied', 'temporarily blocked', 'request rejected',
    'your access has been blocked', 'you do not have access',
    'not entitled to access', '无权访问', '没有权限',
  ];
  if (deniedWords.some((word) => title.includes(word) || body.includes(word))) {
    return {
      type: 'DENIED', provider: inferredProvider, title: titleText,
      host, url, readyState, bodyLength: bodyText.length,
    };
  }

  const authUrlText = `${host}${parsedPath}${location.search}`.toLowerCase();
  const institutionUrl = /(?:institution|institutional|shibboleth|openathens|saml|\/idp\/|\/sso\/|wayf|federat)/i.test(authUrlText);
  const isExplicitAuthUrl = /\/(?:login|sign-?in|authenticate|authentication|shibboleth|institutional-login)(?:\/|$)/i.test(parsedPath);
  const looksLikeAuthForm = Boolean(document.querySelector(
    'input[type="password"],form[action*="login" i],form[action*="signin" i],form[action*="auth" i],a[href*="institution" i],a[href*="shibboleth" i],a[href*="openathens" i]'
  ));
  const isVisibleElement = (element) => {
    if (!element) return false;
    const rect = element.getBoundingClientRect?.();
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(element) : null;
    return Boolean(rect && rect.width > 2 && rect.height > 2 &&
      style?.display !== 'none' && style?.visibility !== 'hidden' && style?.opacity !== '0');
  };
  const visiblePasswordInput = [...document.querySelectorAll('input[type="password"]')].some(isVisibleElement);
  const visibleAuthIframe = [...document.querySelectorAll('iframe[src]')].some((frame) => {
    const src = String(frame.src || frame.getAttribute?.('src') || '').toLowerCase();
    return isVisibleElement(frame) && /(?:login|signin|passport|account|auth)/i.test(src);
  });
  const visibleAuthDialog = [...document.querySelectorAll('[role="dialog"],dialog,.modal,.login-modal,.login-dialog,.login-box')].some((dialog) => {
    if (!isVisibleElement(dialog)) return false;
    const text = String(dialog.innerText || dialog.textContent || '').toLowerCase();
    const hasInput = Boolean(dialog.querySelector?.('input,button,a'));
    return hasInput && /(?:sign in|log in|login|账号登录|用户登录|手机号登录|密码登录|登录)/i.test(text);
  });
  const institutionText = [
    'institutional sign in', 'institutional access', 'access through your institution',
    'sign in through your institution', 'shibboleth', 'openathens', 'single sign-on',
    '学校认证', '机构认证', '机构登录', '校园认证', '图书馆认证', '统一身份认证',
  ].some((word) => title.includes(word) || body.includes(word));
  const institutionAccessPrompt = (
    body.includes('need full-text access') ||
    body.includes('full-text access for your organization') ||
    body.includes('access through your institution') ||
    body.includes('contact ieee to subscribe') ||
    body.includes('通过机构访问') ||
    body.includes('机构全文访问')
  );
  const authTitle = /\b(?:sign in|log in|login|authentication|institutional access)\b/i.test(titleText) || /登录|认证|机构访问/.test(titleText);
  if (institutionAccessPrompt && institutionText) {
    return {
      type: 'INSTITUTION_AUTH_REQUIRED', provider: inferredProvider, title: titleText,
      host, url, readyState, bodyLength: bodyText.length,
    };
  }
  if (isExplicitAuthUrl || (authTitle && looksLikeAuthForm) ||
      (inferredProvider === 'cnki' && (visiblePasswordInput || visibleAuthIframe || visibleAuthDialog))) {
    return {
      type: institutionUrl || institutionText ? 'INSTITUTION_AUTH_REQUIRED' : 'ACCOUNT_AUTH_REQUIRED',
      provider: inferredProvider, title: titleText,
      host, url, readyState, bodyLength: bodyText.length,
    };
  }

  if (inferredProvider === 'sciencedirect') {
    if (/\/getaccess\/.*\/purchase(?:$|[/?#])/i.test(url) ||
        /\/purchase(?:$|[/?#])/i.test(parsedPath) ||
        body.includes('purchase research article') ||
        title.includes('purchase ')) {
      return {
        type: 'PURCHASE', provider: inferredProvider, title: titleText,
        host, url, readyState, bodyLength: bodyText.length,
      };
    }
    if (host === 'pdf.sciencedirectassets.com' || /\/pdfft(?:$|[?#])/i.test(url) ||
        document.querySelector('embed[type="application/pdf"],object[type="application/pdf"]')) {
      return {
        type: 'PDF_VIEWER', provider: inferredProvider, title: titleText,
        host, url, readyState, bodyLength: bodyText.length,
      };
    }
    if (host.includes('sciencedirect.com') && /\/science\/article\//i.test(url)) {
      const citationPdf = document.querySelector('meta[name="citation_pdf_url"]')?.content || '';
      return {
        type: 'ARTICLE', provider: inferredProvider, title: titleText,
        host, url, citationPdf, readyState, bodyLength: bodyText.length,
      };
    }
  }

  if (inferredProvider === 'wiley') {
    if (/\/doi\/(?:pdfdirect|pdf|epdf)\//i.test(parsedPath) ||
        document.querySelector('embed[type="application/pdf"],object[type="application/pdf"]')) {
      return {
        type: 'PDF_VIEWER', provider: inferredProvider, title: titleText,
        host, url, readyState, bodyLength: bodyText.length,
      };
    }
    if (/\/doi\/(?:full|abs)\//i.test(parsedPath) || /\/doi\/10\./i.test(parsedPath)) {
      const citationPdf = document.querySelector('meta[name="citation_pdf_url"]')?.content || '';
      return {
        type: 'ARTICLE', provider: inferredProvider, title: titleText,
        host, url, citationPdf, readyState, bodyLength: bodyText.length,
      };
    }
  }

  if (inferredProvider === 'ieee') {
    if (/\/stamppdf\/getpdf\.jsp/i.test(parsedPath) || /\/stamp\/stamp\.jsp/i.test(parsedPath) ||
        document.querySelector('embed[type="application/pdf"],object[type="application/pdf"]')) {
      return {
        type: 'PDF_VIEWER', provider: inferredProvider, title: titleText,
        host, url, readyState, bodyLength: bodyText.length,
      };
    }
    if (/\/document\/\d+/i.test(parsedPath)) {
      const citationPdf = document.querySelector('meta[name="citation_pdf_url"]')?.content || '';
      return {
        type: 'ARTICLE', provider: inferredProvider, title: titleText,
        host, url, citationPdf, readyState, bodyLength: bodyText.length,
      };
    }
  }

  const embeddedPdf = Boolean(document.querySelector('embed[type="application/pdf"],object[type="application/pdf"]'));
  const likelyPdfUrl = /\.pdf(?:$|[?#])/i.test(url) ||
    /\/(?:pdf|pdfdirect|epdf|pdfft)(?:\/|$)/i.test(parsedPath) ||
    /stamppdf\/getpdf\.jsp|stamp\/stamp\.jsp/i.test(parsedPath) ||
    (inferredProvider === 'cnki' && /(?:^|\/)(?:kcms\/)?(?:download|kbdownload)\.aspx$/i.test(parsedPath)) ||
    /(?:^|[?&])(?:download|type|format|dflag)=(?:pdf|pdfdown)(?:&|$)/i.test(location.search);
  if (embeddedPdf || likelyPdfUrl) {
    return {
      type: 'PDF_VIEWER', provider: inferredProvider, title: titleText,
      host, url, readyState, bodyLength: bodyText.length,
    };
  }

  if (inferredProvider && (location.protocol === 'http:' || location.protocol === 'https:')) {
    const citationPdf = document.querySelector('meta[name="citation_pdf_url"]')?.content || '';
    return {
      type: 'ARTICLE', provider: inferredProvider, title: titleText,
      host, url, citationPdf, readyState, bodyLength: bodyText.length,
    };
  }

  return {
    type: 'UNKNOWN', provider: inferredProvider, title: titleText,
    host, url, readyState, bodyLength: bodyText.length,
  };
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

function getPublisherProvider(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const path = url.pathname.toLowerCase();
    const known = getInteractivePublisher(value);
    if (known) return known;
    if (isCnkiLikeUrl(url)) return 'cnki';
    if (host === 'link.springer.com' || host.endsWith('.springer.com') || host.endsWith('.springernature.com')) return 'springer';
    if (host.endsWith('tandfonline.com') || host.endsWith('.taylorfrancis.com')) return 'taylorfrancis';
    if (host.endsWith('acs.org')) return 'acs';
    if (host.endsWith('rsc.org')) return 'rsc';
    if (url.protocol === 'http:' || url.protocol === 'https:') return 'generic';
  } catch (_) {}
  return '';
}

function requiresManualPdfAction(provider) {
  return GUIDED_PUBLISHER_PROVIDERS.has(String(provider || '').toLowerCase());
}

function shouldUseRecoverablePublisherHandoff({
  provider = '',
  pageType = '',
  pdfCandidateCount = 0,
  explicitManualState = false,
  candidateNeedsHandoff = false,
} = {}) {
  const normalizedProvider = String(provider || '').toLowerCase();
  const guided = GUIDED_PUBLISHER_PROVIDERS.has(normalizedProvider);
  const supported = guided || ['springer', 'taylorfrancis', 'acs', 'rsc'].includes(normalizedProvider);
  if (explicitManualState || candidateNeedsHandoff) return true;
  // 对 IEEE/Wiley/ScienceDirect/CNKI，只要已到该出版商页面但自动获取失败，
  // 就进入可恢复人工接管，而不是把“可能需要登录”直接记为失败并结束批次。
  if (guided) return true;
  return supported && (Number(pdfCandidateCount || 0) > 0 || pageType === 'ARTICLE');
}

function stableTaskArticleKey(task) {
  const raw = task?.url || task?.lastArticleUrl || task?.doi || '';
  try {
    const url = new URL(raw);
    url.hash = '';
    const provider = task?.provider || getPublisherProvider(url.href) || 'generic';
    if (provider === 'ieee') {
      const arnumber = url.pathname.match(/\/document\/(\d+)/i)?.[1] || url.searchParams.get('arnumber') || '';
      if (arnumber) return `ieee:${arnumber}`;
    }
    if (provider === 'sciencedirect') {
      const pii = url.pathname.match(/\/pii\/([^/?#]+)/i)?.[1] || '';
      if (pii) return `sciencedirect:${pii.toLowerCase()}`;
    }
    if (provider === 'wiley') {
      const doi = normalizeBatchDoi(decodeURIComponent(url.pathname)) || normalizeBatchDoi(task?.doi || '');
      if (doi) return `wiley:${doi}`;
    }
    if (provider === 'cnki') {
      const key = cnkiDocumentKey(url);
      if (key) return key;
    }
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_|ref$|source$|campaign$|token$|timestamp$)/i.test(key)) url.searchParams.delete(key);
    }
    return `${provider}:${url.origin}${url.pathname}${url.search}`;
  } catch (_) {
    return `${task?.provider || 'generic'}:${String(raw)}`;
  }
}

function autoPdfAttemptKey(task) {
  return [
    stableTaskArticleKey(task),
    `verify:${Math.max(0, Number(task?.verificationRound || 0))}`,
    `auth:${Math.max(0, Number(task?.accessRecoveryRound || 0))}`,
    `manual:${Math.max(0, Number(task?.manualRetryRound || 0))}`,
  ].join('|');
}

function taskDocumentKey(state, context = {}) {
  return context.documentId || `${state?.type || 'UNKNOWN'}:${state?.url || ''}:${state?.title || ''}`;
}

function noteVerificationRound(task, state, context = {}) {
  const signature = `${state?.url || ''}:${state?.title || ''}`;
  const alreadyWaiting = (task.status === 'WAITING_CHALLENGE_1' || task.status === 'WAITING_CHALLENGE_2') &&
    task.lastVerificationSignature === signature;
  const pdfActionAfterLastVerification = Number(task.lastUserPdfActionAt || 0) > Number(task.lastVerificationAt || 0);
  if (!alreadyWaiting || pdfActionAfterLastVerification) {
    task.verificationRound = Math.max(0, Number(task.verificationRound || 0)) + 1;
    task.lastVerificationAt = Date.now();
  }
  task.lastVerificationSignature = signature;
  task.lastVerificationDocumentKey = taskDocumentKey(state, context);
  return Math.max(1, Number(task.verificationRound || 1));
}

function sanitizeDiagnosticUrl(value) {
  try {
    const url = new URL(value);
    const keep = new Set(['filename', 'fileName', 'dbcode', 'dbname', 'arnumber', 'pii', 'dflag']);
    for (const key of [...url.searchParams.keys()]) {
      if (!keep.has(key)) url.searchParams.set(key, '<redacted>');
    }
    url.hash = '';
    return url.href;
  } catch (_) {
    return String(value || '').slice(0, 500);
  }
}

async function buildDiagnosticReport() {
  const [task, batch, settingsData] = await Promise.all([
    getSdTask(),
    loadBatchState().catch(() => null),
    chrome.storage.local.get('freepaper_settings'),
  ]);
  const report = {
    generatedAt: new Date().toISOString(),
    extensionVersion: chrome.runtime.getManifest().version,
    settings: {
      language: settingsData.freepaper_settings?.language || 'auto',
      autoOpenTaskMonitorOnChallenge: settingsData.freepaper_settings?.autoOpenTaskMonitorOnChallenge !== false,
      assistedPublisherMode: settingsData.freepaper_settings?.assistedPublisherMode !== false,
    },
    activePaper: task ? {
      status: task.status || '',
      stage: task.stage || '',
      provider: task.provider || '',
      doi: task.doi || '',
      title: task.title || '',
      verificationRound: Number(task.verificationRound || 0),
      pdfActionRound: Number(task.pdfActionRound || 0),
      lastUrl: sanitizeDiagnosticUrl(task.lastUrl || task.url || ''),
      lastError: task.lastError || task.reason || '',
      managedTabs: taskTabIds(task).length,
    } : null,
    batch: batch ? {
      running: batch.running === true,
      paused: batch.paused === true,
      total: Number(batch.total || batch.papers?.length || 0),
      done: Number(batch.done || 0),
      failed: Number(batch.failed || 0),
      activeIndex: Number.isInteger(batch.activeIndex) ? batch.activeIndex : -1,
    } : null,
    privacyNote: 'This report excludes cookies, passwords, authentication tokens, browser profiles, and paper full text.',
  };
  return JSON.stringify(report, null, 2);
}

function looksLikeAuthenticationUrl(value) {
  try {
    const url = new URL(value);
    const haystack = `${url.hostname}${url.pathname}${url.search}`.toLowerCase();
    return /(?:login|log-in|signin|sign-in|authenticate|authentication|shibboleth|openathens|saml|oauth|\/idp\/|\/sso\/|captcha|challenge|verify|security-check|institution)/i.test(haystack);
  } catch (_) {
    return false;
  }
}

function isLikelyPdfEndpoint(value) {
  try {
    const url = new URL(value);
    const path = url.pathname.toLowerCase();
    const query = url.search.toLowerCase();
    if (isCnkiPdfEndpoint(url)) return true;
    if (/\.pdf$/i.test(path)) return true;
    if (/(?:^|\/)(?:pdf|pdfdirect|epdf|pdfft)(?:\/|$)/i.test(path)) return true;
    if (/stamppdf\/getpdf\.jsp|stamp\/stamp\.jsp/i.test(path)) return true;
    if (/(?:^|[?&])(?:download|type|format|dflag)=?(?:pdf|pdfdown)(?:&|$)/i.test(query)) return true;
    if (/download\.aspx|kbdownload\.aspx/i.test(path) && /pdf|pdfdown/i.test(query)) return true;
  } catch (_) {}
  return false;
}

function getInteractivePublisher(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (host.endsWith('sciencedirect.com') || host.endsWith('.sciencedirectassets.com') ||
        (host === 'elsevier.com' || host.endsWith('.elsevier.com'))) return 'sciencedirect';
    if (host.endsWith('onlinelibrary.wiley.com')) return 'wiley';
    if (host.includes('ieee.org')) return 'ieee';
  } catch (_) {}
  return '';
}

function isInteractivePublisherUrl(value) {
  return Boolean(getPublisherProvider(value));
}

function isPublisherPdfEndpoint(value, providerHint = '') {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const path = url.pathname.toLowerCase();
    const provider = providerHint || getInteractivePublisher(value);
    if (provider === 'sciencedirect') {
      return isScienceDirectPdfAssetUrl(value) || /\/pdfft(?:$|[?#])/i.test(url.href);
    }
    if (provider === 'wiley') {
      return host.endsWith('onlinelibrary.wiley.com') &&
        /^\/doi\/(?:pdfdirect|pdf|epdf)\//i.test(path);
    }
    if (provider === 'ieee') {
      return host.includes('ieee.org') &&
        (/\/stamppdf\/getpdf\.jsp/i.test(path) || /\/stamp\/stamp\.jsp/i.test(path));
    }
    if (provider === 'cnki') return isCnkiPdfEndpoint(url);
    return isLikelyPdfEndpoint(value);
  } catch (_) {}
  return false;
}

function canonicalizePublisherPdfUrl(value, providerHint = '', baseUrl = '') {
  try {
    const url = new URL(value, baseUrl || undefined);
    const provider = providerHint || getPublisherProvider(url.href) || getInteractivePublisher(url.href);
    if (provider === 'ieee' && /\/stamp\/stamp\.jsp$/i.test(url.pathname)) {
      url.pathname = url.pathname.replace(/\/stamp\/stamp\.jsp$/i, '/stampPDF/getPDF.jsp');
      if (!url.searchParams.has('tp')) url.searchParams.set('tp', '');
    }
    return url.href;
  } catch (_) {
    return String(value || '');
  }
}

function isContextBoundPublisherPdfUrl(value, providerHint = '') {
  try {
    const provider = providerHint || getPublisherProvider(value) || getInteractivePublisher(value);
    return ['sciencedirect', 'wiley', 'ieee', 'cnki'].includes(provider) &&
      isPublisherPdfEndpoint(value, provider);
  } catch (_) {
    return false;
  }
}

function isSafeStandalonePdfUrl(value, providerHint = '') {
  try {
    const url = new URL(value);
    if (!['http:', 'https:', 'blob:', 'data:'].includes(url.protocol)) return false;
    if (url.protocol === 'blob:' || url.protocol === 'data:') return true;
    if (isContextBoundPublisherPdfUrl(url.href, providerHint)) return false;
    const path = url.pathname.toLowerCase();
    return path.endsWith('.pdf') || /\/pdf\/[^/?#]+$/i.test(path);
  } catch (_) {
    return false;
  }
}

function publisherContextDownloadCandidates(task, viewerUrl = '') {
  const provider = task?.provider || getPublisherProvider(task?.url || viewerUrl || '') || 'generic';
  const baseUrl = task?.lastArticleUrl || task?.url || viewerUrl || '';
  const raw = [task?.preferredPdfUrl, task?.citationPdf];

  if (provider === 'ieee') {
    const sources = [task?.url, task?.lastArticleUrl, task?.lastUrl, viewerUrl].filter(Boolean);
    let arnumber = '';
    for (const source of sources) {
      try {
        const parsed = new URL(source);
        arnumber = parsed.pathname.match(/\/document\/(\d+)/i)?.[1] || parsed.searchParams.get('arnumber') || '';
        if (arnumber) break;
      } catch (_) {}
    }
    if (arnumber) raw.unshift(`https://ieeexplore.ieee.org/stampPDF/getPDF.jsp?tp=&arnumber=${arnumber}`);
  }
  raw.push(viewerUrl);

  const candidates = [];
  for (const value of raw) {
    const normalized = canonicalizePublisherPdfUrl(value || '', provider, baseUrl);
    if (!normalized || !isPublisherPdfEndpoint(normalized, provider) || candidates.includes(normalized)) continue;
    candidates.push(normalized);
  }

  const score = (value) => {
    try {
      const url = new URL(value);
      const path = url.pathname.toLowerCase();
      if (provider === 'sciencedirect') {
        if (/\/pdfft(?:$|\/)/i.test(path)) return 120;
        if (path.includes('/main.pdf') || path.endsWith('.pdf')) return 90;
      }
      if (provider === 'wiley') {
        if (/^\/doi\/pdfdirect\//i.test(path)) return 120;
        if (/^\/doi\/pdf\//i.test(path)) return 110;
        if (/^\/doi\/epdf\//i.test(path)) return 100;
      }
      if (provider === 'ieee') {
        if (/\/stamppdf\/getpdf\.jsp/i.test(path)) return 120;
        if (/\/stamp\/stamp\.jsp/i.test(path)) return 80;
      }
      return 50;
    } catch (_) {
      return 0;
    }
  };
  return candidates.sort((a, b) => score(b) - score(a));
}

function isTrustedPublisherPdfViewerUrl(value, providerHint = '') {
  try {
    const provider = providerHint || getPublisherProvider(value);
    if (!provider) return false;
    return isPublisherPdfEndpoint(value, provider);
  } catch (_) {
    return false;
  }
}

function normalizedLooseMatchText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\.pdf$/i, '')
    .replace(/[\s._()\[\]{}<>《》“”'"‘’—–\-:：,，;；!?！？/\\|]+/g, '');
}

function downloadItemLooksLikePdf(item) {
  const mime = String(item?.mime || '').toLowerCase();
  const values = [item?.filename, item?.url, item?.finalUrl].filter(Boolean);
  return mime.includes('pdf') || values.some((value) => {
    try {
      return /\.pdf(?:$|[?#])/i.test(new URL(value, 'https://freepaper.invalid/').pathname);
    } catch (_) {
      return /\.pdf(?:$|[?#])/i.test(String(value));
    }
  });
}

function downloadItemMatchScore(item, task) {
  if (!item || !task || !MANUAL_DOWNLOAD_OBSERVE_STATUSES.has(task.status)) return -Infinity;
  if (item.byExtensionId && item.byExtensionId === chrome.runtime.id && task?.contextDownloadPending !== true) {
    return -Infinity;
  }

  const enteredAt = Number(task.manualStateStartedAt || task.downloadStartedAt || task.retryRequestedAt || task.updatedAt || task.createdAt || 0);
  const age = enteredAt ? Date.now() - enteredAt : 0;
  if (enteredAt && age > MANUAL_DOWNLOAD_CLAIM_WINDOW_MS) return -Infinity;

  let score = 0;
  if (downloadItemLooksLikePdf(item)) score += 35;
  if (task.status === 'WAITING_BROWSER_DOWNLOAD') score += 25;
  if (age >= 0 && age < 2 * 60 * 1000) score += 10;

  const urls = [item.finalUrl, item.url, item.referrer].filter(Boolean);
  const taskProvider = task.provider || getPublisherProvider(task.url || task.lastUrl || '');
  const providerMatch = urls.some((value) => {
    const provider = getPublisherProvider(value);
    return provider && taskProvider && taskProvider !== 'generic' && provider === taskProvider;
  });
  if (providerMatch) score += 55;

  let taskHost = '';
  try { taskHost = new URL(task.lastUrl || task.url || '').hostname.toLowerCase(); } catch (_) {}
  const sameHostMatch = taskHost && urls.some((value) => {
    try {
      const itemHost = new URL(value).hostname.toLowerCase();
      return itemHost === taskHost || itemHost.endsWith(`.${taskHost}`) || taskHost.endsWith(`.${itemHost}`);
    } catch (_) {
      return false;
    }
  });
  if (sameHostMatch) score += 35;

  const taskCnkiKey = cnkiDocumentKey(task.url || task.lastUrl || '');
  if (taskCnkiKey && urls.some((value) => cnkiDocumentKey(value) === taskCnkiKey)) score += 80;

  const filenameText = normalizedLooseMatchText(item.filename || '');
  const titleText = normalizedLooseMatchText(task.title || task.doi || '');
  if (filenameText && titleText) {
    const probeLength = Math.min(Math.max(8, Math.floor(titleText.length * 0.45)), 24);
    const probe = titleText.slice(0, probeLength);
    if (probe.length >= 6 && filenameText.includes(probe)) score += 55;
    else if (filenameText.length >= 8 && titleText.includes(filenameText.slice(0, Math.min(filenameText.length, 20)))) score += 45;
  }

  if (urls.some((value) => /^(?:blob:|data:)/i.test(value)) && filenameText && titleText &&
      (filenameText.includes(titleText.slice(0, Math.min(titleText.length, 12))) ||
       titleText.includes(filenameText.slice(0, Math.min(filenameText.length, 12))))) {
    score += 45;
  }
  return score;
}

function downloadItemMatchesTask(item, task) {
  const pdfEvidence = downloadItemLooksLikePdf(item) || task?.suggestedManualDownloadId === item?.id;
  return pdfEvidence && downloadItemMatchScore(item, task) >= 70;
}

function inferSdStateFromTab(tab, fallbackUrl = '', providerHint = '') {
  const url = tab?.url || tab?.pendingUrl || fallbackUrl || '';
  if (!url) return null;
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch (_) {}
  const provider = providerHint || getPublisherProvider(url);
  if (isPublisherPdfEndpoint(url, provider)) {
    return {
      type: 'PDF_VIEWER',
      provider,
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

async function inspectSdTab(tabId, providerHint = '') {
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: detectSdPageState,
      args: [providerHint || ''],
    });
    return result?.[0]?.result || null;
  } catch (_) {
    return null;
  }
}

function isSecondSdPhase(task, state, tabId) {
  return task.stage === 'OPENING_PDF' || task.stage === 'PDF' ||
    task.pdfTabId === tabId || isPublisherPdfEndpoint(state.url || '', task.provider || state.provider || '');
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
  task.provider = task.provider || state.provider || getPublisherProvider(task.lastUrl || task.url || '');
  rememberTaskTab(task, tabId);
  forgetPendingTaskTab(task, tabId);
  if (context.documentId) task.activeDocumentId = context.documentId;

  if (state.type === 'DENIED' || state.type === 'ACCOUNT_AUTH_REQUIRED' ||
      state.type === 'INSTITUTION_AUTH_REQUIRED' || state.type === 'PURCHASE') {
    task.status = 'ACCESS_DENIED';
    task.stage = state.type === 'PURCHASE'
      ? 'PURCHASE'
      : state.type === 'INSTITUTION_AUTH_REQUIRED'
        ? 'INSTITUTION_AUTH'
        : state.type === 'ACCOUNT_AUTH_REQUIRED'
          ? 'ACCOUNT_AUTH'
          : 'DENIED';
    task.lastError = state.type === 'PURCHASE'
      ? '当前机构或账号没有该文献的全文访问权限，页面已进入购买入口。'
      : state.type === 'INSTITUTION_AUTH_REQUIRED'
        ? '当前页面需要学校、图书馆或机构账号认证。请完成认证后重新检测。'
      : state.type === 'ACCOUNT_AUTH_REQUIRED'
        ? '当前页面需要登录出版商账号。请完成登录后重新检测。'
        : '出版商返回了访问拒绝页面。';
    await saveSdTask(task);
    return;
  }

  if (state.type === 'CHALLENGE') {
    const round = noteVerificationRound(task, state, context);
    const afterPdfAction = Number(task.pdfActionRound || 0) > 0 || isSecondSdPhase(task, state, tabId);
    task.challengePhase = afterPdfAction || round > 1 ? 2 : 1;
    task.stage = 'VERIFICATION';
    task.guidanceType = 'verification';
    task.returningFromVerification = true;
    if (afterPdfAction) task.pdfTabId = tabId;
    else task.articleTabId = tabId;
    task.status = task.challengePhase === 2 ? 'WAITING_CHALLENGE_2' : 'WAITING_CHALLENGE_1';
    task.lastError = sdStatusMessage(task);
    await saveSdTask(task);
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setBadgeBackgroundColor({ color: '#D97706' });
    return;
  }

  const documentKey = context.documentId || task.activeDocumentId || `${state.type}:${state.url || ''}`;

  if (state.type === 'DOWNLOAD_HANDOFF') {
    task.stage = 'DOWNLOAD';
    task.status = 'WAITING_BROWSER_DOWNLOAD';
    task.guidanceType = 'waiting_download';
    task.manualStateStartedAt = task.manualStateStartedAt || Date.now();
    task.lastError = '验证已完成，正在等待浏览器下载创建或完成。请不要重复点击下载按钮。';
    await saveSdTask(task);
    await reconcileObservedManualDownload(task);
    return;
  }

  if (state.type === 'ARTICLE') {
    if (task.status === 'ACCESS_DENIED' && ['INSTITUTION_AUTH', 'ACCOUNT_AUTH'].includes(task.stage)) {
      task.accessRecoveryRound = Math.max(0, Number(task.accessRecoveryRound || 0)) + 1;
      task.lastAuthRecoveredAt = Date.now();
    }
    if (!context.force && task.lastArticleDocumentKey === documentKey) {
      await pushOverlayState(tabId, false);
      return;
    }
    task.lastArticleDocumentKey = documentKey;
    task.stage = 'ARTICLE';
    task.challengePhase = Number(task.pdfActionRound || 0) > 0 ? 2 : 1;
    task.citationPdf = state.citationPdf || task.citationPdf || '';
    const returnedPdfTabToArticle = task.pdfTabId === tabId &&
      Number.isInteger(task.articleTabId) && task.articleTabId !== tabId;
    if (!returnedPdfTabToArticle) {
      task.articleTabId = tabId;
      task.lastArticleUrl = state.url || task.lastArticleUrl || task.url || '';
    } else {
      // PDF/验证子标签页可能在认证后跳回文章详情页。保留原始文章标签页作为
      // 稳定的已登录下载上下文，避免覆盖后再次创建第三个标签页或恢复刷新循环。
      task.lastPdfReturnArticleUrl = state.url || '';
    }
    task.activeTabId = tabId;
    task.lastError = '';
    rememberTaskTab(task, tabId);

    const settings = await getFreepaperSettings();
    if (settings.autoOpenClearPdfAction !== false) {
      task.status = 'ARTICLE_READY';
      task.guidanceType = 'auto_pdf';
      await saveSdTask(task);
      await autoOpenPdf(task, returnedPdfTabToArticle ? task.articleTabId : tabId);
      return;
    }

    task.status = 'WAITING_MANUAL_PDF';
    task.guidanceType = 'click_pdf';
    task.lastError = sdStatusMessage(task);
    await saveSdTask(task);
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
    task.confirmedPdfViewerUrl = state.url || task.lastUrl || '';
    task.confirmedPdfViewerAt = Date.now();
    task.confirmedPdfViewerFromUrlOnly = state.inferredFromTabUrl === true;
    delete task.allowAutoOpenRetry;
    delete task.returningFromVerification;
    task.guidanceType = 'downloading';
    task.lastError = '';
    delete task.diagnosticCode;
    delete task.autoSaveFailed;
    rememberTaskTab(task, tabId);
    task.downloadAttemptId = `publisher_download_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    task.downloadStartedAt = Date.now();
    await saveSdTask(task);
    await autoVerifyAndDownload(task, tabId, task.downloadAttemptId);
    return;
  }

  await pushOverlayState(tabId, false);
}

async function autoOpenPdf(task, articleTabId) {
  // 这里必须使用稳定的论文标识和“认证恢复轮次”，不能使用 documentId 或
  // pdfActionRound。documentId 会在每次重定向后变化，而自动点击本身又会增加
  // pdfActionRound；旧逻辑因此会在 IEEE 返回详情页后不断生成新 attemptKey 并刷新。
  const attemptKey = autoPdfAttemptKey(task);
  if (task.lastAutoPdfAttemptKey === attemptKey && task.allowAutoOpenRetry !== true) {
    task.stage = 'ARTICLE';
    task.status = 'WAITING_MANUAL_PDF';
    task.guidanceType = 'click_pdf';
    task.lastError = 'Freepaper 已在当前认证阶段自动尝试过一次 PDF 入口，但页面又返回了详情页。为避免循环刷新，程序已停止自动重试。请先确认是否需要登录、机构认证或安全验证，再点击“重新检测”。';
    await saveSdTask(task);
    return;
  }

  task.lastAutoPdfAttemptKey = attemptKey;
  task.lastAutoPdfArticleKey = stableTaskArticleKey(task);
  task.stage = 'OPENING_PDF';
  task.status = 'OPENING_PDF';
  task.activeTabId = articleTabId;
  task.guidanceType = 'auto_pdf';
  rememberTaskTab(task, articleTabId);
  delete task.allowAutoOpenRetry;
  await saveSdTask(task);

  let result;
  try {
    [result] = await chrome.scripting.executeScript({
      target: { tabId: articleTabId, frameIds: [0] },
      func: (provider, preferredPdfUrl, citationPdfUrl) => {
        const resolve = (raw) => {
          try { return raw ? new URL(raw, location.href).href : ''; } catch (_) { return ''; }
        };
        const visible = (el) => {
          const rect = el?.getBoundingClientRect?.();
          const style = el ? getComputedStyle(el) : null;
          return Boolean(rect && rect.width > 2 && rect.height > 2 && style?.visibility !== 'hidden' && style?.display !== 'none');
        };
        const hasBlockedStaticExtension = (value) => {
          try {
            const path = new URL(value, location.href).pathname.toLowerCase();
            return /\.(?:css|js|mjs|woff2?|ttf|eot|svg|png|jpe?g|gif|ico|webp|avif|bmp|map|json|xml)$/i.test(path);
          } catch (_) { return true; }
        };
        const isConcretePdfRoute = (value) => {
          const resolved = resolve(value);
          if (!resolved || hasBlockedStaticExtension(resolved)) return false;
          try {
            const url = new URL(resolved);
            const host = url.hostname.toLowerCase();
            const path = url.pathname.toLowerCase();
            if (/purchase|subscribe|pricing|getaccess/i.test(`${path}${url.search}`)) return false;
            if (provider === 'sciencedirect') {
              return ((host === 'pdf.sciencedirectassets.com' || host.endsWith('.pdf.sciencedirectassets.com')) &&
                  (path.endsWith('.pdf') || path.includes('/main.pdf') || /\/pdfft(?:$|[?#])/i.test(resolved))) ||
                (host.endsWith('sciencedirect.com') && /\/pdfft(?:$|[?#])/i.test(resolved));
            }
            if (provider === 'wiley') return host.endsWith('onlinelibrary.wiley.com') && /^\/doi\/(?:pdfdirect|pdf|epdf)\//i.test(path);
            if (provider === 'ieee') return host.includes('ieee.org') && (/\/stamppdf\/getpdf\.jsp/i.test(path) || /\/stamp\/stamp\.jsp/i.test(path));
            if (provider === 'cnki') return /\.pdf$/i.test(path) || /download\.aspx|kbdownload\.aspx/i.test(path) || /(?:^|[?&])dflag=pdfdown(?:&|$)/i.test(url.search);
            return /\.pdf$/i.test(path) || /\/(?:pdf|pdfdirect|epdf|pdfft)(?:\/|$)/i.test(path) || /stamppdf\/getpdf\.jsp|stamp\/stamp\.jsp/i.test(path) || /(?:^|[?&])(?:download|type|format|dflag)=(?:pdf|pdfdown)(?:&|$)/i.test(url.search);
          } catch (_) { return false; }
        };

        const candidates = [];
        const push = (value) => {
          const resolved = resolve(value);
          if (resolved && isConcretePdfRoute(resolved) && !candidates.includes(resolved)) candidates.push(resolved);
        };
        push(preferredPdfUrl);
        push(citationPdfUrl);
        push(document.querySelector('meta[name="citation_pdf_url"]')?.content || '');
        document.querySelectorAll('a[href],link[href]').forEach((el) => push(el.getAttribute('href') || ''));
        if (candidates[0]) return { ok: true, target: candidates[0], method: 'navigate' };

        const actionPattern = /^(?:view|open|download)?\s*(?:full\s*text\s*)?(?:pdf)(?:\s*(?:download|全文|下载))?$|^(?:pdf下载|下载pdf|查看pdf|全文下载|下载全文)$/i;
        const negativePattern = /purchase|subscribe|pricing|citation|bibtex|ris|supplement|supporting|image|figure|icon|logo/i;
        const actions = [];
        document.querySelectorAll('a,button,[role="button"],[data-url],[data-href]').forEach((el, order) => {
          if (!visible(el) || el.closest('#freepaper-overlay-host')) return;
          const text = String(el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
          const rawHref = el.getAttribute('href') || el.getAttribute('data-url') || el.getAttribute('data-href') || '';
          const href = resolve(rawHref);
          const haystack = `${text} ${href}`;
          if (!actionPattern.test(text) && !/(?:view|download|open)[\s_-]*pdf|pdf[\s_-]*download|pdf下载|下载pdf|全文下载/i.test(haystack)) return;
          if (negativePattern.test(haystack) || /purchase|subscribe|pricing|getaccess/i.test(href)) return;
          let score = actionPattern.test(text) ? 100 : 50;
          if (isConcretePdfRoute(href)) score += 80;
          if (el.tagName === 'A' && href) score += 15;
          if (/primary|pdf/i.test(String(el.className || ''))) score += 8;
          actions.push({ el, text, href, score, order });
        });
        actions.sort((a,b)=>b.score-a.score||a.order-b.order);
        const chosen = actions[0];
        if (!chosen) return { ok: false, reason: 'no_clear_pdf_action' };
        const fingerprint = `${location.href}|${chosen.text}|${chosen.href}`;
        if (chosen.el.getAttribute('data-freepaper-auto-pdf-clicked') === fingerprint) {
          return { ok: false, reason: 'already_auto_clicked', fingerprint };
        }
        chosen.el.setAttribute('data-freepaper-auto-pdf-clicked', fingerprint);
        chosen.el.click();
        return { ok: true, method: 'click', autoClicked: true, fingerprint, text: chosen.text, href: chosen.href };
      },
      args: [task.provider || 'generic', task.preferredPdfUrl || '', task.citationPdf || ''],
    });
  } catch (error) {
    result = { result: { ok: false, reason: error.message } };
  }

  const outcome = result?.result || {};
  task = await getSdTask() || task;
  if (!task || SD_TERMINAL_STATUSES.has(task.status)) return;

  if (outcome.ok && outcome.target) {
    const target = canonicalizePublisherPdfUrl(
      outcome.target,
      task.provider || '',
      task.lastArticleUrl || task.url || '',
    );
    task.lastAutoOpenTarget = target;
    task.lastAutoOpenAt = Date.now();
    task.activeTabId = articleTabId;
    task.pdfActionRound = Math.max(0, Number(task.pdfActionRound || 0)) + 1;
    await saveSdTask(task);

    // 先在论文详情页的真实登录/机构认证上下文中获取并触发 Blob 下载。
    // 这样不会由 downloads API 对 stamp.jsp/main.pdf 再发一次脱离上下文的请求，
    // 也就不会先产生 stamp.htm/init.htm。
    const contextDownload = await tryStartPageContextPdfDownload(task, articleTabId, target);
    if (contextDownload?.ok) return;

    task = await getSdTask() || task;
    if (!task || SD_TERMINAL_STATUSES.has(task.status)) return;
    task.stage = 'OPENING_PDF';
    task.status = 'OPENING_PDF';
    task.guidanceType = 'waiting_navigation';
    task.lastError = '正在打开 PDF 或验证页面；若出现机构登录或安全验证，请完成后等待 Freepaper 自动继续。';

    try {
      let pdfTab = null;
      if (Number.isInteger(task.pdfTabId) && task.pdfTabId !== articleTabId) {
        pdfTab = await chrome.tabs.get(task.pdfTabId).catch(() => null);
      }
      if (pdfTab) {
        pdfTab = await chrome.tabs.update(pdfTab.id, { url: target, active: true });
      } else {
        try {
          pdfTab = await chrome.tabs.create({ url: target, active: true, openerTabId: articleTabId });
        } catch (_) {
          pdfTab = await chrome.tabs.create({ url: target, active: true });
        }
      }
      task.pdfTabId = pdfTab.id;
      task.activeTabId = pdfTab.id;
      rememberTaskTab(task, pdfTab.id);
      await saveSdTask(task);
      scheduleSdInspection(pdfTab.id, { reason: 'publisher_pdf_tab_opened', fast: true, force: true });
    } catch (error) {
      task.stage = 'ARTICLE';
      task.status = 'WAITING_MANUAL_PDF';
      task.guidanceType = 'click_pdf';
      task.lastError = `无法打开明确的 PDF 地址：${error.message}`;
      await saveSdTask(task);
    }
    return;
  }

  if (outcome.ok && outcome.autoClicked) {
    task.lastAutoActionFingerprint = outcome.fingerprint || '';
    task.lastAutoActionAt = Date.now();
    task.pdfActionRound = Math.max(0, Number(task.pdfActionRound || 0)) + 1;
    task.stage = 'OPENING_PDF';
    task.status = 'OPENING_PDF';
    task.lastError = '已自动打开明确的 PDF 入口一次，正在等待验证、PDF 页面或浏览器下载。';
    await saveSdTask(task);
    scheduleSdInspection(articleTabId, { reason: 'auto_pdf_action', fast: true, force: true });
    return;
  }

  task.stage = 'ARTICLE';
  task.status = 'WAITING_MANUAL_PDF';
  task.guidanceType = 'click_pdf';
  task.lastError = outcome.reason === 'already_auto_clicked'
    ? '当前页面的 PDF 入口已经自动尝试过一次。为避免重复刷新，请手动点击，或等待页面稳定后重新检测。'
    : '未在详情页找到足够明确的 PDF 地址或按钮。请手动点击 View PDF / Download PDF；下载开始后 Freepaper 会自动识别。';
  await saveSdTask(task);
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
      if ([401, 403, 407].includes(response.status)) return { ok: false, reason: 'AUTH_REQUIRED', httpStatus: response.status };
      if (response.status === 429) return { ok: false, reason: 'ROBOT_CHALLENGE', httpStatus: response.status };
      return { ok: false, reason: `HTTP_${response.status}`, httpStatus: response.status };
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
        preview.includes('press and hold') || preview.includes('安全验证') ||
        preview.includes('请输入验证码') || preview.includes('访问过于频繁') ||
        preview.includes('操作过于频繁')) {
      return { ok: false, reason: 'ROBOT_CHALLENGE' };
    }
    if (preview.includes('institutional sign in') || preview.includes('institutional access') ||
        preview.includes('access through your institution') || preview.includes('shibboleth') ||
        preview.includes('openathens') || preview.includes('saml') ||
        preview.includes('机构登录') || preview.includes('机构认证') ||
        preview.includes('学校认证') || preview.includes('统一身份认证')) {
      return { ok: false, reason: 'INSTITUTION_AUTH_REQUIRED' };
    }
    if (preview.includes('sign in') || preview.includes('login') ||
        preview.includes('authentication') ||
        preview.includes('access denied') || preview.includes('用户登录') ||
        preview.includes('账号登录') ||
        preview.includes('无权访问') || preview.includes('没有权限')) {
      return { ok: false, reason: 'ACCOUNT_AUTH_REQUIRED' };
    }
    return { ok: false, reason: 'NOT_PDF' };
  } catch (error) {
    return { ok: false, reason: 'WORKER_FETCH_FAILED', error: error.message };
  }
}

async function tryStartPageContextPdfDownload(task, articleTabId, candidateUrl) {
  if (!task || !Number.isInteger(articleTabId) || !candidateUrl) {
    return { ok: false, reason: 'INVALID_CONTEXT_DOWNLOAD_REQUEST' };
  }
  const provider = task.provider || getPublisherProvider(candidateUrl) || 'generic';
  const normalizedUrl = canonicalizePublisherPdfUrl(
    candidateUrl,
    provider,
    task.lastArticleUrl || task.url || '',
  );
  if (!normalizedUrl || !isPublisherPdfEndpoint(normalizedUrl, provider)) {
    return { ok: false, reason: 'NOT_PUBLISHER_PDF_ENDPOINT' };
  }

  let articleTab;
  try {
    articleTab = await chrome.tabs.get(articleTabId);
  } catch (_) {
    return { ok: false, reason: 'ARTICLE_TAB_MISSING' };
  }
  const articleUrl = articleTab?.url || articleTab?.pendingUrl || '';
  if (!articleUrl || isPublisherPdfEndpoint(articleUrl, provider)) {
    return { ok: false, reason: 'ARTICLE_CONTEXT_UNAVAILABLE' };
  }

  let current = await getSdTask();
  if (!current || current.id !== task.id || SD_TERMINAL_STATUSES.has(current.status)) {
    return { ok: false, reason: 'TASK_NOT_ACTIVE' };
  }
  const previous = {
    status: current.status,
    stage: current.stage,
    guidanceType: current.guidanceType,
    lastError: current.lastError,
  };
  current.status = 'WAITING_BROWSER_DOWNLOAD';
  current.stage = 'PDF';
  current.guidanceType = 'waiting_download';
  current.manualStateStartedAt = Date.now();
  current.contextDownloadPending = true;
  current.contextDownloadCandidate = normalizedUrl;
  current.contextDownloadStartedAt = Date.now();
  current.lastError = '正在论文页面的已登录上下文中验证 PDF，并准备保存到 Freepaper 文件夹。';
  await saveSdTask(current);

  let outcome;
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: articleTabId, frameIds: [0] },
      world: 'MAIN',
      func: async (url, filename) => {
        const classifyHtml = (text) => {
          const preview = String(text || '').toLowerCase();
          if (/captcha|verify you are human|security check|performing security verification|press and hold|安全验证|请输入验证码|访问过于频繁|操作过于频繁/.test(preview)) return 'ROBOT_CHALLENGE';
          if (/institutional sign in|institutional access|access through your institution|shibboleth|openathens|saml|机构登录|机构认证|学校认证|统一身份认证/.test(preview)) return 'INSTITUTION_AUTH_REQUIRED';
          if (/sign in|log in|login|authentication|access denied|用户登录|账号登录|无权访问|没有权限/.test(preview)) return 'ACCOUNT_AUTH_REQUIRED';
          if (/purchase|subscribe|buy this article|购买|订阅/.test(preview)) return 'PURCHASE_REQUIRED';
          return 'HTML_CONTENT_TYPE';
        };
        try {
          const response = await fetch(url, {
            method: 'GET',
            credentials: 'include',
            redirect: 'follow',
            cache: 'no-store',
            headers: { Accept: 'application/pdf,*/*;q=0.8' },
          });
          if (!response.ok) {
            if ([401, 403, 407].includes(response.status)) return { ok: false, reason: 'AUTH_REQUIRED', httpStatus: response.status };
            if (response.status === 429) return { ok: false, reason: 'ROBOT_CHALLENGE', httpStatus: response.status };
            return { ok: false, reason: `HTTP_${response.status}`, httpStatus: response.status };
          }
          const contentType = String(response.headers.get('content-type') || '').toLowerCase();
          const blob = await response.blob();
          const signature = new Uint8Array(await blob.slice(0, 5).arrayBuffer());
          const isPdf = signature.length >= 5 && signature[0] === 0x25 && signature[1] === 0x50 &&
            signature[2] === 0x44 && signature[3] === 0x46 && signature[4] === 0x2D;
          if (!isPdf) {
            if (contentType.includes('html') || contentType.startsWith('text/')) {
              return { ok: false, reason: classifyHtml((await blob.slice(0, 16000).text())) };
            }
            return { ok: false, reason: 'NOT_PDF', contentType };
          }

          // 必须在创建 Blob URL 的同一网页上下文内触发下载。把 Blob URL
          // 传回扩展 Service Worker 再下载，可能因存储分区/来源不同而失效。
          const blobUrl = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }));
          const anchor = document.createElement('a');
          anchor.href = blobUrl;
          anchor.download = filename || 'paper.pdf';
          anchor.style.display = 'none';
          anchor.rel = 'noopener';
          (document.body || document.documentElement).appendChild(anchor);
          anchor.click();
          anchor.remove();
          setTimeout(() => URL.revokeObjectURL(blobUrl), 120000);
          return {
            ok: true,
            started: true,
            fileSize: blob.size,
            finalUrl: response.url,
            contentType,
          };
        } catch (error) {
          return { ok: false, reason: 'PAGE_CONTEXT_FETCH_FAILED', error: error.message };
        }
      },
      args: [normalizedUrl, `${sanitizeFilename(task.title || task.doi || 'paper')}.pdf`],
    });
    outcome = result?.result || { ok: false, reason: 'NO_CONTEXT_RESULT' };
  } catch (error) {
    outcome = { ok: false, reason: 'CONTEXT_INJECTION_FAILED', error: error.message };
  }

  current = await getSdTask();
  if (!current || current.id !== task.id || SD_TERMINAL_STATUSES.has(current.status)) return outcome;
  if (outcome.ok) {
    current.contextDownloadPending = true;
    current.contextDownloadCandidate = normalizedUrl;
    current.contextDownloadStartedAt = current.contextDownloadStartedAt || Date.now();
    current.lastError = 'PDF 已在论文页面上下文中验证，正在等待浏览器完成保存。';
    await saveSdTask(current);
    return outcome;
  }

  delete current.contextDownloadPending;
  delete current.contextDownloadCandidate;
  delete current.contextDownloadStartedAt;
  current.status = previous.status || 'OPENING_PDF';
  current.stage = previous.stage || 'OPENING_PDF';
  current.guidanceType = previous.guidanceType || 'auto_pdf';
  current.lastError = previous.lastError || '';
  current.lastContextDownloadFailure = outcome.reason || outcome.error || 'CONTEXT_DOWNLOAD_FAILED';
  await saveSdTask(current);
  return outcome;
}

async function downloadPdfThroughDownloadsApi(task, pdfUrl, options = {}) {
  if (isContextBoundPublisherPdfUrl(pdfUrl, task?.provider || '')) {
    return { ok: false, reason: 'CONTEXT_BOUND_PDF_URL' };
  }
  const verified = await verifyRemotePdfHeader(pdfUrl);
  if (verified.ok) {
    return downloadVerifiedResource({
      url: verified.finalUrl || pdfUrl,
      folder: task.folder || 'freepaper',
      filename: `${sanitizeFilename(task.title || task.doi || 'paper')}.pdf`,
    });
  }

  // 浏览器内置 PDF 查看器已经成功呈现页面时，页面脚本和 Service Worker 的 fetch
  // 仍可能因 CORS、临时令牌或网络栈差异失败。只有在“DOM 无法注入 + 严格 PDF
  // 路由”这一强证据成立时，才允许直接交给 downloads API。验证码/登录响应永不兜底。
  const confirmedViewer = options.confirmedViewer === true ||
    (task.confirmedPdfViewerUrl === pdfUrl &&
      Number.isFinite(task.confirmedPdfViewerAt) && Date.now() - task.confirmedPdfViewerAt < 120000);
  const authFailureReasons = new Set([
    'ROBOT_CHALLENGE', 'AUTH_REQUIRED', 'ACCOUNT_AUTH_REQUIRED', 'INSTITUTION_AUTH_REQUIRED',
  ]);
  const canUseConfirmedViewerFallback = confirmedViewer &&
    isTrustedPublisherPdfViewerUrl(pdfUrl, task.provider || '') &&
    !authFailureReasons.has(verified.reason);
  const canUseScienceAssetFallback = isScienceDirectPdfAssetUrl(pdfUrl) &&
    !authFailureReasons.has(verified.reason) && verified.reason !== 'NOT_PDF';
  const canUseTrustedAssetFallback = canUseConfirmedViewerFallback || canUseScienceAssetFallback;
  if (canUseTrustedAssetFallback) {
    const direct = await downloadVerifiedResource({
      url: pdfUrl,
      folder: task.folder || 'freepaper',
      filename: `${sanitizeFilename(task.title || task.doi || 'paper')}.pdf`,
    });
    if (direct.ok) return {
      ...direct,
      trustedAssetFallback: true,
      confirmedViewerFallback: canUseConfirmedViewerFallback,
    };
  }
  return verified;
}

async function extractPdfUrlFromViewerTab(tabId, fallbackUrl = '') {
  const isUsableWebUrl = (value) => {
    try {
      const url = new URL(value);
      return (url.protocol === 'http:' || url.protocol === 'https:') &&
        !/^(?:chrome|edge|extension|chrome-extension|moz-extension):/i.test(url.protocol);
    } catch (_) {
      return false;
    }
  };
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: () => {
        const resolve = (raw) => { try { return raw ? new URL(raw, location.href).href : ''; } catch (_) { return ''; } };
        const embed = document.querySelector('embed[type="application/pdf"]');
        const object = document.querySelector('object[type="application/pdf"]');
        const meta = document.querySelector('meta[name="citation_pdf_url"]');
        return resolve(embed?.src || object?.data || meta?.content || location.href);
      },
    });
    const extracted = result?.result || '';
    // Edge/Chrome 的内置 PDF 查看器可能允许脚本在查看器外壳执行，并返回
    // edge-extension:// 或 chrome-extension:// 地址。该地址不是论文资源，旧版
    // 会拿它做 fetch，最终暴露 WORKER_FETCH_FAILED。此时必须优先使用标签页中
    // 原始的 https PDF URL。
    if (isUsableWebUrl(extracted)) return extracted;
    return isUsableWebUrl(fallbackUrl) ? fallbackUrl : '';
  } catch (_) {
    return isUsableWebUrl(fallbackUrl) ? fallbackUrl : '';
  }
}

async function autoVerifyAndDownload(task, pdfTabId, attemptId = '') {
  let tabUrl = task.lastUrl || '';
  try {
    const tab = await chrome.tabs.get(pdfTabId);
    tabUrl = tab.url || tab.pendingUrl || tabUrl;
  } catch (_) {}

  const extractedUrl = await extractPdfUrlFromViewerTab(pdfTabId, tabUrl);
  const candidates = publisherContextDownloadCandidates(task, extractedUrl || tabUrl);

  // PDF 查看器已经打开时，优先回到仍保留的论文详情页上下文，使用当前会话
  // 获取 PDF 字节并在该页面内触发 Blob 下载。它复用真实 Cookie、Referrer 和
  // 机构认证状态，不会再下载 stamp.htm/init.htm。
  if (Number.isInteger(task.articleTabId) && task.articleTabId !== pdfTabId) {
    for (const candidate of candidates) {
      const contextResult = await tryStartPageContextPdfDownload(task, task.articleTabId, candidate);
      if (contextResult?.ok) return;
    }
  }

  // 只有不依赖页面上下文的普通、稳定 PDF 直链，才允许直接交给 downloads API。
  // 四个交互型数据库的动态端点绝不在这里二次请求。
  let download = null;
  const safeCandidates = [...new Set([extractedUrl, tabUrl].filter((value) =>
    isSafeStandalonePdfUrl(value, task.provider || '')
  ))];
  for (const candidate of safeCandidates) {
    download = await downloadPdfThroughDownloadsApi(task, candidate, { confirmedViewer: true });
    if (download?.ok) break;
  }

  let currentTask = await getSdTask();
  if (!currentTask || currentTask.id !== task.id || SD_TERMINAL_STATUSES.has(currentTask.status)) return;
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
    delete task.extensionDownloadId;
    delete task.contextDownloadPending;
    await saveSdTask(task);
    await chrome.action.setBadgeText({ text: '' });
    return;
  }

  // 已经进入真实 PDF 查看器，但动态地址无法在页面上下文中自动保存时，
  // 只等待查看器自己的下载事件；绝不再把动态 URL 交给 downloads API。
  task.stage = 'PDF';
  task.status = 'WAITING_BROWSER_DOWNLOAD';
  task.guidanceType = 'waiting_download';
  task.autoSaveFailed = true;
  task.manualStateStartedAt = Date.now();
  task.diagnosticCode = download?.reason || task.lastContextDownloadFailure || 'VIEWER_DOWNLOAD_HANDOFF';
  task.lastError = 'PDF 已打开。Freepaper 已停止对动态地址进行二次下载，以免生成 HTM 文件。程序会继续尝试从论文页面上下文保存；若网站阻止自动保存，请使用 PDF 查看器的下载按钮，Freepaper 会关联文件、移动到设置的子文件夹并记录完成。';
  task.pdfTabId = pdfTabId;
  task.activeTabId = pdfTabId;
  delete task.downloadStartedAt;
  delete task.extensionDownloadId;
  await saveSdTask(task);
  await reconcileObservedManualDownload(task);
}

async function startSdTask(paper, folder, batchJobId = null, batchIndex = null, existingTabId = null) {
  const existing = await getSdTask();
  if (existing && !SD_TERMINAL_STATUSES.has(existing.status)) {
    const sameBatchPaper = existing.batchJobId === batchJobId && existing.batchIndex === batchIndex;
    if (sameBatchPaper) return true;
    return false;
  }

  const task = {
    id: `publisher_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    doi: paper.doi || '',
    title: normalizeDetectedPaperTitle(paper.title),
    url: paper.url || `https://doi.org/${paper.doi}`,
    provider: paper.provider || getPublisherProvider(paper.url || '') || 'generic',
    preferredPdfUrl: paper.preferredPdfUrl || '',
    status: 'OPENING',
    stage: 'ARTICLE',
    folder: folder || 'freepaper',
    batchJobId,
    batchIndex,
    createdAt: Date.now(),
    managedTabIds: [],
    pendingChildTabIds: [],
    ignoredTabIds: [],
    verificationRound: 0,
    pdfActionRound: 0,
    guidanceType: 'opening',
  };

  let tab;
  if (Number.isInteger(existingTabId)) {
    tab = await chrome.tabs.get(existingTabId).catch(() => null);
    if (tab) await chrome.tabs.update(existingTabId, { active: true }).catch(() => null);
  }
  if (!tab) tab = await chrome.tabs.create({ url: task.url, active: true });

  task.activeTabId = tab.id;
  task.articleTabId = tab.id;
  task.lastUrl = tab.url || tab.pendingUrl || task.url;
  rememberTaskTab(task, tab.id);
  await saveSdTask(task);
  scheduleSdInspection(tab.id, { reason: 'sd_task_started', fast: true, force: true });
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
  task.returningFromVerification = previousStatus === 'WAITING_CHALLENGE_1' || previousStatus === 'WAITING_CHALLENGE_2' || previousStatus === 'ACCESS_DENIED';
  if (previousStatus === 'ACCESS_DENIED') {
    task.accessRecoveryRound = Math.max(0, Number(task.accessRecoveryRound || 0)) + 1;
  } else if (previousStatus === 'WAITING_MANUAL_PDF') {
    task.manualRetryRound = Math.max(0, Number(task.manualRetryRound || 0)) + 1;
  }
  task.status = 'CHECKING_AFTER_CHALLENGE';
  task.guidanceType = 'checking';
  task.retryRequestedAt = Date.now();
  await saveSdTask(task);

  const delays = [120, 450, 1000, 2000, 3400];
  let lastChallenge = null;
  let lastAccessState = null;
  let sawUnstablePage = false;

  for (const delay of delays) {
    await sleep(delay);
    task = await getSdTask();
    if (!task || SD_TERMINAL_STATUSES.has(task.status)) return { ok: true };

    const tabs = [];
    const candidates = taskTabIds(task);
    for (const tabId of candidates) {
      try {
        const tab = await chrome.tabs.get(tabId);
        tabs.push({ tabId, tab });
      } catch (_) {}
    }

    const inspectedTabs = [];
    for (const { tabId, tab } of tabs) {
      const state = await inspectSdTab(tabId, task.provider || '');
      inspectedTabs.push({ tabId, tab, state });

      // 先相信可注入页面的真实 DOM。这样同一 PDF 路由上返回的验证码/登录 HTML
      // 不会仅因 URL 像 PDF 就被误判为浏览器 PDF 查看器。
      if (state && state.type !== 'UNKNOWN') {
        if (state.type === 'PDF_VIEWER') {
          await handleSdState(task, state, tabId, { force: true, reason: 'user_continue_pdf_viewer' });
          return { ok: true };
        }
        if (state.type === 'CHALLENGE') {
          lastChallenge = { state, tabId };
          continue;
        }
        if (state.type === 'DENIED' || state.type === 'ACCOUNT_AUTH_REQUIRED' ||
            state.type === 'INSTITUTION_AUTH_REQUIRED' || state.type === 'PURCHASE') {
          lastAccessState = { state, tabId };
          continue;
        }
        await handleSdState(task, state, tabId, { force: true, reason: 'user_continue' });
        return { ok: true };
      }

      if (!state && tab.status !== 'complete') sawUnstablePage = true;
      if (state?.type === 'UNKNOWN' && state.readyState !== 'complete') sawUnstablePage = true;
    }

    // 只有脚本无法注入（典型是 Chrome/Edge 内置 PDF 查看器）或页面状态未知时，
    // 才使用严格 PDF 路由进行 URL 级兜底。
    for (const { tabId, tab, state } of inspectedTabs) {
      if (state && state.type !== 'UNKNOWN') continue;
      const inferred = inferSdStateFromTab(tab, '', task.provider || '');
      if (inferred?.type === 'PDF_VIEWER') {
        await handleSdState(task, inferred, tabId, {
          force: true,
          reason: 'user_continue_pdf_url_fallback',
        });
        return { ok: true, recoveredFromPdfUrl: true };
      }
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
  if (lastAccessState) {
    await handleSdState(task, lastAccessState.state, lastAccessState.tabId, {
      force: true,
      reason: 'access_page_still_present',
    });
    return { ok: false, reason: 'access_page_still_present' };
  }

  task.status = 'WAITING_MANUAL_PDF';
  task.stage = 'ARTICLE';
  task.guidanceType = 'click_pdf';
  task.lastError = sawUnstablePage
    ? '页面仍在跳转。请等待页面稳定；若返回详情页，请再次手动点击 View PDF / Download PDF。'
    : sdStatusMessage(task);
  await saveSdTask(task);
  return { ok: false, reason: sawUnstablePage ? 'page_not_stable' : 'pdf_tab_missing' };
}

async function handleUserPdfAction(tabId, payload = {}) {
  const task = await getSdTask();
  if (!task || SD_TERMINAL_STATUSES.has(task.status) || !Number.isInteger(tabId) || !isTaskTab(task, tabId)) {
    return { ok: false, reason: 'no_matching_task' };
  }
  if (payload.trusted === false) return { ok: true, synthetic: true };
  const now = Date.now();
  const fingerprint = `${tabId}:${payload.href || ''}:${payload.text || ''}`;
  if (task.lastPdfActionFingerprint === fingerprint && now - Number(task.lastUserPdfActionAt || 0) < 1200) {
    return { ok: true, duplicate: true };
  }
  task.lastPdfActionFingerprint = fingerprint;
  task.lastUserPdfActionAt = now;
  task.pdfActionRound = Math.max(0, Number(task.pdfActionRound || 0)) + 1;
  task.stage = 'OPENING_PDF';
  task.status = 'CHECKING_AFTER_CHALLENGE';
  task.challengePhase = 2;
  task.guidanceType = 'waiting_navigation';
  task.activeTabId = tabId;
  task.lastError = '已检测到你点击 PDF 按钮，正在等待页面跳转、二次验证或浏览器下载。';
  rememberTaskTab(task, tabId);
  await saveSdTask(task);
  scheduleSdInspection(tabId, { reason: 'user_pdf_action', fast: true, force: true });
  return { ok: true, pdfActionRound: task.pdfActionRound };
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
  const tabIds = taskTabIds(task);
  await chrome.storage.local.remove([SD_STORAGE_KEY, 'sd_notification']);
  await Promise.allSettled(tabIds.map((tabId) => chrome.tabs.sendMessage(tabId, { type: 'HIDE_OVERLAY' })));
  // 仅关闭批量任务由 Freepaper 创建/接管的出版商标签页，不关闭用户手动启动的独立任务页。
  if (task.batchJobId) {
    await Promise.allSettled(tabIds.map((tabId) => chrome.tabs.remove(tabId)));
  }
}


// =========================================================================
// 下载跟踪
// =========================================================================

const DOWNLOAD_WAIT_TIMEOUT_MS = 60000;
const pendingDownloads = {};

async function reconcileObservedManualDownload(task = null) {
  task = task || await getSdTask();
  if (!task || SD_TERMINAL_STATUSES.has(task.status) || !MANUAL_DOWNLOAD_OBSERVE_STATUSES.has(task.status)) return false;
  const since = Number(task.manualStateStartedAt || task.downloadStartedAt || task.retryRequestedAt || task.updatedAt || task.createdAt || Date.now()) - 5000;
  let items = [];
  try {
    items = await chrome.downloads.search({ orderBy: ['-startTime'], limit: 30 });
  } catch (_) { return false; }
  for (const item of items) {
    const started = item.startTime ? new Date(item.startTime).getTime() : 0;
    if (started && started < since) continue;
    if (!downloadItemMatchesTask(item, task)) continue;
    if (await claimObservedManualDownload(item)) return true;
  }
  return false;
}

async function claimObservedManualDownload(item) {
  if (!item || !Number.isInteger(item.id)) return false;
  const task = await getSdTask();
  if (!task || SD_TERMINAL_STATUSES.has(task.status) || !downloadItemMatchesTask(item, task)) return false;
  if (Number.isInteger(task.observedManualDownloadId) && task.observedManualDownloadId !== item.id) return false;

  if (Number.isInteger(task.extensionDownloadId) && task.extensionDownloadId !== item.id) {
    try { await chrome.downloads.cancel(task.extensionDownloadId); } catch (_) {}
    await unregisterFreepaperDownload(task.extensionDownloadId);
  }
  task.downloadAttemptId = `observed_${item.id}_${Date.now()}`;
  delete task.extensionDownloadId;
  task.observedManualDownloadId = item.id;
  task.observedManualDownloadStartedAt = Date.now();
  task.stage = 'PDF';
  task.status = 'DOWNLOADING_PDF';
  task.lastError = '';
  await registerFreepaperDownload(item.id, {
    relativePath: task.suggestedManualRelativePath || item.filename || `${sanitizeFilename(task.title || task.doi || 'paper')}.pdf`,
    sourceUrl: item.finalUrl || item.url || task.lastUrl || task.url || '',
    startedAt: Date.now(),
  });
  await saveSdTask(task);

  if (item.state === 'complete') {
    await completeObservedManualDownload(item.id, item);
  }
  return true;
}

async function completeObservedManualDownload(downloadId, suppliedItem = null) {
  const task = await getSdTask();
  if (!task || task.observedManualDownloadId !== downloadId || SD_TERMINAL_STATUSES.has(task.status)) return false;

  let item = suppliedItem;
  if (!item) {
    try {
      const items = await chrome.downloads.search({ id: downloadId });
      item = items?.[0] || null;
    } catch (_) {
      item = null;
    }
  }
  if (!item || item.state !== 'complete') return false;

  task.status = 'DONE';
  task.stage = 'DONE';
  task.challengePhase = 0;
  task.filename = item.filename || `${sanitizeFilename(task.title || task.doi || 'paper')}.pdf`;
  task.fileSize = item.fileSize || 0;
  task.completedAt = Date.now();
  task.downloadFinishedAt = Date.now();
  task.manualDownloadObserved = true;
  delete task.downloadStartedAt;
  delete task.contextDownloadPending;
  delete task.contextDownloadCandidate;
  delete task.contextDownloadStartedAt;
  await saveSdTask(task);
  await finalizeRegisteredFreepaperDownload(downloadId, item);
  await chrome.action.setBadgeText({ text: '' });
  return true;
}

async function interruptObservedManualDownload(downloadId) {
  const task = await getSdTask();
  if (!task || task.observedManualDownloadId !== downloadId || SD_TERMINAL_STATUSES.has(task.status)) return;
  delete task.observedManualDownloadId;
  delete task.observedManualDownloadStartedAt;
  delete task.contextDownloadPending;
  delete task.contextDownloadCandidate;
  task.status = 'WAITING_MANUAL_PDF';
  task.stage = 'PDF';
  task.lastError = '检测到的浏览器下载已中断。请重新下载，或跳过当前论文。';
  await saveSdTask(task);
}

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  let replied = false;
  const reply = (value) => {
    if (replied) return;
    replied = true;
    try { suggest(value); } catch (_) {}
  };

  void (async () => {
    const task = await getSdTask();
    // 只在当前论文已经明确等待浏览器/PDF 查看器下载时接管文件名。
    // 这样不会把用户同时进行的普通 PDF 下载误移入 Freepaper 文件夹。
    if (!task || !['WAITING_BROWSER_DOWNLOAD', 'WAITING_MANUAL_PDF'].includes(task.status)) {
      reply();
      return;
    }
    const score = downloadItemMatchScore(item, task);
    if (score < 70 || !downloadItemLooksLikePdf(item)) {
      reply();
      return;
    }

    const relativePath = buildDownloadRelativePath(
      task.folder || 'freepaper',
      `${sanitizeFilename(task.title || task.doi || 'paper')}.pdf`,
    );
    task.suggestedManualDownloadId = item.id;
    task.suggestedManualRelativePath = relativePath;
    task.suggestedManualDownloadAt = Date.now();
    await saveSdTask(task);
    reply({ filename: relativePath, conflictAction: 'uniquify' });

    // filename 决定阶段的 DownloadItem 通常已经包含最完整的来源信息，立即尝试
    // 认领；若字段稍后才补齐，onCreated/onChanged 的延迟核对还会再次处理。
    void claimObservedManualDownload({ ...item, filename: relativePath });
  })().catch(() => reply());

  return true;
});

chrome.downloads.onCreated.addListener((item) => {
  const delays = [0, 400, 1200, 3000];
  delays.forEach((delay) => setTimeout(() => {
    void (async () => {
      let current = item;
      try {
        const results = await chrome.downloads.search({ id: item.id });
        current = results?.[0] || item;
      } catch (_) {}
      await claimObservedManualDownload(current);
    })().catch((error) => {
      console.warn('[Freepaper] 无法关联人工下载:', error.message);
    });
  }, delay));
});

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state?.current) {
    // filename、mime、finalUrl 等字段常在 onCreated 之后才补齐。旧版只监听
    // state 变化，导致知网这类临时下载端点在完成前一直无法匹配。
    if (delta.filename || delta.mime || delta.url || delta.finalUrl) {
      void chrome.downloads.search({ id: delta.id }).then((results) => {
        const item = results?.[0];
        if (item) return claimObservedManualDownload(item);
        return false;
      }).catch(() => {});
    }
    return;
  }
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
          mime: item.mime || '',
          url: item.url || '',
          finalUrl: item.finalUrl || '',
        });
      }
      const completedObserved = await completeObservedManualDownload(delta.id, item);
      if (!completedObserved) await claimObservedManualDownload(item);
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
    void interruptObservedManualDownload(delta.id);
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
        mime: item.mime || '',
        url: item.url || '',
        finalUrl: item.finalUrl || '',
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
  // 登录/验证属于可恢复等待态，不计入失败。needs_login 仅兼容旧任务记录。
  state.failed = state.papers.filter(p => p.status === 'failed').length;
  state.waiting = state.papers.filter(p => p.status === 'waiting_user' || p.status === 'waiting_login').length;
  state.needsLogin = state.papers.filter(p => p.status === 'waiting_login' || p.status === 'needs_login').length;
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

function isDoiResolverUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    // doi.org 通常使用 30x 自动跳转；部分中文 DOI 会先进入 chndoi.org 的
    // “多重解析地址选择页面”。两者都只是解析器，绝不能当论文详情页扫描。
    return host === 'doi.org' || host === 'dx.doi.org' || host === 'chndoi.org' || host === 'www.chndoi.org';
  } catch (_) {
    return false;
  }
}

function isChnDoiMultipleResolverUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return (host === 'chndoi.org' || host === 'www.chndoi.org') &&
      /\/resolution\/handler\/?$/i.test(url.pathname);
  } catch (_) {
    return false;
  }
}

function rankDoiResolverTarget(value, doi = '') {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (!/^https?:$/.test(url.protocol) || isDoiResolverUrl(url.href)) return -100000;

    let score = 0;
    // 对 CNKI DOI，多重解析页通常同时给出“境外 / 境内 / 期刊门户”三个入口。
    // 优先境内 link.cnki.net，让其继续完成正常知网路由；若不存在，再选择
    // CNKI 期刊门户，最后才使用境外入口。
    if (host === 'link.cnki.net') score += 1000;
    else if (host === 'link.oversea.cnki.net') score += 700;
    else if (host === 'cnki.net' || host.endsWith('.cnki.net')) score += 850;
    else score += 100;

    const normalizedDoi = normalizeBatchDoi(doi);
    if (normalizedDoi && decodeURIComponent(url.href).toLowerCase().includes(normalizedDoi)) score += 80;
    if (/\/portal\/journal\/portal\/client\/paper\//i.test(url.pathname)) score += 40;
    return score;
  } catch (_) {
    return -100000;
  }
}

function chooseDoiResolverTarget(values, doi = '') {
  const urls = (Array.isArray(values) ? values : [])
    .map(normalizeBatchUrl)
    .filter((url, index, all) => url && all.indexOf(url) === index);
  return urls
    .map((url, index) => ({ url, index, score: rankDoiResolverTarget(url, doi) }))
    .filter((item) => item.score > -100000)
    .sort((a, b) => (b.score - a.score) || (a.index - b.index))[0]?.url || '';
}

async function extractDoiResolverTargets(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: () => {
        const out = [];
        for (const anchor of document.querySelectorAll('a[href]')) {
          try {
            const url = new URL(anchor.getAttribute('href'), location.href);
            if (!/^https?:$/.test(url.protocol)) continue;
            out.push(url.href);
          } catch (_) {}
        }
        return out;
      },
    });
    return Array.isArray(results?.[0]?.result) ? results[0].result : [];
  } catch (_) {
    return [];
  }
}

async function waitForBatchDoiResolution(tabId, jobId, timeoutMs = 22000, doi = '') {
  const deadline = Date.now() + timeoutMs;
  let lastUrl = '';
  let stableSince = 0;
  let lastSeenUrl = '';
  let resolverChoiceAttemptedFor = '';
  let resolverChoiceUrl = '';

  while (Date.now() < deadline) {
    if (!(await isBatchJobRunning(jobId))) return { ok: false, stopped: true, url: lastSeenUrl };
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return { ok: false, reason: 'TAB_CLOSED', url: lastSeenUrl };

    // pendingUrl 在重定向/导航刚开始时通常比 tab.url 更早暴露目标地址。
    const currentUrl = normalizeBatchUrl(tab.pendingUrl || tab.url || '') || tab.pendingUrl || tab.url || '';
    if (currentUrl) lastSeenUrl = currentUrl;

    if (!currentUrl) {
      lastUrl = '';
      stableSince = 0;
      await sleep(250);
      continue;
    }

    if (isChnDoiMultipleResolverUrl(currentUrl)) {
      // chndoi.org 的多重解析页不会自动 30x；它会列出多个 HURL，让用户选择。
      // Freepaper 以前把这个已 complete 的中间页误认为最终论文页，900ms 后扫描失败
      // 并在 finally 中关闭标签页。现在自动选择最合适的真实论文入口再继续等待。
      if (tab.status === 'complete' && resolverChoiceAttemptedFor !== currentUrl) {
        resolverChoiceAttemptedFor = currentUrl;
        const targets = await extractDoiResolverTargets(tabId);
        const target = chooseDoiResolverTarget(targets, doi);
        if (target) {
          resolverChoiceUrl = target;
          await chrome.tabs.update(tabId, { url: target }).catch(() => null);
          lastUrl = '';
          stableSince = 0;
          await sleep(350);
          continue;
        }
      }
      lastUrl = currentUrl;
      stableSince = 0;
      await sleep(250);
      continue;
    }

    if (isDoiResolverUrl(currentUrl)) {
      lastUrl = currentUrl;
      stableSince = 0;
      await sleep(250);
      continue;
    }

    if (currentUrl !== lastUrl) {
      lastUrl = currentUrl;
      stableSince = Date.now();
    } else if (!stableSince) {
      stableSince = Date.now();
    }

    // DOI 解析器可能先完成中间页面再触发真正跳转，因此要求：
    // 1) 已离开所有 DOI 解析器；2) 最终 URL 至少稳定一小段时间；3) 页面加载完成。
    if (tab.status === 'complete' && stableSince && Date.now() - stableSince >= 900) {
      return { ok: true, url: currentUrl, resolverChoiceUrl };
    }
    await sleep(250);
  }

  return { ok: false, reason: 'DOI_RESOLUTION_TIMEOUT', url: lastSeenUrl, resolverChoiceUrl };
}

function normalizeBatchArxivId(value) {
  const match = String(value || '').match(/(?:arxiv(?:\.org)?[\/:.]|\/(?:abs|pdf)\/)(\d{4}\.\d{4,5}|[a-z-]+\/\d{7})(?:v\d+)?/i);
  return match ? match[1].toLowerCase() : '';
}


function isCnkiLikeUrl(value) {
  try {
    const url = value instanceof URL ? value : new URL(value);
    const host = url.hostname.toLowerCase();
    const path = url.pathname.toLowerCase();
    return host === 'cnki.net' || host.endsWith('.cnki.net') ||
      path.includes('/kcms/') || path.includes('/kcms2/') ||
      path.includes('/webpublication/') || path.includes('/portal/journal/portal/client/paper/');
  } catch (_) {
    return false;
  }
}

function isCnkiPdfEndpoint(value) {
  try {
    const url = value instanceof URL ? value : new URL(value);
    if (!isCnkiLikeUrl(url)) return false;
    const path = url.pathname.toLowerCase();
    const query = url.search.toLowerCase();
    const filePath = (url.searchParams.get('filePath') || url.searchParams.get('filepath') || '').toLowerCase();
    const dflag = (url.searchParams.get('dflag') || '').toLowerCase();
    return path.endsWith('.pdf') || filePath.endsWith('.pdf') ||
      (/(?:^|\/)kbdownload\.aspx$/i.test(path)) ||
      (/(?:^|\/)download\.aspx$/i.test(path) && (dflag === 'pdfdown' || query.includes('pdf')));
  } catch (_) {
    return false;
  }
}

function cnkiDocumentKey(value) {
  try {
    const url = value instanceof URL ? value : new URL(value);
    if (!isCnkiLikeUrl(url)) return '';
    const filename = url.searchParams.get('filename') || url.searchParams.get('fileName') ||
      url.searchParams.get('fn') || url.searchParams.get('FileName') || '';
    const db = url.searchParams.get('dbcode') || url.searchParams.get('dbname') ||
      url.searchParams.get('dbName') || url.searchParams.get('DbName') || '';
    if (filename) return `cnki:${String(db).toLowerCase()}:${String(filename).toLowerCase()}`;
    const filePath = url.searchParams.get('filePath') || url.searchParams.get('filepath') || '';
    if (filePath) return `cnki-file:${String(filePath).toLowerCase()}`;
    return '';
  } catch (_) {
    return '';
  }
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
      const cnkiKey = cnkiDocumentKey(url);
      if (cnkiKey) return cnkiKey;
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
    if (isCnkiLikeUrl(url)) {
      if (/\/kcms2?\/article\/abstract/i.test(path) || /\/kcms\/detail\/detail\.aspx/i.test(path)) return 185;
      if (isCnkiPdfEndpoint(url)) return 180;
      return 140;
    }
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
      (host.includes('ieee.org') && path.includes('/stamppdf/getpdf.jsp')) ||
      (host.endsWith('onlinelibrary.wiley.com') && /^\/doi\/(?:pdfdirect|pdf|epdf)\//i.test(path)) ||
      isCnkiPdfEndpoint(url) ||
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
    schemaVersion: 6,
    jobId,
    queuePolicy: 'input_order',
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
  const settings = await getFreepaperSettings();
  if (settings.autoOpenTaskMonitorOnChallenge !== false) {
    // 用户主动开始批量任务时创建并聚焦唯一监控窗；后续状态更新只复用该窗口。
    void ensureTaskMonitorWindow({ focus: true });
  }
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
    await clearConsumedSdTask(sdTask.id);
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
    if (MANUAL_DOWNLOAD_OBSERVE_STATUSES.has(task.status)) {
      await reconcileObservedManualDownload(task);
    }
    if (SD_TERMINAL_STATUSES.has(task.status)) {
      let result;
      if (task.status === 'DONE') {
        result = { status: 'done', filename: task.filename || '', fileSize: task.fileSize || 0, title: task.title || '' };
      } else if (task.status === 'STOPPED') {
        result = { status: 'failed', error: task.reason || sdStatusMessage(task) };
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
          if (contentType.includes('text/html')) {
            const preview = (await response.clone().text()).slice(0, 12000).toLowerCase();
            if (preview.includes('captcha') || preview.includes('verify you are human') ||
                preview.includes('security check') || preview.includes('安全验证') ||
                preview.includes('请输入验证码') || preview.includes('访问过于频繁') ||
                preview.includes('操作过于频繁')) {
              return { ok: false, reason: 'ROBOT_CHALLENGE' };
            }
            if (preview.includes('institutional sign in') || preview.includes('institutional access') ||
                preview.includes('access through your institution') || preview.includes('shibboleth') ||
                preview.includes('openathens') || preview.includes('saml') ||
                preview.includes('机构登录') || preview.includes('机构认证') ||
                preview.includes('学校认证') || preview.includes('统一身份认证')) {
              return { ok: false, reason: 'INSTITUTION_AUTH_REQUIRED' };
            }
            if (preview.includes('sign in') || preview.includes('login') ||
                preview.includes('authentication') || preview.includes('access denied') ||
                preview.includes('用户登录') || preview.includes('账号登录') || preview.includes('无权访问') ||
                preview.includes('没有权限')) {
              return { ok: false, reason: 'ACCOUNT_AUTH_REQUIRED' };
            }
            return { ok: false, reason: 'HTML_CONTENT_TYPE' };
          }
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

  // 首选在论文页面上下文中携带登录状态验证；若页面 fetch 受 CORS、内置查看器
  // 或运行环境影响，再由 Service Worker 对同一真实 PDF 地址做文件头验证。
  const verified = await verifyPdfCandidateInTab(tabId, candidateUrl);
  if (verified.ok) {
    return downloadVerifiedResource({
      url: verified.finalUrl || verified.pdfUrl || candidateUrl,
      blobUrl: verified.blobUrl || '',
      folder: folder || 'freepaper',
      filename: filename || 'paper.pdf',
    });
  }

  const workerVerified = await verifyRemotePdfHeader(candidateUrl);
  if (!workerVerified.ok) {
    return {
      ...verified,
      workerReason: workerVerified.reason || '',
      workerError: workerVerified.error || '',
    };
  }
  return downloadVerifiedResource({
    url: workerVerified.finalUrl || candidateUrl,
    folder: folder || 'freepaper',
    filename: filename || 'paper.pdf',
  });
}

function normalizeDetectedPaperTitle(value) {
  let title = String(value || '').replace(/\s+/g, ' ').trim();
  if (!title) return '';

  // 安全验证、购买页和浏览器中间页的标题不能覆盖 CSV/页面元数据中的论文标题。
  const placeholderTitle = /^(?:请稍候|稍候|just a moment|checking your browser|performing security verification|security verification|purchase research article|purchase|access denied|sign in|log in|login)(?:…|\.{0,3})?$/i;
  if (placeholderTitle.test(title) ||
      /^(?:请稍候|just a moment|checking your browser|purchase research article)\b/i.test(title)) {
    return '';
  }

  // 去掉常见站点后缀，避免保存为“论文标题 | IEEE Xplore.pdf”。
  title = title
    .replace(/\s*[|–—-]\s*IEEE Xplore\s*$/i, '')
    .replace(/\s*[|–—-]\s*Wiley Online Library\s*$/i, '')
    .replace(/\s*[|–—-]\s*ScienceDirect\s*$/i, '')
    .replace(/\s*[|–—-]\s*(?:中国知网|CNKI|知网)\s*$/i, '')
    .replace(/^\s*(?:中国知网|CNKI)\s*[|–—-]\s*/i, '')
    .replace(/\s*[|–—-]\s*SpringerLink\s*$/i, '')
    .replace(/\s*[|–—-]\s*Taylor & Francis Online\s*$/i, '')
    .trim();

  if (!title || placeholderTitle.test(title)) return '';
  return title.slice(0, 160);
}

function batchPaperFilenameBase(paper, detectedTitle = '') {
  return normalizeDetectedPaperTitle(paper?.title) ||
    normalizeDetectedPaperTitle(detectedTitle) ||
    normalizeBatchDoi(paper?.doi) ||
    'paper';
}

async function waitForTabReadyForBatch(tabId, jobId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let sawComplete = false;
  while (Date.now() < deadline) {
    if (!(await isBatchJobRunning(jobId))) return false;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return false;
    if (tab.status === 'complete') {
      if (sawComplete) {
        await sleep(450);
        return isBatchJobRunning(jobId);
      }
      sawComplete = true;
    } else {
      sawComplete = false;
    }
    await sleep(250);
  }
  return isBatchJobRunning(jobId);
}

async function processBatchPaper(state, paper, index) {
  const jobId = state.jobId;
  const folder = state.folder || 'freepaper';
  const candidates = [paper.url, ...(Array.isArray(paper.candidateUrls) ? paper.candidateUrls : [])]
    .map(normalizeBatchUrl)
    .filter((url, position, all) => url && all.indexOf(url) === position);
  let inputUrl = candidates[0] || `https://doi.org/${paper.doi}`;
  let probeTab = null;

  const existingSd = await getSdTask();
  if (existingSd && existingSd.batchJobId === jobId && existingSd.batchIndex === index &&
      !SD_TERMINAL_STATUSES.has(existingSd.status)) {
    return waitForSdResult(jobId, index);
  }

  // PDF 直链优先。文件名使用已有标题；没有标题时再退回 DOI。
  for (const candidate of candidates) {
    if (!isDirectNonSciencePdfUrl(candidate)) continue;
    if (!(await isBatchJobRunning(jobId))) return { status: 'stopped' };
    const direct = await downloadPdfThroughDownloadsApi({
      doi: paper.doi || 'paper',
      title: normalizeDetectedPaperTitle(paper.title),
      folder,
    }, candidate);
    if (direct.ok) {
      return {
        status: 'done',
        filename: direct.filename,
        fileSize: direct.fileSize || 0,
        title: normalizeDetectedPaperTitle(paper.title),
      };
    }
  }

  const nonDirectCandidate = candidates.find((candidate) => !isDirectNonSciencePdfUrl(candidate));
  if (nonDirectCandidate) inputUrl = nonDirectCandidate;

  try {
    probeTab = await chrome.tabs.create({ url: inputUrl, active: false });
    state.activeTabId = probeTab.id;
    await saveBatchState(state);
    if (!(await waitForTabReadyForBatch(probeTab.id, jobId, 15000))) return { status: 'stopped' };

    // DOI 是解析器，不是论文页面。Chrome/Edge 有时会短暂把 doi.org 标记为
    // complete，然后才继续 30x/脚本跳转。旧逻辑会在这个瞬间扫描 doi.org，
    // 把本应进入 CNKI 登录流程的论文直接记为 failed。
    if (isDoiResolverUrl(inputUrl)) {
      const resolution = await waitForBatchDoiResolution(probeTab.id, jobId, 22000, paper.doi || normalizeBatchDoi(inputUrl));
      if (resolution.stopped) return { status: 'stopped' };
      if (!resolution.ok) {
        return {
          status: 'failed',
          error: resolution.reason === 'DOI_RESOLUTION_TIMEOUT'
            ? `DOI 跳转未完成：仍停留在 ${resolution.url || 'doi.org'}。请检查网络或直接提供论文详情页 URL。`
            : `DOI 跳转失败：${resolution.reason || '未知错误'}`,
        };
      }
    }

    const finalTab = await chrome.tabs.get(probeTab.id).catch(() => null);
    const finalUrl = finalTab?.url || inputUrl;

    let pageData = { title: '', doi: '', candidates: [] };
    let scanError = null;
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: probeTab.id, frameIds: [0] },
        func: detectPdfsInPage,
      });
      const result = results?.[0]?.result;
      if (result && typeof result === 'object') pageData = result;
    } catch (error) {
      scanError = error;
    }

    const detectedTitle = normalizeDetectedPaperTitle(pageData.title);
    const effectiveTitle = batchPaperFilenameBase(paper, detectedTitle);
    const pdfUrls = Array.isArray(pageData.candidates) ? pageData.candidates : [];
    const candidateFailures = [];
    // executeScript 返回的 location.href 比刚读取的 tab.url 更接近页面真实最终地址。
    // DOI 跳转较慢时尤其重要，否则知网页面可能被误当成 generic，从而直接结束任务。
    const resolvedPageUrl = normalizeBatchUrl(pageData.url) || finalUrl;
    const earlyProvider = getPublisherProvider(resolvedPageUrl) || getPublisherProvider(finalUrl) || 'generic';
    const guidedPublisherFlow = GUIDED_PUBLISHER_PROVIDERS.has(earlyProvider);

    // 对需要验证/登录的主流数据库，不先后台重复请求 PDF 候选；直接交给
    // 页面状态机自动打开一次明确入口，并在真实页面处理验证与最终下载。
    for (const pdfUrl of (guidedPublisherFlow ? [] : pdfUrls)) {
      if (!(await isBatchJobRunning(jobId))) return { status: 'stopped' };
      const saved = await downloadPagePdf(
        probeTab.id,
        pdfUrl,
        folder,
        `${sanitizeFilename(effectiveTitle)}.pdf`,
      );
      if (saved.ok) {
        return {
          status: 'done',
          filename: saved.filename,
          fileSize: saved.fileSize || 0,
          title: normalizeDetectedPaperTitle(paper.title) || detectedTitle,
        };
      }
      candidateFailures.push({
        url: pdfUrl,
        reason: saved.reason || '',
        workerReason: saved.workerReason || '',
        error: saved.error || saved.workerError || '',
      });
    }

    const pageState = await inspectSdTab(probeTab.id, earlyProvider);
    const explicitManualState = ['CHALLENGE', 'ACCOUNT_AUTH_REQUIRED', 'INSTITUTION_AUTH_REQUIRED', 'DENIED', 'PURCHASE'].includes(pageState?.type);
    const manualFailureReasons = new Set([
      'ROBOT_CHALLENGE', 'AUTH_REQUIRED', 'ACCOUNT_AUTH_REQUIRED', 'INSTITUTION_AUTH_REQUIRED',
      'HTTP_401', 'HTTP_403', 'HTTP_407', 'HTTP_429',
      'HTML_CONTENT_TYPE', 'INJECTION_FAILED', 'FETCH_FAILED',
    ]);
    const candidateNeedsHandoff = candidateFailures.some((item) =>
      manualFailureReasons.has(item.reason) || manualFailureReasons.has(item.workerReason)
    );
    const specificProvider = getInteractivePublisher(resolvedPageUrl) ||
      getInteractivePublisher(finalUrl) || candidates.map(getInteractivePublisher).find(Boolean) || '';
    const provider = specificProvider || getPublisherProvider(resolvedPageUrl) || getPublisherProvider(finalUrl) || 'generic';
    const shouldStartManualHandoff = shouldUseRecoverablePublisherHandoff({
      provider,
      pageType: pageState?.type || '',
      pdfCandidateCount: pdfUrls.length,
      explicitManualState,
      candidateNeedsHandoff,
    });

    if (shouldStartManualHandoff) {
      paper.url = resolvedPageUrl || finalUrl || inputUrl;
      paper.provider = provider;
      // 用户导入表格中的标题优先；验证页“请稍候…”或购买页标题不得覆盖真实论文标题。
      paper.title = normalizeDetectedPaperTitle(paper.title) || detectedTitle || '';
      paper.preferredPdfUrl = pdfUrls.find((url) => isPublisherPdfEndpoint(url, provider)) || pdfUrls[0] || '';
      const started = await startSdTask(paper, folder, jobId, index, probeTab.id);
      if (!started) return { status: 'failed', error: '另一个需要人工验证的任务仍在运行' };
      // 当前标签页已交给全站通用验证状态机，finally 不再关闭；任务结束后统一关闭。
      probeTab = null;
      return waitForSdResult(jobId, index);
    }

    if (scanError) return { status: 'failed', error: `页面扫描失败：${scanError.message}` };
    return {
      status: 'failed',
      error: pdfUrls.length > 0
        ? '已找到 PDF 候选，但返回内容不是有效 PDF，且页面未进入可恢复的登录/验证流程'
        : '未找到可验证的 PDF，且页面未识别为可恢复的登录/验证流程',
      title: detectedTitle || normalizeDetectedPaperTitle(paper.title),
    };
  } catch (error) {
    return { status: 'failed', error: error.message, title: normalizeDetectedPaperTitle(paper.title) };
  } finally {
    // 批量任务创建的探测标签页无论是否为最后一篇都应关闭。
    if (probeTab?.id) {
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
      if (result.title && !currentPaper.title) currentPaper.title = normalizeDetectedPaperTitle(result.title);
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
  const settings = await getFreepaperSettings();
  if (settings.autoOpenTaskMonitorOnChallenge !== false) {
    void ensureTaskMonitorWindow({ focus: false });
  }
  void runBatch(state);
}


// Injected into tabs for PDF detection (batch mode)
function detectPdfsInPage() {
  const out = [];
  const push = (url, text = '', source = '') => {
    if (url && typeof url === 'string' && !url.startsWith('javascript:') && !url.startsWith('#')) {
      out.push({ url: url.trim(), text: String(text || ''), source: String(source || '') });
    }
  };
  const metaContent = (...names) => {
    for (const name of names) {
      const value = document.querySelector(`meta[name="${name}"],meta[property="${name}"]`)
        ?.getAttribute('content')?.trim();
      if (value) return value;
    }
    return '';
  };
  const cleanDoi = (value) => {
    const match = String(value || '').match(/10\.\d{4,9}\/[^\s'"<>]+/i);
    return match ? match[0].replace(/[\s,;:.]+$/g, '') : '';
  };
  const hasBlockedStaticExtension = (value) => {
    try {
      const path = new URL(value, location.href).pathname.toLowerCase();
      // 只匹配真实扩展名，.jsp 不会再被 .js 规则误伤。
      return /\.(?:css|js|mjs|woff2?|ttf|eot|svg|png|jpe?g|gif|ico|webp|map|json|xml)$/i.test(path);
    } catch (_) {
      return false;
    }
  };

  document.querySelectorAll('meta').forEach(meta => {
    const key = (meta.getAttribute('name') || meta.getAttribute('property') || '').toLowerCase();
    const content = meta.getAttribute('content');
    if (content && (key.includes('citation_pdf_url') || key.includes('pdf_url'))) push(content, key, 'meta');
  });
  document.querySelectorAll('a[href],link[href],iframe[src],embed[src],object[data]').forEach(el => {
    const url = el.getAttribute('href') || el.getAttribute('src') || el.getAttribute('data');
    const text = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
    push(url, text, el.tagName);
  });

  const host = location.hostname.toLowerCase();
  const canonicalDoi = cleanDoi(
    metaContent('citation_doi', 'dc.identifier', 'DC.Identifier', 'dc.Identifier') || location.href
  );

  if (host.includes('ieee.org')) {
    const params = new URLSearchParams(location.search);
    const arnumber = params.get('arnumber') ||
      location.pathname.match(/\/document\/(\d+)/i)?.[1] ||
      metaContent('citation_id', 'arnumber').match(/\d+/)?.[0] || '';
    if (arnumber) push(`https://ieeexplore.ieee.org/stampPDF/getPDF.jsp?tp=&arnumber=${arnumber}`, 'IEEE PDF', 'ieee-construct');
    document.querySelectorAll('a[href*="stampPDF/getPDF.jsp"],a[href*="/stamp/stamp.jsp"]').forEach(el => {
      const raw = el.getAttribute('href') || '';
      push(raw.replace('/stamp/stamp.jsp', '/stampPDF/getPDF.jsp'), 'IEEE PDF', 'ieee-link');
    });
  }

  if (host.endsWith('onlinelibrary.wiley.com') && canonicalDoi) {
    push(`https://onlinelibrary.wiley.com/doi/pdfdirect/${canonicalDoi}`, 'Wiley PDF direct', 'wiley-construct');
    push(`https://onlinelibrary.wiley.com/doi/pdf/${canonicalDoi}`, 'Wiley PDF', 'wiley-construct');
    push(`https://onlinelibrary.wiley.com/doi/epdf/${canonicalDoi}`, 'Wiley ePDF', 'wiley-construct');
  }

  // CNKI：仅使用页面已经提供的下载入口或同一官方下载地址的 PDF 模式。
  // 不尝试绕过登录、验证码、机构权限或付费控制。
  const cnkiLikePage = host === 'cnki.net' || host.endsWith('.cnki.net') ||
    location.pathname.toLowerCase().includes('/kcms/') ||
    location.pathname.toLowerCase().includes('/kcms2/') ||
    location.pathname.toLowerCase().includes('/webpublication/') ||
    location.pathname.toLowerCase().includes('/portal/journal/portal/client/paper/');
  if (cnkiLikePage) {
    const addEmbeddedUrls = (raw, label = '', source = '') => {
      const value = String(raw || '').replace(/&amp;/gi, '&');
      if (!value) return;
      if (!/^javascript:/i.test(value)) push(value, label, source);
      const matches = value.match(/(?:https?:\/\/[^'"\s)<>]+|\/(?:[^'"\s)<>]*\/)?(?:kcms\/download\.aspx|download\.aspx|kbDownload\.aspx|paper\/preview)[^'"\s)<>]*)/ig) || [];
      matches.forEach((match) => push(match, label, `${source}-embedded`));
    };

    document.querySelectorAll('a,button,[onclick],[data-url],[data-href],[data-download],[data-download-url]').forEach((el) => {
      const label = (el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
      for (const attr of ['href', 'onclick', 'data-url', 'data-href', 'data-download', 'data-download-url']) {
        const value = el.getAttribute(attr);
        if (value) addEmbeddedUrls(value, label, `cnki-${attr}`);
      }
    });

    // 知网部分页面只公开一个 CAJ/全文下载端点；若端点已经由页面提供，
    // 复制相同参数并设置 dflag=pdfdown 作为 PDF 候选。服务器仍会正常校验用户权限。
    for (const item of [...out]) {
      try {
        const candidate = new URL(item.url, location.href);
        const path = candidate.pathname.toLowerCase();
        const label = `${item.text} ${item.source}`.toLowerCase();
        const isDownloadEndpoint = /(?:^|\/)(?:kcms\/)?download\.aspx$/i.test(path) ||
          /(?:^|\/)kbdownload\.aspx$/i.test(path);
        if (!isDownloadEndpoint) continue;
        push(candidate.href, item.text || 'CNKI download', 'cnki-download-link');
        if (/download\.aspx$/i.test(path) &&
            (label.includes('pdf') || label.includes('caj') ||
             candidate.searchParams.has('filename') || candidate.searchParams.has('fileName'))) {
          const pdfCandidate = new URL(candidate.href);
          pdfCandidate.searchParams.set('dflag', 'pdfdown');
          push(pdfCandidate.href, 'CNKI PDF', 'cnki-pdf-variant');
        }
      } catch (_) {}
    }
  }

  if (host === 'pdf.sciencedirectassets.com') push(location.href, 'ScienceDirect PDF', 'current-url');
  document.querySelectorAll('a[href*="/pdfft"],a[href*="pdf.sciencedirectassets.com"],link[type="application/pdf"]').forEach(el => {
    push(el.getAttribute('href') || '', 'ScienceDirect PDF', 'science-direct-link');
  });
  document.querySelectorAll('embed[type="application/pdf"],object[type="application/pdf"]').forEach(el => {
    push(el.src || el.data, 'PDF embed', 'embed');
  });

  const candidates = [];
  const seen = new Set();
  for (const item of out) {
    let url;
    try { url = new URL(item.url, location.href).href; } catch (_) { continue; }
    if (hasBlockedStaticExtension(url) || seen.has(url)) continue;
    seen.add(url);

    const lower = `${url} ${item.text} ${item.source}`.toLowerCase();
    let score = 0;
    if (lower.includes('stamppdf/getpdf.jsp')) score += 130;
    if (lower.includes('pdf.sciencedirectassets.com')) score += 130;
    if (lower.includes('/pdfft')) score += 120;
    if (lower.includes('/doi/pdfdirect/')) score += 115;
    if (lower.includes('/doi/epdf/')) score += 110;
    if (lower.includes('/doi/pdf/')) score += 100;
    if (lower.includes('dflag=pdfdown')) score += 170;
    if (lower.includes('/kcms/download.aspx') || /\/download\.aspx(?:[?#]|$)/i.test(url)) score += 95;
    if (lower.includes('kbdownload.aspx')) score += 105;
    if (lower.includes('/paper/preview') && lower.includes('.pdf')) score += 115;
    if (lower.includes('pdf下载') || lower.includes('下载pdf') || lower.includes('pdf download')) score += 70;
    if (/\.pdf(?:$|[?#])/i.test(url)) score += 80;
    if (lower.includes('download=true') || lower.includes('download=pdf') || lower.includes('type=pdf')) score += 60;
    if (lower.includes('/pdf')) score += 35;
    if (lower.includes('download')) score += 20;
    if (lower.includes('citation_pdf_url')) score += 60;
    if (lower.includes('/doi/full/') || lower.includes('/doi/abs/') || lower.includes('/abstract') ||
        lower.includes('/kcms2/article/abstract') || lower.includes('/kcms/detail/detail.aspx')) score -= 120;
    if (lower.includes('caj') && !lower.includes('dflag=pdfdown')) score -= 80;
    const path = (() => { try { return new URL(url).pathname.toLowerCase(); } catch (_) { return ''; } })();
    if (/\.(?:html?|xhtml)$/i.test(path)) score -= 120;
    if (lower.includes('.ris') || lower.includes('.bib') || lower.includes('citation-export') || lower.includes('download-citation')) score -= 60;
    if (score >= 30) candidates.push({ url, score });
  }
  candidates.sort((a, b) => b.score - a.score);

  const cnkiTitle = cnkiLikePage
    ? (document.querySelector('h1, .wx-tit h1, .brief h1, .title h1, .article-title')?.textContent || '').trim()
    : '';
  const title = metaContent('citation_title', 'dc.title', 'DC.Title', 'og:title', 'twitter:title') || cnkiTitle || document.title;
  return {
    url: location.href,
    title,
    doi: canonicalDoi,
    candidates: candidates.slice(0, 10).map(item => item.url),
  };
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

        case 'PDF_ACTION_CLICKED':
          return handleUserPdfAction(sender.tab?.id, msg);

        case 'DOWNLOAD_EXAMPLE_CSV': {
          const url = `data:text/csv;charset=utf-8,${encodeURIComponent(EXAMPLE_CSV_TEXT)}`;
          const downloadId = await chrome.downloads.download({
            url,
            filename: 'Freepaper/freepaper-example.csv',
            conflictAction: 'uniquify',
            saveAs: false,
          });
          return { ok: Number.isInteger(downloadId), downloadId };
        }

        case 'OPEN_HELP': {
          const tab = await chrome.tabs.create({ url: chrome.runtime.getURL(`${ONBOARDING_PAGE}?mode=help`) });
          return { ok: Number.isInteger(tab?.id), tabId: tab?.id ?? null };
        }

        case 'GET_DIAGNOSTIC_REPORT':
          return { ok: true, report: await buildDiagnosticReport() };

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
    // 只允许由任务页打开的新导航目标加入任务；先按 URL 分类，
    // 不能把购买页、广告页或其他子窗口一律误标记为 PDF。
    if (!context.fromTaskNavigation) return;
    await bindTaskChildTab(task, tabId, tabUrl, context.sourceTabId ?? null, 'inspection_bind');
    task = await getSdTask();
    if (!task || !isTaskTab(task, tabId)) return;
  }

  // 先检查真实 DOM。验证码或登录页可能保留 PDF 风格 URL，不能先按 URL
  // 直接进入下载流程；只有脚本无法注入/状态未知时，才把严格 PDF 路由
  // 视为浏览器内置 PDF 查看器。
  const state = await inspectSdTab(tabId, task.provider || '');
  if (state && state.type !== 'UNKNOWN') {
    await handleSdState(task, state, tabId, context);
  } else {
    const inferred = inferSdStateFromTab(tab, tabUrl, task.provider || '');
    if (inferred?.type === 'PDF_VIEWER') await handleSdState(task, inferred, tabId, context);
    else if (state) await handleSdState(task, state, tabId, context);
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

async function bindTaskChildTab(task, tabId, targetUrl = '', sourceTabId = null, reason = 'child_tab') {
  if (!task || !Number.isInteger(tabId)) return;
  const url = targetUrl || '';
  rememberTaskTab(task, tabId, true);
  rememberTaskTab(task, tabId);
  if (Number.isInteger(sourceTabId)) task.openedFromTabId = sourceTabId;

  const provider = getPublisherProvider(url);
  const sameProvider = provider && (!task.provider || task.provider === 'generic' || provider === task.provider || looksLikeAuthenticationUrl(url));
  if (sameProvider) {
    task.provider = task.provider || provider;
    task.activeTabId = tabId;
    task.lastUrl = url || task.lastUrl || '';
    forgetPendingTaskTab(task, tabId);
    unmarkIgnoredTaskTab(task, tabId);
    if (isPublisherPdfEndpoint(url, task.provider)) {
      task.pdfTabId = tabId;
      task.stage = 'OPENING_PDF';
      task.status = 'OPENING_PDF';
      task.challengePhase = 2;
    }
    await saveSdTask(task);
    scheduleSdInspection(tabId, {
      reason,
      url,
      fromTaskNavigation: true,
      fast: true,
    });
    return;
  }

  // about:blank 可能稍后才获得真实 URL，先保留为 pending；明确无关页面只纳入清理列表，
  // 不得误标记为 PDF 页，也不得覆盖当前有用的验证页面。
  if (url && url !== 'about:blank') {
    forgetPendingTaskTab(task, tabId);
    markIgnoredTaskTab(task, tabId);
  }
  await saveSdTask(task);
}

async function bindCreatedNavigationTarget(details) {
  if (!details || !Number.isInteger(details.tabId) || !Number.isInteger(details.sourceTabId)) return;
  const task = await getSdTask();
  if (!task || SD_TERMINAL_STATUSES.has(task.status) || !isTaskTab(task, details.sourceTabId)) return;
  await bindTaskChildTab(
    task,
    details.tabId,
    details.url || '',
    details.sourceTabId,
    'created_navigation_target',
  );
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
  // Service Worker 恢复时复用唯一下载进程窗，不主动抢焦点。
  if (SD_MANUAL_STATUSES.has(task.status)) {
    const settings = await getFreepaperSettings();
    if (settings.autoOpenTaskMonitorOnChallenge === true) {
      void ensureTaskMonitorWindow({ focus: false });
    }
  }
  const tabId = taskTabIds(task).find(Number.isInteger);
  if (Number.isInteger(tabId)) scheduleSdInspection(tabId, { reason, fast: true });
}

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[Freepaper] 扩展已安装/更新:', details?.reason || 'unknown');
  await chrome.storage.local.set({
    freepaper_build_info: { version: '2.0.5', build: 'chndoi-multi-target-resolver-handoff', installedAt: Date.now() },
  });
  await migrateLegacyBatchState(`onInstalled:${details?.reason || 'unknown'}`);
  chrome.alarms.create(BATCH_RESUME_ALARM, { periodInMinutes: 1 });
  await recoverActiveBatch('installed');
  await recoverSdUi('installed');
  const mode = details?.reason === 'install' ? 'install' : 'update';
  const page = chrome.runtime.getURL(`${ONBOARDING_PAGE}?mode=${mode}`);
  void chrome.tabs.create({ url: page }).catch(() => null);
});

chrome.runtime.onStartup.addListener(async () => {
  await chrome.storage.local.set({
    freepaper_build_info: { version: '2.0.5', build: 'chndoi-multi-target-resolver-handoff', startedAt: Date.now() },
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
    rememberTaskTab(task, details.tabId);
    const provider = getPublisherProvider(details.url || '') || task.provider || '';
    if (provider && !task.provider) task.provider = provider;
    if (details.tabId === task.pdfTabId || isPublisherPdfEndpoint(details.url || '', task.provider || provider)) {
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
    if (!taskTabIds(task).includes(tabId)) return;

    const currentUrl = info.url || tab.url || tab.pendingUrl || '';
    const currentProvider = getPublisherProvider(currentUrl);
    if (Array.isArray(task.ignoredTabIds) && task.ignoredTabIds.includes(tabId)) {
      if (currentProvider && (!task.provider || task.provider === 'generic' || currentProvider === task.provider || looksLikeAuthenticationUrl(currentUrl))) {
        unmarkIgnoredTaskTab(task, tabId);
        rememberTaskTab(task, tabId, true);
      } else {
        return;
      }
    }

    if (Array.isArray(task.pendingChildTabIds) && task.pendingChildTabIds.includes(tabId)) {
      const provider = getPublisherProvider(currentUrl);
      if (provider && (!task.provider || task.provider === 'generic' || provider === task.provider || looksLikeAuthenticationUrl(currentUrl))) {
        task.provider = task.provider || provider;
        task.activeTabId = tabId;
        task.lastUrl = currentUrl;
        forgetPendingTaskTab(task, tabId);
        unmarkIgnoredTaskTab(task, tabId);
        if (isPublisherPdfEndpoint(currentUrl, task.provider)) {
          task.pdfTabId = tabId;
          task.stage = 'OPENING_PDF';
          task.status = 'OPENING_PDF';
          task.challengePhase = 2;
        }
        await saveSdTask(task);
      } else if (currentUrl && currentUrl !== 'about:blank') {
        // 明确无关的子页面保留在 managedTabIds 中用于任务结束时关闭，
        // 但不参与验证状态判断。
        forgetPendingTaskTab(task, tabId);
        markIgnoredTaskTab(task, tabId);
        await saveSdTask(task);
        return;
      }
    }

    scheduleSdInspection(tabId, {
      reason: `tabs_${info.status || 'url'}`,
      url: currentUrl,
      fast: info.status === 'complete',
    });
  })();
});

chrome.tabs.onCreated.addListener((tab) => {
  if (!Number.isInteger(tab.id) || !Number.isInteger(tab.openerTabId)) return;
  void (async () => {
    const task = await getSdTask();
    if (!task || SD_TERMINAL_STATUSES.has(task.status) || !isTaskTab(task, tab.openerTabId)) return;
    await bindTaskChildTab(
      task,
      tab.id,
      tab.pendingUrl || tab.url || '',
      tab.openerTabId,
      'tabs_created_with_opener',
    );
  })();
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const task = await getSdTask();
  if (!task || SD_TERMINAL_STATUSES.has(task.status) || !taskTabIds(task).includes(tabId)) return;

  if (Array.isArray(task.managedTabIds)) {
    task.managedTabIds = task.managedTabIds.filter((id) => id !== tabId);
  }
  if (Array.isArray(task.pendingChildTabIds)) {
    task.pendingChildTabIds = task.pendingChildTabIds.filter((id) => id !== tabId);
  }
  if (Array.isArray(task.ignoredTabIds)) {
    task.ignoredTabIds = task.ignoredTabIds.filter((id) => id !== tabId);
  }
  if (task.pdfTabId === tabId) task.pdfTabId = null;
  if (task.articleTabId === tabId) task.articleTabId = null;
  if (task.activeTabId === tabId) task.activeTabId = null;

  const remaining = taskTabIds(task);
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
