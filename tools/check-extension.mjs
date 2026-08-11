import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(root, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const errors = [];

function requireFile(relativePath) {
  if (!relativePath || !fs.existsSync(path.join(root, relativePath))) errors.push(`Missing: ${relativePath}`);
}

for (const file of ['background.js', 'content.js', 'i18n.js', 'popup.html', 'popup.js',
  'task-monitor.html', 'task-monitor.js', 'onboarding.html', 'onboarding.js',
  'examples/freepaper-example.csv',
  'examples/regression-page-context-v2.0.2.csv',
  'docs/CODE_AUDIT_v2.0.2_ZH.md',
  'docs/VALIDATION_v2.0.2_ZH.md',
  'LICENSE', 'privacy-policy.md', 'README.md', 'README.zh-CN.md']) {
  requireFile(file);
}
for (const icon of Object.values(manifest.icons || {})) requireFile(icon);
requireFile(manifest.background?.service_worker || '');
requireFile(manifest.action?.default_popup || '');
for (const script of manifest.content_scripts?.flatMap((entry) => entry.js || []) || []) requireFile(script);
if (manifest.default_locale) {
  for (const locale of ['en', 'zh_CN']) requireFile(`_locales/${locale}/messages.json`);
}

for (const file of fs.readdirSync(root).filter((name) => name.endsWith('.js'))) {
  try {
    execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'pipe' });
  } catch (error) {
    errors.push(`Syntax error in ${file}: ${error.stderr?.toString() || error.message}`);
  }
}

const scanFiles = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'dist', 'build'].includes(entry.name)) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (/\.(js|json|html|md|txt|yml|yaml)$/.test(entry.name)) scanFiles.push(p);
  }
}
walk(root);
const allText = scanFiles.map((p) => fs.readFileSync(p, 'utf8')).join('\n');
for (const forbidden of ['127.0.0.1:9876', 'const BACKEND =', 'startPolling()', 'pollForTask()', 'eval(', 'new Function(']) {
  if (allText.includes(forbidden)) errors.push(`Forbidden or legacy marker remains: ${forbidden}`);
}
if (fs.existsSync(path.join(root, 'archive'))) errors.push('archive/ must not be published');
if (fs.existsSync(path.join(root, 'sd-adapter.js'))) errors.push('sd-adapter.js legacy stub must not be published');

if (manifest.name !== '__MSG_extensionName__') errors.push('manifest name must use localized extensionName');
if (manifest.description !== '__MSG_extensionDescription__') errors.push('manifest description must use localized extensionDescription');
if (manifest.default_locale !== 'en') errors.push('default_locale must be en');


const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const popupJs = fs.readFileSync(path.join(root, 'popup.js'), 'utf8');
for (const requiredMarker of [
  'stampPDF/getPDF.jsp',
  '/doi/pdfdirect/',
  'normalizeDetectedPaperTitle',
  'task.batchJobId',
  'PDF_ACTION_CLICKED',
  'verificationRound',
  'autoPdfAttemptKey',
  'WAITING_BROWSER_DOWNLOAD',
  'onDeterminingFilename',
  'INSTITUTION_AUTH_REQUIRED',
  'ACCOUNT_AUTH_REQUIRED',
  'canonicalizePublisherPdfUrl',
  'tryStartPageContextPdfDownload',
  'CONTEXT_BOUND_PDF_URL',
]) {
  if (!background.includes(requiredMarker)) errors.push(`Publisher-routing marker missing from background.js: ${requiredMarker}`);
}
if (!popupJs.includes('hasBlockedStaticExtension')) errors.push('popup.js must use path-based static-extension filtering');
const contentJs = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
if (!contentJs.includes('payload?.message')) errors.push('content.js must prefer precise background guidance');
if (background.includes('activeDocumentId || task.lastUrl') && background.includes('pdfActionRound || 0')) errors.push('legacy IEEE auto-attempt key appears to remain');
if (background.includes("l.includes('.js')") || popupJs.includes("l.includes('.js')")) {
  errors.push('Substring-based .js filtering remains and may reject .jsp URLs');
}

const popup = fs.readFileSync(path.join(root, 'popup.html'), 'utf8');
const displayVersion = manifest.version.endsWith('.0') ? manifest.version.slice(0, -2) : manifest.version;
if (!popup.includes(`v${displayVersion}`)) errors.push('popup.html display version does not match manifest.json');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (pkg.version !== manifest.version) errors.push('package.json version does not match manifest.json');

if (errors.length) {
  console.error(errors.map((item) => `- ${item}`).join('\n'));
  process.exit(1);
}
console.log(`Freepaper ${manifest.version}: extension checks passed.`);
