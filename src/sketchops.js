// Sketch editing operations on the entity model { points, segs, circles, cons, radii }: trim, extend, offset,
// slots and conversion of reference edges. Pure functions (they mutate the model passed in), so they can be tested.
import { arcInfo, segPoints } from './sketchModel.js';

const EPS = 1e-7;
const TAU = Math.PI * 2;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const norm = (a) => { const l = Math.hypot(a[0], a[1]) || 1; return [a[0] / l, a[1] / l]; };
const wrap01 = (u) => ((u % 1) + 1) % 1;

// ------------------------------------------------------------------ geometry of an entity

/** { kind: 'line', A, B } | { kind: 'arc', C, R, a0, theta } | { kind: 'circle', C, R } | null (splines) */
export function entity(m, ref) {
	if (ref.kind === 'circle') { const c = m.circles[ref.i]; return { kind: 'circle', C: m.points[c.c], R: c.r }; }
	const s = m.segs[ref.i], A = m.points[s.a], B = m.points[s.b];
	if (s.spl) return null;
	if (s.arc) { const { C, R, a0, theta } = arcInfo(A, B, s.arc); return { kind: 'arc', C, R, a0, theta, A, B }; }
	return { kind: 'line', A, B };
}

/** Parameter of point P on an entity: line / arc 0..1 from start to end (may fall outside), circle 0..1 by angle. */
export function paramOf(e, P) {
	if (e.kind === 'line') { const d = sub(e.B, e.A), L2 = d[0] * d[0] + d[1] * d[1] || 1e-18; return ((P[0] - e.A[0]) * d[0] + (P[1] - e.A[1]) * d[1]) / L2; }
	const ang = Math.atan2(P[1] - e.C[1], P[0] - e.C[0]);
	if (e.kind === 'circle') return wrap01(ang / TAU);
	let d = ang - e.a0;
	if (e.theta > 0) { while (d < -1e-9) d += TAU; while (d > TAU) d -= TAU; } else { while (d > 1e-9) d -= TAU; while (d < -TAU) d += TAU; }
	return d / e.theta;
}

export function pointAt(e, t) {
	if (e.kind === 'line') return [e.A[0] + (e.B[0] - e.A[0]) * t, e.A[1] + (e.B[1] - e.A[1]) * t];
	const a = e.kind === 'circle' ? t * TAU : e.a0 + e.theta * t;
	return [e.C[0] + e.R * Math.cos(a), e.C[1] + e.R * Math.sin(a)];
}

/** Intersections of two entities treated as infinite lines / full circles: [[x, y], …]. */
function rawIntersect(e, f) {
	const lineLine = (P, d, Q, g) => {
		const den = d[0] * g[1] - d[1] * g[0];
		if (Math.abs(den) < 1e-12) return [];
		const t = ((Q[0] - P[0]) * g[1] - (Q[1] - P[1]) * g[0]) / den;
		return [[P[0] + d[0] * t, P[1] + d[1] * t]];
	};
	const lineCircle = (P, d, C, R) => {
		const f2 = sub(P, C), a = d[0] * d[0] + d[1] * d[1], b = 2 * (f2[0] * d[0] + f2[1] * d[1]), c = f2[0] * f2[0] + f2[1] * f2[1] - R * R;
		let disc = b * b - 4 * a * c;
		if (disc < -1e-9 * Math.max(1, R * R)) return [];
		disc = Math.max(0, disc);
		const s = Math.sqrt(disc);
		const ts = s < 1e-12 ? [-b / (2 * a)] : [(-b - s) / (2 * a), (-b + s) / (2 * a)];
		return ts.map((t) => [P[0] + d[0] * t, P[1] + d[1] * t]);
	};
	const circleCircle = (C1, R1, C2, R2) => {
		const d = dist(C1, C2);
		if (d < 1e-12 || d > R1 + R2 + 1e-9 || d < Math.abs(R1 - R2) - 1e-9) return [];
		const a = (R1 * R1 - R2 * R2 + d * d) / (2 * d), h = Math.sqrt(Math.max(0, R1 * R1 - a * a));
		const u = [(C2[0] - C1[0]) / d, (C2[1] - C1[1]) / d], M = [C1[0] + u[0] * a, C1[1] + u[1] * a];
		return h < 1e-12 ? [M] : [[M[0] - u[1] * h, M[1] + u[0] * h], [M[0] + u[1] * h, M[1] - u[0] * h]];
	};
	const L = (x) => x.kind === 'line';
	if (L(e) && L(f)) return lineLine(e.A, sub(e.B, e.A), f.A, sub(f.B, f.A));
	if (L(e)) return lineCircle(e.A, sub(e.B, e.A), f.C, f.R);
	if (L(f)) return lineCircle(f.A, sub(f.B, f.A), e.C, e.R);
	return circleCircle(e.C, e.R, f.C, f.R);
}

