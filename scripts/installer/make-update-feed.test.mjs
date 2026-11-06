#!/usr/bin/env node
// scripts/installer/make-update-feed.test.mjs — TEST-IR-9/10 (PROV-IR-2) +
// TEST-IR-18 (the cross-node PACT check against landing-site's hosting
// contract, CONS-IR-2).
//
// Every assertion DRIVES the real writer as a subprocess and reads its OWN
// exit status. The fixture bundle tree + the fixture app manifest carry
// version 0.2.0; the repo's real `tauri.conf.json` says 0.1.0, so the
// DEC-13 default check is proven from both sides (fixture manifest passes,
// repo manifest refuses naming both versions).
//
// TEST-IR-18 drops the emitted feed into the REAL hosting path
// (`site/public/updates/latest.json`), runs the real site build
// (`scripts/build-landing-site.mjs`, the PROV-5 validator), mutates the feed
// (unknown platform key, empty signature) and asserts the build refuses
// naming the file — and restores the tree in a `finally` either way.
//
//   node --test scripts/installer/make-update-feed.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(SCRIPTS_DIR, '..', '..');
const WRITER = path.join(SCRIPTS_DIR, 'make-update-feed.mjs');
const BUILD_SITE = path.join(REPO, 'scripts/build-landing-site.mjs');
const FIXTURE_BUNDLE = path.join(REPO, 'scripts/installer/fixtures/bundle');
const FIXTURE_TAURI_CONF = path.join(REPO, 'scripts/installer/fixtures/tauri-app-conf-0.2.0.json');
const VERSION = '0.2.0';

const SITE_UPDATES = path.join(REPO, 'site/public/updates/latest.json');
const SITE_DIST = path.join(REPO, 'site/dist');
const REAL_TAURI_CONF = path.join(REPO, 'src-app/desktop/tauri/tauri.conf.json');

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

/** Run a script as a subprocess; resolves with its own status + output. */
function run(script, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ status: code ?? -1, out }));
    child.on('error', (err) => resolve({ status: -1, out: String(err) }));
  });
}

/** The fixture bundle's updater files: arg-name -> path. */
function fixture_files() {
  return {
    appimage: path.join(FIXTURE_BUNDLE, 'appimage', 'TxResBench_0.2.0_amd64.AppImage'),
    appimageSig: path.join(FIXTURE_BUNDLE, 'appimage', 'TxResBench_0.2.0_amd64.AppImage.sig'),
    darwinApp: path.join(FIXTURE_BUNDLE, 'macos', 'TxResBench_0.2.0_universal.app.tar.gz'),
    darwinSig: path.join(FIXTURE_BUNDLE, 'macos', 'TxResBench_0.2.0_universal.app.tar.gz.sig'),
    nsis: path.join(FIXTURE_BUNDLE, 'nsis', 'TxResBench_0.2.0_x64-setup.exe'),
    nsisSig: path.join(FIXTURE_BUNDLE, 'nsis', 'TxResBench_0.2.0_x64-setup.exe.sig'),
  };
}

/** The full arg set for the fixture bundle, with a per-test --out. */
function feed_args(out, extra = []) {
  const f = fixture_files();
  return [
    '--version', VERSION,
    '--appimage', f.appimage,
    '--appimage-sig', f.appimageSig,
    '--darwin-app', f.darwinApp,
    '--darwin-sig', f.darwinSig,
    '--nsis', f.nsis,
    '--nsis-sig', f.nsisSig,
    '--tauri-conf', FIXTURE_TAURI_CONF,
    '--out', out,
    ...extra,
  ];
}

const RELEASE_PREFIX = `https://github.com/tinnlab/txresbench-app/releases/download/app-v${VERSION}/`;

