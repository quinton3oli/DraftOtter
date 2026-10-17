// Unit tests for the professional-feature modules (3MF/zip, mass properties, DXF/SVG, checks, …).
import * as THREE from 'three';
import { makeZip, readZip, crc32 } from '../src/zip.js';
import { build3MF } from '../src/threemf.js';
import { massProps, convexHull2 } from '../src/analysis.js';
import { parseSVG, parseDXF, shapesToModel, shapesToDXF, shapesToSVG, modelToShapes, shapesBox } from '../src/vector.js';
import { profileRegions, splinePoints } from '../src/sketchModel.js';
import { trim, extend, offset, addSlot, entity, paramOf } from '../src/sketchops.js';
import { thicknessScan, overhangScan } from '../src/printcheck.js';

let fails = 0;
const ok = (name, cond, info = '') => { if (!cond) fails++; console.log(cond ? 'ok  ' : 'FAIL', name, info); };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;
const box = (w, d, h, x = 0, y = 0, z = 0) => { const g = new THREE.BoxGeometry(w, d, h).toNonIndexed(); g.translate(x, y, z); return g; };

// ---------------------------------------------------------------- zip / 3MF
{
	ok('crc32 of "123456789" is CBF43926', crc32(new TextEncoder().encode('123456789')) === 0xcbf43926);
	const z = makeZip([{ name: 'a.txt', data: 'hello' }, { name: 'dir/b.bin', data: new Uint8Array([1, 2, 3]) }]);
	const back = readZip(z);
	ok('zip round-trips entries', new TextDecoder().decode(back['a.txt']) === 'hello' && back['dir/b.bin'].length === 3);
	const g1 = box(10, 10, 10, 0, 0, 5), g2 = box(4, 4, 4, 20, 0, 2);
	const bytes = build3MF([{ name: 'Body & lid', color: '#e8613a', positions: g1.attributes.position.array }, { name: 'Peg', color: '#3a8', positions: g2.attributes.position.array }], { title: 'Test' });
	const files = readZip(bytes);
	const model = new TextDecoder().decode(files['3D/3dmodel.model']);
	ok('3MF package has content types, rels and model', !!files['[Content_Types].xml'] && !!files['_rels/.rels'] && !!model);
	ok('3MF has two named objects with escaped names', (model.match(/<object /g) || []).length === 2 && model.includes('name="Body &amp; lid"'));
	ok('3MF colors as basematerials (#RRGGBBAA)', model.includes('displaycolor="#E8613AFF"') && model.includes('displaycolor="#33AA88FF"'));
	ok('3MF welds vertices (8 per cube, 12 triangles)', (model.match(/<vertex /g) || []).length === 16 && (model.match(/<triangle /g) || []).length === 24);
	ok('3MF is millimeters with build items', model.includes('unit="millimeter"') && (model.match(/<item /g) || []).length === 2);
}

// ---------------------------------------------------------------- mass properties
{
	const mp = massProps([box(10, 20, 30, 1, 2, 15)]);
	ok('volume, area and center of mass of a box', near(mp.volume, 6000, 1e-3) && near(mp.area, 2 * (200 + 300 + 600), 1e-3) && near(mp.com.x, 1, 1e-6) && near(mp.com.y, 2, 1e-6) && near(mp.com.z, 15, 1e-6), JSON.stringify(mp.com));
	ok('box standing on the bed is stable', mp.stable && mp.footprint.length === 4 && near(mp.margin, 5, 1e-6), String(mp.margin));
	// an L made of a thin post and a heavy overhanging block → tips
	const post = box(2, 2, 40, 0, 0, 20), block = box(30, 10, 10, 20, 0, 45);
	const tip = massProps([post, block]);
	ok('heavy overhang outside the footprint is flagged as unstable', !tip.stable && tip.margin < 0, String(tip.margin));
	const ball = new THREE.SphereGeometry(10, 32, 16).toNonIndexed(); ball.translate(0, 0, 10);
	ok('a sphere balances on a point (unstable)', !massProps([ball]).stable);
	const h = convexHull2([[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 0.5], [1, 0.5]]);
	ok('convex hull drops interior and collinear points', h.length === 4, JSON.stringify(h));
}

