// Arrange on a circle: even spacing, live preview + cancel, changing the radius later, other axes, partial arcs.
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
const near = (a, b, e = 1e-3) => Math.abs(a - b) <= e;
const modalBtn = (label) => app((label) => [...document.querySelectorAll('.modal .btn')].find((b) => b.textContent.trim() === label).click(), label);
const setField = (id, v) => app(([id, v]) => { const i = document.querySelector('#' + id); i.value = v; i.dispatchEvent(new Event('input')); }, [id, v]);
const centers = () => app(() => window.LocalCAD.model.nodes.map((n) => { const b = window.LocalCAD.worldBox(n); const c = b.getCenter(b.min.clone()); return [+c.x.toFixed(3), +c.y.toFixed(3), +c.z.toFixed(3)]; }));
const radii = (cs, cx = 0, cy = 0) => cs.map(([x, y]) => Math.hypot(x - cx, y - cy));
const angles = (cs, cx = 0, cy = 0) => cs.map(([x, y]) => Math.atan2(y - cy, x - cx) * 180 / Math.PI).sort((a, b) => a - b);

// six boxes scattered in a row
await app(() => {
	localStorage.clear(); const a = window.LocalCAD; a.model.doc.nodes = []; a.commit();
	for (let i = 0; i < 6; i++) { a.addShape('box'); const n = a.model.nodes[i]; n.params.w = n.params.d = n.params.h = 6; n.pos = [-40 + i * 13 + (i % 2) * 3, (i % 3) * 4, 3]; }
	a.commit(); a.setSelection(a.model.nodes.map((n) => n.id)); a.frame();
});
await wait(300);
const before = await centers();
await app(() => window.LocalCAD.arrangeCircleDialog());
await wait(200);
await setField('ac-cx', '0'); await setField('ac-cy', '0'); await setField('ac-r', '30');
await wait(200);
let c = await centers();
check('live preview places them on the circle while the dialog is open', radii(c).every((r) => near(r, 30, 1e-2)), JSON.stringify(radii(c)));
check('the circle is drawn in the view', await app(() => !!window.LocalCAD.arrangeObj));
await shot('310-arrange-preview');
await modalBtn('Cancel');
await wait(200);
c = await centers();
check('Cancel puts everything back', JSON.stringify(c) === JSON.stringify(before), JSON.stringify(c));
check('…and removes the guide', await app(() => !window.LocalCAD.arrangeObj));

await app(() => window.LocalCAD.arrangeCircleDialog());
await wait(200);
await setField('ac-cx', '0'); await setField('ac-cy', '0'); await setField('ac-r', '30'); await setField('ac-start', '90');
await modalBtn('Arrange');
await wait(300);
c = await centers();
const ang = angles(c);
const gaps = ang.slice(1).map((v, i) => v - ang[i]);
check('Arrange: 6 objects on a Ø60 circle, 60° apart', radii(c).every((r) => near(r, 30, 1e-2)) && gaps.every((g) => near(g, 60, 1e-2)), JSON.stringify({ r: radii(c).map((v) => +v.toFixed(3)), gaps }));
check('one starts at 90° (straight up in Y)', c.some(([x, y]) => near(x, 0, 1e-2) && near(y, 30, 1e-2)), JSON.stringify(c));
check('heights are kept', c.every(([, , z]) => near(z, 3, 1e-3)));
const und = await app(() => { const a = window.LocalCAD; a.undo(); const r = a.model.nodes.map((n) => n.pos[0]); a.redo(); return r; });
check('undo returns to the scattered layout', near(und[0], before[0][0], 1e-3), JSON.stringify(und));

// later: open again — it finds the circle; change only the radius
await app(() => { const a = window.LocalCAD; a.setSelection(a.model.nodes.map((n) => n.id)); a.arrangeCircleDialog(); });
await wait(200);
const found = await app(() => ({ cx: +document.querySelector('#ac-cx').value, cy: +document.querySelector('#ac-cy').value, r: +document.querySelector('#ac-r').value, start: +document.querySelector('#ac-start').value, note: document.querySelector('.modal .form p').textContent }));
check('reopening detects the existing circle (center, radius)', near(found.cx, 0, 1e-2) && near(found.cy, 0, 1e-2) && near(found.r, 30, 1e-2) && /found the circle/.test(found.note), JSON.stringify(found));
await setField('ac-r', '45');
await modalBtn('Arrange');
await wait(300);
c = await centers();
const ang2 = angles(c);
check('changing just the radius keeps the angles', radii(c).every((r) => near(r, 45, 1e-2)) && ang2.every((a, i) => near(a, ang[i], 1e-2)), JSON.stringify(radii(c).map((v) => +v.toFixed(2))));
// the radius slider drives the field too
await app(() => { const a = window.LocalCAD; a.setSelection(a.model.nodes.map((n) => n.id)); a.arrangeCircleDialog(); });
await wait(200);
await app(() => { const s = document.querySelector('.modal input[type=range]'); s.value = '500'; s.dispatchEvent(new Event('input')); });
const rs = await app(() => +document.querySelector('#ac-r').value);
c = await centers();
check('the radius slider resizes the circle live', near(rs, 67.5, 0.01) && radii(c).every((r) => near(r, 67.5, 0.02)), String(rs));
await modalBtn('Cancel');

