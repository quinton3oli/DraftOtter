// Parametric shape library. Every builder returns a BufferGeometry in a Z-up frame,
// centered on its bounding box, with only position + normal attributes.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { TextGeometry } from 'three/examples/jsm/geometries/TextGeometry.js';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { getFont } from './fontlib.js';
import { DEG, base64ToF32 } from './util.js';
import { unpackIndexed, soupOf } from './sculpt.js';
import { ADVANCED } from './advanced.js';
import { profileRegions } from './sketchModel.js';

const EPS = 1e-9;

// ---------------------------------------------------------------- helpers

export function signedVolume(g) {
	const p = g.attributes.position.array;
	const idx = g.index ? g.index.array : null;
	const n = idx ? idx.length : p.length / 3;
	let v = 0;
	for (let i = 0; i < n; i += 3) {
		const a = (idx ? idx[i] : i) * 3, b = (idx ? idx[i + 1] : i + 1) * 3, c = (idx ? idx[i + 2] : i + 2) * 3;
		v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
			- p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c])
			+ p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
	}
	return v / 6;
}

// Swap the 2nd and 3rd vertex of every triangle of a non-indexed geometry.
export function flipWinding(g) {
	for (const name in g.attributes) {
		const attr = g.attributes[name];
		const a = attr.array, s = attr.itemSize;
		for (let i = 0; i < attr.count; i += 3) {
			for (let k = 0; k < s; k++) {
				const t = a[(i + 1) * s + k];
				a[(i + 1) * s + k] = a[(i + 2) * s + k];
				a[(i + 2) * s + k] = t;
			}
		}
		attr.needsUpdate = true;
	}
	if (g.attributes.normal) {
		const n = g.attributes.normal.array;
		for (let i = 0; i < n.length; i++) n[i] = -n[i];
	}
	return g;
}

export function fromPositions(arr) {
	const g = new THREE.BufferGeometry();
	g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
	return g;
}

// Normalize any geometry into our canonical form.
export function finalize(g, crease = 30, center = true) {
	if (g.index) g = g.toNonIndexed();
	for (const k of Object.keys(g.attributes)) if (k !== 'position') g.deleteAttribute(k);
	g.clearGroups();
	if (signedVolume(g) < 0) flipWinding(g);
	g = toCreasedNormals(g, crease * DEG);
	if (center) {
		g.computeBoundingBox();
		const c = g.boundingBox.getCenter(new THREE.Vector3());
		g.translate(-c.x, -c.y, -c.z);
	}
	g.computeBoundingBox();
	g.computeBoundingSphere();
	return g;
}

export function dedupe(pts, eps = 1e-7) {
	const out = [];
	for (const p of pts) {
		const q = out[out.length - 1];
		if (!q || Math.abs(q[0] - p[0]) > eps || Math.abs(q[1] - p[1]) > eps) out.push(p);
	}
	while (out.length > 2) {
		const a = out[0], b = out[out.length - 1];
		if (Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps) out.pop();
		else break;
	}
	return out;
}

export function polyArea(pts) {
	let a = 0;
	for (let i = 0; i < pts.length; i++) {
		const p = pts[i], q = pts[(i + 1) % pts.length];
		a += p[0] * q[1] - q[0] * p[1];
	}
	return a / 2;
}

// Revolve a closed [r, z] profile around the Z axis.
export function revolveProfile(profile, segments = 64, angleDeg = 360) {
	let pts = dedupe(profile.map(([r, z]) => [Math.max(0, r), z]));
	if (pts.length < 3) return null;
	if (polyArea(pts) < 0) pts = pts.reverse();
	const full = angleDeg >= 359.999;
	const total = Math.min(angleDeg, 360) * DEG;
	const n = full ? segments : Math.max(2, Math.round(segments * angleDeg / 360));
	const pos = [];
	const cs = [], sn = [];
	for (let j = 0; j <= n; j++) {
		const t = full && j === n ? 0 : total * j / n;
		cs.push(Math.cos(t)); sn.push(Math.sin(t));
	}
	const P = (p, j) => [p[0] * cs[j], p[0] * sn[j], p[1]];
	const tri = (a, b, c) => pos.push(...a, ...b, ...c);
	const N = pts.length;
	for (let i = 0; i < N; i++) {
		const p = pts[i], q = pts[(i + 1) % N];
		if (p[0] < EPS && q[0] < EPS) continue;
		for (let j = 0; j < n; j++) {
			const A = P(p, j), B = P(q, j), C = P(q, j + 1), D = P(p, j + 1);
			if (p[0] > EPS) tri(A, D, C);
			if (q[0] > EPS) tri(A, C, B);
		}
	}
	if (!full) {
		const contour = pts.map(([r, z]) => new THREE.Vector2(r, z));
		const faces = THREE.ShapeUtils.triangulateShape(contour, []);
		for (const [t, out] of [[0, [0, -1, 0]], [n, [-Math.sin(total), Math.cos(total), 0]]]) {
			for (const f of faces) {
				const a = P(pts[f[0]], t), b = P(pts[f[1]], t), c = P(pts[f[2]], t);
				const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
				const nrm = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
				if (nrm[0] * out[0] + nrm[1] * out[1] + nrm[2] * out[2] >= 0) tri(a, b, c);
				else tri(a, c, b);
			}
		}
	}
	return fromPositions(pos);
}

// Points of an arc, excluding the start point.
export function arcPts(cx, cy, r, a0, a1, n) {
	const out = [];
	for (let i = 1; i <= n; i++) {
		const a = a0 + (a1 - a0) * i / n;
		out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
	}
	return out;
}

