// Surface texture and deform (bend, twist, taper, lattice): the commands, their Properties fields, and the lattice
// editor (drag lattice points in the 3D view). The geometry is in modifiers.js; the groups are ordinary groups with
// mode 'texture' or 'deform', so the parts inside stay editable.
import * as THREE from 'three';
import { TEXTURES, TEXTURE_FACES, TEXTURE_MAPS, TEXTURE_DEFAULTS, DEFORM_DEFAULTS, bendDirs, emptyLattice, latticePoint, makeDeform, invertRest, textureDetail } from './modifiers.js';
import { nodeMatrix } from './engine.js';
import { round, fmt, toast, el } from './util.js';

const HANDLE_PX = 9; // how close (px) the pointer must be to grab a lattice point

export const ModifierMixin = {
	addTexture() {
		const nodes = this.selectedNodes();
		if (!nodes.length) { toast('Select a part to texture', 'warn'); return; }
		this.group('texture', 'Texture', { texture: { ...TEXTURE_DEFAULTS } });
		toast('Texture added — pick the pattern, size and depth on the right', 'info', 3000);
	},

	addDeform() {
		const nodes = this.selectedNodes();
		if (!nodes.length) { toast('Select a part to deform', 'warn'); return; }
		this.group('deform', 'Deform', { deform: { ...DEFORM_DEFAULTS } });
		toast('Deform added — set bend, twist or taper on the right, or edit the lattice', 'info', 3000);
	},

	/** The undeformed solid's box in the group's frame (the same box the kernel uses). */
	modifierBox(n) {
		const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
		const v = new THREE.Vector3();
		for (const c of n.children) {
			if (c.hole || (this.engine.offIds && this.engine.offIds.has(c.id))) continue;
			const g = this.engine.geometry(c);
			if (!g) continue;
			if (!g.boundingBox) g.computeBoundingBox();
			const M = nodeMatrix(c), b = g.boundingBox;
			// exact: the box of the placed vertices (a rotated part's box is not its corners' box)
			const p = g.attributes.position.array;
			if (p.length / 3 > 200000) {
				for (let i = 0; i < 8; i++) { v.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z).applyMatrix4(M); for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], v.getComponent(k)); max[k] = Math.max(max[k], v.getComponent(k)); } }
			} else {
				for (let i = 0; i < p.length; i += 3) { v.set(p[i], p[i + 1], p[i + 2]).applyMatrix4(M); for (let k = 0; k < 3; k++) { const x = v.getComponent(k); if (x < min[k]) min[k] = x; if (x > max[k]) max[k] = x; } }
			}
		}
		return isFinite(min[0]) ? { min, max } : null;
	},

	/** Properties fields for a texture or deform group. */
	modifierProps(sec, n) {
		const row = (label, input, title) => el('label', { class: 'field', title: title || '' }, el('span', { class: 'lbl' }, label), input);
		const select = (options, value, onChange) => {
			const s = el('select', {}, ...Object.entries(options).map(([v, l]) => el('option', { value: v }, l)));
			s.value = value;
			s.addEventListener('change', () => onChange(s.value));
			return s;
		};
		const num = (obj, key, path, step, opts = {}) => {
			const inp = this.numInput(obj[key] ?? 0, (v, expr) => { obj[key] = v; this.setExpr(n, path, expr); this.commit(); }, step, { expr: () => (n.exprs || {})[path] || null, ...opts });
			this.fields.push({ refresh: () => inp._setValue(obj[key] ?? 0) });
			return inp;
		};
		if (n.mode === 'texture') {
			const t = (n.texture = { ...TEXTURE_DEFAULTS, ...(n.texture || {}) });
			sec.appendChild(el('label', { class: 'field wide' }, el('span', {}, 'Pattern'), select(TEXTURES, t.pattern, (v) => {
				t.pattern = v;
				if (v === 'knurl') t.angle = 45; else if (v === 'ribs' || v === 'waves') t.angle = 0;
				this.propSig = null; this.commit();
			})));
			sec.appendChild(row('Size (mm)', num(t, 'size', 'texture.size', 0.5, { min: 0.2 }), 'How far apart the pattern repeats'));
			sec.appendChild(row('Depth (mm)', num(t, 'depth', 'texture.depth', 0.1), 'How far it stands out; negative cuts into the surface'));
			if (t.pattern === 'knurl' || t.pattern === 'ribs' || t.pattern === 'waves') sec.appendChild(row('Angle (°)', num(t, 'angle', 'texture.angle', 15), t.pattern === 'knurl' ? 'Angle of the crossing grooves (45 = square diamonds)' : 'Direction of the ribs (0 = across the first axis, 90 = along it)'));
			if (t.pattern === 'noise') sec.appendChild(row('Seed', num(t, 'seed', 'texture.seed', 1, { int: true, min: 1 }), 'Change for a different random pattern'));
			sec.appendChild(el('label', { class: 'field wide' }, el('span', {}, 'Apply to'), select(TEXTURE_FACES, t.faces, (v) => { t.faces = v; this.commit(); })));
			if (t.pattern !== 'noise') sec.appendChild(el('label', { class: 'field wide', title: 'Cylinder wraps the pattern seamlessly around round parts (knobs, handles)' }, el('span', {}, 'Wrap'), select(TEXTURE_MAPS, t.mapping, (v) => { t.mapping = v; this.commit(); })));
			sec.appendChild(row('Detail (mm)', num(t, 'detail', 'texture.detail', 0.05, { min: 0 }), 'Triangle size; 0 = automatic (finer for hexagons and bumps). Smaller is smoother but slower.'));
			const area = n.children.filter((c) => !c.hole).reduce((a, c) => { const g = this.engine.geometry(c); return a + (g ? surfaceArea(g) : 0); }, 0);
			const L = textureDetail(t, area);
			const tris = Math.round(area / (0.433 * L * L));
			sec.appendChild(el('div', { class: 'muted small pad-x' }, `Up to about ${tris > 1e6 ? (tris / 1e6).toFixed(1) + ' million' : Math.round(tris / 1000) + 'k'} triangles at ${fmt(L, 2)} mm${t.detail > 0 && L > t.detail + 1e-9 ? ' (coarsened to keep the part manageable)' : ''}. Big or fine textures take a few seconds.`));
			return;
		}
		const d = (n.deform = { ...DEFORM_DEFAULTS, ...(n.deform || {}) });
		if (!bendDirs(d.axis).includes(d.bendDir)) d.bendDir = bendDirs(d.axis)[0];
		sec.appendChild(el('label', { class: 'field wide' }, el('span', {}, 'Along axis'), select({ z: 'Z (up)', x: 'X', y: 'Y' }, d.axis, (v) => { d.axis = v; d.bendDir = bendDirs(v)[0]; this.propSig = null; this.commit(); })));
		sec.appendChild(row('Bend (°)', num(d, 'bend', 'deform.bend', 15), 'Bend the part into an arc of this angle'));
		sec.appendChild(el('label', { class: 'field wide' }, el('span', {}, 'Bend toward'), select(Object.fromEntries(bendDirs(d.axis).map((k) => [k, k.toUpperCase()])), d.bendDir, (v) => { d.bendDir = v; this.commit(); })));
		sec.appendChild(row('Twist (°)', num(d, 'twist', 'deform.twist', 15), 'Turn the far end by this angle'));
		sec.appendChild(row('Taper (end scale)', num(d, 'taper', 'deform.taper', 0.1, { min: 0.01 }), '1 = straight; 0.5 = the far end half as wide'));
		const lat = d.lattice;
		const latSel = select({ 0: 'Off', 2: '2 × 2 × 2', 3: '3 × 3 × 3', 4: '4 × 4 × 4' }, String(lat ? lat.n[0] : 0), (v) => {
			const k = +v;
			const moved = lat && lat.d.some((q) => q[0] || q[1] || q[2]);
			if (moved && !confirm('Change the lattice? The points you moved go back to rest.')) { latSel.value = String(lat.n[0]); return; }
			d.lattice = k ? emptyLattice(k) : null;
			this.propSig = null;
			this.commit();
			if (k) this.startLattice(n); else this.stopLattice();
		});
		sec.appendChild(el('label', { class: 'field wide', title: 'Free-form deform: drag the lattice points in the view and the part follows smoothly' }, el('span', {}, 'Lattice'), latSel));
		if (lat) {
			const editing = this.lattice && this.lattice.node === n;
			const moved = lat.d.filter((q) => q[0] || q[1] || q[2]).length;
			sec.appendChild(el('div', { class: 'btn-row' },
				el('button', { class: 'btn' + (editing ? ' on' : ''), title: 'Show the lattice points in the view; drag one to reshape (Shift: along one axis). Esc when done.', onclick: () => (editing ? this.stopLattice() : this.startLattice(n)) }, editing ? 'Done editing' : 'Edit lattice points'),
				el('button', { class: 'btn', disabled: !moved, onclick: () => { d.lattice = emptyLattice(lat.n[0]); this.commit(); } }, 'Reset')));
			sec.appendChild(el('div', { class: 'muted small pad-x' }, moved ? `${moved} of ${lat.d.length} points moved` : 'Drag the points to reshape the part'));
		}
		sec.appendChild(row('Smoothness', num(d, 'detail', 'deform.detail', 8, { int: true, min: 0 }), 'Pieces along the longest side; 0 = automatic (48)'));
	},

	// ------------------------------------------------------------ lattice editor

	startLattice(n) {
		this.stopLattice();
		if (!n || n.mode !== 'deform' || !n.deform || !n.deform.lattice) return;
		const vp = this.vp;
		const pts = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0xffb020, size: 9, sizeAttenuation: false, depthTest: false, transparent: true }));
		const hot = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0xffffff, size: 13, sizeAttenuation: false, depthTest: false, transparent: true }));
		const cage = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffb020, depthTest: false, transparent: true, opacity: 0.55 }));
		for (const o of [cage, pts, hot]) { o.renderOrder = 999; o.raycast = () => {}; o.frustumCulled = false; vp.scene.add(o); }
		const L = (this.lattice = { node: n, pts, hot, cage, world: [], hover: -1, drag: null });
		const down = (e) => this.latticeDown(e);
		const move = (e) => this.latticeHover(e);
		const key = (e) => { if (e.key === 'Escape' && !e.target.closest?.('input, textarea')) { e.preventDefault(); this.stopLattice(); } };
		vp.canvas.addEventListener('pointerdown', down, true);
		vp.canvas.addEventListener('pointermove', move);
		window.addEventListener('keydown', key, true);
		L.off = () => { vp.canvas.removeEventListener('pointerdown', down, true); vp.canvas.removeEventListener('pointermove', move); window.removeEventListener('keydown', key, true); };
		this.latticeSync();
		this.onHint('Drag a lattice point to reshape (Shift: along one axis) · Esc when done');
		this.propSig = null;
		this.renderProps();
	},

	stopLattice() {
		const L = this.lattice;
		if (!L) return;
		this.lattice = null;
		L.off();
		for (const o of [L.cage, L.pts, L.hot]) { this.vp.scene.remove(o); o.geometry.dispose(); o.material.dispose(); }
		this.onHint('');
		this.vp.invalidate();
		this.propSig = null;
		this.renderProps();
	},

	/** Where the lattice points are (world), redrawn after any change; stops when the group is gone or changed. */
	latticeSync() {
		const L = this.lattice;
		if (!L) return;
		const n = this.model.get(L.node.id);
		if (!n || n.mode !== 'deform' || !n.deform || !n.deform.lattice || !this.vp.objs.has(n.id)) { this.stopLattice(); return; }
		L.node = n;
		const d = n.deform, lat = d.lattice, box = this.modifierBox(n);
		if (!box) return;
		L.box = box;
		L.f = makeDeform({ ...d, lattice: null }, box);
		const W = this.worldMatrix(n);
		L.M = W;
		L.Minv = W.clone().invert();
		const [nx, ny, nz] = lat.n;
		L.local = [];
		L.world = [];
		for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
			const p0 = latticePoint(box, lat.n, i, j, k), off = lat.d[i + nx * (j + ny * k)] || [0, 0, 0];
			const q = L.f.rest([p0[0] + off[0], p0[1] + off[1], p0[2] + off[2]]);
			L.local.push(q);
			L.world.push(new THREE.Vector3(...q).applyMatrix4(W));
		}
		this.latticeDraw();
	},

	latticeDraw() {
		const L = this.lattice, lat = L.node.deform.lattice, [nx, ny, nz] = lat.n;
		const pos = new Float32Array(L.world.length * 3);
		L.world.forEach((p, i) => p.toArray(pos, 3 * i));
		L.pts.geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
		L.pts.geometry.computeBoundingSphere();
		const seg = [];
		const at = (i, j, k) => L.world[i + nx * (j + ny * k)];
		for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
			if (i + 1 < nx) seg.push(at(i, j, k), at(i + 1, j, k));
			if (j + 1 < ny) seg.push(at(i, j, k), at(i, j + 1, k));
			if (k + 1 < nz) seg.push(at(i, j, k), at(i, j, k + 1));
		}
		const sp = new Float32Array(seg.length * 3);
		seg.forEach((p, i) => p.toArray(sp, 3 * i));
		L.cage.geometry.setAttribute('position', new THREE.BufferAttribute(sp, 3));
		L.cage.geometry.computeBoundingSphere();
		const h = L.drag ? L.drag.i : L.hover;
		L.hot.geometry.setAttribute('position', new THREE.BufferAttribute(h >= 0 ? new Float32Array(L.world[h].toArray()) : new Float32Array(0), 3));
		this.vp.invalidate();
	},

	/** The lattice point under the pointer (index), or -1. */
	latticePick(e) {
		const L = this.lattice, vp = this.vp, r = vp.canvas.getBoundingClientRect();
		let best = -1, bd = HANDLE_PX;
		L.world.forEach((p, i) => {
			const s = p.clone().project(vp.camera);
			if (s.z > 1) return;
			const x = r.left + ((s.x + 1) / 2) * r.width, y = r.top + ((1 - s.y) / 2) * r.height;
			const dd = Math.hypot(x - e.clientX, y - e.clientY);
			if (dd < bd) { bd = dd; best = i; }
		});
		return best;
	},

	latticeHover(e) {
		const L = this.lattice;
		if (!L || L.drag) return;
		const h = this.latticePick(e);
		if (h !== L.hover) { L.hover = h; this.latticeDraw(); }
		if (h >= 0) this.vp.canvas.style.cursor = 'grab';
	},

	latticeDown(e) {
		const L = this.lattice;
		if (!L || e.button !== 0) return;
		const i = this.latticePick(e);
		if (i < 0) return;
		e.stopImmediatePropagation();
		e.preventDefault();
		const vp = this.vp, n = L.node, lat = n.deform.lattice;
		const start = L.world[i].clone();
		const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(vp.camera.getWorldDirection(new THREE.Vector3()), start);
		const ray = new THREE.Raycaster();
		const hit = (ev) => {
			const r = vp.canvas.getBoundingClientRect();
			ray.setFromCamera(new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1), vp.camera);
			return ray.ray.intersectPlane(plane, new THREE.Vector3());
		};
		const grab = hit(e);
		if (!grab) return;
		const p0 = (() => { const [nx, ny] = lat.n, k = Math.floor(i / (nx * ny)), j = Math.floor((i % (nx * ny)) / nx), ii = i % nx; return latticePoint(L.box, lat.n, ii, j, k); })();
		const off0 = (lat.d[i] || [0, 0, 0]).slice();
		// live preview: move the shown mesh by this point's share of the change (the real rebuild runs on release)
		const mesh = vp.displays.get(n.id);
		const preview = mesh && mesh.geometry.attributes.position && mesh.geometry.attributes.position.count <= 400000 ? latticePreview(mesh, L, i, lat) : null;
		L.drag = { i };
		vp.controls.enabled = false;
		vp.canvas.style.cursor = 'grabbing';
		const snap = Math.max(0.01, Math.min(1, (this.model.settings.snap || 0.1) / 10));
		let off = off0;
		const mv = (ev) => {
			const p = hit(ev);
			if (!p) return;
			let dw = p.sub(grab);
			if (ev.shiftKey) {
				// along the one world axis it moved most
				const a = Math.abs(dw.x) >= Math.abs(dw.y) && Math.abs(dw.x) >= Math.abs(dw.z) ? 'x' : Math.abs(dw.y) >= Math.abs(dw.z) ? 'y' : 'z';
				dw = new THREE.Vector3().setComponent('xyz'.indexOf(a), dw[a]);
			}
			const target = start.clone().add(dw).applyMatrix4(L.Minv).toArray();
			// the lattice offset that puts the point there, through bend / twist / taper
			const q = L.f.restOn ? invertRest(L.f.rest, target, L.local[i]) : target;
			off = [0, 1, 2].map((k) => Math.round((q[k] - p0[k]) / snap) * snap);
			L.world[i] = new THREE.Vector3(...L.f.rest([p0[0] + off[0], p0[1] + off[1], p0[2] + off[2]])).applyMatrix4(L.M);
			if (preview) preview.set([off[0] - off0[0], off[1] - off0[1], off[2] - off0[2]]);
			this.latticeDraw();
			this.onHint(`Lattice point moved ${fmt(off[0], 2)}, ${fmt(off[1], 2)}, ${fmt(off[2], 2)} mm from rest`);
		};
		const up = () => {
			window.removeEventListener('pointermove', mv);
			window.removeEventListener('pointerup', up);
			vp.controls.enabled = true;
			L.drag = null;
			vp.canvas.style.cursor = '';
			const changed = off.some((v, k) => Math.abs(v - off0[k]) > 1e-9);
			if (preview) preview.done(changed, vp);
			if (changed) {
				lat.d[i] = off.map((v) => round(v, 4));
				this.propSig = null;
				this.commit();
			} else this.latticeSync();
			this.onHint('Drag a lattice point to reshape (Shift: along one axis) · Esc when done');
		};
		window.addEventListener('pointermove', mv);
		window.addEventListener('pointerup', up);
	},
};

