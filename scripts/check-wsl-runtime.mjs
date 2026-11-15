#!/usr/bin/env node
// scripts/check-wsl-runtime.mjs — run before a Windows bundle is made (tauri.windows.conf.json
// build.beforeBundleCommand, through `npm run check-wsl-runtime`). It refuses to bundle a WSL runtime the
// app would refuse at import, or one a test or a dirty tree produced:
//   - the directory holds txresbench-wsl.tar and MANIFEST.json (scripts/build-wsl-rootfs.sh writes both);
//   - the tar's sha256 is the MANIFEST's, and so is its size in whole tar blocks;
//   - the MANIFEST's arch is the bundle's: --arch, else TAURI_ENV_ARCH, else the CPU of
//     TAURI_ENV_TARGET_TRIPLE (Tauri sets both for its build hooks);
//   - the version is "<MIN>-<MAX>-<16 hex>" with the MANIFEST's protocol range;
//   - the agent was not built from a test cache (build.agent_cargo_cache is null) and the tree was
//     committed (build.source_commit has no "+dirty"), unless TXR_WSL_RUNTIME_ALLOW_DEV=1.
//
//   node scripts/check-wsl-runtime.mjs [<dir>] [--arch x86_64|aarch64]
//     <dir> defaults to src-app/desktop/tauri/resources/wsl-runtime
// Exit 0 when the pair can be bundled, 1 with the reason otherwise, 2 on bad arguments.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARBALL = 'txresbench-wsl.tar';
const ARCHES = ['x86_64', 'aarch64'];

function fail(msg) {
  console.error(`check-wsl-runtime: ${msg}`);
  process.exit(1);
}
function usage() {
  console.error('usage: node scripts/check-wsl-runtime.mjs [<dir>] [--arch x86_64|aarch64]');
  process.exit(2);
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

const tarPath = path.join(dir, TARBALL);
const manifestPath = path.join(dir, 'MANIFEST.json');
for (const f of [tarPath, manifestPath]) {
  if (!fs.existsSync(f)) {
    fail(`${f} is missing: build it with \`sh scripts/build-wsl-rootfs.sh ${arch}\` before bundling for Windows`);
  }
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
if (m.arch !== arch) fail(`the WSL runtime is for ${m.arch}, the bundle for ${arch}: rebuild it with \`sh scripts/build-wsl-rootfs.sh ${arch}\``);
const [min, max] = Array.isArray(m.protocol) ? m.protocol : [];
if (!Number.isInteger(min) || !Number.isInteger(max) || typeof m.version !== 'string' ||
  !new RegExp(`^${min}-${max}-[0-9a-f]{16}$`).test(m.version)) {
  fail(`MANIFEST.json's version ${JSON.stringify(m.version)} does not match its protocol range ${JSON.stringify(m.protocol)}`);
}

if (process.env.TXR_WSL_RUNTIME_ALLOW_DEV !== '1') {
  const build = m.build ?? {};
  if (!('agent_cargo_cache' in build)) fail('MANIFEST.json does not say whether the agent came from a test cache; rebuild it');
  if (build.agent_cargo_cache !== null) {
    fail(`the agent was built from the test cache "${build.agent_cargo_cache}"; rebuild without TXR_GUEST_AGENT_CARGO_CACHE ` +
      '(or set TXR_WSL_RUNTIME_ALLOW_DEV=1 for a development bundle)');
  }
  if (typeof build.source_commit !== 'string' || !/^[0-9a-f]{40}$/.test(build.source_commit)) {
    fail(`the runtime was built from ${JSON.stringify(build.source_commit)}, not a committed tree; rebuild from a clean ` +
      'checkout (or set TXR_WSL_RUNTIME_ALLOW_DEV=1 for a development bundle)');
  }
}

console.log(`check-wsl-runtime: ${TARBALL} ${m.version} (${m.arch}, sha256 ${sha}) can be bundled`);
