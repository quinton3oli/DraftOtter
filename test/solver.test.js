import { solveSketch, degreesOfFreedom, remapInsert, remapDelete, solveModel, modelDOF } from '../src/constraints.js';
import { profileRegions, toModel, arcInfo } from '../src/sketchModel.js';
let fails = 0;
const ok = (name, cond, info = '') => { if (!cond) fails++; console.log(cond ? 'ok  ' : 'FAIL', name, info); };
const near = (a, b, t = 1e-5) => Math.abs(a - b) < t;
const L = (p, q) => Math.hypot(q[0] - p[0], q[1] - p[1]);

// Rough quad -> exact 40 x 20 rectangle anchored at the origin
let pts = [[0.5, -0.3], [37, 2], [41, 18], [-2, 23]];
let cons = [
	{ type: 'fix', p: [0], x: 0, y: 0 }, { type: 'h', e: [0] }, { type: 'v', e: [1] }, { type: 'h', e: [2] }, { type: 'v', e: [3] },
	{ type: 'len', e: [0], value: 40 }, { type: 'len', e: [1], value: 20 },
];
let t0 = performance.now();
let r = solveSketch(pts, cons);
ok('rectangle solves', r.ok && near(r.pts[2][0], 40) && near(r.pts[2][1], 20) && near(r.pts[0][0], 0), JSON.stringify(r.pts.map((p) => p.map((v) => +v.toFixed(4)))) + ` ${(performance.now() - t0).toFixed(1)}ms`);
ok('fully constrained rectangle has 0 DOF', degreesOfFreedom(r.pts, cons) === 0, 'dof=' + degreesOfFreedom(r.pts, cons));
ok('unconstrained square has 8 DOF', degreesOfFreedom(pts, []) === 8);
ok('without fix: 2 DOF (translation)', degreesOfFreedom(r.pts, cons.slice(1)) === 2, 'dof=' + degreesOfFreedom(r.pts, cons.slice(1)));

// Changing a dimension re-solves
cons[5].value = 55;
r = solveSketch(r.pts, cons);
ok('changing a length re-solves', r.ok && near(L(r.pts[0], r.pts[1]), 55) && near(r.pts[2][0], 55));

// Dragging a held point: other points follow constraints
const held = r.pts.map((p) => p.slice());
held[2] = [70, 35];
r = solveSketch(held, cons.filter((c) => c.type !== 'len'), [2]);
ok('drag keeps rectangle shape', r.ok && near(r.pts[2][0], 70) && near(r.pts[1][0], 70) && near(r.pts[3][1], 35), JSON.stringify(r.pts.map((p) => p.map((v) => +v.toFixed(3)))));

// Parallel / perpendicular / equal / angle on a triangle-ish shape
pts = [[0, 0], [30, 2], [28, 25], [3, 22]];
cons = [{ type: 'par', e: [0, 2] }, { type: 'perp', e: [0, 1] }, { type: 'eq', e: [0, 1] }];
r = solveSketch(pts, cons);
const d0 = [r.pts[1][0] - r.pts[0][0], r.pts[1][1] - r.pts[0][1]], d1 = [r.pts[2][0] - r.pts[1][0], r.pts[2][1] - r.pts[1][1]];
ok('perpendicular + equal + parallel', r.ok && near(d0[0] * d1[0] + d0[1] * d1[1], 0, 1e-4) && near(L(r.pts[0], r.pts[1]), L(r.pts[1], r.pts[2]), 1e-4));
pts = [[0, 0], [30, 0], [10, 20]];
r = solveSketch(pts, [{ type: 'angle', p: [0], value: 30 }, { type: 'fix', p: [0], x: 0, y: 0 }, { type: 'h', e: [0] }]);
const ang = Math.atan2(r.pts[2][1], r.pts[2][0]) * 180 / Math.PI;
ok('corner angle = 30°', r.ok && near(ang, 30, 1e-3), ang.toFixed(4));

// Conflicting constraints are reported
r = solveSketch([[0, 0], [10, 0], [10, 10], [0, 10]], [{ type: 'len', e: [0], value: 10 }, { type: 'len', e: [0], value: 20 }]);
ok('conflict reported', !r.ok && r.bad.length > 0, 'bad=' + r.bad);

// Index remapping
const ins = remapInsert([{ type: 'h', e: [0] }, { type: 'v', e: [1] }, { type: 'fix', p: [2] }], { 2: 3 }, 1, 4);
ok('insert splits edge 0 (drops its constraint) and shifts others', ins.cons.length === 2 && ins.cons[0].e[0] === 2 && ins.cons[1].p[0] === 3 && ins.radii[3] === 3, JSON.stringify(ins));
const del = remapDelete([{ type: 'h', e: [0] }, { type: 'v', e: [2] }, { type: 'fix', p: [3] }], {}, 1, 4);
ok('delete merges edges and shifts indices', del.cons.length === 2 && del.cons[0].e[0] === 1 && del.cons[1].p[0] === 2, JSON.stringify(del));

