// Geometry evaluation: cached primitive builds, non-destructive CSG groups, world baking and stats.
import * as THREE from 'three';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';
import { Brush, Evaluator, ADDITION, SUBTRACTION, INTERSECTION } from 'three-bvh-csg';
import { buildShape, flipWinding, signedVolume } from './shapes.js';
import { DEG, round } from './util.js';
import { fitClearance, fittedParams, fitAxes } from './fits.js';
import { hashKey, getFit, putFit } from './fitcache.js';
import { setMF, toManifold, rawOf, csgRaw, moveFace, offsetSurface, growRaw, hullPoints, setFastFit as setCoreFastFit } from './csgcore.js';
import { TEXTURE_DEFAULTS, DEFORM_DEFAULTS } from './modifiers.js';
import { faceRegion } from './pushpull.js';
import { snapTo, snapMeasured, snapAngle } from './rounding.js';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

let MF = null; // manifold-3d wasm module

export async function initManifold(Module, wasmBinary) {
	try {
		const mod = await Module(wasmBinary ? { wasmBinary } : {});
		mod.setup();
		MF = mod;
		setMF(mod);
	} catch (e) {
		console.warn('manifold-3d unavailable, using fallback CSG', e);
	}
	return !!MF;
}

export function hasManifold() { return !!MF; }

// Coordinates permuted so `axis` becomes Z (cyclic permutations keep handedness): plane coords (u, v) are
// x: (y, z) · y: (z, x) · z: (x, y).
const PERM = { x: [1, 2, 0], y: [2, 0, 1], z: [0, 1, 2] };
export function fromPlane(axis, u, v, w) {
	const out = [0, 0, 0], p = PERM[axis];
	out[p[0]] = u; out[p[1]] = v; out[p[2]] = w;
	return out;
}
function permuted(geom, axis) {
	const p = PERM[axis], src = geom.attributes.position.array, dst = new Float32Array(src.length);
	for (let i = 0; i < src.length; i += 3) { dst[i] = src[i + p[0]]; dst[i + 1] = src[i + p[1]]; dst[i + 2] = src[i + p[2]]; }
	const g = new THREE.BufferGeometry();
	g.setAttribute('position', new THREE.BufferAttribute(dst, 3));
	return g;
}

/**
 * Cross-section of a closed world mesh by the plane axis = pos, optionally inset by `inset` mm.
 * Returns { polygons: [[[u, v], …], …] in plane coordinates, area } or null without Manifold.
 */
export function sectionAt(geom, axis, pos, inset = 0) {
	if (!MF) return null;
	const made = [];
	try {
		const g = geom.index ? geom.toNonIndexed() : geom;
		const m = toManifold(permuted(g, axis));
		made.push(m);
		let cs = m.slice(pos);
		made.push(cs);
		if (inset) { cs = cs.offset(-inset, 'Round'); made.push(cs); }
		return { polygons: cs.toPolygons().map((poly) => poly.map((q) => [q[0], q[1]])), area: cs.area() };
	} catch (e) {
		console.warn(e);
		return null;
	} finally {
		for (const x of made) x.delete();
	}
}

/** The half of a closed mesh on one side of the plane axis = pos (keepAbove: the side with larger values). */
export function clipHalf(geom, axis, pos, keepAbove = true) {
	if (!MF) return null;
	const made = [];
	try {
		const m = toManifold(geom.index ? geom.toNonIndexed() : geom);
		made.push(m);
		const n = [0, 0, 0]; n[{ x: 0, y: 1, z: 2 }[axis]] = keepAbove ? 1 : -1;
		const h = m.trimByPlane(n, keepAbove ? pos : -pos);
		made.push(h);
		return h.isEmpty() ? null : fromManifold(h);
	} catch (err) {
		console.warn(err);
		return null;
	} finally {
		for (const x of made) x.delete();
	}
}

/** Overlap of two closed world meshes: { volume, geometry } (geometry null when they don't overlap). */
export function overlapOf(a, b) {
	if (!MF) return null;
	const made = [];
	try {
		const ma = toManifold(a.index ? a.toNonIndexed() : a), mb = toManifold(b.index ? b.toNonIndexed() : b);
		made.push(ma, mb);
		const x = ma.intersect(mb);
		made.push(x);
		const volume = x.isEmpty() ? 0 : x.volume();
		return { volume, geometry: volume > 1e-6 ? fromManifold(x) : null };
	} catch (e) {
		console.warn(e);
		return null;
	} finally {
		for (const m of made) m.delete();
	}
}

/** Separate shells of a closed mesh (e.g. disconnected pieces after a union). */
export function shellsOf(geom) {
	if (!MF) return null;
	const made = [];
	try {
		const m = toManifold(geom.index ? geom.toNonIndexed() : geom);
		made.push(m);
		const parts = m.decompose();
		made.push(...parts);
		return parts.map((p) => fromManifold(p));
	} catch (e) {
		console.warn(e);
		return null;
	} finally {
		for (const m of made) m.delete();
	}
}

// Note: getMesh(normalIdx) faults in manifold-3d 3.5, so normals are rebuilt with a crease angle instead.
/** Kernel result arrays → three.js geometry with creased normals. */
export function geomFromRaw(r) {
	const g = new THREE.BufferGeometry();
	g.setAttribute('position', new THREE.BufferAttribute(r.pos, 3));
	g.setIndex(new THREE.BufferAttribute(r.idx, 1));
	return toCreasedNormals(g, 30 * DEG);
}
function fromManifold(m) { return geomFromRaw(rawOf(m)); }

/** Worker output (non-indexed triangles with normals) → three.js geometry. */
function geomFromCreased(r) {
	const g = new THREE.BufferGeometry();
	g.setAttribute('position', new THREE.BufferAttribute(r.pos, 3));
	g.setAttribute('normal', new THREE.BufferAttribute(r.normal, 3));
	return g;
}
function manifoldCSG(solids, holes, intersect, offset = 0, mod = null) { const r = csgRaw(solids, holes, intersect, offset, mod); return r && geomFromRaw(r); }

