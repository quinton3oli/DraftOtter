// A small pool of background geometry workers (see csgworker.js). Jobs are queued and run on the first free
// worker, so independent parts of a design are built in parallel while the page stays responsive.
import workerCode from 'virtual:csg-worker';
import wasmBinary from 'manifold-3d/manifold.wasm';

export class CsgPool {
	constructor(size = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1))) {
		this.size = size;
		this.workers = [];
		this.queue = [];
		this.jobs = new Map();
		this.seq = 0;
		this.broken = false;
	}

	/** Start the workers (once). Resolves to true when at least one is ready. */
	start() {
		if (this.started) return this.started;
		this.started = new Promise((resolve) => {
			let url;
			try { url = URL.createObjectURL(new Blob([workerCode], { type: 'text/javascript' })); } catch (e) { this.broken = true; resolve(false); return; }
			let pending = this.size, any = false;
			const settle = () => { if (--pending === 0) { if (!any) this.broken = true; resolve(any); } };
			for (let i = 0; i < this.size; i++) {
				let w;
				try { w = new Worker(url); } catch (e) { settle(); continue; }
				const slot = { w, busy: null, ready: false };
				w.onmessage = (ev) => {
					const d = ev.data;
					if (d.type === 'ready') { slot.ready = true; this.workers.push(slot); any = true; settle(); this.pump(); return; }
					if (d.type === 'failed') { console.warn('Geometry worker failed to start:', d.error); w.terminate(); settle(); return; }
					const job = this.jobs.get(d.id);
					slot.busy = null;
					if (job) { this.jobs.delete(d.id); if (d.ok) job.resolve(d); else job.reject(new Error(d.error)); }
					this.pump();
				};
				w.onerror = (ev) => {
					// a worker that dies takes its job down with it; the caller falls back to building on the main thread
					if (!slot.ready) { console.warn('Geometry worker failed to load:', ev.message); settle(); return; }
					if (slot.busy) { const job = this.jobs.get(slot.busy); this.jobs.delete(slot.busy); if (job) job.reject(new Error(ev.message || 'worker error')); }
					this.workers = this.workers.filter((x) => x !== slot);
					if (!this.workers.length) this.broken = true;
				};
				w.postMessage({ type: 'init', wasm: wasmBinary.slice() });
			}
		});
		return this.started;
	}

	get ok() { return !this.broken && this.workers.length > 0; }

	/** Run one kernel job: { op: 'csg' | 'grow', ... }. Resolves to { r: { pos, idx } | null, ms }. */
	run(msg, transfer = []) {
		return new Promise((resolve, reject) => {
			const id = ++this.seq;
			this.jobs.set(id, { resolve, reject });
			this.queue.push({ id, msg, transfer });
			this.pump();
		});
	}

	pump() {
		for (const slot of this.workers) {
			if (slot.busy || !this.queue.length) continue;
			const { id, msg, transfer } = this.queue.shift();
			slot.busy = id;
			slot.w.postMessage({ ...msg, id }, transfer);
		}
	}
}
