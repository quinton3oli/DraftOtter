// Print check panel, fits & calibration, configurations (switch + zip export), template parameters.
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
import { mkdirSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
mkdirSync('test/shots', { recursive: true });
const dl = resolve('test/downloads26');
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
const reset = (src) => app((src) => { localStorage.clear(); const a = window.LocalCAD; a.setTool(null); a.closeCheckPanel && a.closeCheckPanel(); a.model.doc.nodes = []; a.model.doc.vars = []; a.model.doc.configs = []; a.model.doc.activeConfig = null; a.sel = []; a.commit(); (0, eval)(src)(a); a.frame(); }, src.toString());
const modalBtn = (label) => app((label) => [...document.querySelectorAll('.modal .btn')].find((b) => b.textContent.trim() === label).click(), label);
const waitFile = async (re) => { for (let i = 0; i < 60; i++) { const f = readdirSync(dl).find((n) => re.test(n) && !n.endsWith('.crdownload')); if (f) return f; await wait(100); } return null; };

// ---------------------------------------------------------------- print check
await reset((a) => {
	a.addShape('box'); a.addShape('box'); a.addShape('box'); a.addShape('box');
	const [base, fin, floater, near] = a.model.nodes;
	base.params.w = 40; base.params.d = 30; base.params.h = 5; base.pos = [0, 0, 2.5];
	fin.params.w = 0.5; fin.params.d = 20; fin.params.h = 15; fin.pos = [0, 0, 12.5]; // thin wall on top of the base
	floater.params.w = 6; floater.params.d = 6; floater.params.h = 6; floater.pos = [30, 0, 20]; // floating cube
	near.params.w = 10; near.params.d = 10; near.params.h = 5; near.pos = [-25.2, 0, 2.5]; // 0.2 mm from the base
	a.commit(); a.setSelection([]);
});
await wait(300);
await app(() => window.LocalCAD.checkPrint());
await wait(300);
const items = await app(() => [...document.querySelectorAll('#check-panel .fp-item')].map((r) => r.className.replace('fp-item ', '') + ': ' + r.querySelector('.fp-title').textContent));
const has = (re) => items.some((t) => re.test(t));
check('check finds the thin wall', has(/^warn: Thin walls \(thinnest 0\.5/), items.join(' | '));
check('check finds the narrow gap', has(/^warn: Narrow gaps \(narrowest 0\.2/), items.join(' | '));
check('check finds the floating piece', has(/^error: 1 piece floating/), items.join(' | '));
check('check reports overhangs and bed fit', has(/^info: Overhangs/) && has(/^ok: Fits the build volume/), items.join(' | '));
check('highlights are drawn', await app(() => window.LocalCAD.vp.checkObj && window.LocalCAD.vp.checkObj.children.length >= 3));
await shot('190-print-check');
await app(() => window.LocalCAD.closeCheckPanel());
check('closing the panel clears highlights', await app(() => !window.LocalCAD.vp.checkObj && document.querySelector('#check-panel').style.display === 'none'));

// ---------------------------------------------------------------- fits
await reset((a) => {
	a.addShape('box'); a.addShape('cylinder');
	const [b, c] = a.model.nodes; b.params.w = 30; b.params.d = 30; b.params.h = 10; b.pos = [0, 0, 5]; c.params.r = 5; c.params.h = 20; c.pos = [0, 0, 5]; c.hole = true; a.commit();
	a.setSelection([c.id]);
});
await wait(200);
const fitOpts = await app(() => [...document.querySelectorAll('#props select')].flatMap((s) => [...s.options].map((o) => o.value)));
check('a hole offers fits in Properties', fitOpts.includes('sliding') && fitOpts.includes('press'), fitOpts.join(','));
await app(() => { const s = [...document.querySelectorAll('#props select')].find((x) => [...x.options].some((o) => o.value === 'sliding')); s.value = 'sliding'; s.dispatchEvent(new Event('change')); });
await wait(200);
const fitNote = await app(() => document.querySelector('#props').textContent);
check('sliding fit noted as 0.3 mm larger', /Printed 0\.3 mm larger across .* in X, Y/.test(fitNote), fitNote.slice(0, 120));
const holeVol = await app(() => { const a = window.LocalCAD; const [b, c] = a.model.nodes; a.setSelection([b.id, c.id]); a.group(); return +a.engine.stats([a.model.nodes[0]]).volume.toFixed(2); });
const expect = 9000 - Math.PI * 5.15 ** 2 * 10;
check('the fitted hole cuts Ø10.3 instead of Ø10', Math.abs(holeVol - expect) < 1.5, `${holeVol} vs ${expect.toFixed(2)}`);
await app(() => { const a = window.LocalCAD; a.model.settings.holeComp = 0.1; a.engine.cache.clear(); a.commit(); });
const comp = await app(() => +window.LocalCAD.engine.stats([window.LocalCAD.model.nodes[0]]).volume.toFixed(2));
check('printer hole compensation adds to every fitted hole', Math.abs(comp - (9000 - Math.PI * 5.2 ** 2 * 10)) < 1.5, String(comp));
await app(() => { window.LocalCAD.model.settings.holeComp = 0; });
// a custom hole made of a group (plus-shaped cutter): a custom fit grows it 0.2 mm on every side
await reset((a) => {
	a.addShape('box'); a.addShape('box'); a.addShape('box');
	const [plate, b1, b2] = a.model.nodes; plate.params.w = 60; plate.params.d = 60; plate.params.h = 10; plate.pos = [0, 0, 5];
	b1.params.w = 20; b1.params.d = 10; b1.params.h = 30; b1.pos = [0, 0, 5]; b2.params.w = 10; b2.params.d = 20; b2.params.h = 30; b2.pos = [0, 0, 5]; a.commit();
	a.setSelection([b1.id, b2.id]); a.group(); const cut = a.model.nodes.find((n) => n.type === 'group'); cut.hole = true; a.commit(); a.setSelection([cut.id]);
});
await wait(300);
const gFit = await app(() => [...document.querySelectorAll('#props select')].some((s) => [...s.options].some((o) => o.value === 'custom')));
check('a group used as a hole offers Fit too', gFit);
await app(() => { const s = [...document.querySelectorAll('#props select')].find((x) => [...x.options].some((o) => o.value === 'custom')); s.value = 'custom'; s.dispatchEvent(new Event('change')); });
await page.waitForFunction(() => !document.querySelector('.pbar') && [...document.querySelectorAll('#props .field')].some((x) => /Clearance Ø/.test(x.textContent)), { timeout: 60000 });
await app(() => { const f = [...document.querySelectorAll('#props .field')].find((x) => /Clearance Ø/.test(x.textContent)); const i = f.querySelector('input'); i.value = '0.4'; i.dispatchEvent(new Event('change')); });
await wait(100); await page.waitForFunction(() => !document.querySelector('.pbar'), { timeout: 60000 }); await wait(100);
const plusVol = await app(() => { const a = window.LocalCAD; a.setSelection(a.model.nodes.map((n) => n.id)); a.group(); return +a.engine.stats([a.model.nodes[0]]).volume.toFixed(1); });
const exact0 = 36000 - 300 * 10, grown = 36000 - (300 + 80 * 0.2 + Math.PI * 0.04) * 10;
check('custom 0.4 mm clearance grows the group-shaped hole 0.2 mm all round', Math.abs(plusVol - grown) < 3 && plusVol < exact0 - 150, `${plusVol} vs ${grown.toFixed(1)} (no clearance: ${exact0})`);
// only some directions: the same cutter grown in X only
// (the rebuild may run in the background: wait for it before measuring)
const xOnly = await app(async () => { const a = window.LocalCAD; const cut = a.model.nodes[0].children.find((c) => c.type === 'group'); cut.fitAxes = 'x'; a.commit(); for (let i = 0; i < 50 && a.bgBuild; i++) await a.bgBuild; return +a.engine.stats([a.model.nodes[0]]).volume.toFixed(1); });
const grownX = 36000 - (20.4 * 10 + 10.4 * 20 - 10.4 * 10) * 10;
check('fit in X only widens the cutter along X but not Y', Math.abs(xOnly - grownX) < 3, `${xOnly} vs ${grownX.toFixed(1)}`);
// a blind box pocket, Z only: deeper, not wider
await reset((a) => {
	a.addShape('box'); a.addShape('box');
	const [b, h] = a.model.nodes; b.params.w = 30; b.params.d = 30; b.params.h = 10; b.pos = [0, 0, 5];
	h.params.w = 10; h.params.d = 10; h.params.h = 4; h.pos = [0, 0, 10]; h.hole = true; h.fit = 'custom'; h.fitClearance = 0.4; a.commit(); a.setSelection([h.id]);
});
await wait(300);
const axesUI = await app(() => [...document.querySelectorAll('#props .field')].find((x) => /Grow in/.test(x.textContent)).querySelectorAll('input[type=checkbox]').length);
check('Fit shows X / Y / Z direction checkboxes (box hole defaults to X+Y)', axesUI === 3 && await app(() => [...[...document.querySelectorAll('#props .field')].find((x) => /Grow in/.test(x.textContent)).querySelectorAll('input')].map((i) => i.checked).join() === 'true,true,false'));
await app(() => { const cbs = [...[...document.querySelectorAll('#props .field')].find((x) => /Grow in/.test(x.textContent)).querySelectorAll('input')]; cbs[2].checked = true; cbs[2].dispatchEvent(new Event('change')); });
await wait(200);
await app(() => { const cbs = [...[...document.querySelectorAll('#props .field')].find((x) => /Grow in/.test(x.textContent)).querySelectorAll('input')]; cbs[0].checked = false; cbs[0].dispatchEvent(new Event('change')); });
await wait(200);
await app(() => { const cbs = [...[...document.querySelectorAll('#props .field')].find((x) => /Grow in/.test(x.textContent)).querySelectorAll('input')]; cbs[1].checked = false; cbs[1].dispatchEvent(new Event('change')); });
await wait(200);
const zAx = await app(() => window.LocalCAD.model.nodes[1].fitAxes);
check('ticking Z and unticking X, Y leaves Z only', zAx === 'z', String(zAx));
const keepOne = await app(() => { const cbs = [...[...document.querySelectorAll('#props .field')].find((x) => /Grow in/.test(x.textContent)).querySelectorAll('input')]; cbs[2].checked = false; cbs[2].dispatchEvent(new Event('change')); return window.LocalCAD.model.nodes[1].fitAxes + cbs[2].checked; });
check('the last direction cannot be unticked', keepOne === 'ztrue', keepOne);
const pocket = await app(() => { const a = window.LocalCAD; a.setSelection(a.model.nodes.map((n) => n.id)); a.group(); return +a.engine.stats([a.model.nodes[0]]).volume.toFixed(2); });
check('Z-only fit makes a blind pocket 0.2 mm deeper but no wider', Math.abs(pocket - (9000 - 100 * 2.2)) < 0.5, `${pocket} vs ${9000 - 220}`);
// a mesh-like custom shape (sphere) grown in Y only stays the same in X
const ySph = await app(() => { const a = window.LocalCAD; a.model.doc.nodes = []; a.addShape('sphere'); const n = a.model.nodes[0]; n.hole = true; n.fit = 'custom'; n.fitClearance = 2; n.fitAxes = 'y'; a.commit(); const g = a.engine.geometry(n); g.computeBoundingBox(); const s = g.boundingBox.getSize(g.boundingBox.min.clone()); return [n.params.r, +s.x.toFixed(2), +s.y.toFixed(2), +s.z.toFixed(2)]; });
check('generic shape with a Y-only fit: 2 mm longer in Y, same X and Z', Math.abs(ySph[2] - ySph[1] - 2) < 0.05 && Math.abs(ySph[1] - ySph[3]) < 0.05, JSON.stringify(ySph));
await reset((a) => { a.fitCalibration(5); });
await wait(400);
const cal = await app(() => { const a = window.LocalCAD; const g = a.model.nodes[0]; return { name: g.name, holes: g.children.filter((c) => c.hole).map((c) => c.fit || 'none'), peg: a.model.nodes[1].name }; });
check('fit test print: plate with 5 holes + peg', cal.holes.join() === 'none,press,snug,sliding,loose' && /peg/.test(cal.peg), JSON.stringify(cal));
await app(() => { window.LocalCAD.setSelection([]); window.LocalCAD.frame(); });
await wait(300);
await shot('191-fit-test');

// ---------------------------------------------------------------- configurations
await reset((a) => {
	a.model.doc.vars = [{ name: 'w', expr: '20' }, { name: 'h', expr: '10' }];
	a.model.doc.configs = [{ name: 'Small', values: { w: '20', h: '10' } }, { name: 'Large', values: { w: '40', h: '30' } }];
	a.model.doc.activeConfig = 'Small';
	a.addShape('box'); const b = a.model.nodes[0]; a.setExpr(b, 'params.w', 'w'); a.setExpr(b, 'params.h', 'h'); a.commit(); a.setSelection([]);
});
await wait(300);
const sw = await app(() => { const s = [...document.querySelectorAll('#props select')].find((x) => [...x.options].some((o) => o.value === 'Large')); return !!s; });
check('Properties shows a configuration switcher', sw);
await app(() => { const s = [...document.querySelectorAll('#props select')].find((x) => [...x.options].some((o) => o.value === 'Large')); s.value = 'Large'; s.dispatchEvent(new Event('change')); });
await wait(300);
let p = await app(() => { const n = window.LocalCAD.model.nodes[0]; return [n.params.w, n.params.h, window.LocalCAD.model.doc.activeConfig]; });
check('switching to "Large" applies its values', p[0] === 40 && p[1] === 30 && p[2] === 'Large', JSON.stringify(p));
const undone = await app(() => { const a = window.LocalCAD; a.undo(); const n = a.model.nodes[0]; return [n.params.w, a.model.doc.activeConfig]; });
check('undo restores the previous configuration', undone[0] === 20 && undone[1] === 'Small', JSON.stringify(undone));
// variables dialog: save a new configuration
await app(() => window.LocalCAD.variablesDialog());
await wait(150);
await app(() => { const ins = [...document.querySelectorAll('.vars-row:not(.head) input')]; ins[1].value = '33'; ins[1].dispatchEvent(new Event('input')); const nm = document.querySelector('.cfg-bar input[type=text]'); nm.value = 'Medium'; [...document.querySelectorAll('.cfg-bar .btn')].find((b) => b.textContent === 'Save values as').click(); });
await shot('192-configurations');
await modalBtn('Save');
await wait(200);
p = await app(() => ({ cfgs: window.LocalCAD.model.doc.configs.map((c) => c.name + ':' + c.values.w), active: window.LocalCAD.model.doc.activeConfig, w: window.LocalCAD.model.nodes[0].params.w }));
check('variables dialog saves a new configuration', p.cfgs.join() === 'Small:20,Large:40,Medium:33' && p.active === 'Medium' && p.w === 33, JSON.stringify(p));
// export every configuration
await app(() => window.LocalCAD.exportDialog('stl'));
await wait(100);
await app(() => { document.querySelector('#ex-name').value = 'bracket'; document.querySelector('#ex-scope').value = 'configs'; });
await modalBtn('Export');
const z = await waitFile(/configurations\.zip$/);
check('every configuration exported to one zip', z === 'bracket_configurations.zip', String(z));
if (z) {
	const bytes = readFileSync(resolve(dl, z));
	const names = await app((b64) => Object.keys(window.__lcadTest.readZip(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))), bytes.toString('base64'));
	check('zip holds one STL per configuration', names.join() === 'bracket_Small.stl,bracket_Large.stl,bracket_Medium.stl', names.join());
}
p = await app(() => ({ w: window.LocalCAD.model.nodes[0].params.w, active: window.LocalCAD.model.doc.activeConfig }));
check('export leaves the current configuration in place', p.w === 33 && p.active === 'Medium', JSON.stringify(p));

// ---------------------------------------------------------------- template parameters
await reset((a) => {
	a.model.doc.vars = [{ name: 'side', expr: '12' }];
	a.addShape('box'); a.addShape('cylinder');
	const [b, c] = a.model.nodes; a.setExpr(b, 'params.w', 'side'); a.setExpr(b, 'params.d', 'side'); c.params.r = 2; c.hole = true; a.commit();
	a.setSelection([b.id, c.id]); a.group();
});
await wait(300);
await app(() => window.LocalCAD.makeTemplate(window.LocalCAD.model.nodes[0]));
await wait(100);
const tplText = await app(() => document.querySelector('.modal').textContent);
check('Make template lists the design variables used inside', /side/.test(tplText), tplText.slice(0, 160));
await app(() => { document.querySelector('#tpl-save').checked = false; });
await modalBtn('Make template');
await wait(200);
const lv = await app(() => JSON.stringify(window.LocalCAD.model.nodes[0].localVars));
check('the group gets its own "side" parameter', lv === '[{"name":"side","expr":"12"}]', lv);
// two copies with different values
await app(() => { const a = window.LocalCAD; a.setSelection([a.model.nodes[0].id]); a.duplicate(); const [g1, g2] = a.model.nodes; g2.localVars[0].expr = '30'; a.commit(); });
await wait(300);
const sizes = await app(() => window.LocalCAD.model.nodes.map((g) => g.children[0].params.w));
check('each copy uses its own parameter value', sizes.join() === '12,30', sizes.join());
await app(() => { const a = window.LocalCAD; a.model.doc.vars[0].expr = '99'; a.commit(); });
const sizes2 = await app(() => window.LocalCAD.model.nodes.map((g) => g.children[0].params.w));
check('design variables no longer change the template', sizes2.join() === '12,30', sizes2.join());
await app(() => { const a = window.LocalCAD; a.setSelection([a.model.nodes[1].id]); });
await wait(150);
const prm = await app(() => [...document.querySelectorAll('#props .param-row input')].map((i) => i.value));
check('Properties shows the group parameters', prm.join() === 'side,30', prm.join());
await shot('193-template-params');

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
rmSync(dl, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : 'browser26: all passed');
process.exit(fails ? 1 : 0);
