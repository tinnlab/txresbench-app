#!/usr/bin/env node
// check-aggregate.test.mjs — the NEGATIVE CONTROLS for `scripts/check-aggregate.sh`
// and for the `check:` recipe that drives it (#287).
//
// ── WHY ─────────────────────────────────────────────────────────────────────────
// This branch's whole claim is behavioural: "every leg runs, and the aggregate is still
// red when one fails." A claim like that is worth exactly what its controls are worth, so
// each assertion below DRIVES the real runner as a subprocess over synthetic legs and
// reads the process's OWN exit status — never a status read through a pipe, which has
// produced a false green more than once.
//
// TEST-17..19 go further and drive the REAL `just check` recipe end-to-end with every leg
// replaced by a PATH stub. That exists because the text-shape guards below could not, and
// cannot, carry this weight: a blind audit defeated three successive spellings of them
// (`|| true` on the invocation, a leg rewritten to `true`, a leg swapped for a no-op) with
// the whole suite green. A syntactic guard standing in for a behavioural property has an
// unbounded evasion space; the behavioural test is the one that closes it, and the
// remaining text checks are a cheap early-warning layer on top, not the proof.
//
// It runs as the FIRST leg of `just check`, mirroring the load-bearing order
// `check-packages` and `check-guards` already document: a gate edited without its
// controls still passing is a gate whose PASS is worth nothing. It is aggregated like
// every other leg (it may not abort the run — that is the defect being removed), and the
// runner prints a loud banner when it is the leg that failed.
//
// It reads NOTHING under `.lifecycle/` (rule B6): those artifacts are stripped at merge,
// and a gate that reads them passes in a worktree and then fails on main forever.
//
//   node --test scripts/check-aggregate.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(SCRIPTS_DIR, '..');
const RUNNER = path.join(SCRIPTS_DIR, 'check-aggregate.sh');

/**
 * Drive the real runner over synthetic legs.
 *
 * `spawnSync().status` is the child's OWN exit code. It is deliberately NOT
 * `sh -c 'runner | head'` + `$?`, which reports the LAST pipeline element's status and
 * reads green over a red gate.
 */
function runLegs(legLines, args = [], cwd = REPO) {
  // EPIPE handling (pre-existing flake, fixed here): the runner BAILS on some argument
  // errors (e.g. an out-of-range --min-legs) BEFORE it reads stdin, so the input write
  // races the child's exit — `spawnSync` then reports EPIPE ~1 run in 6 and this whole
  // controls suite reddened for no assertion-related reason. The child that closed its
  // stdin already RAN and EXITED: when EPIPE comes with a numeric `status` (measured
  // `error: EPIPE, status: 2`), that status is the child's OWN verdict and the unborn
  // stdin bytes were not needed — a runner that exits before EOF-on-input has already
  // decided (bad leg, out-of-range floor, bad flag). The verdict is read exactly as
  // before; EPIPE-with-status is accepted, ANY other error still fails loudly.
  const input = legLines.join('\n') + (legLines.length ? '\n' : '');
  const r = spawnSync('bash', [RUNNER, ...args], { input, cwd, encoding: 'utf8' });
  assert.ok(
    r.error === undefined ||
      (r.error.code === 'EPIPE' && typeof r.status === 'number'),
    `spawning the runner failed: ${r.error}`,
  );
  assert.notEqual(
    r.status,
    null,
    `the runner did not exit normally (signal ${r.signal}) — an infrastructure failure, ` +
      `not a wrong exit code; do not read the assertions below as a result`,
  );
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, all: r.stdout + r.stderr };
}

