// Edge detection + fillet / chamfer volumes against hand-calculated values.
import * as THREE from 'three';
import Module from 'manifold-3d';
import { readFileSync } from 'node:fs';
import { Engine, initManifold } from '../src/engine.js';
import { Model, makeNode, makeGroup } from '../src/model.js';
import { signedVolume } from '../src/shapes.js';
import { extractEdges } from '../src/edges.js';
await initManifold(Module, readFileSync('node_modules/manifold-3d/manifold.wasm'));
const eng = new Engine(new Model());
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(ok ? 'ok  ' : 'FAIL', name, info); };
const meshOf = (node) => new THREE.Mesh(eng.geometry(node));
// Faceted arcs (12 segments) deviate from a true circle by ~0.1 %; tolerances below allow for that.
const fillet = (node, chains, kind, size) => {
	const cut = chains.filter((c) => c.convex), fill = chains.filter((c) => !c.convex);
	const kids = [node];
	if (cut.length) kids.push(makeNode('edgeop', { chains: cut, kind, size }, { hole: true }));
	if (fill.length) kids.push(makeNode('edgeop', { chains: fill, kind, size }));
	const g = eng.geometry(makeGroup(kids));
	return g ? signedVolume(g) : NaN;
};
const k = 1 - Math.PI / 4;

const box = makeNode('box');
let E = extractEdges(meshOf(box));
check('box has 12 straight convex edges', E.chains.length === 12 && E.chains.every((c) => c.convex && !c.closed && Math.abs(c.angle - 90) < 1e-6), `${E.chains.length} chains`);
const topFront = E.chains.find((c) => c.pts.every((p) => Math.abs(p[2] - 10) < 1e-6 && Math.abs(p[1] + 10) < 1e-6));
let v = fillet(box, [topFront], 'fillet', 3);
check('fillet r=3 on one box edge', Math.abs(v - (8000 - 20 * 9 * k)) / (20 * 9 * k) < 0.02, `${v.toFixed(2)} vs ${(8000 - 20 * 9 * k).toFixed(2)}`);
v = fillet(box, [topFront], 'chamfer', 3);
check('chamfer 3 mm on one box edge', Math.abs(v - (8000 - 20 * 4.5)) < 0.05, `${v.toFixed(2)} vs 7910`);
const top4 = E.chains.filter((c) => c.pts.every((p) => Math.abs(p[2] - 10) < 1e-6));
v = fillet(box, top4, 'fillet', 2);
const expect4 = 8000 - 4 * 20 * 4 * k + 4 * 4 * k * 2 * (1 - 2 / 3 * 0);
check('fillet all 4 top edges (overlapping corners stay clean)', v < 8000 - 4 * 16 * 4 * k && v > 8000 - 4 * 20 * 4 * k - 1, v.toFixed(2));

// all 12 edges with fillet r = 3 → rounded cube: 14³ + 6·14²·3 + 3·14·π·9 + 4/3·π·27 = 7572.6 (spherical corners)
v = fillet(box, E.chains, 'fillet', 3);
check('fillet all 12 box edges gives spherical (rolling-ball) corners', Math.abs(v - 7572.6) / 7572.6 < 0.01, `${v.toFixed(1)} vs 7572.6`);
// all 12 edges chamfered by 2: cube minus 12 wedges (2·20·2/2 each, overlapping corners counted via inclusion–exclusion)
v = fillet(box, E.chains, 'chamfer', 2);
const chamferExact = 8000 - 12 * (2 * 20) + 8 * (2 * 2 * 2) * (2 / 3) - 8 * (2 * 2 * 2) / 6 * 0;
// exact by inclusion–exclusion (d = 2): 8000 − 12·(d²/2·20) + 8·(3 pairwise overlaps d³/3) − 8·(triple overlap d³/4) = 7568
check('chamfer all 12 box edges gives exact corners', Math.abs(v - (8000 - 12 * 40 + 8 * 8 - 8 * 2)) < 0.01, v.toFixed(3));

// concave: inner corner of an L-bracket (no built-in fillet)
const lb = makeNode('lbracket', { fillet: 0, holes: 0 });
E = extractEdges(meshOf(lb));
const inner = E.chains.filter((c) => !c.convex);
check('L-bracket has one concave edge', inner.length === 1, `${inner.length} concave of ${E.chains.length}`);
const v0 = signedVolume(eng.geometry(lb));
v = fillet(lb, inner, 'fillet', 2);
check('concave fillet r=2 adds material', Math.abs(v - (v0 + 20 * 4 * k)) / (20 * 4 * k) < 0.02, `${(v - v0).toFixed(3)} vs ${(20 * 4 * k).toFixed(3)}`);

// curved edge: rim of a hole drilled through a plate (after a boolean)
const plate = makeGroup([makeNode('box', { w: 40, d: 40, h: 10 }), makeNode('cylinder', { r: 8, h: 30, seg: 96 }, { hole: true })]);
E = extractEdges(meshOf(plate));
const rims = E.chains.filter((c) => c.closed);
check('hole rims found as closed curved edges', rims.length === 2 && rims.every((c) => c.convex), `${rims.length} closed of ${E.chains.length}`);
const pv0 = signedVolume(eng.geometry(plate));
const topRim = rims.find((c) => c.pts[0][2] > 0);
v = fillet(plate, [topRim], 'chamfer', 1);
const expectCh = 0.5 * 2 * Math.PI * (8 + 1 / 3); // Pappus: triangle area × centroid path
check('chamfer 1 mm on the hole rim (countersink)', Math.abs(pv0 - v - expectCh) < 0.6, `${(pv0 - v).toFixed(2)} vs ${expectCh.toFixed(2)}`);
v = fillet(plate, [topRim], 'fillet', 1.5);
check('fillet r=1.5 on the hole rim builds', v > 0 && v < pv0, (pv0 - v).toFixed(2));
// cylinder top edge (curved convex)
const cyl = makeNode('cylinder', { r: 10, h: 20, seg: 96 });
E = extractEdges(meshOf(cyl));
const rim = E.chains.find((c) => c.closed && c.pts[0][2] > 0);
v = fillet(makeNode('cylinder', { r: 10, h: 20, seg: 96 }), [rim], 'fillet', 2);
const pappus = 4 * k * 2 * Math.PI * (10 - 2 + 2 * (10 - 3 * Math.PI) / (12 - 3 * Math.PI) * 0 + (2 - (2 * 2) / (3 * (4 - Math.PI)) * 0));
check('fillet on a cylinder top edge removes a ring', v < signedVolume(eng.geometry(cyl)) - 40, (signedVolume(eng.geometry(cyl)) - v).toFixed(2));
process.exit(fails ? 1 : 0);
