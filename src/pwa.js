// Installable web app: when DraftOtter is served from a website (not opened as a file), add the web manifest,
// register the service worker (offline use and updates), invite people to install it, and open design files that
// the operating system hands to the installed app.
import { toast, el } from './util.js';

const served = () => location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
const PROMPT_KEY = 'draftotter-install-prompt';
const ASK_AGAIN_DAYS = 14;
const PROMPT_DELAY = 1500; // ms after the app is ready: long enough to see the app first

// Chrome and Edge announce "installable" early, often before the app has finished loading: catch it from the start.
let earlyPrompt = null;
if (typeof window !== 'undefined') {
	window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); earlyPrompt = e; window.dispatchEvent(new Event('draftotter-installable')); });
}

/** Running as the installed app (its own window) rather than in a browser tab. */
const installed = () => (typeof matchMedia === 'function' && (matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: window-controls-overlay)').matches)) || navigator.standalone === true;

/** Safari can't install from a button: the steps to show instead, or null. */
function safariSteps() {
	const ua = navigator.userAgent;
	const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
	const safari = /Safari/.test(ua) && !/Chrome|CriOS|Edg|FxiOS|Firefox|OPR/.test(ua);
	if (ios && safari) return 'Tap the Share button, then “Add to Home Screen”.';
	if (safari && /Macintosh/.test(ua)) return 'In the menu bar, choose File → Add to Dock.';
	return null;
}

function loadPrefs() { try { return JSON.parse(localStorage.getItem(PROMPT_KEY) || '{}'); } catch (e) { return {}; } }
function savePrefs(p) { try { localStorage.setItem(PROMPT_KEY, JSON.stringify(p)); } catch (e) { /* private window */ } }

export const PwaMixin = {
	initPwa() {
		if (!served()) return; // opened as a file: nothing to install, and no manifest to fetch
		const head = document.head;
		head.append(
			el('link', { rel: 'manifest', href: 'manifest.webmanifest' }),
			el('meta', { name: 'theme-color', content: '#141a22' }),
			el('link', { rel: 'apple-touch-icon', href: 'icons/draftotter-apple-touch.png' }),
			el('meta', { name: 'apple-mobile-web-app-capable', content: 'yes' }),
		);
		const installable = () => { this.installPrompt = earlyPrompt; this.renderInstallButton(); this.scheduleInstallCard(); };
		if (earlyPrompt) installable();
		window.addEventListener('draftotter-installable', installable);
		window.addEventListener('appinstalled', () => {
			this.installPrompt = earlyPrompt = null;
			this.closeInstallCard();
			this.renderInstallButton();
			savePrefs({ ...loadPrefs(), installed: Date.now() });
			toast('DraftOtter is installed — open it from your Start menu, Dock or home screen', 'ok', 5000);
		});
		if (!this.installPrompt && safariSteps()) this.scheduleInstallCard();
		this.registerServiceWorker();
		// design files opened with the installed app (double-click a .lcad.json, or Open with → DraftOtter)
		if ('launchQueue' in window) {
			window.launchQueue.setConsumer(async (params) => {
				const h = params.files && params.files[0];
				if (!h) return;
				try { await this.openProject(await h.getFile(), h); } catch (err) { toast('Could not open that file: ' + err.message, 'error', 5000); }
			});
		}
	},

	async registerServiceWorker() {
		if (!('serviceWorker' in navigator)) return;
		let reg;
		try { reg = await navigator.serviceWorker.register('sw.js'); } catch (e) { console.warn('Service worker not registered', e); return; }
		const offer = (w) => {
			if (!w || !navigator.serviceWorker.controller) return; // first install: nothing to replace
			this.updateWaiting = w;
			const bar = el('div', { class: 'toast info update-toast' }, 'A new version of DraftOtter is ready. ',
				el('button', { class: 'btn sm primary', onclick: () => { this.autosaveNow(); w.postMessage('skip-waiting'); } }, 'Reload to update'),
				el('button', { class: 'btn sm', onclick: () => bar.remove() }, 'Later'));
			(document.querySelector('#toasts') || document.body).appendChild(bar);
		};
		if (reg.waiting) offer(reg.waiting);
		reg.addEventListener('updatefound', () => {
			const w = reg.installing;
			w && w.addEventListener('statechange', () => { if (w.state === 'installed') offer(w); });
		});
		let reloading = false;
		navigator.serviceWorker.addEventListener('controllerchange', () => { if (this.updateWaiting && !reloading) { reloading = true; location.reload(); } });
		// look for a new version now and then while the app stays open
		setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
	},

	async installApp() {
		const p = this.installPrompt;
		this.closeInstallCard();
		if (!p) { toast(safariSteps() || 'Use your browser\'s menu → Install DraftOtter (or Add to Home Screen)', 'info', 5000); return; }
		this.installPrompt = earlyPrompt = null; // the browser's prompt can only be shown once
		this.renderInstallButton();
		p.prompt();
		const choice = await p.userChoice.catch(() => null);
		if (choice && choice.outcome === 'dismissed') savePrefs({ ...loadPrefs(), later: Date.now() });
	},

	/** Should the install card come up on its own? Not when installed, declined for good, or declined lately. */
	shouldOfferInstall() {
		if (installed() || !served()) return false;
		const p = loadPrefs();
		if (p.never) return false;
		if (p.later && Date.now() - p.later < ASK_AGAIN_DAYS * 864e5) return false;
		return !!(this.installPrompt || safariSteps());
	},

	scheduleInstallCard() {
		clearTimeout(this.installTimer);
		if (!this.shouldOfferInstall()) return;
		const show = () => {
			// wait for a quiet moment: no dialog open, no tool in use
			if (document.querySelector('.modal-back') || this.vp.tool) { this.installTimer = setTimeout(show, 3000); return; }
			if (this.shouldOfferInstall()) this.showInstallCard();
		};
		this.installTimer = setTimeout(show, PROMPT_DELAY);
	},

	showInstallCard() {
		if (document.querySelector('#install-card')) return;
		const steps = this.installPrompt ? null : safariSteps();
		const later = () => { savePrefs({ ...loadPrefs(), later: Date.now() }); this.closeInstallCard(); };
		const never = () => { savePrefs({ ...loadPrefs(), never: true }); this.closeInstallCard(); toast('OK — you can still install it any time from File → Install DraftOtter', 'info', 3500); };
		const perk = (icon, text) => el('li', {}, el('span', { class: 'ic-perk' }, icon), text);
		const main = steps
			? el('button', { class: 'btn primary ic-main', onclick: later }, 'Got it')
			: el('button', { class: 'btn primary ic-main', onclick: () => this.installApp() }, 'Install');
		const card = el('div', { class: 'ic-card' },
			el('button', { class: 'icon-btn ic-close', title: 'Not now', onclick: later }, '✕'),
			el('img', { src: 'icons/draftotter-192.png', alt: '', class: 'ic-icon' }),
			el('h2', {}, 'Install DraftOtter on this device'),
			el('p', { class: 'ic-lead' }, 'Get the full app experience — free, and it takes a second.'),
			el('ul', { class: 'ic-perks' },
				perk('⚡', 'Opens instantly from your Start menu, Dock or home screen'),
				perk('✈', 'Works fully offline — design anywhere, no internet needed'),
				perk('🔒', 'Your designs stay on this device')),
			steps ? el('div', { class: 'ic-steps' }, steps) : null,
			main,
			el('div', { class: 'ic-secondary' },
				steps ? null : el('button', { class: 'btn link', onclick: later }, 'Not now'),
				el('button', { class: 'btn link', onclick: never }, 'Don’t ask again')));
		const back = el('div', { id: 'install-card', class: 'install-back', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Install DraftOtter' }, card);
		// clicking outside the card or pressing Esc means "not now"
		back.addEventListener('pointerdown', (e) => { if (e.target === back) later(); });
		this.installKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); later(); } };
		window.addEventListener('keydown', this.installKey, true);
		document.body.appendChild(back);
		setTimeout(() => main.focus(), 50);
	},

	closeInstallCard() {
		clearTimeout(this.installTimer);
		if (this.installKey) { window.removeEventListener('keydown', this.installKey, true); this.installKey = null; }
		const c = document.querySelector('#install-card');
		if (c) c.remove();
	},

	/** "Install app" in the status bar while the browser can install it. */
	renderInstallButton() {
		let b = document.querySelector('#st-install');
		if (!this.installPrompt || installed()) { if (b) b.remove(); return; }
		if (b) return;
		b = el('span', { id: 'st-install', class: 'install-state', role: 'button', tabindex: 0, title: 'Install DraftOtter as an app on this device (works offline)', onclick: () => this.installApp() }, '⤓ Install app');
		document.querySelector('#status').insertBefore(b, document.querySelector('#save-state'));
	},
};
