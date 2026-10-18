// DraftOtter application: wires model, engine, viewport and UI together.
import * as THREE from 'three';
import Module from 'manifold-3d/manifold.js';
import wasmBinary from 'manifold-3d/manifold.wasm';
import { Model, makeNode, makeGroup, cloneWithNewIds, walk } from './model.js';
import { Engine, nodeMatrix, initManifold, hasManifold } from './engine.js';
import { SHAPES, buildShape, offsetPolygon } from './shapes.js';
import { LIBRARY_SECTIONS } from './advanced.js';
import { Viewport, planeBasis } from './viewport.js';
import { sectionNormal, sectionBase, sectionTilts, setSectionTilts, tiltAxisNames } from './sectiontool.js';
import { openSketchEditor } from './sketch.js';
import { stlBinary, stlAscii, parseSTL } from './io.js';
import { stepFromPositions } from './step.js';
import { build3MF } from './threemf.js';
import { readZip, makeZip } from './zip.js';
import { massProps } from './analysis.js';
import { SplitMixin } from './split.js';
import { VectorMixin } from './vectorUI.js';
import { PrintCheckMixin } from './printcheck.js';
import { FitMixin, FITS, fitClearance, fitAxes, fittedParams } from './fits.js';
import { loadFitCache } from './fitcache.js';
import { CsgPool } from './workers.js';
import { ConfigMixin, TemplateMixin } from './params.js';
import { VersionMixin } from './versions.js';
import { AssemblyMixin } from './assembly.js';
import { WrapMixin } from './wrap.js';
import { TimelineMixin } from './timeline.js';
import { DrawingMixin } from './drawing.js';
import { FontPickerMixin } from './fontpicker.js';
import { createShellPicker } from './shellpick.js';
import { readCADFile, storeBody } from './stepimport.js';
import { HoleWizardMixin } from './holewizard.js';
import { FeaMixin } from './feaui.js';
import { ArrangeMixin } from './arrange.js';
import { RoundMixin, snapTo, snapNoise, snapMeasured, snapAngle, mapNumbers } from './rounding.js';
import { ImageImportMixin, isImageFile } from './imageimport.js';
import { MeshImportMixin, isMeshFile } from './meshimport.js';
import { parse3MF, is3MF } from './threemfimport.js';
import { RenderMixin } from './render.js';
import { PaintMixin } from './paintui.js';
import { PrintPrepMixin } from './printprep.js';
import { SymmetryMixin } from './symmetry.js';
import { exportColors, effectivePaint } from './paint.js';
import { ReliefMixin } from './relief.js';
import { ClaudeLinkMixin } from './claudelink.js';
import { ModifierMixin } from './modifyui.js';
import { HistoryMixin } from './historyui.js';
import { PwaMixin } from './pwa.js';
import { SculptMixin } from './sculptui.js';
import { TabsMixin } from './tabs.js';
import { holeCallout } from './holes.js';
import { DEG, round, fmt, evalExpr, isExpression, exprError, exprNames, renameInExpr, resolveVars, EXPR_FUNCS, f32ToBase64, hashString, download, toast, el, readFile, pickFile, idbGet, idbSet } from './util.js';
import { solveModel } from './constraints.js';
import { toModel, modelToParams, profileRegions, modelFromRegions, scaleModel, sketchPaths } from './sketchModel.js';
import { ICONS, icon } from './icons.js';

const AUTOSAVE_KEY = 'draftotter-autosave-v1';
// identifies this build of the app (set by build.mjs): caches made by an older build are not reused
const BUILD = typeof __DRAFTOTTER_BUILD__ !== 'undefined' ? __DRAFTOTTER_BUILD__ : 'dev';
// bump to redraw every library picture (e.g. after changing how they are lit)
const THUMB_VERSION = 't1:';
// when the user last pressed, dragged, scrolled or typed (background work waits for a quiet moment)
let lastInteraction = 0;
if (typeof window !== 'undefined') for (const ev of ['pointerdown', 'pointerup', 'wheel', 'keydown']) window.addEventListener(ev, () => { lastInteraction = performance.now(); }, { capture: true, passive: true });
if (typeof window !== 'undefined') window.addEventListener('pointermove', () => { lastInteraction = performance.now(); }, { capture: true, passive: true }); // hovering counts too (it picks faces and handles)
const FACE_OVERLAP = 0.02; // how far an extrusion sketched on a face reaches back into the face (inside the part)
const LIBRARY_KEY = 'draftotter-library-v1';
const PANELS_KEY = 'draftotter-panels';
// running as an installed app: its window title already starts with the app's name
const installedApp = () => (window.matchMedia && window.matchMedia('(display-mode: standalone), (display-mode: window-controls-overlay), (display-mode: minimal-ui)').matches) || navigator.standalone === true;
const $ = (s) => document.querySelector(s);

/**
 * Push/pull outlines and placement are measured off 32-bit mesh data. On a face lined up with X, Y or Z they go to
 * whole microns (46.9997 → 47), so the new faces line up with a design's round numbers. On a slanted face the true
 * values are irrational: rounding them would move the push/pull off its face, so only float noise is removed there.
 * (What is left where faces meet, a fraction of a micron, is merged when the feature group is built.) Returns how
 * many values changed.
 */
function snapPushPull(n, ex = {}) {
	const aligned = n.type === 'faceoff' || (n.rot || [0, 0, 0]).every((d) => Math.abs(d / 90 - Math.round(d / 90)) < 1e-9);
	const snap = aligned ? (x) => snapTo(x, 0.001) : snapMeasured;
	let changed = 0;
	for (let i = 0; i < 3; i++) if (!ex['pos.' + i]) { const v = snap(n.pos[i]); if (v !== n.pos[i]) { n.pos[i] = v; changed++; } }
	for (const k of ['loops', 'V', 'outline']) if (Array.isArray(n.params[k])) changed += mapNumbers(n.params[k], snap);
	return changed;
}

const PRESETS = {
	holeCyl: { label: 'Round hole', make: () => makeNode('cylinder', { r: 5, h: 20 }, { hole: true, name: 'Round hole' }) },
	holeBox: { label: 'Box hole', make: () => makeNode('box', {}, { hole: true, name: 'Box hole' }) },
	polyTetra: { label: 'Tetrahedron', make: () => makeNode('polyhedron', { kind: 'tetrahedron' }, { name: 'Tetrahedron' }) },
	polyOcta: { label: 'Octahedron', make: () => makeNode('polyhedron', { kind: 'octahedron' }, { name: 'Octahedron' }) },
	polyDodeca: { label: 'Dodecahedron', make: () => makeNode('polyhedron', { kind: 'dodecahedron' }, { name: 'Dodecahedron' }) },
	polyIcosa: { label: 'Icosahedron', make: () => makeNode('polyhedron', { kind: 'icosahedron' }, { name: 'Icosahedron' }) },
	geodesic: { label: 'Geodesic sphere', make: () => makeNode('polyhedron', { kind: 'icosahedron', detail: 2, flat: false }, { name: 'Geodesic sphere' }) },
	loftDuct: { label: 'Duct adapter', make: () => makeNode('loft', { bShape: 'rectangle', bW: 40, bD: 25, bR: 3, tShape: 'circle', tW: 26, h: 35, offsetY: 6, wall: 1.6 }, { name: 'Duct adapter' }) },
	loftTwist: { label: 'Twisted loft', make: () => makeNode('loft', { bShape: 'polygon', bSides: 5, bW: 36, bR: 2, tShape: 'circle', tW: 18, h: 40, twist: 72 }, { name: 'Twisted loft' }) },
	sweepTube: { label: 'Bent tube', make: () => makeNode('sweep', { path: '0,0,0; 50,0,0; 50,0,40; 90,0,40', cornerRadius: 12, pw: 10, wall: 1.5 }, { name: 'Bent tube' }) },
	sweepHandle: { label: 'Spline handle', make: () => makeNode('sweep', { path: '0,0,0; 10,0,25; 40,0,35; 70,0,25; 80,0,0', smooth: true, profile: 'rectangle', pw: 10, ph: 14 }, { name: 'Handle' }) },
	washer: { label: 'Washer', make: () => makeNode('tube', { ro: 5, ri: 2.7, h: 1, seg: 64 }, { name: 'M5 washer', color: '#c0c8d0' }) },
	screwPlain: { label: 'Screw hole', make: () => makeNode('screwhole', { style: 'plain' }, { name: 'M3 screw hole' }) },
	screwCsk: { label: 'Countersunk', make: () => makeNode('screwhole', { style: 'countersunk' }, { name: 'M3 countersunk hole' }) },
	screwCb: { label: 'Counterbore', make: () => makeNode('screwhole', { style: 'counterbore' }, { name: 'M3 counterbored hole' }) },
	screwInsert: { label: 'Heat-set insert', make: () => makeNode('screwhole', { style: 'insert', depth: 6 }, { name: 'M3 heat-set insert hole' }) },
	screwNut: { label: 'Nut trap', make: () => makeNode('screwhole', { style: 'nuttrap' }, { name: 'M3 nut trap' }) },
	holeWizard: { label: 'Wizard hole', make: () => makeNode('wizhole', {}, { name: 'M3 clearance hole' }) },
	nut: {
		label: 'Hex nut',
		make: () => makeGroup([
			makeNode('prism', { sides: 6, r: 6.5, sizeBy: 'flats', h: 6.5 }, { name: 'Nut body', color: '#a8b4c0' }),
			makeNode('thread', { d: 8, pitch: 1.25, length: 8.5, clearance: 0.15, chamfer: false }, { hole: true, name: 'M8 thread' }),
		], { name: 'Hex nut M8', color: '#a8b4c0' }),
	},
	bolt: {
		label: 'Hex bolt',
		make: () => {
			const head = makeNode('prism', { sides: 6, r: 6.5, sizeBy: 'flats', h: 5.3, fillet: 0.6 }, { name: 'Head', color: '#a8b4c0' });
			head.pos = [0, 0, 20 + 5.3 / 2 - 12.65];
			const shank = makeNode('thread', { d: 8, pitch: 1.25, length: 20.5, clearance: -0.1 }, { name: 'M8 thread', color: '#a8b4c0' });
			shank.pos = [0, 0, 10.25 - 12.65]; // overlaps the head by 0.5 mm so the union is solid
			return makeGroup([head, shank], { name: 'Hex bolt M8×20', color: '#a8b4c0' });
		},
	},
};

// Extra search words for the Shapes panel.
const KEYWORDS = {
	box: 'cube block rectangle', cylinder: 'rod disc round', sphere: 'ball', hemisphere: 'dome half sphere', tube: 'pipe ring washer arc',
	prism: 'polygon hexagon octagon', text: 'letters label emboss engrave', capsule: 'pill rounded rod', ellipsoid: 'egg oval',
	polyTetra: 'polyhedron platonic d4 dice', polyOcta: 'polyhedron platonic d8 dice', polyDodeca: 'polyhedron platonic d12 dice', polyIcosa: 'polyhedron platonic d20 dice', geodesic: 'icosphere dome',
	torusknot: 'knot trefoil', twisted: 'vase spiral taper twist', heart: 'love', arrow: 'pointer direction', cross: 'plus', slot: 'stadium obround oval hole', reuleaux: 'triangle constant width',
	cup: 'mug container cylinder hollow', bowl: 'dish container', funnel: 'cone pour', elbow: 'pipe bend tube 90',
	gear: 'spur cog helical herringbone involute', loft: 'blend transition morph adapter', loftDuct: 'loft hose fan duct adapter square round', loftTwist: 'loft twist vase',
	sweep: 'path tube pipe wire rail extrude along', sweepTube: 'sweep pipe tube bend', sweepHandle: 'sweep spline handle grip arch', ringgear: 'internal planetary gear', rack: 'linear gear', pulley: 'timing belt gt2 gear', cam: 'eccentric', spring: 'coil helix',
	thread: 'screw bolt rod metric', nut: 'hex', bolt: 'screw hex', washer: 'spacer ring', standoff: 'spacer pcb hex', dshaft: 'motor shaft axle', splineshaft: 'shaft axle',
	knob: 'handle grip dial', bearingholder: 'pillow block 608 bearing mount',
	lbracket: 'angle corner mount', tslot: 'aluminium aluminum extrusion v-slot 2020', dovetail: 'joint slide joinery', snaphook: 'clip latch snap fit',
	filletstrip: 'cove radius corner', honeycomb: 'hex lightweight panel grille', gridpanel: 'pegboard perforated holes grille vent', hook: 'hanger j hook',
	holeCyl: 'cylinder hole', screwPlain: 'clearance', screwCsk: 'countersink flat head', screwCb: 'socket head cap', screwInsert: 'brass heat set threaded', screwNut: 'captive nut pocket',
};

const PRINTERS = {
	'Custom': null,
	'Bambu Lab X1C / X1 / P1 / P2': [256, 256, 256],
	// H2D / H2C: the volume one nozzle reaches (both together: 350 / 330 × 320 × 325)
	'Bambu Lab H2D': [325, 320, 325],
	'Bambu Lab H2C': [325, 320, 325],
	'Bambu Lab A1': [256, 256, 256],
	'Bambu Lab A1 mini': [180, 180, 180],
	'Prusa MK4 / MK4S': [250, 210, 220],
	'Prusa MINI': [180, 180, 180],
	'Prusa XL': [360, 360, 360],
	'Creality Ender 3 (V2/V3)': [220, 220, 250],
	'Creality K1 / K1C': [220, 220, 250],
	'Creality K1 Max': [300, 300, 300],
	'Voron 2.4 (350)': [350, 350, 340],
	'Elegoo Neptune 4': [225, 225, 265],
	'Anycubic Kobra 2': [220, 220, 250],
};

class App {
	constructor() {
		this.model = new Model();
		this.engine = new Engine(this.model);
		this.sel = [];
		this.clipboard = null;
		this.lastDup = null;
		this.propSig = null;
		this.fields = [];
		this.statsTimer = null;
	}

	async init() {
		this.buildToolbar();
		this.buildPanelToggles();
		this.buildLeftTabs();
		this.buildStatsToggle();
		this.vp = new Viewport($('#viewport'), this);
		const ld = this.loadingScreen();
		ld.set(0.05, 'Starting the geometry engine');
		const ok = await initManifold(Module, wasmBinary);
		// background geometry workers: big joins and fit growth run there, several at once
		// (started when a build needs them, or shortly after the app is ready, so they don't slow the start)
		if (ok) this.engine.setPool(new CsgPool());
		ld.set(0.1, 'Reading saved shapes');
		await loadFitCache();
		$('#st-engine').textContent = ok ? 'CSG: Manifold (watertight)' : 'CSG: BVH fallback';
		this.loadTabSession(); // the open tabs (the active one's design is restored now, the others when opened)
		await this.restore();
		await this.prebuild(ld, 0.12, 0.95, false);
		this.fileHandle = this.model.nodes.length ? (await idbGet(this.tabKey('fileHandle'))) || null : null;
		this.buildLibrary();
		this.bindKeys();
		// Right-click is ours (orbit + object menu): suppress the browser menu everywhere except text fields.
		document.addEventListener('contextmenu', (e) => {
			if (!(e.target instanceof Element && e.target.closest('input[type=text], input[type=search], textarea, [contenteditable]'))) e.preventDefault();
		}, true);
		this.bindDrop();
		// Double-click a row to rename. Uses the click count rather than 'dblclick', because the first click
		// selects the row and redraws the list, and browsers then never fire 'dblclick'.
		$('#tree').addEventListener('click', (e) => {
			if (e.detail !== 2) return;
			const row = e.target instanceof Element && e.target.closest('.tree-row');
			if (row && !e.target.closest('button, input')) this.startRename(row.dataset.id);
		});
		this.buildSectionPanel();
		this.vp.buildBed(this.model.settings);
		this.vp.setSnap(this.model.settings);
		this.syncSnapSelect();
		this.afterChange();
		await this.restoreUndo(); // undo steps from the last session, if the design is unchanged since
		this.vp.frameBox(this.sceneBox());
		window.addEventListener('beforeunload', () => this.autosaveNow());
		ld.set(0.97, 'Preparing the 3D view');
		await this.vp.precompile();
		ld.done();
		document.body.classList.add('ready');
		this.initClaudeLink();
		this.initPwa();
		// an unexpected error: say so plainly (instead of a click that silently does nothing)
		const report = (msg) => {
			if (!msg || /ResizeObserver loop/.test(msg)) return;
			const now = Date.now();
			if (this.lastError && this.lastError.msg === msg && now - this.lastError.t < 10000) return;
			this.lastError = { msg, t: now };
			toast(`Something went wrong: ${msg}. Your design is autosaved, and Undo (Ctrl+Z) steps back.`, 'error', 7000);
		};
		window.addEventListener('error', (e) => report(e.message));
		window.addEventListener('unhandledrejection', (e) => report(e.reason && (e.reason.message || String(e.reason))));
		setTimeout(() => { if (this.engine.pool) this.engine.pool.start(); }, 1500);
	}

	// ============================================================ state

	async restore() {
		try {
			const key = this.tabKey(AUTOSAVE_KEY);
			let raw = localStorage.getItem(key);
			// a design too big for localStorage is autosaved in IndexedDB (see autosaveNow)
			if (raw && raw.startsWith('{"inIdb"')) raw = (await idbGet(key)) || null;
			if (raw) {
				const data = JSON.parse(raw);
				this.model.load(data.doc, data.blobs);
				this.savedSig = data.savedSig || null;
				this.fileName = data.fileName || null;
				if (this.model.nodes.length) toast('Restored your last session', 'info');
				return;
			}
		} catch (e) {
			console.warn('autosave restore failed', e);
		}
		this.model.load(this.model.emptyDoc());
	}

