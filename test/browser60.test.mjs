// Push/pull on a face that runs into rounded edges moves the rounding with it: pulling the top of a rounded box
// up 10 mm gives the same solid as a rounded box 10 mm taller; pushing it in 5 mm one 5 mm shorter. Sharp faces
// keep the plain extrude, and the distance can be changed afterwards.
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
const reset = (params) => app((params) => { localStorage.clear(); const a = window.DraftOtter; a.setTool(null); a.model.doc.nodes = []; a.sel = []; a.commit(); a.addShape('box'); Object.assign(a.model.nodes[0].params, params); a.commit(); a.setSelection([]); a.frame(); }, params);
// the solid's volume and size, and the same for a reference box built directly
const solid = () => app(() => { const a = window.DraftOtter, g = a.model.nodes[0], b = a.worldBox(g); return { kids: g.children ? g.children.map((c) => c.type).join(',') : g.type, vol: a.engine.stats([g]).volume, h: b.max.z - b.min.z, w: b.max.x - b.min.x, err: a.engine.errors.has(g.id) }; });
const reference = (params) => app((params) => { const a = window.DraftOtter, e = a.engine, n = { id: 'ref' + Math.random(), type: 'box', params: { ...a.model.nodes[0].children[0].params, ...params }, pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1] }; const g = e.geometry(n); return e.stats([n]).volume; }, params);
const pushTop = async (z, dist) => {
	await page.keyboard.press('u');
	const p = await screen(4, 3, z);
	await page.mouse.move(cv.x + p.x, cv.y + p.y, { steps: 3 });
	await page.mouse.click(cv.x + p.x, cv.y + p.y);
	await wait(150);
	await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
	await page.keyboard.type(String(dist));
	await page.keyboard.press('Enter');
	await wait(600);
	await app(() => window.DraftOtter.setTool(null));
};

// a 40 × 30 × 20 box with 3 mm rounded edges
const R = { w: 40, d: 30, h: 20, radius: 3, edgeType: 'fillet', seg: 8 };
await reset(R);
await wait(400);
const v0 = (await solid()).vol;
await pushTop(20, 10);
let s = await solid();
let ref = await reference({ h: 30 });
check('pulling the top of a rounded box carries the rounded edges up with it', s.kids === 'box,facemove' && Math.abs(s.h - 30) < 1e-3 && !s.err, JSON.stringify(s));
check('…the result is the same solid as a rounded box 10 mm taller', Math.abs(s.vol - ref) < 0.05, `${s.vol.toFixed(3)} vs ${ref.toFixed(3)} (was ${v0.toFixed(3)})`);

// change the distance afterwards: push in by 5 instead
await app(() => { const a = window.DraftOtter, f = a.model.nodes[0].children[1]; f.params.depth = -5; a.commit(); });
await wait(400);
s = await solid();
ref = await reference({ h: 15 });
check('changing the distance to −5 pushes the rounded top down', Math.abs(s.h - 15) < 1e-3 && Math.abs(s.vol - ref) < 0.05 && !s.err, `${JSON.stringify(s)} ref ${ref.toFixed(3)}`);
check('…and it stays one push/pull feature', s.kids === 'box,facemove', s.kids);

// pushing in further than the straight walls allow is refused, not mangled
await app(() => { const a = window.DraftOtter, f = a.model.nodes[0].children[1]; f.params.depth = -30; a.commit(); });
await wait(400);
s = await solid();
check('pushing in deeper than the part flags an error and keeps the part whole', s.err && Math.abs(s.h - 20) < 1e-3, JSON.stringify(s));

// a sharp box keeps the plain push/pull
await reset({ w: 40, d: 30, h: 20, radius: 0 });
await wait(400);
await pushTop(20, 6);
s = await solid();
check('a face with sharp edges still extrudes as before', s.kids === 'box,facex' && Math.abs(s.h - 26) < 1e-3 && Math.abs(s.vol - 40 * 30 * 26) < 0.05, JSON.stringify(s));

