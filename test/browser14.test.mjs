// Fillet / chamfer tool (hover + click real edges, apply, edit size, concave edges, hole rims, round whole part)
// and STEP export through the UI, verified by reading the file back with OpenCascade.
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
import { mkdirSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const occt = await require('occt-import-js')();
mkdirSync('test/shots', { recursive: true });
const dl = path.resolve('test/downloads-step');
rmSync(dl, { recursive: true, force: true });
mkdirSync(dl, { recursive: true });
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 120000, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1500, height: 900 } });
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
const k = 1 - Math.PI / 4;
const cv = await (await page.$('#viewport canvas')).boundingBox();
const reset = (fn) => app((src) => { localStorage.clear(); const a = window.LocalCAD; a.setTool(null); a.model.doc.nodes = []; a.sel = []; a.commit(); (0, eval)(src)(a); a.setSelection([]); a.frame(); }, fn.toString());
const screen = (x, y, z) => app(([x, y, z]) => { const vp = window.LocalCAD.vp; vp.render(); return vp.project(vp.camera.position.clone().set(x, y, z)); }, [x, y, z]);
const vol = () => app(() => { const a = window.LocalCAD; return a.engine.stats([a.model.nodes[0]]).volume; });
const clickAt = async (x, y, z) => { const p = await screen(x, y, z); await page.mouse.move(cv.x + p.x, cv.y + p.y, { steps: 3 }); await wait(30); await page.mouse.click(cv.x + p.x, cv.y + p.y); await wait(60); };
const setBar = (kind, size) => app(([kind, size]) => { const b = document.querySelector('#fillet-bar'); const s = b.querySelector('select'); s.value = kind; s.dispatchEvent(new Event('change')); const i = b.querySelector('input.num'); i.value = size; i.dispatchEvent(new Event('change')); }, [kind, size]);
const applyBtn = () => app(() => [...document.querySelectorAll('#fillet-bar .btn')].find((b) => b.textContent === 'Apply').click());

// ---------------------------------------------------------------- fillet one box edge by clicking it
await reset((a) => { a.addShape('box'); });
await wait(500);
await page.keyboard.press('g');
let p = await screen(0, -10, 20); // middle of the top-front edge (box spans z 0..20)
await page.mouse.move(cv.x + p.x, cv.y + p.y, { steps: 4 });
await wait(80);
check('hovering an edge highlights it', await app(() => window.LocalCAD.vp.canvas.style.cursor === 'pointer' && window.LocalCAD.vp.filletTool.hoverPick && window.LocalCAD.vp.filletTool.hoverPick.ci >= 0));
await page.mouse.click(cv.x + p.x, cv.y + p.y);
await wait(80);
const barText = await app(() => document.querySelector('#fillet-bar').innerText.replace(/\n/g, ' '));
check('clicking selects the edge', barText.includes('1 edge on “Box”'), barText.slice(0, 60));
await setBar('fillet', '3');
await shot('90-fillet-select');
await applyBtn();
await wait(300);
let r = await app(() => { const a = window.LocalCAD; const g = a.model.nodes[0]; return { type: g.type, kids: g.children.map((c) => c.type + (c.hole ? '(hole)' : '')).join(','), vol: a.engine.stats([g]).volume }; });
check('fillet applied (non-destructive group)', r.type === 'group' && r.kids === 'box,edgeop(hole)' && Math.abs(r.vol - (8000 - 20 * 9 * k)) < 2, JSON.stringify(r));
// change the radius afterwards in Properties
await app(() => { const a = window.LocalCAD; const e = a.model.nodes[0].children[1]; a.setTool(null); a.setSelection([e.id]); });
await wait(100);
const sizeField = await page.$$eval('#props .field', (fs) => fs.map((f) => f.textContent));
check('fillet size is editable in Properties', sizeField.some((t) => t.includes('Size')), JSON.stringify(sizeField.slice(0, 3)));
await app(() => { const a = window.LocalCAD; const e = a.model.nodes[0].children[1]; e.params.size = 2; a.commit(); });
r = await vol();
check('changing the radius rebuilds the fillet', Math.abs(r - (8000 - 20 * 4 * k)) < 1, r.toFixed(2));
// add a chamfer to another edge of the same part -> goes into the same fillet group
await app(() => { const a = window.LocalCAD; a.setSelection([]); a.setTool('fillet'); });
await clickAt(10, 0, 20); // top-right edge
await setBar('chamfer', '2');
await applyBtn();
await wait(300);
r = await app(() => { const a = window.LocalCAD; return { n: a.model.nodes.length, kids: a.model.nodes[0].children.length, vol: a.engine.stats([a.model.nodes[0]]).volume }; });
check('second operation joins the same fillet group', r.n === 1 && r.kids === 3 && r.vol < 8000 - 20 * 4 * k - 30, JSON.stringify(r));
await app(() => { const a = window.LocalCAD; a.setTool(null); a.frame(); });
await wait(500);
await shot('91-fillet-chamfer');
await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
check('undo removes the chamfer', await app(() => window.LocalCAD.model.nodes[0].children.length === 2));