// Memory budgets: built shapes (bytes of vertex data) and live kernel solids (triangles, ~100 bytes each)
const GEOM_BUDGET = 150e6, MANIFOLD_TRI_BUDGET = 3e6;
// vertex data, plus the triangle index and BVH the viewport adds for picking (often as big as the vertices)
const geomBytes = (g) => {
	if (!g || !g.attributes) return 0;
	let b = g.index ? g.index.array.byteLength : 0;
	for (const k in g.attributes) b += g.attributes[k].array.byteLength;
	for (const r of (g.boundsTree && g.boundsTree._roots) || []) b += r.byteLength || 0;
	return b;
};


// Push/pull features act on the part as it was when they were made, so a group holding a face move, or material
// added by push/pull after a cut (e.g. thickening a filleted wall), is built in order rather than "all solids, then
// all holes" (which would cut the fillet out of the new material too)
const PULLS = new Set(['facex']);
const hasMoves = (g) => {
	let cut = false;
	for (const c of g.children || []) {
		if (c.type === 'facemove' || c.type === 'faceoff') return true;
		if (c.type === 'facex' && c.params && c.params.ref) return true; // finds its face again on the part built before it
		if (c.hole) cut = true;
		else if (cut && PULLS.has(c.type)) return true;
	}
	return false;
};

// Groups whose result is computed as a mesh (not kept as a live Manifold): hulls, offsets and the modifiers.
const MESH_MODES = new Set(['hull', 'offset', 'texture', 'deform']);

/** Bounding box { min, max } of non-indexed position arrays. */
function boxOfArrays(arrs) {
	const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
	for (const a of arrs) for (let i = 0; i < a.length; i += 3) for (let k = 0; k < 3; k++) { const v = a[i + k]; if (v < min[k]) min[k] = v; if (v > max[k]) max[k] = v; }
	return { min, max };
}

/** A texture / deform group's modifier for the kernel, given its solids (position arrays in the group frame). */
export function modifierOf(group, solidArrays) {
	if (group.mode === 'texture') return { kind: 'texture', ...TEXTURE_DEFAULTS, ...(group.texture || {}), box: boxOfArrays(solidArrays) };
	if (group.mode === 'deform') return { kind: 'deform', ...DEFORM_DEFAULTS, ...(group.deform || {}), box: boxOfArrays(solidArrays) };
	return null;
}
export function growMany(geoms, c, axes) { const r = growRaw(geoms, c, axes); return r && geomFromRaw(r); }
const growAlong = (geom, c, axes) => growMany([geom], c, axes);
let fastFit = true;
/** Turn the convex / extrusion shortcuts off (tests compare them with the plain Minkowski result). */
export function setFastFit(on) { fastFit = !!on; setCoreFastFit(on); }

const evaluator = new Evaluator();
evaluator.attributes = ['position', 'normal'];
evaluator.useGroups = false;

const _e = new THREE.Euler();
const _q = new THREE.Quaternion();

/**
 * Matrix entries with the rounding crumbs of rotations removed (cos 90° is 6e-17, not 0). Faces meant to line up
 * exactly then do, so a cut flush with a face removes it cleanly instead of leaving a skin 1e-15 mm thick.
 */
/** The planes of a symmetric group: axis A, center C, unit directions in the planes (d) and their normals (m). */
export function symmetryPlanes(sym = {}) {
	const A = new THREE.Vector3(...(sym.axis || [0, 0, 1])).normalize();
	if (!(A.lengthSq() > 0.5)) A.set(0, 0, 1);
	const C = new THREE.Vector3(...(sym.center || [0, 0, 0]));
	const n = Math.max(1, Math.min(24, Math.round(sym.n || 1)));
	// in-plane basis: X-ish for a vertical axis, Z-ish for a horizontal one
	const ref = Math.abs(A.z) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
	const U = ref.clone().addScaledVector(A, -A.dot(ref)).normalize(), V = new THREE.Vector3().crossVectors(A, U);
	const t0 = ((sym.angle || 0) * Math.PI) / 180;
	const planes = [];
	for (let k = 0; k < n; k++) {
		const t = t0 + (k * Math.PI) / n;
		const d = U.clone().multiplyScalar(Math.cos(t)).addScaledVector(V, Math.sin(t));
		planes.push({ d, m: new THREE.Vector3().crossVectors(A, d) });
	}
	return { A, C, n, U, V, t0, planes };
}

/**
 * Make a solid n-fold mirror-symmetric: keep the wedge between the first two planes (angle → angle + 180°/n around
 * the axis through the center), mirror it across the first plane, and turn both copies around the axis n times.
 * n = 1 is a plain mirror: the half in front of the plane is kept and mirrored. temps collects intermediates to free.
 */
export function symmetrize(acc, sym, temps = []) {
	const { A, C, n, planes } = symmetryPlanes(sym);
	const keep = (m) => { temps.push(m); return m; };
	const m0 = planes[0].m;
	let wedge = keep(acc.trimByPlane([m0.x, m0.y, m0.z], m0.dot(C)));
	if (n > 1) {
		const t1 = planes[0].d.clone().applyAxisAngle(A, Math.PI / n), m1 = new THREE.Vector3().crossVectors(A, t1).negate();
		wedge = keep(wedge.trimByPlane([m1.x, m1.y, m1.z], m1.dot(C)));
	}
	if (wedge.isEmpty()) return keep(wedge.translate([0, 0, 0]));
	const mirrored = keep(keep(keep(wedge.translate([-C.x, -C.y, -C.z])).mirror([m0.x, m0.y, m0.z])).translate([C.x, C.y, C.z]));
	const pieces = [wedge, mirrored];
	for (let k = 1; k < n; k++) {
		const R = new THREE.Matrix4().makeTranslation(C.x, C.y, C.z).multiply(new THREE.Matrix4().makeRotationAxis(A, (2 * Math.PI * k) / n)).multiply(new THREE.Matrix4().makeTranslation(-C.x, -C.y, -C.z));
		const e = Array.from(R.elements);
		pieces.push(keep(wedge.transform(e)), keep(mirrored.transform(e)));
	}
	return MF.Manifold.union(pieces);
}