// ── TEST-IR-9 / the PROV-5 wire shape ───────────────────────────────────────────
test('TEST-IR-9 the emitted feed is exactly the PROV-5 shape: four fixed-order platforms, one shared darwin payload, verbatim signatures', async () => {
  const dir = scratch('txr-feed-');
  const out = path.join(dir, 'latest.json');
  const r = await run(WRITER, feed_args(out));
  assert.equal(r.status, 0, r.out);

  const feed = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepEqual(Object.keys(feed), ['version', 'platforms']);
  assert.equal(feed.version, VERSION);
  assert.match(feed.version, /^0\.2\.0$/);

  const platforms = feed.platforms;
  assert.deepEqual(Object.keys(platforms), ['darwin-aarch64', 'darwin-x86_64', 'linux-x86_64', 'windows-x86_64']);

  // One universal payload under BOTH darwin keys (DEC-6), url + signature equal.
  assert.deepEqual(platforms['darwin-aarch64'], platforms['darwin-x86_64']);
  assert.equal(platforms['darwin-aarch64'].url, `${RELEASE_PREFIX}TxResBench_0.2.0_universal.app.tar.gz`);
  assert.equal(platforms['linux-x86_64'].url, `${RELEASE_PREFIX}TxResBench_0.2.0_amd64.AppImage`);
  assert.equal(platforms['windows-x86_64'].url, `${RELEASE_PREFIX}TxResBench_0.2.0_x64-setup.exe`);

  // Every signature is the .sig file's bytes, verbatim and non-empty.
  const f = fixture_files();
  assert.equal(platforms['darwin-aarch64'].signature, fs.readFileSync(f.darwinSig, 'utf8'));
  assert.equal(platforms['linux-x86_64'].signature, fs.readFileSync(f.appimageSig, 'utf8'));
  assert.equal(platforms['windows-x86_64'].signature, fs.readFileSync(f.nsisSig, 'utf8'));
  for (const entry of Object.values(platforms)) {
    assert.ok(entry.signature.trim().length > 0, 'signature is non-empty');
    assert.equal(entry.url, entry.url.replace(/\?.*$/, ''), 'url has no query string');
  }
});

test('TEST-IR-9 the output is byte-deterministic for identical inputs (run twice, identical bytes)', async () => {
  const dir = scratch('txr-feed-');
  const a = path.join(dir, 'a.json');
  const b = path.join(dir, 'b.json');
  const r1 = await run(WRITER, feed_args(a));
  const r2 = await run(WRITER, feed_args(b));
  assert.equal(r1.status, 0, r1.out);
  assert.equal(r2.status, 0, r2.out);
  assert.ok(fs.readFileSync(a).equals(fs.readFileSync(b)), 'byte-identical output');
});

test('TEST-IR-9 pub_date and notes are written verbatim when given and absent otherwise', async () => {
  const dir = scratch('txr-feed-');
  const notes = path.join(dir, 'notes.txt');
  fs.writeFileSync(notes, 'Fixes for the first release cohort.\nRelease notes text.\n');

  const out = path.join(dir, 'latest.json');
  const r = await run(WRITER, feed_args(out, ['--pub-date', '2026-11-10T12:00:00Z', '--notes', notes]));
  assert.equal(r.status, 0, r.out);
  const feed = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepEqual(Object.keys(feed), ['version', 'pub_date', 'notes', 'platforms']);
  assert.equal(feed.pub_date, '2026-11-10T12:00:00Z');
  assert.equal(feed.notes, fs.readFileSync(notes, 'utf8'));
});

test('TEST-IR-9 a --version that is not semver, or not the manifest version, exits 1 naming both values', async () => {
  const dir = scratch('txr-feed-');
  const out = path.join(dir, 'latest.json');

  const bad = await run(WRITER, feed_args(out, ['--version', 'abc']));
  assert.equal(bad.status, 1);
  assert.match(bad.out, /not a semver/);

  // The repo manifest (0.1.0) is the DEFAULT --tauri-conf: the fixture
  // bundle (0.2.0) is refused with BOTH versions named (DEC-13). The extra
  // --tauri-conf value overrides the base one (last occurrence wins).
  const repoManifest = await run(WRITER, feed_args(out, ['--tauri-conf', REAL_TAURI_CONF]));
  assert.equal(repoManifest.status, 1);
  assert.match(repoManifest.out, /version mismatch/);
  assert.match(repoManifest.out, /0\.2\.0/);
  assert.match(repoManifest.out, /0\.1\.0/);
  assert.ok(!fs.existsSync(out), 'nothing written on a mismatch');

  // Explicit --version vs the fixture manifest: the manifest wins.
  const clash = await run(WRITER, feed_args(out, ['--version', '9.9.9']));
  assert.equal(clash.status, 1);
  assert.match(clash.out, /version mismatch/);
  assert.match(clash.out, /9\.9\.9/);
  assert.match(clash.out, /0\.2\.0/);
});

