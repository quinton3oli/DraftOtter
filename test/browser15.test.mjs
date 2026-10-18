// Push / pull faces: drag to thicken, type a negative distance to cut, faces with holes, edit afterwards, variables.
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';
mkdirSync('test/shots', { recursive: true });
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 120000, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1500, height: 900 } });
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
const cv = await (await page.$('#viewport canvas')).boundingBox();
const screen = (x, y, z) => app(([x, y, z]) => { const vp = window.DraftOtter.vp; vp.render(); return vp.project(vp.camera.position.clone().set(x, y, z)); }, [x, y, z]);
const info = () => app(() => { const a = window.DraftOtter; const g = a.model.nodes[0]; const b = a.worldBox(g); return { n: a.model.nodes.length, kids: g.children ? g.children.map((c) => c.type + (c.hole ? '(hole)' : '')).join(',') : g.type, vol: +a.engine.stats([g]).volume.toFixed(2), min: b.min.toArray().map((v) => +v.toFixed(3)), max: b.max.toArray().map((v) => +v.toFixed(3)) }; });
const reset = (src) => app((src) => { localStorage.clear(); const a = window.DraftOtter; a.setTool(null); a.model.doc.nodes = []; a.model.doc.vars = []; a.sel = []; a.commit(); (0, eval)(src)(a); a.setSelection([]); a.frame(); }, src.toString());

// ---------------------------------------------------------------- drag the top face up
await reset((a) => { a.addShape('box'); });
await wait(500);
await page.keyboard.press('u');
let p0 = await screen(2, 3, 20), p1 = await screen(2, 3, 26);
await page.mouse.move(cv.x + p0.x, cv.y + p0.y, { steps: 3 });
await wait(50);
check('hovering a face highlights it', await app(() => window.DraftOtter.vp.pushPull.hoverMesh.visible && window.DraftOtter.vp.canvas.style.cursor === 'pointer'));
await page.mouse.down();
await page.mouse.move(cv.x + p1.x, cv.y + p1.y, { steps: 12 });
const mid = await app(() => ({ d: window.DraftOtter.vp.pushPull.distance, preview: window.DraftOtter.vp.pushPull.preview.visible, label: document.querySelector('.vp-label.angle:not([style*="none"])') && [...document.querySelectorAll('.vp-label.angle')].map((l) => l.textContent).join('|') }));
await shot('100-pushpull-drag');
await page.mouse.up();
await wait(400);
let r = await info();
check('dragging shows a live preview with a snapped distance', mid.preview && Number.isInteger(mid.d) && mid.d >= 4 && mid.d <= 8, JSON.stringify(mid));
check('drag thickens the top face', r.kids === 'box,facex' && Math.abs(r.max[2] - (20 + mid.d)) < 1e-3 && Math.abs(r.vol - (8000 + 400 * mid.d)) < 0.5, JSON.stringify(r));
const d1 = mid.d;

// ---------------------------------------------------------------- click a side face and type a negative distance
p0 = await screen(10, -2, 8);
await page.mouse.move(cv.x + p0.x, cv.y + p0.y, { steps: 3 });
await page.mouse.click(cv.x + p0.x, cv.y + p0.y);
await wait(120);
check('clicking a face focuses the distance box', await app(() => document.activeElement && document.activeElement.closest('#pp-bar') !== null));
await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
await page.keyboard.type('-3');
await page.keyboard.press('Enter');
await wait(400);
r = await info();
check('negative distance cuts the side face in (same feature group)', r.n === 1 && r.kids === 'box,facex,facex(hole)' && Math.abs(r.max[0] - 7) < 1e-3 && Math.abs(r.vol - (8000 + 400 * d1 - 3 * 20 * (20 + d1))) < 0.5 /* side face is now 20 + d1 tall (flush with the boss) */, JSON.stringify(r));
await app(() => { const a = window.DraftOtter; a.setTool(null); a.setSelection([]); a.frame(); });
await wait(500);
await shot('101-pushpull-result');

// edit the distance afterwards in Properties
await app(() => { const a = window.DraftOtter; const f = a.model.nodes[0].children[1]; a.setSelection([f.id]); });
await wait(100);
const inp = await page.$('#props .field input.num');
await inp.click();
await page.keyboard.type('10');
await page.keyboard.press('Enter');
await wait(300);
r = await info();
check('distance editable afterwards (top now +10)', Math.abs(r.max[2] - 30) < 1e-3, JSON.stringify(r.max));
// flip it negative in Properties: becomes a cut automatically
await app(() => { const a = window.DraftOtter; a.model.nodes[0].children[1].params.depth = -5; a.commit(); });
r = await info();
check('making the distance negative turns it into a cut', Math.abs(r.max[2] - 15) < 1e-3 && r.kids === 'box,facex(hole),facex(hole)', JSON.stringify(r));

