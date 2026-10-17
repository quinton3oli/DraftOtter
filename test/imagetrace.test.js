// Image tracing: outlines of dark (or light) shapes, holes included, areas accurate, specks dropped.
import { traceImage, loopArea } from '../src/imagetrace.js';

let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(ok ? 'ok  ' : 'FAIL', name, info); };

// a 120 × 80 white image with a black 60 × 40 rectangle that has a white Ø20 hole, plus one stray dark pixel
const w = 120, h = 80, data = new Uint8ClampedArray(w * h * 4);
const set = (x, y, v, a = 255) => { const p = (y * w + x) * 4; data[p] = data[p + 1] = data[p + 2] = v; data[p + 3] = a; };
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
	const inRect = x >= 30 && x < 90 && y >= 20 && y < 60, inHole = Math.hypot(x + 0.5 - 60, y + 0.5 - 40) < 10;
	set(x, y, inRect && !inHole ? 0 : 255);
}
set(5, 5, 0); // a speck
const img = { width: w, height: h, data };

let r = traceImage(img, { threshold: 0.5, smooth: 2, minArea: 4 });
const areas = r.loops.map((l) => Math.abs(loopArea(l))).sort((a, b) => b - a);
check('a shape with a hole traces as two outlines', r.loops.length === 2, JSON.stringify({ n: r.loops.length, areas }));
check('outer outline ≈ 60 × 40 = 2400 px²', Math.abs(areas[0] - 2400) < 40, String(areas[0]));
check('hole ≈ π·10² = 314 px²', Math.abs(areas[1] - Math.PI * 100) < 15, String(areas[1]));
check('the speck is dropped', r.dropped === 1, String(r.dropped));
check('simplified: a rectangle-with-hole needs few points', r.points < 120, String(r.points));
// the rectangle's corners stay sharp (simplification keeps them, smoothing only rounds them a little)
const outer = r.loops.find((l) => Math.abs(loopArea(l)) > 1000);
const xs = outer.map((p) => p[0]), ys = outer.map((p) => p[1]);
check('outer outline spans the rectangle (sub-pixel edges)', Math.abs(Math.min(...xs) - 29.5) < 0.6 && Math.abs(Math.max(...xs) - 89.5) < 0.6 && Math.abs(Math.min(...ys) - 19.5) < 0.6 && Math.abs(Math.max(...ys) - 59.5) < 0.6, JSON.stringify([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]));

// inverted: the light areas are the shape
r = traceImage(img, { threshold: 0.5, invert: true, smooth: 2, minArea: 4 });
check('inverted: the white background (with the rectangle as its hole) and the white disc', r.loops.length === 3, String(r.loops.length));

// transparent background: only the opaque ink counts
const t = new Uint8ClampedArray(w * h * 4);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const p = (y * w + x) * 4; const on = x >= 40 && x < 80 && y >= 30 && y < 50; t[p] = t[p + 1] = t[p + 2] = 20; t[p + 3] = on ? 255 : 0; }
r = traceImage({ width: w, height: h, data: t }, { threshold: 0.5, smooth: 1, minArea: 4 });
check('a logo on a transparent background traces just the opaque part', r.loops.length === 1 && Math.abs(Math.abs(loopArea(r.loops[0])) - 800) < 25, JSON.stringify(r.loops.map((l) => Math.abs(loopArea(l)))));
// a shape touching the image edge still closes
const e = new Uint8ClampedArray(w * h * 4);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const p = (y * w + x) * 4; const on = x < 30; e[p] = e[p + 1] = e[p + 2] = on ? 0 : 255; e[p + 3] = 255; }
r = traceImage({ width: w, height: h, data: e }, { threshold: 0.5, smooth: 1, minArea: 4 });
check('a shape touching the edge of the image still closes', r.loops.length === 1 && Math.abs(Math.abs(loopArea(r.loops[0])) - 30 * 80) < 60, String(r.loops.length));

console.log(fails ? `${fails} FAILED` : 'imagetrace: all passed');
process.exit(fails ? 1 : 0);
