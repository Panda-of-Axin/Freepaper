import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const version = manifest.version;
const dist = path.join(root, 'dist');
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'freepaper-release-'));

const runtimeFiles = [
  'manifest.json', 'background.js', 'content.js', 'i18n.js',
  'popup.html', 'popup.js', 'task-monitor.html', 'task-monitor.js',
  'onboarding.html', 'onboarding.js', 'examples/freepaper-example.csv',
  '_locales/en/messages.json', '_locales/zh_CN/messages.json',
  'icons/icon16.png', 'icons/icon32.png', 'icons/icon48.png', 'icons/icon128.png',
];

for (const rel of runtimeFiles) {
  const src = path.join(root, rel);
  if (!fs.existsSync(src)) throw new Error(`Missing runtime file: ${rel}`);
  const dst = path.join(stage, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
const chromeZip = path.join(dist, `Freepaper_v${version}_Chrome_Web_Store_Upload.zip`);
const edgeZip = path.join(dist, `Freepaper_v${version}_Edge_Addons_Upload.zip`);

if (process.platform === 'win32') {
  const ps = [
    "$ErrorActionPreference='Stop'",
    `Compress-Archive -Path '${stage.replace(/'/g, "''")}\\*' -DestinationPath '${chromeZip.replace(/'/g, "''")}' -Force`,
  ].join('; ');
  execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'inherit' });
} else {
  execFileSync('zip', ['-q', '-r', chromeZip, '.'], { cwd: stage, stdio: 'inherit' });
}
fs.copyFileSync(chromeZip, edgeZip);

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
fs.writeFileSync(path.join(dist, 'SHA256SUMS.txt'),
  `${sha256(chromeZip)}  ${path.basename(chromeZip)}\n${sha256(edgeZip)}  ${path.basename(edgeZip)}\n`, 'utf8');

const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
const escaped = version.replace(/\./g, '\\.');
const match = changelog.match(new RegExp(`^## ${escaped}\\s*\\n([\\s\\S]*?)(?=^## |\\Z)`, 'm'));
if (!match) throw new Error(`CHANGELOG.md has no section for ${version}`);
const body = match[1].trim();
if (!body || /TODO/i.test(body)) throw new Error(`CHANGELOG ${version} section is empty or still contains TODO.`);
fs.writeFileSync(path.join(dist, 'RELEASE_NOTES.md'), `# Freepaper v${version}\n\n${body}\n`, 'utf8');

console.log(`Release packages written to ${path.relative(root, dist)}/`);
