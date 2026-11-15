#!/usr/bin/env node
// scripts/build-wsl-rootfs.docker.test.mjs — builds the WSL guest root with
// `scripts/build-wsl-rootfs.sh` and checks what the Windows app will import (the contract in the
// script's header):
//   - the tar's entries, types, modes and owners, read here from its bytes (no host tar); it is a plain
//     tar, not compressed;
//   - /etc/wsl.conf, /etc/txresbench-agent-protocol and /etc/txresbench-wsl-version;
//   - the agent, bwrap, busybox and squashfuse are ELF binaries for the tarball's CPU; the agent is static;
//   - /etc/shadow: no date but the epoch's day, and root has no password;
//   - MANIFEST.json: its keys, the tarball's sha256, the protocol range, every Alpine package of the root's
//     apk database with its version and licence, exactly the packages the notices name, and the test cache
//     the agent came from;
//   - scripts/check-wsl-runtime.mjs (run before a Windows bundle) takes the pair, and refuses one whose
//     agent came from a test cache;
//   - the notices refusal, after a real userland assembly, leaves the previous outputs alone;
//   - a second build of the same tree, its agent built afresh without the cache, gives the same bytes;
//   - in a Linux container of the tarball's platform, chrooted into the unpacked root: `bwrap --version`,
//     `squashfuse --help`, the agent's `--pipe-selftest`, and, privileged, squashfuse mounting a squashfs
//     image as the agent's WSL mode does (`-o ro,allow_other`), which a bwrap sandbox then reads as uid
//     1001 in a user namespace (the root entered with pivot_root);
//   - the pinned build images are the linux/amd64 and linux/arm64 entries of the indexes
//     scripts/guest-root-common.sh names (read from the registry).
//
// Needs Docker (linux/amd64 and linux/arm64) and network for the build's downloads; a build takes minutes,
// so the tests run only with TXR_WSL_ROOTFS_DOCKER_TEST=1 (a `node --test` over every *.test.mjs skips
// them). The agent's cargo registry and target dir live in Docker volumes named for this run
// (txr-wsl-rootfs-test-<arch>-<run>-*), removed at the end.
//
//   TXR_WSL_ROOTFS_DOCKER_TEST=1 TMPDIR=<scratch> node --test scripts/build-wsl-rootfs.docker.test.mjs
//   TXR_WSL_ROOTFS_ARCHES="x86_64" ...    (default: "x86_64 aarch64")

import nodeTest, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO, 'scripts/build-wsl-rootfs.sh');
const HELPER = path.join(REPO, 'scripts/guest-root-common.sh');
const CHECK = path.join(REPO, 'scripts/check-wsl-runtime.mjs');
const ARCHES = (process.env.TXR_WSL_ROOTFS_ARCHES || 'x86_64 aarch64').split(/\s+/).filter(Boolean);
const ELF_MACHINE = { x86_64: 0x3e, aarch64: 0xb7 };
const HEADING = '## WSL runtime (Windows builds only)';
const EPOCH = 1767225600;
const RUN_ID = `${process.pid}-${crypto.randomBytes(3).toString('hex')}`;

// Only on request: every test here builds, or reads what was built.
const ENABLED = process.env.TXR_WSL_ROOTFS_DOCKER_TEST === '1';
const SKIP = 'builds the WSL root with Docker: set TXR_WSL_ROOTFS_DOCKER_TEST=1 to run it';
function test(name, opts, fn) {
  if (typeof opts === 'function') [opts, fn] = [{}, opts];
  return nodeTest(name, ENABLED ? opts : { ...opts, skip: SKIP }, fn);
}

const TMPDIRS = [];
const VOLUMES = [];
process.on('exit', () => {
  for (const d of TMPDIRS) fs.rmSync(d, { recursive: true, force: true });
});
after(() => {
  for (const v of VOLUMES) spawnSync('docker', ['volume', 'rm', '-f', v], { encoding: 'utf8' });
});
function scratch(prefix) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), prefix));
  TMPDIRS.push(dir);
  return dir;
}

