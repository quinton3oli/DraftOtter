// Feature timeline: every part and feature in the order it was made. Suppress a step to switch it off, or
// roll the design back to any step — new work is then inserted at that point in the history.
import { walk, setSeqSource } from './model.js';
import { toast, el } from './util.js';
import { SHAPES } from './shapes.js';

const GLYPH = {
	group: '◫', sketch: '✎', edgeop: '◜', facex: '⇕', faceoff: '⇕', facemove: '⇕', wrap: '⟳', text: 'T', mesh: '▲', box: '■', cylinder: '●', sphere: '◉',
};

export const TimelineMixin = {
	/** Is a node switched off (suppressed, or after the rollback point)? */
	isOff(n) {
		const rb = this.model.doc.rollback;
		return !!n.suppressed || (rb != null && (n.seq || 0) > rb);
	},

	/** Recompute which nodes are off and hand the set to the engine (called on every commit). */
	syncOff() {
		const off = new Set();
		walk(this.model.nodes, (n) => { if (this.isOff(n)) off.add(n.id); });
		this.engine.offIds = off;
		// while rolled back, new nodes are inserted right after the rollback point
		const doc = this.model.doc;
		// (steps are renumbered a million apart when rolling back, so there is room for many insertions)
		setSeqSource(doc.rollback != null ? () => (doc.rollback += 1) : null);
		return off;
	},

	/** All nodes in creation order with their parent. */
	timelineItems() {
		const items = [];
		let k = 0;
		walk(this.model.nodes, (n, parent) => { items.push({ n, parent, k: k++ }); });
		return items.sort((a, b) => (a.n.seq || 0) - (b.n.seq || 0) || a.k - b.k);
	},

	setRollback(seq) {
		const doc = this.model.doc;
		const items = this.timelineItems();
		if (seq == null || (items.length && seq >= (items[items.length - 1].n.seq || 0))) doc.rollback = null;
		else {
			// renumber the history with wide gaps, keeping the order
			let at = 0;
			items.forEach((it, i) => { const old = it.n.seq || 0; it.n.seq = (i + 1) * 1e6; if (old <= seq) at = it.n.seq; });
			doc.rollback = at;
		}
		this.commit();
	},

	toggleSuppress(n) {
		if (n.suppressed) delete n.suppressed; else n.suppressed = true;
		this.commit();
	},

	setLeftTab(tab) {
		this.leftTab = tab;
		document.querySelectorAll('.left-tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
		document.querySelector('#tree').style.display = tab === 'timeline' ? 'none' : '';
		document.querySelector('#timeline').style.display = tab === 'timeline' ? '' : 'none';
		if (tab === 'timeline') this.renderTimeline();
	},

	renderTimeline() {
		const host = document.querySelector('#timeline');
		if (!host || this.leftTab !== 'timeline') return;
		host.innerHTML = '';
		const doc = this.model.doc, items = this.timelineItems(), sel = new Set(this.sel);
		const rb = doc.rollback;
		if (rb != null) host.appendChild(el('div', { class: 'tl-banner' }, el('span', {}, 'Rolled back — later steps are switched off. New work is inserted here.'), el('button', { class: 'btn sm primary', onclick: () => this.setRollback(null) }, 'Roll to end')));
		if (!items.length) host.appendChild(el('div', { class: 'muted small pad-x' }, 'Steps appear here as you add shapes and features.'));
		let markerShown = rb == null;
		items.forEach(({ n, parent }, i) => {
			const after = rb != null && (n.seq || 0) > rb;
			if (after && !markerShown) { host.appendChild(this.rollbackMarker()); markerShown = true; }
			const label = n.type === 'group' ? (n.mode === 'hull' ? 'Hull' : n.mode === 'intersect' ? 'Intersect' : n.mode === 'offset' ? 'Offset' : n.mode === 'texture' ? 'Texture' : n.mode === 'deform' ? 'Deform' : 'Group') : (SHAPES[n.type] || {}).label || n.type;
			const sup = el('input', { type: 'checkbox', checked: !n.suppressed, title: n.suppressed ? 'Suppressed — click to switch it back on' : 'Click to suppress (switch off) this step' });
			sup.addEventListener('click', (e) => { e.stopPropagation(); this.toggleSuppress(n); });
			const back = el('button', { class: 'icon-btn sm tl-back', title: 'Roll back to just after this step' }, '⤒');
			back.addEventListener('click', (e) => { e.stopPropagation(); this.setRollback(n.seq || 0); });
			const row = el('div', { class: 'tl-row' + (sel.has(n.id) ? ' sel' : '') + (n.suppressed ? ' suppressed' : '') + (after ? ' after' : '') + (n.hole ? ' is-hole' : '') },
				el('span', { class: 'tl-num' }, String(i + 1)), el('span', { class: 'tl-glyph' }, GLYPH[n.type] || '◆'),
				el('span', { class: 'tl-name' }, n.name || label, parent ? el('span', { class: 'muted small' }, ' in ' + parent.name) : null),
				back, sup);
			row.addEventListener('click', () => { if (!after) this.setSelection([n.id]); });
			row.addEventListener('dblclick', () => { if (n.type === 'sketch' && !after) this.editSketch(n); });
			host.appendChild(row);
		});
		if (!markerShown) host.appendChild(this.rollbackMarker());
	},

	rollbackMarker() {
		return el('div', { class: 'tl-marker', title: 'Rollback point' }, el('span', {}, 'rollback point'));
	},
};
