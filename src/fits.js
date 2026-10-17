// Fits & tolerances for 3D printing: a hole can be given a fit (press / snug / sliding / loose) and is then
// enlarged by that diametral clearance plus the printer's hole compensation from Settings.
import { makeNode, makeGroup } from './model.js';
import { fmt, toast } from './util.js';

export const FITS = {
	press: { label: 'Press fit', clearance: 0.1, hint: 'pressed or tapped in, holds by friction' },
	snug: { label: 'Snug fit', clearance: 0.2, hint: 'goes in by hand, no play' },
	sliding: { label: 'Sliding fit', clearance: 0.3, hint: 'slides and turns freely (shafts, hinges)' },
	loose: { label: 'Loose fit', clearance: 0.5, hint: 'drops in easily (lids, alignment)' },
};

/** Diametral clearance (mm) a hole node gets from its fit, including the printer compensation. */
export function fitClearance(node, settings = {}) {
	if (!node || !node.hole || !node.fit) return 0;
	const c = node.fit === 'custom' ? +node.fitClearance || 0 : FITS[node.fit] ? FITS[node.fit].clearance : 0;
	return c + (+settings.holeComp || 0);
}

// Holes that are usually drilled straight through grow sideways only (X and Y of the object) unless told otherwise.
const SIDEWAYS = new Set(['cylinder', 'box', 'prism', 'wizhole', 'screwhole', 'tube']);

/** Directions a fitted hole grows in, in the object's own frame: e.g. 'xy' or 'xyz'. */
export function fitAxes(node) {
	const a = node && node.fitAxes;
	if (typeof a === 'string' && /^[xyz]+$/.test(a)) return ['x', 'y', 'z'].filter((k) => a.includes(k)).join('');
	return node && SIDEWAYS.has(node.type) ? 'xy' : 'xyz';
}

/** Exact parameter-level growth for simple holes; null when the generic offset must be used. */
export function fittedParams(type, params, d, axes = 'xy') {
	const r = d / 2, x = axes.includes('x'), y = axes.includes('y'), z = axes.includes('z');
	if (type === 'box') return { ...params, w: params.w + (x ? d : 0), d: params.d + (y ? d : 0), h: params.h + (z ? d : 0) };
	if ((type === 'cylinder' || type === 'prism') && x === y) return { ...params, r: params.r + (x ? r : 0), h: params.h + (z ? d : 0) };
	return null;
}

export const FitMixin = {
	/** A test plate: one Ø`nominal` hole per fit (plus "none"), labelled, and a matching peg. */
	fitCalibration(nominal = 5) {
		const keys = ['none', ...Object.keys(FITS)];
		const pitch = nominal + 9, w = pitch * keys.length + 4, d = nominal + 16;
		const plate = makeNode('box', { w, d, h: 5 }, { name: 'Plate', color: '#4d96ff' });
		const kids = [plate];
		keys.forEach((k, i) => {
			const x = -w / 2 + 2 + pitch * (i + 0.5);
			const h = makeNode('cylinder', { r: nominal / 2, h: 12 }, { name: k === 'none' ? 'Hole (no fit)' : `Hole (${FITS[k].label})`, hole: true });
			h.pos = [x, 3, 0];
			if (k !== 'none') h.fit = k;
			kids.push(h);
			const t = makeNode('text', { text: k === 'none' ? '0' : String(FITS[k].clearance), size: 3.2, depth: 0.6 }, { name: 'Label', color: '#ffffff' });
			t.pos = [x, -d / 2 + 3.4, 2.8];
			kids.push(t);
		});
		const g = makeGroup(kids, { name: `Fit test Ø${fmt(nominal, 2)}`, color: '#4d96ff' });
		const peg = makeNode('cylinder', { r: nominal / 2, h: 12 }, { name: `Test peg Ø${fmt(nominal, 2)}`, color: '#ffb347' });
		this.addNode(g);
		this.addNode(peg);
		this.setSelection([g.id]);
		toast('Print the plate and the peg. Find the hole that fits the way you want, then set Settings → Hole compensation if every hole runs tight or loose.', 'info', 9000);
		return g;
	},
};
