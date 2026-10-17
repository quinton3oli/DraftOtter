// Design history as a commit graph, stored inside the design file (doc.history), like a small Git:
//  - objects: every part's record (its fields, with children as a list of ids) stored once under a hash of its
//    contents, so commits that share parts share storage;
//  - commits: { id, parents, time, message, auto, thumb, tree: { roots, nodes: { id: hash }, meta: hash } };
//  - branches: name → commit id; head: the current branch; tags: name → commit id.
// Plain data and functions (no DOM, no three.js) so merging can be tested on its own.
import { walk } from './model.js';
import { hashString, fmt } from './util.js';

export const FORMAT = 1;
const META_FIELDS = ['name', 'vars', 'configs', 'activeConfig', 'joints', 'mates', 'rollback'];
const UI_FIELDS = ['expanded']; // view state that doesn't belong in history

export function emptyHistory() {
	return { v: FORMAT, objects: {}, commits: {}, branches: { main: null }, head: 'main', tags: {} };
}

/** JSON with sorted keys, so equal records compare (and hash) equal whatever order fields were set in. */
export function stable(v) {
	if (v === undefined) return 'undefined';
	if (v === null || typeof v !== 'object') return JSON.stringify(v);
	if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
	return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
}
export const same = (a, b) => stable(a) === stable(b);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function put(H, rec) {
	const s = stable(rec), h = hashString(s);
	if (!H.objects[h]) H.objects[h] = JSON.parse(s);
	return h;
}

/** A part as stored: its own fields, children as ids, no view state. */
function recordOf(n) {
	const r = {};
	for (const k of Object.keys(n)) if (!UI_FIELDS.includes(k) && n[k] !== undefined) r[k] = k === 'children' ? n.children.map((c) => c.id) : n[k];
	return r;
}

/** Store a design state ({ nodes, vars, … } as in Model.designState) and return its tree. */
export function snapshot(H, state) {
	const nodes = {};
	walk(state.nodes || [], (n) => { nodes[n.id] = put(H, recordOf(n)); });
	const meta = {};
	for (const k of META_FIELDS) if (state[k] !== undefined && state[k] !== null) meta[k] = state[k];
	return { roots: (state.nodes || []).map((n) => n.id), nodes, meta: put(H, meta) };
}

/** The design state a tree stands for (fresh objects, safe to edit). */
export function materialize(H, tree) {
	const meta = clone(H.objects[tree.meta]) || {};
	const build = (id) => {
		const r = clone(H.objects[tree.nodes[id]]);
		if (!r) return null;
		if (r.children) r.children = r.children.map(build).filter(Boolean);
		if (r.type === 'group') r.expanded = false;
		return r;
	};
	return { name: meta.name ?? 'Untitled', vars: meta.vars || [], configs: meta.configs || [], activeConfig: meta.activeConfig ?? null, joints: meta.joints || [], mates: meta.mates || [], rollback: meta.rollback ?? null, nodes: tree.roots.map(build).filter(Boolean) };
}

export const treeSig = (t) => (t ? stable({ roots: t.roots, nodes: t.nodes, meta: t.meta }) : '');

export function headId(H) { return H.branches[H.head] ?? null; }
export function headCommit(H) { const id = headId(H); return id ? H.commits[id] : null; }

let idSeq = 0;
const newId = () => Date.now().toString(36) + (idSeq++ % 1296).toString(36).padStart(2, '0') + Math.random().toString(36).slice(2, 5);

/**
 * Commit a design state on the current branch. Returns the commit, or null when auto and nothing changed.
 * opts: { message, auto, thumb, parents (default: [head]), time }
 */
export function commit(H, state, opts = {}) {
	const tree = snapshot(H, state);
	const head = headCommit(H);
	if (opts.auto && !opts.force && head && treeSig(head.tree) === treeSig(tree) && !opts.parents) return null;
	const c = {
		id: newId(),
		parents: opts.parents || (head ? [head.id] : []),
		time: opts.time || Date.now(),
		message: opts.message || (opts.auto ? 'Saved' : 'Commit'),
		auto: !!opts.auto,
		parts: (state.nodes || []).length,
		tree,
	};
	if (opts.thumb) c.thumb = opts.thumb;
	H.commits[c.id] = c;
	H.branches[H.head] = c.id;
	return c;
}

