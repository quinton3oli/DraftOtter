// Random-use stress test: hundreds of random actions through the app (shapes, groups and cuts, parameters,
// textures, deforms, sketches, undo / redo, copy / paste, tabs, commits / branches / merges, sculpting, export),
// checking after every step that nothing threw, the design still saves and loads, and undo history is sound.
// A fixed seed makes a failure repeatable: node test/fuzz.test.mjs [seed] [steps]
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';

const SEED = +(process.argv[2] || 1234), STEPS = +(process.argv[3] || 260);
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 900000, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1400, height: 900 } });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message + ' ' + (e.stack || '').split('\n').slice(1, 3).join(' ')));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('dialog', (d) => d.accept());
await page.goto(pathToFileURL('LocalCAD.html').href);
await page.waitForFunction(() => document.body.classList.contains('ready'));
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForFunction(() => document.body.classList.contains('ready'));

const result = await page.evaluate(async ({ SEED, STEPS }) => {
	const a = window.LocalCAD;
	let s = SEED >>> 0;
	const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
	const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
	const settle = async () => { for (let i = 0; i < 100 && a.bgBuild; i++) await a.bgBuild; };
	const all = () => { const out = []; const w = (l) => l.forEach((n) => { out.push(n); if (n.children) w(n.children); }); w(a.model.nodes); return out; };
	const tops = () => a.model.nodes;
	const log = [];
	const problems = [];
	const shapes = ['box', 'cylinder', 'sphere', 'cone', 'tube', 'torus', 'prism', 'star', 'gear', 'capsule', 'wedge', 'screwhole', 'thread', 'cup', 'knob', 'lbracket'];
	const actions = {
		add: () => { a.addShape(pick(shapes)); },
		addSketch: () => {
			const w = 5 + rnd() * 20, h = 5 + rnd() * 20;
			const params = { mode: rnd() < 0.3 ? 'revolve' : 'extrude', height: 2 + rnd() * 10, angle: 360, axisX: 0, anchored: true, v: 2, points: [[1, 0], [1 + w, 0], [1 + w, h], [1, h]], segs: [{ a: 0, b: 1 }, { a: 1, b: 2, ...(rnd() < 0.4 ? { arc: 0.3 } : {}) }, { a: 2, b: 3 }, { a: 3, b: 0 }], circles: [], cons: [], radii: {} };
			const n = { id: 'n' + Math.random().toString(36).slice(2, 10), seq: Date.now() * 1000, type: 'sketch', name: 'Sketch', params, pos: [rnd() * 60 - 30, rnd() * 60 - 30, 0], rot: [0, 0, 0], scale: [1, 1, 1], color: '#3aa0e8', visible: true, locked: false, hole: false };
			a.model.nodes.push(n); a.commit();
		},
		param: () => {
			const n = pick(all().filter((x) => x.type !== 'group' && x.type !== 'mesh' && x.type !== 'sketch'));
			if (!n) return;
			const nums = Object.entries(n.params).filter(([, v]) => typeof v === 'number');
			if (!nums.length) return;
			const [k, v] = pick(nums);
			n.params[k] = Math.max(0.5, Math.round(v * (0.6 + rnd() * 0.8) * 100) / 100);
			a.commit();
		},
		move: () => { const n = pick(tops()); if (!n) return; n.pos = n.pos.map((p) => p + (rnd() - 0.5) * 20); a.commit(); },
		rotate: () => { const n = pick(tops()); if (!n) return; a.setSelection([n.id]); a.rotateSel(pick(['x', 'y', 'z']), pick([15, 45, 90])); },
		hole: () => { const n = pick(tops()); if (!n) return; a.setSelection([n.id]); a.toggleHole(); },
		group: () => { const t = tops(); if (t.length < 2) return; const k = Math.min(t.length, 2 + Math.floor(rnd() * 3)); const ids = t.slice().sort(() => rnd() - 0.5).slice(0, k).map((n) => n.id); a.setSelection(ids); a.group(pick(['union', 'union', 'intersect', 'hull'])); },
		ungroup: () => { const g = pick(tops().filter((n) => n.type === 'group')); if (!g) return; a.setSelection([g.id]); a.ungroup(); },
		texture: () => { const n = pick(tops().filter((x) => !x.hole)); if (!n) return; a.setSelection([n.id]); a.group('texture', 'Texture', { texture: { pattern: pick(['knurl', 'ribs', 'bumps', 'noise']), size: 2 + rnd() * 3, depth: (rnd() - 0.3) * 0.8, angle: 45, faces: pick(['all', 'sides', 'top']), mapping: 'box', detail: 1.2, seed: 1 } }); },
		deform: () => { const n = pick(tops().filter((x) => !x.hole)); if (!n) return; a.setSelection([n.id]); a.group('deform', 'Deform', { deform: { axis: pick(['x', 'y', 'z']), bend: pick([0, 30, -45]), bendDir: '+x', twist: pick([0, 30, 90]), taper: pick([1, 0.7]), lattice: null, detail: 16 } }); },
		offset: () => { const n = pick(tops()); if (!n) return; a.setSelection([n.id]); a.group('offset', null, { offset: pick([0.5, -0.3, 1]) }); },
		del: () => { const n = pick(tops()); if (!n) return; a.setSelection([n.id]); a.deleteSel(); },
		dup: () => { const n = pick(tops()); if (!n) return; a.setSelection([n.id]); a.duplicate(); },
		copyPaste: () => { const n = pick(tops()); if (!n) return; a.setSelection([n.id]); a.copy(); a.paste(); },
		undo: () => { for (let i = 0, k = 1 + Math.floor(rnd() * 3); i < k; i++) a.undo(); },
		redo: () => { a.redo(); },
		mirror: () => { const n = pick(tops()); if (!n) return; a.setSelection([n.id]); a.mirror(pick(['x', 'y', 'z'])); },
		drop: () => { a.setSelection(tops().map((n) => n.id)); a.dropToBed(); },
		variable: () => { a.model.doc.vars = [{ name: 'w', expr: String(2 + Math.floor(rnd() * 8)) }]; const n = pick(all().filter((x) => x.type === 'box')); if (n) { a.setExpr(n, 'params.w', 'w*3'); } a.commit(); },
		commit: () => { a.histCommit('fuzz ' + log.length); },
		branch: async () => { const H = a.hist(); const name = 'b' + Object.keys(H.branches).length; await a.newBranch(name); },
		switchBranch: async () => { const H = a.hist(); const b = pick(Object.keys(H.branches)); await a.switchBranch(b, 'commit'); },
		merge: async () => { const H = a.hist(); const others = Object.keys(H.branches).filter((b) => b !== H.head); if (!others.length) return; const r = await a.mergeBranch(pick(others)); if (r === 'conflicts') { if (rnd() < 0.5) await a.finishMerge(); else await a.abortMerge(); } },
		newTab: async () => { if (a.tabs.length < 4) await a.newTab(); },
		switchTab: async () => { await a.switchTab(Math.floor(rnd() * a.tabs.length)); },
		closeTab: async () => { if (a.tabs.length > 1) await a.closeTab(Math.floor(rnd() * a.tabs.length), true); },
		sculpt: async () => {
			const n = pick(tops().filter((x) => !x.hole && x.type !== 'group'));
			if (!n || a.engine.stats([n]).tris > 20000) return;
			a.setSelection([n.id]);
			a.startSculpt(n);
			const btn = [...document.querySelectorAll('.modal .btn')].find((b) => b.textContent === 'Start sculpting');
			if (btn) { document.querySelector('#sc-detail').value = 'low'; btn.click(); }
			for (let i = 0; i < 100 && !a.sculpt; i++) await new Promise((r) => setTimeout(r, 30));
			if (!a.sculpt) { document.querySelectorAll('.modal-back').forEach((m) => m.remove()); return; }
			const ses = a.sculpt.session, b = ses.geometry.boundingBox;
			const c = [(b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, b.max.z];
			const brush = pick(['draw', 'clay', 'inflate', 'smooth', 'pinch', 'crease']);
			ses.beginStroke(brush); ses.changed(ses.dab(brush, c, { radius: Math.max(1, (b.max.x - b.min.x) / 4), strength: 0.6, falloff: 'smooth', symmetry: [true, false, false] })); ses.endStroke();
			a.sculpt.modified = true;
			a.exitSculpt(rnd() < 0.8);
		},
		exportSTL: () => { const nodes = tops().filter((n) => n.visible); if (!nodes.length) return; const g = a.engine.printable(nodes, true); if (g && g.attributes.position.count % 3) problems.push('export: partial triangle'); },
	};
	const names = Object.keys(actions);
	const weights = { add: 6, addSketch: 2, param: 6, move: 4, hole: 3, group: 4, undo: 4, del: 2 };
	const bag = names.flatMap((k) => Array(weights[k] || 1).fill(k));
	for (let step = 0; step < STEPS; step++) {
		const act = pick(bag);
		log.push(act);
		try {
			await actions[act]();
			await settle();
		} catch (e) {
			problems.push(`step ${step} ${act}: threw ${e.message} ${(e.stack || '').split('\n')[1] || ''}`);
			break;
		}
		// invariants
		try {
			const ser = a.model.serialize();
			const d = JSON.parse(ser);
			if (!Array.isArray(d.doc.nodes)) problems.push(`step ${step} ${act}: bad document`);
			// every mesh part's data is saved with the design
			for (const n of all()) if (n.type === 'mesh' && !d.blobs[n.params.blob]) problems.push(`step ${step} ${act}: mesh data missing for ${n.name}`);
			// ids are unique
			const ids = all().map((n) => n.id);
			if (new Set(ids).size !== ids.length) problems.push(`step ${step} ${act}: duplicate ids`);
			// the undo position is valid
			if (a.model.hIndex < 0 || a.model.hIndex >= a.model.history.length) problems.push(`step ${step} ${act}: undo index out of range`);
			if (a.sel.some((id) => !a.model.get(id))) problems.push(`step ${step} ${act}: selection has deleted objects`);
			// no shape has invalid (NaN) coordinates
			for (const n of all()) {
				const g = a.engine.cache.get(a.engine.key(n));
				if (!g || !g.attributes.position) continue;
				const p = g.attributes.position.array;
				for (let i = 0; i < p.length; i++) if (!Number.isFinite(p[i])) { problems.push(`step ${step} ${act}: NaN in ${n.type} ${JSON.stringify(n.type === 'group' ? { mode: n.mode, texture: n.texture, deform: n.deform, offset: n.offset } : n.params)}`); break; }
			}
			if (a.sculpt || a.merging || a.lattice) problems.push(`step ${step} ${act}: a mode was left on (${a.sculpt ? 'sculpt' : a.merging ? 'merge' : 'lattice'})`);
		} catch (e) {
			problems.push(`step ${step} ${act}: invariant check threw ${e.message}`);
		}
		if (problems.length > 5) break;
	}
	// finally: reload-safe (save → load gives the same design)
	const before = JSON.stringify(a.model.designState());
	const d = JSON.parse(a.model.serialize());
	a.model.load(d.doc, d.blobs);
	a.afterChange();
	if (JSON.stringify(a.model.designState()) !== before) problems.push('save → load changed the design');
	const failedGroups = [...a.engine.errors].map((id) => a.model.get(id)).filter(Boolean).map((n) => n.name);
	return { steps: log.length, problems, failedGroups, parts: a.model.nodes.length, tabs: a.tabs.length, commits: Object.keys(a.hist().commits).length, counts: Object.fromEntries(names.map((k) => [k, log.filter((x) => x === k).length])) };
}, { SEED, STEPS });

let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(ok ? 'ok  ' : 'FAIL', name, info); };
console.log(`seed ${SEED}: ${result.steps} steps, ${result.parts} parts, ${result.tabs} tabs, ${result.commits} commits`);
console.log('actions:', JSON.stringify(result.counts));
check('no action threw and every check held', result.problems.length === 0, result.problems.join('\n     '));
check('no page errors', errors.length === 0, errors.slice(0, 8).join('\n     '));
if (result.failedGroups.length) console.log('     (booleans that could not be computed, shown as errors in the app):', result.failedGroups.join(', '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'fuzz: all passed');
process.exit(fails ? 1 : 0);
