// Sculpting core: an indexed triangle mesh with neighbor lists, Blender-style brushes (draw, clay, inflate, smooth,
// flatten, pinch, crease, grab), mirror symmetry, and per-stroke undo. Works in the part's own frame (mm). The
// geometry is a three.js BufferGeometry with a BVH, so finding the surface under the cursor and the vertices
// under a brush stays fast on large meshes.
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

export const BRUSHES = {
	draw: { label: 'Draw', key: '1', tip: 'Raise the surface (Ctrl: dig in)' },
	clay: { label: 'Clay', key: '2', tip: 'Build up in flat layers, like adding clay (Ctrl: carve)' },
	inflate: { label: 'Inflate', key: '3', tip: 'Puff the surface outward along its own direction (Ctrl: deflate)' },
	smooth: { label: 'Smooth', key: '4', tip: 'Even out bumps (also: hold Shift with any brush)' },
	flatten: { label: 'Flatten', key: '5', tip: 'Press the surface flat' },
	pinch: { label: 'Pinch', key: '6', tip: 'Pull the surface toward the brush center (Ctrl: spread)' },
	crease: { label: 'Crease', key: '7', tip: 'Cut a sharp groove (Ctrl: sharp ridge)' },
	grab: { label: 'Grab', key: '8', tip: 'Drag a region of the surface around' },
};

export const FALLOFFS = { smooth: 'Smooth', sphere: 'Sphere', sharp: 'Sharp', constant: 'Constant' };

/** Brush weight at distance t = d / r (0..1). */
export function falloff(kind, t) {
	if (t >= 1) return 0;
	switch (kind) {
		case 'constant': return 1;
		case 'sphere': return Math.sqrt(1 - t * t);
		case 'sharp': return (1 - t) * (1 - t);
		default: { const s = 1 - t; return s * s * (3 - 2 * s); } // smooth
	}
}

export class SculptSession {
	/** positions: Float32Array (x y z per vertex), index: Uint32Array (3 per triangle). */
	constructor(positions, index) {
		this.pos = positions;
		this.idx = index;
		this.nv = positions.length / 3;
		this.nt = index.length / 3;
		const g = (this.geometry = new THREE.BufferGeometry());
		g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
		g.setIndex(new THREE.BufferAttribute(this.idx, 1));
		this.nrm = new Float32Array(this.pos.length);
		g.setAttribute('normal', new THREE.BufferAttribute(this.nrm, 3));
		// the BVH reorders the triangles in place, so it comes first and everything else uses its order
		g.boundsTree = new MeshBVH(g);
		this.buildTopology();
		this.computeNormals();
		g.computeBoundingBox();
		g.computeBoundingSphere();
		this.undoStack = [];
		this.redoStack = [];
		this.stroke = null;
		this.stale = 0; // how far vertices may have moved since the BVH was last fitted (mm)
		// the center that symmetry mirrors about: the middle of the part as it started
		const b = g.boundingBox;
		this.symCenter = [(b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2];
	}

	/** Neighbor vertices and the triangles around each vertex (compressed lists). */
	buildTopology() {
		const { nv, nt, idx } = this;
		const tcount = new Uint32Array(nv + 1);
		for (let i = 0; i < idx.length; i++) tcount[idx[i] + 1]++;
		for (let i = 0; i < nv; i++) tcount[i + 1] += tcount[i];
		const vt = new Uint32Array(idx.length), fill = tcount.slice(0, nv);
		for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) vt[fill[idx[3 * t + k]]++] = t;
		this.vtStart = tcount; this.vt = vt;
		// neighbors: the other corners of each vertex's triangles, without repeats
		const nstart = new Uint32Array(nv + 1), tmp = [];
		const list = [];
		for (let v = 0; v < nv; v++) {
			tmp.length = 0;
			for (let j = tcount[v]; j < tcount[v + 1]; j++) {
				const t = vt[j];
				for (let k = 0; k < 3; k++) { const u = idx[3 * t + k]; if (u !== v && !tmp.includes(u)) tmp.push(u); }
			}
			nstart[v + 1] = nstart[v] + tmp.length;
			for (const u of tmp) list.push(u);
		}
		this.nbStart = nstart; this.nb = Uint32Array.from(list);
	}

