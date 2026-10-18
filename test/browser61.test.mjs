// 3MF import: a Bambu Studio–style project (compressed, objects in separate model files, component transforms, names
// in the project settings), a plain model in inches with a color, and a round trip through DraftOtter's own 3MF export.
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
import { deflateRawSync, crc32 } from 'node:zlib';
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

// a zip with deflated entries (as slicers write them)
function zip(files) {
	const parts = [], central = [];
	let off = 0;
	for (const [name, text] of Object.entries(files)) {
		const raw = Buffer.from(text), data = deflateRawSync(raw), nm = Buffer.from(name), crc = crc32(raw) >>> 0;
		const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(8, 8); h.writeUInt32LE(crc, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(raw.length, 22); h.writeUInt16LE(nm.length, 26);
		const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10); c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(nm.length, 28); c.writeUInt32LE(off, 42);
		parts.push(h, nm, data); central.push(c, nm);
		off += 30 + nm.length + data.length;
	}
	const cd = Buffer.concat(central), e = Buffer.alloc(22);
	e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(central.length / 2, 8); e.writeUInt16LE(central.length / 2, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
	return Buffer.concat([...parts, cd, e]).toString('base64');
}
// a cube mesh (size s, corner at the origin) as 3MF vertices / triangles
const cube = (s) => {
	const v = [[0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0], [0, 0, s], [s, 0, s], [s, s, s], [0, s, s]];
	const t = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
	return `<mesh><vertices>${v.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices><triangles>${t.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh>`;
};
const NS = 'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"';
const rels = '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>';
const types = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>';

// Bambu-style: two objects, each a component pointing into 3D/Objects/object_1.model, placed by build transforms
const bambu = zip({
	'[Content_Types].xml': types,
	'_rels/.rels': rels,
	'3D/3dmodel.model': `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" ${NS}><resources>
		<object id="2" type="model"><components><component p:path="/3D/Objects/object_1.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/></components></object>
		<object id="4" type="model"><components><component p:path="/3D/Objects/object_1.model" objectid="3" transform="2 0 0 0 1 0 0 0 1 0 0 0"/></components></object>
		</resources><build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 100 100 0"/><item objectid="4" transform="1 0 0 0 1 0 0 0 1 140 100 0"/></build></model>`,
	'3D/Objects/object_1.model': `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" ${NS}><resources><object id="1" type="model">${cube(20)}</object><object id="3" type="model">${cube(10)}</object></resources></model>`,
	'Metadata/model_settings.config': '<?xml version="1.0" encoding="UTF-8"?><config><object id="2"><metadata key="name" value="Gear housing"/></object><object id="4"><metadata key="name" value="Lid clip"/></object></config>',
});
// a plain model in inches, colored
const inches = zip({
	'[Content_Types].xml': types,
	'_rels/.rels': rels,
	'3D/3dmodel.model': `<?xml version="1.0" encoding="UTF-8"?><model unit="inch" ${NS}><resources><basematerials id="9"><base name="Red PLA" displaycolor="#C81E1EFF"/></basematerials>
		<object id="1" type="model" name="Inch cube" pid="9" pindex="0">${cube(1)}</object></resources><build><item objectid="1"/></build></model>`,
});

const importB64 = (b64, name) => page.evaluate(async ([b64, name]) => {
	const a = window.DraftOtter;
	a.model.doc.nodes = []; a.commit();
	const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
	await a.import3MF([new File([bytes], name)]);
	return a.model.nodes.map((n) => { const b = a.worldBox(n), s = b.getSize(new b.min.constructor()); return { name: n.name, type: n.type, color: n.color, size: s.toArray().map((v) => +v.toFixed(3)), min: b.min.toArray().map((v) => +v.toFixed(3)), vol: +a.engine.stats([n]).volume.toFixed(3) }; });
}, [b64, name]);

let parts = await importB64(bambu, 'project.3mf');
check('a Bambu-style project imports one part per object, named from its project settings', parts.length === 2 && parts[0].name === 'Gear housing' && parts[1].name === 'Lid clip' && parts.every((p) => p.type === 'mesh'), JSON.stringify(parts));
check('…components in other model files and their transforms are followed (the clip is stretched 2× in X)', parts[0].size.join() === '20,20,20' && parts[1].size.join() === '20,10,10' && Math.abs(parts[0].vol - 8000) < 0.01 && Math.abs(parts[1].vol - 2000) < 0.01, JSON.stringify(parts.map((p) => [p.size, p.vol])));
check('…they keep their layout from the plate, standing on the bed', Math.abs(parts[1].min[0] - parts[0].min[0] - 40) < 1e-3 && Math.abs(parts[1].min[1] - parts[0].min[1]) < 1e-3 && parts.every((p) => Math.abs(p.min[2]) < 1e-6), JSON.stringify(parts.map((p) => p.min)));

parts = await importB64(inches, 'inch.3mf');
check('a model in inches comes in at the right size (1 in = 25.4 mm), with its name and color', parts.length === 1 && parts[0].name === 'Inch cube' && parts[0].size.every((v) => Math.abs(v - 25.4) < 1e-3) && parts[0].color === '#c81e1e', JSON.stringify(parts));

// round trip: DraftOtter's own 3MF export (two colored parts) back in
const round = await page.evaluate(async () => {
	const a = window.DraftOtter;
	a.model.doc.nodes = []; a.commit();
	a.addShape('box'); a.addShape('cylinder');
	const [b, c] = a.model.nodes;
	b.name = 'Base'; b.color = '#3366cc'; Object.assign(b.params, { w: 30, d: 20, h: 10 }); b.pos = [0, 0, 5];
	c.name = 'Peg'; c.color = '#22aa44'; Object.assign(c.params, { r: 4, h: 12, seg: 48 }); c.pos = [40, 0, 6];
	a.commit();
	const before = a.model.nodes.map((n) => +a.engine.stats([n]).volume.toFixed(2));
	const { build3MF } = window.__lcadTest || {};
	let bytes = null;
	const orig = URL.createObjectURL;
	URL.createObjectURL = (blob) => { bytes = blob; return orig.call(URL, new Blob([])); };
	try { a.doExport(a.model.nodes, 'pair', true, '3mf'); } finally { URL.createObjectURL = orig; }
	const data = new Uint8Array(await bytes.arrayBuffer());
	a.model.doc.nodes = []; a.commit();
	await a.import3MF([new File([data], 'pair.3mf')]);
	return { before, after: a.model.nodes.map((n) => ({ name: n.name, color: n.color, vol: +a.engine.stats([n]).volume.toFixed(2) })) };
});
check('DraftOtter\'s own 3MF export comes back in with names, colors and shapes', round.after.length === 2 && round.after[0].name === 'Base' && round.after[1].name === 'Peg' && round.after[0].color === '#3366cc' && round.after[1].color === '#22aa44' && round.after.every((p, i) => Math.abs(p.vol - round.before[i]) < 0.05), JSON.stringify(round));

// a file that isn't a 3MF says so instead of failing silently
const bad = await page.evaluate(async () => {
	const a = window.DraftOtter; a.model.doc.nodes = []; a.commit();
	await a.import3MF([new File([new Uint8Array([1, 2, 3, 4])], 'broken.3mf')]);
	return { n: a.model.nodes.length, toast: [...document.querySelectorAll('.toast')].map((t) => t.textContent).pop() };
});
check('a broken file shows a clear message and adds nothing', bad.n === 0 && /Could not import broken\.3mf/.test(bad.toast || ''), JSON.stringify(bad));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'browser61: all passed');
process.exit(fails ? 1 : 0);
