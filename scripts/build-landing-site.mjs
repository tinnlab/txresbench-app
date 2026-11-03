#!/usr/bin/env node
/**
 * build-landing-site.mjs — renders the TxResBench landing page from
 * `site/src/index.html` + `site/config.json` into `site/dist/` (the GitHub
 * Pages publish root) and copies `site/src/**` (styles, assets) and
 * `site/public/**` (machine feeds) verbatim.
 *
 * Usage:
 *   node scripts/build-landing-site.mjs [--out site/dist] [--config site/config.json]
 *                                     [--tauri-conf src-app/desktop/tauri/tauri.conf.json]
 *   node scripts/build-landing-site.mjs --print-urls
 *
 * Contracts:
 *   - every value rendered onto the page comes from the config file; a missing
 *     or empty field, a malformed value (sha256, url, download kind), an empty
 *     `downloads` array, an unrecognised method group or an unsubstituted
 *     template token fails the build with the field name.
 *   - `config.product.version` MUST equal the `version` of
 *     `src-app/desktop/tauri/tauri.conf.json` (the app's single version source
 *     of truth); drift fails the build naming both values. Each `downloads[]`
 *     url's `app-v<semver>` tag must carry that same version, and each row's
 *     `os`/`kind` must be one of the release node's four combos
 *     (macos=dmg, windows=nsis, linux=deb/appimage).
 *   - `site/public/` hosts exactly the two machine feeds, each optionally
 *     absent: `pretrained-catalogue.json` (JSON object root; every `url`
 *     field's host must be github.com or tinnlab.github.io) and
 *     `updates/latest.json` (Tauri v2 updater static-JSON shape). A
 *     present-but-invalid file, an unknown platform/top-level key or an
 *     unexpected file in `public/` fails the build naming the file and the
 *     violation — before the output dir is touched.
 *   - copied files are byte-identical (sha256 verified) — the hosted feeds are
 *     never rewritten, reordered or re-encoded.
 *   - output is deterministic: no timestamps, no mutable state.
 *   - exit 0 = built; exit 1 = invalid config, invalid hosted feed or
 *     unrenderable template; exit 2 = usage error.
 */

import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

const URLS = {
  BASE: 'https://tinnlab.github.io/txresbench-app/',
  LANDING: 'https://tinnlab.github.io/txresbench-app/',
  FEED: 'https://tinnlab.github.io/txresbench-app/updates/latest.json',
  CATALOGUE: 'https://tinnlab.github.io/txresbench-app/pretrained-catalogue.json',
};

const DOWNLOAD_KINDS = new Set(['dmg', 'nsis', 'deb', 'appimage']);
// Group 1 = "tag"|"download", group 2 = the tag's version payload
// ("app-v" + semver), group 3 = the trailing path after the tag. The version
// in the tag is checked against config.product.version (ITEM-4: a download
// row must link the release the page advertises).
const DOWNLOAD_RE = /^https:\/\/github\.com\/tinnlab\/txresbench-app\/releases\/(tag|download)\/app-v([0-9A-Za-z.+-]+)\/(.*)$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const LINK_HOST_RE = /^https:\/\/(github\.com|tinnlab\.github\.io)\//;
// The release node's (PROV-IR-3) os/kind matrix; a row outside it is a wiring
// error — a user must never be handed the wrong OS's installer.
const OS_KINDS = { macos: ['dmg'], windows: ['nsis'], linux: ['deb', 'appimage'] };

// Hosted public/ contract (PROV-landing-site-2/5/7): exactly these two files may
// live in site/public; any other file would be published unvalidated.
const PUBLIC_FILES = new Set(['pretrained-catalogue.json', 'updates/latest.json']);
const FEED_TOP_KEYS = new Set(['version', 'pub_date', 'notes', 'platforms']);
const FEED_PLATFORM_KEYS = ['darwin-aarch64', 'darwin-x86_64', 'linux-x86_64', 'windows-x86_64'];
// semver 2.0.0 (no leading zeros, optional prerelease/build metadata).
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
// RFC3339 date-time (full-date + full-time + offset; date-only is accepted by
// RFC3339 but never meaningful for a release timestamp).
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const ALLOWED_HOSTS = new Set(['github.com', 'tinnlab.github.io']);

