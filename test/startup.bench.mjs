// Startup benchmark: how long until the app is usable (body.ready), for the web app (served, warm: from the
// service worker cache) and the single-file version. Not part of npm test; run: node test/startup.bench.mjs
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const RUNS = +(process.argv[2] || 7);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.wasm': 'application/wasm', '.mjs': 'text/javascript' };
const server = http.createServer((req, res) => {
	let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
	if (p === '/') p = '/index.html';
	const file = path.join('web', p);
	if (!existsSync(file)) { res.writeHead(404).end(); return; }
	res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
	res.end(readFileSync(file));
}).listen(0, '127.0.0.1');
await new Promise((r) => server.on('listening', r));
const base = `http://localhost:${server.address().port}/`;
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1400, height: 900 } });

const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
async function measure(url, label) {
	const ctx = await browser.createBrowserContext();
	const page = await ctx.newPage();
	const times = [];
	for (let i = 0; i < RUNS + 2; i++) {
		if (i === 0) await page.goto(url); else await page.reload();
		await page.waitForFunction(() => document.body.classList.contains('ready'), { timeout: 120000 });
		const t = await page.evaluate(() => ({ ready: performance.now(), engine: window.__engineMs || 0, sw: !!(navigator.serviceWorker && navigator.serviceWorker.controller) }));
		if (i >= 2) times.push(t); // first visits fill the caches
	}
	await ctx.close();
	const r = { ready: Math.round(median(times.map((t) => t.ready))), engine: Math.round(median(times.map((t) => t.engine))), sw: times.every((t) => t.sw) };
	console.log(`${label.padEnd(10)} ready ${r.ready} ms (median of ${RUNS})${r.engine ? `, geometry engine ${r.engine} ms` : ''}${r.sw ? ', from the service worker' : ''}`);
	return r;
}

await measure(base, 'web app');
await measure(pathToFileURL('LocalCAD.html').href, 'file');
await browser.close();
server.close();
