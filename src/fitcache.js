// Grown (fitted) hole shapes that were slow to make are kept in IndexedDB, so reopening a design or reloading the page
// doesn't have to grow them again. The whole store is read once at startup so lookups stay synchronous.
import * as THREE from 'three';

const DB = 'localcad-cache', STORE = 'fits', VERSION = 'v1', LIMIT = 80 * 1024 * 1024;
const mem = new Map(); // hash -> { p, n, i, t, size }
let db = null;

/** 53-bit string hash (cyrb53) with the length mixed in. */
export function hashKey(str) {
	let h1 = 0xdeadbeef ^ str.length, h2 = 0x41c6ce57 ^ str.length;
	for (let i = 0; i < str.length; i++) {
		const ch = str.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return VERSION + ':' + (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36) + ':' + str.length.toString(36);
}

const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

/** Read the stored shapes into memory (dropping the oldest beyond the size limit). Never throws. */
export async function loadFitCache() {
	try {
		const open = indexedDB.open(DB, 1);
		open.onupgradeneeded = () => open.result.createObjectStore(STORE);
		db = await req(open);
		const tx = db.transaction(STORE);
		const [keys, vals] = await Promise.all([req(tx.objectStore(STORE).getAllKeys()), req(tx.objectStore(STORE).getAll())]);
		const all = keys.map((k, i) => [k, vals[i]]).filter(([k, v]) => v && String(k).startsWith(VERSION + ':')).sort((a, b) => b[1].t - a[1].t);
		let total = 0;
		const drop = [];
		for (const [k, v] of all) { total += v.size || 0; if (total > LIMIT) drop.push(k); else mem.set(k, v); }
		for (const k of keys) if (!String(k).startsWith(VERSION + ':')) drop.push(k);
		if (drop.length) { const w = db.transaction(STORE, 'readwrite'); for (const k of drop) w.objectStore(STORE).delete(k); }
	} catch (e) {
		db = null; // storage unavailable (private window, file:// restrictions): just compute every time
	}
	return mem.size;
}

/** A stored shape as a fresh geometry, or null. */
export function getFit(hash) {
	const v = mem.get(hash);
	if (!v) return null;
	const g = new THREE.BufferGeometry();
	g.setAttribute('position', new THREE.BufferAttribute(v.p.slice(), 3));
	if (v.n) g.setAttribute('normal', new THREE.BufferAttribute(v.n.slice(), 3));
	if (v.i) g.setIndex(new THREE.BufferAttribute(v.i.slice(), 1));
	v.t = Date.now();
	return g;
}

/** Remember a shape (in memory now, on disk in the background). */
export function putFit(hash, g) {
	const p = g.attributes.position.array.slice(), n = g.attributes.normal ? g.attributes.normal.array.slice() : null, i = g.index ? g.index.array.slice() : null;
	const v = { p, n, i, t: Date.now(), size: p.byteLength + (n ? n.byteLength : 0) + (i ? i.byteLength : 0) };
	mem.set(hash, v);
	if (!db) return;
	try { db.transaction(STORE, 'readwrite').objectStore(STORE).put(v, hash); } catch (e) { /* full or closed: fine */ }
}

/** Forget every stored shape. */
export function clearFitCache() {
	mem.clear();
	if (db) try { db.transaction(STORE, 'readwrite').objectStore(STORE).clear(); } catch (e) { /* ignore */ }
}
