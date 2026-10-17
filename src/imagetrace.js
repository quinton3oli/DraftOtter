// Tracing a raster image (PNG / JPG …) into closed outlines for a sketch: marching squares on the image's "ink"
// (dark — or, inverted, light — opaque pixels), with sub-pixel edges, then light smoothing and simplification.

/**
 * How much "ink" each pixel has, 0..1: darkness × opacity (or lightness × opacity when inverted), so a logo on a
 * transparent background traces just the same as one on white.
 */
export function inkOf(img, invert = false) {
	const { width: w, height: h, data } = img;
	const ink = new Float32Array(w * h);
	for (let i = 0, p = 0; i < w * h; i++, p += 4) {
		const lum = (0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2]) / 255, a = data[p + 3] / 255;
		ink[i] = (invert ? lum : 1 - lum) * a;
	}
	return ink;
}

/**
 * Closed outlines (in pixels: x right, y down) where ink crosses `threshold` (0..1). Loops come back as arrays of
 * [x, y]; the image border counts as outside, so shapes touching it still close.
 */
export function contours(ink, w, h, threshold = 0.5) {
	// padded field: one ring of "outside" around the image
	const W = w + 2, H = h + 2;
	const f = new Float32Array(W * H).fill(-threshold);
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) f[(y + 1) * W + x + 1] = ink[y * w + x] - threshold;
	const v = (x, y) => f[y * W + x];
	// a point on the grid edge between two nodes, keyed by that edge so neighboring cells share it
	const pts = new Map();
	const edgePt = (x0, y0, x1, y1) => {
		const k = x0 === x1 ? `v${x0},${Math.min(y0, y1)}` : `h${Math.min(x0, x1)},${y0}`;
		if (!pts.has(k)) {
			const a = v(x0, y0), b = v(x1, y1), t = a / (a - b);
			pts.set(k, [x0 + (x1 - x0) * t - 1, y0 + (y1 - y0) * t - 1]); // back to image pixel coordinates
		}
		return k;
	};
	const links = new Map(); // edge key -> [edge keys it connects to]
	const link = (a, b) => { (links.get(a) || links.set(a, []).get(a)).push(b); (links.get(b) || links.set(b, []).get(b)).push(a); };
	for (let y = 0; y < H - 1; y++) {
		for (let x = 0; x < W - 1; x++) {
			const tl = v(x, y) > 0, tr = v(x + 1, y) > 0, br = v(x + 1, y + 1) > 0, bl = v(x, y + 1) > 0;
			const c = (tl ? 8 : 0) | (tr ? 4 : 0) | (br ? 2 : 0) | (bl ? 1 : 0);
			if (c === 0 || c === 15) continue;
			const T = () => edgePt(x, y, x + 1, y), R = () => edgePt(x + 1, y, x + 1, y + 1), B = () => edgePt(x, y + 1, x + 1, y + 1), L = () => edgePt(x, y, x, y + 1);
			switch (c) {
				case 1: case 14: link(L(), B()); break;
				case 2: case 13: link(B(), R()); break;
				case 3: case 12: link(L(), R()); break;
				case 4: case 11: link(T(), R()); break;
				case 6: case 9: link(T(), B()); break;
				case 7: case 8: link(L(), T()); break;
				case 5: case 10: {
					// saddle: decide by the middle of the cell
					const mid = (v(x, y) + v(x + 1, y) + v(x + 1, y + 1) + v(x, y + 1)) / 4 > 0;
					if ((c === 5) === mid) { link(L(), T()); link(B(), R()); } else { link(L(), B()); link(T(), R()); }
					break;
				}
			}
		}
	}
	// chain the links into loops
	const used = new Set(), loops = [];
	for (const start of links.keys()) {
		if (used.has(start)) continue;
		const loop = [];
		let prev = null, cur = start;
		while (cur && !used.has(cur)) {
			used.add(cur);
			loop.push(pts.get(cur));
			const next = (links.get(cur) || []).find((k) => k !== prev && !used.has(k));
			prev = cur;
			cur = next;
		}
		if (loop.length >= 3) loops.push(loop);
	}
	return loops;
}

