// Bundles src/ into a single self-contained, offline app (LocalCAD.html during development; DraftOtter.html in the
// download package).
import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

// The OpenCascade STEP reader's WebAssembly, gzip-compressed and embedded (decompressed on first use).
const occtWasm = {
	name: 'occt-wasm',
	setup(b) {
		b.onResolve({ filter: /^virtual:occt-wasm-gz$/ }, (a) => ({ path: a.path, namespace: 'occtwasm' }));
		b.onLoad({ filter: /.*/, namespace: 'occtwasm' }, () => ({
			contents: 'export default ' + JSON.stringify(gzipSync(readFileSync('node_modules/occt-import-js/dist/occt-import-js.wasm'), { level: 9 }).toString('base64')),
			loader: 'js',
		}));
	},
};

// The background geometry worker (src/csgworker.js), bundled on its own and embedded as source text.
let workerCode = '';
const csgWorker = {
	name: 'csg-worker',
	setup(b) {
		b.onResolve({ filter: /^virtual:csg-worker$/ }, (a) => ({ path: a.path, namespace: 'csgworker' }));
		b.onLoad({ filter: /.*/, namespace: 'csgworker' }, () => ({ contents: 'export default ' + JSON.stringify(workerCode), loader: 'js' }));
	},
};

// The Draco mesh decoder (compressed GLB files), embedded gzipped: its JS wrapper as text and its wasm.
const dracoDecoder = {
	name: 'draco-decoder',
	setup(b) {
		b.onResolve({ filter: /^virtual:draco-decoder$/ }, (a) => ({ path: a.path, namespace: 'draco' }));
		b.onLoad({ filter: /.*/, namespace: 'draco' }, () => {
			const dir = 'node_modules/three/examples/jsm/libs/draco/gltf/';
			const gz = (p) => gzipSync(readFileSync(dir + p), { level: 9 }).toString('base64');
			return { contents: 'export const wrapper = ' + JSON.stringify(gz('draco_wasm_wrapper.js')) + '; export const wasm = ' + JSON.stringify(gz('draco_decoder.wasm')) + ';', loader: 'js' };
		});
	},
};

// an id for this build (the sources and package versions): caches made by an older build are not reused
import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
function buildId() {
	const h = createHash('sha256');
	const walk = (d) => { for (const f of readdirSync(d).sort()) { const p = d + '/' + f; if (statSync(p).isDirectory()) walk(p); else h.update(p).update(readFileSync(p)); } };
	walk('src');
	h.update(readFileSync('package-lock.json'));
	return h.digest('hex').slice(0, 12);
}

const watch = process.argv.includes('--watch');
const dev = process.argv.includes('--dev');

const options = {
	entryPoints: ['src/app.js'],
	bundle: true,
	format: 'esm',
	platform: 'browser',
	target: ['chrome100', 'firefox100', 'safari15'],
	minify: !dev,
	write: false,
	legalComments: 'none',
	external: ['node:*', 'fs', 'path', 'crypto'],
	plugins: [occtWasm, csgWorker, dracoDecoder],
	define: {},
	loader: { '.wasm': 'binary', '.json': 'json', '.woff': 'base64' },
	logLevel: 'warning',
};

async function build() {
	const w = await esbuild.build({
		entryPoints: ['src/csgworker.js'], bundle: true, format: 'iife', platform: 'browser', target: options.target,
		minify: !dev, write: false, legalComments: 'none', external: options.external, logLevel: 'error',
		define: { 'import.meta.url': '"file:///csgworker.js"' }, // the wasm bytes are passed in, nothing is fetched
	});
	workerCode = w.outputFiles[0].text;
	options.define.__LOCALCAD_BUILD__ = JSON.stringify(buildId());
	const res = await esbuild.build(options);
	const js = res.outputFiles[0].text.replace(/<\/script/gi, '<\/script');
	const css = readFileSync('src/style.css', 'utf8');
	const html = readFileSync('src/index.html', 'utf8')
		.replace('/*__CSS__*/', () => css)
		.replace('/*__JS__*/', () => js)
		// the otter badge (top bar, tab icon, loading screen), inlined so the app stays one file
		.replaceAll('__BRAND_BADGE__', 'data:image/png;base64,' + readFileSync('src/assets/brand-badge.png').toString('base64'));
	writeFileSync('LocalCAD.html', html);
	console.log(`LocalCAD.html written (${(html.length / 1024 / 1024).toFixed(2)} MB)`);
}

await build();
if (watch) {
	const { watch: fsWatch } = await import('node:fs');
	let t;
	fsWatch('src', { recursive: true }, () => {
		clearTimeout(t);
		t = setTimeout(() => build().catch((e) => console.error(e.message)), 150);
	});
	console.log('Watching src/ …');
}
