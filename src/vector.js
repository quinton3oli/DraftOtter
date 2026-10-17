// 2D vector files: SVG and DXF import (to sketch geometry) and export (sketches and part sections).
//
// Shapes are { polylines: [{ pts: [[x, y], …], bulges?: [b…], closed }], circles: [{ c: [x, y], r }] } in
// millimeters with Y up. Bulges follow the DXF / sketch convention: tan(sweep / 4), positive = counter-clockwise.
import { segPoints, segInner } from './sketchModel.js';

// ================================================================= tiny XML reader (enough for SVG)

function parseXML(text) {
	const root = { tag: '#root', attrs: {}, children: [] };
	const stack = [root];
	const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[\s\S]*?\?>|<\/\s*([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
	let m;
	while ((m = re.exec(text))) {
		if (m[1]) { // close tag
			while (stack.length > 1 && stack[stack.length - 1].tag !== m[1]) stack.pop();
			if (stack.length > 1) stack.pop();
			continue;
		}
		if (!m[2]) continue;
		const attrs = {};
		for (const a of m[3].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = (a[2] ?? a[3]).replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
		const node = { tag: m[2].replace(/^svg:/, ''), attrs, children: [] };
		stack[stack.length - 1].children.push(node);
		if (!m[4]) stack.push(node);
	}
	return root;
}

// ================================================================= 2D affine (a b c d e f) like SVG matrix()

const I = [1, 0, 0, 1, 0, 0];
const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const apply = (m, [x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const nums = (s) => (String(s || '').match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || []).map(Number);

function parseTransform(s) {
	let m = I;
	for (const t of String(s || '').matchAll(/(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g)) {
		const v = nums(t[2]);
		let n = I;
		if (t[1] === 'matrix' && v.length === 6) n = v;
		if (t[1] === 'translate') n = [1, 0, 0, 1, v[0] || 0, v[1] || 0];
		if (t[1] === 'scale') n = [v[0] ?? 1, 0, 0, v[1] ?? v[0] ?? 1, 0, 0];
		if (t[1] === 'rotate') {
			const a = ((v[0] || 0) * Math.PI) / 180, c = Math.cos(a), s2 = Math.sin(a);
			n = [c, s2, -s2, c, 0, 0];
			if (v.length === 3) n = mul(mul([1, 0, 0, 1, v[1], v[2]], n), [1, 0, 0, 1, -v[1], -v[2]]);
		}
		if (t[1] === 'skewX') n = [1, 0, Math.tan(((v[0] || 0) * Math.PI) / 180), 1, 0, 0];
		if (t[1] === 'skewY') n = [1, Math.tan(((v[0] || 0) * Math.PI) / 180), 0, 1, 0, 0];
		m = mul(m, n);
	}
	return m;
}

// ================================================================= SVG path data

function flattenPath(d, tol = 0.05) {
	const out = [];
	let cur = null, start = [0, 0], p = [0, 0], lastCtrl = null, lastCmd = '';
	const toks = String(d).match(/[a-zA-Z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || [];
	let i = 0, cmd = '';
	const num = () => +toks[i++];
	const segsFor = (len) => Math.max(4, Math.min(64, Math.ceil(len / (tol * 20))));
	const line = (q) => { if (!cur) { cur = { pts: [p.slice()], closed: false }; out.push(cur); } cur.pts.push(q); p = q; };
	while (i < toks.length) {
		if (/[a-zA-Z]/.test(toks[i])) cmd = toks[i++];
		const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase();
		const o = rel ? p : [0, 0];
		if (C === 'Z') {
			if (cur) { cur.closed = true; cur = null; }
			p = start.slice(); lastCtrl = null; lastCmd = 'Z';
			continue;
		}
		if (C === 'M') {
			p = [o[0] + num(), o[1] + num()]; start = p.slice(); cur = { pts: [p.slice()], closed: false }; out.push(cur);
			cmd = rel ? 'l' : 'L'; lastCtrl = null; lastCmd = 'M';
			continue;
		}
		if (C === 'L') line([o[0] + num(), o[1] + num()]);
		else if (C === 'H') line([rel ? p[0] + num() : num(), p[1]]);
		else if (C === 'V') line([p[0], rel ? p[1] + num() : num()]);
		else if (C === 'C' || C === 'S') {
			const c1 = C === 'C' ? [o[0] + num(), o[1] + num()] : lastCtrl && /[CS]/.test(lastCmd) ? [2 * p[0] - lastCtrl[0], 2 * p[1] - lastCtrl[1]] : p.slice();
			const c2 = [o[0] + num(), o[1] + num()], e = [o[0] + num(), o[1] + num()];
			const p0 = p.slice(), n = segsFor(Math.hypot(c1[0] - p0[0], c1[1] - p0[1]) + Math.hypot(c2[0] - c1[0], c2[1] - c1[1]) + Math.hypot(e[0] - c2[0], e[1] - c2[1]));
			for (let k = 1; k <= n; k++) {
				const t = k / n, u = 1 - t;
				line([u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * e[0], u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * e[1]]);
			}
			lastCtrl = c2; lastCmd = C; continue;
		} else if (C === 'Q' || C === 'T') {
			const c = C === 'Q' ? [o[0] + num(), o[1] + num()] : lastCtrl && /[QT]/.test(lastCmd) ? [2 * p[0] - lastCtrl[0], 2 * p[1] - lastCtrl[1]] : p.slice();
			const e = [o[0] + num(), o[1] + num()], p0 = p.slice(), n = segsFor(Math.hypot(c[0] - p0[0], c[1] - p0[1]) + Math.hypot(e[0] - c[0], e[1] - c[1]));
			for (let k = 1; k <= n; k++) { const t = k / n, u = 1 - t; line([u * u * p0[0] + 2 * u * t * c[0] + t * t * e[0], u * u * p0[1] + 2 * u * t * c[1] + t * t * e[1]]); }
			lastCtrl = c; lastCmd = C; continue;
		} else if (C === 'A') {
			let rx = Math.abs(num()), ry = Math.abs(num());
			const phi = (num() * Math.PI) / 180, large = !!num(), sweep = !!num(), e = [o[0] + num(), o[1] + num()];
			const p0 = p.slice();
			if (!rx || !ry) { line(e); } else {
				// endpoint → center parameterization (SVG spec F.6.5)
				const cp = Math.cos(phi), sp = Math.sin(phi), dx = (p0[0] - e[0]) / 2, dy = (p0[1] - e[1]) / 2;
				const x1 = cp * dx + sp * dy, y1 = -sp * dx + cp * dy;
				const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
				if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
				const num2 = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1, den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
				let k = Math.sqrt(Math.max(0, num2 / den));
				if (large === sweep) k = -k;
				const cx1 = (k * rx * y1) / ry, cy1 = (-k * ry * x1) / rx;
				const cx = cp * cx1 - sp * cy1 + (p0[0] + e[0]) / 2, cy = sp * cx1 + cp * cy1 + (p0[1] + e[1]) / 2;
				const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
				const t1 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
				let dt = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
				if (!sweep && dt > 0) dt -= 2 * Math.PI;
				if (sweep && dt < 0) dt += 2 * Math.PI;
				const n = Math.max(4, Math.ceil((Math.abs(dt) * Math.max(rx, ry)) / (tol * 20)));
				for (let s = 1; s <= Math.min(n, 128); s++) {
					const t = t1 + (dt * s) / Math.min(n, 128);
					line(s === Math.min(n, 128) ? e : [cx + rx * Math.cos(t) * cp - ry * Math.sin(t) * sp, cy + rx * Math.cos(t) * sp + ry * Math.sin(t) * cp]);
				}
			}
		} else { i++; continue; }
		lastCtrl = null; lastCmd = C;
	}
	return out.filter((pl) => pl.pts.length >= 2);
}

const UNIT_MM = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6, px: 25.4 / 96, '': 25.4 / 96 };
const lenMM = (s) => { const m = /^\s*([-+]?[\d.]+(?:e[-+]?\d+)?)\s*([a-z%]*)/i.exec(String(s || '')); return m && UNIT_MM[m[2]] !== undefined ? +m[1] * UNIT_MM[m[2]] : null; };

/** SVG text → shapes in mm (Y up). */
export function parseSVG(text) {
	const doc = parseXML(text);
	const svg = (function find(n) { if (n.tag === 'svg') return n; for (const c of n.children) { const f = find(c); if (f) return f; } return null; })(doc);
	if (!svg) throw new Error('Not an SVG file');
	// user units → mm from width/height + viewBox
	const vb = nums(svg.attrs.viewBox);
	const wmm = lenMM(svg.attrs.width), hmm = lenMM(svg.attrs.height);
	let sx = 25.4 / 96, sy = 25.4 / 96, ox = 0, oy = 0;
	if (vb.length === 4) {
		ox = vb[0]; oy = vb[1];
		if (wmm) sx = wmm / vb[2]; else if (hmm) sx = hmm / vb[3];
		if (hmm) sy = hmm / vb[3]; else sy = sx;
		if (!wmm && hmm) sx = sy;
	}
	const top = [sx, 0, 0, -sy, -ox * sx, oy * sy]; // flip Y
	const shapes = { polylines: [], circles: [] };
	const skip = new Set(['defs', 'clipPath', 'mask', 'symbol', 'style', 'title', 'desc', 'metadata', 'pattern', 'marker', 'linearGradient', 'radialGradient', 'text']);
	const hidden = (a) => a.display === 'none' || /display\s*:\s*none/.test(a.style || '') || a.visibility === 'hidden';
	const walk = (n, M) => {
		if (skip.has(n.tag) || hidden(n.attrs)) return;
		const m = n.attrs.transform ? mul(M, parseTransform(n.attrs.transform)) : M;
		const a = n.attrs, f = (k, d = 0) => (a[k] !== undefined ? +nums(a[k])[0] || 0 : d);
		const poly = (pts, closed) => shapes.polylines.push({ pts: pts.map((q) => apply(m, q)), closed });
		const uniform = Math.abs(m[0] * m[3] - m[1] * m[2]) > 0 && Math.abs(Math.hypot(m[0], m[1]) - Math.hypot(m[2], m[3])) < 1e-9 && Math.abs(m[0] * m[2] + m[1] * m[3]) < 1e-9;
		switch (n.tag) {
			case 'path': for (const pl of flattenPath(a.d)) poly(pl.pts, pl.closed); break;
			case 'rect': {
				const x = f('x'), y = f('y'), w = f('width'), h = f('height');
				let rx = Math.min(f('rx', a.ry !== undefined ? f('ry') : 0), w / 2), ry = Math.min(f('ry', rx), h / 2);
				if (w > 0 && h > 0) {
					if (rx > 0 && ry > 0) {
						const k = 0.5523;
						for (const pl of flattenPath(`M${x + rx},${y} H${x + w - rx} C${x + w - rx + k * rx},${y} ${x + w},${y + ry - k * ry} ${x + w},${y + ry} V${y + h - ry} C${x + w},${y + h - ry + k * ry} ${x + w - rx + k * rx},${y + h} ${x + w - rx},${y + h} H${x + rx} C${x + rx - k * rx},${y + h} ${x},${y + h - ry + k * ry} ${x},${y + h - ry} V${y + ry} C${x},${y + ry - k * ry} ${x + rx - k * rx},${y} ${x + rx},${y} Z`)) poly(pl.pts, true);
					} else poly([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], true);
				}
				break;
			}
			case 'circle': case 'ellipse': {
				const cx = f('cx'), cy = f('cy'), rx = n.tag === 'circle' ? f('r') : f('rx'), ry = n.tag === 'circle' ? f('r') : f('ry');
				if (!(rx > 0 && ry > 0)) break;
				if (rx === ry && uniform) { const c = apply(m, [cx, cy]); shapes.circles.push({ c, r: rx * Math.hypot(m[0], m[1]) }); }
				else poly(Array.from({ length: 72 }, (_, k) => [cx + rx * Math.cos((k * Math.PI) / 36), cy + ry * Math.sin((k * Math.PI) / 36)]), true);
				break;
			}
			case 'line': poly([[f('x1'), f('y1')], [f('x2'), f('y2')]], false); break;
			case 'polyline': case 'polygon': {
				const v = nums(a.points), pts = [];
				for (let k = 0; k + 1 < v.length; k += 2) pts.push([v[k], v[k + 1]]);
				if (pts.length >= 2) poly(pts, n.tag === 'polygon');
				break;
			}
			default: break;
		}
		for (const c of n.children) walk(c, m);
	};
	walk(svg, top);
	return shapes;
}

// ================================================================= DXF

const DXF_UNITS = { 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000 };

function bspline(ctrl, degree, knots, n) {
	const p = degree, k = knots && knots.length === ctrl.length + p + 1 ? knots : (() => {
		const kk = [];
		for (let i = 0; i <= p; i++) kk.push(0);
		for (let i = 1; i < ctrl.length - p; i++) kk.push(i);
		for (let i = 0; i <= p; i++) kk.push(ctrl.length - p);
		return kk;
	})();
	const t0 = k[p], t1 = k[k.length - p - 1], out = [];
	for (let s = 0; s <= n; s++) {
		const t = s === n ? t1 - 1e-9 : t0 + ((t1 - t0) * s) / n;
		let span = p;
		while (span < ctrl.length - 1 && t >= k[span + 1]) span++;
		const d = [];
		for (let j = 0; j <= p; j++) d.push(ctrl[Math.min(ctrl.length - 1, Math.max(0, span - p + j))].slice());
		for (let r = 1; r <= p; r++) for (let j = p; j >= r; j--) {
			const i = span - p + j, den = k[i + p - r + 1] - k[i];
			const a = den ? (t - k[i]) / den : 0;
			d[j] = [(1 - a) * d[j - 1][0] + a * d[j][0], (1 - a) * d[j - 1][1] + a * d[j][1]];
		}
		out.push(d[p]);
	}
	return out;
}

/** DXF text → shapes in mm. Supports LINE, LWPOLYLINE, POLYLINE/VERTEX, CIRCLE, ARC, ELLIPSE, SPLINE. */
export function parseDXF(text) {
	const lines = String(text).split(/\r?\n/);
	const pairs = [];
	for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([+lines[i].trim(), lines[i + 1].trim()]);
	let scale = 1;
	const iu = pairs.findIndex(([c, v]) => c === 9 && v === '$INSUNITS');
	if (iu >= 0 && pairs[iu + 1] && DXF_UNITS[+pairs[iu + 1][1]]) scale = DXF_UNITS[+pairs[iu + 1][1]];
	const shapes = { polylines: [], circles: [] };
	const S = (v) => v * scale;
	// entities: split by code 0
	const ents = [];
	let inEnt = false, cur = null;
	for (const [c, v] of pairs) {
		if (c === 0) {
			if (cur) ents.push(cur);
			if (v === 'SECTION' || v === 'ENDSEC' || v === 'EOF') inEnt = false;
			cur = inEnt ? { type: v, g: [] } : null;
			continue;
		}
		if (c === 2 && (v === 'ENTITIES' || v === 'BLOCKS')) { inEnt = v === 'ENTITIES'; continue; }
		if (cur) cur.g.push([c, v]);
	}
	if (cur && inEnt) ents.push(cur);
	const get = (e, code, d = 0) => { const f = e.g.find(([c]) => c === code); return f ? +f[1] : d; };
	const all = (e, code) => e.g.filter(([c]) => c === code).map(([, v]) => +v);
	let poly = null;
	for (const e of ents) {
		if (e.type === 'LINE') shapes.polylines.push({ pts: [[S(get(e, 10)), S(get(e, 20))], [S(get(e, 11)), S(get(e, 21))]], closed: false });
		else if (e.type === 'CIRCLE') shapes.circles.push({ c: [S(get(e, 10)), S(get(e, 20))], r: S(get(e, 40)) });
		else if (e.type === 'ARC') {
			const cx = get(e, 10), cy = get(e, 20), r = get(e, 40);
			const a0 = (get(e, 50) * Math.PI) / 180;
			let a1 = (get(e, 51) * Math.PI) / 180;
			if (a1 <= a0) a1 += 2 * Math.PI;
			const sw = a1 - a0;
			shapes.polylines.push({ pts: [[S(cx + r * Math.cos(a0)), S(cy + r * Math.sin(a0))], [S(cx + r * Math.cos(a1)), S(cy + r * Math.sin(a1))]], bulges: [Math.tan(sw / 4), 0], closed: false });
		} else if (e.type === 'LWPOLYLINE') {
			const pts = [], bulges = [];
			for (const [c, v] of e.g) {
				if (c === 10) { pts.push([S(+v), 0]); bulges.push(0); }
				if (c === 20 && pts.length) pts[pts.length - 1][1] = S(+v);
				if (c === 42 && pts.length) bulges[bulges.length - 1] = +v;
			}
			if (pts.length >= 2) shapes.polylines.push({ pts, bulges, closed: !!(get(e, 70) & 1) });
		} else if (e.type === 'POLYLINE') poly = { pts: [], bulges: [], closed: !!(get(e, 70) & 1) };
		else if (e.type === 'VERTEX' && poly) { poly.pts.push([S(get(e, 10)), S(get(e, 20))]); poly.bulges.push(get(e, 42)); }
		else if (e.type === 'SEQEND' && poly) { if (poly.pts.length >= 2) shapes.polylines.push(poly); poly = null; }
		else if (e.type === 'ELLIPSE') {
			const cx = get(e, 10), cy = get(e, 20), mx = get(e, 11), my = get(e, 21), ratio = get(e, 40, 1);
			let t0 = get(e, 41, 0), t1 = get(e, 42, 2 * Math.PI);
			if (t1 <= t0) t1 += 2 * Math.PI;
			const full = Math.abs(t1 - t0 - 2 * Math.PI) < 1e-6, n = 72, pts = [];
			for (let k = 0; k <= (full ? n - 1 : n); k++) {
				const t = t0 + ((t1 - t0) * k) / n, c = Math.cos(t), s = Math.sin(t);
				pts.push([S(cx + mx * c - my * ratio * s), S(cy + my * c + mx * ratio * s)]);
			}
			shapes.polylines.push({ pts, closed: full });
		} else if (e.type === 'SPLINE') {
			const deg = get(e, 71, 3), knots = all(e, 40);
			const cx = all(e, 10), cy = all(e, 20), fx = all(e, 11), fy = all(e, 21);
			let pts;
			if (cx.length >= deg + 1) pts = bspline(cx.map((x, k) => [x, cy[k]]), deg, knots, Math.max(16, cx.length * 8));
			else pts = fx.map((x, k) => [x, fy[k]]);
			if (pts.length >= 2) shapes.polylines.push({ pts: pts.map(([x, y]) => [S(x), S(y)]), closed: !!(get(e, 70) & 1) });
		}
	}
	return shapes;
}

// ================================================================= shapes → sketch model

function simplify(pts, tol) {
	if (pts.length < 3 || !(tol > 0)) return pts;
	const keep = new Uint8Array(pts.length);
	keep[0] = keep[pts.length - 1] = 1;
	const st = [[0, pts.length - 1]];
	while (st.length) {
		const [a, b] = st.pop();
		let best = -1, bi = -1;
		const [ax, ay] = pts[a], [bx, by] = pts[b], L = Math.hypot(bx - ax, by - ay) || 1e-12;
		for (let i = a + 1; i < b; i++) {
			const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / L;
			if (d > best) { best = d; bi = i; }
		}
		if (best > tol) { keep[bi] = 1; st.push([a, bi], [bi, b]); }
	}
	return pts.filter((_, i) => keep[i]);
}

// A closed loop is split at the point farthest from its start, and both halves simplified.
function simplifyClosed(pts, tol) {
	if (pts.length < 4) return pts;
	let k = 0, d = -1;
	for (let i = 1; i < pts.length; i++) { const e = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]); if (e > d) { d = e; k = i; } }
	const a = simplify(pts.slice(0, k + 1), tol), b = simplify([...pts.slice(k), pts[0]], tol);
	return [...a, ...b.slice(1, -1)];
}

/** Bounding box of shapes. */
export function shapesBox(sh) {
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	const add = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
	for (const p of sh.polylines) for (const [x, y] of p.pts) add(x, y);
	for (const c of sh.circles) { add(c.c[0] - c.r, c.c[1] - c.r); add(c.c[0] + c.r, c.c[1] + c.r); }
	return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

/** Scale and move shapes (in place) by s about the origin, then by (dx, dy). */
export function transformShapes(sh, s, dx, dy) {
	for (const p of sh.polylines) p.pts = p.pts.map(([x, y]) => [x * s + dx, y * s + dy]);
	for (const c of sh.circles) { c.c = [c.c[0] * s + dx, c.c[1] * s + dy]; c.r *= s; }
	return sh;
}

/**
 * Shapes → sketch model { points, segs, circles, cons: [], radii: {} }. Endpoints closer than `tol` are merged,
 * so separately drawn lines that meet form closed loops. Flattened curves are simplified to `simplifyTol`.
 */
export function shapesToModel(sh, { tol = 1e-3, simplifyTol = 0.01 } = {}) {
	const m = { points: [], segs: [], circles: [], cons: [], radii: {} };
	const grid = new Map(), cell = Math.max(tol * 4, 1e-6);
	const key = (x, y) => Math.round(x / cell) + ',' + Math.round(y / cell);
	const pid = ([x, y]) => {
		const kx = Math.round(x / cell), ky = Math.round(y / cell);
		for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
			for (const id of grid.get((kx + i) + ',' + (ky + j)) || []) if (Math.hypot(m.points[id][0] - x, m.points[id][1] - y) <= tol) return id;
		}
		const id = m.points.length;
		m.points.push([x, y]);
		const k = key(x, y);
		if (!grid.has(k)) grid.set(k, []);
		grid.get(k).push(id);
		return id;
	};
	for (const pl of sh.polylines) {
		const hasBulge = pl.bulges && pl.bulges.some((b) => b);
		let pts = pl.pts, bulges = pl.bulges;
		if (!hasBulge) { pts = pl.closed ? simplifyClosed(pl.pts, simplifyTol) : simplify(pl.pts, simplifyTol); bulges = null; }
		// a closed polyline whose last point repeats the first
		if (pl.closed && pts.length > 2 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) <= tol) { pts = pts.slice(0, -1); if (bulges) bulges = bulges.slice(0, -1); }
		const ids = pts.map(pid);
		const n = ids.length, count = pl.closed ? n : n - 1;
		for (let i = 0; i < count; i++) {
			const a = ids[i], b = ids[(i + 1) % n];
			if (a === b) continue;
			const s = { a, b };
			if (bulges && bulges[i]) s.arc = bulges[i];
			m.segs.push(s);
		}
	}
	for (const c of sh.circles) if (c.r > 0) m.circles.push({ c: pid(c.c), r: c.r });
	return m;
}

// ================================================================= export

const f6 = (v) => (Math.round(v * 1e6) / 1e6).toString();

/** DXF (R12, mm) from shapes: LINE / ARC / CIRCLE entities, closed polylines as POLYLINE. */
export function shapesToDXF(sh, { layer = '0' } = {}) {
	const o = ['0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1009', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES'];
	for (const pl of sh.polylines) {
		const bul = pl.bulges || [];
		if (pl.closed || pl.pts.length > 2) {
			o.push('0', 'POLYLINE', '8', layer, '66', '1', '70', pl.closed ? '1' : '0', '10', '0', '20', '0', '30', '0');
			pl.pts.forEach(([x, y], i) => { o.push('0', 'VERTEX', '8', layer, '10', f6(x), '20', f6(y), '30', '0'); if (bul[i]) o.push('42', f6(bul[i])); });
			o.push('0', 'SEQEND', '8', layer);
		} else if (bul[0]) {
			// single arc
			const [A, B] = pl.pts, sw = 4 * Math.atan(bul[0]);
			const dx = B[0] - A[0], dy = B[1] - A[1], c = Math.hypot(dx, dy), r = c / 2 / Math.sin(Math.abs(sw) / 2);
			const mid = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2], h = Math.sqrt(Math.max(0, r * r - (c / 2) ** 2)) * Math.sign(bul[0]) * (Math.abs(sw) > Math.PI ? -1 : 1);
			const C = [mid[0] - (dy / c) * h, mid[1] + (dx / c) * h];
			let a0 = Math.atan2(A[1] - C[1], A[0] - C[0]), a1 = Math.atan2(B[1] - C[1], B[0] - C[0]);
			if (sw < 0) [a0, a1] = [a1, a0];
			o.push('0', 'ARC', '8', layer, '10', f6(C[0]), '20', f6(C[1]), '30', '0', '40', f6(r), '50', f6((a0 * 180) / Math.PI), '51', f6((a1 * 180) / Math.PI));
		} else {
			const [[x1, y1], [x2, y2]] = pl.pts;
			o.push('0', 'LINE', '8', layer, '10', f6(x1), '20', f6(y1), '30', '0', '11', f6(x2), '21', f6(y2), '31', '0');
		}
	}
	for (const c of sh.circles) o.push('0', 'CIRCLE', '8', layer, '10', f6(c.c[0]), '20', f6(c.c[1]), '30', '0', '40', f6(c.r));
	o.push('0', 'ENDSEC', '0', 'EOF');
	return o.join('\n') + '\n';
}

/** SVG (mm units, Y flipped back to down) from shapes. Closed loops are filled even-odd as one path. */
export function shapesToSVG(sh, { stroke = '#000', fill = 'none', margin = 2 } = {}) {
	const b = shapesBox(sh);
	const W = b.w + 2 * margin, H = b.h + 2 * margin;
	const X = (x) => f6(x - b.x0 + margin), Y = (y) => f6(b.y1 - y + margin);
	const d = [];
	for (const pl of sh.polylines) {
		const pts = pl.bulges && pl.bulges.some((v) => v) ? expandBulges(pl) : pl.pts;
		d.push('M' + pts.map(([x, y]) => X(x) + ' ' + Y(y)).join(' L') + (pl.closed ? ' Z' : ''));
	}
	for (const c of sh.circles) d.push(`M${X(c.c[0] - c.r)} ${Y(c.c[1])} a${f6(c.r)} ${f6(c.r)} 0 1 0 ${f6(2 * c.r)} 0 a${f6(c.r)} ${f6(c.r)} 0 1 0 ${f6(-2 * c.r)} 0 Z`);
	return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${f6(W)}mm" height="${f6(H)}mm" viewBox="0 0 ${f6(W)} ${f6(H)}">
<path d="${d.join(' ')}" fill="${fill}" fill-rule="evenodd" stroke="${stroke}" stroke-width="0.1"/>
</svg>
`;
}

function expandBulges(pl) {
	const out = [];
	const n = pl.pts.length, count = pl.closed ? n : n - 1;
	out.push(pl.pts[0]);
	for (let i = 0; i < count; i++) {
		const A = pl.pts[i], B = pl.pts[(i + 1) % n];
		for (const q of segPoints(A, B, (pl.bulges || [])[i] || 0)) out.push(q);
	}
	if (pl.closed) out.pop();
	return out;
}

/** Sketch model → shapes (non-construction geometry; arcs kept as bulges). */
export function modelToShapes(m) {
	const sh = { polylines: [], circles: [] };
	for (const s of m.segs) {
		if (s.cons || !m.points[s.a] || !m.points[s.b]) continue;
		if (s.spl) { sh.polylines.push({ pts: [m.points[s.a].slice(), ...segInner(m, s, true)], closed: false }); continue; }
		sh.polylines.push({ pts: [m.points[s.a].slice(), m.points[s.b].slice()], bulges: [s.arc || 0, 0], closed: false });
	}
	for (const c of m.circles) if (!c.cons && m.points[c.c]) sh.circles.push({ c: m.points[c.c].slice(), r: c.r });
	return sh;
}
