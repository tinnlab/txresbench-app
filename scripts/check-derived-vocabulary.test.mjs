#!/usr/bin/env node
// check-derived-vocabulary.test.mjs — the NEGATIVE CONTROLS for
// `scripts/check-derived-vocabulary.sh` (#304).
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────
// #304 is the record of that guard printing PASS while the leak #303 was filed for sat in
// `scripts/`. Two structural reasons: `scripts/*.mjs` was outside the scanned surface, and
// the self-reference exemption was the WHOLE FILE of anything pinned in
// `scripts/guard-hashes.txt` — so widening the glob alone would have exempted the very
// guard that leaked. Both are repaired in the guard; this file is the part that keeps the
// repair honest tomorrow.
//
// A guard whose bite is argued in a header comment is a guard nobody re-checks. Every
// assertion below DRIVES the real shell guard as a subprocess over a synthetic repo and
// reads the CHILD-S OWN exit status — never a status observed through a pipe, which reports
// the last pipeline element and has produced a false green in this tree more than once.
//
// ── WHAT IS SYNTHETIC AND WHAT IS REAL ──────────────────────────────────────────
// The GUARD is real, byte-for-byte: it is copied, not reimplemented. So is everything it
// DERIVES from — the processor manifests, the reserved framework packages, the env recipes,
// the pin manifest, the justfile and the whole of `scripts/`. What is synthesized is only
// the app-core `.rs` bulk, which exists solely to clear `MIN_FILES`: these controls are
// about the BUILD surface, and a control that reddened because the real tree grew a leak
// somewhere else would misattribute a tree problem to the guard.
//
// No control here scans the real tree. That is the `check-derived-vocabulary` leg-s own job.
//
// It reads NOTHING under `.lifecycle/` (rule B6): those artifacts are stripped at merge, so
// a gate that reads them passes in a worktree and then fails on main forever.
//
//   node --test scripts/check-derived-vocabulary.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(SCRIPTS_DIR, '..');

/**
 * Read `contributes.datatypes[].id` out of a manifest — the same indentation-exact slice the
 * guard reads, so the controls and the guard cannot come to hunt different sets.
 */
