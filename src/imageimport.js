// Tools → Import image as a sketch: trace a PNG / JPG (logo, icon, silhouette, drawing) into an editable sketch part,
// with a live preview of the outline and controls for threshold, invert, smoothing, detail and size.
import * as THREE from 'three';
import { makeNode } from './model.js';
import { shapesToModel } from './vector.js';
import { modelToParams, profileRegions } from './sketchModel.js';
import { traceImage, inkOf, quantizeImage, colorInk } from './imagetrace.js';
import { round, fmt, evalExpr, toast, el, pickFile } from './util.js';

const IMAGE_RE = /\.(png|jpe?g|webp|gif|bmp)$/i;
export const isImageFile = (f) => IMAGE_RE.test(f.name) || /^image\//.test(f.type || '');

/** Load an image file into pixels, scaled so its longer side is `size` px (never enlarged beyond 2×). */
async function loadPixels(file, size) {
	const url = URL.createObjectURL(file);
	try {
		const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('not an image this browser can read')); i.src = url; });
		const s = Math.min(size / Math.max(img.naturalWidth, img.naturalHeight), 2);
		const w = Math.max(1, Math.round(img.naturalWidth * s)), h = Math.max(1, Math.round(img.naturalHeight * s));
		const c = document.createElement('canvas');
		c.width = w; c.height = h;
		const ctx = c.getContext('2d', { willReadFrequently: true });
		ctx.drawImage(img, 0, 0, w, h);
		return { data: ctx.getImageData(0, 0, w, h), natural: [img.naturalWidth, img.naturalHeight], canvas: c };
	} finally {
		URL.revokeObjectURL(url);
	}
}

/** Otsu's threshold on the ink values (0..1): the split that best separates shape from background. */
function autoThreshold(ink) {
	const bins = new Float64Array(256);
	for (const v of ink) bins[Math.min(255, Math.max(0, Math.round(v * 255)))]++;
	const total = ink.length;
	let sum = 0;
	for (let i = 0; i < 256; i++) sum += i * bins[i];
	let sumB = 0, wB = 0, best = 0, t = 128;
	for (let i = 0; i < 256; i++) {
		wB += bins[i];
		if (!wB) continue;
		const wF = total - wB;
		if (!wF) break;
		sumB += i * bins[i];
		const mB = sumB / wB, mF = (sum - sumB) / wF, between = wB * wF * (mB - mF) ** 2;
		if (between > best) { best = between; t = i; }
	}
	return Math.min(0.95, Math.max(0.05, (t + 0.5) / 255));
}

/** Dark corners on an opaque image usually mean a light shape on a dark background. */
function looksInverted(img) {
	const { width: w, height: h, data } = img;
	let dark = 0, n = 0;
	for (const [x, y] of [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1], [w >> 1, 0], [w >> 1, h - 1], [0, h >> 1], [w - 1, h >> 1]]) {
		const p = (y * w + x) * 4;
		if (data[p + 3] < 128) return false; // transparent background: the opaque part is the shape
		n++;
		if (0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2] < 100) dark++;
	}
	return dark > n / 2;
}

