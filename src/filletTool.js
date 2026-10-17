// Fillet / chamfer tool: hover highlights a real edge of the part under the cursor, click toggles it.
import * as THREE from 'three';
import { extractEdges } from './edges.js';

export class FilletTool {
	constructor(vp) {
		this.vp = vp;
		this.active = false;
		this.cache = new Map(); // node id -> { sig, chains }
		this.target = null; // node id
		this.selected = new Set(); // chain indices on target
		this.flipped = new Set(); // chains whose start / end are swapped (variable size)
		this.hover = -1;
		this.group = new THREE.Group();
		vp.helpers.add(this.group);
		this.allMat = new THREE.LineBasicMaterial({ color: 0x7fb4ff, transparent: true, opacity: 0.55 });
		this.hoverMat = new THREE.LineBasicMaterial({ color: 0xffa94d, depthTest: false, transparent: true });
		this.selMat = new THREE.LineBasicMaterial({ color: 0xffd23f, depthTest: false, transparent: true });
	}

	setActive(on) {
		this.active = on;
		this.target = null;
		this.selected.clear();
		this.flipped.clear();
		this.hover = -1;
		this.redraw();
		this.vp.app.onFilletState(on, this.selection());
	}

	edgesOf(id) {
		const d = this.vp.displays.get(id);
		if (!d || !d.geometry.attributes.position) return null;
		d.updateWorldMatrix(true, false);
		const sig = d.geometry.uuid + '|' + d.matrixWorld.elements.map((v) => v.toFixed(5)).join(',');
		const c = this.cache.get(id);
		if (c && c.sig === sig) return c.chains;
		const { chains, triPatch } = extractEdges(d);
		this.cache.set(id, { sig, chains, triPatch });
		return chains;
	}

	/** The edges around the face (smooth patch) a mesh triangle belongs to. */
	faceChains(id, faceIndex) {
		const chains = this.edgesOf(id);
		const c = this.cache.get(id);
		if (!chains || !c || faceIndex == null) return [];
		const p = c.triPatch[faceIndex];
		if (!(p >= 0)) return [];
		return chains.map((ch, i) => (ch.pa === p || ch.pb === p ? i : -1)).filter((i) => i >= 0);
	}

	/** Swap start and end of the selected edges (which end gets the start size). */
	flipSelected() {
		for (const i of this.selected) { if (this.flipped.has(i)) this.flipped.delete(i); else this.flipped.add(i); }
		this.redraw();
		this.vp.app.onFilletState(true, this.selection());
	}

	selection() {
		if (!this.target) return null;
		const chains = this.edgesOf(this.target) || [];
		const rev = (ch) => ({ ...ch, pts: ch.pts.slice().reverse(), n1: ch.n1.slice().reverse(), n2: ch.n2.slice().reverse() });
		return { id: this.target, chains: [...this.selected].map((i) => chains[i] && (this.flipped.has(i) ? rev(chains[i]) : chains[i])).filter(Boolean) };
	}

	// After a rebuild the target may be gone or changed.
	refresh() {
		if (!this.active) return;
		if (this.target && !this.vp.app.model.get(this.target)) { this.target = null; this.selected.clear(); this.flipped.clear(); }
		this.hover = -1;
		this.redraw();
		this.vp.app.onFilletState(true, this.selection());
	}

	pickChain(e) {
		const vp = this.vp;
		const hit = vp.raycast(e, vp.pickables());
		const id = hit ? hit.object.userData.nodeId : this.target;
		if (!id) return null;
		const chains = this.edgesOf(id);
		if (!chains) return null;
		const r = vp.canvas.getBoundingClientRect();
		const mx = e.clientX - r.left, my = e.clientY - r.top;
		let best = -1, bd = 12;
		const v = new THREE.Vector3();
		chains.forEach((ch, ci) => {
			const n = ch.pts.length;
			for (let i = 0; i < (ch.closed ? n : n - 1); i++) {
				const a = vp.project(v.set(...ch.pts[i])), b = vp.project(v.set(...ch.pts[(i + 1) % n]));
				if (a.behind || b.behind) continue;
				const dx = b.x - a.x, dy = b.y - a.y;
				const t = Math.max(0, Math.min(1, ((mx - a.x) * dx + (my - a.y) * dy) / (dx * dx + dy * dy || 1)));
				const d = Math.hypot(a.x + dx * t - mx, a.y + dy * t - my);
				if (d < bd) { bd = d; best = ci; }
			}
		});
		if (best >= 0) return { id, ci: best };
		// not near an edge: the face under the cursor stands for all the edges around it
		const d = vp.displays.get(id);
		const face = hit && hit.object === d ? this.faceChains(id, hit.faceIndex) : [];
		return { id, ci: -1, face };
	}

