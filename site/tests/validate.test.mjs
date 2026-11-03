/**
 * validate.test.mjs — landing-site ITEM-5 suite, contract-side assertions.
 * Plain node:test, zero deps (node builtins only). TESTS.md TEST-2 (config
 * schema v1 cases incl. version drift), TEST-3 (catalogue hosting contract),
 * TEST-4 (Tauri v2 update-feed wire shape), TEST-9 (stats band / chips /
 * paper band / system-requirements rendering), TEST-15 (download-link
 * contract). TEST-18's branch-diff assertion belongs to ITEM-6 (deploy.test.mjs).
 *
 * Every build here is fully hermetic: --out and --public point at scratch
 * dirs under site/tests/.tmp/<pid>/, so no test ever creates or removes
 * site/public or the publish root (the --public flag is the ITEM-4
 * --tauri-conf precedent, PLAN note k). Feed/catalogue fixtures are the
 * two files TEST-19 allows.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SITE = join(ROOT, 'site');
const SCRATCH = join(SITE, 'tests', '.tmp', `validate-${process.pid}`);

const GROUP_LABELS = {
  'response-call': 'Response call',
  'response-probability': 'Response probability',
  'static-risk': 'Static risk',
  'dynamic-risk': 'Dynamic risk',
};
const ALLOWED_LINK = /^https:\/\/(github\.com|tinnlab\.github\.io)\//;
const DOWNLOAD_URL = /^https:\/\/github\.com\/tinnlab\/txresbench-app\/releases\/(tag|download)\/app-v([0-9A-Za-z.+-]+)\/(.*)$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

function build(extra = []) {
  const r = spawnSync('node', ['scripts/build-landing-site.mjs', ...extra], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function sha256(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

function readCfg() {
  return JSON.parse(readFileSync(join(SITE, 'config.json'), 'utf8'));
}

function writeCfg(name, mutate) {
  const c = readCfg();
  mutate(c);
  const p = join(SCRATCH, name);
  writeFileSync(p, JSON.stringify(c, null, 2));
  return p;
}

/** build the committed config hermetically and return {code, html, out} */
function buildCommitted(name) {
  const out = join(SCRATCH, name);
  const pub = join(SCRATCH, `${name}-pub`);
  mkdirSync(pub, { recursive: true });
  const r = build(['--out', out, '--public', pub]);
  const html = r.code === 0 ? readFileSync(join(out, 'index.html'), 'utf8') : '';
  return { code: r.code, html, out, stderr: r.stderr, stdout: r.stdout };
}

before(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
});