// ---------------------------------------------------------------- SVG / DXF
{
	const svg = `<?xml version="1.0"?><!-- logo --><svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="50mm" viewBox="0 0 200 100">
		<defs><circle id="x" cx="1" cy="1" r="99"/></defs>
		<g transform="translate(10,10)"><rect x="0" y="0" width="100" height="60"/><circle cx="50" cy="30" r="10"/></g>
		<path d="M150 10 h20 v20 h-20 z"/>
		<path d="M150 60 A 10 10 0 0 1 170 60 L 150 60 Z"/>
		<polygon points="0,90 10,90 5,99" style="display:none"/></svg>`;
	const sh = parseSVG(svg);
	ok('SVG: rect, circle, two paths (defs and hidden skipped)', sh.polylines.length === 3 && sh.circles.length === 1, JSON.stringify({ p: sh.polylines.length, c: sh.circles.length }));
	ok('SVG: viewBox scaled to mm and Y flipped', near(sh.circles[0].r, 5) && near(sh.circles[0].c[0], 30) && near(sh.circles[0].c[1], -20), JSON.stringify(sh.circles[0]));
	const rect = sh.polylines[0];
	const rb = shapesBox({ polylines: [rect], circles: [] });
	ok('SVG: rect becomes a closed 50×30 mm loop', rect.closed && near(rb.w, 50) && near(rb.h, 30), JSON.stringify(rb));
	const arcPath = sh.polylines[2], ab = shapesBox({ polylines: [arcPath], circles: [] });
	ok('SVG: elliptical-arc command flattens to a half circle (r 5 mm)', near(ab.w, 10, 1e-6) && near(ab.h, 5, 0.01), JSON.stringify(ab));
	// whole drawing → sketch model → profile regions: rect with a round hole, a square, a half-disc
	const m = shapesToModel(sh);
	const regions = profileRegions({ v: 2, ...m });
	ok('SVG → sketch: 3 solids, one with a hole', regions.length === 3 && regions.filter((r) => r.holes.length === 1).length === 1, JSON.stringify(regions.map((r) => r.holes.length)));

	const dxf = ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '1', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES',
		'0', 'LINE', '8', '0', '10', '0', '20', '0', '11', '2', '21', '0',
		'0', 'LINE', '8', '0', '10', '2', '20', '0', '11', '2', '21', '1',
		'0', 'ARC', '8', '0', '10', '1', '20', '1', '40', '1', '50', '0', '51', '180',
		'0', 'LINE', '8', '0', '10', '0', '20', '1', '11', '0', '21', '0',
		'0', 'CIRCLE', '8', '0', '10', '1', '20', '0.5', '40', '0.25',
		'0', 'LWPOLYLINE', '8', '0', '90', '2', '70', '1', '10', '5', '20', '0', '42', '1', '10', '7', '20', '0', '42', '1',
		'0', 'ENDSEC', '0', 'EOF'].join('\n');
	const d = parseDXF(dxf);
	ok('DXF: inches → mm, lines/arc/circle/bulged polyline read', d.polylines.length === 5 && d.circles.length === 1 && near(d.circles[0].r, 6.35) && near(d.polylines[0].pts[1][0], 50.8), JSON.stringify({ p: d.polylines.length, r: d.circles[0].r }));
	const dm = shapesToModel(d);
	const dr = profileRegions({ v: 2, ...dm });
	// arch: 2" × 1" rectangle with a half-circle top (r = 1") and a 0.5" hole, plus a full circle of two bulges (r = 1")
	const area = (p) => { let s = 0; for (let i = 0; i < p.length; i++) { const q = p[i], w = p[(i + 1) % p.length]; s += q[0] * w[1] - w[0] * q[1]; } return Math.abs(s / 2); };
	const arch = dr.find((r) => r.holes.length === 1), disc = dr.find((r) => !r.holes.length);
	ok('DXF: separate lines + arc join into a closed arch with a hole', !!arch && Math.abs(area(arch.outer) - (2 * 1 + Math.PI / 2) * 645.16) < 6, arch && area(arch.outer).toFixed(1));
	ok('DXF: two bulges of 1 make a full circle', !!disc && Math.abs(area(disc.outer) - Math.PI * 645.16) < 6, disc && area(disc.outer).toFixed(1));

	// export round trip: model → DXF → parse → same regions
	const back = parseDXF(shapesToDXF(modelToShapes(dm)));
	const br = profileRegions({ v: 2, ...shapesToModel(back) });
	ok('DXF export round-trips (lines, arcs, circles)', br.length === dr.length && Math.abs(area(br.find((r) => r.holes.length === 1).outer) - area(arch.outer)) < 0.5);
	const svgOut = shapesToSVG(modelToShapes(dm));
	const sb = parseSVG(svgOut);
	ok('SVG export is valid mm SVG that parses back', /width="[\d.]+mm"/.test(svgOut) && sb.polylines.length + sb.circles.length > 0);
}

