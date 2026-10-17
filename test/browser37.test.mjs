// Fit on several holes at once (multi-selection), mixed values, directions, and the progress bar for slow rebuilds.
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
const fitSelect = () => app(() => { const s = [...document.querySelectorAll('#props select')].find((x) => [...x.options].some((o) => o.value === 'sliding')); return s ? { value: s.value, label: s.closest('.sec').querySelector('.sec-title').textContent } : null; });
const pickFit = (v) => app((v) => { const s = [...document.querySelectorAll('#props select')].find((x) => [...x.options].some((o) => o.value === 'sliding')); s.value = v; s.dispatchEvent(new Event('change')); }, v);
const axisBoxes = () => app(() => { const f = [...document.querySelectorAll('#props .field')].find((x) => /Grow in/.test(x.textContent)); return f ? [...f.querySelectorAll('input')].map((i) => (i.indeterminate ? 'mixed' : i.checked)) : null; });
// watch for the progress bar appearing
await app(() => { window.__pbar = 0; new MutationObserver(() => { if (document.querySelector('.pbar')) window.__pbar++; }).observe(document.body, { childList: true }); });

// a plate with three round holes and one box hole, plus a solid
await app(() => {
	localStorage.clear(); const a = window.LocalCAD; a.model.doc.nodes = []; a.commit();
	a.addShape('box'); const p = a.model.nodes[0]; p.params.w = 80; p.params.d = 30; p.params.h = 6; p.pos = [0, 0, 3];
	for (let i = 0; i < 3; i++) { a.addShape('cylinder'); const c = a.model.nodes[i + 1]; c.params.r = 3; c.params.h = 20; c.pos = [-30 + i * 20, 0, 3]; c.hole = true; }
	a.addShape('box'); const b = a.model.nodes[4]; b.params.w = 6; b.params.d = 6; b.params.h = 20; b.pos = [30, 0, 3]; b.hole = true;
	a.model.nodes[1].fit = 'press';
	a.commit(); a.setSelection(a.model.nodes.map((n) => n.id));
});
await wait(300);
let fs = await fitSelect();
check('multi-selection shows Fit for the holes in it', !!fs && /4 holes/.test(fs.label), JSON.stringify(fs));
check('differing fits show as Mixed', fs && fs.value === '__mixed', JSON.stringify(fs));
await pickFit('sliding');
await wait(400);
const fits = await app(() => window.LocalCAD.model.nodes.map((n) => n.fit || ''));
check('one change sets the fit on every selected hole, not the solid', fits.join() === ',sliding,sliding,sliding,sliding', fits.join());
fs = await fitSelect();
check('…and now reads Sliding', fs.value === 'sliding');
const note = await app(() => document.querySelector('#props').textContent);
check('shared note when all match', /Printed 0\.3 mm larger across/.test(note));
check('undo takes back the whole change in one step', await app(() => { const a = window.LocalCAD; a.undo(); const r = a.model.nodes.map((n) => n.fit || '').join(); a.redo(); return r; }) === ',press,,,');
// directions for all of them
await app(() => { const a = window.LocalCAD; a.setSelection(a.model.nodes.map((n) => n.id)); });
await wait(200);
check('axes start as X+Y for round and box holes', JSON.stringify(await axisBoxes()) === '[true,true,false]', JSON.stringify(await axisBoxes()));
await app(() => { const f = [...document.querySelectorAll('#props .field')].find((x) => /Grow in/.test(x.textContent)); const z = f.querySelectorAll('input')[2]; z.checked = true; z.dispatchEvent(new Event('change')); });
await wait(400);
const axes = await app(() => window.LocalCAD.model.nodes.slice(1).map((n) => n.fitAxes));
check('ticking Z adds it on every hole', axes.every((x) => x === 'xyz'), axes.join());
// one hole on Z only: the X box then shows as mixed
await app(() => { const a = window.LocalCAD; a.model.nodes[1].fitAxes = 'z'; a.commit(); a.setSelection(a.model.nodes.map((n) => n.id)); });
await wait(300);
check('a direction that differs between holes shows as mixed', JSON.stringify(await axisBoxes()) === '["mixed","mixed",true]', JSON.stringify(await axisBoxes()));
const z0 = await app(() => { const f = [...document.querySelectorAll('#props .field')].find((x) => /Grow in/.test(x.textContent)); const z = f.querySelectorAll('input')[2]; z.checked = false; z.dispatchEvent(new Event('change')); return window.LocalCAD.model.nodes[1].fitAxes; });
check('cannot untick a direction a hole has as its only one', z0 === 'z', z0);
check('no progress bar for quick changes on a few simple holes', await app(() => window.__pbar) === 0);

// slow work: several custom-shaped (group) holes — a progress bar shows while they are rebuilt
await app(() => {
	const a = window.LocalCAD; a.model.doc.nodes = []; a.commit();
	a.addShape('box'); const p = a.model.nodes[0]; p.params.w = 120; p.params.d = 40; p.params.h = 8; p.pos = [0, 0, 4];
	const ids = [];
	for (let i = 0; i < 4; i++) {
		a.addShape('box'); a.addShape('sphere');
		const [b, s] = a.model.nodes.slice(-2); b.params.w = 10; b.params.d = 4; b.params.h = 20; b.pos = [-45 + i * 30, 0, 4]; s.params.r = 4; s.pos = [-45 + i * 30, 0, 8];
		a.commit(); a.setSelection([b.id, s.id]); a.group(); const g = a.model.nodes[a.model.nodes.length - 1]; g.hole = true; g.name = 'Cutter ' + (i + 1); ids.push(g.id);
	}
	a.commit(); a.setSelection([p.id, ...ids]); a.group(); const part = a.model.nodes[0]; a.setSelection(part.children.filter((c) => c.hole).map((c) => c.id));
	window.__pbar = 0; window.__pbarText = [];
	new MutationObserver(() => { const t = document.querySelector('.pbar-text'); if (t) window.__pbarText.push(t.textContent); }).observe(document.body, { childList: true, subtree: true, characterData: true });
});
await wait(300);
const vol0 = await app(() => window.LocalCAD.engine.stats([window.LocalCAD.model.nodes[0]]).volume);
const start = Date.now();
await pickFit('loose');
await wait(50);
const during = await app(() => !!document.querySelector('.pbar'));
await shot('312-fit-progress');
await page.waitForFunction(() => !document.querySelector('.pbar'), { timeout: 120000 });
await wait(200);
const texts = await app(() => [...new Set(window.__pbarText)]);
check('a progress bar shows while the custom holes are grown', during && (await app(() => window.__pbar)) > 0, JSON.stringify({ during }));
// holes are grown in parallel, so they finish in any order
check('…counting through each hole', texts.some((t) => /Cutter \d.*\(1 \/ /.test(t)) && [1, 2, 3, 4].every((k) => texts.some((t) => t.includes('Cutter ' + k))), texts.slice(0, 6).join(' | '));
check('…and it goes away when done', await app(() => !document.querySelector('.pbar')), `${Date.now() - start} ms`);
const res = await app(() => { const a = window.LocalCAD; return { fits: a.model.nodes[0].children.filter((c) => c.hole).map((c) => c.fit), vol: a.engine.stats([a.model.nodes[0]]).volume }; });
check('all four group holes got the loose fit and cut more material', res.fits.every((f) => f === 'loose') && res.vol < vol0 - 20, JSON.stringify({ ...res, vol0 }));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'browser37: all passed');
process.exit(fails ? 1 : 0);
