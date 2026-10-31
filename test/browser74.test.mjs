// No creeping rounding errors. (1) A push/pull is built on its face as the part has it now, not on the outline it
// stored: an outline saved rounded to 0.1 mm (as older versions did) on a face that is 40.03 × 30.07 still cuts the
// whole face cleanly — no leftover skin, no sliver triangles. (2) Grouping and ungrouping keep every part exactly where
// it was (each round trip used to round positions to 0.1 µm and rotations to 0.001°, and parts crept off each other).
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 240000, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1400, height: 900 } });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(pathToFileURL('DraftOtter.html').href);
await page.waitForFunction(() => document.body.classList.contains('ready'));
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(ok ? 'ok  ' : 'FAIL', name, info); };
const app = (fn, ...a) => page.evaluate(fn, ...a);

// ---- (1) a stale, rounded outline on a face that is not on round numbers
const r1 = await app(async () => {
	const a = window.DraftOtter;
	const box = { id: 'b1', type: 'box', name: 'Box', params: { w: 40.03, d: 30.07, h: 10, radius: 0, edgeType: 'fillet', seg: 4 }, pos: [0.004, -0.013, 5], rot: [0, 0, 0], scale: [1, 1, 1], color: '#e8613a', visible: true, locked: false, hole: false };
	// the outline as an older version saved it: rounded to 0.1 mm, so it is up to 0.05 mm off the real face
	const cut = { id: 'f1', type: 'facex', name: 'Push/pull', params: { depth: -1.6, draft: 0, loops: [[[-20, -15], [20, -15], [20, 15], [-20, 15]]], ref: { p: [0, 0, 10], n: [0, 0, 1], area: 1203.7 } }, pos: [0, 0, 10], rot: [0, 0, 0], scale: [1, 1, 1], color: '#e8613a', visible: true, locked: false, hole: true };
	a.model.doc.nodes = [{ id: 'g1', type: 'group', name: 'Box', mode: 'union', children: [box, cut], pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1], hole: false, color: '#e8613a', visible: true, locked: false, featureGroup: true, filletGroup: true }];
	a.sel = [];
	a.commit();
	for (let i = 0; i < 200 && a.bgBuild; i++) await a.bgBuild;
	const n = a.model.nodes[0], g = a.engine.printable([n], true), pos = g.attributes.position, C = a.vp.camera.position.constructor;
	let slivers = 0, zs = new Set();
	for (let i = 0; i < pos.count; i += 3) {
		const p = [0, 1, 2].map((k) => new C().fromBufferAttribute(pos, i + k));
		const cr = p[1].clone().sub(p[0]).cross(p[2].clone().sub(p[0])), area = cr.length() / 2;
		const long = Math.max(p[0].distanceTo(p[1]), p[1].distanceTo(p[2]), p[2].distanceTo(p[0]));
		if (area > 0 && (2 * area) / long < 1e-3) slivers++;
		if (Math.abs(Math.abs(cr.normalize().z) - 1) < 1e-6) zs.add(+p[0].z.toFixed(5));
	}
	return { tris: pos.count / 3, slivers, zs: [...zs].sort((p, q) => p - q), vol: a.engine.stats([n]).volume, err: a.engine.errors.has(n.id) };
});
check('a cut on the whole top face, saved with a rounded outline, cuts exactly that face', !r1.err && Math.abs(r1.vol - 40.03 * 30.07 * 8.4) < 0.01, JSON.stringify(r1));
check('…leaving a plain box: 12 triangles, flat faces only at z 0 and 8.4, no slivers', r1.tris === 12 && r1.slivers === 0 && r1.zs.length === 2 && Math.abs(r1.zs[1] - 8.4) < 1e-5, JSON.stringify(r1));

// ---- (2) group / ungroup round trips keep parts exactly in place
const r2 = await app(async () => {
	const a = window.DraftOtter;
	const mk = (id, pos, rot) => ({ id, type: 'box', name: id, params: { w: 10, d: 10, h: 10, radius: 0, edgeType: 'fillet', seg: 4 }, pos, rot, scale: [1, 1, 1], color: '#e8613a', visible: true, locked: false, hole: false });
	a.model.doc.nodes = [mk('p1', [12.345, -3.217, 5], [0, 0, 0]), mk('p2', [-7.777, 8.123, 5], [0, 0, 37.5]), mk('p3', [30.1, 0.001, 7.5], [10, 20, 30])];
	a.sel = [];
	a.commit();
	const world = () => a.model.nodes.flatMap(function all(n) { return n.children ? n.children.flatMap(all) : [n]; }).sort((p, q) => p.id.localeCompare(q.id)).map((n) => { a.vp.objs.get(n.id).updateWorldMatrix(true, false); return a.vp.objs.get(n.id).matrixWorld.toArray(); });
	const before = world();
	for (let round = 0; round < 6; round++) {
		a.setSelection(['p1', 'p2']); a.group('union');
		a.setSelection([a.model.nodes.find((n) => n.type === 'group').id, 'p3']); a.group('union');
		// spin the outer group so ungrouping has to compose rotations
		const outer = a.model.nodes[0];
		outer.rot = [0, 0, 0]; a.commit();
		a.setSelection([outer.id]); a.ungroup();
		a.setSelection([a.model.nodes.find((n) => n.type === 'group').id]); a.ungroup();
	}
	const after = world();
	let worst = 0;
	before.forEach((m, i) => m.forEach((v, k) => { worst = Math.max(worst, Math.abs(v - after[i][k])); }));
	// a part in a rotated group, ungrouped: its world place is kept (not rounded to 0.001° and 0.1 µm)
	a.setSelection(['p1', 'p2']); a.group('union');
	const g = a.model.nodes.find((n) => n.type === 'group');
	g.rot = [0, 0, 33.3]; g.pos = [1.5, 2.25, 0]; a.commit();
	const inGroup = world();
	a.setSelection([g.id]); a.ungroup();
	const out = world();
	let worstRot = 0;
	inGroup.forEach((m, i) => m.forEach((v, k) => { worstRot = Math.max(worstRot, Math.abs(v - out[i][k])); }));
	return { worst, worstRot, count: a.model.nodes.length, pos: a.model.get('p1').pos };
});
check('six group / ungroup round trips: every part exactly where it was (< 1e-8 mm)', r2.worst < 1e-8 && r2.count === 3, JSON.stringify(r2));
check('ungrouping a rotated group keeps the part in place (only float noise snapped: < 0.05 µm)', r2.worstRot < 5e-5, JSON.stringify(r2));

