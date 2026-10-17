// Push / pull: pick a planar face of any part (also after booleans) and extrude its exact outline outward
// (thicken) or inward (cut). Includes the face-region extraction and the viewport tool.
import * as THREE from 'three';
import { extrudePts, layeredExtrude } from './shapes.js';
import { fmt, round } from './util.js';
import { weld } from './meshutil.js';

// Orthonormal frame for a plane (same convention as the viewport's workplane).
function planeBasis(normal) {
	const n = normal.clone().normalize();
	let x = new THREE.Vector3(1, 0, 0).projectOnPlane(n);
	if (x.length() < 0.1) x = new THREE.Vector3(0, 1, 0).projectOnPlane(n);
	x.normalize();
	const y = n.clone().cross(x).normalize();
	return { n, x, y, quat: new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, n)) };
}

/**
 * The flat face containing triangle `faceIndex` of a mesh, in world space.
 * Returns { origin, basis, loops (2D, outer first), tris (world positions for highlighting), area }.
 */
export function faceRegion(mesh, faceIndex) {
	const g = mesh.geometry, pos = g.attributes.position, idx = g.index;
	mesh.updateWorldMatrix(true, false);
	const M = mesh.matrixWorld, flip = M.determinant() < 0;
	// world-space vertices welded to 0.1 µm (typed-array hashing)
	const w = weld(pos.array, idx ? idx.array : null, 1e-4, M.elements);
	const V = new Array(w.count), T = [], triOf = [];
	for (let i = 0; i < w.count; i++) V[i] = new THREE.Vector3(w.verts[3 * i], w.verts[3 * i + 1], w.verts[3 * i + 2]);
	const NV = w.count;
	const triCount = w.ids.length / 3;
	for (let t = 0; t < triCount; t++) {
		let a = w.ids[3 * t], b = w.ids[3 * t + 1], c = w.ids[3 * t + 2];
		if (flip) [b, c] = [c, b];
		triOf[t] = a === b || b === c || a === c ? -1 : T.length;
		if (triOf[t] >= 0) T.push([a, b, c]);
	}
	const start = triOf[faceIndex];
	if (start === undefined || start < 0) return null;
	const N = T.map(([a, b, c]) => V[b].clone().sub(V[a]).cross(V[c].clone().sub(V[a])).normalize());
	const edgeTris = new Map();
	T.forEach(([a, b, c], t) => {
		for (const [p, q] of [[a, b], [b, c], [c, a]]) {
			const k = p < q ? p * NV + q : q * NV + p;
			const l = edgeTris.get(k);
			if (l) l.push(t); else edgeTris.set(k, [t]);
		}
	});
	const n0 = N[start], d0 = n0.dot(V[T[start][0]]);
	// Smooth patch around the picked triangle (neighbors within the crease angle). If it is larger than the
	// flat region, the face is curved: offset the whole patch along its normals instead of extruding a plane.
	const cosCrease = Math.cos((25 * Math.PI) / 180);
	const smooth = new Set([start]);
	const st2 = [start];
	while (st2.length) {
		const t = st2.pop();
		const [a, b, c] = T[t];
		for (const [p2, q2] of [[a, b], [b, c], [c, a]]) {
			for (const u of edgeTris.get(p2 < q2 ? p2 * NV + q2 : q2 * NV + p2)) {
				if (smooth.has(u) || N[u].dot(N[t]) < cosCrease) continue;
				smooth.add(u);
				st2.push(u);
			}
		}
	}
	const inReg = new Set([start]);
	const stack = [start];
	while (stack.length) {
		const t = stack.pop();
		const [a, b, c] = T[t];
		for (const [p, q] of [[a, b], [b, c], [c, a]]) {
			for (const u of edgeTris.get(p < q ? p * NV + q : q * NV + p)) {
				if (inReg.has(u) || N[u].dot(n0) < 1 - 1e-6) continue;
				if (T[u].some((vi) => Math.abs(n0.dot(V[vi]) - d0) > 1e-3)) continue;
				inReg.add(u);
				stack.push(u);
			}
		}
	}
	// boundary loops from directed edges whose reverse is not in the region
	const boundaryLoops = (set) => {
		const dir = new Set();
		for (const t of set) { const [a, b, c] = T[t]; dir.add(a * NV + b); dir.add(b * NV + c); dir.add(c * NV + a); }
		const out = new Map();
		for (const k of dir) {
			const a = Math.floor(k / NV), b = k % NV;
			if (dir.has(b * NV + a)) continue;
			if (!out.has(a)) out.set(a, []);
			out.get(a).push(b);
		}
		const res = [];
		for (const [s] of out) {
			while (out.get(s) && out.get(s).length) {
				const loop = [s];
				let cur = out.get(s).pop(), guard = 0;
				while (cur !== s && guard++ < 1e6) { loop.push(cur); const nx = out.get(cur); if (!nx || !nx.length) break; cur = nx.pop(); }
				if (loop.length >= 3) res.push(loop);
			}
		}
		return res;
	};
	const loops3 = boundaryLoops(inReg);
	const areaOf = (set) => { let sum = 0; for (const t of set) { const [a1, b1, c1] = T[t]; sum += V[b1].clone().sub(V[a1]).cross(V[c1].clone().sub(V[a1])).length() / 2; } return sum; };
	// the surface curving smoothly away from the face (behind its plane), up to where it turns side-on:
	// rounded edges around a flat face, or the neighboring facets of a cylinder wall
	const band = new Set(inReg);
	for (const todo = [...inReg]; todo.length;) {
		const t = todo.pop();
		const [a, b, c] = T[t];
		for (const [p, q] of [[a, b], [b, c], [c, a]]) {
			for (const u of edgeTris.get(p < q ? p * NV + q : q * NV + p)) {
				if (band.has(u) || N[u].dot(N[t]) < cosCrease || N[u].dot(n0) < 1e-4) continue;
				if (T[u].some((vi) => n0.dot(V[vi]) - d0 > 1e-4)) continue;
				band.add(u);
				todo.push(u);
			}
		}
	}
	// curved only when the flat part is a small facet of that smooth surface (e.g. a cylinder wall), not when a
	// flat face runs into rounded edges (a rounded box: its top is most of it); surfaces curving toward the face
	// (the inside of a tube) are measured against the whole smooth patch
	const curved = smooth.size > inReg.size && areaOf(inReg) < 0.2 * areaOf(band.size > inReg.size ? band : smooth);
	if (!curved && !loops3.length) return null;
	if (curved) {
		// curved patch: local vertex list, triangles and area-weighted vertex normals
		const ids = new Map(), PV = [], PN = [], PT = [];
		const vi = (g2) => { if (!ids.has(g2)) { ids.set(g2, PV.length); PV.push(V[g2]); PN.push(new THREE.Vector3()); } return ids.get(g2); };
		let total = 0;
		const tris = [];
		for (const t of smooth) {
			const [a, b, c] = T[t];
			const cr = V[b].clone().sub(V[a]).cross(V[c].clone().sub(V[a]));
			total += cr.length() / 2;
			const la = vi(a), lb = vi(b), lc = vi(c);
			PT.push([la, lb, lc]);
			for (const l of [la, lb, lc]) PN[l].add(cr);
			for (const g2 of [a, b, c]) tris.push(V[g2].x, V[g2].y, V[g2].z);
		}
		PN.forEach((n) => n.normalize());
		return { curved: true, V: PV, N: PN, T: PT, tris, area: total, normal: N[start].clone() };
	}
	const basis = planeBasis(n0);
	const origin = V[loops3[0][0]].clone();
	const to2 = (vi) => { const d = V[vi].clone().sub(origin); return [d.dot(basis.x), d.dot(basis.y)]; };
	const area = (lp) => { let s = 0; for (let i = 0; i < lp.length; i++) { const p = lp[i], q = lp[(i + 1) % lp.length]; s += p[0] * q[1] - q[0] * p[1]; } return s / 2; };
	const loops = loops3.map((lp) => lp.map(to2)).sort((a, b) => Math.abs(area(b)) - Math.abs(area(a)));
	const tris = [];
	for (const t of inReg) for (const vi of T[t]) tris.push(V[vi].x, V[vi].y, V[vi].z);
	let total = 0;
	for (const t of inReg) { const [a, b, c] = T[t]; total += V[b].clone().sub(V[a]).cross(V[c].clone().sub(V[a])).length() / 2; }
	return { origin, basis, loops, tris, area: total, blend: blendOf() };

	// A face whose outer edges all drop away below it, and that runs into rounded edges or meets curved walls (filleted
	// corners, a cylinder): push/pull moves the face itself, carrying the rounding along and stretching or shortening
	// the walls, instead of extruding its faceted outline (which can never line up with curved walls exactly and leaves
	// paper-thin skins). { h: how far below the face the rounding reaches (0 if none), outline: where the face (with its
	// rounding) meets the walls, 2D in the face frame }, or null for faces bounded by flat walls, or meeting a wall that
	// rises above them.
	function blendOf() {
		let h = 0;
		for (const t of band) for (const vi of T[t]) h = Math.max(h, d0 - n0.dot(V[vi]));
		if (h < 1e-3) h = 0;
		const bl = boundaryLoops(band).map((lp) => ({ lp, p2: lp.map(to2) })).sort((x, y) => Math.abs(area(y.p2)) - Math.abs(area(x.p2)));
		if (!bl.length) return null;
		const outer = bl[0].lp;
		let curvedWall = false;
		for (let i = 0; i < outer.length; i++) {
			const a = outer[i], b = outer[(i + 1) % outer.length];
			for (const u of edgeTris.get(a < b ? a * NV + b : b * NV + a) || []) {
				if (band.has(u)) continue;
				// a wall rising above the face would be dragged along
				if (T[u].some((vi) => n0.dot(V[vi]) - d0 > 1e-4)) return null;
				// a wall that is part of a curved surface: it bends smoothly into a neighbor that is not in its plane
				if (!curvedWall) {
					const [p, q, r] = T[u];
					for (const [x, y] of [[p, q], [q, r], [r, p]]) for (const w of edgeTris.get(x < y ? x * NV + y : y * NV + x) || []) {
						if (w === u || band.has(w)) continue;
						const c = N[w].dot(N[u]);
						if (c > cosCrease && c < 1 - 1e-6) curvedWall = true;
					}
				}
			}
		}
		if (!h && !curvedWall) return null;
		return { h, outline: bl[0].p2 };
	}
}

