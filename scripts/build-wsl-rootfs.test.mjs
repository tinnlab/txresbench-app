#!/usr/bin/env node
// scripts/build-wsl-rootfs.test.mjs — the controls for `scripts/build-wsl-rootfs.sh` that need no Docker:
// its argument and notices refusals (they stop before any build step); with a stand-in `docker` on PATH,
// the notices check in both directions and what each later step's failure leaves (the previous outputs,
// no run directory); the Windows-only bundling of its output (tauri.windows.conf.json, .gitignore,
// .gitkeep) and the check run before a Windows bundle (scripts/check-wsl-runtime.mjs); the notices
// section it checks packages against; and the pinned build images it shares with the macOS guest root.
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
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO, 'scripts/build-wsl-rootfs.sh');
const CHECK = path.join(REPO, 'scripts/check-wsl-runtime.mjs');
const TAURI = path.join(REPO, 'src-app/desktop/tauri');
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

/** The tauri.<platform>.conf.json merge Tauri applies (tauri-utils `config::parse::read_from`): a JSON
 *  Merge Patch (RFC 7396) of the platform file over tauri.conf.json, so a platform file's array REPLACES
 *  the base array. */
function mergePatch(target, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = target !== null && typeof target === 'object' && !Array.isArray(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  }
  return out;
}
/** The merged config for a target (`macos`, `windows`, `linux`); without one, tauri.conf.json's. */
function configFor(platform) {
  const base = JSON.parse(fs.readFileSync(path.join(TAURI, 'tauri.conf.json'), 'utf8'));
  const file = platform && path.join(TAURI, `tauri.${platform}.conf.json`);
  return file && fs.existsSync(file) ? mergePatch(base, JSON.parse(fs.readFileSync(file, 'utf8'))) : base;
}
const bundleFor = (platform) => configFor(platform).bundle;

function git(...args) {
  const res = spawnSync('git', ['-C', REPO, ...args], { encoding: 'utf8' });
  return { status: res.status, out: res.stdout.trim() };
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

// ── bundling: Windows only ───────────────────────────────────────────────────

test('the Windows bundle adds resources/wsl-runtime and keeps every base resource', () => {
  const base = bundleFor();
  const win = bundleFor('windows');
  assert.deepEqual(win.resources, [...base.resources, 'resources/wsl-runtime']);
  // the platform file changes nothing else in the bundle
  assert.deepEqual({ ...win, resources: undefined }, { ...base, resources: undefined });
  const winFile = JSON.parse(fs.readFileSync(path.join(TAURI, 'tauri.windows.conf.json'), 'utf8'));
  assert.deepEqual(Object.keys(winFile).sort(), ['$schema', 'build', 'bundle']);
  assert.deepEqual(Object.keys(winFile.bundle), ['resources']);
});

test('a Windows bundle is made only after the WSL runtime check passes', () => {
  const base = configFor().build;
  const win = configFor('windows').build;
  assert.deepEqual(win, { ...base, beforeBundleCommand: 'npm run check-wsl-runtime' });
  for (const platform of ['macos', 'linux', undefined]) {
    assert.equal(configFor(platform).build.beforeBundleCommand, undefined, `${platform}: no WSL check`);
  }
  // the npm script resolves the way the build's own `npm run fetch-oras` does: from the root package.json
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['check-wsl-runtime'], 'node scripts/check-wsl-runtime.mjs');
  assert.equal(pkg.scripts['fetch-oras'], 'node scripts/fetch-oras.mjs');
});

test('the macOS and Linux bundles do not carry the WSL runtime', () => {
  for (const platform of ['macos', 'linux', undefined]) {
    const resources = bundleFor(platform).resources ?? [];
    assert.ok(!resources.some((r) => r.includes('wsl')), `${platform}: ${resources}`);
  }
  // the macOS bundle is exactly what main ships
  assert.deepEqual(bundleFor('macos').resources, ['resources/pretrained-bundled', 'resources/sandbox-vm-runtime']);
});

