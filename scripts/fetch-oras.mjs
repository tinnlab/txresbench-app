#!/usr/bin/env node
// scripts/fetch-oras.mjs — stage the `oras` CLI as the desktop app's Tauri sidecar.
//
// The app downloads each method environment from GHCR with the external `oras`
// program (`src-app/server/src/modules/sandbox/method_env.rs`, `tool_bin`).
// The desktop bundle ships oras next to the app executable through Tauri's
// `bundle.externalBin: ["binaries/oras"]`, which expects the file
// `src-app/desktop/tauri/binaries/oras-<target-triple>` (`.exe` on Windows) at
// build time. This script writes that file: it downloads the official oras
// release asset for the target, verifies the archive against the sha256 PINNED
// below, extracts the `oras` binary, verifies the binary's own pinned sha256,
// and writes it executable. Nothing is fetched at app run time.
//
// `tauri build` / `tauri dev` run it first (tauri.conf.json beforeBuildCommand /
// beforeDevCommand, through the root package.json `fetch-oras` script); the
// Tauri CLI passes the target it builds as TAURI_ENV_TARGET_TRIPLE.
//
// ## PINS
//
// oras v1.3.6, released 2026-10-24
// (https://github.com/oras-project/oras/releases/tag/v1.3.6).
// `archive` = the sha256 listed for the asset in that release's own
// `oras_1.3.6_checksums.txt` (copied 2026-11-13; every downloaded asset matched
// it). `binary` = the sha256 of the `oras` / `oras.exe` member extracted from
// that verified archive. The checksums file is never fetched at build time:
// updating oras means editing ORAS_VERSION and both columns here by hand.
//
// ## USAGE
//
//   node scripts/fetch-oras.mjs [<target-triple>] [--out-dir <dir>] [--base-url <url>]
//
// The target is the argument, else TAURI_ENV_TARGET_TRIPLE, else the host
// (`rustc -vV`, else the Node platform/arch). `universal-apple-darwin` stages
// both macOS architectures and combines them with `lipo` (macOS only), as
// `tauri build --target universal-apple-darwin` needs all three files.
// `--out-dir` defaults to src-app/desktop/tauri/binaries. `--base-url` is the
// loopback test seam: it replaces scheme+host+port of every download and only
// a loopback host may be named.
//
// A file that already exists with the pinned binary sha256 is kept (no
// download). Exit 0 on success, 1 on a download or verification failure
// (nothing is written), 2 on a usage error or an unsupported target.

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(SCRIPT_PATH), '..');

export const ORAS_VERSION = '1.3.6';
export const DEFAULT_OUT_DIR = path.join(REPO, 'src-app/desktop/tauri/binaries');
export const UNIVERSAL_DARWIN = 'universal-apple-darwin';

/** Rust target triple -> oras release platform. */
export const TARGETS = {
  'aarch64-apple-darwin': { os: 'darwin', arch: 'arm64' },
  'x86_64-apple-darwin': { os: 'darwin', arch: 'amd64' },
  'aarch64-unknown-linux-gnu': { os: 'linux', arch: 'arm64' },
  'x86_64-unknown-linux-gnu': { os: 'linux', arch: 'amd64' },
  'aarch64-pc-windows-msvc': { os: 'windows', arch: 'arm64' },
  'x86_64-pc-windows-msvc': { os: 'windows', arch: 'amd64' },
};

/** Pinned sha256 per release asset (see PINS above). */
export const PINS = {
  'oras_1.3.6_darwin_amd64.tar.gz': {
    archive: '844e26430aa0afe2c40fdbddafc3b39ef968a6d41955b7380684bd02907fa397',
    binary: '6adc106a3ddbdef0738c1fa6b1394a2cf2bb77e3825b69608f4ac088aacec908',
  },
  'oras_1.3.6_darwin_arm64.tar.gz': {
    archive: 'e2b25a53234e2471c5fc81936f957fa612065ab559c21834c02d8bfbc2f62b30',
    binary: '5539de6e731b6fa4bc27c57b41e4e9844982132335ad07d973870411a94627df',
  },
  'oras_1.3.6_linux_amd64.tar.gz': {
    archive: '66fb0ad7206f3f6fa77ed5b552049d364ccf4b50b1684554f731f76302b52ca0',
    binary: '2be7e2b668fc32329408ca17f104021bdb93407266537b6410668ed7d05c4611',
  },
  'oras_1.3.6_linux_arm64.tar.gz': {
    archive: 'b84269e78dfc2d5329a4aab373da3200de95e6c138338cf6c66c10c0a3f248c1',
    binary: 'e61243d2c862a5aaf6451914edd8cc089ae91df425201fa9ee7659cbed36e7c0',
  },
  'oras_1.3.6_windows_amd64.zip': {
    archive: 'ec3d19f386d5d2f0892288772d7b242475a05332aafa64b6773378ca771d76d3',
    binary: '16843cb3851b0db59f41de17219f24b04ec27eb454ab6507f65654e0926d2947',
  },
  'oras_1.3.6_windows_arm64.zip': {
    archive: '2b6104e9b9da4ca8c395cc15b8fbbbcbc072df77242a146e0d1639bacc4ed0cb',
    binary: '705e003d39150ebc2923cacd32e2c4e2e196083d5e524c9b075d1c0e78eb3350',
  },
};

