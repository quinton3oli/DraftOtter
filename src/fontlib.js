// Fonts for 3D text: the two built-in Helvetiker faces plus the bundled Fontsource families (see fonts/catalog.js).
// A font key is 'regular' / 'bold' (Helvetiker) or '<family id>' / '<family id>:bold'.
// Faces are decoded and converted to three.js Font objects on first use, then cached.
import opentype from 'opentype.js';
import { Font } from 'three/examples/jsm/loaders/FontLoader.js';
import fontRegular from './fonts/helvetiker_regular.typeface.json';
import fontBold from './fonts/helvetiker_bold.typeface.json';
import { CATALOG } from './fonts/catalog.js';

export { CATALOG };
export const BUILTIN = [{ id: 'helvetiker', label: 'Helvetiker', cat: 'Sans', builtin: true, faces: { regular: true, bold: true } }];
const cache = new Map([['regular', new Font(fontRegular)], ['bold', new Font(fontBold)]]);

/** Split a font key into its family entry and style. */
export function parseFontKey(key) {
	if (!key || key === 'regular' || key === 'bold') return { fam: BUILTIN[0], style: key === 'regular' ? 'regular' : 'bold' };
	const [id, style] = String(key).split(':');
	const fam = CATALOG.find((f) => f.id === id);
	if (!fam) return { fam: BUILTIN[0], style: 'bold' };
	return { fam, style: style === 'bold' && fam.faces.bold ? 'bold' : 'regular' };
}

export function fontKey(famId, style) {
	if (famId === 'helvetiker') return style === 'bold' ? 'bold' : 'regular';
	return style === 'bold' ? famId + ':bold' : famId;
}

export function fontLabel(key) {
	const { fam, style } = parseFontKey(key);
	return fam.label + (style === 'bold' && fam.faces.regular ? ' Bold' : '');
}

const b64ToBuffer = (b64) => { const s = atob(b64); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u.buffer; };

/** Raw WOFF bytes of a face (for CSS previews). */
export function faceBuffer(key) {
	const { fam, style } = parseFontKey(key);
	return fam.builtin ? null : b64ToBuffer(fam.faces[style]);
}

/** three.js Font for a key (falls back to Helvetiker Bold). */
export function getFont(key) {
	const k = key || 'bold';
	if (cache.has(k)) return cache.get(k);
	const { fam, style } = parseFontKey(k);
	if (fam.builtin) return cache.get(style);
	try {
		const font = new Font(toTypeface(opentype.parse(b64ToBuffer(fam.faces[style]))));
		cache.set(k, font);
		return font;
	} catch (e) {
		console.warn('Font failed to load', k, e);
		cache.set(k, cache.get('bold'));
		return cache.get('bold');
	}
}

// Converted from three.js TTFLoader (MIT): opentype.js font → typeface JSON used by three's Font.
function toTypeface(font) {
	const round = (x) => Math.round(x * 100) / 100;
	const scale = 100000 / ((font.unitsPerEm || 2048) * 72);
	// TrueType outlines run clockwise like typeface fonts; CFF (PostScript) outlines need reversing
	const reversed = font.outlinesFormat === 'cff';
	const glyphs = {};
	const map = font.encoding.cmap.glyphIndexMap;
	for (const unicode of Object.keys(map)) {
		const glyph = font.glyphs.get(map[unicode]);
		if (!glyph) continue;
		const token = { ha: round(glyph.advanceWidth * scale), x_min: round((glyph.xMin || 0) * scale), x_max: round((glyph.xMax || 0) * scale), o: '' };
		let cmds = glyph.path.commands;
		if (reversed) cmds = reverseCommands(cmds);
		for (const c of cmds) {
			const t = c.type.toLowerCase() === 'c' ? 'b' : c.type.toLowerCase();
			token.o += t + ' ';
			if (c.x !== undefined && c.y !== undefined) token.o += round(c.x * scale) + ' ' + round(c.y * scale) + ' ';
			if (c.x1 !== undefined && c.y1 !== undefined) token.o += round(c.x1 * scale) + ' ' + round(c.y1 * scale) + ' ';
			if (c.x2 !== undefined && c.y2 !== undefined) token.o += round(c.x2 * scale) + ' ' + round(c.y2 * scale) + ' ';
		}
		glyphs[String.fromCodePoint(+unicode)] = token;
	}
	return {
		glyphs, familyName: font.getEnglishName('fullName'),
		ascender: round(font.ascender * scale), descender: round(font.descender * scale),
		underlinePosition: font.tables.post.underlinePosition, underlineThickness: font.tables.post.underlineThickness,
		boundingBox: { xMin: font.tables.head.xMin, xMax: font.tables.head.xMax, yMin: font.tables.head.yMin, yMax: font.tables.head.yMax },
		resolution: 1000,
	};
}

function reverseCommands(commands) {
	const paths = [];
	let path;
	for (const c of commands) {
		if (c.type.toLowerCase() === 'm') { path = [c]; paths.push(path); } else if (c.type.toLowerCase() !== 'z') path.push(c);
	}
	const out = [];
	for (const p of paths) {
		out.push({ type: 'm', x: p[p.length - 1].x, y: p[p.length - 1].y });
		for (let i = p.length - 1; i > 0; i--) {
			const c = p[i], r = { type: c.type };
			if (c.x2 !== undefined && c.y2 !== undefined) { r.x1 = c.x2; r.y1 = c.y2; r.x2 = c.x1; r.y2 = c.y1; } else if (c.x1 !== undefined && c.y1 !== undefined) { r.x1 = c.x1; r.y1 = c.y1; }
			r.x = p[i - 1].x; r.y = p[i - 1].y;
			out.push(r);
		}
	}
	return out;
}
