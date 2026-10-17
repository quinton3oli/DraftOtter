// Advanced parametric shape library: geometric solids, containers, mechanical parts, structural / joinery parts.
// Builders return geometry in absolute coordinates (Z up); shapes.js centers and normalizes them.
// `ctx.csg(solids, holes)` performs watertight booleans for parts assembled from pieces.
import * as THREE from 'three';
import { revolveProfile, extrudePts, bevelExtrude, fromPositions, filletPolygon, arcPts, gearOutline, offsetPolygon, polyArea } from './shapes.js';
import { DEG } from './util.js';
import { buildEdgeOp } from './edges.js';
import { buildFaceExtrude, buildFaceOffset } from './pushpull.js';
import { buildWrap } from './wrap.js';
import { buildWizardHole, HOLE_SIZES, HOLE_TYPES } from './holes.js';

// Param helpers (local copies: shapes.js imports this module, so its helpers are not ready at load time).
const num = (key, label, def, min = 0.01) => ({ key, label, def, min, type: 'num' });
const int = (key, label, def, min = 3, max = 512) => ({ key, label, def, min, max, type: 'int' });
const sel = (key, label, def, options) => ({ key, label, def, options, type: 'select' });
const bool = (key, label, def) => ({ key, label, def, type: 'bool' });
const EDGE = [num('edge', 'Top/bottom edge', 0, 0), sel('edgeType', 'Edge type', 'chamfer', ['chamfer', 'fillet'])];

// ---------------------------------------------------------------- small helpers

const circlePts = (r, n = 48, cx = 0, cy = 0, a0 = 0) => Array.from({ length: n }, (_, i) => {
	const a = a0 + (i / n) * Math.PI * 2;
	return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
});
const ngon = (n, rc, a0 = Math.PI / 2) => circlePts(rc, n, 0, 0, a0);
const cyl = (r, h, seg = 48, z0 = 0) => {
	const g = revolveProfile([[0, 0], [r, 0], [r, h], [0, h]], seg);
	g.translate(0, 0, z0);
	return g;
};
const box = (w, d, h, x = 0, y = 0, z = 0) => {
	const g = new THREE.BoxGeometry(w, d, h).toNonIndexed();
	g.translate(x, y, z);
	return g;
};
const extrude = (pts, h, holes = [], p) => extrudePts(pts, h, holes, 12, p);
// Combine pieces, falling back gracefully when no boolean context is available.
const combine = (ctx, solids, holes = []) => (ctx && ctx.csg ? ctx.csg(solids, holes) : solids[0]);

// ---------------------------------------------------------------- geometric

function buildCapsule(p) {
	const r = p.r, L = Math.max(p.length, 2 * r + 0.01), q = Math.max(4, Math.round(p.seg / 4));
	const prof = [];
	for (let i = 0; i <= q; i++) { const a = -Math.PI / 2 + (Math.PI / 2) * (i / q); prof.push([r * Math.cos(a), r + r * Math.sin(a)]); }
	for (let i = 0; i <= q; i++) { const a = (Math.PI / 2) * (i / q); prof.push([r * Math.cos(a), L - r + r * Math.sin(a)]); }
	return revolveProfile(prof, p.seg);
}

function buildEllipsoid(p) {
	const n = Math.max(8, p.seg | 0), half = Math.round(n / 2), prof = [];
	for (let i = 0; i <= half; i++) { const a = -Math.PI / 2 + (Math.PI * i) / half; prof.push([Math.cos(a), Math.sin(a)]); }
	const g = revolveProfile(prof, n);
	g.scale(p.rx, p.ry, p.rz);
	return g;
}

function buildPolyhedron(p) {
	const C = { tetrahedron: THREE.TetrahedronGeometry, octahedron: THREE.OctahedronGeometry, dodecahedron: THREE.DodecahedronGeometry, icosahedron: THREE.IcosahedronGeometry }[p.kind] || THREE.IcosahedronGeometry;
	const g = new C(p.r, Math.max(0, Math.min(5, p.detail | 0)));
	if (p.flat && !(p.detail > 0)) {
		// Rotate so the first face lies flat on the bed.
		const a = new THREE.Vector3().fromBufferAttribute(g.attributes.position, 0);
		const b = new THREE.Vector3().fromBufferAttribute(g.attributes.position, 1);
		const c = new THREE.Vector3().fromBufferAttribute(g.attributes.position, 2);
		const n = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
		g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(n, new THREE.Vector3(0, 0, -1)));
	}
	return g;
}

function buildTorusKnot(p) {
	return new THREE.TorusKnotGeometry(p.R, p.tube, Math.max(64, p.seg | 0), 16, Math.max(1, p.p | 0), Math.max(1, p.q | 0));
}

function buildTwisted(p) {
	const n = Math.max(3, p.sides | 0);
	const pts = filletPolygon(ngon(n, p.r), p.fillet || 0, 6);
	const steps = Math.max(2, Math.round(Math.abs(p.twist) / 4), p.taper !== 1 ? 12 : 1);
	const g = bevelExtrude([{ outer: pts }], p.h, {}, steps);
	const pos = g.attributes.position;
	for (let i = 0; i < pos.count; i++) {
		const t = pos.getZ(i) / p.h;
		const a = p.twist * DEG * t, s = 1 + (p.taper - 1) * t;
		const x = pos.getX(i) * s, y = pos.getY(i) * s;
		pos.setXY(i, x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a));
	}
	return g;
}

function buildHeart(p) {
	const pts = [];
	for (let i = 0; i < 96; i++) {
		const t = (i / 96) * Math.PI * 2;
		pts.push([16 * Math.sin(t) ** 3, 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)]);
	}
	const k = p.size / 32;
	return extrude(pts.map(([x, y]) => [x * k, y * k]), p.h, [], p);
}

