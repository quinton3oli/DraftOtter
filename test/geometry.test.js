import { SHAPES, buildShape, signedVolume } from '../src/shapes.js';
import { Engine, initManifold, hasManifold } from '../src/engine.js';
import Module from 'manifold-3d';
import { readFileSync } from 'node:fs';
await initManifold(Module, readFileSync('node_modules/manifold-3d/manifold.wasm'));
console.log('manifold:', hasManifold());
const eng0 = new Engine(new Model());
import { Model, makeNode, makeGroup } from '../src/model.js';

function manifold(g) {
	const p = g.attributes.position.array;
	const f = (x) => (Math.abs(x) < 5e-5 ? 0 : x).toFixed(4); const key = (i) => `${f(p[i * 3])},${f(p[i * 3 + 1])},${f(p[i * 3 + 2])}`;
	const edges = new Map();
	let bad = 0;
	for (let t = 0; t < p.length / 9; t++) {
		const v = [key(t * 3), key(t * 3 + 1), key(t * 3 + 2)];
		for (let k = 0; k < 3; k++) {
			const a = v[k], b = v[(k + 1) % 3];
			if (a === b) continue;
			const e = a + '|' + b;
			edges.set(e, (edges.get(e) || 0) + 1);
		}
	}
	for (const [e, c] of edges) {
		const [a, b] = e.split('|');
		const r = edges.get(b + '|' + a) || 0;
		if (c !== r) bad++;
	}
	return bad;
}

let fail = 0;
for (const type of Object.keys(SHAPES)) {
	if (type === 'mesh' || type === 'edgeop' || type === 'facex' || type === 'faceoff' || type === 'facemove') continue; // need external data (an imported file / picked edges or faces)
	const t0 = performance.now();
	const g = eng0.geometry(makeNode(type));
	const ms = performance.now() - t0;
	if (!g) { console.log('NULL', type); fail++; continue; }
	const v = signedVolume(g), bad = manifold(g);
	const ok = v > 0 && bad === 0;
	if (!ok) fail++;
	console.log(ok ? 'ok  ' : 'FAIL', type.padEnd(11), 'tris', g.attributes.position.count / 3, 'vol', v.toFixed(1), 'openEdges', bad, ms > 150 ? `(${ms.toFixed(0)} ms)` : '');
}
for (const extra of [{ type: 'cylinder', p: { topEdge: 2, bottomEdge: 1, edgeType: 'fillet' } }, { type: 'tube', p: { angle: 180 } }, { type: 'torus', p: { angle: 90 } }, { type: 'gear', p: { helix: 20, herringbone: true } }, { type: 'sketch', p: { mode: 'revolve', angle: 270, pts: [[2, 0], [10, 0], [10, 5], [2, 8]], fillet: 1 } }, { type: 'box', p: { radius: 3 } }, { type: 'box', p: { radius: 3, edgeType: 'chamfer' } },
	{ type: 'prism', p: { edge: 1.5 } }, { type: 'prism', p: { edge: 1.5, edgeType: 'fillet', fillet: 2 } }, { type: 'star', p: { edge: 0.8 } },
	{ type: 'text', p: { edge: 0.4, edgeType: 'fillet' } }, { type: 'gear', p: { edge: 0.8 } }, { type: 'gear', p: { edge: 0.6, edgeType: 'fillet', helix: 20 } }, { type: 'text', p: { text: 'Hello 80%', edge: 0.3 } }, { type: 'sketch', p: { edge: 2, edgeType: 'fillet' } },
	{ type: 'screwhole', p: { style: 'countersunk' } }, { type: 'screwhole', p: { style: 'counterbore' } }, { type: 'screwhole', p: { style: 'insert' } }, { type: 'screwhole', p: { style: 'insert', depth: 4 } }]) {
	const g = buildShape(extra.type, extra.p);
	if (!g) { console.log('NULL', extra.type); fail++; continue; }
	const v = signedVolume(g), bad = manifold(g);
	if (!(v > 0 && bad === 0)) fail++;
	console.log(v > 0 && bad === 0 ? 'ok  ' : 'FAIL', (extra.type + '*').padEnd(11), 'vol', v.toFixed(1), 'openEdges', bad);
}

