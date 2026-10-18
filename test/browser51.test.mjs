// Mesh import (OBJ, GLB) and image → relief / lithophane.
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';
mkdirSync('test/shots', { recursive: true });
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
const modalBtn = (label) => app((label) => [...document.querySelectorAll('.modal .btn')].find((b) => b.textContent.trim() === label).click(), label);
const parts = () => app(() => window.DraftOtter.model.nodes.map((n) => { const a = window.DraftOtter, b = a.worldBox(n); return { type: n.type, name: n.name, size: [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z].map((v) => +v.toFixed(3)), vol: +a.engine.stats([n]).volume.toFixed(1) }; }));
const reset = () => app(() => { localStorage.clear(); const a = window.DraftOtter; a.model.doc.nodes = []; a.commit(); });

// a box 1 × 2 × 0.5 (x, y, z) with Y up, as an OBJ (the usual export of AI image-to-3D tools is Y-up)
const box = (sx, sy, sz, ox = 0) => {
	const v = [];
	for (const z of [0, sz]) for (const y of [0, sy]) for (const x of [0, sx]) v.push([x + ox, y, z]);
	const f = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
	return { v, f };
};
const obj = (() => { const b = box(1, 2, 0.5); return b.v.map((p) => `v ${p.join(' ')}`).join('\n') + '\n' + b.f.map((q) => `f ${q.map((i) => i + 1).join(' ')}`).join('\n') + '\n'; })();

await reset();
await app((text) => window.DraftOtter.importMeshFile(new File([text], 'figurine.obj')), obj);
await page.waitForSelector('#mi-size');
const objInfo = await app(() => document.querySelector('.modal .form p').textContent);
check('OBJ: the dialog reports meshes, triangles and size, and suggests 50 mm for a tiny model', /1 mesh, 12 triangles/.test(objInfo) && (await app(() => document.querySelector('#mi-size').value)) === '50', objInfo);
await modalBtn('Import');
await wait(400);
let p = await parts();
check('OBJ imported Y-up → stands on Z, scaled so the longest side is 50 mm', p.length === 1 && p[0].type === 'mesh' && p[0].name === 'figurine' && Math.abs(p[0].size[2] - 50) < 1e-3 && Math.abs(p[0].size[0] - 25) < 1e-3 && Math.abs(p[0].size[1] - 12.5) < 1e-3, JSON.stringify(p));
check('…as a solid with the right volume (25 × 12.5 × 50)', Math.abs(p[0].vol - 25 * 12.5 * 50) < 1, String(p[0].vol));

// a GLB with two cubes (built here: JSON chunk + binary chunk)
const glb = (() => {
	const meshes = [box(1, 1, 1), box(1, 1, 1, 2)];
	const bufs = [], json = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0, 1] }], nodes: [], meshes: [], accessors: [], bufferViews: [], buffers: [] };
	let off = 0;
	meshes.forEach((m, k) => {
		const pos = new Float32Array(m.v.flat());
		const idx = new Uint16Array(m.f.flatMap((q) => [q[0], q[1], q[2], q[0], q[2], q[3]]));
		const min = [0, 1, 2].map((i) => Math.min(...m.v.map((p) => p[i]))), max = [0, 1, 2].map((i) => Math.max(...m.v.map((p) => p[i])));
		json.bufferViews.push({ buffer: 0, byteOffset: off, byteLength: pos.byteLength }); bufs.push(Buffer.from(pos.buffer)); off += pos.byteLength;
		json.bufferViews.push({ buffer: 0, byteOffset: off, byteLength: idx.byteLength }); bufs.push(Buffer.from(idx.buffer)); off += idx.byteLength;
		const pad = (4 - (off % 4)) % 4; if (pad) { bufs.push(Buffer.alloc(pad)); off += pad; }
		json.accessors.push({ bufferView: 2 * k, componentType: 5126, count: m.v.length, type: 'VEC3', min, max });
		json.accessors.push({ bufferView: 2 * k + 1, componentType: 5123, count: idx.length, type: 'SCALAR' });
		json.meshes.push({ name: 'Cube ' + (k + 1), primitives: [{ attributes: { POSITION: 2 * k }, indices: 2 * k + 1 }] });
		json.nodes.push({ mesh: k, name: 'Cube ' + (k + 1) });
	});
	const bin = Buffer.concat(bufs); json.buffers.push({ byteLength: bin.length });
	let js = Buffer.from(JSON.stringify(json)); const jpad = (4 - (js.length % 4)) % 4; js = Buffer.concat([js, Buffer.alloc(jpad, 0x20)]);
	const head = Buffer.alloc(12); head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + js.length + 8 + bin.length, 8);
	const ch = (len, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b; };
	return [...Buffer.concat([head, ch(js.length, 0x4e4f534a), js, ch(bin.length, 0x004e4942), bin])];
})();
await reset();
await app((bytes) => window.DraftOtter.importMeshFile(new File([new Uint8Array(bytes)], 'pieces.glb')), glb);
await page.waitForSelector('#mi-merge');
const glbInfo = await app(() => document.querySelector('.modal .form p').textContent);
check('GLB: two meshes found (sizes in meters)', /2 meshes, 24 triangles/.test(glbInfo) && /meters/.test(glbInfo), glbInfo);
await app(() => { const m = document.querySelector('#mi-merge'); m.checked = false; document.querySelector('#mi-size').value = '30'; });
await modalBtn('Import');
await wait(400);
p = await parts();
check('GLB imported as two parts, 30 mm overall (each cube 10 mm)', p.length === 2 && p.every((q) => q.size.every((s) => Math.abs(s - 10) < 1e-3)) && p.map((q) => q.name).sort().join() === 'Cube 1,Cube 2', JSON.stringify(p));

