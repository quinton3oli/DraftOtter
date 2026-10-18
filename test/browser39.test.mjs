// Loading screen: shown while a design is built at startup, when opening a file and restoring a version.
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';
mkdirSync('test/shots', { recursive: true });
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 600000, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1500, height: 900 } });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const app = (fn, ...a) => page.evaluate(fn, ...a);
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(ok ? 'ok  ' : 'FAIL', name, info); };
const overlay = () => app(() => { const l = document.querySelector('#loading'); return l ? { shown: !l.classList.contains('hidden') && !l.classList.contains('gone'), text: l.querySelector('.ld-text').textContent, sub: l.querySelector('.ld-sub').textContent, title: l.querySelector('.ld-title').textContent, w: l.querySelector('.ld-fill').style.width } : null; });
// sample the loading screen while the page works (it yields between shapes, so evaluate gets through)
const sample = async (until) => { const seen = []; while (!(await until())) { const o = await overlay().catch(() => null); if (o && o.shown) { if (!seen.length) await page.screenshot({ path: 'test/shots/313-loading.png' }).catch(() => {}); seen.push(o); } await wait(30); } return seen; };

await page.goto(pathToFileURL('DraftOtter.html').href);
await page.waitForFunction(() => document.body.classList.contains('ready'));
check('loading screen is gone once ready', !(await overlay()).shown);
// it fades out first; under load that can take a moment
await page.waitForFunction(() => getComputedStyle(document.querySelector('#loading')).display === 'none', { timeout: 3000 }).catch(() => null);
check('…and does not block clicks', await app(() => getComputedStyle(document.querySelector('#loading')).display === 'none'));

// a design with slow shapes: torus holes with fits (odd clearances so nothing is reused from the shape cache)
const doc = await app(() => {
	const a = window.DraftOtter; localStorage.clear(); a.model.doc.nodes = []; a.commit();
	const salt = Math.random() * 0.01;
	for (let i = 0; i < 4; i++) {
		a.addShape('box'); a.addShape('torus');
		const [b, t] = a.model.nodes.slice(-2); b.params.w = 40; b.params.d = 40; b.params.h = 8; b.pos = [i * 50, 0, 4]; t.pos = [i * 50, 0, 4]; t.hole = true; t.fit = 'custom'; t.fitClearance = 0.3 + salt + i * 0.01; t.name = 'Torus cut ' + (i + 1);
		a.commit(); a.setSelection([b.id, t.id]); a.group(); a.model.nodes[a.model.nodes.length - 1].name = 'Plate ' + (i + 1);
	}
	a.commit(); a.autosaveNow();
	return JSON.stringify({ format: 'draftotter', doc: a.model.doc, blobs: a.model.blobs });
});

// 1) startup: reload restores the autosave and builds it behind the loading screen
await page.reload({ waitUntil: 'domcontentloaded' });
const seen = await sample(() => app(() => document.body.classList.contains('ready')).catch(() => false));
check('startup shows the loading screen while building', seen.length > 0, String(seen.length));
check('…naming the shape being built and the count', seen.some((o) => /^Building /.test(o.text) && /of \d+ shapes/.test(o.sub)), JSON.stringify(seen.slice(-2)));
const widths = seen.map((o) => parseInt(o.w, 10)).filter(isFinite);
check('…with a progress bar that moves forward', widths.length >= 1 && widths.every((w, i) => !i || w >= widths[i - 1]), widths.join(','));
await wait(400);
check('…and goes away when the design is shown', !(await overlay()).shown && (await app(() => window.DraftOtter.model.nodes.length)) === 4);

// 2) opening a design file
await app(() => { window.DraftOtter.engine.cache.clear(); });
await app((text) => { window.__open = window.DraftOtter.openProject(new File([text], 'plates.lcad', { type: 'application/json' })).then(() => (window.__opened = true)); }, doc.replace(/"fitClearance":0\.3/g, '"fitClearance":0.31'));
const seen2 = await sample(() => app(() => !!window.__opened));
check('opening a heavy file shows the loading screen with its name', seen2.some((o) => o.title === 'Opening plates.lcad'), JSON.stringify(seen2[0] || null));
await wait(400);
check('…then closes', !(await overlay()).shown);

// 3) a quick open doesn't flash it
await app(() => { window.__shown = 0; const l = document.querySelector('#loading'); new MutationObserver(() => { if (!l.classList.contains('gone')) window.__shown++; }).observe(l, { attributes: true }); });
// (a design file from before the rename: the old format name still opens)
await app(() => window.DraftOtter.openProject(new File([JSON.stringify({ format: 'localcad', doc: { ...window.DraftOtter.model.emptyDoc(), nodes: [] } })], 'empty.lcad')));
check('a quick open does not flash the loading screen', (await app(() => window.__shown)) === 0);

// sizes from rounded scales snap to the micron (1.03333 × 60 = 61.9998 → 62)
const sc = await app(() => {
	const a = window.DraftOtter; a.model.doc.nodes = []; a.addShape('box'); a.addShape('cylinder');
	const [b, c] = a.model.nodes; b.params.w = 60; b.params.d = 45; b.params.h = 7; b.scale = [1.03333, -1.04444, 1]; c.params.r = 5; c.params.h = 12; c.scale = [1.01, 1, 0.83333];
	a.commit();
	const size = (n) => { const g = a.engine.geometry(n); return [0, 1, 2].map((i) => Math.abs(n.scale[i]) * (g.boundingBox.max.getComponent(i) - g.boundingBox.min.getComponent(i))); };
	return { b: size(b), c: size(c), bs: b.scale, cs: c.scale };
});
check('rounded scales give exact sizes (62 × 47, mirrored Y kept)', Math.abs(sc.b[0] - 62) < 1e-9 && Math.abs(sc.b[1] - 47) < 1e-5 && sc.bs[1] < 0, JSON.stringify(sc));
check('…cylinder 10 tall, clean scales left alone', Math.abs(sc.c[2] - 10) < 1e-9 && sc.cs[0] === 1.01 && sc.cs[1] === 1, JSON.stringify(sc));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'browser39: all passed');
process.exit(fails ? 1 : 0);
