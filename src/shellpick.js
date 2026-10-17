// Mini 3D view for Shell / hollow out: orbit the part and click the flat faces that should stay open.
// Outermost faces facing ±X/±Y/±Z map to the quick Top/Bottom/… choices (exact); any other flat face is
// returned as a custom opening { origin, quat, loops } in the part's (scaled) local frame.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { faceRegion } from './pushpull.js';

const DIRS = { top: [2, 1], bottom: [2, -1], front: [1, -1], back: [1, 1], left: [0, -1], right: [0, 1] };

export function createShellPicker(geometry, node, { width = 400, height = 250, onChange } = {}) {
	const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
	renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
	renderer.setSize(width, height);
	const canvas = renderer.domElement;
	canvas.className = 'shell-pick-canvas';
	const scene = new THREE.Scene();
	scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.6));
	const sun = new THREE.DirectionalLight(0xffffff, 1.4);
	sun.position.set(1, -1.5, 2);
	scene.add(sun);
	const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: node.color || '#e8613a', roughness: 0.6, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
	mesh.scale.set(...node.scale);
	scene.add(mesh);
	mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 30), new THREE.LineBasicMaterial({ color: 0x111418, transparent: true, opacity: 0.5 })));
	mesh.updateMatrixWorld(true);
	const box = new THREE.Box3().setFromObject(mesh), size = box.getSize(new THREE.Vector3()), ctr = box.getCenter(new THREE.Vector3());
	const R = size.length() / 2 || 10;
	const camera = new THREE.PerspectiveCamera(35, width / height, R / 100, R * 100);
	camera.up.set(0, 0, 1);
	camera.position.copy(ctr).add(new THREE.Vector3(1.1, -1.6, 1.1).normalize().multiplyScalar(R * 3.2));
	const controls = new OrbitControls(camera, canvas);
	controls.target.copy(ctr);
	controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
	controls.update();
	const overlays = new THREE.Group();
	scene.add(overlays);
	const quick = new Set(); // 'top', 'front', …
	const custom = []; // { key, origin, quat, loops, tris }
	let hover = null;

	const render = () => renderer.render(scene, camera);
	controls.addEventListener('change', render);

	const triMesh = (pos, color, opacity) => {
		const g = new THREE.BufferGeometry();
		g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
		const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthTest: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
		return m;
	};
	// triangles of the outermost face(s) facing a quick direction
	const quickTris = (dir) => {
		const [ax, sg] = DIRS[dir], p = geometry.attributes.position.array, out = [];
		const ext = sg > 0 ? box.max.getComponent(ax) : box.min.getComponent(ax), s = node.scale;
		const v = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
		for (let i = 0; i < p.length; i += 9) {
			a.set(p[i] * s[0], p[i + 1] * s[1], p[i + 2] * s[2]); b.set(p[i + 3] * s[0], p[i + 4] * s[1], p[i + 5] * s[2]); c.set(p[i + 6] * s[0], p[i + 7] * s[1], p[i + 8] * s[2]);
			v.subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
			if (v.getComponent(ax) * sg > 0.999 && [a, b, c].every((q) => Math.abs(q.getComponent(ax) - ext) < 1e-3)) out.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
		}
		return out;
	};
	const redraw = () => {
		overlays.children.forEach((o) => o.geometry.dispose());
		overlays.clear();
		for (const d of quick) { const t = quickTris(d); if (t.length) overlays.add(triMesh(t, 0xffa43d, 0.85)); }
		for (const f of custom) overlays.add(triMesh(f.tris, 0xffa43d, 0.85));
		if (hover) overlays.add(triMesh(hover.tris, 0x19b8b4, hover.curved ? 0.25 : 0.55));
		render();
	};
	const rc = new THREE.Raycaster();
	const pick = (e) => {
		const r = canvas.getBoundingClientRect();
		rc.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
		const hit = rc.intersectObject(mesh, false)[0];
		if (!hit) return null;
		const reg = faceRegion(mesh, hit.faceIndex);
		if (!reg) return null;
		if (reg.curved) return { curved: true, tris: reg.tris };
		const n = new THREE.Vector3(0, 0, 1).applyQuaternion(reg.basis.quat);
		// an outermost axis-aligned face → quick choice
		let dir = null;
		for (const [k, [ax, sg]] of Object.entries(DIRS)) {
			const ext = sg > 0 ? box.max.getComponent(ax) : box.min.getComponent(ax);
			if (n.getComponent(ax) * sg > 0.999 && Math.abs(reg.origin.getComponent(ax) - ext) < 1e-3) dir = k;
		}
		const key = reg.origin.toArray().map((x) => x.toFixed(3)).join(',') + '|' + n.toArray().map((x) => x.toFixed(3)).join(',');
		return { dir, key, origin: reg.origin.clone(), quat: reg.basis.quat.clone(), loops: reg.loops, tris: reg.tris, curved: false };
	};
	let downAt = null;
	canvas.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
	canvas.addEventListener('pointermove', (e) => {
		if (e.buttons) return;
		hover = pick(e);
		canvas.style.cursor = hover && !hover.curved ? 'pointer' : hover ? 'not-allowed' : 'grab';
		canvas.title = hover && hover.curved ? 'Only flat faces can be left open' : 'Click a flat face to leave it open · drag to turn the view';
		redraw();
	});
	canvas.addEventListener('pointerleave', () => { hover = null; redraw(); });
	canvas.addEventListener('click', (e) => {
		if (downAt && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return; // that was an orbit drag
		const f = pick(e);
		if (!f || f.curved) return;
		if (f.dir) { if (quick.has(f.dir)) quick.delete(f.dir); else quick.add(f.dir); }
		else {
			const i = custom.findIndex((c) => c.key === f.key);
			if (i >= 0) custom.splice(i, 1); else custom.push(f);
		}
		redraw();
		if (onChange) onChange({ quick: [...quick], custom: custom.length });
	});
	redraw();
	return {
		canvas,
		setQuick(dir, on) { if (on) quick.add(dir); else quick.delete(dir); redraw(); },
		quick: () => [...quick],
		custom: () => custom.map(({ origin, quat, loops }) => ({ origin, quat, loops })),
		dispose() { controls.dispose(); mesh.children.forEach((c) => c.geometry.dispose()); overlays.children.forEach((o) => o.geometry.dispose()); renderer.dispose(); renderer.forceContextLoss(); },
	};
}
