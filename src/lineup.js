// Parts a hair off their neighbors: flat faces (any direction) that come within 0.03 mm (closer than a slicer
// can tell apart) of another part's face, side by side or touching, without meeting it exactly. Older versions rounded positions on every group, ungroup and
// move, so designs made with them carry offsets like 45.0005 next to 45; the joins show as hairline steps and sliver
// triangles. findHairlines() finds them, lineUpHairlines() moves each such part the exact amount onto its neighbor.
import * as THREE from 'three';
import { nodeMatrix } from './engine.js';
import { exact, toast } from './util.js';
import { intended } from './csgcore.js';

const MAX = 0.0301; // the slicer's merge distance: faces closer than this are never a step anyone meant (they merge into broken spots)
const MIN = 5e-6; // closer than this is the same face (shapes are 32-bit: 22.7 is 22.70000076 there)
const FEATURES = new Set(['facex', 'facemove', 'faceoff', 'edgeop', 'mesh']); // features are fitted onto the part already; imported meshes are left as they are

/**
 * The leaf shapes of the design with their flat faces in world space, computed in double precision from the shape's own
 * points at the values they stand for (as the kernel places them). Each face plane: unit normal n (sign chosen so its
 * largest component is positive), offset d = n·p and a point p on it. [{ node, M, byKey: Map(direction → [{ n, d, p, axis }]), box }]
 */
function leafFaces(app) {
	const out = [];
	const walk = (n, parentM) => {
		if (!n.visible && parentM === null) return;
		const M = (parentM || new THREE.Matrix4()).clone().multiply(nodeMatrix(n));
		if (n.type === 'group') { for (const c of n.children || []) walk(c, M); return; }
		if (FEATURES.has(n.type)) return;
		const g = app.engine.geometry(n);
		if (!g || !g.attributes.position) return;
		const e = M.elements, pos = g.attributes.position.array, idx = g.index ? g.index.array : null;
		const P = (i) => { const x = intended(pos[3 * i]), y = intended(pos[3 * i + 1]), z = intended(pos[3 * i + 2]); return new THREE.Vector3(e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]); };
		const count = idx ? idx.length : pos.length / 3;
		const box = new THREE.Box3(), byKey = new Map(); // faces by direction
		const u = new THREE.Vector3(), w = new THREE.Vector3();
		for (let t = 0; t < count; t += 3) {
			const a = P(idx ? idx[t] : t), b = P(idx ? idx[t + 1] : t + 1), c = P(idx ? idx[t + 2] : t + 2);
			box.expandByPoint(a).expandByPoint(b).expandByPoint(c);
			const nn = u.subVectors(b, a).cross(w.subVectors(c, a));
			const l = nn.length();
			if (l < 1e-6) continue;
			nn.divideScalar(l);
			const big = [0, 1, 2].reduce((m, k) => (Math.abs(nn.getComponent(k)) > Math.abs(nn.getComponent(m)) + 1e-12 ? k : m), 0);
			if (nn.getComponent(big) < 0) nn.negate();
			// exactly along X, Y or Z: exactly that axis (no float noise in the normal)
			const axis = [0, 1, 2].find((k) => Math.abs(Math.abs(nn.getComponent(k)) - 1) < 1e-12);
			const n = axis !== undefined ? new THREE.Vector3().setComponent(axis, 1) : nn.clone();
			const d = axis !== undefined ? a.getComponent(axis) : n.dot(a);
			const key = n.toArray().map((v) => Math.round(v * 1e5)).join(',');
			const same = byKey.get(key);
			if (!same) byKey.set(key, [{ n, d, p: a.clone(), axis }]);
			else if (!same.some((q) => Math.abs(q.d - d) < 1e-9)) same.push({ n, d, p: a.clone(), axis });
		}
		if (byKey.size) out.push({ node: n, M, byKey, box });
	};
	for (const n of app.model.nodes) if (n.visible) walk(n, null);
	return out;
}

const grid = (v) => Math.abs(v * 1000 - Math.round(v * 1000)); // how far off the micron grid (0 … 0.5)
// how round a part's placement is (lower: rounder) — for slanted faces, whose offsets are never on a grid
const roundness = (node) => node.pos.reduce((s, v) => s + grid(v), 0);

