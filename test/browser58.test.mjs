// Exports are exactly what the kernel built (fillets, curves, volume untouched), and Print check finds the spots a
// slicer's vertex merge (0.03 mm) will break: solids touching only along an edge, and hair-thin slivers between cuts.
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 240000, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1500, height: 900 } });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(pathToFileURL('LocalCAD.html').href);
await page.waitForFunction(() => document.body.classList.contains('ready'));
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(ok ? 'ok  ' : 'FAIL', name, info); };

await page.evaluate(() => {
	// what a slicer does on load: merge vertices within d mm, drop collapsed triangles, then count edge uses
	window.meld = (g, d) => {
		const P = (g.index ? g.toNonIndexed() : g).attributes.position.array, grid = new Map(), reps = [];
		const vid = (i) => {
			const x = P[3 * i], y = P[3 * i + 1], z = P[3 * i + 2], cx = Math.floor(x / d), cy = Math.floor(y / d), cz = Math.floor(z / d);
			for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
				const l = grid.get(`${cx + a},${cy + b},${cz + c}`);
				if (l) for (const r of l) { const p = reps[r]; if (Math.hypot(p[0] - x, p[1] - y, p[2] - z) <= d) return r; }
			}
			const r = reps.length; reps.push([x, y, z]); const k = `${cx},${cy},${cz}`; (grid.get(k) || grid.set(k, []).get(k)).push(r); return r;
		};
		const edges = new Map();
		for (let t = 0; t < P.length / 9; t++) {
			const v = [vid(3 * t), vid(3 * t + 1), vid(3 * t + 2)];
			if (v[0] === v[1] || v[1] === v[2] || v[0] === v[2]) continue;
			for (const [x, y] of [[v[0], v[1]], [v[1], v[2]], [v[2], v[0]]]) { const k = x < y ? x + '_' + y : y + '_' + x; edges.set(k, (edges.get(k) || 0) + 1); }
		}
		let open = 0, nonManifold = 0;
		for (const n of edges.values()) { if (n === 1) open++; else if (n > 2) nonManifold++; }
		return { open, nonManifold };
	};
	window.vol = (g) => { const P = (g.index ? g.toNonIndexed() : g).attributes.position.array; let v = 0; for (let i = 0; i < P.length; i += 9) v += (P[i] * (P[i + 4] * P[i + 8] - P[i + 5] * P[i + 7]) - P[i + 1] * (P[i + 3] * P[i + 8] - P[i + 5] * P[i + 6]) + P[i + 2] * (P[i + 3] * P[i + 7] - P[i + 4] * P[i + 6])) / 6; return v; };
	window.tris = (g) => (g.index ? g.index.count : g.attributes.position.count) / 3;
	window.fresh = () => { const a = window.LocalCAD; a.model.doc.nodes = []; a.commit(); };
	window.shape = (type, params, pos, hole = false) => { const a = window.LocalCAD; a.addShape(type); const n = a.model.nodes[a.model.nodes.length - 1]; Object.assign(n.params, params); n.pos = pos; n.rot = [0, 0, 0]; n.hole = hole; a.commit(); return n; };
});

const trouble = () => { const a = window.LocalCAD, it = a.checkPrint().items.find((i) => i.kind === 'slicer'); a.closeCheckPanel(); return { level: it.level, title: it.title, boxes: it.highlight ? it.highlight.boxes.map((b) => [b.min.toArray(), b.max.toArray()]) : [] }; };
await page.evaluate((src) => { window.trouble = eval(src); }, trouble.toString());

// two blocks touching only along one edge
const kiss = await page.evaluate(() => {
	fresh();
	const A = shape('box', { w: 10, d: 10, h: 10 }, [0, 0, 5]), B = shape('box', { w: 10, d: 10, h: 10 }, [10, 10, 5]);
	const g = window.LocalCAD.engine.printable([A, B], true);
	return { vol: vol(g), t: trouble() };
});
check('blocks touching along an edge: both blocks are exported', Math.abs(kiss.vol - 2000) < 0.01, kiss.vol.toFixed(4));
check('…and Print check marks the edge as a spot a slicer will read as broken', kiss.t.level === 'warn' && kiss.t.boxes.length === 1, JSON.stringify(kiss.t));

// a plate with two pockets 0.01 mm apart: the wall between them is a sliver a slicer merges away
const sliver = await page.evaluate(() => {
	fresh();
	shape('box', { w: 40, d: 20, h: 10 }, [0, 0, 5]);
	shape('box', { w: 10, d: 10, h: 10 }, [-5, 0, 7], true);
	shape('box', { w: 10, d: 10, h: 10 }, [5.01, 0, 7], true);
	return trouble();
});
check('pockets 0.01 mm apart: Print check marks the sliver between them', sliver.level === 'warn' && sliver.boxes.length >= 1 && sliver.boxes.every((b) => b[0][0] < 0.4 && b[1][0] > -0.4), JSON.stringify(sliver));
const apart = await page.evaluate(() => {
	fresh();
	shape('box', { w: 40, d: 20, h: 10 }, [0, 0, 5]);
	shape('box', { w: 10, d: 10, h: 10 }, [-5.5, 0, 7], true);
	shape('box', { w: 10, d: 10, h: 10 }, [5.5, 0, 7], true);
	shape('cylinder', { r: 3, h: 10, seg: 96 }, [15, 0, 7], true);
	return trouble();
});
check('…but not when they are a real 1 mm apart, or for fine round holes', apart.level === 'ok', JSON.stringify(apart));

// fillets and curves keep their resolution
const keep = await page.evaluate(() => {
	fresh();
	const B = shape('box', { w: 30, d: 20, h: 10, radius: 0.5, seg: 12 }, [0, 0, 5]), C = shape('cylinder', { r: 3, h: 10, seg: 96 }, [40, 0, 5]);
	const e = window.LocalCAD.engine;
	return { box: [tris(e.world(B)), tris(e.printable([B], true))], vb: [vol(e.world(B)), vol(e.printable([B], true))], vc: [vol(e.world(C)), vol(e.printable([C], true))] };
});
check('a small fillet keeps every facet in the export', keep.box[0] === keep.box[1], JSON.stringify(keep.box));
check('…with the same volume', Math.abs(keep.vb[0] - keep.vb[1]) < 1e-3, JSON.stringify(keep.vb));
// a flat cap may be re-triangulated, but the 96 sides stay: the volume is unchanged to the nanometer
check('a fine cylinder keeps its shape exactly', Math.abs(keep.vc[0] - keep.vc[1]) < 1e-6, JSON.stringify(keep.vc));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'browser58: all passed');
process.exit(fails ? 1 : 0);
