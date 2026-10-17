// Image → relief or lithophane: brightness becomes thickness. A closed, watertight solid (top surface from the
// image, flat bottom, side walls), optionally with a raised frame. Lithophanes: darker = thicker, so light shining
// through shows the picture. Reliefs: light (or dark) parts stand up, for plaques and embossed pictures.
import { makeNode } from './model.js';
import { storeBody } from './stepimport.js';
import { round, fmt, evalExpr, toast, el, pickFile } from './util.js';

/**
 * Heights on a grid (row 0 = top of the image) from image pixels. mode: 'litho' (dark thick), 'light' (light high),
 * 'dark' (dark high). Transparent pixels count as the background (white for lithophanes and light reliefs).
 */
export function heightGrid(img, nx, ny, { mode = 'litho', minT = 0.8, maxT = 3, smooth = 1, frame = 0, cell = 1 } = {}) {
	const { width: w, height: h, data } = img;
	// brightness at a grid point, box-sampled from the image
	const lum = new Float32Array(nx * ny);
	for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
		const x0 = Math.floor((i / nx) * w), x1 = Math.max(x0 + 1, Math.floor(((i + 1) / nx) * w));
		const y0 = Math.floor((j / ny) * h), y1 = Math.max(y0 + 1, Math.floor(((j + 1) / ny) * h));
		let s = 0, n = 0;
		for (let y = y0; y < Math.min(h, y1); y++) for (let x = x0; x < Math.min(w, x1); x++) {
			const p = (y * w + x) * 4, a = data[p + 3] / 255;
			const l = (0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2]) / 255;
			s += l * a + (1 - a); n++; // transparent counts as a white background
		}
		lum[j * nx + i] = n ? s / n : 1;
	}
	// light blur to soften pixel noise
	let v = lum;
	for (let k = 0; k < smooth; k++) {
		const b = new Float32Array(nx * ny);
		for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
			let s = 0, n = 0;
			for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const ii = i + di, jj = j + dj; if (ii >= 0 && jj >= 0 && ii < nx && jj < ny) { const wgt = di === 0 && dj === 0 ? 4 : di === 0 || dj === 0 ? 2 : 1; s += v[jj * nx + ii] * wgt; n += wgt; } }
			b[j * nx + i] = s / n;
		}
		v = b;
	}
	const t = new Float32Array(nx * ny);
	const fr = Math.round(frame / cell);
	for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
		const l = v[j * nx + i];
		const k = mode === 'light' ? l : 1 - l; // 0..1, how much of the way from thin to thick
		let z = minT + (maxT - minT) * k;
		if (fr > 0 && (i < fr || j < fr || i >= nx - fr || j >= ny - fr)) z = maxT; // frame
		t[j * nx + i] = z;
	}
	return t;
}

/**
 * Closed solid from a height grid: nx × ny points spaced `cell` mm apart, centered on the origin, bottom at z = 0,
 * image top at +y. Returns non-indexed triangle positions.
 */
export function reliefSolid(t, nx, ny, cell) {
	const tris = [];
	const X = (i) => (i - (nx - 1) / 2) * cell, Y = (j) => ((ny - 1) / 2 - j) * cell;
	const top = (i, j) => [X(i), Y(j), t[j * nx + i]], bot = (i, j) => [X(i), Y(j), 0];
	const tri = (a, b, c) => tris.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
	for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
		// top surface, facing up (+z): with y decreasing downward rows, this winding is counter-clockwise from above
		const a = top(i, j), b = top(i + 1, j), c = top(i + 1, j + 1), d = top(i, j + 1);
		tri(a, d, c); tri(a, c, b);
		// flat bottom, facing down
		const A = bot(i, j), B = bot(i + 1, j), C = bot(i + 1, j + 1), D = bot(i, j + 1);
		tri(A, C, D); tri(A, B, C);
	}
	// side walls along the four edges (outward facing)
	for (let i = 0; i < nx - 1; i++) {
		tri(top(i, 0), top(i + 1, 0), bot(i + 1, 0)); tri(top(i, 0), bot(i + 1, 0), bot(i, 0)); // back (top row, +y)
		const j = ny - 1;
		tri(top(i, j), bot(i + 1, j), top(i + 1, j)); tri(top(i, j), bot(i, j), bot(i + 1, j)); // front (−y)
	}
	for (let j = 0; j < ny - 1; j++) {
		tri(top(0, j), bot(0, j + 1), top(0, j + 1)); tri(top(0, j), bot(0, j), bot(0, j + 1)); // left (−x)
		const i = nx - 1;
		tri(top(i, j), top(i, j + 1), bot(i, j + 1)); tri(top(i, j), bot(i, j + 1), bot(i, j)); // right (+x)
	}
	return new Float32Array(tris);
}

