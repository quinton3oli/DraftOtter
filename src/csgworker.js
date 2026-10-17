// Background geometry worker: runs the Manifold kernel (booleans, offsets, fit growth) off the main thread.
// Bundled separately by build.mjs and started from a Blob; the main thread sends the wasm bytes once.
import Module from 'manifold-3d/manifold.js';
import { setMF, csgRaw, growRaw, setFastFit, creased } from './csgcore.js';

let ready = null;
const geo = (a) => ({ attributes: { position: { array: a } }, index: null });

self.onmessage = async (e) => {
	const m = e.data;
	if (m.type === 'init') {
		ready = Module({ wasmBinary: m.wasm }).then((mod) => { mod.setup(); setMF(mod); });
		ready.then(() => self.postMessage({ type: 'ready' }), (err) => self.postMessage({ type: 'failed', error: String(err) }));
		return;
	}
	try {
		await ready;
		setFastFit(m.fast !== false);
		const t0 = performance.now();
		let r = null;
		if (m.op === 'csg') r = csgRaw(m.solids.map(geo), m.holes.map(geo), m.intersect, m.offset || 0, m.mod || null);
		else if (m.op === 'grow') r = growRaw(m.geoms.map(geo), m.c, m.axes);
		else throw new Error('unknown op ' + m.op);
		const ms = performance.now() - t0;
		// ready-to-draw triangles with normals, so the main thread only wraps them
		const out = r ? creased(r) : null;
		self.postMessage({ id: m.id, ok: true, r: out, ms }, out ? [out.pos.buffer, out.normal.buffer] : []);
	} catch (err) {
		self.postMessage({ id: m.id, ok: false, error: String((err && err.message) || err) });
	}
};