/**
 * Preview of moving one lattice point on the shown (already deformed) mesh: each vertex is traced back through the
 * deform to its lattice coordinates once, then moved by that point's Bézier weight as the point is dragged.
 */
function latticePreview(mesh, L, idx, lat) {
	const orig = mesh.geometry;
	const g = orig.clone();
	mesh.geometry = g;
	const P = g.attributes.position, n = P.count, src = new Float32Array(P.array);
	const [nx, ny, nz] = lat.n, ii = idx % nx, j = Math.floor((idx % (nx * ny)) / nx), k = Math.floor(idx / (nx * ny));
	const box = L.box, size = [0, 1, 2].map((a) => box.max[a] - box.min[a]);
	const C = [[1], [1, 1], [1, 2, 1], [1, 3, 3, 1]];
	const B = (cnt, i, t) => C[cnt - 1][i] * Math.pow(t, i) * Math.pow(1 - t, cnt - 1 - i);
	const pre = new Float32Array(n * 3), w = new Float32Array(n);
	for (let v = 0; v < n; v++) {
		const p = [src[3 * v], src[3 * v + 1], src[3 * v + 2]];
		const q = L.f.restOn ? invertRest(L.f.rest, p) : p;
		pre[3 * v] = q[0]; pre[3 * v + 1] = q[1]; pre[3 * v + 2] = q[2];
		const t = [0, 1, 2].map((a) => (size[a] > 1e-9 ? Math.min(1, Math.max(0, (q[a] - box.min[a]) / size[a])) : 0.5));
		w[v] = B(nx, ii, t[0]) * B(ny, j, t[1]) * B(nz, k, t[2]);
	}
	return {
		set(dv) {
			const a = P.array;
			for (let v = 0; v < n; v++) {
				const q = [pre[3 * v] + w[v] * dv[0], pre[3 * v + 1] + w[v] * dv[1], pre[3 * v + 2] + w[v] * dv[2]];
				const r = L.f.restOn ? L.f.rest(q) : q;
				a[3 * v] = r[0]; a[3 * v + 1] = r[1]; a[3 * v + 2] = r[2];
			}
			P.needsUpdate = true;
			g.computeVertexNormals();
			g.computeBoundingSphere();
		},
		done(changed, vp) {
			if (!changed) { mesh.geometry = orig; g.dispose(); return; }
			// keep showing the preview until the rebuild replaces this mesh (it may build in the background)
			const id = mesh.userData.nodeId;
			const gone = () => { if (vp.displays.get(id) !== mesh) g.dispose(); else setTimeout(gone, 400); };
			setTimeout(gone, 400);
		},
	};
}

function surfaceArea(g) {
	const p = g.attributes.position.array, idx = g.index ? g.index.array : null, n = idx ? idx.length : p.length / 3;
	let a = 0;
	for (let t = 0; t < n; t += 3) {
		const i = (idx ? idx[t] : t) * 3, j = (idx ? idx[t + 1] : t + 1) * 3, k = (idx ? idx[t + 2] : t + 2) * 3;
		const ux = p[j] - p[i], uy = p[j + 1] - p[i + 1], uz = p[j + 2] - p[i + 2], vx = p[k] - p[i], vy = p[k + 1] - p[i + 1], vz = p[k + 2] - p[i + 2];
		a += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
	}
	return a;
}