	/**
	 * The full-window loading screen: { set(fraction, text, sub), paint(), done() }. With lazy, it only appears once
	 * the work has taken a moment (quick opens don't flash it).
	 */
	loadingScreen(title, lazy = false) {
		let box = $('#loading');
		if (!box) {
			box = el('div', { id: 'loading' }, el('div', { class: 'ld-card' }, el('div', { class: 'ld-title' }, 'DraftOtter'), el('div', { class: 'ld-text' }), el('div', { class: 'ld-track' }, el('div', { class: 'ld-fill' })), el('div', { class: 'ld-sub' })));
			document.body.appendChild(box);
		}
		const t0 = performance.now();
		const show = () => box.classList.remove('hidden', 'gone');
		if (!lazy) show(); else box.classList.add('hidden', 'gone');
		if (title) box.querySelector('.ld-title').textContent = title;
		const fill = box.querySelector('.ld-fill'), text = box.querySelector('.ld-text'), sub = box.querySelector('.ld-sub');
		let closed = false;
		return {
			set(f, t, s) {
				if (lazy && performance.now() - t0 > 150) show();
				fill.style.width = `${Math.round(Math.max(0, Math.min(1, f)) * 100)}%`;
				if (t != null) text.textContent = t;
				sub.textContent = s || '';
			},
			paint: () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))),
			done() {
				if (closed) return;
				closed = true;
				box.classList.add('hidden');
				setTimeout(() => { if (box.classList.contains('hidden')) box.classList.add('gone'); }, 300);
			},
		};
	}

	/**
	 * Build every object's shape one at a time (inner objects first, so each step is one cut or join) while a loading
	 * screen shows the progress, then draw the scene. Already-built shapes are skipped.
	 */
	async prebuild(ld, from = 0, to = 0.95, finish = true) {
		this.syncOff();
		let last = 0;
		await this.engine.buildAsync(this.model.nodes, (done, total, n) => {
			if (performance.now() - last < 40 && done < total) return;
			last = performance.now();
			ld.set(from + ((to - from) * done) / total, `Building ${n.name || n.type}`, `${done} of ${total} shapes`);
		});
		this.tidyValues();
		this.tidyScales();
		// the tidied values are what undo goes back to (otherwise the first undo brings back 89.9999° for 90°)
		// (only for a design just opened: mid-session loads like restoring a version are undoable changes of their own)
		if (this.model.history.length === 1) this.model.rebaseSnapshot();
		ld.set(to, 'Drawing the scene');
		await ld.paint();
		if (!finish) return;
		this.afterChange();
		ld.done();
	}

	autosaveNow() {
		clearTimeout(this.autosaveTimer);
		let json;
		try {
			const data = JSON.parse(this.model.serialize());
			data.savedSig = this.savedSig || null;
			data.fileName = this.fileName || null;
			json = JSON.stringify(data);
		} catch (e) { console.warn('autosave failed', e); return; }
		const key = this.tabKey(AUTOSAVE_KEY); // each tab autosaves on its own
		try {
			localStorage.setItem(key, json);
		} catch (e) {
			// too big for localStorage (a few MB, e.g. with sculpted or imported meshes): keep it in IndexedDB instead
			idbSet(key, json);
			try { localStorage.setItem(key, JSON.stringify({ inIdb: true, time: Date.now() })); } catch (err) { /* full */ }
		}
		this.saveUndo();
		this.saveTabSession();
		this.model.pruneBlobs(Object.keys(this.clipboardBlobs || {}));
		// shapes of parts no open design has any more
		const live = new Set();
		for (const t of this.tabs || [{ model: this.model }]) if (t.model) walk(t.model.nodes, (n) => { live.add(n.id); });
		this.engine.pruneLastShapes(live);
	}

	autosave() {
		clearTimeout(this.autosaveTimer);
		this.autosaveTimer = setTimeout(() => this.autosaveNow(), 600);
	}

	commit() {
		this.applyExpressions();
		this.tidyValues();
		this.syncOff();
		const slow = this.engine.pool && this.model.settings.backgroundBuild !== false && this.engine.pendingCost(this.model.nodes) > 150;
		this.tidyScales(0.001, this.model.nodes, slow); // when building in the background, only parts already built
		this.model.snapshot();
		if (slow) this.backgroundBuild();
		else this.afterChange();
		this.autosave();
	}

	/**
	 * Rebuild in the background workers and draw when done; the page stays usable meanwhile. Changes made during a
	 * build are picked up by another round before drawing. Resolves when the scene is up to date.
	 */
	async backgroundBuild() {
		if (this.bgBuild) { this.bgAgain = true; return this.bgBuild; }
		let bar = null;
		const timer = setTimeout(() => { bar = this.progressBar('Updating'); }, 250);
		this.bgBuild = (async () => {
			try {
				do {
					this.bgAgain = false;
					this.syncOff();
					await this.engine.buildAsync(this.model.nodes, (done, total, n) => { if (bar) bar.set(done / total, `Building "${n.name}" (${done} / ${total})`); });
				} while (this.bgAgain);
			} finally {
				clearTimeout(timer);
				if (bar) bar.done();
			}
			this.bgBuild = null;
			// sizes made by scaling can be tidied now that everything is built
			const before = JSON.stringify(this.model.nodes.map((n) => n.scale));
			this.tidyScales();
			if (JSON.stringify(this.model.nodes.map((n) => n.scale)) !== before) this.autosave();
			this.afterChange();
		})();
		return this.bgBuild;
	}

	afterChange() {
		this.syncOff();
		this.vp.rebuild(this.model, this.engine, this.model.settings);
		if (this.lattice) this.latticeSync();
		if (this.sculpt) {
			// the part being sculpted: gone → leave sculpt mode; otherwise keep its normal display hidden
			if (!this.model.get(this.sculpt.node.id)) { this.sculpt.modified = false; this.exitSculpt(false); } else { const d = this.vp.displays.get(this.sculpt.node.id); if (d) { d.visible = false; this.sculpt.hidden = d; } }
		}
		this.sel = this.sel.filter((id) => this.model.get(id));
		this.vp.setSelection(this.sel);
		this.refreshUI();
		for (const id of this.engine.errors) {
			if (this.model.get(id)) { toast('A boolean operation failed for "' + this.model.get(id).name + '"', 'error'); break; }
		}
	}

	refreshUI() {
		this.renderTree();
		this.renderTimeline();
		this.renderProps();
		this.updateToolbarState();
		this.scheduleStats();
		$('#project-name').value = this.model.doc.name;
		$('#empty-hint').style.display = this.model.nodes.length ? 'none' : '';
		this.updateSaveState();
		this.renderBranchChip();
		this.renderTabs();
	}

	// ---- variables & expressions
	// Fields can hold expressions (e.g. "wall*2") stored in node.exprs[path]; sketch dimensions hold c.expr.
	// Every commit re-evaluates them against the design variables so changing a variable updates the model.
	applyExpressions() {
		const { values, errors } = resolveVars(this.model.doc.vars || []);
		this.varValues = values;
		this.varErrors = errors;
		const problems = [];
		this.scopeById = new Map();
		const visit = (list, values) => { for (const n of list) {
			this.scopeById.set(n.id, values);
			if (n.type === 'faceoff') { n.hole = n.params.depth < 0; n.name = n.name.replace(/^(Thicken|Thin) surface$/, n.hole ? 'Thin surface' : 'Thicken surface'); }
			if ((n.type === 'facex' || n.type === 'faceoff' || n.type === 'facemove') && n.exprs && n.exprs['params.depth']) { const dv = evalExpr(n.exprs['params.depth'], values); if (isFinite(dv)) n.params.depth = dv; }
			if (n.type === 'facex') { n.hole = n.params.depth < 0; n.name = n.name.replace(/^Push\/pull( \(cut\))?$/, n.hole ? 'Push/pull (cut)' : 'Push/pull'); }
			for (const [path, expr] of Object.entries(n.exprs || {})) {
				const v = evalExpr(expr, values);
				if (isFinite(v)) setPath(n, path, v);
				else problems.push(`${n.name}: ${expr}`);
			}
			const cons = n.type === 'sketch' && n.params.cons;
			if (cons && cons.some((c) => c.expr)) {
				let changed = false;
				const m = toModel(n.params);
				for (const c of m.cons) {
					if (!c.expr) continue;
					const v = evalExpr(c.expr, values);
					if (!isFinite(v)) { problems.push(`${n.name}: ${c.expr}`); continue; }
					if (Math.abs(v - c.value) > 1e-12) { c.value = v; changed = true; }
				}
				if (changed) { solveModel(m); Object.assign(n.params, modelToParams(m)); delete n.params.pts; }
			}
			if (n.children) {
				// a group's own parameters are visible to everything inside it (not to the group's own fields)
				let inner = values;
				if (n.localVars && n.localVars.length) {
					const r = resolveVars(n.localVars, values);
					inner = r.values;
					for (const k in r.errors) problems.push(`${n.name}: ${k}`);
				}
				visit(n.children, inner);
			}
		} };
		visit(this.model.nodes, values);
		this.solveMates();
		this.syncOff();
		const sig = problems.join('|');
		if (problems.length && sig !== this.lastExprProblems) toast('Some expressions could not be evaluated: ' + problems.slice(0, 3).join(', '), 'error', 5000);
		this.lastExprProblems = sig;
	}

	setExpr(n, path, expr) {
		if (expr) { n.exprs = n.exprs || {}; n.exprs[path] = expr; }
		else if (n.exprs) { delete n.exprs[path]; if (!Object.keys(n.exprs).length) delete n.exprs; }
	}

	variablesDialog() {
		const rows = (this.model.doc.vars || []).map((v) => ({ ...v, orig: v.name }));
		const body = el('div', { class: 'vars' });
		// configurations: named sets of values, edited on a working copy until Save
		const cfgs = JSON.parse(JSON.stringify(this.model.doc.configs || []));
		let active = this.model.doc.activeConfig || null;
		const cfgBar = el('div', { class: 'cfg-bar' });
		const snapshotValues = () => Object.fromEntries(rows.filter((r) => r.name).map((r) => [r.name, String(r.expr)]));
		const renderCfg = () => {
			cfgBar.innerHTML = '';
			const sel = el('select', { title: 'Load a configuration’s values' }, el('option', { value: '' }, cfgs.length ? '— custom values —' : 'No configurations yet'), ...cfgs.map((c) => el('option', { value: c.name }, c.name)));
			sel.value = active || '';
			sel.addEventListener('change', () => {
				active = sel.value || null;
				const c = cfgs.find((x) => x.name === active);
				if (c) for (const r of rows) if (r.name in c.values) r.expr = c.values[r.name];
				render(); renderCfg();
			});
			const nameIn = el('input', { type: 'text', placeholder: 'name, e.g. Large', style: 'width:120px', spellcheck: 'false' });
			const saveNew = el('button', { class: 'btn sm', onclick: () => {
				const nm = nameIn.value.trim();
				if (!nm) { nameIn.focus(); toast('Type a name for the configuration', 'warn'); return; }
				const ex = cfgs.find((c) => c.name === nm);
				if (ex) ex.values = snapshotValues(); else cfgs.push({ name: nm, values: snapshotValues() });
				active = nm; renderCfg();
			} }, 'Save values as');
			const upd = el('button', { class: 'btn sm', disabled: !active, onclick: () => { const c = cfgs.find((x) => x.name === active); if (c) { c.values = snapshotValues(); toast(`Updated “${active}”`, 'ok'); } } }, 'Update');
			const del = el('button', { class: 'btn sm', disabled: !active, onclick: () => { const i = cfgs.findIndex((x) => x.name === active); if (i >= 0) cfgs.splice(i, 1); active = null; renderCfg(); } }, 'Delete');
			cfgBar.append(el('b', {}, 'Configuration'), sel, upd, del, el('span', { class: 'sep' }), nameIn, saveNew);
		};
		renderCfg();
		const table = el('div', { class: 'vars-table' });
		const render = () => {
			table.innerHTML = '';
			const { values, errors } = resolveVars(rows.filter((r) => r.name));
			table.appendChild(el('div', { class: 'vars-row head' }, el('span', {}, 'Name'), el('span', {}, 'Value / expression'), el('span', {}, '= mm'), el('span', {})));
			rows.forEach((r, i) => {
				const nm = el('input', { type: 'text', value: r.name, placeholder: 'name', spellcheck: 'false' });
				const ex = el('input', { type: 'text', value: r.expr, placeholder: 'e.g. 2 or wall*2', spellcheck: 'false' });
				const nameErr = !r.name ? '' : !/^[A-Za-z_][A-Za-z0-9_]*$/.test(r.name) ? 'Use letters, digits and _' : EXPR_FUNCS[r.name.toLowerCase()] || /^pi$/i.test(r.name) ? 'Reserved name' : rows.filter((q) => q.name === r.name).length > 1 ? 'Duplicate name' : '';
				const err = nameErr || (r.name && errors[r.name]) || '';
				const val = el('span', { class: 'vars-val' + (err ? ' bad' : '') }, err || (r.name in values ? fmt(values[r.name], 4) : ''));
				nm.addEventListener('input', () => { r.name = nm.value.trim(); refresh(); });
				ex.addEventListener('input', () => { r.expr = ex.value; refresh(); });
				const del = el('button', { class: 'icon-btn sm', title: 'Delete variable', html: icon('x') });
				del.addEventListener('click', () => { rows.splice(i, 1); render(); });
				table.appendChild(el('div', { class: 'vars-row' }, nm, ex, val, del));
			});
		};
		// Re-evaluate values without rebuilding the inputs (keeps focus while typing).
		const refresh = () => {
			const { values, errors } = resolveVars(rows.filter((r) => r.name));
			table.querySelectorAll('.vars-row:not(.head)').forEach((rowEl, i) => {
				const r = rows[i];
				const nameErr = !r.name ? '' : !/^[A-Za-z_][A-Za-z0-9_]*$/.test(r.name) ? 'Use letters, digits and _' : EXPR_FUNCS[r.name.toLowerCase()] || /^pi$/i.test(r.name) ? 'Reserved name' : rows.filter((q) => q.name === r.name).length > 1 ? 'Duplicate name' : '';
				const err = nameErr || (r.name && errors[r.name]) || '';
				const v = rowEl.querySelector('.vars-val');
				v.textContent = err || (r.name in values ? fmt(values[r.name], 4) : '');
				v.classList.toggle('bad', !!err);
			});
		};
		const add = el('button', { class: 'btn sm', onclick: () => { let k = rows.length + 1, name = 'v' + k; while (rows.some((r) => r.name === name)) name = 'v' + ++k; rows.push({ name, expr: '10', orig: null }); render(); table.querySelector('.vars-row:last-child input').select(); } }, '+ Add variable');
		body.append(
			el('p', { class: 'muted small' }, 'Name a value once and use it in any number field or sketch dimension, e.g. ', el('code', {}, 'wall'), ', ', el('code', {}, 'bolt + 0.2'), ', ', el('code', {}, 'max(wall*2, 3)'), '. Changing a variable updates every part that uses it. Variables can use each other and functions such as sin, cos, sqrt, min, max and round.'),
			cfgBar, table, el('div', { class: 'btn-row' }, add),
			el('p', { class: 'muted small' }, 'Configurations store a set of values (e.g. Small / Large, M3 / M4) to switch between, and Export can write every configuration in one go.'));
		render();
		this.modal('Variables', body, [{ label: 'Cancel' }, {
			label: 'Save', primary: true, action: () => {
				const named = rows.filter((r) => r.name);
				const { errors } = resolveVars(named);
				const bad = named.find((r) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(r.name) || EXPR_FUNCS[r.name.toLowerCase()] || /^pi$/i.test(r.name) || named.filter((q) => q.name === r.name).length > 1 || errors[r.name]);
				if (bad) { toast(`Fix variable “${bad.name}” first`, 'error'); return false; }
				// Renamed variables: update every expression that used the old name.
				for (const r of named) {
					if (!r.orig || r.orig === r.name) continue;
					walk(this.model.nodes, (n) => {
						for (const k in n.exprs || {}) n.exprs[k] = renameInExpr(n.exprs[k], r.orig, r.name);
						for (const c of (n.type === 'sketch' && n.params.cons) || []) if (c.expr) c.expr = renameInExpr(c.expr, r.orig, r.name);
					});
					for (const q of named) q.expr = renameInExpr(q.expr, r.orig, r.name);
				}
				this.model.doc.vars = named.map(({ name, expr }) => ({ name, expr: String(expr).trim() }));
				this.model.doc.configs = cfgs;
				this.model.doc.activeConfig = active && cfgs.some((c) => c.name === active) ? active : null;
				this.propSig = null;
				this.commit();
				toast('Variables updated', 'ok');
			},
		}], 'wide');
	}

	// ---- saved / unsaved indicator
	designSig() {
		return JSON.stringify({ name: this.model.doc.name, nodes: this.model.doc.nodes });
	}

	isDirty() {
		if (!this.savedSig) return this.model.nodes.length > 0;
		return this.designSig() !== this.savedSig;
	}

	markSaved(fileName) {
		this.savedSig = this.designSig();
		if (fileName) this.fileName = fileName;
		this.updateSaveState();
		this.autosave();
	}

	updateSaveState() {
		const st = $('#save-state');
		if (!st) return;
		const dirty = this.isDirty();
		st.className = 'save-state ' + (dirty ? 'dirty' : 'clean');
		st.textContent = !this.savedSig && !this.model.nodes.length ? '' : dirty ? (this.savedSig ? 'Unsaved changes' : 'Not saved yet') : 'Saved';
		st.title = this.fileName ? 'File: ' + this.fileName + (this.fileHandle ? ' (Ctrl+S saves to this file)' : '') : 'Use Save or Save as to keep a copy of this design';
		document.title = (dirty && this.model.nodes.length ? '• ' : '') + (this.model.doc.name || 'Untitled') + (installedApp() ? '' : ' — DraftOtter');
		const saveBtn = document.querySelector('#toolbar .tb[data-save]');
		if (saveBtn) { saveBtn.classList.toggle('unsaved', dirty && this.model.nodes.length > 0); saveBtn.title = dirty && this.model.nodes.length ? 'Save design (Ctrl+S) — unsaved changes' : 'Save design (Ctrl+S)'; }
	}

	setFileHandle(h) {
		this.fileHandle = h || null;
		idbSet(this.tabKey('fileHandle'), h || undefined);
	}

	selectedNodes() {
		return this.sel.map((id) => this.model.get(id)).filter(Boolean);
	}

	setSelection(ids) {
		this.sel = [...new Set(ids)].filter((id) => this.model.get(id));
		if (this.lattice && !this.sel.includes(this.lattice.node.id)) this.stopLattice();
		this.vp.setSelection(this.sel);
		this.renderTree();
		this.renderProps();
		this.updateToolbarState();
		this.scheduleStats();
	}

	// ============================================================ viewport callbacks

	onPick(id, additive, nested) {
		if (!id) { if (!additive) this.setSelection([]); return; }
		if (additive) {
			this.setSelection(this.sel.includes(id) ? this.sel.filter((s) => s !== id) : [...this.sel, id]);
		} else {
			this.setSelection([id]);
			if (nested) toast('Editing part inside group — changes rebuild the group', 'info', 1800);
		}
	}

	onBoxSelect(ids, additive) {
		this.setSelection(additive ? [...this.sel, ...ids] : ids);
	}

	onDragging(d, guides = []) {
		const snapped = guides.length ? '  · lined up with ' + [...new Set(guides.map((g) => (this.model.get(g.id) || {}).name))].join(', ') : '';
		$('#st-hint').textContent = `Move ΔX ${fmt(d.x, 2)}  ΔY ${fmt(d.y, 2)}${snapped}   (hold Alt to disable snapping)`;
	}

	onHint(text) {
		$('#st-hint').textContent = text;
	}

	onCursor(p) {
		$('#st-cursor').textContent = `X ${fmt(p.x, 1)}  Y ${fmt(p.y, 1)}`;
	}

	onMeasure(d, final, r) {
		if (r && r.angleKind) {
			const what = r.angleKind === 'points' ? 'at the middle point' : 'between the faces';
			$('#st-hint').textContent = `Angle ${fmt(r.angle, 2)}° ${what}` + (final ? '   — click to start a new measurement' : r.angleKind === 'points' ? '   (Shift-click to place the third point)' : '');
			return;
		}
		const head = r && r.perp != null ? `Gap ⊥ ${fmt(r.perp, 3)} mm   offset ${fmt(r.offset, 3)} mm   direct ${fmt(d.length(), 3)} mm` : `Distance ${fmt(d.length(), 3)} mm`;
		$('#st-hint').textContent = `${head}   ΔX ${fmt(d.x, 3)}  ΔY ${fmt(d.y, 3)}  ΔZ ${fmt(d.z, 3)}` + (final ? '   — click to start a new measurement, or Shift-click a third point for the angle at the second' : '');
	}

	onObjectsTransformed(updates, wasScale) {
		for (const u of updates) {
			const n = this.model.get(u.id);
			if (!n) continue;
			this.clearTransformExprs(n, u);
			n.pos = u.pos;
			n.rot = u.rot;
			n.scale = u.scale;
			if (wasScale) bakeScale(n);
		}
		$('#st-hint').textContent = '';
		this.commit();
	}

	onPlaceOnSurface(point, normal) {
		const nodes = this.selectedNodes().filter((n) => !n.locked);
		if (!nodes.length) { toast('Select an object first, then click a face', 'warn'); return; }
		const box = this.vp.selectionBox();
		const bottom = new THREE.Vector3((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, box.min.z);
		const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal.clone().normalize());
		const M = new THREE.Matrix4().makeTranslation(point.x, point.y, point.z)
			.multiply(new THREE.Matrix4().makeRotationFromQuaternion(q))
			.multiply(new THREE.Matrix4().makeTranslation(-bottom.x, -bottom.y, -bottom.z));
		for (const n of nodes) this.setWorldMatrix(n, M.clone().multiply(this.worldMatrix(n)));
		this.setTool(null);
		this.commit();
	}

	frame() {
		this.vp.frameBox(this.sel.length ? this.vp.selectionBox() : this.sceneBox());
	}

	sceneBox() {
		return this.vp.selectionBox(this.model.nodes.filter((n) => n.visible).map((n) => n.id));
	}

	// ============================================================ matrices

	worldMatrix(node) {
		const obj = this.vp.objs.get(node.id);
		if (obj) { obj.updateWorldMatrix(true, false); return obj.matrixWorld.clone(); }
		return nodeMatrix(node);
	}

	// Drop the expression for any transform value that is being changed directly.
	/**
	 * Scales are stored rounded (1.03333 for 31/30), which leaves sizes a fraction of a micron off (61.9998 instead of
	 * 62). Snap every scaled object's size to the micron and keep the exact scale for it.
	 */
	/**
	 * Values copied from 32-bit geometry carry float noise (46.9999 for 47, 30.5001 for 30.5). Parts placed with them
	 * end up a fraction of a micron off their neighbors, and the joins leave hair-thin steps that show as lines on
	 * flat faces. Snap every stored position, size or outline number that is within 0.15 µm of a whole micron (exact
	 * values like 15.6667 for even spacing are kept).
	 */
	tidyValues(roots = this.model.nodes) {
		let changed = 0;
		const walk = (n) => {
			const ex = n.exprs || {};
			for (let i = 0; i < 3; i++) if (!ex['pos.' + i]) { const v = snapNoise(n.pos[i]) || 0; if (v !== n.pos[i]) { n.pos[i] = v; changed++; } }
			// push/pull features are measured off the mesh, so they are kept on whole microns (outline, depth, placement)
			const pp = n.type === 'facex' || n.type === 'faceoff' || n.type === 'facemove';
			if (pp) {
				for (let i = 0; i < 3; i++) if (!ex['rot.' + i]) { const v = snapAngle(n.rot[i]); if (v !== n.rot[i]) { n.rot[i] = v; changed++; } }
				changed += snapPushPull(n, ex);
				if (!ex['params.depth'] && typeof n.params.depth === 'number') { const v = snapTo(n.params.depth, 0.001); if (v !== n.params.depth) { n.params.depth = v; changed++; } }
			}
			if (n.params && n.type !== 'mesh') {
				for (const k of Object.keys(n.params)) {
					if (ex['params.' + k] || k === 'N') continue; // N: surface normals, not sizes
					const v = n.params[k];
					if (typeof v === 'number') { const r = snapNoise(v); if (r !== v) { n.params[k] = r; changed++; } }
					else if (Array.isArray(v)) changed += mapNumbers(v, snapNoise);
				}
			}
			if (n.children) n.children.forEach(walk);
		};
		roots.forEach(walk);
		return changed;
	}

	tidyScales(step = 0.001, roots = this.model.nodes, onlyBuilt = false) {
		const walk = (n) => {
			if (n.scale && n.scale.some((v) => v !== 1)) {
				const g = onlyBuilt ? this.engine.cache.get(this.engine.key(n)) : this.engine.geometry(n);
				if (g) {
					if (!g.boundingBox) g.computeBoundingBox();
					const b = g.boundingBox.getSize(new THREE.Vector3()).toArray().map((x) => round(x, 6)); // vertex data is 32-bit
					n.scale = n.scale.map((v, i) => {
						if (v === 1 || !(b[i] > 1e-6) || (n.exprs && n.exprs['scale.' + i])) return v;
						const t = (Math.sign(v) * snapTo(Math.abs(v) * b[i], step)) / b[i];
						return t && Math.abs(t * b[i] - v * b[i]) <= step / 2 + 1e-9 ? t : v;
					});
				}
			}
			if (n.children) n.children.forEach(walk);
		};
		roots.forEach(walk);
	}

	clearTransformExprs(n, next) {
		if (!n.exprs) return;
		for (const key of ['pos', 'rot', 'scale']) {
			for (let i = 0; i < 3; i++) if (n.exprs[key + '.' + i] && Math.abs(n[key][i] - next[key][i]) > 1e-9) this.setExpr(n, key + '.' + i, null);
		}
	}

	setWorldMatrix(node, M) {
		const obj = this.vp.objs.get(node.id);
		const parentInv = obj && obj.parent ? obj.parent.matrixWorld.clone().invert() : new THREE.Matrix4();
		const local = parentInv.multiply(M);
		const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
		local.decompose(p, q, s);
		const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
		const next = { pos: [round(p.x), round(p.y), round(p.z)], rot: [round(e.x / DEG, 3), round(e.y / DEG, 3), round(e.z / DEG, 3)], scale: [round(s.x, 5), round(s.y, 5), round(s.z, 5)] };
		this.clearTransformExprs(node, next);
		Object.assign(node, next);
	}

	worldBox(node) {
		return this.vp.selectionBox([node.id]);
	}

	moveWorld(node, d) {
		const M = new THREE.Matrix4().makeTranslation(d.x, d.y, d.z).multiply(this.worldMatrix(node));
		this.setWorldMatrix(node, M);
	}

	// ============================================================ commands

	// Place a new node so its bottom sits on: the drop point (oriented to that face), the workplane, or a free spot on the bed.
	addNode(node, at, normal) {
		const g = this.engine.geometry(node);
		const R = nodeMatrix({ pos: [0, 0, 0], rot: node.rot, scale: node.scale });
		const box = g ? g.boundingBox.clone().applyMatrix4(R) : new THREE.Box3(new THREE.Vector3(-5, -5, -5), new THREE.Vector3(5, 5, 5));
		const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
		const wp = this.vp.workplane;
		let origin, quat = new THREE.Quaternion();
		if (at) {
			origin = at.clone();
			if (normal && normal.z < 0.999) quat = planeBasis(normal).quat;
		} else if (wp) {
			origin = wp.origin.clone();
			quat = wp.quat.clone();
		} else {
			const s = this.freeSpot(size);
			origin = new THREE.Vector3(s.x, s.y, 0);
		}
		const M = new THREE.Matrix4().compose(origin, quat, new THREE.Vector3(1, 1, 1))
			.multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -box.min.z))
			.multiply(R);
		this.setWorldMatrix(node, M);
		this.model.nodes.push(node);
		this.sel = [node.id];
		this.commit();
		return node;
	}

	// Nearest free spot to the bed center (fine grid search, 3 mm gap), preferring spots fully on the bed.
	freeSpot(size) {
		const boxes = this.model.nodes.filter((n) => n.visible).map((n) => this.worldBox(n)).filter((b) => !b.isEmpty());
		const snap = this.model.settings.snap || 1;
		const step = snap * Math.max(1, Math.ceil(5 / snap)), gap = 3; // grid multiples, so new parts land on the snap grid
		const bed = this.model.settings.bed;
		const N = Math.ceil(Math.max(bed.w, bed.d) / step);
		const cand = [];
		for (let i = -N; i <= N; i++) for (let j = -N; j <= N; j++) cand.push([i * step, j * step]);
		cand.sort((p, q) => p[0] * p[0] + p[1] * p[1] - (q[0] * q[0] + q[1] * q[1]));
		const free = (x, y) => {
			const b = new THREE.Box3(new THREE.Vector3(x - size.x / 2 - gap, y - size.y / 2 - gap, 0), new THREE.Vector3(x + size.x / 2 + gap, y + size.y / 2 + gap, Math.max(size.z, 0.1)));
			return !boxes.some((o) => o.intersectsBox(b));
		};
		const onBed = (x, y) => Math.abs(x) + size.x / 2 <= bed.w / 2 && Math.abs(y) + size.y / 2 <= bed.d / 2;
		for (const [x, y] of cand) if (onBed(x, y) && free(x, y)) return { x, y };
		for (const [x, y] of cand) if (free(x, y)) return { x, y };
		return { x: 0, y: 0 };
	}

	addShape(type, at, normal) {
		if (type === 'sketch') return this.newSketch(at);
		if (type.startsWith('part:')) {
			const part = this.library().find((p) => p.id === type.slice(5));
			if (!part) return;
			Object.assign(this.model.blobs, part.blobs || {});
			return this.addNode(cloneWithNewIds(part.node), at, normal);
		}
		if (PRESETS[type]) return this.addNode(PRESETS[type].make(), at, normal);
		return this.addNode(makeNode(type), at, normal);
	}

	// ============================================================ shell / hollow

	shellDialog() {
		const nodes = this.selectedNodes();
		if (nodes.length !== 1) { toast('Select one object to hollow out', 'warn'); return; }
		const n = nodes[0];
		if (n.hole) { toast('Holes cannot be shelled — select a solid', 'warn'); return; }
		const faces = [['top', '+z', 'Top'], ['bottom', '-z', 'Bottom'], ['front', '-y', 'Front'], ['back', '+y', 'Back'], ['left', '-x', 'Left'], ['right', '+x', 'Right']];
		const geom = this.engine.geometry(n);
		const status = el('div', { class: 'muted small shell-pick-status' });
		const picker = geom ? createShellPicker(geom, n, { onChange: (s) => sync(s) }) : null;
		const chipInputs = {};
		const form = el('div', { class: 'form' },
			el('label', { class: 'row' }, el('span', {}, 'Wall thickness (mm)'), el('input', { id: 'sh-t', type: 'text', value: this.lastShell || 2 })),
			el('label', { class: 'row' }, el('span', {}, 'Inside corner radius (mm)'), el('input', { id: 'sh-r', type: 'text', value: this.lastShellR || 0, title: 'Rounds every inside corner and edge of the hollow (0 = sharp)' })),
			picker ? el('div', { class: 'shell-pick' }, picker.canvas, status) : null,
			el('div', { class: 'row' }, el('span', {}, 'Quick open faces'), el('div', { class: 'chips' }, ...faces.map(([id, , label]) => {
				const cb = el('input', { id: 'sh-o-' + id, type: 'checkbox' });
				chipInputs[id] = cb;
				cb.addEventListener('change', () => { if (picker) picker.setQuick(id, cb.checked); sync(); });
				return el('label', { class: 'chip-check' }, cb, el('span', {}, label));
			}))),
			el('p', { class: 'muted small' }, 'Click the flat faces to leave open in the preview (drag to turn it, wheel to zoom) — the part becomes a cup, tray, sleeve or channel. The outermost faces match the quick choices; any other flat face gets an opening inset by the wall thickness. The result is an editable group.'));
		const sync = (s) => {
			if (s) for (const [id] of faces) chipInputs[id].checked = s.quick.includes(id);
			const q = faces.filter(([id]) => chipInputs[id].checked).length, c = picker ? picker.custom().length : 0;
			status.textContent = q + c ? `${q + c} open face${q + c > 1 ? 's' : ''}` : 'Closed all round — click faces to leave them open';
		};
		sync();
		this.modal('Shell / hollow out', form, [{ label: 'Cancel' }, {
			label: 'Shell', primary: true, action: () => {
				const t = evalExpr($('#sh-t').value, this.varValues || {});
				if (!(t > 0)) { toast('Enter a wall thickness greater than 0', 'error'); return false; }
				const r = evalExpr($('#sh-r').value || '0', this.varValues || {});
				if (!(r >= 0)) { toast('Enter an inside corner radius of 0 or more', 'error'); return false; }
				this.lastShell = t;
				this.lastShellR = r;
				this.shell(n, t, faces.filter(([id]) => $('#sh-o-' + id).checked).map(([, dir]) => dir), picker ? picker.custom() : [], r);
			},
		}], 'wide', { onClose: () => { if (picker) picker.dispose(); } });
	}

	/** Cavity for a shell, with its inside corners rounded by r (shrink by r, then grow back by r). */
	roundedCavity(n, t, open, r = 0) {
		this.cavityRound = r > 0 ? r : 0;
		const res = this.cavityFor(n, t, open);
		this.cavityRound = 0;
		if (!res || !(r > 0)) return res;
		if (!hasManifold()) { toast('Rounded inside corners need the Manifold engine', 'warn'); return res; }
		const inner = { ...res.inner, hole: false };
		const shrink = makeGroup([inner], { mode: 'offset', offset: -r, name: 'Cavity (shrunk)' });
		const test = this.engine.geometry(shrink);
		if (!test || !test.attributes.position.count) { toast('That corner radius is too large for the space inside', 'error'); return null; }
		return { inner: makeGroup([shrink], { mode: 'offset', offset: r, name: `Cavity (R${fmt(r, 2)} corners)`, hole: true }), exact: res.exact };
	}

	/** Change a shell's wall thickness / inside corner radius afterwards: rebuild its cavity and openings. */
	reshell(g, { t = g.shell.t, r = g.shell.r } = {}) {
		const core = g.children[0];
		const res = this.roundedCavity(core, t, g.shell.open || [], r);
		if (!res) return false;
		const faces = (g.shell.faces || []).map((f) => ({ origin: new THREE.Vector3(...f.origin), quat: new THREE.Quaternion(...f.quat), loops: f.loops }));
		g.children = [core, res.inner, ...g.children.slice(1).filter((c) => !(c.type === 'facex' && c.name === 'Opening') && !/^Cavity/.test(c.name)), ...this.openingsFor(faces, t, core.color)];
		g.shell = { ...g.shell, t, r };
		this.commit();
		return true;
	}

	/** Holes that open a flat face of a shelled part: the face outline inset by t, cut through the wall. */
	openingsFor(faces, t, color) {
		const out = [];
		for (const f of faces) {
			const regions = this.engine.ctx.offset2d(f.loops, -t);
			if (!regions) continue;
			for (const r of regions) {
				const h = makeNode('facex', { loops: [r.outer, ...r.holes].map((lp) => lp.map(([x, y]) => [snapTo(x, 0.001), snapTo(y, 0.001)])), depth: -snapTo(t + Math.max(0.3, t * 0.5), 0.001), draft: 0 }, { name: 'Opening', hole: true, color });
				const e = new THREE.Euler().setFromQuaternion(f.quat, 'XYZ');
				h.pos = f.origin.toArray().map((v) => round(v, 5));
				h.rot = [round(e.x / DEG, 4), round(e.y / DEG, 4), round(e.z / DEG, 4)];
				out.push(h);
			}
		}
		return out;
	}

	shell(n, t, open = [], customFaces = [], r = 0) {
		if (open === true) open = ['+z'];
		const res = this.roundedCavity(n, t, open || [], r);
		if (!res) return;
		const f = this.model.find(n.id);
		const idx = f.list.indexOf(n);
		const g = makeGroup([], { name: n.name + ' (shell)', color: n.color });
		g.pos = n.pos.slice();
		g.rot = n.rot.slice();
		if (n.exprs) for (const k of Object.keys(n.exprs)) if (/^(pos|rot)\./.test(k)) { g.exprs = g.exprs || {}; g.exprs[k] = n.exprs[k]; delete n.exprs[k]; }
		n.pos = [0, 0, 0];
		n.rot = [0, 0, 0];
		n.locked = false;
		g.children = [n, res.inner, ...this.openingsFor(customFaces, t, n.color)];
		g.shell = { t, r, open: open || [], faces: customFaces.map((c) => ({ origin: c.origin.toArray(), quat: c.quat.toArray(), loops: c.loops })) };
		f.list.splice(idx, 1, g);
		this.sel = [g.id];
		this.commit();
		toast(res.exact ? 'Shelled with ' + fmt(t, 2) + ' mm walls' : 'Shelled (walls are approximate for this shape — adjust the cavity if needed)', res.exact ? 'ok' : 'info', 3500);
	}

	// Inner cavity (a hole) in the node's own frame: `t` thinner on every side, extended through any open faces.
	cavityFor(n, t, open = []) {
		const c = cloneWithNewIds(n);
		Object.assign(c, { hole: true, name: 'Cavity', pos: [0, 0, 0], rot: [0, 0, 0], locked: false, visible: true });
		delete c.exprs;
		const p = c.params || {};
		let exact = true, approx = false, lift = 0, dx = 0, dy = 0;
		switch (n.type) {
			case 'box': p.w -= 2 * t; p.d -= 2 * t; p.h -= 2 * t; p.radius = Math.max(0, (p.radius || 0) - t); break;
			case 'cylinder': p.r -= t; p.h -= 2 * t; p.topEdge = Math.max(0, p.topEdge - t); p.bottomEdge = Math.max(0, p.bottomEdge - t); break;
			case 'cone': p.r1 = Math.max(0.01, p.r1 - t); p.r2 = Math.max(0, p.r2 - t); p.h -= 2 * t; exact = false; break;
			case 'sphere': p.r -= t; break;
			case 'hemisphere': p.r -= t; lift = t / 2; break;
			case 'torus': p.r -= t; break;
			case 'prism': {
				const k = p.sizeBy === 'flats' ? 1 : 1 / Math.cos(Math.PI / Math.max(3, p.sides));
				p.r -= t * k; p.h -= 2 * t; p.fillet = Math.max(0, (p.fillet || 0) - t); p.edge = Math.max(0, (p.edge || 0) - t); break;
			}
			case 'sketch':
				if (p.mode !== 'revolve') {
					const regions = profileRegions(p);
					const innerRegions = regions.map((rg) => ({ outer: offsetPolygon(rg.outer, -t), holes: rg.holes.map((h) => offsetPolygon(h, t)) }))
						.filter((rg) => rg.outer.length >= 3)
						.map((rg) => ({ ...rg, holes: rg.holes.filter((h) => h.length >= 3) }));
					if (!innerRegions.length) { toast('Wall thickness is too large for this sketch', 'error'); return null; }
					const all = (rs) => rs.flatMap((rg) => rg.outer);
					if (p.anchored) { lift = t; } // anchored sketches keep absolute coordinates
					else {
						const bb = (pts) => { const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]); return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2]; };
						const [ox, oy] = bb(all(regions)), [ix, iy] = bb(all(innerRegions));
						dx = ix - ox; dy = iy - oy;
					}
					const extra = { height: p.height - 2 * t, fillet: 0, edge: Math.max(0, (p.edge || 0) - t) };
					delete p.pts;
					Object.assign(p, modelToParams(modelFromRegions(innerRegions), extra), { cons: [], radii: {} });
					break;
				}
			// fall through: revolved sketches use the scaled approximation
			default: {
				const g = this.engine.geometry(n);
				if (!g) return null;
				// any other shape (groups, imports, revolves…): a true inward offset of the part, so every wall is t
				if (hasManifold()) return this.offsetCavity(n, t, open, g);
				const s = g.boundingBox.getSize(new THREE.Vector3());
				const f = [s.x, s.y, s.z].map((v) => (v - 2 * t) / v);
				if (f.some((x) => !(x > 0.01))) { toast('Wall thickness is too large for this object', 'error'); return null; }
				c.scale = c.scale.map((v, i) => v * f[i]);
				const ctr = g.boundingBox.getCenter(new THREE.Vector3());
				dx = ctr.x * (1 - f[0]); dy = ctr.y * (1 - f[1]); lift = ctr.z * (1 - f[2]);
				exact = false; approx = true;
			}
		}
		const dims = ['w', 'd', 'h', 'r', 'r1', 'ro', 'height'].filter((k) => k in p && !approx);
		if (dims.some((k) => !(p[k] > 1e-3))) { toast('Wall thickness is too large for this object', 'error'); return null; }
		c.pos = [round(dx * n.scale[0]), round(dy * n.scale[1]), round(lift * n.scale[2])];
		// Open faces: stretch the cavity out through those sides (keeps the other walls at t).
		if (open.length) {
			const g = this.engine.geometry(c);
			if (!g) return null;
			const B = g.boundingBox, S = c.scale.slice(), P = c.pos.slice();
			for (const fdir of open) {
				const i = { x: 0, y: 1, z: 2 }[fdir[1]], sgn = fdir[0] === '+' ? 1 : -1, e = t + (this.cavityRound || 0) + 1;
				const size = B.max.getComponent(i) - B.min.getComponent(i);
				const a1 = P[i] + S[i] * B.min.getComponent(i), a2 = P[i] + S[i] * B.max.getComponent(i);
				let lo = Math.min(a1, a2), hi = Math.max(a1, a2);
				if (sgn > 0) hi += e; else lo -= e;
				if (S[i] >= 0) { S[i] = (hi - lo) / size; P[i] = lo - S[i] * B.min.getComponent(i); }
				else { S[i] = -(hi - lo) / size; P[i] = hi - S[i] * B.min.getComponent(i); }
			}
			c.scale = S.map((v) => round(v, 6));
			c.pos = P.map((v) => round(v, 5));
		}
		return { inner: c, exact };
	}

	/**
	 * Cavity as an "offset −t" group around a copy of the part (exact walls for any shape). Each quick open
	 * direction adds a copy of that cavity pushed out through the wall, kept to a slab at the outermost face.
	 */
	offsetCavity(n, t, open, g) {
		const core = cloneWithNewIds(n);
		Object.assign(core, { hole: false, pos: [0, 0, 0], rot: [0, 0, 0], locked: false, visible: true });
		delete core.exprs;
		const inner = makeGroup([core], { mode: 'offset', offset: -t, name: 'Cavity' });
		const test = this.engine.geometry(inner);
		if (!test || !test.attributes.position.count) { toast('Wall thickness is too large for this object', 'error'); return null; }
		if (!open.length) return { inner: { ...inner, hole: true }, exact: true };
		const B = g.boundingBox.clone(), sc = n.scale;
		B.min.multiply(new THREE.Vector3(...sc)); B.max.multiply(new THREE.Vector3(...sc));
		const big = B.getSize(new THREE.Vector3()).length() * 2 + 20, ctr = B.getCenter(new THREE.Vector3());
		const kids = [inner];
		for (const fdir of open) {
			const i = { x: 0, y: 1, z: 2 }[fdir[1]], sgn = fdir[0] === '+' ? 1 : -1, e = t + (this.cavityRound || 0) + 1;
			const shifted = cloneWithNewIds(inner);
			shifted.pos = [0, 0, 0]; shifted.pos[i] = sgn * e;
			// only the part near the opened face: a slab from just inside the wall to beyond the face
			const ext = sgn > 0 ? B.max.getComponent(i) : B.min.getComponent(i);
			const slab = makeNode('box', { w: big, d: big, h: big });
			slab.pos = ctr.toArray(); slab.pos[i] = ext - sgn * (t + 0.05) + sgn * big / 2;
			kids.push(makeGroup([shifted, slab], { mode: 'intersect', name: 'Opening ' + fdir }));
		}
		return { inner: makeGroup(kids, { name: 'Cavity', hole: true }), exact: true };
	}

	// ============================================================ parts library

	library() {
		try { return JSON.parse(localStorage.getItem(LIBRARY_KEY) || '[]'); } catch (e) { return []; }
	}

	saveLibrary(list) {
		try {
			localStorage.setItem(LIBRARY_KEY, JSON.stringify(list));
			return true;
		} catch (e) {
			toast('Could not save to My parts: browser storage is full (large imported meshes use a lot of space)', 'error', 5000);
			return false;
		}
	}

	saveToLibrary() {
		const nodes = this.selectedNodes();
		if (!nodes.length) { toast('Select something to save as a part', 'warn'); return; }
		const inp = el('input', { id: 'lib-name', type: 'text', value: nodes.length === 1 ? nodes[0].name : 'My part' });
		this.modal('Save to My parts', el('div', { class: 'form' },
			el('label', { class: 'row' }, el('span', {}, 'Part name'), inp),
			el('p', { class: 'muted small' }, 'Saved parts appear under “My parts” in the Shapes panel, in every design on this browser.')), [{ label: 'Cancel' }, {
			label: 'Save', primary: true, action: () => {
				const name = inp.value.trim() || 'My part';
				// Bake world transforms; several objects become one group.
				const box = this.vp.selectionBox(nodes.map((n) => n.id));
				const ctr = box.getCenter(new THREE.Vector3());
				const shift = new THREE.Matrix4().makeTranslation(-ctr.x, -ctr.y, -box.min.z);
				const clones = nodes.map((n) => {
					const c = cloneWithNewIds(n);
					this.vp.objs.set(c.id, null);
					this.setWorldMatrix(c, shift.clone().multiply(this.worldMatrix(n)));
					this.vp.objs.delete(c.id);
					c.locked = false;
					c.visible = true;
					return c;
				});
				const node = clones.length === 1 ? clones[0] : makeGroup(clones, { name });
				node.name = name;
				const blobs = {};
				walk([node], (m) => { if (m.type === 'mesh' && this.model.blobs[m.params.blob]) blobs[m.params.blob] = this.model.blobs[m.params.blob]; });
				const thumb = makeThumbnails(this.engine, { part: () => node }).part || '';
				const list = this.library();
				list.push({ id: Math.random().toString(36).slice(2, 10), name, node, blobs, thumb });
				if (this.saveLibrary(list)) { this.renderMyParts(); toast('Saved “' + name + '” to My parts', 'ok'); }
			},
		}]);
	}

	renderMyParts() {
		const host = $('#my-parts');
		if (!host) return;
		host.innerHTML = '';
		const list = this.library();
		for (const part of list) {
			const item = el('div', { class: 'lib-item', draggable: 'true', title: `Add “${part.name}” (click or drag). Right-click to rename or delete.` },
				el('img', { src: part.thumb, alt: '' }), el('span', {}, part.name));
			item.addEventListener('click', () => this.addShape('part:' + part.id));
			item.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/lcad-shape', 'part:' + part.id); e.dataTransfer.effectAllowed = 'copy'; });
			item.addEventListener('contextmenu', (e) => {
				e.preventDefault();
				this.menu({ x: e.clientX, y: e.clientY }, [
					['Add to design', () => this.addShape('part:' + part.id)],
					['Rename…', () => {
						const v = prompt('Part name', part.name);
						if (v && v.trim()) { const l = this.library(); const q = l.find((x) => x.id === part.id); if (q) { q.name = v.trim(); q.node.name = v.trim(); this.saveLibrary(l); this.renderMyParts(); } }
					}],
					['Delete', () => { if (confirm('Delete “' + part.name + '” from My parts?')) { this.saveLibrary(this.library().filter((x) => x.id !== part.id)); this.renderMyParts(); } }],
				]);
			});
			host.appendChild(item);
		}
		const add = el('div', { class: 'lib-item add-part', title: 'Save the selected objects as a reusable part', html: `<div class="lib-ic">${icon('part')}</div><span>Save selection</span>` });
		add.addEventListener('click', () => this.saveToLibrary());
		host.appendChild(add);
	}

	// ============================================================ sketch on a face

	async onSketchFace(sp) {
		this.setTool(null);
		if (!sp || !sp.object) { toast('Click a face of an object to sketch on it', 'warn'); return; }
		const target = this.model.get(sp.object.userData.nodeId);
		if (!target) return;
		const basis = planeBasis(sp.normal);
		const origin = sp.point.clone();
		const snap = this.model.settings.snap;
		if (snap > 0) for (const k of ['x', 'y', 'z']) if (Math.abs(basis.n[k]) < 1e-3) origin[k] = Math.round(origin[k] / snap) * snap;
		const reference = faceOutline(sp.object, origin, basis);
		const res = await openSketchEditor({ pts: [], cons: [], mode: 'extrude', height: 5 }, this.sketchOpts({ isNew: true, onFace: { target: target.name, reference } }));
		if (!res) return;
		const cut = res.op === 'cut';
		const { op, combine, ...params } = res;
		const depth = params.height;
		// an extrusion overlaps into the face a little (inside the part, harmless); a pocket starts exactly at the face,
		// since a margin outward would bite into anything next to it
		const ov = cut ? 0 : FACE_OVERLAP;
		params.height = depth + ov;
		params.face = { cut, overlap: ov }; // so editing the sketch keeps it on its face
		const feature = makeNode('sketch', params, { name: cut ? 'Pocket' : 'Extrusion', hole: cut, color: target.color });
		const M = new THREE.Matrix4().compose(origin, basis.quat, new THREE.Vector3(1, 1, 1))
			.multiply(new THREE.Matrix4().makeTranslation(0, 0, cut ? -depth : -ov));
		this.setWorldMatrix(feature, M);
		this.model.nodes.push(feature);
		this.sel = [feature.id];
		this.commit();
		const top = this.model.topLevelOf(target.id);
		if (combine && top) {
			this.sel = [top.id, feature.id];
			this.group('union', top.name);
			toast((cut ? `Cut into “${top.name}”` : `Extruded from “${top.name}”`) + ' — double-click it to edit the sketch', 'ok', 4000);
		} else if (cut) toast('Pocket added as a hole — group it with the part to cut', 'info', 3500);
	}

	// ============================================================ fillet / chamfer edges

	onFilletState(active, sel) {
		let bar = $('#fillet-bar');
		if (!active) { if (bar) bar.style.display = 'none'; return; }
		if (!bar) { bar = el('div', { id: 'fillet-bar', class: 'float-bar' }); $('#viewport').appendChild(bar); }
		bar.style.display = '';
		bar.innerHTML = '';
		const n = sel ? sel.chains.length : 0;
		const node = sel && this.model.get(sel.id);
		const kind = el('select', { style: 'flex:none' }, el('option', { value: 'fillet' }, 'Fillet (round)'), el('option', { value: 'chamfer' }, 'Chamfer (bevel)'));
		kind.value = this.filletKind || 'fillet';
		kind.addEventListener('change', () => { this.filletKind = kind.value; });
		const size = el('input', { type: 'text', class: 'num', value: this.filletSize || '1', style: 'width:64px', title: 'Radius (fillet) or distance (chamfer) in mm — math and variables allowed' });
		size.addEventListener('change', () => { this.filletSize = size.value; });
		size.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { this.filletSize = size.value; this.applyEdgeOp(); } });
		// variable size: start size → end size along each edge (green dots mark the start)
		const vary = el('input', { type: 'checkbox', ...(this.filletVariable ? { checked: true } : {}) });
		vary.addEventListener('change', () => { this.filletVariable = vary.checked; this.vp.filletTool.redraw(); this.onFilletState(true, this.vp.filletTool.selection()); });
		const size2 = el('input', { type: 'text', class: 'num', value: this.filletSize2 || '3', style: 'width:64px', title: 'Size at the end of each edge (the start is at the green dot)' });
		size2.addEventListener('change', () => { this.filletSize2 = size2.value; });
		size2.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { this.filletSize2 = size2.value; this.applyEdgeOp(); } });
		const varPart = this.filletVariable ? [el('span', { class: 'muted' }, '→'), size2, el('button', { class: 'btn sm', title: 'Swap which end of the selected edges gets the start size', disabled: !n, onclick: () => this.vp.filletTool.flipSelected() }, 'Flip ⇄')] : [];
		bar.append(el('b', {}, 'Edges'),
			el('span', { class: 'muted' }, n ? `${n} edge${n > 1 ? 's' : ''} on “${node ? node.name : ''}”` : 'Click an edge, or a face for all its edges (click again to deselect)'),
			kind, size, ...varPart, el('span', { class: 'muted' }, 'mm'),
			el('label', { class: 'check', title: 'Change the size along each edge, from the start (green dot) to the end' }, vary, el('span', {}, 'Variable')),
			el('button', { class: 'btn sm primary', disabled: !n, onclick: () => { this.filletKind = kind.value; this.filletSize = size.value; this.filletSize2 = size2.value; this.applyEdgeOp(); } }, 'Apply'),
			el('span', { class: 'sep' }),
			el('button', { class: 'btn sm', title: 'Select every edge of this part', onclick: () => this.vp.filletTool.selectAll() }, 'All edges'),
			el('button', { class: 'btn sm', title: 'Select all outside (convex) edges', onclick: () => this.vp.filletTool.selectAll((c) => c.convex) }, 'Outer'),
			n ? el('button', { class: 'btn sm', onclick: () => { this.vp.filletTool.selected.clear(); this.vp.filletTool.redraw(); this.onFilletState(true, this.vp.filletTool.selection()); } }, 'Clear') : '',
			el('button', { class: 'btn sm', title: 'Round every outside edge at once (offset in, then out)', onclick: () => this.roundAllDialog() }, 'Round whole part…'),
			el('button', { class: 'btn sm', onclick: () => this.setTool(null) }, 'Done'));
	}

	// The group that holds a part's features (fillets, push/pull…); created on first use. Returns { g, Mg }.
	featureGroupFor(node) {
		if (node.type === 'group' && (node.filletGroup || node.featureGroup)) return { g: node, Mg: this.worldMatrix(node) };
		const f = this.model.find(node.id);
		const idx = f.list.indexOf(node);
		const c = this.vp.selectionBox([node.id]).getCenter(new THREE.Vector3());
		const g = makeGroup([], { name: node.name, color: node.color });
		g.featureGroup = true;
		g.filletGroup = true;
		g.pos = [round(c.x), round(c.y), round(c.z)];
		for (let i = 0; i < 3; i++) this.setExpr(node, 'pos.' + i, null);
		node.pos = [round(node.pos[0] - g.pos[0]), round(node.pos[1] - g.pos[1]), round(node.pos[2] - g.pos[2])];
		node.locked = false;
		g.children = [node];
		f.list.splice(idx, 1, g);
		return { g, Mg: new THREE.Matrix4().makeTranslation(g.pos[0], g.pos[1], g.pos[2]) };
	}

	// ============================================================ push / pull a face

	onPushPullState(active, sel, distance, focus) {
		let bar = $('#pp-bar');
		if (!active) { if (bar) bar.style.display = 'none'; return; }
		if (!bar) { bar = el('div', { id: 'pp-bar', class: 'float-bar' }); $('#viewport').appendChild(bar); }
		bar.style.display = '';
		bar.innerHTML = '';
		const node = sel && this.model.get(sel.id);
		const inp = el('input', { type: 'text', class: 'num', value: distance ? fmt(distance, 3) : this.ppDistance || '2', style: 'width:72px', title: 'Distance in mm (math and variables allowed). Negative cuts into the part.' });
		inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { this.ppDistance = inp.value; this.applyPushPull(); } if (e.key === 'Escape') this.setTool(null); });
		inp.addEventListener('change', () => { this.ppDistance = inp.value; });
		const curved = sel && sel.region.curved;
		const draft = el('input', { type: 'text', class: 'num', value: this.ppDraft || '0', style: 'width:52px', title: 'Draft angle in degrees: tapers the extrusion inward as it moves away from the face (flat faces)' });
		draft.addEventListener('change', () => { this.ppDraft = draft.value; this.vp.pushPull.updatePreview(); });
		draft.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { this.ppDraft = draft.value; this.applyPushPull(); } });
		bar.append(el('b', {}, 'Push / pull'),
			el('span', { class: 'muted' }, sel ? `${curved ? 'Curved surface' : 'Face'} on “${node ? node.name : ''}” · ${fmt(sel.region.area, 1)} mm²` : 'Drag a face to thicken it (out) or cut it (in), or click a face and type a distance'),
			el('span', { class: 'muted' }, 'Distance'), inp, el('span', { class: 'muted' }, 'mm'),
			curved ? '' : el('span', { class: 'muted' }, 'Draft'), curved ? '' : draft, curved ? '' : el('span', { class: 'muted' }, '°'),
			el('button', { class: 'btn sm primary', disabled: !sel, onclick: () => { this.ppDistance = inp.value; this.applyPushPull(); } }, 'Apply'),
			el('button', { class: 'btn sm', onclick: () => this.setTool(null) }, 'Done'));
		if (focus && sel) setTimeout(() => { inp.focus(); inp.select(); }, 0);
	}

	applyPushPull() {
		const pp = this.vp.pushPull;
		const sel = pp.sel;
		if (!sel) { toast('Click a face first', 'warn'); return; }
		const d = pp.distance || evalExpr(this.ppDistance || '2', this.varValues || {});
		if (!isFinite(d) || Math.abs(d) < 1e-6) { toast('Enter a non-zero distance (negative cuts in)', 'error'); return; }
		const target = this.model.get(sel.id);
		if (!target) return;
		const r = sel.region;
		// the end of an extrusion or of an earlier push/pull: change that one instead of stacking another on it (two
		// coinciding prisms leave hairline slivers along slanted walls)
		if (!r.curved && !r.blend && !(evalExpr(this.ppDraft || '0', this.varValues || {}) || 0) && !isExpression(this.ppDistance || '')) {
			const msg = this.extendFeatureAt(target, r, d);
			if (msg) {
				pp.sel = null; pp.distance = 0; pp.clear();
				this.sel = [target.id];
				this.commit();
				this.onPushPullState(true, null, 0);
				toast(msg, 'ok', 3600);
				return;
			}
		}
		const { g, Mg } = this.featureGroupFor(target);
		const inv = Mg.clone().invert();
		// the face is remembered (a point on it, which way it faces, its size) so the push/pull can find it again when
		// something before it changes
		const nmat = new THREE.Matrix3().getNormalMatrix(inv);
		const refN = (r.curved ? r.normal : r.basis.n).clone().applyMatrix3(nmat).normalize();
		const refP = (sel.point ? sel.point.clone() : (r.curved ? r.V[0] : r.origin).clone()).applyMatrix4(inv);
		const ref = { p: refP.toArray().map(snapMeasured), n: refN.toArray().map((x) => round(x, 9)), area: round(r.area, 6) };
		let feature;
		if (r.curved) {
			// curved surface: store the patch in the feature group's frame
			const nm = new THREE.Matrix3().getNormalMatrix(inv);
			feature = makeNode('faceoff', {
				V: r.V.map((v) => v.clone().applyMatrix4(inv).toArray().map(snapMeasured)),
				N: r.N.map((n) => n.clone().applyMatrix3(nm).normalize().toArray().map((x) => round(x, 6))),
				T: r.T, depth: snapTo(d, 0.001), ref,
			}, { name: d > 0 ? 'Thicken surface' : 'Thin surface', hole: d < 0, color: target.color });
		} else {
			const draft = evalExpr(this.ppDraft || '0', this.varValues || {}) || 0;
			// a face that runs into rounded edges moves with them (no draft: the rounding keeps its shape)
			feature = r.blend && !draft
				? makeNode('facemove', { outline: r.blend.outline, h: snapMeasured(r.blend.h), depth: snapTo(d, 0.001), ref }, { name: 'Push/pull', color: target.color })
				: makeNode('facex', { loops: r.loops, depth: snapTo(d, 0.001), draft, ref },
					{ name: d > 0 ? 'Push/pull' : 'Push/pull (cut)', hole: d < 0, color: target.color });
			const world = new THREE.Matrix4().compose(r.origin, r.basis.quat, new THREE.Vector3(1, 1, 1));
			const local = inv.clone().multiply(world);
			const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
			local.decompose(p, q, s);
			const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
			// outlines and placement come from 32-bit mesh data: float noise is removed (15.3000002 → 15.3), but values on
			// a slanted face keep their full precision, and angles keep 9 decimals, so the push/pull starts exactly on the
			// face it was taken from (rounding them to microns left sub-micron steps and slivers)
			feature.rot = [snapAngle(e.x / DEG), snapAngle(e.y / DEG), snapAngle(e.z / DEG)];
			feature.pos = [p.x, p.y, p.z];
			snapPushPull(feature);
		}
		if (!pp.distance && isExpression(this.ppDistance || '')) this.setExpr(feature, 'params.depth', this.ppDistance);
		g.children.push(feature);
		pp.sel = null;
		pp.distance = 0;
		pp.clear();
		this.sel = [g.id];
		this.commit();
		this.onPushPullState(true, null, 0);
		toast(`${d > 0 ? 'Thickened' : 'Cut'} ${fmt(Math.abs(d), 2)} mm — select “${feature.name}” in Objects to change the distance`, 'ok', 3200);
	}

	/**
	 * Push/pull on a face that is the end of something already there: the top of a sketch extrusion (its height
	 * changes), the floor of a sketch pocket (its depth changes) or the end of an earlier push/pull (its distance
	 * changes; back to zero removes it). Returns a message when it did that, or null to make a new push/pull.
	 */
	extendFeatureAt(target, r, d) {
		const n = r.basis.n, O = r.origin;
		const near = (a, b, tol) => Math.abs(a - b) <= tol;
		const sameArea = (a) => near(a, r.area, 1e-3 * Math.max(1, r.area));
		const unscaled = (M) => near(Math.abs(M.determinant()), 1, 1e-6);
		const frame = (M) => ({ o: new THREE.Vector3().setFromMatrixPosition(M), z: new THREE.Vector3().setFromMatrixColumn(M, 2).normalize() });
		const loopsArea = (loops) => {
			const a = (lp) => { let s = 0; for (let i = 0; i < lp.length; i++) { const p = lp[i], q = lp[(i + 1) % lp.length]; s += p[0] * q[1] - q[0] * p[1]; } return Math.abs(s) / 2; };
			return loops.length ? a(loops[0]) - loops.slice(1).reduce((t, lp) => t + a(lp), 0) : 0;
		};
		// an earlier push/pull of this part whose end is this face
		if (target.type === 'group' && target.featureGroup) {
			for (const f of [...target.children].reverse()) {
				if (f.type !== 'facex' || f.params.draft || (f.exprs && f.exprs['params.depth'])) continue;
				const M = this.worldMatrix(f);
				if (!unscaled(M)) continue;
				const { o, z } = frame(M);
				if (z.dot(n) < 1 - 1e-6 || !near(O.clone().sub(o).dot(z), f.params.depth, 1e-4) || !sameArea(loopsArea(f.params.loops))) continue;
				const before = f.params.depth, after = snapTo(before + d, 0.001);
				if (Math.abs(after) < 1e-6) {
					target.children.splice(target.children.indexOf(f), 1);
					return `Push/pull of ${fmt(before, 2)} mm undone (${fmt(d, 2)} mm brought it back to the face)`;
				}
				f.params.depth = after;
				f.hole = after < 0;
				if (f.name.startsWith('Push/pull')) f.name = after > 0 ? 'Push/pull' : 'Push/pull (cut)';
				return `Push/pull changed from ${fmt(before, 2)} to ${fmt(after, 2)} mm — select “${f.name}” in Objects to change it`;
			}
		}
		// a sketch extrusion (or pocket) in this part whose end is this face
		const sketches = [];
		const walk = (k) => { if (k.type === 'sketch' && (k.params.mode || 'extrude') === 'extrude') sketches.push(k); (k.children || []).forEach(walk); };
		walk(target);
		for (const k of sketches) {
			const p = k.params;
			if (p.fillet || p.edge || p.taper || p.draft || (k.exprs && (k.exprs['params.height'] || Object.keys(k.exprs).some((e) => e.startsWith('pos') || e.startsWith('rot'))))) continue;
			const M = this.worldMatrix(k);
			if (!unscaled(M)) continue;
			const { o, z } = frame(M);
			const geo = this.engine.geometry(k);
			if (!geo) continue;
			// end area: the sketch's flat cap (top for an extrusion, the floor for a pocket)
			const capZ = k.hole ? 0 : p.height, pos = geo.attributes.position;
			let area = 0;
			const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
			for (let i = 0; i < pos.count; i += 3) {
				a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); c.fromBufferAttribute(pos, i + 2);
				if (!near(a.z, capZ, 1e-6) || !near(b.z, capZ, 1e-6) || !near(c.z, capZ, 1e-6)) continue;
				const cr = b.clone().sub(a).cross(c.clone().sub(a));
				if ((k.hole ? cr.z < 0 : cr.z > 0)) area += cr.length() / 2;
			}
			if (z.dot(n) < 1 - 1e-6 || !near(O.clone().sub(o).dot(z), capZ, 1e-4) || !sameArea(area)) continue;
			// where the part's face is, in the sketch's frame, and how far the sketch reaches out of it (+) or into it (−)
			const ov = k.hole ? 0 : (p.face && p.face.overlap) || 0;
			const faceZ = k.hole ? p.height : ov;
			const before = k.hole ? -p.height : p.height - ov;
			const after = snapTo(before + d, 0.001);
			const what = (e) => (e > 0 ? `${fmt(e, 2)} mm out` : `${fmt(-e, 2)} mm deep`);
			if (!p.face && (after > 0) !== (before > 0)) return null; // a free-standing sketch can't turn into a cut
			const list = this.model.find(k.id).list;
			if (Math.abs(after) <= 0.01) {
				// back flush with the face: the extrusion (or pocket) is gone
				list.splice(list.indexOf(k), 1);
				return `“${k.name}” pushed flush with the face, so it was removed (Ctrl+Z brings it back)`;
			}
			// the new sketch: an extrusion starts just inside the face, a pocket at its floor
			const ovNew = after > 0 ? (p.face ? p.face.overlap || FACE_OVERLAP : 0) : 0;
			const baseZ = after > 0 ? faceZ - ovNew : faceZ + after;
			p.height = snapTo(after > 0 ? after + ovNew : -after, 0.001);
			if (p.face) p.face = { ...p.face, cut: after < 0, overlap: ovNew };
			const flipped = (after < 0) !== !!k.hole;
			k.hole = after < 0;
			if (flipped && /^(Extrusion|Pocket)$/.test(k.name)) k.name = k.hole ? 'Pocket' : 'Extrusion';
			if (Math.abs(baseZ) > 1e-12) {
				const loc = nodeMatrix(k).multiply(new THREE.Matrix4().makeTranslation(0, 0, baseZ));
				const pp = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
				loc.decompose(pp, q, sc);
				k.pos = [pp.x, pp.y, pp.z].map(snapNoise);
			}
			return `“${k.name}” changed from ${what(before)} to ${what(after)}${flipped ? (k.hole ? ' (now a pocket)' : ' (now an extrusion)') : ''} — double-click it to edit the sketch`;
		}
		return null;
	}

	applyEdgeOp() {
		const ft = this.vp.filletTool;
		const s = ft.selection();
		if (!s || !s.chains.length) { toast('Click one or more edges first', 'warn'); return; }
		const kind = this.filletKind || 'fillet';
		const size = evalExpr(this.filletSize || '1', this.varValues || {});
		if (!(size > 0)) { toast('Enter a size greater than 0', 'error'); return; }
		const size2 = this.filletVariable ? evalExpr(this.filletSize2 || '0', this.varValues || {}) : 0;
		if (this.filletVariable && !(size2 > 0)) { toast('Enter an end size greater than 0', 'error'); return; }
		const varying = size2 > 0 && Math.abs(size2 - size) > 1e-9;
		const node = this.model.get(s.id);
		if (!node) return;
		const { g, Mg } = this.featureGroupFor(node);
		// edge data is in world space: express it in the fillet group's frame
		const inv = Mg.clone().invert();
		const nm = new THREE.Matrix3().getNormalMatrix(inv);
		const conv = (ch) => ({
			pts: ch.pts.map((p) => new THREE.Vector3(...p).applyMatrix4(inv).toArray().map((x) => round(x, 5))),
			n1: ch.n1.map((n) => new THREE.Vector3(...n).applyMatrix3(nm).normalize().toArray().map((x) => round(x, 6))),
			n2: ch.n2.map((n) => new THREE.Vector3(...n).applyMatrix3(nm).normalize().toArray().map((x) => round(x, 6))),
			closed: ch.closed, convex: ch.convex,
		});
		const label = kind === 'fillet' ? 'Fillet' : 'Chamfer';
		const cut = s.chains.filter((c) => c.convex), fill = s.chains.filter((c) => !c.convex);
		const sizeExpr = isExpression(this.filletSize || '') ? this.filletSize : null;
		const add = (chains, hole) => {
			const e = makeNode('edgeop', { chains: chains.map(conv), kind, size, ...(varying ? { size2 } : {}) }, { name: (varying ? 'Variable ' + label.toLowerCase() : label) + (hole ? '' : ' (inside corners)'), hole, color: node.color });
			if (sizeExpr) this.setExpr(e, 'params.size', sizeExpr);
			g.children.push(e);
		};
		if (cut.length) add(cut, true);
		if (fill.length) add(fill, false);
		ft.target = g.id;
		ft.selected.clear();
		ft.flipped.clear();
		this.sel = [g.id];
		this.commit();
		if (this.engine.errors.has(g.id)) toast('Some edges could not be filleted cleanly — try a smaller size', 'error', 4000);
		else toast(`${label}ed ${s.chains.length} edge${s.chains.length > 1 ? 's' : ''} — select “${label}” in Objects to change the size later`, 'ok', 3500);
	}

	roundAllDialog() {
		const ft = this.vp.filletTool;
		const id = (ft.target) || (this.sel[0] && this.model.topLevelOf(this.sel[0]) && this.model.topLevelOf(this.sel[0]).id);
		const node = id && this.model.get(id);
		if (!node) { toast('Hover or select a part first', 'warn'); return; }
		const form = el('div', { class: 'form' },
			el('label', { class: 'row' }, el('span', {}, 'Radius (mm)'), el('input', { id: 'ra-r', type: 'text', value: this.filletSize || 1 })),
			el('p', { class: 'muted small' }, `Rounds every outside edge and corner of “${node.name}” by shrinking it and growing it back. Features thinner than twice the radius disappear. Complex parts can take a few seconds.`));
		this.modal('Round whole part', form, [{ label: 'Cancel' }, {
			label: 'Round', primary: true, action: () => {
				const r = evalExpr($('#ra-r').value, this.varValues || {});
				if (!(r > 0)) { toast('Enter a radius greater than 0', 'error'); return false; }
				this.setTool(null);
				this.sel = [node.id];
				this.group('offset', 'Shrink ' + fmt(r, 2), { offset: -r });
				this.group('offset', node.name + ' (rounded)', { offset: r });
			},
		}]);
	}

	// ============================================================ offset (grow / shrink)

	offsetDialog() {
		const nodes = this.selectedNodes();
		if (!nodes.length) { toast('Select objects to offset', 'warn'); return; }
		const form = el('div', { class: 'form' },
			el('label', { class: 'row' }, el('span', {}, 'Distance (mm)'), el('input', { id: 'off-d', type: 'text', value: this.lastOffset ?? 1 })),
			el('p', { class: 'muted small' }, 'Positive grows the shape outward by that distance (rounded edges); negative shrinks it. Great for clearance cut-outs (offset a part by 0.2 mm, then make it a hole) or thickening. It stays editable as a group. Complex shapes can take a few seconds.'));
		this.modal('Offset / thicken', form, [{ label: 'Cancel' }, {
			label: 'Offset', primary: true, action: () => {
				const d = evalExpr($('#off-d').value, this.varValues || {});
				if (!isFinite(d) || d === 0) { toast('Enter a non-zero distance', 'error'); return false; }
				this.lastOffset = d;
				const t0 = performance.now();
				this.group('offset', null, { offset: d });
				const ms = performance.now() - t0;
				if (ms > 1500) toast(`Offset computed in ${(ms / 1000).toFixed(1)} s — it is cached until the parts change`, 'info', 3500);
			},
		}]);
	}

	// ============================================================ workplane

	onPickWorkplane(sp) {
		if (sp && sp.object) {
			const node = this.model.get(sp.object.userData.nodeId);
			this.vp.setWorkplane(sp.point, sp.normal, node ? node.name : 'face');
		} else this.vp.clearWorkplane();
		this.setTool(null);
		this.renderWorkplaneChip();
	}

	renderWorkplaneChip() {
		let chip = $('#wp-chip');
		const wp = this.vp.workplane;
		if (!wp) { if (chip) chip.remove(); return; }
		if (!chip) { chip = el('div', { id: 'wp-chip', class: 'float-chip' }); $('#viewport').appendChild(chip); }
		chip.innerHTML = '';
		chip.append(el('span', { html: icon('workplane') }), el('span', {}, 'Workplane on ', el('b', {}, wp.label)),
			el('button', { class: 'btn sm', title: 'Back to the bed', onclick: () => { this.vp.clearWorkplane(); this.renderWorkplaneChip(); } }, 'Reset to bed'));
	}

	// ============================================================ object picker

	// List every object under the cursor (nearest first), including parts inside groups.
	showObjectPicker(hits, pt) {
		document.querySelectorAll('.menu').forEach((m) => m.remove());
		const restore = () => this.vp.setSelection(this.sel);
		const m = el('div', { class: 'menu picker' }, el('div', { class: 'menu-title' }, 'Objects here'));
		for (const h of hits) {
			const n = h.node;
			const kind = n.type === 'group' ? 'group' : (SHAPES[n.type] || {}).label || n.type;
			const b = el('button', { class: 'pick-row', style: { paddingLeft: 10 + h.depth * 14 + 'px' } },
				el('span', { class: 'swatch' + (n.hole ? ' hole' : ''), style: n.hole ? {} : { background: n.color } }),
				el('span', { class: 'grow' }, n.name),
				h.parent ? el('span', { class: 'muted small' }, 'in ' + h.parent.name) : el('span', { class: 'muted small' }, kind));
			b.addEventListener('mouseenter', () => this.vp.setSelection([n.id]));
			b.addEventListener('click', (e) => { m.remove(); this.onPick(n.id, e.shiftKey || e.ctrlKey || e.metaKey, !!h.parent); });
			m.appendChild(b);
		}
		m.addEventListener('mouseleave', restore);
		document.body.appendChild(m);
		m.style.left = Math.min(pt.x + 4, window.innerWidth - m.offsetWidth - 8) + 'px';
		m.style.top = Math.min(pt.y + 4, window.innerHeight - m.offsetHeight - 8) + 'px';
		setTimeout(() => {
			const off = (e) => { if (!m.contains(e.target)) { m.remove(); restore(); window.removeEventListener('pointerdown', off, true); } };
			window.addEventListener('pointerdown', off, true);
		});
	}

	sketchOpts(extra = {}) {
		return { snap: this.model.settings.snap, scope: this.varValues || {}, ...extra };
	}

	async newSketch(at) {
		const res = await openSketchEditor({ ...makeNode('sketch').params, isNew: true }, this.sketchOpts({ isNew: true }));
		if (!res) return;
		this.addNode(makeNode('sketch', res, { name: res.mode === 'revolve' ? 'Revolve' : 'Extrude' }), at);
		toast('Double-click the shape any time to go back into its sketch', 'info', 3500);
	}

	/** Reopen a sketch to keep working on it; the shape (and anything it cuts or joins) updates when you finish. */
	async editSketch(node) {
		const face = node.params.face;
		const ov = face ? face.overlap || 0 : 0;
		// a sketch made on a face shows its real depth (without the small overlap into the face)
		const shown = face ? { ...node.params, height: round(node.params.height - ov, 6) } : node.params;
		const res = await openSketchEditor(shown, this.sketchOpts({ scope: (this.scopeById && this.scopeById.get(node.id)) || this.varValues || {}, name: node.name, heightLabel: face && face.cut ? 'Pocket depth (mm)' : undefined, lockMode: !!face }));
		if (!res) return;
		res.anchored = !!node.params.anchored; // older (centered) sketches stay centered so they don't jump
		delete res.op; delete res.combine;
		if (face) {
			const oldDepth = node.params.height - ov, newDepth = res.height;
			res.height = newDepth + ov;
			// a pocket hangs down from its face: keep its top on the face when the depth changes
			if (face.cut && Math.abs(newDepth - oldDepth) > 1e-12) {
				const up = new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(...node.rot.map((d) => d * DEG), 'XYZ')));
				node.pos = node.pos.map((v, i) => round(v + up.getComponent(i) * (oldDepth - newDepth), 6));
			}
			res.face = face;
		}
		Object.assign(node.params, res);
		delete node.params.pts;
		this.commit();
	}

	/** The sketch-made object under the cursor (at any depth inside groups), or null. */
	sketchAt(e) {
		return this.sketchFromHits(this.vp.hitsAt(e));
	}

	/** From everything under the cursor: a sketch at or in front of the visible surface (not one hidden behind it). */
	sketchFromHits(hits) {
		const top = hits.find((h) => h.depth === 0);
		const sk = hits.find((h) => h.node && h.node.type === 'sketch' && !h.node.locked);
		if (!sk) return null;
		return !top || sk.distance <= top.distance + 0.05 ? sk.node : null;
	}

	deleteSel() {
		const nodes = this.selectedNodes();
		if (!nodes.length) return;
		for (const n of nodes) this.model.remove(n.id);
		this.cleanupEmptyGroups();
		this.sel = [];
		this.commit();
	}

	cleanupEmptyGroups() {
		let changed = true;
		while (changed) {
			changed = false;
			walk(this.model.nodes, (n) => {
				if (n.type === 'group' && n.children.length === 0) { this.model.remove(n.id); changed = true; return false; }
			});
		}
	}

	copy() {
		const nodes = this.selectedNodes();
		if (!nodes.length) return;
		this.clipboard = nodes.map((n) => ({ node: JSON.parse(JSON.stringify(n)), world: this.worldMatrix(n).toArray() }));
		// mesh data goes along, so pasting into another tab works
		this.clipboardBlobs = {};
		walk(nodes, (n) => { if (n.type === 'mesh' && this.model.blobs[n.params.blob]) this.clipboardBlobs[n.params.blob] = this.model.blobs[n.params.blob]; });
		toast(`Copied ${nodes.length} object${nodes.length > 1 ? 's' : ''}`);
	}

	cut() {
		this.copy();
		this.deleteSel();
	}

	paste() {
		if (!this.clipboard) return;
		Object.assign(this.model.blobs, this.clipboardBlobs || {});
		const ids = [];
		const off = Math.max(this.model.settings.snap, 1) * 5;
		for (const c of this.clipboard) {
			const n = cloneWithNewIds(c.node);
			const M = new THREE.Matrix4().fromArray(c.world);
			const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
			M.decompose(p, q, s);
			const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
			n.pos = [round(p.x + off), round(p.y + off), round(p.z)];
			n.rot = [round(e.x / DEG, 3), round(e.y / DEG, 3), round(e.z / DEG, 3)];
			n.scale = [round(s.x, 5), round(s.y, 5), round(s.z, 5)];
			n.locked = false;
			this.model.nodes.push(n);
			ids.push(n.id);
		}
		this.clipboard.forEach((c) => { const M = new THREE.Matrix4().fromArray(c.world); M.premultiply(new THREE.Matrix4().makeTranslation(off, off, 0)); c.world = M.toArray(); });
		this.sel = ids;
		this.commit();
	}

	// Duplicate in place. Duplicating again after moving the copy repeats that transform (like Tinkercad).
	duplicate() {
		const nodes = this.selectedNodes();
		if (!nodes.length) return;
		let delta = null;
		const ld = this.lastDup;
		if (ld && ld.newIds.length === nodes.length && ld.newIds.every((id, i) => nodes[i].id === id)) {
			const cur = this.worldMatrix(nodes[0]);
			delta = cur.clone().multiply(new THREE.Matrix4().fromArray(ld.src[0]).invert());
			const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
			delta.decompose(p, q, s);
			if (p.length() < 1e-6 && Math.abs(q.w) > 0.999999) delta = null;
		}
		const src = nodes.map((n) => this.worldMatrix(n).toArray());
		const ids = [];
		for (const n of nodes) {
			const f = this.model.find(n.id);
			const c = cloneWithNewIds(n);
			c.locked = false;
			f.list.splice(f.list.indexOf(n) + 1, 0, c);
			ids.push(c.id);
		}
		if (delta) {
			// Need objects for the copies to compute world matrices; reuse originals' matrices instead.
			ids.forEach((id, i) => {
				const c = this.model.get(id);
				const M = delta.clone().multiply(new THREE.Matrix4().fromArray(src[i]));
				const obj = this.vp.objs.get(nodes[i].id);
				const parentInv = obj.parent.matrixWorld.clone().invert();
				const local = parentInv.multiply(M);
				const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
				local.decompose(p, q, s);
				const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
				c.pos = [round(p.x), round(p.y), round(p.z)];
				c.rot = [round(e.x / DEG, 3), round(e.y / DEG, 3), round(e.z / DEG, 3)];
				c.scale = [round(s.x, 5), round(s.y, 5), round(s.z, 5)];
			});
		}
		this.lastDup = { newIds: ids, src };
		this.sel = ids;
		this.commit();
		toast(delta ? 'Duplicated and repeated last move' : 'Duplicated — move the copy, then duplicate again to repeat', 'info', 2200);
	}

	siblingsCheck(nodes) {
		const parents = new Set(nodes.map((n) => this.model.parentOf(n.id)));
		return parents.size === 1 ? [...parents][0] : undefined;
	}

	group(mode = 'union', name = null, opts = {}) {
		const nodes = this.selectedNodes();
		const single = mode === 'offset' || mode === 'texture' || mode === 'deform';
		if (!nodes.length && single) { toast('Select a part first', 'warn'); return; }
		if (nodes.length < 2 && !single && !(mode === 'hull' && nodes.length === 1 && nodes[0].type !== 'group')) {
			if (nodes.length === 1 && nodes[0].type === 'group') { nodes[0].mode = mode; this.commit(); return; }
			toast('Select at least two objects to combine', 'warn');
			return;
		}
		const parent = this.siblingsCheck(nodes);
		if (parent === undefined) { toast('Objects must be at the same level to group', 'warn'); return; }
		const box = this.vp.selectionBox();
		const c = box.getCenter(new THREE.Vector3());
		const pObj = parent ? this.vp.objs.get(parent.id) : null;
		if (pObj) pObj.worldToLocal(c);
		const list = parent ? parent.children : this.model.nodes;
		const idx = Math.min(...nodes.map((n) => list.indexOf(n)));
		for (const n of nodes) list.splice(list.indexOf(n), 1);
		for (const n of nodes) {
			n.pos = [round(n.pos[0] - c.x), round(n.pos[1] - c.y), round(n.pos[2] - c.z)];
			n.locked = false;
		}
		const g = makeGroup(nodes, { mode, name: name || (mode === 'offset' ? `Offset ${opts.offset > 0 ? '+' : ''}${fmt(opts.offset, 2)}` : mode === 'intersect' ? 'Intersection' : mode === 'hull' ? 'Hull' : nodes.some((n) => n.hole) ? 'Cut' : 'Union') });
		if (mode === 'offset') g.offset = opts.offset;
		if (mode === 'texture') g.texture = { ...opts.texture };
		if (mode === 'deform') g.deform = { ...opts.deform };
		g.pos = [round(c.x), round(c.y), round(c.z)];
		list.splice(idx, 0, g);
		this.sel = [g.id];
		this.commit();
		if (!nodes.some((n) => !n.hole)) toast('Group contains only holes — it will be empty', 'warn');
	}

	ungroup() {
		const groups = this.selectedNodes().filter((n) => n.type === 'group');
		if (!groups.length) { toast('Select a group to ungroup', 'warn'); return; }
		const newSel = [];
		for (const g of groups) {
			const f = this.model.find(g.id);
			const G = nodeMatrix(g);
			const idx = f.list.indexOf(g);
			f.list.splice(idx, 1);
			const kids = g.children.map((c) => {
				const M = G.clone().multiply(nodeMatrix(c));
				const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
				M.decompose(p, q, s);
				const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
				c.pos = [round(p.x), round(p.y), round(p.z)];
				c.rot = [round(e.x / DEG, 3), round(e.y / DEG, 3), round(e.z / DEG, 3)];
				c.scale = [round(s.x, 5), round(s.y, 5), round(s.z, 5)];
				if (g.hole) c.hole = true;
				return c;
			});
			f.list.splice(idx, 0, ...kids);
			newSel.push(...kids.map((k) => k.id));
		}
		this.sel = newSel;
		this.commit();
	}

	toggleHole() {
		const nodes = this.selectedNodes();
		if (!nodes.length) return;
		const makeHole = nodes.some((n) => !n.hole);
		for (const n of nodes) n.hole = makeHole;
		this.commit();
	}

	dropToBed() {
		const nodes = this.selectedNodes().length ? this.selectedNodes() : this.model.nodes;
		for (const n of nodes) {
			if (!this.model.isTopLevel(n.id) || n.locked) continue;
			const b = this.worldBox(n);
			if (!b.isEmpty() && Math.abs(b.min.z) > 1e-9) { this.setExpr(n, 'pos.2', null); n.pos[2] = round(n.pos[2] - b.min.z); }
		}
		this.commit();
	}

	centerOnBed() {
		const nodes = this.selectedNodes().filter((n) => !n.locked);
		if (!nodes.length) return;
		const box = this.vp.selectionBox(nodes.map((n) => n.id));
		const c = box.getCenter(new THREE.Vector3());
		for (const n of nodes) this.moveWorld(n, new THREE.Vector3(-c.x, -c.y, -box.min.z));
		this.commit();
	}

	nudge(dx, dy, dz) {
		const nodes = this.selectedNodes().filter((n) => !n.locked);
		if (!nodes.length) return;
		for (const n of nodes) this.moveWorld(n, new THREE.Vector3(dx, dy, dz));
		this.commit();
	}

	// Arrow keys move relative to the view: up = away from the viewer on screen, right = screen right.
	// Each direction snaps to the nearest bed axis so moves stay on the grid.
	nudgeScreen(dir, step) {
		const cam = this.vp.camera;
		const flat = (v) => { v.z = 0; return v; };
		let up = flat(new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion));
		if (up.length() < 0.2) up = flat(cam.getWorldDirection(new THREE.Vector3()));
		const right = new THREE.Vector3(up.y, -up.x, 0); // up rotated -90° about Z
		const snapAxis = (v) => (Math.abs(v.x) >= Math.abs(v.y) ? new THREE.Vector3(Math.sign(v.x), 0, 0) : new THREE.Vector3(0, Math.sign(v.y), 0));
		const d = { up: snapAxis(up), down: snapAxis(up).negate(), right: snapAxis(right), left: snapAxis(right).negate() }[dir];
		if (d) this.nudge(d.x * step, d.y * step, 0);
	}

	rotateSel(axis, deg) {
		const nodes = this.selectedNodes().filter((n) => !n.locked);
		if (!nodes.length) return;
		const c = this.vp.selectionBox().getCenter(new THREE.Vector3());
		const R = new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(...{ x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }[axis]), deg * DEG);
		const M = new THREE.Matrix4().makeTranslation(c.x, c.y, c.z).multiply(R).multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z));
		for (const n of nodes) this.setWorldMatrix(n, M.clone().multiply(this.worldMatrix(n)));
		this.commit();
	}

	/** Mirrored copy: features inside a part are mirrored across the part's center plane; top-level objects
	 * across the selection's far side, so the copy sits next to the original. */
	mirrorCopy(axis) {
		const nodes = this.selectedNodes().filter((n) => !n.locked);
		if (!nodes.length) { toast('Select a feature (e.g. a hole) or object to mirror', 'warn'); return; }
		const parent = this.model.parentOf(nodes[0].id);
		const box = parent ? this.worldBox(parent) : this.vp.selectionBox();
		const i = { x: 0, y: 1, z: 2 }[axis];
		const c = box.getCenter(new THREE.Vector3());
		if (!parent) c.setComponent(i, box.max.getComponent(i) + 2);
		const S = new THREE.Matrix4().makeScale(axis === 'x' ? -1 : 1, axis === 'y' ? -1 : 1, axis === 'z' ? -1 : 1);
		const M = new THREE.Matrix4().makeTranslation(c.x, c.y, c.z).multiply(S).multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z));
		const created = [];
		for (const n of nodes) {
			const f = this.model.find(n.id);
			const copy = cloneWithNewIds(n);
			copy.name = n.name + ' (mirror)';
			f.list.splice(f.list.indexOf(n) + 1, 0, copy);
			this.vp.objs.set(copy.id, this.vp.objs.get(n.id));
			this.setWorldMatrix(copy, M.clone().multiply(this.worldMatrix(n)));
			this.vp.objs.delete(copy.id);
			created.push(copy.id);
		}
		this.sel = created;
		this.commit();
		toast(parent ? `Mirrored across the center of “${parent.name}”` : 'Mirrored copy placed next to the original', 'ok');
	}

	mirror(axis) {
		const nodes = this.selectedNodes().filter((n) => !n.locked);
		if (!nodes.length) { toast('Select something to mirror', 'warn'); return; }
		const c = this.vp.selectionBox().getCenter(new THREE.Vector3());
		const S = new THREE.Matrix4().makeScale(axis === 'x' ? -1 : 1, axis === 'y' ? -1 : 1, axis === 'z' ? -1 : 1);
		const M = new THREE.Matrix4().makeTranslation(c.x, c.y, c.z).multiply(S).multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z));
		for (const n of nodes) this.setWorldMatrix(n, M.clone().multiply(this.worldMatrix(n)));
		this.commit();
	}

	// Work out how each selected object moves to align along one axis.
	// Reference: the anchor object if one is chosen, the bed for a single object, otherwise the selection's bounds.
	alignPlan(axis, where, keyId) {
		const nodes = this.selectedNodes().filter((n) => !n.locked);
		let ref, movers = nodes;
		if (keyId && nodes.some((n) => n.id === keyId)) {
			ref = this.worldBox(this.model.get(keyId));
			movers = nodes.filter((n) => n.id !== keyId);
		} else if (nodes.length === 1) {
			const { w, d } = this.model.settings.bed;
			ref = new THREE.Box3(new THREE.Vector3(-w / 2, -d / 2, 0), new THREE.Vector3(w / 2, d / 2, 0));
		} else ref = this.vp.selectionBox(nodes.map((n) => n.id));
		const target = where === 'min' ? ref.min[axis] : where === 'max' ? ref.max[axis] : (ref.min[axis] + ref.max[axis]) / 2;
		const moves = [];
		for (const n of movers) {
			const b = this.worldBox(n);
			const cur = where === 'min' ? b.min[axis] : where === 'max' ? b.max[axis] : (b.min[axis] + b.max[axis]) / 2;
			const d = new THREE.Vector3();
			d[axis] = target - cur;
			if (Math.abs(d[axis]) > 1e-6) moves.push({ node: n, d });
		}
		return { moves, ref, target };
	}

	align(axis, where, keyId) {
		const { moves } = this.alignPlan(axis, where, keyId);
		if (!moves.length) return;
		for (const { node, d } of moves) this.moveWorld(node, d);
		this.commit();
	}

	onAlignState(active, nodes, key) {
		let bar = $('#align-bar');
		if (!active) { if (bar) bar.style.display = 'none'; return; }
		if (!bar) {
			bar = el('div', { id: 'align-bar', class: 'float-bar' });
			$('#viewport').appendChild(bar);
		}
		bar.style.display = '';
		bar.innerHTML = '';
		const msg = !nodes.length ? 'Select the objects you want to line up.'
			: nodes.length === 1 ? 'Hover a dot to preview · click to align to the bed · click other objects to add them'
				: key ? 'Everything lines up to the anchor · click it again to clear'
					: 'Hover a dot to preview · click to apply · click an object to make it the anchor';
		bar.append(el('b', {}, 'Align'), el('span', { class: 'muted' }, msg));
		if (key) bar.append(el('span', { class: 'chip' }, 'Anchor: ' + this.model.get(key).name));
		if (nodes.length >= 3) {
			bar.append(el('span', { class: 'sep' }), el('span', { class: 'muted' }, 'Space evenly:'),
				...['x', 'y', 'z'].map((ax) => el('button', { class: 'btn sm', title: 'Equal gaps along ' + ax.toUpperCase(), onclick: () => this.distribute(ax) }, ax.toUpperCase())));
		}
		bar.append(el('button', { class: 'btn sm primary', onclick: () => this.setTool(null) }, 'Done'));
	}

	/**
	 * Space the selection evenly along an axis.
	 * by: 'gap' (equal space between neighbors' sides) or 'center' (equal center-to-center pitch).
	 * value: null = fit between the first and last object (both stay put); a number = that gap / pitch, first object stays.
	 */
	distribute(axis, by = 'gap', value = null) {
		const nodes = this.selectedNodes().filter((n) => !n.locked);
		const need = value == null ? 3 : 2;
		if (nodes.length < need) { toast(value == null ? 'Select 3 or more objects to space evenly between the outer two' : 'Select 2 or more objects to space', 'warn'); return false; }
		const items = nodes.map((n) => { const b = this.worldBox(n); return { n, b, c: (b.min[axis] + b.max[axis]) / 2, size: b.max[axis] - b.min[axis] }; })
			.sort((a, b) => a.c - b.c || a.b.min[axis] - b.b.min[axis]);
		const first = items[0], last = items[items.length - 1], k = items.length - 1;
		const moveTo = (it, min) => { const d = new THREE.Vector3(); d[axis] = min - it.b.min[axis]; this.moveWorld(it.n, d); };
		if (by === 'center') {
			const pitch = value == null ? (last.c - first.c) / k : value;
			items.forEach((it, i) => moveTo(it, first.c + i * pitch - it.size / 2));
		} else {
			const total = items.reduce((s, it) => s + it.size, 0);
			const gap = value == null ? (last.b.max[axis] - first.b.min[axis] - total) / k : value;
			let cursor = first.b.min[axis];
			for (const it of items) { moveTo(it, cursor); cursor += it.size + gap; }
		}
		this.commit();
		return true;
	}

	/** Current spacing of the selection along an axis: { gap, pitch } (averages), for the dialog's defaults. */
	spacingOf(nodes, axis) {
		const items = nodes.map((n) => this.worldBox(n)).map((b) => ({ min: b.min[axis], max: b.max[axis], c: (b.min[axis] + b.max[axis]) / 2 })).sort((a, b) => a.c - b.c);
		if (items.length < 2) return { gap: 0, pitch: 0 };
		let gap = 0;
		for (let i = 1; i < items.length; i++) gap += items[i].min - items[i - 1].max;
		return { gap: gap / (items.length - 1), pitch: (items[items.length - 1].c - items[0].c) / (items.length - 1) };
	}

	spaceDialog() {
		const nodes = this.selectedNodes().filter((n) => !n.locked);
		if (nodes.length < 2) { toast('Select 2 or more objects to space evenly', 'warn'); return; }
		// default axis: the one the selection is most spread out along
		const spread = ['x', 'y', 'z'].map((ax) => { const cs = nodes.map((n) => { const b = this.worldBox(n); return (b.min[ax] + b.max[ax]) / 2; }); return Math.max(...cs) - Math.min(...cs); });
		const last = this.lastSpace || {};
		const axis0 = spread[2] > Math.max(spread[0], spread[1]) * 1.5 ? 'z' : spread[1] > spread[0] ? 'y' : 'x';
		const radio = (name, value, label, checked) => el('label', { class: 'chip-check' }, el('input', { type: 'radio', name, value, ...(checked ? { checked: true } : {}) }), el('span', {}, label));
		const fitOk = nodes.length >= 3;
		const amount = el('input', { id: 'sp-val', type: 'text', style: 'width:90px' });
		const note = el('p', { class: 'muted small' });
		const form = el('div', { class: 'form' },
			el('div', { class: 'row' }, el('span', {}, 'Along'), el('div', { class: 'chips' }, ...['x', 'y', 'z'].map((ax) => radio('sp-axis', ax, ax.toUpperCase(), ax === axis0)))),
			el('div', { class: 'row' }, el('span', {}, 'Make equal'), el('div', { class: 'chips' }, radio('sp-by', 'gap', 'Gaps between objects', (last.by || 'gap') === 'gap'), radio('sp-by', 'center', 'Center-to-center', last.by === 'center'))),
			el('div', { class: 'row' }, el('span', {}, 'Spacing'), el('div', { class: 'chips' },
				radio('sp-how', 'fit', 'Fit between first & last', fitOk && last.how !== 'set'), radio('sp-how', 'set', 'Exact distance', !fitOk || last.how === 'set'))),
			el('label', { class: 'row' }, el('span', { id: 'sp-val-label' }, 'Distance (mm)'), amount),
			note);
		const get = (name) => (form.querySelector('input[name="' + name + '"]:checked') || {}).value;
		const refresh = (resetValue) => {
			const ax = get('sp-axis'), by = get('sp-by'), how = get('sp-how');
			const cur = this.spacingOf(nodes, ax);
			form.querySelector('#sp-val-label').textContent = by === 'center' ? 'Center-to-center (mm)' : 'Gap (mm)';
			amount.disabled = how !== 'set';
			if (resetValue || how !== 'set') amount.value = round(by === 'center' ? cur.pitch : (last.by === by && last.value != null && how === 'set' ? last.value : Math.max(0, cur.gap)), 3);
			note.textContent = how === 'set'
				? `The first object (lowest ${ax.toUpperCase()}) stays put; the others are placed after it in order.`
				: `The two outermost objects stay put; the ${nodes.length - 2} in between are moved so the ${by === 'center' ? 'center-to-center distances' : 'gaps'} are equal.`;
		};
		form.addEventListener('change', (e) => refresh(e.target.name !== 'sp-how'));
		if (!fitOk) form.querySelector('input[value="fit"]').disabled = true;
		this.modal('Space evenly', form, [{ label: 'Cancel' }, {
			label: 'Apply', primary: true, action: () => {
				const axis = get('sp-axis'), by = get('sp-by'), how = get('sp-how');
				let value = null;
				if (how === 'set') {
					value = evalExpr(amount.value, this.varValues || {});
					if (!isFinite(value)) { toast('Enter a distance', 'error'); return false; }
				}
				this.lastSpace = { by, how, value };
				return this.distribute(axis, by, value);
			},
		}]);
		refresh(true);
	}

	setTool(tool) {
		const prevTool = this.tool;
		this.tool = this.tool === tool ? null : tool;
		if (this.tool !== 'mate') this.mateState = null;
		if (prevTool === 'holewiz' && this.tool !== 'holewiz') this.endHoleWizard();
		this.vp.setTool(this.tool);
		this.paintBar(this.tool === 'paint');
		if (this.tool !== 'sympoint') { this.hideSymBar(); this.symPending = null; this.symRepick = null; }
		document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === this.tool));
		document.querySelectorAll('[data-tools]').forEach((b) => b.classList.toggle('active', !!this.tool && b.dataset.tools.split(',').includes(this.tool)));
		$('#st-hint').textContent = this.tool === 'measure' ? 'Measure: click two faces for the gap ⊥ between them (or the angle between them), or two points (corners and circle centers snap) for the distance and its X / Y / Z legs, then Shift-click a third point for the angle at the second. Click a round edge, hole, cylinder or sphere for its diameter. Alt = free point. Esc to exit.'
			: this.tool === 'place' ? 'Place on face: click any face or the bed to set the selection onto it. Esc to cancel.'
				: this.tool === 'align' ? 'Align: red dots = X, green = Y, blue = Z. Esc or Done to finish.'
					: this.tool === 'workplane' ? 'Workplane: click a face to build on it, or click the bed to go back to the bed. Esc to cancel.'
						: this.tool === 'sketchface' ? 'Sketch on face: click the face you want to draw on. Esc to cancel.'
						: this.tool === 'sectionface' ? 'Section: click a flat face — the cut plane lies on it. Esc to cancel.'
							: this.tool === 'fillet' ? 'Fillet / chamfer: blue lines are the part’s edges. Click edges to select (or a face for all its edges), set a size — tick Variable to go from one size to another along each edge — then Apply. Esc to finish.'
								: this.tool === 'pushpull' ? 'Push / pull: drag a face (Alt = no snap), or click it and type a distance. Esc to finish.'
								: this.tool === 'sympoint' ? 'Symmetry: click the point the mirror planes go through (on a part or the bed), or Use center. Esc to cancel.'
								: this.tool === 'paint' ? 'Paint: pick a color, then click faces. Export as 3MF and each color becomes a filament in Bambu Studio, Orca or PrusaSlicer. Esc to finish.' : '';
	}

	setGizmo(mode) {
		this.vp.setGizmoMode(mode);
		document.querySelectorAll('[data-gizmo]').forEach((b) => b.classList.toggle('active', b.dataset.gizmo === mode));
	}

	undo() {
		if (this.sculpt) { this.sculptUndo(); return; } // while sculpting: strokes
		if (this.model.undo()) { this.afterChange(); this.autosave(); }
	}

	redo() {
		if (this.sculpt) { this.sculptRedo(); return; }
		if (this.model.redo()) { this.afterChange(); this.autosave(); }
	}

	// ============================================================ files

	async newProject() {
		return this.newTab(); // a new design opens in its own tab
	}

	/** Start over in the current tab (replaces its design). */
	async resetProject() {
		if (this.model.nodes.length && !confirm('Start a new design? Unsaved changes in the current design will be lost (save first if needed).')) return;
		const settings = this.model.settings;
		this.model.load({ ...this.model.emptyDoc(), settings });
		this.sel = [];
		this.savedSig = null;
		this.fileName = null;
		this.setFileHandle(null);
		this.engine.cache.clear();
		this.afterChange();
		this.autosaveNow();
	}

	// Save: write back to the current file when we have one, otherwise behave like Save as.
	// Save as: pick a file name / location (File System Access API), or ask for a name and download.
	async saveProject(saveAs = false) {
		const safe = (s) => (s || 'design').replace(/[^\w\- .]+/g, '_').trim() || 'design';
		const baseOf = (fname) => fname.replace(/\.(qcad|lcad)\.json$|\.json$|\.(qcad|lcad)$/i, '');
		this.saveVersion('', { auto: true }); // every save keeps a version when something changed
		if (window.showSaveFilePicker) {
			try {
				let h = saveAs ? null : this.fileHandle;
				if (h && h.queryPermission && (await h.queryPermission({ mode: 'readwrite' })) !== 'granted') {
					if ((await h.requestPermission({ mode: 'readwrite' })) !== 'granted') h = null;
				}
				if (!h) {
					h = await window.showSaveFilePicker({
						suggestedName: safe(this.model.doc.name) + '.lcad.json',
						types: [{ description: 'DraftOtter design', accept: { 'application/json': ['.json'] } }],
					});
					const base = baseOf(h.name);
					if (base && base !== this.model.doc.name) { this.model.doc.name = base; this.model.snapshot(); $('#project-name').value = base; }
				}
				const w = await h.createWritable();
				await w.write(this.model.serialize());
				await w.close();
				this.setFileHandle(h);
				this.markSaved(h.name);
				toast('Saved to ' + h.name, 'ok');
				return;
			} catch (e) {
				if (e && e.name === 'AbortError') return; // user canceled the dialog
				console.warn('File System Access save failed, downloading instead', e);
			}
		}
		const finish = (name) => {
			const fname = safe(name) + '.lcad.json';
			download(this.model.serialize(), fname, 'application/json');
			this.markSaved(fname);
			toast('Downloaded ' + fname + ' (check your Downloads folder)', 'ok', 3500);
		};
		if (!saveAs && this.savedSig) { finish(this.model.doc.name); return; }
		const inp = el('input', { id: 'saveas-name', type: 'text', value: this.model.doc.name || 'Untitled' });
		this.modal('Save as', el('div', { class: 'form' },
			el('label', { class: 'row' }, el('span', {}, 'File name'), inp),
			el('p', { class: 'muted small' }, 'Saved as a .lcad.json file to your Downloads folder. Open it later with Open (Ctrl+O).')), [{ label: 'Cancel' }, {
			label: 'Save', primary: true, action: () => {
				const name = inp.value.trim() || 'Untitled';
				if (name !== this.model.doc.name) { this.model.doc.name = name; this.model.snapshot(); this.refreshUI(); }
				finish(name);
			},
		}]);
	}

	async openProject(file, fileHandle = null) {
		let handle = fileHandle;
		if (!file && window.showOpenFilePicker) {
			try {
				[handle] = await window.showOpenFilePicker({ types: [{ description: 'DraftOtter design', accept: { 'application/json': ['.json', '.lcad', '.qcad'] } }] });
				file = await handle.getFile();
			} catch (e) {
				if (e && e.name === 'AbortError') return;
				handle = null;
			}
		}
		if (!file) {
			[file] = await pickFile('.json,.lcad,.lcad.json,.qcad,.qcad.json');
			if (!file) return;
		}
		try {
			const data = JSON.parse(await readFile(file, true));
			if (data.format !== 'draftotter' && data.format !== 'localcad') throw new Error('Not a DraftOtter design file');
			// opens in a new tab, unless this one is an empty, untouched design
			if (this.tabs && !this.tabIsBlank() && !(await this.newTab())) return;
			this.model.load(data.doc, data.blobs);
			this.sel = [];
			await this.prebuild(this.loadingScreen('Opening ' + file.name, true));
			this.setFileHandle(handle);
			this.savedSig = this.designSig();
			this.fileName = file.name;
			this.vp.buildBed(this.model.settings);
			this.vp.setSnap(this.model.settings);
			this.syncSnapSelect();
			this.afterChange();
			this.vp.frameBox(this.sceneBox());
			this.autosave();
			toast('Opened ' + file.name, 'ok');
		} catch (e) {
			toast('Could not open file: ' + e.message, 'error', 5000);
		}
	}

	/** Import STEP / IGES / BREP files: every body becomes a mesh part, keeping names, colors and layout. */
	async importCAD(files) {
		if (!files) files = await pickFile('.step,.stp,.iges,.igs,.brep,.brp', true);
		for (const file of files || []) {
			const busy = toast(`Reading ${file.name}…${this.occtLoaded ? '' : ' (starting the STEP reader the first time takes a few seconds)'}`, 'info', 60000);
			try {
				await new Promise((r) => setTimeout(r, 30));
				const bodies = await readCADFile(file.name, new Uint8Array(await readFile(file)));
				this.occtLoaded = true;
				if (!bodies.length) throw new Error('No solid bodies found');
				this.addImportedBodies(file.name, bodies);
				if (busy && busy.remove) busy.remove();
				const tris = bodies.reduce((s, b) => s + b.positions.length / 9, 0);
				toast(`Imported ${file.name} — ${bodies.length} bod${bodies.length > 1 ? 'ies' : 'y'}, ${Math.round(tris).toLocaleString()} triangles`, 'ok', 4000);
			} catch (e) {
				console.error(e);
				if (busy && busy.remove) busy.remove();
				toast(`Could not import ${file.name}: ${e.message}`, 'error', 6000);
			}
		}
	}

	/** 3MF files (models and slicer projects): one part per printed object, with names, colors and plate layout. */
	async import3MF(files) {
		if (!files) files = await pickFile('.3mf', true);
		for (const file of files || []) {
			try {
				const { parts } = await parse3MF(await readFile(file));
				if (!parts.length) throw new Error('no objects with triangles in it');
				this.addImportedBodies(file.name, parts, true);
				const tris = parts.reduce((n, p) => n + p.positions.length / 9, 0);
				toast(`Imported ${file.name} — ${parts.length} part${parts.length > 1 ? 's' : ''}, ${Math.round(tris).toLocaleString()} triangles`, 'ok', 4000);
			} catch (e) {
				toast(`Could not import ${file.name}: ${e.message}`, 'error', 6000);
			}
		}
	}

	/** Bodies keep their relative positions; the whole set is set on the bed at a free spot. */
	addImportedBodies(fileName, bodies, ownNames = false) {
		const box = new THREE.Box3();
		for (const b of bodies) { const p = b.positions; for (let i = 0; i < p.length; i += 3) box.expandByPoint(new THREE.Vector3(p[i], p[i + 1], p[i + 2])); }
		const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
		const spot = this.freeSpot(size);
		const base = fileName.replace(/\.[^.]+$/, '');
		const ids = [];
		for (const b of bodies) {
			// center each body's own mesh, and place it where it was relative to the others
			const p = b.positions, bb = new THREE.Box3();
			for (let i = 0; i < p.length; i += 3) bb.expandByPoint(new THREE.Vector3(p[i], p[i + 1], p[i + 2]));
			const bc = bb.getCenter(new THREE.Vector3());
			const local = new Float32Array(p.length);
			for (let i = 0; i < p.length; i += 3) { local[i] = p[i] - bc.x; local[i + 1] = p[i + 1] - bc.y; local[i + 2] = p[i + 2] - bc.z; }
			const node = makeNode('mesh', { blob: storeBody(this.model, local) }, { name: bodies.length === 1 && !(ownNames && b.name && !/^Part d+$/.test(b.name)) ? base : b.name, ...(b.color ? { color: b.color } : {}) });
			node.pos = [round(spot.x + bc.x - c.x), round(spot.y + bc.y - c.y), round(bc.z - box.min.z)];
			this.model.nodes.push(node);
			ids.push(node.id);
		}
		this.sel = ids;
		this.commit();
		this.frame();
	}

	async importSTL(files, at) {
		if (!files) files = await pickFile('.stl', true);
		for (const file of files) {
			try {
				const { positions, size, tris } = parseSTL(await readFile(file));
				if (!tris) throw new Error('No triangles found');
				const b64 = f32ToBase64(positions);
				const h = hashString(b64);
				this.model.blobs[h] = b64;
				const node = makeNode('mesh', { blob: h }, { name: file.name.replace(/\.stl$/i, '') });
				this.addNode(node, at);
				toast(`Imported ${file.name} — ${tris.toLocaleString()} triangles, ${fmt(size.x, 1)}×${fmt(size.y, 1)}×${fmt(size.z, 1)} mm`, 'ok', 4000);
			} catch (e) {
				toast('STL import failed: ' + e.message, 'error', 5000);
			}
		}
	}

	exportDialog(format = this.lastExportFormat || 'stl') {
		const visible = this.model.nodes.filter((n) => n.visible);
		if (!visible.some((n) => !n.hole)) { toast('Nothing to export — add some solid shapes first', 'warn'); return; }
		const hasSel = this.sel.length > 0;
		const name = (this.model.doc.name || 'design').replace(/[^\w\- ]+/g, '_');
		const form = el('div', { class: 'form' },
			el('label', { class: 'row' }, el('span', {}, 'File name'), el('input', { id: 'ex-name', type: 'text', value: name })),
			el('label', { class: 'row' }, el('span', {}, 'Export'), el('select', { id: 'ex-scope' },
				el('option', { value: 'all' }, 'All visible objects'),
				hasSel ? el('option', { value: 'sel', selected: true }, `Selected objects (${this.sel.length})`) : null,
				el('option', { value: 'each' }, 'Each object as a separate file'),
				(this.model.doc.configs || []).length ? el('option', { value: 'configs' }, `Every configuration (${this.model.doc.configs.length} files in a .zip)`) : null)),
			el('label', { class: 'check' }, el('input', { id: 'ex-merge', type: 'checkbox', checked: true }), el('span', {}, 'Merge into one watertight solid (unions overlaps, cuts loose holes)')),
			el('label', { class: 'row' }, el('span', {}, 'Format'), el('select', { id: 'ex-format' },
				el('option', { value: 'stl' }, 'STL — for 3D printing / slicers'),
				el('option', { value: '3mf' }, '3MF — slicers, keeps part names & colors (multi-material)'),
				el('option', { value: 'step' }, 'STEP (.step) — for other CAD software'),
				el('option', { value: 'stl-ascii' }, 'STL, ASCII text (larger)'))),
			el('p', { class: 'muted small', id: 'ex-note' }),
		);
		const fmtSel = form.querySelector('#ex-format');
		const note = form.querySelector('#ex-note');
		const syncNote = () => {
			note.textContent = fmtSel.value === '3mf'
				? 'One file with every part as its own object, named and colored, in millimeters — slicers (Bambu Studio, PrusaSlicer, Cura, OrcaSlicer) can assign a filament per part. With “Merge” on, loose holes are cut from the parts they overlap.'
				: fmtSel.value === 'step'
				? 'STEP solids open in Fusion, SolidWorks, Onshape, FreeCAD and others. Flat faces and cylinders (holes, pins, tubes, slots, round edges) come through as true faces you can measure and fillet there; other curved surfaces are exported as fine flat facets. Units: millimeters, Z up.'
				: 'Units: millimeters. Z is up. Objects are exported at their positions on the bed.';
		};
		fmtSel.value = format;
		fmtSel.addEventListener('change', syncNote);
		syncNote();
		this.modal('Export', form, [
			{ label: 'Cancel' },
			{
				label: 'Export', primary: true, action: () => {
					const fname = ($('#ex-name').value || name).replace(/\.(stl|step|stp|3mf)$/i, '');
					const scope = $('#ex-scope').value;
					const merge = $('#ex-merge').checked, fmt = $('#ex-format').value;
					this.lastExportFormat = fmt;
					const nodes = scope === 'sel' ? this.selectedNodes().map((n) => this.model.topLevelOf(n.id)).filter((n, i, a) => a.indexOf(n) === i) : visible;
					if (scope === 'configs') { setTimeout(() => this.exportAllConfigs(visible, fname, merge, fmt), 30); return; }
					setTimeout(() => this.doExport(nodes, fname, merge, fmt, scope === 'each'), 30);
				},
			},
		]);
	}

	doExport(nodes, fname, merge, format = 'stl', each = false) {
		if (format === true) format = 'stl-ascii';
		if (format === false) format = 'stl';
		const t0 = performance.now();
		const ext = format === 'step' ? 'step' : format === '3mf' ? '3mf' : 'stl';
		if (format === '3mf') return this.export3MF(nodes, fname, merge, each, t0);
		const write = (geom, fn) => {
			if (!geom || !geom.attributes.position.count) return false;
			if (format === 'step') {
				const flat = geom.index ? geom.toNonIndexed() : geom;
				download(stepFromPositions(flat.attributes.position.array, fn).text, fn + '.step', 'model/step');
			} else download(format === 'stl-ascii' ? stlAscii(geom, fn) : stlBinary(geom), fn + '.stl', format === 'stl-ascii' ? 'text/plain' : 'model/stl');
			return true;
		};
		try {
			if (each) {
				let k = 0;
				const used = new Set();
				for (const n of nodes.filter((n) => !n.hole)) {
					let fn = (fname + '_' + (n.name || n.type)).replace(/[^\w\- ]+/g, '_');
					while (used.has(fn)) fn += '_';
					used.add(fn);
					if (write(this.engine.printable([n], merge), fn)) k++;
				}
				toast(`Exported ${k} ${ext.toUpperCase()} files`, 'ok');
				return;
			}
			const g = this.engine.printable(nodes, merge);
			if (!write(g, fname)) { toast('Export produced an empty mesh', 'error'); return; }
			toast(`Exported ${fname}.${ext} — ${(g.attributes.position.count / 3).toLocaleString()} triangles (${Math.round(performance.now() - t0)} ms)`, 'ok', 4000);
		} catch (e) {
			console.error(e);
			toast('Export failed: ' + e.message, 'error', 5000);
		}
	}

	/** Paint colors per triangle of an exported mesh of top-level part n (world positions), or null when unpainted. */
	paintColorsFor(n, positions) {
		if (!effectivePaint(n).length) return null;
		const g = this.engine.geometry(n);
		if (!g || !g.attributes.position) return null;
		return exportColors(g, n, positions, this.worldMatrix(n).clone().invert());
	}

	/** One file per configuration, bundled into a zip. */
	exportAllConfigs(nodes, fname, merge, format) {
		const t0 = performance.now();
		try {
			const files = this.exportConfigurations(nodes, fname, merge, format, (ns) => {
				if (format === '3mf') {
					const holes = merge ? ns.filter((n) => n.hole) : [];
					const parts = ns.filter((n) => !n.hole).map((n) => { const g = this.engine.printable([n, ...holes], merge); if (!g) return null; const f = g.index ? g.toNonIndexed() : g; return { name: n.name || n.type, color: n.color, positions: f.attributes.position.array, triColors: this.paintColorsFor(n, f.attributes.position.array) }; }).filter(Boolean);
					return parts.length ? { ext: '.3mf', data: build3MF(parts) } : null;
				}
				const g = this.engine.printable(ns, merge);
				if (!g || !g.attributes.position.count) return null;
				const flat = g.index ? g.toNonIndexed() : g;
				if (format === 'step') return { ext: '.step', data: stepFromPositions(flat.attributes.position.array, fname).text };
				return { ext: '.stl', data: format === 'stl-ascii' ? stlAscii(g, fname) : stlBinary(g) };
			});
			if (!files.length) { toast('Export produced no files', 'error'); return; }
			download(makeZip(files), fname + '_configurations.zip', 'application/zip');
			toast(`Exported ${files.length} configurations (${Math.round(performance.now() - t0)} ms)`, 'ok', 4000);
		} catch (e) {
			console.error(e);
			toast('Export failed: ' + e.message, 'error', 5000);
		}
	}

	/** 3MF: every top-level solid is its own named, colored object; loose holes cut the parts they overlap (merge). */
	export3MF(nodes, fname, merge, each, t0 = performance.now()) {
		try {
			const solids = nodes.filter((n) => !n.hole), holes = merge ? nodes.filter((n) => n.hole) : [];
			const partOf = (n) => {
				const g = this.engine.printable([n, ...holes], merge);
				if (!g || !g.attributes.position.count) return null;
				const flat = g.index ? g.toNonIndexed() : g;
				return { name: n.name || n.type, color: n.color, positions: flat.attributes.position.array, triColors: this.paintColorsFor(n, flat.attributes.position.array) };
			};
			if (each) {
				let k = 0;
				const used = new Set();
				for (const n of solids) {
					const part = partOf(n);
					if (!part) continue;
					let fn = (fname + '_' + part.name).replace(/[^\w\- ]+/g, '_');
					while (used.has(fn)) fn += '_';
					used.add(fn);
					download(build3MF([part], { title: part.name }), fn + '.3mf', 'model/3mf');
					k++;
				}
				toast(`Exported ${k} 3MF files`, 'ok');
				return;
			}
			const parts = solids.map(partOf).filter(Boolean);
			if (!parts.length) { toast('Export produced an empty mesh', 'error'); return; }
			download(build3MF(parts, { title: this.model.doc.name || fname }), fname + '.3mf', 'model/3mf');
			toast(`Exported ${fname}.3mf — ${parts.length} part${parts.length > 1 ? 's' : ''} (${Math.round(performance.now() - t0)} ms)`, 'ok', 4000);
		} catch (e) {
			console.error(e);
			toast('Export failed: ' + e.message, 'error', 5000);
		}
	}

	// ============================================================ dialogs

	modal(title, body, buttons = [{ label: 'Close' }], cls = '', opts = {}) {
		const back = el('div', { class: 'modal-back' });
		let closed = false;
		const close = () => { if (closed) return; closed = true; back.remove(); window.removeEventListener('keydown', onKey, true); if (opts.onClose) opts.onClose(); };
		const onKey = (e) => {
			if (e.key === 'Escape') { close(); e.stopPropagation(); }
			if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
				const p = buttons.find((b) => b.primary);
				if (p) { e.preventDefault(); e.stopPropagation(); if (p.action && p.action() === false) return; close(); }
			}
		};
		const box = el('div', { class: 'modal ' + cls },
			el('div', { class: 'modal-head' }, el('h3', {}, title), el('button', { class: 'icon-btn', title: 'Close', onclick: close, html: icon('x') })),
			el('div', { class: 'modal-body' }, body),
			el('div', { class: 'modal-foot' }, ...buttons.map((b) => el('button', {
				class: 'btn ' + (b.primary ? 'primary' : ''), onclick: () => { if (b.action && b.action() === false) return; close(); },
			}, b.label))));
		back.appendChild(box);
		back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });
		document.body.appendChild(back);
		window.addEventListener('keydown', onKey, true);
		const first = box.querySelector('input, select');
		if (first) setTimeout(() => first.focus(), 30);
		return close;
	}

	arrayDialog(initialType = 'linear') {
		const nodes = this.selectedNodes().filter((n) => !n.locked);
		if (!nodes.length) { toast('Select objects to pattern', 'warn'); return; }
		// paths: one drawn for patterns (kept until the next one is drawn), or any sketch in the design
		const selIds = new Set(nodes.map((n) => n.id));
		const sketches = [];
		const walk = (list) => { for (const n of list) { if (n.type === 'sketch' && !selIds.has(n.id)) sketches.push(n); if (n.children) walk(n.children); } };
		walk(this.model.nodes);
		const pathSel = el('select', { id: 'ar-path' },
			this.patternPath ? el('option', { value: 'drawn' }, `Drawn path (${fmt(this.pathLength(this.patternPath), 1)} mm)`) : null,
			...sketches.map((n) => el('option', { value: n.id }, `${n.name || 'Sketch'} (${fmt(this.pathLength(n.params), 1)} mm)`)));
		let close = null;
		const drawPath = async () => {
			if (close) close();
			const res = await openSketchEditor({ ...makeNode('sketch').params, isNew: true }, this.sketchOpts({ isNew: true, path: true }));
			if (res) this.patternPath = res;
			this.arrayDialog('path');
		};
		const box = this.vp.selectionBox();
		const size = box.getSize(new THREE.Vector3());
		const c = box.getCenter(new THREE.Vector3());
		const parent = this.model.parentOf(nodes[0].id);
		const pc = parent ? this.worldBox(parent).getCenter(new THREE.Vector3()) : null; // a feature: pattern around its part
		const inp = (id, v) => el('input', { id, type: 'text', value: v });
		const form = el('div', { class: 'form' },
			el('div', { class: 'seg' },
				el('label', {}, el('input', { type: 'radio', name: 'ar-type', value: 'linear', checked: true }), el('span', {}, 'Linear')),
				el('label', {}, el('input', { type: 'radio', name: 'ar-type', value: 'circular' }), el('span', {}, 'Circular')),
				el('label', {}, el('input', { type: 'radio', name: 'ar-type', value: 'grid' }), el('span', {}, 'Grid')),
				el('label', {}, el('input', { type: 'radio', name: 'ar-type', value: 'path' }), el('span', {}, 'Along a path'))),
			el('label', { class: 'row' }, el('span', {}, 'Count'), inp('ar-n', 5)),
			el('div', { class: 'ar-path', style: 'display:none' },
				el('label', { class: 'row' }, el('span', {}, 'Path'), pathSel.options.length ? pathSel : el('span', { class: 'muted small' }, 'No path yet — draw one')),
				el('div', { class: 'row' }, el('span', {}, ''), el('button', { class: 'btn sm', id: 'ar-draw', onclick: drawPath }, this.patternPath ? 'Draw a new path…' : 'Draw a path…')),
				el('label', { class: 'check' }, el('input', { id: 'ar-follow', type: 'checkbox', checked: true }), el('span', {}, 'Turn copies to follow the path')),
				el('label', { class: 'check' }, el('input', { id: 'ar-atobj', type: 'checkbox', checked: true }), el('span', {}, 'Start the path at the selected object (otherwise it moves to the path\'s start)')),
				el('p', { class: 'muted small' }, 'Copies are spread evenly from the start of the path to its end, or all the way round a closed one. Any sketch in the design can be the path — its longest line, arc, spline or circle.')),
			el('div', { class: 'ar-linear' },
				el('label', { class: 'row' }, el('span', {}, 'Spacing X'), inp('ar-dx', round(size.x + 5, 2))),
				el('label', { class: 'row' }, el('span', {}, 'Spacing Y'), inp('ar-dy', 0)),
				el('label', { class: 'row' }, el('span', {}, 'Spacing Z'), inp('ar-dz', 0))),
			el('div', { class: 'ar-grid', style: 'display:none' },
				el('label', { class: 'row' }, el('span', {}, 'Rows (Y)'), inp('ar-rows', 3)),
				el('label', { class: 'row' }, el('span', {}, 'Spacing X'), inp('ar-gx', round(size.x + 5, 2))),
				el('label', { class: 'row' }, el('span', {}, 'Spacing Y'), inp('ar-gy', round(size.y + 5, 2)))),
			el('div', { class: 'ar-circular', style: 'display:none' },
				el('label', { class: 'row' }, el('span', {}, 'Total angle °'), inp('ar-angle', 360)),
				el('label', { class: 'row' }, el('span', {}, 'Center X'), inp('ar-cx', round(pc ? pc.x : c.x - Math.max(size.x, 10) * 1.5, 2))),
				el('label', { class: 'row' }, el('span', {}, 'Center Y'), inp('ar-cy', round(pc ? pc.y : c.y, 2))),
				el('label', { class: 'check' }, el('input', { id: 'ar-rot', type: 'checkbox', checked: true }), el('span', {}, 'Rotate copies'))),
			el('label', { class: 'check' }, el('input', { id: 'ar-group', type: 'checkbox' }), el('span', {}, 'Group all copies into one object')),
		);
		form.addEventListener('change', () => {
			const t = form.querySelector('input[name=ar-type]:checked').value;
			form.querySelector('.ar-linear').style.display = t === 'linear' ? '' : 'none';
			form.querySelector('.ar-circular').style.display = t === 'circular' ? '' : 'none';
			form.querySelector('.ar-grid').style.display = t === 'grid' ? '' : 'none';
			form.querySelector('.ar-path').style.display = t === 'path' ? '' : 'none';
			// inside this form (the dialog may already be closed when this runs)
			form.querySelector('#ar-n').closest('label').querySelector('span').textContent = t === 'grid' ? 'Columns (X)' : 'Count';
		});
		const typeRadio = form.querySelector(`input[name=ar-type][value=${initialType}]`);
		if (typeRadio) { typeRadio.checked = true; setTimeout(() => form.dispatchEvent(new Event('change')), 0); }
		close = this.modal('Pattern / Array', form, [{ label: 'Cancel' }, {
			label: 'Create', primary: true, action: () => {
				const v = (id) => evalExpr($('#' + id).value);
				const t = form.querySelector('input[name=ar-type]:checked').value;
				const n = Math.max(1, Math.round(v('ar-n')));
				const mats = [];
				let moveFirst = null;
				if (t === 'linear') {
					for (let i = 1; i < n; i++) mats.push(new THREE.Matrix4().makeTranslation(v('ar-dx') * i, v('ar-dy') * i, v('ar-dz') * i));
				} else if (t === 'grid') {
					const rows = Math.max(1, Math.round(v('ar-rows')));
					for (let j = 0; j < rows; j++) for (let i = 0; i < n; i++) if (i || j) mats.push(new THREE.Matrix4().makeTranslation(v('ar-gx') * i, v('ar-gy') * j, 0));
				} else if (t === 'path') {
					const which = $('#ar-path') && $('#ar-path').value;
					const src = which === 'drawn' ? { params: this.patternPath, M: null } : (() => { const n = sketches.find((k) => k.id === which); return n ? { params: n.params, node: n } : null; })();
					const path = src && this.pathWorld(src.params, src.node, c.z);
					if (!path) { toast('Draw a path first (or pick a sketch)', 'warn'); return false; }
					const mm = this.pathMatrices(path, n, c, $('#ar-follow').checked, $('#ar-atobj').checked);
					// copies are placed from where the originals are now; the originals move onto the path's start last
					moveFirst = mm.first;
					mats.push(...mm.copies.map((M) => (mm.first ? M.clone().multiply(mm.first) : M)));
				} else {
					const total = v('ar-angle');
					const step = Math.abs(total) >= 360 ? total / n : total / Math.max(1, n - 1);
					const cx = v('ar-cx'), cy = v('ar-cy');
					const rot = $('#ar-rot').checked;
					for (let i = 1; i < n; i++) {
						const a = step * i * DEG;
						if (rot) mats.push(new THREE.Matrix4().makeTranslation(cx, cy, 0).multiply(new THREE.Matrix4().makeRotationZ(a)).multiply(new THREE.Matrix4().makeTranslation(-cx, -cy, 0)));
						else {
							const p = new THREE.Vector3(c.x - cx, c.y - cy, 0).applyAxisAngle(new THREE.Vector3(0, 0, 1), a);
							mats.push(new THREE.Matrix4().makeTranslation(cx + p.x - c.x, cy + p.y - c.y, 0));
						}
					}
				}
				if (mats.some((m) => m.elements.some((x) => !isFinite(x)))) { toast('Invalid pattern values', 'error'); return false; }
				const created = [];
				for (const node of nodes) {
					const f = this.model.find(node.id);
					const W = this.worldMatrix(node);
					let at = f.list.indexOf(node) + 1;
					for (const M of mats) {
						const copy = cloneWithNewIds(node);
						f.list.splice(at++, 0, copy);
						this.vp.objs.set(copy.id, this.vp.objs.get(node.id)); // same parent frame
						this.setWorldMatrix(copy, M.clone().multiply(W));
						this.vp.objs.delete(copy.id);
						created.push(copy.id);
					}
				}
				if (moveFirst) for (const node of nodes) this.setWorldMatrix(node, moveFirst.clone().multiply(this.worldMatrix(node)));
				this.sel = [...nodes.map((n) => n.id), ...created];
				if ($('#ar-group').checked) {
					this.commit();
					this.group('union');
				} else this.commit();
				toast(`Created ${created.length} copies`, 'ok');
			},
		}]);
	}

	/** Length of a sketch's longest curve (mm). */
	pathLength(params) {
		const p = sketchPaths(params)[0];
		return p ? p.length : 0;
	}

	/**
	 * A sketch's longest curve in world space: { pts: [Vector3], closed, normal } — from a sketch in the design (placed
	 * like its shape), or a drawn path laid flat at height z.
	 */
	pathWorld(params, node, z = 0) {
		const p = params && sketchPaths(params)[0];
		if (!p || p.pts.length < 2) return null;
		let M, off = [0, 0, 0];
		if (node) {
			M = this.worldMatrix(node);
			// a sketch that isn't anchored is centered on its shape: the same shift puts the curve on the shape's base
			if (!node.params.anchored) {
				const regions = profileRegions(node.params);
				if (regions.length) {
					let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
					for (const r of regions) for (const [x, y] of r.outer) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
					off = [-(x0 + x1) / 2, -(y0 + y1) / 2, node.params.mode === 'revolve' ? 0 : -(node.params.height || 0) / 2];
				}
			}
		} else M = new THREE.Matrix4().makeTranslation(0, 0, z);
		const pts = p.pts.map(([x, y]) => new THREE.Vector3(x + off[0], y + off[1], off[2]).applyMatrix4(M));
		const normal = new THREE.Vector3(0, 0, 1).transformDirection(M);
		return { pts, closed: p.closed, normal };
	}

	/**
	 * Placements for n items along a world path, for objects whose middle is c: { first (moves the originals onto the
	 * path's start, or null when the path starts at them), copies: [Matrix4] for items 2…n }.
	 */
	pathMatrices(path, n, c, follow, atObject) {
		const P = path.pts, cum = [0];
		for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + P[i].distanceTo(P[i - 1]));
		const L = cum[cum.length - 1];
		const at = (s) => {
			let i = 1;
			while (i < P.length - 1 && cum[i] < s) i++;
			const seg = cum[i] - cum[i - 1] || 1;
			const t = Math.max(0, Math.min(1, (s - cum[i - 1]) / seg));
			const tan = P[i].clone().sub(P[i - 1]).normalize();
			return { p: P[i - 1].clone().lerp(P[i], t), tan };
		};
		const start = at(0);
		const shift = atObject ? c.clone().sub(start.p) : new THREE.Vector3();
		const B = start.p.clone().add(shift);
		const first = atObject ? null : new THREE.Matrix4().makeTranslation(B.x - c.x, B.y - c.y, B.z - c.z);
		const copies = [];
		const steps = path.closed ? n : Math.max(1, n - 1);
		for (let i = 1; i < n; i++) {
			const q = at((L * i) / steps), Q = q.p.clone().add(shift);
			let M = new THREE.Matrix4().makeTranslation(Q.x, Q.y, Q.z);
			if (follow) {
				const ang = Math.atan2(path.normal.dot(start.tan.clone().cross(q.tan)), start.tan.dot(q.tan));
				M.multiply(new THREE.Matrix4().makeRotationAxis(path.normal, ang));
			}
			M.multiply(new THREE.Matrix4().makeTranslation(-B.x, -B.y, -B.z));
			copies.push(M);
		}
		return { first, copies };
	}

	settingsDialog() {
		const s = this.model.settings;
		const inp = (id, v) => el('input', { id, type: 'text', value: v });
		const printerSel = el('select', { id: 'set-printer' }, ...Object.keys(PRINTERS).map((k) => el('option', { value: k }, k)));
		// printers with the same build volume (H2D / H2C) are told apart by the name chosen last
		const fits = ([, v]) => v && v[0] === s.bed.w && v[1] === s.bed.d && v[2] === s.bed.h;
		const match = (s.bed.printer && PRINTERS[s.bed.printer] && fits([0, PRINTERS[s.bed.printer]]) && [s.bed.printer]) || Object.entries(PRINTERS).find(fits);
		printerSel.value = match ? match[0] : 'Custom';
		printerSel.addEventListener('change', () => {
			const v = PRINTERS[printerSel.value];
			if (v) { $('#set-bw').value = v[0]; $('#set-bd').value = v[1]; $('#set-bh').value = v[2]; }
		});
		const form = el('div', { class: 'form two' },
			el('h4', {}, 'Printer'),
			el('label', { class: 'row' }, el('span', {}, 'Preset'), printerSel),
			el('label', { class: 'row' }, el('span', {}, 'Bed width X (mm)'), inp('set-bw', s.bed.w)),
			el('label', { class: 'row' }, el('span', {}, 'Bed depth Y (mm)'), inp('set-bd', s.bed.d)),
			el('label', { class: 'row' }, el('span', {}, 'Max height Z (mm)'), inp('set-bh', s.bed.h)),
			el('label', { class: 'check' }, el('input', { id: 'set-vol', type: 'checkbox', checked: s.showBuildVolume }), el('span', {}, 'Show build volume')),
			el('h4', {}, 'Grid & snapping'),
			el('label', { class: 'row' }, el('span', {}, 'Grid spacing (mm)'), inp('set-grid', s.grid)),
			el('label', { class: 'row' }, el('span', {}, 'Move snap (mm, 0 = off)'), inp('set-snap', s.snap)),
			el('label', { class: 'row' }, el('span', {}, 'Rotate snap (°, 0 = off)'), inp('set-rsnap', s.rotSnap)),
			el('h4', {}, 'Display'),
			el('label', { class: 'row' }, el('span', {}, 'Background color'), el('div', { class: 'chips' },
				el('input', { id: 'set-bg', type: 'color', value: s.bgColor || '#141a22', title: 'Background of the 3D view' }),
				...[['#141a22', 'Dark (default)'], ['#2b2f36', 'Graphite'], ['#e9edf2', 'Light'], ['#ffffff', 'White'], ['#000000', 'Black']].map(([c, t]) => el('button', { type: 'button', class: 'swatch', title: t, style: `background:${c}`, onclick: () => { const i = $('#set-bg'); i.value = c; i.dispatchEvent(new Event('input')); } })))),
			el('label', { class: 'check' }, el('input', { id: 'set-bed', type: 'checkbox', checked: s.showBed !== false }), el('span', {}, 'Show print bed (plate and grid)')),
			el('label', { class: 'check' }, el('input', { id: 'set-edges', type: 'checkbox', checked: s.showEdges }), el('span', {}, 'Show edge lines')),
			el('label', { class: 'row' }, el('span', {}, 'Overhang warning angle (°)'), inp('set-oh', s.overhangAngle)),
			el('h4', {}, 'Printer fit calibration'),
			el('label', { class: 'row' }, el('span', {}, 'Hole compensation Ø (mm)'), inp('set-hcomp', s.holeComp || 0)),
			el('p', { class: 'muted small' }, 'Added to every hole that has a Fit. Print Tools → Fit test print; if every hole is tight, raise this (e.g. 0.1).'),
			el('h4', {}, 'Material (for print estimates)'),
			el('label', { class: 'row' }, el('span', {}, 'Density (g/cm³)'), el('select', { id: 'set-dens-p' }, ...[['', 'Custom'], ['1.24', 'PLA 1.24'], ['1.27', 'PETG 1.27'], ['1.04', 'ABS 1.04'], ['1.07', 'ASA 1.07'], ['1.21', 'TPU 1.21'], ['1.14', 'Nylon 1.14']].map(([v, l]) => el('option', { value: v }, l)))),
			el('label', { class: 'row' }, el('span', {}, ''), inp('set-dens', s.density)),
			el('label', { class: 'row' }, el('span', {}, 'Filament diameter (mm)'), inp('set-fil', s.filament)),
		);
		form.querySelector('#set-dens-p').addEventListener('change', (e) => { if (e.target.value) $('#set-dens').value = e.target.value; });
		// preview the background and the bed right away (Cancel puts them back)
		const preview = () => { this.vp.buildBed({ ...s, bgColor: form.querySelector('#set-bg').value, showBed: form.querySelector('#set-bed').checked }); };
		form.querySelector('#set-bg').addEventListener('input', preview);
		form.querySelector('#set-bed').addEventListener('change', preview);
		this.modal('Settings', form, [{ label: 'Cancel' }, {
			label: 'Save', primary: true, action: () => {
				const v = (id, def) => { const x = evalExpr($('#' + id).value); return isFinite(x) ? x : def; };
				s.bed = { w: Math.max(10, v('set-bw', s.bed.w)), d: Math.max(10, v('set-bd', s.bed.d)), h: Math.max(10, v('set-bh', s.bed.h)), printer: $('#set-printer').value };
				s.showBuildVolume = $('#set-vol').checked;
				s.bgColor = $('#set-bg').value;
				s.showBed = $('#set-bed').checked;
				s.grid = Math.max(0.5, v('set-grid', s.grid));
				s.snap = Math.max(0, v('set-snap', s.snap));
				s.rotSnap = Math.max(0, v('set-rsnap', s.rotSnap));
				s.showEdges = $('#set-edges').checked;
				s.overhangAngle = Math.min(89, Math.max(1, v('set-oh', s.overhangAngle)));
				s.holeComp = Math.max(-1, Math.min(2, v('set-hcomp', s.holeComp || 0)));
				s.density = Math.max(0.01, v('set-dens', s.density));
				s.filament = Math.max(0.1, v('set-fil', s.filament));
				this.vp.buildBed(s);
				this.vp.setSnap(s);
				this.syncSnapSelect();
				this.afterChange();
				this.autosave();
			},
		}], '', { onClose: () => this.vp.buildBed(this.model.settings) });
	}

	helpDialog() {
		const rows = [
			['Mouse', ''],
			['Right-drag', 'Rotate (orbit) the view'], ['Middle (wheel) drag', 'Pan'], ['Wheel', 'Zoom to cursor'],
			['Click object', 'Select (Shift/Ctrl = add)'], ['Drag object', 'Move on the workplane; snaps to the grid and lines up with nearby objects (Alt = no snapping)'],
			['Left-drag empty space', 'Box select (Shift: add to selection)'], ['Right-click object', 'Object menu'], ['Double-click group', 'Edit a part inside the group'], ['Click the same spot again', 'Select the next object behind'], ['Alt + click', 'List every object under the cursor (incl. parts inside groups)'], ['Double-click empty', 'Fit view'],
			['Keyboard', ''],
			['W / E / R', 'Move / Rotate / Scale handles'], ['Q', 'Hide handles'],
			['Scale handles', 'Drag a face to move just that side; corners resize X+Y. Sizes snap (Shift: proportional, Alt: free)'],
			['Rotate rings', 'Drag on a ring for 15° steps (the rotate snap); move the pointer outside the ring, or hold Shift, for 1° steps (Alt: free)'],
			['Dimension labels', 'Click a size label in the view to type an exact size (Tab moves to the next)'],
			['Arrows', 'Nudge relative to the view (snapped to the nearest bed axis) by the snap value (Shift ×10, Alt ×0.1)'],
			['Ctrl + ↑ / ↓  (or PgUp/PgDn)', 'Nudge Z up / down (Shift ×10, Alt ×0.1)'],
			['Ctrl + ← / →', 'Rotate about Z by the rotate snap (Shift: 90°)'],
			['[ / ]', 'Rotate selection −/+ 90° about Z (Shift: X, Alt: Y)'],
			['Ctrl+G · Ctrl+Shift+G', 'Group (union / cut holes) · Ungroup'], ['Ctrl+[ · Ctrl+]', 'Collapse / expand the left · right panel (or click « »)'], ['Ctrl+I', 'Intersect selection'],
			['Toolbar menus', 'Combine (intersect, hull) · Arrange (space evenly, pattern, mirror, place, workplane) · Modify (sketch on face, shell, offset, split, wrap) · Inspect (print check, interference, section, overhangs, drawing) · Assemble (mates, joints) · More (DXF/SVG, fit test, templates, versions)'],
			['File → Versions', 'Saved versions: compare (ghost overlay) and restore'],
			['Timeline tab', 'Every step in order: untick to suppress, ⤒ to roll back'], ['File → Import STEP / IGES', 'Parts and assemblies from other CAD tools'], ['Modify → Hole Wizard', 'Standard ISO / ANSI holes: click points on flat faces'], ['Inspect → Stress check', 'Pick held and pushed faces, set the force: stress colors, deflection, safety factor'], ['Sketch tools', 'Slot (W), Spline, Trim, Extend, Offset, Face edges'], ['Arrange → Arrange on a circle', 'Space the selection around a circle; run again to change its radius'], ['Assemble menu', 'Mates keep parts attached · exploded view · bill of materials'], ['Drawing', 'Section A–A, detail views, click-to-dimension'], ['Ctrl+H', 'Hull: wrap one skin around the selection to blend shapes together (holes inside still cut)'],
			['H', 'Toggle solid / hole'], ['D', 'Drop to bed'], ['C', 'Center on bed'], ['P', 'Place on face'], ['M', 'Measure: click two points, or click a circle / arc / hole / cylinder / sphere for its diameter & radius (hover a rim, then its middle to snap to the center)'], ['Shift+L', 'Space evenly: equal gaps or center-to-center along X / Y / Z, fit between the outer objects or an exact distance'], ['L', 'Align mode: hover dots to preview, click to apply; click an object to anchor'], ['K', 'Workplane: click a face to build on it (click the bed to reset)'], ['J', 'Sketch on face: draw on a face, then extrude out or cut in'], ['G', 'Fillet / chamfer: click edges of any part (works after booleans), set the size, Apply'], ['U', 'Push / pull: drag a face out to thicken it or in to cut; or click it and type a distance. Draft tapers flat faces; curved faces are offset along the surface'], ['Sketcher', 'Line (D), Arc (B), Circle (C), Rect (Q), Construction (G). Closed loops become solids; loops and circles inside them become holes'],
			['Variables', ''], ['Toolbar ƒ Variables', 'Name values (wall = 2) and type them into any field or sketch dimension: wall*2, max(wall, 3)'],
			['Sketch editor', ''], ['D / S', 'Draw mode / Select mode'], ['H V L E P T A F X Y R', 'Horizontal, Vertical, Length, Equal, Parallel, Perpendicular, Angle, Fix, X / Y dimension, corner Radius'], ['Click a dimension', 'Edit it (numbers, math or variables); click a gray length to turn it into a dimension'],
			['F2 / double-click a name', 'Rename the selected object'], ['Ctrl+D', 'Duplicate (repeat transform)'], ['Ctrl+C / X / V', 'Copy / Cut / Paste'], ['Del', 'Delete'],
			['Ctrl+Z · Ctrl+Y', 'Undo · Redo'], ['Ctrl+A', 'Select all'], ['Esc', 'Cancel tool / deselect'],
			['F', 'Fit selection (or all)'], ['1–6 · 0', 'Front, Back, Right, Left, Top, Bottom · Iso'], ['O', 'Toggle orthographic'],
			['Ctrl+S · Ctrl+Shift+S', 'Save · Save as'], ['Ctrl+O · Ctrl+E', 'Open · Export STL'],
			['Number fields', ''],
			['Math & units', 'Type 25.4*2, 10+3, 3/8in, 2cm …'], ['↑ / ↓ in a field', 'Step value (Shift ×10)'], ['Drag a field label', 'Scrub value'],
		];
		const t = el('table', { class: 'keys' }, ...rows.map(([k, v]) => (v === '' ? el('tr', {}, el('th', { colspan: 2 }, k)) : el('tr', {}, el('td', {}, el('kbd', {}, k)), el('td', {}, v)))));
		const intro = el('p', { class: 'muted' }, 'DraftOtter runs entirely in your browser — nothing is uploaded. Designs autosave locally; use Save to keep a .lcad.json file. Holes become cuts when grouped with solids. Groups stay editable: expand them in the Objects list (or double-click) to change any part.');
		this.modal('Help & shortcuts', el('div', {}, intro, t), [{ label: 'Close', primary: true }], 'wide');
	}

	// ============================================================ toolbar

	// ============================================================ collapsible side panels
	buildPanelToggles() {
		let state = {};
		try { state = JSON.parse(localStorage.getItem(PANELS_KEY) || '{}'); } catch (e) { /* ignore */ }
		for (const [side, label, key] of [['left', 'Shapes · Objects', 'Ctrl+['], ['right', 'Properties · Print info', 'Ctrl+]']]) {
			const aside = $('#' + side);
			const collapse = el('button', { class: 'icon-btn sm panel-toggle', title: `Collapse panel (${key})`, html: side === 'left' ? '«' : '»' });
			collapse.addEventListener('click', () => this.togglePanel(side));
			aside.querySelector('.panel-title').appendChild(collapse);
			const rail = el('button', { class: 'panel-rail', title: `Expand panel (${key})` }, el('span', { class: 'rail-arrow' }, side === 'left' ? '»' : '«'), el('span', { class: 'rail-label' }, label));
			rail.addEventListener('click', () => this.togglePanel(side));
			aside.prepend(rail);
			if (state[side]) $('#app').classList.add(side + '-collapsed');
			const grip = el('div', { class: 'panel-resizer', title: 'Drag to resize · double-click for the default width' });
			grip.addEventListener('pointerdown', (e) => this.startPanelResize(e, side, grip));
			grip.addEventListener('click', (e) => { if (e.detail >= 2) this.setPanelWidth(side, null); });
			aside.appendChild(grip);
			if (state[side + 'Width']) this.setPanelWidth(side, state[side + 'Width'], false);
		}
		window.addEventListener('resize', () => { for (const side of ['left', 'right']) if (this.panelWidths && this.panelWidths[side]) this.setPanelWidth(side, this.panelWidths[side], false); });
		this.buildMobileNav();
	}

	/** Phones: a bar at the bottom switches the sheet under the 3D view between Shapes · Objects and Properties, or hides it. */
	buildMobileNav() {
		const nav = el('nav', { id: 'mnav' });
		const items = [['left', 'cube', 'Shapes'], ['right', 'pencil', 'Properties'], ['', 'eye', 'View only']];
		const btns = items.map(([sheet, ic, label]) => el('button', { 'data-sheet': sheet, onclick: () => this.showSheet(sheet) }, el('span', { html: icon(ic) }), label));
		nav.append(...btns);
		$('#app').appendChild(nav);
		this.showSheet('left');
	}

	showSheet(sheet) {
		const app = $('#app');
		app.dataset.sheet = sheet;
		for (const b of document.querySelectorAll('#mnav button')) b.classList.toggle('on', b.dataset.sheet === sheet);
		requestAnimationFrame(() => this.vp && this.vp.resize());
	}

	/** Side panel width in px (null = default); kept so the 3D view always has room. */
	setPanelWidth(side, w, save = true) {
		this.panelWidths = this.panelWidths || {};
		const app = $('#app'), v = side === 'left' ? '--lw-user' : '--rw-user';
		if (w == null) {
			app.style.removeProperty(v);
			delete this.panelWidths[side];
		} else {
			const other = this.panelWidths[side === 'left' ? 'right' : 'left'] || (side === 'left' ? 300 : 236);
			w = Math.round(Math.max(180, Math.min(w, window.innerWidth - other - 320, window.innerWidth * 0.6)));
			app.style.setProperty(v, w + 'px');
			this.panelWidths[side] = w;
		}
		if (!save) return;
		try {
			const state = JSON.parse(localStorage.getItem(PANELS_KEY) || '{}');
			if (w == null) delete state[side + 'Width']; else state[side + 'Width'] = w;
			localStorage.setItem(PANELS_KEY, JSON.stringify(state));
		} catch (e) { /* ignore */ }
	}

	startPanelResize(e, side, grip) {
		if (e.button !== 0) return;
		e.preventDefault();
		const aside = $('#' + side), start = e.clientX, w0 = aside.getBoundingClientRect().width;
		grip.setPointerCapture(e.pointerId);
		grip.classList.add('dragging');
		document.body.classList.add('resizing-panel');
		let w = w0;
		const move = (ev) => { w = w0 + (side === 'left' ? ev.clientX - start : start - ev.clientX); this.setPanelWidth(side, w, false); };
		const up = () => {
			grip.removeEventListener('pointermove', move);
			grip.removeEventListener('pointerup', up);
			grip.removeEventListener('pointercancel', up);
			grip.classList.remove('dragging');
			document.body.classList.remove('resizing-panel');
			// a second click without dragging, soon after the first: back to the default width
			const now = performance.now();
			if (w !== w0) this.setPanelWidth(side, w);
			else if (now - (grip.lastClick || 0) < 450) { this.setPanelWidth(side, null); grip.lastClick = 0; return; }
			grip.lastClick = w === w0 ? now : 0;
		};
		grip.addEventListener('pointermove', move);
		grip.addEventListener('pointerup', up);
		grip.addEventListener('pointercancel', up);
	}

	/** Print info can be folded away (remembered per browser). */
	buildStatsToggle() {
		const title = $('#stats').previousElementSibling;
		title.classList.add('collapsible');
		title.title = 'Show / hide print info';
		const caret = el('span', { class: 'sec-caret', html: icon('caret') });
		title.prepend(caret);
		let hidden = false;
		try { hidden = localStorage.getItem('draftotter-stats-hidden') === '1'; } catch (e) { /* ignore */ }
		const apply = () => { $('#stats').style.display = hidden ? 'none' : ''; title.classList.toggle('closed', hidden); };
		title.addEventListener('click', () => { hidden = !hidden; try { localStorage.setItem('draftotter-stats-hidden', hidden ? '1' : '0'); } catch (e) { /* ignore */ } apply(); });
		apply();
	}

	buildLeftTabs() {
		const title = $('#tree').previousElementSibling;
		const count = title.querySelector('#tree-count');
		title.innerHTML = '';
		const tab = (id, label) => { const b = el('button', { class: 'left-tab' + (id === 'objects' ? ' on' : ''), title: id === 'timeline' ? 'Feature timeline: every step in order — suppress or roll back' : 'Objects', onclick: () => this.setLeftTab(id) }, label); b.dataset.tab = id; return b; };
		title.append(tab('objects', 'Objects'), count, tab('timeline', 'Timeline'));
		$('#tree').after(el('div', { id: 'timeline', style: 'display:none' }));
		this.leftTab = 'objects';
		this.buildLeftSplitter(title);
	}

	/** Drag the bar above Objects / Timeline up into the Shapes area (double-click or ⇱ toggles all the way). */
	buildLeftSplitter(title) {
		const lib = $('#library'), aside = $('#left');
		const split = el('div', { class: 'left-split', title: 'Drag to resize · double-click to give the list the whole panel' });
		title.before(split);
		const grow = el('button', { class: 'icon-btn sm left-grow', title: 'Expand the list into the Shapes area (drag the bar above to resize)' }, '⇱');
		title.appendChild(grow);
		const set = (h, save = true) => {
			const max = aside.clientHeight - 140;
			if (h == null) { lib.style.flex = ''; lib.style.maxHeight = ''; lib.style.display = ''; }
			else {
				h = Math.max(0, Math.min(max, h));
				lib.style.flex = '0 0 ' + h + 'px'; lib.style.maxHeight = 'none';
				lib.style.display = h < 4 ? 'none' : '';
			}
			grow.textContent = h != null && h < 4 ? '⇲' : '⇱';
			grow.title = h != null && h < 4 ? 'Show the Shapes area again' : 'Expand the list into the Shapes area (drag the bar above to resize)';
			if (save) try { localStorage.setItem('draftotter-lib-height', h == null ? '' : String(Math.round(h))); } catch (e) { /* ignore */ }
		};
		const cur = () => (lib.style.display === 'none' ? 0 : lib.getBoundingClientRect().height);
		const toggle = () => { if (cur() < 4) set(this.libLastHeight || null); else { this.libLastHeight = cur(); set(0); } };
		split.addEventListener('pointerdown', (e) => {
			e.preventDefault();
			split.setPointerCapture(e.pointerId);
			const y0 = e.clientY, h0 = cur();
			split.classList.add('drag');
			const mv = (ev) => set(h0 + ev.clientY - y0, false);
			const up = () => { split.classList.remove('drag'); split.removeEventListener('pointermove', mv); split.removeEventListener('pointerup', up); set(cur()); };
			split.addEventListener('pointermove', mv);
			split.addEventListener('pointerup', up);
		});
		split.addEventListener('dblclick', toggle);
		grow.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
		let saved = null;
		try { saved = localStorage.getItem('draftotter-lib-height'); } catch (e) { /* ignore */ }
		if (saved) requestAnimationFrame(() => set(+saved, false));
	}

	togglePanel(side, force) {
		const on = $('#app').classList.toggle(side + '-collapsed', force);
		try {
			const state = JSON.parse(localStorage.getItem(PANELS_KEY) || '{}');
			state[side] = on;
			localStorage.setItem(PANELS_KEY, JSON.stringify(state));
		} catch (e) { /* ignore */ }
		return on;
	}

	buildToolbar() {
		const bar = $('#toolbar');
		const m = (fn) => (e) => this.menu(e.currentTarget, fn());
		const groups = [
			[
				['file', 'File', 'File: new, open, save, versions, import, export', (e) => this.fileMenu(e.currentTarget), 'has-menu'],
				['save', 'Save', 'Save design (Ctrl+S)', () => this.saveProject(), '', null, { save: '1' }],
				['export', 'Export', 'Export STL, 3MF or STEP (Ctrl+E)', () => this.exportDialog(), 'accent'],
			],
			[
				['undo', 'Undo', 'Undo (Ctrl+Z)', () => this.undo(), '', 'undo'],
				['redo', 'Redo', 'Redo (Ctrl+Y)', () => this.redo(), '', 'redo'],
				['duplicate', 'Duplicate', 'Duplicate (Ctrl+D) — repeat to repeat the transform', () => this.duplicate(), '', 'sel'],
				['trash', 'Delete', 'Delete (Del)', () => this.deleteSel(), '', 'sel'],
			],
			[
				['union', 'Group', 'Group: union solids & cut holes (Ctrl+G)', () => this.group('union'), '', 'sel'],
				['ungroup', 'Ungroup', 'Ungroup (Ctrl+Shift+G)', () => this.ungroup(), '', 'group'],
				['hole', 'Hole', 'Toggle solid / hole (H)', () => this.toggleHole(), '', 'sel'],
				['intersect', 'Combine', 'Combine: Intersect, Hull (blend shapes together)', m(() => [
					['Intersect — keep only the overlap  (Ctrl+I)', () => this.group('intersect')],
					['Hull — wrap one skin around, blending shapes  (Ctrl+H)', () => this.group('hull')],
				]), 'has-menu'],
			],
			[
				['align', 'Align', 'Align objects (L)', () => this.setTool('align'), '', null, { tool: 'align' }],
				['space', 'Arrange', 'Arrange: Space evenly, Arrange on a circle, Pattern, Mirror, Auto-orient, Pack the bed, drop / center / place on a face, Workplane, rotate', m(() => [
					['Space evenly…  (Shift+L)', () => this.spaceDialog()],
					['Arrange on a circle…', () => this.arrangeCircleDialog()],
					['Pattern (linear / circular / grid)…', () => this.arrayDialog()],
					['Mirror X (left / right)', () => this.mirror('x')], ['Mirror Y (front / back)', () => this.mirror('y')], ['Mirror Z (upside down)', () => this.mirror('z')],
					['Mirror copy across X…', () => this.mirrorCopy('x')], ['Mirror copy across Y…', () => this.mirrorCopy('y')],
					null,
					['Auto-orient for printing (least support)…', () => this.autoOrientDialog()],
					['Arrange on the bed (pack parts)…', () => this.arrangeDialog()],
					null,
					['Drop to bed  (D)', () => this.dropToBed()], ['Center on bed  (C)', () => this.centerOnBed()], ['Place on a face…  (P)', () => this.setTool('place')],
					['Workplane: build on a face…  (K)', () => this.setTool('workplane')],
					null,
					['Rotate 90° about Z  (])', () => this.rotateSel('z', 90)], ['Lay on side (90° about X)', () => this.rotateSel('x', 90)], ['Lay on side (90° about Y)', () => this.rotateSel('y', 90)],
				]), 'has-menu', null, { tools: 'place,workplane' }],
			],
			[
				['fillet', 'Fillet', 'Fillet / chamfer edges (G): click edges of any part', () => this.setTool('fillet'), '', null, { tool: 'fillet' }],
				['pushpull', 'Push/pull', 'Push / pull a face (U): drag a face to thicken it or cut it in', () => this.setTool('pushpull'), '', null, { tool: 'pushpull' }],
				['shell', 'Modify', 'Modify: Sketch on face, Shell, Offset, Surface texture, Deform, Split, Wrap text', m(() => [
					['Hole Wizard — standard holes on faces…', () => this.startHoleWizard()],
					['Sketch on a face…  (J)', () => this.setTool('sketchface')],
					['Shell / hollow out…', () => this.shellDialog()],
					['Offset / thicken…', () => this.offsetDialog()],
					['Surface texture (knurl, ribs, bumps, …)', () => this.addTexture()],
					['Deform (bend, twist, taper, lattice)', () => this.addDeform()],
					['Sculpt (shape the surface with brushes)…', () => this.startSculpt()],
					['Paint faces (multi-color printing)…', () => this.startPaint()],
					['Symmetry — mirror planes through a point…', () => this.startSymmetry()],
					null,
					['Split part with a plane…', () => this.splitDialog()],
					['Wrap / emboss text onto a cylinder…', () => this.wrapDialog()],
				]), 'has-menu', null, { tools: 'sketchface,holewiz,paint,sympoint' }],
			],
			[
				['ruler', 'Measure', 'Measure distances, angles and diameters (M)', () => this.setTool('measure'), '', null, { tool: 'measure' }],
				['check', 'Inspect', 'Inspect: Check for printing, interference, section view, overhangs, center of mass, 2D drawing', m(() => [
					['Check for printing…', () => this.checkPrint()],
					['Interference check (overlapping parts)', () => this.interferenceCheck()],
					['Stress check (FEA) — will it bend or break?…', () => this.stressDialog()],
					null,
					[(this.model.settings.section.on ? '✓ ' : '') + 'Section / cut-away view', () => this.toggleSection()],
					[(this.model.settings.overhang ? '✓ ' : '') + 'Highlight overhangs', () => this.toggleOverhang()],
					[(this.showCOM ? '✓ ' : '') + 'Show center of mass', () => { this.showCOM = !this.showCOM; this.renderStats(); }],
					null,
					['2D drawing (PDF / SVG / DXF)…', () => this.drawingDialog()],
				]), 'has-menu', null, { tools: 'feapick' }],
				['hinge', 'Assemble', 'Assemble: Mate parts, joints, exploded view, bill of materials, collisions', m(() => [
					['Mate parts (face to face, pin into hole)…', () => this.startMate()],
					['Add hinge / slider joint to selection…', () => this.jointDialog()],
					['Joints & attachments panel', () => this.showJointsPanel()],
					['Interference check (overlapping parts)', () => this.interferenceCheck()],
					null,
					[(this.explodeOn ? '✓ ' : '') + 'Exploded view', () => this.toggleExplode()],
					['Bill of materials…', () => this.bomDialog()],
				]), 'has-menu', null, { tools: 'mate' }],
			],
			[
				['fx', 'Variables', 'Design variables and configurations: name values and use them in any field', () => this.variablesDialog()],
				['tools', 'More', 'More: import DXF / SVG or an image (PNG / JPG) as a sketch, fit test print, templates', (e) => this.toolsMenu(e.currentTarget), 'has-menu'],
			],
		];
		for (const g of groups) {
			const gEl = el('div', { class: 'tb-group' });
			for (const [ic, label, title, fn, cls, req, data] of g) {
				const b = el('button', { class: 'tb ' + (cls || ''), title, html: icon(ic) + `<span>${label}</span>` });
				b.addEventListener('click', fn);
				if (req) b.dataset.req = req;
				if (data) for (const k in data) b.dataset[k] = data[k];
				gEl.appendChild(b);
			}
			bar.appendChild(gEl);
		}
		// Floating viewport toolbar: gizmo modes + view controls.
		const vpGroups = [
			[
				['move', 'Move', 'Move gizmo (W)', () => this.setGizmo('translate'), '', null, { gizmo: 'translate' }],
				['rotate', 'Rotate', 'Rotate gizmo (E)', () => this.setGizmo('rotate'), '', null, { gizmo: 'rotate' }],
				['scale', 'Scale', 'Scale gizmo (R)', () => this.setGizmo('scale'), '', null, { gizmo: 'scale' }],
			],
			[
				['fit', 'Fit', 'Fit view (F)', () => this.frame()],
				['cube', 'Views', 'Standard views', (e) => this.menu(e.currentTarget, [['Iso (0)', () => this.vp.setView('iso')], ['Top (5)', () => this.vp.setView('top')], ['Front (1)', () => this.vp.setView('front')], ['Right (3)', () => this.vp.setView('right')], ['Back (2)', () => this.vp.setView('back')], ['Left (4)', () => this.vp.setView('left')], ['Bottom (6)', () => this.vp.setView('bottom')], null, ['Toggle orthographic (O)', () => this.toggleOrtho()], ['Save screenshot (PNG)', () => download(dataURLtoBlob(this.vp.screenshot()), (this.model.doc.name || 'design') + '.png')], ['Photoreal render…', () => this.renderDialog()]])],
				['ortho', 'Ortho', 'Orthographic projection (O)', () => this.toggleOrtho(), '', null, { toggle: 'ortho' }],
				['section', 'Section', 'Section / cut-away view', () => this.toggleSection(), '', null, { toggle: 'section' }],
				['overhang', 'Overhangs', 'Highlight overhangs that need support', () => this.toggleOverhang(), '', null, { toggle: 'overhang' }],
			],
		];
		const vpBar = el('div', { id: 'vp-tools' });
		for (const g of vpGroups) {
			const gEl = el('div', { class: 'vt-group' });
			for (const [ic, label, title, fn, cls, req, data] of g) {
				const b = el('button', { class: 'vt ' + (cls || ''), title, html: icon(ic) });
				b.addEventListener('click', fn);
				if (data) for (const k in data) b.dataset[k] = data[k];
				gEl.appendChild(b);
			}
			vpBar.appendChild(gEl);
		}
		$('#viewport').appendChild(vpBar);
		const snapSel = el('select', { id: 'snap-select', title: 'Snap increment' }, ...['0', '0.1', '0.25', '0.5', '1', '2', '5', '10'].map((v) => el('option', { value: v }, v === '0' ? 'Off' : v + ' mm')));
		snapSel.addEventListener('change', () => {
			this.model.settings.snap = Number(snapSel.value);
			this.vp.setSnap(this.model.settings);
			this.autosave();
			snapSel.blur();
		});
		bar.appendChild(el('div', { class: 'tb-group tb-snap' }, el('label', {}, el('span', {}, 'Snap'), snapSel)));
		bar.appendChild(el('div', { class: 'tb-spacer' }));
		const right = el('div', { class: 'tb-group' });
		for (const [ic, label, title, fn] of [['settings', 'Settings', 'Printer, grid & material settings', () => this.settingsDialog()], ['help', 'Help', 'Help & keyboard shortcuts (?)', () => this.helpDialog()]]) {
			const b = el('button', { class: 'tb', title, html: icon(ic) + `<span>${label}</span>` });
			b.addEventListener('click', fn);
			right.appendChild(b);
		}
		bar.appendChild(right);
		$('#project-name').addEventListener('change', (e) => { this.model.doc.name = e.target.value.trim() || 'Untitled'; this.commit(); });
		$('#project-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
		document.querySelector('[data-gizmo=translate]').classList.add('active');
	}

	syncSnapSelect() {
		const s = $('#snap-select');
		const v = String(this.model.settings.snap);
		if (![...s.options].some((o) => o.value === v)) s.appendChild(el('option', { value: v }, v + ' mm'));
		s.value = v;
	}

	updateToolbarState() {
		const nodes = this.selectedNodes();
		document.querySelectorAll('[data-req]').forEach((b) => {
			const r = b.dataset.req;
			b.disabled = r === 'sel' ? !nodes.length : r === 'group' ? !nodes.some((n) => n.type === 'group') : r === 'undo' ? !this.model.canUndo() : r === 'redo' ? !this.model.canRedo() : false;
		});
		const s = this.model.settings;
		document.querySelector('[data-toggle=section]').classList.toggle('active', s.section.on);
		document.querySelector('[data-toggle=overhang]').classList.toggle('active', s.overhang);
		document.querySelector('[data-toggle=ortho]').classList.toggle('active', this.vp.camera.isOrthographicCamera);
		$('#section-panel').style.display = s.section.on ? '' : 'none';
		this.syncSectionPanel();
	}

	fileMenu(anchor) {
		this.menu(anchor, [
			['New design', () => this.newProject()],
			['Open…  (Ctrl+O)', () => this.openProject()],
			null,
			['Save  (Ctrl+S)', () => this.saveProject()],
			['Save as…  (Ctrl+Shift+S)', () => this.saveProject(true)],
			['History & branches…  (commits, branches, merge)', () => this.historyDialog()],
			null,
			['Import STL…', () => this.importSTL()],
			['Import 3MF (models, slicer projects)…', () => this.import3MF()],
			['Import STEP / IGES…', () => this.importCAD()],
			['Import OBJ / glTF / GLB (e.g. from AI image-to-3D tools)…', () => this.importMeshFile()],
			['Import DXF / SVG as a sketch…', () => this.importVectorFile()],
			['Import image (PNG / JPG) as a sketch…', () => this.importImageFile()],
			['Image → relief / lithophane…', () => this.importRelief()],
			['Export STL…  (Ctrl+E)', () => this.exportDialog('stl')],
			['Export STEP…', () => this.exportDialog('step')],
			['Export 3MF (colors, multi-part)…', () => this.exportDialog('3mf')],
			['Export section as DXF / SVG…', () => this.sectionExportDialog()],
			['2D drawing (PDF / SVG / DXF)…', () => this.drawingDialog()],
			['Save screenshot (PNG)', () => download(dataURLtoBlob(this.vp.screenshot()), (this.model.doc.name || 'design') + '.png')], ['Photoreal render…', () => this.renderDialog()],
			null,
			['Save selection to My parts…', () => this.saveToLibrary()],
			...(this.installPrompt ? [null, ['Install DraftOtter as an app (works offline)…', () => this.installApp()]] : []),
		]);
	}

	/** Fit selector for a hole: the hole grows by the fit's clearance plus the printer's hole compensation. */
	/** Fit controls for one hole or several at once (differing values show as "Mixed"). */
	fitControls(host, nodes) {
		if (!Array.isArray(nodes)) nodes = [nodes];
		const n = nodes[0];
		const same = (fn) => nodes.every((x) => fn(x) === fn(n));
		const mixed = !same((x) => x.fit || '');
		const sel = el('select', { title: 'Make the hole bigger by a standard 3D-printing clearance' },
			...(mixed ? [el('option', { value: '__mixed', disabled: true }, 'Mixed')] : []),
			el('option', { value: '' }, 'Exact size (no fit)'),
			...Object.entries(FITS).map(([k, f]) => el('option', { value: k }, `${f.label} +${f.clearance} mm`)),
			el('option', { value: 'custom' }, 'Custom clearance…'));
		sel.value = mixed ? '__mixed' : n.fit || '';
		sel.addEventListener('change', () => this.applyFit(nodes, (x) => {
			if (sel.value) x.fit = sel.value; else delete x.fit;
			if (x.fit === 'custom' && x.fitClearance == null) x.fitClearance = 0.25;
		}));
		host.appendChild(el('label', { class: 'field wide' }, el('span', {}, 'Fit'), sel));
		if (!mixed && n.fit === 'custom') {
			const inp = this.numInput(n.fitClearance || 0, (v) => this.applyFit(nodes, (x) => { x.fitClearance = v; }), 0.05);
			host.appendChild(el('label', { class: 'field' }, el('span', { class: 'lbl' }, 'Clearance Ø (mm)'), inp));
		}
		if (nodes.some((x) => x.fit)) {
			// which of the object's own directions the clearance is added in
			const chips = el('div', { class: 'chips' }, ...['x', 'y', 'z'].map((a) => {
				const on = nodes.filter((x) => fitAxes(x).includes(a)).length;
				const cb = el('input', { type: 'checkbox', checked: on === nodes.length });
				if (on && on < nodes.length) cb.indeterminate = true;
				cb.addEventListener('change', () => {
					const want = cb.checked;
					if (!want && nodes.some((x) => fitAxes(x) === a)) { cb.checked = true; toast('Keep at least one direction', 'warn'); return; }
					this.applyFit(nodes, (x) => { x.fitAxes = ['x', 'y', 'z'].filter((k) => (k === a ? want : fitAxes(x).includes(k))).join(''); });
				});
				return el('label', { class: 'chip-check', title: `Add the clearance along the object's own ${a.toUpperCase()} axis` }, cb, el('span', {}, a.toUpperCase()));
			}));
			host.appendChild(el('div', { class: 'field wide' }, el('span', {}, 'Grow in'), chips));
			if (!mixed && same((x) => fitClearance(x, this.model.settings)) && same(fitAxes)) {
				const axes = fitAxes(n), c = fitClearance(n, this.model.settings), comp = this.model.settings.holeComp || 0;
				host.appendChild(el('div', { class: 'muted small pad-x' }, `Printed ${fmt(c, 2)} mm larger across (${fmt(c / 2, 3)} mm per side) in ${axes.toUpperCase().split('').join(', ')}${comp ? ` — incl. ${fmt(comp, 2)} mm printer compensation` : ''}${FITS[n.fit] ? ' — ' + FITS[n.fit].hint : ''}.`));
			} else host.appendChild(el('div', { class: 'muted small pad-x' }, 'The selected holes have different fits; a change here applies to all of them.'));
		}
	}

	/**
	 * Change the fit of some holes, then rebuild them one at a time with a progress bar (growing a custom shape can
	 * take a while), and commit once at the end.
	 */
	async applyFit(nodes, change) {
		if (this.fitBusy) return;
		nodes.forEach(change);
		this.propSig = null;
		this.applyExpressions();
		const tops = [...new Set(nodes.map((x) => { let t = x, p; while ((p = this.model.parentOf(t.id))) t = p; return t; }))];
		const todo = [...nodes, ...tops.filter((t) => !nodes.includes(t))].filter((x) => !this.engine.cache.has(this.engine.key(x)));
		// only show the bar when there is real work: several objects, or a shape that needs a 3D offset
		const slow = todo.length > 12 || nodes.some((x) => x.fit && (x.type === 'group' || x.type === 'mesh' || !fittedParams(x.type, x.params, 1, fitAxes(x))));
		if (slow && todo.length) {
			this.fitBusy = true;
			const bar = this.progressBar('Applying fit');
			try {
				bar.set(0, 'Starting');
				await bar.paint();
				await this.engine.buildAsync(tops, (done, total, n) => bar.set(done / total, `${nodes.includes(n) ? 'Growing' : 'Cutting'} "${n.name}" (${done} / ${total})`));
				bar.set(1, 'Updating the view');
				await bar.paint();
			} finally {
				this.fitBusy = false;
				bar.done();
			}
		}
		this.commit();
	}

	/** A small progress panel at the bottom of the view: { set(fraction, text), paint(), done() }. */
	progressBar(title) {
		const fill = el('div', { class: 'pbar-fill' });
		const text = el('div', { class: 'pbar-text' }, title);
		const box = el('div', { class: 'pbar' }, el('b', {}, title), text, el('div', { class: 'pbar-track' }, fill));
		document.body.appendChild(box);
		return {
			set(f, t) { fill.style.width = `${Math.round(Math.max(0, Math.min(1, f)) * 100)}%`; if (t) text.textContent = t; },
			// let the browser draw the bar before the next blocking step
			paint: () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))),
			done() { box.remove(); },
		};
	}

	toolsMenu(anchor) {
		this.menu(anchor, [
			['Import DXF / SVG as a sketch…', () => this.importVectorFile()],
			['Import image (PNG / JPG) as a sketch…', () => this.importImageFile()],
			['Image → relief / lithophane…', () => this.importRelief()],
			['Import OBJ / glTF / GLB…', () => this.importMeshFile()],
			['Import 3MF…', () => this.import3MF()],
			['Export section as DXF / SVG (laser / CNC)…', () => this.sectionExportDialog()],
			null,
			['Fit test print (find your printer\'s clearances)', () => this.fitCalibration()],
			['Round dimensions (sizes, positions, angles)…', () => this.roundDialog()],
			['Make template from group…', () => { const n = this.selectedNodes()[0]; this.makeTemplate(n && n.type === 'group' ? n : null); }],
			null,
			['History & branches (commits, branches, merge)…', () => this.historyDialog()],
			null,
			['Connect Claude (AI assistant)…', () => this.claudeDialog()],
		]);
	}

	menu(anchor, items) {
		document.querySelectorAll('.menu').forEach((m) => m.remove());
		const m = el('div', { class: 'menu' }, ...items.map((it) => (it ? el('button', { onclick: () => { m.remove(); it[1](); } }, it[0]) : el('hr'))));
		document.body.appendChild(m);
		const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: anchor.x, bottom: anchor.y };
		m.style.left = Math.min(r.left, window.innerWidth - m.offsetWidth - 8) + 'px';
		m.style.top = Math.min(r.bottom + 4, window.innerHeight - m.offsetHeight - 8) + 'px';
		setTimeout(() => {
			const off = (e) => { if (!m.contains(e.target)) { m.remove(); window.removeEventListener('pointerdown', off, true); } };
			window.addEventListener('pointerdown', off, true);
		});
	}

	toggleOrtho() {
		this.vp.setOrtho(!this.vp.camera.isOrthographicCamera);
		this.updateToolbarState();
	}

	toggleOverhang() {
		this.model.settings.overhang = !this.model.settings.overhang;
		this.vp.applyDisplaySettings(this.model.settings);
		this.updateToolbarState();
		this.autosave();
		if (this.model.settings.overhang) toast(`Red faces overhang more than ${this.model.settings.overhangAngle}° and may need supports`, 'info', 3500);
	}

	toggleSection() {
		const s = this.model.settings.section;
		s.on = !s.on;
		if (s.on) {
			// start through the middle of the design, across its longest side
			const box = this.sceneBox();
			if (!Array.isArray(s.normal) && !box.isEmpty()) {
				const sz = box.getSize(new THREE.Vector3());
				s.axis = sz.x >= sz.y ? 'y' : 'x';
			}
			this.centerSection();
		}
		if (!s.on && this.tool === 'sectionface') this.setTool(null);
		this.afterChange();
		this.autosave();
	}

	/** Put the section plane through the middle of the design (keeping its direction). */
	centerSection() {
		const s = this.model.settings.section, box = this.sel.length ? this.vp.selectionBox() : this.sceneBox();
		if (box.isEmpty()) return;
		s.offset = round(box.getCenter(new THREE.Vector3()).dot(sectionNormal(s)), 3);
	}

	/** Called while the plane is dragged in the view (final = on release). */
	onSectionChanged(final) {
		this.vp.applyDisplaySettings(this.model.settings);
		this.syncSectionPanel();
		if (final) this.autosave();
	}

	/** Section through a clicked flat face: the plane lies on the face, cutting away what is in front of it. */
	onSectionFace(sp) {
		if (!sp || !sp.object) { toast('Click a face of a part', 'warn'); return; }
		const s = this.model.settings.section, n = sp.normal.clone().normalize();
		// an inside face seen through the cut is not a face of the part to cut along
		if (n.dot(this.vp.camera.getWorldDirection(new THREE.Vector3())) > 0) { toast('Click an outside face of the part', 'warn'); return; }
		s.normal = n.toArray().map((x) => { const q = round(x, 9); return Math.abs(q) < 1e-9 ? 0 : q; });
		s.axis = Math.abs(n.x) > 0.9999 ? 'x' : Math.abs(n.y) > 0.9999 ? 'y' : Math.abs(n.z) > 0.9999 ? 'z' : 'custom';
		delete s.base;
		// a hair inside the face so the cut shows right away; drag the arrow to go deeper
		s.offset = round(sp.point.dot(n) - 0.5, 3);
		s.flip = false;
		this.setTool(null);
		this.onSectionChanged(true);
		toast('Section on that face — use the Position slider (or drag the arrow) to go deeper', 'info', 3500);
	}

	buildSectionPanel() {
		// always the open design's settings (they are replaced when a file is opened or another tab is shown)
		const sec = () => this.model.settings.section;
		const changed = (final = true) => this.onSectionChanged(final);
		const axisBtn = (ax, name, title) => el('button', { class: 'sec-dir sec-ax', 'data-ax': ax, title, onclick: () => { const s = sec(); s.axis = ax; s.base = ax; delete s.normal; this.vp.sectionTool.basis = null; this.centerSection(); changed(); } },
			el('b', { class: 'ax-' + ax }, ax.toUpperCase()), el('span', {}, name));
		const val = el('input', { id: 'sec-val', type: 'text', class: 'num sec-val', title: 'Position of the plane along its arrow (mm). Math works: 12.5, 10+2.5. ↑ / ↓ step 1 mm (Shift 10, Alt 0.1)' });
		const slider = el('input', { id: 'sec-slider', type: 'range', class: 'sec-slider', title: 'Slide the cut through the design (scroll to step 1 mm, Shift 10)' });
		// step for − / + and the arrow keys: 1 mm, Shift 10, Alt 0.1
		const stepOf = (e) => (e && e.shiftKey ? 10 : e && e.altKey ? 0.1 : 1);
		const nudge = (d) => { const s = sec(); s.offset = round((s.offset || 0) + d, 4); changed(); };
		const tiltIn = (i) => el('input', { id: 'sec-tilt-' + i, type: 'text', class: 'num sec-tilt', title: 'Tilt angle in degrees (↑ / ↓ step 1°, Shift 15°)' });
		const tiltA = tiltIn('a'), tiltB = tiltIn('b');
		const tiltLabA = el('b', { class: 'sec-tilt-lab' }), tiltLabB = el('b', { class: 'sec-tilt-lab' });
		const panel = el('div', { id: 'section-panel', class: 'float-bar section-bar', style: 'display:none' },
			el('div', { class: 'sec-row' },
				el('b', { class: 'sec-title' }, 'Section view'),
				el('div', { class: 'sec-dirs' },
					axisBtn('x', 'Side', 'Cut across X: see it from the side'),
					axisBtn('y', 'Front', 'Cut across Y: see it from the front'),
					axisBtn('z', 'Top', 'Cut across Z: see it from above'),
					el('button', { class: 'sec-dir', id: 'sec-face', title: 'Click a flat face of a part: the cut lies on it', onclick: () => this.setTool(this.tool === 'sectionface' ? null : 'sectionface') }, el('b', {}, '◩'), el('span', {}, 'On a face'))),
				el('span', { class: 'grow' }),
				el('button', { class: 'btn sm', id: 'sec-look', title: 'Turn the view to look straight at the cut surface', onclick: () => this.lookAtSection() }, 'Look at cut'),
				el('button', { class: 'icon-btn', title: 'Close section view', html: icon('x'), onclick: () => this.toggleSection() })),
			el('div', { class: 'sec-row' },
				el('span', { class: 'sec-lab' }, 'Position'),
				el('button', { class: 'btn sm sec-step', title: 'Move back 1 mm (Shift 10, Alt 0.1)', onclick: (e) => nudge(-stepOf(e)) }, '−'),
				slider,
				el('button', { class: 'btn sm sec-step', title: 'Move forward 1 mm (Shift 10, Alt 0.1)', onclick: (e) => nudge(stepOf(e)) }, '+'),
				val, el('span', { class: 'muted' }, 'mm'),
				el('button', { class: 'btn sm', title: 'Back through the middle of the design (or of the selection)', onclick: () => { this.centerSection(); changed(); } }, 'Center')),
			el('div', { class: 'sec-row' },
				el('span', { class: 'sec-lab' }, 'Tilt'),
				tiltLabA, tiltA, el('span', { class: 'muted' }, '°'),
				tiltLabB, tiltB, el('span', { class: 'muted' }, '°'),
				el('button', { class: 'btn sm', id: 'sec-straight', title: 'Undo the tilt: straight across the axis again', onclick: () => { const s = sec(), C = this.sectionMiddle(); setSectionTilts(s, 0, 0); if (C) s.offset = round(C.dot(sectionNormal(s)), 4); changed(); } }, 'Straighten'),
				el('span', { class: 'grow' }),
				el('button', { class: 'btn sm sec-toggle', id: 'sec-flip', title: 'Show the half on the other side of the cut', onclick: () => { const s = sec(); s.flip = !s.flip; changed(); } }, '⇄ Other half'),
				el('button', { class: 'btn sm sec-toggle', id: 'sec-plane', title: 'Show the plane and its handles in the view', onclick: () => { const s = sec(); s.showPlane = s.showPlane === false; changed(); } }, 'Show plane')));
		$('#viewport').appendChild(panel);
		// typed position: math and variables; arrow keys step it
		const setVal = () => { const v = evalExpr(val.value, this.varValues || {}); if (isFinite(v)) sec().offset = round(v, 4); changed(); };
		val.addEventListener('keydown', (e) => {
			e.stopPropagation();
			if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); nudge((e.key === 'ArrowUp' ? 1 : -1) * stepOf(e)); val.select(); }
			else if (e.key === 'Enter') { setVal(); val.blur(); }
		});
		val.addEventListener('change', setVal);
		// slider: live while dragging, saved when let go; the wheel steps it
		slider.addEventListener('input', () => { sec().offset = round(+slider.value, 4); changed(false); });
		slider.addEventListener('change', () => changed());
		slider.addEventListener('wheel', (e) => { e.preventDefault(); nudge((e.deltaY < 0 ? 1 : -1) * stepOf(e)); }, { passive: false });
		slider.addEventListener('keydown', (e) => e.stopPropagation());
		// tilt fields: degrees about the two other axes; the plane keeps going through the same middle point
		const setTilt = () => {
			const s = sec(), [a0, b0] = sectionTilts(s);
			const a = evalExpr(tiltA.value, this.varValues || {}), b = evalExpr(tiltB.value, this.varValues || {});
			const C = this.sectionMiddle();
			setSectionTilts(s, isFinite(a) ? a : a0, isFinite(b) ? Math.max(-90, Math.min(90, b)) : b0);
			if (C) s.offset = round(C.dot(sectionNormal(s)), 4);
			changed();
		};
		for (const [inp, i] of [[tiltA, 0], [tiltB, 1]]) {
			inp.addEventListener('keydown', (e) => {
				e.stopPropagation();
				if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
					e.preventDefault();
					const t = sectionTilts(sec());
					inp.value = String(round(t[i] + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 15 : 1), 4));
					setTilt();
					inp.select();
				} else if (e.key === 'Enter') { setTilt(); inp.blur(); }
			});
			inp.addEventListener('change', setTilt);
		}
		this.sectionTiltLabels = [tiltLabA, tiltLabB];
		this.syncSectionPanel();
	}

	/** Where the plane crosses the middle of the design (the point it turns about when tilted). */
	sectionMiddle() {
		const s = this.model.settings.section, box = this.sceneBox();
		const C = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
		const n = sectionNormal(s);
		return C.addScaledVector(n, (s.offset || 0) - C.dot(n));
	}

	/** The range the plane can usefully slide over: the design's extent along the plane's normal. */
	sectionRange() {
		const s = this.model.settings.section, box = this.sceneBox(), n = sectionNormal(s);
		if (box.isEmpty()) return [-50, 50];
		let lo = Infinity, hi = -Infinity;
		for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) { const d = n.x * x + n.y * y + n.z * z; lo = Math.min(lo, d); hi = Math.max(hi, d); }
		return [Math.floor(lo * 10) / 10, Math.ceil(hi * 10) / 10];
	}

	/** Turn the view to look straight at the cut surface (from the side that is cut away). */
	lookAtSection() {
		const s = this.model.settings.section;
		if (!s.on) return;
		const n = sectionNormal(s), dir = s.flip ? n.clone().negate() : n.clone();
		const vp = this.vp, C = this.sectionMiddle();
		const box = this.sceneBox(), r = box.isEmpty() ? 60 : Math.max(5, box.getBoundingSphere(new THREE.Sphere()).radius);
		const dist = (r / Math.sin((vp.persp.fov * Math.PI) / 360)) * 1.1;
		// keep "up" sensible: Z up unless looking straight down / up
		if (Math.abs(dir.z) > 0.999) dir.y -= 0.0001 * Math.sign(dir.z);
		vp.animateTo(C.clone().addScaledVector(dir.normalize(), dist), C.clone());
	}

	syncSectionPanel() {
		const s = this.model.settings.section, p = $('#section-panel');
		if (!p) return;
		if (document.activeElement !== $('#sec-val')) $('#sec-val').value = fmt(s.offset || 0, 3);
		const [lo, hi] = this.sectionRange(), slider = $('#sec-slider'), off = s.offset || 0;
		slider.min = String(Math.min(lo, off)); slider.max = String(Math.max(hi, off));
		slider.step = String(this.model.settings.snap > 0 ? Math.min(this.model.settings.snap, 1) : 0.1);
		slider.value = String(off);
		const tilts = sectionTilts(s), names = tiltAxisNames(s);
		const labs = this.sectionTiltLabels || [];
		names.forEach((nm, i) => { if (labs[i]) { labs[i].textContent = 'about ' + nm.toUpperCase(); labs[i].className = 'sec-tilt-lab ax-' + nm; } });
		for (const [i, id] of [[0, '#sec-tilt-a'], [1, '#sec-tilt-b']]) if (document.activeElement !== $(id)) $(id).value = fmt(tilts[i], 2);
		const tilted = Array.isArray(s.normal);
		$('#sec-straight').disabled = !tilted;
		const base = sectionBase(s);
		p.querySelectorAll('.sec-ax').forEach((btn) => { btn.classList.toggle('on', btn.dataset.ax === base && this.tool !== 'sectionface'); btn.classList.toggle('tilted', btn.dataset.ax === base && tilted); });
		$('#sec-face').classList.toggle('on', this.tool === 'sectionface');
		$('#sec-flip').classList.toggle('on', !!s.flip);
		$('#sec-plane').classList.toggle('on', s.showPlane !== false);
	}

	/** A dropped picture: trace it into a sketch, or make a relief / lithophane from it. */
	imageDropChoice(file) {
		let close = null;
		const go = (fn) => { if (close) close(); fn(); };
		const form = el('div', { class: 'form' },
			el('p', {}, `What should “${file.name}” become?`),
			el('div', { class: 'btn-row' },
				el('button', { class: 'btn primary', id: 'drop-sketch', onclick: () => go(() => this.importImageFile(file)) }, 'Traced outline (a sketch to extrude)'),
				el('button', { class: 'btn', id: 'drop-relief', onclick: () => go(() => this.importRelief(file)) }, 'Relief / lithophane')));
		close = this.modal('Import image', form, [{ label: 'Cancel' }]);
	}

	/** Kept for older callers: re-center along the current direction. */
	updateSectionRange(recenter) {
		if (recenter) this.centerSection();
		this.syncSectionPanel();
	}

	// ============================================================ shape library

	buildLibrary() {
		const lib = $('#library');
		lib.innerHTML = '';
		const label = (k) => (PRESETS[k] && PRESETS[k].label) || (SHAPES[k] && SHAPES[k].label) || k;
		const queue = [];
		let collapsed = {};
		try { collapsed = JSON.parse(localStorage.getItem('draftotter-lib-collapsed') || '{}'); } catch (e) { /* ignore */ }
		const add = (key, lbl, title, section) => {
			const img = el('img', { alt: '', class: 'pending' });
			const item = el('div', { class: 'lib-item', draggable: 'true', title: title || `Add ${lbl} (click, or drag onto the bed or a face)` }, img, el('span', {}, lbl));
			item.dataset.search = [key, lbl, section, KEYWORDS[key] || ''].join(' ').toLowerCase();
			item.addEventListener('click', () => this.addShape(key));
			item.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/lcad-shape', key); e.dataTransfer.effectAllowed = 'copy'; });
			queue.push({ key, img });
			return item;
		};
		const sec = (title, items, gridId) => {
			const grid = el('div', { class: 'lib-grid', id: gridId }, ...items);
			const head = el('div', { class: 'lib-title collapsible', html: icon('caret') }, el('span', {}, title), el('span', { class: 'lib-count' }, items.length ? String(items.length) : ''));
			const s = el('div', { class: 'lib-sec' + (collapsed[title] ? ' collapsed' : '') }, head, grid);
			head.addEventListener('click', () => {
				s.classList.toggle('collapsed');
				collapsed[title] = s.classList.contains('collapsed');
				try { localStorage.setItem('draftotter-lib-collapsed', JSON.stringify(collapsed)); } catch (e) { /* ignore */ }
			});
			return s;
		};
		const search = el('input', { type: 'search', class: 'lib-search', placeholder: 'Search shapes…', spellcheck: 'false' });
		const empty = el('div', { class: 'muted small pad', style: 'display:none' }, 'No shapes match.');
		lib.append(el('div', { class: 'lib-search-wrap' }, search), empty);
		const basic = ['box', 'cylinder', 'sphere', 'cone', 'tube', 'hemisphere', 'torus', 'wedge', 'pyramid', 'prism', 'star', 'text'];
		const holes = ['holeCyl', 'holeBox', 'screwPlain', 'screwCsk', 'screwCb', 'screwInsert', 'screwNut', 'holeWizard'];
		const groups = [['Basic shapes', basic], ['Holes', holes], ...LIBRARY_SECTIONS];
		for (const [title, keys] of groups) lib.appendChild(sec(title, keys.filter((k) => PRESETS[k] || SHAPES[k]).map((k) => add(k, label(k), null, title))));
		const sk = add('sketch', 'Sketch', 'Draw a 2D profile and extrude or revolve it', 'custom');
		const imp = el('div', { class: 'lib-item', title: 'Import an STL file', html: `<div class="lib-ic">${icon('import')}</div><span>Import STL</span>` });
		imp.dataset.search = 'import stl mesh file';
		imp.addEventListener('click', () => this.importSTL());
		lib.appendChild(sec('Custom', [sk, imp]));
		lib.appendChild(sec('My parts', [], 'my-parts'));
		this.renderMyParts();

		search.addEventListener('input', () => {
			const q = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
			let any = false;
			for (const s of lib.querySelectorAll('.lib-sec')) {
				let shown = 0;
				for (const it of s.querySelectorAll('.lib-item')) {
					const ok = !q.length || q.every((w) => (it.dataset.search || it.textContent.toLowerCase()).includes(w));
					it.style.display = ok ? '' : 'none';
					if (ok) shown++;
				}
				s.style.display = shown || !q.length ? '' : 'none';
				s.classList.toggle('searching', q.length > 0);
				any = any || shown > 0;
			}
			empty.style.display = any ? 'none' : '';
		});
		search.addEventListener('keydown', (e) => {
			if (e.key === 'Escape') { search.value = ''; search.dispatchEvent(new Event('input')); search.blur(); }
			if (e.key === 'Enter') { const first = [...lib.querySelectorAll('.lib-item')].find((x) => x.style.display !== 'none' && x.offsetParent); if (first) first.click(); }
		});

		this.loadThumbnails(queue);
	}

	/**
	 * Shape pictures for the library: kept in the browser between visits (per build of the app), so a start only
	 * renders the ones it doesn't have yet, a few at a time in idle moments after the app is ready.
	 */
	async loadThumbnails(queue) {
		const KEY = 'draftotter-lib-thumbs';
		const maker = (key) => (key === 'sketch' ? () => makeNode('sketch', { pts: [[0, 0], [20, 0], [20, 4], [4, 4], [4, 20], [0, 20]], height: 12 })
			: PRESETS[key] ? PRESETS[key].make : () => makeNode(key));
		// each picture is kept under a fingerprint of the shape it shows, so an update only redraws shapes that changed
		const sigOf = (node) => THUMB_VERSION + hashString(JSON.stringify(node, (k, v) => (k === 'id' || k === 'seq' ? undefined : v)));
		const saved = (await idbGet(KEY)) || {};
		const have = saved.v === 2 ? saved.thumbs || {} : {};
		const todo = [], fresh = {};
		for (const q of queue) {
			const node = maker(q.key)(), sig = sigOf(node);
			if (have[sig]) { q.img.src = fresh[sig] = have[sig]; q.img.classList.remove('pending'); } else todo.push({ ...q, node, sig });
		}
		if (!todo.length) { if (Object.keys(have).length !== Object.keys(fresh).length) idbSet(KEY, { v: 2, thumbs: fresh }); return; }
		// drawn one at a time when the app is idle: after it is up, and never while you drag, sculpt or type
		while (!document.body.classList.contains('ready')) await new Promise((r) => setTimeout(r, 100));
		const quiet = () => performance.now() - lastInteraction > 800 && !(this.sculpt && this.sculpt.stroking);
		// an idle moment, or at most a second later (so pictures still come in on a page that is never fully idle)
		const idle = (fn) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 1000 }) : setTimeout(fn, 50));
		let tr = null;
		await new Promise((done) => {
			const pump = (deadline) => {
				if (!quiet()) { setTimeout(() => idle(pump), 250); return; }
				void deadline;
				const { img, node, sig } = todo.shift();
				try { tr = tr || new ThumbRenderer(); img.src = fresh[sig] = tr.render(this.engine, node); } catch (e) { console.warn('thumbnail failed', e); }
				img.classList.remove('pending');
				if (todo.length) idle(pump); else done();
			};
			idle(pump);
		});
		if (tr) tr.dispose();
		idbSet(KEY, { v: 2, thumbs: fresh });
	}

	bindDrop() {
		const vpEl = $('#viewport');
		vpEl.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; vpEl.classList.add('drop'); });
		vpEl.addEventListener('dragleave', () => vpEl.classList.remove('drop'));
		vpEl.addEventListener('drop', async (e) => {
			e.preventDefault();
			vpEl.classList.remove('drop');
			const key = e.dataTransfer.getData('text/lcad-shape');
			const sp = this.vp.surfacePoint(e);
			const snap = this.model.settings.snap;
			let at = sp ? sp.point.clone() : null;
			if (at && snap > 0 && !e.altKey) at = this.vp.snapInPlane(at, sp.object ? sp.normal : new THREE.Vector3(0, 0, 1));
			if (key) { this.addShape(key, at, sp && sp.object ? sp.normal : null); return; }
			const files = [...(e.dataTransfer.files || [])];
			const stls = files.filter((f) => /\.stl$/i.test(f.name));
			const cad = files.filter((f) => /\.(step|stp|iges|igs|brep|brp)$/i.test(f.name));
			if (cad.length) await this.importCAD(cad);
			const proj = files.find((f) => /\.json$|\.(qcad|lcad)$/i.test(f.name));
			if (proj) await this.openProject(proj);
			if (stls.length) await this.importSTL(stls, at);
			const tmf = files.filter(is3MF);
			if (tmf.length) await this.import3MF(tmf);
			// drawings and pictures become sketches
			for (const v of files.filter((f) => /\.(svg|dxf)$/i.test(f.name))) this.importVectorText(v.name, await readFile(v, true));
			for (const mf of files.filter(isMeshFile)) await this.importMeshFile(mf);
			const img = files.find((f) => isImageFile(f) && !/\.svg$/i.test(f.name));
			if (img) this.imageDropChoice(img);
		});
	}

	// ============================================================ object tree

	renderTree() {
		const tree = $('#tree');
		tree.innerHTML = '';
		const selSet = new Set(this.sel);
		const row = (n, depth, parent) => {
			const isGroup = n.type === 'group';
			const r = el('div', { class: 'tree-row' + (selSet.has(n.id) ? ' sel' : '') + (n.visible ? '' : ' hidden') + (this.isOff(n) ? ' suppressed' : '') + (n.hole ? ' is-hole' : ''), style: { paddingLeft: 6 + depth * 14 + 'px' }, 'data-id': n.id, title: 'Double-click or F2 to rename' });
			const caret = el('span', { class: 'caret' + (isGroup ? '' : ' none') + (n.expanded ? ' open' : ''), html: isGroup ? icon('caret') : '' });
			caret.addEventListener('click', (e) => { e.stopPropagation(); n.expanded = !n.expanded; this.renderTree(); this.autosave(); });
			const sw = el('span', { class: 'swatch' + (n.hole ? ' hole' : ''), style: n.hole ? {} : { background: n.color } });
			const name = el('span', { class: 'tree-name' }, n.name || n.type);
			const ren = el('button', { class: 'icon-btn sm rename', title: 'Rename (F2)', html: icon('pencil') });
			ren.addEventListener('click', (e) => { e.stopPropagation(); this.startRename(n.id); });
			const tag = isGroup ? el('span', { class: 'tag' }, n.mode === 'intersect' ? 'intersect' : n.mode === 'offset' ? 'offset' : n.mode === 'hull' ? 'hull' : n.mode === 'texture' ? 'texture' : n.mode === 'deform' ? 'deform' : 'group') : n.hole ? el('span', { class: 'tag hole' }, 'hole') : null;
			const eye = el('button', { class: 'icon-btn sm', title: n.visible ? 'Hide' : 'Show', html: icon(n.visible ? 'eye' : 'eyeoff') });
			eye.addEventListener('click', (e) => { e.stopPropagation(); n.visible = !n.visible; this.commit(); });
			const lock = el('button', { class: 'icon-btn sm' + (n.locked ? ' on' : ''), title: n.locked ? 'Unlock' : 'Lock (prevents moving)', html: icon(n.locked ? 'lock' : 'unlock') });
			lock.addEventListener('click', (e) => { e.stopPropagation(); n.locked = !n.locked; this.commit(); });
			r.append(caret, sw, name, tag || '', el('span', { class: 'grow' }), ren, parent ? '' : eye, lock);
			r.addEventListener('click', (e) => this.onPick(n.id, e.shiftKey || e.ctrlKey || e.metaKey));
			r.addEventListener('contextmenu', (e) => { e.preventDefault(); if (!selSet.has(n.id)) this.setSelection([n.id]); this.contextMenu({ x: e.clientX, y: e.clientY }); });
			tree.appendChild(r);
			if (isGroup && n.expanded) for (const c of n.children) row(c, depth + 1, n);
		};
		// Auto-expand groups containing a selected nested node.
		for (const id of this.sel) {
			let p = this.model.parentOf(id);
			while (p) { p.expanded = true; p = this.model.parentOf(p.id); }
		}
		for (let i = this.model.nodes.length - 1; i >= 0; i--) row(this.model.nodes[i], 0, null);
		$('#tree-count').textContent = this.model.nodes.length ? String(this.model.nodes.length) : '';
		if (!this.model.nodes.length) tree.appendChild(el('div', { class: 'muted pad' }, 'No objects yet.'));
	}

	// Inline rename in the Objects list (also from F2, the pencil button and the right-click menu).
	startRename(id) {
		const node = this.model.get(id);
		if (!node) return;
		let p = this.model.parentOf(id);
		let expanded = false;
		while (p) { if (!p.expanded) { p.expanded = true; expanded = true; } p = this.model.parentOf(p.id); }
		if (expanded) this.renderTree();
		const row = [...document.querySelectorAll('#tree .tree-row')].find((r) => r.dataset.id === id);
		const label = row && row.querySelector('.tree-name');
		if (!label) return;
		const inp = el('input', { type: 'text', class: 'tree-rename', value: node.name, spellcheck: 'false' });
		label.replaceWith(inp);
		row.classList.add('renaming');
		inp.focus();
		inp.select();
		let finished = false;
		const finish = (save) => {
			if (finished) return;
			finished = true;
			const v = inp.value.trim();
			if (save && v && v !== node.name) { node.name = v; this.commit(); }
			else this.renderTree();
		};
		inp.addEventListener('blur', () => finish(true));
		inp.addEventListener('keydown', (ev) => {
			ev.stopPropagation();
			if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
			else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
		});
		for (const t of ['click', 'dblclick', 'pointerdown']) inp.addEventListener(t, (ev) => ev.stopPropagation());
	}

	contextMenu(pt, hits = [], surface = null) {
		const nodes = this.selectedNodes();
		if (!nodes.length) return;
		// a sketch-made object under the cursor, even inside a group
		const sketchHere = this.sketchFromHits(hits);
		const see = nodes.filter((n) => !n.hole && this.model.isTopLevel(n.id));
		const items = [
			hits.length > 1 ? [`Select object here… (${hits.length})`, () => this.showObjectPicker(hits, pt)] : false,
			hits.length > 1 ? null : false,
			nodes.length === 1 ? ['Rename…  (F2)', () => this.startRename(nodes[0].id)] : false,
			['Duplicate  (Ctrl+D)', () => this.duplicate()],
			['Copy  (Ctrl+C)', () => this.copy()],
			this.clipboard ? ['Paste  (Ctrl+V)', () => this.paste()] : false,
			['Delete  (Del)', () => this.deleteSel()],
			nodes.length === 1 ? ['History of this part…', () => this.partHistoryDialog(nodes[0])] : false,
			null,
			sketchHere ? [`Edit sketch “${sketchHere.name}”…`, () => this.editSketch(sketchHere)] : false,
			sketchHere ? null : false,
			[nodes.some((n) => !n.hole) ? 'Make hole  (H)' : 'Make solid  (H)', () => this.toggleHole()],
			nodes.length > 1 ? ['Group  (Ctrl+G)', () => this.group('union')] : false,
			nodes.length > 1 ? ['Intersect  (Ctrl+I)', () => this.group('intersect')] : false,
			nodes.length > 1 ? ['Space evenly…  (Shift+L)', () => this.spaceDialog()] : false,
			nodes.length > 1 ? ['Arrange on a circle…', () => this.arrangeCircleDialog()] : false,
			['Hull (blend together)  (Ctrl+H)', () => this.group('hull')],
			nodes.some((n) => n.type === 'group') ? ['Ungroup  (Ctrl+Shift+G)', () => this.ungroup()] : false,
			null,
			['Drop to bed  (D)', () => this.dropToBed()],
			['Center on bed  (C)', () => this.centerOnBed()],
			see.length > 0 && ['Auto-orient for printing…', () => this.autoOrientDialog()],
			['Arrange on the bed…', () => this.arrangeDialog()],
			['Place on face  (P)', () => this.setTool('place')],
			['Rotate 90° Z', () => this.rotateSel('z', 90)],
			['Lay on side (rotate 90° X)', () => this.rotateSel('x', 90)],
			nodes.length === 1 && !nodes[0].hole ? ['Shell / hollow out…', () => this.shellDialog()] : false,
			['Offset / thicken…', () => this.offsetDialog()],
			['Surface texture…', () => this.addTexture()],
			['Deform (bend, twist, taper, lattice)…', () => this.addDeform()],
			nodes.length === 1 && this.model.isTopLevel(nodes[0].id) && !nodes[0].hole ? ['Sculpt…', () => this.startSculpt(nodes[0])] : false,
			['Fillet / chamfer edges…  (G)', () => this.setTool('fillet')],
			surface && surface.object ? ['Sketch on this face…', () => this.onSketchFace(surface)] : false,
			['Push / pull a face…  (U)', () => this.setTool('pushpull')],
			surface && surface.object ? ['Set workplane on this face', () => this.onPickWorkplane(surface)] : false,
			['Save to My parts…', () => this.saveToLibrary()],
			null,
			[nodes.every((n) => n.locked) ? 'Unlock' : 'Lock', () => { const v = !nodes.every((n) => n.locked); nodes.forEach((n) => (n.locked = v)); this.commit(); }],
			['Hide', () => { nodes.forEach((n) => (n.visible = false)); this.commit(); }],
			see.length > 0 && [see.every((n) => n.seeThrough) ? 'Turn off see-through' : 'See-through', () => { const on = !see.every((n) => n.seeThrough); see.forEach((n) => { n.seeThrough = on; if (typeof n.opacity !== 'number') n.opacity = 0.5; }); this.commit(); }],
			see.length > 0 && ['Paint faces…', () => this.startPaint()],
			see.length > 0 && ['Make symmetric (mirror planes through a point)…', () => this.startSymmetry()],
			[nodes.every((n) => n.suppressed) ? 'Unsuppress (timeline)' : 'Suppress (switch off in the timeline)', () => { const on = nodes.every((n) => n.suppressed); nodes.forEach((n) => { if (on) delete n.suppressed; else n.suppressed = true; }); this.commit(); }],
		].filter((x) => x !== false);
		this.menu({ x: pt.x, y: pt.y }, items);
	}

	// ============================================================ properties

	renderProps() {
		const nodes = this.selectedNodes();
		const sig = JSON.stringify(nodes.map((n) => [n.id, n.type, n.mode, n.hole, n.type === 'sketch' ? n.params.mode : 0, n.type === 'cylinder' ? 0 : 0, n.fit || '', n.fitAxes || '', n.localVars ? JSON.stringify(n.localVars) : '']));
		if (sig === this.propSig) { this.refreshFields(); return; }
		this.propSig = sig;
		this.fields = [];
		const host = $('#props');
		host.innerHTML = '';
		this.propScope = nodes.length === 1 && this.scopeById ? this.scopeById.get(nodes[0].id) || null : null;
		if (!nodes.length) {
			host.appendChild(el('div', { class: 'props-empty' },
				el('p', {}, 'Select an object to edit its exact dimensions, position and rotation.'),
				el('p', { class: 'muted' }, 'Tip: every number field accepts math and units — try ', el('code', {}, '25.4*2'), ' or ', el('code', {}, '3/8in'), '.')));
			const vars = this.model.doc.vars || [];
			const vs = this.section(host, 'Variables');
			const sw = this.configSwitcher();
			if (sw) vs.appendChild(sw);
			if (vars.length) for (const v of vars) vs.appendChild(el('div', { class: 'kv pad-x' }, el('span', {}, el('code', {}, v.name), ' = ', v.expr), el('b', {}, this.varErrors && this.varErrors[v.name] ? '⚠' : fmt((this.varValues || {})[v.name], 3))));
			else vs.appendChild(el('div', { class: 'muted small pad-x' }, 'Name values like ', el('code', {}, 'wall = 2'), ' and type them into any field.'));
			vs.appendChild(el('div', { class: 'btn-row' }, el('button', { class: 'btn sm', onclick: () => this.variablesDialog() }, 'Edit variables…')));
			return;
		}
		if (nodes.length > 1) return this.renderMultiProps(host, nodes);
		const n = nodes[0];
		const nested = !this.model.isTopLevel(n.id);
		const parent = this.model.parentOf(n.id);

		// Header: name, solid/hole, color
		const nameIn = el('input', { type: 'text', class: 'name-input', value: n.name });
		nameIn.addEventListener('change', () => { n.name = nameIn.value.trim() || n.name; this.commit(); });
		nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') nameIn.blur(); });
		this.fields.push({ refresh: () => { if (document.activeElement !== nameIn) nameIn.value = n.name; } });
		host.appendChild(el('div', { class: 'props-head' }, nameIn, el('span', { class: 'type-badge' }, n.type === 'group' ? 'group' : (SHAPES[n.type] || {}).label || n.type)));
		if (nested) host.appendChild(el('div', { class: 'note' }, 'Part of ', el('b', {}, parent.name), '. Edits rebuild the group. ', el('a', { href: '#', onclick: (e) => { e.preventDefault(); this.setSelection([parent.id]); } }, 'Select group')));

		const solidBtn = el('button', { class: 'seg-btn' + (n.hole ? '' : ' on') }, 'Solid');
		const holeBtn = el('button', { class: 'seg-btn' + (n.hole ? ' on' : '') }, 'Hole');
		solidBtn.onclick = () => { if (n.hole) { n.hole = false; this.commit(); } };
		holeBtn.onclick = () => { if (!n.hole) { n.hole = true; this.commit(); } };
		const color = el('input', { type: 'color', value: n.color, title: 'Color' });
		color.addEventListener('input', () => { n.color = color.value; const d = this.vp.displays.get(n.id); if (d && d.material.color && !n.hole && !d.material.vertexColors) { d.material.color.set(n.color); this.vp.invalidate(); } });
		color.addEventListener('change', () => { n.color = color.value; this.commit(); });
		host.appendChild(el('div', { class: 'props-row' }, el('div', { class: 'seg-ctl' }, solidBtn, holeBtn), n.hole ? '' : color));
		if (!n.hole && !nested) host.appendChild(this.opacityRow([n]));
		if (n.type === 'wizhole') host.appendChild(el('div', { class: 'hole-callout' }, holeCallout(n.params)));
		if (n.hole) this.fitControls(host, n);

		// Shape parameters
		const def = SHAPES[n.type];
		if (n.type === 'group') {
			const sec = this.section(host, 'Group');
			const mode = el('select', {}, el('option', { value: 'union' }, 'Union (solids merged, holes cut)'), el('option', { value: 'intersect' }, 'Intersect (keep overlap only)'), el('option', { value: 'hull' }, 'Hull (wrap / blend together)'), el('option', { value: 'offset' }, 'Offset (grow / shrink)'), el('option', { value: 'texture' }, 'Surface texture'), el('option', { value: 'deform' }, 'Deform (bend, twist, taper, lattice)'), el('option', { value: 'symmetric' }, 'Symmetric (mirror planes through a point)'));
			mode.value = n.mode;
			mode.addEventListener('change', () => { n.mode = mode.value; if (n.mode === 'offset' && !n.offset) n.offset = 1; if (n.mode === 'symmetric' && !n.sym) n.sym = { n: 2, axis: [0, 0, 1], angle: 0, center: [0, 0, 0] }; if (n.mode !== 'deform' && this.lattice && this.lattice.node === n) this.stopLattice(); this.propSig = null; this.commit(); });
			sec.appendChild(el('label', { class: 'field wide' }, el('span', {}, 'Mode'), mode));
			if (n.mode === 'offset') {
				const inp = this.numInput(n.offset || 0, (v, expr) => { n.offset = v || 0.01; this.setExpr(n, 'offset', expr); this.commit(); }, 0.1, { expr: () => (n.exprs || {}).offset || null });
				this.fields.push({ refresh: () => inp._setValue(n.offset) });
				sec.appendChild(el('label', { class: 'field' }, el('span', { class: 'lbl' }, 'Offset distance'), inp));
			}
			if (n.mode === 'texture' || n.mode === 'deform') this.modifierProps(sec, n);
			if (n.mode === 'symmetric') this.symmetryProps(host, n);
			sec.appendChild(el('div', { class: 'muted small pad-x' }, `${n.children.length} parts · ${n.children.filter((c) => c.hole).length} holes`));
			sec.appendChild(el('div', { class: 'btn-row' },
				el('button', { class: 'btn', onclick: () => { n.expanded = true; this.renderTree(); } }, 'Show parts'),
				el('button', { class: 'btn', onclick: () => this.ungroup() }, 'Ungroup')));
			// sketches inside the group (at any depth): one click back into each
			const sketches = [];
			const findSketches = (g) => { for (const c of g.children || []) { if (c.type === 'sketch') sketches.push(c); else findSketches(c); } };
			findSketches(n);
			if (sketches.length) {
				const sk = this.section(host, sketches.length > 1 ? `Sketches (${sketches.length})` : 'Sketch');
				sk.appendChild(el('div', { class: 'btn-row wrap' }, ...sketches.slice(0, 12).map((c) => el('button', { class: 'btn sm', title: 'Reopen this sketch and keep working on it (or double-click the shape in the view)', onclick: () => this.editSketch(c) }, `✎ ${c.name}`))));
				if (sketches.length > 12) sk.appendChild(el('div', { class: 'muted small pad-x' }, `…and ${sketches.length - 12} more in Objects`));
			}
			if (n.shell) {
				const ss = this.section(host, 'Shell');
				const tIn = this.numInput(n.shell.t, (v) => { if (v > 0) this.reshell(n, { t: v }); }, 0.5);
				const rIn = this.numInput(n.shell.r || 0, (v) => { if (v >= 0) this.reshell(n, { r: v }); }, 0.5);
				ss.appendChild(el('label', { class: 'field' }, el('span', { class: 'lbl' }, 'Wall thickness'), tIn));
				ss.appendChild(el('label', { class: 'field' }, el('span', { class: 'lbl' }, 'Inside corner radius'), rIn));
			}
			this.paramsSection(host, n);
		} else if (def && def.params.length) {
			const sec = this.section(host, 'Dimensions');
			if (n.type === 'sketch') {
				sec.appendChild(el('div', { class: 'btn-row' }, el('button', { class: 'btn', title: 'Download this sketch as DXF', onclick: () => this.exportSketchVector(n, 'dxf') }, 'DXF'), el('button', { class: 'btn', title: 'Download this sketch as SVG', onclick: () => this.exportSketchVector(n, 'svg') }, 'SVG')));
			sec.appendChild(el('div', { class: 'btn-row' }, el('button', { class: 'btn primary', onclick: () => this.editSketch(n) }, 'Edit sketch…'), el('span', { class: 'muted small' }, `${(n.params.points || n.params.pts || []).length} points`)));
			}
			for (const p of def.params) {
				if (n.type === 'sketch' && ((p.key === 'height' && n.params.mode === 'revolve') || ((p.key === 'angle' || p.key === 'seg') && n.params.mode !== 'revolve'))) continue;
				sec.appendChild(this.paramField(n, p));
			}
			if (n.type === 'gear') {
				const info = el('div', { class: 'muted small pad-x' });
				const upd = () => { const m = n.params.module, z = n.params.teeth; info.textContent = `Pitch Ø ${fmt(m * z, 2)} · Outside Ø ${fmt(m * z + 2 * m, 2)} · Mesh center distance = (z1+z2)·m/2`; };
				upd();
				this.fields.push({ refresh: upd });
				sec.appendChild(info);
			}
			if (n.type === 'thread') sec.appendChild(el('div', { class: 'muted small pad-x' }, 'For a nut/tapped hole, set as Hole with +0.1–0.3 mm clearance. For a bolt, use −0.1 mm.'));
		} else if (n.type === 'mesh') {
			const g = this.engine.geometry(n);
			this.section(host, 'Mesh').appendChild(el('div', { class: 'muted small pad-x' }, g ? `${(g.attributes.position.count / 3).toLocaleString()} triangles` : 'Missing mesh data'));
		}
		this.sculptProps(host, n);

		// Transform
		const tr = this.section(host, nested ? 'Transform (in group)' : 'Transform');
		tr.appendChild(this.vecField('Position', n, 'pos', 1, true));
		tr.appendChild(this.vecField('Rotation °', n, 'rot', 1));
		tr.appendChild(this.sizeField(n));
		tr.appendChild(this.vecField('Scale', n, 'scale', 0.01));
		tr.appendChild(el('div', { class: 'btn-row wrap' },
			!nested ? el('button', { class: 'btn sm', onclick: () => this.dropToBed() }, 'Drop to bed') : null,
			!nested ? el('button', { class: 'btn sm', onclick: () => this.centerOnBed() }, 'Center on bed') : null,
			el('button', { class: 'btn sm', onclick: () => { n.rot = [0, 0, 0]; this.commit(); } }, 'Reset rotation'),
			el('button', { class: 'btn sm', title: 'Bake scale into the shape dimensions where possible', onclick: () => { bakeScale(n, true); this.commit(); } }, 'Apply scale')));
	}

	/** See-through switch and opacity slider for solid parts (only changes how they're drawn, never the print). */
	opacityRow(nodes) {
		// undo swaps in fresh node objects, so look the parts up by id each time
		const ids = nodes.map((m) => m.id), live = () => ids.map((id) => this.model.get(id)).filter(Boolean);
		const n = nodes[0];
		const on = nodes.every((m) => m.seeThrough);
		const pct = (v) => Math.round(v * 100) + '%';
		const level = typeof n.opacity === 'number' ? n.opacity : 0.5;
		const sw = el('input', { type: 'checkbox', ...(on ? { checked: true } : {}) });
		const slider = el('input', { type: 'range', min: 0.05, max: 1, step: 0.05, value: level, title: 'Opacity', ...(on ? {} : { disabled: true }) });
		const out = el('span', { class: 'op-val' }, pct(level));
		sw.addEventListener('change', () => {
			slider.disabled = !sw.checked;
			for (const m of live()) { m.seeThrough = sw.checked; if (typeof m.opacity !== 'number') m.opacity = +slider.value; }
			this.commit();
		});
		slider.addEventListener('input', () => {
			out.textContent = pct(+slider.value);
			for (const m of live()) { m.opacity = +slider.value; this.vp.previewOpacity(m); }
		});
		slider.addEventListener('change', () => { for (const m of live()) m.opacity = +slider.value; this.commit(); });
		this.fields.push({ refresh: () => {
			const cur = live();
			if (!cur.length) return;
			sw.checked = cur.every((m) => m.seeThrough);
			slider.disabled = !sw.checked;
			const v = cur[0].opacity;
			if (document.activeElement !== slider && typeof v === 'number') { slider.value = v; out.textContent = pct(v); }
		} });
		return el('div', { class: 'props-row op-row', title: 'Draw the part see-through so you can see inside or behind it. Only changes the view; exports and prints are unaffected.' },
			el('label', { class: 'switch' }, sw, el('span', { class: 'knob' }), el('span', {}, 'See-through')), slider, out);
	}

	renderMultiProps(host, nodes) {
		host.appendChild(el('div', { class: 'props-head' }, el('b', {}, `${nodes.length} objects selected`)));
		const solidBtn = el('button', { class: 'seg-btn' + (nodes.every((n) => !n.hole) ? ' on' : '') }, 'Solid');
		const holeBtn = el('button', { class: 'seg-btn' + (nodes.every((n) => n.hole) ? ' on' : '') }, 'Hole');
		solidBtn.onclick = () => { nodes.forEach((n) => (n.hole = false)); this.commit(); };
		holeBtn.onclick = () => { nodes.forEach((n) => (n.hole = true)); this.commit(); };
		const color = el('input', { type: 'color', value: nodes[0].color, title: 'Color for all' });
		color.addEventListener('change', () => { nodes.forEach((n) => (n.color = color.value)); this.commit(); });
		host.appendChild(el('div', { class: 'props-row' }, el('div', { class: 'seg-ctl' }, solidBtn, holeBtn), color));
		const solids = nodes.filter((n) => !n.hole && this.model.isTopLevel(n.id));
		if (solids.length) host.appendChild(this.opacityRow(solids));
		const holes = nodes.filter((n) => n.hole && !n.locked);
		if (holes.length) this.fitControls(this.section(host, `Fit — ${holes.length} hole${holes.length > 1 ? 's' : ''}`), holes);
		const cb = this.section(host, 'Combine');
		cb.appendChild(el('div', { class: 'btn-row wrap' },
			el('button', { class: 'btn primary', onclick: () => this.group('union') }, 'Group'),
			el('button', { class: 'btn', onclick: () => this.group('intersect') }, 'Intersect'),
			el('button', { class: 'btn', title: 'Wrap one skin around the shapes, blending them together (Ctrl+H)', onclick: () => this.group('hull') }, 'Hull')));
		cb.appendChild(el('div', { class: 'muted small pad-x' }, 'Group merges solids and cuts away anything marked as a hole.'));
		const al = this.section(host, 'Align');
		const ab = (label, title, fn) => el('button', { class: 'btn sm', title, onclick: fn }, label);
		for (const [ax, names] of [['x', ['Left', 'Center', 'Right']], ['y', ['Front', 'Center', 'Back']], ['z', ['Bottom', 'Middle', 'Top']]]) {
			al.appendChild(el('div', { class: 'align-row' }, el('span', { class: 'ax ax-' + ax }, ax.toUpperCase()),
				ab(names[0], `Align ${ax.toUpperCase()} min`, () => this.align(ax, 'min')),
				ab(names[1], `Align ${ax.toUpperCase()} center`, () => this.align(ax, 'center')),
				ab(names[2], `Align ${ax.toUpperCase()} max`, () => this.align(ax, 'max')),
				ab('⇹', `Space evenly along ${ax.toUpperCase()} (equal gaps)`, () => this.distribute(ax))));
		}
		al.appendChild(el('div', { class: 'btn-row' }, el('button', { class: 'btn', title: 'Equal gaps or center-to-center spacing, fit or exact distance (Shift+L)', onclick: () => this.spaceDialog() }, 'Space evenly…')));
		const tr = this.section(host, 'Move selection');
		const box = this.vp.selectionBox();
		const pos = box.isEmpty() ? new THREE.Vector3() : new THREE.Vector3((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, box.min.z);
		const row = el('div', { class: 'vec' });
		['x', 'y', 'z'].forEach((a) => {
			const inp = this.numInput(pos[a], (v) => { const d = new THREE.Vector3(); d[a] = v - pos[a]; nodes.forEach((n) => this.moveWorld(n, d)); this.commit(); }, this.model.settings.snap || 1);
			row.appendChild(el('label', { class: 'vec-c ax-' + a }, el('span', {}, a.toUpperCase()), inp));
		});
		tr.appendChild(el('div', { class: 'field' }, el('span', { class: 'lbl' }, 'Base center'), row));
	}

	section(host, title) {
		const body = el('div', { class: 'sec-body' });
		host.appendChild(el('div', { class: 'sec' }, el('div', { class: 'sec-title' }, title), body));
		return body;
	}

	// A text input that evaluates math, steps with arrows and commits on Enter/blur.
	numInput(value, onCommit, step = 1, opts = {}) {
		const inp = el('input', { type: 'text', class: 'num', value: fmt(value, opts.digits ?? 3) });
		let last = inp.value;
		const getExpr = () => (opts.expr ? opts.expr() : null);
		const mark = () => {
			const ex = getExpr();
			inp.classList.toggle('has-expr', !!ex);
			inp.title = ex ? `ƒ  ${ex}   (click to edit the expression)` : 'Type a number, math (25.4*2, 3/8in) or a variable name';
		};
		mark();
		const commit = () => {
			const raw = inp.value.trim();
			if (raw === last) return;
			const expr = opts.expr && isExpression(raw) ? raw : null;
			const scope = opts.scope || this.propScope || this.varValues || {};
			const v = expr ? evalExpr(raw, scope) : evalExpr(raw);
			if (!isFinite(v)) {
				const why = expr ? exprError(raw, scope) : null;
				if (why) toast(why + (/Unknown name/.test(why) ? ' — add it in Variables (toolbar)' : ''), 'error', 3500);
				inp.classList.add('bad'); setTimeout(() => inp.classList.remove('bad'), 600); inp.value = last; return;
			}
			let x = opts.int ? Math.round(v) : v;
			if (opts.min !== undefined) x = Math.max(opts.min, x);
			if (opts.max !== undefined) x = Math.min(opts.max, x);
			inp.value = last = expr || fmt(x, opts.digits ?? 3);
			onCommit(x, expr);
			mark();
		};
		inp.addEventListener('change', commit);
		inp.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') { commit(); inp.select(); }
			else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
				e.preventDefault();
				const v = evalExpr(inp.value);
				if (!isFinite(v)) return;
				const s = (opts.int ? 1 : step) * (e.shiftKey ? 10 : e.altKey ? 0.1 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
				inp.value = fmt(round(v + s, 6), opts.digits ?? 3);
				commit();
			} else if (e.key === 'Escape') { inp.value = last; inp.blur(); }
		});
		// Select the whole value on focus; swallow the mouseup that would otherwise collapse the selection.
		let justFocused = false;
		inp.addEventListener('focus', () => { const ex = getExpr(); if (ex) inp.value = last = ex; inp.select(); justFocused = true; });
		inp.addEventListener('blur', () => { if (getExpr() && inp.value === last) { inp.value = last = fmt(evalExpr(getExpr(), opts.scope || this.propScope || this.varValues || {}), opts.digits ?? 3); } });
		inp.addEventListener('mouseup', (e) => { if (justFocused) e.preventDefault(); justFocused = false; });
		inp._setValue = (v) => { if (document.activeElement !== inp) { inp.value = last = fmt(v, opts.digits ?? 3); mark(); } };
		return inp;
	}

	// Drag on a label to scrub the attached input.
	scrubbable(label, inp, step) {
		label.classList.add('scrub');
		label.addEventListener('pointerdown', (e) => {
			const start = evalExpr(inp.value);
			if (!isFinite(start)) return;
			const x0 = e.clientX;
			let moved = false;
			label.setPointerCapture(e.pointerId);
			const mv = (ev) => {
				const dx = ev.clientX - x0;
				if (Math.abs(dx) > 2) moved = true;
				if (!moved) return;
				const s = step * (ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1);
				inp.value = fmt(round(start + Math.round(dx / 4) * s, 6), 3);
			};
			const up = () => {
				label.removeEventListener('pointermove', mv);
				label.removeEventListener('pointerup', up);
				if (moved) inp.dispatchEvent(new Event('change'));
			};
			label.addEventListener('pointermove', mv);
			label.addEventListener('pointerup', up);
		});
	}

	paramField(n, p) {
		if (p.type === 'font') return this.fontField(n, p);
		if (p.type === 'select') {
			const s = el('select', {}, ...p.options.map((o) => el('option', { value: o }, o[0].toUpperCase() + o.slice(1))));
			s.value = n.params[p.key];
			s.addEventListener('change', () => { n.params[p.key] = s.value; this.commit(); });
			return el('label', { class: 'field' }, el('span', { class: 'lbl' }, p.label), s);
		}
		if (p.type === 'bool') {
			const c = el('input', { type: 'checkbox', checked: !!n.params[p.key] });
			c.addEventListener('change', () => { n.params[p.key] = c.checked; this.commit(); });
			return el('label', { class: 'field check' }, el('span', { class: 'lbl' }, p.label), c);
		}
		if (p.type === 'text') {
			const t = el('input', { type: 'text', value: n.params[p.key] });
			t.addEventListener('change', () => { n.params[p.key] = t.value; this.commit(); });
			return el('label', { class: 'field' }, el('span', { class: 'lbl' }, p.label), t);
		}
		const step = p.type === 'int' ? 1 : Math.max(this.model.settings.snap || 1, 0.1) >= 1 ? 1 : 0.1;
		const path = 'params.' + p.key;
		const inp = this.numInput(n.params[p.key], (v, expr) => { n.params[p.key] = v; this.setExpr(n, path, expr); this.commit(); }, step, { int: p.type === 'int', min: p.min, max: p.max, expr: () => (n.exprs || {})[path] || null });
		this.fields.push({ refresh: () => inp._setValue(n.params[p.key]) });
		const lbl = el('span', { class: 'lbl' }, p.label);
		this.scrubbable(lbl, inp, p.type === 'int' ? 1 : 0.5);
		return el('label', { class: 'field' }, lbl, inp);
	}

	vecField(label, n, key, step, isPos) {
		const row = el('div', { class: 'vec' });
		['x', 'y', 'z'].forEach((a, i) => {
			const path = key + '.' + i;
			const inp = this.numInput(n[key][i], (v, expr) => {
				if (key === 'scale' && Math.abs(v) < 1e-4) v = 1e-4;
				n[key][i] = v;
				this.setExpr(n, path, expr);
				this.commit();
			}, isPos ? this.model.settings.snap || 1 : key === 'rot' ? this.model.settings.rotSnap || 15 : step, { digits: key === 'scale' ? 4 : 3, expr: () => (n.exprs || {})[path] || null });
			this.fields.push({ refresh: () => inp._setValue(n[key][i]) });
			const lb = el('span', {}, a.toUpperCase());
			this.scrubbable(lb, inp, key === 'scale' ? 0.01 : key === 'rot' ? 1 : 0.5);
			row.appendChild(el('label', { class: 'vec-c ax-' + a }, lb, inp));
		});
		return el('div', { class: 'field' }, el('span', { class: 'lbl' }, label), row);
	}

	sizeField(n) {
		const row = el('div', { class: 'vec' });
		const geomSize = () => {
			const g = this.engine.geometry(n);
			return g ? g.boundingBox.getSize(new THREE.Vector3()) : new THREE.Vector3(1, 1, 1);
		};
		const lock = el('input', { type: 'checkbox', title: 'Keep proportions' });
		lock.checked = !!this.keepRatio;
		lock.addEventListener('change', () => (this.keepRatio = lock.checked));
		['x', 'y', 'z'].forEach((a, i) => {
			const cur = () => geomSize()[a] * Math.abs(n.scale[i]);
			const inp = this.numInput(cur(), (v) => {
				const g = geomSize();
				if (!(g[a] > 0) || !(v > 0)) return;
				const ratio = v / cur();
				if (lock.checked) for (let k = 0; k < 3; k++) n.scale[k] *= ratio;
				else n.scale[i] = Math.sign(n.scale[i] || 1) * (v / g[a]);
				bakeScale(n);
				this.commit();
			}, this.model.settings.snap || 1, { min: 0.001, digits: 2 });
			this.fields.push({ refresh: () => inp._setValue(cur()) });
			row.appendChild(el('label', { class: 'vec-c ax-' + a }, el('span', {}, a.toUpperCase()), inp));
		});
		return el('div', { class: 'field' }, el('span', { class: 'lbl' }, 'Size ', el('label', { class: 'mini-check', title: 'Keep proportions' }, lock, '🔗')), row);
	}

	refreshFields() {
		for (const f of this.fields) f.refresh();
	}

	// ============================================================ stats

	/** Mass properties of the given top-level nodes (cached by geometry keys). */
	massOf(nodes) {
		const solids = nodes.filter((n) => !n.hole && n.visible !== false);
		if (!solids.length) return null;
		const key = solids.map((n) => this.engine.key(n) + n.pos + n.rot + n.scale).join('|');
		if (this.massCache && this.massCache.key === key) return this.massCache.value;
		const geoms = solids.map((n) => this.engine.world(n)).filter(Boolean);
		const value = geoms.length ? massProps(geoms) : null;
		geoms.forEach((g) => g.dispose());
		this.massCache = { key, value };
		return value;
	}

	scheduleStats() {
		clearTimeout(this.statsTimer);
		this.statsTimer = setTimeout(() => this.renderStats(), 120);
	}

	renderStats() {
		const host = $('#stats');
		const s = this.model.settings;
		const sel = this.selectedNodes();
		const nodes = sel.length ? sel.map((n) => this.model.topLevelOf(n.id)).filter((n, i, a) => n && a.indexOf(n) === i) : this.model.nodes.filter((n) => n.visible);
		const st = this.engine.stats(nodes);
		const cm3 = st.volume / 1000;
		const grams = cm3 * s.density;
		const fil = st.volume / (Math.PI * (s.filament / 2) ** 2) / 1000;
		const size = st.box.isEmpty() ? null : st.box.getSize(new THREE.Vector3());
		const b = s.bed;
		const all = this.model.nodes.filter((n) => n.visible && !n.hole);
		const sceneBox = this.engine.stats(all).box;
		const fits = sceneBox.isEmpty() || (sceneBox.min.x >= -b.w / 2 - 0.01 && sceneBox.max.x <= b.w / 2 + 0.01 && sceneBox.min.y >= -b.d / 2 - 0.01 && sceneBox.max.y <= b.d / 2 + 0.01 && sceneBox.max.z <= b.h + 0.01);
		const below = !sceneBox.isEmpty() && sceneBox.min.z < -0.01;
		const floating = !sceneBox.isEmpty() && sceneBox.min.z > 0.01;
		const holes = this.model.nodes.filter((n) => n.visible && n.hole).length;
		host.innerHTML = '';
		const kv = (k, v, cls = '') => el('div', { class: 'kv ' + cls }, el('span', {}, k), el('b', {}, v));
		host.append(
			el('div', { class: 'muted small' }, sel.length ? 'Selection' : 'Whole design (visible)'),
			kv('Size', size ? `${fmt(size.x, 1)} × ${fmt(size.y, 1)} × ${fmt(size.z, 1)} mm` : '—'),
			kv('Volume', cm3 > 0 ? `${fmt(cm3, 2)} cm³` : '—'),
			kv('Weight @100% infill', grams > 0 ? `${fmt(grams, 1)} g` : '—'),
			kv('Filament @100%', fil > 0 ? `${fmt(fil, 2)} m` : '—'),
			kv('Triangles', st.tris ? st.tris.toLocaleString() : '—'),
		);
		const mp = this.massOf(nodes);
		if (mp) {
			const c = mp.com;
			const comBtn = el('button', { class: 'btn sm' + (this.showCOM ? ' on' : ''), title: 'Show the center of mass in the view', onclick: () => { this.showCOM = !this.showCOM; this.renderStats(); } }, this.showCOM ? 'Hide' : 'Show');
			host.append(
				kv('Surface area', `${fmt(mp.area / 100, 2)} cm²`),
				el('div', { class: 'kv' }, el('span', {}, 'Center of mass'), el('b', { class: 'com' }, `${fmt(c.x, 1)}, ${fmt(c.y, 1)}, ${fmt(c.z, 1)}`), comBtn),
			);
			this.lastMass = mp;
		} else this.lastMass = null;
		this.vp.showCenterOfMass(this.showCOM && mp ? mp : null);
		const warns = [];
		if (!fits) warns.push(['warn', `Design exceeds the ${b.w}×${b.d}×${b.h} mm build volume`]);
		if (below) warns.push(['warn', 'Part of the design is below the bed (press D to drop)']);
		if (floating) warns.push(['info', 'Lowest point is above the bed (press D to drop)']);
		if (mp && Math.abs(mp.minZ) < 0.05 && !mp.stable) warns.push(['warn', mp.footprint.length < 3 ? 'Balances on a point or edge — it will tip over (lay it flat or add a base)' : 'Center of mass is outside the footprint — it may tip over while printing']);
		if (holes) warns.push(['info', `${holes} ungrouped hole${holes > 1 ? 's' : ''} — they cut only when grouped, or with “Merge” on export`]);
		if (!warns.length && all.length) warns.push(['ok', 'Fits the printer bed']);
		for (const [k, t] of warns) host.appendChild(el('div', { class: 'stat-msg ' + k }, t));
	}

	// ============================================================ keyboard

	bindKeys() {
		window.addEventListener('keydown', (e) => {
			const t = e.target;
			if (document.querySelector('.modal-back')) return;
			if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) {
				if (e.key === 'Escape') t.blur();
				return;
			}
			const ctrl = e.ctrlKey || e.metaKey;
			const k = e.key.toLowerCase();
			const snap = this.model.settings.snap || 1;
			const step = snap * (e.shiftKey ? 10 : e.altKey ? 0.1 : 1);
			let handled = true;
			if (ctrl && k === 'z' && !e.shiftKey) this.undo();
			else if (ctrl && (k === 'y' || (k === 'z' && e.shiftKey))) this.redo();
			else if (ctrl && k === 'c') this.copy();
			else if (ctrl && k === 'x') this.cut();
			else if (ctrl && k === 'v') this.paste();
			else if (ctrl && k === 'd') this.duplicate();
			else if (ctrl && k === 'g' && e.shiftKey) this.ungroup();
			else if (ctrl && k === 'g') this.group('union');
			else if (ctrl && k === 'i') this.group('intersect');
			else if (ctrl && k === 'h') this.group('hull');
			else if (ctrl && k === 'a') this.setSelection(this.model.nodes.filter((n) => n.visible && !n.locked).map((n) => n.id));
			else if (ctrl && k === 's') this.saveProject(e.shiftKey);
			else if (ctrl && k === 'o') this.openProject();
			else if (ctrl && k === 'e') this.exportDialog();
			else if (ctrl && (k === '[' || e.code === 'BracketLeft')) this.togglePanel('left');
			else if (ctrl && (k === ']' || e.code === 'BracketRight')) this.togglePanel('right');
			else if (ctrl && k === 'arrowup') this.nudge(0, 0, step);
			else if (ctrl && k === 'arrowdown') this.nudge(0, 0, -step);
			else if (ctrl && k === 'arrowleft') this.rotateSel('z', e.shiftKey ? -90 : -(this.model.settings.rotSnap || 15));
			else if (ctrl && k === 'arrowright') this.rotateSel('z', e.shiftKey ? 90 : this.model.settings.rotSnap || 15);
			else if (ctrl) handled = false;
			else if (k === 'delete' || k === 'backspace') this.deleteSel();
			else if (k === 'escape') { if (this.tool) this.setTool(null); else this.setSelection([]); }
			else if (k.startsWith('arrow')) this.nudgeScreen(k.slice(5), step);
			else if (k === 'pageup') this.nudge(0, 0, step);
			else if (k === 'pagedown') this.nudge(0, 0, -step);
			else if (k === 'w') this.setGizmo('translate');
			else if (k === 'e') this.setGizmo('rotate');
			else if (k === 'r') this.setGizmo('scale');
			else if (k === 'q') this.setGizmo('none');
			else if (k === 'h') this.toggleHole();
			else if (k === 'd') this.dropToBed();
			else if (k === 'c') this.centerOnBed();
			else if (k === 'f') this.frame();
			else if (k === 'm') this.setTool('measure');
			else if (k === 'l' && e.shiftKey) this.spaceDialog();
			else if (k === 'l') this.setTool('align');
			else if (k === 'k') this.setTool('workplane');
			else if (k === 'j') this.setTool('sketchface');
			else if (k === 'g') this.setTool('fillet');
			else if (k === 'u') this.setTool('pushpull');
			else if (k === 'f2') { if (this.sel.length) this.startRename(this.sel[0]); }
			else if (k === 'p') { if (this.sel.length) this.setTool('place'); }
			else if (k === 'o') this.toggleOrtho();
			else if (k === '[' || k === ']') this.rotateSel(e.shiftKey ? 'x' : e.altKey ? 'y' : 'z', k === '[' ? -90 : 90);
			else if (k === '{' || k === '}') this.rotateSel('x', k === '{' ? -90 : 90);
			else if (k === '?') this.helpDialog();
			else if ('0123456'.includes(k) && k.length === 1) this.vp.setView(['iso', 'front', 'back', 'right', 'left', 'top', 'bottom'][Number(k)]);
			else handled = false;
			if (handled) e.preventDefault();
		});
		// Right-click (without drag) on the viewport opens the context menu.
		const canvas = this.vp.canvas;
		let down = null;
		canvas.addEventListener('pointerdown', (e) => { if (e.button === 2) down = { x: e.clientX, y: e.clientY }; });
		canvas.addEventListener('pointerup', (e) => {
			if (e.button !== 2 || !down) return;
			const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4;
			down = null;
			if (moved) return;
			const hits = this.vp.hitsAt(e);
			const top = hits.find((h) => h.depth === 0);
			if (!top) return;
			if (!hits.some((h) => this.sel.includes(h.id))) this.setSelection([top.id]);
			this.contextMenu({ x: e.clientX, y: e.clientY }, hits, this.vp.surfacePoint(e));
		});
	}
}

