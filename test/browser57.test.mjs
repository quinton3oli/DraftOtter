// The section bar's controls keep working after the design is replaced (opening a file, another tab): X / Y / Z,
// the position box, Flip, Plane and Center act on the design that is open now.
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 240000, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1500, height: 900 } });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(pathToFileURL('DraftOtter.html').href);
await page.waitForFunction(() => document.body.classList.contains('ready'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const app = (fn, ...a) => page.evaluate(fn, ...a);
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(ok ? 'ok  ' : 'FAIL', name, info); };
const sec = () => app(() => { const s = window.DraftOtter.model.settings.section; return { on: s.on, axis: s.axis, offset: s.offset, flip: !!s.flip, plane: s.showPlane !== false }; });
const click = (sel, text) => app(([sel, text]) => [...document.querySelectorAll(sel)].find((b) => !text || b.textContent.trim() === text || (b.dataset.ax || '').toUpperCase() === text).click(), [sel, text]);

// a design opened from a file (this replaces the design's settings)
const json = await app(() => { const a = window.DraftOtter; a.model.doc.nodes = []; a.addShape('box'); const n = a.model.nodes[0]; n.params.w = 40; n.params.d = 30; n.params.h = 20; a.commit(); return a.model.serialize(); });
await app((json) => window.DraftOtter.openProject(new File([json], 'opened.lcad.json')), json);
await wait(500);
await app(() => window.DraftOtter.toggleSection());
await wait(200);
check('after opening a file, the section view turns on', (await sec()).on && await app(() => document.querySelector('#section-panel').style.display !== 'none'));
for (const ax of ['Y', 'Z', 'X']) {
	await click('#section-panel .sec-ax', ax);
	await wait(150);
	check(`the ${ax} button cuts across ${ax}`, (await sec()).axis === ax.toLowerCase() && await app((ax) => document.querySelector(`#section-panel .sec-ax[data-ax="${ax}"]`).classList.contains('on'), ax.toLowerCase()), JSON.stringify(await sec()));
}
await app(() => { const i = document.querySelector('#sec-val'); i.value = '7.5'; i.dispatchEvent(new Event('change')); });
check('typing a position moves the plane', (await sec()).offset === 7.5);
await click('#section-panel button', 'Center');
check('Center puts it back through the middle', Math.abs((await sec()).offset) < 1e-6, JSON.stringify(await sec()));
await app(() => document.querySelector('#sec-flip').click());
check('Flip keeps the other side', (await sec()).flip === true);
await app(() => document.querySelector('#sec-plane').click());
check('Plane hides the plane and its handles', (await sec()).plane === false);
// the cut is really applied in the view
check('…and the view is cut (clipping on)', await app(() => window.DraftOtter.vp.clipPlanes && window.DraftOtter.vp.clipPlanes.length > 0 && window.DraftOtter.vp.renderer.localClippingEnabled));

// another tab: the bar works on that design
const openedTab = await app(() => window.DraftOtter.tabIndex);
await app(() => window.DraftOtter.newTab());
await wait(500);
await app(() => { const a = window.DraftOtter; a.addShape('cylinder'); a.toggleSection(); });
await wait(200);
await click('#section-panel .sec-ax', 'Y');
check('in another tab the buttons act on that tab\'s design', (await sec()).axis === 'y' && (await sec()).on);
await app((i) => window.DraftOtter.switchTab(i), openedTab);
await wait(400);
check('…and the first tab keeps its own section settings', (await sec()).axis === 'x' && (await sec()).flip === true, JSON.stringify(await sec()) + ' tab ' + await app(() => window.DraftOtter.tabIndex));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'browser57: all passed');
process.exit(fails ? 1 : 0);
