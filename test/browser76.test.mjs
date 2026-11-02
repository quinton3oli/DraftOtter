// The last rounding gaps. (1) Shapes are built in 32-bit, where a box 64.13 wide has its corners at 32.06499863: two
// such boxes side by side met 3.8 µm apart (two pieces with walls between them). Each corner is now taken at the value
// it stands for, and parts are placed in full precision — also in the background workers. (2) A cut made before
// push/pulls remembered their face is set exactly onto its face (its stored outline 0.02 mm off is not used), still cut
// together with the other holes. (3) A curved push/pull is rebuilt from the part's surface as it is, in 64-bit: one
// whose stored points older versions rounded to the micron gives the same solid as a fresh one. (4) Turning a part
// freely with the gizmo keeps the exact angle and place (no rounding to 0.001° / 0.1 µm). (5) "Line them up" also works
// on slanted faces, and leaves a pin in a hole with a tiny clearance alone.
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 240000, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1400, height: 900 } });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(pathToFileURL('DraftOtter.html').href);
await page.waitForFunction(() => document.body.classList.contains('ready'));
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(ok ? 'ok  ' : 'FAIL', name, info); };
const app = (fn, ...a) => page.evaluate(fn, ...a);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// helpers in the page: load nodes; flat X/Y/Z face planes and separate pieces of the whole design
await app(() => {
	const a = window.DraftOtter;
	window.T = {
		base: { rot: [0, 0, 0], scale: [1, 1, 1], color: '#e8613a', visible: true, locked: false, hole: false },
		box(id, w, d, h, pos, extra = {}) { return { ...T.base, id, type: 'box', name: id, params: { w, d, h, radius: 0, edgeType: 'fillet', seg: 4 }, pos, ...extra }; },
		async load(nodes) { a.model.doc.nodes = nodes; a.sel = []; a.commit(); for (let i = 0; i < 200 && a.bgBuild; i++) await a.bgBuild; },
		measure(g) {
			const pos = g.attributes.position, C = a.vp.camera.position.constructor, P = { x: new Set(), y: new Set(), z: new Set() };
			let thin = 0;
			for (let i = 0; i < pos.count; i += 3) {
				const q = [0, 1, 2].map((k) => new C().fromBufferAttribute(pos, i + k));
				const cr = q[1].clone().sub(q[0]).cross(q[2].clone().sub(q[0])), area = cr.length() / 2, nn = cr.clone().normalize();
				const long = Math.max(q[0].distanceTo(q[1]), q[1].distanceTo(q[2]), q[2].distanceTo(q[0]));
				const flat = ['x', 'y', 'z'].findIndex((ax, k) => Math.abs(Math.abs(nn.getComponent(k)) - 1) < 1e-6);
				if (flat >= 0) P['xyz'[flat]].add(+q[0].getComponent(flat).toFixed(5));
				else if (area > 0 && (2 * area) / long < 1e-3) thin++;
			}
			const s = (set) => [...set].sort((p, q) => p - q);
			return { x: s(P.x), y: s(P.y), z: s(P.z), thin, tris: pos.count / 3 };
		},
		state() { const n = a.model.nodes, g = a.engine.printable(n, true); return { ...T.measure(g), vol: a.engine.stats(n).volume, pieces: a.engine.stats(n) && (a.checkPrint().items.find((i) => i.kind === 'floating') || {}).title }; },
	};
});

