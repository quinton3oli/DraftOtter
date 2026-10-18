// Mouse mapping: right-drag orbits, middle-drag pans, left-drag on empty box-selects, left-click empty clears.
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 60000, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1500, height: 900 } });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
await page.goto(pathToFileURL('DraftOtter.html').href);
await page.waitForFunction(() => document.body.classList.contains('ready'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const app = (fn, ...a) => page.evaluate(fn, ...a);
await app(() => { localStorage.clear(); const a = window.DraftOtter; a.addShape('box'); a.addShape('sphere'); a.setSelection([]); a.frame(); });
await wait(600);
const cv = await (await page.$('#viewport canvas')).boundingBox();
const cam = () => app(() => { const vp = window.DraftOtter.vp; const p = vp.camera.position, t = vp.controls.target; return { az: Math.atan2(p.y - t.y, p.x - t.x), t: [t.x, t.y, t.z], d: p.distanceTo(t) }; });
const drag = async (button, x0, y0, dx, dy) => {
	await page.mouse.move(x0, y0);
	await page.mouse.down({ button });
	await page.mouse.move(x0 + dx, y0 + dy, { steps: 12 });
	await page.mouse.up({ button });
	// the view eases to a stop (damping): wait until the camera has settled, not a fixed time
	let prev = null;
	for (let i = 0; i < 40; i++) {
		await wait(100);
		const c = await cam();
		if (prev && Math.abs(c.az - prev.az) < 1e-4 && Math.hypot(c.t[0] - prev.t[0], c.t[1] - prev.t[1], c.t[2] - prev.t[2]) < 1e-3 && Math.abs(c.d - prev.d) < 1e-3) break;
		prev = c;
	}
};
let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log(ok ? 'ok  ' : 'FAIL', name, info || ''); };
// Corner of the viewport is empty space
const ex = cv.x + 120, ey = cv.y + cv.height - 120;
let a = await cam();
await drag('right', ex, ey, 150, 0);
let b = await cam();
check('right-drag orbits', Math.abs(b.az - a.az) > 0.2, `azimuth ${a.az.toFixed(2)} -> ${b.az.toFixed(2)}`);
a = b;
await drag('middle', ex, ey, 150, 60);
b = await cam();
const tMove = Math.hypot(b.t[0] - a.t[0], b.t[1] - a.t[1], b.t[2] - a.t[2]);
check('middle-drag pans', tMove > 1 && Math.abs(b.az - a.az) < 0.02, `target moved ${tMove.toFixed(1)} mm, azimuth change ${(b.az - a.az).toFixed(3)}`);
a = b;
await drag('left', ex, ey, 150, 0);
b = await cam();
check('left-drag on empty does not orbit', Math.abs(b.az - a.az) < 1e-3, `azimuth change ${(b.az - a.az).toExponential(2)}`);
// Box select everything: drag a rectangle over the whole viewport area
await app(() => window.DraftOtter.frame());
await wait(500);
await drag('left', cv.x + 30, cv.y + 120, cv.width - 160, cv.height - 160);
check('left-drag box-selects', (await app(() => window.DraftOtter.sel.length)) === 2, `selected ${await app(() => window.DraftOtter.sel.length)}`);
// Click empty clears
await page.mouse.click(ex, ey);
await wait(100);
check('left-click empty clears selection', (await app(() => window.DraftOtter.sel.length)) === 0);
// Left-drag on an object still moves it
const p = await app(() => { const a = window.DraftOtter; const o = a.vp.objs.get(a.model.nodes[0].id); return a.vp.project(o.position); });
const before = await app(() => window.DraftOtter.model.nodes[0].pos.slice());
await drag('left', cv.x + p.x, cv.y + p.y, 60, 0);
const after = await app(() => window.DraftOtter.model.nodes[0].pos.slice());
check('left-drag object moves it', before.join() !== after.join() && after[2] === before[2], `${before} -> ${after}`);
// Right-click (no drag) on object opens the context menu
await page.mouse.click(cv.x + p.x + 30, cv.y + p.y, { button: 'right' });
await wait(150);
check('right-click object opens menu', !!(await page.$('.menu')));
console.log('ERRORS:', errors.join('\n') || 'none');
await browser.close();
process.exit(fails ? 1 : 0);
