// Arrange → Auto-orient for printing (which side down needs the least support) and Arrange on the bed (pack every
// part onto the plate with even gaps).
import * as THREE from 'three';
import { el, toast, round, fmt, evalExpr } from './util.js';

const DOWN = new THREE.Vector3(0, 0, -1);

/** World triangles of a top-level part: positions (Float64, 9 per triangle), unit normals and areas. */
function worldTris(geom, M) {
	const pos = geom.attributes.position, idx = geom.index;
	const n = (idx ? idx.count : pos.count) / 3;
	const P = new Float64Array(n * 9), N = new Float64Array(n * 3), A = new Float64Array(n);
	const v = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
	for (let i = 0; i < n; i++) {
		for (let k = 0; k < 3; k++) {
			v.fromBufferAttribute(pos, idx ? idx.getX(3 * i + k) : 3 * i + k).applyMatrix4(M);
			P[9 * i + 3 * k] = v.x; P[9 * i + 3 * k + 1] = v.y; P[9 * i + 3 * k + 2] = v.z;
		}
		a.fromArray(P, 9 * i); b.fromArray(P, 9 * i + 3); c.fromArray(P, 9 * i + 6);
		const cr = b.sub(a).cross(c.sub(a));
		const l = cr.length();
		A[i] = l / 2;
		if (l > 1e-12) { cr.divideScalar(l); N[3 * i] = cr.x; N[3 * i + 1] = cr.y; N[3 * i + 2] = cr.z; }
	}
	if (M.determinant() < 0) for (let i = 0; i < N.length; i++) N[i] = -N[i];
	return { n, P, N, A };
}

/**
 * How a part prints with `down` (unit, world) pointing at the bed: support area (mm², faces overhanging more than
 * `angle` from vertical, projected), bed contact area (mm²) and height (mm).
 */
export function orientScore(t, down, angle = 45) {
	const ux = -down.x, uy = -down.y, uz = -down.z;
	let lo = Infinity, hi = -Infinity;
	for (let i = 0; i < t.P.length; i += 3) { const h = t.P[i] * ux + t.P[i + 1] * uy + t.P[i + 2] * uz; if (h < lo) lo = h; if (h > hi) hi = h; }
	const cosA = Math.cos((angle * Math.PI) / 180);
	let support = 0, contact = 0;
	for (let i = 0; i < t.n; i++) {
		const d = -(t.N[3 * i] * ux + t.N[3 * i + 1] * uy + t.N[3 * i + 2] * uz); // 1 = facing straight down
		if (d <= cosA) continue;
		let top = -Infinity;
		for (let k = 0; k < 3; k++) { const j = 9 * i + 3 * k; top = Math.max(top, t.P[j] * ux + t.P[j + 1] * uy + t.P[j + 2] * uz - lo); }
		if (top < 0.05 && d > 0.999) contact += t.A[i] * d;
		else support += t.A[i] * d;
	}
	return { support, contact, height: hi - lo };
}

/** Candidate "down" directions: the six axes, the current one, and the normals of the biggest flat areas. */
function candidates(t) {
	const byDir = new Map();
	for (let i = 0; i < t.n; i++) {
		if (!t.A[i]) continue;
		const k = Math.round(t.N[3 * i] * 200) + ',' + Math.round(t.N[3 * i + 1] * 200) + ',' + Math.round(t.N[3 * i + 2] * 200);
		const e = byDir.get(k);
		if (e) { e.a += t.A[i]; e.x += t.N[3 * i] * t.A[i]; e.y += t.N[3 * i + 1] * t.A[i]; e.z += t.N[3 * i + 2] * t.A[i]; }
		else byDir.set(k, { a: t.A[i], x: t.N[3 * i] * t.A[i], y: t.N[3 * i + 1] * t.A[i], z: t.N[3 * i + 2] * t.A[i] });
	}
	const dirs = [DOWN.clone(), new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0)];
	[...byDir.values()].sort((p, q) => q.a - p.a).slice(0, 40).forEach((e) => dirs.push(new THREE.Vector3(e.x, e.y, e.z).normalize()));
	const out = [];
	for (const d of dirs) if (!out.some((o) => o.dot(d) > 0.9995)) out.push(d);
	return out;
}

/** Rank the ways a part can sit on the bed (best first). */
export function orientOptions(geom, M, angle = 45) {
	const t = worldTris(geom, M);
	let total = 0;
	for (let i = 0; i < t.n; i++) total += t.A[i];
	const scale = Math.sqrt(total) || 1;
	const opts = candidates(t).map((d) => {
		const s = orientScore(t, d, angle);
		// less support first; then more on the bed and lower (a tall thin stand-up print is less reliable)
		return { down: d, ...s, score: s.support - 0.25 * Math.min(s.contact, 0.2 * total) + 0.02 * s.height * scale + (s.contact < 1 ? 0.05 * total : 0) };
	});
	opts.sort((p, q) => p.score - q.score);
	return opts;
}

