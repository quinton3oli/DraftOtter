// Read 3MF files (slicer projects and models from Printables / MakerWorld / Thingiverse): every printed object becomes
// a mesh part with its name and color, placed as on the file's plate. Handles compressed zips, objects built from
// components, components stored in other model files (Bambu Studio / Orca / PrusaSlicer projects) and units.

const UNITS = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 };

export const is3MF = (f) => /\.3mf$/i.test(f.name);

/** All files in a zip (stored or deflated), read through its central directory. Returns { path: Uint8Array }. */
export async function unzip(bytes) {
	const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
	let eocd = -1;
	for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
	if (eocd < 0) throw new Error('not a zip file');
	const count = dv.getUint16(eocd + 10, true);
	let p = dv.getUint32(eocd + 16, true);
	const dec = new TextDecoder(), out = {};
	for (let k = 0; k < count && dv.getUint32(p, true) === 0x02014b50; k++) {
		const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
		const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), local = dv.getUint32(p + 42, true);
		const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen)).replace(/^\//, '');
		p += 46 + nlen + xlen + clen;
		if (name.endsWith('/')) continue;
		const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
		const data = u8.subarray(start, start + csize);
		if (method === 0) out[name] = data;
		else if (method === 8) out[name] = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
	}
	return out;
}

const byTag = (node, tag) => [...node.getElementsByTagNameNS('*', tag)];
const attr = (el, name) => {
	if (el.hasAttribute(name)) return el.getAttribute(name);
	for (const a of el.attributes) if (a.localName === name) return a.value; // namespaced (p:path, p:UUID)
	return null;
};

// 3MF transforms: 12 numbers, a 3×4 matrix applied as [x y z 1] · M
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
const parseTransform = (s) => { const m = (s || '').trim().split(/\s+/).map(Number); return m.length === 12 && m.every(Number.isFinite) ? m : IDENTITY; };
const mul = (a, b) => [ // a then b
	a[0] * b[0] + a[1] * b[3] + a[2] * b[6], a[0] * b[1] + a[1] * b[4] + a[2] * b[7], a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
	a[3] * b[0] + a[4] * b[3] + a[5] * b[6], a[3] * b[1] + a[4] * b[4] + a[5] * b[7], a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
	a[6] * b[0] + a[7] * b[3] + a[8] * b[6], a[6] * b[1] + a[7] * b[4] + a[8] * b[7], a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
	a[9] * b[0] + a[10] * b[3] + a[11] * b[6] + b[9], a[9] * b[1] + a[10] * b[4] + a[11] * b[7] + b[10], a[9] * b[2] + a[10] * b[5] + a[11] * b[8] + b[11],
];

function colorOf(c) {
	const m = /^#?([0-9a-f]{6})/i.exec(c || '');
	return m ? '#' + m[1].toLowerCase() : null;
}

/**
 * Parse a 3MF: { parts: [{ name, color, positions: Float32Array (triangle soup, mm, plate coordinates) }], title }.
 */
