// STEP / IGES / BREP import through OpenCascade (occt-import-js). The 7.6 MB WebAssembly reader is embedded
// gzip-compressed and only decompressed and started the first time a CAD file is imported.
import occtFactory from 'occt-import-js';
import wasmGzB64 from 'virtual:occt-wasm-gz';
import { f32ToBase64, hashString } from './util.js';

let occtPromise = null;

async function gunzip(b64) {
	const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
	const stream = new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function loadOCCT() {
	if (!occtPromise) occtPromise = (async () => occtFactory({ wasmBinary: await gunzip(wasmGzB64) }))();
	return occtPromise;
}

/**
 * Read a CAD file into bodies: [{ name, color ('#rrggbb' or null), positions (non-indexed Float32Array, mm) }].
 * fine: tessellation quality (smaller = finer).
 */
export async function readCADFile(name, bytes, { fine = 0.0008 } = {}) {
	const occt = await loadOCCT();
	const params = { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: fine, angularDeflection: 0.35 };
	const ext = name.toLowerCase().split('.').pop();
	const res = ext === 'igs' || ext === 'iges' ? occt.ReadIgesFile(bytes, params) : ext === 'brep' || ext === 'brp' ? occt.ReadBrepFile(bytes, params) : occt.ReadStepFile(bytes, params);
	if (!res || !res.success) throw new Error('OpenCascade could not read this file');
	const hex = (c) => (c ? '#' + c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('') : null);
	const bodies = [];
	res.meshes.forEach((m, i) => {
		const p = m.attributes.position.array, idx = m.index ? m.index.array : null;
		const n = idx ? idx.length : p.length / 3;
		const out = new Float32Array(n * 3);
		for (let k = 0; k < n; k++) { const v = idx ? idx[k] : k; out[k * 3] = p[v * 3]; out[k * 3 + 1] = p[v * 3 + 1]; out[k * 3 + 2] = p[v * 3 + 2]; }
		if (n >= 3) bodies.push({ name: m.name || `${name.replace(/\.[^.]+$/, '')} ${i + 1}`, color: hex(m.color), positions: out });
	});
	return bodies;
}

/** Store a body as a mesh blob; returns the blob hash. */
export function storeBody(model, positions) {
	const b64 = f32ToBase64(positions);
	const h = hashString(b64);
	model.blobs[h] = b64;
	return h;
}