	/** Vertex normals (area-weighted), for all vertices or just the given ones. */
	computeNormals(ids = null) {
		const { pos, idx, nrm } = this;
		const faceN = (t, out) => {
			const a = 3 * idx[3 * t], b = 3 * idx[3 * t + 1], c = 3 * idx[3 * t + 2];
			const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
			const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
			out[0] = uy * vz - uz * vy; out[1] = uz * vx - ux * vz; out[2] = ux * vy - uy * vx;
		};
		const n = [0, 0, 0];
		const one = (v) => {
			let x = 0, y = 0, z = 0;
			for (let j = this.vtStart[v]; j < this.vtStart[v + 1]; j++) { faceN(this.vt[j], n); x += n[0]; y += n[1]; z += n[2]; }
			const l = Math.hypot(x, y, z) || 1;
			nrm[3 * v] = x / l; nrm[3 * v + 1] = y / l; nrm[3 * v + 2] = z / l;
		};
		if (ids) {
			// moved vertices change their neighbors' normals too
			const seen = new Set();
			for (const v of ids) { seen.add(v); for (let j = this.nbStart[v]; j < this.nbStart[v + 1]; j++) seen.add(this.nb[j]); }
			for (const v of seen) one(v);
		} else for (let v = 0; v < this.nv; v++) one(v);
		this.geometry.attributes.normal.needsUpdate = true;
	}

	/** Vertices within r of center: [ids], using the BVH (bounds a little loose during a stroke, so pad them). */
	verticesNear(center, r) {
		// the BVH is refitted only now and then during a stroke, so its boxes may lag the surface by up to `stale`
		const out = [], seen = new Set(), c = new THREE.Vector3(...center), r2 = r * r, pad = this.stale + 1e-6;
		const { pos, idx } = this;
		this.geometry.boundsTree.shapecast({
			intersectsBounds: (box) => box.distanceToPoint(c) <= r + pad,
			intersectsTriangle: (tri, t) => {
				for (let k = 0; k < 3; k++) {
					const v = idx[3 * t + k];
					if (seen.has(v)) continue;
					seen.add(v);
					const dx = pos[3 * v] - c.x, dy = pos[3 * v + 1] - c.y, dz = pos[3 * v + 2] - c.z;
					if (dx * dx + dy * dy + dz * dz <= r2) out.push(v);
				}
				return false;
			},
		});
		return out;
	}

	/** First hit of a ray (in the part's frame): { point, normal, face } or null. */
	raycast(ray) {
		const hit = this.geometry.boundsTree.raycastFirst(ray, THREE.DoubleSide);
		if (!hit) return null;
		const t = hit.faceIndex, n = [0, 0, 0];
		for (let k = 0; k < 3; k++) { const v = this.idx[3 * t + k]; n[0] += this.nrm[3 * v]; n[1] += this.nrm[3 * v + 1]; n[2] += this.nrm[3 * v + 2]; }
		const l = Math.hypot(...n) || 1;
		return { point: hit.point.toArray(), normal: n.map((x) => x / l), face: t };
	}

	// ------------------------------------------------------------ strokes

	beginStroke(brush, opts = {}) {
		this.stroke = { brush, before: new Map(), touched: new Set(), opts };
		this.redoStack.length = 0;
	}

	/** Remember a vertex's position before the stroke first moves it (for undo). */
	keep(v) {
		const b = this.stroke.before;
		if (!b.has(v)) b.set(v, [this.pos[3 * v], this.pos[3 * v + 1], this.pos[3 * v + 2]]);
		this.stroke.touched.add(v);
	}

	/** Mirrored copies of a point / direction for the active symmetry axes: [[point, dir, flips]]. */
	mirrors(p, d, sym) {
		const out = [[p, d, [1, 1, 1]]];
		const c = this.symCenter;
		for (let a = 0; a < 3; a++) {
			if (!sym || !sym[a]) continue;
			const n = out.length;
			for (let i = 0; i < n; i++) {
				const [q, e, f] = out[i];
				const q2 = q.slice(), e2 = e ? e.slice() : null, f2 = f.slice();
				q2[a] = 2 * c[a] - q[a]; if (e2) e2[a] = -e2[a]; f2[a] = -f2[a];
				out.push([q2, e2, f2]);
			}
		}
		return out;
	}

	/**
	 * One brush dab at a surface point. o: { radius (mm), strength (0..1), falloff, invert, symmetry: [x, y, z] }.
	 * Returns the vertices it moved.
	 */
	dab(brush, center, o) {
		const moved = [];
		for (const [c] of this.mirrors(center, null, o.symmetry)) moved.push(...this.dabOne(brush, c, o));
		// refit (a full pass over the BVH) only once the surface has drifted noticeably from it
		if (this.stale > o.radius * 0.75) this.refit();
		return moved;
	}

