// The web app (web/, built by npm run web): manifest, icons, service worker, working offline, and the update offer
// after a new deploy. Served from a local server here, as Firebase Hosting would.
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

execSync('node scripts/make-web.mjs', { stdio: 'ignore' }); // the web app from the current sources
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(ok ? 'ok  ' : 'FAIL', name, info); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.mjs': 'text/javascript', '.mcpb': 'application/zip' };
let swOverride = null; // a "new deploy": a different service worker build
const server = http.createServer((req, res) => {
	let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
	if (p === '/') p = '/index.html';
	const file = path.join('web', p);
	if (!file.startsWith('web') || !existsSync(file)) { res.writeHead(404).end(); return; }
	let body = readFileSync(file);
	if (p === '/sw.js' && swOverride) body = Buffer.from(swOverride);
	res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
	res.end(body);
}).listen(0, '127.0.0.1');
await new Promise((r) => server.on('listening', r));
const base = `http://localhost:${server.address().port}/`;

const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 240000, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1400, height: 900 } });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const ready = () => page.waitForFunction(() => document.body.classList.contains('ready'), { timeout: 60000 });
const app = (fn, ...a) => page.evaluate(fn, ...a);

await page.goto(base);
await ready();
check('served over http(s), the page links the web manifest', await app(() => !!document.querySelector('link[rel=manifest]') && !!document.querySelector('meta[name=theme-color]')));
const man = await app(async () => (await fetch('manifest.webmanifest')).json());
check('manifest: name, standalone, start URL, icons incl. maskable, opens .lcad.json files', man.name === 'DraftOtter' && man.display === 'standalone' && man.start_url === '/' && man.icons.some((i) => i.purpose === 'maskable' && i.sizes === '512x512') && man.file_handlers[0].accept['application/json'].includes('.json'), JSON.stringify(man).slice(0, 200));
const icons = await app(async (list) => Promise.all(list.map(async (s) => (await fetch(s)).status)), man.icons.map((i) => i.src));
check('…its icons load', icons.every((s) => s === 200), icons.join());
await app(() => navigator.serviceWorker.ready);
await page.reload();
await ready();
check('the service worker is installed and in control', await app(() => !!navigator.serviceWorker.controller && navigator.serviceWorker.controller.scriptURL.endsWith('/sw.js')));
const cached = await app(async () => { const keys = await caches.keys(); const c = await caches.open(keys.find((k) => k.startsWith('localcad-'))); return (await c.keys()).map((r) => new URL(r.url).pathname); });
check('…with the app and icons cached', cached.includes('/') && cached.includes('/icons/draftotter-512.png'), cached.join());

// offline: the app still opens and works
await page.setOfflineMode(true);
await page.reload();
await ready();
const off = await app(() => { const a = window.LocalCAD; a.addShape('box'); return a.model.nodes.length > 0 && !!a.engine.geometry(a.model.nodes[a.model.nodes.length - 1]); });
check('with no network, the app still opens and builds shapes', off);
await page.setOfflineMode(false);

// a new deploy: a service worker with a different build → "A new version is ready" → Reload to update
swOverride = readFileSync('web/sw.js', 'utf8').replace(/const BUILD = '[^']*'/, "const BUILD = 'next-build'");
await app(async () => { const r = await navigator.serviceWorker.getRegistration(); await r.update(); });
await page.waitForSelector('.update-toast', { timeout: 20000 }).catch(() => null);
check('after a new deploy, the app offers to update', await app(() => /new version/.test((document.querySelector('.update-toast') || {}).textContent || '')));
const navigated = page.waitForNavigation({ timeout: 30000 }).catch(() => null);
await app(() => [...document.querySelectorAll('.update-toast .btn')].find((b) => /Reload/.test(b.textContent)).click());
await navigated;
await ready();
const now = await app(async () => (await caches.keys()).filter((k) => k.startsWith('localcad-')));
check('…and "Reload to update" switches to it (old cache cleared)', now.join() === 'localcad-next-build', now.join());

// the Connect Claude dialog on the web links the helper downloads
await app(() => window.LocalCAD.claudeDialog());
const links = await app(async () => Promise.all([...document.querySelectorAll('.claude-form a[download]')].map(async (a) => [a.getAttribute('href'), (await fetch(a.href)).status])));
check('Connect Claude offers the extension and helper as downloads', links.length === 2 && links.every(([, s]) => s === 200), JSON.stringify(links));

check('no page errors', errors.length === 0, errors.join(' | '));

// ---------------------------------------------------------------- the install invitation
// Chrome only offers installing when it decides to, so the test plays the browser: a "beforeinstallprompt" event
// whose prompt() is recorded.
const fresh = async ({ ua, outcome = 'accepted', dialogAtReady = false } = {}) => {
	const ctx = await browser.createBrowserContext();
	const p = await ctx.newPage();
	p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
	if (ua) await p.setUserAgent(ua);
	await p.evaluateOnNewDocument((outcome, dialogAtReady) => {
		window.__prompted = 0;
		// timings measured in the page: when the app became ready, when the install card appeared
		new MutationObserver(() => {
			if (!window.__readyAt && document.body && document.body.classList.contains('ready')) {
				window.__readyAt = performance.now();
				if (dialogAtReady) window.LocalCAD.settingsDialog(); // something open the moment the app is ready
			}
			if (!window.__cardAt && document.querySelector('#install-card')) window.__cardAt = performance.now();
		}).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
		if (/iPhone/.test(navigator.userAgent)) return; // Safari has no install prompt
		window.addEventListener('DOMContentLoaded', () => {
			const e = new Event('beforeinstallprompt', { cancelable: true });
			e.prompt = () => { window.__prompted++; };
			e.userChoice = Promise.resolve({ outcome });
			window.dispatchEvent(e);
		});
	}, outcome, dialogAtReady);
	await p.goto(base);
	await p.waitForFunction(() => document.body.classList.contains('ready'), { timeout: 60000 });
	return { ctx, p, ev: (fn, ...a) => p.evaluate(fn, ...a) };
};
const card = (ev) => ev(() => { const c = document.querySelector('#install-card'); return c ? c.textContent : null; });

