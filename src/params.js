// Design configurations (named sets of variable values, batch export) and parametric templates
// (groups with their own parameters that override the design variables inside them).
import { walk } from './model.js';
import { exprNames, evalExpr, resolveVars, fmt, toast, el } from './util.js';
import { icon } from './icons.js';

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const ConfigMixin = {
	/** Switch to a configuration: its values replace the matching variables. */
	applyConfig(name, { silent = false } = {}) {
		const doc = this.model.doc;
		const cfg = (doc.configs || []).find((c) => c.name === name);
		if (!cfg) return false;
		for (const v of doc.vars || []) if (v.name in cfg.values) v.expr = String(cfg.values[v.name]);
		doc.activeConfig = name;
		if (!silent) { this.propSig = null; this.commit(); toast(`Configuration “${name}”`, 'ok'); }
		return true;
	},

	/** Quick switcher (Properties, no selection). */
	configSwitcher() {
		const doc = this.model.doc, cfgs = doc.configs || [];
		if (!cfgs.length) return null;
		const sel = el('select', { title: 'Switch the design to another configuration' }, ...cfgs.map((c) => el('option', { value: c.name }, c.name)));
		if (!doc.activeConfig) sel.prepend(el('option', { value: '' }, '— custom values —'));
		sel.value = doc.activeConfig || '';
		sel.addEventListener('change', () => { if (sel.value) this.applyConfig(sel.value); });
		return el('label', { class: 'field wide' }, el('span', {}, 'Config'), sel);
	},

	/** Export every configuration into one zip (one file per configuration). */
	exportConfigurations(nodes, fname, merge, format, writeOne) {
		const doc = this.model.doc;
		const saved = { vars: JSON.parse(JSON.stringify(doc.vars || [])), active: doc.activeConfig || null };
		const files = [];
		try {
			for (const c of doc.configs || []) {
				this.applyConfig(c.name, { silent: true });
				this.applyExpressions();
				const out = writeOne(nodes, c.name);
				if (out) files.push({ name: `${fname}_${c.name}`.replace(/[^\w\- .]+/g, '_') + out.ext, data: out.data });
			}
		} finally {
			doc.vars = saved.vars;
			doc.activeConfig = saved.active;
			this.applyExpressions();
			this.afterChange();
		}
		return files;
	},
};

/** Global variables referenced anywhere inside a node (expressions and sketch dimensions). */
export function referencedVars(node) {
	const names = new Set();
	walk([node], (n) => {
		for (const e of Object.values(n.exprs || {})) exprNames(e).forEach((x) => names.add(x));
		for (const c of (n.type === 'sketch' && n.params.cons) || []) if (c.expr) exprNames(c.expr).forEach((x) => names.add(x));
		for (const v of n.localVars || []) exprNames(v.expr).forEach((x) => names.add(x));
	});
	walk([node], (n) => { for (const v of n.localVars || []) names.delete(v.name); });
	return [...names];
}

