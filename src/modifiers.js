// Shape modifiers that work on the finished solid of a group: surface textures (knurl, ribs, bumps, …) and deforms
// (bend, twist, taper and a free-form lattice). Plain math on arrays plus the Manifold kernel (no three.js), so the
// same code runs on the main thread, in the background workers and in the lattice editor.

export const TEXTURES = {
	knurl: 'Knurl (diamond grip)',
	ribs: 'Ribs / grooves',
	waves: 'Waves',
	bumps: 'Bumps (dimples with negative depth)',
	hex: 'Hexagon ridges',
	noise: 'Organic (noise)',
};
export const TEXTURE_FACES = { all: 'All faces', sides: 'Sides only', top: 'Top only', bottom: 'Bottom only', topbottom: 'Top and bottom' };
export const TEXTURE_MAPS = { box: 'Box (flat faces)', cylinder: 'Cylinder (around Z, seamless)' };
export const TEXTURE_DEFAULTS = { pattern: 'knurl', size: 2, depth: 0.4, angle: 45, faces: 'all', mapping: 'box', detail: 0, seed: 1 };
export const DEFORM_DEFAULTS = { axis: 'z', bend: 0, bendDir: '+x', twist: 0, taper: 1, lattice: null, detail: 0 };

const MAX_TRIS = 1000000; // a texture never refines past this (the detail is coarsened instead)
const AX = { x: 0, y: 1, z: 2 };

/** The axes across a deform axis: [first, second]. */
export function crossAxes(axis) {
	const a = AX[axis] ?? 2;
	return a === 2 ? [0, 1] : a === 0 ? [1, 2] : [2, 0];
}

/** Bend directions that make sense for an axis, e.g. z → ['+x', '-x', '+y', '-y']. */
export function bendDirs(axis) {
	return crossAxes(axis).flatMap((i) => ['+' + 'xyz'[i], '-' + 'xyz'[i]]);
}

const binom = [[1], [1, 1], [1, 2, 1], [1, 3, 3, 1], [1, 4, 6, 4, 1]];
function bernstein(n, t, out) {
	// degree n - 1 basis at t, written to out[0..n-1]
	const d = n - 1, s = 1 - t;
	for (let i = 0; i < n; i++) out[i] = binom[d][i] * Math.pow(t, i) * Math.pow(s, d - i);
	return out;
}

/** Lattice point (i, j, k) at rest, in the group's frame. */
export function latticePoint(box, n, i, j, k) {
	const f = (a, idx) => (n[a] > 1 ? box.min[a] + ((box.max[a] - box.min[a]) * idx) / (n[a] - 1) : (box.min[a] + box.max[a]) / 2);
	return [f(0, i), f(1, j), f(2, k)];
}

/** A lattice with every point at rest: { n: [nx, ny, nz], d: [[dx, dy, dz] …] } (index i + nx·(j + ny·k)). */
export function emptyLattice(size) {
	const n = [size, size, size];
	return { n, d: Array.from({ length: size ** 3 }, () => [0, 0, 0]) };
}

/**
 * The deform as point functions over the group's frame: { lattice(p), rest(p), full(p), active }. box is the
 * undeformed solid's bounding box { min, max }. lattice moves points by the lattice offsets (free-form, Bézier);
 * rest applies taper, twist and bend along the axis; full is rest(lattice(p)).
 */