after(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
test('TEST-2 config schema v1 cases; each failure names the field', () => {
  const ok = buildCommitted('test2-valid');
  assert.equal(ok.code, 0, `committed config builds: ${ok.stderr || ok.stdout}`);
  assert.ok(ok.html.length > 0, 'valid build renders a page');

  const cases = [
    ['missing downloads', (c) => { delete c.downloads; }, 'downloads'],
    ['empty downloads', (c) => { c.downloads = []; }, 'downloads'],
    ['empty product.version', (c) => { c.product.version = ''; }, 'product.version'],
    ['non-64-hex sha256', (c) => { c.downloads[0].sha256 = 'zz'; }, 'downloads[0].sha256'],
    ['version drift vs tauri.conf.json', (c) => { c.product.version = '0.2.0'; }, 'product.version'],
    ['downloads url foreign host', (c) => {
      c.downloads[0].url = 'https://evil.example.com/releases/download/app-v0.1.0/x.dmg';
    }, 'downloads[0].url'],
  ];
  for (const [name, mutate, field] of cases) {
    const p = writeCfg(`test2-${field.replace(/[^a-z0-9]/gi, '-')}.json`, mutate);
    const r = build(['--config', p, '--out', join(SCRATCH, 'test2-neg'), '--public', join(SCRATCH, 'test2-neg-pub')]);
    assert.equal(r.code, 1, `${name}: exits 1`);
    assert.ok(r.stderr.includes(field), `${name}: names the field (${field}): ${r.stderr.trim().split('\n')[0]}`);
  }

  // the drift case names both values
  const p = writeCfg('test2-drift.json', (c) => { c.product.version = '0.2.0'; });
  const drift = build(['--config', p, '--out', join(SCRATCH, 'test2-drift-out'), '--public', join(SCRATCH, 'test2-drift-pub')]);
  assert.equal(drift.code, 1);
  assert.ok(drift.stderr.includes('0.1.0') && drift.stderr.includes('0.2.0'), `drift names both versions: ${drift.stderr.trim().split('\n')[0]}`);

  // the drift source is hermetic: an unreadable tauri.conf fails closed (PLAN note h)
  const missing = build(['--tauri-conf', join(SCRATCH, 'no-such-tauri.json')]);
  assert.equal(missing.code, 1);
  assert.ok(missing.stderr.includes('missing'), `unreadable tauri.conf fails closed: ${missing.stderr.trim().split('\n')[0]}`);

  // a failing build never clobbers the previous publish root
  const out = join(SCRATCH, 'test2-noclobber');
  const pub = join(SCRATCH, 'test2-noclobber-pub');
  mkdirSync(pub, { recursive: true });
  assert.equal(build(['--out', out, '--public', pub]).code, 0);
  const before = sha256(join(out, 'index.html'));
  const bad = writeCfg('test2-noclobber.json', (c) => { c.product.version = '9.9.9'; });
  const r = build(['--config', bad, '--out', out, '--public', pub]);
  assert.equal(r.code, 1);
  assert.equal(sha256(join(out, 'index.html')), before, 'failed build leaves the last good publish byte-identical');
});

// ---------------------------------------------------------------------------
const CATALOGUE_VALID = {
  schema: 1,
  models: [
    {
      id: 'example-model',
      version: '1.0.0',
      url: 'https://github.com/tinnlab/txresbench-models/releases/download/app-v1.0.0/example-model.torch',
      size: 1024,
      sha256: 'a'.repeat(64),
    },
    {
      id: 'second',
      version: '2.0.0',
      url: 'https://tinnlab.github.io/txresbench-app/models/second.torch',
      size: 1,
    },
  ],
};

function withScratchPublic(name, file, content) {
  const pub = join(SCRATCH, name);
  rmSync(pub, { recursive: true, force: true });
  mkdirSync(pub, { recursive: true });
  if (file) {
    const target = join(pub, file);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content);
  }
  return pub;
}

