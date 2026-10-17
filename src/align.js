// Visual align mode: dots around the selection for min / center / max on each axis.
// Hover a dot to preview the result, click to apply. Click a selected object to make it the anchor.
import * as THREE from 'three';

const AXIS = ['x', 'y', 'z'];
const COLORS = [0xef6a5f, 0x5ccb6f, 0x4aa3ff];
const HOVER = 0xffd23f;
const WHERE = ['min', 'center', 'max'];
const NAMES = {
	x: ['Align left edges', 'Center along X', 'Align right edges'],
	y: ['Align front edges', 'Center along Y', 'Align back edges'],
	z: ['Align bottoms', 'Center along Z', 'Align tops'],
};

export class AlignTool {
	constructor(vp) {
		this.vp = vp;
		this.active = false;
		this.key = null;
		this.hovered = null;
		this.preview = null;
		this.box = null;

		this.group = new THREE.Group();
		this.group.visible = false;
		vp.helpers.add(this.group);

		const dot = new THREE.SphereGeometry(1, 16, 12);
		this.dots = [];
		this.rails = [];
		for (let a = 0; a < 3; a++) {
			const rail = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: COLORS[a], depthTest: false, transparent: true, opacity: 0.7 }));
			rail.renderOrder = 31;
			this.group.add(rail);
			this.rails.push(rail);
			for (let w = 0; w < 3; w++) {
				const m = new THREE.Mesh(dot, new THREE.MeshBasicMaterial({ color: COLORS[a], depthTest: false, transparent: true }));
				m.renderOrder = 32;
				m.userData = { axis: a, where: w };
				this.group.add(m);
				this.dots.push(m);
			}
		}

		this.guide = new THREE.LineLoop(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: HOVER, dashSize: 2, gapSize: 1.5, depthTest: false, transparent: true }));
		this.guide.renderOrder = 33;
		this.guide.visible = false;
		vp.helpers.add(this.guide);

		this.keyBox = new THREE.Box3Helper(new THREE.Box3(), HOVER);
		Object.assign(this.keyBox.material, { depthTest: false, transparent: true });
		this.keyBox.renderOrder = 33;
		this.keyBox.visible = false;
		vp.helpers.add(this.keyBox);

		this.tip = document.createElement('div');
		this.tip.className = 'vp-label align-tip';
		vp.overlay.appendChild(this.tip);
	}

	setActive(on) {
		this.clearPreview();
		this.active = on;
		this.key = null;
		this.refresh();
	}

	nodes() {
		return this.vp.selectedNodes().filter((n) => !n.locked);
	}

	// Called whenever the selection or scene changes.
	refresh() {
		this.preview = null; // objects may have been rebuilt; nothing to restore
		this.hovered = null;
		this.tip.style.display = 'none';
		this.guide.visible = false;
		const nodes = this.nodes();
		if (this.key && !nodes.some((n) => n.id === this.key)) this.key = null;
		this.box = this.active && nodes.length ? this.vp.selectionBox(nodes.map((n) => n.id)) : null;
		const show = !!(this.box && !this.box.isEmpty());
		this.group.visible = show;
		// With one object we align to the bed, where only "bottom" makes sense vertically.
		for (const d of this.dots) {
			d.visible = !(nodes.length === 1 && d.userData.axis === 2 && d.userData.where !== 0);
			d.material.color.setHex(COLORS[d.userData.axis]);
		}
		this.keyBox.visible = false;
		if (show && this.key) {
			this.keyBox.box.copy(this.vp.selectionBox([this.key]));
			this.keyBox.visible = true;
		}
		this.vp.app.onAlignState(this.active, nodes, this.key);
		this.vp.invalidate();
	}

	// Per-frame: place dots at a constant screen offset from the selection box.
	update() {
		if (!this.group.visible || !this.box) return;
		const B = this.box;
		const c = B.getCenter(new THREE.Vector3());
		const off = this.vp.handles.screenSize(c, 30);
		const r = this.vp.handles.screenSize(c, 6);
		const pos = (a, w) => {
			const t = [B.min, c, B.max][w];
			if (a === 0) return new THREE.Vector3(t.x, B.min.y - off, B.min.z);
			if (a === 1) return new THREE.Vector3(B.max.x + off, t.y, B.min.z);
			return new THREE.Vector3(B.max.x + off, B.min.y - off, t.z);
		};
		for (const d of this.dots) {
			d.position.copy(pos(d.userData.axis, d.userData.where));
			d.scale.setScalar(d === this.hovered ? r * 1.6 : r);
		}
		for (let a = 0; a < 3; a++) {
			const vis = this.dots.filter((d) => d.userData.axis === a && d.visible);
			this.rails[a].geometry.setFromPoints([vis[0].position, vis[vis.length - 1].position]);
			this.rails[a].visible = vis.length > 1;
		}
	}

	pick(e) {
		if (!this.group.visible) return null;
		const rect = this.vp.canvas.getBoundingClientRect();
		const mx = e.clientX - rect.left, my = e.clientY - rect.top;
		let best = null, bd = 16;
		for (const d of this.dots) {
			if (!d.visible) continue;
			const p = this.vp.project(d.position);
			if (p.behind) continue;
			const dist = Math.hypot(p.x - mx, p.y - my);
			if (dist < bd) { bd = dist; best = d; }
		}
		return best;
	}

	// Returns a cursor name, or null when not over a dot.
	hover(e) {
		const d = this.pick(e);
		if (d !== this.hovered) {
			this.clearPreview();
			if (this.hovered) this.hovered.material.color.setHex(COLORS[this.hovered.userData.axis]);
			this.hovered = d;
			if (d) {
				d.material.color.setHex(HOVER);
				this.showPreview(d.userData.axis, d.userData.where);
			}
			this.vp.invalidate();
		}
		if (d) {
			const rect = this.vp.container.getBoundingClientRect();
			this.tip.style.transform = `translate(${e.clientX - rect.left + 16}px, ${e.clientY - rect.top + 14}px)`;
		}
		return d ? 'pointer' : null;
	}

	showPreview(a, w) {
		const app = this.vp.app;
		const { moves, ref, target } = app.alignPlan(AXIS[a], WHERE[w], this.key);
		this.preview = moves.map(({ node, d }) => {
			const obj = this.vp.objs.get(node.id);
			const orig = obj.position.clone();
			const wp = obj.getWorldPosition(new THREE.Vector3()).add(d);
			obj.position.copy(obj.parent.worldToLocal(wp));
			obj.updateMatrixWorld(true);
			return { obj, orig };
		});
		// Dashed guide on the alignment plane, spanning the selection and reference.
		const span = this.box.clone().union(ref);
		const pad = this.vp.handles.screenSize(span.getCenter(new THREE.Vector3()), 10);
		span.expandByScalar(pad);
		const P = (u, v) => {
			const p = new THREE.Vector3();
			p.setComponent(a, target);
			const ax = [0, 1, 2].filter((i) => i !== a);
			p.setComponent(ax[0], u ? span.max.getComponent(ax[0]) : span.min.getComponent(ax[0]));
			p.setComponent(ax[1], v ? span.max.getComponent(ax[1]) : span.min.getComponent(ax[1]));
			return p;
		};
		this.guide.geometry.setFromPoints([P(0, 0), P(1, 0), P(1, 1), P(0, 1)]);
		this.guide.computeLineDistances();
		this.guide.material.dashSize = pad * 0.8;
		this.guide.material.gapSize = pad * 0.5;
		this.guide.visible = true;
		const to = this.key ? `to “${app.model.get(this.key).name}”` : moves.length === 1 && !this.key && this.nodes().length === 1 ? 'to the bed' : '';
		this.tip.textContent = `${NAMES[AXIS[a]][w]} ${to}`.trim() + (moves.length ? '' : ' (already aligned)');
		this.tip.style.display = 'block';
		this.vp.invalidate();
	}

	clearPreview() {
		if (this.preview) {
			for (const { obj, orig } of this.preview) {
				obj.position.copy(orig);
				obj.updateMatrixWorld(true);
			}
		}
		this.preview = null;
		this.guide.visible = false;
		this.tip.style.display = 'none';
		this.vp.invalidate();
	}

	click(e) {
		const d = this.pick(e);
		if (d) {
			this.clearPreview();
			this.vp.app.align(AXIS[d.userData.axis], WHERE[d.userData.where], this.key);
			return;
		}
		const hit = this.vp.raycast(e, this.vp.pickables());
		if (!hit) return;
		const id = hit.object.userData.nodeId;
		if (this.vp.selection.includes(id)) {
			if (this.vp.selection.length < 2) return;
			this.key = this.key === id ? null : id;
			this.refresh();
		} else {
			this.vp.app.onPick(id, true); // add it to the selection
		}
	}
}
