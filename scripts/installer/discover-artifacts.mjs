#!/usr/bin/env node
// scripts/installer/discover-artifacts.mjs — PROV-IR-1 CLI (the fan-out the
// release pipeline drives: discovery -> feed writer + downloads writer).
//
// ## WHAT IT DOES
//
// Prints the `ArtifactSet` the lib's `discover_artifacts` returns: the four
// user-download rows (macos/dmg, windows/nsis, linux/deb, linux/appimage) and
// the three updater payloads (AppImage, the universal `.app.tar.gz`, the NSIS
// exe) with their `.sig` siblings, sized + sha256-verified from the bundle
// dir. The output JSON is what `write-downloads-config.mjs` (PROV-IR-3)
// consumes; `make-update-feed.mjs` (PROV-IR-2) takes the same values as its
// explicit file arguments, so the pipeline can only ever feed the two writers
// from ONE discovered set.
//
// ## VERSION (DEC-13)
//
// `src-app/desktop/tauri/tauri.conf.json` `version` is the single source of
// truth. The CLI reads it and passes it to the lib as the cross-check (the lib
// refuses when any artifact filename carries a different semver), so the
// pipeline never trusts filenames alone — and it never guesses. An explicit
// `--version` must equal the manifest's version; a manifest that cannot be
// read is a fail-closed error (the same posture as the landing-site build's
// drift check). `--tauri-conf` is the test seam (a fixture manifest), the
// default is the shipped manifest.
//
// ## EXIT CODES
//
// 0 = JSON written; 1 = missing/ambiguous/unsigned/invalid artifact or a
// version mismatch (the message names the kind or both versions); 2 = usage
// error. The lib throws `Error` naming the artifact; this wrapper maps a throw
// to exit 1, so the named-failure semantics are the same at both layers.
//
//   node scripts/installer/discover-artifacts.mjs [--bundle-dir <dir>]
//       [--version <semver>] [--tauri-conf <path>] [--out <file>]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { discover_artifacts } from './lib/artifacts.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(SCRIPT_PATH), '..', '..');

const log = (...args) => console.log('discover-artifacts:', ...args);
const fail = (code, ...lines) => {
  for (const line of lines) console.error(line);
  process.exit(code);
};

function parse_args(argv) {
  const args = {
    bundleDir: path.join(REPO, 'src-app/desktop/tauri/target/release/bundle'),
    version: null,
    tauriConf: path.join(REPO, 'src-app/desktop/tauri/tauri.conf.json'),
    out: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) fail(2, `discover-artifacts: ${a} needs a value`);
      return argv[++i];
    };
    if (a === '--bundle-dir') args.bundleDir = path.resolve(next());
    else if (a === '--version') args.version = next();
    else if (a === '--tauri-conf') args.tauriConf = path.resolve(next());
    else if (a === '--out') args.out = path.resolve(next());
    else if (a === '--help') {
      log(`usage: node scripts/installer/discover-artifacts.mjs
  [--bundle-dir <dir>] [--version <semver>] [--tauri-conf <path>] [--out <file>]`);
      process.exit(0);
    } else fail(2, `discover-artifacts: unknown option: ${a}`);
  }
  return args;
}

/** The app manifest's `version`, or a fail-closed error (DEC-13). */
function manifest_version(tauriConf) {
  if (!fs.existsSync(tauriConf)) {
    fail(
      1,
      `discover-artifacts: cannot verify the artifact version: ${path.relative(REPO, tauriConf)} ` +
        `is missing (the Tauri manifest is the single version source of truth, DEC-13)`,
    );
  }
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(tauriConf, 'utf8'));
  } catch (err) {
    fail(1, `discover-artifacts: cannot verify the artifact version: ${path.relative(REPO, tauriConf)} is not valid JSON (${err.message})`);
  }
  const version = doc && doc.version;
  if (typeof version !== 'string' || version.trim() === '') {
    fail(
      1,
      `discover-artifacts: cannot verify the artifact version: ${path.relative(REPO, tauriConf)} ` +
        `carries no version string (DEC-13)`,
    );
  }
  return version;
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
  const manifestVersion = manifest_version(args.tauriConf);
  if (args.version && args.version !== manifestVersion) {
    fail(
      1,
      `discover-artifacts: version mismatch: ${args.version} passed as --version vs ` +
        `${manifestVersion} in ${path.relative(REPO, args.tauriConf)} (DEC-13: the manifest wins)`,
    );
  }

  const set = discover_artifacts(args.bundleDir, { version: manifestVersion });
  const bytes = `${JSON.stringify(set, null, 1)}\n`;
  if (args.out) {
    write_atomic(args.out, bytes);
    log(`wrote ${path.relative(REPO, args.out)} (version ${set.version}, ${set.downloads.length} download row(s), ` +
      `${Object.keys(set.updater).length} updater payload(s))`);
  } else {
    process.stdout.write(bytes);
  }
}

main();