/**
 * A push/pull prism is measured off 32-bit mesh data, so its corners sit up to a fraction of a micron (or, where the
 * outline was rounded to whole microns, half a micron) beside the part's own corners. Joined or cut like that, they
 * leave hairline ledges and sliver triangles along the face's edges. This moves each corner column of the prism so
 * its foot lands exactly (in 64-bit, sideways) on the part's matching vertex on the face plane — at most a few microns — so
 * the prism's sides continue the part's sides exactly. M is the feature's placement (its Z = the face normal).
 * Returns the fitted prism, or null when nothing needed moving.
 */
export function fitToFace(prism, part, M) {
	const n = new THREE.Vector3().setFromMatrixColumn(M, 2).normalize();
	const d0 = n.dot(new THREE.Vector3().setFromMatrixPosition(M));
	const TOL = 3e-3, PLANE = 2e-3, CELL = 0.01;
	// the part's vertices on the face plane, exactly (warpBatch hands them over as 64-bit)
	const onPlane = [];
	const copy = part.warpBatch((v, count) => {
		for (let i = 0; i < count * 3; i += 3) if (Math.abs(n.x * v[i] + n.y * v[i + 1] + n.z * v[i + 2] - d0) < PLANE) onPlane.push(v[i], v[i + 1], v[i + 2]);
	});
	copy.delete();
	if (!onPlane.length) return null;
	const grid = new Map(), cell = (x) => Math.floor(x / CELL);
	for (let j = 0; j < onPlane.length; j += 3) {
		const key = cell(onPlane[j]) + ',' + cell(onPlane[j + 1]) + ',' + cell(onPlane[j + 2]);
		(grid.get(key) || grid.set(key, []).get(key)).push(j);
	}
	let moved = 0;
	const out = prism.warpBatch((v, count) => {
		for (let i = 0; i < count * 3; i += 3) {
			// the corner's foot on the face plane
			const t = n.x * v[i] + n.y * v[i + 1] + n.z * v[i + 2] - d0;
			const bx = v[i] - n.x * t, by = v[i + 1] - n.y * t, bz = v[i + 2] - n.z * t;
			let best = -1, bd = TOL * TOL;
			const cx = cell(bx), cy = cell(by), cz = cell(bz);
			for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
				const list = grid.get((cx + dx) + ',' + (cy + dy) + ',' + (cz + dz));
				if (!list) continue;
				for (const j of list) {
					const ex = onPlane[j] - bx, ey = onPlane[j + 1] - by, ez = onPlane[j + 2] - bz, dd = ex * ex + ey * ey + ez * ez;
					if (dd < bd) { bd = dd; best = j; }
				}
			}
			if (best < 0 || bd === 0) continue;
			// sideways only: along the normal the prism stays as built (a cut whose top sat exactly in the face's plane
			// would leave a zero-thickness skin of the face behind)
			let mx = onPlane[best] - bx, my = onPlane[best + 1] - by, mz = onPlane[best + 2] - bz;
			const along = n.x * mx + n.y * my + n.z * mz;
			mx -= n.x * along; my -= n.y * along; mz -= n.z * along;
			if (mx === 0 && my === 0 && mz === 0) continue;
			v[i] += mx; v[i + 1] += my; v[i + 2] += mz;
			moved++;
		}
	});
	if (!moved) { out.delete(); return null; }
	return out;
}

function cleanMatrix(e) {
	return Array.from(e, (v) => { const r = Math.round(v); return Math.abs(v - r) < 1e-9 ? r : v; });
}

export function nodeMatrix(node, target = new THREE.Matrix4()) {
	_e.set(node.rot[0] * DEG, node.rot[1] * DEG, node.rot[2] * DEG, 'XYZ');
	_q.setFromEuler(_e);
	return target.compose(new THREE.Vector3(...node.pos), _q, new THREE.Vector3(...node.scale));
}

// Clone a geometry with a matrix applied, fixing winding for mirrored transforms.
export function bake(geom, matrix) {
	const g = new THREE.BufferGeometry();
	g.setAttribute('position', geom.attributes.position.clone());
	if (geom.attributes.normal) g.setAttribute('normal', geom.attributes.normal.clone());
	if (geom.index) g.setIndex(geom.index.clone());
	let out = g.index ? g.toNonIndexed() : g;
	out.applyMatrix4(matrix);
	if (matrix.determinant() < 0) {
		flipWinding(out);
		// flipWinding negated normals; applyMatrix4 already produced correct normals, so undo.
		const n = out.attributes.normal;
		if (n) for (let i = 0; i < n.array.length; i++) n.array[i] = -n.array[i];
	}
	if (!out.attributes.normal) out.computeVertexNormals();
	return out;
}

const area2 = (p) => { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[i], r = p[(i + 1) % p.length]; a += q[0] * r[1] - r[0] * q[1]; } return a / 2; };
function inPoly(pt, poly) {
	let c = false;
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const a = poly[i], b = poly[j];
		if ((a[1] > pt[1]) !== (b[1] > pt[1]) && pt[0] < ((b[0] - a[0]) * (pt[1] - a[1])) / (b[1] - a[1] || 1e-12) + a[0]) c = !c;
	}
	return c;
}
/** Polygons with outers counter-clockwise and holes clockwise → [{ outer, holes }]. */
function nestPolygons(polys) {
	const outers = polys.filter((p) => area2(p) > 0).map((p) => ({ outer: p, holes: [], a: area2(p) })).sort((x, y) => x.a - y.a);
	for (const h of polys.filter((p) => area2(p) < 0)) {
		const o = outers.find((x) => inPoly(h[0], x.outer));
		if (o) o.holes.push(h);
	}
	return outers.map(({ outer, holes }) => ({ outer, holes }));
}

const prepGeom = (g) => { const n = g.index ? g.toNonIndexed() : g; if (!n.attributes.normal) n.computeVertexNormals(); return n; };

