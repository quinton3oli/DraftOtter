#!/usr/bin/env node
// DraftOtter MCP server: lets Claude (Claude Desktop, Claude Code, …) work on the design open in DraftOtter.
//
//   Claude ⇄ (MCP over stdio) ⇄ this helper ⇄ (WebSocket on 127.0.0.1) ⇄ DraftOtter in the browser
//
// The page connects to the helper when "Allow Claude to connect" is on (More → Connect Claude). The helper only
// listens on 127.0.0.1 and only accepts pages opened from a file (or served by this helper). No dependencies:
// the MCP protocol (JSON-RPC over stdio) and the WebSocket server are implemented here.
//
//   node localcad-mcp.mjs            env: LOCALCAD_PORT (47821), LOCALCAD_EXPORT_DIR (~/Downloads)
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '1.1.0';
const PORT = +process.env.LOCALCAD_PORT || 47821;
const EXPORT_DIR = expandHome(process.env.LOCALCAD_EXPORT_DIR || path.join(os.homedir(), 'Downloads'));
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CALL_TIMEOUT = 180000;
const log = (...a) => process.stderr.write('[localcad-mcp] ' + a.join(' ') + '\n');

function expandHome(p) {
	// unfilled ${...} placeholders (e.g. an optional setting left empty) fall back to the default
	if (!p || /\$\{/.test(p)) return path.join(os.homedir(), 'Downloads');
	return p.replace(/^~(?=$|[\\/])/, os.homedir());
}

// ============================================================ tools

const vec3 = (desc) => ({ type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: desc });
const ids = (desc) => ({ type: 'array', items: { type: 'string' }, description: desc });

const INSTRUCTIONS = `DraftOtter is a CAD app for 3D-printable parts, open in the user's browser. These tools edit the design that is open there; the user watches the changes live and can undo each one (Ctrl+Z).

Conventions: millimeters and degrees. Z is up. The print bed is the XY plane at z = 0, centered on the origin. Every object has pos (for built-in shapes: the center of its bounding box; for sketches: the sketch origin), rot (XYZ Euler angles, degrees) and scale. Positions inside a group are relative to the group.

Holes: an object marked as a hole only cuts the solids it is grouped with. To cut, use combine with mode "cut" (the first object is kept, the others become holes). Groups can be nested.

Workflow: call get_design first (it also tells you what the user has selected — "this" or "the selected part" usually means the selection). Use list_shape_types to see each shape's parameters. Build with add_shape, sketch (custom 2D profiles that are extruded or revolved) and combine. After changes, check with screenshot (look at it from more than one view when shape matters) and get_stats. Prefer parameters over scaling so the design stays editable; parameters can be expressions of design variables (set_variables).`;

const TOOLS = [
	{
		name: 'get_design',
		description: 'The open design: its name, printer bed size, variables, the current selection, and the object tree (id, name, type, hole, group mode, parameters, pos/rot/scale, color, and the world-space bounding box of each object).',
		inputSchema: { type: 'object', properties: {} },
		annotations: { readOnlyHint: true },
	},
	{
		name: 'list_shape_types',
		description: 'The shapes add_shape can create (box, cylinder, gear, thread, screw holes, …) with their parameters: key, label, default, type and allowed options. Pass type to get just one.',
		inputSchema: { type: 'object', properties: { type: { type: 'string', description: 'One shape type, e.g. "gear"' } } },
		annotations: { readOnlyHint: true },
	},
	{
		name: 'add_shape',
		description: 'Add a built-in shape. Parameters not given keep their defaults (see list_shape_types). Without position it is placed on the bed in a free spot. Numeric parameters may be expressions of design variables, e.g. "wall*2". Returns the new object with its bounding box.',
		inputSchema: {
			type: 'object',
			properties: {
				type: { type: 'string', description: 'Shape type, e.g. "box", "cylinder", "screwhole"' },
				params: { type: 'object', description: 'Shape parameters, e.g. {"w": 40, "d": 20, "h": 5, "radius": 1}' },
				name: { type: 'string' },
				color: { type: 'string', description: 'CSS hex color, e.g. "#3aa0e8"' },
				hole: { type: 'boolean', description: 'Make it a hole (cuts only inside a group)' },
				position: vec3('Center of the bounding box [x, y, z] in mm. A 10 mm tall shape at z = 5 sits on the bed.'),
				rotation: vec3('XYZ Euler angles in degrees'),
				parent: { type: 'string', description: 'Put it inside this group (position is then relative to the group)' },
			},
			required: ['type'],
		},
	},
	{
		name: 'sketch',
		description: 'Create (or, with id, replace the profile of) a custom shape from a 2D profile drawn in the sketch XY plane. Every closed loop is a solid; loops and circles inside another loop are holes. extrude: along +Z by height. revolve: around the vertical line x = axis_x of the sketch (the sketch Y becomes Z), by angle degrees. The sketch origin is placed at position; rotate it to sketch on other planes (rotation [90, 0, 0] stands an extrusion up on the XZ plane). The user can open it in the sketch editor afterwards.',
		inputSchema: {
			type: 'object',
			properties: {
				id: { type: 'string', description: 'Existing sketch object to change (omit to create a new one)' },
				loops: {
					type: 'array',
					description: 'Closed loops, each a list of vertices [x, y] or [x, y, bulge]. bulge makes the edge from this vertex to the next an arc: tan(arc angle / 4), positive = counter-clockwise (1 = half circle, 0.4142 = quarter circle).',
					items: { type: 'array', items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 3 } },
				},
				circles: { type: 'array', description: 'Full circles', items: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, r: { type: 'number' } }, required: ['x', 'y', 'r'] } },
				mode: { type: 'string', enum: ['extrude', 'revolve'] },
				height: { type: 'number', description: 'Extrude height (mm)' },
				angle: { type: 'number', description: 'Revolve angle (degrees, default 360)' },
				axis_x: { type: 'number', description: 'Revolve axis: the vertical line x = axis_x (default 0). The profile must lie on one side of it.' },
				corner_radius: { type: 'number', description: 'Round every sharp corner of the profile by this radius' },
				edge: { type: 'number', description: 'Top/bottom edge size for extrusions' },
				edge_type: { type: 'string', enum: ['chamfer', 'fillet'] },
				name: { type: 'string' },
				color: { type: 'string' },
				hole: { type: 'boolean' },
				position: vec3('Where the sketch origin goes [x, y, z]. Omitted for a new sketch: placed on the bed in a free spot.'),
				rotation: vec3('XYZ Euler angles in degrees'),
				parent: { type: 'string', description: 'Put it inside this group' },
			},
		},
	},
	{
		name: 'update_object',
		description: 'Change an object: parameters (only the ones given change), name, color, hole, visibility, position, rotation, scale, or a group\'s mode. Numeric parameters may be expressions of variables.',
		inputSchema: {
			type: 'object',
			properties: {
				id: { type: 'string' },
				params: { type: 'object' },
				name: { type: 'string' },
				color: { type: 'string' },
				hole: { type: 'boolean' },
				visible: { type: 'boolean' },
				position: vec3('New pos (relative to the parent group, if any)'),
				rotation: vec3('New rotation (XYZ degrees)'),
				scale: vec3('New scale factors'),
				mode: { type: 'string', enum: ['union', 'intersect', 'hull'], description: 'Groups only' },
			},
			required: ['id'],
		},
	},
	{
		name: 'move',
		description: 'Move objects in world space: by an offset, and/or drop them onto the bed, and/or center them on the bed.',
		inputSchema: {
			type: 'object',
			properties: {
				ids: ids('Objects to move'),
				by: vec3('World offset [dx, dy, dz] in mm'),
				drop_to_bed: { type: 'boolean', description: 'Lower (or raise) them so their lowest point is at z = 0' },
				center_on_bed: { type: 'boolean', description: 'Center them (together) on the bed, resting on it' },
			},
			required: ['ids'],
		},
	},
	{
		name: 'combine',
		description: 'Group objects into one part. mode "union" joins them (objects already marked as holes cut), "cut" keeps the first object and cuts it with the others, "intersect" keeps only the common volume, "hull" wraps them in their convex hull. The objects must be at the same level (siblings). Returns the new group.',
		inputSchema: {
			type: 'object',
			properties: {
				ids: ids('Objects to combine (for "cut": the part to keep first)'),
				mode: { type: 'string', enum: ['union', 'cut', 'intersect', 'hull'] },
				name: { type: 'string' },
			},
			required: ['ids', 'mode'],
		},
	},
	{
		name: 'ungroup',
		description: 'Split a group back into its objects (they keep their places).',
		inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
	},
	{
		name: 'duplicate',
		description: 'Copy objects. With count > 1 the copies form a linear pattern, each offset from the previous one.',
		inputSchema: {
			type: 'object',
			properties: { ids: ids('Objects to copy'), offset: vec3('World offset of each copy from the previous [dx, dy, dz]'), count: { type: 'integer', minimum: 1, maximum: 200 } },
			required: ['ids'],
		},
	},
	{
		name: 'delete_objects',
		description: 'Delete objects (the user can undo it).',
		inputSchema: { type: 'object', properties: { ids: ids('Objects to delete') }, required: ['ids'] },
		annotations: { destructiveHint: true },
	},
	{
		name: 'set_variables',
		description: 'Set design variables (numbers or expressions of other variables, e.g. "wall*2"). Parameters that use them update. A value of null removes the variable.',
		inputSchema: {
			type: 'object',
			properties: { variables: { type: 'object', description: 'name → number, expression string, or null', additionalProperties: { type: ['number', 'string', 'null'] } } },
			required: ['variables'],
		},
	},
	{
		name: 'get_stats',
		description: 'Size, volume, weight (at 100% infill), surface area, center of mass, triangle count and print warnings, for the given objects or the whole visible design.',
		inputSchema: { type: 'object', properties: { ids: ids('Objects (default: the whole visible design)') } },
		annotations: { readOnlyHint: true },
	},
	{
		name: 'screenshot',
		description: 'Render the design (or just frame some objects) from a standard view and return the image, to check your work. The user\'s own view is left as it was.',
		inputSchema: {
			type: 'object',
			properties: {
				view: { type: 'string', enum: ['iso', 'top', 'front', 'back', 'left', 'right', 'bottom'], description: 'Default iso' },
				ids: ids('Frame these objects (default: the whole design)'),
				size: { type: 'integer', minimum: 200, maximum: 1600, description: 'Longest side in pixels (default 900)' },
			},
		},
		annotations: { readOnlyHint: true },
	},
	{
		name: 'select',
		description: 'Select objects in DraftOtter so the user sees which ones you mean (an empty list clears the selection).',
		inputSchema: { type: 'object', properties: { ids: ids('Objects to select') }, required: ['ids'] },
	},
	{
		name: 'undo',
		description: 'Undo (or with redo: true, redo) the last changes in DraftOtter.',
		inputSchema: { type: 'object', properties: { steps: { type: 'integer', minimum: 1, maximum: 50 }, redo: { type: 'boolean' } } },
	},
	{
		name: 'export',
		description: `Export objects (default: the whole visible design, holes cut) to a file for printing: STL, 3MF or STEP. The file is written to the given path; a bare file name goes to ${EXPORT_DIR}.`,
		inputSchema: {
			type: 'object',
			properties: {
				format: { type: 'string', enum: ['stl', '3mf', 'step'] },
				ids: ids('Objects to export'),
				path: { type: 'string', description: 'File path or name (default: the design name)' },
			},
			required: ['format'],
		},
	},
];

