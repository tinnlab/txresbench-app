#!/usr/bin/env node
// check-pub-orphans.test.mjs — the NEGATIVE CONTROLS for `scripts/check-pub-orphans.mjs` (#295).
//
// ── WHY ─────────────────────────────────────────────────────────────────────────
// #295 cleared this guard's first red: two unconsumed `pub` items had reached `main` and a
// ledger entry had gone stale. Every way of clearing a red guard except the honest one ends
// with the guard passing because it stopped LOOKING — raise the floor, widen an allowlist,
// `#[allow]` the item, quietly delete the assertion. `docs/derived-guards.md` §5
// names those as non-repairs, and this repository has filed the "fix made the check blind"
// class repeatedly (#274, #286, #272, #213). A one-off "I added a `pub fn` and watched it
// go red" proves the guard bit on the day someone typed it and nothing about tomorrow.
//
// So the bite is a COMMITTED control. Each assertion below DRIVES the real guard as a
// subprocess over a synthetic lib-crate tree and reads the child's OWN exit status —
// never a status observed through a pipe, which reports the LAST pipeline element's code
// and has produced a false green in this repo more than once.
//
// ── WHAT IS SYNTHETIC AND WHAT IS REAL ──────────────────────────────────────────
// The guard resolves its repo root from its own location (`dirname(script)/..`) and shells
// out to `find src-app/...` from there, so copying the REAL guard file into a temp repo
// makes the TREE the variable. The one thing substituted in the copy is the `LEDGER` object
// literal — the ledger is part of the guard, not part of its input, and a synthetic tree
// cannot satisfy the real pins. That substitution is asserted to have actually happened, so
// a future reshape of the guard cannot silently turn these controls into a no-op.
// No control here scans the real TREE: that is the `check-pub-orphans` leg's own job, and a
// control that reddened on an ordinary new orphan would misattribute a tree problem to the
// guard — which matters more since this file is declared `--controls-leg`, so its failure
// prints "every other result above is unverified" over six unrelated verdicts.
//
// TEST-3 is the deliberate exception and the line is worth stating exactly: it reads the
// real shipped `LEDGER`, because the ledger is part of the GUARD, not part of the tree. A
// pin with no stated reason is a defect in the floor itself, and invalidating the gate's
// PASS is precisely the right response to that. What TEST-3 does NOT do is care whether the
// tree has orphans — only whether each entry says why it is tolerated.
//
// It reads NOTHING under `.lifecycle/` (rule B6): those artifacts are stripped at merge, so
// a gate that reads them passes in a worktree and then fails on main forever.
//
//   node --test scripts/check-pub-orphans.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(SCRIPTS_DIR, '..');
const GUARD = path.join(SCRIPTS_DIR, 'check-pub-orphans.mjs');
const GUARD_SRC = fs.readFileSync(GUARD, 'utf8');

/** The shipped `LEDGER` object literal, matched as a whole so it can be swapped or parsed. */
const LEDGER_RE = /const LEDGER = \{[\s\S]*?\n\};/;

const TMPDIRS = [];
process.on('exit', () => {
  for (const d of TMPDIRS) fs.rmSync(d, { recursive: true, force: true });
});

/**
 * A synthetic repo: the REAL guard (with `LEDGER` substituted) over a tree of `.rs` files.
 *
 * `files` maps a path relative to the repo root → file contents. Declarations must live
 * under `src-app/server/src/` (the guard's declaration scope); a consumer may live anywhere
 * under `src-app/` (its reference scope).
 */
function fixture(ledger, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-orphans-ctl-'));
  TMPDIRS.push(dir);
  // A FUNCTION replacer, never a string one. In a string replacement `$&`, `` $` ``, `$'`
  // and `$$` are replacement PATTERNS, so a fixture reason containing one would splice the
  // matched ledger back in (or swallow text) and silently produce a nonsense guard copy.
  // (`$1` is NOT one of them here — `LEDGER_RE` has no capture groups; an earlier version
  // of this comment said otherwise. TEST-4's ledger carries a literal `$&` as the control.)
  const patched = GUARD_SRC.replace(LEDGER_RE, () => `const LEDGER = ${JSON.stringify(ledger)};`);
  assert.notEqual(
    patched,
    GUARD_SRC,
    'the LEDGER literal was not substituted — the guard has been reshaped and these ' +
      'controls would be asserting against the REAL ledger over a synthetic tree, i.e. ' +
      'nothing. Fix LEDGER_RE rather than deleting the assertion.',
  );
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'scripts', 'check-pub-orphans.mjs'), patched);
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return dir;
}

