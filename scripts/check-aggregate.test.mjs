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
  const r = spawnSync('bash', [RUNNER, ...args], {
    input: legLines.join('\n') + (legLines.length ? '\n' : ''),
    cwd,
    encoding: 'utf8',
  });
  assert.equal(r.error, undefined, `spawning the runner failed: ${r.error}`);
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
 * them together and nothing reddens — `docs/design/derived-guards.md` §4's "a derivation
 * whose two sides read the same source is a tautology in the direction that source
 * changes". This constant is the frozen half that §4 prescribes alongside the derivation.
 * Adding a leg never needs it edited; REMOVING one does, and this file's sha256 is pinned
 * in `scripts/guard-hashes.txt`, so that edit lands in a diff a reviewer reads.
 */
const MIN_LEGS_FLOOR = 10;

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
  const design = fs.readFileSync(path.join(REPO, 'docs/design/aggregate-gate-reporting.md'), 'utf8');
  const section = design.split('## §5 Non-negotiables', 2)[1];
  assert.ok(section, 'aggregate-gate-reporting.md must still declare a `## §5 Non-negotiables` section');
  for (const inv of ['INV-1', 'INV-2', 'INV-3', 'INV-4']) {
    assert.match(section, new RegExp(`\\*\\*${inv}\\*\\*`), `${inv} is missing from the design's non-negotiables`);
  }
});

