// Persistent mates (attached parts follow their base), exploded view, bill of materials.
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
import { mkdirSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
mkdirSync('test/shots', { recursive: true });
const dl = resolve('test/downloads33');
rmSync(dl, { recursive: true, force: true });
mkdirSync(dl, { recursive: true });
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 240000, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1500, height: 900 } });
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
const near = (a, b, e = 1e-3) => Math.abs(a - b) <= e;
const modalBtn = (label) => app((label) => [...document.querySelectorAll('.modal .btn')].find((b) => b.textContent.trim() === label).click(), label);

// a base plate with a block mated on top (kept attached)
await app(() => {
	localStorage.clear(); const a = window.DraftOtter; a.model.doc.nodes = []; a.model.doc.mates = []; a.commit();
	a.addShape('box'); a.addShape('box');
	const [base, top] = a.model.nodes; base.params.w = 40; base.params.d = 40; base.params.h = 10; base.pos = [0, 0, 5]; top.params.w = 10; top.params.d = 10; top.params.h = 10; top.pos = [60, 0, 5]; base.name = 'Base'; top.name = 'Block';
	a.commit();
	const T = a.vp.camera.position.constructor;
	a.mate = { node: top, a: { kind: 'face', center: new T(60, 0, 0), dir: new T(0, 0, -1) }, b: { kind: 'face', center: new T(0, 0, 10), dir: new T(0, 0, 1) }, base: a.worldMatrix(top), flip: false, spin: 0, offset: 0, target: base, keep: true };
	a.applyMate(); a.showMateBar(); a.endMate();
});
await wait(200);
let r = await app(() => ({ mates: window.DraftOtter.model.doc.mates.length, pos: window.DraftOtter.model.nodes[1].pos }));
check('mating with "keep attached" stores an attachment', r.mates === 1 && near(r.pos[2], 15) && near(r.pos[0], 0), JSON.stringify(r));
// move the base: the block follows
await app(() => { const a = window.DraftOtter; const b = a.model.nodes[0]; b.pos = [25, -10, 5]; b.rot = [0, 0, 90]; a.commit(); });
r = await app(() => window.DraftOtter.model.nodes[1].pos.map((v) => +v.toFixed(3)));
check('moving the base carries the attached block with it', near(r[0], 25) && near(r[1], -10) && near(r[2], 15), JSON.stringify(r));
// move the block itself: it is re-attached where it now is
await app(() => { const a = window.DraftOtter; const t = a.model.nodes[1]; t.pos = [t.pos[0] + 8, t.pos[1], t.pos[2]]; a.commit(); });
await app(() => { const a = window.DraftOtter; const b = a.model.nodes[0]; b.pos = [b.pos[0], b.pos[1] + 5, b.pos[2]]; a.commit(); });
r = await app(() => window.DraftOtter.model.nodes[1].pos.map((v) => +v.toFixed(3)));
check('moving the attached part re-attaches it where you put it', near(r[0], 33) && near(r[1], -5) && near(r[2], 15), JSON.stringify(r));
const und = await app(() => { const a = window.DraftOtter; a.undo(); return a.model.nodes[1].pos.map((v) => +v.toFixed(3)); });
check('attachments follow undo', near(und[0], 33) && near(und[1], -10), JSON.stringify(und));
// detach in the panel
await app(() => window.DraftOtter.showJointsPanel());
const panel = await app(() => document.querySelector('#joints-panel').textContent);
check('panel lists the attachment', /Block → Base/.test(panel), panel.slice(0, 120));
await app(() => [...document.querySelectorAll('#joints-panel .btn')].find((b) => b.textContent === 'Detach').click());
await app(() => { const a = window.DraftOtter; const b = a.model.nodes[0]; b.pos = [0, 0, 5]; a.commit(); });
r = await app(() => ({ mates: window.DraftOtter.model.doc.mates.length, pos: window.DraftOtter.model.nodes[1].pos.map((v) => +v.toFixed(3)) }));
check('after Detach the block stays put', r.mates === 0 && near(r.pos[0], 33), JSON.stringify(r));
await app(() => { document.querySelector('#joints-panel').style.display = 'none'; });

// ---------------------------------------------------------------- exploded view
await app(() => {
	const a = window.DraftOtter; a.model.doc.nodes = []; a.commit();
	for (let i = 0; i < 3; i++) { a.addShape('cylinder'); }
	a.addShape('box');
	const [c1, c2, c3, b] = a.model.nodes; c1.pos = [0, 0, 10]; c2.pos = [0, 0, 10]; c3.pos = [12, 0, 10]; b.pos = [0, 0, 10]; a.commit(); a.setSelection([]); a.frame();
});
const pos0 = await app(() => window.DraftOtter.model.nodes.map((n) => n.pos.slice()));
await app(() => window.DraftOtter.toggleExplode(true));
await wait(300);
const ex = await app(() => { const a = window.DraftOtter; return { moved: a.model.nodes.some((n) => { const o = a.vp.objs.get(n.id); return o && Math.hypot(o.position.x - n.pos[0], o.position.y - n.pos[1], o.position.z - n.pos[2]) > 1; }), data: a.model.nodes.map((n) => n.pos.slice()) }; });
check('exploded view spreads the parts on screen', ex.moved);
check('…without changing the design', JSON.stringify(ex.data) === JSON.stringify(pos0));
await shot('280-exploded');
await app(() => window.DraftOtter.toggleExplode(false));
check('Done puts them back', await app(() => window.DraftOtter.model.nodes.every((n) => { const o = window.DraftOtter.vp.objs.get(n.id); return Math.abs(o.position.x - n.pos[0]) < 1e-6; })));

// ---------------------------------------------------------------- BOM
await app(() => window.DraftOtter.bomDialog());
await wait(200);
const rows = await app(() => [...document.querySelectorAll('.modal table.bom tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent.trim()).join('|')));
check('BOM groups identical parts (3 cylinders, 1 box)', rows.length === 2 && rows.some((t) => /Cylinder\|3\|/.test(t)) && rows.some((t) => /Box\|1\|20 × 20 × 20/.test(t)), rows.join(' / '));
await shot('281-bom');
await modalBtn('Download CSV');
let f = null;
for (let i = 0; i < 40 && !f; i++) { f = readdirSync(dl).find((n) => n.endsWith('_BOM.csv')); await wait(100); }
check('BOM downloads as CSV', !!f && /^Item,Part,Qty/.test(readFileSync(resolve(dl, f), 'utf8')), String(f));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
rmSync(dl, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : 'browser33: all passed');
process.exit(fails ? 1 : 0);
