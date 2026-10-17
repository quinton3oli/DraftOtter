// Sketch entity model: points, line / arc segments (arcs use a "bulge" = tan(included angle / 4), positive =
// counter-clockwise from a to b), circles, construction flags and constraints. Closed loops of non-construction
// segments plus circles form the profile; loops nested inside others become holes.
import { filletPolygon } from './shapes.js';

// ---------------------------------------------------------------- conversion

// Older sketches were a single closed polygon `pts` with constraints on edge (e) / point (p) indices.
export function toModel(params) {
	if (params && (params.v === 2 || Array.isArray(params.segs) || Array.isArray(params.points))) {
		return {
			points: (params.points || []).map((p) => [+p[0], +p[1]]),
			segs: (params.segs || []).map((s) => ({ ...s })),
			circles: (params.circles || []).map((c) => ({ ...c })),
			cons: JSON.parse(JSON.stringify(params.cons || [])),
			radii: { ...(params.radii || {}) },
		};
	}
	const pts = (params && params.pts) || [];
	const n = pts.length;
	return {
		points: pts.map((p) => [+p[0], +p[1]]),
		segs: pts.map((_, i) => ({ a: i, b: (i + 1) % n })),
		circles: [],
		cons: ((params && params.cons) || []).map((c) => {
			const out = { ...c, s: c.s || c.e || [], p: c.p || [] };
			delete out.e;
			if (c.type === 'angle' && (c.p || []).length && !(c.e || []).length) { out.s = [(c.p[0] - 1 + n) % n, c.p[0]]; out.p = []; }
			return out;
		}),
		radii: { ...((params && params.radii) || {}) },
	};
}

export function modelToParams(m, extra = {}) {
	return {
		...extra, v: 2,
		points: m.points.map(([x, y]) => [round5(x), round5(y)]),
			segs: m.segs.map((s) => {
				const o = { a: s.a, b: s.b };
				if (s.arc) o.arc = round5(s.arc);
				if (s.spl) { o.spl = s.spl.map(([x, y]) => [round5(x), round5(y)]); if (s.sp0) o.sp0 = s.sp0.map(round5); if (s.sp1) o.sp1 = s.sp1.map(round5); }
				if (s.cons) o.cons = true;
				return o;
			}),
		circles: m.circles.map((c) => { const o = { c: c.c, r: round5(c.r) }; if (c.cons) o.cons = true; return o; }),
		cons: m.cons, radii: m.radii,
	};
}

const round5 = (v) => Math.round(v * 1e5) / 1e5;

// ---------------------------------------------------------------- arcs

/** Center, radius, start angle and signed sweep of the arc from A to B with bulge b. */
export function arcInfo(A, B, b) {
	const dx = B[0] - A[0], dy = B[1] - A[1], c = Math.hypot(dx, dy) || 1e-12;
	const theta = 4 * Math.atan(b);
	const R = (c * (1 + b * b)) / (4 * Math.abs(b) || 1e-12);
	const s = (b * c) / 2; // sagitta, positive to the right of A→B
	const nl = [-dy / c, dx / c]; // left normal
	const mid = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
	const k = (R - Math.abs(s)) * Math.sign(b || 1); // center sits opposite the bulge (same side for arcs > 180°)
	const C = [mid[0] + nl[0] * k, mid[1] + nl[1] * k];
	const a0 = Math.atan2(A[1] - C[1], A[0] - C[0]);
	return { C, R, a0, theta };
}

/** Points along a segment from its `a` end (excluding a, including b). */
export function segPoints(A, B, bulge, maxStep = Math.PI / 24) {
	if (!bulge) return [B.slice()];
	const { C, R, a0, theta } = arcInfo(A, B, bulge);
	const n = Math.max(2, Math.ceil(Math.abs(theta) / maxStep));
	const out = [];
	for (let i = 1; i < n; i++) { const a = a0 + (theta * i) / n; out.push([C[0] + R * Math.cos(a), C[1] + R * Math.sin(a)]); }
	out.push(B.slice());
	return out;
}