// ============================================================ the page connection

let page = null; // { socket, send(obj), info }
let waiters = [];
const pending = new Map();
let callSeq = 0;

function onPageMessage(conn, text) {
	let msg;
	try { msg = JSON.parse(text); } catch (e) { return; }
	if (msg.type === 'hello') {
		// one DraftOtter window at a time; a second one is turned away rather than taking over
		if (page && page !== conn) { conn.send({ type: 'busy' }); conn.close(); return; }
		page = conn;
		conn.info = msg;
		log(`DraftOtter connected (${msg.design || 'untitled'})`);
		waiters.splice(0).forEach((w) => w());
	} else if (msg.type === 'result' && pending.has(msg.id)) {
		const p = pending.get(msg.id);
		pending.delete(msg.id);
		clearTimeout(p.timer);
		p.resolve(msg);
	}
}

function onPageClose(conn) {
	if (page !== conn) return;
	page = null;
	log('DraftOtter disconnected');
	for (const [id, p] of pending) {
		clearTimeout(p.timer);
		p.resolve({ ok: false, error: 'DraftOtter disconnected while working on this (was the page closed or reloaded?).' });
		pending.delete(id);
	}
}

async function waitForPage(ms) {
	if (page) return page;
	await new Promise((res) => { const t = setTimeout(res, ms); waiters.push(() => { clearTimeout(t); res(); }); });
	return page;
}

