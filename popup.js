/* This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
 * If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// popup.js — Freepaper 独立扩展面板
// 浏览器扩展独立运行，不依赖桌面程序或本地后端。

'use strict';

const $ = (id) => document.getElementById(id);
const t = (key, vars = {}) => FreepaperI18n.t(key, vars);
const paperStatusText = (status) => FreepaperI18n.paperStatus(status) || status || '';
const sdStatusText = (status) => FreepaperI18n.status(status) || t('processing');

function createElement(tag, options = {}) {
  const element = document.createElement(tag);
  if (options.className) element.className = options.className;
  if (options.text !== undefined) element.textContent = String(options.text);
  if (options.title !== undefined) element.title = String(options.title);
  if (options.id) element.id = options.id;
  if (options.style) element.style.cssText = options.style;
  return element;
}

function renderSimpleMessage(container, lines, options = {}) {
  container.replaceChildren();
  const box = createElement('div', {
    style: `font-size:11px;color:${options.color || 'var(--text-muted)'};padding:8px 0;line-height:1.6;`,
  });
  for (const line of lines) {
    box.appendChild(createElement('div', { text: line }));
  }
  container.appendChild(box);
  return box;
}

function csvCell(value) {
  let text = String(value ?? '');
  // 防止用 Excel/LibreOffice 打开报告时把外部输入解释为公式。
  if (/^[\s\u0000-\u001f]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}


// =========================================================================
// State
// =========================================================================

let batchPapers = [];          // { doi, url, status: 'pending'|'done'|'failed' }
let isBatchRunning = false;
let showSettings = false;
let downloadFolder = 'freepaper';
let autoOpenTaskMonitorOnChallenge = false;
let lastBatchUpdatedAt = -1;
let lastSdUpdatedAt = -1;
let lastParseStats = {
  inputRecords: 0, uniquePapers: 0, duplicatesRemoved: 0,
  uniqueTitles: 0, isDiagnosticTable: false,
};
let latestTaskSnapshot = { batch: null, sd: null, monitorOpen: false };

// =========================================================================
// Init
// =========================================================================

document.addEventListener('DOMContentLoaded', async () => {
  await FreepaperI18n.init();
  FreepaperI18n.applyDocument(document);
  const settings = await chrome.storage.local.get('freepaper_settings');
  if ($('languageSelect')) $('languageSelect').value = FreepaperI18n.getLanguageMode();
  if (settings.freepaper_settings?.downloadFolder) {
    downloadFolder = settings.freepaper_settings.downloadFolder;
    $('downloadFolder').value = downloadFolder;
  }
  autoOpenTaskMonitorOnChallenge = settings.freepaper_settings?.autoOpenTaskMonitorOnChallenge === true;
  $('footerText').textContent = t('footerPath', { folder: downloadFolder });
  ensureGlobalTaskControl();
  ensureEnhancedSettingsControl();
  document.querySelectorAll('.panel').forEach((panel) => panel.style.removeProperty('display'));

  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.panel));
  });
  $('btnDownloadAll').addEventListener('click', downloadAllPage);
  $('btnRescan').addEventListener('click', rescanPage);
  $('btnLoadFile').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', handleFileLoad);
  $('btnStartBatch').addEventListener('click', startBatch);
  $('btnClearBatch').addEventListener('click', clearBatch);
  $('btnRefresh')?.addEventListener('click', async () => {
    $('btnRefresh').style.transform = 'rotate(360deg)';
    $('btnRefresh').style.transition = 'transform 0.5s';
    setTimeout(() => { $('btnRefresh').style.transform = ''; $('btnRefresh').style.transition = ''; }, 500);
    await syncPersistentTaskState(true);
    await loadRecentDownloads();
    await checkPagePdfs();
  });
  $('btnSettings')?.addEventListener('click', toggleSettings);
  $('btnSaveSettings')?.addEventListener('click', saveSettings);
  $('btnCancelSettings')?.addEventListener('click', () => setSettingsOpen(false));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && showSettings) setSettingsOpen(false);
  });

  $('btnContinueVerify')?.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ command: 'SD_CONTINUE' });
    const data = await chrome.storage.local.get('sd_notification');
    renderSdNotification(data.sd_notification);
  });
  $('btnStopSd')?.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ command: 'SD_SKIP' });
    $('statusLabel').textContent = t('sd_STOPPED');
  });
  $('btnClearRecent')?.addEventListener('click', async () => {
    if (!confirm(t('confirmClearRecent'))) return;
    await chrome.storage.local.remove(['freepaper_recent_downloads', 'recent_cleared_at']);
    $('recentList').replaceChildren();
    $('recentSection').style.display = 'none';
  });

  $('btnStopAll')?.addEventListener('click', async () => {
    const result = await chrome.runtime.sendMessage({ command: 'BATCH_STOP' });
    isBatchRunning = false;
    $('sdNotify').style.display = 'none';
    if (result?.state) renderBatchProgress(result.state);
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes.batch_state) {
      const state = changes.batch_state.newValue || null;
      latestTaskSnapshot.batch = state;
      if (state?.papers?.length) {
        lastBatchUpdatedAt = state.updatedAt || Date.now();
        renderBatchProgress(state);
      } else {
        isBatchRunning = false;
      }
    }
    if (changes.sd_state) {
      latestTaskSnapshot.sd = changes.sd_state.newValue || null;
    }
    if (changes.sd_notification) {
      lastSdUpdatedAt = changes.sd_notification.newValue?.timestamp || Date.now();
      renderSdNotification(changes.sd_notification.newValue);
    }
    renderGlobalTaskControl(
      latestTaskSnapshot.batch, latestTaskSnapshot.sd, latestTaskSnapshot.monitorOpen,
    );
  });

  // 每次 popup 打开都向后台索取同一份权威快照；storage 仅作为后台未唤醒时的兜底。
  // 因此无论从哪个浏览器标签页点开扩展，看到的都是同一个批量任务。
  await syncPersistentTaskState(true);

  await loadRecentDownloads();
  if (!isBatchRunning && !latestTaskSnapshot.sd) void checkPagePdfs();
  setInterval(loadRecentDownloads, 2000);
  setInterval(() => void syncPersistentTaskState(false), 1200);
});

async function syncPersistentTaskState(force = false) {
  let batch = null;
  let sd = null;
  let sdNotification = null;
  let monitorOpen = false;
  try {
    const snapshot = await chrome.runtime.sendMessage({ command: 'GET_TASK_SNAPSHOT' });
    if (snapshot?.ok) {
      batch = snapshot.batch || null;
      sd = snapshot.sd || null;
      monitorOpen = snapshot.monitorOpen === true;
      if (sd) {
        sdNotification = {
          taskId: sd.id,
          doi: sd.doi || '',
          message: sd.status ? sdStatusText(sd.status) : '',
          status: sd.status,
          timestamp: sd.updatedAt || 0,
        };
      }
    }
  } catch (_) {}

  if (!batch || !sd || !sdNotification) {
    const stored = await chrome.storage.local.get(['batch_state', 'sd_state', 'sd_notification']);
    batch = batch || stored.batch_state || null;
    sd = sd || stored.sd_state || null;
    sdNotification = sdNotification || stored.sd_notification || null;
  }

  latestTaskSnapshot = { batch, sd, monitorOpen };
  renderGlobalTaskControl(batch, sd, monitorOpen);

  if (batch?.papers?.length) {
    const stamp = batch.updatedAt || 0;
    if (force || stamp !== lastBatchUpdatedAt) {
      lastBatchUpdatedAt = stamp;
      switchTab('batch');
      renderBatchProgress(batch);
    }
  } else if (force) {
    isBatchRunning = false;
  }

  const sdStamp = sdNotification?.timestamp || 0;
  if (force || sdStamp !== lastSdUpdatedAt) {
    lastSdUpdatedAt = sdStamp;
    renderSdNotification(sdNotification);
  }
}


const GLOBAL_MANUAL_STATUSES = new Set([
  'WAITING_CHALLENGE_1', 'WAITING_CHALLENGE_2', 'WAITING_MANUAL_PDF',
  'ACCESS_DENIED', 'CHECKING_AFTER_CHALLENGE',
]);
const GLOBAL_TERMINAL_STATUSES = new Set(['DONE', 'FAILED', 'STOPPED']);

function ensureGlobalTaskControl() {
  if ($('freepaperGlobalControl')) return;
  const host = document.createElement('section');
  host.id = 'freepaperGlobalControl';
  host.style.cssText = [
    'display:none', 'margin:10px 12px 8px', 'padding:12px',
    'border:1px solid #c7d2fe', 'border-radius:12px',
    'background:linear-gradient(135deg,#eef2ff,#ffffff)',
    'box-shadow:0 7px 22px rgba(67,56,202,.10)',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif',
  ].join(';');
  host.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:7px;">
      <div style="font-size:13px;font-weight:800;color:#1e1b4b;" data-i18n="globalTitle">${t('globalTitle')}</div>
      <div id="globalTaskBadge" data-i18n="running" style="padding:3px 7px;border-radius:999px;background:#4f46e5;color:#fff;font-size:9px;font-weight:800;">${t('running')}</div>
    </div>
    <div id="globalTaskMessage" data-i18n="readingTask" style="font-size:12px;line-height:1.55;color:#1e293b;">${t('readingTask')}</div>
    <div id="globalTaskCurrent" style="margin-top:5px;font-size:10px;line-height:1.45;color:#64748b;word-break:break-all;"></div>
    <div style="height:6px;margin:9px 0 5px;border-radius:999px;background:#e2e8f0;overflow:hidden;">
      <div id="globalTaskFill" style="height:100%;width:0;background:#4f46e5;transition:width .2s ease;"></div>
    </div>
    <div id="globalTaskStats" style="font-size:10px;color:#64748b;margin-bottom:9px;"></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
      <button id="globalContinue" data-i18n="continueVerify" style="display:none;grid-column:1/-1;border:0;border-radius:8px;padding:8px;background:#2563eb;color:#fff;font-size:11px;font-weight:750;cursor:pointer;">${t('continueVerify')}</button>
      <button id="globalFocus" data-i18n="taskPage" style="border:0;border-radius:8px;padding:8px;background:#e0e7ff;color:#3730a3;font-size:11px;font-weight:750;cursor:pointer;">${t('taskPage')}</button>
      <button id="globalMonitor" data-i18n="openMonitor" style="border:0;border-radius:8px;padding:8px;background:#ede9fe;color:#5b21b6;font-size:11px;font-weight:750;cursor:pointer;">${t('openMonitor')}</button>
      <button id="globalPause" data-i18n="pauseBatch" style="display:none;border:0;border-radius:8px;padding:8px;background:#fef3c7;color:#92400e;font-size:11px;font-weight:750;cursor:pointer;">${t('pauseBatch')}</button>
      <button id="globalSkip" data-i18n="skipPaper" style="border:0;border-radius:8px;padding:8px;background:#e2e8f0;color:#1e293b;font-size:11px;font-weight:750;cursor:pointer;">${t('skipPaper')}</button>
      <button id="globalStop" data-i18n="stopAll" style="border:0;border-radius:8px;padding:8px;background:#fee2e2;color:#b91c1c;font-size:11px;font-weight:750;cursor:pointer;">${t('stopAll')}</button>
    </div>`;

  FreepaperI18n.applyDocument(host);
  const insertionPoint = document.querySelector('header, .header, .topbar');
  if (insertionPoint?.parentNode) insertionPoint.insertAdjacentElement('afterend', host);
  else document.body.prepend(host);

  $('globalContinue').addEventListener('click', async () => {
    const btn = $('globalContinue');
    btn.disabled = true;
    btn.textContent = t('checkingPage');
    await chrome.runtime.sendMessage({ command: 'SD_CONTINUE' }).catch(() => null);
    btn.textContent = t('continueVerify');
    await syncPersistentTaskState(true);
  });
  $('globalFocus').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ command: 'FOCUS_TASK_TAB' }).catch(() => null);
  });
  $('globalMonitor').addEventListener('click', async () => {
    const button = $('globalMonitor');
    button.disabled = true;
    button.textContent = latestTaskSnapshot.monitorOpen ? t('focusing') : t('opening');
    const result = await chrome.runtime.sendMessage({ command: 'OPEN_TASK_MONITOR' }).catch(() => null);
    if (result?.ok) latestTaskSnapshot.monitorOpen = true;
    button.disabled = false;
    await syncPersistentTaskState(true);
  });
  $('globalPause').addEventListener('click', async () => {
    const paused = latestTaskSnapshot.batch?.paused === true;
    const command = paused ? 'BATCH_RESUME' : 'BATCH_PAUSE';
    const result = await chrome.runtime.sendMessage({ command }).catch(() => null);
    if (result?.state) latestTaskSnapshot.batch = result.state;
    await syncPersistentTaskState(true);
  });
  $('globalSkip').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ command: 'SD_SKIP' }).catch(() => null);
    await syncPersistentTaskState(true);
  });
  $('globalStop').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ command: 'BATCH_STOP' }).catch(() => null);
    await syncPersistentTaskState(true);
  });
}

function globalSdMessage(sd) {
  return sd?.status ? sdStatusText(sd.status) : t('taskRunning');
}

function renderGlobalTaskControl(batch, sd, monitorOpen = false) {
  ensureGlobalTaskControl();
  const host = $('freepaperGlobalControl');
  if (!host) return;

  const sdActive = Boolean(sd && !GLOBAL_TERMINAL_STATUSES.has(sd.status));
  const batchActive = Boolean(batch?.papers?.length && batch.running);
  const batchPaused = Boolean(batchActive && batch.paused);
  if (!sdActive && !batchActive) {
    host.style.display = 'none';
    return;
  }
  host.style.display = 'block';

  const total = batch?.total || batch?.papers?.length || 0;
  const processed = batch?.papers?.filter((paper) =>
    ['done', 'failed', 'needs_login'].includes(paper.status)).length || 0;
  const activeIndex = Number.isInteger(batch?.activeIndex) && batch.activeIndex >= 0
    ? batch.activeIndex
    : Math.max(0, Math.min((batch?.current || 1) - 1, Math.max(total - 1, 0)));
  const currentPaper = batch?.papers?.[activeIndex] || null;
  const manual = Boolean(sdActive && GLOBAL_MANUAL_STATUSES.has(sd.status));

  $('globalTaskBadge').textContent = manual ? t('needsAction') : (batchPaused ? t('paused') : t('running'));
  $('globalTaskBadge').style.background = manual ? '#d97706' : (batchPaused ? '#92400e' : '#4f46e5');
  $('globalTaskMessage').textContent = manual
    ? globalSdMessage(sd)
    : (batchActive
      ? (batchPaused
        ? (Number.isInteger(batch.activeIndex) && batch.activeIndex >= 0
          ? t('pauseAfterCurrent')
          : t('batchPausedResumeAt', { index: Math.min(total, (batch.nextIndex || 0) + 1) }))
        : t('batchRunningAt', { current: Math.max(1, activeIndex + 1), total }))
      : globalSdMessage(sd));

  const detailParts = [];
  if (currentPaper) detailParts.push(currentPaper.doi || currentPaper.url || t('unknownPaper'));
  else if (sd?.doi) detailParts.push(sd.doi);
  if (currentPaper?.status) detailParts.push(t('statusPrefix', { status: paperStatusText(currentPaper.status) }));
  $('globalTaskCurrent').textContent = detailParts.join(' · ');

  const percent = total ? Math.round(processed / total * 100) : (sdActive ? 15 : 0);
  $('globalTaskFill').style.width = `${Math.max(0, Math.min(100, percent))}%`;
  $('globalTaskStats').textContent = total
    ? t('stats', { processed, total, done: batch.done || 0, failed: batch.failed || 0 })
    : t('singleTaskRunning');

  $('globalContinue').style.display = manual ? 'block' : 'none';
  $('globalContinue').disabled = !manual;
  $('globalFocus').disabled = !sdActive && !Number.isInteger(batch?.activeTabId);
  $('globalMonitor').textContent = monitorOpen ? t('focusMonitor') : t('openMonitor');
  $('globalMonitor').disabled = !batchActive && !sdActive;
  $('globalPause').style.display = batchActive ? 'block' : 'none';
  $('globalPause').textContent = batchPaused ? t('resumeBatch') : t('pauseBatch');
  $('globalPause').disabled = !batchActive;
  $('globalSkip').disabled = !sdActive;
  $('globalStop').disabled = !batchActive && !sdActive;
}

function renderSdNotification(notification) {
  // v1.3.0 起由主面板顶部总控台统一承载状态和操作。
  // 保留旧 DOM 仅用于兼容现有 popup.html，不再显示第二套控制界面。
  if ($('freepaperGlobalControl')) {
    $('sdNotify').style.display = 'none';
    return;
  }
  if (notification?.message && GLOBAL_MANUAL_STATUSES.has(notification.status)) {
    $('sdNotify').style.display = 'block';
    $('sdNotifyMsg').textContent = notification.message;
  } else {
    $('sdNotify').style.display = 'none';
  }
}

// =========================================================================
// Tabs
// =========================================================================

function switchTab(panelName) {
  // 清除旧版本设置页留下的内联 display，面板可见性只由 active class 决定。
  if (showSettings) setSettingsOpen(false);
  const targetId = `panel${panelName === 'page' ? 'Page' : 'Batch'}`;
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.panel === panelName);
  });
  document.querySelectorAll('.panel').forEach((panel) => {
    panel.style.removeProperty('display');
    panel.classList.toggle('active', panel.id === targetId);
  });
  if (panelName === 'page') checkPagePdfs();
}

// =========================================================================
// Panel 1: 当前页面 PDF 检测（直接注入代码，比 content script 更可靠）
// =========================================================================

// PDF 检测代码（注入到目标页面执行，无需 content script）
function DETECT_JS() {
  const out = [];
  const push = (url, text, source) => {
    if (url && typeof url === 'string') out.push({ url: String(url).trim(), text: String(text||''), source });
  };

  // Meta
  document.querySelectorAll('meta').forEach(meta => {
    const k = (meta.getAttribute('name')||meta.getAttribute('property')||'').toLowerCase();
    const c = meta.getAttribute('content');
    if (c && (k.includes('citation_pdf_url')||k.includes('pdf_url')||k==='pdf_url')) push(c, k, 'meta');
  });
  // Links & embeds
  document.querySelectorAll('a[href],link[href],iframe[src],embed[src],object[data]').forEach(el => {
    const url = el.getAttribute('href')||el.getAttribute('src')||el.getAttribute('data');
    const text = (el.innerText||el.getAttribute('aria-label')||el.getAttribute('title')||'').trim();
    if (url && !url.startsWith('javascript:') && !url.startsWith('#') && url !== location.href) push(url, text, el.tagName);
  });
  // PDF.js
  document.querySelectorAll('script').forEach(s => {
    const t = s.textContent||s.innerText||'';
    const m = t.match(/PDFViewerApplicationOptions\s*\.\s*set\s*\(\s*['\"]defaultUrl['\"]\s*,\s*['\"]([^'\"]+)['\"]/i);
    if (m) push(m[1], 'pdfjs-defaultUrl', 'script');
  });
  // IEEE stamp.jsp
  if (location.hostname.includes('ieee.org') && location.pathname.includes('stamp.jsp')) {
    const p = new URLSearchParams(location.search);
    const ar = p.get('arnumber');
    if (ar) push(`https://ieeexplore.ieee.org/stampPDF/getPDF.jsp?tp=&arnumber=${ar}`, 'IEEE PDF', 'ieee-construct');
  }
  // pdf.sciencedirectassets.com：当前页面 URL 就是 PDF
  if (location.hostname === 'pdf.sciencedirectassets.com') {
    push(location.href, 'ScienceDirect PDF', 'current-url');
  }
  // <embed type="application/pdf"> —— ScienceDirect 等用 embed 加载 PDF
  document.querySelectorAll('embed[type="application/pdf"]').forEach(el => {
    if (el.src) push(el.src, 'PDF embed', 'embed');
  });
  document.querySelectorAll('object[type="application/pdf"]').forEach(el => {
    if (el.data) push(el.data, 'PDF object', 'object');
  });

  // Score and rank
  function score(url, text, source) {
    const l = `${url} ${text} ${source}`.toLowerCase();
    let s = 0;

    // 绝对排除：非文档类型的静态资源
    for (const ext of ['.css','.js','.woff','.ttf','.svg','.png','.jpg','.jpeg','.gif','.ico','.webp','.map','.json','.xml']) {
      if (l.includes(ext) && !l.includes('.pdf')) return -1000;
    }

    // PDF 直接链接
    if (l.includes('stamppdf/getpdf.jsp')) s += 90;
    if (l.includes('stamp/stamp.jsp')) s += 65;
    if (l.includes('pdf.sciencedirectassets.com')) s += 85;
    if (l.includes('/doi/pdfdirect/')) s += 80;
    if (l.includes('/doi/pdf/')) s += 75;
    if (l.includes('/articlepdf/')) s += 70;
    if (l.endsWith('.pdf')) s += 60;
    if (l.includes('.pdf?')||l.includes('&pdf')) s += 45;
    if (l.includes('download=true')) s += 50;   // Wiley/ACS 等
    if (l.includes('download=pdf')||l.includes('type=pdf')) s += 55;
    if (l.includes('/pdf')||l.includes('pdf/')) s += 30;
    if (l.includes('download')) s += 20;
    if (l.includes('citation_pdf_url')) s += 50;
    if (l.includes('fulltext')||l.includes('full-text')) s += 15;
    // 不认识的静态资源
    for (const ext of ['.css','.js','.woff2','.woff','.ttf','.eot','.svg','.png','.jpg','.jpeg','.gif','.ico','.webp','.map','.json','.xml','.html','.htm']) {
      if (l.endsWith(ext) || l.includes(ext+'?')) s -= 100;
    }
    // Penalties for non-PDF content
    for (const n of ['privacy','cookie','terms','supplementary','suppl','cover-image','s0001','s0002','.ris','.bib','.bibtex','.enw','.csv','export-citation','citation-export','download-citation','cite-this','get-rights-and-content','recommended','related-articles','pdf-renderer']) {
      if (l.includes(n)) s -= 50;
    }
    return s;
  }

  const seen = new Set();
  const candidates = [];
  for (const item of out) {
    let url = item.url.trim();
    if (!url) continue;
    try { url = new URL(url, location.href).href; } catch(_) { continue; }
    const s = score(url, item.text, item.source);
    if (s >= 30 && !seen.has(url)) {
      seen.add(url);
      candidates.push({ url, score: s, text: item.text, source: item.source });
    }
  }
  candidates.sort((a,b) => b.score - a.score);
  return {
    url: location.href,
    title: document.title,
    candidates: candidates.slice(0, 5).map(c => c.url),
  };
}

async function checkPagePdfs() {
  $('pageTitle').textContent = t('scanInProgress');
  renderSimpleMessage($('pageList'), [t('scanningCurrentPage')]);

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error(t('noActiveTab'));

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: DETECT_JS,
    });

    const pageData = results?.[0]?.result;
    const list = $('pageList');

    if (pageData?.candidates?.length) {
      $('pageTitle').textContent = t('currentPageCount', { count: pageData.candidates.length });
      const fragment = document.createDocumentFragment();
      for (const url of pageData.candidates) {
        const row = createElement('div', { className: 'page-item' });
        row.appendChild(createElement('span', { text: '⬇', style: 'color:var(--green)' }));
        const label = createElement('span', {
          className: 'name',
          text: url.split('/').pop() || url.slice(0, 50),
          title: url,
        });
        const button = createElement('button', { className: 'btn-sm', text: t('download') });
        button.type = 'button';
        button.addEventListener('click', () => downloadSingle(url));
        row.append(label, button);
        fragment.appendChild(row);
      }
      list.replaceChildren(fragment);
      await chrome.storage.local.set({ _page_pdf_candidates: pageData });
      return;
    }

    $('pageTitle').textContent = t('currentPage');
    const box = renderSimpleMessage(list, [
      t('noPdfDetected'),
      t('pageUrl', { url: pageData?.url || t('unknown') }),
      t('pageTitle', { title: pageData?.title || t('unknown') }),
    ]);
    const retry = createElement('button', {
      id: 'btnRetry', className: 'btn-sm', text: t('retryScan'), style: 'margin-top:6px;',
    });
    retry.type = 'button';
    retry.addEventListener('click', checkPagePdfs);
    box.appendChild(retry);
  } catch (error) {
    const message = error?.message || t('unknown');
    if (message.includes('Cannot access') || message.includes('gallery') ||
        message.includes('cannot be scripted')) {
      $('pageTitle').textContent = t('cannotScan');
      renderSimpleMessage($('pageList'), [
        t('useOnAcademicPage'),
        t('internalPageUnsupported'),
      ]);
      return;
    }
    $('pageTitle').textContent = t('scanFailed');
    renderSimpleMessage($('pageList'), [
      t('scanFailedDetail', { message }),
      t('refreshAndRetry'),
    ], { color: 'var(--red)' });
  }
}

async function downloadAllPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: DETECT_JS,
  });
  const pageData = results?.[0]?.result;
  if (!pageData?.candidates) return;

  // 同一论文页可能暴露多个等价 PDF 候选。只保存第一个验证成功的文件，
  // 避免“下载全部”把同一篇论文重复保存多次。
  let downloaded = false;
  for (const url of pageData.candidates) {
    const ok = await downloadWithVerify(tab.id, url, sanitize(pageData.title || 'paper'));
    if (ok) {
      downloaded = true;
      break;
    }
  }
  $('statusLabel').textContent = downloaded ? t('pdfDownloaded') : t('noValidPdf');
  setTimeout(loadRecentDownloads, 2000);
}

async function downloadSingle(url) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let title = 'paper';
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => document.title,
    });
    title = sanitize(results?.[0]?.result || 'paper');
  } catch(_) {}
  const ok = await downloadWithVerify(tab.id, url, title);
  $('statusLabel').textContent = ok ? t('downloadTriggered') : t('notPdfSkipped');
  setTimeout(loadRecentDownloads, 2000);
}

// 所有真实文件保存统一交给后台 downloads API。
// 网页只负责带登录态验证 PDF，后台负责按“子文件夹/文件名.pdf”落盘。
async function downloadWithVerify(tabId, url, filename) {
  try {
    const result = await chrome.runtime.sendMessage({
      command: 'DOWNLOAD_PAGE_PDF',
      tabId,
      url,
      folder: downloadFolder,
      filename: `${sanitize(filename || 'paper')}.pdf`,
    });
    if (result?.ok) {
      console.log('[Freepaper] PDF downloaded:', result.filename, `(${result.fileSize || 0}B)`);
      return true;
    }
    console.log('[Freepaper] PDF download skipped:', url.slice(0, 80), result?.reason || result?.error);
    return false;
  } catch (error) {
    console.warn('[Freepaper] PDF download failed:', url.slice(0, 80), error.message);
    return false;
  }
}

async function rescanPage() {
  await checkPagePdfs();
}

// =========================================================================
// Panel 2: Batch Download
// =========================================================================

function parseDelimitedLine(line) {
  const cells = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (!quoted && (char === ',' || char === '\t')) {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}


// 解析完整 CSV/TXT，支持引号内逗号、双引号转义和引号内换行。
function parseDelimitedText(text) {
  const rows = [];
  let row = [];
  let current = '';
  let quoted = false;
  const input = String(text || '').replace(/^\uFEFF/, '');

  const pushCell = () => {
    row.push(current.trim());
    current = '';
  };
  const pushRow = () => {
    pushCell();
    if (row.some((cell) => cell !== '')) rows.push(row);
    row = [];
  };

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === '"') {
      if (quoted && input[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (!quoted && (char === ',' || char === '\t')) {
      pushCell();
      continue;
    }
    if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && input[i + 1] === '\n') i++;
      pushRow();
      continue;
    }
    current += char;
  }
  if (current !== '' || row.length > 0) pushRow();
  return rows;
}

function normalizeDoiValue(value) {
  if (!value) return '';
  let doi = String(value).trim()
    .replace(/^doi\s*:\s*/i, '')
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^[\'\"]|[\'\"]$/g, '');
  const match = doi.match(/10\.\d{4,9}\/[^\s\'\"<>]+/i);
  if (match) doi = match[0];
  doi = doi.replace(/[\s,;:]+$/g, '').replace(/\.$/, '');
  // arXiv 的 v1/v2 是同一记录的版本号，不应被当成不同论文。
  doi = doi.replace(/^(10\.48550\/arxiv\.[^\s]+?)v\d+$/i, '$1');
  return /^10\.\d{4,9}\//i.test(doi) ? doi.toLowerCase() : '';
}

function extractDoiFromText(value) {
  if (!value) return '';
  const match = String(value).match(/10\.\d{4,9}\/[^\s\'\"<>]+/i);
  return match ? normalizeDoiValue(match[0]) : '';
}

function normalizeArxivId(value) {
  const text = String(value || '').trim();
  const match = text.match(/(?:arxiv(?:\.org)?[\/:.]|\/(?:abs|pdf)\/)(\d{4}\.\d{4,5}|[a-z-]+\/\d{7})(?:v\d+)?/i);
  return match ? match[1].toLowerCase() : '';
}

function normalizeCandidateUrl(value) {
  if (!value) return '';
  const raw = String(value).trim().replace(/^[\'\"]|[\'\"]$/g, '');
  if (!/^https?:\/\//i.test(raw)) return '';
  try {
    const url = new URL(raw);
    url.hash = '';
    // 仅清理明确的追踪参数；认证、下载和签名参数必须保留。
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|spm$|ref$|source$|campaign$)/i.test(key)) url.searchParams.delete(key);
    }
    return url.href;
  } catch (_) {
    return '';
  }
}

function canonicalDocumentKey(doi, urls) {
  const normalizedDoi = normalizeDoiValue(doi);
  if (normalizedDoi) return `doi:${normalizedDoi}`;
  for (const value of urls || []) {
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase();
      const arxivId = normalizeArxivId(url.href);
      if (arxivId) return `arxiv:${arxivId}`;
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

function scoreInputUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    const full = `${host}${path}${parsed.search.toLowerCase()}`;
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

function choosePreferredInputUrl(urls, doi) {
  const unique = [...new Set((urls || []).filter(Boolean))];
  unique.sort((a, b) => scoreInputUrl(b) - scoreInputUrl(a));
  return unique[0] || (doi ? `https://doi.org/${doi}` : '');
}

function formatParseHint(fileName = '') {
  const prefix = fileName ? `${fileName} · ` : '';
  if (lastParseStats.isDiagnosticTable) {
    const titles = lastParseStats.uniqueTitles > 0
      ? t('titleThemes', { count: lastParseStats.uniqueTitles })
      : '';
    return t('diagnosticHint', {
      prefix, records: lastParseStats.inputRecords, papers: lastParseStats.uniquePapers,
      duplicates: lastParseStats.duplicatesRemoved, titles,
    });
  }
  return lastParseStats.duplicatesRemoved > 0
    ? t('recordsHint', { prefix, records: lastParseStats.inputRecords, papers: lastParseStats.uniquePapers, duplicates: lastParseStats.duplicatesRemoved })
    : t('papersHint', { prefix, papers: lastParseStats.uniquePapers });
}

function parsePaperList(text) {
  if (!text || !text.trim()) {
    lastParseStats = {
      inputRecords: 0, uniquePapers: 0, duplicatesRemoved: 0,
      uniqueTitles: 0, isDiagnosticTable: false,
    };
    return [];
  }

  const groups = new Map();
  let inputRecords = 0;
  let headerMap = null;
  let isDiagnosticTable = false;
  const allTitles = new Set();
  const rows = parseDelimitedText(text);

  for (const cells of rows) {
    if (!cells.some((cell) => String(cell).trim())) continue;
    const normalizedCells = cells.map((cell) => cell.trim().replace(/^\uFEFF/, '').toLowerCase());
    const looksLikeHeader = normalizedCells.includes('doi') && normalizedCells.includes('url');
    if (looksLikeHeader) {
      headerMap = Object.fromEntries(normalizedCells.map((name, index) => [name, index]));
      isDiagnosticTable = normalizedCells.includes('case_id') ||
        normalizedCells.includes('expected_result') || normalizedCells.includes('test_purpose');
      continue;
    }

    const getColumn = (name) => {
      const index = headerMap?.[name];
      return Number.isInteger(index) ? String(cells[index] || '').trim() : '';
    };

    let doi = normalizeDoiValue(getColumn('doi'));
    const urls = [];
    const explicitUrl = normalizeCandidateUrl(getColumn('url'));
    if (explicitUrl) urls.push(explicitUrl);

    // 对没有标准表头的粘贴文本保持兼容：扫描整行 DOI 和 URL。
    for (const cell of cells) {
      if (!doi) doi = extractDoiFromText(cell);
      const url = normalizeCandidateUrl(cell);
      if (url && !urls.includes(url)) urls.push(url);
    }

    if (!doi) {
      for (const url of urls) {
        const arxivId = normalizeArxivId(url);
        if (arxivId) {
          doi = `10.48550/arxiv.${arxivId}`.toLowerCase();
          break;
        }
      }
    }

    if (!doi && urls.length === 0) continue;
    inputRecords++;
    const title = getColumn('title');
    if (title) allTitles.add(title.trim().toLowerCase());
    const key = canonicalDocumentKey(doi, urls);
    if (!key) continue;

    let group = groups.get(key);
    if (!group) {
      group = {
        doi: doi || urls[0],
        title: title || '',
        candidateUrls: [],
        sourceCount: 0,
        status: 'pending',
        caseIds: [],
        urlTypes: [],
        expectedResults: [],
      };
      groups.set(key, group);
    }
    if (!group.title && title) group.title = title;
    group.sourceCount += 1;
    for (const url of urls) {
      if (!group.candidateUrls.includes(url)) group.candidateUrls.push(url);
    }
    const caseId = getColumn('case_id');
    const urlType = getColumn('url_type');
    const expectedResult = getColumn('expected_result');
    if (caseId && !group.caseIds.includes(caseId)) group.caseIds.push(caseId);
    if (urlType && !group.urlTypes.includes(urlType)) group.urlTypes.push(urlType);
    if (expectedResult && !group.expectedResults.includes(expectedResult)) group.expectedResults.push(expectedResult);
  }

  const papers = [...groups.values()].map((group) => ({
    ...group,
    url: choosePreferredInputUrl(group.candidateUrls, normalizeDoiValue(group.doi)),
    duplicateCount: Math.max(0, group.sourceCount - 1),
  }));
  lastParseStats = {
    inputRecords,
    uniquePapers: papers.length,
    duplicatesRemoved: Math.max(0, inputRecords - papers.length),
    uniqueTitles: allTitles.size,
    isDiagnosticTable,
  };
  return papers;
}

function renderBatchList() {
  const list = $('paperList');
  list.replaceChildren();
  if (batchPapers.length === 0) return;

  const fragment = document.createDocumentFragment();
  batchPapers.forEach((paper, index) => {
    const row = createElement('div', { className: 'paper-item' });
    row.appendChild(createElement('span', { className: 'idx', text: index + 1 }));
    const identifier = paper.doi || paper.url || t('unknownPaper');
    row.appendChild(createElement('span', { className: 'doi', text: identifier, title: identifier }));

    let tag = '';
    let tagClass = '';
    if (paper.status === 'done') { tag = t('completed'); tagClass = 'tag-done'; }
    else if (paper.status === 'needs_login') { tag = t('loginRequired'); tagClass = 'tag-login'; }
    else if (paper.status === 'failed') { tag = t('failed'); tagClass = 'tag-fail'; }
    else if (paper.status === 'downloading') { tag = t('downloading'); }
    if (tag) row.appendChild(createElement('span', { className: `tag ${tagClass}`.trim(), text: tag }));
    fragment.appendChild(row);
  });
  list.appendChild(fragment);
}

async function handleFileLoad(e) {
  const file = e.target.files[0];
  if (!file) return;
  $('fileHint').textContent = t('loading');

  try {
    const text = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsText(file);
    });

    cleanupCompletionUI();
    $('batchText').value = text;
    batchPapers = parsePaperList(text);
    renderBatchList();
    $('fileHint').textContent = formatParseHint(file.name);
  } catch (err) {
    $('fileHint').textContent = t('readFailed', { message: err.message });
  }
}

// Live parse as user types in textarea
$('batchText').addEventListener('input', () => {
  cleanupCompletionUI();
  batchPapers = parsePaperList($('batchText').value);
  renderBatchList();
  if ($('batchText').value.trim()) {
    $('fileHint').textContent = formatParseHint();
  }
});

function clearBatch() {
  if (isBatchRunning) {
    alert(t('stopRunningFirst'));
    return;
  }
  batchPapers = [];
  $('batchText').value = '';
  $('fileInput').value = '';
  $('fileHint').textContent = '';
  renderBatchList();
  cleanupCompletionUI();
  // 同步清除 storage 中的批量任务状态
  chrome.storage.local.remove('batch_state');
  chrome.runtime.sendMessage({ command: 'BATCH_STOP' });
}

// 清理上次完成留下的汇总表、导出按钮等
function cleanupCompletionUI() {
  $('summaryTable')?.remove();
  $('exportArea')?.remove();
  $('btnRetryFailed')?.remove();
  $('btnExportCsv')?.remove();
  $('progressSection').classList.remove('visible');
  $('btnStopAll').style.display = 'none';
  $('statusDot').className = 'status-dot';
  $('statusLabel').textContent = t('ready');
  isBatchRunning = false;
  $('btnStartBatch').textContent = t('startBatch');
}

async function startBatch() {
  // Parse if not already parsed
  if (batchPapers.length === 0) {
    batchPapers = parsePaperList($('batchText').value);
  }
  if (batchPapers.length === 0) {
    alert(t('pasteOrLoadFirst'));
    return;
  }

  if (isBatchRunning) {
    const result = await chrome.runtime.sendMessage({ command: 'batch_stop' });
    isBatchRunning = false;
    if (result?.state) renderBatchProgress(result.state);
    return;
  }

  isBatchRunning = true;
  $('btnStartBatch').textContent = t('stopBatch');
  $('progressSection').classList.add('visible');
  renderBatchList();

  const response = await chrome.runtime.sendMessage({
    command: 'batch_start',
    papers: batchPapers,
    folder: downloadFolder,
  });
  if (!response?.ok) {
    isBatchRunning = false;
    $('btnStartBatch').textContent = t('startBatch');
    $('statusLabel').textContent = response?.reason === 'batch_already_running'
      ? t('batchAlreadyRunning')
      : t('startFailed', { message: response?.error || response?.reason || t('unknown') });
  } else if (response.state) {
    renderBatchProgress(response.state);
  }
}

function renderBatchProgress(state) {
  if (!state) return;
  isBatchRunning = Boolean(state.running);
  batchPapers = state.papers || [];
  renderBatchList();

  if (state.running) {
    const processed = (state.papers || []).filter((paper) =>
      ['done', 'failed', 'needs_login'].includes(paper.status)).length;
    $('statusDot').className = state.paused ? 'status-dot' : 'status-dot working';
    $('statusLabel').textContent = state.paused
      ? t('batchPausedAt', { processed, total: state.total })
      : t('batchRunningProgress', { current: Math.min(state.current || 0, state.total), total: state.total });
    $('progressCount').textContent = `${processed}/${state.total}`;
    $('progressFill').style.width = state.total > 0 ? `${Math.round(processed/state.total*100)}%` : '0%';
    $('progressLabel').textContent = t('batchResultLine', { done: state.done, failed: state.failed, paused: state.paused ? t('continueFromControl') : '' });
    $('progressSection').classList.add('visible');
    $('btnStopAll').style.display = 'block';
    $('btnStartBatch').textContent = t('stopBatch');
  } else {
    $('btnStopAll').style.display = 'none';
    if (state.stopReason && (state.nextIndex ?? state.current ?? 0) < state.total) {
      $('statusDot').className = 'status-dot';
      $('statusLabel').textContent = t('stoppedWithReason', { reason: state.stopReason });
      $('progressCount').textContent = `${state.done || 0}/${state.total}`;
      $('progressFill').style.width = state.total > 0 ? `${Math.round((state.done || 0)/state.total*100)}%` : '0%';
      $('progressLabel').textContent = t('stoppedSummary', { done: state.done || 0, failed: state.failed || 0 });
      $('progressSection').classList.add('visible');
      $('btnStartBatch').textContent = t('startBatch');
      return;
    }
    // 完成——显示汇总表
    const statuses = { done: [], failed: [], needs_login: [] };
    for (const p of batchPapers) {
      if (p.status === 'done') statuses.done.push(p);
      else if (p.status === 'needs_login') statuses.needs_login.push(p);
      else statuses.failed.push(p);
    }
    const done = statuses.done.length;
    const failed = statuses.failed.length;
    const needsLogin = statuses.needs_login.length;

    $('statusDot').className = 'status-dot';
    $('statusLabel').textContent = t('completionStatus', { done, failed, login: needsLogin });
    $('progressCount').textContent = `${done}/${state.total}`;
    $('progressFill').style.width = state.total > 0 ? `${Math.round(done/state.total*100)}%` : '0%';
    $('progressLabel').textContent = t('completionStats', { done, failed, login: needsLogin });
    $('progressSection').classList.add('visible');
    $('btnStartBatch').textContent = t('startBatch');
    isBatchRunning = false;

    // 显示汇总表
    showSummaryTable(statuses, state.total);

    // 按钮：导出 + 重试
    if (failed > 0 || needsLogin > 0) {
      if (!$('btnRetryFailed')) {
        const btn = document.createElement('button');
        btn.id = 'btnRetryFailed';
        btn.className = 'btn btn-primary';
        btn.textContent = t('retryFailed', { count: failed + needsLogin });
        btn.style.marginTop = '6px';
        btn.addEventListener('click', retryFailed);
        $('paperList').after(btn);
      } else {
        $('btnRetryFailed').textContent = t('retryFailed', { count: failed + needsLogin });
      }
    }

    // 导出报告区域
    if (!$('exportArea')) {
      const area = document.createElement('div');
      area.id = 'exportArea';
      area.className = 'export-area';
      area.innerHTML = `
        <div class="title">${t('downloadComplete')}</div>
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px;">
          ${t('completionSummary', { total: state.total, done, failed, login: needsLogin })}
        </div>
        <button class="btn btn-primary" style="width:100%;margin-bottom:4px;" id="btnExportCsvAction">
          ${t('exportCsv')}
        </button>
      `;
      let insertAfter = $('btnRetryFailed') || $('paperList');
      insertAfter.after(area);
      $('btnExportCsvAction').addEventListener('click', exportSummaryCsv);
    } else {
      // 更新已有区域
      $('exportArea').querySelector('div:last-child').textContent =
        `${t('completionSummary', { total: state.total, done, failed, login: needsLogin })}`;
    }
  }
}

function showSummaryTable(statuses) {
  let container = $('summaryTable');
  if (!container) {
    container = document.createElement('div');
    container.id = 'summaryTable';
    container.style.cssText = 'padding:8px 14px;background:white;font-size:11px;max-height:150px;overflow-y:auto;';
    $('paperList').after(container);
  }
  container.replaceChildren();

  const appendGroup = (title, papers, titleStyle, itemColor) => {
    if (!papers.length) return;
    container.appendChild(createElement('div', {
      text: `${title} (${papers.length})`,
      style: `${titleStyle};font-weight:600;margin:6px 0 2px;`,
    }));
    for (const paper of papers) {
      const identifier = paper.doi || paper.url || t('unknownPaper');
      container.appendChild(createElement('div', {
        text: identifier,
        title: identifier,
        style: `color:${itemColor};padding-left:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;`,
      }));
    }
  };

  appendGroup(t('groupSuccess'), statuses.done, 'color:var(--green);margin-top:0', 'var(--text)');
  appendGroup(t('groupLogin'), statuses.needs_login, 'color:#b45309', 'var(--text-muted)');
  appendGroup(t('groupFailed'), statuses.failed, 'color:var(--red)', 'var(--text-muted)');
}

function exportSummaryCsv() {
  const header = [
    'status', 'doi', 'title', 'selected_url', 'filename', 'source_count',
    'duplicates_merged', 'case_ids', 'url_types', 'expected_results', 'candidate_urls', 'error',
  ];
  const rows = [header.map(csvCell).join(',')];
  for (const paper of batchPapers) {
    const status = paper.status === 'done'
      ? 'success'
      : paper.status === 'needs_login' ? 'needs_login' : 'failed';
    const values = [
      status,
      paper.doi || '',
      paper.title || '',
      paper.url || '',
      paper.filename || '',
      String(paper.sourceCount || 1),
      String(paper.duplicateCount || 0),
      Array.isArray(paper.caseIds) ? paper.caseIds.join(' | ') : '',
      Array.isArray(paper.urlTypes) ? paper.urlTypes.join(' | ') : '',
      Array.isArray(paper.expectedResults) ? paper.expectedResults.join(' | ') : '',
      Array.isArray(paper.candidateUrls) ? paper.candidateUrls.join(' | ') : '',
      paper.error || '',
    ];
    rows.push(values.map(csvCell).join(','));
  }
  const csv = '\ufeff' + rows.join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({
    url,
    filename: `freepaper_summary_${new Date().toISOString().slice(0, 10)}.csv`,
    conflictAction: 'uniquify',
    saveAs: true,
  }).finally(() => setTimeout(() => URL.revokeObjectURL(url), 60000));
}

async function retryFailed() {
  const failedCount = batchPapers.filter((paper) =>
    paper.status === 'failed' || paper.status === 'needs_login').length;
  if (failedCount === 0) return;

  const button = $('btnRetryFailed');
  if (button) {
    button.disabled = true;
    button.textContent = t('buildingRetry', { count: failedCount });
  }

  const response = await chrome.runtime.sendMessage({
    command: 'BATCH_RETRY_FAILED',
    folder: downloadFolder,
  }).catch((error) => ({ ok: false, error: error.message }));

  if (!response?.ok) {
    if (button) {
      button.disabled = false;
      button.textContent = t('retryFailed', { count: failedCount });
    }
    $('statusLabel').textContent = response?.reason === 'batch_already_running'
      ? t('batchAlreadyRunning')
      : t('retryStartFailed', { message: response?.error || response?.reason || t('unknown') });
    return;
  }

  $('btnRetryFailed')?.remove();
  cleanupCompletionUI();
  isBatchRunning = true;
  if (response.state) {
    batchPapers = response.state.papers || [];
    renderBatchProgress(response.state);
    $('statusLabel').textContent = t('retryOnly', { count: response.state.total });
  }
}

// =========================================================================
// Recent Downloads
// =========================================================================

async function loadRecentDownloads() {
  try {
    const data = await chrome.storage.local.get('freepaper_recent_downloads');
    const stored = Array.isArray(data.freepaper_recent_downloads)
      ? data.freepaper_recent_downloads
      : [];
    const recent = stored
      .filter((item) => item?.filename && item.filename.toLowerCase().endsWith('.pdf'))
      .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))
      .slice(0, 8);

    const section = $('recentSection');
    const list = $('recentList');
    list.replaceChildren();
    if (!recent.length) {
      section.style.display = 'none';
      return;
    }

    section.style.display = 'block';
    const fragment = document.createDocumentFragment();
    for (const item of recent) {
      const parts = item.filename.replace(/\\/g, '/').split('/');
      const name = parts.pop() || '?';
      const folder = parts.pop() || '';
      const row = createElement('div', { className: 'recent-item' });
      row.appendChild(createElement('span', { text: '✅' }));
      row.appendChild(createElement('span', { className: 'name', text: name, title: item.filename }));
      if (folder) {
        row.appendChild(createElement('span', {
          text: folder,
          style: 'font-size:9px;color:var(--accent);background:#f0edff;padding:1px 4px;border-radius:3px;flex-shrink:0;',
        }));
      }
      const timeValue = item.endTime || item.startTime || item.timestamp;
      row.appendChild(createElement('span', { className: 'time', text: formatTime(timeValue) }));
      fragment.appendChild(row);
    }
    list.appendChild(fragment);
  } catch (_) {
    $('recentSection').style.display = 'none';
  }
}

function formatTime(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return t('justNow');
  if (diff < 3600000) return t('minutesAgo', { count: Math.floor(diff / 60000) });
  return new Date(iso).toLocaleTimeString(FreepaperI18n.localeTag(), { hour:'2-digit', minute:'2-digit' });
}

// =========================================================================
// Settings
// =========================================================================

function ensureEnhancedSettingsControl() {
  const panel = $('settingsPanel');
  if (!panel || $('autoOpenTaskMonitorOnChallenge')) return;
  const row = document.createElement('label');
  row.style.cssText = [
    'display:flex', 'align-items:center', 'gap:10px', 'margin:10px 0',
    'padding:12px 10px', 'border:1px solid #e2e8f0', 'border-radius:9px',
    'background:#f8fafc', 'font-size:12px', 'line-height:1.5', 'cursor:pointer',
  ].join(';');
  row.innerHTML = `
    <input id="autoOpenTaskMonitorOnChallenge" type="checkbox" style="width:18px;height:18px;flex-shrink:0;accent-color:#2563eb;cursor:pointer;">
    <span style="flex:1;"><strong data-i18n="autoMonitorTitle">${t('autoMonitorTitle')}</strong><br><span style="color:#64748b;font-size:10px;" data-i18n="autoMonitorHint">${t('autoMonitorHint')}</span></span>`;
  const options = $('settingsOptions');
  if (options) options.appendChild(row);
  else panel.appendChild(row);
  $('autoOpenTaskMonitorOnChallenge').checked = autoOpenTaskMonitorOnChallenge;
}

function setSettingsOpen(open) {
  showSettings = Boolean(open);
  const panel = $('settingsPanel');
  const button = $('btnSettings');

  // 先清除历史内联 display，避免关闭设置后两个业务面板同时出现。
  document.querySelectorAll('.panel').forEach((item) => item.style.removeProperty('display'));

  panel?.classList.toggle('visible', showSettings);
  panel?.setAttribute('aria-hidden', String(!showSettings));
  document.body.classList.toggle('settings-open', showSettings);
  button?.classList.toggle('active', showSettings);
  if (button) {
    button.textContent = showSettings ? '×' : '⚙';
    button.title = showSettings ? t('closeSettings') : t('settings');
    button.setAttribute('aria-label', showSettings ? t('closeSettings') : t('openSettings'));
    button.setAttribute('aria-expanded', String(showSettings));
  }

  if (showSettings) {
    if ($('languageSelect')) $('languageSelect').value = FreepaperI18n.getLanguageMode();
    const checkbox = $('autoOpenTaskMonitorOnChallenge');
    if (checkbox) checkbox.checked = autoOpenTaskMonitorOnChallenge;
    requestAnimationFrame(() => $('downloadFolder')?.focus());
  }
}

function toggleSettings() {
  setSettingsOpen(!showSettings);
}

function normalizeDownloadFolder(value) {
  let folder = String(value || '').trim().replace(/\\/g, '/');
  folder = folder
    .replace(/^\/+/, '')
    .replace(/[<>:"|?*\x00-\x1F]/g, '_')
    .replace(/\/{2,}/g, '/');
  folder = folder
    .split('/')
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .join('/');
  return folder.slice(0, 120) || 'freepaper';
}

async function saveSettings() {
  downloadFolder = normalizeDownloadFolder($('downloadFolder')?.value);
  if ($('downloadFolder')) $('downloadFolder').value = downloadFolder;
  autoOpenTaskMonitorOnChallenge = $('autoOpenTaskMonitorOnChallenge')?.checked === true;
  const language = $('languageSelect')?.value || 'auto';
  const current = await chrome.storage.local.get('freepaper_settings');
  const nextSettings = {
    ...(current.freepaper_settings || {}),
    downloadFolder,
    autoOpenTaskMonitorOnChallenge,
    language,
  };
  await chrome.storage.local.set({ freepaper_settings: nextSettings });
  await FreepaperI18n.setLanguage(language);
  FreepaperI18n.applyDocument(document);
  if ($('footerText')) $('footerText').textContent = t('footerPath', { folder: downloadFolder });
  renderBatchList();
  if (latestTaskSnapshot.batch?.papers?.length) renderBatchProgress(latestTaskSnapshot.batch);
  renderGlobalTaskControl(latestTaskSnapshot.batch, latestTaskSnapshot.sd, latestTaskSnapshot.monitorOpen);
  ensureGlobalTaskControl();
  setSettingsOpen(false);
  chrome.runtime.sendMessage({ command: 'settings_updated', settings: nextSettings }).catch(() => null);
}

function sanitize(s) {
  return (s || 'paper').replace(/[<>:"/\\|?*]/g, '_').slice(0, 80);
}
