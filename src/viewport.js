// Three.js viewport: rendering, camera, picking, dragging, gizmo, view cube, measure.
import * as THREE from 'three';
import { isSculptedBlob, SCULPT_CREASE } from './shapes.js';
import { roundFeatureAt } from './measureGeo.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { nodeMatrix } from './engine.js';
import { DEG, round, fmt } from './util.js';
import { EditHandles } from './handles.js';
import { AlignTool } from './align.js';
import { FilletTool } from './filletTool.js';
import { PushPullTool, faceRegion } from './pushpull.js';
import { sharpEdges } from './meshutil.js';
import { SectionTool, sectionNormal, capOutline } from './sectiontool.js';
import { arcAround } from './measureGeo.js';
import { paintedGeometry, effectivePaint } from './paint.js';
import { symmetryHelper } from './symmetry.js';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const Z_UP = new THREE.Vector3(0, 0, 1);

// Shared uniforms for overhang + section shading on every solid material.
const U = {
	uOverhang: { value: 0 },
	uOverhangSin: { value: Math.sin(45 * DEG) },
	uSection: { value: 0 },
};

function patchMaterial(mat) {
	mat.onBeforeCompile = (shader) => {
		Object.assign(shader.uniforms, U);
		shader.vertexShader = shader.vertexShader
			.replace('#include <common>', '#include <common>\nvarying vec3 vWN;\nvarying vec3 vWP;')
			.replace('#include <begin_vertex>', '#include <begin_vertex>\nvWP = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWN = normalize(mat3(modelMatrix) * objectNormal);');
		shader.fragmentShader = shader.fragmentShader
			.replace('#include <common>', '#include <common>\nvarying vec3 vWN;\nvarying vec3 vWP;\nuniform float uOverhang;\nuniform float uOverhangSin;\nuniform float uSection;')
			.replace('#include <dithering_fragment>', `#include <dithering_fragment>
	if (uOverhang > 0.5 && gl_FrontFacing && normalize(vWN).z < -uOverhangSin && vWP.z > 0.15) {
		gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(1.0, 0.12, 0.08), 0.75);
	}
	if (uSection > 0.5 && !gl_FrontFacing) gl_FragColor = vec4(0.86, 0.32, 0.28, 1.0);`);
	};
	mat.customProgramCacheKey = () => 'lcad-solid';
	return mat;
}

/** A part drawn see-through in the view: its See-through switch is on (n.seeThrough) and n.opacity is below 1. */
export function seeThrough(n) {
	return !!n.seeThrough && !n.hole && typeof n.opacity === 'number' && n.opacity < 1;
}

const edgeCache = new WeakMap(), sculptEdgeCache = new WeakMap();
/** The outline lines of a shape: edges sharper than 28° (CAD parts) or 80° (sculpted parts, see SCULPT_CREASE). */
function edgesFor(geom, angle = 28) {
	const cache = angle === 28 ? edgeCache : sculptEdgeCache;
	let e = cache.get(geom);
	if (!e) {
		// same lines as THREE.EdgesGeometry(geom, angle), found with typed-array hashing instead of string keys
		e = new THREE.BufferGeometry();
		e.setAttribute('position', new THREE.BufferAttribute(sharpEdges(geom.attributes.position.array, geom.index ? geom.index.array : null, angle), 3));
		cache.set(geom, e);
	}
	return e;
}

function makeLabel(cls) {
	const d = document.createElement('div');
	d.className = 'vp-label ' + (cls || '');
	return d;
}

