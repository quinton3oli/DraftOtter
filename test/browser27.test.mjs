// Version history (save / compare / restore), mates, hinge joint + collision sweep, interference, wrap onto a cylinder.
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';
mkdirSync('test/shots', { recursive: true });
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 180000, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1500, height: 900 } });
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
const near = (a, b, e = 1e-3) => Math.abs(a - b) <= e;
const reset = (src) => app((src) => { localStorage.clear(); const a = window.DraftOtter; a.setTool(null); a.stopCompare(); a.closeCheckPanel(); a.endMate(); a.model.doc.nodes = []; delete a.model.doc.history; a.model.doc.joints = []; a.sel = []; a.commit(); (0, eval)(src)(a); a.frame(); }, src.toString());
const modalBtn = (label) => app((label) => [...document.querySelectorAll('.modal .btn')].find((b) => b.textContent.trim() === label).click(), label);
const cv = await (await page.$('#viewport canvas')).boundingBox();
const screen = (x, y, z) => app(([x, y, z]) => { const vp = window.DraftOtter.vp; vp.render(); return vp.project(vp.camera.position.clone().set(x, y, z)); }, [x, y, z]);
const clickAt = async (x, y, z) => { const p = await screen(x, y, z); await page.mouse.move(cv.x + p.x, cv.y + p.y, { steps: 2 }); await page.mouse.click(cv.x + p.x, cv.y + p.y); await wait(150); };

// ---------------------------------------------------------------- versions
await reset((a) => { a.addShape('box'); a.addShape('cylinder'); const [b, c] = a.model.nodes; c.pos = [30, 0, 10]; a.commit(); });
await wait(300);
const v1 = await app(() => window.DraftOtter.saveVersion('first').id);
await app(() => { const a = window.DraftOtter; const [b, c] = a.model.nodes; b.params.w = 35; a.model.doc.nodes.splice(1, 1); a.addShape('sphere'); a.commit(); });
await wait(300);
const auto = await app(() => { const a = window.DraftOtter; const x = a.saveVersion('', { auto: true }); const y = a.saveVersion('', { auto: true }); return [!!x, !!y, Object.keys(a.model.doc.history.commits).length]; });
check('automatic versions skip unchanged designs', auto[0] && !auto[1] && auto[2] === 2, JSON.stringify(auto));
await app(() => window.DraftOtter.versionsDialog());
await wait(200);
const rows = await app(() => [...document.querySelectorAll('.hist-row')].map((r) => r.querySelector('.ver-name').value + (r.classList.contains('current') ? '*' : '') + (r.querySelector('img') ? '+thumb' : '')));
check('history lists both commits, newest first, with thumbnails', rows.join() === 'Saved*+thumb,first+thumb', rows.join());
await shot('200-versions');
await app(() => document.querySelector('.modal-back .modal-head .icon-btn').click());
const diff = await app((id) => { const d = window.DraftOtter.compareVersion(id); return { added: d.added.map((n) => n.type), removed: d.removed.map((n) => n.type), changed: d.changed.map((c) => c.what.join(';')), ghost: window.DraftOtter.compareObj.children.length }; }, v1);
check('compare lists added / removed / changed parts', diff.added.join() === 'sphere' && diff.removed.join() === 'cylinder' && /w 20 → 35/.test(diff.changed.join()), JSON.stringify(diff));
check('compare shows the old version as a ghost', diff.ghost >= 2);
await shot('201-compare');
await app((id) => window.DraftOtter.restoreVersion(id), v1);
await wait(300);
const rest = await app(() => window.DraftOtter.model.nodes.map((n) => n.type + (n.params.w || '')).join());
check('restore brings the old design back', rest === 'box20,cylinder', rest);
const und = await app(() => { const a = window.DraftOtter; a.undo(); return a.model.nodes.map((n) => n.type).join(); });
check('restore can be undone', und === 'box,sphere', und);
const persisted = await app(() => Object.keys(JSON.parse(window.DraftOtter.model.serialize()).doc.history.commits).length);
check('versions are saved inside the design file', persisted >= 2, String(persisted));

