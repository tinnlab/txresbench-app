/**
 * THE CONTROLS FOR `check-recipe-pins.mjs` — "does this guard actually go RED?" (#316)
 *
 * ## Why a controls suite, and why it is declared IN FRONT of the guard
 *
 * `just check-guards` declares this file as `check-recipe-pins-controls`, immediately in
 * front of `check-recipe-pins`, in the load-bearing position the justfile already documents
 * twice: a gate edited without its controls still passing is a gate whose PASS is worth
 * nothing. This file is the committed proof that the guard goes RED — on a recipe that gains
 * a leg, on one that loses a leg with `--min-legs` lowered on the same line AND its byte pin
 * re-fitted, on a recipe nobody enumerated appearing under `just check`, on a dropped leg the
 * stale frozen floor would have waved through, and on the guard's own subtests being renamed
 * out from under it.
 *
 * ## It drives the REAL guard over SYNTHETIC repositories
 *
 * Every mutation below is applied to a COPY of this tree in a run-scoped temp root, never to
 * this tree. `scripts/check-recipe-pins.mjs` and `scripts/check-aggregate.test.mjs` both
 * derive their repository root from their own file location, so a copy at `<tmp>/scripts/`
 * reads `<tmp>/justfile` — no argument plumbing, and therefore no overridable subject path
 * for an evasion to travel down. The consequence that matters: this suite can never redden
 * for an ordinary, legitimate pin change belonging to the `check-recipe-pins` leg beside it,
 * and it can never misattribute a REAL pin problem to the GUARD.
 *
 * TEST-9 is the positive control for that harness. Without it, every RED below could equally
 * mean "the temp copy is broken", which is the confounded-negative failure this repository
 * has hit before: "the thing is absent" passes vacuously when the thing never ran at all.
 *
 *   node --test scripts/check-recipe-pins.test.mjs
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(SCRIPTS_DIR, '..');
const GUARD = path.join(SCRIPTS_DIR, 'check-recipe-pins.mjs');
const PINNED_TEST = 'scripts/check-aggregate.test.mjs';

// ONE run-scoped root, removed at the end (#314 — never a `tmp/` inside the repository).
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-pins-controls-'));
after(() => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* best effort */ } });