function buildArrow(p) {
	const L = p.length, sw = p.shaft / 2, hw = p.head / 2, hl = Math.min(p.headLength, L * 0.95);
	return extrude([[0, -sw], [L - hl, -sw], [L - hl, -hw], [L, 0], [L - hl, hw], [L - hl, sw], [0, sw]], p.h, [], p);
}

function buildCross(p) {
	const a = p.size / 2, w = p.width / 2;
	return extrude(filletPolygon([[w, -a], [w, -w], [a, -w], [a, w], [w, w], [w, a], [-w, a], [-w, w], [-a, w], [-a, -w], [-w, -w], [-w, -a]], p.fillet || 0), p.h, [], p);
}

function buildSlot(p) {
	const r = p.width / 2, l = Math.max(0, p.length / 2 - r);
	const pts = [...arcPts(l, 0, r, -Math.PI / 2, Math.PI / 2, 24), ...arcPts(-l, 0, r, Math.PI / 2, Math.PI * 1.5, 24)];
	return extrude(pts, p.h, [], p);
}

function buildReuleaux(p) {
	const w = p.width, R = w / Math.sqrt(3), pts = [];
	const v = [0, 1, 2].map((i) => [R * Math.cos(Math.PI / 2 + (i * 2 * Math.PI) / 3), R * Math.sin(Math.PI / 2 + (i * 2 * Math.PI) / 3)]);
	for (let i = 0; i < 3; i++) {
		const c = v[i], a = v[(i + 1) % 3];
		const a0 = Math.atan2(a[1] - c[1], a[0] - c[0]);
		pts.push(...arcPts(c[0], c[1], w, a0, a0 + Math.PI / 3, 20));
	}
	return extrude(pts, p.h, [], p);
}

// ---------------------------------------------------------------- containers

function buildCup(p) {
	const R = p.d / 2, w = Math.min(p.wall, R - 0.2), b = Math.min(p.bottom, p.h - 0.2);
	const prof = [[0, 0], ...(p.round > 0 ? [[R - p.round, 0], ...arcPts(R - p.round, p.round, p.round, -Math.PI / 2, 0, 8)] : [[R, 0]]), [R, p.h], [R - w, p.h], [R - w, b], [0, b]];
	return revolveProfile(prof, p.seg);
}

function buildBowl(p) {
	const R = p.r, t = Math.min(p.wall, R * 0.5), c = Math.min(p.base, R - t - 0.5);
	const ac = Math.asin((c - R) / R), ai = Math.asin((c + t - R) / (R - t));
	const prof = [[0, c], [R * Math.cos(ac), c]];
	for (let i = 1; i <= 24; i++) { const a = ac + (0 - ac) * (i / 24); prof.push([R * Math.cos(a), R + R * Math.sin(a)]); }
	prof.push([R - t, R]);
	for (let i = 1; i <= 24; i++) { const a = 0 + (ai - 0) * (i / 24); prof.push([(R - t) * Math.cos(a), R + (R - t) * Math.sin(a)]); }
	prof.push([0, c + t]);
	return revolveProfile(prof, p.seg);
}

function buildFunnel(p) {
	const rs = p.spout / 2, rt = p.top / 2, w = p.wall;
	return revolveProfile([[rs, 0], [rs + w, 0], [rs + w, p.spoutLength], [rt + w, p.spoutLength + p.coneHeight], [rt, p.spoutLength + p.coneHeight], [rs, p.spoutLength]], p.seg);
}

function buildElbow(p, ctx) {
	const ro = p.od / 2, ri = Math.max(0.1, ro - p.wall), R = Math.max(p.bend, ro + 0.5);
	const outer = revolveProfile(circlePts(ro, 32, R, 0), p.seg, p.angle);
	const inner = revolveProfile(circlePts(ri, 32, R, 0), p.seg, Math.min(360, p.angle + 4));
	inner.rotateZ(-2 * DEG);
	return combine(ctx, [outer], [inner]);
}

// ---------------------------------------------------------------- mechanical

function buildRingGear(p) {
	const { pts, ra } = gearOutline({ module: p.module, teeth: p.teeth, pressure: p.pressure, backlash: -Math.abs(p.clearance || 0) });
	const outerR = ra + 0.25 * p.module + p.rim;
	return extrude(circlePts(outerR, 128), p.thickness, [pts], p);
}

function buildRack(p) {
	const m = p.module, n = Math.max(1, p.teeth | 0), P = Math.PI * m, k = Math.tan(p.pressure * DEG);
	const yr = p.base, yt = yr + 2.25 * m;
	const hp = P / 4 - (p.backlash || 0) / 2;
	const hr = Math.min(hp + 1.25 * m * k, P / 2 - 0.01), ht = Math.max(hp - m * k, 0.05);
	const L = n * P, top = [];
	for (let i = 0; i < n; i++) {
		const c = (i + 0.5) * P;
		top.push([c - hr, yr], [c - ht, yt], [c + ht, yt], [c + hr, yr]);
	}
	const pts = [[0, 0], [L, 0], [L, yr], ...top.reverse(), [0, yr]];
	return extrude(pts, p.thickness, [], p);
}

