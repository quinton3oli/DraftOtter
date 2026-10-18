// Space evenly: equal gaps / center-to-center, fit between the outer objects or an exact distance, any axis.
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
const near = (a, b) => Math.abs(a - b) < 1e-3;

// four parts of different widths, unevenly placed along X (slightly off in Y too)
const setup = () => app(() => {
	localStorage.clear(); const a = window.DraftOtter; a.setTool(null); a.model.doc.nodes = []; a.commit();
	const specs = [[10, -40], [20, -13], [6, 8], [14, 45]];
	for (const [w, x] of specs) { a.addShape('box'); const n = a.model.nodes[a.model.nodes.length - 1]; n.params.w = w; n.params.d = 10; n.params.h = 10; n.pos = [x, (x % 7), 5]; }
	a.commit(); a.setSelection(a.model.nodes.map((n) => n.id)); a.frame();
});
const spans = () => app(() => window.DraftOtter.model.nodes.map((n) => { const b = window.DraftOtter.worldBox(n); return [b.min.x, b.max.x, b.min.y]; }).sort((p, q) => p[0] - q[0]));
const gaps = (s) => s.slice(1).map((b, i) => b[0] - s[i][1]);
const centers = (s) => s.map((b) => (b[0] + b[1]) / 2);
const openDialog = async () => { await page.keyboard.down('Shift'); await page.keyboard.press('l'); await page.keyboard.up('Shift'); await wait(200); };
const pick = (name, value) => app(([name, value]) => { const i = document.querySelector(`.modal input[name="${name}"][value="${value}"]`); i.checked = true; i.dispatchEvent(new Event('change', { bubbles: true })); }, [name, value]);
const apply = () => app(() => [...document.querySelectorAll('.modal .btn')].find((b) => b.textContent === 'Apply').click());

// ---------------------------------------------------------------- fit: equal gaps (Shift+L, defaults)
await setup();
await wait(300);
let s0 = await spans();
await openDialog();
const dlg = await app(() => ({ open: !!document.querySelector('.modal'), axis: document.querySelector('.modal input[name="sp-axis"]:checked').value, how: document.querySelector('.modal input[name="sp-how"]:checked').value }));
check('Shift+L opens Space evenly, picking the spread-out axis (X) and "fit"', dlg.open && dlg.axis === 'x' && dlg.how === 'fit', JSON.stringify(dlg));
await shot('160-space-dialog');
await apply();
await wait(300);
let s = await spans(), g = gaps(s);
check('fit: all gaps equal', g.every((x) => near(x, g[0])), JSON.stringify(g));
check('fit: outer objects stay put, Y untouched', near(s[0][0], s0[0][0]) && near(s[3][1], s0[3][1]) && s.every((b, i) => near(b[2], s0[i][2])), JSON.stringify({ s0, s }));
await app(() => { const a = window.DraftOtter; a.setSelection([]); a.frame(); });
await wait(300);
await shot('161-space-result');

// ---------------------------------------------------------------- fit: equal center-to-center
await setup();
await wait(200);
await openDialog();
await pick('sp-by', 'center');
await apply();
await wait(300);
s = await spans();
let c = centers(s), p = c.slice(1).map((x, i) => x - c[i]);
check('fit: equal center-to-center pitch', p.every((x) => near(x, p[0])), JSON.stringify(p));

// ---------------------------------------------------------------- exact gap of 5 mm
await setup();
await wait(200);
s0 = await spans();
await openDialog();
const remembered = await app(() => document.querySelector('.modal input[name="sp-by"]:checked').value);
check('dialog remembers the last choice (center-to-center)', remembered === 'center', remembered);
await pick('sp-by', 'gap');
await pick('sp-how', 'set');
await app(() => { const i = document.querySelector('#sp-val'); i.value = '2.5*2'; i.dispatchEvent(new Event('input')); });
await apply();
await wait(300);
s = await spans(); g = gaps(s);
check('exact gap (expression 2.5*2 = 5 mm), first object stays', g.every((x) => near(x, 5)) && near(s[0][0], s0[0][0]), JSON.stringify(g));

// ---------------------------------------------------------------- exact pitch with only two objects, along Y
await app(() => {
	const a = window.DraftOtter; a.model.doc.nodes = []; a.commit();
	a.addShape('cylinder'); a.addShape('cylinder'); const [p, q] = a.model.nodes; p.pos = [0, -20, 10]; q.pos = [3, 17, 10]; a.commit(); a.setSelection([p.id, q.id]);
});
await wait(200);
await openDialog();
const two = await app(() => ({ axis: document.querySelector('.modal input[name="sp-axis"]:checked').value, fitDisabled: document.querySelector('.modal input[value="fit"]').disabled, how: document.querySelector('.modal input[name="sp-how"]:checked').value }));
check('two objects: fit is disabled, exact distance chosen, axis Y', two.fitDisabled && two.how === 'set' && two.axis === 'y', JSON.stringify(two));
await pick('sp-by', 'center');
await app(() => { const i = document.querySelector('#sp-val'); i.value = '30'; });
await apply();
await wait(300);
const ys = await app(() => window.DraftOtter.model.nodes.map((n) => n.pos[1]).sort((a, b) => a - b));
check('two objects placed 30 mm center-to-center along Y', near(ys[1] - ys[0], 30) && near(ys[0], -20), JSON.stringify(ys));

// ---------------------------------------------------------------- undo restores, entry points exist
const undone = await app(() => { const a = window.DraftOtter; a.undo(); return a.model.nodes.map((n) => n.pos[1]).sort((x, y) => x - y); });
check('undo restores the previous spacing', near(undone[1], 17), JSON.stringify(undone));
const entries = await app(() => ({ tb: !![...document.querySelectorAll('#toolbar .tb')].find((b) => /Space evenly/.test(b.title)), props: !![...document.querySelectorAll('#props button')].find((b) => b.textContent === 'Space evenly…') }));
check('toolbar button and Properties button exist', entries.tb && entries.props, JSON.stringify(entries));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'browser23: all passed');
process.exit(fails ? 1 : 0);