// lithophane from a left-black → right-white gradient (200 × 100 px)
await reset();
await app(async () => {
	const c = document.createElement('canvas'); c.width = 200; c.height = 100;
	const g = c.getContext('2d'), gr = g.createLinearGradient(0, 0, 200, 0); gr.addColorStop(0, '#000'); gr.addColorStop(1, '#fff');
	g.fillStyle = gr; g.fillRect(0, 0, 200, 100);
	window.__grad = new File([await new Promise((r) => c.toBlob(r, 'image/png'))], 'gradient.png', { type: 'image/png' });
	window.DraftOtter.importRelief(window.__grad);
});
await page.waitForSelector('#rl-info');
await app(() => { const set = (id, v) => { const i = document.querySelector('#' + id); i.value = v; i.dispatchEvent(new Event('change')); }; set('rl-w', '100'); set('rl-min', '0.8'); set('rl-max', '3'); set('rl-frame', '0'); const s = document.querySelector('#rl-smooth'); s.value = 0; s.dispatchEvent(new Event('input')); });
await wait(200);
const rlInfo = await app(() => document.querySelector('#rl-info').textContent);
check('relief dialog shows size, thickness range and triangles', /100 × 49\.\d mm/.test(rlInfo) && /0\.8–3 mm thick/.test(rlInfo), rlInfo);
await page.screenshot({ path: 'test/shots/410-lithophane.png' });
await modalBtn('Create');
await wait(500);
p = await parts();
const lith = p[0];
check('lithophane: a mesh 100 mm wide, 0.8 to 3 mm thick', lith && lith.type === 'mesh' && /lithophane/.test(lith.name) && Math.abs(lith.size[0] - 100) < 1e-3 && Math.abs(lith.size[2] - 3) < 0.01, JSON.stringify(lith));
check('…dark side thick, light side thin: volume ≈ 100 × 49.75 × 1.9', lith && Math.abs(lith.vol - 100 * 49.75 * 1.9) / (100 * 49.75 * 1.9) < 0.03, String(lith && lith.vol));
const solid = await app(() => { const a = window.DraftOtter, n = a.model.nodes[0]; a.addShape('cylinder'); const c = a.model.nodes[1]; c.hole = true; c.params.r = 5; c.params.h = 20; c.pos = [0, 0, 1]; const m = n; m.pos = [0, 0, 0]; a.commit(); a.setSelection([m.id, c.id]); a.group(); const g = a.model.nodes[0]; return { err: a.engine.errors.has(g.id), vol: a.engine.stats([g]).volume }; });
check('…and watertight: a hole can be cut through it', !solid.err && solid.vol < lith.vol - 100, JSON.stringify(solid));

// relief with a frame
await reset();
await app(() => window.DraftOtter.importRelief(window.__grad));
await page.waitForSelector('#rl-info');
await app(() => { const m = document.querySelector('#rl-mode'); m.value = 'light'; m.dispatchEvent(new Event('change')); const set = (id, v) => { const i = document.querySelector('#' + id); i.value = v; i.dispatchEvent(new Event('change')); }; set('rl-w', '60'); set('rl-frame', '4'); });
await wait(200);
await modalBtn('Create');
await wait(500);
p = await parts();
check('relief (light parts up) with a frame: 60 mm wide, as tall as its thickest setting', p[0] && /relief/.test(p[0].name) && Math.abs(p[0].size[0] - 60) < 1e-3 && Math.abs(p[0].size[2] - 4) < 0.01, JSON.stringify(p[0]));

// dropping an image asks what it should become
await app(() => {
	const dt = new DataTransfer(); dt.items.add(window.__grad);
	const vp = document.querySelector('#viewport'), r = vp.getBoundingClientRect();
	vp.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 200, clientY: r.top + 200 }));
});
await page.waitForSelector('#drop-relief', { timeout: 5000 }).catch(() => null);
check('dropping an image offers traced outline or relief', await app(() => !!document.querySelector('#drop-sketch') && !!document.querySelector('#drop-relief')));
await app(() => document.querySelector('#drop-relief').click());
await page.waitForSelector('#rl-info', { timeout: 5000 }).catch(() => null);
check('…and choosing relief opens the relief dialog', await app(() => !!document.querySelector('#rl-info') && !document.querySelector('#drop-relief')));
await modalBtn('Cancel');

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'browser51: all passed');
process.exit(fails ? 1 : 0);
