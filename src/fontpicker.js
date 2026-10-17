// Font picker for text parts: every bundled font previewed in its own typeface, with search, categories and bold.
import { CATALOG, BUILTIN, parseFontKey, fontKey, fontLabel, faceBuffer } from './fontlib.js';
import { el } from './util.js';

const CATS = ['All', 'Sans', 'Serif', 'Mono', 'Display', 'Stencil', 'Script'];
const loaded = new Set();

/** Register a face with the page (FontFace) so it can be previewed; returns its CSS family name. */
function cssFamily(key) {
	const { fam, style } = parseFontKey(key);
	if (fam.builtin) return 'Helvetica, Arial, sans-serif';
	const name = `lcad-${fam.id}-${style}`;
	if (!loaded.has(name)) {
		loaded.add(name);
		try { const f = new FontFace(name, faceBuffer(key)); document.fonts.add(f); f.load().catch(() => {}); } catch (e) { /* preview only */ }
	}
	return `'${name}', sans-serif`;
}

export const FontPickerMixin = {
	fontField(n, p) {
		const key = n.params[p.key] || p.def;
		const btn = el('button', { class: 'font-btn', title: 'Choose a font' }, el('span', { style: { fontFamily: cssFamily(key) } }, fontLabel(key)), el('span', { class: 'caret-down' }, '▾'));
		btn.addEventListener('click', (e) => { e.preventDefault(); this.openFontPicker(btn, n, p.key); });
		return el('label', { class: 'field' }, el('span', { class: 'lbl' }, p.label), btn);
	},

	openFontPicker(anchor, n, key) {
		document.querySelectorAll('.font-picker').forEach((x) => x.remove());
		const cur = parseFontKey(n.params[key]);
		const state = { cat: this.fontCat || 'All', q: '', bold: cur.style === 'bold' };
		const sample = (String(n.params.text || '').trim() || 'AaBb 123').slice(0, 24);
		const search = el('input', { type: 'text', placeholder: 'Search fonts…', spellcheck: 'false' });
		const boldCb = el('input', { type: 'checkbox', checked: state.bold });
		const chips = el('div', { class: 'fp-cats' });
		const list = el('div', { class: 'fp-fonts' });
		const pop = el('div', { class: 'font-picker' },
			el('div', { class: 'fp-top' }, search, el('label', { class: 'fp-bold' }, boldCb, ' Bold')), chips, list,
			el('div', { class: 'muted small fp-note' }, `${CATALOG.length + 1} font families · open-source (SIL Open Font License) · bundled, works offline`));
		const render = () => {
			chips.innerHTML = '';
			for (const c of CATS) {
				const b = el('button', { class: 'chip-btn' + (state.cat === c ? ' on' : '') }, c);
				b.addEventListener('click', () => { state.cat = c; this.fontCat = c; render(); });
				chips.appendChild(b);
			}
			list.innerHTML = '';
			const q = state.q.toLowerCase();
			const fams = [...BUILTIN, ...CATALOG].filter((f) => (state.cat === 'All' || f.cat === state.cat) && (!q || f.label.toLowerCase().includes(q) || f.cat.toLowerCase().includes(q)));
			if (!fams.length) list.appendChild(el('div', { class: 'muted small pad-x' }, 'No fonts match.'));
			for (const f of fams) {
				const style = state.bold && f.faces.bold ? 'bold' : f.faces.regular ? 'regular' : 'bold';
				const k = fontKey(f.id, style);
				const on = cur.fam.id === f.id;
				const row = el('button', { class: 'fp-font' + (on ? ' on' : ''), title: f.label + (style === 'bold' ? ' Bold' : '') },
					el('span', { class: 'fp-name' }, f.label, el('span', { class: 'muted small' }, ' ' + f.cat + (f.faces.bold && f.faces.regular ? '' : ' · one weight'))),
					el('span', { class: 'fp-sample', style: { fontFamily: cssFamily(k) } }, sample));
				row.addEventListener('click', () => { n.params[key] = k; close(); this.propSig = null; this.commit(); });
				list.appendChild(row);
			}
		};
		search.addEventListener('input', () => { state.q = search.value; render(); });
		search.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') close(); if (e.key === 'Enter') { const first = list.querySelector('.fp-font'); if (first) first.click(); } });
		boldCb.addEventListener('change', () => { state.bold = boldCb.checked; render(); });
		const off = (e) => { if (!pop.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) close(); };
		const close = () => { pop.remove(); window.removeEventListener('pointerdown', off, true); };
		document.body.appendChild(pop);
		const r = anchor.getBoundingClientRect();
		pop.style.left = Math.max(8, Math.min(r.right - pop.offsetWidth, window.innerWidth - pop.offsetWidth - 8)) + 'px';
		pop.style.top = Math.max(8, Math.min(r.bottom + 4, window.innerHeight - pop.offsetHeight - 8)) + 'px';
		setTimeout(() => window.addEventListener('pointerdown', off, true));
		render();
		const onRow = list.querySelector('.fp-font.on');
		if (onRow) onRow.scrollIntoView({ block: 'center' });
		search.focus();
	},
};
