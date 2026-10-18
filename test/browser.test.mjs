// Headless smoke test: loads DraftOtter.html, exercises core flows, captures errors + screenshots.
// Usage: node test/browser.test.mjs [shotDir]
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
import { mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';

const out = path.resolve(process.argv[2] || 'test/shots');
const dl = path.resolve('test/downloads');
rmSync(dl, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
mkdirSync(dl, { recursive: true });
const exe = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const browser = await puppeteer.launch({
	executablePath: exe,
	headless: 'new',
	protocolTimeout: 60000,
	args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1500,900'],
	defaultViewport: { width: 1500, height: 900 },
});
const page = await browser.newPage();
const cdp = await page.createCDPSession();
await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('dialog', (d) => d.accept());
await page.goto(pathToFileURL('DraftOtter.html').href);
await page.waitForFunction(() => document.body.classList.contains('ready'), { timeout: 30000 });
await page.evaluate(() => { localStorage.clear(); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (n) => page.screenshot({ path: `${out}/${n}.png` });
const app = (fn, ...a) => page.evaluate(fn, ...a);
const key = async (k, mods = []) => {
	for (const m of mods) await page.keyboard.down(m);
	await page.keyboard.press(k);
	for (const m of mods.reverse()) await page.keyboard.up(m);
};
const clickLib = (label) => app((label) => [...document.querySelectorAll('.lib-item')].find((e) => e.textContent.trim() === label).click(), label);

await clickLib('Box');
await wait(200);
// Real mouse drag of the box in the viewport
const cv = await (await page.$('#viewport canvas')).boundingBox();
const boxScreen = await app(() => { const a = window.DraftOtter; return a.vp.project(a.vp.objs.get(a.model.nodes[0].id).position); });
const before = await app(() => window.DraftOtter.model.nodes[0].pos.slice());
await page.mouse.move(cv.x + boxScreen.x, cv.y + boxScreen.y);
await page.mouse.down();
await page.mouse.move(cv.x + boxScreen.x + 60, cv.y + boxScreen.y + 10, { steps: 8 });
await page.mouse.up();
await wait(200);
const after = await app(() => window.DraftOtter.model.nodes[0].pos.slice());
console.log('drag moved box:', JSON.stringify(before), '->', JSON.stringify(after));
// Keyboard: duplicate, nudge, duplicate again (repeat transform)
await key('d', ['Control']);
await page.keyboard.down('Shift');
await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
await page.keyboard.up('Shift');
await key('d', ['Control']);
console.log('duplicate-repeat x positions:', JSON.stringify(await app(() => window.DraftOtter.model.nodes.map((n) => n.pos[0]))));
// Make last a hole, overlap it, select all, group with Ctrl+G
await key('h');
await app(() => { const a = window.DraftOtter; const n = a.model.nodes; n[2].pos[0] = n[1].pos[0] + 10; a.commit(); });
await key('a', ['Control']);
await key('g', ['Control']);
await wait(200);
console.log('after Ctrl+G:', await app(() => window.DraftOtter.model.nodes.map((n) => n.type + (n.children ? '(' + n.children.length + ')' : '')).join(',')));
// Edit nested child param via the properties panel
await app(() => { const a = window.DraftOtter; a.setSelection([a.model.nodes[0].children[0].id]); });
await wait(100);
await shot('10-nested');
const inp = await page.$('#props .field input.num');
await inp.click();
await inp.type('30+5');
await page.keyboard.press('Enter');
await wait(200);
console.log('nested width after typing 30+5:', await app(() => window.DraftOtter.model.nodes[0].children[0].params.w));
// Ungroup then undo
await app(() => { const a = window.DraftOtter; a.setSelection([a.model.nodes[0].id]); });
await key('g', ['Control', 'Shift']);
console.log('after ungroup:', await app(() => window.DraftOtter.model.nodes.map((n) => n.type).join(',')));
await key('z', ['Control']);
console.log('after undo:', await app(() => window.DraftOtter.model.nodes.map((n) => n.type).join(',')));
// Sketch dialog (do not await the promise)
await app(() => { window.DraftOtter.newSketch(); });
await wait(300);
await page.select('.sk-toolbar select', 'Pulley (revolve)');
await wait(200);
await shot('11-sketch');
await app(() => [...document.querySelectorAll('.sk-actions .btn')].find((b) => b.textContent === 'Create').click());
await wait(300);
// Mechanical parts
await clickLib('Gear'); await clickLib('Hex nut'); await clickLib('Spring');
await app(() => { const a = window.DraftOtter; a.setSelection([]); a.frame(); });
await wait(700);
await shot('12-scene');
// Measure tool
await key('m');
await page.mouse.click(cv.x + 300, cv.y + 500);
await page.mouse.click(cv.x + 600, cv.y + 520);
await wait(200);
console.log('measure:', await app(() => document.querySelector('.vp-label.measure').innerText.replace(/\n/g, ' ')));
await shot('13-measure');
await key('Escape');
// Export via the dialog (merged, binary)
await key('e', ['Control']);
await wait(200);
await shot('14-export');
await app(() => [...document.querySelectorAll('.modal-foot .btn')].find((b) => b.textContent === 'Export').click());
await wait(3000);
// Save project (first save opens Save as; use the download fallback here)
await app(() => { window.showSaveFilePicker = undefined; });
await key('s', ['Control']);
await wait(200);
await app(() => [...document.querySelectorAll('.modal-foot .btn')].find((b) => b.textContent === 'Save').click());
await wait(800);
console.log('downloads:', readdirSync(dl));
// Settings and help dialogs
await app(() => window.DraftOtter.settingsDialog()); await wait(150); await shot('15-settings'); await key('Escape');
await app(() => window.DraftOtter.helpDialog()); await wait(150); await shot('16-help'); await key('Escape');
// Reload: autosave restore
await app(() => window.DraftOtter.autosaveNow());
const n1 = await app(() => window.DraftOtter.model.nodes.length);
await page.reload();
await page.waitForFunction(() => document.body.classList.contains('ready'), { timeout: 30000 });
console.log('autosave restore:', n1, '->', await app(() => window.DraftOtter.model.nodes.length));
await wait(300);
await shot('17-restored');
console.log('ERRORS:\n' + (errors.filter((e) => !/GPU stall|swiftshader|WebGL|GL_|maxLeafSize|ReadPixels/i.test(e)).join('\n') || 'none'));
await browser.close();
