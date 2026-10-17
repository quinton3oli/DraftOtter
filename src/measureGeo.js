// Round-feature detection for the measure tool: circles and arcs on flat faces (hole rims, cylinder ends,
// slot ends, rounded corners), cylinders (including fillets) and spheres. Each result gives the center,
// radius and the plane / axis, so the tool can show the diameter (the maximum distance across).
import * as THREE from 'three';
import { faceRegion } from './pushpull.js';

// ---------------------------------------------------------------- small linear algebra

function solve(A, b) {
	const n = b.length, M = A.map((r, i) => [...r, b[i]]);
	for (let c = 0; c < n; c++) {
		let p = c;
		for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
		if (Math.abs(M[p][c]) < 1e-12) return null;
		[M[c], M[p]] = [M[p], M[c]];
		for (let r = 0; r < n; r++) {
			if (r === c) continue;
			const f = M[r][c] / M[c][c];
			for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
		}
	}
	return M.map((r, i) => r[n] / r[i]);
}

/** Least-squares circle through 2D points (algebraic fit). { cx, cy, r, rms } or null for (near) straight runs. */
export function fitCircle2(pts) {
	if (pts.length < 3) return null;
	// center the data for conditioning
	let mx = 0, my = 0;
	for (const [x, y] of pts) { mx += x; my += y; }
	mx /= pts.length; my /= pts.length;
	const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
	for (const [x0, y0] of pts) {
		const x = x0 - mx, y = y0 - my, z = -(x * x + y * y), row = [x, y, 1];
		for (let i = 0; i < 3; i++) { b[i] += row[i] * z; for (let j = 0; j < 3; j++) A[i][j] += row[i] * row[j]; }
	}
	const s = solve(A, b);
	if (!s) return null;
	const cx = -s[0] / 2, cy = -s[1] / 2, r2 = cx * cx + cy * cy - s[2];
	if (!(r2 > 0)) return null;
	const r = Math.sqrt(r2);
	let e = 0;
	for (const [x0, y0] of pts) e += (Math.hypot(x0 - mx - cx, y0 - my - cy) - r) ** 2;
	return { cx: cx + mx, cy: cy + my, r, rms: Math.sqrt(e / pts.length) };
}

function fitSphere(pts) {
	const m = new THREE.Vector3();
	for (const p of pts) m.add(p);
	m.multiplyScalar(1 / pts.length);
	const A = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], b = [0, 0, 0, 0];
	for (const p0 of pts) {
		const x = p0.x - m.x, y = p0.y - m.y, z = p0.z - m.z, w = -(x * x + y * y + z * z), row = [x, y, z, 1];
		for (let i = 0; i < 4; i++) { b[i] += row[i] * w; for (let j = 0; j < 4; j++) A[i][j] += row[i] * row[j]; }
	}
	const s = solve(A, b);
	if (!s) return null;
	const c = new THREE.Vector3(-s[0] / 2, -s[1] / 2, -s[2] / 2), r2 = c.lengthSq() - s[3];
	if (!(r2 > 0)) return null;
	const r = Math.sqrt(r2);
	c.add(m);
	let e = 0;
	for (const p of pts) e += (p.distanceTo(c) - r) ** 2;
	return { c, r, rms: Math.sqrt(e / pts.length) };
}

/** Eigen-decomposition of a symmetric 3×3 matrix (Jacobi). Returns [{ value, vector }] sorted ascending. */
function symEigen3(S) {
	const a = S.map((r) => r.slice()), v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
	for (let it = 0; it < 50; it++) {
		let p = 0, q = 1;
		if (Math.abs(a[0][2]) > Math.abs(a[p][q])) { p = 0; q = 2; }
		if (Math.abs(a[1][2]) > Math.abs(a[p][q])) { p = 1; q = 2; }
		if (Math.abs(a[p][q]) < 1e-12) break;
		const th = 0.5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]), c = Math.cos(th), s = Math.sin(th);
		for (let k = 0; k < 3; k++) { const x = a[k][p], y = a[k][q]; a[k][p] = c * x - s * y; a[k][q] = s * x + c * y; }
		for (let k = 0; k < 3; k++) { const x = a[p][k], y = a[q][k]; a[p][k] = c * x - s * y; a[q][k] = s * x + c * y; }
		for (let k = 0; k < 3; k++) { const x = v[k][p], y = v[k][q]; v[k][p] = c * x - s * y; v[k][q] = s * x + c * y; }
	}
	return [0, 1, 2].map((i) => ({ value: a[i][i], vector: new THREE.Vector3(v[0][i], v[1][i], v[2][i]) })).sort((x, y) => x.value - y.value);
}

function basisFor(n) {
	let x = new THREE.Vector3(1, 0, 0).projectOnPlane(n);
	if (x.length() < 0.1) x = new THREE.Vector3(0, 1, 0).projectOnPlane(n);
	x.normalize();
	return { x, y: n.clone().cross(x).normalize() };
}

const good = (fit, size) => fit && fit.r < size * 5 && fit.rms <= Math.max(1e-3, fit.r * 0.01);

// ---------------------------------------------------------------- loops (flat faces)

function distToLoop(h, lp) {
	let best = Infinity, bi = 0;
	for (let i = 0; i < lp.length; i++) {
		const a = lp[i], b = lp[(i + 1) % lp.length];
		const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy || 1e-12;
		const t = Math.max(0, Math.min(1, ((h[0] - a[0]) * dx + (h[1] - a[1]) * dy) / L));
		const d = Math.hypot(a[0] + t * dx - h[0], a[1] + t * dy - h[1]);
		if (d < best) { best = d; bi = t < 0.5 ? i : (i + 1) % lp.length; }
	}
	return { d: best, i: bi };
}

