/**
 * build.test.mjs — landing-site ITEM-5 suite, build-side assertions.
 * Plain node:test, zero deps (node builtins only). TESTS.md TEST-1 (build
 * from clean + board-example-leak detector), TEST-5 (zero-outbound page),
 * TEST-6 (section/anchor + link-resolution assertions), TEST-10 (canonical
 * URLs, byte-determinism), TEST-16 (the suite itself is self-contained and
 * green), TEST-19 (no data files; page numbers equal config values).
 *
 * Run: node --test 'site/tests/*.test.mjs'   (from the repo root)
 *
 * The suite writes its scratch fixtures under site/tests/.tmp/<pid>/ —
 * inside site/ (TEST-16), gitignored, and removed again in after().
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SITE = join(ROOT, 'site');
const DIST = join(SITE, 'dist');
const SCRATCH = join(SITE, 'tests', '.tmp', `build-${process.pid}`);

function build(extra = []) {
  const r = spawnSync('node', ['scripts/build-landing-site.mjs', ...extra], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function page() {
  return readFileSync(join(DIST, 'index.html'), 'utf8');
}

function sha256(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

function treeMap(dir) {
  const out = new Map();
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      for (const [rel, hash] of treeMap(p)) out.set(join(name, rel), hash);
    } else {
      out.set(name, sha256(p));
    }
  }
  return out;
}

/**
 * The board's design examples (INV-6) — exact strings, so the scan cannot
 * trip on text the page legitimately carries (e.g. the footer's
 * "PolyForm Noncommercial 1.0.0 ·" is a TEST-6 requirement; a naive
 * "no 1.0.0" rule would contradict it — DRIFT-1 ITEM-4 #5).
 */
const BOARD_EXAMPLES = [
  '1.0.0 · 310 MB',            // hero sub-line example
  'Apple silicon · version 1.0.0', // hero sub-line suffix example
  '310 MB · SHA-256',          // macOS tile example
  '290 MB · SHA-256',          // Windows tile example
  '330 MB · SHA-256',          // Linux tile example
  '0 MB',                      // pre-release rows must not claim a size
  'doi:10.0000',               // paper-band example citation
  'Journal, Year',             // paper-band example venue
  'Authors. ',                 // paper-band example author
  '>38</b> methods',           // stats-band example
  '>50</b> datasets',          // stats-band example
  '>3,522</b> patients',       // stats-band example
  '3,522',                     // stats-band example, rendered
  'All 38, with references',   // chips-more example
  'Version 1.0.0',             // Download section example
  'dynforest',                 // board chip id not in the published census
  'flirti',                    // board chip id not in the published census
];

const ALLOWED_HOSTS = ['github.com', 'tinnlab.github.io'];
const SECTION_HEADINGS = [
  ['see', 'See it'],
  ['what', 'What you can do'],
  ['methods', 'Methods included'],
  ['download', 'Download'],
  ['privacy', 'Privacy'],
];
const RESEARCH_NOTICE = "For research. Predictions are not for deciding a patient's treatment.";

test('TEST-1 build from clean + board-example-leak detector', () => {
  rmSync(DIST, { recursive: true, force: true }); // build-from-clean
  const r = build();
  assert.equal(r.code, 0, `build exit ${r.code}: ${r.stderr || r.stdout}`);
  assert.ok(existsSync(join(DIST, 'index.html')), 'site/dist/index.html exists after a clean build');
  const html = page();
  for (const [i, token] of BOARD_EXAMPLES.entries()) {
    assert.ok(!html.includes(token), `board design example must not leak (string ${i + 1}: ${JSON.stringify(token)})`);
  }
  assert.ok(!/\{\{\s*[a-zA-Z0-9_.]+\s*\}\}/.test(html), 'no unsubstituted {{token}} remains');
  assert.ok(!html.includes('<!--::'), 'no unsubstituted <!--::MARKER::--> remains');
});