/** Every commit reachable from cid (including it). */
export function ancestors(H, cid) {
	const seen = new Set(), stack = cid ? [cid] : [];
	while (stack.length) {
		const id = stack.pop();
		if (!id || seen.has(id) || !H.commits[id]) continue;
		seen.add(id);
		stack.push(...H.commits[id].parents);
	}
	return seen;
}

/** The best common ancestor of two commits (the newest one that isn't an ancestor of another), or null. */
export function mergeBase(H, a, b) {
	const A = ancestors(H, a), B = ancestors(H, b);
	const common = [...A].filter((id) => B.has(id));
	if (!common.length) return null;
	const best = common.filter((c) => !common.some((d) => d !== c && ancestors(H, d).has(c)));
	best.sort((x, y) => H.commits[y].time - H.commits[x].time);
	return best[0];
}

/** Commits in display order: newest first (parents always after their children). */
export function orderedCommits(H) {
	const all = Object.values(H.commits).sort((a, b) => b.time - a.time || (a.id < b.id ? 1 : -1));
	// make sure children come before parents even with equal times
	const out = [], placed = new Set(), kids = new Map();
	for (const c of all) for (const p of c.parents) { if (!kids.has(p)) kids.set(p, []); kids.get(p).push(c.id); }
	const ready = (c) => (kids.get(c.id) || []).every((k) => placed.has(k));
	const pending = all.slice();
	while (pending.length) {
		const i = pending.findIndex(ready);
		const c = pending.splice(i < 0 ? 0 : i, 1)[0];
		out.push(c);
		placed.add(c.id);
	}
	return out;
}

/** Drop commits no branch or tag reaches, and objects no commit uses. */
export function gc(H) {
	const keep = new Set();
	for (const id of [...Object.values(H.branches), ...Object.values(H.tags)]) for (const c of ancestors(H, id)) keep.add(c);
	for (const id of Object.keys(H.commits)) if (!keep.has(id)) delete H.commits[id];
	const used = new Set();
	for (const c of Object.values(H.commits)) { used.add(c.tree.meta); for (const h of Object.values(c.tree.nodes)) used.add(h); }
	for (const h of Object.keys(H.objects)) if (!used.has(h)) delete H.objects[h];
}

/** Old files: versions (a list of full snapshots) become a straight line of commits on main. */
export function migrateVersions(H, versions) {
	const list = (versions || []).slice().sort((a, b) => a.time - b.time);
	for (const v of list) {
		let state;
		try { state = JSON.parse(v.state); } catch (e) { continue; }
		commit(H, state, { message: v.name || (v.auto ? 'Saved' : 'Version'), auto: !!v.auto, thumb: v.thumb, time: v.time, force: true });
	}
}

// ---------------------------------------------------------------- differences

/** Parts added / removed / changed between two lists of top-level nodes (matched by id). */
export function diffDesigns(oldNodes, newNodes) {
	const flat = (nodes) => { const m = new Map(); walk(nodes, (n) => { m.set(n.id, n); }); return m; };
	const a = flat(oldNodes), b = flat(newNodes);
	const strip = (n) => stable({ ...n, children: n.children ? n.children.map((c) => c.id) : undefined, expanded: undefined, locked: undefined });
	const added = [], removed = [], changed = [];
	for (const [id, n] of b) if (!a.has(id)) added.push(n);
	for (const [id, n] of a) if (!b.has(id)) removed.push(n);
	for (const [id, n] of b) if (a.has(id) && strip(a.get(id)) !== strip(n)) changed.push({ before: a.get(id), after: n, what: whatChanged(a.get(id), n) });
	return { added, removed, changed };
}