export class Engine {
	constructor(model) {
		this.model = model;
		this.cache = new Map();
		this.cost = new Map(); // node id -> how long its last build took (ms), to spot slow rebuilds ahead of time
		this.pool = null; // background workers (see workers.js), set by the app
		this.lastById = new Map(); // node id -> its most recent geometry (shown while a background build runs)
		this.mcache = new Map(); // node key -> live Manifold solid (owned here), so nested joins don't re-convert meshes
		this.mbusy = 0; // while > 0, no Manifold is freed (an operation is still using them)
		this.flatten = true; // join cut-inside-cut chains in one operation (tests compare with step by step)
		this.building = 0; // background builds in progress
		this.inBuild = false; // true while the builder itself asks for geometry
		this.errors = new Set();
		this.movesFailed = new Set();
		this.ctx = {
			getBlob: (h) => this.model.blobs[h], // the current design (it changes when switching tabs)
			// Booleans for shape builders that combine pieces: solids unioned, then holes subtracted.
			csg: (solids, holes = []) => {
				const prep = (g) => { const n = g.index ? g.toNonIndexed() : g; if (!n.attributes.normal) n.computeVertexNormals(); return n; };
				const S = solids.map(prep), H = holes.map(prep);
				if (MF) { try { return manifoldCSG(S, H, false); } catch (err) { console.warn(err); } }
				return concat(S);
			},
			// Refine a closed mesh to edges of about `length` and move every vertex with fn([x, y, z]) (bending).
			warp: (geom, length, fn) => {
				if (!MF) return geom;
				const made = [];
				try {
					const m = toManifold(prepGeom(geom));
					made.push(m);
					const r = m.refineToLength(length);
					made.push(r);
					const w = r.warp(fn);
					made.push(w);
					return fromManifold(w);
				} catch (err) { console.warn(err); return geom; } finally { for (const x of made) x.delete(); }
			},
			// Clean 2D outlines (overlapping / self-intersecting contours, as in many fonts) with a nonzero fill.
			// Returns [{ outer, holes }] with outers counter-clockwise, or null without Manifold.
			clean2d: (loops) => {
				if (!MF) return null;
				let cs = null;
				try {
					cs = new MF.CrossSection(loops.filter((l) => l.length >= 3), 'NonZero');
					return nestPolygons(cs.toPolygons().map((p) => p.map((q) => [q[0], q[1]])));
				} catch (err) { console.warn(err); return null; } finally { if (cs) cs.delete(); }
			},
			// Grow (+) or shrink (−) 2D outlines; returns [{ outer, holes }] or null without Manifold.
			offset2d: (loops, delta) => {
				if (!MF) return null;
				const made = [];
				try {
					const cs = new MF.CrossSection(loops.filter((l) => l.length >= 3), 'NonZero');
					made.push(cs);
					const o = cs.offset(delta, 'Miter', 4);
					made.push(o);
					return nestPolygons(o.toPolygons().map((p) => p.map((q) => [q[0], q[1]])));
				} catch (err) { console.warn(err); return null; } finally { for (const x of made) x.delete(); }
			},
			// Extrude 2D outlines (nonzero fill) straight up by depth as one watertight solid.
			extrude2d: (loops, depth) => {
				if (!MF) return null;
				const made = [];
				try {
					const cs = new MF.CrossSection(loops.filter((l) => l.length >= 3), 'NonZero');
					made.push(cs);
					const m = cs.extrude(depth);
					made.push(m);
					return m.isEmpty() ? null : fromManifold(m);
				} catch (err) { console.warn(err); return null; } finally { for (const x of made) x.delete(); }
			},
			// Boolean union for shape builders that combine pieces (e.g. a nut trap).
			union: (geoms) => {
				const list = geoms.map((g) => {
					const n = g.index ? g.toNonIndexed() : g;
					if (!n.attributes.normal) n.computeVertexNormals();
					return n;
				});
				if (MF) { try { return manifoldCSG(list, [], false); } catch (err) { console.warn(err); } }
				return concat(list);
			},
		};
	}

	key(node) {
		if (this.offIds && this.offIds.has(node.id)) return 'OFF';
		if (node.type === 'group') {
			return 'G' + node.mode + (node.mode === 'offset' ? '(' + (node.offset || 0) + ')' : node.mode === 'symmetric' ? JSON.stringify(node.sym || {}) : node.mode === 'texture' ? JSON.stringify(node.texture || {}) : node.mode === 'deform' ? JSON.stringify(node.deform || {}) : '') + '[' + node.children.map((c) => this.key(c) + '@' + c.hole + c.pos + '/' + c.rot + '/' + c.scale).join(';') + ']' + (this.fitOf(node) ? '|fit' + this.fitOf(node) + fitAxes(node) : '');
		}
		const fit = this.fitOf(node);
		if (node.type === 'mesh') return 'M' + node.params.blob + (fit ? '|fit' + fit + fitAxes(node) : '');
		return node.type + JSON.stringify(node.params) + (fit ? '|fit' + fit + fitAxes(node) : '');
	}

	/** Tests: compare the fast growth paths with plain Minkowski. */
	setFastFit(on) { setFastFit(on); this.cache.clear(); }

	/** Diametral clearance of a fitted hole (0 when it has no fit). */
	fitOf(node) {
		return node.hole && node.fit ? fitClearance(node, (this.model && this.model.settings) || {}) : 0;
	}

	/** A group used as a hole with a fit: its combined shape grown by half the clearance on every side. */
	fittedGroup(node) {
		const d = this.fitOf(node);
		if (!(d > 0) || !MF) return this.csg(node);
		// growth distributes over union: grow each solid inside on its own (much faster than growing the joined shape)
		const leaves = [];
		const walk = (n, M) => {
			const kids = (n.children || []).filter((k) => !(this.offIds && this.offIds.has(k.id)));
			if (n.type === 'group' && (n.mode || 'union') === 'union' && kids.length && !kids.some((k) => k.hole)) {
				for (const k of kids) walk(k, M.clone().multiply(nodeMatrix(k)));
				return true;
			}
			const g = this.geometry(n);
			if (g) leaves.push(bake(g, M));
			return !!g;
		};
		const plain = (node.mode || 'union') === 'union' && !node.children.some((k) => k.hole);
		if (plain) node.children.filter((k) => !(this.offIds && this.offIds.has(k.id))).forEach((k) => walk(k, nodeMatrix(k)));
		else { const g = this.csg(node); if (g) leaves.push(g); }
		if (!leaves.length) return null;
		return growMany(leaves, d / 2, fitAxes(node)) || this.csg(node);
	}

