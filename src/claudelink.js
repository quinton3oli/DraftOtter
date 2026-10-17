// Claude connection: the page side of the LocalCAD MCP helper (claude/localcad-mcp.mjs). When the user allows it,
// the page connects to the helper on 127.0.0.1 and runs the tools Claude calls (add shapes, sketch, combine,
// screenshot, export, …) on the open design. Every change is a normal commit, so each one can be undone.
import * as THREE from 'three';
import { makeNode, cloneWithNewIds } from './model.js';
import { SHAPES } from './shapes.js';
import { modelToParams, profileRegions } from './sketchModel.js';
import { stlBinary } from './io.js';
import { stepFromPositions } from './step.js';
import { build3MF } from './threemf.js';
import { round, fmt, evalExpr, toast, el } from './util.js';

const PREFS_KEY = 'localcad-claude';
const DEFAULT_PORT = 47821;
const $ = (s) => document.querySelector(s);

function loadPrefs() {
	try { return { on: false, port: DEFAULT_PORT, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; } catch (e) { return { on: false, port: DEFAULT_PORT }; }
}
function savePrefs(p) {
	try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch (e) { /* private window */ }
}

const STATES = {
	off: ['', ''],
	waiting: ['Claude: waiting for the helper', 'Allowed, but the DraftOtter helper isn\'t running. Start Claude Desktop (with the DraftOtter extension) or Claude Code (with the localcad MCP server).'],
	connected: ['Claude connected', 'Claude can work on this design. Click for settings.'],
	working: ['Claude is working…', 'Claude is changing the design. Each change can be undone (Ctrl+Z).'],
	busy: ['Claude: another window is connected', 'Claude is connected to DraftOtter in another tab or window. Close that one (or turn Claude off there) to use this one.'],
};

/** base64 of bytes (ArrayBuffer, typed array or string), in chunks so large files don't overflow the stack. */
function toBase64(data) {
	const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	let s = '';
	for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
	return btoa(s);
}

const r3 = (v) => v.map((x) => round(x, 4));
const boxOut = (b) => (b.isEmpty() ? null : { min: r3(b.min.toArray()), max: r3(b.max.toArray()), size: r3(b.getSize(new THREE.Vector3()).toArray()) });

/** Parameters for reading: big arrays (imported meshes, push/pull outlines) are summarized. */
function compactParams(p) {
	const out = {};
	for (const [k, v] of Object.entries(p || {})) {
		if (k === 'blob') continue;
		if (Array.isArray(v)) {
			const n = JSON.stringify(v).length;
			out[k] = n > 1500 ? `[${v.length} items, not shown]` : v;
		} else if (v && typeof v === 'object') {
			out[k] = JSON.stringify(v).length > 1500 ? '{not shown}' : v;
		} else out[k] = v;
	}
	return out;
}

export const ClaudeLinkMixin = {
	initClaudeLink() {
		this.claude = { prefs: loadPrefs(), ws: null, state: 'off', retry: null, delay: 2000, queue: Promise.resolve() };
		const badge = el('span', { id: 'st-claude', class: 'claude-state', role: 'button', tabindex: 0, onclick: () => this.claudeDialog() });
		$('#status').insertBefore(badge, $('#save-state'));
		this.claudeSetState('off');
		if (this.claude.prefs.on) this.claudeConnect();
	},

	claudeSetState(state) {
		const c = this.claude;
		c.state = state;
		const b = $('#st-claude');
		if (b) {
			b.className = 'claude-state ' + state;
			b.textContent = STATES[state][0];
			b.title = STATES[state][1];
		}
		const live = $('#claude-live');
		if (live) live.textContent = state === 'off' ? 'Off' : STATES[state][0];
	},

	claudeConnect() {
		const c = this.claude;
		clearTimeout(c.retry);
		if (c.ws) { c.ws.onclose = null; try { c.ws.close(); } catch (e) { /* closed */ } c.ws = null; }
		if (!c.prefs.on) { this.claudeSetState('off'); return; }
		if (c.state !== 'busy') this.claudeSetState('waiting');
		let ws;
		try { ws = new WebSocket(`ws://127.0.0.1:${c.prefs.port || DEFAULT_PORT}`); } catch (e) { this.claudeRetry(); return; }
		c.ws = ws;
		ws.onopen = () => {
			c.delay = 2000;
			ws.send(JSON.stringify({ type: 'hello', app: 'LocalCAD', design: this.model.doc.name || 'Untitled' }));
			this.claudeSetState('connected');
		};
		ws.onmessage = (e) => {
			let msg;
			try { msg = JSON.parse(e.data); } catch (err) { return; }
			if (msg.type === 'busy') { this.claudeSetState('busy'); c.delay = 10000; return; }
			if (msg.type === 'call') c.queue = c.queue.then(() => this.claudeRun(ws, msg));
		};
		ws.onclose = () => { if (c.ws === ws) { c.ws = null; if (c.state !== 'busy') this.claudeSetState('waiting'); this.claudeRetry(); } };
	},

	claudeRetry() {
		const c = this.claude;
		clearTimeout(c.retry);
		if (!c.prefs.on) return;
		c.retry = setTimeout(() => this.claudeConnect(), c.delay);
		c.delay = Math.min(10000, c.delay * 1.5);
	},

	async claudeRun(ws, msg) {
		const fn = CLAUDE_TOOLS[msg.tool];
		let reply;
		this.claudeSetState('working');
		try {
			if (!fn) throw new Error(`DraftOtter doesn't know the tool "${msg.tool}" (update DraftOtter to match the helper).`);
			const r = await fn.call(this, msg.args || {});
			reply = { type: 'result', id: msg.id, ok: true, ...r };
		} catch (e) {
			console.warn('Claude tool failed', msg.tool, e);
			reply = { type: 'result', id: msg.id, ok: false, error: e.message || String(e) };
		}
		if (this.claude.ws === ws) this.claudeSetState('connected');
		if (ws.readyState === 1) ws.send(JSON.stringify(reply));
	},

	claudeDialog() {
		const c = this.claude, p = c.prefs;
		// where the helper sits next to this file, for the Claude Code command
		let helper = 'C:\\path\\to\\DraftOtter\\claude\\localcad-mcp.mjs';
		if (location.protocol === 'file:') {
			const dir = decodeURIComponent(location.pathname).replace(/\/[^/]*$/, '');
			helper = /^\/[A-Za-z]:/.test(dir) ? (dir.slice(1) + '/claude/localcad-mcp.mjs').replace(/\//g, '\\') : dir + '/claude/localcad-mcp.mjs';
		}
		const web = location.protocol !== 'file:';
		if (web) helper = 'C:/path/to/localcad-mcp.mjs';
		const cmd = `claude mcp add localcad -- node "${helper}"`;
		const port = el('input', { id: 'claude-port', type: 'text', value: p.port || DEFAULT_PORT, style: 'width:80px' });
		const allow = el('input', { id: 'claude-on', type: 'checkbox', checked: !!p.on });
		const copyBtn = el('button', { class: 'btn sm', type: 'button', onclick: () => { if (navigator.clipboard) navigator.clipboard.writeText(cmd).then(() => toast('Copied', 'ok', 1200), () => toast('Select the command and copy it', 'warn')); } }, 'Copy');
		const form = el('div', { class: 'form claude-form' },
			el('p', {}, 'Let Claude (with your Claude subscription) build and change this design for you: describe a part and Claude adds shapes, sketches and cuts here, checks its work with screenshots, and can export STL files. You see every step, and each one can be undone.'),
			el('label', { class: 'check' }, allow, el('span', {}, 'Allow Claude to connect')),
			el('div', { class: 'kv' }, el('span', {}, 'Status'), el('b', { id: 'claude-live' }, c.state === 'off' ? 'Off' : STATES[c.state][0])),
			el('h4', {}, 'Set up once'),
			web
				? el('p', { class: 'small' }, el('b', {}, 'Claude Desktop: '), 'download ', el('a', { href: 'claude/DraftOtter.mcpb', download: 'DraftOtter.mcpb' }, 'DraftOtter.mcpb'), ' and open it to install the DraftOtter extension (or drag it onto Claude Desktop’s Settings → Extensions).')
				: el('p', { class: 'small' }, el('b', {}, 'Claude Desktop: '), 'open ', el('code', {}, 'DraftOtter.mcpb'), ' (in the ', el('code', {}, 'claude'), ' folder next to DraftOtter.html) to install the DraftOtter extension, or drag it onto Claude Desktop’s Settings → Extensions.'),
			web
				? el('p', { class: 'small' }, el('b', {}, 'Claude Code: '), 'download ', el('a', { href: 'claude/localcad-mcp.mjs', download: 'localcad-mcp.mjs' }, 'localcad-mcp.mjs'), ', then run this once with its path (needs Node.js):')
				: el('p', { class: 'small' }, el('b', {}, 'Claude Code: '), 'run this once (needs Node.js):'),
			el('div', { class: 'claude-cmd' }, el('code', {}, cmd), copyBtn),
			el('p', { class: 'muted small' }, 'Then ask Claude things like “add a 60 × 40 × 3 mm plate with M3 countersunk holes 5 mm from each corner”. Keep this page open while Claude works. Only this computer can connect (127.0.0.1), and only while this box is ticked.'),
			el('details', {}, el('summary', { class: 'small' }, 'Advanced'),
				el('label', { class: 'row' }, el('span', {}, 'Helper port'), port),
				el('p', { class: 'muted small' }, `Change it only if ${DEFAULT_PORT} is taken; set the same port in the extension settings (or LOCALCAD_PORT for Claude Code).`)),
		);
		const apply = () => {
			const v = Math.round(+port.value);
			p.port = v > 1023 && v < 65536 ? v : DEFAULT_PORT;
			p.on = allow.checked;
			savePrefs(p);
			c.delay = 2000;
			this.claudeSetState(p.on ? 'waiting' : 'off');
			this.claudeConnect();
		};
		allow.addEventListener('change', apply);
		port.addEventListener('change', apply);
		this.modal('Connect Claude', form, [{ label: 'Close' }]);
	},

	/** Wait for background builds, so boxes, stats and pictures show the finished design. */
	async claudeSettle() {
		for (let i = 0; i < 50 && this.bgBuild; i++) await this.bgBuild;
	},

	claudeNode(id) {
		const n = id && this.model.get(String(id));
		if (!n) throw new Error(`No object with id "${id}". Call get_design for the current ids.`);
		return n;
	},

	claudeSummary(n, deep = true) {
		const o = { id: n.id, name: n.name, type: n.type };
		if (n.hole) o.hole = true;
		if (n.type === 'group') { o.mode = n.mode; if (n.offset) o.offset = n.offset; if (n.mode === 'texture') o.texture = n.texture; if (n.mode === 'deform') o.deform = compactParams(n.deform); } else o.params = compactParams(n.params);
		o.pos = n.pos; o.rot = n.rot;
		if (n.scale.some((s) => s !== 1)) o.scale = n.scale;
		o.color = n.color;
		if (!n.visible) o.visible = false;
		if (n.locked) o.locked = true;
		if (n.exprs) o.exprs = n.exprs;
		const b = this.vp.objs.has(n.id) ? this.vp.selectionBox([n.id]) : new THREE.Box3();
		o.box = boxOut(b);
		if (n.children && deep) o.children = n.children.map((c) => this.claudeSummary(c, deep));
		return o;
	},

	/** Set shape parameters (validated against the shape's parameter list); strings are expressions of variables. */
	claudeParams(n, params) {
		if (!params) return;
		const defs = (SHAPES[n.type] && SHAPES[n.type].params) || [];
		const raw = n.type === 'mesh' || n.type === 'facex' || n.type === 'faceoff' || n.type === 'facemove' || n.type === 'edgeop';
		for (const [k, v] of Object.entries(params)) {
			const d = defs.find((x) => x.key === k);
			if (!d) {
				if (raw || n.type === 'sketch') throw new Error(`"${k}" can't be set here${n.type === 'sketch' ? ' (use the sketch tool to change the profile)' : ''}.`);
				throw new Error(`${SHAPES[n.type] ? SHAPES[n.type].label : n.type} has no parameter "${k}". It has: ${defs.map((x) => x.key).join(', ')}.`);
			}
			const path = 'params.' + k;
			if (d.type === 'num' || d.type === 'int') {
				let val = v, expr = null;
				if (typeof v === 'string') {
					val = evalExpr(v, this.varValues || {});
					if (!isFinite(val)) throw new Error(`"${v}" (for ${k}) is not a number or a valid expression of the design variables.`);
					if (!/^\s*-?[\d.]+\s*$/.test(v)) expr = v;
				}
				if (typeof val !== 'number' || !isFinite(val)) throw new Error(`${k} must be a number.`);
				if (d.type === 'int') val = Math.round(val);
				if (d.min !== undefined && val < d.min) throw new Error(`${k} (${d.label}) must be at least ${d.min}.`);
				if (d.max !== undefined && val > d.max) throw new Error(`${k} (${d.label}) must be at most ${d.max}.`);
				this.setExpr(n, path, expr);
				n.params[k] = val;
			} else if (d.type === 'select') {
				if (!d.options.includes(v)) throw new Error(`${k} must be one of: ${d.options.join(', ')}.`);
				n.params[k] = v;
			} else if (d.type === 'bool') {
				n.params[k] = !!v;
			} else n.params[k] = String(v);
		}
	},

	claudeTransform(n, a) {
		const v3 = (x, what) => {
			if (!Array.isArray(x) || x.length !== 3 || x.some((q) => typeof q !== 'number' || !isFinite(q))) throw new Error(`${what} must be three numbers [x, y, z].`);
			return x.map((q) => round(q, 6));
		};
		const clear = (key) => { for (let i = 0; i < 3; i++) this.setExpr(n, key + '.' + i, null); };
		if (a.position) { n.pos = v3(a.position, 'position'); clear('pos'); }
		if (a.rotation) { n.rot = v3(a.rotation, 'rotation'); clear('rot'); }
		if (a.scale) {
			const s = v3(a.scale, 'scale');
			if (s.some((q) => q === 0)) throw new Error('scale factors can\'t be 0.');
			n.scale = s; clear('scale');
		}
	},

	/** Put a new node in the design: inside a group, at a given place, or in a free spot on the bed. */
	claudePlace(node, a) {
		if (a.parent) {
			const g = this.claudeNode(a.parent);
			if (g.type !== 'group') throw new Error(`"${g.name}" is not a group.`);
			g.children.push(node);
			this.sel = [node.id];
			this.commit();
		} else if (a.position) {
			this.model.nodes.push(node);
			this.sel = [node.id];
			this.commit();
		} else {
			this.addNode(node);
		}
	},

	claudeSaid(text) {
		toast('Claude: ' + text, 'info', 2200);
	},
};

/** Sketch params from loops ([x, y] or [x, y, bulge] vertices) and circles. */
function sketchModel(loops = [], circles = []) {
	const m = { points: [], segs: [], circles: [], cons: [], radii: {} };
	loops.forEach((loop, li) => {
		if (!Array.isArray(loop) || loop.length < 2) throw new Error(`Loop ${li + 1} needs at least 2 vertices (3 for straight edges).`);
		const base = m.points.length;
		loop.forEach((v, i) => {
			if (!Array.isArray(v) || v.length < 2 || !isFinite(v[0]) || !isFinite(v[1])) throw new Error(`Loop ${li + 1}, vertex ${i + 1} must be [x, y] or [x, y, bulge].`);
			m.points.push([+v[0], +v[1]]);
			const s = { a: base + i, b: base + ((i + 1) % loop.length) };
			if (v[2]) s.arc = +v[2];
			m.segs.push(s);
		});
	});
	for (const c of circles) {
		if (!(c && isFinite(c.x) && isFinite(c.y) && c.r > 0)) throw new Error('Each circle needs x, y and r > 0.');
		m.points.push([+c.x, +c.y]);
		m.circles.push({ c: m.points.length - 1, r: +c.r });
	}
	return m;
}

const CLAUDE_TOOLS = {
	async get_design() {
		await this.claudeSettle();
		const d = this.model.doc, s = this.model.settings;
		return {
			data: {
				name: d.name,
				units: 'mm',
				bed: { ...s.bed, note: 'XY plane at z = 0, centered on the origin' },
				snap: s.snap,
				variables: (d.vars || []).map((v) => ({ name: v.name, expr: v.expr, value: this.varValues ? this.varValues[v.name] : undefined })),
				selection: this.sel.slice(),
				objects: this.model.nodes.map((n) => this.claudeSummary(n)),
				sketch_format: 'sketch objects: points [[x,y]…], segs [{a,b,arc?}] (a,b = point indices, arc = bulge), circles [{c (point index), r}]',
			},
		};
	},

	async list_shape_types({ type }) {
		const out = [];
		for (const [key, def] of Object.entries(SHAPES)) {
			if (def.hidden || (type && key !== type)) continue;
			out.push({
				type: key, label: def.label, ...(def.defaultHole ? { hole_by_default: true } : {}),
				params: def.params.map((p) => {
					const o = { key: p.key, label: p.label, type: p.type, default: p.def };
					if (p.min !== undefined && p.type !== 'select') o.min = p.min;
					if (p.max !== undefined) o.max = p.max;
					if (p.options) o.options = p.options;
					return o;
				}),
			});
		}
		if (type && !out.length) throw new Error(`No shape type "${type}". Call list_shape_types without type to see them all.`);
		return { data: type ? out[0] : { shapes: out, note: 'For custom outlines use the sketch tool. Hex nuts, bolts, washers: thread, prism (sides 6, sizeBy flats), tube.' } };
	},

	async add_shape(a) {
		const def = SHAPES[a.type];
		if (!def || def.hidden) throw new Error(`No shape type "${a.type}". Call list_shape_types to see them (custom outlines: use the sketch tool).`);
		const node = makeNode(a.type, {}, { ...(a.name ? { name: String(a.name) } : {}), ...(a.color ? { color: String(a.color) } : {}), ...(a.hole !== undefined ? { hole: !!a.hole } : {}) });
		this.claudeParams(node, a.params);
		this.claudeTransform(node, a);
		this.claudePlace(node, a);
		await this.claudeSettle();
		this.claudeSaid(`added “${node.name}”`);
		return { data: this.claudeSummary(node) };
	},

	async sketch(a) {
		const opts = {};
		if (a.mode) { if (!['extrude', 'revolve'].includes(a.mode)) throw new Error('mode must be extrude or revolve.'); opts.mode = a.mode; }
		if (a.height !== undefined) { if (!(a.height > 0)) throw new Error('height must be greater than 0.'); opts.height = +a.height; }
		if (a.angle !== undefined) { if (!(a.angle > 0 && a.angle <= 360)) throw new Error('angle must be between 0 and 360.'); opts.angle = +a.angle; }
		if (a.axis_x !== undefined) opts.axisX = +a.axis_x;
		if (a.corner_radius !== undefined) opts.fillet = Math.max(0, +a.corner_radius);
		if (a.edge !== undefined) opts.edge = Math.max(0, +a.edge);
		if (a.edge_type) opts.edgeType = a.edge_type;
		const hasProfile = (a.loops && a.loops.length) || (a.circles && a.circles.length);
		let node = a.id ? this.claudeNode(a.id) : null;
		if (node && node.type !== 'sketch') throw new Error(`"${node.name}" is not a sketch.`);
		if (!node && !hasProfile) throw new Error('Give the profile as loops and/or circles.');
		const base = node ? { ...node.params } : { mode: 'extrude', height: 10, angle: 360, fillet: 0, seg: 64, axisX: 0, anchored: true };
		const params = hasProfile ? modelToParams(sketchModel(a.loops, a.circles), { ...base, ...opts }) : { ...base, ...opts };
		delete params.pts;
		const regions = profileRegions(params);
		if (!regions.length) throw new Error('The profile has no closed loop. Each loop needs 3 or more vertices (or 2 with a bulge), and loops must not cross themselves.');
		if (params.mode === 'revolve') {
			const ax = +params.axisX || 0;
			const xs = regions.flatMap((r) => r.outer.map((q) => q[0] - ax));
			if (Math.min(...xs) < -1e-6 && Math.max(...xs) > 1e-6) throw new Error(`For a revolve the profile must lie on one side of the axis x = ${ax} (it spans x ${fmt(Math.min(...xs) + ax, 3)} to ${fmt(Math.max(...xs) + ax, 3)}).`);
		}
		if (node) {
			delete node.params.pts;
			for (const k of ['points', 'segs', 'circles', 'cons', 'radii']) if (hasProfile) delete node.params[k];
			Object.assign(node.params, params);
			if (a.name) node.name = String(a.name);
			if (a.color) node.color = String(a.color);
			if (a.hole !== undefined) node.hole = !!a.hole;
			this.claudeTransform(node, a);
			this.sel = [node.id];
			this.commit();
		} else {
			node = makeNode('sketch', params, { name: a.name ? String(a.name) : params.mode === 'revolve' ? 'Revolve' : 'Extrude', ...(a.color ? { color: String(a.color) } : {}), ...(a.hole !== undefined ? { hole: !!a.hole } : {}) });
			delete node.params.pts;
			this.claudeTransform(node, a);
			this.claudePlace(node, a);
		}
		await this.claudeSettle();
		if (!this.engine.geometry(node)) throw new Error('The sketch did not make a solid (check that the loops are closed and do not cross).');
		this.claudeSaid(`${a.id ? 'changed' : 'added'} sketch “${node.name}”`);
		return { data: this.claudeSummary(node) };
	},

	async update_object(a) {
		const n = this.claudeNode(a.id);
		if (n.locked && (a.position || a.rotation || a.scale)) throw new Error(`"${n.name}" is locked; ask the user to unlock it first.`);
		if (n.type === 'group' && a.params) throw new Error('Groups have no parameters (change the objects inside, or the group\'s mode).');
		this.claudeParams(n, a.params);
		if (a.name !== undefined) n.name = String(a.name);
		if (a.color) n.color = String(a.color);
		if (a.hole !== undefined) n.hole = !!a.hole;
		if (a.visible !== undefined) n.visible = !!a.visible;
		if (a.mode) {
			if (n.type !== 'group') throw new Error('Only groups have a mode.');
			if (!['union', 'intersect', 'hull'].includes(a.mode)) throw new Error('mode must be union, intersect or hull.');
			n.mode = a.mode;
		}
		this.claudeTransform(n, a);
		this.commit();
		await this.claudeSettle();
		this.claudeSaid(`changed “${n.name}”`);
		return { data: this.claudeSummary(n) };
	},

	async move(a) {
		const nodes = (a.ids || []).map((id) => this.claudeNode(id));
		if (!nodes.length) throw new Error('Give the ids of the objects to move.');
		const locked = nodes.find((n) => n.locked);
		if (locked) throw new Error(`"${locked.name}" is locked.`);
		const by = a.by ? new THREE.Vector3(...a.by) : new THREE.Vector3();
		// work out every object's world offset from the boxes as they are now, then move once (one undo step)
		const boxes = nodes.map((n) => this.worldBox(n));
		const d = nodes.map((n, i) => {
			const v = by.clone();
			if (a.drop_to_bed && !boxes[i].isEmpty()) v.z = -boxes[i].min.z;
			return v;
		});
		if (a.center_on_bed) {
			const all = new THREE.Box3();
			boxes.forEach((b, i) => { if (!b.isEmpty()) all.union(b.clone().translate(d[i])); });
			if (!all.isEmpty()) { const c = all.getCenter(new THREE.Vector3()); d.forEach((v) => v.add(new THREE.Vector3(-c.x, -c.y, -all.min.z))); }
		}
		nodes.forEach((n, i) => { if (d[i].lengthSq() > 0) this.moveWorld(n, d[i]); });
		this.sel = nodes.map((n) => n.id);
		this.commit();
		await this.claudeSettle();
		this.claudeSaid(`moved ${nodes.length > 1 ? nodes.length + ' objects' : '“' + nodes[0].name + '”'}`);
		return { data: nodes.map((n) => this.claudeSummary(n, false)) };
	},

	async combine(a) {
		const nodes = (a.ids || []).map((id) => this.claudeNode(id));
		const mode = a.mode;
		if (!['union', 'cut', 'intersect', 'hull'].includes(mode)) throw new Error('mode must be union, cut, intersect or hull.');
		if (nodes.length < 2 && !(mode === 'hull' && nodes.length === 1)) throw new Error('Combine needs at least two objects.');
		if (new Set(nodes).size !== nodes.length) throw new Error('The same object is listed twice.');
		if (this.siblingsCheck(nodes) === undefined) throw new Error('The objects must be at the same level (all top-level, or all in the same group). Ungroup or move them first.');
		if (mode === 'cut') {
			if (nodes[0].hole) throw new Error(`The first object ("${nodes[0].name}") is the part to keep, but it is a hole.`);
			nodes.slice(1).forEach((n) => { n.hole = true; });
		}
		this.setSelection(nodes.map((n) => n.id));
		this.group(mode === 'cut' ? 'union' : mode, a.name ? String(a.name) : null);
		const g = this.selectedNodes()[0];
		if (!g || g.type !== 'group') throw new Error('Could not combine those objects.');
		await this.claudeSettle();
		if (this.engine.errors && this.engine.errors.has && this.engine.errors.has(g.id)) throw new Error('The boolean operation failed for this group.');
		this.claudeSaid(`${mode === 'cut' ? 'cut' : 'combined'} → “${g.name}”`);
		return { data: this.claudeSummary(g) };
	},

	async ungroup(a) {
		const g = this.claudeNode(a.id);
		if (g.type !== 'group') throw new Error(`"${g.name}" is not a group.`);
		this.setSelection([g.id]);
		this.ungroup();
		await this.claudeSettle();
		this.claudeSaid(`ungrouped “${g.name}”`);
		return { data: this.selectedNodes().map((n) => this.claudeSummary(n, false)) };
	},

	async duplicate(a) {
		const nodes = (a.ids || []).map((id) => this.claudeNode(id));
		if (!nodes.length) throw new Error('Give the ids of the objects to copy.');
		const count = Math.max(1, Math.min(200, Math.round(a.count || 1)));
		const off = new THREE.Vector3(...(a.offset || [0, 0, 0]));
		const made = [];
		for (const n of nodes) {
			const f = this.model.find(n.id);
			// the world offset in the parent group's own axes
			const obj = this.vp.objs.get(n.id), parent = obj && obj.parent;
			const local = (k) => {
				if (!parent) return off.clone().multiplyScalar(k);
				const o = new THREE.Vector3().setFromMatrixPosition(obj.matrixWorld);
				return parent.worldToLocal(o.clone().addScaledVector(off, k)).sub(parent.worldToLocal(o.clone()));
			};
			let at = f.list.indexOf(n) + 1;
			for (let k = 1; k <= count; k++) {
				const c = cloneWithNewIds(n);
				c.locked = false;
				const d = local(k);
				c.pos = c.pos.map((v, i) => round(v + d.getComponent(i), 6));
				if (c.exprs) for (let i = 0; i < 3; i++) this.setExpr(c, 'pos.' + i, null);
				f.list.splice(at++, 0, c);
				made.push(c);
			}
		}
		this.sel = made.map((c) => c.id);
		this.commit();
		await this.claudeSettle();
		this.claudeSaid(`made ${made.length} cop${made.length > 1 ? 'ies' : 'y'}`);
		return { data: made.map((c) => this.claudeSummary(c, false)) };
	},

	async delete_objects(a) {
		const nodes = (a.ids || []).map((id) => this.claudeNode(id));
		if (!nodes.length) throw new Error('Give the ids of the objects to delete.');
		const names = nodes.map((n) => n.name);
		for (const n of nodes) this.model.remove(n.id);
		this.cleanupEmptyGroups();
		this.sel = [];
		this.commit();
		await this.claudeSettle();
		this.claudeSaid(`deleted ${names.length > 1 ? names.length + ' objects' : '“' + names[0] + '”'}`);
		return { data: { deleted: names.length, left: this.model.nodes.length } };
	},

	async set_variables(a) {
		const vars = this.model.doc.vars = this.model.doc.vars || [];
		for (const [name, v] of Object.entries(a.variables || {})) {
			if (!/^[A-Za-z_]\w*$/.test(name)) throw new Error(`"${name}" is not a valid variable name (letters, digits and _, not starting with a digit).`);
			const i = vars.findIndex((x) => x.name === name);
			if (v === null) { if (i >= 0) vars.splice(i, 1); continue; }
			const expr = typeof v === 'number' ? String(round(v, 9)) : String(v);
			if (i >= 0) vars[i].expr = expr; else vars.push({ name, expr });
		}
		this.commit();
		await this.claudeSettle();
		const errors = this.varErrors || {};
		if (Object.keys(errors).length) throw new Error('Some variables have problems: ' + Object.entries(errors).map(([k, e]) => `${k}: ${e}`).join('; '));
		this.claudeSaid('updated variables');
		return { data: vars.map((v) => ({ name: v.name, expr: v.expr, value: this.varValues[v.name] })) };
	},

	async get_stats(a) {
		await this.claudeSettle();
		const nodes = a.ids && a.ids.length ? a.ids.map((id) => this.claudeNode(id)) : this.model.nodes.filter((n) => n.visible);
		const s = this.model.settings;
		const st = this.engine.stats(nodes);
		const mp = this.massOf(nodes);
		const all = this.model.nodes.filter((n) => n.visible && !n.hole);
		const scene = this.engine.stats(all).box, b = s.bed;
		const out = {
			size: st.box.isEmpty() ? null : r3(st.box.getSize(new THREE.Vector3()).toArray()),
			box: boxOut(st.box),
			volume_cm3: round(st.volume / 1000, 3),
			weight_g: round((st.volume / 1000) * s.density, 2),
			density: s.density,
			triangles: st.tris,
		};
		if (mp) { out.surface_area_cm2 = round(mp.area / 100, 2); out.center_of_mass = r3([mp.com.x, mp.com.y, mp.com.z]); }
		const warn = [];
		if (!scene.isEmpty()) {
			if (scene.min.x < -b.w / 2 - 0.01 || scene.max.x > b.w / 2 + 0.01 || scene.min.y < -b.d / 2 - 0.01 || scene.max.y > b.d / 2 + 0.01 || scene.max.z > b.h + 0.01) warn.push(`The design exceeds the ${b.w}×${b.d}×${b.h} mm build volume.`);
			if (scene.min.z < -0.01) warn.push('Part of the design is below the bed (z < 0).');
			if (scene.min.z > 0.01) warn.push('The lowest point is above the bed (it would print in the air).');
		}
		if (mp && Math.abs(mp.minZ) < 0.05 && !mp.stable) warn.push('It may tip over while printing (center of mass outside the footprint).');
		const holes = this.model.nodes.filter((n) => n.visible && n.hole).length;
		if (holes) warn.push(`${holes} hole object(s) are not in a group, so they cut nothing yet (use combine).`);
		const failed = [...(this.engine.errors || [])].map((id) => this.model.get(id)).filter(Boolean).map((n) => n.name);
		if (failed.length) warn.push('Boolean operations failed for: ' + failed.join(', '));
		out.warnings = warn;
		return { data: out };
	},

	async screenshot(a) {
		await this.claudeSettle();
		const vp = this.vp, cam = vp.camera, ctl = vp.controls;
		const dirs = vp.viewDir(a.view || 'iso');
		if (!dirs) throw new Error('view must be iso, top, front, back, left, right or bottom.');
		const size = Math.max(200, Math.min(1600, Math.round(a.size || 900)));
		const saved = { pos: cam.position.clone(), target: ctl.target.clone(), zoom: cam.zoom };
		const selIds = vp.selection.slice();
		const ids = a.ids && a.ids.length ? a.ids.map((id) => this.claudeNode(id).id) : null;
		let box = ids ? vp.selectionBox(ids) : this.sceneBox();
		if (box.isEmpty()) { const { w, d } = this.model.settings.bed; box = new THREE.Box3(new THREE.Vector3(-w / 2, -d / 2, 0), new THREE.Vector3(w / 2, d / 2, 20)); }
		const sph = box.getBoundingSphere(new THREE.Sphere());
		const r = Math.max(sph.radius, 5);
		const dir = new THREE.Vector3(...dirs).normalize();
		const canvas = vp.renderer.domElement;
		const aspect = canvas.width / canvas.height || 1;
		const fov = vp.persp.fov * Math.PI / 180;
		const half = Math.min(fov, 2 * Math.atan(Math.tan(fov / 2) * aspect)) / 2; // the narrower half-angle
		let url;
		try {
			vp.setSelection([]); // no highlight or gizmo in the picture
			cam.position.copy(sph.center).addScaledVector(dir, (r / Math.sin(half)) * 1.08);
			ctl.target.copy(sph.center);
			if (cam.isOrthographicCamera) { cam.zoom = 1; vp.updateOrtho(); }
			cam.lookAt(sph.center);
			cam.updateMatrixWorld();
			vp.render();
			const k = Math.min(1, size / Math.max(canvas.width, canvas.height));
			const c2 = document.createElement('canvas');
			c2.width = Math.round(canvas.width * k); c2.height = Math.round(canvas.height * k);
			c2.getContext('2d').drawImage(canvas, 0, 0, c2.width, c2.height);
			url = c2.toDataURL('image/jpeg', 0.88);
		} finally {
			cam.position.copy(saved.pos);
			ctl.target.copy(saved.target);
			if (cam.isOrthographicCamera) { cam.zoom = saved.zoom; vp.updateOrtho(); }
			cam.lookAt(saved.target);
			cam.updateMatrixWorld();
			vp.setSelection(selIds);
			vp.render();
		}
		return { image: { base64: url.split(',')[1], mimeType: 'image/jpeg' }, data: `${a.view || 'iso'} view of ${ids ? ids.length + ' object(s)' : 'the design'}` };
	},

	async select(a) {
		const ids = (a.ids || []).map((id) => this.claudeNode(id).id);
		this.setSelection(ids);
		return { data: { selection: this.sel.slice() } };
	},

	async undo(a) {
		const steps = Math.max(1, Math.min(50, Math.round(a.steps || 1)));
		let k = 0;
		for (let i = 0; i < steps; i++) {
			const ok = a.redo ? this.model.canRedo() : this.model.canUndo();
			if (!ok) break;
			if (a.redo) this.redo(); else this.undo();
			k++;
		}
		await this.claudeSettle();
		if (k) this.claudeSaid(`${a.redo ? 'redid' : 'undid'} ${k} step${k > 1 ? 's' : ''}`);
		return { data: { [a.redo ? 'redone' : 'undone']: k, objects: this.model.nodes.map((n) => ({ id: n.id, name: n.name, type: n.type })) } };
	},

	async export(a) {
		await this.claudeSettle();
		const fmtName = a.format;
		if (!['stl', '3mf', 'step'].includes(fmtName)) throw new Error('format must be stl, 3mf or step.');
		const nodes = a.ids && a.ids.length ? a.ids.map((id) => this.claudeNode(id)) : this.model.nodes.filter((n) => n.visible);
		if (!nodes.some((n) => !n.hole)) throw new Error('Nothing solid to export.');
		const name = (this.model.doc.name || 'design').replace(/[^\w\- ]+/g, '_').trim() || 'design';
		let bytes, tris;
		if (fmtName === '3mf') {
			const holes = nodes.filter((n) => n.hole);
			const parts = nodes.filter((n) => !n.hole).map((n) => {
				const g = this.engine.printable([n, ...holes], true);
				if (!g || !g.attributes.position.count) return null;
				const f = g.index ? g.toNonIndexed() : g;
				return { name: n.name || n.type, color: n.color, positions: f.attributes.position.array };
			}).filter(Boolean);
			if (!parts.length) throw new Error('The export is empty.');
			tris = parts.reduce((t, p) => t + p.positions.length / 9, 0);
			bytes = build3MF(parts, { title: this.model.doc.name || name });
		} else {
			const g = this.engine.printable(nodes, true);
			if (!g || !g.attributes.position.count) throw new Error('The export is empty.');
			const flat = g.index ? g.toNonIndexed() : g;
			tris = flat.attributes.position.count / 3;
			bytes = fmtName === 'step' ? stepFromPositions(flat.attributes.position.array, name).text : stlBinary(flat);
		}
		if (bytes instanceof Blob) bytes = await bytes.arrayBuffer();
		this.claudeSaid(`exported ${fmtName.toUpperCase()}`);
		return { file: { name, ext: fmtName, base64: toBase64(bytes) }, data: { format: fmtName, objects: nodes.length, triangles: tris } };
	},
};

export { CLAUDE_TOOLS };
