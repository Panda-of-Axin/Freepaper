/* This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. */
'use strict';

(() => {
  const SETTINGS_KEY = 'freepaper_settings';
  const SUPPORTED = new Set(['auto', 'zh_CN', 'en']);

  const messages = {
    en: {
      versionLabel: 'v2.0.5 · CHNDOI multi-target resolver hotfix',
      refreshStatus: 'Refresh status',
      help: 'Help', openHelp: 'Open help', quickStartTitle: 'New here? Start in four steps',
      quickStep1: 'Prepare a CSV, TSV, or TXT file containing DOI or URL fields.',
      quickStep2: 'Import the file and check the detected paper titles.',
      quickStep3: 'Start the task and keep the single download-monitor window available.',
      quickStep4: 'Freepaper tries one clear PDF action; follow the page assistant for login or verification.',
      downloadExampleCsv: 'Download example CSV', copyExampleCsv: 'Copy example', copied: 'Copied', viewFullGuide: 'View full guide', dontShowAgain: 'Do not show again',
      preparingDownload: 'Preparing…', downloadStarted: 'Download started', openGuide: 'Open usage guide',
      settings: 'Settings', openSettings: 'Open settings', closeSettings: 'Close settings',
      currentPageTab: '📄 Current page', batchDownloadTab: '📋 Batch download', ready: 'Ready',
      sdNeedsAction: '🤖 The current paper page needs your action', waiting: 'Waiting…', continueAfterAction: '✓ I’m done, continue',
      stopThisPaper: '⏹ Stop this paper', stopAllTasks: '⏹ Stop all tasks', scanPagePdf: '📄 Scan page for PDFs',
      downloadAll: '⬇ Download', rescan: '🔄 Rescan',
      batchPlaceholder: 'Paste one DOI or URL per line\nCSV and TXT files are also supported\n\nExamples:\n10.1038/s41586-023-06921-5\nhttps://doi.org/10.1109/5.771073\nhttps://arxiv.org/abs/2312.00752',
      loadCsvTxt: '📁 Load CSV/TXT', startBatch: '▶ Start batch download', stopBatch: '⏹ Stop', clear: 'Clear',
      recentDownloads: '📥 Recent downloads', settingsSubtitle: 'Settings open in a separate layer and do not change the Current page or Batch download layout.',
      downloadSubfolder: 'Download subfolder', folderHint: 'PDFs are saved under Downloads / this folder. Do not enter a drive letter or an absolute path.',
      language: 'Language', languageHint: 'Auto follows the browser UI language. You can override it at any time.',
      languageAuto: 'Auto (browser language)', languageChinese: '简体中文', languageEnglish: 'English',
      saveSettings: 'Save settings', cancel: 'Cancel', footerPath: 'PDF → Downloads/{folder}/',
      autoMonitorTitle: 'Automatically open the download monitor',
      autoMonitorHint: 'Enabled by default: open one monitor when a batch starts and focus the same window when manual action is required.',
      globalTitle: 'Freepaper control center', running: 'Running', readingTask: 'Reading task status…',
      continueVerify: 'I’m done, continue', taskPage: 'Go to task page', openMonitor: 'Open download monitor', focusMonitor: 'Focus download monitor',
      pauseBatch: 'Pause batch', resumeBatch: 'Resume batch', skipPaper: 'Skip current paper', stopAll: 'Stop all',
      checkingPage: 'Waiting for the page to stabilize…', opening: 'Opening…', focusing: 'Focusing…', needsAction: 'Action required', paused: 'Paused',
      taskRunning: 'Task is running.', unknownPaper: 'Unknown paper', statusPrefix: 'Status: {status}',
      pauseAfterCurrent: 'Pause requested. No new paper will start after the current one finishes.',
      batchPausedResumeAt: 'Batch paused. It will resume from paper {index}.', batchRunningAt: 'Batch download: {current} / {total}',
      stats: '{processed}/{total} · Success {done} · Failed {failed} · Waiting {waiting}', singleTaskRunning: 'Single-paper task is running',
      scanInProgress: '📄 Scanning…', scanningCurrentPage: '⏳ Scanning the current page…', noActiveTab: 'No active tab',
      currentPageCount: '📄 Current page · {count} PDF candidate(s)', download: 'Download', currentPage: '📄 Current page',
      noPdfDetected: 'No PDF link was detected.', pageUrl: 'Page: {url}', pageTitle: 'Title: {title}', unknown: 'Unknown', retryScan: '🔄 Rescan',
      cannotScan: '📄 Cannot scan', useOnAcademicPage: 'Use this feature on an academic paper page.', internalPageUnsupported: 'Browser internal pages cannot be scanned.',
      scanFailed: '📄 Scan failed', scanFailedDetail: 'Scan failed: {message}', refreshAndRetry: 'Refresh the page and try again.',
      pdfDownloaded: 'PDF downloaded', noValidPdf: 'No valid PDF found', downloadTriggered: 'Download started', notPdfSkipped: 'Not a PDF; skipped',
      diagnosticHint: '{prefix}Test table: {records} URL cases → {papers} download items ({duplicates} duplicate entries merged{titles})',
      titleThemes: '; {count} title topic(s)', recordsHint: '{prefix}{records} records → {papers} papers ({duplicates} duplicates merged)',
      papersHint: '{prefix}{papers} papers', completed: 'Done', loginRequired: 'Login required', waitingAction: 'Waiting for action', failed: 'Failed', downloading: 'Downloading',
      loading: 'Loading…', readFailed: 'Read failed: {message}', stopRunningFirst: 'Stop the running batch first.',
      pasteOrLoadFirst: 'Paste DOI/URL entries or load a file first.', batchAlreadyRunning: 'A batch task is already running', startFailed: 'Failed to start: {message}',
      batchPausedAt: 'Batch paused · {processed}/{total}', batchRunningProgress: 'Batch downloading… {current}/{total}',
      batchResultLine: '{done} succeeded, {failed} failed, {waiting} waiting{paused}', continueFromControl: '; resume from the control center',
      stoppedWithReason: 'Stopped: {reason}', stoppedSummary: '{done} succeeded, {failed} failed; click Start to run again',
      completionStatus: 'Completed: {done}✅ {failed}❌ {login}🔐', completionStats: '{done} success · {failed} failed · {login} login required',
      retryFailed: '🔄 Retry failed/login-required ({count})', downloadComplete: '📊 Download task complete',
      completionSummary: '{total} papers · {done} success · {failed} failed · {login} login required', exportCsv: '📥 Export CSV report',
      groupSuccess: '✅ Success', groupLogin: '🔐 Login required', groupFailed: '❌ Failed',
      buildingRetry: 'Building a retry queue with only {count} paper(s)…', retryStartFailed: 'Failed to start retry: {message}',
      retryOnly: 'Retrying only {count} failed/login-required paper(s)', justNow: 'Just now', minutesAgo: '{count}m ago',
      closeSettings: 'Close settings',
      sd_OPENING: 'Opening the paper page…', sd_ARTICLE_READY: 'Article page ready; opening one clear PDF action…', sd_OPENING_PDF: 'Waiting for PDF, verification, or download…',
      sd_PDF_PAGE_READY: 'PDF page ready; validating and downloading…', sd_CHECKING_AFTER_CHALLENGE: 'Waiting for the page to stabilize and checking again…',
      sd_WAITING_CHALLENGE_1: 'Complete the first security verification, then click Continue.',
      sd_WAITING_CHALLENGE_2: 'Another verification appeared after the PDF action. Complete it; if the PDF button remains, click it again.',
      sd_WAITING_MANUAL_PDF: 'Manually click View PDF / Download PDF. Freepaper will watch repeated verification and the final download.',
      sd_ACCESS_DENIED: 'Access denied. Check institutional access, VPN, or permissions.', sd_DONE: 'The PDF was downloaded.',
      sd_FAILED: 'The current paper failed.', sd_STOPPED: 'The current paper was stopped.', processing: 'Processing…',
      phaseChallenge1: 'First verification', phaseChallenge2: 'Second verification',
      phaseVerificationRound: 'Verification {round}', phasePermission: 'Permission required',
      monitorClickPdfInstruction: 'Manually click View PDF / Download PDF. Freepaper will watch the next navigation, repeated verification, or browser download.',
      monitorVerificationInstruction: 'Complete verification round {round}. If the page returns to the article and still shows a PDF button, click it again.',
      monitorPermissionInstruction: 'This is a purchase/subscription page, not a PDF. Confirm access or skip this paper.',
      monitorLoginInstruction: 'Complete account or institutional login, return to the paper page, and run detection again.',
      monitorWaitingInstruction: 'Wait for the page to finish navigating. Do not repeatedly click or refresh.',
      monitorWaitingDownloadInstruction: 'Verification is complete. Freepaper is reconciling the browser download; do not click Download repeatedly.',
      phaseManual: 'Manual action', phaseAccess: 'Restore access', phaseAction: 'Action required',
      overlayTitle: 'Freepaper page-action assistant', dragToMove: 'Drag to move', overlayDefaultMessage: 'Complete the required action on this page.',
      overlayHint: 'Drag the header to move this assistant; its position is remembered. Full progress and the download monitor are in the extension main panel.',
      continueChecking: 'I’m done, continue checking', waitingStable: 'Waiting for the page to stabilize…',
      monitorTitle: 'Freepaper download monitor', monitorBadge: 'Live monitor', currentPaperStatus: 'Current paper status', readingTasks: 'Reading task…',
      batchProgress: 'Batch download progress', noBatchTask: 'No batch task', monitorHint: 'This is an auxiliary monitor. Closing it does not stop the background task; reopen or focus it from the extension main panel.',
      noManualPaper: 'No paper currently needs manual action', batchPaused: 'Batch paused', batchRunning: 'Batch running', auxiliaryMonitor: 'Live monitor',
      currentFinishesThenPause: 'Pausing after the current paper', batchEnded: 'Batch task ended', currentItem: 'Current: {index}/{total} · {paper} · {status}',
      status_pending: 'Pending', status_downloading: 'Downloading', status_waiting_user: 'Waiting for action', status_waiting_login: 'Waiting for login', status_done: 'Done', status_failed: 'Failed', status_needs_login: 'Login required (legacy)',
      confirmClearRecent: 'Clear the Freepaper recent-download list? Downloaded files will not be deleted.'
    },
    zh_CN: {
      versionLabel: 'v2.0.5 · CHNDOI 多重解析页自动接管',
      refreshStatus: '刷新状态',
      help: '帮助', openHelp: '打开帮助', quickStartTitle: '第一次使用？按四步开始',
      quickStep1: '准备包含 DOI 或 URL 字段的 CSV、TSV 或 TXT。',
      quickStep2: '导入文件并检查识别出的论文标题。',
      quickStep3: '启动任务，并保留唯一的下载进程窗。',
      quickStep4: 'Freepaper 会尝试一次明确 PDF 入口；遇到登录或验证时按照页面助手操作。',
      downloadExampleCsv: '下载示例 CSV', copyExampleCsv: '复制示例内容', copied: '已复制', viewFullGuide: '查看完整教程', dontShowAgain: '不再显示',
      preparingDownload: '正在准备…', downloadStarted: '下载已开始', openGuide: '打开使用指南',
      settings: '设置', openSettings: '打开设置', closeSettings: '关闭设置',
      currentPageTab: '📄 当前页面', batchDownloadTab: '📋 批量下载', ready: '就绪',
      sdNeedsAction: '🤖 当前论文页面需要你的操作', waiting: '等待中…', continueAfterAction: '✓ 我已完成，继续',
      stopThisPaper: '⏹ 终止此篇', stopAllTasks: '⏹ 终止全部任务', scanPagePdf: '📄 扫描页面 PDF',
      downloadAll: '⬇ 下载', rescan: '🔄 重新扫描',
      batchPlaceholder: '粘贴 DOI 或链接，每行一个\n也支持从 CSV、TXT 文件加载\n\n例如：\n10.1038/s41586-023-06921-5\nhttps://doi.org/10.1109/5.771073\nhttps://arxiv.org/abs/2312.00752',
      loadCsvTxt: '📁 加载 CSV/TXT', startBatch: '▶ 开始批量下载', stopBatch: '⏹ 停止', clear: '清空',
      recentDownloads: '📥 最近下载', settingsSubtitle: '设置页独立显示，不会改变“当前页面”和“批量下载”的布局状态。',
      downloadSubfolder: '下载子文件夹', folderHint: 'PDF 保存到“下载目录 / 此文件夹”。请勿输入盘符或以斜杠开头的绝对路径。',
      language: '界面语言', languageHint: '自动模式跟随浏览器界面语言，也可以随时手动切换。',
      languageAuto: '自动（跟随浏览器）', languageChinese: '简体中文', languageEnglish: 'English',
      saveSettings: '保存设置', cancel: '取消', footerPath: 'PDF → 下载/{folder}/',
      autoMonitorTitle: '自动打开下载进程窗', autoMonitorHint: '默认开启：批量任务开始时只打开一个监控窗；遇到验证时聚焦同一窗口，不重复弹出。',
      globalTitle: 'Freepaper 总控台', running: '运行中', readingTask: '正在读取任务状态…',
      continueVerify: '我已完成验证，继续', taskPage: '回到任务页面', openMonitor: '打开下载进程', focusMonitor: '聚焦下载进程',
      pauseBatch: '暂停批量任务', resumeBatch: '继续批量任务', skipPaper: '跳过当前篇', stopAll: '终止全部',
      checkingPage: '等待页面稳定并检测…', opening: '正在打开…', focusing: '正在聚焦…', needsAction: '需要操作', paused: '已暂停',
      taskRunning: '任务正在执行。', unknownPaper: '未知论文', statusPrefix: '状态：{status}',
      pauseAfterCurrent: '暂停请求已生效；当前篇处理完成后不会启动下一篇。',
      batchPausedResumeAt: '批量任务已暂停，将从第 {index} 篇继续。', batchRunningAt: '批量下载正在执行：{current} / {total}',
      stats: '{processed}/{total} · 成功 {done} · 失败 {failed} · 等待人工 {waiting}', singleTaskRunning: '单篇任务正在执行',
      scanInProgress: '📄 扫描中…', scanningCurrentPage: '⏳ 正在扫描当前页面…', noActiveTab: '没有活动标签页',
      currentPageCount: '📄 当前页面 · {count} 个 PDF', download: '下载', currentPage: '📄 当前页面',
      noPdfDetected: '未检测到 PDF 链接。', pageUrl: '当前页面：{url}', pageTitle: '标题：{title}', unknown: '未知', retryScan: '🔄 重新扫描',
      cannotScan: '📄 无法扫描', useOnAcademicPage: '请在学术论文页面使用此功能。', internalPageUnsupported: '当前页面（浏览器内部页）不支持扫描。',
      scanFailed: '📄 扫描失败', scanFailedDetail: '扫描失败：{message}', refreshAndRetry: '请刷新页面后重试。',
      pdfDownloaded: 'PDF 已下载', noValidPdf: '未找到有效 PDF', downloadTriggered: '下载已触发', notPdfSkipped: '不是 PDF，已跳过',
      diagnosticHint: '{prefix}测试表 {records} 条 URL 场景 → {papers} 个下载对象（按 DOI/文献标识合并 {duplicates} 条{titles}）',
      titleThemes: '；涉及 {count} 个标题主题', recordsHint: '{prefix}{records} 条记录 → {papers} 篇（合并重复 {duplicates} 条）',
      papersHint: '{prefix}{papers} 篇', completed: '完成', loginRequired: '等待登录', waitingAction: '等待操作', failed: '失败', downloading: '下载中',
      loading: '加载中…', readFailed: '读取失败：{message}', stopRunningFirst: '请先停止正在运行的批量任务',
      pasteOrLoadFirst: '请先粘贴 DOI 或链接，或加载文件', batchAlreadyRunning: '已有批量任务正在运行', startFailed: '启动失败：{message}',
      batchPausedAt: '批量任务已暂停 · {processed}/{total}', batchRunningProgress: '批量下载中… {current}/{total}',
      batchResultLine: '{done} 篇成功，{failed} 篇失败，{waiting} 篇等待人工{paused}', continueFromControl: '；可从总控台继续',
      stoppedWithReason: '已停止：{reason}', stoppedSummary: '{done} 篇成功，{failed} 篇失败；可再次点击开始重新执行',
      completionStatus: '完成：{done}✅ {failed}❌ {login}🔐', completionStats: '{done} 成功 · {failed} 失败 · {login} 需登录',
      retryFailed: '🔄 重试失败/需登录 ({count} 篇)', downloadComplete: '📊 下载任务完成',
      completionSummary: '共 {total} 篇，成功 {done}，失败 {failed}，需登录 {login}', exportCsv: '📥 导出下载报告 CSV',
      groupSuccess: '✅ 成功', groupLogin: '🔐 需登录', groupFailed: '❌ 失败',
      buildingRetry: '正在建立仅含 {count} 篇的重试队列…', retryStartFailed: '重试启动失败：{message}',
      retryOnly: '仅重试 {count} 篇失败/需登录论文', justNow: '刚刚', minutesAgo: '{count}分前',
      sd_OPENING: '正在打开论文页面…', sd_ARTICLE_READY: '文章页已就绪，正在尝试一次明确 PDF 入口…', sd_OPENING_PDF: '正在等待 PDF、验证或下载响应…',
      sd_PDF_PAGE_READY: 'PDF 页面已就绪，正在验证并下载…', sd_CHECKING_AFTER_CHALLENGE: '正在等待页面跳转稳定并重新检测…',
      sd_WAITING_CHALLENGE_1: '请完成第一次安全验证，然后点击继续。', sd_WAITING_CHALLENGE_2: '点击 PDF 后又出现验证。请完成验证；若仍显示 PDF 按钮，请再次点击。',
      sd_WAITING_MANUAL_PDF: '请手动点击 View PDF / Download PDF；Freepaper 会继续监听重复验证和最终下载。', sd_ACCESS_DENIED: '访问被拒绝，请检查机构登录或 VPN。',
      sd_DONE: '当前论文已下载。', sd_FAILED: '当前论文下载失败。', sd_STOPPED: '当前论文已停止。', processing: '处理中…',
      phaseChallenge1: '第一级验证', phaseChallenge2: '第二级验证',
      phaseVerificationRound: '第 {round} 轮验证', phasePermission: '权限确认',
      monitorClickPdfInstruction: '请手动点击 View PDF / Download PDF。Freepaper 会监听后续跳转、重复验证或浏览器下载。',
      monitorVerificationInstruction: '请完成第 {round} 轮验证。若页面返回详情页且仍显示 PDF 按钮，请再次点击。',
      monitorPermissionInstruction: '当前是购买/订阅页，不是 PDF。请确认访问权限，或跳过当前文献。',
      monitorLoginInstruction: '请完成账号或机构登录，返回论文页面后重新检测。',
      monitorWaitingInstruction: '请等待页面完成跳转，不要反复点击或刷新。',
      monitorWaitingDownloadInstruction: '验证已完成，Freepaper 正在核对浏览器下载，请不要重复点击下载。',
      phaseManual: '需要手动操作', phaseAccess: '访问恢复', phaseAction: '需要操作',
      overlayTitle: 'Freepaper 页面操作助手', dragToMove: '按住拖动', overlayDefaultMessage: '请完成当前页面操作',
      overlayHint: '可按住顶部拖动，位置会自动记忆。完整进度和下载进程入口位于扩展主面板。',
      continueChecking: '我已完成，继续检测', waitingStable: '正在等待页面稳定…',
      monitorTitle: 'Freepaper 下载进程', monitorBadge: '持续监控', currentPaperStatus: '当前论文状态', readingTasks: '正在读取任务…',
      batchProgress: '批量下载进度', noBatchTask: '没有批量任务', monitorHint: '此窗口是辅助监控界面。关闭后不会影响后台任务，可随时从扩展主面板重新打开或聚焦。',
      noManualPaper: '当前没有需要人工处理的论文', batchPaused: '批量已暂停', batchRunning: '批量运行中', auxiliaryMonitor: '辅助监控',
      currentFinishesThenPause: '当前篇完成后暂停', batchEnded: '批量任务已结束', currentItem: '当前：{index}/{total} · {paper} · {status}',
      status_pending: '待处理', status_downloading: '下载中', status_waiting_user: '等待操作', status_waiting_login: '等待登录', status_done: '完成', status_failed: '失败', status_needs_login: '需登录（旧任务）',
      confirmClearRecent: '清空 Freepaper 最近下载列表？已下载文件不会被删除。'
    }
  };

  let languageMode = 'auto';
  let locale = 'en';
  let initialized = false;

  function normalizeMode(value) {
    return SUPPORTED.has(value) ? value : 'auto';
  }

  function browserLocale() {
    const raw = String(chrome?.i18n?.getUILanguage?.() || navigator?.language || 'en').toLowerCase();
    return raw.startsWith('zh') ? 'zh_CN' : 'en';
  }

  function resolveLocale(mode) {
    return mode === 'auto' ? browserLocale() : mode;
  }

  function format(template, vars = {}) {
    return String(template).replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, key) =>
      Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : `{${key}}`);
  }

  function t(key, vars = {}) {
    const table = messages[locale] || messages.en;
    return format(table[key] ?? messages.en[key] ?? key, vars);
  }

  async function init(force = false) {
    if (initialized && !force) return locale;
    try {
      const data = await chrome.storage.local.get(SETTINGS_KEY);
      languageMode = normalizeMode(data[SETTINGS_KEY]?.language);
    } catch (_) {
      languageMode = 'auto';
    }
    locale = resolveLocale(languageMode);
    initialized = true;
    return locale;
  }

  async function setLanguage(mode) {
    languageMode = normalizeMode(mode);
    locale = resolveLocale(languageMode);
    initialized = true;
    const data = await chrome.storage.local.get(SETTINGS_KEY);
    await chrome.storage.local.set({
      [SETTINGS_KEY]: { ...(data[SETTINGS_KEY] || {}), language: languageMode },
    });
    return locale;
  }

  function applyDocument(root = document) {
    if (!root?.querySelectorAll) return;
    root.documentElement && (root.documentElement.lang = locale === 'zh_CN' ? 'zh-CN' : 'en');
    root.querySelectorAll('[data-i18n]').forEach((element) => {
      element.textContent = t(element.dataset.i18n);
    });
    root.querySelectorAll('[data-i18n-placeholder]').forEach((element) => {
      element.setAttribute('placeholder', t(element.dataset.i18nPlaceholder));
    });
    root.querySelectorAll('[data-i18n-title]').forEach((element) => {
      element.setAttribute('title', t(element.dataset.i18nTitle));
    });
    root.querySelectorAll('[data-i18n-aria-label]').forEach((element) => {
      element.setAttribute('aria-label', t(element.dataset.i18nAriaLabel));
    });
  }

  function localeTag() {
    return locale === 'zh_CN' ? 'zh-CN' : 'en-US';
  }

  globalThis.FreepaperI18n = {
    init, setLanguage, t, applyDocument, localeTag,
    getLocale: () => locale,
    getLanguageMode: () => languageMode,
    status: (status) => t(`sd_${status}`),
    paperStatus: (status) => t(`status_${status}`),
  };
})();
