// History & branches in the app: commit, branch, switch, merge (clean and with conflicts), cancel a merge,
// cherry-pick, one part's history, tags, deleting branches, saving, old files, and undo that survives reloading.
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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const app = (fn, ...a) => page.evaluate(fn, ...a);
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(ok ? 'ok  ' : 'FAIL', name, info); };
const chip = () => app(() => { const c = document.querySelector('#branch-chip'); return c && { text: c.textContent, dirty: !!c.querySelector('.bc-dot') }; });
const design = () => app(() => window.DraftOtter.model.nodes.map((n) => `${n.name}:${n.params ? [n.params.w, n.params.h].join('x') : ''}${n.color ? ':' + n.color : ''}`).join(' | '));
const box = () => app(() => { const n = window.DraftOtter.model.nodes.find((x) => x.name === 'Base'); return n && { w: n.params.w, h: n.params.h, color: n.color }; });
const closeModals = () => app(() => document.querySelectorAll('.modal-back').forEach((m) => m.remove()));
const H = () => app(() => { const h = window.DraftOtter.hist(); return { head: h.head, branches: Object.keys(h.branches), commits: Object.keys(h.commits).length, tags: Object.keys(h.tags) }; });

await app(() => { localStorage.clear(); const a = window.DraftOtter; a.model.load(a.model.emptyDoc()); a.afterChange(); });
await app(() => { const a = window.DraftOtter; a.addShape('box'); const n = a.model.nodes[0]; n.name = 'Base'; n.params.w = 20; n.params.h = 10; a.commit(); });
let c = await chip();
check('the top bar shows the branch, with a dot for uncommitted changes', c && /main/.test(c.text) && c.dirty, JSON.stringify(c));

// ---------------------------------------------------------------- commit from the History window
await app(() => window.DraftOtter.historyDialog());
await wait(150);
await app(() => { const m = document.querySelector('#hist-msg'); m.value = 'first box'; [...document.querySelectorAll('.modal .ver-new .btn')].find((b) => b.textContent === 'Commit').click(); });
await wait(150);
check('committing from the History window', (await H()).commits === 1 && !(await chip()).dirty && await app(() => document.querySelector('.hist-row .ver-name').value === 'first box'));
await closeModals();

// ---------------------------------------------------------------- branch, change, switch back
check('new branch takes the current design along', await app(() => window.DraftOtter.newBranch('tall lid')) && (await H()).head === 'tall lid' && /tall lid/.test((await chip()).text));
await app(() => { const a = window.DraftOtter; a.model.nodes[0].params.h = 25; a.commit(); a.histCommit('taller'); });
check('a commit on the branch leaves main alone', await app(() => { const h = window.DraftOtter.hist(); return h.branches.main !== h.branches['tall lid']; }));
await app(() => window.DraftOtter.switchBranch('main'));
await wait(300);
check('switching back to main brings main\'s design back', (await box()).h === 10 && (await H()).head === 'main', JSON.stringify(await box()));
await app(() => { const a = window.DraftOtter; a.model.nodes[0].params.w = 40; a.commit(); });
// switching with uncommitted changes asks first
await app(() => { window.__sw = window.DraftOtter.switchBranch('tall lid'); });
await wait(200);
const asked = await app(() => [...document.querySelectorAll('.modal .btn')].map((b) => b.textContent).join(','));
check('switching with uncommitted changes asks what to do', /Commit and switch/.test(asked) && /Discard changes/.test(asked), asked);
await app(() => [...document.querySelectorAll('.modal .btn')].find((b) => b.textContent === 'Cancel').click());
check('…Cancel stays put', (await H()).head === 'main' && (await box()).w === 40);
await app(() => window.DraftOtter.histCommit('wider'));

// ---------------------------------------------------------------- clean merge
let r = await app(() => window.DraftOtter.mergeBranch('tall lid'));
await wait(300);
let b = await box();
check('merging a branch with changes to other fields: no conflicts', r === 'merged' && b.w === 40 && b.h === 25, JSON.stringify({ r, b }));
check('…and a merge commit with both parents', await app(() => { const h = window.DraftOtter.hist(); return h.commits[h.branches.main].parents.length === 2; }));
check('merging again: nothing new', (await app(() => window.DraftOtter.mergeBranch('tall lid'))) === 'up-to-date');

