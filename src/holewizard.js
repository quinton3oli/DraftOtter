// Hole Wizard tool: pick a standard hole, then click points on flat faces to drill it there (snapped to the grid in
// the face's plane, square to the face). Holes go into the part's feature group, so they cut it and stay editable.
import * as THREE from 'three';
import { makeNode } from './model.js';
import { HOLE_SIZES, HOLE_TYPES, TYPE_LABEL, holeCallout } from './holes.js';
import { round, fmt, toast, el, evalExpr } from './util.js';

const DEG = Math.PI / 180;

export const HoleWizardMixin = {
	holeParams() {
		if (!this.hw) this.hw = { std: 'ISO', size: 'M3', type: 'clearance', fit: 'normal', depth: 10, thru: true, threads: false };
		return this.hw;
	},

	startHoleWizard() {
		this.holeParams();
		this.setTool('holewiz');
		this.showHoleBar();
	},

	showHoleBar() {
		const hw = this.holeParams();
		let bar = document.querySelector('#hw-bar');
		if (!bar) { bar = el('div', { id: 'hw-bar', class: 'float-bar hw-bar' }); document.querySelector('#viewport').appendChild(bar); }
		bar.innerHTML = '';
		const sel = (opts, val, fn, title) => { const s = el('select', { title }, ...opts.map(([v, l]) => el('option', { value: v }, l))); s.value = val; s.addEventListener('change', () => { fn(s.value); this.showHoleBar(); }); return s; };
		const sizes = Object.entries(HOLE_SIZES).filter(([, s]) => s.std === hw.std).map(([k]) => [k, k]);
		if (!HOLE_SIZES[hw.size] || HOLE_SIZES[hw.size].std !== hw.std) hw.size = sizes[hw.std === 'ISO' ? 2 : 1][0];
		const depth = el('input', { type: 'text', class: 'num', value: hw.depth, style: 'width:50px', disabled: hw.thru, title: 'Hole depth (mm)' });
		depth.addEventListener('keydown', (e) => e.stopPropagation());
		depth.addEventListener('change', () => { const v = evalExpr(depth.value, this.varValues || {}); if (v > 0) hw.depth = v; this.showHoleBar(); });
		const thru = el('input', { type: 'checkbox', checked: hw.thru });
		thru.addEventListener('change', () => { hw.thru = thru.checked; this.showHoleBar(); });
		const threads = el('input', { type: 'checkbox', checked: hw.threads });
		threads.addEventListener('change', () => { hw.threads = threads.checked; this.showHoleBar(); });
		bar.append(el('b', {}, 'Hole'),
			sel([['ISO', 'ISO metric'], ['ANSI', 'ANSI inch']], hw.std, (v) => { hw.std = v; }, 'Standard'),
			sel(sizes, hw.size, (v) => { hw.size = v; }, 'Size'),
			sel(HOLE_TYPES.map((t) => [t, TYPE_LABEL[t]]), hw.type, (v) => { hw.type = v; }, 'Hole type'),
			hw.type === 'tapped' ? el('label', { class: 'muted', title: 'Model the internal thread (good for M5 / #10 and larger in FDM)' }, threads, ' threads') : sel([['close', 'Close fit'], ['normal', 'Normal fit'], ['loose', 'Loose fit']], hw.fit, (v) => { hw.fit = v; }, 'Clearance fit'),
			el('label', { class: 'muted' }, thru, ' through'), hw.thru ? null : el('label', { class: 'muted' }, 'depth ', depth),
			el('span', { class: 'sep' }),
			el('span', { class: 'muted hw-callout' }, holeCallout({ ...hw, depth: hw.depth })),
			el('span', { class: 'muted' }, '· click flat faces to drill'),
			el('button', { class: 'btn sm primary', onclick: () => this.setTool(null) }, 'Done'));
		bar.style.display = '';
	},

	endHoleWizard() {
		const bar = document.querySelector('#hw-bar');
		if (bar) bar.style.display = 'none';
		this.vp.showHolePreview(null);
		this.hwHover = null;
	},

	/** Where a hole would go for this pointer event: snapped point, face normal, target part. */
	holeSpot(e) {
		const sp = this.vp.surfacePoint(e);
		if (!sp || !sp.object) return null;
		const id = sp.object.userData.nodeId;
		const top = id ? this.model.topLevelOf(id) : null;
		if (!top || top.hole || top.locked) return null;
		const n = sp.normal.clone().normalize();
		const p = e.altKey ? sp.point.clone() : this.vp.snapInPlane(sp.point.clone(), n);
		return { point: p, normal: n, node: top, mesh: sp.object };
	},

	holeHover(e) {
		const s = this.holeSpot(e);
		this.hwHover = s;
		const S = HOLE_SIZES[this.holeParams().size];
		this.vp.showHolePreview(s ? { point: s.point, normal: s.normal, r: Math.max(S.clr[1], S.cb[0] * (this.hw.type === 'counterbore' ? 1 : 0), S.csk * (this.hw.type === 'countersink' ? 1 : 0)) / 2 } : null);
		if (s) this.onHint(`Hole: ${holeCallout(this.hw)} at X ${fmt(s.point.x, 2)} Y ${fmt(s.point.y, 2)} Z ${fmt(s.point.z, 2)} — click to drill (Alt: no snapping)`);
	},

	/** Thickness of the part along −normal from a surface point (for through holes). */
	thicknessAt(point, normal, node) {
		const meshes = [];
		this.vp.objs.get(node.id).traverse((o) => { if (o.isMesh && o.geometry && o.geometry.attributes.position) meshes.push(o); });
		const rc = new THREE.Raycaster(point.clone().addScaledVector(normal, -0.01), normal.clone().negate());
		// the ray leaves through back faces, so test both sides
		const sides = meshes.map((m) => m.material.side);
		meshes.forEach((m) => { m.material.side = THREE.DoubleSide; });
		let far = 0;
		try { for (const h of rc.intersectObjects(meshes, false)) far = Math.max(far, h.distance); } finally { meshes.forEach((m, i) => { m.material.side = sides[i]; }); }
		return far > 0 ? far + 0.01 : null;
	},

	holeClick(e) {
		const s = this.holeSpot(e) || this.hwHover;
		if (!s) return;
		const hw = this.holeParams();
		// the hole's top sits a hair above the surface (clean cut); its length covers the depth below it
		const lift = 0; // flush with the face (Manifold cuts coplanar faces cleanly)
		let D = hw.depth + lift;
		if (hw.thru) {
			const t = this.thicknessAt(s.point, s.normal, s.node);
			if (!t) { toast('Could not measure the part there — untick “through” and give a depth', 'warn'); return; }
			D = round(t + 0.5 + lift, 3);
		}
		const params = { size: hw.size, type: hw.type, fit: hw.fit, depth: D, thru: hw.thru, threads: hw.type === 'tapped' && hw.threads };
		const hole = makeNode('wizhole', params, { name: `${hw.size} ${TYPE_LABEL[hw.type].toLowerCase()}${hw.thru ? '' : ' ' + fmt(hw.depth, 1) + ' deep'}`, hole: true });
		// local +Z is the face normal
		const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), s.normal);
		const center = s.point.clone().addScaledVector(s.normal, lift); // the hole's origin is its top
		const W = new THREE.Matrix4().compose(center, q, new THREE.Vector3(1, 1, 1));
		const { g, Mg } = this.featureGroupFor(s.node);
		const local = Mg.clone().invert().multiply(W);
		const p = new THREE.Vector3(), qq = new THREE.Quaternion(), sc = new THREE.Vector3();
		local.decompose(p, qq, sc);
		const eu = new THREE.Euler().setFromQuaternion(qq, 'XYZ');
		hole.pos = p.toArray().map((v) => round(v, 4));
		hole.rot = [eu.x, eu.y, eu.z].map((v) => round(v / DEG, 4));
		g.children.push(hole);
		this.sel = [g.id];
		this.commit();
		this.lastHole = hole.id;
		toast(`Drilled ${holeCallout(params)} — select it in Objects to edit, or Pattern / Mirror it`, 'ok', 3500);
	},
};
