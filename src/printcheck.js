// "Check for printing": thin walls, narrow gaps, floating pieces, overlapping parts, overhangs, bed fit.
// analyzePrint() is pure (world-space geometries in, findings out); PrintCheckMixin adds the panel + highlights.
import * as THREE from 'three';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';
import { overlapOf, shellsOf } from './engine.js';
import { fmt, el, toast, evalExpr } from './util.js';

const DEFAULTS = { minWall: 0.8, minGap: 0.3, overhangAngle: 45 };

/** Wall thickness and gap width per triangle by casting rays inward / outward from each centroid. */
export function thicknessScan(geom, { minWall, minGap, maxTris = 40000 }) {
	const g = geom.index ? geom.toNonIndexed() : geom;
	const pos = g.attributes.position.array, triCount = pos.length / 9;
	const bvh = new MeshBVH(g);
	const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
	mesh.raycast = acceleratedRaycast;
	g.boundsTree = bvh;
	const rc = new THREE.Raycaster();
	rc.firstHitOnly = true;
	const stride = Math.max(1, Math.ceil(triCount / maxTris));
	const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), ctr = new THREE.Vector3();
	const thin = [], gaps = [];
	let thinArea = 0, gapArea = 0, minT = Infinity, minG = Infinity;
	for (let t = 0; t < triCount; t += stride) {
		const o = t * 9;
		a.set(pos[o], pos[o + 1], pos[o + 2]); b.set(pos[o + 3], pos[o + 4], pos[o + 5]); c.set(pos[o + 6], pos[o + 7], pos[o + 8]);
		n.subVectors(c, b).cross(new THREE.Vector3().subVectors(a, b));
		const area = n.length() / 2;
		if (area < 1e-9) continue;
		n.normalize();
		ctr.copy(a).add(b).add(c).multiplyScalar(1 / 3);
		const eps = 1e-4;
		// inward: distance to the opposite surface = local wall thickness
		rc.set(ctr.clone().addScaledVector(n, -eps), n.clone().negate());
		rc.far = minWall;
		const hin = rc.intersectObject(mesh, false)[0];
		if (hin && hin.distance > 1e-3) { thin.push(t); thinArea += area * stride; minT = Math.min(minT, hin.distance + eps); }
		// outward: distance to a facing surface = gap width
		rc.set(ctr.clone().addScaledVector(n, eps), n.clone());
		rc.far = minGap;
		const hout = rc.intersectObject(mesh, false)[0];
		if (hout && hout.distance > 1e-3) { gaps.push(t); gapArea += area * stride; minG = Math.min(minG, hout.distance + eps); }
	}
	g.boundsTree = undefined;
	return { thin, gaps, thinArea, gapArea, minT, minG, geom: g };
}

/** Downward-facing area steeper than the overhang angle, ignoring faces on the bed. */
export function overhangScan(geom, angleDeg, bedZ = 0) {
	const g = geom.index ? geom.toNonIndexed() : geom;
	const pos = g.attributes.position.array, s = Math.sin((angleDeg * Math.PI) / 180), tris = [];
	let area = 0;
	const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
	for (let o = 0; o < pos.length; o += 9) {
		a.set(pos[o], pos[o + 1], pos[o + 2]); b.set(pos[o + 3], pos[o + 4], pos[o + 5]); c.set(pos[o + 6], pos[o + 7], pos[o + 8]);
		n.subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
		const ar = n.length() / 2;
		if (ar < 1e-9) continue;
		n.normalize();
		if (n.z < -s && Math.max(a.z, b.z, c.z) > bedZ + 0.15) { tris.push(o / 9); area += ar; }
	}
	return { tris, area, geom: g };
}

/**
 * Spots a slicer will read as a broken mesh. Slicers rebuild the mesh by merging points closer than about 0.03 mm
 * (CuraEngine: 0.03 mm), so hair-thin slivers between nearly-matching cuts, and solids touching only along an edge,
 * turn into holes or edges shared by four faces. Simulates that merge and returns boxes around the damage.
 */
