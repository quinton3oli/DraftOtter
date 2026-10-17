// Settings: background color of the 3D view and hiding the print bed (previewed live, Cancel restores, saved).
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';
mkdirSync('test/shots', { recursive: true });
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 240000, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1500, height: 900 } });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(pathToFileURL('LocalCAD.html').href);
await page.waitForFunction(() => document.body.classList.contains('ready'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const app = (fn, ...a) => page.evaluate(fn, ...a);
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(ok ? 'ok  ' : 'FAIL', name, info); };
const state = () => app(() => { const vp = window.QCAD.vp; return { bg: vp.bgColor.toString(16), bedParts: vp.bed.children.length, css: getComputedStyle(vp.container).backgroundColor, saved: { bg: window.QCAD.model.settings.bgColor, bed: window.QCAD.model.settings.showBed } }; });
const modalBtn = (label) => app((label) => [...document.querySelectorAll('.modal .btn')].find((b) => b.textContent.trim() === label).click(), label);

await app(() => { localStorage.clear(); const a = window.QCAD; a.model.doc.nodes = []; a.addShape('box'); a.commit(); a.setSelection([]); });
let s = await state();
check('defaults: dark background and the print bed shown', s.bg === '141a22' && s.bedParts > 3, JSON.stringify(s));

// preview, then Cancel
await app(() => window.QCAD.settingsDialog());
await wait(200);
await app(() => { [...document.querySelectorAll('.modal .swatch')].find((b) => b.title === 'White').click(); const c = document.querySelector('#set-bed'); c.checked = false; c.dispatchEvent(new Event('change')); });
await wait(100);
s = await state();
check('choosing a color and unticking the bed previews right away', s.bg === 'ffffff' && s.bedParts === 0, JSON.stringify(s));
await modalBtn('Cancel');
await wait(150);
s = await state();
check('Cancel puts them back', s.bg === '141a22' && s.bedParts > 3 && s.saved.bg === '#141a22', JSON.stringify(s));

// choose and save
await app(() => window.QCAD.settingsDialog());
await wait(200);
await app(() => { const i = document.querySelector('#set-bg'); i.value = '#e9edf2'; i.dispatchEvent(new Event('input')); const c = document.querySelector('#set-bed'); c.checked = false; c.dispatchEvent(new Event('change')); });
await modalBtn('Save');
await wait(300);
s = await state();
check('Save: light background, no print bed', s.bg === 'e9edf2' && s.bedParts === 0 && s.saved.bg === '#e9edf2' && s.saved.bed === false && /233, 237, 242/.test(s.css), JSON.stringify(s));
await app(() => { window.QCAD.vp.setView('iso'); window.QCAD.frame(); });
await wait(500);
await page.screenshot({ path: 'test/shots/370-light-no-bed.png' });
// kept after reloading
await app(() => window.QCAD.autosaveNow());
await page.reload();
await page.waitForFunction(() => document.body.classList.contains('ready'));
s = await state();
check('kept after reloading', s.bg === 'e9edf2' && s.bedParts === 0, JSON.stringify(s));
// the bed can come back
await app(() => { const a = window.QCAD; a.model.settings.showBed = true; a.vp.buildBed(a.model.settings); });
check('turning the bed back on draws it again', (await state()).bedParts > 3);

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'browser47: all passed');
process.exit(fails ? 1 : 0);
