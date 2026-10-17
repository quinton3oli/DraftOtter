// Minimal ZIP writer (stored / uncompressed entries) and reader, enough for 3MF packages and batch exports.

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

export function crc32(bytes) {
	let c = 0xffffffff;
	for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

const enc = new TextEncoder();
const toBytes = (d) => (typeof d === 'string' ? enc.encode(d) : d instanceof Uint8Array ? d : new Uint8Array(d.buffer || d));

/** files: [{ name, data: string | Uint8Array | ArrayBuffer }] → Uint8Array of a .zip */
export function makeZip(files) {
	const entries = files.map((f) => ({ name: enc.encode(f.name), data: toBytes(f.data) }));
	let size = 22;
	for (const e of entries) size += 30 + e.name.length + e.data.length + 46 + e.name.length;
	const out = new Uint8Array(size), dv = new DataView(out.buffer);
	let o = 0;
	const central = [];
	// fixed DOS timestamp (1 Jan 2024) so identical inputs give identical files
	const time = 0, date = ((2024 - 1980) << 9) | (1 << 5) | 1;
	for (const e of entries) {
		const crc = crc32(e.data);
		central.push({ e, crc, offset: o });
		dv.setUint32(o, 0x04034b50, true); dv.setUint16(o + 4, 20, true); dv.setUint16(o + 6, 0x0800, true); dv.setUint16(o + 8, 0, true);
		dv.setUint16(o + 10, time, true); dv.setUint16(o + 12, date, true); dv.setUint32(o + 14, crc, true);
		dv.setUint32(o + 18, e.data.length, true); dv.setUint32(o + 22, e.data.length, true);
		dv.setUint16(o + 26, e.name.length, true); dv.setUint16(o + 28, 0, true);
		out.set(e.name, o + 30); out.set(e.data, o + 30 + e.name.length);
		o += 30 + e.name.length + e.data.length;
	}
	const cdStart = o;
	for (const { e, crc, offset } of central) {
		dv.setUint32(o, 0x02014b50, true); dv.setUint16(o + 4, 20, true); dv.setUint16(o + 6, 20, true); dv.setUint16(o + 8, 0x0800, true);
		dv.setUint16(o + 10, 0, true); dv.setUint16(o + 12, time, true); dv.setUint16(o + 14, date, true); dv.setUint32(o + 16, crc, true);
		dv.setUint32(o + 20, e.data.length, true); dv.setUint32(o + 24, e.data.length, true); dv.setUint16(o + 28, e.name.length, true);
		dv.setUint16(o + 30, 0, true); dv.setUint16(o + 32, 0, true); dv.setUint16(o + 34, 0, true); dv.setUint16(o + 36, 0, true);
		dv.setUint32(o + 38, 0, true); dv.setUint32(o + 42, offset, true);
		out.set(e.name, o + 46);
		o += 46 + e.name.length;
	}
	dv.setUint32(o, 0x06054b50, true); dv.setUint16(o + 4, 0, true); dv.setUint16(o + 6, 0, true);
	dv.setUint16(o + 8, entries.length, true); dv.setUint16(o + 10, entries.length, true);
	dv.setUint32(o + 12, o - cdStart, true); dv.setUint32(o + 16, cdStart, true); dv.setUint16(o + 20, 0, true);
	return out;
}

/** Read the stored (uncompressed) entries of a zip made by makeZip. Returns { name: Uint8Array }. */
export function readZip(bytes) {
	const u8 = toBytes(bytes), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), out = {};
	const dec = new TextDecoder();
	let o = 0;
	while (o + 30 <= u8.length && dv.getUint32(o, true) === 0x04034b50) {
		const method = dv.getUint16(o + 8, true), csize = dv.getUint32(o + 18, true), nlen = dv.getUint16(o + 26, true), xlen = dv.getUint16(o + 28, true);
		const name = dec.decode(u8.subarray(o + 30, o + 30 + nlen));
		const start = o + 30 + nlen + xlen;
		if (method === 0) out[name] = u8.subarray(start, start + csize);
		o = start + csize;
	}
	return out;
}