// a half circle around X, turned with the circle
await app(() => { const a = window.LocalCAD; a.setSelection(a.model.nodes.slice(0, 3).map((n) => n.id)); a.arrangeCircleDialog(); });
await wait(200);
await app(() => { const r = document.querySelector('.modal input[name=ac-axis][value=x]'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); });
await setField('ac-cx', '0'); await setField('ac-cy', '0'); await setField('ac-cz', '40'); await setField('ac-r', '20'); await setField('ac-start', '0'); await setField('ac-total', '180');
await app(() => { const t = document.querySelector('#ac-turn'); t.checked = true; t.dispatchEvent(new Event('change', { bubbles: true })); });
await modalBtn('Arrange');
await wait(300);
const yz = await app(() => window.LocalCAD.model.nodes.slice(0, 3).map((n) => { const b = window.LocalCAD.worldBox(n); const c = b.getCenter(b.min.clone()); return [+c.y.toFixed(2), +c.z.toFixed(2), n.rot[0]]; }).sort((p, q) => p[1] - q[1] || p[0] - q[0]));
check('half circle around X: 0°, 90°, 180° in the YZ plane', yz.some(([y, z]) => near(y, 20, 0.02) && near(z, 40, 0.02)) && yz.some(([y, z]) => near(y, 0, 0.02) && near(z, 60, 0.02)) && yz.some(([y, z]) => near(y, -20, 0.02) && near(z, 40, 0.02)), JSON.stringify(yz));
check('…and each one turned with the circle', new Set(yz.map((p) => Math.round(p[2]))).size === 3, JSON.stringify(yz.map((p) => p[2])));

// features inside a part: holes arranged around the part's center
await app(() => {
	const a = window.LocalCAD; a.model.doc.nodes = []; a.commit();
	a.addShape('cylinder'); const disc = a.model.nodes[0]; disc.params.r = 40; disc.params.h = 5; disc.pos = [0, 0, 2.5];
	for (let i = 0; i < 5; i++) { a.addShape('cylinder'); const h = a.model.nodes[i + 1]; h.params.r = 2; h.params.h = 20; h.hole = true; h.pos = [-20 + i * 9, 3, 2.5]; }
	a.commit(); a.setSelection(a.model.nodes.map((n) => n.id)); a.group();
	const g = a.model.nodes[0]; a.setSelection(g.children.slice(1).map((c) => c.id)); a.arrangeCircleDialog();
});
await wait(200);
// the dialog remembers the last choices (X axis, half circle, turning) — set them back
await app(() => { const r = document.querySelector('.modal input[name=ac-axis][value=z]'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); const t = document.querySelector('#ac-turn'); t.checked = false; });
await setField('ac-total', '360'); await setField('ac-cx', '0'); await setField('ac-cy', '0'); await setField('ac-cz', '2.5'); await setField('ac-r', '28');
await modalBtn('Arrange');
await wait(400);
const holes = await app(() => { const a = window.LocalCAD; return a.model.nodes[0].children.slice(1).map((c) => { const b = a.worldBox(c); const p = b.getCenter(b.min.clone()); return Math.hypot(p.x, p.y); }); });
const vol = await app(() => +window.LocalCAD.engine.stats([window.LocalCAD.model.nodes[0]]).volume.toFixed(0));
check('holes inside a part arranged on a bolt circle (R28) and still cutting', holes.length === 5 && holes.every((r) => near(r, 28, 0.02)) && vol < Math.PI * 1600 * 5 - 250, JSON.stringify({ holes, vol }));
await app(() => { const a = window.LocalCAD; a.setSelection([]); a.vp.setView('top'); a.frame(); });
await wait(600);
await shot('311-arrange-bolt-circle');

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'browser36: all passed');
process.exit(fails ? 1 : 0);
