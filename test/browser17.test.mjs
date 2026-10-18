// Collapsible side panels: buttons, rails, Ctrl+[ / Ctrl+], viewport resizes, state remembered after reload.
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
await page.evaluate(() => { localStorage.removeItem('draftotter-panels'); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const app = (fn, ...a) => page.evaluate(fn, ...a);
const shot = (n) => page.screenshot({ path: `test/shots/${n}.png` });
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(ok ? 'ok  ' : 'FAIL', name, info); };
const widths = () => app(() => ({ left: document.querySelector('#left').getBoundingClientRect().width, right: document.querySelector('#right').getBoundingClientRect().width, vp: document.querySelector('#viewport canvas').getBoundingClientRect().width }));

const w0 = await widths();
check('panels start expanded', w0.left > 200 && w0.right > 250, JSON.stringify(w0));
await page.click('#left .panel-toggle');
await wait(300);
const w1 = await widths();
check('left collapse button shrinks the panel to a rail', w1.left <= 31 && await app(() => getComputedStyle(document.querySelector('#library')).display === 'none'), JSON.stringify(w1));
check('viewport grows to fill the space', w1.vp > w0.vp + 180, JSON.stringify(w1));
await page.click('#right .panel-toggle');
await wait(300);
const w2 = await widths();
check('right collapse button shrinks the panel', w2.right <= 31 && w2.vp > w1.vp + 250, JSON.stringify(w2));
await shot('120-panels-collapsed');

await page.reload();
await page.waitForFunction(() => document.body.classList.contains('ready'));
await wait(300);
const w3 = await widths();
check('collapsed state is remembered after reload', w3.left <= 31 && w3.right <= 31, JSON.stringify(w3));

await page.click('#left .panel-rail');
await wait(300);
check('clicking the rail expands the panel again', (await widths()).left > 200);
await page.keyboard.down('Control'); await page.keyboard.press('BracketRight'); await page.keyboard.up('Control');
await wait(300);
check('Ctrl+] expands the right panel', (await widths()).right > 250);
await page.keyboard.down('Control'); await page.keyboard.press('BracketLeft'); await page.keyboard.up('Control');
await wait(300);
check('Ctrl+[ collapses the left panel', (await widths()).left <= 31);
await page.keyboard.down('Control'); await page.keyboard.press('BracketLeft'); await page.keyboard.up('Control');
await wait(300);
check('Ctrl+[ again expands it', (await widths()).left > 200);
await shot('121-panels-expanded');

check('no page errors', errors.length === 0, errors.join(' | '));
await app(() => localStorage.removeItem('draftotter-panels'));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'browser17: all passed');
process.exit(fails ? 1 : 0);
