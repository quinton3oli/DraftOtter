// Builds the installable web app for Firebase Hosting into web/: the app as index.html, the web manifest, icons,
// the service worker (stamped with this build, so visitors get an update offer), and the Claude helper downloads.
//   npm run web        (then: npm run deploy, or npx firebase-tools deploy --only hosting)
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
const out = path.join(root, 'web');

console.log('building DraftOtter …');
execSync('node build.mjs', { cwd: root, stdio: 'inherit' });

rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(out, 'icons'), { recursive: true });
mkdirSync(path.join(out, 'claude'), { recursive: true });

const html = readFileSync(path.join(root, 'DraftOtter.html'));
writeFileSync(path.join(out, 'index.html'), html);
copyFileSync(path.join(root, 'pwa', 'manifest.webmanifest'), path.join(out, 'manifest.webmanifest'));
for (const f of readdirSync(path.join(root, 'pwa', 'icons'))) copyFileSync(path.join(root, 'pwa', 'icons', f), path.join(out, 'icons', f));
// the service worker names its cache after this build: a new build means a new cache and an update offer
const build = createHash('sha256').update(html).update(readFileSync(path.join(root, 'pwa', 'manifest.webmanifest'))).digest('hex').slice(0, 12);
writeFileSync(path.join(out, 'sw.js'), readFileSync(path.join(root, 'pwa', 'sw.js'), 'utf8').replace('__BUILD__', build));

// Claude connection downloads (the Connect Claude dialog links to them)
copyFileSync(path.join(root, 'claude', 'draftotter-mcp.mjs'), path.join(out, 'claude', 'draftotter-mcp.mjs'));
execSync(`npx mcpb pack claude "${path.join(out, 'claude', 'DraftOtter.mcpb')}"`, { cwd: root, stdio: 'ignore' });

const mb = (p) => (statSync(p).size / 1024 / 1024).toFixed(2) + ' MB';
console.log(`\nweb/ ready (build ${build})`);
for (const f of readdirSync(out, { recursive: true })) if (statSync(path.join(out, f)).isFile()) console.log('  ' + f.split(path.sep).join('/') + '  ' + mb(path.join(out, f)));