export function whatChanged(x, y) {
	const out = [];
	if (x.name !== y.name) out.push(`renamed “${x.name}” → “${y.name}”`);
	if (!same(x.pos, y.pos) || !same(x.rot, y.rot)) out.push('moved');
	if (!same(x.scale, y.scale)) out.push('scaled');
	if (x.hole !== y.hole) out.push(y.hole ? 'made a hole' : 'made solid');
	if (x.color !== y.color) out.push('recolored');
	if (x.mode !== y.mode) out.push(`mode ${x.mode} → ${y.mode}`);
	const pk = new Set([...Object.keys(x.params || {}), ...Object.keys(y.params || {})]);
	for (const k of pk) {
		const p = (x.params || {})[k], q = (y.params || {})[k];
		if (same(p, q)) continue;
		out.push(typeof p === 'number' && typeof q === 'number' ? `${k} ${fmt(p, 3)} → ${fmt(q, 3)}` : `${k} changed`);
	}
	for (const k of ['texture', 'deform', 'offset', 'suppressed', 'fit']) if (!same(x[k], y[k])) out.push(`${k} changed`);
	const ids = (n) => (n.children ? n.children.map((c) => (typeof c === 'string' ? c : c.id)) : []);
	if (!same(ids(x), ids(y))) out.push('parts added or removed');
	return out.length ? out : ['edited'];
}

/** What a commit changed compared with its first parent. */
export function commitChanges(H, cid) {
	const c = H.commits[cid];
	if (!c) return null;
	const before = c.parents[0] ? materialize(H, H.commits[c.parents[0]].tree) : { nodes: [] };
	return diffDesigns(before.nodes, materialize(H, c.tree).nodes);
}

/** The commits (newest first) in which a part changed, from a commit back through its ancestors. */
export function partHistory(H, nodeId, fromCid) {
	const seq = [...ancestors(H, fromCid)].map((id) => H.commits[id]).sort((a, b) => a.time - b.time);
	const out = [];
	let last; // hash of the part in the previous commit (in time order)
	for (const c of seq) {
		const h = c.tree.nodes[nodeId];
		if (h === last) continue;
		const prev = last ? H.objects[last] : null, cur = h ? H.objects[h] : null;
		out.push({ commit: c, record: cur, what: !prev ? ['added'] : !cur ? ['deleted'] : whatChanged(prev, cur) });
		last = h;
	}
	return out.reverse();
}

// ---------------------------------------------------------------- three-way merge

function index(H, tree) {
	const recs = new Map(), parent = new Map();
	if (!tree) return { recs, parent, roots: [], meta: {} };
	for (const id of tree.roots) parent.set(id, null);
	for (const [id, h] of Object.entries(tree.nodes)) {
		const r = H.objects[h];
		recs.set(id, r);
		for (const c of r.children || []) parent.set(c, id);
	}
	return { recs, parent, roots: tree.roots, meta: H.objects[tree.meta] || {} };
}

const SUBKEYED = ['params', 'exprs']; // merged key by key
const QUIET = ['seq']; // bookkeeping: on a clash, keep ours without asking

/**
 * Merge two trees against their common ancestor. Returns { conflicts, build(choices) → design state }.
 * Each conflict: { key, kind: 'field' | 'delete' | 'parent' | 'node' | 'meta', id, path, base, ours, theirs }.
 * choices: { [key]: 'ours' | 'theirs' } (missing = ours; for 'delete' conflicts, 'ours' = what ours did).
 */