	hoverAt(e) {
		const p = this.pickChain(e);
		const h = p && p.ci >= 0 ? p.id + ':' + p.ci : p && p.face && p.face.length ? p.id + ':f' + p.face.join(',') : null;
		if (h !== this.hoverKey) { this.hoverKey = h; this.hoverPick = p; this.redraw(p && p.id); }
		return h ? 'pointer' : null;
	}

	click(e) {
		const p = this.pickChain(e);
		if (!p || (p.ci < 0 && !(p.face && p.face.length))) return;
		if (p.id !== this.target) { this.target = p.id; this.selected.clear(); this.flipped.clear(); }
		if (p.ci < 0) {
			// a face: select all its edges, or clear them if they all already are
			if (p.face.every((i) => this.selected.has(i))) p.face.forEach((i) => this.selected.delete(i));
			else p.face.forEach((i) => this.selected.add(i));
		} else if (this.selected.has(p.ci)) this.selected.delete(p.ci);
		else this.selected.add(p.ci);
		this.redraw(p.id);
		this.vp.app.onFilletState(true, this.selection());
	}

	selectAll(filter) {
		const id = this.target || (this.hoverPick && this.hoverPick.id);
		if (!id) return;
		this.target = id;
		const chains = this.edgesOf(id) || [];
		chains.forEach((c, i) => { if (!filter || filter(c)) this.selected.add(i); });
		this.redraw(id);
		this.vp.app.onFilletState(true, this.selection());
	}

	lines(chains, mat, lift) {
		const pts = [];
		for (const ch of chains) {
			const n = ch.pts.length;
			const P = ch.pts.map((p, i) => {
				// lift the line slightly off the surface so it is not hidden by the faces it sits on
				const b = new THREE.Vector3(...ch.n1[i]).add(new THREE.Vector3(...ch.n2[i])).normalize().multiplyScalar(ch.convex ? lift : -lift);
				return new THREE.Vector3(...p).add(b);
			});
			for (let i = 0; i < (ch.closed ? n : n - 1); i++) pts.push(P[i], P[(i + 1) % n]);
		}
		const l = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), mat);
		l.renderOrder = mat.depthTest === false ? 46 : 6;
		return l;
	}

	redraw(showId) {
		for (const c of [...this.group.children]) { c.geometry.dispose(); this.group.remove(c); }
		if (!this.active) { this.vp.invalidate(); return; }
		const shown = new Set([this.target, showId].filter(Boolean));
		for (const id of shown) {
			const chains = this.edgesOf(id);
			if (chains && chains.length) this.group.add(this.lines(chains, this.allMat, 0.03));
		}
		if (this.target) {
			const chains = this.edgesOf(this.target) || [];
			const sel = [...this.selected].map((i) => chains[i]).filter(Boolean);
			if (sel.length) this.group.add(this.lines(sel, this.selMat, 0.03));
		}
		const hp = this.hoverPick;
		if (hp && (hp.ci >= 0 || (hp.face && hp.face.length))) {
			const all = this.edgesOf(hp.id) || [];
			const hs = (hp.ci >= 0 ? [hp.ci] : hp.face).map((i) => all[i]).filter(Boolean);
			if (hs.length) this.group.add(this.lines(hs, this.hoverMat, 0.03));
		}
		// variable size: a dot where each selected edge starts (gets the start size)
		if (this.target && this.vp.app.filletVariable) {
			const s = this.selection();
			const pts = s ? s.chains.map((ch) => new THREE.Vector3(...ch.pts[0])) : [];
			if (pts.length) {
				const dots = new THREE.Points(new THREE.BufferGeometry().setFromPoints(pts), new THREE.PointsMaterial({ color: 0x3ddc84, size: 11, sizeAttenuation: false, depthTest: false }));
				dots.renderOrder = 47;
				this.group.add(dots);
			}
		}
		this.vp.invalidate();
	}
}