/**
 * Parts to move: [{ node, t (world shift), from, to }] — each part's faces with that normal
 * that miss a parallel neighbor's face by under 0.03 mm all call for the same move, and no face of it that meets
 * another exactly is pulled off it. On faces lined up with X, Y or Z the less round value moves (45.0005 → 45); on
 * slanted faces the part whose placement is less round moves (when neither is, nothing does).
 */
export function findHairlines(app) {
	const L = leafFaces(app);
	const moves = [];
	for (let i = 0; i < L.length; i++) {
		const near = L[i].box.clone().expandByScalar(0.05);
		const others = L.filter((o, j) => j !== i && near.intersectsBox(o.box));
		if (!others.length) continue;
		for (const [key, mine] of L[i].byKey) {
			const n = mine[0].n, wants = [];
			let meets = false;
			for (const o of others) {
				const theirs = o.byKey.get(key);
				if (!theirs) continue;
				for (const q of theirs) {
					if (q.n.dot(n) < 1 - 1e-9) continue;
					for (const a of mine) {
						// both offsets measured along this part's own normal (so a hair of normal noise doesn't count)
						const da = a.axis !== undefined ? a.d : n.dot(a.p), db = a.axis !== undefined && q.axis === a.axis ? q.d : n.dot(q.p);
						const d = db - da;
						if (Math.abs(d) < MIN) { meets = true; break; }
						if (Math.abs(d) > MAX) continue;
						const moveMe = a.axis !== undefined && q.axis === a.axis ? grid(da) > grid(db) + 1e-6 : roundness(L[i].node) > roundness(o.node) + 1e-6;
						if (moveMe) wants.push({ d, a: da, b: db });
					}
					if (meets) break;
				}
				if (meets) break;
			}
			if (meets || !wants.length) continue; // already meets something exactly this way: moving would break that
			const d = wants[0].d;
			if (wants.some((x) => Math.abs(x.d - d) > 1e-9)) continue; // pulled different ways: leave it
			moves.push({ node: L[i].node, n: n.clone(), d, from: wants[0].a, to: wants[0].b, M: L[i].M });
		}
	}
	// per part: one shift t that does every move (n·t = d for each); none when they disagree — e.g. a pin in a hole
	// with a tiny clearance "misses" on every side, and no single shift closes them all, so it stays as it is
	const byNode = new Map();
	for (const m of moves) (byNode.get(m.node) || byNode.set(m.node, []).get(m.node)).push(m);
	const out = [];
	for (const [node, ms] of byNode) {
		const A = new THREE.Matrix3().set(0, 0, 0, 0, 0, 0, 0, 0, 0), b = new THREE.Vector3();
		for (const m of ms) {
			const n = m.n, e = A.elements;
			for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) e[c * 3 + r] += n.getComponent(r) * n.getComponent(c);
			b.addScaledVector(n, m.d);
		}
		// moves along fewer than three directions leave the rest free: keep those parts of t at zero
		for (let k = 0; k < 3; k++) A.elements[k * 4] += 1e-12;
		if (Math.abs(A.determinant()) < 1e-30) continue;
		const t = b.clone().applyMatrix3(A.clone().invert());
		if (ms.some((m) => Math.abs(m.n.dot(t) - m.d) > 1e-7)) continue;
		out.push({ ...ms[0], node, t, count: ms.length });
	}
	return out;
}

export const LineUpMixin = {
	/** Move every part found by findHairlines onto its neighbor (one undo step). Returns how many moved. */
	lineUpHairlines() {
		const moves = findHairlines(this);
		if (!moves.length) { toast('Nothing to line up — every part meets its neighbors exactly', 'ok'); return 0; }
		const done = new Set();
		for (const m of moves) {
			// the world shift, in the frame the part's position is given in (its parent's)
			const parentM = m.M.clone().multiply(nodeMatrix(m.node).invert());
			const dw = m.t.clone();
			const dl = dw.clone().applyMatrix3(new THREE.Matrix3().setFromMatrix4(parentM).invert());
			for (let i = 0; i < 3; i++) { if (m.node.exprs) delete m.node.exprs['pos.' + i]; m.node.pos[i] = exact(m.node.pos[i] + dl.getComponent(i)); }
			done.add(m.node.id);
		}
		this.commit();
		toast(`Lined up ${done.size} part${done.size > 1 ? 's' : ''} that sat a hair off — Undo (Ctrl+Z) puts ${done.size > 1 ? 'them' : 'it'} back`, 'ok', 5000);
		return done.size;
	},
};