const GROUP_LABELS = {
  'response-call': 'Response call',
  'response-probability': 'Response probability',
  'static-risk': 'Static risk',
  'dynamic-risk': 'Dynamic risk',
};

const ERRORS = [];
function error(field, why) {
  ERRORS.push(`config error: ${field}: ${why}`);
}

function isNonEmpty(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function validateConfig(cfg, path) {
  if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) {
    error('$', 'the file must contain a single JSON object');
    return;
  }
  const p = path ? `${path}.` : '';

  if (cfg.schema !== 1) error(`${p}schema`, 'must be 1 (schema v1)');

  if (cfg.product === null || typeof cfg.product !== 'object') error(`${p}product`, 'missing object');
  else {
    if (!isNonEmpty(cfg.product.name)) error(`${p}product.name`, 'missing or empty');
    if (!isNonEmpty(cfg.product.version)) error(`${p}product.version`, 'missing or empty');
  }

  if (cfg.paper !== null && cfg.paper !== undefined) {
    if (typeof cfg.paper !== 'object' || Array.isArray(cfg.paper)) error(`${p}paper`, 'must be an object or null');
    else {
      for (const k of ['author', 'title', 'venue', 'year', 'doi', 'cite_url', 'bibtex_url']) {
        if (!isNonEmpty(cfg.paper[k])) error(`${p}paper.${k}`, 'missing or empty');
      }
      for (const k of ['cite_url', 'bibtex_url']) {
        validateLink(cfg.paper[k], `${p}paper.${k}`);
      }
    }
  }

  if (cfg.stats === null || typeof cfg.stats !== 'object') error(`${p}stats`, 'missing object');
  else {
    for (const k of ['methods', 'datasets', 'patients', 'prediction_kinds']) {
      const v = cfg.stats[k];
      if (v === undefined || v === null || v === '') error(`${p}stats.${k}`, 'missing or empty');
      else if (!Number.isFinite(Number(v)) || Number(v) < 0) error(`${p}stats.${k}`, `must be a non-negative number, got ${JSON.stringify(v)}`);
    }
  }

  if (!Array.isArray(cfg.methods)) error(`${p}methods`, 'must be an array');
  else {
    cfg.methods.forEach((m, i) => {
      if (m === null || typeof m !== 'object') error(`${p}methods[${i}]`, 'must be an object');
      else {
        if (!isNonEmpty(m.id)) error(`${p}methods[${i}].id`, 'missing or empty');
        if (!isNonEmpty(m.group)) error(`${p}methods[${i}].group`, 'missing or empty');
        else if (!(m.group in GROUP_LABELS)) error(`${p}methods[${i}].group`, `unrecognised group ${JSON.stringify(m.group)} (known: ${Object.keys(GROUP_LABELS).join(', ')})`);
      }
    });
  }

  if (!Array.isArray(cfg.downloads)) error(`${p}downloads`, 'must be an array');
  else if (cfg.downloads.length === 0) error(`${p}downloads`, 'must contain at least one row');
  else {
    cfg.downloads.forEach((d, i) => {
      if (d === null || typeof d !== 'object') error(`${p}downloads[${i}]`, 'must be an object');
      else {
        for (const k of ['os', 'label', 'detail', 'url', 'sha256']) {
          if (!isNonEmpty(d[k])) error(`${p}downloads[${i}].${k}`, 'missing or empty');
        }
        if (!isNonEmpty(d.kind)) error(`${p}downloads[${i}].kind`, 'missing or empty');
        else if (!DOWNLOAD_KINDS.has(d.kind)) {
          error(`${p}downloads[${i}].kind`, `must be one of ${[...DOWNLOAD_KINDS].join(', ')}, got ${JSON.stringify(d.kind)}`);
        }
        if (d.size_mb === undefined || d.size_mb === null || d.size_mb === '') error(`${p}downloads[${i}].size_mb`, 'missing or empty');
        else if (!Number.isFinite(Number(d.size_mb)) || Number(d.size_mb) < 0) error(`${p}downloads[${i}].size_mb`, 'must be a non-negative number');
        if (isNonEmpty(d.url)) {
          const m = DOWNLOAD_RE.exec(d.url);
          if (!m) {
            error(`${p}downloads[${i}].url`, `must be a tinnlab/txresbench-app release asset URL under app-v<semver> (${DOWNLOAD_RE})`);
          } else if (m[2] !== cfg.product.version) {
            error(`${p}downloads[${i}].url`, `release tag app-v${m[2]} does not match product.version ${JSON.stringify(cfg.product.version)} (the page must link the release it advertises)`);
          }
        }
        if (isNonEmpty(d.sha256) && !SHA256_RE.test(d.sha256)) {
          error(`${p}downloads[${i}].sha256`, 'must be 64 lowercase hex characters');
        }
        if (d.os !== undefined && d.kind !== undefined) {
          const allowed = OS_KINDS[d.os];
          if (!allowed) error(`${p}downloads[${i}].os`, `unrecognised os ${JSON.stringify(d.os)} (known: ${Object.keys(OS_KINDS).join(', ')})`);
          else if (!allowed.includes(d.kind)) {
            error(`${p}downloads[${i}].kind`, `${JSON.stringify(d.kind)} is not a ${JSON.stringify(d.os)} artifact (${d.os}: ${allowed.join(', ')})`);
          }
        }
      }
    });
  }

  if (cfg.system === null || typeof cfg.system !== 'object') error(`${p}system`, 'missing object');
  else {
    for (const k of ['memory_gb', 'disk_gb']) {
      const v = cfg.system[k];
      if (v === undefined || v === null || v === '') error(`${p}system.${k}`, 'missing or empty');
      else if (!Number.isFinite(Number(v)) || Number(v) < 0) error(`${p}system.${k}`, 'must be a non-negative number');
    }
  }

  if (cfg.links === null || typeof cfg.links !== 'object') error(`${p}links`, 'missing object');
  else {
    for (const k of ['source', 'licence', 'third_party', 'issues', 'releases', 'benchmark', 'notes']) {
      if (!isNonEmpty(cfg.links[k])) error(`${p}links.${k}`, 'missing or empty');
      else validateLink(cfg.links[k], `${p}links.${k}`);
    }
  }
}

