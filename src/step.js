// STEP (ISO 10303-21, AP214) export of triangle meshes as B-rep solids.
// Coplanar neighboring triangles are merged into planar faces (with holes); smooth patches that fit a cylinder
// (holes, pins, round edges) become true CYLINDRICAL_SURFACE faces bounded by CIRCLE / LINE edges, shared with
// their flat neighbors. Anything else stays faceted. Each connected shell becomes a MANIFOLD_SOLID_BREP.

function stepNum(v) {
	if (!isFinite(v)) v = 0;
	let r = Math.round(v * 1e6) / 1e6;
	if (Object.is(r, -0) || Math.abs(r) < 1e-9) r = 0;
	let s = String(r);
	if (/e/i.test(s)) {
		const [m, e] = r.toExponential().split('e');
		s = (m.includes('.') ? m : m + '.') + 'E' + e;
	} else if (!s.includes('.')) s += '.';
	return s;
}

function stepStr(s) {
	return "'" + String(s).replace(/'/g, "''").replace(/[^\x20-\x7e]/g, '_') + "'";
}

// Weld vertices and return indexed triangles (degenerates removed).
function weld(positions) {
	const map = new Map(), V = [], T = [];
	const key = (x, y, z) => `${Math.round(x * 1e5)},${Math.round(y * 1e5)},${Math.round(z * 1e5)}`;
	const vid = (i) => {
		const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
		const k = key(x, y, z);
		let id = map.get(k);
		if (id === undefined) { id = V.length; V.push([x, y, z]); map.set(k, id); }
		return id;
	};
	for (let t = 0; t < positions.length / 9; t++) {
		const a = vid(t * 3), b = vid(t * 3 + 1), c = vid(t * 3 + 2);
		if (a === b || b === c || a === c) continue;
		T.push([a, b, c]);
	}
	return { V, T };
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/**
 * Build STEP text from a non-indexed triangle position array (mm).
 * Returns { text, faces, solids }.
 */
export function stepFromPositions(positions, name = 'DraftOtter part') {
	const { V, T } = weld(positions);
	const N = T.map(([a, b, c]) => norm(cross(sub(V[b], V[a]), sub(V[c], V[a]))));
	// triangle adjacency through directed edges
	const edgeTri = new Map();
	T.forEach(([a, b, c], t) => { for (const [p, q] of [[a, b], [b, c], [c, a]]) edgeTri.set(p + '>' + q, t); });
	const neighbors = (t) => { const [a, b, c] = T[t]; return [[b, a], [c, b], [a, c]].map(([p, q]) => edgeTri.get(p + '>' + q)).filter((x) => x !== undefined); };

	// 1. planar regions (coplanar, edge-connected triangles)
	const region = new Int32Array(T.length).fill(-1);
	const regions = [];
	for (let s = 0; s < T.length; s++) {
		if (region[s] >= 0) continue;
		const n = N[s], d = dot(n, V[T[s][0]]);
		const r = regions.length, list = [s];
		region[s] = r;
		for (let k = 0; k < list.length; k++) {
			for (const u of neighbors(list[k])) {
				if (region[u] >= 0) continue;
				if (dot(N[u], n) < 1 - 1e-7) continue;
				if (T[u].some((vi) => Math.abs(dot(n, V[vi]) - d) > 1e-4)) continue;
				region[u] = r;
				list.push(u);
			}
		}
		regions.push({ tris: list, n });
	}

	// 2. solids = connected components of triangles
	const comp = new Int32Array(T.length).fill(-1);
	let ncomp = 0;
	for (let s = 0; s < T.length; s++) {
		if (comp[s] >= 0) continue;
		const st = [s];
		comp[s] = ncomp;
		while (st.length) { const t = st.pop(); for (const u of neighbors(t)) if (comp[u] < 0) { comp[u] = ncomp; st.push(u); } }
		ncomp++;
	}

	// 3. cylinders: smooth patches (planar regions meeting at < 25°) whose normals all lie in one plane and
	// whose vertices sit on one circle around the axis. Their boundaries are split into chains (by neighbor face)
	// that must be circles around the axis or lines along it, otherwise the patch stays faceted.
	const regionOfTri = region;
	const cyl = findCylinders(V, T, N, regions, regionOfTri, edgeTri);
	const inCyl = new Int32Array(regions.length).fill(-1);
	cyl.forEach((c, ci) => { for (const r of c.regions) inCyl[r] = ci; });
	const chainOfEdge = new Map(); // undirected mesh edge -> chain
	for (const c of cyl) for (const ch of c.chains) for (let i = 0; i + 1 < ch.vs.length; i++) chainOfEdge.set(ukey(ch.vs[i], ch.vs[i + 1]), ch);

	// 4. entity writer
	const lines = [];
	let id = 30;
	const ent = (s) => { const k = '#' + id++; lines.push(`${k}=${s};`); return k; };
	const pointId = new Map(), vertexId = new Map();
	const cpt = (vi) => { if (!pointId.has(vi)) pointId.set(vi, ent(`CARTESIAN_POINT('',(${V[vi].map(stepNum).join(',')}))`)); return pointId.get(vi); };
	const vtx = (vi) => { if (!vertexId.has(vi)) vertexId.set(vi, ent(`VERTEX_POINT('',${cpt(vi)})`)); return vertexId.get(vi); };
	const edges = new Map(); // undirected key -> { id, a, b }
	const edgeCurve = (a, b) => {
		const k = a < b ? a + '_' + b : b + '_' + a;
		let e = edges.get(k);
		if (!e) {
			const d = sub(V[b], V[a]), len = Math.hypot(...d);
			const dir = ent(`DIRECTION('',(${norm(d).map(stepNum).join(',')}))`);
			const vec = ent(`VECTOR('',${dir},${stepNum(len)})`);
			const line = ent(`LINE('',${cpt(a)},${vec})`);
			e = { id: ent(`EDGE_CURVE('',${vtx(a)},${vtx(b)},${line},.T.)`), a, b };
			edges.set(k, e);
		}
		return `ORIENTED_EDGE('',*,*,${e.id},${e.a === a ? '.T.' : '.F.'})`;
	};
	const dirEnt = (v) => ent(`DIRECTION('',(${norm(v).map(stepNum).join(',')}))`);
	const ptEnt = (p) => ent(`CARTESIAN_POINT('',(${p.map(stepNum).join(',')}))`);
	// one EDGE_CURVE per chain (circle arc / full circle / line), created on first use
	const chainEdge = (ch) => {
		if (ch.id) return ch.id;
		const a = ch.vs[0], b = ch.vs[ch.vs.length - 1];
		let curve;
		if (ch.kind === 'circle') {
			curve = ent(`CIRCLE('',${ent(`AXIS2_PLACEMENT_3D('',${ptEnt(ch.center)},${dirEnt(ch.axis)},${dirEnt(ch.ref)})`)},${stepNum(ch.r)})`);
		} else {
			const d = sub(V[b], V[a]), len = Math.hypot(...d);
			curve = ent(`LINE('',${cpt(a)},${ent(`VECTOR('',${dirEnt(d)},${stepNum(len)})`)})`);
		}
		ch.id = ent(`EDGE_CURVE('',${vtx(a)},${vtx(b)},${curve},${ch.kind === 'circle' ? (ch.ccw ? '.T.' : '.F.') : '.T.'})`);
		return ch.id;
	};
	/** Oriented edges for a directed vertex loop, with chained runs collapsed into their curve edge. */
	const loopEdges = (lp) => {
		const n = lp.length;
		const chainAt = (k) => chainOfEdge.get(ukey(lp[k], lp[(k + 1) % n])) || null;
		// start where a chain begins (or at any unchained edge) so no chain is split across the start
		let s = 0;
		for (let k = 0; k < n; k++) { const c = chainAt(k); if (!c || c !== chainAt((k - 1 + n) % n)) { s = k; break; } }
		const out = [];
		for (let i = 0; i < n; i++) {
			const k = (s + i) % n, c = chainAt(k);
			if (!c) { out.push(ent(edgeCurve(lp[k], lp[(k + 1) % n]))); continue; }
			if (i > 0 && c === chainAt((k - 1 + n) % n)) continue; // rest of the same chain
			const a = lp[k], b = lp[(k + 1) % n];
			const idx = c.vs.indexOf(a);
			const forward = c.vs[idx + 1] === b || (c.closed && idx === c.vs.length - 1 && c.vs[1] === b);
			out.push(ent(`ORIENTED_EDGE('',*,*,${chainEdge(c)},${forward ? '.T.' : '.F.'})`));
		}
		return out;
	};

	const shellFaces = Array.from({ length: ncomp }, () => []);
	let faceCount = 0;
	regions.forEach((reg, ri) => { if (inCyl[ri] < 0) writePlanar(reg); });
	for (const c of cyl) {
		const bounds = c.loops.map((lp) => ent(`FACE_BOUND('',${ent(`EDGE_LOOP('',(${loopEdges(lp).join(',')}))`)},.T.)`));
		const surf = ent(`CYLINDRICAL_SURFACE('',${ent(`AXIS2_PLACEMENT_3D('',${ptEnt(c.origin)},${dirEnt(c.axis)},${dirEnt(c.ref)})`)},${stepNum(c.r)})`);
		shellFaces[comp[c.tris[0]]].push(ent(`ADVANCED_FACE('',(${bounds.join(',')}),${surf},${c.outward ? '.T.' : '.F.'})`));
		faceCount++;
	}
	function writePlanar(reg) {
		// boundary = directed edges whose reverse is not in the same region
		const inReg = new Set();
		for (const t of reg.tris) { const [a, b, c] = T[t]; inReg.add(a + '>' + b); inReg.add(b + '>' + c); inReg.add(c + '>' + a); }
		const out = new Map(); // start vertex -> [end vertices]
		for (const k of inReg) {
			const [a, b] = k.split('>').map(Number);
			if (inReg.has(b + '>' + a)) continue;
			if (!out.has(a)) out.set(a, []);
			out.get(a).push(b);
		}
		// walk loops
		const loops = [];
		for (const [start] of out) {
			while (out.get(start) && out.get(start).length) {
				const loop = [start];
				let cur = out.get(start).pop();
				let guard = 0;
				while (cur !== start && guard++ < 1e6) {
					loop.push(cur);
					const nx = out.get(cur);
					if (!nx || !nx.length) break;
					cur = nx.pop();
				}
				if (loop.length >= 3) loops.push(loop);
			}
		}
		if (!loops.length) return;
		// plane basis, signed areas: the outer loop runs counter-clockwise about the normal
		const n = reg.n, o = V[loops[0][0]];
		const ref = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
		const xd = norm(cross(ref, n)), yd = cross(n, xd);
		const area = (lp) => { let s = 0; for (let i = 0; i < lp.length; i++) { const p = sub(V[lp[i]], o), q = sub(V[lp[(i + 1) % lp.length]], o); s += dot(p, xd) * dot(q, yd) - dot(q, xd) * dot(p, yd); } return s / 2; };
		loops.sort((a, b) => Math.abs(area(b)) - Math.abs(area(a)));
		const bounds = loops.map((lp, i) => {
			const el = ent(`EDGE_LOOP('',(${loopEdges(lp).join(',')}))`);
			return ent(`${i === 0 ? 'FACE_OUTER_BOUND' : 'FACE_BOUND'}('',${el},.T.)`);
		});
		const ax = ent(`AXIS2_PLACEMENT_3D('',${cpt(loops[0][0])},${ent(`DIRECTION('',(${n.map(stepNum).join(',')}))`)},${ent(`DIRECTION('',(${xd.map(stepNum).join(',')}))`)})`);
		const plane = ent(`PLANE('',${ax})`);
		shellFaces[comp[reg.tris[0]]].push(ent(`ADVANCED_FACE('',(${bounds.join(',')}),${plane},.T.)`));
		faceCount++;
	}
	const breps = shellFaces.filter((f) => f.length).map((faces, i, all) => {
		const shell = ent(`CLOSED_SHELL('',(${faces.join(',')}))`);
		return ent(`MANIFOLD_SOLID_BREP(${stepStr(all.length > 1 ? `${name} ${i + 1}` : name)},${shell})`);
	});

	const now = new Date().toISOString().slice(0, 19);
	const head = [
		'ISO-10303-21;', 'HEADER;',
		`FILE_DESCRIPTION(('DraftOtter faceted solid export'),'2;1');`,
		`FILE_NAME(${stepStr(name + '.step')},'${now}',('DraftOtter'),(''),'DraftOtter','DraftOtter','');`,
		`FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));`, 'ENDSEC;', 'DATA;',
		`#1=APPLICATION_CONTEXT('core data for automotive mechanical design processes');`,
		`#2=APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#1);`,
		`#3=PRODUCT_CONTEXT('',#1,'mechanical');`,
		`#4=PRODUCT_DEFINITION_CONTEXT('part definition',#1,'design');`,
		`#5=PRODUCT(${stepStr(name)},${stepStr(name)},'',(#3));`,
		`#6=PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,(#5));`,
		`#7=PRODUCT_DEFINITION_FORMATION('','',#5);`,
		`#8=PRODUCT_DEFINITION('design','',#7,#4);`,
		`#9=PRODUCT_DEFINITION_SHAPE('','',#8);`,
		`#10=SHAPE_DEFINITION_REPRESENTATION(#9,#20);`,
		`#11=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));`,
		`#12=(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.));`,
		`#13=(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT());`,
		`#14=UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-05),#11,'distance_accuracy_value','confusion accuracy');`,
		`#15=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#14))GLOBAL_UNIT_ASSIGNED_CONTEXT((#11,#12,#13))REPRESENTATION_CONTEXT('Context #1','3D Context with UNIT and UNCERTAINTY'));`,
		`#16=CARTESIAN_POINT('',(0.,0.,0.));`,
		`#17=DIRECTION('',(0.,0.,1.));`,
		`#18=DIRECTION('',(1.,0.,0.));`,
		`#19=AXIS2_PLACEMENT_3D('',#16,#17,#18);`,
		`#20=ADVANCED_BREP_SHAPE_REPRESENTATION(${stepStr(name)},(#19${breps.map((b) => ',' + b).join('')}),#15);`,
	];
	const text = [...head, ...lines, 'ENDSEC;', 'END-ISO-10303-21;', ''].join('\n');
	return { text, faces: faceCount, solids: breps.length, cylinders: cyl.length };
}

const ukey = (a, b) => (a < b ? a + '_' + b : b + '_' + a);

// ---------------------------------------------------------------- cylinder detection

function eigenSmallest(C) {
	// smallest eigenvector of a symmetric 3×3 matrix (Jacobi)
	const a = C.map((r) => r.slice()), v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
	for (let it = 0; it < 50; it++) {
		let p = 0, q = 1;
		if (Math.abs(a[0][2]) > Math.abs(a[p][q])) { p = 0; q = 2; }
		if (Math.abs(a[1][2]) > Math.abs(a[p][q])) { p = 1; q = 2; }
		if (Math.abs(a[p][q]) < 1e-14) break;
		const th = 0.5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]), c = Math.cos(th), s = Math.sin(th);
		for (let k = 0; k < 3; k++) { const x = a[k][p], y = a[k][q]; a[k][p] = c * x - s * y; a[k][q] = s * x + c * y; }
		for (let k = 0; k < 3; k++) { const x = a[p][k], y = a[q][k]; a[p][k] = c * x - s * y; a[q][k] = s * x + c * y; }
		for (let k = 0; k < 3; k++) { const x = v[k][p], y = v[k][q]; v[k][p] = c * x - s * y; v[k][q] = s * x + c * y; }
	}
	let m = 0;
	for (let i = 1; i < 3; i++) if (a[i][i] < a[m][m]) m = i;
	const tr = a[0][0] + a[1][1] + a[2][2] || 1;
	return { vec: norm([v[0][m], v[1][m], v[2][m]]), ratio: a[m][m] / tr };
}

