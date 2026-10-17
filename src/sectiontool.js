// Section view in the 3D view: the cut plane is drawn as a see-through sheet with a frame, and a gizmo — an arrow to
// slide the plane along its normal and two rings to tilt it. The gizmo keeps a fixed size on screen and sits where the
// plane crosses the middle of the view, so it stays at hand when zoomed in.
// The plane's direction is a base axis (X, Y or Z) tilted by two angles about the other two world axes, like a gimbal:
// the first ring turns about a fixed world axis, the second about its partner turned by the first. A ring turns the
// plane as far as the pointer sweeps around it (like the part rotator): rotation steps on the ring, 1° out past it or
// with Shift, Alt free. Moving snaps to the grid (Alt: free).
import * as THREE from 'three';
import { fmt, round } from './util.js';

const DEG = Math.PI / 180;
const AXES = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
// gizmo sizes in screen pixels
const ARROW = 92, SHAFT = 1.8, HEAD_R = 6, HEAD_L = 15, RING = 58, RING_T = 1.6, GRAB_T = 10;
// the two world axes each base axis is tilted about (right-handed: P × Q = A)
const TILT_AXES = { x: ['y', 'z'], y: ['z', 'x'], z: ['x', 'y'] };
const AXIS_COLOR = { x: 0xff5a5a, y: 0x5ad25a, z: 0x4f9dff };

/** The section's plane normal (unit) from its settings: a free normal, or one of the axes. */
export function sectionNormal(s) {
	const n = Array.isArray(s.normal) && s.normal.length === 3 ? s.normal : AXES[s.axis] || AXES.x;
	const v = new THREE.Vector3(...n);
	return v.lengthSq() > 1e-12 ? v.normalize() : new THREE.Vector3(1, 0, 0);
}

/** The base axis the tilts are measured from: the chosen X / Y / Z, else the axis nearest the plane's normal. */
export function sectionBase(s) {
	if (AXES[s.base]) return s.base;
	if (AXES[s.axis]) return s.axis;
	const n = sectionNormal(s), a = [Math.abs(n.x), Math.abs(n.y), Math.abs(n.z)];
	return a[0] >= a[1] && a[0] >= a[2] ? 'x' : a[1] >= a[2] ? 'y' : 'z';
}

/** { A, P, Q } world unit vectors for a base axis. */
function frameOf(base) {
	const [p, q] = TILT_AXES[base];
	return { A: new THREE.Vector3(...AXES[base]), P: new THREE.Vector3(...AXES[p]), Q: new THREE.Vector3(...AXES[q]) };
}

/** The plane's tilts in degrees: [about P, about Q] (P, Q: the other two axes of the base axis, in X→Y→Z order). */
export function sectionTilts(s) {
	const n = sectionNormal(s), { A, P, Q } = frameOf(sectionBase(s));
	const b = Math.asin(Math.max(-1, Math.min(1, n.dot(P)))) / DEG;
	const a = Math.atan2(-n.dot(Q), n.dot(A)) / DEG;
	const clean = (x) => { const r = round(x, 6); return Math.abs(r) < 1e-6 ? 0 : r; };
	return [clean(a), clean(b)];
}

/** The plane normal for a base axis tilted by a° about P, then b° about Q turned with it. */
export function normalFromTilts(base, a, b) {
	const { A, P, Q } = frameOf(base);
	const ca = Math.cos(a * DEG), sa = Math.sin(a * DEG), cb = Math.cos(b * DEG), sb = Math.sin(b * DEG);
	return P.clone().multiplyScalar(sb).add(A.clone().multiplyScalar(ca * cb)).add(Q.clone().multiplyScalar(-sa * cb)).normalize();
}

/** Set the plane's tilts (degrees) about its base axis; with both 0 it is the plain axis again. */
export function setSectionTilts(s, a, b) {
	const base = sectionBase(s);
	s.base = base;
	if (Math.abs(a) < 1e-9 && Math.abs(b) < 1e-9) { s.axis = base; delete s.normal; return; }
	const n = normalFromTilts(base, a, b);
	s.normal = n.toArray().map((x) => { const v = round(x, 9); return Math.abs(v) < 1e-9 ? 0 : v; });
	s.axis = 'custom';
}

/** The names of the two axes a plane on this base axis tilts about. */
export function tiltAxisNames(s) { return TILT_AXES[sectionBase(s)]; }