// Fold scale into shape parameters for shapes where that keeps dimensions meaningful.
function bakeScale(n, force) {
	const before = { ...n.params };
	bakeScaleInner(n, force);
	// Parameters rewritten by the scale bake no longer follow their expressions.
	if (n.exprs) for (const k in before) if (n.params[k] !== before[k] && n.exprs['params.' + k]) { delete n.exprs['params.' + k]; if (!Object.keys(n.exprs).length) delete n.exprs; }
}

// Set a value at "params.w" / "pos.2" style paths (integers stay integers for int parameters).
function setPath(n, path, v) {
	const parts = path.split('.');
	let o = n;
	for (let i = 0; i < parts.length - 1; i++) { o = o[parts[i]]; if (!o) return; }
	const last = parts[parts.length - 1];
	if (parts[0] === 'params') {
		const def = SHAPES[n.type] && SHAPES[n.type].params.find((p) => p.key === last);
		if (def && def.type === 'int') v = Math.round(v);
		if (def && def.min !== undefined && v < def.min) v = def.min;
	}
	o[last] = round(v, 6);
}

function bakeScaleInner(n, force) {
	const [sx, sy, sz] = n.scale.map(Math.abs);
	const sgn = n.scale.map((v) => (v < 0 ? -1 : 1));
	const p = n.params;
	const near = (a, b) => Math.abs(a - b) < 1e-6 * Math.max(1, a, b);
	if (near(sx, 1) && near(sy, 1) && near(sz, 1)) return;
	let done = false;
	const r = (v) => round(v, 3);
	switch (n.type) {
		case 'box': case 'wedge': case 'pyramid':
			p.w = r(p.w * sx); p.d = r(p.d * sy); p.h = r(p.h * sz); done = true; break;
		case 'cylinder': if (near(sx, sy)) { p.r = r(p.r * sx); p.h = r(p.h * sz); done = true; } break;
		case 'cone': if (near(sx, sy)) { p.r1 = r(p.r1 * sx); p.r2 = r(p.r2 * sx); p.h = r(p.h * sz); done = true; } break;
		case 'tube': if (near(sx, sy)) { p.ro = r(p.ro * sx); p.ri = r(p.ri * sx); p.h = r(p.h * sz); done = true; } break;
		case 'prism': if (near(sx, sy)) { p.r = r(p.r * sx); p.h = r(p.h * sz); done = true; } break;
		case 'star': if (near(sx, sy)) { p.ro = r(p.ro * sx); p.ri = r(p.ri * sx); p.h = r(p.h * sz); done = true; } break;
		case 'sphere': case 'hemisphere': if (near(sx, sy) && near(sy, sz)) { p.r = r(p.r * sx); done = true; } break;
		case 'torus': if (near(sx, sy) && near(sy, sz)) { p.R = r(p.R * sx); p.r = r(p.r * sx); done = true; } break;
		case 'text': if (near(sx, sy)) { p.size = r(p.size * sx); p.depth = r(p.depth * sz); done = true; } break;
		case 'sketch':
		{
			const m = toModel(p);
			const curved = m.circles.length || m.segs.some((g) => g.arc);
			const [ax, ay] = p.mode !== 'revolve' ? [sx, sy] : [sx, sz];
			const ok = p.mode !== 'revolve' ? !curved || near(sx, sy) : near(sx, sy) && (!curved || near(sx, sz));
			if (ok) {
				scaleModel(m, ax, ay);
				Object.assign(p, modelToParams(m)); delete p.pts;
				if (p.mode !== 'revolve') p.height = r(p.height * sz);
				done = true;
			}
			break;
		}
		default: break;
	}
	if (done) n.scale = sgn;
	else if (force) toast('This shape keeps a non-uniform scale (its parameters cannot represent it)', 'info');
}