/**
 * Smooth spline (centripetal Catmull-Rom) from A through the interior points to B. t0 / t1 are optional points
 * beyond each end (they make the curve flow smoothly into a neighbor, e.g. when a closed spline is split in two).
 * Returns the points after A, ending with B.
 */
export function splinePoints(A, B, spl, t0, t1, per = 12) {
	const P = [A, ...spl, B];
	const ext = [t0 || [2 * A[0] - P[1][0], 2 * A[1] - P[1][1]], ...P, t1 || [2 * B[0] - P[P.length - 2][0], 2 * B[1] - P[P.length - 2][1]]];
	const out = [];
	const td = (a, b) => Math.max(1e-6, Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])));
	for (let i = 1; i + 2 < ext.length; i++) {
		const [p0, p1, p2, p3] = [ext[i - 1], ext[i], ext[i + 1], ext[i + 2]];
		const k0 = 0, k1 = k0 + td(p0, p1), k2 = k1 + td(p1, p2), k3 = k2 + td(p2, p3);
		for (let s = 1; s <= per; s++) {
			const t = k1 + ((k2 - k1) * s) / per;
			const L = (a, b, ka, kb) => [((kb - t) * a[0] + (t - ka) * b[0]) / (kb - ka), ((kb - t) * a[1] + (t - ka) * b[1]) / (kb - ka)];
			const A1 = L(p0, p1, k0, k1), A2 = L(p1, p2, k1, k2), A3 = L(p2, p3, k2, k3);
			const B1 = L(A1, A2, k0, k2), B2 = L(A2, A3, k1, k3);
			out.push(s === per ? p2.slice() : L(B1, B2, k1, k2));
		}
	}
	return out;
}

/** Points along segment s after its start vertex, ending at its end vertex (forward or reversed). */
export function segInner(m, s, fwd = true) {
	const A = m.points[fwd ? s.a : s.b], B = m.points[fwd ? s.b : s.a];
	if (s.spl && s.spl.length) return fwd ? splinePoints(A, B, s.spl, s.sp0, s.sp1) : splinePoints(A, B, s.spl.slice().reverse(), s.sp1, s.sp0);
	return segPoints(A, B, s.arc ? (fwd ? s.arc : -s.arc) : 0);
}

export function arcMid(A, B, b) {
	const dx = B[0] - A[0], dy = B[1] - A[1], c = Math.hypot(dx, dy) || 1e-12;
	const s = (b * c) / 2;
	return [(A[0] + B[0]) / 2 + (dy / c) * s, (A[1] + B[1]) / 2 - (dx / c) * s];
}

/** Bulge that makes the arc A→B pass the perpendicular bisector at the projection of P. */
export function bulgeThrough(A, B, P) {
	const dx = B[0] - A[0], dy = B[1] - A[1], c = Math.hypot(dx, dy) || 1e-12;
	const s = ((P[0] - (A[0] + B[0]) / 2) * dy - (P[1] - (A[1] + B[1]) / 2) * dx) / c; // distance to the right
	return Math.max(-50, Math.min(50, (2 * s) / c)); // bulge = 2·sagitta / chord
}

// ---------------------------------------------------------------- profile

const polyArea = (p) => { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[i], r = p[(i + 1) % p.length]; a += q[0] * r[1] - r[0] * q[1]; } return a / 2; };
function inside(pt, poly) {
	let c = false;
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const a = poly[i], b = poly[j];
		if ((a[1] > pt[1]) !== (b[1] > pt[1]) && pt[0] < ((b[0] - a[0]) * (pt[1] - a[1])) / (b[1] - a[1] || 1e-12) + a[0]) c = !c;
	}
	return c;
}