/** Hosts a release download may touch: the release URL and its redirect targets. */
const RELEASE_HOSTS = [
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
];
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1', '[::1]'];
const MAX_REDIRECTS = 10;
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 300_000;

export class UsageError extends Error {}

/** The release asset, the archive member and the sidecar file for a target. */
export function assetFor(triple, version = ORAS_VERSION) {
  const t = TARGETS[triple];
  if (!t) {
    throw new UsageError(
      `unsupported target ${JSON.stringify(triple)}; supported: ` +
        `${[...Object.keys(TARGETS), UNIVERSAL_DARWIN].join(', ')}`,
    );
  }
  const windows = t.os === 'windows';
  return {
    asset: `oras_${version}_${t.os}_${t.arch}.${windows ? 'zip' : 'tar.gz'}`,
    member: windows ? 'oras.exe' : 'oras',
    sidecar: sidecarName(triple),
    url: `https://github.com/oras-project/oras/releases/download/v${version}/` +
      `oras_${version}_${t.os}_${t.arch}.${windows ? 'zip' : 'tar.gz'}`,
  };
}

/** The file name tauri-build and the bundler look for: `oras-<triple>[.exe]`. */
export function sidecarName(triple) {
  return `oras-${triple}${triple.includes('windows') ? '.exe' : ''}`;
}

