// Hole Wizard: standard holes (ISO metric and ANSI unified inch) — clearance, tapped (optionally with modeled
// threads), counterbore, countersink, heat-set insert and nut trap. Dimensions in mm.
// clr: close / normal / loose clearance Ø · tap: tap drill Ø · cb: counterbore Ø, depth · csk: countersink Ø
// ins: heat-set insert hole Ø, depth · nut: hex nut across flats, thickness · p: thread pitch · D: major Ø
import { revolveProfile, extrudePts, buildShape } from './shapes.js';

export const HOLE_SIZES = {
	M2: { std: 'ISO', D: 2, p: 0.4, tap: 1.6, clr: [2.2, 2.4, 2.6], cb: [4.4, 2.2], csk: 4.4, ins: [3.2, 4.0], nut: [4.0, 1.6] },
	'M2.5': { std: 'ISO', D: 2.5, p: 0.45, tap: 2.05, clr: [2.7, 2.9, 3.1], cb: [5.5, 2.7], csk: 5.5, ins: [3.6, 4.5], nut: [5.0, 2.0] },
	M3: { std: 'ISO', D: 3, p: 0.5, tap: 2.5, clr: [3.2, 3.4, 3.6], cb: [6.5, 3.2], csk: 6.7, ins: [4.0, 5.0], nut: [5.5, 2.4] },
	M4: { std: 'ISO', D: 4, p: 0.7, tap: 3.3, clr: [4.3, 4.5, 4.8], cb: [8.0, 4.2], csk: 9.0, ins: [5.6, 6.0], nut: [7.0, 3.2] },
	M5: { std: 'ISO', D: 5, p: 0.8, tap: 4.2, clr: [5.3, 5.5, 5.8], cb: [10.0, 5.2], csk: 11.2, ins: [6.4, 7.0], nut: [8.0, 4.0] },
	M6: { std: 'ISO', D: 6, p: 1.0, tap: 5.0, clr: [6.4, 6.6, 7.0], cb: [11.5, 6.2], csk: 13.4, ins: [8.0, 9.0], nut: [10.0, 5.0] },
	M8: { std: 'ISO', D: 8, p: 1.25, tap: 6.8, clr: [8.4, 9.0, 10.0], cb: [15.0, 8.2], csk: 17.9, ins: [9.6, 10.0], nut: [13.0, 6.5] },
	M10: { std: 'ISO', D: 10, p: 1.5, tap: 8.5, clr: [10.5, 11.0, 12.0], cb: [18.0, 10.2], csk: 22.4, ins: [12.0, 12.0], nut: [16.0, 8.0] },
	M12: { std: 'ISO', D: 12, p: 1.75, tap: 10.2, clr: [13.0, 13.5, 14.5], cb: [20.0, 12.2], csk: 26.4, ins: [14.0, 14.0], nut: [18.0, 10.0] },
	'#4-40': { std: 'ANSI', D: 2.845, p: 0.635, tap: 2.26, clr: [2.95, 3.26, 3.66], cb: [5.56, 2.84], csk: 5.4, ins: [4.0, 4.8], nut: [6.35, 2.38] },
	'#6-32': { std: 'ANSI', D: 3.505, p: 0.794, tap: 2.69, clr: [3.66, 3.80, 4.09], cb: [6.35, 3.51], csk: 6.6, ins: [4.6, 5.6], nut: [7.94, 2.78] },
	'#8-32': { std: 'ANSI', D: 4.166, p: 0.794, tap: 3.45, clr: [4.32, 4.50, 4.85], cb: [7.14, 4.17], csk: 8.0, ins: [5.6, 6.4], nut: [8.73, 3.18] },
	'#10-24': { std: 'ANSI', D: 4.826, p: 1.058, tap: 3.80, clr: [5.05, 5.18, 5.61], cb: [7.94, 4.83], csk: 9.4, ins: [6.4, 7.1], nut: [9.53, 3.18] },
	'1/4-20': { std: 'ANSI', D: 6.35, p: 1.27, tap: 5.11, clr: [6.53, 6.76, 7.14], cb: [9.53, 6.35], csk: 12.3, ins: [8.0, 8.9], nut: [11.11, 5.56] },
	'5/16-18': { std: 'ANSI', D: 7.938, p: 1.411, tap: 6.53, clr: [8.20, 8.43, 8.73], cb: [11.91, 7.94], csk: 15.3, ins: [10.0, 10.0], nut: [12.7, 6.75] },
	'3/8-16': { std: 'ANSI', D: 9.525, p: 1.588, tap: 7.94, clr: [9.80, 10.08, 10.5], cb: [14.29, 9.53], csk: 18.5, ins: [12.0, 12.0], nut: [14.29, 8.33] },
	'1/2-13': { std: 'ANSI', D: 12.7, p: 1.954, tap: 10.72, clr: [13.1, 13.5, 14.3], cb: [19.05, 12.7], csk: 24.6, ins: [16.0, 16.0], nut: [19.05, 11.1] },
};
export const HOLE_TYPES = ['clearance', 'tapped', 'counterbore', 'countersink', 'insert', 'nuttrap'];
export const TYPE_LABEL = { clearance: 'Clearance', tapped: 'Tapped', counterbore: 'Counterbore', countersink: 'Countersink', insert: 'Heat-set insert', nuttrap: 'Nut trap' };

