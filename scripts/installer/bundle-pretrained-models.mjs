#!/usr/bin/env node
// scripts/installer/bundle-pretrained-models.mjs — staged bundled models (PROV-IR-4).
//
// ## WHAT IT DOES
//
// Reads the frozen `data/pretrained-catalogue/bundled-models.json` (PROV-PC-1,
// CONS-IR-6) and stages the bundled set for the Tauri installer: for every
// `models[]` entry it fetches `url` (build time only — the shipped app never
// dials the model host, INV-1/INV-2), verifies the bytes against the manifest's
// `sha256` + `size_bytes`, and writes `<out>/<file>` (`<id>@<version>.txr`).
// The manifest is copied byte-identical next to the files as
// `<out>/bundled-models.json` — one source of truth, parsed by both this
// staging step and the desktop provision module (PROV-IR-5, ITEM-3).
//
// The staged bytes are NEVER interpreted: `.txr` content is opaque to this
// script (INV-7). The staging target
// `src-app/desktop/tauri/resources/pretrained-bundled/` is gitignored — model
// bytes are never committed to the app repo (DEC-9).
//
// ## HOST POLICY (CONS-IR-6)
//
// A manifest `url` must be http(s) on `{github.com, tinnlab.github.io}`. The
// fetch follows GitHub's release-asset redirect, so redirect targets must be on
// `{github.com, objects.githubusercontent.com, tinnlab.github.io}`. `--base-url`
// is the loopback test seam (PROV-IR-4 "[--base-url <override for tests>]",
// mirroring the server's `EnvImageSeams` never-network-in-tests discipline): it
// replaces scheme+host+port of every fetch while keeping the manifest's .../ +
// path, and only a loopback host may be named.
//
// ## MODES
//
//   node scripts/installer/bundle-pretrained-models.mjs [--manifest <path>]
//       [--out <dir>] [--base-url <url>] [--dry-run] [--check]
//
// Defaults: `--manifest data/pretrained-catalogue/bundled-models.json`,
// `--out src-app/desktop/tauri/resources/pretrained-bundled` (repo-relative).
//
//   (default)  fetch every entry whose staged file is missing or mismatched,
//              verify, stage via `<file>.part` + rename, then copy the manifest
//              byte-identical. Idempotent: a verified existing file is not
//              re-fetched or rewritten.
//   --check    verify the staged set against the manifest (parity, PROV-IR-4's
//              "incomplete set" clause) WITHOUT fetching: every manifest entry
//              maps to exactly one verified staged file, no extra `.txr` file
//              is present, and `<out>/bundled-models.json` is byte-identical.
//   --dry-run  print the plan (what would be fetched/staged) and write nothing.
//
// An absent manifest is the valid "no bundled models yet" state (PROV-IR-4):
// exit 0, nothing staged. Exit 1 on a validation/verification failure (naming
// the entry or file), exit 2 on a usage error.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(SCRIPT_PATH), '..', '..');

/** Manifest url hosts (CONS-IR-6). */
const MANIFEST_URL_HOSTS = new Set(['github.com', 'tinnlab.github.io']);
/** Fetch + redirect-target hosts (PROV-IR-9: the model host + its redirect). */
const FETCH_HOSTS = new Set([
  'github.com',
  'tinnlab.github.io',
  'objects.githubusercontent.com',
]);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const MAX_REDIRECTS = 10;
const REQUEST_TIMEOUT_MS = 300_000;
const SHA256_RE = /^[0-9a-f]{64}$/;

const log = (...args) => console.log('bundle-pretrained-models:', ...args);
const fail = (code, ...lines) => {
  for (const line of lines) console.error(line);
  process.exit(code);
};

function parse_args(argv) {
  const args = {
    manifest: path.join(REPO, 'data/pretrained-catalogue/bundled-models.json'),
    out: path.join(REPO, 'src-app/desktop/tauri/resources/pretrained-bundled'),
    baseUrl: null,
    dryRun: false,
    check: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) fail(2, `bundle-pretrained-models: ${a} needs a value`);
      return argv[++i];
    };
    if (a === '--manifest') args.manifest = path.resolve(next());
    else if (a === '--out') args.out = path.resolve(next());
    else if (a === '--base-url') args.baseUrl = next();
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--check') args.check = true;
    else if (a === '--help') {
      log(`usage: node scripts/installer/bundle-pretrained-models.mjs
  [--manifest <path>] [--out <dir>] [--base-url <url>] [--dry-run] [--check]`);
      process.exit(0);
    } else fail(2, `bundle-pretrained-models: unknown option: ${a}`);
  }
  if (args.dryRun && args.check) fail(2, 'bundle-pretrained-models: --dry-run and --check are exclusive');
  return args;
}

