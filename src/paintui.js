// Modify → Paint faces: click faces to color them for multi-color (AMS) printing. Each click stores a seed on the part
// (see paint.js), so the paint follows later edits; 3MF export hands the colors to the slicer as filaments.
import { faceTriangles, seedTriangle, effectivePaint } from './paint.js';
import { el, toast, round } from './util.js';
const $ = (s) => document.querySelector(s);

const SWATCHES = ['#ffffff', '#1a1a1a', '#e03a3a', '#f2c230', '#2f7de1', '#2fae5a', '#f07f1e', '#9a5ad6', '#8a8f98'];

export const PaintMixin = {
	startPaint() {
		if (this.tool !== 'paint') this.setTool('paint');
	},

	/** The floating paint bar (shown while the tool is on). */
	paintBar(active) {
		let bar = $('#paint-bar');
		if (!active) { if (bar) bar.style.display = 'none'; return; }
		if (!bar) { bar = el('div', { id: 'paint-bar', class: 'float-bar' }); $('#viewport').appendChild(bar); }
		bar.style.display = '';
		bar.innerHTML = '';
		if (!this.paintColor) this.paintColor = '#e03a3a';
		if (!this.paintMode) this.paintMode = 'fill';
		// colors already used in the design come first, so matching a color is one click
		const used = [];
		const walk = (ns) => { for (const n of ns) { for (const s of n.paint || []) if (!used.includes(s.c)) used.push(s.c); if (n.children) walk(n.children); } };
		walk(this.model.nodes);
		const colors = [...used, ...SWATCHES.filter((c) => !used.includes(c))].slice(0, 12);
		const sw = colors.map((c) => el('button', { class: 'paint-sw' + (c === this.paintColor && this.paintMode === 'fill' ? ' on' : ''), style: `background:${c}`, title: c, onclick: () => { this.paintColor = c; this.paintMode = 'fill'; this.paintBar(true); } }));
		const pick = el('input', { type: 'color', value: this.paintColor, title: 'Any color' });
		pick.addEventListener('change', () => { this.paintColor = pick.value; this.paintMode = 'fill'; this.paintBar(true); });
		const erase = el('button', { class: 'btn sm' + (this.paintMode === 'erase' ? ' active' : ''), title: 'Click painted faces to take the paint off', onclick: () => { this.paintMode = this.paintMode === 'erase' ? 'fill' : 'erase'; this.paintBar(true); } }, 'Eraser');
		const sel = this.selectedNodes().filter((n) => effectivePaint(n).length);
		bar.append(el('b', {}, 'Paint'),
			el('span', { class: 'muted' }, this.paintMode === 'erase' ? 'Click a painted face to clear it' : 'Click a face to color it'),
			el('span', { class: 'paint-sws' }, ...sw, pick), erase,
			sel.length ? el('button', { class: 'btn sm', title: 'Take all paint off the selected part', onclick: () => { sel.forEach((n) => effectivePaint(n).forEach((s) => delete s.owner.paint)); this.commit(); this.paintBar(true); } }, 'Clear part') : '',
			el('button', { class: 'btn sm', onclick: () => this.setTool(null) }, 'Done'));
	},

	onPaintClick(e) {
		const sp = this.vp.surfacePoint(e);
		if (!sp || !sp.object || sp.faceIndex === undefined || !sp.face) return;
		const node = this.model.get(sp.object.userData.nodeId);
		if (!node || !this.model.isTopLevel(node.id)) return;
		if (node.hole) { toast('Holes have no color to paint — paint the part they cut', 'warn'); return; }
		if (node.locked) { toast('That part is locked', 'warn'); return; }
		const shape = this.engine.geometry(node);
		if (!shape || !shape.attributes.position) return;
		const region = new Set(faceTriangles(shape, sp.faceIndex));
		// strokes on this face are replaced (or removed by the eraser), also ones stored on a part inside this one
		const hits = effectivePaint(node).filter((s) => region.has(seedTriangle(shape, s.p, s.n)));
		for (const h of hits) {
			h.owner.paint = h.owner.paint.filter((x) => x !== h.stroke);
			if (!h.owner.paint.length) delete h.owner.paint;
		}
		if (this.paintMode === 'erase') {
			if (!hits.length) return;
		} else {
			const p = sp.object.worldToLocal(sp.point.clone()), n = sp.face.normal;
			node.paint = [...(node.paint || []), { p: [round(p.x, 4), round(p.y, 4), round(p.z, 4)], n: [round(n.x, 5), round(n.y, 5), round(n.z, 5)], c: this.paintColor }];
		}
		this.commit();
		this.paintBar(true);
	},
};
