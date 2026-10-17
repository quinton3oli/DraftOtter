// Split a part with a plane into two editable halves, with optional alignment-pin holes (and the pins),
// and optionally turn both halves cut-face-down ready to print.
import * as THREE from 'three';
import { makeNode, makeGroup, cloneWithNewIds } from './model.js';
import { sectionAt, fromPlane } from './engine.js';
import { round, fmt, evalExpr, toast, el } from './util.js';

const AX = { x: 0, y: 1, z: 2 };

/** Pin positions inside (inset) section polygons: n points spread as far apart as possible. */
export function pinSpots(polygons, n) {
	if (!polygons || !polygons.length || n < 1) return [];
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	for (const p of polygons) for (const [x, y] of p) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
	const inside = (x, y) => {
		let c = false;
		for (const p of polygons) for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
			const a = p[i], b = p[j];
			if ((a[1] > y) !== (b[1] > y) && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
		}
		return c;
	};
	const edgeDist = (x, y) => {
		let d = Infinity;
		for (const p of polygons) for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
			const a = p[j], b = p[i], ex = b[0] - a[0], ey = b[1] - a[1], L = ex * ex + ey * ey || 1e-12;
			const t = Math.max(0, Math.min(1, ((x - a[0]) * ex + (y - a[1]) * ey) / L));
			d = Math.min(d, Math.hypot(a[0] + t * ex - x, a[1] + t * ey - y));
		}
		return d;
	};
	const N = 36, cand = [];
	for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
		const x = x0 + ((x1 - x0) * i) / N, y = y0 + ((y1 - y0) * j) / N;
		if (inside(x, y)) cand.push([x, y]);
	}
	if (!cand.length) return [];
	if (n === 1) {
		let best = cand[0], bd = -1;
		for (const c of cand) { const d = edgeDist(c[0], c[1]); if (d > bd) { bd = d; best = c; } }
		return [best];
	}
	// farthest pair, then greedy farthest-point sampling
	let a = 0, b = 0, bd = -1;
	for (let i = 0; i < cand.length; i++) for (let j = i + 1; j < cand.length; j++) {
		const d = (cand[i][0] - cand[j][0]) ** 2 + (cand[i][1] - cand[j][1]) ** 2;
		if (d > bd) { bd = d; a = i; b = j; }
	}
	const out = [cand[a], cand[b]];
	while (out.length < n && out.length < cand.length) {
		let best = null, bdist = -1;
		for (const c of cand) {
			const d = Math.min(...out.map((o) => (o[0] - c[0]) ** 2 + (o[1] - c[1]) ** 2));
			if (d > bdist) { bdist = d; best = c; }
		}
		out.push(best);
	}
	return out;
}

