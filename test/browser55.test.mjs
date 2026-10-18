// Sculpt mode in the app: enter from the Modify menu, sculpt with the mouse, brush keys, F radius, undo / redo,
// grab, refine, Done (a mesh part that keeps the original), back to the original, cutting a sculpted part, Cancel,
// and autosaving a design too big for localStorage.
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
const settle = () => app(async () => { const a = window.DraftOtter; for (let i = 0; i < 50 && a.bgBuild; i++) await a.bgBuild; });
// screen position of a point given in the sculpted part's own frame
const screenOf = (p) => app((p) => { const a = window.DraftOtter, vp = a.vp, S = a.sculpt; vp.render(); const w = new (vp.camera.position.constructor)(...p).applyMatrix4(S.M); const s = w.project(vp.camera), r = vp.canvas.getBoundingClientRect(); return { x: r.left + ((s.x + 1) / 2) * r.width, y: r.top + ((1 - s.y) / 2) * r.height }; }, p);
const topZ = () => app(() => { const s = window.DraftOtter.sculpt.session; let z = -Infinity; for (let v = 0; v < s.nv; v++) z = Math.max(z, s.pos[3 * v + 2]); return z; });
// how far out (and in) the surface reaches from the middle of the part
const reach = () => app(() => { const s = window.DraftOtter.sculpt.session, c = s.symCenter; let r = 0; for (let v = 0; v < s.nv; v++) r = Math.max(r, Math.hypot(s.pos[3 * v] - c[0], s.pos[3 * v + 1] - c[1], s.pos[3 * v + 2] - c[2])); return r; });
const inner = () => app(() => { const s = window.DraftOtter.sculpt.session, c = s.symCenter; let r = Infinity; for (let v = 0; v < s.nv; v++) r = Math.min(r, Math.hypot(s.pos[3 * v] - c[0], s.pos[3 * v + 1] - c[1], s.pos[3 * v + 2] - c[2])); return r; });
const stroke = async (from, to, mods = []) => {
	for (const m of mods) await page.keyboard.down(m);
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move(to.x, to.y, { steps: 12 });
	await page.mouse.up();
	for (const m of mods) await page.keyboard.up(m);
	await wait(100);
};

// starting to sculpt must not change the shape (a filleted CAD box keeps its exact size and corners)
const keep = await app(async () => {
	localStorage.clear();
	const a = window.DraftOtter; a.model.doc.nodes = []; a.commit(); a.addShape('box');
	const n = a.model.nodes[0]; Object.assign(n.params, { w: 80, d: 60, h: 20, radius: 3, edgeType: 'fillet' }); a.commit();
	const g = a.engine.geometry(n); g.computeBoundingBox();
	a.startSculpt(n);
	[...document.querySelectorAll('.modal .btn')].find((b) => b.textContent === 'Start sculpting').click();
	for (let i = 0; i < 100 && !a.sculpt; i++) await new Promise((r) => setTimeout(r, 50));
	const s = a.sculpt.session; s.geometry.computeBoundingBox();
	const out = { before: g.boundingBox.max.toArray(), after: s.geometry.boundingBox.max.toArray(), brush: a.sculpt.radiusPx };
	a.exitSculpt(false);
	return out;
});
check('starting to sculpt keeps the part exactly as it was', keep.before.every((v, i) => Math.abs(v - keep.after[i]) < 1e-4), JSON.stringify(keep));
check('…and the brush starts at a size that fits the part', keep.brush >= 10 && keep.brush <= 150, keep.brush);

