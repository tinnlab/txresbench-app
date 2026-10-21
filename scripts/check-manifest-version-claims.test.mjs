#!/usr/bin/env node
// check-manifest-version-claims.test.mjs — the NEGATIVE CONTROLS for
// `scripts/check-manifest-version-claims.sh` (#300).
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────
// #300 records four consecutive branches colliding on one line of a package manifest,
// every one of them caught by a full staging merge and NONE by `base..head`. A guard
// claiming to close that has to be shown doing it, on those four cases, or it is just
// another opinion in a header comment. So every assertion below RECONSTRUCTS one of the
// four historical rows as a real git history and DRIVES THE REAL GUARD over it as a
// subprocess, reading the CHILD'S OWN exit status — never a status observed through a
// pipe, which reports the last element of the pipeline and has produced a false green in
// this tree before.
//
// The four rows are reconstructed TWICE each, because the collision has two moments:
//
//   LANDED     the competing branch has already merged, so the number is on main's TIP.
//              This is what actually happened all four times, and it is REFERENCE A.
//   IN-FLIGHT  the competing branch is still open and its claim exists only on its own
//              ref. Main has not moved. This is the SAME collision one day earlier, it
//              is invisible to a staging merge as well as to `base..head`, and it is
//              REFERENCE B — the half #300 asked for, because it is the half that
//              removes the surprise rather than relocating it.
//
// ── WHAT IS SYNTHETIC AND WHAT IS REAL ──────────────────────────────────────────
// The GUARD is real, byte-for-byte: it is COPIED into each fixture repo, never
// reimplemented. Everything else is synthetic — the packages, their versions and the
// branch topology — and NOTHING here reads the real tree. That is deliberate: a control
// that reddened because a real branch grew a real collision would misattribute a TREE
// problem to the GUARD, and the `check-manifest-version-claims` leg beside it is what
// scans the real tree.
//
// ── NO REAL PACKAGE NAME AND NO DOMAIN ID IS SPELLED IN THIS FILE ───────────────
// Load-bearing rather than stylistic, twice over:
//
//   1. This file lives under `scripts/`, which BOTH guards over the zero-core-vocabulary
//      invariant scan, and the pytest half excludes test code by PATH SEGMENT ONLY, not
//      by basename. A control that spelled a contributed id would be reported as a leak
//      by the guard it sits next to. Two `scripts/*` additions have already turned main
//      red exactly this way (#303, #324).
//   2. The fixture package names are GENERATED, so a guard that had quietly hard-coded a
//      package would score zero here. "A new kind costs zero core code" is enforced from
//      OUTSIDE the package it protects, and this is the outside.
//
// It reads NOTHING under `.lifecycle/`: those artifacts are stripped at merge, so a gate
// that reads them passes in a worktree and then fails on main forever.
//
//   node --test scripts/check-manifest-version-claims.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.join(SCRIPTS_DIR, 'check-manifest-version-claims.sh');

/** The guard's own collapsed-glob floor. A fixture below it tests the floor, not the guard. */
const MIN_PACKAGES = 5;

let seq = 0;
const tmpRoots = [];
function newRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvc-fixture-'));
  tmpRoots.push(dir);
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'fixture@invalid');
  git('config', 'user.name', 'fixture');
  git('config', 'commit.gpgsign', 'false');
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.copyFileSync(GUARD, path.join(dir, 'scripts', path.basename(GUARD)));
  return { dir, git };
}

process.on('exit', () => {
  for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true });
});

/** Generated, never quoted from the real tree — see the header, point 2. */
function pkgNames(n) {
  const base = `p${(seq++).toString(36)}`;
  return Array.from({ length: n }, (_, i) => `${base}-unit-${i}`);
}

function writeManifest(dir, pkg, version, note) {
  const d = path.join(dir, 'src-app', 'packages', pkg);
  fs.mkdirSync(path.join(d, 'compute'), { recursive: true });
  fs.writeFileSync(
    path.join(d, 'manifest.yaml'),
    `# ${pkg}\nname: ${pkg}\nversion: ${version}\nchangelog:\n  - ${note ?? `release ${version}`}\n`,
  );
}
function touchKernel(dir, pkg, body) {
  fs.writeFileSync(path.join(dir, 'src-app', 'packages', pkg, 'compute', 'kernel.py'), body);
}

/**
 * Build one history and run the real guard over it.
 *
 *   baseVersion   what the package said when the branch started
 *   mainNow       what main's TIP says now (=== baseVersion means main has not moved)
 *   claimed       what the branch under test claims
 *   rivals        [{ name, version }] — branches that exist and have NOT merged
 *   quiet         true = the branch under test changes nothing in the package
 *   moveOther     true = main's later commit moves a DIFFERENT package, not this one
 *   selfRemote    true = the branch under test ALSO has refs/remotes/origin/<itself>, at an
 *                 earlier commit (i.e. it has an unpushed commit). Carries the same claim.
 */