const TMPDIRS = [];
// Every temp path below is interpolated into a shell command inside single quotes. A path
// containing a quote would produce a syntactically broken command and read as a test
// failure rather than as the environment problem it is, so it is refused up front.
assert.doesNotMatch(
  os.tmpdir(),
  /['"]/,
  `TMPDIR (${os.tmpdir()}) contains a quote — this suite cannot build shell commands over ` +
    `such a path. Infrastructure, not a result.`,
);
function tmpdir(label) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `check-aggregate-${label}-`));
  TMPDIRS.push(d);
  return d;
}
// These controls are leg 1 of every `just check`, so a cleanup that only LOOKS like
// cleanup leaks a directory per run, forever. (It did: the previous version registered an
// EMPTY callback.)
process.on('exit', () => {
  for (const d of TMPDIRS) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// ── TEST-1 [acceptance] [invariant: INV-1] ──────────────────────────────────────────
test('TEST-1 [acceptance] [invariant: INV-1] every leg runs even when an earlier leg fails', () => {
  const d = tmpdir('inv1');
  const { status } = runLegs([
    `first  touch '${d}/first.marker' && exit 7`,
    `second touch '${d}/second.marker'`,
    `third  touch '${d}/third.marker'`,
  ]);

  // The proof shape #276 used on itself: a leg AFTER the failing one left its side effect
  // behind, so it demonstrably executed. Under abort-on-first-failure only `first.marker`
  // would exist.
  for (const marker of ['first', 'second', 'third']) {
    assert.ok(
      fs.existsSync(path.join(d, `${marker}.marker`)),
      `${marker} did not run — the runner aborted on an earlier failure, which is the ` +
        `exact defect #287 removes (a leg's failure may change the VERDICT, never which legs RUN)`,
    );
  }
  assert.notEqual(status, 0, 'sanity: the run containing a failing leg must not be green');
});

// ── TEST-2 [acceptance] [invariant: INV-2] ──────────────────────────────────────────
test('TEST-2 [acceptance] [invariant: INV-2] the aggregate exits non-zero when any leg fails', () => {
  const d = tmpdir('inv2');
  const { status } = runLegs([
    `ok-one   touch '${d}/a'`,
    `broken   exit 3`,
    `ok-two   touch '${d}/b'`,
  ]);
  // Read from the child's own status. Running everything must NOT convert a failing
  // aggregate into a passing one — that would be strictly worse than aborting.
  assert.equal(
    status,
    1,
    'a run with a failing leg must exit 1; a green here means the aggregate swallowed a failure',
  );
});

// ── TEST-3 [acceptance] [invariant: INV-3] ──────────────────────────────────────────
test('TEST-3 [acceptance] [invariant: INV-3] the summary names every leg with its own verdict', () => {
  const { all } = runLegs(['alpha true', 'beta exit 3', 'gamma true']);
  const summary = all.slice(all.indexOf('SUMMARY'));
  assert.match(summary, /PASS\s+alpha/, 'the summary must record alpha as PASS by name');
  assert.match(summary, /FAIL\(3\)\s+beta/, 'the summary must record beta as FAIL with its own exit code');
  assert.match(summary, /PASS\s+gamma/, 'the summary must record gamma as PASS by name');
  // A bare "something failed" repeats the original defect one level up, so the failing
  // legs are also listed explicitly.
  assert.match(summary, /FAILED LEGS \(1 of 3\): beta/);
});

// ── TEST-4 [acceptance] [invariant: INV-4] ──────────────────────────────────────────
test('TEST-4 [acceptance] [invariant: INV-4] a shrunken leg set fails instead of reporting a green', () => {
  // Both legs PASS. The only thing wrong is that a third leg is missing — i.e. the gate
  // silently got smaller, which is the vacuous green the floor exists to catch.
  const short = runLegs(['alpha true', 'beta true'], ['--min-legs', '3']);
  assert.notEqual(short.status, 0, 'a run below the declared leg floor must not be green');
  assert.match(short.all, /LEG FLOOR BREACHED — read 2 leg\(s\), floor is 3/);

  const empty = runLegs([], ['--min-legs', '0']);
  assert.notEqual(empty.status, 0, 'reporting success over zero legs is the vacuous green itself');
  assert.match(empty.all, /NO LEGS/);
});

// ── TEST-5 ──────────────────────────────────────────────────────────────────────────
test('TEST-5 the aggregate exits 0 when every leg passes', () => {
  const { status, all } = runLegs(['alpha true', 'beta true', 'gamma true'], ['--min-legs', '3']);
  // The complement of TEST-2: the gate must not be merely always-red.
  assert.equal(status, 0, `an all-passing run must exit 0; got ${status}\n${all}`);
  assert.match(all, /PASS — 3\/3 legs passed/);
  assert.doesNotMatch(all, /FAILED LEGS/);
});

// ── TEST-6 ──────────────────────────────────────────────────────────────────────────
test('TEST-6 legs run in the declared order, and a failure does not reorder them', () => {
  const d = tmpdir('order');
  const log = path.join(d, 'order.log');
  const { status } = runLegs([
    `one   echo one >> '${log}'`,
    `two   echo two >> '${log}'; exit 2`,
    `three echo three >> '${log}'`,
    `four  echo four >> '${log}'`,
  ]);
  assert.notEqual(status, 0);
  assert.deepEqual(
    fs.readFileSync(log, 'utf8').trim().split('\n'),
    ['one', 'two', 'three', 'four'],
    'legs must execute sequentially in the order declared — the #276 constraint is that no ' +
      'leg gets special-pleaded into an earlier position',
  );
});

// ── TEST-7 ──────────────────────────────────────────────────────────────────────────
test('TEST-7 each leg’s stdout and stderr reach the aggregate output, failing legs included', () => {
  // The needles must be COMPUTED by the leg, never spelled in its command text — the
  // runner echoes each command as `$ <cmd>`, so a literal needle is satisfied by that echo
  // even with every leg's output discarded. (It was: this test passed with
  // `bash -c … >/dev/null 2>/dev/null`.) `21*2` is in the command; `OUT-42` is only in the
  // output.
  const { all } = runLegs([
    "talker printf 'OUT-%s\\n' $((21*2)) && printf 'ERR-%s\\n' $((21*2)) >&2",
    "loud-failure printf 'FOUT-%s\\n' $((21*3)) && printf 'FERR-%s\\n' $((21*3)) >&2 && exit 4",
  ]);
  for (const needle of ['OUT-42', 'ERR-42', 'FOUT-63', 'FERR-63']) {
    assert.ok(
      all.includes(needle),
      `'${needle}' was swallowed — a summary that names a failing leg is useless if the ` +
        `reason it failed is not in the log`,
    );
  }
});

// ── TEST-8 ──────────────────────────────────────────────────────────────────────────

/**
 * The leg-count floor, FROZEN here rather than derived from the justfile.
 *
 * TEST-8 also asserts `legs.length === --min-legs`, but both sides of that comparison are
 * read from the same file, so deleting a leg AND lowering `--min-legs` in one commit moves
 * them together and nothing reddens — `docs/derived-guards.md` §4's "a derivation
 * whose two sides read the same source is a tautology in the direction that source
 * changes". This constant is the frozen half that §4 prescribes alongside the derivation.
 * Adding a leg never needs it edited; REMOVING one does, and this file's sha256 is pinned
 * in `scripts/guard-hashes.txt`, so that edit lands in a diff a reviewer reads.
 */
// 10 -> 5 in the strip node (ITEM-2): five legs (`check-py`, `check-packages`,
// `check-coercion`, `check-processor-versions`, `check-r-regime`) were REMOVED with the
// units they verified — the single-cell processor packages, the env-rootfs recipes and
// the coercion corpus, all deleted by the node's plan. A plan shrinkage, not the
// "lower the floor to fit a red" §5 names as the anti-pattern; see the ITEM-2 block in
// the TEST-21 ledger below.
// 5 -> 11 (gate-tests phase 1): the UI `npm run check` chain was split into seven
// `ui-*` legs (one per link / guard family) because its red first link (`check:e2e-routing`)
// was hiding `test:unit` behind it — the #287 defect one level down. A pure ADD, so the
// floor moved UP with the set, in the same diff as `--min-legs` and AGGREGATE_FLOORS.
// 11 -> 13 (gate-tests phase 2): two Rust crate-test legs added — `sdk-crates-test`
// (the SDK crates' own tests, `cargo test --workspace` in the sdk/ workspace, run in the
// sqlite-backend driver variant the app consumes because the default PG/embedded-pg
// variant needs a build-time Postgres cluster the gate image lacks; sandbox-guest-agent +
// sandbox-seccomp excluded: their test binaries need `libseccomp-dev`, absent from the
// gate image — see the justfile comment) and `desktop-crate-test`
// (`cargo test -p txresbench-desktop`). A pure ADD (nested sdk/ workspace + the desktop
// crate were covered by NO leg before), again in the same diff as `--min-legs` and
// AGGREGATE_FLOORS. Note the sdk leg is EXPECTED RED today: it surfaces a pre-existing
// generator-golden drift (txresbench-framework) and a FUSE-device gap
// (txresbench-test-harness data_dir_reclaim) — reds to fix, never to exclude (the floor
// moves up WITH the legs; it does not shrink to fit them).
// 13 -> 16 (gate-tests phase 3): three JS/TS legs added — `sdk-ts-test` (the npm `test`
// script of the five SDK packages that declare one: framework, kit, gallery, shell,
// config; notification-ui + test-e2e have no test/typecheck script and get no leg),
// `gallery-guards` (check-gallery-prod-exclusion.mjs --build + check-harness-parity.mjs
// from the app's ui/ cwd) and `site-test` (node --test site/tests/*.test.mjs). A pure
// ADD — committed suites no leg ran — again in the same diff as `--min-legs` and
// AGGREGATE_FLOORS. The site leg is EXPECTED RED today: deploy.test.mjs TEST-18
// (the node's diff-surface rule) fails because the gate-tests phase diffs themselves
// touch docs/justfile/scripts, and build.test.mjs TEST-16 (self-contained + green)
// inherits that red — named reds, never excluded (the floor rises WITH the set).
// 16 -> 18 (gate-tests phase 4): TWO legs added — `scripts-node-tests` (a run-time
// `find` over scripts/ for every `*.test.mjs` not already a leg, minus the one docker
// suite the gate cannot build) and `scripts-py-tests` (the six stdlib-unittest
// `*.test.py` under scripts/demo + scripts/dev-registry, `python3 -I`). A pure ADD —
// committed suites no leg ran — again in the same diff as `--min-legs` and
// AGGREGATE_FLOORS. Both legs are expected RED today on THIS box for path-only
// reasons: the demo scripts' tests hardcode /data/pbya/... work dirs (absent here), and
// build-wsl-rootfs + installer/surface + e2e_demo carry pre-existing code-state reds —
// NAMED reds per file (TEST-26 keeps the coverage claim machine-checked), never
// skipped, never edited.
const MIN_LEGS_FLOOR = 18;

/**
 * The body of a `just` recipe, delimited the way JUST delimits it: every following line
 * that is blank or indented, up to the first non-indented non-blank line.
 *
 * NOT `split('\n\n')[0]`. A blank line does NOT end a recipe for `just` — it keeps
 * executing the indented lines after it — so a blank-line-truncating parser cannot see a
 * line appended past one, and an `exit 0` hidden there would make `just check`
 * unconditionally green with every control still passing.
 */
function recipeBody(name) {
  const lines = fs.readFileSync(path.join(REPO, 'justfile'), 'utf8').split('\n');
  const header = new RegExp(`^${name}(\\s+[^:]*)?:`);
  const start = lines.findIndex((l) => header.test(l));
  if (start < 0) return null;
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') { body.push(l); continue; }
    if (!/^\s/.test(l)) break;
    body.push(l);
  }
  // Trailing blank lines belong to the gap, not the recipe.
  while (body.length && body[body.length - 1].trim() === '') body.pop();
  return body;
}

function checkBlock() {
  const body = recipeBody('check');
  assert.ok(body, 'the justfile no longer declares a `check:` recipe');
  return body.join('\n');
}

function legLinesOf(block) {
  const lines = block.split('\n');
  const start = lines.findIndex((l) => /<<'LEGS'/.test(l));
  assert.notEqual(start, -1, 'the `check:` recipe must feed its legs to the runner via the LEGS heredoc');
  const end = lines.findIndex((l, i) => i > start && l.trim() === 'LEGS');
  assert.notEqual(end, -1, 'the LEGS heredoc is unterminated');
  return {
    legs: lines.slice(start + 1, end).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')),
    // `start` — the invocation line — is INCLUDED. Excluding it is what made the anchored
    // INVOCATION pattern dead code: ` || true` appended to the invocation passed every
    // control while making `just check` exit 0 over any failing leg.
    outside: [...lines.slice(0, start + 1), ...lines.slice(end + 1)].map((l) => l.trim()).filter(Boolean),
    opener: lines[start],
  };
}

test('TEST-8 the `check:` recipe routes every leg through the runner and can no longer abort', () => {
  const block = checkBlock();
  assert.ok(
    block.includes('scripts/check-aggregate.sh'),
    '`just check` must run its legs through the aggregate runner, or the legs after the ' +
      'first failure become unreachable again (#287)',
  );

  const { legs, outside, opener } = legLinesOf(block);

  const minLegs = Number(/--min-legs[ =](\d+)/.exec(opener)?.[1]);
  assert.ok(Number.isInteger(minLegs), 'the runner must be given a --min-legs floor');
  assert.ok(
    legs.length >= MIN_LEGS_FLOOR,
    `\`just check\` declares only ${legs.length} legs; the frozen floor is ${MIN_LEGS_FLOOR}. ` +
      `A leg has been removed. Do NOT lower this constant to go green — it is the frozen half ` +
      `that makes a shrinking gate visible when --min-legs is lowered in the same commit ` +
      `(derived-guards.md §4).`,
  );
  assert.equal(
    legs.length,
    minLegs,
    `the floor (${minLegs}) must equal the number of legs the recipe actually declares ` +
      `(${legs.length}) — a floor below the leg count lets a leg vanish silently, which is ` +
      `the #218 "guard floor below the guard count" failure`,
  );

  const controls = /--controls-leg[ =](\S+)/.exec(opener)?.[1];
  assert.ok(controls, 'the runner must be told which leg is its own controls leg');
  assert.equal(
    legs[0].split(/\s+/)[0],
    controls,
    "the aggregate's own controls run FIRST, exactly as `check-packages` and `check-guards` " +
      'document ordering as load-bearing',
  );

  for (const leg of legs) {
    const [name, ...rest] = leg.split(/\s+/);
    assert.ok(rest.join(' ').length > 0, `leg '${name}' declares no command — it would report a free PASS`);
  }

  // The anti-regression property: everything the recipe does OUTSIDE the heredoc is the
  // shebang, the shell options, and the single runner invocation. Any other command line
  // here would run before/after the aggregation and could abort the recipe — which is
  // precisely the defect #287 removes.
  // ANCHORED, both ends. An unanchored /check-aggregate\.sh/ accepts any line that merely
  // MENTIONS the runner — `exit 0 # scripts/check-aggregate.sh`, or the invocation itself
  // with `|| true` appended, which makes `just check` exit 0 over a failing leg. The whole
  // line must be the invocation and nothing else.
  const INVOCATION =
    /^"\{\{justfile_directory\(\)\}\}\/scripts\/check-aggregate\.sh"(?: --[a-z-]+(?: (?:'[^']*'|[^\s'"]+))?)* <<'LEGS'$/;
  const allowed = [/^#!\/usr\/bin\/env bash$/, /^set -uo pipefail$/, INVOCATION];
  for (const line of outside) {
    assert.ok(
      allowed.some((re) => re.test(line)),
      `unexpected command in the \`check:\` recipe outside the leg list: '${line}'. Every ` +
        `gate belongs in the LEGS heredoc; a bare line here aborts the recipe on failure ` +
        `and hides every leg behind it.`,
    );
  }
});

// ── TEST-9 ──────────────────────────────────────────────────────────────────────────
test('TEST-9 a failing controls leg is called out as invalidating the other results', () => {
  const { status, all } = runLegs(
    ['self-controls exit 1', 'other true'],
    ['--controls-leg', 'self-controls'],
  );
  assert.notEqual(status, 0);
  assert.match(all, /this gate's own integrity control FAILED — every other result above is unverified/);
  // ...and it still did not abort: the other leg ran and is reported.
  assert.match(all.slice(all.indexOf('SUMMARY')), /PASS\s+other/);
});

// ── TEST-10 ─────────────────────────────────────────────────────────────────────────
test('TEST-10 the runner and these controls are pinned in scripts/guard-hashes.txt', () => {
  const manifest = fs.readFileSync(path.join(SCRIPTS_DIR, 'guard-hashes.txt'), 'utf8');
  const pins = new Map(
    manifest
      .split('\n')
      .filter((l) => l.trim() && !l.trim().startsWith('#'))
      .map((l) => l.trim().split(/\s+/))
      .map(([hash, rel]) => [rel, hash]),
  );
  for (const rel of ['scripts/check-aggregate.sh', 'scripts/check-aggregate.test.mjs']) {
    const pinned = pins.get(rel);
    assert.ok(
      pinned,
      `${rel} is not pinned in scripts/guard-hashes.txt. The runner decides whether ` +
        `\`just check\` passes; unpinned, it can be weakened in a diff nobody reads — the ` +
        `exact argument check-guard-integrity.sh's own header makes. Re-pin with ` +
        `scripts/check-guard-integrity.sh --update`,
    );
    const actual = createHash('sha256').update(fs.readFileSync(path.join(REPO, rel))).digest('hex');
    assert.equal(actual, pinned, `${rel} was edited without re-pinning (scripts/check-guard-integrity.sh --update)`);
  }
});

// ── TEST-11 ─────────────────────────────────────────────────────────────────────────
test('TEST-11 the design the runner realizes still declares its non-negotiables', () => {
  // The anti-deletion half, the same shape as the R-regime suite's own existence test: a
  // runner whose design has been deleted is a mechanism nobody can evaluate.
  const design = fs.readFileSync(path.join(REPO, 'docs/aggregate-gate-reporting.md'), 'utf8');
  const section = design.split('## §5 Non-negotiables', 2)[1];
  assert.ok(section, 'aggregate-gate-reporting.md must still declare a `## §5 Non-negotiables` section');
  for (const inv of ['INV-1', 'INV-2', 'INV-3', 'INV-4']) {
    assert.match(section, new RegExp(`\\*\\*${inv}\\*\\*`), `${inv} is missing from the design's non-negotiables`);
  }
});

// ── TEST-12 ─────────────────────────────────────────────────────────────────────────
test('TEST-12 the rewritten `check:` block still parses for its one existing text consumer', () => {
  // The ancient text consumer was a processor package's pytest reading the recipe
  // slice to assert the R-regime leg; with the package tree the slice's check moved
  // here. Re-asserted so a future edit to the
  // recipe's SHAPE fails in the same run that makes it: the surviving aggregate leg
  // (`check-invariants`) must still be declared.
  const justfile = fs.readFileSync(path.join(REPO, 'justfile'), 'utf8');
  const block = justfile.split('\ncheck:', 2)[1].split('\n\n', 1)[0];
  assert.ok(block.length > 0, 'the `check:` block parsed empty — a blank line has been introduced into it');
  assert.ok(
    block.includes('check-invariants'),
    '`just check` must still include the surviving aggregate leg (check-invariants)',
  );
});

// ── TEST-13 ─────────────────────────────────────────────────────────────────────────
/**
 * Every recipe in the justfile: name → { body lines, header dependencies }.
 * `just` runs a recipe's DEPENDENCIES sequentially before its body and aborts on the
 * first failing one, so dependencies are part of the abort surface and are parsed here.
 */
function allRecipes() {
  const lines = fs.readFileSync(path.join(REPO, 'justfile'), 'utf8').split('\n');
  const recipes = new Map();
  for (let i = 0; i < lines.length; i++) {
    const m = /^([a-zA-Z][\w-]*)([^:]*):(?!=)(.*)$/.exec(lines[i]);
    if (!m) continue;
    // A trailing `# …` on a recipe header is a COMMENT, not dependencies — parsing it as
    // dependencies turns every bare word in the comment into a phantom recipe name.
    // `just` also allows a dependency with arguments, spelled `(dep arg)`; dropping those
    // would leave their subtree unwalked, which is the hole the asserts below exist to close.
    const depText = m[3].split('#')[0].replace(/[()]/g, ' ');
    const deps = depText.trim().split(/\s+/).filter((d) => /^[a-zA-Z][\w-]*$/.test(d));
    // The PARAMETER LIST carries a gate's arguments and their defaults — e.g.
    // `check-processor-versions BASE='origin/main':`. Leaving it out of the pin let the
    // diff base be redefined in the header (`BASE='HEAD'`), which is the same evasion as
    // passing the argument at the call site, one line up.
    // The RAW header line, not just `m[2]`: `([^:]*)` cannot cross a colon, so a default
    // value containing one (`FILTER="analysis:: dataset::"`) truncates the captured
    // parameter list and silently under-hashes the rest. Hashing the line itself has no
    // such blind spot.
    const header = lines[i].trim();
    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() === '') { body.push(l); continue; }
      if (!/^\s/.test(l)) break;
      body.push(l);
    }
    while (body.length && body[body.length - 1].trim() === '') body.pop();
    recipes.set(m[1], { body, deps, header });
  }
  return recipes;
}

/**
 * Every TOP-LEVEL directive in the justfile: `set …`, `export …`, `alias …` and every
 * `name := value`, wherever they appear. They change how the recipes execute without
 * living in any recipe body.
 *
 * Deliberately NOT "everything before the first recipe": `PY_TEST_FLOOR := \"1900\"` — the
 * committed floor under check-py's ~1900-test collection, whose own comment says "Do NOT
 * lower the floor to go green" — is declared halfway down the file, after several recipes.
 * A preamble-only scan missed it, and lowering it to "0" left every test green.
 */
function topLevelDirectives() {
  const lines = fs.readFileSync(path.join(REPO, 'justfile'), 'utf8').split('\n');
  const out = [];
  // An indented line belongs to a RECIPE only if a recipe header opened the current block.
  // `just` also allows multi-line assignments (`A := \'\'\'…\'\'\'`, backtick blocks) whose
  // continuation lines are indented but are VALUE, not recipe body — hashing only the
  // opening line would leave their contents editable in silence.
  let inRecipe = false;
  for (const l of lines) {
    if (/^\s/.test(l)) {
      if (!inRecipe) {
        const t = l.trim();
        if (t && !t.startsWith('#')) out.push(t);
      }
      continue;
    }
    const t = l.trim();
    if (!t) continue;
    if (t.startsWith('#')) continue;
    if (/^([a-zA-Z][\w-]*)([^:]*):(?!=)/.test(l)) { inRecipe = true; continue; }
    inRecipe = false;
    out.push(t);
  }
  return out;
}

/** How many separate GATES a recipe body invokes (`scripts/check-*` or `just check-*`). */
function gateInvocations(body) {
  let n = 0;
  for (const line of body) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    n += [...t.matchAll(/scripts\/check-[\w.-]+|(?<![\w-])just\s+check-[\w-]+/g)].length;
  }
  return n;
}

test('TEST-13 no recipe reachable as a leg of `just check` can abort on its first failure', () => {
  // WHAT THIS ASSERTS, HONESTLY. The behavioural proof that `just check` itself runs every
  // leg is TEST-17/18/19, which drive the real recipe. This is the structural companion
  // for the recipes BELOW it, whose own sub-legs those stubs cannot reach.
  //
  // The predicate is "how many GATES does this recipe invoke", not "how many LINES does it
  // have". A blind audit defeated the line-counting version three ways with the suite
  // green — a shebang recipe with `set -euo pipefail` and four separate gate lines, a
  // one-line `a && b && c` chain, and just HEADER DEPENDENCIES — and all three abort on
  // the first failure exactly as the original defect did. Counting invocations catches the
  // first two; parsing dependencies catches the third.
  const recipes = allRecipes();
  const seen = new Set();
  const queue = ['check'];
  const offenders = [];

  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const rec = recipes.get(name);
    assert.ok(rec, `\`just check\` reaches recipe '${name}', which the justfile does not define`);
    const { body, deps } = rec;

    // A COMMENT mentioning the runner must not exempt a recipe from the abort check.
    const routed = body.some((l) => !l.trim().startsWith('#') && l.includes('check-aggregate.sh'));
    const gates = gateInvocations(body);
    const nonBlank = body.map((l) => l.trim()).filter(Boolean);
    const isShebang = nonBlank.length > 0 && nonBlank[0].startsWith('#!');
    const commandLines = nonBlank.filter((l) => !l.startsWith('#')).length;
    // TWO predicates, unioned, because each catches what the other misses. Counting GATE
    // INVOCATIONS catches a shebang recipe and a one-line `&&` chain, which the line count
    // does not; counting COMMAND LINES on a non-shebang recipe catches a multi-line
    // aggregate whose commands are not spelled `scripts/check-*` or `just check-*` (a node
    // script, an npm script, a cargo invocation), which the gate count does not. Replacing
    // the second with the first was a regression: it made this predicate strictly weaker.
    if (!routed && gates >= 2) {
      offenders.push(
        `${name}: invokes ${gates} separate gates without routing them through the runner ` +
          `(a shebang and a one-line \`&&\` chain abort on the first failure just as ` +
          `separate lines do)`,
      );
    } else if (!routed && !isShebang && commandLines >= 2) {
      offenders.push(
        `${name}: ${commandLines} separate command lines and no shebang — \`just\` runs each ` +
          `as its own command and aborts on the first non-zero exit`,
      );
    }
    // `just` runs dependencies sequentially and aborts on the first failing one, so a
    // recipe listing two or more of them is an aggregate with the original defect.
    // ONE dependency is already an abort surface: `just` runs it BEFORE the body and stops
    // if it fails, so `recipe: dep` hides the body behind the dep exactly as the original
    // defect hid leg 3 behind leg 2. The threshold is 1, not 2.
    if (deps.length >= 1) {
      offenders.push(
        `${name}: declares header dependencies (${deps.join(' ')}), which just runs before ` +
          `the body and aborts on the first failure — hiding the body behind them`,
      );
    }
    // An invocation this walk cannot resolve is a hole in the walk, not a pass.
    for (const line of body) {
      const t = line.trim();
      if (t.startsWith('#')) continue;
      assert.ok(
        !/(?<![\w-])just\s+-/.test(t),
        `${name} invokes just with flags ('${t}') — this walk resolves only \`just <recipe>\`, ` +
          `so the subtree behind it would go unchecked`,
      );
      assert.ok(
        !/\{\{[^}]*\}\}\s+check-/.test(t),
        `${name} invokes a gate through an interpolation ('${t}') — this walk cannot follow ` +
          `it, so the subtree behind it would go unchecked`,
      );
    }

    for (const d of deps) queue.push(d);
    for (const line of body) {
      if (line.trim().startsWith('#')) continue;
      for (const m of line.matchAll(/(?<![\w-])just\s+([\w-]+)/g)) queue.push(m[1]);
    }
  }

  // A floor over the DERIVED walk. Set to the real reach so that dropping ANY recipe from
  // the gate reddens here, not four later (the earlier `>= 5` left that much slack).
  assert.ok(
    seen.size >= 4,
    `the walk reached only ${seen.size} recipe(s) from \`check\` (expected at least 4, ` +
      `currently ${[...seen].join(', ')}). A gate has left the tree, or the walk broke.`,
  );
  assert.deepEqual(
    offenders,
    [],
    `these recipes are reachable from \`just check\` and abort on their first failing gate, ` +
      `hiding every gate after it — the #287 defect one level down:\n  ${offenders.join('\n  ')}`,
  );
});