// side faces of the rounded box move their rounding too
await reset(R);
await wait(400);
await page.keyboard.press('u');
const p = await screen(20, 2, 10);
await page.mouse.move(cv.x + p.x, cv.y + p.y, { steps: 3 });
await page.mouse.click(cv.x + p.x, cv.y + p.y);
await wait(150);
await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
await page.keyboard.type('8');
await page.keyboard.press('Enter');
await wait(600);
s = await solid();
ref = await reference({ w: 48 });
check('a rounded side face moves out with its rounding (same as a box 8 mm wider)', s.kids === 'box,facemove' && Math.abs(s.w - 48) < 1e-3 && Math.abs(s.vol - ref) < 0.05, `${JSON.stringify(s)} ref ${ref.toFixed(3)}`);

// rounded edges made with the Fillet tool (every edge of a sharp box, 2 mm): pulling the top 6 mm matches a box
// built 6 mm taller and filleted the same way
const setBar = (kind, size) => app(([kind, size]) => { const b = document.querySelector('#fillet-bar'); const s = b.querySelector('select'); s.value = kind; s.dispatchEvent(new Event('change')); const i = b.querySelector('input.num'); i.value = size; i.dispatchEvent(new Event('change')); }, [kind, size]);
const filletAll = async () => {
	await app(() => window.DraftOtter.setTool('fillet'));
	await app(() => { const a = window.DraftOtter, ft = a.vp.filletTool; ft.target = a.model.nodes[0].id; ft.selected.clear(); ft.selectAll(); });
	await setBar('fillet', '2');
	await app(() => [...document.querySelectorAll('#fillet-bar .btn')].find((b) => b.textContent === 'Apply').click());
	await wait(800);
	await app(() => { const a = window.DraftOtter; a.setTool(null); a.setSelection([]); a.frame(); });
	await wait(300);
};
await reset({ w: 40, d: 30, h: 26, radius: 0 });
await wait(300);
await filletAll();
const tall = await solid();
const tallTrouble = await app(() => { const a = window.DraftOtter, it = a.checkPrint().items.find((i) => i.kind === 'slicer'); a.closeCheckPanel(); return [it.level, it.highlight ? it.highlight.boxes.map((b) => [b.min.toArray().map((v) => +v.toFixed(2)), b.max.toArray().map((v) => +v.toFixed(2))]) : []]; });
await reset({ w: 40, d: 30, h: 20, radius: 0 });
await wait(300);
await filletAll();
await pushTop(20, 6);
s = await solid();
check('a face rounded with the Fillet tool moves with its fillets', s.kids === 'box,edgeop,facemove' && Math.abs(s.h - 26) < 1e-3 && !s.err, JSON.stringify(s));
check('…the same solid as a taller box filleted the same way', Math.abs(s.vol - tall.vol) < 0.05, `${s.vol.toFixed(3)} vs ${tall.vol.toFixed(3)}`);
const trouble = await app(() => { const a = window.DraftOtter, it = a.checkPrint().items.find((i) => i.kind === 'slicer'); a.closeCheckPanel(); return [it.level, it.highlight ? it.highlight.boxes.map((b) => [b.min.toArray().map((v) => +v.toFixed(2)), b.max.toArray().map((v) => +v.toFixed(2))]) : []]; });
// (the Fillet tool's own corner blends can hold sub-0.03 mm detail; the push/pull must not add any)
check('…and adds no spots a slicer would read as broken', trouble[1].length <= tallTrouble[1].length, `${trouble[1].length} vs ${tallTrouble[1].length} on the same box built taller`);