function runScenario({
  baseVersion,
  mainNow,
  claimed,
  rivals = [],
  quiet = false,
  moveOther = false,
  selfRemote = false,
  packages = MIN_PACKAGES,
}) {
  const { dir, git } = newRepo();
  const names = pkgNames(packages);
  const subject = names[0];
  const bystander = names[1];

  for (const p of names) {
    writeManifest(dir, p, baseVersion);
    touchKernel(dir, p, 'BASE\n');
  }
  git('add', '-A');
  git('commit', '-qm', 'base');
  const baseCommit = git('rev-parse', 'HEAD').trim();

  // The branch under test: it changes the package and states a version.
  git('checkout', '-q', '-b', 'feature');
  if (!quiet) {
    touchKernel(dir, subject, 'FEATURE WORK\n');
    writeManifest(dir, subject, claimed, `bumped from ${baseVersion} on this branch`);
    git('add', '-A');
    git('commit', '-qm', 'feature');
  } else {
    fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'x\n');
    git('add', '-A');
    git('commit', '-qm', 'unrelated');
  }

  // The branch also exists on the remote, one commit behind — the ordinary state of any
  // branch with something unpushed, and the state that made this guard report a branch as
  // contesting itself until the self-exclusion was made refname-based. The branch TRACKS
  // that remote ref (as a real branch with an unpushed commit does), so the guard can tell
  // it apart from a different branch that merely shares the short name.
  if (selfRemote) {
    const pushed = git('rev-parse', 'HEAD').trim();
    fs.writeFileSync(path.join(dir, 'unpushed.txt'), 'local only\n');
    git('add', '-A');
    git('commit', '-qm', 'unpushed');
    git('update-ref', 'refs/remotes/origin/feature', pushed);
    // A real branch with an unpushed commit has its remote configured and TRACKS the
    // remote ref; without the remote config, `%(upstream)` cannot resolve and the guard
    // would see origin/feature as an unrelated claimant.
    git('config', 'remote.origin.url', 'fixture-remote');
    git('config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
    git('config', 'branch.feature.remote', 'origin');
    git('config', 'branch.feature.merge', 'refs/heads/feature');
  }

  // Main moves on — the competing branch LANDED while this one was out.
  git('checkout', '-q', 'main');
  if (mainNow !== baseVersion) {
    const moved = moveOther ? bystander : subject;
    touchKernel(dir, moved, 'LANDED ELSEWHERE\n');
    writeManifest(dir, moved, mainNow);
    git('add', '-A');
    git('commit', '-qm', 'other branch landed');
  }

  // ...or it has NOT landed, and its claim exists only on its own unmerged ref.
  for (const r of rivals) {
    git('checkout', '-q', '-b', r.name, baseCommit);
    touchKernel(dir, subject, `RIVAL ${r.name}\n`);
    writeManifest(dir, subject, r.version, `bumped from ${baseVersion} on ${r.name}`);
    git('add', '-A');
    git('commit', '-qm', r.name);
    git('checkout', '-q', 'main');
  }

  const r = spawnSync('bash', [path.join(dir, 'scripts', path.basename(GUARD)), 'main', 'feature'], {
    cwd: dir,
    encoding: 'utf8',
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}`, subject, bystander, dir, git };
}

/**
 * THE FOUR HISTORICAL COLLISIONS, from #300's own table, as version arithmetic.
 *
 * The PACKAGE is irrelevant to the mechanism and is therefore not named here (header,
 * point 2) — what is reproduced exactly is the shape: where the branch started, what the
 * competing branch took, what this branch claimed, and what it had to be resolved to.
 *
 *   issue  base     claimed  rival took  resolved to  shape
 *   #227   0.5.0    0.6.0    0.6.0       0.7.0        claim EQUALS the taken version
 *   #269   0.4.0    0.5.0    0.5.0       0.6.0        claim EQUALS the taken version
 *   #266   0.5.0    0.6.0    0.6.0       0.7.0        claim EQUALS the taken version
 *   #243   0.8.0    0.8.1    0.9.0       0.9.1        claim sits BELOW the taken version
 *
 * #243 is the one that is a different shape, and it is the one #300 spends most words on:
 * its changelog sentence ("0.8.0 arrived on main while this branch was out, and this is a
 * bump relative to it") was TRUE when written and FALSE when it landed as 0.9.1. Fixing
 * the number alone would have shipped the false sentence.
 */
const HISTORICAL = [
  { issue: '#227', base: '0.5.0', claimed: '0.6.0', rival: '0.6.0', resolved: '0.7.0' },
  { issue: '#269', base: '0.4.0', claimed: '0.5.0', rival: '0.5.0', resolved: '0.6.0' },
  { issue: '#266', base: '0.5.0', claimed: '0.6.0', rival: '0.6.0', resolved: '0.7.0' },
  { issue: '#243', base: '0.8.0', claimed: '0.8.1', rival: '0.9.0', resolved: '0.9.1' },
];

// ── TEST-1 ──────────────────────────────────────────────────────────────────────
// REFERENCE A: the competing claim has LANDED on main. This is what happened all four
// times, and it is what `check-processor-seed-versions.sh` cannot see, because relative
// to its OWN merge base this branch bumped correctly every single time.
for (const row of HISTORICAL) {
  test(`TEST-1 ${row.issue} — LANDED rival at ${row.rival} reddens a ${row.claimed} claim`, () => {
    const { status, out, subject } = runScenario({
      baseVersion: row.base,
      mainNow: row.rival,
      claimed: row.claimed,
    });
    assert.equal(status, 1, `expected a collision failure, got exit ${status}:\n${out}`);
    assert.match(out, new RegExp(`FAIL\\s+${subject}\\b`), `the failure must NAME the package:\n${out}`);
    assert.ok(
      out.includes(row.rival),
      `the failure must name the version that is already taken (${row.rival}):\n${out}`,
    );
    assert.ok(
      out.includes(row.claimed),
      `the failure must name what this branch claimed (${row.claimed}):\n${out}`,
    );
    // The distinction between "somebody has your exact number" and "main is past you"
    // is the difference between #227/#269/#266 and #243, and a reader acts on it.
    const expected = row.claimed === row.rival ? 'TAKEN' : 'BEHIND';
    assert.ok(out.includes(expected), `expected verdict ${expected} in:\n${out}`);
  });
}

// ── TEST-2 ──────────────────────────────────────────────────────────────────────
// REFERENCE B: the same four collisions ONE DAY EARLIER — the rival is still open, main
// has not moved, and a staging merge would be clean. This is the case #300 filed for.
for (const row of HISTORICAL) {
  test(`TEST-2 ${row.issue} — IN-FLIGHT rival at ${row.rival} reddens a ${row.claimed} claim`, () => {
    const rivalBranch = `rival-${row.issue.slice(1)}`;
    const { status, out, subject } = runScenario({
      baseVersion: row.base,
      mainNow: row.base, // main has NOT moved: base..head and a staging merge are both clean
      claimed: row.claimed,
      rivals: [{ name: rivalBranch, version: row.claimed }],
    });
    assert.equal(status, 1, `expected a contested-claim failure, got exit ${status}:\n${out}`);
    assert.match(out, new RegExp(`FAIL\\s+${subject}\\b`), `must NAME the package:\n${out}`);
    assert.ok(out.includes('CONTESTED'), `expected the CONTESTED verdict in:\n${out}`);
    assert.ok(out.includes(rivalBranch), `must NAME the other claimant branch:\n${out}`);
    assert.ok(out.includes(row.claimed), `must name the contested version:\n${out}`);
  });
}

// ── TEST-3 ──────────────────────────────────────────────────────────────────────
test('TEST-3 the failure carries a number to bump to AND says the changelog is a human call', () => {
  const row = HISTORICAL[3]; // #243, the row whose changelog sentence went false
  const { status, out } = runScenario({
    baseVersion: row.base,
    mainNow: row.rival,
    claimed: row.claimed,
  });
  assert.equal(status, 1);
  // The arithmetic floor above every claim seen — 0.9.0 taken means 0.9.1 is the floor,
  // which is exactly what #243 was resolved to.
  assert.ok(out.includes(row.resolved), `expected the floor ${row.resolved} in:\n${out}`);
  assert.ok(/lowest free number/.test(out), `expected a labelled floor in:\n${out}`);
  // ...and the part a merge tool must NOT be allowed to decide.
  assert.ok(/changelog/i.test(out), `the failure must point at the changelog prose:\n${out}`);
  assert.ok(
    /MINOR/.test(out) && /re-decided|re-decide/i.test(out),
    `the failure must say patch-vs-minor is re-decided against the new base:\n${out}`,
  );
  assert.ok(
    /No tool can decide/i.test(out),
    `the guard must state plainly that it is not resolving the prose:\n${out}`,
  );
});

// ── TEST-4 ──────────────────────────────────────────────────────────────────────
// A check that cannot discriminate is indistinguishable from no check. Every case below
// is a LEGITIMATE branch and must be green.
test('TEST-4 a legitimate single-branch bump is GREEN, and the guard says it looked', () => {
  const { status, out, subject } = runScenario({
    baseVersion: '0.5.0',
    mainNow: '0.5.0',
    claimed: '0.6.0',
  });
  assert.equal(status, 0, `a lone bump must pass:\n${out}`);
  assert.match(out, new RegExp(`ok\\s+${subject}\\b`), `the guard must report that it CHECKED the package, not merely that it found nothing:\n${out}`);
  assert.ok(/1 package\(s\) claimed a version/.test(out), `expected exactly one claim examined:\n${out}`);
});

test('TEST-4b a branch that touches no package claims nothing and is GREEN', () => {
  const { status, out } = runScenario({ baseVersion: '0.5.0', mainNow: '0.6.0', claimed: '0.5.0', quiet: true });
  assert.equal(status, 0, `an untouched package must assert nothing:\n${out}`);
  assert.ok(/0 package\(s\) claimed a version/.test(out), out);
});

test('TEST-4c a rival that is merely BEHIND main is not a claimant (the noise control)', () => {
  // Measured on the real tree while writing this: every (unmerged-ref x package) pair whose
  // version differs from main's numbers 1058, and even at LIVE_REFS_CAP=400 refs x 24
  // packages the ceiling is ~9,600. A guard that reported every differing version would
  // emit that many lines of pure noise on day one and be switched off by the end of the week.
  const { status, out } = runScenario({
    baseVersion: '0.5.0',
    mainNow: '0.6.0',
    claimed: '0.7.0',
    rivals: [{ name: 'stale-branch', version: '0.4.0' }],
  });
  assert.ok(!out.includes('stale-branch'), `a behind-main ref must never be reported as a claimant:\n${out}`);
  // main DID move this package, so the stale-base verdict is the one that fires here.
  assert.equal(status, 1, out);
  assert.ok(out.includes('STALE BASE'), out);
});

test('TEST-4e a package changed with NO bump is deferred to the sibling guard, not re-diagnosed', () => {
  // `check-processor-seed-versions.sh` owns this failure and runs as the leg in front of this
  // one. Two guards reporting one defect send the reader to the wrong repair — here the number
  // is not the problem at all.
  const { status, out, subject } = runScenario({ baseVersion: '0.5.0', mainNow: '0.5.0', claimed: '0.5.0' });
  assert.equal(status, 0, `the no-bump case belongs to the other guard:\n${out}`);
  assert.match(out, new RegExp(`skip\\s+${subject}\\b`), out);
  assert.ok(/check-processor-seed-versions/.test(out), `it must SAY whose failure it is:\n${out}`);
  assert.ok(!/TAKEN/.test(out), `it must not re-diagnose the defect as a collision:\n${out}`);
});

test('TEST-4f a branch never contests ITSELF through its own remote-tracking ref', () => {
  // Found by running the guard against the branch actually in flight in this repo: its own
  // `refs/remotes/origin/<branch>` sat at a different commit, so an object-identity test
  // alone reported CONTESTED against itself, naming itself as the rival. Excluded by NAME.
  const { status, out, subject } = runScenario({
    baseVersion: '0.5.0',
    mainNow: '0.5.0',
    claimed: '0.6.0',
    selfRemote: true,
  });
  assert.equal(status, 0, `a branch must not contest itself:\n${out}`);
  assert.ok(!/CONTESTED/.test(out), out);
  assert.match(out, new RegExp(`ok\\s+${subject}\\b`), out);
});

test('TEST-4d main moving a DIFFERENT package leaves this claim alone', () => {
  const { status, out, subject } = runScenario({
    baseVersion: '0.5.0',
    mainNow: '0.9.9',
    claimed: '0.6.0',
    moveOther: true,
  });
  assert.equal(status, 0, `a bump on an unrelated package must not redden this one:\n${out}`);
  // The exit code alone cannot discriminate: a guard replaced by `exit 0` passes this too.
  // The guard must actually LOOK at the package and say so, like TEST-4/4b/4e/4f/5b do.
  assert.match(out, new RegExp(`ok\\s+${subject}\\b`), `the guard must report that it CHECKED the package, not merely that it found nothing:\n${out}`);
  assert.ok(/1 package\(s\) claimed a version/.test(out), `expected exactly one claim examined:\n${out}`);
});

// ── TEST-5 ──────────────────────────────────────────────────────────────────────
test('TEST-5 a free number chosen against a base main has moved past still reddens', () => {
  // #300's subtlest case: 0.7.0 IS free, so the number needs no repair — but it was
  // chosen against 0.5.0, and both the patch-vs-minor decision and the changelog sentence
  // were made against a base that no longer exists.
  const { status, out, subject } = runScenario({ baseVersion: '0.5.0', mainNow: '0.6.0', claimed: '0.7.0' });
  assert.equal(status, 1, `expected the stale-base verdict, got exit ${status}:\n${out}`);
  assert.ok(out.includes('STALE BASE'), out);
  assert.match(out, new RegExp(`FAIL\\s+${subject}\\b`), out);
  assert.ok(out.includes('0.5.0') && out.includes('0.6.0'), `both bases must be printed:\n${out}`);
});

test('TEST-5b merging main in clears the stale-base verdict, and nothing else does', () => {
  // The verdict must be SELF-CLEARING by the correct action, or it is a wall rather than
  // a guard. Re-run the same fixture after merging main into the branch.
  const { dir, git, subject } = runScenario({ baseVersion: '0.5.0', mainNow: '0.6.0', claimed: '0.7.0' });
  git('checkout', '-q', 'feature');
  git('-c', 'user.email=f@invalid', '-c', 'user.name=f', 'merge', '-q', '--no-edit', '-X', 'ours', 'main');
  const r = spawnSync('bash', [path.join(dir, 'scripts', path.basename(GUARD)), 'main', 'feature'], {
    cwd: dir,
    encoding: 'utf8',
  });
  const out = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 0, `merging main in must clear the verdict:\n${out}`);
  assert.match(out, new RegExp(`ok\\s+${subject}\\b`), out);
});

// ── TEST-6 ──────────────────────────────────────────────────────────────────────
test('TEST-6 the guard FAILS CLOSED on a collapsed package glob', () => {
  const { dir, git } = runScenario({ baseVersion: '0.5.0', mainNow: '0.5.0', claimed: '0.6.0' });
  git('checkout', '-q', 'feature');
  // Rename the layout out from under the glob — the shape that once let a sibling guard
  // print "clean (0 packages checked)" at exit 0. Run in WORKING-TREE mode (no HEAD_REF):
  // with a pinned HEAD_REF the scan set is derived from the refs, not the disk, so an
  // on-disk rename cannot collapse it — the on-disk glob is the scan set only when the
  // working tree IS the branch under test (TEST-11 covers the ref-derived floor).
  for (const p of fs.readdirSync(path.join(dir, 'src-app', 'packages'))) {
    fs.renameSync(
      path.join(dir, 'src-app', 'packages', p, 'manifest.yaml'),
      path.join(dir, 'src-app', 'packages', p, 'package.yaml'),
    );
  }
  const r = spawnSync('bash', [path.join(dir, 'scripts', path.basename(GUARD)), 'main'], {
    cwd: dir,
    encoding: 'utf8',
  });
  assert.equal(r.status, 1, `a scan set that collapsed to nothing must never be a PASS:\n${r.stdout}${r.stderr}`);
  assert.ok(/below the floor/.test(`${r.stdout}${r.stderr}`), `${r.stdout}${r.stderr}`);
});

test('TEST-6b the guard REFUSES rather than guessing when main is unreachable', () => {
  const { dir } = runScenario({ baseVersion: '0.5.0', mainNow: '0.5.0', claimed: '0.6.0' });
  const r = spawnSync('bash', [path.join(dir, 'scripts', path.basename(GUARD)), 'no/such/ref', 'feature'], {
    cwd: dir,
    encoding: 'utf8',
  });
  assert.equal(r.status, 2, `a missing reference is a setup failure, not a green:\n${r.stdout}${r.stderr}`);
  assert.ok(/not found/.test(`${r.stdout}${r.stderr}`), `${r.stdout}${r.stderr}`);
});

// ── TEST-7 ──────────────────────────────────────────────────────────────────────
test('TEST-7 the guard hard-codes no package name (a new one costs zero edits to it)', () => {
  // The fixture names are generated per run, so a guard carrying an enumeration of real
  // package names would have nothing to match here. Assert directly, too: the guard's own
  // bytes must not mention any package that exists in the real tree.
  const real = execFileSync('git', ['ls-files', '--', 'src-app/packages/*/manifest.yaml'], {
    cwd: path.resolve(SCRIPTS_DIR, '..'),
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean)
    .map((p) => p.split('/')[2]);
  assert.ok(real.length >= MIN_PACKAGES, `the reader broke: found ${real.length} package(s)`);
  const bytes = fs.readFileSync(GUARD, 'utf8');
  const named = real.filter((p) => bytes.includes(p));
  assert.deepEqual(named, [], `the guard names real packages, so a new one is not free: ${named.join(', ')}`);
});

// ── TEST-8 ──────────────────────────────────────────────────────────────────────
test('TEST-8 a stacked branch does not contest its own lineage (both directions)', () => {
  // feat-b is a strict descendant of feat-a: it contains feat-a's commit and does not
  // re-touch `version:`. One claim on one lineage is not a collision, so neither side may
  // redden the other as CONTESTED — and the advice a false CONTESTED would print ("bump to
  // 0.6.1") would manufacture a spurious bump. Run from BOTH sides.
  const { dir, git } = newRepo();
  const names = pkgNames(MIN_PACKAGES);
  const subject = names[0];
  for (const p of names) {
    writeManifest(dir, p, '0.5.0');
    touchKernel(dir, p, 'BASE\n');
  }
  git('add', '-A');
  git('commit', '-qm', 'base');

  git('checkout', '-q', '-b', 'feat-a');
  touchKernel(dir, subject, 'FEATURE WORK\n');
  writeManifest(dir, subject, '0.6.0', 'bumped from 0.5.0 on feat-a');
  git('add', '-A');
  git('commit', '-qm', 'feat-a');

  // feat-b is stacked on feat-a: it inherits feat-a's commit (and its claim) and adds its
  // own work WITHOUT re-touching `version:`.
  git('checkout', '-q', '-b', 'feat-b');
  touchKernel(dir, subject, 'STACKED WORK\n');
  git('add', '-A');
  git('commit', '-qm', 'feat-b');

  // From feat-a's side: feat-b is a DESCENDANT of HEAD and must not contest it.
  let r = spawnSync('bash', [path.join(dir, 'scripts', path.basename(GUARD)), 'main', 'feat-a'], {
    cwd: dir,
    encoding: 'utf8',
  });
  let out = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 0, `feat-a must not be contested by its descendant feat-b:\n${out}`);
  assert.ok(!/CONTESTED/.test(out), out);
  assert.match(out, new RegExp(`ok\\s+${subject}\\b`), out);

  // From feat-b's side: feat-a is an ANCESTOR of HEAD and must not contest it.
  r = spawnSync('bash', [path.join(dir, 'scripts', path.basename(GUARD)), 'main', 'feat-b'], {
    cwd: dir,
    encoding: 'utf8',
  });
  out = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 0, `feat-b must not be contested by its ancestor feat-a:\n${out}`);
  assert.ok(!/CONTESTED/.test(out), out);
  assert.match(out, new RegExp(`ok\\s+${subject}\\b`), out);
});

// ── TEST-9 ──────────────────────────────────────────────────────────────────────
test('TEST-9 a package ADDED on the branch is scanned even with main checked out, and a rival claiming it reddens', () => {
  // The scan set must come from the refs, not the working tree: CI checks out main and
  // passes `main feature`, so a package that exists only on the branch is invisible to an
  // on-disk glob — the exact shape a new spatial kind ships as. A rival claiming the same
  // new package at the same version must redden and NAME it.
  const { dir, git } = newRepo();
  const names = pkgNames(MIN_PACKAGES);
  const added = pkgNames(1)[0];
  for (const p of names) {
    writeManifest(dir, p, '0.5.0');
    touchKernel(dir, p, 'BASE\n');
  }
  git('add', '-A');
  git('commit', '-qm', 'base');

  // feature adds the new package.
  git('checkout', '-q', '-b', 'feature');
  writeManifest(dir, added, '0.1.0', 'introduced on feature');
  touchKernel(dir, added, 'NEW\n');
  git('add', '-A');
  git('commit', '-qm', 'feature adds package');

  // rival adds the SAME package at the SAME version.
  git('checkout', '-q', 'main');
  git('checkout', '-q', '-b', 'rival');
  writeManifest(dir, added, '0.1.0', 'introduced on rival');
  touchKernel(dir, added, 'NEW\n');
  git('add', '-A');
  git('commit', '-qm', 'rival adds package');
  git('checkout', '-q', 'main');

  const r = spawnSync('bash', [path.join(dir, 'scripts', path.basename(GUARD)), 'main', 'feature'], {
    cwd: dir,
    encoding: 'utf8',
  });
  const out = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 1, `the added package's collision must be seen:\n${out}`);
  assert.match(out, new RegExp(`FAIL\\s+${added}\\b`), `the failure must NAME the added package:\n${out}`);
  assert.ok(out.includes('CONTESTED'), out);
  assert.ok(out.includes('rival'), `must name the rival claimant:\n${out}`);
});