const onEntity = (e, t) => (e.kind === 'circle' ? true : t > -1e-6 && t < 1 + 1e-6);

/** Real intersections of entity e with every other entity: [{ P, t (on e), ref, tf }]. */
export function intersections(m, ref) {
	const e = entity(m, ref);
	if (!e) return [];
	const out = [];
	const others = [...m.segs.map((_, i) => ({ kind: 'seg', i })), ...m.circles.map((_, i) => ({ kind: 'circle', i }))];
	for (const r of others) {
		if (r.kind === ref.kind && r.i === ref.i) continue;
		const f = entity(m, r);
		if (!f) continue;
		for (const P of rawIntersect(e, f)) {
			const t = paramOf(e, P), tf = paramOf(f, P);
			if (onEntity(e, t) && onEntity(f, tf)) out.push({ P, t, ref: r, tf });
		}
	}
	return out;
}

// ------------------------------------------------------------------ topology helpers

function findPoint(m, P, tol = 1e-6) {
	const i = m.points.findIndex((q) => dist(q, P) < tol);
	return i >= 0 ? i : m.points.push([P[0], P[1]]) - 1;
}

/** Bulge of the part of segment s between params t0 and t1. */
function subBulge(m, s, t0, t1) {
	if (!s.arc) return 0;
	const { theta } = arcInfo(m.points[s.a], m.points[s.b], s.arc);
	return Math.tan((theta * (t1 - t0)) / 4);
}

/** Split any segment (other than `skip`) whose interior passes through P, joining it at point pid. */
function attachPoint(m, P, pid, skip = new Set()) {
	const n = m.segs.length;
	for (let i = 0; i < n; i++) {
		if (skip.has(i)) continue;
		const s = m.segs[i];
		if (s.a === pid || s.b === pid) continue;
		const e = entity(m, { kind: 'seg', i });
		if (!e) continue;
		const t = paramOf(e, P);
		if (!(t > 1e-6 && t < 1 - 1e-6) || dist(pointAt(e, t), P) > 1e-5) continue;
		const b1 = subBulge(m, s, 0, t), b2 = subBulge(m, s, t, 1);
		const ns = { a: pid, b: s.b };
		if (b2) ns.arc = b2;
		if (s.cons) ns.cons = true;
		s.b = pid;
		if (s.arc) s.arc = b1;
		m.segs.push(ns);
		dupOrientation(m, i, m.segs.length - 1);
	}
}

/** h / v constraints of a split segment hold for both halves; whole-segment dimensions are dropped. */
function dupOrientation(m, si, nsi) {
	const extra = [];
	m.cons = m.cons.filter((c) => {
		if (!(c.s || []).includes(si)) return true;
		if ((c.type === 'h' || c.type === 'v') && c.s.length === 1) { extra.push({ ...c, s: [nsi] }); return true; }
		return c.type === 'radius' && c.s.length === 1;
	});
	m.cons.push(...extra);
}

/** Make everything that used point `from` use point `to` instead (from is then unused). */
function mergePoint(m, from, to) {
	for (const s of m.segs) { if (s.a === from) s.a = to; if (s.b === from) s.b = to; }
	for (const c of m.circles) if (c.c === from) c.c = to;
	for (const c of m.cons) if (c.p) c.p = c.p.map((p) => (p === from ? to : p));
	if (m.radii && m.radii[from] != null) { if (m.radii[to] == null) m.radii[to] = m.radii[from]; delete m.radii[from]; }
}