/** Closed loops of the profile. Returns { loops: [{ pts, pids }], open: number of unclosed chains }. */
export function findLoops(m) {
	const live = m.segs.map((s, i) => i).filter((i) => !m.segs[i].cons && m.segs[i].a !== m.segs[i].b && m.points[m.segs[i].a] && m.points[m.segs[i].b]);
	const adj = new Map();
	for (const i of live) for (const v of [m.segs[i].a, m.segs[i].b]) { if (!adj.has(v)) adj.set(v, []); adj.get(v).push(i); }
	const used = new Set(), loops = [];
	let open = 0;
	for (const s0 of live) {
		if (used.has(s0)) continue;
		used.add(s0);
		const start = m.segs[s0].a;
		const steps = [{ s: s0, from: start, to: m.segs[s0].b }];
		let cur = m.segs[s0].b;
		while (cur !== start) {
			const next = (adj.get(cur) || []).find((i) => !used.has(i));
			if (next === undefined) break;
			used.add(next);
			const sg = m.segs[next];
			const to = sg.a === cur ? sg.b : sg.a;
			steps.push({ s: next, from: cur, to });
			cur = to;
		}
		if (cur !== start) { open++; continue; }
		const pts = [], pids = [];
		for (const st of steps) {
			const sg = m.segs[st.s];
			const fwd = st.from === sg.a;
			pts.push(m.points[st.from].slice()); pids.push(st.from);
			const inner = segInner(m, sg, fwd);
			inner.pop();
			for (const q of inner) { pts.push(q); pids.push(-1); }
		}
		loops.push({ pts, pids, steps });
	}
	return { loops, open };
}

/**
 * The curves of a sketch as polylines, longest first: [{ pts: [[x, y]…], closed, length }]. Chains of lines, arcs and
 * splines (open or closed) and circles; construction geometry only when there is nothing else.
 */
export function sketchPaths(params) {
	const m = toModel(params);
	const pick = (cons) => {
		const live = m.segs.map((s, i) => i).filter((i) => !!m.segs[i].cons === cons && m.segs[i].a !== m.segs[i].b && m.points[m.segs[i].a] && m.points[m.segs[i].b]);
		const adj = new Map();
		for (const i of live) for (const v of [m.segs[i].a, m.segs[i].b]) { if (!adj.has(v)) adj.set(v, []); adj.get(v).push(i); }
		const used = new Set(), out = [];
		const walk = (start, s0) => {
			const steps = [];
			let cur = start, si = s0;
			while (si !== undefined && !used.has(si)) {
				used.add(si);
				const sg = m.segs[si], fwd = sg.a === cur, to = fwd ? sg.b : sg.a;
				steps.push({ sg, fwd, from: cur });
				cur = to;
				if (cur === start) break;
				si = (adj.get(cur) || []).find((j) => !used.has(j));
			}
			const pts = [m.points[start].slice()];
			for (const st of steps) pts.push(...segInner(m, st.sg, st.fwd));
			return { pts, closed: cur === start && steps.length > 1 };
		};
		// open chains from their loose ends first, then whatever is left (closed loops)
		for (const [v, list] of adj) if (list.length === 1 && !used.has(list[0])) out.push(walk(v, list[0]));
		for (const i of live) if (!used.has(i)) out.push(walk(m.segs[i].a, i));
		for (const c of m.circles) if (!!c.cons === cons && m.points[c.c]) {
			const [cx, cy] = m.points[c.c], n = Math.max(24, Math.ceil(c.r * 2));
			out.push({ pts: Array.from({ length: n + 1 }, (_, k) => [cx + c.r * Math.cos((2 * Math.PI * k) / n), cy + c.r * Math.sin((2 * Math.PI * k) / n)]), closed: true });
		}
		return out;
	};
	let paths = pick(false);
	if (!paths.length) paths = pick(true);
	for (const p of paths) {
		if (p.closed && (p.pts[0][0] !== p.pts[p.pts.length - 1][0] || p.pts[0][1] !== p.pts[p.pts.length - 1][1])) p.pts.push(p.pts[0].slice());
		p.length = 0;
		for (let i = 1; i < p.pts.length; i++) p.length += Math.hypot(p.pts[i][0] - p.pts[i - 1][0], p.pts[i][1] - p.pts[i - 1][1]);
	}
	return paths.filter((p) => p.length > 1e-6).sort((a, b) => b.length - a.length);
}