// ── TEST-10 ─────────────────────────────────────────────────────────────────────
test('TEST-10 a package DELETED on main while the branch bumps it is still scanned', () => {
  // The scan set must come from the refs, not the working tree: with main checked out, a
  // package main deleted is absent on disk, so an on-disk glob would never scan it — and a
  // rival claiming the same bumped version would be invisible.
  const { dir, git } = newRepo();
  const names = pkgNames(MIN_PACKAGES);
  const subject = names[0];
  for (const p of names) {
    writeManifest(dir, p, '0.5.0');
    touchKernel(dir, p, 'BASE\n');
  }
  git('add', '-A');
  git('commit', '-qm', 'base');

  // feature bumps the subject.
  git('checkout', '-q', '-b', 'feature');
  touchKernel(dir, subject, 'FEATURE WORK\n');
  writeManifest(dir, subject, '0.6.0', 'bumped from 0.5.0 on feature');
  git('add', '-A');
  git('commit', '-qm', 'feature bumps');

  // main deletes the subject while the branch is out.
  git('checkout', '-q', 'main');
  git('rm', '-qr', path.join('src-app', 'packages', subject));
  git('commit', '-qm', 'main deletes package');

  // rival claims the same bumped version for the deleted package.
  git('checkout', '-q', '-b', 'rival');
  writeManifest(dir, subject, '0.6.0', 'bumped from 0.5.0 on rival');
  touchKernel(dir, subject, 'RIVAL\n');
  git('add', '-A');
  git('commit', '-qm', 'rival bumps');
  git('checkout', '-q', 'main');

  const r = spawnSync('bash', [path.join(dir, 'scripts', path.basename(GUARD)), 'main', 'feature'], {
    cwd: dir,
    encoding: 'utf8',
  });
  const out = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 1, `the deleted-on-main package's collision must be seen:\n${out}`);
  assert.match(out, new RegExp(`FAIL\\s+${subject}\\b`), `the failure must NAME the package:\n${out}`);
  assert.ok(out.includes('CONTESTED'), out);
  assert.ok(out.includes('rival'), `must name the rival claimant:\n${out}`);
});