export const SplitMixin = {
	splitDialog() {
		const nodes = this.selectedNodes();
		const node = nodes.length === 1 ? this.model.topLevelOf(nodes[0].id) : null;
		if (!node || node.hole || node.locked) { toast('Select one solid part to split', 'warn'); return; }
		const world = this.engine.world(node);
		if (!world) return;
		world.computeBoundingBox();
		const bb = world.boundingBox, size = bb.getSize(new THREE.Vector3()), ctr = bb.getCenter(new THREE.Vector3());
		const last = this.lastSplit || {};
		const axis0 = last.axis || 'z';
		const inp = (id, v, w = 80) => el('input', { id, type: 'text', value: v, style: `width:${w}px` });
		const radio = (name, value, label, checked) => el('label', { class: 'chip-check' }, el('input', { type: 'radio', name, value, ...(checked ? { checked: true } : {}) }), el('span', {}, label));
		const note = el('p', { class: 'muted small' });
		const form = el('div', { class: 'form' },
			el('div', { class: 'row' }, el('span', {}, 'Cut across'), el('div', { class: 'chips' }, ...['x', 'y', 'z'].map((a) => radio('sp-axis', a, a.toUpperCase(), a === axis0)))),
			el('label', { class: 'row' }, el('span', {}, 'At (mm)'), el('div', { class: 'chips' }, inp('sp-pos', ''), el('input', { id: 'sp-slider', type: 'range', min: 0, max: 1000, style: 'width:170px' }))),
			el('label', { class: 'row' }, el('span', {}, 'Alignment pins'), el('select', { id: 'sp-pins' }, ...[0, 1, 2, 3, 4].map((k) => el('option', { value: k, ...(k === (last.pins ?? 2) ? { selected: true } : {}) }, k ? `${k} pin${k > 1 ? 's' : ''}` : 'None')))),
			el('label', { class: 'row' }, el('span', {}, 'Pin Ø × length (mm)'), el('div', { class: 'chips' }, inp('sp-pd', last.pinD ?? 5, 60), el('span', {}, '×'), inp('sp-pl', last.pinL ?? 12, 60))),
			el('label', { class: 'row' }, el('span', {}, 'Hole clearance (mm)'), inp('sp-cl', last.clearance ?? 0.15, 60)),
			el('label', { class: 'check' }, el('input', { id: 'sp-orient', type: 'checkbox', ...(last.orient !== false ? { checked: true } : {}) }), el('span', {}, 'Lay both halves cut-face down, ready to print')),
			note);
		const q = (id) => form.querySelector('#' + id);
		const axis = () => form.querySelector('input[name="sp-axis"]:checked').value;
		const range = () => [bb.min.getComponent(AX[axis()]), bb.max.getComponent(AX[axis()])];
		const setPos = (v) => { q('sp-pos').value = round(v, 3); const [a, b] = range(); q('sp-slider').value = Math.round(((v - a) / (b - a || 1)) * 1000); };
		const opts = () => ({
			axis: axis(), pos: evalExpr(q('sp-pos').value, this.varValues || {}), pins: +q('sp-pins').value,
			pinD: evalExpr(q('sp-pd').value, this.varValues || {}), pinL: evalExpr(q('sp-pl').value, this.varValues || {}),
			clearance: evalExpr(q('sp-cl').value, this.varValues || {}), orient: q('sp-orient').checked,
		});
		const preview = () => {
			const o = opts();
			const spots = this.splitSpots(world, o);
			this.vp.showCutPlane(o.axis, o.pos, bb, spots.map(([u, v]) => new THREE.Vector3(...fromPlane(o.axis, u, v, o.pos))), (o.pinD / 2 || 1));
			note.textContent = o.pins && spots.length < o.pins
				? `Only room for ${spots.length} pin${spots.length === 1 ? '' : 's'} of Ø${fmt(o.pinD, 2)} here — try a smaller pin or another position.`
				: o.pins ? `Holes are Ø${fmt(o.pinD + 2 * o.clearance, 2)} × ${fmt(o.pinL / 2 + o.clearance, 2)} deep in each half; the pins are added as separate parts.` : 'The halves stay editable: each is a group of the original part and a cutting box.';
		};
		setPos(last.axis === axis0 && last.pos != null && last.pos > range()[0] && last.pos < range()[1] ? last.pos : ctr.getComponent(AX[axis0]));
		form.addEventListener('change', (e) => { if (e.target.name === 'sp-axis') setPos(ctr.getComponent(AX[axis()])); preview(); });
		q('sp-slider').addEventListener('input', () => { const [a, b] = range(); q('sp-pos').value = round(a + ((b - a) * q('sp-slider').value) / 1000, 2); preview(); });
		q('sp-pos').addEventListener('input', preview);
		this.modal('Split part', form, [{ label: 'Cancel' }, {
			label: 'Split', primary: true, action: () => {
				const o = opts();
				const [a, b] = range();
				if (!(o.pos > a + 1e-3 && o.pos < b - 1e-3)) { toast(`The cut must be inside the part (${fmt(a, 2)} … ${fmt(b, 2)})`, 'error'); return false; }
				if (o.pins && !(o.pinD > 0 && o.pinL > 0 && o.clearance >= 0)) { toast('Check the pin size', 'error'); return false; }
				this.lastSplit = o;
				this.splitPart(node, o, world);
			},
		}], '', { onClose: () => this.vp.showCutPlane(null) });
		preview();
	},

	/** Pin centers (plane coordinates) for the given options. */
	splitSpots(world, o) {
		if (!o.pins) return [];
		const sec = sectionAt(world, o.axis, o.pos, o.pinD / 2 + o.clearance + Math.max(1.2, o.pinD * 0.3));
		return sec ? pinSpots(sec.polygons, o.pins) : [];
	},

	splitPart(node, o, world = this.engine.world(node)) {
		world.computeBoundingBox();
		const bb = world.boundingBox, size = bb.getSize(new THREE.Vector3()), ctr = bb.getCenter(new THREE.Vector3());
		const i = AX[o.axis], big = Math.max(size.x, size.y, size.z) * 2 + 40;
		const cutter = () => {
			const c = makeNode('box', { w: big, d: big, h: big }, { name: 'Cut' });
			const p = ctr.toArray(); p[i] = o.pos - big / 2;
			c.pos = p.map((v) => round(v));
			return c;
		};
		const spots = this.splitSpots(world, o);
		const pinHoles = () => spots.map(([u, v]) => {
			const h = makeNode('cylinder', { r: o.pinD / 2 + o.clearance, h: o.pinL + 2 * o.clearance }, { name: 'Pin hole', hole: true });
			h.pos = fromPlane(o.axis, u, v, o.pos).map((x) => round(x));
			if (o.axis === 'x') h.rot = [0, 90, 0];
			if (o.axis === 'y') h.rot = [90, 0, 0];
			return h;
		});
		const part = (k) => {
			const keep = cloneWithNewIds(node);
			const c = cutter();
			const g = k === 0 ? makeGroup([keep, c, ...pinHoles()], { mode: 'intersect', name: node.name + ' (part 1)', color: node.color })
				: makeGroup([keep, { ...c, hole: true }, ...pinHoles()], { name: node.name + ' (part 2)', color: node.color });
			return g;
		};
		const halves = [part(0), part(1)];
		const list = this.model.nodes, idx = list.indexOf(node);
		list.splice(idx, 1, ...halves);
		// recenter each group on its own half so its handles sit on it
		for (const [k, g] of halves.entries()) {
			const c = ctr.clone();
			c.setComponent(i, k === 0 ? (bb.min.getComponent(i) + o.pos) / 2 : (o.pos + bb.max.getComponent(i)) / 2);
			g.pos = c.toArray().map((v) => round(v));
			for (const ch of g.children) ch.pos = ch.pos.map((v, j) => round(v - g.pos[j]));
		}
		const pins = spots.map(() => makeNode('cylinder', { r: o.pinD / 2, h: o.pinL }, { name: 'Alignment pin', color: node.color }));
		if (o.orient) this.layCutDown(halves, o.axis);
		else {
			const d = new THREE.Vector3(); d.setComponent(i, 10);
			halves[1].pos = halves[1].pos.map((v, j) => round(v + d.getComponent(j)));
		}
		// pins stand next to the halves
		let px = this.halvesMaxX(halves) + 6;
		for (const p of pins) { p.pos = [round(px + o.pinD / 2), round(ctr.y), round(o.pinL / 2)]; px += o.pinD + 4; list.push(p); }
		this.sel = halves.map((g) => g.id);
		this.commit();
		toast(`Split into 2 parts${pins.length ? ` with ${pins.length} alignment pin${pins.length > 1 ? 's' : ''}` : ''}`, 'ok');
		return halves;
	},

	halvesMaxX(halves) {
		let m = -Infinity;
		for (const g of halves) { const w = this.engine.world(g); if (w) { w.computeBoundingBox(); m = Math.max(m, w.boundingBox.max.x); w.dispose(); } }
		return m;
	},

	/** Rotate each half so its cut face points down, set it on the bed and put them side by side. */
	layCutDown(halves, axis) {
		const n = new THREE.Vector3(); n.setComponent(AX[axis], 1);
		let x = null;
		halves.forEach((g, k) => {
			const cutNormal = k === 0 ? n.clone() : n.clone().negate();
			const q = new THREE.Quaternion().setFromUnitVectors(cutNormal, new THREE.Vector3(0, 0, -1));
			if (cutNormal.z > 0.999) q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI); // well-defined flip
			const M = new THREE.Matrix4().compose(new THREE.Vector3(...g.pos), new THREE.Quaternion().setFromEuler(new THREE.Euler(...g.rot.map((r) => r * Math.PI / 180), 'XYZ')), new THREE.Vector3(...g.scale));
			const R = new THREE.Matrix4().makeRotationFromQuaternion(q).multiply(M);
			const p = new THREE.Vector3(), qq = new THREE.Quaternion(), s = new THREE.Vector3();
			R.decompose(p, qq, s);
			const e = new THREE.Euler().setFromQuaternion(qq, 'XYZ');
			g.rot = [e.x, e.y, e.z].map((r) => round(r * 180 / Math.PI, 3));
			g.pos = p.toArray().map((v) => round(v));
			const w = this.engine.world(g);
			w.computeBoundingBox();
			const b = w.boundingBox;
			w.dispose();
			const dx = x === null ? 0 : x - b.min.x;
			g.pos = [round(g.pos[0] + dx), round(g.pos[1]), round(g.pos[2] - b.min.z)];
			x = b.max.x + dx + 10;
		});
	},
};
