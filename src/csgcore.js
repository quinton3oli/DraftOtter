// The solid-modeling kernel on Manifold: booleans, hulls, offsets and fit growth. It works on plain arrays (no
// three.js), so the same code runs on the main thread and in the background geometry workers (csgworker.js).
// Inputs are geometry-like objects { attributes: { position: { array } }, index } holding non-indexed triangles;
// results are { pos: Float32Array, idx: Uint32Array }.

import { weld } from './meshutil.js';
import { applyModifier } from './modifiers.js';

let MF = null;
export function setMF(mod) { MF = mod; }

/** A Manifold's triangles as plain arrays. */
export function rawOf(m) {
	const mesh = m.getMesh(), np = mesh.numProp || 3;
	let pos;
	if (np === 3) pos = new Float32Array(mesh.vertProperties);
	else { const v = mesh.vertProperties, n = v.length / np; pos = new Float32Array(n * 3); for (let i = 0; i < n; i++) { pos[3 * i] = v[np * i]; pos[3 * i + 1] = v[np * i + 1]; pos[3 * i + 2] = v[np * i + 2]; } }
	return { pos, idx: new Uint32Array(mesh.triVerts) };
}

const PERM = { x: [1, 2, 0], y: [2, 0, 1], z: [0, 1, 2] };

// Non-indexed geometry -> Manifold (throws if not a closed solid).
export function toManifold(geom) {
	// shared corners found by exact coordinates (typed-array hashing; indexed input is fine too)
	const w = weld(geom.attributes.position.array, geom.index ? geom.index.array : null, 0);
	const mesh = new MF.Mesh({ numProp: 3, vertProperties: new Float32Array(w.verts), triVerts: w.ids });
	mesh.merge();
	const m = new MF.Manifold(mesh);
	const st = m.status();
	if (st !== 'NoError') {
		m.delete();
		throw new Error('Manifold input error: ' + st);
	}
	return m;
}

// offset > 0 grows the result by that distance (rounded), offset < 0 shrinks it (Minkowski sum / difference with a sphere).
// intersect may also be 'hull': the convex hull around all solids (holes are still cut from it afterwards).
// mod: a texture / deform applied to the result last (see modifiers.js).
export function csgRaw(solids, holes, intersect, offset = 0, mod = null) {
	const made = [];
	const mk = (g) => { const m = toManifold(g); made.push(m); return m; };
	try {
		let acc;
		if (intersect === 'hull') {
			// built from the vertices alone, so it also works for meshes that aren't watertight
			acc = MF.Manifold.hull(hullPoints(solids));
			made.push(acc);
		} else {
			const S = solids.map(mk);
			acc = S.length === 1 ? S[0] : (intersect ? MF.Manifold.intersection(S) : MF.Manifold.union(S));
			if (acc !== S[0]) made.push(acc);
		}
		if (holes.length) {
			const H = holes.map(mk);
			const hu = H.length === 1 ? H[0] : MF.Manifold.union(H);
			if (hu !== H[0]) made.push(hu);
			acc = acc.subtract(hu);
			made.push(acc);
		}
		if (acc.isEmpty()) return null;
		if (offset) {
			const r = Math.abs(offset);
			const ball = MF.Manifold.sphere(r, r < 1 ? 12 : r < 4 ? 16 : 24);
			made.push(ball);
			acc = offset > 0 ? acc.minkowskiSum(ball) : acc.minkowskiDifference(ball);
			made.push(acc);
			if (acc.isEmpty()) return null;
		}
		if (mod) {
			acc = applyModifier(MF, acc, mod);
			made.push(acc);
			if (acc.isEmpty()) return null;
		}
		return rawOf(acc);
	} finally {
		for (const m of made) m.delete();
	}
}

export function hullPoints(geoms) {
	const pts = [];
	for (const g of geoms) {
		const a = g.attributes.position.array;
		for (let i = 0; i < a.length; i += 3) pts.push([a[i], a[i + 1], a[i + 2]]);
	}
	return pts;
}