function circleFit2(P) {
	let mx = 0, my = 0;
	for (const [x, y] of P) { mx += x; my += y; }
	mx /= P.length; my /= P.length;
	let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
	for (const [x, y] of P) {
		const u = x - mx, v = y - my;
		suu += u * u; svv += v * v; suv += u * v; suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u;
	}
	const det = suu * svv - suv * suv;
	if (Math.abs(det) < 1e-14) return null;
	const b1 = (suuu + suvv) / 2, b2 = (svvv + svuu) / 2;
	const uc = (b1 * svv - b2 * suv) / det, vc = (suu * b2 - suv * b1) / det;
	return { cx: uc + mx, cy: vc + my, r: Math.sqrt(uc * uc + vc * vc + (suu + svv) / P.length) };
}

function findCylinders(V, T, N, regions, regionOfTri, edgeTri) {
	const out = [];
	// smooth patches: union regions across edges with a small angle
	const parent = regions.map((_, i) => i);
	const find = (x) => { while (parent[x] !== x) x = parent[x] = parent[parent[x]]; return x; };
	const cos25 = Math.cos((25 * Math.PI) / 180);
	T.forEach(([a, b, c], t) => {
		for (const [p, q] of [[a, b], [b, c], [c, a]]) {
			const u = edgeTri.get(q + '>' + p);
			if (u === undefined) continue;
			const ra = regionOfTri[t], rb = regionOfTri[u];
			if (ra !== rb && dot(regions[ra].n, regions[rb].n) > cos25) parent[find(ra)] = find(rb);
		}
	});
	const patches = new Map();
	regions.forEach((_, i) => { const r = find(i); if (!patches.has(r)) patches.set(r, []); patches.get(r).push(i); });
	const testPatch = (regs) => {
		if (regs.length < 3) return null;
		const tris = regs.flatMap((r) => regions[r].tris);
		// axis = direction all the normals are perpendicular to
		const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
		for (const t of tris) { const n = N[t]; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] += n[i] * n[j]; }
		const { vec: axis, ratio } = eigenSmallest(C);
		if (ratio > 1e-4) return null;
		const ref = norm(cross(Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], axis)), yd = cross(axis, ref);
		const vs = [...new Set(tris.flatMap((t) => T[t]))];
		const P = vs.map((vi) => [dot(V[vi], ref), dot(V[vi], yd)]);
		const f = circleFit2(P);
		if (!f || !(f.r > 1e-3)) return null;
		const tol = Math.max(2e-4, f.r * 2e-4);
		if (P.some(([x, y]) => Math.abs(Math.hypot(x - f.cx, y - f.cy) - f.r) > tol)) return null;
		const origin = [ref[0] * f.cx + yd[0] * f.cy, ref[1] * f.cx + yd[1] * f.cy, ref[2] * f.cx + yd[2] * f.cy];
		// outward = mesh normals point away from the axis
		const t0 = tris[0], c0 = [0, 1, 2].map((k) => (V[T[t0][0]][k] + V[T[t0][1]][k] + V[T[t0][2]][k]) / 3);
		const rad = sub(c0, origin), radial = sub(rad, axis.map((x) => x * dot(rad, axis)));
		const outward = dot(radial, N[t0]) > 0;
		// boundary loops of the patch and their chains (split where the neighbor face changes)
		const triSet = new Set(tris);
		const outEdges = new Map(), nbr = new Map();
		for (const t of tris) {
			const [a, b, c] = T[t];
			for (const [p, q] of [[a, b], [b, c], [c, a]]) {
				const u = edgeTri.get(q + '>' + p);
				if (u !== undefined && triSet.has(u)) continue;
				if (!outEdges.has(p)) outEdges.set(p, []);
				outEdges.get(p).push(q);
				nbr.set(p + '>' + q, u === undefined ? -1 : regionOfTri[u]);
			}
		}
		const loops = [];
		let bad = false;
		for (const [s0] of outEdges) {
			while (outEdges.get(s0) && outEdges.get(s0).length) {
				const lp = [s0];
				let cur = outEdges.get(s0).pop(), guard = 0;
				while (cur !== s0 && guard++ < 1e6) { lp.push(cur); const nx = outEdges.get(cur); if (!nx || !nx.length) { bad = true; break; } cur = nx.pop(); }
				if (lp.length >= 2) loops.push(lp);
			}
		}
		if (bad || !loops.length) return null;
		const chains = [];
		for (const lp of loops) {
			const n = lp.length, nb = (k) => nbr.get(lp[k] + '>' + lp[(k + 1) % n]);
			let s = 0;
			for (let k = 0; k < n; k++) if (nb(k) !== nb((k - 1 + n) % n)) { s = k; break; }
			const closedAll = lp.every((_, k) => nb(k) === nb(0));
			let cur = null;
			for (let i = 0; i < n; i++) {
				const k = (s + i) % n;
				if (!cur || nb(k) !== cur.nb) { cur = { nb: nb(k), vs: [lp[k]] }; chains.push(cur); }
				cur.vs.push(lp[(k + 1) % n]);
			}
			if (closedAll) chains[chains.length - 1].closed = true;
		}
		// classify chains
		for (const ch of chains) {
			const pts = ch.vs.map((v) => V[v]);
			const h = pts.map((p) => dot(sub(p, origin), axis));
			const flat = Math.max(...h) - Math.min(...h) < tol;
			const radial = pts.every((p) => { const d = sub(p, origin), dd = sub(d, axis.map((x) => x * dot(d, axis))); return Math.abs(Math.hypot(...dd) - f.r) < tol; });
			if (flat && radial && pts.length >= 3) {
				const hc = h.reduce((x, y) => x + y, 0) / h.length;
				ch.kind = 'circle';
				ch.center = origin.map((o, k) => o + axis[k] * hc);
				ch.axis = axis; ch.ref = ref; ch.r = f.r;
				const a = sub(pts[0], ch.center), b = sub(pts[1], ch.center);
				ch.ccw = dot(cross(a, b), axis) > 0;
				continue;
			}
			const d = sub(pts[pts.length - 1], pts[0]), L = Math.hypot(...d);
			const along = L > tol && Math.abs(Math.abs(dot(norm(d), axis)) - 1) < 1e-6;
			const straight = pts.every((p) => Math.hypot(...cross(sub(p, pts[0]), norm(d))) < tol);
			if (along && straight && !ch.closed) { ch.kind = 'line'; continue; }
			bad = true;
			break;
		}
		if (bad) return null;
		return { regions: regs, tris, axis, ref, origin, r: f.r, outward, loops, chains };
	};
	// region adjacency within smooth patches, and region areas
	const adj = regions.map(() => new Set());
	T.forEach(([a, b, c], t) => {
		for (const [p, q] of [[a, b], [b, c], [c, a]]) {
			const u = edgeTri.get(q + '>' + p);
			if (u === undefined) continue;
			const ra = regionOfTri[t], rb = regionOfTri[u];
			if (ra !== rb && dot(regions[ra].n, regions[rb].n) > cos25) { adj[ra].add(rb); adj[rb].add(ra); }
		}
	});
	const area = regions.map((r) => r.tris.reduce((s2, t) => { const [a, b, c] = T[t]; return s2 + Math.hypot(...cross(sub(V[b], V[a]), sub(V[c], V[a]))) / 2; }, 0));
	for (const regs of patches.values()) {
		const whole = testPatch(regs);
		if (whole) { out.push(whole); continue; }
		if (regs.length < 4) continue;
		// tangent flat faces (slots, rounded rectangles) join the round parts into one patch: drop the large
		// regions and try each remaining connected piece on its own
		const sorted = regs.map((r) => area[r]).sort((x, y) => x - y), median = sorted[Math.floor(sorted.length / 2)];
		const keep = new Set(regs.filter((r) => area[r] <= median * 4));
		const seen = new Set();
		for (const r0 of keep) {
			if (seen.has(r0)) continue;
			const comp = [r0];
			seen.add(r0);
			for (let i = 0; i < comp.length; i++) for (const nb of adj[comp[i]]) if (keep.has(nb) && !seen.has(nb)) { seen.add(nb); comp.push(nb); }
			const c = testPatch(comp);
			if (c) out.push(c);
		}
	}
	return out;
}
