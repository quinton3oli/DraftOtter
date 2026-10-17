// Align mode: hover preview (and revert), click to apply, anchor object, single object to bed.
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';
mkdirSync('test/shots', { recursive: true });
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 60000, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1500, height: 900 } });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(pathToFileURL('LocalCAD.html').href);
await page.waitForFunction(() => document.body.classList.contains('ready'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const app = (fn, ...a) => page.evaluate(fn, ...a);
const shot = (n) => page.screenshot({ path: `test/shots/${n}.png` });
const cv = await (await page.$('#viewport canvas')).boundingBox();

await app(() => {
	localStorage.clear();
	const a = window.LocalCAD;
	a.addShape('box'); a.addShape('cylinder'); a.addShape('sphere');
	const [b, c, s] = a.model.nodes;
	b.pos = [-30, -20, 10]; c.pos = [5, 10, 15]; c.params.h = 30; s.pos = [35, 25, 10];
	a.commit();
	a.setSelection(a.model.nodes.map((n) => n.id));
	a.frame();
});
await wait(600);
const mins = () => app(() => { const a = window.LocalCAD; return a.model.nodes.map((n) => { const b = a.worldBox(n); return [+b.min.x.toFixed(2), +b.min.y.toFixed(2), +b.min.z.toFixed(2)]; }); });
const dotPos = (axis, where) => app((axis, where) => { const vp = window.LocalCAD.vp; vp.render(); const d = vp.alignTool.dots.find((m) => m.userData.axis === axis && m.userData.where === where); return vp.project(d.position); }, axis, where);

await page.keyboard.press('l');
await wait(200);
console.log('align bar:', await app(() => document.querySelector('#align-bar').innerText.replace(/\n/g, ' | ')));
console.log('start mins', JSON.stringify(await mins()));
// Hover the X-min (left) dot -> preview
let p = await dotPos(0, 0);
await page.mouse.move(cv.x + p.x, cv.y + p.y, { steps: 4 });
await wait(150);
const preview = await app(() => window.LocalCAD.vp.objs.get(window.LocalCAD.model.nodes[2].id).position.x);
console.log('tip:', await app(() => document.querySelector('.align-tip').textContent), '| sphere previewed x =', preview.toFixed(2), '| model unchanged:', JSON.stringify((await mins())[2]));
await shot('50-align-preview');
// Move away -> preview reverts
await page.mouse.move(cv.x + 40, cv.y + cv.height - 40, { steps: 4 });
await wait(100);
console.log('after leaving, sphere obj x =', (await app(() => window.LocalCAD.vp.objs.get(window.LocalCAD.model.nodes[2].id).position.x)).toFixed(2));
// Click the left dot -> applies
p = await dotPos(0, 0);
await page.mouse.move(cv.x + p.x, cv.y + p.y, { steps: 3 });
await page.mouse.click(cv.x + p.x, cv.y + p.y);
await wait(200);
console.log('after click left:', JSON.stringify(await mins()));
// Anchor the cylinder by clicking it, then align tops (Z max)
const cyl = await app(() => { const a = window.LocalCAD; const o = a.vp.objs.get(a.model.nodes[1].id); return a.vp.project(o.getWorldPosition(o.position.clone())); });
await page.mouse.click(cv.x + cyl.x, cv.y + cyl.y);
await wait(150);
console.log('anchor:', await app(() => window.LocalCAD.vp.alignTool.key === window.LocalCAD.model.nodes[1].id), '| bar:', await app(() => document.querySelector('#align-bar .chip')?.textContent));
p = await dotPos(2, 2);
await page.mouse.move(cv.x + p.x, cv.y + p.y, { steps: 3 });
await wait(100);
await shot('51-align-anchor');
await page.mouse.click(cv.x + p.x, cv.y + p.y);
await wait(200);
console.log('tops after anchored Z-max:', JSON.stringify(await app(() => { const a = window.LocalCAD; return a.model.nodes.map((n) => +a.worldBox(n).max.z.toFixed(2)); })));
// Single object -> bed center
await app(() => { const a = window.LocalCAD; a.setSelection([a.model.nodes[2].id]); });
await wait(100);
console.log('single: visible dots', await app(() => window.LocalCAD.vp.alignTool.dots.filter((d) => d.visible).length));
p = await dotPos(1, 1);
await page.mouse.move(cv.x + p.x, cv.y + p.y, { steps: 3 });
await page.mouse.click(cv.x + p.x, cv.y + p.y);
await wait(200);
console.log('sphere centered on bed Y:', await app(() => { const a = window.LocalCAD; const b = a.worldBox(a.model.nodes[2]); return ((b.min.y + b.max.y) / 2).toFixed(3); }));
await page.keyboard.press('Escape');
console.log('align off:', await app(() => !window.LocalCAD.vp.alignTool.active && document.querySelector('#align-bar').style.display === 'none'));
console.log('ERRORS:', errors.filter((e) => !/GPU stall|swiftshader|WebGL|GL_|ReadPixels/i.test(e)).join('\n') || 'none');
await browser.close();