function sh(cmd, args = []) {
  const res = spawnSync('sh', ['-c', cmd, 'sh', ...args], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout.trim();
}
const platformOf = (arch) => sh(`. "${HELPER}"; guest_platform "$1"`, [arch]);
const alpineImageOf = (arch) => sh(`. "${HELPER}"; guest_alpine_image "$1"`, [arch]);
const rustImageOf = (arch) => sh(`. "${HELPER}"; guest_rust_image "$1"`, [arch]);
const cacheOf = (arch) => `txr-wsl-rootfs-test-${arch}-${RUN_ID}`;

/** One build into `outDir`. With `cache` (the default) the agent's cargo registry and target dir live in
 *  this run's volumes; `cache: false` builds the agent from nothing, as a release does. */
function build(arch, outDir, extra = [], { cache = true } = {}) {
  const env = { ...process.env };
  delete env.SOURCE_DATE_EPOCH; // the tests expect the script's own epoch
  delete env.TXR_GUEST_AGENT_CARGO_CACHE;
  if (cache) {
    env.TXR_GUEST_AGENT_CARGO_CACHE = cacheOf(arch);
    for (const v of [`${cacheOf(arch)}-registry`, `${cacheOf(arch)}-target`]) if (!VOLUMES.includes(v)) VOLUMES.push(v);
  }
  const res = spawnSync('sh', [SCRIPT, arch, '--out-dir', outDir, '--work-dir', path.join(outDir, '..', 'work'), ...extra], {
    encoding: 'utf8',
    env,
    maxBuffer: 256 * 1024 * 1024,
  });
  return { status: res.status, out: res.stdout + res.stderr };
}

/** scripts/check-wsl-runtime.mjs over `dir` for `arch`. */
function checkRuntime(dir, arch, env = {}) {
  const res = spawnSync(process.execPath, [CHECK, dir, '--arch', arch], {
    encoding: 'utf8',
    env: { ...process.env, TXR_WSL_RUNTIME_ALLOW_DEV: '', ...env },
  });
  return { status: res.status, out: res.stdout + res.stderr };
}

function docker(args, input) {
  const res = spawnSync('docker', args, { input, maxBuffer: 64 * 1024 * 1024 });
  return { status: res.status, stdout: res.stdout, out: res.stdout.toString() + res.stderr.toString() };
}

// ── a minimal tar reader (ustar + GNU long names) ────────────────────────────

function octal(buf, off, len) {
  const s = buf.toString('latin1', off, off + len).replace(/\0.*$/s, '').trim();
  return s === '' ? 0 : parseInt(s, 8);
}
function readTar(tar) {
  const entries = new Map();
  let off = 0;
  let longName = null;
  let longLink = null;
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const size = octal(h, 124, 12);
    const type = String.fromCharCode(h[156] || 0x30);
    const data = tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = data.toString('utf8').replace(/\0+$/, ''); continue; }
    if (type === 'K') { longLink = data.toString('utf8').replace(/\0+$/, ''); continue; }
    const magic = h.toString('latin1', 257, 263);
    const prefix = magic === 'ustar\0' ? h.toString('utf8', 345, 500).replace(/\0.*$/s, '') : '';
    let name = longName ?? (prefix ? `${prefix}/` : '') + h.toString('utf8', 0, 100).replace(/\0.*$/s, '');
    const link = longLink ?? h.toString('utf8', 157, 257).replace(/\0.*$/s, '');
    longName = longLink = null;
    name = name.replace(/\/$/, '');
    assert.ok(!entries.has(name), `${name} appears once`);
    entries.set(name, {
      name, type, link, data,
      mode: octal(h, 100, 8), uid: octal(h, 108, 8), gid: octal(h, 116, 8), mtime: octal(h, 136, 12),
    });
  }
  return entries;
}

// ── ELF ──────────────────────────────────────────────────────────────────────

function elf(buf) {
  assert.ok(buf.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])), 'ELF magic');
  assert.equal(buf[4], 2, 'ELFCLASS64');
  assert.equal(buf[5], 1, 'little-endian');
  const machine = buf.readUInt16LE(18);
  const phoff = Number(buf.readBigUInt64LE(32));
  const phentsize = buf.readUInt16LE(54);
  const phnum = buf.readUInt16LE(56);
  let interp = false;
  const needed = [];
  for (let i = 0; i < phnum; i++) {
    const p = phoff + i * phentsize;
    const type = buf.readUInt32LE(p);
    if (type === 3) interp = true; // PT_INTERP
    if (type === 2) { // PT_DYNAMIC: look for DT_NEEDED
      const at = Number(buf.readBigUInt64LE(p + 8));
      const len = Number(buf.readBigUInt64LE(p + 32));
      for (let d = at; d + 16 <= at + len; d += 16) {
        const tag = buf.readBigInt64LE(d);
        if (tag === 0n) break;
        if (tag === 1n) needed.push(buf.readBigUInt64LE(d + 8));
      }
    }
  }
  return { machine, interp, needed: needed.length };
}

