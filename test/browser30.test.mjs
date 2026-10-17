// STEP / IGES import through the embedded OpenCascade reader.
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
import { mkdirSync, readFileSync } from 'node:fs';
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
const T = 'node_modules/occt-import-js/test/testfiles/';
const importFile = (path, name) => app(async ([b64, name]) => {
	const a = window.LocalCAD; a.model.doc.nodes = []; a.commit();
	const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
	const t0 = performance.now();
	await a.importCAD([new File([bytes], name)]);
	const nodes = a.model.nodes;
	const box = a.vp.selectionBox(nodes.map((n) => n.id));
	return { n: nodes.length, types: [...new Set(nodes.map((n) => n.type))], names: nodes.slice(0, 3).map((n) => n.name), vol: +a.engine.stats(nodes).volume.toFixed(1), size: box.getSize(box.min.clone()).toArray().map((v) => +v.toFixed(2)), minz: +box.min.z.toFixed(3), ms: Math.round(performance.now() - t0) };
}, [readFileSync(path).toString('base64'), name]);

let r = await importFile(T + 'cube-10x10mm/Cube 10x10.stp', 'Cube 10x10.stp');
check('STEP cube imports as a 10 mm mesh part on the bed', r.n === 1 && r.types.join() === 'mesh' && Math.abs(r.vol - 1000) < 0.5 && r.size.every((v) => Math.abs(v - 10) < 1e-3) && r.minz === 0, JSON.stringify(r));
r = await importFile(T + 'cube-10x10mm/Cube 10x10.igs', 'Cube 10x10.igs');
check('IGES imports too', r.n >= 1 && Math.abs(r.size[0] - 10) < 1e-3, JSON.stringify(r));
r = await importFile(T + 'cube-units/cube-in.step', 'cube-in.step');
check('inch STEP files are converted to millimeters (a 1 m cube written in inches → 1000 mm)', r.n === 1 && r.size.every((v) => Math.abs(v - 1000) < 0.01), JSON.stringify(r));
r = await importFile(T + 'cax-if/as1-oc-214.stp', 'as1-oc-214.stp');
check('an assembly imports as separate named bodies laid out as designed', r.n > 5 && r.types.join() === 'mesh' && r.minz === 0 && r.vol > 0, JSON.stringify(r));
await app(() => { const a = window.LocalCAD; a.setSelection([]); a.frame(); });
await wait(500);
await shot('250-step-import');
const save = await app(() => { const a = window.LocalCAD; const d = JSON.parse(a.model.serialize()); return Object.keys(d.blobs).length === new Set(a.model.nodes.map((n) => n.params.blob)).size; });
check('imported bodies are saved inside the design file', save);
const ex = await app(() => { const a = window.LocalCAD; const g = a.engine.printable(a.model.nodes, false); return g.attributes.position.count > 0; });
check('imported parts can be exported / combined', ex);

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'browser30: all passed');
process.exit(fails ? 1 : 0);
