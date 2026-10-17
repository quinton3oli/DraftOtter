// Import OBJ and glTF / GLB meshes (what AI image-to-3D tools and many 3D apps export) as mesh parts: one part per
// mesh or all merged, Y-up models stood up on Z, scaled to a size in mm. Draco and meshopt compressed GLBs work.
import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { wrapper as dracoWrapperGz, wasm as dracoWasmGz } from 'virtual:draco-decoder';
import { makeNode } from './model.js';
import { storeBody } from './stepimport.js';
import { round, fmt, evalExpr, toast, el, pickFile, readFile } from './util.js';

const MESH_RE = /\.(obj|glb|gltf)$/i;
export const isMeshFile = (f) => MESH_RE.test(f.name);

async function gunzip(b64) {
	const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
	const stream = new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

let draco = null;
/** A Draco loader whose decoder comes from the copy embedded in the app (works offline, no files to fetch). */
function dracoLoader() {
	if (draco) return draco;
	draco = new DRACOLoader();
	draco.setDecoderConfig({ type: 'wasm' });
	draco._loadLibrary = async (url) => {
		if (/wrapper/.test(url)) return new TextDecoder().decode(await gunzip(dracoWrapperGz));
		return (await gunzip(dracoWasmGz)).buffer;
	};
	return draco;
}

/** File → three.js scene (Object3D). */
export async function parseMeshFile(file) {
	if (/\.obj$/i.test(file.name)) return new OBJLoader().parse(await readFile(file, true));
	const loader = new GLTFLoader();
	loader.setDRACOLoader(dracoLoader());
	loader.setMeshoptDecoder(MeshoptDecoder);
	const data = /\.gltf$/i.test(file.name) ? await readFile(file, true) : await readFile(file);
	const gltf = await new Promise((res, rej) => loader.parse(data, '', res, (e) => rej(e instanceof Error ? e : new Error(String(e && e.message || e)))));
	const root = gltf.scene || (gltf.scenes && gltf.scenes[0]);
	// the loader tidies names for animation (spaces become _); keep the names as written in the file
	const json = gltf.parser && gltf.parser.json, assoc = gltf.parser && gltf.parser.associations;
	if (json && assoc) root.traverse((o) => { const a = assoc.get(o); const def = a && a.nodes !== undefined ? json.nodes[a.nodes] : null; if (def && def.name) o.userData.fileName = def.name; });
	return root;
}

/** The meshes of a scene as world-space triangle soups: [{ name, positions: Float32Array, color }]. */
export function sceneMeshes(root) {
	root.updateMatrixWorld(true);
	const out = [];
	root.traverse((o) => {
		if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
		let g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
		g.applyMatrix4(o.matrixWorld);
		const pos = g.attributes.position;
		const positions = new Float32Array(pos.count * 3);
		for (let i = 0; i < pos.count; i++) { positions[3 * i] = pos.getX(i); positions[3 * i + 1] = pos.getY(i); positions[3 * i + 2] = pos.getZ(i); }
		const mat = Array.isArray(o.material) ? o.material[0] : o.material;
		const named = (x) => x && (x.userData.fileName || x.name);
		out.push({ name: named(o) || named(o.parent) || 'Mesh', positions, color: mat && mat.color ? '#' + mat.color.getHexString() : null });
	});
	return out;
}

export const MeshImportMixin = {
	async importMeshFile(file) {
		if (!file) { const files = await pickFile('.obj,.glb,.gltf', false); file = files && files[0]; }
		if (!file) return;
		let meshes;
		try {
			meshes = sceneMeshes(await parseMeshFile(file));
		} catch (e) {
			console.error(e);
			toast(`Could not read ${file.name}: ${e.message}`, 'error', 6000);
			return;
		}
		meshes = meshes.filter((m) => m.positions.length >= 9);
		if (!meshes.length) { toast('No meshes in that file', 'warn'); return; }
		const base = file.name.replace(MESH_RE, '');
		const tris = meshes.reduce((n, m) => n + m.positions.length / 9, 0);
		// size as stored (glTF is in meters; AI-made models are usually about 1 unit across)
		const box = new THREE.Box3();
		for (const m of meshes) for (let i = 0; i < m.positions.length; i += 3) box.expandByPoint(new THREE.Vector3(m.positions[i], m.positions[i + 1], m.positions[i + 2]));
		const sz = box.getSize(new THREE.Vector3()), longest = Math.max(sz.x, sz.y, sz.z) || 1;
		const glb = /\.(glb|gltf)$/i.test(file.name);
		const guess = longest < 10 ? 50 : longest; // tiny means meters or unitless: suggest 50 mm
		const inp = (id, v) => el('input', { id, type: 'text', value: v, style: 'width:90px' });
		const form = el('div', { class: 'form' },
			el('p', { class: 'muted small' }, `${file.name}: ${meshes.length} mesh${meshes.length > 1 ? 'es' : ''}, ${Math.round(tris).toLocaleString()} triangles · ${fmt(sz.x, 3)} × ${fmt(sz.y, 3)} × ${fmt(sz.z, 3)} ${glb ? '(meters in the file)' : 'units'}`),
			el('label', { class: 'row' }, el('span', {}, 'Longest side (mm)'), inp('mi-size', round(guess, 3))),
			el('label', { class: 'check' }, el('input', { id: 'mi-yup', type: 'checkbox', checked: true }), el('span', {}, 'Y is up in the file (stand it up on Z)')),
			meshes.length > 1 ? el('label', { class: 'check' }, el('input', { id: 'mi-merge', type: 'checkbox', checked: true }), el('span', {}, `Merge into one part (otherwise ${meshes.length} parts)`)) : null,
			el('p', { class: 'muted small' }, 'Imported as mesh parts: move, scale, cut holes in them or join them with other shapes. Colors and textures are not kept.'));
		this.modal('Import ' + (glb ? 'glTF / GLB' : 'OBJ'), form, [{ label: 'Cancel' }, {
			label: 'Import', primary: true, action: () => {
				const size = evalExpr(form.querySelector('#mi-size').value, this.varValues || {});
				if (!(size > 0)) { toast('Enter a size greater than 0', 'error'); return false; }
				const yUp = form.querySelector('#mi-yup').checked, merge = meshes.length === 1 || (form.querySelector('#mi-merge') || {}).checked;
				const s = size / longest, c = box.getCenter(new THREE.Vector3());
				// center on the origin, scale to size, and turn Y-up into Z-up (x, y, z) → (x, −z, y)
				const place = (p) => {
					const q = new Float32Array(p.length);
					for (let i = 0; i < p.length; i += 3) {
						const x = (p[i] - c.x) * s, y = (p[i + 1] - c.y) * s, z = (p[i + 2] - c.z) * s;
						if (yUp) { q[i] = x; q[i + 1] = -z; q[i + 2] = y; } else { q[i] = x; q[i + 1] = y; q[i + 2] = z; }
					}
					return q;
				};
				const parts = merge ? [{ name: base, positions: concat(meshes.map((m) => m.positions)), color: meshes[0].color }] : meshes;
				const ids = [];
				for (const part of parts) {
					const node = makeNode('mesh', { blob: storeBody(this.model, place(part.positions)) }, { name: merge ? base : part.name || base, ...(part.color && part.color !== '#ffffff' ? { color: part.color } : {}) });
					this.addNode(node);
					ids.push(node.id);
				}
				this.setSelection(ids);
				toast(`Imported ${base} — ${Math.round(tris).toLocaleString()} triangles, ${fmt(size, 1)} mm long`, 'ok', 4000);
			},
		}]);
	},
};

function concat(arrays) {
	const n = arrays.reduce((k, a) => k + a.length, 0), out = new Float32Array(n);
	let o = 0;
	for (const a of arrays) { out.set(a, o); o += a.length; }
	return out;
}