/** Remove segments / circles (and points nothing uses any more), remapping every index. */
export function compact(m, { segs = [], circles = [] } = {}) {
	const S = new Set(segs), C = new Set(circles);
	const used = new Set();
	m.segs.forEach((s, i) => { if (!S.has(i)) used.add(s.a).add(s.b); });
	m.circles.forEach((c, i) => { if (!C.has(i)) used.add(c.c); });
	for (const c of m.cons) for (const p of c.p || []) used.add(p);
	const pMap = [], sMap = [], cMap = [];
	let k = 0; m.points.forEach((_, i) => { pMap[i] = used.has(i) ? k++ : -1; });
	k = 0; m.segs.forEach((_, i) => { sMap[i] = S.has(i) ? -1 : k++; });
	k = 0; m.circles.forEach((_, i) => { cMap[i] = C.has(i) ? -1 : k++; });
	m.points = m.points.filter((_, i) => pMap[i] >= 0);
	m.segs = m.segs.filter((_, i) => sMap[i] >= 0).map((s) => ({ ...s, a: pMap[s.a], b: pMap[s.b] }));
	m.circles = m.circles.filter((_, i) => cMap[i] >= 0).map((c) => ({ ...c, c: pMap[c.c] }));
	m.cons = m.cons.filter((c) => (c.p || []).every((i) => pMap[i] >= 0) && (c.s || []).every((i) => sMap[i] >= 0) && (c.c || []).every((i) => cMap[i] >= 0))
		.map((c) => ({ ...c, p: (c.p || []).map((i) => pMap[i]), s: (c.s || []).map((i) => sMap[i]), c: (c.c || []).map((i) => cMap[i]) }));
	const r = {};
	for (const key in m.radii || {}) if (pMap[key] >= 0) r[pMap[key]] = m.radii[key];
	m.radii = r;
	return m;
}

/** Circles that were crossed at points: replace each by arcs between those points (CCW). */
function circlesToArcs(m, splits) {
	const gone = [];
	for (const [ci, pids] of splits) {
		const c = m.circles[ci], C = m.points[c.c];
		let list = [...new Set(pids)].map((pid) => ({ pid, u: wrap01(Math.atan2(m.points[pid][1] - C[1], m.points[pid][0] - C[0]) / TAU) })).sort((a, b) => a.u - b.u);
		if (list.length === 1) {
			const u = wrap01(list[0].u + 0.5), P = [C[0] + c.r * Math.cos(u * TAU), C[1] + c.r * Math.sin(u * TAU)];
			list.push({ pid: findPoint(m, P), u });
			list.sort((a, b) => a.u - b.u);
		}
		for (let k = 0; k < list.length; k++) {
			const a = list[k], b = list[(k + 1) % list.length];
			const sweep = wrap01(b.u - a.u) * TAU || TAU;
			const s = { a: a.pid, b: b.pid, arc: Math.tan(sweep / 4) };
			if (c.cons) s.cons = true;
			m.segs.push(s);
		}
		gone.push(ci);
	}
	return gone;
}

// ------------------------------------------------------------------ trim

/**
 * Trim the piece of an entity around point Q, between its nearest crossings with other geometry.
 * Crossing entities are split there so the remaining outline stays connected. Returns a message on failure.
 */