// Segments for a round tool of radius c so its facets stay within 0.01 mm of the true circle (multiple of 4).
const toolSegs = (c) => Math.min(48, Math.max(8, 4 * Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - 0.01 / c)) / 4)));

/** The Minkowski tool for growing by c along the given axes: ball, flat disc in that plane, or a bar. */
function growTool(c, axes) {
	const t = Math.min(1e-3, c * 1e-2), n = toolSegs(c);
	if (axes.length === 3) return MF.Manifold.sphere(c, n);
	if (axes.length === 2) {
		const disc = MF.Manifold.cylinder(t, c, c, n, true);
		if (axes === 'xy') return disc;
		const r = axes === 'xz' ? disc.rotate([90, 0, 0]) : disc.rotate([0, 90, 0]);
		disc.delete();
		return r;
	}
	return MF.Manifold.cube([axes === 'x' ? 2 * c : t, axes === 'y' ? 2 * c : t, axes === 'z' ? 2 * c : t], true);
}

/**
 * If m is a straight extrusion along some axis (every vertex on one of two parallel planes, constant cross-section),
 * returns { axis, lo, hi } for it.
 */
function prismAxis(m) {
	const v = m.getMesh().vertProperties, bb = m.boundingBox();
	const vol = m.volume();
	for (const [i, axis] of [[2, 'z'], [0, 'x'], [1, 'y']]) {
		const lo = bb.min[i], hi = bb.max[i], h = hi - lo, eps = 1e-5 * Math.max(1, h);
		if (!(h > eps)) continue;
		let ok = true;
		for (let k = i; k < v.length; k += 3) if (Math.abs(v[k] - lo) > eps && Math.abs(v[k] - hi) > eps) { ok = false; break; }
		if (!ok) continue;
		// two planes alone also fit a frustum: the volume and the outline seen along the axis must match one section
		const p = toPlane(m, axis);
		const sec = p.slice((lo + hi) / 2), proj = p.project();
		const A = sec.area(), P = proj.area();
		sec.delete(); proj.delete(); p.delete();
		if (Math.abs(A * h - vol) <= 1e-4 * vol && Math.abs(P - A) <= 1e-4 * A) return { axis, lo, hi };
	}
	return null;
}
// Rotate coordinates so `axis` becomes Z (cyclic, so handedness is kept) and back again — see fromPlane.
const toPlane = (m, axis) => { const p = PERM[axis]; return axis === 'z' ? m.translate([0, 0, 0]) : m.warp((q) => { const o = [q[0], q[1], q[2]]; q[0] = o[p[0]]; q[1] = o[p[1]]; q[2] = o[p[2]]; }); };
const fromPlaneM = (m, axis) => { const p = PERM[axis]; return axis === 'z' ? m : m.warp((q) => { const o = [q[0], q[1], q[2]]; q[p[0]] = o[0]; q[p[1]] = o[1]; q[p[2]] = o[2]; }); };