test('TEST-3 catalogue hosting contract', () => {
  const src = join(SCRATCH, 'catalogue-valid.json');
  writeFileSync(src, JSON.stringify(CATALOGUE_VALID, null, 2));
  let pub = withScratchPublic('test3-valid', 'pretrained-catalogue.json', JSON.stringify(CATALOGUE_VALID, null, 2));
  const out = join(SCRATCH, 'test3-out');
  let r = build(['--out', out, '--public', pub]);
  assert.equal(r.code, 0, `valid catalogue builds: ${r.stderr || r.stdout}`);
  assert.equal(sha256(join(out, 'pretrained-catalogue.json')), sha256(src), 'catalogue published byte-identical');

  // allowed hosts only: github.com and tinnlab.github.io pass (fixture above),
  // any other host fails naming the host
  const foreign = JSON.parse(JSON.stringify(CATALOGUE_VALID));
  foreign.models[0].url = 'https://example.com/model.torch';
  pub = withScratchPublic('test3-foreign', 'pretrained-catalogue.json', JSON.stringify(foreign));
  r = build(['--out', join(SCRATCH, 'test3-out2'), '--public', pub]);
  assert.equal(r.code, 1, 'foreign catalogue host fails');
  assert.ok(/pretrained-catalogue\.json: \$\.models\[0\]\.url: host "example\.com" is outside the policy/.test(r.stderr),
    `names file, field and host: ${r.stderr.trim().split('\n')[0]}`);

  // unparseable http url fails naming the file
  const badUrl = JSON.parse(JSON.stringify(CATALOGUE_VALID));
  badUrl.models[0].url = 'http://[not-a-host';
  pub = withScratchPublic('test3-badurl', 'pretrained-catalogue.json', JSON.stringify(badUrl));
  r = build(['--out', join(SCRATCH, 'test3-out3'), '--public', pub]);
  assert.equal(r.code, 1);
  assert.ok(/not a parseable URL/.test(r.stderr), `names the unparseable url: ${r.stderr.trim().split('\n')[0]}`);

  // invalid JSON fails naming the file
  pub = withScratchPublic('test3-badjson', 'pretrained-catalogue.json', '{ not json');
  r = build(['--out', join(SCRATCH, 'test3-out4'), '--public', pub]);
  assert.equal(r.code, 1);
  assert.ok(/pretrained-catalogue\.json: not valid JSON/.test(r.stderr), `names file + violation: ${r.stderr.trim().split('\n')[0]}`);

  // non-object root fails naming the rule
  pub = withScratchPublic('test3-array', 'pretrained-catalogue.json', '[1,2,3]');
  r = build(['--out', join(SCRATCH, 'test3-out5'), '--public', pub]);
  assert.equal(r.code, 1);
  assert.ok(/root must be a single JSON object, got an array/.test(r.stderr), `names the root rule: ${r.stderr.trim().split('\n')[0]}`);

  // absence is valid: build succeeds and publishes no catalogue file
  pub = withScratchPublic('test3-absent', null, null);
  const outAbsent = join(SCRATCH, 'test3-out6');
  r = build(['--out', outAbsent, '--public', pub]);
  assert.equal(r.code, 0, `absent catalogue still builds: ${r.stderr || r.stdout}`);
  assert.ok(!existsSync(join(outAbsent, 'pretrained-catalogue.json')), 'no catalogue file published when absent');

  // the hosted surface holds only the two named feeds (PLAN note g)
  pub = withScratchPublic('test3-extra', 'extra.json', '{}');
  r = build(['--out', join(SCRATCH, 'test3-out7'), '--public', pub]);
  assert.equal(r.code, 1);
  assert.ok(/unexpected file in site\/public/.test(r.stderr) && r.stderr.includes('extra.json'),
    `unexpected file fails named: ${r.stderr.trim().split('\n')[0]}`);
});

// ---------------------------------------------------------------------------
function feedFixture(mutate) {
  const f = {
    version: '1.1.0',
    pub_date: '2026-10-26T12:00:00Z',
    notes: 'First public release.',
    platforms: {
      'linux-x86_64': {
        url: 'https://github.com/tinnlab/txresbench-app/releases/download/app-v1.1.0/txresbench-desktop_1.1.0_amd64.AppImage',
        signature: 'RWQd3U+1NTZRQN1uF5X0jRy8S6mG0F7iLkPq2tQ9vY4zB0kT2n1W0C9pLvF0JzA',
      },
    },
  };
  mutate?.(f);
  return JSON.stringify(f, null, 2);
}