function ini(text) {
  const out = {};
  let section = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const s = line.match(/^\[([a-z]+)\]$/);
    if (s) { section = s[1]; assert.ok(!(section in out), `[${section}] once`); out[section] = {}; continue; }
    const kv = line.match(/^([A-Za-z]+)=(\S+)$/);
    assert.ok(kv && section, `"${line}" is key=value inside a section`);
    assert.ok(!(kv[1] in out[section]), `${section}.${kv[1]} once`);
    out[section][kv[1]] = kv[2];
  }
  return out;
}

function protocolRange() {
  const lib = fs.readFileSync(path.join(REPO, 'sdk/crates/sandbox-vm-protocol/src/lib.rs'), 'utf8');
  return [
    Number(lib.match(/^pub const PROTOCOL_VERSION_MIN: u32 = (\d+);$/m)[1]),
    Number(lib.match(/^pub const PROTOCOL_VERSION: u32 = (\d+);$/m)[1]),
  ];
}

function noticeLines(text) {
  const lines = text.split('\n');
  const start = lines.indexOf(HEADING);
  assert.ok(start >= 0);
  const out = [];
  for (const l of lines.slice(start + 1)) {
    if (l.startsWith('## ')) break;
    if (l.startsWith('  - ')) out.push(l);
  }
  return out;
}
function noticesCover(text) {
  const covered = new Map();
  for (const l of noticeLines(text)) {
    const [names, licence] = l.slice(4).split(' — ');
    for (const n of names.split(', ')) covered.set(n, licence);
  }
  return covered;
}

/** /etc/shadow's lines as field arrays. */
function shadow(entry) {
  return entry.data.toString('utf8').split('\n').filter(Boolean).map((l) => l.split(':'));
}

