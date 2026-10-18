// Second browser pass: pattern, mirror, place-on-face, STL import, view cube, ortho.
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 60000, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1500, height: 900 } });
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
await page.goto(pathToFileURL('DraftOtter.html').href);
await page.waitForFunction(() => document.body.classList.contains('ready'));
await page.evaluate(() => localStorage.clear());
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const app = (fn, ...a) => page.evaluate(fn, ...a);
const shot = (n) => page.screenshot({ path: `test/shots/${n}.png` });

// Circular pattern of a cylinder around origin, grouped
await app(() => { const a = window.DraftOtter; a.addShape('cylinder'); const n = a.model.nodes[0]; n.params.r = 4; n.pos = [30, 0, 10]; a.commit(); a.setSelection([n.id]); a.arrayDialog(); });
await wait(200);
await page.evaluate(() => document.querySelector('input[name=ar-type][value=circular]').nextElementSibling.click());
await page.evaluate(() => { document.querySelector('#ar-n').value = 8; document.querySelector('#ar-cx').value = 0; document.querySelector('#ar-cy').value = 0; document.querySelector('#ar-group').checked = true; });
await shot('20-pattern-dialog');
await app(() => [...document.querySelectorAll('.modal-foot .btn')].find((b) => b.textContent === 'Create').click());
await wait(400);
console.log('pattern ->', await app(() => { const a = window.DraftOtter; const g = a.model.nodes[0]; return g.type + ' with ' + g.children.length + ' children; child angles ' + g.children.map((c) => Math.round(Math.atan2(c.pos[1] + g.pos[1], c.pos[0] + g.pos[0]) * 180 / Math.PI)).join(','); }));
// Mirror a wedge in X
await app(() => { const a = window.DraftOtter; a.setSelection([]); a.addShape('wedge'); });
const w0 = await app(() => { const a = window.DraftOtter; return a.engine.stats([a.model.nodes[1]]).volume; });
await app(() => window.DraftOtter.mirror('x'));
const w1 = await app(() => { const a = window.DraftOtter; const n = a.model.nodes[1]; return { scale: n.scale, vol: a.engine.stats([n]).volume }; });
console.log('mirror wedge: volume', w0.toFixed(1), '->', w1.vol.toFixed(1), 'scale', JSON.stringify(w1.scale));
// Place a cone on the top face of the pattern ring (click its top)
await app(() => { const a = window.DraftOtter; a.addShape('cone'); a.setTool('place'); });
const target = await app(() => { const a = window.DraftOtter; const g = a.model.nodes[0]; const b = a.vp.selectionBox([g.id]); const c = b.getCenter(b.min.clone()); c.x = 30 + g.pos[0] * 0; c.y = 0; c.z = b.max.z; const p = a.vp.project(c); return { x: p.x, y: p.y, top: b.max.z }; });
const cv = await (await page.$('#viewport canvas')).boundingBox();
await page.mouse.click(cv.x + target.x, cv.y + target.y);
await wait(300);
console.log('place on face -> cone bottom z', await app(() => { const a = window.DraftOtter; const b = a.vp.selectionBox([a.model.nodes[2].id]); return b.min.z.toFixed(2); }), 'expected', target.top.toFixed(2));
// STL import via file chooser (uses the earlier export)
await app(() => window.DraftOtter.setSelection([]));
const [chooser] = await Promise.all([page.waitForFileChooser(), app(() => { window.DraftOtter.importSTL(); })]);
await chooser.accept([path.resolve('test/downloads/Untitled.stl')]);
await wait(1500);
console.log('import ->', await app(() => { const a = window.DraftOtter; const n = a.model.nodes[a.model.nodes.length - 1]; return n.type + ' "' + n.name + '" tris ' + a.engine.geometry(n).attributes.position.count / 3; }));
// Boolean with imported mesh: subtract a box hole from it
await app(() => { const a = window.DraftOtter; const m = a.model.nodes[a.model.nodes.length - 1]; const h = { ...a.model.nodes[0] }; a.addShape('holeBox'); const hole = a.model.nodes[a.model.nodes.length - 1]; hole.pos = m.pos.slice(); a.commit(); a.setSelection([m.id, hole.id]); a.group(); });
await wait(500);
console.log('mesh boolean ->', await app(() => { const a = window.DraftOtter; const g = a.model.nodes[a.model.nodes.length - 1]; const geo = a.engine.geometry(g); return g.type + ' tris ' + (geo ? geo.attributes.position.count / 3 : 0) + ' errors ' + a.engine.errors.size; }));
// View cube: click its center (front-ish face), then ortho
await app(() => window.DraftOtter.frame());
await wait(500);
await page.mouse.click(cv.x + cv.width - 8 - 50, cv.y + 8 + 50);
await wait(500);
await page.keyboard.press('o');
await wait(300);
await shot('21-ortho-viewcube');
console.log('ortho:', await app(() => !!window.DraftOtter.vp.camera.isOrthographicCamera));
await page.keyboard.press('0');
await wait(400);
await shot('22-iso');
console.log('ERRORS:', errors.filter((e) => !/GPU stall|swiftshader|WebGL|GL_|ReadPixels/i.test(e)).join('\n') || 'none');
await browser.close();
