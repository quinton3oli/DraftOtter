// Document model: a tree of nodes plus settings, with snapshot-based undo/redo.
import { SHAPES, defaultParams } from './shapes.js';

export const DEFAULT_SETTINGS = {
	bed: { w: 220, d: 220, h: 250 },
	grid: 10,
	snap: 1,
	rotSnap: 15,
	density: 1.24,
	filament: 1.75,
	showEdges: true,
	showBuildVolume: true,
	showBed: true, // the print bed plate, grid and border
	bgColor: '#141a22', // background of the 3D view
	overhang: false,
	overhangAngle: 45,
	section: { on: false, axis: 'x', offset: 0, flip: false },
};

// Creation order for the feature timeline. Normally increasing time-based numbers; while the design is rolled
// back the app supplies numbers that slot in right after the rollback point.
let SEQ = Date.now() * 1000;
let seqSource = null;
export function setSeqSource(fn) { seqSource = fn; }
export function nextSeq() { return seqSource ? seqSource() : ++SEQ; }

export function uid() {
	return 'n' + Math.random().toString(36).slice(2, 10);
}

export function makeNode(type, params = {}, extra = {}) {
	const def = SHAPES[type];
	return {
		id: uid(),
		seq: nextSeq(),
		type,
		name: def ? def.label : type,
		params: { ...defaultParams(type), ...params },
		pos: [0, 0, 0],
		rot: [0, 0, 0],
		scale: [1, 1, 1],
		color: def ? def.color : '#e8613a',
		visible: true,
		locked: false,
		...extra,
		hole: extra.hole ?? !!(def && def.defaultHole),
	};
}

export function makeGroup(children, extra = {}) {
	const firstSolid = children.find((c) => !c.hole) || children[0];
	return {
		id: uid(),
		seq: nextSeq(),
		type: 'group',
		name: 'Group',
		mode: 'union',
		children,
		pos: [0, 0, 0],
		rot: [0, 0, 0],
		scale: [1, 1, 1],
		hole: false,
		color: firstSolid ? firstSolid.color : '#e8613a',
		visible: true,
		locked: false,
		expanded: false,
		...extra,
	};
}

export function cloneWithNewIds(node) {
	const c = JSON.parse(JSON.stringify(node));
	const re = (n) => {
		n.id = uid();
		n.seq = nextSeq();
		if (n.children) n.children.forEach(re);
	};
	re(c);
	return c;
}

export function walk(nodes, fn, parent = null, depth = 0) {
	for (const n of nodes) {
		if (fn(n, parent, depth) === false) return false;
		if (n.children && walk(n.children, fn, n, depth + 1) === false) return false;
	}
	return true;
}

export class Model {
	constructor() {
		this.blobs = {};
		this.doc = this.emptyDoc();
		this.history = [];
		this.hIndex = -1;
		this.dirty = false;
	}