// ---- (3) fillets are fitted onto the part as it is: a boss on a plate, its vertical edge filleted. The cutter must
// not run on into the plate (it used to dig a groove 5% of the radius deep), and an edge saved 0.05 mm off (the boss
// moved since) still rounds the real edge — no ledge beside it. After moving the boss again, what is shown is what a
// fresh build gives (nothing stale kept from the build before).
const planesOf = () => app(async () => {
	const a = window.DraftOtter;
	for (let i = 0; i < 200 && a.bgBuild; i++) await a.bgBuild;
	const n = a.model.nodes[0], g = a.engine.printable([n], true), pos = g.attributes.position, C = a.vp.camera.position.constructor;
	const planes = { x: new Set(), y: new Set(), z: new Set() };
	for (let i = 0; i < pos.count; i += 3) {
		const q = [0, 1, 2].map((k) => new C().fromBufferAttribute(pos, i + k));
		const nn = q[1].clone().sub(q[0]).cross(q[2].clone().sub(q[0])).normalize();
		['x', 'y', 'z'].forEach((ax, k) => { if (Math.abs(Math.abs(nn.getComponent(k)) - 1) < 1e-6) planes[ax].add(+q[0].getComponent(k).toFixed(5)); });
	}
	const vol = a.engine.stats([n]).volume;
	a.engine.cache.clear(); a.engine.mcache.clear();
	const fresh = a.engine.stats([n]).volume;
	return { x: [...planes.x].sort((p, q) => p - q), y: [...planes.y].sort((p, q) => p - q), z: [...planes.z].sort((p, q) => p - q), vol, fresh };
});
await app(() => {
	const a = window.DraftOtter;
	const box = (id, w, d, h, pos) => ({ id, type: 'box', name: id, params: { w, d, h, radius: 0, edgeType: 'fillet', seg: 4 }, pos, rot: [0, 0, 0], scale: [1, 1, 1], color: '#e8613a', visible: true, locked: false, hole: false });
	// the edge as saved: 0.05 mm off the boss's corner (x 5.05), from the plate (z 5) to the boss top (z 25)
	const fillet = { id: 'e1', type: 'edgeop', name: 'Fillet', params: { kind: 'fillet', size: 2, size2: 0, segs: 12, chains: [{ pts: [[5.05, 5, 5], [5.05, 5, 25]], n1: [[1, 0, 0], [1, 0, 0]], n2: [[0, 1, 0], [0, 1, 0]], closed: false, convex: true }] }, pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1], color: '#e8613a', visible: true, locked: false, hole: true };
	a.model.doc.nodes = [{ id: 'g2', type: 'group', name: 'Part', mode: 'union', children: [box('plate', 40, 40, 5, [0, 0, 2.5]), box('boss', 10, 10, 20, [0, 0, 15]), fillet], pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1], hole: false, color: '#e8613a', visible: true, locked: false, featureGroup: true, filletGroup: true }];
	a.sel = [];
	a.commit();
});
let r3 = await planesOf();
check('a fillet down to a plate leaves the plate whole (flat tops only at z 0, 5 and 25)', JSON.stringify(r3.z) === '[0,5,25]', JSON.stringify(r3));
check('…and an edge saved 0.05 mm off rounds the real edge: no ledge beside it (sides only at ±5 and ±20)', JSON.stringify(r3.x) === '[-20,-5,5,20]' && JSON.stringify(r3.y) === '[-20,-5,5,20]', JSON.stringify(r3));
await app(() => { const a = window.DraftOtter; a.model.get('boss').pos = [0.03, 0, 15]; a.commit(); });
r3 = await planesOf();
check('after moving the boss again: the fillet follows it, and what is shown matches a fresh build', JSON.stringify(r3.x) === '[-20,-4.97,5.03,20]' && Math.abs(r3.vol - r3.fresh) < 1e-6, JSON.stringify(r3));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'browser74: all passed');
process.exit(fails ? 1 : 0);
