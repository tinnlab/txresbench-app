#!/usr/bin/env node
// scripts/verify-macos-vm-runtime.test.mjs — the controls for `scripts/verify-macos-vm-runtime.mjs`, the check
// run before a macOS bundle is made: a good runtime pair passes; a release bundle without one, with half of
// one, with a checksum that does not match, or with an archive the app would refuse fails with a plain
// message; a debug bundle may have no runtime; and the check is the npm script a bundle step can run, and
// reads the dir the macOS bundle ships, for the names the app looks for in mac_vm_run.rs.
//
//   node --test scripts/verify-macos-vm-runtime.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = path.join(REPO, 'scripts/verify-macos-vm-runtime.mjs');
const TAURI = path.join(REPO, 'src-app/desktop/tauri');
const ARCHIVE = 'sandbox-vm-runtime.tar';

const TMPDIRS = [];
process.on('exit', () => {
  for (const d of TMPDIRS) fs.rmSync(d, { recursive: true, force: true });
});
function scratch(prefix) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), prefix));
  TMPDIRS.push(dir);
  return dir;
}

/** The check over `dir`, as Tauri runs it for a release bundle (no TAURI_ENV_DEBUG) unless `env` says. */
function check(dir, env = {}) {
  const base = { ...process.env };
  delete base.TAURI_ENV_DEBUG;
  const res = spawnSync(process.execPath, [CHECK, ...(dir === undefined ? [] : [dir])], {
    encoding: 'utf8',
    env: { ...base, ...env },
  });
  return { status: res.status, out: res.stdout + res.stderr };
}

/** A resource dir like the one scripts/build-macos-vm-runtime.sh fills: the tar (of a stage holding the
 *  launcher, a guest root and a MANIFEST, packed with `-C <stage> .` as the build does) and its .sha256. */
function runtimeDir({ launcher = true, guestRoot = true } = {}) {
  const dir = scratch('txr-vmrt-');
  const stage = path.join(dir, 'stage');
  fs.mkdirSync(path.join(stage, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(stage, 'lib'), { recursive: true });
  if (launcher) fs.writeFileSync(path.join(stage, 'bin/txresbench-sandbox-vm-launcher'), '#!/bin/sh\n', { mode: 0o755 });
  if (guestRoot) {
    fs.mkdirSync(path.join(stage, 'share/guest-root/etc'), { recursive: true });
    fs.writeFileSync(path.join(stage, 'share/guest-root/etc/txresbench-agent-protocol'), '1 1\n');
  }
  fs.writeFileSync(path.join(stage, 'MANIFEST'), 'txresbench macOS method-VM runtime\n');
  const out = path.join(dir, 'res');
  fs.mkdirSync(out);
  const tar = path.join(out, ARCHIVE);
  const res = spawnSync('tar', ['-cf', tar, '-C', stage, '.'], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  fs.writeFileSync(`${tar}.sha256`, `${sha256(tar)}\n`);
  return out;
}
function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// ── the check ────────────────────────────────────────────────────────────────

test('a release bundle takes a whole runtime whose checksum matches', () => {
  const dir = runtimeDir();
  const r = check(dir);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, new RegExp(`sandbox-vm-runtime\\.tar \\([0-9.]+ MB, sha256 ${sha256(path.join(dir, ARCHIVE))}\\) can be bundled`));
});

test('a release bundle without the runtime is refused, as from a fresh checkout', () => {
  const dir = scratch('txr-vmrt-empty-');
  fs.writeFileSync(path.join(dir, '.gitkeep'), '');
  const r = check(dir);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /sandbox-vm-runtime\.tar is missing: build it on an Apple Silicon Mac with `sh scripts\/build-macos-vm-runtime\.sh` before making a release bundle \(without it the Mac app cannot run any method\)/);
});

