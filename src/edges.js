// Edge features on finished meshes (works after booleans) and fillet / chamfer geometry along them.
//
// extractEdges(): welds a triangle mesh, groups triangles into smooth patches (crease angle), and returns
// the edges where two patches meet as chains, each with the per-vertex normals of both patches and whether
// the edge is convex (outside corner) or concave (inside corner).
//
// buildEdgeOp(): for each chain, sweeps the exact fillet / chamfer cross-section along it. Convex edges get a
// "cutter" (material to remove); concave edges get a "filler" (material to add).
import * as THREE from 'three';
import { signedVolume, flipWinding, revolveProfile } from './shapes.js';
import { weld } from './meshutil.js';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** Feature edges of a world-space mesh. Returns { chains, segments } (segments for picking / drawing). */
export function extractEdges(mesh, creaseDeg = 25) {
	const g = mesh.geometry, pos = g.attributes.position, idx = g.index;
	mesh.updateWorldMatrix(true, false);
	const M = mesh.matrixWorld, flip = M.determinant() < 0;
	// world-space vertices welded to 0.1 µm (typed-array hashing)
	const w = weld(pos.array, idx ? idx.array : null, 1e-4, M.elements);
	const V = new Array(w.count), T = [];
	for (let i = 0; i < w.count; i++) V[i] = [w.verts[3 * i], w.verts[3 * i + 1], w.verts[3 * i + 2]];
	const NV = w.count;
	const triCount = w.ids.length / 3;
	const srcTri = new Int32Array(triCount).fill(-1); // mesh triangle -> welded triangle
	for (let t = 0; t < triCount; t++) {
		let a = w.ids[3 * t], b = w.ids[3 * t + 1], c = w.ids[3 * t + 2];
		if (flip) [b, c] = [c, b];
		if (a === b || b === c || a === c) continue;
		srcTri[t] = T.length;
		T.push([a, b, c]);
	}
	const N = [], A = [];
	for (const [a, b, c] of T) {
		const cr = cross(sub(V[b], V[a]), sub(V[c], V[a]));
		A.push(len(cr) / 2);
		N.push(norm(cr));
	}
	// undirected edge -> triangles
	const ekey = (p, q) => (p < q ? p * NV + q : q * NV + p);
	const edgeTris = new Map();
	T.forEach(([a, b, c], t) => {
		for (const [p, q] of [[a, b], [b, c], [c, a]]) {
			const k = ekey(p, q);
			const l = edgeTris.get(k);
			if (l) l.push(t); else edgeTris.set(k, [t]);
		}
	});
	// smooth patches
	const cosCrease = Math.cos((creaseDeg * Math.PI) / 180);
	const patch = new Int32Array(T.length).fill(-1);
	let np = 0;
	const triEdges = (t) => { const [a, b, c] = T[t]; return [ekey(a, b), ekey(b, c), ekey(c, a)]; };
	for (let s = 0; s < T.length; s++) {
		if (patch[s] >= 0) continue;
		patch[s] = np;
		const st = [s];
		while (st.length) {
			const t = st.pop();
			for (const k of triEdges(t)) {
				const tt = edgeTris.get(k);
				if (tt.length !== 2) continue;
				const u = tt[0] === t ? tt[1] : tt[0];
				if (patch[u] >= 0 || dot(N[t], N[u]) < cosCrease) continue;
				patch[u] = np;
				st.push(u);
			}
		}
		np++;
	}
	// feature edges grouped by patch pair
	const groups = new Map();
	for (const [k, tt] of edgeTris) {
		if (tt.length !== 2 || patch[tt[0]] === patch[tt[1]]) continue;
		const p = Math.floor(k / NV), q = k % NV;
		let [ta, tb] = tt;
		if (patch[ta] > patch[tb]) [ta, tb] = [tb, ta];
		const gk = patch[ta] + ':' + patch[tb];
		if (!groups.has(gk)) groups.set(gk, { pa: patch[ta], pb: patch[tb], edges: [] });
		groups.get(gk).edges.push({ p, q, ta, tb });
	}
	// per-vertex normals per patch (area weighted)
	const vertPatchN = new Map();
	T.forEach((tri, t) => {
		for (const v of tri) {
			const k = v * (np + 1) + patch[t];
			const cur = vertPatchN.get(k) || [0, 0, 0];
			vertPatchN.set(k, add(cur, mul(N[t], A[t])));
		}
	});
	const pn = (v, p) => norm(vertPatchN.get(v * (np + 1) + p) || [0, 0, 1]);

	const chains = [];
	for (const grp of groups.values()) {
		const adj = new Map();
		for (const e of grp.edges) {
			for (const [x, y] of [[e.p, e.q], [e.q, e.p]]) { if (!adj.has(x)) adj.set(x, []); adj.get(x).push({ to: y, e }); }
		}
		const used = new Set();
		const walk = (start) => {
			const ids = [start];
			let cur = start;
			for (;;) {
				const nx = (adj.get(cur) || []).find((n) => !used.has(n.e));
				if (!nx) break;
				used.add(nx.e);
				cur = nx.to;
				if (cur === start) return { ids, closed: true };
				ids.push(cur);
			}
			return { ids, closed: false };
		};
		const starts = [...adj.keys()].sort((a, b) => (adj.get(a).length === 1 ? -1 : 0) - (adj.get(b).length === 1 ? -1 : 0));
		for (const s of starts) {
			while ((adj.get(s) || []).some((n) => !used.has(n.e))) {
				const { ids, closed } = walk(s);
				if (ids.length < 2) continue;
				// convex if patch B's triangle lies behind patch A's plane at this edge
				const e0 = grp.edges.find((e) => (e.p === ids[0] && e.q === ids[1]) || (e.q === ids[0] && e.p === ids[1])) || grp.edges[0];
				const cb = T[e0.tb].reduce((s2, v) => add(s2, mul(V[v], 1 / 3)), [0, 0, 0]);
				const convex = dot(sub(cb, V[e0.p]), N[e0.ta]) < 0;
				chains.push({
					pts: ids.map((v) => V[v]), n1: ids.map((v) => pn(v, grp.pa)), n2: ids.map((v) => pn(v, grp.pb)),
					closed, convex, pa: grp.pa, pb: grp.pb, angle: (Math.acos(Math.max(-1, Math.min(1, dot(N[e0.ta], N[e0.tb])))) * 180) / Math.PI,
				});
			}
		}
	}
	// the smooth patch (face) each mesh triangle belongs to, for picking a face to select all its edges
	const triPatch = Array.from(srcTri, (w) => (w >= 0 ? patch[w] : -1));
	return { chains, triPatch };
}