export const SLICER_MERGE = 0.03;
export function slicerTrouble(geom, d = SLICER_MERGE) {
	const P = (geom.index ? geom.toNonIndexed() : geom).attributes.position.array;
	const grid = new Map(), reps = [];
	const id = (i) => {
		const x = P[i], y = P[i + 1], z = P[i + 2], cx = Math.floor(x / d), cy = Math.floor(y / d), cz = Math.floor(z / d);
		for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
			const l = grid.get((cx + a) + ',' + (cy + b) + ',' + (cz + c));
			if (l) for (const r of l) { const o = reps[r]; if (Math.hypot(P[o] - x, P[o + 1] - y, P[o + 2] - z) <= d) return r; }
		}
		const r = reps.length;
		reps.push(i);
		const k = cx + ',' + cy + ',' + cz;
		if (!grid.has(k)) grid.set(k, []);
		grid.get(k).push(r);
		return r;
	};
	const edges = new Map();
	for (let i = 0; i < P.length; i += 9) {
		const a = id(i), b = id(i + 3), c = id(i + 6);
		if (a === b || b === c || a === c) continue;
		for (const [x, y] of [[a, b], [b, c], [c, a]]) { const k = x < y ? x + '_' + y : y + '_' + x; edges.set(k, (edges.get(k) || 0) + 1); }
	}
	const boxes = [];
	for (const [k, n] of edges) {
		if (n === 2) continue;
		const [a, b] = k.split('_').map((v) => reps[+v]);
		const box = new THREE.Box3().setFromPoints([new THREE.Vector3(P[a], P[a + 1], P[a + 2]), new THREE.Vector3(P[b], P[b + 1], P[b + 2])]).expandByScalar(0.3);
		const near = boxes.find((x) => x.intersectsBox(box));
		if (near) near.union(box); else boxes.push(box);
	}
	return boxes;
}

/**
 * parts: [{ id, name, geom (world) }]; merged: world geometry of everything combined.
 * Returns { items: [{ kind, level: 'ok' | 'warn' | 'error' | 'info', title, detail, highlight }] }.
 */
