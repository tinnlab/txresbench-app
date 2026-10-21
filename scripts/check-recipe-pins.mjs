#!/usr/bin/env node
/**
 * check-recipe-pins.mjs — the gate-defining RECIPES are pinned, and that pin is verified
 * from inside `just check-guards` (#316).
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────
 * `scripts/check-guard-integrity.sh` pins the BYTES OF THE GUARD FILES. TEST-20/TEST-21 in
 * `scripts/check-aggregate.test.mjs` pin the BYTES OF THE RECIPES that decide which guards
 * run at all. Those are the same property one level apart — "a gate cannot be weakened
 * SILENTLY" — and until this file they were verified in two different places:
 *
 *   guard FILE bytes  → `check-guard-integrity`, a leg of `just check-guards`
 *   gate RECIPE bytes → `check-aggregate-controls`, a leg of `just check` ONLY
 *
 * Twice now a `justfile` recipe edit has reached main with its pin left behind (#316:
 * `check-invariants` at 051c09a1/0bc9063e, `check-guards` at cce0282e), and both times the
 * change was gated by running a GATE — `just check-guards` — rather than the test that pins
 * the gate. Running a gate is not the same as running the test that pins it, and the two
 * lived one recipe apart. This closes that distance: the recipe pin is now verified by the
 * same command that verifies the guard files, so a `justfile` edit reddens at the point of
 * the edit instead of at whoever next runs the full `just check`.
 *
 * ── WHY IT RE-INVOKES RATHER THAN RE-IMPLEMENTS ─────────────────────────────────
 * This file declares NO recipe name, NO hash and NO floor. It runs the EXISTING TEST-20 and
 * TEST-21 by name and requires them to have run and passed. A second copy of the pinned set
 * would be a second source of truth, and the drift direction that matters — the copy quietly
 * stops covering something — is silent. `docs/design/derived-guards.md` §2 is the rule; this
 * is it applied to the guard's own subject.
 *
 * ── THE VACUITY HOLE THIS IS BUILT AROUND (measured, node v24.8.0) ──────────────
 * `node --test --test-name-pattern=<pattern>` exits 0 and prints `# tests 1 / # pass 1` even
 * when the pattern matches NOTHING, because the FILE itself counts as a passing test:
 *
 *     $ node --test --test-reporter=tap --test-name-pattern='^TEST-99 ' <file>; echo $?
 *     TAP version 13
 *     1..0
 *     ok 1 - scripts/check-aggregate.test.mjs
 *     # tests 1
 *     # pass 1
 *     0
 *
 * So a guard that read the SUMMARY would report PASS the moment TEST-21 were renamed, moved
 * or deleted — the same "check that cannot fail" defect this repository has spent a week
 * removing. This guard therefore asserts on the per-subtest `ok N - TEST-<id>` lines, and
 * fails LOUDLY when a required subtest did not run. `scripts/check-recipe-pins.test.mjs`
 * pins that behaviour (TEST-6) so it cannot regress.
 *
 * ── USAGE ───────────────────────────────────────────────────────────────────────
 *   scripts/check-recipe-pins.mjs      # no arguments, and none are accepted
 *
 * Exit 0 = every required subtest ran and passed. 1 = drift (the child's full report is
 * printed, including TEST-21's "Current values, if this change is intended" block).
 * 2 = tooling/environment broken; the result is not a verdict.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(SCRIPTS_DIR, '..');

/**
 * The subject, as a named descriptor rather than inline literals.
 *
 * DELIBERATELY NOT configurable and NOT readable from the environment (DEC-8). An
 * overridable subject path or subtest list would reintroduce, one word wide, exactly the
 * "point the leg at an empty file" evasion TEST-21's own header records three audit rounds
 * finding. It is a struct so the set can be extended without a rewrite.
 */
const PINNED = {
  file: 'scripts/check-aggregate.test.mjs',
  /**
   * The justfile assertions this gate re-runs, pinned by their FULL NAMES.
   *
   * NAMES, NOT IDS, AND THAT DISTINCTION WAS BOUGHT. A blind round renamed the real TEST-13
   * to TEST-130, added `test('TEST-13 the gate manifest is present and non-empty', …)` in its
   * place, and every gate stayed green: the guard had verified that SOMETHING called TEST-13
   * ran. Pinning the sentence means a stand-in under a borrowed id is refused.
   *
   * THERE IS NO EXCLUSION LIST, DELIBERATELY. An earlier draft had one, gated by a
   * minimum-length check on the "reason" string, and the same round used it to shrink this
   * list back to two ids — the exact cut a previous round had proved insufficient — with a
   * 31-letter nonsense reason, while the coverage test CERTIFIED it. A hatch guarded by a
   * character count is a hatch. This list is fixed; TEST-13 in the controls suite refuses any
   * shrink of it.
   *
   * TEST-17/18/19 of that file also read the justfile — through the real `just` — and are NOT
   * here: they need `just` plus the whole scripts/ tree and cannot run over the synthetic
   * repositories the controls build. They are run by `check-aggregate-controls` under
   * `just check`. That is a real limit of this leg, stated rather than hidden behind a list.
   */
  subtests: {
    'TEST-8': 'TEST-8 the `check:` recipe routes every leg through the runner and can no longer abort',
    'TEST-12': 'TEST-12 the rewritten `check:` block still parses for its one existing text consumer',
    'TEST-13': 'TEST-13 no recipe reachable as a leg of `just check` can abort on its first failure',
    'TEST-20': 'TEST-20 every aggregating recipe declares a floor equal to its leg count and >= its frozen minimum',
    'TEST-21': 'TEST-21 the gate-defining recipes are byte-pinned, so no gate can be neutered silently',
  },
};
const PINNED_IDS = Object.keys(PINNED.subtests);

