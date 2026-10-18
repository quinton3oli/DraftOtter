// Background geometry workers: slow rebuilds run off the main thread (several at once), the page does no slow
// geometry work meanwhile, and the results match building on the main thread.
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 600000, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1500, height: 900 } });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(pathToFileURL('DraftOtter.html').href);
await page.waitForFunction(() => document.body.classList.contains('ready'));
const app = (fn, ...a) => page.evaluate(fn, ...a);
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(ok ? 'ok  ' : 'FAIL', name, info); };

const pool = await app(async () => { const p = window.DraftOtter.engine.pool; await p.start(); return { ok: p.ok, n: p.workers.length }; });
check('background geometry workers start', pool.ok && pool.n >= 1, JSON.stringify(pool));

// four plates, each cut by a torus hole with a fit (no shortcut: the slow general growth); fresh clearances each
// time so nothing comes from the saved-shape cache
await app(() => {
	const a = window.DraftOtter; a.model.settings.backgroundBuild = false; a.model.doc.nodes = [];
	for (let i = 0; i < 4; i++) {
		a.addShape('box'); a.addShape('torus');
		const [b, t] = a.model.nodes.slice(-2);
		b.params.w = 34; b.params.d = 34; b.params.h = 6; b.pos = [i * 40, 0, 3];
		Object.assign(t.params, { R: 10, r: 2.5, seg: 32, seg2: 14 }); t.pos = [i * 40, 0, 6]; t.hole = true; t.fit = 'custom'; t.fitClearance = 0.3 + Math.random() * 0.05; t.fitAxes = 'xy'; t.name = 'Ring ' + (i + 1);
		a.commit(); a.setSelection([b.id, t.id]); a.group(); a.model.nodes[a.model.nodes.length - 1].name = 'Plate ' + (i + 1);
	}
});
const vols = () => app(() => window.DraftOtter.model.nodes.map((n) => +window.DraftOtter.engine.stats([n]).volume.toFixed(3)));
const vSync = await vols();
// the same design rebuilt by the workers
const vAsync = await app(async () => { const a = window.DraftOtter, E = a.engine; E.cache.clear(); E.lastById.clear(); await E.buildAsync(a.model.nodes); return a.model.nodes.map((n) => +E.stats([n]).volume.toFixed(3)); });
check('built in the background, the result matches building on the main thread', vAsync.every((v, i) => Math.abs(v - vSync[i]) < 0.05), JSON.stringify({ vSync, vAsync }));
// equal work, one after another vs in parallel
const speed = await app(async () => {
	const a = window.DraftOtter, E = a.engine, p = E.pool, rings = () => a.model.nodes.map((n) => n.children[1]);
	const fresh = () => { for (const r of rings()) r.fitClearance = 0.3 + Math.random() * 0.05; };
	fresh(); E.setPool(null); let t0 = performance.now(); await E.buildAsync(a.model.nodes); const seq = performance.now() - t0; E.setPool(p);
	fresh(); t0 = performance.now(); await E.buildAsync(a.model.nodes); const par = performance.now() - t0;
	return { seq: Math.round(seq), par: Math.round(par) };
});
check(`…in parallel: faster than one after another (${speed.seq} ms → ${speed.par} ms)`, pool.n === 1 || speed.par < speed.seq * 0.7, `${pool.n} workers`);

// an edit to a part that was slow before goes to the background: commit returns at once, and no slow geometry
// work happens on the page meanwhile (handles and picking use the last shape until the new one is ready)
const before = await vols();
const edit = await app(async () => {
	const a = window.DraftOtter, E = a.engine; a.model.settings.backgroundBuild = true; a.afterChange();
	const ring = a.model.nodes[2].children[1];
	ring.fitClearance += 0.0037;
	const og = E.geometry.bind(E), slowHere = [];
	E.geometry = (n) => { const t = performance.now(); const g = og(n); const d = performance.now() - t; if (d > 60 && !E.inBuild && a.model.get(n.id)) slowHere.push(n.name + ' ' + Math.round(d)); return g; };
	const t0 = performance.now(); a.commit(); const commitMs = performance.now() - t0;
	const busy = !!a.bgBuild;
	await a.bgBuild;
	E.geometry = og;
	return { commitMs: Math.round(commitMs), busy, slowHere, cached: E.cache.has(E.key(a.model.nodes[2])) };
});
check('an edit to a slow part rebuilds in the background (commit returns right away)', edit.busy && edit.commitMs < 120 && edit.cached, JSON.stringify(edit));
check('…without slow geometry work on the page meanwhile', edit.slowHere.length === 0, JSON.stringify(edit.slowHere));
const v2 = await vols();
check('…with the right result (only the edited plate changes)', Math.abs(v2[2] - before[2]) > 0.01 && Math.abs(v2[0] - before[0]) < 1e-6, JSON.stringify({ before, after: v2 }));
// edits made while a build runs are picked up before drawing
const twice = await app(async () => {
	const a = window.DraftOtter; const r1 = a.model.nodes[1].children[1], r3 = a.model.nodes[3].children[1];
	r1.fitClearance += 0.0041; a.commit();
	r3.fitClearance += 0.0043; a.commit();
	await a.bgBuild;
	return [1, 3].map((i) => a.engine.cache.has(a.engine.key(a.model.nodes[i])));
});
check('changes made during a build are included before drawing', twice.every(Boolean), JSON.stringify(twice));
// quick edits stay on the main thread
const quick = await app(() => { const a = window.DraftOtter; a.addShape('box'); return !a.bgBuild; });
check('quick edits still update at once', quick);

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'browser42: all passed');
process.exit(fails ? 1 : 0);