export function analyzePrint(parts, merged, opts = {}) {
	const o = { ...DEFAULTS, ...opts };
	const items = [];
	merged.computeBoundingBox();
	const bb = merged.boundingBox;
	// bed
	if (o.bed) {
		const b = o.bed;
		const fits = bb.min.x >= -b.w / 2 - 0.01 && bb.max.x <= b.w / 2 + 0.01 && bb.min.y >= -b.d / 2 - 0.01 && bb.max.y <= b.d / 2 + 0.01 && bb.max.z <= b.h + 0.01;
		items.push(fits ? { kind: 'bed', level: 'ok', title: 'Fits the build volume' } : { kind: 'bed', level: 'error', title: 'Too big for the printer', detail: `${fmt(bb.max.x - bb.min.x, 1)} × ${fmt(bb.max.y - bb.min.y, 1)} × ${fmt(bb.max.z - bb.min.z, 1)} mm vs ${b.w} × ${b.d} × ${b.h} mm, or off the bed` });
	}
	if (bb.min.z < -0.01) items.push({ kind: 'below', level: 'error', title: 'Part of the design is below the bed', detail: `${fmt(-bb.min.z, 2)} mm under — press D (Drop to bed) or the slicer will cut it off` });
	else if (bb.min.z > 0.01) items.push({ kind: 'float-all', level: 'warn', title: 'Nothing touches the bed', detail: `Lowest point is ${fmt(bb.min.z, 2)} mm up — press D to drop it` });
	// floating shells
	const shells = o.shells || [];
	const floating = [];
	for (const s of shells) {
		s.computeBoundingBox();
		if (s.boundingBox.min.z > bb.min.z + 0.05) floating.push(s);
	}
	items.push(floating.length
		? { kind: 'floating', level: 'error', title: `${floating.length} piece${floating.length > 1 ? 's' : ''} floating in the air`, detail: 'Separate pieces that start above the bed print onto nothing — connect them, drop them, or plan supports', highlight: { boxes: floating.map((s) => s.boundingBox.clone()) } }
		: { kind: 'floating', level: 'ok', title: shells.length > 1 ? `${shells.length} separate pieces, all on the bed` : 'No floating pieces' });
	const trouble = slicerTrouble(merged);
	items.push(trouble.length
		? { kind: 'slicer', level: 'warn', title: `${trouble.length} spot${trouble.length > 1 ? 's' : ''} a slicer will read as broken`, detail: 'Faces closer than 0.03 mm (cuts that nearly but not exactly line up) or pieces touching only along an edge. Slicers merge points that close and may show gaps or stray lines here — line the features up exactly, or move them apart', highlight: { boxes: trouble } }
		: { kind: 'slicer', level: 'ok', title: 'Nothing a slicer will read as broken' });
	// walls & gaps
	const scan = thicknessScan(merged, o);
	items.push(scan.thin.length
		? { kind: 'thin', level: 'warn', title: `Thin walls (thinnest ${fmt(scan.minT, 2)} mm)`, detail: `${fmt(scan.thinArea, 1)} mm² of surface is thinner than ${o.minWall} mm — it may print weak, with gaps, or not at all`, highlight: { geom: scan.geom, tris: scan.thin, color: 0xff3b5c } }
		: { kind: 'thin', level: 'ok', title: `No walls thinner than ${o.minWall} mm` });
	items.push(scan.gaps.length
		? { kind: 'gaps', level: 'warn', title: `Narrow gaps (narrowest ${fmt(scan.minG, 2)} mm)`, detail: `${fmt(scan.gapArea, 1)} mm² of surface faces another surface closer than ${o.minGap} mm — these may fuse shut`, highlight: { geom: scan.geom, tris: scan.gaps, color: 0xb15cff } }
		: { kind: 'gaps', level: 'ok', title: `No gaps narrower than ${o.minGap} mm` });
	// overhangs
	const oh = overhangScan(merged, o.overhangAngle, bb.min.z);
	items.push(oh.area > 1
		? { kind: 'overhang', level: 'info', title: `Overhangs: ${fmt(oh.area / 100, 2)} cm²`, detail: `Faces steeper than ${o.overhangAngle}° from vertical may need supports (or rotate the part)`, highlight: { geom: oh.geom, tris: oh.tris, color: 0xff9a3c } }
		: { kind: 'overhang', level: 'ok', title: `No overhangs beyond ${o.overhangAngle}°` });
	// overlapping parts that are not joined
	const overl = [];
	if (parts.length <= 40) {
		const boxes = parts.map((p) => { p.geom.computeBoundingBox(); return p.geom.boundingBox; });
		for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
			if (!boxes[i].intersectsBox(boxes[j])) continue;
			const r = overlapOf(parts[i].geom, parts[j].geom);
			if (r && r.volume > 1e-3) overl.push({ a: parts[i].name, b: parts[j].name, volume: r.volume, geom: r.geometry });
		}
	}
	items.push(overl.length
		? { kind: 'overlap', level: 'info', title: `${overl.length} overlapping pair${overl.length > 1 ? 's' : ''} of parts`, detail: overl.slice(0, 4).map((x) => `${x.a} ∩ ${x.b}: ${fmt(x.volume, 1)} mm³`).join(' · ') + ' — fine when exported with Merge; group them to join them for good', highlight: { solids: overl.map((x) => x.geom).filter(Boolean), color: 0xff3b5c } }
		: { kind: 'overlap', level: 'ok', title: parts.length > 1 ? 'Parts do not overlap' : 'Single part' });
	return { items, box: bb };
}

// ================================================================= panel + highlights

