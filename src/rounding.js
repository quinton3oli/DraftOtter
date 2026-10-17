// Round dimensions: snap shape sizes, positions, scaled sizes and angles to a chosen step (e.g. 0.01 mm), for the
// selection or the whole design, with a preview of what changes. Values driven by expressions are left alone.
import { el, fmt, toast } from './util.js';

/** v rounded to the nearest multiple of step, without float noise (0.1 + 0.2 → 0.3). */
export function snapTo(v, step) {
	if (!(step > 0)) return v;
	const dec = Math.max(0, Math.min(12, Math.ceil(-Math.log10(step) + 1e-9) + 1));
	return +(Math.round(v / step) * step).toFixed(dec);
}

/**
 * Float noise from 32-bit geometry (46.9999, 30.5001): a value within 0.15 µm of a whole micron is snapped to it;
 * anything else (12.3456) is kept as it is.
 */
export function snapNoise(v) {
	if (typeof v !== 'number' || !isFinite(v)) return v;
	const r = Math.round(v * 1000) / 1000;
	return r !== v && Math.abs(v - r) < 1.5e-4 ? +r.toFixed(3) : v;
}

/**
 * For values measured off 32-bit mesh data (push/pull outlines and placement): a whole micron when the value is that
 * within float precision (15.3000002 → 15.3), otherwise the value as it is. Unlike snapNoise this never moves a
 * value by more than ~1e-6 of itself, so a push/pull on a slanted face stays exactly on that face.
 */
export function snapMeasured(v) {
	if (typeof v !== 'number' || !isFinite(v)) return v;
	const r = Math.round(v * 1000) / 1000;
	return Math.abs(v - r) <= Math.max(1e-9, Math.abs(v) * 1.2e-6) ? +r.toFixed(3) : Math.round(v * 1e9) / 1e9;
}

/** An angle in degrees: exactly a multiple of 90° when within 3e-4° of one, otherwise to 9 decimals. */
export function snapAngle(deg) {
	const k = Math.round(deg / 90) * 90;
	return Math.abs(deg - k) < 3e-4 ? k : Math.round(deg * 1e9) / 1e9;
}

/** Apply fn to every number in a (nested) array, in place; returns how many changed. */
export function mapNumbers(arr, fn) {
	let changed = 0;
	for (let i = 0; i < arr.length; i++) {
		if (Array.isArray(arr[i])) changed += mapNumbers(arr[i], fn);
		else if (typeof arr[i] === 'number') { const r = fn(arr[i]); if (r !== arr[i]) { arr[i] = r; changed++; } }
	}
	return changed;
}

// numeric params that are counts, seeds or flags rather than dimensions
const NOT_SIZES = new Set(['seg', 'segs', 'sides', 'count', 'points', 'teeth', 'seed', 'v', 'turns', 'n', 'rows', 'cols', 'quality']);

