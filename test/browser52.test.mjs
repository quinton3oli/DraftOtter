// Sketch revolve axis: set its X position by typing or by dragging the axis line; the solid revolves around it and
// stays where the profile was drawn.
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
const field = (label) => app((label) => { const f = [...document.querySelectorAll('.sk-field')].find((x) => x.textContent.includes(label)); return f ? { shown: f.style.display !== 'none', value: f.querySelector('input').value } : null; }, label);
const setField = (label, v) => app(([label, v]) => { const i = [...document.querySelectorAll('.sk-field')].find((x) => x.textContent.includes(label)).querySelector('input'); i.value = v; i.dispatchEvent(new Event('change')); }, [label, v]);
const editorBtn = (label) => app((label) => [...document.querySelectorAll('.sk-actions button')].find((b) => b.textContent.trim() === label).click(), label);
const scr = (x, y) => app(([x, y]) => { const d = document.querySelector('.modal-back').__sketch; const r = document.querySelector('.sk-canvas').getBoundingClientRect(); const [sx, sy] = d.toScr([x, y]); return [r.left + sx, r.top + sy]; }, [x, y]);
const part = () => app(() => { const a = window.DraftOtter, n = a.model.nodes[0], g = a.engine.geometry(n); g.computeBoundingBox(); return { axisX: n.params.axisX, mode: n.params.mode, vol: a.engine.stats([n]).volume, min: g.boundingBox.min.x, max: g.boundingBox.max.x }; });
const k = 64 / (2 * Math.PI) * Math.sin(2 * Math.PI / 64); // a 64-sided revolve has this much of a true circle's area

// a 4 × 10 rectangle from x = 10 to 14
await app(() => { localStorage.clear(); const a = window.DraftOtter; a.model.doc.nodes = []; a.commit(); a.newSketch(); });
await wait(400);
await app(() => { const ta = document.querySelector('.sk-points'); ta.value = '10, 0\n14, 0\n14, 10\n10, 10'; ta.dispatchEvent(new Event('input')); });
await app(() => { const s = [...document.querySelectorAll('.sk-panel select, .modal select')].find((x) => [...x.options].some((o) => o.value === 'revolve')); s.value = 'revolve'; s.dispatchEvent(new Event('change')); });
await app(() => [...document.querySelectorAll('.sk-toolbar .btn')].find((b) => b.textContent.includes('Fit')).click());
await page.keyboard.press('s');
await wait(150);
let f = await field('Revolve axis at X');
check('revolve mode shows the axis position (0 to start)', f && f.shown && f.value === '0', JSON.stringify(f));
check('extrude mode hides it', await app(() => { const s = [...document.querySelectorAll('.modal select')].find((x) => [...x.options].some((o) => o.value === 'revolve')); s.value = 'extrude'; s.dispatchEvent(new Event('change')); const hidden = [...document.querySelectorAll('.sk-field')].find((x) => x.textContent.includes('Revolve axis at X')).style.display === 'none'; s.value = 'revolve'; s.dispatchEvent(new Event('change')); return hidden; }));
// type the axis at x = 5: radii 5..9
await setField('Revolve axis at X', '5');
await wait(100);
await page.screenshot({ path: 'test/shots/420-revolve-axis.png' });
await editorBtn('Create');
await wait(400);
let r = await part();
const want5 = Math.PI * (81 - 25) * 10 * k;
check('revolves around x = 5 (a ring from radius 4 to 9 around it)', r.mode === 'revolve' && r.axisX === 5 && Math.abs(r.vol - want5) / want5 < 0.01, JSON.stringify({ r, want5 }));
check('…centered on the axis where it was drawn (x from −4 to 14)', Math.abs(r.min + 4) < 0.05 && Math.abs(r.max - 14) < 0.05, JSON.stringify(r));

// reopen and drag the axis line from x = 5 back to x = 0
await app(() => { const a = window.DraftOtter; a.editSketch(a.model.nodes[0]); });
await wait(400);
await page.keyboard.press('s');
f = await field('Revolve axis at X');
check('reopening shows the axis where it was', f && f.value === '5', JSON.stringify(f));
const [x0, y0] = await scr(5, 5), [x1] = await scr(0, 5);
await page.mouse.move(x0, y0, { steps: 2 });
await wait(80);
check('hovering the axis line shows a left–right cursor', await app(() => document.querySelector('.sk-canvas').style.cursor === 'ew-resize'));
await page.mouse.down(); await page.mouse.move(x1 + 2, y0, { steps: 8 }); await page.mouse.up();
await wait(150);
f = await field('Revolve axis at X');
check('dragging the axis line moves it (snapped to the grid)', f && f.value === '0', JSON.stringify(f));
await editorBtn('Apply');
await wait(400);
r = await part();
const want0 = Math.PI * (196 - 100) * 10 * k;
check('…and the solid revolves around the new axis (radius 10 to 14)', r.axisX === 0 && Math.abs(r.vol - want0) / want0 < 0.01 && Math.abs(r.min + 14) < 0.05, JSON.stringify({ r, want0 }));
check('undo goes back to the axis at 5', await app(() => { const a = window.DraftOtter; a.undo(); const v = a.model.nodes[0].params.axisX; a.redo(); return v; }) === 5);

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'browser52: all passed');
process.exit(fails ? 1 : 0);
