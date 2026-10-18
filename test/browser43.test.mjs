// Kernel performance work: live Manifold solids between nested joins, flattened cut chains, typed-array welding and
// edge lines. Results must match the plain step-by-step mesh path exactly.
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 600000, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1500, height: 900 } });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(pathToFileURL('DraftOtter.html').href);
await page.waitForFunction(() => document.body.classList.contains('ready'));
const app = (fn, ...a) => page.evaluate(fn, ...a);
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(ok ? 'ok  ' : 'FAIL', name, info); };

// a 25-deep chain: plate, then each level cuts one more hole (Cut → Cut → … like a real feature history)
const chain = await app(() => {
	const a = window.QCAD, E = a.engine; E.setPool(null);
	a.model.doc.nodes = []; a.addShape('box');
	const plate = a.model.nodes[0]; plate.params.w = 120; plate.params.d = 60; plate.params.h = 8; plate.pos = [0, 0, 4];
	a.commit();
	for (let i = 0; i < 25; i++) {
		a.addShape('cylinder');
		const h = a.model.nodes[a.model.nodes.length - 1]; h.params.r = 1.5 + (i % 3) * 0.5; h.params.h = 20; h.hole = true; h.pos = [-55 + (i % 13) * 9, i < 13 ? -15 : 15, 4];
		a.commit(); a.setSelection([a.model.nodes[0].id, h.id]); a.group(); a.model.nodes[0].name = 'Cut ' + (i + 1);
	}
	const top = a.model.nodes[0];
	const depth = (n) => (n.children ? 1 + Math.max(...n.children.map(depth)) : 0);
	const clear = () => { E.cache.clear(); E.lastById.clear(); for (const m of E.mcache.values()) m.delete(); E.mcache.clear(); };
	const res = {};
	for (const flat of [true, false]) { E.flatten = flat; clear(); const t0 = performance.now(); const v = E.stats([top]).volume; res[flat ? 'flat' : 'steps'] = { v, ms: performance.now() - t0 }; }
	// the old way: every level converted to a mesh and back (csgMesh)
	clear(); E.flatten = true;
	const mesh = (n) => (n.type === 'group' ? E.csgMesh(n) : E.geometry(n));
	const origCsg = E.csg; E.csg = (g) => E.csgMesh(g);
	const t0 = performance.now(); const vMesh = E.stats([top]).volume; const msMesh = performance.now() - t0;
	E.csg = origCsg; clear();
	const exact = 120 * 60 * 8 - [...Array(25)].reduce((s, _, i) => s + Math.PI * (1.5 + (i % 3) * 0.5) ** 2 * 8, 0);
	return { depth: depth(top), ...res, vMesh, msMesh, exact };
});
check('25-deep cut chain: flattened, step-by-step and the old mesh path agree', Math.abs(chain.flat.v - chain.steps.v) < 1e-6 && Math.abs(chain.flat.v - chain.vMesh) < 0.01 && Math.abs(chain.flat.v - chain.exact) < 5, JSON.stringify(chain));
check(`live solids beat converting every level (${Math.round(chain.msMesh)} ms → ${Math.round(chain.flat.ms)} ms)`, chain.flat.ms < chain.msMesh, '');

// mirrored and scaled parts inside groups (the kernel's own transforms, incl. reflections)
const mir = await app(() => {
	const a = window.QCAD, E = a.engine;
	a.model.doc.nodes = []; a.addShape('wedge'); a.addShape('box');
	const [w, b] = a.model.nodes; w.scale = [-1, 1.5, 1]; w.pos = [5, 0, 5]; b.params.w = 4; b.params.d = 4; b.params.h = 30; b.hole = true; b.pos = [5, 0, 5]; a.commit();
	a.setSelection([w.id, b.id]); a.group();
	const g = a.model.nodes[0]; g.scale = [1, 1, 2]; a.commit();
	a.addShape('box'); a.commit(); a.setSelection([g.id, a.model.nodes[1].id]); a.group();
	const top = a.model.nodes[0];
	E.cache.clear(); E.lastById.clear();
	const live = E.stats([top]).volume;
	const origCsg = E.csg; E.csg = (x) => E.csgMesh(x); E.cache.clear(); const viaMesh = E.stats([top]).volume; E.csg = origCsg; E.cache.clear();
	return { live, viaMesh };
});
check('mirrored and scaled parts inside groups come out the same', Math.abs(mir.live - mir.viaMesh) < 0.01 && mir.live > 0, JSON.stringify(mir));

// the live-solid cache stays bounded
const bounded = await app(() => {
	const a = window.QCAD, E = a.engine;
	a.model.doc.nodes = [];
	for (let i = 0; i < 40; i++) { a.addShape('box'); a.addShape('cylinder'); const [b, c] = a.model.nodes.slice(-2); b.pos = [i * 25, 0, 10]; c.pos = [i * 25, 0, 10]; c.hole = true; c.params.r = 3 + (i % 5); a.commit(); a.setSelection([b.id, c.id]); a.group(); }
	for (let k = 0; k < 10; k++) { for (const g of a.model.nodes) g.children[1].params.r += 0.01; E.stats(a.model.nodes); }
	return E.mcache.size;
});
check('live solids are freed as designs change (cache stays bounded)', bounded <= 300, String(bounded));

// edge lines from the typed-array version
const edges = await app(() => {
	const a = window.QCAD;
	a.model.doc.nodes = []; a.addShape('box'); a.addShape('cylinder'); a.model.nodes[1].pos = [40, 0, 10]; a.commit();
	const counts = [];
	a.vp.scene.traverse((o) => { if (o.isLineSegments && o.parent && o.parent.userData && o.geometry.attributes.position) counts.push(o.geometry.attributes.position.count / 2); });
	return counts.sort((x, y) => x - y);
});
check('edge lines: a box has 12, a cylinder its two rims', edges.includes(12) && edges.some((c) => c >= 64), JSON.stringify(edges));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'browser43: all passed');
process.exit(fails ? 1 : 0);