/** The circle or arc of a closed 2D loop around vertex i: { cx, cy, r, full, from, count } or null. */
export function arcAround(lp, i) {
	const n = lp.length;
	let xs = 1e9, xe = -1e9, ys = 1e9, ye = -1e9;
	for (const [x, y] of lp) { xs = Math.min(xs, x); xe = Math.max(xe, x); ys = Math.min(ys, y); ye = Math.max(ye, y); }
	const size = Math.hypot(xe - xs, ye - ys) || 1;
	if (n >= 6) {
		const all = fitCircle2(lp);
		if (good(all, size)) return { ...all, full: true, from: 0, count: n };
	}
	if (n < 5) return null;
	const run = (s, c) => Array.from({ length: c }, (_, k) => lp[(s + k + n) % n]);
	let s = i - 2, c = 5;
	let fit = fitCircle2(run(s, c));
	if (!good(fit, size)) return null;
	// grow forwards, then backwards, while the points stay on one circle
	for (;;) { if (c >= n) break; const f = fitCircle2(run(s, c + 1)); if (!good(f, size)) break; fit = f; c++; }
	for (;;) { if (c >= n) break; const f = fitCircle2(run(s - 1, c + 1)); if (!good(f, size)) break; fit = f; s--; c++; }
	// ignore runs that bend through only a few degrees (nearly straight polylines)
	const a0 = Math.atan2(lp[(s + n) % n][1] - fit.cy, lp[(s + n) % n][0] - fit.cx);
	const pts = run(s, c);
	let sweep = 0;
	for (let k = 1; k < pts.length; k++) {
		let d = Math.atan2(pts[k][1] - fit.cy, pts[k][0] - fit.cx) - Math.atan2(pts[k - 1][1] - fit.cy, pts[k - 1][0] - fit.cx);
		while (d > Math.PI) d -= 2 * Math.PI;
		while (d < -Math.PI) d += 2 * Math.PI;
		sweep += d;
	}
	if (Math.abs(sweep) < (20 * Math.PI) / 180) return null;
	return { ...fit, full: c >= n, from: (s + n) % n, count: c, a0, sweep };
}

// ---------------------------------------------------------------- main entry

const cache = new Map();

/**
 * Round feature at a picked triangle. Returns
 * { kind: 'circle' | 'arc' | 'cylinder' | 'sphere', center, normal (plane normal / cylinder axis), r,
 *   a0, sweep (arcs), loopDist (mm from the hit point to the rim, flat faces) } or null.
 */
export function roundFeatureAt(mesh, faceIndex, hit) {
	if (faceIndex == null) return null;
	mesh.updateWorldMatrix(true, false);
	const key = mesh.geometry.uuid + '|' + mesh.matrixWorld.elements.map((x) => x.toFixed(4)).join(',') + '|' + faceIndex;
	let reg = cache.get(key);
	if (reg === undefined) {
		reg = faceRegion(mesh, faceIndex);
		cache.set(key, reg);
		if (cache.size > 64) cache.delete(cache.keys().next().value);
	}
	if (!reg) return null;
	if (reg.curved) {
		const V = reg.V, N = reg.N;
		if (V.length < 6) return null;
		const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
		for (const n of N) { const a = [n.x, n.y, n.z]; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] += a[i] * a[j]; }
		const eig = symEigen3(C), tot = eig[0].value + eig[1].value + eig[2].value || 1;
		const box = new THREE.Box3().setFromPoints(V), size = box.getSize(new THREE.Vector3()).length() || 1;
		if (eig[0].value / tot < 0.02) {
			// normals all perpendicular to one direction: a cylinder (or a fillet) around that axis
			const axis = eig[0].vector.normalize(), { x, y } = basisFor(axis);
			const o = V[0];
			const fit = fitCircle2(V.map((p) => { const d = p.clone().sub(o); return [d.dot(x), d.dot(y)]; }));
			if (!good(fit, size)) return null;
			const c0 = o.clone().addScaledVector(x, fit.cx).addScaledVector(y, fit.cy);
			const center = c0.addScaledVector(axis, hit.clone().sub(c0).dot(axis)); // on the axis, level with the cursor
			return { kind: 'cylinder', center, normal: axis, r: fit.r };
		}
		if (eig[0].value / tot > 0.08) {
			const fit = fitSphere(V);
			if (fit && fit.rms <= Math.max(1e-3, fit.r * 0.01) && fit.r < size * 5) return { kind: 'sphere', center: fit.c, normal: hit.clone().sub(fit.c).normalize(), r: fit.r };
		}
		return null;
	}
	// flat face: nearest boundary loop to the cursor
	const { origin, basis, loops } = reg;
	const n = basis.x.clone().cross(basis.y).normalize();
	const dh = hit.clone().sub(origin), h = [dh.dot(basis.x), dh.dot(basis.y)];
	let best = null;
	for (const lp of loops) {
		const d = distToLoop(h, lp);
		if (!best || d.d < best.d) best = { ...d, lp };
	}
	if (!best) return null;
	const arc = arcAround(best.lp, best.i);
	if (!arc) return null;
	const center = origin.clone().addScaledVector(basis.x, arc.cx).addScaledVector(basis.y, arc.cy);
	const res = { kind: arc.full ? 'circle' : 'arc', center, normal: n, r: arc.r, loopDist: best.d };
	if (!arc.full) {
		// arc start direction and sweep in world space
		res.start = origin.clone().addScaledVector(basis.x, best.lp[arc.from][0]).addScaledVector(basis.y, best.lp[arc.from][1]);
		res.sweep = arc.sweep;
		res.basis = basis;
	}
	return res;
}
