// scripts/installer/lib/artifacts.mjs — Tauri bundle-artifact discovery (PROV-IR-1).
//
// ## THE SEAM THIS PINS (landing-site DEC-13)
//
// `landing-site`'s PROV-landing-site-4/6 binds the download-link contract on
// `site/config.json` `downloads[]` rows and explicitly imposes NO filename
// convention: "the `installers-release` node pins the asset names its pipeline
// emits". This module is that pin. It reads the Tauri bundler output the
// release pipeline produces and returns the mapping the rest of the node —
// `make-update-feed.mjs` and `write-downloads-config.mjs` (ITEM-5) — consumes.
//
// ## THE INPUT: the Tauri v2 bundle dir
//
// `tauri build` writes per-OS bundles under
// `src-app/desktop/tauri/target/release/bundle/`:
//
//   deb/       `<mainBinaryName?>_<version>_<arch>.deb`            (Linux x86_64)
//   appimage/  `<productName>_<version>_<arch>.AppImage` (+ `.sig`)
//   macos/     `<productName>_<version>_<arch>.dmg`                (user download)
//              `<productName>_<version>_<arch>.app.tar.gz` (+ `.sig`, updater payload)
//   nsis/      `<productName>_<version>_<arch>-setup.exe` (+ `.sig`)
//
// The discovery is PATTERN-based — an entry is found by its extension pattern
// inside its directory, never by spelling the full name. Anything the bundler
// names differently (a different product name, a `-R` release suffix in the
// version, a renamed binary) is still found, as long as it keeps the
// conventional extension. A directory holding more than one candidate for a
// kind is an error, and so is an absent directory or empty match for a
// required kind: the release pipeline must produce exactly one artifact of
// each required kind, and a split-bundle build (e.g. two AppImages) is a
// configuration error rather than something to guess about.
//
// ## THE MAPPING (PROV-IR-1, fixed by DEC-6/7/8)
//
//   user-download rows (board M tiles):
//     macos   `dmg`       — the universal .dmg
//     windows `nsis`      — the x64 NSIS -setup.exe
//     linux   `deb` + `appimage`
//   updater payloads (feed entries):
//     darwin  `.app.tar.gz`   — the SAME artifact serves `darwin-aarch64` and
//                               `darwin-x86_64` (DEC-6, tauri-action universal
//                               convention); the plain dmg is NOT an updater
//                               artifact (DEC-8)
//     linux   the AppImage    — self-update-capable bundle (DEC-7)
//     windows the NSIS exe
//   Every updater payload must carry its `<file>.sig` sibling (produced by
//   `bundle.createUpdaterArtifacts: true`); the signature file path is what
//   PROV-IR-2's feed writer needs, its bytes are that file's content verbatim.
//
// ## VERSION
//
// `tauri.conf.json` `version` is the single source of truth (DEC-13), but the
// bundle dir itself carries the version in every artifact name, so
// `discover_artifacts(bundle_dir)` derives it by scanning the discovered names
// for the semver token. Exactly one distinct version across the artifact set is
// required; a caller may pass `{ version }` and the derivation cross-checks it
// (a mismatch is an error, never a guess).
//
// ## ERRORS
//
// The functions throw `Error` with a message naming the artifact/kind; the CLI
// wrapper (scripts/installer/discover-artifacts.mjs, ITEM-5) maps a throw to
// exit 1. `sha256_file` is the shared zero-dep hasher so the writers never
// reimplement it.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** The four platform keys of landing-site PROV-5, in its fixed order. */
export const FEED_PLATFORM_ORDER = [
  'darwin-aarch64',
  'darwin-x86_64',
  'linux-x86_64',
  'windows-x86_64',
];

/** The download-row kinds the release matrix emits (DEC-12's four-value set). */
export const DOWNLOAD_KINDS = ['dmg', 'nsis', 'deb', 'appimage'];

/** A semver token. Deliberately NOT a bare `\b\d+…` scan: a filename like
 *  `Tool-1.3.0-x64-setup.exe` would swallow `-x64-setup.something` into a
 *  "pre-release", and a `\b` never sits on the `_` that Tauri puts around the
 *  version. Each kind therefore extracts its version-candidate group from its
 *  anchored shape and the group must BE a semver, not merely contain one. */