// ── TEST-14 ─────────────────────────────────────────────────────────────────────────
test('TEST-14 a leg whose command is commented out is refused, not reported PASS', () => {
  // `bash -c '# just check-invariants'` runs nothing and exits 0, so muting a leg in place
  // — the natural way somebody "temporarily" disables one — would report it PASS while the
  // leg COUNT stayed put, defeating the floor at the same time.
  const { status, all } = runLegs(['muted # just check-invariants', 'other true'], ['--min-legs', '2']);
  assert.equal(status, 2, 'a commented-out leg command must be a hard refusal, not a free PASS');
  assert.match(all, /has a commented-out command/);
  assert.doesNotMatch(all, /PASS\s+muted/);
});

// ── TEST-15 ─────────────────────────────────────────────────────────────────────────
test('TEST-15 duplicate leg names are refused, so the floor cannot be satisfied by a copy', () => {
  // Swapping one leg for a second copy of another keeps `--min-legs` satisfied while
  // silently dropping a real gate — a shrunken set that INV-4's counter cannot see.
  const { status, all } = runLegs(['a true', 'b true', 'a true'], ['--min-legs', '3']);
  assert.equal(status, 2, 'a duplicate leg name must be refused');
  assert.match(all, /duplicate leg name 'a'/);
});

// ── TEST-16 ─────────────────────────────────────────────────────────────────────────
test('TEST-16 an out-of-range --min-legs is refused rather than failing open', () => {
  // With `set -e` deliberately absent, `[ "$n" -lt "$MIN_LEGS" ]` over a value past
  // 2^63-1 errors instead of comparing, the failing test is skipped, and the floor
  // silently stops being a floor — a green over any leg set at all.
  const { status, all } = runLegs(['a true'], ['--min-legs', '99999999999999999999']);
  assert.equal(status, 2, 'an uncomparable floor must be refused, never skipped');
  assert.match(all, /out of range/);
});

// ══════════════════════════════════════════════════════════════════════════════════════
// TEST-17..19 — the BEHAVIOURAL proof, over the REAL `just check` recipe
//
// Everything above this line that inspects the justfile inspects its TEXT. A blind audit
// defeated three successive spellings of those text guards with the whole suite green:
// ` || true` on the runner invocation, a leg rewritten to `true`, and a leg swapped for a
// no-op — each of which removes a real gate from `just check`. That is the signature of a
// syntactic guard standing in for a behavioural property: the evasion space is unbounded,
// so each round only finds another spelling.
//
// So these run the ACTUAL recipe. Every external command a leg invokes (`cargo`, `npm`,
// `node`, and the nested `just`) is replaced by a PATH stub that records its argv and can
// be told to fail; `just` itself and `scripts/check-aggregate.sh` are the real ones,
// invoked by absolute path. What the stubs record IS the set of gates `just check` really
// ran, and the exit status is the gate's real verdict.
// ══════════════════════════════════════════════════════════════════════════════════════

/** Resolve a real executable from PATH before the stub directory shadows it. */
function resolveOnPath(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(dir, name);
    try {
      // A directory is "executable" (searchable) to access(2); requiring a regular file
      // stops a directory named `just` on PATH from turning all three behavioural tests
      // red for an environment reason.
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* next */ }
  }
  return null;
}

/**
 * Run the REAL `just check` with every leg's external command stubbed.
 * `fail` is a substring matched against `<command> <args…>`; the stub exits 1 on a match.
 */
function runRealJustCheck({ fail = '' } = {}) {
  const d = tmpdir('realgate');
  const bin = path.join(d, 'bin');
  const log = path.join(d, 'invocations.log');
  fs.mkdirSync(bin);
  // The fail directive travels in a FILE the stub reads, never in an environment
  // variable. An env var would give the only behavioural proof of INV-1/INV-2 a unique,
  // externally visible fingerprint: anything ambient could key on `${STUB_FAIL+x}` and
  // behave one way for these tests and another way for the real gate — a behavioural test
  // distinguishable from the run it stands in for is not standing in for it.
  const failFile = path.join(d, 'fail-directive');
  fs.writeFileSync(failFile, fail);
  // `npx` (and `tsc`, the binary it resolves) are stubbed too: the split UI chain runs
  // `npx --no-install tsc --noEmit` as its OWN leg now, on the raw PATH — without a stub
  // the behavioural tests would execute the real compiler (minutes, and it needs
  // node_modules/.bin) and record nothing for TEST-17/18/19. (`tsc` is kept so a bare
  // `tsc` invocation anywhere would also be intercepted, not executed for real.)
  // `python3` joins the stub set with the gate-tests phase-4 `scripts-py-tests` leg:
  // without it the behavioural runs would execute the REAL six-suite python leg once per
  // TEST-17/18/19 run (minutes of squashfs packaging, plus it is RED on this box on the
  // absent /data/pbya paths, so TEST-19's all-green sanity would redden for an
  // environment reason). The stub set is exactly the external commands a leg may call.
  for (const name of ['cargo', 'npm', 'node', 'just', 'npx', 'tsc', 'python3']) {
    fs.writeFileSync(
      path.join(bin, name),
      `#!/usr/bin/env bash\n` +
        `line="${name} $*"\n` +
        `printf '%s\\n' "$line" >> '${log}'\n` +
        `want="$(cat '${failFile}' 2>/dev/null)"\n` +
        `if [ -n "$want" ] && [ "$line" = "$want" ]; then\n` +
        `  echo "stub: failing on demand: $line" >&2\n` +
        `  exit 1\n` +
        `fi\n` +
        `exit 0\n`,
      { mode: 0o755 },
    );
  }
  const realJust = resolveOnPath('just');
  assert.ok(realJust, '`just` is not on PATH — cannot drive the real recipe');
  const r = spawnSync(realJust, ['check'], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
  });
  assert.equal(r.error, undefined, `spawning just failed: ${r.error}`);
  assert.notEqual(r.status, null, `just did not exit normally (signal ${r.signal}) — infrastructure, not a result`);
  const invocations = fs.existsSync(log)
    ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean)
    : [];
  return { status: r.status, out: r.stdout + r.stderr, invocations };
}

/**
 * The gates `just check` must actually invoke, in order — a FROZEN case table over the
 * derived leg list (`docs/derived-guards.md` §4: derive the membership, freeze the
 * cases whose values matter). Each entry is matched as a prefix of a recorded invocation.
 *
 * Matched for EQUALITY, never as a prefix. A prefix match is defeated by a decoy recipe
 * whose name merely EXTENDS a real gate's (`just check-pyx` prefix-matches `just check-py`
 * and removes ~1900 tests), by an extra argument (`just check-processor-versions HEAD`
 * neuters the diff base), and by a sibling npm script (`npm run check:noop`).
 */
const EXPECTED_GATES = [
  // Leg 1 is pinned to THIS FILE's own path. Anything less lets the controls leg be
  // repointed at an empty `.mjs` (or `/dev/null`), which removes this entire suite from
  // the gate while `node --test …` still shows up in the recorded argv.
  `node --test ${path.join(SCRIPTS_DIR, 'check-aggregate.test.mjs')}`,
  'cargo check --workspace --tests',
  // gate-tests phase 2: the two Rust crate-test legs. `sdk-crates-test` is the ONLY
  // recorded form that can work in the gate image — the default-feature SDK workspace
  // cannot even resolve (its PG driver needs a build-time Postgres cluster; the lock pins
  // postgresql_embedded 0.20.4, rustc >= 1.94, the image has 1.90), so the leg runs the
  // sqlite-backend variant and excludes the two crates whose test binaries need
  // `libseccomp-dev` (see the justfile comment). Frozen here by exact string so the leg
  // cannot silently drop the feature/exclude set. `desktop-crate-test` needs no
  // adjustment — it links and its 103 tests pass.
  'cargo test --workspace --no-default-features --features sqlite-backend,routes,module --exclude sandbox-guest-agent --exclude sandbox-seccomp --no-fail-fast -- --test-threads=1',
  'cargo test -p txresbench-desktop',
  // gate-tests phase 3: the JS/TS legs. `sdk-ts-test` runs the npm `test` script of the
  // five SDK packages that declare one, in ONE npm invocation from the repo root (npm
  // runs every named workspace even when one fails, so a red package cannot hide the
  // rest); the workspace names are spelled out because `npm test --workspaces
  // --if-present` would also sweep the src-app/ui workspace and any package that grows
  // a `test` script, and this leg is scoped to the SDK packages the phase names.
  // notification-ui and test-e2e have no test/typecheck script and are deliberately not
  // included. `gallery-guards` runs the two pinned gallery guards from the app's ui/
  // cwd — the prod-exclusion guard builds the bundle ITSELF (`--build`: clean + `npm run
  // build` from src-app/ui/gallery.config.json's buildCmd, then scan) because the
  // aggregate's legs are independent and ui-npm-build cannot be relied on to have run
  // first — plus the parity guard's own engine test (`node --test
  // check-harness-parity.test.mjs`, the neutral cases that prove the guard fires when a
  // copy loses a core; the gallery package's `test` script runs the same file again via
  // `npm run test:node`, a harmless second invocation that keeps this leg self-contained).
  // `site-test` is `node --test site/tests/*.test.mjs` from the repo root (the
  // zero-dependency site suite); it is EXPECTED RED today on deploy.test.mjs TEST-18
  // (the diff-surface rule vs the gate-tests phase diffs) + build.test.mjs TEST-16
  // (which re-runs the suite and demands green) — frozen here so a future change cannot
  // silently drop that red instead of keeping it a named leg.
  'npm test --workspace=@txresbench/framework --workspace=@txresbench/kit --workspace=@txresbench/gallery --workspace=@txresbench/shell --workspace=@txresbench/config',
  `node ${path.join(REPO, 'sdk/packages/gallery/scripts/check-gallery-prod-exclusion.mjs')} --build`,
  `node ${path.join(REPO, 'sdk/packages/gallery/scripts/check-harness-parity.mjs')}`,
  `node --test ${path.join(REPO, 'sdk/packages/gallery/scripts/check-harness-parity.test.mjs')}`,
  'node --test site/tests/*.test.mjs',
  // gate-tests phase 4: the scripts/ suites as their own legs. `scripts-node-tests`
  // discovers every `scripts/**/*.test.mjs` with a run-time `find` and runs each as its
  // own `node --test` subprocess (one per suite, so a suite that crashes or fails cannot
  // mask the files after it; sort for a deterministic order), excluding ONLY the five
  // suites another leg already runs (check-aggregate-controls in this recipe;
  // check-method-env-images-controls + check-method-list-controls in `check-guards`;
  // check-network-allowlist-controls + check-pub-orphans-controls in `check-invariants`)
  // and build-wsl-rootfs.docker.test.mjs (needs docker + network + ~minutes — the leg
  // PRINTS `SKIPPED build-wsl-rootfs.docker.test.mjs: needs docker`, so the skip is never
  // silent; the docker suite remains its own TXR_WSL_ROOTFS_DOCKER_TEST=1 lane). The 13
  // rows below are the file set as of this phase, frozen in find|sort order; a NEW test
  // file that lands is discovered by the leg, and TEST-26 asserts over the filesystem
  // that every scripts/**/*.test.mjs and *.test.py is covered or named in an exclusion.
  // `scripts-py-tests` runs the six stdlib-unittest `*.test.py` under scripts/demo +
  // scripts/dev-registry, each `python3 -I`, TMPDIR at a per-run dir under $HOME (the
  // four that honor TMPDIR write there; the demo/e2e_real tests hardcode /data/pbya
  // work dirs — path-only reds on this box, named, never skipped). Both legs are one
  // subprocess per file and exit non-zero after the LAST file regardless of the
  // failures before it, exactly the no-hiding property the aggregate itself has.
  'node --test scripts/assemble-method-list.test.mjs',
  'node --test scripts/build-installer-local.test.mjs',
  'node --test scripts/build-wsl-rootfs.test.mjs',
  'node --test scripts/fetch-oras.test.mjs',
  'node --test scripts/import-method-list.test.mjs',
  'node --test scripts/installer/bundle-pretrained-models.test.mjs',
  'node --test scripts/installer/discover-artifacts.test.mjs',
  'node --test scripts/installer/lib/artifacts.test.mjs',
  'node --test scripts/installer/make-update-feed.test.mjs',
  'node --test scripts/installer/surface.test.mjs',
  'node --test scripts/installer/write-downloads-config.test.mjs',
  'node --test scripts/publish-method-list.test.mjs',
  'node --test scripts/verify-macos-vm-runtime.test.mjs',
  'python3 -I scripts/demo/e2e_demo.test.py',
  'python3 -I scripts/demo/record_demo_bundle.test.py',
  'python3 -I scripts/dev-registry/e2e_real.test.py',
  'python3 -I scripts/dev-registry/make_real_inputs.test.py',
  'python3 -I scripts/dev-registry/publish.test.py',
  'python3 -I scripts/dev-registry/registry.test.py',
  // The UI `npm run check` chain (gate-tests phase 1): one recorded command per link —
  // the chain was split out of the single opaque `npm run check` leg precisely so a red
  // link (currently `check:e2e-routing`) cannot hide the links after it. TEST-25 keeps
  // the package.json chain and the `ui-*` legs in parity; these rows are the frozen
  // case-table half of the same property over the REAL recipe. The tsc link runs through
  // `npx --no-install` because `tsc` is on PATH only inside `npm run` (node_modules/.bin)
  // — a plain shell leg would say "tsc: command not found".
  'npx --no-install tsc --noEmit',
  'npm run typecheck:tests',
  'node scripts/collect-actions.mjs --check',
  'node scripts/action-refs-lint.mjs',
  'node scripts/action-coverage.mjs',
  'node scripts/lint-no-domain-in-builtin.mjs',
  'node scripts/lint-text-source-bytes.mjs',
  'node scripts/lint-native-controls.mjs',
  'node scripts/lint-secret-input-caps.mjs',
  'npm run check:e2e-routing',
  'npm run check:rename-mechanical',
  'npm run test:unit',
  'npm run build',
  'just check-invariants',
];

