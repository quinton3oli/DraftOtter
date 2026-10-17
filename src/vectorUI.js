// App commands for 2D vector files: import DXF / SVG as a sketch part, export sketches and part sections.
import * as THREE from 'three';
import { makeNode } from './model.js';
import { sectionAt, fromPlane } from './engine.js';
import { parseSVG, parseDXF, shapesToModel, shapesToDXF, shapesToSVG, modelToShapes, shapesBox, transformShapes } from './vector.js';
import { toModel, modelToParams, profileRegions } from './sketchModel.js';
import { round, fmt, evalExpr, toast, el, pickFile, readFile, download } from './util.js';

const AX = { x: 0, y: 1, z: 2 };
const safe = (s) => String(s || 'design').replace(/[^\w\- ]+/g, '_');

export const VectorMixin = {
	async importVectorFile() {
		const files = await pickFile('.dxf,.svg', false);
		const file = files && files[0];
		if (!file) return;
		try {
			this.importVectorText(file.name, await readFile(file, true));
		} catch (e) {
			console.error(e);
			toast('Could not read that file: ' + e.message, 'error', 5000);
		}
	},

	/** Show the import dialog for DXF / SVG text (also the entry point for tests). */
	importVectorText(name, text) {
		const sh = /\.svg$/i.test(name) ? parseSVG(text) : parseDXF(text);
		const box = shapesBox(sh);
		if (!(box.w >= 0) || (!sh.polylines.length && !sh.circles.length)) { toast('No usable outlines in that file', 'warn'); return; }
		const base = name.replace(/\.(dxf|svg)$/i, '');
		const inp = (id, v) => el('input', { id, type: 'text', value: v, style: 'width:90px' });
		const form = el('div', { class: 'form' },
			el('p', { class: 'muted small' }, `${name}: ${sh.polylines.length} paths / lines, ${sh.circles.length} circles · ${fmt(box.w, 2)} × ${fmt(box.h, 2)} mm`),
			el('label', { class: 'row' }, el('span', {}, 'Width (mm)'), inp('vi-w', round(box.w, 3))),
			el('label', { class: 'row' }, el('span', {}, 'Extrude height (mm)'), inp('vi-h', this.lastVectorHeight ?? 3)),
			el('p', { class: 'muted small' }, 'Closed outlines become solids and outlines inside them become holes. The result is an editable sketch part — open it to adjust, constrain or add to it.'));
		this.modal('Import ' + (/\.svg$/i.test(name) ? 'SVG' : 'DXF'), form, [{ label: 'Cancel' }, {
			label: 'Import', primary: true, action: () => {
				const w = evalExpr(form.querySelector('#vi-w').value, this.varValues || {}), h = evalExpr(form.querySelector('#vi-h').value, this.varValues || {});
				if (!(w > 0) || !(h > 0)) { toast('Enter a width and height greater than 0', 'error'); return false; }
				this.lastVectorHeight = h;
				const s = box.w > 0 ? w / box.w : 1;
				transformShapes(sh, s, -(box.x0 + box.w / 2) * s, -(box.y0 + box.h / 2) * s); // centered on its own origin
				const m = shapesToModel(sh, { tol: Math.max(1e-3, w * 1e-5), simplifyTol: Math.max(0.005, w * 2e-4) });
				const regions = profileRegions({ v: 2, ...m });
				if (!regions.length) toast('No closed outlines found — the sketch was imported, but needs closing to become a solid', 'warn', 5000);
				const node = makeNode('sketch', modelToParams(m, { mode: 'extrude', height: h, fillet: 0, anchored: true }), { name: base || 'Imported sketch' });
				this.addNode(node);
				toast(`Imported ${base} — ${regions.length} solid${regions.length === 1 ? '' : 's'}`, 'ok');
			},
		}]);
	},

	/** Sketch node → shapes; exact arcs unless corner rounding is used (then the rounded outline). */
	sketchShapes(n) {
		const p = n.params, m = toModel(p);
		const rounded = (p.fillet || 0) > 0 || Object.values(p.radii || {}).some((r) => r > 0);
		if (!rounded) return modelToShapes(m);
		const sh = { polylines: [], circles: [] };
		for (const r of profileRegions(p)) for (const loop of [r.outer, ...r.holes]) sh.polylines.push({ pts: loop, closed: true });
		return sh;
	},

	exportSketchVector(n, kind) {
		const sh = this.sketchShapes(n);
		if (!sh.polylines.length && !sh.circles.length) { toast('This sketch is empty', 'warn'); return; }
		if (kind === 'dxf') download(shapesToDXF(sh), safe(n.name) + '.dxf', 'application/dxf');
		else download(shapesToSVG(sh), safe(n.name) + '.svg', 'image/svg+xml');
	},

	sectionExportDialog() {
		const sel = this.selectedNodes().map((n) => this.model.topLevelOf(n.id)).filter((n, i, a) => n && a.indexOf(n) === i);
		const nodes = (sel.length ? sel : this.model.nodes.filter((n) => n.visible)).filter((n) => n.visible !== false);
		if (!nodes.some((n) => !n.hole)) { toast('Nothing to cut — add some solid shapes first', 'warn'); return; }
		const geom = this.engine.printable(nodes, true);
		if (!geom) return;
		geom.computeBoundingBox();
		const bb = geom.boundingBox;
		const last = this.lastSection || { axis: 'z', format: 'dxf' };
		const radio = (name, value, label, checked) => el('label', { class: 'chip-check' }, el('input', { type: 'radio', name, value, ...(checked ? { checked: true } : {}) }), el('span', {}, label));
		const pos = el('input', { id: 'se-pos', type: 'text', style: 'width:90px' });
		const info = el('p', { class: 'muted small' });
		const form = el('div', { class: 'form' },
			el('p', { class: 'muted small' }, sel.length ? `Cutting the ${sel.length} selected object${sel.length > 1 ? 's' : ''}.` : 'Cutting all visible objects.'),
			el('div', { class: 'row' }, el('span', {}, 'Cut across'), el('div', { class: 'chips' }, ...['x', 'y', 'z'].map((a) => radio('se-axis', a, a.toUpperCase(), a === last.axis)))),
			el('label', { class: 'row' }, el('span', {}, 'At (mm)'), pos),
			el('div', { class: 'row' }, el('span', {}, 'Format'), el('div', { class: 'chips' }, radio('se-fmt', 'dxf', 'DXF', last.format !== 'svg'), radio('se-fmt', 'svg', 'SVG', last.format === 'svg'))),
			info);
		const axis = () => form.querySelector('input[name="se-axis"]:checked').value;
		const mid = () => { const i = AX[axis()]; return i === 2 ? Math.min(bb.max.z, bb.min.z + 0.2) : (bb.min.getComponent(i) + bb.max.getComponent(i)) / 2; };
		const update = () => {
			const a = axis(), v = evalExpr(pos.value, this.varValues || {});
			const sec = isFinite(v) ? sectionAt(geom, a, v) : null;
			info.textContent = sec && sec.polygons.length ? `${sec.polygons.length} outline${sec.polygons.length > 1 ? 's' : ''}, ${fmt(sec.area, 1)} mm² — drawn in the cut plane, in millimeters.` : 'The plane misses the part here.';
			this.vp.showCutPlane(a, v, bb);
		};
		pos.value = round(mid(), 3);
		form.addEventListener('change', (e) => { if (e.target.name === 'se-axis') pos.value = round(mid(), 3); update(); });
		pos.addEventListener('input', update);
		this.modal('Export section', form, [{ label: 'Cancel' }, {
			label: 'Export', primary: true, action: () => {
				const a = axis(), v = evalExpr(pos.value, this.varValues || {}), format = form.querySelector('input[name="se-fmt"]:checked').value;
				const sec = isFinite(v) ? sectionAt(geom, a, v) : null;
				if (!sec || !sec.polygons.length) { toast('The plane misses the part — pick another position', 'error'); return false; }
				this.lastSection = { axis: a, format };
				const sh = { polylines: sec.polygons.map((pts) => ({ pts, closed: true })), circles: [] };
				const name = safe(this.model.doc.name) + `_section_${a}${round(v, 2)}`;
				if (format === 'dxf') download(shapesToDXF(sh), name + '.dxf', 'application/dxf');
				else download(shapesToSVG(sh, { fill: '#000', stroke: 'none' }), name + '.svg', 'image/svg+xml');
				toast(`Exported ${sec.polygons.length} outline${sec.polygons.length > 1 ? 's' : ''} as ${format.toUpperCase()}`, 'ok');
			},
		}], '', { onClose: () => this.vp.showCutPlane(null) });
		update();
	},
};

export { fromPlane };
