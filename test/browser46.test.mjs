// Measuring on a section: the cut surface is a face on the section plane (not the wall behind it), its outline's
// corners and edges snap, and holes cut through show their diameter.
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';
mkdirSync('test/shots', { recursive: true });
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 240000, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1500, height: 900 } });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(pathToFileURL('LocalCAD.html').href);
await page.waitForFunction(() => document.body.classList.contains('ready'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const app = (fn, ...a) => page.evaluate(fn, ...a);
const shot = (n) => page.screenshot({ path: `test/shots/${n}.png` });
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(ok ? 'ok  ' : 'FAIL', name, info); };
const cv = await (await page.$('#viewport canvas')).boundingBox();
const scr = (p) => app((p) => { const vp = window.QCAD.vp; vp.render(); return vp.project(vp.camera.position.clone().set(...p)); }, p);
const moveTo = async (p) => { const s = await scr(p); await page.mouse.move(cv.x + s.x, cv.y + s.y, { steps: 3 }); await wait(120); return s; };
const clickAt = async (p) => { const s = await moveTo(p); await page.mouse.click(cv.x + s.x, cv.y + s.y); await wait(200); };
const res = () => app(() => { const m = window.QCAD.vp.measure, r = m.result; return r ? { main: m.label.textContent, d: r.d && r.d.toArray(), len: r.d && r.d.length(), perp: r.perp, angle: r.angle, kinds: m.ents.map((e) => e.kind + (e.cap ? '(cut)' : '')), pts: m.pts.map((p) => p.toArray().map((v) => +v.toFixed(4))) } : null; });
const section = (axis, offset, flip) => app(([axis, offset, flip]) => { const a = window.QCAD, s = a.model.settings.section; if (!s.on) a.toggleSection(); s.axis = axis; delete s.normal; s.offset = offset; s.flip = flip; s.showPlane = false; a.onSectionChanged(true); }, [axis, offset, flip]);

// a 40 × 30 × 10 plate with a Ø10 hole through the middle
await app(() => {
	localStorage.clear(); const a = window.QCAD; a.model.doc.nodes = []; a.addShape('box'); a.addShape('cylinder');
	const [b, c] = a.model.nodes; b.params.w = 40; b.params.d = 30; b.params.h = 10; b.pos = [0, 0, 5]; c.params.r = 5; c.params.h = 20; c.pos = [0, 0, 5]; c.hole = true; a.commit();
	a.setSelection([b.id, c.id]); a.group(); a.setSelection([]); a.vp.setView('iso'); a.frame();
});
await wait(600);
// cut through the hole along Y, keeping the back half so the cut surface faces the camera
await section('y', 0, true);
await wait(300);
await app(() => window.QCAD.setTool('measure'));
await moveTo([-12, 0, 5]);
const hov = await app(() => { const vp = window.QCAD.vp; const sp = vp.surfacePoint({ clientX: window.__x, clientY: window.__y }); return null; });
const sp = await app(([x, y]) => { const vp = window.QCAD.vp; const r = vp.canvas.getBoundingClientRect(); const s = vp.surfacePoint({ clientX: r.left + x, clientY: r.top + y }); return s && { cap: !!s.cap, p: s.point.toArray().map((v) => +v.toFixed(3)) }; }, [(await scr([-12, 0, 5])).x, (await scr([-12, 0, 5])).y]);
check('the cut surface is hit on the section plane (not the far wall behind it)', sp && sp.cap && Math.abs(sp.p[1]) < 1e-6 && Math.abs(sp.p[0] + 12) < 0.5, JSON.stringify(sp));
check('hovering the cut surface outlines it', await app(() => !!window.QCAD.vp.measure.caphoverFace));
await shot('360-section-measure-hover');

// corner to corner of the cut outline
await clickAt([-20, 0, 0]);
await clickAt([20, 0, 10]);
let r = await res();
check('cut outline corners snap: 40 wide and 10 tall exactly', r && r.kinds.join() === 'point,point' && Math.abs(r.d[0] - 40) < 1e-6 && Math.abs(r.d[2] - 10) < 1e-6 && Math.abs(r.d[1]) < 1e-6, JSON.stringify(r));
// wall thickness: outer edge to the hole's edge, both snapped onto the outline edges
await clickAt([-19.9, 0, 4.3]);
await clickAt([-5.15, 0, 6.2]);
r = await res();
check('wall thickness by snapping onto the cut edges: 15 mm', r && Math.abs(Math.abs(r.d[0]) - 15) < 0.05 && Math.abs(r.d[1]) < 1e-6, JSON.stringify(r));
await shot('361-section-measure-wall');
// the cut surface as a face: to the plate's top face is 90°
await clickAt([-12, 0, 5]);
await clickAt([-12, 8, 10]);
r = await res();
check('the cut surface measures as a face (90° to the top face)', r && r.kinds[0] === 'face(cut)' && Math.abs(r.angle - 90) < 1e-3, JSON.stringify(r));
// cut surface to a parallel face: the plate's back face (y = 15) is 15 mm behind the cut
await app(() => { window.QCAD.vp.setView('iso'); });
// a hole cut through by a horizontal section shows its diameter
await app(() => window.QCAD.vp.clearMeasure());
await section('z', 5, false);
await wait(300);
await moveTo([5.6, 0.4, 5]);
await moveTo([5.4, 0.3, 5]);
const round = await app(() => { const m = window.QCAD.vp.measure; return m.hover ? { kind: m.hover.kind, d: +(2 * m.hover.r).toFixed(3), mode: m.hover.mode, label: m.hlabel.textContent } : null; });
check('a hole cut through shows its diameter on the cut surface (Ø10)', round && round.kind === 'circle' && Math.abs(round.d - 10) < 0.05, JSON.stringify(round));
await shot('362-section-measure-hole');
await page.keyboard.press('Escape');

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'browser46: all passed');
process.exit(fails ? 1 : 0);
