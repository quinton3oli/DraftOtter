// Photoreal render: the dialog path-traces the design (tiny and few samples here — software graphics are slow), the
// picture shows the part on the backdrop, Save PNG downloads it, changing the material renders again, closing stops.
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 600000, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1500, height: 900 } });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(pathToFileURL('DraftOtter.html').href);
await page.waitForFunction(() => document.body.classList.contains('ready'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(ok ? 'ok  ' : 'FAIL', name, info); };

await page.evaluate(() => {
	localStorage.clear();
	const a = window.DraftOtter; a.model.doc.nodes = []; a.model.doc.name = 'Render test';
	a.addShape('box'); const b = a.model.nodes[0]; b.color = '#e8613a'; Object.assign(b.params, { w: 30, d: 30, h: 30, radius: 4 }); b.pos = [0, 0, 15];
	a.commit(); a.setSelection([]); a.vp.setView('iso');
});
await wait(800);
await page.evaluate(() => window.DraftOtter.frame());
await wait(800);
await page.evaluate(() => window.DraftOtter.renderDialog({ samples: 3, width: 160, height: 100, prefs: { material: 'matte', backdrop: 'light' } }));
await page.waitForFunction(() => window.DraftOtter.renderState && window.DraftOtter.renderState.done, { timeout: 300000, polling: 500 });
const pic = await page.evaluate(() => {
	const st = window.DraftOtter.renderState, c = st.sh.renderer.domElement;
	// read the picture back through a 2D canvas: the middle (the part) is orange, the corners (backdrop) are light gray
	const cv = document.createElement('canvas'); cv.width = c.width; cv.height = c.height;
	const g = cv.getContext('2d'); g.drawImage(c, 0, 0);
	const px = (x, y) => [...g.getImageData(x, y, 1, 1).data];
	const avg = (x0, y0, x1, y1) => { const d = g.getImageData(x0, y0, x1 - x0, y1 - y0).data; let r = 0, gg = 0, b = 0, n = 0; for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; n++; } return [r / n, gg / n, b / n].map(Math.round); };
	return { size: [c.width, c.height], middle: avg(70, 40, 90, 60), corner: avg(0, 0, 12, 8), status: document.querySelector('#rn-status').textContent };
});
check('the render finishes at the chosen size', pic.size.join() === '160,100' && /^Done — 3 samples/.test(pic.status), JSON.stringify(pic));
check('…showing the part in its color (orange in the middle) on the light studio backdrop', pic.middle[0] > pic.middle[2] + 40 && pic.corner.every((v) => v > 150), JSON.stringify(pic));

const saved = await page.evaluate(async () => {
	let got = null;
	const orig = URL.createObjectURL;
	URL.createObjectURL = (blob) => { got = blob; return orig.call(URL, new Blob([])); };
	try {
		[...document.querySelectorAll('.modal button')].find((b) => b.textContent === 'Save PNG').click();
		for (let i = 0; i < 50 && !got; i++) await new Promise((r) => setTimeout(r, 100));
	} finally { URL.createObjectURL = orig; }
	if (!got) return null;
	const u = new Uint8Array(await got.arrayBuffer());
	return { type: got.type, png: u[1] === 0x50 && u[2] === 0x4e && u[3] === 0x47, size: u.length, open: !!document.querySelector('.render-form') };
});
check('Save PNG downloads the picture (and keeps the render open)', saved && saved.png && saved.open, JSON.stringify(saved));

// another material renders again
await page.evaluate(() => { const s = document.querySelector('#rn-mat'); s.value = 'metal'; s.dispatchEvent(new Event('change')); });
await wait(300);
const again = await page.evaluate(() => ({ done: window.DraftOtter.renderState.done, pref: JSON.parse(localStorage.getItem('draftotter-render') || '{}').material }));
check('changing the material starts a new render (and is remembered)', again.done === false && again.pref === 'metal', JSON.stringify(again));
await page.waitForFunction(() => window.DraftOtter.renderState.done, { timeout: 300000, polling: 500 });

// closing stops the render (the renderer is kept, nothing is thrown away)
const firstRenderer = await page.evaluate(() => (window.__sh = window.DraftOtter.renderState.sh, true));
await page.evaluate(() => [...document.querySelectorAll('.modal button')].find((b) => b.textContent === 'Close').click());
await wait(200);
check('closing stops it', await page.evaluate(() => !window.DraftOtter.renderState.alive && !document.querySelector('.render-form')));

// opening it again reuses the prepared renderer (no new shader to prepare), and closing mid-render is instant
const t0 = Date.now();
await page.evaluate(() => window.DraftOtter.renderDialog({ samples: 500, width: 320, height: 200, prefs: { material: 'glossy', backdrop: 'dark' } }));
await page.waitForFunction(() => { const st = window.DraftOtter.renderState; return st && st.sceneReady && !st.done && st.sh.tracer.samples > 0.2; }, { timeout: 300000, polling: 200 });
const reopenS = (Date.now() - t0) / 1000;
check('opening it again reuses the same renderer, and the picture starts quickly', firstRenderer && await page.evaluate(() => window.DraftOtter.renderState.sh === window.__sh) && reopenS < 30, reopenS + ' s');
// changing a setting mid-render updates in place: the page is never stuck for long
const stall = await page.evaluate(async () => {
	let worst = 0, last = performance.now();
	const tick = setInterval(() => { const t = performance.now(); worst = Math.max(worst, t - last); last = t; }, 10);
	const s = document.querySelector('#rn-bg'); s.value = 'light'; s.dispatchEvent(new Event('change'));
	const m = document.querySelector('#rn-mat'); m.value = 'resin'; m.dispatchEvent(new Event('change'));
	await new Promise((r) => setTimeout(r, 1500));
	clearInterval(tick);
	return Math.round(worst);
});
check('changing the backdrop and material mid-render never locks the page (no new shader)', stall < 1000 && await page.evaluate(() => window.DraftOtter.renderState.sh === window.__sh), stall + ' ms longest pause');
const closeMs = await page.evaluate(() => { const t0 = performance.now(); [...document.querySelectorAll('.modal button')].find((b) => b.textContent === 'Close').click(); return performance.now() - t0; });
check('closing during a render closes the window right away', closeMs < 150 && await page.evaluate(() => !document.querySelector('.render-form')), closeMs.toFixed(1) + ' ms');

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'browser65: all passed');
process.exit(fails ? 1 : 0);
