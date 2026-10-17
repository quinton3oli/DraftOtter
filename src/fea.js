// Basic stress check: linear-elastic finite elements on a voxel model of the part.
// The part is voxelized into cubes; each cube is an 8-node brick with incompatible (bending) modes, so beams and
// plates bend realistically even with only a few cubes through the thickness. The system K·u = f is solved by a
// Jacobi-preconditioned conjugate gradient in a Web Worker (matrix-free). Units: mm, N, MPa.
import * as THREE from 'three';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';

export const MATERIALS = {
	PLA: { E: 3500, nu: 0.36, yield: 50 },
	PETG: { E: 2100, nu: 0.38, yield: 50 },
	ABS: { E: 2200, nu: 0.35, yield: 40 },
	ASA: { E: 2000, nu: 0.35, yield: 45 },
	'Nylon (PA12)': { E: 1700, nu: 0.39, yield: 48 },
	PC: { E: 2400, nu: 0.37, yield: 62 },
	'Aluminum 6061': { E: 69000, nu: 0.33, yield: 276 },
	'Steel (mild)': { E: 200000, nu: 0.3, yield: 250 },
};

// ================================================================= voxel model

/**
 * Voxelize a closed world mesh into a grid that fits its bounding box exactly (cells are bricks hx × hy × hz):
 * { nx, ny, nz, hx, hy, hz, h, origin: [x, y, z], solid: Uint8Array(nx·ny·nz) }.
 * target: approximate number of solid voxels.
 */
export function voxelize(geom, target = 12000) {
	const g = geom.index ? geom.toNonIndexed() : geom;
	g.computeBoundingBox();
	const bb = g.boundingBox, size = bb.getSize(new THREE.Vector3());
	let vol = 0;
	const p = g.attributes.position.array;
	for (let i = 0; i < p.length; i += 9) vol += (p[i] * (p[i + 4] * p[i + 8] - p[i + 5] * p[i + 7]) - p[i + 1] * (p[i + 3] * p[i + 8] - p[i + 5] * p[i + 6]) + p[i + 2] * (p[i + 3] * p[i + 7] - p[i + 4] * p[i + 6])) / 6;
	vol = Math.abs(vol) || size.x * size.y * size.z;
	let h = Math.cbrt(vol / target);
	h = Math.max(h, Math.max(size.x, size.y, size.z) / 160);
	const nx = Math.max(1, Math.round(size.x / h)), ny = Math.max(1, Math.round(size.y / h)), nz = Math.max(1, Math.round(size.z / h));
	const hx = size.x / nx || h, hy = size.y / ny || h, hz = size.z / nz || h;
	const origin = [bb.min.x, bb.min.y, bb.min.z];
	const solid = new Uint8Array(nx * ny * nz);
	const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
	g.boundsTree = new MeshBVH(g);
	mesh.raycast = acceleratedRaycast;
	const rc = new THREE.Raycaster();
	rc.firstHitOnly = false;
	const dir = new THREE.Vector3(1, 0, 0);
	for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) {
		// one ray along X per row of voxel centers; inside where an odd number of surfaces has been crossed
		const y = origin[1] + (j + 0.5) * hy, z = origin[2] + (k + 0.5) * hz;
		rc.set(new THREE.Vector3(bb.min.x - 1, y + hy * 1e-4, z + hz * 1.3e-4), dir);
		const xs = rc.intersectObject(mesh, false).map((it) => it.point.x).sort((a, b) => a - b);
		const uniq = xs.filter((x, i) => i === 0 || x - xs[i - 1] > 1e-7);
		for (let i = 0; i < nx; i++) {
			const x = origin[0] + (i + 0.5) * hx;
			let c = 0;
			for (const q of uniq) if (q < x) c++;
			if (c % 2) solid[i + nx * (j + ny * k)] = 1;
		}
	}
	g.boundsTree = undefined;
	return { nx, ny, nz, hx, hy, hz, h: Math.cbrt(hx * hy * hz), origin, solid };
}

