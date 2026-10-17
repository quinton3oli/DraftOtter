// STL import/export.
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';

export function stlBinary(geom) {
	const p = geom.attributes.position.array;
	const tris = p.length / 9;
	const buf = new ArrayBuffer(84 + tris * 50);
	const dv = new DataView(buf);
	const header = 'DraftOtter STL export';
	for (let i = 0; i < 80; i++) dv.setUint8(i, i < header.length ? header.charCodeAt(i) : 32);
	dv.setUint32(80, tris, true);
	let o = 84;
	const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
	for (let t = 0; t < tris; t++) {
		const i = t * 9;
		a.set(p[i], p[i + 1], p[i + 2]);
		b.set(p[i + 3], p[i + 4], p[i + 5]);
		c.set(p[i + 6], p[i + 7], p[i + 8]);
		n.subVectors(c, b).cross(a.clone().sub(b)).normalize();
		if (!isFinite(n.x)) n.set(0, 0, 0);
		dv.setFloat32(o, n.x, true); dv.setFloat32(o + 4, n.y, true); dv.setFloat32(o + 8, n.z, true);
		o += 12;
		for (let k = 0; k < 9; k++) { dv.setFloat32(o, p[i + k], true); o += 4; }
		dv.setUint16(o, 0, true);
		o += 2;
	}
	return buf;
}

export function stlAscii(geom, name = 'localcad') {
	const p = geom.attributes.position.array;
	const out = [`solid ${name}`];
	const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
	const f = (v) => v.toExponential(6);
	for (let i = 0; i < p.length; i += 9) {
		a.set(p[i], p[i + 1], p[i + 2]);
		b.set(p[i + 3], p[i + 4], p[i + 5]);
		c.set(p[i + 6], p[i + 7], p[i + 8]);
		n.subVectors(c, b).cross(a.clone().sub(b)).normalize();
		if (!isFinite(n.x)) n.set(0, 0, 0);
		out.push(` facet normal ${f(n.x)} ${f(n.y)} ${f(n.z)}`, '  outer loop');
		for (const v of [a, b, c]) out.push(`   vertex ${f(v.x)} ${f(v.y)} ${f(v.z)}`);
		out.push('  endloop', ' endfacet');
	}
	out.push(`endsolid ${name}`);
	return out.join('\n');
}

// Returns non-indexed positions centered on their bounding box, plus the size.
export function parseSTL(arrayBuffer) {
	const g = new STLLoader().parse(arrayBuffer);
	const geom = g.index ? g.toNonIndexed() : g;
	geom.computeBoundingBox();
	const c = geom.boundingBox.getCenter(new THREE.Vector3());
	geom.translate(-c.x, -c.y, -c.z);
	geom.computeBoundingBox();
	const size = geom.boundingBox.getSize(new THREE.Vector3());
	return { positions: new Float32Array(geom.attributes.position.array), size, tris: geom.attributes.position.count / 3 };
}
