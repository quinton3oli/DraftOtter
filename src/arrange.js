// Arrange on a circle: space the selected objects evenly around a circle (any axis), with a live preview.
// Opening it again on objects that already sit on a circle picks up that circle, so the radius can be changed later.
import * as THREE from 'three';
import { round, fmt, toast, el, evalExpr } from './util.js';

const AXES = { z: new THREE.Vector3(0, 0, 1), x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0) };
function basis(axis) {
	const a = AXES[axis];
	const u = axis === 'z' ? new THREE.Vector3(1, 0, 0) : axis === 'x' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
	return { a, u, v: a.clone().cross(u) };
}

/** Least-squares circle through 2D points: { cx, cy, r, rms } or null. */
function fitCircle(P) {
	if (P.length < 3) return null;
	let mx = 0, my = 0;
	for (const [x, y] of P) { mx += x; my += y; }
	mx /= P.length; my /= P.length;
	let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
	for (const [x, y] of P) { const u = x - mx, v = y - my; suu += u * u; svv += v * v; suv += u * v; suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u; }
	const det = suu * svv - suv * suv;
	if (Math.abs(det) < 1e-12) return null;
	const b1 = (suuu + suvv) / 2, b2 = (svvv + svuu) / 2;
	const uc = (b1 * svv - b2 * suv) / det, vc = (suu * b2 - suv * b1) / det;
	const r = Math.sqrt(uc * uc + vc * vc + (suu + svv) / P.length);
	let e = 0;
	for (const [x, y] of P) e += (Math.hypot(x - mx - uc, y - my - vc) - r) ** 2;
	return { cx: uc + mx, cy: vc + my, r, rms: Math.sqrt(e / P.length) };
}

/**
 * Where each object goes: [{ node, M }] (new world matrices) for an arrangement
 * { axis, center: Vector3, radius, start (°), total (°), turn (rotate with the circle) }.
 */
export function circleLayout(items, o) {
	const { a, u, v } = basis(o.axis);
	const n = items.length;
	const full = Math.abs(o.total) >= 360 - 1e-9;
	const step = full ? o.total / n : n > 1 ? o.total / (n - 1) : 0;
	// keep the objects' current order around the circle
	const ang = (c) => { const d = c.clone().sub(o.center); return Math.atan2(d.dot(v), d.dot(u)); };
	const order = items.map((it, i) => ({ it, i, t: ang(it.c) }));
	const t0 = order[0].t;
	order.sort((p, q) => ((p.t - t0 + 4 * Math.PI) % (2 * Math.PI)) - ((q.t - t0 + 4 * Math.PI) % (2 * Math.PI)));
	return order.map(({ it, t }, k) => {
		const th = ((o.start + step * k) * Math.PI) / 180;
		const axial = it.c.clone().sub(o.center).dot(a);
		const target = o.center.clone().addScaledVector(u, o.radius * Math.cos(th)).addScaledVector(v, o.radius * Math.sin(th)).addScaledVector(a, axial);
		let M = new THREE.Matrix4().makeTranslation(target.x - it.c.x, target.y - it.c.y, target.z - it.c.z);
		if (o.turn) {
			const R = new THREE.Matrix4().makeRotationAxis(a, th - t);
			M = new THREE.Matrix4().makeTranslation(target.x, target.y, target.z).multiply(R).multiply(new THREE.Matrix4().makeTranslation(-it.c.x, -it.c.y, -it.c.z));
		}
		return { node: it.node, M: M.multiply(it.W) };
	});
}

