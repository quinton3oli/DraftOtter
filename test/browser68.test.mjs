// Phone layout: one column (toolbar on one row, tabs, the 3D view, a sheet), no sideways scroll, the bottom bar
// switches the sheet between Shapes · Objects and Properties or hides it, and the desktop layout is unchanged.
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 240000, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(ok ? 'ok  ' : 'FAIL', name, info); };
await page.emulate({ viewport: { width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
await page.goto(pathToFileURL('DraftOtter.html').href);
await page.waitForFunction(() => document.body.classList.contains('ready'));
await wait(500);
const lay = () => page.evaluate(() => {
	const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return b.width && b.height ? { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } : null; };
	return { sw: document.documentElement.scrollWidth, top: r('#topbar'), vp: r('#viewport'), left: r('#left'), right: r('#right'), nav: r('#mnav'), tabs: r('#tabbar') };
});
let L = await lay();
check('no sideways scroll on a phone', L.sw === 390, L.sw);
check('the toolbar stays one row', L.top && L.top.h < 60, JSON.stringify(L.top));
check('the 3D view is full width, above the Shapes sheet, with the bar at the bottom', L.vp.w === 390 && L.left && L.left.y >= L.vp.y + L.vp.h - 1 && !L.right && L.nav && L.nav.y + L.nav.h === 844, JSON.stringify(L));
await page.tap('.lib-item');
await wait(500);
await page.tap('#mnav button[data-sheet=right]');
await wait(300);
L = await lay();
const dims = await page.evaluate(() => !!document.querySelector('#props .sec-title') && document.querySelector('#props').textContent.includes('Width'));
check('Properties replaces Shapes in the sheet and shows the part’s dimensions', L.right && !L.left && dims, JSON.stringify(L));
const h0 = L.vp.h;
await page.tap('#mnav button[data-sheet=""]');
await wait(400);
L = await lay();
const cv = await page.evaluate(() => Math.round(window.DraftOtter.vp.renderer.domElement.getBoundingClientRect().height));
check('View only hides the sheet and the 3D view (and its canvas) grows', !L.left && !L.right && L.vp.h > h0 + 200 && Math.abs(cv - L.vp.h) <= 1, `${h0} → ${L.vp.h} (canvas ${cv})`);
// desktop: unchanged three columns, no bottom bar
await page.emulate({ viewport: { width: 1500, height: 900 }, userAgent: '' });
await wait(500);
L = await lay();
check('desktop keeps the side panels and has no bottom bar', L.left && L.right && !L.nav && L.left.x === 0 && L.right.x + L.right.w === 1500, JSON.stringify(L));
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'browser68: all passed');
process.exit(fails ? 1 : 0);