export const PrintPrepMixin = {
	/** Turn a top-level part so `down` (world) faces the bed, keeping it where it is, then set it on the bed. */
	orientPart(n, down) {
		const M = this.worldMatrix(n), g = this.engine.geometry(n);
		if (!g || !g.attributes.position || !g.attributes.position.count) return;
		g.computeBoundingBox();
		const c = g.boundingBox.getCenter(new THREE.Vector3()).applyMatrix4(M);
		const q = new THREE.Quaternion().setFromUnitVectors(down.clone().normalize(), DOWN);
		const R = new THREE.Matrix4().makeTranslation(c.x, c.y, c.z).multiply(new THREE.Matrix4().makeRotationFromQuaternion(q)).multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z));
		const M2 = R.multiply(M);
		const box = g.boundingBox.clone().applyMatrix4(M2);
		this.setWorldMatrix(n, new THREE.Matrix4().makeTranslation(0, 0, -box.min.z).multiply(M2));
	},

	printableParts(nodes) {
		// parts with a shape to place (a group can come out empty, e.g. a symmetric one whose kept wedge has nothing in it)
		return nodes.filter((n) => { if (!this.model.isTopLevel(n.id) || n.hole || n.locked || !n.visible) return false; const g = this.engine.geometry(n); return !!(g && g.attributes.position && g.attributes.position.count); });
	},

	autoOrientDialog() {
		const nodes = this.printableParts(this.selectedNodes());
		if (!nodes.length) { toast('Select the part to orient first', 'warn'); return; }
		const angle = this.model.settings.overhangAngle || 45;
		const cm2 = (a) => `${fmt(a / 100, 1)} cm²`;
		if (nodes.length > 1) {
			let before = 0, after = 0;
			for (const n of nodes) {
				const o = orientOptions(this.engine.geometry(n), this.worldMatrix(n), angle);
				before += o.find((x) => x.down.dot(DOWN) > 0.9995).support;
				after += o[0].support;
				this.orientPart(n, o[0].down);
			}
			this.commit();
			toast(`Oriented ${nodes.length} parts · supports ${cm2(before)} → ${cm2(after)}`, 'ok', 5000);
			return;
		}
		const n = nodes[0];
		const opts = orientOptions(this.engine.geometry(n), this.worldMatrix(n), angle);
		const cur = opts.find((x) => x.down.dot(DOWN) > 0.9995);
		const shown = opts.slice(0, 6);
		if (!shown.includes(cur)) shown.push(cur);
		let pick = shown[0];
		const rows = shown.map((o, i) => {
			const r = el('label', { class: 'orient-opt' + (i === 0 ? ' on' : '') },
				el('input', { type: 'radio', name: 'orient', ...(i === 0 ? { checked: true } : {}) }),
				el('b', {}, i === 0 ? 'Best' : o === cur ? 'As it is now' : `Option ${i + 1}`),
				el('span', {}, `Supports ${cm2(o.support)}`),
				el('span', {}, `On the bed ${cm2(o.contact)}`),
				el('span', {}, `Height ${fmt(o.height, 1)} mm`));
			r.querySelector('input').addEventListener('change', () => { pick = o; rows.forEach((x) => x.classList.toggle('on', x === r)); });
			return r;
		});
		this.modal('Auto-orient for printing', el('div', { class: 'form' },
			el('p', { class: 'muted small' }, `Ways “${n.name}” can sit on the bed, least support first (faces overhanging more than ${angle}° need support). Contact is how much of the part is flat on the bed.`),
			el('div', { class: 'orient-list' }, ...rows)), [{ label: 'Cancel' }, {
			label: 'Apply', primary: true, action: () => {
				if (pick === cur) return;
				this.orientPart(n, pick.down);
				this.commit();
				toast(`Oriented “${n.name}” · supports ${cm2(cur.support)} → ${cm2(pick.support)} · on the bed ${cm2(cur.contact)} → ${cm2(pick.contact)}`, 'ok', 5000);
			},
		}]);
	},

	arrangeDialog() {
		const sel = this.printableParts(this.selectedNodes());
		const nodes = sel.length > 1 ? sel : this.printableParts(this.model.nodes);
		if (!nodes.length) { toast('Nothing to arrange', 'warn'); return; }
		const gapIn = el('input', { id: 'ab-gap', type: 'text', value: this.arrangeGap ?? 5, style: 'width:70px' });
		gapIn.addEventListener('keydown', (e) => e.stopPropagation());
		const rot = el('input', { id: 'ab-rot', type: 'checkbox', ...(this.arrangeRotate !== false ? { checked: true } : {}) });
		this.modal('Arrange on the bed', el('div', { class: 'form' },
			el('p', { class: 'muted small' }, `Packs ${nodes.length} part${nodes.length > 1 ? 's' : ''} onto the print bed, biggest first, centered on the plate.${sel.length > 1 ? ' (the selection)' : ' Select some parts first to arrange just those.'}`),
			el('label', { class: 'row' }, el('span', {}, 'Gap between parts (mm)'), gapIn),
			el('label', { class: 'check' }, rot, el('span', {}, 'Turn parts 90° when that fits better'))), [{ label: 'Cancel' }, {
			label: 'Arrange', primary: true, action: () => {
				const gap = evalExpr(gapIn.value, this.varValues || {});
				if (!(gap >= 0)) { toast('Enter a gap of 0 or more', 'error'); return false; }
				this.arrangeGap = gap;
				this.arrangeRotate = rot.checked;
				this.arrangeOnBed(nodes, { gap, rotate: rot.checked });
			},
		}]);
	},

	/** Pack parts onto the bed (max-rects, best short side fit). Returns how many fit. */
	arrangeOnBed(nodes, { gap = 5, rotate = true } = {}) {
		const bed = this.model.settings.bed;
		const items = this.printableParts(nodes).map((n) => {
			const g = this.engine.geometry(n);
			g.computeBoundingBox();
			const box = g.boundingBox.clone().applyMatrix4(this.worldMatrix(n));
			return { n, box, w: box.max.x - box.min.x, d: box.max.y - box.min.y };
		}).sort((a, b) => b.w * b.d - a.w * a.d || b.n.seq - a.n.seq);
		let free = [{ x: 0, y: 0, w: bed.w + gap, h: bed.d + gap }];
		const placed = [], left = [];
		for (const it of items) {
			let best = null;
			for (const [w, h, turn] of rotate && Math.abs(it.w - it.d) > 1e-6 ? [[it.w, it.d, false], [it.d, it.w, true]] : [[it.w, it.d, false]]) {
				const W = w + gap, H = h + gap;
				for (const f of free) {
					if (W > f.w + 1e-9 || H > f.h + 1e-9) continue;
					const s = Math.min(f.w - W, f.h - H), l = Math.max(f.w - W, f.h - H);
					if (!best || s < best.s - 1e-9 || (Math.abs(s - best.s) < 1e-9 && (l < best.l - 1e-9 || (Math.abs(l - best.l) < 1e-9 && f.y + f.x < best.y + best.x)))) best = { x: f.x, y: f.y, W, H, turn, s, l };
				}
			}
			if (!best) { left.push(it); continue; }
			placed.push({ it, ...best });
			// split every free rectangle the new one overlaps, then drop the ones inside others
			const r = best, next = [];
			for (const f of free) {
				if (r.x >= f.x + f.w || r.x + r.W <= f.x || r.y >= f.y + f.h || r.y + r.H <= f.y) { next.push(f); continue; }
				if (r.x > f.x) next.push({ x: f.x, y: f.y, w: r.x - f.x, h: f.h });
				if (r.x + r.W < f.x + f.w) next.push({ x: r.x + r.W, y: f.y, w: f.x + f.w - r.x - r.W, h: f.h });
				if (r.y > f.y) next.push({ x: f.x, y: f.y, w: f.w, h: r.y - f.y });
				if (r.y + r.H < f.y + f.h) next.push({ x: f.x, y: r.y + r.H, w: f.w, h: f.y + f.h - r.y - r.H });
			}
			free = next.filter((a, i) => !next.some((b, j) => j !== i && a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h && (j < i || a.w !== b.w || a.h !== b.h || a.x !== b.x || a.y !== b.y)));
		}
		// center the packed layout on the plate (bed coordinates are centered on the origin)
		let maxX = 0, maxY = 0;
		for (const p of placed) { maxX = Math.max(maxX, p.x + p.W - gap); maxY = Math.max(maxY, p.y + p.H - gap); }
		const ox = -maxX / 2, oy = -maxY / 2;
		for (const p of placed) {
			const n = p.it.n;
			let M = this.worldMatrix(n), box = p.it.box;
			if (p.turn) {
				const c = box.getCenter(new THREE.Vector3());
				M = new THREE.Matrix4().makeTranslation(c.x, c.y, 0).multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2)).multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, 0)).multiply(M);
				const g = this.engine.geometry(n);
				box = g.boundingBox.clone().applyMatrix4(M);
			}
			const dx = ox + p.x - box.min.x, dy = oy + p.y - box.min.y;
			this.setWorldMatrix(n, new THREE.Matrix4().makeTranslation(round(dx, 4), round(dy, 4), 0).multiply(M));
		}
		// what didn't fit goes in a row beside the bed
		let x = bed.w / 2 + 20;
		for (const it of left) {
			this.setWorldMatrix(it.n, new THREE.Matrix4().makeTranslation(round(x - it.box.min.x, 4), round(-it.d / 2 - it.box.min.y, 4), 0).multiply(this.worldMatrix(it.n)));
			x += it.w + gap;
		}
		this.commit();
		if (left.length) toast(`${placed.length} part${placed.length === 1 ? '' : 's'} fit on the bed; ${left.length} didn't and ${left.length > 1 ? 'were' : 'was'} put beside it`, 'warn', 6000);
		else toast(`Arranged ${placed.length} part${placed.length === 1 ? '' : 's'} on the bed`, 'ok', 3000);
		return placed.length;
	},
};