function buildPulley(p, ctx) {
	const z = Math.max(10, p.teeth | 0);
	const R = (z * 2) / Math.PI / 2 - 0.254, dep = 0.75, hw = 0.6;
	const outline = [];
	const N = z * 24;
	for (let i = 0; i < N; i++) {
		const th = (i / N) * Math.PI * 2;
		let f = (th / ((2 * Math.PI) / z)) % 1;
		const s = R * (f - 0.5) * ((2 * Math.PI) / z);
		const r = R - dep * Math.sqrt(Math.max(0, 1 - (s / hw) ** 2));
		outline.push([r * Math.cos(th), r * Math.sin(th)]);
	}
	const hubH = p.hub ? p.hubHeight : 0, fl = p.flanges ? 1 : 0, bh = p.beltWidth + 1;
	const z0 = hubH + fl;
	const teeth = extrude(outline, bh + 0.02);
	teeth.translate(0, 0, z0 - 0.01);
	const parts = [teeth];
	if (fl) { parts.push(cyl(R + 1.5, fl + 0.01, 96, hubH)); parts.push(cyl(R + 1.5, fl, 96, z0 + bh)); }
	if (hubH) parts.push(cyl(Math.max(p.hubDiameter / 2, p.bore / 2 + 1.5), hubH + 0.01, 64, 0));
	const total = z0 + bh + fl;
	const holes = p.bore > 0 ? [cyl(p.bore / 2, total + 2, 32, -1)] : [];
	return combine(ctx, parts, holes);
}

function dShape(r, flat, n = 48) {
	const x = r - Math.min(flat, r * 0.9);
	const a0 = Math.acos(x / r), pts = [];
	for (let i = 0; i <= n; i++) { const a = a0 + ((2 * Math.PI - 2 * a0) * i) / n; pts.push([r * Math.cos(a), r * Math.sin(a)]); }
	return pts;
}

function buildKnob(p, ctx) {
	const R = p.d / 2, n = Math.max(0, p.ridges | 0), pts = [];
	for (let i = 0; i < 360; i++) {
		const a = (i / 360) * Math.PI * 2;
		pts.push([(R - (n ? p.ridgeDepth * (1 + Math.cos(n * a)) / 2 : 0)) * Math.cos(a), (R - (n ? p.ridgeDepth * (1 + Math.cos(n * a)) / 2 : 0)) * Math.sin(a)]);
	}
	const body = extrude(pts, p.h, [], p);
	if (!(p.shaft > 0)) return body;
	const sd = Math.min(p.shaftDepth, p.h - 0.5);
	const hole = extrude(p.flat > 0 ? dShape(p.shaft / 2, p.flat) : circlePts(p.shaft / 2, 40), sd + 0.5);
	hole.translate(0, 0, -0.5);
	return combine(ctx, [body], [hole]);
}

function buildStandoff(p) {
	const rc = p.af / 2 / Math.cos(Math.PI / 6);
	return extrude(ngon(6, rc, 0), p.length, p.hole > 0 ? [circlePts(p.hole / 2, 32)] : [], p);
}

function buildDShaft(p) {
	return extrude(dShape(p.d / 2, p.flat, 64), p.length, [], p);
}

function buildSplineShaft(p) {
	const n = Math.max(3, p.splines | 0), ro = p.d / 2, ri = ro - Math.min(p.depth, ro * 0.6), pts = [];
	for (let i = 0; i < n; i++) {
		const a = (i / n) * Math.PI * 2, w = Math.PI / n;
		for (const [r, da] of [[ri, -w * 0.5], [ro, -w * 0.45], [ro, w * 0.45], [ri, w * 0.5]]) pts.push([r * Math.cos(a + da), r * Math.sin(a + da)]);
	}
	return extrude(pts, p.length, [], p);
}

function buildCam(p) {
	return extrude(circlePts(p.r, 96), p.thickness, p.bore > 0 ? [circlePts(p.bore / 2, 32, p.ecc, 0)] : [], p);
}

function buildBearingHolder(p, ctx) {
	const ro = p.od / 2 + p.wall, W = p.width + 2, tb = p.base, cz = tb + ro * 0.85;
	const L = Math.max(p.length, 2 * ro + 4 * p.boltHole + 4);
	const base = box(L, W, tb, 0, 0, tb / 2);
	const block = box(2 * ro, W, cz, 0, 0, cz / 2);
	const ring = cyl(ro, W, 96, -W / 2);
	ring.rotateX(Math.PI / 2);
	ring.translate(0, 0, cz);
	const seat = cyl(p.od / 2 + (p.fit || 0), p.width + 1, 96, -W / 2 - 1);
	seat.rotateX(-Math.PI / 2);
	seat.translate(0, 0, cz);
	const through = cyl(p.od / 2 - 1.5, W + 4, 64, -W / 2 - 2);
	through.rotateX(Math.PI / 2);
	through.translate(0, 0, cz);
	const bx = L / 2 - Math.max(p.boltHole * 1.2, (L / 2 - ro) / 2);
	const holes = [seat, through, cyl(p.boltHole / 2, tb + 2, 24, -1).translate(bx, 0, 0), cyl(p.boltHole / 2, tb + 2, 24, -1).translate(-bx, 0, 0)];
	return combine(ctx, [base, block, ring], holes);
}

// ---------------------------------------------------------------- structural / joinery

function buildLBracket(p, ctx) {
	const a = p.legA, b = p.legB, t = Math.min(p.thickness, a - 0.5, b - 0.5), fr = Math.max(0, Math.min(p.fillet, a - t - 0.1, b - t - 0.1));
	const prof = [[0, 0], [a, 0], [a, t]];
	if (fr > 0) prof.push([t + fr, t], ...arcPts(t + fr, t + fr, fr, -Math.PI / 2, -Math.PI, 10));
	else prof.push([t, t]);
	prof.push([t, b], [0, b]);
	const L = extrude(prof, p.width);
	L.rotateX(Math.PI / 2); // profile Y -> Z, extrusion runs along -Y
	const n = Math.max(0, p.holes | 0), holes = [];
	if (n && p.holeD > 0) {
		for (let k = 0; k < n; k++) {
			const y = -p.width * (k + 0.5) / n;
			holes.push(cyl(p.holeD / 2, t + 2, 32, -1).translate(t + (a - t) / 2 + fr / 2, y, 0));
			const h = cyl(p.holeD / 2, t + 2, 32, -1);
			h.rotateY(Math.PI / 2);
			holes.push(h.translate(0, y, t + (b - t) / 2 + fr / 2));
		}
	}
	return holes.length ? combine(ctx, [L], holes) : L;
}

