// FEA solver check against beam theory: a cantilever under a tip load.
import { solverMain } from '../src/fea.js';
let fails = 0;
const ok = (name, cond, info = '') => { if (!cond) fails++; console.log(cond ? 'ok  ' : 'FAIL', name, info); };
const run = (data) => {
	let result = null;
	globalThis.self = { postMessage: (m) => { if (m.done) result = m; } };
	solverMain();
	self.onmessage({ data });
	return result;
};
for (const [label, h] of [['4 cubes thick', 2.5], ['2 cubes thick', 5]]) {
	const L = 100, b = 10, t = 10, E = 3500, nu = 0.36, F = 10;
	const nx = L / h, ny = b / h, nz = t / h, NX = nx + 1, NY = ny + 1;
	const solid = new Uint8Array(nx * ny * nz).fill(1);
	const fixed = [], loads = new Float64Array(NX * NY * (nz + 1) * 3);
	const tip = [];
	for (let k = 0; k <= nz; k++) for (let j = 0; j <= ny; j++) { fixed.push(0 + NX * (j + NY * k)); tip.push(nx + NX * (j + NY * k)); }
	for (const n of tip) loads[3 * n + 2] = -F / tip.length;
	const t0 = Date.now();
	const r = run({ nx, ny, nz, h, solid, fixed, loads, E, nu });
	const dz = tip.reduce((s, n) => s + r.u[3 * n + 2], 0) / tip.length;
	const I = (b * t ** 3) / 12, G = E / (2 * (1 + nu));
	const theory = (F * L ** 3) / (3 * E * I) + (F * L) / ((5 / 6) * G * b * t);
	ok(`cantilever tip deflection, ${label}`, Math.abs(-dz - theory) / theory < 0.08, `${(-dz).toFixed(3)} mm vs beam theory ${theory.toFixed(3)} mm (${r.iterations} iterations, ${Date.now() - t0} ms)`);
	// bending stress near the root at the outer fiber: σ = M·c/I, sampled at the first row of elements (x = h/2, z = t/2 − h/2)
	let maxRoot = 0;
	for (let e = 0; e < r.vm.length; e++) if (r.elems[3 * e] === 1) maxRoot = Math.max(maxRoot, r.vm[e]);
	const sigma = (F * (L - 1.5 * h) * (t / 2 - h / 2)) / I;
	ok(`root bending stress, ${label}`, Math.abs(maxRoot - sigma) / sigma < 0.2, `${maxRoot.toFixed(2)} MPa vs ${sigma.toFixed(2)} MPa`);
}
console.log(fails ? `${fails} FAILED` : 'fea: all passed');
process.exit(fails ? 1 : 0);