function validateLink(url, field) {
  if (!LINK_HOST_RE.test(url)) {
    error(field, `must be an absolute https URL on github.com or tinnlab.github.io, got ${JSON.stringify(url)}`);
  }
}

/**
 * validateAppVersion — PROV-landing-site-4: `config.product.version` MUST equal
 * `src-app/desktop/tauri/tauri.conf.json` `version`. The site advertises the
 * app the user downloads; the Tauri manifest is the app's single version source
 * of truth (CONS-landing-site-1), so a drift fails the build naming both
 * values. The file is also part of the fail-closed set: a build that cannot
 * read the app version cannot know what it is advertising.
 */
function validateAppVersion(tauriConfPath, cfg) {
  if (cfg.product === null || typeof cfg.product !== 'object' || !isNonEmpty(cfg.product.version)) return;
  if (!existsSync(tauriConfPath)) {
    error('product.version', `cannot check for drift: ${relative(REPO_ROOT, tauriConfPath)} is missing (the site must advertise the app's version)`);
    return;
  }
  let doc;
  try {
    doc = JSON.parse(readFileSync(tauriConfPath, 'utf8'));
  } catch (e) {
    error('product.version', `cannot check for drift: ${relative(REPO_ROOT, tauriConfPath)} is not valid JSON (${e.message})`);
    return;
  }
  if (doc === null || typeof doc !== 'object' || typeof doc.version !== 'string' || doc.version.trim() === '') {
    error('product.version', `cannot check for drift: ${relative(REPO_ROOT, tauriConfPath)} carries no version string`);
    return;
  }
  if (cfg.product.version !== doc.version) {
    error('product.version', `${JSON.stringify(cfg.product.version)} does not match ${relative(REPO_ROOT, tauriConfPath)} version ${JSON.stringify(doc.version)} (drift; the page must advertise the app's version)`);
  }
}

