// Section view in the 3D view: drag the gizmo's arrow to move the plane, its rings to tilt it (about as far as the
// pointer sweeps), pick a face, type a position, slide it, type tilt angles, look straight at the cut.
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';
mkdirSync('test/shots', { recursive: true });
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 240000, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1500, height: 900 } });
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
const sec = () => app(() => { const s = window.QCAD.model.settings.section; return { on: s.on, axis: s.axis, normal: s.normal, offset: s.offset, flip: s.flip }; });
// screen position of a point in the section plane's own frame (u, v along the plane, w along the arrow)
const planePt = (u, v, w = 0) => app(([u, v, w]) => {
	const vp = window.QCAD.vp, t = vp.sectionTool; vp.render();
	const p = t.origin.clone().addScaledVector(t.u, u * t.size).addScaledVector(t.v, v * t.size).addScaledVector(window.__n = t.u.clone().cross(t.v), w * t.size);
	return vp.project(p);
}, [u, v, w]);
const dragFrom = async (a, b) => { await page.mouse.move(cv.x + a.x, cv.y + a.y, { steps: 2 }); await wait(80); await page.mouse.down(); await page.mouse.move(cv.x + b.x, cv.y + b.y, { steps: 8 }); await wait(80); await page.mouse.up(); await wait(150); };

await app(() => {
	localStorage.clear(); const a = window.QCAD; a.model.doc.nodes = []; a.addShape('box');
	const b = a.model.nodes[0]; b.params.w = 60; b.params.d = 30; b.params.h = 20; b.pos = [0, 0, 10]; a.model.settings.snap = 1; a.commit(); a.setSelection([]); a.vp.setView('iso'); a.frame();
});
await wait(600);
await app(() => window.QCAD.toggleSection());
await wait(300);
let s = await sec();
const bar = await app(() => { const p = document.querySelector('#section-panel'), r = p.getBoundingClientRect(), v = document.querySelector('#viewport').getBoundingClientRect(); return { shown: getComputedStyle(p).display !== 'none', top: r.top - v.top, text: p.innerText.replace(/\n/g, ' ') }; });
check('the section toolbar sits at the top of the view', bar.shown && bar.top < 80, JSON.stringify(bar));
check('section starts through the middle, across the long side (Y for a 60×30 part)', s.on && s.axis === 'y' && Math.abs(s.offset) < 1e-6, JSON.stringify(s));
check('the plane, its arrow and two tilt rings are drawn in the view', await app(() => { const t = window.QCAD.vp.sectionTool; return t.group.visible && t.handles.some((h) => h.userData.handle === 'move') && t.handles.filter((h) => h.userData.handle === 'tilt').length === 2; }));
await shot('340-section-plane');

// drag the arrow head along its direction
// a point of the gizmo (sizes in screen pixels, in the gizmo's own frame; the arrow part turns with Flip)
const gizmoPt = (x, y, z, onArrow = false) => app(([x, y, z, onArrow]) => {
	const vp = window.QCAD.vp, t = vp.sectionTool; vp.render();
	const p = (onArrow ? t.arrow : t.gizmo).localToWorld(new (t.gizmo.position.constructor)(x, y, z));
	return vp.project(p);
}, [x, y, z, onArrow]);
const tip = await gizmoPt(0, 0, 71, true);
// 6 mm further along the arrow, on screen
const further = await app(() => { const vp = window.QCAD.vp, t = vp.sectionTool; const p = t.arrow.localToWorld(new (t.gizmo.position.constructor)(0, 0, 71)); const n = t.u.clone().cross(t.v).multiplyScalar(window.QCAD.model.settings.section.flip ? -1 : 1); return vp.project(p.addScaledVector(n, 6)); });
const hov = await app(() => 0);
await page.mouse.move(cv.x + tip.x, cv.y + tip.y, { steps: 2 });
await wait(80);
check('hovering the arrow shows a grab cursor', await app(() => window.QCAD.vp.canvas.style.cursor === 'grab'));
await dragFrom(tip, further);
s = await sec();
check('dragging the arrow moves the plane ~6 mm, snapped to the 1 mm grid', Math.abs(s.offset - 6) <= 1 && Number.isInteger(s.offset), JSON.stringify(s));
const clip = await app(() => { const p = window.QCAD.vp.sectionPlane; return { n: p.normal.toArray(), c: p.constant }; });
check('…and the cut follows (clip plane at the new position)', Math.abs(Math.abs(clip.c) - Math.abs(s.offset)) < 1e-9, JSON.stringify(clip));
check('…and the typed position shows it', await app(() => +document.querySelector('#sec-val').value) === s.offset);

// type a position
await app(() => { const i = document.querySelector('#sec-val'); i.value = '-7.5'; i.dispatchEvent(new Event('change')); });
s = await sec();
check('typing a position moves the plane', s.offset === -7.5, JSON.stringify(s));

