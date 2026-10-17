// STEP export round-trip: write faceted STEP, read it back with OpenCascade (occt-import-js), compare volumes.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import Module from 'manifold-3d';
import { Engine, initManifold } from '../src/engine.js';
import { Model, makeNode, makeGroup } from '../src/model.js';
import { signedVolume } from '../src/shapes.js';
import { stepFromPositions } from '../src/step.js';
const require = createRequire(import.meta.url);
const occtimportjs = require('occt-import-js');
await initManifold(Module, readFileSync('node_modules/manifold-3d/manifold.wasm'));
const occt = await occtimportjs();
const eng = new Engine(new Model());
mkdirSync('test/downloads', { recursive: true });
const meshVolume = (m) => {
	const p = m.attributes.position.array, idx = m.index.array;
	let v = 0;
	for (let i = 0; i < idx.length; i += 3) {
		const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
		v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
	}
	return v / 6;
};
let fails = 0;
const cases = [
	['box', makeNode('box')],
	['box with hole (CSG)', makeGroup([makeNode('box'), makeNode('cylinder', { r: 4, h: 30 }, { hole: true })])],
	['cylinder', makeNode('cylinder')],
	['L-bracket with holes', makeNode('lbracket')],
	['gear with bore', makeNode('gear')],
	['hex nut (thread hole)', makeGroup([makeNode('prism', { r: 6.5, sizeBy: 'flats', h: 6.5 }), makeNode('thread', { length: 8.5, clearance: 0.15, chamfer: false }, { hole: true })])],
	['text', makeNode('text')],
	['slot plate (sketch)', makeNode('sketch', { v: 2, points: [[-15, -4], [15, -4], [15, 4], [-15, 4]], segs: [{ a: 0, b: 1 }, { a: 1, b: 2, arc: 1 }, { a: 2, b: 3 }, { a: 3, b: 0, arc: 1 }], circles: [], cons: [], radii: {}, height: 5, mode: 'extrude', anchored: true })],
	['tube', makeNode('tube')],
];
for (const [label, node] of cases) {
	const g = eng.geometry(node);
	const pos = (g.index ? g.toNonIndexed() : g).attributes.position.array;
	const t0 = performance.now();
	const { text, faces, solids } = stepFromPositions(pos, label);
	const ms = performance.now() - t0;
	writeFileSync(`test/downloads/${label.replace(/\W+/g, '_')}.step`, text);
	const res = occt.ReadStepFile(new TextEncoder().encode(text), null);
	const v0 = signedVolume(g);
	const v1 = res.success ? res.meshes.reduce((s, m) => s + Math.abs(meshVolume(m)), 0) : 0;
	const brepFaces = res.success ? res.meshes.reduce((s, m) => s + (m.brep_faces ? m.brep_faces.length : 0), 0) : 0;
	// true cylinders are exact, so OCC can differ from the faceted mesh by the faceting error (< 0.5%)
	const want = { cylinder: [3, 1], 'box with hole (CSG)': [7, 1], tube: [4, 2], 'slot plate (sketch)': [6, 2] }[label];
	const analytic = (text.match(/CYLINDRICAL_SURFACE/g) || []).length;
	const ok = res.success && Math.abs(v1 - v0) / v0 < 5e-3 && (!want || (faces === want[0] && analytic === want[1]));
	if (!ok) fails++;
	console.log(ok ? 'ok  ' : 'FAIL', label.padEnd(24), `faces ${faces} (OCC read ${brepFaces}, cylinders ${(text.match(/CYLINDRICAL_SURFACE/g) || []).length}) solids ${solids}  vol ${v0.toFixed(1)} → OCC ${v1.toFixed(1)}  ${(text.length / 1024).toFixed(0)} KB ${ms.toFixed(0)} ms`);
}
process.exit(fails ? 1 : 0);
