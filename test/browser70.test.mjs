// Push/pull on the end of something already there changes it instead of stacking another feature on top (two
// coinciding prisms left hairline slivers along slanted walls): the top of a sketch extrusion changes its height, a
// pocket floor its depth, the end of an earlier push/pull its distance (back to zero removes it).
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 240000, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1500, height: 900 } });
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
const near = (a, b, t = 1e-3) => Math.abs(a - b) <= t;
const cv = await (await page.$('#viewport canvas')).boundingBox();

// the part: volume, triangles, extent, children, and how many triangles are slivers (tiny)
const state = () => app(() => {
	const a = window.DraftOtter, g = a.model.nodes[0], geo = a.engine.geometry(g), M = a.worldMatrix(g), pos = geo.attributes.position;
	const V = (i) => new (a.vp.camera.position.constructor)().fromBufferAttribute(pos, i).applyMatrix4(M);
	let tiny = 0;
	const box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
	for (let i = 0; i < pos.count; i += 3) {
		const p = V(i), q = V(i + 1), r = V(i + 2);
		for (const v of [p, q, r]) v.toArray().forEach((x, k) => { box.min[k] = Math.min(box.min[k], x); box.max[k] = Math.max(box.max[k], x); });
		if (q.clone().sub(p).cross(r.clone().sub(p)).length() / 2 < 1e-3) tiny++;
	}
	const d = (n) => n.type + (n.hole ? '(h)' : '') + (n.children ? '[' + n.children.map(d).join(',') + ']' : '');
	return { vol: +a.engine.stats([g]).volume.toFixed(3), tris: pos.count / 3, tiny, min: box.min.map((v) => +v.toFixed(4)), max: box.max.map((v) => +v.toFixed(4)), tree: d(g), err: a.engine.errors.has(g.id) };
});
// the middle of the outermost face facing `dir` (world)
const faceAt = (dir) => app((dir) => {
	const a = window.DraftOtter, g = a.model.nodes[0], geo = a.engine.geometry(g), M = a.worldMatrix(g), pos = geo.attributes.position, C = a.vp.camera.position.constructor;
	const D = new C(...dir), V = (i) => new C().fromBufferAttribute(pos, i).applyMatrix4(M);
	const tris = [];
	let far = -Infinity;
	for (let i = 0; i < pos.count; i += 3) {
		const p = V(i), q = V(i + 1), r = V(i + 2), n = q.clone().sub(p).cross(r.clone().sub(p));
		const ar = n.length() / 2; n.normalize();
		if (n.dot(D) > 0.999) { const c = p.clone().add(q).add(r).divideScalar(3); const h = c.dot(D); tris.push({ c, ar, h }); far = Math.max(far, h); }
	}
	const end = tris.filter((t) => t.h > far - 1e-3);
	return end.reduce((s, t) => s.addScaledVector(t.c, t.ar), new C()).divideScalar(end.reduce((s, t) => s + t.ar, 0)).toArray();
}, dir);
const pushAt = async (pt, dist) => {
	await app(() => window.DraftOtter.setTool('pushpull'));
	const p = await app(([x, y, z]) => { const vp = window.DraftOtter.vp; vp.render(); return vp.project(vp.camera.position.clone().set(x, y, z)); }, pt);
	await page.mouse.move(cv.x + p.x, cv.y + p.y, { steps: 3 });
	await page.mouse.click(cv.x + p.x, cv.y + p.y);
	await wait(200);
	await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
	await page.keyboard.type(String(dist));
	await page.keyboard.press('Enter');
	await wait(700);
	await app(() => window.DraftOtter.setTool(null));
	return state();
};
const push = async (dir, dist) => pushAt(await faceAt(dir), dist);
const view = (pos, target) => app(([pos, target]) => { const vp = window.DraftOtter.vp; vp.camera.position.set(...pos); vp.controls.target.set(...target); vp.controls.update(); vp.render(); }, [pos, target]);
const sketchOn = (pt, pts, cut, value) => app(([pt, pts, cut, value]) => {
	const a = window.DraftOtter, vp = a.vp; vp.render();
	const s = vp.project(vp.camera.position.clone().set(...pt)), r = vp.canvas.getBoundingClientRect();
	a.onSketchFace(vp.surfacePoint({ clientX: r.left + s.x, clientY: r.top + s.y }));
	return new Promise((res) => setTimeout(() => {
		const ta = document.querySelector('.sk-points');
		ta.value = pts; ta.dispatchEvent(new Event('input'));
		if (cut) { const sel = document.querySelector('.sk-right select'); sel.value = 'cut'; sel.dispatchEvent(new Event('change')); }
		const f = [...document.querySelectorAll('.sk-right .sk-field')].find((f) => f.textContent.startsWith(cut ? 'Depth' : 'Extrude height')).querySelector('input');
		f.value = String(value); f.dispatchEvent(new Event('change'));
		[...document.querySelectorAll('.modal .btn')].find((b) => b.textContent.trim() === 'Create').click();
		setTimeout(res, 600);
	}, 400));
}, [pt, pts, cut, value]);
const fresh = async (camPos, target) => {
	await app(() => { const a = window.DraftOtter; a.model.doc.nodes = []; a.commit(); a.addShape('box'); a.setSelection([]); });
	await view(camPos, target);
	await wait(300);
};

