// Import image as a sketch: trace a PNG (shape with a hole), preview + controls, size in mm, extrude; drag & drop.
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
const info = () => app(() => document.querySelector('#it-info').textContent);
const modalBtn = (label) => app((label) => [...document.querySelectorAll('.modal .btn')].find((b) => b.textContent.trim() === label).click(), label);

// a 400 × 300 PNG: a black ring (outer R 100 px, inner r 50 px) with a black bar across the middle, on white
await app(async () => {
	localStorage.clear(); const a = window.DraftOtter; a.model.doc.nodes = []; a.commit();
	const c = document.createElement('canvas'); c.width = 400; c.height = 300;
	const g = c.getContext('2d');
	g.fillStyle = '#fff'; g.fillRect(0, 0, 400, 300);
	g.fillStyle = '#000'; g.beginPath(); g.arc(200, 150, 100, 0, Math.PI * 2); g.arc(200, 150, 50, 0, Math.PI * 2, true); g.fill('evenodd');
	g.fillRect(150, 140, 100, 20); // bar through the hole: makes two holes
	const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
	window.__png = new File([blob], 'ring logo.png', { type: 'image/png' });
	a.importImageFile(window.__png);
});
await page.waitForSelector('#it-info');
await wait(300);
let t = await info();
check('the image traces with a live preview: outer outline + two holes', /^3 outlines/.test(t), t);
await page.screenshot({ path: 'test/shots/400-image-trace.png' });
// invert: the light parts become the shape
await app(() => { const i = document.querySelector('#it-inv'); i.checked = true; i.dispatchEvent(new Event('change')); });
await wait(300);
t = await info();
check('Invert traces the light parts instead', /outline/.test(t) && !/^3 outlines/.test(t), t);
await app(() => { const i = document.querySelector('#it-inv'); i.checked = false; i.dispatchEvent(new Event('change')); });
await wait(300);
// smoothing up: fewer points
const pts = (s) => +(/(\d+) points/.exec(s) || [0, 0])[1];
const before = pts(await info());
await app(() => { const s = document.querySelector('#it-smooth'); s.value = 8; s.dispatchEvent(new Event('input')); });
await wait(300);
const after = pts(await info());
check('more smoothing → fewer points', after > 0 && after < before, `${before} → ${after}`);
// size 40 mm wide, 4 mm tall
await app(() => { const w = document.querySelector('#it-size'); w.value = '40'; w.dispatchEvent(new Event('change')); const h = document.querySelector('#it-h'); h.value = '4'; });
await wait(200);
t = await info();
check('size shown in mm (40 × 30 for a 4:3 image)', /40 × 30 mm/.test(t), t);
await modalBtn('Import');
await wait(500);
const r = await app(() => { const a = window.DraftOtter, n = a.model.nodes[0]; if (!n) return null; const b = a.worldBox(n); return { type: n.type, name: n.name, h: n.params.height, vol: a.engine.stats([n]).volume, size: [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z].map((v) => +v.toFixed(2)) }; });
// 400 px → 40 mm: 0.1 mm/px. Ring: π(10² − 5²) mm² plus the bar (10 × 2 mm) minus the part of the bar inside the ring
const ring = Math.PI * (100 - 25), bar = 10 * 2 - (10 - 10) * 2; // the bar spans the hole exactly (from −5 to +5 mm)
const want = (ring + bar) * 4;
check('imported as an editable sketch part, 20 mm across and 4 mm tall', r && r.type === 'sketch' && r.name === 'ring logo' && r.h === 4 && Math.abs(r.size[0] - 20) < 0.3 && Math.abs(r.size[2] - 4) < 1e-6, JSON.stringify(r));
check('…with the right volume (holes cut, within 2%)', r && Math.abs(r.vol - want) / want < 0.02, `${r && r.vol.toFixed(1)} vs ${want.toFixed(1)}`);
check('the menu has the command', await app(() => { const a = window.DraftOtter; let found = false; const orig = a.menu; a.menu = (anc, items) => { found = items.some((it) => it && /Import image/.test(it[0])); }; a.toolsMenu(document.body); a.menu = orig; return found; }));

// drag & drop an image onto the view opens the same dialog
await app(() => {
	const dt = new DataTransfer(); dt.items.add(window.__png);
	const vp = document.querySelector('#viewport'), r = vp.getBoundingClientRect();
	vp.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 200, clientY: r.top + 200 }));
});
// it first asks what the image should become
await page.waitForSelector('#drop-sketch', { timeout: 5000 }).catch(() => null);
await app(() => document.querySelector('#drop-sketch').click());
await page.waitForSelector('#it-info', { timeout: 5000 }).catch(() => null);
check('dropping an image onto the view opens the import', await app(() => !!document.querySelector('#it-info')));
await modalBtn('Cancel');

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'browser50: all passed');
process.exit(fails ? 1 : 0);