/** Validate + normalise one manifest entry. Returns a frozen-view entry. */
function validate_entry(entry) {
  const name = entry && entry.id ? `${entry.id}@${entry.version ?? '?'}` : '<unnamed>';
  const need = (field) => {
    if (entry[field] === undefined || entry[field] === null || entry[field] === '') {
      fail(1, `bundle-pretrained-models: entry ${name} is incomplete (missing ${field})`);
    }
    return entry[field];
  };
  const id = String(need('id'));
  const version = String(need('version'));
  const file = String(need('file'));
  const url = String(need('url'));
  const sha256 = String(need('sha256'));
  const size = need('size_bytes');
  const entryName = `${id}@${version}`;

  if (file !== `${id}@${version}.txr`) {
    fail(
      1,
      `bundle-pretrained-models: entry ${entryName} has file ${JSON.stringify(file)}, ` +
        `expected ${id}@${version}.txr (PROV-PC-12 naming)`,
    );
  }
  if (!SHA256_RE.test(sha256)) {
    fail(1, `bundle-pretrained-models: entry ${entryName} sha256 ${JSON.stringify(sha256)} is not 64 lowercase hex`);
  }
  if (!Number.isInteger(size) || size <= 0) {
    fail(1, `bundle-pretrained-models: entry ${entryName} size_bytes ${JSON.stringify(size)} is not a positive integer`);
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    fail(1, `bundle-pretrained-models: entry ${entryName} url ${JSON.stringify(url)} is not a URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    fail(1, `bundle-pretrained-models: entry ${entryName} url scheme ${parsed.protocol} is not http(s)`);
  }
  if (!MANIFEST_URL_HOSTS.has(parsed.hostname)) {
    fail(
      1,
      `bundle-pretrained-models: entry ${entryName} url host ${parsed.hostname} is outside ` +
        `{${[...MANIFEST_URL_HOSTS].join(', ')}}`,
    );
  }
  return { id, version, file, url, sha256, size_bytes: size, parsed };
}

function load_manifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) return null;
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    fail(1, `bundle-pretrained-models: cannot parse manifest ${manifestPath}: ${err.message}`);
  }
  if (doc.schema_version !== 1) {
    fail(1, `bundle-pretrained-models: unsupported manifest schema_version ${JSON.stringify(doc.schema_version)}`);
  }
  if (!Array.isArray(doc.models)) {
    fail(1, 'bundle-pretrained-models: manifest models[] is not an array');
  }
  const seen = new Set();
  const entries = [];
  for (const raw of doc.models) {
    const entry = validate_entry(raw);
    if (seen.has(entry.file)) {
      fail(1, `bundle-pretrained-models: duplicate staged file in manifest: ${entry.file}`);
    }
    seen.add(entry.file);
    entries.push(entry);
  }
  return { doc, entries };
}

/** One HTTP GET (no redirects), returning { status, headers, body, finalUrl }. */
function fetch_once(url, allowedHosts) {
  return new Promise((resolve, reject) => {
    if (!allowedHosts.has(url.hostname)) {
      reject(new Error(`fetch host ${url.hostname} is outside the allowed set`));
      return;
    }
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(
      url,
      { method: 'GET', headers: { accept: 'application/octet-stream' } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
            finalUrl: res.headers.location ? new URL(res.headers.location, url) : null,
          }),
        );
      },
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error(`request timed out after ${REQUEST_TIMEOUT_MS} ms`)));
    req.on('error', reject);
    req.end();
  });
}

/** Fetch with redirect following + per-hop host validation. */
async function fetch_with_redirects(url, allowedHosts) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch_once(current, allowedHosts);
    if (res.status >= 300 && res.status < 400 && res.finalUrl) {
      current = res.finalUrl;
      if (!allowedHosts.has(current.hostname)) {
        throw new Error(
          `redirect target host ${current.hostname} is outside ` +
            `{${[...allowedHosts].sort().join(', ')}}`,
        );
      }
      continue;
    }
    if (res.status !== 200) {
      throw new Error(`GET ${current.href} -> HTTP ${res.status}`);
    }
    return res.body;
  }
  throw new Error(`too many redirects (${MAX_REDIRECTS}) fetching ${url.href}`);
}

/** Verify bytes against the manifest; on mismatch fail(1) naming the entry. */
function verify_body(entry, body) {
  if (body.length !== entry.size_bytes) {
    fail(
      1,
      `bundle-pretrained-models: entry ${entry.id}@${entry.version}: fetched ${body.length} bytes, ` +
        `manifest size_bytes ${entry.size_bytes}`,
    );
  }
  const digest = crypto.createHash('sha256').update(body).digest('hex');
  if (digest !== entry.sha256) {
    fail(
      1,
      `bundle-pretrained-models: entry ${entry.id}@${entry.version}: sha256 ${digest} != manifest ${entry.sha256}`,
    );
  }
}

/** Atomic write: `<file>.part` then rename. */
function write_atomic(target, bytes) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const part = `${target}.part`;
  fs.writeFileSync(part, bytes);
  fs.renameSync(part, target);
}

/** True when `target` exists and matches the manifest's sha256 + size. */
function staged_matches(entry, target) {
  if (!fs.existsSync(target)) return false;
  try {
    if (fs.statSync(target).size !== entry.size_bytes) return false;
    return crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex') === entry.sha256;
  } catch {
    return false;
  }
}

function effective_url(entry, baseUrl) {
  if (!baseUrl) return entry.parsed;
  const u = new URL(entry.parsed.pathname + entry.parsed.search, baseUrl);
  return u;
}

async function main() {
  const args = parse_args(process.argv.slice(2));
  if (args.baseUrl) {
    let base;
    try {
      base = new URL(args.baseUrl);
    } catch {
      fail(2, `bundle-pretrained-models: --base-url ${JSON.stringify(args.baseUrl)} is not a URL`);
    }
    if (base.protocol !== 'http:' && base.protocol !== 'https:') {
      fail(2, 'bundle-pretrained-models: --base-url must be http(s)');
    }
    if (!LOOPBACK_HOSTS.has(base.hostname)) {
      fail(2, `bundle-pretrained-models: --base-url host ${base.hostname} must be a loopback host (test seam)`);
    }
    args.baseUrl = base;
  }

  const manifest = load_manifest(args.manifest);
  if (manifest === null) {
    log(`no manifest at ${args.manifest} — no bundled models yet; staging nothing (valid state)`);
    process.exit(0);
  }
  const { entries } = manifest;
  const outDir = args.out;

  if (args.check) {
    if (!fs.existsSync(outDir) || !fs.statSync(outDir).isDirectory()) {
      fail(1, `bundle-pretrained-models: --check: out dir not found: ${outDir}`);
    }
    const manifestCopy = path.join(outDir, 'bundled-models.json');
    if (!fs.existsSync(manifestCopy) || !fs.readFileSync(manifestCopy).equals(fs.readFileSync(args.manifest))) {
      fail(1, `bundle-pretrained-models: --check: ${manifestCopy} is missing or not byte-identical to ${args.manifest}`);
    }
    const staged = new Set(
      fs.readdirSync(outDir).filter((n) => n.endsWith('.txr')).sort(),
    );
    for (const entry of entries) {
      if (!staged.has(entry.file)) {
        fail(1, `bundle-pretrained-models: --check: staged file missing for entry ${entry.id}@${entry.version}: ${entry.file}`);
      }
      if (!staged_matches(entry, path.join(outDir, entry.file))) {
        fail(1, `bundle-pretrained-models: --check: staged file ${entry.file} does not match the manifest`);
      }
    }
    for (const extra of staged) {
      if (!manifest.entries.some((e) => e.file === extra)) {
        fail(1, `bundle-pretrained-models: --check: unexpected staged file: ${extra}`);
      }
    }
    log(`--check: ${entries.length} bundled model(s) verified in ${outDir}`);
    process.exit(0);
  }

  if (args.dryRun) {
    log(`--dry-run: would stage ${entries.length} bundled model(s) into ${outDir}`);
    for (const entry of entries) {
      log(
        `  stage ${entry.id}@${entry.version} -> ${path.relative(REPO, path.join(outDir, entry.file))} ` +
          `(from ${effective_url(entry, args.baseUrl).href}, ${entry.size_bytes} bytes, ` +
          `sha256 ${entry.sha256.slice(0, 12)}…)`,
      );
    }
    log(`  copy bundled-models.json -> ${path.relative(REPO, path.join(outDir, 'bundled-models.json'))} (byte-identical)`);
    process.exit(0);
  }

  const allowedHosts = new Set([
    ...FETCH_HOSTS,
    ...(args.baseUrl ? [...LOOPBACK_HOSTS] : []),
  ]);

  let stagedCount = 0;
  for (const entry of entries) {
    const target = path.join(outDir, entry.file);
    if (staged_matches(entry, target)) {
      log(`already staged + verified: ${entry.file} (skip)`);
      continue;
    }
    const u = effective_url(entry, args.baseUrl);
    log(`fetching ${entry.id}@${entry.version} from ${u.href}`);
    let body;
    try {
      body = await fetch_with_redirects(u, allowedHosts);
    } catch (err) {
      fail(1, `bundle-pretrained-models: entry ${entry.id}@${entry.version}: fetch failed: ${err.message}`);
    }
    verify_body(entry, body);
    write_atomic(target, body);
    stagedCount++;
    log(`staged ${entry.file} (${entry.size_bytes} bytes, sha256 verified)`);
  }

  // The manifest copy after all entries staged, so a failure never leaves the
  // staged set claiming a state it is not in.
  const manifestCopy = path.join(outDir, 'bundled-models.json');
  const manifestBytes = fs.readFileSync(args.manifest);
  if (!fs.existsSync(manifestCopy) || !fs.readFileSync(manifestCopy).equals(manifestBytes)) {
    write_atomic(manifestCopy, manifestBytes);
    log(`copied bundled-models.json -> ${path.relative(REPO, manifestCopy)} (byte-identical)`);
  } else {
    log('bundled-models.json already current (skip)');
  }

  log(`done: ${entries.length} bundled model(s), ${stagedCount} staged now, into ${outDir}`);
}

main().catch((err) => {
  // An unexpected top-level error must not read as success.
  fail(1, `bundle-pretrained-models: ${err && err.stack ? err.stack : err}`);
});