// ---- (1) two 64.13 mm boxes side by side, in a plain union (built on the main thread, then by the background workers)
let r = await app(async () => {
	await T.load([{ ...T.base, id: 'g1', type: 'group', name: 'Pair', mode: 'union', pos: [0, 0, 0], children: [T.box('A', 64.13, 20, 10, [0, 0, 5]), T.box('B', 64.13, 20, 10, [64.13, 0, 5])] }]);
	const a = window.DraftOtter, main = T.state();
	// the same group again, combined by a background worker (each part sent with the matrix that places it)
	let worker = null;
	if (a.engine.pool) {
		a.engine.cache.clear(); a.engine.mcache.clear();
		await a.engine.buildAsync(a.model.nodes, () => {});
		worker = T.state();
	}
	return { main, worker, want: 2 * 64.13 * 20 * 10 };
});
check('two 64.13 mm boxes side by side join into one block (faces only at the ends, x -32.065 and 96.195)', JSON.stringify(r.main.x) === '[-32.065,96.195]' && /No floating|separate pieces/.test(r.main.pieces) && !/2 separate/.test(r.main.pieces) && Math.abs(r.main.vol - r.want) < r.want * 1e-6, JSON.stringify(r.main));
check('…the same when a background worker combines them', !r.worker || (JSON.stringify(r.worker.x) === '[-32.065,96.195]' && Math.abs(r.worker.vol - r.want) < r.want * 1e-6), JSON.stringify(r.worker));

// ---- (2) an older cut (no remembered face) whose stored outline stops 0.02 mm short of its face's edge (it left a
// 0.02 mm wall standing there), with another hole after it
r = await app(async () => {
	await T.load([{ ...T.base, id: 'g1', type: 'group', name: 'Box', mode: 'union', pos: [0, 0, 0], children: [
		T.box('A', 20, 20, 10, [0, 0, 5]),
		{ ...T.base, id: 'f1', type: 'facex', name: 'Push/pull (cut)', hole: true, pos: [0, 0, 10], params: { loops: [[[-10, -10], [10, -10], [10, 9.98], [-10, 9.98]]], depth: -2, draft: 0 } }, // 0.02 short of the face's edge
		T.box('H', 4, 4, 20, [0, 0, 5], { hole: true }),
	] }]);
	return T.state();
});
check('an older cut is set exactly onto its face: top cut down to z 8 all across it, no 0.02 mm wall left at its edge', JSON.stringify(r.z) === '[0,8]' && JSON.stringify(r.y) === '[-10,-2,2,10]' && r.thin === 0, JSON.stringify(r));
check('…and the hole after it still cuts (cut together as before)', Math.abs(r.vol - (20 * 20 * 8 - 4 * 4 * 8)) < 1e-6, JSON.stringify(r.vol));

// ---- (3) a curved push/pull made with the tool on a cylinder, then its stored points rounded to the micron as older
// versions saved them: it still builds exactly the same solid
await app(() => { const a = window.DraftOtter; a.setTool(null); a.model.doc.nodes = []; a.sel = []; a.commit(); a.addShape('cylinder'); const c = a.model.nodes[0]; Object.assign(c.params, { r: 15, h: 20, seg: 64 }); c.pos = [0, 0, 10]; a.commit(); a.setSelection([]); a.vp.setView('iso'); a.frame(); });
await wait(400);
const cv = await (await page.$('#viewport canvas')).boundingBox();
const sp = await app(() => { const vp = window.DraftOtter.vp; vp.render(); return vp.project(new (vp.camera.position.constructor)(0, -15, 10)); });
await page.keyboard.press('u');
await page.mouse.move(cv.x + sp.x, cv.y + sp.y, { steps: 3 });
await page.mouse.click(cv.x + sp.x, cv.y + sp.y);
await wait(150);
await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
await page.keyboard.type('5');
await page.keyboard.press('Enter');
await wait(800);
r = await app(async () => {
	const a = window.DraftOtter;
	a.setTool(null);
	for (let i = 0; i < 200 && a.bgBuild; i++) await a.bgBuild;
	const g = a.model.nodes[0], f = g.children && g.children.at(-1);
	if (!f || f.type !== 'faceoff') return { kids: g.children ? g.children.map((c) => c.type).join() : g.type };
	const fresh = { vol: a.engine.stats([g]).volume, ...T.measure(a.engine.printable([g], true)) };
	// as an older version saved it: every stored point rounded to the micron
	const snap = (v) => Math.round(v * 1000) / 1000;
	f.params.V = f.params.V.map((p) => p.map(snap));
	a.engine.cache.clear(); a.engine.mcache.clear();
	a.commit();
	for (let i = 0; i < 200 && a.bgBuild; i++) await a.bgBuild;
	const old = { vol: a.engine.stats([g]).volume, ...T.measure(a.engine.printable([g], true)) };
	return { fresh: { vol: fresh.vol, tris: fresh.tris, thin: fresh.thin }, old: { vol: old.vol, tris: old.tris, thin: old.thin } };
});
check('a curved push/pull with points rounded by an older version builds the same solid as a fresh one', r.fresh && Math.abs(r.fresh.vol - r.old.vol) < 1e-6 && r.fresh.tris === r.old.tris && r.old.thin === r.fresh.thin, JSON.stringify(r));

