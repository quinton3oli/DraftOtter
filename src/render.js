// Photoreal render: the design path-traced (three-gpu-pathtracer) in a studio — soft light from a big softbox and a
// gradient sky, a floor that catches shadows and reflections, and print-like materials (matte or glossy plastic,
// silk, metal, clear resin) in each part's color. The picture refines for as long as it runs; Save writes a PNG.
//
// The path tracer's shader is very large, and on some graphics drivers preparing it (and throwing it away while the
// card is still busy with it) takes long enough to lock the page. So one renderer and one path tracer are made the
// first time and kept for the whole session: closing the window only stops and hides it, changing a setting only
// updates materials, colors, size or quality, and opening it again reuses the prepared shader.
import * as THREE from 'three';
import { WebGLPathTracer, GradientEquirectTexture } from 'three-gpu-pathtracer';
import { el, toast, download } from './util.js';

const MATERIALS = {
	matte: { label: 'Matte PLA', props: { roughness: 0.62, metalness: 0, clearcoat: 0.04, clearcoatRoughness: 0.5, sheen: 0, transmission: 0 } },
	glossy: { label: 'Glossy PETG', props: { roughness: 0.2, metalness: 0, clearcoat: 0.5, clearcoatRoughness: 0.08, sheen: 0, transmission: 0 } },
	silk: { label: 'Silk PLA', props: { roughness: 0.3, metalness: 0.45, clearcoat: 0, clearcoatRoughness: 0.5, sheen: 0.5, transmission: 0 } },
	metal: { label: 'Metal', props: { roughness: 0.22, metalness: 1, clearcoat: 0, clearcoatRoughness: 0.5, sheen: 0, transmission: 0 } },
	resin: { label: 'Clear resin', props: { roughness: 0.06, metalness: 0, clearcoat: 0, clearcoatRoughness: 0.5, sheen: 0, transmission: 0.92 } },
};
const BACKDROPS = {
	light: { label: 'Studio, light', top: '#ffffff', bottom: '#b9c0ca', floor: '#e8eaee' },
	dark: { label: 'Studio, dark', top: '#5a616d', bottom: '#0b0d10', floor: '#1d2025' },
	white: { label: 'Plain white', top: '#ffffff', bottom: '#f4f4f4', floor: '#ffffff' },
	clear: { label: 'Transparent (no floor)', top: '#ffffff', bottom: '#b9c0ca', floor: null, transparent: true },
};
const QUALITY = { draft: { label: 'Draft (fast)', samples: 48 }, good: { label: 'Good', samples: 220 }, best: { label: 'Best (slow)', samples: 900 } };
const SIZES = { view: { label: 'Like the view' }, hd: { label: '1920 × 1080', w: 1920, h: 1080 }, square: { label: '1600 × 1600', w: 1600, h: 1600 }, uhd: { label: '3840 × 2160 (slow)', w: 3840, h: 2160 } };
// Z-up (DraftOtter) → Y-up (the renderer's sky)
const TO_Y_UP = new THREE.Matrix4().makeRotationX(-Math.PI / 2);

// made once, kept for the session (see above)
let shared = null;
function sharedRenderer() {
	if (shared) return shared;
	const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, preserveDrawingBuffer: true });
	renderer.toneMapping = THREE.ACESFilmicToneMapping;
	renderer.outputColorSpace = THREE.SRGBColorSpace;
	renderer.setPixelRatio(1);
	const tracer = new WebGLPathTracer(renderer);
	tracer.minSamples = 1;
	tracer.renderDelay = 0;
	tracer.fadeDuration = 0;
	tracer.rasterizeScene = false; // no extra raster pass while the shader is being prepared
	tracer.filterGlossyFactor = 0.4;
	tracer.bounces = 6; // fixed, so no setting ever changes the shader
	const env = new GradientEquirectTexture(256);
	env.exponent = 1.6;
	shared = { renderer, tracer, env, scene: null, camera: null, fence: null, sceneKey: null };
	return shared;
}

