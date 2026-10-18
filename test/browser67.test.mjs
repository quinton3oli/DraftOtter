// Print prep and color: painting faces (fills one face, follows edits, erases, exports to 3MF as filaments),
// auto-orient (picks the side that needs the least support), arrange on the bed (packs parts without overlaps),
// and tracing a colored image into one part per color.
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
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(ok ? 'ok  ' : 'FAIL', name, info); };
const app = (fn, ...a) => page.evaluate(fn, ...a);
const modalBtn = (label) => app((label) => [...document.querySelectorAll('.modal .btn')].find((b) => b.textContent.trim() === label).click(), label);

// ---------------------------------------------------------------- paint
// a 30 × 30 × 20 box with 4 mm rounded edges
await app(() => { const a = window.DraftOtter; a.model.doc.nodes = []; a.commit(); a.addShape('box'); const n = a.model.nodes[0]; n.params.w = 30; n.params.d = 30; n.params.h = 20; n.params.radius = 4; n.params.seg = 6; n.pos = [0, 0, 10]; a.commit(); a.setTool('paint'); a.paintColor = '#ff0000'; });
await wait(400);
// click the middle of the top face on screen
const clickAt = async (world) => {
	const p = await app((w) => { const vp = window.DraftOtter.vp; const v = new (vp.camera.position.constructor)(w[0], w[1], w[2]).project(vp.camera); const r = vp.canvas.getBoundingClientRect(); return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height }; }, world);
	await page.mouse.click(p.x, p.y);
	await wait(400);
};
// what's painted: counts of red triangles by where they face
const painted = () => app(() => {
	const a = window.DraftOtter, n = a.model.nodes[0], d = a.vp.displays.get(n.id), g = d.geometry, col = g.attributes.color;
	if (!col) return { vertexColors: !!d.material.vertexColors, red: 0 };
	const pos = g.attributes.position;
	let red = 0, redNotUp = 0, redUp = 0;
	for (let i = 0; i < pos.count; i += 3) {
		const r = col.getX(i), gg = col.getY(i);
		if (!(r > 0.9 && gg < 0.1)) continue;
		red++;
		const ax = pos.getX(i + 1) - pos.getX(i), ay = pos.getY(i + 1) - pos.getY(i), az = pos.getZ(i + 1) - pos.getZ(i);
		const bx = pos.getX(i + 2) - pos.getX(i), by = pos.getY(i + 2) - pos.getY(i), bz = pos.getZ(i + 2) - pos.getZ(i);
		const nz = (ax * by - ay * bx) / Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx);
		if (nz > 0.9999) redUp++; else redNotUp++;
	}
	return { vertexColors: !!d.material.vertexColors, red, redUp, redNotUp, seeds: (n.paint || []).length };
});
await clickAt([0, 0, 20]);
let p = await painted();
check('clicking the top face paints it, and only it (not the rounded edges around it)', p.vertexColors && p.redUp > 0 && p.redNotUp === 0 && p.seeds === 1, JSON.stringify(p));
await clickAt([0, 0, 20]);
p = await painted();
check('painting the same face again replaces the stroke instead of piling up', p.seeds === 1, JSON.stringify(p));
// a fillet: the rounded edge between top and front
await app(() => { window.DraftOtter.paintColor = '#0000ff'; });
await clickAt([0, -15 + 4 - 4 * Math.cos(Math.PI / 4), 20 - 4 + 4 * Math.sin(Math.PI / 4)]);
const blue = await app(() => {
	const a = window.DraftOtter, d = a.vp.displays.get(a.model.nodes[0].id), col = d.geometry.attributes.color, pos = d.geometry.attributes.position;
	let n = 0, flat = 0;
	for (let i = 0; i < pos.count; i += 3) {
		if (!(col.getZ(i) > 0.9 && col.getX(i) < 0.1)) continue;
		n++;
		const ax = pos.getX(i + 1) - pos.getX(i), ay = pos.getY(i + 1) - pos.getY(i), az = pos.getZ(i + 1) - pos.getZ(i), bx = pos.getX(i + 2) - pos.getX(i), by = pos.getY(i + 2) - pos.getY(i), bz = pos.getZ(i + 2) - pos.getZ(i);
		const l = Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx), nz = (ax * by - ay * bx) / l, ny = (az * bx - ax * bz) / l;
		if (nz > 0.9999 || ny < -0.9999) flat++;
	}
	return { n, flat, seeds: a.model.nodes[0].paint.length };
});
check('clicking a rounded edge paints the curved strip, not the big flat faces it joins', blue.n > 0 && blue.flat === 0 && blue.seeds === 2, JSON.stringify(blue));
// paint follows edits: make the box taller
await app(() => { const a = window.DraftOtter, n = a.model.nodes[0]; n.params.h = 30; n.pos = [0, 0, 15]; a.commit(); });
await wait(500);
p = await painted();
check('after making the box taller the top face is still the painted one', p.redUp > 0 && p.redNotUp === 0, JSON.stringify(p));
// export 3MF: two filaments
const model = await app(async () => {
	const a = window.DraftOtter;
	let blob = null;
	const orig = URL.createObjectURL;
	URL.createObjectURL = (b) => { blob = b; return orig.call(URL, new Blob([])); };
	try { a.doExport(a.model.nodes, 'painted', true, '3mf'); } finally { URL.createObjectURL = orig; }
	const t = new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer()));
	const m = t.slice(t.indexOf('<?xml version="1.0" encoding="UTF-8"?>\n<model'));
	const tris = [...m.matchAll(/<triangle [^>]*>/g)].map((x) => x[0]);
	const codes = {};
	for (const tr of tris) { const c = (/paint_color="(\w+)"/.exec(tr) || [0, 'none'])[1]; codes[c] = (codes[c] || 0) + 1; }
	return { bases: (m.match(/<base /g) || []).length, codes, prusa: tris.every((tr) => tr.includes('slic3rpe:mmu_segmentation=')), ns: m.includes('xmlns:slic3rpe') };
});
check('3MF export: three colors (part + red + blue), every triangle tagged with its filament for Bambu/Orca and PrusaSlicer', model.bases === 3 && model.codes['4'] > 0 && model.codes['8'] > 0 && model.codes['0C'] > 0 && !model.codes.none && model.prusa && model.ns, JSON.stringify(model));
// eraser
await app(() => { window.DraftOtter.paintMode = 'erase'; });
await clickAt([0, 0, 30]);
p = await painted();
check('the eraser takes the paint off the face clicked', p.red === 0 && p.seeds === 1, JSON.stringify(p));
await app(() => { const a = window.DraftOtter; a.paintMode = 'fill'; a.setTool(null); });
check('the paint bar closes with the tool', await app(() => document.querySelector('#paint-bar').style.display === 'none'));
// a single-color design exports without paint codes (unchanged files)
const plain = await app(async () => {
	const a = window.DraftOtter;
	delete a.model.nodes[0].paint; a.commit();
	let blob = null;
	const orig = URL.createObjectURL;
	URL.createObjectURL = (b) => { blob = b; return orig.call(URL, new Blob([])); };
	try { a.doExport(a.model.nodes, 'plain', true, '3mf'); } finally { URL.createObjectURL = orig; }
	return new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer())).includes('paint_color');
});
check('…and a one-color design has no paint codes', !plain);

