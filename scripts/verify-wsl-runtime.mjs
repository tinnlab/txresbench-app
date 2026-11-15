#!/usr/bin/env node
// scripts/verify-wsl-runtime.mjs — run before a Windows bundle is made (tauri.windows.conf.json
// build.beforeBundleCommand, through `npm run verify-wsl-runtime`). It refuses to bundle a WSL runtime the
// app would refuse at import, or one that a test, a dirty tree or another tree produced:
//   - the directory holds txresbench-wsl.tar and MANIFEST.json (scripts/build-wsl-rootfs.sh writes both);
//   - the tar's sha256 is the MANIFEST's, and the tar is a whole number of 512-byte tar blocks;
//   - the MANIFEST's arch is the bundle's: --arch, else TAURI_ENV_ARCH, else the CPU of
//     TAURI_ENV_TARGET_TRIPLE (Tauri sets both for its build hooks);
//   - the version is "<MIN>-<MAX>-<16 hex>" with the MANIFEST's protocol range, and the range holds this
//     tree's PROTOCOL_VERSION (sdk/crates/sandbox-vm-protocol/src/lib.rs), which the app requires;
//   - unless TXR_WSL_RUNTIME_ALLOW_DEV=1 (a development bundle):
//       the agent was not built from a test cache (build.agent_cargo_cache is null);
//       the runtime was built from a commit (build.source_commit, no "+dirty") that this checkout has,
//       and the build's inputs (BUILD_INPUTS) are the same here, committed or not, with no untracked
//       file among them. The resource directory is ignored by git, so a runtime built from an older tree
//       stays there across checkouts and pulls; this is what refuses it once sdk/ or the build changes.
//
// Not a scripts/check-*: those are the repo's pinned architectural guards (scripts/check-guard-integrity.sh),
// which this, a check of a build's output, is not.
//
//   node scripts/verify-wsl-runtime.mjs [<dir>] [--arch x86_64|aarch64]
//     <dir> defaults to src-app/desktop/tauri/resources/wsl-runtime
// Exit 0 when the pair can be bundled, 1 with the reason otherwise, 2 on bad arguments.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARBALL = 'txresbench-wsl.tar';
const ARCHES = ['x86_64', 'aarch64'];
const PROTOCOL_SRC = 'sdk/crates/sandbox-vm-protocol/src/lib.rs';
// Everything scripts/build-wsl-rootfs.sh reads from the tree (scripts/build-wsl-rootfs.test.mjs checks
// this list against the script and its helper). All of sdk/: cargo reads the workspace's manifests
// wherever they are, and a narrower list could miss one; the cost is a rebuild after a change to sdk/ the
// agent does not use.
const BUILD_INPUTS = ['sdk', 'scripts/build-wsl-rootfs.sh', 'scripts/guest-root-common.sh', 'THIRD-PARTY-NOTICES.md'];

function fail(msg) {
  console.error(`verify-wsl-runtime: ${msg}`);
  process.exit(1);
}
function usage() {
  console.error('usage: node scripts/verify-wsl-runtime.mjs [<dir>] [--arch x86_64|aarch64]');
  process.exit(2);
}
function git(...args) {
  return spawnSync('git', ['-C', REPO, ...args], { encoding: 'utf8' });
}

let dir = path.join(REPO, 'src-app/desktop/tauri/resources/wsl-runtime');
let arch = null;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--arch') {
    arch = args[++i];
    if (!ARCHES.includes(arch)) usage();
  } else if (args[i].startsWith('-')) {
    usage();
  } else {
    dir = path.resolve(args[i]);
  }
}
if (arch === null) {
  if (process.env.TAURI_ENV_ARCH) arch = process.env.TAURI_ENV_ARCH;
  else if (process.env.TAURI_ENV_TARGET_TRIPLE) arch = process.env.TAURI_ENV_TARGET_TRIPLE.split('-')[0];
  else fail('cannot tell the bundle\'s CPU: pass --arch, or run this from `tauri build` (TAURI_ENV_ARCH)');
  if (!ARCHES.includes(arch)) fail(`the bundle's CPU "${arch}" has no WSL runtime (x86_64 or aarch64)`);
}
const rebuild = `rebuild it with \`sh scripts/build-wsl-rootfs.sh ${arch}\``;

const tarPath = path.join(dir, TARBALL);
const manifestPath = path.join(dir, 'MANIFEST.json');
for (const f of [tarPath, manifestPath]) {
  if (!fs.existsSync(f)) fail(`${f} is missing: build it with \`sh scripts/build-wsl-rootfs.sh ${arch}\` before bundling for Windows`);
}