// ---------------------------------------------------------------- conflict: same field on both branches
await app(async () => { const a = window.DraftOtter; await a.newBranch('red'); a.model.nodes[0].color = '#ff0000'; a.model.nodes[0].params.h = 30; a.commit(); a.histCommit('red and 30'); await a.switchBranch('main'); a.model.nodes[0].params.h = 12; a.commit(); a.histCommit('12 high'); });
await wait(200);
r = await app(() => window.DraftOtter.mergeBranch('red'));
await wait(300);
check('the same field changed on both branches stops for a choice', r === 'conflicts' && await app(() => !!document.querySelector('#merge-panel') && document.querySelectorAll('.merge-row').length === 1));
b = await box();
check('…the rest is merged already, mine kept for the clash', b.h === 12 && b.color === '#ff0000', JSON.stringify(b));
check('…the panel shows both values, with the parameter\'s name', await app(() => /Base: Height Z/.test(document.querySelector('.merge-row').textContent) && /Mine:\s*12/.test(document.querySelector('.merge-row').textContent) && /Theirs:\s*30/.test(document.querySelector('.merge-row').textContent)), await app(() => document.querySelector('.merge-row').textContent));
check('…and the chip shows a merge in progress', await app(() => document.querySelector('#branch-chip').classList.contains('merging')));
await app(() => document.querySelector('.merge-row').click());
await wait(150);
check('clicking a conflict shows their version as a ghost', await app(() => !!window.DraftOtter.compareObj));
await app(() => [...document.querySelectorAll('.merge-row .btn')].find((x) => /Theirs/.test(x.textContent)).click());
await wait(300);
check('choosing theirs updates the design right away', (await box()).h === 30);
await page.screenshot({ path: 'test/shots/451-merge-conflict.png' });
await app(() => [...document.querySelectorAll('#merge-panel .btn')].find((x) => x.textContent === 'Finish merge').click());
await wait(200);
check('finishing commits the merge', await app(() => { const a = window.DraftOtter, h = a.hist(); return !a.merging && !document.querySelector('#merge-panel') && h.commits[h.branches.main].parents.length === 2 && !a.histDirty(); }));

// cancel a merge
await app(async () => { const a = window.DraftOtter; await a.switchBranch('red'); a.model.nodes[0].params.w = 50; a.commit(); a.histCommit('50 wide'); await a.switchBranch('main'); a.model.nodes[0].params.w = 45; a.commit(); a.histCommit('45 wide'); });
await wait(200);
await app(() => window.DraftOtter.mergeBranch('red'));
await wait(300);
await app(() => [...document.querySelectorAll('#merge-panel .btn')].find((x) => x.textContent === 'Cancel merge').click());
await wait(300);
check('Cancel merge puts the design back as it was', (await box()).w === 45 && await app(() => !window.DraftOtter.merging && !window.DraftOtter.histDirty()));

// ---------------------------------------------------------------- cherry-pick
const pick = await app(async () => {
	const a = window.DraftOtter;
	await a.newBranch('extras');
	a.addShape('sphere'); a.model.nodes[a.model.nodes.length - 1].name = 'Ball';
	a.model.nodes[0].color = '#00ff00'; a.commit();
	const c = a.histCommit('ball and green');
	await a.switchBranch('main');
	return { cid: c.id, ball: a.hist().objects[c.tree.nodes[Object.keys(c.tree.nodes).find((id) => a.hist().objects[c.tree.nodes[id]].name === 'Ball')]].id };
});
await wait(200);
await app((cid) => window.DraftOtter.cherryPickDialog(cid), pick.cid);
await wait(150);
check('apply changes lists what the commit changed', await app(() => document.querySelectorAll('.cp-row').length === 2));
await app((id) => { document.querySelectorAll('.cp-row input').forEach((x) => { x.checked = x.dataset.id === id; }); [...document.querySelectorAll('.modal .btn')].find((x) => x.textContent === 'Apply').click(); }, pick.ball);
await wait(400);
check('…and brings only the chosen ones (the ball, not the color)', /Ball/.test(await design()) && (await box()).color !== '#00ff00', await design());
check('…as a commit on main', await app(() => /Applied changes/.test(window.DraftOtter.hist().commits[window.DraftOtter.hist().branches.main].message)));

