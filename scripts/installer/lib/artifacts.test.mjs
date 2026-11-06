#!/usr/bin/env node
// scripts/installer/lib/artifacts.test.mjs — TEST-IR-19 (PROV-IR-1).
//
// The negative controls for `scripts/installer/lib/artifacts.mjs`: the
// PROV-IR-1 mapping (download rows vs updater payloads, the one universal
// darwin artifact under BOTH feed keys), pattern-based discovery (a renamed
// artifact set is still found — no hardcoded filename may be introduced), and
// the named failures (missing kind, missing `.sig`, version mismatch,
// ambiguity).
//
//   node --test scripts/installer/lib/artifacts.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DOWNLOAD_KINDS,
  FEED_PLATFORM_ORDER,
  discover_artifacts,
  feed_platforms,
  sha256_file,
} from './artifacts.mjs';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(SCRIPTS_DIR, '..', '..', '..');
const FIXTURE_BUNDLE = path.join(REPO, 'scripts/installer/fixtures/bundle');

const TMPDIRS = [];
process.on('exit', () => {
  for (const d of TMPDIRS) fs.rmSync(d, { recursive: true, force: true });
});

/** A scratch dir under the run's TMPDIR (never /tmp), cleaned on exit. */
function scratch(prefix) {
  const base = process.env.TMPDIR || os.tmpdir();
  const dir = fs.mkdtempSync(path.join(base, prefix));
  TMPDIRS.push(dir);
  return dir;
}

/** Copy the fixture bundle tree into a scratch dir (mutable per test). */
function copy_fixture_bundle() {
  const dir = scratch('txr-artifacts-');
  fs.cpSync(FIXTURE_BUNDLE, path.join(dir, 'bundle'), { recursive: true });
  return path.join(dir, 'bundle');
}

// ── TEST-IR-19 / MAPPING ────────────────────────────────────────────────────────
test('TEST-IR-19 discover_artifacts maps the fixture bundle per PROV-IR-1', () => {
  const set = discover_artifacts(FIXTURE_BUNDLE);

  assert.equal(set.version, '0.2.0');

  // The four user-download rows, in the fixed order (macos, windows, linux x2).
  assert.equal(set.downloads.length, 4);
  assert.deepEqual(
    set.downloads.map((d) => [d.os, d.kind]),
    [
      ['macos', 'dmg'],
      ['windows', 'nsis'],
      ['linux', 'deb'],
      ['linux', 'appimage'],
    ],
  );
  for (const row of set.downloads) {
    assert.match(row.file, /./, `${row.kind} row has a file`);
    assert.ok(fs.existsSync(row.path), `${row.kind} row path exists: ${row.path}`);
    assert.equal(row.size_bytes, fs.statSync(row.path).size);
    assert.match(row.sha256, /^[0-9a-f]{64}$/);
    assert.equal(row.sha256, sha256_file(row.path));
  }
  assert.deepEqual(set.downloads.map((d) => d.kind), [...DOWNLOAD_KINDS]);

  // Updater payloads: AppImage (Linux), the universal .app.tar.gz (macOS),
  // the NSIS exe (Windows), each with its `.sig` sibling.
  const [dmg, nsis, deb, appimage] = set.downloads;
  assert.equal(set.updater.appimage.file, appimage.file);
  assert.equal(set.updater.appimage.path, appimage.path);
  assert.equal(set.updater.nsis.file, nsis.file);
  assert.equal(set.updater.nsis.path, nsis.path);
  assert.equal(set.updater.darwin.file, 'TxResBench_0.2.0_universal.app.tar.gz');
  assert.equal(set.updater.darwin.path, path.join(FIXTURE_BUNDLE, 'macos', set.updater.darwin.file));
  assert.ok(!set.updater.darwin.path.includes('.dmg'), 'the dmg is not an updater payload (DEC-8)');
  for (const [label, upd] of Object.entries(set.updater)) {
    assert.ok(fs.existsSync(upd.signature_file), `${label} signature exists`);
    assert.ok(fs.statSync(upd.signature_file).size > 0, `${label} signature is non-empty`);
    assert.equal(upd.sha256, sha256_file(upd.path));
  }
  assert.equal(dmg.file, 'TxResBench_0.2.0_universal.dmg');
});

// ── TEST-IR-19 / FEED PLATFORMS (DEC-6/7/8) ─────────────────────────────────────
test('TEST-IR-19 feed_platforms emits the four PROV-5 keys, darwin twice on one artifact', () => {
  const set = discover_artifacts(FIXTURE_BUNDLE);
  const platforms = feed_platforms(set);

  assert.deepEqual(platforms.map((p) => p.platform), FEED_PLATFORM_ORDER);
  const byKey = Object.fromEntries(platforms.map((p) => [p.platform, p.updater]));
  // The SAME universal .app.tar.gz serves both darwin keys (tauri universal
  // convention), not two different payloads.
  assert.equal(byKey['darwin-aarch64'], byKey['darwin-x86_64']);
  assert.equal(byKey['darwin-aarch64'].file, set.updater.darwin.file);
  assert.equal(byKey['linux-x86_64'], set.updater.appimage);
  assert.equal(byKey['windows-x86_64'], set.updater.nsis);
});