export const TemplateMixin = {
	/** Parameters section for a group: its own named values, used by everything inside it. */
	paramsSection(host, n) {
		const sec = this.section(host, 'Parameters');
		const list = n.localVars || [];
		const scope = (this.scopeById && this.scopeById.get(n.id)) || this.varValues || {};
		const { values, errors } = resolveVars(list, scope);
		list.forEach((v, i) => {
			const nm = el('input', { type: 'text', value: v.name, class: 'pname', spellcheck: 'false', title: 'Parameter name (use it in any field inside this group)' });
			const ex = el('input', { type: 'text', value: v.expr, class: 'num', spellcheck: 'false', title: errors[v.name] || `= ${fmt(values[v.name], 4)}` });
			if (errors[v.name]) ex.classList.add('bad');
			nm.addEventListener('change', () => {
				const nv = nm.value.trim();
				if (!NAME_RE.test(nv)) { toast('Use letters, digits and _ for parameter names', 'error'); nm.value = v.name; return; }
				// rename inside the group
				const from = v.name;
				walk([n], (m) => {
					for (const k in m.exprs || {}) m.exprs[k] = m.exprs[k].replace(new RegExp('\\b' + from + '\\b(?!\\s*\\()', 'g'), nv);
					for (const c of (m.type === 'sketch' && m.params.cons) || []) if (c.expr) c.expr = c.expr.replace(new RegExp('\\b' + from + '\\b(?!\\s*\\()', 'g'), nv);
				});
				v.name = nv;
				this.propSig = null;
				this.commit();
			});
			ex.addEventListener('change', () => { v.expr = ex.value.trim() || '0'; this.commit(); });
			ex.addEventListener('keydown', (e) => { if (e.key === 'Enter') ex.blur(); });
			const del = el('button', { class: 'icon-btn sm', title: 'Remove parameter', html: icon('x') });
			del.addEventListener('click', () => { list.splice(i, 1); if (!list.length) delete n.localVars; this.propSig = null; this.commit(); });
			sec.appendChild(el('div', { class: 'param-row' }, nm, ex, el('span', { class: 'muted small' }, errors[v.name] ? '!' : `= ${fmt(values[v.name], 3)}`), del));
		});
		const add = el('button', { class: 'btn sm', onclick: () => {
			n.localVars = n.localVars || [];
			let k = n.localVars.length + 1, name = 'p' + k;
			while (n.localVars.some((v) => v.name === name)) name = 'p' + ++k;
			n.localVars.push({ name, expr: '10' });
			this.propSig = null;
			this.commit();
		} }, '+ Parameter');
		const tpl = el('button', { class: 'btn sm', title: 'Copy the design variables it uses into this group and save it to My parts', onclick: () => this.makeTemplate(n) }, 'Make template…');
		sec.appendChild(el('div', { class: 'btn-row' }, add, tpl));
		if (!list.length) sec.appendChild(el('div', { class: 'muted small pad-x' }, 'Parameters are values that every field inside this group can use (e.g. width, wall). Each copy of the group — and each use from My parts — can have its own values.'));
	},

	/** Turn a group into a self-contained parametric part and offer to save it to My parts. */
	makeTemplate(n) {
		if (!n || n.type !== 'group') { toast('Select a group to make a template', 'warn'); return; }
		const used = referencedVars(n).filter((name) => (this.model.doc.vars || []).some((v) => v.name === name));
		const checks = used.map((name) => {
			const v = this.model.doc.vars.find((x) => x.name === name);
			return { name, expr: v.expr, cb: el('input', { type: 'checkbox', checked: true }) };
		});
		const body = el('div', { class: 'form' },
			el('p', { class: 'muted small' }, used.length ? 'These design variables are used inside the group. Checked ones become the group’s own parameters, so the part works in any design and each copy can have its own values.' : 'This group does not use any design variables yet. Add parameters in Properties and use them in its fields, e.g. a width of “w”.'),
			...checks.map((c) => el('label', { class: 'check' }, c.cb, el('span', {}, el('code', {}, c.name), ` = ${c.expr}`))),
			el('label', { class: 'check' }, el('input', { id: 'tpl-save', type: 'checkbox', checked: true }), el('span', {}, 'Save to My parts')));
		this.modal('Make template', body, [{ label: 'Cancel' }, {
			label: 'Make template', primary: true, action: () => {
				n.localVars = n.localVars || [];
				for (const c of checks) if (c.cb.checked && !n.localVars.some((v) => v.name === c.name)) n.localVars.push({ name: c.name, expr: c.expr });
				if (!n.localVars.length) delete n.localVars;
				this.propSig = null;
				this.commit();
				if (body.querySelector('#tpl-save').checked) { this.setSelection([n.id]); setTimeout(() => this.saveToLibrary(), 50); }
			},
		}]);
	},
};

export { evalExpr };
