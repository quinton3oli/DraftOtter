// 3MF writer: one mesh object per part with its name and color (basematerials), millimeter units. When the design
// has more than one color (parts in different colors, or faces painted), every triangle also gets its color as a
// filament number the way Bambu Studio / Orca (paint_color) and PrusaSlicer (mmu_segmentation) store painting, so the
// slicer opens it already split over filaments 1, 2, 3… in the order of the palette.
import { makeZip } from './zip.js';

const esc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
const num = (v) => { const r = Math.round(v * 1e5) / 1e5; return Object.is(r, -0) ? '0' : String(r); };

function hexColor(c) {
	let h = String(c || '#cccccc').replace('#', '');
	if (h.length === 3) h = h.split('').map((x) => x + x).join('');
	return '#' + h.slice(0, 6).toUpperCase() + 'FF';
}

/** Weld a non-indexed position array into vertices + triangles (drops degenerate triangles). */
function weld(positions) {
	const map = new Map(), verts = [], tris = [], from = [];
	const id = (i) => {
		const x = positions[i], y = positions[i + 1], z = positions[i + 2];
		const k = Math.round(x * 1e5) + ',' + Math.round(y * 1e5) + ',' + Math.round(z * 1e5);
		let v = map.get(k);
		if (v === undefined) { v = verts.length / 3; verts.push(x, y, z); map.set(k, v); }
		return v;
	};
	for (let i = 0; i < positions.length; i += 9) {
		const a = id(i), b = id(i + 3), c = id(i + 6);
		if (a !== b && b !== c && a !== c) { tris.push(a, b, c); from.push(i / 9); }
	}
	return { verts, tris, from };
}

/** A filament number (1-based) as the slicers' triangle painting code: a whole triangle in that state. */
export function paintCode(k) {
	return k < 3 ? (k * 4).toString(16).toUpperCase() : (k - 3).toString(16).toUpperCase() + 'C';
}

const key = (c) => hexColor(c);

/**
 * parts: [{ name, color, positions (non-indexed Float32Array, world mm), triColors? (color or null per triangle) }]
 * Returns the .3mf file bytes.
 */
export function build3MF(parts, { title = 'DraftOtter design' } = {}) {
	const objs = [], items = [];
	// the palette: part colors first, then painted colors
	const palette = [], at = new Map();
	const idx = (c) => { const k = key(c); if (!at.has(k)) { at.set(k, palette.length); palette.push(k); } return at.get(k); };
	for (const p of parts) idx(p.color);
	for (const p of parts) if (p.triColors) for (const c of p.triColors) if (c) idx(c);
	const multi = palette.length > 1;
	const mats = palette.map((c, i) => `<base name="Color ${i + 1}" displaycolor="${c}"/>`);
	parts.forEach((p, i) => {
		const { verts, tris, from } = weld(p.positions);
		const base = idx(p.color);
		if (!tris.length) return;
		const id = i + 2;
		const v = [], t = [];
		for (let k = 0; k < verts.length; k += 3) v.push(`<vertex x="${num(verts[k])}" y="${num(verts[k + 1])}" z="${num(verts[k + 2])}"/>`);
		for (let k = 0; k < tris.length; k += 3) {
			let extra = '';
			if (multi) {
				const c = p.triColors && p.triColors[from[k / 3]];
				const m = c ? idx(c) : base, code = paintCode(m + 1);
				extra = (m !== base ? ` pid="1" p1="${m}"` : '') + ` paint_color="${code}" slic3rpe:mmu_segmentation="${code}"`;
			}
			t.push(`<triangle v1="${tris[k]}" v2="${tris[k + 1]}" v3="${tris[k + 2]}"${extra}/>`);
		}
		objs.push(`<object id="${id}" type="model" name="${esc(p.name)}" pid="1" pindex="${base}"><mesh><vertices>${v.join('')}</vertices><triangles>${t.join('')}</triangles></mesh></object>`);
		items.push(`<item objectid="${id}"/>`);
	});
	const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06">
<metadata name="Title">${esc(title)}</metadata>
<metadata name="Application">DraftOtter</metadata>
<resources>
<basematerials id="1">${mats.join('')}</basematerials>
${objs.join('\n')}
</resources>
<build>${items.join('')}</build>
</model>`;
	const types = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`;
	const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;
	return makeZip([
		{ name: '[Content_Types].xml', data: types },
		{ name: '_rels/.rels', data: rels },
		{ name: '3D/3dmodel.model', data: model },
	]);
}
