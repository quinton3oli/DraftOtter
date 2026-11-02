// Changing an object's level in the Objects tree: drag a row onto another row's top or bottom edge to put it above or
// below that object (at its level), onto a group's middle to put it inside, or onto the empty space below the list to
// take it to the top level. Right-click has "Move out of group" and "Move into group…" too. Objects keep their exact
// place in the world (also into a turned group), a group left empty goes away, a group can't go into itself, and one
// Undo puts everything back.
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 240000, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1400, height: 900 } });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(pathToFileURL('DraftOtter.html').href);
await page.waitForFunction(() => document.body.classList.contains('ready'));
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(ok ? 'ok  ' : 'FAIL', name, info); };
const app = (fn, ...a) => page.evaluate(fn, ...a);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// G (turned 30° about Z, moved) holds A and B; C and D are on their own
await app(() => {
	const a = window.DraftOtter, b = { rot: [0, 0, 0], scale: [1, 1, 1], color: '#e8613a', visible: true, locked: false, hole: false };
	const box = (id, pos) => ({ ...b, id, type: 'box', name: id, params: { w: 10, d: 10, h: 10, radius: 0, edgeType: 'fillet', seg: 4 }, pos });
	a.model.doc.nodes = [{ ...b, id: 'G', type: 'group', name: 'G', mode: 'union', pos: [12.3, -4.56, 5], rot: [0, 0, 30], expanded: true, children: [box('A', [0, 0, 0]), box('B', [7.5, 0, 0])] }, box('C', [40, 0, 5]), box('D', [60, 0, 5])];
	a.sel = []; a.commit();
	window.W = (id) => { const a = window.DraftOtter; return a.worldMatrix(a.model.get(id)).toArray(); };
	window.same = (m1, m2) => m1.every((v, i) => Math.abs(v - m2[i]) < 1e-9);
	window.where = (id) => { const a = window.DraftOtter, p = a.model.parentOf(id); return p ? p.id : 'top'; };
	// a real drag in the list: dragstart on one row, dragover + drop on another at a height within it (0 top … 1 bottom)
	window.drag = (fromId, toId, f) => {
		const rows = () => [...document.querySelectorAll('#tree .tree-row')];
		const src = rows().find((r) => r.dataset.id === fromId);
		const dst = toId ? rows().find((r) => r.dataset.id === toId) : document.querySelector('#tree');
		const dt = new DataTransfer();
		src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
		const b = dst.getBoundingClientRect(), y = toId ? b.top + b.height * f : b.bottom - 3;
		dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: b.left + 20, clientY: y }));
		const shown = toId ? ['drop-above', 'drop-below', 'drop-into'].find((c) => dst.classList.contains(c)) || 'none' : (dst.classList.contains('drop-top') ? 'drop-top' : 'none');
		dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: b.left + 20, clientY: y }));
		src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
		return shown;
	};
});
await wait(300);

// 1. drag B onto the bottom edge of C: out of the group, next to C (top level), same place in the world
let r = await app(() => { const before = W('B'); const shown = drag('B', 'C', 0.9); return { shown, where: where('B'), same: same(before, W('B')), G: where('A'), rot: window.DraftOtter.model.get('B').rot }; });
check('dragging B onto C\'s bottom edge shows a line under C and moves B out of its group, next to C', r.shown === 'drop-below' && r.where === 'top' && r.G === 'G', JSON.stringify(r));
check('…B stays exactly where it was in the world (its 30° turn now its own)', r.same && Math.abs(r.rot[2] - 30) < 1e-9, JSON.stringify(r));
r = await app(() => { const ids = [...document.querySelectorAll('#tree .tree-row')].map((x) => x.dataset.id); return ids; });
check('…and the list shows it right under C', r.indexOf('B') === r.indexOf('C') + 1, JSON.stringify(r));

// 2. drag C onto the middle of G: into the turned group, same place in the world
r = await app(() => { const before = W('C'); const shown = drag('C', 'G', 0.5); return { shown, where: where('C'), same: same(before, W('C')), local: window.DraftOtter.model.get('C').pos }; });
check('dragging C onto the middle of group G outlines G and puts C inside it', r.shown === 'drop-into' && r.where === 'G', JSON.stringify(r));
check('…C keeps its exact place in the world (its position is now given in G\'s turned frame)', r.same, JSON.stringify(r));