let m;
try {
  m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
} catch (e) {
  fail(`${manifestPath} is not JSON: ${e.message}`);
}
const tar = fs.readFileSync(tarPath);
const sha = crypto.createHash('sha256').update(tar).digest('hex');
if (m.sha256 !== sha) fail(`${TARBALL} (sha256 ${sha}) is not the one MANIFEST.json describes (${m.sha256}); rebuild both`);
if (tar.length === 0 || tar.length % 512 !== 0) fail(`${TARBALL} is not a whole tar (${tar.length} bytes)`);
if (m.arch !== arch) fail(`the WSL runtime is for ${m.arch}, the bundle for ${arch}: ${rebuild}`);
const [min, max] = Array.isArray(m.protocol) ? m.protocol : [];
if (!Number.isInteger(min) || !Number.isInteger(max) || typeof m.version !== 'string' ||
  !new RegExp(`^${min}-${max}-[0-9a-f]{16}$`).test(m.version)) {
  fail(`MANIFEST.json's version ${JSON.stringify(m.version)} does not match its protocol range ${JSON.stringify(m.protocol)}`);
}
let protocol = null;
try {
  // with m, $ also matches before \r, so a Windows checkout's CRLF line ends read the same
  const found = /^pub const PROTOCOL_VERSION: u32 = ([0-9]+);$/m.exec(fs.readFileSync(path.join(REPO, PROTOCOL_SRC), 'utf8'));
  if (found) protocol = Number(found[1]);
} catch {
  // reported below
}
if (protocol === null) fail(`cannot read PROTOCOL_VERSION from ${path.join(REPO, PROTOCOL_SRC)}`);
if (protocol < min || protocol > max) {
  fail(`the WSL runtime's agent serves protocol ${min}..${max}, and this tree's app speaks ${protocol}: ${rebuild}`);
}

if (process.env.TXR_WSL_RUNTIME_ALLOW_DEV !== '1') {
  const dev = '(or set TXR_WSL_RUNTIME_ALLOW_DEV=1 for a development bundle)';
  const build = m.build ?? {};
  if (!('agent_cargo_cache' in build)) fail('MANIFEST.json does not say whether the agent came from a test cache; rebuild it');
  if (build.agent_cargo_cache !== null) {
    fail(`the agent was built from the test cache "${build.agent_cargo_cache}"; rebuild without TXR_GUEST_AGENT_CARGO_CACHE ${dev}`);
  }
  const commit = build.source_commit;
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)) {
    fail(`the runtime was built from ${JSON.stringify(commit)}, not a committed tree; rebuild from a clean checkout ${dev}`);
  }
  // git must read this checkout first: no git, no .git, or a checkout git refuses (safe.directory) is
  // not a missing commit, and a rebuild would not help
  const repo = git('rev-parse', '--git-dir');
  if (repo.status !== 0) {
    fail(`cannot read ${REPO} with git, to compare it with the runtime's commit ${commit}: ` +
      `${repo.error ? repo.error.message : repo.stderr.trim()} ${dev}`);
  }
  if (git('cat-file', '-e', `${commit}^{commit}`).status !== 0) {
    fail(`the runtime was built from commit ${commit}, which this checkout does not have; ${rebuild} ${dev}`);
  }
  const changed = git('diff', '--quiet', '--no-ext-diff', '--no-textconv', commit, '--', ...BUILD_INPUTS);
  if (changed.status === 1) {
    fail(`the runtime was built from ${commit}, and ${BUILD_INPUTS.join(', ')} differ here ` +
      `(git diff ${commit.slice(0, 12)} -- ${BUILD_INPUTS.join(' ')}); ${rebuild} ${dev}`);
  }
  const untracked = git('ls-files', '--others', '--exclude-standard', '--', ...BUILD_INPUTS);
  if (changed.status !== 0 || untracked.status !== 0) {
    fail(`cannot compare this checkout with ${commit}: ${(changed.stderr || untracked.stderr || '').trim()}`);
  }
  if (untracked.stdout.trim() !== '') {
    fail(`untracked files among the build's inputs (${untracked.stdout.trim().split('\n').join(', ')}) were not in ` +
      `the runtime's build; commit or remove them, then ${rebuild} ${dev}`);
  }
}

console.log(`verify-wsl-runtime: ${TARBALL} ${m.version} (${m.arch}, sha256 ${sha}) can be bundled`);
