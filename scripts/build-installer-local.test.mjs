#!/usr/bin/env node
// scripts/build-installer-local.test.mjs — TEST-IR-20 (ITEM-2).
//
// The dry-run / --skip-models contract of `scripts/build-installer-local.sh`
// and the ITEM-2 half of TEST-IR-14 (the tauri.conf.json + .gitignore static
// wiring: createUpdaterArtifacts, bundle.resources, plugins.updater with the
// empty pubkey + the fixed endpoints — the raw-string assertions mirror the
// desktop crate's include_str! config pins, kept here so the ITEM-2 config
// contract is verified in the item that ships it).
//
// The script is driven as a SUBPROCESS against a fixture repo tree: the test
// writes a miniature repository (the script copy + the frozen-shape
// bundled-models.json fixture), and a stub bin dir on PATH provides the
// prerequisite probes (node/npm/cargo/rustc/uname/dpkg) so the behavior is
// machine-independent. The stub `node` touches a marker file when executed —
// the dry run must never execute it (a dry run stages nothing, fetches
// nothing).
//
//   node --test scripts/build-installer-local.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(SCRIPT_DIR, '..');
const INSTALLER_SCRIPT = path.join(SCRIPT_DIR, 'build-installer-local.sh');
const FIXTURE_MANIFEST = path.join(REPO, 'scripts/installer/fixtures/bundled-models.json');

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

/** The bash used to drive the script (the harness shell, not a stub). */
function bash() {
  const found = spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' });
  const bin = found.status === 0 ? found.stdout.trim() : '/bin/bash';
  return fs.existsSync(bin) ? bin : '/bin/bash';
}