/** Straight extrusion grown in 2D (a round offset, or a sweep along one direction) and re-extruded, longer if asked. */
function growPrism(m, pr, c, axes) {
	const made = [];
	try {
		const P = PERM[pr.axis], letters = 'xyz';
		const gu = axes.includes(letters[P[0]]), gv = axes.includes(letters[P[1]]), gw = axes.includes(pr.axis);
		const p = toPlane(m, pr.axis);
		made.push(p);
		let cs = p.slice((pr.lo + pr.hi) / 2);
		made.push(cs);
		if (gu && gv) { cs = cs.offset(c, 'Round', 2, toolSegs(c)); made.push(cs); }
		else if (gu || gv) {
			// exact 2D Minkowski with a segment: the shape plus every edge swept along the segment
			const d = gu ? [c, 0] : [0, c], quads = [];
			for (const poly of cs.toPolygons()) for (let i = 0; i < poly.length; i++) {
				const A = poly[i], B = poly[(i + 1) % poly.length];
				const q = [[A[0] - d[0], A[1] - d[1]], [B[0] - d[0], B[1] - d[1]], [B[0] + d[0], B[1] + d[1]], [A[0] + d[0], A[1] + d[1]]];
				const ar = (q[1][0] - q[0][0]) * (q[3][1] - q[0][1]) - (q[3][0] - q[0][0]) * (q[1][1] - q[0][1]);
				if (Math.abs(ar) < 1e-12) continue;
				quads.push(ar > 0 ? q : q.reverse());
			}
			const sw = MF.CrossSection.ofPolygons(quads, 'Positive');
			made.push(sw);
			cs = MF.CrossSection.union(cs, sw);
			made.push(cs);
		}
		const h = pr.hi - pr.lo + (gw ? 2 * c : 0);
		const ex = cs.extrude(h);
		made.push(ex);
		const placed = ex.translate([0, 0, pr.lo - (gw ? c : 0)]);
		made.push(placed);
		const back = fromPlaneM(placed, pr.axis);
		if (back === placed) made.pop();
		return back;
	} finally {
		for (const x of made) x.delete();
	}
}

let fastFit = true;
/** Turn the convex / extrusion shortcuts off (tests compare them with the plain Minkowski result). */
export function setFastFit(on) { fastFit = !!on; }

/** One connected solid grown: convex → direct Minkowski (fast), extrusion → 2D, anything else → general Minkowski. */
/**
 * Minkowski sum of two convex solids: the hull of every corner of one moved by every corner of the other. Exact, and
 * far faster than minkowskiSum, which misses convexity when rounding leaves the hull a hair bigger than the shape.
 */
function convexSum(m, tool) {
	const A = m.getMesh().vertProperties, B = tool.getMesh().vertProperties;
	const na = A.length / 3, nb = B.length / 3, pts = new Array(na * nb);
	for (let i = 0, k = 0; i < na; i++) for (let j = 0; j < nb; j++) pts[k++] = [A[3 * i] + B[3 * j], A[3 * i + 1] + B[3 * j + 1], A[3 * i + 2] + B[3 * j + 2]];
	return MF.Manifold.hull(pts);
}

function growPiece(m, c, axes, tool) {
	if (!fastFit) return m.minkowskiSum(tool);
	const hull = m.hull(), hv = hull.volume();
	hull.delete();
	if (hv - m.volume() <= 1e-6 * hv + 1e-9) return convexSum(m, tool);
	const pr = prismAxis(m);
	if (pr) return growPrism(m, pr, c, axes);
	return m.minkowskiSum(tool);
}

/**
 * Grow closed meshes (in one frame) by c only along some axes and return their union. A ball for 'xyz', a thin disc
 * for two axes (a true offset in that plane, nothing added across it), a thin bar for one axis. Growth distributes
 * over union, so every input and every loose piece in it is grown on its own and they are joined at the end.
 */
export function growRaw(geoms, c, axes) {
	if (!MF || !(c > 0) || !geoms.length) return null;
	const made = [];
	try {
		const tool = growTool(c, axes);
		made.push(tool);
		const out = [];
		for (const g of geoms) {
			const m = toManifold(g.index ? g.toNonIndexed() : g);
			made.push(m);
			const parts = m.decompose();
			made.push(...parts);
			for (const part of parts) { const r = growPiece(part, c, axes, tool); made.push(r); out.push(r); }
		}
		if (!out.length) return null;
		const u = out.length === 1 ? out[0] : MF.Manifold.union(out);
		if (u !== out[0]) made.push(u);
		return u.isEmpty() ? null : rawOf(u);
	} catch (err) {
		console.warn(err);
		return null;
	} finally {
		for (const x of made) x.delete();
	}
}


/**
 * Non-indexed triangles with crease-angle normals (smooth across edges under the angle, sharp above it), like
 * three.js toCreasedNormals, so workers can hand back geometry that is ready to draw: { pos, normal }.
 */
