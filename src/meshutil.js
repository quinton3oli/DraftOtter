// Fast mesh helpers on typed arrays (no string keys): welding duplicate vertices, and the sharp-edge lines drawn
// over parts. Used by the kernel bridge (toManifold), edge and face picking, and the viewport.

const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
const bitsOf = (x) => { f32[0] = x + 0; return u32[0]; }; // + 0 folds -0 into 0

/**
 * Weld a non-indexed (or indexed) triangle mesh. With quantum = 0, vertices merge only when their coordinates are
 * exactly equal; otherwise when they round to the same multiple of quantum. Optional 4×4 matrix (column-major
 * elements) is applied first. Returns { verts: Float64Array (x,y,z per vertex), count, ids: Uint32Array (vertex per
 * triangle corner) }.
 */
export function weld(pos, index = null, quantum = 0, m = null) {
	const corners = index ? index.length : pos.length / 3;
	let size = 1;
	while (size < corners * 2) size <<= 1;
	const table = new Int32Array(size).fill(-1), mask = size - 1;
	const keys = quantum ? new Float64Array(corners * 3) : new Uint32Array(corners * 3);
	const verts = new Float64Array(corners * 3), ids = new Uint32Array(corners);
	let count = 0;
	for (let c = 0; c < corners; c++) {
		const i = (index ? index[c] : c) * 3;
		let x = pos[i], y = pos[i + 1], z = pos[i + 2];
		if (m) {
			const X = m[0] * x + m[4] * y + m[8] * z + m[12], Y = m[1] * x + m[5] * y + m[9] * z + m[13], Z = m[2] * x + m[6] * y + m[10] * z + m[14];
			x = X; y = Y; z = Z;
		}
		let a, b, d;
		if (quantum) { a = Math.round(x / quantum); b = Math.round(y / quantum); d = Math.round(z / quantum); }
		else { a = bitsOf(x); b = bitsOf(y); d = bitsOf(z); }
		let h = (Math.imul(a | 0, 73856093) ^ Math.imul(b | 0, 19349663) ^ Math.imul(d | 0, 83492791)) & mask;
		for (;;) {
			const v = table[h];
			if (v < 0) {
				table[h] = count;
				keys[3 * count] = a; keys[3 * count + 1] = b; keys[3 * count + 2] = d;
				verts[3 * count] = x; verts[3 * count + 1] = y; verts[3 * count + 2] = z;
				ids[c] = count++;
				break;
			}
			if (keys[3 * v] === a && keys[3 * v + 1] === b && keys[3 * v + 2] === d) { ids[c] = v; break; }
			h = (h + 1) & mask;
		}
	}
	return { verts: verts.subarray(0, count * 3), count, ids };
}

/**
 * Map from an undirected edge (two vertex ids) to the triangles using it, on numbers instead of strings.
 * Returns { get(a, b) -> number[] | undefined, entries() -> iterator of [a, b, tris] }.
 */
export function edgeMap(ids, nverts) {
	const map = new Map();
	const tri = ids.length / 3;
	for (let t = 0; t < tri; t++) {
		for (let k = 0; k < 3; k++) {
			const p = ids[3 * t + k], q = ids[3 * t + ((k + 1) % 3)];
			if (p === q) continue;
			const key = p < q ? p * nverts + q : q * nverts + p;
			const l = map.get(key);
			if (l) l.push(t); else map.set(key, [t]);
		}
	}
	return {
		get: (a, b) => map.get(a < b ? a * nverts + b : b * nverts + a),
		*entries() { for (const [k, v] of map) yield [Math.floor(k / nverts), k % nverts, v]; },
		map,
	};
}

/**
 * Line segments along sharp edges (faces meeting at more than angleDeg) and open borders, like three.js
 * EdgesGeometry but without string hashing. Returns a Float32Array of segment end points.
 */
export function sharpEdges(pos, index = null, angleDeg = 28) {
	const { verts, count, ids } = weld(pos, index, 1e-4);
	const T = ids.length / 3, N = new Float64Array(T * 3), ok = new Uint8Array(T);
	for (let t = 0; t < T; t++) {
		const a = ids[3 * t] * 3, b = ids[3 * t + 1] * 3, c = ids[3 * t + 2] * 3;
		if (a === b || b === c || a === c) continue;
		const ux = verts[b] - verts[a], uy = verts[b + 1] - verts[a + 1], uz = verts[b + 2] - verts[a + 2];
		const vx = verts[c] - verts[a], vy = verts[c + 1] - verts[a + 1], vz = verts[c + 2] - verts[a + 2];
		const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx, l = Math.hypot(x, y, z);
		if (!(l > 0)) continue;
		N[3 * t] = x / l; N[3 * t + 1] = y / l; N[3 * t + 2] = z / l; ok[t] = 1;
	}
	const cos = Math.cos((angleDeg * Math.PI) / 180);
	const out = [];
	const em = edgeMap(ids, count);
	for (const [a, b, tris] of em.entries()) {
		const live = tris.filter((t) => ok[t]);
		let sharp = live.length === 1;
		if (live.length === 2) { const [s, t] = live; sharp = N[3 * s] * N[3 * t] + N[3 * s + 1] * N[3 * t + 1] + N[3 * s + 2] * N[3 * t + 2] <= cos; }
		if (sharp) out.push(verts[3 * a], verts[3 * a + 1], verts[3 * a + 2], verts[3 * b], verts[3 * b + 1], verts[3 * b + 2]);
	}
	return new Float32Array(out);
}