export const RoundMixin = {
	/**
	 * Work out (and with apply, make) the changes. opts: { step, angleStep, scope: 'sel' | 'all', sizes, positions,
	 * angles }. Returns { count, largest, angleLargest, skipped }.
	 */
	roundDimensions(opts, apply = false) {
		const roots = opts.scope === 'sel' ? this.selectedNodes() : this.model.nodes;
		const out = { count: 0, largest: 0, angleLargest: 0, skipped: 0 };
		const take = (n, path, get, set, step, isAngle) => {
			const v = get();
			if (typeof v !== 'number' || !isFinite(v)) return;
			if (n.exprs && n.exprs[path]) { if (Math.abs(snapTo(v, step) - v) > 1e-12) out.skipped++; return; }
			const r = snapTo(v, step);
			const d = Math.abs(r - v);
			if (d <= 1e-12) return;
			out.count++;
			if (isAngle) out.angleLargest = Math.max(out.angleLargest, d); else out.largest = Math.max(out.largest, d);
			if (apply) set(r);
		};
		const seen = new Set();
		const walk = (n) => {
			if (seen.has(n.id) || n.locked) return;
			seen.add(n.id);
			if (opts.sizes && n.params && n.type !== 'mesh') {
				for (const k of Object.keys(n.params)) {
					// lists of points (push/pull outlines, sketch points)
					if (Array.isArray(n.params[k]) && !(n.exprs && n.exprs['params.' + k])) {
						const copy = JSON.parse(JSON.stringify(n.params[k]));
						const c = mapNumbers(copy, (v) => { const r = snapTo(v, opts.step); if (Math.abs(r - v) > 1e-12) out.largest = Math.max(out.largest, Math.abs(r - v)); return Math.abs(r - v) > 1e-12 ? r : v; });
						out.count += c;
						if (apply && c) n.params[k] = copy;
					}
				}
				for (const k of Object.keys(n.params)) if (!NOT_SIZES.has(k)) take(n, 'params.' + k, () => n.params[k], (r) => { n.params[k] = r; }, opts.step, /angle|twist|draft|sweep|tilt/i.test(k));
			}
			if (opts.positions) for (let i = 0; i < 3; i++) take(n, 'pos.' + i, () => n.pos[i], (r) => { n.pos[i] = r; }, opts.step);
			if (opts.angles) for (let i = 0; i < 3; i++) take(n, 'rot.' + i, () => n.rot[i], (r) => { n.rot[i] = r; }, opts.angleStep, true);
			if (n.children) n.children.forEach(walk);
		};
		roots.forEach(walk);
		// sizes that come from a scale: snap the scaled size (the scale itself keeps full precision)
		if (opts.sizes) {
			const before = new Map();
			const keep = (n) => { before.set(n, n.scale.slice()); (n.children || []).forEach(keep); };
			roots.forEach(keep);
			this.tidyScales(opts.step, roots);
			for (const [n, s] of before) {
				if (s.some((v, i) => v !== n.scale[i])) {
					out.count++;
					const g = this.engine.geometry(n);
					if (g && g.boundingBox) s.forEach((v, i) => { const b = g.boundingBox.max.getComponent(i) - g.boundingBox.min.getComponent(i); out.largest = Math.max(out.largest, Math.abs((n.scale[i] - v) * b)); });
					if (!apply) n.scale = s;
				}
			}
		}
		return out;
	},

	roundDialog() {
		const hasSel = this.selectedNodes().length > 0;
		const last = this.lastRounding || { step: 0.01, angleStep: 0.1, sizes: true, positions: true, angles: true };
		const steps = [1, 0.5, 0.1, 0.05, 0.01, 0.001];
		const stepSel = el('select', { id: 'rd-step' }, ...steps.map((s) => el('option', { value: s }, `${s} mm`)), el('option', { value: 'custom' }, 'Custom…'));
		const custom = el('input', { type: 'text', id: 'rd-custom', value: String(last.step), style: 'width:80px' });
		stepSel.value = steps.includes(last.step) ? String(last.step) : 'custom';
		const angSel = el('select', { id: 'rd-angle' }, ...[15, 5, 1, 0.5, 0.1, 0.01].map((s) => el('option', { value: s }, `${s}°`)));
		angSel.value = String(last.angleStep);
		const cb = (id, label, on) => el('label', { class: 'check' }, el('input', { type: 'checkbox', id, ...(on ? { checked: true } : {}) }), el('span', {}, label));
		const radio = (value, label, on, disabled) => el('label', { class: 'chip-check' }, el('input', { type: 'radio', name: 'rd-scope', value, ...(on ? { checked: true } : {}), ...(disabled ? { disabled: true } : {}) }), el('span', {}, label));
		const note = el('p', { class: 'muted small', id: 'rd-note' });
		const form = el('div', { class: 'form' },
			el('label', { class: 'row' }, el('span', {}, 'Round to the nearest'), el('div', { class: 'chips' }, stepSel, custom)),
			el('div', { class: 'row' }, el('span', {}, 'Apply to'), el('div', { class: 'chips' }, radio('sel', 'Selected objects', hasSel, !hasSel), radio('all', 'Whole design', !hasSel))),
			cb('rd-sizes', 'Sizes (dimensions, and sizes made by scaling)', last.sizes),
			cb('rd-positions', 'Positions', last.positions),
			el('div', { class: 'row' }, cb('rd-angles', 'Rotations, to the nearest', last.angles), angSel),
			note);
		const q = (id) => form.querySelector('#' + id);
		const opts = () => {
			const step = stepSel.value === 'custom' ? parseFloat(custom.value) : parseFloat(stepSel.value);
			return { step, angleStep: parseFloat(angSel.value), scope: form.querySelector('input[name="rd-scope"]:checked').value, sizes: q('rd-sizes').checked, positions: q('rd-positions').checked, angles: q('rd-angles').checked };
		};
		const update = () => {
			custom.style.display = stepSel.value === 'custom' ? '' : 'none';
			const o = opts();
			if (!(o.step > 0)) { note.textContent = 'Enter a step larger than 0.'; return; }
			const r = this.roundDimensions(o, false);
			note.textContent = r.count
				? `${r.count} value${r.count > 1 ? 's' : ''} will change` + (r.largest ? ` — the largest by ${fmt(r.largest, 6)} mm` : '') + (r.angleLargest ? `, angles by up to ${fmt(r.angleLargest, 4)}°` : '') + '.' + (r.skipped ? ` ${r.skipped} value${r.skipped > 1 ? 's' : ''} set by expressions ${r.skipped > 1 ? 'stay' : 'stays'} as ${r.skipped > 1 ? 'they are' : 'it is'}.` : '')
				: 'Everything is already on that step.' + (r.skipped ? ` (${r.skipped} set by expressions left alone.)` : '');
		};
		form.addEventListener('change', update);
		custom.addEventListener('input', update);
		custom.addEventListener('keydown', (e) => e.stopPropagation());
		this.modal('Round dimensions', form, [{ label: 'Cancel' }, {
			label: 'Round', primary: true, action: () => {
				const o = opts();
				if (!(o.step > 0)) { toast('Enter a step larger than 0', 'error'); return false; }
				const r = this.roundDimensions(o, true);
				this.lastRounding = { step: o.step, angleStep: o.angleStep, sizes: o.sizes, positions: o.positions, angles: o.angles };
				this.propSig = null;
				this.commit();
				toast(r.count ? `Rounded ${r.count} value${r.count > 1 ? 's' : ''} to ${o.step} mm — Undo (Ctrl+Z) takes it back` : 'Nothing needed rounding', r.count ? 'ok' : 'info', 4000);
			},
		}]);
		update();
	},
};
