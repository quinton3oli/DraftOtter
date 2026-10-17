// Makes the app's icons from the DraftOtter otter icon (brand/draftotter-icon.png): the small badge used in the top
// bar, tab and loading screen (otter on a light disc, so it shows on the dark UI), and the installed-app icons (on a
// white tile, padded so nothing is cropped; the maskable one keeps the otter inside the 80% safe zone). Drawn with a
// headless browser's canvas, so no image libraries are needed.  Run: node scripts/make-icons.mjs
import puppeteer from 'puppeteer-core';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = 'data:image/png;base64,' + readFileSync(path.join(root, 'brand', 'draftotter-icon.png')).toString('base64');
// [file, size, background: 'disc' | 'tile' | 'square', how much of the icon box the otter fills]
const OUT = [
	['src/assets/brand-badge.png', 128, 'disc', 0.8],
	['pwa/icons/draftotter-192.png', 192, 'tile', 0.8],
	['pwa/icons/draftotter-512.png', 512, 'tile', 0.8],
	['pwa/icons/draftotter-maskable-512.png', 512, 'square', 0.62],
	['pwa/icons/draftotter-apple-touch.png', 180, 'square', 0.78],
	['claude/icon.png', 256, 'tile', 0.8],
];

const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new' });
const page = await browser.newPage();
const results = await page.evaluate(async (src, OUT) => {
	const img = new Image();
	img.src = src;
	await img.decode();
	// the otter's own bounds (the file has empty margins)
	const c0 = document.createElement('canvas');
	c0.width = img.width; c0.height = img.height;
	const g0 = c0.getContext('2d');
	g0.drawImage(img, 0, 0);
	const d = g0.getImageData(0, 0, img.width, img.height).data;
	let x0 = img.width, y0 = img.height, x1 = 0, y1 = 0;
	for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) if (d[(y * img.width + x) * 4 + 3] > 24) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
	const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
	const out = {};
	for (const [file, size, bg, fill] of OUT) {
		const c = document.createElement('canvas');
		c.width = c.height = size;
		const g = c.getContext('2d');
		g.imageSmoothingQuality = 'high';
		g.fillStyle = '#ffffff';
		if (bg === 'disc') { g.beginPath(); g.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2); g.fill(); }
		else if (bg === 'tile') { const r = size * 0.22; g.beginPath(); g.roundRect(0, 0, size, size, r); g.fill(); }
		else g.fillRect(0, 0, size, size);
		const s = (size * fill) / Math.max(bw, bh), w = bw * s, h = bh * s;
		g.drawImage(img, x0, y0, bw, bh, (size - w) / 2, (size - h) / 2, w, h);
		out[file] = c.toDataURL('image/png').split(',')[1];
	}
	return out;
}, src, OUT);
await browser.close();
for (const [file, b64] of Object.entries(results)) {
	mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
	writeFileSync(path.join(root, file), Buffer.from(b64, 'base64'));
	console.log('wrote', file, Math.round(Buffer.from(b64, 'base64').length / 1024) + ' KB');
}
