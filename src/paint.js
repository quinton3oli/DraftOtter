// Painting colors onto faces of a part (for multi-color / AMS printing). A paint stroke is stored on the part as a
// seed — a point on the surface, its normal and a color, in the part's own coordinates — and re-found on the current
// shape every time it is drawn, so paint follows edits: the face nearest the seed (facing the same way) is filled.
//
// What "a face" is: a flat face is every connected triangle in its plane. On a curved surface (cylinder side, fillet,
// sphere) it is the smooth patch of similar-sized facets reached without crossing a crease; big flat faces next to a
// rounded edge are left out, so filling a fillet doesn't spill onto the faces it rounds.
import * as THREE from 'three';
import { weld } from './meshutil.js';
import { nodeMatrix } from './engine.js';

const COS_CREASE = Math.cos((25 * Math.PI) / 180);
const topoCache = new WeakMap(); // geometry -> triangle topology
const colorCache = new WeakMap(); // geometry -> Map(paint signature -> per-triangle colors)

/** Triangles, normals, areas, neighbors and flat-face groups of a (non-indexed or indexed) geometry. */
function topology(geom) {
	let t = topoCache.get(geom);
	if (t) return t;
	const pos = geom.attributes.position.array, idx = geom.index ? geom.index.array : null;
	const w = weld(pos, idx, 1e-4);
	const NV = w.count, nT = w.ids.length / 3;
	const V = w.verts, ids = w.ids;
	const N = new Float64Array(nT * 3), A = new Float64Array(nT), D = new Float64Array(nT), ok = new Uint8Array(nT);
	for (let i = 0; i < nT; i++) {
		const a = ids[3 * i] * 3, b = ids[3 * i + 1] * 3, c = ids[3 * i + 2] * 3;
		if (a === b || b === c || a === c) continue;
		const ux = V[b] - V[a], uy = V[b + 1] - V[a + 1], uz = V[b + 2] - V[a + 2];
		const vx = V[c] - V[a], vy = V[c + 1] - V[a + 1], vz = V[c + 2] - V[a + 2];
		let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
		const l = Math.hypot(nx, ny, nz);
		if (l < 1e-12) continue;
		nx /= l; ny /= l; nz /= l;
		N[3 * i] = nx; N[3 * i + 1] = ny; N[3 * i + 2] = nz;
		A[i] = l / 2;
		D[i] = nx * V[a] + ny * V[a + 1] + nz * V[a + 2];
		ok[i] = 1;
	}
	// triangles sharing each edge
	const edges = new Map();
	for (let i = 0; i < nT; i++) {
		if (!ok[i]) continue;
		for (let k = 0; k < 3; k++) {
			const p = ids[3 * i + k], q = ids[3 * i + ((k + 1) % 3)];
			const key = p < q ? p * NV + q : q * NV + p;
			const l = edges.get(key);
			if (l) l.push(i); else edges.set(key, [i]);
		}
	}
	const nbr = new Array(nT);
	for (let i = 0; i < nT; i++) nbr[i] = [];
	for (const l of edges.values()) for (const i of l) for (const j of l) if (i !== j) nbr[i].push(j);
	const dot = (i, j) => N[3 * i] * N[3 * j] + N[3 * i + 1] * N[3 * j + 1] + N[3 * i + 2] * N[3 * j + 2];
	// flat-face groups: connected triangles in one plane
	const group = new Int32Array(nT).fill(-1), gArea = [];
	for (let s = 0; s < nT; s++) {
		if (!ok[s] || group[s] >= 0) continue;
		const g = gArea.length;
		let area = 0;
		const st = [s];
		group[s] = g;
		while (st.length) {
			const i = st.pop();
			area += A[i];
			for (const j of nbr[i]) if (group[j] < 0 && ok[j] && dot(i, j) > 1 - 1e-6 && Math.abs(D[j] - D[s]) < 1e-3) { group[j] = g; st.push(j); }
		}
		gArea.push(area);
	}
	const members = gArea.map(() => []);
	for (let i = 0; i < nT; i++) if (group[i] >= 0) members[group[i]].push(i);
	t = { nT, V, ids, N, A, ok, nbr, group, gArea, members, dot };
	topoCache.set(geom, t);
	return t;
}

/** The triangles of the face that triangle `seed` belongs to (see the note at the top). */
export function faceTriangles(geom, seed) {
	const t = topology(geom);
	if (seed < 0 || seed >= t.nT || !t.ok[seed]) return [];
	const { nbr, group, gArea, dot } = t;
	const g0 = group[seed], a0 = gArea[g0];
	// flat face: no smooth neighbors, or it is much bigger than the facets around it (a face next to a fillet)
	let nMax = 0;
	const members = t.members[g0];
	for (const i of members) for (const j of nbr[i]) if (group[j] !== g0 && dot(i, j) > COS_CREASE) nMax = Math.max(nMax, gArea[group[j]]);
	if (!nMax || a0 > 3 * nMax) return members;
	// curved: spread over smooth neighbors, skipping big flat faces
	const limit = 4 * Math.max(a0, nMax);
	const inG = new Set([g0]), out = [...members], st = [...members];
	while (st.length) {
		const i = st.pop();
		for (const j of nbr[i]) {
			const gj = group[j];
			if (inG.has(gj) || dot(i, j) <= COS_CREASE || gArea[gj] > limit) continue;
			inG.add(gj);
			for (const k of t.members[gj]) { out.push(k); st.push(k); }
		}
	}
	return out;
}