/** The host's Rust target triple: `rustc -vV`, else the Node platform/arch. */
export function hostTriple() {
  try {
    const out = execFileSync('rustc', ['-vV'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const line = out.split('\n').find((l) => l.startsWith('host:'));
    if (line) return line.slice('host:'.length).trim();
  } catch {
    // no rustc on PATH: fall through to the platform mapping
  }
  const arch = { x64: 'x86_64', arm64: 'aarch64' }[process.arch];
  const os = { darwin: 'apple-darwin', linux: 'unknown-linux-gnu', win32: 'pc-windows-msvc' }[process.platform];
  if (!arch || !os) {
    throw new UsageError(`cannot map host ${process.platform}/${process.arch} to a target triple; pass one`);
  }
  return `${arch}-${os}`;
}

export function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function fileSha256(file) {
  try {
    return sha256(fs.readFileSync(file));
  } catch {
    return null;
  }
}

// ── archive readers (no packages; the result is verified against its pin) ─────

function cString(buf, start, len) {
  const field = buf.subarray(start, start + len);
  const nul = field.indexOf(0);
  return field.subarray(0, nul < 0 ? field.length : nul).toString('utf8');
}

function memberMatches(name, member) {
  return name.replace(/^\.\//, '') === member;
}

/** The bytes of the regular-file `member` at the root of a .tar.gz archive. */
export function extractFromTarGz(archive, member) {
  const tar = zlib.gunzipSync(archive);
  let off = 0;
  let longName = null;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i];
    const stored = parseInt(cString(header, 148, 8).trim(), 8);
    if (stored !== sum) throw new Error(`tar header checksum mismatch at offset ${off}`);
    const sizeField = cString(header, 124, 12).trim();
    if (!/^[0-7]+$/.test(sizeField)) throw new Error(`unsupported tar size field at offset ${off}`);
    const size = parseInt(sizeField, 8);
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    const ustar = cString(header, 257, 6) === 'ustar';
    const prefix = ustar ? cString(header, 345, 155) : '';
    const dataStart = off + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new Error('truncated tar archive');
    const data = tar.subarray(dataStart, dataEnd);
    if (type === 'x') {
      // pax extended header: only `path` changes which member this is
      const text = data.toString('utf8');
      const m = text.match(/(?:^|\n)\d+ path=([^\n]*)\n/);
      longName = m ? m[1] : longName;
    } else if (type === 'L') {
      longName = cString(data, 0, data.length);
    } else if (type !== 'g') {
      const name = longName ?? (prefix ? `${prefix}/${cString(header, 0, 100)}` : cString(header, 0, 100));
      longName = null;
      if ((type === '0' || type === '7') && memberMatches(name, member)) return Buffer.from(data);
    }
    off = dataStart + Math.ceil(size / 512) * 512;
  }
  throw new Error(`${member} not found in the archive`);
}

/** The bytes of `member` at the root of a .zip archive (stored or deflated). */
export function extractFromZip(archive, member) {
  const EOCD = 0x06054b50;
  const CEN = 0x02014b50;
  const LOC = 0x04034b50;
  let eocd = -1;
  for (let i = archive.length - 22; i >= Math.max(0, archive.length - 22 - 0xffff); i--) {
    if (archive.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip archive (no end-of-central-directory record)');
  const count = archive.readUInt16LE(eocd + 10);
  let p = archive.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (archive.readUInt32LE(p) !== CEN) throw new Error('corrupt zip central directory');
    const flags = archive.readUInt16LE(p + 8);
    const method = archive.readUInt16LE(p + 10);
    const csize = archive.readUInt32LE(p + 20);
    const usize = archive.readUInt32LE(p + 24);
    const nameLen = archive.readUInt16LE(p + 28);
    const extraLen = archive.readUInt16LE(p + 30);
    const commentLen = archive.readUInt16LE(p + 32);
    const local = archive.readUInt32LE(p + 42);
    const name = archive.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (!memberMatches(name, member)) continue;
    if (flags & 1) throw new Error(`${member} is encrypted`);
    if (csize === 0xffffffff || usize === 0xffffffff || local === 0xffffffff) {
      throw new Error('zip64 archives are not supported');
    }
    if (archive.readUInt32LE(local) !== LOC) throw new Error('corrupt zip local header');
    const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    const data = archive.subarray(start, start + csize);
    let out;
    if (method === 0) out = Buffer.from(data);
    else if (method === 8) out = zlib.inflateRawSync(data);
    else throw new Error(`unsupported zip compression method ${method}`);
    if (out.length !== usize) throw new Error(`${member}: expected ${usize} bytes, got ${out.length}`);
    return out;
  }
  throw new Error(`${member} not found in the archive`);
}

// ── download ─────────────────────────────────────────────────────────────────

function hostOf(url) {
  return url.hostname.toLowerCase();
}

/** GET with per-hop host checks; returns the body of the final 200 response. */
export async function download(url, allowedHosts) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!allowedHosts.has(hostOf(current))) {
      throw new Error(`host ${current.hostname} is outside {${[...allowedHosts].sort().join(', ')}}`);
    }
    const res = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      await res.body?.cancel();
      if (!location) throw new Error(`HTTP ${res.status} without a location from ${current.href}`);
      current = new URL(location, current);
      continue;
    }
    if (res.status !== 200) {
      await res.body?.cancel();
      throw new Error(`GET ${current.href} -> HTTP ${res.status}`);
    }
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length > MAX_ARCHIVE_BYTES) throw new Error(`archive larger than ${MAX_ARCHIVE_BYTES} bytes`);
    return body;
  }
  throw new Error(`too many redirects fetching ${url.href}`);
}

function writeExecutable(target, bytes) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const part = `${target}.part`;
  fs.writeFileSync(part, bytes, { mode: 0o755 });
  fs.chmodSync(part, 0o755);
  fs.renameSync(part, target);
}

/**
 * Stage `oras-<triple>` into `outDir`. `pins` and `baseUrl` are the test seams
 * (the CLI always uses PINS). Returns `{ path, fetched }`.
 */
export async function stageTarget({ triple, outDir, baseUrl = null, pins = PINS, log = () => {} }) {
  const a = assetFor(triple);
  const pin = pins[a.asset];
  if (!pin) throw new Error(`no pinned sha256 for ${a.asset}`);
  const target = path.join(outDir, a.sidecar);

  if (fileSha256(target) === pin.binary) {
    fs.chmodSync(target, 0o755);
    log(`${a.sidecar}: present with the pinned sha256 (no download)`);
    return { path: target, fetched: false };
  }

  let url = new URL(a.url);
  const allowed = new Set(RELEASE_HOSTS);
  if (baseUrl) {
    url = new URL(url.pathname, baseUrl);
    for (const h of LOOPBACK_HOSTS) allowed.add(h);
  }
  log(`${a.sidecar}: downloading ${url.href}`);
  const archive = await download(url, allowed);
  const archiveSum = sha256(archive);
  if (archiveSum !== pin.archive) {
    throw new Error(`${a.asset}: sha256 mismatch: got ${archiveSum}, pinned ${pin.archive}; refusing it`);
  }
  const binary = a.asset.endsWith('.zip')
    ? extractFromZip(archive, a.member)
    : extractFromTarGz(archive, a.member);
  const binarySum = sha256(binary);
  if (binarySum !== pin.binary) {
    throw new Error(`${a.asset}: extracted ${a.member} sha256 mismatch: got ${binarySum}, pinned ${pin.binary}; refusing it`);
  }
  writeExecutable(target, binary);
  log(`${a.sidecar}: written (archive and binary sha256 verified)`);
  return { path: target, fetched: true };
}