const model = new Model();
const eng = new Engine(model);
const box = makeNode('box');
const hole = makeNode('cylinder', { r: 4, h: 30 }, { hole: true });
const grp = makeGroup([box, hole]);
const t0 = performance.now();
const g = eng.geometry(grp);
console.log('CSG box-cyl vol', signedVolume(g).toFixed(1), 'expected', (8000 - Math.PI * 16 * 20).toFixed(1), 'open', manifold(g), (performance.now() - t0).toFixed(0) + 'ms');
const nut = makeGroup([makeNode('prism', { r: 6.5, sizeBy: 'flats', h: 6.5 }), makeNode('thread', { length: 10, clearance: 0.2 }, { hole: true })]);
const t1 = performance.now();
const ng = eng.geometry(nut);
console.log('CSG nut vol', signedVolume(ng).toFixed(1), 'open', manifold(ng), (performance.now() - t1).toFixed(0) + 'ms');
const nt = eng.geometry(makeNode('screwhole', { style: 'nuttrap' }));
const ntOk = nt && signedVolume(nt) > 0 && manifold(nt) === 0;
if (!ntOk) fail++;
console.log(ntOk ? 'ok  ' : 'FAIL', 'screwhole nuttrap (union) vol', nt && signedVolume(nt).toFixed(1), 'open', nt && manifold(nt), 'hole default:', makeNode('screwhole').hole);
for (const [type, p, label] of [
	['loft', { bShape: 'rectangle', bW: 40, bD: 25, bR: 3, tShape: 'circle', tW: 26, h: 35, offsetY: 6, wall: 1.6 }, 'loft duct'],
	['loft', { bShape: 'polygon', bSides: 5, bW: 36, bR: 2, tShape: 'circle', tW: 18, h: 40, twist: 72 }, 'loft twist'],
	['sweep', { path: '0,0,0; 50,0,0; 50,0,40; 90,0,40', cornerRadius: 12, pw: 10, wall: 1.5 }, 'sweep tube'],
	['sweep', { path: '0,0,0; 10,0,25; 40,0,35; 70,0,25; 80,0,0', smooth: true, profile: 'rectangle', pw: 10, ph: 14 }, 'sweep spline'],
	['sweep', { path: '0,0,0; 0,0,30; 30,0,30', cornerRadius: 8 }, 'sweep vertical start'],
	['sketch', { pts: [[0, 0], [30, 0], [30, 4], [4, 4], [4, 30], [0, 30]], anchored: true, radii: { 3: 3 }, height: 8 }, 'sketch anchored+radius'],
]) {
	const g = eng0.geometry(makeNode(type, p));
	const v = g ? signedVolume(g) : 0, bad = g ? manifold(g) : -1;
	const okk = v > 0 && bad === 0;
	if (!okk) fail++;
	console.log(okk ? 'ok  ' : 'FAIL', label.padEnd(22), 'vol', v.toFixed(1), 'openEdges', bad);
}
// v2 sketches: holes, arcs, separate regions, revolve with a hole
const v2 = (extra) => eng0.geometry(makeNode('sketch', { v: 2, anchored: true, height: 5, cons: [], radii: {}, ...extra }));
const rect = { points: [[-20, -10], [20, -10], [20, 10], [-20, 10], [-10, 0], [10, 0]], segs: [{ a: 0, b: 1 }, { a: 1, b: 2 }, { a: 2, b: 3 }, { a: 3, b: 0 }] };
for (const [label, g, want] of [
	['plate with 2 Ø6 holes', v2({ ...rect, circles: [{ c: 4, r: 3 }, { c: 5, r: 3 }] }), (800 - 2 * Math.PI * 9) * 5],
	['lone circle (disc)', v2({ points: [[0, 0]], segs: [], circles: [{ c: 0, r: 10 }] }), Math.PI * 100 * 5],
	['two separate rectangles', v2({ points: [[0, 0], [10, 0], [10, 10], [0, 10], [20, 0], [30, 0], [30, 10], [20, 10]], segs: [{ a: 0, b: 1 }, { a: 1, b: 2 }, { a: 2, b: 3 }, { a: 3, b: 0 }, { a: 4, b: 5 }, { a: 5, b: 6 }, { a: 6, b: 7 }, { a: 7, b: 4 }], circles: [] }), 1000],
	['D-shape (line + semicircle arc)', v2({ points: [[0, -10], [0, 10]], segs: [{ a: 0, b: 1 }, { a: 1, b: 0, arc: 1 }], circles: [] }), (Math.PI * 100) / 2 * 5],
	['revolve: ring with a circular hole (pipe torus)', v2({ mode: 'revolve', points: [[8, -4], [16, -4], [16, 4], [8, 4], [12, 0]], segs: [{ a: 0, b: 1 }, { a: 1, b: 2 }, { a: 2, b: 3 }, { a: 3, b: 0 }], circles: [{ c: 4, r: 2 }], seg: 96 }), (64 - Math.PI * 4) * 2 * Math.PI * 12],
]) {
	const v = g ? signedVolume(g) : 0, bad = g ? manifold(g) : -1;
	const okk = g && bad === 0 && Math.abs(v - want) / want < 0.01;
	if (!okk) fail++;
	console.log(okk ? 'ok  ' : 'FAIL', label.padEnd(44), 'vol', v.toFixed(1), 'expected', want.toFixed(1), 'openEdges', bad);
}
const sk = eng0.geometry(makeNode('sketch', { pts: [[0, 0], [30, 0], [30, 10], [0, 10]], anchored: true, height: 5 }));
sk.computeBoundingBox();
const anch = Math.abs(sk.boundingBox.min.x) < 1e-6 && Math.abs(sk.boundingBox.min.z) < 1e-6 && Math.abs(sk.boundingBox.max.x - 30) < 1e-6;
if (!anch) fail++;
console.log(anch ? 'ok  ' : 'FAIL', 'anchored sketch keeps its own origin');
process.exit(fail ? 1 : 0);