// Round every corner of a closed polygon with radius r.
export function filletPolygon(pts, rAll, segs = 8, radii = null) {
	const hasPer = radii && Object.keys(radii).length;
	if (!(rAll > 0) && !hasPer) return pts.slice();
	if (pts.length < 3) return pts.slice();
	const out = [];
	const N = pts.length;
	for (let i = 0; i < N; i++) {
		const p = pts[i], a = pts[(i - 1 + N) % N], b = pts[(i + 1) % N];
		const r = hasPer && radii[i] != null ? radii[i] : rAll;
		if (!(r > 0)) { out.push(p); continue; }
		const v1 = [a[0] - p[0], a[1] - p[1]], v2 = [b[0] - p[0], b[1] - p[1]];
		const l1 = Math.hypot(...v1), l2 = Math.hypot(...v2);
		if (l1 < EPS || l2 < EPS) { out.push(p); continue; }
		v1[0] /= l1; v1[1] /= l1; v2[0] /= l2; v2[1] /= l2;
		const cos = Math.max(-1, Math.min(1, v1[0] * v2[0] + v1[1] * v2[1]));
		const th = Math.acos(cos);
		if (th < 1e-3 || Math.PI - th < 1e-3) { out.push(p); continue; }
		let t = r / Math.tan(th / 2);
		const tMax = Math.min(l1, l2) * 0.499;
		let rr = r;
		if (t > tMax) { t = tMax; rr = t * Math.tan(th / 2); }
		const s = [p[0] + v1[0] * t, p[1] + v1[1] * t];
		const e = [p[0] + v2[0] * t, p[1] + v2[1] * t];
		const bis = [v1[0] + v2[0], v1[1] + v2[1]];
		const bl = Math.hypot(...bis);
		const d = rr / Math.sin(th / 2);
		const c = [p[0] + bis[0] / bl * d, p[1] + bis[1] / bl * d];
		const a0 = Math.atan2(s[1] - c[1], s[0] - c[0]);
		let a1 = Math.atan2(e[1] - c[1], e[0] - c[0]);
		let da = a1 - a0;
		while (da > Math.PI) da -= 2 * Math.PI;
		while (da < -Math.PI) da += 2 * Math.PI;
		out.push(s, ...arcPts(c[0], c[1], rr, a0, a0 + da, segs));
	}
	return out;
}

function edgeSize(p, depth) {
	return Math.max(0, Math.min((p && p.edge) || 0, depth / 2 - 0.01));
}

// Extrude closed polygons (with holes) to height h, optionally chamfering / filleting the top and bottom edges.
// Built as stacked offset rings so the result is always a closed, manifold solid (three's bevel breaks on holes).
export function bevelExtrude(polys, h, p = {}, steps = 1) {
	// Thin features (tooth tips, letter strokes) can fold over when inset; shrink the edge until the solid is closed.
	// Done per outline (e.g. per letter) so one difficult glyph doesn't shrink the edge on all the others.
	const parts = [];
	for (const poly of polys) {
		let e = edgeSize(p, h), g = null;
		for (let i = 0; i < 6 && e > 1e-3; i++, e *= 0.6) {
			const t = bevelLayers([poly], h, p, steps, e);
			if (openEdges(t.attributes.position.array) === 0) { g = t; break; }
		}
		parts.push(g || bevelLayers([poly], h, p, steps, 0));
	}
	const total = parts.reduce((n, g) => n + g.attributes.position.array.length, 0);
	const pos = new Float32Array(total);
	let o = 0;
	for (const g of parts) { pos.set(g.attributes.position.array, o); o += g.attributes.position.array.length; }
	const out = new THREE.BufferGeometry();
	out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
	return out;
}

// Number of unmatched directed edges in a triangle soup (0 = closed and consistently oriented).
function openEdges(P) {
	const key = (i) => Math.round(P[i * 3] * 1e4) + ',' + Math.round(P[i * 3 + 1] * 1e4) + ',' + Math.round(P[i * 3 + 2] * 1e4);
	const E = new Map();
	for (let t = 0; t < P.length / 9; t++) {
		for (let k = 0; k < 3; k++) {
			const a = key(t * 3 + k), b = key(t * 3 + ((k + 1) % 3));
			if (a === b) continue;
			const f = a + '|' + b, r = b + '|' + a;
			if (E.get(r) > 0) E.set(r, E.get(r) - 1);
			else E.set(f, (E.get(f) || 0) + 1);
		}
	}
	let n = 0;
	for (const c of E.values()) n += c;
	return n;
}

function bevelLayers(polys, h, p, steps, e) {
	const segs = e > 1e-4 ? (p.edgeType === 'fillet' ? 6 : 1) : 0;
	const bottom = [];
	if (!segs) bottom.push([0, 0]);
	for (let i = 0; i <= segs && segs; i++) {
		const t = (i / segs) * Math.PI / 2;
		bottom.push(p.edgeType === 'fillet' ? [e - e * Math.cos(t), e - e * Math.sin(t)] : [i ? e : 0, i ? 0 : e]);
	}
	const layers = [...bottom];
	const zA = bottom[bottom.length - 1][0], zB = h - zA;
	for (let k = 1; k < steps; k++) layers.push([zA + ((zB - zA) * k) / steps, 0]);
	for (let i = bottom.length - 1; i >= 0; i--) layers.push([h - bottom[i][0], bottom[i][1]]);
	return layeredExtrude(polys, layers);
}

