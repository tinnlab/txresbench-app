#!/usr/bin/env node
// scripts/fetch-oras.test.mjs — the controls for `scripts/fetch-oras.mjs`.
//
// No control touches the network: every download is served by a loopback
// HTTP server in this process (the script's `--base-url` / `baseUrl` seam), and
// the archives are built here from fake `oras` bytes with a minimal tar / zip
// writer, so the pins the success-path controls use are computed from those
// bytes. The CLI controls run the real script as a subprocess with the real
// pinned table; they serve bytes that cannot match it and assert the refusal.
//
// Subprocesses are awaited with async `spawn`, not `spawnSync`: the loopback
// server lives in this process and a synchronous wait would deadlock it.
//
//   node --test scripts/fetch-oras.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

import {
  ORAS_VERSION,
  PINS,
  TARGETS,
  UNIVERSAL_DARWIN,
  UsageError,
  assetFor,
  extractFromTarGz,
  extractFromZip,
  fetchOras,
  sha256,
  sidecarName,
  stageTarget,
} from './fetch-oras.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fetch-oras.mjs');

const TMPDIRS = [];
process.on('exit', () => {
  for (const d of TMPDIRS) fs.rmSync(d, { recursive: true, force: true });
});

function scratch(prefix) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), prefix));
  TMPDIRS.push(dir);
  return dir;
}

// ── fixture archives ─────────────────────────────────────────────────────────

function tarHeader(name, size, type = '0') {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000755\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return h;
}

function pad512(buf) {
  return Buffer.concat([buf, Buffer.alloc((512 - (buf.length % 512)) % 512)]);
}

/** A .tar.gz with `files` = [[name, Buffer], ...]. */
function makeTarGz(files) {
  const parts = [];
  for (const [name, data] of files) {
    parts.push(tarHeader(name, data.length), pad512(data));
  }
  parts.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(parts));
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A .zip (deflated members) with `files` = [[name, Buffer], ...]. */
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const comp = zlib.deflateRawSync(data);
    const crc = crc32(data);
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0);
    loc.writeUInt16LE(20, 4);
    loc.writeUInt16LE(8, 8);
    loc.writeUInt32LE(crc, 14);
    loc.writeUInt32LE(comp.length, 18);
    loc.writeUInt32LE(data.length, 22);
    loc.writeUInt16LE(nameBuf.length, 26);
    locals.push(loc, nameBuf, comp);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    centrals.push(cen, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/** A fake release asset for `triple`: its archive bytes, binary bytes and pins. */
function fakeAsset(triple, binary = Buffer.from(`#!/bin/sh\necho fake oras for ${triple}\n`)) {
  const a = assetFor(triple);
  const files = [['LICENSE', Buffer.from('Apache License 2.0\n')], [a.member, binary]];
  const archive = a.asset.endsWith('.zip') ? makeZip(files) : makeTarGz(files);
  return {
    ...a,
    archive,
    binary,
    pins: { [a.asset]: { archive: sha256(archive), binary: sha256(binary) } },
    route: new URL(a.url).pathname,
  };
}

// ── loopback server + subprocess ─────────────────────────────────────────────

/** `routes`: path -> { body } | { redirect }. Records every request path. */
async function startServer(routes) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    const route = routes[req.url];
    if (!route) {
      res.writeHead(404);
      res.end('not found');
    } else if (route.redirect) {
      res.writeHead(302, { location: route.redirect });
      res.end();
    } else {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(route.body);
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = new URL(`http://127.0.0.1:${server.address().port}`);
  return { base, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

function runCli(args, env = {}) {
  return new Promise((resolve) => {
    const childEnv = { ...process.env, ...env };
    if (!('TAURI_ENV_TARGET_TRIPLE' in env)) delete childEnv.TAURI_ENV_TARGET_TRIPLE;
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ status: code, out }));
  });
}

// ── target -> asset mapping ──────────────────────────────────────────────────