await app(() => { localStorage.clear(); const a = window.DraftOtter; a.model.doc.nodes = []; a.commit(); a.addShape('sphere'); const n = a.model.nodes[0]; n.params.r = 15; n.name = 'Ball'; n.color = '#d08040'; a.commit(); a.setSelection([n.id]); a.vp.setView('front'); a.frame(); });
await wait(700);
// Modify → Sculpt…
await app(() => { [...document.querySelectorAll('#toolbar .tb-btn, #toolbar button')].find((x) => /Modify/.test(x.title || x.textContent)).click(); [...document.querySelectorAll('.menu .menu-item, .menu button, .menu div')].find((x) => x.textContent.trim().startsWith('Sculpt')).click(); });
await wait(200);
const opts = await app(() => [...document.querySelectorAll('#sc-detail option')].map((o) => o.textContent));
check('Sculpt asks for the detail level, with triangle counts', opts.length === 4 && opts.every((t) => /triangles/.test(t)), opts.join(' | '));
await app(() => [...document.querySelectorAll('.modal .btn')].find((b) => b.textContent === 'Start sculpting').click());
await page.waitForFunction(() => !!window.DraftOtter.sculpt, { timeout: 20000 }).catch(() => null);
await wait(300);
const st = await app(() => { const a = window.DraftOtter, S = a.sculpt; return S && { nt: S.session.nt, panel: !!document.querySelector('#sculpt-panel'), hidden: a.vp.displays.get(S.node.id).visible === false, brush: S.brush, sym: S.symmetry }; });
check('Sculpt mode: a subdivided mesh, the brush panel, the part\'s normal display hidden', st && st.nt > 10000 && st.panel && st.hidden && st.brush === 'draw' && st.sym.every((v) => !v), JSON.stringify(st));

// hover shows the brush ring; a stroke across the top raises it
const top = await screenOf([0, 0, 15]), side = await screenOf([0, 0, 15]);
await page.mouse.move(top.x, top.y + 20);
await wait(100);
check('hovering the part shows the brush ring', await app(() => window.DraftOtter.sculpt.ring.visible));
// (in the front view: points inside the sphere's outline, on the side facing us)
const z0 = await reach();
const a1 = await screenOf([-6, -12, 5]), a2 = await screenOf([6, -12, 5]);
await stroke(a1, a2);
const z1 = await reach();
check('dragging with Draw raises the surface', z1 > z0 + 0.05, `${z0.toFixed(2)} → ${z1.toFixed(2)}`);
// a stroke on the +X side only (symmetry is off): nothing on the −X side changes
await stroke(await screenOf([5, -13.82, 3]), await screenOf([9, -11.66, 3]));
const sides = await app(() => { const s = window.DraftOtter.sculpt.session, c = s.symCenter, last = s.undoStack[s.undoStack.length - 1]; let pos = 0, neg = 0; for (const e of last.ids) { const v = s.pos[3 * e] - c[0]; if (v > 0) pos++; else neg++; } return { pos, neg }; });
check('with symmetry off (the default), a stroke changes only the spot it is on', sides.pos > 20 && sides.neg === 0, JSON.stringify(sides));
await app(() => window.DraftOtter.sculptUndo());
check('…as one undo step', await app(() => window.DraftOtter.sculpt.session.undoStack.length === 1 && window.DraftOtter.sculpt.modified));
await page.screenshot({ path: 'test/shots/470-sculpt.png' });
await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
check('Ctrl+Z undoes the stroke (not the design)', Math.abs((await reach()) - z0) < 1e-4 && await app(() => window.DraftOtter.model.nodes[0].type === 'sphere'));
await page.keyboard.down('Control'); await page.keyboard.down('Shift'); await page.keyboard.press('z'); await page.keyboard.up('Shift'); await page.keyboard.up('Control');
check('Ctrl+Shift+Z redoes it', Math.abs((await reach()) - z1) < 1e-4);
const in0 = await inner();
await stroke(a1, a2, ['Control']);
const dug = await app(() => { const s = window.DraftOtter.sculpt.session, c = s.symCenter, last = s.undoStack[s.undoStack.length - 1]; let d = 0; for (let i = 0; i < last.ids.length; i++) { const v = last.ids[i]; const r0 = Math.hypot(last.before[3 * i] - c[0], last.before[3 * i + 1] - c[1], last.before[3 * i + 2] - c[2]); const r1 = Math.hypot(s.pos[3 * v] - c[0], s.pos[3 * v + 1] - c[1], s.pos[3 * v + 2] - c[2]); d += r1 - r0; } return d / last.ids.length; });
check('Ctrl-drag digs in instead (the stroke moves the surface inward)', dug < -0.005, dug.toFixed(4) + ' mm on average');

