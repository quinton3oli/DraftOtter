// Symmetry: pick a point and the part becomes mirror-symmetric about n planes through it. The wedge between the
// first two planes is kept and mirrored around; the result is a symmetric group whose planes, axis, angle and point
// can be edited, with the planes shown in the view while it is selected.
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 240000, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1500, height: 900 } });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(pathToFileURL('LocalCAD.html').href);
await page.waitForFunction(() => document.body.classList.contains('ready'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(ok ? 'ok  ' : 'FAIL', name, info); };
const app = (fn, ...a) => page.evaluate(fn, ...a);
const near = (a, b, t = 0.05) => Math.abs(a - b) <= t;
const info = () => app(() => {
	const a = window.DraftOtter, n = a.model.nodes[0], b = a.worldBox(n), st = a.engine.stats([n]);
	return { type: n.type, mode: n.mode, name: n.name, sym: n.sym, vol: +st.volume.toFixed(1), min: b.min.toArray().map((v) => +v.toFixed(3)), max: b.max.toArray().map((v) => +v.toFixed(3)), err: a.engine.errors.has(n.id), planes: a.vp.symHelper ? a.vp.symHelper.children.filter((c) => c.isMesh && c.geometry.attributes.position.count === 6).length : 0 };
});

// a 40 × 20 × 10 box from x = −10 to 30 (y −10…10, z 0…10)
await app(() => {
	const a = window.DraftOtter;
	a.model.doc.nodes = []; a.commit();
	a.addShape('box');
	const n = a.model.nodes[0];
	Object.assign(n.params, { w: 40, d: 20, h: 10 });
	n.pos = [10, 0, 5];
	a.commit();
	a.setSelection([n.id]);
	a.startSymmetry();
});
await wait(200);
check('Symmetry asks for the point, with a planes count', await app(() => !!document.querySelector('#sym-bar') && document.querySelector('#sym-bar').style.display !== 'none' && window.DraftOtter.tool === 'sympoint'));
// click the origin on the bed (z = 0 is fine: the planes are vertical)
const P = await app(() => { const vp = window.DraftOtter.vp; const v = new (vp.camera.position.constructor)(0, 0, 0).project(vp.camera); const r = vp.canvas.getBoundingClientRect(); return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height }; });
await app(() => { const i = document.querySelector('#sym-n'); i.value = 2; i.dispatchEvent(new Event('change')); });
// a real click lands on the part; the exact point used for the geometry checks is given directly
await page.mouse.click(P.x, P.y);
await wait(600);
const clicked = await app(() => { const a = window.DraftOtter, g = a.model.nodes[0]; return { mode: g.mode, center: g.sym && g.sym.center }; });
check('clicking a point in the view makes the symmetric group through it', clicked.mode === 'symmetric' && clicked.center.every(Number.isFinite), JSON.stringify(clicked));
await app(() => { const a = window.DraftOtter; a.undo(); a.setSelection([a.model.nodes[0].id]); a.startSymmetry(); const i = document.querySelector('#sym-n'); i.value = 2; i.dispatchEvent(new Event('change')); a.onSymClick({ point: new (a.vp.camera.position.constructor)(0, 0, 5) }); });
await wait(600);
let s = await info();
// 2 planes (XZ and YZ): the quarter x 0…30, y 0…10 is kept → mirrored and turned → x −30…30, y −10…10
check('two planes through the origin: the kept quarter is mirrored into a 60 × 20 box', s.type === 'group' && s.mode === 'symmetric' && near(s.vol, 12000, 1) && near(s.min[0], -30) && near(s.max[0], 30) && near(s.min[1], -10) && near(s.max[1], 10) && !s.err, JSON.stringify(s));
check('…the point is stored in the group and the planes are drawn while it is selected', s.sym.n === 2 && near(s.sym.center[0] + 10, 0, 0.5) && s.planes === 2, JSON.stringify(s.sym) + ' planes ' + s.planes);
check('the tool closes after the click', await app(() => window.DraftOtter.tool === null && document.querySelector('#sym-bar').style.display === 'none'));

// one plane = a plain mirror: keep x ≥ 0 of the box (0…30) and mirror it → 60 × 20 × 10 again
await app(() => { const a = window.DraftOtter, g = a.model.nodes[0]; g.sym = { ...g.sym, n: 1, angle: 90 }; a.commit(); });
await wait(300);
s = await info();
// n = 1 at 90°: the plane is the YZ plane (normal −X): the side x ≤ 0 (−10…0) is kept → 20 wide
check('one plane is a plain mirror (the plane through the point, at 90°: the left part kept and mirrored)', near(s.vol, 4000, 1) && near(s.min[0], -10) && near(s.max[0], 10), JSON.stringify(s));
await app(() => { const a = window.DraftOtter, g = a.model.nodes[0]; g.sym = { ...g.sym, angle: 270 }; a.commit(); });
await wait(300);
s = await info();
check('…turning it to the other side keeps the long part instead', near(s.vol, 12000, 1) && near(s.min[0], -30) && near(s.max[0], 30), JSON.stringify(s));