// Closed solid through stacked offset rings: layers = [[z, inset], …] (inset > 0 shrinks outlines, grows holes).
export function layeredExtrude(polys, layers) {
	const pos = [];
	const tri = (a, b, c) => pos.push(...a, ...b, ...c);
	for (const poly of polys) {
		let outer = dedupe(poly.outer);
		if (outer.length < 3) continue;
		if (polyArea(outer) < 0) outer = outer.reverse();
		const holes = (poly.holes || []).map((hp) => { let q = dedupe(hp); if (polyArea(q) > 0) q = q.reverse(); return q; }).filter((q) => q.length >= 3);
		const ringsAt = ([z, ins]) => [offsetPolygon(outer, -ins), ...holes.map((q) => offsetPolygon(q, ins))].map((r) => r.map(([x, y]) => [x, y, z]));
		const L = layers.map(ringsAt);
		for (let k = 0; k < L.length - 1; k++) {
			for (let r = 0; r < L[k].length; r++) {
				const A = L[k][r], B = L[k + 1][r], n = A.length;
				for (let i = 0; i < n; i++) {
					const j = (i + 1) % n;
					tri(A[i], A[j], B[j]);
					tri(A[i], B[j], B[i]);
				}
			}
		}
		for (const [rings, up] of [[L[0], false], [L[L.length - 1], true]]) {
			const flat = rings.flat();
			const faces = THREE.ShapeUtils.triangulateShape(rings[0].map(([x, y]) => new THREE.Vector2(x, y)), rings.slice(1).map((r) => r.map(([x, y]) => new THREE.Vector2(x, y))));
			if (!faces.length) continue;
			const [f0] = faces;
			const pa = flat[f0[0]], pb = flat[f0[1]], pc = flat[f0[2]];
			const nz = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0]);
			const flip = up ? nz < 0 : nz > 0;
			for (const f of faces) flip ? tri(flat[f[0]], flat[f[2]], flat[f[1]]) : tri(flat[f[0]], flat[f[1]], flat[f[2]]);
		}
	}
	return fromPositions(pos);
}

export function extrudePts(pts, depth, holes = [], curveSegments = 12, p) {
	// outer counter-clockwise, holes clockwise: three.js only repairs hole winding when it flips the outer loop
	if (polyArea(pts) < 0) pts = pts.slice().reverse();
	holes = holes.map((h) => (polyArea(h) > 0 ? h.slice().reverse() : h));
	if (edgeSize(p, depth) > 1e-4) return bevelExtrude([{ outer: pts, holes }], depth, p);
	const shape = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
	for (const h of holes) shape.holes.push(new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x, y))));
	return new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments });
}

const toPts = (v2s) => v2s.map((v) => [v.x, v.y]);

// Offset a simple polygon by d (negative = inwards), with mitred corners.
export function offsetPolygon(pts, d) {
	if (pts.length < 3) return pts.slice();
	const ccw = polyArea(pts) > 0;
	const sgn = ccw ? 1 : -1; // inward normal is to the left of edges on a CCW polygon
	const n = pts.length, out = [];
	const lines = [];
	for (let i = 0; i < n; i++) {
		const a = pts[i], b = pts[(i + 1) % n];
		const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
		const nx = (-dy / l) * sgn, ny = (dx / l) * sgn; // inward normal
		lines.push({ p: [a[0] - nx * d, a[1] - ny * d], v: [dx / l, dy / l] });
	}
	for (let i = 0; i < n; i++) {
		const L1 = lines[(i - 1 + n) % n], L2 = lines[i];
		const cr = L1.v[0] * L2.v[1] - L1.v[1] * L2.v[0];
		if (Math.abs(cr) < 1e-9) { out.push(L2.p.slice()); continue; }
		const t = ((L2.p[0] - L1.p[0]) * L2.v[1] - (L2.p[1] - L1.p[1]) * L2.v[0]) / cr;
		out.push([L1.p[0] + L1.v[0] * t, L1.p[1] + L1.v[1] * t]);
	}
	return out;
}

function circlePath(r, ccw = true) {
	const p = new THREE.Path();
	p.absarc(0, 0, r, 0, Math.PI * 2, ccw);
	return p;
}

// ---------------------------------------------------------------- builders

function buildBox(p) {
	const r = Math.min(p.radius || 0, Math.min(p.w, p.d, p.h) / 2 - 1e-4);
	if (r > 1e-4) return new RoundedBoxGeometry(p.w, p.d, p.h, p.edgeType === 'chamfer' ? 1 : Math.max(1, p.seg | 0), r);
	return new THREE.BoxGeometry(p.w, p.d, p.h);
}

function cornerProfile(r, h, bottom, top, type) {
	// Outer profile of a cylinder with optional chamfer/fillet on the bottom and top edges.
	bottom = Math.max(0, Math.min(bottom, r - 1e-3, h / 2 - 1e-3));
	top = Math.max(0, Math.min(top, r - 1e-3, h / 2 - 1e-3));
	const pts = [[0, 0]];
	if (bottom > 0) {
		pts.push([r - bottom, 0]);
		if (type === 'fillet') pts.push(...arcPts(r - bottom, bottom, bottom, -Math.PI / 2, 0, 10));
		else pts.push([r, bottom]);
	} else pts.push([r, 0]);
	if (top > 0) {
		pts.push([r, h - top]);
		if (type === 'fillet') pts.push(...arcPts(r - top, h - top, top, 0, Math.PI / 2, 10));
		else pts.push([r - top, h]);
	} else pts.push([r, h]);
	pts.push([0, h]);
	return pts;
}

