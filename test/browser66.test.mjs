// A part can be drawn see-through: a switch and an opacity slider under the color. The slider previews live,
// the setting is saved with the design and survives undo, and selecting/deselecting keeps the chosen opacity.
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
const state = () => page.evaluate(() => {
	const app = window.DraftOtter, n = app.model.nodes[app.model.nodes.length - 1], m = app.vp.displays.get(n.id).material;
	const sw = document.querySelector('.op-row .switch input'), sl = document.querySelector('.op-row input[type=range]');
	return { seeThrough: !!n.seeThrough, opacity: n.opacity, transparent: m.transparent, matOpacity: +m.opacity.toFixed(3), depthWrite: m.depthWrite, sw: sw && sw.checked, slDisabled: sl && sl.disabled, label: (document.querySelector('.op-val') || {}).textContent };
});

await page.evaluate(() => { window.DraftOtter.addShape('box'); });
await wait(500);
let s = await state();
check('a solid part shows the See-through switch, off, with the slider disabled', s.sw === false && s.slDisabled === true && s.transparent === false, JSON.stringify(s));

await page.click('.op-row .switch');
await wait(400);
s = await state();
check('turning the switch on draws the part at 50% opacity', s.seeThrough && s.transparent && s.depthWrite === false && s.slDisabled === false, JSON.stringify(s));
await page.evaluate(() => window.DraftOtter.setSelection([]));
await wait(200);
s = await state();
check('…deselected it keeps the chosen opacity', s.matOpacity === 0.5, JSON.stringify(s));
await page.evaluate(() => { const a = window.DraftOtter; a.setSelection([a.model.nodes[a.model.nodes.length - 1].id]); });
await wait(300);

await page.evaluate(() => { const sl = document.querySelector('.op-row input[type=range]'); sl.value = 0.2; sl.dispatchEvent(new Event('input')); });
s = await state();
check('dragging the slider changes the selected part’s opacity live, exactly', s.opacity === 0.2 && s.label === '20%' && s.matOpacity === 0.2, JSON.stringify(s));
await page.evaluate(() => { const sl = document.querySelector('.op-row input[type=range]'); sl.dispatchEvent(new Event('change')); });
await wait(300);
await page.evaluate(() => window.DraftOtter.setSelection([]));
await wait(200);
s = await state();
check('…and a faint part stays faint when deselected', s.matOpacity === 0.2, JSON.stringify(s));

const saved = await page.evaluate(() => { const j = JSON.parse(JSON.stringify(window.DraftOtter.model.nodes)); return j[j.length - 1]; });
check('the setting is saved with the part', saved.seeThrough === true && saved.opacity === 0.2, JSON.stringify(saved));

await page.evaluate(() => { const a = window.DraftOtter; a.setSelection([a.model.nodes[a.model.nodes.length - 1].id]); });
await wait(300);
await page.click('.op-row .switch');
await wait(400);
s = await state();
check('turning the switch off makes it solid again but remembers the level', !s.seeThrough && !s.transparent && s.opacity === 0.2 && s.slDisabled, JSON.stringify(s));
await page.evaluate(() => window.DraftOtter.undo());
await wait(500);
s = await state();
check('undo brings the see-through look back (at the slider level, while selected), and the switch shows it', s.seeThrough && s.transparent && s.matOpacity === 0.2 && s.sw === true && s.slDisabled === false, JSON.stringify(s));

// the right-click menu has See-through next to Hide
const menuClick = (label) => page.evaluate((label) => { const a = window.DraftOtter; a.setSelection([a.model.nodes[a.model.nodes.length - 1].id]); a.contextMenu({ x: 700, y: 400 }); const bs = [...document.querySelectorAll('.menu button')]; const i = bs.findIndex((b) => b.textContent === 'Hide'); const next = bs[i + 1] && bs[i + 1].textContent; const b = bs.find((b) => b.textContent === label); if (b) b.click(); else document.querySelector('.menu').remove(); return next; }, label);
let next = await menuClick('Turn off see-through');
await wait(400);
s = await state();
check('the right-click menu offers "Turn off see-through" right after Hide', next === 'Turn off see-through' && !s.seeThrough && !s.transparent, next + ' ' + JSON.stringify(s));
next = await menuClick('See-through');
await wait(400);
s = await state();
check('…and "See-through" turns it back on at the remembered level', next === 'See-through' && s.seeThrough && s.matOpacity === 0.2 && s.sw === true, next + ' ' + JSON.stringify(s));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'browser66: all passed');
process.exit(fails ? 1 : 0);
