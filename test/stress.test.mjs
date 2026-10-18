// Feature-mix stress test: random sequences that combine the newer tools with each other and with the basics —
// push/pull (also on extrusion ends and earlier push/pulls), fillets, face paint, symmetry, see-through, patterns,
// shell, split, arrange, auto-orient, section view, groups and holes, undo / redo, exports — checking after every
// step that nothing threw, no geometry has NaNs, the design still saves and loads, and exports produce whole files.
// A fixed seed makes a failure repeatable: node test/stress.test.mjs [seed] [steps]
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';

const SEEDS = process.argv[2] ? [+process.argv[2]] : [11, 22, 33];
const STEPS = +(process.argv[3] || 120);
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 1800000, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1400, height: 900 } });
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(ok ? 'ok  ' : 'FAIL', name, info); };

for (const SEED of SEEDS) {
	const page = await browser.newPage();
	const errors = [];
	page.on('pageerror', (e) => errors.push('pageerror: ' + e.message + ' ' + (e.stack || '').split('\n').slice(1, 4).join(' ')));
	page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
	page.on('dialog', (d) => d.accept());
	await page.goto(pathToFileURL('DraftOtter.html').href);
	await page.waitForFunction(() => document.body.classList.contains('ready'));
	await page.evaluate(() => localStorage.clear());
	await page.reload();
	await page.waitForFunction(() => document.body.classList.contains('ready'));

	const result = await page.evaluate(async ({ SEED, STEPS }) => {
		const a = window.DraftOtter, vp = a.vp;
		const V3 = vp.camera.position.constructor;
		let s = SEED >>> 0;
		const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
		const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
		const wait = (ms) => new Promise((r) => setTimeout(r, ms));
		const settle = async () => { for (let i = 0; i < 100 && a.bgBuild; i++) await a.bgBuild; };
		const all = () => { const out = []; const w = (l) => l.forEach((n) => { out.push(n); if (n.children) w(n.children); }); w(a.model.nodes); return out; };
		const tops = () => a.model.nodes;
		const solids = () => tops().filter((n) => !n.hole && n.visible);
		const log = [], problems = [], notes = [];
		const modalClick = (label) => { const b = [...document.querySelectorAll('.modal .btn')].find((x) => x.textContent.trim() === label); if (b) { b.click(); return true; } return false; };
		const closeModals = () => document.querySelectorAll('.modal-back').forEach((m) => m.remove());
		// a screen point on a random face of a part (front-facing, visible from the camera)
		const facePoint = (n) => {
			const d = vp.displays.get(n.id);
			if (!d || !d.geometry.attributes.position) return null;
			vp.render();
			d.updateWorldMatrix(true, false);
			const pos = d.geometry.attributes.position, tri = Math.floor(rnd() * (pos.count / 3));
			const c = new V3();
			for (let k = 0; k < 3; k++) c.add(new V3().fromBufferAttribute(pos, 3 * tri + k));
			c.divideScalar(3).applyMatrix4(d.matrixWorld);
			const p = vp.project(c), r = vp.canvas.getBoundingClientRect();
			if (!(p.x > 0 && p.y > 0 && p.x < r.width && p.y < r.height)) return null;
			return { clientX: r.left + p.x, clientY: r.top + p.y, button: 0 };
		};
		const frame = () => { a.setSelection([]); a.frame(); vp.render(); };
		const shapes = ['box', 'cylinder', 'sphere', 'cone', 'tube', 'prism', 'star', 'wedge', 'torus', 'capsule', 'gear'];
		const lastPP = { id: null, e: null };
		const actions = {
			add: () => { a.addShape(pick(shapes)); const n = tops()[tops().length - 1]; if (n && n.type === 'box' && rnd() < 0.5) { n.params.radius = pick([1, 2, 3]); a.commit(); } },
			addSketch: () => {
				const w = 6 + rnd() * 20, h = 6 + rnd() * 20, k = rnd() * 6;
				const params = { mode: 'extrude', height: 3 + rnd() * 10, angle: 360, axisX: 0, anchored: true, v: 2, points: [[0, 0], [w, k], [w - k, h], [0, h]], segs: [{ a: 0, b: 1 }, { a: 1, b: 2 }, { a: 2, b: 3 }, { a: 3, b: 0 }], circles: [], cons: [], radii: {} };
				a.model.nodes.push({ id: 'n' + Math.random().toString(36).slice(2, 10), seq: Date.now() * 1000 + Math.floor(rnd() * 999), type: 'sketch', name: 'Sketch', params, pos: [rnd() * 40 - 20, rnd() * 40 - 20, 0], rot: [0, 0, 0], scale: [1, 1, 1], color: '#3aa0e8', visible: true, locked: false, hole: false });
				a.commit();
			},
			param: () => {
				const n = pick(all().filter((x) => x.params && ['box', 'cylinder', 'sphere', 'cone', 'tube', 'prism', 'sketch'].includes(x.type)));
				if (!n) return;
				const nums = Object.entries(n.params).filter(([k, v]) => typeof v === 'number' && !['seg', 'v', 'angle', 'sides', 'axisX'].includes(k));
				if (!nums.length) return;
				const [k, v] = pick(nums);
				n.params[k] = Math.max(0.5, Math.round(v * (0.7 + rnd() * 0.6) * 100) / 100);
				a.commit();
			},
			move: () => { const n = pick(tops()); if (!n) return; n.pos = n.pos.map((p, i) => (i === 2 ? p : p + (rnd() - 0.5) * 20)); a.commit(); },
			rotate: () => { const n = pick(tops()); if (!n) return; a.setSelection([n.id]); a.rotateSel(pick(['x', 'y', 'z']), pick([15, 45, 90])); },
			hole: () => { const n = pick(tops()); if (!n) return; a.setSelection([n.id]); a.toggleHole(); },
			group: () => { const t = tops(); if (t.length < 2) return; const ids = t.slice().sort(() => rnd() - 0.5).slice(0, 2 + Math.floor(rnd() * 2)).map((n) => n.id); a.setSelection(ids); a.group(pick(['union', 'union', 'intersect'])); },
			ungroup: () => { const g = pick(tops().filter((n) => n.type === 'group')); if (!g) return; a.setSelection([g.id]); a.ungroup(); },
			pushpull: async () => {
				const n = pick(solids());
				if (!n) return;
				frame();
				a.setTool('pushpull');
				const e = facePoint(n);
				const f = e && vp.pushPull.pickFace(e);
				if (!f) { a.setTool(null); return; }
				vp.pushPull.sel = f;
				vp.pushPull.distance = pick([-3, -1.5, -0.5, 0.5, 1, 2, 4, 6]);
				a.applyPushPull();
				lastPP.id = n.id; lastPP.e = e;
				a.setTool(null);
			},
			pushpullAgain: async () => {
				// the same spot again: the end of what was just pulled (exercises changing the earlier feature)
				if (!lastPP.e) return;
				a.setTool('pushpull');
				const f = vp.pushPull.pickFace(lastPP.e);
				if (!f) { a.setTool(null); return; }
				vp.pushPull.sel = f;
				vp.pushPull.distance = pick([-6, -4, -2, -1, 1, 2]);
				a.applyPushPull();
				a.setTool(null);
			},
			fillet: () => {
				const n = pick(solids());
				if (!n) return;
				a.setTool('fillet');
				const ft = vp.filletTool;
				const chains = ft.edgesOf(n.id) || [];
				if (!chains.length) { a.setTool(null); return; }
				ft.target = n.id;
				const convex = chains.map((c, i) => (c.convex ? i : -1)).filter((i) => i >= 0);
				const pool = convex.length ? convex : chains.map((_, i) => i);
				for (let i = 0; i < 1 + Math.floor(rnd() * 4); i++) ft.selected.add(pick(pool));
				a.filletKind = pick(['fillet', 'chamfer']);
				a.filletSize = String(pick([0.5, 1, 1.5, 2]));
				a.filletVariable = false;
				a.applyEdgeOp();
				a.setTool(null);
			},
			paint: () => {
				const n = pick(solids());
				if (!n) return;
				frame();
				a.setTool('paint');
				a.paintColor = pick(['#e03a3a', '#2f7de1', '#f2c230', '#1a1a1a']);
				a.paintMode = rnd() < 0.15 ? 'erase' : 'fill';
				const e = facePoint(n);
				if (e) a.onPaintClick(e);
				a.setTool(null);
			},
			symmetry: () => {
				const n = pick(solids());
				if (!n) return;
				a.setSelection([n.id]);
				a.startSymmetry();
				if (!a.symPending) return;
				a.symPending.n = 1 + Math.floor(rnd() * 4);
				const b = a.worldBox(n), c = b.getCenter(new V3());
				a.applySymmetry(rnd() < 0.5 ? null : new V3(c.x + (rnd() - 0.5) * 6, c.y + (rnd() - 0.5) * 6, c.z));
			},
			editSymmetry: () => {
				const g = pick(all().filter((x) => x.type === 'group' && x.mode === 'symmetric'));
				if (!g) return;
				g.sym = { ...g.sym, n: 1 + Math.floor(rnd() * 5), angle: Math.round(rnd() * 180), axis: pick([[0, 0, 1], [1, 0, 0], [0, 1, 0]]) };
				a.commit();
			},
			seeThrough: () => { const n = pick(solids()); if (!n) return; n.seeThrough = !n.seeThrough; n.opacity = pick([0.2, 0.5, 0.8]); a.commit(); },
			pattern: () => {
				const n = pick(tops());
				if (!n) return;
				a.setSelection([n.id]);
				a.arrayDialog(pick(['linear', 'circular', 'grid']));
				if (!modalClick('Create')) closeModals();
			},
			shell: () => {
				const n = pick(solids().filter((x) => x.type !== 'group'));
				if (!n) return;
				a.setSelection([n.id]);
				a.shellDialog();
				if (!modalClick('Shell')) closeModals();
			},
			split: () => {
				const n = pick(solids());
				if (!n) return;
				a.setSelection([n.id]);
				a.splitDialog();
				if (!modalClick('Split')) closeModals();
			},
			arrange: () => { const ns = solids(); if (!ns.length) return; a.arrangeOnBed(ns, { gap: pick([2, 5]), rotate: rnd() < 0.5 }); },
			orient: () => {
				const n = pick(solids());
				if (!n) return;
				a.setSelection([n.id]);
				a.autoOrientDialog();
				if (!modalClick('Apply')) closeModals();
			},
			section: () => { a.toggleSection(); },
			mirror: () => { const n = pick(tops()); if (!n) return; a.setSelection([n.id]); a.mirror(pick(['x', 'y'])); },
			dup: () => { const n = pick(tops()); if (!n) return; a.setSelection([n.id]); a.duplicate(); },
			del: () => { if (tops().length < 3) return; const n = pick(tops()); a.setSelection([n.id]); a.deleteSel(); },
			undo: () => { for (let i = 0, k = 1 + Math.floor(rnd() * 3); i < k; i++) a.undo(); },
			redo: () => { a.redo(); },
			export: async () => {
				const ns = tops().filter((n) => n.visible);
				if (!ns.length) return;
				const fmt = pick(['stl', '3mf', 'step']);
				let blob = null;
				const orig = URL.createObjectURL;
				URL.createObjectURL = (b) => { blob = b; return orig.call(URL, new Blob([])); };
				try { a.doExport(ns, 'stress', true, fmt); } finally { URL.createObjectURL = orig; }
				if (!blob) { notes.push(`export ${fmt}: nothing written`); return; }
				const bytes = new Uint8Array(await blob.arrayBuffer());
				if (fmt === 'stl' && (bytes.length - 84) % 50) problems.push(`export stl: ${bytes.length} bytes is not whole triangles`);
				if (fmt === '3mf' && !(bytes[0] === 0x50 && bytes[1] === 0x4b)) problems.push('export 3mf: not a zip');
				if (fmt === 'step') { const t = new TextDecoder().decode(bytes); if (!t.startsWith('ISO-10303-21') || !t.trim().endsWith('END-ISO-10303-21;')) problems.push('export step: incomplete file'); if (/NaN|Infinity/.test(t)) problems.push('export step: NaN in file'); }
			},
		};
		const weights = { add: 6, addSketch: 2, param: 3, pushpull: 6, pushpullAgain: 3, fillet: 3, paint: 3, symmetry: 2, editSymmetry: 1, group: 2, hole: 2, undo: 4, export: 2 };
		const names = Object.keys(actions);
		const bag = names.flatMap((k) => Array(weights[k] || 1).fill(k));
		// start with a few parts
		for (let i = 0; i < 3; i++) actions.add();
		for (let step = 0; step < STEPS; step++) {
			const act = pick(bag);
			log.push(act);
			try {
				await actions[act]();
				await settle();
				closeModals();
				if (a.tool) a.setTool(null);
			} catch (e) {
				problems.push(`step ${step} ${act}: threw ${e.message} ${(e.stack || '').split('\n').slice(1, 3).join(' ')}`);
				break;
			}
			try {
				const d = JSON.parse(a.model.serialize());
				if (!Array.isArray(d.doc.nodes)) problems.push(`step ${step} ${act}: bad document`);
				const ids = all().map((n) => n.id);
				if (new Set(ids).size !== ids.length) problems.push(`step ${step} ${act}: duplicate ids`);
				if (a.sel.some((id) => !a.model.get(id))) problems.push(`step ${step} ${act}: selection has deleted objects`);
				for (const n of all()) {
					const g = a.engine.cache.get(a.engine.key(n));
					if (!g || !g.attributes.position) continue;
					const p = g.attributes.position.array;
					for (let i = 0; i < p.length; i++) if (!Number.isFinite(p[i])) { problems.push(`step ${step} ${act}: NaN in ${n.type}${n.mode ? '/' + n.mode : ''}`); break; }
				}
				for (const n of tops()) {
					const dsp = vp.displays.get(n.id);
					if (!dsp) problems.push(`step ${step} ${act}: ${n.name} has no display`);
				}
				if (a.symPending || a.symRepick) problems.push(`step ${step} ${act}: symmetry pick left on`);
				// undo then redo gives back exactly this design
				if (a.model.canUndo()) {
					const here = JSON.stringify(a.model.designState());
					a.undo(); await settle();
					a.redo(); await settle();
					const back = JSON.stringify(a.model.designState());
					if (back !== here) {
						let i = 0;
						while (i < here.length && here[i] === back[i]) i++;
						problems.push(`step ${step} ${act}: undo + redo changed the design near …${here.slice(Math.max(0, i - 80), i + 60)}… vs …${back.slice(Math.max(0, i - 80), i + 60)}…`);
					}
				}
			} catch (e) {
				problems.push(`step ${step} ${act}: invariant check threw ${e.message}`);
			}
			if (problems.length > 4) break;
		}
		const before = JSON.stringify(a.model.designState());
		const d = JSON.parse(a.model.serialize());
		a.model.load(d.doc, d.blobs);
		a.afterChange();
		await settle();
		if (JSON.stringify(a.model.designState()) !== before) problems.push('save → load changed the design');
		const failed = [...a.engine.errors].map((id) => a.model.get(id)).filter(Boolean).map((n) => `${n.name} (${n.type}${n.mode ? '/' + n.mode : ''})`);
		return { steps: log.length, problems, notes, failed, parts: tops().length, counts: Object.fromEntries(names.map((k) => [k, log.filter((x) => x === k).length])) };
	}, { SEED, STEPS });
	console.log(`seed ${SEED}:`, JSON.stringify(result.counts));
	if (result.notes.length) console.log('  notes:', result.notes.slice(0, 6).join(' | '));
	if (result.failed.length) console.log('  parts flagged with build errors:', result.failed.join(', '));
	check(`seed ${SEED}: ${result.steps} mixed steps with no exceptions or broken invariants`, !result.problems.length, result.problems.join('\n   '));
	check(`seed ${SEED}: no page errors`, !errors.length, errors.slice(0, 6).join('\n   '));
	await page.close();
}
await browser.close();
console.log(fails ? `${fails} FAILED` : 'stress: all passed');
process.exit(fails ? 1 : 0);
