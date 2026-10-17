// Surface textures and deforms (modifiers.js) through the engine, against exact volumes and positions.
import * as THREE from 'three';
import Module from 'manifold-3d';
import { readFileSync } from 'node:fs';
import { Engine, initManifold } from '../src/engine.js';
import { Model, makeNode, makeGroup } from '../src/model.js';
import { signedVolume } from '../src/shapes.js';
import { makeDeform, invertRest, emptyLattice, latticePoint, textureHeight, TEXTURE_DEFAULTS } from '../src/modifiers.js';
await initManifold(Module, readFileSync('node_modules/manifold-3d/manifold.wasm'));
const eng = new Engine(new Model());
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(ok ? 'ok  ' : 'FAIL', name, info); };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const info = (g) => { g.computeBoundingBox(); const b = g.boundingBox; return { vol: signedVolume(g), min: b.min.toArray().map((v) => +v.toFixed(3)), max: b.max.toArray().map((v) => +v.toFixed(3)), tris: g.attributes.position.count / 3 }; };
const build = (mode, settings, ...kids) => { const g = makeGroup(kids, { mode, [mode]: settings }); return { g, geo: eng.geometry(g) }; };
const box = (w, d, h) => makeNode('box', { w, d, h });

// ---------------------------------------------------------------- textures
let r = build('texture', { pattern: 'knurl', size: 2, depth: 0.4 }, box(20, 20, 20));
let s = r.geo && info(r.geo);
check('knurl: builds a watertight solid', !!r.geo && !eng.errors.has(r.g.id) && s.tris > 5000, s && s.tris);
check('…that grows outward by at most the depth', s.vol > 8000 && s.vol < 8000 + 6 * 400 * 0.4 && s.max[0] <= 10.4 + 0.6 && s.max[0] > 10.1, JSON.stringify(s));
let manifoldOk = true;
try { eng.manifoldOf(makeGroup([r.g])); } catch (e) { manifoldOk = false; }
check('…and can be joined or cut like any part', manifoldOk);
const t1 = makeGroup([r.g, Object.assign(makeNode('cylinder', { r: 3, h: 30 }), { hole: true })]);
const cut = eng.geometry(t1);
check('…cutting a hole through a textured part works', !!cut && info(cut).vol < s.vol - 400, cut && info(cut).vol);

r = build('texture', { pattern: 'ribs', size: 2, depth: 0.5, faces: 'top' }, box(20, 20, 10));
s = info(r.geo);
check('top only: the sides stay put', near(s.min[0], -10, 0.002) && near(s.max[0], 10, 0.002) && s.max[2] > 5.3 && s.max[2] <= 5.5 + 1e-6, JSON.stringify(s));
check('…and untouched flat faces are simplified back to few triangles', s.tris < 60000, s.tris);

r = build('texture', { pattern: 'bumps', size: 3, depth: -0.5, faces: 'sides' }, box(30, 30, 10));
s = info(r.geo);
check('bumps with negative depth: dimples cut in (smaller volume, same outline)', s.vol < 9000 && s.vol > 9000 - 4 * 300 * 0.5 && near(s.max[2], 5, 0.002) && near(s.max[0], 15, 0.002), JSON.stringify(s));

r = build('texture', { pattern: 'ribs', size: 2, depth: 0.6, angle: 0, faces: 'sides', mapping: 'cylinder' }, makeNode('cylinder', { r: 10, h: 15, seg: 64 }));
s = info(r.geo);
check('ribs around a cylinder (cylindrical mapping)', !!r.geo && s.max[0] > 10.3 && s.max[0] <= 10.6 + 0.01 && near(s.max[2], 7.5, 0.002) && near(s.min[2], -7.5, 0.002), JSON.stringify(s));
// seamless: the pattern repeats a whole number of times around
const ctx = { box: { min: [-10, -10, 0], max: [10, 10, 15] }, wraps: Math.round((2 * Math.PI * 10) / 2) };
const tt = { ...TEXTURE_DEFAULTS, pattern: 'ribs', size: 2, angle: 0, mapping: 'cylinder' };
const hA = textureHeight(tt, [Math.cos(Math.PI - 1e-9) * 10, Math.sin(Math.PI - 1e-9) * 10, 5], [-1, 0, 0], ctx), hB = textureHeight(tt, [Math.cos(-Math.PI + 1e-9) * 10, Math.sin(-Math.PI + 1e-9) * 10, 5], [-1, 0, 0], ctx);
check('…without a seam where it wraps around', near(hA, hB, 1e-4), `${hA} ${hB}`);

