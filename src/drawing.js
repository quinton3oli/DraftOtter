// 2D technical drawings: orthographic views (third-angle: top above front, right side to the right) and an
// optional isometric view, with visible / hidden lines, overall dimensions, hole diameters and a title block.
// Output: SVG (mm), DXF, or print to PDF.
import * as THREE from 'three';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';
import { fitCircle2 } from './measureGeo.js';
import { extractEdges } from './edges.js';
import { sectionAt, clipHalf } from './engine.js';
import { fmt, toast, el, download } from './util.js';

// ================================================================= projection & line extraction

export const VIEWS = {
	front: { label: 'FRONT', dir: [0, 1, 0], right: [1, 0, 0], up: [0, 0, 1] },
	top: { label: 'TOP', dir: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0] },
	right: { label: 'RIGHT', dir: [-1, 0, 0], right: [0, 1, 0], up: [0, 0, 1] },
	iso: { label: 'ISOMETRIC', dir: [-1, 1, -1], right: null, up: null },
};

function viewBasis(v) {
	const d = new THREE.Vector3(...v.dir).normalize();
	if (v.right) return { d, r: new THREE.Vector3(...v.right), u: new THREE.Vector3(...v.up) };
	const r = new THREE.Vector3().crossVectors(d, new THREE.Vector3(0, 0, 1)).normalize();
	return { d, r, u: new THREE.Vector3().crossVectors(r, d).normalize() };
}

/** Weld a non-indexed mesh and list each edge with its two face normals. */
function edgeList(geom) {
	const p = geom.attributes.position.array, map = new Map(), V = [], F = [];
	const vid = (i) => {
		const k = Math.round(p[i] * 1e4) + ',' + Math.round(p[i + 1] * 1e4) + ',' + Math.round(p[i + 2] * 1e4);
		let id = map.get(k);
		if (id === undefined) { id = V.length; V.push(new THREE.Vector3(p[i], p[i + 1], p[i + 2])); map.set(k, id); }
		return id;
	};
	const edges = new Map();
	for (let i = 0; i < p.length; i += 9) {
		const a = vid(i), b = vid(i + 3), c = vid(i + 6);
		if (a === b || b === c || a === c) continue;
		const n = V[b].clone().sub(V[a]).cross(V[c].clone().sub(V[a]));
		if (n.lengthSq() < 1e-16) continue;
		n.normalize();
		const f = F.length;
		F.push(n);
		for (const [x, y] of [[a, b], [b, c], [c, a]]) {
			const k = x < y ? x + '_' + y : y + '_' + x;
			if (!edges.has(k)) edges.set(k, { a: Math.min(x, y), b: Math.max(x, y), f: [] });
			edges.get(k).f.push(f);
		}
	}
	return { V, F, edges: [...edges.values()] };
}

/**
 * Lines of one view: [{ a: [x, y], b: [x, y], hidden }] in view coordinates (mm), plus circles seen face-on.
 * crease: dihedral angle (°) above which an edge is drawn; silhouettes are always drawn.
 */
export function viewLines(geom, viewKey, { crease = 30, hidden = true, bvhMesh = null } = {}) {
	const { d, r, u } = viewBasis(VIEWS[viewKey]);
	const { V, F, edges } = geom.__edges || (geom.__edges = edgeList(geom));
	const cosC = Math.cos((crease * Math.PI) / 180);
	const toViewer = d.clone().negate();
	let mesh = bvhMesh;
	if (hidden && !mesh) {
		const g = new THREE.BufferGeometry();
		g.setAttribute('position', geom.attributes.position);
		g.boundsTree = new MeshBVH(g);
		mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
		mesh.raycast = acceleratedRaycast;
	}
	const rc = new THREE.Raycaster();
	rc.firstHitOnly = true;
	const proj = (P) => [P.dot(r), P.dot(u)];
	const isHidden = (P) => {
		if (!hidden) return false;
		rc.set(P.clone().addScaledVector(toViewer, 1e-3), toViewer);
		rc.far = Infinity;
		const h = rc.intersectObject(mesh, false)[0];
		return !!h && h.distance > 2e-3;
	};
	const out = [];
	let size = 0;
	for (const v of V) size = Math.max(size, Math.abs(v.x), Math.abs(v.y), Math.abs(v.z));
	const step = Math.max(0.2, size / 120);
	for (const e of edges) {
		let draw = false;
		if (e.f.length !== 2) draw = true;
		else {
			const [n1, n2] = [F[e.f[0]], F[e.f[1]]];
			if (n1.dot(n2) < cosC) draw = true;
			else if ((n1.dot(d) < 0) !== (n2.dot(d) < 0)) draw = true; // silhouette
		}
		if (!draw) continue;
		const A = V[e.a], B = V[e.b];
		const pa = proj(A), pb = proj(B);
		if (Math.hypot(pa[0] - pb[0], pa[1] - pb[1]) < 1e-4) continue; // edge seen end-on
		// split into visible / hidden runs by sampling
		const n = Math.max(2, Math.min(40, Math.ceil(A.distanceTo(B) / step)));
		let runStart = 0, runHidden = null;
		const at = (t) => A.clone().lerp(B, t);
		for (let i = 0; i <= n; i++) {
			const t = i / n;
			const h = isHidden(at(Math.min(0.999, Math.max(0.001, t))));
			if (runHidden === null) runHidden = h;
			if (h !== runHidden || i === n) {
				const t1 = i === n && h === runHidden ? 1 : (i - 0.5) / n;
				out.push({ a: proj(at(runStart)), b: proj(at(t1)), hidden: runHidden });
				runStart = t1; runHidden = h;
			}
		}
	}
	return { lines: mergeCollinear(out), mesh };
}