function apkDb(text) {
  const pkgs = [];
  for (const rec of text.split(/\n\n+/)) {
    const f = Object.fromEntries(rec.split('\n').filter((l) => /^[A-Za-z]:/.test(l)).map((l) => [l[0], l.slice(2)]));
    if (f.P) pkgs.push({ name: f.P, version: f.V, license: f.L });
  }
  return pkgs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

const MODES = {
  'usr/bin/txresbench-sandbox-agent': 0o755,
  'etc/wsl.conf': 0o644,
  'etc/txresbench-agent-protocol': 0o644,
  'etc/txresbench-wsl-version': 0o644,
  'sandbox-rootfs': 0o755,
  'sandbox-layer': 0o755,
  'host-mounts': 0o755,
  workspace: 0o755,
  tmp: 0o1777,
};

// ── the builds ───────────────────────────────────────────────────────────────

const built = {};

for (const arch of ARCHES) {
  test(`${arch}: the build writes the tarball and MANIFEST.json`, { timeout: 60 * 60 * 1000 }, () => {
    const dir = scratch(`wsl-rootfs-${arch}-`);
    const out = path.join(dir, 'out');
    const res = build(arch, out);
    assert.equal(res.status, 0, res.out.slice(-4000));
    assert.deepEqual(fs.readdirSync(out).sort(), ['MANIFEST.json', 'txresbench-wsl.tar']);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'work')), [], 'the run directory is removed');
    const tar = fs.readFileSync(path.join(out, 'txresbench-wsl.tar'));
    built[arch] = { dir, out, tar, manifest: JSON.parse(fs.readFileSync(path.join(out, 'MANIFEST.json'), 'utf8')), entries: readTar(tar) };
    const m = built[arch].manifest;
    console.log(`# ${arch}: version ${m.version}, sha256 ${m.sha256}, ${tar.length} bytes, ` +
      `${built[arch].entries.size} entries, ${m.packages.length} packages`);
  });

  test(`${arch}: the tarball's entries, types, modes and owners`, () => {
    const b = built[arch];
    assert.ok(b, 'built');
    const e = b.entries;
    for (const name of e.keys()) {
      assert.ok(!name.startsWith('/') && !name.startsWith('./') && !name.split('/').includes('..'), `relative name ${name}`);
    }
    // the top level of an Alpine root plus the four mount points
    const top = [...e.keys()].filter((n) => !n.includes('/')).sort();
    assert.deepEqual(top, ['bin', 'dev', 'etc', 'home', 'host-mounts', 'lib', 'media', 'mnt', 'opt', 'proc', 'root',
      'run', 'sandbox-layer', 'sandbox-rootfs', 'sbin', 'srv', 'sys', 'tmp', 'usr', 'var', 'workspace']);
    for (const d of ['sandbox-rootfs', 'sandbox-layer', 'host-mounts', 'workspace', 'dev', 'proc', 'sys']) {
      assert.equal(e.get(d).type, '5', `${d} is a directory`);
      assert.deepEqual([...e.keys()].filter((n) => n.startsWith(`${d}/`)), [], `${d} is empty`);
    }
    for (const [name, mode] of Object.entries(MODES)) {
      assert.equal(e.get(name)?.mode, mode, `${name} mode ${mode.toString(8)}`);
    }
    for (const f of ['usr/bin/txresbench-sandbox-agent', 'usr/bin/bwrap', 'bin/busybox', 'usr/bin/squashfuse',
      'usr/bin/fusermount3', 'etc/wsl.conf', 'etc/txresbench-agent-protocol', 'etc/txresbench-wsl-version']) {
      assert.equal(e.get(f)?.type, '0', `${f} is a regular file`);
      assert.equal(e.get(f).uid, 0, `${f} owned by root`);
      assert.equal(e.get(f).gid, 0, `${f} group root`);
    }
    for (const f of ['usr/bin/txresbench-sandbox-agent', 'usr/bin/bwrap', 'bin/busybox', 'usr/bin/squashfuse', 'usr/bin/fusermount3']) {
      assert.equal(e.get(f).mode & 0o111, 0o111, `${f} is executable`);
    }
    assert.equal(e.get('bin/sh').type, '2');
    assert.equal(e.get('bin/sh').link, '/bin/busybox');
    // nothing setuid/setgid, no device nodes or FIFOs, one fixed mtime
    for (const x of e.values()) {
      assert.equal(x.mode & 0o6000, 0, `${x.name} is not setuid/setgid`);
      assert.ok(['0', '1', '2', '5'].includes(x.type), `${x.name}: type ${x.type}`);
      assert.equal(x.mtime, EPOCH, `${x.name} mtime`);
    }
    // every entry is root-owned except the shadow group's files of alpine-baselayout
    const notRoot = [...e.values()].filter((x) => x.uid !== 0 || x.gid !== 0).map((x) => `${x.name} ${x.uid}:${x.gid}`).sort();
    assert.deepEqual(notRoot, ['etc/shadow 0:42', 'etc/shadow- 0:42']);
    // no build date in /etc/shadow (busybox's install writes one), and root has no password
    const day = String(Math.floor(EPOCH / 86400));
    for (const f of ['etc/shadow', 'etc/shadow-']) {
      for (const fields of shadow(e.get(f))) {
        assert.ok(fields[2] === '' || fields[2] === day, `${f}: ${fields[0]}'s last change is ${fields[2]}`);
      }
      const root = shadow(e.get(f)).find((x) => x[0] === 'root');
      assert.ok(root && /^[*!]/.test(root[1]), `${f}: root's password is locked`);
    }
    assert.ok(shadow(e.get('etc/shadow')).some((x) => x[2] === day), 'the dates busybox wrote are the epoch\'s');
  });

  test(`${arch}: wsl.conf and the two markers`, () => {
    const b = built[arch];
    const e = b.entries;
    assert.deepEqual(ini(e.get('etc/wsl.conf').data.toString('utf8')), {
      interop: { enabled: 'false', appendWindowsPath: 'false' },
      automount: { enabled: 'true', mountFsTab: 'false' },
      network: { generateHosts: 'false', generateResolvConf: 'false' },
      boot: { systemd: 'false' },
      user: { default: 'nobody' },
    });
    // the default user exists and cannot log in
    const nobody = e.get('etc/passwd').data.toString('utf8').split('\n').find((l) => l.startsWith('nobody:'));
    assert.match(nobody, /^nobody:x:65534:65534:[^:]*:[^:]*:\/sbin\/nologin$/);
    assert.equal(e.get('sbin/nologin')?.link, '/bin/busybox');
    const [min, max] = protocolRange();
    assert.equal(e.get('etc/txresbench-agent-protocol').data.toString('utf8'), `${min} ${max}\n`);
    const version = e.get('etc/txresbench-wsl-version').data.toString('utf8');
    assert.match(version, new RegExp(`^${min}-${max}-[0-9a-f]{16}\\n$`));
    assert.equal(version.trim(), b.manifest.version);
  });

  test(`${arch}: the agent is a static binary for ${arch}; bwrap, busybox and squashfuse are ${arch} too`, () => {
    const e = built[arch].entries;
    const agent = elf(e.get('usr/bin/txresbench-sandbox-agent').data);
    assert.equal(agent.machine, ELF_MACHINE[arch]);
    assert.equal(agent.interp, false, 'no program interpreter');
    assert.equal(agent.needed, 0, 'no shared library');
    for (const f of ['usr/bin/bwrap', 'bin/busybox', 'usr/bin/squashfuse']) {
      assert.equal(elf(e.get(f).data).machine, ELF_MACHINE[arch], f);
    }
  });

  test(`${arch}: MANIFEST.json`, () => {
    const b = built[arch];
    const m = b.manifest;
    assert.deepEqual(Object.keys(m), ['version', 'arch', 'sha256', 'protocol', 'packages', 'build']);
    assert.equal(m.arch, arch);
    assert.equal(m.sha256, crypto.createHash('sha256').update(b.tar).digest('hex'));
    assert.deepEqual(m.protocol, protocolRange());
    // the packages are exactly the root's apk database, sorted by name
    const db = apkDb(b.entries.get('lib/apk/db/installed').data.toString('utf8'));
    assert.deepEqual(m.packages, db);
    for (const p of m.packages) assert.deepEqual(Object.keys(p), ['name', 'version', 'license']);
    for (const n of ['busybox', 'bubblewrap', 'squashfuse', 'fuse3', 'musl', 'alpine-baselayout', 'alpine-keys']) {
      assert.ok(m.packages.some((p) => p.name === n), n);
    }
    // each one named in the notices with the same licence, and the notices name nothing else
    const cover = noticesCover(fs.readFileSync(path.join(REPO, 'THIRD-PARTY-NOTICES.md'), 'utf8'));
    for (const p of m.packages) assert.equal(cover.get(p.name), p.license, `${p.name} in the notices`);
    assert.deepEqual([...cover.keys()].sort(), m.packages.map((p) => p.name).sort());
    // the build record
    assert.deepEqual(Object.keys(m.build), ['alpine_image', 'alpine_repositories', 'rust_image', 'agent_toolchain',
      'agent_sha256', 'agent_cargo_cache', 'archiver', 'source_commit']);
    assert.equal(m.build.agent_cargo_cache, cacheOf(arch), 'the test cache the agent came from');
    assert.equal(m.build.alpine_image, alpineImageOf(arch));
    assert.deepEqual(m.build.alpine_repositories,
      ['https://dl-cdn.alpinelinux.org/alpine/v3.20/main', 'https://dl-cdn.alpinelinux.org/alpine/v3.20/community']);
    assert.equal(m.build.rust_image, rustImageOf(arch));
    assert.equal(m.build.agent_sha256,
      crypto.createHash('sha256').update(b.entries.get('usr/bin/txresbench-sandbox-agent').data).digest('hex'));
    assert.match(m.build.agent_toolchain[0], /^rustc 1\.90\.\d+$/);
    assert.ok(m.build.agent_toolchain.some((t) => /^libseccomp-static \S+$/.test(t)), m.build.agent_toolchain);
    assert.match(m.build.source_commit, /^[0-9a-f]{40}(\+dirty)?$/);
    // a plain tar: no gzip (1f 8b), bzip2, xz or zstd magic; the first header's ustar/GNU magic at 257
    assert.ok(![[0x1f, 0x8b], [0x42, 0x5a], [0xfd, 0x37], [0x28, 0xb5]].some(([a, c]) => b.tar[0] === a && b.tar[1] === c));
    assert.equal(b.tar.toString('latin1', 257, 263), 'ustar ');
    assert.equal(b.tar.length % 512, 0, 'whole tar blocks');
  });

  test(`${arch}: the root's programs run in a Linux container (chroot)`, () => {
    const b = built[arch];
    const res = docker(['run', '--rm', '--platform', platformOf(arch), '-v', `${b.out}:/in:ro`, alpineImageOf(arch), 'sh', '-c', `
      set -e
      mkdir /r && tar -xf /in/txresbench-wsl.tar -C /r
      chroot /r /usr/bin/bwrap --version
      # --help exits non-zero; its first line names the program and its version
      chroot /r /usr/bin/squashfuse --help > /tmp/help 2>&1 || true
      sed -n 1p /tmp/help
      chroot /r /bin/busybox uname -m
      head -c 300000 /dev/urandom > /tmp/in
      chroot /r /usr/bin/txresbench-sandbox-agent --pipe-selftest < /tmp/in > /tmp/out
      cmp /tmp/in /tmp/out && echo selftest-ok`]);
    assert.equal(res.status, 0, res.out);
    const lines = res.out.split('\n');
    assert.match(lines[0], /^bubblewrap \d+\.\d+\.\d+$/);
    assert.match(lines[1], /^squashfuse \d+\.\d+\.\d+ \(c\)/, 'squashfuse starts: its libraries load');
    assert.equal(lines[2], arch);
    assert.ok(lines.includes('selftest-ok'), res.out);
  });

  test(`${arch}: the bundle check takes the pair, and refuses an agent from the test cache`, () => {
    const b = built[arch];
    const dev = checkRuntime(b.out, arch, { TXR_WSL_RUNTIME_ALLOW_DEV: '1' });
    assert.equal(dev.status, 0, dev.out);
    assert.match(dev.out, new RegExp(`${b.manifest.version} \\(${arch}, sha256 ${b.manifest.sha256}\\) can be bundled`));
    const release = checkRuntime(b.out, arch);
    assert.equal(release.status, 1, release.out);
    assert.match(release.out, /the agent was built from the test cache/);
    const other = arch === 'x86_64' ? 'aarch64' : 'x86_64';
    const wrong = checkRuntime(b.out, other, { TXR_WSL_RUNTIME_ALLOW_DEV: '1' });
    assert.equal(wrong.status, 1, wrong.out);
    assert.match(wrong.out, new RegExp(`the WSL runtime is for ${arch}, the bundle for ${other}`));
  });

  test(`${arch}: squashfuse mounts a squashfs image and a bwrap sandbox reads it (privileged, pivot_root)`, () => {
    const b = built[arch];
    // The root is entered with pivot_root in a private mount namespace, as WSL enters a distro: a chroot
    // would not do, since the kernel refuses a user namespace to a chrooted process.
    const smoke = [
      'set -e',
      'umount -l /.old',
      'mount -t proc proc /proc',
      'mount -t devtmpfs dev /dev',
      // as the agent's WSL mode mounts an image (sdk/crates/sandbox-guest-agent)
      '/usr/bin/squashfuse -o ro,allow_other /tmp/t.sqfs /sandbox-rootfs',
      // read back as uid 1001 in a user namespace, as the method's sandbox reads it
      '/usr/bin/bwrap --ro-bind / / --dev /dev --proc /proc --unshare-user --uid 1001 --gid 1001 \\',
      '  --unshare-net --unshare-pid --die-with-parent /bin/sh -c "id -u; cat /sandbox-rootfs/hello.txt"',
      '/usr/bin/fusermount3 -u /sandbox-rootfs',
      '[ -z "$(ls /sandbox-rootfs)" ] && echo unmounted',
    ].join('\n');
    const res = docker(['run', '--rm', '--privileged', '--platform', platformOf(arch), '-v', `${b.out}:/in:ro`,
      '-e', `SMOKE=${smoke}`, alpineImageOf(arch), 'sh', '-c', `
      set -e
      apk add -q --no-cache squashfs-tools >/dev/null   # makes the test image; not part of the root
      mkdir /r && tar -xf /in/txresbench-wsl.tar -C /r
      mkdir /img && echo hello-from-squashfs > /img/hello.txt
      mksquashfs /img /r/tmp/t.sqfs -quiet -noappend >/dev/null
      printf '%s\\n' "$SMOKE" > /r/tmp/smoke.sh
      unshare -m sh -c 'mount --make-rprivate / && mount --bind /r /r && cd /r && mkdir .old &&
        pivot_root . .old && exec /bin/sh /tmp/smoke.sh'`]);
    assert.equal(res.status, 0, res.out);
    assert.match(res.out, /^1001\nhello-from-squashfs$/m);
    assert.match(res.out, /^unmounted$/m);
  });
}