// closest point parameter t on the line P + t·d to a ray
function closestOnLine(ray, P, d) {
	const r = ray.direction, w0 = P.clone().sub(ray.origin);
	const b = d.dot(r), dd = d.dot(w0), e = r.dot(w0);
	const denom = 1 - b * b;
	if (Math.abs(denom) < 1e-6) return null;
	return (b * e - dd) / denom;
}

const Z = new THREE.Vector3(0, 0, 1);

export class SectionTool {
	constructor(vp) {
		this.vp = vp;
		this.group = new THREE.Group(); // the sheet and its frame, on the model
		this.group.visible = false;
		vp.helpers.add(this.group);
		this.gizmo = new THREE.Group(); // arrow + rings, in the middle of the view (world-aligned)
		this.gizmo.visible = false;
		vp.helpers.add(this.gizmo);
		const color = 0x4fd1ff;
		this.sheetMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false });
		this.frameMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthTest: false });
		this.hotMat = new THREE.MeshBasicMaterial({ color: 0xffd23f, side: THREE.DoubleSide, depthTest: false });
		this.arrowMat = new THREE.MeshBasicMaterial({ color, depthTest: false });
		this.ringMats = { a: new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.9 }), b: new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.9 }) };
		this.grabMat = new THREE.MeshBasicMaterial({ visible: false }); // invisible, but still hit by the picking ray
		this.label = document.createElement('div');
		this.label.className = 'vp-label measure';
		this.label.style.display = 'none';
		vp.overlay.appendChild(this.label);
		this.drag = null;
		this.hot = null;
		this.basis = null; // the sheet's own in-plane directions { u, v }, kept steady while it turns
		this.handles = [];
		this.buildGizmo();
	}

	get s() { return this.vp.app.model.settings.section; }

	/** In-plane directions for normal n: kept from before when they still fit, else made fresh. */
	basisFor(n) {
		const b = this.basis;
		if (b && Math.abs(b.u.dot(n)) < 1e-6 && Math.abs(b.v.dot(n)) < 1e-6) return b;
		const q = new THREE.Quaternion().setFromUnitVectors(Z, n);
		this.basis = { u: new THREE.Vector3(1, 0, 0).applyQuaternion(q), v: new THREE.Vector3(0, 1, 0).applyQuaternion(q) };
		return this.basis;
	}

	quatFor(n) {
		const { u, v } = this.basisFor(n);
		return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(u, v, n));
	}

	/** Arrow and rings, built once in pixel units (scaled every frame to keep their size on screen). */
	buildGizmo() {
		const g = this.gizmo;
		const shaft = new THREE.Mesh(new THREE.CylinderGeometry(SHAFT, SHAFT, ARROW, 10).rotateX(Math.PI / 2).translate(0, 0, ARROW / 2), this.arrowMat);
		const head = new THREE.Mesh(new THREE.ConeGeometry(HEAD_R, HEAD_L, 16).rotateX(Math.PI / 2).translate(0, 0, ARROW + HEAD_L / 2), this.arrowMat);
		// a fatter invisible shaft so the arrow is easy to catch
		const grabArrow = new THREE.Mesh(new THREE.CylinderGeometry(8, 8, ARROW + HEAD_L, 8).rotateX(Math.PI / 2).translate(0, 0, (ARROW + HEAD_L) / 2), this.grabMat);
		this.arrow = new THREE.Group();
		this.arrow.add(shaft, head, grabArrow);
		for (const m of [shaft, head, grabArrow]) { m.renderOrder = 33; m.userData = { handle: 'move' }; }
		g.add(this.arrow);
		this.arrowParts = [shaft, head];
		// ring 'a' turns about P (fixed), ring 'b' about Q turned by a; each is oriented every frame in place()
		this.rings = {};
		for (const ring of ['a', 'b']) {
			const holder = new THREE.Group();
			const vis = new THREE.Mesh(new THREE.TorusGeometry(RING, RING_T, 6, 128), this.ringMats[ring]);
			const grab = new THREE.Mesh(new THREE.TorusGeometry(RING, GRAB_T, 6, 64), this.grabMat);
			vis.renderOrder = 34;
			vis.userData = { handle: 'tilt', ring, visual: true }; // drawn only; the wider invisible ring is what you grab
			grab.userData = { handle: 'tilt', ring };
			holder.add(vis, grab);
			g.add(holder);
			this.rings[ring] = { holder, vis, grab };
		}
	}

	/** World axis a ring turns about (unit), for the current tilts. */
	ringAxis(ring) {
		const s = this.s, { P, Q } = frameOf(sectionBase(s));
		if (ring === 'a') return P;
		const a = this.drag && this.drag.kind === 'tilt' ? this.drag.a : sectionTilts(s)[0];
		return Q.clone().applyAxisAngle(P, a * DEG);
	}

	/** Rebuild the sheet and frame for the current settings (sized from the scene), and place the gizmo. */
	update() {
		const s = this.s, g = this.group;
		for (const c of [...g.children]) { g.remove(c); c.geometry && c.geometry.dispose(); }
		const show = !!(s.on && s.showPlane !== false);
		g.visible = show;
		this.gizmo.visible = show;
		if (!s.on) { this.label.style.display = 'none'; this.vp.invalidate(); return; }
		const box = this.vp.app.sceneBox();
		const n = sectionNormal(s);
		const center = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
		const size = box.isEmpty() ? 60 : Math.max(20, box.getSize(new THREE.Vector3()).length() * 0.75);
		this.size = size;
		// the sheet's middle: the scene center moved onto the plane
		const o = center.clone().addScaledVector(n, (s.offset || 0) - center.dot(n));
		this.origin = o;
		g.position.copy(o);
		g.quaternion.copy(this.quatFor(n));
		const { u, v } = this.basisFor(n);
		this.u = u; this.v = v;
		const half = size / 2, bw = size * 0.012;
		const sheet = new THREE.Mesh(new THREE.PlaneGeometry(size, size), this.sheetMat);
		sheet.renderOrder = 30;
		g.add(sheet);
		// frame: four bars (grab them to slide the plane too)
		const frameMat = this.hot && this.hot.handle === 'move' ? this.hotMat : this.frameMat;
		const bar = (w, h, x, y) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), frameMat); m.position.set(x, y, 0); m.renderOrder = 31; m.userData = { handle: 'move' }; g.add(m); };
		bar(size, bw, 0, half - bw / 2); bar(size, bw, 0, -half + bw / 2); bar(bw, size - 2 * bw, half - bw / 2, 0); bar(bw, size - 2 * bw, -half + bw / 2, 0);
		g.updateMatrixWorld(true);
		// colors: the arrow in the plane's color, each ring in the color of the world axis it turns about
		for (const m of this.arrowParts) m.material = this.hot && this.hot.handle === 'move' ? this.hotMat : this.arrowMat;
		const names = TILT_AXES[sectionBase(s)];
		this.ringMats.a.color.setHex(AXIS_COLOR[names[0]]);
		this.ringMats.b.color.setHex(AXIS_COLOR[names[1]]);
		for (const ring of ['a', 'b']) this.rings[ring].vis.material = this.hot && this.hot.handle === 'tilt' && this.hot.ring === ring ? this.hotMat : this.ringMats[ring];
		this.handles = [...g.children.filter((c) => c.userData.handle), this.arrow.children[2], this.rings.a.grab, this.rings.b.grab];
		this.place();
	}

	/**
	 * Put the gizmo where the plane crosses the middle of the view (or, if the plane is edge-on or behind, at the
	 * sheet's middle) and size it in pixels. Called every frame.
	 */
	place() {
		const s = this.s, vp = this.vp, g = this.gizmo;
		if (!s.on || !g.visible || !this.origin) return;
		const n = sectionNormal(s);
		let P = null;
		if (this.drag && this.drag.kind === 'tilt') P = this.drag.center; // stay put while turning
		else {
			vp.raycaster.setFromCamera({ x: 0, y: 0 }, vp.camera);
			const pl = new THREE.Plane().setFromNormalAndCoplanarPoint(n, this.origin);
			const hit = vp.raycaster.ray.intersectPlane(pl, new THREE.Vector3());
			// only where the plane is reasonably face-on, and within its sheet
			if (hit && Math.abs(vp.raycaster.ray.direction.dot(n)) > 0.15) {
				const d = hit.clone().sub(this.origin), lim = this.size / 2;
				const a = Math.max(-lim, Math.min(lim, d.dot(this.u))), b = Math.max(-lim, Math.min(lim, d.dot(this.v)));
				P = this.origin.clone().addScaledVector(this.u, a).addScaledVector(this.v, b);
			} else P = this.origin.clone();
		}
		g.position.copy(P);
		g.quaternion.identity();
		// with Flip the other side is kept, so the arrow points the other way
		this.arrow.quaternion.setFromUnitVectors(Z, s.flip ? n.clone().negate() : n);
		for (const ring of ['a', 'b']) this.rings[ring].holder.quaternion.setFromUnitVectors(Z, this.ringAxis(ring));
		g.scale.setScalar(vp.handles.screenSize(P, 1));
		g.updateMatrixWorld(true);
	}

	pick(e) {
		if (!this.group.visible || !this.handles.length) return null;
		const vp = this.vp;
		vp.raycaster.setFromCamera(vp.ndc(e), vp.camera);
		// the gizmo wins over the frame behind it
		const hits = vp.raycaster.intersectObjects(this.handles, false);
		const onGizmo = (o) => { for (let p = o.parent; p; p = p.parent) if (p === this.gizmo) return true; return false; };
		// the rings stand upright through the arrow: where they cross it, the arrow wins
		const hit = hits.find((h) => onGizmo(h.object) && h.object.userData.handle === 'move') || hits.find((h) => onGizmo(h.object)) || hits[0];
		return hit ? { handle: hit.object.userData.handle, ring: hit.object.userData.ring, point: hit.point } : null;
	}

	hoverAt(e) {
		if (this.drag) return 'grabbing';
		const p = this.pick(e);
		const key = p ? p.handle + (p.ring || '') : null;
		if (key !== (this.hot ? this.hot.handle + (this.hot.ring || '') : null)) { this.hot = p; this.update(); }
		if (p) {
			const names = tiltAxisNames(this.s);
			this.vp.app.onHint(p.handle === 'move' ? 'Drag to move the section plane (snaps to the grid · Alt: free) — or use the slider in the Section bar'
				: `Drag around the ring to tilt the plane about ${names[p.ring === 'a' ? 0 : 1].toUpperCase()} (on the ring: ${this.vp.app.model.settings.rotSnap || 15}° steps · out past the ring or Shift: 1° · Alt: free)`);
		}
		return p ? 'grab' : null;
	}

	/** Start dragging a handle; returns true when the press was ours. */
	pointerDown(e) {
		if (e.button !== 0) return false;
		const p = this.pick(e);
		if (!p) return false;
		const s = this.s, vp = this.vp;
		const n = sectionNormal(s);
		vp.raycaster.setFromCamera(vp.ndc(e), vp.camera);
		const [a0, b0] = sectionTilts(s);
		this.drag = { kind: p.handle, ring: p.ring, start: { offset: s.offset || 0, normal: n.clone() }, a: a0, b: b0, a0, b0, P: p.point.clone(), t0: closestOnLine(vp.raycaster.ray, p.point, n) };
		if (p.handle === 'tilt') {
			const d = this.drag, C = this.gizmo.position.clone(), axis = this.ringAxis(p.ring).clone();
			d.center = C;
			d.axis = axis;
			const cr = vp.canvas.getBoundingClientRect(), c = vp.project(C);
			d.centerPx = { x: c.x + cr.left, y: c.y + cr.top };
			// the pointer's direction from the middle, in the ring's own plane (so the sweep is a true 3D angle)
			d.ringPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(axis, C);
			d.last = this.ringDir(e);
			d.swept = 0;
			// which way round is positive: the ring's axis toward or away from the viewer
			const toEye = vp.camera.isOrthographicCamera ? vp.camera.getWorldDirection(new THREE.Vector3()).negate() : vp.camera.position.clone().sub(C).normalize();
			d.facing = axis.dot(toEye);
			// seen nearly edge-on the sweep is unreliable: then move along the ring's line on screen instead
			const tangent = axis.clone().cross(p.point.clone().sub(C)).normalize();
			const pa = vp.project(p.point), pb = vp.project(p.point.clone().addScaledVector(tangent, vp.handles.screenSize(p.point, 20)));
			const tx = pb.x - pa.x, ty = pb.y - pa.y, tl = Math.hypot(tx, ty);
			d.tan = tl > 2 ? { x: tx / tl, y: ty / tl } : { x: 1, y: 0 };
			d.x0 = e.clientX; d.y0 = e.clientY;
		}
		vp.controls.enabled = false;
		const move = (ev) => this.dragMove(ev);
		const up = () => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			vp.controls.enabled = true;
			this.drag = null;
			this.label.style.display = 'none';
			this.vp.app.onSectionChanged(true);
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
		return true;
	}

	/** Unit direction from the gizmo's middle to where the pointer meets the dragged ring's plane (null if it misses). */
	ringDir(e) {
		const d = this.drag, vp = this.vp;
		vp.raycaster.setFromCamera(vp.ndc(e), vp.camera);
		const hit = vp.raycaster.ray.intersectPlane(d.ringPlane, new THREE.Vector3());
		if (!hit) return null;
		const v = hit.sub(d.center);
		return v.lengthSq() > 1e-12 ? v.normalize() : null;
	}

	dragMove(e) {
		const d = this.drag, s = this.s, vp = this.vp;
		if (!d) return;
		const r = vp.container.getBoundingClientRect();
		if (d.kind === 'move') {
			vp.raycaster.setFromCamera(vp.ndc(e), vp.camera);
			const t = closestOnLine(vp.raycaster.ray, d.P, d.start.normal);
			if (t === null || d.t0 === null) return;
			let off = d.start.offset + (t - d.t0);
			const snap = vp.app.model.settings.snap;
			if (snap > 0 && !e.altKey) off = Math.round(off / snap) * snap;
			s.offset = round(off, 4);
			this.label.textContent = `${fmt(s.offset, 3)} mm`;
		} else {
			let deg;
			const dir = Math.abs(d.facing) > 0.3 && d.last ? this.ringDir(e) : null;
			if (dir) {
				// the angle swept around the ring, measured in its own plane: the plane turns exactly as far as the
				// pointer goes round
				d.swept += Math.atan2(d.axis.dot(d.last.clone().cross(dir)), d.last.dot(dir));
				d.last = dir;
				deg = d.swept / DEG;
			} else {
				// seen edge-on: half a degree per pixel along the ring's line on screen
				deg = ((e.clientX - d.x0) * d.tan.x + (e.clientY - d.y0) * d.tan.y) * 0.5;
			}
			// like the part rotator: on (or inside) the ring coarse steps, out past the ring 1° steps; Shift 1°, Alt free
			const ringPx = RING * 1.45;
			const out = Math.hypot(e.clientX - d.centerPx.x, e.clientY - d.centerPx.y) > ringPx;
			const coarse = vp.app.model.settings.rotSnap || 15;
			const stepDeg = e.altKey ? 0 : e.shiftKey || out ? 1 : coarse;
			let v = (d.ring === 'a' ? d.a0 : d.b0) + deg;
			if (stepDeg) v = Math.round(v / stepDeg) * stepDeg;
			v = (((v + 180) % 360) + 360) % 360 - 180;
			let a = d.a0, b = d.b0;
			if (d.ring === 'a') a = v; else b = Math.max(-90, Math.min(90, v));
			d.a = a; d.b = b;
			setSectionTilts(s, a, b);
			// keep the plane through the gizmo's middle while it turns
			s.offset = round(d.center.dot(sectionNormal(s)), 4);
			const names = tiltAxisNames(s);
			this.label.textContent = `Tilt about ${names[d.ring === 'a' ? 0 : 1].toUpperCase()}: ${fmt(d.ring === 'a' ? a : b, 1)}°${stepDeg === 1 ? ' (1° steps)' : stepDeg ? '' : ' (free)'}`;
		}
		this.label.style.display = 'block';
		this.label.style.transform = `translate(${e.clientX - r.left + 16}px, ${e.clientY - r.top - 18}px)`;
		vp.app.onSectionChanged(false);
	}
}

