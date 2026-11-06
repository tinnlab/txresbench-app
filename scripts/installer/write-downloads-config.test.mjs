#!/usr/bin/env node
// scripts/installer/write-downloads-config.test.mjs — TEST-IR-11 (PROV-IR-3).
//
// Every assertion DRIVES the real writer as a subprocess and reads its OWN
// exit status. The artifact JSON is the real `discover_artifacts` output over
// the fixture bundle (version 0.2.0); the fixture config is the repo's real
// `site/config.json` (schema v1) with `product.version` and the download-row
// tags moved to 0.2.0 — the state a release would be in BEFORE the writer
// fills the real values (landing-site DRIFT-1 ITEM-1 #2). No control ever
// writes the real config: every run targets a scratch copy.
//
//   node --test scripts/installer/write-downloads-config.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { discover_artifacts } from './lib/artifacts.mjs';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(SCRIPTS_DIR, '..', '..');
const WRITER = path.join(SCRIPTS_DIR, 'write-downloads-config.mjs');
const FIXTURE_BUNDLE = path.join(REPO, 'scripts/installer/fixtures/bundle');
const REAL_CONFIG = path.join(REPO, 'site/config.json');
const VERSION = '0.2.0';

const TMPDIRS = [];
process.on('exit', () => {
  for (const d of TMPDIRS) fs.rmSync(d, { recursive: true, force: true });
});

function scratch(prefix) {
  const base = process.env.TMPDIR || os.tmpdir();
  const dir = fs.mkdtempSync(path.join(base, prefix));
  TMPDIRS.push(dir);
  return dir;
}

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WRITER, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ status: code ?? -1, out }));
    child.on('error', (err) => resolve({ status: -1, out: String(err) }));
  });
}

/** The real ArtifactSet over the fixture bundle, as the pipeline would get it. */
function artifact_doc() {
  return discover_artifacts(FIXTURE_BUNDLE);
}