// ---- the reported case: a slanted four-sided shape sketched on the -X side of a box, extruded 5, pulled and pushed
await fresh([-80, -60, 50], [-10, 0, 10]);
await sketchOn([-10, 0, 10], '-7.6,3.8\n1.5,2.9\n3.1,-5.25\n-9.7,-5.25', false, 5);
const s0 = await state();
check('the slanted shape is extruded 5 mm out of the side', near(s0.min[0], -15) && s0.tree === 'group[box,sketch]', JSON.stringify(s0));
let s = await push([-1, 0, 0], 5);
check('pulling its end 5 mm makes the extrusion 5 mm longer (no extra feature)', near(s.min[0], -20) && s.tree === 'group[box,sketch]' && s.tiny === 0 && s.tris === s0.tris, JSON.stringify(s));
s = await push([-1, 0, 0], -5);
check('pushing it back 5 mm gives exactly the part it was: same volume and triangles, no slivers', s.vol === s0.vol && s.tris === s0.tris && near(s.min[0], -15) && s.tiny === 0, JSON.stringify(s));
s = await push([-1, 0, 0], -3);
check('pushing 3 mm more shortens the extrusion to 2 mm, still clean', near(s.min[0], -12) && s.tiny === 0 && s.tree === 'group[box,sketch]', JSON.stringify(s));
s = await push([-1, 0, 0], -6);
check('pushing past the box face turns the extrusion into a pocket of the rest (2 out, pushed 6: 4 deep)', s.tree === 'group[box,sketch(h)]' && near(s.min[0], -10) && near(s.vol, 8000 - (s0.vol - 8000) / 5 * 4, 0.01) && s.tiny === 0 && !s.err, JSON.stringify(s));
const pf = await app(() => { const a = window.DraftOtter, k = a.model.nodes[0].children.find((c) => c.type === 'sketch'); return new (a.vp.camera.position.constructor)().setFromMatrixPosition(a.worldMatrix(k)).toArray(); });
s = await pushAt(pf, 4);
check('pulling the pocket floor 4 mm brings it flush: the pocket is removed, exactly the box', s.tree === 'group[box]' && s.vol === 8000 && s.tris === 12, JSON.stringify(s));

// ---- push/pull on push/pull
await fresh([60, -70, 70], [0, 0, 10]);
const b0 = await state();
s = await push([0, 0, 1], 5);
check('pulling a box top adds a push/pull', s.tree === 'group[box,facex]' && near(s.max[2], 25), JSON.stringify(s));
s = await push([0, 0, 1], 3);
check('pulling that top again changes the same push/pull (5 to 8 mm)', s.tree === 'group[box,facex]' && near(s.max[2], 28), JSON.stringify(s));
const depth = await app(() => window.DraftOtter.model.nodes[0].children[1].params.depth);
check('…its distance reads 8', depth === 8, String(depth));
s = await push([0, 0, 1], -8);
check('pushing it back 8 mm removes the push/pull: exactly the box again', s.tree === 'group[box]' && s.vol === b0.vol && s.tris === b0.tris && near(s.max[2], 20), JSON.stringify(s));
s = await push([0, 0, 1], -4);
check('pushing the plain top makes a cut (4 mm)', s.tree === 'group[box,facex(h)]' && near(s.max[2], 16), JSON.stringify(s));
s = await push([0, 0, 1], -2);
check('pushing that cut floor deepens the same cut (4 to 6 mm)', s.tree === 'group[box,facex(h)]' && near(s.max[2], 14) && s.tiny === 0, JSON.stringify(s));

// ---- a pocket from a sketch: pushing its floor makes it deeper (seen from above, so the floor can be clicked)
await fresh([8, -12, 120], [0, 0, 10]);
await sketchOn([0, 0, 20], '-6,-4\n5,-4\n2,5\n-4,6', true, 4);
const p0 = await state();
const floor = await app(() => { const a = window.DraftOtter, k = a.model.nodes[0].children.find((c) => c.type === 'sketch'); return new (a.vp.camera.position.constructor)().setFromMatrixPosition(a.worldMatrix(k)).toArray(); });
s = await pushAt([floor[0] - 0.5, floor[1], floor[2]], -3);
const sk = await app(() => { const k = window.DraftOtter.model.nodes[0].children.find((c) => c.type === 'sketch'); return { h: k ? k.params.height : null }; });
const area = (8000 - p0.vol) / 4;
check('pushing a sketch pocket floor 3 mm deeper makes the same pocket 7 mm deep', s.tree === 'group[box,sketch(h)]' && near(sk.h, 7) && near(p0.vol - s.vol, area * 3, 0.01) && s.tiny === 0, JSON.stringify({ s, sk, p0: p0.vol }));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'browser70: all passed');
process.exit(fails ? 1 : 0);