export function merge3(H, baseTree, oursTree, theirsTree) {
	const B = index(H, baseTree), O = index(H, oursTree), T = index(H, theirsTree);
	const conflicts = [];
	const add = (c) => { c.key = `${c.kind}:${c.id || ''}:${c.path || ''}`; conflicts.push(c); };
	const three = (b, o, t, onClash) => {
		if (same(o, t)) return o;
		if (same(b, o)) return t;
		if (same(b, t)) return o;
		return onClash();
	};
	const result = new Map();
	const ids = new Set([...B.recs.keys(), ...O.recs.keys(), ...T.recs.keys()]);
	for (const id of ids) {
		const b = B.recs.get(id), o = O.recs.get(id), t = T.recs.get(id);
		if (same(o, t)) { if (o) result.set(id, clone(o)); continue; }
		if (same(b, o)) { if (t) result.set(id, clone(t)); continue; }
		if (same(b, t)) { if (o) result.set(id, clone(o)); continue; }
		if (!o || !t) {
			// deleted on one side, changed on the other
			add({ kind: 'delete', id, deletedIn: o ? 'theirs' : 'ours', ours: clone(o), theirs: clone(t), name: (o || t).name });
			result.set(id, clone(o || t));
			continue;
		}
		if (!b) { add({ kind: 'node', id, ours: clone(o), theirs: clone(t), name: o.name }); result.set(id, clone(o)); continue; }
		const out = {};
		for (const k of new Set([...Object.keys(b), ...Object.keys(o), ...Object.keys(t)])) {
			if (k === 'children') continue;
			if (SUBKEYED.includes(k)) {
				const bb = b[k] || {}, oo = o[k] || {}, tt = t[k] || {}, sub = {};
				for (const s of new Set([...Object.keys(bb), ...Object.keys(oo), ...Object.keys(tt)])) {
					const v = three(bb[s], oo[s], tt[s], () => { add({ kind: 'field', id, path: k + '.' + s, base: clone(bb[s]), ours: clone(oo[s]), theirs: clone(tt[s]), name: o.name }); return oo[s]; });
					if (v !== undefined) sub[s] = clone(v);
				}
				if (Object.keys(sub).length || o[k] || t[k]) out[k] = sub;
				continue;
			}
			const v = three(b[k], o[k], t[k], () => { if (!QUIET.includes(k)) add({ kind: 'field', id, path: k, base: clone(b[k]), ours: clone(o[k]), theirs: clone(t[k]), name: o.name }); return o[k]; });
			if (v !== undefined) out[k] = clone(v);
		}
		if (o.children) out.children = [];
		result.set(id, out);
	}
	// where each part lives (which group, or the top level)
	const parent = new Map();
	for (const id of result.keys()) {
		const inO = O.recs.has(id), inT = T.recs.has(id);
		const po = O.parent.get(id), pt = T.parent.get(id), pb = B.parent.get(id);
		if (inO && inT) {
			parent.set(id, three(pb, po, pt, () => { add({ kind: 'parent', id, base: pb, ours: po, theirs: pt, name: result.get(id).name }); return po; }));
		} else parent.set(id, inO ? po : pt);
	}
	// a part whose group was deleted on one side: keep the group, and let the user choose (deleting takes both)
	for (let again = true; again;) {
		again = false;
		for (const [id, p] of parent) {
			if (p == null || result.has(p)) continue;
			const o = O.recs.get(p), t = T.recs.get(p);
			result.set(p, clone(o || t));
			parent.set(p, o ? O.parent.get(p) : T.parent.get(p));
			if (!conflicts.some((c) => c.kind === 'delete' && c.id === p)) add({ kind: 'delete', id: p, deletedIn: o ? 'theirs' : 'ours', ours: clone(o), theirs: clone(t), name: (o || t).name, inner: true });
			again = true;
		}
	}
	// a kept group (or part) comes back whole: what's inside it on the side that kept it (deleted only along with it)
	// stays, and goes again if the user chooses to delete it
	const restore = (id, side) => {
		for (const c of (side.recs.get(id) || {}).children || []) {
			if (!result.has(c)) { result.set(c, clone(side.recs.get(c))); parent.set(c, id); }
			restore(c, side);
		}
	};
	for (const c of conflicts) if (c.kind === 'delete') restore(c.id, c.deletedIn === 'ours' ? T : O);

	// design-wide data: name, variables (by name), configurations, joints, …
	const meta = {};
	for (const k of META_FIELDS) {
		if (k === 'vars') {
			const by = (list) => new Map((list || []).map((v) => [v.name, v]));
			const vb = by(B.meta.vars), vo = by(O.meta.vars), vt = by(T.meta.vars), out = [];
			const names = [...new Set([...vo.keys(), ...vt.keys(), ...vb.keys()])];
			for (const nm of names) {
				const v = three(vb.get(nm), vo.get(nm), vt.get(nm), () => { add({ kind: 'meta', path: 'vars.' + nm, base: clone(vb.get(nm)), ours: clone(vo.get(nm)), theirs: clone(vt.get(nm)), name: 'Variable ' + nm }); return vo.get(nm); });
				if (v) out.push(clone(v));
			}
			meta.vars = out;
			continue;
		}
		const v = three(B.meta[k], O.meta[k], T.meta[k], () => { add({ kind: 'meta', path: k, base: clone(B.meta[k]), ours: clone(O.meta[k]), theirs: clone(T.meta[k]), name: k === 'name' ? 'Design name' : k }); return O.meta[k]; });
		if (v !== undefined) meta[k] = clone(v);
	}

	const build = (choices = {}) => {
		const recs = new Map([...result].map(([id, r]) => [id, clone(r)]));
		const par = new Map(parent), m = clone(meta), gone = new Set();
		const pick = (c) => (choices[c.key] || 'ours') === 'theirs';
		for (const c of conflicts) {
			const theirs = pick(c);
			if (c.kind === 'field') {
				const r = recs.get(c.id);
				if (!r) continue;
				const v = theirs ? c.theirs : c.ours, [k, s] = c.path.split('.');
				if (s !== undefined) { r[k] = r[k] || {}; if (v === undefined) delete r[k][s]; else r[k][s] = clone(v); } else if (v === undefined) delete r[k]; else r[k] = clone(v);
			} else if (c.kind === 'parent') par.set(c.id, theirs ? c.theirs : c.ours);
			else if (c.kind === 'node') recs.set(c.id, clone(theirs ? c.theirs : c.ours));
			else if (c.kind === 'delete') {
				const deleteIt = (c.deletedIn === 'ours') !== theirs; // ours deleted it and we keep ours (or theirs deleted it and we take theirs)
				if (deleteIt) gone.add(c.id);
				else { const keep = c.ours || c.theirs; const r = recs.get(c.id); recs.set(c.id, { ...clone(keep), ...(r && r.children ? { children: [] } : {}) }); }
			} else if (c.kind === 'meta') {
				const v = theirs ? c.theirs : c.ours;
				if (c.path.startsWith('vars.')) {
					const nm = c.path.slice(5), i = m.vars.findIndex((x) => x.name === nm);
					if (v) { if (i >= 0) m.vars[i] = clone(v); else m.vars.push(clone(v)); } else if (i >= 0) m.vars.splice(i, 1);
				} else if (v === undefined) delete m[c.path]; else m[c.path] = clone(v);
			}
		}
		// deleting a group deletes everything in it
		for (let again = true; again;) { again = false; for (const [id, p] of par) if (!gone.has(id) && p != null && gone.has(p)) { gone.add(id); again = true; } }
		for (const id of gone) { recs.delete(id); par.delete(id); }
		// order inside each group: ours first, then what theirs added after its neighbor there
		const kidsOf = (p, side) => (p == null ? side.roots : (side.recs.get(p) || {}).children || []);
		const ordered = (p) => {
			const mine = [...par].filter(([, q]) => q === p).map(([id]) => id), want = new Set(mine);
			const list = kidsOf(p, O).filter((id) => want.has(id));
			const theirs = kidsOf(p, T);
			theirs.forEach((id, i) => {
				if (!want.has(id) || list.includes(id)) return;
				let at = 0;
				for (let j = i - 1; j >= 0; j--) { const k = list.indexOf(theirs[j]); if (k >= 0) { at = k + 1; break; } }
				list.splice(at, 0, id);
			});
			for (const id of mine) if (!list.includes(id)) list.push(id);
			return list;
		};
		const make = (id) => {
			const r = clone(recs.get(id));
			if (r.children) r.children = ordered(id).map(make);
			if (r.type === 'group') r.expanded = false;
			return r;
		};
		return { name: m.name ?? 'Untitled', vars: m.vars || [], configs: m.configs || [], activeConfig: m.activeConfig ?? null, joints: m.joints || [], mates: m.mates || [], rollback: m.rollback ?? null, nodes: ordered(null).map(make) };
	};
	return { conflicts, build };
}
