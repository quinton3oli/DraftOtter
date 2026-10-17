// Commit graph and three-way merge (history.js).
import { makeNode, makeGroup } from '../src/model.js';
import { same, emptyHistory, snapshot, materialize, commit, headId, mergeBase, merge3, ancestors, gc, migrateVersions, partHistory, orderedCommits, commitChanges, treeSig } from '../src/history.js';
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(ok ? 'ok  ' : 'FAIL', name, info); };
const clone = (v) => JSON.parse(JSON.stringify(v));
const state = (nodes, vars = []) => ({ name: 'Part', nodes, vars, configs: [], joints: [], mates: [], rollback: null });
const find = (nodes, id) => { let r = null; const w = (l) => l.forEach((n) => { if (n.id === id) r = n; if (n.children) w(n.children); }); w(nodes); return r; };
let t = 1000;
const at = () => (t += 1000);

// ---------------------------------------------------------------- storage
const H = emptyHistory();
const box = makeNode('box', { w: 20, d: 20, h: 10 }, { name: 'Base' });
const cyl = makeNode('cylinder', { r: 5, h: 20 }, { name: 'Peg' });
let s0 = state([box, cyl], [{ name: 'wall', expr: '2' }]);
const c0 = commit(H, s0, { message: 'start', time: at() });
check('first commit on main', H.branches.main === c0.id && c0.parents.length === 0);
const back = materialize(H, c0.tree);
check('a commit gives back the same design', same(back.nodes, s0.nodes) && back.vars[0].name === 'wall');
check('automatic commits skip unchanged designs', commit(H, s0, { auto: true }) === null);
const objs = Object.keys(H.objects).length;
const s1 = clone(s0); s1.nodes[0].params.h = 12;
const c1 = commit(H, s1, { message: 'taller', time: at() });
check('unchanged parts are stored once (only the changed one is new)', Object.keys(H.objects).length === objs + 1, Object.keys(H.objects).length - objs);
check('field order does not matter for storage', treeSig(snapshot(H, { ...s1, nodes: s1.nodes.map((n) => Object.fromEntries(Object.entries(n).reverse())) })) === treeSig(c1.tree));

// ---------------------------------------------------------------- branches and merge base
H.branches.lid = c1.id; // branch "lid" from c1
H.head = 'lid';
const sl = clone(s1); sl.nodes[1].params.r = 6; sl.nodes[1].color = '#ff0000';
const cl = commit(H, sl, { message: 'wider peg', time: at() });
H.head = 'main';
const sm = clone(s1); sm.nodes[0].params.w = 30; sm.nodes[1].params.h = 25;
const cm = commit(H, sm, { message: 'wider base', time: at() });
check('branches move independently', H.branches.main === cm.id && H.branches.lid === cl.id);
check('merge base is where they split', mergeBase(H, cm.id, cl.id) === c1.id);

// both edited the peg, different fields → no conflict
let m = merge3(H, H.commits[c1.id].tree, cm.tree, cl.tree);
let out = m.build();
check('changes to different fields merge without conflicts', m.conflicts.length === 0, JSON.stringify(m.conflicts));
const peg = find(out.nodes, cyl.id), base = find(out.nodes, box.id);
check('…and the result has both sides\' changes', peg.params.r === 6 && peg.params.h === 25 && peg.color === '#ff0000' && base.params.w === 30 && base.params.h === 12, JSON.stringify([peg.params, base.params]));

// same field changed differently → conflict, with choices
const sa = clone(s1); sa.nodes[0].params.h = 15;
const sb = clone(s1); sb.nodes[0].params.h = 18; sb.nodes[0].name = 'Plate';
m = merge3(H, H.commits[c1.id].tree, snapshot(H, sa), snapshot(H, sb));
check('the same field changed on both sides is a conflict', m.conflicts.length === 1 && m.conflicts[0].kind === 'field' && m.conflicts[0].path === 'params.h' && m.conflicts[0].ours === 15 && m.conflicts[0].theirs === 18, JSON.stringify(m.conflicts));
check('…mine by default (the other change still comes through)', find(m.build().nodes, box.id).params.h === 15 && find(m.build().nodes, box.id).name === 'Plate');
check('…or theirs when chosen', find(m.build({ [m.conflicts[0].key]: 'theirs' }).nodes, box.id).params.h === 18);

// deleted on one side, edited on the other
const sd = clone(s1); sd.nodes.splice(1, 1);
const se = clone(s1); se.nodes[1].params.r = 9;
m = merge3(H, H.commits[c1.id].tree, snapshot(H, sd), snapshot(H, se));
check('deleted here but edited there is a conflict', m.conflicts.length === 1 && m.conflicts[0].kind === 'delete' && m.conflicts[0].deletedIn === 'ours');
check('…keeping my deletion by default', !find(m.build().nodes, cyl.id));
check('…or keeping their edited part', find(m.build({ [m.conflicts[0].key]: 'theirs' }).nodes, cyl.id).params.r === 9);
// deleted on one side, untouched on the other → just deleted
m = merge3(H, H.commits[c1.id].tree, snapshot(H, sd), snapshot(H, s1));
check('deleted on one side and untouched on the other: deleted, no conflict', !m.conflicts.length && !find(m.build().nodes, cyl.id));

