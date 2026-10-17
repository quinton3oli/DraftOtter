// Web-sized images for the landing page from the full-size originals (assets/source-*.png):
// the transparent render trimmed for the hero, the in-app views of the otter and the logo, the logo render, and the badge. Run: node landing/make-images.mjs
import puppeteer from 'puppeteer-core';
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const a = (f) => path.join(here, 'assets', f);
const uri = (f) => 'data:image/png;base64,' + readFileSync(a(f)).toString('base64');
// [source, out, crop [x, y, w, h] in source pixels (null = whole; 'trim' = to the visible pixels), output width ('native':
// as cropped), jpeg
// quality (or 'png' / 'webp' to keep transparency)]
const JOBS = [
	['source-in-app.png', 'otter-in-app.jpg', null, 1384, 0.88],
	['source-render-transparent.png', 'otter-cutout.webp', 'trim', 'native', 'webp'],
	['source-logo-in-app.png', 'logo-in-app.jpg', null, 'native', 0.88],
	['source-logo-render.png', 'logo-render.jpg', [240, 60, 1440, 960], 1200, 0.85],
];
const b = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new' });
const p = await b.newPage();
for (const [src, out, crop, width, q] of JOBS) {
	const data = await p.evaluate(async (u, crop, width, q) => {
		const img = new Image(); img.src = u; await img.decode();
		let box = crop || [0, 0, img.width, img.height];
		if (crop === 'trim') {
			const t = document.createElement('canvas'); t.width = img.width; t.height = img.height;
			const tg = t.getContext('2d'); tg.drawImage(img, 0, 0);
			const d = tg.getImageData(0, 0, img.width, img.height).data;
			let x0 = img.width, y0 = img.height, x1 = 0, y1 = 0;
			for (let yy = 0; yy < img.height; yy++) for (let xx = 0; xx < img.width; xx++) if (d[(yy * img.width + xx) * 4 + 3] > 8) { x0 = Math.min(x0, xx); y0 = Math.min(y0, yy); x1 = Math.max(x1, xx); y1 = Math.max(y1, yy); }
			const pad = Math.round((x1 - x0) * 0.04);
			box = [x0 - pad, y0 - pad, x1 - x0 + 1 + 2 * pad, y1 - y0 + 1 + 2 * pad];
		}
		const [x, y, w, h] = box;
		const c = document.createElement('canvas');
		const W = width === 'native' ? w : width; // native: the cropped size, never scaled up
		c.width = W; c.height = Math.round((h * W) / w);
		const g = c.getContext('2d'); g.imageSmoothingQuality = 'high';
		g.drawImage(img, x, y, w, h, 0, 0, c.width, c.height);
		return (q === 'png' ? c.toDataURL('image/png') : q === 'webp' ? c.toDataURL('image/webp', 0.93) : c.toDataURL('image/jpeg', q)).split(',')[1];
	}, uri(src), crop, width, q);
	writeFileSync(a(out), Buffer.from(data, 'base64'));
	console.log('wrote', out, Math.round(Buffer.from(data, 'base64').length / 1024) + ' KB');
}
await b.close();
copyFileSync(path.join(here, '..', 'src', 'assets', 'brand-badge.png'), a('badge.png'));
copyFileSync(path.join(here, '..', 'pwa', 'icons', 'draftotter-192.png'), a('icon-192.png'));
console.log('copied badge.png, icon-192.png');
