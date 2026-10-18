// Claude connection end to end: the MCP helper (claude/draftotter-mcp.mjs) spoken to over stdio like Claude does,
// DraftOtter in a browser connected to it, and every tool run against the real app.
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const PORT = 47890;
const OUT = path.resolve('test/downloads/mcp');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(ok ? 'ok  ' : 'FAIL', name, info); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- the helper, as an MCP client sees it
const helper = spawn(process.execPath, ['claude/draftotter-mcp.mjs'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, DRAFTOTTER_PORT: String(PORT), DRAFTOTTER_EXPORT_DIR: OUT } });
let helperLog = '';
helper.stderr.on('data', (d) => { helperLog += d; });
const replies = new Map();
let inBuf = '', rpcId = 0;
helper.stdout.on('data', (d) => {
	inBuf += d;
	let nl;
	while ((nl = inBuf.indexOf('\n')) >= 0) {
		const line = inBuf.slice(0, nl); inBuf = inBuf.slice(nl + 1);
		const msg = JSON.parse(line);
		if (replies.has(msg.id)) { replies.get(msg.id)(msg); replies.delete(msg.id); }
	}
});
const rpc = (method, params) => new Promise((res) => { const id = ++rpcId; replies.set(id, res); helper.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
const call = async (name, args = {}) => {
	const r = await rpc('tools/call', { name, arguments: args });
	const text = (r.result.content.find((c) => c.type === 'text') || {}).text || '';
	let data = null;
	try { data = JSON.parse(text); } catch (e) { data = text; }
	return { error: !!r.result.isError, text, data, content: r.result.content };
};

const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
check('initialize: protocol version and server info', init.result.protocolVersion === '2025-06-18' && init.result.serverInfo.name === 'draftotter' && /millimeters/.test(init.result.instructions), JSON.stringify(init.result.serverInfo));
helper.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
const list = await rpc('tools/list', {});
const names = list.result.tools.map((t) => t.name);
check('tools/list has the tools', ['get_design', 'add_shape', 'sketch', 'combine', 'screenshot', 'export', 'undo'].every((n) => names.includes(n)) && list.result.tools.every((t) => t.inputSchema && t.inputSchema.type === 'object'), names.join(','));
const manifest = JSON.parse(readFileSync('claude/manifest.json', 'utf8'));
check('the Claude Desktop extension lists the same tools', manifest.tools.map((t) => t.name).join() === names.join() && manifest.version === JSON.parse(readFileSync('package.json', 'utf8')).version, manifest.tools.map((t) => t.name).join());
check('unknown methods get an error', (await rpc('nope/nothing', {})).error.code === -32601);
let r = await call('get_design');
check('without DraftOtter open, tools say how to connect', r.error && /Connect Claude/.test(r.text), r.text);

// pages from other websites are turned away
const status = (origin) => new Promise((res) => {
	const req = http.request({ host: '127.0.0.1', port: PORT, path: '/', headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', Origin: origin } });
	req.on('upgrade', (resp, sock) => { sock.destroy(); res(101); });
	req.on('response', (resp) => res(resp.statusCode));
	req.on('error', () => res('error'));
	req.end();
});
check('a website can\'t connect (origin check)', (await status('https://evil.example')) !== 101);
check('a page opened from a file can', (await status('null')) === 101);

// ---------------------------------------------------------------- DraftOtter, connected
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 240000, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1400, height: 900 } });
const errors = [];
const open = async () => {
	const page = await browser.newPage();
	page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
	page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
	await page.goto(pathToFileURL('DraftOtter.html').href);
	await page.waitForFunction(() => document.body.classList.contains('ready'));
	return page;
};
const page = await open();
const app = (fn, ...a) => page.evaluate(fn, ...a);
check('Claude is off by default (no badge, no connection)', await app(() => getComputedStyle(document.querySelector('#st-claude')).display === 'none' && !window.DraftOtter.claude.ws));
// turn it on through the dialog
await app(() => { localStorage.clear(); const a = window.DraftOtter; a.model.doc.nodes = []; a.model.doc.vars = []; a.commit(); a.claudeDialog(); });
await app((port) => { const p = document.querySelector('#claude-port'); p.value = port; const c = document.querySelector('#claude-on'); c.checked = true; c.dispatchEvent(new Event('change')); }, PORT);
await page.waitForFunction(() => document.querySelector('#st-claude').textContent === 'Claude connected', { timeout: 10000 }).catch(() => null);
check('ticking "Allow Claude to connect" connects (badge, dialog status)', await app(() => document.querySelector('#st-claude').textContent === 'Claude connected' && document.querySelector('#claude-live').textContent === 'Claude connected'));
check('the dialog shows the Claude Code command for this copy', await app(() => /claude mcp add draftotter -- node ".*claude\\draftotter-mcp\.mjs"/.test(document.querySelector('.claude-cmd code').textContent)));
check('the setting is remembered', await app(() => JSON.parse(localStorage.getItem('draftotter-claude')).on === true));
const closeModal = (p) => p.evaluate(() => [...document.querySelectorAll('.modal-back .btn')].find((b) => b.textContent.trim() === 'Close').click());
await closeModal(page);

r = await call('list_shape_types', { type: 'box' });
check('list_shape_types: one type with its parameters', !r.error && r.data.type === 'box' && r.data.params.some((p) => p.key === 'w' && p.default === 20), r.text.slice(0, 200));
r = await call('list_shape_types');
check('…or all of them (no internal types)', r.data.shapes.length > 40 && !r.data.shapes.some((s) => ['sketch', 'mesh', 'facex'].includes(s.type)), r.data.shapes.length);

// a plate with a hole cut in it
r = await call('add_shape', { type: 'box', params: { w: 60, d: 40, h: 4 }, name: 'Plate', position: [0, 0, 2] });
const plate = r.data;
check('add_shape: a 60 × 40 × 4 plate on the bed', !r.error && plate.name === 'Plate' && plate.box.size.join() === '60,40,4' && plate.box.min[2] === 0, r.text.slice(0, 300));
r = await call('add_shape', { type: 'cylinder', params: { r: 3, h: 10 }, hole: true, position: [20, 10, 2], name: 'Hole' });
const hole = r.data;
check('…and a hole cylinder', hole.hole === true && hole.box.size[2] === 10);
r = await call('add_shape', { type: 'box', params: { width: 5 } });
check('a wrong parameter name is explained', r.error && /no parameter "width".*w, d, h/.test(r.text), r.text);
r = await call('add_shape', { type: 'teapot' });
check('an unknown shape type is explained', r.error && /list_shape_types/.test(r.text), r.text);
r = await call('combine', { ids: [plate.id, hole.id], mode: 'cut', name: 'Plate with hole' });
const grp = r.data;
check('combine cut: a group with the plate and the hole', !r.error && grp.type === 'group' && grp.children.length === 2 && grp.children[1].hole, r.text.slice(0, 200));
r = await call('get_stats', { ids: [grp.id] });
const k64 = 64 / (2 * Math.PI) * Math.sin(2 * Math.PI / 64);
const want = (60 * 40 * 4 - Math.PI * 9 * k64 * 4) / 1000;
check('get_stats: the hole is cut out of the volume', Math.abs(r.data.volume_cm3 - want) < 0.005 && r.data.size.join() === '60,40,4', JSON.stringify({ got: r.data.volume_cm3, want }));

// variables and expressions
r = await call('set_variables', { variables: { thick: 3 } });
check('set_variables', !r.error && r.data[0].value === 3, r.text);
r = await call('update_object', { id: plate.id, params: { h: 'thick*2' } });
check('a parameter can be an expression of a variable', !r.error && r.data.params.h === 6 && r.data.exprs['params.h'] === 'thick*2', r.text.slice(0, 300));
await call('set_variables', { variables: { thick: 2 } });
r = await call('get_design');
check('…and follows the variable', r.data.objects[0].children[0].params.h === 4 && r.data.variables[0].expr === '2', JSON.stringify(r.data.objects[0].children[0].params));
r = await call('update_object', { id: plate.id, params: { h: 'nope*2' } });
check('a bad expression is explained', r.error && /not a number or a valid expression/.test(r.text), r.text);

// sketches: an extrusion with a hole, an arc, a revolve around a moved axis
r = await call('sketch', { loops: [[[-10, -10], [10, -10], [10, 10], [-10, 10]]], circles: [{ x: 0, y: 0, r: 5 }], height: 3, name: 'Washer plate' });
check('sketch: square with a round hole', !r.error && r.data.type === 'sketch' && r.data.box.size.join() === '20,20,3' && r.data.box.min[2] === 0, r.text.slice(0, 200));
const sq = r.data;
r = await call('get_stats', { ids: [sq.id] });
check('…its volume has the hole', Math.abs(r.data.volume_cm3 * 1000 - (400 - Math.PI * 25) * 3) < 3, r.data.volume_cm3);
r = await call('sketch', { loops: [[[-10, 0], [10, 0, 1]]], height: 2, name: 'D' });
const dShape = r.data;
r = await call('get_stats', { ids: [dShape.id] });
check('sketch: an arc edge from a bulge (half disc)', !r.error && Math.abs(r.data.volume_cm3 * 1000 - Math.PI * 100) < 4 && dShape.box.size.join() === '20,10,2', JSON.stringify({ v: r.data.volume_cm3, size: dShape.box.size }));
r = await call('sketch', { loops: [[[10, 0], [14, 0], [14, 10], [10, 10]]], mode: 'revolve', axis_x: 5, name: 'Ring' });
const ring = r.data;
r = await call('get_stats', { ids: [ring.id] });
const wantRing = Math.PI * (81 - 25) * 10 * k64 / 1000;
check('sketch: revolve around x = 5', !r.error && Math.abs(r.data.volume_cm3 - wantRing) < 0.01 * wantRing && ring.box.size.join() === '18,18,10', JSON.stringify({ v: r.data.volume_cm3, wantRing, size: ring.box.size }));
r = await call('sketch', { loops: [[[-5, 0], [5, 0], [5, 5], [-5, 5]]], mode: 'revolve' });
check('a revolve profile crossing the axis is explained', r.error && /one side of the axis/.test(r.text), r.text);
r = await call('sketch', { loops: [[[0, 0], [5, 0]]] });
check('an open profile is explained', r.error && /closed loop/.test(r.text), r.text);
r = await call('sketch', { id: dShape.id, height: 5 });
check('sketch with id changes an existing one', !r.error && r.data.id === dShape.id && r.data.box.size[2] === 5, r.text.slice(0, 200));

// moving, copying, deleting
r = await call('move', { ids: [dShape.id], by: [0, 0, 7] });
check('move by an offset', r.data[0].box.min[2] === 7, JSON.stringify(r.data[0].box));
r = await call('move', { ids: [dShape.id], drop_to_bed: true });
check('move: drop to the bed', r.data[0].box.min[2] === 0);
r = await call('duplicate', { ids: [sq.id], offset: [0, 30, 0], count: 2 });
check('duplicate: a linear pattern of 2 copies', !r.error && r.data.length === 2 && r.data[1].box.min[1] - sq.box.min[1] === 60, r.text.slice(0, 200));
const copies = r.data.map((c) => c.id);
r = await call('delete_objects', { ids: copies });
check('delete_objects', !r.error && r.data.deleted === 2);
r = await call('undo');
check('undo brings them back', !r.error && r.data.undone === 1 && r.data.objects.length === 6, r.text.slice(0, 200));
r = await call('undo', { redo: true });
check('…and redo removes them again', r.data.redone === 1 && r.data.objects.length === 4);
r = await call('select', { ids: [ring.id] });
check('select shows the user an object', await app(() => window.DraftOtter.sel.length === 1) && r.data.selection.length === 1);

// the picture, without moving the user's view
const cam0 = await app(() => window.DraftOtter.vp.camera.position.toArray().join());
r = await call('screenshot', { view: 'top', size: 600 });
const img = r.content.find((c) => c.type === 'image');
const jpg = img && Buffer.from(img.data, 'base64');
check('screenshot returns a picture', !r.error && img && img.mimeType === 'image/jpeg' && jpg[0] === 0xff && jpg[1] === 0xd8 && jpg.length > 5000, img && jpg.length);
const cam1 = await app(() => window.DraftOtter.vp.camera.position.toArray().join());
check('…and leaves the user\'s view and selection alone', cam1.split(',').every((v, i) => Math.abs(v - cam0.split(',')[i]) < 1e-6) && await app(() => window.DraftOtter.vp.selection.length === 1), cam0 + ' → ' + cam1);
r = await call('screenshot', { view: 'iso', ids: [grp.id] });
if (img) { const fs = await import('node:fs'); fs.writeFileSync('test/shots/430-claude-screenshot.jpg', Buffer.from(r.content.find((c) => c.type === 'image').data, 'base64')); }

// export
r = await call('export', { format: 'stl', ids: [grp.id], path: 'plate' });
const stl = path.join(OUT, 'plate.stl');
check('export STL writes the file', !r.error && existsSync(stl) && r.data.file === stl, r.text);
if (existsSync(stl)) { const b = readFileSync(stl); check('…a valid binary STL with the cut', b.readUInt32LE(80) === r.data.triangles && b.length === 84 + 50 * r.data.triangles, b.length); }
r = await call('export', { format: '3mf' });
check('export 3MF of the whole design (named after it)', !r.error && existsSync(r.data.file) && readFileSync(r.data.file).subarray(0, 2).toString() === 'PK' && /\.3mf$/.test(r.data.file), r.text);
r = await call('export', { format: 'step', ids: [ring.id], path: path.join(OUT, 'sub', 'ring.txt') });
check('export STEP keeps the right extension', !r.error && /ring\.txt\.step$/.test(r.data.file) && /ISO-10303-21/.test(readFileSync(r.data.file, 'utf8').slice(0, 200)), r.text);

r = await call('get_stats');
check('get_stats warns about loose holes etc. (none here)', Array.isArray(r.data.warnings) && !r.data.warnings.some((w) => /hole object/.test(w)), JSON.stringify(r.data.warnings));
r = await call('update_object', { id: 'nope' });
check('an unknown id is explained', r.error && /get_design/.test(r.text), r.text);
check('each change was one undo step in DraftOtter', await app(() => window.DraftOtter.model.canUndo()));

// one window at a time
const page2 = await open();
await page2.evaluate(() => { const a = window.DraftOtter; localStorage.setItem('draftotter-claude', JSON.stringify({ on: true, port: 47890 })); a.claude.prefs = { on: true, port: 47890 }; a.claudeConnect(); });
await page2.waitForFunction(() => /another window/.test(document.querySelector('#st-claude').textContent), { timeout: 8000 }).catch(() => null);
check('a second DraftOtter window is told another one is connected', await page2.evaluate(() => /another window/.test(document.querySelector('#st-claude').textContent)));
r = await call('get_design');
check('…and Claude keeps working with the first', !r.error && r.data.objects.length === 4);
// turning it off disconnects; the other window can then connect
await app(() => { const a = window.DraftOtter; a.claudeDialog(); const c = document.querySelector('#claude-on'); c.checked = false; c.dispatchEvent(new Event('change')); });
await closeModal(page);
await wait(300);
check('turning it off disconnects and hides the badge', await app(() => !window.DraftOtter.claude.ws && getComputedStyle(document.querySelector('#st-claude')).display === 'none'));
await page2.waitForFunction(() => document.querySelector('#st-claude').textContent === 'Claude connected', { timeout: 15000 }).catch(() => null);
check('…and the other window takes over', await page2.evaluate(() => document.querySelector('#st-claude').textContent === 'Claude connected'));
await page2.evaluate(() => { const a = window.DraftOtter; a.model.doc.nodes = []; a.commit(); });
r = await call('get_design');
check('…with its own design', !r.error && r.data.objects.length === 0, r.data && r.data.objects && r.data.objects.length);

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
helper.stdin.end();
await wait(300);
check('the helper quits when Claude closes the connection', helper.exitCode === 0, helper.exitCode);
if (fails) console.log(helperLog);
console.log(fails ? `${fails} FAILED` : 'mcp: all passed');
process.exit(fails ? 1 : 0);