// ── the notices refusal after a real userland, and reproducibility ───────────

const FIRST = ARCHES[0];

test(`${FIRST}: a package missing from the notices, or listed with another licence, fails the build and keeps the previous outputs`, { timeout: 30 * 60 * 1000 }, () => {
  const b = built[FIRST];
  assert.ok(b, 'built');
  const before = Object.fromEntries(fs.readdirSync(b.out).map((f) => [f, fs.readFileSync(path.join(b.out, f))]));
  const real = fs.readFileSync(path.join(REPO, 'THIRD-PARTY-NOTICES.md'), 'utf8');
  const cases = [
    [real.replace('  - squashfuse — BSD-2-Clause\n', ''), /packages missing from .*squashfuse \(BSD-2-Clause\)/],
    [real.replace('  - squashfuse — BSD-2-Clause\n', '  - squashfuse — MIT\n'), /packages missing from .*squashfuse \(BSD-2-Clause\)/],
    [real.replace('  - fuse3, fuse3-libs, fuse-common — ', '  - fuse3, fuse-common — '), /packages missing from .*fuse3-libs \(GPL-2\.0-only AND LGPL-2\.1-only\)/],
  ];
  for (const [text, want] of cases) {
    assert.notEqual(text, real, 'the fixture differs from the real notices');
    const notices = path.join(b.dir, 'NOTICES.md');
    fs.writeFileSync(notices, text);
    const res = build(FIRST, b.out, ['--notices', notices]);
    assert.equal(res.status, 1, res.out.slice(-3000));
    assert.match(res.out, want);
    assert.doesNotMatch(res.out, /building the guest agent/, 'refused before the agent build');
    for (const [f, bytes] of Object.entries(before)) assert.ok(fs.readFileSync(path.join(b.out, f)).equals(bytes), `${f} kept`);
    assert.deepEqual(fs.readdirSync(path.join(b.dir, 'work')), [], 'the run directory is removed');
  }
});