export const loopArea = (lp) => { let a = 0; for (let i = 0; i < lp.length; i++) { const p = lp[i], q = lp[(i + 1) % lp.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };

/** Smooth a closed loop (light averaging with neighbors, `passes` times) to take out the pixel stair-steps. */
export function smoothLoop(lp, passes) {
	let a = lp;
	for (let k = 0; k < passes; k++) {
		const n = a.length, b = new Array(n);
		for (let i = 0; i < n; i++) {
			const p = a[(i + n - 1) % n], q = a[i], r = a[(i + 1) % n];
			b[i] = [(p[0] + 2 * q[0] + r[0]) / 4, (p[1] + 2 * q[1] + r[1]) / 4];
		}
		a = b;
	}
	return a;
}

/** Drop points that lie within `tol` of the line through their neighbors (Douglas–Peucker, closed loop). */
export function simplifyLoop(lp, tol) {
	if (lp.length < 5 || !(tol > 0)) return lp;
	const dp = (pts) => {
		const keep = new Uint8Array(pts.length);
		keep[0] = keep[pts.length - 1] = 1;
		const st = [[0, pts.length - 1]];
		while (st.length) {
			const [a, b] = st.pop();
			const [ax, ay] = pts[a], [bx, by] = pts[b], L = Math.hypot(bx - ax, by - ay) || 1e-12;
			let best = -1, bi = -1;
			for (let i = a + 1; i < b; i++) { const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / L; if (d > best) { best = d; bi = i; } }
			if (best > tol) { keep[bi] = 1; st.push([a, bi], [bi, b]); }
		}
		return pts.filter((_, i) => keep[i]);
	};
	// split at the point farthest from the start, simplify both halves
	let k = 0, far = -1;
	for (let i = 1; i < lp.length; i++) { const d = Math.hypot(lp[i][0] - lp[0][0], lp[i][1] - lp[0][1]); if (d > far) { far = d; k = i; } }
	const a = dp(lp.slice(0, k + 1)), b = dp([...lp.slice(k), lp[0]]);
	return [...a, ...b.slice(1, -1)];
}

/**
 * The whole trace: image data → { loops (pixels), points, dropped }. opts: threshold (0..1), invert, smooth (0..10),
 * minArea (pixels², specks smaller than this are dropped), ink (a ready ink field to trace instead of the image's).
 */
export function traceImage(img, { threshold = 0.5, invert = false, smooth = 3, minArea = 9, ink = null } = {}) {
	const raw = contours(ink || inkOf(img, invert), img.width, img.height, threshold);
	let dropped = 0;
	const loops = [];
	for (const lp of raw) {
		if (Math.abs(loopArea(lp)) < minArea) { dropped++; continue; }
		const s = simplifyLoop(smoothLoop(lp, Math.round(smooth)), 0.25 + smooth * 0.12);
		if (s.length >= 3 && Math.abs(loopArea(s)) >= minArea * 0.5) loops.push(s);
	}
	return { loops, points: loops.reduce((n, l) => n + l.length, 0), dropped };
}

/**
 * The image's main colors: k-means on the opaque pixels (k = colors, or found automatically up to 8 when 0), then
 * every pixel labeled with its nearest color and specks smoothed away (3×3 majority). Returns { palette: ['#rrggbb'],
 * labels (Int8Array per pixel, -1 = transparent), counts, background (index of the color filling the border, or -1) }.
 */
export function quantizeImage(img, colors = 0) {
	const { width: w, height: h, data } = img, n = w * h;
	const opaque = [];
	for (let i = 0; i < n; i++) if (data[i * 4 + 3] >= 128) opaque.push(i);
	if (!opaque.length) return { palette: [], labels: new Int8Array(n).fill(-1), counts: [], background: -1 };
	// sample for speed
	const step = Math.max(1, Math.floor(opaque.length / 40000));
	const S = [];
	for (let k = 0; k < opaque.length; k += step) { const p = opaque[k] * 4; S.push([data[p], data[p + 1], data[p + 2]]); }
	const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
	const kmeans = (k) => {
		// k-means++ start, deterministic (farthest point after the mean)
		const C = [S.reduce((m, s) => [m[0] + s[0] / S.length, m[1] + s[1] / S.length, m[2] + s[2] / S.length], [0, 0, 0])];
		const best = new Float64Array(S.length).fill(Infinity);
		while (C.length < k) {
			let far = -1, fi = 0;
			for (let i = 0; i < S.length; i++) { best[i] = Math.min(best[i], d2(S[i], C[C.length - 1])); if (best[i] > far) { far = best[i]; fi = i; } }
			if (far < 1) break;
			C.push(S[fi].slice());
		}
		const lab = new Int32Array(S.length);
		for (let it = 0; it < 16; it++) {
			const sum = C.map(() => [0, 0, 0, 0]);
			for (let i = 0; i < S.length; i++) {
				let bi = 0, bd = Infinity;
				for (let c = 0; c < C.length; c++) { const d = d2(S[i], C[c]); if (d < bd) { bd = d; bi = c; } }
				lab[i] = bi;
				const t = sum[bi]; t[0] += S[i][0]; t[1] += S[i][1]; t[2] += S[i][2]; t[3]++;
			}
			C.forEach((c, j) => { const t = sum[j]; if (t[3]) { c[0] = t[0] / t[3]; c[1] = t[1] / t[3]; c[2] = t[2] / t[3]; } });
		}
		const cnt = C.map(() => 0);
		for (const l of lab) cnt[l]++;
		return C.map((c, j) => ({ c, n: cnt[j] })).filter((x) => x.n > 0);
	};
	let C;
	if (colors > 0) C = kmeans(colors);
	else {
		// auto: start from 8 and merge colors that are close, and drop ones too small to matter (antialiased edges)
		C = kmeans(8);
		const total = S.length;
		let merged = true;
		while (merged && C.length > 1) {
			merged = false;
			let bi = -1, bj = -1, bd = Infinity;
			for (let i = 0; i < C.length; i++) for (let j = i + 1; j < C.length; j++) { const d = d2(C[i].c, C[j].c); if (d < bd) { bd = d; bi = i; bj = j; } }
			const small = C.findIndex((x) => x.n < total * 0.004);
			if (bd < 48 * 48) { const a = C[bi], b = C[bj], t = a.n + b.n; a.c = a.c.map((v, k) => (v * a.n + b.c[k] * b.n) / t); a.n = t; C.splice(bj, 1); merged = true; }
			else if (small >= 0) {
				const s = C[small];
				C.splice(small, 1);
				let ni = 0, nd = Infinity;
				C.forEach((x, k) => { const d = d2(x.c, s.c); if (d < nd) { nd = d; ni = k; } });
				C[ni].n += s.n;
				merged = true;
			}
		}
	}
	const pal = C.map((x) => x.c);
	const labels = new Int8Array(n).fill(-1);
	for (const i of opaque) {
		const p = i * 4, px = [data[p], data[p + 1], data[p + 2]];
		let bi = 0, bd = Infinity;
		for (let c = 0; c < pal.length; c++) { const d = d2(px, pal[c]); if (d < bd) { bd = d; bi = c; } }
		labels[i] = bi;
	}
	// 3×3 majority: lone pixels (antialiasing between two colors) join their neighbors
	const out = labels.slice(), votes = new Int32Array(pal.length);
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
		const i = y * w + x;
		if (labels[i] < 0) continue;
		votes.fill(0);
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
			const xx = x + dx, yy = y + dy;
			if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
			const l = labels[yy * w + xx];
			if (l >= 0) votes[l]++;
		}
		let bl = labels[i];
		for (let c = 0; c < pal.length; c++) if (votes[c] > votes[bl]) bl = c;
		if (votes[bl] >= 5) out[i] = bl;
	}
	const counts = pal.map(() => 0), border = pal.map(() => 0);
	let borderN = 0;
	for (let i = 0; i < n; i++) {
		if (out[i] < 0) continue;
		counts[out[i]]++;
		const x = i % w, y = (i / w) | 0;
		if (x === 0 || y === 0 || x === w - 1 || y === h - 1) { border[out[i]]++; borderN++; }
	}
	let background = -1;
	const perim = 2 * (w + h) - 4;
	if (borderN > perim * 0.6) { const b = border.indexOf(Math.max(...border)); if (border[b] > perim * 0.5) background = b; }
	const hex = (c) => '#' + c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');
	return { palette: pal.map(hex), labels: out, counts, background };
}

/** The ink field of one color of a quantized image (1 where the pixel has that color). */
export function colorInk(q, index) {
	const ink = new Float32Array(q.labels.length);
	for (let i = 0; i < ink.length; i++) ink[i] = q.labels[i] === index ? 1 : 0;
	return ink;
}