function pubError(file, why) {
  ERRORS.push(`public error: ${file}: ${why}`);
}

/**
 * validatePublic — the `site/public/` hosting contract (PROV-landing-site-2/5/7).
 *
 * The two machine feeds are validated BEFORE the output dir is touched, so a
 * present-but-invalid file fails the build without destroying the previous
 * publish output. Absent files are valid (the app treats 404/empty as "nothing
 * yet", DEC-17). Validation never rewrites a file — the copy pass keeps the
 * byte-identical promise (sha256 read-back).
 */
function validatePublic(publicDir) {
  if (!existsSync(publicDir)) return;
  const rel = (p) => relative(REPO_ROOT, p);
  for (const name of readdirSync(publicDir)) {
    const p = join(publicDir, name);
    if (statSync(p).isFile()) {
      if (!PUBLIC_FILES.has(name)) pubError(rel(p), 'unexpected file in site/public (only pretrained-catalogue.json and updates/latest.json are hosted, and both may be absent)');
    } else if (name === 'updates') {
      for (const sub of readdirSync(p)) {
        const sp = join(p, sub);
        if (statSync(sp).isFile() && !PUBLIC_FILES.has(`updates/${sub}`)) pubError(rel(sp), 'unexpected file in site/public (only pretrained-catalogue.json and updates/latest.json are hosted, and both may be absent)');
        else if (statSync(sp).isDirectory()) pubError(rel(sp), `unexpected directory in site/public (only pretrained-catalogue.json and updates/latest.json are hosted, and both may be absent)`);
      }
    } else if (name !== 'updates') {
      pubError(rel(p), 'unexpected directory in site/public (only pretrained-catalogue.json and updates/latest.json are hosted, and both may be absent)');
    }
  }
  validateCatalogue(join(publicDir, 'pretrained-catalogue.json'), rel);
  validateFeed(join(publicDir, 'updates', 'latest.json'), rel);
}

/**
 * validateCatalogue — PROV-landing-site-2: JSON object root; every `url` field
 * that carries an http(s):// value must point at github.com or
 * tinnlab.github.io. No field schema is imposed (the schema is the
 * pretrained-catalogue node's, DEC-7).
 */
function validateCatalogue(file, rel) {
  if (!existsSync(file)) return;
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    pubError(rel(file), `not valid JSON (${e.message})`);
    return;
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    pubError(rel(file), `root must be a single JSON object, got ${Array.isArray(doc) ? 'an array' : doc === null ? 'null' : `a ${typeof doc}`}`);
    return;
  }
  scanUrlHosts(doc, rel(file), '$');
}

function scanUrlHosts(node, file, where) {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((v, i) => scanUrlHosts(v, file, `${where}[${i}]`));
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'url') checkUrlHost(value, file, `${where}.url`);
    scanUrlHosts(value, file, `${where}.${key}`);
  }
}

function checkUrlHost(value, file, where) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return;
  let host;
  try {
    host = new URL(value).hostname.toLowerCase();
  } catch {
    pubError(file, `${where}: not a parseable URL: ${JSON.stringify(value)}`);
    return;
  }
  if (!ALLOWED_HOSTS.has(host)) {
    pubError(file, `${where}: host ${JSON.stringify(host)} is outside the policy (github.com or tinnlab.github.io only)`);
  }
}

