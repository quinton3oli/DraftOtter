// Small shared helpers.

export const DEG = Math.PI / 180;
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const round = (v, n = 4) => {
	const f = Math.pow(10, n);
	const r = Math.round(v * f) / f;
	return Object.is(r, -0) ? 0 : r;
};
export const fmt = (v, n = 2) => {
	if (!isFinite(v)) return '—';
	return String(round(v, n));
};

// ---------------------------------------------------------------- expressions
// Safe numeric expression evaluator (no eval). Supports + - * / % ^, parentheses, functions
// (trig in degrees), constants (pi), variables from `scope`, and a trailing unit: "3/8in", "2cm", "25mm".
const D2R = Math.PI / 180;
export const EXPR_FUNCS = {
	sin: (d) => Math.sin(d * D2R), cos: (d) => Math.cos(d * D2R), tan: (d) => Math.tan(d * D2R),
	asin: (v) => Math.asin(v) / D2R, acos: (v) => Math.acos(v) / D2R, atan: (v) => Math.atan(v) / D2R, atan2: (y, x) => Math.atan2(y, x) / D2R,
	sqrt: Math.sqrt, abs: Math.abs, min: Math.min, max: Math.max, round: Math.round, floor: Math.floor, ceil: Math.ceil,
	pow: Math.pow, hypot: Math.hypot, exp: Math.exp, ln: Math.log, log: Math.log10,
};
const EXPR_CONSTS = { pi: Math.PI, PI: Math.PI };
const UNIT_RE = /([0-9.)\s])(in|"|cm|mm)$/i;

function tokenize(s) {
	const t = [];
	let i = 0;
	while (i < s.length) {
		const c = s[i];
		if (/\s/.test(c)) { i++; continue; }
		const num = /^(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/.exec(s.slice(i));
		if (num) { t.push({ k: 'n', v: parseFloat(num[1]) }); i += num[1].length; continue; }
		const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i));
		if (id) { t.push({ k: 'id', v: id[0] }); i += id[0].length; continue; }
		if (s.startsWith('**', i)) { t.push({ k: 'op', v: '^' }); i += 2; continue; }
		if ('+-*/%^(),'.includes(c)) { t.push({ k: 'op', v: c }); i++; continue; }
		throw new Error('Unexpected "' + c + '"');
	}
	return t;
}

function parse(tokens, scope) {
	let i = 0;
	const peek = () => tokens[i];
	const eat = (v) => { const t = tokens[i]; if (!t || (v && t.v !== v)) throw new Error('Expected ' + (v || 'value')); i++; return t; };
	const expr = () => {
		let v = term();
		while (peek() && (peek().v === '+' || peek().v === '-')) v = eat().v === '+' ? v + term() : v - term();
		return v;
	};
	const term = () => {
		let v = power();
		while (peek() && '*/%'.includes(peek().v) && peek().k === 'op') {
			const o = eat().v, r = power();
			v = o === '*' ? v * r : o === '/' ? v / r : v % r;
		}
		return v;
	};
	const power = () => {
		const b = unary();
		if (peek() && peek().v === '^') { eat(); return Math.pow(b, power()); }
		return b;
	};
	const unary = () => {
		if (peek() && peek().v === '-') { eat(); return -unary(); }
		if (peek() && peek().v === '+') { eat(); return unary(); }
		return primary();
	};
	const primary = () => {
		const t = eat();
		if (t.k === 'n') return t.v;
		if (t.v === '(') { const v = expr(); eat(')'); return v; }
		if (t.k === 'id') {
			if (peek() && peek().v === '(' && EXPR_FUNCS[t.v.toLowerCase()]) {
				eat('(');
				const args = [];
				if (!(peek() && peek().v === ')')) { args.push(expr()); while (peek() && peek().v === ',') { eat(); args.push(expr()); } }
				eat(')');
				return EXPR_FUNCS[t.v.toLowerCase()](...args);
			}
			if (scope && Object.prototype.hasOwnProperty.call(scope, t.v)) return scope[t.v];
			if (EXPR_CONSTS[t.v] !== undefined) return EXPR_CONSTS[t.v];
			throw new Error('Unknown name "' + t.v + '"');
		}
		throw new Error('Unexpected "' + t.v + '"');
	};
	const v = expr();
	if (i < tokens.length) throw new Error('Unexpected "' + tokens[i].v + '"');
	return v;
}

// Evaluate; returns NaN on any error. Use exprError() to get the message.
export function evalExpr(str, scope) {
	if (typeof str === 'number') return str;
	try { return evalExprStrict(str, scope); } catch (e) { return NaN; }
}

export function evalExprStrict(str, scope) {
	let s = String(str).trim();
	if (s === '') throw new Error('Empty');
	let mul = 1;
	const m = UNIT_RE.exec(s);
	if (m) {
		const u = m[2].toLowerCase();
		mul = u === 'in' || u === '"' ? 25.4 : u === 'cm' ? 10 : 1;
		s = s.slice(0, s.length - m[2].length);
	}
	const v = parse(tokenize(s), scope) * mul;
	if (typeof v !== 'number' || !isFinite(v)) throw new Error('Not a finite number');
	return v;
}

export function exprError(str, scope) {
	try { evalExprStrict(str, scope); return null; } catch (e) { return e.message; }
}

