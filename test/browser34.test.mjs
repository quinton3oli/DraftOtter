// Drawings: section A–A with hatching, detail views, click-to-dimension (snapping), saved with the design.
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';
mkdirSync('test/shots', { recursive: true });
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 240000, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1500, height: 950 } });
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
const texts = () => app(() => [...document.querySelectorAll('.dw-preview svg text')].map((t) => t.textContent));
// click a model point (view coordinates) on the sheet preview
const clickView = async (view, x, y) => {
	const p = await app(([view, x, y]) => {
		const dw = window.LocalCAD.drawingState.dw, b = dw.boxes[view];
		const sx = b.px + (x - b.box[0]) * b.s, sy = dw.h - (b.py + (y - b.box[1]) * b.s);
		const svg = document.querySelector('.dw-preview svg'), pt = svg.createSVGPoint(); pt.x = sx; pt.y = sy;
		const q = pt.matrixTransform(svg.getScreenCTM());
		return [q.x, q.y];
	}, [view, x, y]);
	await page.mouse.click(p[0], p[1]);
	await wait(250);
};

// a plate 60 × 40 × 8 with a Ø8 hole and a Ø16 × 12 boss
await app(() => {
	localStorage.clear(); const a = window.LocalCAD; a.model.doc.nodes = []; a.model.doc.drawing = null; a.commit();
	a.addShape('box'); a.addShape('cylinder'); a.addShape('cylinder');
	const [b, h, boss] = a.model.nodes; b.params.w = 60; b.params.d = 40; b.params.h = 8; b.pos = [0, 0, 4];
	h.params.r = 4; h.params.h = 30; h.pos = [-15, 0, 4]; h.hole = true; boss.params.r = 8; boss.params.h = 12; boss.pos = [15, 0, 14];
	a.commit(); a.setSelection([b.id, h.id, boss.id]); a.group(); a.model.nodes[0].name = 'Bracket'; a.commit(); a.setSelection([]);
	a.drawingDialog();
});
await wait(1500);
await app(() => { const cb = [...document.querySelectorAll('.dw-opts label')].find((l) => /Section/.test(l.textContent)).querySelector('input'); cb.checked = true; cb.dispatchEvent(new Event('change')); });
await wait(1500);
let t = await texts();
const sec = await app(() => { const v = window.LocalCAD.drawingState.views.section; return { lines: v && v.lines.length, hatch: v && v.hatch.length, cut: v && v.cut }; });
check('section A–A view with its label and the cut line on the top view', t.includes('SECTION A–A') && t.filter((x) => x === 'A').length === 2 && sec.lines > 4 && sec.cut === 0, JSON.stringify(sec));
check('the cut faces are hatched (plate and boss with the hole open)', sec.hatch >= 2, JSON.stringify(sec));

// detail view on the front view, around the hole
await app(() => [...document.querySelectorAll('.dw-opts .btn')].find((b) => /Detail/.test(b.textContent)).click());
await clickView('front', -15, 4);
t = await texts();
check('a detail view appears with its letter and scale', t.some((x) => /^DETAIL B \(/.test(x)) && t.includes('B'), t.filter((x) => /DETAIL|^B$/.test(x)).join('|'));

// click-to-dimension: boss height on the front view (snaps to corners)
await app(() => [...document.querySelectorAll('.dw-opts .btn')].find((b) => /Dimension/.test(b.textContent)).click());
await clickView('front', 7.3, 8.2); // near the boss's left foot (7, 8)
await clickView('front', 7.2, 19.7); // near its top-left corner (7, 20)
t = await texts();
check('two clicks add a snapped dimension (boss height 12)', t.includes('12'), t.filter((x) => /^\d/.test(x)).join('|'));
const dims = await app(() => window.LocalCAD.model.doc.drawing.dims.length);
check('dimensions are saved with the design', dims === 1);
await shot('290-drawing-section-detail-dims');

// remove the dimension by clicking it (leave dimension mode first)
await app(() => [...document.querySelectorAll('.dw-opts .btn')].find((b) => /Dimension/.test(b.textContent)).click());
await app(() => document.querySelector('.dw-preview [data-dim]').dispatchEvent(new MouseEvent('click', { bubbles: true })));
await wait(300);
check('clicking a dimension removes it', await app(() => window.LocalCAD.model.doc.drawing.dims.length === 0 && !document.querySelector('.dw-preview [data-dim]')));
// reopen: section + detail are remembered
await app(() => { document.querySelector('.modal .icon-btn').click(); window.LocalCAD.drawingDialog(); });
await wait(2500);
t = await texts();
check('reopening keeps the section and the detail', t.includes('SECTION A–A') && t.some((x) => /^DETAIL B/.test(x)), '');

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'browser34: all passed');
process.exit(fails ? 1 : 0);