export function trim(m, ref, Q) {
	const e = entity(m, ref);
	if (!e) return 'Splines cannot be trimmed';
	const xs = intersections(m, ref);
	const tq = paramOf(e, Q);
	if (ref.kind === 'circle') {
		const us = [...new Set(xs.map((x) => +wrap01(x.t).toFixed(9)))].sort((a, b) => a - b);
		if (us.length < 2) return 'A circle needs two crossings to trim between';
		let ia = us.length - 1;
		for (let k = 0; k < us.length; k++) if (us[k] < tq) ia = k;
		const ua = us[ia], ub = us[(ia + 1) % us.length];
		const pa = findPoint(m, pointAt(e, ua)), pb = findPoint(m, pointAt(e, ub));
		const splits = joinCutters(m, xs, [ua, ub], [pa, pb], ref, true);
		// keep the arc from ub around to ua (the clicked piece is between ua and ub)
		const sweep = wrap01(ua - ub) * TAU;
		const s = { a: pb, b: pa, arc: Math.tan(sweep / 4) };
		if (m.circles[ref.i].cons) s.cons = true;
		m.segs.push(s);
		const gone = circlesToArcs(m, splits);
		compact(m, { circles: [ref.i, ...gone] });
		return null;
	}
	const ts = xs.map((x) => x.t).filter((t) => t > 1e-6 && t < 1 - 1e-6);
	let ta = 0, tb = 1;
	for (const t of ts) { if (t < tq && t > ta) ta = t; if (t > tq && t < tb) tb = t; }
	const s = m.segs[ref.i];
	if (ta === 0 && tb === 1) { compact(m, { segs: [ref.i] }); return null; }
	const pa = ta > 0 ? findPoint(m, pointAt(e, ta)) : null, pb = tb < 1 ? findPoint(m, pointAt(e, tb)) : null;
	const splits = joinCutters(m, xs, [ta, tb], [pa, pb], ref, false);
	const B = s.b, bA = subBulge(m, s, 0, ta), bB = subBulge(m, s, tb, 1);
	if (ta > 0 && tb < 1) {
		const ns = { a: pb, b: B };
		if (bB) ns.arc = bB;
		if (s.cons) ns.cons = true;
		s.b = pa;
		if (s.arc) s.arc = bA;
		m.segs.push(ns);
		dupOrientation(m, ref.i, m.segs.length - 1);
		m.cons = m.cons.filter((c) => !(c.s || []).includes(ref.i) || c.type === 'h' || c.type === 'v');
	} else if (ta > 0) {
		s.b = pa;
		if (s.arc) s.arc = bA;
		m.cons = m.cons.filter((c) => !(c.s || []).includes(ref.i) || c.type === 'h' || c.type === 'v');
	} else {
		s.a = pb;
		if (s.arc) s.arc = bB;
		m.cons = m.cons.filter((c) => !(c.s || []).includes(ref.i) || c.type === 'h' || c.type === 'v');
	}
	const gone = circlesToArcs(m, splits);
	compact(m, { circles: gone });
	return null;
}

/** Split the entities crossing at params ts (points pids) so they share those points; returns circle splits. */
function joinCutters(m, xs, ts, pids, ref, circ) {
	const splits = new Map();
	ts.forEach((t, k) => {
		const pid = pids[k];
		if (pid === null || pid === undefined) return;
		for (const x of xs) {
			const same = circ ? Math.abs(wrap01(x.t) - wrap01(t)) < 1e-6 : Math.abs(x.t - t) < 1e-6;
			if (!same) continue;
			if (x.ref.kind === 'circle') { if (!splits.has(x.ref.i)) splits.set(x.ref.i, []); splits.get(x.ref.i).push(pid); }
		}
		attachPoint(m, m.points[pid], pid, new Set(ref.kind === 'seg' ? [ref.i] : []));
	});
	return splits;
}

// ------------------------------------------------------------------ extend

/** Extend a line's free end (the one nearest Q) to the next entity it would hit. Returns a message on failure. */
export function extend(m, si, Q) {
	const s = m.segs[si];
	if (s.arc || s.spl) return 'Only straight lines can be extended';
	const endB = dist(m.points[s.b], Q) < dist(m.points[s.a], Q);
	const pid = endB ? s.b : s.a, other = endB ? s.a : s.b;
	if (m.segs.filter((g) => g.a === pid || g.b === pid).length > 1) return 'That end is already connected';
	const P = m.points[pid], O = m.points[other], d = norm(sub(P, O));
	const ray = { kind: 'line', A: P, B: [P[0] + d[0], P[1] + d[1]] };
	let best = null;
	const others = [...m.segs.map((_, i) => ({ kind: 'seg', i })), ...m.circles.map((_, i) => ({ kind: 'circle', i }))];
	for (const r of others) {
		if (r.kind === 'seg' && r.i === si) continue;
		const f = entity(m, r);
		if (!f) continue;
		for (const X of rawIntersect(ray, f)) {
			const t = paramOf(ray, X);
			if (t > 1e-6 && onEntity(f, paramOf(f, X)) && (!best || t < best.t)) best = { t, X, r };
		}
	}
	if (!best) return 'Nothing to extend to';
	m.points[pid] = [best.X[0], best.X[1]];
	// landing exactly on an existing point (e.g. a corner): merge into it so the outline connects
	const existing = m.points.findIndex((q, i) => i !== pid && dist(q, best.X) < 1e-6);
	if (existing >= 0) { mergePoint(m, pid, existing); compact(m); return null; }
	if (best.r.kind === 'circle') { const gone = circlesToArcs(m, new Map([[best.r.i, [pid]]])); compact(m, { circles: gone }); } else attachPoint(m, best.X, pid, new Set([si]));
	return null;
}