// ── TEST-IR-10 / url + signature policy ─────────────────────────────────────────
test('TEST-IR-10 a file name that breaks out of the release download prefix is exit 1 naming the file', async () => {
  const dir = scratch('txr-feed-');
  const out = path.join(dir, 'latest.json');
  const f = fixture_files();

  // A query-string character in the file name would move the rest of the url
  // into the query; the writer must refuse it (never a silent url drift).
  const weird = path.join(dir, 'bad?name.AppImage');
  fs.writeFileSync(weird, 'bytes');
  const r = await run(WRITER, feed_args(out, [ '--appimage', weird ]));
  assert.equal(r.status, 1);
  assert.match(r.out, /bad\?name\.AppImage/);
  assert.match(r.out, /outside the release download prefix/);
  assert.ok(!fs.existsSync(out), 'nothing written');

  // A nonexistent artifact is a named failure too (the feed must never name
  // an asset the build did not produce).
  const missing = await run(WRITER, feed_args(out, ['--appimage', path.join(dir, 'never.AppImage')]));
  assert.equal(missing.status, 1);
  assert.match(missing.out, /not found/);
  assert.match(missing.out, /linux \(AppImage\)/);
});

test('TEST-IR-10 an empty or missing signature is exit 1 and nothing is written; model urls never appear in the feed', async () => {
  const dir = scratch('txr-feed-');
  const out = path.join(dir, 'latest.json');
  const f = fixture_files();

  const emptySig = path.join(dir, 'empty.sig');
  fs.writeFileSync(emptySig, '   \n');
  const empty = await run(WRITER, feed_args(out, ['--appimage-sig', emptySig]));
  assert.equal(empty.status, 1);
  assert.match(empty.out, /signature is empty/);
  assert.match(empty.out, /linux/);
  assert.ok(!fs.existsSync(out), 'nothing written');

  const missingSig = await run(WRITER, feed_args(out, ['--darwin-sig', path.join(dir, 'no.sig')]));
  assert.equal(missingSig.status, 1);
  assert.match(missingSig.out, /signature file not found/);
  assert.ok(!fs.existsSync(out), 'nothing written');

  const good = await run(WRITER, feed_args(out));
  assert.equal(good.status, 0, good.out);
  const bytes = fs.readFileSync(out, 'utf8');
  assert.ok(!bytes.includes('txresbench-models'), 'the feed never re-publishes model assets (INV-2)');
  assert.ok(!bytes.includes('.dmg'), 'the dmg is not an updater payload (DEC-8)');
});

// ── TEST-IR-18 / the cross-node PACT check (CONS-IR-2) ─────────────────────────
test('TEST-IR-18 the emitted feed passes the real site build; a mutated platform key or empty signature is refused naming the file', async () => {
  const saved = fs.existsSync(SITE_UPDATES) ? fs.readFileSync(SITE_UPDATES) : null;
  try {
    // The writer's DEFAULT out IS the hosting path (site/public/updates/latest.json).
    const r = await run(WRITER, feed_args(SITE_UPDATES));
    assert.equal(r.status, 0, r.out);
    assert.ok(fs.existsSync(SITE_UPDATES));

    const build = await run(BUILD_SITE, []);
    assert.equal(build.status, 0, build.out);

    // An unknown platform key fails the build naming the key + the file.
    const doc = JSON.parse(fs.readFileSync(SITE_UPDATES, 'utf8'));
    doc.platforms['macos-universal'] = { url: 'https://github.com/tinnlab/txresbench-app/releases/download/app-v0.2.0/x.dmg', signature: 'x' };
    fs.writeFileSync(SITE_UPDATES, `${JSON.stringify(doc, null, 1)}\n`);
    const mutated = await run(BUILD_SITE, []);
    assert.equal(mutated.status, 1);
    assert.match(mutated.out, /latest\.json/);
    assert.match(mutated.out, /macos-universal/);

    // An empty signature fails the build naming the platform field.
    delete doc.platforms['macos-universal'];
    doc.platforms['linux-x86_64'].signature = '   ';
    fs.writeFileSync(SITE_UPDATES, `${JSON.stringify(doc, null, 1)}\n`);
    const unsigned = await run(BUILD_SITE, []);
    assert.equal(unsigned.status, 1);
    assert.match(unsigned.out, /latest\.json/);
    assert.match(unsigned.out, /linux-x86_64\.signature/);
  } finally {
    fs.rmSync(SITE_DIST, { recursive: true, force: true });
    if (saved) fs.writeFileSync(SITE_UPDATES, saved);
    else {
      fs.rmSync(SITE_UPDATES, { force: true });
      fs.rmSync(path.dirname(SITE_UPDATES), { recursive: true, force: true });
    }
  }
});