/** Join consecutive collinear pieces (tessellated straight edges) to keep files small. */
function mergeCollinear(lines) {
	const groups = new Map();
	for (const l of lines) {
		const dx = l.b[0] - l.a[0], dy = l.b[1] - l.a[1], L = Math.hypot(dx, dy);
		if (L < 1e-6) continue;
		let ang = Math.atan2(dy, dx);
		if (ang < 0) ang += Math.PI;
		if (ang >= Math.PI - 1e-9) ang = 0;
		const nx = -Math.sin(ang), ny = Math.cos(ang), off = l.a[0] * nx + l.a[1] * ny;
		const k = `${l.hidden ? 'h' : 'v'}|${Math.round(ang * 1e4)}|${Math.round(off * 1e3)}`;
		if (!groups.has(k)) groups.set(k, { ang, items: [] });
		const tx = Math.cos(ang), ty = Math.sin(ang);
		let s0 = l.a[0] * tx + l.a[1] * ty, s1 = l.b[0] * tx + l.b[1] * ty;
		if (s0 > s1) [s0, s1] = [s1, s0];
		groups.get(k).items.push({ s0, s1, l, nx, ny, off, tx, ty });
	}
	const out = [];
	for (const g of groups.values()) {
		g.items.sort((x, y) => x.s0 - y.s0);
		let cur = null;
		for (const it of g.items) {
			if (cur && it.s0 <= cur.s1 + 1e-4) cur.s1 = Math.max(cur.s1, it.s1);
			else { if (cur) out.push(cur); cur = { ...it }; }
		}
		if (cur) out.push(cur);
	}
	return out.map((c) => ({ a: [c.s0 * c.tx + c.off * c.nx, c.s0 * c.ty + c.off * c.ny], b: [c.s1 * c.tx + c.off * c.nx, c.s1 * c.ty + c.off * c.ny], hidden: c.l.hidden }));
}

/** Circles seen face-on in a view: closed feature-edge loops perpendicular to the view that fit a circle. */
export function viewCircles(chains, viewKey) {
	const { d, r, u } = viewBasis(VIEWS[viewKey]);
	const out = [];
	for (const ch of chains) {
		if (!ch.closed || ch.pts.length < 8) continue;
		const P = ch.pts.map((q) => new THREE.Vector3(...q));
		const depth = P.map((q) => q.dot(d));
		if (Math.max(...depth) - Math.min(...depth) > 1e-3) continue; // not perpendicular to the view
		const pts2 = P.map((q) => [q.dot(r), q.dot(u)]);
		const f = fitCircle2(pts2);
		if (!f || f.rms > Math.max(1e-3, f.r * 0.01)) continue;
		if (out.some((c) => Math.hypot(c.c[0] - f.cx, c.c[1] - f.cy) < 1e-3 && Math.abs(c.r - f.r) < 1e-3)) continue;
		out.push({ c: [f.cx, f.cy], r: f.r });
	}
	return out;
}

// ================================================================= sheet layout & rendering

export const SHEETS = { letter: { label: 'Letter 11 × 8.5 in', w: 279.4, h: 215.9 }, tabloid: { label: 'Tabloid 17 × 11 in', w: 431.8, h: 279.4 }, a4: { label: 'A4', w: 297, h: 210 }, a3: { label: 'A3', w: 420, h: 297 } };
const SCALES = [10, 5, 4, 2, 1, 0.5, 0.25, 0.2, 0.1, 0.05, 0.02, 0.01];
const scaleLabel = (s) => (s >= 1 ? `${s}:1` : `1:${Math.round(1 / s)}`);

/**
 * Build the drawing as primitives: { w, h, scale, place, items: [ { t: 'line', a, b, style } | { t: 'circle', c, r, style } |
 * { t: 'text', p, s, size, anchor, bold, dim? } ] }.
 * views: { front, top, right, iso?, section? } each { lines, circles, box: [minX, minY, maxX, maxY], hatch? } in model mm.
 * Layout (third-angle): column 1 front with top above, column 2 right with the isometric above, column 3 section A–A
 * with detail views above. opts.dims: user dimensions [{ view, a, b }]; opts.details: [{ view, c, r, k }].
 */