// Cross-section ring of the fillet / chamfer at one point of an edge.
function sectionRing(E, n1, n2, convex, kind, r, segs, eps) {
	const c = Math.max(-0.995, Math.min(0.995, dot(n1, n2)));
	const s = convex ? -1 : 1; // center lies inside the material (convex) or in the empty wedge (concave)
	const push = convex ? 1 : -1; // nudge the flat sides off the faces: outward for cutters, inward for fillers
	const bis = norm(add(n1, n2));
	const ring = [add(E, mul(bis, push * eps))];
	let T1, T2, arc = [];
	if (kind === 'chamfer') {
		const v1 = norm(mul(sub(n2, mul(n1, c)), convex ? -1 : 1)), v2 = norm(mul(sub(n1, mul(n2, c)), convex ? -1 : 1));
		T1 = add(E, mul(v1, r));
		T2 = add(E, mul(v2, r));
		arc = [T1, T2];
	} else {
		const k = r / (1 + c);
		const C = add(E, mul(add(n1, n2), s * k));
		for (let i = 0; i <= segs; i++) {
			const t = i / segs;
			const d = norm(add(mul(n1, 1 - t), mul(n2, t))); // between n1 and n2
			arc.push(add(C, mul(d, -s * r)));
		}
		T1 = arc[0];
		T2 = arc[arc.length - 1];
	}
	ring.push(add(T1, mul(n1, push * eps)), ...arc, add(T2, mul(n2, push * eps)));
	return ring;
}