function buildCylinder(p) {
	return revolveProfile(cornerProfile(p.r, p.h, p.bottomEdge || 0, p.topEdge || 0, p.edgeType), p.seg, 360);
}

function buildTube(p) {
	const ri = Math.min(p.ri, p.ro - 0.01);
	return revolveProfile([[ri, 0], [p.ro, 0], [p.ro, p.h], [ri, p.h]], p.seg, p.angle ?? 360);
}

function buildCone(p) {
	return revolveProfile([[0, 0], [p.r1, 0], [p.r2, p.h], [0, p.h]], p.seg, 360);
}

function buildSphere(p) {
	const n = Math.max(4, p.seg | 0);
	const prof = [];
	const half = Math.max(2, Math.round(n / 2));
	for (let i = 0; i <= half; i++) {
		const a = -Math.PI / 2 + Math.PI * i / half;
		prof.push([p.r * Math.cos(a), p.r * Math.sin(a)]);
	}
	const g = revolveProfile(prof, n, 360);
	return g;
}

function buildHemisphere(p) {
	const n = Math.max(4, p.seg | 0);
	const quarter = Math.max(2, Math.round(n / 4));
	const prof = [[0, 0]];
	for (let i = 0; i <= quarter; i++) {
		const a = Math.PI / 2 * i / quarter;
		prof.push([p.r * Math.cos(a), p.r * Math.sin(a)]);
	}
	return revolveProfile(prof, n, 360);
}

function buildTorus(p) {
	const r = Math.min(p.r, p.R - 0.01);
	const prof = [];
	const n = Math.max(6, p.seg2 | 0);
	for (let i = 0; i < n; i++) {
		const a = Math.PI * 2 * i / n;
		prof.push([p.R + r * Math.cos(a), r * Math.sin(a)]);
	}
	return revolveProfile(prof, p.seg, p.angle ?? 360);
}

function buildWedge(p) {
	const g = extrudePts([[-p.w / 2, -p.h / 2], [p.w / 2, -p.h / 2], [-p.w / 2, p.h / 2]], p.d);
	g.rotateX(Math.PI / 2);
	return g;
}

function buildPyramid(p) {
	const w = p.w / 2, d = p.d / 2, h = p.h;
	const a = [-w, -d, 0], b = [w, -d, 0], c = [w, d, 0], e = [-w, d, 0], t = [0, 0, h];
	return fromPositions([...a, ...c, ...b, ...a, ...e, ...c, ...a, ...b, ...t, ...b, ...c, ...t, ...c, ...e, ...t, ...e, ...a, ...t]);
}

function buildPrism(p) {
	const n = Math.max(3, p.sides | 0);
	let r = p.r;
	if (p.sizeBy === 'flats') r = p.r / Math.cos(Math.PI / n);
	const pts = [];
	const off = n % 2 === 0 ? Math.PI / n : Math.PI / 2;
	for (let i = 0; i < n; i++) {
		const a = off + Math.PI * 2 * i / n;
		pts.push([r * Math.cos(a), r * Math.sin(a)]);
	}
	return extrudePts(filletPolygon(pts, p.fillet || 0), p.h, [], 12, p);
}

function buildStar(p) {
	const n = Math.max(3, p.points | 0);
	const pts = [];
	for (let i = 0; i < n * 2; i++) {
		const a = Math.PI / 2 + Math.PI * i / n;
		const r = i % 2 ? p.ri : p.ro;
		pts.push([r * Math.cos(a), r * Math.sin(a)]);
	}
	return extrudePts(pts, p.h, [], 12, p);
}

function buildText(p, ctx) {
	const text = String(p.text ?? '').trim() ? String(p.text) : '?';
	const shapes = getFont(p.font).generateShapes(text, p.size);
	let polys = shapes.map((sh) => { const ex = sh.extractPoints(Math.max(1, p.seg | 0)); return { outer: toPts(ex.shape), holes: ex.holes.map(toPts) }; });
	// many fonts draw letters from overlapping strokes: merge them so the text is one clean solid
	const clean = ctx && ctx.clean2d ? ctx.clean2d(polys.flatMap((q) => [q.outer, ...q.holes])) : null;
	if (clean && clean.length) polys = clean;
	if (edgeSize(p, p.depth) > 1e-4) return bevelExtrude(polys, p.depth, p);
	const solid = ctx && ctx.extrude2d ? ctx.extrude2d(polys.flatMap((q) => [q.outer, ...q.holes]), p.depth) : null;
	if (solid) return solid;
	const g = new TextGeometry(text, {
		font: getFont(p.font),
		size: p.size,
		depth: p.depth,
		curveSegments: Math.max(1, p.seg | 0),
		bevelEnabled: false,
	});
	return g;
}

