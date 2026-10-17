// Fast fit growth: convex pieces, extrusions (2D offset) and per-solid growth must match plain Minkowski, much faster;
// slow results are kept across a page reload.
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 600000, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1500, height: 900 } });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(pathToFileURL('LocalCAD.html').href);
await page.waitForFunction(() => document.body.classList.contains('ready'));
const app = (fn, ...a) => page.evaluate(fn, ...a);
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(ok ? 'ok  ' : 'FAIL', name, info); };

// grow one hole both ways: fast paths on and off; report added volume, size and time
const compare = (label, build, axes, clr = 0.4) => app(([build, axes, clr]) => {
	const a = window.LocalCAD, E = a.engine;
	a.model.doc.nodes = []; a.commit();
	// eslint-disable-next-line no-new-func
	const n = new Function('a', build)(a);
	const vol = (g) => { const p = g.attributes.position, idx = g.index; let v = 0; const tri = idx ? idx.count / 3 : p.count / 3; for (let t = 0; t < tri; t++) { const [i, j, k] = idx ? [idx.getX(3 * t), idx.getX(3 * t + 1), idx.getX(3 * t + 2)] : [3 * t, 3 * t + 1, 3 * t + 2]; const ax = p.getX(i), ay = p.getY(i), az = p.getZ(i), bx = p.getX(j), by = p.getY(j), bz = p.getZ(j), cx = p.getX(k), cy = p.getY(k), cz = p.getZ(k); v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6; } return v; };
	const size = (g) => { g.computeBoundingBox(); const s = g.boundingBox.getSize(g.boundingBox.min.clone()); return [+s.x.toFixed(3), +s.y.toFixed(3), +s.z.toFixed(3)]; };
	n.hole = true;
	const base = E.geometry(n), v0 = vol(base), s0 = size(base);
	n.fit = 'custom'; n.fitClearance = clr; n.fitAxes = axes;
	const run = (fast) => { E.setFastFit(fast); const t0 = performance.now(); const g = E.geometry(n); return { ms: Math.round(performance.now() - t0), dv: vol(g) - v0, size: size(g) }; };
	const slow = run(false), fast = run(true);
	E.setFastFit(true);
	return { s0, slow, fast };
}, [build, axes, clr]);
const same = (r, tol = 0.02) => Math.abs(r.fast.dv - r.slow.dv) <= tol * Math.abs(r.slow.dv) + 0.5 && r.fast.size.every((v, i) => Math.abs(v - r.slow.size[i]) < 0.01);
const show = (r) => JSON.stringify({ base: r.s0, slow: r.slow, fast: r.fast });

const STAR = "a.addShape('star'); return a.model.nodes[0];";
let r = await compare('star', STAR, 'xy');
check('star (extrusion) grown in X+Y: same as Minkowski', same(r) && r.fast.size[2] === r.s0[2], show(r));
r = await compare('star', STAR, 'x');
check('star grown in X only: same as Minkowski', same(r) && r.fast.size[1] === r.s0[1], show(r));
r = await compare('star', STAR, 'z');
check('star grown in Z only: just deeper', same(r) && Math.abs(r.fast.size[2] - r.s0[2] - 0.4) < 1e-3, show(r));
const TEXT = "a.addShape('text'); const n = a.model.nodes[0]; n.params.text = 'Fit'; return n;";
r = await compare('text', TEXT, 'xy');
check('text grown in X+Y: same as Minkowski, much faster', same(r) && r.fast.ms * 5 < r.slow.ms, show(r));
// a group: a box plus a star lying on its side (an extrusion along X inside the group) — grown in Y+Z
const GROUP = "a.addShape('box'); a.addShape('star'); const [b, s] = a.model.nodes; b.params.w = 20; b.params.d = 6; b.params.h = 6; s.rot = [0, 90, 0]; s.pos = [12, 0, 0]; a.commit(); a.setSelection([b.id, s.id]); a.group(); return a.model.nodes[0];";
r = await compare('group', GROUP, 'yz');
check('group of a box and a sideways star, Y+Z: same as Minkowski, much faster', same(r) && r.fast.size[0] === r.s0[0] && r.fast.ms * 5 < r.slow.ms, show(r));
r = await compare('group', GROUP, 'xyz');
check('…and in X+Y+Z (ball): same as Minkowski', same(r, 0.03), show(r));
// two separate pieces in one mesh-like group
const TWO = "a.addShape('sphere'); a.addShape('sphere'); const [p, q] = a.model.nodes; q.pos = [30, 0, 0]; a.commit(); a.setSelection([p.id, q.id]); a.group(); return a.model.nodes[0];";
r = await compare('two', TWO, 'xyz');
check('two separate spheres: each grown on its own, same result', same(r), show(r));

// a shape with no shortcut (torus): kept across a reload
const t1 = await app(() => {
	const a = window.LocalCAD; a.model.doc.nodes = []; a.addShape('torus'); const n = a.model.nodes[0]; n.hole = true; n.fit = 'custom'; n.fitClearance = 0.4; n.fitAxes = 'xy';
	a.engine.cache.clear(); const t0 = performance.now(); a.engine.geometry(n); const ms = performance.now() - t0; a.commit(); a.autosaveNow(); return Math.round(ms);
});
await new Promise((res) => setTimeout(res, 800)); // let the background save finish
await page.reload();
await page.waitForFunction(() => document.body.classList.contains('ready'));
const t2 = await app(() => { const a = window.LocalCAD, n = a.model.nodes[0]; a.engine.cache.clear(); const t0 = performance.now(); const g = a.engine.geometry(n); return { ms: Math.round(performance.now() - t0), fit: n.fit, tris: g.attributes.position.count }; });
check('a slow grown hole is reused after reloading the page', t2.fit === 'custom' && t2.ms < 100 && t1 > 300, JSON.stringify({ first: t1, afterReload: t2 }));
const t3 = await app(() => { const a = window.LocalCAD, n = a.model.nodes[0]; n.fitClearance = 0.5; a.engine.cache.clear(); const t0 = performance.now(); a.engine.geometry(n); return Math.round(performance.now() - t0); });
check('…but a changed clearance is grown again', t3 > 300, String(t3));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'browser38: all passed');
process.exit(fails ? 1 : 0);
