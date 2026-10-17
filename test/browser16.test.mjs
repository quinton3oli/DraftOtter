// Sketcher v2 (rectangles, circles as holes, arcs, construction) + push/pull on curved faces and with draft.
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';
mkdirSync('test/shots', { recursive: true });
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 120000, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1500, height: 900 } });
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
const reset = (src) => app((src) => { localStorage.clear(); const a = window.LocalCAD; a.setTool(null); a.model.doc.nodes = []; a.model.doc.vars = []; a.sel = []; a.commit(); (0, eval)(src)(a); a.setSelection([]); a.frame(); }, src.toString());
const modalBtn = (label) => app((label) => [...document.querySelectorAll('.modal-back .btn')].find((b) => b.textContent.trim() === label).click(), label);
const dlgPos = async (x, y) => app(([x, y]) => { const d = document.querySelector('.modal-back').__sketch; const r = document.querySelector('.sk-canvas').getBoundingClientRect(); const [sx, sy] = d.toScr([x, y]); return [r.left + sx, r.top + sy]; }, [x, y]);
const clickAt = async (x, y) => { const p = await dlgPos(x, y); await page.mouse.move(p[0], p[1], { steps: 2 }); await page.mouse.click(p[0], p[1]); await wait(30); };
const status = () => app(() => document.querySelector('.sk-status').textContent);

// ---------------------------------------------------------------- plate with a circular hole, drawn with the tools
await reset(() => {});
await app(() => { window.LocalCAD.newSketch(); });
await wait(300);
await app(() => { const s = document.querySelector('.modal-back').__sketch.st; s.points.length = 0; s.segs.length = 0; s.circles.length = 0; s.cons.length = 0; });
await page.keyboard.press('q');
await clickAt(-10, -6); await clickAt(10, 6);
await page.keyboard.press('c');
await clickAt(0, 0); await clickAt(3, 0);
let st = await status();
check('rectangle + circle → 1 solid with 1 hole', st.includes('1 solid') && st.includes('1 hole'), st);
// a construction circle does not change the profile
await app(() => { const cb = [...document.querySelectorAll('.modal-back label.sk-inline input')][0]; cb.checked = true; cb.dispatchEvent(new Event('change')); });
await clickAt(6, 3); await clickAt(7, 3);
await app(() => { const cb = [...document.querySelectorAll('.modal-back label.sk-inline input')][0]; cb.checked = false; cb.dispatchEvent(new Event('change')); });
st = await status();
check('construction circle is not part of the profile', st.includes('1 solid') && st.includes('1 hole'), st);
const counts = await app(() => { const s = document.querySelector('.modal-back').__sketch.st; return { pts: s.points.length, segs: s.segs.length, circles: s.circles.length, cons: s.circles.filter((c) => c.cons).length }; });
check('sketch entities recorded', counts.segs === 4 && counts.circles === 2 && counts.cons === 1, JSON.stringify(counts));
await shot('110-sketch-hole');
await modalBtn('Create');
await wait(400);
let n = await app(() => { const a = window.LocalCAD; const n = a.model.nodes[0]; return { type: n.type, v: n.params.v, h: n.params.height, vol: +a.engine.stats([n]).volume.toFixed(1) }; });
let expect = (20 * 12 - Math.PI * 9) * n.h;
check('plate with hole has the right volume', n.type === 'sketch' && n.v === 2 && Math.abs(n.vol - expect) / expect < 0.005, JSON.stringify(n) + ' expect ' + expect.toFixed(1));

// ---------------------------------------------------------------- D shape: line + arc
await reset(() => {});
await app(() => { window.LocalCAD.newSketch(); });
await wait(300);
await app(() => { const s = document.querySelector('.modal-back').__sketch.st; s.points.length = 0; s.segs.length = 0; s.circles.length = 0; s.cons.length = 0; });
await page.keyboard.press('d');
await clickAt(0, -5); await clickAt(0, 5);
await page.keyboard.press('Escape');
await page.keyboard.press('b');
await clickAt(0, 5); await clickAt(0, -5); await clickAt(-5, 0);
st = await status();
check('line + arc close a loop', st.includes('1 solid') && !st.includes('open'), st);
const bulge = await app(() => document.querySelector('.modal-back').__sketch.st.segs[1].arc);
check('arc stored as a bulge (semicircle ≈ 1)', Math.abs(Math.abs(bulge) - 1) < 0.05, String(bulge));
await shot('111-sketch-arc');
await modalBtn('Create');
await wait(400);
n = await app(() => { const a = window.LocalCAD; const n = a.model.nodes[0]; return { h: n.params.height, vol: +a.engine.stats([n]).volume.toFixed(1) }; });
expect = (Math.PI * 25 / 2) * n.h;
check('half-disc volume', Math.abs(n.vol - expect) / expect < 0.02, JSON.stringify(n) + ' expect ' + expect.toFixed(1));
// editing re-opens with arcs intact
await app(() => { const a = window.LocalCAD; a.editSketch(a.model.nodes[0]); });
await wait(300);
const reopened = await app(() => document.querySelector('.modal-back').__sketch.st.segs.filter((s) => s.arc).length);
check('re-opening the sketch keeps the arc', reopened === 1, String(reopened));
await modalBtn('Cancel');