/**
 * Regions to extrude: [{ outer, holes }]. Line–line corners at original points are rounded by the per-point
 * radius (radii[pid]) or the global `fillet`.
 */
export function profileRegions(params) {
	const m = toModel(params);
	const fillet = (params && params.fillet) || 0;
	const { loops } = findLoops(m);
	const polys = [];
	for (const lp of loops) {
		// corner radii only where both neighboring segments are lines
		const radii = {};
		lp.pids.forEach((pid, i) => {
			if (pid < 0) return;
			const prevStep = lp.steps[(lp.steps.findIndex((s) => s.from === pid) - 1 + lp.steps.length) % lp.steps.length];
			const nextStep = lp.steps.find((s) => s.from === pid);
			const lineLine = prevStep && nextStep && !m.segs[prevStep.s].arc && !m.segs[nextStep.s].arc;
			const r = m.radii[pid] != null ? m.radii[pid] : fillet;
			if (lineLine && r > 0) radii[i] = r;
		});
		polys.push(Object.keys(radii).length ? filletPolygon(lp.pts, 0, 8, radii) : lp.pts);
	}
	for (const c of m.circles) {
		if (c.cons || !m.points[c.c] || !(c.r > 0)) continue;
		const [cx, cy] = m.points[c.c], n = Math.max(32, Math.min(128, Math.round(c.r * 6)));
		polys.push(Array.from({ length: n }, (_, i) => [cx + c.r * Math.cos((2 * Math.PI * i) / n), cy + c.r * Math.sin((2 * Math.PI * i) / n)]));
	}
	const items = polys.filter((p) => p.length >= 3).map((pts) => ({ pts, area: Math.abs(polyArea(pts)) })).sort((a, b) => b.area - a.area);
	for (let i = 0; i < items.length; i++) {
		let parent = -1;
		for (let j = 0; j < i; j++) if (inside(items[i].pts[0], items[j].pts)) parent = j; // smallest container wins (sorted)
		items[i].parent = parent;
		items[i].depth = parent < 0 ? 0 : items[parent].depth + 1;
	}
	return items.map((it, i) => (it.depth % 2 === 0 ? { outer: it.pts, holes: items.filter((h) => h.parent === i && h.depth % 2 === 1).map((h) => h.pts) } : null)).filter(Boolean);
}

/** Make a model from plain polygons (outer + holes), e.g. for shell cavities. */
export function modelFromRegions(regions) {
	const m = { points: [], segs: [], circles: [], cons: [], radii: {} };
	for (const r of regions) {
		for (const loop of [r.outer, ...(r.holes || [])]) {
			const base = m.points.length;
			loop.forEach((p, i) => { m.points.push([p[0], p[1]]); m.segs.push({ a: base + i, b: base + ((i + 1) % loop.length) }); });
		}
	}
	return m;
}

/** Scale a sketch model in place (arcs and circles keep their shape only for uniform scale). */
export function scaleModel(m, sx, sy) {
	m.points = m.points.map(([x, y]) => [x * sx, y * sy]);
	for (const s of m.segs) { if (s.spl) s.spl = s.spl.map(([x, y]) => [x * sx, y * sy]); if (s.sp0) s.sp0 = [s.sp0[0] * sx, s.sp0[1] * sy]; if (s.sp1) s.sp1 = [s.sp1[0] * sx, s.sp1[1] * sy]; }
	const k = Math.sqrt(Math.abs(sx * sy));
	for (const c of m.circles) c.r *= k;
	for (const c of m.cons) {
		if (c.type === 'len' || c.type === 'radius' || c.type === 'dia') c.value *= k;
		if (c.type === 'px') c.value *= sx;
		if (c.type === 'py') c.value *= sy;
		if (c.type === 'fix') { c.x *= sx; c.y *= sy; }
	}
	for (const key in m.radii) m.radii[key] *= k;
	return m;
}