// ---- (4) turning a part freely with the gizmo (Alt: no snapping) to 33.3333333°, moved off the grid
r = await app(() => {
	const a = window.DraftOtter, vp = a.vp;
	a.model.doc.nodes = [T.box('A', 10, 10, 10, [0, 0, 5])]; a.sel = []; a.commit();
	const obj = vp.objs.get('A');
	vp.gizmoStart = { items: [{ id: 'A', obj }] };
	obj.rotation.set(0, 0, (33.3333333 * Math.PI) / 180);
	obj.position.set(1.23456789, 2.3456789, 5);
	vp.onGizmoEnd();
	return a.model.get('A');
});
check('a free gizmo turn keeps the exact angle and place (33.3333333°, x 1.23456789)', Math.abs(r.rot[2] - 33.3333333) < 1e-9 && Math.abs(r.pos[0] - 1.23456789) < 1e-9 && Math.abs(r.pos[1] - 2.3456789) < 1e-9, JSON.stringify(r.rot.concat(r.pos)));

// ---- (5) line up on slanted faces: two boxes turned 30°, one 0.5 µm off the other's side; and a pin in a hole with a
// 0.01 mm clearance, which must stay as it is
r = await app(async () => {
	const a = window.DraftOtter, c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6);
	// B sits against A's +x side (both turned 30° about Z): 10 mm further along A's x axis, plus 0.0005 mm
	const off = 10.0005;
	await T.load([{ ...T.base, id: 'g1', type: 'group', name: 'Part', mode: 'union', pos: [0, 0, 0], children: [
		T.box('A', 10, 10, 10, [0, 0, 5], { rot: [0, 0, 30] }), T.box('B', 10, 10, 10, [off * c, off * s, 5], { rot: [0, 0, 30] }),
		{ ...T.base, id: 'pin', type: 'cylinder', name: 'pin', params: { r: 2, h: 10, seg: 32, edgeType: 'chamfer', topEdge: 0, bottomEdge: 0 }, pos: [40, 0, 5] },
		{ ...T.base, id: 'hole', type: 'tube', name: 'sleeve', params: { ro: 5, ri: 2.01, h: 10, seg: 32 }, pos: [40, 0, 5] },
	] }]);
	const before = a.checkPrint().items.find((i) => i.kind === 'hairline').title;
	const moved = a.lineUpHairlines();
	const B = a.model.get('B').pos, along = (B[0] * c + B[1] * s), across = (-B[0] * s + B[1] * c);
	return { before, moved, along, across, pin: a.model.get('pin').pos, sleeve: a.model.get('hole').pos, after: a.checkPrint().items.find((i) => i.kind === 'hairline').title };
});
check('a part 0.5 µm off a slanted neighbor is found and lined up flush (10 mm along, nothing across)', /1 part a hair off/.test(r.before) && r.moved === 1 && Math.abs(r.along - 10) < 1e-9 && Math.abs(r.across) < 1e-9 && /exactly/.test(r.after), JSON.stringify(r));
check('…and a pin in a hole with a 0.01 mm clearance is left where it is', r.pin[0] === 40 && r.sleeve[0] === 40, JSON.stringify(r));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'browser76: all passed');
process.exit(fails ? 1 : 0);