// Boundary edges of the planar face under the cursor, in the face's 2D sketch coordinates.
function faceOutline(mesh, origin, basis) {
	const g = mesh.geometry, pos = g.attributes.position, idx = g.index;
	const M = mesh.matrixWorld, flip = M.determinant() < 0;
	const d0 = basis.n.dot(origin);
	const edges = new Map();
	const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
	const key = (v) => v.x.toFixed(3) + ',' + v.y.toFixed(3) + ',' + v.z.toFixed(3);
	const triCount = idx ? idx.count / 3 : pos.count / 3;
	for (let t = 0; t < triCount; t++) {
		const i0 = idx ? idx.getX(t * 3) : t * 3, i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1, i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
		a.fromBufferAttribute(pos, i0).applyMatrix4(M); b.fromBufferAttribute(pos, i1).applyMatrix4(M); c.fromBufferAttribute(pos, i2).applyMatrix4(M);
		const nrm = b.clone().sub(a).cross(c.clone().sub(a));
		const l = nrm.length();
		if (l < 1e-12) continue;
		nrm.divideScalar(flip ? -l : l);
		if (nrm.dot(basis.n) < 0.999 || Math.abs(basis.n.dot(a) - d0) > 0.01) continue;
		for (const [p, q] of [[a, b], [b, c], [c, a]]) {
			const k1 = key(p), k2 = key(q), k = k1 < k2 ? k1 + '|' + k2 : k2 + '|' + k1;
			const e = edges.get(k);
			if (e) e.count++; else edges.set(k, { count: 1, p: p.clone(), q: q.clone() });
		}
	}
	const out = [];
	const to2 = (v) => { const d = v.clone().sub(origin); return [d.dot(basis.x), d.dot(basis.y)]; };
	for (const e of edges.values()) {
		if (e.count !== 1) continue;
		out.push([...to2(e.p), ...to2(e.q)].map((v) => round(v, 4)));
		if (out.length > 4000) break;
	}
	return out;
}

