// 2D sketcher: lines, arcs, circles, rectangles and construction geometry with geometric constraints and
// driving dimensions. Closed loops form the profile; loops/circles inside others become holes.
import { el, evalExpr, isExpression, round, fmt, pickFile, readFile, download, toast } from './util.js';
import { parseSVG, parseDXF, shapesToModel, shapesToDXF, shapesToSVG, modelToShapes } from './vector.js';
import { MODEL_CONSTRAINTS, solveModel, modelDOF, validModelCon } from './constraints.js';
import { toModel, modelToParams, arcInfo, arcMid, segPoints, segInner, splinePoints, bulgeThrough, findLoops, profileRegions } from './sketchModel.js';
import { trim as opTrim, extend as opExtend, offset as opOffset, addSlot } from './sketchops.js';
import { fitCircle2 } from './measureGeo.js';

const poly = (pts) => ({ points: pts, segs: pts.map((_, i) => ({ a: i, b: (i + 1) % pts.length })), circles: [], cons: [], radii: {} });
const PRESETS = {
	Rectangle: () => {
		const m = poly([[-15, -10], [15, -10], [15, 10], [-15, 10]]);
		m.cons = [{ type: 'h', s: [0] }, { type: 'v', s: [1] }, { type: 'h', s: [2] }, { type: 'v', s: [3] }];
		return m;
	},
	'Plate with 2 holes': () => {
		const m = PRESETS.Rectangle();
		m.points.push([-8, 0], [8, 0]);
		m.circles.push({ c: 4, r: 2.5 }, { c: 5, r: 2.5 });
		m.cons.push({ type: 'dia', c: [0], value: 5 }, { type: 'dia', c: [1], value: 5 });
		return m;
	},
	'Rounded slot': () => ({
		points: [[-12, -6], [12, -6], [12, 6], [-12, 6]], segs: [{ a: 0, b: 1 }, { a: 1, b: 2, arc: 1 }, { a: 2, b: 3 }, { a: 3, b: 0, arc: 1 }], circles: [], radii: {},
		cons: [{ type: 'h', s: [0] }, { type: 'h', s: [2] }, { type: 'tangent', s: [0, 1] }, { type: 'tangent', s: [1, 2] }, { type: 'tangent', s: [2, 3] }, { type: 'tangent', s: [3, 0] }],
	}),
	Washer: () => ({ points: [[0, 0]], segs: [], circles: [{ c: 0, r: 10 }, { c: 0, r: 4.2 }], cons: [], radii: {} }),
	'L-bracket': () => poly([[0, 0], [30, 0], [30, 4], [4, 4], [4, 30], [0, 30]]),
	'T-profile': () => poly([[-15, 0], [15, 0], [15, 4], [3, 4], [3, 25], [-3, 25], [-3, 4], [-15, 4]]),
	'U-channel': () => poly([[-15, 0], [15, 0], [15, 20], [12, 20], [12, 3], [-12, 3], [-12, 20], [-15, 20]]),
	Triangle: () => poly([[-15, 0], [15, 0], [0, 22]]),
	'Vase (revolve)': () => poly([[0, 0], [14, 0], [16, 8], [12, 25], [9, 35], [11, 45], [10, 45], [8, 35], [11, 25], [14, 8], [12, 2], [0, 2]]),
	'Pulley (revolve)': () => poly([[3, 0], [15, 0], [15, 2], [12, 5], [12, 7], [15, 10], [15, 12], [3, 12]]),
};

/**
 * initial: sketch params (v2 model or legacy polygon). opts: { snap, scope, isNew, onFace: { target, reference } }.
 * Resolves to new sketch params (+ { op, combine } on a face) or null when canceled.
 */