// ── TEST-IR-19 / NAMED FAILURES ─────────────────────────────────────────────────
test('TEST-IR-19 a missing required kind is an error naming the kind', () => {
  const noDeb = copy_fixture_bundle();
  fs.rmSync(path.join(noDeb, 'deb'), { recursive: true });
  assert.throws(() => discover_artifacts(noDeb), /missing required deb/);

  const noAppimage = copy_fixture_bundle();
  fs.rmSync(path.join(noAppimage, 'appimage'), { recursive: true });
  assert.throws(() => discover_artifacts(noAppimage), /missing required appimage/);

  const noDmg = copy_fixture_bundle();
  fs.rmSync(path.join(noDmg, 'macos', 'TxResBench_0.2.0_universal.dmg'));
  assert.throws(() => discover_artifacts(noDmg), /missing required dmg/);

  const noDarwinUpdater = copy_fixture_bundle();
  fs.rmSync(path.join(noDarwinUpdater, 'macos', 'TxResBench_0.2.0_universal.app.tar.gz'));
  assert.throws(() => discover_artifacts(noDarwinUpdater), /missing required darwin-updater/);

  const noNsis = copy_fixture_bundle();
  fs.rmSync(path.join(noNsis, 'nsis'), { recursive: true });
  assert.throws(() => discover_artifacts(noNsis), /missing required nsis/);

  const noBundle = copy_fixture_bundle();
  assert.throws(() => discover_artifacts(path.join(noBundle, 'gone')), /bundle directory not found/);
});

test('TEST-IR-19 a missing updater .sig is an error naming it', () => {
  const noSig = copy_fixture_bundle();
  fs.rmSync(path.join(noSig, 'appimage', 'TxResBench_0.2.0_amd64.AppImage.sig'));
  assert.throws(() => discover_artifacts(noSig), /missing AppImage updater signature/);

  const noDarwinSig = copy_fixture_bundle();
  fs.rmSync(path.join(noDarwinSig, 'macos', 'TxResBench_0.2.0_universal.app.tar.gz.sig'));
  assert.throws(() => discover_artifacts(noDarwinSig), /missing macOS updater signature/);

  const noNsisSig = copy_fixture_bundle();
  fs.rmSync(path.join(noNsisSig, 'nsis', 'TxResBench_0.2.0_x64-setup.exe.sig'));
  assert.throws(() => discover_artifacts(noNsisSig), /missing Windows updater signature/);
});

test('TEST-IR-19 discovery is pattern-based, not filename-based', () => {
  // A differently-named but convention-shaped set is still discovered: renaming
  // every artifact (different product name, `-setup` vs `_setup`, no `universal`
  // token) must not break the mapping, and the version derives from the names.
  const dir = scratch('txr-artifacts-rename-');
  const bundle = path.join(dir, 'bundle');
  const files = {
    'deb/tool_1.3.0_amd64.deb': 'd',
    'appimage/Tool_1.3.0_amd64.AppImage': 'a',
    'appimage/Tool_1.3.0_amd64.AppImage.sig': 'as',
    'macos/Tool_1.3.0_universal.dmg': 'm',
    'macos/Tool_1.3.0_universal.app.tar.gz': 'm2',
    'macos/Tool_1.3.0_universal.app.tar.gz.sig': 'm3',
    'nsis/Tool-1.3.0-x64-setup.exe': 'n',
    'nsis/Tool-1.3.0-x64-setup.exe.sig': 'ns',
  };
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(bundle, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  const set = discover_artifacts(bundle);
  assert.equal(set.version, '1.3.0');
  assert.deepEqual(set.downloads.map((d) => [d.os, d.kind]), [
    ['macos', 'dmg'],
    ['windows', 'nsis'],
    ['linux', 'deb'],
    ['linux', 'appimage'],
  ]);
  assert.equal(set.updater.nsis.file, 'Tool-1.3.0-x64-setup.exe');
  assert.equal(set.updater.darwin.file, 'Tool_1.3.0_universal.app.tar.gz');

  // The explicit-version cross-check agrees here and disagrees on a real
  // mismatch — the caller never guesses (DEC-13).
  assert.equal(discover_artifacts(bundle, { version: '1.3.0' }).version, '1.3.0');
  assert.throws(() => discover_artifacts(bundle, { version: '9.9.9' }), /version mismatch/);

  // A set whose names carry two different versions cannot be disambiguated.
  fs.renameSync(
    path.join(bundle, 'nsis', 'Tool-1.3.0-x64-setup.exe'),
    path.join(bundle, 'nsis', 'Tool-2.0.0-x64-setup.exe'),
  );
  fs.renameSync(
    path.join(bundle, 'nsis', 'Tool-1.3.0-x64-setup.exe.sig'),
    path.join(bundle, 'nsis', 'Tool-2.0.0-x64-setup.exe.sig'),
  );
  assert.throws(() => discover_artifacts(bundle), /cannot determine the artifact version/);
});

test('TEST-IR-19 two candidates for one kind are an ambiguity error, and unknown bundle dirs are ignored', () => {
  const dir = copy_fixture_bundle();
  fs.writeFileSync(path.join(dir, 'appimage', 'TxResBench_0.2.0_amd64.AppImage.sig'), 'sig');
  fs.writeFileSync(path.join(dir, 'appimage', 'Tool_0.2.1_amd64.AppImage'), 'second');
  assert.throws(() => discover_artifacts(dir), /ambiguous appimage/);

  // An msi or rpm directory the release matrix does not build is not part of
  // the PROV-IR-1 surface and must not disturb discovery.
  const withExtra = copy_fixture_bundle();
  fs.mkdirSync(path.join(withExtra, 'rpm'), { recursive: true });
  fs.writeFileSync(path.join(withExtra, 'rpm', 'tool-0.2.0-1.x86_64.rpm'), 'x');
  fs.mkdirSync(path.join(withExtra, 'msi'), { recursive: true });
  fs.writeFileSync(path.join(withExtra, 'msi', 'tool_0.2.0_x64.msi'), 'x');
  const set = discover_artifacts(withExtra);
  assert.equal(set.version, '0.2.0');
  assert.equal(set.downloads.length, 4);
});
