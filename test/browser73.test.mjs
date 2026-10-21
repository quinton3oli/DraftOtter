// Push/pull lines up exactly with the part: its prism is fitted onto the part's own vertices (in 64-bit), so no
// hairline ledges or sliver triangles are left where it meets the faces beside it — even when the design has
// sub-micron offsets (here a tray whose hollow sits 0.5 µm off center, pulled up on its rim).
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

// a tray (94 × 69 box, 90 × 65 hollow 0.5 µm off center, finger scoop) with its left rim pulled up 15 mm
const TRAY = {"id":"n0172lgfx","type":"group","name":"Cut","mode":"union","children":[{"id":"nzhu9mhyz","type":"group","name":"Cut","mode":"union","children":[{"id":"nwads0cio","type":"cylinder","name":"Cylinder","params":{"r":17,"h":72,"seg":128,"edgeType":"chamfer","topEdge":0,"bottomEdge":0},"pos":[0,67,5],"rot":[-90,0,0],"scale":[1,1,1],"color":"#f2a03d","visible":true,"locked":false,"hole":true},{"id":"np4eoj0qx","type":"group","name":"Cut","mode":"union","children":[{"id":"nk0jkspi2","type":"box","name":"Box","params":{"w":94,"d":69,"h":17,"radius":0,"edgeType":"fillet","seg":4},"pos":[0,67.0005,1],"rot":[0,0,0],"scale":[1,1,1],"color":"#e8613a","visible":true,"locked":false,"hole":false},{"id":"n1iboll35","type":"box","name":"Box","params":{"w":90,"d":65,"h":26,"radius":0,"edgeType":"fillet","seg":4},"pos":[0,67,8.5],"rot":[0,0,0],"scale":[1,1,1],"color":"#e8613a","visible":true,"locked":false,"hole":true}],"pos":[0,0,-7.5],"rot":[0,0,0],"scale":[1,1,1],"hole":false,"color":"#e8613a","visible":true,"locked":false,"expanded":true}],"pos":[0,-67.0005,6.5],"rot":[0,0,0],"scale":[1,1,1],"hole":false,"color":"#e8613a","visible":true,"locked":false,"expanded":true},{"id":"n8mihus4l","type":"facex","name":"Push/pull","params":{"depth":15,"draft":0,"loops":[[[0,0],[0,2],[-28.272,2],[-28.272,67],[0,67],[0,69],[-30.272,69],[-30.272,0]]],"ref":{"p":[-21.248442355,-33.949166539,8.5],"n":[0,0,1],"area":251.087022}},"pos":[-16.728,-34.5,8.5],"rot":[0,0,0],"scale":[1,1,1],"color":"#e8613a","visible":true,"locked":false,"hole":false}],"pos":[0,0,8.5],"rot":[0,0,0],"scale":[1,1,1],"hole":false,"color":"#e8613a","visible":true,"locked":false,"expanded":false,"featureGroup":true,"filletGroup":true};
const analyze = () => app(async () => {
	const a = window.DraftOtter;
	for (let i = 0; i < 200 && a.bgBuild; i++) await a.bgBuild;
	const n = a.model.nodes[0], g = a.engine.printable([n], true), pos = g.attributes.position, C = a.vp.camera.position.constructor;
	let slivers = 0;
	const planes = { x: new Set(), y: new Set(), z: new Set() };
	for (let i = 0; i < pos.count; i += 3) {
		const p = [0, 1, 2].map((k) => new C().fromBufferAttribute(pos, i + k));
		const cr = p[1].clone().sub(p[0]).cross(p[2].clone().sub(p[0])), area = cr.length() / 2, nn = cr.normalize();
		const long = Math.max(p[0].distanceTo(p[1]), p[1].distanceTo(p[2]), p[2].distanceTo(p[0]));
		if (area > 0 && (2 * area) / long < 1e-3) slivers++;
		['x', 'y', 'z'].forEach((ax, k) => { if (Math.abs(Math.abs(nn.getComponent(k)) - 1) < 1e-6) planes[ax].add(+p[0].getComponent(k).toFixed(6)); });
	}
	let steps = 0;
	for (const ax of ['x', 'y', 'z']) { const vs = [...planes[ax]].sort((p, q) => p - q); for (let i = 1; i < vs.length; i++) if (vs[i] - vs[i - 1] < 0.01) steps++; }
	return { tris: pos.count / 3, slivers, steps, vol: +a.engine.stats([n]).volume.toFixed(2), err: a.engine.errors.has(n.id) };
});
const slicerOk = () => app(() => {
	const a = window.DraftOtter;
	a.checkPrint();
	const txt = document.body.textContent;
	document.querySelectorAll('.modal-back').forEach((m) => m.remove());
	return { ok: /Nothing a slicer will read as broken/.test(txt), broken: (txt.match(/\d+ spots? a slicer will read as broken/) || [''])[0] };
});

await app((tray) => { const a = window.DraftOtter; a.model.load({ ...a.model.emptyDoc(), nodes: [tray] }); a.afterChange(); }, TRAY);
let s = await analyze();
check('pulled rim on a tray with a 0.5 µm offset: no sliver triangles and no micro-steps between faces', s.slivers === 0 && s.steps === 0 && !s.err, JSON.stringify(s));
let sl = await slicerOk();
check('…and the print check finds nothing a slicer would read as broken', sl.ok, JSON.stringify(sl));

// the same face pushed in instead (a cut)
await app(() => { const a = window.DraftOtter, f = a.model.nodes[0].children[1]; f.params.depth = -3; f.hole = true; a.commit(); });
s = await analyze();
// cuts are left as built (fitting a cut's sides exactly onto the part's outside faces leaves zero-thickness skins);
// what remains there is sub-micron and below what slicers see
check('pushed in 3 mm (a cut): builds cleanly', s.vol > 0 && !s.err, JSON.stringify(s));
sl = await slicerOk();
check('…and nothing a slicer would read as broken', sl.ok, JSON.stringify(sl));

// a plain box: pulling a face still gives exact volumes (the fit only moves what is off)
await app(() => {
	const a = window.DraftOtter;
	a.model.doc.nodes = []; a.commit();
	a.addShape('box');
	const b = a.model.nodes[0];
	b.paint = undefined;
	const g = { id: 'g' + Math.random().toString(36).slice(2, 9), type: 'group', name: 'Box', mode: 'union', pos: [0, 0, 10], rot: [0, 0, 0], scale: [1, 1, 1], color: b.color, visible: true, locked: false, hole: false, featureGroup: true, children: [{ ...b, pos: [0, 0, 0] }, { id: 'f' + Math.random().toString(36).slice(2, 9), type: 'facex', name: 'Push/pull', params: { loops: [[[-10, -10], [10, -10], [10, 10], [-10, 10]]], depth: 5, draft: 0, ref: { p: [0, 0, 10], n: [0, 0, 1], area: 400 } }, pos: [0, 0, 10], rot: [0, 0, 0], scale: [1, 1, 1], color: b.color, visible: true, locked: false, hole: false }] };
	a.model.doc.nodes = [g]; a.commit();
});
s = await analyze();
check('a plain box pulled 5 mm: exactly 20 × 20 × 25', s.vol === 10000 && s.slivers === 0 && s.steps === 0, JSON.stringify(s));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'browser73: all passed');
process.exit(fails ? 1 : 0);
