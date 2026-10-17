// 2D sketch constraint solver (damped least squares / Levenberg–Marquardt with a numeric Jacobian).
// A sketch is a closed polygon `pts`; edge i runs from pts[i] to pts[(i + 1) % n].
// Constraints: { type, p: [point indices], e: [edge indices], value, expr }.

export const CONSTRAINT_INFO = {
	h: { label: 'Horizontal', glyph: 'H', edges: 1 },
	v: { label: 'Vertical', glyph: 'V', edges: 1 },
	len: { label: 'Length', glyph: '', edges: 1, value: true },
	eq: { label: 'Equal length', glyph: '=', edges: 2 },
	par: { label: 'Parallel', glyph: '∥', edges: 2 },
	perp: { label: 'Perpendicular', glyph: '⊥', edges: 2 },
	angle: { label: 'Corner angle', glyph: '∠', points: 1, value: true },
	fix: { label: 'Fixed', glyph: '⚓', points: 1 },
	px: { label: 'X position', glyph: 'X', points: 1, value: true },
	py: { label: 'Y position', glyph: 'Y', points: 1, value: true },
};

const edgePts = (n, e) => [e, (e + 1) % n];

// Residuals for one constraint, given flat coordinates X ([x0, y0, x1, y1, ...]).
function residuals(c, X, n) {
	const P = (i) => [X[2 * i], X[2 * i + 1]];
	const E = (e) => { const [a, b] = edgePts(n, e); const A = P(a), B = P(b); return [B[0] - A[0], B[1] - A[1]]; };
	const len = (d) => Math.hypot(d[0], d[1]) || 1e-12;
	switch (c.type) {
		case 'h': return [E(c.e[0])[1]];
		case 'v': return [E(c.e[0])[0]];
		case 'len': return [len(E(c.e[0])) - c.value];
		case 'eq': return [len(E(c.e[0])) - len(E(c.e[1]))];
		case 'par': { const a = E(c.e[0]), b = E(c.e[1]); return [(a[0] * b[1] - a[1] * b[0]) / (len(a) * len(b))]; }
		case 'perp': { const a = E(c.e[0]), b = E(c.e[1]); return [(a[0] * b[0] + a[1] * b[1]) / (len(a) * len(b))]; }
		case 'angle': {
			const i = c.p[0], p = P(i), a = P((i - 1 + n) % n), b = P((i + 1) % n);
			const u = [a[0] - p[0], a[1] - p[1]], w = [b[0] - p[0], b[1] - p[1]];
			const ang = Math.atan2(Math.abs(u[0] * w[1] - u[1] * w[0]), u[0] * w[0] + u[1] * w[1]);
			return [(ang - (c.value * Math.PI) / 180) * Math.max(1, (len(u) + len(w)) / 2)];
		}
		case 'fix': { const p = P(c.p[0]); return [p[0] - c.x, p[1] - c.y]; }
		case 'px': return [P(c.p[0])[0] - c.value];
		case 'py': return [P(c.p[0])[1] - c.value];
		default: return [];
	}
}

function allResiduals(cons, X, n) {
	const r = [];
	for (const c of cons) r.push(...residuals(c, X, n));
	return r;
}

// Solve a small dense linear system A x = b (Gaussian elimination, partial pivoting).
function solveLinear(A, b) {
	const n = b.length;
	const M = A.map((row, i) => [...row, b[i]]);
	for (let c = 0; c < n; c++) {
		let p = c;
		for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
		if (Math.abs(M[p][c]) < 1e-14) continue;
		[M[c], M[p]] = [M[p], M[c]];
		for (let r = 0; r < n; r++) {
			if (r === c) continue;
			const f = M[r][c] / M[c][c];
			if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
		}
	}
	return M.map((row, i) => (Math.abs(row[i]) < 1e-14 ? 0 : row[n] / row[i]));
}