	emptyDoc() {
		return { name: 'Untitled', nodes: [], vars: [], settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) };
	}

	get nodes() { return this.doc.nodes; }
	get settings() { return this.doc.settings; }

	find(id) {
		let res = null;
		walk(this.doc.nodes, (n, parent) => {
			if (n.id === id) {
				res = { node: n, parent, list: parent ? parent.children : this.doc.nodes };
				return false;
			}
		});
		return res;
	}

	get(id) {
		const f = this.find(id);
		return f ? f.node : null;
	}

	parentOf(id) {
		const f = this.find(id);
		return f ? f.parent : null;
	}

	isTopLevel(id) {
		return this.doc.nodes.some((n) => n.id === id);
	}

	topLevelOf(id) {
		for (const n of this.doc.nodes) {
			let found = false;
			walk([n], (m) => { if (m.id === id) { found = true; return false; } });
			if (found) return n;
		}
		return null;
	}

	remove(id) {
		const f = this.find(id);
		if (!f) return null;
		const i = f.list.indexOf(f.node);
		f.list.splice(i, 1);
		return f.node;
	}

	// Load a full document (e.g. from file or autosave), merging in missing settings.
	load(doc, blobs) {
		const base = this.emptyDoc();
		this.doc = {
			...base,
			...doc,
			vars: doc.vars || [],
			settings: { ...base.settings, ...(doc.settings || {}), bed: { ...base.settings.bed, ...((doc.settings || {}).bed || {}) }, section: { ...base.settings.section, ...((doc.settings || {}).section || {}) } },
		};
		if (blobs) Object.assign(this.blobs, blobs);
		this.history = [];
		this.hIndex = -1;
		this.snapshot();
	}

	/** Replace the current undo step with the design as it is now (after a load-time tidy-up, which is not an edit). */
	rebaseSnapshot() {
		if (this.hIndex >= 0) this.history[this.hIndex] = JSON.stringify(this.designState());
	}

	// Snapshots cover the design (name + nodes); view settings live outside undo history.
	snapshot() {
		const s = JSON.stringify(this.designState());
		if (this.history[this.hIndex] === s) return false;
		this.history.length = this.hIndex + 1;
		this.history.push(s);
		if (this.history.length > 200) this.history.shift();
		this.hIndex = this.history.length - 1;
		this.dirty = true;
		return true;
	}

	/** The undoable part of the document (view settings and saved versions live outside undo). */
	designState() {
		const d = this.doc;
		return { name: d.name, nodes: d.nodes, vars: d.vars || [], configs: d.configs || [], activeConfig: d.activeConfig || null, joints: d.joints || [], mates: d.mates || [], rollback: d.rollback ?? null };
	}

	canUndo() { return this.hIndex > 0; }
	canRedo() { return this.hIndex < this.history.length - 1; }

	undo() {
		if (!this.canUndo()) return false;
		this.hIndex--;
		Object.assign(this.doc, JSON.parse(this.history[this.hIndex]));
		return true;
	}

	redo() {
		if (!this.canRedo()) return false;
		this.hIndex++;
		Object.assign(this.doc, JSON.parse(this.history[this.hIndex]));
		return true;
	}

	usedBlobs() {
		const out = {};
		walk(this.doc.nodes, (n) => {
			if (n.type === 'mesh' && n.params.blob && this.blobs[n.params.blob]) out[n.params.blob] = this.blobs[n.params.blob];
		});
		// meshes that only older commits use
		for (const r of Object.values((this.doc.history && this.doc.history.objects) || {})) {
			if (r && r.type === 'mesh' && r.params && r.params.blob && this.blobs[r.params.blob]) out[r.params.blob] = this.blobs[r.params.blob];
		}
		return out;
	}

	/**
	 * Drop mesh data that nothing refers to any more: not the design, not an undo step, not a commit. (Each sculpt or
	 * import adds a blob; without this they would all stay in memory for the whole session.)
	 */
	pruneBlobs(keep = []) {
		const keys = Object.keys(this.blobs);
		if (keys.length < 2) return 0;
		const used = new Set(keep);
		walk(this.doc.nodes, (n) => { if (n.type === 'mesh' && n.params.blob) used.add(n.params.blob); });
		for (const r of Object.values((this.doc.history && this.doc.history.objects) || {})) if (r && r.type === 'mesh' && r.params) used.add(r.params.blob);
		// mesh data only undo steps still need is capped (~300 MB): beyond that, the oldest undo steps go
		const UNDO_BLOB_BUDGET = 300e6;
		const undoOnly = () => keys.filter((k) => this.blobs[k] && !used.has(k) && this.history.some((s) => s.includes(k)));
		let extra = undoOnly().reduce((t, k) => t + this.blobs[k].length, 0);
		while (extra > UNDO_BLOB_BUDGET && this.hIndex > 0) {
			this.history.shift();
			this.hIndex--;
			extra = undoOnly().reduce((t, k) => t + this.blobs[k].length, 0);
		}
		let dropped = 0;
		for (const k of keys) {
			if (used.has(k)) continue;
			if (this.history.some((s) => s.includes(k))) continue; // an undo step still uses it
			delete this.blobs[k];
			dropped++;
		}
		return dropped;
	}

	serialize() {
		return JSON.stringify({ format: 'draftotter', version: 1, doc: this.doc, blobs: this.usedBlobs() });
	}
}