export function layoutDrawing(views, { sheet = 'letter', scale = 'auto', title = 'Part', date = new Date(), dims = [], details = [], pending = null } = {}) {
	const S = SHEETS[sheet] || SHEETS.letter, m = 10, tbH = 24;
	const items = [];
	const L = (a, b, style = 'thin', extra) => items.push({ t: 'line', a, b, style, ...extra });
	const T = (p, s, size = 3.2, anchor = 'middle', bold = false, extra) => items.push({ t: 'text', p, s, size, anchor, bold, ...extra });
	// border & title block
	L([m, m], [S.w - m, m], 'border'); L([S.w - m, m], [S.w - m, S.h - m], 'border'); L([S.w - m, S.h - m], [m, S.h - m], 'border'); L([m, S.h - m], [m, m], 'border');
	const tbW = 120, tx = S.w - m - tbW, ty = m;
	L([tx, ty + tbH], [S.w - m, ty + tbH], 'border'); L([tx, ty], [tx, ty + tbH], 'border');
	L([tx, ty + tbH / 2], [S.w - m, ty + tbH / 2], 'thin'); L([tx + 70, ty], [tx + 70, ty + tbH / 2], 'thin');
	const sz = (k) => { const b = views[k] && views[k].box; return b && isFinite(b[0]) ? [b[2] - b[0], b[3] - b[1]] : [0, 0]; };
	const [fw, fh] = sz('front'), [, th] = sz('top'), [rw, rh] = sz('right'), [sw, sh] = sz('section');
	const gap = 24; // room for dimensions between views
	const hasSec = !!views.section, hasCol3 = hasSec || details.length > 0;
	const colW = [fw, rw, hasCol3 ? Math.max(sw, ...details.map((d) => 2 * d.r * d.k)) : 0];
	const row0 = Math.max(fh, rh, sh), row1 = Math.max(th, ...details.map((d) => 2 * d.r * d.k), 0);
	const ncol = hasCol3 ? 3 : 2;
	const availW = S.w - 2 * m - (ncol + 1) * gap, availH = S.h - 2 * m - tbH - 3 * gap;
	let sc = scale;
	if (scale === 'auto') sc = SCALES.find((s) => (colW[0] + colW[1] + colW[2]) * s <= availW && (row0 + row1) * s <= availH) || SCALES[SCALES.length - 1];
	T([tx + tbW / 2, ty + tbH * 0.68], title, 5, 'middle', true);
	T([tx + 35, ty + tbH * 0.2], `SCALE ${scaleLabel(sc)} · UNITS: mm`, 2.6);
	T([tx + 70 + (tbW - 70) / 2, ty + tbH * 0.2], date.toLocaleDateString(), 2.6);
	T([m + 4, ty + 4], 'THIRD-ANGLE PROJECTION · DraftOtter', 2.4, 'start');
	const ox = m + gap + 6, oy = m + tbH + gap + 6;
	const cx = [ox, ox + colW[0] * sc + gap, ox + (colW[0] + colW[1]) * sc + 2 * gap];
	const ry = [oy, oy + row0 * sc + gap];
	const place = { front: [cx[0], ry[0], sc], top: [cx[0], ry[1], sc], right: [cx[1], ry[0], sc] };
	if (hasSec) place.section = [cx[2], ry[0], sc];
	if (views.iso) {
		const isoW = S.w - m - 6 - cx[1] - (hasCol3 ? colW[2] * sc + gap : 0), isoH = S.h - m - 6 - ry[1];
		const [iw, ih] = sz('iso');
		const s = Math.min(sc, isoW / (iw || 1), isoH / (ih || 1));
		if (s > 0 && isoW > 20 && isoH > 20) place.iso = [cx[1], ry[1], s];
	}
	const out = { w: S.w, h: S.h, scale: sc, items, place, boxes: {} };
	const toSheet = (k, q) => { const [px, py, s] = place[k], b = views[k].box; return [px + (q[0] - b[0]) * s, py + (q[1] - b[1]) * s]; };
	for (const k of Object.keys(place)) {
		const v = views[k], [px, py, s] = place[k];
		const X = (q) => toSheet(k, q);
		out.boxes[k] = { box: v.box, px, py, s };
		for (const l of v.lines) L(X(l.a), X(l.b), l.hidden ? 'hidden' : 'visible');
		for (const poly of v.hatch || []) for (const h of hatchLines(poly.map(X), 1.8)) L(h[0], h[1], 'thin');
		const [w] = sz(k);
		T([px + (w * s) / 2, py - (k === 'iso' ? 6 : 13)], k === 'section' ? 'SECTION A–A' : VIEWS[k].label, 2.6, 'middle', true);
		if (k === 'iso') continue;
		const [vw, vh] = sz(k);
		dimH(items, X([v.box[0], v.box[1]]), X([v.box[2], v.box[1]]), -4.5, fmt(vw, 2));
		dimV(items, X([v.box[0], v.box[1]]), X([v.box[0], v.box[3]]), -4.5, fmt(vh, 2));
		for (const c of v.circles || []) {
			const cc = X(c.c), rr = c.r * s, e = rr + 1.5;
			L([cc[0] - e, cc[1]], [cc[0] + e, cc[1]], 'center'); L([cc[0], cc[1] - e], [cc[0], cc[1] + e], 'center');
			const a = Math.PI / 4, p0 = [cc[0] + rr * Math.cos(a), cc[1] + rr * Math.sin(a)], p1 = [p0[0] + 5, p0[1] + 5];
			L(p0, p1, 'thin'); L(p1, [p1[0] + 4, p1[1]], 'thin');
			T([p1[0] + 4.5, p1[1] - 1], 'Ø' + fmt(2 * c.r, 2), 2.6, 'start');
			arrow(items, p1, p0);
		}
	}
	// section line A–A across the top view
	if (hasSec && views.section.cut != null && place.top) {
		const b = views.top.box, y = views.section.cut;
		const a1 = toSheet('top', [b[0], y]), a2 = toSheet('top', [b[2], y]);
		const e1 = [a1[0] - 6, a1[1]], e2 = [a2[0] + 6, a2[1]];
		L(e1, e2, 'center');
		for (const e of [e1, e2]) { L(e, [e[0], e[1] + 5], 'visible'); arrow(items, e, [e[0], e[1] + 5], 1.6); T([e[0], e[1] + 6.5], 'A', 3.2, 'middle', true); }
	}
	// detail views: circle + letter on the parent view, magnified copy in column 3
	let dy = ry[1];
	details.forEach((d, i) => {
		if (!place[d.view]) return;
		const letter = String.fromCharCode(66 + i);
		const s0 = place[d.view][2], c0 = toSheet(d.view, d.c);
		items.push({ t: 'circle', c: c0, r: d.r * s0, style: 'thin', detail: i });
		T([c0[0] + d.r * s0 * 0.75 + 2, c0[1] + d.r * s0 * 0.75 + 2], letter, 3.2, 'start', true, { detail: i });
		const s = sc * d.k, R = d.r * s, cxx = cx[2] + R, cyy = dy + R;
		const P = (q) => [cxx + (q[0] - d.c[0]) * s, cyy + (q[1] - d.c[1]) * s];
		for (const l of views[d.view].lines) {
			const seg = clipToCircle(l.a, l.b, d.c, d.r);
			if (seg) L(P(seg[0]), P(seg[1]), l.hidden ? 'hidden' : 'visible');
		}
		items.push({ t: 'circle', c: [cxx, cyy], r: R, style: 'thin' });
		T([cxx, cyy - R - 6], `DETAIL ${letter} (${scaleLabel(s)})`, 2.6, 'middle', true, { detail: i });
		dy += 2 * R + gap;
	});
	// user dimensions
	dims.forEach((dm, i) => {
		if (!place[dm.view]) return;
		const v = views[dm.view], a = toSheet(dm.view, dm.a), b = toSheet(dm.view, dm.b);
		const horiz = Math.abs(dm.b[0] - dm.a[0]) >= Math.abs(dm.b[1] - dm.a[1]);
		const val = horiz ? Math.abs(dm.b[0] - dm.a[0]) : Math.abs(dm.b[1] - dm.a[1]);
		const B0 = toSheet(dm.view, [v.box[0], v.box[1]]), B1 = toSheet(dm.view, [v.box[2], v.box[3]]);
		const tag = { dim: i };
		if (horiz) {
			const above = (a[1] + b[1]) / 2 > (B0[1] + B1[1]) / 2;
			const y = above ? B1[1] + 6 + (dm.lane || 0) * 5 : B0[1] - 12 - (dm.lane || 0) * 5;
			L([a[0], a[1]], [a[0], y + (above ? 1.5 : -1.5)], 'thin', tag); L([b[0], b[1]], [b[0], y + (above ? 1.5 : -1.5)], 'thin', tag); L([a[0], y], [b[0], y], 'thin', tag);
			arrow(items, [(a[0] + b[0]) / 2, y], [a[0], y]); arrow(items, [(a[0] + b[0]) / 2, y], [b[0], y]);
			T([(a[0] + b[0]) / 2, y + 1.1], fmt(val, 2), 2.8, 'middle', false, tag);
		} else {
			const right = (a[0] + b[0]) / 2 > (B0[0] + B1[0]) / 2;
			const x = right ? B1[0] + 6 + (dm.lane || 0) * 5 : B0[0] - 12 - (dm.lane || 0) * 5;
			L([a[0], a[1]], [x + (right ? 1.5 : -1.5), a[1]], 'thin', tag); L([b[0], b[1]], [x + (right ? 1.5 : -1.5), b[1]], 'thin', tag); L([x, a[1]], [x, b[1]], 'thin', tag);
			arrow(items, [x, (a[1] + b[1]) / 2], [x, a[1]]); arrow(items, [x, (a[1] + b[1]) / 2], [x, b[1]]);
			T([x - 1.1, (a[1] + b[1]) / 2], fmt(val, 2), 2.8, 'middle', false, { ...tag, rot: -90 });
		}
	});
	if (pending && place[pending.view]) { const p = toSheet(pending.view, pending.p); items.push({ t: 'circle', c: p, r: 1.2, style: 'pending' }); }
	out.toSheet = toSheet;
	return out;
}