	/** A fitted hole: exact parameter growth for simple shapes, otherwise a rounded offset of the shape. */
	fittedShape(node) {
		const d = this.fitOf(node);
		const axes = fitAxes(node);
		const p = fittedParams(node.type, node.params, d, axes);
		if (p) return buildShape(node.type, p, this.ctx);
		const g = buildShape(node.type, node.params, this.ctx);
		if (!g || !MF || !(d > 0)) return g;
		return growAlong(g, d / 2, axes) || g;
	}

	/**
	 * Keep a built shape. The cache holds at most 400 shapes and about GEOM_BUDGET bytes of them; the oldest go
	 * first, except shapes that are on screen now (big sculpted or imported meshes would otherwise pile up in memory
	 * as they change).
	 */
	remember(key, g) {
		this.cache.set(key, g);
		// sizes are measured now rather than when stored: the viewport adds an index and a BVH to shapes it shows
		let bytes = 0;
		for (const x of this.cache.values()) bytes += geomBytes(x);
		this.cacheBytes = bytes;
		if (this.cache.size <= 400 && bytes <= GEOM_BUDGET) return;
		const inUse = new Set(this.lastById.values());
		for (const [k, old] of this.cache) {
			if (this.cache.size <= 400 && this.cacheBytes <= GEOM_BUDGET) break;
			if (k === key || inUse.has(old)) continue;
			this.cache.delete(k);
			this.cacheBytes -= geomBytes(old);
			if (old) { old.boundsTree = null; old.dispose(); }
			const m = this.mcache.get(k);
			if (m && !this.mbusy) { this.mcache.delete(k); this.mcacheTris -= m.numTri ? m.numTri() : 0; m.delete(); }
		}
	}

	/** Forget the last shapes of parts that no open design has any more (they are kept for drawing during builds). */
	pruneLastShapes(liveIds) {
		for (const id of [...this.lastById.keys()]) if (!liveIds.has(id)) this.lastById.delete(id);
	}

	// Geometry of a node in its own local frame (null if empty).
	geometry(node) {
		if (this.offIds && this.offIds.has(node.id)) return null; // suppressed / rolled back (feature timeline)
		const key = this.key(node);
		if (this.cache.has(key)) {
			const g = this.cache.get(key);
			this.cache.delete(key);
			this.cache.set(key, g);
			return g;
		}
		// while the background workers rebuild, everything else (handles, picking, stats) sees the last shape
		// instead of building it here and freezing the page
		if (this.building && !this.inBuild && this.lastById.has(node.id)) return this.lastById.get(node.id);
		let g;
		const t0 = performance.now();
		if (this.fitOf(node)) {
			// grown holes that took a while are kept across sessions
			const h = hashKey(key);
			g = fastFit ? getFit(h) : null;
			if (!g) {
				const t0 = performance.now();
				g = node.type === 'group' ? this.fittedGroup(node) : this.fittedShape(node);
				if (g && fastFit && performance.now() - t0 > 80) putFit(h, g);
			}
		} else g = node.type === 'group' ? this.csg(node) : buildShape(node.type, node.params, this.ctx);
		if (g) {
			g.computeBoundingBox();
			g.computeBoundingSphere();
		}
		this.cost.set(node.id, performance.now() - t0);
		this.remember(key, g);
		this.lastById.set(node.id, g);
		return g;
	}

	/** geometry() on behalf of the background builder (always the current shape, never a stale one). */
	built(node) {
		const was = this.inBuild;
		this.inBuild = true;
		try { return this.geometry(node); } finally { this.inBuild = was; }
	}

	// ------------------------------------------------------------ background building

	setPool(pool) { this.pool = pool; }

	/** About how long (ms) building what isn't built yet will take, judged by how long those parts took before. */
	pendingCost(roots) {
		let ms = 0;
		const walk = (n) => {
			if ((this.offIds && this.offIds.has(n.id)) || this.cache.has(this.key(n))) return;
			// textures and deforms not built before: assume slow, so they go to the background workers
			ms += this.cost.get(n.id) || (n.mode === 'texture' || n.mode === 'deform' ? 1000 : 0);
			(n.children || []).forEach(walk);
		};
		roots.forEach(walk);
		return ms;
	}

	/**
	 * Build everything under roots that isn't built yet: inner objects first, joins and fit growth on the background
	 * workers (several at once when they don't depend on each other), simple shapes here. onProgress(done, total,
	 * node). Results land in the cache, so drawing afterwards is instant. Returns how many were built.
	 */
	async buildAsync(roots, onProgress) {
		const order = [], seen = new Set();
		const walk = (n) => {
			if (seen.has(n) || (this.offIds && this.offIds.has(n.id))) return;
			seen.add(n);
			if (this.cache.has(this.key(n))) return;
			(n.children || []).forEach(walk);
			order.push(n);
		};
		roots.forEach(walk);
		const total = order.length;
		if (!total) return 0;
		this.building++;
		try { return await this.runBuild(order, onProgress); } finally { this.building--; }
	}

	async runBuild(order, onProgress) {
		const total = order.length;
		const useWorkers = !!(this.pool && MF && (await this.pool.start()) && this.pool.ok);
		let done = 0, last = performance.now();
		const tasks = new Map();
		for (const n of order) {
			const deps = (n.children || []).map((c) => tasks.get(c)).filter(Boolean);
			tasks.set(n, (async () => {
				await Promise.all(deps);
				// let the page paint now and then
				if (performance.now() - last > 30) { await new Promise((res) => setTimeout(res, 0)); last = performance.now(); }
				try {
					if (useWorkers) await this.buildNodeAsync(n);
					else this.built(n);
				} catch (e) {
					console.warn(e);
				}
				done++;
				if (onProgress) onProgress(done, total, n);
			})());
		}
		await Promise.all(tasks.values());
		return total;
	}

