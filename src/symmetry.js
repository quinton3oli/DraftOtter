// Modify → Symmetry: pick a point, and the selected part becomes mirror-symmetric about n planes through it (all
// containing one axis, 180°/n apart). Kept as a group in "symmetric" mode, so the planes, axis, angle and point
// stay editable; the engine keeps the wedge between the first two planes and mirrors it around (engine.symmetrize).
import * as THREE from 'three';
import { makeGroup } from './model.js';
import { symmetryPlanes } from './engine.js';
import { el, toast, round, fmt } from './util.js';
const $ = (s) => document.querySelector(s);

export const AXES = { z: [0, 0, 1], x: [1, 0, 0], y: [0, 1, 0] };
export const axisName = (a) => Object.keys(AXES).find((k) => AXES[k].every((v, i) => Math.abs(v - (a || [0, 0, 1])[i]) < 1e-9)) || 'custom';
const clampN = (v) => Math.max(1, Math.min(24, Math.round(+v) || 1));

export const SymmetryMixin = {
	startSymmetry() {
		const nodes = this.selectedNodes().filter((n) => this.model.isTopLevel(n.id));
		if (!nodes.length) { toast('Select the part to make symmetric first', 'warn'); return; }
		if (nodes.every((n) => n.hole)) { toast('Select a solid part (holes alone have no shape to mirror)', 'warn'); return; }
		this.symRepick = null;
		this.symPending = { ids: nodes.map((n) => n.id), n: this.symLast || 2 };
		if (this.tool !== 'sympoint') this.setTool('sympoint');
		this.symBar();
	},

	/** The floating bar while picking the point (also used to pick a new point for an existing symmetric group). */
	symBar() {
		let bar = $('#sym-bar');
		if (!bar) { bar = el('div', { id: 'sym-bar', class: 'float-bar' }); $('#viewport').appendChild(bar); }
		bar.style.display = '';
		bar.innerHTML = '';
		if (this.symRepick) {
			bar.append(el('b', {}, 'Symmetry'), el('span', { class: 'muted' }, 'Click the new point for the planes'), el('button', { class: 'btn sm', onclick: () => this.setTool(null) }, 'Cancel'));
			return;
		}
		const st = this.symPending;
		const nIn = el('input', { id: 'sym-n', type: 'number', min: 1, max: 24, step: 1, value: st.n, class: 'num', style: 'width:56px', title: 'Number of mirror planes' });
		nIn.addEventListener('keydown', (e) => e.stopPropagation());
		nIn.addEventListener('change', () => { st.n = clampN(nIn.value); nIn.value = st.n; });
		bar.append(el('b', {}, 'Symmetry'), el('span', { class: 'muted' }, 'Click the point the planes go through'),
			el('span', { class: 'muted' }, 'Planes'), nIn,
			el('button', { class: 'btn sm', title: 'Use the center of the selection', onclick: () => { st.n = clampN(nIn.value); this.applySymmetry(null); } }, 'Use center'),
			el('button', { class: 'btn sm', onclick: () => this.setTool(null) }, 'Cancel'));
	},

	hideSymBar() {
		const bar = $('#sym-bar');
		if (bar) bar.style.display = 'none';
	},

	/** A click in the view while picking. */
	onSymClick(sp) {
		if (!sp) return;
		const P = sp.point.clone();
		if (this.symRepick) {
			const n = this.model.get(this.symRepick);
			this.symRepick = null;
			this.setTool(null);
			if (!n) return;
			const local = P.applyMatrix4(this.worldMatrix(n).invert());
			n.sym = { ...(n.sym || {}), center: [round(local.x, 4), round(local.y, 4), round(local.z, 4)] };
			this.commit();
			return;
		}
		const nIn = $('#sym-n');
		if (nIn && this.symPending) this.symPending.n = clampN(nIn.value);
		this.applySymmetry(P);
	},

	/** Wrap the picked parts in a symmetric group through world point P (null: the selection's center). */
	applySymmetry(P) {
		const st = this.symPending;
		if (!st) return;
		const nodes = st.ids.map((id) => this.model.get(id)).filter(Boolean);
		this.symPending = null;
		this.setTool(null);
		if (!nodes.length) return;
		this.symLast = st.n;
		const box = new THREE.Box3();
		for (const n of nodes) box.union(this.worldBox(n));
		const c = box.getCenter(new THREE.Vector3());
		const point = P || c.clone();
		const list = this.model.nodes, idx = Math.min(...nodes.map((n) => list.indexOf(n)));
		for (const n of nodes) list.splice(list.indexOf(n), 1);
		for (const n of nodes) { n.pos = [round(n.pos[0] - c.x), round(n.pos[1] - c.y), round(n.pos[2] - c.z)]; n.locked = false; }
		const first = nodes.find((n) => !n.hole) || nodes[0];
		const g = makeGroup(nodes, { mode: 'symmetric', name: `Symmetric ×${st.n}`, color: first.color });
		g.pos = [round(c.x), round(c.y), round(c.z)];
		g.sym = { n: st.n, axis: [0, 0, 1], angle: 0, center: [round(point.x - c.x, 4), round(point.y - c.y, 4), round(point.z - c.z, 4)] };
		list.splice(idx, 0, g);
		this.sel = [g.id];
		this.commit();
		const geo = this.engine.geometry(g);
		if (!geo || !geo.attributes.position || !geo.attributes.position.count) toast('Nothing is left in the kept wedge — change the first plane’s angle or the point', 'warn', 6000);
		else toast(`Mirrored across ${st.n} plane${st.n > 1 ? 's' : ''} through the point. Change them in Properties → Symmetry.`, 'ok', 4500);
	},

	/** Properties → Symmetry for a symmetric group. */
	symmetryProps(host, n) {
		const sec = this.section(host, 'Symmetry');
		if (!n.sym) n.sym = { n: 2, axis: [0, 0, 1], angle: 0, center: [0, 0, 0] };
		const sym = () => n.sym;
		const set = (fn) => { const s = { ...sym() }; fn(s); n.sym = s; if (/^Symmetric ×\d+$/.test(n.name)) n.name = `Symmetric ×${s.n}`; this.commit(); };
		const nIn = this.numInput(sym().n, (v) => { if (v >= 1) set((s) => (s.n = clampN(v))); }, 1);
		sec.appendChild(el('label', { class: 'field' }, el('span', { class: 'lbl' }, 'Mirror planes'), nIn));
		const ax = el('select', {}, el('option', { value: 'z' }, 'Z (vertical)'), el('option', { value: 'x' }, 'X'), el('option', { value: 'y' }, 'Y'), ...(axisName(sym().axis) === 'custom' ? [el('option', { value: 'custom' }, 'Custom')] : []));
		ax.value = axisName(sym().axis);
		ax.addEventListener('change', () => { if (AXES[ax.value]) set((s) => (s.axis = [...AXES[ax.value]])); });
		sec.appendChild(el('label', { class: 'field' }, el('span', { class: 'lbl' }, 'Planes share axis'), ax));
		const aIn = this.numInput(sym().angle || 0, (v) => set((s) => (s.angle = round(v, 4))), 5);
		sec.appendChild(el('label', { class: 'field' }, el('span', { class: 'lbl' }, 'First plane °'), aIn));
		const cIns = [0, 1, 2].map((i) => this.numInput(sym().center[i], (v) => set((s) => { s.center = [...s.center]; s.center[i] = round(v, 4); }), 1));
		cIns.forEach((inp, i) => sec.appendChild(el('label', { class: 'field' }, el('span', { class: 'lbl' }, `Point ${'XYZ'[i]} (in group)`), inp)));
		this.fields.push({ refresh: () => {
			const s = sym();
			if (nIn._setValue) nIn._setValue(s.n);
			if (aIn._setValue) aIn._setValue(s.angle || 0);
			cIns.forEach((c, i) => c._setValue && c._setValue(s.center[i]));
			ax.value = axisName(s.axis);
		} });
		sec.appendChild(el('div', { class: 'btn-row wrap' },
			el('button', { class: 'btn sm', title: 'Keep the neighboring wedge instead (turns the planes by half their spacing)', onclick: () => set((s) => (s.angle = round((s.angle || 0) + 90 / s.n, 4))) }, 'Keep other side'),
			el('button', { class: 'btn sm', title: 'Click a new point for the planes', onclick: () => { this.symRepick = n.id; this.symPending = null; this.setTool('sympoint'); this.symBar(); } }, 'Pick point…')));
		sec.appendChild(el('div', { class: 'muted small pad-x' }, `The wedge between the first two planes (${fmt(180 / sym().n, 2)}° wide) is kept and mirrored around. Planes show in the view while the group is selected.`));
	},
};

