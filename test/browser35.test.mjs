// Stress check (FEA) in the app: cantilever beam vs beam theory, picking faces, results panel, deformed view.
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';
mkdirSync('test/shots', { recursive: true });
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 300000, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1500, height: 900 } });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(pathToFileURL('DraftOtter.html').href);
await page.waitForFunction(() => document.body.classList.contains('ready'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const app = (fn, ...a) => page.evaluate(fn, ...a);
const shot = (n) => page.screenshot({ path: `test/shots/${n}.png` });
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(ok ? 'ok  ' : 'FAIL', name, info); };

await app(() => {
	localStorage.clear(); const a = window.DraftOtter; a.model.doc.nodes = []; a.commit();
	a.addShape('box'); const b = a.model.nodes[0]; b.params.w = 100; b.params.d = 10; b.params.h = 10; b.pos = [0, 0, 5]; b.name = 'Beam'; a.commit(); a.setSelection([b.id]); a.frame();
	a.stressDialog();
});
await wait(400);
check('stress panel opens in "pick fixed faces" mode', await app(() => window.DraftOtter.tool === 'feapick' && /Fixed faces: 0/.test(document.querySelector('#fea-panel').textContent)));
// click the end faces: project a point on each end face (the near end from the current view, then rotate to see the other)
const clickFace = async (x, y, z, cam) => {
	await app(([cam]) => { const vp = window.DraftOtter.vp; vp.camera.position.set(...cam); vp.controls.target.set(0, 0, 5); vp.controls.update(); vp.render(); }, [cam]);
	const p = await app(([x, y, z]) => { const vp = window.DraftOtter.vp; vp.render(); return vp.project(vp.camera.position.clone().set(x, y, z)); }, [x, y, z]);
	const cv = await (await page.$('#viewport canvas')).boundingBox();
	await page.mouse.click(cv.x + p.x, cv.y + p.y);
	await wait(200);
};
await clickFace(-50, 1, 6, [-200, -60, 60]);
await app(() => window.DraftOtter.feaPick('load'));
await clickFace(50, 1, 6, [200, -60, 60]);
let st = await app(() => ({ f: window.DraftOtter.fea.fixed.length, l: window.DraftOtter.fea.loads.length, n: window.DraftOtter.fea.fixed[0] && window.DraftOtter.fea.fixed[0].normal.toArray().map((v) => +v.toFixed(3)) }));
check('clicking the end faces marks one fixed and one loaded face', st.f === 1 && st.l === 1 && st.n[0] === -1, JSON.stringify(st));
await app(() => { const F = window.DraftOtter.fea; F.force = 10; F.dir = '-z'; F.mat = 'PLA'; F.res = 'normal'; window.DraftOtter.showFeaPanel(); });
const t0 = Date.now();
await app(() => window.DraftOtter.runFea());
await page.waitForFunction(() => window.DraftOtter.fea && window.DraftOtter.fea.result, { timeout: 180000 });
const r = await app(() => { const R = window.DraftOtter.fea.result; return { disp: +R.maxDisp.toFixed(3), peak: +R.peak.toFixed(2), elements: R.elements, h: +R.vox.h.toFixed(2), panel: document.querySelector('#fea-panel').textContent }; });
const theory = 1.152;
check('cantilever deflection matches beam theory (±10%)', Math.abs(r.disp - theory) / theory < 0.1, `${r.disp} mm vs ${theory} mm (${r.elements} cubes of ${r.h} mm, ${Date.now() - t0} ms)`);
check('peak stress is close to the 6 MPa beam-theory root stress', r.peak > 3.5 && r.peak < 8, `${r.peak} MPa`);
check('PLA at 10 N is reported as strong enough', /Looks strong enough/.test(r.panel) && /safety factor/.test(r.panel), r.panel.slice(0, 200));
check('the part is shown in stress colors', await app(() => !!window.DraftOtter.feaResultObj && window.DraftOtter.vp.objs.get(window.DraftOtter.fea.node.id).visible === false));
await app(() => { const vp = window.DraftOtter.vp; vp.camera.position.set(40, -220, 80); vp.controls.target.set(0, 0, 5); vp.controls.update(); });
await wait(400);
await shot('300-stress-check');
// a much bigger load on a weaker material fails
await app(() => { const F = window.DraftOtter.fea; F.force = 120; F.mat = 'PETG'; F.res = 'coarse'; window.DraftOtter.runFea(); });
await page.waitForFunction(() => window.DraftOtter.fea.result && window.DraftOtter.fea.result.force === 120, { timeout: 180000 });
const r2 = await app(() => document.querySelector('#fea-panel').textContent);
check('120 N on PETG is flagged as likely to break', /Likely to bend permanently or break/.test(r2), r2.slice(-420));
await app(() => window.DraftOtter.closeFea());
check('closing restores the part', await app(() => !window.DraftOtter.feaResultObj && window.DraftOtter.vp.objs.get(window.DraftOtter.model.nodes[0].id).visible && !window.DraftOtter.feaMarkObj));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'browser35: all passed');
process.exit(fails ? 1 : 0);