	/** One node, with its heavy step on a worker (falls back to building here if that fails). */
	async buildNodeAsync(n) {
		const key = this.key(n);
		if (this.cache.has(key)) return;
		const d = this.fitOf(n);
		const heavy = n.type === 'group' || (d > 0 && !fittedParams(n.type, n.params, d, fitAxes(n)));
		if (!heavy) { this.built(n); return; }
		const t0 = performance.now();
		try {
			let g = null, workMs = 0;
			const h = d > 0 ? hashKey(key) : null;
			if (h && fastFit) g = getFit(h);
			if (!g) {
				const run = async (msg, arrays) => {
					const res = await this.pool.run({ ...msg, fast: fastFit }, arrays.map((a) => a.buffer));
					workMs += res.ms;
					return res.r ? geomFromCreased(res.r) : null;
				};
				const baked = (geo, M) => bake(geo, M).attributes.position.array;
				const csgJob = (group) => {
					const mode = group.mode || 'union';
					// face moves work on the combined solid in order: built here, on the kernel
					if (hasMoves(group) || mode === 'symmetric') { const m = this.manifoldOf(group); return m && !m.isEmpty() ? fromManifold(m) : null; }
					let S, H;
					if (MESH_MODES.has(mode)) {
						const items = [];
						for (const c of group.children) { const cg = this.built(c); if (cg) items.push({ c, g: cg }); }
						S = items.filter((i) => !i.c.hole).map(({ c, g: cg }) => baked(cg, nodeMatrix(c)));
						H = items.filter((i) => i.c.hole).map(({ c, g: cg }) => baked(cg, nodeMatrix(c)));
					} else {
						// chains flattened into one operation, as on the main thread
						const { solids, holes } = this.flatGather(group);
						const bk = ({ node, M }) => { const cg = this.built(node); return cg ? baked(cg, M) : null; };
						S = solids.map(bk).filter(Boolean);
						H = holes.map(bk).filter(Boolean);
					}
					if (!S.length) return null;
					return run({ op: 'csg', solids: S, holes: H, intersect: group.mode === 'hull' ? 'hull' : group.mode === 'intersect', offset: group.mode === 'offset' ? group.offset || 0 : 0, mod: modifierOf(group, S) }, [...S, ...H]);
				};
				if (n.type === 'group' && !(d > 0)) g = await csgJob(n);
				else if (n.type === 'group') {
					// same as fittedGroup: grow each solid inside on its own when the group is a plain union
					const leaves = [];
					const walk = (m, M) => {
						const kids = (m.children || []).filter((k) => !(this.offIds && this.offIds.has(k.id)));
						if (m.type === 'group' && (m.mode || 'union') === 'union' && kids.length && !kids.some((k) => k.hole)) { for (const k of kids) walk(k, M.clone().multiply(nodeMatrix(k))); return; }
						const lg = this.built(m);
						if (lg) leaves.push(baked(lg, M));
					};
					const plain = (n.mode || 'union') === 'union' && !n.children.some((k) => k.hole);
					if (plain) n.children.filter((k) => !(this.offIds && this.offIds.has(k.id))).forEach((k) => walk(k, nodeMatrix(k)));
					else { const cg = await csgJob(n); if (cg) leaves.push(new Float32Array((cg.index ? cg.toNonIndexed() : cg).attributes.position.array)); }
					if (leaves.length) g = (await run({ op: 'grow', geoms: leaves, c: d / 2, axes: fitAxes(n) }, leaves)) || (await csgJob(n));
				} else {
					const base = buildShape(n.type, n.params, this.ctx);
					if (base) {
						const a = new Float32Array((base.index ? base.toNonIndexed() : base).attributes.position.array);
						g = (await run({ op: 'grow', geoms: [a], c: d / 2, axes: fitAxes(n) }, [a])) || base;
					}
				}
				if (g && h && fastFit && workMs > 80) putFit(h, g);
			}
			if (n.type === 'group') this.errors.delete(n.id);
			if (g) { g.computeBoundingBox(); g.computeBoundingSphere(); }
			// results belong to their key, so they are kept even if the design moved on in the meantime
			if (!this.cache.has(key)) this.remember(key, g);
			this.lastById.set(n.id, g);
			this.cost.set(n.id, performance.now() - t0);
		} catch (e) {
			console.warn('Background build failed, building here instead', e);
			this.built(n);
		}
	}

	csg(group) {
		const mode = group.mode || 'union';
		if (MF && !MESH_MODES.has(mode)) {
			try {
				const m = this.manifoldOf(group);
				if (this.movesFailed.has(group.id)) this.errors.add(group.id); else this.errors.delete(group.id);
				return m && !m.isEmpty() ? fromManifold(m) : null;
			} catch (e) {
				console.warn('Manifold CSG failed, falling back', e);
			}
		}
		return this.csgMesh(group);
	}

	// ------------------------------------------------------------ live kernel solids

	/**
	 * What a group combines, with chains flattened: when a group's only solid is itself a plain union group, that
	 * group's solids and holes are taken directly (A − h1, then − h2 … becomes A − (h1 ∪ h2 …), one operation).
	 * Returns { solids: [{ node, M }], holes: [{ node, M }] } with matrices into the group's frame.
	 */
	flatGather(group) {
		const off = (k) => this.offIds && this.offIds.has(k.id);
		const plain = (k) => k.type === 'group' && !k.hole && (k.mode || 'union') === 'union' && !this.fitOf(k) && k.children.some((c) => !off(c)) && !hasMoves(k);
		const solids = [], holes = [];
		const gather = (g, M) => {
			const kids = g.children.filter((k) => !off(k));
			const sol = kids.filter((k) => !k.hole);
			for (const h of kids.filter((k) => k.hole)) holes.push({ node: h, M: M.clone().multiply(nodeMatrix(h)) });
			if (this.flatten && sol.length === 1 && plain(sol[0])) gather(sol[0], M.clone().multiply(nodeMatrix(sol[0])));
			else for (const k of sol) solids.push({ node: k, M: M.clone().multiply(nodeMatrix(k)) });
		};
		if ((group.mode || 'union') === 'union') gather(group, new THREE.Matrix4());
		else for (const k of group.children.filter((c) => !off(c))) (k.hole ? holes : solids).push({ node: k, M: nodeMatrix(k) });
		return { solids, holes };
	}

	/** A node's solid as a live Manifold in its own frame (cached and owned by the engine: never delete it). */
	manifoldOf(node) {
		const key = this.key(node);
		const hit = this.mcache.get(key);
		if (hit) { this.mcache.delete(key); this.mcache.set(key, hit); return hit; }
		let m = null;
		const mode = node.mode || 'union';
		if (node.type === 'group' && !this.fitOf(node) && !MESH_MODES.has(mode)) m = this.groupManifold(node);
		else {
			const g = this.geometry(node);
			if (g) m = toManifold(g);
		}
		if (m) this.keepManifold(key, m);
		return m;
	}