const fail = (code, msg) => { console.error(msg); process.exit(code); };

if (process.argv.length > 2) {
  fail(2, `usage: ${path.relative(REPO, fileURLToPath(import.meta.url))}   (no arguments)`);
}

// `node` reads NODE_OPTIONS before any user code and will happily `--require` a shim that
// redefines `assert`. That is the same ambient-environment hole `check-aggregate.sh` refuses
// for $BASH_ENV and `check-py` refuses for $PYTEST_ADDOPTS, arriving through a different
// variable. Refusing is deliberate over silently unsetting: if something set it, the operator
// needs to know.
if ((process.env.NODE_OPTIONS ?? '').trim() !== '') {
  fail(2, 'FAIL(2): refusing to run with $NODE_OPTIONS set — it can inject a --require shim ' +
          'into the child that verifies the pins. Unset it and re-run.');
}

const target = path.join(REPO, PINNED.file);
if (!fs.existsSync(target)) {
  fail(1, `FAIL: ${PINNED.file} does not exist. The recipe pins live in that file; without it ` +
         `nothing verifies which gates \`just check\` runs.`);
}

// One child, both subtests. `--test-name-pattern` is a JS regex anchored at the start of the
// subtest name, and is repeatable (the patterns are OR-ed).
const patterns = PINNED_IDS.map((id) => `--test-name-pattern=^${id} `);
const env = { ...process.env };
// A parent `node --test` exports NODE_TEST_CONTEXT so a child reports into ITS run. The
// controls suite spawns this guard from inside `node --test`, so leaving it set would make
// the child's reporter talk to the wrong runner and the TAP this parses never appear.
delete env.NODE_TEST_CONTEXT;
delete env.NODE_OPTIONS;

const r = spawnSync(
  process.execPath,
  ['--test', '--test-reporter=tap', ...patterns, target],
  { cwd: REPO, encoding: 'utf8', env },
);
if (r.error) fail(2, `FAIL(2): could not spawn node to verify the pins: ${r.error.message}`);
if (r.status === null) {
  fail(2, `FAIL(2): the pin verification did not exit normally (signal ${r.signal}) — an ` +
         `infrastructure failure, not a verdict.`);
}

