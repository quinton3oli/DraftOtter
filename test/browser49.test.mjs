// Sketch editor: the selected point's line is highlighted in the Points box (and the box scrolls to it); clicking a
// line in the box selects that point.
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
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(ok ? 'ok  ' : 'FAIL', name, info); };
const ptPos = (i) => app((i) => { const d = document.querySelector('.modal-back').__sketch; const r = document.querySelector('.sk-canvas').getBoundingClientRect(); const [sx, sy] = d.toScr(d.st.points[i]); return [r.left + sx, r.top + sy]; }, i);
const marks = () => app(() => { const lines = document.querySelector('.sk-points').value.split('\n'); const hl = document.querySelector('.sk-points-hl'); const out = []; let li = 0; for (const node of hl.childNodes) { if (node.nodeName === 'MARK') out.push(li); li += (node.textContent.match(/\n/g) || []).length; } return out.map((l) => [l, lines[l]]); });
const selPts = () => app(() => [...document.querySelector('.modal-back').__sketch.st.sel.pts]);

await app(() => { localStorage.clear(); window.LocalCAD.newSketch(); });
await wait(400);
await app(() => { const ta = document.querySelector('.sk-points'); ta.value = '0, 0\n30, 0\n30, 20\n15, 30\n0, 20'; ta.dispatchEvent(new Event('input')); });
await wait(200);
check('nothing highlighted before anything is selected', (await marks()).length === 0);
// show all points, then switch from the Line tool (a new sketch starts with it) to Select
const fit = () => app(() => [...document.querySelectorAll('.sk-toolbar .btn')].find((b) => b.textContent.includes('Fit')).click());
await fit();
await page.keyboard.press('s');
await wait(100);

// click the third point in the drawing
let [x, y] = await ptPos(2);
await page.mouse.click(x, y);
await wait(150);
let m = await marks();
check('selecting a point highlights its line in the Points box', m.length === 1 && m[0][0] === 2 && m[0][1] === '30, 20', JSON.stringify({ m, sel: await selPts() }));
await page.screenshot({ path: 'test/shots/390-sketch-point-highlight.png' });
// shift-click another
[x, y] = await ptPos(4);
await page.keyboard.down('Shift'); await page.mouse.click(x, y); await page.keyboard.up('Shift');
await wait(150);
m = await marks();
check('several selected points: each line highlighted', m.map((r) => r[0]).join() === '2,4', JSON.stringify(m));
// clicking empty canvas clears it
const cv = await app(() => { const r = document.querySelector('.sk-canvas').getBoundingClientRect(); return [r.left + 20, r.bottom - 20]; });
await page.mouse.click(cv[0], cv[1]);
await wait(150);
check('clearing the selection clears the highlight', (await marks()).length === 0, JSON.stringify(await marks()));

// click a line in the box: that point gets selected in the drawing
await app(() => { const ta = document.querySelector('.sk-points'); const pos = ta.value.split('\n').slice(0, 3).join('\n').length + 2; ta.focus(); ta.setSelectionRange(pos, pos); ta.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
await wait(150);
check('clicking a line in the box selects that point', JSON.stringify(await selPts()) === '[3]' && (await marks())[0][0] === 3, JSON.stringify({ sel: await selPts(), m: await marks() }));

// many points: selecting one far down scrolls the box to it
await app(() => { document.querySelector('.sk-canvas').focus(); const ta = document.querySelector('.sk-points'); ta.blur(); const pts = []; for (let i = 0; i < 60; i++) { const a = (i / 60) * Math.PI * 2; pts.push(`${(20 * Math.cos(a)).toFixed(2)}, ${(20 * Math.sin(a)).toFixed(2)}`); } ta.value = pts.join('\n'); ta.dispatchEvent(new Event('input')); });
await wait(200);
await fit();
await wait(100);
[x, y] = await ptPos(50);
await page.mouse.click(x, y);
await wait(200);
const scroll = await app(() => { const ta = document.querySelector('.sk-points'), hl = document.querySelector('.sk-points-hl'); return { ta: ta.scrollTop, hl: hl.scrollTop, max: ta.scrollHeight - ta.clientHeight }; });
m = await marks();
check('a point far down the list: the box scrolls to its highlighted line', m.length === 1 && m[0][0] === 50 && scroll.ta > 0 && Math.abs(scroll.ta - scroll.hl) < 1, JSON.stringify({ m, scroll }));

await app(() => [...document.querySelectorAll('.sk-actions button')].find((b) => b.textContent.trim() === 'Cancel').click());
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'browser49: all passed');
process.exit(fails ? 1 : 0);
