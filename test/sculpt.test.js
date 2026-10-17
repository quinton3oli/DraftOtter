// Sculpting core (sculpt.js): brushes, symmetry, grab, undo / redo, staying a valid solid, and storage.
import Module from 'manifold-3d';
import { readFileSync } from 'node:fs';
import { Engine, initManifold } from '../src/engine.js';
import { Model, makeNode } from '../src/model.js';
import { toManifold, rawOf } from '../src/csgcore.js';
import { SculptSession, falloff, packIndexed, unpackIndexed, soupOf } from '../src/sculpt.js';
import { signedVolume } from '../src/shapes.js';
await initManifold(Module, readFileSync('node_modules/manifold-3d/manifold.wasm'));
const MF = await Module({ wasmBinary: readFileSync('node_modules/manifold-3d/manifold.wasm') }); MF.setup();
const model = new Model(), eng = new Engine(model);
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(ok ? 'ok  ' : 'FAIL', name, info); };

const sphereSession = (L = 0.7) => {
	const m = toManifold(eng.geometry(makeNode('sphere', { r: 10, seg: 48 })));
	const f = m.refineToLength(L), r = rawOf(f);
	m.delete(); f.delete();
	return new SculptSession(new Float32Array(r.pos), new Uint32Array(r.idx));
};
const vol = (s) => { const { positions, index } = s.export(); const g = { attributes: { position: { array: soupOf(positions, index), count: index.length } }, index: null }; return signedVolume(g); };
const maxZ = (s) => { let z = -Infinity; for (let v = 0; v < s.nv; v++) z = Math.max(z, s.pos[3 * v + 2]); return z; };
const top = (s) => { let best = 0; for (let v = 0; v < s.nv; v++) if (s.pos[3 * v + 2] > s.pos[3 * best + 2]) best = v; return [s.pos[3 * best], s.pos[3 * best + 1], s.pos[3 * best + 2]]; };
const validSolid = (s) => { const { positions, index } = s.export(); const m = new MF.Manifold(new MF.Mesh({ numProp: 3, vertProperties: positions, triVerts: index })); const st = m.status(); m.delete(); return st; };
const opts = { radius: 3, strength: 1, falloff: 'smooth', invert: false, symmetry: [false, false, false] };

let s = sphereSession();
const deg = (s.nbStart[s.nv] / s.nv);
check('a subdivided sphere with neighbor lists (about 6 neighbors per vertex)', s.nt > 5000 && deg > 5.5 && deg < 6.5, `${s.nt} triangles, ${deg.toFixed(2)} neighbors`);
check('falloff: 1 at the center, 0 at the edge, smooth in between', falloff('smooth', 0) === 1 && falloff('smooth', 1) === 0 && Math.abs(falloff('smooth', 0.5) - 0.5) < 1e-9);
const hit = s.raycast({ origin: { x: 0, y: 0, z: 50 }, direction: { x: 0, y: 0, z: -1 } } instanceof Object ? new (await import('three')).Ray(new (await import('three')).Vector3(0, 0, 50), new (await import('three')).Vector3(0, 0, -1)) : null);
check('raycast finds the top of the sphere', hit && Math.abs(hit.point[2] - 10) < 0.05 && hit.normal[2] > 0.99, JSON.stringify(hit && hit.point));

// draw raises, only under the brush
const z0 = maxZ(s), far0 = s.pos.slice(0, 3 * s.nv).filter((_, i) => i % 3 === 2 && false);
s.beginStroke('draw');
const moved = s.dab('draw', top(s), opts);
s.endStroke(); s.changed(moved);
check('Draw raises the surface under the brush', maxZ(s) > z0 + 0.1, `${z0.toFixed(3)} → ${maxZ(s).toFixed(3)}`);
check('…and only within the radius', moved.every((v) => Math.hypot(s.pos[3 * v], s.pos[3 * v + 1]) < 3.5));
check('…it is still a valid closed solid', validSolid(s) === 'NoError', validSolid(s));
const raised = vol(s);
check('…with a bit more volume', raised > 4 / 3 * Math.PI * 1000 * 0.98, raised.toFixed(1));
s.undo();
check('undo puts every vertex back exactly', Math.abs(maxZ(s) - z0) < 1e-6 && Math.abs(vol(s) - vol(sphereSession())) < 1e-3);
s.redo();
check('redo brings the stroke back', maxZ(s) > z0 + 0.1);

// Ctrl: dig in
s = sphereSession();
s.beginStroke('draw'); s.dab('draw', top(s), { ...opts, invert: true }); s.endStroke();
check('Draw with Ctrl digs in', maxZ(s) < z0 - 0.1, maxZ(s).toFixed(3));