// ---------------------------------------------------------------- measuring on the cut surface

const outlineCache = new Map();

/**
 * Where a mesh crosses a plane, in world space: { segs: [[A, B]…], loops: [[P…]…] } — the outline of the cut
 * surface. Cached per mesh, placement and plane.
 */
export function capOutline(mesh, plane) {
	mesh.updateWorldMatrix(true, false);
	const key = mesh.geometry.uuid + '|' + mesh.matrixWorld.elements.join(',') + '|' + plane.normal.toArray().join(',') + ',' + plane.constant;
	const hit = outlineCache.get(key);
	if (hit) return hit;
	const g = mesh.geometry, pos = g.attributes.position, idx = g.index, M = mesh.matrixWorld;
	const T = idx ? idx.count / 3 : pos.count / 3;
	const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
	const segs = [];
	const eps = 1e-7;
	for (let t = 0; t < T; t++) {
		const ia = idx ? idx.getX(3 * t) : 3 * t, ib = idx ? idx.getX(3 * t + 1) : 3 * t + 1, ic = idx ? idx.getX(3 * t + 2) : 3 * t + 2;
		A.fromBufferAttribute(pos, ia).applyMatrix4(M); B.fromBufferAttribute(pos, ib).applyMatrix4(M); C.fromBufferAttribute(pos, ic).applyMatrix4(M);
		const da = plane.distanceToPoint(A), db = plane.distanceToPoint(B), dc = plane.distanceToPoint(C);
		if ((da > eps && db > eps && dc > eps) || (da < -eps && db < -eps && dc < -eps)) continue;
		const pts = [];
		const edge = (P, Q, dp, dq) => {
			if ((dp > eps && dq < -eps) || (dp < -eps && dq > eps)) pts.push(P.clone().lerp(Q, dp / (dp - dq)));
		};
		edge(A, B, da, db); edge(B, C, db, dc); edge(C, A, dc, da);
		for (const [P, d] of [[A, da], [B, db], [C, dc]]) if (Math.abs(d) <= eps) pts.push(P.clone());
		if (pts.length >= 2 && pts[0].distanceToSquared(pts[1]) > 1e-14) segs.push([pts[0], pts[1]]);
	}
	// chain the segments into loops (ends matched to 0.1 µm); an edge lying in the plane comes from both its
	// triangles, so drop repeats first
	const k = (p) => `${Math.round(p.x * 1e4)},${Math.round(p.y * 1e4)},${Math.round(p.z * 1e4)}`;
	const seen = new Set();
	for (let i = segs.length - 1; i >= 0; i--) { const a = k(segs[i][0]), b = k(segs[i][1]); const kk = a < b ? a + '|' + b : b + '|' + a; if (seen.has(kk)) segs.splice(i, 1); else seen.add(kk); }
	const ends = new Map();
	segs.forEach((s, i) => { for (const e of [0, 1]) { const kk = k(s[e]); if (!ends.has(kk)) ends.set(kk, []); ends.get(kk).push([i, e]); } });
	const used = new Uint8Array(segs.length), loops = [];
	for (let i = 0; i < segs.length; i++) {
		if (used[i]) continue;
		used[i] = 1;
		const loop = [segs[i][0], segs[i][1]];
		let cur = segs[i][1];
		for (let guard = 0; guard < segs.length; guard++) {
			const next = (ends.get(k(cur)) || []).find(([j]) => !used[j]);
			if (!next) break;
			const [j, e] = next;
			used[j] = 1;
			cur = segs[j][1 - e];
			if (k(cur) === k(loop[0])) break;
			loop.push(cur);
		}
		if (loop.length >= 3) loops.push(loop);
	}
	// corners: where an outline turns by more than 10° (not the in-between points along straight edges or the
	// many small turns around a round hole), plus the ends of any open piece
	const corners = [];
	for (const lp of loops) {
		for (let i = 0; i < lp.length; i++) {
			const a = lp[(i + lp.length - 1) % lp.length], b = lp[i], c = lp[(i + 1) % lp.length];
			const u = b.clone().sub(a), w = c.clone().sub(b);
			if (u.lengthSq() < 1e-14 || w.lengthSq() < 1e-14) continue;
			if (u.normalize().dot(w.normalize()) < Math.cos(10 * DEG)) corners.push(b);
		}
	}
	// loops without the in-between points along straight edges (circle detection needs only real bends; extra
	// points on straight runs can make a rectangle look like an arc)
	const simple = loops.map((lp) => lp.filter((b, i) => {
		const a = lp[(i + lp.length - 1) % lp.length], c = lp[(i + 1) % lp.length];
		const u = b.clone().sub(a), w = c.clone().sub(b);
		return u.lengthSq() > 1e-14 && w.lengthSq() > 1e-14 && u.normalize().dot(w.normalize()) < Math.cos(0.5 * DEG);
	})).filter((lp) => lp.length >= 3);
	const out = { segs, loops, corners, simple };
	outlineCache.set(key, out);
	if (outlineCache.size > 24) outlineCache.delete(outlineCache.keys().next().value);
	return out;
}