/**
 * validateFeed — PROV-landing-site-5: the Tauri v2 static-JSON updater shape.
 * Root object with `version` (semver), optional RFC3339 `pub_date`, optional
 * string `notes`, and `platforms` (object; >= 1 key of the fixed set; each
 * entry a non-empty `url` + non-empty `signature`). Unknown top-level or
 * platform keys, empty url/signature, non-semver version or missing platforms
 * fail the build naming the defect; the file is then copied verbatim.
 */
function validateFeed(file, rel) {
  if (!existsSync(file)) return;
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    pubError(rel(file), `not valid JSON (${e.message})`);
    return;
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    pubError(rel(file), `root must be a single JSON object, got ${Array.isArray(doc) ? 'an array' : doc === null ? 'null' : `a ${typeof doc}`}`);
    return;
  }
  for (const key of Object.keys(doc)) {
    if (!FEED_TOP_KEYS.has(key)) pubError(rel(file), `unknown top-level key ${JSON.stringify(key)} (allowed: ${[...FEED_TOP_KEYS].join(', ')})`);
  }
  if (typeof doc.version !== 'string' || !SEMVER_RE.test(doc.version)) {
    pubError(rel(file), `version must be a semver string, got ${JSON.stringify(doc.version)}`);
  }
  if (doc.pub_date !== undefined && (typeof doc.pub_date !== 'string' || !RFC3339_RE.test(doc.pub_date) || Number.isNaN(Date.parse(doc.pub_date)))) {
    pubError(rel(file), `pub_date must be an RFC3339 date-time with a zone offset, got ${JSON.stringify(doc.pub_date)}`);
  }
  if (doc.notes !== undefined && typeof doc.notes !== 'string') {
    pubError(rel(file), `notes must be a string, got ${JSON.stringify(doc.notes)}`);
  }
  if (doc.platforms === null || typeof doc.platforms !== 'object' || Array.isArray(doc.platforms)) {
    pubError(rel(file), 'platforms must be an object');
    return;
  }
  const keys = Object.keys(doc.platforms);
  if (keys.length === 0) pubError(rel(file), 'platforms must contain at least one platform');
  for (const key of keys) {
    if (!FEED_PLATFORM_KEYS.includes(key)) {
      pubError(rel(file), `platforms: unknown platform key ${JSON.stringify(key)} (allowed: ${FEED_PLATFORM_KEYS.join(', ')})`);
      continue;
    }
    const entry = doc.platforms[key];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      pubError(rel(file), `platforms.${key}: entry must be an object`);
      continue;
    }
    if (typeof entry.url !== 'string' || entry.url.trim() === '') pubError(rel(file), `platforms.${key}.url: must be a non-empty string`);
    if (typeof entry.signature !== 'string' || entry.signature.trim() === '') pubError(rel(file), `platforms.${key}.signature: must be a non-empty string`);
    checkUrlHost(entry.url, rel(file), `platforms.${key}.url`);
  }
}

function get(cfg, path) {
  let v = cfg;
  for (const part of path.split('.')) {
    if (v === null || typeof v !== 'object') return undefined;
    v = v[part];
  }
  return v;
}

function renderPaperNav(cfg) {
  return cfg.paper
    ? `<a class="nav-link" href="${escapeAttr(cfg.paper.cite_url)}">Paper</a>`
    : '';
}

function renderHeroPrimary(cfg) {
  const d = cfg.downloads[0];
  const size = Number(d.size_mb) > 0 ? ` · ${d.size_mb} MB` : '';
  return `<a class="hero-primary" data-os="${escapeAttr(d.os)}" href="${escapeAttr(d.url)}">Download for ${escapeHtml(d.label)}<span class="btn-sub">${escapeHtml(d.detail)} · version ${escapeHtml(cfg.product.version)}${size}</span></a>`;
}

