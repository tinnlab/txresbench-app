#!/usr/bin/env node
// scripts/installer/surface.test.mjs — the node's published-surface checks.
//
// TEST-IR-12 (INV-5): the node's published files carry no marker words —
// `scripts/installer/README.md`, the pipeline tools' sources and the fixture
// records. TEST-IR-13 (INV-6): the node's diff vs its node base (the parent
// of the first `installers-release: ITEM-1` commit in this branch's history,
// like landing-site TEST-18) touches no `src-app/server/**` and no
// `src-app/ui/**` path, stays inside the node's file set, and adds no
// guard-shaped script. The release-workflow test is the ITEM-6 step-order
// review (the plan's verdict: the workflow edit is validated by YAML parse +
// step-order assertions, not by a run — Actions are parked).
//
//   node --test scripts/installer/surface.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(SCRIPTS_DIR, '..', '..');

/** git command from the repo root; throws on a non-zero status. */
function git(args) {
  return execFileSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .trimEnd();
}

/** The node's base: the parent of the first `installers-release: ITEM-1` commit. */
function node_base() {
  const log = git(['log', '--reverse', '--format=%H %s', '--grep=installers-release: ITEM-1']);
  const line = log.split('\n').find((l) => /^[0-9a-f]{40} installers-release: ITEM-1 /.test(l));
  assert.ok(line, 'no installers-release ITEM-1 commit in the branch history');
  const hash = line.split(' ')[0];
  return git(['rev-parse', `${hash}^`]);
}

// ── TEST-IR-12: marker words in the node's published files (INV-5) ─────────────
//
// The node's marker vocabulary, pinned: the words INV-5 bans and the
// phrase-forms the plan names. The test file itself contains these strings
// and is therefore not on the scan list.
const MARKER_RES = [
  /\bTODO\b/i,
  /\bTBD\b/i,
  /\bFIXME\b/i,
  /\bXXX\b/i,
  /\bHACK\b/i,
  /\bWIP\b/i,
  /\bPLACEHOLDER\b/i,
  /coming soon/i,
  /not yet implemented/i,
  /not implemented/i,
  /work in progress/i,
  /under construction/i,
];

/** All marker hits in one file: `[{ word, line }]`. */
function marker_hits(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const hits = [];
  for (const re of MARKER_RES) {
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(re);
      if (m) hits.push({ word: m[0], line: i + 1, file: path.relative(REPO, file) });
    }
  }
  return hits;
}

test('TEST-IR-12 (INV-5) the node\'s published files carry no marker words', () => {
  const files = [
    'scripts/installer/README.md',
    'scripts/installer/bundle-pretrained-models.mjs',
    'scripts/installer/discover-artifacts.mjs',
    'scripts/installer/make-update-feed.mjs',
    'scripts/installer/write-downloads-config.mjs',
    'scripts/installer/lib/artifacts.mjs',
    'scripts/installer/fixtures/README.md',
    'scripts/installer/fixtures/bundled-models.json',
    'scripts/installer/fixtures/tauri-app-conf-0.2.0.json',
    '.github/workflows/release.yml',
    'scripts/build-installer-local.sh',
  ];
  const hits = [];
  for (const rel of files) {
    const file = path.join(REPO, rel);
    assert.ok(fs.existsSync(file), `published file missing: ${rel}`);
    hits.push(...marker_hits(file));
  }
  assert.deepEqual(hits, [], `marker words in published files:\n${hits.map((h) => `${h.file}:${h.line} ${h.word}`).join('\n')}`);
});

// ── TEST-IR-13: the node's diff surface (INV-6) ────────────────────────────────

/** The node's allowed file-set prefixes (the PLAN's Files-to-touch, completed
 *  with the ledger directory every item of this node commits). */
const ALLOWED_PREFIXES = [
  '.github/workflows/release.yml',
  '.gitignore',
  'Cargo.lock',
  '.lifecycle/txresbench-app/installers-release/',
  'scripts/build-installer-local.sh',
  'scripts/build-installer-local.test.mjs',
  'scripts/installer/',
  'src-app/desktop/tauri/',
];

function inside_allowed(rel) {
  return ALLOWED_PREFIXES.some((p) => rel === p || rel.startsWith(p));
}