test('TEST-5 zero-outbound page (no script, no third-party requests)', () => {
  const html = page();
  assert.ok(!/<script/i.test(html), 'page contains no <script element (zero-JS promise)');
  assert.ok(!/<iframe|<object|<embed/i.test(html), 'page contains no embed/object/iframe');

  const stylesheet = /<link[^>]+rel="stylesheet"[^>]*>/i.exec(html);
  assert.ok(stylesheet, 'page links its stylesheet');
  assert.ok(!/href="https?:\/\//i.test(stylesheet[0]), 'stylesheet link is local, not a CDN URL');
  assert.ok(!/<link[^>]+rel="(?:preconnect|dns-prefetch)"/i.test(html), 'no preconnect/dns-prefetch hints');

  // every http(s):// literal on the page must be an allowed user-opened link
  const literals = [...html.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((m) => m[0]);
  assert.ok(literals.length > 0, 'page carries its allowed links');
  for (const lit of literals) {
    const host = new URL(lit).hostname.toLowerCase();
    assert.ok(
      ALLOWED_HOSTS.includes(host),
      `http(s) literal outside the two-host policy: ${lit} (host ${host})`,
    );
  }

  // src/href attributes: relative-to-assets or an allowed absolute URL
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const v = m[1];
    if (/^(?:https?:)?\/\//i.test(v)) continue; // checked above
    if (v.startsWith('#')) continue;
    assert.ok(!v.startsWith('/'), `absolute-path reference (not publishable): ${v}`);
    assert.ok(!v.startsWith('..'), `reference escaping the publish root: ${v}`);
  }
  const imgs = [...html.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(imgs.length >= 4, 'board imagery referenced');
  assert.ok(imgs.every((s) => s.startsWith('assets/') && !/^https?:/i.test(s)), `no remote <img src> (${imgs.join(', ')})`);

  const css = readFileSync(join(DIST, 'styles.css'), 'utf8');
  assert.ok(!/url\(\s*['"]?https?:/i.test(css), 'stylesheet loads no remote fonts');
  assert.ok(!/url\(\s*['"]?\/\//i.test(css), 'stylesheet has no protocol-relative url()');
});

test('TEST-6 section anchors, board wording, anchor + file resolution', () => {
  const html = page();
  assert.ok(existsSync(join(DIST, 'styles.css')), 'styles.css copied into dist');

  // design sections at their anchor ids, with the board's headings (INV-7)
  for (const [id, heading] of SECTION_HEADINGS) {
    assert.ok(html.includes(`id="${id}"`), `section #${id} present`);
    const re = new RegExp(`<section[^>]*id="${id}"[^>]*>[\\s\\S]*?<h2[^>]*>${heading}</h2>`);
    assert.ok(re.test(html), `#${id} heading "${heading}" in the design wording`);
  }
  const noticeCount = html.split(RESEARCH_NOTICE).length - 1;
  assert.equal(noticeCount, 1, `research notice appears exactly once (got ${noticeCount})`);
  assert.ok(html.includes('PolyForm Noncommercial 1.0.0'), 'footer carries the PolyForm Noncommercial 1.0.0 notice');
  assert.ok(html.includes('>Licence</a>'), 'footer Licence link rendered');
  assert.ok(html.includes('Third-party notices'), 'footer Third-party notices link rendered');

  // every internal anchor resolves to an existing id
  for (const m of html.matchAll(/href="#([^"]+)"/g)) {
    assert.ok(html.includes(`id="${m[1]}"`), `anchor href="#${m[1]}" resolves to an existing id`);
  }

  // every relative file reference exists in dist/ (page + stylesheet)
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((v) => !v.startsWith('#') && !/^https?:/i.test(v) && !/^\/\//.test(v));
  for (const ref of refs) {
    const resolved = normalize(join(DIST, ref));
    assert.ok(resolved.startsWith(normalize(DIST)), `reference escapes dist/: ${ref}`);
    assert.ok(existsSync(resolved), `dist file exists for reference: ${ref}`);
  }
  const css = readFileSync(join(DIST, 'styles.css'), 'utf8');
  for (const m of css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
    const ref = m[1];
    const resolved = normalize(join(DIST, dirname('styles.css'), ref));
    assert.ok(resolved.startsWith(normalize(DIST)), `stylesheet reference escapes dist/: ${ref}`);
    assert.ok(existsSync(resolved), `dist file exists for stylesheet reference: ${ref}`);
  }
});

test('TEST-10 canonical URLs, no identifiers, byte-deterministic output', () => {
  const urls = build(['--print-urls']).stdout.trim().split('\n');
  assert.deepEqual(urls, [
    'https://tinnlab.github.io/txresbench-app/',
    'https://tinnlab.github.io/txresbench-app/updates/latest.json',
    'https://tinnlab.github.io/txresbench-app/pretrained-catalogue.json',
  ], '--print-urls prints exactly LANDING, FEED, CATALOGUE');
  for (const u of urls) assert.ok(!u.includes('?'), `stable URL carries no query string: ${u}`);
  const html = page();
  const withQuery = [...html.matchAll(/(?:src|href|content)="([^"]*)"/g)].map((m) => m[1]).filter((v) => v.includes('?'));
  assert.deepEqual(withQuery, [], 'no query-string variants in page references');

  // deterministic build: two consecutive builds of the same tree are identical
  const args = ['--out', join(SCRATCH, 'det-1'), '--public', join(SCRATCH, 'pub')];
  const args2 = ['--out', join(SCRATCH, 'det-2'), '--public', join(SCRATCH, 'pub')];
  mkdirSync(join(SCRATCH, 'pub'), { recursive: true });
  const r1 = build(args);
  const r2 = build(args2);
  assert.equal(r1.code, 0, r1.stderr || r1.stdout);
  assert.equal(r2.code, 0, r2.stderr || r2.stdout);
  const t1 = treeMap(join(SCRATCH, 'det-1'));
  const t2 = treeMap(join(SCRATCH, 'det-2'));
  assert.deepEqual([...t1.keys()].sort(), [...t2.keys()].sort(), 'same file set in two builds');
  for (const [rel, hash] of t1) assert.equal(t2.get(rel), hash, `byte-identical across builds: ${rel}`);
});

test('TEST-19 no data files; page numbers equal config values', () => {
  // committed tree only (git ls-files): runtime scratch never pollutes this
  const ls = spawnSync('git', ['ls-files', 'site'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(ls.status, 0, 'git ls-files runs from the repo root');
  const files = ls.stdout.trim().split('\n').filter(Boolean);
  const tabular = files.filter((f) => /\.(csv|xlsx|parquet)$/i.test(f));
  assert.deepEqual(tabular, [], `no tabular data file under site/ (${tabular.join(', ')})`);
  const json = files.filter((f) => f.endsWith('.json'));
  const allowed = new Set([
    'site/config.json',
    'site/public/pretrained-catalogue.json',
    'site/public/updates/latest.json',
  ]);
  for (const f of json) {
    assert.ok(allowed.has(f), `only config.json and the two machine feeds are .json under site/ (got ${f})`);
  }

  const cfg = JSON.parse(readFileSync(join(SITE, 'config.json'), 'utf8'));
  const html = page();

  // stats band numbers equal config.stats
  const stats = new Map(
    [...html.matchAll(/<b class="stat-value">([^<]+)<\/b> ([a-z ]+)/g)].map((m) => [m[2].trim(), m[1]]),
  );
  assert.equal(stats.get('methods'), String(cfg.stats.methods), 'methods stat equals config');
  assert.equal(stats.get('datasets'), String(cfg.stats.datasets), 'datasets stat equals config');
  assert.equal(stats.get('patients'), String(cfg.stats.patients), 'patients stat equals config');
  assert.equal(stats.get('kinds of prediction'), String(cfg.stats.prediction_kinds), 'prediction_kinds stat equals config');
  assert.equal(stats.size, 4, 'no extra numeric claims in the stats band');

  // each download tile's size claim equals its row (no other numeric claims)
  const tiles = [...html.matchAll(/<a class="tile(?: tile-primary)?" data-os="([^"]+)"[^>]*><div class="tile-os">[^<]+<\/div><div class="tile-detail">[^<]+<\/div><div class="tile-meta">([^<]+)<\/div><\/a>/g)];
  assert.equal(tiles.length, cfg.downloads.length, 'one tile per downloads row');
  cfg.downloads.forEach((d, i) => {
    const expected = Number(d.size_mb) > 0 ? `${d.size_mb} MB · SHA-256` : 'SHA-256';
    assert.equal(tiles[i][2], expected, `tile ${i} (${d.os}) size claim equals config.size_mb`);
  });
});

test('TEST-16 the suite is self-contained and green', { timeout: 120000 }, () => {
  // no dependencies outside the node: builtins
  for (const f of readdirSync(join(SITE, 'tests')).filter((f) => f.endsWith('.mjs'))) {
    const src = readFileSync(join(SITE, 'tests', f), 'utf8');
    for (const m of src.matchAll(/from\s+'([^']+)'/g)) {
      const spec = m[1];
      assert.ok(spec.startsWith('node:'), `${f}: import outside node: builtins (${spec})`);
    }
    // needle spelled with unicode escapes so the scan does not match itself
    assert.ok(!src.includes('\u002fdata\u002f') && !src.includes('\u002ftmp\u002f'),
      `${f}: no absolute fixture paths outside the repo`);
  }
  // no fixtures outside site/ (scratch root lives in site/tests/.tmp/<pid>)
  assert.ok(SCRATCH.startsWith(join(SITE, 'tests')), 'scratch root is inside site/tests');

  // and the whole suite itself passes (this file is the last test, so the
  // nested run cannot race this file's own builds; TXR_TEST16_INNER stops
  // the recursion one level down).
  if (process.env.TXR_TEST16_INNER === '1') return;
  // A genuine gate run. node's test runner inherits NODE_TEST_CONTEXT from
  // the enclosing test file and then refuses to run anything ("node:test
  // run() is being called recursively") — that would make this assertion
  // vacuous. Removing it spawns a real `node --test` run; TXR_TEST16_INNER
  // stops the recursion one level down.
  const env = { ...process.env, TXR_TEST16_INNER: '1' };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync('node', ['--test', 'site/tests/*.test.mjs'], {
    cwd: ROOT,
    encoding: 'utf8',
    env,
  });
  assert.equal(r.status, 0, `suite under node --test site/tests/*.test.mjs fails:\n${r.stderr || r.stdout}`);
});

test('cleanup: the suite leaves no scratch behind', () => {
  rmSync(SCRATCH, { recursive: true, force: true });
});