// Involute gear outline (2D points, CCW) plus the root radius.
export function gearOutline(p) {
	const m = p.module, z = Math.max(5, p.teeth | 0), pa = p.pressure * DEG;
	const rp = m * z / 2, rb = rp * Math.cos(pa), ra = rp + m, rf = Math.max(rp - 1.25 * m, 0.2);
	const invA = Math.tan(pa) - pa;
	const half = Math.PI / (2 * z) - (p.backlash || 0) / (2 * rp);
	const rs = Math.max(rb, rf);
	const inv = (R) => { const t = Math.sqrt(Math.max((R / rb) ** 2 - 1, 0)); return t - Math.atan(t); };
	const NF = 8;
	const pts = [];
	const polar = (R, a) => [R * Math.cos(a), R * Math.sin(a)];
	for (let k = 0; k < z; k++) {
		const th = Math.PI * 2 * k / z;
		const A = [], B = [];
		for (let i = 0; i <= NF; i++) {
			const R = rs + (ra - rs) * i / NF;
			A.push([R, th - half - invA + inv(R)]);
			B.push([R, th + half + invA - inv(R)]);
		}
		// Avoid pointed / crossing tips on small gears.
		while (A.length > 2 && A[A.length - 1][1] > B[B.length - 1][1]) { A.pop(); B.pop(); }
		if (rf < rs - 1e-6) pts.push(polar(rf, A[0][1]));
		for (const [R, a] of A) pts.push(polar(R, a));
		for (let i = B.length - 1; i >= 0; i--) pts.push(polar(B[i][0], B[i][1]));
		if (rf < rs - 1e-6) pts.push(polar(rf, B[0][1]));
		// root arc to the next tooth
		const a0 = B[0][1], a1 = th + Math.PI * 2 / z - half - invA + inv(rs);
		for (let i = 1; i < 4; i++) pts.push(polar(rf, a0 + (a1 - a0) * i / 4));
	}
	return { pts, rf, rp, ra };
}

// Involute spur / helical gear.
function buildGear(p) {
	const m = p.module;
	const { pts, rf, rp } = gearOutline(p);
	const holes = [];
	if (p.bore > 0 && p.bore / 2 < rf - 0.2) holes.push(circlePath(p.bore / 2, true));
	const steps = Math.abs(p.helix) > 0.01 ? Math.max(4, Math.round(p.thickness / m * 4)) : 1;
	const shape = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
	shape.holes.push(...holes);
	const g = edgeSize(p, p.thickness) > 1e-4
		? bevelExtrude([{ outer: pts, holes: holes.length ? [toPts(holes[0].getPoints(48))] : [] }], p.thickness, p, steps)
		: new THREE.ExtrudeGeometry(shape, { depth: p.thickness, bevelEnabled: false, steps, curveSegments: 32 });
	if (Math.abs(p.helix) > 0.01) {
		const pos = g.attributes.position;
		const k = Math.tan(p.helix * DEG) / rp;
		for (let i = 0; i < pos.count; i++) {
			const x = pos.getX(i), y = pos.getY(i), zz = pos.getZ(i);
			const a = k * (p.herringbone && zz > p.thickness / 2 ? p.thickness - zz : zz);
			const c = Math.cos(a), s = Math.sin(a);
			pos.setXY(i, x * c - y * s, x * s + y * c);
		}
	}
	return g;
}

// ISO metric style thread, generated as a radius-function surface (watertight).
function buildThread(p) {
	const R = p.d / 2 + (p.clearance || 0);
	const pitch = Math.max(0.2, p.pitch);
	const depth = 0.6134 * pitch;
	const rMin = Math.max(0.1, R - depth);
	const L = p.length;
	const seg = Math.max(12, p.seg | 0);
	const rows = Math.max(4, Math.ceil(L / pitch * 16));
	const hand = p.leftHand ? -1 : 1;
	const prof = (u) => {
		if (u < 0.125) return 1;
		if (u < 0.4375) return 1 - (u - 0.125) / 0.3125;
		if (u < 0.6875) return 0;
		return (u - 0.6875) / 0.3125;
	};
	const ch = p.chamfer ? depth : 0;
	const verts = [];
	for (let j = 0; j <= rows; j++) {
		const zz = L * j / rows;
		for (let i = 0; i < seg; i++) {
			const th = Math.PI * 2 * i / seg;
			let u = zz / pitch - hand * th / (Math.PI * 2);
			u -= Math.floor(u);
			let r = rMin + (R - rMin) * prof(u);
			if (ch > 0) r = Math.min(r, rMin + Math.min(zz, L - zz) + 0.0);
			verts.push([r * Math.cos(th), r * Math.sin(th), zz]);
		}
	}
	const pos = [];
	const V = (j, i) => verts[j * seg + (i % seg)];
	for (let j = 0; j < rows; j++) {
		for (let i = 0; i < seg; i++) {
			const a = V(j, i), b = V(j, i + 1), c = V(j + 1, i + 1), d = V(j + 1, i);
			pos.push(...a, ...b, ...c, ...a, ...c, ...d);
		}
	}
	const bc = [0, 0, 0], tc = [0, 0, L];
	for (let i = 0; i < seg; i++) {
		pos.push(...bc, ...V(0, i + 1), ...V(0, i));
		pos.push(...tc, ...V(rows, i), ...V(rows, i + 1));
	}
	return fromPositions(pos);
}

