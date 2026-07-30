/* This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. */
'use strict';

const $ = (id) => document.getElementById(id);
const t = (key, vars = {}) => FreepaperI18n.t(key, vars);
let lastStamp = '';

const MANUAL_STATUSES = new Set([
  'WAITING_CHALLENGE_1', 'WAITING_CHALLENGE_2', 'WAITING_MANUAL_PDF', 'ACCESS_DENIED',
]);

function render(snapshot, force = false) {
  const batch = snapshot?.batch || null;
  const sd = snapshot?.sd || null;
  const stamp = `${batch?.updatedAt || 0}:${sd?.updatedAt || 0}:${FreepaperI18n.getLocale()}`;
  if (!force && stamp === lastStamp) return;
  lastStamp = stamp;

  $('sdMessage').textContent = sd ? FreepaperI18n.status(sd.status) : t('noManualPaper');
  $('sdDoi').textContent = sd?.doi || '';
  const batchPaused = Boolean(batch?.running && batch?.paused);
  $('phaseBadge').textContent = sd?.status === 'WAITING_CHALLENGE_2'
    ? t('phaseChallenge2')
    : (sd?.status === 'WAITING_CHALLENGE_1'
      ? t('phaseChallenge1')
      : (batchPaused ? t('batchPaused') : (batch?.running ? t('batchRunning') : t('auxiliaryMonitor'))));

  const terminal = !sd || ['DONE', 'FAILED', 'STOPPED'].includes(sd.status);
  const manual = Boolean(sd && MANUAL_STATUSES.has(sd.status));
  $('btnContinue').disabled = !manual;
  $('btnContinue').style.display = manual ? 'block' : 'none';
  $('btnSkip').disabled = terminal;
  const hasTaskTab = [sd?.activeTabId, sd?.pdfTabId, sd?.articleTabId, batch?.activeTabId].some(Number.isInteger);
  $('btnFocus').disabled = !hasTaskTab;
  $('btnPause').disabled = !batch?.running;
  $('btnPause').textContent = batchPaused ? t('resumeBatch') : t('pauseBatch');
  $('btnStop').disabled = !batch?.running && terminal;

  if (batch?.papers?.length) {
    const total = batch.total || batch.papers.length;
    const done = batch.done || 0;
    const failed = batch.failed || 0;
    const processed = batch.papers.filter((paper) => ['done', 'failed', 'needs_login'].includes(paper.status)).length;
    $('batchTitle').textContent = batch.running
      ? (batch.paused
        ? (Number.isInteger(batch.activeIndex) && batch.activeIndex >= 0 ? t('currentFinishesThenPause') : t('batchPaused'))
        : t('batchRunning'))
      : t('batchEnded');
    $('progressFill').style.width = total ? `${Math.round(processed / total * 100)}%` : '0%';
    $('batchStats').textContent = t('stats', { processed, total, done, failed });
    const index = Number.isInteger(batch.activeIndex) && batch.activeIndex >= 0
      ? batch.activeIndex
      : Math.min(batch.nextIndex || 0, Math.max(total - 1, 0));
    const paper = batch.papers[index];
    if (paper) {
      $('currentPaper').style.display = 'block';
      $('currentPaper').textContent = t('currentItem', {
        index: index + 1,
        total,
        paper: paper.doi || paper.url || t('unknownPaper'),
        status: FreepaperI18n.paperStatus(paper.status || 'pending'),
      });
    } else {
      $('currentPaper').style.display = 'none';
    }
  } else {
    $('batchTitle').textContent = t('noBatchTask');
    $('progressFill').style.width = '0%';
    $('batchStats').textContent = '0 / 0';
    $('currentPaper').style.display = 'none';
  }
}

async function sync(force = false) {
  try {
    const snapshot = await chrome.runtime.sendMessage({ type: 'GET_TASK_SNAPSHOT' });
    if (snapshot?.ok) render(snapshot, force);
  } catch (_) {
    const stored = await chrome.storage.local.get(['batch_state', 'sd_state']);
    render({ batch: stored.batch_state || null, sd: stored.sd_state || null }, force);
  }
}

async function init() {
  await FreepaperI18n.init();
  FreepaperI18n.applyDocument(document);

  $('btnContinue').addEventListener('click', async () => {
    $('btnContinue').disabled = true;
    $('btnContinue').textContent = t('waitingStable');
    await chrome.runtime.sendMessage({ type: 'SD_CONTINUE' }).catch(() => null);
    $('btnContinue').textContent = t('continueChecking');
    await sync(true);
  });
  $('btnFocus').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'FOCUS_TASK_TAB' }).catch(() => null);
  });
  $('btnPause').addEventListener('click', async () => {
    const snapshot = await chrome.runtime.sendMessage({ type: 'GET_TASK_SNAPSHOT' }).catch(() => null);
    const paused = snapshot?.batch?.paused === true;
    await chrome.runtime.sendMessage({ type: paused ? 'BATCH_RESUME' : 'BATCH_PAUSE' }).catch(() => null);
    await sync(true);
  });
  $('btnSkip').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'SD_SKIP' }).catch(() => null);
    await sync(true);
  });
  $('btnStop').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'BATCH_STOP' }).catch(() => null);
    await sync(true);
  });

  void chrome.runtime.sendMessage({ type: 'TASK_MONITOR_READY' }).catch(() => null);
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes.freepaper_settings) {
      void FreepaperI18n.init(true).then(() => {
        FreepaperI18n.applyDocument(document);
        lastStamp = '';
        void sync(true);
      });
      return;
    }
    if (changes.batch_state || changes.sd_state || changes.sd_notification) void sync();
  });
  setInterval(() => void sync(), 1000);
  await sync(true);
}

void init();