/** Nodes (voxel corners) of solid voxels that lie within `tol` of the picked surface triangles. */
export function nodesNear(vox, tris, tol) {
	const { nx, ny, nz, hx, hy, hz, origin, solid } = vox;
	const g = new THREE.BufferGeometry();
	g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(tris), 3));
	const bvh = new MeshBVH(g);
	const out = new Set();
	const P = new THREE.Vector3(), target = {};
	const used = new Uint8Array((nx + 1) * (ny + 1) * (nz + 1));
	for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
		if (!solid[i + nx * (j + ny * k)]) continue;
		for (let c = 0; c < 8; c++) used[(i + (c & 1)) + (nx + 1) * ((j + ((c >> 1) & 1)) + (ny + 1) * (k + ((c >> 2) & 1)))] = 1;
	}
	for (let k = 0; k <= nz; k++) for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
		const n = i + (nx + 1) * (j + (ny + 1) * k);
		if (!used[n]) continue;
		P.set(origin[0] + i * hx, origin[1] + j * hy, origin[2] + k * hz);
		const r = bvh.closestPointToPoint(P, target, 0, tol);
		if (r && target.distance <= tol) out.add(n);
	}
	return [...out];
}

// ================================================================= solver (runs in a worker)

export function solverMain() {
	const gauss = [-1 / Math.sqrt(3), 1 / Math.sqrt(3)];
	const NAT = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]];
	function Dmat(E, nu) {
		const c = E / ((1 + nu) * (1 - 2 * nu)), g = (1 - 2 * nu) / 2;
		return [[1 - nu, nu, nu, 0, 0, 0], [nu, 1 - nu, nu, 0, 0, 0], [nu, nu, 1 - nu, 0, 0, 0], [0, 0, 0, g, 0, 0], [0, 0, 0, 0, g, 0], [0, 0, 0, 0, 0, g]].map((r) => r.map((v) => v * c));
	}
	// strain-displacement for a brick hx × hy × hz at natural point (xi, eta, zeta); dN/dx = (2 / hx) dN/dxi
	let SX = 2, SY = 2, SZ = 2;
	function Bmat(xi, eta, zeta) {
		const B = Array.from({ length: 6 }, () => new Float64Array(24));
		for (let a = 0; a < 8; a++) {
			const [xa, ya, za] = NAT[a];
			const dx = 0.125 * SX * xa * (1 + eta * ya) * (1 + zeta * za), dy = 0.125 * SY * ya * (1 + xi * xa) * (1 + zeta * za), dz = 0.125 * SZ * za * (1 + xi * xa) * (1 + eta * ya);
			B[0][3 * a] = dx; B[1][3 * a + 1] = dy; B[2][3 * a + 2] = dz;
			B[3][3 * a] = dy; B[3][3 * a + 1] = dx;
			B[4][3 * a + 1] = dz; B[4][3 * a + 2] = dy;
			B[5][3 * a] = dz; B[5][3 * a + 2] = dx;
		}
		return B;
	}
	// incompatible (bubble) modes 1 − xi², 1 − eta², 1 − zeta² for each displacement component
	function Bincomp(xi, eta, zeta) {
		const B = Array.from({ length: 6 }, () => new Float64Array(9));
		const d = [[-2 * xi * SX, 0, 0], [0, -2 * eta * SY, 0], [0, 0, -2 * zeta * SZ]]; // dP_m/d(x,y,z)
		for (let m = 0; m < 3; m++) {
			const [dx, dy, dz] = d[m];
			B[0][m] = dx; B[3][m] = dy; B[5][m] = dz; // ux modes
			B[1][3 + m] = dy; B[3][3 + m] = dx; B[4][3 + m] = dz; // uy modes
			B[2][6 + m] = dz; B[4][6 + m] = dy; B[5][6 + m] = dx; // uz modes
		}
		return B;
	}
	const mulT = (A, D, Bm, out, w) => { // out += Aᵀ D B · w
		const ra = A[0].length, rb = Bm[0].length;
		const DB = D.map((row) => { const r = new Float64Array(rb); for (let k = 0; k < 6; k++) if (row[k]) for (let j = 0; j < rb; j++) r[j] += row[k] * Bm[k][j]; return r; });
		for (let i = 0; i < ra; i++) for (let k = 0; k < 6; k++) { const a = A[k][i]; if (!a) continue; for (let j = 0; j < rb; j++) out[i][j] += a * DB[k][j] * w; }
	};
	function invert(M) {
		const n = M.length, A = M.map((r, i) => [...r, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
		for (let c = 0; c < n; c++) {
			let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
			[A[c], A[p]] = [A[p], A[c]];
			const d = A[c][c];
			for (let j = 0; j < 2 * n; j++) A[c][j] /= d;
			for (let r = 0; r < n; r++) if (r !== c) { const f = A[r][c]; if (f) for (let j = 0; j < 2 * n; j++) A[r][j] -= f * A[c][j]; }
		}
		return A.map((r) => r.slice(n));
	}
	/** Condensed 24×24 stiffness of a brick hx × hy × hz with E = 1 (scale by E). */
	function brickKE(nu, hx, hy, hz) {
		SX = 2 / hx; SY = 2 / hy; SZ = 2 / hz;
		const D = Dmat(1, nu), w = (hx * hy * hz) / 8; // detJ
		const Kuu = Array.from({ length: 24 }, () => new Float64Array(24)), Kua = Array.from({ length: 24 }, () => new Float64Array(9)), Kaa = Array.from({ length: 9 }, () => new Float64Array(9));
		for (const a of gauss) for (const b of gauss) for (const c of gauss) {
			const B = Bmat(a, b, c), Ba = Bincomp(a, b, c);
			mulT(B, D, B, Kuu, w); mulT(B, D, Ba, Kua, w); mulT(Ba, D, Ba, Kaa, w);
		}
		const Ki = invert(Kaa.map((r) => [...r]));
		const KE = new Float64Array(576);
		for (let i = 0; i < 24; i++) for (let j = 0; j < 24; j++) {
			let s = Kuu[i][j];
			for (let p = 0; p < 9; p++) for (let q = 0; q < 9; q++) s -= Kua[i][p] * Ki[p][q] * Kua[j][q];
			KE[i * 24 + j] = s;
		}
		return KE;
	}

	self.onmessage = (ev) => {
		const { nx, ny, nz, h, solid, fixed, loads, E, nu, maxIter = 4000, tol = 1e-6 } = ev.data;
		const hx = ev.data.hx || h, hy = ev.data.hy || h, hz = ev.data.hz || h;
		const NX = nx + 1, NY = ny + 1, nn = NX * NY * (nz + 1);
		const KE = brickKE(nu, hx, hy, hz), scale = E;
		// elements
		const elems = [];
		for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (solid[i + nx * (j + ny * k)]) elems.push(i, j, k);
		const ne = elems.length / 3, conn = new Int32Array(ne * 8);
		for (let e = 0; e < ne; e++) {
			const i = elems[3 * e], j = elems[3 * e + 1], k = elems[3 * e + 2];
			NAT.forEach(([a, b, c], m) => { conn[e * 8 + m] = (i + (a > 0 ? 1 : 0)) + NX * ((j + (b > 0 ? 1 : 0)) + NY * (k + (c > 0 ? 1 : 0))); });
		}
		const ndof = nn * 3;
		const fix = new Uint8Array(ndof);
		for (const n of fixed) { fix[3 * n] = fix[3 * n + 1] = fix[3 * n + 2] = 1; }
		const diag = new Float64Array(ndof);
		for (let e = 0; e < ne; e++) for (let a = 0; a < 8; a++) for (let c = 0; c < 3; c++) diag[3 * conn[e * 8 + a] + c] += KE[(3 * a + c) * 25] * scale;
		const used = new Uint8Array(ndof);
		for (let d = 0; d < ndof; d++) used[d] = diag[d] > 0 ? 1 : 0;
		const Kp = (p, out) => {
			out.fill(0);
			const pe = new Float64Array(24);
			for (let e = 0; e < ne; e++) {
				for (let a = 0; a < 8; a++) { const n = 3 * conn[e * 8 + a]; pe[3 * a] = p[n]; pe[3 * a + 1] = p[n + 1]; pe[3 * a + 2] = p[n + 2]; }
				for (let r = 0; r < 24; r++) {
					let s = 0;
					const row = r * 24;
					for (let c = 0; c < 24; c++) s += KE[row + c] * pe[c];
					out[3 * conn[e * 8 + (r / 3 | 0)] + (r % 3)] += s * scale;
				}
			}
			for (let d = 0; d < ndof; d++) if (fix[d] || !used[d]) out[d] = 0;
		};
		const f = new Float64Array(ndof);
		for (let d = 0; d < ndof; d++) if (!fix[d] && used[d]) f[d] = loads[d] || 0;
		const u = new Float64Array(ndof), r = f.slice(), z = new Float64Array(ndof), p = new Float64Array(ndof), q = new Float64Array(ndof);
		const Minv = (d) => (diag[d] > 0 && !fix[d] ? 1 / diag[d] : 0);
		let rz = 0, fn = 0;
		for (let d = 0; d < ndof; d++) { z[d] = r[d] * Minv(d); p[d] = z[d]; rz += r[d] * z[d]; fn += f[d] * f[d]; }
		fn = Math.sqrt(fn) || 1;
		let it = 0, res = 1;
		for (; it < maxIter; it++) {
			Kp(p, q);
			let pq = 0;
			for (let d = 0; d < ndof; d++) pq += p[d] * q[d];
			if (!(Math.abs(pq) > 1e-300)) break;
			const alpha = rz / pq;
			let rr = 0;
			for (let d = 0; d < ndof; d++) { u[d] += alpha * p[d]; r[d] -= alpha * q[d]; rr += r[d] * r[d]; }
			res = Math.sqrt(rr) / fn;
			if (it % 25 === 0) self.postMessage({ progress: Math.min(0.99, Math.log(1 / Math.max(res, tol)) / Math.log(1 / tol)), it, res });
			if (res < tol) break;
			let rz2 = 0;
			for (let d = 0; d < ndof; d++) { z[d] = r[d] * Minv(d); rz2 += r[d] * z[d]; }
			const beta = rz2 / rz;
			rz = rz2;
			for (let d = 0; d < ndof; d++) p[d] = z[d] + beta * p[d];
		}
		// element von Mises stress at the center (incompatible modes vanish there)
		const B0 = Bmat(0, 0, 0), D = Dmat(E, nu), vm = new Float32Array(ne);
		for (let e = 0; e < ne; e++) {
			const eps = new Float64Array(6);
			for (let a = 0; a < 8; a++) { const n = 3 * conn[e * 8 + a]; for (let c = 0; c < 3; c++) { const v = u[n + c]; for (let k = 0; k < 6; k++) eps[k] += B0[k][3 * a + c] * v; } }
			const s = D.map((row) => row.reduce((acc, v, k) => acc + v * eps[k], 0));
			vm[e] = Math.sqrt(0.5 * ((s[0] - s[1]) ** 2 + (s[1] - s[2]) ** 2 + (s[2] - s[0]) ** 2) + 3 * (s[3] ** 2 + s[4] ** 2 + s[5] ** 2));
		}
		self.postMessage({ done: true, u, vm, elems: new Int32Array(elems), iterations: it, residual: res, converged: res < tol * 10 }, [u.buffer, vm.buffer]);
	};
}

let workerUrl = null;
/** Solve a voxel model. onProgress(fraction). Resolves { u, vm, elems, iterations, residual, converged }. */
export function solveFEA(vox, fixedNodes, loads, mat, onProgress) {
	if (!workerUrl) workerUrl = URL.createObjectURL(new Blob(['(' + solverMain.toString() + ')()'], { type: 'text/javascript' }));
	return new Promise((resolve, reject) => {
		const w = new Worker(workerUrl);
		w.onmessage = (ev) => {
			if (ev.data.done) { w.terminate(); resolve(ev.data); } else if (onProgress) onProgress(ev.data.progress, ev.data);
		};
		w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'Solver failed')); };
		w.postMessage({ nx: vox.nx, ny: vox.ny, nz: vox.nz, h: vox.h, hx: vox.hx, hy: vox.hy, hz: vox.hz, solid: vox.solid, fixed: fixedNodes, loads, E: mat.E, nu: mat.nu });
	});
}