async function callPage(tool, args) {
	if (!(await waitForPage(4000))) {
		return { ok: false, error: listening
			? 'DraftOtter is not connected. Ask the user to open DraftOtter in their browser and turn on More (wrench) → Connect Claude → "Allow Claude to connect".'
			: `The DraftOtter helper could not open port ${PORT} on 127.0.0.1 (${bindError || 'in use'}). Another copy of it may be running; quit the other Claude app or change the port.` };
	}
	const id = ++callSeq;
	return new Promise((resolve) => {
		const timer = setTimeout(() => { pending.delete(id); resolve({ ok: false, error: 'DraftOtter did not answer in time.' }); }, CALL_TIMEOUT);
		pending.set(id, { resolve, timer });
		page.send({ type: 'call', id, tool, args: args || {} });
	});
}

// ---------------------------------------------------------------- tool calls

async function runTool(name, args) {
	if (!TOOLS.some((t) => t.name === name)) return toolError(`Unknown tool ${name}`);
	const r = await callPage(name, args);
	if (!r.ok) return toolError(r.error || 'Failed');
	const content = [];
	if (r.file) {
		// exports: the page sends the file, the helper writes it
		let target = args && args.path ? expandHome(String(args.path)) : r.file.name;
		if (!path.isAbsolute(target)) target = path.join(EXPORT_DIR, target);
		const ext = '.' + r.file.ext;
		if (path.extname(target).toLowerCase() !== ext) target += ext;
		try {
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, Buffer.from(r.file.base64, 'base64'));
		} catch (e) {
			return toolError(`Could not write ${target}: ${e.message}`);
		}
		r.data = { ...(r.data || {}), file: target, bytes: fs.statSync(target).size };
	}
	if (r.data !== undefined) content.push({ type: 'text', text: typeof r.data === 'string' ? r.data : JSON.stringify(r.data, null, 1) });
	if (r.image) content.push({ type: 'image', data: r.image.base64, mimeType: r.image.mimeType });
	if (!content.length) content.push({ type: 'text', text: 'Done.' });
	return { content };
}