// keys
const r0 = await app(() => window.DraftOtter.sculpt.radiusPx);
await page.keyboard.press('x');
await page.mouse.move(top.x - 60, top.y + 40);
await page.mouse.move(top.x - 40, top.y + 40);
await wait(150);
check('symmetry on: a purple ring marks the mirrored spot too', await app(() => window.DraftOtter.sculpt.mirrorRings.length === 1 && window.DraftOtter.sculpt.mirrorRings[0].visible && /mirrored/.test(document.querySelector('#sculpt-panel').textContent)));
await page.keyboard.press('x');
await page.keyboard.press('6');
await page.keyboard.press(']');
await page.keyboard.press('y');
const k = await app(() => { const S = window.DraftOtter.sculpt; return { brush: S.brush, r: S.radiusPx, sym: S.symmetry.join() }; });
check('number keys pick brushes, ] grows the brush, Y toggles symmetry', k.brush === 'pinch' && k.r > r0 && k.sym === 'false,true,false', JSON.stringify(k));
await page.mouse.move(700, 450);
await page.keyboard.press('f');
await page.mouse.move(700 + 120, 450, { steps: 4 });
await page.mouse.down(); await page.mouse.up();
check('F, move, click: sets the radius by distance (like Blender)', await app(() => Math.abs(window.DraftOtter.sculpt.radiusPx - 120) <= 2 && !document.querySelector('.sc-adjust')), await app(() => window.DraftOtter.sculpt.radiusPx));
await page.keyboard.press('f');
await page.mouse.move(700 + 30, 450, { steps: 2 });
await page.keyboard.press('Escape');
check('…Esc puts it back', await app(() => Math.abs(window.DraftOtter.sculpt.radiusPx - 120) <= 2));

// grab
await app(() => { const S = window.DraftOtter.sculpt; S.radiusPx = 60; S.strength = 1; S.symmetry = [false, false, false]; });
await page.keyboard.press('8');
const zg = await topZ(), g1 = await screenOf([0, 0, 13]), g2 = await screenOf([0, 0, 22]);
await stroke(g1, g2);
check('Grab pulls the surface along', (await topZ()) > zg + 4, `${zg.toFixed(2)} → ${(await topZ()).toFixed(2)}`);

// refine
const nt0 = await app(() => window.DraftOtter.sculpt.session.nt);
await app(() => [...document.querySelectorAll('#sculpt-panel .btn')].find((b) => b.textContent === 'Refine').click());
await wait(300);
const nt1 = await app(() => window.DraftOtter.sculpt.session.nt);
check('Refine adds detail (about 2.5× the triangles) and keeps the shape', nt1 > nt0 * 2 && Math.abs((await topZ()) - (zg + 0)) > 4, `${nt0} → ${nt1}`);
await app(() => window.DraftOtter.sculptUndo());
check('…and can be undone', (await app(() => window.DraftOtter.sculpt.session.nt)) === nt0);
await app(() => window.DraftOtter.sculptRedo && window.DraftOtter.refineSculpt());

