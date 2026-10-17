// Checks a binary STL for watertightness (every directed edge matched by its reverse) and reports volume.
import { readFileSync } from 'node:fs';
const buf = readFileSync(process.argv[2]);
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const n = dv.getUint32(80, true);
const edges = new Map();
let vol = 0;
const key = (o) => [0, 4, 8].map((k) => dv.getFloat32(o + k, true).toFixed(4)).join(',');
for (let t = 0; t < n; t++) {
	const o = 84 + t * 50 + 12;
	const v = [key(o), key(o + 12), key(o + 24)];
	const p = [0, 12, 24].map((k) => [0, 4, 8].map((j) => dv.getFloat32(o + k + j, true)));
	vol += (p[0][0] * (p[1][1] * p[2][2] - p[1][2] * p[2][1]) - p[0][1] * (p[1][0] * p[2][2] - p[1][2] * p[2][0]) + p[0][2] * (p[1][0] * p[2][1] - p[1][1] * p[2][0])) / 6;
	for (let k = 0; k < 3; k++) { const e = v[k] + '|' + v[(k + 1) % 3]; edges.set(e, (edges.get(e) || 0) + 1); }
}
let bad = 0;
for (const [e, c] of edges) { const [a, b] = e.split('|'); if ((edges.get(b + '|' + a) || 0) !== c) bad++; }
console.log(`${process.argv[2]}: ${n} triangles, volume ${(vol / 1000).toFixed(3)} cm³, unmatched edges: ${bad} ${bad ? '✗ NOT watertight' : '✓ watertight'}`);