// paint stays on when the part is wrapped: push/pull another face (feature group), then group it with another part
const wrapped = await app(async () => {
	const a = window.DraftOtter, vp = a.vp, C = vp.camera.position.constructor;
	a.model.doc.nodes = []; a.commit();
	a.addShape('box');
	const b = a.model.nodes[0];
	b.paint = [{ p: [0, 0, 10], n: [0, 0, 1], c: '#ff0000' }]; a.commit();
	const redTop = () => {
		const n = a.model.nodes[0], d = vp.displays.get(n.id), g = d.geometry, col = g.attributes.color, pos = g.attributes.position;
		if (!col) return { red: 0 };
		d.updateWorldMatrix(true, false);
		let red = 0, wrong = 0, topZ = -Infinity;
		const v = new C();
		for (let i = 0; i < pos.count; i++) topZ = Math.max(topZ, v.fromBufferAttribute(pos, i).applyMatrix4(d.matrixWorld).z);
		for (let i = 0; i < pos.count; i += 3) {
			if (!(col.getX(i) > 0.9 && col.getY(i) < 0.1)) continue;
			red++;
			for (let k = 0; k < 3; k++) if (Math.abs(v.fromBufferAttribute(pos, i + k).applyMatrix4(d.matrixWorld).z - topZ) > 1e-3) { wrong++; break; }
		}
		return { red, wrong };
	};
	const out = { start: redTop() };
	a.setSelection([]); a.frame(); vp.render();
	const s = vp.project(new C(0, -10, 10)), r = vp.canvas.getBoundingClientRect();
	a.setTool('pushpull');
	vp.pushPull.sel = vp.pushPull.pickFace({ clientX: r.left + s.x, clientY: r.top + s.y });
	vp.pushPull.distance = 3;
	a.applyPushPull();
	a.setTool(null);
	out.pushpull = { tree: a.model.nodes[0].type, ...redTop() };
	a.addShape('cylinder');
	a.setSelection(a.model.nodes.map((n) => n.id)); a.group('union');
	out.grouped = { tree: a.model.nodes[0].children.length, ...redTop() };
	let blob = null;
	const orig = URL.createObjectURL;
	URL.createObjectURL = (bb) => { blob = bb; return orig.call(URL, new Blob([])); };
	try { a.doExport(a.model.nodes, 'wrapped', true, '3mf'); } finally { URL.createObjectURL = orig; }
	out.exportPainted = new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer())).includes('paint_color="8"');
	return out;
});
check('paint stays on the part (and on the right face) after push/pull wraps it in a feature group', wrapped.pushpull.tree === 'group' && wrapped.pushpull.red > 0 && wrapped.pushpull.wrong === 0, JSON.stringify(wrapped));
check('…and after grouping it with another part, including in the 3MF export', wrapped.grouped.red > 0 && wrapped.grouped.wrong === 0 && wrapped.exportPainted, JSON.stringify(wrapped));

