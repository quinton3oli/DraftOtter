// Feature timeline (order, suppress, rollback + insert), 2D drawing (views, hidden lines, dimensions, exports).
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
import { mkdirSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
mkdirSync('test/shots', { recursive: true });
const dl = resolve('test/downloads28');
rmSync(dl, { recursive: true, force: true });
mkdirSync(dl, { recursive: true });
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 180000, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1500, height: 900 } });
const page = await browser.newPage();
const cdp = await page.createCDPSession();
await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl });
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
const modalBtn = (label) => app((label) => [...document.querySelectorAll('.modal .btn')].find((b) => b.textContent.trim() === label).click(), label);
const waitFile = async (re) => { for (let i = 0; i < 60; i++) { const f = readdirSync(dl).find((n) => re.test(n) && !n.endsWith('.crdownload')); if (f) return f; await wait(100); } return null; };

// ---------------------------------------------------------------- timeline
await app(() => {
	localStorage.clear(); const a = window.LocalCAD; a.model.doc.nodes = []; a.model.doc.rollback = null; a.commit();
	a.addShape('box'); const b = a.model.nodes[0]; b.params.w = 40; b.params.d = 30; b.params.h = 10; b.pos = [0, 0, 5]; a.commit();
	a.addShape('cylinder'); const c = a.model.nodes[1]; c.params.r = 5; c.params.h = 30; c.pos = [-10, 0, 5]; c.hole = true; a.commit();
	a.setSelection([b.id, c.id]); a.group();
	a.addShape('sphere'); const s = a.model.nodes[1]; s.params.r = 6; s.pos = [12, 0, 16]; a.commit(); a.setSelection([]);
	a.setLeftTab('timeline');
});
await wait(300);
const vol = () => app(() => +window.LocalCAD.engine.stats(window.LocalCAD.model.nodes.filter((n) => n.visible)).volume.toFixed(1));
const rows = await app(() => [...document.querySelectorAll('#timeline .tl-row .tl-name')].map((r) => r.firstChild.textContent));
check('timeline lists every step in creation order', rows.join() === 'Box,Cylinder,Cut,Sphere', rows.join());
await shot('220-timeline');
const full = await vol();
// suppress the hole
await app(() => { const row = [...document.querySelectorAll('#timeline .tl-row')][1]; row.querySelector('input[type=checkbox]').click(); });
await wait(300);
const noHole = await vol();
check('suppressing the hole fills it back in', noHole > full + 700, `${full} → ${noHole}`);
check('suppressed step is struck through', await app(() => [...document.querySelectorAll('#timeline .tl-row')][1].classList.contains('suppressed')));
await app(() => { const row = [...document.querySelectorAll('#timeline .tl-row')][1]; row.querySelector('input[type=checkbox]').click(); });
await wait(200);
check('unsuppress restores it', Math.abs((await vol()) - full) < 0.5);
// roll back to after the group (before the sphere)
await app(() => { const row = [...document.querySelectorAll('#timeline .tl-row')][2]; row.querySelector('.tl-back').click(); });
await wait(300);
const rb = await app(() => ({ banner: !!document.querySelector('.tl-banner'), after: [...document.querySelectorAll('#timeline .tl-row')].map((r) => r.classList.contains('after')), marker: !!document.querySelector('.tl-marker') }));
check('rolling back greys out later steps and shows the marker', rb.banner && rb.marker && rb.after.join() === 'false,false,false,true', JSON.stringify(rb));
const rolled = await vol();
check('rolled-back sphere is not part of the design', Math.abs(rolled - (full - (4 / 3) * Math.PI * 216)) < 15, `${full} → ${rolled}`);
// insert a new step at the rollback point
await app(() => { const a = window.LocalCAD; a.addShape('cone'); a.setSelection([]); });
await wait(300);
const ins = await app(() => [...document.querySelectorAll('#timeline .tl-row')].map((r) => r.querySelector('.tl-name').firstChild.textContent + (r.classList.contains('after') ? '(off)' : '')));
check('a new step is inserted at the rollback point', ins.join() === 'Box,Cylinder,Cut,Cone,Sphere(off)', ins.join());
await app(() => [...document.querySelectorAll('.tl-banner .btn')][0].click());
await wait(300);
const end = await app(() => ({ rb: window.LocalCAD.model.doc.rollback, after: document.querySelectorAll('#timeline .tl-row.after').length }));
check('roll to end switches everything back on', end.rb === null && end.after === 0, JSON.stringify(end));
const und = await app(() => { const a = window.LocalCAD; a.undo(); return a.model.doc.rollback !== null; });
check('rollback is part of undo', und);
await app(() => { const a = window.LocalCAD; a.model.doc.rollback = null; a.commit(); a.setLeftTab('objects'); });