/** Run a guard copy and return its OWN exit status plus its combined output. */
function runGuard(repoDir) {
  const r = spawnSync(process.execPath, [path.join(repoDir, 'scripts', 'check-pub-orphans.mjs')], {
    encoding: 'utf8',
  });
  assert.equal(r.error, undefined, `spawning the guard failed: ${r.error}`);
  assert.notEqual(
    r.status,
    null,
    `the guard did not exit normally (signal ${r.signal}) — an infrastructure failure, not a ` +
      'wrong exit code; do not read the assertions below as a result',
  );
  return { status: r.status, all: r.stdout + r.stderr };
}

/**
 * The positive control every case below carries — and it deliberately spans BOTH of the
 * guard's scopes and BOTH of their boundaries.
 *
 * The guard has TWO different scopes and they are not the same: declarations are collected
 * from `src-app/server/src` only, while references are counted across ALL of `src-app`. A
 * positive control that only ever exercises one scope proves one scope, and each item here
 * exists to kill a specific mutation of the guard that the others survive:
 *
 * * `used_item`  — declared and consumed inside `modules/`: the ordinary case.
 * * `far_item`   — declared in the server crate, consumed ONLY from `src-app/consumers/**`. Kills
 *                  the REFERENCE-scope narrowing (`rsFiles('src-app')` → `'src-app/server'`),
 *                  which every control survived before this item existed.
 * * `root_item`  — declared at the server crate's ROOT, outside `modules/`. Kills a
 *                  DECLARATION-scope narrowing (…`/src` → …`/src/modules/demo`) — the
 *                  "guard quietly stopped LOOKING at most of the crate" direction.
 * * `outside_item` — an unconsumed `pub fn` OUTSIDE the declaration scope, asserted NOT to be
 *                  reported. Kills a DECLARATION-scope WIDENING (…`/src` → `src-app`), which
 *                  would drag `desktop/tauri/**` and every library crate into the floor.
 * * `comment_only_item` — an unconsumed `pub fn` whose ONLY other mention is inside a
 *                  whole-line comment. Kills `isCommentLine = () => false`, i.e. the guard
 *                  accepting prose as a consumer, which is the cheapest way to blind it.
 */
const CONSUMED = {
  'src-app/server/src/modules/demo/repository.rs':
    'pub fn used_item() -> u8 { 1 }\nfn caller() -> u8 { used_item() }\n',
  'src-app/server/src/modules/demo/exported.rs': 'pub fn far_item() -> u8 { 3 }\n',
  // Deliberately NOT under `src-app/server` — this is the reference scope's outer edge.
  'src-app/consumers/consumer/src/lib.rs': 'fn use_far() -> u8 { far_item() }\n',
  // Declared at the crate ROOT, not under `modules/` — the declaration scope's inner edge.
  'src-app/server/src/permissions.rs':
    'pub fn root_item() -> u8 { 4 }\nfn root_caller() -> u8 { root_item() }\n',
  // OUTSIDE the declaration scope: unconsumed, and must never be reported.
  'src-app/consumers/consumer/src/orphaned_but_out_of_scope.rs':
    'pub fn outside_item() -> u8 { 5 }\n',
};

/** Every consumed name that must NEVER appear in the guard's output. */
const MUST_NOT_BE_REPORTED = /\b(?:used_item|far_item|root_item|outside_item)\b/;