export const RenderMixin = {
	renderDialog(opts = {}) {
		const solids = this.model.nodes.filter((n) => n.visible && !n.hole);
		if (!solids.length) { toast('Nothing to render — add some solid shapes first', 'warn'); return; }
		let prefs = { material: 'matte', backdrop: 'light', quality: 'good', size: 'view' };
		try { prefs = { ...prefs, ...JSON.parse(localStorage.getItem('draftotter-render') || '{}') }; } catch (e) { /* ignore */ }
		Object.assign(prefs, opts.prefs || {});
		const sel = (id, table, value) => el('select', { id }, ...Object.entries(table).map(([k, v]) => el('option', { value: k, selected: k === value }, v.label)));
		const matSel = sel('rn-mat', MATERIALS, prefs.material), bgSel = sel('rn-bg', BACKDROPS, prefs.backdrop), qSel = sel('rn-q', QUALITY, prefs.quality), sizeSel = sel('rn-size', SIZES, prefs.size);
		const status = el('span', { class: 'muted small', id: 'rn-status' }, 'Preparing…');
		const bar = el('div', { class: 'rn-bar' }, el('div', { class: 'rn-fill' }));
		const holder = el('div', { class: 'rn-canvas' });
		const form = el('div', { class: 'form render-form' },
			el('div', { class: 'rn-controls' },
				el('label', {}, el('span', {}, 'Material'), matSel), el('label', {}, el('span', {}, 'Backdrop'), bgSel),
				el('label', {}, el('span', {}, 'Quality'), qSel), el('label', {}, el('span', {}, 'Size'), sizeSel)),
			holder, el('div', { class: 'rn-status' }, bar, status),
			el('p', { class: 'muted small' }, 'Path-traced on your graphics card: the picture sharpens as it runs. The camera is your current view — close this, turn the view, and render again for another angle.'));
		const sh = sharedRenderer();
		const st = { alive: true, sh, target: 0, frame: 0, done: false, ui: { holder, status, bar } };
		this.renderState = st;
		holder.appendChild(sh.renderer.domElement);
		// closing only stops the loop and takes the picture out of the window: nothing is thrown away
		const stop = () => {
			if (!st.alive) return;
			st.alive = false;
			cancelAnimationFrame(st.frame);
			sh.renderer.domElement.remove();
		};
		const close = this.modal('Photoreal render', form, [
			{ label: 'Close' },
			{ label: 'Save PNG', primary: true, action: () => { this.saveRender(st); return false; } },
		], 'wide', { onClose: stop });
		const settings = () => ({ material: matSel.value, backdrop: bgSel.value, quality: qSel.value, size: sizeSel.value });
		const changed = () => {
			const p = settings();
			try { localStorage.setItem('draftotter-render', JSON.stringify(p)); } catch (e) { /* ignore */ }
			this.applyRenderSettings(st, p, opts);
		};
		for (const s of [matSel, bgSel, qSel, sizeSel]) s.addEventListener('change', changed);
		// the parts and the camera are taken once per opening; settings only change how they look
		setTimeout(() => { if (!st.alive) return; this.buildRenderScene(st, opts); changed(); }, 30);
		return close;
	},

	/** The design's parts (holes cut, in their colors), a floor, a softbox and the camera of the view, turned Y-up. */
	buildRenderScene(st, opts = {}) {
		const sh = st.sh, vp = this.vp;
		if (sh.scene) sh.scene.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
		const scene = new THREE.Scene();
		const visible = this.model.nodes.filter((n) => n.visible), holes = visible.filter((n) => n.hole);
		const box = new THREE.Box3(), parts = [];
		for (const n of visible.filter((k) => !k.hole)) {
			const g = this.engine.printable([n, ...holes], true);
			if (!g || !g.attributes.position.count) continue;
			const geo = (g.index ? g.toNonIndexed() : g.clone()).applyMatrix4(TO_Y_UP);
			if (!geo.attributes.normal) geo.computeVertexNormals();
			geo.computeBoundingBox();
			box.union(geo.boundingBox);
			// painted faces: a color per corner (white material so the colors show as they are)
			const tc = this.paintColorsFor(n, (g.index ? g.toNonIndexed() : g).attributes.position.array);
			if (tc && !geo.index) {
				const arr = new Float32Array(geo.attributes.position.count * 3), base = new THREE.Color(n.color || '#cccccc'), c = new THREE.Color();
				for (let i = 0; i < tc.length; i++) { c.set(tc[i] || base); for (let k = 0; k < 3; k++) c.toArray(arr, 9 * i + 3 * k); }
				geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
			}
			const painted = !!geo.attributes.color;
			const color = new THREE.Color(painted ? '#ffffff' : n.color || '#cccccc');
			const mesh = new THREE.Mesh(geo, new THREE.MeshPhysicalMaterial({ color, vertexColors: painted, ior: 1.5, thickness: 4, sheenColor: color.clone().lerp(new THREE.Color('#ffffff'), 0.4) }));
			mesh.userData.part = true;
			mesh.userData.painted = painted;
			scene.add(mesh);
			parts.push(mesh);
		}
		if (box.isEmpty()) { st.ui.status.textContent = 'Nothing to render'; return; }
		const size = Math.max(1, box.getSize(new THREE.Vector3()).length()), c = box.getCenter(new THREE.Vector3());
		const floor = new THREE.Mesh(new THREE.PlaneGeometry(size * 40, size * 40).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#e8eaee', roughness: 0.85, metalness: 0, transparent: true }));
		floor.position.set(c.x, box.min.y - 0.001, c.z);
		scene.add(floor);
		const soft = new THREE.RectAreaLight(0xffffff, 6, size * 1.6, size * 1.6);
		soft.position.set(c.x - size * 0.9, c.y + size * 1.6, c.z + size * 1.1);
		soft.lookAt(c);
		scene.add(soft);
		scene.environment = sh.env;
		scene.environmentIntensity = 0.9;
		// the camera of the view
		const vc = vp.camera, target = vp.controls.target.clone();
		const cam = new THREE.PerspectiveCamera(vp.persp ? vp.persp.fov : 40, 1, size * 0.01, size * 200);
		cam.position.copy(vc.position).applyMatrix4(TO_Y_UP);
		cam.up.copy(vc.up).applyMatrix4(TO_Y_UP);
		cam.lookAt(target.clone().applyMatrix4(TO_Y_UP));
		if (vc.isOrthographicCamera) {
			// a flat view: a long lens from far back gives nearly the same picture
			const T = target.clone().applyMatrix4(TO_Y_UP), d = cam.position.distanceTo(T), span = (vc.top - vc.bottom) / vc.zoom;
			cam.fov = 8;
			const back = span / 2 / Math.tan((cam.fov * Math.PI) / 360);
			cam.position.copy(T).addScaledVector(cam.position.clone().sub(T).normalize(), Math.max(back, d));
			cam.far = back * 4;
		}
		sh.scene = scene;
		sh.camera = cam;
		st.parts = parts;
		st.floor = floor;
		st.sceneReady = false;
	},

	/** Settings → the scene and the path tracer, without rebuilding either (no new shader, no new scene). */
	applyRenderSettings(st, p, opts = {}) {
		const sh = st.sh, vp = this.vp;
		// before this opening's scene is built, the build applies the settings itself
		if (!st.alive || !sh.scene || !st.parts) return;
		cancelAnimationFrame(st.frame);
		const mat = MATERIALS[p.material] || MATERIALS.matte, bd = BACKDROPS[p.backdrop] || BACKDROPS.light;
		for (const m of st.parts) Object.assign(m.material, mat.props);
		st.floor.material.color.set(bd.floor || '#ffffff');
		st.floor.material.opacity = bd.floor ? 1 : 0;
		sh.env.topColor.set(bd.top); sh.env.bottomColor.set(bd.bottom);
		sh.env.update();
		sh.scene.background = bd.transparent ? null : sh.env;
		sh.renderer.setClearColor(0x000000, bd.transparent ? 0 : 1);
		const sz = SIZES[p.size] || SIZES.view, vr = vp.canvas.getBoundingClientRect();
		const w = opts.width || sz.w || Math.round(vr.width), h = opts.height || sz.h || Math.round(vr.height);
		const resized = !st.size || st.size[0] !== w || st.size[1] !== h;
		st.size = [w, h];
		if (resized) {
			sh.renderer.setSize(w, h, false);
			sh.renderer.domElement.style.aspectRatio = `${w} / ${h}`;
			// small tiles: each step is a short burst of work for the graphics card, so the page stays responsive
			const n = Math.max(2, Math.min(8, Math.ceil(Math.sqrt((w * h) / 250000))));
			sh.tracer.tiles.set(n, n);
		}
		sh.camera.aspect = w / h;
		sh.camera.updateProjectionMatrix();
		const tracer = sh.tracer;
		if (!st.sceneReady) {
			// the parts (once per opening): only the scene's data changes, the shader stays the same
			tracer.setScene(sh.scene, sh.camera);
			st.sceneReady = true;
		} else {
			tracer.updateMaterials();
			tracer.updateEnvironment();
			tracer.updateCamera();
		}
		tracer.reset();
		st.target = opts.samples || QUALITY[p.quality].samples;
		st.done = false;
		this.runRender(st);
	},

	/** Run samples until the target, one step at a time: the next only once the card has finished the last. */
	runRender(st) {
		const sh = st.sh, tracer = sh.tracer, gl = sh.renderer.getContext(), { status, bar } = st.ui;
		const [w, h] = st.size;
		const t0 = performance.now();
		const step = () => {
			if (!st.alive) return;
			if (sh.fence) {
				if (gl.getSyncParameter(sh.fence, gl.SYNC_STATUS) !== gl.SIGNALED) { st.frame = requestAnimationFrame(step); return; }
				gl.deleteSync(sh.fence);
				sh.fence = null;
			}
			if (tracer.isCompiling) {
				status.textContent = 'Preparing the renderer… (the first time can take a minute on some graphics cards)';
				tracer.renderSample();
				st.frame = requestAnimationFrame(step);
				return;
			}
			if (tracer.samples < st.target) {
				tracer.renderSample();
				sh.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
				gl.flush();
				const k = Math.min(1, tracer.samples / st.target);
				bar.firstChild.style.width = `${Math.round(k * 100)}%`;
				status.textContent = `${Math.floor(tracer.samples)} / ${st.target} samples · ${w} × ${h}`;
				st.frame = requestAnimationFrame(step);
			} else {
				st.done = true;
				status.textContent = `Done — ${st.target} samples in ${((performance.now() - t0) / 1000).toFixed(1)} s · ${w} × ${h}`;
			}
		};
		st.frame = requestAnimationFrame(step);
	},

	saveRender(st) {
		if (!st || !st.sh) return;
		const name = (this.model.doc.name || 'design').replace(/[^\w\- ]+/g, '_');
		st.sh.renderer.domElement.toBlob((blob) => {
			if (!blob) { toast('Could not save the picture', 'error'); return; }
			download(blob, `${name} render.png`, 'image/png');
			toast(`Saved ${name} render.png${st.done ? '' : ' (still refining — save again later for a cleaner picture)'}`, 'ok', 3500);
		}, 'image/png');
	},
};