export const ImageImportMixin = {
	/** Keep colors: one sketch part per color, side by side as in the picture, placed together on a free spot. */
	addColorLayers(layers, { s, cx, cy, height, base }) {
		const nodes = [];
		layers.forEach((L, i) => {
			const sh = { polylines: L.loops.map((lp) => ({ pts: lp.map(([x, y]) => [round((x - cx) * s, 4), round((cy - y) * s, 4)]), closed: true })), circles: [] };
			const m = shapesToModel(sh, { tol: Math.max(1e-4, s * 1e-3), simplifyTol: 0 });
			if (!profileRegions({ v: 2, ...m }).length) return;
			nodes.push(makeNode('sketch', modelToParams(m, { mode: 'extrude', height, fillet: 0, anchored: true }), { name: `${base} – color ${i + 1}`, color: L.color }));
		});
		if (!nodes.length) { toast('Nothing to import', 'warn'); return; }
		const box = new THREE.Box3();
		for (const n of nodes) { const g = this.engine.geometry(n); if (g) box.union(g.boundingBox); }
		const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
		const spot = this.freeSpot(size);
		for (const n of nodes) { n.pos = [round(spot.x - c.x, 4), round(spot.y - c.y, 4), round(-box.min.z, 4)]; this.model.nodes.push(n); }
		this.sel = nodes.map((n) => n.id);
		this.commit();
		toast(`Traced “${base}” into ${nodes.length} colored part${nodes.length > 1 ? 's' : ''}. Export as 3MF to keep the colors.`, 'ok', 5000);
	},

	async importImageFile(file) {
		if (!file) { const files = await pickFile('.png,.jpg,.jpeg,.webp,.gif,.bmp', false); file = files && files[0]; }
		if (!file) return;
		let src;
		try { src = await loadPixels(file, 600); } catch (e) { toast('Could not read that image: ' + e.message, 'error', 5000); return; }
		const base = file.name.replace(IMAGE_RE, '') || 'Traced image';
		const last = this.lastImageTrace || {};
		const st = {
			invert: looksInverted(src.data), smooth: last.smooth ?? 3, detail: last.detail ?? 600, speck: last.speck ?? 0.15,
			threshold: null, width: last.width ?? 50, height: last.height ?? 3, sizeBy: last.sizeBy || 'width',
			keepColors: !!last.keepColors, colors: last.colors ?? 0, withBg: !!last.withBg,
		};
		st.threshold = autoThreshold(inkOf(src.data, st.invert));
		let result = null, quant = null;

		const preview = el('canvas', { class: 'img-trace-preview', width: 460, height: 300 });
		const info = el('p', { class: 'muted small', id: 'it-info' });
		const slider = (id, min, max, step, value) => el('input', { id, type: 'range', min, max, step, value, style: 'width:180px' });
		const thr = slider('it-thr', 1, 99, 1, Math.round(st.threshold * 100));
		const thrVal = el('span', { class: 'muted small' });
		const smooth = slider('it-smooth', 0, 8, 1, st.smooth);
		const speck = slider('it-speck', 0, 2, 0.05, st.speck);
		const inv = el('input', { id: 'it-inv', type: 'checkbox', ...(st.invert ? { checked: true } : {}) });
		const detail = el('select', { id: 'it-detail' }, ...[[300, 'Low (faster)'], [600, 'Medium'], [1000, 'High'], [1600, 'Very high']].map(([v, l]) => el('option', { value: v }, l)));
		detail.value = String(st.detail);
		const keep = el('input', { id: 'it-keep', type: 'checkbox', ...(st.keepColors ? { checked: true } : {}) });
		const ncol = el('select', { id: 'it-ncol' }, el('option', { value: 0 }, 'Automatic'), ...[2, 3, 4, 5, 6, 7, 8].map((v) => el('option', { value: v }, String(v))));
		ncol.value = String(st.colors);
		const bg = el('input', { id: 'it-bg', type: 'checkbox', ...(st.withBg ? { checked: true } : {}) });
		keep.addEventListener('change', () => { st.keepColors = keep.checked; retrace(); });
		ncol.addEventListener('change', () => { st.colors = +ncol.value; retrace(); });
		bg.addEventListener('change', () => { st.withBg = bg.checked; retrace(); });
		const sizeBy = el('select', { id: 'it-sizeby' }, el('option', { value: 'width' }, 'Width'), el('option', { value: 'height' }, 'Height'));
		sizeBy.value = st.sizeBy;
		const sizeIn = el('input', { id: 'it-size', type: 'text', value: st.width, style: 'width:80px' });
		const hIn = el('input', { id: 'it-h', type: 'text', value: st.height, style: 'width:80px' });
		for (const i of [sizeIn, hIn]) i.addEventListener('keydown', (e) => e.stopPropagation());

		const draw = () => {
			const ctx = preview.getContext('2d'), W = preview.width, H = preview.height, img = src.canvas;
			const s = Math.min(W / img.width, H / img.height) * 0.94, ox = (W - img.width * s) / 2, oy = (H - img.height * s) / 2;
			ctx.fillStyle = '#0f151d'; ctx.fillRect(0, 0, W, H);
			ctx.globalAlpha = 0.35; ctx.drawImage(img, ox, oy, img.width * s, img.height * s); ctx.globalAlpha = 1;
			if (!result) return;
			if (result.layers) {
				for (const L of result.layers) {
					ctx.beginPath();
					for (const lp of L.loops) { lp.forEach(([x, y], i) => (i ? ctx.lineTo(ox + x * s, oy + y * s) : ctx.moveTo(ox + x * s, oy + y * s))); ctx.closePath(); }
					ctx.fillStyle = L.color; ctx.fill('evenodd');
					ctx.strokeStyle = '#00000055'; ctx.lineWidth = 0.8; ctx.stroke();
				}
				return;
			}
			// filled the way the sketch will be (outer shapes solid, shapes inside them holes)
			ctx.beginPath();
			for (const lp of result.loops) { lp.forEach(([x, y], i) => (i ? ctx.lineTo(ox + x * s, oy + y * s) : ctx.moveTo(ox + x * s, oy + y * s))); ctx.closePath(); }
			ctx.fillStyle = '#19b8b440'; ctx.fill('evenodd');
			ctx.strokeStyle = '#4fd1ff'; ctx.lineWidth = 1.2; ctx.stroke();
		};
		const size = () => { const r = src.data; return st.sizeBy === 'width' ? [st.width, (st.width * r.height) / r.width] : [(st.width * r.width) / r.height, st.width]; };
		const retrace = () => {
			const minArea = Math.pow(st.speck / 100 * Math.max(src.data.width, src.data.height), 2) + 2;
			if (st.keepColors) {
				const key = src.data.width + 'x' + src.data.height + ':' + st.colors;
				if (!quant || quant.key !== key) { quant = quantizeImage(src.data, st.colors); quant.key = key; }
				const layers = [];
				quant.palette.forEach((color, i) => {
					if (i === quant.background && !st.withBg) return;
					const t = traceImage(src.data, { ink: colorInk(quant, i), threshold: 0.5, smooth: st.smooth, minArea });
					if (t.loops.length) layers.push({ color, ...t });
				});
				result = { layers, loops: layers.flatMap((L) => L.loops), points: layers.reduce((n, L) => n + L.points, 0), dropped: layers.reduce((n, L) => n + L.dropped, 0) };
			} else result = traceImage(src.data, { threshold: st.threshold, invert: st.invert, smooth: st.smooth, minArea });
			thrVal.textContent = `${Math.round(st.threshold * 100)}%`;
			for (const e of bwOnly) e.style.display = st.keepColors ? 'none' : '';
			for (const e of colorOnly) e.style.display = st.keepColors ? '' : 'none';
			const [wmm, hmm] = size();
			info.textContent = result.loops.length
				? (result.layers ? `${result.layers.length} color${result.layers.length > 1 ? 's' : ''} · ` : '') + `${result.loops.length} outline${result.loops.length > 1 ? 's' : ''} · ${result.points} points · ${fmt(wmm, 1)} × ${fmt(hmm, 1)} mm` + (result.dropped ? ` · ${result.dropped} speck${result.dropped > 1 ? 's' : ''} left out` : '') + (result.points > 4000 ? ' — that is a lot of points: try more smoothing or less detail' : '')
				: 'Nothing traced — move the threshold, or try Invert.';
			draw();
		};
		let timer = null;
		const soon = () => { clearTimeout(timer); timer = setTimeout(retrace, 60); };
		thr.addEventListener('input', () => { st.threshold = thr.value / 100; soon(); });
		smooth.addEventListener('input', () => { st.smooth = +smooth.value; soon(); });
		speck.addEventListener('input', () => { st.speck = +speck.value; soon(); });
		inv.addEventListener('change', () => { st.invert = inv.checked; st.threshold = autoThreshold(inkOf(src.data, st.invert)); thr.value = Math.round(st.threshold * 100); retrace(); });
		detail.addEventListener('change', async () => { st.detail = +detail.value; src = await loadPixels(file, st.detail); retrace(); });
		const readSize = () => { const v = evalExpr(sizeIn.value, this.varValues || {}); if (v > 0) st.width = v; st.sizeBy = sizeBy.value; retrace(); };
		sizeIn.addEventListener('change', readSize);
		sizeBy.addEventListener('change', readSize);

		const bwOnly = [el('div', { class: 'row' }, el('span', {}, 'Threshold'), el('div', { class: 'chips' }, thr, thrVal)), el('label', { class: 'check' }, inv, el('span', {}, 'Invert (light shapes on a dark background)'))];
		const colorOnly = [el('label', { class: 'row' }, el('span', {}, 'Colors'), ncol), el('label', { class: 'check' }, bg, el('span', {}, 'Include the background color'))];
		const form = el('div', { class: 'form img-trace' },
			preview,
			info,
			el('label', { class: 'check' }, keep, el('span', {}, 'Keep the image’s colors (one part per color, for multi-color printing)')),
			...bwOnly,
			...colorOnly,
			el('div', { class: 'row' }, el('span', {}, 'Smoothing'), smooth),
			el('div', { class: 'row' }, el('span', {}, 'Leave out specks'), speck),
			el('label', { class: 'row' }, el('span', {}, 'Detail'), detail),
			el('div', { class: 'row' }, el('span', {}, 'Size'), el('div', { class: 'chips' }, sizeBy, sizeIn, el('span', { class: 'muted' }, 'mm'))),
			el('label', { class: 'row' }, el('span', {}, 'Extrude height (mm)'), hIn),
			el('p', { class: 'muted small' }, 'Dark shapes become solid and light areas inside them become holes (Invert swaps that). The result is an editable sketch — double-click it later to adjust points or the height.'));

		this.modal('Import image as a sketch', form, [{ label: 'Cancel' }, {
			label: 'Import', primary: true, action: () => {
				readSize();
				const hh = evalExpr(hIn.value, this.varValues || {});
				if (!(hh > 0)) { toast('Enter an extrude height greater than 0', 'error'); return false; }
				if (!result || !result.loops.length) { toast('Nothing traced yet — adjust the threshold', 'warn'); return false; }
				st.height = hh;
				this.lastImageTrace = { smooth: st.smooth, detail: st.detail, speck: st.speck, width: st.width, height: st.height, sizeBy: st.sizeBy, keepColors: st.keepColors, colors: st.colors, withBg: st.withBg };
				// pixels → mm, centered on the sketch origin, with y pointing up
				const [wmm] = size(), s = wmm / src.data.width, cx = src.data.width / 2, cy = src.data.height / 2;
				if (result.layers) { this.addColorLayers(result.layers, { s, cx, cy, height: hh, base }); return; }
				const sh = { polylines: result.loops.map((lp) => ({ pts: lp.map(([x, y]) => [round((x - cx) * s, 4), round((cy - y) * s, 4)]), closed: true })), circles: [] };
				const m = shapesToModel(sh, { tol: Math.max(1e-4, s * 1e-3), simplifyTol: 0 });
				const regions = profileRegions({ v: 2, ...m });
				const node = makeNode('sketch', modelToParams(m, { mode: 'extrude', height: hh, fillet: 0, anchored: true }), { name: base });
				this.addNode(node);
				toast(`Traced “${base}” — ${regions.length} solid${regions.length === 1 ? '' : 's'}. Double-click it to edit the sketch.`, 'ok', 4000);
			},
		}], 'wide');
		retrace();
	},
};