// TEST-1 [acceptance] [invariant: INV-1] — the guard still BITES.
test('TEST-1 a `pub` item nothing consumes is named as a NEW ORPHAN and the guard exits 1', () => {
  const dir = fixture(
    {},
    {
      ...CONSUMED,
      'src-app/server/src/modules/demo/lonely.rs':
        '// a capability built and never wired — exactly the #295 shape\n' +
        'pub async fn set_grace_window(days: i32) -> i32 { days }\n',
      // Declared at the crate ROOT, outside `modules/`, and unconsumed. It must be REPORTED.
      // A consumed root item (CONSUMED's `root_item`) cannot carry this: narrowing the
      // declaration glob to `…/modules/demo` merely drops a name that was never an orphan,
      // so that mutation survived. An UNCONSUMED one out there is what makes the narrowing
      // observable — it is the "guard quietly stopped LOOKING at most of the crate" case.
      'src-app/server/src/root_orphan.rs': 'pub fn root_orphan_item() -> u8 { 7 }\n',
      // An orphan whose name is a SUBSTRING of a consumed identifier. Dropping the `\\b`
      // word boundaries from the guard's reference regex makes `used_item` count as a
      // consumer of `used_ite`, i.e. prose-free blinding by coincidence of spelling. Nothing
      // in the suite killed that mutation before this fixture.
      'src-app/server/src/modules/demo/substring.rs': 'pub fn used_ite() -> u8 { 8 }\n',
      // Named ONLY in prose. A name in a comment is not a consumer — this must still be
      // reported, or the guard can be blinded by writing about the thing it should flag.
      'src-app/server/src/modules/demo/talked_about.rs':
        'pub fn comment_only_item() -> u8 { 6 }\n',
      'src-app/server/src/modules/demo/prose.rs':
        '// `comment_only_item` is mentioned here and nowhere else.\n' +
        '/// comment_only_item again, in a doc comment.\n',
    },
  );
  const { status, all } = runGuard(dir);
  assert.equal(status, 1, `the guard must FAIL on an unconsumed pub item.\n${all}`);
  assert.match(all, /NEW ORPHAN\(S\)/, all);
  assert.match(all, /src-app\/server\/src\/modules\/demo\/lonely\.rs:2\s+set_grace_window/, all);
  assert.match(
    all,
    /talked_about\.rs:1\s+comment_only_item/,
    `a name that appears only in comments has no consumer and must still be reported.\n${all}`,
  );
  assert.match(
    all,
    /root_orphan\.rs:1\s+root_orphan_item/,
    `an unconsumed pub item OUTSIDE modules/ is still in the declaration scope.\n${all}`,
  );
  assert.match(
    all,
    /substring\.rs:1\s+used_ite\b/,
    `a name that is only a SUBSTRING of a consumed identifier has no consumer.\n${all}`,
  );
  // The positive control: NO consumed item — in either scope — is swept up in the same
  // breath, and the item outside the declaration scope is not claimed at all.
  assert.doesNotMatch(
    all,
    MUST_NOT_BE_REPORTED,
    `a consumed item, or one outside the declaration scope, must not be reported.\n${all}`,
  );
});

// TEST-2 [acceptance] [invariant: INV-3] — the ratchet fails in BOTH directions.
test('TEST-2 the exact-match ledger fails on a stale pin, and only an exact match exits 0', () => {
  // (a) pinned, but the item IS consumed → STALE, exit 1. A ratchet that only tightens
  //     decays into a list nobody remembers was meant to be temporary.
  const stale = fixture({ used_item: 'demo/repository.rs — a stated reason.' }, { ...CONSUMED });
  const a = runGuard(stale);
  assert.equal(a.status, 1, `a pinned-but-consumed entry must FAIL.\n${a.all}`);
  assert.match(a.all, /STALE LEDGER ENTR\(Y\/IES\)/, a.all);
  assert.match(a.all, /\bused_item\b/, a.all);

  // (b) the SAME tree with the SAME orphan pinned correctly → exit 0. Without this control
  //     "exits 1" would be indistinguishable from a guard that fails on everything.
  const files = {
    ...CONSUMED,
    'src-app/server/src/modules/demo/lonely.rs': 'pub fn parked_item() -> u8 { 2 }\n',
  };
  const pinned = fixture({ parked_item: 'demo/lonely.rs — debt with a named plan.' }, files);
  const b = runGuard(pinned);
  assert.equal(b.status, 0, `an exactly-matching floor must PASS.\n${b.all}`);
  assert.match(b.all, /the orphan set is exactly the pinned floor/, b.all);

  // (c) the same orphan, unpinned → NEW ORPHAN, exit 1. Same tree, ledger the only variable.
  const unpinned = fixture({}, files);
  const c = runGuard(unpinned);
  assert.equal(c.status, 1, `dropping the pin must redden the same tree.\n${c.all}`);
  assert.match(c.all, /NEW ORPHAN\(S\)[\s\S]*parked_item/, c.all);
});

