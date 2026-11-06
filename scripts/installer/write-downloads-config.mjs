#!/usr/bin/env node
// scripts/installer/write-downloads-config.mjs — `site/config.json` downloads[] (PROV-IR-3).
//
// ## WHAT IT DOES
//
// Reads the `site/config.json` (schema v1, PROV-landing-site-4) and REPLACES
// only its `downloads[]` with the four release rows — macos/dmg,
// windows/nsis, linux/deb, linux/appimage — computed from the discovered
// `ArtifactSet` (PROV-IR-1 / `discover-artifacts.mjs`):
//
//   url      = https://github.com/tinnlab/txresbench-app/releases/download/app-v<version>/<file>
//   size_mb  = ceil(size_bytes / 1 MiB)
//   sha256   = the artifact's 64-lowercase-hex digest (verified at discovery time)
//
// Every OTHER key of the config is preserved (values never touched; the
// file is re-serialized deterministically — the config is not a byte-copy
// contract like the `site/public` feeds). The existing rows' `label` +
// `detail` (the copy the landing-site owns, board M) are kept per (os, kind):
// the writer fills in the values it can compute and never rewrites page copy.
// The rows keep the config's own order, and the config must carry exactly the
// four combos — a fifth kind, a missing combo or a duplicate is a named
// error (the site build rejects a fifth kind anyway; the writer refuses
// earlier, in the same place that knows the artifact set).
//
// ## THE VERSION RULE (DEC-13, PROV-landing-site-4)
//
// `config.product.version` must equal the ArtifactSet `version` (which
// `discover-artifacts.mjs` cross-checked against
// `src-app/desktop/tauri/tauri.conf.json`). The row urls carry the same
// version in their `app-v<semver>` tag, and the site build already fails
// when that tag drifts from `product.version` — so a partial update (config
// version bumped without the tauri manifest, or the reverse) is a named
// exit-1 here instead of a stale page.
//
// ## EXIT CODES
//
// 0 = config written; 1 = validation/mismatch failure (nothing written —
// the output is only written after every input validates, via a `.part`-
// rename); 2 = usage error.
//
//   node scripts/installer/write-downloads-config.mjs --artifacts <json>
//       [--out <path>]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(SCRIPT_PATH), '..', '..');

// The same grammar the site build validates sha256 with (PROV-landing-site-4).
const SHA256_RE = /^[0-9a-f]{64}$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const NAME_RE = /^[^/\\]+$/;

const RELEASE_DOWNLOAD_BASE = 'https://github.com';
const RELEASE_DOWNLOAD_PATH = '/tinnlab/txresbench-app/releases/download/app-v';
const MIB = 1024 * 1024;

/** The PROV-IR-3 os/kind matrix (landing-site PROV-4's OS_KINDS, DEC-12). */
const OS_KINDS = new Map([
  ['macos', ['dmg']],
  ['windows', ['nsis']],
  ['linux', ['deb', 'appimage']],
]);
const ALL_COMBOS = [...OS_KINDS.entries()].flatMap(([os, kinds]) => kinds.map((kind) => `${os}/${kind}`)).sort();

const log = (...args) => console.log('write-downloads-config:', ...args);
const fail = (code, ...lines) => {
  for (const line of lines) console.error(line);
  process.exit(code);
};

function parse_args(argv) {
  const args = {
    artifacts: null,
    out: path.join(REPO, 'site/config.json'),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help') {
      log(`usage: node scripts/installer/write-downloads-config.mjs
  --artifacts <json> [--out <path>]`);
      process.exit(0);
    }
    if (a === '--artifacts') {
      if (i + 1 >= argv.length) fail(2, 'write-downloads-config: --artifacts needs a value');
      args.artifacts = path.resolve(argv[++i]);
    } else if (a === '--out') {
      if (i + 1 >= argv.length) fail(2, 'write-downloads-config: --out needs a value');
      args.out = path.resolve(argv[++i]);
    } else fail(2, `write-downloads-config: unknown option: ${a}`);
  }
  if (args.artifacts === null) fail(2, 'write-downloads-config: missing required option: --artifacts');
  return args;
}

function read_json(file, what) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    fail(1, `write-downloads-config: ${what} not found: ${file}`);
  }
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    fail(1, `write-downloads-config: ${what} is not valid JSON (${err.message})`);
  }
  return doc;
}

