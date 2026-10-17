// Wrap text (or a sketch) around a cylinder: emboss it outward or engrave it inward. The flat shape is
// refined and bent with Manifold's warp, so the result stays watertight and fuses with the cylinder.
import * as THREE from 'three';
import { buildShape } from './shapes.js';
import { makeNode, makeGroup } from './model.js';
import { round, fmt, toast, el, evalExpr } from './util.js';

/**
 * params: { R, depth, mode ('emboss' | 'engrave'), angle (°, around the axis; 0 = front / −Y), z (along the axis),
 *           text, size, font, src? ({ type, params } of a sketch, used instead of text) }
 * Output frame: cylinder axis = +Z through the origin.
 */
export function buildWrap(p, ctx) {
	const src = p.src && p.src.type ? buildShape(p.src.type, p.src.params, ctx) : buildShape('text', { text: p.text || 'Text', size: p.size || 6, depth: 1, font: p.font || 'bold', seg: 8 }, ctx);
	if (!src || !ctx.warp) return src;
	src.computeBoundingBox();
	const b = src.boundingBox, cx = (b.min.x + b.max.x) / 2, cy = (b.min.y + b.max.y) / 2, z0 = b.min.z, z1 = b.max.z;
	const R = Math.max(0.5, p.R || 10), d = Math.max(0.05, p.depth || 0.8), ov = Math.min(0.3, d);
	const [r0, r1] = p.mode === 'engrave' ? [R - d, R + ov] : [R - ov, R + d];
	const a0 = ((p.angle || 0) * Math.PI) / 180, zo = p.z || 0;
	const len = Math.max(0.15, R * 0.035);
	return ctx.warp(src, len, (v) => {
		const t = (v[2] - z0) / (z1 - z0 || 1), rho = r0 + t * (r1 - r0), th = (v[0] - cx) / R + a0;
		const y = v[1] - cy;
		v[0] = rho * Math.sin(th);
		v[1] = -rho * Math.cos(th);
		v[2] = y + zo;
	});
}

const ROUND_TYPES = { cylinder: (p) => p.r, tube: (p) => p.ro, cone: (p) => Math.max(p.r1, p.r2) };

export const WrapMixin = {
	/** Select a text (or sketch) and a cylinder, then wrap one around the other. */
	wrapDialog() {
		const sel = this.selectedNodes().map((n) => this.model.topLevelOf(n.id)).filter((n, i, a) => n && a.indexOf(n) === i);
		const cyl = sel.find((n) => ROUND_TYPES[n.type]);
		const flat = sel.find((n) => n !== cyl && (n.type === 'text' || n.type === 'sketch'));
		if (!cyl) { toast('Select a cylinder (or tube) and, optionally, a text or sketch to wrap onto it', 'warn', 4000); return; }
		const R = ROUND_TYPES[cyl.type](cyl.params) * Math.max(cyl.scale[0], cyl.scale[1]);
		const H = (cyl.params.h || 20) * cyl.scale[2];
		const inp = (id, v, w = 80) => el('input', { id, type: 'text', value: v, style: `width:${w}px` });
		const radio = (name, value, label, checked) => el('label', { class: 'chip-check' }, el('input', { type: 'radio', name, value, ...(checked ? { checked: true } : {}) }), el('span', {}, label));
		const form = el('div', { class: 'form' },
			flat ? el('p', { class: 'muted small' }, `Wrapping “${flat.name}” around “${cyl.name}” (R ${fmt(R, 2)} mm).`) : el('label', { class: 'row' }, el('span', {}, 'Text'), inp('wr-text', 'DraftOtter', 160)),
			flat ? null : el('label', { class: 'row' }, el('span', {}, 'Letter height (mm)'), inp('wr-size', round(Math.min(H * 0.4, 8), 2))),
			el('div', { class: 'row' }, el('span', {}, 'Style'), el('div', { class: 'chips' }, radio('wr-mode', 'emboss', 'Raised (emboss)', true), radio('wr-mode', 'engrave', 'Cut in (engrave)', false))),
			el('label', { class: 'row' }, el('span', {}, 'Depth (mm)'), inp('wr-depth', 0.8)),
			el('label', { class: 'row' }, el('span', {}, 'Around (°, 0 = front)'), inp('wr-angle', 0)),
			el('label', { class: 'row' }, el('span', {}, 'Height on the cylinder (mm)'), inp('wr-z', 0)),
			el('label', { class: 'check' }, el('input', { id: 'wr-combine', type: 'checkbox', checked: true }), el('span', {}, 'Combine with the cylinder')),
			el('p', { class: 'muted small' }, 'Height is measured from the cylinder’s middle. The wrapped shape stays editable: change the text, depth or angle in Properties.'));
		const q = (id) => form.querySelector('#' + id);
		this.modal('Wrap onto cylinder', form, [{ label: 'Cancel' }, {
			label: 'Wrap', primary: true, action: () => {
				const v = (id) => evalExpr(q(id).value, this.varValues || {});
				const mode = form.querySelector('input[name="wr-mode"]:checked').value;
				const params = { R: round(R, 4), depth: v('wr-depth'), mode, angle: v('wr-angle'), z: v('wr-z') };
				if (![params.depth, params.angle, params.z].every(isFinite) || !(params.depth > 0)) { toast('Check the numbers', 'error'); return false; }
				if (flat && flat.type === 'text') Object.assign(params, { text: flat.params.text, size: flat.params.size, font: flat.params.font });
				else if (flat) params.src = { type: flat.type, params: JSON.parse(JSON.stringify(flat.params)) };
				else Object.assign(params, { text: q('wr-text').value || 'Text', size: v('wr-size') || 6, font: 'bold' });
				this.wrapOnto(cyl, params, { combine: q('wr-combine').checked, remove: flat });
			},
		}]);
	},

	wrapOnto(cyl, params, { combine = true, remove = null } = {}) {
		const w = makeNode('wrap', params, { name: params.mode === 'engrave' ? 'Engraved text' : 'Embossed text', color: cyl.color, hole: params.mode === 'engrave' });
		// same frame as the cylinder: its axis is local Z through its center
		w.pos = cyl.pos.slice(); w.rot = cyl.rot.slice();
		const list = this.model.nodes;
		if (remove) { const i = list.indexOf(remove); if (i >= 0) list.splice(i, 1); }
		if (combine) {
			const i = list.indexOf(cyl);
			const g = makeGroup([cyl, w], { name: cyl.name + (params.mode === 'engrave' ? ' (engraved)' : ' (embossed)'), color: cyl.color });
			g.pos = cyl.pos.slice();
			for (const c of g.children) c.pos = c.pos.map((v, k) => round(v - g.pos[k]));
			list.splice(i, 1, g);
			this.sel = [g.id];
		} else {
			list.push(w);
			this.sel = [w.id];
		}
		this.commit();
		return w;
	},
};