test('every supported target maps to its oras release asset, member and sidecar name', () => {
  const expected = {
    'aarch64-apple-darwin': ['darwin_arm64.tar.gz', 'oras', 'oras-aarch64-apple-darwin'],
    'x86_64-apple-darwin': ['darwin_amd64.tar.gz', 'oras', 'oras-x86_64-apple-darwin'],
    'aarch64-unknown-linux-gnu': ['linux_arm64.tar.gz', 'oras', 'oras-aarch64-unknown-linux-gnu'],
    'x86_64-unknown-linux-gnu': ['linux_amd64.tar.gz', 'oras', 'oras-x86_64-unknown-linux-gnu'],
    'aarch64-pc-windows-msvc': ['windows_arm64.zip', 'oras.exe', 'oras-aarch64-pc-windows-msvc.exe'],
    'x86_64-pc-windows-msvc': ['windows_amd64.zip', 'oras.exe', 'oras-x86_64-pc-windows-msvc.exe'],
  };
  assert.deepEqual(Object.keys(TARGETS).sort(), Object.keys(expected).sort());
  for (const [triple, [suffix, member, sidecar]] of Object.entries(expected)) {
    const a = assetFor(triple);
    assert.equal(a.asset, `oras_${ORAS_VERSION}_${suffix}`, triple);
    assert.equal(a.member, member, triple);
    assert.equal(a.sidecar, sidecar, triple);
    assert.equal(
      a.url,
      `https://github.com/oras-project/oras/releases/download/v${ORAS_VERSION}/oras_${ORAS_VERSION}_${suffix}`,
      triple,
    );
  }
  assert.equal(sidecarName(UNIVERSAL_DARWIN), 'oras-universal-apple-darwin');
});

test('every target has a pinned archive and binary sha256 for the pinned version', () => {
  const assets = Object.keys(TARGETS).map((t) => assetFor(t).asset).sort();
  assert.deepEqual(Object.keys(PINS).sort(), assets);
  for (const [asset, pin] of Object.entries(PINS)) {
    assert.ok(asset.startsWith(`oras_${ORAS_VERSION}_`), asset);
    assert.match(pin.archive, /^[0-9a-f]{64}$/, `${asset} archive pin`);
    assert.match(pin.binary, /^[0-9a-f]{64}$/, `${asset} binary pin`);
    assert.notEqual(pin.archive, pin.binary, asset);
  }
});

test('an unsupported target is a usage error', async () => {
  assert.throws(() => assetFor('riscv64gc-unknown-linux-gnu'), UsageError);
  const res = await runCli(['riscv64gc-unknown-linux-gnu', '--out-dir', scratch('fetch-oras-')]);
  assert.equal(res.status, 2, res.out);
  assert.match(res.out, /unsupported target "riscv64gc-unknown-linux-gnu"/);
});

test('the archive readers return the named member from tar.gz and zip', () => {
  const bin = Buffer.from('binary bytes\n');
  const files = [['LICENSE', Buffer.from('x')], ['oras', bin]];
  assert.deepEqual(extractFromTarGz(makeTarGz(files), 'oras'), bin);
  assert.deepEqual(extractFromTarGz(makeTarGz([['./oras', bin]]), 'oras'), bin);
  assert.deepEqual(extractFromZip(makeZip([['oras.exe', bin]]), 'oras.exe'), bin);
  assert.throws(() => extractFromTarGz(makeTarGz([['LICENSE', bin]]), 'oras'), /oras not found/);
  assert.throws(() => extractFromZip(makeZip([['LICENSE', bin]]), 'oras.exe'), /oras.exe not found/);
});

// ── staging ──────────────────────────────────────────────────────────────────

test('a verified asset is written executable, and a second run downloads nothing', async () => {
  const fake = fakeAsset('x86_64-unknown-linux-gnu');
  const srv = await startServer({ [fake.route]: { body: fake.archive } });
  try {
    const out = scratch('fetch-oras-');
    const first = await stageTarget({ triple: 'x86_64-unknown-linux-gnu', outDir: out, baseUrl: srv.base, pins: fake.pins });
    assert.equal(first.fetched, true);
    const target = path.join(out, 'oras-x86_64-unknown-linux-gnu');
    assert.deepEqual(fs.readFileSync(target), fake.binary);
    if (process.platform !== 'win32') assert.equal(fs.statSync(target).mode & 0o777, 0o755);
    assert.deepEqual(srv.requests, [fake.route]);

    const second = await stageTarget({ triple: 'x86_64-unknown-linux-gnu', outDir: out, baseUrl: srv.base, pins: fake.pins });
    assert.equal(second.fetched, false);
    assert.equal(srv.requests.length, 1, 'no second download');
  } finally {
    await srv.close();
  }
});