export function makeDeform(d, box) {
	const ax = AX[d.axis] ?? 2;
	const [ia, ib] = crossAxes(d.axis);
	const c = [0, 1, 2].map((i) => (box.min[i] + box.max[i]) / 2);
	const lo = box.min[ax], len = Math.max(1e-9, box.max[ax] - box.min[ax]);
	const taper = d.taper ?? 1, twist = ((d.twist || 0) * Math.PI) / 180, bend = ((d.bend || 0) * Math.PI) / 180;
	let bi = AX[(d.bendDir || '+x').slice(1)] ?? ia, sg = (d.bendDir || '+x')[0] === '-' ? -1 : 1;
	if (bi === ax) { bi = ia; sg = 1; }
	const L = d.lattice && d.lattice.n && d.lattice.d && d.lattice.d.some((v) => v[0] || v[1] || v[2]) ? d.lattice : null;
	const size = [0, 1, 2].map((i) => box.max[i] - box.min[i]);
	const bx = L ? new Float64Array(L.n[0]) : null, by = L ? new Float64Array(L.n[1]) : null, bz = L ? new Float64Array(L.n[2]) : null;
	const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
	const lattice = (p) => {
		if (!L) return p;
		const [nx, ny, nz] = L.n;
		bernstein(nx, size[0] > 1e-9 ? clamp01((p[0] - box.min[0]) / size[0]) : 0.5, bx);
		bernstein(ny, size[1] > 1e-9 ? clamp01((p[1] - box.min[1]) / size[1]) : 0.5, by);
		bernstein(nz, size[2] > 1e-9 ? clamp01((p[2] - box.min[2]) / size[2]) : 0.5, bz);
		let x = p[0], y = p[1], z = p[2];
		for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) {
			const wjk = by[j] * bz[k];
			if (!wjk) continue;
			for (let i = 0; i < nx; i++) {
				const v = L.d[i + nx * (j + ny * k)];
				if (!v) continue;
				const w = bx[i] * wjk;
				x += w * v[0]; y += w * v[1]; z += w * v[2];
			}
		}
		return [x, y, z];
	};
	const restOn = taper !== 1 || twist || bend;
	const rest = (p) => {
		if (!restOn) return p;
		const q = [p[0], p[1], p[2]];
		const t = (q[ax] - lo) / len;
		if (taper !== 1) {
			const k = 1 + (taper - 1) * t;
			q[ia] = c[ia] + (q[ia] - c[ia]) * k;
			q[ib] = c[ib] + (q[ib] - c[ib]) * k;
		}
		if (twist) {
			const a = twist * t, cs = Math.cos(a), sn = Math.sin(a);
			const u = q[ia] - c[ia], v = q[ib] - c[ib];
			q[ia] = c[ia] + u * cs - v * sn;
			q[ib] = c[ib] + u * sn + v * cs;
		}
		if (bend) {
			// bend the axis into an arc of the whole angle, curving toward bendDir
			const R = len / bend, u = sg * (q[bi] - c[bi]), s = q[ax] - lo, phi = s / R, r = R - u;
			q[bi] = c[bi] + sg * (R - r * Math.cos(phi));
			q[ax] = lo + r * Math.sin(phi);
		}
		return q;
	};
	return { lattice, rest, full: (p) => rest(lattice(p)), active: !!(L || restOn), restOn };
}

/** Undo rest(): the point that rest() moves to target (Newton steps with a numeric Jacobian). */
export function invertRest(rest, target, guess = target) {
	let q = guess.slice();
	const h = 1e-4;
	for (let it = 0; it < 20; it++) {
		const f = rest(q), e = [target[0] - f[0], target[1] - f[1], target[2] - f[2]];
		if (Math.hypot(e[0], e[1], e[2]) < 1e-7) break;
		const J = [0, 1, 2].map((k) => { const qq = q.slice(); qq[k] += h; const g = rest(qq); return [(g[0] - f[0]) / h, (g[1] - f[1]) / h, (g[2] - f[2]) / h]; }); // columns
		// solve J·dq = e (3×3, Cramer's rule)
		const m = (r, c) => J[c][r];
		const det = m(0, 0) * (m(1, 1) * m(2, 2) - m(1, 2) * m(2, 1)) - m(0, 1) * (m(1, 0) * m(2, 2) - m(1, 2) * m(2, 0)) + m(0, 2) * (m(1, 0) * m(2, 1) - m(1, 1) * m(2, 0));
		if (Math.abs(det) < 1e-12) break;
		const col = (k, v) => [0, 1, 2].map((r) => [0, 1, 2].map((cc) => (cc === k ? v[r] : m(r, cc))));
		const d3 = (A) => A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1]) - A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0]) + A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]);
		q = q.map((v, k) => v + d3(col(k, e)) / det);
	}
	return q;
}

