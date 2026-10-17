import { readFileSync } from 'node:fs';
import Module from 'manifold-3d';
import { Engine, initManifold } from '../src/engine.js';
import { Model, makeNode, makeGroup } from '../src/model.js';
import { signedVolume } from '../src/shapes.js';
import { CATALOG, fontKey } from '../src/fontlib.js';
await initManifold(Module, readFileSync('node_modules/manifold-3d/manifold.wasm'));
const eng = new Engine(new Model());
let bad = 0;
for (const f of [{ id: 'helvetiker', faces: { regular: 1, bold: 1 } }, ...CATALOG]) for (const st of Object.keys(f.faces)) {
	const key = fontKey(f.id, st);
	const t0 = performance.now();
	const n = makeNode('text', { text: 'Ag8 &B!', size: 10, depth: 2, font: key });
	const g = eng.geometry(n);
	const v = g ? signedVolume(g) : 0;
	// boolean with a plate: fails if the glyph mesh is not a clean solid
	eng.errors.clear();
	const grp = makeGroup([makeNode('box', { w: 80, d: 20, h: 2 }), n]);
	const gg = eng.geometry(grp);
	const ok = v > 10 && gg && !eng.errors.size;
	if (!ok) bad++;
	console.log(ok ? 'ok  ' : 'FAIL', key.padEnd(28), 'vol', v.toFixed(1), (performance.now() - t0).toFixed(0) + 'ms');
}
console.log(bad ? bad + ' bad' : 'all fonts ok');
process.exit(bad ? 1 : 0);