// ── TEST-17 [acceptance] [invariant: INV-1] ─────────────────────────────────────────
test('TEST-17 [acceptance] [invariant: INV-1] the REAL `just check` runs every gate when one fails', () => {
  // Fail the e2e-routing gate — the chain link that is red on main and that made every
  // later link of the old one-leg `npm run check` unreachable.
  const { invocations, status } = runRealJustCheck({ fail: 'npm run check:e2e-routing' });
  assert.notEqual(status, 0, 'sanity: the run had a failing gate and must not be green');

  const missing = EXPECTED_GATES.filter((g) => !invocations.includes(g));
  assert.deepEqual(
    missing,
    [],
    `\`just check\` did not invoke these gates at all:\n  ${missing.join('\n  ')}\n` +
      `What it did invoke:\n  ${invocations.join('\n  ')}\n` +
      `Either a gate was removed/neutered in the recipe, or the aggregate aborted early — ` +
      `both are the #287 defect.`,
  );

  // ...and in the declared order: nothing was reordered to put a favoured gate first.
  const order = EXPECTED_GATES.map((g) => invocations.indexOf(g));
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
    `the gates ran out of order (${order.join(',')}) — the #276 constraint is that no gate ` +
      `gets special-pleaded into an earlier position`,
  );
});

// ── TEST-18 [acceptance] [invariant: INV-2] ─────────────────────────────────────────
test('TEST-18 [acceptance] [invariant: INV-2] the REAL `just check` exits non-zero when a gate fails', () => {
  // Read from the process's own status. This is the assertion that ` || true` anywhere in
  // the recipe — on the runner invocation or on any single leg — turns RED, which no
  // text-shape check reliably did.
  // EVERY gate, one at a time — not a sample. Forcing only a sample of the gates left the
  // rest able to be made unable to fail (` || true`, `&`, a redirect) with the suite green.
  // Each run is ~0.1s because every leg is a stub.
  for (const gate of EXPECTED_GATES) {
    const { status, out } = runRealJustCheck({ fail: gate });
    assert.notEqual(
      status,
      0,
      `\`just check\` exited 0 with '${gate}' failing — a failing aggregate was turned into ` +
        `a passing one, which is strictly worse than the abort it replaced.\n${out.slice(-2000)}`,
    );
  }
});

// ── TEST-19 ─────────────────────────────────────────────────────────────────────────
test('TEST-19 the REAL `just check` exits 0 when every gate passes', () => {
  const { status, invocations, out } = runRealJustCheck();
  assert.equal(status, 0, `an all-passing run must exit 0; got ${status}\n${out}`);
  const missing = EXPECTED_GATES.filter((g) => !invocations.includes(g));
  assert.deepEqual(missing, [], `gates not invoked on the green path: ${missing.join(', ')}`);
});

// ── TEST-20 ─────────────────────────────────────────────────────────────────────────
/**
 * Frozen leg floors for EVERY recipe that aggregates, not just `check`.
 *
 * The derived `--min-legs === declared leg count` check is a tautology on its own: both
 * sides are read from the same file, so deleting a leg and lowering the floor on the same
 * line moves them together (`derived-guards.md` §4). These frozen minimums are the other
 * half, and they cover the three aggregates this branch created — which had no floor
 * control of any kind until a blind audit removed a guard from `check-guards` with a
 * two-line edit and the whole suite stayed green.
 */
// #316 — TWO FLOORS WERE STALE, AND STALE IN THE DIRECTION THAT MATTERS. Both recipes gained a
// controls leg and neither floor moved with it, so `legs.length >= frozen` had two legs of slack
// — which is exactly the same-line `--min-legs` dodge the assertion above exists to close, left
// open by omission. A floor is RAISED with the set it guards; `docs/derived-guards.md` §5
// names lowering one to fit as the anti-pattern. Every entry here now equals its recipe's real
// leg count:
//   'check-invariants': 6 -> 7  — 051c09a1 (#295) added `check-pub-orphans-controls`
//   'check-guards':     4 -> 7  — cce0282e (#278/#304) added `check-derived-vocabulary-controls`;
//                                 #316 added `check-recipe-pins-controls` + `check-recipe-pins`
// #355 — 'check-invariants': 7 -> 9. Two legs added, `check-design-citations-controls` and
// `check-design-citations`. Raised in the SAME diff that adds them, which is what the
// paragraph above had to be told twice; the floor equals the leg count or the equality
// assertion below reds.
// #300 — `check-processor-versions` BECAME an aggregate and is frozen here in the same diff
// that makes it one. It was a single-line recipe; it now runs the base-relative seed-version
// guard, the collision guard's controls, and the collision guard itself. Frozen at 3, equal to
// its leg count, because this file's own argument two comments up is that a floor is raised
// with the set it guards and that the branch adding the set is the one that owes the raise.
// App repo (ITEM-4, method-env-images) — 'check-guards': 7 -> 9. Two legs added,
// `check-method-env-images-controls` and `check-method-env-images` (the committed env-manifest
// structural guard + its negative-control suite, the first pair from the method-env-images
// node). Raised in the SAME diff that adds them, next to the pins in scripts/guard-hashes.txt.
// strip node (ITEM-2): `check-packages` and `check-processor-versions` are deleted with
// their subjects (processor packages + env-rootfs), and `check`/`check-invariants`/
// `check-guards` each lost their single-cell legs. The floors moved WITH the removals
// in the same diff (the anti-pattern §5 names is lowering one to fit a RED, not
// shrinking a gate whose subject is deleted by plan — see the ITEM-2 ledger block).
// App repo (gate guards) — 'check-invariants': 5 -> 9. Four legs added, `check-dead-refs`,
// `check-naming`, `check-network-allowlist` and `check-network-allowlist-controls`: three pinned
// guards that no recipe ran, and the control suite of the network guard. Raised in the SAME
// diff that adds them.
// App repo (PR 4a, the method list) — 'check-guards': 4 -> 6. Two legs added,
// `check-method-list-controls` and `check-method-list` (the method list guard + its controls),
// in the SAME diff that adds them, next to their pins in scripts/guard-hashes.txt.
// gate-tests phase 1 — 'check': 5 -> 11. The UI `npm run check` chain was split into
// seven `ui-*` legs (one per link / guard family): the chain's red first link
// (`check:e2e-routing`) was hiding `test:unit`, the #287 defect one level down. A pure
// ADD, raised in the SAME diff as `--min-legs` and MIN_LEGS_FLOOR (see TEST-8).
// gate-tests phase 2 — 'check': 11 -> 13. Two legs added: `sdk-crates-test` (the SDK
// crates' own tests; the adjusted sqlite-backend form of `cd sdk && cargo test
// --workspace`, excluding the two crates that need libseccomp-dev) and
// `desktop-crate-test` (`cargo test -p txresbench-desktop`). A pure ADD (neither was
// covered by any leg before), raised in the SAME diff as `--min-legs` and
// MIN_LEGS_FLOOR; the sdk leg is expected RED today on the pre-existing
// generator-golden drift + FUSE-device gap — the floor rises WITH the set, it never
// shrinks to fit a red.
// gate-tests phase 3 — 'check': 13 -> 16. Three legs added: `sdk-ts-test` (npm `test`
// of the five SDK packages that declare one), `gallery-guards`
// (check-gallery-prod-exclusion --build + check-harness-parity from the app's ui/ cwd)
// and `site-test` (the zero-dep site suite). A pure ADD (all three were committed test
// populations no leg ran), raised in the SAME diff as `--min-legs` and MIN_LEGS_FLOOR;
// the site leg is expected RED today on deploy.test.mjs TEST-18 (diff-surface rule vs
// the gate-tests phase diffs) + build.test.mjs TEST-16 (suite-must-be-green) — a NAMED
// red leg, never excluded.
// gate-tests phase 4 — 'check': 16 -> 18. Two legs added: `scripts-node-tests` (the
// run-time-discovered node:test suites under scripts/, minus the five suites another leg
// runs and the docker-only suite, which the leg prints a SKIPPED line for) and
// `scripts-py-tests` (the six stdlib-unittest *.test.py, python3 -I). A pure ADD (all
// were committed test populations no leg ran), raised in the SAME diff as `--min-legs`
// and MIN_LEGS_FLOOR; both legs are expected RED today for path-only + pre-existing
// code-state reasons — NAMED reds per failing suite (the justfile comment and TEST-26
// list them), never excluded.
const AGGREGATE_FLOORS = {
  check: 18,
  'check-invariants': 9,
  'check-guards': 6,
};

test('TEST-20 every aggregating recipe declares a floor equal to its leg count and >= its frozen minimum', () => {
  const recipes = allRecipes();
  // Comment lines are excluded: a recipe whose PROSE mentions the runner is not routed
  // through it, and treating it as aggregating produced a confidently wrong diagnosis.
  const aggregating = [...recipes.entries()].filter(([, r]) =>
    r.body.some((l) => !l.trim().startsWith('#') && l.includes('check-aggregate.sh')),
  );
  assert.ok(
    aggregating.length >= Object.keys(AGGREGATE_FLOORS).length,
    `only ${aggregating.length} aggregating recipe(s) found; ${Object.keys(AGGREGATE_FLOORS).length} are frozen ` +
      `(${Object.keys(AGGREGATE_FLOORS).join(', ')}) — one has stopped aggregating`,
  );

  for (const [name, { body }] of aggregating) {
    const lines = body.map((l) => l.trim());
    const start = lines.findIndex((l) => /<<'LEGS'/.test(l));
    const end = lines.findIndex((l, i) => i > start && l === 'LEGS');
    assert.ok(start >= 0 && end > start, `${name}: aggregating recipe has no LEGS heredoc`);
    const legs = lines.slice(start + 1, end).filter((l) => l && !l.startsWith('#'));

    const minLegs = Number(/--min-legs[ =](\d+)/.exec(lines[start])?.[1]);
    assert.ok(Number.isInteger(minLegs), `${name}: no --min-legs floor given to the runner`);
    assert.equal(
      legs.length,
      minLegs,
      `${name}: --min-legs is ${minLegs} but the recipe declares ${legs.length} legs — a floor ` +
        `below the leg count lets a leg vanish silently (#218)`,
    );

    const frozen = AGGREGATE_FLOORS[name];
    assert.ok(
      frozen !== undefined,
      `${name} aggregates but has no frozen floor in AGGREGATE_FLOORS — add one, or a leg can ` +
        `be dropped from it by editing --min-legs on the same line`,
    );
    assert.ok(
      legs.length >= frozen,
      `${name} declares only ${legs.length} legs; the frozen floor is ${frozen}. A gate has been ` +
        `removed. Do NOT lower this constant to go green.`,
    );
    // ...and EXACTLY, not merely at least (#316). A floor allowed to sit BELOW the leg count is
    // slack, and slack is how both #316 staleness bugs happened: `check-invariants` and
    // `check-guards` each gained a controls leg and neither frozen floor moved, leaving two legs
    // of play in which a leg could be deleted and `--min-legs` lowered on the same line with
    // every assertion here still satisfied. Nothing objected, because nothing asked. Requiring
    // equality is what makes adding OR removing a leg cost a second, visible line in a
    // SEPARATELY PINNED file — the justfile cannot be edited into agreement with itself.
    assert.equal(
      frozen,
      legs.length,
      `${name}: the frozen floor is ${frozen} but the recipe declares ${legs.length} legs. ` +
        `A floor below the leg count is slack a leg can vanish into. RAISE the floor with the ` +
        `set it guards (derived-guards.md §5 names lowering one to fit as the anti-pattern); ` +
        `if a leg was deliberately removed, that removal needs its own justification, not a ` +
        `smaller number here.`,
    );

    const names = legs.map((l) => l.split(/\s+/)[0]);
    assert.equal(new Set(names).size, names.length, `${name}: duplicate leg names ${names.join(', ')}`);
  }
});