// ---------------------------------------------------------------- a face with a hole (after a boolean), driven by a variable
await reset((a) => {
	a.model.doc.vars = [{ name: 'boss', expr: '4' }];
	a.addShape('box'); a.addShape('cylinder');
	const [b, c] = a.model.nodes; b.params.w = 40; b.params.d = 40; b.params.h = 10; b.pos = [0, 0, 5]; c.params.r = 6; c.params.h = 20; c.pos = [0, 0, 5]; c.hole = true; a.commit();
	a.setSelection([b.id, c.id]); a.group();
});
await wait(500);
const v0 = (await info()).vol;
await page.keyboard.press('u');
p0 = await screen(14, 14, 10);
await page.mouse.move(cv.x + p0.x, cv.y + p0.y, { steps: 3 });
await page.mouse.click(cv.x + p0.x, cv.y + p0.y);
await wait(120);
const area = await app(() => window.DraftOtter.vp.pushPull.sel && window.DraftOtter.vp.pushPull.sel.region.area);
check('face with a hole is picked as one face (area excludes the hole)', Math.abs(area - (1600 - Math.PI * 36)) < 1, area && area.toFixed(2));
await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
await page.keyboard.type('boss');
await page.keyboard.press('Enter');
await wait(400);
r = await info();
check('push/pull a holed face by a variable keeps the hole through', Math.abs(r.max[2] - 14) < 1e-3 && Math.abs(r.vol - (v0 + 4 * area)) < 1, JSON.stringify(r));
await app(() => { const a = window.DraftOtter; a.model.doc.vars[0].expr = '8'; a.commit(); });
r = await info();
check('changing the variable updates the push/pull', Math.abs(r.max[2] - 18) < 1e-3, JSON.stringify(r.max));
await app(() => { const a = window.DraftOtter; a.setTool(null); a.setSelection([]); a.frame(); });
await wait(500);
await shot('102-pushpull-holed');
console.log('ERRORS:', errors.filter((e) => !/GPU stall|swiftshader|WebGL|GL_|ReadPixels/i.test(e)).join('\n') || 'none');
// a cut on a wall's side face whose outline runs down into the plate under it: the cut starts exactly at the face
// (no margin biting into the plate next to it, which left a 0.02 mm groove that slicers outline)
const flush = await app(() => {
	const a = window.DraftOtter; a.model.doc.nodes = [];
	a.addShape('box'); a.addShape('box');
	const [plate, wall] = a.model.nodes; plate.params.w = 40; plate.params.d = 20; plate.params.h = 4; plate.pos = [0, 0, 2];
	wall.params.w = 4; wall.params.d = 20; wall.params.h = 14; wall.pos = [18, 0, 7];
	a.commit(); a.setSelection([plate.id, wall.id]); a.group();
	const g = a.model.nodes[0];
	g.children.push({ id: 'cutx', type: 'facex', name: 'Push/pull (cut)', params: { loops: [[[2, -10], [14, -10], [14, 10], [2, 10]]], depth: -1, draft: 0 }, pos: [16 - g.pos[0], -g.pos[1], -g.pos[2]], rot: [0, -90, 0], scale: [1, 1, 1], hole: true, color: '#888' });
	a.commit();
	return a.engine.stats([g]).volume;
});
check('a cut flush with a wall face does not groove the plate beside it', Math.abs(flush - (3200 + 4 * 20 * 10 - 1 * 20 * 12)) < 0.05, String(flush));
const tilted = await app(() => { const a = window.DraftOtter; const g = a.model.nodes[0]; const out = []; for (const deg of [30, 37]) { g.rot = [0, 0, deg]; a.commit(); const b = a.worldBox(g); out.push({ v: a.engine.stats([g]).volume, h: b.max.z - b.min.z }); } return out; });
check('…also on a turned part (no leftover skin)', tilted.every((t) => Math.abs(t.v - 3760) < 0.05 && Math.abs(t.h - 14) < 1e-3), JSON.stringify(tilted));

await browser.close();
process.exit(fails ? 1 : 0);