function jacobian(cons, X, n, free) {
	const r0 = allResiduals(cons, X, n);
	const J = r0.map(() => new Array(free.length).fill(0));
	for (let k = 0; k < free.length; k++) {
		const j = free[k], h = 1e-6 * Math.max(1, Math.abs(X[j]));
		const xp = X.slice(), xm = X.slice();
		xp[j] += h; xm[j] -= h;
		const rp = allResiduals(cons, xp, n), rm = allResiduals(cons, xm, n);
		for (let i = 0; i < r0.length; i++) J[i][k] = (rp[i] - rm[i]) / (2 * h);
	}
	return { r0, J };
}

const norm2 = (r) => r.reduce((s, v) => s + v * v, 0);

/**
 * Solve the sketch. `held` lists point indices that must not move (e.g. the point being dragged).
 * Returns { pts, ok, residual, bad: [constraint indices not satisfied] }.
 */
export function solveSketch(pts, cons, held = []) {
	const n = pts.length;
	const X = pts.flat();
	const active = cons.filter((c) => valid(c, n));
	if (!active.length) return { pts: pts.map((p) => p.slice()), ok: true, residual: 0, bad: [] };
	const fixedSet = new Set(held);
	const free = [];
	for (let i = 0; i < n; i++) if (!fixedSet.has(i)) free.push(2 * i, 2 * i + 1);
	let lambda = 1e-3;
	let { r0, J } = jacobian(active, X, n, free);
	let err = norm2(r0);
	for (let it = 0; it < 200 && err > 1e-20; it++) {
		// Normal equations with Levenberg–Marquardt damping: (JᵀJ + λI) δ = -Jᵀr
		const m = free.length;
		const A = Array.from({ length: m }, () => new Array(m).fill(0));
		const g = new Array(m).fill(0);
		for (let i = 0; i < r0.length; i++) {
			const Ji = J[i];
			for (let a = 0; a < m; a++) {
				if (!Ji[a]) continue;
				g[a] -= Ji[a] * r0[i];
				for (let b = 0; b < m; b++) A[a][b] += Ji[a] * Ji[b];
			}
		}
		let improved = false;
		for (let tries = 0; tries < 12; tries++) {
			const Ad = A.map((row, a) => row.map((v, b) => (a === b ? v + lambda * (1 + v) : v)));
			const d = solveLinear(Ad, g);
			const Xn = X.slice();
			for (let k = 0; k < m; k++) Xn[free[k]] += d[k];
			const rn = allResiduals(active, Xn, n);
			const en = norm2(rn);
			if (en < err) {
				for (let k = 0; k < X.length; k++) X[k] = Xn[k];
				err = en;
				lambda = Math.max(lambda / 4, 1e-12);
				improved = true;
				break;
			}
			lambda *= 8;
		}
		if (!improved) break;
		({ r0, J } = jacobian(active, X, n, free));
	}
	const out = [];
	for (let i = 0; i < n; i++) out.push([X[2 * i], X[2 * i + 1]]);
	const bad = [];
	cons.forEach((c, i) => { if (valid(c, n) && norm2(residuals(c, X, n)) > 1e-8) bad.push(i); });
	return { pts: out, ok: bad.length === 0, residual: Math.sqrt(err), bad };
}

export function valid(c, n) {
	const pOk = (c.p || []).every((i) => i >= 0 && i < n);
	const eOk = (c.e || []).every((i) => i >= 0 && i < n);
	return n >= 2 && pOk && eOk && (!CONSTRAINT_INFO[c.type] || !CONSTRAINT_INFO[c.type].value || isFinite(c.value));
}