// ── TEST-21 ─────────────────────────────────────────────────────────────────────────
/**
 * WHY THIS EXISTS, AND WHY IT IS A HASH RATHER THAN ANOTHER PREDICATE.
 *
 * Three blind audit rounds defeated three generations of checks over this recipe, and the
 * pattern was identical every time: a predicate that pattern-matches a SEMANTIC property
 * ("this leg really runs its gate") has an unbounded evasion space, so each round only
 * found the next spelling — ` || true` on a leg, a leg pointed at a decoy recipe whose
 * name PREFIX-matches the real one (`just check-pyx`), the controls leg repointed at an
 * empty test file, a nested aggregate's sub-legs replaced by `true`. Every one of them
 * keeps the leg count exact and the recorded argv plausible.
 *
 * The repo already answers this question, in `scripts/check-guard-integrity.sh`: the
 * property is not "a guard cannot be weakened", it is "a guard cannot be weakened
 * SILENTLY". Its answer is a committed hash. This is that answer applied to the surface
 * that decides WHICH GATES `just check` RUNS.
 *
 * Two things are frozen:
 *   1. the SET of recipes reachable from `check` — so a decoy recipe substituted for a
 *      real one changes the set and reddens, however plausibly it is named;
 *   2. the BYTES of every AGGREGATING recipe (comments and blank lines excluded, so prose
 *      edits do not churn the pin) — so any change to any leg reddens.
 *
 * EVERY reachable recipe body is pinned, not only the aggregating ones. Restricting it to
 * aggregates left a hole a blind round walked straight through: rewriting `check-coercion`
 * into a `set -euo pipefail` shebang running three scripts NOT named `check-*` restored
 * abort-on-first-failure and scored zero on every predicate. The predicates below remain as
 * a readable diagnosis of WHAT changed; the pin is what makes the change impossible to miss.
 *
 * TO CHANGE A GATE — which is a normal thing to do — update the constant this test prints,
 * then re-pin this file with `scripts/check-guard-integrity.sh --update`. That is two
 * visible lines in the diff, next to the change that needed them. That is the entire point.
 */
// strip node (ITEM-2): the five single-cell recipe rows are gone with their subjects.
const REACHABLE_FROM_CHECK = [
  "check",
  "check-domain",
  "check-guards",
  "check-invariants"
];