function buildSpring(p) {
	// Helical coil with circular wire section, closed with end caps.
	const turns = Math.max(0.25, p.turns), R = p.R, r = Math.min(p.wire / 2, R * 0.95);
	const pitch = Math.max(p.pitch, r * 2 + 0.05);
	const along = Math.max(8, Math.round(turns * (p.seg | 0)));
	const around = 12;
	const rings = [];
	for (let j = 0; j <= along; j++) {
		const t = turns * Math.PI * 2 * j / along;
		const c = [R * Math.cos(t), R * Math.sin(t), pitch * t / (Math.PI * 2)];
		const nrm = [Math.cos(t), Math.sin(t), 0];
		const tan = new THREE.Vector3(-R * Math.sin(t), R * Math.cos(t), pitch / (Math.PI * 2)).normalize();
		const bin = new THREE.Vector3().crossVectors(tan, new THREE.Vector3(...nrm)).normalize();
		const ring = [];
		for (let i = 0; i < around; i++) {
			const a = Math.PI * 2 * i / around;
			ring.push([
				c[0] + r * (Math.cos(a) * nrm[0] + Math.sin(a) * bin.x),
				c[1] + r * (Math.cos(a) * nrm[1] + Math.sin(a) * bin.y),
				c[2] + r * (Math.cos(a) * nrm[2] + Math.sin(a) * bin.z),
			]);
		}
		rings.push({ ring, c });
	}
	const pos = [];
	for (let j = 0; j < along; j++) {
		const A = rings[j].ring, B = rings[j + 1].ring;
		for (let i = 0; i < around; i++) {
			const i1 = (i + 1) % around;
			pos.push(...A[i], ...B[i], ...B[i1], ...A[i], ...B[i1], ...A[i1]);
		}
	}
	const s = rings[0], e = rings[along];
	for (let i = 0; i < around; i++) {
		const i1 = (i + 1) % around;
		pos.push(...s.c, ...s.ring[i], ...s.ring[i1]);
		pos.push(...e.c, ...e.ring[i1], ...e.ring[i]);
	}
	return fromPositions(pos);
}

// Sketch profile (lines, arcs, circles; nested loops become holes; separate loops separate solids).
function buildSketch(p, ctx) {
	const regions = profileRegions(p);
	if (!regions.length) return null;
	const parts = [];
	for (const r of regions) {
		if (p.mode === 'revolve') {
			// the revolve axis is the vertical line x = axisX of the sketch; the solid stays where the profile was drawn
			const ax = +p.axisX || 0, shift = (lp) => (ax ? lp.map(([x, y]) => [x - ax, y]) : lp);
			const solid = revolveProfile(shift(r.outer), p.seg || 64, p.angle ?? 360);
			if (!solid) continue;
			const holes = r.holes.map((h) => revolveProfile(shift(h), p.seg || 64, Math.min(360, (p.angle ?? 360) + (p.angle >= 359.999 ? 0 : 2)))).filter(Boolean);
			if (holes.length && p.angle < 359.999) holes.forEach((h) => h.rotateZ(-DEG));
			const g = holes.length && ctx && ctx.csg ? ctx.csg([solid], holes) : solid;
			if (g && ax) g.translate(ax, 0, 0);
			parts.push(g);
		} else parts.push(extrudePts(r.outer, p.height, r.holes, 12, p));
	}
	if (parts.length === 1) return parts[0];
	// separate regions are disjoint solids: merge their triangles
	const flat = parts.filter(Boolean).map((g) => (g.index ? g.toNonIndexed() : g));
	const total = flat.reduce((n, g) => n + g.attributes.position.array.length, 0);
	const pos = new Float32Array(total);
	let o = 0;
	for (const g of flat) { pos.set(g.attributes.position.array, o); o += g.attributes.position.array.length; }
	return fromPositions(pos);
}

// Typical metric screw dimensions (mm): clearance hole, socket-head counterbore Ø/depth,
// countersink head Ø (90°), heat-set insert hole Ø/depth, hex nut across-flats/thickness.
export const SCREWS = {
	M2: { d: 2.4, cb: 4.4, cbh: 2.2, csk: 4.4, ins: 3.2, insh: 4.0, nut: 4.0, nuth: 1.6 },
	'M2.5': { d: 2.9, cb: 5.5, cbh: 2.7, csk: 5.5, ins: 3.6, insh: 4.5, nut: 5.0, nuth: 2.0 },
	M3: { d: 3.4, cb: 6.5, cbh: 3.2, csk: 6.7, ins: 4.0, insh: 5.0, nut: 5.5, nuth: 2.4 },
	M4: { d: 4.5, cb: 8.0, cbh: 4.2, csk: 9.0, ins: 5.6, insh: 6.0, nut: 7.0, nuth: 3.2 },
	M5: { d: 5.5, cb: 10.0, cbh: 5.2, csk: 11.2, ins: 6.4, insh: 7.0, nut: 8.0, nuth: 4.0 },
	M6: { d: 6.6, cb: 11.5, cbh: 6.2, csk: 13.4, ins: 8.0, insh: 9.0, nut: 10.0, nuth: 5.0 },
	M8: { d: 9.0, cb: 15.0, cbh: 8.2, csk: 17.9, ins: 9.6, insh: 10.0, nut: 13.0, nuth: 6.5 },
};

