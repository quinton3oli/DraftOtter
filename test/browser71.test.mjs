// The rename from LocalCAD to DraftOtter keeps everything a browser had saved: settings and autosaves under the old
// "localcad-…" localStorage keys and the old "localcad" IndexedDB (big autosaves, undo, file handles) move to the
// new names on the first start, the design comes back, and the old storage is cleared. Old design files still open.
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

// make a design, then store it the way an old LocalCAD build did: a big autosave in IndexedDB "localcad" with a
// marker in localStorage, plus a small setting and an undo record — and nothing under the new names
await app(async () => {
	const a = window.DraftOtter;
	a.model.doc.nodes = []; a.commit();
	a.addShape('box'); a.model.nodes[0].name = 'Saved before the rename'; a.commit();
	const json = a.model.serialize();
	localStorage.clear();
	localStorage.setItem('localcad-autosave-v1', JSON.stringify({ inIdb: true, time: Date.now() }));
	localStorage.setItem('localcad-panels', JSON.stringify({ leftWidth: 300 }));
	await new Promise((res) => { const d = indexedDB.deleteDatabase('draftotter'); d.onsuccess = d.onerror = d.onblocked = () => res(); });
	await new Promise((res, rej) => {
		const o = indexedDB.open('localcad', 1);
		o.onupgradeneeded = () => o.result.createObjectStore('kv');
		o.onsuccess = () => {
			const t = o.result.transaction('kv', 'readwrite');
			t.objectStore('kv').put(json, 'localcad-autosave-v1');
			t.objectStore('kv').put({ history: [], hIndex: 0, savedAt: 1 }, 'localcad-undo-v1');
			t.oncomplete = () => { o.result.close(); res(); };
			t.onerror = () => rej(t.error);
		};
		o.onerror = () => rej(o.error);
	});
});
await page.reload();
await page.waitForFunction(() => document.body.classList.contains('ready'));
await new Promise((r) => setTimeout(r, 800));
const after = await app(async () => {
	const keys = Object.keys(localStorage);
	const dbs = indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name) : null;
	const kv = await new Promise((res) => {
		const o = indexedDB.open('draftotter');
		o.onsuccess = () => {
			const db = o.result;
			if (!db.objectStoreNames.contains('kv')) { res([]); return; }
			const q = db.transaction('kv').objectStore('kv').getAllKeys();
			q.onsuccess = () => res(q.result);
			q.onerror = () => res([]);
		};
		o.onerror = () => res(null);
	});
	return { name: window.DraftOtter.model.nodes[0] && window.DraftOtter.model.nodes[0].name, keys, dbs, kv };
});
check('the design autosaved by the old version (kept in its IndexedDB) comes back after the rename', after.name === 'Saved before the rename', JSON.stringify(after));
check('settings and autosave markers moved to draftotter-… keys; no localcad-… keys left', after.keys.includes('draftotter-panels') && after.keys.includes('draftotter-autosave-v1') && !after.keys.some((k) => k.startsWith('localcad-')), JSON.stringify(after.keys));
check('the old IndexedDB records moved over under their new names', after.kv && after.kv.includes('draftotter-autosave-v1') && after.kv.includes('draftotter-undo-v1'), JSON.stringify(after.kv));
check('and the old "localcad" database is gone', !after.dbs || !after.dbs.includes('localcad'), JSON.stringify(after.dbs));

// design files saved before the rename still open; new ones are written in the new format
const files = await app(async () => {
	const a = window.DraftOtter;
	await a.openProject(new File([JSON.stringify({ format: 'localcad', version: 1, doc: { ...a.model.emptyDoc(), nodes: [] } })], 'old.lcad.json'));
	return { opened: a.model.nodes.length === 0, format: JSON.parse(a.model.serialize()).format };
});
check('a design file from before the rename opens, and saving writes the new format', files.opened && files.format === 'draftotter', JSON.stringify(files));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'browser71: all passed');
process.exit(fails ? 1 : 0);