export function creased(r, creaseDeg = 30) {
	const P = r.pos, I = r.idx, T = I.length / 3, cos = Math.cos((creaseDeg * Math.PI) / 180);
	const fn = new Float32Array(T * 3);
	const nv = P.length / 3, count = new Uint32Array(nv + 1);
	for (let t = 0; t < T; t++) {
		const a = I[3 * t] * 3, b = I[3 * t + 1] * 3, c = I[3 * t + 2] * 3;
		const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
		let x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
		const l = Math.hypot(x, y, z) || 1;
		fn[3 * t] = x / l; fn[3 * t + 1] = y / l; fn[3 * t + 2] = z / l;
		for (let k = 0; k < 3; k++) count[I[3 * t + k] + 1]++;
	}
	// vertex -> faces (compressed lists)
	for (let i = 0; i < nv; i++) count[i + 1] += count[i];
	const fill = count.slice(0, nv), faces = new Uint32Array(T * 3);
	for (let t = 0; t < T; t++) for (let k = 0; k < 3; k++) faces[fill[I[3 * t + k]]++] = t;
	const pos = new Float32Array(T * 9), normal = new Float32Array(T * 9);
	for (let t = 0; t < T; t++) {
		const nx = fn[3 * t], ny = fn[3 * t + 1], nz = fn[3 * t + 2];
		for (let k = 0; k < 3; k++) {
			const v = I[3 * t + k], o = 9 * t + 3 * k;
			pos[o] = P[3 * v]; pos[o + 1] = P[3 * v + 1]; pos[o + 2] = P[3 * v + 2];
			let sx = 0, sy = 0, sz = 0;
			for (let j = count[v]; j < count[v + 1]; j++) {
				const f = faces[j], fx = fn[3 * f], fy = fn[3 * f + 1], fz = fn[3 * f + 2];
				if (fx * nx + fy * ny + fz * nz >= cos) { sx += fx; sy += fy; sz += fz; }
			}
			const l = Math.hypot(sx, sy, sz) || 1;
			normal[o] = sx / l; normal[o + 1] = sy / l; normal[o + 2] = sz / l;
		}
	}
	return { pos, normal };
}

/**
 * Push/pull of a face together with the rounded edges around it: every point of the part above a level just below
 * where the rounding starts, inside the face's outline, moves along the face normal by `depth`. The straight walls
 * under the rounding stretch or shrink with it, so no new faces or seams are made. M: the face frame (column-major
 * 4×4, face at z = 0, normal +z) in the solid's frame, Minv its inverse; p: { outline (2D, face frame), h, depth }.
 * Returns a new Manifold (the caller owns it), or null when it cannot be done (pushing in past other detail).
 */
export function moveFace(acc, M, Minv, p) {
	const d = p.depth || 0, h = p.h || 0, outline = p.outline || [];
	if (!d || outline.length < 3) return null;
	const made = [];
	const keep = (m) => { made.push(m); return m; };
	let out = null;
	try {
		const local = keep(acc.transform(Minv));
		const P = -(h + 0.02);
		const polys = keep(keep(new MF.CrossSection([outline], 'Positive')).offset(0.01, 'Miter')).toPolygons();
		const inside = (x, y) => {
			let c = false;
			for (const poly of polys) for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
				const [xi, yi] = poly[i], [xj, yj] = poly[j];
				if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
			}
			return c;
		};
		if (d < 0 && !h) {
			// nothing rounded to carry along: remove everything above the new level, inside an outline a hair wider
			// than the face, so the cut never has to line up with the walls (and leaves no skin on them)
			const F = keep(keep(new MF.CrossSection([outline], 'Positive')).offset(0.01, 'Miter'));
			const res = keep(local.subtract(keep(keep(F.extrude(1e4)).translate([0, 0, d]))));
			if (res.isEmpty() || res.status() !== 'NoError') return null;
			out = res.transform(M);
			return out;
		}
		if (d < 0) {
			// pushing in only shortens straight walls: no other point may lie in the height it takes away
			const mesh = local.getMesh(), np = mesh.numProp, V = mesh.vertProperties;
			for (let i = 0; i < V.length; i += np) {
				const z = V[i + 2];
				if (z <= P && z > P + d - 0.01 && inside(V[i], V[i + 1])) return null;
			}
		}
		const res = keep(local.warp((v) => { if (v[2] > P && inside(v[0], v[1])) v[2] += d; }));
		if (res.isEmpty() || res.status() !== 'NoError' || res.volume() <= 0) return null;
		out = res.transform(M);
		return out;
	} finally {
		for (const m of made) m.delete();
	}
}