/**
 * ── RE-PIN LEDGER ───────────────────────────────────────────────────────────────────────
 *
 * WHAT THIS IS, AND — SAID FIRST, BECAUSE THREE DRAFTS GOT IT WRONG — WHAT IT IS NOT.
 *
 * Updating a byte-pin so it matches a body that moved is exactly how a weakened gate would be
 * laundered into main. This block exists so that no pin can move WITHOUT THE REVIEWER BEING
 * SHOWN A CLAIM ABOUT WHY. That is the whole of it. It does not, and cannot, establish that
 * the claim is TRUE.
 *
 * Three successive versions of this ledger tried to make the claim machine-verifiable — first
 * "a real commit is cited", then "a real commit that touched the justfile", then "a real commit
 * that moved THIS recipe's body, plus a +body/+stale marker". Blind rounds walked through all
 * three, the last one ten different ways, each time with a genuinely neutered gate and a green
 * tree: `moved <sha> +body` is satisfied forever by ANY historical body-move commit for that
 * recipe, so the citation never has to have anything to do with the change in front of the
 * reviewer. That predicate is deleted rather than sharpened. A hand-written check that
 * pattern-matches a SEMANTIC property has an unbounded evasion space — which is the reason
 * TEST-21 below is a HASH and not a predicate, and the same reasoning applies one level up.
 *
 * SO THE HONEST SPLIT IS:
 *   MACHINE  every pin has exactly one row, carrying that pin's CURRENT value. A pin cannot
 *            move without this block moving in the same diff. (TEST-10, needs no git.)
 *            Cited commits exist and touched the justfile. (TEST-16, needs history.)
 *            Neither of those can be satisfied by editing the pin alone, which is the property
 *            that was actually wanted.
 *   HUMAN    whether the move was EARNED. #316 said so explicitly — "I want an angle that did
 *            not write the fix asking whether each re-pin was earned" — and that is what
 *            happened: two independent blind angles re-derived every recipe hash across every
 *            commit that touched the justfile and confirmed both moves below are
 *            strengthenings. The prose under each row is what they read. A reviewer who cannot
 *            check a row from the prose plus `git show` should refuse the pin.
 *
 * GRAMMAR (parsed, and ONLY between the two TABLE markers below — a row hidden in this prose
 * is not a row, and a table region containing any non-ASCII character is refused, because a
 * zero-width space once made the visible row and the effective row different things):
 *
 *     <pin>  <its FULL current value>  <sha>…  |  THIS-CHANGE
 *
 * The FULL hash, not a prefix: an 8-hex prefix leaves a pin change that preserves it
 * unremarked, and this test's own derived control found that before a reviewer had to.
 *
 *   <sha>…       the commit(s) that moved this recipe's body. Checked to EXIST and to touch
 *                the justfile; NOT checked to explain this pin — see above.
 *   THIS-CHANGE  this change sets the value, so no earlier commit can carry it. A declaration
 *                for the reviewer, verified as nothing more than that.
 *
 * ─── TABLE ───
 * check                      a872f993c562dd039df073336ba1a8d363dc2ebf3ff63731a873c9571026506e  THIS-CHANGE
 * check-domain               bbb462d17850d2f630f4b1e3f267e008b02d540d33c62d18370c6ca1f40c2ab4  8020d711dbfb0631a4f77dc62fb3d634374e9f65 THIS-CHANGE
 * check-guards               d2b4d79bf4a8bab42e736fef9559a9081ce6f9628903e992e01d82116585edee  THIS-CHANGE
 * check-invariants           b5b00cf8712642df67f14ad80b85a2be3bcec72c79fd4dc3a64860c5ea5389f2  5f356c5e THIS-CHANGE
 * __directives__             154eafad031d58f2879e721e70a0e2b4f1aebee40a7ae78b112d028365256cbb  5f356c5e THIS-CHANGE
 * ─── END TABLE ───
 *
 * ── APP-REPO RE-ANCHOR (ITEM-27, citations only) ─────────────────────────────────────────
 * The cited commits above were original upsteam-txresbench shas (a9bc4c1c, cce0282e,
 * 051c09a1, 0bc9063e) that moved these recipe bodies in the UPSTREAM repo. The app repo
 * squashed that history at its baseline copy `8020d71` ("baseline: unchanged copy of
 * txresbench") — no upstream sha exists here, so TEST-16's existence check reddened on
 * every row. The PIN VALUES did not move (TEST-10/TEST-21 still hold: the bytes of every
 * pinned recipe are unchanged since the baseline; the only later justfile commit —
 * e38a55d, the strip — touched NO pinned recipe body). The citations are therefore
 * re-pointed at `8020d71`, the commit that moved EVERY pinned recipe body into this
 * repository, marked THIS-CHANGE because no earlier commit in this repo can carry the
 * value. The upstream provenance of the values (a9bc4c1c, 051c09a1/0bc9063e, cce0282e)
 * stays in the prose below, readable for a reviewer who wants the historical story; the
 * machine checks above now hold in this repo.
 *
 * ── APP-REPO CHECK-GUARDS MOVE (ITEM-4, method-env-images) ───────────────────────────────
 * `check-guards` moved AGAIN in this repository: the pin above is
 * 310717a1..., not 4493b447..., and the row cites both commits that moved its
 * body — eaf2a71 (this repository's ITEM-4 move) and 8020d71 (the baseline
 * import, which the APP-REPO RE-ANCHOR note above explains replaces the
 * upstream shas). The change: ITEM-4 ADDS `check-method-env-images-controls
 * node --test scripts/check-method-env-images.test.mjs` in front of
 * `check-method-env-images bash scripts/check-method-env-images.sh` (the
 * negative-control suite first, the committed env-manifest structural guard
 * second — the controls-in-front-of-guard order every other pair here uses)
 * and raises `--min-legs` 7 -> 9 with them. Nothing removed, no leg repointed,
 * no floor lowered; both legs point at files pinned in scripts/guard-hashes.txt
 * (34 pins), and AGGREGATE_FLOORS moves 7 -> 9 in this same diff, so the recipe
 * cannot be edited into agreement with itself. STRENGTHENING. Establish it
 * yourself: `git show eaf2a71 -- justfile` is one recipe.
 *
 * ── APP-REPO CHECK-GUARDS MOVE (PR 4a, the method list) ──────────────────────────────────
 * `check-guards` moved again: 7cbe21a4... -> d2b4d79b.... The change ADDS
 * `check-method-list-controls node --test scripts/check-method-list.test.mjs` in front of
 * `check-method-list bash scripts/check-method-list.sh` (controls first, the same order as
 * the method-env-images pair), after that pair and before `check-no-format-crates`, and
 * raises `--min-legs` 4 -> 6 with them. Nothing removed, no leg repointed, no floor lowered;
 * both legs point at files pinned in scripts/guard-hashes.txt (MIN_GUARDS 17 -> 19), and
 * AGGREGATE_FLOORS moves 4 -> 6 in this same diff. STRENGTHENING. Establish it yourself:
 * the only justfile hunk of this change is inside `check-guards`.
 *
 * ── STRIP NODE ITEM-2 (the single-cell legs are REMOVED with their subjects) ────────────────
 * `check`, `check-invariants` and `check-guards` each lost their single-cell legs in the
 * same diff that deletes the units the legs verified:
 *   - `check-py`, `check-packages`, `check-coercion`, `check-processor-versions` and
 *     `check-r-regime` are DELETED (not repointed, not neutered): their subjects — the
 *     processor package tree, the env recipe tree + pins, the coercion corpus, the
 *     processor manifest guards — are removed by the node's plan (ITEM-2); the recipe
 *     rows leave `RECIPE_PINS` with them.
 *   - `check-invariants` loses `check-kinds-zero-core`, `check-no-legacy-wire` and the
 *     `check-design-citations` pair (their subjects: processor kind/vocabulary guards,
 *     the workstore wire guard, the design-citations guard whose subject docs mostly
 *     went); `--min-legs` 9 -> 5.
 *   - `check-guards` loses the `check-recipe-pins` pair, the `check-derived-vocabulary`
 *     pair and `check-env-loop --fast` (env-recipe pins + processor vocabulary); it
 *     keeps the integrity, method-env-images and no-format-crates legs; `--min-legs`
 *     9 -> 4.
 *   - `check` loses all five of its now-deleted recipe legs; `--min-legs` 10 -> 5.
 * The removed gates' own controls are deleted with them (a control over a deleted gate is
 * a green no-op). All four floor constants move in this same diff, and the removal is the
 * node's plan — this is not the "lower the floor to fit a red" the §5 prose refuses; it
 * is the gate set shrinking because the checked units were deleted by an owner-approved
 * plan (`.lifecycle/txresbench-app/strip-single-cell/PLAN.md` ITEM-2, STRIP-MAP.md §5/§6/
 * §9/§10). `check-domain` is the one row that did not move.
 *
 * ── WHY THE TWO MOVED ROWS SAY WHAT THEY SAY (the part a reviewer judges) ────────────────
 *
 * check-invariants  a20e9556 -> 104c0ae2   (#316 filed this half as "nobody knows what changed")
 *   051c09a1  ADDS `check-pub-orphans-controls node --test scripts/check-pub-orphans.test.mjs`
 *             immediately in front of the guard it controls, and raises `--min-legs` 6 -> 7
 *             with it. Nothing removed, no leg repointed, no floor lowered. The leg points at
 *             a 451-line, 4-test suite that is itself pinned in `scripts/guard-hashes.txt`,
 *             so it is not a decoy. STRENGTHENING.
 *   0bc9063e  DECLARES that leg to the runner as `--controls-leg check-pub-orphans-controls`,
 *             so a run whose controls fail now prints the "every other result above is
 *             unverified" banner over the other legs. Strictly more enforcement.
 *             STRENGTHENING.
 *   The recipe needs no repair, so the pin moves and the body does not. Establish it yourself:
 *   `git show 051c09a1 -- justfile` and `git show 0bc9063e -- justfile` are 28 and 24 lines.
 *
 * check-invariants  104c0ae2 -> aaec696e   (#355, THIS CHANGE)
 *   #355      ADDS the design-citations guard's controls immediately in front of
 *             the guard itself, and raises
 *             `--min-legs` 7 -> 9 with them. Nothing removed, no leg repointed, no floor
 *             lowered; both legs point at files pinned in `scripts/guard-hashes.txt`, so
 *             neither is a decoy. The guard fails when a design or research doc path cited
 *             anywhere in the tree is not on disk — #315, which nothing caught for months.
 *             STRENGTHENING. Establish it yourself: the only justfile hunk in this
 *             change is inside `check-invariants`, and `git diff -- justfile` is that hunk.
 *
 * check-guards      15fb39a2 -> 4493b447   (TWO reasons, do not expect one)
 *   cce0282e  ADDS the derived-vocabulary guard's controls in front of the guard it
 *             controls and
 *             raises `--min-legs` 4 -> 5. Merged to main as 6fd17559 WITHOUT this pin moving,
 *             which is the red #316 was filed on. STRENGTHENING.
 *   #316      ADDS `check-recipe-pins-controls` + `check-recipe-pins` and raises `--min-legs`
 *             5 -> 7. The intermediate value `8fff1bbe` (cce0282e's body) never ships.
 *
 * check-processor-versions  b13e91e1 -> d7d82a9f   (#300, THIS CHANGE)
 *   THIS-CHANGE  the recipe was ONE LINE running `check-processor-seed-versions.sh`. It becomes
 *             a three-leg aggregate: that same guard UNCHANGED and still FIRST, then
 *             `check-manifest-version-claims.test.mjs` as a declared `--controls-leg`, then
 *             `check-manifest-version-claims.sh`. Nothing is removed, no leg is repointed, no
 *             floor is lowered, and the pre-existing leg's command text is semantically
 *             identical to what it was — the added leg-name prefix and double quotes around
 *             the script path are a strengthening, not a change of meaning. `--min-legs 3`
 *             is declared and frozen in
 *             AGGREGATE_FLOORS in this same diff.
 *             WHY AN AGGREGATE AND NOT A SECOND LINE: `just` aborts a recipe on the first
 *             non-zero line, and the two guards' failure populations are NOT the same branch —
 *             the sibling's failures are overlapping, neither contained in the other: it reddens on a missing bump, a
 *             downgrade, or a missing top-level `version:`, while the claims guard DEFERS only
 *             on the no-bump case (its "skip ... that is check-processor-seed-versions.sh's
 *             failure" line, asserted by TEST-4e) and reddens instead on a collision or a
 *             stale base. A downgrade or a missing `version:` reddens BOTH guards on the same
 *             package — the overlap is real, and it is exactly why a second line would be
 *             unreachable: the sibling can redden on X while the claims guard should redden
 *             on Y on the same branch. Every leg must run, and `--min-legs 3` is the floor.
 *             STRENGTHENING.
 *             Establish it yourself: `git show <this commit> -- justfile` is one recipe.
 *
 * ── CHECK MOVES AGAIN (gate-tests phase 1, THIS-CHANGE) ────────────────────────────────
 * `check` 555f7ffb -> 9c09d395: the recipe's single opaque `ui-npm-check` leg
 * (`cd src-app/ui && npm run check`) is replaced by seven `ui-*` legs, one per link of
 * the `check` chain (or per guard family): `ui-tsc`
 * (`npx --no-install tsc --noEmit`),
 * `ui-typecheck-tests`, `ui-guards-actions` (collect-actions + action-refs-lint +
 * action-coverage, one family), `ui-guards-lint` (the four lint scripts, one family),
 * `ui-e2e-routing`, `ui-rename-mechanical` and `ui-unit`. `--min-legs` rises 5 -> 11
 * with them, and AGGREGATE_FLOORS / MIN_LEGS_FLOOR move to 11 in this same diff, so
 * the recipe cannot be edited into agreement with itself. Nothing removed, no leg
 * repointed, no floor lowered; `npm run check` is unchanged in package.json (the
 * developer's one-shot command), and the new TEST-25 asserts the chain and the legs
 * are in parity so a link added to one and not the other reddens here. STRENGTHENING:
 * the chain's red first link (`check:e2e-routing`) no longer hides `test:unit`.
 *
 * ── CHECK MOVES AGAIN AGAIN (gate-tests phase 1 fix — the `ui-tsc` leg) ────────────────
 * `check` 9c09d395 -> b781c463: the `ui-tsc` leg is `npx --no-install tsc --noEmit`
 * instead of bare `tsc --noEmit`. `tsc` is on PATH only inside `npm run`
 * (node_modules/.bin), so the leg as written could not work — a plain shell leg says
 * "tsc: command not found". `npx --no-install` resolves the installed `tsc` from
 * node_modules/.bin without fetching anything (it refuses to install a missing package),
 * on the same npm version resolution the `npm run` chain uses. The gate is the SAME
 * `tsc --noEmit` typecheck — the invocation is repaired, not weakened: TEST-25
 * normalises a leading `npx --no-install ` to the bare link text so parity holds against
 * the unchanged package.json link `tsc --noEmit`, and the frozen case table pins the
 * leg's recorded command as `npx --no-install tsc --noEmit` (TEST-17/18/19 fail it by
 * exact string, so the leg cannot drop back to a form that cannot run). FIX.
 *
 * ── CHECK MOVES AGAIN AGAIN AGAIN (gate-tests phase 2, THIS-CHANGE) ────────────────────
 * `check` b781c463 -> 8d6a84f4: TWO crate-test legs are ADDED to the end of the Rust
 * group (after `cargo-check-workspace`): `sdk-crates-test` and `desktop-crate-test`,
 * the two things phase 1's `cargo check --workspace --tests` covered only by compiling
 * (AUDIT A1/D4/C2 — no leg RAN the SDK crates' own tests or the desktop crate's tests).
 * `--min-legs` rises 11 -> 13 with them, and AGGREGATE_FLOORS / MIN_LEGS_FLOOR move to
 * 13 in this same diff. Nothing removed, no leg repointed, no floor lowered.
 * `desktop-crate-test` is the brief's literal `cargo test -p txresbench-desktop` — it
 * links (GTK/WebKit present) and its 103 tests pass, so no adjustment. `sdk-crates-test`
 * is ADJUSTED from the literal `cd sdk && cargo test --workspace` because the default-
 * feature SDK workspace cannot even resolve in this gate image, and the adjustment is
 * FLATTERING, not weakening:
 *   * `--no-default-features --features "sqlite-backend,routes,module"` — the SDK crates
 *     default to the Postgres/embedded-pg driver, whose schema-bound `query!` macros
 *     verify against a live build-time Postgres cluster (docker-compose, 127.0.0.1:54321)
 *     absent from the gate image; the committed sdk/Cargo.lock pins postgresql_embedded
 *     0.20.4 (drag in sqlx 0.9, rust-version >= 1.94) while the image has rustc 1.90, so
 *     `cargo test --workspace` fails at RESOLUTION before any crate builds. The leg tests
 *     the SQLite driver variant — the same crate surfaces (routes + module stay on) with
 *     the driver the app itself consumes — and every test of every member still runs.
 *   * `--exclude sandbox-guest-agent --exclude sandbox-seccomp` — their TEST BINARIES
 *     link `-lseccomp`; the gate image ships only `libseccomp2`, no `libseccomp-dev`
 *     (measured: `rust-lld: unable to find library -lseccomp`). The repo's own runner for
 *     these two is sdk/scripts/test-guest-agent-linux.sh (Docker, pinned rust:1.90 image,
 *     apk libseccomp-dev + bwrap + privilege for the WSL-mode e2e) — an explicitly
 *     separate, privileged lane, NOT part of `just check`; not a test hidden, a lane the
 *     gate image cannot provide.
 *   * `-- --test-threads=1` — the crate suites are not parallel-safe: txresbench-file's
 *     http_routes tests re-init a GLOBAL storage dir per test, so under the parallel
 *     default two tests 404 on each other's files (flaky; the same binary passes serially,
 *     measured). Serial runs every test deterministically — no test skipped, no assertion
 *     reduced; the race is reported, not papered over.
 * The leg is EXPECTED RED today on main, and that red is the point: it surfaces (a)
 * txresbench-framework `openapi::emit_ts::tests::generator_golden_fixture` — a
 * deterministic, feature-independent generator-vs-golden drift (generated 117 lines vs
 * golden 147) that NO leg ever ran, and (b) txresbench-test-harness tests/data_dir_reclaim.rs
 * — `fuse: device not found` (no /dev/fuse, unprivileged container; mksquashfs and
 * squashfuse ARE installed). Neither is excluded: per §5-adjacent discipline a pre-existing
 * red becomes a NAMED red leg, not an allowlist entry. (470 pass, 3 fail, 7 ignored,
 * measured on this gate image — 12 SDK members + the sdk/desktop/harness crate; details
 * in the justfile comment.) STRENGTHENING: the two crate-test populations the gate never
 * executed
 * are now legs, and the exclusions/features are frozen by exact string in EXPECTED_GATES
 * (TEST-17/18/19) so the leg cannot silently drop back to a form that cannot run.
 * (Same diff, control-suite repair: `runLegs` accepted a pre-existing `spawnSync bash
 * EPIPE` ~1 run in 6 — the runner bails on an out-of-range `--min-legs` before reading
 * stdin, so the input write races the child's exit. EPIPE-with-a-numeric-status is the
 * child's own verdict and is now accepted; no assertion weakened, only the noise
 * removed — measured 14/14 clean runs after, 1-in-6 before.)
 *
 * ── CHECK MOVES AGAIN AGAIN AGAIN AGAIN (gate-tests phase 3, THIS-CHANGE) ──────────
 * `check` 8d6a84f4 -> 09335a9a: THREE JS/TS legs are ADDED after `desktop-crate-test`:
 * `sdk-ts-test`, `gallery-guards` and `site-test` — committed test populations that NO
 * leg had ever run (the UI chain covers src-app/ui only; the sdk-crates-test leg covers
 * the Rust crates; the npm workspaces' node:test/vitest suites, the two gallery guards
 * and the site suite were unrun). `--min-legs` rises 13 -> 16 with them, and
 * AGGREGATE_FLOORS / MIN_LEGS_FLOOR move to 16 in this same diff. Nothing removed, no
 * leg repointed, no floor lowered.
 * `sdk-ts-test` is the brief's own shape (`npm test` per SDK package in one leg): the
 * five packages that declare a `test` script — @txresbench/framework, kit, gallery,
 * shell, config — spelled out as `--workspace=` names from the repo root, because
 * `npm test --workspaces --if-present` would also sweep src-app/ui and any future
 * `test` script. npm runs EVERY named workspace even when one fails (it collects the
 * failures and exits non-zero; measured), so a red package cannot hide the ones after
 * it — the same no-hiding property the aggregate itself has. notification-ui and
 * test-e2e declare no test/typecheck script (test-e2e's only script is `validate`;
 * notification-ui has none) and get no leg — stated in the justfile comment.
 * `gallery-guards` runs the two pinned gallery guards from the app's ui/ cwd. The
 * prod-exclusion guard invokes its own `--build` (clean dist + `npm run build` via
 * gallery.config.json's buildCmd, then scan) — the leg depends on NOTHING outside
 * itself, because the aggregate's legs are independent and ui-npm-build cannot be
 * relied on to have run first. To make that scan meaningful, this change also pins
 * `distDir: 'dist'` and `buildCmd: 'npm run build'` in src-app/ui/gallery.config.json:
 * this app's vite outDir is `src-app/ui/dist` (vite.config.ts `outDir: '../dist'`),
 * which differs from the generic guard default `../../dist/ui` (the historical
 * txresbench layout), and `npm run build:nocheck` does not exist here — without those
 * two keys the guard would scan a directory this tree never emits (a false red) or
 * fail at the default build command. The guard bytes themselves are untouched and
 * still pinned. `check-harness-parity.mjs` exits 0 "nothing to check" here: the app
 * declares no `harnessCopies` (the unified harness lives in the package itself; a
 * standalone-consumer state the guard's design allows) — the guard still RUNS, its
 * verdict is simply vacuous for this consumer, which is the reason the app's own
 * README says parity is true by construction. The parity guard's own engine test
 * (`check-harness-parity.test.mjs`, which proves the guard FIRES when a copy loses a
 * core — the part that actually carries weight) runs as the third link of this same
 * leg, and again inside the gallery package's `test` via `sdk-ts-test`; the consumer
 * acceptance case named by that test's header (src-app/ui/scripts/check-harness-parity
 * .consumer.test.mjs) does not exist in this repo and was not created. The gallery PLAYWRIGHT e2e
 * (`test:e2e:gallery`) is NOT wired: it needs a browser and the gate image ships no
 * Playwright browsers (verified: no ~/.cache/ms-playwright, no installed playwright
 * package) — recorded in the justfile comment, not a hidden test (the ui e2e legs were
 * never in this gate either).
 * `site-test` is the site suite's own runner (`node --test site/tests/*.test.mjs` from
 * the repo root; the suite has no package.json — it is plain node:test on builtins and
 * the README names that as its gate). It is EXPECTED RED on main and the red is the
 * POINT of adding it: site/tests/deploy.test.mjs "TEST-18 the node's diff surface …"
 * requires the current round's diff (working tree vs HEAD, or the last commit when the
 * tree is clean) to touch only that node's file list (site/, the build script, the
 * parked workflow, its ledger, .gitignore) — and the gate-tests phase diffs themselves
 * touch docs/justfile/scripts, so the rule reddens on this phase's own subject;
 * site/tests/build.test.mjs "TEST-16 the suite is self-contained and green" re-runs the
 * suite and inherits that red. Neither is fixed by editing the suite (it enforces an
 * item-node boundary that the gate-tests phases live outside of; a fix belongs to the
 * lead's review, and the brief says: if the suite fails, keep the leg red, do not
 * skip). No test is removed, skipped or baselined — the reds are NAMED in the leg.
 * (Same diff, wiring: src-app/ui/gallery.config.json gains distDir + buildCmd — see
 * the gallery-guards bullet above; count remains 36 in guard-hashes.txt because no
 * pinned guard's bytes changed, only scripts/check-aggregate.test.mjs re-pinned.)
 * STRENGTHENING: three previously-unrun committed suites now run, the two gallery
 * guards finally have a caller, and the new leg commands are frozen by exact string in
 * EXPECTED_GATES (TEST-17/18/19) so they cannot silently drop back to a weaker form.
 *
 * ── CHECK MOVES AGAIN AGAIN AGAIN AGAIN AGAIN (gate-tests phase 4, THIS-CHANGE) ────
 * `check` 09335a9a -> a872f993: TWO legs are ADDED after `site-test`:
 * `scripts-node-tests` and `scripts-py-tests` — the committed scripts/ test suites that
 * NO leg had ever run (the five top-level control suites and the docker WSL-rootfs
 * suite are the only .mjs suites handled elsewhere; EVERYTHING else — 7 top-level
 * suites, the installer node's 6, and all 6 *.test.py — was run by nothing, AUDIT
 * B4/D17). `--min-legs` rises 16 -> 18 with them, and AGGREGATE_FLOORS /
 * MIN_LEGS_FLOOR move to 18 in this same diff. Nothing removed, no leg repointed, no
 * floor lowered.
 * `scripts-node-tests` is `find scripts -name '*.test.mjs'` at run time (piped through
 * `sort` for a deterministic order), one `node --test <file>` subprocess per suite
 * (a suite that crashes or fails cannot make the files after it unrun), with an
 * exclusion list naming only what another leg already runs — check-aggregate.test.mjs
 * (check-aggregate-controls, first leg of this recipe), check-method-env-images.test.mjs
 * + check-method-list.test.mjs (check-method-*-controls in `check-guards`),
 * check-network-allowlist.test.mjs + check-pub-orphans.test.mjs (the controls in
 * `check-invariants`) — plus build-wsl-rootfs.docker.test.mjs, the docker builds suite
 * (linux/amd64 + arm64, network, minutes; its own header self-skips unless
 * TXR_WSL_ROOTFS_DOCKER_TEST=1, and the gate image ships no docker), for which the leg
 * prints `SKIPPED build-wsl-rootfs.docker.test.mjs: needs docker` — the only exclusion
 * without a runner, and never silent. A new *.test.mjs that lands next month is picked
 * up with NO justfile edit (the self-growing scope the farm rules demand); the new
 * TEST-26 asserts over the filesystem that every scripts/ *.test.mjs and *.test.py is
 * covered by one of the two legs' globs or named in an exclusion whose claim is
 * provable — so a new orphan suite, or an exclusion entry no leg runs, turns the gate
 * red. `scripts-py-tests` runs the six stdlib-unittest files (scripts/demo + the
 * dev-registry quartet) with `python3 -I` (each loads its module under test by explicit
 * sys.path.insert/importlib.util, so isolated mode's sys.path is not a problem) and
 * TMPDIR at a per-run dir under $HOME — never /tmp, never the repo. The `python3` stub
 * joined the behavioural stubs (TEST-17/18/19) in this same diff for the same reason
 * npm/cargo are stubbed, so the real (red, path-bound) python leg is never executed
 * four dozen times inside the controls. REDS, NAMED, NOT FIXED (a red is listed, never
 * skipped): scripts/demo/e2e_demo.test.py — a route-surface assertion (133 vs 130
 * policy rows) plus 6 errors on the absent /data/pbya work dir; scripts/demo/
 * record_demo_bundle.test.py — 3 errors on the absent /data/pbya work dir;
 * scripts/dev-registry/e2e_real.test.py — module error: makedirs /data/pbya is
 * PermissionError (absent, root-owned); scripts/dev-registry/publish.test.py — 1 error
 * on the absent /data/share/pbya/sigtrans/methods/... real-method tree (11 pass, 1
 * skipped); scripts/build-wsl-rootfs.test.mjs — 1 pre-existing failure (the test's
 * expected tauri.conf.json object lacks the windows.nsis keys the installers node added
 * to the real config; 31 pass); scripts/installer/surface.test.mjs — 2 pre-existing
 * failures (TEST-IR-13: the diff vs the installers node base touches src-app/ui paths
 * committed after that base; ITEM-6: release.yml's step order no longer matches the
 * test's expectations). registry.test.py, make_real_inputs.test.py (1 self-skip: no
 * benchmark tree) and the other ten node suites pass. STRENGTHENING: nineteen committed
 * suites no leg executed are now legs, the two newly-run legs are frozen by exact string
 * in EXPECTED_GATES (TEST-17/18/19), the coverage claim has its own test (TEST-26), and
 * `python3 -I` + TMPDIR isolate the python leg from the ambient environment.
 *
 * ── THE ANCHOR IS a9bc4c1c, NOT 2caaa6e9 ────────────────────────────────────────────────
 *
 * Stated exactly, because the first draft of this block said "unmoved since the pins were
 * introduced at 2caaa6e9" and a blind auditor following that pointer found TEN mismatches and
 * no explanation — the opposite of what a ledger is for. 2caaa6e9 (#287) introduced the
 * constant; a9bc4c1c (#287 R5) then changed the NORMALISER (the shebang, the parameter list and
 * the top-level directives joined the hash) and added `__directives__`, so every value in this
 * object moved there for a reason that has nothing to do with any recipe. `check-r-regime`'s
 * BODY genuinely moved at a9bc4c1c too — a bare `-eq 0` suite check became
 * `-lt {{R_REGIME_SUITE_FLOOR}}`. Since a9bc4c1c exactly four recipes have moved: `check-guards`
 * once, `check-invariants` twice, `check-processor-versions` once and `check` five
 * times (gate-tests phase 1, its phase-1 `ui-tsc` leg fix, the phase-2 crate-test
 * legs, the phase-3 JS/TS legs, and the phase-4 scripts/ suites — the five blocks
 * above) — the
 * rows above.
 */