// Closed solid swept through rings (open chains get caps fanned from each ring's first point).
function sweepSolid(rings, closed) {
	const pos = [], tri = (a, b, c) => pos.push(...a, ...b, ...c);
	const n = rings[0].length, m = rings.length;
	for (let k = 0; k < (closed ? m : m - 1); k++) {
		const A = rings[k], B = rings[(k + 1) % m];
		for (let i = 0; i < n; i++) { const j = (i + 1) % n; tri(A[i], A[j], B[j]); tri(A[i], B[j], B[i]); }
	}
	if (!closed) {
		const S = rings[0], Eend = rings[m - 1];
		for (let i = 1; i < n - 1; i++) { tri(S[0], S[i + 1], S[i]); tri(Eend[0], Eend[i], Eend[i + 1]); }
	}
	const g = new THREE.BufferGeometry();
	g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
	if (signedVolume(g) < 0) flipWinding(g); // booleans need outward-facing triangles
	return g;
}

/** Geometry for one edge-op node: params { chains, kind: 'fillet'|'chamfer', size, segs }. */
export function buildEdgeOp(p, ctx) {
	const r = Math.max(0.01, p.size || 1), segs = Math.max(2, p.segs | 0 || 12);
	// variable size: from size at the start of each edge to size2 at its end (closed loops go there and back)
	const r2 = p.size2 > 0 ? Math.max(0.01, p.size2) : r;
	const eps = Math.max(0.02, Math.max(r, r2) * 0.03);
	const solids = [];
	for (const ch of p.chains || []) {
		const n = ch.pts.length;
		if (n < 2) continue;
		const radii = radiiAlong(ch, r, r2);
		let rings = ch.pts.map((E, i) => sectionRing(E, ch.n1[i], ch.n2[i], !!ch.convex, p.kind, radii[i], segs, eps));
		if (!ch.closed && ch.convex) {
			// cutters run slightly past both ends so the cut goes cleanly through the neighboring faces
			// (fillers stop flush, otherwise they would leave tiny bumps on the end faces)
			const t0 = norm(sub(ch.pts[0], ch.pts[1])), t1 = norm(sub(ch.pts[n - 1], ch.pts[n - 2]));
			const ext = Math.max(0.05, Math.max(r, r2) * 0.05);
			rings = [rings[0].map((q) => add(q, mul(t0, ext))), ...rings, rings[n - 1].map((q) => add(q, mul(t1, ext)))];
		}
		solids.push(sweepSolid(rings, !!ch.closed));
	}
	// Rolling-ball corners: where three filleted outside edges meet, carve a spherical corner.
	// (with a variable size, only where all three edges arrive with the same radius)
	if (p.kind !== 'chamfer') solids.push(...cornerPatches(p.chains || [], r, segs, eps, ctx, r2));
	if (!solids.length) return null;
	if (solids.length === 1) return solids[0];
	return ctx && ctx.csg ? ctx.csg(solids, []) : solids[0];
}

/** Fillet size at each point of a chain: size at the start, size2 at the end, linear in distance along the edge. */
export function radiiAlong(ch, r, r2) {
	const n = ch.pts.length;
	if (!(Math.abs(r2 - r) > 1e-9)) return new Array(n).fill(r);
	const L = [0];
	for (let i = 1; i < n; i++) L.push(L[i - 1] + len(sub(ch.pts[i], ch.pts[i - 1])));
	const total = L[n - 1] + (ch.closed ? len(sub(ch.pts[0], ch.pts[n - 1])) : 0) || 1;
	// closed loops: out to size2 halfway round and smoothly back, so the loop meets itself
	return L.map((l) => { const t = l / total; return ch.closed ? r + (r2 - r) * (1 - Math.cos(2 * Math.PI * t)) / 2 : r + (r2 - r) * t; });
}