/**
 * The shipped `LEDGER` object, read out of the guard's own source.
 *
 * The literal is data (string concatenations + comments), so evaluating it is how these
 * controls read the SAME object the guard uses rather than a re-typed copy that can drift.
 */
function shippedLedger() {
  const m = GUARD_SRC.match(LEDGER_RE);
  assert.ok(m, 'the shipped LEDGER literal could not be located — fix LEDGER_RE');
  return new Function(`return ${m[0].replace(/^const LEDGER = /, '').replace(/;$/, '')}`)();
}

/**
 * The real server crate, read once: every `.rs` file in the guard's DECLARATION scope, and
 * name -> the files that declare it.
 *
 * The declaration grammar is READ OUT OF THE GUARD (`const DECL = /…/;`) rather than
 * re-typed here, so a change to what the guard considers a declaration flows into this
 * control instead of silently drifting from it. That coupling has already earned itself:
 * dropping `struct` from the guard's alternation is caught by this test and by nothing else.
 *
 * ALL declaring files are kept, not the first. A name CAN be declared twice in the crate
 * (`PENDING` was — that is #308), and `find` output is readdir order, so keeping only the
 * first made the verdict depend on a filename. `.some()` over the whole list is what makes
 * this deterministic; the `.sort()` only stabilises the diagnostic.
 */
function realCrate() {
  const m = GUARD_SRC.match(/^const DECL = (\/.*\/);$/m);
  assert.ok(m, "the guard's DECL regex could not be located — fix this matcher, not the test");
  const decl = new Function(`return ${m[1]}`)();
  const files = execSync("find src-app/server/src -name '*.rs' -not -path '*/target/*'", {
    cwd: REPO,
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter(Boolean)
    .sort();
  const where = new Map();
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(REPO, f), 'utf8').split('\n')) {
      const d = line.match(decl);
      if (d) {
        if (!where.has(d[1])) where.set(d[1], []);
        if (!where.get(d[1]).includes(f)) where.get(d[1]).push(f);
      }
    }
  }
  return { files, where };
}

