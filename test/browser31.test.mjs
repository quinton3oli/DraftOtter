// Hole Wizard (click a face, through / blind, standards, types), feature pattern and mirror copy inside a part.
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';
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
const near = (a, b, e) => Math.abs(a - b) <= e;
const modalBtn = (label) => app((label) => [...document.querySelectorAll('.modal .btn')].find((b) => b.textContent.trim() === label).click(), label);
const cv = await (await page.$('#viewport canvas')).boundingBox();
const screen = (x, y, z) => app(([x, y, z]) => { const vp = window.LocalCAD.vp; vp.render(); return vp.project(vp.camera.position.clone().set(x, y, z)); }, [x, y, z]);
const clickAt = async (x, y, z) => { const p = await screen(x, y, z); await page.mouse.move(cv.x + p.x, cv.y + p.y, { steps: 2 }); await wait(60); await page.mouse.click(cv.x + p.x, cv.y + p.y); await wait(300); };
const vol = () => app(() => +window.LocalCAD.engine.stats([window.LocalCAD.model.nodes[0]]).volume.toFixed(2));
const plate = () => app(() => { localStorage.clear(); const a = window.LocalCAD; a.setTool(null); a.model.doc.nodes = []; a.commit(); a.addShape('box'); const b = a.model.nodes[0]; b.params.w = 60; b.params.d = 40; b.params.h = 8; b.pos = [0, 0, 4]; a.commit(); a.setSelection([]); a.vp.setView('top'); a.frame(); });

