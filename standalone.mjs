// Build dist/rafter.html: one self-contained file (app + three.js + pako inlined) that runs
// by double-clicking it, offline, with no web server. Fonts still come from Google Fonts
// when online and fall back to system fonts otherwise.
//
// Run:  node standalone.mjs        (needs Node 18+ and npm; fetches the build tools once)
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, '.standalone-cache');
const DEPS = { esbuild: '0.24.2', three: '0.160.0', pako: '2.1.0' }; // three/pako match the CDN versions in page.html

if (!existsSync(join(CACHE, 'node_modules', 'esbuild'))) {
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(join(CACHE, 'package.json'), JSON.stringify({ private: true, dependencies: DEPS }, null, 2));
  console.log('Installing build tools into .standalone-cache (one time)...');
  execSync('npm install --no-audit --no-fund --loglevel=error', { cwd: CACHE, stdio: 'inherit' });
}

const require = (await import('node:module')).createRequire(join(CACHE, 'package.json'));
const esbuild = require('esbuild');

const result = await esbuild.build({
  entryPoints: [join(HERE, 'app.js')],
  bundle: true,
  format: 'iife',
  minify: true,
  write: false,
  target: ['firefox115', 'chrome115', 'safari16'],
  nodePaths: [join(CACHE, 'node_modules')],
  legalComments: 'none',
  logLevel: 'warning',
});
const appJs = result.outputFiles[0].text;
// The engine worker, inlined as source and started from a blob URL (see startWorker in app.js).
const workerJs = (await esbuild.build({
  entryPoints: [join(HERE, 'engine-worker.js')],
  bundle: true, format: 'iife', minify: true, write: false,
  target: ['firefox115', 'chrome115', 'safari16'], legalComments: 'none', logLevel: 'warning',
})).outputFiles[0].text;
const pakoJs = readFileSync(join(CACHE, 'node_modules', 'pako', 'dist', 'pako.min.js'), 'utf8');

// Inline scripts must not contain a literal closing script tag.
const inline = (js) => js.replace(/<\/(script)/gi, '<\\/$1');

execSync('python3 build.py', { cwd: HERE, stdio: 'ignore' }); // make sure index.html is current
let html = readFileSync(join(HERE, 'index.html'), 'utf8');

// Fonts: inline the Latin subsets as data URIs so the page looks the same offline.
const fontLink = html.match(/<link href="(https:\/\/fonts\.googleapis\.com\/css2[^"]+)" rel="stylesheet">/);
if (!fontLink) throw new Error('standalone: Google Fonts link not found in page.html');
const fontCache = join(CACHE, 'fonts.css');
if (!existsSync(fontCache)) {
  console.log('Downloading fonts (one time)...');
  const ua = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' };
  const css = await (await fetch(fontLink[1].replace(/&amp;/g, '&'), { headers: ua })).text();
  // Keep only the /* latin */ blocks (the others are Cyrillic, Vietnamese, ...).
  const blocks = css.split(/(?=\/\* )/).filter((b) => b.startsWith('/* latin */'));
  let out = '';
  for (const b of blocks) {
    const url = b.match(/url\((https:[^)]+\.woff2)\)/)[1];
    const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
    out += b.replace(url, 'data:font/woff2;base64,' + buf.toString('base64'));
  }
  if (!out) throw new Error('standalone: no latin font blocks downloaded');
  writeFileSync(fontCache, out);
}
html = html.replace(/<link rel="preconnect"[^>]*>\n?/g, '').replace(fontLink[0], `<style>${readFileSync(fontCache, 'utf8')}</style>`);

const swaps = [
  [/<script type="importmap">[\s\S]*?<\/script>\n?/, ''],
  [/<script src="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/pako\/[^"]+"><\/script>/, () => `<script>${inline(pakoJs)}</script>`],
  [/<script type="module" src="app\.js"><\/script>/, () => `<script>window.__RAFTER_WORKER_SRC = ${inline(JSON.stringify(workerJs))};</script>\n<script>${inline(appJs)}</script>`],
];
for (const [re, rep] of swaps) {
  if (!re.test(html)) throw new Error('standalone: page.html no longer matches ' + re);
  html = html.replace(re, rep);
}

mkdirSync(join(HERE, 'dist'), { recursive: true });
writeFileSync(join(HERE, 'dist', 'rafter.html'), html);
console.log(`wrote dist/rafter.html (${(html.length / 1024).toFixed(0)} KB)`);