const RECIPE_PINS = {
  "check": "a872f993c562dd039df073336ba1a8d363dc2ebf3ff63731a873c9571026506e",
  "check-domain": "bbb462d17850d2f630f4b1e3f267e008b02d540d33c62d18370c6ca1f40c2ab4",
  "check-guards": "d2b4d79bf4a8bab42e736fef9559a9081ce6f9628903e992e01d82116585edee",
  "check-invariants": "b5b00cf8712642df67f14ad80b85a2be3bcec72c79fd4dc3a64860c5ea5389f2",
  "__directives__": "154eafad031d58f2879e721e70a0e2b4f1aebee40a7ae78b112d028365256cbb"
};

test('TEST-21 the gate-defining recipes are byte-pinned, so no gate can be neutered silently', () => {
  const recipes = allRecipes();

  // (1) the reachable SET — a decoy recipe standing in for a real gate changes it.
  const seen = new Set();
  const queue = ['check'];
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const rec = recipes.get(name);
    if (!rec) continue;
    for (const d of rec.deps) queue.push(d);
    for (const line of rec.body) {
      if (line.trim().startsWith('#')) continue;
      for (const m of line.matchAll(/(?<![\w-])just\s+([\w-]+)/g)) queue.push(m[1]);
    }
  }
  const reachable = [...seen].sort();

  // (2) the aggregating recipes' BYTES.
  // Comments are excluded so prose edits do not churn the pin — but a `#!` line is NOT a
  // comment, it is the SHEBANG that selects the interpreter for the whole recipe. Dropping
  // it let `#!/usr/bin/env bash` become `#!/bin/true`, turning a recipe into a no-op that
  // exits 0 with every test green. Parameters and dependencies are hashed for the same
  // reason: both change what the recipe runs.
  const normalise = (rec) =>
    [
      rec.header,
      rec.deps.join(' '),
      ...rec.body
        .map((l) => l.trim())
        .filter((l) => l && (!l.startsWith('#') || l.startsWith('#!'))),
    ].join('\n');
  const actual = {};
  for (const name of reachable) {
    const rec = recipes.get(name);
    if (!rec) continue;
    actual[name] = createHash('sha256').update(normalise(rec)).digest('hex');
  }
  // Every TOP-LEVEL directive — `set …`, `export …`, `alias …`, and every `name := …`,
  // wherever it appears — governs how the recipes execute, and none of it lives in a recipe
  // body. Unpinned, `set shell := ["bash","-c","true #"]` neutered every non-shebang gate,
  // `PY_TEST_FLOOR := "0"` made check-py's ~1900-test floor vacuous, `ui_dir` could be
  // repointed at a shim package.json, and `export PACKAGE_SUITES_BASE := "HEAD"` dropped
  // the submodule suites — all with every test green.
  //
  // Stated precisely, because the first draft of this comment overclaimed: only the
  // JUSTFILE spelling of the last one is closed. `check-package-suites.mjs` still reads
  // `process.env.PACKAGE_SUITES_BASE`, which no pin reaches, so the same drop remains
  // available with a one-word env prefix. That belongs to that gate (it is the same
  // `env -u PYTEST_ADDOPTS` discipline check-py already applies and it does not), and is
  // filed separately rather than claimed as fixed here.
  actual.__directives__ = createHash('sha256')
    .update(topLevelDirectives().join('\n'))
    .digest('hex');

  const expectedNames = Object.keys(RECIPE_PINS).sort();
  const actualNames = Object.keys(actual).sort();
  const report =
    `\n\nCurrent values, if this change is intended:\n` +
    `const REACHABLE_FROM_CHECK = ${JSON.stringify(reachable, null, 2)};\n` +
    `const RECIPE_PINS = ${JSON.stringify(actual, null, 2)};\n` +
    `Then re-pin this file: scripts/check-guard-integrity.sh --update`;

  assert.deepEqual(
    reachable,
    [...REACHABLE_FROM_CHECK].sort(),
    `the set of recipes \`just check\` reaches has changed. A gate has been added, removed, ` +
      `or replaced by a decoy (a recipe whose name merely PREFIX-matches a real gate passes ` +
      `every argv check).${report}`,
  );
  assert.deepEqual(
    actualNames,
    expectedNames,
    `the set of gate-defining recipes has changed.${report}`,
  );
  for (const name of expectedNames) {
    assert.equal(
      actual[name],
      RECIPE_PINS[name],
      `the \`${name}\` recipe's legs changed without its pin being updated. Every evasion ` +
        `three audit rounds found — a leg with \` || true\`, a leg pointed at a decoy recipe, ` +
        `the controls leg repointed at an empty file, a nested aggregate's sub-legs replaced ` +
        `by \`true\` — lands here, because this is bytes and not a predicate.${report}`,
    );
  }
});

// ── TEST-22 ─────────────────────────────────────────────────────────────────────────
test('TEST-22 the runner refuses a poisoned environment and strips it from every leg', () => {
  // `bash` sources $BASH_ENV before every non-interactive script — the recipe, this runner,
  // and each leg. An ambient BASH_ENV defining `node(){ exit 0; }` etc. made `just check`
  // print "PASS — 10/10 legs passed" having executed no gate at all, with every test green.
  // The repo already applies this discipline one level down (check-py's `env -u
  // PYTEST_ADDOPTS`); it belongs here too.
  const d = tmpdir('env');
  const poison = path.join(d, 'poison.sh');
  fs.writeFileSync(poison, 'true\n');

  const poisoned = spawnSync('bash', [RUNNER, '--label', 'poisoned'], {
    input: 'a true\n',
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, BASH_ENV: poison },
  });
  assert.equal(poisoned.status, 2, 'a run with BASH_ENV set must be refused, not silently accepted');
  assert.match(poisoned.stdout + poisoned.stderr, /refusing to run with \$BASH_ENV set/);

  // Refusing is deliberate over silently unsetting: if something set BASH_ENV, the operator
  // needs to know. And a leg must not see it even when the runner started clean.
  const marker = path.join(d, 'leg-saw-it');
  const clean = runLegs([`probe test -n "\${BASH_ENV:-}" && touch '${marker}'; true`]);
  assert.equal(clean.status, 0, 'sanity: a clean run must still pass');
  assert.ok(!fs.existsSync(marker), 'a leg inherited BASH_ENV — it must be stripped per leg');
});