export async function parse3MF(bytes) {
	const files = await unzip(bytes);
	const dec = new TextDecoder();
	const xml = (path) => { const f = files[path]; return f ? new DOMParser().parseFromString(dec.decode(f), 'application/xml') : null; };
	// the main model: named in _rels/.rels, usually 3D/3dmodel.model
	let rootPath = '3D/3dmodel.model';
	const rels = xml('_rels/.rels');
	if (rels) for (const r of byTag(rels, 'Relationship')) if (/3dmodel$/.test(r.getAttribute('Type') || '')) rootPath = (r.getAttribute('Target') || rootPath).replace(/^\//, '');
	const root = xml(rootPath);
	if (!root) throw new Error('no 3D model inside (not a 3MF?)');
	const models = new Map(); // path → { scale, objects: Map(id → el), materials: Map(id → [colors]) }
	const load = (path) => {
		if (models.has(path)) return models.get(path);
		const doc = path === rootPath ? root : xml(path);
		if (!doc) return null;
		const model = byTag(doc, 'model')[0] || doc.documentElement;
		const m = { path, doc, scale: UNITS[(model.getAttribute('unit') || 'millimeter').toLowerCase()] || 1, objects: new Map(), materials: new Map() };
		for (const o of byTag(doc, 'object')) m.objects.set(o.getAttribute('id'), o);
		for (const b of byTag(doc, 'basematerials')) m.materials.set(b.getAttribute('id'), byTag(b, 'base').map((x) => colorOf(x.getAttribute('displaycolor'))));
		for (const g of byTag(doc, 'colorgroup')) m.materials.set(g.getAttribute('id'), byTag(g, 'color').map((x) => colorOf(x.getAttribute('color'))));
		models.set(path, m);
		return m;
	};
	const main = load(rootPath);
	// an object's triangles in its parent's frame, following components (possibly into other files)
	const collect = (m, id, T, out, depth = 0) => {
		const o = m && m.objects.get(id);
		if (!o || depth > 16) return;
		const mesh = byTag(o, 'mesh')[0];
		if (mesh) {
			const V = byTag(mesh, 'vertex').map((v) => [+v.getAttribute('x'), +v.getAttribute('y'), +v.getAttribute('z')]);
			const tris = byTag(mesh, 'triangle');
			const s = m.scale, at = (i) => { const [x, y, z] = V[i] || [0, 0, 0]; return [(x * T[0] + y * T[3] + z * T[6] + T[9]) * s, (x * T[1] + y * T[4] + z * T[7] + T[10]) * s, (x * T[2] + y * T[5] + z * T[8] + T[11]) * s]; };
			for (const t of tris) out.push(...at(+t.getAttribute('v1')), ...at(+t.getAttribute('v2')), ...at(+t.getAttribute('v3')));
			return;
		}
		for (const c of byTag(o, 'component')) {
			const path = attr(c, 'path');
			const sub = path ? load(path.replace(/^\//, '')) : m;
			collect(sub, c.getAttribute('objectid'), mul(parseTransform(c.getAttribute('transform')), T), out, depth + 1);
		}
	};
	const colorFor = (m, o) => {
		const pid = o && o.getAttribute('pid');
		const list = pid && m.materials.get(pid);
		return list ? list[+(o.getAttribute('pindex') || 0)] || list[0] || null : null;
	};
	const parts = [];
	const items = byTag(root, 'item');
	const ids = items.length ? items.map((it) => ({ id: it.getAttribute('objectid'), T: parseTransform(it.getAttribute('transform')), name: attr(it, 'name') }))
		: [...main.objects.keys()].map((id) => ({ id, T: IDENTITY, name: null }));
	ids.forEach(({ id, T, name }, i) => {
		const out = [];
		collect(main, id, T, out);
		if (out.length < 9) return;
		const o = main.objects.get(id);
		parts.push({ id, name: name || (o && o.getAttribute('name')) || `Part ${i + 1}`, color: colorFor(main, o), positions: new Float32Array(out) });
	});
	// names given in slicer project settings (Bambu Studio / Orca / PrusaSlicer write them there)
	const cfg = files['Metadata/model_settings.config'] || files['Metadata/Slic3r_PE_model.config'];
	if (cfg) {
		const doc = new DOMParser().parseFromString(dec.decode(cfg), 'application/xml');
		const names = new Map();
		for (const o of byTag(doc, 'object')) {
			const meta = byTag(o, 'metadata').find((md) => md.getAttribute('key') === 'name' && md.parentNode === o);
			if (meta) names.set(o.getAttribute('id'), meta.getAttribute('value'));
		}
		for (const pt of parts) if (names.has(pt.id) && /^Part \d+$/.test(pt.name)) pt.name = names.get(pt.id);
	}
	const titleEl = byTag(root, 'metadata').find((md) => md.getAttribute('name') === 'Title');
	return { parts, title: titleEl ? titleEl.textContent : null };
}