// ---------------------------------------------------------------- auto-orient
// a cone standing on its tip (needs lots of support); best is on its base
const cone = await app(async () => {
	const a = window.DraftOtter;
	a.model.doc.nodes = []; a.commit();
	a.addShape('cone');
	const n = a.model.nodes[0];
	n.rot = [180, 0, 0]; a.commit();
	a.dropToBed();
	a.setSelection([n.id]);
	a.autoOrientDialog();
	return { rows: document.querySelectorAll('.orient-opt').length, first: document.querySelector('.orient-opt').textContent };
});
await modalBtn('Apply');
await wait(400);
const after = await app(() => {
	const a = window.DraftOtter, n = a.model.nodes[0], g = a.engine.geometry(n), M = a.worldMatrix(n), pos = g.attributes.position;
	const THREE = { V: a.vp.camera.position.constructor };
	let minZ = Infinity, flatDown = 0;
	const v = new THREE.V(), w = new THREE.V(), u = new THREE.V();
	for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i).applyMatrix4(M); minZ = Math.min(minZ, v.z); }
	for (let i = 0; i < pos.count; i += 3) {
		v.fromBufferAttribute(pos, i).applyMatrix4(M); w.fromBufferAttribute(pos, i + 1).applyMatrix4(M); u.fromBufferAttribute(pos, i + 2).applyMatrix4(M);
		const nrm = w.clone().sub(v).cross(u.clone().sub(v));
		if (nrm.z < 0 && Math.abs(nrm.z) / nrm.length() > 0.999 && Math.max(v.z, w.z, u.z) < minZ + 0.05) flatDown += nrm.length() / 2;
	}
	return { minZ: +minZ.toFixed(3), flatDown: +flatDown.toFixed(1) };
});
check('auto-orient lists options, best first', cone.rows >= 2 && /^Best/.test(cone.first), JSON.stringify(cone));
check('…and Apply sets the cone on its flat base, sitting on the bed', after.flatDown > 100 && Math.abs(after.minZ) < 1e-3, JSON.stringify(after));