// Screw hole cut from the top face down (top of the shape = surface of the part).
function buildScrewHole(p, ctx) {
	const S = SCREWS[p.size] || SCREWS.M3;
	const c = p.clearance || 0;
	const D = Math.max(0.5, p.depth);
	const rs = (S.d + c) / 2;
	const seg = 48;
	let prof;
	switch (p.style) {
		case 'countersunk': {
			const rh = (S.csk + c) / 2, hh = Math.min(rh - rs, D - 0.2);
			prof = [[0, 0], [rs, 0], [rs, D - hh], [rs + hh, D], [0, D]];
			break;
		}
		case 'counterbore': {
			const rh = (S.cb + c) / 2, hh = Math.min(S.cbh + 0.2, D - 0.2);
			prof = [[0, 0], [rs, 0], [rs, D - hh], [rh, D - hh], [rh, D], [0, D]];
			break;
		}
		case 'insert': {
			const ri = (S.ins + c) / 2, ih = Math.min(S.insh + 0.5, D), fl = Math.min(0.5, ih / 3);
			prof = ih >= D - 1e-6
				? [[0, 0], [ri, 0], [ri, D - fl], [ri + fl, D], [0, D]]
				: [[0, 0], [rs, 0], [rs, D - ih], [ri, D - ih], [ri, D - fl], [ri + fl, D], [0, D]];
			break;
		}
		case 'nuttrap': {
			const af = S.nut + 0.3 + c, nh = Math.min(S.nuth + 0.3, D - 0.2);
			const R = af / 2 / Math.cos(Math.PI / 6);
			const hex = [];
			for (let i = 0; i < 6; i++) hex.push([R * Math.cos((Math.PI / 3) * i), R * Math.sin((Math.PI / 3) * i)]);
			const pocket = extrudePts(hex, nh);
			pocket.translate(0, 0, D - nh);
			const shaft = revolveProfile([[0, 0], [rs, 0], [rs, D - nh / 2], [0, D - nh / 2]], seg);
			if (ctx && ctx.union) return ctx.union([shaft, pocket]);
			return null;
		}
		default:
			prof = [[0, 0], [rs, 0], [rs, D], [0, D]];
	}
	return revolveProfile(prof, seg);
}

function buildMesh(p, ctx) {
	const data = ctx && ctx.getBlob ? ctx.getBlob(p.blob) : null;
	if (!data) return null;
	// sculpted parts are stored indexed (sculpt.js), imported meshes as a list of triangles
	if (data.startsWith('IDX1:')) { const m = unpackIndexed(data); return fromPositions(soupOf(m.positions, m.index)); }
	return fromPositions(base64ToF32(data));
}

// ---------------------------------------------------------------- registry

const num = (key, label, def, min = 0.01, step) => ({ key, label, def, min, step, type: 'num' });
const int = (key, label, def, min = 3, max = 512) => ({ key, label, def, min, max, type: 'int' });
const sel = (key, label, def, options) => ({ key, label, def, options, type: 'select' });
const bool = (key, label, def) => ({ key, label, def, type: 'bool' });

export const SHAPES = {
	box: { label: 'Box', color: '#e8613a', build: buildBox, params: [num('w', 'Width X', 20), num('d', 'Depth Y', 20), num('h', 'Height Z', 20), num('radius', 'Edge size', 0, 0), sel('edgeType', 'Edge type', 'fillet', ['fillet', 'chamfer']), int('seg', 'Round segments', 4, 1, 16)] },
	cylinder: { label: 'Cylinder', color: '#f2a03d', build: buildCylinder, params: [num('r', 'Radius', 10), num('h', 'Height', 20), int('seg', 'Segments', 64), sel('edgeType', 'Edge type', 'chamfer', ['chamfer', 'fillet']), num('topEdge', 'Top edge', 0, 0), num('bottomEdge', 'Bottom edge', 0, 0)] },
	tube: { label: 'Tube', color: '#3aa0e8', build: buildTube, params: [num('ro', 'Outer radius', 10), num('ri', 'Inner radius', 7), num('h', 'Height', 20), int('seg', 'Segments', 64), num('angle', 'Sweep angle °', 360, 1)] },
	cone: { label: 'Cone', color: '#9b59d0', build: buildCone, params: [num('r1', 'Bottom radius', 10, 0), num('r2', 'Top radius', 0, 0), num('h', 'Height', 20), int('seg', 'Segments', 64)] },
	sphere: { label: 'Sphere', color: '#3ec46d', build: buildSphere, params: [num('r', 'Radius', 10), int('seg', 'Segments', 48, 6)] },
	hemisphere: { label: 'Dome', color: '#2fbfa8', build: buildHemisphere, params: [num('r', 'Radius', 10), int('seg', 'Segments', 48, 6)] },
	torus: { label: 'Torus', color: '#e84a8a', build: buildTorus, params: [num('R', 'Ring radius', 12), num('r', 'Tube radius', 3), int('seg', 'Ring segments', 64), int('seg2', 'Tube segments', 24), num('angle', 'Sweep angle °', 360, 1)] },
	wedge: { label: 'Wedge', color: '#5a6ee8', build: buildWedge, params: [num('w', 'Width X', 20), num('d', 'Depth Y', 20), num('h', 'Height Z', 20)] },
	pyramid: { label: 'Pyramid', color: '#d8c13a', build: buildPyramid, params: [num('w', 'Width X', 20), num('d', 'Depth Y', 20), num('h', 'Height Z', 20)] },
	prism: { label: 'Polygon', color: '#6c8a9e', build: buildPrism, params: [int('sides', 'Sides', 6, 3, 128), num('r', 'Size', 10), sel('sizeBy', 'Size is', 'corners', ['corners', 'flats']), num('h', 'Height', 10), num('fillet', 'Corner radius', 0, 0), num('edge', 'Top/bottom edge', 0, 0), sel('edgeType', 'Edge type', 'chamfer', ['chamfer', 'fillet'])] },
	star: { label: 'Star', color: '#f2c94c', build: buildStar, params: [int('points', 'Points', 5, 3, 64), num('ro', 'Outer radius', 12), num('ri', 'Inner radius', 5), num('h', 'Height', 5), num('edge', 'Top/bottom edge', 0, 0), sel('edgeType', 'Edge type', 'chamfer', ['chamfer', 'fillet'])] },
	text: { label: 'Text', color: '#e8613a', build: buildText, crease: 35, params: [{ key: 'text', label: 'Text', def: 'Text', type: 'text' }, num('size', 'Size', 10), num('depth', 'Depth', 3), { key: 'font', label: 'Font', def: 'bold', type: 'font' }, int('seg', 'Curve quality', 6, 1, 32), num('edge', 'Top/bottom edge', 0, 0), sel('edgeType', 'Edge type', 'chamfer', ['chamfer', 'fillet'])] },
	gear: { label: 'Gear', color: '#8a9aa8', build: buildGear, crease: 20, params: [num('module', 'Module', 2, 0.1), int('teeth', 'Teeth', 20, 5, 300), num('thickness', 'Thickness', 6), num('bore', 'Bore Ø', 5, 0), num('pressure', 'Pressure angle °', 20, 10), num('helix', 'Helix angle °', 0, -45), bool('herringbone', 'Herringbone', false), num('backlash', 'Backlash', 0.1, 0), num('edge', 'Top/bottom edge', 0, 0), sel('edgeType', 'Edge type', 'chamfer', ['chamfer', 'fillet'])] },
	thread: { label: 'Thread', color: '#b0b8c0', build: buildThread, crease: 50, params: [num('d', 'Major Ø', 8, 0.5), num('pitch', 'Pitch', 1.25, 0.2), num('length', 'Length', 16), num('clearance', 'Radial clearance', 0, -2), int('seg', 'Segments', 48, 12, 256), bool('chamfer', 'Chamfer ends', true), bool('leftHand', 'Left-hand', false)] },
	spring: { label: 'Spring', color: '#c0c8d0', build: buildSpring, crease: 50, params: [num('R', 'Coil radius', 8), num('wire', 'Wire Ø', 2), num('pitch', 'Pitch', 5), num('turns', 'Turns', 5, 0.25), int('seg', 'Segments/turn', 48, 8, 256)] },
	sketch: { label: 'Sketch', color: '#3aa0e8', build: buildSketch, hidden: true, params: [sel('mode', 'Mode', 'extrude', ['extrude', 'revolve']), num('height', 'Extrude height', 10), num('angle', 'Revolve angle °', 360, 1), num('axisX', 'Revolve axis at X', 0, -1e6), num('fillet', 'Corner radius', 0, 0), int('seg', 'Revolve segments', 64), num('edge', 'Top/bottom edge', 0, 0), sel('edgeType', 'Edge type', 'chamfer', ['chamfer', 'fillet'])] },
	screwhole: { label: 'Screw hole', color: '#8fa3b8', build: buildScrewHole, defaultHole: true, crease: 40, params: [sel('size', 'Screw size', 'M3', Object.keys(SCREWS)), sel('style', 'Style', 'plain', ['plain', 'countersunk', 'counterbore', 'insert', 'nuttrap']), num('depth', 'Depth', 10, 0.5), num('clearance', 'Extra clearance Ø', 0, -1)] },
	mesh: { label: 'Imported mesh', color: '#9aa4b0', build: buildMesh, hidden: true, crease: 30, params: [] },
};

