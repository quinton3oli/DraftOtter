// Sketch tools: slot, spline, trim, extend, offset, face edges.
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
const near = (a, b, e) => Math.abs(a - b) <= e;
const dlgPos = (x, y) => app(([x, y]) => { const d = document.querySelector('.modal-back').__sketch; const r = document.querySelector('.sk-canvas').getBoundingClientRect(); const [sx, sy] = d.toScr([x, y]); return [r.left + sx, r.top + sy]; }, [x, y]);
const clickAt = async (x, y) => { const p = await dlgPos(x, y); await page.mouse.move(p[0], p[1], { steps: 2 }); await page.mouse.click(p[0], p[1]); await wait(40); };
const tool = (label) => app((label) => [...document.querySelectorAll('.sk-toolbar .btn')].find((b) => b.textContent.includes(label)).click(), label);
const status = () => app(() => document.querySelector('.sk-status').textContent);
const regions = () => app(() => {
	const s = document.querySelector('.modal-back').__sketch.st;
	const area = (p) => { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[i], w = p[(i + 1) % p.length]; a += q[0] * w[1] - w[0] * q[1]; } return Math.abs(a / 2); };
	return window.__lcadTest.profileRegions({ v: 2, points: s.points, segs: s.segs, circles: s.circles, cons: s.cons, radii: s.radii }).map((r) => ({ a: +area(r.outer).toFixed(2), holes: r.holes.map((h) => +area(h).toFixed(2)) }));
});
const fresh = async () => {
	await app(() => { document.querySelectorAll('.modal-back').forEach((d) => d.remove()); window.LocalCAD.newSketch(); });
	await wait(300);
	await app(() => { const s = document.querySelector('.modal-back').__sketch.st; s.points.length = 0; s.segs.length = 0; s.circles.length = 0; s.cons.length = 0; });
};

// ---------------------------------------------------------------- slot
await fresh();
await tool('Slot');
await clickAt(-10, 0); await clickAt(10, 0); await clickAt(0, 4);
let r = await regions();
check('slot tool: two centers + width → one stadium (R4)', r.length === 1 && near(r[0].a, 20 * 8 + Math.PI * 16, 0.6), JSON.stringify(r));
await shot('270-sketch-slot');

// ---------------------------------------------------------------- spline closed by a line
await fresh();
await tool('Spline');
await clickAt(-10, 0); await clickAt(-4, 8); await clickAt(4, 9); await clickAt(10, 0);
await page.keyboard.press('Enter');
await wait(60);
await tool('Line');
await clickAt(10, 0); await clickAt(-10, 0);
r = await regions();
const spl = await app(() => document.querySelector('.modal-back').__sketch.st.segs.filter((s) => s.spl).length);
check('spline + line close into a region', spl === 1 && r.length === 1 && r[0].a > 100, JSON.stringify({ spl, r }));
// drag a spline point in select mode
await tool('Select');
const p0 = await dlgPos(-4, 8), p1 = await dlgPos(-4, 12);
await page.mouse.move(p0[0], p0[1]); await page.mouse.down(); await page.mouse.move(p1[0], p1[1], { steps: 5 }); await page.mouse.up();
await wait(60);
const moved = await app(() => document.querySelector('.modal-back').__sketch.st.segs.find((s) => s.spl).spl[0]);
check('spline points can be dragged', near(moved[0], -4, 0.01) && near(moved[1], 12, 0.01), JSON.stringify(moved));
await shot('271-sketch-spline');

// ---------------------------------------------------------------- trim: rectangle + circle across its right edge
await fresh();
await tool('Rect');
await clickAt(-10, -5); await clickAt(10, 5);
await tool('Circle');
await clickAt(10, 0); await clickAt(13, 0);
await tool('Trim');
await clickAt(10, 1.5); // the edge inside the circle (the circle's center split the edge, so there are two pieces)
await clickAt(10, -1.5);
await clickAt(7, 0); // the arc inside the rectangle
r = await regions();
check('trim makes a rectangle with a round bump', r.length === 1 && near(r[0].a, 200 + Math.PI * 9 / 2, 0.6), JSON.stringify(r));
await shot('272-sketch-trim');

// ---------------------------------------------------------------- extend
await fresh();
await tool('Line');
await clickAt(-10, -6); await clickAt(-10, 6); await page.keyboard.press('Escape');
await clickAt(10, -6); await clickAt(10, 6); await page.keyboard.press('Escape');
await clickAt(-10, 6); await clickAt(10, 6); await page.keyboard.press('Escape');
await clickAt(-10, -6); await clickAt(4, -6); await page.keyboard.press('Escape');
check('a gap leaves the outline open', /open/.test(await status()), await status());
await tool('Extend');
await clickAt(3.5, -6);
r = await regions();
check('extend closes the gap to the side line', r.length === 1 && near(r[0].a, 240, 0.01), JSON.stringify(r) + ' ' + (await status()));

// ---------------------------------------------------------------- offset
await fresh();
await tool('Rect');
await clickAt(-10, -5); await clickAt(10, 5);
await app(() => { const st = document.querySelector('.modal-back').__sketch.st; st.sel.segs = new Set(st.segs.map((_, i) => i)); });
await app(() => { const i = document.querySelector('.sk-toolbar input[title^="Offset"]'); i.value = '2'; });
await tool('Offset');
r = await regions();
check('offset a rectangle by 2 → a 24 × 14 frame around it', r.length === 1 && near(r[0].a, 24 * 14, 1e-3) && r[0].holes.length === 1 && near(r[0].holes[0], 200, 1e-3), JSON.stringify(r));
await shot('273-sketch-offset');
await app(() => document.querySelectorAll('.modal-back').forEach((d) => d.remove()));

// ---------------------------------------------------------------- face edges: sketch on a face with a hole
await app(() => {
	const a = window.LocalCAD; a.model.doc.nodes = []; a.commit();
	a.addShape('box'); a.addShape('cylinder');
	const [b, c] = a.model.nodes; b.params.w = 30; b.params.d = 30; b.params.h = 10; b.pos = [0, 0, 5]; c.params.r = 5; c.params.h = 20; c.pos = [0, 0, 5]; c.hole = true; a.commit();
	a.setSelection([b.id, c.id]); a.group(); a.setSelection([]); a.vp.setView('top'); a.frame();
});
await wait(900);
const cv = await (await page.$('#viewport canvas')).boundingBox();
const sp = await app(() => { const vp = window.LocalCAD.vp; vp.render(); return vp.project(vp.camera.position.clone().set(10, 10, 10)); });
await app(() => window.LocalCAD.setTool('sketchface'));
await page.mouse.click(cv.x + sp.x, cv.y + sp.y);
await wait(600);
const hasBtn = await app(() => !![...document.querySelectorAll('.sk-toolbar .btn')].find((b) => /Face edges/.test(b.textContent)));
check('sketch on a face offers Face edges', hasBtn);
if (hasBtn) {
	await tool('Face edges');
	r = await regions();
	check('face edges become a square with a round hole', r.length === 1 && near(r[0].a, 900, 0.01) && r[0].holes.length === 1 && near(r[0].holes[0], Math.PI * 25, 0.5), JSON.stringify(r));
	const circles = await app(() => document.querySelector('.modal-back').__sketch.st.circles.length);
	check('the hole comes in as a true circle', circles === 1, String(circles));
}
await shot('274-sketch-face-edges');

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'browser32: all passed');
process.exit(fails ? 1 : 0);