test('half a pair is refused: the archive without its .sha256, and the .sha256 alone', () => {
  const noSha = runtimeDir();
  fs.rmSync(path.join(noSha, `${ARCHIVE}.sha256`));
  const r1 = check(noSha);
  assert.equal(r1.status, 1, r1.out);
  assert.match(r1.out, /sandbox-vm-runtime\.tar\.sha256 is missing/);

  const noTar = runtimeDir();
  fs.rmSync(path.join(noTar, ARCHIVE));
  const r2 = check(noTar);
  assert.equal(r2.status, 1, r2.out);
  assert.match(r2.out, /sandbox-vm-runtime\.tar is missing/);
});

test('an archive that is not the one its .sha256 names is refused', () => {
  const dir = runtimeDir();
  const other = 'a'.repeat(64);
  fs.writeFileSync(path.join(dir, `${ARCHIVE}.sha256`), `${other}\n`);
  const r = check(dir);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, new RegExp(`sandbox-vm-runtime\\.tar \\(sha256 ${sha256(path.join(dir, ARCHIVE))}\\) is not the one sandbox-vm-runtime\\.tar\\.sha256 names \\(${other}\\)`));
});

test('the .sha256 is read the way the app reads it: trimmed, any case, 64 hex digits', () => {
  const dir = runtimeDir();
  const sha = path.join(dir, `${ARCHIVE}.sha256`);
  fs.writeFileSync(sha, `  ${sha256(path.join(dir, ARCHIVE)).toUpperCase()}  \n`);
  assert.equal(check(dir).status, 0);
  for (const bad of ['', 'not a sha', `${'a'.repeat(63)}\n`, `${sha256(path.join(dir, ARCHIVE))}  ${ARCHIVE}\n`]) {
    fs.writeFileSync(sha, bad);
    const r = check(dir);
    assert.equal(r.status, 1, `${JSON.stringify(bad)}: ${r.out}`);
    assert.match(r.out, /sandbox-vm-runtime\.tar\.sha256 does not hold a sha256 \(64 hex digits\)/);
  }
});

test('an empty or cut-off archive is refused even when the checksum matches', () => {
  const dir = runtimeDir();
  const tar = path.join(dir, ARCHIVE);
  for (const bytes of [Buffer.alloc(0), fs.readFileSync(tar).subarray(0, 700)]) {
    fs.writeFileSync(tar, bytes);
    fs.writeFileSync(`${tar}.sha256`, `${sha256(tar)}\n`);
    const r = check(dir);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, new RegExp(`sandbox-vm-runtime\\.tar is not a whole tar \\(${bytes.length} bytes\\)`));
  }
});

test('blocks that are not a tar are refused', () => {
  const dir = runtimeDir();
  const tar = path.join(dir, ARCHIVE);
  fs.writeFileSync(tar, crypto.randomBytes(2048));
  fs.writeFileSync(`${tar}.sha256`, `${sha256(tar)}\n`);
  const r = check(dir);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /cannot read sandbox-vm-runtime\.tar as a tar/);
});