/** The repo config moved to the fixture release version (a pre-writer state). */
function release_config() {
  const cfg = JSON.parse(fs.readFileSync(REAL_CONFIG, 'utf8'));
  cfg.product.version = VERSION;
  for (const row of cfg.downloads) {
    row.url = row.url.replace(/\/app-v[^/]+\//, `/app-v${VERSION}/`);
  }
  return cfg;
}

// ── TEST-IR-11 / the four real rows ─────────────────────────────────────────────
test('TEST-IR-11 downloads[] becomes exactly the four rows with real url/size_mb/sha256 and the config copy preserved', async () => {
  const dir = scratch('txr-config-');
  const artifacts = path.join(dir, 'artifacts.json');
  fs.writeFileSync(artifacts, `${JSON.stringify(artifact_doc(), null, 1)}\n`);
  const config = path.join(dir, 'config.json');
  fs.writeFileSync(config, `${JSON.stringify(release_config(), null, 2)}\n`);

  const before = JSON.parse(fs.readFileSync(config, 'utf8'));
  const { schema, product, paper, stats, methods, system, links } = before;
  const r = await run(['--artifacts', artifacts, '--out', config]);
  assert.equal(r.status, 0, r.out);

  const after = JSON.parse(fs.readFileSync(config, 'utf8'));
  assert.equal(after.downloads.length, 4);
  assert.deepEqual(after.downloads.map((d) => [d.os, d.kind]), [
    ['macos', 'dmg'],
    ['windows', 'nsis'],
    ['linux', 'deb'],
    ['linux', 'appimage'],
  ]);
  for (const row of after.downloads) {
    assert.ok(row.label && row.detail, `${row.kind} row keeps the page copy`);
    assert.match(row.url, /^https:\/\/github\.com\/tinnlab\/txresbench-app\/releases\/download\/app-v0\.2\.0\//);
    assert.match(row.sha256, /^[0-9a-f]{64}$/);
    assert.ok(Number.isInteger(row.size_mb) && row.size_mb > 0);
  }
  // Values (label/detail) survived from the config's own rows, not invented.
  assert.deepEqual(
    after.downloads.map((d) => [d.label, d.detail]),
    before.downloads.map((d) => [d.label, d.detail]),
  );
  // The rows' url/size_mb/sha256 are the artifact set's values, computed per PROV-IR-3.
  const set = artifact_doc();
  for (const row of after.downloads) {
    const art = set.downloads.find((a) => a.os === row.os && a.kind === row.kind);
    assert.equal(row.url, `https://github.com/tinnlab/txresbench-app/releases/download/app-v${set.version}/${art.file}`);
    assert.equal(row.sha256, art.sha256);
    assert.equal(row.size_mb, Math.ceil(art.size_bytes / (1024 * 1024)));
  }
  // Every non-downloads key is preserved (values, schema, order).
  assert.equal(after.schema, schema);
  assert.deepEqual(after.product, product);
  assert.deepEqual(after.paper, paper);
  assert.deepEqual(after.stats, stats);
  assert.deepEqual(after.methods, methods);
  assert.deepEqual(after.system, system);
  assert.deepEqual(after.links, links);
  assert.deepEqual(Object.keys(after), Object.keys(before), 'key order unchanged');
});

test('TEST-IR-11 a product.version / artifacts version mismatch exits 1 naming both and writes nothing', async () => {
  const dir = scratch('txr-config-');
  const artifacts = path.join(dir, 'artifacts.json');
  fs.writeFileSync(artifacts, `${JSON.stringify(artifact_doc(), null, 1)}\n`);
  const config = path.join(dir, 'config.json');
  fs.writeFileSync(config, `${JSON.stringify(release_config(), null, 2)}\n`);

  // The release-config move is undone: config 0.1.0 vs artifacts 0.2.0.
  const doc = JSON.parse(fs.readFileSync(config, 'utf8'));
  doc.product.version = '0.1.0';
  fs.writeFileSync(config, `${JSON.stringify(doc, null, 2)}\n`);
  const before = fs.readFileSync(config);

  const r = await run(['--artifacts', artifacts, '--out', config]);
  assert.equal(r.status, 1);
  assert.match(r.out, /version mismatch/);
  assert.match(r.out, /0\.1\.0/);
  assert.match(r.out, /0\.2\.0/);
  assert.ok(fs.readFileSync(config).equals(before), 'the config file is untouched on a mismatch');
});

// ── TEST-IR-11 / negative controls: artifact set shape ─────────────────────────
test('TEST-IR-11 an artifact set outside the four combos is exit 1 naming the combo', async () => {
  const dir = scratch('txr-config-');
  const config = path.join(dir, 'config.json');
  fs.writeFileSync(config, `${JSON.stringify(release_config(), null, 2)}\n`);
  const r = await run(['--artifacts', path.join(dir, 'none.json'), '--out', config]);
  assert.equal(r.status, 1);
  assert.match(r.out, /not found/);

  const missing = artifact_doc();
  missing.downloads = missing.downloads.filter((d) => !(d.os === 'linux' && d.kind === 'deb'));
  const missingPath = path.join(dir, 'missing.json');
  fs.writeFileSync(missingPath, `${JSON.stringify(missing, null, 1)}\n`);
  const r2 = await run(['--artifacts', missingPath, '--out', config]);
  assert.equal(r2.status, 1);
  assert.match(r2.out, /exactly linux\/appimage, linux\/deb, macos\/dmg, windows\/nsis/);
  assert.ok(fs.readFileSync(config, 'utf8').includes('"0.2.0"'), 'config untouched');

  const extra = artifact_doc();
  extra.downloads.push({ os: 'windows', kind: 'rpm', file: 'x.rpm', size_bytes: 1, sha256: '0'.repeat(64) });
  const extraPath = path.join(dir, 'extra.json');
  fs.writeFileSync(extraPath, `${JSON.stringify(extra, null, 1)}\n`);
  const r3 = await run(['--artifacts', extraPath, '--out', config]);
  assert.equal(r3.status, 1);
  assert.match(r3.out, /windows\/rpm/);
  assert.match(r3.out, /outside the PROV-IR-3 matrix/);
});

test('TEST-IR-11 an artifact row with a bad sha256, size or file name is exit 1 naming the row', async () => {
  const dir = scratch('txr-config-');
  const config = path.join(dir, 'config.json');
  fs.writeFileSync(config, `${JSON.stringify(release_config(), null, 2)}\n`);

  const bad = artifact_doc();
  bad.downloads.find((d) => d.kind === 'dmg').sha256 = 'zz';
  const badPath = path.join(dir, 'bad.json');
  fs.writeFileSync(badPath, `${JSON.stringify(bad, null, 1)}\n`);
  const r = await run(['--artifacts', badPath, '--out', config]);
  assert.equal(r.status, 1);
  assert.match(r.out, /macos\/dmg/);
  assert.match(r.out, /sha256/);

  const sized = artifact_doc();
  sized.downloads.find((d) => d.kind === 'nsis').size_bytes = 0;
  const sizedPath = path.join(dir, 'sized.json');
  fs.writeFileSync(sizedPath, `${JSON.stringify(sized, null, 1)}\n`);
  const r2 = await run(['--artifacts', sizedPath, '--out', config]);
  assert.equal(r2.status, 1);
  assert.match(r2.out, /windows\/nsis/);
  assert.match(r2.out, /size_bytes/);
});

// ── TEST-IR-11 / negative controls: config row set ─────────────────────────────
test('TEST-IR-11 a config downloads[] that is not exactly the four combos is exit 1 naming the row', async () => {
  const dir = scratch('txr-config-');
  const artifacts = path.join(dir, 'artifacts.json');
  fs.writeFileSync(artifacts, `${JSON.stringify(artifact_doc(), null, 1)}\n`);

  const noLinux = release_config();
  noLinux.downloads = noLinux.downloads.filter((d) => !(d.os === 'linux' && d.kind === 'deb'));
  const noLinuxPath = path.join(dir, 'no-linux.json');
  fs.writeFileSync(noLinuxPath, `${JSON.stringify(noLinux, null, 2)}\n`);
  const r1 = await run(['--artifacts', artifacts, '--out', noLinuxPath]);
  assert.equal(r1.status, 1);
  assert.match(r1.out, /missing linux\/deb/);

  const fifth = release_config();
  fifth.downloads.push({ os: 'windows', kind: 'rpm', label: 'RPM', detail: 'x', url: 'x', size_mb: 0, sha256: '0'.repeat(64) });
  const fifthPath = path.join(dir, 'fifth.json');
  fs.writeFileSync(fifthPath, `${JSON.stringify(fifth, null, 2)}\n`);
  const r2 = await run(['--artifacts', artifacts, '--out', fifthPath]);
  assert.equal(r2.status, 1);
  assert.match(r2.out, /windows\/rpm/);
  assert.match(r2.out, /no artifact row/);
});
