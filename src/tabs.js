// Design tabs: several designs open at once, each with its own document, undo, history, file and view. The tab
// strip sits under the toolbar; the active tab's design is this.model, and switching swaps it (the engine's caches
// are shared, so switching back to a tab is quick). Open tabs come back after a reload: each autosaves on its own
// and the list of tabs is kept in localStorage.
import { Model } from './model.js';
import { toast, el, idbGet, idbSet } from './util.js';

const SESSION_KEY = 'draftotter-tabs-v1';
const AUTOSAVE_KEY = 'draftotter-autosave-v1';
const FIRST = 't0'; // the first tab uses the original (single-design) storage keys, so older sessions open as tab 1
const $ = (s) => document.querySelector(s);
const newId = () => 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

export const TabsMixin = {
	/** Storage key for something belonging to a tab (the first tab keeps the old, un-suffixed keys). */
	tabKey(base, id = this.curTab() && this.curTab().id) {
		return !id || id === FIRST ? base : base + ':' + id;
	},

	curTab() { return this.tabs ? this.tabs[this.tabIndex] : null; },

	/** Read the tab list (before the first design is restored). */
	loadTabSession() {
		let s = null;
		try { s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (e) { /* none */ }
		const list = s && Array.isArray(s.tabs) && s.tabs.length ? s.tabs : [{ id: FIRST, name: 'Untitled' }];
		this.tabs = list.map((t) => ({ id: t.id, name: t.name || 'Untitled', fileName: t.fileName || null, dirty: !!t.dirty, model: null }));
		this.tabIndex = Math.max(0, this.tabs.findIndex((t) => t.id === (s && s.active)));
		this.tabs[this.tabIndex].model = this.model;
	},

	saveTabSession() {
		if (!this.tabs) return;
		const t = this.curTab();
		if (t) { t.name = this.model.doc.name; t.fileName = this.fileName || null; t.dirty = this.isDirty(); }
		try { localStorage.setItem(SESSION_KEY, JSON.stringify({ active: t && t.id, tabs: this.tabs.map((x) => ({ id: x.id, name: x.name, fileName: x.fileName, dirty: x.dirty })) })); } catch (e) { /* full */ }
	},

	/** A tab's autosaved design: { doc, blobs, savedSig, fileName } or null. */
	async readTabSave(id) {
		let raw = null;
		try { raw = localStorage.getItem(this.tabKey(AUTOSAVE_KEY, id)); } catch (e) { /* none */ }
		if (raw && raw.startsWith('{"inIdb"')) raw = (await idbGet(this.tabKey(AUTOSAVE_KEY, id))) || null;
		try { return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
	},

	/** Leave the current tab cleanly (tools closed, state kept with the tab). Returns false if it can't now. */
	stashTab() {
		if (this.sculpt) { toast('Finish sculpting first (Done or Cancel)', 'warn'); return false; }
		if (this.merging) { toast('Finish or cancel the merge first', 'warn'); return false; }
		if (this.lattice) this.stopLattice();
		this.stopCompare && this.stopCompare();
		this.setTool(null);
		this.autosaveNow();
		const t = this.curTab(), cam = this.vp.camera, ctl = this.vp.controls;
		Object.assign(t, {
			model: this.model, sel: this.sel.slice(), fileHandle: this.fileHandle, fileName: this.fileName, savedSig: this.savedSig,
			name: this.model.doc.name, dirty: this.isDirty(),
			view: { pos: cam.position.toArray(), target: ctl.target.toArray(), zoom: cam.zoom, ortho: !!cam.isOrthographicCamera },
		});
		return true;
	},

	/** Show tab i. */
	async switchTab(i) {
		if (i === this.tabIndex || !this.tabs[i]) return true;
		if (!this.stashTab()) return false;
		const t = this.tabs[i];
		if (!t.model) {
			// first visit since the page loaded: its autosave
			const m = new Model(), saved = await this.readTabSave(t.id);
			if (saved && saved.doc) m.load(saved.doc, saved.blobs); else m.load({ ...m.emptyDoc(), name: t.name });
			Object.assign(t, { model: m, sel: [], savedSig: saved ? saved.savedSig || null : null, fileName: saved ? saved.fileName || null : null, fileHandle: (await idbGet(this.tabKey('fileHandle', t.id))) || null, fresh: true });
		}
		this.tabIndex = i;
		this.model = t.model;
		this.engine.model = t.model;
		this.sel = t.sel || [];
		this.fileHandle = t.fileHandle || null;
		this.fileName = t.fileName || null;
		this.savedSig = t.savedSig || null;
		this.applyExpressions();
		// a tab whose parts are already built (switching back) needs no loading screen
		this.syncOff();
		const off = this.engine.offIds || new Set();
		let unbuilt = false;
		const look = (list) => { for (const n of list) { if (unbuilt) return; if (!off.has(n.id) && !this.engine.cache.has(this.engine.key(n))) unbuilt = true; else if (n.children) look(n.children); } };
		look(this.model.nodes);
		let ld = null;
		if (unbuilt) { ld = this.loadingScreen('Opening “' + (t.model.doc.name || 'Untitled') + '”', true); await this.prebuild(ld, 0, 0.95, false); }
		this.vp.buildBed(this.model.settings);
		this.vp.setSnap(this.model.settings);
		this.syncSnapSelect();
		this.afterChange();
		if (t.fresh) { t.fresh = false; await this.restoreUndo(); }
		if (t.view) {
			if (!!t.view.ortho !== !!this.vp.camera.isOrthographicCamera) this.vp.setOrtho(t.view.ortho);
			this.vp.camera.position.fromArray(t.view.pos);
			this.vp.controls.target.fromArray(t.view.target);
			if (this.vp.camera.isOrthographicCamera) { this.vp.camera.zoom = t.view.zoom; this.vp.updateOrtho(); }
			this.vp.controls.update();
		} else this.vp.frameBox(this.sceneBox());
		this.vp.invalidate();
		if (ld) ld.done();
		this.saveTabSession();
		this.renderTabs();
		return true;
	},

	/** Open a new, empty design in a tab (with the current printer and grid settings). */
	async newTab() {
		const m = new Model();
		const settings = JSON.parse(JSON.stringify(this.model.settings));
		settings.section = { ...settings.section, on: false };
		m.load({ ...m.emptyDoc(), settings });
		const t = { id: newId(), name: 'Untitled', model: m, sel: [], fileHandle: null, fileName: null, savedSig: null, dirty: false };
		this.tabs.splice(this.tabIndex + 1, 0, t);
		const ok = await this.switchTab(this.tabIndex + 1);
		if (!ok) this.tabs.splice(this.tabs.indexOf(t), 1);
		this.renderTabs();
		return ok;
	},

	/** Is the current tab an empty, untouched design (so opening a file can use it)? */
	tabIsBlank() {
		return !this.model.nodes.length && !this.fileName && !this.isDirty() && !Object.keys((this.model.doc.history || {}).commits || {}).length;
	},

	tabDirty(t) {
		return t === this.curTab() ? this.isDirty() : !!t.dirty;
	},

	/** Close tab i (asks first when it has unsaved changes). The last tab is replaced by an empty one. */
	async closeTab(i, force = false) {
		const t = this.tabs[i];
		if (!t) return false;
		if (!force && this.tabDirty(t) && (t.model ? t.model.nodes.length : true) && !confirm(`Close “${t === this.curTab() ? this.model.doc.name : t.name}” without saving? Its unsaved changes will be lost.`)) return false;
		if (t === this.curTab()) {
			if (this.sculpt || this.merging) { this.stashTab(); return false; }
			if (this.tabs.length === 1) {
				// the only tab: start over with an empty design in its place
				await this.newTab();
				return this.closeTab(0, true);
			}
			const next = i < this.tabs.length - 1 ? i + 1 : i - 1;
			if (!(await this.switchTab(next))) return false;
		}
		const at = this.tabs.indexOf(t);
		this.tabs.splice(at, 1);
		if (at < this.tabIndex) this.tabIndex--;
		// its autosave, file and undo go with it
		try { localStorage.removeItem(this.tabKey(AUTOSAVE_KEY, t.id)); } catch (e) { /* none */ }
		idbSet(this.tabKey(AUTOSAVE_KEY, t.id), undefined);
		idbSet(this.tabKey('fileHandle', t.id), undefined);
		idbSet(this.tabKey('draftotter-undo-v1', t.id), undefined);
		this.saveTabSession();
		this.renderTabs();
		return true;
	},

	moveTab(from, to) {
		if (from === to || !this.tabs[from] || !this.tabs[to]) return;
		const active = this.curTab();
		const [t] = this.tabs.splice(from, 1);
		this.tabs.splice(to, 0, t);
		this.tabIndex = this.tabs.indexOf(active);
		this.saveTabSession();
		this.renderTabs();
	},

	renderTabs() {
		if (!this.tabs) return;
		let bar = $('#tabbar');
		if (!bar) {
			bar = el('div', { id: 'tabbar', role: 'tablist' });
			$('#app').insertBefore(bar, $('#left'));
		}
		bar.innerHTML = '';
		let dragFrom = -1;
		this.tabs.forEach((t, i) => {
			const active = i === this.tabIndex;
			const name = active ? this.model.doc.name || 'Untitled' : t.name || 'Untitled';
			const dirty = this.tabDirty(t) && (active ? this.model.nodes.length > 0 : true);
			const tab = el('div', { class: 'tab' + (active ? ' active' : ''), role: 'tab', 'aria-selected': String(active), draggable: 'true', title: (t.fileName ? t.fileName : name) + (dirty ? ' — unsaved changes' : '') },
				el('span', { class: 'tab-name' }, name),
				dirty ? el('span', { class: 'tab-dot', title: 'Unsaved changes' }) : null,
				el('button', { class: 'tab-x', title: 'Close tab', onclick: (e) => { e.stopPropagation(); this.closeTab(i); } }, '✕'));
			tab.addEventListener('click', () => this.switchTab(i));
			tab.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); this.closeTab(i); } });
			tab.addEventListener('dragstart', (e) => { dragFrom = i; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/lcad-tab', String(i)); });
			tab.addEventListener('dragover', (e) => { if (dragFrom >= 0) { e.preventDefault(); tab.classList.add('drop'); } });
			tab.addEventListener('dragleave', () => tab.classList.remove('drop'));
			tab.addEventListener('drop', (e) => { e.preventDefault(); tab.classList.remove('drop'); if (dragFrom >= 0) this.moveTab(dragFrom, i); dragFrom = -1; });
			bar.appendChild(tab);
		});
		bar.appendChild(el('button', { class: 'tab-new', title: 'New design in a new tab', onclick: () => this.newTab() }, '+'));
	},
};

export { SESSION_KEY };
