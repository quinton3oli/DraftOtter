// Save / Save as: File System Access path (stubbed picker), saved-state indicator, and the download fallback.
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
import { mkdirSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
const dl = path.resolve('test/downloads-saveas');
rmSync(dl, { recursive: true, force: true });
mkdirSync(dl, { recursive: true });
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1500, height: 900 } });
const page = await browser.newPage();
const cdp = await page.createCDPSession();
await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => d.accept());
await page.goto(pathToFileURL('DraftOtter.html').href);
await page.waitForFunction(() => document.body.classList.contains('ready'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const app = (fn, ...a) => page.evaluate(fn, ...a);
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(ok ? 'ok  ' : 'FAIL', name, info); };
const key = async (k, mods = []) => { for (const m of mods) await page.keyboard.down(m); await page.keyboard.press(k); for (const m of [...mods].reverse()) await page.keyboard.up(m); await wait(150); };
const state = () => app(() => ({ text: document.querySelector('#save-state').textContent, title: document.title, name: window.DraftOtter.model.doc.name }));

// Fake File System Access API: records pickers shown and what was written to each "file".
await app(() => {
	localStorage.clear();
	window.__fs = { pickers: 0, files: {}, next: 'Bracket v1.lcad.json' };
	const handle = (name) => ({
		name, kind: 'file',
		queryPermission: async () => 'granted', requestPermission: async () => 'granted',
		createWritable: async () => { let buf = ''; return { write: async (d) => { buf += d; }, close: async () => { window.__fs.files[name] = buf; } }; },
	});
	window.showSaveFilePicker = async (opts) => { window.__fs.pickers++; window.__fs.suggested = opts.suggestedName; if (window.__fs.cancel) { const e = new Error('cancel'); e.name = 'AbortError'; throw e; } return handle(window.__fs.next); };
	const a = window.DraftOtter;
	a.model.doc.nodes = []; a.savedSig = null; a.fileHandle = null; a.commit();
	a.addShape('box');
	document.activeElement.blur();
});
let s = await state();
check('new design shows "Not saved yet"', s.text === 'Not saved yet' && s.title.startsWith('•'), JSON.stringify(s));

// Ctrl+S with no file yet -> acts as Save as (picker), design takes the file's name
await key('s', ['Control']);
s = await state();
let fsState = await app(() => ({ ...window.__fs, files: Object.keys(window.__fs.files) }));
check('first Ctrl+S opens the save dialog and writes the file', fsState.pickers === 1 && fsState.files.includes('Bracket v1.lcad.json'), JSON.stringify(fsState));
check('design is renamed to the chosen file name; shows Saved', s.name === 'Bracket v1' && s.text === 'Saved' && !s.title.startsWith('•'), JSON.stringify(s));

// Edit -> unsaved; Ctrl+S writes to the same file without asking again
await app(() => { const a = window.DraftOtter; a.addShape('cylinder'); document.activeElement.blur(); });
s = await state();
check('editing shows "Unsaved changes"', s.text === 'Unsaved changes' && s.title.startsWith('•'), JSON.stringify(s));
await key('s', ['Control']);
fsState = await app(() => ({ pickers: window.__fs.pickers, nodes: JSON.parse(window.__fs.files['Bracket v1.lcad.json']).doc.nodes.length }));
check('Ctrl+S saves silently to the same file', fsState.pickers === 1 && fsState.nodes === 2, JSON.stringify(fsState));
check('state back to Saved', (await state()).text === 'Saved');

// Save as -> new file, new name; original file untouched afterwards
await app(() => { window.__fs.next = 'Bracket v2.lcad.json'; });
await key('s', ['Control', 'Shift']);
s = await state();
fsState = await app(() => ({ pickers: window.__fs.pickers, suggested: window.__fs.suggested, files: Object.keys(window.__fs.files) }));
check('Ctrl+Shift+S asks for a new file and saves a copy', fsState.pickers === 2 && fsState.files.includes('Bracket v2.lcad.json') && s.name === 'Bracket v2', JSON.stringify({ fsState, s }));
check('Save as suggests the current name', fsState.suggested === 'Bracket v1.lcad.json', fsState.suggested);
await app(() => { window.DraftOtter.addShape('sphere'); document.activeElement.blur(); });
await key('s', ['Control']);
const counts = await app(() => ({ v1: JSON.parse(window.__fs.files['Bracket v1.lcad.json']).doc.nodes.length, v2: JSON.parse(window.__fs.files['Bracket v2.lcad.json']).doc.nodes.length }));
check('later saves go to the new file only', counts.v1 === 2 && counts.v2 === 3, JSON.stringify(counts));

// Cancelling the dialog changes nothing
await app(() => { window.__fs.cancel = true; });
await key('s', ['Control', 'Shift']);
s = await state();
check('cancelling Save as keeps everything as it was', s.name === 'Bracket v2' && s.text === 'Saved', JSON.stringify(s));

// Toolbar has a Save as button
await app(() => window.DraftOtter.fileMenu(document.querySelector('#toolbar .tb')));
check('File menu has Save as', await app(() => [...document.querySelectorAll('.menu button')].some((b) => b.textContent.startsWith('Save as'))));
await app(() => document.querySelectorAll('.menu').forEach((m) => m.remove()));

// Fallback (no File System Access API): Save as asks for a name and downloads
await app(() => { delete window.showSaveFilePicker; window.showSaveFilePicker = undefined; const a = window.DraftOtter; a.fileHandle = null; });
await app(() => { window.DraftOtter.fileMenu(document.querySelector('#toolbar .tb')); [...document.querySelectorAll('.menu button')].find((b) => b.textContent.startsWith('Save as')).click(); });
await wait(150);
check('fallback shows a file-name dialog', !!(await page.$('#saveas-name')));
await app(() => { document.querySelector('#saveas-name').value = 'Gearbox lid'; });
await app(() => [...document.querySelectorAll('.modal-foot .btn')].find((b) => b.textContent === 'Save').click());
await wait(1200);
const files = readdirSync(dl);
s = await state();
check('fallback downloads <name>.lcad.json and renames the design', files.includes('Gearbox lid.lcad.json') && s.name === 'Gearbox lid' && s.text === 'Saved', JSON.stringify({ files, s }));
const saved = JSON.parse(readFileSync(path.join(dl, 'Gearbox lid.lcad.json'), 'utf8'));
check('downloaded file is a valid DraftOtter design', saved.format === 'draftotter' && saved.doc.nodes.length === 3);

// Saved state survives a reload
await app(() => window.DraftOtter.autosaveNow());
await page.reload();
await page.waitForFunction(() => document.body.classList.contains('ready'));
s = await state();
check('saved state is remembered after reload', s.text === 'Saved' && s.name === 'Gearbox lid', JSON.stringify(s));
console.log('ERRORS:', errors.join('\n') || 'none');
await browser.close();
rmSync(dl, { recursive: true, force: true });
process.exit(fails ? 1 : 0);
