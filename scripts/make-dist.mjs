// Builds the end-user package: dist/DraftOtter.zip with the app (one self-contained HTML file), a short readme and
// the licenses of everything bundled inside it. No sources, tests or projects.
//   npm run dist
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
const out = path.join(root, 'dist', 'DraftOtter');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version || '1.0.0';

console.log('building DraftOtter …');
execSync('node build.mjs', { cwd: root, stdio: 'inherit' });

rmSync(path.join(root, 'dist'), { recursive: true, force: true });
mkdirSync(out, { recursive: true });
copyFileSync(path.join(root, 'LocalCAD.html'), path.join(out, 'DraftOtter.html'));

// ---------------------------------------------------------------- Claude connection (MCP helper + Claude Desktop extension)
const claudeOut = path.join(out, 'claude');
mkdirSync(claudeOut, { recursive: true });
copyFileSync(path.join(root, 'claude', 'localcad-mcp.mjs'), path.join(claudeOut, 'localcad-mcp.mjs'));
console.log('packing DraftOtter.mcpb …');
execSync(`npx mcpb pack claude "${path.join(claudeOut, 'DraftOtter.mcpb')}"`, { cwd: root, stdio: 'ignore' });
writeFileSync(path.join(claudeOut, 'README.txt'), `Connect Claude to DraftOtter
==========================

Claude (with your Claude subscription) can build and change designs in DraftOtter: describe a part and Claude adds
shapes, sketches and cuts, checks its work with screenshots, and can export STL / 3MF / STEP files. You see every
change live, and each one can be undone.

1. In DraftOtter: More (wrench icon) → Connect Claude → tick "Allow Claude to connect".
2. Set up Claude once:
   - Claude Desktop: double-click DraftOtter.mcpb (or drag it onto Claude Desktop → Settings → Extensions) and
     install it. It needs no other software.
   - Claude Code: run (Node.js 18 or newer required)
       claude mcp add localcad -- node "<this folder>/localcad-mcp.mjs"
3. Keep DraftOtter open while you chat, and ask for example:
   "Add a 60 × 40 × 3 mm plate with M3 countersunk holes 5 mm in from each corner."

Everything stays on this computer: DraftOtter and the helper talk over 127.0.0.1 only, and only while the box in
step 1 is ticked. Files Claude exports go to your Downloads folder unless you ask for another place (Claude
Desktop: set the folder in the extension's settings).
`.replace(/\n/g, '\r\n'));

// ---------------------------------------------------------------- readme for end users
const readme = `DraftOtter ${version}
=============

A precise CAD app for designing 3D-printable parts. It runs entirely in your web browser and works offline —
nothing is uploaded anywhere.

Getting started
---------------
1. Unzip this folder anywhere (for example your Documents folder).
2. Double-click DraftOtter.html. It opens in your web browser (Chrome or Edge recommended; Firefox works too).
3. Click a shape in the Shapes panel on the left to add it. Mark shapes as Hole and Group them with solids to cut.
   Press ? in the app for the keyboard shortcuts, or click the ? button at the top right.

Saving your work
----------------
- Your current design is saved automatically in the browser, so it is still there when you reopen DraftOtter.html.
- Use File → Save (Ctrl+S) to save a design file (.lcad.json) you can keep, back up or share. Open it again with
  File → Open (Ctrl+O), or drag it onto the window.
- Export for printing with the Export button (STL or 3MF), or as STEP for other CAD programs.

Notes
-----
- Keep DraftOtter.html wherever you like; it is the whole app. Your designs are separate files.
- The autosave lives in your browser: clearing the browser's site data removes it, so save important designs
  to files.

Working with Claude (optional)
------------------------------
Claude can design with you: it adds and changes shapes in DraftOtter while you watch. See claude/README.txt to set
it up (Claude Desktop: install claude/DraftOtter.mcpb; in DraftOtter: More → Connect Claude).

Third-party software
--------------------
DraftOtter includes open-source components and fonts; their licenses are in THIRD-PARTY-LICENSES.txt.
`;
writeFileSync(path.join(out, 'README.txt'), readme.replace(/\n/g, '\r\n'));