// a cube rounded on its four upright edges (Fillet tool, 14 mm): the top face meets the curved corners. Pushing it in
// used to leave paper-thin skins standing on the corners at the old height; now it is cut clean, and pulling it out
// stretches the corners
const cornerCube = () => app(() => {
	localStorage.clear();
	const a = window.DraftOtter; a.setTool(null); a.model.doc.nodes = []; a.sel = []; a.commit();
	a.addShape('box'); const b = a.model.nodes[0]; Object.assign(b.params, { w: 50, d: 50, h: 50, radius: 0 }); b.pos = [0, 0, 25]; a.commit();
	const { g } = a.featureGroupFor(b);
	const ch = (p, q, n1, n2) => ({ pts: [p, q], n1: [n1, n1], n2: [n2, n2], closed: false, convex: true });
	g.children.push({ id: 'fil' + Math.random().toString(36).slice(2), seq: 99, type: 'edgeop', name: 'Fillet', hole: true, visible: true, locked: false, pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1], color: b.color,
		params: { kind: 'fillet', size: 14, size2: 0, segs: 12, chains: [ch([25, 25, -25], [25, 25, 25], [1, 0, 0], [0, 1, 0]), ch([-25, 25, 25], [-25, 25, -25], [-1, 0, 0], [0, 1, 0]), ch([-25, -25, -25], [-25, -25, 25], [-1, 0, 0], [0, -1, 0]), ch([25, -25, 25], [25, -25, -25], [1, 0, 0], [0, -1, 0])] } });
	a.commit(); a.setSelection([]); a.frame();
});
const report = () => app(() => { const a = window.DraftOtter, g = a.model.nodes[0], b = a.worldBox(g), it = a.checkPrint().items.find((i) => i.kind === 'slicer'); a.closeCheckPanel(); return { kids: g.children ? g.children.map((c) => c.type).join(',') : g.type, vol: a.engine.stats([g]).volume, top: b.max.z, slicer: it.level, err: a.engine.errors.has(g.id) }; });
await cornerCube();
await wait(500);
const c0 = await report();
await pushTop(50, -10);
let c = await report();
check('pushing in the top of a cube with rounded upright corners cuts it clean to the new height', c.kids === 'box,edgeop,facemove' && Math.abs(c.top - 40) < 1e-3 && !c.err, JSON.stringify(c));
check('…exactly 4/5 of the volume, with no skins left on the rounded corners', Math.abs(c.vol - c0.vol * 0.8) < 0.05 && c.slicer === 'ok', `${c.vol.toFixed(3)} vs ${(c0.vol * 0.8).toFixed(3)}, slicer ${c.slicer}`);
await cornerCube();
await wait(500);
await pushTop(50, 10);
c = await report();
check('pulling it out stretches the rounded corners (6/5 of the volume, clean)', Math.abs(c.top - 60) < 1e-3 && Math.abs(c.vol - c0.vol * 1.2) < 0.05 && c.slicer === 'ok', JSON.stringify(c));

// pulling one rounded corner out 15 mm thickens the whole smooth wall around the cube; it used to leave triangular
// pits at the old corners (the fillet's cut was applied after the new material) and seams along the bottom
await cornerCube();
await wait(500);
await page.keyboard.press('u');
{
	const q = await screen(20.9, 20.9, 25);
	await page.mouse.move(cv.x + q.x, cv.y + q.y, { steps: 3 });
	await page.mouse.click(cv.x + q.x, cv.y + q.y);
	await wait(150);
	await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
	await page.keyboard.type('15');
	await page.keyboard.press('Enter');
	await wait(800);
	await app(() => window.DraftOtter.setTool(null));
}
const wall = await app(() => {
	const a = window.DraftOtter, g = a.model.nodes[0], b = a.worldBox(g), geo = a.engine.printable([g], true), P = (geo.index ? geo.toNonIndexed() : geo).attributes.position.array;
	let top = 0;
	const keyOf = (i) => P[i] + ',' + P[i + 1] + ',' + P[i + 2], ids = new Map(), edges = new Map();
	for (let i = 0; i < P.length; i += 9) {
		const ux = P[i + 3] - P[i], uy = P[i + 4] - P[i + 1], uz = P[i + 5] - P[i + 2], wx = P[i + 6] - P[i], wy = P[i + 7] - P[i + 1], wz = P[i + 8] - P[i + 2];
		const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx, l = Math.hypot(nx, ny, nz);
		if (nz / l > 0.9999 && Math.abs(P[i + 2] - b.max.z) < 1e-4) top += l / 2;
		const v = [0, 3, 6].map((o) => { const k = keyOf(i + o); if (!ids.has(k)) ids.set(k, ids.size); return ids.get(k); });
		for (const [x, y] of [[v[0], v[1]], [v[1], v[2]], [v[2], v[0]]]) { const k = Math.min(x, y) + '_' + Math.max(x, y); edges.set(k, (edges.get(k) || 0) + 1); }
	}
	const bad = [...edges.values()].filter((n) => n !== 2).length;
	return { kids: g.children.map((c) => c.type).join(','), vol: a.engine.stats([g]).volume, top, h: b.max.z - b.min.z, w: b.max.x - b.min.x, bad, err: a.engine.errors.has(g.id) };
});
check('pulling a rounded corner out 15 mm thickens the smooth wall: exactly 80 mm across', wall.kids === 'box,edgeop,faceoff' && Math.abs(wall.w - 80) < 1e-3 && Math.abs(wall.h - 50) < 1e-3 && !wall.err, JSON.stringify(wall));
check('…a solid prism with no pits at the old corners (volume = top area × height)', Math.abs(wall.vol - wall.top * wall.h) < 0.05, `${wall.vol.toFixed(3)} vs ${(wall.top * wall.h).toFixed(3)}`);
check('…and a clean mesh (every edge shared by exactly two faces)', wall.bad === 0, wall.bad + ' bad edges');