function contributedIds(manifestPath) {
  const out = [];
  let inBlock = false;
  for (const line of fs.readFileSync(manifestPath, 'utf8').split('\n')) {
    if (/^\s*(#|$)/.test(line)) continue;
    const indent = line.length - line.trimStart().length;
    if (!inBlock) {
      if (indent === 2 && /^ {2}datatypes:\s*$/.test(line)) inBlock = true;
      continue;
    }
    if (indent <= 2) {
      inBlock = false;
      continue;
    }
    const m = /^ {4}- id:\s*["']?([^"'\s]+)/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

/**
 * NO DATATYPE ID IS SPELLED IN THIS FILE, and that is load-bearing rather than stylistic.
 *
 * This file lives under `scripts/`, which BOTH guards over this invariant scan — and the
 * pytest half (`spatial-types/tests/test_spatial_types_manifest.py`) has no test-module
 * exclusion by BASENAME, only by path segment. A control that spelled the id it plants would
 * therefore be reported as a leak by the very guard TEST-10 asserts agreement with. The first
 * cut of this file did exactly that and the pytest caught it.
 *
 * So the planted term is DERIVED, the way `derived-guards.md` §2 asks of anything that ranges
 * over a declared set: the lexicographically first COMPOUND contributed id in the tree. If
 * nothing is contributed, these controls THROW rather than plant a term no guard hunts —
 * a control planting an unforbidden term is green for a reason unrelated to what it claims.
 */
const MANIFESTS = execFileSync('git', ['ls-files', '--', 'src-app/packages/*/manifest.yaml'], {
  cwd: REPO,
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean);

const compound = (id) => id.includes('/') || id.includes('-');

const LEAK_TERM = (() => {
  const ids = MANIFESTS.flatMap((rel) => contributedIds(path.join(REPO, rel))).filter(compound);
  if (ids.length === 0) {
    throw new Error(
      'check-derived-vocabulary.test.mjs: no package contributes a compound datatype id. These ' +
        'controls plant a REAL contributed id; planting one the tree does not contribute would ' +
        'make every one of them vacuously green, so this refuses rather than guesses.',
    );
  }
  return ids.sort()[0];
})();

/**
 * A term that CONTAINS the compound separator, for the escape controls.
 *
 * `LEAK_TERM` is the lexicographically-first compound id, and `compound` accepts a hyphen — so
 * it resolves to a hyphen-only id and `LEAK_TERM.replace('/', ...)` is a NO-OP. A blind audit
 * found TEST-18 planting no escape at all and staying green with both escape fixes reverted:
 * a control for escaped separators that never writes one.
 */
const SLASHED_TERM = (() => {
  const ids = MANIFESTS.flatMap((rel) => contributedIds(path.join(REPO, rel))).filter(id =>
    id.includes('/'),
  );
  if (ids.length === 0) {
    throw new Error(
      'check-derived-vocabulary.test.mjs: no contributed id contains the compound separator, so ' +
        'the escaped-separator controls cannot plant one. They refuse rather than planting a ' +
        'term with nothing to escape — which is exactly how they came to be vacuous.',
    );
  }
  return ids.sort()[0];
})();

/**
 * The term TEST-10 plants: one BOTH guards hunt. The shell guard forbids every contributed id;
 * the pytest forbids only what its own package contributes, so agreement can only be asserted
 * over that narrower set. Derived from that package-s manifest, never typed.
 */
const CROSS_GUARD_PKG = 'src-app/packages/spatial-types';
const SHARED_TERM = (() => {
  const mf = path.join(REPO, CROSS_GUARD_PKG, 'manifest.yaml');
  if (!fs.existsSync(mf)) {
    throw new Error(
      `check-derived-vocabulary.test.mjs: ${CROSS_GUARD_PKG}/manifest.yaml is gone, so the guard ` +
        'TEST-10 compares against cannot be located. A cross-guard control whose counterpart has ' +
        'moved is a control switched off; it fails rather than skipping (derived-guards.md §3).',
    );
  }
  const ids = contributedIds(mf).filter(compound);
  if (ids.length === 0) throw new Error(`${CROSS_GUARD_PKG} contributes no compound id to plant`);
  return ids.sort()[0];
})();

/** The paths the guard reads, plus everything it scans on the BUILD surface. */
const COPY_PATHSPECS = [
  'justfile',
  'scripts',
  'src-app/packages/*/manifest.yaml',
  'src-app/packages/_helpers',
  'src-app/packages/_lib',
  'src-app/env-rootfs/*/Dockerfile',
  'src-app/server/src/modules/sandbox/processors/mod.rs',
  // TEST-10 runs the OTHER guard over this invariant inside the same fixture.
  `${CROSS_GUARD_PKG}/manifest.yaml`,
  `${CROSS_GUARD_PKG}/tests`,
  // #311/#324 — the surface is DECLARED (`scripts/lib/zero-core-surface.txt`, already inside
  // `scripts`) and is every `scripts/` directory AT ANY DEPTH, so the fixture has to have more
  // than one of them or the controls below verify a shape the tree does not have:
  //   * `src-app/libs/viz/scripts` is the #324 region — the directory this guard could not see;
  //   * `src-app/ui/scripts` is the declaration's ONE written exception, and TEST-22 asserts
  //     that exception is LOAD-BEARING by deleting it and requiring the guard to go red. It is
  //     also what `MIN_SURFACE_DIRS` counts, and what makes the "names a real path" control
  //     (TEST-26) mean anything in here rather than only against the real tree.
  'src-app/libs/viz/scripts',
  'src-app/ui/scripts',
  // Every declared `test_path_segment` must CLASSIFY SOMETHING (a capped slot naming nothing is
  // an exemption already paid for), so the fixture has to carry a path for each of the three or
  // the PRISTINE tree is red for a reason that has nothing to do with any control here.
  // `tests` and `fixtures` arrive with the pathspecs above; `testdata` lives only here.
  'src-app/testdata',
];

const TMPDIRS = [];
process.on('exit', () => {
  for (const d of TMPDIRS) fs.rmSync(d, { recursive: true, force: true });
});

/**
 * Where fixtures live. `TXR_CTL_TMPDIR` overrides, because `os.tmpdir()` is shared: on a busy
 * box something reaped the pristine tree MID-RUN and seven cases failed with `ENOENT` on a
 * directory this file had created — a failure that looks exactly like a real red and is not
 * one. `pristineDir()` below additionally REBUILDS if the tree has gone, so a reap costs time
 * rather than a spurious verdict.
 */
const CTL_TMP = process.env.TXR_CTL_TMPDIR || os.tmpdir();

/** Built once, and rebuilt if the environment removes it under us. */
function buildPristine() {
  const dir = fs.mkdtempSync(path.join(CTL_TMP, 'derived-vocab-ctl-src-'));
  TMPDIRS.push(dir);
  // `--others --exclude-standard` as well as `--cached`, so an in-progress edit to the guard
  // is what these controls exercise — the same reason the guard itself reads that way.
  const files = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...COPY_PATHSPECS],
    { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
    .split('\n')
    .filter(Boolean);
  for (const rel of files) {
    const src = path.join(REPO, rel);
    if (!fs.existsSync(src) || fs.statSync(src).isDirectory()) continue;
    const dst = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
  // The app-core bulk, synthesized: it exists only to clear the two guards- file floors
  // (`MIN_FILES` here, and the pytest-s own >= 500 anti-vacuity floor that TEST-10 drives).
  const gen = path.join(dir, 'src-app/server/src/gen');
  fs.mkdirSync(gen, { recursive: true });
  for (let i = 0; i < 600; i++) fs.writeFileSync(path.join(gen, `f${i}.rs`), `pub fn f${i}() {}\n`);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

let PRISTINE = buildPristine();

function pristineDir() {
  if (!fs.existsSync(PRISTINE)) PRISTINE = buildPristine();
  return PRISTINE;
}

/** A fresh working copy of the pristine fixture, with `edits` applied. */
function fixture(edits = {}) {
  const src = pristineDir();
  const dir = fs.mkdtempSync(path.join(CTL_TMP, 'derived-vocab-ctl-'));
  TMPDIRS.push(dir);
  fs.cpSync(src, dir, { recursive: true });
  for (const [rel, mutate] of Object.entries(edits)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const before = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
    // `append` REFUSES a file that is not there (see below). Anything else may create one,
    // which is how a control declares that the new file IS the subject.
    const after = mutate(before, rel);
    if (after === null) fs.rmSync(p, { force: true });
    else fs.writeFileSync(p, after);
  }
  return dir;
}

/** Run the REAL guard inside `dir` and return its OWN status + output. */
function runGuard(dir) {
  const r = spawnSync('bash', [path.join(dir, 'scripts', 'check-derived-vocabulary.sh')], {
    cwd: dir,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(r.error, undefined, `guard failed to spawn: ${r.error}`);
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

/**
 * Run the OTHER guard over this invariant, inside the SAME fixture. It resolves its repo root
 * from its own file location, so a copy of it in the fixture scans the fixture.
 *
 * A missing python3/pytest is a HARD FAILURE, never a skip: a cross-guard agreement control
 * that no-ops on an under-tooled box is a green signal certifying nothing (derived-guards.md
 * §3 — a skip is a skip, never a pass).
 */
function runOtherGuard(dir, selector = 'test_a_new_kind_costs_zero_core_code') {
  const spec = path.join(dir, CROSS_GUARD_PKG, 'tests', 'test_spatial_types_manifest.py');
  const r = spawnSync(
    'python3',
    ['-m', 'pytest', spec, '-k', selector, '-q', '--no-header',
     '-p', 'no:cacheprovider'],
    { cwd: dir, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  const out = `${r.stdout}${r.stderr}`;
  assert.equal(r.error, undefined, `python3 is required by TEST-10 and did not run: ${r.error}`);
  assert.ok(
    r.status === 0 || r.status === 1,
    `pytest could not run the counterpart guard (status ${r.status}). TEST-10 asserts two guards ` +
      `AGREE; it cannot be satisfied by one of them being unrunnable.\n${out}`,
  );
  assert.match(out, /1 (passed|failed)/, `expected exactly one selected test:\n${out}`);
  return { code: r.status, out };
}

/**
 * Append to an EXISTING file, and refuse if it is not there.
 *
 * The refusal is the finding, not defensiveness: `TEST-13` plants in a real pinned build
 * script and asserts the guard names that path. With a permissive append, renaming that
 * script away made the control silently CREATE a new file whose content began with the string
 * `null` — and the test stayed green, having verified nothing about the file it names.
 */
/** Run the byte-pin guard inside the fixture. It is what actually bounds a declared block. */
function runIntegrity(dir) {
  const r = spawnSync('bash', [path.join(dir, 'scripts', 'check-guard-integrity.sh')], {
    cwd: dir,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(r.error, undefined, `check-guard-integrity failed to spawn: ${r.error}`);
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

/** Re-pin every guard in the fixture, the way a real author would after an intended edit. */
function repin(dir) {
  const r = spawnSync('bash', [path.join(dir, 'scripts', 'check-guard-integrity.sh'), '--update'], {
    cwd: dir,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, `--update must succeed:\n${r.stdout}${r.stderr}`);
}

/** Prepend to an EXISTING file, refusing a missing one — see `append`. */
const prepend = (text) => (before, rel) => {
  if (before === null) {
    throw new Error(
      `check-derived-vocabulary.test.mjs: cannot prepend to ${rel} — it is not in the fixture. ` +
        'A control that invents its own subject verifies nothing about the file it names.',
    );
  }
  return `${text}\n${before}`;
};

const append = (text) => (before, rel) => {
  if (before === null) {
    throw new Error(
      `check-derived-vocabulary.test.mjs: cannot append to ${rel} — it is not in the fixture. ` +
        'This control plants in a REAL file on purpose; creating one instead would make it ' +
        'green while testing nothing about the file it names.',
    );
  }
  return `${before}\n${text}\n`;
};

/**
 * The fixture is a copy of the REAL tree, so a green expectation here is also an assertion
 * about that tree. Say so at the point of failure: a vocabulary leak someone else lands under
 * `scripts/` would otherwise redden this file and be read as a broken control.
 */
function assertPristineGreen() {
  const r = runGuard(fixture());
  assert.equal(
    r.code,
    0,
    'the UNMUTATED fixture is RED. These controls copy the real justfile, scripts/ and ' +
      'manifests, so this is almost certainly a real leak somewhere under scripts/ — a TREE ' +
      'problem, not a control problem. Run scripts/check-derived-vocabulary.sh directly and ' +
      `fix what it names before reading anything below.\n${r.out}`,
  );
  return r;
}

// ── TEST-4 ───────────────────────────────────────────────────────────────────────
test('TEST-4 the fixture is GREEN, and #277s leak in a PINNED scripts/*.mjs turns it RED', () => {
  // The positive control first: without it, every red below could be the fixture rather than
  // the plant, and a control that is red for the wrong reason proves nothing.
  const clean = assertPristineGreen();
  assert.match(clean.out, /^PASS:/m);

  // #277s leak, re-introduced verbatim in shape: a contributed datatype id hard-coded into a
  // PINNED `scripts/*.mjs` guard. Before #304 this file was outside the scanned surface AND
  // exempt for being pinned, so the guard printed PASS over it — twice over.
  const leaked = runGuard(
    fixture({
      'scripts/check-viz-producer-magnitudes.mjs': append(`const KIND = '${LEAK_TERM}';`),
    }),
  );
  assert.equal(leaked.code, 1, `a pinned .mjs guard spelling ${LEAK_TERM} must be RED:\n${leaked.out}`);
  assert.match(leaked.out, /^FAIL: contributed DOMAIN vocabulary leaked/m);
  assert.match(leaked.out, new RegExp(`scripts/check-viz-producer-magnitudes\\.mjs:\\d+: ${LEAK_TERM}`));
});

test('TEST-4b an UNPINNED scripts/*.mjs is scanned too — the widening is not about pins', () => {
  const r = runGuard(
    fixture({ 'scripts/preland-frontend-health.mjs': append(`const KIND = '${LEAK_TERM}';`) }),
  );
  assert.equal(r.code, 1, `an unpinned .mjs spelling ${LEAK_TERM} must be RED:\n${r.out}`);
  assert.match(r.out, new RegExp(`scripts/preland-frontend-health\\.mjs:\\d+: ${LEAK_TERM}`));
});

// ── TEST-5 ───────────────────────────────────────────────────────────────────────
test('TEST-5 the exemption is a DECLARED BLOCK in a PINNED file — and nothing wider', () => {
  const block = `# txr:guard-vocabulary\nFIXTURE_HUNTED='${LEAK_TERM}'\n# txr:end-guard-vocabulary`;

  // (a) inside the block, in a PINNED file: exempt. A guard that HUNTS a term must spell it.
  const inside = runGuard(fixture({ 'scripts/check-substrate-retired.sh': append(block) }));
  assert.equal(inside.code, 0, `a declared block in a pinned guard must stay GREEN:\n${inside.out}`);

  // (b) the SAME literal one line OUTSIDE the block, in the SAME pinned file: a leak. This is
  //     the narrowing — before #304 the whole file was exempt and this was green.
  const outside = runGuard(
    fixture({
      'scripts/check-substrate-retired.sh': append(`${block}\nFIXTURE_DISPATCH='${LEAK_TERM}'`),
    }),
  );
  assert.equal(outside.code, 1, `a pinned guard DISPATCHING on ${LEAK_TERM} must be RED:\n${outside.out}`);
  assert.match(outside.out, new RegExp(`scripts/check-substrate-retired\\.sh:\\d+: ${LEAK_TERM}`));

  // (c) the block cannot be SELF-GRANTED: an unpinned build file carrying the markers FAILS
  //     loudly rather than no-opping, so nobody ships a leak believing it is exempt.
  const unpinned = runGuard(fixture({ 'scripts/preland-frontend-health.mjs': append(block) }));
  assert.equal(unpinned.code, 1, `markers in an unpinned file must FAIL:\n${unpinned.out}`);
  assert.match(unpinned.out, /^FAIL: the scan of a build file could not be trusted/m);
  assert.match(unpinned.out, /is NOT pinned/);

  // (d) an UNTERMINATED block FAILS. Left alone it would blank the rest of the file — the
  //     whole-file exemption #304 removed, arriving back through a typo.
  const unterminated = runGuard(
    fixture({
      'scripts/check-substrate-retired.sh': append(
        `# txr:guard-vocabulary\nFIXTURE_HUNTED='${LEAK_TERM}'`,
      ),
    }),
  );
  assert.equal(unterminated.code, 1, `an unterminated block must FAIL:\n${unterminated.out}`);
  assert.match(unterminated.out, /opened and never closed/);
});

// ── TEST-6 ───────────────────────────────────────────────────────────────────────
test('TEST-6 the JS-test exclusion is DERIVED from the justfile, not typed into the guard', () => {
  const plant = { 'scripts/check-aggregate.test.mjs': append(`const KIND = '${LEAK_TERM}';`) };

  // A control suite may plant the vocabulary it tests — the justfile declares it a test module
  // by invoking it under `node --test`, exactly as pytest-s `python_files` declares a Python one.
  const declared = runGuard(fixture(plant));
  assert.equal(declared.code, 0, `a justfile-declared node --test module may spell it:\n${declared.out}`);

  // Remove ONLY that declaration and the identical file is scanned like any other. A guard with
  // `*.test.mjs` typed into it would stay green here, which is the difference this asserts.
  const undeclared = runGuard(
    fixture({
      ...plant,
      justfile: (before) =>
        before
          .split('\n')
          .filter((l) => !(l.includes('node --test') && l.includes('check-aggregate.test.mjs')))
          .join('\n'),
    }),
  );
  assert.equal(undeclared.code, 1, `an UNdeclared .mjs must be scanned:\n${undeclared.out}`);
  assert.match(undeclared.out, new RegExp(`scripts/check-aggregate\\.test\\.mjs:\\d+: ${LEAK_TERM}`));
});

// ── TEST-7 ───────────────────────────────────────────────────────────────────────
test('TEST-7 the js dialect closes the fail-open the sh dialect would have opened', () => {
  // A JS line whose id sits to the RIGHT of a word-initial `#` OUTSIDE any string — a private
  // class field, which is ordinary modern JS. Under the sh dialect the stripper reads that `#`
  // as opening a comment and truncates the line there, so the id drops silently out of the
  // scan: a fail-open, on a file class that carries 196 `#` characters in one member.
  const hashed = runGuard(
    fixture({
      'scripts/preland-frontend-health.mjs': append(
        `class Dispatch { #kind = '${LEAK_TERM}'; }`,
      ),
    }),
  );
  assert.equal(hashed.code, 1, `a term to the right of a # must still be seen:\n${hashed.out}`);
  assert.match(hashed.out, new RegExp(`scripts/preland-frontend-health\\.mjs:\\d+: ${LEAK_TERM}`));

  // …and the other direction, which is what keeps this from being the cry-wolf class: a term in
  // a `//` COMMENT is prose about the id, not a dispatch on it, and is not reported.
  const commented = runGuard(
    fixture({ 'scripts/preland-frontend-health.mjs': append(`// this file must not know ${LEAK_TERM}`) }),
  );
  assert.equal(commented.code, 0, `a term in a // comment must not be a hit:\n${commented.out}`);
});

// ── TEST-8 ───────────────────────────────────────────────────────────────────────
test('TEST-8 the RED output is the documentation — it names the tier and the remedy', () => {
  const r = runGuard(
    fixture({ 'scripts/check-viz-producer-magnitudes.mjs': append(`const KIND = '${LEAK_TERM}';`) }),
  );
  assert.equal(r.code, 1);
  // A reader who hits this red must learn, from the red itself, that `.mjs` is now scanned and
  // what a guard that legitimately hunts the vocabulary is supposed to do instead.
  assert.match(r.out, /scripts\/\*\.mjs/);
  assert.match(r.out, /txr:guard-vocabulary/);
  assert.match(r.out, /no longer exempts the whole file/);
});

// ── TEST-9 ───────────────────────────────────────────────────────────────────────
test('TEST-9 the floors still bite on the WIDENED surface', () => {
  // Widening a surface is worth nothing if the surface can then collapse quietly. Strip
  // `scripts/` back to the guard and its lib and the build scan set falls under its floor.
  const collapsed = runGuard(
    fixture(
      Object.fromEntries(
        fs
          .readdirSync(path.join(pristineDir(), 'scripts'))
          .filter((n) => n !== 'check-derived-vocabulary.sh' && n !== 'guard-hashes.txt' && n !== 'lib')
          .map((n) => [`scripts/${n}`, () => null]),
      ),
    ),
  );
  assert.equal(collapsed.code, 1, `a collapsed build surface must FAIL:\n${collapsed.out}`);
  assert.match(collapsed.out, /the build scan set resolved to \d+ file\(s\), below the floor/);

  // …and the derivation that EXCLUDES the control suites has its own floor, so it cannot
  // collapse into "exclude everything" either.
  const noJsTests = runGuard(
    fixture({
      justfile: (before) =>
        before
          .split('\n')
          .filter((l) => !l.includes('node --test'))
          .join('\n'),
    }),
  );
  assert.equal(noJsTests.code, 1, `a collapsed js-test derivation must FAIL:\n${noJsTests.out}`);
  assert.match(noJsTests.out, /the justfile declared 0 .* path\(s\), below the floor of/);
});

// ── TEST-10 ──────────────────────────────────────────────────────────────────────
test('TEST-10 the two guards over this invariant now AGREE on the same planted leak', () => {
  // #304s thesis, asserted rather than argued. `check-derived-vocabulary.sh` and
  // `spatial-types`s `test_a_new_kind_costs_zero_core_code` enforce ONE invariant and
  // DISAGREED about whether a pinned guard may spell domain vocabulary: one said yes
  // structurally (the whole file was exempt, and `.mjs` was unscanned), one said no
  // structurally (it scans wholesale with no exemption). #277 landed in that gap, and the
  // merge that shipped it ran the shell guard and not the pytest.
  //
  // Both are run over the SAME fixture, clean and leaked, and their verdicts are compared.
  const plant = {
    'scripts/check-viz-producer-magnitudes.mjs': append(`const KIND = '${SHARED_TERM}';`),
  };

  const cleanDir = fixture();
  const cleanShell = runGuard(cleanDir);
  const cleanOther = runOtherGuard(cleanDir);
  assert.equal(cleanShell.code, 0, `the shell guard must be GREEN on a clean fixture:\n${cleanShell.out}`);
  assert.equal(cleanOther.code, 0, `the counterpart guard must be GREEN on a clean fixture:\n${cleanOther.out}`);

  const leakedDir = fixture(plant);
  const leakedShell = runGuard(leakedDir);
  const leakedOther = runOtherGuard(leakedDir);
  assert.equal(leakedShell.code, 1, `the shell guard must be RED on the planted leak:\n${leakedShell.out}`);
  assert.equal(leakedOther.code, 1, `the counterpart guard must be RED on the planted leak:\n${leakedOther.out}`);

  // Agreement is not two reds — it is two reds ABOUT THE SAME THING. Before #304 the shell
  // guard printed PASS over exactly this file while the pytest failed on it.
  const where = /scripts\/check-viz-producer-magnitudes\.mjs/;
  assert.match(leakedShell.out, where);
  assert.match(leakedOther.out, where);
  assert.ok(leakedShell.out.includes(SHARED_TERM), `the shell guard must name the term:\n${leakedShell.out}`);
  assert.ok(leakedOther.out.includes(SHARED_TERM), `the counterpart must name the term:\n${leakedOther.out}`);
});

// ── TEST-11 ──────────────────────────────────────────────────────────────────────
test('TEST-11 the JS-test exclusion needs TWO keys, and neither can be forged from outside', () => {
  // A blind audit defeated the first cut of this derivation in one line: `grep` has no notion
  // of a justfile RECIPE, so a comment, an echo string, or a path under some other
  // `.../scripts/` directory each granted a silent WHOLE-FILE exemption — the leak this guard
  // exists for, back to PASS. Every dodge it found is a case here.
  // KEY 1 IS ISOLATED, and the first cut of this test did not isolate it. Every negative leg
  // planted in a file that does not import `node:test`, so key 2 alone rejected all of them —
  // a blind audit removed the comment-stripping and the path anchoring one at a time and this
  // test stayed GREEN. Three of the round's headline claims rested on nothing.
  //
  // So the plant goes in a file that DOES satisfy key 2 (`check-aggregate.test.mjs` imports
  // `node:test`), with its REAL justfile declaration deleted first. The only thing left
  // deciding the verdict is the SHAPE of the declaration that is put back.
  const TESTMOD = 'scripts/check-aggregate.test.mjs';
  const dropRealDecl = (before) =>
    before
      .split('\n')
      .filter(l => !(l.includes('node --test') && l.includes('check-aggregate.test.mjs')))
      .join('\n');
  const plant = { [TESTMOD]: append(`const KIND = '${LEAK_TERM}';`) };
  const withJustfile = (text) => ({
    ...plant,
    justfile: (before) => `${dropRealDecl(before)}\n${text}\n`,
  });

  // Positive control 1: the tree is otherwise clean.
  assertPristineGreen();
  // Positive control 2: with its real declaration REMOVED, the planted module is scanned — so
  // every red below is the declaration shape and not the plant.
  const undeclared = runGuard(fixture({ ...plant, justfile: dropRealDecl }));
  assert.equal(undeclared.code, 1, `the plant must be RED once undeclared:\n${undeclared.out}`);
  // Positive control 3: put the REAL declaration shape back and it is exempt again — so the
  // reds below cannot be "this file is always scanned".
  const redeclared = runGuard(
    fixture(withJustfile('re-run:\n    node --test "{{justfile_directory()}}/scripts/check-aggregate.test.mjs"')),
  );
  assert.equal(redeclared.code, 0, `an honest re-declaration must exempt it again:\n${redeclared.out}`);

  // (a) a COMMENT is not something the tree runs.
  const commented = runGuard(
    fixture(
      withJustfile('# historical: node --test "{{justfile_directory()}}/scripts/check-aggregate.test.mjs"'),
    ),
  );
  assert.equal(commented.code, 1, `a justfile COMMENT must not exempt a file:\n${commented.out}`);

  // (b) an echo STRING inside a real recipe is not an invocation either.
  const echoed = runGuard(
    fixture(withJustfile('say-hint:\n    @echo "run: node --test scripts/check-aggregate.test.mjs"')),
  );
  assert.equal(echoed.code, 1, `an echoed string must not exempt a file:\n${echoed.out}`);

  // (c) a path under some OTHER `.../scripts/` directory must not exempt the repo-root file of
  //     the same name — the first cut rewrote it greedily onto `scripts/`.
  const foreign = runGuard(
    fixture(
      withJustfile('x-hint:\n    node --test "{{justfile_directory()}}/src-app/ui/scripts/check-aggregate.test.mjs"'),
    ),
  );
  assert.equal(foreign.code, 1, `a foreign scripts/ path must not exempt this one:\n${foreign.out}`);

  // (d) KEY 2, isolated the other way: a REAL, non-comment, correctly-anchored declaration
  //     does not exempt a file that is not a test module. `preland-frontend-health.mjs` does
  //     not import `node:test`, so only key 2 can be deciding this one.
  const declaredNotATest = runGuard(
    fixture({
      'scripts/preland-frontend-health.mjs': append(`const KIND = '${LEAK_TERM}';`),
      justfile: (before) =>
        `${before}\nrun-it:\n    node --test "{{justfile_directory()}}/scripts/preland-frontend-health.mjs"\n`,
    }),
  );
  assert.equal(
    declaredNotATest.code,
    1,
    `a declared file that does not import node:test must still be scanned:\n${declaredNotATest.out}`,
  );

  // (f) a `node:test` specifier inside a COMMENT does not satisfy key 2 either — the key is a
  //     property of the MODULE, not of any text that happens to appear in the file.
  const commentedImport = runGuard(
    fixture({
      'scripts/preland-frontend-health.mjs': (before) =>
        `// import test from 'node:test'\n${before}\nconst KIND = '${LEAK_TERM}';\n`,
      justfile: (before) =>
        `${before}\nrun-it:\n    node --test "{{justfile_directory()}}/scripts/preland-frontend-health.mjs"\n`,
    }),
  );
  assert.equal(
    commentedImport.code,
    1,
    `a node:test specifier in a comment must not satisfy key 2:\n${commentedImport.out}`,
  );

  // (g) …and a purely COSMETIC reformat of the import must not change the verdict. Anchoring
  //     the whole specifier pattern at the start of a line stopped matching a prettier-wrapped
  //     import, so reformatting two modules would have tripped the floor and hard-FAILED the
  //     guard over whitespace.
  const reformatted = runGuard(
    fixture({
      [TESTMOD]: (before) =>
        `${before.replace(/^import test from ['"]node:test['"];?$/m, "import {\n  test,\n} from 'node:test';")}\nconst KIND = '${LEAK_TERM}';\n`,
      justfile: (before) =>
        `${dropRealDecl(before)}\nre-run:\n    node --test "{{justfile_directory()}}/scripts/check-aggregate.test.mjs"\n`,
    }),
  );
  assert.equal(
    reformatted.code,
    0,
    `a wrapped import is still an import — a reformat must not change the verdict:\n${reformatted.out}`,
  );

  // (h) an idiomatic declaration whose `node --test` sits AFTER a quoted span must still be
  //     accepted. The decision is made on the line with quoted spans blanked, and the earlier
  //     "no quote before the node token" rule rejected this outright — a cry-wolf that would
  //     have scanned a control suite and pushed someone to switch the derivation off.
  const envPrefixed = runGuard(
    fixture(withJustfile('e-run:\n    NODE_OPTIONS="--no-warnings" node --test "{{justfile_directory()}}/scripts/check-aggregate.test.mjs"')),
  );
  assert.equal(envPrefixed.code, 0, `an env-prefixed invocation must be accepted:\n${envPrefixed.out}`);
  const cdPrefixed = runGuard(
    fixture(withJustfile('c-run:\n    cd "{{justfile_directory()}}" && node --test scripts/check-aggregate.test.mjs')),
  );
  assert.equal(cdPrefixed.code, 0, `a cd-prefixed invocation must be accepted:\n${cdPrefixed.out}`);

  // (i) the path anchor: a DECLARED module in a scripts SUBDIRECTORY is not exempt, because
  //     the anchor accepts only a repo-root `scripts/<name>.mjs`. Without the anchor this is
  //     green, so it is what makes the "deliberately NOT widened to subdirectories" line true.
  const subdir = runGuard(
    fixture({
      'scripts/sub/zz-sub.test.mjs': () =>
        `import test from 'node:test';\nconst KIND = '${LEAK_TERM}';\n`,
      justfile: (before) =>
        `${before}\ns-run:\n    node --test "{{justfile_directory()}}/scripts/sub/zz-sub.test.mjs"\n`,
    }),
  );
  assert.equal(subdir.code, 1, `a declared module in a subdirectory must NOT be exempt:\n${subdir.out}`);

  // (j) key 2 must be an IMPORT, not the specifier appearing anywhere. A guard that INSPECTS
  //     test imports would spell `node:test` in a string; that must not buy it an exemption.
  const specifierString = runGuard(
    fixture({
      'scripts/preland-frontend-health.mjs': (before, rel) => {
        if (before === null) throw new Error(`${rel} missing`);
        return `const RUNNER_SPEC = 'node:test';\n${before}\nconst KIND = '${LEAK_TERM}';\n`;
      },
      justfile: (before) =>
        `${before}\nr-run:\n    node --test "{{justfile_directory()}}/scripts/preland-frontend-health.mjs"\n`,
    }),
  );
  assert.equal(
    specifierString.code,
    1,
    `a bare 'node:test' string must not satisfy key 2:\n${specifierString.out}`,
  );

  // (e) …and the exclusion still WORKS for a real test module, with node flags in between —
  //     the first cut required the path to sit immediately after `--test`, so one added flag
  //     collapsed the whole derivation to zero and fired the floor.
  const flagged = runGuard(
    fixture({
      'scripts/check-aggregate.test.mjs': append(`const KIND = '${LEAK_TERM}';`),
      justfile: (before) => before.replace(/node --test /g, 'node --test --test-reporter=spec '),
    }),
  );
  assert.equal(flagged.code, 0, `flags between --test and the path must be tolerated:\n${flagged.out}`);
});

// ── TEST-12 ──────────────────────────────────────────────────────────────────────
test('TEST-12 the js stripper handles regex literals and block comments, both directions', () => {
  const P = 'scripts/preland-frontend-health.mjs';

  // FAIL-OPEN, closed: the `//` a regex literal makes out of an escaped slash used to read as a
  // comment marker and truncate the rest of the line, so a dispatch after one exited 0.
  for (const line of [
    `const parts = s.split(/\\//); const K = '${LEAK_TERM}';`,
    `const m = /^https:\\/\\//.test(u); const K = '${LEAK_TERM}';`,
  ]) {
    const r = runGuard(fixture({ [P]: append(line) }));
    assert.equal(r.code, 1, `a term after a regex literal must be seen:\n${line}\n${r.out}`);
  }

  // CRY-WOLF, closed: prose in a `/* … */` block — single AND multi-line — is a comment, and
  // the guard used to report it while accepting the identical prose in a `//` comment.
  for (const block of [
    `/** prose about ${LEAK_TERM} here */`,
    `/*\n * prose about ${LEAK_TERM}\n */`,
  ]) {
    const r = runGuard(fixture({ [P]: append(block) }));
    assert.equal(r.code, 0, `prose in a block comment must not be a hit:\n${block}\n${r.out}`);
  }

  // …and the block comment does not swallow what follows it.
  const after = runGuard(fixture({ [P]: append(`/* prose */\nconst K = '${LEAK_TERM}';`) }));
  assert.equal(after.code, 1, `a dispatch after a CLOSED block comment must be seen:\n${after.out}`);
});

// ── TEST-13 ──────────────────────────────────────────────────────────────────────
test('TEST-13 the build surface is the whole of scripts/, not an extension list', () => {
  // The first cut added `scripts/*.mjs` as a third glob. That is still an enumeration of the
  // set the guard ranges over, and it drifts the same way a term list does: a pinned `.py`
  // build script and a `.bash` one were both invisible.
  const py = runGuard(fixture({ 'scripts/coercion-parity-kernel.py': append(`KIND = '${LEAK_TERM}'`) }));
  assert.equal(py.code, 1, `a .py build script must be scanned:\n${py.out}`);
  assert.match(py.out, /scripts\/coercion-parity-kernel\.py:\d+:/);

  const bash = runGuard(
    fixture({ 'scripts/zz-control.bash': () => `#!/usr/bin/env bash\nKIND='${LEAK_TERM}'\n` }),
  );
  assert.equal(bash.code, 1, `a .bash build script must be scanned:\n${bash.out}`);

  // …and a Python COMMENT is still prose, so the py dialect is really being applied rather
  // than everything being matched raw.
  const pyComment = runGuard(
    fixture({ 'scripts/coercion-parity-kernel.py': append(`# prose about ${LEAK_TERM}`) }),
  );
  assert.equal(pyComment.code, 0, `a python comment must not be a hit:\n${pyComment.out}`);
});

// ── TEST-14 ──────────────────────────────────────────────────────────────────────
test('TEST-14 the declared block is a whole-file-scope exemption bounded by the PIN', () => {
  const G = 'scripts/check-substrate-retired.sh';
  const block = `# txr:guard-vocabulary\nFIXTURE_HUNTED='${LEAK_TERM}'\n# txr:end-guard-vocabulary`;
  const dispatch = `case "$KIND" in ${LEAK_TERM}) exec_domain_path ;; esac`;

  // Three SYNTACTIC bounds were tried on this block and a blind audit defeated each in one
  // line, while the last also cried wolf on six ordinary declaration forms. There is no
  // predicate here any more, and this test says what IS true rather than what would be nice.

  // (a) an honest, re-pinned block is exempt.
  const honest = fixture({ [G]: append(block) });
  repin(honest);
  assert.equal(runGuard(honest).code, 0, 'a declared, re-pinned block must be exempt');

  // (b) THE HONEST RESIDUAL, asserted so a future round can tell it from a regression: the
  //     block scope is NOT bounded by content. Wrap the whole file and put a dispatch inside,
  //     re-pin, and every automated gate is green. The remaining control is a human reading
  //     the one-line `guard-hashes.txt` diff that the re-pin produces. If a later change makes
  //     this RED, that is an improvement and this assertion is what will say so.
  const wide = fixture({
    [G]: (before, rel) => {
      if (before === null) throw new Error(`${rel} missing from the fixture`);
      const lines = before.split('\n');
      lines.splice(1, 0, '# txr:guard-vocabulary');
      return `${lines.join('\n')}\n${dispatch}\n# txr:end-guard-vocabulary\n`;
    },
  });
  repin(wide);
  const wideRun = runGuard(wide);
  assert.equal(
    wideRun.code,
    0,
    `RECORDED, not endorsed: an over-wide re-pinned block is green. If this is now RED, the ` +
      `guard gained a content bound and this test should be updated to assert it.\n${wideRun.out}`,
  );

  // (c) …and the pin is a REAL gate, not a formality: the same edit WITHOUT the re-pin fails,
  //     by name. This is the half that forces the change into a reviewed manifest diff.
  const unpinnedEdit = fixture({ [G]: append(block) });
  repin(unpinnedEdit);
  fs.appendFileSync(path.join(unpinnedEdit, G), `${dispatch}\n`);
  const integrity = runIntegrity(unpinnedEdit);
  assert.equal(integrity.code, 1, `an edit after the pin must FAIL it:\n${integrity.out}`);
  assert.match(integrity.out, /check-substrate-retired\.sh/);

  // (d) the markers cannot be self-granted in an UNPINNED file — the half a pin cannot
  //     express, because an unpinned file has no bytes to compare.
  const unpinned = runGuard(fixture({ 'scripts/preland-frontend-health.mjs': append(block) }));
  assert.equal(unpinned.code, 1, `markers in an unpinned file must FAIL:\n${unpinned.out}`);
  assert.match(unpinned.out, /is NOT pinned/);

  // (b') the PREMISE (b) rests on, asserted rather than assumed: the DISPATCH line is itself a
  //      leak when it is not inside a block. Without this, (b)'s green could mean the matcher
  //      stopped seeing that shape rather than the block exempting it — and (e) below uses a
  //      different shape, so it does not cover this one.
  const bareDispatch = fixture({ [G]: append(dispatch) });
  repin(bareDispatch);
  const bareRun = runGuard(bareDispatch);
  assert.equal(bareRun.code, 1, `the dispatch must be a leak outside a block:\n${bareRun.out}`);

  // (e) …and the exemption still EXISTS: without the marker the same line is a leak. Without
  //     this, (a) could be green because nothing is scanned at all.
  const noMarker = fixture({ [G]: append(`FIXTURE_HUNTED='${LEAK_TERM}'`) });
  repin(noMarker);
  assert.equal(runGuard(noMarker).code, 1, 'the same line without markers must be a leak');
});

// ── TEST-16 ──────────────────────────────────────────────────────────────────────
test('TEST-16 the fail-closed `raw` dialect is real — an unknown extension is not blanked', () => {
  // Claimed in the guard header, in derived-guards.md and in the commit; tested by nothing.
  // A blind audit replaced the raw arm with `code = ""` — a total fail-open on every
  // unknown-extension build file — and the whole suite stayed green, because every plant
  // landed in an extension that HAS an arm.
  //
  // The LIVE arm is `strip_build()`'s `return raw`. There used to be a second, unreachable
  // `else { code = raw }` in the main rule, and this comment named THAT one — so mutating the
  // arm the comment pointed at proved nothing. The dead arm is gone; this names the live one.
  const raw = runGuard(
    fixture({ 'scripts/zz-control.conf': () => `# a config the guard has no dialect for\nkind = ${LEAK_TERM}\n` }),
  );
  assert.equal(raw.code, 1, `an unknown-extension build file must be scanned RAW:\n${raw.out}`);
  assert.match(raw.out, /scripts\/zz-control\.conf:\d+:/);

  // …and RAW means RAW: nothing is stripped, so even a line that LOOKS like a comment in some
  // other language is scanned. That is the fail-closed direction, and it is deliberate — the
  // alternative is guessing a comment syntax and blanking live code with it.
  const looksLikeComment = runGuard(
    fixture({ 'scripts/zz-control.conf': () => `# ${LEAK_TERM}\n` }),
  );
  assert.equal(looksLikeComment.code, 1, `raw must not guess a comment syntax:\n${looksLikeComment.out}`);
});

// ── TEST-17 ──────────────────────────────────────────────────────────────────────
test('TEST-17 the vocabulary-block markers exist ONLY on the build tier', () => {
  // The `BLOCKS` gate was added with a long comment about marker records leaking into the LEAK
  // report from the app-core and framework tiers, and a blind audit ungated it again with no
  // test noticing. The marker is a build-tier mechanism; anywhere else it is just text.
  const inRust = runGuard(
    fixture({
      'src-app/server/src/gen/f0.rs': (before) => `// txr:guard-vocabulary\n${before}`,
    }),
  );
  assert.equal(inRust.code, 0, `a marker in an app-core .rs file is just text:\n${inRust.out}`);
  assert.ok(
    !inRust.out.includes('!!'),
    `a structural record must never reach the report from the app-core tier:\n${inRust.out}`,
  );

  // …and the same marker in a framework .py file, which is the other ungated tier.
  const inPy = runGuard(
    fixture({ 'src-app/packages/_lib/txr_columns.py': prepend('# txr:guard-vocabulary') }),
  );
  assert.equal(inPy.code, 0, `a marker in a framework .py file is just text:\n${inPy.out}`);
  assert.ok(!inPy.out.includes('!!'), `no structural record from the framework tier:\n${inPy.out}`);

  // …while on the BUILD tier the same marker in an unpinned file is still a hard failure, so
  // this is a gate on the TIER and not the mechanism being switched off.
  const onBuild = runGuard(
    fixture({ 'scripts/preland-frontend-health.mjs': append('// txr:guard-vocabulary') }),
  );
  assert.equal(onBuild.code, 1, `the marker must still bite on the build tier:\n${onBuild.out}`);
  assert.match(onBuild.out, /is NOT pinned/);
});

// ── TEST-18 ──────────────────────────────────────────────────────────────────────
test('TEST-18 an escape hides nothing and glues nothing, and an open comment is LOUD', () => {
  const P = 'scripts/preland-frontend-health.mjs';
  const S = 'scripts/zz-control.sh';

  // (a) FAIL-OPEN #1, closed: the stripper blanked BOTH characters of an escape, so a compound
  //     id written with an ESCAPED SEPARATOR vanished. `SLASHED_TERM` is used here and not
  //     `LEAK_TERM` for a reason a blind audit had to find: `LEAK_TERM` carries no separator,
  //     so the first version of this control planted no escape at all and passed with both
  //     escape fixes reverted.
  const escaped = SLASHED_TERM.replace('/', '\\/');
  assert.notEqual(escaped, SLASHED_TERM, 'the planted term must actually contain an escape');
  for (const line of [`const RE = /${escaped}/;`, `const K = "${escaped}";`]) {
    const r = runGuard(fixture({ [P]: append(line) }));
    assert.equal(r.code, 1, `an escaped separator must not hide a term:\n${line}\n${r.out}`);
  }
  // …and the SAME source text is deliberately NOT a hit in a shell script, because the two
  // languages differ: JavaScript drops the backslash on an unknown escape (so the JS literal
  // above IS the id), while a bash double-quoted string keeps it (so `X="da\\/result"` is the
  // string `da\\/result`, which is not the id and cannot dispatch on it). An earlier version of
  // this leg asserted the opposite and was wrong about bash, not about the guard.
  const shEscaped = runGuard(fixture({ [S]: () => `#!/usr/bin/env bash\nX="${escaped}"\n` }));
  assert.equal(
    shEscaped.code,
    0,
    `a backslash the shell KEEPS makes a different string, not the id:\n${shEscaped.out}`,
  );

  // …and the third direction, which round 5 added: a dialect that KEEPS the backslash on an
  // unknown escape. Python `"\\d"` really is two characters, so the term beside it IS bounded
  // and must be reported — dropping the backslash there deleted a boundary the language has,
  // and `re.compile("<term>\\d+")` went silent.
  const PYF = 'scripts/zz-control.py';
  const keepsBackslash = runGuard(
    fixture({ [PYF]: () => `RX = re.compile("${SLASHED_TERM}\\\\d+")\n` }),
  );
  assert.equal(
    keepsBackslash.code,
    1,
    `a term bounded by a KEPT backslash must be reported:\n${keepsBackslash.out}`,
  );

  // …and the IDENTITY escape, which is the third direction and the one a blind audit found
  // after the fix for the first two: in JS an escaped letter outside the escape table means
  // itself, so `\\a` between two characters of a compound id does not break it.
  const identity = runGuard(
    fixture({ [P]: append(`const K = "${SLASHED_TERM.replace(/^(.)(.)/, '$1\\$2')}";`) }),
  );
  assert.equal(identity.code, 1, `an identity escape must not hide a term:\n${identity.out}`);

  // (b) FAIL-OPEN #2, closed — and it was a REGRESSION introduced by the fix for (a). Keeping
  //     the escaped character glued the `n` of a trailing `\n` onto the token, killing the
  //     right-hand boundary, so `printf "<term>\n"` — the idiomatic way to write that line —
  //     stopped being reported. An escaped WORD character is an escape SEQUENCE and is blanked;
  //     an escaped punctuation character IS the character and is kept.
  for (const [file, line] of [
    [S, `printf "${LEAK_TERM}\\n"`],
    [P, `const msg = "\\t${SLASHED_TERM}\\n";`],
  ]) {
    const r = runGuard(
      fixture({ [file]: file === S ? () => `#!/usr/bin/env bash\n${line}\n` : append(line) }),
    );
    assert.equal(r.code, 1, `an escape sequence must not glue onto a term:\n${line}\n${r.out}`);
  }

  // (c) …and a block comment the stripper cannot parse is reported LOUDLY rather than
  //     silently blanking the rest of the file.
  const opened = runGuard(fixture({ [P]: append(`const RE = /[/*]/\nconst K = '${LEAK_TERM}'`) }));
  assert.equal(opened.code, 1, `an unterminated block comment must be LOUD:\n${opened.out}`);
  assert.match(opened.out, /never closed/);
});

// ── #311 / #324 ──────────────────────────────────────────────────────────────────
// The five controls below are one change: the two guards over this invariant stopped
// deriving their SURFACE and their EXEMPTION RULE separately and now read one committed
// declaration. Everything above this line predates that and is unchanged.

/** The path the #324 leak actually landed in — a `scripts/` directory that is not the root. */
const VIZ_SCRIPTS = 'src-app/libs/viz/scripts';
/** The declaration both guards read. */
const DECL = 'scripts/lib/zero-core-surface.txt';

/** Rewrite the fixture's shared declaration line-wise. */
const declEdit = (mutate) => (before, rel) => {
  if (before === null) throw new Error(`${rel} is not in the fixture — the declaration must be`
    + ' copied in, or every control below verifies a guard reading nothing.');
  return mutate(before);
};

// ── TEST-19 ──────────────────────────────────────────────────────────────────────
test('TEST-19 [acceptance] [invariant: INV-1] the build surface is DERIVED from the declaration, not rooted at the repo', () => {
  assertPristineGreen();

  // (a) THE #324 REGION. `BUILD_SURFACE_GLOBS=('justfile' 'scripts')` was a git pathspec
  //     rooted at the repo, so #259's fixture generator at `src-app/libs/viz/scripts/` was
  //     outside it — and this guard printed PASS while the wholesale pytest carried the red
  //     to `main`. Replayed against `origin/main`'s guard, this same plant exits 0.
  const viz = runGuard(
    fixture({ [`${VIZ_SCRIPTS}/zz-planted.py`]: () => `KIND = "${SHARED_TERM}"\n` }),
  );
  assert.equal(viz.code, 1, `a leak under ${VIZ_SCRIPTS}/ must be RED:\n${viz.out}`);
  assert.match(viz.out, /src-app\/libs\/viz\/scripts\/zz-planted\.py:\d+:/);
  assert.ok(viz.out.includes(SHARED_TERM), `the guard must NAME the term:\n${viz.out}`);

  // (b) …and a `scripts/` directory that does not exist in the tree AT ALL is covered on
  //     arrival, with ZERO edits to the declaration. That is the difference between a
  //     derivation and the enumeration #304 wrote down: #304 repaired #303 by naming the
  //     instance it had just seen, and #324 is the next instance. A rule that has to be
  //     edited for the next directory is the same defect with a later date.
  const fresh = runGuard(
    fixture({ 'src-app/server/scripts/zz-new-region.sh': () => `K='${SHARED_TERM}'\n` }),
  );
  assert.equal(fresh.code, 1, `a NEW scripts/ directory must be covered on arrival:\n${fresh.out}`);
  assert.match(fresh.out, /src-app\/server\/scripts\/zz-new-region\.sh:\d+:/);

  // (c) …and the surface is provably WIDER than the repo root it used to be, measured from
  //     the guard's own PASS line rather than asserted. Without this, (a) and (b) could both
  //     be green because the guard had started matching raw text everywhere.
  const dir = fixture();
  const green = runGuard(dir);
  assert.equal(green.code, 0, green.out);
  const built = Number(/\+ (\d+) build file\(s\)/.exec(green.out)?.[1]);
  const dirs = Number(/all (\d+) `scripts\/` director/.exec(green.out)?.[1]);
  assert.ok(Number.isInteger(built) && Number.isInteger(dirs), `PASS line unreadable:\n${green.out}`);
  assert.ok(dirs >= 2, `the walk must cross the repo root, got ${dirs} director(y/ies)`);
  // Every candidate a REPO-ROOT surface could possibly have scanned, counted generously.
  const rootOnly = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'justfile', 'scripts'],
    { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  ).split('\n').filter(Boolean).length;
  assert.ok(
    built > rootOnly,
    `the build surface (${built}) must exceed everything a repo-root pathspec could reach ` +
      `(${rootOnly}); if it does not, the widening is not in effect:\n${green.out}`,
  );
});

// ── TEST-20 ──────────────────────────────────────────────────────────────────────
test('TEST-20 [acceptance] [invariant: INV-3] both guards AGREE on the #324 region, in both directions', () => {
  // TEST-10 asserts the same agreement for a repo-root `scripts/*.mjs`, which is where #277
  // leaked. It was GREEN across the whole of #324, because #324 leaked one directory deeper.
  // An agreement control is only worth the region it covers, so this is that control moved to
  // the region that actually failed.
  const plant = { [`${VIZ_SCRIPTS}/zz-planted.py`]: () => `KIND = "${SHARED_TERM}"\n` };

  const cleanDir = fixture();
  const cleanShell = runGuard(cleanDir);
  const cleanOther = runOtherGuard(cleanDir);
  assert.equal(cleanShell.code, 0, `the shell guard must be GREEN on a clean fixture:\n${cleanShell.out}`);
  assert.equal(cleanOther.code, 0, `the counterpart must be GREEN on a clean fixture:\n${cleanOther.out}`);

  const leaked = fixture(plant);
  const leakedShell = runGuard(leaked);
  const leakedOther = runOtherGuard(leaked);
  assert.equal(leakedShell.code, 1, `the shell guard must be RED:\n${leakedShell.out}`);
  assert.equal(leakedOther.code, 1, `the counterpart must be RED:\n${leakedOther.out}`);

  // Agreement is two reds ABOUT THE SAME THING, not two reds.
  const where = /src-app\/libs\/viz\/scripts\/zz-planted\.py/;
  assert.match(leakedShell.out, where);
  assert.match(leakedOther.out, where);
  assert.ok(leakedShell.out.includes(SHARED_TERM), leakedShell.out);
  assert.ok(leakedOther.out.includes(SHARED_TERM), leakedOther.out);
});

// ── TEST-21 ──────────────────────────────────────────────────────────────────────
test('TEST-21 [acceptance] [invariant: INV-2] the declared block is honoured IDENTICALLY, and exempts no leak', () => {
  const G = 'scripts/check-substrate-retired.sh';
  const decl = `# txr:guard-vocabulary\nFIXTURE_HUNTED='${SHARED_TERM}'\n# txr:end-guard-vocabulary`;

  // #311 residual 1, closed. A guard that legitimately HUNTS a spatial id has to spell it,
  // declares the block to say so, and until now passed the shell guard and FAILED the pytest,
  // which granted no exemption at all. `derived-guards.md` §1 is explicit that "starts
  // refusing things it never meant to refuse" is the SAME failure as a vacuous green, so a
  // latent false red is not a lesser defect to be left standing.

  // (a) a declared, re-pinned block: BOTH green.
  const honest = fixture({ [G]: append(decl) });
  repin(honest);
  const honestShell = runGuard(honest);
  const honestOther = runOtherGuard(honest);
  assert.equal(honestShell.code, 0, `the shell guard must honour the block:\n${honestShell.out}`);
  assert.equal(honestOther.code, 0, `the counterpart must honour the SAME block:\n${honestOther.out}`);

  // (b) the same line one line OUTSIDE the block: BOTH red. Without this, (a)'s agreement
  //     could be two guards that had stopped scanning the file at all.
  const outside = fixture({ [G]: append(`${decl}\nFIXTURE_LOOSE='${SHARED_TERM}'`) });
  repin(outside);
  const outsideShell = runGuard(outside);
  const outsideOther = runOtherGuard(outside);
  assert.equal(outsideShell.code, 1, `a line outside the block is a leak:\n${outsideShell.out}`);
  assert.equal(outsideOther.code, 1, `…in BOTH guards:\n${outsideOther.out}`);

  // (c) markers in an UNPINNED file exempt nothing, in either guard — the second key.
  const unpinned = fixture({ 'scripts/preland-frontend-health.mjs': append(decl) });
  const unpinnedShell = runGuard(unpinned);
  const unpinnedOther = runOtherGuard(unpinned);
  assert.equal(unpinnedShell.code, 1, `markers in an unpinned file must FAIL:\n${unpinnedShell.out}`);
  assert.match(unpinnedShell.out, /is NOT pinned/);
  assert.equal(unpinnedOther.code, 1, `…and must not exempt in the counterpart:\n${unpinnedOther.out}`);

  // (d) THE ONE THAT MATTERS. With a legitimate block present and re-pinned, the #324-shaped
  //     leak is STILL red in both. An exemption whose first act is to cover the defect that
  //     motivated the branch is the move `derived-guards.md` §5 and this repo's own brief
  //     refuse; this is the assertion that says it did not happen.
  const both = fixture({
    [G]: append(decl),
    [`${VIZ_SCRIPTS}/zz-planted.py`]: () => `KIND = "${SHARED_TERM}"\n`,
  });
  repin(both);
  const bothShell = runGuard(both);
  const bothOther = runOtherGuard(both);
  assert.equal(bothShell.code, 1, `the block must not launder the leak (shell):\n${bothShell.out}`);
  assert.equal(bothOther.code, 1, `the block must not launder the leak (pytest):\n${bothOther.out}`);
  assert.match(bothShell.out, /src-app\/libs\/viz\/scripts\/zz-planted\.py/);
  assert.match(bothOther.out, /src-app\/libs\/viz\/scripts\/zz-planted\.py/);

  // (e) an UNTERMINATED block blanks nothing rather than the rest of the file — the whole-file
  //     exemption #304 removed, arriving back through a typo. Fail-closed in both.
  const open = fixture({ [G]: append(`# txr:guard-vocabulary\nFIXTURE_HUNTED='${SHARED_TERM}'`) });
  repin(open);
  const openShell = runGuard(open);
  const openOther = runOtherGuard(open);
  assert.equal(openShell.code, 1, `an unterminated block must FAIL:\n${openShell.out}`);
  assert.equal(openOther.code, 1, `…and must exempt nothing in the counterpart:\n${openOther.out}`);
});

// ── TEST-22 ──────────────────────────────────────────────────────────────────────
test('TEST-22 the declaration fails CLOSED, and every written exception is load-bearing', () => {
  // (a) missing: a hard FAIL, never a fallback. A guard that silently reverts to a built-in
  //     surface when its declaration goes missing is the declaration not existing.
  const gone = runGuard(fixture({ [DECL]: () => null }));
  assert.equal(gone.code, 1, `a missing declaration must FAIL:\n${gone.out}`);
  assert.match(gone.out, /zero-core-surface\.txt is missing/);

  // (b) a DUPLICATED single-valued field: a hard FAIL. Two readers could otherwise pick
  //     different ones, which is precisely the drift one declaration exists to remove.
  const dup = runGuard(
    fixture({ [DECL]: declEdit((b) => `${b}\nsurface_dir notscripts\n`) }),
  );
  assert.equal(dup.code, 1, `a duplicated field must FAIL:\n${dup.out}`);
  assert.match(dup.out, /surface_dir` 2 time\(s\)/);

  // (c) an exception NAMING NOTHING: a hard FAIL. `derived-guards.md` §3 — a marker naming
  //     nothing is not a premise that does not hold, it is a guard switched off, and it looks
  //     identical from the outside.
  const nowhereDir = fixture({
    [DECL]: declEdit((b) => `${b}\nsurface_exception src-app/nope/scripts because\n`),
  });
  const nowhere = runGuard(nowhereDir);
  assert.equal(nowhere.code, 1, `an exception naming nothing must FAIL:\n${nowhere.out}`);
  assert.match(nowhere.out, /no tracked file at or under/);
  //     …in BOTH readers. The counterpart gained this rule in round 4 under a comment saying it
  //     made "enforced ungated, in both readers" a fact rather than a claim — and it stayed a
  //     claim, because this leg drove only the shell.
  const nowhereOther = runOtherGuard(nowhereDir);
  assert.equal(nowhereOther.code, 1, `…in both readers:\n${nowhereOther.out}`);
  assert.match(nowhereOther.out, /no tracked file at or under/);

  // (d) THE EXCEPTION IS REAL WORK, not decoration. Delete it and the guard goes red on the
  //     sibling ratchet's own baseline — which is what the entry says it is protecting. An
  //     exemption that changes nothing when removed is `derived-guards.md` §5's pre-authorized
  //     future leak, and this is how that is told apart from a live one.
  // ONE entry at a time, and deliberately not all five at once: the guard caps its report at
  // 100 lines (50 hits), and `domain-baseline.json` alone carries 49 — so dropping every
  // exception truncates the very file a control is asserting on, and the control passes or
  // fails on display width rather than on behaviour. The first cut of this leg did exactly
  // that and was green for the wrong reason.
  const dropOne = (needle) =>
    declEdit((b) =>
      b.split('\n').filter((l) => !(l.startsWith('surface_exception ') && l.includes(needle))).join('\n'),
    );
  // DERIVED from the declaration, not typed: the list was hard-coded at TWO entries while the
  // declaration shipped FIVE, so three exemptions had no control that they did anything — in a
  // branch whose whole argument is that a guard reads the set it ranges over from the
  // declaration that defines it. Reading it here means an exception added tomorrow is covered
  // by this leg on arrival, which is the same property the guard's own surface has.
  const declaredExceptions = fs
    .readFileSync(path.join(REPO, DECL), 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('surface_exception '))
    .map((l) => l.split(/\s+/)[1]);
  assert.ok(
    declaredExceptions.length >= 2,
    `${DECL} parsed to ${declaredExceptions.length} exception(s) — the reader broke, and a leg ` +
      'that loops over nothing passes without asserting anything',
  );
  for (const target of declaredExceptions) {
    const named = target.split('/').pop();
    const noExcept = runGuard(fixture({ [DECL]: dropOne(named) }));
    assert.equal(
      noExcept.code,
      1,
      `removing the exception for ${named} must expose what it covers — an exemption that ` +
        `changes nothing when removed is a pre-authorized future leak:\n${noExcept.out}`,
    );
    assert.ok(
      noExcept.out.includes(target),
      `the guard must NAME ${target} once its exception is gone:\n${noExcept.out}`,
    );
  }

  // (e) …and the exception cannot be used the OTHER way. The FIRST cut of this leg asserted
  //     that exempting the leak's directory dropped the build count below MIN_BUILD_FILES —
  //     which was TRUE that day and is not a mechanism: a blind round paid the shortfall
  //     straight back by adding a `surface_root` in the same edit and landed exactly ON the
  //     floor, leak exempt, guard green. What actually bounds it is the CAP, so that is what
  //     this asserts: a sixth exception fails, by name, whatever the file counts do.
  const dodge = runGuard(
    fixture({
      [DECL]: declEdit((b) => `${b}\nsurface_exception ${VIZ_SCRIPTS} quieting the leak\n`),
      [`${VIZ_SCRIPTS}/zz-planted.py`]: () => `KIND = "${SHARED_TERM}"\n`,
    }),
  );
  assert.equal(dodge.code, 1, `exempting the leak's directory must not go green:\n${dodge.out}`);
  assert.match(dodge.out, /the cap is/);

  // (f) THE FAIL-OPEN A BLIND ROUND FOUND, and it is the sharpest one in this file. A value
  //     that is not a plain token is refused BEFORE it reaches a matcher. Unrefused, an
  //     unbalanced paren in the marker made awk's lazily-compiled dynamic regex die on every
  //     BUILD file with its stderr swallowed; the guard read "no hits" and printed PASS over a
  //     real planted leak while still reporting the same file count, because that count is a
  //     line count of the file LIST and never had anything to do with what awk processed.
  const badMarker = runGuard(
    fixture({
      [DECL]: declEdit((b) => b.replace(/^vocab_block_open .*$/m, 'vocab_block_open txr:guard-vocabulary(')),
      [`${VIZ_SCRIPTS}/zz-planted.py`]: () => `KIND = "${SHARED_TERM}"\n`,
    }),
  );
  assert.equal(badMarker.code, 1, `a marker that is not a plain token must FAIL:\n${badMarker.out}`);
  assert.match(badMarker.out, /not a plain marker token/);

  // (g) …and `surface_root` gets the SAME "names a real path" control `surface_exception` has.
  //     It did not, and a blind round walked through the gap: a root resolving to nothing drops
  //     the recipes out of the scanned surface at exit 0, with a leak in them. Both spellings
  //     are refused — a git PATHSPEC (`:(exclude)justfile`) by the charset, before git can
  //     interpret it, and a plain path naming nothing by the existence check.
  const pathspecRoot = runGuard(
    fixture({ [DECL]: declEdit((b) => `${b}\nsurface_root :(exclude)justfile\n`) }),
  );
  assert.equal(pathspecRoot.code, 1, `a git pathspec as a root must FAIL:\n${pathspecRoot.out}`);
  assert.match(pathspecRoot.out, /not a plain path token/);

  const deadRoot = runGuard(
    fixture({ [DECL]: declEdit((b) => `${b}\nsurface_root justfile-does-not-exist\n`) }),
  );
  assert.equal(deadRoot.code, 1, `a root naming nothing must FAIL:\n${deadRoot.out}`);
  assert.match(deadRoot.out, /git tracks nothing there/);

  // (i) A VERDICT WRITTEN AFTER ITS READER HAS RUN IS NOT A VERDICT. The scanner's exit
  //     status is checked ~400 lines below the last read of the `fail` flag, so the first cut
  //     of that check printed its whole FAIL block and then the PASS block and exited 0 — the
  //     FAIL-then-PASS shape this guard's own `fail=0` comment already warns about, reproduced
  //     by a blind round on the very check added to close a fail-open. The exit code is what
  //     this asserts, not the message: the message was always right.
  //     The unreadable file is a DANGLING SYMLINK rather than a `chmod 000`: mode bits do not
  //     stop root, and CI containers routinely run as root, so the first cut of this leg would
  //     have become a spurious RED there (the guard reads the file, finds no leak, exits 0, and
  //     the `did not RUN` assertion fails) — a portability trap in a suite whose own header
  //     refuses skips. git lists a symlink like any other file, and no uid can open one whose
  //     target does not exist.
  const unreadable = fixture();
  const blindPath = path.join(unreadable, 'scripts/zz-unreadable.sh');
  fs.symlinkSync('zz-target-that-does-not-exist', blindPath);
  const blind = runGuard(unreadable);
  assert.equal(
    blind.code,
    1,
    `a file the scanner could not READ must FAIL, not merely print:\n${blind.out}`,
  );
  assert.match(blind.out, /did not RUN/);
  assert.doesNotMatch(blind.out, /^PASS:/m, 'FAIL and PASS in one run is a pipeline artifact');

  // (j) THE DOT IS A METACHARACTER AND IT IS IN THE CHARSET. The round that added the
  //     charsets also removed the escaping, on the grounds that the charsets had removed the
  //     need for it. They removed all of it but the dot — and every shipped exception is a
  //     FILE PATH, so every one carries a dot. `domain-baseline.json` was matching
  //     `domain-baselineXjson`, which is the #324 state (fast guard PASS, wholesale pytest
  //     RED) reinstated with the declaration exactly as committed.
  const neighbour = 'src-app/ui/scripts/domain-baselineXjson';
  const overmatch = fixture({ [neighbour]: () => `const k = "${SHARED_TERM}";\n` });
  const overShell = runGuard(overmatch);
  const overOther = runOtherGuard(overmatch);
  assert.equal(overShell.code, 1, `an exception must not match a NEIGHBOUR path:\n${overShell.out}`);
  assert.match(overShell.out, /domain-baselineXjson/);
  assert.equal(overOther.code, 1, `…and the two must agree about it:\n${overOther.out}`);

  // (k) a TRAILING SLASH on a declared path is refused. `data_root src-app/packages/` passed
  //     every other check and built a prefix matching nothing, so the exclusion silently
  //     no-opped in BOTH readers and a package's own scripts/ directory started being reported.
  //     BOTH readers, and the second half is the finding: the first cut of this leg drove only
  //     the shell, and the counterpart's charset `(?![/.])` ACCEPTED a trailing slash, because
  //     its lookahead succeeds at end-of-string. So the shell refused `src-app/packages/` and
  //     the pytest took it and produced dozens of false positives from the un-excluded data
  //     root — one declaration, two answers, which is the whole defect this file removes. A
  //     control that drives one reader cannot see that, whatever it asserts.
  const trailingDir = fixture({
    [DECL]: declEdit((b) => b.replace(/^data_root (.*)$/m, 'data_root $1/')),
  });
  const trailing = runGuard(trailingDir);
  assert.equal(trailing.code, 1, `a trailing slash must be refused:\n${trailing.out}`);
  assert.match(trailing.out, /not a plain path token/);
  const trailingOther = runOtherGuard(trailingDir);
  assert.equal(
    trailingOther.code,
    1,
    `…and the counterpart must refuse it for the SAME reason, not accept it and scan a data ` +
      `root it was told to exclude:\n${trailingOther.out}`,
  );
  assert.match(trailingOther.out, /not a plain path token/);

  // (l) THE SECOND EXEMPTION AXIS, and the leg that exists because a blind round defeated
  //     everything above it from one line. With a real leak planted under a nested `scripts/`
  //     directory, appending `test_path_segment viz` to the declaration turned the fast guard,
  //     the wholesale scan AND the containment assertion green — for the price of a single
  //     re-pin, which is CHEAPER than the `surface_exception` route the cap above bounds. An
  //     exemption axis whose price is lower than the one the guard advertises as capped is
  //     derived-guards.md §5's widening, wearing a different field name.
  //
  //     The leak stays planted while the exemption is added, which is FB-1's shape: an
  //     exemption is proven not to launder the defect only by planting both together.
  //     RE-POINTING a segment rather than APPENDING one, and a blind round is why. Appending
  //     makes the record count 4 -> 5 and trips MAX_TEST_SEGMENTS as well, so the leg passed on
  //     whichever check fired first and said nothing about the one it names. Re-pointing holds
  //     the count fixed, which is also the vector the cap CANNOT price — the honest subject.
  const segDodge = fixture({
    [DECL]: declEdit((b) => b.replace(/^test_path_segment fixtures$/m, 'test_path_segment viz')),
    [`${VIZ_SCRIPTS}/zz-planted.py`]: () => `KIND = "${SHARED_TERM}"\n`,
  });
  const segShell = runGuard(segDodge);
  assert.equal(
    segShell.code,
    1,
    `a test-path segment must not be usable to delete a \`scripts/\` directory from the build ` +
      `surface with a leak in it:\n${segShell.out}`,
  );
  assert.match(segShell.out, /matches file\(s\) on the BUILD surface/);
  //     …and the counterpart catches it WITHOUT this guard, which is the property that
  //     matters: the two are supposed to be independent opinions. Its containment assertion is
  //     what notices, because its model of the build surface deliberately does not apply the
  //     segments while its own scan set does.
  const segOther = runOtherGuard(segDodge, 'test_the_wholesale_scan_contains_the_fast_guards_build_surface');
  assert.equal(
    segOther.code,
    1,
    `…and the wholesale side must catch the same dodge on its own:\n${segOther.out}`,
  );

  // (m) …and ADDING one costs what adding a sixth `surface_exception` costs: an edit to a
  //     SECOND pinned file in the same commit. Before this cap, the cheaper axis sat one field
  //     away from a comment claiming the cap was "the only non-decaying bound on an exception".
  const segCap = runGuard(
    fixture({ [DECL]: declEdit((b) => `${b}\ntest_path_segment zzspec\n`) }),
  );
  assert.equal(segCap.code, 1, `a fourth test_path_segment must FAIL:\n${segCap.out}`);
  assert.match(segCap.out, /test_path_segment` record\(s\); the cap is/);

  // (n) a `surface_root` INSIDE a `data_root` is a declared surface that contributes NOTHING:
  //     it passes the charset, it passes the names-a-real-path check, and the data-root
  //     exclusion then removes every file it brought. §3's marker naming nothing, one field
  //     over — found blind by appending it and watching the build count not move.
  const inertRoot = fixture({
    [DECL]: declEdit((b) => `${b}\nsurface_root ${CROSS_GUARD_PKG}\n`),
  });
  const inertShell = runGuard(inertRoot);
  assert.equal(inertShell.code, 1, `a surface_root under a data_root must FAIL:\n${inertShell.out}`);
  assert.match(inertShell.out, /at or under/);
  const inertOther = runOtherGuard(inertRoot);
  assert.equal(
    inertOther.code,
    1,
    `…and both readers must say so, not one:\n${inertOther.out}`,
  );

  // (p) EVERY declared field is validated, not the two that happened to get a leg. The
  //     charset machinery had controls; the per-field WIRING did not, and a dropped
  //     `_check_values <field> <kind>` line is invisible — the field simply stops being
  //     checked. Derived from the declaration rather than enumerated, so a field added
  //     tomorrow is covered on arrival: for each field present, plant a value carrying a
  //     metacharacter and require BOTH readers to refuse it.
  const declFields = [
    ...new Set(
      fs.readFileSync(path.join(REPO, DECL), 'utf8')
        .split('\n')
        .filter((l) => l.trim() && !l.trimStart().startsWith('#'))
        .map((l) => l.trim().split(/\s+/)[0]),
    ),
  ];
  assert.ok(declFields.length >= 7, `only ${declFields.length} field(s) parsed from ${DECL}`);
  for (const field of declFields) {
    // A value that is a plain token in NO charset: `(` is refused by path, name and marker
    // alike, so one probe covers every field without the leg having to know which kind it is.
    //
    // REPLACING the field's first record rather than APPENDING one, and the first cut of this
    // leg got that wrong in a way worth keeping: appending to a SINGLE-valued field makes the
    // record count 2, and the counterpart raises on the duplicate before it ever reaches the
    // charset — so the leg asserted the wrong refusal and failed on four of the nine fields
    // while proving nothing about their wiring. Replacing holds the count fixed, so the ONLY
    // thing that changed is the value, which is what the leg is about.
    const probe = fixture({
      [DECL]: declEdit((b) => {
        const lines = b.split('\n');
        const i = lines.findIndex((l) => l.startsWith(`${field} `));
        assert.ok(i >= 0, `${DECL} has no \`${field}\` record to replace`);
        lines[i] = `${field} zz(bad`;
        return lines.join('\n');
      }),
    });
    const shellBad = runGuard(probe);
    assert.equal(
      shellBad.code,
      1,
      `\`${field}\` accepts a value carrying a metacharacter — its _check_values wiring is ` +
        `missing, and a value like this is what killed awk's dynamic regex at exit 0:\n${shellBad.out}`,
    );
    assert.match(shellBad.out, /not a plain (path|name|marker) token/);
    const otherBad = runOtherGuard(probe);
    assert.equal(
      otherBad.code,
      1,
      `…and the counterpart must refuse \`${field}\` for the same reason. Its fail-closed layer ` +
        `had no negative control at all until this leg:\n${otherBad.out}`,
    );
    assert.match(otherBad.out, /not a plain (path|name|marker) token/);
  }

  // (q) THE THIRD EXEMPTION AXIS, and the one both readers applied to BOTH sets — so the
  //     backstop shrank with the scan and could not see it. One appended line,
  //     `data_root src-app/libs`, dropped 10 build files including a planted leak and got a
  //     PASS out of both guards. A data root is not an opinion about what to skip: it is a
  //     statement about where the CONTRIBUTED PACKAGES are, and a directory is a package
  //     because it holds a manifest. So it is DERIVED-CHECKED, and `src-app/libs` is refused.
  //     WITH A MANIFEST PLANTED, because the first rule asked about FILE SHAPE and a blind
  //     round bought the exemption with a one-line empty `manifest.yaml`. The dodge and its
  //     legitimising file are planted together, which is the only way a leg can show that the
  //     rule refuses the vector rather than the sloppiest spelling of it.
  const dataDodge = fixture({
    [DECL]: declEdit((b) => `${b}\ndata_root src-app/libs\n`),
    'src-app/libs/zz/manifest.yaml': () => 'name: zz\n',
    [`${VIZ_SCRIPTS}/zz-planted.py`]: () => `KIND = "${SHARED_TERM}"\n`,
  });
  const dataShell = runGuard(dataDodge);
  assert.equal(dataShell.code, 1, `a data root holding no package must FAIL:\n${dataShell.out}`);
  assert.match(dataShell.out, /not at or under/);
  const dataOther = runOtherGuard(dataDodge);
  assert.equal(
    dataOther.code,
    1,
    `…and the wholesale side must catch it INDEPENDENTLY — it is the reader that applied this ` +
      `axis to both of its own sets:\n${dataOther.out}`,
  );
  //     ON THE SAME RULE. Asserting only the exit code lets a leg pass on whichever check the
  //     counterpart happens to run first, which is how three of these rules ended up with no
  //     control at all while their legs were green.
  assert.match(dataOther.out, /not at or under/);

  // (r) A CAPPED SLOT THAT NAMES NOTHING IS AN EXEMPTION ALREADY PAID FOR. `__tests__` sat in
  //     the declaration matching zero tracked files, so one of the four capped slots cost
  //     nothing to spend: a blind round re-pointed it at a directory holding a real leak and
  //     both guards went green with the count never moving.
  //     RE-POINTS, and the first cut of THIS leg made the mistake the leg above documents.
  //     Appending takes the count 3 -> 4, and in the counterpart the CAP is checked before the
  //     classifies-something rule — so `bankedOther` asserted only `code === 1` and passed on
  //     the cap, leaving the counterpart's banked-slot rule with no control at all.
  const banked = fixture({
    [DECL]: declEdit((b) => b.replace(/^test_path_segment testdata$/m, 'test_path_segment __tests__')),
  });
  const bankedShell = runGuard(banked);
  assert.equal(bankedShell.code, 1, `a segment classifying nothing must FAIL:\n${bankedShell.out}`);
  assert.match(bankedShell.out, /no tracked file under the/);
  const bankedOther = runOtherGuard(banked);
  assert.equal(bankedOther.code, 1, `…in both readers:\n${bankedOther.out}`);
  assert.match(
    bankedOther.out,
    /no tracked file under/,
    `…and on the SAME rule, not on whichever check the counterpart happens to run first:\n${bankedOther.out}`,
  );

  // (s) A DOT-LEADING SEGMENT: the two charsets disagreed over 118 strings of the form `a/.b`,
  //     and it was not cosmetic. `surface_root src-app/./packages/_lib` walked past the
  //     at-or-under-a-data-root check — which compares the DECLARED STRINGS — while git
  //     normalised the path and the data-root exclusion emptied it: a declared surface
  //     contributing nothing, at exit 0, with the PASS line advertising it.
  const dotted = fixture({
    [DECL]: declEdit((b) => `${b}\nsurface_root ${CROSS_GUARD_PKG.replace('src-app/', 'src-app/./')}\n`),
  });
  const dotShell = runGuard(dotted);
  assert.equal(dotShell.code, 1, `a dot-leading segment must be refused:\n${dotShell.out}`);
  assert.match(dotShell.out, /not a plain path token/);
  const dotOther = runOtherGuard(dotted);
  assert.equal(dotOther.code, 1, `…and identically in the counterpart:\n${dotOther.out}`);

  // (t) A CRLF DECLARATION. The counterpart argued at length that keeping the `\r` on the value
  //     let the charset refuse it "in both readers", and then read the file in TEXT mode, whose
  //     universal-newline translation removed the byte one call before the code that was
  //     supposed to keep it. Shell red, counterpart green, on the file this branch exists to
  //     make one file.
  const crlfDir = fixture({ [DECL]: declEdit((b) => b.replace(/\n/g, '\r\n')) });
  const crlfShell = runGuard(crlfDir);
  assert.equal(crlfShell.code, 1, `a CRLF declaration must be refused:\n${crlfShell.out}`);
  const crlfOther = runOtherGuard(crlfDir);
  assert.equal(
    crlfOther.code,
    1,
    `…and the counterpart must refuse the same bytes, not normalise them away:\n${crlfOther.out}`,
  );

  // (u) THE BUILD-TIER ASSERTION'S REMEDY HAS TO BE REACHABLE. The first cut computed the
  //     assertion BEFORE the exception and js-test subtractions, so neither remedy its own
  //     message named could clear it — and one of the two could not have worked in any order,
  //     because the js-test derivation is anchored at the repo root and can never name a path
  //     with a directory in it. A guard that fails with instructions that do not work is §1's
  //     false red with the remedy line making it worse.
  const HELPER = 'scripts/tests/zz-helper.sh';
  const tripped = runGuard(fixture({ [HELPER]: () => '#!/usr/bin/env bash\necho ok\n' }));
  assert.equal(tripped.code, 1, `a build file on a test path must be reported:\n${tripped.out}`);
  assert.match(tripped.out, /matches file\(s\) on the BUILD surface/);
  const remedied = runGuard(
    fixture({
      [HELPER]: () => '#!/usr/bin/env bash\necho ok\n',
      [DECL]: declEdit((b) => `${b}\nsurface_exception ${HELPER} a build helper on a test path\n`),
      'scripts/check-derived-vocabulary.sh': (before) => {
        assert.ok(before, 'the guard must be in the fixture');
        return before.replace(/^MAX_SURFACE_EXCEPTIONS=5 /m, 'MAX_SURFACE_EXCEPTIONS=6 ');
      },
    }),
  );
  assert.equal(
    remedied.code,
    0,
    `the remedy the FAIL message names — a declared exception plus the cap it costs — must ` +
      `actually clear the guard:\n${remedied.out}`,
  );

  // (h) a CONTRIBUTED package's own scripts/ directory is DATA, not a surface. The widening
  //     swept it in until a blind round planted a package's own declared id there and watched
  //     the guard report it — §1's "starts refusing things it never meant to refuse", landing
  //     on exactly the act the zero-core invariant exists to keep free.
  const pkgScripts = runGuard(
    fixture({ [`${CROSS_GUARD_PKG}/scripts/gen.py`]: () => `KIND = "${SHARED_TERM}"\n` }),
  );
  assert.equal(pkgScripts.code, 0, `a package's OWN scripts/ must not be a surface:\n${pkgScripts.out}`);
});

// ── TEST-23 ──────────────────────────────────────────────────────────────────────
test('TEST-23 the declaration is BYTE-PINNED like the guards that read it', () => {
  // Moving the surface out of a pinned guard and into a data file would have REMOVED the one
  // property this machinery has — `check-guard-integrity.sh`: "a guard cannot be weakened
  // SILENTLY". So the declaration is pinned too, and narrowing the surface costs a visible
  // diff here and a re-pin diff there, in the same commit.
  const dir = fixture();
  assert.equal(runIntegrity(dir).code, 0, 'the pristine fixture must be pinned');

  fs.appendFileSync(path.join(dir, DECL), 'surface_exception scripts nope\n');
  const drifted = runIntegrity(dir);
  assert.equal(drifted.code, 1, `an edit to the declaration must FAIL the pin:\n${drifted.out}`);
  assert.match(drifted.out, /zero-core-surface\.txt/);

  repin(dir);
  assert.equal(runIntegrity(dir).code, 0, 'a re-pin must clear it — that is the reviewed diff');

  // …and the manifest floor moved with the set, which is what #316 had to be told twice.
  const manifest = fs.readFileSync(path.join(dir, 'scripts/guard-hashes.txt'), 'utf8');
  const entries = manifest.split('\n').filter((l) => /^[0-9a-f]{64}\s+\S+$/.test(l)).length;
  const floor = Number(
    /^MIN_GUARDS=(\d+)/m.exec(fs.readFileSync(path.join(dir, 'scripts/check-guard-integrity.sh'), 'utf8'))?.[1],
  );
  assert.ok(entries >= 1, 'the manifest must hold entries');
  assert.equal(
    floor,
    entries,
    `MIN_GUARDS (${floor}) must equal the ${entries} pinned entries. Slack here is how twelve ` +
      'pins were once droppable before check 3 could fire.',
  );
});

// ── TEST-26 ──────────────────────────────────────────────────────────────────────
test('TEST-26 every written exception names a real path and a design section that exists', () => {
  // Asserted against the REAL tree, ungated, for the reason `derived-guards.md` §3 gives for
  // every marker-keyed guard: the path is caller-supplied text and can be repointed, and a
  // pointer to nothing is indistinguishable from a guard switched off. The guard itself
  // enforces the first half on every run; this adds the DOC pointer, which it cannot check
  // without reading prose.
  const text = fs.readFileSync(path.join(REPO, DECL), 'utf8');
  const records = text
    .split('\n')
    .filter((l) => l.trim() && !l.trimStart().startsWith('#'))
    .map((l) => l.trim().split(/\s+/));
  assert.ok(records.length >= 5, `${DECL} parsed to ${records.length} record(s) — the reader broke`);

  const exceptions = records.filter(([f]) => f === 'surface_exception');
  assert.ok(exceptions.length >= 1, 'the control needs at least one exception to be about');
  const dirRecord = records.find(([f]) => f === 'surface_dir');
  assert.ok(dirRecord, 'the declaration must name a surface_dir');
  const surfaceDir = dirRecord[1];
  // BOUNDED BY THE SCAN ROOTS, exactly as the guard's own walk is. The first cut of the
  // walk-reaches half checked `surfaceDir` anywhere in the tree, so an exception at
  // `docs/scripts/x` would have satisfied this control and failed the guard — a control
  // greener than its subject is a control that has stopped describing it.
  const scanRoots = records.filter(([f]) => f === 'scan_root').map(([, v]) => v);
  assert.ok(scanRoots.length >= 1, 'the declaration must name at least one scan_root');
  const underScanRoot = (f) => scanRoots.some((r) => f === r || f.startsWith(`${r}/`));
  for (const [, target] of exceptions) {
    const tracked = execFileSync(
      'git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', target],
      { cwd: REPO, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    ).split('\n').filter(Boolean);
    assert.ok(tracked.length > 0, `surface_exception ${target} names nothing in the tree`);
    // …and it must name something the WALK REACHES. "Is a tracked path" is not the property:
    // an entry pointing at a file no `surface_dir` walk ever visits narrows nothing and reads,
    // from the outside, exactly like one that does. The first cut of this control asserted only
    // the weaker half.
    assert.ok(
      tracked.some((f) => underScanRoot(f) && f.split('/').slice(0, -1).includes(surfaceDir)),
      `surface_exception ${target} names tracked path(s), but none of them sits under a ` +
        `\`${surfaceDir}/\` directory INSIDE a declared scan root, so the exception excludes ` +
        `nothing the guard would have scanned. That is derived-guards.md §3's marker naming ` +
        `nothing, one step in.`,
    );
  }

  // …and the section the file sends a reader to is really there. It is where the cost of the
  // exception is recorded, so a dead pointer turns a declared decision back into an omission.
  const design = fs.readFileSync(path.join(REPO, 'docs/design/derived-guards.md'), 'utf8');
  assert.ok(text.includes('docs/design/derived-guards.md'), `${DECL} must cite its design record`);
  assert.match(design, /### §7\.1/, 'derived-guards.md §7.1 is where the residuals are recorded');
});

// ── TEST-27 ──────────────────────────────────────────────────────────────────────
test('TEST-27 the containment assertion has a NEGATIVE control — it can be driven red', () => {
  // A blind round noted that TEST-24 (in the pytest) had nothing that drove it red on purpose,
  // so "it passes" carried no information about whether it CAN fail. It can, and this is where
  // that is asserted rather than believed: point the fast guard's surface at a region the
  // wholesale scan does not cover, and the containment must go red.
  //
  // `scan_root` is what makes both sets agree today, so the mutation adds a `surface_root` that
  // is tracked (so it survives the "names a real path" control) and sits OUTSIDE every scan
  // root — the shape that would let the fast guard range over a region with no backstop.
  const OUTSIDE = 'Cargo.lock';
  const dir = fixture({
    [DECL]: declEdit((b) => `${b}\nsurface_root ${OUTSIDE}\n`),
    [OUTSIDE]: () => '# fixture stand-in for a tracked file outside every scan root\n',
  });
  const shell = runGuard(dir);
  assert.equal(shell.code, 0, `the fast guard itself stays green on this mutation:\n${shell.out}`);

  const containment = 'test_the_wholesale_scan_contains_the_fast_guards_build_surface';
  const clean = runOtherGuard(fixture(), containment);
  assert.equal(clean.code, 0, `the containment assertion must be GREEN unmutated:\n${clean.out}`);

  const other = runOtherGuard(dir, containment);
  assert.equal(
    other.code,
    1,
    'the counterpart must go RED when the fast guard ranges over a region it cannot see — ' +
      `that is the #324 relation, and without this leg TEST-24 proves nothing:\n${other.out}`,
  );
  assert.match(other.out, /second opinion/i);
});


// ── TEST-28 ──────────────────────────────────────────────────────────────────────
test('TEST-28 the MIN_SURFACE_DIRS floor BITES — the root-only regression is what #324 was', () => {
  // The floor carries the strongest instruction in the guard ("Re-point the derivation; do NOT
  // lower this") and, for three rounds, no control that it did anything: setting it to 0 and
  // re-pinning left the whole suite green. A floor nothing drives is a number, and #324 is
  // precisely the regression it claims to catch — a derivation that has collapsed back to a
  // root-only pathspec, seeing `scripts/` and nothing deeper.
  //
  // Driven from the TREE rather than by editing the constant, because that is the direction
  // that matters: the guard must notice the surface collapsing, whatever the number says.
  const dir = fixture();
  for (const nested of [VIZ_SCRIPTS, 'src-app/ui/scripts']) {
    fs.rmSync(path.join(dir, nested), { recursive: true, force: true });
  }
  const collapsed = runGuard(dir);
  assert.equal(
    collapsed.code,
    1,
    `with every nested \`scripts/\` directory gone the walk resolves to 1 and MUST fail — that ` +
      `is the root-only derivation #324 leaked through:\n${collapsed.out}`,
  );
  assert.match(collapsed.out, /director\(y\/ies\), below the floor of/);
  assert.match(collapsed.out, /CROSSES/);
});

// ── TEST-29 ──────────────────────────────────────────────────────────────────────
test('TEST-29 the declared test segments DRIVE the app-core tier, and are not decoration', () => {
  // Nothing asserted the app-core tier read the declared list at all, and for a round it did
  // not: the app-core and framework tiers carried `(tests|testdata|fixtures)` hard-coded while
  // only the build tier used the declaration. This is the leg that would have said so.
  //
  // It used to drive `__tests__`, which was in the declaration and matched ZERO tracked files.
  // That was the wrong segment to pick for exactly the reason `__tests__` was later deleted: a
  // capped exemption slot that classifies nothing is an exemption already paid for, and a
  // control built on one is a control built on the part of the declaration that does no work.
  //
  // Both directions, because only the pair is informative: with the segment DECLARED the file
  // is test code and the guard is green; with it REMOVED the same file in the same tree is a
  // leak and the guard names it.
  const rel = 'src-app/server/src/gen/tests/zz_case.rs';
  const plant = { [rel]: () => `const KIND: &str = "${LEAK_TERM}";\n` };

  const declared = runGuard(fixture(plant));
  assert.equal(
    declared.code,
    0,
    `a file under a DECLARED test segment must not be scanned as a dispatch — that is the ` +
      `cry-wolf direction derived-guards.md §1 calls the same defect as a vacuous green:\n${declared.out}`,
  );

  const withdrawn = runGuard(
    fixture({
      ...plant,
      [DECL]: declEdit((b) =>
        b.split('\n').filter((l) => l !== 'test_path_segment tests').join('\n'),
      ),
    }),
  );
  assert.equal(
    withdrawn.code,
    1,
    `…and with the segment withdrawn the SAME file must be reported, or the app-core tier is ` +
      `not reading the declared list:\n${withdrawn.out}`,
  );
  assert.ok(
    withdrawn.out.includes(rel),
    `the guard must NAME the file once its segment is gone:\n${withdrawn.out}`,
  );
});