// ---------------------------------------------------------------- print check scans
{
	const merge = (...gs) => { const n = gs.reduce((k, g) => k + g.attributes.position.array.length, 0), out = new Float32Array(n); let o = 0; for (const g of gs) { out.set(g.attributes.position.array, o); o += g.attributes.position.array.length; } const r = new THREE.BufferGeometry(); r.setAttribute('position', new THREE.BufferAttribute(out, 3)); return r; };
	const thick = thicknessScan(box(20, 20, 10, 0, 0, 5), { minWall: 0.8, minGap: 0.3 });
	ok('solid block: no thin walls, no gaps', !thick.thin.length && !thick.gaps.length);
	const plate = thicknessScan(box(20, 20, 0.5, 0, 0, 0.25), { minWall: 0.8, minGap: 0.3 });
	ok('0.5 mm plate: thin walls found, thinnest 0.5', plate.thin.length > 0 && near(plate.minT, 0.5, 1e-3) && plate.thinArea > 790, JSON.stringify({ n: plate.thin.length, t: plate.minT, a: plate.thinArea }));
	const pair = thicknessScan(merge(box(10, 10, 10, 0, 0, 5), box(10, 10, 10, 10.2, 0, 5)), { minWall: 0.8, minGap: 0.3 });
	ok('two blocks 0.2 mm apart: narrow gap found', pair.gaps.length === 4 && near(pair.minG, 0.2, 1e-3) && near(pair.gapArea, 200, 1e-3), JSON.stringify({ n: pair.gaps.length, g: pair.minG, a: pair.gapArea }));
	const t = box(10, 10, 10, 0, 0, 15); // floating cube: bottom face is an overhang
	const oh = overhangScan(t, 45, 0);
	ok('downward face above the bed is an overhang (100 mm²)', near(oh.area, 100, 1e-6), String(oh.area));
	ok('faces on the bed are not overhangs', near(overhangScan(box(10, 10, 10, 0, 0, 5), 45, 0).area, 0));
}

