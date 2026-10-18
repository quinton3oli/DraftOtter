// Round dimensions: sizes, positions, scaled sizes and angles snapped to a chosen step, with a preview and undo.
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 240000, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1500, height: 900 } });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(pathToFileURL('DraftOtter.html').href);
await page.waitForFunction(() => document.body.classList.contains('ready'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const app = (fn, ...a) => page.evaluate(fn, ...a);
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(ok ? 'ok  ' : 'FAIL', name, info); };
const modalBtn = (label) => app((label) => [...document.querySelectorAll('.modal .btn')].find((b) => b.textContent.trim() === label).click(), label);
const state = () => app(() => window.DraftOtter.model.nodes.map((n) => ({ p: { ...n.params }, pos: n.pos.slice(), rot: n.rot.slice(), scale: n.scale.slice() })));

await app(() => {
	localStorage.clear(); const a = window.DraftOtter; a.model.doc.nodes = []; a.commit();
	a.addShape('box'); a.addShape('cylinder'); a.addShape('box');
	const [b, c, d] = a.model.nodes;
	b.params.w = 10.4567; b.params.d = 20.0049; b.params.h = 5; b.pos = [1.2344, -7.891, 2.5]; b.rot = [0, 0, 12.345];
	c.params.r = 4.987; c.params.h = 12; c.scale = [1, 1, 0.8347]; c.pos = [30, 0.004, 5.0082];
	a.model.doc.vars = [{ name: 'wall', expr: '2.345' }];
	d.params.w = 2.345; d.exprs = { 'params.w': 'wall' }; d.params.d = 8.888; d.pos = [-30, 0, 4];
	a.commit(); a.setSelection([]);
});
const before = await state();
await app(() => window.DraftOtter.roundDialog());
await wait(200);
const opts = await app(() => ({ scopeSelDisabled: document.querySelector('.modal input[name=rd-scope][value=sel]').disabled, all: document.querySelector('.modal input[name=rd-scope][value=all]').checked, step: document.querySelector('#rd-step').value, note: document.querySelector('#rd-note').textContent }));
check('with nothing selected it rounds the whole design, 0.01 mm by default', opts.scopeSelDisabled && opts.all && opts.step === '0.01', JSON.stringify(opts));
check('preview says how many values change and by how much', /values will change — the largest by/.test(opts.note) && /set by expressions stays? as/.test(opts.note), opts.note);
check('previewing changes nothing yet', JSON.stringify(await state()) === JSON.stringify(before));
await modalBtn('Round');
await wait(300);
const [b, c, d] = await state();
check('sizes rounded to 0.01 mm', b.p.w === 10.46 && b.p.d === 20 && c.p.r === 4.99, JSON.stringify([b.p, c.p]));
check('positions rounded', b.pos.join() === '1.23,-7.89,2.5' && c.pos.join() === '30,0,5.01', JSON.stringify([b.pos, c.pos]));
check('rotations to 0.1°', b.rot[2] === 12.3, String(b.rot));
const cylH = await app(() => { const n = window.DraftOtter.model.nodes[1]; const g = window.DraftOtter.engine.geometry(n); return +((g.boundingBox.max.z - g.boundingBox.min.z) * n.scale[2]).toFixed(9); });
check('a size made by scaling is rounded too (12 × 0.8347 = 10.0164 → 10.02)', cylH === 10.02, String(cylH));
check('values set by expressions are left alone', d.p.w === 2.345 && d.p.d === 8.89, JSON.stringify(d.p));
const und = await app(() => { const a = window.DraftOtter; a.undo(); const r = a.model.nodes[0].params.w; a.redo(); return r; });
check('one undo takes it all back', und === 10.4567, String(und));

// selection only, custom step
await app(() => { const a = window.DraftOtter; a.model.nodes[0].params.w = 10.4567; a.model.nodes[2].params.d = 8.888; a.commit(); a.setSelection([a.model.nodes[0].id]); a.roundDialog(); });
await wait(200);
await app(() => { const s = document.querySelector('#rd-step'); s.value = 'custom'; s.dispatchEvent(new Event('change', { bubbles: true })); const i = document.querySelector('#rd-custom'); i.value = '0.25'; i.dispatchEvent(new Event('input')); });
await modalBtn('Round');
await wait(300);
const s2 = await state();
check('custom step 0.25 mm on the selection only', s2[0].p.w === 10.5 && s2[2].p.d === 8.888, JSON.stringify([s2[0].p.w, s2[2].p.d]));
check('the menu has the command', await app(() => { const a = window.DraftOtter; let found = false; const orig = a.menu; a.menu = (anc, items) => { found = items.some((it) => it && /Round dimensions/.test(it[0])); }; a.toolsMenu(document.body); a.menu = orig; return found; }));

// float noise is cleaned up on every change, so parts that should be flush are flush
const tidy = await app(() => {
	const a = window.DraftOtter; a.model.doc.nodes = []; a.commit();
	a.addShape('box'); a.addShape('box'); a.addShape('box');
	const [p, q, r] = a.model.nodes;
	for (const b of [p, q]) { b.params.w = 20; b.params.d = 20; b.params.h = 10; }
	p.pos = [0, 0, 5]; q.pos = [0.00004, -0.0001, 15]; // should sit exactly on top, flush
	r.params.w = 46.99995; r.params.d = 12.3456; r.pos = [40.12345, 0, 5];
	r.type = 'facex'; r.params = { loops: [[[0, 0], [46.99992, 0], [46.99992, 1.99996], [0, 1.99996]]], depth: 3.00001, draft: 0 };
	a.commit();
	return { q: q.pos, r: r.pos, loops: r.params.loops, depth: r.params.depth };
});
check('position noise snaps; push/pull placement goes to the micron', tidy.q.join() === '0,0,15' && tidy.r.join() === '40.123,0,5', JSON.stringify(tidy));
check('float noise in outlines and sizes snaps (46.99992 → 47, 1.99996 → 2)', JSON.stringify(tidy.loops) === '[[[0,0],[47,0],[47,2],[0,2]]]' && tidy.depth === 3, JSON.stringify(tidy));
const kept = await app(() => { const a = window.DraftOtter; a.addShape('box'); const n = a.model.nodes[a.model.nodes.length - 1]; n.params.w = 12.3456; a.commit(); return n.params.w; });
check('real values that are not noise are kept (12.3456)', kept === 12.3456, String(kept));
const flush = await app(() => {
	const a = window.DraftOtter; const [p, q] = a.model.nodes; a.setSelection([p.id, q.id]); a.group();
	const g = a.engine.geometry(a.model.nodes.find((n) => n.type === 'group'));
	const xs = new Set(); const pa = g.attributes.position; for (let i = 0; i < pa.count; i++) if (pa.getX(i) > 9) xs.add(+pa.getX(i).toFixed(6));
	return [...xs];
});
check('stacked boxes placed 0.04 µm apart join flush (one side face, no step)', flush.length === 1 && flush[0] === 10, JSON.stringify(flush));
const rl = await app(() => {
	const a = window.DraftOtter; a.model.doc.nodes = []; a.addShape('box'); const n = a.model.nodes[0];
	n.type = 'facex'; n.params = { loops: [[[0, 0], [46.9912, 0], [46.9912, 2.0049], [0, 2.0049]]], depth: 3, draft: 0 }; a.commit();
	a.roundDimensions({ step: 0.01, angleStep: 0.1, scope: 'all', sizes: true, positions: true, angles: false }, true); a.commit();
	return n.params.loops;
});
check('Round dimensions also rounds outlines (push/pull, sketches)', JSON.stringify(rl) === '[[[0,0],[46.99,0],[46.99,2],[0,2]]]', JSON.stringify(rl));

const ppr = await app(() => {
	const a = window.DraftOtter; a.model.doc.nodes = []; a.addShape('box'); const n = a.model.nodes[0];
	n.type = 'facex'; n.params = { loops: [[[0, 0], [46.9997, 0], [46.9997, 1.9996], [0.0004, 1.9996]]], depth: 3.0004, draft: 0 }; n.pos = [-33.9997, 30.5003, 0.0004]; a.commit();
	return { loops: n.params.loops, depth: n.params.depth, pos: n.pos };
});
check('push/pull features are rounded to whole microns (outline, depth, placement)', JSON.stringify(ppr) === JSON.stringify({ loops: [[[0, 0], [47, 0], [47, 2], [0, 2]]], depth: 3, pos: [-34, 30.5, 0] }), JSON.stringify(ppr));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'browser40: all passed');
process.exit(fails ? 1 : 0);