test('a Windows target is staged from the zip as oras-<triple>.exe', async () => {
  const fake = fakeAsset('x86_64-pc-windows-msvc', Buffer.from('MZ fake windows oras'));
  const srv = await startServer({ [fake.route]: { body: fake.archive } });
  try {
    const out = scratch('fetch-oras-');
    await stageTarget({ triple: 'x86_64-pc-windows-msvc', outDir: out, baseUrl: srv.base, pins: fake.pins });
    assert.deepEqual(fs.readdirSync(out), ['oras-x86_64-pc-windows-msvc.exe']);
    assert.deepEqual(fs.readFileSync(path.join(out, 'oras-x86_64-pc-windows-msvc.exe')), fake.binary);
  } finally {
    await srv.close();
  }
});

test('an archive with the wrong sha256 is refused and nothing is written', async () => {
  const fake = fakeAsset('aarch64-apple-darwin');
  const tampered = makeTarGz([['oras', Buffer.from('#!/bin/sh\necho tampered\n')]]);
  const srv = await startServer({ [fake.route]: { body: tampered } });
  try {
    const out = scratch('fetch-oras-');
    await assert.rejects(
      stageTarget({ triple: 'aarch64-apple-darwin', outDir: out, baseUrl: srv.base, pins: fake.pins }),
      /oras_1\.3\.6_darwin_arm64\.tar\.gz: sha256 mismatch.*refusing it/,
    );
    assert.deepEqual(fs.existsSync(out) ? fs.readdirSync(out) : [], []);
  } finally {
    await srv.close();
  }
});

test('an extracted binary with the wrong sha256 is refused and nothing is written', async () => {
  const fake = fakeAsset('aarch64-unknown-linux-gnu');
  const pins = { [fake.asset]: { archive: fake.pins[fake.asset].archive, binary: '0'.repeat(64) } };
  const srv = await startServer({ [fake.route]: { body: fake.archive } });
  try {
    const out = scratch('fetch-oras-');
    await assert.rejects(
      stageTarget({ triple: 'aarch64-unknown-linux-gnu', outDir: out, baseUrl: srv.base, pins }),
      /extracted oras sha256 mismatch/,
    );
    assert.deepEqual(fs.readdirSync(out), []);
  } finally {
    await srv.close();
  }
});

test('an existing file with the wrong sha256 is not kept: it is replaced by the verified binary', async () => {
  const fake = fakeAsset('x86_64-apple-darwin');
  const srv = await startServer({ [fake.route]: { body: fake.archive } });
  try {
    const out = scratch('fetch-oras-');
    const target = path.join(out, 'oras-x86_64-apple-darwin');
    fs.writeFileSync(target, 'stale or tampered sidecar');
    const res = await stageTarget({ triple: 'x86_64-apple-darwin', outDir: out, baseUrl: srv.base, pins: fake.pins });
    assert.equal(res.fetched, true);
    assert.deepEqual(srv.requests, [fake.route]);
    assert.deepEqual(fs.readFileSync(target), fake.binary);
  } finally {
    await srv.close();
  }
});

test('a redirect to a host outside the release hosts is refused', async () => {
  const fake = fakeAsset('x86_64-unknown-linux-gnu');
  const srv = await startServer({ [fake.route]: { redirect: 'http://downloads.invalid/oras.tar.gz' } });
  try {
    const out = scratch('fetch-oras-');
    await assert.rejects(
      stageTarget({ triple: 'x86_64-unknown-linux-gnu', outDir: out, baseUrl: srv.base, pins: fake.pins }),
      /host downloads\.invalid is outside/,
    );
    assert.deepEqual(fs.readdirSync(out), []);
  } finally {
    await srv.close();
  }
});

