// Placement snaps to the grid: new parts, dragging (absolute grid, not just the drag distance), dropping on a face, Place on face.
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
const screen = (x, y, z) => app(([x, y, z]) => { const vp = window.LocalCAD.vp; vp.render(); return vp.project(vp.camera.position.clone().set(x, y, z)); }, [x, y, z]);
const reset = (snap, src) => app(([snap, src]) => { localStorage.clear(); const a = window.LocalCAD; a.setTool(null); a.model.doc.nodes = []; a.model.settings.snap = snap; a.sel = []; a.commit(); (0, eval)(src)(a); a.setSelection([]); a.frame(); }, [snap, src.toString()]);
const box = (i) => app((i) => { const a = window.LocalCAD; const b = a.worldBox(a.model.nodes[i]); const c = b.getCenter(b.min.clone()); return { c: c.toArray().map((v) => +v.toFixed(3)), minz: +b.min.z.toFixed(3) }; }, i);
const onGrid = (v, s) => Math.abs(v / s - Math.round(v / s)) < 1e-6;

// ---------------------------------------------------------------- new parts land on grid multiples
await reset(2, (a) => { a.addShape('box'); a.addShape('cylinder'); a.addShape('box'); });
await wait(300);
const placed = [await box(0), await box(1), await box(2)];
check('new parts are placed on the snap grid (snap 2)', placed.every((b) => onGrid(b.c[0], 2) && onGrid(b.c[1], 2)), JSON.stringify(placed.map((b) => b.c)));

// ---------------------------------------------------------------- dragging snaps the center to the grid
await reset(5, (a) => { a.addShape('box'); const n = a.model.nodes[0]; n.pos = [1.3, 2.7, 10]; a.commit(); });
await wait(300);
let p0 = await screen(1.3, 2.7, 20), p1 = await screen(17, 9, 20);
await page.mouse.move(cv.x + p0.x, cv.y + p0.y);
await page.mouse.down();
await page.mouse.move(cv.x + p1.x, cv.y + p1.y, { steps: 10 });
await page.mouse.up();
await wait(300);
let b = await box(0);
check('dragging an off-grid part lands its center on the grid (snap 5)', onGrid(b.c[0], 5) && onGrid(b.c[1], 5) && Math.abs(b.c[0] - 1.3) > 4, JSON.stringify(b));

// Alt-drag stays free
p0 = await screen(b.c[0], b.c[1], 20); p1 = await screen(b.c[0] + 3.3, b.c[1] - 6.1, 20);
await page.mouse.move(cv.x + p0.x, cv.y + p0.y);
await page.mouse.down();
await page.mouse.move(cv.x + p0.x + 6, cv.y + p0.y + 3, { steps: 2 });
await page.keyboard.down('Alt');
await page.mouse.move(cv.x + p1.x, cv.y + p1.y, { steps: 10 });
await page.mouse.up();
await page.keyboard.up('Alt');
await wait(300);
const bAlt = await box(0);
check('Alt-drag does not snap', !(onGrid(bAlt.c[0], 5) && onGrid(bAlt.c[1], 5)), JSON.stringify(bAlt));

// ---------------------------------------------------------------- dropping a shape onto a face
await reset(5, (a) => { a.addShape('box'); const n = a.model.nodes[0]; n.params.w = 60; n.params.d = 60; n.pos = [0, 0, 10]; a.commit(); });
await wait(300);
p0 = await screen(8.3, -11.2, 20);
await app(([x, y]) => {
	const dt = new DataTransfer(); dt.setData('text/lcad-shape', 'cylinder');
	document.querySelector('#viewport').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }));
}, [cv.x + p0.x, cv.y + p0.y]);
await wait(400);
b = await box(1);
check('shape dropped on a face sits on it, centered on a grid point', Math.abs(b.minz - 20) < 1e-3 && b.c[0] === 10 && b.c[1] === -10, JSON.stringify(b));

// ---------------------------------------------------------------- Place on face (P)
await reset(5, (a) => { a.addShape('box'); a.addShape('cylinder'); const [n, c] = a.model.nodes; n.params.w = 60; n.params.d = 60; n.pos = [0, 0, 10]; c.pos = [80, 0, 10]; a.commit(); });
await wait(300);
await app(() => { const a = window.LocalCAD; a.setSelection([a.model.nodes[1].id]); });
await page.keyboard.press('p');
p0 = await screen(-6.6, 13.1, 20);
await page.mouse.click(cv.x + p0.x, cv.y + p0.y);
await wait(400);
b = await box(1);
check('Place on face snaps the drop point to the grid', Math.abs(b.minz - 20) < 1e-3 && b.c[0] === -5 && b.c[1] === 15, JSON.stringify(b));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'browser18: all passed');
process.exit(fails ? 1 : 0);