	keepManifold(key, m) {
		const prev = this.mcache.get(key);
		if (prev && prev !== m) { this.mcacheTris -= prev.numTri(); if (!this.mbusy) prev.delete(); }
		this.mcache.set(key, m);
		this.mcacheTris = (this.mcacheTris || 0) + m.numTri();
		if (this.mbusy) return;
		// at most 300 solids and MANIFOLD_TRI_BUDGET triangles of them (they live in the geometry kernel's memory)
		while (this.mcache.size > 300 || (this.mcacheTris > MANIFOLD_TRI_BUDGET && this.mcache.size > 1)) {
			const k = this.mcache.keys().next().value, old = this.mcache.get(k);
			if (k === key) break;
			this.mcache.delete(k);
			this.mcacheTris -= old.numTri();
			old.delete();
		}
	}

	groupManifold(group) {
		if (hasMoves(group) && (group.mode || 'union') === 'union') return this.sequenceManifold(group);
		const { solids, holes } = this.flatGather(group);
		this.mbusy++;
		const temps = [];
		let out = null;
		try {
			const place = ({ node, M }) => { const m = this.manifoldOf(node); if (!m) return null; const t = m.transform(cleanMatrix(M.elements)); temps.push(t); return t; };
			const S = solids.map(place).filter(Boolean), H = holes.map(place).filter(Boolean);
			if (!S.length) return null;
			let acc = S.length === 1 ? S[0] : (group.mode === 'intersect' ? MF.Manifold.intersection(S) : MF.Manifold.union(S));
			if (acc !== S[0]) temps.push(acc);
			if (H.length) {
				const hu = H.length === 1 ? H[0] : MF.Manifold.union(H);
				if (hu !== H[0]) temps.push(hu);
				acc = acc.subtract(hu);
				temps.push(acc);
			}
			if (group.mode === 'symmetric') { acc = symmetrize(acc, group.sym || {}, temps); temps.push(acc); }
			out = acc;
			return out;
		} finally {
			for (const t of temps) if (t !== out) t.delete();
			this.mbusy--;
			if (!this.mbusy && this.mcache.size > 300) this.keepManifold(this.mcache.keys().next().value, this.mcache.values().next().value);
		}
	}

	/**
	 * A union group with face moves, or with push/pull material added after a cut, is built in order: the solids and
	 * holes before each move (or added push/pull) are combined first, then the move is applied or the material added.
	 */
	sequenceManifold(group) {
		const kids = group.children.filter((k) => !(this.offIds && this.offIds.has(k.id)));
		this.mbusy++;
		const temps = [];
		let acc = null, out = null, failed = false;
		const keep = (m) => { temps.push(m); return m; };
		try {
			const place = (node) => { const m = this.manifoldOf(node); return m ? keep(m.transform(cleanMatrix(nodeMatrix(node).elements))) : null; };
			let S = [], H = [];
			const flush = () => {
				const parts = acc ? [acc, ...S] : S;
				if (parts.length) acc = parts.length === 1 ? parts[0] : keep(MF.Manifold.union(parts));
				if (acc && H.length) acc = keep(acc.subtract(H.length === 1 ? H[0] : keep(MF.Manifold.union(H))));
				S = []; H = [];
			};
			for (const k of kids) {
				// a push/pull made with a remembered face finds that face again on the part as built so far, so it follows
				// edits made before it (a taller box: the pull starts from the new top)
				let f = k;
				if ((k.type === 'facex' || k.type === 'facemove' || k.type === 'faceoff') && k.params && k.params.ref) {
					flush();
					if (!acc) continue;
					f = this.refoundFeature(acc, k) || k;
					if (k.type === 'facex') {
						const m = place(f);
						// pulls only: a cut whose sides exactly continue the part's outside faces would leave zero-thickness skins
						const fit = m && !k.hole && fitToFace(m, acc, nodeMatrix(f));
						if (fit) keep(fit);
						if (m) acc = keep(k.hole ? acc.subtract(fit || m) : acc.add(fit || m));
						continue;
					}
				}
				if (k.type === 'facemove') {
					flush();
					if (!acc) continue;
					const M = nodeMatrix(f), moved = moveFace(acc, cleanMatrix(M.elements), cleanMatrix(M.clone().invert().elements), f.params);
					if (moved) acc = keep(moved); else failed = true;
					continue;
				}
				if (k.type === 'faceoff') {
					// curved push/pull: move the surface itself when the faces beside it allow, else add / cut a slab
					flush();
					if (!acc) continue;
					const moved = offsetSurface(acc, cleanMatrix(nodeMatrix(f).elements), f.params);
					if (moved) { acc = keep(moved); continue; }
					const slab = place(f);
					if (slab) acc = keep(k.hole ? acc.subtract(slab) : acc.add(slab));
					continue;
				}
				if (!k.hole && H.length && PULLS.has(k.type)) flush();
				const m = place(k);
				if (m) (k.hole ? H : S).push(m);
			}
			flush();
			if (failed) this.movesFailed.add(group.id); else this.movesFailed.delete(group.id);
			out = acc;
			return out;
		} finally {
			for (const t of temps) if (t !== out) t.delete();
			this.mbusy--;
		}
	}

