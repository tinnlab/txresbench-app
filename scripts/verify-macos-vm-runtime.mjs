#!/usr/bin/env node
// scripts/verify-macos-vm-runtime.mjs — the check to run before a macOS bundle is made
// (`npm run verify-macos-vm-runtime`). The Mac app runs every method in a small Linux VM whose runtime it
// ships as one archive in resources/sandbox-vm-runtime/, built on an Apple Silicon Mac by
// scripts/build-macos-vm-runtime.sh. git ignores that directory, so a fresh checkout holds only its
// .gitkeep, and a bundle made from it installs and starts but can run no method. This refuses a release
// bundle unless the directory holds a runtime the app accepts (ensure_runtime_in in
// src-app/server/src/modules/sandbox/mac_vm_run.rs):
//   - sandbox-vm-runtime.tar and sandbox-vm-runtime.tar.sha256 are both there;
//   - the .sha256 holds one sha256 (64 hex digits), and it is the tar's;
//   - the tar is whole (a non-zero number of 512-byte blocks that `tar -tf` reads) and holds
//     bin/txresbench-sandbox-vm-launcher and share/guest-root/, which the app requires after unpacking.
// A debug bundle (`tauri build --debug`, for which Tauri sets TAURI_ENV_DEBUG=true) may have no runtime:
// a test run names one with TXR_SANDBOX_VM_LAUNCHER and TXR_SANDBOX_GUEST_ROOT instead. When a debug bundle
// has either file, the pair is checked as for a release.
//
// Not yet run by the bundle step. Wiring it is one line in tauri.macos.conf.json,
//   "build": { "beforeBundleCommand": "npm run verify-macos-vm-runtime" }
// (as tauri.windows.conf.json runs verify-wsl-runtime), but the release workflow has no step that puts the
// runtime there yet, so its macOS leg would stop at the bundle step. Add that step first.
//
// Not a scripts/check-*: those are the repo's pinned architectural guards (scripts/check-guard-integrity.sh),
// which this, a check of a build's output, is not.
//
//   node scripts/verify-macos-vm-runtime.mjs [<dir>]
//     <dir> defaults to src-app/desktop/tauri/resources/sandbox-vm-runtime
// Exit 0 when the bundle can be made, 1 with the reason otherwise, 2 on bad arguments.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The names the app looks for (mac_vm_run.rs: RUNTIME_ARCHIVE, LAUNCHER_BIN, share/guest-root).
const ARCHIVE = 'sandbox-vm-runtime.tar';
const LAUNCHER = 'bin/txresbench-sandbox-vm-launcher';
const GUEST_ROOT = 'share/guest-root/';
const REBUILD = 'build it on an Apple Silicon Mac with `sh scripts/build-macos-vm-runtime.sh`';

function fail(msg) {
  console.error(`verify-macos-vm-runtime: ${msg}`);
  process.exit(1);
}
function usage() {
  console.error('usage: node scripts/verify-macos-vm-runtime.mjs [<dir>]');
  process.exit(2);
}
function sha256(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(1 << 20);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

const args = process.argv.slice(2);
if (args.length > 1 || args.some((a) => a.startsWith('-'))) usage();
const dir = args.length === 1 ? path.resolve(args[0]) : path.join(REPO, 'src-app/desktop/tauri/resources/sandbox-vm-runtime');
const tarPath = path.join(dir, ARCHIVE);
const shaPath = `${tarPath}.sha256`;
const debug = process.env.TAURI_ENV_DEBUG === 'true';

if (debug && !fs.existsSync(tarPath) && !fs.existsSync(shaPath)) {
  console.log(`verify-macos-vm-runtime: a debug bundle without the VM runtime (${dir} has no ${ARCHIVE}); ` +
    'it runs methods only when TXR_SANDBOX_VM_LAUNCHER and TXR_SANDBOX_GUEST_ROOT name a runtime');
  process.exit(0);
}
for (const f of [tarPath, shaPath]) {
  if (!fs.existsSync(f)) fail(`${f} is missing: ${REBUILD} before making a release bundle (without it the Mac app cannot run any method)`);
}

const expected = fs.readFileSync(shaPath, 'utf8').trim().toLowerCase();
if (!/^[0-9a-f]{64}$/.test(expected)) fail(`${shaPath} does not hold a sha256 (64 hex digits); ${REBUILD}`);
const size = fs.statSync(tarPath).size;
if (size === 0 || size % 512 !== 0) fail(`${ARCHIVE} is not a whole tar (${size} bytes); ${REBUILD}`);
const actual = sha256(tarPath);
if (actual !== expected) {
  fail(`${ARCHIVE} (sha256 ${actual}) is not the one ${ARCHIVE}.sha256 names (${expected}); ${REBUILD}, which writes both`);
}

const list = spawnSync('tar', ['-tf', tarPath], { encoding: 'utf8', maxBuffer: 1 << 28 });
if (list.error || list.status !== 0) {
  fail(`cannot read ${ARCHIVE} as a tar: ${list.error ? list.error.message : list.stderr.trim()}; ${REBUILD}`);
}
const entries = list.stdout.split('\n').map((e) => e.replace(/^(\.\/)+/, ''));
for (const [want, found] of [
  [LAUNCHER, entries.includes(LAUNCHER)],
  [GUEST_ROOT, entries.some((e) => e.startsWith(GUEST_ROOT))],
]) {
  if (!found) fail(`${ARCHIVE} has no ${want}, which the app needs to run methods; ${REBUILD}`);
}

console.log(`verify-macos-vm-runtime: ${ARCHIVE} (${(size / 1048576).toFixed(1)} MB, sha256 ${actual}) can be bundled`);