// Done
const sculptedTris = await app(() => window.DraftOtter.sculpt.session.nt);
await app(() => [...document.querySelectorAll('#sculpt-panel .btn')].find((b) => b.textContent === 'Done').click());
await settle();
let n = await app(() => { const a = window.DraftOtter, n = a.model.nodes[0], g = a.engine.geometry(n); return { type: n.type, name: n.name, src: n.sculptSource && n.sculptSource.type, idx: (a.model.blobs[n.params.blob] || '').startsWith('IDX1:'), tris: g && g.attributes.position.count / 3, sel: a.sel[0] === n.id, mode: !!a.sculpt, panel: !!document.querySelector('#sculpt-panel') }; });
check('Done: the part becomes a sculpted mesh part (stored compactly), the original kept', n.type === 'mesh' && n.name === 'Ball' && n.src === 'sphere' && n.idx && n.tris === sculptedTris && n.sel && !n.mode && !n.panel, JSON.stringify(n));
const look = await app(() => { const a = window.DraftOtter, n = a.model.nodes[0], d = a.vp.displays.get(n.id), lines = d.children.find((c) => c.isLineSegments); return { lines: lines ? lines.geometry.attributes.position.count / 2 : 0, tris: a.engine.geometry(n).attributes.position.count / 3 }; });
check('a sculpted part is shaded smooth, without outline lines on every fold', look.lines < look.tris * 0.01, JSON.stringify(look));
check('…the Properties offer to keep sculpting or go back', await app(() => /Keep sculpting/.test(document.querySelector('#props').textContent) && /Back to the original part/.test(document.querySelector('#props').textContent)));
// a sculpted part works with holes like any other
const cut = await app(async () => { const a = window.DraftOtter; a.addShape('cylinder'); const h = a.model.nodes[1]; h.params.r = 4; h.params.h = 60; h.hole = true; h.pos = a.model.nodes[0].pos.slice(); a.commit(); a.setSelection(a.model.nodes.map((x) => x.id)); a.group(); for (let i = 0; i < 50 && a.bgBuild; i++) await a.bgBuild; const g = a.model.nodes[0]; return { ok: !a.engine.errors.has(g.id), vol: a.engine.stats([g]).volume }; });
check('a hole cuts through a sculpted part', cut.ok && cut.vol > 1000, JSON.stringify(cut));
await app(() => window.DraftOtter.undo());
await settle();
// back to the original, and again
await app(() => { const a = window.DraftOtter; a.setSelection([a.model.nodes[0].id]); a.propSig = null; a.renderProps(); [...document.querySelectorAll('#props .btn')].find((b) => b.textContent === 'Back to the original part').click(); });
await settle();
check('Back to the original part: the sphere again, editable', await app(() => { const n = window.DraftOtter.model.nodes[0]; return n.type === 'sphere' && n.params.r === 15; }));
await app(() => window.DraftOtter.undo());
await settle();
check('…and Undo returns to the sculpted one', await app(() => window.DraftOtter.model.nodes[0].type === 'mesh'));

// keep sculpting: straight in (no detail question), then Cancel discards
await app(() => window.DraftOtter.startSculpt(window.DraftOtter.model.nodes[0]));
check('Keep sculpting goes straight back in', await app(() => !!window.DraftOtter.sculpt && !document.querySelector('.modal-back') && window.DraftOtter.sculpt.session.nt === window.DraftOtter.engine.geometry(window.DraftOtter.model.nodes[0]).attributes.position.count / 3));
const blob0 = await app(() => window.DraftOtter.model.nodes[0].params.blob);
await page.keyboard.press('1');
const c1 = await screenOf([-6, -12, 5]), c2 = await screenOf([6, -12, 5]);
await stroke(c1, c2);
check('(a stroke before canceling)', await app(() => window.DraftOtter.sculpt.modified));
await app(() => [...document.querySelectorAll('#sculpt-panel .btn')].find((b) => b.textContent === 'Cancel').click());
await wait(200);
check('Cancel (after confirming) leaves the part as it was', await app((b) => !window.DraftOtter.sculpt && window.DraftOtter.model.nodes[0].params.blob === b && window.DraftOtter.vp.displays.get(window.DraftOtter.model.nodes[0].id).visible, blob0), blob0);

// a design too big for localStorage autosaves to IndexedDB and comes back after a reload
await app(() => {
	const real = Storage.prototype.setItem;
	Storage.prototype.setItem = function (k, v) { if (k === 'draftotter-autosave-v1' && v.length > 5000) throw new DOMException('full', 'QuotaExceededError'); return real.call(this, k, v); };
	window.DraftOtter.autosaveNow();
	Storage.prototype.setItem = real;
});
await wait(500);
check('too big for localStorage: autosaved to IndexedDB (with a marker)', await app(() => JSON.parse(localStorage.getItem('draftotter-autosave-v1')).inIdb === true));
await page.reload();
// a 600k-triangle mesh in software rendering: drawing its edges and stats takes a while on a slow machine
await page.waitForFunction(() => document.body.classList.contains('ready'), { timeout: 90000 });
await settle();
check('…and restored from there after reloading', await app(() => { const n = window.DraftOtter.model.nodes[0]; return n && n.type === 'mesh' && !!window.DraftOtter.engine.geometry(n); }));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'browser55: all passed');
process.exit(fails ? 1 : 0);