const _tri = new THREE.Triangle(), _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _p = new THREE.Vector3(), _q = new THREE.Vector3();
/** The triangle nearest a seed point among those facing roughly the seed's way (-1 when there is none). */
export function seedTriangle(geom, p, n) {
	const t = topology(geom), { V, ids, N } = t;
	_p.set(p[0], p[1], p[2]);
	let best = -1, bestD = Infinity;
	for (let i = 0; i < t.nT; i++) {
		if (!t.ok[i] || N[3 * i] * n[0] + N[3 * i + 1] * n[1] + N[3 * i + 2] * n[2] < 0.9) continue;
		const a = ids[3 * i] * 3, b = ids[3 * i + 1] * 3, c = ids[3 * i + 2] * 3;
		_tri.set(_a.set(V[a], V[a + 1], V[a + 2]), _b.set(V[b], V[b + 1], V[b + 2]), _c.set(V[c], V[c + 1], V[c + 2]));
		const d = _tri.closestPointToPoint(_p, _q).distanceToSquared(_p);
		if (d < bestD) { bestD = d; best = i; }
	}
	return best;
}

/**
 * All the paint that shows on a part: its own strokes plus those of everything inside it (a painted part that gets
 * grouped, filleted, push/pulled or made symmetric keeps its colors), carried into the part's frame. Inner strokes
 * come first so the part's own strokes paint over them. Each stroke keeps a reference to where it is stored.
 */
export function effectivePaint(node) {
	const out = [];
	const walk = (n, M) => {
		for (const c of n.children || []) {
			if (c.hole) continue;
			const Mc = M.clone().multiply(nodeMatrix(c));
			walk(c, Mc);
			if (!c.paint || !c.paint.length) continue;
			const nm = new THREE.Matrix3().getNormalMatrix(Mc);
			for (const s of c.paint) {
				const p = new THREE.Vector3(...s.p).applyMatrix4(Mc), q = new THREE.Vector3(...s.n).applyMatrix3(nm).normalize();
				out.push({ p: p.toArray(), n: q.toArray(), c: s.c, owner: c, stroke: s });
			}
		}
	};
	walk(node, new THREE.Matrix4());
	for (const s of node.paint || []) out.push({ ...s, owner: node, stroke: s });
	return out;
}

const plain = (paint) => paint.map(({ p, n, c }) => ({ p, n, c }));

/** Per-triangle paint colors of a part's shape (null where unpainted). Later strokes cover earlier ones. */
export function triangleColors(geom, paint) {
	if (!geom || !geom.attributes.position || !paint || !paint.length) return null;
	const sig = JSON.stringify(plain(paint));
	let m = colorCache.get(geom);
	if (!m) colorCache.set(geom, (m = new Map()));
	if (m.has(sig)) return m.get(sig);
	const t = topology(geom), cols = new Array(t.nT).fill(null);
	for (const s of paint) {
		const seed = seedTriangle(geom, s.p, s.n);
		if (seed < 0) continue;
		for (const i of faceTriangles(geom, seed)) cols[i] = s.c;
	}
	if (m.size > 8) m.clear();
	m.set(sig, cols);
	return cols;
}

/** A copy of the shape with a vertex color per corner (paint, or the part color), for drawing it painted. */
export function paintedGeometry(geom, node) {
	const cols = triangleColors(geom, effectivePaint(node));
	if (!cols) return null;
	const g = geom.index ? geom.toNonIndexed() : geom.clone();
	const n = g.attributes.position.count, arr = new Float32Array(n * 3);
	const base = new THREE.Color(node.color || '#cccccc'), c = new THREE.Color(), seen = new Map();
	for (let i = 0; i < n / 3; i++) {
		const hex = cols[i];
		let col = base;
		if (hex) { col = seen.get(hex); if (!col) { col = c.clone().set(hex); seen.set(hex, col); } }
		for (let k = 0; k < 3; k++) { arr[9 * i + 3 * k] = col.r; arr[9 * i + 3 * k + 1] = col.g; arr[9 * i + 3 * k + 2] = col.b; }
	}
	g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
	return g;
}

/**
 * Paint colors for an exported mesh of the part (world positions, non-indexed; `toLocal` takes world to the part's
 * own coordinates): each exported triangle takes the color of the shape's triangle it lies on. Faces made by
 * cutting (holes) stay unpainted. Returns an array with a color or null per triangle, or null without paint.
 */
export function exportColors(geom, node, positions, toLocal) {
	const cols = triangleColors(geom, effectivePaint(node));
	if (!cols) return null;
	if (!geom.boundsTree) geom.computeBoundsTree();
	const t = topology(geom), N = t.N;
	const out = new Array(positions.length / 9).fill(null), hit = {};
	const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), cen = new THREE.Vector3(), nrm = new THREE.Vector3();
	for (let i = 0; i < out.length; i++) {
		a.fromArray(positions, 9 * i).applyMatrix4(toLocal);
		b.fromArray(positions, 9 * i + 3).applyMatrix4(toLocal);
		c.fromArray(positions, 9 * i + 6).applyMatrix4(toLocal);
		cen.copy(a).add(b).add(c).divideScalar(3);
		nrm.copy(b).sub(a).cross(c.clone().sub(a));
		if (nrm.lengthSq() < 1e-18) continue;
		nrm.normalize();
		const r = geom.boundsTree.closestPointToPoint(cen, hit);
		if (!r || r.distance > 0.05) continue;
		const f = r.faceIndex;
		if (cols[f] && N[3 * f] * nrm.x + N[3 * f + 1] * nrm.y + N[3 * f + 2] * nrm.z > 0.8) out[i] = cols[f];
	}
	return out;
}