test('an archive without the launcher or without the guest root is refused, as the app refuses it', () => {
  const noLauncher = check(runtimeDir({ launcher: false }));
  assert.equal(noLauncher.status, 1, noLauncher.out);
  assert.match(noLauncher.out, /sandbox-vm-runtime\.tar has no bin\/txresbench-sandbox-vm-launcher, which the app needs to run methods/);
  const noGuestRoot = check(runtimeDir({ guestRoot: false }));
  assert.equal(noGuestRoot.status, 1, noGuestRoot.out);
  assert.match(noGuestRoot.out, /sandbox-vm-runtime\.tar has no share\/guest-root\//);
});

test('a debug bundle may have no runtime; only TAURI_ENV_DEBUG=true makes a bundle a debug one', () => {
  const dir = scratch('txr-vmrt-debug-');
  fs.writeFileSync(path.join(dir, '.gitkeep'), '');
  const debug = check(dir, { TAURI_ENV_DEBUG: 'true' });
  assert.equal(debug.status, 0, debug.out);
  assert.match(debug.out, /a debug bundle without the VM runtime .* runs methods only when TXR_SANDBOX_VM_LAUNCHER and TXR_SANDBOX_GUEST_ROOT name a runtime/);
  for (const value of ['false', '1', '']) {
    const r = check(dir, { TAURI_ENV_DEBUG: value });
    assert.equal(r.status, 1, `TAURI_ENV_DEBUG=${JSON.stringify(value)}: ${r.out}`);
  }
});

test('a debug bundle that has a runtime gets it checked like a release', () => {
  const good = runtimeDir();
  assert.equal(check(good, { TAURI_ENV_DEBUG: 'true' }).status, 0);
  fs.writeFileSync(path.join(good, `${ARCHIVE}.sha256`), `${'b'.repeat(64)}\n`);
  const bad = check(good, { TAURI_ENV_DEBUG: 'true' });
  assert.equal(bad.status, 1, bad.out);
  assert.match(bad.out, /is not the one sandbox-vm-runtime\.tar\.sha256 names/);
  const half = runtimeDir();
  fs.rmSync(path.join(half, `${ARCHIVE}.sha256`));
  assert.equal(check(half, { TAURI_ENV_DEBUG: 'true' }).status, 1);
});

test('bad arguments exit 2 with the usage line', () => {
  for (const args of [['--arch', 'x86_64'], ['a', 'b']]) {
    const res = spawnSync(process.execPath, [CHECK, ...args], { encoding: 'utf8' });
    assert.equal(res.status, 2, res.stdout + res.stderr);
    assert.match(res.stderr, /usage: node scripts\/verify-macos-vm-runtime\.mjs \[<dir>\]/);
  }
});

// ── the macOS bundle and the app ─────────────────────────────────────────────

/** The tauri.<platform>.conf.json merge Tauri applies: a JSON Merge Patch (RFC 7396) over tauri.conf.json
 *  (the same reading as scripts/build-wsl-rootfs.test.mjs). */
function mergePatch(target, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = target !== null && typeof target === 'object' && !Array.isArray(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  }
  return out;
}
function configFor(platform) {
  const base = JSON.parse(fs.readFileSync(path.join(TAURI, 'tauri.conf.json'), 'utf8'));
  const file = platform && path.join(TAURI, `tauri.${platform}.conf.json`);
  return file && fs.existsSync(file) ? mergePatch(base, JSON.parse(fs.readFileSync(file, 'utf8'))) : base;
}

test('the check is the npm script a bundle step runs, the way the Windows bundle runs its own', () => {
  // resolved from the root package.json, as the build's own `npm run fetch-oras` is
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['verify-macos-vm-runtime'], 'node scripts/verify-macos-vm-runtime.mjs');
  assert.equal(configFor('windows').build.beforeBundleCommand, 'npm run verify-wsl-runtime');
  assert.ok(pkg.scripts['verify-wsl-runtime'], 'the Windows check is an npm script of the same root package.json');
});

test('the check looks where the macOS bundle and the app look, for what the app needs', () => {
  const app = fs.readFileSync(path.join(REPO, 'src-app/server/src/modules/sandbox/mac_vm_run.rs'), 'utf8');
  const check = fs.readFileSync(CHECK, 'utf8');
  const constant = (name) => {
    const m = new RegExp(`const ${name}: &str = "([^"]+)";`).exec(app);
    assert.ok(m, `mac_vm_run.rs has no ${name}`);
    return m[1];
  };
  const resourceDir = constant('RUNTIME_RESOURCE_DIR');
  assert.ok(configFor('macos').bundle.resources.includes(`resources/${resourceDir}`), 'the bundle ships the dir the app reads');
  assert.ok(check.includes(`'src-app/desktop/tauri/resources/${resourceDir}'`), 'the check reads that dir by default');
  assert.ok(check.includes(`const ARCHIVE = '${constant('RUNTIME_ARCHIVE')}';`));
  assert.ok(check.includes(`const LAUNCHER = 'bin/${constant('LAUNCHER_BIN')}';`));
  // what ensure_runtime_in requires of the unpacked archive
  assert.ok(app.includes('tmp.join("bin").join(LAUNCHER_BIN).is_file() || !tmp.join("share/guest-root").is_dir()'));
  assert.ok(check.includes("const GUEST_ROOT = 'share/guest-root/';"));
  // the .sha256 sits next to the archive in both
  assert.ok(app.includes('format!("{}.sha256", archive.display())'));
});
