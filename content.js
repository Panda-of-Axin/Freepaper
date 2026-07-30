/* This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
 * If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// content.js — Freepaper 页面浮层
// document_start 即启动；每个新 document 主动向后台拉取状态。
// 页面浮层是当前页面助手；扩展 popup 是最高级总控台，task-monitor.html 是持续监控辅助窗。
'use strict';

const t = (key, vars = {}) => FreepaperI18n.t(key, vars);
const OVERLAY_ID = 'freepaper-overlay-host';
const OVERLAY_POSITION_KEY = 'freepaper_overlay_position';
let desiredOverlay = null;
let healthTimer = null;
let rootObserver = null;
let domObserver = null;
let syncInFlight = false;
let overlayPosition = null;
let overlayRenderKey = '';
let dragState = null;


function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function validOverlayPosition(value) {
  return value && Number.isFinite(value.left) && Number.isFinite(value.top);
}

function applyOverlayPosition(host, persistAdjusted = false) {
  if (!host) return;
  if (!validOverlayPosition(overlayPosition)) {
    host.style.left = 'auto';
    host.style.top = '20px';
    host.style.right = '20px';
    return;
  }
  const rect = host.getBoundingClientRect();
  const maxLeft = Math.max(8, window.innerWidth - Math.max(rect.width, 338) - 8);
  const maxTop = Math.max(8, window.innerHeight - Math.max(rect.height, 120) - 8);
  const adjusted = {
    left: Math.round(clamp(overlayPosition.left, 8, maxLeft)),
    top: Math.round(clamp(overlayPosition.top, 8, maxTop)),
  };
  host.style.left = `${adjusted.left}px`;
  host.style.top = `${adjusted.top}px`;
  host.style.right = 'auto';
  if (persistAdjusted && (adjusted.left !== overlayPosition.left || adjusted.top !== overlayPosition.top)) {
    overlayPosition = adjusted;
    void chrome.storage.local.set({ [OVERLAY_POSITION_KEY]: adjusted });
  }
}

async function loadOverlayPosition() {
  try {
    const data = await chrome.storage.local.get(OVERLAY_POSITION_KEY);
    overlayPosition = validOverlayPosition(data[OVERLAY_POSITION_KEY])
      ? data[OVERLAY_POSITION_KEY]
      : null;
    applyOverlayPosition(document.getElementById(OVERLAY_ID), true);
  } catch (_) {}
}

function installOverlayDragging(host) {
  const handle = host?.shadowRoot?.getElementById('fp-drag-handle');
  if (!handle) return;

  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const rect = host.getBoundingClientRect();
    host.style.left = `${rect.left}px`;
    host.style.top = `${rect.top}px`;
    host.style.right = 'auto';
    dragState = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };
    handle.setPointerCapture?.(event.pointerId);
    handle.classList.add('dragging');
    event.preventDefault();
  });

  handle.addEventListener('pointermove', (event) => {
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    const rect = host.getBoundingClientRect();
    const left = clamp(event.clientX - dragState.offsetX, 8, Math.max(8, window.innerWidth - rect.width - 8));
    const top = clamp(event.clientY - dragState.offsetY, 8, Math.max(8, window.innerHeight - rect.height - 8));
    host.style.left = `${Math.round(left)}px`;
    host.style.top = `${Math.round(top)}px`;
    event.preventDefault();
  });

  const finishDrag = (event) => {
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    const rect = host.getBoundingClientRect();
    overlayPosition = { left: Math.round(rect.left), top: Math.round(rect.top) };
    dragState = null;
    handle.classList.remove('dragging');
    try { handle.releasePointerCapture?.(event.pointerId); } catch (_) {}
    void chrome.storage.local.set({ [OVERLAY_POSITION_KEY]: overlayPosition });
  };
  handle.addEventListener('pointerup', finishDrag);
  handle.addEventListener('pointercancel', finishDrag);
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

function getRoot() {
  return document.documentElement || document.body || null;
}

function removeOverlay() {
  document.getElementById(OVERLAY_ID)?.remove();
  overlayRenderKey = '';
  dragState = null;
}

function phaseLabel(payload) {
  if (payload?.status === 'WAITING_CHALLENGE_2' || payload?.phase === 2) return t('phaseChallenge2');
  if (payload?.status === 'WAITING_CHALLENGE_1') return t('phaseChallenge1');
  if (payload?.status === 'WAITING_MANUAL_PDF') return t('phaseManual');
  if (payload?.status === 'ACCESS_DENIED') return t('phaseAccess');
  return t('phaseAction');
}

function overlayMessage(payload) {
  return payload?.status ? FreepaperI18n.status(payload.status) : (payload?.message || t('overlayDefaultMessage'));
}

function ensureRootThenRender() {
  const root = getRoot();
  if (root) {
    if (rootObserver) {
      rootObserver.disconnect();
      rootObserver = null;
    }
    renderOverlay(desiredOverlay);
    return;
  }
  if (!rootObserver) {
    rootObserver = new MutationObserver(() => {
      if (getRoot()) ensureRootThenRender();
    });
    rootObserver.observe(document, { childList: true, subtree: true });
  }
}

function renderOverlay(payload) {
  desiredOverlay = payload || null;
  if (!desiredOverlay) {
    removeOverlay();
    stopHealthCheck();
    return;
  }

  const nextRenderKey = JSON.stringify({
    taskId: desiredOverlay.taskId || '',
    status: desiredOverlay.status || '',
    message: desiredOverlay.message || '',
    doi: desiredOverlay.doi || '',
    updatedAt: desiredOverlay.updatedAt || 0,
  });
  const existingHost = document.getElementById(OVERLAY_ID);
  if (existingHost && overlayRenderKey === nextRenderKey) {
    applyOverlayPosition(existingHost, true);
    startHealthCheck();
    return;
  }

  const root = getRoot();
  if (!root) {
    ensureRootThenRender();
    return;
  }

  let host = document.getElementById(OVERLAY_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = OVERLAY_ID;
    host.style.cssText = [
      'all:initial', 'position:fixed', 'top:20px', 'right:20px',
      'z-index:2147483647', 'display:block', 'pointer-events:auto',
      'contain:layout style paint',
    ].join(';');
    host.attachShadow({ mode: 'open' });
    root.appendChild(host);
  }
  applyOverlayPosition(host, true);

  host.shadowRoot.innerHTML = `
    <style>
      :host { all: initial; }
      .panel { box-sizing:border-box;width:338px;padding:16px;border:1px solid rgba(37,99,235,.18);
        border-radius:14px;background:#fff;color:#1e293b;box-shadow:0 14px 40px rgba(15,23,42,.30);
        font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif; }
      .head { display:flex;align-items:center;justify-content:space-between;gap:8px;margin:-4px -4px 8px;padding:4px;
        border-radius:9px;cursor:grab;user-select:none;touch-action:none; }
      .head:hover { background:#f8fafc; }
      .head.dragging { cursor:grabbing;background:#eef2ff; }
      .headLeft { display:flex;align-items:center;gap:7px;min-width:0; }
      .dragMark { color:#94a3b8;font-size:15px;line-height:1;letter-spacing:-2px; }
      .title { font-size:15px;font-weight:750; }
      .phase { border-radius:999px;background:#eff6ff;color:#1d4ed8;padding:3px 7px;font-size:10px;font-weight:650; }
      .doi { overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#64748b;font-size:10px;margin-bottom:8px; }
      .msg { font-size:13px;line-height:1.65;margin-bottom:13px;white-space:pre-wrap; }
      .hint { font-size:10px;line-height:1.5;color:#64748b;margin:-5px 0 11px; }
      .actions { display:grid;grid-template-columns:1fr 1fr;gap:8px; }
      button { box-sizing:border-box;border:0;border-radius:8px;padding:9px 11px;cursor:pointer;font-size:12px;font-weight:650; }
      button:disabled { opacity:.65;cursor:wait; }
      .primary { grid-column:1 / -1;background:#2563eb;color:#fff; }
      .secondary { background:#e2e8f0;color:#1e293b; }
      .danger { background:#fee2e2;color:#b91c1c; }
    </style>
    <div class="panel" role="dialog" aria-label="Freepaper page verification assistant">
      <div class="head" id="fp-drag-handle" title="${t('dragToMove')}">
        <div class="headLeft"><span class="dragMark">⠿</span><div class="title">${t('overlayTitle')}</div></div>
        <div class="phase">${phaseLabel(payload)}</div>
      </div>
      ${payload.doi ? `<div class="doi" title="${escapeHtml(payload.doi)}">${escapeHtml(payload.doi)}</div>` : ''}
      <div class="msg">${escapeHtml(overlayMessage(payload))}</div>
      <div class="hint">${t('overlayHint')}</div>
      <div class="actions">
        <button class="primary" id="fp-continue">${t('continueChecking')}</button>
        <button class="secondary" id="fp-skip">${t('skipPaper')}</button>
        <button class="danger" id="fp-stop">${t('stopAll')}</button>
      </div>
    </div>`;

  overlayRenderKey = nextRenderKey;
  installOverlayDragging(host);
  requestAnimationFrame(() => applyOverlayPosition(host, true));

  host.shadowRoot.getElementById('fp-continue').addEventListener('click', async () => {
    const button = host.shadowRoot.getElementById('fp-continue');
    button.disabled = true;
    button.textContent = t('waitingStable');
    await chrome.runtime.sendMessage({ type: 'SD_CONTINUE' }).catch(() => null);
    setTimeout(() => void syncOverlay(), 300);
  });
  host.shadowRoot.getElementById('fp-skip').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'SD_SKIP' }).catch(() => null);
    await syncOverlay();
  });
  host.shadowRoot.getElementById('fp-stop').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'BATCH_STOP' }).catch(() => null);
    await syncOverlay();
  });

  startHealthCheck();
}

async function syncOverlay() {
  if (syncInFlight) return;
  syncInFlight = true;
  try {
    const state = await chrome.runtime.sendMessage({ type: 'OVERLAY_SYNC_REQUEST' });
    if (state?.show && state.payload) renderOverlay(state.payload);
    else renderOverlay(null);
  } catch (_) {
    // 扩展更新、Service Worker 唤醒或当前 document 即将被替换时可能短暂断开。
  } finally {
    syncInFlight = false;
  }
}

function startHealthCheck() {
  if (!domObserver) {
    domObserver = new MutationObserver(() => {
      if (desiredOverlay && !document.getElementById(OVERLAY_ID)) ensureRootThenRender();
    });
    domObserver.observe(document, { childList: true, subtree: true });
  }
  if (!healthTimer) {
    healthTimer = setInterval(() => {
      if (desiredOverlay && !document.getElementById(OVERLAY_ID)) ensureRootThenRender();
      void syncOverlay();
    }, 1200);
  }
}

function stopHealthCheck() {
  if (healthTimer) {
    clearInterval(healthTimer);
    healthTimer = null;
  }
  if (domObserver) {
    domObserver.disconnect();
    domObserver = null;
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'SHOW_OVERLAY') {
    renderOverlay(msg.payload);
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === 'HIDE_OVERLAY') {
    renderOverlay(null);
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (changes[OVERLAY_POSITION_KEY]) {
    overlayPosition = validOverlayPosition(changes[OVERLAY_POSITION_KEY].newValue)
      ? changes[OVERLAY_POSITION_KEY].newValue
      : null;
    applyOverlayPosition(document.getElementById(OVERLAY_ID), true);
  }
  if (changes.freepaper_settings) {
    void FreepaperI18n.init(true).then(() => {
      overlayRenderKey = '';
      if (desiredOverlay) renderOverlay(desiredOverlay);
    });
  }
  if (changes.sd_state || changes.sd_notification) void syncOverlay();
});

window.addEventListener('pageshow', () => void syncOverlay());
window.addEventListener('resize', () => applyOverlayPosition(document.getElementById(OVERLAY_ID), true));
document.addEventListener('readystatechange', () => void syncOverlay());
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void syncOverlay();
});

// document_start：后台已通过 webNavigation 提前绑定新标签页时，首个 document 就能恢复状态。
void FreepaperI18n.init().then(() => {
  void loadOverlayPosition();
  void syncOverlay();
});