// ── TEST-23 ─────────────────────────────────────────────────────────────────────────
function pinnedPaths() {
  return new Set(
    fs
      .readFileSync(path.join(SCRIPTS_DIR, 'guard-hashes.txt'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() && !l.trim().startsWith('#'))
      .map((l) => l.trim().split(/\s+/)[1]),
  );
}

test('TEST-23 the UI-side and gallery guards that `just check` relies on are byte-pinned', () => {
  // `check-guard-integrity.sh` pinned only `scripts/check-*` and `scripts/lib/*`, so
  // `action-coverage.mjs` lost nine tenths of its scope with no pin moving. If the globs are
  // narrowed again and `--update` is run, these pins vanish and this test reddens.
  const pins = pinnedPaths();
  const must = [
    'src-app/ui/scripts/action-coverage.mjs',
    'src-app/ui/scripts/action-refs-lint.mjs',
    'src-app/ui/scripts/collect-actions.mjs',
    'src-app/ui/scripts/guard-floors.test.mjs',
    'src-app/ui/scripts/check-built-css-urls.mjs',
    'src-app/ui/scripts/check-e2e-routing.mjs',
    'src-app/ui/scripts/check-rename-mechanical.mjs',
    'src-app/ui/scripts/lint-native-controls.mjs',
    'src-app/ui/scripts/lint-secret-input-caps.mjs',
    'src-app/ui/scripts/lint-text-source-bytes.mjs',
    'sdk/packages/gallery/scripts/check-gallery-prod-exclusion.mjs',
    'sdk/packages/gallery/scripts/check-harness-parity.mjs',
  ];
  for (const rel of must) {
    assert.ok(fs.existsSync(path.join(REPO, rel)), `${rel} no longer exists; update this list with the guard`);
    assert.ok(pins.has(rel), `${rel} is not pinned in scripts/guard-hashes.txt`);
  }
  // The one deliberate exception: ratcheted by its committed baseline instead.
  assert.ok(
    !pins.has('src-app/ui/scripts/lint-no-domain-in-builtin.mjs'),
    'lint-no-domain-in-builtin.mjs is the named exception and must stay out of the pin set',
  );
});

// ── TEST-24 ─────────────────────────────────────────────────────────────────────────
test('TEST-24 docs/aggregate-gate-reporting.md states the same floors as AGGREGATE_FLOORS', () => {
  // The doc is the reference for "what floor must not be lowered". A wrong number there
  // invites someone to lower the real one to match it (it said `check-guards` 4 while the
  // recipe had 6). The sentence is `(`check` N, `check-invariants` N, `check-guards` N)`.
  const doc = fs.readFileSync(path.join(REPO, 'docs/aggregate-gate-reporting.md'), 'utf8');
  const m = /\(`check` (\d+), `check-invariants` (\d+), `check-guards` (\d+)\)/.exec(doc);
  assert.ok(m, 'docs/aggregate-gate-reporting.md §4 no longer states the floors as "(`check` N, `check-invariants` N, `check-guards` N)"');
  const stated = { check: Number(m[1]), 'check-invariants': Number(m[2]), 'check-guards': Number(m[3]) };
  assert.deepEqual(
    stated,
    AGGREGATE_FLOORS,
    'the floors in docs/aggregate-gate-reporting.md §4 differ from AGGREGATE_FLOORS in this file; ' +
      'fix the DOC (never lower a floor to match a stale doc)',
  );
});

// ── TEST-25 ─────────────────────────────────────────────────────────────────────────
/**
 * The `npm run check` chain and the `just check` UI legs must stay in PARITY.
 *
 * The recipe no longer runs `npm run check` as one opaque leg: that is the #287 defect
 * one level down — the chain's red first link (`check:e2e-routing` is red on main) hid
 * every later link, including `test:unit`. The chain is split into per-link `ui-*` legs
 * (`ui-tsc`, `ui-typecheck-tests`, `ui-guards-actions`, `ui-guards-lint`,
 * `ui-e2e-routing`, `ui-rename-mechanical`, `ui-unit`), so a red link is a named red
 * leg and the legs after it still run.
 *
 * This test holds both sides to the same list. A link added to `src-app/ui/package.json`'s
 * `check` chain without a matching `ui-*` leg — or a `ui-*` leg whose command is not a
 * link of the chain — reddens here. Links are compared by THEIR OWN TEXT (`npm run X`
 * compares as `X`: the script's body command is irrelevant, only that the same script
 * name is wired on both sides; every other link, e.g. `node scripts/foo.mjs`, compares
 * verbatim, so a command changed in ONE place without the other is also a parity break).
 * `ui-npm-build` is excluded: the bundle build is a separate gate that has no place in
 * the `check` chain.
 *
 * The FAILING direction is demonstrated in `.dsh/parity-proof.txt` (gate-tests phase 1):
 * dropping one `ui-*` leg from the justfile turns this test red while the chain is
 * untouched.
 */
function uiChainLinks() {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'src-app/ui/package.json'), 'utf8'));
  const chain = pkg.scripts.check;
  assert.ok(chain, '`src-app/ui/package.json` no longer declares a `check` script');
  const links = chain.split('&&').map((l) => l.trim()).filter(Boolean);
  assert.ok(
    links.length >= 10,
    `the ui check chain has only ${links.length} link(s) — it must still be the full chain, ` +
      `not something an emptied parser would read as complete`,
  );
  return links;
}

/**
 * `npm run X` compares as `X`; a leg that invokes a binary through
 * `npx --no-install <cmd>` is treated as `<cmd>` itself (the SAME tool, resolved via
 * node_modules/.bin by npx — the leg fix for `tsc` being off the raw PATH). Every other
 * link compares as its own text.
 */
function uiLinkKey(link) {
  const m = /^npm run ([\w:.-]+)$/.exec(link);
  if (m) return m[1];
  return link.replace(/^npx --no-install /, '');
}

/** The `ui-*` legs of the `check:` recipe: leg name -> [normalised link(s) of its command]. */
function uiLegCommands() {
  const { legs } = legLinesOf(checkBlock());
  const out = new Map();
  for (const leg of legs) {
    const [name, ...rest] = leg.split(/\s+/);
    if (!name.startsWith('ui-')) continue;
    const cmd = rest.join(' ').trim();
    assert.ok(
      cmd.startsWith('cd {{ui_dir}} && '),
      `ui leg '${name}' does not begin with 'cd {{ui_dir}} && ' — a leg that does not run ` +
        `from the UI directory cannot be the link's own command`,
    );
    out.set(
      name,
      cmd.slice('cd {{ui_dir}} && '.length).split('&&').map((l) => l.trim()).filter(Boolean).map(uiLinkKey),
    );
  }
  return out;
}

test('TEST-25 every ui link of the `check` chain has a `just check` ui-* leg, and vice versa', () => {
  const chain = uiChainLinks().map(uiLinkKey);
  const legs = uiLegCommands();
  // The bundle build is a separate gate and is deliberately NOT part of the check chain.
  assert.ok(
    legs.has('ui-npm-build'),
    '`just check` must keep the `ui-npm-build` leg (its `npm run build` is not a `check`-chain link)',
  );
  const chainLegs = new Map(legs);
  chainLegs.delete('ui-npm-build');

  // Every declared linkage must have both sides: a chain link with no leg, and a leg
  // command that is not a chain link. These come FIRST so a dropped leg reddens with
  // the link named, not with a count message (`.dsh/parity-proof.txt`).
  const legLinks = new Map();
  for (const [name, keys] of chainLegs) for (const k of keys) legLinks.set(k, name);
  const uncovered = chain.filter((k) => !legLinks.has(k));
  assert.deepEqual(
    uncovered,
    [],
    `these link(s) of ui/package.json's \`check\` chain have no \`ui-*\` leg in the justfile ` +
      `(the chain: ${chain.join(' && ')}): ${uncovered.join(', ')}`,
  );
  const chainSet = new Set(chain);
  const stray = [];
  for (const [name, keys] of chainLegs) {
    for (const k of keys) if (!chainSet.has(k)) stray.push(`${name} -> ${k}`);
  }
  assert.deepEqual(
    stray,
    [],
    `these \`ui-*\` leg command(s) are not link(s) of ui/package.json's \`check\` chain: ` +
      `${stray.join(', ')}`,
  );
  // POSITIVE COUNT, last: a parser that extracted nothing is caught by the two assertions
  // above (every link is then "uncovered"), and this keeps the split from silently
  // re-collapsing into fewer legs while somehow staying in parity.
  assert.ok(
    chainLegs.size >= 7,
    `only ${chainLegs.size} ui-* chain leg(s) found — the split must be one leg per link ` +
      `or guard family, not a re-collapsed chain`,
  );
});

// ── TEST-26 ─────────────────────────────────────────────────────────────────────────
/**
 * The scripts/ test-suite legs (gate-tests phase 4) must actually cover every committed
 * test file under scripts/ — otherwise `just check` again answers about a subset of its
 * suites, which is the failure class this whole file exists to remove, one level up.
 *
 * `scripts-node-tests` discovers at run time (`find scripts -name '*.test.mjs'`) and
 * excludes an EXPLICIT list; `scripts-py-tests` discovers `*.test.py`. A test file that
 * no glob runs is an orphan suite the gate never executes. So this test derives the
 * ground truth from the FILESYSTEM — every scripts/ `*.test.mjs` and `*.test.py` on
 * disk (a `**` glob in prose would terminate this block comment; the pattern is spelled
 * as the legs spell it) —
 * and checks each file against the two legs' own commands as spelled in the `check:`
 * recipe (never against a second copy of the list, which is the tautology §4 warns
 * about):
 *
 *  - a file NOT in the exclusions is covered by the run-time glob (which is also why a
 *    NEW suite that lands is picked up with no justfile edit — that self-growing property
 *    is the member here, and the frozen cases are the exclusions' claims);
 *  - a file IN an exclusion list is legal only when its claim is provable from the
 *    justfile: another leg runs it by path (`node --test … scripts/<file>`), or — the one
 *    designed exception — it is build-wsl-rootfs.docker.test.mjs, for which the leg
 *    prints `SKIPPED build-wsl-rootfs.docker.test.mjs: needs docker` (the suite needs
 *    docker + network + minutes; its own header self-skips unless
 *    TXR_WSL_ROOTFS_DOCKER_TEST=1, so excluding it WITHOUT the printed line would be a
 *    silent skip — the precisely-named anti-pattern);
 *  - an exclusion name that matches NO file on disk is drift, not a skip: it excludes
 *    nothing and would leave the suite double-run or silently dropped;
 *  - the discover globs' exact patterns and the SKIPPED print remain spelled in the legs,
 *    so the discovery cannot be narrowed to a subset in a diff nobody reads.
 *
 * FLOOR. The suite set GROWS without a justfile edit by design (a new *.test.mjs that
 * lands is discovered automatically), so the floor here is a MINIMUM, not the exact
 * count: today 19 *.test.mjs + 6 *.test.py = 25 files. It moves UP with a deliberate
 * shrink, NEVER down to fit a red — the derived-guards §5 rule, applied to a set whose
 * growth is automatic and whose shrink therefore has to be argued for.
 */
test('TEST-26 every scripts/**/*.test.mjs and *.test.py is covered by the scripts-node-tests / scripts-py-tests globs or a named exclusion', () => {
  const { legs } = legLinesOf(checkBlock());
  const nodeLeg = legs.find((l) => l.startsWith('scripts-node-tests '));
  const pyLeg = legs.find((l) => l.startsWith('scripts-py-tests '));
  assert.ok(
    nodeLeg,
    '`just check` no longer declares the scripts-node-tests leg — the coverage claim ' +
      'this test exists to keep cannot be verified over a missing leg',
  );
  assert.ok(
    pyLeg,
    '`just check` no longer declares the scripts-py-tests leg — the coverage claim this ' +
      'test exists to keep cannot be verified over a missing leg',
  );
  const nodeCmd = nodeLeg.slice('scripts-node-tests '.length);
  const pyCmd = pyLeg.slice('scripts-py-tests '.length);

  // The discovery patterns are part of the contract, frozen by exact string: a narrowed
  // glob (a subset, a different suffix) drops suites with every other check still green.
  assert.match(
    nodeCmd,
    /find scripts -name '\*\.test\.mjs'/,
    `scripts-node-tests must discover with \`find scripts -name '*.test.mjs'\` — a narrower ` +
      `glob would silently drop suites: ${nodeCmd}`,
  );
  assert.match(
    pyCmd,
    /find scripts -name '\*\.test\.py'/,
    `scripts-py-tests must discover with \`find scripts -name '*.test.py'\` — a narrower ` +
      `glob would silently drop suites: ${pyCmd}`,
  );
  // The docker suite's exclusion must stay LOUD: without the printed line it is exactly
  // the silent skip (a suite whose own header self-skips) the leg exists to prevent.
  assert.match(
    nodeCmd,
    /SKIPPED build-wsl-rootfs\.docker\.test\.mjs: needs docker/,
    'scripts-node-tests must print `SKIPPED build-wsl-rootfs.docker.test.mjs: needs docker` ' +
      '— an exclusion with no printed reason is a silent skip',
  );

  const nodeExcluded = new Set([...nodeCmd.matchAll(/-not -name '([^']+)'/g)].map((m) => m[1]));
  const pyExcluded = new Set([...pyCmd.matchAll(/-not -name '([^']+)'/g)].map((m) => m[1]));

  // Every test file under scripts/, DERIVED — never a hand-list (a hand-list is a
  // snapshot of what existed the day someone typed it; this is the file system).
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.test.mjs') || e.name.endsWith('.test.py')) files.push(p);
    }
  };
  walk(path.join(REPO, 'scripts'));
  assert.ok(
    files.length >= 20,
    `only ${files.length} test file(s) found under scripts/ (25 today: 19 *.test.mjs + ` +
      `6 *.test.py) — the scan collapsed? Do NOT lower this floor to fit a red; a shrink ` +
      `of the suite set has to be argued for like any other guard removal`,
  );

  /**
   * "Another leg runs it": a non-comment recipe line that invokes `node --test` naming
   * the suite's path. The two new legs run files through `"$f"`, so they can never
   * satisfy this — an exclusion cannot be self-justifying.
   */
  const runnerOf = (base) => {
    const hits = [];
    for (const rec of allRecipes().values()) {
      for (const l of rec.body) {
        const t = l.trim();
        if (!t || t.startsWith('#')) continue;
        if (t.includes('node --test') && t.includes(`scripts/${base}`)) hits.push(t);
      }
    }
    return hits;
  };

  const problems = [];
  for (const p of files) {
    const rel = path.relative(REPO, p).split(path.sep).join('/');
    const base = path.basename(p);
    const py = rel.endsWith('.test.py');
    const excluded = (py ? pyExcluded : nodeExcluded).has(base);
    if (!excluded) continue;
    if (base === 'build-wsl-rootfs.docker.test.mjs') continue; // its SKIPPED line is asserted above
    if (runnerOf(base).length === 0) {
      problems.push(
        `${rel} is excluded from the ${py ? 'scripts-py' : 'scripts-node'}-tests leg's glob ` +
          `but NO other leg runs it — excluded-but-unrun is exactly the orphan suite this ` +
          `phase came to close. Let the glob run it (it is discovered automatically) or ` +
          `justify the exclusion beside the leg in the justfile`,
      );
    }
  }
  assert.deepEqual(
    problems,
    [],
    `script-suite coverage holes (a file only counts as covered when it is run):\n  ` +
      `${problems.join('\n  ')}`,
  );

  // The reverse drift: an exclusion that names no file on disk excludes nothing. It can
  // silently re-run a suite that is already a leg, or pretend to skip one that never
  // existed — both put the coverage claim in a diff nobody reads.
  for (const base of nodeExcluded) {
    assert.ok(
      files.some((p) => path.basename(p) === base),
      `scripts-node-tests excludes '${base}', which is not a *.test.mjs under scripts/ — ` +
        `an exclusion that names nothing is drift, not a skip`,
    );
  }
  for (const base of pyExcluded) {
    assert.ok(
      files.some((p) => path.basename(p) === base),
      `scripts-py-tests excludes '${base}', which is not a *.test.py under scripts/ — an ` +
        `exclusion that names nothing is drift, not a skip`,
    );
  }
});