test('only the .gitkeep of resources/wsl-runtime is tracked; the build outputs are ignored', () => {
  assert.equal(git('ls-files', 'src-app/desktop/tauri/resources/wsl-runtime').out,
    'src-app/desktop/tauri/resources/wsl-runtime/.gitkeep');
  for (const f of ['txresbench-wsl.tar', 'MANIFEST.json']) {
    const res = git('check-ignore', '-q', `src-app/desktop/tauri/resources/wsl-runtime/${f}`);
    assert.equal(res.status, 0, `${f} is ignored`);
  }
  assert.notEqual(git('check-ignore', '-q', 'src-app/desktop/tauri/resources/wsl-runtime/.gitkeep').status, 0);
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

test('the guest-root helper pins one image per arch by digest, and names the index each comes from', () => {
  // That each pin is its platform's entry of the index is checked against the registry by the Docker test.
  const helper = path.join(REPO, 'scripts/guest-root-common.sh');
  const res = spawnSync('sh', ['-c',
    `. "${helper}"; for a in x86_64 aarch64; do guest_platform $a; guest_alpine_image $a; guest_rust_image $a; done; ` +
      'echo "$GUEST_ALPINE_INDEX"; echo "$GUEST_RUST_INDEX"; guest_arch_ok arm64 && echo BAD || echo refused'],
  { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const [p1, a1, r1, p2, a2, r2, alpineIndex, rustIndex, refused] = res.stdout.trim().split('\n');
  assert.deepEqual([p1, p2], ['linux/amd64', 'linux/arm64']);
  for (const img of [a1, a2, alpineIndex]) assert.match(img, /^alpine:3\.20@sha256:[0-9a-f]{64}$/);
  for (const img of [r1, r2, rustIndex]) assert.match(img, /^rust:1\.90-alpine3\.20@sha256:[0-9a-f]{64}$/);
  assert.equal(new Set([a1, a2, alpineIndex]).size, 3);
  assert.equal(new Set([r1, r2, rustIndex]).size, 3);
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

// ── the build's later steps, with a stand-in docker ──────────────────────────

/** A fake `docker` on PATH: `docker info` succeeds, and each `docker run` is told apart by the step it is
 *  (the userland, the agent, the assembly) and acts as STUB_<STEP> says: ok (the default), fail, or for
 *  the assembly empty (writes nothing) or badsha (a result whose sha256 is not the tar's). Every run's step
 *  is appended to $STUB_LOG. The userland's apk database is $STUB_INSTALLED. */
const STUB = `#!/bin/sh
[ "$1" = info ] && exit 0
[ "$1" = run ] || { echo "stub docker: $*" >&2; exit 1; }
w= step=
for a; do
  case "$a" in
    *:/w) w=\${a%:/w} ;;
    PACKAGES=*) step=userland ;;
    GUEST_TRIPLE=*) step=agent ;;
    PMIN=*) step=assemble ;;
  esac
done
echo "$step" >> "$STUB_LOG"
case "$step" in
  userland) mode=\${STUB_USERLAND:-ok} ;;
  agent) mode=\${STUB_AGENT:-ok} ;;
  assemble) mode=\${STUB_ASSEMBLE:-ok} ;;
  *) echo "stub docker: which step is this? $*" >&2; exit 1 ;;
esac
[ "$mode" = fail ] && { echo "stub docker: $step fails" >&2; exit 1; }
case "$step" in
  userland) : > "$w/userland.tar"; cp "$STUB_INSTALLED" "$w/installed" ;;
  agent)
    d=$(mktemp -d)
    printf 'agent' > "$d/txresbench-sandbox-agent"
    echo 'rustc 1.90.0' > "$d/agent-build.txt"
    tar -C "$d" -cf - txresbench-sandbox-agent agent-build.txt
    rm -rf "$d" ;;
  assemble)
    [ "$mode" = empty ] && exit 0
    printf 'new-tar' > "$w/txresbench-wsl.tar"
    printf 'new-manifest' > "$w/MANIFEST.json"
    if [ "$mode" = badsha ]; then
      sha=0000000000000000000000000000000000000000000000000000000000000000
    else
      sha=$(sha256sum "$w/txresbench-wsl.tar" 2>/dev/null || shasum -a 256 "$w/txresbench-wsl.tar")
      sha=\${sha%% *}
    fi
    echo "3-3-0123456789abcdef $sha" > "$w/result" ;;
esac
`;

/** The apk database of a root holding exactly the packages the notices list (as `P:`/`V:`/`L:` records),
 *  with `edit` applied to the records. */
function installedDb(edit = (records) => records) {
  const res = loadThirdParty('print(json.dumps(m.WSL_ALPINE_PACKAGES))');
  assert.equal(res.status, 0, res.stderr);
  const records = [];
  for (const [names, licence] of JSON.parse(res.stdout)) {
    for (const name of names.split(', ')) records.push({ P: name, V: '1.0-r0', L: licence });
  }
  return edit(records).map((r) => Object.entries(r).map(([k, v]) => `${k}:${v}`).join('\n')).join('\n\n') + '\n\n';
}

/** One build with the stand-in docker into a fresh directory whose out-dir holds a previous pair. */
function stubBuild({ env = {}, installed = installedDb(), notices } = {}) {
  const dir = scratch('wsl-rootfs-stub-');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'docker'), STUB, { mode: 0o755 });
  const out = path.join(dir, 'out');
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'txresbench-wsl.tar'), 'old-tar');
  fs.writeFileSync(path.join(out, 'MANIFEST.json'), 'old-manifest');
  fs.writeFileSync(path.join(dir, 'installed'), installed);
  const args = ['x86_64', '--out-dir', out, '--work-dir', path.join(dir, 'work')];
  if (notices !== undefined) {
    fs.writeFileSync(path.join(dir, 'NOTICES.md'), notices);
    args.push('--notices', path.join(dir, 'NOTICES.md'));
  }
  const res = run(args, {
    PATH: `${bin}:${process.env.PATH}`,
    STUB_LOG: path.join(dir, 'steps'),
    STUB_INSTALLED: path.join(dir, 'installed'),
    TXR_GUEST_AGENT_CARGO_CACHE: '',
    ...env,
  });
  const read = (f) => fs.readFileSync(path.join(out, f), 'utf8');
  const steps = fs.existsSync(path.join(dir, 'steps')) ? fs.readFileSync(path.join(dir, 'steps'), 'utf8').trim().split('\n') : [];
  return { ...res, steps, tar: read('txresbench-wsl.tar'), manifest: read('MANIFEST.json'), work: fs.readdirSync(path.join(dir, 'work')) };
}

function assertKept(r) {
  assert.equal(r.tar, 'old-tar', 'the previous tarball is kept');
  assert.equal(r.manifest, 'old-manifest', 'the previous MANIFEST.json is kept');
  assert.deepEqual(r.work, [], 'the run directory is removed');
}

test('with every step succeeding, the outputs are replaced and the run directory removed', () => {
  const r = stubBuild();
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.steps, ['userland', 'agent', 'assemble']);
  assert.equal(r.tar, 'new-tar');
  assert.equal(r.manifest, 'new-manifest');
  assert.deepEqual(r.work, []);
});

test('a failing agent build or assembly keeps the previous outputs', () => {
  for (const [env, steps, want] of [
    [{ STUB_USERLAND: 'fail' }, ['userland'], /assembling the Alpine userland failed/],
    [{ STUB_AGENT: 'fail' }, ['userland', 'agent'], /the guest agent build failed/],
    [{ STUB_ASSEMBLE: 'fail' }, ['userland', 'agent', 'assemble'], /assembling the root failed/],
    [{ STUB_ASSEMBLE: 'empty' }, ['userland', 'agent', 'assemble'], /the archive step wrote no output/],
    [{ STUB_ASSEMBLE: 'badsha' }, ['userland', 'agent', 'assemble'], /the archive's sha256 does not match what the container computed/],
  ]) {
    const r = stubBuild({ env });
    assert.equal(r.status, 1, `${JSON.stringify(env)}: ${r.out}`);
    assert.match(r.out, want);
    assert.deepEqual(r.steps, steps, JSON.stringify(env));
    assertKept(r);
  }
});

test('the notices must name every package of the root with its licence, and nothing the root lacks', () => {
  const real = fs.readFileSync(path.join(REPO, 'THIRD-PARTY-NOTICES.md'), 'utf8');
  // an edit of the WSL section only (other sections list some of the same packages)
  const inWsl = (from, to) => {
    const section = noticesSection(real);
    assert.ok(section.includes(from), from);
    return real.replace(section, section.replace(from, to));
  };
  const cases = [
    // a package the notices do not name
    [{ installed: installedDb((r) => [...r, { P: 'extra-lib', V: '1', L: 'MIT' }]) },
      /packages missing from .*: extra-lib \(MIT\)/],
    // a package without a licence record does not take the one before it
    [{ installed: installedDb((r) => [...r, { P: 'zzz-unlicensed', V: '1' }]) },
      /packages missing from .*: zzz-unlicensed \(no licence recorded\)/],
    // a package the notices name but the root does not have
    [{ notices: inWsl('  - musl — MIT\n', '  - musl — MIT\n  - not-in-the-root — MIT\n') },
      /lists packages the root does not have .*: not-in-the-root$/m],
    // words of a notices line are not package names: only ", " separates them
    [{ notices: inWsl('  - squashfuse — BSD-2-Clause\n', '  - squashfuse busybox — BSD-2-Clause\n') },
      /packages missing from .*squashfuse \(BSD-2-Clause\)/],
  ];
  for (const [opts, want] of cases) {
    if (opts.notices) assert.notEqual(opts.notices, real, 'the fixture differs from the real notices');
    const r = stubBuild(opts);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, want);
    assert.deepEqual(r.steps, ['userland'], 'refused before the agent build');
    assertKept(r);
  }
  // the real notices pass
  assert.equal(stubBuild().status, 0);
});

// ── the check before a Windows bundle ────────────────────────────────────────

function checkRun(args, env = {}) {
  const res = spawnSync(process.execPath, [CHECK, ...args], {
    encoding: 'utf8',
    env: { ...process.env, TAURI_ENV_ARCH: '', TAURI_ENV_TARGET_TRIPLE: '', TXR_WSL_RUNTIME_ALLOW_DEV: '', ...env },
  });
  return { status: res.status, out: res.stdout + res.stderr };
}

/** A runtime directory with a tarball of `blocks` tar blocks and the MANIFEST.json a release build writes,
 *  `edit` applied to it. */
function runtimeDir({ blocks = 4, edit = (m) => m } = {}) {
  const dir = scratch('wsl-runtime-');
  const tar = Buffer.alloc(blocks * 512);
  tar.write('a tar');
  fs.writeFileSync(path.join(dir, 'txresbench-wsl.tar'), tar);
  const manifest = edit({
    version: '3-3-0123456789abcdef',
    arch: 'x86_64',
    sha256: crypto.createHash('sha256').update(tar).digest('hex'),
    protocol: [3, 3],
    packages: [],
    build: { agent_cargo_cache: null, source_commit: 'a'.repeat(40) },
  });
  fs.writeFileSync(path.join(dir, 'MANIFEST.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  return dir;
}

test('the bundle check takes a release pair for the bundle\'s CPU, from --arch or from Tauri', () => {
  const dir = runtimeDir();
  for (const [args, env] of [
    [['--arch', 'x86_64'], {}],
    [[], { TAURI_ENV_ARCH: 'x86_64' }],
    [[], { TAURI_ENV_TARGET_TRIPLE: 'x86_64-pc-windows-msvc' }],
  ]) {
    const r = checkRun([dir, ...args], env);
    assert.equal(r.status, 0, `${JSON.stringify([args, env])}: ${r.out}`);
    assert.match(r.out, /txresbench-wsl\.tar 3-3-0123456789abcdef \(x86_64, sha256 [0-9a-f]{64}\) can be bundled/);
  }
});

test('the bundle check refuses a missing, mismatched or foreign pair', () => {
  const cases = [
    [runtimeDir(), ['--arch', 'aarch64'], {}, /the WSL runtime is for x86_64, the bundle for aarch64/],
    [runtimeDir(), [], {}, /cannot tell the bundle's CPU/],
    [runtimeDir(), [], { TAURI_ENV_ARCH: 'i686' }, /the bundle's CPU "i686" has no WSL runtime/],
    [runtimeDir({ edit: (m) => ({ ...m, sha256: '0'.repeat(64) }) }), ['--arch', 'x86_64'], {},
      /is not the one MANIFEST\.json describes/],
    [runtimeDir({ edit: (m) => ({ ...m, protocol: [3, 4] }) }), ['--arch', 'x86_64'], {},
      /version "3-3-0123456789abcdef" does not match its protocol range \[3,4\]/],
    [runtimeDir({ edit: () => 'not json' }), ['--arch', 'x86_64'], {}, /MANIFEST\.json is not JSON/],
  ];
  for (const [dir, args, env, want] of cases) {
    const r = checkRun([dir, ...args], env);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, want);
  }
  // a tarball that is not whole tar blocks, even with its sha256 in the MANIFEST
  const dir = scratch('wsl-runtime-');
  fs.writeFileSync(path.join(dir, 'txresbench-wsl.tar'), 'short');
  fs.writeFileSync(path.join(dir, 'MANIFEST.json'), JSON.stringify({
    version: '3-3-0123456789abcdef', arch: 'x86_64', protocol: [3, 3],
    sha256: crypto.createHash('sha256').update('short').digest('hex'),
    build: { agent_cargo_cache: null, source_commit: 'a'.repeat(40) },
  }));
  const short = checkRun([dir, '--arch', 'x86_64']);
  assert.equal(short.status, 1, short.out);
  assert.match(short.out, /is not a whole tar \(5 bytes\)/);
  // either file missing
  for (const f of ['txresbench-wsl.tar', 'MANIFEST.json']) {
    const d = runtimeDir();
    fs.rmSync(path.join(d, f));
    const r = checkRun([d, '--arch', 'x86_64']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, new RegExp(`${f.replace('.', '\\.')} is missing: build it with \`sh scripts/build-wsl-rootfs\\.sh x86_64\``));
  }
  // the default directory is the Windows bundle's resource, which holds only .gitkeep in the tree
  const def = checkRun(['--arch', 'x86_64']);
  assert.equal(def.status, 1, def.out);
  assert.match(def.out, /src-app\/desktop\/tauri\/resources\/wsl-runtime\/txresbench-wsl\.tar is missing/);
});

test('the bundle check refuses a test-cache agent or a dirty tree unless the bundle is for development', () => {
  for (const [edit, want] of [
    [(m) => ({ ...m, build: { ...m.build, agent_cargo_cache: 'txr-cache' } }), /the agent was built from the test cache "txr-cache"/],
    [(m) => ({ ...m, build: { ...m.build, source_commit: `${'a'.repeat(40)}+dirty` } }), /not a committed tree/],
    [(m) => ({ ...m, build: { source_commit: 'a'.repeat(40) } }), /does not say whether the agent came from a test cache/],
  ]) {
    const dir = runtimeDir({ edit });
    const r = checkRun([dir, '--arch', 'x86_64']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, want);
    const dev = checkRun([dir, '--arch', 'x86_64'], { TXR_WSL_RUNTIME_ALLOW_DEV: '1' });
    assert.equal(dev.status, 0, dev.out);
  }
});

test('the bundle check refuses bad arguments with exit 2', () => {
  for (const args of [['--arch', 'arm64'], ['--arch'], ['--bogus']]) {
    const r = checkRun(args);
    assert.equal(r.status, 2, `${JSON.stringify(args)}: ${r.out}`);
    assert.match(r.out, /usage: node scripts\/check-wsl-runtime\.mjs/);
  }
});