// a dialog open the moment the app is ready: the card waits for it
let s = await fresh({ dialogAtReady: true });
await wait(5000);
check('no card while a dialog is open', (await card(s.ev)) === null && await s.ev(() => !!document.querySelector('.modal-back')));
await s.ev(() => document.querySelector('.modal-back').remove());
await s.p.waitForSelector('#install-card', { timeout: 8000 }).catch(() => null);
check('…it comes once the dialog is closed', (await card(s.ev)) !== null);
await s.ctx.close();

s = await fresh();
check('when the browser can install it: an "Install app" button in the status bar', await s.ev(() => /Install app/.test((document.querySelector('#st-install') || {}).textContent || '')));
await s.p.waitForSelector('#install-card', { timeout: 10000 }).catch(() => null);
const delay = await s.ev(() => window.__cardAt - window.__readyAt);
check('the card comes a moment after the app is ready (about 1.5 s), not right away', delay >= 1400 && delay < 6000, Math.round(delay) + ' ms');
let txt = await card(s.ev);
check('then a card invites installing', /Install DraftOtter on this device/.test(txt || '') && /Not now/.test(txt) && /Don’t ask again/.test(txt) && /offline/.test(txt), txt);
await wait(500); // after the pop-in
const geo = await s.ev(() => { const r = document.querySelector('.ic-card').getBoundingClientRect(); return { dx: Math.abs(r.left + r.width / 2 - innerWidth / 2), dy: Math.abs(r.top + r.height / 2 - innerHeight / 2), dim: getComputedStyle(document.querySelector('#install-card')).backgroundColor, focus: (document.activeElement && document.activeElement.className) || '' }; });
check('…front and center, over a dimmed app, with Install ready to press', geo.dx < 2 && geo.dy < 2 && geo.dim !== 'rgba(0, 0, 0, 0)' && /ic-main/.test(geo.focus), JSON.stringify(geo));
await wait(600);
await s.p.screenshot({ path: 'test/shots/461-install-card.png' });
await s.ev(() => [...document.querySelectorAll('#install-card .btn')].find((b) => b.textContent === 'Install').click());
await wait(200);
check('Install opens the browser\'s install prompt and tidies up', (await s.ev(() => window.__prompted)) === 1 && (await card(s.ev)) === null && await s.ev(() => !document.querySelector('#st-install')));
await s.ctx.close();

s = await fresh();
await s.p.waitForSelector('#install-card', { timeout: 10000 }).catch(() => null);
await s.ev(() => [...document.querySelectorAll('#install-card .btn')].find((b) => b.textContent === 'Not now').click());
check('Not now closes it and remembers', (await card(s.ev)) === null && await s.ev(() => JSON.parse(localStorage.getItem('localcad-install-prompt')).later > 0));
await s.p.reload();
await s.p.waitForFunction(() => document.body.classList.contains('ready'), { timeout: 60000 });
await wait(6000);
check('…so it doesn\'t come back on the next visit (the status bar button stays)', (await card(s.ev)) === null && await s.ev(() => !!document.querySelector('#st-install')));
await s.ev(() => { localStorage.removeItem('localcad-install-prompt'); window.LocalCAD.showInstallCard(); });
await s.p.keyboard.press('Escape');
check('Esc counts as "not now"', (await card(s.ev)) === null && await s.ev(() => JSON.parse(localStorage.getItem('localcad-install-prompt')).later > 0));
await s.ev(() => { localStorage.removeItem('localcad-install-prompt'); window.LocalCAD.showInstallCard(); });
await s.p.mouse.click(20, 20);
check('…and so does clicking outside the card', (await card(s.ev)) === null && await s.ev(() => JSON.parse(localStorage.getItem('localcad-install-prompt')).later > 0));
check('…but it does after two weeks', await s.ev(() => { localStorage.setItem('localcad-install-prompt', JSON.stringify({ later: Date.now() - 15 * 864e5 })); return window.LocalCAD.shouldOfferInstall(); }));
await s.ev(() => { localStorage.removeItem('localcad-install-prompt'); window.LocalCAD.showInstallCard(); [...document.querySelectorAll('#install-card .btn')].find((b) => /ask again/.test(b.textContent)).click(); });
check('Don\'t ask again: never on its own again', await s.ev(() => !window.LocalCAD.shouldOfferInstall() && JSON.parse(localStorage.getItem('localcad-install-prompt')).never === true));
await s.ctx.close();

s = await fresh({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
await s.p.waitForSelector('#install-card', { timeout: 10000 }).catch(() => null);
txt = await card(s.ev);
check('Safari on iPhone (no install button): the card shows the steps', /Add to Home Screen/.test(txt || '') && /Got it/.test(txt) && !/Not now/.test(txt), txt);
check('…and no status bar button there', await s.ev(() => !document.querySelector('#st-install')));
await s.ctx.close();

check('no page errors in the install checks', errors.length === 0, errors.join(' | '));
await browser.close();
server.close();
console.log(fails ? `${fails} FAILED` : 'pwa: all passed');
process.exit(fails ? 1 : 0);
