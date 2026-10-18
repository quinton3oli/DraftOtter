// Push/pull follows edits made before it: the face it was made on is found again when the part changes, for flat faces
// (extrude / cut), faces with rounded edges (face move) and curved walls (surface offset). Unchanged parts don't shift,
// and push/pulls saved before this (no remembered face) still build as they were.
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
const cv = await (await page.$('#viewport canvas')).boundingBox();
const screen = (x, y, z) => app(([x, y, z]) => { const vp = window.DraftOtter.vp; vp.render(); return vp.project(vp.camera.position.clone().set(x, y, z)); }, [x, y, z]);
const pushAt = async (x, y, z, dist) => {
	await app(() => { const a = window.DraftOtter; a.setTool(null); a.setSelection([]); a.frame(); });
	await wait(400);
	await page.keyboard.press('u');
	const p = await screen(x, y, z);
	await page.mouse.move(cv.x + p.x, cv.y + p.y, { steps: 3 });
	await page.mouse.click(cv.x + p.x, cv.y + p.y);
	await wait(150);
	await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
	await page.keyboard.type(String(dist));
	await page.keyboard.press('Enter');
	await wait(700);
	await app(() => window.DraftOtter.setTool(null));
};
const box = (params) => app((params) => {
	localStorage.clear();
	const a = window.DraftOtter; a.setTool(null); a.model.doc.nodes = []; a.sel = []; a.commit();
	a.addShape('box'); const b = a.model.nodes[0]; Object.assign(b.params, { radius: 0, ...params }); b.pos = [0, 0, params.h / 2]; a.commit(); a.setSelection([]); a.frame();
}, params);
const state = () => app(() => {
	const a = window.DraftOtter, g = a.model.nodes[0], b = a.worldBox(g);
	return { kids: g.children ? g.children.map((c) => c.type + (c.hole ? '(hole)' : '')).join(',') : g.type, vol: a.engine.stats([g]).volume, min: b.min.toArray(), max: b.max.toArray(), err: a.engine.errors.has(g.id), ref: !!(g.children && g.children.at(-1).params.ref) };
});
// change the box at the bottom of the part (it keeps its base on the bed)
const edit = (params) => app((params) => { const a = window.DraftOtter, b = a.model.nodes[0].children[0]; Object.assign(b.params, params); if (params.h) b.pos = [b.pos[0], b.pos[1], b.pos[2] + (params.h - (b._h || 0))]; a.commit(); }, params);
const near = (a, b, tol = 0.05) => Math.abs(a - b) <= tol;

// ---- flat face: extrude the top 10 mm, then make the box taller and wider
await box({ w: 40, d: 30, h: 20 });
await wait(300);
await pushAt(4, 3, 20, 10);
let s = await state();
check('a new push/pull remembers its face', s.kids === 'box,facex' && s.ref && near(s.max[2], 30, 1e-3), JSON.stringify(s));
await app(() => { const a = window.DraftOtter, b = a.model.nodes[0].children[0]; b.params.h = 30; b.pos = [b.pos[0], b.pos[1], b.pos[2] + 5]; a.commit(); });
await wait(300);
s = await state();
check('making the box 10 mm taller: the pull starts from the new top (part is 40 mm tall)', near(s.max[2], 40, 1e-3) && near(s.vol, 40 * 30 * 40) && !s.err, JSON.stringify(s));
await app(() => { const a = window.DraftOtter, b = a.model.nodes[0].children[0]; b.params.w = 60; a.commit(); });
await wait(300);
s = await state();
check('making it wider: the pull covers the whole new top', near(s.vol, 60 * 30 * 40) && near(s.max[0] - s.min[0], 60, 1e-3) && !s.err, JSON.stringify(s));
// unchanged: rebuilding gives exactly the same part
const v1 = s.vol;
await app(() => window.DraftOtter.commit());
s = await state();
check('…and an unchanged part rebuilds exactly the same', s.vol === v1, `${s.vol} vs ${v1}`);

// ---- a cut into a side face follows the face when the box gets deeper
await box({ w: 40, d: 30, h: 20 });
await wait(300);
await pushAt(20, 2, 10, -5);
s = await state();
check('cutting 5 mm into the side face', s.kids === 'box,facex(hole)' && near(s.max[0], 15, 1e-3), JSON.stringify(s));
await app(() => { const a = window.DraftOtter, b = a.model.nodes[0].children[0]; b.params.w = 50; a.commit(); });
await wait(300);
s = await state();
check('widening the box: the cut moves with the side face (still 5 mm deep)', near(s.max[0], 20, 1e-3) && near(s.vol, 45 * 30 * 20) && !s.err, JSON.stringify(s));

// ---- rounded edges: pull the top of a rounded box, then make the box taller
await box({ w: 40, d: 30, h: 20, radius: 3, edgeType: 'fillet', seg: 8 });
await wait(300);
await pushAt(4, 3, 20, 10);
s = await state();
check('a rounded top pulled 10 mm (face move, remembered)', s.kids === 'box,facemove' && s.ref && near(s.max[2], 30, 1e-3), JSON.stringify(s));
await app(() => { const a = window.DraftOtter, b = a.model.nodes[0].children[0]; b.params.h = 30; b.pos = [b.pos[0], b.pos[1], b.pos[2] + 5]; a.commit(); });
await wait(300);
s = await state();
const ref40 = await app(() => { const a = window.DraftOtter, e = a.engine, n = { id: 'r' + Math.random(), type: 'box', params: { ...a.model.nodes[0].children[0].params, h: 40 }, pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1] }; return e.stats([n]).volume; });
check('making the box taller: the rounded top moves up with it — the same as a rounded box 40 mm tall', near(s.max[2], 40, 1e-3) && near(s.vol, ref40) && !s.err, `${JSON.stringify(s)} ref ${ref40}`);

// ---- curved wall: a cube rounded on its upright edges, its wall pulled out 5 mm; then the cube gets wider
await app(() => {
	localStorage.clear();
	const a = window.DraftOtter; a.setTool(null); a.model.doc.nodes = []; a.sel = []; a.commit();
	a.addShape('cylinder'); const c = a.model.nodes[0]; Object.assign(c.params, { r: 15, h: 20, seg: 64 }); c.pos = [0, 0, 10]; a.commit(); a.setSelection([]); a.frame();
});
await wait(300);
await pushAt(0, -15, 10, 5);
s = await state();
check('a cylinder wall pulled out 5 mm (remembered)', s.kids === 'cylinder,faceoff' && s.ref && near(s.max[0] - s.min[0], 40, 0.05), JSON.stringify(s));
await app(() => { const a = window.DraftOtter, c = a.model.nodes[0].children[0]; c.params.r = 20; a.commit(); });
await wait(300);
s = await state();
check('making the cylinder bigger: the wall is pulled out from its new size (50 mm across)', near(s.max[0] - s.min[0], 50, 0.1) && !s.err, JSON.stringify(s));

// ---- a push/pull saved before faces were remembered still builds as it was
await box({ w: 40, d: 30, h: 20 });
await wait(300);
await pushAt(4, 3, 20, 10);
await app(() => { const a = window.DraftOtter, f = a.model.nodes[0].children[1]; delete f.params.ref; a.commit(); });
s = await state();
check('an older push/pull (no remembered face) builds as before', s.kids === 'box,facex' && near(s.max[2], 30, 1e-3) && near(s.vol, 40 * 30 * 30) && !s.err, JSON.stringify(s));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'browser63: all passed');
process.exit(fails ? 1 : 0);
