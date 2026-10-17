// Sculpt mode, like Blender's: shape a part's surface with brushes. The part is turned into an evenly subdivided
// mesh, you sculpt with the left mouse button (right-drag still orbits), and Done turns the result into a solid
// mesh part (the original is kept, so it can be brought back). Keys: 1–8 brushes, F radius, Shift+F strength,
// [ ] radius, Ctrl inverts, Shift smooths, X/Y/Z symmetry, Ctrl+Z / Ctrl+Shift+Z undo / redo, Enter done.
import * as THREE from 'three';
import { SculptSession, BRUSHES, FALLOFFS, packIndexed, unpackIndexed } from './sculpt.js';
import { toManifold, rawOf } from './csgcore.js';
import { hasManifold } from './engine.js';
import { hashString, fmt, toast, el } from './util.js';

const MAX_TRIS = 1500000;
const $ = (s) => document.querySelector(s);
const DETAIL = [['low', 'Low', 60], ['medium', 'Medium', 110], ['high', 'High', 180], ['ultra', 'Very high', 280]];

export const SculptMixin = {
	/** Start sculpting the selected part (asks for the detail level unless it is already a sculpted mesh). */
	startSculpt(node = this.selectedNodes()[0]) {
		if (this.sculpt) return;
		if (!node) { toast('Select a part to sculpt', 'warn'); return; }
		if (!this.model.isTopLevel(node.id)) { toast('Sculpt works on whole parts: select the group this part is in (or ungroup it first)', 'warn', 4500); return; }
		if (node.hole) { toast('Holes can’t be sculpted — make it solid first', 'warn'); return; }
		if (!hasManifold()) { toast('Sculpting needs the geometry engine, which isn’t available here', 'error'); return; }
		const blob = node.type === 'mesh' ? this.model.blobs[node.params.blob] : null;
		if (blob && blob.startsWith('IDX1:')) { const m = unpackIndexed(blob); this.enterSculpt(node, m.positions, m.index); return; }
		const g = this.engine.geometry(node);
		if (!g) { toast('That part is empty', 'warn'); return; }
		let m;
		try { m = toManifold(g); } catch (e) { toast('Only closed solids can be sculpted (this one has gaps)', 'error', 4000); return; }
		const area = m.surfaceArea(), bb = m.boundingBox(), size = Math.max(...[0, 1, 2].map((i) => bb.max[i] - bb.min[i]));
		const est = (div) => { const L = Math.max(size / div, Math.sqrt(area / (0.433 * MAX_TRIS))); return { L, tris: Math.round(area / (0.433 * L * L)) }; };
		const go = (div) => {
			const { L } = est(div);
			const lsc = this.loadingScreen('Preparing to sculpt', true);
			lsc.set(0.3, 'Subdividing the surface');
			setTimeout(() => {
				try {
					// subdivided only: the shape stays exactly as it was (no rounding of edges or facets)
					const fine = m.refineToLength(L), r = rawOf(fine);
					fine.delete();
					this.enterSculpt(node, new Float32Array(r.pos), new Uint32Array(r.idx));
				} catch (e) { console.error(e); toast('Could not prepare the part for sculpting: ' + e.message, 'error', 5000); }
				m.delete();
				lsc.done();
			}, 30);
		};
		const pick = el('select', { id: 'sc-detail' }, ...DETAIL.map(([k, label, div]) => { const e = est(div); return el('option', { value: k }, `${label} — ${e.tris > 1e6 ? (e.tris / 1e6).toFixed(1) + 'M' : Math.round(e.tris / 1000) + 'k'} triangles, ${fmt(e.L, 2)} mm`); }));
		pick.value = 'medium';
		this.modal('Sculpt “' + node.name + '”', el('div', { class: 'form' },
			el('p', { class: 'small' }, 'The part becomes a detailed mesh you can shape with brushes, like clay. Its settings (sizes, sketch, …) can’t be edited while it is sculpted, but the original is kept: you can bring it back from the Properties panel.'),
			el('label', { class: 'row' }, el('span', {}, 'Detail'), pick),
			el('p', { class: 'muted small' }, 'More detail means finer features but slower brushes. You can add detail later with Refine.')),
			[{ label: 'Cancel', action: () => m.delete() }, { label: 'Start sculpting', primary: true, action: () => go(DETAIL.find((d) => d[0] === pick.value)[2]) }]);
	},

	enterSculpt(node, positions, index) {
		const session = new SculptSession(positions, index);
		const vp = this.vp;
		const mat = new THREE.MeshStandardMaterial({ color: node.color || '#e8613a', roughness: 0.55, metalness: 0.05 });
		const mesh = new THREE.Mesh(session.geometry, mat);
		mesh.matrixAutoUpdate = false;
		mesh.matrix.copy(this.worldMatrix(node));
		mesh.matrixWorldNeedsUpdate = true;
		mesh.raycast = () => {}; // we raycast the session ourselves
		const ring = new THREE.LineLoop(circleGeometry(), new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.85 }));
		ring.renderOrder = 999; ring.visible = false; ring.raycast = () => {};
		vp.scene.add(mesh, ring);
		const S = (this.sculpt = {
			node, session, mesh, ring, history: [],
			// symmetry starts off: a stroke changes only the spot under the brush (turn it on with X / Y / Z)
			brush: 'draw', radiusPx: 60, strength: 0.5, falloff: 'smooth', symmetry: [false, false, false], mirrorRings: [],
			M: mesh.matrix.clone(), Minv: mesh.matrix.clone().invert(), modified: false,
		});
		const scl = new THREE.Vector3().setFromMatrixScale(S.M);
		S.scale = (Math.abs(scl.x) + Math.abs(scl.y) + Math.abs(scl.z)) / 3 || 1;
		// a part that is tiny on screen is hard to sculpt: bring it into view; then start with a brush about a
		// seventh of its size (a fixed pixel size could cover a whole small part)
		const sph = session.geometry.boundingSphere.clone().applyMatrix4(S.M);
		const pxOf = () => { const S2 = this.sculpt; const keep = S2.radiusPx; S2.radiusPx = 1; const perPx = this.sculptRadius(sph.center.clone().applyMatrix4(S.Minv).toArray()) * S.scale; S2.radiusPx = keep; return sph.radius / perPx; };
		if (pxOf() < 120) { this.vp.frameBox(new THREE.Box3().setFromCenterAndSize(sph.center, new THREE.Vector3(1, 1, 1).multiplyScalar(sph.radius * 2))); }
		S.fitRadius = () => { S.radiusPx = Math.max(10, Math.min(150, Math.round(pxOf() * 0.15))); };
		S.fitRadius();
		setTimeout(() => { if (this.sculpt === S) { S.fitRadius(); this.renderSculptPanel(); } }, 350); // after the zoom
		this.setSelection([]);
		this.setTool(null);
		const disp = vp.displays.get(node.id);
		if (disp) { S.hidden = disp; disp.visible = false; }
		vp.tool = 'sculpt';
		// input
		const down = (e) => this.sculptDown(e), move = (e) => this.sculptHover(e), key = (e) => this.sculptKey(e);
		vp.canvas.addEventListener('pointerdown', down, true);
		vp.canvas.addEventListener('pointermove', move);
		window.addEventListener('keydown', key, true);
		S.off = () => { vp.canvas.removeEventListener('pointerdown', down, true); vp.canvas.removeEventListener('pointermove', move); window.removeEventListener('keydown', key, true); };
		document.body.classList.add('sculpting');
		this.renderSculptPanel();
		this.onHint('Sculpt: left-drag to shape · Ctrl inverts · Shift smooths · F radius · Shift+F strength · right-drag orbits');
		vp.invalidate();
	},

	/** Leave sculpt mode. keep: save the result as the part (otherwise everything is discarded). */
	exitSculpt(keep) {
		const S = this.sculpt;
		if (!S) return;
		if (!keep && S.modified && !confirm('Discard your sculpting?')) return;
		const vp = this.vp;
		let result = null;
		if (keep && S.modified) result = S.session.export();
		this.sculpt = null;
		S.off();
		this.endSizeAdjust && this.endSizeAdjust(false, S);
		vp.scene.remove(S.mesh, S.ring, ...S.mirrorRings);
		for (const m of S.mirrorRings) m.material.dispose();
		S.mesh.material.dispose(); S.ring.geometry.dispose(); S.ring.material.dispose();
		S.session.dispose();
		if (S.hidden) S.hidden.visible = true;
		vp.tool = null;
		vp.canvas.style.cursor = '';
		document.body.classList.remove('sculpting');
		const p = $('#sculpt-panel'); if (p) p.remove();
		this.onHint('');
		const node = this.model.get(S.node.id);
		if (result && node) {
			// the sculpted shape becomes a mesh part with the same place, name and color; the original is kept
			const packed = packIndexed(result.positions, result.index), h = 'S' + hashString(packed);
			this.model.blobs[h] = packed;
			const f = this.model.find(node.id);
			const source = node.sculptSource || JSON.parse(JSON.stringify(node));
			const next = { id: node.id, seq: node.seq, type: 'mesh', name: node.name, params: { blob: h }, pos: node.pos.slice(), rot: node.rot.slice(), scale: node.scale.slice(), color: node.color, visible: node.visible, locked: false, hole: false, sculptSource: source };
			f.list[f.list.indexOf(node)] = next;
			this.sel = [next.id];
			this.commit();
			toast(`Sculpted “${next.name}” — ${(result.index.length / 3).toLocaleString()} triangles`, 'ok', 3000);
		} else {
			this.setSelection(node ? [node.id] : []);
			vp.invalidate();
		}
	},

	/** Put a sculpted part back to what it was before sculpting (undoable). */
	unsculpt(node) {
		if (!node || !node.sculptSource) return;
		const f = this.model.find(node.id);
		const back = JSON.parse(JSON.stringify(node.sculptSource));
		Object.assign(back, { id: node.id, pos: node.pos.slice(), rot: node.rot.slice(), scale: node.scale.slice() });
		f.list[f.list.indexOf(node)] = back;
		this.sel = [back.id];
		this.commit();
		toast(`“${back.name}” is back to the original part — Undo (Ctrl+Z) to return to the sculpted one`, 'ok', 4000);
	},

	/** Properties: start sculpting, or bring back the original. */
	sculptProps(host, n) {
		if (!this.model.isTopLevel(n.id) || n.hole) return;
		const sec = this.section(host, 'Sculpt');
		sec.appendChild(el('div', { class: 'btn-row' },
			el('button', { class: 'btn', title: 'Shape the surface with brushes, like clay (Blender-style Sculpt mode)', onclick: () => this.startSculpt(n) }, n.sculptSource ? 'Keep sculpting' : 'Sculpt…'),
			n.sculptSource ? el('button', { class: 'btn', title: 'Replace the sculpted mesh with the part as it was before sculpting', onclick: () => this.unsculpt(n) }, 'Back to the original part') : null));
	},

	// ------------------------------------------------------------ the panel

	renderSculptPanel() {
		const S = this.sculpt;
		if (!S) return;
		let p = $('#sculpt-panel');
		if (!p) { p = el('div', { id: 'sculpt-panel', class: 'side-panel sculpt' }); $('#viewport').appendChild(p); }
		p.innerHTML = '';
		const ses = S.session;
		const brushBtns = Object.entries(BRUSHES).map(([k, b]) => el('button', { class: 'btn sm sc-brush' + (S.brush === k ? ' on' : ''), title: `${b.tip} (${b.key})`, onclick: () => { S.brush = k; this.renderSculptPanel(); } }, el('span', { class: 'sc-key' }, b.key), b.label));
		const range = (min, max, step, val, on) => { const r = el('input', { type: 'range', min, max, step, value: val }); r.addEventListener('input', () => on(+r.value)); return r; };
		const rv = el('b', {}, `${Math.round(S.radiusPx)} px`), sv = el('b', {}, `${Math.round(S.strength * 100)}%`);
		const sym = ['X', 'Y', 'Z'].map((a, i) => el('button', { class: 'btn sm' + (S.symmetry[i] ? ' on' : ''), title: `Mirror strokes across ${a} (${a} key)`, onclick: () => { S.symmetry[i] = !S.symmetry[i]; this.renderSculptPanel(); } }, a));
		const fall = el('select', {}, ...Object.entries(FALLOFFS).map(([k, l]) => el('option', { value: k }, l)));
		fall.value = S.falloff;
		fall.addEventListener('change', () => { S.falloff = fall.value; });
		p.append(
			el('div', { class: 'fp-head' }, el('b', {}, 'Sculpt: ' + S.node.name)),
			el('div', { class: 'sc-brushes' }, ...brushBtns),
			el('label', { class: 'sc-row' }, el('span', {}, 'Radius'), range(5, 400, 1, S.radiusPx, (v) => { S.radiusPx = v; rv.textContent = `${v} px`; }), rv),
			el('label', { class: 'sc-row' }, el('span', {}, 'Strength'), range(0.02, 1, 0.01, S.strength, (v) => { S.strength = v; sv.textContent = `${Math.round(v * 100)}%`; }), sv),
			el('label', { class: 'sc-row' }, el('span', {}, 'Falloff'), fall),
			el('div', { class: 'sc-row' }, el('span', {}, 'Symmetry'), el('div', { class: 'btn-row' }, ...sym), el('span', { class: 'muted small' }, S.symmetry.some(Boolean) ? 'mirrored (purple rings)' : 'off')),
			el('div', { class: 'sc-row' }, el('span', {}, 'Detail'), el('span', { class: 'muted small' }, `${ses.nt.toLocaleString()} triangles`),
				el('button', { class: 'btn sm', title: 'More triangles for finer detail (about 2.5×)', disabled: ses.nt * 2.5 > MAX_TRIS, onclick: () => this.refineSculpt() }, 'Refine')),
			el('div', { class: 'btn-row' },
				el('button', { class: 'btn sm', disabled: !ses.undoStack.length && !S.history.length, title: 'Undo stroke (Ctrl+Z)', onclick: () => this.sculptUndo() }, 'Undo'),
				el('button', { class: 'btn sm', disabled: !ses.redoStack.length, title: 'Redo (Ctrl+Shift+Z)', onclick: () => this.sculptRedo() }, 'Redo')),
			el('div', { class: 'muted small' }, 'Left-drag sculpts, right-drag orbits. Ctrl inverts, Shift smooths, F / Shift+F radius / strength, [ ] size, X Y Z symmetry.'),
			el('div', { class: 'btn-row' },
				el('button', { class: 'btn', onclick: () => this.exitSculpt(false) }, 'Cancel'),
				el('button', { class: 'btn primary', title: 'Keep the sculpted shape (Enter)', onclick: () => this.exitSculpt(true) }, 'Done')));
	},

	/** Split every triangle for finer detail (the previous mesh is kept for undo). */
	refineSculpt() {
		const S = this.sculpt;
		if (!S) return;
		const ses = S.session, { positions, index } = ses.export();
		let m;
		try {
			m = toManifold({ attributes: { position: { array: positions } }, index: { array: index } });
			const area = m.surfaceArea(), L = Math.sqrt(area / (0.433 * ses.nt)) / 1.6;
			const fine = m.refineToLength(L), r = rawOf(fine);
			fine.delete();
			S.history.push({ positions, index, undoStack: ses.undoStack, redoStack: ses.redoStack });
			this.swapSession(new Float32Array(r.pos), new Uint32Array(r.idx));
			toast(`Refined: ${S.session.nt.toLocaleString()} triangles`, 'ok', 2000);
		} catch (e) {
			toast('Could not refine: ' + e.message, 'error', 4000);
		} finally { if (m) m.delete(); }
	},

	swapSession(positions, index, stacks) {
		const S = this.sculpt;
		const keepSym = S.session.symCenter;
		S.session.dispose();
		S.session = new SculptSession(positions, index);
		S.session.symCenter = keepSym;
		if (stacks) { S.session.undoStack = stacks.undoStack; S.session.redoStack = stacks.redoStack; }
		S.mesh.geometry = S.session.geometry;
		S.modified = true;
		this.renderSculptPanel();
		this.vp.invalidate();
	},

	sculptUndo() {
		const S = this.sculpt;
		if (!S) return;
		if (S.session.undo()) { this.vp.invalidate(); this.renderSculptPanel(); return; }
		const prev = S.history.pop();
		if (prev) this.swapSession(prev.positions, prev.index, prev);
	},

	sculptRedo() {
		const S = this.sculpt;
		if (S && S.session.redo()) { this.vp.invalidate(); this.renderSculptPanel(); }
	},

	// ------------------------------------------------------------ input

	/** Ray in the part's frame from a pointer event. */
	sculptRay(e) {
		const vp = this.vp, r = vp.canvas.getBoundingClientRect();
		const rc = new THREE.Raycaster();
		rc.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), vp.camera);
		return rc.ray.clone().applyMatrix4(this.sculpt.Minv);
	},

	/** Brush radius in the part's frame (mm) at a surface point, from the radius in screen pixels. */
	sculptRadius(localPoint) {
		const S = this.sculpt, vp = this.vp, cam = vp.camera;
		const world = new THREE.Vector3(...localPoint).applyMatrix4(S.M);
		const h = vp.canvas.getBoundingClientRect().height || 1;
		let perPx;
		if (cam.isOrthographicCamera) perPx = (cam.top - cam.bottom) / cam.zoom / h;
		else perPx = (2 * world.distanceTo(cam.position) * Math.tan((cam.fov * Math.PI) / 360)) / h;
		return (S.radiusPx * perPx) / S.scale;
	},

	sculptHover(e) {
		const S = this.sculpt;
		if (!S) return;
		S.lastPointer = { x: e.clientX, y: e.clientY };
		if (S.stroking || S.adjust) return;
		const hit = S.session.raycast(this.sculptRay(e));
		this.placeRing(hit);
	},

	placeRing(hit) {
		const S = this.sculpt;
		for (const m of S.mirrorRings) m.visible = false;
		if (!hit) { S.ring.visible = false; this.vp.invalidate(); return; }
		const r = this.sculptRadius(hit.point);
		const put = (ring, point, normal) => {
			const p = new THREE.Vector3(...point), n = new THREE.Vector3(...normal);
			const local = new THREE.Matrix4().compose(p.clone().addScaledVector(n, r * 0.02), new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n), new THREE.Vector3(r, r, r));
			ring.matrixAutoUpdate = false;
			ring.matrix.copy(S.M).multiply(local);
			ring.matrixWorldNeedsUpdate = true;
			ring.visible = true;
		};
		put(S.ring, hit.point, hit.normal);
		S.ring.material.color.set(this.strokeBrush(e_mods) === 'smooth' ? 0x8ec9ff : 0xffffff);
		// with symmetry on, a fainter ring shows every mirrored spot the stroke will also change
		const copies = S.session.mirrors(hit.point, hit.normal, S.symmetry).slice(1);
		copies.forEach(([point, normal], i) => {
			if (!S.mirrorRings[i]) {
				const m = new THREE.LineLoop(S.ring.geometry, new THREE.LineBasicMaterial({ color: 0xb38bff, depthTest: false, transparent: true, opacity: 0.7 }));
				m.renderOrder = 998; m.raycast = () => {};
				this.vp.scene.add(m);
				S.mirrorRings[i] = m;
			}
			put(S.mirrorRings[i], point, normal);
		});
		this.vp.invalidate();
	},

	strokeBrush(mods) {
		return mods && mods.shift ? 'smooth' : this.sculpt.brush;
	},

	sculptDown(e) {
		const S = this.sculpt;
		if (!S) return;
		if (S.adjust) { e.preventDefault(); e.stopImmediatePropagation(); this.endSizeAdjust(e.button === 0); return; }
		if (e.button !== 0) return; // right / middle: orbit and pan as usual
		e.preventDefault();
		e.stopImmediatePropagation();
		const ses = S.session;
		const hit = ses.raycast(this.sculptRay(e));
		if (!hit) return;
		const brush = this.strokeBrush({ shift: e.shiftKey });
		const o = { radius: this.sculptRadius(hit.point), strength: S.strength, falloff: S.falloff, invert: e.ctrlKey || e.metaKey, symmetry: S.symmetry };
		ses.beginStroke(brush);
		S.stroking = true;
		const vp = this.vp;
		vp.controls.enabled = false;
		// pointer events only record where the pointer is; the sculpting happens once per frame, so a fast mouse
		// doesn't queue up more work than the screen can show
		let latest = { x: e.clientX, y: e.clientY }, last = { ...latest }, lastHit = hit, ended = false;
		const moved = new Set();
		const flush = () => {
			if (moved.size) { ses.changed([...moved]); moved.clear(); vp.invalidate(); }
			if (lastHit) this.placeRing(lastHit);
		};
		let step;
		if (brush === 'grab') {
			ses.grabStart(hit.point, o);
			const startW = new THREE.Vector3(...hit.point).applyMatrix4(S.M);
			const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(vp.camera.getWorldDirection(new THREE.Vector3()), startW);
			const b = startW.clone().applyMatrix4(S.Minv);
			step = () => {
				const r = vp.canvas.getBoundingClientRect(), rc = new THREE.Raycaster();
				rc.setFromCamera(new THREE.Vector2(((latest.x - r.left) / r.width) * 2 - 1, -((latest.y - r.top) / r.height) * 2 + 1), vp.camera);
				const p = rc.ray.intersectPlane(plane, new THREE.Vector3());
				if (!p) return;
				const a = p.applyMatrix4(S.Minv);
				for (const v of ses.grabMove([a.x - b.x, a.y - b.y, a.z - b.z])) moved.add(v);
				lastHit = null;
			};
		} else {
			for (const v of ses.dab(brush, hit.point, o)) moved.add(v);
			step = () => {
				// dabs evenly spaced along the pointer's path since the last frame, each on the surface under it
				const spacing = Math.max(2, S.radiusPx * 0.25);
				let dx = latest.x - last.x, dy = latest.y - last.y, dist = Math.hypot(dx, dy);
				while (dist >= spacing) {
					last = { x: last.x + (dx / dist) * spacing, y: last.y + (dy / dist) * spacing };
					const h = ses.raycast(this.sculptRay({ clientX: last.x, clientY: last.y }));
					if (h) { for (const v of ses.dab(brush, h.point, { ...o, radius: this.sculptRadius(h.point) })) moved.add(v); lastHit = h; }
					dx = latest.x - last.x; dy = latest.y - last.y; dist = Math.hypot(dx, dy);
				}
			};
		}
		flush();
		const frame = () => {
			if (ended) return;
			step();
			flush();
			requestAnimationFrame(frame);
		};
		requestAnimationFrame(frame);
		const mv = (ev) => { latest = { x: ev.clientX, y: ev.clientY }; };
		const up = () => {
			window.removeEventListener('pointermove', mv);
			window.removeEventListener('pointerup', up);
			step();
			flush();
			ended = true;
			vp.controls.enabled = true;
			S.stroking = false;
			if (ses.endStroke()) { S.modified = true; ses.changed([]); }
			this.renderSculptPanel();
			vp.invalidate();
		};
		window.addEventListener('pointermove', mv);
		window.addEventListener('pointerup', up);
	},

	sculptKey(e) {
		const S = this.sculpt;
		if (!S || (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable]'))) return;
		const k = e.key.toLowerCase(), ctrl = e.ctrlKey || e.metaKey;
		const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };
		if (S.adjust) {
			if (k === 'escape') { stop(); this.endSizeAdjust(false); } else if (k === 'enter' || k === 'f') { stop(); this.endSizeAdjust(true); }
			return;
		}
		if (ctrl && k === 'z') { stop(); if (e.shiftKey) this.sculptRedo(); else this.sculptUndo(); return; }
		if (ctrl && k === 'y') { stop(); this.sculptRedo(); return; }
		if (ctrl) return;
		const brush = Object.keys(BRUSHES).find((b) => BRUSHES[b].key === e.key);
		if (brush) { stop(); S.brush = brush; this.renderSculptPanel(); return; }
		if (k === 'f') { stop(); this.startSizeAdjust(e.shiftKey ? 'strength' : 'radius'); return; }
		if (k === '[' || k === ']') { stop(); S.radiusPx = Math.max(5, Math.min(400, Math.round(S.radiusPx * (k === ']' ? 1.15 : 1 / 1.15)))); this.renderSculptPanel(); return; }
		if (k === 'x' || k === 'y' || k === 'z') { stop(); const i = 'xyz'.indexOf(k); S.symmetry[i] = !S.symmetry[i]; this.renderSculptPanel(); toast(`Symmetry ${k.toUpperCase()} ${S.symmetry[i] ? 'on' : 'off'}`, 'info', 1200); return; }
		if (k === 'enter') { stop(); this.exitSculpt(true); return; }
		// everything else that would change the design waits until sculpting is done
		if (['delete', 'backspace', 'g', 'h', 'd', 'c', 'm', 'l', 'u', 'p', 'j'].includes(k)) stop();
	},

	/** Blender's F / Shift+F: the radius (or strength) follows the pointer's distance from where the key was pressed. */
	startSizeAdjust(what) {
		const S = this.sculpt, vp = this.vp;
		const at = S.lastPointer || (() => { const r = vp.canvas.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })();
		const start = { radiusPx: S.radiusPx, strength: S.strength };
		const circle = el('div', { class: 'sc-adjust' });
		const label = el('div', { class: 'sc-adjust-label' });
		document.body.append(circle, label);
		const show = () => {
			const r = what === 'radius' ? S.radiusPx : 40 + S.strength * 200;
			Object.assign(circle.style, { left: at.x - r + 'px', top: at.y - r + 'px', width: 2 * r + 'px', height: 2 * r + 'px' });
			Object.assign(label.style, { left: at.x + 'px', top: at.y + 'px' });
			label.textContent = what === 'radius' ? `Radius ${Math.round(S.radiusPx)} px` : `Strength ${Math.round(S.strength * 100)}%`;
		};
		const mv = (ev) => {
			const d = Math.hypot(ev.clientX - at.x, ev.clientY - at.y);
			if (what === 'radius') S.radiusPx = Math.max(5, Math.min(400, Math.round(d)));
			else S.strength = Math.max(0.02, Math.min(1, (d - 40) / 200));
			show();
		};
		window.addEventListener('pointermove', mv);
		S.ring.visible = false;
		S.adjust = { what, start, circle, label, mv };
		show();
		vp.invalidate();
	},

	endSizeAdjust(keep, S = this.sculpt) {
		const a = S && S.adjust;
		if (!a) return;
		window.removeEventListener('pointermove', a.mv);
		a.circle.remove(); a.label.remove();
		if (!keep) { S.radiusPx = a.start.radiusPx; S.strength = a.start.strength; }
		S.adjust = null;
		if (this.sculpt === S) this.renderSculptPanel();
	},
};

// the brush ring: a unit circle in the XY plane
function circleGeometry() {
	const pts = [];
	for (let i = 0; i < 64; i++) { const a = (i / 64) * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a), Math.sin(a), 0)); }
	return new THREE.BufferGeometry().setFromPoints(pts);
}

let e_mods = null; // modifier keys of the last pointer event (for the ring color)
if (typeof window !== 'undefined') {
	const track = (e) => { e_mods = { shift: e.shiftKey }; };
	window.addEventListener('pointermove', track, true);
	window.addEventListener('keydown', track, true);
	window.addEventListener('keyup', track, true);
}