/** Validate the ArtifactSet: exactly the four combos, one row each, honest fields. */
function load_artifacts(file) {
  const doc = read_json(file, 'artifacts json');
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    fail(1, `write-downloads-config: ${file} root must be a single JSON object (a PROV-IR-1 ArtifactSet)`);
  }
  if (typeof doc.version !== 'string' || !SEMVER_RE.test(doc.version)) {
    fail(1, `write-downloads-config: artifacts version ${JSON.stringify(doc.version)} is not a semver string`);
  }
  if (!Array.isArray(doc.downloads)) {
    fail(1, 'write-downloads-config: artifacts downloads[] is not an array');
  }
  const byCombo = new Map();
  for (const [i, row] of doc.downloads.entries()) {
    if (row === null || typeof row !== 'object') fail(1, `write-downloads-config: artifacts downloads[${i}] must be an object`);
    const os = row.os;
    const kind = row.kind;
    const label = `${os ?? '<missing os>'}/${kind ?? '<missing kind>'}`;
    const allowed = OS_KINDS.get(os);
    if (!allowed || !allowed.includes(kind)) {
      fail(1, `write-downloads-config: artifacts downloads[${i}] ${label} is outside the PROV-IR-3 matrix (${ALL_COMBOS.join(', ')})`);
    }
    if (byCombo.has(label)) {
      fail(1, `write-downloads-config: duplicate artifact row ${label}`);
    }
    if (typeof row.file !== 'string' || !NAME_RE.test(row.file)) {
      fail(1, `write-downloads-config: artifacts row ${label} file ${JSON.stringify(row.file)} is not a bare file name`);
    }
    if (!Number.isInteger(row.size_bytes) || row.size_bytes <= 0) {
      fail(1, `write-downloads-config: artifacts row ${label} size_bytes ${JSON.stringify(row.size_bytes)} is not a positive integer`);
    }
    if (typeof row.sha256 !== 'string' || !SHA256_RE.test(row.sha256)) {
      fail(1, `write-downloads-config: artifacts row ${label} sha256 ${JSON.stringify(row.sha256)} is not 64 lowercase hex`);
    }
    byCombo.set(label, row);
  }
  const combos = [...byCombo.keys()].sort();
  if (combos.length !== ALL_COMBOS.length || combos.some((c, i) => c !== ALL_COMBOS[i])) {
    fail(
      1,
      `write-downloads-config: artifact set must be exactly ${ALL_COMBOS.join(', ')} ` +
        `(got ${combos.length === 0 ? 'none' : combos.join(', ')}; a missing or extra combo is a release-matrix error)`,
    );
  }
  return { version: doc.version, byCombo };
}

/** The release-download url for an artifact file, re-validated (PROV-IR-3). */
function release_url(version, row, label) {
  const url = `${RELEASE_DOWNLOAD_BASE}${RELEASE_DOWNLOAD_PATH}${version}/${row.file}`;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    fail(1, `write-downloads-config: artifacts row ${label} file ${JSON.stringify(row.file)} cannot form a release url`);
  }
  const expectedPath = `${RELEASE_DOWNLOAD_PATH}${version}/${row.file}`;
  if (parsed.hostname !== 'github.com' || parsed.pathname !== expectedPath || parsed.search !== '' || parsed.hash !== '') {
    fail(
      1,
      `write-downloads-config: artifacts row ${label} file ${JSON.stringify(row.file)} is outside the release ` +
        `download prefix (expected ${url})`,
    );
  }
  return url;
}

/** Atomic write: `<file>.part` then rename. */
function write_atomic(target, bytes) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const part = `${target}.part`;
  fs.writeFileSync(part, bytes);
  fs.renameSync(part, target);
}

function main() {
  const args = parse_args(process.argv.slice(2));
  const artifacts = load_artifacts(args.artifacts);

  const config = read_json(args.out, 'site config');
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    fail(1, `write-downloads-config: ${args.out} root must be a single JSON object (schema v1)`);
  }
  const configVersion = config.product && config.product.version;
  if (typeof configVersion !== 'string' || configVersion.trim() === '') {
    fail(1, 'write-downloads-config: site config carries no product.version');
  }
  if (configVersion !== artifacts.version) {
    fail(
      1,
      `write-downloads-config: version mismatch: config product.version ${JSON.stringify(configVersion)} vs ` +
        `artifacts version ${JSON.stringify(artifacts.version)} (the row urls would carry app-v${artifacts.version} ` +
        `under a page advertising ${configVersion}; align the config first, PROV-landing-site-4)`,
    );
  }

  if (!Array.isArray(config.downloads)) {
    fail(1, 'write-downloads-config: site config downloads[] is not an array');
  }
  const seen = new Set();
  const rows = config.downloads.map((row, i) => {
    if (row === null || typeof row !== 'object') fail(1, `write-downloads-config: config downloads[${i}] must be an object`);
    const label = `${row.os ?? '<missing os>'}/${row.kind ?? '<missing kind>'}`;
    // The row's label/detail are the landing-site's own page copy (board M);
    // the writer fills only the values the artifact set can compute, so a row
    // without copy is a wire error, never something to invent here.
    if (typeof row.label !== 'string' || row.label.trim() === '' || typeof row.detail !== 'string' || row.detail.trim() === '') {
      fail(1, `write-downloads-config: config downloads[${i}] ${label} carries no label/detail copy (the site build would refuse it)`);
    }
    const artifact = artifacts.byCombo.get(label);
    if (!artifact) {
      fail(
        1,
        `write-downloads-config: config downloads[${i}] ${label} has no artifact row ` +
          `(expected exactly ${ALL_COMBOS.join(', ')}; a row outside the release matrix is a site-wiring error)`,
      );
    }
    if (seen.has(label)) fail(1, `write-downloads-config: config downloads[${i}] duplicates ${label}`);
    seen.add(label);
    return {
      ...row,
      url: release_url(artifacts.version, artifact, label),
      size_mb: Math.ceil(artifact.size_bytes / MIB),
      sha256: artifact.sha256,
    };
  });
  for (const combo of ALL_COMBOS) {
    if (!seen.has(combo)) {
      fail(1, `write-downloads-config: config downloads[] is missing ${combo} (the page must offer every released platform)`);
    }
  }
  config.downloads = rows;

  write_atomic(args.out, `${JSON.stringify(config, null, 1)}\n`);
  log(`wrote ${path.relative(REPO, args.out)} (${rows.length} download rows, version ${artifacts.version})`);
}

main();