// groups: both add parts into the same group; one adds into a group the other deleted
const hole = makeNode('cylinder', { r: 2, h: 30 }, { hole: true, name: 'Hole' });
const g = makeGroup([clone(box), hole], { name: 'Cut' });
const sg = state([g]);
const Hg = emptyHistory();
const g0 = commit(Hg, sg, { time: at() });
const ga = clone(sg); const h2 = makeNode('cylinder', { r: 1, h: 30 }, { hole: true, name: 'Hole A' }); ga.nodes[0].children.push(h2);
const gb = clone(sg); const h3 = makeNode('box', { w: 2 }, { hole: true, name: 'Slot B' }); gb.nodes[0].children.splice(1, 0, h3);
m = merge3(Hg, g0.tree, snapshot(Hg, ga), snapshot(Hg, gb));
out = m.build();
check('parts added to the same group on both sides are both kept', !m.conflicts.length && out.nodes[0].children.map((c) => c.name).join() === 'Base,Slot B,Hole,Hole A', out.nodes[0].children.map((c) => c.name).join());
const gdel = state([]);
m = merge3(Hg, g0.tree, snapshot(Hg, gdel), snapshot(Hg, ga));
check('a group deleted here but added to there is a conflict', m.conflicts.length === 1 && m.conflicts[0].kind === 'delete' && m.conflicts[0].id === g.id, JSON.stringify(m.conflicts.map((c) => c.key)));
check('…deleting it takes what was added inside too', m.build().nodes.length === 0);
const kept = m.build({ [m.conflicts[0].key]: 'theirs' });
check('…keeping it keeps the new part', kept.nodes[0].children.map((c) => c.name).join() === 'Base,Hole,Hole A', kept.nodes[0].children.map((c) => c.name).join());
// moved into different groups
const g2 = makeGroup([makeNode('box')], { name: 'Other' });
const sp = state([clone(g), g2, makeNode('sphere', {}, { name: 'Ball' })]);
const p0 = commit(Hg, sp, { time: at() });
const ball = sp.nodes[2].id;
const pa = clone(sp); const ba = pa.nodes.pop(); pa.nodes[0].children.push(ba);
const pb = clone(sp); const bb = pb.nodes.pop(); pb.nodes[1].children.push(bb);
m = merge3(Hg, p0.tree, snapshot(Hg, pa), snapshot(Hg, pb));
check('a part moved into different groups is a conflict', m.conflicts.length === 1 && m.conflicts[0].kind === 'parent');
check('…resolved either way', m.build().nodes[0].children.some((c) => c.id === ball) && m.build({ [m.conflicts[0].key]: 'theirs' }).nodes[1].children.some((c) => c.id === ball));

// variables merge by name
const va = clone(s0); va.vars = [{ name: 'wall', expr: '3' }, { name: 'gap', expr: '0.2' }];
const vb = clone(s0); vb.vars = [{ name: 'wall', expr: '2' }, { name: 'r', expr: '4' }];
m = merge3(H, c0.tree, snapshot(H, va), snapshot(H, vb));
check('variables merge by name', !m.conflicts.length && m.build().vars.map((v) => v.name + '=' + v.expr).join() === 'wall=3,gap=0.2,r=4', m.build().vars.map((v) => v.name + '=' + v.expr).join());
const vc = clone(s0); vc.vars = [{ name: 'wall', expr: '4' }];
m = merge3(H, c0.tree, snapshot(H, va), snapshot(H, vc));
check('…the same variable changed on both sides is a conflict', m.conflicts.length === 1 && m.conflicts[0].kind === 'meta' && m.conflicts[0].path === 'vars.wall');

// ---------------------------------------------------------------- graph
H.head = 'main';
const merged = commit(H, m.build(), { message: 'merge', parents: [cm.id, cl.id], time: at() });
check('a merge commit has both parents and reaches both histories', merged.parents.length === 2 && ancestors(H, merged.id).has(cl.id) && ancestors(H, merged.id).has(cm.id));
check('after merging, the merge base is the merged branch itself', mergeBase(H, H.branches.main, H.branches.lid) === cl.id);
const order = orderedCommits(H).map((c) => c.message);
check('commits list newest first', order[0] === 'merge' && order[order.length - 1] === 'start', order.join());
const ch = commitChanges(H, cm.id);
check('what a commit changed', ch.changed.length === 2 && !ch.added.length, JSON.stringify(ch.changed.map((x) => x.what)));
const ph = partHistory(H, cyl.id, H.branches.main);
check('history of one part: when it changed', ph.length >= 3 && ph[ph.length - 1].what[0] === 'added' && ph.some((x) => x.commit.id === cl.id), ph.map((x) => x.commit.message + ':' + x.what.join(';')).join(' | '));
delete H.branches.lid;
const before = Object.keys(H.commits).length;
gc(H);
check('deleting a merged branch keeps its commits (main reaches them)', Object.keys(H.commits).length === before);
H.branches.tmp = c0.id; H.head = 'tmp';
const lone = commit(H, state([makeNode('torus')]), { time: at() });
H.head = 'main'; delete H.branches.tmp;
gc(H);
check('deleting an unmerged branch drops its commits and their parts', !H.commits[lone.id] && !Object.values(H.objects).some((o) => o.type === 'torus'));

// ---------------------------------------------------------------- old files
const Hv = emptyHistory();
migrateVersions(Hv, [{ id: 'b', name: 'Saved', auto: true, time: 2000, state: JSON.stringify(s1), thumb: 'x' }, { id: 'a', name: 'first', auto: false, time: 1000, state: JSON.stringify(s0) }]);
const mv = orderedCommits(Hv);
check('old versions become a line of commits on main, oldest first', mv.length === 2 && mv[1].message === 'first' && mv[0].parents[0] === mv[1].id && headId(Hv) === mv[0].id && mv[0].thumb === 'x');

console.log(fails ? `${fails} FAILED` : 'history: all passed');
process.exit(fails ? 1 : 0);