	dabOne(brush, c, o) {
		const r = o.radius, ids = this.verticesNear(c, r);
		if (!ids.length) return ids;
		const { pos, nrm } = this, w = new Float32Array(ids.length);
		const sign = o.invert ? -1 : 1, s = Math.max(0, Math.min(1, o.strength));
		// the area under the brush: its average direction and center
		let nx = 0, ny = 0, nz = 0, cx = 0, cy = 0, cz = 0, ws = 0;
		ids.forEach((v, i) => {
			const d = Math.hypot(pos[3 * v] - c[0], pos[3 * v + 1] - c[1], pos[3 * v + 2] - c[2]);
			w[i] = falloff(o.falloff, d / r);
			nx += nrm[3 * v] * w[i]; ny += nrm[3 * v + 1] * w[i]; nz += nrm[3 * v + 2] * w[i];
			cx += pos[3 * v] * w[i]; cy += pos[3 * v + 1] * w[i]; cz += pos[3 * v + 2] * w[i]; ws += w[i];
		});
		const nl = Math.hypot(nx, ny, nz) || 1;
		nx /= nl; ny /= nl; nz /= nl;
		if (ws > 0) { cx /= ws; cy /= ws; cz /= ws; }
		const step = r * 0.05 * s; // how far a full-strength dab moves the surface (a stroke overlaps several dabs)
		let most = 0;
		const move = (v, dx, dy, dz) => { this.keep(v); pos[3 * v] += dx; pos[3 * v + 1] += dy; pos[3 * v + 2] += dz; const d = dx * dx + dy * dy + dz * dz; if (d > most) most = d; };
		const smoothStep = (v, k) => {
			let ax = 0, ay = 0, az = 0;
			const a = this.nbStart[v], b = this.nbStart[v + 1];
			if (b === a) return;
			for (let j = a; j < b; j++) { const u = this.nb[j]; ax += pos[3 * u]; ay += pos[3 * u + 1]; az += pos[3 * u + 2]; }
			const m = b - a;
			move(v, (ax / m - pos[3 * v]) * k, (ay / m - pos[3 * v + 1]) * k, (az / m - pos[3 * v + 2]) * k);
		};
		switch (brush) {
			case 'draw':
				ids.forEach((v, i) => move(v, nx * step * w[i] * sign, ny * step * w[i] * sign, nz * step * w[i] * sign));
				break;
			case 'inflate':
				ids.forEach((v, i) => { const k = step * 0.8 * w[i] * sign; move(v, nrm[3 * v] * k, nrm[3 * v + 1] * k, nrm[3 * v + 2] * k); });
				break;
			case 'clay': {
				// a plane a little above (or below) the area: bring what is under it up to it
				const off = step * 1.2 * sign, px = cx + nx * off, py = cy + ny * off, pz = cz + nz * off;
				ids.forEach((v, i) => {
					const d = (pos[3 * v] - px) * nx + (pos[3 * v + 1] - py) * ny + (pos[3 * v + 2] - pz) * nz;
					if (d * sign < 0) { const k = -d * w[i] * Math.min(1, s * 1.5); move(v, nx * k, ny * k, nz * k); }
				});
				break;
			}
			case 'flatten':
				ids.forEach((v, i) => {
					const d = (pos[3 * v] - cx) * nx + (pos[3 * v + 1] - cy) * ny + (pos[3 * v + 2] - cz) * nz;
					const k = -d * w[i] * Math.min(1, s * 0.8);
					move(v, nx * k, ny * k, nz * k);
				});
				break;
			case 'smooth':
				for (let pass = 0; pass < 2; pass++) ids.forEach((v, i) => smoothStep(v, Math.min(1, w[i] * s * 0.9)));
				break;
			case 'pinch':
			case 'crease': {
				// toward the brush center, along the surface (not in or out)
				const k0 = (brush === 'crease' ? 0.25 : 0.35) * s * (brush === 'pinch' ? sign : 1);
				ids.forEach((v, i) => {
					let dx = c[0] - pos[3 * v], dy = c[1] - pos[3 * v + 1], dz = c[2] - pos[3 * v + 2];
					const dn = dx * nx + dy * ny + dz * nz;
					dx -= nx * dn; dy -= ny * dn; dz -= nz * dn;
					const k = k0 * w[i];
					move(v, dx * k, dy * k, dz * k);
				});
				if (brush === 'crease') {
					// and dig a groove (Ctrl: a ridge)
					ids.forEach((v, i) => { const k = -step * 0.7 * w[i] * sign; move(v, nx * k, ny * k, nz * k); });
				}
				break;
			}
			default:
				return [];
		}
		this.stale += Math.sqrt(most);
		return ids;
	}

