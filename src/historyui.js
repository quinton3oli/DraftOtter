// History & branches: commits with thumbnails, branches (try ideas side by side), three-way merging with a conflict
// panel, cherry-picking changes from other commits, the history of one part, tags, and an undo stack that survives
// reloading. The data side is in history.js; the visual compare (ghost overlay) is in versions.js.
import * as THREE from 'three';
import { walk } from './model.js';
import { SHAPES } from './shapes.js';
import { emptyHistory, snapshot, materialize, commit, headId, headCommit, ancestors, mergeBase, merge3, orderedCommits, gc, migrateVersions, partHistory, commitChanges, diffDesigns, treeSig, same } from './history.js';
import { fmt, toast, el, idbGet, idbSet } from './util.js';

const $ = (s) => document.querySelector(s);
const THUMBS_KEPT = 80; // automatic commits older than this lose their thumbnail (named, tagged and branch tips keep theirs)
const UNDO_KEY = 'draftotter-undo-v1';
const UNDO_KEPT = 80;
const when = (t) => {
	const d = new Date(t), now = new Date();
	return d.toDateString() === now.toDateString() ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};
const validName = (s) => /^[\w][\w\-. ]{0,40}$/.test(s);

export const HistoryMixin = {
	/** The design's history (created on first use; old "versions" become commits on main). */
	hist() {
		const doc = this.model.doc;
		if (!doc.history || doc.history.v !== 1) {
			doc.history = emptyHistory();
			if (doc.versions && doc.versions.length) migrateVersions(doc.history, doc.versions);
		}
		if (doc.versions) delete doc.versions;
		return doc.history;
	},

	workingState() {
		return JSON.parse(JSON.stringify(this.model.designState()));
	},

	/** Has the design changed since the current branch's last commit? */
	histDirty() {
		const head = headCommit(this.hist());
		const tree = snapshot({ objects: {} }, this.model.designState());
		return head ? treeSig(head.tree) !== treeSig(tree) : this.model.nodes.length > 0;
	},

	/** Parts changed since the last commit: { added, removed, changed } (compared with an empty design if none). */
	histChanges() {
		const head = headCommit(this.hist());
		return diffDesigns(head ? materialize(this.hist(), head.tree).nodes : [], this.model.nodes);
	},

	/** Commit the design on the current branch. Returns the commit (null when auto and unchanged). */
	histCommit(message, { auto = false, parents } = {}) {
		const H = this.hist();
		this.vp.render && this.vp.render();
		const c = commit(H, this.workingState(), { message: message || (auto ? 'Saved' : `Commit ${Object.keys(H.commits).length + 1}`), auto, thumb: this.versionThumb(), parents });
		if (!c) return null;
		this.pruneThumbs();
		this.autosave && this.autosave();
		this.renderBranchChip();
		return c;
	},

	pruneThumbs() {
		const H = this.hist();
		const keep = new Set([...Object.values(H.branches), ...Object.values(H.tags)]);
		const list = Object.values(H.commits).sort((a, b) => b.time - a.time);
		list.forEach((c, i) => { if (c.thumb && c.auto && i >= THUMBS_KEPT && !keep.has(c.id)) delete c.thumb; });
	},

	// ---- older names, kept for compatibility (Save keeps an automatic commit)
	saveVersion(name, { auto = false } = {}) { return this.histCommit(name, { auto }); },
	restoreVersion(id) { return this.restoreCommit(id); },
	compareVersion(id) { return this.compareCommit(id); },
	versionsDialog() { return this.historyDialog(); },

	/** Put a design state in place as an ordinary (undoable) change. */
	async loadState(state, label) {
		const doc = this.model.doc;
		Object.assign(doc, { name: state.name ?? doc.name, nodes: state.nodes, vars: state.vars || [], configs: state.configs || [], activeConfig: state.activeConfig ?? null, joints: state.joints || [], mates: state.mates || [], rollback: state.rollback ?? null });
		this.stopCompare();
		this.sel = [];
		this.applyExpressions();
		await this.prebuild(this.loadingScreen(label || 'Loading', true));
		this.commit();
		this.frame();
	},

	/** Bring back a commit's design as the current (uncommitted) design on this branch. */
	async restoreCommit(cid) {
		const H = this.hist(), c = H.commits[cid];
		if (!c) return;
		if (this.histDirty()) this.histCommit(`Before restoring “${c.message}”`, { auto: true });
		await this.loadState(materialize(H, c.tree), `Restoring “${c.message}”`);
		toast(`Restored “${c.message}” — Undo (Ctrl+Z) goes back`, 'ok', 4000);
	},

	compareCommit(cid) {
		const H = this.hist(), c = H.commits[cid];
		if (!c) return null;
		return this.compareNodes(materialize(H, c.tree).nodes, `“${c.message}” (${when(c.time)})`, () => this.restoreCommit(cid));
	},

	// ------------------------------------------------------------ branches

	/** Start a branch. From the current commit it takes your uncommitted changes along; from another commit it opens that one. */
	async newBranch(name, from = null) {
		const H = this.hist();
		name = (name || '').trim();
		if (!validName(name)) { toast('Branch names: letters, digits, spaces, - _ . (up to 40)', 'error', 3500); return false; }
		if (name in H.branches) { toast(`There is already a branch “${name}”`, 'error'); return false; }
		const here = headId(H);
		if (!from || from === here) {
			if (!here && this.model.nodes.length) this.histCommit('Start', { auto: true });
			H.branches[name] = headId(H);
			H.head = name;
		} else {
			if (this.histDirty()) this.histCommit(`Before branching “${name}”`, { auto: true });
			H.branches[name] = from;
			H.head = name;
			await this.loadState(materialize(H, H.commits[from].tree), `Opening branch “${name}”`);
		}
		this.autosave();
		this.renderBranchChip();
		toast(`On branch “${name}” — changes you commit now stay on it`, 'ok', 3500);
		return true;
	},

	/** Switch branches. changes: 'commit' | 'discard' (what to do with uncommitted changes); asks when not given. */
	async switchBranch(name, changes) {
		const H = this.hist();
		if (!(name in H.branches) || name === H.head) return false;
		if (this.histDirty() && !changes) {
			return new Promise((res) => {
				const form = el('div', { class: 'form' }, el('p', {}, `You have changes on “${H.head}” that aren't committed. Commit them there before switching to “${name}”?`));
				this.modal('Switch branch', form, [
					{ label: 'Cancel', action: () => res(false) },
					{ label: 'Discard changes', action: () => { this.switchBranch(name, 'discard').then(res); } },
					{ label: 'Commit and switch', primary: true, action: () => { this.switchBranch(name, 'commit').then(res); } },
				]);
			});
		}
		if (changes === 'commit' && this.histDirty()) this.histCommit('Work in progress', { auto: true });
		H.head = name;
		const c = headCommit(H);
		await this.loadState(c ? materialize(H, c.tree) : { ...this.workingState(), nodes: [] }, `Switching to “${name}”`);
		this.autosave();
		this.renderBranchChip();
		toast(`Switched to branch “${name}”`, 'ok');
		return true;
	},

	renameBranch(from, to) {
		const H = this.hist();
		to = (to || '').trim();
		if (!(from in H.branches) || !validName(to) || to in H.branches) { toast('Choose a new, unused branch name', 'error'); return false; }
		const out = {};
		for (const [k, v] of Object.entries(H.branches)) out[k === from ? to : k] = v;
		H.branches = out;
		if (H.head === from) H.head = to;
		this.autosave();
		this.renderBranchChip();
		return true;
	},

	/** Delete a branch (not the current one). Commits only it reached are dropped. */
	deleteBranch(name, force = false) {
		const H = this.hist();
		if (!(name in H.branches) || name === H.head) return false;
		const tip = H.branches[name];
		const others = new Set();
		for (const [k, v] of [...Object.entries(H.branches), ...Object.entries(H.tags)]) if (k !== name) for (const a of ancestors(H, v)) others.add(a);
		const lost = [...ancestors(H, tip)].filter((id) => !others.has(id)).length;
		if (lost && !force && !confirm(`Delete branch “${name}”? ${lost} commit${lost > 1 ? 's' : ''} that only it has will be lost (merge it first to keep them).`)) return false;
		delete H.branches[name];
		gc(H);
		this.autosave();
		this.renderBranchChip();
		return true;
	},

	tagCommit(cid, name) {
		const H = this.hist();
		name = (name || '').trim();
		if (!validName(name)) { toast('Tag names: letters, digits, spaces, - _ .', 'error'); return false; }
		H.tags[name] = cid;
		this.autosave();
		return true;
	},

	untag(name) {
		const H = this.hist();
		delete H.tags[name];
		gc(H);
		this.autosave();
	},

	// ------------------------------------------------------------ merging

	/** Merge another branch into the current one. Resolves to 'up-to-date' | 'fast-forward' | 'merged' | 'conflicts'. */
	async mergeBranch(source) {
		const H = this.hist();
		const theirs = H.branches[source];
		if (!theirs || source === H.head) return null;
		if (this.merging) { toast('Finish or cancel the merge in progress first', 'warn'); return null; }
		if (this.histDirty()) this.histCommit(`Before merging “${source}”`, { auto: true });
		const ours = headId(H);
		if (ours && ancestors(H, ours).has(theirs)) { toast(`“${H.head}” already has everything from “${source}”`, 'info'); return 'up-to-date'; }
		if (!ours || ancestors(H, theirs).has(ours)) {
			// nothing new here: just move up to theirs
			H.branches[H.head] = theirs;
			await this.loadState(materialize(H, H.commits[theirs].tree), `Merging “${source}”`);
			this.autosave();
			this.renderBranchChip();
			toast(`Merged “${source}” (no changes here to combine with)`, 'ok');
			return 'fast-forward';
		}
		const base = mergeBase(H, ours, theirs);
		const m = merge3(H, base ? H.commits[base].tree : null, H.commits[ours].tree, H.commits[theirs].tree);
		return this.startMerge({ m, title: `Merging “${source}” into “${H.head}”`, message: `Merged “${source}” into “${H.head}”`, parents: [ours, theirs], theirsTree: H.commits[theirs].tree, oursTree: H.commits[ours].tree, theirsLabel: source });
	},

	/** Apply a merge result; with conflicts, show the panel and wait for the user. */
	async startMerge(job) {
		const H = this.hist();
		if (!job.m.conflicts.length) {
			await this.loadState(job.m.build(), job.title);
			this.histCommit(job.message, { parents: job.parents });
			toast(job.message + ' — no conflicts', 'ok', 3500);
			return 'merged';
		}
		this.merging = { ...job, choices: {} };
		await this.loadState(job.m.build({}), job.title);
		this.renderMergePanel();
		return 'conflicts';
	},

	async setMergeChoice(key, side) {
		const mg = this.merging;
		if (!mg) return;
		mg.choices[key] = side;
		const state = mg.m.build(mg.choices);
		Object.assign(this.model.doc, { nodes: state.nodes, vars: state.vars, configs: state.configs, activeConfig: state.activeConfig, joints: state.joints, mates: state.mates, rollback: state.rollback, name: state.name });
		this.commit();
		await this.claudeSettle?.();
		this.renderMergePanel();
	},

	async finishMerge() {
		const mg = this.merging;
		if (!mg) return;
		this.merging = null;
		this.closeMergePanel();
		this.histCommit(mg.message, { parents: mg.parents });
		toast(mg.message, 'ok', 3000);
	},

	async abortMerge() {
		const mg = this.merging;
		if (!mg) return;
		this.merging = null;
		this.closeMergePanel();
		await this.loadState(materialize(this.hist(), mg.oursTree), 'Canceling the merge');
		toast('Merge canceled', 'info');
	},

	closeMergePanel() {
		const p = $('#merge-panel');
		if (p) p.remove();
		this.stopCompare();
	},

	conflictText(c) {
		const v = (x) => (x === undefined ? '(none)' : typeof x === 'number' ? fmt(x, 4) : typeof x === 'string' ? (x.length > 24 ? x.slice(0, 24) + '…' : x) : typeof x === 'boolean' ? (x ? 'yes' : 'no') : Array.isArray(x) && x.length <= 4 && x.every((q) => typeof q === 'number') ? x.map((q) => fmt(q, 3)).join(', ') : 'changed');
		const groupName = (id) => (id == null ? 'top level' : `“${(this.model.get(id) || {}).name || id}”`);
		if (c.kind === 'field') {
			// the parameter's own label ("Height Z") where there is one
			const n = this.model.get(c.id), key = c.path.replace(/^params\./, '');
			const def = n && c.path.startsWith('params.') && SHAPES[n.type] && SHAPES[n.type].params.find((p) => p.key === key);
			return { what: `${c.name}: ${def ? def.label : key}`, ours: v(c.ours), theirs: v(c.theirs) };
		}
		if (c.kind === 'delete') return { what: `${c.name}${c.inner ? ' (parts were added inside it)' : ''}`, ours: c.deletedIn === 'ours' ? 'deleted' : 'changed', theirs: c.deletedIn === 'theirs' ? 'deleted' : 'changed' };
		if (c.kind === 'parent') return { what: `${c.name}: which group it's in`, ours: groupName(c.ours), theirs: groupName(c.theirs) };
		if (c.kind === 'meta') return { what: c.name, ours: v(c.ours && c.ours.expr !== undefined ? c.ours.expr : c.ours), theirs: v(c.theirs && c.theirs.expr !== undefined ? c.theirs.expr : c.theirs) };
		return { what: c.name || c.id, ours: 'mine', theirs: 'theirs' };
	},

	renderMergePanel() {
		const mg = this.merging;
		if (!mg) return;
		let p = $('#merge-panel');
		if (!p) { p = el('div', { id: 'merge-panel', class: 'side-panel merge' }); $('#viewport').appendChild(p); }
		p.innerHTML = '';
		const H = this.hist();
		const theirsNodes = materialize(H, mg.theirsTree).nodes;
		const rows = mg.m.conflicts.map((c) => {
			const t = this.conflictText(c), side = mg.choices[c.key] || 'ours';
			const btn = (s, label, val) => el('button', { class: 'btn sm' + (side === s ? ' on' : ''), title: s === 'ours' ? 'Keep the current branch\'s version' : `Take “${mg.theirsLabel}”'s version`, onclick: () => this.setMergeChoice(c.key, s) }, el('span', { class: 'muted' }, label + ' '), val);
			return el('div', { class: 'merge-row' + (c.id ? ' has-part' : ''), onclick: (e) => {
				if (e.target.closest('button') || !c.id) return;
				if (this.model.get(c.id)) this.setSelection([c.id]);
				// their version of this part as a ghost
				const top = theirsNodes.find((n) => { let hit = false; walk([n], (q) => { if (q.id === c.id) hit = true; }); return hit; });
				if (top) this.compareNodes([top], `“${mg.theirsLabel}”'s ${c.name}`, null, { quiet: true });
			} }, el('div', { class: 'small' }, t.what), el('div', { class: 'btn-row' }, btn('ours', 'Mine:', t.ours), btn('theirs', 'Theirs:', t.theirs)));
		});
		p.append(
			el('div', { class: 'fp-head' }, el('b', {}, mg.title)),
			el('div', { class: 'muted small' }, `${mg.m.conflicts.length} conflict${mg.m.conflicts.length > 1 ? 's' : ''}: both branches changed the same thing. Everything else is merged already. Choose a side for each (click one to see their version as a ghost); the view shows the result as you go.`),
			el('div', { class: 'fp-list' }, ...rows),
			el('div', { class: 'btn-row' },
				el('button', { class: 'btn sm', onclick: () => { for (const c of mg.m.conflicts) mg.choices[c.key] = 'ours'; this.setMergeChoice(mg.m.conflicts[0].key, 'ours'); } }, 'All mine'),
				el('button', { class: 'btn sm', onclick: () => { for (const c of mg.m.conflicts) mg.choices[c.key] = 'theirs'; this.setMergeChoice(mg.m.conflicts[0].key, 'theirs'); } }, 'All theirs')),
			el('div', { class: 'btn-row' },
				el('button', { class: 'btn', onclick: () => this.abortMerge() }, 'Cancel merge'),
				el('button', { class: 'btn primary', onclick: () => this.finishMerge() }, 'Finish merge')));
	},

	// ------------------------------------------------------------ cherry-pick

	/** Apply some of a commit's changes (by part id) to the current design, merging like a merge would. */
	async cherryPick(cid, ids) {
		const H = this.hist(), c = H.commits[cid];
		if (!c) return null;
		const parent = c.parents[0] ? H.commits[c.parents[0]] : null;
		const baseState = parent ? materialize(H, parent.tree) : { ...this.workingState(), nodes: [] };
		const theirsFull = materialize(H, c.tree);
		const pick = new Set(ids);
		// "theirs" = the commit's parent with only the chosen parts' changes applied
		const flat = (nodes) => { const m = new Map(); walk(nodes, (n, p) => { m.set(n.id, { n, p }); }); return m; };
		const B = flat(baseState.nodes), T = flat(theirsFull.nodes);
		const nodes = JSON.parse(JSON.stringify(baseState.nodes));
		const find = (list, id) => { let r = null; walk(list, (n, p) => { if (n.id === id) { r = { n, list: p ? p.children : list }; return false; } }); return r; };
		for (const id of pick) {
			const b = B.get(id), t = T.get(id);
			if (b && !t) { const f = find(nodes, id); if (f) f.list.splice(f.list.indexOf(f.n), 1); continue; }
			if (!t) continue;
			const rec = JSON.parse(JSON.stringify(t.n));
			if (b) { const f = find(nodes, id); if (f) { const kids = f.n.children; Object.keys(f.n).forEach((k) => delete f.n[k]); Object.assign(f.n, rec); if (kids) f.n.children = kids; } continue; }
			// added: into the same group if it's there, else at the top level
			const host = t.p && find(nodes, t.p.id);
			const list = host ? host.n.children : nodes;
			const sib = (t.p ? t.p.children : theirsFull.nodes), at = sib.findIndex((x) => x.id === id);
			const prev = at > 0 ? list.findIndex((x) => x.id === sib[at - 1].id) : -1;
			list.splice(prev + 1, 0, rec);
		}
		const scratch = { objects: H.objects };
		const m = merge3(scratch, parent ? parent.tree : snapshot(scratch, baseState), snapshot(scratch, this.model.designState()), snapshot(scratch, { ...theirsFull, nodes }));
		return this.startMerge({ m, title: `Applying changes from “${c.message}”`, message: `Applied changes from “${c.message}”`, parents: undefined, theirsTree: c.tree, oursTree: snapshot(scratch, this.model.designState()), theirsLabel: c.message });
	},

	cherryPickDialog(cid) {
		const H = this.hist(), c = H.commits[cid];
		const ch = commitChanges(H, cid);
		const items = [...ch.added.map((n) => [n, '+ added']), ...ch.removed.map((n) => [n, '− removed']), ...ch.changed.map((x) => [x.after, '~ ' + x.what.join(', ')])];
		if (!items.length) { toast('That commit changed nothing to apply', 'info'); return; }
		const boxes = items.map(([n, what]) => { const cb = el('input', { type: 'checkbox', checked: true, 'data-id': n.id }); return el('label', { class: 'check cp-row' }, cb, el('span', {}, el('b', {}, n.name), ' ', el('span', { class: 'muted small' }, what))); });
		const form = el('div', { class: 'form' }, el('p', { class: 'small' }, `Bring changes from “${c.message}” into the current design. Parts you changed too are merged; clashes are shown for you to choose.`), ...boxes);
		this.modal('Apply changes from a commit', form, [{ label: 'Cancel' }, { label: 'Apply', primary: true, action: () => {
			const ids = [...form.querySelectorAll('input[type=checkbox]')].filter((x) => x.checked).map((x) => x.dataset.id);
			if (!ids.length) return false;
			this.cherryPick(cid, ids);
		} }]);
	},

	// ------------------------------------------------------------ one part's history

	partHistoryDialog(node) {
		const H = this.hist();
		const list = partHistory(H, node.id, headId(H));
		const body = el('div', { class: 'versions' });
		const head = headCommit(H), cur = head && head.tree.nodes[node.id];
		const now = snapshot({ objects: {} }, { nodes: [node] }).nodes[node.id];
		if (cur !== now) body.append(el('div', { class: 'ver-row part' }, el('div', { class: 'ver-info' }, el('b', {}, 'Now (not committed)'), el('div', { class: 'muted small' }, cur ? 'changed since the last commit' : 'not in any commit yet'))));
		if (!list.length) body.append(el('p', { class: 'muted' }, 'This part isn\'t in any commit on this branch yet.'));
		for (const x of list) {
			body.append(el('div', { class: 'ver-row part' },
				x.commit.thumb ? el('img', { src: x.commit.thumb, class: 'ver-thumb', alt: '' }) : el('div', { class: 'ver-thumb' }),
				el('div', { class: 'ver-info' }, el('b', {}, x.commit.message), el('div', { class: 'muted small' }, `${when(x.commit.time)} · ${x.what.join(', ')}`)),
				el('div', { class: 'ver-btns' }, x.record ? el('button', { class: 'btn sm', title: 'Set this part back to how it was in that commit (the rest of the design stays)', onclick: () => { close(); this.restorePart(node.id, x.record); } }, 'Use this version') : null)));
		}
		const close = this.modal(`History of “${node.name}”`, body, [{ label: 'Close' }], 'wide');
	},

	restorePart(id, record) {
		const n = this.model.get(id);
		if (!n) return;
		const kids = n.children;
		for (const k of Object.keys(n)) if (k !== 'children') delete n[k];
		const r = JSON.parse(JSON.stringify(record));
		delete r.children;
		Object.assign(n, r);
		if (kids) n.children = kids;
		this.commit();
		toast(`“${n.name}” is back to that version — Undo (Ctrl+Z) goes back`, 'ok', 3500);
	},

	// ------------------------------------------------------------ undo that survives reloading

	saveUndo() {
		const m = this.model;
		if (!m.history.length) return;
		const from = Math.max(0, m.hIndex - UNDO_KEPT + 1);
		idbSet(this.tabKey ? this.tabKey(UNDO_KEY) : UNDO_KEY, { history: m.history.slice(from, from + UNDO_KEPT + 20), hIndex: m.hIndex - from, savedAt: Date.now() });
	},

	async restoreUndo() {
		const u = await idbGet(this.tabKey ? this.tabKey(UNDO_KEY) : UNDO_KEY);
		const m = this.model;
		if (!u || !u.history || !u.history[u.hIndex]) return false;
		// only if the design is still exactly where that undo stack left it
		if (u.history[u.hIndex] !== JSON.stringify(m.designState())) return false;
		m.history = u.history;
		m.hIndex = u.hIndex;
		this.updateToolbarState();
		return true;
	},

	// ------------------------------------------------------------ top bar chip

	renderBranchChip() {
		let chip = $('#branch-chip');
		if (!chip) {
			chip = el('button', { id: 'branch-chip', class: 'branch-chip', title: 'History & branches', onclick: () => this.historyDialog() });
			const name = $('#project-name');
			if (!name) return;
			name.after(chip);
		}
		const H = this.hist();
		const dirty = this.histDirty();
		chip.innerHTML = '';
		chip.append(el('span', { class: 'bc-icon' }, '⎇'), el('span', {}, H.head));
		if (dirty) chip.append(el('span', { class: 'bc-dot', title: 'Changes since the last commit' }));
		chip.classList.toggle('dirty', dirty);
		chip.classList.toggle('merging', !!this.merging);
		chip.title = `Branch “${H.head}”${dirty ? ' — uncommitted changes' : ''} · History & branches`;
	},

	// ------------------------------------------------------------ the History window

	historyDialog() {
		const H = this.hist();
		const body = el('div', { class: 'history' });
		let close = null;
		const ask = (title, label, value = '') => new Promise((res) => {
			const inp = el('input', { type: 'text', value, style: 'width:100%' });
			inp.addEventListener('keydown', (e) => e.stopPropagation());
			const f = el('div', { class: 'form' }, el('label', { class: 'row' }, el('span', {}, label), inp));
			this.modal(title, f, [{ label: 'Cancel', action: () => res(null) }, { label: 'OK', primary: true, action: () => res(inp.value.trim() || null) }]);
			setTimeout(() => { inp.focus(); inp.select(); }, 40);
		});
		const render = () => {
			body.innerHTML = '';
			// ---- branch bar
			const sel = el('select', { id: 'hist-branch' }, ...Object.keys(H.branches).map((b) => el('option', { value: b }, b)));
			sel.value = H.head;
			sel.addEventListener('change', async () => { const ok = await this.switchBranch(sel.value); if (!ok) sel.value = H.head; render(); });
			const others = Object.keys(H.branches).filter((b) => b !== H.head);
			const mergeSel = el('select', { id: 'hist-merge' }, el('option', { value: '' }, 'Merge a branch into this…'), ...others.map((b) => el('option', { value: b }, b)));
			mergeSel.disabled = !others.length;
			mergeSel.addEventListener('change', async () => { const b = mergeSel.value; if (!b) return; close(); await this.mergeBranch(b); });
			body.append(el('div', { class: 'hist-bar' },
				el('span', { class: 'muted small' }, 'Branch'), sel,
				el('button', { class: 'btn sm', title: 'Start a branch here (takes your current changes along)', onclick: async () => { const n = await ask('New branch', 'Name', ''); if (n && (await this.newBranch(n))) render(); } }, '+ New branch'),
				mergeSel,
				el('button', { class: 'btn sm', title: 'Rename this branch', onclick: async () => { const n = await ask('Rename branch', 'New name', H.head); if (n && this.renameBranch(H.head, n)) render(); } }, 'Rename'),
				others.length ? el('button', { class: 'btn sm', title: 'Delete another branch', onclick: async () => { const n = await ask('Delete a branch', 'Branch to delete (' + others.join(', ') + ')', others[0]); if (n && this.deleteBranch(n)) render(); } }, 'Delete…') : null));
			// ---- commit box
			const ch = this.histChanges(), count = ch.added.length + ch.removed.length + ch.changed.length;
			const dirty = this.histDirty();
			const msg = el('input', { type: 'text', id: 'hist-msg', placeholder: dirty ? 'Describe your changes, e.g. “thicker walls”' : 'No changes since the last commit', style: 'flex:1' });
			const doCommit = () => { if (!this.histDirty()) return; const c = this.histCommit(msg.value.trim() || null); if (c) { toast(`Committed “${c.message}” on ${H.head}`, 'ok'); render(); } };
			msg.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') doCommit(); });
			body.append(el('div', { class: 'ver-new' }, msg, el('button', { class: 'btn primary', disabled: !dirty, onclick: doCommit }, 'Commit')));
			if (dirty) body.append(el('div', { class: 'muted small' }, count ? `Since the last commit: ${[ch.added.length && `${ch.added.length} added`, ch.removed.length && `${ch.removed.length} removed`, ch.changed.length && `${ch.changed.length} changed`].filter(Boolean).join(', ')}` : 'Design settings changed since the last commit'));
			// ---- graph
			const list = orderedCommits(H);
			if (!list.length) { body.append(el('p', { class: 'muted' }, 'No commits yet. Commit to record the design; every Save also commits when something changed. Branches let you try an idea without touching your main design, and merge it back later.')); return; }
			const lanes = layoutLanes(list);
			const ROW = 66, LW = 14, width = 12 + LW * Math.max(1, lanes.count);
			const refs = new Map();
			for (const [b, id] of Object.entries(H.branches)) if (id) { if (!refs.has(id)) refs.set(id, []); refs.get(id).push({ b, head: b === H.head }); }
			for (const [t, id] of Object.entries(H.tags)) { if (!refs.has(id)) refs.set(id, []); refs.get(id).push({ t }); }
			const headIdNow = headId(H), reach = ancestors(H, headIdNow);
			const svg = graphSvg(list, lanes, ROW, LW, width, headIdNow);
			const rows = el('div', { class: 'hist-rows' });
			list.forEach((c) => {
				const nameEl = el('input', { type: 'text', value: c.message, class: 'ver-name', title: 'Rename this commit' });
				nameEl.addEventListener('change', () => { c.message = nameEl.value.trim() || c.message; this.autosave(); });
				nameEl.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') nameEl.blur(); });
				const badges = (refs.get(c.id) || []).map((r) => el('span', { class: 'hist-badge ' + (r.t ? 'tag' : r.head ? 'head' : 'branch'), title: r.t ? 'Tag' : r.head ? 'Current branch' : 'Branch' }, r.t ? '🏷 ' + r.t : r.b));
				const more = this.menu ? (e) => this.menu(e.currentTarget, [
					['Show what changed', () => { const d = commitChanges(H, c.id); const box = el('div', { class: 'fp-list' }); box.append(...[...d.added.map((n) => el('div', { class: 'cmp-row add' }, el('span', {}, '+ ' + n.name))), ...d.removed.map((n) => el('div', { class: 'cmp-row rem' }, el('span', {}, '− ' + n.name))), ...d.changed.map((x) => el('div', { class: 'cmp-row chg' }, el('span', {}, '~ ' + x.after.name), el('span', { class: 'muted small' }, x.what.join(', '))))]); if (!box.children.length) box.append(el('div', { class: 'muted small' }, 'No part changes (settings or variables only)')); this.modal(`What “${c.message}” changed`, box, [{ label: 'Close' }]); }],
					['Start a branch here…', async () => { const n = await ask('New branch from this commit', 'Name', ''); if (n && (await this.newBranch(n, c.id))) render(); }],
					['Apply changes from this commit…', () => { close(); this.cherryPickDialog(c.id); }],
					['Tag this commit…', async () => { const n = await ask('Tag', 'Name, e.g. “printed v2”', ''); if (n && this.tagCommit(c.id, n)) render(); }],
					...(refs.get(c.id) || []).filter((r) => r.t).map((r) => [`Remove tag “${r.t}”`, () => { this.untag(r.t); render(); }]),
				]) : null;
				rows.append(el('div', { class: 'hist-row' + (c.id === headIdNow ? ' current' : '') + (reach.has(c.id) ? '' : ' elsewhere'), style: `height:${ROW}px` },
					c.thumb ? el('img', { src: c.thumb, class: 'ver-thumb', alt: '' }) : el('div', { class: 'ver-thumb' }),
					el('div', { class: 'ver-info' }, el('div', { class: 'hist-title' }, nameEl, ...badges), el('div', { class: 'muted small' }, `${when(c.time)} · ${c.parts ?? '?'} object${c.parts === 1 ? '' : 's'}${c.auto ? ' · automatic' : ''}${c.parents.length > 1 ? ' · merge' : ''}`)),
					el('div', { class: 'ver-btns' },
						el('button', { class: 'btn sm', title: 'Show it as a ghost over the current design and list the differences', onclick: () => { close(); this.compareCommit(c.id); } }, 'Compare'),
						el('button', { class: 'btn sm', title: 'Bring this design back (as changes on the current branch)', onclick: () => { close(); this.restoreCommit(c.id); } }, 'Restore'),
						more ? el('button', { class: 'btn sm', title: 'More: what changed, branch, apply changes, tag', onclick: more }, '⋯') : null)));
			});
			body.append(el('div', { class: 'hist-graph' }, svg, rows));
		};
		render();
		close = this.modal('History & branches', body, [{ label: 'Close' }], 'wide history-modal');
	},
};

