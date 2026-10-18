// Rotate rings: on the ring = 15° steps, outside the ring = 1° steps (with tick marks), Shift = 1°.
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

const setup = async () => {
	await app(() => { localStorage.clear(); const a = window.DraftOtter; a.model.doc.nodes = []; a.model.settings.rotSnap = 15; a.commit(); a.addShape('box'); a.setSelection([a.model.nodes[0].id]); a.setGizmo('rotate'); a.vp.setView('top'); a.frame(); });
	await wait(400);
	// the view animates there: wait until the camera has stopped (slower on a busy machine)
	await page.evaluate(() => new Promise((done) => { const cam = window.DraftOtter.vp.camera; let last = '', same = 0, n = 0; const tick = () => { const k = cam.position.toArray().join(); same = k === last ? same + 1 : 0; last = k; if (same >= 5 || ++n > 600) done(); else requestAnimationFrame(tick); }; requestAnimationFrame(tick); })); // unchanged for 5 frames in a row
	await app(() => window.DraftOtter.vp.render());
	await wait(150);
};
// screen points on a circle of radius k·R around the Z ring's center, at the given angles (degrees)
const arc = (k, degs) => app(([k, degs]) => {
	const a = window.DraftOtter; a.vp.render(); a.vp.helpers.updateMatrixWorld(true);
	const H = a.vp.handles, R = H.ringRadius, c = H.rotGroup.position;
	return degs.map((d) => { const t = (d * Math.PI) / 180; return a.vp.project(c.clone().set(c.x + k * R * Math.cos(t), c.y + k * R * Math.sin(t), c.z)); });
}, [k, degs]);
const rotZ = () => app(() => window.DraftOtter.model.nodes[0].rot[2]);

// ---------------------------------------------------------------- on the ring: 15° steps
await setup();
let pts = await arc(1, [0, 10, 20, 30, 38]);
await page.mouse.move(cv.x + pts[0].x, cv.y + pts[0].y);
await wait(50);
const hint = await app(() => document.querySelector('#st-hint').textContent);
check('hovering a ring explains both step sizes', /15° steps/.test(hint) && /1° steps/.test(hint), hint);
await page.mouse.down();
for (const p of pts.slice(1)) await page.mouse.move(cv.x + p.x, cv.y + p.y, { steps: 4 });
const label = await app(() => document.querySelector('.vp-label.angle').textContent);
const coarseTicks = await app(() => { const t = window.DraftOtter.vp.handles.ticks; return t.visible ? t.geometry.attributes.position.count / 2 : 0; });
await page.mouse.up();
await wait(300);
let r = await rotZ();
check('dragging on the ring snaps to 15° (38° → 45°)', Math.abs(Math.abs(r) - 45) < 1e-6, String(r));
check('label shows the step size', label.includes('15° steps'), label);
check('coarse ticks every 15°', coarseTicks === 24, String(coarseTicks));

// ---------------------------------------------------------------- outside the ring: 1° steps
await setup();
const start = await arc(1, [0]);
pts = await arc(1.45, [5, 15, 25, 33, 37]);
await page.mouse.move(cv.x + start[0].x, cv.y + start[0].y);
await page.mouse.down();
for (const p of pts) await page.mouse.move(cv.x + p.x, cv.y + p.y, { steps: 4 });
const fine = await app(() => ({ inView: (() => { const b = document.querySelector('.vp-label.angle').getBoundingClientRect(), v = document.querySelector('#viewport').getBoundingClientRect(); return b.left >= v.left && b.right <= v.right && b.top >= v.top && b.bottom <= v.bottom; })(), label: document.querySelector('.vp-label.angle').textContent, ticks: window.DraftOtter.vp.handles.ticks.visible ? window.DraftOtter.vp.handles.ticks.geometry.attributes.position.count / 2 : 0 }));
await shot('130-rotate-fine');
await page.mouse.up();
await wait(300);
r = await rotZ();
check('dragging outside the ring rotates in 1° steps (≈37°)', Number.isInteger(r) && Math.abs(Math.abs(r) - 37) <= 1 && Math.abs(r) % 15 !== 0, String(r));
check('fine mode shows a 1° protractor and label', fine.ticks === 360 && fine.label.includes('1° steps') && fine.inView, JSON.stringify(fine));

// ---------------------------------------------------------------- Shift on the ring also gives 1°
await setup();
pts = await arc(1, [0, 10, 20, 32]);
await page.mouse.move(cv.x + pts[0].x, cv.y + pts[0].y);
await page.mouse.down();
await page.keyboard.down('Shift');
for (const p of pts.slice(1)) await page.mouse.move(cv.x + p.x, cv.y + p.y, { steps: 4 });
await page.mouse.up();
await page.keyboard.up('Shift');
await wait(300);
r = await rotZ();
check('Shift-drag on the ring gives 1° steps (≈32°)', Number.isInteger(r) && Math.abs(Math.abs(r) - 32) <= 1, String(r));
check('ticks hidden after the drag', !(await app(() => window.DraftOtter.vp.handles.ticks.visible)));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'browser19: all passed');
process.exit(fails ? 1 : 0);
