// Surface texture and deform in the app: Modify menu commands, Properties fields, building in the background, the
// lattice editor (drag a point in the view), undo, and saving.
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
const settle = () => app(async () => { const a = window.DraftOtter; for (let i = 0; i < 50 && a.bgBuild; i++) await a.bgBuild; });
const stats = (id) => app((id) => { const a = window.DraftOtter, n = a.model.get(id); const s = a.engine.stats([n]); const z = s.box.getSize(new (s.box.min.constructor)()); return { vol: s.volume, size: z.toArray().map((v) => +v.toFixed(3)), tris: s.tris }; }, id);
const field = (label) => app((label) => { const f = [...document.querySelectorAll('#props .field')].find((x) => x.querySelector('span') && x.querySelector('span').textContent.trim() === label); return f ? (f.querySelector('input, select') || {}).value : null; }, label);
const setField = async (label, v) => { await app(([label, v]) => { const f = [...document.querySelectorAll('#props .field')].find((x) => x.querySelector('span') && x.querySelector('span').textContent.trim() === label); const i = f.querySelector('input, select'); i.value = v; i.dispatchEvent(new Event('change')); }, [label, v]); await settle(); };
const menuItem = (text) => app((text) => { const b = [...document.querySelectorAll('#toolbar .tb-btn, #toolbar button')].find((x) => /Modify/.test(x.title || x.textContent)); b.click(); const it = [...document.querySelectorAll('.menu .menu-item, .menu button, .menu div')].find((x) => x.textContent.trim().startsWith(text)); if (!it) return false; it.click(); return true; }, text);

await app(() => { localStorage.clear(); const a = window.DraftOtter; a.model.doc.nodes = []; a.commit(); });

// ---------------------------------------------------------------- texture
await app(() => { const a = window.DraftOtter; a.addShape('box'); const n = a.model.nodes[0]; n.params.w = 30; n.params.d = 30; n.params.h = 10; a.commit(); a.setSelection([n.id]); });
await settle();
check('Modify menu has Surface texture', await menuItem('Surface texture'));
await settle();
let g = await app(() => { const a = window.DraftOtter, n = a.selectedNodes()[0]; return n && { id: n.id, mode: n.mode, texture: n.texture, kids: n.children.length }; });
check('…which wraps the part in a texture group (knurl by default)', g && g.mode === 'texture' && g.texture.pattern === 'knurl' && g.kids === 1, JSON.stringify(g));
let s = await stats(g.id);
check('the knurled part is bigger than the plain box', s.vol > 9000 && s.size[0] > 30.2 && s.size[0] <= 30.81 && s.tris > 3000, JSON.stringify(s));
check('Properties: pattern, size, depth, apply to, wrap', (await field('Pattern')) === 'knurl' && (await field('Size (mm)')) === '2' && (await field('Depth (mm)')) === '0.4' && (await field('Apply to')) === 'all' && (await field('Wrap')) === 'box');
check('the tree tags it as a texture', await app(() => [...document.querySelectorAll('#tree .tag')].some((t) => t.textContent === 'texture')));
await setField('Apply to', 'top');
await setField('Pattern', 'bumps');
await setField('Depth (mm)', '-0.5');
s = await stats(g.id);
check('dimples on the top only: smaller volume, sides untouched', s.vol < 9000 && s.vol > 8500 && s.size[0] === 30 && s.size[2] === 10, JSON.stringify(s));
const hist = await app(() => window.DraftOtter.model.hIndex);
await app(() => window.DraftOtter.undo());
await settle();
check('undo goes back one setting at a time', await app(() => window.DraftOtter.model.get(window.DraftOtter.model.nodes[0].id).texture.pattern === 'bumps' && window.DraftOtter.model.nodes[0].texture.depth === 0.4), hist);
await app(() => window.DraftOtter.redo());
await settle();
// the part inside stays editable
await app(() => { const a = window.DraftOtter, b = a.model.nodes[0].children[0]; b.params.h = 20; a.commit(); });
await settle();
s = await stats(g.id);
check('editing the part inside re-textures it', s.size[2] === 20, JSON.stringify(s));
check('it was built by the background workers', await app(() => !!window.DraftOtter.engine.pool && window.DraftOtter.engine.pool.ok));

// a knurled knob: cylinder with seamless cylindrical knurl on the sides
await app(() => { const a = window.DraftOtter; a.model.doc.nodes = []; a.commit(); a.addShape('cylinder'); const n = a.model.nodes[0]; n.params.r = 15; n.params.h = 18; a.commit(); a.setSelection([n.id]); a.addTexture(); });
await settle();
await setField('Apply to', 'sides');
await setField('Wrap', 'cylinder');
await setField('Size (mm)', '2.5');
await settle();
await app(() => { const a = window.DraftOtter; a.setSelection([]); a.vp.frameBox(a.sceneBox()); });
await wait(600);
await page.screenshot({ path: 'test/shots/440-texture-knurl.png' });

