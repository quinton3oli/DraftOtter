// Selection overlay + direct-manipulation handles:
//  - oriented selection box with clickable / editable dimension labels
//  - scale mode: face & corner handles that move one side (opposite side fixed), snapped sizes
//  - rotate mode: axis rings with a protractor sector and snapped angle readout
import * as THREE from 'three';
import { DEG, fmt, evalExpr, round } from './util.js';

const AXES = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
const AXIS_COLORS = [0xef6a5f, 0x5ccb6f, 0x4aa3ff];
const HOVER = 0xffd23f;

function handleMat(color) {
	return new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true });
}

export class EditHandles {
	constructor(vp) {
		this.vp = vp;
		this.frameGroup = new THREE.Group();
		this.frameGroup.matrixAutoUpdate = false;
		vp.helpers.add(this.frameGroup);

		this.boxHelper = new THREE.Box3Helper(new THREE.Box3(), 0x19b8b4);
		Object.assign(this.boxHelper.material, { depthTest: false, transparent: true, opacity: 0.6 });
		this.boxHelper.renderOrder = 5;
		this.frameGroup.add(this.boxHelper);

		// Scale handles (children of the oriented frame)
		this.scaleGroup = new THREE.Group();
		this.frameGroup.add(this.scaleGroup);
		const cube = new THREE.BoxGeometry(1, 1, 1);
		this.scaleHandles = [];
		for (let i = 0; i < 3; i++) {
			for (const s of [-1, 1]) {
				const m = new THREE.Mesh(cube, handleMat(AXIS_COLORS[i]));
				m.userData = { kind: 'face', axis: i, side: s, color: AXIS_COLORS[i] };
				m.renderOrder = 30;
				this.scaleGroup.add(m);
				this.scaleHandles.push(m);
			}
		}
		for (const sx of [-1, 1]) {
			for (const sy of [-1, 1]) {
				const m = new THREE.Mesh(cube, handleMat(0xf2f5fa));
				m.userData = { kind: 'corner', sx, sy, color: 0xf2f5fa };
				m.renderOrder = 30;
				this.scaleGroup.add(m);
				this.scaleHandles.push(m);
			}
		}

		// Rotate rings (world axes, centered on the selection)
		this.rotGroup = new THREE.Group();
		vp.helpers.add(this.rotGroup);
		this.rings = [];
		this.ringRadius = 0;
		this.sector = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: HOVER, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthTest: false, depthWrite: false }));
		this.sector.matrixAutoUpdate = false;
		this.sector.renderOrder = 28;
		this.sector.visible = false;
		vp.helpers.add(this.sector);
		// Protractor ticks: coarse steps inside the ring, 1° steps outside it
		this.ticks = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthTest: false, depthWrite: false }));
		this.ticks.matrixAutoUpdate = false;
		this.ticks.renderOrder = 29;
		this.ticks.visible = false;
		this.ticksKey = '';
		vp.helpers.add(this.ticks);

		// Dimension labels
		this.labels = [0, 1, 2].map((i) => {
			const l = document.createElement('div');
			l.className = 'vp-label dim dim-' + 'xyz'[i];
			l.title = 'Click to type an exact size';
			l.addEventListener('pointerdown', (e) => e.stopPropagation());
			l.addEventListener('click', (e) => { e.stopPropagation(); this.editDim(i, l); });
			vp.overlay.appendChild(l);
			return l;
		});
		this.angleLabel = document.createElement('div');
		this.angleLabel.className = 'vp-label angle';
		vp.overlay.appendChild(this.angleLabel);

		this.hovered = null;
		this.drag = null;
		this.editing = null;
	}

	get mode() {
		return this.vp.gizmoMode;
	}

	editableNodes() {
		const nodes = this.vp.selectedNodes();
		return nodes.length && !nodes.some((n) => n.locked) ? nodes : [];
	}

	// Frame of the selection: rotation+translation matrix F and a box in F's coordinates.
	// A single object uses its own orientation, so sizes match its own width/depth/height.
	frame() {
		const ids = this.vp.selection;
		if (!ids.length) return null;
		if (ids.length === 1) {
			const obj = this.vp.objs.get(ids[0]);
			const disp = this.vp.displays.get(ids[0]);
			const g = disp && disp.geometry;
			if (g && g.attributes.position) {
				if (!g.boundingBox) g.computeBoundingBox();
				obj.updateWorldMatrix(true, false);
				const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
				obj.matrixWorld.decompose(p, q, s);
				const F = new THREE.Matrix4().compose(p, q, new THREE.Vector3(1, 1, 1));
				const a = g.boundingBox.min.clone().multiply(s), b = g.boundingBox.max.clone().multiply(s);
				const box = new THREE.Box3(a.clone().min(b), a.max(b));
				return { F, box };
			}
		}
		const box = this.vp.selectionBox();
		if (box.isEmpty()) return null;
		return { F: new THREE.Matrix4(), box };
	}

	// ------------------------------------------------------------ per-frame overlay

	update() {
		const fr = this.drag ? this.drag.liveFrame() : this.frame();
		const show = !!fr;
		this.frameGroup.visible = show;
		if (!show) {
			for (const l of this.labels) l.style.display = 'none';
			this.rotGroup.visible = false;
			this.angleLabel.style.display = 'none';
			return;
		}
		const { F, box } = fr;
		this.frameGroup.matrix.copy(F);
		this.frameGroup.matrixWorldNeedsUpdate = true;
		this.boxHelper.box.copy(box);
		const { min, max } = box;
		const c = box.getCenter(new THREE.Vector3());
		const size = box.getSize(new THREE.Vector3());
		const W = (x, y, z) => new THREE.Vector3(x, y, z).applyMatrix4(F);
		const pts = [W(c.x, min.y, min.z), W(max.x, c.y, min.z), W(max.x, min.y, c.z)];
		const editable = this.editableNodes().length > 0 && !this.vp.tool;
		// Scale handles
		this.scaleGroup.visible = editable && this.mode === 'scale';
		if (this.scaleGroup.visible) {
			for (const h of this.scaleHandles) {
				const u = h.userData;
				if (u.kind === 'face') {
					const p = c.clone();
					p.setComponent(u.axis, u.side > 0 ? max.getComponent(u.axis) : min.getComponent(u.axis));
					h.position.copy(p);
				} else {
					h.position.set(u.sx > 0 ? max.x : min.x, u.sy > 0 ? max.y : min.y, min.z);
				}
				h.scale.setScalar(this.screenSize(h.position.clone().applyMatrix4(F), u.kind === 'face' ? 13 : 11));
			}
		}
		this.placeDimLabels(pts, W(c.x, c.y, c.z), size, F);
		// Rotate rings
		this.rotGroup.visible = editable && this.mode === 'rotate';
		if (this.rotGroup.visible) {
			const center = this.drag && this.drag.kind === 'rotate' ? this.drag.center : W(c.x, c.y, c.z);
			const R = this.drag && this.drag.kind === 'rotate' ? this.drag.R : Math.max(size.length() / 2 * 1.08, 4);
			if (Math.abs(R - this.ringRadius) > 1e-6 * R) this.buildRings(R);
			this.rotGroup.position.copy(center);
			// keep the ring stroke ~3px thick at any zoom
			const tube = this.screenSize(center, 1.6);
			for (const r of this.rings) {
				const vis = r.userData.visual;
				if (!vis.userData.tube || Math.abs(tube / vis.userData.tube - 1) > 0.2) {
					vis.geometry.dispose();
					vis.geometry = new THREE.TorusGeometry(R, tube, 6, 128);
					vis.userData.tube = tube;
				}
			}
		}
	}

	screenSize(world, px) {
		const vp = this.vp;
		const h = vp.container.clientHeight || 1;
		if (vp.camera.isOrthographicCamera) return ((vp.ortho.top - vp.ortho.bottom) / vp.ortho.zoom) * (px / h);
		const d = world.distanceTo(vp.camera.position);
		return 2 * d * Math.tan((vp.persp.fov * DEG) / 2) * (px / h);
	}

	buildRings(R) {
		this.ringRadius = R;
		for (const r of this.rings) {
			this.rotGroup.remove(r);
			r.geometry.dispose();
			r.userData.visual.geometry.dispose();
		}
		this.rings = [];
		for (let i = 0; i < 3; i++) {
			const visual = new THREE.Mesh(new THREE.TorusGeometry(R, R * 0.01, 6, 128), handleMat(AXIS_COLORS[i]));
			visual.renderOrder = 29;
			const pick = new THREE.Mesh(new THREE.TorusGeometry(R, Math.max(R * 0.07, 0.6), 6, 64), new THREE.MeshBasicMaterial({ visible: false }));
			pick.userData = { kind: 'ring', axis: i, visual, color: AXIS_COLORS[i] };
			pick.add(visual);
			// Torus lies in XY (normal Z). Orient so the ring's normal is the rotation axis.
			if (i === 0) pick.rotation.y = Math.PI / 2;
			if (i === 1) pick.rotation.x = Math.PI / 2;
			this.rotGroup.add(pick);
			this.rings.push(pick);
		}
	}

	// ------------------------------------------------------------ picking

	pickTargets() {
		if (!this.editableNodes().length) return [];
		if (this.mode === 'scale' && this.scaleGroup.visible) return this.scaleHandles;
		if (this.mode === 'rotate' && this.rotGroup.visible) return this.rings;
		return [];
	}

	pick(e) {
		const targets = this.pickTargets();
		if (!targets.length) return null;
		this.vp.helpers.updateMatrixWorld(true);
		if (this.mode === 'scale') {
			// Small handles: pick the nearest one within a comfortable screen radius.
			const r = this.vp.canvas.getBoundingClientRect();
			const mx = e.clientX - r.left, my = e.clientY - r.top;
			let best = null, bd = 14;
			for (const h of targets) {
				const p = this.vp.project(h.getWorldPosition(new THREE.Vector3()));
				if (p.behind) continue;
				const d = Math.hypot(p.x - mx, p.y - my);
				if (d < bd) { bd = d; best = h; }
			}
			return best;
		}
		this.vp.raycaster.setFromCamera(this.vp.ndc(e), this.vp.camera);
		const hits = this.vp.raycaster.intersectObjects(targets, false);
		return hits.length ? hits[0].object : null;
	}

	setHover(h) {
		if (this.hovered === h) return;
		const paint = (o, col) => {
			if (!o) return;
			const m = o.userData.visual ? o.userData.visual.material : o.material;
			m.color.setHex(col);
		};
		paint(this.hovered, this.hovered && this.hovered.userData.color);
		this.hovered = h;
		paint(h, HOVER);
		this.vp.invalidate();
	}

	/**
	 * Size labels sit by the middle of three box edges. Push each one outward (on screen, away from the box's
	 * middle) and further while it would still cover a scale grip, so the grips stay clickable.
	 */
	placeDimLabels(pts, center, size, F) {
		const vp = this.vp;
		const cs = vp.project(center);
		const grips = this.scaleGroup.visible ? this.scaleHandles.map((h) => vp.project(h.position.clone().applyMatrix4(F))).filter((p) => !p.behind) : [];
		for (let i = 0; i < 3; i++) {
			const l = this.labels[i];
			if (this.editing && this.editing.axis === i) { l.style.display = 'none'; continue; }
			const s = vp.project(pts[i]);
			let dx = s.x - cs.x, dy = s.y - cs.y;
			const len = Math.hypot(dx, dy);
			if (len < 1e-6) { dx = 0; dy = 1; } else { dx /= len; dy /= len; }
			// label half-size plus a grip's radius, and a few pixels of air
			const w = (l.offsetWidth || 40) / 2 + 10, h = (l.offsetHeight || 20) / 2 + 10;
			let k = 14;
			const covers = (x, y) => grips.some((g) => Math.abs(g.x - x) < w && Math.abs(g.y - y) < h);
			while (k < 90 && covers(s.x + dx * k, s.y + dy * k)) k += 6;
			vp.placeLabel(l, pts[i], fmt(size.getComponent(i), 2), { x: dx * k, y: dy * k });
		}
	}

	/** The resize cursor whose arrows point the way a grip moves on screen (from the current view). */
	resizeCursor(h) {
		const fr = this.frame();
		if (!fr) return 'move';
		const u = h.userData, { F, box } = fr;
		const p = h.position.clone().applyMatrix4(F);
		let dir;
		if (u.kind === 'face') dir = new THREE.Vector3().setComponent(u.axis, u.side);
		else { const c = box.getCenter(new THREE.Vector3()); dir = h.position.clone().sub(new THREE.Vector3(c.x, c.y, h.position.z)); }
		dir.transformDirection(F);
		const step = this.screenSize(p, 40);
		const a = this.vp.project(p), b = this.vp.project(p.clone().addScaledVector(dir, step));
		if (a.behind || b.behind) return 'move';
		const dx = b.x - a.x, dy = b.y - a.y;
		if (Math.hypot(dx, dy) < 3) return 'move'; // pointing straight at the viewer
		const deg = ((Math.atan2(dy, dx) * 180) / Math.PI + 180) % 180; // screen y points down
		if (deg < 22.5 || deg >= 157.5) return 'ew-resize';
		if (deg < 67.5) return 'nwse-resize';
		if (deg < 112.5) return 'ns-resize';
		return 'nesw-resize';
	}

	// Returns a cursor name when hovering a handle.
	hover(e) {
		if (this.drag) return null;
		const h = this.pick(e);
		this.setHover(h);
		if (!h) return null;
		const u = h.userData;
		if (u.kind === 'ring') {
			const step = this.vp.app.model.settings.rotSnap || 15;
			this.vp.app.onHint(`Rotate: drag on the ring for ${step}° steps · drag outside the ring for 1° steps · Alt: free`);
			return 'grab';
		}
		return this.resizeCursor(h);
	}

	pointerDown(e) {
		const h = this.pick(e);
		if (!h) return false;
		const u = h.userData;
		if (u.kind === 'ring') this.startRotate(e, u.axis);
		else this.startScale(e, u);
		return true;
	}

	items() {
		return this.editableNodes().map((n) => {
			const obj = this.vp.objs.get(n.id);
			obj.updateWorldMatrix(true, false);
			return { id: n.id, obj, start: obj.matrixWorld.clone() };
		});
	}

	applyWorld(items, M) {
		for (const it of items) {
			const m = M.clone().multiply(it.start);
			const parentInv = it.obj.parent.matrixWorld.clone().invert();
			parentInv.multiply(m).decompose(it.obj.position, it.obj.quaternion, it.obj.scale);
			it.obj.updateMatrixWorld(true);
		}
		this.vp.invalidate();
	}

	finish(items, isScale) {
		this.drag = null;
		this.sector.visible = false;
		this.ticks.visible = false;
		this.angleLabel.style.display = 'none';
		this.vp.controls.enabled = true;
		this.vp.canvas.style.cursor = '';
		this.vp.app.onObjectsTransformed(items.map(({ id, obj }) => ({ id, ...objTransformLocal(obj) })), isScale);
	}

	// ------------------------------------------------------------ scale

	snapSize(v, ev) {
		const snap = this.vp.app.model.settings.snap;
		if (snap > 0 && !ev.altKey) v = Math.round(v / snap) * snap;
		return Math.max(v, snap > 0 && !ev.altKey ? snap : 0.05);
	}

	startScale(e, u) {
		const fr = this.frame();
		if (!fr) return;
		const vp = this.vp;
		const { F, box } = fr;
		const Finv = F.clone().invert();
		const size0 = box.getSize(new THREE.Vector3());
		const c0 = box.getCenter(new THREE.Vector3());
		const items = this.items();
		const ray = () => vp.raycaster.ray;
		let lineP, lineD, plane, p0Frame, t0;
		if (u.kind === 'face') {
			const pf = c0.clone();
			pf.setComponent(u.axis, u.side > 0 ? box.max.getComponent(u.axis) : box.min.getComponent(u.axis));
			lineP = pf.applyMatrix4(F);
			lineD = AXES[u.axis].clone().multiplyScalar(u.side).transformDirection(F);
			vp.raycaster.setFromCamera(vp.ndc(e), vp.camera);
			t0 = closestOnLine(ray(), lineP, lineD);
		} else {
			const corner = new THREE.Vector3(u.sx > 0 ? box.max.x : box.min.x, u.sy > 0 ? box.max.y : box.min.y, box.min.z).applyMatrix4(F);
			plane = new THREE.Plane().setFromNormalAndCoplanarPoint(AXES[2].clone().transformDirection(F), corner);
			vp.raycaster.setFromCamera(vp.ndc(e), vp.camera);
			const hit = ray().intersectPlane(plane, new THREE.Vector3());
			if (!hit) return;
			p0Frame = hit.applyMatrix4(Finv);
		}
		let current = { F, box: box.clone() };
		this.drag = { kind: 'scale', liveFrame: () => current };
		vp.controls.enabled = false;
		let moved = false;
		const move = (ev) => {
			vp.raycaster.setFromCamera(vp.ndc(ev), vp.camera);
			const f = new THREE.Vector3(1, 1, 1);
			const anchor = new THREE.Vector3(c0.x, c0.y, box.min.z);
			if (u.kind === 'face') {
				const t = closestOnLine(ray(), lineP, lineD);
				if (t === null) return;
				const i = u.axis;
				const s0 = size0.getComponent(i);
				const s1 = this.snapSize(s0 + (t - t0), ev);
				f.setComponent(i, s1 / s0);
				if (ev.shiftKey) f.setScalar(s1 / s0);
				anchor.setComponent(i, u.side > 0 ? box.min.getComponent(i) : box.max.getComponent(i));
			} else {
				const hit = ray().intersectPlane(plane, new THREE.Vector3());
				if (!hit) return;
				const p = hit.applyMatrix4(Finv);
				const sx = this.snapSize(size0.x + (p.x - p0Frame.x) * u.sx, ev);
				const sy = this.snapSize(size0.y + (p.y - p0Frame.y) * u.sy, ev);
				f.set(sx / size0.x, sy / size0.y, 1);
				if (ev.shiftKey) { const k = Math.max(f.x, f.y); f.setScalar(k); }
				anchor.x = u.sx > 0 ? box.min.x : box.max.x;
				anchor.y = u.sy > 0 ? box.min.y : box.max.y;
			}
			moved = true;
			const S = new THREE.Matrix4().makeTranslation(anchor.x, anchor.y, anchor.z)
				.multiply(new THREE.Matrix4().makeScale(f.x, f.y, f.z))
				.multiply(new THREE.Matrix4().makeTranslation(-anchor.x, -anchor.y, -anchor.z));
			const M = F.clone().multiply(S).multiply(Finv);
			this.applyWorld(items, M);
			const nb = box.clone().applyMatrix4(S);
			current = { F, box: nb };
			const sz = nb.getSize(new THREE.Vector3());
			vp.app.onHint(`Size ${fmt(sz.x, 2)} × ${fmt(sz.y, 2)} × ${fmt(sz.z, 2)} mm   (Shift: proportional · Alt: no snap)`);
		};
		const up = () => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			if (moved) this.finish(items, true);
			else { this.drag = null; vp.controls.enabled = true; }
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
	}

	// Set an exact size along one axis of the selection frame (keeps the min side fixed).
	scaleTo(axis, value) {
		const fr = this.frame();
		if (!fr || !(value > 0)) return;
		const { F, box } = fr;
		const s0 = box.getSize(new THREE.Vector3()).getComponent(axis);
		if (!(s0 > 0)) return;
		const f = new THREE.Vector3(1, 1, 1);
		f.setComponent(axis, value / s0);
		const a = box.min;
		const S = new THREE.Matrix4().makeTranslation(a.x, a.y, a.z)
			.multiply(new THREE.Matrix4().makeScale(f.x, f.y, f.z))
			.multiply(new THREE.Matrix4().makeTranslation(-a.x, -a.y, -a.z));
		const items = this.items();
		if (!items.length) return;
		this.applyWorld(items, F.clone().multiply(S).multiply(F.clone().invert()));
		this.vp.app.onObjectsTransformed(items.map(({ id, obj }) => ({ id, ...objTransformLocal(obj) })), true);
	}

	editDim(axis, label) {
		if (!this.editableNodes().length) return;
		this.cancelEdit();
		const fr = this.frame();
		if (!fr) return;
		const cur = fr.box.getSize(new THREE.Vector3()).getComponent(axis);
		const inp = document.createElement('input');
		inp.type = 'text';
		inp.className = 'dim-edit dim-' + 'xyz'[axis];
		inp.value = fmt(cur, 3);
		inp.style.transform = label.style.transform;
		this.vp.overlay.appendChild(inp);
		this.editing = { axis, inp };
		const done = (apply) => {
			if (!this.editing || this.editing.inp !== inp) return;
			this.editing = null;
			const v = evalExpr(inp.value);
			inp.remove();
			if (apply && isFinite(v) && v > 0 && Math.abs(v - cur) > 1e-9) this.scaleTo(axis, v);
			this.vp.invalidate();
		};
		inp.addEventListener('keydown', (e) => {
			e.stopPropagation();
			if (e.key === 'Enter') done(true);
			else if (e.key === 'Escape') done(false);
			else if (e.key === 'Tab') {
				e.preventDefault();
				done(true);
				const next = (axis + (e.shiftKey ? 2 : 1)) % 3;
				requestAnimationFrame(() => { this.vp.render(); this.editDim(next, this.labels[next]); });
			}
		});
		inp.addEventListener('blur', () => done(true));
		inp.addEventListener('pointerdown', (e) => e.stopPropagation());
		setTimeout(() => { inp.focus(); inp.select(); }, 0);
		this.vp.invalidate();
	}

	cancelEdit() {
		if (this.editing) {
			const { inp } = this.editing;
			this.editing = null;
			inp.remove();
		}
	}

	// ------------------------------------------------------------ rotate

	startRotate(e, axisIdx) {
		const vp = this.vp;
		const axis = AXES[axisIdx];
		const center = this.rotGroup.position.clone();
		const R = this.ringRadius;
		const u = AXES[(axisIdx + 1) % 3], v = AXES[(axisIdx + 2) % 3];
		const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(axis, center);
		const angleAt = (ev) => {
			vp.raycaster.setFromCamera(vp.ndc(ev), vp.camera);
			const p = vp.raycaster.ray.intersectPlane(plane, new THREE.Vector3());
			if (!p) return null;
			p.sub(center);
			lastDist = Math.hypot(p.dot(u), p.dot(v));
			return Math.atan2(p.dot(v), p.dot(u));
		};
		let lastDist = R;
		const a0 = angleAt(e);
		if (a0 === null) return;
		const items = this.items();
		const fr0 = this.frame();
		let last = a0, total = 0, snapped = 0;
		this.drag = { kind: 'rotate', axis: axisIdx, center, R, liveFrame: () => this.frame() || fr0 };
		vp.controls.enabled = false;
		vp.canvas.style.cursor = 'grabbing';
		const basis = new THREE.Matrix4().makeBasis(u, v, axis).setPosition(center);
		const move = (ev) => {
			const a = angleAt(ev);
			if (a === null) return;
			let d = a - last;
			while (d > Math.PI) d -= 2 * Math.PI;
			while (d < -Math.PI) d += 2 * Math.PI;
			total += d;
			last = a;
			// Outside the ring (or Shift): 1° steps. On / inside the ring: the rotate snap (15° by default).
			const coarse = vp.app.model.settings.rotSnap || 0;
			const fine = ev.shiftKey || lastDist > R * FINE_RING;
			const snapDeg = ev.altKey ? 0 : fine ? 1 : coarse;
			this.drag.step = snapDeg;
			this.showTicks(basis, R, a0, ev.altKey ? 0 : fine ? 1 : coarse);
			let deg = total / DEG;
			if (snapDeg > 0) deg = Math.round(deg / snapDeg) * snapDeg;
			deg = Math.round(deg * 1e6) / 1e6;
			if (deg === snapped && ev.type !== 'pointerdown') { this.placeAngle(ev, deg); return; }
			snapped = deg;
			const M = new THREE.Matrix4().makeTranslation(center.x, center.y, center.z)
				.multiply(new THREE.Matrix4().makeRotationAxis(axis, deg * DEG))
				.multiply(new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z));
			this.applyWorld(items, M);
			// protractor sector
			this.sector.geometry.dispose();
			this.sector.geometry = new THREE.CircleGeometry(R * 0.98, 96, a0, deg * DEG);
			this.sector.matrix.copy(basis);
			this.sector.matrixWorldNeedsUpdate = true;
			this.sector.material.color.setHex(AXIS_COLORS[axisIdx]);
			this.sector.visible = true;
			this.placeAngle(ev, deg);
		};
		const up = () => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			if (snapped !== 0) this.finish(items, false);
			else {
				this.drag = null;
				this.sector.visible = false;
		this.ticks.visible = false;
				this.angleLabel.style.display = 'none';
				vp.controls.enabled = true;
				vp.canvas.style.cursor = '';
				vp.invalidate();
			}
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
	}

	// Tick marks around the ring in the rotation plane; zero at the grab angle a0.
	showTicks(basis, R, a0, step) {
		const key = [R, a0, step].join('|');
		if (key !== this.ticksKey) {
			this.ticksKey = key;
			const pos = [];
			const push = (a, r0, r1) => { const c = Math.cos(a), s = Math.sin(a); pos.push(c * r0, s * r0, 0, c * r1, s * r1, 0); };
			if (step === 1) {
				for (let k = 0; k < 360; k++) push(a0 + k * DEG, R * 1.04, R * (1.04 + (k % 15 === 0 ? 0.12 : k % 5 === 0 ? 0.07 : 0.035)));
			} else if (step > 0) {
				for (let k = 0; k * step < 360 - 1e-9; k++) push(a0 + k * step * DEG, R * 0.84, R * 0.96);
			}
			this.ticks.geometry.dispose();
			this.ticks.geometry = new THREE.BufferGeometry();
			this.ticks.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
		}
		this.ticks.matrix.copy(basis);
		this.ticks.matrixWorldNeedsUpdate = true;
		this.ticks.visible = step > 0;
	}

	placeAngle(ev, deg) {
		const r = this.vp.container.getBoundingClientRect();
		const l = this.angleLabel;
		l.style.display = 'block';
		const step = this.drag && this.drag.step;
		l.textContent = (deg > 0 ? '+' : '') + round(deg, 1) + '°' + (step ? `  (${step}° steps)` : '  (free)');
		const x = Math.max(4, Math.min(ev.clientX - r.left + 16, r.width - l.offsetWidth - 4)), y = Math.max(4, Math.min(ev.clientY - r.top - 18, r.height - l.offsetHeight - 4));
		l.style.transform = `translate(${x}px, ${y}px)`; // kept inside the view
		const ax = this.drag && this.drag.axis !== undefined ? 'XYZ'[this.drag.axis] : '';
		this.vp.app.onHint(`Rotate about ${ax}: ${round(deg, 1)}°   (on the ring: ${this.vp.app.model.settings.rotSnap || 15}° steps · outside the ring or Shift: 1° · Alt: free)`);
	}
}

const FINE_RING = 1.12; // beyond this fraction of the ring radius, rotation snaps in 1° steps

// Closest point on the line (P + t·d) to the ray; returns t (d must be unit length).
function closestOnLine(ray, P, d) {
	const r = ray.direction, w0 = P.clone().sub(ray.origin);
	const b = d.dot(r), dd = d.dot(w0), e = r.dot(w0);
	const denom = 1 - b * b;
	if (Math.abs(denom) < 1e-6) return null;
	return (b * e - dd) / denom;
}

function objTransformLocal(obj) {
	const e = new THREE.Euler().setFromQuaternion(obj.quaternion, 'XYZ');
	return {
		pos: [round(obj.position.x), round(obj.position.y), round(obj.position.z)],
		rot: [round(e.x / DEG, 3), round(e.y / DEG, 3), round(e.z / DEG, 3)],
		scale: [round(obj.scale.x, 5), round(obj.scale.y, 5), round(obj.scale.z, 5)],
	};
}