/** 45° hatch lines inside a polygon (sheet coordinates), spacing in mm. */
function hatchLines(poly, spacing) {
	if (poly.length < 3) return [];
	const proj = poly.map(([x, y]) => x - y);
	const lo = Math.min(...proj), hi = Math.max(...proj), out = [];
	for (let c = Math.ceil(lo / spacing) * spacing; c <= hi; c += spacing) {
		// line x − y = c; intersect with every edge
		const xs = [];
		for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
			const a = poly[j], b = poly[i], fa = a[0] - a[1] - c, fb = b[0] - b[1] - c;
			if ((fa > 0) === (fb > 0)) continue;
			const t = fa / (fa - fb);
			xs.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
		}
		xs.sort((p, q) => p[0] - q[0]);
		for (let k = 0; k + 1 < xs.length; k += 2) out.push([xs[k], xs[k + 1]]);
	}
	return out;
}

/** The part of segment ab inside a circle (or null). */
function clipToCircle(a, b, c, r) {
	const d = [b[0] - a[0], b[1] - a[1]], f = [a[0] - c[0], a[1] - c[1]];
	const A = d[0] * d[0] + d[1] * d[1], B = 2 * (f[0] * d[0] + f[1] * d[1]), C = f[0] * f[0] + f[1] * f[1] - r * r;
	if (A < 1e-12) return null;
	const disc = B * B - 4 * A * C;
	if (disc <= 0) return null;
	const s = Math.sqrt(disc);
	const t0 = Math.max(0, (-B - s) / (2 * A)), t1 = Math.min(1, (-B + s) / (2 * A));
	if (t1 <= t0) return null;
	return [[a[0] + d[0] * t0, a[1] + d[1] * t0], [a[0] + d[0] * t1, a[1] + d[1] * t1]];
}