// …and keep pushing and pulling from there: the second pull used to do nothing (the part's points no longer matched)
const pp = async (x, y, z, dist) => {
	await app(() => { const a = window.DraftOtter; a.setTool(null); a.setSelection([]); a.frame(); });
	await wait(400);
	await page.keyboard.press('u');
	const q = await screen(x, y, z);
	await page.mouse.move(cv.x + q.x, cv.y + q.y, { steps: 3 });
	await page.mouse.click(cv.x + q.x, cv.y + q.y);
	await wait(150);
	await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
	await page.keyboard.type(String(dist));
	await page.keyboard.press('Enter');
	await wait(800);
	await app(() => window.DraftOtter.setTool(null));
	return app(() => { const a = window.DraftOtter, g = a.model.nodes[0], b = a.worldBox(g); return { n: g.children.length, vol: a.engine.stats([g]).volume, w: b.max.x - b.min.x, h: b.max.z - b.min.z, err: a.engine.errors.has(g.id) }; });
};
const s1 = await pp(-31.5, -31.5, 25, 5);
check('a second pull on the thickened wall works (now 90 mm across)', s1.n === 4 && Math.abs(s1.w - 90) < 1e-3 && s1.vol > wall.vol + 1000 && !s1.err, JSON.stringify(s1));
const s2 = await pp(-34.5, -34.5, 25, -5);
check('…pushing it back in 5 mm returns exactly to 80 mm across', Math.abs(s2.w - 80) < 1e-3 && Math.abs(s2.vol - wall.vol) < 0.05 && !s2.err, `${JSON.stringify(s2)} vs ${wall.vol.toFixed(3)}`);
const s3 = await pp(0, 0, 50, -10);
check('…and the top can still be pushed in afterwards (4/5 of the volume)', Math.abs(s3.h - 40) < 1e-3 && Math.abs(s3.vol - wall.vol * 0.8) < 0.05 && !s3.err, JSON.stringify(s3));

// a cylinder's top meets its curved wall the same way
await app(() => { localStorage.clear(); const a = window.DraftOtter; a.setTool(null); a.model.doc.nodes = []; a.sel = []; a.commit(); a.addShape('cylinder'); Object.assign(a.model.nodes[0].params, { r: 12, h: 30, seg: 64 }); a.model.nodes[0].pos = [0, 0, 15]; a.commit(); a.setSelection([]); a.frame(); });
await wait(500);
const y0 = await report();
await pushTop(30, -12);
c = await report();
check('pushing in the top of a cylinder leaves a clean, shorter cylinder', Math.abs(c.top - 18) < 1e-3 && Math.abs(c.vol - y0.vol * 0.6) < 0.05 && c.slicer === 'ok' && !c.err, JSON.stringify(c));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'browser60: all passed');
process.exit(fails ? 1 : 0);