// ---------------------------------------------------------------- arrange
const arr = await app(() => {
	const a = window.DraftOtter;
	a.model.doc.nodes = []; a.commit();
	for (let i = 0; i < 8; i++) { a.addShape('box'); const n = a.model.nodes[i]; n.params.w = 20 + i * 6; n.params.d = 15 + (i % 3) * 10; n.pos = [0, 0, 10]; }
	a.addShape('cylinder');
	a.commit();
	a.setSelection([]);
	a.arrangeOnBed(a.model.nodes.slice(), { gap: 5, rotate: true });
	const bed = a.model.settings.bed;
	const boxes = a.model.nodes.map((n) => a.worldBox(n));
	let overlap = 0, minGap = Infinity, off = 0;
	for (let i = 0; i < boxes.length; i++) {
		const b = boxes[i];
		if (b.min.x < -bed.w / 2 - 1e-6 || b.max.x > bed.w / 2 + 1e-6 || b.min.y < -bed.d / 2 - 1e-6 || b.max.y > bed.d / 2 + 1e-6) off++;
		for (let j = i + 1; j < boxes.length; j++) {
			const c = boxes[j];
			const gx = Math.max(c.min.x - b.max.x, b.min.x - c.max.x), gy = Math.max(c.min.y - b.max.y, b.min.y - c.max.y);
			const gap = Math.max(gx, gy);
			if (gap < 0) overlap++;
			minGap = Math.min(minGap, gap);
		}
	}
	return { n: boxes.length, overlap, off, minGap: +minGap.toFixed(3) };
});
check('arrange packs 9 parts on the bed with no overlaps and at least the gap between them', arr.n === 9 && arr.overlap === 0 && arr.off === 0 && arr.minGap >= 5 - 1e-3, JSON.stringify(arr));
const tooMany = await app(() => {
	const a = window.DraftOtter;
	a.model.doc.nodes = []; a.commit();
	for (let i = 0; i < 3; i++) { a.addShape('box'); const n = a.model.nodes[i]; n.params.w = 200; n.params.d = 200; }
	a.commit();
	return a.arrangeOnBed(a.model.nodes.slice(), { gap: 5 });
});
check('parts that do not fit are counted out (and put beside the bed)', tooMany === 1, String(tooMany));

// ---------------------------------------------------------------- image with colors
await app(async () => {
	const a = window.DraftOtter; a.model.doc.nodes = []; a.commit();
	const c = document.createElement('canvas'); c.width = 400; c.height = 300;
	const g = c.getContext('2d');
	g.fillStyle = '#ffffff'; g.fillRect(0, 0, 400, 300);
	g.fillStyle = '#e02020'; g.beginPath(); g.arc(120, 150, 80, 0, Math.PI * 2); g.fill();
	g.fillStyle = '#2050e0'; g.fillRect(230, 70, 140, 160);
	g.fillStyle = '#20a040'; g.fillRect(270, 110, 60, 80); // green inside the blue
	const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
	a.importImageFile(new File([blob], 'flag.png', { type: 'image/png' }));
});
await page.waitForSelector('#it-info');
await app(() => { const k = document.querySelector('#it-keep'); k.checked = true; k.dispatchEvent(new Event('change')); });
await wait(600);
const it = await app(() => ({ info: document.querySelector('#it-info').textContent, thrHidden: document.querySelector('#it-thr').closest('.row').style.display === 'none' }));
check('Keep colors finds the three colors (white background left out)', /^3 colors/.test(it.info) && it.thrHidden, JSON.stringify(it));
await page.screenshot({ path: 'test/shots/670-image-colors.png' });
await modalBtn('Import');
await wait(800);
const parts = await app(() => {
	const a = window.DraftOtter;
	return a.model.nodes.map((n) => { const b = a.worldBox(n); return { color: n.color, z: +b.min.z.toFixed(3), vol: Math.round(a.engine.stats([n]).volume) }; });
});
const near = (hex, r, g, b) => { const v = parseInt(hex.slice(1), 16); return Math.abs((v >> 16) - r) < 40 && Math.abs(((v >> 8) & 255) - g) < 40 && Math.abs((v & 255) - b) < 40; };
const hasRed = parts.some((p) => near(p.color, 0xe0, 0x20, 0x20)), hasBlue = parts.some((p) => near(p.color, 0x20, 0x50, 0xe0)), hasGreen = parts.some((p) => near(p.color, 0x20, 0xa0, 0x40));
check('…and imports one part per color, in that color, sitting on the bed', parts.length === 3 && hasRed && hasBlue && hasGreen && parts.every((p) => p.z === 0 && p.vol > 0), JSON.stringify(parts));
// blue has the green cut out of it (no overlap): blue area ≈ 140×160 − 60×80 px at 0.125 mm/px, 3 mm tall
const blueVol = parts.find((p) => near(p.color, 0x20, 0x50, 0xe0)).vol, expect = (140 * 160 - 60 * 80) * 0.125 * 0.125 * 3;
check('…the blue part has a hole where the green part sits (colors do not overlap)', Math.abs(blueVol - expect) / expect < 0.05, `${blueVol} vs ${Math.round(expect)}`);

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'browser67: all passed');
process.exit(fails ? 1 : 0);