// ── TEST-11 ─────────────────────────────────────────────────────────────────────
test('TEST-11 the floor applies to the ref-derived scan set in HEAD_REF mode (probe E)', () => {
  // The DISCRIMINATING shape: the working tree holds >= MIN_PACKAGES manifests on disk
  // while the REF-DERIVED set is below the floor. Only that shape can tell the two floor
  // placements apart — a fixture where both count the same number passes identically
  // against either placement and asserts nothing (the old TEST-11 was exactly that: 3
  // packages on disk AND in the refs, so both placements counted 3 < MIN_PACKAGES).
  //
  // Probe E: feature renames every manifest.yaml -> package.yaml, so HEAD_REF's own tree
  // has ZERO manifests while main's tree (checked out, so the on-disk glob) still holds
  // MIN_PACKAGES. A floor placed on the on-disk glob counts 5 and passes; the guard then
  // skips every manifest as absent on feature and prints "clean" at exit 0 — the ITEM-37
  // fail-open. The floor must be placed on the ref-derived set, and on HEAD_REF's OWN
  // count within it: the union is 5 (main's side alone), but HEAD_REF's own count is 0,
  // so the floor must refuse.
  const { dir, git } = newRepo();
  const names = pkgNames(MIN_PACKAGES);
  for (const p of names) {
    writeManifest(dir, p, '0.5.0');
    touchKernel(dir, p, 'BASE\n');
  }
  git('add', '-A');
  git('commit', '-qm', 'base');

  // feature renames the layout out from under the glob.
  git('checkout', '-q', '-b', 'feature');
  for (const p of names) {
    fs.renameSync(
      path.join(dir, 'src-app', 'packages', p, 'manifest.yaml'),
      path.join(dir, 'src-app', 'packages', p, 'package.yaml'),
    );
  }
  git('add', '-A');
  git('commit', '-qm', 'feature renames manifests away');

  // Check out main: the working tree now holds MIN_PACKAGES manifests on disk, so an
  // on-disk-glob floor would pass — only the ref-derived floor can refuse.
  git('checkout', '-q', 'main');

  const r = spawnSync('bash', [path.join(dir, 'scripts', path.basename(GUARD)), 'main', 'feature'], {
    cwd: dir,
    encoding: 'utf8',
  });
  const out = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 1, `a ref-derived scan set below the floor must never be a PASS:\n${out}`);
  assert.ok(/below the floor/.test(out), out);
});

