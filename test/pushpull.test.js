// Push/pull geometry: flat faces with draft, curved faces (tube walls), against exact volumes.
import * as THREE from 'three';
import Module from 'manifold-3d';
import { readFileSync } from 'node:fs';
import { Engine, initManifold } from '../src/engine.js';
import { Model, makeNode, makeGroup } from '../src/model.js';
import { signedVolume } from '../src/shapes.js';
import { faceRegion } from '../src/pushpull.js';
await initManifold(Module, readFileSync('node_modules/manifold-3d/manifold.wasm'));
const eng = new Engine(new Model());
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(ok ? 'ok  ' : 'FAIL', name, info); };
// find a triangle whose centroid satisfies a predicate
const triWhere = (geom, pred) => {
	const p = geom.attributes.position, idx = geom.index;
	const n = idx ? idx.count / 3 : p.count / 3, v = new THREE.Vector3(), c = new THREE.Vector3();
	for (let t = 0; t < n; t++) {
		c.set(0, 0, 0);
		for (let k = 0; k < 3; k++) c.add(v.fromBufferAttribute(p, idx ? idx.getX(t * 3 + k) : t * 3 + k));
		if (pred(c.divideScalar(3))) return t;
	}
	return -1;
};
const featureFrom = (region, depth, draft = 0) => region.curved
	? makeNode('faceoff', { V: region.V.map((v) => v.toArray()), N: region.N.map((n) => n.toArray()), T: region.T, depth }, { hole: depth < 0 })
	: (() => {
		const f = makeNode('facex', { loops: region.loops, depth, draft }, { hole: depth < 0 });
		const m = new THREE.Matrix4().compose(region.origin, region.basis.quat, new THREE.Vector3(1, 1, 1));
		const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
		m.decompose(p, q, s);
		const e = new THREE.Euler().setFromQuaternion(q);
		f.pos = p.toArray(); f.rot = [e.x, e.y, e.z].map((a) => (a * 180) / Math.PI);
		return f;
	})();
const vol = (n) => signedVolume(eng.geometry(n));

// flat face, no draft / with draft
const box = makeNode('box');
let g = eng.geometry(box), mesh = new THREE.Mesh(g);
let R = faceRegion(mesh, triWhere(g, (c) => Math.abs(c.z - 10) < 1e-6));
check('box top is a flat face (not curved)', R && !R.curved && Math.abs(R.area - 400) < 1e-6);
let v = vol(makeGroup([box, featureFrom(R, 10)]));
check('push top +10', Math.abs(v - 12000) < 0.01, v.toFixed(3));
v = vol(makeGroup([box, featureFrom(R, 10, 10)]));
const t = Math.tan((10 * Math.PI) / 180), a2 = 20 - 2 * 10 * t;
const frustum = (10 / 3) * (400 + a2 * a2 + 20 * a2);
check('push top +10 with 10° draft (frustum)', Math.abs(v - (8000 + frustum)) < 0.05, `${(v - 8000).toFixed(3)} vs ${frustum.toFixed(3)}`);
v = vol(makeGroup([box, featureFrom(R, -6, 10)]));
const a3 = 20 - 2 * 6 * t, pocket = (6 / 3) * (400 + a3 * a3 + 20 * a3);
check('pocket −6 with 10° draft narrows going in', Math.abs(8000 - v - pocket) < 0.05, `${(8000 - v).toFixed(3)} vs ${pocket.toFixed(3)}`);

// curved: tube outer wall +2, inner wall +1 (towards the axis)
const tube = makeNode('tube', { ro: 10, ri: 7, h: 20, seg: 96 });
g = eng.geometry(tube); mesh = new THREE.Mesh(g);
const v0 = vol(tube);
R = faceRegion(mesh, triWhere(g, (c) => Math.hypot(c.x, c.y) > 9.9 && Math.abs(c.z) < 5));
check('tube outer wall is picked as one curved surface', R && R.curved && Math.abs(R.area - 2 * 96 * 10 * Math.sin(Math.PI / 96) * 20) < 0.5, R && `area ${R.area.toFixed(2)}`);
v = vol(makeGroup([tube, featureFrom(R, 2)]));
const ring = (ro, ri) => 0.5 * 96 * Math.sin((2 * Math.PI) / 96) * (ro * ro - ri * ri) * 20;
check('thicken outer wall by 2 (outer radius 10 → 12)', Math.abs(v - (v0 + ring(12, 10))) / ring(12, 10) < 0.002, `${(v - v0).toFixed(2)} vs ${ring(12, 10).toFixed(2)}`);
R = faceRegion(mesh, triWhere(g, (c) => Math.hypot(c.x, c.y) < 7.1 && Math.abs(c.z) < 5));
v = vol(makeGroup([tube, featureFrom(R, 1)]));
check('thicken inner wall by 1 (inner radius 7 → 6)', R.curved && Math.abs(v - (v0 + ring(7, 6))) / ring(7, 6) < 0.002, `${(v - v0).toFixed(2)} vs ${ring(7, 6).toFixed(2)}`);
v = vol(makeGroup([tube, featureFrom(faceRegion(mesh, triWhere(g, (c) => Math.hypot(c.x, c.y) > 9.9 && Math.abs(c.z) < 5)), -1)]));
check('thin the outer wall by 1 (10 → 9)', Math.abs(v0 - v - ring(10, 9)) / ring(10, 9) < 0.002, `${(v0 - v).toFixed(2)} vs ${ring(10, 9).toFixed(2)}`);
// flat face next to a tangent fillet stays flat
const filleted = makeGroup([makeNode('box'), makeNode('edgeop', { chains: [], kind: 'fillet', size: 2 })]);
process.exit(fails ? 1 : 0);