// ── TEST-12 ─────────────────────────────────────────────────────────────────────────
test('TEST-12 the rewritten `check:` block still parses for its one existing text consumer', () => {
  // `src-app/packages/differential-expression/tests/test_rootfs_deps_r.py` reads this
  // recipe as TEXT with exactly this algorithm and asserts the R regime leg is in it.
  // Re-asserted here so a future edit to the recipe's SHAPE fails in the same run that
  // makes it, rather than in someone else's package suite.
  const justfile = fs.readFileSync(path.join(REPO, 'justfile'), 'utf8');
  const block = justfile.split('\ncheck:', 2)[1].split('\n\n', 1)[0];
  assert.ok(block.length > 0, 'the `check:` block parsed empty — a blank line has been introduced into it');
  assert.ok(
    block.includes('check-r-regime'),
    '`just check` must still include the R regime suite, and the existing pytest that ' +
      'asserts it reads this exact slice of the justfile',
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
    seen.size >= 9,
    `the walk reached only ${seen.size} recipe(s) from \`check\` (expected at least 9: ` +
      `${[...seen].join(', ')}). A gate has left the tree, or the walk broke.`,
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
  for (const name of ['cargo', 'npm', 'node', 'just']) {
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
 * derived leg list (`docs/design/derived-guards.md` §4: derive the membership, freeze the
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
  'npm run check',
  'npm run build',
  'just check-py',
  'just check-packages',
  'just check-coercion',
  'just check-processor-versions',
  'just check-invariants',
  'just check-r-regime',
];

// ── TEST-17 [acceptance] [invariant: INV-1] ─────────────────────────────────────────
test('TEST-17 [acceptance] [invariant: INV-1] the REAL `just check` runs every gate when one fails', () => {
  // Fail the ui type-check — the leg that was actually red on main and that made seven
  // gates unreachable in the first place.
  const { invocations, status } = runRealJustCheck({ fail: 'npm run check' });
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
  // EVERY gate, one at a time — not a sample. Forcing only three of the ten left the other
  // seven able to be made unable to fail (` || true`, `&`, a redirect) with the suite green.
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
// open by omission. A floor is RAISED with the set it guards; `docs/design/derived-guards.md` §5
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
const AGGREGATE_FLOORS = {
  check: 10,
  'check-invariants': 9,
  'check-guards': 9,
  'check-packages': 2,
  'check-processor-versions': 3,
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
const REACHABLE_FROM_CHECK = [
  "check",
  "check-coercion",
  "check-domain",
  "check-guards",
  "check-invariants",
  "check-packages",
  "check-processor-versions",
  "check-py",
  "check-r-regime"
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
 * check                      c9bdcd8be56f9318ca84de8228e9f0b608e1794b404f687fe8892b4cdef36b6d  8020d711dbfb0631a4f77dc62fb3d634374e9f65 THIS-CHANGE
 * check-coercion             d571dea18bc7b32d4eb1ac6cb0955af4d8e4679a9faa32ef3b54299c00e9b644  8020d711dbfb0631a4f77dc62fb3d634374e9f65 THIS-CHANGE
 * check-domain               bbb462d17850d2f630f4b1e3f267e008b02d540d33c62d18370c6ca1f40c2ab4  8020d711dbfb0631a4f77dc62fb3d634374e9f65 THIS-CHANGE
 * check-guards               310717a171295e01606aaa790d90c742988e5aa5d3f047b61746658802ac4990  eaf2a71be9793f97a9642437d9de14d38f216475 8020d711dbfb0631a4f77dc62fb3d634374e9f65 THIS-CHANGE
 * check-invariants           aaec696e5ff37f56457c59c3a3954911cd93d4a85cea490d922ac57218a430fc  8020d711dbfb0631a4f77dc62fb3d634374e9f65 THIS-CHANGE
 * check-packages             45e578d674049dae499fe67dd307d5719f0ff0f63f5bc50752d1640bf067af4f  8020d711dbfb0631a4f77dc62fb3d634374e9f65 THIS-CHANGE
 * check-processor-versions   d7d82a9fbe447e08f37859c898b36acc32d57cd3d300e7651c99d9b045282567  8020d711dbfb0631a4f77dc62fb3d634374e9f65 THIS-CHANGE
 * check-py                   192a9f75fb6f4c8e5744fc53d1b7818e6c6536b876922943e22d850808eb0bb1  8020d711dbfb0631a4f77dc62fb3d634374e9f65 THIS-CHANGE
 * check-r-regime             5be5c88f59cd1247c8bfe08c12d47675006f30a7c82da0040d62cf1165a0ab9d  8020d711dbfb0631a4f77dc62fb3d634374e9f65 THIS-CHANGE
 * __directives__             9920e51a9625a1ab3e7cbfaff6b490420f35a5cca6918e0a28e1ec4151da88ba  8020d711dbfb0631a4f77dc62fb3d634374e9f65 THIS-CHANGE
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
 *   #355      ADDS `check-design-citations-controls node --test
 *             scripts/check-design-citations.test.mjs` immediately in front of
 *             `check-design-citations node scripts/check-design-citations.mjs`, and raises
 *             `--min-legs` 7 -> 9 with them. Nothing removed, no leg repointed, no floor
 *             lowered; both legs point at files pinned in `scripts/guard-hashes.txt`, so
 *             neither is a decoy. The guard fails when a `docs/design/` or `docs/research/`
 *             path cited anywhere in the tree is not on disk — #315, which nothing caught for
 *             months. STRENGTHENING. Establish it yourself: the only justfile hunk in this
 *             change is inside `check-invariants`, and `git diff -- justfile` is that hunk.
 *
 * check-guards      15fb39a2 -> 4493b447   (TWO reasons, do not expect one)
 *   cce0282e  ADDS `check-derived-vocabulary-controls node --test
 *             scripts/check-derived-vocabulary.test.mjs` in front of the guard it controls and
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
 * ── THE ANCHOR IS a9bc4c1c, NOT 2caaa6e9 ────────────────────────────────────────────────
 *
 * Stated exactly, because the first draft of this block said "unmoved since the pins were
 * introduced at 2caaa6e9" and a blind auditor following that pointer found TEN mismatches and
 * no explanation — the opposite of what a ledger is for. 2caaa6e9 (#287) introduced the
 * constant; a9bc4c1c (#287 R5) then changed the NORMALISER (the shebang, the parameter list and
 * the top-level directives joined the hash) and added `__directives__`, so every value in this
 * object moved there for a reason that has nothing to do with any recipe. `check-r-regime`'s
 * BODY genuinely moved at a9bc4c1c too — a bare `-eq 0` suite check became
 * `-lt {{R_REGIME_SUITE_FLOOR}}`. Since a9bc4c1c exactly three recipes have moved: `check-guards`
 * once, `check-invariants` twice and `check-processor-versions` once — the four rows above.
 */
const RECIPE_PINS = {
  "check": "c9bdcd8be56f9318ca84de8228e9f0b608e1794b404f687fe8892b4cdef36b6d",
  "check-coercion": "d571dea18bc7b32d4eb1ac6cb0955af4d8e4679a9faa32ef3b54299c00e9b644",
  "check-domain": "bbb462d17850d2f630f4b1e3f267e008b02d540d33c62d18370c6ca1f40c2ab4",
  "check-guards": "310717a171295e01606aaa790d90c742988e5aa5d3f047b61746658802ac4990",
  "check-invariants": "aaec696e5ff37f56457c59c3a3954911cd93d4a85cea490d922ac57218a430fc",
  "check-packages": "45e578d674049dae499fe67dd307d5719f0ff0f63f5bc50752d1640bf067af4f",
  "check-processor-versions": "d7d82a9fbe447e08f37859c898b36acc32d57cd3d300e7651c99d9b045282567",
  "check-py": "192a9f75fb6f4c8e5744fc53d1b7818e6c6536b876922943e22d850808eb0bb1",
  "check-r-regime": "5be5c88f59cd1247c8bfe08c12d47675006f30a7c82da0040d62cf1165a0ab9d",
  "__directives__": "9920e51a9625a1ab3e7cbfaff6b490420f35a5cca6918e0a28e1ec4151da88ba"
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