function arrow(items, from, to, size = 1.8) {
	const ang = Math.atan2(to[1] - from[1], to[0] - from[0]);
	for (const s of [-1, 1]) items.push({ t: 'line', a: to, b: [to[0] - size * Math.cos(ang + s * 0.32), to[1] - size * Math.sin(ang + s * 0.32)], style: 'thin' });
}
function dimH(items, a, b, off, text) {
	const y = Math.min(a[1], b[1]) + off - 2;
	items.push({ t: 'line', a: [a[0], a[1] - 1], b: [a[0], y - 1.5], style: 'thin' }, { t: 'line', a: [b[0], b[1] - 1], b: [b[0], y - 1.5], style: 'thin' }, { t: 'line', a: [a[0], y], b: [b[0], y], style: 'thin' });
	arrow(items, [(a[0] + b[0]) / 2, y], [a[0], y]); arrow(items, [(a[0] + b[0]) / 2, y], [b[0], y]);
	items.push({ t: 'text', p: [(a[0] + b[0]) / 2, y + 1.1], s: text, size: 2.8, anchor: 'middle' });
}
function dimV(items, a, b, off, text) {
	const x = Math.min(a[0], b[0]) + off - 2;
	items.push({ t: 'line', a: [a[0] - 1, a[1]], b: [x - 1.5, a[1]], style: 'thin' }, { t: 'line', a: [b[0] - 1, b[1]], b: [x - 1.5, b[1]], style: 'thin' }, { t: 'line', a: [x, a[1]], b: [x, b[1]], style: 'thin' });
	arrow(items, [x, (a[1] + b[1]) / 2], [x, a[1]]); arrow(items, [x, (a[1] + b[1]) / 2], [x, b[1]]);
	items.push({ t: 'text', p: [x - 1.1, (a[1] + b[1]) / 2], s: text, size: 2.8, anchor: 'middle', rot: -90 });
}

