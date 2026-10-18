// Design tabs: new tab, separate designs / undo / views / history per tab, copy and paste between tabs (meshes
// too), tabs coming back after a reload, opening a file into a new or an empty tab, closing, reordering.
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';
mkdirSync('test/shots', { recursive: true });
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 240000, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1500, height: 900 } });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('dialog', (d) => d.accept());
await page.goto(pathToFileURL('DraftOtter.html').href);
await page.waitForFunction(() => document.body.classList.contains('ready'));
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForFunction(() => document.body.classList.contains('ready'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const app = (fn, ...a) => page.evaluate(fn, ...a);
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(ok ? 'ok  ' : 'FAIL', name, info); };
const tabs = () => app(() => [...document.querySelectorAll('#tabbar .tab')].map((t) => (t.classList.contains('active') ? '*' : '') + t.querySelector('.tab-name').textContent + (t.querySelector('.tab-dot') ? '•' : '')));
const design = () => app(() => window.DraftOtter.model.nodes.map((n) => n.type).join(','));
const clickTab = async (i) => { await app((i) => document.querySelectorAll('#tabbar .tab')[i].click(), i); await page.waitForFunction(() => !document.querySelector('#loading.show, #loading:not([hidden]).on'), { timeout: 20000 }).catch(() => null); await wait(400); };

check('one tab to start, plus a + button', (await tabs()).join() === '*Untitled' && await app(() => !!document.querySelector('#tabbar .tab-new')), (await tabs()).join());
await app(() => { const a = window.DraftOtter; a.addShape('box'); a.model.doc.name = 'Bracket'; a.model.snapshot(); a.commit(); a.model.settings.bed = { w: 300, d: 300, h: 300 }; });
check('the tab shows the design name, with a dot for unsaved changes', (await tabs()).join() === '*Bracket•', (await tabs()).join());

// a new tab
await app(() => document.querySelector('#tabbar .tab-new').click());
await wait(600);
check('+ opens an empty design in a new tab', (await tabs()).join() === 'Bracket•,*Untitled' && (await design()) === '', (await tabs()).join());
check('…with the same printer settings', await app(() => window.DraftOtter.model.settings.bed.w === 300));
await app(() => { const a = window.DraftOtter; a.addShape('cylinder'); a.model.doc.name = 'Knob'; a.model.snapshot(); a.commit(); });
await app(() => { const a = window.DraftOtter; a.model.nodes[0].params.r = 7; a.commit(); });
const cam2 = await app(() => { const v = window.DraftOtter.vp; v.camera.position.set(100, -50, 80); v.controls.target.set(5, 5, 5); v.controls.update(); return v.camera.position.toArray().map((x) => +x.toFixed(2)).join(); });
check('each tab has its own design', (await design()) === 'cylinder' && (await tabs()).join() === 'Bracket•,*Knob•');

// back to the first: its design, selection and undo
await clickTab(0);
check('switching back shows the first design', (await design()) === 'box' && (await tabs()).join() === '*Bracket•,Knob•', (await tabs()).join());
check('…with its selection', await app(() => window.DraftOtter.sel.length === 1 && window.DraftOtter.model.get(window.DraftOtter.sel[0]).type === 'box'));
await app(() => { const a = window.DraftOtter; a.model.nodes[0].params.w = 44; a.commit(); a.undo(); });
check('undo works per tab', await app(() => window.DraftOtter.model.nodes[0].params.w === 20));
await clickTab(1);
check('…and the other tab keeps its own undo and view', await app(() => window.DraftOtter.model.nodes[0].params.r === 7 && window.DraftOtter.model.canUndo()) && (await app(() => window.DraftOtter.vp.camera.position.toArray().map((x) => +x.toFixed(2)).join())) === cam2);
await app(() => { const a = window.DraftOtter; a.undo(); });
check('…undo there changes only that design', await app(() => window.DraftOtter.model.nodes[0].params.r !== 7));
await app(() => window.DraftOtter.redo());

// copy and paste between tabs, including a mesh part
await clickTab(0);
await app(async () => {
	const a = window.DraftOtter;
	const pos = new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 0, 0, 0, 10, 10, 0, 0, 0, 0, 0, 0, 10, 0, 0, 0, 10, 10, 0, 0, 0, 10, 0, 0, 0, 10]);
	// a closed tetrahedron as an imported mesh
	const tet = new Float32Array([0, 0, 0, 0, 10, 0, 10, 0, 0, 0, 0, 0, 10, 0, 0, 0, 0, 10, 0, 0, 0, 0, 0, 10, 0, 10, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10]);
	void pos;
	const b64 = btoa(String.fromCharCode(...new Uint8Array(tet.buffer)));
	a.model.blobs.tetra1 = b64;
	const { makeNode } = { makeNode: (t, p, x) => ({ id: 'mesh' + Date.now(), seq: Date.now(), type: t, name: 'Tet', params: p, pos: [40, 0, 5], rot: [0, 0, 0], scale: [1, 1, 1], color: '#aaa', visible: true, locked: false, hole: false, ...x }) };
	a.model.nodes.push(makeNode('mesh', { blob: 'tetra1' }));
	a.commit();
	a.setSelection(a.model.nodes.map((n) => n.id));
	a.copy();
});
await clickTab(1);
await app(() => window.DraftOtter.paste());
await wait(300);
check('copy in one tab, paste in another (a mesh part brings its data along)', (await design()) === 'cylinder,box,mesh' && await app(() => { const a = window.DraftOtter, m = a.model.nodes[2]; return !!a.model.blobs[m.params.blob] && !!a.engine.geometry(m); }), await design());
await page.screenshot({ path: 'test/shots/480-tabs.png' });