const VERSION_SOURCE = '\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z]+(?:\\.[0-9A-Za-z]+)*)?';
const VERSION_FULL = new RegExp(`^${VERSION_SOURCE}$`);

/** Per-kind anchored filename shapes; group 1 is the version candidate. */
const NAME_SHAPES = [
  // Linux debs: `<name>_<version>_<arch>.deb`
  { kind: 'deb', re: /^[A-Za-z0-9._-]+_([A-Za-z0-9._-]+)_[A-Za-z0-9.-]+\.deb$/ },
  // AppImage: `<name>_<version>_<arch>.AppImage`
  { kind: 'appimage', re: /^[A-Za-z0-9._ -]+_([A-Za-z0-9._-]+)_[A-Za-z0-9.-]+\.AppImage$/ },
  // macOS user download: `<name>_<version>_<arch>.dmg`
  { kind: 'dmg', re: /^[A-Za-z0-9._ -]+_([A-Za-z0-9._-]+)_[A-Za-z0-9.-]+\.dmg$/ },
  // macOS updater payload: `<name>_<version>_<arch>.app.tar.gz`
  { kind: 'darwin-updater', re: /^[A-Za-z0-9._ -]+_([A-Za-z0-9._-]+)_[A-Za-z0-9.-]+\.app\.tar\.gz$/ },
  // Windows NSIS: `<name>_<version>_<arch>-setup.exe` (the Tauri shape) or a
  // `-`-separated variant of the same parts
  { kind: 'nsis', re: /^[A-Za-z0-9._ -]+[_-]([A-Za-z0-9._-]+)[_-][A-Za-z0-9.-]+-setup\.exe$/ },
];

/** The version a filename of `kind` carries, or null when it does not parse. */
function version_of(name, kind) {
  const shape = NAME_SHAPES.find((s) => s.kind === kind);
  const m = shape.re.exec(name);
  if (!m) return null;
  return VERSION_FULL.test(m[1]) ? m[1] : null;
}

/** Required kinds: dir -> { pattern, label } where label names the kind in errors. */
const REQUIRED_KINDS = [
  { label: 'deb', dir: 'deb', pattern: /\.deb$/ },
  { label: 'appimage', dir: 'appimage', pattern: /\.AppImage$/ },
  { label: 'dmg', dir: 'macos', pattern: /\.dmg$/ },
  { label: 'darwin-updater', dir: 'macos', pattern: /\.app\.tar\.gz$/ },
  { label: 'nsis', dir: 'nsis', pattern: /setup\.exe$/i },
];

