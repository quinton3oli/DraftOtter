// Hull: wrap a convex skin around the selection (blend shapes), holes still cut, single-object hull, Ctrl+H, UI entries.
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';
mkdirSync('test/shots', { recursive: true });
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 120000, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1500, height: 900 } });
const page = await browser.newPage();
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
const info = () => app(() => { const a = window.DraftOtter; const g = a.model.nodes[0]; const b = a.worldBox(g); return { n: a.model.nodes.length, type: g.type, mode: g.mode, name: g.name, vol: +a.engine.stats([g]).volume.toFixed(1), size: b.getSize(b.min.clone()).toArray().map((v) => +v.toFixed(2)) }; });

// ---------------------------------------------------------------- two boxes → one long box (Ctrl+H)
await reset((a) => { a.addShape('box'); a.addShape('box'); const [p, q] = a.model.nodes; for (const n of [p, q]) { n.params.w = n.params.d = n.params.h = 10; } p.pos = [0, 0, 5]; q.pos = [20, 0, 5]; a.commit(); a.setSelection([p.id, q.id]); });
await wait(300);
await page.keyboard.down('Control'); await page.keyboard.press('h'); await page.keyboard.up('Control');
await wait(400);
let r = await info();
check('Ctrl+H hulls the selection into one part', r.n === 1 && r.type === 'group' && r.mode === 'hull' && r.name === 'Hull', JSON.stringify(r));
check('hull of two cubes is the box spanning them (3000 mm³)', Math.abs(r.vol - 3000) < 0.5 && r.size[0] === 30, JSON.stringify(r));
const tag = await app(() => [...document.querySelectorAll('#tree .tag')].map((t) => t.textContent).join(','));
check('tree tags it as a hull', tag.includes('hull'), tag);

// ---------------------------------------------------------------- two spheres blend into a capsule; a hole still cuts
await reset((a) => { a.addShape('sphere'); a.addShape('sphere'); const [p, q] = a.model.nodes; p.params.r = q.params.r = 10; p.pos = [0, 0, 10]; q.pos = [30, 0, 10]; a.commit(); a.setSelection([p.id, q.id]); a.group('hull'); });
await wait(400);
r = await info();
const capsule = (4 / 3) * Math.PI * 1000 + Math.PI * 100 * 30;
check('hull of two spheres is a capsule', Math.abs(r.vol - capsule) / capsule < 0.03 && Math.abs(r.size[0] - 50) < 0.1, JSON.stringify(r) + ' expect ≈' + capsule.toFixed(0));
await app(() => { const a = window.DraftOtter; const g = a.model.nodes[0]; a.addShape('cylinder'); const c = a.model.nodes[1]; c.params.r = 3; c.params.h = 40; c.hole = true; c.pos = [15 + g.pos[0], g.pos[1], 0]; a.commit(); });
await wait(200);
const withHole = await app(() => { const a = window.DraftOtter; const [g, c] = a.model.nodes; a.setSelection([g.id, c.id]); a.group('union'); return +a.engine.stats([a.model.nodes[0]]).volume.toFixed(1); });
check('a hole grouped with the hull cuts through it', withHole < r.vol - 500, `${withHole} < ${r.vol}`);
await app(() => { const a = window.DraftOtter; a.setSelection([]); a.frame(); });
await wait(400);
await shot('140-hull-capsule');

// ---------------------------------------------------------------- holes inside a hull group are cut after the hull
await reset((a) => { a.addShape('box'); a.addShape('box'); a.addShape('cylinder'); const [p, q, c] = a.model.nodes; for (const n of [p, q]) { n.params.w = n.params.d = n.params.h = 10; } p.pos = [0, 0, 5]; q.pos = [20, 0, 5]; c.params.r = 2; c.params.h = 20; c.pos = [10, 0, 5]; c.hole = true; a.commit(); a.setSelection([p.id, q.id, c.id]); a.group('hull'); });
await wait(400);
r = await info();
const expectHole = 3000 - Math.PI * 4 * 10;
check('holes in a hull group are subtracted from the hull', Math.abs(r.vol - expectHole) / expectHole < 0.01, JSON.stringify(r) + ' expect ' + expectHole.toFixed(1));

// ---------------------------------------------------------------- single object: convex wrap of a star
await reset((a) => { a.addShape('star'); a.setSelection([a.model.nodes[0].id]); });
await wait(300);
const starVol = await app(() => +window.DraftOtter.engine.stats([window.DraftOtter.model.nodes[0]]).volume.toFixed(1));
await app(() => window.DraftOtter.group('hull'));
await wait(300);
r = await info();
check('hulling a single object wraps it (star → filled polygon)', r.mode === 'hull' && r.vol > starVol * 1.3, `${starVol} → ${r.vol}`);

// ---------------------------------------------------------------- switch an existing group between union and hull in Properties
await reset((a) => { a.addShape('sphere'); a.addShape('cube' in a ? 'box' : 'box'); const [p, q] = a.model.nodes; p.params.r = 8; p.pos = [0, 0, 8]; q.pos = [40, 0, 10]; a.commit(); a.setSelection([p.id, q.id]); a.group('union'); a.setSelection([a.model.nodes[0].id]); });
await wait(300);
const unionVol = (await info()).vol;
const opts = await app(() => [...document.querySelectorAll('#props select option')].map((o) => o.value));
check('Properties group mode offers Hull', opts.includes('hull'), opts.join(','));
await app(() => { const s = [...document.querySelectorAll('#props select')].find((x) => [...x.options].some((o) => o.value === 'hull')); s.value = 'hull'; s.dispatchEvent(new Event('change')); });
await wait(300);
r = await info();
check('switching a group to Hull bridges the gap', r.mode === 'hull' && r.vol > unionVol * 1.5, `${unionVol} → ${r.vol}`);

// ---------------------------------------------------------------- toolbar button and context menu entries exist
const ui = await app(() => ({ tb: !![...document.querySelectorAll('#toolbar .tb')].find((b) => /Hull/.test(b.title || b.textContent)), props: true }));
check('toolbar has a Hull button', ui.tb);

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'browser21: all passed');
process.exit(fails ? 1 : 0);