export class Viewport {
	constructor(container, app) {
		this.app = app;
		this.container = container;
		this.objs = new Map(); // node id -> Object3D
		this.displays = new Map(); // node id -> mesh that shows the node
		this.selection = [];
		this.tool = null; // 'measure' | 'place'
		this.needsRender = true;
		this.gizmoMode = 'translate';

		const renderer = (this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true }));
		renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		renderer.localClippingEnabled = true;
		renderer.autoClear = false;
		// checking every shader for errors makes the GPU compile them one at a time while the page waits; three.js
		// still reports a shader that fails to link. Turn it back on with localStorage['draftotter-debug-shaders'] = 1.
		try { renderer.debug.checkShaderErrors = !!localStorage.getItem('draftotter-debug-shaders'); } catch (e) { renderer.debug.checkShaderErrors = false; }
		// the first frames wait for precompile(), so drawing doesn't compile shaders one at a time on the main thread
		this.holdFrames = true;
		setTimeout(() => { this.holdFrames = false; this.invalidate(); }, 8000); // whatever happens
		container.appendChild(renderer.domElement);
		const canvas = (this.canvas = renderer.domElement);
		canvas.tabIndex = 0;

		this.scene = new THREE.Scene();
		this.persp = new THREE.PerspectiveCamera(40, 1, 0.1, 50000);
		this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -50000, 50000);
		for (const c of [this.persp, this.ortho]) c.up.copy(Z_UP);
		this.camera = this.persp;
		this.persp.position.set(160, -220, 170);

		this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
		this.headLight = new THREE.DirectionalLight(0xffffff, 1.6);
		this.headLight.position.set(0.4, 0.6, 1);
		this.fillLight = new THREE.DirectionalLight(0xffffff, 0.5);
		this.fillLight.position.set(-1, -0.3, -0.6);
		for (const c of [this.persp, this.ortho]) {
			this.scene.add(c);
		}
		this.persp.add(this.headLight, this.fillLight);

		this.bed = new THREE.Group();
		this.scene.add(this.bed);
		this.root = new THREE.Group();
		this.scene.add(this.root);
		this.helpers = new THREE.Group();
		this.scene.add(this.helpers);

		this.overlay = document.createElement('div');
		this.overlay.className = 'vp-overlay';
		container.appendChild(this.overlay);
		this.handles = new EditHandles(this);
		this.alignTool = new AlignTool(this);
		this.filletTool = new FilletTool(this);
		this.sectionTool = new SectionTool(this);
		this.pushPull = new PushPullTool(this);

		// Transform gizmo. Registered before our own pointer handlers so it gets first dibs.
		const tc = (this.tc = new TransformControls(this.camera, canvas));
		tc.setSize(0.9);
		this.scene.add(tc.getHelper());
		// Drop the free-move center handle (dragging an object's body moves it on the workplane instead)
		// and the trackball rotate ring (arbitrary rotations are rarely wanted for mechanical parts).
		for (const [mode, name] of [['translate', 'XYZ'], ['rotate', 'XYZE']]) {
			for (const set of [tc._gizmo.picker[mode], tc._gizmo.gizmo[mode]]) {
				for (const h of set.children.filter((c) => c.name === name)) set.remove(h);
			}
		}
		// Start the axis-arrow hit zones away from the center, so grabbing an object's middle drags it on the workplane.
		// (three bakes each handle's transform into its geometry, so rebuild them pointing the same way.)
		for (const h of tc._gizmo.picker.translate.children) {
			if (!['X', 'Y', 'Z'].includes(h.name)) continue;
			h.geometry.computeBoundingBox();
			const c = h.geometry.boundingBox.getCenter(new THREE.Vector3());
			const i = ['X', 'Y', 'Z'].indexOf(h.name);
			const dir = new THREE.Vector3().setComponent(i, Math.sign(c.getComponent(i)) || 1);
			const g = new THREE.CylinderGeometry(0.2, 0, 0.45, 4);
			g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir));
			g.translate(dir.x * 0.375, dir.y * 0.375, dir.z * 0.375);
			h.geometry = g;
		}
		this.pivot = new THREE.Object3D();
		this.scene.add(this.pivot);
		tc.addEventListener('dragging-changed', (e) => {
			this.controls.enabled = !e.value;
		});
		tc.addEventListener('change', () => this.invalidate());
		tc.addEventListener('mouseDown', () => this.onGizmoStart());
		tc.addEventListener('objectChange', () => this.onGizmoChange());
		tc.addEventListener('mouseUp', () => this.onGizmoEnd());

		// Before the orbit controls see wheel / pointer events, move their pivot to the depth of what is under the
		// cursor. Zoom and pan speed scale with pivot distance, so this keeps them responsive however close you get.
		canvas.addEventListener('wheel', (e) => this.retarget(e), { capture: true, passive: true });
		canvas.addEventListener('pointerdown', (e) => this.retarget(e), true);
		canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
		canvas.addEventListener('pointermove', (e) => this.onHover(e));
		canvas.addEventListener('dblclick', (e) => this.onDblClick(e));
		canvas.addEventListener('contextmenu', (e) => e.preventDefault());

		const controls = (this.controls = new OrbitControls(this.camera, canvas));
		controls.enableDamping = true;
		controls.dampingFactor = 0.18;
		controls.zoomToCursor = true;
		controls.screenSpacePanning = true;
		controls.zoomSpeed = 2;
		controls.minDistance = 0.001;
		controls.maxDistance = 20000;
		controls.minZoom = 0.01;
		controls.maxZoom = 5000;
		// Right-drag orbits, middle-drag pans, wheel zooms. Left is kept for selecting and moving objects.
		controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
		controls.target.set(0, 0, 0);
		controls.addEventListener('change', () => this.invalidate());

		this.raycaster = new THREE.Raycaster();
		this.raycaster.params.Line.threshold = 0.5;

		// Section plane
		this.clipPlanes = [];
		this.sectionPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);

		// Measure helpers
		this.measure = { pts: [], ents: [], legs: [], line: null, markers: [], label: makeLabel('measure'), clabel: makeLabel('measure'), hlabel: makeLabel('measure hover'), pin: null, hover: null };
		for (const l of [this.measure.label, this.measure.clabel, this.measure.hlabel]) { this.overlay.appendChild(l); l.style.display = 'none'; }

		// Box select rectangle
		this.boxEl = document.createElement('div');
		this.boxEl.className = 'box-select';
		container.appendChild(this.boxEl);

		this.initViewCube();

		new ResizeObserver(() => this.resize()).observe(container);
		this.resize();
		this.loop();
	}

	invalidate() {
		this.needsRender = true;
	}

	retarget(e) {
		const cam = this.camera;
		if (cam.isOrthographicCamera || !this.controls || this.tc.dragging) return;
		this.raycaster.setFromCamera(this.ndc(e), cam);
		const hit = this.raycaster.intersectObjects(this.pickables(true), false).find((h) => this.clipOk(h.point));
		let p = hit ? hit.point : null;
		// The bed plane only counts near the scene: far out towards the horizon it would put the pivot so deep that
		// orbiting flings the view away and panning races off.
		const s = this.sceneSphere();
		if (!p) {
			const g = this.raycaster.ray.intersectPlane(new THREE.Plane(Z_UP, 0), new THREE.Vector3());
			if (g && g.distanceTo(s.center) < s.radius * 1.2) p = g;
		}
		const fwd = cam.getWorldDirection(new THREE.Vector3());
		const centerDepth = s.center.clone().sub(cam.position).dot(fwd);
		// Nothing useful under the cursor: pivot at the depth of the scene's center.
		let depth = p ? p.clone().sub(cam.position).dot(fwd) : centerDepth;
		if (!(depth > 1e-3)) return;
		depth = Math.min(depth, centerDepth + s.radius); // never beyond the far side of the scene
		// Keep the pivot on the view axis so the view does not jump.
		this.controls.target.copy(cam.position).addScaledVector(fwd, depth);
	}

	/** Exploded view: display offsets per top-level part (null = assembled). */
	setExplode(offsets) {
		this.explode = offsets;
		this.app.afterChange();
	}

	applyExplode() {
		if (!this.explode) return;
		for (const [id, d] of this.explode) { const o = this.objs.get(id); if (o) o.position.add(d); }
	}

	/** Hole Wizard preview: a ring of the hole's size on the face and a short axis line into the part. */
	showHolePreview(h) {
		if (this.holeObj) { this.helpers.remove(this.holeObj); this.holeObj.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); this.holeObj = null; }
		if (h) {
			const g = new THREE.Group();
			const ring = new THREE.Mesh(new THREE.RingGeometry(h.r * 0.82, h.r, 40), new THREE.MeshBasicMaterial({ color: 0x4fd1ff, side: THREE.DoubleSide, depthTest: false, transparent: true, opacity: 0.9 }));
			ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), h.normal);
			ring.position.copy(h.point).addScaledVector(h.normal, 0.05);
			ring.renderOrder = 27;
			g.add(ring);
			const axis = new THREE.Line(new THREE.BufferGeometry().setFromPoints([h.point.clone().addScaledVector(h.normal, h.r * 1.5), h.point.clone().addScaledVector(h.normal, -h.r * 3)]), new THREE.LineDashedMaterial({ color: 0x4fd1ff, dashSize: h.r * 0.4, gapSize: h.r * 0.25, depthTest: false }));
			axis.computeLineDistances();
			axis.renderOrder = 27;
			g.add(axis);
			this.helpers.add(g);
			this.holeObj = g;
		}
		this.invalidate();
	}

	/** Print-check highlights: colored triangles, red overlap solids and boxes around floating pieces. */
	showCheckHighlights(items) {
		if (this.checkObj) { this.helpers.remove(this.checkObj); this.checkObj.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); this.checkObj = null; }
		if (items) {
			const g = new THREE.Group();
			for (const it of items) {
				const h = it.highlight;
				if (!h || it.shown === false) continue;
				if (h.tris && h.geom) {
					const src = h.geom.attributes.position.array, out = new Float32Array(h.tris.length * 9);
					h.tris.forEach((t, k) => out.set(src.subarray(t * 9, t * 9 + 9), k * 9));
					const geo = new THREE.BufferGeometry();
					geo.setAttribute('position', new THREE.BufferAttribute(out, 3));
					geo.computeVertexNormals();
					const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: h.color, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
					m.renderOrder = 6;
					g.add(m);
				}
				for (const s of h.solids || []) {
					const m = new THREE.Mesh(s.clone(), new THREE.MeshBasicMaterial({ color: h.color, transparent: true, opacity: 0.55, depthTest: false }));
					m.renderOrder = 26;
					g.add(m);
				}
				for (const b of h.boxes || []) g.add(new THREE.Box3Helper(b.clone().expandByScalar(0.5), 0xff3b5c));
			}
			this.helpers.add(g);
			this.checkObj = g;
		}
		this.invalidate();
	}

	/** Translucent cutting plane (axis = pos) over a box, with optional pin markers; null clears it. */
	showCutPlane(axis, pos, box, pins = [], pinR = 1) {
		if (this.cutObj) { this.helpers.remove(this.cutObj); this.cutObj.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); this.cutObj = null; }
		if (axis && isFinite(pos)) {
			const g = new THREE.Group();
			const size = box.getSize(new THREE.Vector3()).addScalar(16), c = box.getCenter(new THREE.Vector3());
			const i = { x: 0, y: 1, z: 2 }[axis];
			const dims = [size.x, size.y, size.z];
			const [w, h] = axis === 'x' ? [dims[1], dims[2]] : axis === 'y' ? [dims[0], dims[2]] : [dims[0], dims[1]];
			const quad = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: 0xff8a3d, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false }));
			const edge = new THREE.LineSegments(new THREE.EdgesGeometry(quad.geometry), new THREE.LineBasicMaterial({ color: 0xff8a3d }));
			quad.add(edge);
			if (axis === 'x') quad.rotation.set(0, Math.PI / 2, 0);
			if (axis === 'y') quad.rotation.set(Math.PI / 2, 0, 0);
			const p = c.clone(); p.setComponent(i, pos);
			quad.position.copy(p);
			quad.renderOrder = 24;
			g.add(quad);
			for (const pin of pins) {
				const ring = new THREE.Mesh(new THREE.RingGeometry(pinR * 0.6, pinR, 24), new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, depthTest: false }));
				ring.rotation.copy(quad.rotation);
				ring.position.copy(pin);
				ring.renderOrder = 25;
				g.add(ring);
			}
			this.helpers.add(g);
			this.cutObj = g;
		}
		this.invalidate();
	}

	/** Center-of-mass marker: a target dot with a plumb line to the bed and the footprint outline. */
	showCenterOfMass(mp) {
		if (this.comObj) { this.helpers.remove(this.comObj); this.comObj.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); this.comObj = null; }
		if (mp) {
			const g = new THREE.Group();
			const col = mp.stable ? 0x46d39a : 0xff6b6b;
			const dot = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), new THREE.MeshBasicMaterial({ color: col, depthTest: false }));
			dot.position.copy(mp.com);
			dot.renderOrder = 23;
			dot.userData.scaleWithView = 1.6;
			g.add(dot);
			const plumb = new THREE.Line(new THREE.BufferGeometry().setFromPoints([mp.com, new THREE.Vector3(mp.com.x, mp.com.y, mp.minZ)]), new THREE.LineDashedMaterial({ color: col, dashSize: 1.5, gapSize: 1, depthTest: false }));
			plumb.computeLineDistances();
			plumb.renderOrder = 23;
			g.add(plumb);
			if (mp.footprint.length >= 2) {
				const pts = mp.footprint.map(([x, y]) => new THREE.Vector3(x, y, mp.minZ + 0.02));
				const fp = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: col, depthTest: false }));
				fp.renderOrder = 23;
				g.add(fp);
			}
			this.helpers.add(g);
			this.comObj = g;
		}
		this.invalidate();
	}

	// Bounding sphere of the bed plus every visible object.
	sceneSphere() {
		const bed = this.app.model.settings.bed;
		const box = new THREE.Box3(new THREE.Vector3(-bed.w / 2, -bed.d / 2, 0), new THREE.Vector3(bed.w / 2, bed.d / 2, 0));
		for (const o of this.pickables(true)) box.expandByObject(o);
		return box.getBoundingSphere(new THREE.Sphere());
	}

	// Near/far planes that follow the zoom level, so close-ups are not clipped.
	updateClipRange() {
		const cam = this.persp;
		const d = cam.position.distanceTo(this.controls.target);
		const near = Math.min(1, Math.max(0.0005, d * 0.002));
		const far = Math.max(near * 2e5, 5000);
		if (Math.abs(cam.near - near) > near * 0.05 || cam.far !== far) {
			cam.near = near;
			cam.far = far;
			cam.updateProjectionMatrix();
		}
	}

	resize() {
		const w = this.container.clientWidth, h = this.container.clientHeight;
		if (!w || !h) return;
		this.cubeSize = w < 520 ? 72 : 100; // smaller view cube on phones
		this.renderer.setSize(w, h);
		this.persp.aspect = w / h;
		this.persp.updateProjectionMatrix();
		this.updateOrtho();
		this.invalidate();
	}

	updateOrtho() {
		const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
		const dist = this.persp.position.distanceTo(this.controls ? this.controls.target : new THREE.Vector3());
		const halfH = dist * Math.tan((this.persp.fov * DEG) / 2);
		this.ortho.left = (-halfH * w) / h;
		this.ortho.right = (halfH * w) / h;
		this.ortho.top = halfH;
		this.ortho.bottom = -halfH;
		this.ortho.updateProjectionMatrix();
	}

	setOrtho(on) {
		const from = this.camera, to = on ? this.ortho : this.persp;
		if (from === to) return;
		if (on) {
			this.persp.position.copy(from.position);
			this.updateOrtho();
			this.ortho.zoom = 1;
			this.ortho.updateProjectionMatrix();
		} else {
			// Convert ortho zoom back to a perspective distance.
			const dir = from.position.clone().sub(this.controls.target);
			dir.multiplyScalar(1 / from.zoom);
			this.persp.position.copy(this.controls.target).add(dir);
		}
		to.position.copy(on ? this.persp.position : this.persp.position);
		to.quaternion.copy(from.quaternion);
		this.camera = to;
		this.controls.object = to;
		this.tc.camera = to;
		if (on) {
			this.persp.remove(this.headLight, this.fillLight);
			this.ortho.add(this.headLight, this.fillLight);
		} else {
			this.ortho.remove(this.headLight, this.fillLight);
			this.persp.add(this.headLight, this.fillLight);
		}
		this.controls.update();
		this.invalidate();
	}

	// ------------------------------------------------------------ bed / grid

	/** Background color of the view (any CSS hex color). */
	setBackground(color) {
		const c = new THREE.Color();
		try { c.set(color || '#141a22'); } catch (e) { c.set('#141a22'); }
		this.bgColor = c.getHex();
		this.container.style.background = '#' + c.getHexString();
		this.invalidate();
	}

	buildBed(settings) {
		this.bed.clear();
		this.setBackground(settings.bgColor);
		// the print bed can be hidden altogether (plate, grid, border, axis marks and build volume)
		if (settings.showBed === false) { this.invalidate(); return; }
		const { w, d, h } = settings.bed;
		const grid = Math.max(0.5, settings.grid || 10);
		const plate = new THREE.Mesh(
			new THREE.PlaneGeometry(w, d),
			new THREE.MeshBasicMaterial({ color: 0x1d2633, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2, side: THREE.DoubleSide, transparent: true, opacity: 0.92 }),
		);
		plate.position.z = -0.02;
		plate.renderOrder = -2;
		this.bed.add(plate);

		const minor = [], major = [];
		const add = (arr, x1, y1, x2, y2) => arr.push(x1, y1, 0, x2, y2, 0);
		const nx = Math.floor(w / 2 / grid), ny = Math.floor(d / 2 / grid);
		for (let i = -nx; i <= nx; i++) add(i % 5 === 0 ? major : minor, i * grid, -d / 2, i * grid, d / 2);
		for (let j = -ny; j <= ny; j++) add(j % 5 === 0 ? major : minor, -w / 2, j * grid, w / 2, j * grid);
		const lines = (arr, color, opacity) => {
			const g = new THREE.BufferGeometry();
			g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
			const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
			l.renderOrder = -1;
			return l;
		};
		this.bed.add(lines(minor, 0x5a7090, 0.28), lines(major, 0x7a95b8, 0.55));
		const border = [-w / 2, -d / 2, 0, w / 2, -d / 2, 0, w / 2, -d / 2, 0, w / 2, d / 2, 0, w / 2, d / 2, 0, -w / 2, d / 2, 0, -w / 2, d / 2, 0, -w / 2, -d / 2, 0];
		this.bed.add(lines(border, 0x9ab8e0, 0.9));
		const axis = (x, y, color) => {
			const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0.01), new THREE.Vector3(x, y, 0.01)]);
			const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color }));
			l.renderOrder = -1;
			return l;
		};
		this.bed.add(axis(Math.min(w / 2, 30), 0, 0xe0504a), axis(0, Math.min(d / 2, 30), 0x4ac060));
		if (settings.showBuildVolume) {
			const box = new THREE.Box3(new THREE.Vector3(-w / 2, -d / 2, 0), new THREE.Vector3(w / 2, d / 2, h));
			const bh = new THREE.Box3Helper(box, 0x4a6080);
			bh.material.transparent = true;
			bh.material.opacity = 0.25;
			this.bed.add(bh);
		}
		this.invalidate();
	}

	applyDisplaySettings(settings) {
		U.uOverhang.value = settings.overhang ? 1 : 0;
		U.uOverhangSin.value = Math.sin((settings.overhangAngle || 45) * DEG);
		const s = settings.section;
		U.uSection.value = s.on ? 1 : 0;
		this.clipPlanes.length = 0;
		if (s.on) {
			// keeps the side behind the plane (the arrow points at what is cut away); Flip keeps the other side
			const n = sectionNormal(s);
			const sign = s.flip ? 1 : -1;
			this.sectionPlane.normal.copy(n).multiplyScalar(sign);
			this.sectionPlane.constant = -sign * (s.offset || 0);
			this.clipPlanes.push(this.sectionPlane);
		}
		if (this.sectionTool) this.sectionTool.update();
		this.invalidate();
	}

	// ------------------------------------------------------------ scene objects

	material(node, top, painted = false) {
		if (node.hole && top) {
			return new THREE.MeshStandardMaterial({
				color: 0x8fa3b8, transparent: true, opacity: 0.32, depthWrite: false, roughness: 0.6,
				clippingPlanes: this.clipPlanes, side: THREE.DoubleSide,
			});
		}
		const see = top && seeThrough(node);
		return patchMaterial(new THREE.MeshStandardMaterial({
			color: painted ? 0xffffff : node.color, vertexColors: painted, roughness: 0.55, metalness: 0.05,
			clippingPlanes: this.clipPlanes,
			side: this.clipPlanes.length ? THREE.DoubleSide : THREE.FrontSide,
			...(see ? { transparent: true, opacity: node.opacity, depthWrite: false } : {}),
		}));
	}

	/** Selected: holes brighten a little; see-through parts keep exactly the opacity on their slider. */
	selectedOpacity(id) {
		const n = this.app.model.get(id);
		return !n || n.hole ? 0.45 : this.baseOpacity(id);
	}

	/** How see-through a top-level part is drawn when it isn't selected. */
	baseOpacity(id) {
		const n = this.app.model.get(id);
		if (!n || n.hole) return 0.32;
		return seeThrough(n) ? n.opacity : 1;
	}

	/** Live opacity change while dragging the slider (the commit afterwards rebuilds the material). */
	previewOpacity(node) {
		const d = this.displays.get(node.id);
		if (!d || !d.userData.top || node.hole || !d.material.color) return;
		const see = seeThrough(node);
		if (d.material.transparent !== see) { d.material.transparent = see; d.material.depthWrite = !see; d.material.needsUpdate = true; }
		d.material.opacity = see ? node.opacity : 1;
		this.invalidate();
	}

	ghostMaterial() {
		return new THREE.MeshStandardMaterial({ color: 0x19b8b4, transparent: true, opacity: 0.45, depthTest: false, depthWrite: false, emissive: 0x0d3533 });
	}

	disposeTree(obj) {
		obj.traverse((o) => {
			if (o.userData.ownGeom) o.geometry.dispose();
			if (o.material) {
				if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
				else o.material.dispose();
			}
		});
	}

	rebuild(model, engine, settings) {
		this.tc.detach();
		for (const c of [...this.root.children]) {
			this.disposeTree(c);
			this.root.remove(c);
		}
		this.objs.clear();
		this.displays.clear();
		this.applyDisplaySettings(settings);
		this.showEdges = settings.showEdges;
		for (const n of model.nodes) this.root.add(this.buildObj(n, engine, true));
		this.applyExplode();
		this.root.updateMatrixWorld(true);
		// the section plane is sized and centered on the parts, so draw it once they are built
		if (this.sectionTool) this.sectionTool.update();
		this.setSelection(this.selection);
		this.invalidate();
	}

	buildObj(node, engine, top) {
		const shape = engine.geometry(node) || new THREE.BufferGeometry();
		if (shape.attributes.position && !shape.boundsTree) shape.computeBoundsTree();
		// painted faces: a colored copy of the shape (top-level solids only; parts inside a group draw as the group)
		const painted = top && !node.hole && shape.attributes.position && effectivePaint(node).length ? paintedGeometry(shape, node) : null;
		if (painted) painted.computeBoundsTree();
		const geom = painted || shape;
		const mesh = new THREE.Mesh(geom, this.material(node, top, !!painted));
		if (painted) mesh.userData.ownGeom = true;
		mesh.userData.nodeId = node.id;
		mesh.renderOrder = node.hole && top ? 2 : 0;
		if (this.showEdges && geom.attributes.position) {
			const sculpted = node.type === 'mesh' && isSculptedBlob({ getBlob: (h) => this.app.model.blobs[h] }, node.params.blob);
			const e = new THREE.LineSegments(edgesFor(shape, sculpted ? SCULPT_CREASE : 28), new THREE.LineBasicMaterial({
				color: node.hole && top ? 0x9ab0c8 : 0x111418, transparent: true, opacity: node.hole && top ? 0.5 : 0.35,
				clippingPlanes: this.clipPlanes,
			}));
			e.raycast = () => {};
			mesh.add(e);
		}
		let obj;
		if (node.type === 'group') {
			obj = new THREE.Group();
			obj.add(mesh);
			for (const c of node.children) obj.add(this.buildObj(c, engine, false));
		} else {
			obj = mesh;
		}
		obj.userData.nodeId = node.id;
		nodeMatrix(node).decompose(obj.position, obj.quaternion, obj.scale);
		mesh.visible = top && node.visible;
		mesh.userData.top = top;
		this.objs.set(node.id, obj);
		this.displays.set(node.id, mesh);
		return obj;
	}

	// ------------------------------------------------------------ selection

	setSelection(ids) {
		// Reset previous highlights
		for (const id of this.selection) {
			const d = this.displays.get(id);
			if (!d) continue;
			if (d.userData.ghost) {
				d.material.dispose();
				d.material = d.userData.origMat;
				d.userData.ghost = false;
				d.visible = false;
				d.renderOrder = 0;
			} else if (d.material.emissive) {
				d.material.emissive.setHex(0x000000);
				if (d.material.transparent) d.material.opacity = this.baseOpacity(id);
			}
		}
		this.selection = ids.filter((id) => this.objs.has(id));
		for (const id of this.selection) {
			const d = this.displays.get(id);
			if (!d.userData.top) {
				d.userData.origMat = d.material;
				d.userData.ghost = true;
				d.material = this.ghostMaterial();
				d.visible = true;
				d.renderOrder = 10;
			} else if (d.material.emissive) {
				d.material.emissive.setHex(0x16365c);
				if (d.material.transparent) d.material.opacity = this.selectedOpacity(id);
			}
		}
		this.attachGizmo();
		this.showSymmetryPlanes();
		this.invalidate();
	}

	/** While one symmetric group is selected, its mirror planes, axis and point are drawn in the view. */
	showSymmetryPlanes() {
		if (this.symHelper) { this.scene.remove(this.symHelper); this.disposeTree(this.symHelper); this.symHelper.traverse((o) => o.geometry && o.geometry.dispose()); this.symHelper = null; }
		const n = this.selection.length === 1 ? this.app.model.get(this.selection[0]) : null;
		if (!n || n.type !== 'group' || n.mode !== 'symmetric') return;
		const obj = this.objs.get(n.id);
		if (!obj) return;
		obj.updateWorldMatrix(true, true);
		const box = new THREE.Box3().setFromObject(this.displays.get(n.id));
		const size = box.isEmpty() ? 20 : box.getSize(new THREE.Vector3()).length();
		this.symHelper = symmetryHelper(n, size);
		this.symHelper.matrixAutoUpdate = false;
		this.symHelper.matrix.copy(obj.matrixWorld);
		this.scene.add(this.symHelper);
	}

	selectedNodes() {
		return this.selection.map((id) => this.app.model.get(id)).filter(Boolean);
	}

	attachGizmo() {
		this.tc.detach();
		const nodes = this.selectedNodes();
		this.invalidate();
		if (this.handles) this.handles.cancelEdit();
		if (this.alignTool && this.alignTool.active) this.alignTool.refresh();
		if (this.filletTool && this.filletTool.active) this.filletTool.refresh();
		if (this.pushPull && this.pushPull.active) this.pushPull.refresh();
		// Rotate and scale use our own handles; the transform gizmo is only used for moving.
		if (this.tool || !nodes.length || this.gizmoMode !== 'translate' || nodes.some((n) => n.locked)) return;
		if (nodes.length === 1) {
			this.tc.attach(this.objs.get(nodes[0].id));
		} else {
			const box = this.selectionBox();
			box.getCenter(this.pivot.position);
			this.pivot.quaternion.identity();
			this.pivot.scale.set(1, 1, 1);
			this.pivot.updateMatrixWorld(true);
			this.tc.attach(this.pivot);
		}
		this.tc.setMode('translate');
		this.tc.setSpace('world');
	}

	setGizmoMode(mode) {
		this.gizmoMode = mode;
		this.attachGizmo();
		this.invalidate();
	}

	setSnap(settings) {
		this.tc.setTranslationSnap(settings.snap > 0 ? settings.snap : null);
		this.tc.setRotationSnap(settings.rotSnap > 0 ? settings.rotSnap * DEG : null);
		this.tc.setScaleSnap(null);
	}

	selectionBox(ids = this.selection) {
		const box = new THREE.Box3();
		for (const id of ids) {
			const d = this.displays.get(id);
			if (!d || !d.geometry.attributes.position) continue;
			d.updateWorldMatrix(true, false);
			box.expandByObject(d, true);
		}
		return box;
	}

	// ------------------------------------------------------------ gizmo handling

	onGizmoStart() {
		this.gizmoStart = {
			pivotInv: this.pivot.matrixWorld.clone().invert(),
			items: this.selection.map((id) => {
				const o = this.objs.get(id);
				o.updateWorldMatrix(true, false);
				return { id, obj: o, world: o.matrixWorld.clone() };
			}),
		};
	}

	onGizmoChange() {
		if (this.tc.object === this.pivot && this.gizmoStart) {
			this.pivot.updateMatrixWorld(true);
			const delta = this.pivot.matrixWorld.clone().multiply(this.gizmoStart.pivotInv);
			for (const it of this.gizmoStart.items) {
				const m = delta.clone().multiply(it.world);
				const parentInv = it.obj.parent.matrixWorld.clone().invert();
				parentInv.multiply(m).decompose(it.obj.position, it.obj.quaternion, it.obj.scale);
			}
		}
		this.invalidate();
	}

	onGizmoEnd() {
		if (!this.gizmoStart) return;
		const updates = this.gizmoStart.items.map(({ id, obj }) => ({ id, ...objTransform(obj) }));
		this.gizmoStart = null;
		this.app.onObjectsTransformed(updates, this.gizmoMode === 'scale');
	}

	// ------------------------------------------------------------ pointer

	ndc(e) {
		const r = this.canvas.getBoundingClientRect();
		return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
	}

	pickables(includeLocked = false) {
		const out = [];
		for (const n of this.app.model.nodes) {
			if (!n.visible || (n.locked && !includeLocked)) continue;
			const d = this.displays.get(n.id);
			if (d && d.geometry.attributes.position) out.push(d);
		}
		return out;
	}

	clipOk(p) {
		return !this.clipPlanes.length || this.sectionPlane.distanceToPoint(p) >= 0;
	}

	raycast(e, objects) {
		this.raycaster.setFromCamera(this.ndc(e), this.camera);
		const hits = this.intersect(objects);
		return hits.find((h) => this.clipOk(h.point)) || null;
	}

	// Ray/mesh intersection that also catches rays passing exactly through a vertex (e.g. the center of a
	// cylinder cap or a sphere pole), which floating-point triangle tests can miss.
	intersect(objects) {
		const rc = this.raycaster;
		let hits = rc.intersectObjects(objects, false);
		const missed = objects.filter((o) => {
			if (hits.some((h) => h.object === o) || !o.geometry.attributes.position) return false;
			if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
			return rc.ray.intersectsBox(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld));
		});
		if (missed.length) {
			const ray = rc.ray.clone();
			const side = new THREE.Vector3(0.6, 0.8, 0.3).cross(ray.direction).normalize();
			const eps = 1e-5 * Math.max(1, ray.origin.length());
			for (const k of [1, -1]) {
				rc.ray.origin.copy(ray.origin).addScaledVector(side, eps * k);
				const extra = rc.intersectObjects(missed.filter((o) => !hits.some((h) => h.object === o)), false);
				hits = hits.concat(extra);
			}
			rc.ray.copy(ray);
			hits.sort((a, b) => a.distance - b.distance);
		}
		return hits;
	}

	groundPoint(e, z = 0) {
		this.raycaster.setFromCamera(this.ndc(e), this.camera);
		const p = new THREE.Vector3();
		const plane = new THREE.Plane(Z_UP, -z);
		return this.raycaster.ray.intersectPlane(plane, p) ? p : null;
	}

	// Surface point under the cursor (objects first, then bed) with world normal.
	surfacePoint(e, exclude = []) {
		const objs = this.pickables(true).filter((d) => !exclude.includes(d.userData.nodeId));
		// in a section view, only what is left after the cut can be hit
		const hit = this.clipPlanes.length ? (this.raycaster.setFromCamera(this.ndc(e), this.camera), this.intersect(objs).find((h) => this.clipOk(h.point))) : this.raycast(e, objs);
		if (hit && hit.face) {
			const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
			if (hit.object.matrixWorld.determinant() < 0) n.negate();
			// Seeing the inside of a part through the cut: what is under the cursor is the cut surface itself, on the
			// section plane — not the far wall behind it.
			if (this.clipPlanes.length && n.dot(this.raycaster.ray.direction) > 0) {
				const P = this.raycaster.ray.intersectPlane(this.sectionPlane, new THREE.Vector3());
				if (P) {
					const cn = this.sectionPlane.normal.clone();
					if (cn.dot(this.raycaster.ray.direction) > 0) cn.negate();
					return { point: P, normal: cn, object: hit.object, cap: true };
				}
			}
			return { point: hit.point, normal: n, object: hit.object, face: hit.face, faceIndex: hit.faceIndex };
		}
		const g = this.groundPoint(e, 0);
		return g ? { point: g, normal: Z_UP.clone(), object: null } : null;
	}

	onPointerDown(e) {
		this.canvas.focus();
		this.downPos = { x: e.clientX, y: e.clientY };
		if (e.button !== 0 || this.tc.dragging) return;
		if (this.app.model.settings.section.on && this.tool !== 'sectionface' && this.sectionTool.pointerDown(e)) return;
		if (this.tool === 'pushpull') { this.pushPull.pointerDown(e); return; }
		if (this.tool) {
			this.toolDown = true;
			return; // handled on click (pointerup without movement)
		}
		if (e.altKey) {
			// Alt+click lists every object under the cursor, including parts inside groups.
			const all = this.hitsAt(e);
			if (all.length) this.app.showObjectPicker(all, { x: e.clientX, y: e.clientY });
			return;
		}
		if (this.handles.pointerDown(e)) return;
		const stack = this.hitsAt(e).filter((h) => h.depth === 0 && !h.node.locked);
		if (stack.length) {
			const additive = e.shiftKey || e.ctrlKey || e.metaKey;
			if (additive) {
				this.app.onPick(stack[0].id, true);
				return;
			}
			// If an already-selected object is anywhere under the cursor, grab it (even if something is in front).
			const already = stack.find((h) => this.selection.includes(h.id));
			if (!already) this.app.onPick(stack[0].id, false);
			this.startDrag(e, (already || stack[0]).point, already ? { stack, from: already.id } : null);
			this.controls.enabled = false;
		} else {
			// Left-drag on empty space draws a selection box; a plain click clears the selection.
			this.startBoxSelect(e, e.shiftKey || e.ctrlKey || e.metaKey);
		}
	}

	hitsAt(e) {
		this.raycaster.setFromCamera(this.ndc(e), this.camera);
		const found = new Map();
		const test = (node, depth, parent) => {
			const d = this.displays.get(node.id);
			if (d && d.geometry.attributes.position) {
				d.updateWorldMatrix(true, false);
				const hit = this.intersect([d]).find((h) => this.clipOk(h.point));
				if (hit && (!found.has(node.id) || hit.distance < found.get(node.id).distance)) {
					found.set(node.id, { id: node.id, node, depth, parent, distance: hit.distance, point: hit.point });
				}
			}
			if (node.children) for (const c of node.children) test(c, depth + 1, node);
		};
		for (const n of this.app.model.nodes) if (n.visible) test(n, 0, null);
		return [...found.values()].sort((a, b) => a.distance - b.distance);
	}

	startDrag(e, point, cycle) {
		const nodes = this.selectedNodes().filter((n) => !n.locked);
		if (!nodes.length) return;
		const wp = this.workplane;
		const plane = wp ? new THREE.Plane().setFromNormalAndCoplanarPoint(wp.normal, point) : new THREE.Plane(Z_UP, -point.z);
		const items = nodes.map((n) => {
			const o = this.objs.get(n.id);
			o.updateWorldMatrix(true, false);
			return { id: n.id, obj: o, start: o.getWorldPosition(new THREE.Vector3()) };
		});
		const start = point.clone();
		let moved = false;
		const snap = this.app.model.settings.snap;
		const ids = items.map((it) => it.id);
		const B0 = this.selectionBox(ids);
		const c0 = B0.isEmpty() ? null : B0.getCenter(new THREE.Vector3()); // the selection's center snaps to grid points
		// Other objects to snap against (edges and centers), only on the bed workplane.
		const others = wp ? [] : this.pickables(true).filter((d) => !ids.includes(d.userData.nodeId))
			.map((d) => ({ id: d.userData.nodeId, box: new THREE.Box3().setFromObject(d, true) }));
		const move = (ev) => {
			if (!moved && Math.hypot(ev.clientX - this.downPos.x, ev.clientY - this.downPos.y) < 4) return;
			moved = true;
			this.canvas.style.cursor = 'grabbing';
			this.raycaster.setFromCamera(this.ndc(ev), this.camera);
			const p = new THREE.Vector3();
			if (!this.raycaster.ray.intersectPlane(plane, p)) return;
			let d = p.sub(start);
			const gs = (v, base) => Math.round((base + v) / snap) * snap - base; // land base + v on the grid
			if (wp) {
				let u = d.dot(wp.x), w = d.dot(wp.y);
				if (snap > 0 && !ev.altKey) {
					const rel = c0 ? c0.clone().sub(wp.origin) : null;
					if (rel) { u = gs(u, rel.dot(wp.x)); w = gs(w, rel.dot(wp.y)); } else { u = gs(u, 0); w = gs(w, 0); }
				}
				d = wp.x.clone().multiplyScalar(u).addScaledVector(wp.y, w);
			} else {
				d.z = 0;
				if (snap > 0 && !ev.altKey) {
					d.x = gs(d.x, c0 ? c0.x : 0);
					d.y = gs(d.y, c0 ? c0.y : 0);
				}
			}
			const guides = !ev.altKey && others.length && !B0.isEmpty() ? this.objectSnap(B0, d, others, p) : [];
			this.drawGuides(guides, B0, d);
			for (const it of items) {
				const w = it.start.clone().add(d);
				it.obj.parent.worldToLocal(w);
				it.obj.position.copy(w);
			}
			this.app.onDragging(d, guides);
			this.invalidate();
		};
		const up = (ev) => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			this.controls.enabled = true;
			this.canvas.style.cursor = '';
			this.drawGuides([]);
			if (moved) { this.app.onObjectsTransformed(items.map(({ id, obj }) => ({ id, ...objTransform(obj) }))); this.lastClick = null; return; }
			// A second click on the same spot cycles through objects stacked under the cursor.
			const lc = this.lastClick;
			this.lastClick = { x: ev.clientX, y: ev.clientY };
			if (cycle && cycle.stack.length > 1 && lc && Math.hypot(lc.x - ev.clientX, lc.y - ev.clientY) < 5) {
				const i = cycle.stack.findIndex((h) => h.id === cycle.from);
				const next = cycle.stack[(i + 1) % cycle.stack.length];
				this.app.onPick(next.id, false);
				this.app.onHint(`Selected “${next.node.name}” (${(i + 1) % cycle.stack.length + 1} of ${cycle.stack.length} here) — click again for the next, or Alt+click for a list`);
			}
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
	}

	// Snap the moving box's edges/center to other objects' edges/centers (X and Y), within ~8 px.
	objectSnap(B0, d, others, p) {
		const tol = this.handles.screenSize(p, 8);
		const guides = [];
		for (const a of ['x', 'y']) {
			const mv = [B0.min[a], (B0.min[a] + B0.max[a]) / 2, B0.max[a]].map((x) => x + d[a]);
			let best = null;
			for (const o of others) {
				for (const ov of [o.box.min[a], (o.box.min[a] + o.box.max[a]) / 2, o.box.max[a]]) {
					for (const m of mv) {
						const diff = ov - m;
						if (Math.abs(diff) < tol && (!best || Math.abs(diff) < Math.abs(best.diff) - 1e-9)) best = { diff, value: ov, other: o };
					}
				}
			}
			if (best) {
				d[a] += best.diff;
				guides.push({ axis: a, value: best.value, box: best.other.box, id: best.other.id });
			}
		}
		return guides;
	}

	drawGuides(guides, B0, d) {
		if (!this.guideLines) {
			this.guideLines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xff4fd8, depthTest: false, transparent: true }));
			this.guideLines.renderOrder = 40;
			this.helpers.add(this.guideLines);
		}
		if (!guides.length) { this.guideLines.visible = false; this.invalidate(); return; }
		const moved = B0.clone().translate(d);
		const pts = [];
		for (const g of guides) {
			const span = moved.clone().union(g.box);
			const o = g.axis === 'x' ? 'y' : 'x';
			for (const z of [span.min.z + 0.05, span.max.z]) {
				const a = new THREE.Vector3(), b = new THREE.Vector3();
				a[g.axis] = b[g.axis] = g.value;
				a[o] = span.min[o] - 3; b[o] = span.max[o] + 3;
				a.z = b.z = z;
				pts.push(a, b);
			}
		}
		this.guideLines.geometry.setFromPoints(pts);
		this.guideLines.visible = true;
		this.invalidate();
	}

	// Workplane: new shapes and drags happen on this plane instead of the bed.
	setWorkplane(point, normal, label) {
		const basis = planeBasis(normal);
		const origin = point.clone();
		const snap = this.app.model.settings.snap;
		if (snap > 0) for (const k of ['x', 'y', 'z']) if (Math.abs(basis.n[k]) < 1e-3) origin[k] = Math.round(origin[k] / snap) * snap;
		this.workplane = { origin, normal: basis.n, x: basis.x, y: basis.y, quat: basis.quat, label };
		if (this.wpGroup) { this.helpers.remove(this.wpGroup); this.wpGroup.traverse((o) => o.geometry && o.geometry.dispose()); }
		const g = (this.wpGroup = new THREE.Group());
		const size = 100, step = Math.max(1, this.app.model.settings.grid || 10);
		const minor = [], major = [];
		for (let i = -size / 2; i <= size / 2 + 1e-6; i += step) {
			const arr = Math.abs(i) < 1e-6 ? major : minor;
			arr.push(i, -size / 2, 0, i, size / 2, 0, -size / 2, i, 0, size / 2, i, 0);
		}
		const mk = (arr, opacity) => {
			const geo = new THREE.BufferGeometry();
			geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
			const l = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xffa94d, transparent: true, opacity, depthWrite: false }));
			l.renderOrder = 3;
			return l;
		};
		g.add(mk(minor, 0.35), mk(major, 0.9));
		g.position.copy(origin).addScaledVector(basis.n, 0.05);
		g.quaternion.copy(basis.quat);
		this.helpers.add(g);
		this.invalidate();
	}

	clearWorkplane() {
		this.workplane = null;
		if (this.wpGroup) { this.helpers.remove(this.wpGroup); this.wpGroup = null; }
		this.invalidate();
	}

	startBoxSelect(e, additive) {
		const r = this.container.getBoundingClientRect();
		const x0 = e.clientX, y0 = e.clientY;
		const box = this.boxEl;
		Object.assign(box.style, { width: '0px', height: '0px' });
		const move = (ev) => {
			if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > 4) box.style.display = 'block';
			const l = Math.min(x0, ev.clientX) - r.left, t = Math.min(y0, ev.clientY) - r.top;
			Object.assign(box.style, { left: l + 'px', top: t + 'px', width: Math.abs(ev.clientX - x0) + 'px', height: Math.abs(ev.clientY - y0) + 'px' });
		};
		const up = (ev) => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			const dragged = box.style.display === 'block';
			box.style.display = 'none';
			if (!dragged) {
				if (!additive) this.app.onPick(null, false);
				return;
			}
			const minX = Math.min(x0, ev.clientX), maxX = Math.max(x0, ev.clientX);
			const minY = Math.min(y0, ev.clientY), maxY = Math.max(y0, ev.clientY);
			const ids = [];
			for (const d of this.pickables()) {
				const b = new THREE.Box3().setFromObject(d, true);
				const c = b.getCenter(new THREE.Vector3()).project(this.camera);
				const sx = r.left + ((c.x + 1) / 2) * r.width, sy = r.top + ((1 - c.y) / 2) * r.height;
				if (sx >= minX && sx <= maxX && sy >= minY && sy <= maxY) ids.push(d.userData.nodeId);
			}
			this.app.onBoxSelect(ids, additive);
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
	}

	onHover(e) {
		const p = this.groundPoint(e, 0);
		if (p) this.app.onCursor(p);
		if (e.buttons) {
			return;
		}
		if (this.toolDown) {
			this.toolDown = false;
		}
		if (this.app.model.settings.section.on && this.tool !== 'sectionface') {
			const c = this.sectionTool.hoverAt(e);
			if (c) { this.canvas.style.cursor = c; return; }
		}
		if (this.tool === 'pushpull') {
			this.canvas.style.cursor = this.pushPull.hoverAt(e) || '';
			return;
		}
		if (this.tool === 'fillet') {
			const c = this.filletTool.hoverAt(e);
			this.canvas.style.cursor = c || '';
			return;
		}
		if (this.tool === 'align') {
			const c = this.alignTool.hover(e);
			this.canvas.style.cursor = c || (this.raycast(e, this.pickables()) ? 'pointer' : '');
			return;
		}
		if (this.tool) {
			this.canvas.style.cursor = 'crosshair';
			if (this.tool === 'measure') this.measureHover(e);
			if (this.tool === 'holewiz') this.app.holeHover(e);
			return;
		}
		const hc = this.handles.hover(e);
		if (hc) { this.canvas.style.cursor = hc; return; }
		const hit = this.raycast(e, this.pickables());
		this.canvas.style.cursor = hit && !this.tc.axis ? 'pointer' : '';
	}

	onClickTool(e) {
		if (this.tool === 'measure') this.measureClick(e);
		else if (this.tool === 'align') this.alignTool.click(e);
		else if (this.tool === 'fillet') this.filletTool.click(e);
		else if (this.tool === 'workplane') this.app.onPickWorkplane(this.surfacePoint(e));
		else if (this.tool === 'mate') this.app.onMateClick(this.surfacePoint(e));
		else if (this.tool === 'holewiz') this.app.holeClick(e);
		else if (this.tool === 'feapick') this.app.onFeaClick(e);
		else if (this.tool === 'sketchface') this.app.onSketchFace(this.surfacePoint(e));
		else if (this.tool === 'sectionface') this.app.onSectionFace(this.surfacePoint(e));
		else if (this.tool === 'paint') this.app.onPaintClick(e);
		else if (this.tool === 'sympoint') this.app.onSymClick(this.surfacePoint(e));
		else if (this.tool === 'place') {
			const sp = this.surfacePoint(e, this.selection);
			if (sp) this.app.onPlaceOnSurface(e.altKey ? sp.point : this.snapInPlane(sp.point.clone(), sp.normal), sp.normal);
		}
	}

	onDblClick(e) {
		if (this.tool) return;
		// a shape made from a sketch (also inside a group, also a pocket): go back into its sketch
		const sketch = this.app.sketchAt(e);
		if (sketch) { this.app.setSelection([sketch.id]); this.app.editSketch(sketch); return; }
		const hit = this.raycast(e, this.pickables());
		if (!hit) {
			this.app.frame();
			return;
		}
		const node = this.app.model.get(hit.object.userData.nodeId);
		if (!node || node.type !== 'group') return;
		// Select the direct child of the group under the cursor.
		let best = null;
		for (const c of node.children) {
			const obj = this.objs.get(c.id);
			const meshes = [];
			obj.traverse((o) => { if (o.isMesh && o.geometry.attributes.position) meshes.push(o); });
			this.raycaster.setFromCamera(this.ndc(e), this.camera);
			for (const m of meshes) {
				const wasVis = m.visible;
				const hits = this.raycaster.intersectObject(m, false);
				m.visible = wasVis;
				if (hits.length && (!best || hits[0].distance < best.d)) best = { d: hits[0].distance, id: c.id };
			}
		}
		if (best) this.app.onPick(best.id, false, true);
	}

	// ------------------------------------------------------------ tools

	setTool(tool) {
		this.tool = tool;
		this.clearMeasure();
		this.alignTool.setActive(tool === 'align');
		this.filletTool.setActive(tool === 'fillet');
		this.pushPull.setActive(tool === 'pushpull');
		this.attachGizmo();
		this.canvas.style.cursor = tool && tool !== 'align' && tool !== 'fillet' && tool !== 'pushpull' ? 'crosshair' : '';
		if (tool) {
			const click = (e) => {
				if (!this.tool) return;
				if (e.button !== 0) return;
				if (Math.hypot(e.clientX - this.downPos.x, e.clientY - this.downPos.y) > 4) return;
				this.onClickTool(e);
			};
			this._toolClick && this.canvas.removeEventListener('pointerup', this._toolClick);
			this._toolClick = click;
			this.canvas.addEventListener('pointerup', click);
		} else if (this._toolClick) {
			this.canvas.removeEventListener('pointerup', this._toolClick);
			this._toolClick = null;
		}
		this.invalidate();
	}

	/** Snap a point lying on a plane with normal n to the grid within that plane (world grid for axis-aligned planes). */
	snapInPlane(p, n) {
		const snap = this.app.model.settings.snap;
		if (!(snap > 0)) return p;
		const r = (v) => Math.round(v / snap) * snap;
		const nn = n.clone().normalize();
		if (['x', 'y', 'z'].some((k) => Math.abs(Math.abs(nn[k]) - 1) < 1e-6)) {
			for (const k of ['x', 'y', 'z']) if (Math.abs(nn[k]) < 1e-3) p[k] = r(p[k]);
			return p;
		}
		const { x, y } = planeBasis(nn);
		const a = p.dot(x), b = p.dot(y);
		return p.addScaledVector(x, r(a) - a).addScaledVector(y, r(b) - b);
	}

	snapPoint(e) {
		this.lastSnapVertex = false;
		const sp = this.surfacePoint(e);
		if (!sp) return null;
		if (sp.cap && !e.altKey) return this.capSnap(e, sp);
		let p = sp.point.clone();
		if (sp.object && sp.face && !e.altKey) {
			// Snap to the nearest triangle corner if close on screen.
			const r = this.canvas.getBoundingClientRect();
			const pos = sp.object.geometry.attributes.position;
			let best = null;
			// the hit triangle's corners, plus any corner of the object near the hit point (the cursor can sit in the
			// neighboring triangle of a corner)
			const cand = [sp.face.a, sp.face.b, sp.face.c];
			if (pos.count < 300000) {
				const inv = sp.object.matrixWorld.clone().invert(), lp = sp.point.clone().applyMatrix4(inv);
				const rw = this.handles.screenSize(sp.point, 12) / Math.max(1e-9, sp.object.matrixWorld.getMaxScaleOnAxis()), r2 = rw * rw;
				const a2 = pos.array;
				for (let i = 0, k = 0; i < pos.count; i++, k += 3) { const dx = a2[k] - lp.x, dy = a2[k + 1] - lp.y, dz = a2[k + 2] - lp.z; if (dx * dx + dy * dy + dz * dz < r2) cand.push(i); }
			}
			for (const idx of cand) {
				const v = new THREE.Vector3().fromBufferAttribute(pos, idx).applyMatrix4(sp.object.matrixWorld);
				const s = v.clone().project(this.camera);
				const dx = ((s.x + 1) / 2) * r.width - (e.clientX - r.left), dy = ((1 - s.y) / 2) * r.height - (e.clientY - r.top);
				const d = Math.hypot(dx, dy);
				if (d < 12 && (!best || d < best.d)) best = { d, v };
			}
			// in a section view, the corners of the cut snap from the faces next to it too
			if (this.clipPlanes.length) {
				for (const P of capOutline(sp.object, this.sectionPlane).corners) {
					const s = P.clone().project(this.camera);
					const d = Math.hypot(((s.x + 1) / 2) * r.width - (e.clientX - r.left), ((1 - s.y) / 2) * r.height - (e.clientY - r.top));
					if (d < 12 && (!best || d < best.d)) best = { d, v: P.clone() };
				}
			}
			if (best) p = best.v;
			this.lastSnapVertex = !!best;
		} else if (!sp.object) {
			const snap = this.app.model.settings.snap;
			if (snap > 0 && !e.altKey) {
				p.x = Math.round(p.x / snap) * snap;
				p.y = Math.round(p.y / snap) * snap;
			}
		}
		return p;
	}

	/** The outline of the cut surface on a part (for measuring and tests). */
	capOutlineOf(mesh) { return capOutline(mesh, this.sectionPlane); }

	/** On the cut surface: snap to a corner of the cut outline (12 px), else onto an outline edge (8 px). */
	capSnap(e, sp) {
		const { segs, corners } = capOutline(sp.object, this.sectionPlane);
		const r = this.canvas.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
		let best = null;
		for (const P of corners) {
			const s = this.project(P), d = Math.hypot(s.x - mx, s.y - my);
			if (!s.behind && d < 12 && (!best || d < best.d)) best = { d, P };
		}
		if (best) { this.lastSnapVertex = true; return best.P.clone(); }
		let edge = null;
		for (const [A, B] of segs) {
			const a = this.project(A), b = this.project(B);
			if (a.behind || b.behind) continue;
			const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy || 1e-9;
			const t = Math.max(0, Math.min(1, ((mx - a.x) * dx + (my - a.y) * dy) / L));
			const d = Math.hypot(a.x + dx * t - mx, a.y + dy * t - my);
			if (d < 8 && (!edge || d < edge.d)) edge = { d, P: A.clone().lerp(B, t) };
		}
		if (edge) { this.lastSnapVertex = true; return edge.P; }
		return sp.point.clone();
	}

	/** A circle or arc in the cut outline near the cursor (a hole or rounded corner cut through), like roundFeatureAt. */
	capRound(sp) {
		const { simple: loops } = capOutline(sp.object, this.sectionPlane);
		if (!loops.length) return null;
		const n = sp.normal.clone().normalize(), basis = planeBasis(n), o = loops[0][0];
		const to2 = (P) => { const d = P.clone().sub(o); return [d.dot(basis.x), d.dot(basis.y)]; };
		const h = to2(sp.point);
		let best = null;
		for (const lp3 of loops) {
			const lp = lp3.map(to2);
			for (let i = 0; i < lp.length; i++) {
				const a = lp[i], b = lp[(i + 1) % lp.length], dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy || 1e-12;
				const t = Math.max(0, Math.min(1, ((h[0] - a[0]) * dx + (h[1] - a[1]) * dy) / L));
				const d = Math.hypot(a[0] + t * dx - h[0], a[1] + t * dy - h[1]);
				if (!best || d < best.d) best = { d, lp, i: t < 0.5 ? i : (i + 1) % lp.length };
			}
		}
		const arc = best && arcAround(best.lp, best.i);
		if (!arc) return null;
		const center = o.clone().addScaledVector(basis.x, arc.cx).addScaledVector(basis.y, arc.cy);
		const res = { kind: arc.full ? 'circle' : 'arc', center, normal: n, r: arc.r, loopDist: best.d };
		if (!arc.full) {
			res.start = o.clone().addScaledVector(basis.x, best.lp[arc.from][0]).addScaledVector(basis.y, best.lp[arc.from][1]);
			res.sweep = arc.sweep;
			res.basis = basis;
		}
		return res;
	}

	clearMeasure() {
		const m = this.measure;
		m.pts = [];
		m.lastRound = null;
		this.setRoundOverlay('pin', null);
		this.setRoundOverlay('hover', null);
		if (m.line) { this.helpers.remove(m.line); m.line.geometry.dispose(); m.line = null; }
		for (const k of m.markers) this.helpers.remove(k);
		m.markers = [];
		m.ents = [];
		this.setMeasureLegs([]);
		this.setFaceOutline('pick', null);
		this.setFaceOutline('hover2', null);
		this.setFaceOutline('caphover', null);
		m.capLoops = null;
		m.label.style.display = 'none';
		this.invalidate();
	}

	// ------------------------------------------------------------ measure: points, faces and the legs between them

	/**
	 * What a measure click picks: { kind: 'point', p } (corner, circle center, bed grid, curved wall) or
	 * { kind: 'face', p (clicked point), n, c (face center), loops } for a flat face. With full = false (hovering)
	 * the face's outline and center are left out.
	 */
	measureEntity(e, full = true) {
		const f = e.altKey ? null : this.measureFeature(e);
		if (f && f.mode === 'center') return { kind: 'point', p: f.center.clone() };
		const sp = this.surfacePoint(e);
		const p = this.snapPoint(e);
		if (!sp || !p) return null;
		if (sp.cap && !e.altKey && !this.lastSnapVertex) {
			// the cut surface: a flat face on the section plane, outlined while you measure
			const { loops } = capOutline(sp.object, this.sectionPlane);
			return { kind: 'face', p: sp.point.clone(), n: sp.normal.clone(), c: sp.point.clone(), object: sp.object, cap: true, loops };
		}
		if (e.altKey || !sp.object || !sp.face || this.lastSnapVertex) return { kind: 'point', p };
		if (f && (f.kind === 'cylinder' || f.kind === 'sphere')) return { kind: 'point', p };
		const n = sp.face.normal.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(sp.object.matrixWorld)).normalize();
		const ent = { kind: 'face', p: sp.point.clone(), n, c: sp.point.clone(), object: sp.object, faceIndex: sp.faceIndex };
		if (!full) return ent;
		const reg = faceRegion(sp.object, sp.faceIndex);
		if (!reg || reg.curved) return { kind: 'point', p };
		// area-weighted center of the face
		const t = reg.tris, c = new THREE.Vector3(), A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
		let area = 0;
		for (let i = 0; i < t.length; i += 9) {
			A.set(t[i], t[i + 1], t[i + 2]); B.set(t[i + 3], t[i + 4], t[i + 5]); C.set(t[i + 6], t[i + 7], t[i + 8]);
			const a = B.clone().sub(A).cross(C.clone().sub(A)).length() / 2;
			c.addScaledVector(A.clone().add(B).add(C), a / 3);
			area += a;
		}
		if (area > 0) ent.c = c.multiplyScalar(1 / area);
		ent.loops = reg.loops.map((lp) => lp.map(([x, y]) => reg.origin.clone().addScaledVector(reg.basis.x, x).addScaledVector(reg.basis.y, y)));
		ent.area = area;
		return ent;
	}

	/**
	 * The measurement between two picks. Face to point or to a parallel face: the perpendicular gap and the sideways
	 * offset (face center to face center / point). Faces at an angle: the angle. Points: the X / Y / Z legs.
	 */
	measureResult(A, B) {
		const pa = A.kind === 'face' ? A.c : A.p, pb = B.kind === 'face' ? B.c : B.p;
		const F = A.kind === 'face' ? A : B.kind === 'face' ? B : null;
		const d = pb.clone().sub(pa);
		const xyz = `ΔX ${fmt(d.x, 3)} · ΔY ${fmt(d.y, 3)} · ΔZ ${fmt(d.z, 3)}`;
		const axisLegs = (a, b) => {
			const out = [], cur = a.clone();
			[['x', 0xff5a5a, 'X'], ['y', 0x5ad15a, 'Y'], ['z', 0x5a9bff, 'Z']].forEach(([k, color, name]) => {
				const step = b[k] - a[k];
				if (Math.abs(step) < 1e-6) return;
				const next = cur.clone(); next[k] = b[k];
				out.push({ a: cur.clone(), b: next, color, text: `${name} ${fmt(Math.abs(step), 3)}` });
				cur.copy(next);
			});
			return out;
		};
		const sameFace = A.kind === 'face' && B.kind === 'face' && A.object === B.object && Math.abs(A.n.dot(B.n)) > 0.99999 && Math.abs(B.p.clone().sub(A.p).dot(A.n)) < 1e-4;
		if (!F || sameFace) {
			// two points (or two clicks on one face): straight distance and its X / Y / Z legs
			const a = A.p, b = B.p, v = b.clone().sub(a);
			return { a, b, main: `${fmt(v.length(), 3)} mm`, sub: `ΔX ${fmt(v.x, 3)} · ΔY ${fmt(v.y, 3)} · ΔZ ${fmt(v.z, 3)}`, legs: axisLegs(a, b), d: v };
		}
		if (A.kind === 'face' && B.kind === 'face' && Math.abs(A.n.dot(B.n)) < Math.cos((0.5 * Math.PI) / 180)) {
			const ang = (Math.acos(Math.min(1, Math.abs(A.n.dot(B.n)))) * 180) / Math.PI;
			return { a: pa, b: pb, main: `∠ ${fmt(ang, 2)}°`, sub: `faces at an angle · centers ${fmt(d.length(), 3)} mm apart · ${xyz}`, legs: axisLegs(pa, pb), d, angle: ang };
		}
		const n = F.n.clone().normalize();
		const perp = d.dot(n), foot = pa.clone().addScaledVector(n, perp), lat = pb.clone().sub(foot);
		const legs = [];
		if (Math.abs(perp) > 1e-6) legs.push({ a: pa.clone(), b: foot, color: 0xffcc33, text: `⊥ ${fmt(Math.abs(perp), 3)}` });
		if (lat.length() > 1e-6) legs.push({ a: foot.clone(), b: pb.clone(), color: 0x4fd1ff, text: `offset ${fmt(lat.length(), 3)}` });
		const what = A.kind === 'face' && B.kind === 'face' ? 'parallel faces' : 'face to point';
		return { a: pa, b: pb, main: `⊥ ${fmt(Math.abs(perp), 3)} mm`, sub: `${what} · offset ${fmt(lat.length(), 3)} · direct ${fmt(d.length(), 3)}<br>${xyz}`, legs, d, perp: Math.abs(perp), offset: lat.length() };
	}

	/** Colored dimension lines (with small labels) for the parts of a measurement. */
	setMeasureLegs(legs) {
		const m = this.measure;
		for (const l of m.legs || []) { this.helpers.remove(l.line); l.line.geometry.dispose(); l.label.remove(); }
		m.legs = legs.map((g) => {
			const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([g.a, g.b]), new THREE.LineDashedMaterial({ color: g.color, depthTest: false, dashSize: 1, gapSize: 0.6 }));
			line.computeLineDistances();
			line.renderOrder = 21;
			this.helpers.add(line);
			const label = makeLabel('measure leg');
			label.style.borderColor = '#' + g.color.toString(16).padStart(6, '0');
			label.textContent = g.text;
			this.overlay.appendChild(label);
			return { line, label, mid: g.a.clone().add(g.b).multiplyScalar(0.5) };
		});
		this.invalidate();
	}

	/** Outline of a picked face ('pick') or the face under the cursor while choosing the second one. */
	setFaceOutline(which, ent) {
		const m = this.measure, key = which + 'Face';
		if (m[key]) { this.helpers.remove(m[key]); m[key].traverse((o) => { if (o.geometry) o.geometry.dispose(); }); m[key] = null; }
		if (!ent || !ent.loops) { this.invalidate(); return; }
		const g = new THREE.Group();
		const mat = new THREE.LineBasicMaterial({ color: which === 'pick' ? 0xffcc33 : 0x4fd1ff, depthTest: false, transparent: true, opacity: 0.9 });
		for (const lp of ent.loops) { const l = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(lp), mat); l.renderOrder = 21; g.add(l); }
		this.helpers.add(g);
		m[key] = g;
		this.invalidate();
	}

	measureMarker(p) {
		const s = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffcc33, depthTest: false }));
		s.renderOrder = 20;
		s.position.copy(p);
		s.userData.scaleWithView = true;
		this.helpers.add(s);
		this.measure.markers.push(s);
	}

	// ------------------------------------------------------------ measure: circles, arcs, cylinders, spheres

	/** Round feature under the cursor with how it is being pointed at: mode 'edge' (on the rim / curved wall) or 'center'. */
	measureFeature(e) {
		const r = this.canvas.getBoundingClientRect();
		const nearCenter = (g) => { const c = this.project(g.center); return !c.behind && Math.hypot(c.x - (e.clientX - r.left), c.y - (e.clientY - r.top)) < 14; };
		// The center of a hole has no surface under it, so the last round feature seen stays snappable.
		const last = this.measure.lastRound;
		const sticky = () => (last && nearCenter(last) ? { ...last, mode: 'center' } : null);
		const sp = this.surfacePoint(e);
		if (!sp || !sp.object) return sticky();
		const f = sp.cap ? this.capRound(sp) : roundFeatureAt(sp.object, sp.faceIndex, sp.point);
		if (!f) return sticky();
		if (f.kind === 'sphere') f.normal = this.camera.getWorldDirection(new THREE.Vector3()).negate(); // outline = silhouette
		// circles and arcs remember themselves for center snapping; a cylinder's axis has no single center point
		if (f.kind === 'circle' || f.kind === 'arc') this.measure.lastRound = f;
		if (f.kind !== 'cylinder' && nearCenter(f)) f.mode = 'center';
		else if (f.kind === 'cylinder' && sticky()) return sticky();
		else if (f.kind === 'cylinder' || f.kind === 'sphere') f.mode = 'edge';
		else if (f.loopDist < this.handles.screenSize(sp.point, 9)) f.mode = 'edge';
		else return sticky();
		return f;
	}

	/** Diameter direction for a round feature: across the screen, within the feature's plane. */
	roundAxes(f) {
		const n = f.normal.clone().normalize();
		const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
		let u = right.clone().projectOnPlane(n);
		if (u.length() < 0.2) u = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1).projectOnPlane(n);
		u.normalize();
		return { n, u, v: n.clone().cross(u) };
	}

	roundText(f) {
		const what = { circle: 'Circle', arc: 'Arc', cylinder: 'Cylinder', sphere: 'Sphere' }[f.kind];
		const sweep = f.kind === 'arc' ? ` · ${fmt(Math.abs(f.sweep) / DEG, 1)}°` : '';
		const c = f.center;
		return {
			html: f.kind === 'arc' ? `<b>R ${fmt(f.r, 3)} mm</b><span>${what} · Ø ${fmt(2 * f.r, 3)}${sweep}</span>` : `<b>Ø ${fmt(2 * f.r, 3)} mm</b><span>${what} · R ${fmt(f.r, 3)}</span>`,
			hint: `${what}: Ø ${fmt(2 * f.r, 3)} mm  ·  R ${fmt(f.r, 3)} mm${sweep}  ·  center X ${fmt(c.x, 3)}  Y ${fmt(c.y, 3)}  Z ${fmt(c.z, 3)}`,
		};
	}

	/** Draw (or clear) a round-feature overlay: outline, diameter (or radius for arcs) and center. */
	setRoundOverlay(which, f, opts = {}) {
		const m = this.measure;
		const old = m[which + 'Obj'];
		if (old) { this.helpers.remove(old); old.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); m[which + 'Obj'] = null; }
		const label = which === 'pin' ? m.clabel : m.hlabel;
		m[which] = f;
		if (!f) { label.style.display = 'none'; this.invalidate(); return; }
		const color = which === 'pin' ? 0xffcc33 : 0x4fd1ff;
		const mat = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: which === 'pin' ? 1 : 0.9 });
		const faint = new THREE.LineDashedMaterial({ color, depthTest: false, transparent: true, opacity: 0.55, dashSize: f.r * 0.08, gapSize: f.r * 0.06 });
		const g = new THREE.Group();
		g.renderOrder = 21;
		const { n, u, v } = this.roundAxes(f);
		const at = (t, r = f.r) => f.center.clone().addScaledVector(u, Math.cos(t) * r).addScaledVector(v, Math.sin(t) * r);
		const line = (pts, material) => { const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), material); l.renderOrder = 21; if (material.isLineDashedMaterial) l.computeLineDistances(); g.add(l); return l; };
		const circle = Array.from({ length: 129 }, (_, i) => at((i / 128) * Math.PI * 2));
		let a, b;
		if (f.kind === 'arc') {
			line(circle, faint);
			// the arc itself, from its start point through its sweep (in the face's plane)
			const s0 = f.start.clone().sub(f.center).normalize(), s1 = n.clone().cross(s0);
			const pts = Array.from({ length: 65 }, (_, i) => { const t = (i / 64) * f.sweep; return f.center.clone().addScaledVector(s0, Math.cos(t) * f.r).addScaledVector(s1, Math.sin(t) * f.r); });
			line(pts, mat);
			a = f.center.clone(); b = pts[32];
		} else {
			line(circle, mat);
			a = at(Math.PI); b = at(0);
		}
		if (which === 'pin' || f.mode === 'edge') line([a, b], mat);
		g.add(this.dotMarker(f.center, color));
		if (which === 'pin' || f.mode === 'edge') { g.add(this.dotMarker(a, color)); g.add(this.dotMarker(b, color)); }
		this.helpers.add(g);
		m[which + 'Obj'] = g;
		const t = this.roundText(f);
		label.innerHTML = f.mode === 'center' && which === 'hover' ? '<b>Center</b><span>click to measure from here</span>' : t.html;
		label.style.display = 'block';
		m[which + 'Mid'] = f.mode === 'center' && which === 'hover' ? f.center.clone() : a.clone().add(b).multiplyScalar(0.5);
		if (opts.hint !== false) this.app.onHint(t.hint + (which === 'pin' ? '   — click to measure again' : f.mode === 'edge' ? '   — click to pin' : ''));
		this.invalidate();
	}

	dotMarker(p, color) {
		const s = new THREE.Mesh(new THREE.SphereGeometry(0.7, 10, 6), new THREE.MeshBasicMaterial({ color, depthTest: false }));
		s.renderOrder = 22;
		s.position.copy(p);
		s.userData.scaleWithView = true;
		return s;
	}

	measureHover(e) {
		const m = this.measure;
		const f = e.altKey ? null : this.measureFeature(e);
		if (m.ents && m.ents.length === 1) {
			// second pick: centers of round features snap; flat faces measure face to face
			const cf = f && f.mode === 'center' ? f : null;
			this.setRoundOverlay('hover', cf, { hint: false });
			const ent = this.measureEntity(e, false);
			if (ent) this.drawMeasure(m.ents[0], ent, false);
			return;
		}
		this.setRoundOverlay('hover', f);
		const capEnt = !e.altKey && this.clipPlanes.length ? this.measureEntity(e, false) : null;
		const capLoops = capEnt && capEnt.cap ? capEnt.loops : null;
		if (capLoops !== this.measure.capLoops) { this.measure.capLoops = capLoops; this.setFaceOutline('caphover', capLoops ? capEnt : null); }
		if (capEnt && capEnt.cap && !f) this.app.onHint('Cut surface: click to measure from it — corners and edges of the cut snap; holes cut through show their diameter. Alt = free point.');
		if (!f && !e.altKey && !(capEnt && capEnt.cap)) {
			const ent = this.measureEntity(e, false);
			if (ent && ent.kind === 'face') this.app.onHint('Face: click to measure from it (gap ⊥ and sideways offset to the next face or point). Corners and circle centers snap; Alt = free point.');
		}
	}

	measureClick(e) {
		const m = this.measure;
		if (!m.ents) m.ents = [];
		const f = e.altKey ? null : this.measureFeature(e);
		if (m.ents.length !== 1 && f && f.mode === 'edge') {
			// clicking a rim / curved wall pins its diameter (the maximum distance across)
			this.clearMeasure();
			this.setRoundOverlay('pin', f);
			return;
		}
		const ent = this.measureEntity(e, true);
		if (!ent) return;
		if (m.ents.length >= 2 || m.pin) this.clearMeasure();
		this.setRoundOverlay('hover', null);
		m.ents.push(ent);
		m.pts.push(ent.kind === 'face' ? ent.p.clone() : ent.p.clone());
		this.measureMarker(ent.p);
		if (ent.kind === 'face') this.setFaceOutline(m.ents.length === 1 ? 'pick' : 'hover2', ent);
		if (m.ents.length === 2) this.drawMeasure(m.ents[0], m.ents[1], true);
		this.invalidate();
	}

	measurePreview(e) {
		const m = this.measure;
		if (!m.ents || m.ents.length !== 1) return;
		const ent = this.measureEntity(e, false);
		if (ent) this.drawMeasure(m.ents[0], ent, false);
	}

	/** Draw the measurement between two picks (points as plain vectors also work). */
	drawMeasure(A, B, final) {
		const m = this.measure;
		if (A.isVector3) A = { kind: 'point', p: A };
		if (B.isVector3) B = { kind: 'point', p: B };
		const r = this.measureResult(A, B);
		if (!m.line) {
			m.line = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffcc33, depthTest: false, transparent: true, opacity: 0.55 }));
			m.line.renderOrder = 20;
			this.helpers.add(m.line);
		}
		m.line.geometry.setFromPoints([r.a, r.b]);
		m.line.geometry.computeBoundingSphere();
		m.label.innerHTML = `<b>${r.main}</b><span>${r.sub}</span>`;
		m.label.style.marginTop = r.legs.length ? '-52px' : ''; // keep clear of the leg labels
		m.label.style.display = 'block';
		m.mid = r.a.clone().add(r.b).multiplyScalar(0.5);
		m.final = final;
		m.result = r;
		this.setMeasureLegs(r.legs);
		if (final && m.pts.length === 2) { m.pts[0] = r.a.clone(); m.pts[1] = r.b.clone(); }
		this.app.onMeasure(r.d, final, r);
		this.invalidate();
	}

	// ------------------------------------------------------------ camera

	animateTo(pos, target, up) {
		const c = this.camera, ctl = this.controls;
		const p0 = c.position.clone(), t0 = ctl.target.clone();
		const start = performance.now(), dur = 280;
		const step = () => {
			const k = Math.min(1, (performance.now() - start) / dur);
			const s = k * k * (3 - 2 * k);
			c.position.lerpVectors(p0, pos, s);
			ctl.target.lerpVectors(t0, target, s);
			ctl.update();
			this.invalidate();
			if (k < 1) requestAnimationFrame(step);
			else if (this.camera.isOrthographicCamera) this.updateOrtho();
		};
		step();
	}

	viewDir(name) {
		return {
			top: [0, -0.0001, 1], bottom: [0, 0.0001, -1], front: [0, -1, 0], back: [0, 1, 0],
			left: [-1, 0, 0], right: [1, 0, 0], iso: [0.75, -1, 0.8],
		}[name];
	}

	setView(name) {
		const dir = new THREE.Vector3(...this.viewDir(name)).normalize();
		const dist = this.camera.position.distanceTo(this.controls.target);
		this.animateTo(this.controls.target.clone().addScaledVector(dir, dist), this.controls.target.clone());
	}

	viewFromDirection(dir) {
		const d = dir.clone().normalize();
		if (Math.abs(d.z) > 0.999) d.y = -0.0001 * Math.sign(d.z || 1);
		const dist = this.camera.position.distanceTo(this.controls.target);
		this.animateTo(this.controls.target.clone().addScaledVector(d.normalize(), dist), this.controls.target.clone());
	}

	frameBox(box) {
		if (box.isEmpty()) {
			const { w, d } = this.app.model.settings.bed;
			box = new THREE.Box3(new THREE.Vector3(-w / 2, -d / 2, 0), new THREE.Vector3(w / 2, d / 2, 20));
		}
		const sphere = box.getBoundingSphere(new THREE.Sphere());
		const r = Math.max(sphere.radius, 5);
		const dir = this.camera.position.clone().sub(this.controls.target).normalize();
		const dist = r / Math.sin((this.persp.fov * DEG) / 2) * 1.15;
		if (this.camera.isOrthographicCamera) {
			this.camera.zoom = 1;
			this.camera.updateProjectionMatrix();
		}
		this.animateTo(sphere.center.clone().addScaledVector(dir, dist), sphere.center.clone());
	}

	// ------------------------------------------------------------ view cube

	initViewCube() {
		const scene = (this.cubeScene = new THREE.Scene());
		this.cubeCam = new THREE.OrthographicCamera(-0.95, 0.95, 0.95, -0.95, 0.1, 10);
		this.cubeCam.up.copy(Z_UP);
		const faces = [
			['TOP', [0, 0, 1], [1, 0, 0], [0, 1, 0]],
			['BOTTOM', [0, 0, -1], [1, 0, 0], [0, -1, 0]],
			['FRONT', [0, -1, 0], [1, 0, 0], [0, 0, 1]],
			['BACK', [0, 1, 0], [-1, 0, 0], [0, 0, 1]],
			['RIGHT', [1, 0, 0], [0, 1, 0], [0, 0, 1]],
			['LEFT', [-1, 0, 0], [0, -1, 0], [0, 0, 1]],
		];
		this.cubeFaces = [];
		for (const [label, n, r, u] of faces) {
			const cv = document.createElement('canvas');
			cv.width = cv.height = 128;
			const g = cv.getContext('2d');
			g.fillStyle = '#2b3646';
			g.fillRect(0, 0, 128, 128);
			g.strokeStyle = '#6d86a6';
			g.lineWidth = 6;
			g.strokeRect(3, 3, 122, 122);
			g.fillStyle = '#dfe8f5';
			g.font = 'bold ' + (label.length > 5 ? 22 : 26) + 'px system-ui, sans-serif';
			g.textAlign = 'center';
			g.textBaseline = 'middle';
			g.fillText(label, 64, 66);
			const tex = new THREE.CanvasTexture(cv);
			tex.colorSpace = THREE.SRGBColorSpace;
			const mat = new THREE.MeshBasicMaterial({ map: tex });
			const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
			const R = new THREE.Vector3(...r), Uv = new THREE.Vector3(...u), N = new THREE.Vector3(...n);
			plane.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(R, Uv, N));
			plane.position.copy(N).multiplyScalar(0.5);
			plane.userData.dir = N;
			plane.userData.mat = mat;
			scene.add(plane);
			this.cubeFaces.push(plane);
		}
		const axes = new THREE.AxesHelper(0.95);
		axes.position.set(-0.5, -0.5, -0.5);
		scene.add(axes);
		this.cubeSize = this.container.clientWidth < 520 ? 72 : 100;
		this.canvas.addEventListener('pointerdown', (e) => {
			const hit = this.cubeHit(e);
			if (hit) {
				e.stopImmediatePropagation();
				this.viewFromDirection(hit.userData.dir);
			}
		}, true);
		this.canvas.addEventListener('pointermove', (e) => {
			const hit = this.cubeHit(e);
			for (const f of this.cubeFaces) f.userData.mat.color.setHex(f === hit ? 0x8fc1ff : 0xffffff);
			if (hit) this.canvas.style.cursor = 'pointer';
			this.invalidate();
		});
	}

	cubeHit(e) {
		const r = this.canvas.getBoundingClientRect();
		const s = this.cubeSize, x = e.clientX - r.left - (r.width - s - 8), y = e.clientY - r.top - 8;
		if (x < 0 || y < 0 || x > s || y > s) return null;
		const nd = new THREE.Vector2((x / s) * 2 - 1, -(y / s) * 2 + 1);
		this.raycaster.setFromCamera(nd, this.cubeCam);
		const hits = this.raycaster.intersectObjects(this.cubeFaces, false);
		return hits.length ? hits[0].object : null;
	}

	// ------------------------------------------------------------ render

	project(v) {
		const p = v.clone().project(this.camera);
		const w = this.container.clientWidth, h = this.container.clientHeight;
		return { x: ((p.x + 1) / 2) * w, y: ((1 - p.y) / 2) * h, behind: p.z > 1 };
	}

	placeLabel(el, world, text, offset = null) {
		const s = this.project(world);
		if (s.behind) { el.style.display = 'none'; return; }
		el.style.display = 'block';
		if (text !== undefined) el.textContent = text;
		const x = s.x + (offset ? offset.x : 0), y = s.y + (offset ? offset.y : 0);
		el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
	}

	updateOverlays() {
		this.handles.update();
		this.alignTool.update();
		const m = this.measure;
		if (m.line && m.mid) this.placeLabel(m.label, m.mid);
		for (const l of m.legs || []) this.placeLabel(l.label, l.mid);
		// the section gizmo stays in the middle of the view at a fixed size on screen
		if (this.sectionTool) this.sectionTool.place();
		if (m.pin && m.pinMid) this.placeLabel(m.clabel, m.pinMid);
		if (m.hover && m.hoverMid) this.placeLabel(m.hlabel, m.hoverMid);
		if (this.comObj) for (const s of this.comObj.children) if (s.userData.scaleWithView) s.scale.setScalar(s.userData.scaleWithView * (this.camera.isOrthographicCamera ? (this.ortho.top - this.ortho.bottom) / this.ortho.zoom / 250 : s.position.distanceTo(this.camera.position) / 250));
		for (const g of [m.pinObj, m.hoverObj]) if (g) for (const s of g.children) if (s.userData.scaleWithView) s.scale.setScalar(this.camera.isOrthographicCamera ? (this.ortho.top - this.ortho.bottom) / this.ortho.zoom / 250 : s.position.distanceTo(this.camera.position) / 250);
		// keep measure markers a constant screen size
		const k = this.camera.isOrthographicCamera ? (this.ortho.top - this.ortho.bottom) / this.ortho.zoom / 250 : null;
		for (const s of m.markers) {
			const sc = k || s.position.distanceTo(this.camera.position) / 250;
			s.scale.setScalar(sc);
		}
	}

	loop() {
		requestAnimationFrame(() => this.loop());
		if (this.holdFrames) return; // while starting: no frames until the shaders are compiled (see precompile)
		const changed = this.controls.update();
		if (!changed && !this.needsRender) return;
		this.render();
	}

	render() {
		this.needsRender = false;
		if (!this.camera.isOrthographicCamera) this.updateClipRange();
		if (this.camera.isOrthographicCamera) this.camera.updateProjectionMatrix();
		this.updateOverlays();
		const r = this.renderer;
		const w = this.container.clientWidth, h = this.container.clientHeight;
		r.setViewport(0, 0, w, h);
		r.setScissorTest(false);
		r.setClearColor(this.bgColor || 0x141a22, 1);
		r.clear();
		r.render(this.scene, this.camera);
		// view cube
		const s = this.cubeSize;
		r.setScissorTest(true);
		r.setScissor(w - s - 8, h - s - 8, s, s);
		r.setViewport(w - s - 8, h - s - 8, s, s);
		r.clearDepth();
		const dir = this.camera.position.clone().sub(this.controls.target).normalize();
		this.cubeCam.position.copy(dir.multiplyScalar(4));
		this.cubeCam.quaternion.copy(this.camera.quaternion);
		r.render(this.cubeScene, this.cubeCam);
		r.setScissorTest(false);
	}

	/** Compile the shaders the scene and the view cube need, in parallel where the GPU allows (at most 3 s). */
	async precompile() {
		const r = this.renderer;
		if (!r.compileAsync) return;
		const limit = new Promise((res) => setTimeout(res, 3000));
		try {
			await Promise.race([Promise.all([r.compileAsync(this.scene, this.camera), this.cubeScene && this.cubeCam ? r.compileAsync(this.cubeScene, this.cubeCam) : null]), limit]);
		} catch (e) { /* compiled on first use instead */ }
		this.holdFrames = false;
		this.invalidate();
	}

	screenshot() {
		this.render();
		return this.canvas.toDataURL('image/png');
	}
}

// Orthonormal frame for a plane: n = normal, x = world X projected onto the plane (or Y if X is the normal).
export function planeBasis(normal) {
	const n = normal.clone().normalize();
	let x = new THREE.Vector3(1, 0, 0).projectOnPlane(n);
	if (x.length() < 0.1) x = new THREE.Vector3(0, 1, 0).projectOnPlane(n);
	x.normalize();
	const y = n.clone().cross(x).normalize();
	const quat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, n));
	return { n, x, y, quat };
}

export function objTransform(obj) {
	const e = new THREE.Euler().setFromQuaternion(obj.quaternion, 'XYZ');
	return {
		pos: [round(obj.position.x), round(obj.position.y), round(obj.position.z)],
		rot: [round(e.x / DEG, 3), round(e.y / DEG, 3), round(e.z / DEG, 3)],
		scale: [round(obj.scale.x, 5), round(obj.scale.y, 5), round(obj.scale.z, 5)],
	};
}
