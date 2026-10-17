// Variable-size fillets and chamfers (start → end along each edge, flip) and picking a face to select all its edges.
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';
mkdirSync('test/shots', { recursive: true });
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 240000, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1500, height: 900 } });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(pathToFileURL('LocalCAD.html').href);
await page.waitForFunction(() => document.body.classList.contains('ready'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const app = (fn, ...a) => page.evaluate(fn, ...a);
const shot = (n) => page.screenshot({ path: `test/shots/${n}.png` });
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(ok ? 'ok  ' : 'FAIL', name, info); };
const k = 1 - Math.PI / 4;
const cv = await (await page.$('#viewport canvas')).boundingBox();
const reset = (fn) => app((src) => { localStorage.clear(); const a = window.LocalCAD; a.setTool(null); a.model.doc.nodes = []; a.sel = []; a.commit(); (0, eval)(src)(a); a.setSelection([]); a.frame(); }, fn.toString());
const screen = (x, y, z) => app(([x, y, z]) => { const vp = window.LocalCAD.vp; vp.render(); return vp.project(vp.camera.position.clone().set(x, y, z)); }, [x, y, z]);
const clickAt = async (x, y, z) => { const p = await screen(x, y, z); await page.mouse.move(cv.x + p.x, cv.y + p.y, { steps: 3 }); await wait(60); await page.mouse.click(cv.x + p.x, cv.y + p.y); await wait(120); };
const bar = () => app(() => document.querySelector('#fillet-bar').innerText.replace(/\n/g, ' '));
const setBar = (o) => app((o) => {
	const b = document.querySelector('#fillet-bar');
	if (o.variable != null) { const v = [...b.querySelectorAll('input[type=checkbox]')][0]; if (v.checked !== o.variable) { v.checked = o.variable; v.dispatchEvent(new Event('change')); } }
	const b2 = document.querySelector('#fillet-bar');
	if (o.kind) { const s = b2.querySelector('select'); s.value = o.kind; s.dispatchEvent(new Event('change')); }
	const nums = [...b2.querySelectorAll('input.num')];
	if (o.size != null) { nums[0].value = o.size; nums[0].dispatchEvent(new Event('change')); }
	if (o.size2 != null) { nums[1].value = o.size2; nums[1].dispatchEvent(new Event('change')); }
}, o);
const btn = (label) => app((label) => [...document.querySelectorAll('#fillet-bar .btn')].find((b) => b.textContent.trim() === label).click(), label);
const vol = () => app(() => { const a = window.LocalCAD; return a.engine.stats([a.model.nodes[0]]).volume; });

// ---------------------------------------------------------------- variable fillet 1 → 4 mm along one edge
await reset((a) => { a.addShape('box'); });
await wait(500);
await page.keyboard.press('g');
await clickAt(0, -10, 20);
await setBar({ variable: true, kind: 'fillet', size: '1', size2: '4' });
await wait(100);
let t = await bar();
check('Variable shows an end size and Flip', /→/.test(t) && /Flip/.test(t), t.slice(0, 120));
const start0 = await app(() => window.LocalCAD.vp.filletTool.selection().chains[0].pts[0].slice());
check('a dot marks where the start size goes', await app(() => window.LocalCAD.vp.filletTool.group.children.some((c) => c.isPoints)));
await btn('Flip ⇄');
const start1 = await app(() => window.LocalCAD.vp.filletTool.selection().chains[0].pts[0].slice());
check('Flip swaps the ends', Math.abs(start0[0] + start1[0]) < 1e-6 && Math.abs(start0[0]) > 5, JSON.stringify([start0, start1]));
await shot('320-variable-fillet-select');
await btn('Apply');
await wait(400);
let r = await app(() => { const a = window.LocalCAD; const g = a.model.nodes[0]; const e = g.children[1]; return { name: e.name, size: e.params.size, size2: e.params.size2, vol: a.engine.stats([g]).volume }; });
const want = 8000 - k * 20 * (1 + 4 + 16) / 3; // ∫ k·r(t)² along 20 mm with r going 1 → 4
check('variable fillet removes exactly ∫ k·r² (1 → 4 mm)', r.name === 'Variable fillet' && r.size === 1 && r.size2 === 4 && Math.abs(r.vol - want) < 1.5, JSON.stringify({ ...r, want }));
// the start is where it was flipped to: the 4 mm end is at -x (start was +x... after flip at -x? check the fillet is bigger at one end)
const ends = await app(() => {
	const a = window.LocalCAD, g = a.model.nodes[0], s = window.__s = a.engine.geometry(g);
	// height of the cut at each end, from the lowest point on the front face near x = ±9.5
	s.computeBoundingBox(); const top = s.boundingBox.max.z, front = s.boundingBox.min.y;
	const p = s.attributes.position, lowest = (xs) => { let m = 99; for (let i = 0; i < p.count; i++) if (Math.abs(p.getX(i) - xs) < 0.6 && Math.abs(p.getY(i) - front) < 1e-3) m = Math.min(m, top - p.getZ(i)); return m; };
	return [lowest(-10), lowest(10)];
});
check('…bigger at one end than the other', Math.abs(Math.max(...ends) - 4) < 0.05 && Math.abs(Math.min(...ends) - 1) < 0.05, JSON.stringify(ends));
// edit the end size in Properties
await app(() => { const a = window.LocalCAD; const e = a.model.nodes[0].children[1]; a.setTool(null); a.setSelection([e.id]); });
await wait(150);
const fields = await page.$$eval('#props .field', (fs) => fs.map((f) => f.textContent));
check('End size is editable in Properties', fields.some((t) => /End size/.test(t)), JSON.stringify(fields.slice(0, 4)));
await app(() => { const a = window.LocalCAD; const e = a.model.nodes[0].children[1]; e.params.size2 = 1; a.commit(); });
check('setting the end size equal to the start makes it constant again', Math.abs((await vol()) - (8000 - 20 * k)) < 1, String(await vol()));

// ---------------------------------------------------------------- variable chamfer
await reset((a) => { a.addShape('box'); });
await wait(400);
await page.keyboard.press('g');
await clickAt(0, -10, 20);
await setBar({ variable: true, kind: 'chamfer', size: '1', size2: '4' });
await btn('Apply');
await wait(400);
const vc = await vol();
check('variable chamfer removes ∫ d²/2 (1 → 4 mm)', Math.abs(vc - (8000 - 20 * 21 / 3 / 2)) < 1, String(vc));

// ---------------------------------------------------------------- click a face: all its edges
await reset((a) => { a.addShape('box'); });
await wait(400);
await page.keyboard.press('g');
await app(() => { const a = window.LocalCAD; a.filletVariable = false; a.vp.filletTool.setActive(true); });
const pf = await screen(2, 1, 20);
await page.mouse.move(cv.x + pf.x, cv.y + pf.y, { steps: 3 });
await wait(100);
check('hovering a face highlights the edges around it', await app(() => { const h = window.LocalCAD.vp.filletTool.hoverPick; return !!(h && h.ci < 0 && h.face && h.face.length === 4); }));
await page.mouse.click(cv.x + pf.x, cv.y + pf.y);
await wait(120);
t = await bar();
check('clicking a face selects its 4 edges', /4 edges/.test(t), t.slice(0, 80));
await shot('321-face-edges');
await page.mouse.click(cv.x + pf.x, cv.y + pf.y);
await wait(120);
t = await bar();
check('clicking it again clears them', !/\d+ edges? on/.test(t), t.slice(0, 80));
await page.mouse.click(cv.x + pf.x, cv.y + pf.y);
await wait(120);
await setBar({ kind: 'fillet', size: '2' });
await btn('Apply');
await wait(500);
const vf = await vol();
check('fillet the whole top face rim', vf < 8000 - 4 * 18 * 4 * k && vf > 8000 - 4 * 20 * 4 * k - 1, String(vf));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'browser41: all passed');
process.exit(fails ? 1 : 0);
