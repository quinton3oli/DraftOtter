// The landing page for publishing: landing/index.html plus only the assets it references (the full-size
// source-*.png originals stay behind) → landing-dist/.  Run: node scripts/make-landing.mjs
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'landing'), out = path.join(root, 'landing-dist');
const html = readFileSync(path.join(src, 'index.html'), 'utf8');
const assets = [...new Set([...html.matchAll(/["'(](assets\/[^"')\s]+)/g)].map((m) => m[1]))];
rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(out, 'assets'), { recursive: true });
writeFileSync(path.join(out, 'index.html'), html);
let bytes = Buffer.byteLength(html);
for (const a of assets) {
	copyFileSync(path.join(src, a), path.join(out, a));
	bytes += statSync(path.join(out, a)).size;
}
console.log(`landing-dist: index.html + ${assets.length} assets (${Math.round(bytes / 1024)} KB)`);