function dataURLtoBlob(url) {
	const [head, b64] = url.split(',');
	const bin = atob(b64);
	const arr = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
	return new Blob([arr], { type: head.match(/:(.*?);/)[1] });
}

// Small offscreen renderer for shape thumbnails.
class ThumbRenderer {
	constructor() {
		try {
			this.r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
			this.r.debug.checkShaderErrors = false; // see Viewport: checking forces one-at-a-time compiles
		} catch (e) {
			this.r = null;
			return;
		}
		this.r.setPixelRatio(2);
		this.r.setSize(72, 72);
		this.scene = new THREE.Scene();
		this.scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 2));
		const dl = new THREE.DirectionalLight(0xffffff, 1.5);
		dl.position.set(1, -2, 3);
		this.scene.add(dl);
		this.cam = new THREE.PerspectiveCamera(30, 1, 0.1, 5000);
		this.cam.up.set(0, 0, 1);
	}

	render(engine, node) {
		if (!this.r) return '';
		const g = engine.geometry(node);
		if (!g) return '';
		const mat = node.hole
			? new THREE.MeshStandardMaterial({ color: 0xa9bbcf, transparent: true, opacity: 0.8 })
			: new THREE.MeshStandardMaterial({ color: node.color, roughness: 0.5 });
		const m = new THREE.Mesh(g, mat);
		nodeMatrix({ pos: [0, 0, 0], rot: node.rot, scale: node.scale }).decompose(m.position, m.quaternion, m.scale);
		this.scene.add(m);
		const sph = new THREE.Box3().setFromObject(m).getBoundingSphere(new THREE.Sphere());
		const dir = new THREE.Vector3(0.9, -1.3, 0.9).normalize();
		this.cam.position.copy(sph.center).addScaledVector(dir, (sph.radius / Math.sin(15 * DEG)) * 1.05);
		this.cam.lookAt(sph.center);
		this.r.render(this.scene, this.cam);
		const url = this.r.domElement.toDataURL('image/png');
		this.scene.remove(m);
		mat.dispose();
		return url;
	}

	dispose() {
		if (!this.r) return;
		this.r.dispose();
		this.r.forceContextLoss();
		this.r = null;
	}
}

