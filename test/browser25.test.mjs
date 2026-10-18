// DXF / SVG: import as a sketch part (with holes), export a sketch, export a part section.
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
import { mkdirSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
mkdirSync('test/shots', { recursive: true });
const dl = resolve('test/downloads25');
rmSync(dl, { recursive: true, force: true });
mkdirSync(dl, { recursive: true });
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 120000, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1500, height: 900 } });
const page = await browser.newPage();
const cdp = await page.createCDPSession();
await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl });
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
const reset = (src) => app((src) => { localStorage.clear(); const a = window.DraftOtter; a.setTool(null); a.model.doc.nodes = []; a.sel = []; a.commit(); (0, eval)(src)(a); a.frame(); }, src.toString());
const modalBtn = (label) => app((label) => [...document.querySelectorAll('.modal .btn')].find((b) => b.textContent.trim() === label).click(), label);
const waitFile = async (re) => { for (let i = 0; i < 50; i++) { const f = readdirSync(dl).find((n) => re.test(n) && !n.endsWith('.crdownload')); if (f) return f; await wait(100); } return null; };

// ---------------------------------------------------------------- import an SVG (plate 60×40 mm with two round holes and a slot)
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="60mm" height="40mm" viewBox="0 0 60 40">
<path d="M0 0 H60 V40 H0 Z M10 20 m-4 0 a4 4 0 1 0 8 0 a4 4 0 1 0 -8 0 Z"/>
<circle cx="50" cy="20" r="4"/>
<rect x="24" y="8" width="12" height="24" rx="3"/></svg>`;
await reset(() => {});
await app((svg) => window.DraftOtter.importVectorText('plate.svg', svg), svg);
await wait(100);
const info = await app(() => document.querySelector('.modal .muted').textContent);
check('import dialog shows the drawing size', /60 × 40 mm/.test(info), info);
await app(() => { document.querySelector('#vi-h').value = '4'; });
await modalBtn('Import');
await wait(500);
const n = await app(() => { const a = window.DraftOtter; const n = a.model.nodes[0]; const b = a.worldBox(n); return { type: n.type, name: n.name, vol: +a.engine.stats([n]).volume.toFixed(1), size: b.getSize(b.min.clone()).toArray().map((v) => +v.toFixed(2)) }; });
const want = (2400 - 2 * Math.PI * 16 - (12 * 24 - (4 - Math.PI) * 9)) * 4;
check('SVG becomes an extruded sketch with 3 holes (volume)', n.type === 'sketch' && n.name === 'plate' && Math.abs(n.vol - want) / want < 0.01 && n.size[0] === 60 && n.size[2] === 4, JSON.stringify(n) + ' expect ' + want.toFixed(1));
await app(() => { window.DraftOtter.setSelection([]); window.DraftOtter.frame(); });
await wait(300);
await shot('180-svg-import');

// ---------------------------------------------------------------- export the sketch as DXF and re-import it
await app(() => { const a = window.DraftOtter; a.exportSketchVector(a.model.nodes[0], 'dxf'); });
const fd = await waitFile(/\.dxf$/);
check('sketch DXF downloaded', fd === 'plate.dxf', String(fd));
if (fd) {
	const dxf = readFileSync(resolve(dl, fd), 'utf8');
	check('DXF has circles and polylines in mm', /\nCIRCLE\n/.test(dxf) && /\$INSUNITS\n70\n4/.test(dxf));
	await app((dxf) => window.DraftOtter.importVectorText('again.dxf', dxf), dxf);
	await modalBtn('Import');
	await wait(400);
	const v2 = await app(() => { const a = window.DraftOtter; const n = a.model.nodes[1]; n.params.height = 4; a.commit(); return +a.engine.stats([n]).volume.toFixed(1); });
	check('DXF round trip gives the same part', Math.abs(v2 - n.vol) / n.vol < 0.01, `${v2} vs ${n.vol}`);
}

// ---------------------------------------------------------------- section export of a part with a hole
await reset((a) => { a.addShape('box'); a.addShape('cylinder'); const [b, c] = a.model.nodes; b.params.w = 50; b.params.d = 30; b.params.h = 10; b.pos = [0, 0, 5]; c.params.r = 5; c.params.h = 20; c.pos = [0, 0, 5]; c.hole = true; a.commit(); a.setSelection([b.id, c.id]); a.group(); a.setSelection([]); });
await wait(300);
for (const f of readdirSync(dl)) rmSync(resolve(dl, f));
await app(() => window.DraftOtter.sectionExportDialog());
await wait(150);
const sec = await app(() => document.querySelector('.modal .form p:last-child').textContent);
check('section dialog finds 2 outlines (plate + hole)', /2 outlines/.test(sec), sec);
await app(() => { const r = document.querySelector('.modal input[value="svg"]'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); });
await modalBtn('Export');
const fs2 = await waitFile(/section.*\.svg$/);
check('section SVG downloaded', !!fs2, String(fs2));
if (fs2) {
	const s = readFileSync(resolve(dl, fs2), 'utf8');
	check('section SVG is 54 × 34 mm (part + 2 mm margins)', /width="54mm" height="34mm"/.test(s), s.slice(0, 200));
}

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
rmSync(dl, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : 'browser25: all passed');
process.exit(fails ? 1 : 0);
