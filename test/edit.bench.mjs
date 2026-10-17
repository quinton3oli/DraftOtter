// Everyday-editing benchmark on a big design: how long a small edit, selecting, autosave, the UI refresh, a frame
// and switching tabs take. Not part of npm test; run: node test/edit.bench.mjs
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';

const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 900000, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-precise-memory-info'], defaultViewport: { width: 1500, height: 900 } });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto(pathToFileURL('LocalCAD.html').href);
await page.waitForFunction(() => document.body.classList.contains('ready'));
const app = (fn, ...a) => page.evaluate(fn, ...a);

const built = await app(async () => {
	localStorage.clear();
	const a = window.LocalCAD;
	const settle = async () => { for (let i = 0; i < 100 && a.bgBuild; i++) await a.bgBuild; };
	a.model.doc.nodes = [];
	a.model.doc.vars = [{ name: 'wall', expr: '2' }, { name: 'hole', expr: '3.2' }];
	const make = (type, params, extra) => { const n = { id: 'n' + Math.random().toString(36).slice(2, 10), seq: Date.now() * 1000 + Math.floor(Math.random() * 1e6), type, name: type, params, pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1], color: '#e8613a', visible: true, locked: false, hole: false, ...extra }; return n; };
	// 30 plates, each a group with two holes; 60 loose parts
	for (let i = 0; i < 30; i++) {
		const plate = make('box', { w: 30, d: 20, h: 4, radius: 1, edgeType: 'fillet', seg: 4 });
		const h1 = make('cylinder', { r: 2, h: 10, seg: 32, edgeType: 'chamfer', topEdge: 0, bottomEdge: 0 }, { hole: true, pos: [-8, 0, 0] });
		const h2 = make('cylinder', { r: 2, h: 10, seg: 32, edgeType: 'chamfer', topEdge: 0, bottomEdge: 0 }, { hole: true, pos: [8, 0, 0] });
		a.model.nodes.push({ ...make('group', {}), type: 'group', mode: 'union', name: 'Plate ' + i, children: [plate, h1, h2], expanded: false, pos: [(i % 6) * 40 - 100, Math.floor(i / 6) * 30 - 60, 2] });
	}
	for (let i = 0; i < 60; i++) a.model.nodes.push(make(i % 2 ? 'cylinder' : 'box', i % 2 ? { r: 4, h: 10, seg: 48, edgeType: 'chamfer', topEdge: 0, bottomEdge: 0 } : { w: 8, d: 8, h: 8, radius: 0, edgeType: 'fillet', seg: 4 }, { pos: [(i % 10) * 15 - 70, Math.floor(i / 10) * 15 + 100, 5] }));
	a.commit();
	await settle();
	// a sculpted part (~200k triangles)
	a.addShape('sphere');
	const s = a.model.nodes[a.model.nodes.length - 1];
	s.params.r = 30; s.pos = [150, 0, 30];
	a.commit();
	await settle();
	a.setSelection([s.id]);
	a.startSculpt(s);
	[...document.querySelectorAll('.modal .btn')].find((b) => b.textContent === 'Start sculpting').click();
	for (let i = 0; i < 200 && !a.sculpt; i++) await new Promise((r) => setTimeout(r, 50));
	const ses = a.sculpt.session;
	ses.beginStroke('draw'); ses.dab('draw', [0, 0, 30], { radius: 8, strength: 1, falloff: 'smooth', symmetry: [false, false, false] }); ses.endStroke();
	a.sculpt.modified = true;
	a.exitSculpt(true);
	await settle();
	// some history
	for (let i = 0; i < 15; i++) { a.model.nodes[30 + (i % 30)].params.h = 8 + i; a.commit(); a.histCommit('step ' + i); }
	await settle();
	const json = a.model.serialize();
	return { parts: a.model.nodes.length, tris: a.engine.stats(a.model.nodes).tris, fileMB: +(json.length / 1e6).toFixed(2) };
});
console.log('design:', JSON.stringify(built));

const times = await app(async () => {
	const a = window.LocalCAD;
	const settle = async () => { for (let i = 0; i < 100 && a.bgBuild; i++) await a.bgBuild; };
	const med = async (fn, n = 7) => { const t = []; for (let i = 0; i < n; i++) { const t0 = performance.now(); await fn(i); t.push(performance.now() - t0); } t.sort((x, y) => x - y); return Math.round(t[Math.floor(n / 2)] * 10) / 10; };
	const loose = a.model.nodes[40]; // a box
	const out = {};
	out.editLoosePart = await med(async (i) => { loose.params.w = 8 + i * 0.37; a.commit(); await settle(); });
	out.editHoleInGroup = await med(async (i) => { a.model.nodes[3].children[1].params.r = 2 + i * 0.013; a.commit(); await settle(); });
	const big = a.model.nodes.find((n) => n.type === 'mesh');
	out.moveBigMesh = await med(async (i) => { big.pos = [150 + i, 0, 30]; a.commit(); await settle(); });
	out.editVariable = await med(async (i) => { a.model.doc.vars[0].expr = String(2 + i * 0.1); a.commit(); await settle(); });
	out.select = await med(async (i) => { a.setSelection([a.model.nodes[i + 5].id]); });
	out.refreshUI = await med(async () => { a.refreshUI(); });
	out.afterChange = await med(async () => { a.afterChange(); });
	out.autosave = await med(async () => { a.autosaveNow(); });
	const gl = a.vp.renderer.getContext();
	out.renderFrame = await med(async () => { a.vp.render(); gl.finish(); });
	out.histDirty = await med(async () => { a.histDirty(); });
	out.isDirty = await med(async () => { a.isDirty(); });
	out.snapshot = await med(async () => { JSON.stringify(a.model.designState()); });
	out.serialize = await med(async () => { a.model.serialize(); }, 3);
	await a.newTab();
	await settle();
	out.switchTab = await med(async (i) => { await a.switchTab(i % 2 === 0 ? 0 : 1); await settle(); }, 4);
	out.heapMB = Math.round(performance.memory.usedJSHeapSize / 1e6);
	return out;
});
for (const [k, v] of Object.entries(times)) console.log(k.padEnd(16), v, k === 'heapMB' ? 'MB' : 'ms');
// dragging a part with the mouse: time per pointer move (until the next frame is drawn)
await app(async () => { const a = window.LocalCAD; await a.switchTab(0); a.setSelection([a.model.nodes[40].id]); a.vp.setView('top'); a.frame(); });
await new Promise((r) => setTimeout(r, 800));
const at = await app(() => { const a = window.LocalCAD, vp = a.vp; vp.render(); const n = a.model.nodes[40]; const p = vp.project(new (vp.camera.position.constructor)(...n.pos)); const r = vp.canvas.getBoundingClientRect(); return { x: r.left + p.x, y: r.top + p.y }; });
await page.mouse.move(at.x, at.y);
await page.mouse.down();
const t0 = Date.now();
for (let i = 1; i <= 30; i++) { await page.mouse.move(at.x + i * 4, at.y + i * 2); await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r()))); }
const dragMs = (Date.now() - t0) / 30;
await page.mouse.up();
console.log('dragPerMove'.padEnd(16), Math.round(dragMs), 'ms (incl. test overhead)');
await browser.close();