// ---------------------------------------------------------------- mate: put a block on top of another, then a pin into a hole
await reset((a) => {
	a.addShape('box'); a.addShape('box');
	const [base, top] = a.model.nodes; base.params.w = 40; base.params.d = 40; base.params.h = 10; base.pos = [0, 0, 5];
	top.params.w = 10; top.params.d = 10; top.params.h = 10; top.pos = [50, 30, 5]; top.rot = [0, 0, 30]; a.commit(); a.setSelection([]);
});
await wait(400);
await app(() => window.DraftOtter.startMate());
await clickAt(50, 30, 0.01 + 0); // bottom face is hidden from above — use the side instead
const st = await app(() => !!(window.DraftOtter.mateState && window.DraftOtter.mateState.a));
if (!st) await clickAt(50 - 4.9, 30, 5); // fallback: a side face
await app(() => { const a = window.DraftOtter; if (a.mateState && a.mateState.a) { a.mateState.a.f = { kind: 'face', center: new a.vp.camera.position.constructor(50, 30, 0), dir: new a.vp.camera.position.constructor(0, 0, -1) }; } });
await clickAt(5, 5, 10); // top face of the base
await wait(300);
let m = await app(() => { const a = window.DraftOtter; const t = a.model.nodes[1]; const b = a.worldBox(t); return { min: b.min.toArray().map((v) => +v.toFixed(3)), max: b.max.toArray().map((v) => +v.toFixed(3)), bar: !!document.querySelector('#mate-bar') && document.querySelector('#mate-bar').style.display !== 'none' }; });
check('mate puts the block flat on top of the base, centered', near(m.min[2], 10) && near((m.min[0] + m.max[0]) / 2, 0, 0.01) && near((m.min[1] + m.max[1]) / 2, 0, 0.01) && m.bar, JSON.stringify(m));
await shot('202-mate');
await app(() => [...document.querySelectorAll('#mate-bar .btn')].find((b) => b.textContent === 'Flip').click());
await wait(200);
m = await app(() => { const a = window.DraftOtter; const b = a.worldBox(a.model.nodes[1]); return +b.max.z.toFixed(3); });
check('Flip puts it on the other side of the face (sunk into the base)', near(m, 10), String(m));
await app(() => window.DraftOtter.endMate());

// pin into a hole: concentric
await reset((a) => {
	a.addShape('box'); a.addShape('cylinder'); a.addShape('cylinder');
	const [plate, hole, pin] = a.model.nodes; plate.params.w = 40; plate.params.d = 40; plate.params.h = 8; plate.pos = [0, 0, 4];
	hole.params.r = 3; hole.params.h = 20; hole.pos = [8, -6, 4]; hole.hole = true; a.commit(); a.setSelection([plate.id, hole.id]); a.group();
	pin.params.r = 3; pin.params.h = 16; pin.pos = [60, 20, 8]; pin.rot = [90, 0, 0]; a.commit(); a.setSelection([]);
});
await wait(400);
const res = await app(() => {
	const a = window.DraftOtter;
	const T = a.vp.camera.position.constructor;
	const [g, pin] = a.model.nodes;
	// feature on the pin: its axis (lying along Y); on the plate: the hole rim
	a.mate = { node: pin, a: { kind: 'axis', center: new T(60, 20, 8), dir: new T(0, 1, 0) }, b: { kind: 'circle', center: new T(8, -6, 8), dir: new T(0, 0, 1) }, base: a.worldMatrix(pin), flip: false, spin: 0, offset: 0, target: g };
	a.applyMate();
	const b = a.worldBox(pin);
	return { cx: +((b.min.x + b.max.x) / 2).toFixed(3), cy: +((b.min.y + b.max.y) / 2).toFixed(3), h: +(b.max.z - b.min.z).toFixed(3) };
});
check('pin axis becomes concentric with the hole (stands upright in it)', near(res.cx, 8) && near(res.cy, -6) && near(res.h, 16), JSON.stringify(res));

