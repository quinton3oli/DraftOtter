// Higher-end CAD: variables & expressions, constrained sketches with driving dimensions, sketch on face,
// loft & sweep, offset (grow/shrink), shell with open faces.
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';
mkdirSync('test/shots', { recursive: true });
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 120000, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1500, height: 900 } });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('dialog', (d) => d.accept());
await page.goto(pathToFileURL('LocalCAD.html').href);
await page.waitForFunction(() => document.body.classList.contains('ready'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const app = (fn, ...a) => page.evaluate(fn, ...a);
const shot = (n) => page.screenshot({ path: `test/shots/${n}.png` });
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(ok ? 'ok  ' : 'FAIL', name, info); };
const near = (a, b, t = 0.05) => Math.abs(a - b) <= t;
const vol = (i = 0) => app((i) => { const a = window.LocalCAD; return a.engine.stats([a.model.nodes[i]]).volume; }, i);
const modalBtn = (label) => app((label) => [...document.querySelectorAll('.modal-foot .btn, .sk-actions .btn')].find((b) => b.textContent === label).click(), label);
const reset = () => app(() => { localStorage.clear(); const a = window.LocalCAD; a.model.doc.nodes = []; a.model.doc.vars = []; a.sel = []; a.commit(); });
await reset();

// ---------------------------------------------------------------- 3. Variables & expressions
await app(() => window.LocalCAD.variablesDialog());
await wait(100);
await app(() => [...document.querySelectorAll('.modal .btn')].find((b) => b.textContent.includes('Add variable')).click());
await app(() => { const [nm, ex] = document.querySelectorAll('.vars-row:not(.head) input'); nm.value = 'wall'; nm.dispatchEvent(new Event('input')); ex.value = '2'; ex.dispatchEvent(new Event('input')); });
await app(() => [...document.querySelectorAll('.modal .btn')].find((b) => b.textContent.includes('Add variable')).click());
await app(() => { const ins = document.querySelectorAll('.vars-row:not(.head) input'); ins[2].value = 'width'; ins[2].dispatchEvent(new Event('input')); ins[3].value = 'wall*10 + 5'; ins[3].dispatchEvent(new Event('input')); });
const liveVal = await app(() => [...document.querySelectorAll('.vars-val')].map((v) => v.textContent));
check('variables dialog shows live values', liveVal[0] === '2' && liveVal[1] === '25', JSON.stringify(liveVal));
await shot('80-variables');
await modalBtn('Save');
check('variables saved', await app(() => JSON.stringify(window.LocalCAD.model.doc.vars) === JSON.stringify([{ name: 'wall', expr: '2' }, { name: 'width', expr: 'wall*10 + 5' }])));
await app(() => window.LocalCAD.addShape('box'));
let inp = await page.$('#props .field input.num');
await inp.click();
await page.keyboard.type('width');
await page.keyboard.press('Enter');
await wait(150);
let st = await app(() => { const n = window.LocalCAD.model.nodes[0]; return { w: n.params.w, expr: n.exprs && n.exprs['params.w'], cls: document.querySelector('#props .field input.num').className }; });
check('typing a variable name into a field stores an expression', st.w === 25 && st.expr === 'width' && st.cls.includes('has-expr'), JSON.stringify(st));
// change the variable -> the box follows
await app(() => { const a = window.LocalCAD; a.model.doc.vars[0].expr = '3'; a.commit(); });
check('changing a variable updates the part', await app(() => window.LocalCAD.model.nodes[0].params.w === 35));
await app(() => document.activeElement.blur());
await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
check('undo reverts the variable change', await app(() => window.LocalCAD.model.nodes[0].params.w === 25 && window.LocalCAD.model.doc.vars[0].expr === '2'));
// unknown name is rejected with a helpful message
inp = await page.$('#props .field input.num');
await inp.click();
await page.keyboard.type('bogus*2');
await page.keyboard.press('Enter');
await wait(100);
check('unknown variable is rejected', await app(() => window.LocalCAD.model.nodes[0].params.w === 25 && [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('Unknown name'))));
// direct manipulation drops a position expression
await app(() => { const a = window.LocalCAD; const n = a.model.nodes[0]; n.pos[0] = 0; a.setExpr(n, 'pos.0', 'wall*5'); a.commit(); });
check('position expression applied', await app(() => window.LocalCAD.model.nodes[0].pos[0] === 10));
await app(() => { const a = window.LocalCAD; a.setSelection([a.model.nodes[0].id]); a.nudge(1, 0, 0); });
check('nudging replaces a position expression with the new value', await app(() => { const n = window.LocalCAD.model.nodes[0]; return n.pos[0] === 11 && !(n.exprs && n.exprs['pos.0']); }));

// ---------------------------------------------------------------- 2. Constrained sketch with a variable-driven dimension
await reset();
await app(() => { const a = window.LocalCAD; a.model.doc.vars = [{ name: 'L', expr: '30' }]; a.commit(); a.newSketch(); });
await wait(300);
const dlgPos = async (x, y) => app(([x, y]) => { const d = document.querySelector('.modal-back').__sketch; const r = document.querySelector('.sk-canvas').getBoundingClientRect(); const [sx, sy] = d.toScr([x, y]); return [r.left + sx, r.top + sy]; }, [x, y]);
await app(() => { const ta = document.querySelector('.sk-points'); ta.value = '0,0\n24,1\n25,13\n-1,11'; ta.dispatchEvent(new Event('input')); });
await app(() => [...document.querySelectorAll('.sk-toolbar .btn')].find((b) => b.textContent.includes('Fit')).click());
await page.keyboard.press('s'); // select mode
// select bottom edge (0) and constrain horizontal, then top edge (2) horizontal, sides vertical
const clickEdge = async (a, b) => { const p = await dlgPos((a[0] + b[0]) / 2, (a[1] + b[1]) / 2); await page.mouse.click(p[0], p[1]); };
await clickEdge([0, 0], [24, 1]); await page.keyboard.press('h');
await clickEdge([25, 13], [-1, 11]); await page.keyboard.press('h');
let S = await app(() => document.querySelector('.modal-back').__sketch.st.points);
await clickEdge(S[1], S[2]); await page.keyboard.press('v');
S = await app(() => document.querySelector('.modal-back').__sketch.st.points);
await clickEdge(S[3], S[0]); await page.keyboard.press('v');
// fix the first point, then dimension the bottom edge with the variable L, and the side with 12
S = await app(() => document.querySelector('.modal-back').__sketch.st.points);
let p0 = await dlgPos(S[0][0], S[0][1]);
await page.mouse.click(p0[0], p0[1]); await page.keyboard.press('f');
await clickEdge(S[0], S[1]); await page.keyboard.press('l');
await wait(150);
await page.waitForSelector('.sk-dim-edit');
await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
await page.keyboard.type('L');
await page.keyboard.press('Enter');
await wait(100);
S = await app(() => document.querySelector('.modal-back').__sketch.st.points);
await clickEdge(S[1], S[2]); await page.keyboard.press('l');
await page.waitForSelector('.sk-dim-edit');
await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
await page.keyboard.type('12');
await page.keyboard.press('Enter');
await wait(150);
const sk = await app(() => { const d = document.querySelector('.modal-back').__sketch; return { pts: d.st.points.map((p) => p.map((v) => Math.round(v * 1000) / 1000)), cons: d.st.cons.length, status: document.querySelector('.sk-status').textContent }; });
const [q0, q1, q2, q3] = sk.pts;
check('sketch solves to an exact 30 × 12 rectangle', q1[0] - q0[0] === 30 && q1[1] === q0[1] && q2[1] - q1[1] === 12 && q2[0] === q1[0] && q3[0] === q0[0] && q3[1] === q2[1], JSON.stringify(sk.pts));
check('fully constrained status shown', sk.status.includes('Fully constrained'), sk.status + ` (${sk.cons} constraints)`);
await shot('81-sketch-constraints');
await modalBtn('Create');
await wait(300);
const skNode = await app(() => { const n = window.LocalCAD.model.nodes[0]; const b = window.LocalCAD.worldBox(n); return { type: n.type, cons: n.params.cons.length, sx: +(b.max.x - b.min.x).toFixed(3), sy: +(b.max.y - b.min.y).toFixed(3) }; });
check('sketch part created with constraints', skNode.type === 'sketch' && skNode.cons >= 7 && skNode.sx === 30 && skNode.sy === 12, JSON.stringify(skNode));
await app(() => { const a = window.LocalCAD; a.model.doc.vars[0].expr = '45'; a.commit(); });
const after = await app(() => { const n = window.LocalCAD.model.nodes[0]; const b = window.LocalCAD.worldBox(n); return +(b.max.x - b.min.x).toFixed(3); });
check('changing the variable re-solves the sketch (L = 45)', after === 45, String(after));

// ---------------------------------------------------------------- 4. Sketch on face: cut a pocket and extrude a boss
await reset();
await app(() => { const a = window.LocalCAD; a.addShape('box'); a.setSelection([]); a.frame(); });
await wait(500);
const openFace = () => app(() => {
	const a = window.LocalCAD, vp = a.vp;
	const d = vp.displays.get(a.model.nodes[0].id);
	const top = new (d.position.constructor)(0, 0, 20);
	vp.render();
	const s = vp.project(top), r = vp.canvas.getBoundingClientRect();
	a.onSketchFace(vp.surfacePoint({ clientX: r.left + s.x + 2, clientY: r.top + s.y + 2 }));
});
await openFace();
await wait(300);
const refCount = await app(() => document.querySelector('.modal-back').__sketch && document.querySelectorAll('.sk-canvas').length && document.querySelector('.modal-back').__sketch.st && document.querySelector('.modal-head h3').textContent);
check('sketch-on-face opens on the clicked object', String(refCount).includes('Box'), String(refCount));
await app(() => {
	const ta = document.querySelector('.sk-points');
	const o = document.querySelector('.modal-back').__sketch.st;
	// center a 10 x 10 square on the face (face origin is where we clicked)
	ta.value = '-5,-5\n5,-5\n5,5\n-5,5'; ta.dispatchEvent(new Event('input'));
	const sel = document.querySelector('.sk-right select'); sel.value = 'cut'; sel.dispatchEvent(new Event('change'));
	const fields = [...document.querySelectorAll('.sk-right .sk-field')];
	const depth = fields.find((f) => f.textContent.startsWith('Depth')).querySelector('input'); depth.value = '8'; depth.dispatchEvent(new Event('change'));
});
await shot('82-sketch-on-face');
await modalBtn('Create');
await wait(400);
let r = await app(() => { const a = window.LocalCAD; const g = a.model.nodes[0]; return { n: a.model.nodes.length, type: g.type, name: g.name, kids: g.children && g.children.map((c) => c.type + (c.hole ? '(hole)' : '')).join(','), vol: a.engine.stats([g]).volume }; });
check('pocket is cut into the box (combined automatically)', r.n === 1 && r.type === 'group' && r.kids === 'box,sketch(hole)' && near(r.vol, 8000 - 10 * 10 * 8, 1), JSON.stringify(r));
await app(() => window.LocalCAD.frame());
await wait(500);
await shot('83-pocket');
// extrude a boss from the box side (+X face)
await app(() => {
	const a = window.LocalCAD, vp = a.vp;
	vp.setView('right');
});
await wait(500);
await app(() => window.LocalCAD.frame());
await wait(500);
await app(() => {
	const a = window.LocalCAD, vp = a.vp;
	vp.render();
	const s = vp.project(new THREE_V(10, 0, 10)), rr = vp.canvas.getBoundingClientRect();
	a.onSketchFace(vp.surfacePoint({ clientX: rr.left + s.x + 1, clientY: rr.top + s.y + 1 }));
	function THREE_V(x, y, z) { const v = vp.camera.position.clone(); v.set(x, y, z); return v; }
});
await wait(300);
await app(() => {
	const ta = document.querySelector('.sk-points');
	ta.value = '-3,-3\n3,-3\n3,3\n-3,3'; ta.dispatchEvent(new Event('input'));
	const fields = [...document.querySelectorAll('.sk-right .sk-field')];
	const h = fields.find((f) => f.textContent.startsWith('Extrude height')).querySelector('input'); h.value = '7'; h.dispatchEvent(new Event('change'));
});
await modalBtn('Create');
await wait(500);
r = await app(() => { const a = window.LocalCAD; const g = a.model.nodes[0]; const b = a.worldBox(g); return { n: a.model.nodes.length, vol: a.engine.stats([g]).volume, maxx: +b.max.x.toFixed(3) }; });
check('boss extruded out of the side face', r.n === 1 && near(r.vol, 7200 + 6 * 6 * 7, 1.5) && near(r.maxx, 17, 0.01), JSON.stringify(r));
await app(() => { window.LocalCAD.vp.setView('iso'); });
await wait(400);
await app(() => window.LocalCAD.frame());
await wait(500);
await shot('84-boss');

// ---------------------------------------------------------------- 6/7. Loft & sweep from the library
await reset();
const clickLib = (label) => app((label) => [...document.querySelectorAll('.lib-item')].find((e) => e.textContent.trim() === label).click(), label);
for (const l of ['Loft', 'Duct adapter', 'Twisted loft', 'Sweep', 'Bent tube', 'Spline handle']) await clickLib(l);
const lsOk = await app(() => window.LocalCAD.model.nodes.map((n) => [n.type, !!window.LocalCAD.engine.geometry(n)]));
check('loft & sweep library items build', lsOk.length === 6 && lsOk.every(([, ok]) => ok), JSON.stringify(lsOk));
await app(() => { const a = window.LocalCAD; a.setSelection([]); a.frame(); });
await wait(600);
await shot('85-loft-sweep');
// edit a sweep path in Properties
await app(() => { const a = window.LocalCAD; const n = a.model.nodes.find((x) => x.type === 'sweep'); a.setSelection([n.id]); });
const pathInput = await page.$$eval('#props .field input[type=text]:not(.num)', (els) => els.map((e) => e.value));
check('sweep path is editable in Properties', pathInput.some((v) => v.includes(';')), JSON.stringify(pathInput.slice(0, 2)));

// ---------------------------------------------------------------- 8. Offset and shell with open faces
await reset();
await app(() => { const a = window.LocalCAD; a.addShape('box'); a.setSelection([a.model.nodes[0].id]); a.offsetDialog(); });
await wait(100);
await app(() => { document.querySelector('#off-d').value = '1'; });
await modalBtn('Offset');
await wait(300);
r = await app(() => { const a = window.LocalCAD; const g = a.model.nodes[0]; const b = a.worldBox(g); return { mode: g.mode, off: g.offset, vol: a.engine.stats([g]).volume, size: +(b.max.x - b.min.x).toFixed(2) }; });
check('offset +1 grows a 20 mm cube to 22 mm with rounded edges', r.mode === 'offset' && near(r.size, 22, 0.05) && r.vol > 10400 && r.vol < 10648, JSON.stringify(r));
await app(async () => { const a = window.LocalCAD; a.model.nodes[0].offset = -1; a.commit(); if (a.bgBuild) await a.bgBuild; }); // a slow rebuild may run in the background
r = await app(() => { const a = window.LocalCAD; const b = a.worldBox(a.model.nodes[0]); return +(b.max.x - b.min.x).toFixed(2); });
check('offset −1 shrinks it to 18 mm', near(r, 18, 0.05), String(r));
await reset();
await app(() => { const a = window.LocalCAD; a.addShape('box'); a.setSelection([a.model.nodes[0].id]); a.shellDialog(); });
await wait(100);
await app(() => { document.querySelector('#sh-t').value = '2'; document.querySelector('#sh-o-top').checked = true; document.querySelector('#sh-o-front').checked = true; });
await shot('86-shell-dialog');
await modalBtn('Shell');
await wait(300);
r = await vol();
check('shell with top + front open', near(r, 8000 - 16 * 18 * 18, 1), r.toFixed(1) + ' (expected 2816)');
await app(() => { const a = window.LocalCAD; a.setSelection([]); a.frame(); });
await wait(500);
await shot('87-shell-open');

console.log('ERRORS:', errors.filter((e) => !/GPU stall|swiftshader|WebGL|GL_|ReadPixels/i.test(e)).join('\n') || 'none');
await browser.close();
process.exit(fails ? 1 : 0);