// Mirrors `check-aggregate.test.mjs`'s own refusal: a temp path containing a quote would
// produce a broken command and read as a test failure rather than as the environment problem
// it is.
assert.doesNotMatch(ROOT, /['"]/, `refusing to run: the temp root ${ROOT} contains a quote`);

/**
 * The subtests the guard requires, READ from the guard rather than copied into the expectation.
 * Names are pinned there, so this parses id → full name.
 */
const GUARD_SUBTESTS = (() => {
  const src = fs.readFileSync(GUARD, 'utf8');
  const block = /subtests:\s*\{([\s\S]*?)\n  \},/.exec(src);
  assert.ok(block, 'the guard no longer declares PINNED.subtests');
  const entries = [...block[1].matchAll(/'(TEST-\d+)':\s*'((?:[^'\\]|\\.)*)'/g)]
    .map((m) => [m[1], m[2].replace(/\\'/g, "'")]);
  assert.equal(entries.length, 5, `PINNED.subtests parsed as ${entries.length} entries, expected 5`);
  return new Map(entries);
})();
const GUARD_IDS = [...GUARD_SUBTESTS.keys()];
/** The guard's own success sentence, rebuilt from that list. */
const PASS_LINE = new RegExp(`PASS: ${GUARD_IDS.join(' \\+ ')} ran and passed`);

let seq = 0;
/**
 * A synthetic repository holding exactly what TEST-20/TEST-21 read: a justfile, the pinned
 * test file that carries the pins, and the guard itself.
 */
function synthetic(mutate = () => {}) {
  const dir = path.join(ROOT, `repo-${++seq}`);
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  // Copied through an LF normalisation, not byte-for-byte. `.gitattributes` does not force
  // `eol=lf` on the justfile, so a Windows clone with `core.autocrlf=true` gets CRLF — and
  // every mutation anchor below ends in a newline, so on such a checkout the anchors would all
  // miss and eight of these controls would fail with "the mutation anchor is not unique",
  // i.e. an environment problem wearing a guard failure's clothes. The synthetic tree is ours
  // to define; normalising it here keeps the controls portable without touching the real one.
  const lf = (src) => fs.readFileSync(src, 'utf8').replace(/\r\n/g, '\n');
  fs.writeFileSync(path.join(dir, 'justfile'), lf(path.join(REPO, 'justfile')));
  fs.writeFileSync(path.join(dir, PINNED_TEST), lf(path.join(REPO, PINNED_TEST)));
  fs.writeFileSync(path.join(dir, 'scripts', 'check-recipe-pins.mjs'), lf(GUARD));

  const io = {
    dir,
    justfile: () => fs.readFileSync(path.join(dir, 'justfile'), 'utf8'),
    setJustfile: (s) => fs.writeFileSync(path.join(dir, 'justfile'), s),
    pins: () => fs.readFileSync(path.join(dir, PINNED_TEST), 'utf8'),
    setPins: (s) => fs.writeFileSync(path.join(dir, PINNED_TEST), s),
    /** Exact, single-occurrence substitution — a silent no-op edit would fake every RED below. */
    edit(which, from, to) {
      const read = which === 'justfile' ? io.justfile : io.pins;
      const write = which === 'justfile' ? io.setJustfile : io.setPins;
      const s = read();
      assert.equal(s.split(from).length - 1, 1,
        `the mutation anchor is not unique in ${which}; the control would not be applying what it claims:\n${from}`);
      write(s.replace(from, to));
    },
  };
  mutate(io);
  return io;
}

/** Run the REAL guard over a synthetic (or the real) repository and return its own exit code. */
function runGuard(dir) {
  const r = spawnSync(process.execPath, [path.join(dir, 'scripts', 'check-recipe-pins.mjs')], {
    cwd: dir,
    encoding: 'utf8',
    // `spawnSync().status` is the child's OWN exit code — deliberately not a pipeline's, which
    // reports the LAST element's status and reads green over a red gate.
    env: { ...process.env, NODE_TEST_CONTEXT: '', NODE_OPTIONS: '' },
  });
  assert.equal(r.error, undefined, `spawning the guard failed: ${r.error}`);
  assert.notEqual(r.status, null,
    `the guard did not exit normally (signal ${r.signal}) — an infrastructure failure, not a ` +
      `verdict; do not read the assertions below as a result`);
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/**
 * The `check-guards` runner invocation, READ from the justfile rather than typed here.
 * A copy of `--min-legs 7` in this file would be one more number to keep in step with a
 * declaration that already exists, in a suite whose whole subject is numbers drifting from
 * the sets they describe.
 */
const CHECK_GUARDS_LEGS = (() => {
  const line = fs.readFileSync(path.join(REPO, 'justfile'), 'utf8')
    .split(/\r?\n/)
    .find((l) => l.includes(`--label 'just check-guards'`));
  assert.ok(line, 'the justfile no longer declares a `just check-guards` aggregate invocation');
  const m = /--label 'just check-guards' --min-legs \d+/.exec(line);
  assert.ok(m, `could not read check-guards' runner invocation from: ${line}`);
  return m[0];
})();
const CHECK_GUARDS_MIN = Number(/--min-legs (\d+)/.exec(CHECK_GUARDS_LEGS)[1]);

// ── TEST-9 ──────────────────────────────────────────────────────────────────────────
// Declared first because everything below depends on it. An UNMUTATED copy must be GREEN.
test('TEST-9 positive control — an unmutated synthetic copy of this tree is GREEN through the guard', () => {
  const s = synthetic();
  const { status, out } = runGuard(s.dir);
  assert.equal(status, 0,
    `the synthetic harness itself is broken — every RED below would be meaningless:\n${out}`);
  assert.match(out, PASS_LINE,
    'the guard must name EVERY subtest it required as having run — the summary line is what an ' +
      'operator reads, and a shorter list there is a shorter gate');
});

// ── TEST-1 ──────────────────────────────────────────────────────────────────────────
test('TEST-1 the guard is GREEN over THIS repository, and both pinned subtests really ran', () => {
  const { status, out } = runGuard(REPO);
  assert.equal(status, 0, `the recipe pins do not match this tree:\n${out}`);
  // Not the `# pass N` summary: see the guard's header. The summary counts the FILE, so it
  // reads green over a subtest that never ran.
  assert.match(out, PASS_LINE);
});

// ── TEST-2 [acceptance] [invariant: INV-1] ──────────────────────────────────────────
test('TEST-2 [acceptance] [invariant: INV-1] a recipe that GAINS a leg with its pin untouched goes RED', () => {
  const s = synthetic((io) => {
    io.edit('justfile',
      `    check-env-loop-fast bash "{{justfile_directory()}}/scripts/check-env-loop.sh" --fast\n`,
      `    check-env-loop-fast bash "{{justfile_directory()}}/scripts/check-env-loop.sh" --fast\n` +
      `    check-smuggled true\n`);
    io.edit('justfile', CHECK_GUARDS_LEGS, `--label 'just check-guards' --min-legs ${CHECK_GUARDS_MIN + 1}`);
    // The frozen floor is moved WITH the leg, so TEST-20 is fully satisfied and the byte pin is
    // the only assertion left that can object. Without this the RED would be over-determined
    // and this control would not show what it claims to show.
    io.edit('pins', `'check-guards': ${CHECK_GUARDS_MIN}`, `'check-guards': ${CHECK_GUARDS_MIN + 1}`);
  });
  const { status, out } = runGuard(s.dir);
  assert.notEqual(status, 0, `a recipe gained a leg and the guard reported PASS:\n${out}`);
  assert.match(out, /the `check-guards` recipe's legs changed without its pin being updated/);
  assert.match(out, /^ok \d+ - TEST-20 /m,
    'TEST-20 must still PASS here — otherwise the RED is the floor, not the byte pin');
});

// ── TEST-3 [acceptance] [invariant: INV-1] ──────────────────────────────────────────
test('TEST-3 [acceptance] [invariant: INV-1] a DROPPED leg survives neither the same-line floor edit nor a re-fitted floor', () => {
  // The full evasion, not half of it: delete the leg, lower `--min-legs` on the same line so
  // the derived check still balances, AND lower the frozen floor in AGGREGATE_FLOORS so
  // TEST-20 is satisfied too. Everything except the byte pin has been made to agree. That is
  // precisely the state `docs/design/derived-guards.md` §5 calls "lowering a floor to fit",
  // and the byte pin is the only thing left that can see it.
  const s = synthetic((io) => {
    io.edit('justfile',
      `    check-no-format-crates "{{justfile_directory()}}/scripts/check-no-format-crates.sh"\n`, '');
    io.edit('justfile', CHECK_GUARDS_LEGS, `--label 'just check-guards' --min-legs ${CHECK_GUARDS_MIN - 1}`);
    io.edit('pins', `'check-guards': ${CHECK_GUARDS_MIN}`, `'check-guards': ${CHECK_GUARDS_MIN - 1}`);
  });
  const { status, out } = runGuard(s.dir);
  assert.notEqual(status, 0, `a guard leg was deleted and the guard reported PASS:\n${out}`);
  assert.match(out, /the `check-guards` recipe's legs changed without its pin being updated/);
  // And the BYTE PIN is what caught it, not collateral floor arithmetic. Asserted against the
  // TAP result lines, which is reachable: an earlier draft asserted the ABSENCE of a
  // floor-mismatch message that the mutation makes structurally impossible to emit, i.e. a
  // check that could not fail, inside the suite whose premise is removing those.
  assert.match(out, /^ok \d+ - TEST-20 /m,
    'TEST-20 must PASS here: --min-legs and the frozen floor were both moved to 6, so every ' +
      'floor assertion is satisfied and only the bytes disagree');
  assert.match(out, /^not ok \d+ - TEST-21 /m, 'TEST-21 is the assertion that must have failed');
});

// ── TEST-4 [acceptance] [invariant: INV-2] ──────────────────────────────────────────
test('TEST-4 [acceptance] [invariant: INV-2] a recipe nobody enumerated, wired under `just check`, is DISCOVERED', () => {
  // The subject set is DERIVED by walking `just check`'s dependencies and invocations out of
  // the justfile, never read from a list. An enumerating guard cannot see a recipe nobody
  // typed into it; this one must. `--min-legs` is raised with the added leg so the floor
  // arithmetic stays balanced and the SET assertion is the thing under test.
  const s = synthetic((io) => {
    io.edit('justfile',
      `    check-r-regime just check-r-regime\n    LEGS\n`,
      `    check-r-regime just check-r-regime\n    check-undeclared just check-undeclared\n    LEGS\n`);
    io.edit('justfile', `--label 'just check' --min-legs 10`, `--label 'just check' --min-legs 11`);
    io.edit('pins', `check: 10`, `check: 11`);
    io.setJustfile(`${io.justfile()}\n\ncheck-undeclared:\n    true\n`);
  });
  const { status, out } = runGuard(s.dir);
  assert.notEqual(status, 0, `a new gate recipe appeared under \`just check\` and the guard reported PASS:\n${out}`);
  assert.match(out, /the set of recipes .just check. reaches has changed/);
  // The DERIVED set is printed back, and it contains a recipe no constant in this repository
  // mentions. That is the proof of derivation: an enumerating guard could not have listed it.
  // (Stated precisely: this string appears for any TEST-21 failure, because the report always
  // prints the derived set — so it evidences the DERIVATION, not which assertion fired. The
  // preceding match is what pins the assertion.)
  // Bounded to the ARRAY. The lazy form `\[[\s\S]*?"check-undeclared"[\s\S]*?\]` ran straight
  // past `];` into the RECIPE_PINS dump, where the name also appears, so it proved only that
  // the string occurs somewhere after the opening bracket — measured by deleting the entry from
  // the array alone and watching it still match.
  const arr = /const REACHABLE_FROM_CHECK = \[([^\]]*)\]/.exec(out);
  assert.ok(arr, `the guard must print the derived reachable set; it did not:\n${out}`);
  assert.match(arr[1], /"check-undeclared"/,
    'the derived reachable set itself must CONTAIN the recipe nobody enumerated — an ' +
      'enumerating guard could not have found it');
});

// ── TEST-5 [acceptance] [invariant: INV-3] ──────────────────────────────────────────
test('TEST-5 [acceptance] [invariant: INV-3] the CORRECTED frozen floor catches a dropped leg that the stale floor waved through', () => {
  /**
   * Build the state in which the byte pin has ALREADY been honestly re-fitted to a shrunken
   * recipe — i.e. someone deleted a leg and re-pinned, which is a legal-looking two-line diff.
   * The frozen floor is then the ONLY thing standing between that diff and a green tree, and
   * this proves the #316 floor correction is load-bearing rather than cosmetic: at the
   * corrected floor of 7 the deletion FAILS, and at main's stale floor of 4 the very same
   * deletion PASSES.
   */
  const drop = (io) => {
    io.edit('justfile',
      `    check-no-format-crates "{{justfile_directory()}}/scripts/check-no-format-crates.sh"\n`, '');
    io.edit('justfile', CHECK_GUARDS_LEGS, `--label 'just check-guards' --min-legs ${CHECK_GUARDS_MIN - 1}`);
  };

  // Step 1 — drop the leg, then read the guard's OWN report for the shrunken body's hash and
  // apply it. The guard prints the values "if this change is intended"; using them is the
  // documented re-pin path, which is exactly what makes this the dangerous case.
  const probe = synthetic(drop);
  const first = runGuard(probe.dir);
  assert.notEqual(first.status, 0, 'sanity: the un-repinned drop must be red before it is re-fitted');
  const refitted = /"check-guards": "([0-9a-f]{64})"/.exec(first.out);
  assert.ok(refitted, `the guard must print the current value for a re-pin; it did not:\n${first.out}`);
  const stalePin = /"check-guards": "([0-9a-f]{64})"/.exec(fs.readFileSync(path.join(REPO, PINNED_TEST), 'utf8'));
  assert.ok(stalePin && stalePin[1] !== refitted[1], 'sanity: the shrunken body must hash differently');

  // Step 2 — the CORRECTED floor (7). The byte pin now agrees; only the floor can object.
  const corrected = synthetic((io) => {
    drop(io);
    io.edit('pins', `"check-guards": "${stalePin[1]}"`, `"check-guards": "${refitted[1]}"`);
  });
  const c = runGuard(corrected.dir);
  assert.notEqual(c.status, 0, `a re-pinned leg deletion slipped past the corrected floor:\n${c.out}`);
  assert.match(c.out, /A gate has been removed\. Do NOT lower this constant to go green\./);

  // Step 3 — main's STALE floor (4), everything else identical. It passes. That is the bug
  // this branch's floor correction closes, demonstrated rather than asserted.
  const stale = synthetic((io) => {
    drop(io);
    io.edit('pins', `"check-guards": "${stalePin[1]}"`, `"check-guards": "${refitted[1]}"`);
    io.edit('pins', `'check-guards': ${CHECK_GUARDS_MIN}`, `'check-guards': 4`);
  });
  const st = runGuard(stale.dir);
  // NARROWED DELIBERATELY. An earlier draft asserted a whole-guard `exit 0` here, which made
  // this control a RATCHET AGAINST STRENGTHENING: adding TEST-20's `frozen === legs.length`
  // assertion — the correct repair for the slack this very test is about — turned step 3 RED,
  // so the hardening was reported as a controls failure. What step 3 actually claims is
  // narrower and survives that: at the stale floor the DELETION goes unremarked.
  assert.doesNotMatch(st.out, /A gate has been removed/,
    `this step must show the stale floor of 4 saying NOTHING about the deleted leg — that is ` +
      `the slack #316 closed. If it has started objecting, the reason has changed and TEST-5's ` +
      `premise needs re-deriving:\n${st.out}`);
  // The count below is the recipe's REAL remaining legs after the drop, not a frozen constant.
  // The app repo (method-env-images ITEM-4) raised this recipe 7 -> 9, so the drop leaves 8;
  // a literal left at the old count would make this control a ratchet against a legitimate
  // addition — the same mistake the paragraph above records in its first draft.
  assert.match(st.out, /the frozen floor is 4 but the recipe declares 8 legs/,
    'at the stale floor the only surviving objection must be the EQUALITY assertion #316 added; ' +
      'if even that is gone, the floor has stopped guarding anything');
});

// ── TEST-6 ──────────────────────────────────────────────────────────────────────────
test('TEST-6 a pinned subtest renamed out of the file FAILS the guard — it does not silently pass', () => {
  // Measured on node v24.8.0: `--test-name-pattern` matching nothing exits 0 and prints
  // `# tests 1 / # pass 1`, because the FILE counts as a passing test. A guard reading that
  // summary would report PASS the moment TEST-21 were renamed, moved or deleted — the
  // "check that cannot fail" defect. This is the control that keeps the guard honest.
  const s = synthetic((io) => {
    io.edit('pins', `test('TEST-21 the gate-defining recipes are byte-pinned`,
                    `test('TEST-21x the gate-defining recipes are byte-pinned`);
  });
  const { status, out } = runGuard(s.dir);
  assert.notEqual(status, 0, `TEST-21 was renamed away and the guard reported PASS:\n${out}`);
  assert.match(out, /TEST-21 did not run/);
  assert.match(out, /This is NOT a pass/);
});

// ── TEST-7 ──────────────────────────────────────────────────────────────────────────
test('TEST-7 the guard fails CLOSED on a missing subject, an empty subject, an argument, and a poisoned environment', () => {
  // (a) the pinned file is gone.
  const gone = synthetic((io) => fs.rmSync(path.join(io.dir, PINNED_TEST)));
  const a = runGuard(gone.dir);
  assert.notEqual(a.status, 0, `the pinned file was deleted and the guard reported PASS:\n${a.out}`);
  assert.match(a.out, /does not exist/);

  // (b) the pinned file is present but declares nothing — the "repoint the leg at an empty
  // file" evasion TEST-21's own header records an audit round finding.
  const empty = synthetic((io) => io.setPins('// nothing here\n'));
  const b = runGuard(empty.dir);
  assert.notEqual(b.status, 0, `the pinned file was emptied and the guard reported PASS:\n${b.out}`);
  assert.match(b.out, new RegExp(`${GUARD_IDS.join(', ')} did not run`),
    'the message must name the WHOLE pinned list — asserting a trailing substring passes for any ' +
      'list that merely ends with those ids, so it would not notice the list being cut');

  // (c) the guard takes no arguments, so a subject cannot be redirected at the call site.
  const argv = spawnSync(process.execPath, [GUARD, '--repo', os.tmpdir()], { encoding: 'utf8', cwd: REPO });
  assert.equal(argv.status, 2, `an argument must be refused, not interpreted:\n${argv.stdout}${argv.stderr}`);

  // (d) $NODE_OPTIONS can `--require` a shim into the child that verifies the pins. Refused,
  // not silently unset — the same discipline `check-aggregate.sh` applies to $BASH_ENV.
  const poisoned = spawnSync(process.execPath, [GUARD], {
    encoding: 'utf8', cwd: REPO, env: { ...process.env, NODE_OPTIONS: '--no-warnings' },
  });
  assert.equal(poisoned.status, 2, `a run with $NODE_OPTIONS set must be refused:\n${poisoned.stdout}${poisoned.stderr}`);
  assert.match(`${poisoned.stdout}${poisoned.stderr}`, /refusing to run with \$NODE_OPTIONS set/);
});

// ── TEST-8 ──────────────────────────────────────────────────────────────────────────
test('TEST-8 `just check-guards` declares the controls leg immediately in front of the guard', () => {
  // Structural, and honestly so: the behavioural complement is the real `just check-guards`
  // run recorded in phase 8. What this pins is the ORDER, which no hash covers on its own —
  // a controls leg that runs AFTER the guard it controls cannot invalidate its verdict.
  const justfile = fs.readFileSync(path.join(REPO, 'justfile'), 'utf8').split('\n');
  const start = justfile.findIndex((l) => l.startsWith('check-guards:'));
  assert.ok(start > 0, 'the justfile no longer defines `check-guards`');
  const heredoc = justfile.slice(start).findIndex((l) => /<<'LEGS'/.test(l));
  const end = justfile.slice(start).findIndex((l, i) => i > heredoc && l.trim() === 'LEGS');
  assert.ok(heredoc > 0 && end > heredoc, '`check-guards` no longer routes through the aggregate runner');
  const legs = justfile.slice(start + heredoc + 1, start + end).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const names = legs.map((l) => l.split(/\s+/)[0]);

  const controls = names.indexOf('check-recipe-pins-controls');
  const guard = names.indexOf('check-recipe-pins');
  assert.notEqual(guard, -1, '`check-recipe-pins` is not a leg of `just check-guards` — the gate is unwired');
  assert.equal(controls, guard - 1,
    `the controls leg must sit IMMEDIATELY in front of the guard it controls; got ${names.join(', ')}`);
  assert.match(legs[guard], /scripts\/check-recipe-pins\.mjs/,
    'the leg must invoke this guard by path — a leg whose argv merely mentions `node` proves nothing');
  assert.match(legs[controls], /--test .*scripts\/check-recipe-pins\.test\.mjs/,
    'the controls leg must run THIS file, not some other test');

  const minLegs = Number(/--min-legs[ =](\d+)/.exec(justfile[start + heredoc])?.[1]);
  assert.equal(minLegs, legs.length,
    `--min-legs is ${minLegs} but \`check-guards\` declares ${legs.length} legs — a floor below the ` +
      `leg count lets a leg vanish silently`);
});

// ── TEST-10 ─────────────────────────────────────────────────────────────────────────
/**
 * The RE-PIN LEDGER, checked against RECIPE_PINS itself rather than against two names.
 *
 * #316's trap, restated: updating a byte-pin so it matches a body that moved is exactly how a
 * weakened gate would be laundered into main. The ledger is the defence, and the FIRST draft of
 * this test was itself an enumeration — `for (const name of ['check-invariants','check-guards'])`
 * — so a blind round defeated it by moving a THIRD pin: it appended ` || true` to the
 * `check-coercion` recipe, took the replacement hash out of TEST-21's own report, re-pinned, wrote
 * no ledger line, and all twelve controls stayed green. A guard that silently stops covering the
 * thing it names is `docs/design/derived-guards.md` §1, reintroduced by the repair for it.
 *
 * So this ranges over `Object.keys(RECIPE_PINS)`. A pin with no row fails; a row whose recorded
 * value has drifted from its pin fails; and a citation must be EVIDENCE, not merely a real commit
 * — the second blind finding was that swapping a cited sha for an unrelated justfile-touching one
 * left the old test green. `moved <sha>` is therefore re-derived: the recipe's normalised hash at
 * <sha>^ and at <sha> must actually differ.
 */

/**
 * One recipe's normalised hash from a justfile SOURCE STRING, by the same rule TEST-21 uses:
 * header line, dependencies, then body lines trimmed with blanks and non-shebang comments
 * dropped. Deliberately a separate implementation from the pinned file's, because this one
 * ranges over HISTORY (`git show <sha>:justfile`) rather than over the working tree, and the
 * pinned file offers no export. It fails CLOSED: any divergence makes a hash mismatch, which
 * reddens, and it is exercised on real commits by this test on every run.
 */
function recipeHashIn(src, name) {
  const lines = src.split(/\r?\n/);
  // `(\\s[^:]*)?` and NOT `([^:]*)`: the loose form prefix-matches a LONGER recipe name, so
  // `recipeHashIn(src, 'check-guards')` would hash a `check-guards-preflight:` declared above
  // it. A blind round measured 63 such disagreements with the pinned file's own `allRecipes()`
  // across this repository's history (all on `e2e-processors`), and showed the direction is
  // FAIL-OPEN: a commit that touched only the decoy would then be accepted as evidence that
  // the real recipe's body moved. `just` separates a recipe's name from its parameters with
  // whitespace, so requiring it costs nothing and closes the prefix.
  const i = lines.findIndex((l) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s[^:]*)?:(?!=)`).test(l));
  if (i < 0) return null;
  const header = lines[i].trim();
  const deps = (/^[^:]*:(?!=)(.*)$/.exec(lines[i])?.[1] ?? '')
    .split('#')[0].replace(/[()]/g, ' ').trim().split(/\s+/).filter((d) => /^[a-zA-Z][\w-]*$/.test(d));
  const body = [];
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j];
    if (l.trim() === '') { body.push(l); continue; }
    if (!/^\s/.test(l)) break;
    body.push(l);
  }
  while (body.length && body[body.length - 1].trim() === '') body.pop();
  const norm = [header, deps.join(' '),
    ...body.map((l) => l.trim()).filter((l) => l && (!l.startsWith('#') || l.startsWith('#!')))].join('\n');
  return createHash('sha256').update(norm).digest('hex');
}

const git = (args) => spawnSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/**
 * Parse RECIPE_PINS and the ledger table out of a pinned-file SOURCE. No git, no network.
 *
 * RECIPE_PINS is parsed as STRICT JSON, not scanned with a regex. A blind round defeated the
 * regex by leaving the old value in a `//` comment beside the new one: the scanner saw ten
 * plausible pairs and the ledger needed no edit at all, while JavaScript used the weakened
 * hash. JSON.parse admits exactly one reading of the block, and it is the same reading the
 * runtime gets.
 *
 * The table is read only BETWEEN ITS MARKERS. Rows used to be matched anywhere in ~90 lines of
 * surrounding prose, so a row could be hidden below the visible table; and a zero-width space
 * in a visible row silently de-parsed it, making the row a reviewer reads and the row the
 * machine reads two different things. The region is therefore refused outright if it contains
 * any non-ASCII character.
 */
function readLedger(src) {
  const block = /const RECIPE_PINS = (\{[\s\S]*?\n\});/.exec(src);
  if (!block) return { error: 'the source declares no RECIPE_PINS object' };
  let pins;
  try {
    pins = new Map(Object.entries(JSON.parse(block[1])));
  } catch (e) {
    return { error: `RECIPE_PINS is not a plain JSON object (${e.message}). It must be literal ` +
      `"key": "<64 hex>" pairs and nothing else — a comment or an alternate quoting lets the ` +
      `checker and the runtime read different values, which is how a pin was once moved with ` +
      `the ledger left untouched.` };
  }
  const table = /^ \* ─── TABLE ───$([\s\S]*?)^ \* ─── END TABLE ───$/m.exec(src);
  if (!table) return { error: 'the RE-PIN LEDGER has no delimited ─── TABLE ─── region' };
  // eslint-disable-next-line no-control-regex
  const nonAscii = /[^\x00-\x7F─]/.exec(table[1]);
  if (nonAscii) {
    return { error: `the ledger table contains a non-ASCII character (U+${nonAscii[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}). ` +
      `Refused: a zero-width space here once made a row that reads correctly parse as no row at all.` };
  }
  const rows = new Map();
  const dupes = [];
  const malformed = [];
  for (const line of table[1].split('\n')) {
    if (!line.trim() || line.trim() === '*') continue;
    const m = /^ \* ([\w.-]+)\s+([0-9a-f]{64})\s+((?:[0-9a-f]{7,40}\s+)*(?:[0-9a-f]{7,40}|THIS-CHANGE)(?:\s+THIS-CHANGE)?)\s*$/.exec(line);
    if (!m) { malformed.push(line.trim()); continue; }
    if (rows.has(m[1])) dupes.push(m[1]);
    const parts = m[3].trim().split(/\s+/);
    rows.set(m[1], { value: m[2], shas: parts.filter((x) => x !== 'THIS-CHANGE'), thisChange: parts.includes('THIS-CHANGE') });
  }
  return { pins, rows, dupes, malformed };
}


/**
 * The property a machine can actually hold: every pin has exactly one row carrying its CURRENT
 * value, so a pin cannot move without this block moving in the same diff. Needs no git, and is
 * therefore never conditioned away.
 */
function ledgerCoverageErrors(src) {
  const L = readLedger(src);
  if (L.error) return [L.error];
  const e = [];
  for (const line of L.malformed) e.push(`unparseable ledger table row: "${line}"`);
  for (const d of L.dupes) e.push(`the ledger has two rows for \`${d}\``);
  for (const k of L.pins.keys()) if (!L.rows.has(k)) e.push(`\`${k}\` has NO ledger row`);
  for (const k of L.rows.keys()) if (!L.pins.has(k)) e.push(`the ledger has a row for \`${k}\`, which is not a pin`);
  for (const [key, pin] of L.pins) {
    const row = L.rows.get(key);
    if (row && row.value !== pin) {
      e.push(`the ledger records \`${key}\` at ${row.value.slice(0, 8)} but RECIPE_PINS says ${pin.slice(0, 8)}. ` +
        `The pin moved and the ledger did not — which is the omission #316 exists to make loud, one level up.`);
    }
  }
  return e;
}

/** Cited commits exist and touched the justfile. Deliberately NOT a claim that they explain the pin. */
function ledgerCitationErrors(src) {
  const L = readLedger(src);
  if (L.error) return [L.error];
  const e = [];
  for (const [key, row] of L.rows) {
    if (!row.shas.length && !row.thisChange) e.push(`\`${key}\`'s row cites nothing at all`);
    for (const sha of row.shas) {
      if (git(['cat-file', '-e', `${sha}^{commit}`]).status !== 0) {
        e.push(`the ledger cites ${sha} for \`${key}\`, which is not a commit in this repository`);
        continue;
      }
      const files = git(['show', '--name-only', '--format=', sha]);
      if (files.status !== 0 || !/^justfile$/m.test(files.stdout)) {
        e.push(`the ledger cites ${sha} for \`${key}\`, but that commit does not touch the justfile`);
      }
    }
  }
  return e;
}

const REAL_PINNED_SRC = () => fs.readFileSync(path.join(REPO, PINNED_TEST), 'utf8');

// ── TEST-10 ─────────────────────────────────────────────────────────────────────────
test('TEST-10 every pin carries a ledger row at its CURRENT value (needs no git)', () => {
  assert.deepEqual(ledgerCoverageErrors(REAL_PINNED_SRC()), []);
});

// ── TEST-16 ─────────────────────────────────────────────────────────────────────────
test('TEST-16 every cited commit exists and touched the justfile — refused, never skipped, without history', () => {
  /**
   * REFUSES rather than skips when history is unavailable. A skip exits 0 and takes the check
   * with it, which is the fail-open shape `derived-guards.md` §3 calls out — and nothing
   * downstream would notice, because the controls leg is a plain `node --test`. A shallow clone
   * is a fixable condition, so it gets a red with the remedy in the message.
   */
  const probe = git(['rev-parse', '--is-shallow-repository']);
  assert.equal(probe.status, 0,
    `the ledger citations cannot be checked: git is unavailable here ` +
      `(${(probe.stderr || '').trim() || probe.error?.message}). Refused rather than skipped.`);
  assert.notEqual(probe.stdout.trim(), 'true',
    'the ledger citations cannot be checked: this is a SHALLOW clone. Re-run with full history ' +
      '(`fetch-depth: 0`). Refused rather than skipped: a skip would switch this off in silence.');
  assert.deepEqual(ledgerCitationErrors(REAL_PINNED_SRC()), []);
});

// ── TEST-17 ─────────────────────────────────────────────────────────────────────────
test('TEST-17 NO pin can move without its ledger row moving — derived over every pin, not a sample', () => {
  /**
   * The control for the one property this ledger actually claims. It is DERIVED over
   * `Object.keys(RECIPE_PINS)` rather than aimed at a chosen recipe, because the previous
   * version aimed eight hand-written attacks at `check-coercion` — the single pin for which the
   * attack it was testing is impossible by an accident of history — and consequently passed
   * with the entire code path it claimed to exercise DELETED.
   *
   * What is NOT claimed, and was in three earlier drafts: that a cited commit explains the
   * change. Blind rounds laundered every version of that predicate. The claim is now exactly
   * what the loop below proves.
   */
  const src = REAL_PINNED_SRC();
  const L = readLedger(src);
  assert.ok(!L.error, `the shipped ledger must parse: ${L.error}`);
  assert.equal(L.pins.size, 10, `expected 10 pins, parsed ${L.pins.size}`);

  for (const [key, pin] of L.pins) {
    // Move the pin, leave the ledger alone — the shape of every laundering attempt.
    const forged = `${pin.slice(0, 63)}${pin[63] === 'a' ? 'b' : 'a'}`;
    const moved = src.replace(`"${key}": "${pin}"`, `"${key}": "${forged}"`);
    assert.notEqual(moved, src, `the mutation anchor for \`${key}\` did not apply`);
    assert.notEqual(ledgerCoverageErrors(moved).length, 0,
      `\`${key}\`'s pin was changed with its ledger row untouched and nothing objected. That is ` +
        `the #316 trap: a weakened gate re-pinned in silence.`);
  }

  // ...and the shipped state is clean, so the REDs above mean "the row is stale", not "any edit reddens".
  assert.deepEqual(ledgerCoverageErrors(src), []);

  // The parse itself must refuse the two shapes that made the checker and the runtime disagree.
  const commented = src.replace(
    /"check-coercion": "([0-9a-f]{64})",/,
    (_, h) => `// legacy: "check-coercion": "${h}",\n  "check-coercion": "${'0'.repeat(64)}",`);
  assert.notEqual(ledgerCoverageErrors(commented).length, 0,
    'a commented-out decoy pin beside the real one must be refused — it let a pin move with the ledger untouched');
  const zwsp = src.replace(' * check-coercion             ', ' * check-coercion​            ');
  assert.notEqual(ledgerCoverageErrors(zwsp).length, 0,
    'a zero-width space in the table must be refused — it makes the row a reviewer reads and the row the machine reads different things');
});

// ── TEST-13 ─────────────────────────────────────────────────────────────────────────
test('TEST-13 the pinned subtest list cannot SHRINK, and each entry still names a real assertion', () => {
  /**
   * WHAT THIS CLAIMS, AND — SAID PLAINLY, BECAUSE TWO EARLIER VERSIONS CLAIMED MORE — WHAT IT
   * DOES NOT.
   *
   * Earlier drafts DERIVED, from the pinned file's source, "every test that reads the justfile",
   * and asserted the guard's list covered it. That claim is withdrawn. A blind round showed the
   * derivation's test-block regex stopped at the first statement of each test and that eight of
   * nine ordinary spellings of a new justfile-reading test walked past it — an indented `test(`,
   * a backtick name, one generated in a loop, one nested in `describe`, a `let` helper, an
   * object-property helper, a read after an early `);`, a concatenated path. Sharpening the
   * regex is another predicate over the same unbounded space, which is the trap
   * `derived-guards.md` §1 names and the reason TEST-21 is a hash rather than a matcher.
   *
   * So this holds the two things that ARE checkable, and no more:
   *   1. the list may not shrink — the ids the guard ships with are all still there, in a file
   *      whose bytes are pinned, so removing one is a visible diff a reviewer sees;
   *   2. every named assertion still exists in the pinned file under exactly that name, so an
   *      entry cannot decay into a pin on nothing.
   *
   * THE HONEST BOUND: a NEW justfile assertion added tomorrow will not be added to the guard's
   * list by any machine. It is still run — by `check-aggregate-controls` under the full
   * `just check` — so what is lost is earliness, not coverage. That is a degradation back to
   * `main`'s behaviour for that one assertion, not a hole, and it is written here rather than
   * papered over with a matcher that three rounds of review kept walking through.
   */
  const FROZEN = ['TEST-8', 'TEST-12', 'TEST-13', 'TEST-20', 'TEST-21'];
  const missing = FROZEN.filter((id) => !GUARD_SUBTESTS.has(id));
  assert.deepEqual(missing, [],
    `${missing.join(', ')} was removed from PINNED.subtests. Do NOT shrink this list to go green: ` +
      `an earlier version of this branch shipped an "excluded" hatch gated by a minimum-length ` +
      `reason string, and a blind round used it to cut the list back to two ids — the exact cut a ` +
      `previous round had proved insufficient — with this test certifying the result.`);

  const src = fs.readFileSync(path.join(REPO, PINNED_TEST), 'utf8');
  for (const [id, name] of GUARD_SUBTESTS) {
    assert.ok(src.includes(`test('${name}'`) || src.includes(`test(\`${name}\``),
      `the guard pins ${id} to the assertion "${name}", and ${PINNED_TEST} declares no test with ` +
        `that exact name. Either the test was renamed — in which case the guard must be updated ` +
        `in the same diff, so the rename is the thing being reviewed — or the pin has decayed ` +
        `into a pin on nothing.`);
  }
});

// ── TEST-14 ─────────────────────────────────────────────────────────────────────────
test('TEST-14 a SKIPPED pinned subtest is refused — a skip is a skip, never a pass', () => {
  /**
   * The shorter sibling of TEST-6's rename evasion, and the one an earlier draft of the guard
   * fell to. node emits a skipped test as `ok N - TEST-21 … # SKIP` and exits 0, so a parser
   * that stops at the test id records it as a PASS. Reproduced against that draft: marking both
   * pinned subtests `{ skip: true }` and deleting two REAL gate legs from `check-guards` printed
   * `PASS: … ran and passed`. The mutation below is that, in one line.
   */
  const s = synthetic((io) => {
    io.edit('pins', `test('TEST-21 the gate-defining recipes are byte-pinned, so no gate can be neutered silently', () => {`,
                    `test('TEST-21 the gate-defining recipes are byte-pinned, so no gate can be neutered silently', { skip: 'muted' }, () => {`);
    // ...and a real gate leg removed underneath it, so a PASS here would be certifying a
    // shrunken gate, not merely tolerating a muted test.
    io.edit('justfile',
      `    check-no-format-crates "{{justfile_directory()}}/scripts/check-no-format-crates.sh"\n`, '');
    io.edit('justfile', CHECK_GUARDS_LEGS, `--label 'just check-guards' --min-legs ${CHECK_GUARDS_MIN - 1}`);
  });
  const { status, out } = runGuard(s.dir);
  assert.notEqual(status, 0, `a pinned subtest was skipped while a real leg was deleted, and the guard reported PASS:\n${out}`);
  assert.match(out, /TEST-21 was SKIPPED/);
  assert.match(out, /A skip is a skip, never a pass/);
});

// ── TEST-15 ─────────────────────────────────────────────────────────────────────────
test('TEST-15 the guard separates “could not run” (exit 2) from “the pins drifted” (exit 1)', () => {
  // `check-aggregate.sh` renders FAIL(1) and FAIL(2) differently on purpose, and the guard's
  // header sells the split. An earlier draft routed every broken-child path into exit 1, telling
  // the operator a recipe had changed when in fact nothing had been established at all.
  const broken = synthetic((io) => io.setPins(`${io.pins()}\nthis is not valid javascript(((\n`));
  const b = runGuard(broken.dir);
  assert.equal(b.status, 2,
    `a subject that cannot be parsed must exit 2 (not a verdict), not 1 (the recipes changed):\n${b.out}`);
  assert.match(b.out, /produced no test results/);

  // The control: a REAL drift on an otherwise healthy subject is still exit 1.
  const drifted = synthetic((io) => {
    io.edit('justfile',
      `    check-env-loop-fast bash "{{justfile_directory()}}/scripts/check-env-loop.sh" --fast\n`,
      `    check-env-loop-fast bash "{{justfile_directory()}}/scripts/check-env-loop.sh" --fast\n    check-extra true\n`);
    io.edit('justfile', CHECK_GUARDS_LEGS, `--label 'just check-guards' --min-legs ${CHECK_GUARDS_MIN + 1}`);
    io.edit('pins', `'check-guards': ${CHECK_GUARDS_MIN}`, `'check-guards': ${CHECK_GUARDS_MIN + 1}`);
  });
  const d = runGuard(drifted.dir);
  assert.equal(d.status, 1, `a real pin drift must exit 1, not 2:\n${d.out}`);

  // The OTHER exit-2 branch, which had no control at all: every pinned subtest passes and the
  // child still exits non-zero, because something ELSE in the file failed. Deleting that branch
  // made the guard print PASS over a non-zero child and no control objected.
  const otherFailure = synthetic((io) => io.setPins(
    `${io.pins()}\nprocess.on('exit', () => { process.exitCode = 7; });\n`));
  const o = runGuard(otherFailure.dir);
  assert.equal(o.status, 2,
    `every pinned subtest passed but the subject exited non-zero — that is "not a verdict" ` +
      `(exit 2), not a pin mismatch and not a PASS:\n${o.out}`);
  assert.match(o.out, /every pinned subtest passed but .* exited/);
});

// ── TEST-18 ─────────────────────────────────────────────────────────────────────────
test('TEST-18 a DECOY subtest sharing a pinned id cannot overwrite the real one’s verdict', () => {
  // `ran.set(id, ok)` was last-write-wins, so appending `test('TEST-21 decoy', () => {})` to the
  // subject let a passing decoy overwrite a real `not ok`. The drift was then reported under
  // exit 2 — the code this guard's header defines as "not a verdict" — which defeats the very
  // split the branch added. Any `not ok` for an id must win, and the duplicate itself is named.
  const s = synthetic((io) => {
    io.edit('justfile',
      `    check-no-format-crates "{{justfile_directory()}}/scripts/check-no-format-crates.sh"\n`, '');
    io.edit('justfile', CHECK_GUARDS_LEGS, `--label 'just check-guards' --min-legs ${CHECK_GUARDS_MIN - 1}`);
    io.edit('pins', `'check-guards': ${CHECK_GUARDS_MIN}`, `'check-guards': ${CHECK_GUARDS_MIN - 1}`);
    io.setPins(`${io.pins()}\ntest('TEST-21 decoy', () => {});\n`);
  });
  const { status, out } = runGuard(s.dir);
  assert.equal(status, 1,
    `a real gate leg was deleted and a decoy TEST-21 was appended; the verdict must be 1 (the ` +
      `pins drifted), not 0 and not 2 ("not a verdict"):\n${out}`);
  assert.match(out, /TEST-21 is declared more than once|recipe's legs changed without its pin/);
});


// ── TEST-19 ─────────────────────────────────────────────────────────────────────────
test('TEST-19 a STAND-IN under a pinned id is refused — the guard pins the sentence, not the number', () => {
  /**
   * The nine-line diff a blind round used to remove a real assertion from this gate while every
   * check stayed green: rename `TEST-13 no recipe reachable … can abort on its first failure` to
   * `TEST-130 …`, and add `test('TEST-13 the gate manifest is present and non-empty', …)` in its
   * place. The guard had verified that SOMETHING named TEST-13 ran.
   *
   * Both halves are pinned now: this proves the substitution is refused, and TEST-13 proves the
   * pinned NAME still names a real test, so the pair cannot be satisfied by renaming both.
   */
  const s = synthetic((io) => {
    io.edit('pins',
      `test('TEST-13 no recipe reachable as a leg of \`just check\` can abort on its first failure', () => {`,
      `test('TEST-13 the gate manifest is present and non-empty', () => {\n  assert.ok(fs.readFileSync(path.join(REPO, 'justfile'), 'utf8').length > 0);\n});\ntest('TEST-130 no recipe reachable as a leg of \`just check\` can abort on its first failure', () => {`);
  });
  const { status, out } = runGuard(s.dir);
  assert.notEqual(status, 0,
    `a stand-in assertion was substituted under the pinned id TEST-13 and the guard reported PASS:\n${out}`);
  assert.match(out, /a different assertion is running under TEST-13/);
});

// ── TEST-11 ─────────────────────────────────────────────────────────────────────────
test('TEST-11 the design this guard realizes still declares its non-negotiables and this failure class', () => {
  // Mirrors `check-aggregate.test.mjs`'s own TEST-11. A guard whose stated rationale can be
  // deleted while the guard stands is a guard nobody can evaluate; the next person to meet a
  // red here needs the reasoning, not just the assertion.
  const design = fs.readFileSync(path.join(REPO, 'docs/design/derived-guards.md'), 'utf8');
  assert.match(design, /^## §6 Non-negotiables$/m, 'the design no longer declares its non-negotiables');
  // Prose is hard-wrapped and carries emphasis markers, so the sentences are matched over a
  // whitespace- and `*`-normalised copy. Matching the raw text would make this test fail on a
  // reflow, which trains people to edit the assertion instead of reading it.
  const flat = design.replace(/[*_`]/g, '').replace(/\s+/g, ' ');
  assert.match(flat, /A guard derives the set it ranges over from the declaration that defines that set/,
    'INV-1 — the invariant this guard realizes — is gone from the design');
  assert.match(flat, /A guard is never relaxed to make a branch pass/,
    'INV-4 — the invariant the re-pin ledger exists to uphold — is gone from the design');
  assert.match(flat, /Running a gate is not the same as running the test that pins the gate/,
    'the §7 entry recording this failure class has been deleted');
  assert.match(flat, /a change that edits justfile is gated by just check, never by a sub-recipe/,
    'the PROCESS half of the #316 repair — the half no gate can enforce — has been deleted');
});

// ── TEST-12 ─────────────────────────────────────────────────────────────────────────
test('TEST-12 this branch’s own files are pinned in scripts/guard-hashes.txt at their current bytes', () => {
  // The branch-local form of the omission being repaired: a guard added or edited without its
  // pin. `check-guard-integrity` enforces this over the whole manifest; this is the same
  // question asked of the three files this change touches, so it fails in the run that made
  // the edit rather than in someone else's.
  const manifest = fs.readFileSync(path.join(REPO, 'scripts/guard-hashes.txt'), 'utf8');
  for (const rel of ['scripts/check-recipe-pins.mjs', 'scripts/check-recipe-pins.test.mjs', PINNED_TEST]) {
    const want = createHash('sha256').update(fs.readFileSync(path.join(REPO, rel))).digest('hex');
    assert.match(manifest, new RegExp(`^${want}\\s+${rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'),
      `${rel} is not pinned at its current bytes. Deliberate? ` +
        `scripts/check-guard-integrity.sh --update && git add scripts/guard-hashes.txt`);
  }
});
