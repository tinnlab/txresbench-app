#!/usr/bin/env node
// scripts/installer/make-update-feed.mjs — the Tauri v2 update feed (PROV-IR-2).
//
// ## WHAT IT WRITES
//
// `site/public/updates/latest.json` — the landing-site PROV-5 wire shape
// EXACTLY, at the source path the site build hosts byte-identical:
//
//   { version, pub_date?, notes?, platforms: {
//       darwin-aarch64: {url, signature},
//       darwin-x86_64:  {url, signature},   (the SAME universal payload, DEC-6)
//       linux-x86_64:   {url, signature},   (the AppImage, DEC-7)
//       windows-x86_64: {url, signature} }  (the NSIS exe)
//     }
//
// The four platform keys are written in landing-site's fixed order
// (PROV-landing-site-5); the root keys in the order above; the file is
// byte-deterministic for identical inputs (1-space indent, fixed key order,
// no timestamp except the optional --pub-date, which is written verbatim).
//
// Every `url` is constructed from the artifact's file name against the ONLY
// host the release pipeline publishes to:
//
//   https://github.com/tinnlab/txresbench-app/releases/download/app-v<version>/<file>
//
// and the composed URL is re-validated (host == github.com, exact path
// prefix, no query or fragment) before anything is written — a file name that
// would break out of the prefix (a `..` escaping the path, a `?`/`#` turning
// the rest into a query or fragment) is a named error, never a silent url.
// The feed's entries are the updater PAYLOADS only: the AppImage, the
// universal `.app.tar.gz` and the NSIS exe — never the user-download dmg
// (DEC-8) and never a model asset (the model host is not in the release
// path; feed urls are built solely from the six artifacts named on the
// command line).
//
// Each `signature` is the artifact's `.sig` file content VERBATIM (the
// minisign signature `bundle.createUpdaterArtifacts` produced), and a
// missing, unreadable or whitespace-only signature aborts with the platform
// named — an unsigned update must never be published (Tauri refuses it, and
// this writer refuses to pretend otherwise).
//
// ## VERSION (DEC-13)
//
// `--version` must be semver AND equal to
// `src-app/desktop/tauri/tauri.conf.json` `version` — the app's single
// version source of truth; a mismatch exits 1 naming both values, and a
// manifest that cannot be read is a fail-closed error. `--tauri-conf` is the
// test seam (a fixture manifest); the default is the shipped manifest.
//
// ## EXIT CODES
//
// 0 = feed written; 1 = validation/policy failure (nothing written — the
// output is only ever written after every input validates, via a
// `.part`-rename); 2 = usage error.
//
//   node scripts/installer/make-update-feed.mjs --version <semver>
//       --appimage <file> --appimage-sig <file>
//       --darwin-app <file> --darwin-sig <file>
//       --nsis <file> --nsis-sig <file>
//       [--pub-date <RFC3339>] [--notes <file>]
//       [--out <path>] [--tauri-conf <path>]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FEED_PLATFORM_ORDER } from './lib/artifacts.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(SCRIPT_PATH), '..', '..');

// The same grammar the site build validates against
// (scripts/build-landing-site.mjs SEMVER_RE / RFC3339_RE) — the writer's
// output must pass the site build, so the two never diverge.
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const RELEASE_DOWNLOAD_BASE = 'https://github.com';
const RELEASE_DOWNLOAD_PATH = '/tinnlab/txresbench-app/releases/download/app-v';

const log = (...args) => console.log('make-update-feed:', ...args);
const fail = (code, ...lines) => {
  for (const line of lines) console.error(line);
  process.exit(code);
};

function parse_args(argv) {
  const args = {
    version: null,
    appimage: null,
    appimageSig: null,
    darwinApp: null,
    darwinSig: null,
    nsis: null,
    nsisSig: null,
    pubDate: null,
    notes: null,
    out: path.join(REPO, 'site/public/updates/latest.json'),
    tauriConf: path.join(REPO, 'src-app/desktop/tauri/tauri.conf.json'),
  };
  const takesValue = {
    '--version': 'version',
    '--appimage': 'appimage',
    '--appimage-sig': 'appimageSig',
    '--darwin-app': 'darwinApp',
    '--darwin-sig': 'darwinSig',
    '--nsis': 'nsis',
    '--nsis-sig': 'nsisSig',
    '--pub-date': 'pubDate',
    '--notes': 'notes',
    '--out': 'out',
    '--tauri-conf': 'tauriConf',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help') {
      log(`usage: node scripts/installer/make-update-feed.mjs
  --version <semver> --appimage <file> --appimage-sig <file>
  --darwin-app <file> --darwin-sig <file> --nsis <file> --nsis-sig <file>
  [--pub-date <RFC3339>] [--notes <file>] [--out <path>] [--tauri-conf <path>]`);
      process.exit(0);
    }
    const key = takesValue[a];
    if (!key) fail(2, `make-update-feed: unknown option: ${a}`);
    if (i + 1 >= argv.length) fail(2, `make-update-feed: ${a} needs a value`);
    args[key] = argv[++i];
  }
  const required = ['version', 'appimage', 'appimageSig', 'darwinApp', 'darwinSig', 'nsis', 'nsisSig'];
  for (const key of required) {
    if (args[key] === null) fail(2, `make-update-feed: missing required option: --${key.replace(/([A-Z])/g, '-$1').toLowerCase()}`);
  }
  if (args.out) args.out = path.resolve(args.out);
  if (args.tauriConf) args.tauriConf = path.resolve(args.tauriConf);
  return args;
}