// ================================================================= post-processing

/** Nodal fields (averaged element stress, displacement) sampled at mesh vertices. */
export function sampleResults(vox, res, positions) {
	const { nx, ny, nz, origin } = vox, NX = nx + 1, NY = ny + 1, nn = NX * NY * (nz + 1);
	const hx = vox.hx || vox.h, hy = vox.hy || vox.h, hz = vox.hz || vox.h;
	const ns = new Float32Array(nn), cnt = new Uint16Array(nn);
	const ne = res.vm.length;
	for (let e = 0; e < ne; e++) {
		const i = res.elems[3 * e], j = res.elems[3 * e + 1], k = res.elems[3 * e + 2];
		for (let c = 0; c < 8; c++) { const n = (i + (c & 1)) + NX * ((j + ((c >> 1) & 1)) + NY * (k + ((c >> 2) & 1))); ns[n] += res.vm[e]; cnt[n]++; }
	}
	for (let n = 0; n < nn; n++) if (cnt[n]) ns[n] /= cnt[n];
	const count = positions.length / 3, stress = new Float32Array(count), disp = new Float32Array(count * 3);
	for (let v = 0; v < count; v++) {
		const fx = (positions[3 * v] - origin[0]) / hx, fy = (positions[3 * v + 1] - origin[1]) / hy, fz = (positions[3 * v + 2] - origin[2]) / hz;
		const i = Math.max(0, Math.min(nx - 1, Math.floor(fx))), j = Math.max(0, Math.min(ny - 1, Math.floor(fy))), k = Math.max(0, Math.min(nz - 1, Math.floor(fz)));
		const tx = Math.max(0, Math.min(1, fx - i)), ty = Math.max(0, Math.min(1, fy - j)), tz = Math.max(0, Math.min(1, fz - k));
		let s = 0, ws = 0;
		for (let c = 0; c < 8; c++) {
			const a = c & 1, b = (c >> 1) & 1, d = (c >> 2) & 1;
			const n = (i + a) + NX * ((j + b) + NY * (k + d));
			if (!cnt[n]) continue;
			const w = (a ? tx : 1 - tx) * (b ? ty : 1 - ty) * (d ? tz : 1 - tz) + 1e-9;
			s += w * ns[n]; ws += w;
			for (let q = 0; q < 3; q++) disp[3 * v + q] += w * res.u[3 * n + q];
		}
		if (ws > 0) { stress[v] = s / ws; for (let q = 0; q < 3; q++) disp[3 * v + q] /= ws; }
	}
	let maxDisp = 0, maxDispAt = 0;
	for (let n = 0; n < nn; n++) { const d = Math.hypot(res.u[3 * n], res.u[3 * n + 1], res.u[3 * n + 2]); if (cnt[n] && d > maxDisp) { maxDisp = d; maxDispAt = n; } }
	const sorted = Float32Array.from(res.vm).sort();
	const peak = sorted[Math.max(0, Math.floor(sorted.length * 0.995) - 1)] || 0, max = sorted[sorted.length - 1] || 0;
	return { stress, disp, maxDisp, peak, max, maxDispAt };
}

/** Blue → green → yellow → red. */
export function stressColor(t) {
	const s = Math.max(0, Math.min(1, t));
	const stops = [[0, [0.13, 0.35, 0.95]], [0.33, [0.1, 0.8, 0.85]], [0.55, [0.25, 0.85, 0.25]], [0.78, [1, 0.85, 0.1]], [1, [0.95, 0.15, 0.1]]];
	for (let i = 1; i < stops.length; i++) if (s <= stops[i][0]) { const [a, ca] = stops[i - 1], [b, cb] = stops[i], f = (s - a) / (b - a); return ca.map((v, k) => v + (cb[k] - v) * f); }
	return stops[stops.length - 1][1];
}