// ---------------------------------------------------------------- sketch operations
{
	const area = (p) => { let s = 0; for (let i = 0; i < p.length; i++) { const q = p[i], w = p[(i + 1) % p.length]; s += q[0] * w[1] - w[0] * q[1]; } return Math.abs(s / 2); };
	const M = () => ({ points: [], segs: [], circles: [], cons: [], radii: {} });
	const line = (m, a, b) => { const i = m.points.push(a) - 1, j = m.points.push(b) - 1; m.segs.push({ a: i, b: j }); return m.segs.length - 1; };
	// plus sign: trimming the right arm splits the vertical line where they cross
	let m = M();
	line(m, [-10, 0], [10, 0]); line(m, [0, -10], [0, 10]);
	trim(m, { kind: 'seg', i: 0 }, [5, 0.1]);
	const deg = (pid) => m.segs.filter((s) => s.a === pid || s.b === pid).length;
	const center = m.points.findIndex((p) => Math.hypot(p[0], p[1]) < 1e-9);
	ok('trim removes the clicked piece and joins the crossing line there', m.segs.length === 3 && center >= 0 && deg(center) === 3, JSON.stringify(m.segs));
	// rectangle + circle across its right edge → trim to a rectangle with a round bump
	m = M();
	const r0 = [[-10, -5], [10, -5], [10, 5], [-10, 5]].map((p) => m.points.push(p) - 1);
	for (let k = 0; k < 4; k++) m.segs.push({ a: r0[k], b: r0[(k + 1) % 4] });
	m.points.push([10, 0]); m.circles.push({ c: 4, r: 3 });
	trim(m, { kind: 'seg', i: 1 }, [10, 0.2]);
	ok('trimming an edge inside a circle splits the circle into arcs that share the corners', m.circles.length === 0 && m.segs.length === 7 && m.segs.filter((s) => s.arc).length === 2, JSON.stringify(m.segs));
	const inner = m.segs.findIndex((s) => s.arc && Math.abs(Math.min(m.points[s.a][0], m.points[s.b][0]) - 10) < 1e-6 && (() => { const e = entity(m, { kind: 'seg', i: m.segs.indexOf(s) }); const t = paramOf(e, [7, 0]); return t > 0 && t < 1; })());
	trim(m, { kind: 'seg', i: inner }, [7, 0]);
	const reg = profileRegions({ v: 2, ...m });
	ok('trim edge + circle gives one closed outline with a round bump', reg.length === 1 && Math.abs(area(reg[0].outer) - (200 + Math.PI * 9 / 2)) < 0.3, reg.length && area(reg[0].outer).toFixed(2));
	// extend a dangling line to a wall
	m = M();
	line(m, [0, 0], [5, 0]); line(m, [10, -5], [10, 5]);
	ok('extend reaches the next line and splits it there', extend(m, 0, [4.9, 0]) === null && Math.abs(m.points[m.segs[0].b][0] - 10) < 1e-9 && m.segs.length === 3, JSON.stringify(m.points));
	// offset a closed square outward and a slot (lines + arcs)
	m = M();
	const q = [[0, 0], [10, 0], [10, 10], [0, 10]].map((p) => m.points.push(p) - 1);
	for (let k = 0; k < 4; k++) m.segs.push({ a: q[k], b: q[(k + 1) % 4] });
	offset(m, [0, 1, 2, 3], [], 2);
	let regs = profileRegions({ v: 2, ...m });
	ok('offset a closed square outward by 2 → 14 × 14 around it', regs.length === 1 && Math.abs(area(regs[0].outer) - 196) < 1e-6 && regs[0].holes.length === 1, regs.map((r) => area(r.outer)).join());
	m = M();
	addSlot(m, [0, 0], [20, 0], 5);
	offset(m, [0, 1, 2, 3], [], 1);
	regs = profileRegions({ v: 2, ...m });
	ok('offset a slot keeps tangent arcs (R5 → R6)', regs.length === 1 && Math.abs(area(regs[0].outer) - (20 * 12 + Math.PI * 36)) < 0.5, regs.length && area(regs[0].outer).toFixed(2));
	m = M();
	addSlot(m, [0, 0], [30, 10], 4);
	regs = profileRegions({ v: 2, ...m });
	ok('slot tool geometry: stadium area', regs.length === 1 && Math.abs(area(regs[0].outer) - (Math.hypot(30, 10) * 8 + Math.PI * 16)) < 0.4, regs.length && area(regs[0].outer).toFixed(2));
	// spline passes through its points and closes a loop with a line
	const sp = splinePoints([0, 0], [20, 0], [[5, 6], [12, 7]]);
	ok('spline passes through its points', sp.some((p) => Math.hypot(p[0] - 5, p[1] - 6) < 1e-9) && sp.some((p) => Math.hypot(p[0] - 12, p[1] - 7) < 1e-9) && sp[sp.length - 1][0] === 20);
	m = M();
	m.points.push([0, 0], [20, 0]);
	m.segs.push({ a: 0, b: 1, spl: [[5, 6], [12, 7]] }, { a: 1, b: 0 });
	regs = profileRegions({ v: 2, ...m });
	ok('a spline and a line close into a region', regs.length === 1 && area(regs[0].outer) > 80);
}

console.log(fails ? `${fails} FAILED` : 'features: all passed');
process.exit(fails ? 1 : 0);
