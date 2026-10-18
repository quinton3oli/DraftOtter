// Handles: directional snapped scaling, rotate rings, editable dimension labels, Ctrl+arrow Z nudge.
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';
mkdirSync('test/shots', { recursive: true });
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
const cv = await (await page.$('#viewport canvas')).boundingBox();
const bbox = () => app(() => { const a = window.DraftOtter; const b = a.vp.selectionBox(); return [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z].map((v) => Math.round(v * 1000) / 1000); });

await app(() => { const a = window.DraftOtter; a.addShape('box'); a.frame(); });
await wait(600);
// ---- Scale: drag +X face handle
await page.keyboard.press('r');
await wait(100);
const hp = await app(() => { const a = window.DraftOtter; a.vp.render(); const h = a.vp.handles.scaleHandles.find((m) => m.userData.kind === 'face' && m.userData.axis === 0 && m.userData.side === 1); h.updateWorldMatrix(true, false); return a.vp.project(h.getWorldPosition(h.position.clone())); });
console.log('before scale', JSON.stringify(await bbox()));
await page.mouse.move(cv.x + hp.x, cv.y + hp.y);
await wait(50);
console.log('cursor over handle:', await app(() => window.DraftOtter.vp.canvas.style.cursor));
await page.mouse.down();
await page.mouse.move(cv.x + hp.x + 37, cv.y + hp.y + 3, { steps: 10 });
await shot('30-scaling');
await page.mouse.up();
await wait(200);
console.log('after +X scale', JSON.stringify(await bbox()), 'params', JSON.stringify(await app(() => window.DraftOtter.model.nodes[0].params)), 'scale', JSON.stringify(await app(() => window.DraftOtter.model.nodes[0].scale)));
// ---- Corner handle
const cp = await app(() => { const a = window.DraftOtter; a.vp.render(); const h = a.vp.handles.scaleHandles.find((m) => m.userData.kind === 'corner' && m.userData.sx === 1 && m.userData.sy === -1); return a.vp.project(h.getWorldPosition(h.position.clone())); });
await page.mouse.move(cv.x + cp.x, cv.y + cp.y);
await page.mouse.down();
await page.mouse.move(cv.x + cp.x + 20, cv.y + cp.y + 25, { steps: 10 });
await page.mouse.up();
await wait(200);
console.log('after corner', JSON.stringify(await bbox()), 'params', JSON.stringify(await app(() => window.DraftOtter.model.nodes[0].params)));
// ---- Editable dimension label: set Z to 12.5 by clicking the label
const zl = await page.$('.vp-label.dim-z');
await zl.click();
await wait(100);
console.log('edit input present:', !!(await page.$('.dim-edit')));
await shot('31-dim-edit');
await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
await page.keyboard.type('25/2');
await page.keyboard.press('Enter');
await wait(200);
console.log('after typing Z=25/2', JSON.stringify(await bbox()), 'h param', await app(() => window.DraftOtter.model.nodes[0].params.h));
// ---- Rotate ring drag (Z ring)
await page.keyboard.press('e');
await wait(100);
const ring = await app(() => {
	const a = window.DraftOtter; a.vp.render();
	const H = a.vp.handles; const R = H.ringRadius; const c = H.rotGroup.position;
	const p0 = a.vp.project(c.clone().add({ x: R, y: 0, z: 0, isVector3: true }));
	const pts = []; for (let d = 0; d <= 60; d += 10) { const t = d * Math.PI / 180; pts.push(a.vp.project(c.clone().set(c.x + R * Math.cos(t), c.y + R * Math.sin(t), c.z))); }
	return pts;
});
await page.mouse.move(cv.x + ring[0].x, cv.y + ring[0].y);
await wait(50);
console.log('cursor over ring:', await app(() => window.DraftOtter.vp.canvas.style.cursor));
await page.mouse.down();
for (const p of ring.slice(1)) await page.mouse.move(cv.x + p.x, cv.y + p.y, { steps: 3 });
await shot('32-rotating');
console.log('angle label:', await app(() => document.querySelector('.vp-label.angle').textContent));
await page.mouse.up();
await wait(200);
console.log('rotation after ring drag', JSON.stringify(await app(() => window.DraftOtter.model.nodes[0].rot)));
// ---- Ctrl+Up nudges Z
const z0 = await app(() => window.DraftOtter.model.nodes[0].pos[2]);
await page.keyboard.down('Control'); await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp'); await page.keyboard.up('Control');
await page.keyboard.down('Control'); await page.keyboard.down('Shift'); await page.keyboard.press('ArrowUp'); await page.keyboard.up('Shift'); await page.keyboard.up('Control');
console.log('Z nudge:', z0, '->', await app(() => window.DraftOtter.model.nodes[0].pos[2]));
await page.keyboard.press('w');
await wait(100);
await shot('33-final');
console.log('ERRORS:', errors.filter((e) => !/GPU stall|swiftshader|WebGL|GL_|ReadPixels/i.test(e)).join('\n') || 'none');
await browser.close();