Object.assign(SHAPES, ADVANCED);

export function defaultParams(type) {
	const o = {};
	for (const p of SHAPES[type].params) o[p.key] = p.def;
	if (type === 'sketch') o.pts = [[-10, -10], [10, -10], [10, 10], [-10, 10]];
	return o;
}

/**
 * Parameters as the shape builders expect them: whole numbers where a count is meant (segments, sides, teeth),
 * within each parameter's limits, and a usable number everywhere (values can arrive from expressions, files or
 * scripts, e.g. a segment count of 68.56 or NaN, which would otherwise make invalid geometry).
 */
export function cleanParams(type, params) {
	const def = SHAPES[type];
	const p = { ...defaultParams(type), ...params };
	for (const d of def.params) {
		if (d.type !== 'num' && d.type !== 'int') continue;
		let v = p[d.key];
		if (typeof v === 'string' && v.trim() !== '' && isFinite(+v)) v = +v;
		if (typeof v !== 'number' || !Number.isFinite(v)) v = d.def;
		if (d.type === 'int') v = Math.round(v);
		if (d.min !== undefined && v < d.min) v = d.min;
		if (d.max !== undefined && v > d.max) v = d.max;
		p[d.key] = v;
	}
	return p;
}

/** Shading crease (degrees) for sculpted parts: smooth up to this bend. */
export const SCULPT_CREASE = 80;
export const isSculptedBlob = (ctx, blob) => { const d = ctx && ctx.getBlob ? ctx.getBlob(blob) : null; return typeof d === 'string' && d.startsWith('IDX1:'); };

export function buildShape(type, params, ctx) {
	const def = SHAPES[type];
	if (!def) return null;
	const p = cleanParams(type, params);
	let g;
	try {
		g = def.build(p, ctx);
	} catch (e) {
		console.error('Shape build failed', type, e);
		g = null;
	}
	if (!g || !g.attributes.position || g.attributes.position.count === 0) return null;
	// Imported meshes and "anchored" sketches keep their own origin; everything else is centered on its bounds.
	// sculpted surfaces (stored indexed, see sculpt.js) are organic: shade them smooth except at truly sharp edges,
	// or every small fold a brush leaves shows up as a hard crease
	const crease = type === 'mesh' && isSculptedBlob(ctx, p.blob) ? SCULPT_CREASE : def.crease ?? 30;
	return finalize(g, crease, type !== 'mesh' && !def.anchored && !(type === 'sketch' && p.anchored));
}