test('TEST-4 Tauri v2 update-feed wire shape', () => {
  // valid shape copies verbatim
  let pub = withScratchPublic('test4-valid', 'updates/latest.json', feedFixture());
  let out = join(SCRATCH, 'test4-out');
  let r = build(['--out', out, '--public', pub]);
  assert.equal(r.code, 0, `valid feed builds: ${r.stderr || r.stdout}`);
  assert.equal(sha256(join(out, 'updates', 'latest.json')), sha256(join(pub, 'updates', 'latest.json')), 'feed published byte-identical');

  const cases = [
    ['unknown platform key', feedFixture((f) => { f.platforms['darwin-riscv64'] = { url: 'https://github.com/tinnlab/txresbench-app/releases/download/app-v1.1.0/x', signature: 'sig' }; }), /unknown platform key "darwin-riscv64"/],
    ['missing signature', feedFixture((f) => { delete f.platforms['linux-x86_64'].signature; }), /platforms\.linux-x86_64\.signature: must be a non-empty string/],
    ['empty url', feedFixture((f) => { f.platforms['linux-x86_64'].url = ''; }), /platforms\.linux-x86_64\.url: must be a non-empty string/],
    ['missing platforms', feedFixture((f) => { delete f.platforms; }), /platforms must be an object/],
    ['non-semver version', feedFixture((f) => { f.version = '1.0'; }), /version must be a semver string, got "1\.0"/],
    ['unknown top-level key', feedFixture((f) => { f.other = true; }), /unknown top-level key "other"/],
    ['foreign url host', feedFixture((f) => { f.platforms['linux-x86_64'].url = 'https://example.com/x.AppImage'; }), /host "example\.com" is outside the policy/],
    ['date-only pub_date', feedFixture((f) => { f.pub_date = '2026-10-26'; }), /pub_date must be an RFC3339 date-time with a zone offset/],
  ];
  for (let i = 0; i < cases.length; i += 1) {
    const [name, content, re] = cases[i];
    pub = withScratchPublic(`test4-neg${i}`, 'updates/latest.json', content);
    r = build(['--out', join(SCRATCH, `test4-out${i}`), '--public', pub]);
    assert.equal(r.code, 1, `${name}: exits 1`);
    assert.ok(re.test(r.stderr), `${name}: names the defect: ${r.stderr.trim().split('\n')[0]}`);
    assert.ok(r.stderr.includes('updates/latest.json'), `${name}: names the file`);
  }

  // absent feed is valid
  pub = withScratchPublic('test4-absent', null, null);
  out = join(SCRATCH, 'test4-out-absent');
  r = build(['--out', out, '--public', pub]);
  assert.equal(r.code, 0, `absent feed still builds: ${r.stderr || r.stdout}`);
  assert.ok(!existsSync(join(out, 'updates')), 'no updates/ published when absent');
});