/** Lanes for the commit graph (newest first): which column each commit sits in. */
function layoutLanes(list) {
	const lanes = [], lane = new Map();
	let count = 0;
	for (const c of list) {
		let i = lanes.indexOf(c.id);
		if (i < 0) { i = lanes.indexOf(null); if (i < 0) i = lanes.length; }
		// any other lane waiting for this commit ends here
		for (let k = 0; k < lanes.length; k++) if (k !== i && lanes[k] === c.id) lanes[k] = null;
		lane.set(c.id, i);
		lanes[i] = c.parents[0] || null;
		for (const p of c.parents.slice(1)) if (!lanes.includes(p)) { let j = lanes.indexOf(null); if (j < 0) j = lanes.length; lanes[j] = p; }
		count = Math.max(count, lanes.length);
	}
	return { lane, count };
}

const COLORS = ['#19b8b4', '#5ab0ff', '#ffb020', '#ff6b9a', '#b38bff', '#46d39a', '#ff8a4d'];
function graphSvg(list, lanes, ROW, LW, width, headIdNow) {
	const NS = 'http://www.w3.org/2000/svg';
	const svg = document.createElementNS(NS, 'svg');
	svg.setAttribute('width', width);
	svg.setAttribute('height', list.length * ROW);
	svg.setAttribute('class', 'hist-svg');
	const pos = new Map(list.map((c, i) => [c.id, { x: 8 + LW * lanes.lane.get(c.id), y: i * ROW + ROW / 2, lane: lanes.lane.get(c.id) }]));
	for (const c of list) {
		const a = pos.get(c.id);
		c.parents.forEach((pid, k) => {
			const b = pos.get(pid);
			if (!b) return;
			const path = document.createElementNS(NS, 'path');
			const lane = k === 0 && b.lane !== a.lane && b.lane < a.lane ? a.lane : b.lane;
			const color = COLORS[(k === 0 ? a.lane : b.lane) % COLORS.length];
			// down from the child, over to the parent's column near the child, then straight down to it
			const midY = a.y + ROW * 0.6;
			const x2 = b.x;
			path.setAttribute('d', a.x === x2 ? `M${a.x},${a.y} L${b.x},${b.y}` : `M${a.x},${a.y} C${a.x},${midY} ${x2},${a.y} ${x2},${midY} L${b.x},${b.y}`);
			path.setAttribute('stroke', color);
			path.setAttribute('stroke-width', '2');
			path.setAttribute('fill', 'none');
			svg.appendChild(path);
			void lane;
		});
	}
	for (const c of list) {
		const a = pos.get(c.id);
		const dot = document.createElementNS(NS, 'circle');
		dot.setAttribute('cx', a.x); dot.setAttribute('cy', a.y); dot.setAttribute('r', c.id === headIdNow ? 6 : 4.5);
		dot.setAttribute('fill', c.id === headIdNow ? '#ffffff' : COLORS[a.lane % COLORS.length]);
		dot.setAttribute('stroke', COLORS[a.lane % COLORS.length]);
		dot.setAttribute('stroke-width', '2');
		svg.appendChild(dot);
	}
	return svg;
}

export { same };
