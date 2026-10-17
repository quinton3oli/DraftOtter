// Orbit / pan / zoom started from a point far away (near the horizon) must not fling the view away.
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 120000, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1500, height: 900 } });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(pathToFileURL('LocalCAD.html').href);
await page.waitForFunction(() => document.body.classList.contains('ready'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const app = (fn, ...a) => page.evaluate(fn, ...a);
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(ok ? 'ok  ' : 'FAIL', name, info); };
const cv = await (await page.$('#viewport canvas')).boundingBox();

// low camera looking across the bed, so the bed plane runs off towards the horizon
const lowView = () => app(() => {
	const a = window.LocalCAD; const vp = a.vp;
	a.model.doc.nodes = []; a.commit(); a.addShape('box'); a.setSelection([]);
	vp.controls.target.set(0, 0, 0); vp.camera.position.set(0, -420, 45); vp.camera.lookAt(0, 0, 0); vp.controls.update(); vp.render();
	const far = vp.project(new THREE_V(0, 6000, 0));
	return far;
	function THREE_V(x, y, z) { return vp.camera.position.clone().set(x, y, z); }
});
// where is the scene (bed center) on screen, and how far is the pivot from it?
const state = () => app(() => {
	const vp = window.LocalCAD.vp; vp.render();
	const c = vp.project(vp.camera.position.clone().set(0, 0, 0)), s = vp.sceneSphere ? vp.sceneSphere() : { center: vp.camera.position.clone().set(0, 0, 0), radius: 156 };
	const w = vp.container.clientWidth, h = vp.container.clientHeight;
	return { inView: !c.behind && c.x > 0 && c.x < w && c.y > 0 && c.y < h, pivotFromScene: +vp.controls.target.distanceTo(s.center).toFixed(1), radius: +s.radius.toFixed(1), camDist: +vp.camera.position.distanceTo(s.center).toFixed(1) };
});

// ---------------------------------------------------------------- orbit from the horizon
let far = await lowView();
await wait(200);
await page.mouse.move(cv.x + far.x, cv.y + far.y + 2);
await page.mouse.down({ button: 'right' });
let st = await state();
check('pivot stays within the scene when pressing near the horizon', st.pivotFromScene <= st.radius * 1.25, JSON.stringify(st));
await page.mouse.move(cv.x + far.x + 160, cv.y + far.y + 40, { steps: 12 });
await page.mouse.up({ button: 'right' });
await wait(600);
st = await state();
check('orbiting from the horizon keeps the scene in view', st.inView && st.camDist < 2000, JSON.stringify(st));

// ---------------------------------------------------------------- pan from the horizon
far = await lowView();
await wait(200);
const before = await state();
await page.mouse.move(cv.x + far.x, cv.y + far.y + 2);
await page.mouse.down({ button: 'middle' });
await page.mouse.move(cv.x + far.x + 120, cv.y + far.y + 2, { steps: 10 });
await page.mouse.up({ button: 'middle' });
await wait(600);
st = await state();
check('panning from the horizon moves a sensible amount (scene still in view)', st.inView && Math.abs(st.camDist - before.camDist) < 400, JSON.stringify({ before, after: st }));

// ---------------------------------------------------------------- wheel zoom out at the horizon
far = await lowView();
await wait(200);
await page.mouse.move(cv.x + far.x, cv.y + far.y + 2);
for (let i = 0; i < 3; i++) { await page.mouse.wheel({ deltaY: 100 }); await wait(60); }
await wait(600);
st = await state();
check('zooming out at the horizon does not shoot the camera away', st.inView && st.camDist < 1200, JSON.stringify(st));

// ---------------------------------------------------------------- pivot on an object is unchanged
await app(() => { const a = window.LocalCAD; a.model.doc.nodes = []; a.commit(); a.addShape('box'); a.setSelection([]); a.vp.camera.position.set(0, -80, 30); a.vp.controls.target.set(0, 0, 10); a.vp.controls.update(); });
await wait(300);
const pv = await app(() => {
	const vp = window.LocalCAD.vp; vp.render();
	const p = vp.project(vp.camera.position.clone().set(0, -10, 10)), r = vp.canvas.getBoundingClientRect();
	vp.retarget({ clientX: r.left + p.x, clientY: r.top + p.y });
	const fwd = vp.camera.getWorldDirection(vp.camera.position.clone()); const d = (q) => q.clone().sub(vp.camera.position).dot(fwd);
	return { target: +d(vp.controls.target).toFixed(2), top: +d(vp.camera.position.clone().set(0, -10, 10)).toFixed(2) };
});
check('pressing on an object still pivots at its depth', Math.abs(pv.target - pv.top) < 0.5, JSON.stringify(pv));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'browser20: all passed');
process.exit(fails ? 1 : 0);
