// Stress check panel: pick fixed faces and loaded faces on a part, set the force and material, run the voxel FEA,
// then see the stress colors, peak stress, deflection and safety factor (and the exaggerated deformed shape).
import * as THREE from 'three';
import { faceRegion } from './pushpull.js';
import { MATERIALS, voxelize, nodesNear, solveFEA, sampleResults, stressColor } from './fea.js';
import { fmt, toast, el, evalExpr } from './util.js';

const RES = { coarse: ['Coarse (fast)', 4000], normal: ['Normal', 12000], fine: ['Fine (slow)', 30000] };
const DIRS = { push: 'Push into the face', pull: 'Pull away from the face', '-z': 'Down (−Z)', '+z': 'Up (+Z)', '-x': '−X', '+x': '+X', '-y': '−Y', '+y': '+Y' };

export const FeaMixin = {
	stressDialog() {
		const sel = this.selectedNodes().map((n) => this.model.topLevelOf(n.id)).filter((n, i, a) => n && a.indexOf(n) === i);
		const solids = this.model.nodes.filter((n) => n.visible && !n.hole);
		const node = sel.length === 1 ? sel[0] : solids.length === 1 ? solids[0] : null;
		if (!node || node.hole) { toast('Select the one part to check', 'warn'); return; }
		this.fea = { node, fixed: [], loads: [], force: this.fea?.force ?? 50, dir: this.fea?.dir || '-z', mat: this.fea?.mat || 'PLA', res: this.fea?.res || 'normal', result: null, deform: 0 };
		this.showFeaPanel();
		this.feaPick('fixed');
	},

	showFeaPanel() {
		const F = this.fea;
		let panel = document.querySelector('#fea-panel');
		if (!panel) { panel = el('div', { id: 'fea-panel', class: 'side-panel fea' }); document.querySelector('#viewport').appendChild(panel); }
		panel.innerHTML = '';
		const sel = (opts, val, fn) => { const s = el('select', {}, ...Object.entries(opts).map(([k, v]) => el('option', { value: k }, Array.isArray(v) ? v[0] : typeof v === 'string' ? v : k))); s.value = val; s.addEventListener('change', () => fn(s.value)); return s; };
		const pickBtn = (kind, label) => el('button', { class: 'btn sm' + (this.tool === 'feapick' && F.pick === kind ? ' active' : ''), onclick: () => this.feaPick(kind) }, label);
		const force = el('input', { type: 'text', class: 'num', value: F.force, style: 'width:60px' });
		force.addEventListener('keydown', (e) => e.stopPropagation());
		force.addEventListener('change', () => { const v = evalExpr(force.value, this.varValues || {}); if (v > 0) F.force = v; });
		const mat = MATERIALS[F.mat];
		panel.append(
			el('div', { class: 'fp-head' }, el('b', {}, 'Stress check — ' + F.node.name), el('button', { class: 'icon-btn', title: 'Close', onclick: () => this.closeFea() }, '✕')),
			el('div', { class: 'fea-row' }, el('span', { class: 'fea-dot fixed' }), el('span', {}, `Fixed faces: ${F.fixed.length}`), pickBtn('fixed', 'Pick'), F.fixed.length ? el('button', { class: 'btn sm', onclick: () => { F.fixed = []; this.feaMarks(); this.showFeaPanel(); } }, 'Clear') : null),
			el('div', { class: 'fea-row' }, el('span', { class: 'fea-dot load' }), el('span', {}, `Loaded faces: ${F.loads.length}`), pickBtn('load', 'Pick'), F.loads.length ? el('button', { class: 'btn sm', onclick: () => { F.loads = []; this.feaMarks(); this.showFeaPanel(); } }, 'Clear') : null),
			el('div', { class: 'fea-row' }, el('span', {}, 'Force'), force, el('span', {}, 'N'), sel(DIRS, F.dir, (v) => { F.dir = v; })),
			el('div', { class: 'fea-row' }, el('span', {}, 'Material'), sel(Object.fromEntries(Object.keys(MATERIALS).map((k) => [k, k])), F.mat, (v) => { F.mat = v; this.showFeaPanel(); }), el('span', { class: 'muted small' }, `E ${fmt(mat.E, 0)} MPa · yield ${mat.yield} MPa`)),
			el('div', { class: 'fea-row' }, el('span', {}, 'Detail'), sel(RES, F.res, (v) => { F.res = v; })),
			el('div', { class: 'fea-row' }, el('button', { class: 'btn primary', onclick: () => this.runFea() }, 'Run stress check'), el('div', { class: 'fea-progress' }, el('div', { class: 'fea-bar' }))),
			el('div', { class: 'muted small' }, this.tool === 'feapick' ? `Click faces on the part to add them as ${F.pick === 'fixed' ? 'fixed (held still)' : 'loaded (where the force is applied)'}; click again to remove.` : 'Fixed faces are held in place; the force is spread over the loaded faces.'));
		if (F.result) this.feaResultsInto(panel);
		panel.style.display = '';
	},

	feaPick(kind) {
		this.fea.pick = kind;
		if (this.tool !== 'feapick') this.setTool('feapick');
		this.feaMarks();
		this.showFeaPanel();
	},

	onFeaClick(e) {
		const F = this.fea;
		if (!F) return;
		const sp = this.vp.surfacePoint(e);
		if (!sp || !sp.object) return;
		const top = this.model.topLevelOf(sp.object.userData.nodeId);
		if (!top || top.id !== F.node.id) { toast(`Pick faces on “${F.node.name}”`, 'warn'); return; }
		const reg = faceRegion(sp.object, sp.faceIndex);
		if (!reg) return;
		const n = reg.curved ? reg.normal.clone() : new THREE.Vector3(0, 0, 1).applyQuaternion(reg.basis.quat);
		const key = reg.tris.slice(0, 9).map((v) => v.toFixed(3)).join(',');
		const list = F.pick === 'fixed' ? F.fixed : F.loads;
		const other = F.pick === 'fixed' ? F.loads : F.fixed;
		const i = list.findIndex((f) => f.key === key);
		if (i >= 0) list.splice(i, 1);
		else { const j = other.findIndex((f) => f.key === key); if (j >= 0) other.splice(j, 1); list.push({ key, tris: Float32Array.from(reg.tris), normal: n.normalize() }); }
		F.result = null;
		this.clearFeaResult();
		this.feaMarks();
		this.showFeaPanel();
	},

	/** Green (fixed) and orange (loaded) face highlights. */
	feaMarks() {
		const F = this.fea;
		if (this.feaMarkObj) { this.vp.helpers.remove(this.feaMarkObj); this.feaMarkObj.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); this.feaMarkObj = null; }
		if (!F) { this.vp.invalidate(); return; }
		const g = new THREE.Group();
		const add = (list, color) => { for (const f of list) { const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(f.tris, 3)); g.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.85, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }))); } };
		add(F.fixed, 0x2fbf71);
		add(F.loads, 0xff9a3c);
		// force arrows
		for (const f of F.loads) {
			const c = new THREE.Vector3(), p = f.tris;
			for (let i = 0; i < p.length; i += 3) c.add(new THREE.Vector3(p[i], p[i + 1], p[i + 2]));
			c.multiplyScalar(3 / p.length);
			const d = this.feaDirection(f.normal);
			const L = this.worldBox(F.node).getSize(new THREE.Vector3()).length() * 0.18;
			g.add(new THREE.ArrowHelper(d, c.clone().addScaledVector(d, -L), L, 0xff6a00, L * 0.3, L * 0.15));
		}
		this.vp.helpers.add(g);
		this.feaMarkObj = g;
		this.vp.invalidate();
	},

	feaDirection(normal) {
		const d = this.fea.dir;
		if (d === 'push') return normal.clone().negate();
		if (d === 'pull') return normal.clone();
		const v = new THREE.Vector3(); v[d[1]] = d[0] === '-' ? -1 : 1;
		return v;
	},

	async runFea() {
		const F = this.fea;
		if (!F.fixed.length) { toast('Pick at least one fixed face (where the part is held)', 'warn'); return; }
		if (!F.loads.length) { toast('Pick at least one loaded face (where the force pushes)', 'warn'); return; }
		const geom = this.engine.world(F.node);
		if (!geom) return;
		const bar = document.querySelector('#fea-panel .fea-bar');
		const setP = (f) => { if (bar) bar.style.width = Math.round(f * 100) + '%'; };
		setP(0.02);
		await new Promise((r) => setTimeout(r, 30));
		const t0 = performance.now();
		const vox = voxelize(geom, RES[F.res][1]);
		const tol = Math.min(vox.hx, vox.hy, vox.hz) * 0.6;
		const fixedNodes = nodesNear(vox, concatTris(F.fixed), tol);
		const loadNodes = nodesNear(vox, concatTris(F.loads), tol).filter((n) => !fixedNodes.includes(n));
		if (!fixedNodes.length || !loadNodes.length) { toast('The picked faces are too small for this detail level — try Fine', 'error'); setP(0); return; }
		const nn = (vox.nx + 1) * (vox.ny + 1) * (vox.nz + 1), loads = new Float64Array(nn * 3);
		const avgN = F.loads.reduce((a, f) => a.add(f.normal), new THREE.Vector3()).normalize();
		const dir = this.feaDirection(avgN), per = F.force / loadNodes.length;
		for (const n of loadNodes) { loads[3 * n] = dir.x * per; loads[3 * n + 1] = dir.y * per; loads[3 * n + 2] = dir.z * per; }
		const mat = MATERIALS[F.mat];
		try {
			const res = await solveFEA(vox, fixedNodes, loads, mat, (f) => setP(0.05 + 0.9 * f));
			setP(1);
			const flat = geom.index ? geom.toNonIndexed() : geom;
			const s = sampleResults(vox, res, flat.attributes.position.array);
			F.result = { ...s, positions: flat.attributes.position.array, vox, iterations: res.iterations, converged: res.converged, ms: performance.now() - t0, elements: res.vm.length, mat, force: F.force };
			F.deform = s.maxDisp > 0 ? Math.max(1, Math.round((this.worldBox(F.node).getSize(new THREE.Vector3()).length() * 0.06) / s.maxDisp)) : 1;
			this.setTool(null);
			this.setSelection([]);
			this.showFeaResult();
			this.vp.frameBox(this.vp.selectionBox([F.node.id]));
			this.showFeaPanel();
		} catch (e) {
			console.error(e);
			toast('Stress check failed: ' + e.message, 'error', 5000);
			setP(0);
		}
	},

	/** Colored (and optionally deformed) copy of the part replaces it in the view while results are shown. */
	showFeaResult() {
		const F = this.fea, R = F.result;
		this.clearFeaResult(true);
		const pos = R.positions, count = pos.length / 3;
		const out = new Float32Array(pos.length), col = new Float32Array(pos.length);
		const k = F.showDeformed === false ? 0 : F.deform;
		for (let v = 0; v < count; v++) {
			for (let q = 0; q < 3; q++) out[3 * v + q] = pos[3 * v + q] + R.disp[3 * v + q] * k;
			const c = stressColor(R.stress[v] / (R.peak || 1));
			col[3 * v] = c[0]; col[3 * v + 1] = c[1]; col[3 * v + 2] = c[2];
		}
		const geo = new THREE.BufferGeometry();
		geo.setAttribute('position', new THREE.BufferAttribute(out, 3));
		geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
		geo.computeVertexNormals();
		const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
		mesh.renderOrder = 1;
		this.vp.helpers.add(mesh);
		this.feaResultObj = mesh;
		const disp = this.vp.objs.get(F.node.id);
		if (disp) disp.visible = false;
		this.vp.invalidate();
	},

	clearFeaResult(keepData) {
		if (this.feaResultObj) { this.vp.helpers.remove(this.feaResultObj); this.feaResultObj.geometry.dispose(); this.feaResultObj = null; }
		if (this.fea) { const o = this.vp.objs.get(this.fea.node.id); if (o) o.visible = true; if (!keepData) this.fea.result = null; }
		this.vp.invalidate();
	},

	feaResultsInto(panel) {
		const F = this.fea, R = F.result, y = R.mat.yield;
		const sf = R.peak > 0 ? y / R.peak : Infinity;
		const verdict = sf >= 2 ? ['ok', 'Looks strong enough'] : sf >= 1 ? ['warn', 'Marginal — little safety margin'] : ['error', 'Likely to bend permanently or break'];
		const slider = el('input', { type: 'range', min: 0, max: Math.max(10, F.deform * 4), value: F.deform, style: 'flex:1' });
		slider.addEventListener('input', () => { F.deform = +slider.value; F.showDeformed = true; this.showFeaResult(); lbl.textContent = '×' + F.deform; });
		const lbl = el('span', { class: 'muted small' }, '×' + F.deform);
		panel.append(
			el('div', { class: 'fea-legend' }, el('span', {}, '0'), el('div', { class: 'fea-grad' }), el('span', {}, fmt(R.peak, 2) + ' MPa')),
			el('div', { class: 'fp-item ' + verdict[0] }, el('span', { class: 'fp-ic' }, verdict[0] === 'ok' ? '✓' : verdict[0] === 'warn' ? '⚠' : '✕'), el('div', {},
				el('div', { class: 'fp-title' }, verdict[1]),
				el('div', { class: 'fp-detail' }, `Peak stress ${fmt(R.peak, 2)} MPa (max ${fmt(R.max, 2)}) · yield ${y} MPa · safety factor ${isFinite(sf) ? fmt(sf, 2) : '∞'}`),
				el('div', { class: 'fp-detail' }, `Max deflection ${fmt(R.maxDisp, 3)} mm under ${fmt(R.force, 1)} N`))),
			el('div', { class: 'fea-row' }, el('span', { class: 'muted small' }, 'Deformation'), slider, lbl),
			el('div', { class: 'muted small' }, `${R.elements.toLocaleString()} bricks of ${fmt(R.vox.hx, 2)} × ${fmt(R.vox.hy, 2)} × ${fmt(R.vox.hz, 2)} mm · ${R.iterations} iterations · ${Math.round(R.ms)} ms${R.converged ? '' : ' · did not fully converge'}. Approximate: assumes solid (100% infill) material equally strong in every direction — printed parts are often 30–50% weaker across layers, so aim for a safety factor of 2 or more.`));
	},

	closeFea() {
		this.clearFeaResult();
		this.fea = null;
		this.feaMarks();
		if (this.tool === 'feapick') this.setTool(null);
		const p = document.querySelector('#fea-panel');
		if (p) p.style.display = 'none';
	},
};

function concatTris(list) {
	const n = list.reduce((a, f) => a + f.tris.length, 0), out = new Float32Array(n);
	let o = 0;
	for (const f of list) { out.set(f.tris, o); o += f.tris.length; }
	return out;
}