// history is per tab
await app(() => window.DraftOtter.histCommit('knob v1'));
await clickTab(0);
check('history (commits, branches) belongs to each tab', await app(() => Object.keys(window.DraftOtter.hist().commits).length === 0));

// tabs come back after a reload; the other tab loads when opened
await app(() => window.DraftOtter.autosaveNow());
await clickTab(1);
await app(() => window.DraftOtter.autosaveNow());
await page.reload();
await page.waitForFunction(() => document.body.classList.contains('ready'));
await wait(300);
check('after a reload, all tabs are back (the active one open)', (await tabs()).join() === 'Bracket•,*Knob•' && (await design()) === 'cylinder,box,mesh', (await tabs()).join() + ' / ' + (await design()));
await clickTab(0);
check('…and the other one opens with its design when clicked', (await design()) === 'box,mesh' && await app(() => window.DraftOtter.model.doc.name === 'Bracket'));
await wait(500);
check('…and the loading screen is gone afterwards', await app(() => { const l = document.querySelector('#loading'); return !l || l.classList.contains('hidden'); }));
await clickTab(1);
check('…history came back too', await app(() => Object.values(window.DraftOtter.hist().commits).some((c) => c.message === 'knob v1')));

// opening a design file: a new tab (this one has a design); an empty tab is reused
const openFile = (name, json) => app(([name, json]) => window.DraftOtter.openProject(new File([json], name, { type: 'application/json' })), [name, json]);
const fileJson = await app(() => { const a = window.DraftOtter; const d = JSON.parse(a.model.serialize()); d.doc.name = 'From file'; d.doc.nodes = d.doc.nodes.slice(0, 1); delete d.doc.history; return JSON.stringify(d); });
await openFile('from-file.lcad.json', fileJson);
await wait(500);
check('opening a file puts it in a new tab', (await tabs()).join() === 'Bracket•,Knob•,*From file' && (await design()) === 'cylinder', (await tabs()).join());
await app(() => document.querySelector('#tabbar .tab-new').click());
await wait(500);
await openFile('again.lcad.json', fileJson);
await wait(500);
check('…but an empty, untouched tab is used instead of opening another', (await tabs()).length === 4 && (await tabs())[3] === '*From file', (await tabs()).join());

// reorder, close (asks when unsaved), close the last
await app(() => window.DraftOtter.moveTab(3, 0));
check('tabs can be reordered', (await tabs())[0] === '*From file', (await tabs()).join());
const keyGone = await app(async () => {
	const a = window.DraftOtter, t = a.tabs.find((x) => x.name === 'Bracket'), key = 'draftotter-autosave-v1' + (t.id === 't0' ? '' : ':' + t.id);
	const had = localStorage.getItem(key) !== null;
	await a.closeTab(a.tabs.indexOf(t));
	return { had, gone: localStorage.getItem(key) === null };
});
check('closing a tab (after confirming unsaved changes) removes it and its autosave', (await tabs()).length === 3 && !(await tabs()).some((t) => /Bracket/.test(t)) && keyGone.had && keyGone.gone, JSON.stringify(keyGone) + ' ' + (await tabs()).join());
await app(async () => { const a = window.DraftOtter; while (a.tabs.length > 1) await a.closeTab(a.tabs.length - 1, true); await a.closeTab(0, true); });
await wait(500);
check('closing the last tab leaves one empty design', (await tabs()).join() === '*Untitled' && (await design()) === '', (await tabs()).join());

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'browser56: all passed');
process.exit(fails ? 1 : 0);