const toolError = (text) => ({ content: [{ type: 'text', text }], isError: true });

// ============================================================ MCP over stdio (JSON-RPC 2.0, one message per line)

const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

function send(msg) {
	process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handleRpc(msg) {
	const { id, method, params } = msg;
	const reply = (result) => { if (id !== undefined) send({ jsonrpc: '2.0', id, result }); };
	const fail = (code, message) => { if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code, message } }); };
	if (method === undefined) return; // a response to something we never send
	switch (method) {
		case 'initialize': {
			const want = params && params.protocolVersion;
			return reply({
				protocolVersion: PROTOCOLS.includes(want) ? want : PROTOCOLS[0],
				capabilities: { tools: { listChanged: false } },
				serverInfo: { name: 'localcad', title: 'DraftOtter', version: VERSION },
				instructions: INSTRUCTIONS,
			});
		}
		case 'ping': return reply({});
		case 'tools/list': return reply({ tools: TOOLS });
		case 'tools/call': {
			try {
				return reply(await runTool(params && params.name, (params && params.arguments) || {}));
			} catch (e) {
				return reply(toolError(String(e && e.message || e)));
			}
		}
		case 'resources/list': return reply({ resources: [] });
		case 'prompts/list': return reply({ prompts: [] });
		default:
			if (method.startsWith('notifications/')) return;
			return fail(-32601, `Method not found: ${method}`);
	}
}

let inBuf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
	inBuf += chunk;
	let nl;
	while ((nl = inBuf.indexOf('\n')) >= 0) {
		const line = inBuf.slice(0, nl).trim();
		inBuf = inBuf.slice(nl + 1);
		if (!line) continue;
		let msg;
		try { msg = JSON.parse(line); } catch (e) { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
		for (const m of Array.isArray(msg) ? msg : [msg]) handleRpc(m);
	}
});
// the Claude app closed the pipe: we're done
process.stdin.on('end', () => process.exit(0));

// ============================================================ HTTP + WebSocket server on 127.0.0.1

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
let listening = false, bindError = null;

// The hosted web app, plus any listed in LOCALCAD_ORIGINS (comma-separated, e.g. a self-hosted copy).
const WEB_ORIGINS = ['https://localcad-8158c.web.app', 'https://localcad-8158c.firebaseapp.com', ...(process.env.LOCALCAD_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)];

