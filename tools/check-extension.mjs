import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const errors = [];

function requireFile(relativePath) {
  if (!relativePath || !fs.existsSync(path.join(root, relativePath))) errors.push(`Missing: ${relativePath}`);
}

for (const file of [
  'background.js', 'content.js', 'i18n.js', 'popup.html', 'popup.js',
  'task-monitor.html', 'task-monitor.js', 'onboarding.html', 'onboarding.js',
  'examples/freepaper-example.csv', 'docs/CODE_AUDIT.md', 'docs/VALIDATION.md',
  'docs/RELEASE_CHECKLIST.md', 'docs/RELEASE_PROCESS.md', 'CHANGELOG.md',
  'LICENSE', 'privacy-policy.md', 'README.md', 'README.zh-CN.md',
  'tools/release.mjs', 'tools/package-extension.mjs',
  '.github/workflows/ci.yml', '.github/workflows/release.yml',
]) requireFile(file);

for (const icon of Object.values(manifest.icons || {})) requireFile(icon);
requireFile(manifest.background?.service_worker || '');
requireFile(manifest.action?.default_popup || '');
for (const script of manifest.content_scripts?.flatMap((entry) => entry.js || []) || []) requireFile(script);
if (manifest.default_locale) for (const locale of ['en', 'zh_CN']) requireFile(`_locales/${locale}/messages.json`);

for (const file of fs.readdirSync(root).filter((name) => name.endsWith('.js'))) {
  try { execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'pipe' }); }
  catch (error) { errors.push(`Syntax error in ${file}: ${error.stderr?.toString() || error.message}`); }
}
for (const file of fs.readdirSync(path.join(root, 'tools')).filter((name) => name.endsWith('.mjs'))) {
  try { execFileSync(process.execPath, ['--check', path.join(root, 'tools', file)], { stdio: 'pipe' }); }
  catch (error) { errors.push(`Syntax error in tools/${file}: ${error.stderr?.toString() || error.message}`); }
}

const scanFiles = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'dist', 'build', 'history'].includes(entry.name)) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (/\.(js|mjs|json|html|md|txt|yml|yaml)$/.test(entry.name)) scanFiles.push(p);
  }
}
walk(root);
const selfPath = path.join(root, 'tools', 'check-extension.mjs');
const allText = scanFiles.filter((p) => p !== selfPath).map((p) => fs.readFileSync(p, 'utf8')).join('\n');
for (const forbidden of ['127.0.0.1:9876', 'const BACKEND =', 'startPolling()', 'pollForTask()', 'eval(', 'new Function(']) {
  if (allText.includes(forbidden)) errors.push(`Forbidden or legacy marker remains: ${forbidden}`);
}
if (fs.existsSync(path.join(root, 'archive'))) errors.push('archive/ must not be published');
if (fs.existsSync(path.join(root, 'sd-adapter.js'))) errors.push('sd-adapter.js legacy stub must not be published');
if (fs.existsSync(path.join(root, 'UPLOAD_TO_GITHUB.md'))) errors.push('UPLOAD_TO_GITHUB.md is obsolete; use docs/RELEASE_PROCESS.md');

const docsRoot = path.join(root, 'docs');
for (const name of fs.readdirSync(docsRoot)) {
  if (/[_-]v\d+\.\d+/i.test(name)) errors.push(`Version-specific current doc must be archived under docs/history/: docs/${name}`);
}

if (manifest.name !== '__MSG_extensionName__') errors.push('manifest name must use localized extensionName');
if (manifest.description !== '__MSG_extensionDescription__') errors.push('manifest description must use localized extensionDescription');
if (manifest.default_locale !== 'en') errors.push('default_locale must be en');

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (pkg.version !== manifest.version) errors.push('package.json version does not match manifest.json');
for (const rel of ['popup.html', 'i18n.js', 'onboarding.html']) {
  const text = fs.readFileSync(path.join(root, rel), 'utf8');
  if (!text.includes(`v${manifest.version}`)) errors.push(`${rel} visible version does not match manifest.json`);
}

const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const popupJs = fs.readFileSync(path.join(root, 'popup.js'), 'utf8');
for (const requiredMarker of [
  'stampPDF/getPDF.jsp', '/doi/pdfdirect/', 'normalizeDetectedPaperTitle',
  'task.batchJobId', 'PDF_ACTION_CLICKED', 'verificationRound', 'autoPdfAttemptKey',
  'WAITING_BROWSER_DOWNLOAD', 'onDeterminingFilename', 'INSTITUTION_AUTH_REQUIRED',
  'ACCOUNT_AUTH_REQUIRED', 'canonicalizePublisherPdfUrl', 'tryStartPageContextPdfDownload',
  'CONTEXT_BOUND_PDF_URL', 'waiting_login', 'shouldUseRecoverablePublisherHandoff',
  'isDoiResolverUrl', 'isChnDoiMultipleResolverUrl', 'chooseDoiResolverTarget',
]) if (!background.includes(requiredMarker)) errors.push(`Publisher-routing marker missing from background.js: ${requiredMarker}`);

if (!background.includes('version: chrome.runtime.getManifest().version')) errors.push('background build_info must read version from manifest');
if (!popupJs.includes('hasBlockedStaticExtension')) errors.push('popup.js must use path-based static-extension filtering');
const contentJs = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
if (!contentJs.includes('payload?.message')) errors.push('content.js must prefer precise background guidance');
if (background.includes("l.includes('.js')") || popupJs.includes("l.includes('.js')")) errors.push('Substring-based .js filtering remains and may reject .jsp URLs');

if (errors.length) {
  console.error(errors.map((item) => `- ${item}`).join('\n'));
  process.exit(1);
}
console.log(`Freepaper ${manifest.version}: extension checks passed.`);