// For each corner shared by convex chains whose faces have exactly three distinct normals: the ball center C
// sits r inside all three faces; the cutter is the box between C and the corner minus the ball.
function cornerPatches(chains, r0, segs, eps, ctx, r2 = r0) {
	const ends = new Map();
	const keyOf = (q) => q.map((v) => Math.round(v * 1e3)).join(',');
	for (const ch of chains) {
		if (ch.closed || !ch.convex || ch.pts.length < 2) continue;
		const n = ch.pts.length;
		for (const i of [0, n - 1]) {
			const k = keyOf(ch.pts[i]);
			if (!ends.has(k)) ends.set(k, { V: ch.pts[i], normals: [], count: 0, radii: [] });
			const rec = ends.get(k);
			rec.count++;
			rec.radii.push(i === 0 ? r0 : r2);
			for (const nn of [ch.n1[i], ch.n2[i]]) if (!rec.normals.some((m) => dot(m, nn) > 0.999)) rec.normals.push(nn);
		}
	}
	const out = [];
	for (const { V, normals, count, radii } of ends.values()) {
		if (normals.length !== 3 || count < 3) continue; // only where three filleted edges actually meet
		const r = radii[0];
		if (radii.some((x) => Math.abs(x - r) > 1e-6)) continue; // different sizes arrive here: no single ball
		const M = new THREE.Matrix3().set(...normals[0], ...normals[1], ...normals[2]);
		if (Math.abs(M.determinant()) < 0.05) continue; // nearly coplanar faces: no well-defined ball corner
		const Mi = M.clone().invert();
		const solve = (s) => new THREE.Vector3(...s).applyMatrix3(Mi).toArray();
		const C = add(V, solve([-r, -r, -r]));
		const corner = (b) => add(C, solve([0, 1, 2].map((i) => ((b >> i) & 1 ? r + eps : 0))));
		const P = Array.from({ length: 8 }, (_, b) => corner(b));
		const center = P.reduce((s, q) => add(s, mul(q, 1 / 8)), [0, 0, 0]);
		const pos = [];
		for (let i = 0; i < 3; i++) {
			for (const bit of [0, 1]) {
				const [j, k] = [0, 1, 2].filter((x) => x !== i);
				const idx = (bj, bk) => (bit << i) | (bj << j) | (bk << k);
				const q = [P[idx(0, 0)], P[idx(1, 0)], P[idx(1, 1)], P[idx(0, 1)]];
				for (const [a, b, c] of [[q[0], q[1], q[2]], [q[0], q[2], q[3]]]) {
					const nrm = cross(sub(b, a), sub(c, a)), fc = mul(add(add(a, b), c), 1 / 3);
					if (dot(nrm, sub(fc, center)) >= 0) pos.push(...a, ...b, ...c); else pos.push(...a, ...c, ...b);
				}
			}
		}
		const box = new THREE.BufferGeometry();
		box.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
		const half = Math.max(8, segs * 2), prof = [];
		for (let i = 0; i <= half; i++) { const a = -Math.PI / 2 + (Math.PI * i) / half; prof.push([r * Math.cos(a), r * Math.sin(a)]); }
		const ball = revolveProfile(prof, half * 2).toNonIndexed ? revolveProfile(prof, half * 2) : null;
		if (!ball) continue;
		ball.translate(C[0], C[1], C[2]);
		if (signedVolume(ball) < 0) flipWinding(ball);
		const patch = ctx && ctx.csg ? ctx.csg([box], [ball]) : null;
		if (patch) out.push(patch);
	}
	return out;
}