// ---------------------------------------------------------------- deform
await app(() => { const a = window.DraftOtter; a.model.doc.nodes = []; a.commit(); a.addShape('box'); const n = a.model.nodes[0]; n.params.w = 10; n.params.d = 10; n.params.h = 40; a.commit(); a.setSelection([n.id]); });
check('Modify menu has Deform', await menuItem('Deform'));
await settle();
g = await app(() => { const n = window.DraftOtter.selectedNodes()[0]; return { id: n.id, mode: n.mode }; });
check('…a deform group', g.mode === 'deform' && (await field('Along axis')) === 'z' && (await field('Twist (°)')) === '0' && (await field('Lattice')) === '0');
await setField('Twist (°)', '90');
s = await stats(g.id);
check('twist 90°: same volume, corners turned', Math.abs(s.vol - 4000) < 40 && s.size[0] > 11 && s.size[2] === 40, JSON.stringify(s));
await setField('Twist (°)', '0');
await setField('Bend (°)', '90');
s = await stats(g.id);
check('bend 90° toward +X', Math.abs(s.vol - 4000) < 40 && s.size[0] > 29 && s.size[2] < 31, JSON.stringify(s));
check('the twist could be an expression of a variable too', await app(() => { const a = window.DraftOtter; a.model.doc.vars = [{ name: 'ang', expr: '45' }]; const n = a.model.nodes[0]; a.setExpr(n, 'deform.twist', 'ang*2'); a.commit(); return n.deform.twist === 90; }));
await settle();
await app(() => { const a = window.DraftOtter, n = a.model.nodes[0]; a.setExpr(n, 'deform.twist', null); n.deform.twist = 0; n.deform.bend = 0; a.commit(); a.setSelection([n.id]); a.propSig = null; a.renderProps(); });
await settle();

// lattice: 2×2×2, drag a top corner point sideways in the view
await setField('Lattice', '2');
await settle();
let L = await app(() => { const a = window.DraftOtter; return a.lattice && { n: a.lattice.world.length, top: a.lattice.world.map((p) => p.z) }; });
check('choosing a lattice starts the editor with 8 points around the part', L && L.n === 8 && Math.max(...L.top) - Math.min(...L.top) === 40, JSON.stringify(L));
await app(() => window.DraftOtter.vp.setView('front'));
await wait(600);
const pt = await app(() => { const a = window.DraftOtter, vp = a.vp, r = vp.canvas.getBoundingClientRect(); const i = a.lattice.world.findIndex((p) => p.z > 0 && p.x > 0 && p.y < 0); const s = a.lattice.world[i].clone().project(vp.camera); return { i, x: r.left + ((s.x + 1) / 2) * r.width, y: r.top + ((1 - s.y) / 2) * r.height }; });
await page.mouse.move(pt.x, pt.y);
await page.mouse.down();
for (let k = 1; k <= 8; k++) await page.mouse.move(pt.x + k * 10, pt.y, { steps: 1 });
check('dragging previews the change right away', await app(() => !!window.DraftOtter.lattice.drag));
await page.mouse.up();
await settle();
const moved = await app((i) => window.DraftOtter.model.nodes[0].deform.lattice.d[i], pt.i);
check('dragging a point moves it in the lattice (to the right in the front view = +X)', moved[0] > 2 && Math.abs(moved[1]) < 0.01 && Math.abs(moved[2]) < 0.6, JSON.stringify(moved));
s = await stats(g.id);
check('…and the part follows', s.size[0] > 10 + moved[0] * 0.1, JSON.stringify(s));
check('the Properties show it', await app(() => /1 of 8 points moved/.test(document.querySelector('#props').textContent)));
await page.screenshot({ path: 'test/shots/441-lattice.png' });
await app(() => window.DraftOtter.undo());
await settle();
check('undo puts the point back', await app(() => window.DraftOtter.model.nodes[0].deform.lattice.d.every((q) => !q[0] && !q[1] && !q[2])));
check('…and the editor follows it', await app((i) => Math.abs(window.DraftOtter.lattice.world[i].x - 5) < 1e-6, pt.i));
await page.keyboard.press('Escape');
check('Esc leaves the lattice editor', await app(() => !window.DraftOtter.lattice));

// saved designs keep the settings
const round = await app(() => { const a = window.DraftOtter, s = a.model.serialize(); a.model.load(JSON.parse(s).doc, JSON.parse(s).blobs); a.afterChange(); const n = a.model.nodes[0]; return { mode: n.mode, lattice: !!n.deform.lattice, n: n.deform.lattice.n }; });
check('saving and opening keeps the deform', round.mode === 'deform' && round.lattice && round.n.join() === '2,2,2', JSON.stringify(round));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'browser53: all passed');
process.exit(fails ? 1 : 0);
