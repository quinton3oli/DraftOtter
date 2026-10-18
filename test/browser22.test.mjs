// Measure tool: diameters of circles / cylinders / spheres / holes, arc radii, and center snapping.
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';
mkdirSync('test/shots', { recursive: true });
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 120000, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1500, height: 900 } });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(pathToFileURL('DraftOtter.html').href);
await page.waitForFunction(() => document.body.classList.contains('ready'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const app = (fn, ...a) => page.evaluate(fn, ...a);
const shot = (n) => page.screenshot({ path: `test/shots/${n}.png` });
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(ok ? 'ok  ' : 'FAIL', name, info); };
const cv = await (await page.$('#viewport canvas')).boundingBox();
const reset = async (src, view = 'iso') => {
	await app(([src, view]) => { localStorage.clear(); const a = window.DraftOtter; a.setTool(null); a.model.doc.nodes = []; a.sel = []; a.commit(); (0, eval)(src)(a); a.setSelection([]); a.vp.setView(view); a.frame(); }, [src.toString(), view]);
	await wait(900);
	await page.keyboard.press('m');
	await wait(100);
};
const scr = (x, y, z) => app(([x, y, z]) => { const vp = window.DraftOtter.vp; vp.render(); return vp.project(vp.camera.position.clone().set(x, y, z)); }, [x, y, z]);
const click = async (x, y, z) => { const p = await scr(x, y, z); await page.mouse.move(cv.x + p.x, cv.y + p.y, { steps: 2 }); await wait(60); await page.mouse.click(cv.x + p.x, cv.y + p.y); await wait(120); };
const hoverAt = async (x, y, z) => { const p = await scr(x, y, z); await page.mouse.move(cv.x + p.x, cv.y + p.y, { steps: 2 }); await wait(80); };
const pinned = () => app(() => { const m = window.DraftOtter.vp.measure; return m.pin ? { kind: m.pin.kind, d: +(2 * m.pin.r).toFixed(3), r: +m.pin.r.toFixed(3), c: m.pin.center.toArray().map((v) => +v.toFixed(3)), label: m.clabel.textContent } : null; });

// ---------------------------------------------------------------- cylinder: rim of the top face, and the curved wall
await reset((a) => { a.addShape('cylinder'); const n = a.model.nodes[0]; n.params.r = 12.5; n.params.h = 20; n.pos = [0, 0, 10]; a.commit(); });
await hoverAt(12.35, 0.2, 20);
const hov = await app(() => { const m = window.DraftOtter.vp.measure; return { kind: m.hover && m.hover.kind, mode: m.hover && m.hover.mode, label: m.hlabel.style.display !== 'none' ? m.hlabel.textContent : '' }; });
check('hovering a cylinder rim previews its diameter', hov.kind === 'circle' && hov.mode === 'edge' && hov.label.includes('Ø 25'), JSON.stringify(hov));
await click(12.35, 0.2, 20);
let r = await pinned();
check('clicking the rim pins Ø 25 at the top center', r && r.kind === 'circle' && Math.abs(r.d - 25) < 1e-3 && Math.abs(r.c[2] - 20) < 1e-3 && Math.hypot(r.c[0], r.c[1]) < 1e-3, JSON.stringify(r));
await shot('150-measure-circle');
await click(9, -8.66, 10); // on the curved wall
r = await pinned();
check('clicking a cylinder wall gives its diameter', r && r.kind === 'cylinder' && Math.abs(r.d - 25) < 1e-3, JSON.stringify(r));
const hint = await app(() => document.querySelector('#st-hint').textContent);
check('status bar shows Ø, R and center', /Ø 25/.test(hint) && /R 12\.5/.test(hint) && /center/.test(hint), hint);

// ---------------------------------------------------------------- a hole through a plate (after a boolean)
await reset((a) => {
	a.addShape('box'); a.addShape('cylinder');
	const [b, c] = a.model.nodes; b.params.w = 60; b.params.d = 40; b.params.h = 8; b.pos = [0, 0, 4]; c.params.r = 4.2; c.params.h = 20; c.pos = [10, 5, 4]; c.hole = true; a.commit();
	a.setSelection([b.id, c.id]); a.group();
}, 'top');
await click(10 + 4.2 * Math.cos(0.7) + 0.3, 5 + 4.2 * Math.sin(0.7) + 0.2, 8);
r = await pinned();
check('rim of a drilled hole gives its diameter (Ø 8.4)', r && Math.abs(r.d - 8.4) < 1e-3 && Math.abs(r.c[0] - 10) < 1e-3 && Math.abs(r.c[1] - 5) < 1e-3, JSON.stringify(r));

// ---------------------------------------------------------------- sphere
await reset((a) => { a.addShape('sphere'); const n = a.model.nodes[0]; n.params.r = 15; n.pos = [0, 0, 15]; a.commit(); });
await click(0, -10, 26);
r = await pinned();
check('sphere gives its diameter', r && r.kind === 'sphere' && Math.abs(r.d - 30) < 0.15, JSON.stringify(r));

// ---------------------------------------------------------------- arc: a slot end (straight sides + semicircles)
await reset((a) => {
	a.addShape('sketch' in {} ? 'x' : 'box'); const n = a.model.nodes[0];
	n.type = 'sketch'; n.name = 'Slot';
	n.params = { v: 2, points: [[-10, -3], [10, -3], [10, 3], [-10, 3]], segs: [{ a: 0, b: 1 }, { a: 1, b: 2, arc: 1 }, { a: 2, b: 3 }, { a: 3, b: 0, arc: 1 }], circles: [], cons: [], radii: {}, height: 5, mode: 'extrude', anchored: true };
	n.pos = [0, 0, 0]; a.commit();
}, 'top');
await click(10 + 3 * Math.cos(0.4) - 0.2, 3 * Math.sin(0.4), 5);
r = await pinned();
check('slot end is an arc with R 3', r && r.kind === 'arc' && Math.abs(r.r - 3) < 0.01 && /R 3/.test(r.label) && Math.abs(r.c[0] - 10) < 0.01, JSON.stringify(r));
await shot('151-measure-arc');

// ---------------------------------------------------------------- center snapping: center-to-center distance between two holes
await reset((a) => {
	a.addShape('box'); a.addShape('cylinder'); a.addShape('cylinder');
	const [b, c, d] = a.model.nodes; b.params.w = 80; b.params.d = 40; b.params.h = 6; b.pos = [0, 0, 3];
	for (const h of [c, d]) { h.params.r = 3; h.params.h = 20; h.hole = true; }
	c.pos = [-17.3, 4.1, 3]; d.pos = [21.9, -6.4, 3]; a.commit(); a.setSelection([b.id, c.id, d.id]); a.group();
}, 'top');
// hover near the first hole's center (over the hole, so the ray hits the hole wall) - use the rim, then the center point
await hoverAt(-17.3 + 3.2, 4.1, 6);
await hoverAt(-17.3, 4.1, 6);
let snap = await app(() => { const m = window.DraftOtter.vp.measure; return m.hover ? m.hover.mode : null; });
await click(-17.3, 4.1, 6);
await hoverAt(21.9 + 3.2, -6.4, 6);
await click(21.9, -6.4, 6);
const dist = await app(() => { const m = window.DraftOtter.vp.measure; return m.pts.length === 2 ? +m.pts[0].distanceTo(m.pts[1]).toFixed(3) : null; });
const want = +Math.hypot(21.9 + 17.3, -6.4 - 4.1).toFixed(3);
check('center of a hole snaps (center-to-center distance is exact)', dist === want, `snap=${snap} dist=${dist} want=${want}`);
await shot('152-measure-centers');

// ---------------------------------------------------------------- plain point-to-point still works away from round features
await reset((a) => { a.addShape('box'); }, 'top');
await click(-5, -5, 20);
await click(5, 3, 20);
const pp = await app(() => { const m = window.DraftOtter.vp.measure; return { n: m.pts.length, pin: !!m.pin }; });
check('flat faces keep point-to-point measuring', pp.n === 2 && !pp.pin, JSON.stringify(pp));
await page.keyboard.press('Escape');
await wait(100);
const cleared = await app(() => { const m = window.DraftOtter.vp.measure; return !m.pinObj && !m.hoverObj && m.clabel.style.display === 'none' && m.hlabel.style.display === 'none'; });
check('leaving the tool clears round-feature overlays', cleared);

// ---------------------------------------------------------------- faces: cylinder height, parallel gap + offset, angle, X/Y/Z legs
const res = () => app(() => { const m = window.DraftOtter.vp.measure; const r = m.result; return r ? { perp: r.perp, offset: r.offset, angle: r.angle, legs: (m.legs || []).map((l) => l.label.textContent), main: m.label.textContent, kinds: m.ents.map((e) => e.kind) } : null; });
await reset((a) => { a.addShape('cylinder'); const n = a.model.nodes[0]; n.params.r = 10; n.params.h = 30; n.pos = [0, 0, 15]; a.commit(); });
await click(4, 3, 30);
await click(25, 0, 0);
r = await res();
check('cylinder height: top face to the bed reads ⊥ 30 (no diameter in the way)', r && r.kinds.join() === 'face,point' && Math.abs(r.perp - 30) < 1e-3 && !(await pinned()), JSON.stringify(r));
await shot('153-measure-height');
await reset((a) => { a.addShape('box'); a.addShape('box'); const [p, q] = a.model.nodes; for (const b of [p, q]) { b.params.w = b.params.d = b.params.h = 10; } p.pos = [0, 0, 5]; q.pos = [30, 8, 5]; a.commit(); });
await click(5, -1, 6);
await click(35, 9, 4);
r = await res();
check('two parallel faces: gap ⊥ 30 and sideways offset 8 as two legs', r && r.kinds.join() === 'face,face' && Math.abs(r.perp - 30) < 1e-3 && Math.abs(r.offset - 8) < 1e-3 && r.legs.length === 2 && /⊥ 30/.test(r.legs[0]) && /offset 8/.test(r.legs[1]), JSON.stringify(r));
await shot('154-measure-faces');
await click(1, 2, 10);
await click(5, 1, 3);
r = await res();
check('top face and side face: 90° apart', r && Math.abs(r.angle - 90) < 1e-3 && /∠ 90/.test(r.main), JSON.stringify(r));
await click(5, -5, 10);
await click(35, 3, 10);
r = await res();
check('corner to corner: distance with X and Y legs', r && r.kinds.join() === 'point,point' && r.legs.length === 2 && /X 30/.test(r.legs[0]) && /Y 8/.test(r.legs[1]) && r.main.startsWith('31.048'), JSON.stringify(r));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'browser22: all passed');
process.exit(fails ? 1 : 0);