/** The planes of a symmetric group as see-through quads, an axis line and the point (in the group's frame). */
export function symmetryHelper(group, size) {
	const { A, C, planes } = symmetryPlanes(group.sym || {});
	const out = new THREE.Group();
	const L = Math.max(size, 10) * 0.42;
	planes.forEach(({ d }, i) => {
		const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([s, t]) => C.clone().addScaledVector(d, s * L).addScaledVector(A, t * L));
		const col = i === 0 ? 0x19b8b4 : 0x4fd1ff;
		const geo = new THREE.BufferGeometry().setFromPoints([pts[0], pts[1], pts[2], pts[0], pts[2], pts[3]]);
		out.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: i === 0 ? 0.16 : 0.1, side: THREE.DoubleSide, depthWrite: false })));
		out.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.7, depthWrite: false })));
	});
	const axis = new THREE.Line(new THREE.BufferGeometry().setFromPoints([C.clone().addScaledVector(A, -L * 1.15), C.clone().addScaledVector(A, L * 1.15)]), new THREE.LineDashedMaterial({ color: 0xffcc33, dashSize: L * 0.07, gapSize: L * 0.05, depthTest: false }));
	axis.computeLineDistances();
	out.add(axis);
	const dot = new THREE.Mesh(new THREE.SphereGeometry(Math.max(0.4, L * 0.02), 12, 8), new THREE.MeshBasicMaterial({ color: 0xffcc33, depthTest: false }));
	dot.position.copy(C);
	out.add(dot);
	out.traverse((o) => { o.raycast = () => {}; o.renderOrder = 5; });
	return out;
}