async function loadImage(file) {
	const url = URL.createObjectURL(file);
	try {
		const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('not an image this browser can read')); i.src = url; });
		const s = Math.min(1, 1200 / Math.max(img.naturalWidth, img.naturalHeight));
		const c = document.createElement('canvas');
		c.width = Math.max(1, Math.round(img.naturalWidth * s)); c.height = Math.max(1, Math.round(img.naturalHeight * s));
		const ctx = c.getContext('2d', { willReadFrequently: true });
		ctx.drawImage(img, 0, 0, c.width, c.height);
		return { data: ctx.getImageData(0, 0, c.width, c.height), canvas: c };
	} finally { URL.revokeObjectURL(url); }
}

export const ReliefMixin = {
	async importRelief(file) {
		if (!file) { const files = await pickFile('.png,.jpg,.jpeg,.webp,.gif,.bmp', false); file = files && files[0]; }
		if (!file) return;
		let src;
		try { src = await loadImage(file); } catch (e) { toast('Could not read that image: ' + e.message, 'error', 5000); return; }
		const base = file.name.replace(/\.[^.]+$/, '') || 'Relief';
		const last = this.lastRelief || {};
		const st = { mode: last.mode || 'litho', width: last.width ?? 100, minT: last.minT ?? 0.8, maxT: last.maxT ?? 3, detail: last.detail ?? 200, smooth: last.smooth ?? 1, frame: last.frame ?? 3 };
		const preview = el('canvas', { class: 'img-trace-preview', width: 460, height: 300 });
		const info = el('p', { class: 'muted small', id: 'rl-info' });
		const sel = (id, opts, v) => { const s = el('select', { id }, ...opts.map(([val, l]) => el('option', { value: val }, l))); s.value = String(v); return s; };
		const inp = (id, v) => { const i = el('input', { id, type: 'text', value: v, style: 'width:80px' }); i.addEventListener('keydown', (e) => e.stopPropagation()); return i; };
		const mode = sel('rl-mode', [['litho', 'Lithophane — darker is thicker (shine light through it)'], ['light', 'Relief — light parts stand up'], ['dark', 'Relief — dark parts stand up']], st.mode);
		const widthIn = inp('rl-w', st.width), minIn = inp('rl-min', st.minT), maxIn = inp('rl-max', st.maxT), frameIn = inp('rl-frame', st.frame);
		const detail = sel('rl-detail', [[100, 'Low'], [200, 'Medium'], [300, 'High'], [450, 'Very high']], st.detail);
		const smooth = el('input', { id: 'rl-smooth', type: 'range', min: 0, max: 4, step: 1, value: st.smooth, style: 'width:160px' });

		const grid = () => {
			const nx = Math.max(2, Math.round(st.detail)), ny = Math.max(2, Math.round((st.detail * src.data.height) / src.data.width));
			const cell = st.width / (nx - 1);
			return { nx, ny, cell };
		};
		const draw = () => {
			const { nx, ny, cell } = grid();
			const t = heightGrid(src.data, nx, ny, { mode: st.mode, minT: st.minT, maxT: st.maxT, smooth: st.smooth, frame: st.frame, cell });
			// preview: thickness as shading (lithophanes look like the picture when lit from behind)
			const ctx = preview.getContext('2d'), W = preview.width, H = preview.height;
			const im = ctx.createImageData(nx, ny);
			for (let k = 0; k < nx * ny; k++) {
				const f = (t[k] - st.minT) / (st.maxT - st.minT || 1);
				const g = st.mode === 'litho' ? 255 * (1 - f) * 0.92 + 10 : 40 + 200 * f; // backlit look vs raised look
				im.data[4 * k] = g; im.data[4 * k + 1] = g * 0.96; im.data[4 * k + 2] = g * 0.88; im.data[4 * k + 3] = 255;
			}
			const tmp = document.createElement('canvas'); tmp.width = nx; tmp.height = ny; tmp.getContext('2d').putImageData(im, 0, 0);
			const s = Math.min(W / nx, H / ny) * 0.94;
			ctx.fillStyle = '#0f151d'; ctx.fillRect(0, 0, W, H);
			ctx.imageSmoothingEnabled = true;
			ctx.drawImage(tmp, (W - nx * s) / 2, (H - ny * s) / 2, nx * s, ny * s);
			const tris = (nx - 1) * (ny - 1) * 4 + (nx + ny) * 4;
			info.textContent = `${fmt(st.width, 1)} × ${fmt((ny - 1) * cell, 1)} mm · ${fmt(st.minT, 2)}–${fmt(st.maxT, 2)} mm thick · ${tris.toLocaleString()} triangles · ${fmt(cell, 2)} mm detail`;
		};
		const read = () => {
			const v = (i, def) => { const x = evalExpr(i.value, this.varValues || {}); return isFinite(x) ? x : def; };
			st.mode = mode.value; st.width = Math.max(1, v(widthIn, st.width)); st.minT = Math.max(0.1, v(minIn, st.minT)); st.maxT = Math.max(st.minT + 0.1, v(maxIn, st.maxT));
			st.frame = Math.max(0, v(frameIn, st.frame)); st.detail = +detail.value; st.smooth = +smooth.value;
			draw();
		};
		for (const i of [widthIn, minIn, maxIn, frameIn]) i.addEventListener('change', read);
		for (const s of [mode, detail]) s.addEventListener('change', () => {
			if (s === mode && mode.value !== 'litho' && st.mode === 'litho') { minIn.value = 1.5; maxIn.value = 4; frameIn.value = 0; }
			if (s === mode && mode.value === 'litho' && st.mode !== 'litho') { minIn.value = 0.8; maxIn.value = 3; frameIn.value = 3; }
			read();
		});
		smooth.addEventListener('input', read);

		const form = el('div', { class: 'form' },
			preview, info,
			el('label', { class: 'row' }, el('span', {}, 'Type'), mode),
			el('label', { class: 'row' }, el('span', {}, 'Width (mm)'), widthIn),
			el('div', { class: 'row' }, el('span', {}, 'Thickness (mm)'), el('div', { class: 'chips' }, el('span', { class: 'muted' }, 'thinnest'), minIn, el('span', { class: 'muted' }, 'thickest'), maxIn)),
			el('label', { class: 'row' }, el('span', {}, 'Frame (mm, 0 = none)'), frameIn),
			el('label', { class: 'row' }, el('span', {}, 'Detail'), detail),
			el('div', { class: 'row' }, el('span', {}, 'Smoothing'), smooth),
			el('p', { class: 'muted small' }, 'Lithophanes print best standing upright, 100% infill, in white or natural filament, with a fine layer height. The result is a solid mesh part: place it, scale it, or join it with a stand.'));
		this.modal('Image → relief / lithophane', form, [{ label: 'Cancel' }, {
			label: 'Create', primary: true, action: () => {
				read();
				const { nx, ny, cell } = grid();
				const t = heightGrid(src.data, nx, ny, { mode: st.mode, minT: st.minT, maxT: st.maxT, smooth: st.smooth, frame: st.frame, cell });
				const positions = reliefSolid(t, nx, ny, cell);
				this.lastRelief = { ...st };
				const node = makeNode('mesh', { blob: storeBody(this.model, positions) }, { name: `${base} ${st.mode === 'litho' ? 'lithophane' : 'relief'}`, ...(st.mode === 'litho' ? { color: '#f2efe6' } : {}) });
				this.addNode(node);
				toast(`Created ${node.name} — ${fmt(st.width, 1)} × ${fmt((ny - 1) * cell, 1)} mm`, 'ok', 4000);
			},
		}], 'wide');
		draw();
	},
};
