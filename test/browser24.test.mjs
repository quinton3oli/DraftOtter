// 3MF export (loaded back with three's 3MF loader), mass properties / tip-over warning, split with alignment pins.
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
import { mkdirSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
mkdirSync('test/shots', { recursive: true });
const dl = resolve('test/downloads24');
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
const reset = (src) => app((src) => { localStorage.clear(); const a = window.LocalCAD; a.setTool(null); a.showCOM = false; a.model.doc.nodes = []; a.sel = []; a.commit(); (0, eval)(src)(a); a.frame(); }, src.toString());
const modalBtn = (label) => app((label) => [...document.querySelectorAll('.modal .btn')].find((b) => b.textContent.trim() === label).click(), label);
const waitFile = async (re) => { for (let i = 0; i < 50; i++) { const f = readdirSync(dl).find((n) => re.test(n) && !n.endsWith('.crdownload')); if (f) return f; await wait(100); } return null; };

// ---------------------------------------------------------------- 3MF export
await reset((a) => { a.addShape('box'); a.addShape('cylinder'); const [b, c] = a.model.nodes; b.name = 'Body'; b.color = '#ff0000'; c.name = 'Knob'; c.color = '#0000ff'; c.pos = [40, 0, 10]; a.commit(); a.setSelection([]); });
await wait(300);
await app(() => window.LocalCAD.exportDialog('3mf'));
await wait(100);
const note = await app(() => document.querySelector('#ex-note').textContent);
check('Export dialog offers 3MF with a note about colors', /colored/.test(note), note);
await app(() => { document.querySelector('#ex-name').value = 'pair'; });
await modalBtn('Export');
const f3 = await waitFile(/\.3mf$/);
check('3MF downloaded', f3 === 'pair.3mf', String(f3));
if (f3) {
	const bytes = readFileSync(resolve(dl, f3));
	const parsed = await app(async (b64) => {
		const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
		const { readZip } = window.__lcadTest;
		const model = new TextDecoder().decode(readZip(bin)['3D/3dmodel.model']);
		return { objects: (model.match(/<object /g) || []).length, names: [...model.matchAll(/<object [^>]*name="([^"]+)"/g)].map((m) => m[1]), colors: [...model.matchAll(/displaycolor="([^"]+)"/g)].map((m) => m[1]) };
	}, bytes.toString('base64'));
	check('3MF holds both parts with names and colors', parsed.objects === 2 && parsed.names.join() === 'Body,Knob' && parsed.colors.join() === '#FF0000FF,#0000FFFF', JSON.stringify(parsed));
}

// ---------------------------------------------------------------- mass properties & tipping
await reset((a) => { a.addShape('box'); const b = a.model.nodes[0]; b.params.w = 10; b.params.d = 20; b.params.h = 30; b.pos = [3, 4, 15]; a.commit(); a.setSelection([]); });
await wait(400);
let stats = await app(() => document.querySelector('#stats').textContent);
check('Print info shows surface area and center of mass', /Surface area\s*22 cm²/.test(stats) && /Center of mass\s*3, 4, 15/.test(stats), stats.replace(/\s+/g, ' ').slice(0, 300));
await app(() => [...document.querySelectorAll('#stats button')].find((b) => b.textContent === 'Show').click());
await wait(200);
check('center of mass marker can be shown', await app(() => !!window.LocalCAD.vp.comObj));
await reset((a) => { a.addShape('box'); a.addShape('box'); const [p, q] = a.model.nodes; p.params.w = 2; p.params.d = 2; p.params.h = 40; p.pos = [0, 0, 20]; q.params.w = 30; q.params.d = 10; q.params.h = 10; q.pos = [16, 0, 45]; a.commit(); a.setSelection([p.id, q.id]); a.group(); a.setSelection([]); });
await wait(500);
stats = await app(() => document.querySelector('#stats').textContent);
check('warns when the center of mass is outside the footprint', /may tip over/.test(stats), stats.replace(/\s+/g, ' ').slice(-200));
await shot('170-mass-props');

// ---------------------------------------------------------------- split with pins
await reset((a) => { a.addShape('box'); const b = a.model.nodes[0]; b.params.w = 40; b.params.d = 30; b.params.h = 30; b.pos = [0, 0, 15]; a.commit(); a.setSelection([b.id]); });
await wait(300);
await app(() => window.LocalCAD.splitDialog());
await wait(200);
const dlg = await app(() => ({ pos: document.querySelector('#sp-pos').value, plane: !!window.LocalCAD.vp.cutObj, rings: window.LocalCAD.vp.cutObj ? window.LocalCAD.vp.cutObj.children.length - 1 : 0 }));
check('split dialog previews the plane at the middle with 2 pin spots', dlg.pos === '15' && dlg.plane && dlg.rings === 2, JSON.stringify(dlg));
await shot('171-split-preview');
await modalBtn('Split');
await wait(600);
const res = await app(() => {
	const a = window.LocalCAD;
	return a.model.nodes.map((n) => { const b = a.worldBox(n); return { name: n.name, type: n.type, vol: +a.engine.stats([n]).volume.toFixed(1), minz: +b.min.z.toFixed(3), h: +(b.max.z - b.min.z).toFixed(3) }; });
});
const halves = res.filter((r) => /part/.test(r.name)), pins = res.filter((r) => r.name === 'Alignment pin');
const holeVol = 2 * Math.PI * (2.5 + 0.15) ** 2 * (6 + 0.15);
check('two halves + two pins', halves.length === 2 && pins.length === 2, JSON.stringify(res));
check('each half is 40×30×15 minus two pin holes', halves.every((h) => Math.abs(h.vol - (18000 - holeVol)) < 3 && Math.abs(h.h - 15) < 1e-3), JSON.stringify(halves) + ' expect ' + (18000 - holeVol).toFixed(1));
check('halves lie cut-face down on the bed, side by side', halves.every((h) => Math.abs(h.minz) < 1e-3), JSON.stringify(halves));
const noOverlap = await app(() => { const a = window.LocalCAD; const [p, q] = a.model.nodes; const b1 = a.worldBox(p), b2 = a.worldBox(q); return !b1.intersectsBox(b2); });
check('halves do not overlap', noOverlap);
check('cut plane preview removed after splitting', await app(() => !window.LocalCAD.vp.cutObj));
await app(() => { window.LocalCAD.setSelection([]); window.LocalCAD.frame(); });
await wait(400);
await shot('172-split-result');
const undo = await app(() => { const a = window.LocalCAD; a.undo(); return a.model.nodes.length; });
check('undo restores the original part', undo === 1);

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
rmSync(dl, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : 'browser24: all passed');
process.exit(fails ? 1 : 0);