export const ArrangeMixin = {
	arrangeCircleDialog() {
		const nodes = this.selectedNodes().filter((n) => !n.locked);
		if (nodes.length < 2) { toast('Select two or more objects to arrange on a circle', 'warn'); return; }
		// originals, so the preview can always start from where things were
		const items = nodes.map((node) => ({ node, W: this.worldMatrix(node), c: this.worldBox(node).getCenter(new THREE.Vector3()), saved: { pos: node.pos.slice(), rot: node.rot.slice(), scale: node.scale.slice(), exprs: node.exprs ? { ...node.exprs } : undefined } }));
		const last = this.lastArrange || {};
		const guess = (axis) => {
			// objects already on a circle: use that circle; otherwise center on the selection
			const { a, u, v } = basis(axis);
			const P = items.map((it) => [it.c.dot(u), it.c.dot(v)]);
			const f = fitCircle(P);
			const box = new THREE.Box3();
			items.forEach((it) => box.expandByPoint(it.c));
			const bc = box.getCenter(new THREE.Vector3());
			if (f && f.rms < Math.max(0.01, f.r * 0.01) && f.r < 1e5) {
				const c = u.clone().multiplyScalar(f.cx).addScaledVector(v, f.cy).addScaledVector(a, bc.dot(a));
				const d0 = items[0].c.clone().sub(c);
				return { center: c, radius: f.r, start: (Math.atan2(d0.dot(v), d0.dot(u)) * 180) / Math.PI, found: true };
			}
			const far = Math.max(...items.map((it) => { const d = it.c.clone().sub(bc); return Math.hypot(d.dot(u), d.dot(v)); }));
			return { center: bc, radius: round(far > 1e-6 ? far : 10, 3), start: 0, found: false };
		};
		const axis0 = last.axis || 'z';
		let g = guess(axis0);
		const inp = (id, v, w = 70) => el('input', { id, type: 'text', value: round(v, 3), style: `width:${w}px` });
		const radio = (name, value, label, checked) => el('label', { class: 'chip-check' }, el('input', { type: 'radio', name, value, ...(checked ? { checked: true } : {}) }), el('span', {}, label));
		const note = el('p', { class: 'muted small' });
		const rSlider = el('input', { type: 'range', min: 0, max: 1000, style: 'width:160px' });
		const form = el('div', { class: 'form' },
			el('div', { class: 'row' }, el('span', {}, 'Around axis'), el('div', { class: 'chips' }, ...['z', 'x', 'y'].map((x) => radio('ac-axis', x, x.toUpperCase(), x === axis0)))),
			el('label', { class: 'row' }, el('span', {}, 'Center X / Y / Z'), el('div', { class: 'chips' }, inp('ac-cx', g.center.x), inp('ac-cy', g.center.y), inp('ac-cz', g.center.z))),
			el('label', { class: 'row' }, el('span', {}, 'Radius (mm)'), el('div', { class: 'chips' }, inp('ac-r', g.radius), rSlider)),
			el('label', { class: 'row' }, el('span', {}, 'Start angle (°)'), inp('ac-start', g.start)),
			el('label', { class: 'row' }, el('span', {}, 'Spread over (°)'), inp('ac-total', last.total ?? 360)),
			el('label', { class: 'check' }, el('input', { id: 'ac-turn', type: 'checkbox', ...(last.turn ? { checked: true } : {}) }), el('span', {}, 'Turn each object with the circle (like spokes)')),
			note);
		const q = (id) => form.querySelector('#' + id);
		const sliderMax = () => Math.max(50, (evalExpr(q('ac-r').value, this.varValues || {}) || 10) * 3);
		const syncSlider = () => { const r = evalExpr(q('ac-r').value, this.varValues || {}); rSlider.value = Math.round((Math.max(0, r) / sliderMax()) * 1000); };
		const opts = () => {
			const v = (id) => evalExpr(q(id).value, this.varValues || {});
			return { axis: form.querySelector('input[name="ac-axis"]:checked').value, center: new THREE.Vector3(v('ac-cx'), v('ac-cy'), v('ac-cz')), radius: v('ac-r'), start: v('ac-start'), total: v('ac-total'), turn: q('ac-turn').checked };
		};
		const restore = () => { for (const it of items) { Object.assign(it.node, { pos: it.saved.pos.slice(), rot: it.saved.rot.slice(), scale: it.saved.scale.slice() }); if (it.saved.exprs) it.node.exprs = { ...it.saved.exprs }; } };
		const preview = () => {
			const o = opts();
			if (![o.center.x, o.center.y, o.center.z, o.radius, o.start, o.total].every(isFinite) || !(o.radius >= 0)) { note.textContent = 'Check the numbers'; return; }
			restore();
			this.afterChange();
			for (const { node, M } of circleLayout(items, o)) this.setWorldMatrix(node, M);
			this.afterChange();
			this.showArrangeGuide(o);
			const n = items.length, full = Math.abs(o.total) >= 360 - 1e-9;
			note.textContent = `${n} objects, ${fmt(Math.abs(full ? o.total / n : o.total / (n - 1)), 2)}° apart on a Ø${fmt(2 * o.radius, 2)} mm circle${g.found ? ' (found the circle they were on)' : ''}.`;
		};
		form.addEventListener('change', (e) => {
			if (e.target.name === 'ac-axis') { g = guess(e.target.value); q('ac-cx').value = round(g.center.x, 3); q('ac-cy').value = round(g.center.y, 3); q('ac-cz').value = round(g.center.z, 3); q('ac-r').value = round(g.radius, 3); q('ac-start').value = round(g.start, 3); }
			syncSlider();
			preview();
		});
		form.querySelectorAll('input[type=text]').forEach((i) => { i.addEventListener('keydown', (e) => e.stopPropagation()); i.addEventListener('input', preview); });
		rSlider.addEventListener('input', () => { q('ac-r').value = round((rSlider.value / 1000) * sliderMax(), 2); preview(); });
		rSlider.addEventListener('change', syncSlider);
		let applied = false;
		this.modal('Arrange on a circle', form, [{ label: 'Cancel' }, {
			label: 'Arrange', primary: true, action: () => {
				const o = opts();
				if (![o.radius, o.start, o.total].every(isFinite) || !(o.radius >= 0)) { toast('Check the numbers', 'error'); return false; }
				applied = true;
				this.lastArrange = { axis: o.axis, total: o.total, turn: o.turn };
				restore();
				this.afterChange();
				for (const { node, M } of circleLayout(items, o)) this.setWorldMatrix(node, M);
				this.commit();
				toast(`Arranged ${items.length} objects on a Ø${fmt(2 * o.radius, 2)} mm circle — run it again on them to change the radius`, 'ok', 4000);
			},
		}], '', { onClose: () => { this.showArrangeGuide(null); if (!applied) { restore(); this.afterChange(); } } });
		syncSlider();
		preview();
	},

	/** Dashed circle and center mark in the view while arranging. */
	showArrangeGuide(o) {
		if (this.arrangeObj) { this.vp.helpers.remove(this.arrangeObj); this.arrangeObj.traverse((x) => { if (x.geometry) x.geometry.dispose(); }); this.arrangeObj = null; }
		if (o) {
			const { a, u, v } = basis(o.axis);
			const pts = Array.from({ length: 129 }, (_, i) => { const t = (i / 128) * Math.PI * 2; return o.center.clone().addScaledVector(u, o.radius * Math.cos(t)).addScaledVector(v, o.radius * Math.sin(t)); });
			const g = new THREE.Group();
			const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineDashedMaterial({ color: 0x4fd1ff, dashSize: Math.max(0.5, o.radius * 0.06), gapSize: Math.max(0.3, o.radius * 0.04), depthTest: false }));
			line.computeLineDistances();
			line.renderOrder = 26;
			g.add(line);
			const s = Math.max(1, o.radius * 0.08);
			const cross = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([o.center.clone().addScaledVector(u, -s), o.center.clone().addScaledVector(u, s), o.center.clone().addScaledVector(v, -s), o.center.clone().addScaledVector(v, s), o.center.clone().addScaledVector(a, -s), o.center.clone().addScaledVector(a, s)]), new THREE.LineBasicMaterial({ color: 0x4fd1ff, depthTest: false }));
			cross.renderOrder = 26;
			g.add(cross);
			this.vp.helpers.add(g);
			this.arrangeObj = g;
		}
		this.vp.invalidate();
	},
};