// ---------------------------------------------------------------- third-party licenses
const read = (p) => readFileSync(path.join(root, p), 'utf8').trim();
const licFile = (dir) => {
	const d = path.join(root, 'node_modules', dir);
	if (!existsSync(d)) return null;
	const f = readdirSync(d).find((x) => /^(licen[sc]e|copying)(\.(md|txt))?$/i.test(x));
	return f ? read(path.join('node_modules', dir, f)) : null;
};
const ver = (dir) => { try { return JSON.parse(read(path.join('node_modules', dir, 'package.json'))).version; } catch (e) { return ''; } };
const sections = [];
const add = (title, license, text) => sections.push(`${'='.repeat(78)}\n${title}\nLicense: ${license}\n${'='.repeat(78)}\n\n${text}\n`);

for (const [dir, lic, note] of [
	['three', 'MIT', 'https://threejs.org'],
	['three-mesh-bvh', 'MIT', 'https://github.com/gkjohnson/three-mesh-bvh'],
	['three-bvh-csg', 'MIT', 'https://github.com/gkjohnson/three-bvh-csg'],
	['manifold-3d', 'Apache-2.0', 'https://github.com/elalish/manifold'],
	['opentype.js', 'MIT', 'https://github.com/opentypejs/opentype.js'],
]) {
	const t = licFile(dir);
	if (!t) throw new Error('license text missing for ' + dir);
	add(`${dir} ${ver(dir)} — ${note}`, lic, t);
}
// mesh decoders used by GLB import (shipped with three.js)
const apache = licFile('manifold-3d'); // the Apache-2.0 license text
add('Draco 3D mesh decoder — https://github.com/google/draco (distributed with three.js)', 'Apache-2.0', `Copyright 2017 The Draco Authors.\n\n${apache}`);
add('meshoptimizer decoder — https://github.com/zeux/meshoptimizer (distributed with three.js)', 'MIT',
	`Copyright (C) 2016-2026, by Arseny Kapoulkine (arseny.kapoulkine@gmail.com)\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`);
// STEP / IGES import (LGPL): included as WebAssembly; source and relinking information
const occt = licFile('occt-import-js');
if (!occt) throw new Error('license text missing for occt-import-js');
add(`occt-import-js ${ver('occt-import-js')} (Open CASCADE Technology) — https://github.com/kovacsv/occt-import-js`, 'LGPL-2.1 (Open CASCADE Technology: LGPL-2.1 with the OCCT exception)',
	`DraftOtter uses this library, unmodified, to import STEP, IGES and BREP files. Its source code is available at\nhttps://github.com/kovacsv/occt-import-js and https://dev.opencascade.org. On request we will provide the\ninformation needed to replace this library with a modified version of it.\n\n${occt}`);
// Helvetiker (three.js typeface)
try {
	const h = JSON.parse(read('src/fonts/helvetiker_regular.typeface.json')).original_font_information || {};
	add('Helvetiker typeface (MgOpen) — distributed with three.js', 'MgOpen font license', `${h.copyright || ''}\n\n${(h.license_description || '').replace(/\r/g, '')}\n${h.license_url || ''}`);
} catch (e) { /* not bundled */ }
// fonts (Fontsource packages of Google Fonts families)
const fonts = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((d) => d.startsWith('@fontsource/'));
for (const f of fonts) {
	const t = licFile(f);
	if (!t) throw new Error('license text missing for ' + f);
	const j = JSON.parse(read(path.join('node_modules', f, 'package.json')));
	add(`Font: ${f.replace('@fontsource/', '')} (${ver(f)}, via Fontsource)`, j.license || 'OFL-1.1', t);
}
const header = `Third-party software and fonts included in DraftOtter\n\nDraftOtter bundles the components below into DraftOtter.html. Each is used under its own license, reproduced here.\n\n`;
writeFileSync(path.join(out, 'THIRD-PARTY-LICENSES.txt'), (header + sections.join('\n')).replace(/\r?\n/g, '\r\n'));

// ---------------------------------------------------------------- zip
const zip = path.join(root, 'dist', `DraftOtter-${version}.zip`);
if (process.platform === 'win32') {
	execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${out}' -DestinationPath '${zip}' -Force"`, { stdio: 'inherit' });
} else {
	execSync(`cd "${path.dirname(out)}" && zip -r "${zip}" DraftOtter`, { stdio: 'inherit' });
}
const kb = (p) => (statSync(p).size / 1024 / 1024).toFixed(2) + ' MB';
console.log(`\n${path.relative(root, zip)} (${kb(zip)})`);
for (const f of readdirSync(out, { recursive: true })) if (statSync(path.join(out, f)).isFile()) console.log('  DraftOtter/' + f.replace(/\\/g, '/') + '  ' + kb(path.join(out, f)));
