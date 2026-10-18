// Measuring angles: two faces give the angle between the faces (where their planes meet), drawn as an arc — 120°
// for two sides of a hexagon, 90° for a box, the sharp angle of a wedge — and Shift + a third point gives the angle
// at the middle point, with a live preview while Shift is held.
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 120000, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1500, height: 900 } });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(pathToFileURL('DraftOtter.html').href);
await page.waitForFunction(() => document.body.classList.contains('ready'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const app = (fn, ...a) => page.evaluate(fn, ...a);
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(ok ? 'ok  ' : 'FAIL', name, info); };
const near = (a, b, t = 0.01) => Math.abs(a - b) <= t;
const cv = await (await page.$('#viewport canvas')).boundingBox();
const reset = async (src) => {
	await app((src) => { const a = window.DraftOtter; a.setTool(null); a.model.doc.nodes = []; a.sel = []; a.commit(); (0, eval)(src)(a); a.setSelection([]); a.vp.setView('iso'); a.frame(); }, src.toString());
	await wait(700);
	await page.keyboard.press('m');
	await wait(100);
};
const scr = (p) => app((p) => { const vp = window.DraftOtter.vp; vp.render(); return vp.project(vp.camera.position.clone().set(...p)); }, p);
const click = async (p, shift = false) => {
	const s = await scr(p);
	await page.mouse.move(cv.x + s.x, cv.y + s.y, { steps: 2 });
	await wait(60);
	if (shift) await page.keyboard.down('Shift');
	await page.mouse.click(cv.x + s.x, cv.y + s.y);
	if (shift) await page.keyboard.up('Shift');
	await wait(120);
};
const corner = async (p, shift = false, hoverOnly = false) => {
	const c = await scr(p), m = await scr([0, 0, 10]);
	const d = Math.hypot(m.x - c.x, m.y - c.y) || 1, x = cv.x + c.x + ((m.x - c.x) / d) * 3, y = cv.y + c.y + ((m.y - c.y) / d) * 3;
	if (shift) await page.keyboard.down('Shift');
	await page.mouse.move(x, y, { steps: 3 });
	await wait(hoverOnly ? 400 : 120);
	if (!hoverOnly) { await page.mouse.click(x, y); await wait(150); }
	if (shift && !hoverOnly) await page.keyboard.up('Shift');
};
const result = () => app(() => { const m = window.DraftOtter.vp.measure, r = m.result; return r ? { angle: r.angle, kind: r.angleKind, main: m.label.textContent, legs: (m.legs || []).map((l) => l.label.textContent), arc: (m.legs || []).some((l) => l.line.geometry.attributes.position.count > 2), hint: document.querySelector('#st-hint').textContent } : null; });
// flat faces of the first part that face the camera: normal and area-weighted center (world)
const faces = () => app(() => {
	const a = window.DraftOtter, vp = a.vp, n0 = a.model.nodes[0], d = vp.displays.get(n0.id), C = vp.camera.position.constructor;
	d.updateWorldMatrix(true, false);
	const pos = d.geometry.attributes.position, groups = new Map();
	const view = new C().subVectors(vp.camera.position, vp.controls.target).normalize();
	for (let i = 0; i < pos.count; i += 3) {
		const p = [0, 1, 2].map((k) => new C().fromBufferAttribute(pos, i + k).applyMatrix4(d.matrixWorld));
		const cr = p[1].clone().sub(p[0]).cross(p[2].clone().sub(p[0]));
		const area = cr.length() / 2, n = cr.normalize();
		if (n.dot(view) < 0.15) continue;
		const key = n.toArray().map((v) => v.toFixed(3)).join();
		const g = groups.get(key) || { n: n.toArray(), c: new C(), area: 0 };
		g.c.addScaledVector(p[0].clone().add(p[1]).add(p[2]).divideScalar(3), area);
		g.area += area;
		groups.set(key, g);
	}
	return [...groups.values()].map((g) => ({ n: g.n, c: g.c.divideScalar(g.area).toArray(), area: g.area }));
});

// ---- hexagon: two neighboring side faces meet at 120° (the old measure said 60°)
await reset((a) => { a.addShape('prism'); const n = a.model.nodes[0]; Object.assign(n.params, { sides: 6, r: 12, h: 10 }); n.pos = [0, 0, 5]; a.commit(); });
let fs = (await faces()).filter((f) => Math.abs(f.n[2]) < 0.01);
// two neighbors: normals 60° apart
let pair = null;
for (const f of fs) for (const g of fs) if (f !== g && near(f.n[0] * g.n[0] + f.n[1] * g.n[1], 0.5, 0.01)) pair = pair || [f, g];
check('found two neighboring hexagon sides facing the camera', !!pair, JSON.stringify(fs.map((f) => f.n)));
await click(pair[0].c);
await click(pair[1].c);
let r = await result();
check('two hexagon sides: ∠ 120° between the faces (not the 60° between their normals)', r && near(r.angle, 120) && r.kind === 'faces' && /∠ 120/.test(r.main), JSON.stringify(r));
check('…drawn as an arc where the planes meet, labeled with the angle', r.arc && r.legs.some((t) => /^120/.test(t)), JSON.stringify(r.legs));
check('…and the status line says what it measured', /Angle 120.*between the faces/.test(r.hint), r.hint);

// ---- box: top and side 90°
await reset((a) => { a.addShape('box'); const n = a.model.nodes[0]; Object.assign(n.params, { w: 20, d: 20, h: 20 }); n.pos = [0, 0, 10]; a.commit(); });
fs = await faces();
const top = fs.find((f) => f.n[2] > 0.99), side = fs.find((f) => Math.abs(f.n[2]) < 0.01);
await click(top.c);
await click(side.c);
r = await result();
check('box top and side: ∠ 90°', r && near(r.angle, 90), JSON.stringify(r));

// ---- wedge: the sharp edge between the slope and the bottom is atan(h / w)
await reset((a) => { a.addShape('wedge'); const n = a.model.nodes[0]; Object.assign(n.params, { w: 20, d: 20, h: 10 }); n.pos = [0, 0, 5]; n.rot = [0, 0, 180]; a.commit(); });
fs = await faces();
const slope = fs.find((f) => f.n[2] > 0.1 && f.n[2] < 0.99);
const back = fs.find((f) => Math.abs(f.n[2]) < 0.01 && f.n[0] > 0.99);
check('wedge: the slope and the upright back face are visible', !!slope && !!back, JSON.stringify(fs.map((f) => f.n)));
await click(slope.c);
await click(back.c);
r = await result();
const expect = 90 - (Math.atan(10 / 20) * 180) / Math.PI; // slope to the upright back face
check(`wedge slope to its upright back: ∠ ${expect.toFixed(2)}°`, r && near(r.angle, expect), JSON.stringify(r));

// ---- three points: corners of a box (clicked just inside, the corner snap takes them), Shift-click the third
await reset((a) => { a.addShape('box'); const n = a.model.nodes[0]; Object.assign(n.params, { w: 20, d: 20, h: 20 }); n.pos = [0, 0, 10]; a.commit(); });
await corner([10, -10, 20]);
await corner([-10, -10, 20]);
r = await result();
const pts = await app(() => window.DraftOtter.vp.measure.pts.map((p) => p.toArray().map((v) => +v.toFixed(3))));
check('two corners first (snapped): 20 mm and a hint about the third point', r && !r.kind && /^20 mm/.test(r.main) && /Shift-click a third point/.test(r.hint), JSON.stringify({ r, pts }));
// hover with Shift held: preview of the angle
await corner([-10, 10, 20], true, true);
const prev = await result();
await corner([-10, 10, 20], true);
r = await result();
check('Shift-hovering a third corner previews the angle', prev && prev.kind === 'points' && near(prev.angle, 90, 0.05), JSON.stringify(prev));
check('Shift-clicking it gives ∠ 90° at the middle corner, with both arms and an arc', r && r.kind === 'points' && near(r.angle, 90, 0.05) && r.arc && r.legs.filter((x) => /^20/.test(x)).length === 2, JSON.stringify(r));
check('…three picks are kept', await app(() => window.DraftOtter.vp.measure.ents.length === 3));
await corner([10, 10, 20]);
check('a plain click after the angle starts a new measurement', await app(() => window.DraftOtter.vp.measure.ents.length === 1));
// a 3D angle: top edge to a slanted face diagonal — corner (10,10,20) → (10,-10,20) → down to (-10,-10,0)
await corner([10, -10, 20]);
await corner([-10, -10, 0], true);
r = await result();
const u = [0, 20, 0], v = [-20, 0, -20];
const want = (Math.acos((u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (Math.hypot(...u) * Math.hypot(...v))) * 180) / Math.PI;
check('a 3D angle (top edge to a slanted diagonal) is measured in 3D', r && r.kind === 'points' && near(r.angle, want, 0.05), JSON.stringify({ r, want }));

// letting go of Shift without clicking goes back to the two-point distance
await corner([10, -10, 20]);
await corner([-10, -10, 20]);
await corner([-10, 10, 20], true, true);
const during = await result();
await page.keyboard.up('Shift');
const c2 = await scr([-10, 10, 20]);
await page.mouse.move(cv.x + c2.x + 4, cv.y + c2.y + 6, { steps: 2 });
await wait(200);
const released = await result();
check('letting go of Shift without clicking goes back to the distance', during && during.kind === 'points' && released && !released.kind && /^20 mm/.test(released.main), JSON.stringify({ during: during && during.main, released: released && released.main }));
await page.screenshot({ path: 'test/shots/720-measure-angle.png' });

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'browser72: all passed');
process.exit(fails ? 1 : 0);
