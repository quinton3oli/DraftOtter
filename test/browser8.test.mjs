// Shell, screw holes, edge bevels, object snapping, workplane, My parts library, object picker / click cycling.
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';
mkdirSync('test/shots', { recursive: true });
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 90000, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1500, height: 900 } });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('dialog', (d) => d.accept());
await page.goto(pathToFileURL('LocalCAD.html').href);
await page.waitForFunction(() => document.body.classList.contains('ready'));
await page.evaluate(() => { localStorage.clear(); });
await page.reload();
await page.waitForFunction(() => document.body.classList.contains('ready'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const app = (fn, ...a) => page.evaluate(fn, ...a);
const shot = (n) => page.screenshot({ path: `test/shots/${n}.png` });
const cv = await (await page.$('#viewport canvas')).boundingBox();
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(ok ? 'ok  ' : 'FAIL', name, info); };
const clickLib = (label) => app((label) => [...document.querySelectorAll('.lib-item')].find((e) => e.textContent.trim() === label).click(), label);
const modalBtn = (label) => app((label) => [...document.querySelectorAll('.modal-foot .btn, .modal .btn')].find((b) => b.textContent === label).click(), label);
const proj = (x, y, z) => app((x, y, z) => { const vp = window.LocalCAD.vp; vp.render(); return vp.project(new (vp.camera.position.constructor)(x, y, z)); }, x, y, z);
const reset = () => app(() => { const a = window.LocalCAD; a.model.doc.nodes = []; a.sel = []; a.vp.clearWorkplane(); a.commit(); });

// ---- 1. Shell with open top
await clickLib('Box');
await app(() => window.LocalCAD.shellDialog());
await wait(100);
await app(() => { document.querySelector('#sh-t').value = '2'; document.querySelector('#sh-o-top').checked = true; });
await modalBtn('Shell');
await wait(300);
const sh = await app(() => { const a = window.LocalCAD; const g = a.model.nodes[0]; return { type: g.type, kids: g.children.map((c) => c.type + (c.hole ? '(hole)' : '')).join(','), inner: g.children[1].params, vol: a.engine.stats([g]).volume }; });
check('shell makes editable group', sh.type === 'group' && sh.kids === 'box,box(hole)', sh.kids);
check('shell open-top volume', Math.abs(sh.vol - (8000 - 16 * 16 * 18)) < 1, `${sh.vol.toFixed(1)} (expected 3392)`);
await app(() => window.LocalCAD.frame());
await wait(500);
await shot('60-shell');

// ---- 2. Screw holes + 3. edges
await reset();
for (const l of ['Screw hole', 'Countersunk', 'Counterbore', 'Heat-set insert', 'Nut trap']) await clickLib(l);
const holes = await app(() => { const a = window.LocalCAD; return a.model.nodes.map((n) => [n.params.style, n.hole, !!a.engine.geometry(n)]); });
check('screw-hole presets are holes with geometry', holes.length === 5 && holes.every(([, h, g]) => h && g), JSON.stringify(holes));
await app(() => { const a = window.LocalCAD; a.addShape('box'); const b = a.model.nodes[5]; b.params.w = 60; b.params.d = 20; b.params.h = 8; a.model.nodes.slice(0, 5).forEach((n, i) => { n.pos = [-24 + i * 12, b.pos[1], b.pos[2] + 4 - n.params.depth / 2 + 0.01]; }); a.commit(); a.setSelection(a.model.nodes.map((n) => n.id)); a.group(); });
await wait(300);
const plate = await app(() => { const a = window.LocalCAD; const g = a.model.nodes[0]; return { ok: !!a.engine.geometry(g) && !a.engine.errors.size, vol: a.engine.stats([g]).volume }; });
check('plate with all screw-hole styles booleans cleanly', plate.ok && plate.vol < 60 * 20 * 8 - 100, plate.vol.toFixed(1));
await app(() => window.LocalCAD.frame());
await wait(500);
await shot('61-screwholes');
await reset();
await app(() => { const a = window.LocalCAD; a.addShape('prism'); a.addShape('text'); a.addShape('gear'); a.model.nodes[0].params.edge = 2; a.model.nodes[0].params.edgeType = 'fillet'; a.model.nodes[1].params.edge = 0.6; a.model.nodes[2].params.edge = 0.6; a.commit(); a.setSelection([]); a.frame(); });
await wait(500);
const edged = await app(() => { const a = window.LocalCAD; return a.model.nodes.map((n) => !!a.engine.geometry(n)); });
check('edge chamfer/fillet on polygon, text, gear', edged.every(Boolean));
await shot('62-edges');

// ---- 4. Object snapping while dragging (grid snap off to isolate)
await reset();
await app(() => { const a = window.LocalCAD; a.model.settings.snap = 0; a.vp.setSnap(a.model.settings); a.addShape('box'); a.addShape('box'); const [A, B] = a.model.nodes; A.pos = [0, 0, 10]; B.pos = [45, 0.7, 10]; a.commit(); a.setSelection([]); a.vp.setView('top'); });
await wait(500);
await app(() => window.LocalCAD.frame());
await wait(500);
let p = await proj(45, 0.7, 20);
await page.mouse.move(cv.x + p.x, cv.y + p.y);
await page.mouse.down();
await page.mouse.move(cv.x + p.x - 25, cv.y + p.y + 1, { steps: 8 });
const guidesVisible = await app(() => !!(window.LocalCAD.vp.guideLines && window.LocalCAD.vp.guideLines.visible));
await shot('63-snap-guides');
await page.mouse.up();
await wait(200);
const by = await app(() => window.LocalCAD.model.nodes[1].pos[1]);
check('drag snaps Y edge to neighboring object', Math.abs(by) < 1e-6 && guidesVisible, `B.y = ${by}, guides shown: ${guidesVisible}`);
await app(() => { const a = window.LocalCAD; a.model.settings.snap = 1; a.vp.setSnap(a.model.settings); a.vp.setView('iso'); });

// ---- 5. Workplane on top face, then on a side face
await reset();
await app(() => { const a = window.LocalCAD; a.addShape('box'); const b = a.model.nodes[0]; b.pos = [0, 0, 10]; a.commit(); a.setSelection([]); a.frame(); });
await wait(500);
await page.keyboard.press('k');
p = await proj(2, 3, 20);
await page.mouse.click(cv.x + p.x, cv.y + p.y);
await wait(200);
const wp1 = await app(() => { const w = window.LocalCAD.vp.workplane; return w && [w.normal.z, w.origin.z]; });
await clickLib('Cylinder');
const cyl = await app(() => { const a = window.LocalCAD; const b = a.worldBox(a.model.nodes[1]); return [+b.min.z.toFixed(3), a.vp.workplane && a.vp.workplane.label]; });
check('workplane on top face; new shape sits on it', wp1 && Math.abs(wp1[0] - 1) < 1e-6 && Math.abs(cyl[0] - 20) < 1e-3, `normal.z=${wp1 && wp1[0]}, cylinder bottom z=${cyl[0]}, chip=${await app(() => !!document.querySelector('#wp-chip'))}`);
await shot('64-workplane-top');
await app(() => { const a = window.LocalCAD; a.setSelection([]); a.vp.setView('right'); });
await wait(500);
await app(() => window.LocalCAD.frame());
await wait(500);
await wait(500);
await page.keyboard.press('k');
p = await proj(10, -3, 10);
await page.mouse.click(cv.x + p.x, cv.y + p.y);
await wait(200);
await clickLib('Cone');
const cone = await app(() => { const a = window.LocalCAD; const n = a.model.nodes[2]; const b = a.worldBox(n); return { minx: +b.min.x.toFixed(3), wpn: a.vp.workplane.normal.toArray().map((v) => +v.toFixed(3)) }; });
check('workplane on side face; new shape stands out from it', Math.abs(cone.minx - 10) < 1e-3 && cone.wpn[0] === 1, JSON.stringify(cone));
await app(() => window.LocalCAD.frame());
await wait(500);
await shot('65-workplane-side');
await app(() => { const a = window.LocalCAD; a.setSelection([]); a.vp.setView('iso'); });
await wait(500);
await app(() => window.LocalCAD.frame());
await wait(500);
await page.keyboard.press('k');
p = await app(() => {
	const vp = window.LocalCAD.vp; const r = vp.canvas.getBoundingClientRect();
	for (const [fx, fy] of [[0.5, 0.92], [0.15, 0.85], [0.85, 0.85], [0.3, 0.7], [0.7, 0.7]]) {
		const x = r.width * fx, y = r.height * fy;
		const s = vp.surfacePoint({ clientX: r.left + x, clientY: r.top + y });
		if (s && !s.object) return { x, y };
	}
	return { x: 0, y: 0 };
});
await page.mouse.click(cv.x + p.x, cv.y + p.y);
await wait(100);
check('clicking the bed resets the workplane', await app(() => !window.LocalCAD.vp.workplane && !document.querySelector('#wp-chip')));

// ---- 6. My parts library
await app(() => { const a = window.LocalCAD; a.setSelection(a.model.nodes.map((n) => n.id)); a.saveToLibrary(); });
await wait(100);
await app(() => { document.querySelector('#lib-name').value = 'Test bracket'; });
await modalBtn('Save');
await wait(400);
const libItems = await app(() => [...document.querySelectorAll('#my-parts .lib-item')].map((e) => e.textContent.trim()));
check('saved part appears in My parts', libItems.includes('Test bracket'), JSON.stringify(libItems));
const before = await app(() => window.LocalCAD.model.nodes.length);
await clickLib('Test bracket');
await wait(300);
const added = await app(() => { const a = window.LocalCAD; const n = a.model.nodes[a.model.nodes.length - 1]; return { count: a.model.nodes.length, type: n.type, kids: n.children && n.children.length, minz: +a.worldBox(n).min.z.toFixed(3) }; });
check('inserting a saved part adds it on the bed', added.count === before + 1 && added.type === 'group' && added.kids === 3 && Math.abs(added.minz) < 1e-3, JSON.stringify(added));
await shot('66-my-parts');

// ---- 7. Object picker + click cycling with an embedded object
await reset();
await app(() => { const a = window.LocalCAD; a.addShape('box'); a.addShape('sphere'); const [B, S] = a.model.nodes; B.params.w = 40; B.params.d = 40; B.params.h = 20; B.pos = [0, 0, 10]; S.params.r = 6; S.pos = [0, 0, 10]; S.name = 'Hidden ball'; a.commit(); a.setSelection([]); a.vp.setView('top'); });
await wait(500);
await app(() => window.LocalCAD.frame());
await wait(500);
p = await proj(0, 0, 20);
await page.keyboard.down('Alt');
await page.mouse.click(cv.x + p.x, cv.y + p.y);
await page.keyboard.up('Alt');
await wait(150);
const rows = await app(() => [...document.querySelectorAll('.menu.picker .pick-row')].map((r) => r.textContent));
check('Alt+click lists every object under the cursor', rows.length === 2 && rows.some((r) => r.includes('Hidden ball')), JSON.stringify(rows));
await shot('67-picker');
await app(() => [...document.querySelectorAll('.menu.picker .pick-row')].find((r) => r.textContent.includes('Hidden ball')).click());
check('picking from the list selects the embedded object', await app(() => window.LocalCAD.model.get(window.LocalCAD.sel[0]).name === 'Hidden ball'));
await app(() => window.LocalCAD.setSelection([]));
await page.mouse.click(cv.x + p.x, cv.y + p.y);
await wait(80);
const first = await app(() => window.LocalCAD.model.get(window.LocalCAD.sel[0]).name);
await page.mouse.click(cv.x + p.x, cv.y + p.y);
await wait(80);
const second = await app(() => window.LocalCAD.model.get(window.LocalCAD.sel[0]).name);
await page.mouse.click(cv.x + p.x, cv.y + p.y);
await wait(80);
const third = await app(() => window.LocalCAD.model.get(window.LocalCAD.sel[0]).name);
check('clicking the same spot cycles through stacked objects', first === 'Box' && second === 'Hidden ball' && third === 'Box', `${first} -> ${second} -> ${third}`);
await page.mouse.click(cv.x + p.x + 30, cv.y + p.y, { button: 'right' });
await wait(100);
const ctx = await app(() => [...document.querySelectorAll('.menu button')].map((b) => b.textContent));
check('right-click menu offers object list, shell, save part, workplane', ctx.some((t) => t.startsWith('Select object here')) && ctx.some((t) => t.startsWith('Shell')) && ctx.some((t) => t.startsWith('Save to My parts')) && ctx.some((t) => t.startsWith('Set workplane')), JSON.stringify(ctx.slice(0, 3)));

console.log('ERRORS:', errors.filter((e) => !/GPU stall|swiftshader|WebGL|GL_|ReadPixels/i.test(e)).join('\n') || 'none');
await browser.close();
process.exit(fails ? 1 : 0);