// ---------------------------------------------------------------- hinge joint + collision sweep + interference
await reset((a) => {
	a.addShape('box'); a.addShape('box');
	const [wall, door] = a.model.nodes; wall.params.w = 60; wall.params.d = 4; wall.params.h = 40; wall.pos = [20, -25, 20]; // in the door's swing path
	door.params.w = 40; door.params.d = 4; door.params.h = 30; door.pos = [0, 0, 15]; a.commit(); a.setSelection([door.id]);
});
await wait(300);
const j = await app(() => { const a = window.DraftOtter; const T = a.vp.camera.position.constructor; const door = a.model.nodes[1]; return a.addJoint({ type: 'hinge', node: door, origin: new T(20, 0, 0), axis: new T(0, 0, 1), min: -180, max: 180 }).id; });
await wait(200);
check('joints panel opens with a slider', await app(() => !!document.querySelector('#joints-panel input[type=range]')));
await app(() => { const a = window.DraftOtter; a.setJoint(a.model.doc.joints[0], 90); });
let dp = await app(() => { const a = window.DraftOtter; const b = a.worldBox(a.model.nodes[1]); return [b.min.x, b.max.x, b.min.y, b.max.y].map((v) => +v.toFixed(2)); });
check('hinge at 90° swings the door about its edge (counter-clockwise)', near(dp[0], 18, 0.01) && near(dp[1], 22, 0.01) && near(dp[2], -40, 0.01) && near(dp[3], 0, 0.01), JSON.stringify(dp));
const sweep = await app(() => { const a = window.DraftOtter; return a.sweepJoint(a.model.doc.joints[0], 36); });
check('collision sweep finds where the door hits the wall', sweep.hits.length > 0 && /Hits Box/.test(sweep.text), sweep.text);
await shot('203-joint');
const pairs = await app(() => window.DraftOtter.interferenceCheck().map((p) => `${p.a}/${p.b}:${p.volume.toFixed(0)}`));
check('interference check reports the overlapping door and wall', pairs.length === 1 && /Box\/Box/.test(pairs[0]), pairs.join());
const undoJ = await app(() => { const a = window.DraftOtter; a.undo(); return a.model.doc.joints[0].value; });
check('joint moves are undoable', undoJ === 0, String(undoJ));

// ---------------------------------------------------------------- wrap text onto a cylinder
await reset((a) => { a.addShape('cylinder'); a.addShape('text'); const [c, t] = a.model.nodes; c.params.r = 15; c.params.h = 30; c.pos = [0, 0, 15]; t.params.text = 'LOCAL'; t.params.size = 7; t.pos = [50, 0, 2]; a.commit(); a.setSelection([c.id, t.id]); });
await wait(400);
const cylVol = await app(() => +window.DraftOtter.engine.stats([window.DraftOtter.model.nodes[0]]).volume.toFixed(1));
await app(() => window.DraftOtter.wrapDialog());
await wait(100);
await modalBtn('Wrap');
await wait(1200);
const w = await app(() => { const a = window.DraftOtter; const g = a.model.nodes[0]; const b = a.worldBox(g); return { n: a.model.nodes.length, type: g.type, kids: g.children.map((c) => c.type).join(), vol: +a.engine.stats([g]).volume.toFixed(1), rx: +((b.max.x - b.min.x) / 2).toFixed(2), miny: +b.min.y.toFixed(2), maxy: +b.max.y.toFixed(2), err: [...a.engine.errors].length }; });
check('text wrapped and merged with the cylinder', w.n === 1 && w.kids === 'cylinder,wrap' && w.vol > cylVol + 20 && w.err === 0, JSON.stringify(w) + ' cyl ' + cylVol);
check('embossed letters stand 0.8 mm proud on the front', near(w.miny, -15.8, 0.05) && near(w.maxy, 15, 0.05), JSON.stringify(w));
await app(() => { const a = window.DraftOtter; const wr = a.model.nodes[0].children[1]; wr.params.mode = 'engrave'; wr.hole = true; a.commit(); });
await wait(800);
const eng = await app(() => { const a = window.DraftOtter; return { vol: +a.engine.stats([a.model.nodes[0]]).volume.toFixed(1), err: [...a.engine.errors].length }; });
check('switching to engrave cuts the letters in', eng.vol < cylVol - 20 && eng.err === 0, JSON.stringify(eng) + ' cyl ' + cylVol);
await app(() => { const a = window.DraftOtter; a.model.nodes[0].children[1].params.mode = 'emboss'; a.model.nodes[0].children[1].hole = false; a.commit(); a.setSelection([]); a.vp.setView('front'); a.frame(); });
await wait(1200);
await shot('204-wrap');

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'browser27: all passed');
process.exit(fails ? 1 : 0);
