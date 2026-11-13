#!/usr/bin/env node
// scripts/build-wsl-rootfs.test.mjs — the controls for `scripts/build-wsl-rootfs.sh` that need no Docker:
// its argument and notices refusals (they stop before any build step), the notices section it checks
// packages against, and the pinned build images it shares with the macOS guest root.
//
// The builds themselves (both arches: the tarball's file list and modes, wsl.conf, the markers, the
// agent's CPU and static linking, MANIFEST.json, the notices refusal after a real userland assembly,
// reproducibility, and a smoke run of the root's programs in a Linux container) are in
// `scripts/build-wsl-rootfs.docker.test.mjs`.
//
//   node --test scripts/build-wsl-rootfs.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO, 'scripts/build-wsl-rootfs.sh');
const HEADING = '## WSL runtime (Windows builds only)';

const TMPDIRS = [];
process.on('exit', () => {
  for (const d of TMPDIRS) fs.rmSync(d, { recursive: true, force: true });
});
function scratch(prefix) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), prefix));
  TMPDIRS.push(dir);
  return dir;
}

function run(args, env = {}) {
  const res = spawnSync('sh', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  return { status: res.status, out: res.stdout + res.stderr };
}

function loadThirdParty(probe) {
  return spawnSync(
    'python3',
    [
      '-I', '-c',
      'import importlib.util, json, sys\n' +
        'spec = importlib.util.spec_from_file_location("tp", sys.argv[1])\n' +
        'm = importlib.util.module_from_spec(spec); sys.modules["tp"] = m; spec.loader.exec_module(m)\n' +
        probe,
      path.join(REPO, 'scripts/third-party.py'),
    ],
    { encoding: 'utf8' },
  );
}

function noticesSection(text) {
  const start = text.indexOf(`\n${HEADING}\n`);
  if (start < 0) return null;
  const rest = text.slice(start + 1);
  const next = rest.indexOf('\n## ', HEADING.length);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

// ── arguments ────────────────────────────────────────────────────────────────

test('no arguments, an unknown arch or an unknown option: usage, exit 2', () => {
  for (const args of [[], ['arm64'], ['x86-64'], ['x86_64', '--bogus'], ['x86_64', '--out-dir']]) {
    const res = run(args);
    assert.equal(res.status, 2, `${JSON.stringify(args)}: ${res.out}`);
    assert.match(res.out, /usage: sh scripts\/build-wsl-rootfs\.sh <x86_64\|aarch64>/);
  }
});

test('a non-numeric SOURCE_DATE_EPOCH is refused before any build step', () => {
  const res = run(['x86_64', '--out-dir', scratch('wsl-rootfs-out-')], { SOURCE_DATE_EPOCH: '2026-01-01' });
  assert.equal(res.status, 1, res.out);
  assert.match(res.out, /SOURCE_DATE_EPOCH must be a number of seconds/);
});

test('a notices file without the WSL package list is refused before any build step', () => {
  const dir = scratch('wsl-rootfs-notices-');
  const out = path.join(dir, 'out');
  const work = path.join(dir, 'work');
  const notices = path.join(dir, 'NOTICES.md');
  // the macOS section alone does not count
  const real = fs.readFileSync(path.join(REPO, 'THIRD-PARTY-NOTICES.md'), 'utf8');
  fs.writeFileSync(notices, real.replace(noticesSection(real), ''));
  const res = run(['x86_64', '--out-dir', out, '--work-dir', work, '--notices', notices]);
  assert.equal(res.status, 1, res.out);
  assert.match(res.out, /has no package list under "## WSL runtime \(Windows builds only\)"/);
  assert.equal(fs.existsSync(out), false, 'nothing is created');
  assert.equal(fs.existsSync(work), false, 'nothing is created');

  const missing = run(['x86_64', '--notices', path.join(dir, 'absent.md')]);
  assert.equal(missing.status, 1, missing.out);
  assert.match(missing.out, /no notices file at .*absent\.md/);
});

test('the build writes into the Windows bundle resource by default', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(src, /^OUT=\$ROOT\/src-app\/desktop\/tauri\/resources\/wsl-runtime$/m);
  assert.match(src, /^TARBALL=txresbench-wsl\.tar$/m);
});

// ── notices ──────────────────────────────────────────────────────────────────

test('THIRD-PARTY-NOTICES.md carries the WSL runtime section exactly as the generator renders it', () => {
  const res = loadThirdParty('print("\\n".join(m.render_wsl_runtime()))');
  assert.equal(res.status, 0, res.stderr);
  const rendered = res.stdout.replace(/\n$/, '');
  const notices = fs.readFileSync(path.join(REPO, 'THIRD-PARTY-NOTICES.md'), 'utf8');
  const section = noticesSection(notices);
  assert.ok(section, 'the notices carry the WSL section');
  assert.equal(section.replace(/\n+$/, ''), rendered.replace(/\n+$/, ''));
  // after the macOS runtime, before the licence texts (where render_notices puts it)
  const at = notices.indexOf(`\n${HEADING}\n`);
  assert.ok(notices.indexOf('\n## macOS method-VM runtime') < at);
  assert.ok(at < notices.indexOf('\n## Licence texts\n'));
});

test('the generator places the WSL section after the macOS runtime in a full render', () => {
  const res = loadThirdParty(
    'text = m.render_notices([], [], [], [])\n' +
      'print(json.dumps([text.index("## macOS method-VM runtime"), text.index("## WSL runtime (Windows builds only)"), text.index("## Licence texts")]))',
  );
  assert.equal(res.status, 0, res.stderr);
  const [mac, wsl, texts] = JSON.parse(res.stdout);
  assert.ok(mac < wsl && wsl < texts, res.stdout);
});

test('every WSL notices line names packages and one licence, with no package listed twice', () => {
  const res = loadThirdParty('print(json.dumps(m.WSL_ALPINE_PACKAGES))');
  assert.equal(res.status, 0, res.stderr);
  const seen = new Set();
  for (const [names, licence] of JSON.parse(res.stdout)) {
    assert.ok(licence && !licence.includes(' — '), licence);
    for (const n of names.split(', ')) {
      assert.match(n, /^[a-z0-9][a-z0-9._+-]*$/, `"${n}" is a bare package name`);
      assert.ok(!seen.has(n), `${n} is listed once`);
      seen.add(n);
    }
  }
  // what the root is built from must be listed
  for (const n of ['busybox', 'bubblewrap', 'squashfuse', 'fuse3', 'musl', 'alpine-baselayout', 'alpine-keys']) {
    assert.ok(seen.has(n), n);
  }
});

// ── shared build images ──────────────────────────────────────────────────────

test('the guest-root helper pins one image per arch by manifest digest', () => {
  const helper = path.join(REPO, 'scripts/guest-root-common.sh');
  const res = spawnSync('sh', ['-c',
    `. "${helper}"; for a in x86_64 aarch64; do guest_platform $a; guest_alpine_image $a; guest_rust_image $a; done; ` +
      'guest_arch_ok arm64 && echo BAD || echo refused'], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const [p1, a1, r1, p2, a2, r2, refused] = res.stdout.trim().split('\n');
  assert.deepEqual([p1, p2], ['linux/amd64', 'linux/arm64']);
  for (const img of [a1, a2]) assert.match(img, /^alpine:3\.20@sha256:[0-9a-f]{64}$/);
  for (const img of [r1, r2]) assert.match(img, /^rust:1\.90-alpine3\.20@sha256:[0-9a-f]{64}$/);
  assert.notEqual(a1, a2);
  assert.notEqual(r1, r2);
  assert.equal(refused, 'refused');
});

test('the macOS guest root builds its agent through the shared helper, for aarch64', () => {
  const src = fs.readFileSync(path.join(REPO, 'scripts/build-macos-vm-guest-root.sh'), 'utf8');
  assert.match(src, /^\. "\$ROOT\/scripts\/guest-root-common\.sh"$/m);
  assert.match(src, /^guest_build_agent "\$ROOT" aarch64 "\$STAGE\.agent"/m);
  assert.match(src, /^ALPINE_IMAGE=\$\(guest_alpine_image aarch64\)$/m);
  assert.doesNotMatch(src, /docker run --rm --platform linux\/arm64 -v "\$ROOT:\/work:ro"/, 'no second copy of the agent build');
});

test('the agent protocol range is read from the protocol crate', () => {
  const lib = fs.readFileSync(path.join(REPO, 'sdk/crates/sandbox-vm-protocol/src/lib.rs'), 'utf8');
  const max = lib.match(/^pub const PROTOCOL_VERSION: u32 = (\d+);$/m)[1];
  const min = lib.match(/^pub const PROTOCOL_VERSION_MIN: u32 = (\d+);$/m)[1];
  const res = spawnSync('sh', ['-c',
    `. "${path.join(REPO, 'scripts/guest-root-common.sh')}"; guest_protocol_range "$1" && echo "$GUEST_PROTOCOL_MIN $GUEST_PROTOCOL_MAX"`,
    'sh', REPO], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), `${min} ${max}`);

  const bad = spawnSync('sh', ['-c',
    `. "${path.join(REPO, 'scripts/guest-root-common.sh')}"; guest_protocol_range "$1"`, 'sh', scratch('wsl-rootfs-proto-')],
  { encoding: 'utf8' });
  assert.notEqual(bad.status, 0);
});