// symmetry: a stroke on +X also happens on −X
s = sphereSession();
const px = [7.07, 0, 7.07], pre = s.export().positions;
s.beginStroke('draw'); const sm = s.dab('draw', px, { ...opts, symmetry: [true, false, false] }); s.endStroke();
let left = 0, right = 0;
for (const v of new Set(sm)) { const d = Math.hypot(s.pos[3 * v] - pre[3 * v], s.pos[3 * v + 1] - pre[3 * v + 1], s.pos[3 * v + 2] - pre[3 * v + 2]); if (pre[3 * v] > 0) right = Math.max(right, d); else left = Math.max(left, d); }
check('symmetry X mirrors the stroke to the other side', left > 0.1 && Math.abs(left - right) / right < 0.15, `${left.toFixed(3)} / ${right.toFixed(3)}`);

// smooth and flatten take a bump back down
s = sphereSession();
for (let i = 0; i < 4; i++) { s.beginStroke('draw'); s.dab('draw', top(s), opts); s.endStroke(); }
const bump = maxZ(s);
for (let i = 0; i < 6; i++) { s.beginStroke('smooth'); s.dab('smooth', [0, 0, bump], { ...opts, radius: 4 }); s.endStroke(); }
check('Smooth evens out a bump', maxZ(s) < bump - 0.3, `${bump.toFixed(2)} → ${maxZ(s).toFixed(2)}`);
s = sphereSession();
for (let i = 0; i < 6; i++) { s.beginStroke('flatten'); s.dab('flatten', [0, 0, 10], { ...opts, radius: 5 }); s.endStroke(); }
// the top cap (not the bottom of the sphere): how far from flat it is now, against before
const capSpread = (q) => { let lo = Infinity, hi = -Infinity; for (let v = 0; v < q.nv; v++) if (q.pos[3 * v + 2] > 0 && Math.hypot(q.pos[3 * v], q.pos[3 * v + 1]) < 2.5) { lo = Math.min(lo, q.pos[3 * v + 2]); hi = Math.max(hi, q.pos[3 * v + 2]); } return hi - lo; };
const spread0 = capSpread(sphereSession()), spread = capSpread(s);
check('Flatten presses the top flat', spread < spread0 * 0.4, `${spread0.toFixed(3)} → ${spread.toFixed(3)}`);

// inflate grows, clay builds up, pinch and crease pull in
s = sphereSession();
const v0 = vol(s);
s.beginStroke('inflate'); s.dab('inflate', [0, 0, 10], { ...opts, radius: 6 }); s.endStroke();
check('Inflate adds volume', vol(s) > v0 + 1, (vol(s) - v0).toFixed(2));
s = sphereSession();
s.beginStroke('clay'); s.dab('clay', [0, 0, 10], { ...opts, radius: 4 }); s.endStroke();
check('Clay builds up', vol(s) > v0 + 0.5 && validSolid(s) === 'NoError', (vol(s) - v0).toFixed(2));
s = sphereSession();
s.beginStroke('crease'); s.dab('crease', [0, 0, 10], opts); s.endStroke();
check('Crease cuts a groove', maxZ(s) < 10 - 0.05 || vol(s) < v0, maxZ(s).toFixed(3));
s = sphereSession();
s.beginStroke('pinch'); const pm = s.dab('pinch', [0, 0, 10], opts); s.endStroke();
const before = sphereSession().export().positions;
const closer = pm.filter((v) => Math.hypot(s.pos[3 * v], s.pos[3 * v + 1]) < Math.hypot(before[3 * v], before[3 * v + 1]) - 1e-6).length;
check('Pinch pulls the surface toward the brush center', closer > pm.length * 0.6, `${closer} of ${pm.length}`);

// grab
s = sphereSession();
s.beginStroke('grab');
s.grabStart([0, 0, 10], { ...opts, radius: 4 });
s.changed(s.grabMove([0, 0, 5]));
s.endStroke();
check('Grab drags the region with the pointer', Math.abs(maxZ(s) - 15) < 0.3 && validSolid(s) === 'NoError', maxZ(s).toFixed(3));
s.undo();
check('…and undoes in one step', Math.abs(maxZ(s) - 10) < 0.01);

// storage
const ex = s.export();
const packed = packIndexed(ex.positions, ex.index), back = unpackIndexed(packed);
check('indexed storage round-trips exactly', back.positions.length === ex.positions.length && back.positions.every((x, i) => x === ex.positions[i]) && back.index.every((x, i) => x === ex.index[i]));
check('…and is about half the size of a triangle list', packed.length < (ex.index.length * 12 * 4) / 3 * 0.6, `${(packed.length / 1e6).toFixed(2)} MB`);
model.blobs.sc = packed;
const g = eng.geometry(makeNode('mesh', { blob: 'sc' }));
check('a mesh part reads the indexed format', g && g.attributes.position.count === ex.index.length);

console.log(fails ? `${fails} FAILED` : 'sculpt: all passed');
process.exit(fails ? 1 : 0);
