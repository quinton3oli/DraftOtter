// Going back into a sketch: double-click the shape (also inside a group, also a pocket), right-click → Edit sketch,
// Properties of the group; a pocket keeps its top on the face when its depth changes.
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
const cv = await (await page.$('#viewport canvas')).boundingBox();
const scr = (p) => app((p) => { const vp = window.DraftOtter.vp; vp.render(); return vp.project(vp.camera.position.clone().set(...p)); }, p);
const editorOpen = () => app(() => !!document.querySelector('.sk-actions'));
const editorField = (label) => app((label) => { const f = [...document.querySelectorAll('.sk-field')].find((x) => x.textContent.includes(label) && x.style.display !== 'none'); return f ? f.querySelector('input').value : null; }, label);
const editorBtn = (label) => app((label) => [...document.querySelectorAll('.sk-actions button')].find((b) => b.textContent.trim() === label).click(), label);
const info = () => app(() => { const a = window.DraftOtter, g = a.model.nodes[0], p = g.children.find((c) => c.type === 'sketch'); const b = a.worldBox(g); return { vol: +a.engine.stats([g]).volume.toFixed(2), top: +b.max.z.toFixed(4), h: p.params.height, z: p.pos[2] }; });

// a 40 × 30 × 10 block with a 10 × 10 pocket, 3 deep, sketched on its top face (as "Sketch on face" makes it)
await app(() => {
	localStorage.clear(); const a = window.DraftOtter; a.model.doc.nodes = [];
	a.addShape('box'); a.addShape('box');
	const [b, p] = a.model.nodes; b.params.w = 40; b.params.d = 30; b.params.h = 10; b.pos = [0, 0, 5];
	p.type = 'sketch'; p.name = 'Pocket'; p.hole = true;
	p.params = { v: 2, points: [[-5, -5], [5, -5], [5, 5], [-5, 5]], segs: [{ a: 0, b: 1 }, { a: 1, b: 2 }, { a: 2, b: 3 }, { a: 3, b: 0 }], circles: [], cons: [], radii: {}, height: 3, mode: 'extrude', anchored: true, face: { cut: true, overlap: 0 } };
	p.pos = [0, 0, 7]; a.commit();
	a.setSelection([b.id, p.id]); a.group(); a.model.nodes[0].name = 'Block'; a.setSelection([]); a.vp.setView('iso'); a.frame();
});
await wait(600);
let r = await info();
check('the pocket cuts 10 × 10 × 3', Math.abs(r.vol - (12000 - 300)) < 0.01, JSON.stringify(r));

// double-click the pocket (inside the group) → its sketch opens, showing the pocket depth
const s = await scr([0, 0, 10]);
await page.mouse.click(cv.x + s.x, cv.y + s.y, { count: 2 });
await wait(400);
check('double-clicking the pocket reopens its sketch', await editorOpen());
const depth = await editorField('Pocket depth');
check('…showing its depth (3 mm, labeled Pocket depth)', depth === '3', String(depth));
await page.screenshot({ path: 'test/shots/380-edit-sketch.png' });
// make it 5 deep and apply
await app(() => { const f = [...document.querySelectorAll('.sk-field')].find((x) => x.textContent.includes('Pocket depth')); const i = f.querySelector('input'); i.value = '5'; i.dispatchEvent(new Event('change')); });
await editorBtn('Apply');
await wait(400);
r = await info();
check('editing the depth: the pocket gets deeper and its top stays on the face', Math.abs(r.vol - (12000 - 500)) < 0.01 && r.h === 5 && Math.abs(r.z - 0) < 1e-9 && r.top === 10 /* moved down 2 mm inside the group */, JSON.stringify(r));
check('one undo takes the edit back', await app(() => { const a = window.DraftOtter; a.undo(); const v = +a.engine.stats([a.model.nodes[0]]).volume.toFixed(2); a.redo(); return v; }) === 11700);

// right-click over the pocket: "Edit sketch “Pocket”…"
await page.mouse.click(cv.x + s.x, cv.y + s.y, { button: 'right' });
await wait(300);
const menu = await app(() => [...document.querySelectorAll('.menu button')].map((b) => b.textContent));
check('right-click offers Edit sketch “Pocket”…', menu.some((t) => t === 'Edit sketch “Pocket”…'), JSON.stringify(menu.slice(0, 3)));
await page.keyboard.press('Escape');
await app(() => document.querySelectorAll('.menu').forEach((m) => m.remove()));

// Properties of the group lists its sketches
await app(() => { const a = window.DraftOtter; a.setSelection([a.model.nodes[0].id]); });
await wait(200);
const btns = await app(() => [...document.querySelectorAll('#props .sec')].filter((sec) => /Sketch/.test(sec.querySelector('.sec-title').textContent)).flatMap((sec) => [...sec.querySelectorAll('button')].map((b) => b.textContent)));
check('the group’s Properties have a button for its sketch', btns.includes('✎ Pocket'), JSON.stringify(btns));
await app(() => [...document.querySelectorAll('#props button')].find((b) => b.textContent === '✎ Pocket').click());
await wait(300);
check('…which reopens it too', await editorOpen());
await editorBtn('Cancel');
await wait(200);
check('Cancel leaves the pocket as it was', (await info()).h === 5 && !(await editorOpen()));

// double-clicking a plain part (no sketch) does not open the sketch editor
await app(() => window.DraftOtter.setSelection([]));
const side = await scr([15, -15, 5]);
await page.mouse.click(cv.x + side.x, cv.y + side.y, { count: 2 });
await wait(300);
check('double-clicking a plain part still just selects it', !(await editorOpen()), '');

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'browser48: all passed');
process.exit(fails ? 1 : 0);