// ---------------------------------------------------------------- texture patterns (height 0..1)

const frac = (x) => x - Math.floor(x);
const tri = (x) => 1 - Math.abs(2 * frac(x) - 1); // 0 at whole numbers, 1 halfway
const SQ3 = Math.sqrt(3);

function hexOffset(u, v, s) {
	// offset from the nearest point of a triangular lattice with spacing s (the centers of hexagonal cells)
	const fy = v / (s * SQ3 / 2), fx = u / s - fy / 2;
	const i0 = Math.floor(fx), j0 = Math.floor(fy);
	let best = Infinity, bu = 0, bv = 0;
	for (let di = 0; di <= 1; di++) for (let dj = 0; dj <= 1; dj++) {
		const i = i0 + di, j = j0 + dj;
		const cu = (i + j / 2) * s, cv = j * s * SQ3 / 2;
		const d = (u - cu) ** 2 + (v - cv) ** 2;
		if (d < best) { best = d; bu = u - cu; bv = v - cv; }
	}
	return [bu, bv];
}

function hash3(x, y, z, seed) {
	let h = (x * 374761393 + y * 668265263 + z * 2147483647 + seed * 144269504) | 0;
	h = Math.imul(h ^ (h >>> 13), 1274126177);
	return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function valueNoise(x, y, z, seed) {
	const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
	const sm = (t) => t * t * (3 - 2 * t);
	const tx = sm(x - x0), ty = sm(y - y0), tz = sm(z - z0);
	let out = 0;
	for (let k = 0; k <= 1; k++) for (let j = 0; j <= 1; j++) for (let i = 0; i <= 1; i++) {
		out += hash3(x0 + i, y0 + j, z0 + k, seed) * (i ? tx : 1 - tx) * (j ? ty : 1 - ty) * (k ? tz : 1 - tz);
	}
	return out;
}

/** Pattern height (0..1) at surface coordinates (u, v) for the flat patterns. */
function pattern2(t, u, v) {
	const s = Math.max(1e-3, t.size), a = ((t.angle ?? 0) * Math.PI) / 180;
	switch (t.pattern) {
		case 'knurl': {
			// two sets of crossing V-grooves; the ridges meet in diamonds
			const k = Math.tan(Math.min(Math.max(a, 0.09), 1.48));
			return Math.min(tri((u + v / k) / s), tri((u - v / k) / s));
		}
		case 'ribs': return tri((u * Math.cos(a) + v * Math.sin(a)) / s);
		case 'waves': return 0.5 + 0.5 * Math.sin((2 * Math.PI * (u * Math.cos(a) + v * Math.sin(a))) / s);
		case 'bumps': {
			const [du, dv] = hexOffset(u, v, s), r = 0.42 * s, d2 = (du * du + dv * dv) / (r * r);
			return d2 < 1 ? Math.sqrt(1 - d2) : 0;
		}
		case 'hex': {
			const [du, dv] = hexOffset(u, v, s);
			let m = 0;
			for (let k = 0; k < 3; k++) { const ang = (k * Math.PI) / 3; m = Math.max(m, Math.abs(du * Math.cos(ang) + dv * Math.sin(ang))); }
			const edge = s / 2 - m, w = 0.14 * s;
			const x = Math.min(1, Math.max(0, 1 - edge / w));
			return x * x * (3 - 2 * x);
		}
		default: return 0;
	}
}

/**
 * Height of the texture (0..1) at a surface point p with normal n. ctx: { box, R (reference radius), wraps }.
 */
export function textureHeight(t, p, n, ctx) {
	const { box } = ctx;
	const x = p[0] - box.min[0], y = p[1] - box.min[1], z = p[2] - box.min[2];
	if (t.pattern === 'noise') {
		const s = Math.max(1e-3, t.size), seed = t.seed || 1;
		let h = 0, amp = 0.5, f = 1 / s, tot = 0;
		for (let o = 0; o < 3; o++) { h += amp * valueNoise(x * f, y * f, z * f, seed + o * 17); tot += amp; amp *= 0.5; f *= 2.03; }
		return Math.min(1, Math.max(0, (h / tot - 0.25) / 0.5));
	}
	if (t.mapping === 'cylinder') {
		// around the vertical axis through the box center; the pattern repeats a whole number of times around
		const cx = (box.min[0] + box.max[0]) / 2, cy = (box.min[1] + box.max[1]) / 2;
		const ang = Math.atan2(p[1] - cy, p[0] - cx);
		const u = (ang / (2 * Math.PI)) * ctx.wraps * t.size;
		const wz = Math.min(1, Math.abs(n[2]) ** 4 * 1.2);
		const side = pattern2(t, u, z);
		return wz > 0.001 ? (1 - wz) * side + wz * pattern2(t, x, y) : side;
	}
	// box: each face takes the pattern from the plane it faces most (blended where it turns)
	const ax = Math.abs(n[0]) ** 4, ay = Math.abs(n[1]) ** 4, az = Math.abs(n[2]) ** 4, sum = ax + ay + az || 1;
	let h = 0;
	if (ax > 1e-3) h += (ax / sum) * pattern2(t, y, z);
	if (ay > 1e-3) h += (ay / sum) * pattern2(t, x, z);
	if (az > 1e-3) h += (az / sum) * pattern2(t, x, y);
	return h;
}

/** How much a face with normal z-component nz takes the texture (0..1), by the "apply to" choice. */
function faceWeight(faces, nz) {
	const ramp = (v, a, b) => Math.min(1, Math.max(0, (v - a) / (b - a)));
	switch (faces) {
		case 'sides': return ramp(-Math.abs(nz), -0.8, -0.55);
		case 'top': return ramp(nz, 0.55, 0.8);
		case 'bottom': return ramp(-nz, 0.55, 0.8);
		case 'topbottom': return ramp(Math.abs(nz), 0.55, 0.8);
		default: return 1;
	}
}

/** Edge length a texture refines to (mm), coarsened so the result stays under MAX_TRIS. */
export function textureDetail(t, area) {
	// fine features (thin hexagon walls, round bumps) need more points per repeat than smooth ones
	const per = t.pattern === 'hex' ? 16 : t.pattern === 'bumps' ? 11 : 8;
	let L = t.detail > 0 ? t.detail : Math.max(0.05, Math.abs(t.size) / per);
	if (area > 0) L = Math.max(L, Math.sqrt(area / (0.433 * MAX_TRIS)));
	return L;
}

// ---------------------------------------------------------------- applying to a Manifold

/**
 * The modified solid as a new Manifold (the input is left alone). mod: { kind: 'texture' | 'deform', box, … }.
 */
export function applyModifier(MF, m, mod) {
	if (mod.kind === 'texture') return applyTexture(MF, m, mod);
	if (mod.kind === 'deform') return applyDeform(MF, m, mod);
	throw new Error('unknown modifier ' + mod.kind);
}

function applyTexture(MF, m, t) {
	if (!t.depth || !(t.size > 0)) return m.translate([0, 0, 0]);
	const L = textureDetail(t, m.surfaceArea());
	const fine = m.refineToLength(L);
	let mesh;
	try { mesh = fine.getMesh(); } finally { fine.delete(); }
	const np = mesh.numProp || 3, V = mesh.vertProperties, I = mesh.triVerts;
	const nv = V.length / np, T = I.length / 3;
	const P = new Float64Array(nv * 3);
	for (let i = 0; i < nv; i++) { P[3 * i] = V[np * i]; P[3 * i + 1] = V[np * i + 1]; P[3 * i + 2] = V[np * i + 2]; }
	// area-weighted vertex normals of the textured faces only (so where a textured face meets a plain one, the edge
	// moves along the textured face and the plain face stays flat), and "apply to" weights
	const N = new Float64Array(nv * 3), W = new Float64Array(nv), A = new Float64Array(nv);
	for (let f = 0; f < T; f++) {
		const a = I[3 * f], b = I[3 * f + 1], c = I[3 * f + 2];
		const ux = P[3 * b] - P[3 * a], uy = P[3 * b + 1] - P[3 * a + 1], uz = P[3 * b + 2] - P[3 * a + 2];
		const vx = P[3 * c] - P[3 * a], vy = P[3 * c + 1] - P[3 * a + 1], vz = P[3 * c + 2] - P[3 * a + 2];
		const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx, ar = Math.hypot(x, y, z);
		if (!(ar > 0)) continue;
		const w = faceWeight(t.faces, z / ar);
		for (const v of [a, b, c]) { N[3 * v] += w * x; N[3 * v + 1] += w * y; N[3 * v + 2] += w * z; W[v] += w * ar; A[v] += ar; }
	}
	const box = t.box || (() => { const bb = m.boundingBox(); return { min: bb.min, max: bb.max }; })();
	const R = Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1]) / 2;
	const ctx = { box, wraps: Math.max(1, Math.round((2 * Math.PI * R) / t.size)) };
	const out = new Float32Array(nv * 3);
	const p = [0, 0, 0], n = [0, 0, 0];
	for (let i = 0; i < nv; i++) {
		p[0] = P[3 * i]; p[1] = P[3 * i + 1]; p[2] = P[3 * i + 2];
		const w = A[i] > 0 ? W[i] / A[i] : 0;
		let d = 0;
		if (w > 1e-6) {
			const l = Math.hypot(N[3 * i], N[3 * i + 1], N[3 * i + 2]) || 1;
			n[0] = N[3 * i] / l; n[1] = N[3 * i + 1] / l; n[2] = N[3 * i + 2] / l;
			d = t.depth * w * textureHeight(t, p, n, ctx);
		}
		out[3 * i] = p[0] + n[0] * d; out[3 * i + 1] = p[1] + n[1] * d; out[3 * i + 2] = p[2] + n[2] * d;
	}
	const res = new MF.Manifold(new MF.Mesh({ numProp: 3, vertProperties: out, triVerts: new Uint32Array(I) }));
	if (res.status() !== 'NoError') { const st = res.status(); res.delete(); throw new Error('Texture made an invalid solid: ' + st); }
	// flat areas the texture didn't touch go back to a few big triangles
	try { const s = res.simplify(0.0005); res.delete(); return s; } catch (e) { return res; }
}

function applyDeform(MF, m, d) {
	const box = d.box || (() => { const bb = m.boundingBox(); return { min: bb.min, max: bb.max }; })();
	const f = makeDeform(d, box);
	if (!f.active) return m.translate([0, 0, 0]);
	const size = [0, 1, 2].map((i) => box.max[i] - box.min[i]);
	const segs = d.detail > 0 ? d.detail : 48;
	let L = Math.max(...size) / segs;
	const area = m.surfaceArea();
	L = Math.max(L, Math.sqrt(area / (0.433 * MAX_TRIS)), 0.02);
	const fine = m.refineToLength(L);
	let res;
	try {
		res = fine.warpBatch((v, count) => {
			for (let i = 0; i < count; i++) {
				const q = f.full([v[3 * i], v[3 * i + 1], v[3 * i + 2]]);
				v[3 * i] = q[0]; v[3 * i + 1] = q[1]; v[3 * i + 2] = q[2];
			}
		});
	} finally { fine.delete(); }
	try { const s = res.simplify(0.001); res.delete(); return s; } catch (e) { return res; }
}