/** Pages allowed to connect: DraftOtter opened as a file (origin "null"), served by this helper, or the web app. */
function originOk(origin) {
	if (!origin || origin === 'null' || origin === 'file://') return true;
	return origin === `http://127.0.0.1:${PORT}` || origin === `http://localhost:${PORT}` || WEB_ORIGINS.includes(origin);
}

function findApp() {
	for (const p of [path.join(HERE, 'DraftOtter.html'), path.join(HERE, '..', 'DraftOtter.html'), path.join(HERE, 'LocalCAD.html'), path.join(HERE, '..', 'LocalCAD.html')]) if (fs.existsSync(p)) return p;
	return null;
}

const server = http.createServer((req, res) => {
	if (!originOk(req.headers.origin)) { res.writeHead(403).end(); return; }
	if (req.url === '/status') {
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ app: 'localcad-mcp', version: VERSION, connected: !!page }));
		return;
	}
	// DraftOtter itself, for browsers that don't let a page opened from a file talk to 127.0.0.1
	const app = (req.url === '/' || req.url.startsWith('/?')) && findApp();
	if (app) {
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
		fs.createReadStream(app).pipe(res);
		return;
	}
	res.writeHead(404, { 'content-type': 'text/plain' }).end('DraftOtter MCP helper. Open DraftOtter and turn on More → Connect Claude.');
});

server.on('upgrade', (req, socket) => {
	const key = req.headers['sec-websocket-key'];
	if (!key || String(req.headers.upgrade).toLowerCase() !== 'websocket' || !originOk(req.headers.origin)) {
		socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
		return;
	}
	const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
	socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
	socket.setNoDelay(true);
	const conn = wsConnection(socket, (text) => onPageMessage(conn, text), () => onPageClose(conn));
});

function wsConnection(socket, onText, onClose) {
	let buf = Buffer.alloc(0), frags = [], closed = false;
	const frame = (op, payload) => {
		const n = payload.length;
		const head = n < 126 ? Buffer.from([0x80 | op, n]) : n < 65536 ? Buffer.from([0x80 | op, 126, n >> 8, n & 255]) : Buffer.concat([Buffer.from([0x80 | op, 127]), bigLen(n)]);
		if (!socket.destroyed) socket.write(Buffer.concat([head, payload]));
	};
	const conn = {
		send: (obj) => frame(1, Buffer.from(JSON.stringify(obj))),
		close: () => { if (!closed) { frame(8, Buffer.alloc(0)); socket.end(); } },
	};
	const ping = setInterval(() => frame(9, Buffer.alloc(0)), 20000);
	const finish = () => { if (closed) return; closed = true; clearInterval(ping); onClose(); };
	socket.on('data', (d) => {
		buf = Buffer.concat([buf, d]);
		for (;;) {
			if (buf.length < 2) return;
			const fin = buf[0] & 0x80, op = buf[0] & 15, masked = buf[1] & 0x80;
			let len = buf[1] & 127, off = 2;
			if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
			else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
			if (len > 512 * 1024 * 1024) { socket.destroy(); return; }
			const need = off + (masked ? 4 : 0) + len;
			if (buf.length < need) return;
			let payload = buf.subarray(off + (masked ? 4 : 0), need);
			if (masked) {
				const m = buf.subarray(off, off + 4);
				payload = Buffer.from(payload);
				for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3];
			}
			buf = buf.subarray(need);
			if (op === 8) { conn.close(); finish(); return; }
			if (op === 9) { frame(10, payload); continue; }
			if (op === 10) continue;
			if (op === 1 || op === 2 || op === 0) {
				frags.push(payload);
				if (fin) { const all = Buffer.concat(frags); frags = []; onText(all.toString('utf8')); }
			}
		}
	});
	socket.on('close', finish);
	socket.on('error', finish);
	return conn;
}

function bigLen(n) {
	const b = Buffer.alloc(8);
	b.writeBigUInt64BE(BigInt(n));
	return b;
}

// Another copy may hold the port (e.g. Claude Desktop and Claude Code both running): keep trying, so this one
// takes over when that one quits.
function listen() {
	server.once('error', (e) => {
		bindError = e.code || e.message;
		if (!listening) setTimeout(listen, 3000);
	});
	server.listen(PORT, '127.0.0.1', () => {
		listening = true;
		bindError = null;
		log(`listening on http://127.0.0.1:${PORT} (exports go to ${EXPORT_DIR})`);
	});
}
listen();
