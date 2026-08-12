import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = String(process.argv[2] || '').trim().replace(/^v/, '');
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('Usage: npm run release -- X.Y.Z');
  process.exit(2);
}

function read(rel) { return fs.readFileSync(path.join(root, rel), 'utf8'); }
function write(rel, text) { fs.writeFileSync(path.join(root, rel), text, 'utf8'); }

const changelog = read('CHANGELOG.md');
const heading = `## ${version}`;
const escapedVersion = version.replace(/\./g, '\\.');
const section = changelog.match(new RegExp(`^## ${escapedVersion}\\s*\\n([\\s\\S]*?)(?=^## |\\Z)`, 'm'));
if (!section) {
  console.error(`CHANGELOG.md must contain ${heading} before release preparation.`);
  process.exit(3);
}
if (!section[1].trim() || /TODO/i.test(section[1])) {
  console.error(`${heading} is empty or still contains TODO.`);
  process.exit(3);
}

const manifest = JSON.parse(read('manifest.json'));
const previous = manifest.version;
manifest.version = version;
write('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);

const pkg = JSON.parse(read('package.json'));
pkg.version = version;
write('package.json', `${JSON.stringify(pkg, null, 2)}\n`);

// Only these UI files intentionally display a release number. Runtime build metadata reads manifest dynamically.
for (const rel of ['popup.html', 'i18n.js', 'onboarding.html']) {
  let text = read(rel);
  const escaped = previous.replace(/\./g, '\\.');
  text = text.replace(new RegExp(`v${escaped}`, 'g'), `v${version}`);
  write(rel, text);
}

console.log(`Prepared version ${version} (previous ${previous}). Running verification...`);
execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'verify'], { cwd: root, stdio: 'inherit' });
execFileSync(process.execPath, [path.join(root, 'tools/package-extension.mjs')], { cwd: root, stdio: 'inherit' });
console.log('\nRelease preparation complete.');
console.log('Next: review CHANGELOG.md and dist/, then git add -A, commit, push, tag, and push the tag.');