function renderAlsoOs(cfg) {
  const seen = new Set();
  const labels = [];
  for (const d of cfg.downloads.slice(1)) {
    if (!seen.has(d.os)) {
      seen.add(d.os);
      labels.push(d.label);
    }
  }
  if (labels.length === 0) return '';
  let rest;
  if (labels.length === 1) rest = labels[0];
  else rest = `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
  return `<span class="also-os">also for <a href="#download">${escapeHtml(rest)}</a></span>`;
}

function renderCiteLine(cfg) {
  return cfg.paper
    ? `<div class="hero-meta">Free for research use · <a href="${escapeAttr(cfg.paper.cite_url)}">Cite</a></div>`
    : '<div class="hero-meta">Free for research use</div>';
}

function renderPaperBand(cfg) {
  if (!cfg.paper) return '';
  const p = cfg.paper;
  return `<div class="paper-band"><div class="wrap paper-band-inner"><b class="paper-label">Paper</b><span class="paper-text">${escapeHtml(p.author)}. <i>${escapeHtml(p.title)}.</i> ${escapeHtml(p.venue)}, ${escapeHtml(p.year)}. ${escapeHtml(p.doi)}</span><span class="paper-links"><a class="link-strong" href="${escapeAttr(p.cite_url)}">Read the paper</a> &nbsp;·&nbsp; <a href="${escapeAttr(p.cite_url)}">Copy citation</a> &nbsp;·&nbsp; <a href="${escapeAttr(p.bibtex_url)}">BibTeX</a></span></div></div>`;
}

function renderStats(cfg) {
  const s = cfg.stats;
  const rows = [
    [s.methods, 'methods'],
    [s.datasets, 'datasets'],
    [s.patients, 'patients'],
    [s.prediction_kinds, 'kinds of prediction'],
  ];
  const spans = rows
    .map(([v, label]) => `<span><b class="stat-value">${escapeHtml(String(v))}</b> ${escapeHtml(label)}</span>`)
    .join('');
  return `<div class="stat-band"><div class="wrap stat-band-inner">${spans}</div></div>`;
}

function renderChips(cfg) {
  return cfg.methods
    .map((m) => `<span class="chip"><span class="chip-id">${escapeHtml(m.id)}</span><span class="chip-group">${escapeHtml(GROUP_LABELS[m.group])}</span></span>`)
    .join('');
}

function renderTiles(cfg) {
  return cfg.downloads
    .map((d, i) => {
      const meta = Number(d.size_mb) > 0 ? `${d.size_mb} MB · SHA-256` : 'SHA-256';
      const cls = i === 0 ? 'tile tile-primary' : 'tile';
      return `<a class="${cls}" data-os="${escapeAttr(d.os)}" href="${escapeAttr(d.url)}"><div class="tile-os">${escapeHtml(d.label)}</div><div class="tile-detail">${escapeHtml(d.detail)}</div><div class="tile-meta">${escapeHtml(meta)}</div></a>`;
    })
    .join('');
}

const MARKERS = {
  'PAPER-NAV': renderPaperNav,
  'HERO-PRIMARY': renderHeroPrimary,
  'ALSO-OS': renderAlsoOs,
  'CITE-LINE': renderCiteLine,
  'PAPER-BAND': renderPaperBand,
  STATS: renderStats,
  CHIPS: renderChips,
  TILES: renderTiles,
};

function renderTemplate(template, cfg) {
  let html = template;
  for (const [name, fn] of Object.entries(MARKERS)) {
    const marker = `<!--::${name}::-->`;
    if (!html.includes(marker)) {
      error('template', `marker ${marker} is missing from the template`);
      return '';
    }
    html = html.replace(marker, fn(cfg));
  }
  html = html.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (whole, path) => {
    const v = get(cfg, path);
    if (v === undefined || v === null) {
      error('template', `token ${whole} has no config value under '${path}'`);
      return whole;
    }
    return escapeHtml(String(v));
  });
  if (html.includes('{{') || html.includes('<!--::')) {
    error('template', 'unsubstituted token or marker remains after rendering');
  }
  return html;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s) {
  return escapeHtml(s);
}

function sha256File(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

function copyTreeVerbatim(srcDir, outDir) {
  if (!existsSync(srcDir)) return 0;
  const entries = readdirSync(srcDir);
  let count = 0;
  for (const name of entries) {
    const src = join(srcDir, name);
    if (name === 'index.html' && srcDir === join(REPO_ROOT, 'site', 'src')) {
      // rendered separately by the template pass
      continue;
    }
    mkdirSync(outDir, { recursive: true });
    if (statSync(src).isDirectory()) {
      count += copyTreeVerbatim(src, join(outDir, name));
      continue;
    }
    const dst = join(outDir, name);
    cpSync(src, dst);
    if (sha256File(src) !== sha256File(dst)) {
      error('copy', `byte-identical copy failed for ${relative(REPO_ROOT, src)}`);
    }
    count += 1;
  }
  return count;
}

function parseArgs(argv) {
  const args = {
    out: join(REPO_ROOT, 'site', 'dist'),
    config: join(REPO_ROOT, 'site', 'config.json'),
    tauriConf: join(REPO_ROOT, 'src-app', 'desktop', 'tauri', 'tauri.conf.json'),
    printUrls: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--config') args.config = argv[++i];
    else if (a === '--tauri-conf') args.tauriConf = argv[++i];
    else if (a === '--print-urls') args.printUrls = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else {
      console.error(`unknown argument: ${a}`);
      args.help = true;
      args.badArg = true;
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`usage: node scripts/build-landing-site.mjs [--out site/dist] [--config site/config.json] [--tauri-conf src-app/desktop/tauri/tauri.conf.json]
       node scripts/build-landing-site.mjs --print-urls`);
    process.exit(args.badArg ? 2 : 0);
  }
  if (args.printUrls) {
    for (const key of ['LANDING', 'FEED', 'CATALOGUE']) console.log(URLS[key]);
    process.exit(0);
  }

  if (!existsSync(args.config)) {
    console.error(`config error: ${args.config}: file not found`);
    process.exit(1);
  }
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(args.config, 'utf8'));
  } catch (e) {
    console.error(`config error: ${args.config}: not valid JSON (${e.message})`);
    process.exit(1);
  }
  validateConfig(cfg, '');
  validateAppVersion(args.tauriConf, cfg);
  if (ERRORS.length > 0) {
    for (const line of ERRORS) console.error(line);
    process.exit(1);
  }

  // Public/ hosting contract: validate BEFORE the output dir is recreated so a
  // present-but-invalid feed never destroys nor replaces a previous publish.
  validatePublic(join(REPO_ROOT, 'site', 'public'));
  if (ERRORS.length > 0) {
    for (const line of ERRORS) console.error(line);
    process.exit(1);
  }

  if (args.out === REPO_ROOT || args.out === join(REPO_ROOT, 'site')) {
    console.error(`usage error: refusing to build into ${args.out}; --out must be the publish root (site/dist)`);
    process.exit(2);
  }

  const templatePath = join(REPO_ROOT, 'site', 'src', 'index.html');
  const template = readFileSync(templatePath, 'utf8');
  const html = renderTemplate(template, cfg);
  if (ERRORS.length > 0) {
    for (const line of ERRORS) console.error(line);
    process.exit(1);
  }

  rmSync(args.out, { recursive: true, force: true });
  mkdirSync(args.out, { recursive: true });
  writeFileSync(join(args.out, 'index.html'), html);
  const copied = copyTreeVerbatim(join(REPO_ROOT, 'site', 'src'), args.out);
  copyTreeVerbatim(join(REPO_ROOT, 'site', 'public'), args.out);
  if (ERRORS.length > 0) {
    for (const line of ERRORS) console.error(line);
    process.exit(1);
  }
  console.log(`built ${relative(REPO_ROOT, join(args.out, 'index.html'))} (${copied} source file${copied === 1 ? '' : 's'} copied)`);
  process.exit(0);
}

main();
