// Pattern along a path: a drawn open path (copies spread from start to end, turning with it), a circle in a sketch
// (evenly round a closed path, the original moved onto it), and "Draw a path…" opening the sketch editor.
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 240000, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1500, height: 900 } });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(pathToFileURL('DraftOtter.html').href);
await page.waitForFunction(() => document.body.classList.contains('ready'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(ok ? 'ok  ' : 'FAIL', name, info); };
const centers = () => page.evaluate(() => { const a = window.DraftOtter; return a.model.nodes.filter((n) => n.type === 'box').map((n) => { const c = a.worldBox(n).getCenter(new (a.worldBox(n).min.constructor)()); return { c: c.toArray().map((v) => +v.toFixed(3)), rz: +n.rot[2].toFixed(3) }; }); });
const create = async (opts) => {
	await page.evaluate((o) => {
		document.querySelector('#ar-n').value = String(o.n);
		if (o.path) document.querySelector('#ar-path').value = o.path;
		document.querySelector('#ar-follow').checked = o.follow;
		document.querySelector('#ar-atobj').checked = o.atobj;
		[...document.querySelectorAll('.modal button')].find((b) => b.textContent === 'Create').click();
	}, opts);
	await wait(300);
};

// a 10 mm cube at the origin; a drawn L-shaped path: 50 mm along X, then 50 mm along Y (100 mm long)
await page.evaluate(() => {
	localStorage.clear();
	const a = window.DraftOtter; a.model.doc.nodes = []; a.addShape('box');
	const b = a.model.nodes[0]; Object.assign(b.params, { w: 10, d: 10, h: 10 }); b.pos = [0, 0, 5]; a.commit();
	a.patternPath = { v: 2, points: [[0, 0], [50, 0], [50, 50]], segs: [{ a: 0, b: 1 }, { a: 1, b: 2 }], circles: [], cons: [], radii: {}, anchored: true };
	a.setSelection([b.id]);
	a.arrayDialog('path');
});
await wait(200);
const shown = await page.evaluate(() => ({ visible: getComputedStyle(document.querySelector('.ar-path')).display !== 'none', opts: [...document.querySelectorAll('#ar-path option')].map((o) => o.textContent) }));
check('the pattern dialog offers "Along a path" with the drawn path (100 mm)', shown.visible && shown.opts[0] === 'Drawn path (100 mm)', JSON.stringify(shown));
await create({ n: 5, path: 'drawn', follow: true, atobj: true });
let cs = await centers();
const want = [[0, 0], [25, 0], [50, 0], [50, 25], [50, 50]];
check('5 copies spread evenly along the path, starting at the cube', cs.length === 5 && cs.every((x, i) => Math.abs(x.c[0] - want[i][0]) < 1e-3 && Math.abs(x.c[1] - want[i][1]) < 1e-3 && Math.abs(x.c[2] - 5) < 1e-3), JSON.stringify(cs));
check('…turning to follow it (the ones after the corner are turned 90°)', cs.map((x) => Math.round(x.rz)).join() === '0,0,0,90,90', JSON.stringify(cs.map((x) => x.rz)));

// a sketch with a 30 mm circle as the path, 6 items, not starting at the object: the cube moves onto the circle
await page.evaluate(() => {
	const a = window.DraftOtter; a.model.doc.nodes = []; a.addShape('box');
	const b = a.model.nodes[0]; Object.assign(b.params, { w: 10, d: 10, h: 10 }); b.pos = [100, 100, 5];
	const sk = { id: 'sk1', seq: 50, type: 'sketch', name: 'Ring path', params: { v: 2, points: [[0, 0]], segs: [], circles: [{ c: 0, r: 30 }], cons: [], radii: {}, height: 2, mode: 'extrude', anchored: true }, pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1], color: '#888888', visible: true, locked: false, hole: false };
	a.model.nodes.push(sk); a.commit();
	a.setSelection([b.id]);
	a.arrayDialog('path');
});
await wait(200);
const opt = await page.evaluate(() => [...document.querySelectorAll('#ar-path option')].map((o) => o.value + '=' + o.textContent));
check('any sketch in the design can be the path', opt.some((o) => /^sk1=Ring path \(188\.\d mm\)/.test(o)), JSON.stringify(opt));
await create({ n: 6, path: 'sk1', follow: false, atobj: false });
cs = await centers();
const r = cs.map((x) => Math.hypot(x.c[0], x.c[1]));
const ang = cs.map((x) => (Math.atan2(x.c[1], x.c[0]) * 180) / Math.PI).map((a) => (a + 360) % 360).sort((p, q) => p - q);
check('6 items go evenly round the circle, the original moved onto it', cs.length === 6 && r.every((v) => Math.abs(v - 30) < 0.2) && ang.every((a, i) => Math.abs(a - 60 * i) < 1), JSON.stringify({ r, ang }));
check('…not turned when "follow" is off', cs.every((x) => Math.abs(x.rz) < 1e-6), JSON.stringify(cs.map((x) => x.rz)));

// Draw a path… opens the sketch editor in path mode
await page.evaluate(() => { const a = window.DraftOtter; a.setSelection([a.model.nodes[0].id]); a.arrayDialog('path'); });
await wait(200);
await page.evaluate(() => document.querySelector('#ar-draw').click());
await wait(400);
const editor = await page.evaluate(() => ({ open: !!document.querySelector('.sk-canvas'), btn: [...document.querySelectorAll('.sk-actions button')].map((b) => b.textContent) }));
check('"Draw a path…" opens the sketch editor with a "Use as path" button', editor.open && editor.btn.includes('Use as path'), JSON.stringify(editor));
await page.evaluate(() => [...document.querySelectorAll('.sk-actions button')].find((b) => b.textContent === 'Cancel').click());
await wait(300);
check('…and cancelling comes back to the pattern dialog', await page.evaluate(() => !!document.querySelector('#ar-path') && getComputedStyle(document.querySelector('.ar-path')).display !== 'none'));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'browser62: all passed');
process.exit(fails ? 1 : 0);