// 3 planes (60° apart): 6 wedges, the result is 3-fold symmetric about the axis
const sym3 = await app(() => {
	const a = window.DraftOtter, g = a.model.nodes[0];
	g.sym = { ...g.sym, n: 3, angle: 0 }; a.commit();
	const geo = a.engine.geometry(g), pos = geo.attributes.position, C = g.sym.center;
	// shape test (vertex lists can differ along seams): a 3-fold symmetric solid has its centroid on the axis and
	// equal second moments across it (Ixx = Iyy, Ixy = 0 about the point) — volume integrals over tetrahedra
	let V = 0, mx = 0, my = 0, xx = 0, yy = 0, xy = 0;
	const p = (i) => [pos.getX(i) - C[0], pos.getY(i) - C[1], pos.getZ(i)];
	for (let i = 0; i < pos.count; i += 3) {
		const [A, B, D] = [p(i), p(i + 1), p(i + 2)];
		const v = (A[0] * (B[1] * D[2] - B[2] * D[1]) - A[1] * (B[0] * D[2] - B[2] * D[0]) + A[2] * (B[0] * D[1] - B[1] * D[0])) / 6;
		V += v; mx += (v * (A[0] + B[0] + D[0])) / 4; my += (v * (A[1] + B[1] + D[1])) / 4;
		const s2 = (k) => A[k] * A[k] + B[k] * B[k] + D[k] * D[k] + A[k] * B[k] + A[k] * D[k] + B[k] * D[k];
		xx += (v * s2(0)) / 10; yy += (v * s2(1)) / 10;
		xy += (v * (2 * A[0] * A[1] + 2 * B[0] * B[1] + 2 * D[0] * D[1] + A[0] * B[1] + A[1] * B[0] + A[0] * D[1] + A[1] * D[0] + B[0] * D[1] + B[1] * D[0])) / 20;
	}
	const cx = mx / V, cy = my / V, aniso = Math.abs(xx - yy) / xx, cross = Math.abs(xy) / xx;
	const miss = Math.abs(cx) > 1e-3 || Math.abs(cy) > 1e-3 || aniso > 1e-4 || cross > 1e-4 ? 1 : 0;
	const worst = { V: +V.toFixed(1), cx: +cx.toFixed(5), cy: +cy.toFixed(5), aniso, cross };
	return { miss, worst, count: pos.count, name: g.name, err: a.engine.errors.has(g.id), planes: a.vp.symHelper ? a.vp.symHelper.children.filter((k) => k.isMesh && k.geometry.attributes.position.count === 6).length : 0 };
});
check('three planes: the part is 3-fold symmetric (centroid on the axis, equal moments across it)', sym3.count > 0 && sym3.miss === 0 && !sym3.err, JSON.stringify(sym3));
check('…the plane preview follows the count', sym3.planes === 3, JSON.stringify(sym3));

// the properties panel: a Symmetry section; Keep other side turns the planes by half their spacing
const props = await app(() => {
	const a = window.DraftOtter;
	a.setSelection([]); a.setSelection([a.model.nodes[0].id]);
	const titles = [...document.querySelectorAll('#props .sec-title')].map((t) => t.textContent);
	const btn = [...document.querySelectorAll('#props button')].find((b) => b.textContent === 'Keep other side');
	btn.click();
	return { titles, angle: a.model.nodes[0].sym.angle };
});
check('Properties has a Symmetry section, and Keep other side turns the planes by 30° for 3 planes', props.titles.includes('Symmetry') && near(props.angle, 30, 1e-6), JSON.stringify(props));
const nm = await app(() => window.DraftOtter.model.nodes[0].name);
check('…and the name follows the plane count', nm === 'Symmetric ×3', nm);
await wait(300);
s = await info();
check('…still a valid solid after that', s.vol > 0 && !s.err, JSON.stringify(s));

// the planes disappear when nothing is selected; undo all the way back gives the box
check('the plane preview goes away when deselected', await app(() => { const a = window.DraftOtter; a.setSelection([]); return !a.vp.symHelper; }));
await app(() => { const a = window.DraftOtter; for (let i = 0; i < 20 && a.model.nodes[0].type === 'group'; i++) a.undo(); });
await wait(400);
s = await info();
check('undo brings back the original box', s.type === 'box' && near(s.vol, 8000, 1), JSON.stringify(s));

// Use center: the planes go through the middle of the selection (box −10…30 → center x = 10)
await app(() => { const a = window.DraftOtter; a.setSelection([a.model.nodes[0].id]); a.startSymmetry(); const i = document.querySelector('#sym-n'); i.value = 1; i.dispatchEvent(new Event('change')); [...document.querySelectorAll('#sym-bar button')].find((b) => b.textContent === 'Use center').click(); });
await wait(500);
s = await info();
check('Use center: one plane through the middle of a symmetric box leaves it unchanged', s.mode === 'symmetric' && near(s.vol, 8000, 1) && near(s.min[0], -10) && near(s.max[0], 30), JSON.stringify(s));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'browser69: all passed');
process.exit(fails ? 1 : 0);