// ---------------------------------------------------------------- M3 clearance through hole by clicking the top face
await plate();
await wait(900);
await app(() => window.LocalCAD.startHoleWizard());
await wait(100);
const bar = await app(() => document.querySelector('#hw-bar').textContent);
check('Hole Wizard bar shows the callout', /Ø3\.4 thru \(M3 normal fit\)/.test(bar), bar);
await clickAt(10.3, 5.2, 8);
let r = await app(() => { const a = window.LocalCAD; const g = a.model.nodes[0]; const h = g.children && g.children.find((c) => c.type === 'wizhole'); return { kids: g.children ? g.children.map((c) => c.type).join() : g.type, pos: h && h.pos, depth: h && h.params.depth, rot: h && h.rot }; });
check('clicking the face drills a hole at the snapped point, square to the face', r.kids === 'box,wizhole' && near(r.pos[0], 10, 1e-3) && near(r.pos[1], 5, 1e-3) && r.depth > 8 && r.depth < 9, JSON.stringify(r));
let v = await vol();
check('through hole removes Ø3.4 × 8 mm', near(v, 60 * 40 * 8 - Math.PI * 1.7 ** 2 * 8, 0.5), String(v));
await shot('260-hole-wizard');
// a blind M5 counterbore and an ANSI countersink, placed in one session
await app(() => { const a = window.LocalCAD; Object.assign(a.hw, { size: 'M5', type: 'counterbore', thru: false, depth: 6 }); a.showHoleBar(); });
await clickAt(-15, -8, 8);
await app(() => { const a = window.LocalCAD; Object.assign(a.hw, { std: 'ANSI', size: '#8-32', type: 'countersink', thru: true }); a.showHoleBar(); });
await clickAt(-15, 10, 8);
r = await app(() => window.LocalCAD.model.nodes[0].children.filter((c) => c.type === 'wizhole').map((h) => h.params.size + ':' + h.params.type + ':' + h.params.depth));
check('several holes of different standards in one session', r.length === 3 && /M5:counterbore:6(,|$)/.test(r.join()) && /#8-32:countersink/.test(r.join()), r.join());
const callout = await app(() => { const a = window.LocalCAD; const h = a.model.nodes[0].children.find((c) => c.params && c.params.type === 'counterbore'); a.setSelection([h.id]); return document.querySelector('#props .hole-callout').textContent; });
check('Properties shows the hole callout', /Ø5\.5 ↧6, ⌴Ø10 ↧5\.2 \(M5\)/.test(callout), callout);
await app(() => window.LocalCAD.setTool(null));
check('leaving the tool hides the bar and preview', await app(() => document.querySelector('#hw-bar').style.display === 'none' && !window.LocalCAD.vp.holeObj));

// ---------------------------------------------------------------- tapped with modeled threads
await plate();
await wait(500);
await app(() => { const a = window.LocalCAD; a.startHoleWizard(); Object.assign(a.hw, { std: 'ISO', size: 'M8', type: 'tapped', threads: true, thru: true }); a.showHoleBar(); });
await clickAt(0, 0, 8);
r = await app(() => { const a = window.LocalCAD; const g = a.model.nodes[0]; return { vol: +a.engine.stats([g]).volume.toFixed(1), err: [...a.engine.errors].length }; });
check('M8 tapped hole with modeled threads cuts cleanly', r.err === 0 && r.vol < 19200 - Math.PI * 3.4 ** 2 * 8 && r.vol > 19200 - Math.PI * 4.2 ** 2 * 8, JSON.stringify(r));
await app(() => window.LocalCAD.setTool(null));

// ---------------------------------------------------------------- feature pattern + mirror copy
await plate();
await wait(500);
await app(() => { const a = window.LocalCAD; a.startHoleWizard(); Object.assign(a.hw, { std: 'ISO', size: 'M4', type: 'clearance', fit: 'normal', thru: true }); a.showHoleBar(); });
await clickAt(12, 0, 8);
await app(() => window.LocalCAD.setTool(null));
const v1 = await vol();
await app(() => { const a = window.LocalCAD; const h = a.model.nodes[0].children.find((c) => c.type === 'wizhole'); a.setSelection([h.id]); a.arrayDialog(); });
await wait(150);
const center = await app(() => [document.querySelector('#ar-cx').value, document.querySelector('#ar-cy').value]);
check('circular pattern of a feature defaults to its part center', center.join() === '0,0', center.join());
await app(() => { const r = document.querySelector('.modal input[name=ar-type][value=circular]'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); document.querySelector('#ar-n').value = '6'; });
await modalBtn('Create');
await wait(500);
r = await app(() => { const a = window.LocalCAD; const g = a.model.nodes[0]; return { holes: g.children.filter((c) => c.type === 'wizhole').map((h) => [+h.pos[0].toFixed(2), +h.pos[1].toFixed(2)]), n: a.model.nodes.length }; });
const hv = Math.PI * 2.25 ** 2 * 8;
check('pattern puts 6 holes on a circle inside the same part', r.n === 1 && r.holes.length === 6 && r.holes.every(([x, y]) => near(Math.hypot(x, y), 12, 0.01)), JSON.stringify(r));
check('all 6 cut the part', near(await vol(), v1 - 5 * hv, 3), String(await vol()));
// mirror copy of one counterbore across the part's YZ plane
await app(() => { const a = window.LocalCAD; Object.assign(a.hw, { size: 'M3', type: 'counterbore', thru: true }); });
await app(() => window.LocalCAD.startHoleWizard());
await clickAt(22, 14, 8);
await app(() => window.LocalCAD.setTool(null));
const before = await vol();
await app(() => { const a = window.LocalCAD; const g = a.model.nodes[0]; const h = g.children.filter((c) => c.type === 'wizhole').pop(); a.setSelection([h.id]); a.mirrorCopy('x'); });
await wait(400);
r = await app(() => { const a = window.LocalCAD; const hs = a.model.nodes[0].children.filter((c) => c.type === 'wizhole'); const m = hs[hs.length - 1]; const b = a.worldBox(m); return { name: m.name, cx: +((b.min.x + b.max.x) / 2).toFixed(2), cy: +((b.min.y + b.max.y) / 2).toFixed(2), topZ: +b.max.z.toFixed(2) }; });
check('mirror copy lands at −X inside the same part, still opening upward', /mirror/.test(r.name) && near(r.cx, -22, 0.01) && near(r.cy, 14, 0.01) && r.topZ >= 7.99, JSON.stringify(r));
const after = await vol();
check('the mirrored counterbore cuts the part too', after < before - 50, `${before} → ${after}`);
await app(() => { const a = window.LocalCAD; a.setSelection([]); a.vp.setView('iso'); a.frame(); });
await wait(700);
await shot('261-hole-pattern');

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'browser31: all passed');
process.exit(fails ? 1 : 0);