// TEST-3 [acceptance] [invariant: INV-2] — every pin cites the file that really declares it.
//
// WHAT IS MACHINE-CHECKED, AND WHAT IS NOT. Stated first because four blind rounds in a row
// caught an earlier version of this comment claiming more than the code did.
//
// CHECKED — a fact about the tree, not a property of the prose: the entry opens with a file
// path, that path resolves UNIQUELY in the crate, and the file it resolves to really
// declares the pinned item. It cannot be satisfied by rewording, only by being right, and it
// reddens the day a pinned item moves, is renamed, is deleted, is de-`pub`'d, or is cited to
// a file that does not declare it. Those are the ways a ledger rots.
//
// NOT CHECKED — whether a truthful, specific citation is followed by a GOOD reason. Three
// successive attempts to machine-check that failed, each in a different way: a length floor
// passed anything wordy; an anchored refusal list could never fire at all; and the length
// floor restored in its place both refused honest short reasons ("consumed only through a
// macro expansion" is 38 chars, and 20 `z`s passed) and still let seven pins be hollowed by
// repeating the citation. A hand-written pattern standing in for a SEMANTIC property has an
// unbounded evasion space; the lifecycle's guard-substitution tripwire fired on exactly this
// and its instruction is not to write a better predicate. So there is no predicate here.
// Whether the shipped dispositions are adequate — nine of the twelve are a bare "Debt,
// pre-existing." with no named plan — is a HUMAN judgement, filed as #309.
//
// It reads real declaration FILES but not the tree's ORPHAN SET: a new orphan on main cannot
// redden it. A citation that stops resolving uniquely can, and that is correct — an
// unfollowable citation is a defect in the GUARD's own floor, which is what a controls leg
// exists to invalidate a PASS for.
test('TEST-3 every shipped LEDGER pin cites the file that really declares it', () => {
  const ledger = shippedLedger();
  assert.ok(Object.keys(ledger).length > 0, 'an empty ledger is a floor deleted, not a floor met');
  // LEDGER_RE is non-greedy, so a reshape putting a `\n};` inside the literal would make it
  // match a PREFIX and this test would silently check fewer pins than ship. Two earlier
  // attempts at detecting that both failed, in opposite directions: counting entry lines
  // INSIDE the match is a tautology (both sides come from the same truncated block), and
  // scanning the text AFTER it for entry-shaped lines false-reds on any ordinary `{ cwd:
  // REPO }` further down the guard. Assert the SPAN instead — pure structure, no prose: the
  // match must end exactly where the literal ends, at the last `\n};` before `const DECL`.
  const block = GUARD_SRC.match(LEDGER_RE)[0];
  const declIdx = GUARD_SRC.indexOf('\nconst DECL =');
  assert.ok(declIdx > 0, 'the guard no longer has a `const DECL` after its LEDGER — fix this matcher');
  assert.equal(
    GUARD_SRC.indexOf(block) + block.length,
    GUARD_SRC.lastIndexOf('\n};', declIdx) + 3,
    'the parsed LEDGER does not reach the end of the literal — LEDGER_RE matched a PREFIX, ' +
      'so this test is checking fewer pins than the guard ships',
  );

  const { files, where } = realCrate();
  for (const [name, reason] of Object.entries(ledger)) {
    assert.equal(typeof reason, 'string', `${name}: the reason must be a string`);
    const raw = (reason.match(/^\s*([A-Za-z0-9_/.-]+\.rs)\b/) || [])[1];
    assert.ok(
      raw,
      `${name}: the reason must OPEN with the declaring file so a reader can go check it ` +
        `(got ${JSON.stringify(reason.replace(/\s+/g, ' ').trim())})`,
    );
    // Normalise before resolving: `./a/b.rs`, `a//b.rs` and `a/../a/b.rs` all name the same
    // file and were being rejected as if they named none.
    const cited = path.normalize(raw).replace(/^\.\//, '');

    // The citation must resolve to EXACTLY ONE file in the crate. The earlier rule asked
    // only whether the BASENAME was ambiguous and then accepted any citation containing a
    // slash — so `project_extension/repository.rs` (two real files) and
    // `project_extension/extension.rs` (three) both passed while being exactly as
    // unfollowable as the bare basename the rule was written to refuse.
    const resolved = files.filter((f) => f === cited || f.endsWith(`/${cited}`));
    assert.equal(
      resolved.length,
      1,
      resolved.length === 0
        ? `${name}: "${cited}" matches no file in src-app/server/src`
        : `${name}: "${cited}" matches ${resolved.length} files (${resolved.join(', ')}) — ` +
            'cite enough of the path for a reader to land on one',
    );

    const real = where.get(name);
    assert.ok(
      real,
      `${name}: pinned, but no such \`pub\` declaration exists in src-app/server/src — a pin ` +
        'for an item that is gone is a floor that can be silently re-spent',
    );
    // Any of the declaring files may be the cited one. `f === cited` counts: the FULL path is
    // the most precise citation possible, and an earlier `endsWith('/' + cited)` alone
    // rejected exactly that, printing the same path on both sides of the diagnostic.
    // LIMIT: under a name collision this accepts a citation to EITHER declaring file. That is
    // #308's name-keyed ledger, not something this control can resolve.
    assert.ok(
      real.includes(resolved[0]),
      `${name}: the pin cites ${cited} but the declaration is at ${real.join(', ')} — a ` +
        'citation a reader cannot follow is not a stated reason',
    );
  }
});


// TEST-4 — the summary line the controls (and every reader) rely on says what it means.
//
// This deliberately does NOT run the real tree. Two reasons, both learned the hard way in
// review: (a) the real scan is already the `check-pub-orphans` leg that runs two lines
// later in `check-invariants`, so duplicating it doubles the recipe's cost and buys the
// same bit; (b) worse, it would make an ORDINARY new orphan redden the CONTROLS leg —
// and a controls leg is declared to the runner as the leg whose failure invalidates every
// other verdict, so a routine orphan would print "everything above is unverified" over
// unrelated, correct results. The controls must speak only about whether the GUARD works.
//
// The floor is asserted as an equality between what the guard REPORTS and a ledger the
// TEST supplies — two genuinely independent sources. Reading both sides out of the same
// shipped literal would be a tautology in the direction that literal changes
// (`derived-guards.md` §4); a hardcoded count would be the frozen cardinality §4 refuses.
test('TEST-4 the reported floor is the ledger the guard was given, and the summary parses', () => {
  const ledger = {
    parked_one: 'demo/lonely.rs — debt with a named plan: removed with the recipe rewrite.',
    // The `$&` is deliberate: under a STRING replacement it would splice the whole matched
    // ledger back in and produce a broken guard copy. It is the control for the function
    // replacer in `fixture()`.
    parked_two:
      'demo/lonelier.rs — consumed only through a macro expansion (`m!($&)`) this counter cannot see.',
  };
  const dir = fixture(ledger, {
    ...CONSUMED,
    'src-app/server/src/modules/demo/lonely.rs': 'pub fn parked_one() -> u8 { 1 }\n',
    'src-app/server/src/modules/demo/lonelier.rs': 'pub fn parked_two() -> u8 { 2 }\n',
  });
  const { status, all } = runGuard(dir);
  assert.equal(status, 0, `an exactly-matching floor must PASS.\n${all}`);
  const reported = all.match(/ledger pins (\d+)/);
  assert.ok(reported, `the summary line did not report a floor:\n${all}`);
  assert.equal(
    Number(reported[1]),
    Object.keys(ledger).length,
    'the floor the guard reports must be the ledger it was given',
  );
  assert.match(all, /(\d+) pub item\(s\) in the lib crate, (\d+) with no consumer/, all);

  // A RED fixture where the pinned count and the orphan count DIFFER. Every green fixture
  // forces `pins == orphans == found`, so on those the summary could print any of the three
  // and still read correctly — mutating it to `orphans.length` survived the whole suite.
  // Here: 2 pins, 3 orphans. Only the ledger's own size can produce "ledger pins 2".
  const redFiles = {
    ...CONSUMED,
    'src-app/server/src/modules/demo/lonely.rs': 'pub fn parked_one() -> u8 { 1 }\n',
    'src-app/server/src/modules/demo/lonelier.rs': 'pub fn parked_two() -> u8 { 2 }\n',
    'src-app/server/src/modules/demo/loneliest.rs': 'pub fn unpinned_third() -> u8 { 3 }\n',
  };
  const redDir = fixture(ledger, redFiles);
  const red = runGuard(redDir);
  assert.equal(red.status, 1, `an unpinned third orphan must FAIL.\n${red.all}`);
  assert.match(
    red.all,
    /3 with no consumer \(ledger pins 2\)/,
    `the floor must track the LEDGER, not the orphan set.\n${red.all}`,
  );
  // The DECLARATION count was shape-checked but never value-checked, so mutating it to the
  // orphan count survived. The expected number is COUNTED FROM THE FIXTURE — a hardcoded 6
  // is the frozen cardinality this same test refuses forty lines above, and it made adding
  // one entry to the shared CONSUMED map redden TEST-4 and blame the guard for a test edit.
  const declRe = new Function(`return ${GUARD_SRC.match(/^const DECL = (\/.*\/);$/m)[1]}`)();
  const inScopeDecls = Object.entries(redFiles)
    .filter(([f]) => f.startsWith('src-app/server/src/'))
    .flatMap(([, body]) => body.split('\n'))
    .filter((l) => declRe.test(l)).length;
  assert.match(
    red.all,
    new RegExp(`^check-pub-orphans: ${inScopeDecls} pub item\\(s\\) in the lib crate`, 'm'),
    `the declaration count must be the declarations, not the orphans.\n${red.all}`,
  );
});