const out = `${r.stdout}${r.stderr}`;
const lines = out.split(/\r?\n/);
// The per-subtest TAP lines, NOT the `# pass N` summary. See the vacuity note in the header:
// the summary counts the FILE, so it reads green over a subtest that never ran.
//
// The line is matched UNANCHORED-LEFT deliberately: a top-level TAP result starts at column 0,
// while a nested subtest's result and every line of a YAML diagnostic body are indented. The
// diagnostic body of a failing TEST-21 contains the whole `RECIPE_PINS` dump, so trimming
// first would let the subject's own error text be read as a result line.
const ran = new Map();
const duplicated = new Set();
const seenNames = new Map();
const skipped = [];
for (const line of lines) {
  const m = /^(not ok|ok) \d+ - (TEST-\d+)\b(.*)$/.exec(line);
  if (!m) continue;
  // A TAP DIRECTIVE is not a result. `ok 2 - TEST-21 … # SKIP` is node's spelling of "this
  // test did not run", and it exits 0 — so counting it as a pass makes the whole guard
  // vacuous with a five-character edit. Verified: marking TEST-20/TEST-21 `{ skip: true }`
  // and deleting two real legs from `check-guards` made an earlier draft print PASS.
  // `docs/design/derived-guards.md` §3 states the rule this restores: a skip is a SKIP,
  // never a pass.
  // `(?<!\\)` because node ESCAPES a `#` that occurs inside a test's description (`\#`). Without
  // it, a subtest legitimately named "... (see the # TODO note)" is reported as SKIPPED — a
  // fail-closed direction, but it accuses a test that ran and passed and hands the operator the
  // wrong remedy.
  if (/(?<!\\)#\s*(SKIP|TODO)\b/i.test(m[3])) { skipped.push(m[2]); continue; }
  // AND-combined, never last-write-wins. `ran.set(id, ok)` let a DECOY subtest sharing a pinned
  // id overwrite the real one's `not ok`: a blind round deleted a real gate leg, appended
  // `test('TEST-21 decoy', () => {})`, and the drift was reported under exit 2 — the code this
  // guard's own header defines as "not a verdict" — instead of exit 1. Any `not ok` for an id
  // wins, and a repeated id is itself reported below.
  if (ran.has(m[2])) duplicated.add(m[2]);
  ran.set(m[2], (ran.get(m[2]) ?? true) && m[1] === 'ok');
  seenNames.set(m[2], line.replace(/^(not ok|ok) \d+ - /, '').replace(/\s+#\s*(SKIP|TODO)\b.*$/i, '').trim());
}

// A repeated id is not merely a parsing nuisance — it is the decoy evasion one level down, and
// it makes "which assertion passed?" unanswerable. Refuse it outright.
const dupPinned = PINNED_IDS.filter((id) => duplicated.has(id));
if (dupPinned.length) {
  fail(1,
    `${out}\n` +
    `FAIL: ${dupPinned.join(', ')} is declared more than once in ${PINNED.file}.\n` +
    `      A second subtest sharing a pinned id makes this gate unable to say which one it\n` +
    `      verified, and a passing decoy beside a failing original is exactly the substitution\n` +
    `      this file exists to refuse. Give it a distinct id.`);
}

const missing = PINNED_IDS.filter((id) => !ran.has(id) && !skipped.includes(id));
const wasSkipped = PINNED_IDS.filter((id) => skipped.includes(id));
const failed = PINNED_IDS.filter((id) => ran.get(id) === false);

// EXIT 2 IS "THIS IS NOT A VERDICT", AND IT HAS TO BE REACHABLE. A child that could not run at
// all — a syntax error in the subject, a `process.exit()` before the first test — emits no
// result lines whatsoever and exits non-zero. Reporting that as exit 1 tells the operator a
// recipe changed when nothing of the sort has been established, and `check-aggregate.sh`
// renders the two codes differently on purpose.
if (ran.size === 0 && skipped.length === 0 && r.status !== 0) {
  fail(2, `${out}\nFAIL(2): ${PINNED.file} produced no test results and exited ${r.status}. ` +
          `The pin verification could not RUN, so this is not a verdict about the recipes.`);
}

if (wasSkipped.length) {
  fail(1,
    `${out}\n` +
    `FAIL: ${wasSkipped.join(', ')} was SKIPPED in ${PINNED.file}.\n` +
    `      A skip is a skip, never a pass (docs/design/derived-guards.md §3). node exits 0 on a\n` +
    `      skipped test, so counting it would switch this gate off with a five-character edit.\n` +
    `      Un-skip it, or remove the pin it was standing for — do not leave it muted.`);
}

// A test that RAN under a pinned id but is not the pinned ASSERTION is a substitution, and
// the id alone cannot tell them apart — a blind round proved it with a nine-line diff.
const substituted = PINNED_IDS.filter((id) => seenNames.has(id) && seenNames.get(id) !== PINNED.subtests[id]);
if (substituted.length) {
  fail(1,
    `${out}\n` +
    `FAIL: a different assertion is running under ${substituted.join(', ')}.\n` +
    substituted.map((id) => `      pinned:  ${PINNED.subtests[id]}\n      on disk: ${seenNames.get(id)}`).join('\n') + `\n` +
    `      This gate pins the SENTENCE, not the number, because a stand-in under a borrowed id\n` +
    `      passes every check that looks only at the id. Renaming a test deliberately? Update\n` +
    `      PINNED.subtests here in the same diff, so the substitution is the thing being reviewed.`);
}

if (missing.length) {
  fail(1,
    `${out}\n` +
    `FAIL: ${missing.join(', ')} did not run in ${PINNED.file}.\n` +
    `      This is NOT a pass. \`node --test --test-name-pattern\` exits 0 when its pattern\n` +
    `      matches nothing, so a renamed, moved or deleted subtest would otherwise switch this\n` +
    `      gate off in silence. Restore the subtest under its pinned id, or — if it was\n` +
    `      deliberately renamed — update PINNED.subtests here in the same diff.`);
}

// Every required subtest ran and passed, yet the child exited non-zero: something ELSE in the
// subject file failed, or the process died after reporting. That is a broken verification, not
// a pin mismatch — sending the operator to re-derive pins that are fine is a wrong story.
if (!failed.length && r.status !== 0) {
  fail(2, `${out}\nFAIL(2): every pinned subtest passed but ${PINNED.file} exited ${r.status}. ` +
          `Something else in that file failed; this run establishes nothing about the recipes.`);
}

if (failed.length) {
  fail(1,
    `${out}\n` +
    `FAIL: the gate-defining recipes no longer match their pins (${failed.join(', ')}).\n` +
    `      A recipe under \`just check\` changed without its pin being updated. That is the\n` +
    `      change this gate exists to make loud, and it is a normal thing to do deliberately:\n` +
    `      apply the values printed above, add a RE-PIN LEDGER line in ${PINNED.file} naming\n` +
    `      the commit that moved the body and why, then re-pin the file itself with\n` +
    `      scripts/check-guard-integrity.sh --update. Do NOT update a pin you cannot explain.`);
}

console.log(`PASS: ${PINNED_IDS.join(' + ')} ran and passed over ${PINNED.file} — the ` +
            `recipes \`just check\` reaches still match their pins.`);