/**
 * Builder for flat-face push/pull: params { loops (outer first, then holes), depth (negative = into the face),
 * draft (degrees; positive tapers the outline inward as it moves away from the face) }.
 */
export function buildFaceExtrude(p) {
	const loops = p.loops || [];
	if (!loops.length || loops[0].length < 3) return null;
	// Thickening overlaps the face slightly (inside the part, so it is harmless). Cutting starts exactly at the face:
	// a margin outward would also bite into anything next to the face (a wall rising from it, the side of a recess)
	// and leave a hair-thin groove that slicers pick up. Exact geometry makes the flush cut clean.
	const d = p.depth || 0, ov = d < 0 ? 0 : 0.02;
	const tanA = Math.tan(((p.draft || 0) * Math.PI) / 180);
	if (Math.abs(tanA) > 1e-6) {
		// distance s runs from just outside the face (−ov) to |d|; outlines inset by s·tan(draft)
		const L = Math.abs(d);
		const g = layeredExtrude([{ outer: loops[0], holes: loops.slice(1) }], [[-ov, -ov * tanA], [L, L * tanA]]);
		if (d < 0) g.scale(1, 1, -1); // cutting: grow into the part instead
		return g;
	}
	const h = Math.abs(d) + ov;
	const g = extrudePts(loops[0], h, loops.slice(1));
	g.translate(0, 0, d >= 0 ? -ov : d);
	return g;
}