// ---------------------------------------------------------------- one part's history
await app(() => { const a = window.DraftOtter; a.partHistoryDialog(a.model.nodes[0]); });
await wait(150);
const ph = await app(() => [...document.querySelectorAll('.modal .ver-row.part b')].map((x) => x.textContent));
check('history of one part: the commits that changed it', ph.length >= 4 && ph.includes('first box') && ph.includes('wider'), ph.join(' | '));
await app(() => { const rows = [...document.querySelectorAll('.modal .ver-row.part')]; const first = rows.find((r) => r.querySelector('b').textContent === 'first box'); first.querySelector('.btn').click(); });
await wait(300);
b = await box();
check('…"Use this version" sets just that part back', b.w === 20 && b.h === 10 && /Ball/.test(await design()), JSON.stringify(b));
await app(() => window.DraftOtter.undo());

// ---------------------------------------------------------------- the History window: graph, badges, tags
await app(() => { const a = window.DraftOtter, h = a.hist(); a.tagCommit(h.branches.main, 'printed v1'); });
await app(() => window.DraftOtter.historyDialog());
await wait(200);
const g = await app(() => ({ dots: document.querySelectorAll('.hist-svg circle').length, rows: document.querySelectorAll('.hist-row').length, lines: document.querySelectorAll('.hist-svg path').length, badges: [...document.querySelectorAll('.hist-badge')].map((x) => x.textContent), branches: [...document.querySelectorAll('#hist-branch option')].map((o) => o.value) }));
const hh = await H();
check('the graph has a dot per commit and lines between them', g.dots === hh.commits && g.rows === hh.commits && g.lines >= hh.commits - 1, JSON.stringify(g));
check('branch and tag labels', g.badges.includes('main') && g.badges.includes('red') && g.badges.some((x) => /printed v1/.test(x)) && g.branches.join() === 'main,tall lid,red,extras', JSON.stringify(g));
await page.screenshot({ path: 'test/shots/450-history.png' });
await closeModals();

// delete a merged and an unmerged branch
check('deleting a merged branch keeps its commits', await app(() => { const a = window.DraftOtter, n = Object.keys(a.hist().commits).length; a.deleteBranch('tall lid', true); return Object.keys(a.hist().commits).length === n; }));
check('deleting an unmerged branch drops what only it had', await app(() => { const a = window.DraftOtter, n = Object.keys(a.hist().commits).length; a.deleteBranch('red', true); return Object.keys(a.hist().commits).length === n - 1; }));
check('the current branch can\'t be deleted', await app(() => window.DraftOtter.deleteBranch('main', true) === false));

// ---------------------------------------------------------------- files
const saved = await app(() => { const a = window.DraftOtter, s = a.model.serialize(), d = JSON.parse(s); a.model.load(d.doc, d.blobs); a.afterChange(); const h = a.hist(); return { head: h.head, branches: Object.keys(h.branches).join(), tags: Object.keys(h.tags).join(), dirty: a.histDirty(), size: s.length }; });
check('saving and opening keeps branches, tags and history', saved.head === 'main' && saved.branches === 'main,extras' && saved.tags === 'printed v1' && !saved.dirty, JSON.stringify(saved));
const old = await app(() => { const a = window.DraftOtter; const st = JSON.stringify(a.model.designState()); a.model.load({ ...a.model.emptyDoc(), nodes: JSON.parse(st).nodes, versions: [{ id: 'x', name: 'old named', auto: false, time: 1, state: st }, { id: 'y', name: 'Saved', auto: true, time: 2, state: st }] }); a.afterChange(); const h = a.hist(); return { commits: Object.values(h.commits).map((c) => c.message).sort().join(), versions: 'versions' in a.model.doc }; });
check('old files: versions become commits on main', old.commits === 'Saved,old named' && !old.versions, JSON.stringify(old));

// ---------------------------------------------------------------- undo survives reloading
await app(() => { const a = window.DraftOtter; a.model.nodes[0].params.d = 33; a.commit(); a.autosaveNow(); });
await wait(500);
await page.reload();
await page.waitForFunction(() => document.body.classList.contains('ready'));
await wait(300);
const u = await app(() => { const a = window.DraftOtter; const can = a.model.canUndo(); const d0 = a.model.nodes[0].params.d; a.undo(); return { can, d0, d1: a.model.nodes[0].params.d }; });
check('undo still works after reloading the page', u.can && u.d0 === 33 && u.d1 !== 33, JSON.stringify(u));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'browser54: all passed');
process.exit(fails ? 1 : 0);
