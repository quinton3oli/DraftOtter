// Renaming objects in the Objects list: double-click, F2, pencil button, right-click menu, nested parts, Escape, undo.
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1500, height: 900 } });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(pathToFileURL('DraftOtter.html').href);
await page.waitForFunction(() => document.body.classList.contains('ready'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const app = (fn, ...a) => page.evaluate(fn, ...a);
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(ok ? 'ok  ' : 'FAIL', name, info); };
await app(() => { localStorage.clear(); const a = window.DraftOtter; a.model.doc.nodes = []; a.addShape('box'); a.addShape('cylinder'); a.addShape('sphere'); a.setSelection([]); });
const names = () => app(() => window.DraftOtter.model.nodes.map((n) => n.name));
const row = (name) => page.evaluateHandle((name) => [...document.querySelectorAll('#tree .tree-row')].find((r) => r.querySelector('.tree-name')?.textContent === name), name);
const typeName = async (text, key = 'Enter') => {
	await page.waitForSelector('#tree .tree-rename');
	await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
	await page.keyboard.type(text);
	await page.keyboard.press(key);
	await wait(100);
};

// 1. Real double-click on a row name (the first click selects and redraws the list)
let r = await row('Box');
await r.asElement().$('.tree-name').then((n) => n.click({ count: 2 }));
await typeName('Base plate');
check('double-click renames', (await names()).includes('Base plate'), JSON.stringify(await names()));
// 2. F2 renames the selection
await app(() => { const a = window.DraftOtter; a.setSelection([a.model.nodes[1].id]); document.activeElement.blur(); });
await page.keyboard.press('F2');
await typeName('Shaft');
check('F2 renames the selected object', (await names())[1] === 'Shaft');
// 3. Pencil button
r = await row('Sphere');
await r.asElement().hover();
await r.asElement().$('.rename').then((b) => b.click());
await typeName('Knob ball');
check('pencil button renames', (await names())[2] === 'Knob ball');
// 4. Escape cancels
await app(() => { const a = window.DraftOtter; a.setSelection([a.model.nodes[2].id]); document.activeElement.blur(); });
await page.keyboard.press('F2');
await typeName('SHOULD NOT SAVE', 'Escape');
check('Escape cancels a rename', (await names())[2] === 'Knob ball');
// 5. Right-click menu > Rename
r = await row('Shaft');
await r.asElement().click({ button: 'right' });
await app(() => [...document.querySelectorAll('.menu button')].find((b) => b.textContent.startsWith('Rename')).click());
await typeName('Drive shaft');
check('right-click > Rename', (await names())[1] === 'Drive shaft');
// 6. Nested part inside a collapsed group
await app(() => { const a = window.DraftOtter; a.setSelection(a.model.nodes.slice(0, 2).map((n) => n.id)); a.group(); a.model.nodes[0].expanded = false; a.setSelection([a.model.nodes[0].children[0].id]); a.model.nodes[0].expanded = false; a.renderTree(); document.activeElement.blur(); });
await page.keyboard.press('F2');
await typeName('Inner part');
check('renames a part inside a collapsed group', await app(() => window.DraftOtter.model.nodes[0].children.some((c) => c.name === 'Inner part')));
// 7. Properties name box stays in sync, and undo reverts the rename
check('Properties panel shows the new name', await app(() => document.querySelector('#props .name-input').value === 'Inner part'));
await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
check('Ctrl+Z undoes a rename', await app(() => !window.DraftOtter.model.nodes[0].children.some((c) => c.name === 'Inner part')));
// 8. Typing in the rename box does not trigger shortcuts (e.g. "d" = drop, "h" = hole)
await app(() => { const a = window.DraftOtter; a.setSelection([a.model.nodes[a.model.nodes.length - 1].id]); document.activeElement.blur(); });
const before = await app(() => JSON.stringify(window.DraftOtter.model.nodes[window.DraftOtter.model.nodes.length - 1]));
await page.keyboard.press('F2');
await typeName('hdwer');
const after = await app(() => { const n = window.DraftOtter.model.nodes[window.DraftOtter.model.nodes.length - 1]; return { name: n.name, hole: n.hole }; });
check('shortcut keys are ignored while typing a name', after.name === 'hdwer' && after.hole === JSON.parse(before).hole, JSON.stringify(after));
console.log('ERRORS:', errors.join('\n') || 'none');
await browser.close();
process.exit(fails ? 1 : 0);