/** Hole callout text, e.g. "Ø3.4 thru, ⌴Ø6.5 ↧3.2 (M3 counterbore)". */
export function holeCallout(p) {
	const S = HOLE_SIZES[p.size] || HOLE_SIZES.M3;
	const f = (v) => (Math.round(v * 100) / 100).toString();
	const fit = { close: 0, normal: 1, loose: 2 }[p.fit] ?? 1;
	const depth = p.thru ? 'thru' : `↧${f(p.depth)}`;
	switch (p.type) {
		case 'tapped': return `${p.size}${S.std === 'ISO' ? '×' + S.p : ''} ${p.threads ? 'threaded' : `tap drill Ø${f(S.tap)}`} ${depth}`;
		case 'counterbore': return `Ø${f(S.clr[fit])} ${depth}, ⌴Ø${f(S.cb[0])} ↧${f(S.cb[1])} (${p.size})`;
		case 'countersink': return `Ø${f(S.clr[fit])} ${depth}, ⌵Ø${f(S.csk)} × ${S.std === 'ISO' ? 90 : 82}° (${p.size})`;
		case 'insert': return `Insert Ø${f(S.ins[0])} ↧${f(S.ins[1])} (${p.size})`;
		case 'nuttrap': return `Ø${f(S.clr[fit])} ${depth}, hex nut ${f(S.nut[0])} AF (${p.size})`;
		default: return `Ø${f(S.clr[fit])} ${depth} (${p.size} ${p.fit || 'normal'} fit)`;
	}
}

/** Hole solid with its top at z = 0 (the face it is drilled into) going down to z = −depth. */
export function buildWizardHole(p, ctx) {
	const g = buildRaw(p, ctx);
	if (g) g.translate(0, 0, -Math.max(0.5, p.depth || 10));
	return g;
}

function buildRaw(p, ctx) {
	const S = HOLE_SIZES[p.size] || HOLE_SIZES.M3;
	const D = Math.max(0.5, p.depth || 10), seg = 48, x = p.extra || 0;
	const fit = { close: 0, normal: 1, loose: 2 }[p.fit] ?? 1;
	const rs = (S.clr[fit] + x) / 2;
	let prof;
	switch (p.type) {
		case 'tapped': {
			if (p.threads) {
				// modeled internal thread: a threaded rod used as the hole, with a little play for printing
				const g = buildShape('thread', { d: S.D + x, pitch: S.p, length: D + 0.2, clearance: 0.15, seg: 48, chamfer: true, leftHand: false }, ctx);
				if (g) { g.computeBoundingBox(); g.translate(0, 0, -g.boundingBox.min.z - 0.1); return g; }
			}
			const rt = (S.tap + x) / 2;
			prof = [[0, 0], [rt, 0], [rt, D], [0, D]];
			break;
		}
		case 'counterbore': {
			const rh = (S.cb[0] + x) / 2, hh = Math.min(S.cb[1] + 0.2, D - 0.2);
			prof = [[0, 0], [rs, 0], [rs, D - hh], [rh, D - hh], [rh, D], [0, D]];
			break;
		}
		case 'countersink': {
			const rh = (S.csk + x) / 2, half = ((S.std === 'ISO' ? 90 : 82) / 2) * (Math.PI / 180);
			const hh = Math.min((rh - rs) / Math.tan(half), D - 0.2);
			prof = [[0, 0], [rs, 0], [rs, D - hh], [rh, D], [0, D]];
			break;
		}
		case 'insert': {
			const ri = (S.ins[0] + x) / 2, ih = Math.min(S.ins[1] + 0.5, D), fl = Math.min(0.5, ih / 3);
			prof = ih >= D - 1e-6 ? [[0, 0], [ri, 0], [ri, D - fl], [ri + fl, D], [0, D]] : [[0, 0], [rs, 0], [rs, D - ih], [ri, D - ih], [ri, D - fl], [ri + fl, D], [0, D]];
			break;
		}
		case 'nuttrap': {
			const af = S.nut[0] + 0.3 + x, nh = Math.min(S.nut[1] + 0.3, D - 0.2), R = af / 2 / Math.cos(Math.PI / 6);
			const hex = [];
			for (let i = 0; i < 6; i++) hex.push([R * Math.cos((Math.PI / 3) * i), R * Math.sin((Math.PI / 3) * i)]);
			const pocket = extrudePts(hex, nh);
			pocket.translate(0, 0, D - nh);
			const shaft = revolveProfile([[0, 0], [rs, 0], [rs, D - nh / 2], [0, D - nh / 2]], seg);
			return ctx && ctx.union ? ctx.union([shaft, pocket]) : shaft;
		}
		default:
			prof = [[0, 0], [rs, 0], [rs, D], [0, D]];
	}
	return revolveProfile(prof, seg);
}