// 3. a group can't go into itself or its own contents
r = await app(() => ({ shown: drag('G', 'A', 0.5), where: where('G'), can: window.DraftOtter.canMoveTo(['G'], 'C', 'above') }));
check('a group cannot be dropped on its own contents', r.shown === 'none' && r.where === 'top' && r.can === false, JSON.stringify(r));

// 4. drag A onto the top edge of D: above D at the top level
r = await app(() => { const before = W('A'); const shown = drag('A', 'D', 0.1); const ids = [...document.querySelectorAll('#tree .tree-row')].map((x) => x.dataset.id); return { shown, where: where('A'), same: same(before, W('A')), above: ids.indexOf('A') === ids.indexOf('D') - 1 }; });
check('dragging A onto D\'s top edge puts it just above D, at the top level, in place', r.shown === 'drop-above' && r.where === 'top' && r.same && r.above, JSON.stringify(r));

// 5. right-click: "Move out of group" on C (the last thing in G) — G, now empty, goes away
r = await app(async () => {
	const a = window.DraftOtter;
	a.setSelection(['C']);
	const row = [...document.querySelectorAll('#tree .tree-row')].find((x) => x.dataset.id === 'C');
	const b = row.getBoundingClientRect();
	row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: b.left + 10, clientY: b.top + 5 }));
	await new Promise((res) => setTimeout(res, 100));
	const items = [...document.querySelectorAll('.menu .mi, .ctx-menu .mi, .menu button, .menu div')].map((x) => x.textContent.trim());
	const out = [...document.querySelectorAll('.menu *')].find((x) => x.children.length === 0 && /^Move out of group/.test(x.textContent.trim()));
	const before = W('C');
	(out.closest('button, .mi, [role="menuitem"]') || out).click();
	return { hasInto: items.some((t) => /^Move into group/.test(t)), where: where('C'), same: same(before, W('C')), G: !!a.model.get('G') };
});
check('right-click "Move out of group" takes the last object out, and the empty group goes away', r.where === 'top' && r.same && r.G === false && r.hasInto, JSON.stringify(r));

// 6. "Move into group…": make a group of A and B, then move D into it from the dialog
r = await app(async () => {
	const a = window.DraftOtter;
	a.setSelection(['A', 'B']); a.group('union', 'AB');
	const gid = a.model.nodes.find((n) => n.name === 'AB').id;
	a.setSelection(['D']);
	const before = W('D');
	a.moveIntoGroupDialog();
	await new Promise((res) => setTimeout(res, 100));
	const sel = document.querySelector('#mv-group');
	const options = [...sel.options].map((o) => o.textContent.trim());
	sel.value = gid;
	[...document.querySelectorAll('.modal .btn')].find((x) => x.textContent === 'Move').click();
	return { options, where: where('D') === gid, same: same(before, W('D')) };
});
check('"Move into group…" lists the groups and moves D into the chosen one, in place', r.options.includes('AB') && r.where && r.same, JSON.stringify(r));

// 7. undo, step by step, back to the start
r = await app(async () => {
	const a = window.DraftOtter;
	for (let i = 0; i < 6; i++) a.undo();
	return { G: !!a.model.get('G'), A: where('A'), B: where('B'), C: where('C'), D: where('D'), pos: a.model.get('B').pos };
});
check('Undo puts every move back (A and B in G again, C and D on their own)', r.G && r.A === 'G' && r.B === 'G' && r.C === 'top' && r.D === 'top' && r.pos[0] === 7.5, JSON.stringify(r));

// 8. dragging onto the empty space under the list takes a part out to the top level
r = await app(() => { const before = W('B'); const shown = drag('B', null); return { shown, where: where('B'), same: same(before, W('B')) }; });
check('dropping on the empty space below the list moves it to the top level', r.shown === 'drop-top' && r.where === 'top' && r.same, JSON.stringify(r));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'browser77: all passed');
process.exit(fails ? 1 : 0);