const STYLE = {
	visible: 'stroke="#000" stroke-width="0.45"', hidden: 'stroke="#000" stroke-width="0.25" stroke-dasharray="1.6 0.9"',
	thin: 'stroke="#000" stroke-width="0.18"', center: 'stroke="#000" stroke-width="0.18" stroke-dasharray="4 0.8 0.8 0.8"', border: 'stroke="#000" stroke-width="0.6"', pending: 'stroke="#e8613a" stroke-width="0.5"',
};
const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const n3 = (v) => (Math.round(v * 1000) / 1000).toString();

export function drawingToSVG(dw) {
	const Y = (y) => dw.h - y;
	const parts = [];
	for (const it of dw.items) {
		const tag = it.dim != null ? ` data-dim="${it.dim}"` : it.detail != null ? ` data-detail="${it.detail}"` : '';
		if (it.t === 'line') parts.push(`<line${tag} x1="${n3(it.a[0])}" y1="${n3(Y(it.a[1]))}" x2="${n3(it.b[0])}" y2="${n3(Y(it.b[1]))}" ${STYLE[it.style] || STYLE.thin} stroke-linecap="round"/>`);
		else if (it.t === 'circle') parts.push(`<circle${tag} cx="${n3(it.c[0])}" cy="${n3(Y(it.c[1]))}" r="${n3(it.r)}" fill="none" ${STYLE[it.style] || STYLE.thin}/>`);
		else if (it.t === 'text') parts.push(`<text${tag} x="${n3(it.p[0])}" y="${n3(Y(it.p[1]))}" font-family="Arial, Helvetica, sans-serif" font-size="${it.size}" text-anchor="${it.anchor}"${it.bold ? ' font-weight="bold"' : ''}${it.rot ? ` transform="rotate(${it.rot} ${n3(it.p[0])} ${n3(Y(it.p[1]))})"` : ''}>${esc(it.s)}</text>`);
	}
	return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${dw.w}mm" height="${dw.h}mm" viewBox="0 0 ${dw.w} ${dw.h}">
<rect width="100%" height="100%" fill="#fff"/>
${parts.join('\n')}
</svg>
`;
}

export function drawingToDXF(dw) {
	const o = ['0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1009', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES'];
	const layer = { visible: 'VISIBLE', hidden: 'HIDDEN', thin: 'DIM', center: 'CENTER', border: 'BORDER' };
	for (const it of dw.items) {
		if (it.t === 'line') o.push('0', 'LINE', '8', layer[it.style] || 'DIM', '10', n3(it.a[0]), '20', n3(it.a[1]), '30', '0', '11', n3(it.b[0]), '21', n3(it.b[1]), '31', '0');
		else if (it.t === 'circle') o.push('0', 'CIRCLE', '8', layer[it.style] || 'DIM', '10', n3(it.c[0]), '20', n3(it.c[1]), '30', '0', '40', n3(it.r));
		else if (it.t === 'text') {
			const h = { start: 0, middle: 1, end: 2 }[it.anchor] || 0;
			o.push('0', 'TEXT', '8', 'TEXT', '10', n3(it.p[0]), '20', n3(it.p[1]), '30', '0', '40', n3(it.size * 0.72), '1', String(it.s).replace(/Ø/g, '%%c'));
			if (it.rot) o.push('50', String(-it.rot));
			if (h) o.push('72', String(h), '11', n3(it.p[0]), '21', n3(it.p[1]), '31', '0');
		}
	}
	o.push('0', 'ENDSEC', '0', 'EOF');
	return o.join('\n') + '\n';
}

// ================================================================= app command

export const DrawingMixin = {
	/** Compute every view of the given nodes (or the visible design). opts.section adds section A–A (cut at the middle, looking from the front). */
	drawingViews(nodes, { iso = true, hidden = true, section = false } = {}) {
		const geom = this.engine.printable(nodes, true);
		if (!geom || !geom.attributes.position.count) return null;
		const g = geom.index ? geom.toNonIndexed() : geom;
		// feature-edge chains (the fillet tool's edge finder) give the hole circles
		let chains = [];
		try { chains = extractEdges(new THREE.Mesh(g)).chains; } catch (e) { chains = []; }
		const views = {};
		let mesh = null;
		const boxOf = (lines, extra = []) => {
			let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
			for (const l of lines) for (const p of [l.a, l.b]) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
			for (const p of extra) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
			return [x0, y0, x1, y1];
		};
		for (const k of ['front', 'top', 'right', ...(iso ? ['iso'] : [])]) {
			const r = viewLines(g, k, { hidden: k === 'iso' ? true : hidden, bvhMesh: mesh });
			mesh = r.mesh || mesh;
			const lines = k === 'iso' ? r.lines.filter((l) => !l.hidden) : hidden ? r.lines : r.lines.filter((l) => !l.hidden);
			views[k] = { lines, circles: k === 'iso' ? [] : viewCircles(chains, k), box: boxOf(lines) };
		}
		if (section) {
			g.computeBoundingBox();
			const yc = (g.boundingBox.min.y + g.boundingBox.max.y) / 2;
			const back = clipHalf(g, 'y', yc, true);
			const sec = sectionAt(g, 'y', yc);
			if (back && sec) {
				const r = viewLines(back, 'front', { hidden: false });
				// section polygons are in (z, x) plane coordinates; the front view shows (x, z)
				const hatch = sec.polygons.map((p) => p.map(([u, v]) => [v, u]));
				const lines = r.lines.filter((l) => !l.hidden);
				views.section = { lines, hatch, circles: [], box: boxOf(lines, hatch.flat()), cut: yc };
			}
		}
		return views;
	},

	drawingDialog() {
		const sel = this.selectedNodes().map((n) => this.model.topLevelOf(n.id)).filter((n, i, a) => n && a.indexOf(n) === i);
		const nodes = sel.length ? sel : this.model.nodes.filter((n) => n.visible);
		if (!nodes.some((n) => !n.hole)) { toast('Nothing to draw — add some solid shapes first', 'warn'); return; }
		const saved = this.model.doc.drawing || {};
		const opts = { sheet: this.lastDrawing?.sheet || 'letter', scale: 'auto', iso: this.lastDrawing?.iso ?? true, hidden: this.lastDrawing?.hidden ?? true, section: !!saved.section, title: sel.length === 1 ? sel[0].name : this.model.doc.name || 'Part', dims: (saved.dims || []).slice(), details: (saved.details || []).slice() };
		const persist = () => { this.model.doc.drawing = { section: opts.section, dims: opts.dims, details: opts.details }; this.autosave && this.autosave(); };
		const preview = el('div', { class: 'dw-preview' });
		const sheetSel = el('select', {}, ...Object.entries(SHEETS).map(([k, s]) => el('option', { value: k }, s.label)));
		sheetSel.value = opts.sheet;
		const scaleSel = el('select', {}, el('option', { value: 'auto' }, 'Fit to sheet'), ...SCALES.map((s) => el('option', { value: s }, scaleLabel(s))));
		const isoCb = el('input', { type: 'checkbox', checked: opts.iso }), hidCb = el('input', { type: 'checkbox', checked: opts.hidden }), secCb = el('input', { type: 'checkbox', checked: opts.section });
		const titleIn = el('input', { type: 'text', value: opts.title, style: 'width:140px' });
		const hint = el('span', { class: 'muted small dw-hint' });
		let mode = null, pending = null;
		const modeBtn = (m, label, title) => { const b = el('button', { class: 'btn sm', title }, label); b.addEventListener('click', () => { mode = mode === m ? null : m; pending = null; syncMode(); build(); }); b.dataset.mode = m; return b; };
		const dimBtn = modeBtn('dim', '↔ Dimension', 'Click two points on a view (corners and circle centers snap); click a dimension to remove it');
		const detBtn = modeBtn('detail', '◎ Detail', 'Click a spot on a view to add a magnified detail view (click a detail circle to remove it)');
		const syncMode = () => {
			for (const b of [dimBtn, detBtn]) b.classList.toggle('active', b.dataset.mode === mode);
			hint.textContent = mode === 'dim' ? (pending ? 'Now click the second point…' : 'Click the first point on a view') : mode === 'detail' ? 'Click the spot to magnify' : 'Click a dimension or detail to remove it';
			preview.style.cursor = mode ? 'crosshair' : '';
		};
		let dw = null, views = null, viewsKey = '';
		const build = () => {
			const key = `${opts.iso}|${opts.hidden}|${opts.section}`;
			if (key !== viewsKey) { views = this.drawingViews(nodes, opts); viewsKey = key; }
			if (!views) { preview.textContent = 'Could not build the views.'; return; }
			dw = layoutDrawing(views, { ...opts, pending });
			preview.innerHTML = drawingToSVG(dw).replace(/^<\?xml[^>]*>\s*/, '').replace(/width="[\d.]+mm" height="[\d.]+mm"/, 'width="100%"');
		};
		const upd = () => { opts.sheet = sheetSel.value; opts.scale = scaleSel.value === 'auto' ? 'auto' : +scaleSel.value; opts.iso = isoCb.checked; opts.hidden = hidCb.checked; opts.section = secCb.checked; opts.title = titleIn.value || 'Part'; this.lastDrawing = { ...opts }; persist(); build(); };
		for (const x of [sheetSel, scaleSel, isoCb, hidCb, secCb]) x.addEventListener('change', upd);
		titleIn.addEventListener('change', upd);
		titleIn.addEventListener('keydown', (e) => e.stopPropagation());
		// clicks on the sheet: map to a view and its model coordinates
		const viewAt = (e) => {
			const svg = preview.querySelector('svg');
			if (!svg || !dw) return null;
			const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
			const p = pt.matrixTransform(svg.getScreenCTM().inverse());
			const sx = p.x, sy = dw.h - p.y;
			for (const [k, v] of Object.entries(dw.boxes)) {
				if (k === 'iso') continue;
				const w = (v.box[2] - v.box[0]) * v.s, h = (v.box[3] - v.box[1]) * v.s;
				if (sx >= v.px - 3 && sx <= v.px + w + 3 && sy >= v.py - 3 && sy <= v.py + h + 3) return { view: k, p: [v.box[0] + (sx - v.px) / v.s, v.box[1] + (sy - v.py) / v.s], s: v.s };
			}
			return null;
		};
		const snap = (hit) => {
			const v = views[hit.view];
			let best = null, bd = 4 / hit.s;
			const cands = [...v.lines.flatMap((l) => [l.a, l.b]), ...(v.circles || []).map((c) => c.c)];
			for (const q of cands) { const d = Math.hypot(q[0] - hit.p[0], q[1] - hit.p[1]); if (d < bd) { bd = d; best = q; } }
			return best ? best.slice() : hit.p;
		};
		preview.addEventListener('click', (e) => {
			const dimEl = e.target.closest && e.target.closest('[data-dim]'), detEl = e.target.closest && e.target.closest('[data-detail]');
			if (!mode && dimEl) { opts.dims.splice(+dimEl.dataset.dim, 1); persist(); build(); return; }
			if (!mode && detEl) { opts.details.splice(+detEl.dataset.detail, 1); persist(); build(); return; }
			const hit = viewAt(e);
			if (!hit) return;
			if (mode === 'dim') {
				const p = snap(hit);
				if (!pending) { pending = { view: hit.view, p }; syncMode(); build(); return; }
				if (pending.view === hit.view && Math.hypot(p[0] - pending.p[0], p[1] - pending.p[1]) > 1e-6) {
					const lane = opts.dims.filter((d) => d.view === hit.view).length % 4;
					opts.dims.push({ view: hit.view, a: pending.p, b: p, lane });
					persist();
				}
				pending = null; syncMode(); build();
			} else if (mode === 'detail') {
				const b = views[hit.view].box, r = Math.max(b[2] - b[0], b[3] - b[1]) * 0.15;
				opts.details.push({ view: hit.view, c: hit.p, r, k: 2 });
				persist(); mode = null; syncMode(); build();
			}
		});
		const fname = () => (opts.title || 'drawing').replace(/[^\w\- ]+/g, '_') + '_drawing';
		const body = el('div', { class: 'dw' },
			el('div', { class: 'dw-opts' }, el('label', {}, 'Title ', titleIn), el('label', {}, 'Sheet ', sheetSel), el('label', {}, 'Scale ', scaleSel),
				el('label', { class: 'check' }, isoCb, ' Isometric'), el('label', { class: 'check' }, hidCb, ' Hidden lines'), el('label', { class: 'check', title: 'Cut through the middle, looking from the front' }, secCb, ' Section A–A'),
				el('span', { class: 'sk-sep' }), dimBtn, detBtn, el('button', { class: 'btn sm', onclick: () => { opts.dims = []; opts.details = []; pending = null; persist(); build(); } }, 'Clear'), hint),
			preview);
		syncMode();
		this.modal('Drawing', body, [
			{ label: 'Close' },
			{ label: 'DXF', action: () => { download(drawingToDXF(dw), fname() + '.dxf', 'application/dxf'); return false; } },
			{ label: 'SVG', action: () => { download(drawingToSVG(dw), fname() + '.svg', 'image/svg+xml'); return false; } },
			{ label: 'Print / PDF', primary: true, action: () => { this.printDrawing(dw); return false; } },
		], 'xwide');
		setTimeout(build, 20);
		this.drawingState = { get dw() { return dw; }, opts, get views() { return views; } };
	},

	/** Print through a hidden frame sized to the sheet (choose “Save as PDF” in the print dialog). */
	printDrawing(dw) {
		const f = document.createElement('iframe');
		f.style.cssText = 'position:fixed;width:0;height:0;border:0;right:0;bottom:0';
		document.body.appendChild(f);
		const svg = drawingToSVG(dw).replace(/^<\?xml[^>]*>\s*/, '');
		f.contentDocument.open();
		f.contentDocument.write(`<!doctype html><html><head><meta charset="utf-8"><style>@page{size:${dw.w}mm ${dw.h}mm;margin:0}html,body{margin:0}svg{display:block;width:${dw.w}mm;height:${dw.h}mm}</style></head><body>${svg}</body></html>`);
		f.contentDocument.close();
		setTimeout(() => { f.contentWindow.focus(); f.contentWindow.print(); setTimeout(() => f.remove(), 1000); }, 100);
	},
};
