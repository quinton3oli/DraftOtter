// No lips or hairline steps where features meet the part. (1) An extrusion sketched on a face that runs past the
// face's edge starts exactly on the face — its small reach into the part (so it always fuses) no longer sticks out as
// a 0.02 mm lip beyond the edge. (2) A pull starts exactly on its face (no reach below it), and an older pull without a
// remembered face is set onto its face too (its stored outline 0.02 mm off is not used). (3) "Line them up" in the
// print check moves a part sitting 0.5 µm off its neighbor flush, and leaves deliberate overlaps on round numbers alone.
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

// load nodes, build, and list the flat X/Y/Z face planes of the first part
const planes = (src) => app(async (src) => {
	const a = window.DraftOtter;
	a.model.doc.nodes = (0, eval)('(' + src + ')')();
	a.sel = [];
	a.commit();
	for (let i = 0; i < 200 && a.bgBuild; i++) await a.bgBuild;
	const n = a.model.nodes[0], g = a.engine.printable(a.model.nodes, true), pos = g.attributes.position, C = a.vp.camera.position.constructor;
	const P = { x: new Set(), y: new Set(), z: new Set() };
	for (let i = 0; i < pos.count; i += 3) {
		const q = [0, 1, 2].map((k) => new C().fromBufferAttribute(pos, i + k));
		const nn = q[1].clone().sub(q[0]).cross(q[2].clone().sub(q[0])).normalize();
		['x', 'y', 'z'].forEach((ax, k) => { if (Math.abs(Math.abs(nn.getComponent(k)) - 1) < 1e-6) P[ax].add(+q[0].getComponent(k).toFixed(5)); });
	}
	const s = (set) => [...set].sort((p, q) => p - q);
	return { x: s(P.x), y: s(P.y), z: s(P.z), err: a.engine.errors.has(n.id) };
}, src.toString());
const base = { rot: [0, 0, 0], scale: [1, 1, 1], color: '#e8613a', visible: true, locked: false };
const json = JSON.stringify(base);

// (1) a 10 × 10 square sketched on the top of a 20 × 20 × 10 box, half of it past the box's edge, extruded 5 mm
let r = await planes(new Function(`const b = ${json};
	const box = { ...b, id: 'b1', type: 'box', name: 'Box', params: { w: 20, d: 20, h: 10, radius: 0, edgeType: 'fillet', seg: 4 }, pos: [0, 0, 5], hole: false };
	const sk = { ...b, id: 's1', type: 'sketch', name: 'Extrusion', hole: false, pos: [10, 0, 9.98], params: { mode: 'extrude', height: 5.02, angle: 360, axisX: 0, fillet: 0, seg: 64, edge: 0, edgeType: 'chamfer', anchored: true, v: 2,
		points: [[-5, -5], [5, -5], [5, 5], [-5, 5]], segs: [{ a: 0, b: 1 }, { a: 1, b: 2 }, { a: 2, b: 3 }, { a: 3, b: 0 }], circles: [], cons: [], radii: {}, face: { cut: false, overlap: 0.02 } } };
	return [{ ...b, id: 'g1', type: 'group', name: 'Box', mode: 'union', children: [box, sk], pos: [0, 0, 0], hole: false }];`));
check('an extrusion sketched past the face edge starts on the face: no lip below it (flat at z 0, 10, 15 only)', JSON.stringify(r.z) === '[0,10,15]' && !r.err, JSON.stringify(r));

// (2) an older pull (no remembered face) whose stored outline is 0.02 mm off the face, pulled 3 mm
r = await planes(new Function(`const b = ${json};
	const box = { ...b, id: 'b1', type: 'box', name: 'Box', params: { w: 20, d: 20, h: 10, radius: 0, edgeType: 'fillet', seg: 4 }, pos: [0, 0, 5], hole: false };
	const pull = { ...b, id: 'f1', type: 'facex', name: 'Push/pull', hole: false, pos: [0, 0, 10], params: { loops: [[[-10, -10], [10, -10], [10, 10.02], [-10, 10.02]]], depth: 3, draft: 0 } };
	return [{ ...b, id: 'g1', type: 'group', name: 'Box', mode: 'union', children: [box, pull], pos: [0, 0, 0], hole: false }];`));
check('an older pull is set exactly onto its face: sides only at ±10, top at 13, nothing below the face', JSON.stringify(r.y) === '[-10,10]' && JSON.stringify(r.x) === '[-10,10]' && JSON.stringify(r.z) === '[0,13]' && !r.err, JSON.stringify(r));

// (3) line up: box B sits 0.5 µm off box A's side; box C overlaps A's top by 0.02 mm on purpose (round numbers)
const lineup = await app(async () => {
	const a = window.DraftOtter, b = { rot: [0, 0, 0], scale: [1, 1, 1], color: '#e8613a', visible: true, locked: false, hole: false };
	const box = (id, w, d, h, pos) => ({ ...b, id, type: 'box', name: id, params: { w, d, h, radius: 0, edgeType: 'fillet', seg: 4 }, pos });
	a.model.doc.nodes = [{ ...b, id: 'g1', type: 'group', name: 'Part', mode: 'union', pos: [0, 0, 0], children: [box('A', 20, 20, 10, [0, 0, 5]), box('B', 20, 20, 10, [20.0005, 0, 5]), box('C', 6, 6, 5, [0, 0, 12.48])] }];
	a.sel = [];
	a.commit();
	for (let i = 0; i < 200 && a.bgBuild; i++) await a.bgBuild;
	const res = a.checkPrint(), item = res.items.find((i) => i.kind === 'hairline');
	const moved = a.lineUpHairlines();
	const after = a.checkPrint().items.find((i) => i.kind === 'hairline');
	return { title: item.title, level: item.level, hasButton: !!document.querySelector('#check-panel button.btn.sm') && [...document.querySelectorAll('#check-panel button')].some((x) => /Line them up/.test(x.textContent)) || !!item.action, moved, B: a.model.get('B').pos, C: a.model.get('C').pos, after: after.title };
});
check('the print check finds the part a hair off its neighbor, with a "Line them up" button', /1 part a hair off/.test(lineup.title) && lineup.level === 'warn' && lineup.hasButton, JSON.stringify(lineup));
check('…lining up moves it flush (x 20.0005 → 20) and leaves the deliberate 0.02 mm overlap alone', lineup.moved === 1 && lineup.B[0] === 20 && lineup.C[2] === 12.48 && /meet their neighbors exactly/.test(lineup.after), JSON.stringify(lineup));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'browser75: all passed');
process.exit(fails ? 1 : 0);