/**
 * Push/pull of a curved surface (patch V, T in the feature frame; depth along the surface) done by moving the part's
 * own points: every point lying on the patch moves along the surface normal there, far enough that each face of the
 * patch ends up exactly `depth` away, and the faces around the patch stretch to follow. That only keeps those faces
 * flat when the points slide within them (a wall between a flat top and bottom), so otherwise null is returned and
 * the caller adds or cuts a slab instead. M: column-major 4×4 (feature frame → part frame).
 * Returns a new Manifold (the caller owns it) or null.
 */
export function offsetSurface(acc, M, p) {
	const d = p.depth || 0, V = p.V || [], T = p.T || [];
	if (!d || !T.length) return null;
	const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
	const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
	const unit = (a) => { const l = Math.hypot(...a) || 1; return a.map((x) => x / l); };
	const pt = (v) => [M[0] * v[0] + M[4] * v[1] + M[8] * v[2] + M[12], M[1] * v[0] + M[5] * v[1] + M[9] * v[2] + M[13], M[2] * v[0] + M[6] * v[1] + M[10] * v[2] + M[14]];
	const PV = V.map(pt);
	const tris = T.map(([a, b, c]) => { const A = PV[a], B = PV[b], C = PV[c]; return { A, B, C, n: unit(cross(sub(B, A), sub(C, A))) }; }).filter((t) => Math.hypot(...t.n) > 0.5);
	const tol = 1e-3;
	// distance from a point to a triangle (closest point, Ericson)
	const distTo = (P, { A, B, C }) => {
		const ab = sub(B, A), ac = sub(C, A), ap = sub(P, A);
		const d1 = dot(ab, ap), d2 = dot(ac, ap);
		if (d1 <= 0 && d2 <= 0) return Math.hypot(...ap);
		const bp = sub(P, B), d3 = dot(ab, bp), d4 = dot(ac, bp);
		if (d3 >= 0 && d4 <= d3) return Math.hypot(...bp);
		const cp = sub(P, C), d5 = dot(ab, cp), d6 = dot(ac, cp);
		if (d6 >= 0 && d5 <= d6) return Math.hypot(...cp);
		const vc = d1 * d4 - d3 * d2;
		if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return Math.hypot(...sub(P, [A[0] + ab[0] * v, A[1] + ab[1] * v, A[2] + ab[2] * v])); }
		const vb = d5 * d2 - d1 * d6;
		if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return Math.hypot(...sub(P, [A[0] + ac[0] * w, A[1] + ac[1] * w, A[2] + ac[2] * w])); }
		const va = d3 * d6 - d5 * d4;
		if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / (d4 - d3 + (d5 - d6)); return Math.hypot(...sub(P, [B[0] + (C[0] - B[0]) * w, B[1] + (C[1] - B[1]) * w, B[2] + (C[2] - B[2]) * w])); }
		const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
		return Math.hypot(...sub(P, [A[0] + ab[0] * v + ac[0] * w, A[1] + ab[1] * v + ac[1] * w, A[2] + ab[2] * v + ac[2] * w]));
	};
	// how a point on the patch moves: along the mean normal of the patch faces it touches, lengthened so each of them
	// moves exactly d (a point on a fold between two facets moves to where both offset facets meet)
	const moveOf = (P) => {
		// the distinct face directions at this point
		const ns = [];
		for (const t of tris) if (distTo(P, t) <= tol && !ns.some((n) => dot(n, t.n) > 1 - 1e-9)) ns.push(t.n);
		if (!ns.length) return null;
		let o;
		if (ns.length === 1) o = ns[0].map((x) => x * d);
		else if (ns.length === 2) {
			// where the two faces, each moved exactly d, meet: o·n1 = o·n2 = d
			const c = dot(ns[0], ns[1]);
			o = ns[0].map((x, i) => ((x + ns[1][i]) * d) / (1 + c));
		} else {
			// three or more: least squares for o·nᵢ = d (exact where three faces meet at a corner)
			const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], r = [0, 0, 0];
			for (const n of ns) for (let i = 0; i < 3; i++) { r[i] += n[i] * d; for (let j = 0; j < 3; j++) A[i][j] += n[i] * n[j]; }
			const det = A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1]) - A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0]) + A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]);
			if (Math.abs(det) < 1e-9) {
				const m = unit(ns.reduce((s2, n) => [s2[0] + n[0], s2[1] + n[1], s2[2] + n[2]], [0, 0, 0]));
				o = m.map((x) => (x * d) / Math.max(0.5, Math.min(...ns.map((n) => dot(n, m)))));
			} else {
				const col = (k) => A.map((row, i) => row.map((x, j) => (j === k ? r[i] : x)));
				const D = (B) => B[0][0] * (B[1][1] * B[2][2] - B[1][2] * B[2][1]) - B[0][1] * (B[1][0] * B[2][2] - B[1][2] * B[2][0]) + B[0][2] * (B[1][0] * B[2][1] - B[1][1] * B[2][0]);
				o = [D(col(0)) / det, D(col(1)) / det, D(col(2)) / det];
			}
		}
		// a point on a sharp fold would have to travel far: not a smooth surface to offset this way
		return Math.hypot(...o) > 2 * Math.abs(d) ? false : o;
	};
	const mesh = acc.getMesh(), np = mesh.numProp, AV = mesh.vertProperties, AT = mesh.triVerts, nv = AV.length / np;
	const at = (i) => [AV[np * i], AV[np * i + 1], AV[np * i + 2]];
	const moves = new Array(nv);
	let any = false;
	for (let i = 0; i < nv; i++) { const o = moveOf(at(i)); if (o === false) return null; moves[i] = o; if (o) any = true; }
	if (!any) return null;
	for (let t = 0; t < AT.length; t += 3) {
		const ids = [AT[t], AT[t + 1], AT[t + 2]], P = ids.map(at), os = ids.map((i) => moves[i]).filter(Boolean);
		if (!os.length) continue;
		const n = unit(cross(sub(P[1], P[0]), sub(P[2], P[0])));
		if (os.length === 3 && os.every((o) => dot(n, o) * Math.sign(d) > 0.5 * Math.hypot(...o))) continue; // part of the surface
		// a face beside the surface: its points must slide within it
		for (const o of os) if (Math.abs(dot(n, o)) > 1e-6 * Math.abs(d)) return null;
	}
	// getMesh() gives the points in single precision while warp() sees them in full: match on the single-precision value
	const f = Math.fround, key = (x, y, z) => f(x) + ',' + f(y) + ',' + f(z);
	const moveAt = new Map();
	for (let i = 0; i < nv; i++) if (moves[i]) moveAt.set(key(...at(i)), moves[i]);
	let moved = 0;
	const res = acc.warp((v) => { const o = moveAt.get(key(v[0], v[1], v[2])); if (o) { v[0] += o[0]; v[1] += o[1]; v[2] += o[2]; moved++; } });
	if (moved < moveAt.size || res.isEmpty() || res.status() !== 'NoError' || res.volume() <= 0) { res.delete(); return null; }
	return res;
}