	/** Grab: pick up the vertices around a point (and its mirrors), then move them with grabMove. */
	grabStart(center, o) {
		this.grab = this.mirrors(center, null, o.symmetry).map(([c, , flips]) => {
			const ids = this.verticesNear(c, o.radius);
			const w = new Float32Array(ids.length), p0 = new Float32Array(ids.length * 3);
			ids.forEach((v, i) => {
				const d = Math.hypot(this.pos[3 * v] - c[0], this.pos[3 * v + 1] - c[1], this.pos[3 * v + 2] - c[2]);
				w[i] = falloff(o.falloff, d / o.radius) * Math.min(1, o.strength * 1.5);
				p0[3 * i] = this.pos[3 * v]; p0[3 * i + 1] = this.pos[3 * v + 1]; p0[3 * i + 2] = this.pos[3 * v + 2];
				this.keep(v);
			});
			return { ids, w, p0, flips };
		});
	}

	/** Move the grabbed region by delta (mm, part frame) from where it was picked up. */
	grabMove(delta) {
		const moved = [];
		for (const g of this.grab || []) {
			const d = delta.map((x, a) => x * g.flips[a]);
			g.ids.forEach((v, i) => {
				this.pos[3 * v] = g.p0[3 * i] + d[0] * g.w[i];
				this.pos[3 * v + 1] = g.p0[3 * i + 1] + d[1] * g.w[i];
				this.pos[3 * v + 2] = g.p0[3 * i + 2] + d[2] * g.w[i];
				moved.push(v);
			});
			this.stale = Math.max(this.stale, Math.hypot(...d));
		}
		return moved;
	}

	refit() {
		this.stale = 0;
		this.geometry.boundsTree.refit();
	}

	/** Finish the stroke: one undo step. Returns whether anything changed. */
	endStroke() {
		const st = this.stroke;
		this.stroke = null;
		this.grab = null;
		this.refit();
		this.geometry.computeBoundingBox();
		this.geometry.computeBoundingSphere();
		if (!st || !st.before.size) return false;
		const ids = Uint32Array.from(st.before.keys());
		const before = new Float32Array(ids.length * 3);
		ids.forEach((v, i) => { const p = st.before.get(v); before[3 * i] = p[0]; before[3 * i + 1] = p[1]; before[3 * i + 2] = p[2]; });
		this.undoStack.push({ ids, before });
		if (this.undoStack.length > 60) this.undoStack.shift();
		return true;
	}

	/** Swap stored positions with the current ones (undo and redo are the same operation). */
	swap(entry) {
		const { ids, before } = entry;
		for (let i = 0; i < ids.length; i++) {
			const v = ids[i];
			for (let k = 0; k < 3; k++) { const t = this.pos[3 * v + k]; this.pos[3 * v + k] = before[3 * i + k]; before[3 * i + k] = t; }
		}
		this.changed(ids);
		this.refit();
	}

	undo() { const e = this.undoStack.pop(); if (!e) return false; this.swap(e); this.redoStack.push(e); return true; }
	redo() { const e = this.redoStack.pop(); if (!e) return false; this.swap(e); this.undoStack.push(e); return true; }

	/** After moving vertices: new normals, and upload. */
	changed(ids) {
		this.computeNormals(ids);
		this.geometry.attributes.position.needsUpdate = true;
	}

	/** Positions and triangles as plain arrays (copies). */
	export() {
		return { positions: new Float32Array(this.pos), index: new Uint32Array(this.idx) };
	}

	dispose() {
		this.geometry.boundsTree = null;
		this.geometry.dispose();
	}
}

// ---------------------------------------------------------------- storage

const b64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => { const t = atob(s), out = new Uint8Array(t.length); for (let i = 0; i < t.length; i++) out[i] = t.charCodeAt(i); return out; };

/** An indexed mesh as a blob string ("IDX1:" vertices ":" triangles), about half the size of a triangle list. */
export function packIndexed(positions, index) {
	return 'IDX1:' + b64(new Uint8Array(positions.buffer, positions.byteOffset, positions.byteLength)) + ':' + b64(new Uint8Array(index.buffer, index.byteOffset, index.byteLength));
}

export function unpackIndexed(s) {
	const [, v, i] = s.split(':');
	return { positions: new Float32Array(unb64(v).buffer), index: new Uint32Array(unb64(i).buffer) };
}

/** Triangle list (non-indexed positions) from an indexed mesh. */
export function soupOf(positions, index) {
	const out = new Float32Array(index.length * 3);
	for (let i = 0; i < index.length; i++) { const v = index[i]; out[3 * i] = positions[3 * v]; out[3 * i + 1] = positions[3 * v + 1]; out[3 * i + 2] = positions[3 * v + 2]; }
	return out;
}
