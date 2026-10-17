// Advanced shape library: search, collapsible sections, background thumbnails, every shape adds cleanly.
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';
mkdirSync('test/shots', { recursive: true });
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 120000, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1500, height: 900 } });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' || /thumbnail failed/.test(m.text())) errors.push(m.text()); });
const t0 = Date.now();
await page.goto(pathToFileURL('LocalCAD.html').href);
await page.waitForFunction(() => document.body.classList.contains('ready'));
const readyMs = Date.now() - t0;
await page.evaluate(() => { localStorage.clear(); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const app = (fn, ...a) => page.evaluate(fn, ...a);
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(ok ? 'ok  ' : 'FAIL', name, info); };
check('app ready quickly (thumbnails load in background)', readyMs < 8000, readyMs + ' ms');
await page.waitForFunction(() => !document.querySelector('#library img.pending'), { timeout: 60000 });
const thumbs = await app(() => { const imgs = [...document.querySelectorAll('#library .lib-item img')]; return { total: imgs.length, filled: imgs.filter((i) => i.src.startsWith('data:image/png') && i.src.length > 1500).length }; });
check('all library thumbnails rendered', thumbs.total >= 60 && thumbs.filled === thumbs.total, JSON.stringify(thumbs));
const sections = await app(() => [...document.querySelectorAll('#library .lib-sec .lib-title span:first-of-type')].map((s) => s.textContent));
console.log('     sections:', sections.join(' | '));
await page.screenshot({ path: 'test/shots/70-library.png' });
// Search
const search = await page.$('.lib-search');
await search.type('bearing');
await wait(100);
const vis = () => app(() => [...document.querySelectorAll('#library .lib-item')].filter((i) => i.style.display !== 'none' && i.offsetParent).map((i) => i.textContent.trim()));
const r1 = await vis();
check('search "bearing" finds the bearing holder', r1.includes('Bearing holder') && r1.length <= 3, JSON.stringify(r1));
await app(() => { const s = document.querySelector('.lib-search'); s.value = ''; s.dispatchEvent(new Event('input')); });
await search.type('pegboard');
await wait(100);
const r2 = await vis();
check('search by keyword "pegboard" finds Grid panel', r2.length === 1 && r2[0] === 'Grid panel', JSON.stringify(r2));
await page.screenshot({ path: 'test/shots/71-search.png' });
await page.keyboard.press('Enter');
await wait(300);
check('Enter adds the top search result', await app(() => window.LocalCAD.model.nodes.some((n) => n.type === 'gridpanel')));
await search.click({ clickCount: 3 });
await page.keyboard.press('Escape');
await wait(100);
check('Escape clears the search', (await vis()).length >= 60);
// Collapse a section
await app(() => [...document.querySelectorAll('#library .lib-title.collapsible')].find((t) => t.textContent.includes('Geometric')).click());
const collapsedHidden = await app(() => { const s = [...document.querySelectorAll('#library .lib-sec')].find((x) => x.textContent.includes('Geometric')); return s.classList.contains('collapsed') && s.querySelector('.lib-grid').offsetParent === null; });
check('sections collapse', collapsedHidden);
await app(() => [...document.querySelectorAll('#library .lib-title.collapsible')].find((t) => t.textContent.includes('Geometric')).click());
// Add every library item and make sure each builds
const keys = await app(() => [...document.querySelectorAll('#library .lib-item')].map((i) => i.querySelector('span').textContent.trim()).filter((t) => !['Import STL', 'Sketch', 'Save selection'].includes(t)));
await app(() => { const a = window.LocalCAD; a.model.doc.nodes = []; a.commit(); });
const bad = [];
for (const label of keys) {
	const ok = await app((label) => {
		const a = window.LocalCAD;
		const n0 = a.model.nodes.length;
		[...document.querySelectorAll('#library .lib-item')].find((i) => i.querySelector('span').textContent.trim() === label).click();
		const n = a.model.nodes[a.model.nodes.length - 1];
		return a.model.nodes.length === n0 + 1 && !!a.engine.geometry(n) && a.worldBox(n).min.z > -1e-3 && a.worldBox(n).min.z < 1e-3;
	}, label);
	if (!ok) bad.push(label);
}
check('every library item adds, builds and sits on the bed', bad.length === 0, bad.length ? 'problems: ' + bad.join(', ') : `${keys.length} items`);
await app(() => { const a = window.LocalCAD; a.setSelection([]); a.frame(); });
await wait(800);
await page.screenshot({ path: 'test/shots/72-all-shapes.png' });
console.log('ERRORS:', errors.filter((e) => !/GPU stall|swiftshader|WebGL|GL_|ReadPixels/i.test(e)).join('\n') || 'none');
await browser.close();
process.exit(fails ? 1 : 0);