export function openSketchEditor(initial, opts = {}) {
	if (typeof opts === 'number') opts = { snap: opts };
	const scope = opts.scope || {};
	const onFace = opts.onFace || null;
	return new Promise((resolve) => {
		const st = {
			...toModel(initial || {}),
			mode: initial.mode || 'extrude', height: initial.height ?? 10, angle: initial.angle ?? 360, fillet: initial.fillet ?? 0, seg: initial.seg ?? 64, axisX: +initial.axisX || 0,
			op: 'add', depth: 5, combine: true,
			snap: opts.snap || 1, constructionMode: false,
			tool: (initial.pts || initial.points || []).length ? 'select' : 'line',
			draw: null, mouse: null,
			scale: 6, ox: 0, oy: 0, hover: null,
			sel: { pts: new Set(), segs: new Set(), circles: new Set(), con: -1 },
			bad: [],
		};
		const ref = onFace ? onFace.reference || [] : [];
		const model = () => ({ points: st.points, segs: st.segs, circles: st.circles, cons: st.cons, radii: st.radii });
		const history = [];
		const pushHist = () => { history.push(JSON.stringify(model())); if (history.length > 150) history.shift(); };
		const undo = () => { if (!history.length) return; Object.assign(st, JSON.parse(history.pop())); clearSel(); st.draw = null; solve(); syncText(); draw(); };
		const clearSel = () => { st.sel = { pts: new Set(), segs: new Set(), circles: new Set(), con: -1 }; };
		let hits = [];

		// ------------------------------------------------------------ DOM
		const canvas = el('canvas', { class: 'sk-canvas' });
		const coords = el('div', { class: 'sk-coords' }, '');
		const status = el('div', { class: 'sk-status' });
		const ta = el('textarea', { class: 'sk-points', spellcheck: 'false', title: 'Edit coordinates. Changing the number of lines replaces the sketch with a polygon. Click a line to select that point.' });
		// a layer behind the text box with the same text, where the lines of the selected points are highlighted
		const taHL = el('div', { class: 'sk-points-hl', 'aria-hidden': 'true' });
		const taWrap = el('div', { class: 'sk-points-wrap' }, taHL, ta);
		const consList = el('div', { class: 'sk-cons' });
		const num = (key, label) => {
			const i = el('input', { type: 'text', value: st[key] });
			i.addEventListener('change', () => { const v = evalExpr(i.value, scope); if (isFinite(v)) st[key] = v; i.value = round(st[key], 4); draw(); });
			return el('label', { class: 'sk-field' }, el('span', {}, label), i);
		};
		const opSel = el('select', {},
			...(onFace ? [el('option', { value: 'add' }, 'Extrude out of the face (add)'), el('option', { value: 'cut' }, 'Cut into the face (pocket / hole)')]
				: [el('option', { value: 'extrude' }, 'Extrude'), el('option', { value: 'revolve' }, 'Revolve (around Y axis → Z)')]));
		opSel.value = onFace ? st.op : st.mode;
		// a sketch made on a face stays an extrusion / pocket on that face
		if (opts.lockMode) { opSel.disabled = true; opSel.title = 'This sketch was made on a face: it stays an extrusion from that face'; }
		opSel.addEventListener('change', () => { if (onFace) st.op = opSel.value; else st.mode = opSel.value; syncFields(); draw(); });
		const fH = num('height', opts.heightLabel || 'Extrude height (mm)'), fA = num('angle', 'Revolve angle (°)'), fS = num('seg', 'Revolve segments'), fD = num('depth', 'Depth (mm)');
		const fX = num('axisX', 'Revolve axis at X (mm) — or drag the axis line');
		const combineBox = el('input', { type: 'checkbox', checked: true });
		combineBox.addEventListener('change', () => { st.combine = combineBox.checked; });
		const fC = el('label', { class: 'sk-check' }, combineBox, el('span', {}, onFace ? `Combine with “${onFace.target}”` : ''));
		const syncFields = () => {
			const extr = onFace ? st.op === 'add' : st.mode === 'extrude';
			fH.style.display = extr ? '' : 'none';
			fD.style.display = onFace && st.op === 'cut' ? '' : 'none';
			fA.style.display = fS.style.display = fX.style.display = !onFace && st.mode === 'revolve' ? '' : 'none';
			fC.style.display = onFace ? '' : 'none';
		};
		const presetSel = el('select', {}, el('option', { value: '' }, 'Load preset…'), ...Object.keys(PRESETS).map((k) => el('option', { value: k }, k)));
		presetSel.addEventListener('change', () => {
			if (!presetSel.value) return;
			pushHist();
			Object.assign(st, PRESETS[presetSel.value]());
			if (/revolve/.test(presetSel.value) && !onFace) { st.mode = 'revolve'; opSel.value = 'revolve'; syncFields(); }
			presetSel.value = '';
			clearSel(); st.draw = null; solve(); fit(); syncText(); setTool('select');
		});
		const snapIn = el('input', { type: 'text', value: st.snap, style: 'width:46px' });
		snapIn.addEventListener('change', () => { const v = evalExpr(snapIn.value); st.snap = isFinite(v) && v >= 0 ? v : st.snap; snapIn.value = st.snap; });
		const btn = (label, fn, cls = '', title = '') => el('button', { class: 'btn sm ' + cls, onclick: fn, title }, label);
		const toolBtns = {
			select: btn('➚ Select', () => setTool('select'), '', 'Select (S): pick points, lines, arcs and circles to constrain; drag to move'),
			line: btn('╱ Line', () => setTool('line'), '', 'Line (D): click points; click the first point to close; Enter/Esc ends the chain'),
			arc: btn('◠ Arc', () => setTool('arc'), '', 'Arc (B): click start, click end, move to bend, click to place'),
			circle: btn('◯ Circle', () => setTool('circle'), '', 'Circle (C): click the center, then the radius'),
			rect: btn('▭ Rect', () => setTool('rect'), '', 'Rectangle (Q): click two corners (adds horizontal / vertical constraints)'),
			slot: btn('⊂⊃ Slot', () => setTool('slot'), '', 'Slot (W): click the two end centers, then the width'),
			spline: btn('∿ Spline', () => setTool('spline'), '', 'Spline: click points for a smooth curve; Enter / double-click ends it, clicking the first point closes it'),
			trim: btn('✂ Trim', () => setTool('trim'), '', 'Trim: click the piece of a line, arc or circle to cut away up to where it crosses other geometry'),
			extend: btn('⇥ Extend', () => setTool('extend'), '', 'Extend: click near the free end of a line to stretch it to the next line, arc or circle'),
		};
		const offIn = el('input', { type: 'text', value: '2', style: 'width:42px', title: 'Offset distance (mm). Positive = outward for closed shapes' });
		offIn.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') doOffset(); });
		const consToggle = el('input', { type: 'checkbox' });
		consToggle.addEventListener('change', () => { st.constructionMode = consToggle.checked; });
		const conBtn = (type, label, key) => btn(label, () => addConstraint(type), 'con-btn', `${(MODEL_CONSTRAINTS[type] || {}).label || label}${key ? ` (${key})` : ''}`);
		const conBar = el('div', { class: 'sk-toolbar sk-cons-bar' },
			el('span', { class: 'muted small' }, 'Constrain:'),
			conBtn('h', 'H', 'H'), conBtn('v', 'V', 'V'), conBtn('len', '↔ Length', 'L'), conBtn('radius', 'R / Ø', 'R'), conBtn('angle', '∠ Angle', 'A'),
			conBtn('eq', '= Equal', 'E'), conBtn('par', '∥', 'P'), conBtn('perp', '⊥', 'T'), conBtn('tangent', '⌒ Tangent', 'N'),
			conBtn('coincident', '• Coinc.', 'I'), conBtn('online', '∈ On', 'O'), conBtn('midpoint', 'Mid', 'M'), conBtn('sym', '⇋ Sym.', 'J'), conBtn('concentric', '◎', 'K'),
			conBtn('fix', '⚓', 'F'), conBtn('px', 'X', 'X'), conBtn('py', 'Y', 'Y'),
			btn('◜ Fillet', () => addCornerRadius(), 'con-btn', 'Round the selected corner points'),
			btn('◠⇄╱', () => toggleArc(), 'con-btn', 'Turn the selected lines into arcs (or arcs back into lines)'),
			btn('┄ Constr.', () => toggleConstruction(), 'con-btn', 'Toggle construction for the selected lines / circles (G)'),
			btn('✕', () => deleteSelection(), 'con-btn', 'Delete the selection or constraint (Del)'));

		const dlg = el('div', { class: 'modal-back' },
			el('div', { class: 'modal sketch-modal' },
				el('div', { class: 'modal-head' }, el('h3', {}, onFace ? `Sketch on “${onFace.target}”` : 'Sketch profile'),
					el('span', { class: 'muted' }, 'Closed shapes become solids, shapes inside them become holes · click a dimension to edit it (variables allowed) · wheel zoom · right-drag pan')),
				el('div', { class: 'sk-body' },
					el('div', { class: 'sk-left' },
							el('div', { class: 'sk-toolbar' }, toolBtns.select, toolBtns.line, toolBtns.arc, toolBtns.circle, toolBtns.rect, toolBtns.slot, toolBtns.spline,
								el('span', { class: 'sk-sep' }), toolBtns.trim, toolBtns.extend,
								btn('⧈ Offset', () => doOffset(), '', 'Offset the selected lines, arcs and circles by the distance (select them first)'), offIn,
								ref.length ? btn('⬚ Face edges', () => useFaceEdges(), '', 'Turn the outline of the face you are sketching on into sketch geometry') : null,
								el('span', { class: 'sk-sep' }),
							el('label', { class: 'sk-inline', title: 'New geometry is construction (reference only, not part of the solid)' }, consToggle, ' Construction'),
							presetSel, btn('Undo', () => undo()), btn('Clear', () => { pushHist(); Object.assign(st, { points: [], segs: [], circles: [], cons: [], radii: {} }); clearSel(); st.draw = null; syncText(); draw(); }),
							btn('Fit', () => { fit(); draw(); }), btn('Mirror X', () => mirrorX()),
							btn('Import…', () => importVector(), '', 'Add the outlines of a DXF or SVG file to this sketch'),
							btn('DXF', () => exportVector('dxf'), '', 'Export this sketch as DXF (laser cutting / CNC)'), btn('SVG', () => exportVector('svg'), '', 'Export this sketch as SVG'),
							el('label', { class: 'sk-inline' }, 'Snap ', snapIn, ' mm')),
						conBar,
						el('div', { class: 'sk-canvas-wrap' }, canvas, coords, status)),
					el('div', { class: 'sk-right' },
						el('label', { class: 'sk-field' }, el('span', {}, 'Operation'), opSel),
						fH, fD, fA, fS, fX, fC, num('fillet', 'Round all corners (mm)'),
						el('div', { class: 'sk-field' }, el('span', {}, 'Constraints'), consList),
						el('label', { class: 'sk-field grow' }, el('span', {}, 'Points (x, y per line, mm)'), taWrap),
						el('div', { class: 'sk-actions' }, btn('Cancel', () => close(null)), btn(opts.path ? 'Use as path' : opts.isNew || initial.isNew ? 'Create' : 'Apply', () => ok(), 'primary')))),
			),
		);
		document.body.appendChild(dlg);
		dlg.__sketch = { st, toScr: (p) => toScr(p), hits: () => hits }; // inspection hook for automated tests
		syncFields();
		const ctx = canvas.getContext('2d');

		// the revolve axis line is under the cursor (select tool, nothing else there)
		function axisAt(sx, sy) {
			if (onFace || st.mode !== 'revolve' || st.tool !== 'select') return false;
			if (pointAt(sx, sy) >= 0 || segAt(sx, sy) || hitAt(sx, sy)) return false;
			return Math.abs(sx - toScr([st.axisX || 0, 0])[0]) < 6;
		}

		function setTool(t) {
			st.tool = t;
			st.draw = null;
			for (const k in toolBtns) toolBtns[k].classList.toggle('active', k === t);
			draw();
		}
		function close(v) { window.removeEventListener('keydown', onKey, true); dlg.remove(); resolve(v); }
		function ok() {
			// a path (for a pattern): any lines, arcs, splines or circles will do, open or closed
			if (opts.path) {
				if (!model().segs.length && !model().circles.length) { flash('Draw the path: lines, arcs, a spline or a circle'); return; }
				close(modelToParams(model(), { anchored: true }));
				return;
			}
			if (!profileRegions(model()).length) { flash('No closed shape yet — close a loop of lines/arcs or add a circle'); return; }
			const out = modelToParams(model(), { mode: onFace ? 'extrude' : st.mode, height: onFace && st.op === 'cut' ? st.depth : st.height, angle: st.angle, fillet: st.fillet, seg: st.seg, anchored: true, axisX: round(st.axisX || 0, 4) });
			if (onFace) { out.op = st.op; out.combine = st.combine; }
			close(out);
		}
		function syncText() { ta.value = st.points.map(([x, y]) => `${round(x, 3)}, ${round(y, 3)}`).join('\n'); syncPointsHL(); }

		// which text line holds point i (lines that aren't a point, like blanks, are skipped)
		const pointLines = () => {
			const out = [];
			ta.value.split('\n').forEach((line, li) => { if (line.split(/[,;\s]+/).filter(Boolean).length >= 2) out.push(li); });
			return out;
		};
		let lastHL = '';
		/** Highlight the selected points' lines (and the ends of selected lines/arcs), and bring the first into view. */
		function syncPointsHL() {
			const sel = new Set(st.sel ? st.sel.pts : []);
			if (st.sel) for (const si of st.sel.segs) { const sg = st.segs[si]; if (sg) { sel.add(sg.a); sel.add(sg.b); } }
			const map = pointLines(), lines = ta.value.split('\n');
			const hot = new Set([...sel].map((i) => map[i]).filter((li) => li !== undefined));
			const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
			taHL.innerHTML = lines.map((l, i) => (hot.has(i) ? `<mark>${esc(l) || ' '}</mark>` : esc(l))).join('\n') + '\n';
			taHL.scrollTop = ta.scrollTop;
			const key = [...hot].sort((a, b) => a - b).join(',');
			if (key && key !== lastHL && document.activeElement !== ta) {
				// scroll the text box so the first highlighted line shows
				const first = Math.min(...hot), lh = parseFloat(getComputedStyle(ta).lineHeight) || 15;
				const top = first * lh, pad = parseFloat(getComputedStyle(ta).paddingTop) || 0;
				if (top < ta.scrollTop || top + lh > ta.scrollTop + ta.clientHeight - 2 * pad) ta.scrollTop = Math.max(0, top - ta.clientHeight / 3);
				taHL.scrollTop = ta.scrollTop;
			}
			lastHL = key;
		}
		ta.addEventListener('scroll', () => { taHL.scrollTop = ta.scrollTop; });
		// clicking a line (or moving the cursor onto it) selects that point in the drawing
		const caretSelect = () => {
			const li = ta.value.slice(0, ta.selectionStart).split('\n').length - 1;
			const pi = pointLines().indexOf(li);
			if (pi < 0 || pi >= st.points.length) return;
			clearSel();
			st.sel.pts.add(pi);
			draw();
		};
		ta.addEventListener('click', caretSelect);
		ta.addEventListener('keyup', (e) => { if (/^Arrow(Up|Down)$|^Page|^Home$|^End$/.test(e.key)) caretSelect(); });
		ta.addEventListener('input', () => {
			const pts = [];
			for (const line of ta.value.split(/\n/)) {
				const m = line.split(/[,;\s]+/).filter(Boolean);
				if (m.length >= 2) { const x = evalExpr(m[0], scope), y = evalExpr(m[1], scope); if (isFinite(x) && isFinite(y)) pts.push([x, y]); }
			}
			if (pts.length === st.points.length) st.points = pts; // same topology, new coordinates
			else Object.assign(st, poly(pts));
			draw();
			syncPointsHL();
		});

		// ------------------------------------------------------------ model editing
		const addPoint = (p) => { st.points.push([p[0], p[1]]); return st.points.length - 1; };
		const degree = (pid) => st.segs.filter((s) => s.a === pid || s.b === pid).length;
		function deleteEntities({ pts = [], segs = [], circles = [] }) {
			const P = new Set(pts), S = new Set(segs), C = new Set(circles);
			st.segs.forEach((s, i) => { if (P.has(s.a) || P.has(s.b)) S.add(i); });
			st.circles.forEach((c, i) => { if (P.has(c.c)) C.add(i); });
			// endpoints left without any geometry go too
			const keepRef = new Set();
			st.segs.forEach((s, i) => { if (!S.has(i)) keepRef.add(s.a).add(s.b); });
			st.circles.forEach((c, i) => { if (!C.has(i)) keepRef.add(c.c); });
			for (const i of S) for (const v of [st.segs[i].a, st.segs[i].b]) if (!keepRef.has(v)) P.add(v);
			for (const i of C) if (!keepRef.has(st.circles[i].c)) P.add(st.circles[i].c);
			const pMap = [], sMap = [], cMap = [];
			let k = 0; st.points.forEach((_, i) => { pMap[i] = P.has(i) ? -1 : k++; });
			k = 0; st.segs.forEach((_, i) => { sMap[i] = S.has(i) ? -1 : k++; });
			k = 0; st.circles.forEach((_, i) => { cMap[i] = C.has(i) ? -1 : k++; });
			st.points = st.points.filter((_, i) => pMap[i] >= 0);
			st.segs = st.segs.filter((_, i) => sMap[i] >= 0).map((s) => ({ ...s, a: pMap[s.a], b: pMap[s.b] }));
			st.circles = st.circles.filter((_, i) => cMap[i] >= 0).map((c) => ({ ...c, c: pMap[c.c] }));
			st.cons = st.cons.filter((c) => (c.p || []).every((i) => pMap[i] >= 0) && (c.s || []).every((i) => sMap[i] >= 0) && (c.c || []).every((i) => cMap[i] >= 0))
				.map((c) => ({ ...c, p: (c.p || []).map((i) => pMap[i]), s: (c.s || []).map((i) => sMap[i]), c: (c.c || []).map((i) => cMap[i]) }));
			const r = {};
			for (const key in st.radii) if (pMap[key] >= 0) r[pMap[key]] = st.radii[key];
			st.radii = r;
		}
		// Split segment s at parameter t (0..1); returns the new point index.
		function splitSeg(si, t) {
			const sg = st.segs[si], A = st.points[sg.a], B = st.points[sg.b];
			let P, b1 = 0, b2 = 0;
			if (sg.arc) {
				const { C, R, a0, theta } = arcInfo(A, B, sg.arc);
				const a = a0 + theta * t;
				P = [C[0] + R * Math.cos(a), C[1] + R * Math.sin(a)];
				b1 = Math.tan((theta * t) / 4); b2 = Math.tan((theta * (1 - t)) / 4);
			} else P = [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t];
			const pid = addPoint(P);
			const nb = sg.b;
			sg.b = pid;
			if (sg.arc) sg.arc = b1;
			const ns = { a: pid, b: nb };
			if (b2) ns.arc = b2;
			if (sg.cons) ns.cons = true;
			st.segs.push(ns);
			const nsi = st.segs.length - 1;
			// orientation constraints still hold on both halves; anything about the whole segment is dropped
			const extra = [];
			st.cons = st.cons.filter((c) => {
				if (!(c.s || []).includes(si)) return true;
				if ((c.type === 'h' || c.type === 'v') && c.s.length === 1) { extra.push({ ...c, s: [nsi] }); return true; }
				if (c.type === 'radius' && c.s.length === 1) return true;
				return false;
			});
			st.cons.push(...extra);
			return pid;
		}

		// ------------------------------------------------------------ constraints
		const segLen = (s) => { const g = st.segs[s], A = st.points[g.a], B = st.points[g.b]; return Math.hypot(B[0] - A[0], B[1] - A[1]); };
		const arcRadius = (s) => { const g = st.segs[s]; return arcInfo(st.points[g.a], st.points[g.b], g.arc).R; };
		const sharedPt = (s1, s2) => { const g = st.segs[s1], h = st.segs[s2]; return [g.a, g.b].find((v) => v === h.a || v === h.b); };
		const segAngle = (s1, s2) => {
			const pid = sharedPt(s1, s2);
			if (pid === undefined) return 90;
			const dirAway = (s) => { const g = st.segs[s], o = g.a === pid ? g.b : g.a, P = st.points[pid], Q = st.points[o]; return [Q[0] - P[0], Q[1] - P[1]]; };
			const u = dirAway(s1), w = dirAway(s2);
			return (Math.atan2(Math.abs(u[0] * w[1] - u[1] * w[0]), u[0] * w[0] + u[1] * w[1]) * 180) / Math.PI;
		};
		function solve(held) {
			if (st.cons.length) { const m = model(); const r = solveModel(m, held); Object.assign(st, { points: m.points, segs: m.segs, circles: m.circles }); st.bad = r.bad; }
			else st.bad = [];
		}
		const varIndex = (kind, i) => {
			let k = 2 * st.points.length;
			if (kind === 'arc') { for (let s = 0; s < i; s++) if (st.segs[s].arc) k++; return k; }
			for (const s of st.segs) if (s.arc) k++;
			return k + i;
		};
		function addConstraint(type) {
			const S = [...st.sel.segs], P = [...st.sel.pts], C = [...st.sel.circles];
			const lines = S.filter((s) => !st.segs[s].arc), arcs = S.filter((s) => st.segs[s].arc);
			const add = [];
			const need = (msg) => flash(`${(MODEL_CONSTRAINTS[type] || {}).label || type}: ${msg} (Select tool)`);
			switch (type) {
				case 'h': case 'v':
					for (const s of lines) if (!st.cons.some((c) => (c.type === 'h' || c.type === 'v') && c.s && c.s[0] === s)) add.push({ type, s: [s], p: [] });
					if (!add.length) return need('select one or more lines');
					break;
				case 'len':
					for (const s of lines) add.push({ type, s: [s], p: [], value: round(segLen(s), 3) });
					for (const s of arcs) add.push({ type: 'radius', s: [s], p: [], value: round(arcRadius(s), 3) });
					for (const c of C) add.push({ type: 'dia', c: [c], p: [], s: [], value: round(st.circles[c].r * 2, 3) });
					if (!add.length) return need('select lines (or arcs / circles)');
					break;
				case 'radius':
					for (const s of arcs) add.push({ type: 'radius', s: [s], p: [], value: round(arcRadius(s), 3) });
					for (const c of C) add.push({ type: 'dia', c: [c], p: [], s: [], value: round(st.circles[c].r * 2, 3) });
					if (!add.length) return need('select arcs or circles');
					break;
				case 'angle': {
					let pair = S.length === 2 ? S : null;
					if (!pair && P.length === 1) { const inc = st.segs.map((s, i) => i).filter((i) => st.segs[i].a === P[0] || st.segs[i].b === P[0]); if (inc.length === 2) pair = inc; }
					if (!pair || sharedPt(pair[0], pair[1]) === undefined) return need('select a corner point or two connected segments');
					add.push({ type, s: pair, p: [], value: round(segAngle(pair[0], pair[1]), 2) });
					break;
				}
				case 'eq':
					if (lines.length < 2) return need('select two or more lines');
					for (let k = 1; k < lines.length; k++) add.push({ type, s: [lines[0], lines[k]], p: [] });
					break;
				case 'par': case 'perp':
					if (lines.length !== 2) return need('select exactly two lines');
					add.push({ type, s: lines, p: [] });
					break;
				case 'tangent':
					if (S.length === 2 && sharedPt(S[0], S[1]) !== undefined) add.push({ type, s: S, p: [] });
					else if (lines.length === 1 && C.length === 1) add.push({ type, s: lines, c: C, p: [] });
					else return need('select two connected segments (one an arc), or a line and a circle');
					break;
				case 'coincident':
					if (P.length !== 2) return need('select two points');
					add.push({ type, p: P, s: [] });
					break;
				case 'online':
					if (P.length !== 1 || S.length + C.length !== 1) return need('select one point and one line / arc / circle');
					add.push(C.length ? { type, p: P, c: C, s: [] } : { type, p: P, s: S });
					break;
				case 'midpoint':
					if (P.length !== 1 || lines.length !== 1) return need('select one point and one line');
					add.push({ type, p: P, s: lines });
					break;
				case 'sym':
					if (P.length !== 2 || lines.length !== 1) return need('select two points and the (construction) line to mirror about');
					add.push({ type, p: P, s: lines });
					break;
				case 'concentric':
					if (C.length === 2) add.push({ type, c: C, s: [], p: [] });
					else if (C.length === 1 && arcs.length === 1) add.push({ type, c: C, s: arcs, p: [] });
					else return need('select two circles (or a circle and an arc)');
					break;
				case 'fix':
					for (const i of P) add.push({ type, p: [i], s: [], x: st.points[i][0], y: st.points[i][1] });
					if (!add.length) return need('select one or more points');
					break;
				case 'px': case 'py':
					for (const i of P) add.push({ type, p: [i], s: [], value: round(st.points[i][type === 'px' ? 0 : 1], 3) });
					if (!add.length) return need('select one or more points');
					break;
				default: return;
			}
			pushHist();
			st.cons.push(...add);
			solve();
			syncText();
			draw();
			if (add.length === 1 && MODEL_CONSTRAINTS[add[0].type].value) {
				const idx = st.cons.length - 1;
				requestAnimationFrame(() => { const h = hits.find((x) => x.kind === 'dim' && x.ci === idx); if (h) editValue(h); });
			}
		}
		function addCornerRadius() {
			const P = [...st.sel.pts];
			if (!P.length) { flash('Fillet: select one or more corner points first'); return; }
			const v = evalExpr(prompt('Corner radius (mm) for ' + P.length + ' corner(s):', String(st.radii[P[0]] || 2)) || '', scope);
			if (!isFinite(v)) return;
			pushHist();
			for (const i of P) { if (v > 0) st.radii[i] = v; else delete st.radii[i]; }
			draw();
		}
		function toggleArc() {
			const S = [...st.sel.segs];
			if (!S.length) { flash('Select lines to bend into arcs (or arcs to straighten)'); return; }
			pushHist();
			for (const s of S) {
				const g = st.segs[s];
				if (g.arc) { delete g.arc; st.cons = st.cons.filter((c) => !(c.type === 'radius' && c.s && c.s[0] === s)); }
				else { g.arc = 0.4; st.cons = st.cons.filter((c) => !((c.type === 'h' || c.type === 'v' || c.type === 'len') && c.s && c.s.length === 1 && c.s[0] === s)); }
			}
			solve(); draw();
		}
		function toggleConstruction() {
			const S = [...st.sel.segs], C = [...st.sel.circles];
			if (!S.length && !C.length) { flash('Select lines, arcs or circles to toggle construction'); return; }
			pushHist();
			const on = ![...S.map((s) => st.segs[s]), ...C.map((c) => st.circles[c])].every((x) => x.cons);
			for (const s of S) { if (on) st.segs[s].cons = true; else delete st.segs[s].cons; }
			for (const c of C) { if (on) st.circles[c].cons = true; else delete st.circles[c].cons; }
			draw();
		}
		function deleteSelection() {
			if (st.sel.con >= 0) { pushHist(); st.cons.splice(st.sel.con, 1); st.sel.con = -1; solve(); draw(); return; }
			const any = st.sel.pts.size + st.sel.segs.size + st.sel.circles.size;
			if (!any) return;
			pushHist();
			deleteEntities({ pts: [...st.sel.pts], segs: [...st.sel.segs], circles: [...st.sel.circles] });
			clearSel(); solve(); syncText(); draw();
		}
		function mirrorX() {
			pushHist();
			st.points = st.points.map(([x, y]) => [-x, y]);
			for (const s of st.segs) if (s.arc) s.arc = -s.arc;
			for (const c of st.cons) { if (c.type === 'px') c.value = -c.value; if (c.type === 'fix') c.x = -c.x; }
			solve(); syncText(); draw();
		}

		// Inline editor for a dimension (numbers, math or variables).
		function editValue(h) {
			const c = st.cons[h.ci];
			if (!c) return;
			const inp = el('input', { type: 'text', class: 'sk-dim-edit', value: c.expr || round(c.value, 4) });
			inp.style.left = h.x + h.w / 2 + 'px';
			inp.style.top = h.y + h.h / 2 + 'px';
			canvas.parentElement.appendChild(inp);
			inp.focus(); inp.select();
			let done = false;
			const finish = (save) => {
				if (done) return;
				done = true;
				inp.remove();
				if (!save) return;
				const raw = inp.value.trim();
				const v = evalExpr(raw, scope);
				if (!isFinite(v) || (['len', 'angle', 'radius', 'dia'].includes(c.type) && v <= 0)) { flash('Invalid value: ' + raw); return; }
				pushHist();
				c.value = v;
				if (isExpression(raw)) c.expr = raw; else delete c.expr;
				solve(); syncText(); draw();
			};
			inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
			inp.addEventListener('blur', () => finish(true));
		}

		async function importVector() {
			const files = await pickFile('.dxf,.svg', false);
			const file = files && files[0];
			if (!file) return;
			try {
				const text = await readFile(file, true);
				const sh = /\.svg$/i.test(file.name) ? parseSVG(text) : parseDXF(text);
				const add = shapesToModel(sh);
				if (!add.points.length) { flash('No usable outlines in that file'); return; }
				pushHist();
				const base = st.points.length;
				st.points.push(...add.points);
				st.segs.push(...add.segs.map((s) => ({ ...s, a: s.a + base, b: s.b + base })));
				st.circles.push(...add.circles.map((c) => ({ ...c, c: c.c + base })));
				clearSel(); st.draw = null; st.tool = 'select';
				syncText(); fit(); draw();
				flash(`Imported ${add.segs.length + add.circles.length} lines, arcs and circles from ${file.name}`);
			} catch (e) { console.error(e); flash('Could not read that file: ' + e.message); }
		}
		function exportVector(kind) {
			const sh = modelToShapes(model());
			if (!sh.polylines.length && !sh.circles.length) { flash('Nothing to export yet'); return; }
			const name = (opts.name || 'sketch').replace(/[^\w\- ]+/g, '_');
			if (kind === 'dxf') download(shapesToDXF(sh), name + '.dxf', 'application/dxf');
			else download(shapesToSVG(sh), name + '.svg', 'image/svg+xml');
		}

		let flashTimer = null;
		function flash(msg) { status.textContent = msg; status.className = 'sk-status warn'; clearTimeout(flashTimer); flashTimer = setTimeout(() => updateStatus(), 2800); }
		function updateStatus() {
			const { open } = findLoops(model());
			const regions = profileRegions(model());
			if (st.bad.length) { status.textContent = `⚠ ${st.bad.length} constraint${st.bad.length > 1 ? 's' : ''} can't be satisfied (red) — remove or change one`; status.className = 'sk-status bad'; return; }
			if (!st.points.length) { status.textContent = 'Pick a drawing tool: Line, Arc, Circle or Rectangle'; status.className = 'sk-status'; return; }
			const dof = st.points.length > 250 ? -1 : modelDOF(model()); // DOF is costly on big imported outlines
			const holes = regions.reduce((n, r) => n + r.holes.length, 0);
			const prof = regions.length ? `${regions.length} solid${regions.length > 1 ? 's' : ''}${holes ? ` · ${holes} hole${holes > 1 ? 's' : ''}` : ''}` : 'no closed shape yet';
			status.textContent = `${dof < 0 ? `${st.points.length} points` : dof === 0 ? '✓ Fully constrained' : `${dof} degree${dof > 1 ? 's' : ''} of freedom`} · ${prof}${open ? ` · ${open} open chain${open > 1 ? 's' : ''}` : ''}`;
			status.className = 'sk-status ' + (dof === 0 && !open ? 'good' : open ? 'warn' : '');
		}
		function renderConsList() {
			consList.innerHTML = '';
			if (!st.cons.length && !Object.keys(st.radii).length) { consList.appendChild(el('div', { class: 'muted small' }, 'None yet. Select geometry, then use the Constrain buttons.')); return; }
			st.cons.forEach((c, i) => {
				const info = MODEL_CONSTRAINTS[c.type] || { label: c.type };
				const parts = [];
				if ((c.s || []).length) parts.push((c.s.length > 1 ? 'segs ' : 'seg ') + c.s.map((s) => s + 1).join(' & '));
				if ((c.c || []).length) parts.push('circle ' + c.c.map((x) => x + 1).join(' & '));
				if ((c.p || []).length) parts.push('pt ' + c.p.map((p) => p + 1).join(', '));
				const val = info.value ? ' = ' + (c.expr ? c.expr + ' (' + fmt(c.value, 3) + ')' : fmt(c.value, 3)) + (c.type === 'angle' ? '°' : '') : '';
				const row = el('div', { class: 'sk-con-row' + (st.bad.includes(i) ? ' bad' : '') + (st.sel.con === i ? ' sel' : '') }, el('span', {}, `${info.label} · ${parts.join(' · ')}${val}`));
				const x = el('button', { class: 'icon-btn sm', title: 'Delete constraint', html: '✕' });
				x.addEventListener('click', () => { pushHist(); st.cons.splice(i, 1); st.sel.con = -1; solve(); draw(); });
				row.addEventListener('click', (e) => { if (e.target !== x) { st.sel.con = i; draw(); } });
				row.appendChild(x);
				consList.appendChild(row);
			});
			for (const k in st.radii) consList.appendChild(el('div', { class: 'sk-con-row' }, el('span', {}, `Corner fillet · pt ${+k + 1} = ${fmt(st.radii[k], 3)}`)));
		}

		// ------------------------------------------------------------ view
		const W = () => canvas.clientWidth, H = () => canvas.clientHeight;
		const toScr = ([x, y]) => [W() / 2 + (x - st.ox) * st.scale, H() / 2 - (y - st.oy) * st.scale];
		const toW = (sx, sy) => [(sx - W() / 2) / st.scale + st.ox, -(sy - H() / 2) / st.scale + st.oy];
		const gridSnap = (w, free) => (free || !st.snap ? [round(w[0], 3), round(w[1], 3)] : [round(Math.round(w[0] / st.snap) * st.snap, 4), round(Math.round(w[1] / st.snap) * st.snap, 4)]);
		// Snap to existing sketch points (returns their index), reference corners, then the grid.
		function snapTarget(sx, sy, free, skip = -1) {
			let best = null, bd = 9;
			st.points.forEach((q, i) => { if (i === skip) return; const [x, y] = toScr(q); const d = Math.hypot(x - sx, y - sy); if (d < bd) { bd = d; best = { p: q.slice(), pid: i }; } });
			if (best) return best;
			for (const [a, b, c, d] of ref) for (const q of [[a, b], [c, d]]) { const [x, y] = toScr(q); const dd = Math.hypot(x - sx, y - sy); if (dd < bd) { bd = dd; best = { p: q.slice() }; } }
			return best || { p: gridSnap(toW(sx, sy), free) };
		}
		function fit() {
			const all = [...st.points, ...st.circles.flatMap((c) => { const p = st.points[c.c]; return p ? [[p[0] - c.r, p[1] - c.r], [p[0] + c.r, p[1] + c.r]] : []; }), ...ref.flatMap(([a, b, c, d]) => [[a, b], [c, d]])];
			if (!all.length) { st.scale = 6; st.ox = 0; st.oy = 0; return; }
			let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
			for (const [x, y] of all) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
			if (!onFace && st.mode === 'revolve') { x0 = Math.min(x0, st.axisX || 0); x1 = Math.max(x1, st.axisX || 0); }
			st.ox = (x0 + x1) / 2; st.oy = (y0 + y1) / 2;
			st.scale = Math.min((W() || 600) / Math.max(x1 - x0, 1), (H() || 500) / Math.max(y1 - y0, 1)) * 0.7;
		}
		const segPath = (s) => { const g = st.segs[s]; return [st.points[g.a], ...segInner({ points: st.points }, g, true)]; };

		function draw() {
			syncPointsHL();
			const dpr = window.devicePixelRatio || 1;
			const w = W(), h = H();
			if (canvas.width !== w * dpr || canvas.height !== h * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			ctx.fillStyle = '#121820';
			ctx.fillRect(0, 0, w, h);
			hits = [];
			const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500];
			const g = steps.find((s) => s * st.scale >= 12) || 500;
			const [wx0, wy1] = toW(0, 0), [wx1, wy0] = toW(w, h);
			ctx.lineWidth = 1;
			for (let x = Math.floor(wx0 / g) * g; x <= wx1; x += g) { const sx = Math.round(toScr([x, 0])[0]) + 0.5; ctx.strokeStyle = Math.abs(Math.round(x / g)) % 5 === 0 ? '#2c3a4c' : '#1d2632'; ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, h); ctx.stroke(); }
			for (let y = Math.floor(wy0 / g) * g; y <= wy1; y += g) { const sy = Math.round(toScr([0, y])[1]) + 0.5; ctx.strokeStyle = Math.abs(Math.round(y / g)) % 5 === 0 ? '#2c3a4c' : '#1d2632'; ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(w, sy); ctx.stroke(); }
			const [ax, ay] = toScr([0, 0]);
			if (!onFace && st.mode === 'revolve') {
				// the revolve axis (draggable): what lies left of it is not part of the solid
				const rx = toScr([st.axisX || 0, 0])[0];
				ctx.strokeStyle = '#4ac06055'; ctx.beginPath(); ctx.moveTo(ax, 0); ctx.lineTo(ax, h); ctx.stroke();
				ctx.fillStyle = 'rgba(200,60,60,0.08)'; ctx.fillRect(0, 0, rx, h);
				ctx.lineWidth = st.hover && st.hover.kind === 'axis' || st.dragging === 'axis' ? 2.5 : 1;
				ctx.setLineDash([8, 6]); ctx.strokeStyle = '#e0a040'; ctx.beginPath(); ctx.moveTo(rx, 0); ctx.lineTo(rx, h); ctx.stroke(); ctx.setLineDash([]);
				ctx.lineWidth = 1;
				ctx.fillStyle = '#e0a040'; ctx.fillText(`revolve axis  x = ${fmt(st.axisX || 0, 3)}`, rx + 6, 14);
			} else { ctx.strokeStyle = '#4ac06088'; ctx.beginPath(); ctx.moveTo(ax, 0); ctx.lineTo(ax, h); ctx.stroke(); }
			ctx.strokeStyle = '#e0504a88'; ctx.beginPath(); ctx.moveTo(0, ay); ctx.lineTo(w, ay); ctx.stroke();
			if (ref.length) {
				ctx.setLineDash([5, 4]); ctx.strokeStyle = '#ffa94dcc'; ctx.lineWidth = 1.5; ctx.beginPath();
				for (const [x1, y1, x2, y2] of ref) { const a = toScr([x1, y1]), b = toScr([x2, y2]); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); }
				ctx.stroke(); ctx.setLineDash([]);
			}
			ctx.fillStyle = '#6d86a6'; ctx.font = '11px system-ui, sans-serif'; ctx.fillText(`grid ${g} mm`, 8, h - 8);

			// filled profile (holes cut out)
			const regions = profileRegions(model());
			if (regions.length) {
				ctx.beginPath();
				for (const r of regions) for (const loop of [r.outer, ...r.holes]) loop.forEach((p, i) => { const [sx, sy] = toScr(p); i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); });
				ctx.fillStyle = onFace && st.op === 'cut' ? 'rgba(239,90,79,0.18)' : 'rgba(74,163,255,0.18)';
				ctx.fill('evenodd');
			}
			// segments
			st.segs.forEach((sg, i) => {
				const pts = segPath(i);
				const sel = st.sel.segs.has(i), hov = st.hover && st.hover.kind === 'seg' && st.hover.i === i;
				ctx.setLineDash(sg.cons ? [6, 4] : []);
				ctx.strokeStyle = sel ? '#ffcc33' : hov ? '#a6ece9' : sg.cons ? '#7f93ab' : '#2cc7c2';
				ctx.lineWidth = sel || hov ? 3 : sg.cons ? 1.2 : 2;
				ctx.beginPath(); pts.forEach((p, k) => { const [sx, sy] = toScr(p); k ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); }); ctx.stroke();
				ctx.setLineDash([]);
				if (sg.spl && st.tool === 'select') {
					ctx.fillStyle = '#a6ece9';
					sg.spl.forEach((p, k) => { const [x, y] = toScr(p); const hv = st.hover && st.hover.kind === 'splHandle' && st.hover.i === i && st.hover.k === k; ctx.fillRect(x - (hv ? 5 : 3.5), y - (hv ? 5 : 3.5), hv ? 10 : 7, hv ? 10 : 7); });
				}
				if (sg.arc && st.tool === 'select') {
					const M = toScr(arcMid(st.points[sg.a], st.points[sg.b], sg.arc));
					ctx.fillStyle = st.hover && st.hover.kind === 'arcHandle' && st.hover.i === i ? '#ffcc33' : '#a6ece9';
					ctx.beginPath(); ctx.arc(M[0], M[1], 4, 0, Math.PI * 2); ctx.fill();
				}
			});
			// circles
			st.circles.forEach((c, i) => {
				const P = st.points[c.c];
				if (!P) return;
				const [cx, cy] = toScr(P);
				const sel = st.sel.circles.has(i), hov = st.hover && st.hover.kind === 'circle' && st.hover.i === i;
				ctx.setLineDash(c.cons ? [6, 4] : []);
				ctx.strokeStyle = sel ? '#ffcc33' : hov ? '#a6ece9' : c.cons ? '#7f93ab' : '#2cc7c2';
				ctx.lineWidth = sel || hov ? 3 : c.cons ? 1.2 : 2;
				ctx.beginPath(); ctx.arc(cx, cy, c.r * st.scale, 0, Math.PI * 2); ctx.stroke();
				ctx.setLineDash([]);
			});
			// corner fillets preview
			if (st.fillet > 0 || Object.keys(st.radii).length) {
				ctx.strokeStyle = '#2cc7c277'; ctx.lineWidth = 1;
				for (const r of regions) { ctx.beginPath(); r.outer.forEach((p, i) => { const [sx, sy] = toScr(p); i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); }); ctx.closePath(); ctx.stroke(); }
			}
			drawAnnotations();
			// points
			const used = new Set();
			st.segs.forEach((s) => { if (!s.cons) used.add(s.a).add(s.b); });
			st.circles.forEach((c) => used.add(c.c));
			st.points.forEach((p, i) => {
				const [sx, sy] = toScr(p);
				const sel = st.sel.pts.has(i), hov = st.hover && st.hover.kind === 'pt' && st.hover.i === i;
				ctx.beginPath(); ctx.arc(sx, sy, sel || hov ? 6 : 4, 0, Math.PI * 2);
				ctx.fillStyle = sel ? '#ffcc33' : used.has(i) ? '#dfe8f5' : '#8a9bb0';
				ctx.fill();
				if (st.radii[i]) { ctx.strokeStyle = '#ffcc33'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(sx, sy, 9, 0, Math.PI * 2); ctx.stroke(); }
			});
			drawPreview();
			renderConsList();
			updateStatus();
		}

		function drawPreview() {
			const d = st.draw, m = st.mouse;
			if (!d || !m) return;
			ctx.strokeStyle = '#ffd76a'; ctx.lineWidth = 1.5; ctx.setLineDash(st.constructionMode ? [6, 4] : []);
			const S = (p) => toScr(p);
			ctx.beginPath();
			if (d.kind === 'line' && d.last != null) { const a = S(st.points[d.last]), b = S(m); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); }
			if (d.kind === 'arc' && d.a != null && d.b == null) { const a = S(st.points[d.a]), b = S(m); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); }
			if (d.kind === 'arc' && d.b != null) { const A = st.points[d.a], B = st.points[d.b], bl = bulgeThrough(A, B, m) || 1e-6; [A, ...segPoints(A, B, bl)].forEach((p, i) => { const q = S(p); i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); }); }
			if (d.kind === 'circle' && d.c != null) { const c = st.points[d.c], r = Math.hypot(m[0] - c[0], m[1] - c[1]); const q = S(c); ctx.arc(q[0], q[1], r * st.scale, 0, Math.PI * 2); }
			if (d.kind === 'rect' && d.p0) { const a = S(d.p0), b = S(m); ctx.rect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])); }
			if (d.kind === 'spline' && d.pts.length) {
				const P = [...d.pts, m];
				const curve = P.length > 1 ? [P[0], ...splinePoints(P[0], P[P.length - 1], P.slice(1, -1))] : P;
				curve.forEach((p, i) => { const q = S(p); i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); });
				ctx.stroke(); ctx.beginPath();
				ctx.fillStyle = '#ffd76a';
				for (const p of d.pts) { const q = S(p); ctx.fillRect(q[0] - 3, q[1] - 3, 6, 6); }
			}
			if (d.kind === 'slot' && d.c1) {
				const c2 = d.c2 || m, r = d.c2 ? slotRadius(d.c1, d.c2, m) : 0;
				if (!d.c2 || r < 1e-6) { const a = S(d.c1), b = S(c2); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); }
				else {
					const tmp = { points: [], segs: [], circles: [], cons: [], radii: {} };
					addSlot(tmp, d.c1, d.c2, r);
					for (const g of tmp.segs) { const pts = [tmp.points[g.a], ...segInner(tmp, g, true)]; pts.forEach((p, i) => { const q = S(p); i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); }); }
				}
			}
			ctx.stroke(); ctx.setLineDash([]);
		}

		// Constraint glyphs, dimension labels and plain measurements (click a plain one to make it a dimension).
		function drawAnnotations() {
			const n = st.points.length;
			if (!n) return;
			const cen = st.points.reduce((s, p) => [s[0] + p[0] / n, s[1] + p[1] / n], [0, 0]);
			const outward = (s) => {
				const g = st.segs[s], A = st.points[g.a], B = st.points[g.b];
				const M = g.arc ? arcMid(A, B, g.arc) : [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
				let nx = -(B[1] - A[1]), ny = B[0] - A[0];
				const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l;
				if (g.arc) { const sgn = Math.sign(g.arc); const rx = ny, ry = -nx; nx = rx * sgn; ny = ry * sgn; }
				else if ((M[0] - cen[0]) * nx + (M[1] - cen[1]) * ny < 0) { nx = -nx; ny = -ny; }
				return { m: toScr(M), n: [nx, -ny] };
			};
			const stack = {};
			const label = (x, y, text, opt) => {
				ctx.font = (opt.bold ? '600 ' : '') + '11px system-ui, sans-serif';
				const tw = ctx.measureText(text).width + 10, th = 16;
				if (opt.edge) {
					const { o, k } = opt.edge;
					const d = 9 + Math.abs(o.n[0]) * tw / 2 + Math.abs(o.n[1]) * th / 2 + (k - 1) * (Math.abs(o.n[0]) * tw + Math.abs(o.n[1]) * th + 4);
					x = o.m[0] + o.n[0] * d; y = o.m[1] + o.n[1] * d;
				}
				const bx = x - tw / 2, by = y - th / 2;
				const selC = opt.ci !== undefined && st.sel.con === opt.ci, bad = opt.ci !== undefined && st.bad.includes(opt.ci);
				ctx.fillStyle = bad ? '#5a1d1d' : selC ? '#5a4a10' : opt.bg || '#1b2533';
				ctx.strokeStyle = bad ? '#ef5a4f' : selC ? '#ffcc33' : opt.border || '#3a4b60';
				ctx.lineWidth = 1;
				ctx.beginPath(); ctx.roundRect(bx, by, tw, th, 4); ctx.fill(); ctx.stroke();
				ctx.fillStyle = bad ? '#ffb3ad' : opt.color || '#dfe8f5';
				ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, x, y + 0.5);
				ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
				hits.push({ ...opt, x: bx, y: by, w: tw, h: th });
			};
			const dimOpt = { color: '#ffd76a', border: '#8a6d1f', bold: true };
			const plainOpt = { color: '#8fa3b8', bg: '#151c25', border: '#26313f' };
			const val = (c, unit = '') => (c.expr ? `${c.expr} = ` : '') + fmt(c.value, 2) + unit;
			const dimmedSeg = new Set(), dimmedCircle = new Set();
			const m = model();
			st.cons.forEach((c, ci) => {
				if (!validModelCon(c, m)) return;
				const info = MODEL_CONSTRAINTS[c.type] || {};
				const S = c.s || [], P = c.p || [], C = c.c || [];
				if (c.type === 'len' || (c.type === 'radius' && S.length)) {
					dimmedSeg.add(S[0]);
					const o = outward(S[0]), k = (stack['s' + S[0]] = (stack['s' + S[0]] || 0) + 1);
					label(0, 0, (c.type === 'radius' ? 'R ' : '') + val(c), { kind: 'dim', ci, edge: { o, k }, ...dimOpt });
				} else if (c.type === 'dia' || (c.type === 'radius' && C.length)) {
					dimmedCircle.add(C[0]);
					const cc = st.circles[C[0]], P0 = st.points[cc.c];
					const q = toScr([P0[0] + cc.r * 0.7071, P0[1] + cc.r * 0.7071]);
					label(q[0] + 18, q[1] - 10, (c.type === 'dia' ? 'Ø ' : 'R ') + val(c), { kind: 'dim', ci, ...dimOpt });
				} else if (c.type === 'angle') {
					const pid = sharedPt(S[0], S[1]);
					const q = toScr(st.points[pid]);
					const k = (stack['p' + pid] = (stack['p' + pid] || 0) + 1);
					label(q[0], q[1] - 16 * k, val(c, '°'), { kind: 'dim', ci, ...dimOpt });
				} else if (c.type === 'px' || c.type === 'py') {
					const q = toScr(st.points[P[0]]), k = (stack['p' + P[0]] = (stack['p' + P[0]] || 0) + 1);
					label(q[0], q[1] - 16 * k, (c.type === 'px' ? 'X ' : 'Y ') + val(c), { kind: 'dim', ci, ...dimOpt });
				} else if (S.length && !P.length) {
					for (const s of S) {
						const o = outward(s), k = (stack['s' + s] = (stack['s' + s] || 0) + 1);
						label(0, 0, S.length > 1 || C.length ? info.glyph + (ci + 1) : info.glyph, { kind: 'glyph', ci, edge: { o, k }, color: '#a6ece9' });
					}
				} else if (C.length && !P.length) {
					for (const ix of C) { const q = toScr(st.points[st.circles[ix].c]); label(q[0] + 12, q[1] + 12, info.glyph + (ci + 1), { kind: 'glyph', ci, color: '#a6ece9' }); }
				} else if (P.length) {
					for (const pid of P) {
						const q = toScr(st.points[pid]), k = (stack['p' + pid] = (stack['p' + pid] || 0) + 1);
						label(q[0] + 14, q[1] - 16 * k, info.glyph + (P.length > 1 || S.length || C.length ? ci + 1 : ''), { kind: 'glyph', ci, color: '#a6ece9' });
					}
				}
			});
			if (st.segs.length <= 80) {
				st.segs.forEach((sg, s) => {
					if (dimmedSeg.has(s) || sg.cons) return;
					const L = sg.arc ? arcInfo(st.points[sg.a], st.points[sg.b], sg.arc).R : Math.hypot(st.points[sg.b][0] - st.points[sg.a][0], st.points[sg.b][1] - st.points[sg.a][1]);
					if (!sg.arc && L * st.scale < 34) return;
					const o = outward(s), k = (stack['s' + s] || 0) + 1;
					label(0, 0, (sg.arc ? 'R ' : '') + fmt(L, 2), { kind: sg.arc ? 'plainArc' : 'len', s, edge: { o, k }, ...plainOpt });
				});
			}
			st.circles.forEach((c, i) => {
				if (dimmedCircle.has(i) || c.cons || !st.points[c.c]) return;
				const P0 = st.points[c.c], q = toScr([P0[0] + c.r * 0.7071, P0[1] + c.r * 0.7071]);
				label(q[0] + 18, q[1] - 10, 'Ø ' + fmt(c.r * 2, 2), { kind: 'plainCircle', c: i, ...plainOpt });
			});
		}

		// ------------------------------------------------------------ hit testing
		const pointAt = (sx, sy) => { let best = -1, bd = 9; st.points.forEach((p, i) => { const [x, y] = toScr(p); const d = Math.hypot(x - sx, y - sy); if (d < bd) { bd = d; best = i; } }); return best; };
		const distSeg = (a, b, sx, sy) => {
			const dx = b[0] - a[0], dy = b[1] - a[1];
			const t = Math.max(0, Math.min(1, ((sx - a[0]) * dx + (sy - a[1]) * dy) / (dx * dx + dy * dy || 1)));
			return { d: Math.hypot(a[0] + dx * t - sx, a[1] + dy * t - sy), t };
		};
		// nearest segment within 7 px: { i, t } (t = parameter along the whole segment)
		const segAt = (sx, sy) => {
			let best = null;
			st.segs.forEach((sg, i) => {
				const pts = segPath(i).map(toScr), n = pts.length - 1;
				for (let k = 0; k < n; k++) {
					const r = distSeg(pts[k], pts[k + 1], sx, sy);
					const t = (k + r.t) / n;
					if (r.d < 7 && t > 0.03 && t < 0.97 && (!best || r.d < best.d)) best = { i, t, d: r.d };
				}
			});
			return best;
		};
		const circleAt = (sx, sy) => {
			let best = -1, bd = 7;
			st.circles.forEach((c, i) => { const P = st.points[c.c]; if (!P) return; const [x, y] = toScr(P); const d = Math.abs(Math.hypot(x - sx, y - sy) - c.r * st.scale); if (d < bd) { bd = d; best = i; } });
			return best;
		};
		const arcHandleAt = (sx, sy) => {
			if (st.tool !== 'select') return -1;
			let best = -1, bd = 8;
			st.segs.forEach((sg, i) => { if (!sg.arc) return; const [x, y] = toScr(arcMid(st.points[sg.a], st.points[sg.b], sg.arc)); const d = Math.hypot(x - sx, y - sy); if (d < bd) { bd = d; best = i; } });
			return best;
		};
		const hitAt = (sx, sy) => hits.slice().reverse().find((h) => sx >= h.x && sx <= h.x + h.w && sy >= h.y && sy <= h.y + h.h) || null;
		const local = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

		// Resolve a click to a point index: an existing point, a split of a segment, or a new point.
		function resolvePoint(sx, sy, free) {
			const t = snapTarget(sx, sy, free);
			if (t.pid !== undefined) return t.pid;
			const sh = segAt(sx, sy);
			if (sh && !free) return splitSeg(sh.i, sh.t);
			return addPoint(t.p);
		}
		// Auto horizontal / vertical when a new line is drawn nearly axis-aligned.
		function inferHV(si, free) {
			if (free) return;
			const g = st.segs[si], A = st.points[g.a], B = st.points[g.b];
			const dx = B[0] - A[0], dy = B[1] - A[1], L = Math.hypot(dx, dy);
			if (L < 1e-9) return;
			if (Math.abs(dy) / L < Math.sin((1.5 * Math.PI) / 180)) st.cons.push({ type: 'h', s: [si], p: [] });
			else if (Math.abs(dx) / L < Math.sin((1.5 * Math.PI) / 180)) st.cons.push({ type: 'v', s: [si], p: [] });
		}
		// take over a model edited by sketchops (it may have replaced the arrays)
		const adopt = (m) => { st.points = m.points; st.segs = m.segs; st.circles = m.circles; st.cons = m.cons; st.radii = m.radii; };
		// like segAt, but anywhere along the segment (trim / extend clicks near the ends too)
		const segAtAny = (sx, sy) => {
			let best = null;
			st.segs.forEach((sg, i) => { const pts = segPath(i).map(toScr), n = pts.length - 1; for (let k = 0; k < n; k++) { const r = distSeg(pts[k], pts[k + 1], sx, sy); if (r.d < 8 && (!best || r.d < best.d)) best = { i, t: (k + r.t) / n, d: r.d }; } });
			return best;
		};
		function slotRadius(c1, c2, m, free) {
			const dx = c2[0] - c1[0], dy = c2[1] - c1[1], L = Math.hypot(dx, dy) || 1;
			let r = Math.abs((m[0] - c1[0]) * dy - (m[1] - c1[1]) * dx) / L;
			if (st.snap && !free) r = Math.max(st.snap / 2, Math.round(r / (st.snap / 2)) * (st.snap / 2));
			return r;
		}
		function finishSpline(closed) {
			const d = st.draw;
			st.draw = null;
			if (!d || d.kind !== 'spline' || d.pts.length < 2) { draw(); return; }
			const P = d.pts;
			const pid = (p) => { const i = st.points.findIndex((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 1e-9); return i >= 0 ? i : addPoint(p); };
			const mk = (a, b, spl, sp0, sp1) => { const sg = { a, b, spl: spl.map((p) => p.slice()) }; if (sp0) sg.sp0 = sp0.slice(); if (sp1) sg.sp1 = sp1.slice(); if (st.constructionMode) sg.cons = true; st.segs.push(sg); };
			if (closed && P.length >= 3) {
				// a closed spline is two halves that flow smoothly into each other
				const j = Math.ceil(P.length / 2), a = pid(P[0]), b = pid(P[j]);
				mk(a, b, P.slice(1, j), P[P.length - 1], P[j + 1] || P[0]);
				mk(b, a, P.slice(j + 1), P[j - 1], P[1]);
			} else mk(pid(P[0]), pid(P[P.length - 1]), P.slice(1, -1));
			syncText();
			draw();
		}
		function doOffset() {
			const d = evalExpr(offIn.value, scope);
			if (!isFinite(d) || !d) { flash('Enter a non-zero offset distance'); return; }
			const segs = [...st.sel.segs], circles = [...st.sel.circles];
			if (!segs.length && !circles.length) { flash('Select the lines, arcs or circles to offset first'); return; }
			pushHist();
			const m = model();
			const n = opOffset(m, segs, circles, d);
			adopt(m);
			if (!n) { history.pop(); flash('Could not offset that by ' + d + ' mm'); return; }
			clearSel(); solve(); syncText(); draw();
			flash(`Offset ${n} entit${n > 1 ? 'ies' : 'y'} by ${fmt(d, 3)} mm`);
		}
		function useFaceEdges() {
			pushHist();
			// chain the reference outline; runs that fit a circle become circles
			const pid = (p) => { const i = st.points.findIndex((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 1e-6); return i >= 0 ? i : addPoint(p); };
			const key = (p) => Math.round(p[0] * 1e4) + ',' + Math.round(p[1] * 1e4);
			const adj = new Map(), pts = new Map();
			ref.forEach(([x1, y1, x2, y2], i) => { for (const p of [[x1, y1], [x2, y2]]) { const k = key(p); pts.set(k, p); if (!adj.has(k)) adj.set(k, []); adj.get(k).push(i); } });
			const used = new Set();
			let made = 0;
			ref.forEach((_, s0) => {
				if (used.has(s0)) return;
				used.add(s0);
				const [x1, y1, x2, y2] = ref[s0];
				const loop = [[x1, y1], [x2, y2]];
				let cur = key([x2, y2]);
				for (;;) {
					const nx = (adj.get(cur) || []).find((i) => !used.has(i));
					if (nx === undefined) break;
					used.add(nx);
					const [a1, b1, a2, b2] = ref[nx];
					const next = key([a1, b1]) === cur ? [a2, b2] : [a1, b1];
					loop.push(next);
					cur = key(next);
				}
				const closed = key(loop[0]) === key(loop[loop.length - 1]);
				if (closed) loop.pop();
				const fit = closed && loop.length >= 12 ? fitCircle2(loop) : null;
				if (fit && fit.rms < Math.max(1e-3, fit.r * 0.005)) { st.circles.push({ c: addPoint([fit.cx, fit.cy]), r: fit.r }); made++; return; }
				const ids = loop.map(pid);
				for (let k = 0; k + 1 < ids.length + (closed ? 1 : 0); k++) { st.segs.push({ a: ids[k], b: ids[(k + 1) % ids.length] }); made++; }
			});
			solve(); syncText(); draw();
			flash(`Added ${made} edges from the face outline`);
		}
		const newSeg = (a, b, arc) => { const s = { a, b }; if (arc) s.arc = arc; if (st.constructionMode) s.cons = true; st.segs.push(s); return st.segs.length - 1; };

		canvas.addEventListener('contextmenu', (e) => e.preventDefault());
		canvas.addEventListener('dblclick', () => {
			if (st.draw && st.draw.kind === 'line') { st.draw = { kind: 'line', last: null }; draw(); }
			if (st.draw && st.draw.kind === 'spline') { finishSpline(false); }
		});
		canvas.addEventListener('pointerdown', (e) => {
			const [sx, sy] = local(e);
			canvas.setPointerCapture(e.pointerId);
			if (e.button === 2 || e.button === 1) {
				const start = [e.clientX, e.clientY, st.ox, st.oy];
				const mv = (ev) => { st.ox = start[2] - (ev.clientX - start[0]) / st.scale; st.oy = start[3] + (ev.clientY - start[1]) / st.scale; draw(); };
				const up = () => { canvas.removeEventListener('pointermove', mv); canvas.removeEventListener('pointerup', up); };
				canvas.addEventListener('pointermove', mv);
				canvas.addEventListener('pointerup', up);
				return;
			}
			const additive = e.shiftKey || e.ctrlKey || e.metaKey, free = e.altKey;
			if (axisAt(sx, sy)) {
				pushHist();
				st.dragging = 'axis';
				const mv = (ev) => {
					const [qx] = local(ev);
					let x = toW(qx, 0)[0];
					if (!ev.altKey && st.snap > 0) x = Math.round(x / st.snap) * st.snap;
					st.axisX = round(x, 4);
					fX.querySelector('input').value = round(st.axisX, 4);
					draw();
				};
				const up = () => { st.dragging = false; canvas.removeEventListener('pointermove', mv); canvas.removeEventListener('pointerup', up); draw(); };
				canvas.addEventListener('pointermove', mv);
				canvas.addEventListener('pointerup', up);
				return;
			}
			// labels: edit dimensions, select constraints, turn plain measurements into dimensions
			let h = hitAt(sx, sy);
			if (h && /^(len|plainArc|plainCircle)$/.test(h.kind) && (pointAt(sx, sy) >= 0 || segAt(sx, sy))) h = null;
			if (h && !st.draw) {
				if (h.kind === 'dim') { st.sel.con = h.ci; draw(); editValue(h); return; }
				if (h.kind === 'glyph') { clearSel(); st.sel.con = h.ci; draw(); return; }
				pushHist();
				if (h.kind === 'len') st.cons.push({ type: 'len', s: [h.s], p: [], value: round(segLen(h.s), 3) });
				if (h.kind === 'plainArc') st.cons.push({ type: 'radius', s: [h.s], p: [], value: round(arcRadius(h.s), 3) });
				if (h.kind === 'plainCircle') st.cons.push({ type: 'dia', c: [h.c], s: [], p: [], value: round(st.circles[h.c].r * 2, 3) });
				const ci = st.cons.length - 1;
				draw();
				const nh = hits.find((x) => x.kind === 'dim' && x.ci === ci);
				if (nh) editValue(nh);
				return;
			}
			if (st.tool === 'select') return selectDown(e, sx, sy, additive);
			pushHist();
			const d = st.draw;
			if (st.tool === 'line') {
				const pid = resolvePoint(sx, sy, free);
				if (d && d.last != null && pid !== d.last) {
					const si = newSeg(d.last, pid);
					inferHV(si, free);
					const closes = pid === d.first || degree(pid) > 1;
					st.draw = closes ? { kind: 'line', last: null } : { kind: 'line', last: pid, first: d.first };
					solve();
				} else st.draw = { kind: 'line', last: pid, first: pid };
			} else if (st.tool === 'arc') {
				if (!d || d.a == null) st.draw = { kind: 'arc', a: resolvePoint(sx, sy, free) };
				else if (d.b == null) { const b = resolvePoint(sx, sy, free); if (b !== d.a) st.draw = { kind: 'arc', a: d.a, b }; }
				else {
					const bl = bulgeThrough(st.points[d.a], st.points[d.b], toW(sx, sy)) || 0.4;
					newSeg(d.a, d.b, bl);
					st.draw = null;
					solve();
				}
			} else if (st.tool === 'circle') {
				if (!d || d.c == null) st.draw = { kind: 'circle', c: resolvePoint(sx, sy, free) };
				else {
					const c = st.points[d.c], m = toW(sx, sy);
					let r = Math.hypot(m[0] - c[0], m[1] - c[1]);
					if (st.snap && !free) r = Math.max(st.snap / 2, Math.round(r / (st.snap / 2)) * (st.snap / 2));
					if (r > 1e-6) st.circles.push({ c: d.c, r, ...(st.constructionMode ? { cons: true } : {}) });
					st.draw = null;
				}
			} else if (st.tool === 'slot') {
				const p = snapTarget(sx, sy, free).p;
				if (!d || !d.c1) st.draw = { kind: 'slot', c1: p };
				else if (!d.c2) { if (Math.hypot(p[0] - d.c1[0], p[1] - d.c1[1]) > 1e-6) st.draw = { kind: 'slot', c1: d.c1, c2: p }; }
				else {
					const r = slotRadius(d.c1, d.c2, toW(sx, sy), free);
					if (r > 1e-6) { const m = model(); addSlot(m, d.c1, d.c2, r, st.constructionMode); adopt(m); }
					st.draw = null;
					solve();
				}
			} else if (st.tool === 'spline') {
				const p = snapTarget(sx, sy, free).p;
				if (!d || d.kind !== 'spline') st.draw = { kind: 'spline', pts: [p] };
				else {
					const first = d.pts[0], [fx, fy] = toScr(first);
					if (d.pts.length >= 3 && Math.hypot(fx - sx, fy - sy) < 9) finishSpline(true);
					else if (Math.hypot(p[0] - d.pts[d.pts.length - 1][0], p[1] - d.pts[d.pts.length - 1][1]) > 1e-6) d.pts.push(p);
				}
			} else if (st.tool === 'trim' || st.tool === 'extend') {
				const sh = segAtAny(sx, sy), ci = sh ? -1 : circleAt(sx, sy), Q = toW(sx, sy);
				if (!sh && ci < 0) { flash(st.tool === 'trim' ? 'Click on the piece of a line, arc or circle to trim' : 'Click near the free end of a line'); history.pop(); }
				else {
					const m = model();
					const msg = st.tool === 'trim' ? opTrim(m, sh ? { kind: 'seg', i: sh.i } : { kind: 'circle', i: ci }, Q) : sh ? opExtend(m, sh.i, Q) : 'Only lines can be extended';
					if (msg) { flash(msg); history.pop(); } else { adopt(m); clearSel(); solve(); }
				}
			} else if (st.tool === 'rect') {
				const p = snapTarget(sx, sy, free).p;
				if (!d || !d.p0) st.draw = { kind: 'rect', p0: p };
				else if (Math.abs(p[0] - d.p0[0]) > 1e-6 && Math.abs(p[1] - d.p0[1]) > 1e-6) {
					const [x0, y0] = d.p0, [x1, y1] = p;
					const i0 = addPoint([x0, y0]), i1 = addPoint([x1, y0]), i2 = addPoint([x1, y1]), i3 = addPoint([x0, y1]);
					const s0 = newSeg(i0, i1), s1 = newSeg(i1, i2), s2 = newSeg(i2, i3), s3 = newSeg(i3, i0);
					st.cons.push({ type: 'h', s: [s0], p: [] }, { type: 'v', s: [s1], p: [] }, { type: 'h', s: [s2], p: [] }, { type: 'v', s: [s3], p: [] });
					st.draw = null;
				}
			}
			syncText();
			draw();
		});

		const splHandleAt = (sx, sy) => {
			if (st.tool !== 'select') return null;
			let best = null, bd = 8;
			st.segs.forEach((sg, i) => (sg.spl || []).forEach((p, k) => { const [x, y] = toScr(p); const d = Math.hypot(x - sx, y - sy); if (d < bd) { bd = d; best = { i, k }; } }));
			return best;
		};
		function selectDown(e, sx, sy, additive) {
			const shd = splHandleAt(sx, sy);
			if (shd) { pushHist(); return dragWith(e, (ev, x, y) => { st.segs[shd.i].spl[shd.k] = snapTarget(x, y, ev.altKey).p; }); }
			const ah = arcHandleAt(sx, sy);
			if (ah >= 0) return dragArc(ah, e);
			const pi = pointAt(sx, sy);
			if (pi >= 0) {
				if (additive) { st.sel.pts.has(pi) ? st.sel.pts.delete(pi) : st.sel.pts.add(pi); }
				else if (!st.sel.pts.has(pi)) { clearSel(); st.sel.pts.add(pi); }
				st.sel.con = -1;
				draw();
				return dragPoint(pi, e);
			}
			const sh = segAt(sx, sy);
			const ci = sh ? -1 : circleAt(sx, sy);
			if (sh) {
				if (!additive) clearSel();
				st.sel.segs.has(sh.i) && additive ? st.sel.segs.delete(sh.i) : st.sel.segs.add(sh.i);
			} else if (ci >= 0) {
				if (!additive) clearSel();
				st.sel.circles.has(ci) && additive ? st.sel.circles.delete(ci) : st.sel.circles.add(ci);
				st.sel.con = -1;
				draw();
				return dragCircle(ci, e);
			} else if (!additive) clearSel();
			st.sel.con = -1;
			draw();
		}
		const dragWith = (e, onMove) => {
			let moved = false;
			const t0 = [e.clientX, e.clientY];
			const mv = (ev) => {
				if (!moved && Math.hypot(ev.clientX - t0[0], ev.clientY - t0[1]) < 3) return;
				if (!moved) pushHist();
				moved = true;
				onMove(ev, ...local(ev));
				syncText();
				draw();
			};
			const up = () => { canvas.removeEventListener('pointermove', mv); canvas.removeEventListener('pointerup', up); st.dragging = false; if (moved) solve(); syncText(); draw(); };
			st.dragging = true;
			canvas.addEventListener('pointermove', mv);
			canvas.addEventListener('pointerup', up);
		};
		function dragPoint(i, e) {
			dragWith(e, (ev, sx, sy) => { st.points[i] = snapTarget(sx, sy, ev.altKey, i).p; solve({ points: [i] }); });
		}
		function dragArc(s, e) {
			dragWith(e, (ev, sx, sy) => {
				const g = st.segs[s];
				g.arc = bulgeThrough(st.points[g.a], st.points[g.b], toW(sx, sy)) || 1e-6;
				solve({ vars: [varIndex('arc', s)] });
			});
		}
		function dragCircle(ci, e) {
			dragWith(e, (ev, sx, sy) => {
				const c = st.circles[ci], P = st.points[c.c], m = toW(sx, sy);
				let r = Math.hypot(m[0] - P[0], m[1] - P[1]);
				if (st.snap && !ev.altKey) r = Math.max(st.snap / 2, Math.round(r / (st.snap / 2)) * (st.snap / 2));
				c.r = r;
				solve({ vars: [varIndex('circle', ci)] });
			});
		}

		canvas.addEventListener('pointermove', (e) => {
			const [sx, sy] = local(e);
			const t = snapTarget(sx, sy, e.altKey);
			st.mouse = t.p;
			coords.textContent = `x ${fmt(t.p[0], 2)}   y ${fmt(t.p[1], 2)}`;
			if (st.dragging) return;
			const h = hitAt(sx, sy);
			const sph = splHandleAt(sx, sy);
			if (sph) { st.hover = { kind: 'splHandle', i: sph.i, k: sph.k }; canvas.style.cursor = 'move'; draw(); return; }
			const ah = arcHandleAt(sx, sy), pi = ah >= 0 ? -1 : pointAt(sx, sy);
			const sh = pi < 0 && ah < 0 ? segAt(sx, sy) : null, ci = pi < 0 && !sh && ah < 0 ? circleAt(sx, sy) : -1;
			st.hover = ah >= 0 ? { kind: 'arcHandle', i: ah } : pi >= 0 ? { kind: 'pt', i: pi } : sh ? { kind: 'seg', i: sh.i } : ci >= 0 ? { kind: 'circle', i: ci } : h ? { kind: h.kind } : null;
			if (!st.hover && axisAt(sx, sy)) st.hover = { kind: 'axis' };
			canvas.style.cursor = st.tool !== 'select' ? 'crosshair' : h ? 'pointer' : ah >= 0 || pi >= 0 ? 'move' : sh || ci >= 0 ? 'pointer' : st.hover && st.hover.kind === 'axis' ? 'ew-resize' : 'default';
			draw();
		});
		canvas.addEventListener('wheel', (e) => {
			e.preventDefault();
			const [sx, sy] = local(e);
			const before = toW(sx, sy);
			st.scale = Math.max(0.2, Math.min(400, st.scale * Math.exp(-e.deltaY * 0.0015)));
			const after = toW(sx, sy);
			st.ox += before[0] - after[0]; st.oy += before[1] - after[1];
			draw();
		}, { passive: false });

		function onKey(e) {
			if (e.target === ta || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') { if (e.key === 'Escape' && e.target.tagName !== 'INPUT') close(null); return; }
			const k = e.key.toLowerCase();
			if (k === 'delete' || k === 'backspace') deleteSelection();
			else if (k === 'z' && (e.ctrlKey || e.metaKey)) undo();
			else if (k === 'escape') {
				if (st.draw) { st.draw = null; draw(); }
				else if (st.sel.pts.size || st.sel.segs.size || st.sel.circles.size || st.sel.con >= 0) { clearSel(); draw(); }
				else close(null);
			} else if (k === 'enter') { if (st.draw && st.draw.kind === 'spline') finishSpline(false); else if (st.draw) { st.draw = null; draw(); } else ok(); }
			else if (e.ctrlKey || e.metaKey || e.altKey) return;
			else if (k === 'd') setTool('line');
			else if (k === 'b') setTool('arc');
			else if (k === 'c') setTool('circle');
			else if (k === 'q') setTool('rect');
			else if (k === 'w') setTool('slot');
			else if (k === 's') setTool('select');
			else if (k === 'g') toggleConstruction();
			else if (k === 'h') addConstraint('h');
			else if (k === 'v') addConstraint('v');
			else if (k === 'l') addConstraint('len');
			else if (k === 'r') { if (st.sel.segs.size || st.sel.circles.size) addConstraint('radius'); else addCornerRadius(); }
			else if (k === 'e') addConstraint('eq');
			else if (k === 'p') addConstraint('par');
			else if (k === 't') addConstraint('perp');
			else if (k === 'n') addConstraint('tangent');
			else if (k === 'i') addConstraint('coincident');
			else if (k === 'o') addConstraint('online');
			else if (k === 'm') addConstraint('midpoint');
			else if (k === 'j') addConstraint('sym');
			else if (k === 'k') addConstraint('concentric');
			else if (k === 'a') addConstraint('angle');
			else if (k === 'f') addConstraint('fix');
			else if (k === 'x') addConstraint('px');
			else if (k === 'y') addConstraint('py');
			else return;
			e.preventDefault();
			e.stopPropagation();
		}
		window.addEventListener('keydown', onKey, true);
		solve();
		syncText();
		setTool(st.tool);
		requestAnimationFrame(() => { fit(); draw(); });
		new ResizeObserver(() => draw()).observe(canvas);
	});
}