// ---------------------------------------------------------------- drawing
await app(() => {
	const a = window.LocalCAD; a.model.doc.nodes = []; a.commit();
	a.addShape('box'); a.addShape('cylinder'); a.addShape('cylinder');
	const [b, h, boss] = a.model.nodes; b.params.w = 60; b.params.d = 40; b.params.h = 8; b.pos = [0, 0, 4]; b.name = 'Plate';
	h.params.r = 4; h.params.h = 30; h.pos = [-15, 0, 4]; h.hole = true; boss.params.r = 8; boss.params.h = 12; boss.pos = [15, 0, 14];
	a.commit(); a.setSelection([b.id, h.id, boss.id]); a.group(); a.model.nodes[0].name = 'Bracket'; a.commit();
	a.drawingDialog();
});
await wait(1500);
const svg = await app(() => { const v = document.querySelector('.dw-preview svg'); return { lines: v.querySelectorAll('line').length, hidden: v.querySelectorAll('line[stroke-dasharray="1.6 0.9"]').length, texts: [...v.querySelectorAll('text')].map((t) => t.textContent) }; });
check('drawing has front / top / right / isometric views', ['FRONT', 'TOP', 'RIGHT', 'ISOMETRIC'].every((t) => svg.texts.includes(t)), svg.texts.join('|'));
check('overall dimensions 60 × 40 × 20', svg.texts.filter((t) => t === '60').length === 2 && svg.texts.includes('40') && svg.texts.filter((t) => t === '20').length === 2, svg.texts.join('|'));
check('hole diameters are called out', svg.texts.includes('Ø8') && svg.texts.includes('Ø16'), svg.texts.join('|'));
check('the hole shows as hidden (dashed) lines in the side views', svg.hidden >= 4, String(svg.hidden));
check('title block shows the part name and scale', svg.texts.includes('Bracket') && svg.texts.some((t) => /SCALE 1:1/.test(t)), svg.texts.join('|'));
await shot('221-drawing');
await modalBtn('SVG');
await modalBtn('DXF');
const fsvg = await waitFile(/_drawing\.svg$/), fdxf = await waitFile(/_drawing\.dxf$/);
check('drawing downloads as SVG and DXF', fsvg === 'Bracket_drawing.svg' && fdxf === 'Bracket_drawing.dxf', `${fsvg} ${fdxf}`);
if (fsvg) check('SVG sheet is Letter size in mm', /width="279.4mm" height="215.9mm"/.test(readFileSync(resolve(dl, fsvg), 'utf8')));
if (fdxf) { const d = readFileSync(resolve(dl, fdxf), 'utf8'); check('DXF has layered lines and text', /\nHIDDEN\n/.test(d) && /\nTEXT\n/.test(d) && /%%c8/.test(d)); }
await app(() => { const s = document.querySelector('.dw-opts select'); s.value = 'a3'; s.dispatchEvent(new Event('change')); });
await wait(300);
const a3 = await app(() => document.querySelector('.dw-preview svg').getAttribute('viewBox'));
check('changing the sheet re-lays the drawing', a3 === '0 0 420 297', a3);

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
rmSync(dl, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : 'browser28: all passed');
process.exit(fails ? 1 : 0);
