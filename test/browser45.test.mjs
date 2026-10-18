// Scale grips: the size labels never cover a grip (thin parts included), and the resize cursor's arrows follow the
// grip's direction on screen for the current view.
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
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(ok ? 'ok  ' : 'FAIL', name, info); };
const cv = await (await page.$('#viewport canvas')).boundingBox();

const setup = (w, d, h, view) => app(([w, d, h, view]) => {
	const a = window.QCAD; a.model.doc.nodes = []; a.addShape('box');
	const b = a.model.nodes[0]; b.params.w = w; b.params.d = d; b.params.h = h; b.pos = [0, 0, h / 2]; a.commit();
	a.vp.camera.up.set(0, 0, 1); a.setSelection([b.id]); a.vp.setGizmoMode('scale'); a.vp.setView(view); a.frame();
}, [w, d, h, view]);
// grips on screen and the label boxes (both relative to the canvas)
const layout = () => app(() => {
	const vp = window.QCAD.vp, H = vp.handles; vp.render();
	const fr = H.frame(), cr = vp.canvas.getBoundingClientRect();
	const grips = H.scaleHandles.map((h) => { const p = vp.project(h.position.clone().applyMatrix4(fr.F)); return { x: p.x, y: p.y, kind: h.userData.kind, axis: h.userData.axis, side: h.userData.side }; });
	const labels = H.labels.map((l) => { const r = l.getBoundingClientRect(); return { l: r.left - cr.left, t: r.top - cr.top, r: r.right - cr.left, b: r.bottom - cr.top, shown: l.style.display !== 'none', text: l.textContent }; });
	return { grips, labels };
});
const covered = (L) => L.labels.filter((b) => b.shown).flatMap((b) => L.grips.filter((g) => g.x > b.l - 4 && g.x < b.r + 4 && g.y > b.t - 4 && g.y < b.b + 4).map((g) => b.text + ' covers ' + g.kind + (g.axis ?? '')));

for (const [w, d, h, view] of [[60, 30, 2, 'iso'], [60, 2, 30, 'iso'], [4, 60, 30, 'iso'], [40, 40, 40, 'iso'], [60, 30, 2, 'front']]) {
	await setup(w, d, h, view);
	await wait(500);
	// the view animates there: measure once the camera has stopped moving (it can take longer on a busy machine)
	await page.evaluate(() => new Promise((done) => { const cam = window.QCAD.vp.camera; let last = '', same = 0, n = 0; const tick = () => { const k = cam.position.toArray().join(); same = k === last ? same + 1 : 0; last = k; if (same >= 5 || ++n > 600) done(); else requestAnimationFrame(tick); }; requestAnimationFrame(tick); })); // unchanged for 5 frames in a row
	const L = await layout();
	const c = covered(L);
	check(`${w}×${d}×${h} (${view}): no size label covers a scale grip`, c.length === 0, c.join(', '));
}
await page.screenshot({ path: 'test/shots/350-scale-labels.png' });

// cursor arrows follow the view
const cursorAt = async (pick) => {
	const L = await layout();
	const g = L.grips.find(pick);
	await page.mouse.move(cv.x + g.x, cv.y + g.y, { steps: 2 });
	await wait(80);
	return app(() => window.QCAD.vp.canvas.style.cursor);
};
await setup(40, 30, 20, 'front');
await wait(600);
const cz = await cursorAt((g) => g.kind === 'face' && g.axis === 2 && g.side > 0);
check('front view: the Z grip shows ↕', cz === 'ns-resize', cz);

// look straight down; then straight down but turned 45° — the arrows must turn with the view
const lookDown = (turnDeg) => app((t) => { const vp = window.QCAD.vp, c = vp.camera, r = t * Math.PI / 180; vp.controls.target.set(0, 0, 10); c.up.set(-Math.sin(r), Math.cos(r), 0); c.position.set(0, 0, 220); c.lookAt(0, 0, 10); c.updateMatrixWorld(); vp.render(); }, turnDeg);
await setup(40, 30, 20, 'top');
await wait(600);
await lookDown(0);
let cx = await cursorAt((g) => g.kind === 'face' && g.axis === 0 && g.side > 0);
let cy = await cursorAt((g) => g.kind === 'face' && g.axis === 1 && g.side > 0);
check('looking straight down: the X grip shows ↔ and the Y grip ↕', cx === 'ew-resize' && cy === 'ns-resize', JSON.stringify({ cx, cy }));
await lookDown(45);
cx = await cursorAt((g) => g.kind === 'face' && g.axis === 0 && g.side > 0);
cy = await cursorAt((g) => g.kind === 'face' && g.axis === 1 && g.side > 0);
check('view turned 45°: X and Y grips get the two diagonal arrows', /^(nwse|nesw)-resize$/.test(cx) && /^(nwse|nesw)-resize$/.test(cy) && cx !== cy, JSON.stringify({ cx, cy }));
await lookDown(90);
cx = await cursorAt((g) => g.kind === 'face' && g.axis === 0 && g.side > 0);
check('view turned 90°: the X grip now shows ↕', cx === 'ns-resize', cx);

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'browser45: all passed');
process.exit(fails ? 1 : 0);
