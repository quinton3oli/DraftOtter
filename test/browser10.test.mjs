// Right-click never shows the browser's context menu (except in text fields); the app's own menus still work.
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1500, height: 900 } });
const page = await browser.newPage();
await page.goto(pathToFileURL('DraftOtter.html').href);
await page.waitForFunction(() => document.body.classList.contains('ready'));
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(ok ? 'ok  ' : 'FAIL', name, info); };
await page.evaluate(() => { localStorage.clear(); const a = window.DraftOtter; a.addShape('box'); a.setSelection([a.model.nodes[0].id]); });
// Fire a real contextmenu event at each element and see whether the browser default was canceled.
const blocked = await page.evaluate(() => {
	const targets = {
		canvas: '#viewport canvas', dimLabel: '.vp-label.dim', toolbar: '#toolbar .tb', library: '.lib-item', tree: '.tree-row',
		properties: '#props .sec-title', status: '#status', viewTools: '#vp-tools .vt', searchBox: '.lib-search', numberField: '#props input.num',
	};
	const out = {};
	for (const [k, sel] of Object.entries(targets)) {
		const el = document.querySelector(sel);
		if (!el) { out[k] = 'missing'; continue; }
		const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
		el.dispatchEvent(ev);
		out[k] = ev.defaultPrevented;
		document.querySelectorAll('.menu').forEach((m) => m.remove());
	}
	return out;
});
for (const k of ['canvas', 'dimLabel', 'toolbar', 'library', 'tree', 'properties', 'status', 'viewTools']) check(`browser menu blocked on ${k}`, blocked[k] === true, String(blocked[k]));
for (const k of ['searchBox', 'numberField']) check(`browser menu still allowed in ${k} (copy/paste)`, blocked[k] === false, String(blocked[k]));
// App menus still open: tree row and object in the viewport
await page.click('.tree-row', { button: 'right' });
check('object list right-click menu opens', !!(await page.$('.menu')));
await page.mouse.click(5, 5);
const cv = await (await page.$('#viewport canvas')).boundingBox();
const p = await page.evaluate(() => { const a = window.DraftOtter; const o = a.vp.objs.get(a.model.nodes[0].id); a.vp.render(); return a.vp.project(o.position); });
await page.mouse.click(cv.x + p.x + 20, cv.y + p.y, { button: 'right' });
await new Promise((r) => setTimeout(r, 100));
check('viewport object right-click menu opens', !!(await page.$('.menu')));
await browser.close();
process.exit(fails ? 1 : 0);
