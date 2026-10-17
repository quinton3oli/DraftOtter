// Assemblies: mate parts (face to face, rim to rim / into holes, axis to axis), hinge and slider joints with a
// motion slider, interference checks, and a collision sweep across a joint's range of motion.
import * as THREE from 'three';
import { faceRegion } from './pushpull.js';
import { roundFeatureAt } from './measureGeo.js';
import { overlapOf, nodeMatrix } from './engine.js';
import { download } from './util.js';
import { fmt, round, toast, el, evalExpr } from './util.js';
const DEG_ = Math.PI / 180;

const DEG = Math.PI / 180;

/** What was clicked: a flat face (center + normal), a circle on a flat face, or a cylinder axis. */
export function mateFeature(sp) {
	if (!sp || !sp.object) return null;
	const mesh = sp.object;
	const f = roundFeatureAt(mesh, sp.faceIndex, sp.point);
	if (f && f.kind === 'cylinder') return { kind: 'axis', center: f.center.clone(), dir: f.normal.clone().normalize(), r: f.r };
	if (f && (f.kind === 'circle' || f.kind === 'arc') && f.loopDist !== undefined) {
		// a rim: use the circle's center on the face plane
		return { kind: 'circle', center: f.center.clone(), dir: sp.normal.clone().normalize(), r: f.r };
	}
	const reg = faceRegion(mesh, sp.faceIndex);
	if (reg && !reg.curved && reg.tris.length) {
		// area-weighted centroid of the flat face
		const t = reg.tris, c = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), d = new THREE.Vector3();
		let A = 0;
		for (let i = 0; i < t.length; i += 9) {
			a.set(t[i], t[i + 1], t[i + 2]); b.set(t[i + 3], t[i + 4], t[i + 5]); d.set(t[i + 6], t[i + 7], t[i + 8]);
			const ar = b.clone().sub(a).cross(d.clone().sub(a)).length() / 2;
			c.addScaledVector(a.clone().add(b).add(d), ar / 3);
			A += ar;
		}
		if (A > 0) return { kind: 'face', center: c.multiplyScalar(1 / A), dir: sp.normal.clone().normalize() };
	}
	return { kind: 'point', center: sp.point.clone(), dir: sp.normal.clone().normalize() };
}

/**
 * World transform that mates feature `a` (on the moving part) to feature `b` (fixed).
 * Faces / rims end up facing each other and centered (flip = same side instead); axes become collinear
 * (the moving part keeps its position along the axis). spin turns about the mate axis, offset moves along it.
 */
export function mateMatrix(a, b, { flip = false, spin = 0, offset = 0 } = {}) {
	const axial = a.kind === 'axis' || b.kind === 'axis';
	const nB = b.dir.clone().normalize();
	let target;
	if (axial) target = a.dir.dot(nB) >= 0 ? nB.clone() : nB.clone().negate();
	else target = nB.clone().negate();
	if (flip) target.negate();
	const q = new THREE.Quaternion().setFromUnitVectors(a.dir.clone().normalize(), target);
	if (a.dir.clone().normalize().dot(target) < -0.999999) {
		// 180° turn: pick any axis perpendicular to the direction
		const perp = Math.abs(target.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
		q.setFromAxisAngle(perp.cross(target).normalize(), Math.PI);
	}
	const R = new THREE.Matrix4().makeRotationFromQuaternion(q);
	const ca = a.center.clone().applyMatrix4(R);
	let t = b.center.clone().sub(ca);
	if (axial) t.addScaledVector(nB, -t.dot(nB)); // keep the axial position: only make the axes coincide
	t.addScaledVector(nB, offset);
	const M = new THREE.Matrix4().makeTranslation(t.x, t.y, t.z).multiply(R);
	if (spin) {
		const c = b.center;
		M.premultiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z)).premultiply(new THREE.Matrix4().makeRotationAxis(nB, spin * DEG)).premultiply(new THREE.Matrix4().makeTranslation(c.x, c.y, c.z));
	}
	return M;
}