test('universal-apple-darwin stages both macOS slices and combines them', async () => {
  const arm = fakeAsset('aarch64-apple-darwin');
  const x64 = fakeAsset('x86_64-apple-darwin');
  const srv = await startServer({ [arm.route]: { body: arm.archive }, [x64.route]: { body: x64.archive } });
  const calls = [];
  const combine = (output, inputs) => {
    calls.push(inputs.map((p) => path.basename(p)));
    fs.writeFileSync(output, Buffer.concat(inputs.map((p) => fs.readFileSync(p))));
  };
  try {
    const out = scratch('fetch-oras-');
    const pins = { ...arm.pins, ...x64.pins };
    await fetchOras({ triple: UNIVERSAL_DARWIN, outDir: out, baseUrl: srv.base, pins, combine });
    assert.deepEqual(calls, [['oras-aarch64-apple-darwin', 'oras-x86_64-apple-darwin']]);
    assert.deepEqual(fs.readdirSync(out).sort(), [
      'oras-aarch64-apple-darwin',
      'oras-universal-apple-darwin',
      'oras-x86_64-apple-darwin',
    ]);
    assert.deepEqual(
      fs.readFileSync(path.join(out, 'oras-universal-apple-darwin')),
      Buffer.concat([arm.binary, x64.binary]),
    );
    await fetchOras({ triple: UNIVERSAL_DARWIN, outDir: out, baseUrl: srv.base, pins, combine });
    assert.equal(srv.requests.length, 2, 'the slices are not downloaded again');
    assert.deepEqual(fs.readdirSync(out).filter((n) => n.endsWith('.part')), []);
  } finally {
    await srv.close();
  }
});

// ── build wiring ─────────────────────────────────────────────────────────────

test('tauri.conf.json ships the sidecar and both build hooks stage it before the UI', () => {
  const repo = path.resolve(path.dirname(SCRIPT), '..');
  const conf = JSON.parse(fs.readFileSync(path.join(repo, 'src-app/desktop/tauri/tauri.conf.json'), 'utf8'));
  assert.deepEqual(conf.bundle.externalBin, ['binaries/oras']);
  assert.equal(conf.build.beforeBuildCommand, 'npm run fetch-oras && npm run build --workspace=@txresbench/ui');
  assert.equal(conf.build.beforeDevCommand, 'npm run fetch-oras && npm run dev --workspace=@txresbench/ui');

  // `npm run` resolves the root package.json from either hook working
  // directory (the Tauri CLI runs hooks in the frontend dir it resolves).
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['fetch-oras'], 'node scripts/fetch-oras.mjs');

  const gitignore = fs.readFileSync(path.join(repo, '.gitignore'), 'utf8');
  assert.match(gitignore, /^src-app\/desktop\/tauri\/binaries\/$/m, 'the staged binaries are never committed');
});

// ── the CLI with the real pinned table ───────────────────────────────────────

test('CLI: bytes that do not match the pinned sha256 are refused (exit 1, nothing written)', async () => {
  const real = assetFor('x86_64-unknown-linux-gnu');
  const route = new URL(real.url).pathname;
  const srv = await startServer({ [route]: { body: makeTarGz([['oras', Buffer.from('not the real oras')]]) } });
  try {
    const out = scratch('fetch-oras-');
    const res = await runCli(['x86_64-unknown-linux-gnu', '--out-dir', out, '--base-url', srv.base.href]);
    assert.equal(res.status, 1, res.out);
    assert.match(res.out, /oras_1\.3\.6_linux_amd64\.tar\.gz: sha256 mismatch/);
    assert.match(res.out, new RegExp(`pinned ${PINS['oras_1.3.6_linux_amd64.tar.gz'].archive}`));
    assert.deepEqual(srv.requests, [route]);
    assert.deepEqual(fs.existsSync(out) ? fs.readdirSync(out) : [], []);
  } finally {
    await srv.close();
  }
});

test('CLI: the target comes from TAURI_ENV_TARGET_TRIPLE when no argument is given', async () => {
  const real = assetFor('aarch64-pc-windows-msvc');
  const route = new URL(real.url).pathname;
  const srv = await startServer({ [route]: { body: Buffer.from('not a zip') } });
  try {
    const out = scratch('fetch-oras-');
    const res = await runCli(['--out-dir', out, '--base-url', srv.base.href], {
      TAURI_ENV_TARGET_TRIPLE: 'aarch64-pc-windows-msvc',
    });
    assert.equal(res.status, 1, res.out);
    assert.match(res.out, /for aarch64-pc-windows-msvc \(from TAURI_ENV_TARGET_TRIPLE\)/);
    assert.deepEqual(srv.requests, [route]);
    assert.deepEqual(fs.existsSync(out) ? fs.readdirSync(out) : [], []);
  } finally {
    await srv.close();
  }
});

test('CLI: --base-url must be a loopback URL', async () => {
  const res = await runCli(['x86_64-unknown-linux-gnu', '--out-dir', scratch('fetch-oras-'), '--base-url', 'https://example.com']);
  assert.equal(res.status, 2, res.out);
  assert.match(res.out, /--base-url must be an http\(s\) loopback URL/);
});