// ── TEST-12 ─────────────────────────────────────────────────────────────────────
test('TEST-12 working-tree mode: an uncommitted bump colliding with a rival committed off the same tip reddens', () => {
  // The descendant-skip must not silence a REAL collision in working-tree mode. There
  // HEAD_OID is the last COMMIT and does NOT contain the working tree's claim, so a
  // rival that branched off that same tip and committed the SAME version is not
  // "inheriting my claim" — it is a competing claim, and skipping it would print
  // "clean" over a live collision. Probe C: developer sits on main's tip with an
  // uncommitted bump to 0.6.0; rival branched off that same tip and committed 0.6.0.
  const { dir, git } = newRepo();
  const names = pkgNames(MIN_PACKAGES);
  const subject = names[0];
  for (const p of names) {
    writeManifest(dir, p, '0.5.0');
    touchKernel(dir, p, 'BASE\n');
  }
  git('add', '-A');
  git('commit', '-qm', 'base');

  // rival branches off main's TIP and commits the same version the developer is about
  // to claim.
  git('checkout', '-q', '-b', 'rival');
  touchKernel(dir, subject, 'RIVAL WORK\n');
  writeManifest(dir, subject, '0.6.0', 'bumped from 0.5.0 on rival');
  git('add', '-A');
  git('commit', '-qm', 'rival bumps');
  git('checkout', '-q', 'main');

  // The developer's claim is UNCOMMITTED — the working tree, which is exactly what
  // working-tree mode (ONE argument) is for.
  touchKernel(dir, subject, 'LOCAL WORK\n');
  writeManifest(dir, subject, '0.6.0', 'bumped from 0.5.0 locally');

  const r = spawnSync('bash', [path.join(dir, 'scripts', path.basename(GUARD)), 'main'], {
    cwd: dir,
    encoding: 'utf8',
  });
  const out = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 1, `the uncommitted claim must collide with the rival's committed one:\n${out}`);
  assert.ok(out.includes('CONTESTED'), out);
  assert.ok(out.includes('rival'), `must name the rival claimant:\n${out}`);
  assert.match(out, new RegExp(`FAIL\\s+${subject}\\b`), `the failure must NAME the package:\n${out}`);
});