// ------------------------------------------------------------------ offset

/** Ordered chains (open or closed) through the given segments: [{ steps: [{ s, fwd }], closed }]. */
function chainsOf(m, segIdx) {
	const left = new Set(segIdx), chains = [];
	const at = (v) => [...left].filter((i) => m.segs[i].a === v || m.segs[i].b === v);
	while (left.size) {
		// start at an end of an open chain if there is one
		let s0 = [...left].find((i) => at(m.segs[i].a).length === 1 || at(m.segs[i].b).length === 1);
		let fwd = true;
		if (s0 === undefined) s0 = [...left][0];
		else if (at(m.segs[s0].a).length !== 1) fwd = false;
		const steps = [{ s: s0, fwd }];
		left.delete(s0);
		let v = fwd ? m.segs[s0].b : m.segs[s0].a;
		const start = fwd ? m.segs[s0].a : m.segs[s0].b;
		for (;;) {
			const nx = at(v)[0];
			if (nx === undefined) break;
			const f = m.segs[nx].a === v;
			steps.push({ s: nx, fwd: f });
			left.delete(nx);
			v = f ? m.segs[nx].b : m.segs[nx].a;
		}
		chains.push({ steps, closed: v === start });
	}
	return chains;
}

/** Offset pieces: line { kind, A, B } or arc { kind, C, R, a0, a1, theta }, along the chain direction. */
function offsetPiece(m, step, d) {
	const s = m.segs[step.s];
	let A = m.points[s.a], B = m.points[s.b], b = s.arc || 0;
	if (!step.fwd) { [A, B] = [B, A]; b = -b; }
	if (!b) { const n = norm([-(B[1] - A[1]), B[0] - A[0]]); return { kind: 'line', A: [A[0] + n[0] * d, A[1] + n[1] * d], B: [B[0] + n[0] * d, B[1] + n[1] * d] }; }
	const { C, R, theta } = arcInfo(A, B, b);
	// left of the direction of travel: toward the center for counter-clockwise arcs
	const R2 = theta > 0 ? R - d : R + d;
	return { kind: 'arc', C, R: R2, theta, from: Math.atan2(A[1] - C[1], A[0] - C[0]), to: Math.atan2(B[1] - C[1], B[0] - C[0]) };
}
const pieceStart = (p) => (p.kind === 'line' ? p.A : [p.C[0] + p.R * Math.cos(p.from), p.C[1] + p.R * Math.sin(p.from)]);
const pieceEnd = (p) => (p.kind === 'line' ? p.B : [p.C[0] + p.R * Math.cos(p.to), p.C[1] + p.R * Math.sin(p.to)]);
const asEntity = (p) => (p.kind === 'line' ? p : { kind: 'circle', C: p.C, R: p.R });

/** Corner between two offset pieces: their intersection nearest the shifted shared vertex. */
function joinPieces(p, q) {
	const guess = pieceEnd(p), g2 = pieceStart(q);
	if (dist(guess, g2) < 1e-9) return guess;
	const cand = rawIntersect(asEntity(p), asEntity(q));
	const mid = [(guess[0] + g2[0]) / 2, (guess[1] + g2[1]) / 2];
	let best = null;
	for (const X of cand) if (!best || dist(X, mid) < dist(best, mid)) best = X;
	return best && dist(best, mid) < 10 * (dist(guess, g2) + 1e-6) + 1e-3 ? best : mid;
}

