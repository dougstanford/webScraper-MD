/**
 * End-to-end smoke test. Serves a tiny hostile knowledge base from a local
 * HTTP server, runs the CLI against it, and checks what landed on disk.
 *
 *   node test/smoke.mjs
 *
 * No network, no browser, no CI. Exits non-zero on the first failed assertion.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { downloadAsset } from '../src/assets.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scrape.mjs');

// A 1x1 transparent PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const page = (title, body, extraHead = '') => `<!doctype html><html><head><title>${title}</title>
<meta property="og:site_name" content="Smoke &quot;KB&quot;">${extraHead}</head>
<body><nav><a href="/docs/a">A</a> <a href="/docs/b">B</a> <a href="/docs/c/">C</a></nav>
<main><article><h1>${title}</h1>${body}</article></main></body></html>`;

const LOREM = '<p>' + 'This is a paragraph of real prose so Readability has something to score. '.repeat(6) + '</p>';

const ROUTES = {
  '/robots.txt': { type: 'text/plain', body: 'User-agent: *\nDisallow: /docs/secret\n' },
  '/docs/a': {
    type: 'text/html',
    body: page('Alpha', `${LOREM}<p>See <a href="/docs/b">Beta</a> and <a href="/docs/c/">Gamma</a>, not <a href="/other/x">Other</a>.</p>
      <img src="/docs/pic.png" alt="pic"><img src="/docs/evil.md" alt="evil">`,
    '<meta name="date" content="not-a-date&#10;cssclasses: [evil]">'),
  },
  '/docs/b': { type: 'text/html', body: page('Beta', LOREM) },
  '/docs/c': { type: 'text/html', body: page('Gamma', `${LOREM}<a href="/docs/a#%E0">bad fragment back to Alpha</a>`) },
  '/docs/other-links': {
    type: 'text/html',
    body: page('Links', `${LOREM}<a href="/docs/secret">secret</a> <a href="/docs/r">redirect</a>`),
  },
  '/docs/secret': { type: 'text/html', body: page('Secret', LOREM) },
  '/docs/r': { status: 302, location: '/other/x' },
  '/other/x': { type: 'text/html', body: page('Offsite', LOREM) },
  '/docs/pic.png': { type: 'image/png', body: PNG },
  '/docs/evil.md': { type: 'text/markdown', body: '# not an image\n' },
  '/docs/tricky.md': { type: 'image/png', body: PNG },
};

const server = http.createServer((req, res) => {
  const key = req.url.replace(/\?.*$/, '').replace(/(.)\/$/, '$1');
  const route = ROUTES[key];
  if (!route) { res.writeHead(404); res.end('nope'); return; }
  if (route.status === 302) { res.writeHead(302, { Location: route.location }); res.end(); return; }
  res.writeHead(200, { 'Content-Type': route.type });
  res.end(route.body);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wsmd-smoke-'));
// Async on purpose: a synchronous spawn would block this process, and the
// server the CLI is talking to lives in this process.
const run = (...args) => new Promise((resolve) => {
  const child = spawn(process.execPath, [CLI, ...args, '--out', tmp, '--delay', '0']);
  let err = '';
  let out = '';
  child.stderr.on('data', (d) => { err += d; });
  child.stdout.on('data', (d) => { out += d; });
  child.on('close', (code) => resolve({ code, err, out }));
});
const ls = async (dir) => (await fs.readdir(dir).catch(() => [])).sort();

let passed = 0;
const check = async (name, fn) => { await fn(); passed += 1; console.log(`  ok  ${name}`); };

try {
  // --- Run 1: a clean crawl -------------------------------------------------
  const r1 = await run(`${origin}/docs/a`, '--crawl', '--assets', '--index', '--wikilinks');
  await check('clean crawl exits 0', () => assert.equal(r1.code, 0, r1.err));
  await check('three notes plus index written', async () => {
    assert.deepEqual(await ls(tmp), ['Alpha.md', 'Beta.md', 'Gamma.md', 'Smoke KB.md']);
  });
  const notes = await ls(tmp);
  assert.deepEqual(notes, ['Alpha.md', 'Beta.md', 'Gamma.md', 'Smoke KB.md']);

  const alpha = await fs.readFile(path.join(tmp, 'Alpha.md'), 'utf8');
  await check('frontmatter injection is neutralised', () => {
    assert.ok(!/^cssclasses/m.test(alpha), alpha);
    assert.match(alpha, /^published: "not-a-date cssclasses: \[evil\]"$/m);
  });
  await check('site name with quotes gives valid index YAML', async () => {
    const index = await fs.readFile(path.join(tmp, 'Smoke KB.md'), 'utf8');
    assert.match(index, /^description: "Index of 3 pages clipped from Smoke \\"KB\\""$/m);
  });
  await check('offsite link was not crawled', () => assert.ok(!notes.includes('Offsite.md')));
  await check('wikilinks rewritten, bad fragment survives', async () => {
    assert.match(alpha, /\[\[Beta\]\]/);
    const gamma = await fs.readFile(path.join(tmp, 'Gamma.md'), 'utf8');
    assert.match(gamma, /\[\[Alpha#%E0\|bad fragment back to Alpha\]\]/);
  });
  await check('no .md written into attachments (private host guard via CLI)', async () => {
    const files = await ls(path.join(tmp, 'attachments'));
    assert.ok(files.every((f) => !f.endsWith('.md')), files.join(','));
  });
  await check('skipped assets are reported, not counted as failures', () => {
    assert.match(r1.err, /image link\(s\) left remote/);
    assert.ok(!/failure\(s\)/.test(r1.err), r1.err);
  });

  // --- Run 2: same again, nothing may be overwritten --------------------------
  const r2 = await run(`${origin}/docs/a`, '--crawl', '--index');
  await check('re-run skips existing notes and index', () => {
    assert.equal(r2.code, 0, r2.err);
    assert.match(r2.err, /3 already existed/);
    assert.match(r2.err, /already exists; --overwrite/);
  });

  // --- Run 3: robots block and out-of-scope redirect are failures ------------
  const r3 = await run(`${origin}/docs/other-links`, '--crawl', '--scope', `${origin}/docs/`);
  await check('robots and redirect failures give exit 2', () => {
    assert.equal(r3.code, 2, r3.err);
    assert.match(r3.err, /Disallowed by robots\.txt/);
    assert.match(r3.err, /Redirected out of scope/);
    assert.match(r3.err, /2 failure\(s\)/);
  });

  // --- Run 4: bad flags -----------------------------------------------------
  const r4 = await run(`${origin}/docs/a`, '--depth', 'lots');
  await check('bad numeric flag fails fast', () => {
    assert.equal(r4.code, 1);
    assert.match(r4.err, /--depth needs a whole number/);
  });

  // --- Asset guards, called directly to get past the private-host check -------
  const assetDir = path.join(tmp, 'direct-assets');
  const taken = new Set();
  const dl = (p) => downloadAsset(`${origin}${p}`, { dir: assetDir, taken, userAgent: 'smoke', allowPrivateHosts: true });
  await check('image with image/png is stored', async () => assert.deepEqual(await dl('/docs/pic.png'), { name: 'pic.png', wrote: true }));
  await check('text/markdown response is skipped', async () => {
    await assert.rejects(dl('/docs/evil.md'), (e) => e.skip && /not an image/.test(e.message));
  });
  await check('extension follows content type, not the URL', async () => {
    assert.deepEqual(await dl('/docs/tricky.md'), { name: 'tricky.png', wrote: true });
  });
  const direct = await ls(assetDir);
  assert.deepEqual(direct, ['pic.png', 'tricky.png']);

  console.log(`\nsmoke: ${passed} checks passed`);
} finally {
  server.close();
  await fs.rm(tmp, { recursive: true, force: true });
}
