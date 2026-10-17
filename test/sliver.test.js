// Push/pull on slanted faces (a 5-point star with all ten sides pushed out, as built in the app): the result is
// exactly as tall as the star, with no near-duplicate vertices (the sub-micron steps rounding used to leave), and
// the placement helpers keep slanted values exact while removing float noise.
import Module from 'manifold-3d';
import { readFileSync } from 'node:fs';
import { Engine, initManifold } from '../src/engine.js';
import { Model, makeNode, makeGroup } from '../src/model.js';
import { toManifold } from '../src/csgcore.js';
import { snapMeasured, snapAngle } from '../src/rounding.js';
await initManifold(Module, readFileSync('node_modules/manifold-3d/manifold.wasm'));
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(ok ? 'ok  ' : 'FAIL', name, info); };

// the push/pulls of a real design (placement as the app stored it before this fix: rounded to microns / 4 decimals)
const F = [
	[[0, -6.146, -15.3], [90, 33.7234, 0], [[0, 0], [0, 30.6], [-8.48, 30.6], [-8.48, 0]]],
	[[0, -6.146, -15.3], [89.9999, -33.723, 0], [[0, 0], [8.48, 0], [8.481, 30.6], [0, 30.6]]],
	[[4.755, -2.691, 15.3], [-90, 74.2766, 0], [[0, 0], [8.45, 0], [8.45, 30.6], [0, 30.6]]],
	[[4.755, -2.691, -15.3], [90, 38.2766, 0], [[0, 0], [8.48, 0], [8.48, 30.6], [0, 30.6]]],
	[[2.939, 2.899, 15.3], [-90, 2.2766, 0], [[0, 0], [8.449, 0], [8.449, 30.6], [0, 30.6]]],
	[[2.939, 2.899, 15.3], [-90, 69.7234, 0], [[0, 0], [0, 30.6], [-8.48, 30.6], [-8.48, 0]]],
	[[-2.939, 2.899, -15.3], [-90, -69.7234, 0], [[0, 0], [0, -30.6], [8.45, -30.6], [8.45, 0]]],
	[[-2.939, 2.899, 15.3], [-90, -2.2766, 0], [[0, 0], [0, 30.6], [-8.48, 30.6], [-8.48, 0]]],
	[[-4.755, -2.691, -15.3], [90, -38.2766, 0], [[0, 0], [0, 30.6], [-8.449, 30.6], [-8.449, 0]]],
	[[-7.045, -10.825, -15.3], [-90, -74.2766, 0], [[0, 0], [0, -30.6], [8.449, -30.6], [8.449, 0]]],
];
const star = makeNode('star', { points: 5, ro: 12, ri: 5, h: 30.6, edge: 0 });
const feats = F.map(([pos, rot, loop]) => { const n = makeNode('facex', { depth: 2, draft: 0, loops: [loop] }); n.pos = pos; n.rot = rot.map(snapAngle); return n; });
const g = makeGroup([star, ...feats]);
const model = new Model(); model.load({ ...model.emptyDoc(), nodes: [g] });
const eng = new Engine(model);
const geo = eng.geometry(g);
geo.computeBoundingBox();
const h = geo.boundingBox.max.z - geo.boundingBox.min.z;
check('the pushed-out star is exactly as tall as the star', Math.abs(h - 30.6) < 1e-6, h);
const P = geo.attributes.position.array, cells = new Map();
for (let i = 0; i < P.length; i += 3) { const k = Math.round(P[i] / 0.002) + ',' + Math.round(P[i + 1] / 0.002) + ',' + Math.round(P[i + 2] / 0.002); if (!cells.has(k)) cells.set(k, new Set()); cells.get(k).add(P[i] + ',' + P[i + 1] + ',' + P[i + 2]); }
let worst = 0;
for (const c of cells.values()) { const pts = [...c].map((k) => k.split(',').map(Number)); for (const p of pts) for (const q of pts) worst = Math.max(worst, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])); }
console.log('worst step', worst);
check('…where the push/pulls meet the star, any step is under a micron', worst < 1e-3, worst + ' mm');
let ok = true;
try { const m = toManifold(geo); ok = m.status() === 'NoError'; m.delete(); } catch (e) { ok = false; }
check('…and it is a valid solid that can be cut or joined further', ok);

check('measured values: float noise removed (15.3000002 → 15.3)', snapMeasured(15.3000002) === 15.3 && snapMeasured(-6.1459998) === -6.146);
check('…but a value on a slanted face keeps its precision (not rounded to a micron)', snapMeasured(6.14637115) === 6.14637115 && snapMeasured(2.69097) === 2.69097);
check('angles: 89.9999° → 90°, others kept to 9 decimals', snapAngle(89.9999) === 90 && snapAngle(-90.00002) === -90 && snapAngle(33.72339427) === 33.72339427);

console.log(fails ? `${fails} FAILED` : 'sliver: all passed');
process.exit(fails ? 1 : 0);