/** `lipo -create` the two macOS slices into `output`. */
function lipoCreate(output, inputs) {
  execFileSync('lipo', ['-create', '-output', output, ...inputs], { stdio: 'inherit' });
}

/**
 * Stage the sidecar(s) for `triple`. For `universal-apple-darwin` this stages
 * both macOS slices and combines them; `combine` is the test seam for `lipo`.
 */
export async function fetchOras({ triple, outDir = DEFAULT_OUT_DIR, baseUrl = null, pins = PINS, log = () => {}, combine = lipoCreate }) {
  if (triple !== UNIVERSAL_DARWIN) {
    return [await stageTarget({ triple, outDir, baseUrl, pins, log })];
  }
  const slices = [];
  for (const t of ['aarch64-apple-darwin', 'x86_64-apple-darwin']) {
    slices.push(await stageTarget({ triple: t, outDir, baseUrl, pins, log }));
  }
  const target = path.join(outDir, sidecarName(UNIVERSAL_DARWIN));
  const part = `${target}.part`;
  fs.rmSync(part, { force: true });
  combine(part, slices.map((s) => s.path));
  const fresh = fs.readFileSync(part);
  if (fileSha256(target) === sha256(fresh)) {
    fs.rmSync(part);
    fs.chmodSync(target, 0o755);
    log(`${path.basename(target)}: unchanged`);
  } else {
    fs.chmodSync(part, 0o755);
    fs.renameSync(part, target);
    log(`${path.basename(target)}: written from the two verified slices`);
  }
  return [...slices, { path: target, fetched: false }];
}

function parseArgs(argv) {
  const args = { triple: null, outDir: DEFAULT_OUT_DIR, baseUrl: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new UsageError(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--out-dir') args.outDir = path.resolve(value());
    else if (a === '--base-url') args.baseUrl = value();
    else if (a === '--help' || a === '-h') {
      console.log('usage: node scripts/fetch-oras.mjs [<target-triple>] [--out-dir <dir>] [--base-url <loopback url>]');
      process.exit(0);
    } else if (a.startsWith('-')) throw new UsageError(`unknown option: ${a}`);
    else if (args.triple === null) args.triple = a;
    else throw new UsageError(`unexpected argument: ${a}`);
  }
  if (args.baseUrl !== null) {
    let base;
    try {
      base = new URL(args.baseUrl);
    } catch {
      throw new UsageError(`--base-url ${JSON.stringify(args.baseUrl)} is not a URL`);
    }
    if (!['http:', 'https:'].includes(base.protocol) || !LOOPBACK_HOSTS.includes(hostOf(base))) {
      throw new UsageError('--base-url must be an http(s) loopback URL (test seam)');
    }
    args.baseUrl = base;
  }
  return args;
}

async function main() {
  const log = (...m) => console.log('fetch-oras:', ...m);
  let args;
  let triple;
  try {
    args = parseArgs(process.argv.slice(2));
    triple = args.triple || process.env.TAURI_ENV_TARGET_TRIPLE || hostTriple();
    if (triple !== UNIVERSAL_DARWIN) assetFor(triple);
  } catch (err) {
    console.error(`fetch-oras: ${err.message}`);
    process.exit(err instanceof UsageError ? 2 : 1);
  }
  const source = args.triple ? 'argument' : process.env.TAURI_ENV_TARGET_TRIPLE ? 'TAURI_ENV_TARGET_TRIPLE' : 'host';
  log(`oras ${ORAS_VERSION} for ${triple} (from ${source}) into ${args.outDir}`);
  try {
    await fetchOras({ triple, outDir: args.outDir, baseUrl: args.baseUrl, log });
  } catch (err) {
    console.error(`fetch-oras: ${err.message}`);
    process.exit(1);
  }
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(SCRIPT_PATH);
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`fetch-oras: ${err && err.stack ? err.stack : err}`);
    process.exit(1);
  });
}