test('TEST-IR-13 (INV-6) the node diff stays inside the node file set', () => {
  const base = node_base();
  // `git diff <base>` covers the working-tree round (tracked edits + staged
  // changes) and, on a clean tree, is exactly `<base>..HEAD`; untracked
  // files are added separately.
  const changed = git(['diff', '--name-only', base]).split('\n').filter(Boolean);
  const untracked = git(['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean);
  const all = [...new Set([...changed, ...untracked])];
  assert.ok(all.length > 0, 'the node diff must touch at least one file');

  const banned = all.filter((p) => p.startsWith('src-app/server/') || p.startsWith('src-app/ui/'));
  assert.deepEqual(banned, [], `the node must not touch src-app/server/** or src-app/ui/** (INV-6):\n${banned.join('\n')}`);

  const outside = all.filter((p) => !inside_allowed(p));
  assert.deepEqual(outside, [], `paths outside the node's file set:\n${outside.join('\n')}`);

  // New paths: added in the working-tree diff plus untracked (a script added
  // now shows up in the round even before the commit).
  const added = git(['diff', '--name-only', '--diff-filter=A', base]).split('\n').filter(Boolean);
  const newPaths = [...new Set([...added, ...untracked])];
  for (const rel of newPaths) {
    // Every new script lives under scripts/installer/, or is the local-script
    // test that sits next to the script it tests (TESTS.md, DRIFT-1 ITEM-2 #1).
    if (rel.startsWith('scripts/') && !(rel.startsWith('scripts/installer/') || rel === 'scripts/build-installer-local.test.mjs')) {
      assert.fail(`new file outside scripts/installer: ${rel}`);
    }
    const base2 = path.basename(rel);
    assert.ok(!base2.startsWith('check-') && !base2.startsWith('coercion-parity'),
      `guard-shaped new file (would demand a guard-integrity pin): ${rel}`);
  }
});

// ── ITEM-6 release-workflow review (static: YAML parse + step order) ──────────

test('ITEM-6 release.yml parses as YAML and keeps the pipeline steps', () => {
  const yaml = execFileSync('python3', ['-c',
    'import sys, yaml; d = yaml.safe_load(open(sys.argv[1])); print("ok")',
    path.join(REPO, '.github/workflows/release.yml')], { encoding: 'utf8' });
  assert.equal(yaml.trim(), 'ok');
});

test('ITEM-6 release.yml wiring: matrix, key env, publish job order', () => {
  const rel = '.github/workflows/release.yml';
  const text = fs.readFileSync(path.join(REPO, rel), 'utf8');
  const lines = text.split('\n');
  const at = (needle) => {
    const i = lines.findIndex((l) => l.includes(needle));
    assert.ok(i >= 0, `${rel}: missing ${needle}`);
    return i;
  };

  // Triggers + draft release posture unchanged.
  assert.ok(text.includes('workflow_dispatch'), 'workflow_dispatch trigger');
  assert.ok(text.includes("tags:"), 'tag trigger');
  assert.ok(text.includes("app-v*"), 'app-v* tag pattern');
  assert.ok(text.includes('releaseDraft: true'), 'draft release');

  // The build matrix builds the four-artifact set.
  for (const needle of ['--bundles deb,appimage', '--target universal-apple-darwin', '--bundles nsis']) {
    assert.ok(text.includes(needle), `matrix leg missing: ${needle}`);
  }

  // The updater signing key reaches the build (PROV-IR-10, DEC-5).
  for (const needle of ['TAURI_SIGNING_PRIVATE_KEY:', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD:']) {
    assert.ok(text.includes(needle), `missing signing-key env: ${needle}`);
  }
  // Our own writers build the feed (DEC-3): tauri-action's updaterJson is not used.
  assert.ok(!text.includes('updaterJson'), 'tauri-action updaterJson must not be used (DEC-3)');

  // Every matrix leg stages the bundled models BEFORE the build.
  const stage = at('Stage bundled models');
  const build = at('Build and upload the installers');
  const stageCmd = at('run: node scripts/installer/bundle-pretrained-models.mjs');
  assert.ok(stage < build, 'Stage bundled models must precede the build');
  assert.ok(stageCmd > stage && stageCmd < build, 'the staging step runs before the build');

  // The bundle dir is uploaded from each leg (the publish job re-discover and
  // the feed need all four platform artifact sets).
  at('actions/upload-artifact@v4');
  at('bundle-'); // the per-platform artifact name
  at('src-app/desktop/tauri/target/release/bundle/');

  // Publish job: needs the whole matrix, works on the default branch (the
  // feed/config commit lands where the Pages build reads it), downloads the
  // merged bundles, discovers, writes, commits — in that order.
  const publish = at('publish:');
  const needs = at('needs: build');
  const checkout = at('github.event.repository.default_branch');
  const collect = at('actions/download-artifact@v4');
  const merge = at('merge-multiple: true');
  const discover = at('discover-artifacts.mjs --bundle-dir bundle --out artifacts.json');
  const feed = at('make-update-feed.mjs --version');
  const rows = at('write-downloads-config.mjs --artifacts artifacts.json');
  const commit = at('Commit the feed and the download rows');
  const add = at('git add site/public/updates/latest.json site/config.json');
  const push = at('git push');
  assert.ok(needs > publish && checkout > publish, 'publish job needs the build matrix and works on the default branch');
  assert.ok(collect > checkout && merge > collect, 'bundles collected into one dir');
  assert.ok(discover > merge, 'discovery runs on the merged bundle dir');
  assert.ok(feed > discover && rows > discover, 'the two writers consume the discovered set');
  assert.ok(commit > rows && add > commit && push > commit, 'the feed + rows are committed last');
});
