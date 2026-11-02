// Parts a hair off their neighbors: flat faces lined up with X, Y or Z that come within 0.03 mm (closer than a slicer
// can tell apart) of another part's face, side by side or touching, without meeting it exactly. Older versions rounded positions on every group, ungroup and
// move, so designs made with them carry offsets like 45.0005 next to 45; the joins show as hairline steps and sliver
// triangles. findHairlines() finds them, lineUpHairlines() moves each such part the exact amount onto its neighbor.
import * as THREE from 'three';
import { nodeMatrix } from './engine.js';
import { exact, toast } from './util.js';

const MAX = 0.0301; // the slicer's merge distance: faces closer than this are never a step anyone meant (they merge into broken spots)
const MIN = 5e-6; // closer than this is the same face (shapes are 32-bit: 22.7 is 22.70000076 there)
const FEATURES = new Set(['facex', 'facemove', 'faceoff', 'edgeop', 'mesh']); // features are fitted onto the part already; imported meshes are left as they are

// the axis (0, 1, 2) and sign a matrix column points along, or null when it is not lined up with one
function axisOf(x, y, z) {
	const v = [x, y, z], k = v.findIndex((c) => Math.abs(c) > 1e-9);
	return k >= 0 && v.every((c, i) => i === k || Math.abs(c) <= 1e-9) ? k : null;
}

/**
 * The leaf shapes of the design with their flat axis faces in world space, computed in double precision from the
 * shape's own vertices (as the kernel places them). [{ node, M, faces: [Set x, Set y, Set z], box }]
 */
function leafFaces(app) {
	const out = [];
	const walk = (n, parentM) => {
		if (!n.visible && parentM === null) return;
		const M = (parentM || new THREE.Matrix4()).clone().multiply(nodeMatrix(n));
		if (n.type === 'group') { for (const c of n.children || []) walk(c, M); return; }
		if (FEATURES.has(n.type)) return;
		const e = M.elements;
		// only shapes whose own axes stay lined up with the world's (else their faces are not X/Y/Z faces)
		if ([0, 4, 8].some((o) => axisOf(e[o], e[o + 1], e[o + 2]) === null)) return;
		const g = app.engine.geometry(n);
		if (!g || !g.attributes.position) return;
		const pos = g.attributes.position.array, idx = g.index ? g.index.array : null;
		const faces = [new Set(), new Set(), new Set()];
		const P = (i) => { const x = pos[3 * i], y = pos[3 * i + 1], z = pos[3 * i + 2]; return [e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]]; };
		const count = idx ? idx.length : pos.length / 3;
		const box = new THREE.Box3();
		for (let t = 0; t < count; t += 3) {
			const a = P(idx ? idx[t] : t), b = P(idx ? idx[t + 1] : t + 1), c = P(idx ? idx[t + 2] : t + 2);
			box.expandByPoint(new THREE.Vector3(...a)).expandByPoint(new THREE.Vector3(...b)).expandByPoint(new THREE.Vector3(...c));
			for (let k = 0; k < 3; k++) if (Math.abs(a[k] - b[k]) < 1e-9 && Math.abs(b[k] - c[k]) < 1e-9) {
				// a flat face across this axis (all three corners at the same value): keep it if it has an area
				const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
				const cr = Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]);
				if (cr > 1e-9) faces[k].add(a[k]);
			}
		}
		if (faces.some((f) => f.size)) out.push({ node: n, M, faces, box });
	};
	for (const n of app.model.nodes) if (n.visible) walk(n, null);
	return out;
}

/**
 * Parts to move: [{ node, axis, d (world mm), from, to }] — each part's faces on that axis that miss a neighbor's by
 * under 0.03 mm all call for the same move, and no face of it that meets another exactly is pulled off it.
 */
export function findHairlines(app) {
	const L = leafFaces(app);
	const grid = (v) => Math.abs(v * 1000 - Math.round(v * 1000)); // how far off the micron grid (0 … 0.5)
	const moves = [];
	for (let i = 0; i < L.length; i++) {
		for (let k = 0; k < 3; k++) {
			if (!L[i].faces[k].size) continue;
			const wants = [], exactMeet = [];
			const near = L[i].box.clone().expandByScalar(0.01);
			for (let j = 0; j < L.length; j++) {
				if (j === i || !L[j].faces[k].size || !near.intersectsBox(L[j].box)) continue;
				for (const a of L[i].faces[k]) for (const b of L[j].faces[k]) {
					const d = b - a;
					if (Math.abs(d) < MIN) exactMeet.push(j);
					else if (Math.abs(d) <= MAX && grid(a) > grid(b) + 1e-6) wants.push({ d, a, b, j }); // the less round one moves
				}
			}
			if (!wants.length) continue;
			const d = wants[0].d;
			if (wants.some((w) => Math.abs(w.d - d) > 1e-9)) continue; // pulled different ways: leave it
			if (exactMeet.length) continue; // it already meets something exactly on this axis: moving would break that
			moves.push({ node: L[i].node, axis: k, d, from: wants[0].a, to: wants[0].b, M: L[i].M });
		}
	}
	return moves;
}

export const LineUpMixin = {
	/** Move every part found by findHairlines onto its neighbor (one undo step). Returns how many moved. */
	lineUpHairlines() {
		const moves = findHairlines(this);
		if (!moves.length) { toast('Nothing to line up — every part meets its neighbors exactly', 'ok'); return 0; }
		const done = new Set();
		for (const m of moves) {
			// the world move along the axis, in the frame the part's position is given in (its parent's)
			const parentM = m.M.clone().multiply(nodeMatrix(m.node).invert());
			const dw = new THREE.Vector3().setComponent(m.axis, m.d);
			const dl = dw.clone().applyMatrix3(new THREE.Matrix3().setFromMatrix4(parentM).invert());
			for (let i = 0; i < 3; i++) { if (m.node.exprs) delete m.node.exprs['pos.' + i]; m.node.pos[i] = exact(m.node.pos[i] + dl.getComponent(i)); }
			done.add(m.node.id);
		}
		this.commit();
		toast(`Lined up ${done.size} part${done.size > 1 ? 's' : ''} that sat a hair off — Undo (Ctrl+Z) puts ${done.size > 1 ? 'them' : 'it'} back`, 'ok', 5000);
		return done.size;
	},
};