for (const pattern of ['waves', 'hex', 'noise']) {
	r = build('texture', { pattern, size: 3, depth: 0.5 }, box(20, 20, 10));
	check(`${pattern}: builds`, !!r.geo && info(r.geo).vol > 4000, r.geo && info(r.geo).vol);
}
r = build('texture', { pattern: 'knurl', size: 2, depth: 0 }, box(10, 10, 10));
check('depth 0 leaves the part as it is', near(info(r.geo).vol, 1000, 1e-6));

// ---------------------------------------------------------------- deforms
r = build('deform', { twist: 90 }, box(10, 10, 40));
s = info(r.geo);
check('twist keeps the volume', near(s.vol, 4000, 40), s.vol);
check('…and turns the top 90° (corners stay within the diagonal)', s.max[0] > 5.5 && s.max[0] <= 7.08, JSON.stringify(s));
r = build('deform', { taper: 0.5 }, box(10, 10, 40));
s = info(r.geo);
check('taper to half: frustum volume', near(s.vol, 100 * 40 * (1 - 0.5 + 0.25 / 3), 4), s.vol);
r = build('deform', { bend: 90, bendDir: '+x' }, box(10, 10, 40));
s = info(r.geo);
const R = 40 / (Math.PI / 2);
check('bend 90°: volume kept', near(s.vol, 4000, 20), s.vol);
check('…and the top ends up turned sideways, an arc of radius L/θ away', near(s.max[0], R, 0.01) && near(s.max[2], R + 5 - 20, 0.01) && near(s.min[0], -5, 0.01), JSON.stringify({ s, R }));
r = build('deform', { bend: -90, bendDir: '+x' }, box(10, 10, 40));
check('a negative bend goes the other way', info(r.geo).min[0] < -R, info(r.geo).min[0]);
r = build('deform', { axis: 'x', bend: 45, bendDir: '+z' }, box(40, 10, 10));
check('bend along X toward +Z', info(r.geo).max[2] > 6, JSON.stringify(info(r.geo)));

// lattice: shear the top 4 points of a 2×2×2 lattice by +10 in X
const lat = emptyLattice(2);
for (const i of [0, 1]) for (const j of [0, 1]) lat.d[i + 2 * (j + 2 * 1)] = [10, 0, 0];
r = build('deform', { lattice: lat }, box(10, 10, 20));
s = info(r.geo);
check('lattice: moving the top points shears the part (volume kept)', near(s.vol, 2000, 5) && near(s.max[0], 15, 0.01) && near(s.min[0], -5, 0.01), JSON.stringify(s));
const lat3 = emptyLattice(3);
lat3.d[1 + 3 * (1 + 3 * 2)] = [0, 0, 8]; // the middle of the top face, up
r = build('deform', { lattice: lat3 }, box(20, 20, 10));
s = info(r.geo);
check('lattice 3×3×3: pulling the top middle point domes the top', s.max[2] > 6 && near(s.min[2], -5, 0.01), JSON.stringify(s));
check('a 2×2×2 corner point sits on the box corner', latticePoint({ min: [-5, -5, -10], max: [5, 5, 10] }, [2, 2, 2], 1, 1, 1).join() === '5,5,10');

// the editor's inverse: rest(invertRest(rest, x)) = x
const f = makeDeform({ axis: 'z', bend: 60, bendDir: '-y', twist: 45, taper: 0.7 }, { min: [-5, -5, -20], max: [5, 5, 20] });
const p = [3, -2, 12], q = invertRest(f.rest, f.rest(p));
check('invertRest undoes bend + twist + taper', Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) < 1e-5, q.join());

// ---------------------------------------------------------------- engine
const g = makeGroup([box(10, 10, 10)], { mode: 'texture', texture: { pattern: 'knurl', size: 2, depth: 0.3 } });
const k1 = eng.key(g);
g.texture.depth = 0.5;
check('changing a setting changes the cache key', eng.key(g) !== k1);
const big = makeGroup([box(100, 100, 100)], { mode: 'texture', texture: { pattern: 'knurl', size: 0.4, depth: 0.2 } });
const t0 = performance.now();
const bg = eng.geometry(big);
check('a texture too fine for a big part is coarsened to stay under the triangle limit', !!bg && info(bg).tris <= 1100000, `${bg && info(bg).tris} tris, ${Math.round(performance.now() - t0)} ms`);

console.log(fails ? `${fails} FAILED` : 'modifiers: all passed');
process.exit(fails ? 1 : 0);
