// Arrow keys nudge relative to the camera: check the world direction of each key from several views.
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
await app(() => { localStorage.clear(); window.DraftOtter.addShape('box'); });
const pos = () => app(() => window.DraftOtter.model.nodes[0].pos.slice(0, 2));
const dirOf = async (key) => {
	const a = await pos();
	await page.keyboard.press(key);
	const b = await pos();
	const dx = Math.round(b[0] - a[0]), dy = Math.round(b[1] - a[1]);
	return dx ? (dx > 0 ? '+X' : '-X') : dy ? (dy > 0 ? '+Y' : '-Y') : '0';
};
// Expected: Up moves away from the viewer, Right moves to screen-right.
const expect = {
	front: ['+Y', '-Y', '-X', '+X'], back: ['-Y', '+Y', '+X', '-X'],
	right: ['-X', '+X', '-Y', '+Y'], left: ['+X', '-X', '+Y', '-Y'],
	top: ['+Y', '-Y', '-X', '+X'], iso: ['+Y', '-Y', '-X', '+X'],
};
let fails = 0;
for (const view of Object.keys(expect)) {
	await app((v) => window.DraftOtter.vp.setView(v), view);
	await wait(450);
	await page.mouse.move(5, 300); // keep focus off inputs
	const got = [];
	for (const k of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) got.push(await dirOf(k));
	const ok = got.join() === expect[view].join();
	if (!ok) fails++;
	console.log(ok ? 'ok  ' : 'FAIL', view.padEnd(6), 'up/down/left/right ->', got.join(' '), ok ? '' : '(expected ' + expect[view].join(' ') + ')');
}
// Rotate the camera 30° off the right view: still snaps to an axis
await app(() => { const vp = window.DraftOtter.vp; const t = vp.controls.target; const d = vp.camera.position.distanceTo(t); vp.camera.position.set(t.x + d * Math.cos(-0.5), t.y + d * Math.sin(-0.5), t.z + d * 0.4); vp.controls.update(); });
await wait(100);
console.log('oblique view, Up ->', await dirOf('ArrowUp'));
const z0 = (await app(() => window.DraftOtter.model.nodes[0].pos[2]));
await page.keyboard.down('Control'); await page.keyboard.press('ArrowUp'); await page.keyboard.up('Control');
console.log('Ctrl+Up still raises Z:', z0, '->', await app(() => window.DraftOtter.model.nodes[0].pos[2]));
console.log('ERRORS:', errors.join('\n') || 'none');
await browser.close();
process.exit(fails ? 1 : 0);