/** Motion of a joint by `delta` (degrees for hinges, mm for sliders) as a world matrix. */
export function jointMotion(j, delta) {
	const o = new THREE.Vector3(...j.origin), ax = new THREE.Vector3(...j.axis).normalize();
	if (j.type === 'slider') return new THREE.Matrix4().makeTranslation(ax.x * delta, ax.y * delta, ax.z * delta);
	return new THREE.Matrix4().makeTranslation(o.x, o.y, o.z).multiply(new THREE.Matrix4().makeRotationAxis(ax, delta * DEG)).multiply(new THREE.Matrix4().makeTranslation(-o.x, -o.y, -o.z));
}

export const AssemblyMixin = {
	// ------------------------------------------------------------ mate tool
	startMate() {
		this.mateState = { a: null };
		this.setTool('mate');
		this.onHint('Mate: click a face, rim or shaft on the part to MOVE, then the face / hole it should attach to. Esc to cancel.');
	},

	onMateClick(sp) {
		if (!sp || !sp.object) return;
		const id = sp.object.userData.nodeId;
		const top = id ? this.model.topLevelOf(id) : null;
		if (!top) return;
		const f = mateFeature(sp);
		if (!f) return;
		const st = this.mateState || (this.mateState = { a: null });
		if (!st.a) {
			if (top.locked) { toast('That part is locked', 'warn'); return; }
			st.a = { node: top, f };
			this.setSelection([top.id]);
			this.onHint(`Moving “${top.name}” (${f.kind === 'axis' ? 'shaft / hole axis' : f.kind === 'circle' ? 'round rim' : 'face'}). Now click where it should attach.`);
			return;
		}
		if (top.id === st.a.node.id) { toast('Pick a face on a different part', 'warn'); return; }
		const node = st.a.node;
		const base = this.worldMatrix(node);
		this.mate = { node, a: st.a.f, b: f, base, flip: false, spin: 0, offset: 0, target: top, keep: true };
		this.mateState = null;
		this.setTool(null);
		this.applyMate();
		this.showMateBar();
	},

	applyMate() {
		const m = this.mate;
		if (!m) return;
		const M = mateMatrix(m.a, m.b, m).multiply(m.base);
		this.setWorldMatrix(m.node, M);
		this.setAttachment(m.node, m.keep ? m.target : null, M);
		this.commit();
	},

	// ------------------------------------------------------------ persistent mates (rigid attachment)
	/** Attach part `node` to part `base` at its world matrix M (or detach with base = null). */
	setAttachment(node, base, M = nodeMatrix(node)) {
		const doc = this.model.doc;
		doc.mates = (doc.mates || []).filter((x) => x.node !== node.id);
		if (!base) return null;
		const Mb = nodeMatrix(base);
		const rel = Mb.clone().invert().multiply(M);
		const mate = { id: Math.random().toString(36).slice(2, 10), node: node.id, base: base.id, rel: rel.toArray().map((v) => +v.toFixed(9)) };
		doc.mates.push(mate);
		return mate;
	},

	/**
	 * Keep attached parts with their base parts (run on every change). If the attached part itself was moved
	 * (and its base was not), it is re-attached where it now is.
	 */
	solveMates() {
		const doc = this.model.doc, mates = doc.mates || [];
		if (!mates.length) return;
		doc.mates = mates.filter((m) => this.model.isTopLevel(m.node) && this.model.isTopLevel(m.base));
		const same = (a, b) => a && b && a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
		for (let pass = 0; pass < 3; pass++) {
			for (const m of doc.mates) {
				const node = this.model.get(m.node), base = this.model.get(m.base);
				const Mb = nodeMatrix(base), Mn = nodeMatrix(node);
				const b = Mb.toArray(), n = Mn.toArray();
				if (pass === 0 && m.lastB && m.lastN && !same(n, m.lastN) && same(b, m.lastB)) m.rel = Mb.clone().invert().multiply(Mn).toArray().map((v) => +v.toFixed(9));
				const W = Mb.clone().multiply(new THREE.Matrix4().fromArray(m.rel));
				const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
				W.decompose(p, q, s);
				const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
				const next = { pos: p.toArray().map((v) => round(v)), rot: [e.x, e.y, e.z].map((v) => round(v / DEG_, 3)), scale: s.toArray().map((v) => round(v, 5)) };
				if (node.exprs) for (const k of Object.keys(node.exprs)) if (/^(pos|rot|scale)\./.test(k)) delete node.exprs[k];
				Object.assign(node, next);
				m.lastB = b.map((v) => +v.toFixed(9));
				m.lastN = nodeMatrix(node).toArray().map((v) => +v.toFixed(9));
			}
		}
	},

	// ------------------------------------------------------------ exploded view (display only)
	toggleExplode(on = !this.explodeOn) {
		this.explodeOn = on;
		let bar = document.querySelector('#explode-bar');
		if (!on) { if (bar) bar.style.display = 'none'; this.vp.setExplode(null); return; }
		if (!bar) { bar = el('div', { id: 'explode-bar', class: 'float-bar' }); document.querySelector('#viewport').appendChild(bar); }
		bar.innerHTML = '';
		const slider = el('input', { type: 'range', min: 0, max: 100, value: Math.round((this.explodeFactor ?? 0.6) * 100), style: 'width:180px' });
		const apply = () => { this.explodeFactor = slider.value / 100; this.vp.setExplode(this.explodeOffsets(this.explodeFactor)); };
		slider.addEventListener('input', apply);
		bar.append(el('b', {}, 'Exploded view'), el('span', { class: 'muted' }, 'spread'), slider, el('span', { class: 'muted' }, 'display only — the design is unchanged'), el('button', { class: 'btn sm primary', onclick: () => this.toggleExplode(false) }, 'Done'));
		bar.style.display = '';
		apply();
	},

	/** Offsets that push each visible part away from the center of the assembly. */
	explodeOffsets(f) {
		const parts = this.model.nodes.filter((n) => n.visible && !n.hole);
		const boxes = parts.map((n) => ({ n, b: this.worldBox(n) })).filter((x) => !x.b.isEmpty());
		const all = new THREE.Box3();
		for (const x of boxes) all.union(x.b);
		const c = all.getCenter(new THREE.Vector3()), size = all.getSize(new THREE.Vector3()).length() || 1;
		const out = new Map();
		for (const x of boxes) {
			const d = x.b.getCenter(new THREE.Vector3()).sub(c);
			if (d.length() < 1e-6) d.set(0, 0, 1).multiplyScalar(size * 0.05);
			out.set(x.n.id, d.multiplyScalar(f * 1.2).add(d.clone().normalize().multiplyScalar(f * size * 0.15)));
		}
		return out;
	},

	// ------------------------------------------------------------ bill of materials
	bomRows() {
		const s = this.model.settings;
		const rows = new Map();
		for (const n of this.model.nodes.filter((x) => x.visible && !x.hole)) {
			const key = this.engine.key(n) + '|' + n.scale.map((v) => +v.toFixed(4)).join(',');
			if (!rows.has(key)) {
				const st = this.engine.stats([n]), size = st.box.isEmpty() ? null : st.box.getSize(new THREE.Vector3());
				rows.set(key, { name: n.name || n.type, qty: 0, size: size ? [size.x, size.y, size.z] : [0, 0, 0], volume: st.volume / 1000, mass: (st.volume / 1000) * s.density, color: n.color });
			}
			rows.get(key).qty++;
		}
		return [...rows.values()];
	},

	bomDialog() {
		const rows = this.bomRows();
		if (!rows.length) { toast('Nothing in the design yet', 'warn'); return; }
		const totalQ = rows.reduce((a, r) => a + r.qty, 0), totalM = rows.reduce((a, r) => a + r.qty * r.mass, 0);
		const table = el('table', { class: 'bom' },
			el('thead', {}, el('tr', {}, ...['#', 'Part', 'Qty', 'Size (mm)', 'Volume (cm³)', 'Mass (g, each)'].map((h) => el('th', {}, h)))),
			el('tbody', {}, ...rows.map((r, i) => el('tr', {},
				el('td', {}, String(i + 1)), el('td', {}, el('span', { class: 'swatch', style: { background: r.color } }), ' ', r.name), el('td', {}, String(r.qty)),
				el('td', {}, r.size.map((v) => fmt(v, 1)).join(' × ')), el('td', {}, fmt(r.volume, 2)), el('td', {}, fmt(r.mass, 1))))),
			el('tfoot', {}, el('tr', {}, el('td', {}), el('td', {}, 'Total'), el('td', {}, String(totalQ)), el('td', {}), el('td', {}), el('td', {}, fmt(totalM, 1) + ' g'))));
		const csv = () => ['Item,Part,Qty,Size X (mm),Size Y (mm),Size Z (mm),Volume (cm3),Mass each (g)', ...rows.map((r, i) => [i + 1, '"' + r.name.replace(/"/g, '""') + '"', r.qty, ...r.size.map((v) => v.toFixed(2)), r.volume.toFixed(3), r.mass.toFixed(2)].join(','))].join('\n');
		this.modal('Bill of materials', el('div', {}, el('p', { class: 'muted small' }, `${rows.length} different part${rows.length > 1 ? 's' : ''}, ${totalQ} in total. Identical parts are counted together. Mass uses the material density from Settings (${this.model.settings.density} g/cm³, 100% infill).`), table),
			[{ label: 'Close' }, { label: 'Download CSV', primary: true, action: () => { download(csv(), (this.model.doc.name || 'design').replace(/[^\w\- ]+/g, '_') + '_BOM.csv', 'text/csv'); return false; } }], 'wide');
		return rows;
	},

	showMateBar() {
		const m = this.mate;
		let bar = document.querySelector('#mate-bar');
		if (!bar) { bar = el('div', { id: 'mate-bar', class: 'float-bar' }); document.querySelector('#viewport').appendChild(bar); }
		bar.innerHTML = '';
		const axial = m.a.kind === 'axis' || m.b.kind === 'axis' || (m.a.kind === 'circle' && m.b.kind === 'circle');
		const off = el('input', { type: 'text', class: 'num', value: m.offset, style: 'width:54px', title: 'Gap / offset along the mate direction (mm)' });
		off.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') off.blur(); });
		off.addEventListener('change', () => { const v = evalExpr(off.value, this.varValues || {}); if (isFinite(v)) { m.offset = v; this.applyMate(); } });
		const b = (label, title, fn, cls = '') => el('button', { class: 'btn sm ' + cls, title, onclick: fn }, label);
		bar.append(el('b', {}, 'Mate'), el('span', { class: 'muted' }, `“${m.node.name}” → “${m.target.name}”`),
			b('Flip', 'Put it on the other side / reverse the direction', () => { m.flip = !m.flip; this.applyMate(); }),
			b('↻ 90°', 'Turn it 90° about the mate axis', () => { m.spin = (m.spin + 90) % 360; this.applyMate(); }),
			el('label', { class: 'muted' }, 'Offset ', off, ' mm'),
			el('label', { class: 'muted', title: 'Keep it attached: it moves with the part it is mated to' }, (() => { const c = el('input', { type: 'checkbox', checked: m.keep }); c.addEventListener('change', () => { m.keep = c.checked; this.applyMate(); }); return c; })(), ' keep attached'),
			el('span', { class: 'sep' }),
			b(axial ? 'Make hinge' : 'Make hinge here', 'Keep it attached and let it rotate about this axis', () => this.jointFromMate('hinge')),
			b('Make slider', 'Keep it attached and let it slide along this direction', () => this.jointFromMate('slider')),
			b('Done', '', () => this.endMate(), 'primary'));
		bar.style.display = '';
	},

	endMate() {
		this.mate = null;
		const bar = document.querySelector('#mate-bar');
		if (bar) bar.style.display = 'none';
	},

	jointFromMate(type) {
		const m = this.mate;
		if (!m) return;
		const axis = m.b.dir.clone().normalize();
		this.setAttachment(m.node, null); // the joint drives it now
		this.addJoint({ type: type === 'hinge' ? 'hinge' : 'slider', node: m.node, origin: m.b.center.clone(), axis, name: `${m.node.name} ${type}` });
		this.endMate();
	},

	// ------------------------------------------------------------ joints
	addJoint({ type, node, origin, axis, name, min, max }) {
		const doc = this.model.doc;
		doc.joints = doc.joints || [];
		const j = {
			id: Math.random().toString(36).slice(2, 10), name: name || `${node.name} ${type}`, type, node: node.id,
			origin: origin.toArray().map((v) => round(v, 5)), axis: axis.toArray().map((v) => round(v, 6)), value: 0,
			min: min ?? (type === 'hinge' ? -90 : -20), max: max ?? (type === 'hinge' ? 90 : 20),
		};
		doc.joints.push(j);
		this.commit();
		this.showJointsPanel();
		toast(`Added ${type} “${j.name}” — drag its slider to move it`, 'ok');
		return j;
	},

	/** Joint dialog for the selected part: hinge / slider about a world axis through its center. */
	jointDialog() {
		const n = this.selectedNodes()[0];
		const node = n ? this.model.topLevelOf(n.id) : null;
		if (!node) { toast('Select the part that should move', 'warn'); return; }
		const box = this.worldBox(node), c = box.getCenter(new THREE.Vector3());
		const radio = (name, value, label, checked) => el('label', { class: 'chip-check' }, el('input', { type: 'radio', name, value, ...(checked ? { checked: true } : {}) }), el('span', {}, label));
		const inp = (id, v) => el('input', { id, type: 'text', value: v, style: 'width:70px' });
		const form = el('div', { class: 'form' },
			el('div', { class: 'row' }, el('span', {}, 'Type'), el('div', { class: 'chips' }, radio('jt-type', 'hinge', 'Hinge (rotates)', true), radio('jt-type', 'slider', 'Slider (moves)', false))),
			el('div', { class: 'row' }, el('span', {}, 'Axis'), el('div', { class: 'chips' }, ...['x', 'y', 'z'].map((a) => radio('jt-axis', a, a.toUpperCase(), a === 'z')))),
			el('label', { class: 'row' }, el('span', {}, 'Through point'), el('div', { class: 'chips' }, inp('jt-x', round(c.x, 3)), inp('jt-y', round(c.y, 3)), inp('jt-z', round(c.z, 3)))),
			el('label', { class: 'row' }, el('span', {}, 'Range'), el('div', { class: 'chips' }, inp('jt-min', -90), el('span', {}, 'to'), inp('jt-max', 90))),
			el('p', { class: 'muted small' }, 'Tip: the Mate tool (Tools menu) can attach a part to a hole or face first and turn that into a hinge or slider for you.'));
		const q = (id) => evalExpr(form.querySelector('#' + id).value, this.varValues || {});
		form.addEventListener('change', (e) => { if (e.target.name === 'jt-type') { const h = e.target.value === 'hinge'; form.querySelector('#jt-min').value = h ? -90 : -20; form.querySelector('#jt-max').value = h ? 90 : 20; } });
		this.modal('Add joint to “' + node.name + '”', form, [{ label: 'Cancel' }, {
			label: 'Add joint', primary: true, action: () => {
				const type = form.querySelector('input[name="jt-type"]:checked').value, ax = form.querySelector('input[name="jt-axis"]:checked').value;
				const axis = new THREE.Vector3(ax === 'x' ? 1 : 0, ax === 'y' ? 1 : 0, ax === 'z' ? 1 : 0);
				const o = new THREE.Vector3(q('jt-x'), q('jt-y'), q('jt-z')), min = q('jt-min'), max = q('jt-max');
				if (![o.x, o.y, o.z, min, max].every(isFinite) || !(max > min)) { toast('Check the numbers', 'error'); return false; }
				this.addJoint({ type, node, origin: o, axis, min, max });
			},
		}]);
	},

	/** Move a joint to an absolute value (relative motion from its current value). */
	setJoint(j, value, { commit = true } = {}) {
		const node = this.model.get(j.node);
		if (!node) return;
		const v = Math.max(j.min, Math.min(j.max, value));
		const M = jointMotion(j, v - j.value).multiply(this.worldMatrix(node));
		this.setWorldMatrix(node, M);
		j.value = v;
		if (commit) this.commit();
		else { this.vp.rebuild(this.model, this.engine, this.model.settings); this.vp.setSelection(this.sel); }
	},

	showJointsPanel() {
		const joints = (this.model.doc.joints || []).filter((j) => this.model.get(j.node));
		let panel = document.querySelector('#joints-panel');
		if (!panel) { panel = el('div', { id: 'joints-panel', class: 'side-panel joints' }); document.querySelector('#viewport').appendChild(panel); }
		panel.innerHTML = '';
		panel.append(el('div', { class: 'fp-head' }, el('b', {}, 'Joints'), el('button', { class: 'icon-btn', title: 'Close', onclick: () => { panel.style.display = 'none'; } }, '✕')));
		const mates = (this.model.doc.mates || []).filter((m) => this.model.get(m.node) && this.model.get(m.base));
		if (mates.length) {
			panel.append(el('div', { class: 'muted small' }, 'Attached parts (they move with their base):'));
			for (const m of mates) panel.append(el('div', { class: 'joint-head mate-row' }, el('span', {}, `${this.model.get(m.node).name} → ${this.model.get(m.base).name}`),
				el('button', { class: 'btn sm', title: 'Detach so it can move freely', onclick: () => { this.setAttachment(this.model.get(m.node), null); this.commit(); this.showJointsPanel(); } }, 'Detach')));
		}
		if (!joints.length) panel.append(el('div', { class: 'muted small' }, 'No joints yet. Use Assemble → Mate parts, then “Make hinge / slider”, or Assemble → Add joint.'));
		for (const j of joints) {
			const unit = j.type === 'hinge' ? '°' : ' mm';
			const range = el('input', { type: 'range', min: j.min, max: j.max, step: j.type === 'hinge' ? 1 : 0.5, value: j.value, style: 'flex:1' });
			const val = el('input', { type: 'text', class: 'num', value: fmt(j.value, 2), style: 'width:56px' });
			range.addEventListener('input', () => { this.setJoint(j, +range.value, { commit: false }); val.value = fmt(j.value, 2); });
			range.addEventListener('change', () => this.setJoint(j, +range.value));
			val.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') val.blur(); });
			val.addEventListener('change', () => { const v = evalExpr(val.value, this.varValues || {}); if (isFinite(v)) { this.setJoint(j, v); range.value = j.value; val.value = fmt(j.value, 2); } });
			const res = el('div', { class: 'muted small joint-res' });
			panel.append(el('div', { class: 'joint' },
				el('div', { class: 'joint-head' }, el('b', {}, j.name), el('span', { class: 'muted small' }, `${j.type} · ${fmt(j.min, 1)}…${fmt(j.max, 1)}${unit}`),
					el('button', { class: 'icon-btn sm', title: 'Delete joint', onclick: () => { this.model.doc.joints = this.model.doc.joints.filter((x) => x.id !== j.id); this.commit(); this.showJointsPanel(); } }, '✕')),
				el('div', { class: 'joint-ctl' }, range, val, el('span', { class: 'muted small' }, unit.trim())),
				el('div', { class: 'btn-row' }, el('button', { class: 'btn sm', title: 'Step through the whole range and report where it hits other parts', onclick: () => { res.textContent = 'Checking…'; setTimeout(() => { const r = this.sweepJoint(j); res.textContent = r.text; }, 20); } }, 'Check collisions over range'), el('button', { class: 'btn sm', onclick: () => { this.setJoint(j, 0); range.value = 0; val.value = '0'; } }, 'Reset')),
				res));
		}
		panel.style.display = '';
	},

	/** Step a joint through its range; returns the colliding values and highlights the worst overlap. */
	sweepJoint(j, steps = 36) {
		const node = this.model.get(j.node);
		if (!node) return { text: 'Part not found' };
		const base = this.engine.world(node);
		if (!base) return { text: 'Nothing to check' };
		const others = this.model.nodes.filter((n) => n.visible && !n.hole && n.id !== node.id).map((n) => ({ n, g: this.engine.world(n) })).filter((o) => o.g);
		others.forEach((o) => o.g.computeBoundingBox());
		const hits = [];
		let worst = null;
		for (let i = 0; i <= steps; i++) {
			const v = j.min + ((j.max - j.min) * i) / steps;
			const g = base.clone().applyMatrix4(jointMotion(j, v - j.value));
			g.computeBoundingBox();
			for (const o of others) {
				if (!g.boundingBox.intersectsBox(o.g.boundingBox)) continue;
				const r = overlapOf(g, o.g);
				if (r && r.volume > 0.01) { hits.push({ v, with: o.n.name, volume: r.volume }); if (!worst || r.volume > worst.volume) worst = { ...r, v, with: o.n.name }; }
			}
		}
		this.vp.showCheckHighlights(worst && worst.geometry ? [{ highlight: { solids: [worst.geometry], color: 0xff3b5c } }] : null);
		if (!hits.length) return { hits, text: `✓ No collisions from ${fmt(j.min, 1)} to ${fmt(j.max, 1)}${j.type === 'hinge' ? '°' : ' mm'}` };
		const vals = [...new Set(hits.map((h) => h.v))];
		const unit = j.type === 'hinge' ? '°' : ' mm';
		return { hits, text: `⚠ Hits ${[...new Set(hits.map((h) => h.with))].join(', ')} between ${fmt(Math.min(...vals), 1)}${unit} and ${fmt(Math.max(...vals), 1)}${unit} (worst overlap ${fmt(worst.volume, 1)} mm³ at ${fmt(worst.v, 1)}${unit}, shown in red)` };
	},

	/** Overlaps between all visible parts, shown in the print-check style panel. */
	interferenceCheck() {
		const parts = this.model.nodes.filter((n) => n.visible && !n.hole).map((n) => ({ n, g: this.engine.world(n) })).filter((p) => p.g);
		parts.forEach((p) => p.g.computeBoundingBox());
		const pairs = [];
		for (let i = 0; i < parts.length; i++) for (let k = i + 1; k < parts.length; k++) {
			if (!parts[i].g.boundingBox.intersectsBox(parts[k].g.boundingBox)) continue;
			const r = overlapOf(parts[i].g, parts[k].g);
			if (r && r.volume > 1e-3) pairs.push({ a: parts[i].n.name, b: parts[k].n.name, volume: r.volume, geometry: r.geometry });
		}
		const items = pairs.length
			? pairs.map((p) => ({ kind: 'overlap', level: 'warn', title: `${p.a} ∩ ${p.b}`, detail: `${fmt(p.volume, 2)} mm³ overlap`, highlight: { solids: [p.geometry], color: 0xff3b5c } }))
			: [{ kind: 'overlap', level: 'ok', title: parts.length > 1 ? `No interference between ${parts.length} parts` : 'Only one part' }];
		this.showCheckPanel({ items, ms: 0 }, { minWall: this.model.settings.minWall ?? 0.8, minGap: this.model.settings.minGap ?? 0.3 });
		const head = document.querySelector('#check-panel .fp-head b');
		if (head) head.textContent = 'Interference';
		const foot = document.querySelector('#check-panel .fp-foot');
		if (foot) foot.style.display = 'none';
		return pairs;
	},
};