	/**
	 * A push/pull feature placed on its face as the part is now: the face nearest the remembered point, facing the same
	 * way, is found on the solid built before the feature and its outline (or curved patch) taken again. Returns a copy
	 * of the node with the new placement, or null to use it as stored (the face is unchanged, or can't be found).
	 */
	refoundFeature(acc, k) {
		const ref = k.params.ref, P = new THREE.Vector3(...ref.p), N = new THREE.Vector3(...ref.n).normalize();
		const raw = rawOf(acc), g = new THREE.BufferGeometry();
		g.setAttribute('position', new THREE.BufferAttribute(raw.pos, 3));
		g.setIndex(new THREE.BufferAttribute(raw.idx, 1));
		const mesh = new THREE.Mesh(g);
		const curved = k.type === 'faceoff', minDot = curved ? 0.7 : 1 - 1e-6;
		const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3(), Q = new THREE.Vector3(), tri = new THREE.Triangle();
		let best = -1, bestD = Infinity;
		for (let t = 0; t < raw.idx.length / 3; t++) {
			A.fromArray(raw.pos, 3 * raw.idx[3 * t]); B.fromArray(raw.pos, 3 * raw.idx[3 * t + 1]); C.fromArray(raw.pos, 3 * raw.idx[3 * t + 2]);
			tri.set(A, B, C);
			if (tri.getArea() < 1e-12 || tri.getNormal(Q).dot(N) < minDot) continue;
			const d = tri.closestPointToPoint(P, Q).distanceTo(P);
			if (d < bestD) { bestD = d; best = t; }
		}
		g.dispose();
		if (best < 0) return null;
		const r = faceRegion(mesh, best);
		if (!r) return null;
		// the face as remembered, still there: keep the stored outline (no drift from re-measuring)
		const same = bestD < 1e-4 && Math.abs(r.area - (ref.area || 0)) <= 1e-4 * Math.max(1, ref.area || 0);
		if (same) return null;
		if (curved) {
			if (!r.curved) return null;
			const sm = (v) => v.toArray().map(snapMeasured);
			return { ...k, id: k.id + '#refound', params: { ...k.params, V: r.V.map(sm), N: r.N.map((n) => n.toArray().map((x) => round(x, 6))), T: r.T }, pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1] };
		}
		if (r.curved) return null;
		if (k.type === 'facemove' && !r.blend) return null;
		const e = new THREE.Euler().setFromQuaternion(r.basis.quat, 'XYZ');
		const rot = [snapAngle(e.x / DEG), snapAngle(e.y / DEG), snapAngle(e.z / DEG)];
		const aligned = rot.every((d) => Math.abs(d / 90 - Math.round(d / 90)) < 1e-9);
		const sn = aligned ? (x) => snapTo(x, 0.001) : snapMeasured;
		const pos = r.origin.toArray().map(sn);
		const params = k.type === 'facemove' ? { ...k.params, outline: r.blend.outline.map(([x, y]) => [sn(x), sn(y)]), h: snapMeasured(r.blend.h) } : { ...k.params, loops: r.loops.map((lp) => lp.map(([x, y]) => [sn(x), sn(y)])) };
		return { ...k, id: k.id + '#refound', params, pos, rot, scale: [1, 1, 1] };
	}

	csgMesh(group) {
		const items = [];
		for (const c of group.children) {
			const g = this.geometry(c);
			if (g) items.push({ c, g });
		}
		const solids = items.filter((i) => !i.c.hole);
		const holes = items.filter((i) => i.c.hole);
		if (!solids.length) return null;
		if (MF) {
			try {
				const S = solids.map(({ c, g }) => bake(g, nodeMatrix(c)));
				const H = holes.map(({ c, g }) => bake(g, nodeMatrix(c)));
				const res = manifoldCSG(S, H, group.mode === 'hull' ? 'hull' : group.mode === 'intersect', group.mode === 'offset' ? group.offset || 0 : 0, modifierOf(group, S.map((g) => g.attributes.position.array)));
				this.errors.delete(group.id);
				return res;
			} catch (e) {
				console.warn('Manifold CSG failed, falling back', e);
			}
		}
		const brush = ({ c, g }) => {
			const b = new Brush(bake(g, nodeMatrix(c)));
			b.updateMatrixWorld();
			return b;
		};
		try {
			let acc;
			if (group.mode === 'hull') {
				const pts = hullPoints(solids.map(({ c, g }) => bake(g, nodeMatrix(c)))).map((p) => new THREE.Vector3(...p));
				acc = new Brush(new ConvexGeometry(pts));
				acc.updateMatrixWorld();
			} else {
				acc = brush(solids[0]);
				const op = group.mode === 'intersect' ? INTERSECTION : ADDITION;
				for (let i = 1; i < solids.length; i++) acc = evaluator.evaluate(acc, brush(solids[i]), op);
			}
			for (const h of holes) acc = evaluator.evaluate(acc, brush(h), SUBTRACTION);
			const out = new THREE.BufferGeometry();
			out.setAttribute('position', new THREE.BufferAttribute(new Float32Array(acc.geometry.attributes.position.array), 3));
			out.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(acc.geometry.attributes.normal.array), 3));
			if (acc.geometry.index) out.setIndex(Array.from(acc.geometry.index.array));
			const res = out.index ? out.toNonIndexed() : out;
			this.errors.delete(group.id);
			return res.attributes.position.count ? res : null;
		} catch (e) {
			console.error('CSG failed', e);
			this.errors.add(group.id);
			return null;
		}
	}

	// World-space geometry of a top-level node.
	world(node) {
		const g = this.geometry(node);
		if (!g) return null;
		return bake(g, nodeMatrix(node));
	}

	// Combine nodes into one printable geometry. merge=true does a full CSG union and subtracts loose holes.
	printable(nodes, merge) {
		const solids = nodes.filter((n) => !n.hole);
		const holes = nodes.filter((n) => n.hole);
		if (!merge) {
			const geoms = solids.map((n) => this.world(n)).filter(Boolean);
			return concat(geoms);
		}
		const group = { id: '__export', type: 'group', mode: 'union', children: [...solids, ...holes] };
		return this.csg(group);
	}

	stats(nodes) {
		let volume = 0, tris = 0;
		const box = new THREE.Box3();
		for (const n of nodes) {
			if (n.hole) continue;
			const g = this.world(n);
			if (!g) continue;
			volume += signedVolume(g);
			tris += g.attributes.position.count / 3;
			g.computeBoundingBox();
			box.union(g.boundingBox);
			g.dispose();
		}
		return { volume, tris, box };
	}
}

export function concat(geoms) {
	let total = 0;
	for (const g of geoms) total += g.attributes.position.count;
	const pos = new Float32Array(total * 3);
	const nrm = new Float32Array(total * 3);
	let o = 0;
	for (const g of geoms) {
		pos.set(g.attributes.position.array, o);
		if (g.attributes.normal) nrm.set(g.attributes.normal.array, o);
		o += g.attributes.position.array.length;
	}
	const out = new THREE.BufferGeometry();
	out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
	out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
	return out;
}