/**
 * Offset the selected segments (as chains) and circles by d. Closed chains: positive d grows outward.
 * Open chains: positive d is to the left of the chain. Returns the number of new entities.
 */
export function offset(m, segIdx, circleIdx, d) {
	let made = 0;
	for (const ci of circleIdx) {
		const c = m.circles[ci];
		if (c.r + d > 1e-6) { m.circles.push({ c: c.c, r: c.r + d }); made++; }
	}
	for (const ch of chainsOf(m, segIdx)) {
		if (ch.steps.some((st) => m.segs[st.s].spl)) continue;
		// closed chains: make positive d go outward (chain direction counter-clockwise → outward is to the right)
		let dd = d;
		if (ch.closed) {
			let area = 0;
			for (const st of ch.steps) { const s = m.segs[st.s]; const pts = st.fwd ? [m.points[s.a], ...segPoints(m.points[s.a], m.points[s.b], s.arc || 0)] : [m.points[s.b], ...segPoints(m.points[s.b], m.points[s.a], -(s.arc || 0))]; for (let k = 0; k + 1 < pts.length; k++) area += pts[k][0] * pts[k + 1][1] - pts[k + 1][0] * pts[k][1]; }
			dd = area > 0 ? -d : d;
		}
		const pieces = ch.steps.map((st) => offsetPiece(m, st, dd));
		if (pieces.some((p) => p.kind === 'arc' && !(p.R > 1e-6))) continue;
		const n = pieces.length, corners = [];
		for (let k = 0; k < n; k++) {
			if (k === 0 && !ch.closed) corners.push(pieceStart(pieces[0]));
			else corners.push(joinPieces(pieces[(k - 1 + n) % n], pieces[k]));
		}
		const ids = corners.map((P) => m.points.push([P[0], P[1]]) - 1);
		const endId = ch.closed ? ids[0] : m.points.push(pieceEnd(pieces[n - 1]).slice()) - 1;
		pieces.forEach((p, k) => {
			const a = ids[k], b = k + 1 < n ? ids[k + 1] : endId;
			const s = { a, b };
			if (p.kind === 'arc') {
				const A = m.points[a], B = m.points[b];
				let sweep = Math.atan2(B[1] - p.C[1], B[0] - p.C[0]) - Math.atan2(A[1] - p.C[1], A[0] - p.C[0]);
				if (p.theta > 0) { while (sweep <= 1e-9) sweep += TAU; } else { while (sweep >= -1e-9) sweep -= TAU; }
				if (Math.abs(sweep - p.theta) > Math.PI) sweep += sweep > p.theta ? -TAU : TAU;
				s.arc = Math.tan(sweep / 4);
			}
			m.segs.push(s);
			made++;
		});
	}
	return made;
}

// ------------------------------------------------------------------ slot & reference edges

/** Slot (stadium) from center c1 to center c2 with radius r: two lines and two semicircular arcs. */
export function addSlot(m, c1, c2, r, construction = false) {
	const d = norm(sub(c2, c1)), n = [-d[1], d[0]];
	const P = [[c1[0] + n[0] * r, c1[1] + n[1] * r], [c2[0] + n[0] * r, c2[1] + n[1] * r], [c2[0] - n[0] * r, c2[1] - n[1] * r], [c1[0] - n[0] * r, c1[1] - n[1] * r]];
	const ids = P.map((p) => m.points.push(p) - 1);
	const s0 = m.segs.length;
	// p1 → p2 (line), p2 → p3 around c2 (bulging away from c1: clockwise, bulge −1), p3 → p4, p4 → p1 around c1
	m.segs.push({ a: ids[0], b: ids[1] }, { a: ids[1], b: ids[2], arc: -1 }, { a: ids[2], b: ids[3] }, { a: ids[3], b: ids[0], arc: -1 });
	if (construction) for (let k = 0; k < 4; k++) m.segs[s0 + k].cons = true;
	m.cons.push({ type: 'tangent', s: [s0, s0 + 1], p: [] }, { type: 'tangent', s: [s0 + 1, s0 + 2], p: [] }, { type: 'tangent', s: [s0 + 2, s0 + 3], p: [] }, { type: 'tangent', s: [s0 + 3, s0], p: [] });
	return s0;
}
