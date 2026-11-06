#!/usr/bin/env node
// scripts/installer/discover-artifacts.test.mjs — TEST-IR-19's CLI half
// (PROV-IR-1 exit-status surface; DRIFT-1 ITEM-1 #8: the lib throws naming
// the kind, this wrapper maps a throw to exit 1, and that mapping is
// validated here).
//
// Every assertion DRIVES the real CLI as a subprocess and reads its OWN exit
// status. The fixture bundle tree carries version 0.2.0 while the repo's
// `tauri.conf.json` says 0.1.0, so the DEC-13 wiring is proven from both
// sides: the default `--tauri-conf` check REFUSES (manifest wins), and the
// fixture manifest makes the same bundle pass.
//
//   node --test scripts/installer/discover-artifacts.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(SCRIPTS_DIR, '..', '..');
const CLI = path.join(SCRIPTS_DIR, 'discover-artifacts.mjs');
const FIXTURE_BUNDLE = path.join(REPO, 'scripts/installer/fixtures/bundle');
const FIXTURE_TAURI_CONF = path.join(REPO, 'scripts/installer/fixtures/tauri-app-conf-0.2.0.json');

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

/** Run the real CLI as a subprocess; resolves with its own status + output. */
function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ status: code ?? -1, out }));
    child.on('error', (err) => resolve({ status: -1, out: String(err) }));
  });
}

test('TEST-IR-19 the CLI emits the ArtifactSet JSON for the fixture bundle (fixture manifest version)', async () => {
  const r = await run(['--bundle-dir', FIXTURE_BUNDLE, '--tauri-conf', FIXTURE_TAURI_CONF]);
  assert.equal(r.status, 0, r.out);
  // stdout carries ONLY the JSON: an `--out`-less invocation must be parseable.
  const set = JSON.parse(r.out);
  assert.equal(set.version, '0.2.0');
  assert.equal(set.downloads.length, 4);
  assert.deepEqual(set.downloads.map((d) => [d.os, d.kind]), [
    ['macos', 'dmg'],
    ['windows', 'nsis'],
    ['linux', 'deb'],
    ['linux', 'appimage'],
  ]);
  for (const row of set.downloads) {
    assert.ok(fs.existsSync(row.path), `${row.kind} row path exists`);
  }
  for (const [label, upd] of Object.entries(set.updater)) {
    assert.ok(fs.statSync(upd.signature_file).size > 0, `${label} signature exists`);
  }
  // The same set is byte-stable: a published URL must never change between
  // two invocations on the same bundle.
  const again = await run(['--bundle-dir', FIXTURE_BUNDLE, '--tauri-conf', FIXTURE_TAURI_CONF]);
  assert.equal(again.status, 0, again.out);
  assert.equal(again.out, r.out, 'identical inputs must produce identical bytes');
});

test('TEST-IR-19 --out writes the JSON atomically and reports the path', async () => {
  const dir = scratch('txr-discover-');
  const out = path.join(dir, 'artifacts.json');
  const r = await run(['--bundle-dir', FIXTURE_BUNDLE, '--tauri-conf', FIXTURE_TAURI_CONF, '--out', out]);
  assert.equal(r.status, 0, r.out);
  assert.ok(fs.existsSync(out), 'out file written');
  assert.ok(!fs.existsSync(`${out}.part`), 'no .part left behind');
  const set = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(set.version, '0.2.0');
  // The CLI cross-checks the manifest version against the artifact names:
  // a bundle whose filenames carry a different semver is refused.
  const wrong = await run(['--bundle-dir', FIXTURE_BUNDLE, '--tauri-conf', FIXTURE_TAURI_CONF, '--version', '9.9.9']);
  assert.equal(wrong.status, 1);
  assert.match(wrong.out, /mismatch/);
  assert.match(wrong.out, /9\.9\.9/);
  assert.match(wrong.out, /0\.2\.0/);
});

test('TEST-IR-19 with the repo manifest (0.1.0) the fixture bundle (0.2.0) is a named mismatch — DEC-13 manifest wins', async () => {
  // No --tauri-conf: the default is src-app/desktop/tauri/tauri.conf.json (0.1.0).
  const r = await run(['--bundle-dir', FIXTURE_BUNDLE]);
  assert.equal(r.status, 1);
  assert.match(r.out, /cannot determine the artifact version|version mismatch/);
  assert.match(r.out, /0\.2\.0/);
  assert.match(r.out, /0\.1\.0/);
});

test('TEST-IR-19 a missing required kind is exit 1 naming the kind (lib throw -> CLI exit)', async () => {
  const dir = scratch('txr-discover-');
  fs.cpSync(FIXTURE_BUNDLE, path.join(dir, 'bundle'), { recursive: true });
  fs.rmSync(path.join(dir, 'bundle', 'nsis'), { recursive: true });
  const r = await run(['--bundle-dir', path.join(dir, 'bundle'), '--tauri-conf', FIXTURE_TAURI_CONF]);
  assert.equal(r.status, 1);
  assert.match(r.out, /missing required nsis/);
});

test('TEST-IR-19 usage errors are exit 2 and a missing bundle dir is exit 1 naming it', async () => {
  const usage = await run(['--nope']);
  assert.equal(usage.status, 2);

  const missing = await run(['--bundle-dir', path.join(scratch('txr-discover-'), 'gone'), '--tauri-conf', FIXTURE_TAURI_CONF]);
  assert.equal(missing.status, 1);
  assert.match(missing.out, /bundle directory not found/);
});