// ---------------------------------------------------------------- legacy sketch still loads and shells
await reset((a) => { a.addShape('box'); const n = a.model.nodes[0]; n.type = 'sketch'; n.name = 'Sketch'; n.params = { pts: [[0, 0], [20, 0], [20, 10], [0, 10]], height: 10, mode: 'extrude', cons: [], radii: {}, fillet: 0 }; a.commit(); });
await wait(300);
n = await app(() => { const a = window.LocalCAD; return +a.engine.stats([a.model.nodes[0]]).volume.toFixed(1); });
check('legacy polygon sketch still builds', Math.abs(n - 2000) < 0.5, String(n));

// ---------------------------------------------------------------- push/pull a curved face
await reset((a) => { a.addShape('cylinder'); });
await wait(500);
const cyl = await app(() => { const n = window.LocalCAD.model.nodes[0]; return { r: n.params.r, h: n.params.h, pos: n.pos }; });
await page.keyboard.press('u');
const cv = await (await page.$('#viewport canvas')).boundingBox();
const screen = (x, y, z) => app(([x, y, z]) => { const vp = window.LocalCAD.vp; vp.render(); return vp.project(vp.camera.position.clone().set(x, y, z)); }, [x, y, z]);
const side = await app(() => { const vp = window.LocalCAD.vp; return vp.camera.position.toArray(); });
// pick the point on the side of the cylinder facing the camera
const dir = Math.atan2(side[1] - cyl.pos[1], side[0] - cyl.pos[0]);
let p0 = await screen(cyl.pos[0] + cyl.r * Math.cos(dir), cyl.pos[1] + cyl.r * Math.sin(dir), cyl.pos[2]);
await page.mouse.move(cv.x + p0.x, cv.y + p0.y, { steps: 3 });
await page.mouse.click(cv.x + p0.x, cv.y + p0.y);
await wait(150);
const curved = await app(() => { const s = window.LocalCAD.vp.pushPull.sel, r = s && s.region; return !!(r && r.curved); });
check('the side of a cylinder is picked as a curved face', curved);
await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
await page.keyboard.type('2');
await page.keyboard.press('Enter');
await wait(500);
let r = await app(() => { const a = window.LocalCAD; const g = a.model.nodes[0]; return { kids: g.children ? g.children.map((c) => c.type).join(',') : g.type, vol: +a.engine.stats([g]).volume.toFixed(1) }; });
expect = Math.PI * (cyl.r + 2) ** 2 * cyl.h;
check('curved push/pull offsets the surface (thicker cylinder)', r.kids === 'cylinder,faceoff' && Math.abs(r.vol - expect) / expect < 0.01, JSON.stringify(r) + ' expect ' + expect.toFixed(1));
await app(() => { const a = window.LocalCAD; a.setTool(null); a.setSelection([]); a.frame(); });
await wait(300);
await shot('112-pushpull-curved');

// ---------------------------------------------------------------- push/pull with draft
await reset((a) => { a.addShape('box'); });
await wait(500);
await page.keyboard.press('u');
await wait(100);
await app(() => { const d = document.querySelector('#pp-bar input[title^="Draft"]'); d.value = '10'; d.dispatchEvent(new Event('change')); });
p0 = await screen(2, 3, 20);
await page.mouse.move(cv.x + p0.x, cv.y + p0.y, { steps: 3 });
await page.mouse.click(cv.x + p0.x, cv.y + p0.y);
await wait(150);
await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
await page.keyboard.type('5');
await page.keyboard.press('Enter');
await wait(500);
r = await app(() => { const a = window.LocalCAD; const g = a.model.nodes[0]; const f = g.children && g.children[1]; return { draft: f && f.params.draft, vol: +a.engine.stats([g]).volume.toFixed(1) }; });
const t = Math.tan((10 * Math.PI) / 180) * 5, top = 20 - 2 * t;
expect = 8000 + (5 / 3) * (400 + top * top + 20 * top);
check('draft tapers the extrusion (frustum volume)', +r.draft === 10 && Math.abs(r.vol - expect) < 1, JSON.stringify(r) + ' expect ' + expect.toFixed(1));
await app(() => { const a = window.LocalCAD; a.setTool(null); a.setSelection([]); a.frame(); });
await wait(300);
await shot('113-pushpull-draft');

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'browser16: all passed');
process.exit(fails ? 1 : 0);