/** Write an executable stub that exits `code` (or runs `body`). */
function write_stub(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body || 'exit 0'}\n`, { mode: 0o755 });
}

/**
 * A fixture repo tree + stub bin dir. The child runs with PATH = the stub bin
 * dir ONLY (plus symlinked real dirname/cat), so the prerequisite probes are
 * fully machine-independent: `omit` drops a stub, which is exactly the
 * missing-prerequisite control. `failDpkg` makes the dpkg stub report every
 * Linux build library missing.
 */
function fixture({ failDpkg = false, omit = [] } = {}) {
  const root = scratch('txr-installer-');
  const repo = path.join(root, 'repo');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'data/pretrained-catalogue'), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });

  fs.copyFileSync(INSTALLER_SCRIPT, path.join(repo, 'scripts', 'build-installer-local.sh'));
  fs.copyFileSync(
    FIXTURE_MANIFEST,
    path.join(repo, 'data/pretrained-catalogue', 'bundled-models.json'),
  );

  // dirname/cat must be the real tools (the script resolves its own path and
  // prints the plan via a heredoc); everything else is a stub.
  for (const tool of ['dirname', 'cat']) {
    const real = spawnSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' });
    const src = real.status === 0 ? real.stdout.trim() : `/${tool}`;
    fs.symlinkSync(src, path.join(bin, tool));
  }

  const marker = path.join(root, 'node-ran.marker');
  const stubs = {
    node: `[ -n "$MARKER" ] && touch "$MARKER"\nexit 0`,
    npm: 'exit 0',
    cargo: 'exit 0',
    rustc: 'exit 0',
    uname: 'echo Linux',
    dpkg: failDpkg ? 'exit 1' : 'exit 0',
  };
  for (const [name, body] of Object.entries(stubs)) {
    if (omit.includes(name)) continue;
    write_stub(bin, name, body);
  }

  return { root, repo, bin, marker, env: { MARKER: marker } };
}

/** Run the fixture installer script with the stub bin as the whole PATH. */
function run_installer(repo, bin, args, extraEnv = {}) {
  return spawnSync(bash(), [path.join(repo, 'scripts', 'build-installer-local.sh'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: bin, ...extraEnv },
  });
}

// ── TEST-IR-20 / DRY RUN ───────────────────────────────────────────────────────
test('TEST-IR-20 --dry-run prints the model-staging step + tauri build, executes nothing', () => {
  const { repo, bin, marker } = fixture();

  const res = run_installer(repo, bin, ['--dry-run']);

  assert.equal(res.status, 0, res.stderr);
  const out = `${res.stdout}\n${res.stderr}`;
  assert.match(out, /dry run — prerequisites ok, would run:/);
  // The two steps, in order: stage models, then build.
  const modelStep = out.indexOf('bundle-pretrained-models.mjs');
  const buildStep = out.indexOf('@tauri-apps/cli@2 build --bundles deb,appimage');
  assert.ok(modelStep >= 0, `plan names the model-staging step:\n${out}`);
  assert.ok(buildStep > modelStep, 'the plan stages models BEFORE the build');
  assert.match(out, /--manifest data\/pretrained-catalogue\/bundled-models\.json/);
  assert.match(out, /--out src-app\/desktop\/tauri\/resources\/pretrained-bundled/);

  // A dry run executes nothing: the stub `node` must never be invoked, so
  // nothing is fetched and nothing is staged.
  assert.ok(!fs.existsSync(marker), 'dry run must not execute the staging step');
});

// ── TEST-IR-20 / --SKIP-MODELS ─────────────────────────────────────────────────
test('TEST-IR-20 --skip-models omits the staging step and still plans the build', () => {
  const { repo, bin, marker } = fixture();

  const res = run_installer(repo, bin, ['--dry-run', '--skip-models']);

  assert.equal(res.status, 0, res.stderr);
  const out = `${res.stdout}\n${res.stderr}`;
  assert.match(out, /@tauri-apps\/cli@2 build --bundles deb,appimage/);
  assert.doesNotMatch(out, /bundle-pretrained-models\.mjs/, 'no staging step in the plan');
  assert.doesNotMatch(out, /--manifest/, 'no manifest argument in the plan');
  assert.ok(!fs.existsSync(marker), 'skip-model dry run executes nothing');
});

// ── TEST-IR-20 / PREREQ CHECKS KEEP THEIR EXISTING BEHAVIOR ────────────────────
test('TEST-IR-20 a missing prerequisite binary still fails naming it', () => {
  const { repo, bin } = fixture({ omit: ['cargo'] });

  const res = run_installer(repo, bin, ['--dry-run']);

  assert.equal(res.status, 1);
  assert.match(res.stderr, /missing prerequisite: cargo/);
});

test('TEST-IR-20 missing Linux build libraries still fail with the apt hint (dry-run included)', () => {
  const { repo, bin } = fixture({ failDpkg: true });

  const res = run_installer(repo, bin, ['--dry-run']);

  assert.equal(res.status, 1);
  assert.match(res.stderr, /Linux build libraries not installed/);
  assert.match(res.stderr, /sudo apt-get install/);
  // The existing behavior names the missing packages.
  assert.match(res.stderr, /libwebkit2gtk-4\.1-dev/);
});

test('TEST-IR-20 an unknown option is still a usage error', () => {
  const { repo, bin } = fixture();

  const res = run_installer(repo, bin, ['--bogus']);

  assert.equal(res.status, 2);
  assert.match(res.stderr, /unknown option: --bogus/);
});

// ── TEST-IR-14 (ITEM-2 half) / STATIC WIRING ───────────────────────────────────
test('TEST-IR-14 tauri.conf.json carries the updater + bundled-resources wiring', () => {
  const confPath = path.join(REPO, 'src-app/desktop/tauri/tauri.conf.json');
  const raw = fs.readFileSync(confPath, 'utf8');

  // Raw-string assertions (the desktop crate's include_str! discipline): a
  // config refactor cannot silently drop the wiring.
  assert.match(raw, /"createUpdaterArtifacts"\s*:\s*true/);
  assert.match(raw, /"resources"\s*:\s*\["resources\/pretrained-bundled"\]/);
  assert.match(raw, /"updater"\s*:/);
  assert.match(raw, /"pubkey"\s*:\s*""/);
  assert.ok(
    raw.includes('https://tinnlab.github.io/txresbench-app/updates/latest.json'),
    'endpoints carries the canonical FEED (CONS-IR-1, UPDATER_FEED_URL)',
  );

  // Semantic assertions.
  const conf = JSON.parse(raw);
  assert.equal(conf.bundle.createUpdaterArtifacts, true);
  assert.deepEqual(conf.bundle.resources, ['resources/pretrained-bundled']);
  assert.equal(conf.plugins.updater.pubkey, '');
  assert.deepEqual(conf.plugins.updater.endpoints, [
    'https://tinnlab.github.io/txresbench-app/updates/latest.json',
  ]);
  assert.match(conf.version, /^\d+\.\d+\.\d+$/, 'version is semver (DEC-13 source of truth)');
});

test('TEST-IR-14 the staged bundle dir is gitignored (model bytes never committed)', () => {
  const raw = fs.readFileSync(path.join(REPO, '.gitignore'), 'utf8');
  // The staged bytes are ignored; ONLY the directory marker is tracked (the
  // resource path must exist for tauri-build on a fresh checkout).
  assert.match(
    raw,
    /^src-app\/desktop\/tauri\/resources\/pretrained-bundled\/\*$/m,
    '.gitignore excludes the staged set (DEC-9, INV-2)',
  );
  assert.match(
    raw,
    /^!src-app\/desktop\/tauri\/resources\/pretrained-bundled\/\.gitkeep$/m,
    '.gitignore tracks the directory marker only (DRIFT-1 ITEM-2 #6)',
  );

  const bundleDir = path.join(REPO, 'src-app/desktop/tauri/resources/pretrained-bundled');
  assert.ok(fs.existsSync(path.join(bundleDir, '.gitkeep')), 'the marker exists on a fresh checkout');
  // No staged model bytes in the working tree (the manifest copy + .txr files
  // appear only when the release pipeline stages them).
  assert.ok(
    !fs.existsSync(path.join(bundleDir, 'bundled-models.json')),
    'no staged manifest copy in the working tree',
  );
  assert.equal(
    fs.readdirSync(bundleDir).filter((n) => n.endsWith('.txr')).length,
    0,
    'no staged .txr bytes in the working tree',
  );
});