function buildTSlot(p) {
	const edge = [[10, 10], [3.1, 10], [3.1, 8.2], [5.6, 8.2], [5.6, 7.0], [2.8, 4.2], [-2.8, 4.2], [-5.6, 7.0], [-5.6, 8.2], [-3.1, 8.2], [-3.1, 10]];
	const pts = [];
	for (let q = 0; q < 4; q++) {
		const c = Math.cos((q * Math.PI) / 2), s = Math.sin((q * Math.PI) / 2);
		for (const [x, y] of edge) pts.push([x * c - y * s, x * s + y * c]);
	}
	const holes = p.center > 0 ? [circlePts(p.center / 2, 32)] : [];
	const g = extrude(pts, p.length, holes);
	return g;
}

function buildDovetail(p) {
	return extrude([[-p.base / 2, 0], [p.base / 2, 0], [p.top / 2, p.height], [-p.top / 2, p.height]], p.length);
}

function buildSnapHook(p) {
	const L = p.length, t = p.thickness, d = p.hookDepth, hl = Math.min(p.hookLength, L * 0.6);
	return extrude([[0, 0], [L, 0], [L, t], [L - hl * 0.3, t + d], [L - hl, t + d], [L - hl, t], [0, t]], p.width);
}

function buildFilletStrip(p) {
	const r = p.r;
	return extrude([[0, 0], [r, 0], ...arcPts(r, r, r, -Math.PI / 2, -Math.PI, 16)], p.length);
}

function panelHoles(W, D, border, cells) {
	return cells.filter((h) => h.every(([x, y]) => Math.abs(x) <= W / 2 - border && Math.abs(y) <= D / 2 - border));
}

function buildHoneycomb(p) {
	const W = p.w, D = p.d, f = p.cell + p.wall, rc = p.cell / 2 / Math.cos(Math.PI / 6);
	const cells = [];
	const rows = Math.ceil(D / (f * 0.866)) + 2, cols = Math.ceil(W / f) + 2;
	for (let j = -rows; j <= rows; j++) {
		for (let i = -cols; i <= cols; i++) {
			const cx = i * f + (j % 2 ? f / 2 : 0), cy = j * f * 0.866;
			cells.push(ngon(6, rc, Math.PI / 2).map(([x, y]) => [x + cx, y + cy]));
		}
	}
	const holes = panelHoles(W, D, p.border, cells);
	return extrude([[-W / 2, -D / 2], [W / 2, -D / 2], [W / 2, D / 2], [-W / 2, D / 2]], p.h, holes);
}

function buildGridPanel(p) {
	const W = p.w, D = p.d, s = p.spacing, cells = [];
	const nx = Math.floor(W / s) + 1, ny = Math.floor(D / s) + 1;
	for (let j = 0; j < ny; j++) {
		for (let i = 0; i < nx; i++) {
			const cx = (i - (nx - 1) / 2) * s, cy = (j - (ny - 1) / 2) * s, r = p.hole / 2;
			cells.push(p.shape === 'square' ? [[cx - r, cy - r], [cx + r, cy - r], [cx + r, cy + r], [cx - r, cy + r]] : circlePts(r, 24, cx, cy));
		}
	}
	const holes = panelHoles(W, D, p.border, cells);
	return extrude([[-W / 2, -D / 2], [W / 2, -D / 2], [W / 2, D / 2], [-W / 2, D / 2]], p.h, holes);
}

function buildHook(p) {
	const R = p.radius, t = Math.min(p.thickness, R * 0.9), H = Math.max(p.height, R + t), tip = p.tip;
	const pts = [[0, H], [0, R], ...arcPts(R, R, R, Math.PI, Math.PI * 2, 24), [2 * R, R + tip], [2 * R - t, R + tip], [2 * R - t, R], ...arcPts(R, R, R - t, 0, -Math.PI, 24), [t, H]];
	const g = extrude(pts, p.width);
	g.rotateX(Math.PI / 2);
	return g;
}

// ---------------------------------------------------------------- loft & sweep

// 2D profile from simple parameters (CCW).
function profilePts(shape, w, d, sides, r, n = 96) {
	if (shape === 'circle') return circlePts(w / 2, n);
	const pts = shape === 'polygon' ? ngon(Math.max(3, sides | 0), w / 2, Math.PI / 2) : [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]];
	return filletPolygon(pts, Math.max(0, r || 0), 8);
}

// Resample a closed polygon to N points evenly by arc length (CCW), starting where it crosses the +X ray
// from its centroid, so that different profiles line up point-for-point.
function resample(pts, N) {
	let P = pts.slice();
	if (polyArea(P) < 0) P.reverse();
	const c = P.reduce((s, p) => [s[0] + p[0] / P.length, s[1] + p[1] / P.length], [0, 0]);
	for (let k = 0; k < P.length; k++) {
		const a = P[(k - 1 + P.length) % P.length], b = P[k];
		const ya = a[1] - c[1], yb = b[1] - c[1];
		if (ya < 0 && yb >= 0) {
			const t = -ya / (yb - ya), x = a[0] + (b[0] - a[0]) * t;
			if (x > c[0]) { P = [[x, c[1]], ...P.slice(k), ...P.slice(0, k)]; break; }
		}
	}
	const L = [0];
	for (let i = 1; i <= P.length; i++) { const a = P[i - 1], b = P[i % P.length]; L.push(L[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1])); }
	const total = L[L.length - 1], out = [];
	let j = 0;
	for (let k = 0; k < N; k++) {
		const s = (k / N) * total;
		while (j < P.length - 1 && L[j + 1] < s) j++;
		const a = P[j], b = P[(j + 1) % P.length], t = (s - L[j]) / (L[j + 1] - L[j] || 1);
		out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
	}
	return out;
}