// tilt with a ring: sweep 35° around it (on the ring: 15° steps). The plane turns about as far as the pointer sweeps,
// not several times as far (the old rings turned ~57° for every 34 px of movement)
const ringPt = (ring, deg) => app(([ring, deg]) => {
	const vp = window.QCAD.vp, t = vp.sectionTool; vp.render();
	const p = t.rings[ring].holder.localToWorld(new (t.gizmo.position.constructor)(58 * Math.cos(deg * Math.PI / 180), 58 * Math.sin(deg * Math.PI / 180), 0));
	return vp.project(p);
}, [ring, deg]);
// pick the ring that faces the viewer more (a sweep is measured around its middle)
const facing = await app(() => { const vp = window.QCAD.vp, t = vp.sectionTool, e = vp.camera.position.clone().sub(t.gizmo.position).normalize(); return ['a', 'b'].map((r) => Math.abs(t.ringAxis(r).dot(e))); });
const R = facing[0] >= facing[1] ? 'a' : 'b', ri = R === 'a' ? 0 : 1;
const sweep = async (from, to, steps = 10) => {
	const p0 = await ringPt(R, from);
	await page.mouse.move(cv.x + p0.x, cv.y + p0.y, { steps: 2 }); await wait(60); await page.mouse.down();
	for (let i = 1; i <= steps; i++) { const q = await ringPt(R, from + ((to - from) * i) / steps); await page.mouse.move(cv.x + q.x, cv.y + q.y); }
	await wait(60); await page.mouse.up(); await wait(150);
};
const tilts = () => app(() => { const m = window.QCAD.__sec; return m.sectionTilts(window.QCAD.model.settings.section); });
await page.evaluate(() => { window.QCAD.__sec = { sectionTilts: (s) => { const el = (id) => +document.querySelector(id).value; return [el('#sec-tilt-a'), el('#sec-tilt-b')]; } }; });
await sweep(10, 45);
s = await sec();
let tl = await tilts();
check('sweeping 35° around a ring tilts the plane in 15° steps, by about as much as the sweep', s.axis === 'custom' && Math.abs(tl[ri]) >= 30 && Math.abs(tl[ri]) <= 45 && Math.abs(tl[ri] / 15 - Math.round(tl[ri] / 15)) < 1e-6 && tl[1 - ri] === 0, JSON.stringify({ s, tl, R }));
await shot('341-section-tilted');
// Straighten puts it back across the axis
await app(() => document.querySelector('#sec-straight').click());
s = await sec();
check('Straighten undoes the tilt', s.axis === 'y' && !s.normal, JSON.stringify(s));
// out past the ring: 1° steps, like the part rotator
const cpx = await app(() => window.QCAD.vp.project(window.QCAD.vp.sectionTool.gizmo.position));
const k1 = await ringPt(R, 10);
const ox = k1.x - cpx.x, oy = k1.y - cpx.y, ol = Math.hypot(ox, oy) || 1;
await page.mouse.move(cv.x + k1.x, cv.y + k1.y, { steps: 2 }); await wait(60); await page.mouse.down();
for (let i = 1; i <= 12; i++) {
	const q = await ringPt(R, 10 + 2 * i);
	const qx = q.x - cpx.x, qy = q.y - cpx.y, ql = Math.hypot(qx, qy) || 1;
	await page.mouse.move(cv.x + q.x + (qx / ql) * 70, cv.y + q.y + (qy / ql) * 70);
}
await page.mouse.up(); await wait(150);
tl = await tilts();
check('out past the ring the tilt goes in 1° steps', Math.abs(tl[ri]) >= 10 && Math.abs(tl[ri]) <= 35 && Number.isInteger(tl[ri]) && tl[ri] % 15 !== 0, JSON.stringify(tl));
// typed tilt angles
await app(() => { const i = document.querySelector('#sec-tilt-b'); i.value = '30'; i.dispatchEvent(new Event('change')); });
await app(() => { const i = document.querySelector('#sec-tilt-a'); i.value = '0'; i.dispatchEvent(new Event('change')); });
s = await sec();
const yn = await app(() => { const n = window.QCAD.model.settings.section.normal; return n; });
check('typing a tilt of 30° turns the plane exactly 30° off its axis', yn && Math.abs(Math.acos(yn[1]) * 180 / Math.PI - 30) < 1e-6, JSON.stringify(yn));
await app(() => document.querySelector('#sec-straight').click());
// the position slider spans the design and moves the plane
const sl = await app(() => { const r = document.querySelector('#sec-slider'); return { min: +r.min, max: +r.max }; });
check('the position slider spans the design (Y: −15 to 15)', Math.abs(sl.min + 15) < 0.2 && Math.abs(sl.max - 15) < 0.2, JSON.stringify(sl));
await app(() => { const r = document.querySelector('#sec-slider'); r.value = '9'; r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change')); });
s = await sec();
check('dragging the slider moves the cut', s.offset === 9 && Math.abs(Math.abs(await app(() => window.QCAD.vp.sectionPlane.constant)) - 9) < 1e-9, JSON.stringify(s));
await app(() => [...document.querySelectorAll('#section-panel .sec-step')][1].click());
check('+ steps it 1 mm', (await sec()).offset === 10);
// Look at cut: the camera turns to face the cut surface
await app(() => document.querySelector('#sec-look').click());
await wait(900);
const look = await app(() => { const vp = window.QCAD.vp, d = vp.camera.position.clone().sub(vp.controls.target).normalize(); return d.toArray(); });
check('Look at cut turns the view to face the cut straight on', Math.abs(look[1] - 1) < 1e-3, JSON.stringify(look));
await app(() => { const a = window.QCAD, sc = a.model.settings.section; sc.axis = 'y'; delete sc.normal; a.centerSection(); a.onSectionChanged(true); a.vp.setView('iso'); });
await wait(900);
await app(() => window.QCAD.frame());
await wait(600);
// the gizmo keeps its size on screen and sits in the middle of the view, also zoomed in
const giz = () => app(() => { const vp = window.QCAD.vp, t = vp.sectionTool; vp.render(); const c = vp.project(t.gizmo.position), tipp = vp.project(t.arrow.localToWorld(new (t.gizmo.position.constructor)(0, 0, 100))); const r = vp.canvas.getBoundingClientRect(); return { len: Math.hypot(tipp.x - c.x, tipp.y - c.y), off: Math.hypot(c.x - r.width / 2, c.y - r.height / 2) }; });
await app(() => { const a = window.QCAD, sc = a.model.settings.section; sc.axis = 'z'; delete sc.normal; a.vp.sectionTool.basis = null; a.centerSection(); a.onSectionChanged(true); a.vp.setView('iso'); a.frame(); });
await wait(600);
const g1 = await giz();
await app(() => { const vp = window.QCAD.vp, c = vp.camera, t = vp.controls.target; c.position.lerp(t, 0.8); vp.controls.update(); vp.render(); });
await wait(200);
const g2 = await giz();
check('the gizmo sits in the middle of the view and keeps its size when zooming in', g1.off < 4 && g2.off < 4 && Math.abs(g1.len - g2.len) < 0.25 * g1.len && g1.len < 140, JSON.stringify({ g1, g2 }));
await app(() => { const a = window.QCAD; a.vp.setView('iso'); a.frame(); });
await wait(600);

// axis buttons reset the direction
await app(() => [...document.querySelectorAll('#section-panel .sec-ax')].find((b) => b.dataset.ax === 'z').click());
s = await sec();
check('Z button: horizontal cut through the middle', s.axis === 'z' && !s.normal && Math.abs(s.offset - 10) < 1e-6, JSON.stringify(s));

// pick a face: the side face at x = +30
await app(() => document.querySelector('#sec-face').click());
const side = await app(() => { const vp = window.QCAD.vp; vp.render(); return vp.project(vp.camera.position.clone().set(30, 2, 5)); });
await page.mouse.move(cv.x + side.x, cv.y + side.y, { steps: 2 });
await page.mouse.click(cv.x + side.x, cv.y + side.y);
await wait(200);
s = await sec();
check('Face…: the plane lies on the clicked face, just inside it', s.normal && Math.abs(s.normal[0] - 1) < 1e-6 && Math.abs(s.offset - 29.5) < 1e-6, JSON.stringify(s));

// the plane's inside doesn't block picking the part behind it
await app(() => { const a = window.QCAD; a.model.settings.section.axis = 'y'; delete a.model.settings.section.normal; a.centerSection(); a.onSectionChanged(true); a.setSelection([]); });
const mid = await planePt(0.3, -0.05, 0); // away from the gizmo in the middle
await page.mouse.click(cv.x + mid.x, cv.y + mid.y);
await wait(150);
check('clicking inside the plane still selects the part behind it', await app(() => window.QCAD.sel.length === 1));
// hide the plane, close
await app(() => document.querySelector('#sec-plane').click());
check('the plane can be hidden (the cut stays)', await app(() => !window.QCAD.vp.sectionTool.group.visible && window.QCAD.vp.clipPlanes.length === 1));
await app(() => window.QCAD.toggleSection());
check('closing removes the cut and the plane', await app(() => !window.QCAD.vp.clipPlanes.length && !window.QCAD.vp.sectionTool.group.visible));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'browser44: all passed');
process.exit(fails ? 1 : 0);
