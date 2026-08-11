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

function clearPdfActionHighlights() {
  document.querySelectorAll('[data-freepaper-pdf-highlighted="1"]').forEach((element) => {
    element.style.removeProperty('outline');
    element.style.removeProperty('outline-offset');
    element.style.removeProperty('box-shadow');
    element.removeAttribute('data-freepaper-pdf-highlighted');
  });
}

function updatePdfActionHighlights(enabled) {
  clearPdfActionHighlights();
  if (!enabled) return;
  document.querySelectorAll('a,button,[role="button"],[data-url],[data-href]').forEach((element) => {
    if (!isLikelyPdfActionElement(element)) return;
    element.setAttribute('data-freepaper-pdf-highlighted', '1');
    element.style.setProperty('outline', '3px solid #2563eb', 'important');
    element.style.setProperty('outline-offset', '3px', 'important');
    element.style.setProperty('box-shadow', '0 0 0 6px rgba(37,99,235,.16)', 'important');
  });
}

function removeOverlay() {
  document.getElementById(OVERLAY_ID)?.remove();
  clearPdfActionHighlights();
  overlayRenderKey = '';
  dragState = null;
}

function phaseLabel(payload) {
  if (payload?.guidanceType === 'verification') return t('phaseVerificationRound', { round: payload.verificationRound || 1 });
  if (payload?.guidanceType === 'institution_login') return '机构认证';
  if (payload?.guidanceType === 'account_login') return '账号登录';
  if (payload?.guidanceType === 'waiting_download') return '等待下载';
  if (payload?.status === 'WAITING_MANUAL_PDF') return t('phaseManual');
  if (payload?.guidanceType === 'permission') return t('phasePermission');
  if (payload?.status === 'ACCESS_DENIED') return t('phaseAccess');
  return t('phaseAction');
}

function overlayMessage(payload) {
  // 后台已经根据“机构认证 / 个人账号登录 / 人机验证 / 购买页 / PDF 已打开”
  // 生成了精确说明。旧版优先使用通用 status 文案，导致所有情况都显示成
  // “请点击 View PDF”。这里必须优先展示后台的具体 message。
  return payload?.message || (payload?.status ? FreepaperI18n.status(payload.status) : t('overlayDefaultMessage'));
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
      <div class="hint">${escapeHtml(payload.hint || t('overlayHint'))}</div>
      <div class="actions">
        <button class="primary" id="fp-continue">${escapeHtml(payload.primaryLabel || t('continueChecking'))}</button>
        <button class="secondary" id="fp-skip">${t('skipPaper')}</button>
        <button class="danger" id="fp-stop">${t('stopAll')}</button>
      </div>
    </div>`;

  overlayRenderKey = nextRenderKey;
  updatePdfActionHighlights(payload.status === 'WAITING_MANUAL_PDF');
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

function isLikelyPdfActionElement(element) {
  const target = element?.closest?.('a,button,[role="button"],[data-url],[data-href]');
  if (!target) return null;
  const text = String(target.innerText || target.textContent || target.getAttribute('aria-label') || target.getAttribute('title') || '')
    .replace(/\s+/g, ' ').trim();
  const rawHref = target.getAttribute('href') || target.getAttribute('data-url') || target.getAttribute('data-href') || '';
  let href = '';
  try { href = rawHref ? new URL(rawHref, location.href).href : ''; } catch (_) {}
  const haystack = `${text} ${href}`.toLowerCase();
  const textMatch = /(?:view|download|open|full\s*text)[\s_-]*pdf|pdf[\s_-]*(?:download|全文|下载)|pdf下载|下载pdf|全文下载|查看pdf/.test(haystack);
  const routeMatch = /\.pdf(?:$|[?#])|\/(?:pdf|pdfdirect|epdf|pdfft)(?:\/|$)|stamppdf\/getpdf\.jsp|dflag=pdfdown/i.test(href);
  return textMatch || routeMatch ? { target, text, href } : null;
}

document.addEventListener('click', (event) => {
  const action = isLikelyPdfActionElement(event.target);
  if (!action) return;
  void chrome.runtime.sendMessage({
    type: 'PDF_ACTION_CLICKED',
    text: action.text.slice(0, 180),
    href: action.href.slice(0, 2000),
    trusted: event.isTrusted,
  }).catch(() => null);
}, true);

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