// Closed solid from a stack of rings (equal point counts, each CCW about the stacking direction).
function ringsSolid(rings, startNormal, endNormal) {
	const pos = [], tri = (a, b, c) => pos.push(...a, ...b, ...c);
	const n = rings[0].length;
	for (let k = 0; k < rings.length - 1; k++) {
		const A = rings[k], B = rings[k + 1];
		for (let i = 0; i < n; i++) { const j = (i + 1) % n; tri(A[i], A[j], B[j]); tri(A[i], B[j], B[i]); }
	}
	for (const [ring, nrm] of [[rings[0], startNormal], [rings[rings.length - 1], endNormal]]) {
		// Fan from the centroid: loft/sweep profiles here are star-shaped about their center.
		const c = ring.reduce((s, p) => [s[0] + p[0] / n, s[1] + p[1] / n, s[2] + p[2] / n], [0, 0, 0]);
		for (let i = 0; i < n; i++) {
			const a = ring[i], b = ring[(i + 1) % n];
			const cr = [(a[1] - c[1]) * (b[2] - c[2]) - (a[2] - c[2]) * (b[1] - c[1]), (a[2] - c[2]) * (b[0] - c[0]) - (a[0] - c[0]) * (b[2] - c[2]), (a[0] - c[0]) * (b[1] - c[1]) - (a[1] - c[1]) * (b[0] - c[0])];
			if (cr[0] * nrm[0] + cr[1] * nrm[1] + cr[2] * nrm[2] >= 0) tri(c, a, b);
			else tri(c, b, a);
		}
	}
	return fromPositions(pos);
}