/** SHA-256 of a file, lowercase hex. The one hasher for artifact sizes. */
export function sha256_file(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

/** The regular files directly inside `dir`, sorted by name. */
function list_files(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort();
}

/**
 * Every required artifact from `bundle_dir`, as the PROV-IR-1 `ArtifactSet`.
 *
 * @param {string} bundle_dir the Tauri `target/release/bundle` directory
 * @param {{version?: string}} [opts] an explicit version to cross-check
 */
export function discover_artifacts(bundle_dir, opts = {}) {
  if (!fs.existsSync(bundle_dir)) {
    throw new Error(`bundle directory not found: ${bundle_dir}`);
  }

  /** name -> absolute path, per directory. */
  const files = Object.fromEntries(
    REQUIRED_KINDS.map((k) => [k.label, list_files(path.join(bundle_dir, k.dir))]),
  );

  /** The one candidate for a required kind, or a named throw. */
  const one = (label, pattern) => {
    const dir = REQUIRED_KINDS.find((k) => k.label === label).dir;
    const hits = files[label]
      .filter((name) => pattern.test(name) && !name.endsWith('.sig'))
      .map((name) => ({
        name,
        path: path.join(bundle_dir, dir, name),
      }));
    if (hits.length === 0) {
      throw new Error(
        `missing required ${label} artifact under ${path.join(bundle_dir, dir)} ` +
          `(no ${pattern.source} file)`,
      );
    }
    if (hits.length > 1) {
      throw new Error(
        `ambiguous ${label}: ${hits.length} candidates (${hits.map((h) => h.name).join(', ')}); ` +
          `the release matrix must build exactly one ${label}`,
      );
    }
    return hits[0];
  };

  const deb = one('deb', REQUIRED_KINDS[0].pattern);
  const appimage = one('appimage', REQUIRED_KINDS[1].pattern);
  const dmg = one('dmg', REQUIRED_KINDS[2].pattern);
  const darwin = one('darwin-updater', REQUIRED_KINDS[3].pattern);
  const nsis = one('nsis', REQUIRED_KINDS[4].pattern);

  /** The `.sig` sibling of an updater artifact, or a named throw. */
  const signature = (artifact, label) => {
    const sig = `${artifact.name}.sig`;
    if (!fs.existsSync(`${artifact.path}.sig`)) {
      throw new Error(`missing ${label} updater signature: ${artifact.name}.sig`);
    }
    return `${artifact.path}.sig`;
  };

  /** size/sha256 of an artifact file. */
  const meta = (artifact) => ({
    file: artifact.name,
    path: artifact.path,
    size_bytes: fs.statSync(artifact.path).size,
    sha256: sha256_file(artifact.path),
  });

  const downloads = [
    { os: 'macos', kind: 'dmg', ...meta(dmg) },
    { os: 'windows', kind: 'nsis', ...meta(nsis) },
    { os: 'linux', kind: 'deb', ...meta(deb) },
    { os: 'linux', kind: 'appimage', ...meta(appimage) },
  ];

  const updater = {
    appimage: {
      ...meta(appimage),
      signature_file: signature(appimage, 'AppImage'),
    },
    darwin: {
      ...meta(darwin),
      signature_file: signature(darwin, 'macOS'),
    },
    nsis: {
      ...meta(nsis),
      signature_file: signature(nsis, 'Windows'),
    },
  };

  // ── VERSION ────────────────────────────────────────────────────────────────────
  // Every discovered artifact name carries the same semver (DEC-13). Exactly one
  // distinct version across the set; `opts.version`, when given, must equal it.
  const named = [
    ...downloads.map((a) => [a, a.kind]),
    ...Object.entries(updater).map(([label, a]) => [
      a,
      { appimage: 'appimage', darwin: 'darwin-updater', nsis: 'nsis' }[label],
    ]),
  ];
  const tokens = [
    ...new Set(named.map(([a, kind]) => version_of(a.file, kind)).filter(Boolean)),
  ].sort();
  let version = opts.version ?? null;
  if (opts.version) {
    if (tokens.some((t) => t !== opts.version)) {
      throw new Error(
        `artifact version mismatch: ${tokens.join(', ')} in bundle filenames ` +
          `vs ${opts.version} passed as the version`,
      );
    }
  } else if (tokens.length === 1) {
    version = tokens[0];
  } else if (tokens.length === 0) {
    throw new Error('cannot determine the artifact version: no semver token in any bundle filename');
  } else {
    throw new Error(
      `cannot determine the artifact version: ${tokens.length} distinct semver tokens ` +
        `(${tokens.join(', ')}) in bundle filenames`,
    );
  }

  return { version, downloads, updater };
}

/**
 * The PROV-5 feed entries, in landing-site's fixed platform order (DEC-6).
 *
 * One `updater` payload per platform key: the darwin `.app.tar.gz` serves BOTH
 * `darwin-aarch64` and `darwin-x86_64`, linux is the AppImage, windows the NSIS
 * exe — exactly the mapping PROV-IR-1 pins and PROV-IR-2 must write.
 */
export function feed_platforms(artifacts) {
  return FEED_PLATFORM_ORDER.map((platform) => {
    const updater =
      platform.startsWith('darwin') ? artifacts.updater.darwin
      : platform === 'linux-x86_64' ? artifacts.updater.appimage
      : artifacts.updater.nsis;
    return { platform, updater };
  });
}