// Remaining degrees of freedom (2·points − rank of the constraint Jacobian).
export function degreesOfFreedom(pts, cons) {
	const n = pts.length;
	const active = cons.filter((c) => valid(c, n));
	const free = [];
	for (let i = 0; i < 2 * n; i++) free.push(i);
	if (!active.length) return 2 * n;
	const { J } = jacobian(active, pts.flat(), n, free);
	// rank by Gaussian elimination
	const M = J.map((r) => r.slice());
	let rank = 0;
	const rows = M.length, cols = free.length;
	for (let c = 0; c < cols && rank < rows; c++) {
		let p = rank;
		for (let r = rank + 1; r < rows; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
		if (Math.abs(M[p][c]) < 1e-9) continue;
		[M[rank], M[p]] = [M[p], M[rank]];
		for (let r = rank + 1; r < rows; r++) {
			const f = M[r][c] / M[rank][c];
			for (let k = c; k < cols; k++) M[r][k] -= f * M[rank][k];
		}
		rank++;
	}
	return 2 * n - rank;
}

// Keep constraints valid when a point is inserted at index k (splitting edge k-1).
export function remapInsert(cons, radii, k, n) {
	const splitEdge = (k - 1 + n) % n;
	const out = [];
	for (const c of cons) {
		if ((c.e || []).includes(splitEdge)) continue;
		out.push({ ...c, p: (c.p || []).map((i) => (i >= k ? i + 1 : i)), e: (c.e || []).map((i) => (i >= k ? i + 1 : i)) });
	}
	const r = {};
	for (const key in radii || {}) { const i = +key; r[i >= k ? i + 1 : i] = radii[key]; }
	return { cons: out, radii: r };
}

// Keep constraints valid when point k is deleted (edges k-1 and k merge).
export function remapDelete(cons, radii, k, n) {
	const e1 = (k - 1 + n) % n, e2 = k;
	const out = [];
	for (const c of cons) {
		if ((c.p || []).includes(k) || (c.e || []).includes(e1) || (c.e || []).includes(e2)) continue;
		// angle constraints at neighbors depend on the removed point too
		if (c.type === 'angle' && (c.p[0] === (k - 1 + n) % n || c.p[0] === (k + 1) % n)) continue;
		out.push({ ...c, p: (c.p || []).map((i) => (i > k ? i - 1 : i)), e: (c.e || []).map((i) => (i > k ? i - 1 : i)) });
	}
	const r = {};
	for (const key in radii || {}) { const i = +key; if (i !== k) r[i > k ? i - 1 : i] = radii[key]; }
	return { cons: out, radii: r };
}

// =====================================================================================================
// Entity-model solver (points, line/arc segments, circles). Constraint references:
//   p: point indices, s: segment indices, c: circle indices.
// Variables: point coordinates, arc bulges, circle radii.
// =====================================================================================================

export const MODEL_CONSTRAINTS = {
	h: { label: 'Horizontal', glyph: 'H' },
	v: { label: 'Vertical', glyph: 'V' },
	len: { label: 'Length', glyph: '', value: true },
	eq: { label: 'Equal length', glyph: '=' },
	par: { label: 'Parallel', glyph: '∥' },
	perp: { label: 'Perpendicular', glyph: '⊥' },
	angle: { label: 'Angle', glyph: '∠', value: true },
	fix: { label: 'Fixed', glyph: '⚓' },
	px: { label: 'X position', glyph: 'X', value: true },
	py: { label: 'Y position', glyph: 'Y', value: true },
	radius: { label: 'Radius', glyph: 'R', value: true },
	dia: { label: 'Diameter', glyph: 'Ø', value: true },
	tangent: { label: 'Tangent', glyph: 'T' },
	coincident: { label: 'Coincident', glyph: '•' },
	online: { label: 'Point on', glyph: '∈' },
	sym: { label: 'Symmetric', glyph: '⇋' },
	midpoint: { label: 'Midpoint', glyph: 'M' },
	concentric: { label: 'Concentric', glyph: '◎' },
};

const hyp = (d) => Math.hypot(d[0], d[1]) || 1e-12;
const rot = (u, a) => [u[0] * Math.cos(a) - u[1] * Math.sin(a), u[0] * Math.sin(a) + u[1] * Math.cos(a)];

function modelVars(m) {
	const X = [];
	m.points.forEach((p) => X.push(p[0], p[1]));
	const bIdx = new Map(), rIdx = new Map();
	m.segs.forEach((s, i) => { if (s.arc) { bIdx.set(i, X.length); X.push(s.arc); } });
	m.circles.forEach((c, i) => { rIdx.set(i, X.length); X.push(c.r); });
	return { X, bIdx, rIdx };
}

function modelResiduals(m, X, bIdx, rIdx, cons) {
	const P = (i) => [X[2 * i], X[2 * i + 1]];
	const bulge = (s) => (bIdx.has(s) ? X[bIdx.get(s)] : 0);
	const chord = (s) => { const g = m.segs[s], A = P(g.a), B = P(g.b); return [B[0] - A[0], B[1] - A[1]]; };
	const unit = (d) => { const l = hyp(d); return [d[0] / l, d[1] / l]; };
	const arcR = (s) => { const c = hyp(chord(s)), b = bulge(s); return (c * (1 + b * b)) / (4 * Math.abs(b) || 1e-12); };
	const arcC = (s) => {
		const g = m.segs[s], A = P(g.a), B = P(g.b), d = chord(s), c = hyp(d), b = bulge(s);
		const R = arcR(s), sg = (b * c) / 2, k = (R - Math.abs(sg)) * Math.sign(b || 1);
		return [(A[0] + B[0]) / 2 - (d[1] / c) * k, (A[1] + B[1]) / 2 + (d[0] / c) * k];
	};
	// unit direction leaving point `pid` along segment s (the tangent for arcs)
	const away = (s, pid) => {
		const g = m.segs[s], u = unit(chord(s)), b = bulge(s);
		if (!b) return pid === g.a ? u : [-u[0], -u[1]];
		const th = 4 * Math.atan(b);
		if (pid === g.a) return rot(u, -th / 2);
		const t = rot(u, th / 2);
		return [-t[0], -t[1]];
	};
	const shared = (s1, s2) => { const g = m.segs[s1], h = m.segs[s2]; return [g.a, g.b].find((v) => v === h.a || v === h.b); };
	const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
	const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
	const out = [];
	for (const c of cons) {
		const s = c.s || [], p = c.p || [], ci = c.c || [];
		switch (c.type) {
			case 'h': out.push(chord(s[0])[1]); break;
			case 'v': out.push(chord(s[0])[0]); break;
			case 'len': out.push(hyp(chord(s[0])) - c.value); break;
			case 'eq': out.push(hyp(chord(s[0])) - hyp(chord(s[1]))); break;
			case 'par': out.push(cross(unit(chord(s[0])), unit(chord(s[1])))); break;
			case 'perp': out.push(dot(unit(chord(s[0])), unit(chord(s[1])))); break;
			case 'angle': {
				const pid = shared(s[0], s[1]);
				if (pid === undefined) { out.push(0); break; }
				const d1 = away(s[0], pid), d2 = away(s[1], pid);
				const ang = Math.atan2(Math.abs(cross(d1, d2)), dot(d1, d2));
				out.push((ang - (c.value * Math.PI) / 180) * Math.max(1, (hyp(chord(s[0])) + hyp(chord(s[1]))) / 2));
				break;
			}
			case 'fix': { const q = P(p[0]); out.push(q[0] - c.x, q[1] - c.y); break; }
			case 'px': out.push(P(p[0])[0] - c.value); break;
			case 'py': out.push(P(p[0])[1] - c.value); break;
			case 'radius': out.push((s.length ? arcR(s[0]) : X[rIdx.get(ci[0])]) - c.value); break;
			case 'dia': out.push(2 * X[rIdx.get(ci[0])] - c.value); break;
			case 'tangent': {
				if (s.length === 2) {
					const pid = shared(s[0], s[1]);
					out.push(pid === undefined ? 0 : cross(away(s[0], pid), away(s[1], pid)));
				} else if (s.length === 1 && ci.length === 1) {
					// line tangent to circle: distance from the center to the line = radius
					const g = m.segs[s[0]], A = P(g.a), u = unit(chord(s[0])), C = P(m.circles[ci[0]].c);
					out.push(Math.abs(cross(u, [C[0] - A[0], C[1] - A[1]])) - X[rIdx.get(ci[0])]);
				} else out.push(0);
				break;
			}
			case 'coincident': { const a = P(p[0]), b = P(p[1]); out.push(a[0] - b[0], a[1] - b[1]); break; }
			case 'online': {
				const q = P(p[0]);
				if (ci.length) { const C = P(m.circles[ci[0]].c); out.push(hyp([q[0] - C[0], q[1] - C[1]]) - X[rIdx.get(ci[0])]); }
				else if (bulge(s[0])) { const C = arcC(s[0]); out.push(hyp([q[0] - C[0], q[1] - C[1]]) - arcR(s[0])); }
				else { const A = P(m.segs[s[0]].a); out.push(cross(unit(chord(s[0])), [q[0] - A[0], q[1] - A[1]])); }
				break;
			}
			case 'sym': {
				const a = P(p[0]), b = P(p[1]), A = P(m.segs[s[0]].a), u = unit(chord(s[0]));
				const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
				out.push(cross(u, [mid[0] - A[0], mid[1] - A[1]]), dot([b[0] - a[0], b[1] - a[1]], u));
				break;
			}
			case 'midpoint': { const q = P(p[0]), g = m.segs[s[0]], A = P(g.a), B = P(g.b); out.push(q[0] - (A[0] + B[0]) / 2, q[1] - (A[1] + B[1]) / 2); break; }
			case 'concentric': {
				const cen = (k) => (k < ci.length ? P(m.circles[ci[k]].c) : arcC(s[k - ci.length]));
				const a = cen(0), b = cen(1);
				out.push(a[0] - b[0], a[1] - b[1]);
				break;
			}
			default: break;
		}
	}
	return out;
}

export function validModelCon(c, m) {
	const okP = (c.p || []).every((i) => i >= 0 && i < m.points.length);
	const okS = (c.s || []).every((i) => i >= 0 && i < m.segs.length);
	const okC = (c.c || []).every((i) => i >= 0 && i < m.circles.length);
	if (!(okP && okS && okC)) return false;
	if (MODEL_CONSTRAINTS[c.type] && MODEL_CONSTRAINTS[c.type].value && !isFinite(c.value)) return false;
	if (c.type === 'radius' && (c.s || []).length && !m.segs[c.s[0]].arc) return false;
	if (c.type === 'angle' || (c.type === 'tangent' && (c.s || []).length === 2)) {
		const g = m.segs[c.s[0]], h = m.segs[c.s[1]];
		if (!g || !h || ![g.a, g.b].some((v) => v === h.a || v === h.b)) return false;
	}
	return true;
}

function lmSolve(F, X, free) {
	let r0 = F(X), err = r0.reduce((s, v) => s + v * v, 0);
	let lambda = 1e-3;
	const jac = (X0, r) => {
		const J = r.map(() => new Array(free.length).fill(0));
		for (let k = 0; k < free.length; k++) {
			const j = free[k], h = 1e-6 * Math.max(1, Math.abs(X0[j]));
			const xp = X0.slice(), xm = X0.slice();
			xp[j] += h; xm[j] -= h;
			const rp = F(xp), rm = F(xm);
			for (let i = 0; i < r.length; i++) J[i][k] = (rp[i] - rm[i]) / (2 * h);
		}
		return J;
	};
	let J = jac(X, r0);
	for (let it = 0; it < 200 && err > 1e-20; it++) {
		const mm = free.length;
		const A = Array.from({ length: mm }, () => new Array(mm).fill(0)), g = new Array(mm).fill(0);
		for (let i = 0; i < r0.length; i++) {
			const Ji = J[i];
			for (let a = 0; a < mm; a++) {
				if (!Ji[a]) continue;
				g[a] -= Ji[a] * r0[i];
				for (let b = 0; b < mm; b++) A[a][b] += Ji[a] * Ji[b];
			}
		}
		let improved = false;
		for (let tries = 0; tries < 12; tries++) {
			const Ad = A.map((row, a) => row.map((v, b) => (a === b ? v + lambda * (1 + v) : v)));
			const d = solveLinear(Ad, g);
			const Xn = X.slice();
			for (let k = 0; k < mm; k++) Xn[free[k]] += d[k];
			const rn = F(Xn), en = rn.reduce((s, v) => s + v * v, 0);
			if (en < err) { for (let k = 0; k < X.length; k++) X[k] = Xn[k]; err = en; r0 = rn; lambda = Math.max(lambda / 4, 1e-12); improved = true; break; }
			lambda *= 8;
		}
		if (!improved) break;
		J = jac(X, r0);
	}
	return err;
}

/**
 * Solve a sketch model in place. held: { points: [indices], vars: [variable indices] } stay fixed.
 * Returns { ok, bad: [constraint indices not satisfied], vars: { bIdx, rIdx } }.
 */
export function solveModel(m, held = {}) {
	const active = m.cons.filter((c) => validModelCon(c, m));
	const { X, bIdx, rIdx } = modelVars(m);
	if (active.length) {
		const fixed = new Set();
		for (const i of held.points || []) fixed.add(2 * i).add(2 * i + 1);
		for (const v of held.vars || []) fixed.add(v);
		for (const [, i] of rIdx) if (X[i] <= 0) X[i] = 1e-3;
		const free = X.map((_, i) => i).filter((i) => !fixed.has(i));
		lmSolve((Y) => modelResiduals(m, Y, bIdx, rIdx, active), X, free);
	}
	m.points = m.points.map((_, i) => [X[2 * i], X[2 * i + 1]]);
	for (const [s, i] of bIdx) m.segs[s].arc = Math.abs(X[i]) < 1e-9 ? 1e-9 : X[i];
	for (const [c, i] of rIdx) m.circles[c].r = Math.max(1e-3, X[i]);
	const bad = [];
	m.cons.forEach((c, i) => {
		if (!validModelCon(c, m)) return;
		const r = modelResiduals(m, X, bIdx, rIdx, [c]);
		if (r.reduce((s, v) => s + v * v, 0) > 1e-8) bad.push(i);
	});
	return { ok: !bad.length, bad, vars: { bIdx, rIdx } };
}

/** Remaining degrees of freedom of a sketch model. */
export function modelDOF(m) {
	const { X, bIdx, rIdx } = modelVars(m);
	const active = m.cons.filter((c) => validModelCon(c, m));
	if (!active.length) return X.length;
	const r0 = modelResiduals(m, X, bIdx, rIdx, active);
	const M = r0.map(() => new Array(X.length).fill(0));
	for (let j = 0; j < X.length; j++) {
		const h = 1e-6 * Math.max(1, Math.abs(X[j]));
		const xp = X.slice(), xm = X.slice();
		xp[j] += h; xm[j] -= h;
		const rp = modelResiduals(m, xp, bIdx, rIdx, active), rm = modelResiduals(m, xm, bIdx, rIdx, active);
		for (let i = 0; i < r0.length; i++) M[i][j] = (rp[i] - rm[i]) / (2 * h);
	}
	let rank = 0;
	for (let c = 0; c < X.length && rank < M.length; c++) {
		let p = rank;
		for (let r = rank + 1; r < M.length; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
		if (Math.abs(M[p][c]) < 1e-9) continue;
		[M[rank], M[p]] = [M[p], M[rank]];
		for (let r = rank + 1; r < M.length; r++) { const f = M[r][c] / M[rank][c]; for (let k = c; k < X.length; k++) M[r][k] -= f * M[rank][k]; }
		rank++;
	}
	return X.length - rank;
}