export const PrintCheckMixin = {
	checkPrint() {
		const nodes = this.model.nodes.filter((n) => n.visible && !n.hole);
		if (!nodes.length) { toast('Nothing to check — add some solid shapes first', 'warn'); return; }
		const s = this.model.settings;
		const o = { minWall: s.minWall ?? DEFAULTS.minWall, minGap: s.minGap ?? DEFAULTS.minGap, overhangAngle: s.overhangAngle || 45, bed: s.bed };
		const t0 = performance.now();
		const all = this.model.nodes.filter((n) => n.visible);
		const merged = this.engine.printable(all, true);
		if (!merged) { toast('Could not build the design', 'error'); return; }
		const parts = nodes.map((n) => ({ id: n.id, name: n.name || n.type, geom: this.engine.printable([n, ...all.filter((h) => h.hole)], true) })).filter((p) => p.geom);
		o.shells = shellsOf(merged) || [];
		const res = analyzePrint(parts, merged, o);
		res.ms = performance.now() - t0;
		this.checkResult = res;
		this.showCheckPanel(res, o);
		return res;
	},

	showCheckPanel(res, o) {
		let panel = document.querySelector('#check-panel');
		if (!panel) { panel = el('div', { id: 'check-panel', class: 'side-panel' }); document.querySelector('#viewport').appendChild(panel); }
		panel.innerHTML = '';
		const icon = { ok: '✓', warn: '⚠', error: '✕', info: 'ℹ' };
		const worst = res.items.some((i) => i.level === 'error') ? 'error' : res.items.some((i) => i.level === 'warn') ? 'warn' : 'ok';
		const head = el('div', { class: 'fp-head' }, el('b', {}, 'Print check'), el('span', { class: 'fp-sum ' + worst }, worst === 'ok' ? 'Ready to print' : worst === 'warn' ? 'Check the warnings' : 'Problems found'),
			el('button', { class: 'icon-btn', title: 'Close', onclick: () => this.closeCheckPanel() }, '✕'));
		const list = el('div', { class: 'fp-list' });
		for (const it of res.items) {
			const row = el('div', { class: 'fp-item ' + it.level }, el('span', { class: 'fp-ic' }, icon[it.level]), el('div', {}, el('div', { class: 'fp-title' }, it.title), it.detail ? el('div', { class: 'fp-detail' }, it.detail) : null));
			if (it.highlight) {
				const cb = el('input', { type: 'checkbox', checked: true, title: 'Highlight in the view' });
				cb.addEventListener('change', () => { it.shown = cb.checked; this.vp.showCheckHighlights(res.items); });
				it.shown = true;
				row.appendChild(el('label', { class: 'fp-show' }, cb, 'show'));
			}
			list.appendChild(row);
		}
		const minWall = el('input', { type: 'text', value: o.minWall, class: 'num' }), minGap = el('input', { type: 'text', value: o.minGap, class: 'num' });
		const rerun = () => {
			const s = this.model.settings;
			const w = evalExpr(minWall.value, this.varValues || {}), g = evalExpr(minGap.value, this.varValues || {});
			if (w > 0) s.minWall = w;
			if (g > 0) s.minGap = g;
			this.checkPrint();
		};
		const foot = el('div', { class: 'fp-foot' }, el('label', {}, 'Min wall ', minWall, ' mm'), el('label', {}, 'Min gap ', minGap, ' mm'), el('button', { class: 'btn sm primary', onclick: rerun }, 'Re-check'));
		for (const i of [minWall, minGap]) i.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') rerun(); });
		panel.append(head, list, foot, el('div', { class: 'muted small' }, `Checked in ${Math.round(res.ms)} ms`));
		panel.style.display = '';
		this.vp.showCheckHighlights(res.items);
	},

	closeCheckPanel() {
		const p = document.querySelector('#check-panel');
		if (p) p.style.display = 'none';
		this.vp.showCheckHighlights(null);
		this.checkResult = null;
	},
};