function makeThumbnails(engine, only) {
	const tr = new ThumbRenderer();
	const out = {};
	for (const key in only) out[key] = tr.render(engine, only[key]());
	tr.dispose();
	return out;
}

Object.assign(App.prototype, SplitMixin, VectorMixin, PrintCheckMixin, FitMixin, ConfigMixin, TemplateMixin, VersionMixin, AssemblyMixin, WrapMixin, TimelineMixin, DrawingMixin, FontPickerMixin, HoleWizardMixin, FeaMixin, ArrangeMixin, RoundMixin, ImageImportMixin, MeshImportMixin, ReliefMixin, ClaudeLinkMixin, ModifierMixin, HistoryMixin, PwaMixin, SculptMixin, TabsMixin, RenderMixin, PaintMixin, PrintPrepMixin, SymmetryMixin);

const app = new App();

window.DraftOtter = app;
window.QCAD = app; // alias used by some tests and scripts
window.__lcadTest = { readZip, profileRegions }; // helpers for automated tests
app.init().catch((e) => {
	console.error(e);
	document.body.innerHTML = `<div style="padding:40px;font-family:system-ui;color:#fff;background:#222;height:100vh">DraftOtter failed to start: ${e.message}<br><br>Your browser needs WebGL and WebAssembly support.</div>`;
});