// Does the text reference any names (variables / functions), i.e. should it be stored as an expression?
export function isExpression(str) {
	if (typeof str !== 'string') return false;
	return /[A-Za-z_]/.test(str.trim().replace(UNIT_RE, '$1'));
}

// Names referenced by an expression (excluding functions and constants).
export function exprNames(str) {
	try {
		const t = tokenize(String(str).trim().replace(UNIT_RE, '$1'));
		return [...new Set(t.filter((x, i) => x.k === 'id' && !(t[i + 1] && t[i + 1].v === '(') && EXPR_CONSTS[x.v] === undefined).map((x) => x.v))];
	} catch (e) { return []; }
}

// Rename a variable inside an expression (whole-word, not function calls).
export function renameInExpr(str, from, to) {
	return String(str).replace(new RegExp('\\b' + from + '\\b(?!\\s*\\()', 'g'), to);
}

// Resolve a list of {name, expr} variables (any order; references between them allowed).
// `base` holds values already known (e.g. the design variables when resolving a template's parameters).
export function resolveVars(vars, base = {}) {
	const values = { ...base }, errors = {};
	const pending = vars.filter((v) => v.name);
	for (let pass = 0; pass <= pending.length && pending.length; pass++) {
		for (let i = pending.length - 1; i >= 0; i--) {
			const v = pending[i];
			try { values[v.name] = evalExprStrict(v.expr, values); pending.splice(i, 1); } catch (e) { errors[v.name] = e.message; }
		}
	}
	for (const v of pending) {
		const missing = exprNames(v.expr).filter((n) => !(n in values));
		errors[v.name] = missing.length ? (missing.some((n) => vars.some((w) => w.name === n)) ? 'Circular reference' : 'Unknown name "' + missing[0] + '"') : errors[v.name] || 'Invalid';
	}
	for (const k in values) delete errors[k];
	for (const k in errors) if (!vars.some((v) => v.name === k)) delete errors[k];
	return { values, errors };
}

export function f32ToBase64(arr) {
	const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
	let s = '';
	const CH = 0x8000;
	for (let i = 0; i < bytes.length; i += CH) {
		s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
	}
	return btoa(s);
}

export function base64ToF32(b64) {
	const s = atob(b64);
	const bytes = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
	return new Float32Array(bytes.buffer);
}

export function hashString(str) {
	let h1 = 0x811c9dc5, h2 = 0x1234567;
	for (let i = 0; i < str.length; i++) {
		const c = str.charCodeAt(i);
		h1 = Math.imul(h1 ^ c, 16777619);
		h2 = Math.imul(h2 ^ c, 2246822507);
	}
	return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36) + str.length.toString(36);
}

export function download(data, filename, mime = 'application/octet-stream') {
	const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 2000);
}

let toastHost = null;
export function toast(msg, kind = 'info', ms = 2600) {
	if (!toastHost) {
		toastHost = document.createElement('div');
		toastHost.id = 'toasts';
		document.body.appendChild(toastHost);
	}
	const el = document.createElement('div');
	el.className = 'toast ' + kind;
	el.textContent = msg;
	toastHost.appendChild(el);
	setTimeout(() => {
		el.classList.add('out');
		setTimeout(() => el.remove(), 300);
	}, ms);
	return el;
}

export function el(tag, attrs = {}, ...children) {
	const e = document.createElement(tag);
	for (const k in attrs) {
		const v = attrs[k];
		if (v === undefined || v === null || v === false) continue;
		if (k === 'class') e.className = v;
		else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
		else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
		else if (k === 'html') e.innerHTML = v;
		else e.setAttribute(k, v === true ? '' : v);
	}
	for (const c of children.flat()) {
		if (c === null || c === undefined || c === false) continue;
		e.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
	}
	return e;
}

export function readFile(file, asText) {
	return new Promise((res, rej) => {
		const r = new FileReader();
		r.onload = () => res(r.result);
		r.onerror = rej;
		if (asText) r.readAsText(file);
		else r.readAsArrayBuffer(file);
	});
}

export function pickFile(accept, multiple = false) {
	return new Promise((res) => {
		const i = document.createElement('input');
		i.type = 'file';
		i.accept = accept;
		i.multiple = multiple;
		i.onchange = () => res(Array.from(i.files || []));
		i.click();
	});
}

// Minimal IndexedDB key/value store (used to remember the open design's file handle across reloads).
function idb() {
	return new Promise((res, rej) => {
		const r = indexedDB.open('localcad', 1);
		r.onupgradeneeded = () => r.result.createObjectStore('kv');
		r.onsuccess = () => res(r.result);
		r.onerror = () => rej(r.error);
	});
}
export async function idbGet(key) {
	try {
		const db = await idb();
		return await new Promise((res) => { const q = db.transaction('kv').objectStore('kv').get(key); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); });
	} catch (e) { return undefined; }
}
export async function idbSet(key, value) {
	try {
		const db = await idb();
		await new Promise((res) => { const t = db.transaction('kv', 'readwrite'); if (value === undefined) t.objectStore('kv').delete(key); else t.objectStore('kv').put(value, key); t.oncomplete = res; t.onerror = res; });
	} catch (e) { /* storage unavailable */ }
}
