// The left and right panels can be dragged wider or narrower; the width is remembered, the 3D view keeps the rest,
// double-click puts the default back, and collapsing still works.
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 240000, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1500, height: 900 } });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const url = pathToFileURL('DraftOtter.html').href;
await page.goto(url);
await page.evaluate(() => localStorage.removeItem('draftotter-panels'));
await page.reload();
await page.waitForFunction(() => document.body.classList.contains('ready'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(ok ? 'ok  ' : 'FAIL', name, info); };
const widths = () => page.evaluate(() => ({ left: Math.round(document.querySelector('#left').getBoundingClientRect().width), right: Math.round(document.querySelector('#right').getBoundingClientRect().width), canvas: Math.round(window.DraftOtter.vp.renderer.domElement.getBoundingClientRect().width) }));
const grip = (side) => page.evaluate((side) => { const r = document.querySelector(`#${side} > .panel-resizer`).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, side);
const drag = async (side, dx) => { const g = await grip(side); await page.mouse.move(g.x, g.y); await page.mouse.down(); await page.mouse.move(g.x + dx / 2, g.y, { steps: 4 }); await page.mouse.move(g.x + dx, g.y, { steps: 4 }); await page.mouse.up(); await wait(300); };

const w0 = await widths();
await drag('left', 150);
const w1 = await widths();
check('dragging the left panel edge makes it wider', Math.abs(w1.left - (w0.left + 150)) <= 3, JSON.stringify([w0, w1]));
check('…and the 3D view gets narrower to make room', Math.abs(w1.canvas - (w0.canvas - 150)) <= 4, JSON.stringify([w0.canvas, w1.canvas]));
await drag('right', -200);
const w2 = await widths();
check('dragging the right panel edge outward makes it wider', Math.abs(w2.right - (w0.right + 200)) <= 3, JSON.stringify(w2));
const tiles = await page.evaluate(() => getComputedStyle(document.querySelector('.lib-grid')).gridTemplateColumns.split(' ').length);
check('a wider shapes panel shows more shapes per row', tiles > 3, tiles + ' columns');

await page.reload();
await page.waitForFunction(() => document.body.classList.contains('ready'));
await wait(300);
const w3 = await widths();
check('the widths are remembered after a reload', Math.abs(w3.left - w1.left) <= 2 && Math.abs(w3.right - w2.right) <= 2, JSON.stringify(w3));

await drag('left', 2000);
const w4 = await widths();
check('a panel cannot be dragged so wide the 3D view disappears', w4.canvas >= 300, JSON.stringify(w4));
await drag('left', -2000);
check('…or narrower than its minimum', (await widths()).left >= 180, JSON.stringify(await widths()));

await page.evaluate(() => window.DraftOtter.togglePanel('right', true));
await wait(200);
check('collapsing still folds the panel to a rail', (await widths()).right <= 32, JSON.stringify(await widths()));
await page.evaluate(() => window.DraftOtter.togglePanel('right', false));
await wait(200);
check('…and expanding brings back the chosen width', Math.abs((await widths()).right - w2.right) <= 2, JSON.stringify(await widths()));

const g = await grip('left');
await page.mouse.click(g.x, g.y);
await wait(80);
await page.mouse.click(g.x, g.y);
await wait(200);
check('double-clicking the edge puts the default width back (two separate clicks)', Math.abs((await widths()).left - w0.left) <= 2, JSON.stringify(await widths()));

check('no page errors', errors.length === 0, errors.join(' | '));
await page.evaluate(() => localStorage.removeItem('draftotter-panels'));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'browser59: all passed');
process.exit(fails ? 1 : 0);
