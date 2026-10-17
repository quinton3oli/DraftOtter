// Visual compare: an older design shown as a ghost over the current one, with a list of what changed. Used by
// History & branches (historyui.js) for commits, and by merging to show the other branch's version of a part.
import * as THREE from 'three';
import { diffDesigns } from './history.js';
import { el } from './util.js';

export { diffDesigns };

export const VersionMixin = {
	/** A small picture of the current view for a commit. */
	versionThumb() {
		try {
			const c = document.createElement('canvas');
			c.width = 160; c.height = 100;
			const ctx = c.getContext('2d');
			// copy straight from the WebGL canvas right after a render (same frame), cropped to 16:10
			const gl = this.vp.renderer.domElement, w = gl.width, h = gl.height, r = 1.6;
			const cw = Math.min(w, h * r), ch = cw / r;
			ctx.drawImage(gl, (w - cw) / 2, (h - ch) / 2, cw, ch, 0, 0, 160, 100);
			return c.toDataURL('image/jpeg', 0.72);
		} catch (e) { return ''; }
	},

	/**
	 * Show old top-level nodes as a ghost over the current design with a summary of the changes. onRestore adds a
	 * Restore button; opts.quiet shows the ghost with a title only (no change list). Returns the differences.
	 */
	compareNodes(old, title, onRestore, opts = {}) {
		this.stopCompare();
		const diff = diffDesigns(old, this.model.nodes);
		const group = new THREE.Group();
		const mat = new THREE.MeshBasicMaterial({ color: 0x19b8b4, transparent: true, opacity: 0.28, depthWrite: false });
		const edgeMat = new THREE.LineBasicMaterial({ color: 0x19b8b4, transparent: true, opacity: 0.8 });
		for (const n of old) {
			if (n.visible === false || n.hole) continue;
			const g = this.engine.world(n);
			if (!g) continue;
			const m = new THREE.Mesh(g, mat);
			m.renderOrder = 30;
			group.add(m);
			group.add(new THREE.LineSegments(new THREE.EdgesGeometry(g, 30), edgeMat));
		}
		this.vp.helpers.add(group);
		this.compareObj = group;
		this.vp.invalidate();
		let bar = document.querySelector('#compare-bar');
		if (!bar) { bar = el('div', { id: 'compare-bar', class: 'side-panel compare' }); document.querySelector('#viewport').appendChild(bar); }
		bar.innerHTML = '';
		if (opts.quiet) {
			bar.append(el('div', { class: 'fp-head' }, el('b', {}, 'Ghost: ' + title), el('button', { class: 'icon-btn', title: 'Hide', onclick: () => this.stopCompare() }, '✕')));
			bar.style.display = '';
			return diff;
		}
		const rows = [
			...diff.added.map((n) => ['add', `+ ${n.name}`, 'added']),
			...diff.removed.map((n) => ['rem', `− ${n.name}`, 'removed']),
			...diff.changed.map((c) => ['chg', `~ ${c.after.name}`, c.what.join(', ')]),
		];
		bar.append(
			el('div', { class: 'fp-head' }, el('b', {}, 'Comparing with ' + title), el('button', { class: 'icon-btn', title: 'Stop comparing', onclick: () => this.stopCompare() }, '✕')),
			el('div', { class: 'muted small' }, `Blue ghost = that version · ${diff.added.length} added, ${diff.removed.length} removed, ${diff.changed.length} changed since`),
			el('div', { class: 'fp-list' }, ...(rows.length ? rows.slice(0, 40).map(([k, t, d]) => el('div', { class: 'cmp-row ' + k }, el('span', {}, t), el('span', { class: 'muted small' }, d))) : [el('div', { class: 'muted small' }, 'No differences.')])),
			el('div', { class: 'btn-row' }, el('button', { class: 'btn sm', onclick: () => this.stopCompare() }, 'Done'), onRestore ? el('button', { class: 'btn sm primary', onclick: () => onRestore() }, 'Restore this version') : null));
		bar.style.display = '';
		return diff;
	},

	stopCompare() {
		if (this.compareObj) { this.vp.helpers.remove(this.compareObj); this.compareObj.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); this.compareObj = null; this.vp.invalidate(); }
		const bar = document.querySelector('#compare-bar');
		if (bar) bar.style.display = 'none';
	},
};