// ---------------------------------------------------------------- concave edge + all edges on an L-bracket
await reset((a) => { a.addShape('lbracket'); const n = a.model.nodes[0]; n.params.fillet = 0; n.params.holes = 0; a.commit(); });
await wait(500);
const v0 = await vol();
await app(() => window.LocalCAD.setTool('fillet'));
await app(() => { const a = window.LocalCAD, ft = a.vp.filletTool; ft.target = a.model.nodes[0].id; ft.selected.clear(); ft.selectAll(); });
await setBar('fillet', '1');
const nAll = await app(() => window.LocalCAD.vp.filletTool.selected.size);
await shot('92-all-edges');
await applyBtn();
await wait(800);
r = await app(() => { const a = window.LocalCAD; const g = a.model.nodes[0]; return { kids: g.children.map((c) => c.type + (c.hole ? '(hole)' : '')).join(','), vol: a.engine.stats([g]).volume, err: a.engine.errors.size }; });
check('fillet every edge of an L-bracket (inside edge adds, outside edges cut)', nAll >= 15 && r.kids === 'lbracket,edgeop(hole),edgeop' && r.err === 0 && r.vol < v0, `${nAll} edges, ${JSON.stringify(r)}`);
await app(() => { const a = window.LocalCAD; a.setTool(null); a.setSelection([]); a.frame(); });
await wait(500);
await shot('93-bracket-filleted');

// ---------------------------------------------------------------- chamfer a drilled hole rim (curved edge after a boolean)
await reset((a) => {
	a.addShape('box'); a.addShape('cylinder');
	const [b, c] = a.model.nodes; b.params.w = 40; b.params.d = 40; b.params.h = 10; b.pos = [0, 0, 5]; c.params.r = 6; c.params.h = 20; c.params.seg = 96; c.pos = [0, 0, 5]; c.hole = true; a.commit();
	a.setSelection([b.id, c.id]); a.group();
});
await wait(500);
const pv0 = await vol();
await app(() => window.LocalCAD.setTool('fillet'));
await clickAt(0, -6, 10);
await setBar('chamfer', '1');
await applyBtn();
await wait(400);
r = await vol();
const expectCs = 0.5 * 2 * Math.PI * (6 + 1 / 3);
check('countersink-style chamfer on the hole rim', Math.abs(pv0 - r - expectCs) < 0.6, `${(pv0 - r).toFixed(2)} vs ${expectCs.toFixed(2)}`);
await app(() => { const a = window.LocalCAD; a.setTool(null); a.setSelection([]); a.vp.setView('top'); });
await wait(400);
await app(() => window.LocalCAD.frame());
await wait(500);
await shot('94-hole-chamfer');
await app(() => window.LocalCAD.vp.setView('iso'));

// ---------------------------------------------------------------- round whole part
await reset((a) => { a.addShape('box'); });
await wait(300);
await app(() => { const a = window.LocalCAD; a.setSelection([a.model.nodes[0].id]); a.setTool('fillet'); a.roundAllDialog(); });
await wait(100);
await app(() => { document.querySelector('#ra-r').value = '3'; [...document.querySelectorAll('.modal-foot .btn')].find((b) => b.textContent === 'Round').click(); });
await wait(1500);
r = await app(() => { const a = window.LocalCAD; const g = a.model.nodes[0]; const b = a.worldBox(g); return { size: +(b.max.x - b.min.x).toFixed(2), vol: a.engine.stats([g]).volume, name: g.name }; });
// exact rounded cube (r = 3): 14³ + 6·14²·3 + 3·14·π·9 + 4/3·π·27 = 7572.6; the faceted rounding sphere lands slightly under
check('round whole part keeps size, rounds every edge and corner', Math.abs(r.size - 20) < 0.05 && Math.abs(r.vol - 7572.6) / 7572.6 < 0.01, JSON.stringify(r));

// ---------------------------------------------------------------- STEP export from the UI
await reset((a) => {
	a.addShape('box'); a.addShape('cylinder');
	const [b, c] = a.model.nodes; c.params.r = 4; c.params.h = 30; c.pos = b.pos.slice(); c.hole = true; a.commit();
	a.setSelection([b.id, c.id]); a.group();
	a.model.doc.name = 'Step test'; a.commit();
});
await wait(300);
await app(() => window.LocalCAD.fileMenu(document.querySelector('#toolbar .tb')));
await app(() => [...document.querySelectorAll('.menu button')].find((b) => b.textContent.startsWith('Export STEP')).click());
await wait(150);
check('export dialog opens with STEP selected', await app(() => document.querySelector('#ex-format').value === 'step'));
await shot('95-export-step');
await app(() => [...document.querySelectorAll('.modal-foot .btn')].find((b) => b.textContent === 'Export').click());
await wait(1500);
const files = readdirSync(dl);
check('STEP file downloaded', files.includes('Step test.step'), JSON.stringify(files));
if (files.includes('Step test.step')) {
	const buf = readFileSync(path.join(dl, 'Step test.step'));
	const res = occt.ReadStepFile(new Uint8Array(buf), null);
	let v = 0;
	if (res.success) for (const m of res.meshes) { const P = m.attributes.position.array, I = m.index.array; for (let i = 0; i < I.length; i += 3) { const a = I[i] * 3, b = I[i + 1] * 3, c = I[i + 2] * 3; v += (P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c])) / 6; } }
	const faces = res.success ? res.meshes.reduce((s, m) => s + m.brep_faces.length, 0) : 0;
	check('OpenCascade reads the exported STEP as a solid with the right volume', res.success && Math.abs(Math.abs(v) - 6996.3) < 7 && faces === 7 /* the hole is now a true cylinder */, `faces ${faces}, volume ${Math.abs(v).toFixed(1)}`);
}
console.log('ERRORS:', errors.filter((e) => !/GPU stall|swiftshader|WebGL|GL_|ReadPixels/i.test(e)).join('\n') || 'none');
await browser.close();
rmSync(dl, { recursive: true, force: true });
process.exit(fails ? 1 : 0);