/** The app manifest's `version`, or a fail-closed error (DEC-13). */
function manifest_version(tauriConf) {
  if (!fs.existsSync(tauriConf)) {
    fail(
      1,
      `make-update-feed: cannot verify the version: ${path.relative(REPO, tauriConf)} is missing ` +
        `(the Tauri manifest is the single version source of truth, DEC-13)`,
    );
  }
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(tauriConf, 'utf8'));
  } catch (err) {
    fail(1, `make-update-feed: cannot verify the version: ${path.relative(REPO, tauriConf)} is not valid JSON (${err.message})`);
  }
  const version = doc && doc.version;
  if (typeof version !== 'string' || version.trim() === '') {
    fail(
      1,
      `make-update-feed: cannot verify the version: ${path.relative(REPO, tauriConf)} carries no version string (DEC-13)`,
    );
  }
  return version;
}

/**
 * The release-download url for one artifact file name, re-validated.
 *
 * `file` must be an existing file (its BASENAME is what the url names — a
 * caller can pass the artifact path; the published url always uses the bare
 * name). The composed url is parsed back and must be exactly the
 * github.com release-download prefix with the version: no query, no
 * fragment, no path normalization escape.
 */
function release_url(version, file, label) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    fail(1, `make-update-feed: ${label} artifact not found: ${file}`);
  }
  const base = path.basename(file);
  if (base === '' || base === '.' || base === '..') {
    fail(1, `make-update-feed: ${label} artifact file name ${JSON.stringify(base)} cannot form a release url`);
  }
  const url = `${RELEASE_DOWNLOAD_BASE}${RELEASE_DOWNLOAD_PATH}${version}/${base}`;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    fail(1, `make-update-feed: ${label} artifact file name ${JSON.stringify(base)} cannot form a release url`);
  }
  const expectedPath = `${RELEASE_DOWNLOAD_PATH}${version}/${base}`;
  if (parsed.hostname !== 'github.com' || parsed.pathname !== expectedPath || parsed.search !== '' || parsed.hash !== '') {
    fail(
      1,
      `make-update-feed: ${label} artifact file name ${JSON.stringify(base)} is outside the release ` +
        `download prefix (expected ${url})`,
    );
  }
  return url;
}

/** The `.sig` content, verbatim; a missing/empty signature is a named abort. */
function signature_of(sigFile, label) {
  if (!fs.existsSync(sigFile) || !fs.statSync(sigFile).isFile()) {
    fail(1, `make-update-feed: ${label} signature file not found: ${sigFile}`);
  }
  const content = fs.readFileSync(sigFile, 'utf8');
  if (content.trim() === '') {
    fail(1, `make-update-feed: ${label} signature is empty; refusing to publish an unsigned update`);
  }
  return content;
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

  if (!SEMVER_RE.test(args.version)) {
    fail(1, `make-update-feed: --version ${JSON.stringify(args.version)} is not a semver string`);
  }
  const manifestVersion = manifest_version(args.tauriConf);
  if (args.version !== manifestVersion) {
    fail(
      1,
      `make-update-feed: version mismatch: ${args.version} passed as --version vs ` +
        `${manifestVersion} in ${path.relative(REPO, args.tauriConf)} (DEC-13: the manifest wins)`,
    );
  }
  if (args.pubDate !== null && !RFC3339_RE.test(args.pubDate)) {
    fail(1, `make-update-feed: --pub-date ${JSON.stringify(args.pubDate)} is not an RFC3339 date-time with a zone offset`);
  }

  const darwinUrl = release_url(args.version, args.darwinApp, 'darwin (.app.tar.gz)');
  const linuxUrl = release_url(args.version, args.appimage, 'linux (AppImage)');
  const windowsUrl = release_url(args.version, args.nsis, 'windows (NSIS exe)');

  // One signature per payload; darwin serves BOTH darwin feed keys (DEC-6).
  const darwinSig = signature_of(args.darwinSig, 'darwin');
  const linuxSig = signature_of(args.appimageSig, 'linux');
  const windowsSig = signature_of(args.nsisSig, 'windows');

  const feed = {
    version: args.version,
  };
  if (args.pubDate !== null) feed.pub_date = args.pubDate;
  if (args.notes !== null) {
    if (!fs.existsSync(args.notes) || !fs.statSync(args.notes).isFile()) {
      fail(1, `make-update-feed: --notes file not found: ${args.notes}`);
    }
    feed.notes = fs.readFileSync(args.notes, 'utf8');
  }
  feed.platforms = {
    'darwin-aarch64': { url: darwinUrl, signature: darwinSig },
    'darwin-x86_64': { url: darwinUrl, signature: darwinSig },
    'linux-x86_64': { url: linuxUrl, signature: linuxSig },
    'windows-x86_64': { url: windowsUrl, signature: windowsSig },
  };

  // The one thing no writer may do: write a feed whose platform key set is
  // not exactly the frozen PROV-5 set in its fixed order. Object key order
  // is insertion order, so the literal above + the lib's fixed order check
  // keep the emitted bytes deterministic and contract-shaped.
  if (JSON.stringify(Object.keys(feed.platforms)) !== JSON.stringify(FEED_PLATFORM_ORDER)) {
    fail(1, 'make-update-feed: internal platform set drift (refusing to write)');
  }

  const bytes = `${JSON.stringify(feed, null, 1)}\n`;
  write_atomic(args.out, bytes);
  log(`wrote ${path.relative(REPO, args.out)} (version ${args.version}, 4 platforms, darwin payload shared)`);
}

main();