// ---------------------------------------------------------------- entity model (arcs, circles, construction)
{
	// slot: two lines + two semicircular arcs, tangent, radius 5, length 30
	const m = { points: [[0, 0], [30, 0.5], [31, 10], [-1, 9.5]], segs: [{ a: 0, b: 1 }, { a: 1, b: 2, arc: 0.9 }, { a: 2, b: 3 }, { a: 3, b: 0, arc: 1.1 }], circles: [], radii: {},
		cons: [{ type: 'fix', p: [0], x: 0, y: 0 }, { type: 'h', s: [0] }, { type: 'tangent', s: [0, 1] }, { type: 'tangent', s: [1, 2] }, { type: 'tangent', s: [2, 3] }, { type: 'tangent', s: [3, 0] }, { type: 'radius', s: [1], value: 5 }, { type: 'len', s: [0], value: 30 }, { type: 'h', s: [2] }] };
	const r = solveModel(m);
	const a1 = arcInfo(m.points[1], m.points[2], m.segs[1].arc);
	ok('slot with tangent arcs solves', r.ok && Math.abs(a1.R - 5) < 1e-6 && Math.abs(m.points[1][0] - 30) < 1e-6 && Math.abs(m.points[2][1] - 10) < 1e-5, JSON.stringify(m.points.map((p) => p.map((v) => +v.toFixed(3)))));
	const reg = profileRegions({ v: 2, ...m });
	const area = (p) => { let s = 0; for (let i = 0; i < p.length; i++) { const q = p[i], w = p[(i + 1) % p.length]; s += q[0] * w[1] - w[0] * q[1]; } return Math.abs(s / 2); };
	ok('slot profile area = rectangle + circle', reg.length === 1 && Math.abs(area(reg[0].outer) - (30 * 10 + Math.PI * 25)) < 0.5, area(reg[0].outer).toFixed(2));
	ok('slot is fully constrained', modelDOF(m) === 0, 'dof=' + modelDOF(m));
}
{
	// plate with two circular holes
	const m = { points: [[-20, -10], [20, -10], [20, 10], [-20, 10], [-10, 0], [11, 1]], segs: [{ a: 0, b: 1 }, { a: 1, b: 2 }, { a: 2, b: 3 }, { a: 3, b: 0 }],
		circles: [{ c: 4, r: 2 }, { c: 5, r: 4 }], radii: {}, cons: [{ type: 'dia', c: [0], value: 6 }, { type: 'dia', c: [1], value: 6 }, { type: 'py', p: [5], value: 0 }] };
	const r = solveModel(m);
	const reg = profileRegions({ v: 2, ...m });
	ok('circles inside a rectangle become holes', r.ok && reg.length === 1 && reg[0].holes.length === 2 && Math.abs(m.circles[1].r - 3) < 1e-6 && Math.abs(m.points[5][1]) < 1e-6);
	m.circles[0].cons = true;
	ok('construction geometry is not part of the profile', profileRegions({ v: 2, ...m })[0].holes.length === 1);
	ok('a lone circle forms a disc', profileRegions({ v: 2, points: [[0, 0]], segs: [], circles: [{ c: 0, r: 5 }], cons: [], radii: {} }).length === 1);
	const two = toModel({ pts: [[0, 0], [10, 0], [10, 10], [0, 10]] });
	two.points.push([20, 0], [30, 0], [30, 10], [20, 10]);
	two.segs.push({ a: 4, b: 5 }, { a: 5, b: 6 }, { a: 6, b: 7 }, { a: 7, b: 4 });
	ok('separate loops become separate solids', profileRegions({ v: 2, ...two }).length === 2);
	const washer = profileRegions({ v: 2, points: [[0, 0], [0, 0]], segs: [], circles: [{ c: 0, r: 10 }, { c: 1, r: 4 }], cons: [], radii: {} });
	ok('a circle inside a circle makes a washer', washer.length === 1 && washer[0].holes.length === 1);
}
{
	// symmetric about a construction line, point on circle, concentric circles
	const m = { points: [[0, -10], [0, 10], [-7, 3], [6, 4], [3, 9], [20, 20], [21, 21]], segs: [{ a: 0, b: 1, cons: true }, { a: 2, b: 3 }],
		circles: [{ c: 5, r: 5 }, { c: 6, r: 2 }], radii: {},
		cons: [{ type: 'fix', p: [0], x: 0, y: -10 }, { type: 'v', s: [0] }, { type: 'sym', p: [2, 3], s: [0] }, { type: 'online', p: [4], c: [0] }, { type: 'concentric', c: [0, 1] }] };
	const r = solveModel(m);
	const P = m.points;
	ok('points symmetric about a construction line', r.ok && Math.abs(P[2][0] + P[3][0]) < 1e-6 && Math.abs(P[2][1] - P[3][1]) < 1e-6);
	ok('point on circle & concentric circles', Math.abs(Math.hypot(P[4][0] - P[5][0], P[4][1] - P[5][1]) - m.circles[0].r) < 1e-6 && Math.hypot(P[5][0] - P[6][0], P[5][1] - P[6][1]) < 1e-6);
}
{
	const m = toModel({ pts: [[0, 0], [10, 0], [10, 5]], cons: [{ type: 'h', e: [0], p: [] }, { type: 'angle', p: [1], e: [], value: 90 }] });
	ok('legacy sketches convert (edges → segments, corner angles → segment pairs)', m.segs.length === 3 && m.cons[0].s[0] === 0 && JSON.stringify(m.cons[1].s) === '[0,1]');
}

process.exit(fails ? 1 : 0);
