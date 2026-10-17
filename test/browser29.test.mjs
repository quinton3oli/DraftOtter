// Fonts (picker, many families, clean solids), collapsible Print info, Shell face picker (custom open faces).
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';
mkdirSync('test/shots', { recursive: true });
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 180000, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1500, height: 900 } });
const page = await browser.newPage();
const errors = [];
// synthetic clicks on the shell preview make OrbitControls try to capture a pointer that does not exist
page.on('pageerror', (e) => { if (!/setPointerCapture/.test(e.message)) errors.push('pageerror: ' + e.message); });
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(pathToFileURL('LocalCAD.html').href);
await page.waitForFunction(() => document.body.classList.contains('ready'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const app = (fn, ...a) => page.evaluate(fn, ...a);
const shot = (n) => page.screenshot({ path: `test/shots/${n}.png` });
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(ok ? 'ok  ' : 'FAIL', name, info); };
const modalBtn = (label) => app((label) => [...document.querySelectorAll('.modal .btn')].find((b) => b.textContent.trim() === label).click(), label);

// ---------------------------------------------------------------- fonts
await app(() => { localStorage.clear(); const a = window.LocalCAD; a.model.doc.nodes = []; a.commit(); a.addShape('text'); const t = a.model.nodes[0]; t.params.text = 'Hello'; a.commit(); a.setSelection([t.id]); });
await wait(300);
check('Properties shows a font button with the current font', await app(() => /Helvetiker/.test(document.querySelector('#props .font-btn').textContent)));
await app(() => document.querySelector('#props .font-btn').click());
await wait(300);
const pk = await app(() => ({ rows: document.querySelectorAll('.font-picker .fp-font').length, sample: document.querySelector('.font-picker .fp-sample').textContent, cats: [...document.querySelectorAll('.font-picker .chip-btn')].map((b) => b.textContent) }));
check('font picker lists 50+ families with the text as the sample', pk.rows >= 50 && pk.sample === 'Hello' && pk.cats.includes('Script'), JSON.stringify(pk));
await wait(400);
await shot('240-font-picker');
await app(() => { const s = document.querySelector('.font-picker input[type=text]'); s.value = 'lobst'; s.dispatchEvent(new Event('input')); });
const filtered = await app(() => [...document.querySelectorAll('.font-picker .fp-font')].map((r) => r.title));
check('search filters the list', filtered.join() === 'Lobster', filtered.join());
await app(() => document.querySelector('.font-picker .fp-font').click());
await wait(600);
const t1 = await app(() => { const a = window.LocalCAD; const t = a.model.nodes[0]; return { font: t.params.font, vol: +a.engine.stats([t]).volume.toFixed(1), btn: document.querySelector('#props .font-btn').textContent }; });
check('choosing Lobster rebuilds the text in that font', t1.font === 'lobster' && t1.vol > 50 && /Lobster/.test(t1.btn), JSON.stringify(t1));
// bold + a font with overlapping strokes, merged with a plate
await app(() => { const a = window.LocalCAD; const t = a.model.nodes[0]; t.params.font = 'roboto-slab:bold'; t.pos = [0, 0, 3]; a.addShape('box'); const b = a.model.nodes[1]; b.params.w = 60; b.params.d = 20; b.params.h = 2; b.pos = [0, 0, 1]; a.commit(); a.setSelection([t.id, b.id]); a.group(); });
await wait(800);
const merged = await app(() => { const a = window.LocalCAD; return { err: [...a.engine.errors].length, vol: +a.engine.stats([a.model.nodes[0]]).volume.toFixed(1) }; });
check('text in any font unions cleanly with a plate', merged.err === 0 && merged.vol > 2400, JSON.stringify(merged));

// ---------------------------------------------------------------- print info collapse
await app(() => document.querySelector('#stats').previousElementSibling.click());
await wait(100);
let st = await app(() => ({ hidden: document.querySelector('#stats').style.display === 'none', saved: localStorage.getItem('localcad-stats-hidden') }));
check('clicking the Print info header hides it (remembered)', st.hidden && st.saved === '1', JSON.stringify(st));
await page.reload();
await page.waitForFunction(() => document.body.classList.contains('ready'));
st = await app(() => document.querySelector('#stats').style.display === 'none');
check('stays hidden after reload', st);
await app(() => document.querySelector('#stats').previousElementSibling.click());
check('clicking again shows it', await app(() => document.querySelector('#stats').style.display === ''));

// ---------------------------------------------------------------- shell with a face picker
// an L-shaped part: 40×20×20 base step + 20×20×20 tower → hollow it and leave the top of the low step open
await app(() => {
	localStorage.clear(); const a = window.LocalCAD; a.model.doc.nodes = []; a.commit();
	a.addShape('box'); a.addShape('box');
	const [lo, hi] = a.model.nodes; lo.params.w = 40; lo.params.d = 20; lo.params.h = 10; lo.pos = [0, 0, 5]; hi.params.w = 20; hi.params.d = 20; hi.params.h = 20; hi.pos = [-10, 0, 10];
	a.commit(); a.setSelection([lo.id, hi.id]); a.group(); a.setSelection([a.model.nodes[0].id]);
	a.shellDialog();
});
await wait(400);
check('shell dialog shows a 3D preview of the part', await app(() => !!document.querySelector('.modal .shell-pick-canvas')));
// click around the preview until one face is open that is not an outer side (the top of the low step)
// project the point using the picker's camera is internal, so click candidates until the status reports 1 open face that is NOT a quick face
const found = await app(async () => {
	const c = document.querySelector('.modal .shell-pick-canvas'), r = c.getBoundingClientRect();
	const quick = () => [...document.querySelectorAll('.modal input[id^=sh-o-]')].filter((i) => i.checked).length;
	for (let y = 0.15; y < 0.95; y += 0.03) for (let x = 0.05; x < 0.95; x += 0.03) {
		const ev = { clientX: r.left + r.width * x, clientY: r.top + r.height * y, bubbles: true };
		c.dispatchEvent(new PointerEvent('pointerdown', ev));
		c.dispatchEvent(new MouseEvent('click', ev));
		const s = document.querySelector('.modal .shell-pick-status').textContent;
		if (/^1 open face/.test(s) && quick() === 0) return { x, y, s };
		// undo whatever got toggled
		c.dispatchEvent(new PointerEvent('pointerdown', ev));
		c.dispatchEvent(new MouseEvent('click', ev));
	}
	return null;
});
check('clicking a face that is not an outer side picks a custom opening', !!found, JSON.stringify(found));
await shot('241-shell-picker');
await app(() => { document.querySelector('#sh-t').value = '2'; });
await modalBtn('Shell');
await wait(800);
const sh = await app(() => { const a = window.LocalCAD; const g = a.model.nodes[0]; return { kids: g.children.map((c) => c.type + (c.hole ? '(hole)' : '')).join(','), vol: +a.engine.stats([g]).volume.toFixed(1), err: [...a.engine.errors].length }; });
// solid 40×20×10 + 20×20×10 = 12000; the shell with the step-top (20×20 face at z=10) open:
check('shell group gets the cavity and the custom opening', /facex\(hole\)/.test(sh.kids) && sh.err === 0, JSON.stringify(sh));
check('opening removes the step top (volume below the closed shell)', sh.vol < 12000 - 6000 && sh.vol > 2500, JSON.stringify(sh));
await app(() => { const a = window.LocalCAD; a.setSelection([]); a.frame(); });
await wait(600);
await shot('242-shell-open-step');

// quick choice still exact for a box
await app(() => { const a = window.LocalCAD; a.model.doc.nodes = []; a.commit(); a.addShape('box'); a.setSelection([a.model.nodes[0].id]); a.shellDialog(); });
await wait(300);
await app(() => { const cb = document.querySelector('#sh-o-top'); cb.checked = true; cb.dispatchEvent(new Event('change')); document.querySelector('#sh-t').value = '2'; });
const stx = await app(() => document.querySelector('.modal .shell-pick-status').textContent);
check('ticking Top highlights it and counts it', /^1 open face/.test(stx), stx);
await modalBtn('Shell');
await wait(400);
const bx = await app(() => +window.LocalCAD.engine.stats([window.LocalCAD.model.nodes[0]]).volume.toFixed(1));
check('box with the top open stays exact', Math.abs(bx - (8000 - 16 * 16 * 18)) < 1, String(bx));

// any shape (a group): exact walls from a true inward offset, and quick Top opens only the outermost top
const lshape = (open) => app((open) => {
	const a = window.LocalCAD; a.model.doc.nodes = []; a.commit();
	a.addShape('box'); a.addShape('box');
	const [lo, hi] = a.model.nodes; lo.params.w = 40; lo.params.d = 20; lo.params.h = 10; lo.pos = [0, 0, 5]; hi.params.w = 20; hi.params.d = 20; hi.params.h = 20; hi.pos = [-10, 0, 10];
	a.commit(); a.setSelection([lo.id, hi.id]); a.group();
	a.shell(a.model.nodes[0], 2, open);
	return { vol: +a.engine.stats([a.model.nodes[0]]).volume.toFixed(1), err: [...a.engine.errors].length };
}, open);
const closed = await lshape([]);
check('closed L-shaped shell has exact 2 mm walls', closed.err === 0 && Math.abs(closed.vol - (12000 - 6016)) < 30, JSON.stringify(closed) + ' expect ≈5984');
const topOpen = await lshape(['+z']);
check('quick Top opens only the tower top (16×16 mm)', topOpen.err === 0 && Math.abs(closed.vol - topOpen.vol - 512) < 8, `${closed.vol} → ${topOpen.vol}`);

// rounded inside corners (dialog), then edited afterwards in Properties
await app(() => { const a = window.LocalCAD; a.model.doc.nodes = []; a.commit(); a.addShape('box'); a.setSelection([a.model.nodes[0].id]); a.shellDialog(); });
await wait(300);
await app(() => { document.querySelector('#sh-t').value = '2'; document.querySelector('#sh-r').value = '3'; });
await modalBtn('Shell');
await wait(800);
const rb = (16 - 6) ** 3 + 2 * 3 * 3 * (10 * 10) + Math.PI * 9 * 30 + (4 / 3) * Math.PI * 27; // 16 mm cube rounded R3
let rv = await app(() => { const a = window.LocalCAD; const g = a.model.nodes[0]; return { vol: +a.engine.stats([g]).volume.toFixed(1), err: [...a.engine.errors].length, shell: g.shell }; });
check('inside corners rounded R3 (cavity is a rounded 16 mm cube)', rv.err === 0 && Math.abs(rv.vol - (8000 - rb)) / (8000 - rb) < 0.01 && rv.shell.r === 3, JSON.stringify(rv) + ' expect ' + (8000 - rb).toFixed(1));
await app(() => window.LocalCAD.setSelection([window.LocalCAD.model.nodes[0].id]));
await wait(200);
const shellFields = await app(() => [...document.querySelectorAll('#props .field .lbl')].map((l) => l.textContent));
check('Properties shows the shell settings', shellFields.includes('Wall thickness') && shellFields.includes('Inside corner radius'), shellFields.join());
await app(() => { const f = [...document.querySelectorAll('#props .field')].find((x) => x.querySelector('.lbl') && x.querySelector('.lbl').textContent === 'Inside corner radius'); const i = f.querySelector('input'); i.value = '0'; i.dispatchEvent(new Event('change')); });
await wait(600);
rv = await app(() => +window.LocalCAD.engine.stats([window.LocalCAD.model.nodes[0]]).volume.toFixed(1));
check('setting the radius to 0 makes sharp inside corners again', Math.abs(rv - 3904) < 1, String(rv));
await app(() => { const f = [...document.querySelectorAll('#props .field')].find((x) => x.querySelector('.lbl') && x.querySelector('.lbl').textContent === 'Wall thickness'); const i = f.querySelector('input'); i.value = '3'; i.dispatchEvent(new Event('change')); });
await wait(600);
rv = await app(() => +window.LocalCAD.engine.stats([window.LocalCAD.model.nodes[0]]).volume.toFixed(1));
check('changing the wall thickness rebuilds the shell', Math.abs(rv - (8000 - 14 ** 3)) < 1, String(rv));
// open top + rounded corners
await app(() => { const a = window.LocalCAD; a.model.doc.nodes = []; a.commit(); a.addShape('box'); a.shell(a.model.nodes[0], 2, ['+z'], [], 4); a.setSelection([]); a.frame(); });
await wait(800);
rv = await app(() => { const a = window.LocalCAD; return { vol: +a.engine.stats([a.model.nodes[0]]).volume.toFixed(1), err: [...a.engine.errors].length, top: +a.worldBox(a.model.nodes[0]).max.z.toFixed(2) }; });
check('open-top cup with R4 inside corners', rv.err === 0 && rv.vol > 3392 + 50 && rv.vol < 3392 + 600 && rv.top === 20, JSON.stringify(rv));
await shot('244-shell-rounded');

// ---------------------------------------------------------------- resizable Objects / Timeline list
const lib0 = await app(() => document.querySelector('#library').getBoundingClientRect().height);
const sp = await app(() => { const r = document.querySelector('.left-split').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
await page.mouse.move(sp.x, sp.y);
await page.mouse.down();
await page.mouse.move(sp.x, sp.y - 200, { steps: 8 });
await page.mouse.up();
await wait(100);
const lib1 = await app(() => ({ lib: document.querySelector('#library').getBoundingClientRect().height, tree: document.querySelector('#tree').getBoundingClientRect().height, saved: localStorage.getItem('localcad-lib-height') }));
check('dragging the divider up gives the list more room', Math.abs(lib0 - 200 - lib1.lib) < 3 && +lib1.saved === Math.round(lib1.lib), JSON.stringify({ lib0, ...lib1 }));
await app(() => document.querySelector('.left-grow').click());
await wait(100);
const lib2 = await app(() => ({ shown: document.querySelector('#library').style.display !== 'none', tree: document.querySelector('#tree').getBoundingClientRect().height }));
check('⇱ expands the list over the whole Shapes area', !lib2.shown && lib2.tree > lib1.tree + 100, JSON.stringify(lib2));
await shot('243-list-expanded');
await page.reload();
await page.waitForFunction(() => document.body.classList.contains('ready'));
await wait(200);
check('the expanded list is remembered after reload', await app(() => document.querySelector('#library').style.display === 'none'));
await app(() => document.querySelector('.left-grow').click());
await wait(100);
check('⇲ brings the Shapes area back', await app(() => document.querySelector('#library').style.display !== 'none' && document.querySelector('#library').getBoundingClientRect().height > 40));
await app(() => localStorage.removeItem('localcad-lib-height'));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'browser29: all passed');
process.exit(fails ? 1 : 0);