function loftRings(bottom, top, h, p, steps) {
	const N = bottom.length, rings = [];
	const cb = bottom.reduce((s, q) => [s[0] + q[0] / N, s[1] + q[1] / N], [0, 0]);
	for (let k = 0; k <= steps; k++) {
		const t = k / steps, a = (p.twist || 0) * DEG * t;
		const ring = [];
		for (let i = 0; i < N; i++) {
			let x = bottom[i][0] + (top[i][0] - bottom[i][0]) * t - cb[0], y = bottom[i][1] + (top[i][1] - bottom[i][1]) * t - cb[1];
			[x, y] = [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
			ring.push([x + cb[0] + (p.offsetX || 0) * t, y + cb[1] + (p.offsetY || 0) * t, h * t]);
		}
		rings.push(ring);
	}
	return rings;
}

function buildLoft(p, ctx) {
	const N = Math.max(24, p.seg | 0);
	const B0 = profilePts(p.bShape, p.bW, p.bD, p.bSides, p.bR), T0 = profilePts(p.tShape, p.tW, p.tD, p.tSides, p.tR);
	const steps = Math.max(8, Math.round(Math.abs(p.twist || 0) / 4), Math.round(Math.hypot(p.offsetX || 0, p.offsetY || 0) / 4));
	const outer = ringsSolid(loftRings(resample(B0, N), resample(T0, N), p.h, p, steps), [0, 0, -1], [0, 0, 1]);
	if (!(p.wall > 0)) return outer;
	const Bi = resample(offsetPolygon(B0, -p.wall), N), Ti = resample(offsetPolygon(T0, -p.wall), N);
	const inner = ringsSolid(loftRings(Bi, Ti, p.h + 0.2, p, steps), [0, 0, -1], [0, 0, 1]);
	inner.translate(0, 0, -0.1);
	return combine(ctx, [outer], [inner]);
}

// Parse "x,y,z; x,y,z; …" (z optional).
function parsePath(str) {
	return String(str || '').split(/[;\n]+/).map((s) => s.split(/[,\s]+/).filter(Boolean).map(Number)).filter((a) => a.length >= 2 && a.every(isFinite))
		.map(([x, y, z = 0]) => new THREE.Vector3(x, y, z));
}

// Polyline with each corner replaced by a smooth bend of radius ~r.
function roundPath(P, r, segs = 10) {
	if (P.length < 3 || !(r > 0)) return P;
	const out = [P[0]];
	for (let i = 1; i < P.length - 1; i++) {
		const a = P[i - 1], b = P[i], c = P[i + 1];
		const u = a.clone().sub(b), w = c.clone().sub(b);
		const lu = u.length(), lw = w.length();
		const ang = u.angleTo(w);
		if (ang > Math.PI - 1e-3 || lu < 1e-6 || lw < 1e-6) { out.push(b); continue; }
		const d = Math.min(r / Math.tan(ang / 2), lu * 0.49, lw * 0.49);
		const s = b.clone().addScaledVector(u.normalize(), d), e = b.clone().addScaledVector(w.normalize(), d);
		for (let k = 0; k <= segs; k++) {
			const t = k / segs, m = 1 - t; // quadratic Bézier through the corner (close to a circular arc)
			out.push(s.clone().multiplyScalar(m * m).addScaledVector(b, 2 * m * t).addScaledVector(e, t * t));
		}
	}
	out.push(P[P.length - 1]);
	return out;
}

// Rings of the profile placed along the path with rotation-minimizing (parallel transport) frames.
function sweepRings(path, prof) {
	const n = path.length;
	const T = path.map((p, i) => path[Math.min(i + 1, n - 1)].clone().sub(path[Math.max(i - 1, 0)]).normalize());
	const up = Math.abs(T[0].z) > 0.95 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
	let N = up.clone().sub(T[0].clone().multiplyScalar(up.dot(T[0]))).normalize();
	const rings = [];
	for (let i = 0; i < n; i++) {
		if (i > 0) N = N.clone().sub(T[i].clone().multiplyScalar(N.dot(T[i]))).normalize();
		const Bv = T[i].clone().cross(N).normalize();
		rings.push(prof.map(([u, v]) => path[i].clone().addScaledVector(N, u).addScaledVector(Bv, v).toArray()));
	}
	return { rings, T };
}

function buildSweep(p, ctx) {
	let P = parsePath(p.path);
	P = P.filter((q, i) => i === 0 || q.distanceTo(P[i - 1]) > 1e-6);
	if (P.length < 2) return null;
	let path;
	if (p.smooth && P.length > 2) {
		const curve = new THREE.CatmullRomCurve3(P, false, 'centripetal');
		path = curve.getSpacedPoints(Math.max(16, Math.round(curve.getLength() / 1.5)));
	} else path = roundPath(P, p.cornerRadius, 12);
	const base = profilePts(p.profile, p.pw, p.ph, p.psides, 0, 48);
	const prof = resample(base, 48);
	const { rings, T } = sweepRings(path, prof);
	const outer = ringsSolid(rings, T[0].clone().negate().toArray(), T[T.length - 1].toArray());
	if (!(p.wall > 0)) return outer;
	const ext = path.slice();
	ext[0] = path[0].clone().addScaledVector(T[0], -0.1);
	ext[ext.length - 1] = path[path.length - 1].clone().addScaledVector(T[T.length - 1], 0.1);
	const r2 = sweepRings(ext, resample(offsetPolygon(base, -p.wall), 48));
	const inner = ringsSolid(r2.rings, r2.T[0].clone().negate().toArray(), r2.T[r2.T.length - 1].toArray());
	return combine(ctx, [outer], [inner]);
}

// ---------------------------------------------------------------- registry

export const ADVANCED = {
	// push / pull of a picked face (outline in the feature's own frame; negative distance cuts in)
	facex: { label: 'Push/pull', color: '#8fa3b8', build: buildFaceExtrude, hidden: true, anchored: true, crease: 30, params: [num('depth', 'Distance (− cuts in)', 5, -10000), num('draft', 'Draft angle °', 0, -60)] },
	// push / pull of a face whose rounded edges move with it (applied to the part built so far; see moveFace)
	facemove: { label: 'Push/pull', color: '#8fa3b8', build: () => null, hidden: true, anchored: true, params: [num('depth', 'Distance (− pushes in)', 5, -10000)] },
	faceoff: { label: 'Push/pull (curved)', color: '#8fa3b8', build: buildFaceOffset, hidden: true, anchored: true, crease: 30, params: [num('depth', 'Distance (− thins)', 1, -10000)] },
	// fillet / chamfer along picked edges (created by the Fillet tool; geometry is in the parent's frame)
	edgeop: { label: 'Edge fillet', color: '#8fa3b8', build: buildEdgeOp, hidden: true, anchored: true, crease: 40, params: [sel('kind', 'Type', 'fillet', ['fillet', 'chamfer']), num('size', 'Size (radius / distance)', 1, 0.05), num('size2', 'End size (0 = same all along)', 0, 0), int('segs', 'Smoothness', 12, 2, 48)] },
	// Hole Wizard hole (origin = top of the hole, on the face; cuts down −Z)
	wizhole: { label: 'Hole (wizard)', color: '#8fa3b8', build: buildWizardHole, defaultHole: true, anchored: true, crease: 40, params: [
		sel('size', 'Size', 'M3', Object.keys(HOLE_SIZES)), sel('type', 'Type', 'clearance', HOLE_TYPES), sel('fit', 'Clearance fit', 'normal', ['close', 'normal', 'loose']),
		num('depth', 'Depth', 10, 0.5), bool('threads', 'Model threads (tapped)', false), num('extra', 'Extra Ø', 0, -1)] },
	// text / sketch wrapped around a cylinder (frame: cylinder axis = Z)
	wrap: { label: 'Wrapped text', color: '#e8613a', build: buildWrap, hidden: true, anchored: true, crease: 35, params: [
		{ key: 'text', label: 'Text', def: 'Text', type: 'text' }, num('size', 'Letter height', 6), { key: 'font', label: 'Font', def: 'bold', type: 'font' },
		sel('mode', 'Style', 'emboss', ['emboss', 'engrave']), num('depth', 'Depth', 0.8, 0.05), num('R', 'Cylinder radius', 10, 0.5),
		num('angle', 'Around (°)', 0, -3600), num('z', 'Height on cylinder', 0, -10000)] },
	// loft & sweep
	loft: { label: 'Loft', color: '#4d96ff', build: buildLoft, crease: 40, params: [
		sel('bShape', 'Bottom shape', 'rectangle', ["circle","rectangle","polygon"]), num('bW', 'Bottom width / Ø', 30), num('bD', 'Bottom depth', 30), int('bSides', 'Bottom sides', 6, 3, 64), num('bR', 'Bottom corner radius', 2, 0),
		sel('tShape', 'Top shape', 'circle', ["circle","rectangle","polygon"]), num('tW', 'Top width / Ø', 20), num('tD', 'Top depth', 20), int('tSides', 'Top sides', 6, 3, 64), num('tR', 'Top corner radius', 0, 0),
		num('h', 'Height', 30), num('offsetX', 'Top offset X', 0, -1000), num('offsetY', 'Top offset Y', 0, -1000), num('twist', 'Twist °', 0, -1080), num('wall', 'Wall (0 = solid)', 0, 0), int('seg', 'Resolution', 96, 24, 512)] },
	sweep: { label: 'Sweep', color: '#ff8fab', build: buildSweep, crease: 40, params: [
		{ key: 'path', label: 'Path (x,y,z; …)', def: '0,0,0; 40,0,0; 40,40,0; 40,40,30', type: 'text' }, bool('smooth', 'Smooth spline', false), num('cornerRadius', 'Corner radius', 10, 0),
		sel('profile', 'Profile', 'circle', ["circle","rectangle","polygon"]), num('pw', 'Profile width / Ø', 8), num('ph', 'Profile height', 8), int('psides', 'Profile sides', 6, 3, 64), num('wall', 'Wall (0 = solid)', 0, 0)] },
	// geometric
	capsule: { label: 'Capsule', color: '#3ec4a6', build: buildCapsule, params: [num('r', 'Radius', 6), num('length', 'Length', 30), int('seg', 'Segments', 48, 8)] },
	ellipsoid: { label: 'Ellipsoid', color: '#5bc0eb', build: buildEllipsoid, params: [num('rx', 'Radius X', 15), num('ry', 'Radius Y', 10), num('rz', 'Radius Z', 7), int('seg', 'Segments', 48, 8)] },
	polyhedron: { label: 'Polyhedron', color: '#9b5de5', build: buildPolyhedron, crease: 10, params: [sel('kind', 'Kind', 'icosahedron', ['tetrahedron', 'octahedron', 'dodecahedron', 'icosahedron']), num('r', 'Radius', 12), int('detail', 'Subdivision (geodesic)', 0, 0, 5), bool('flat', 'Rest on a face', true)] },
	torusknot: { label: 'Torus knot', color: '#f15bb5', build: buildTorusKnot, crease: 60, params: [num('R', 'Radius', 14), num('tube', 'Tube radius', 3.5), int('p', 'Winds (p)', 2, 1, 20), int('q', 'Loops (q)', 3, 1, 20), int('seg', 'Segments', 200, 64, 800)] },
	twisted: { label: 'Twisted prism', color: '#fee440', build: buildTwisted, crease: 40, params: [int('sides', 'Sides', 6, 3, 64), num('r', 'Radius', 12), num('h', 'Height', 30), num('twist', 'Twist °', 90, -1080), num('taper', 'Top scale', 0.7, 0.01), num('fillet', 'Corner radius', 1, 0)] },
	heart: { label: 'Heart', color: '#ef476f', build: buildHeart, params: [num('size', 'Width', 30), num('h', 'Height', 5), ...EDGE] },
	arrow: { label: 'Arrow', color: '#ffd166', build: buildArrow, params: [num('length', 'Length', 40), num('shaft', 'Shaft width', 8), num('head', 'Head width', 20), num('headLength', 'Head length', 14), num('h', 'Height', 4), ...EDGE] },
	cross: { label: 'Cross', color: '#06d6a0', build: buildCross, params: [num('size', 'Size', 30), num('width', 'Arm width', 10), num('h', 'Height', 5), num('fillet', 'Corner radius', 0, 0), ...EDGE] },
	slot: { label: 'Slot', color: '#118ab2', build: buildSlot, params: [num('length', 'Length', 40), num('width', 'Width', 12), num('h', 'Height', 5), ...EDGE] },
	reuleaux: { label: 'Reuleaux', color: '#8ac926', build: buildReuleaux, params: [num('width', 'Width', 30), num('h', 'Height', 5), ...EDGE] },
	// containers
	cup: { label: 'Cup', color: '#4cc9f0', build: buildCup, crease: 40, params: [num('d', 'Outer Ø', 40), num('h', 'Height', 50), num('wall', 'Wall', 2), num('bottom', 'Bottom thickness', 2), num('round', 'Bottom edge radius', 3, 0), int('seg', 'Segments', 96, 8)] },
	bowl: { label: 'Bowl', color: '#f8961e', build: buildBowl, crease: 40, params: [num('r', 'Radius', 30), num('wall', 'Wall', 2), num('base', 'Flat base height', 4, 0.1), int('seg', 'Segments', 96, 8)] },
	funnel: { label: 'Funnel', color: '#90be6d', build: buildFunnel, crease: 40, params: [num('top', 'Top inner Ø', 60), num('spout', 'Spout inner Ø', 8), num('coneHeight', 'Cone height', 35), num('spoutLength', 'Spout length', 25), num('wall', 'Wall', 1.6), int('seg', 'Segments', 96, 8)] },
	elbow: { label: 'Pipe elbow', color: '#adb5bd', build: buildElbow, crease: 40, params: [num('od', 'Outer Ø', 16), num('wall', 'Wall', 2), num('bend', 'Bend radius', 20), num('angle', 'Angle °', 90, 1), int('seg', 'Segments', 64, 8)] },
	// mechanical
	ringgear: { label: 'Ring gear', color: '#8a9aa8', build: buildRingGear, crease: 20, params: [num('module', 'Module', 2, 0.1), int('teeth', 'Teeth', 40, 8, 400), num('thickness', 'Thickness', 6), num('rim', 'Rim thickness', 4), num('pressure', 'Pressure angle °', 20, 10), num('clearance', 'Clearance', 0.15, 0), ...EDGE] },
	rack: { label: 'Gear rack', color: '#8a9aa8', build: buildRack, crease: 20, params: [num('module', 'Module', 2, 0.1), int('teeth', 'Teeth', 10, 1, 500), num('thickness', 'Thickness', 6), num('base', 'Base height', 5), num('pressure', 'Pressure angle °', 20, 10), num('backlash', 'Backlash', 0.1, 0), ...EDGE] },
	pulley: { label: 'GT2 pulley', color: '#6c757d', build: buildPulley, crease: 35, params: [int('teeth', 'Teeth', 20, 10, 200), num('beltWidth', 'Belt width', 6), num('bore', 'Bore Ø', 5, 0), bool('flanges', 'Flanges', true), bool('hub', 'Hub', true), num('hubHeight', 'Hub height', 7), num('hubDiameter', 'Hub Ø', 16)] },
	knob: { label: 'Knob', color: '#ff6b6b', build: buildKnob, crease: 40, params: [num('d', 'Diameter', 30), num('h', 'Height', 16), int('ridges', 'Grip ridges', 18, 0, 120), num('ridgeDepth', 'Ridge depth', 1.2, 0), num('shaft', 'Shaft Ø', 6.2, 0), num('flat', 'D-flat depth', 0.5, 0), num('shaftDepth', 'Shaft depth', 12), num('edge', 'Top/bottom edge', 1.5, 0), sel('edgeType', 'Edge type', 'fillet', ['chamfer', 'fillet'])] },
	standoff: { label: 'Hex standoff', color: '#c9a227', build: buildStandoff, params: [num('af', 'Across flats', 5.5), num('length', 'Length', 10), num('hole', 'Hole Ø', 2.8, 0), ...EDGE] },
	dshaft: { label: 'D-shaft', color: '#b0b8c0', build: buildDShaft, params: [num('d', 'Diameter', 6), num('length', 'Length', 30), num('flat', 'Flat depth', 0.5, 0), ...EDGE] },
	splineshaft: { label: 'Spline shaft', color: '#b0b8c0', build: buildSplineShaft, params: [num('d', 'Outer Ø', 10), num('length', 'Length', 30), int('splines', 'Splines', 6, 3, 60), num('depth', 'Spline depth', 1.5), ...EDGE] },
	cam: { label: 'Cam', color: '#e76f51', build: buildCam, params: [num('r', 'Radius', 15), num('ecc', 'Eccentricity', 5, 0), num('bore', 'Bore Ø', 5, 0), num('thickness', 'Thickness', 6), ...EDGE] },
	bearingholder: { label: 'Bearing holder', color: '#457b9d', build: buildBearingHolder, crease: 40, params: [num('od', 'Bearing OD', 22), num('width', 'Bearing width', 7), num('fit', 'Seat clearance', 0.1, 0), num('wall', 'Wall', 4), num('length', 'Base length', 56), num('base', 'Base thickness', 5), num('boltHole', 'Bolt hole Ø', 4.5)] },
	// structural / joinery
	lbracket: { label: 'L-bracket', color: '#2a9d8f', build: buildLBracket, params: [num('legA', 'Leg A (base)', 30), num('legB', 'Leg B (upright)', 30), num('width', 'Width', 20), num('thickness', 'Thickness', 4), num('fillet', 'Inner fillet', 4, 0), num('holeD', 'Hole Ø', 4.5, 0), int('holes', 'Holes per leg', 1, 0, 10)] },
	tslot: { label: '2020 T-slot', color: '#adb5bd', build: buildTSlot, params: [num('length', 'Length', 50), num('center', 'Center hole Ø', 4.2, 0)] },
	dovetail: { label: 'Dovetail', color: '#bc6c25', build: buildDovetail, params: [num('base', 'Narrow width', 10), num('top', 'Wide width', 16), num('height', 'Height', 6), num('length', 'Length', 30)] },
	snaphook: { label: 'Snap-fit hook', color: '#e9c46a', build: buildSnapHook, params: [num('length', 'Beam length', 20), num('thickness', 'Beam thickness', 1.8), num('width', 'Width', 8), num('hookDepth', 'Hook depth', 1.2), num('hookLength', 'Hook length', 4)] },
	filletstrip: { label: 'Fillet strip', color: '#a8dadc', build: buildFilletStrip, params: [num('r', 'Radius', 4), num('length', 'Length', 40)] },
	honeycomb: { label: 'Honeycomb panel', color: '#f4a261', build: buildHoneycomb, params: [num('w', 'Width X', 80), num('d', 'Depth Y', 60), num('h', 'Thickness', 3), num('cell', 'Cell size', 8), num('wall', 'Wall', 1.6), num('border', 'Border', 4, 0)] },
	gridpanel: { label: 'Grid panel', color: '#e5989b', build: buildGridPanel, params: [num('w', 'Width X', 80), num('d', 'Depth Y', 60), num('h', 'Thickness', 3), sel('shape', 'Holes', 'round', ['round', 'square']), num('hole', 'Hole size', 5), num('spacing', 'Spacing', 10), num('border', 'Border', 4, 0)] },
	hook: { label: 'Wall hook', color: '#6d597a', build: buildHook, params: [num('height', 'Back height', 50), num('radius', 'Hook radius', 12), num('thickness', 'Thickness', 5), num('width', 'Width', 15), num('tip', 'Tip height', 8, 0)] },
};

// Library sections for the Shapes panel (keys are shape types or app presets).
export const LIBRARY_SECTIONS = [
	['Loft & sweep', ['loft', 'loftDuct', 'loftTwist', 'sweep', 'sweepTube', 'sweepHandle']],
	['Geometric', ['capsule', 'ellipsoid', 'polyTetra', 'polyOcta', 'polyDodeca', 'polyIcosa', 'geodesic', 'torusknot', 'twisted', 'heart', 'arrow', 'cross', 'slot', 'reuleaux']],
	['Containers & pipes', ['cup', 'bowl', 'funnel', 'elbow']],
	['Gears & motion', ['gear', 'ringgear', 'rack', 'pulley', 'cam', 'spring']],
	['Hardware', ['thread', 'nut', 'bolt', 'washer', 'standoff', 'dshaft', 'splineshaft', 'knob', 'bearingholder']],
	['Structural & joinery', ['lbracket', 'tslot', 'dovetail', 'snaphook', 'filletstrip', 'honeycomb', 'gridpanel', 'hook']],
];