/**
 * Builder for curved-face push/pull: params { V, N, T (patch vertices, normals, triangles), depth }.
 * Builds the slab between the surface and its offset (plus side walls along the patch boundary).
 */
export function buildFaceOffset(p) {
	const V = p.V || [], N = p.N || [], T = p.T || [];
	if (!T.length) return null;
	const d = p.depth || 0, ov = 0.02;
	const sIn = d >= 0 ? -ov : d, sOut = d >= 0 ? d : ov;
	const at = (i, s) => [V[i][0] + N[i][0] * s, V[i][1] + N[i][1] * s, V[i][2] + N[i][2] * s];
	const pos = [];
	const tri = (a, b, c) => pos.push(...a, ...b, ...c);
	const dir = new Set();
	for (const [a, b, c] of T) {
		tri(at(a, sOut), at(b, sOut), at(c, sOut)); // outer surface keeps the face's orientation
		tri(at(a, sIn), at(c, sIn), at(b, sIn)); // inner surface faces the other way
		dir.add(a + '>' + b); dir.add(b + '>' + c); dir.add(c + '>' + a);
	}
	for (const k of dir) {
		const [a, b] = k.split('>').map(Number);
		if (dir.has(b + '>' + a)) continue; // interior edge
		const ai = at(a, sIn), bi = at(b, sIn), bo = at(b, sOut), ao = at(a, sOut);
		tri(ai, bi, bo);
		tri(ai, bo, ao);
	}
	const g = new THREE.BufferGeometry();
	g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
	return g;
}

// Closest point on the line (P + t·d) to the ray; returns t (d unit length).
function closestOnLine(ray, P, d) {
	const r = ray.direction, w0 = P.clone().sub(ray.origin);
	const b = d.dot(r), dd = d.dot(w0), e = r.dot(w0);
	const denom = 1 - b * b;
	if (Math.abs(denom) < 1e-6) return null;
	return (b * e - dd) / denom;
}