// ── TEST-13 ─────────────────────────────────────────────────────────────────────
test('TEST-13 working-tree mode: a COMMITTED bump with a stacked descendant is not CONTESTED', () => {
  // Probe D1: the developer sits on feat-a with the bump COMMITTED and a clean working
  // tree, feat-b stacked above carrying the same version. HEAD_OID (feat-a) DOES
  // contain the claim, so a descendant stating that version INHERITED it — the skip is
  // sound and the branch must stay green. This is the direction the `[ -n "$HEAD_REF" ]`
  // gate broke: it switched the descendant skip off in working-tree mode even though
  // the claim was committed, reddening a legitimate stacked pair as CONTESTED with
  // actively wrong advice ("bump to 0.6.1"). TEST-12 + TEST-13 pin the gate in both
  // directions: reverting to the mode test fails THIS control, removing the gate fails
  // TEST-12.
  const { dir, git } = newRepo();
  const names = pkgNames(MIN_PACKAGES);
  const subject = names[0];
  for (const p of names) {
    writeManifest(dir, p, '0.5.0');
    touchKernel(dir, p, 'BASE\n');
  }
  git('add', '-A');
  git('commit', '-qm', 'base');

  // feat-a commits the bump.
  git('checkout', '-q', '-b', 'feat-a');
  touchKernel(dir, subject, 'FEATURE WORK\n');
  writeManifest(dir, subject, '0.6.0', 'bumped from 0.5.0 on feat-a');
  git('add', '-A');
  git('commit', '-qm', 'feat-a');

  // feat-b is stacked on feat-a: it inherits feat-a's commit (and its claim) and adds
  // its own work WITHOUT re-touching `version:`.
  git('checkout', '-q', '-b', 'feat-b');
  touchKernel(dir, subject, 'STACKED WORK\n');
  git('add', '-A');
  git('commit', '-qm', 'feat-b');

  // Back on feat-a with a CLEAN working tree — the claim is committed, not sitting in
  // the working tree. Working-tree mode (ONE argument) must not redden it.
  git('checkout', '-q', 'feat-a');

  const r = spawnSync('bash', [path.join(dir, 'scripts', path.basename(GUARD)), 'main'], {
    cwd: dir,
    encoding: 'utf8',
  });
  const out = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 0, `a committed claim with a stacked descendant must not be CONTESTED:\n${out}`);
  assert.ok(!/CONTESTED/.test(out), out);
  assert.match(out, new RegExp(`ok\\s+${subject}\\b`), `the guard must report that it CHECKED the package:\n${out}`);
});