test(`${FIRST}: building the same tree again, the agent from nothing, gives the same tarball and MANIFEST`, { timeout: 90 * 60 * 1000 }, () => {
  const b = built[FIRST];
  assert.ok(b, 'built');
  // No cache: the agent is compiled again from a fresh registry and target dir, as a release build does.
  const out2 = path.join(b.dir, 'out2');
  const res = build(FIRST, out2, [], { cache: false });
  assert.equal(res.status, 0, res.out.slice(-4000));
  assert.doesNotMatch(res.out, /using the test cache volumes/);
  const tar2 = fs.readFileSync(path.join(out2, 'txresbench-wsl.tar'));
  assert.equal(crypto.createHash('sha256').update(tar2).digest('hex'), b.manifest.sha256);
  const m2 = JSON.parse(fs.readFileSync(path.join(out2, 'MANIFEST.json'), 'utf8'));
  assert.equal(m2.build.agent_cargo_cache, null, 'no cache recorded');
  assert.deepEqual({ ...m2, build: { ...m2.build, agent_cargo_cache: b.manifest.build.agent_cargo_cache } }, b.manifest);
});

// ── the pinned images ────────────────────────────────────────────────────────

test('the pinned build images are the linux/amd64 and linux/arm64 entries of the indexes the helper names', () => {
  const indexes = sh(`. "${HELPER}"; echo "$GUEST_ALPINE_INDEX"; echo "$GUEST_RUST_INDEX"`).split('\n');
  const pinned = { [indexes[0]]: alpineImageOf, [indexes[1]]: rustImageOf };
  for (const [index, imageOf] of Object.entries(pinned)) {
    const res = spawnSync('docker', ['buildx', 'imagetools', 'inspect', '--raw', index], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    const list = JSON.parse(res.stdout);
    for (const [arch, [os, cpu]] of [['x86_64', ['linux', 'amd64']], ['aarch64', ['linux', 'arm64']]]) {
      const entry = list.manifests.find((x) => x.platform?.os === os && x.platform?.architecture === cpu);
      assert.ok(entry, `${index} has ${os}/${cpu}`);
      const [repo] = index.split('@');
      assert.equal(imageOf(arch), `${repo}@${entry.digest}`, `${arch}: the ${os}/${cpu} entry of ${index}`);
    }
  }
});