export class PushPullTool {
	constructor(vp) {
		this.vp = vp;
		this.active = false;
		this.sel = null; // { id, region }
		this.hover = null;
		this.distance = 0;
		this.hoverMesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: 0xffa94d, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
		this.hoverMesh.renderOrder = 7;
		this.preview = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: 0x5ccb6f, transparent: true, opacity: 0.45, depthWrite: false }));
		this.preview.renderOrder = 8;
		this.preview.matrixAutoUpdate = false;
		this.label = document.createElement('div');
		this.label.className = 'vp-label angle';
		vp.overlay.appendChild(this.label);
		vp.helpers.add(this.hoverMesh, this.preview);
		this.clear();
	}

	clear() {
		this.hoverMesh.visible = false;
		this.preview.visible = false;
		this.label.style.display = 'none';
		this.vp.invalidate();
	}

	setActive(on) {
		this.active = on;
		this.sel = null;
		this.hover = null;
		this.distance = 0;
		this.clear();
		this.vp.app.onPushPullState(on, null, 0);
	}

	pickFace(e) {
		const hit = this.vp.raycast(e, this.vp.pickables());
		if (!hit || hit.faceIndex === undefined) return null;
		const region = faceRegion(hit.object, hit.faceIndex);
		return region ? { id: hit.object.userData.nodeId, region, point: hit.point } : null;
	}

	showRegion(r) {
		this.hoverMesh.geometry.dispose();
		const g = new THREE.BufferGeometry();
		g.setAttribute('position', new THREE.Float32BufferAttribute(r.tris, 3));
		this.hoverMesh.geometry = g;
		this.hoverMesh.visible = true;
		this.vp.invalidate();
	}

	hoverAt(e) {
		if (this.dragging) return 'grabbing';
		const f = this.pickFace(e);
		if (f) this.showRegion(f.region);
		else if (this.sel) this.showRegion(this.sel.region);
		else this.hoverMesh.visible = false;
		this.vp.invalidate();
		return f ? 'pointer' : null;
	}

	updatePreview() {
		const s = this.sel;
		if (!s || !this.distance) { this.preview.visible = false; this.label.style.display = 'none'; this.vp.invalidate(); return; }
		const r = s.region;
		const g = r.curved
			? buildFaceOffset({ V: r.V.map((v) => v.toArray()), N: r.N.map((n) => n.toArray()), T: r.T, depth: this.distance })
			: buildFaceExtrude({ loops: r.blend && !+(this.vp.app.ppDraft || 0) ? [r.blend.outline] : r.loops, depth: this.distance, draft: this.vp.app.ppDraft || 0 });
		this.preview.geometry.dispose();
		this.preview.geometry = g;
		if (r.curved) this.preview.matrix.identity();
		else this.preview.matrix.compose(r.origin, r.basis.quat, new THREE.Vector3(1, 1, 1));
		this.preview.matrixWorldNeedsUpdate = true;
		this.preview.material.color.setHex(this.distance > 0 ? 0x5ccb6f : 0xef5a4f);
		this.preview.visible = true;
		this.vp.invalidate();
	}

	pointerDown(e) {
		const f = this.pickFace(e);
		if (!f) return false;
		this.sel = f;
		this.distance = 0;
		this.showRegion(f.region);
		const n = (f.region.curved ? f.region.normal : f.region.basis.n).clone();
		const P = f.point.clone();
		const vp = this.vp;
		vp.raycaster.setFromCamera(vp.ndc(e), vp.camera);
		const t0 = closestOnLine(vp.raycaster.ray, P, n);
		const snap = vp.app.model.settings.snap;
		let moved = false;
		const x0 = e.clientX, y0 = e.clientY;
		const r = vp.container.getBoundingClientRect();
		const move = (ev) => {
			if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
			moved = true;
			this.dragging = true;
			vp.raycaster.setFromCamera(vp.ndc(ev), vp.camera);
			const t = closestOnLine(vp.raycaster.ray, P, n);
			if (t === null || t0 === null) return;
			let d = t - t0;
			if (snap > 0 && !ev.altKey) d = Math.round(d / snap) * snap;
			this.distance = round(d, 3); // whole microns
			this.updatePreview();
			this.label.style.display = this.distance ? 'block' : 'none';
			this.label.textContent = (this.distance > 0 ? '+' : '') + fmt(this.distance, 2) + ' mm';
			this.label.style.transform = `translate(${ev.clientX - r.left + 16}px, ${ev.clientY - r.top - 18}px)`;
			vp.app.onPushPullState(true, this.sel, this.distance);
		};
		const up = () => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			this.dragging = false;
			this.label.style.display = 'none';
			if (moved && this.distance) vp.app.applyPushPull();
			else vp.app.onPushPullState(true, this.sel, this.distance, true);
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
		return true;
	}

	// After a rebuild the selected face is stale.
	refresh() {
		if (!this.active) return;
		if (this.sel && !this.vp.app.model.get(this.sel.id)) this.sel = null;
	}
}