// ---------------------------------------------------------------------------
test('TEST-9 stats band, chips, paper band, system requirements render from config', () => {
  const cfg = readCfg();
  const { code, html } = buildCommitted('test9-base');
  assert.equal(code, 0);

  const stats = [...html.matchAll(/<b class="stat-value">([^<]+)<\/b> ([a-z ]+)/g)].map((m) => [m[2].trim(), m[1]]);
  assert.equal(stats.length, 4, 'four stats rendered');
  assert.deepEqual(new Map(stats), new Map([
    ['methods', String(cfg.stats.methods)],
    ['datasets', String(cfg.stats.datasets)],
    ['patients', String(cfg.stats.patients)],
    ['kinds of prediction', String(cfg.stats.prediction_kinds)],
  ]), 'stats band values equal config.stats');

  const chips = [...html.matchAll(/<span class="chip"><span class="chip-id">([^<]+)<\/span><span class="chip-group">([^<]+)<\/span><\/span>/g)];
  assert.equal(chips.length, cfg.methods.length, 'one chip per config method');
  cfg.methods.forEach((m, i) => {
    assert.equal(chips[i][1], m.id, `chip ${i} id equals config.methods[${i}].id`);
    assert.equal(chips[i][2], GROUP_LABELS[m.group], `chip ${i} group label`);
  });
  assert.ok(html.includes(`All ${cfg.stats.methods}, with references`), 'chips-more counts from config.stats');

  // paper: null renders no band and no Paper/Cite links (DEC-11)
  assert.equal(cfg.paper, null, 'committed config hides the paper band');
  assert.ok(!html.includes('class="paper-band"'), 'no paper band with paper:null');
  assert.ok(!/>Paper<\/a>/.test(html), 'no nav Paper with paper:null');
  assert.ok(!/>Cite<\/a>/.test(html), 'no Cite link with paper:null');
  assert.ok(!html.includes('Read the paper'), 'no Read-the-paper link with paper:null');

  // a present paper renders the citation fields
  const paper = {
    author: 'Tinn Lab', title: 'TxResBench: benchmarked prediction of treatment response from serial blood biomarkers.',
    venue: 'Nature Methods', year: '2026', doi: '10.1038/s41592-2026-00000-x',
    cite_url: 'https://github.com/tinnlab/txresbench-app/blob/main/docs/txresbench-benchmark.md',
    bibtex_url: 'https://github.com/tinnlab/txresbench-app/blob/main/docs/txresbench-benchmark.bib',
  };
  const p = writeCfg('test9-paper.json', (c) => { c.paper = paper; });
  const out = join(SCRATCH, 'test9-paper-out');
  const pub = join(SCRATCH, 'test9-paper-pub');
  mkdirSync(pub, { recursive: true });
  const r = build(['--config', p, '--out', out, '--public', pub]);
  assert.equal(r.code, 0, r.stderr || r.stdout);
  const paperHtml = readFileSync(join(out, 'index.html'), 'utf8');
  assert.ok(paperHtml.includes('class="paper-band"'), 'present paper renders the band');
  for (const s of [paper.author, paper.title, paper.venue, paper.year, paper.doi]) {
    assert.ok(paperHtml.includes(s), `paper citation field renders: ${s}`);
  }
  assert.ok(/>Paper<\/a>/.test(paperHtml), 'nav Paper renders with a present paper');
  assert.ok(paperHtml.includes('>Cite</a>'), 'Cite link renders with a present paper');
  assert.ok(paperHtml.includes('Read the paper') && paperHtml.includes('Copy citation') && paperHtml.includes('>BibTeX</a>'),
    'paper band action links render');

  // system requirements sentence renders config values
  assert.ok(html.includes(`Needs ${cfg.system.memory_gb} GB memory and about ${cfg.system.disk_gb} GB of disk.`),
    'system-requirements sentence renders memory_gb/disk_gb');
});

// ---------------------------------------------------------------------------
test('TEST-15 download-link contract', () => {
  const cfg = readCfg();
  const { code, html } = buildCommitted('test15-base');
  assert.equal(code, 0);

  for (const [i, d] of cfg.downloads.entries()) {
    const m = DOWNLOAD_URL.exec(d.url);
    assert.ok(m, `downloads[${i}].url matches the release-tag pattern: ${d.url}`);
    assert.equal(m[2], cfg.product.version, `downloads[${i}].url tag equals product.version`);
    assert.ok(SHA256_RE.test(d.sha256), `downloads[${i}].sha256 is 64 lowercase hex`);
  }
  for (const [k, u] of Object.entries(cfg.links)) {
    assert.ok(ALLOWED_LINK.test(u), `links.${k} is an absolute https URL on github.com / tinnlab.github.io`);
  }

  const hero = /<a class="hero-primary" data-os="([^"]+)" href="([^"]+)"/.exec(html);
  assert.ok(hero, 'hero primary button rendered');
  assert.equal(hero[1], cfg.downloads[0].os, 'hero data-os equals downloads[0].os');
  assert.equal(hero[2], cfg.downloads[0].url, 'hero href equals downloads[0].url');

  const tiles = [...html.matchAll(/<a class="tile(?: tile-primary)?" data-os="([^"]+)" href="([^"]+)"/g)];
  assert.equal(tiles.length, cfg.downloads.length, 'one tile per downloads row');
  const pageOss = new Set();
  tiles.forEach((t, i) => {
    assert.equal(t[1], cfg.downloads[i].os, `tile ${i} data-os equals row os`);
    assert.equal(t[2], cfg.downloads[i].url, `tile ${i} href equals row url`);
    pageOss.add(t[1]);
  });
  pageOss.add(hero[1]);
  assert.deepEqual([...pageOss].sort(), [...new Set(cfg.downloads.map((d) => d.os))].sort(),
    'page data-os set equals the config os set');
});
