#!/usr/bin/env node
// check-design-citations.test.mjs — the NEGATIVE CONTROLS for
// `scripts/check-design-citations.mjs` (#355).
//
// ── WHY ─────────────────────────────────────────────────────────────────────────
// A check that cannot discriminate is indistinguishable from no check. #355 asks for the
// mutation proof in as many words — delete a genuinely-cited design document and show every
// citing site named; plant a citation to a document that does not exist and show it caught —
// and a one-off "I deleted a file and watched it go red" proves the guard bit on the day
// somebody typed it and nothing about tomorrow. So the bite is a COMMITTED control.
//
// Every assertion below DRIVES the real guard as a subprocess over a synthetic repository and
// reads the child's OWN exit status, never a status observed through a pipe — which reports
// the last pipeline element's code and has produced a false green in this tree more than once.
//
// ── WHAT IS SYNTHETIC AND WHAT IS REAL ──────────────────────────────────────────
// The guard resolves its repo root from its own location (`dirname(script)/..`), so copying
// the REAL guard file into a temporary git repository makes the TREE the variable. Three
// object literals are substituted in the copy — `KNOWN_DANGLING`, `BOUNDS` and `SELF_EXEMPT` —
// because all three are part of the GUARD rather than part of its input, and a synthetic tree
// of four files cannot satisfy floors measured on a tree of 3,731. Each substitution is
// asserted to have actually happened, so a future reshape of the guard cannot silently turn
// these controls into a no-op.
//
// No control here scans the real tree. That is the `check-design-citations` leg's own job, and
// a control that reddened for an ordinary new dangling citation would misattribute a TREE
// problem to the GUARD. The two deliberate exceptions are TEST-11 and TEST-12, which read the
// SHIPPED `KNOWN_DANGLING` and `SELF_EXEMPT` — those are part of the guard, not the tree.
//
//   node --test scripts/check-design-citations.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(SCRIPTS_DIR, '..');
const GUARD_REL = 'scripts/check-design-citations.mjs';
const GUARD = path.join(REPO, GUARD_REL);
const GUARD_SRC = fs.readFileSync(GUARD, 'utf8');

const KNOWN_DANGLING_RE = /const KNOWN_DANGLING = \{[\s\S]*?\n\};/;
const BOUNDS_RE = /const BOUNDS = \{[\s\S]*?\n\};/;
const SELF_EXEMPT_RE = /const SELF_EXEMPT = \[[^\]]*\];/;

/** Bounds that a four-file synthetic tree can satisfy; individual tests override. */
const OPEN_BOUNDS = { textFiles: 1, roots: {}, citationSites: 0, distinctPaths: 0, registerCap: 9 };

const TMPDIRS = [];
process.on('exit', () => {
  for (const d of TMPDIRS) fs.rmSync(d, { recursive: true, force: true });
});

/**
 * A synthetic git repository holding the REAL guard (with its three literals substituted).
 *
 * The copied guard is itself in `SELF_EXEMPT` by default, for the same reason the shipped one
 * is: it spells dangling paths in its own header prose in order to explain what it hunts.
 * TEST-10 turns that off to prove the exemption is doing real work rather than decorating.
 *
 * `files` maps a repo-relative path to its contents; a `Buffer` value is written verbatim,
 * which is how the binary-sniff control gets a NUL byte into the tree. The tree is `git
 * init`ed and `git add`ed because the guard's surface is DERIVED from `git ls-files` — an
 * untracked file is not the tree, and the controls have to honour that to exercise the real
 * derivation rather than a weaker stand-in.
 */
function fixture({ files, register = {}, bounds = OPEN_BOUNDS, selfExempt = [GUARD_REL] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-citations-ctl-'));
  TMPDIRS.push(dir);

  // FUNCTION replacers, never string ones: in a string replacement `$&`, `` $` ``, `$'` and
  // `$$` are replacement PATTERNS, so a fixture reason carrying one would splice the matched
  // literal back in and produce a nonsense guard copy. (`check-pub-orphans.test.mjs` records
  // the same lesson; TEST-13 below carries a literal `$&` as the control for it.)
  let patched = GUARD_SRC.replace(
    KNOWN_DANGLING_RE,
    () => `const KNOWN_DANGLING = ${JSON.stringify(register)};`,
  );
  assert.notEqual(patched, GUARD_SRC, 'the KNOWN_DANGLING literal was not substituted — the guard has been reshaped');
  let next = patched.replace(BOUNDS_RE, () => `const BOUNDS = ${JSON.stringify(bounds)};`);
  assert.notEqual(next, patched, 'the BOUNDS literal was not substituted — the guard has been reshaped');
  patched = next;
  next = patched.replace(SELF_EXEMPT_RE, () => `const SELF_EXEMPT = ${JSON.stringify(selfExempt)};`);
  assert.notEqual(next, patched, 'the SELF_EXEMPT literal was not substituted — the guard has been reshaped');
  patched = next;

  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, GUARD_REL), patched, 'utf8');
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (Buffer.isBuffer(body)) fs.writeFileSync(abs, body);
    else fs.writeFileSync(abs, body, 'utf8');
  }
  execFileSync('git', ['-C', dir, 'init', '-q'], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: 'ignore' });
  return dir;
}

/** Run the guard in a synthetic repo and return its OWN status plus its output. */
function run(dir, args = []) {
  const r = spawnSync(process.execPath, [path.join(dir, GUARD_REL), ...args], { encoding: 'utf8' });
  assert.equal(r.error, undefined, `spawning the guard failed: ${r.error}`);
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

// ── TEST-1 ──────────────────────────────────────────────────────────────────────────
// The mutation #355 asks for, in both halves: a genuinely-cited document is REMOVED, and
// every citing site is named. Two files, three sites, at three different line numbers.
test('TEST-1 a cited design document that is absent is reported at every citing site, with its line', () => {
  const cited = 'docs/design/storage-layout.md';
  const dir = fixture({
    files: {
      'docs/design/present.md': '# present\n',
      'src-app/a.py': `"""\nRealizes \`${cited}\` section 6.4.\n"""\n`,
      'src-app/b.rs': `//! one\n//! two\n//! see \`${cited}\` and \`docs/design/present.md\`\n`,
      'src-app/c.md': `A line.\nAnother.\nAnd \`${cited}\` again.\n`,
    },
  });
  const { status, out } = run(dir);
  assert.equal(status, 1, `expected exit 1, got ${status}:\n${out}`);
  assert.match(out, new RegExp(`${cited}\\s+-- no such path`));
  // NAMING WHAT IS WRONG, not that something is: file, line and cited path, per site.
  assert.match(out, /cited by src-app\/a\.py:2/);
  assert.match(out, /cited by src-app\/b\.rs:3/);
  assert.match(out, /cited by src-app\/c\.md:3/);
  // ...and the document that IS present is not reported.
  assert.ok(!out.includes('docs/design/present.md   -- no such path'), out);
});

// ── TEST-2 ──────────────────────────────────────────────────────────────────────────
// RESTORE, and it goes green. The same tree with the document put back. Without this half,
// TEST-1 is satisfied by a guard that fails on everything.
test('TEST-2 the same tree passes once the document is restored', () => {
  const cited = 'docs/design/storage-layout.md';
  const dir = fixture({
    files: {
      'docs/design/storage-layout.md': '# storage layout\n',
      'src-app/a.py': `"""\nRealizes \`${cited}\` section 6.4.\n"""\n`,
      'src-app/b.rs': `//! see \`${cited}\`\n`,
    },
  });
  const { status, out } = run(dir);
  assert.equal(status, 0, `expected exit 0, got ${status}:\n${out}`);
  assert.match(out, /PASS check-design-citations/);
});

// ── TEST-3 ──────────────────────────────────────────────────────────────────────────
// The cry-wolf controls. This tree has had prose-scanning guards fire on legitimate English
// three times in one day — on the words "feature" and "invitation", and on a wire-measurement
// scan — and a guard people switch off enforces nothing. All four sentences below are correct
// English about paths that do or do not exist, and none of them may fail the build.
test('TEST-3 passing mentions, glob forms, fenced examples and URLs do not fail the build', () => {
  const dir = fixture({
    files: {
      'docs/design/real.md': '# real\n',
      // A markdown fence holding a shell transcript that DEMONSTRATES a path is absent —
      // exactly what this repository's issue prose does routinely.
      'docs/notes.md':
        'Prose citing `docs/design/real.md`.\n' +
        '\n' +
        '```\n' +
        '$ git cat-file -e origin/main:docs/design/gone-for-the-example.md\n' +
        'fatal: Not a valid object name\n' +
        '```\n' +
        '\n' +
        '~~~sh\n' +
        'ls docs/research/also-not-here.md\n' +
        '~~~\n',
      // A path inside a third-party documentation URL.
      'src-app/x.ts': '// see https://example.invalid/docs/design/their-doc.md for the upstream rule\n',
      // The forms an English sentence uses to talk about the DIRECTORY rather than a document.
      'src-app/y.ts':
        '// Every file under docs/design/ is a design record; `docs/design/*.md` are the\n' +
        '// documents and `docs/design/<name>.md` is how this comment refers to one.\n',
    },
  });
  const { status, out } = run(dir);
  assert.equal(status, 0, `a legitimate sentence failed the build (exit ${status}):\n${out}`);
});

// ── TEST-4 ──────────────────────────────────────────────────────────────────────────
// ...and the fence exclusion is a HOLE, not a feature. The same path OUTSIDE a fence is
// caught, in the same file. Stating the hole is what makes it something other than a
// silent gap: a citation that appears only inside a fence is unchecked.
test('TEST-4 the fence exclusion is bounded — the same path outside the fence is caught', () => {
  const body = (extra) =>
    '```\n$ cat docs/design/only-an-example.md\n```\n' + extra;
  const green = fixture({ files: { 'docs/notes.md': body('') } });
  assert.equal(run(green).status, 0, 'a path inside a fence must not fail the build');

  const red = fixture({ files: { 'docs/notes.md': body('\nRealizes `docs/design/only-an-example.md` section 2.\n') } });
  const { status, out } = run(red);
  assert.equal(status, 1, `the same path outside the fence must be caught:\n${out}`);
  assert.match(out, /cited by docs\/notes\.md:5/);
  // The fenced occurrence on line 2 is NOT reported: the exclusion is real, not decorative.
  assert.ok(!out.includes('docs/notes.md:2'), out);
});

// ── TEST-5 ──────────────────────────────────────────────────────────────────────────
// The shapes a citation actually ships in: a sentence-final period, a line-number suffix, a
// directory reference, and a section number after the path.
test('TEST-5 trailing punctuation, line-number suffixes and directory citations resolve correctly', () => {
  const dir = fixture({
    files: {
      'docs/design/scale.md': '# scale\n',
      'docs/research/survey/01-a.md': '# a\n',
      'src-app/a.md':
        'Ends a sentence: see `docs/design/scale.md`.\n' +
        'With a line range: `docs/research/survey/01-a.md:67-71` is explicit.\n' +
        'With a section: `docs/design/scale.md` section 3.2 says so.\n' +
        'A directory: the survey lives at `docs/research/survey/`.\n',
    },
  });
  const { status, out } = run(dir);
  assert.equal(status, 0, `expected exit 0, got ${status}:\n${out}`);
  assert.match(out, /4 citation\(s\) at 3 distinct path\(s\)/);
});

// ── TEST-6 ──────────────────────────────────────────────────────────────────────────
// The register fails in BOTH directions, which is what makes it a register and not an
// allowlist. Three trees: registered-and-still-dangling passes; registered-and-restored
// fails; registered-and-uncited fails.
test('TEST-6 KNOWN_DANGLING tolerates only a path that is BOTH missing AND cited', () => {
  const cited = 'docs/design/gone.md';
  const register = { [cited]: '#368 — lives on a branch' };
  const citing = { 'src-app/a.py': `# see \`${cited}\`\n` };

  const tolerated = run(fixture({ files: citing, register }));
  assert.equal(tolerated.status, 0, `a registered, still-dangling citation must pass:\n${tolerated.out}`);

  const restored = run(fixture({ files: { ...citing, [cited]: '# gone, but back\n' }, register }));
  assert.equal(restored.status, 1, 'a registered path that now EXISTS must fail');
  assert.match(restored.out, /which now EXISTS\. Delete the entry/);

  const uncited = run(fixture({ files: { 'src-app/a.py': '# nothing here\n' }, register }));
  assert.equal(uncited.status, 1, 'a registered path nothing cites must fail');
  assert.match(uncited.out, /NOTHING CITES any more\. Delete the entry/);
});

// ── TEST-7 ──────────────────────────────────────────────────────────────────────────
// The cap. `derived-guards.md` §7.1.2 item 3: a cap on the number of DECLARATIONS is the one
// bound that does not decay, because it is compared against a count of declarations rather
// than against a count of files.
test('TEST-7 the register cap refuses one entry more than it is pinned at', () => {
  const files = { 'src-app/a.py': '# `docs/design/one.md` `docs/design/two.md`\n' };
  const register = { 'docs/design/one.md': 'r1', 'docs/design/two.md': 'r2' };
  assert.equal(run(fixture({ files, register, bounds: { ...OPEN_BOUNDS, registerCap: 2 } })).status, 0);
  const over = run(fixture({ files, register, bounds: { ...OPEN_BOUNDS, registerCap: 1 } }));
  assert.equal(over.status, 1, 'a register over its cap must fail');
  assert.match(over.out, /holds 2 entries; the cap is 1/);
});

// ── TEST-8 ──────────────────────────────────────────────────────────────────────────
// The liveness floors, PER ROOT. The tree below satisfies a combined floor comfortably and
// has walked one root to nothing — which is the exact shape `staleClaims.test.ts` records:
// one combined bound is satisfiable by a single root while another silently walks nothing.
test('TEST-8 a per-root floor catches a root that has collapsed while the total is met', () => {
  const files = {};
  for (let i = 0; i < 12; i++) files[`src-app/f${i}.ts`] = '// `docs/design/real.md`\n';
  files['docs/design/real.md'] = '# real\n';
  const total = { ...OPEN_BOUNDS, textFiles: 10 };
  assert.equal(run(fixture({ files, bounds: total })).status, 0, 'the total floor alone is met');

  const perRoot = run(fixture({ files, bounds: { ...total, roots: { 'src-app': 10, scripts: 3 } } }));
  assert.equal(perRoot.status, 1, 'a root walked to nothing must fail even when the total is met');
  assert.match(perRoot.out, /LIVENESS: the scanned file count under scripts\/ is 1, below the frozen floor of 3/);

  const sitesFloor = run(fixture({ files, bounds: { ...total, citationSites: 99 } }));
  assert.equal(sitesFloor.status, 1, 'a matcher that stopped matching must fail');
  assert.match(sitesFloor.out, /LIVENESS: the citation-site count is 12, below the frozen floor of 99/);
});

// ── TEST-9 ──────────────────────────────────────────────────────────────────────────
// An exemption naming nothing is not "a case that does not arise" — it is a guard switched
// off, and it looks identical from the outside (`derived-guards.md` §3).
test('TEST-9 a SELF_EXEMPT entry that names no file is a hard failure', () => {
  const dir = fixture({
    files: { 'docs/design/real.md': '# real\n', 'src-app/a.py': '# `docs/design/real.md`\n' },
    selfExempt: [GUARD_REL, 'scripts/no-such-guard.mjs'],
  });
  const { status, out } = run(dir);
  assert.equal(status, 1, 'a dead exemption must fail');
  assert.match(out, /SELF_EXEMPT names scripts\/no-such-guard\.mjs, which does not exist/);
});

// ── TEST-10 ─────────────────────────────────────────────────────────────────────────
// The exemption is not a hiding place: a file NAMED in SELF_EXEMPT really is skipped, so the
// green in TEST-3 and the shipped exemption of this very file are load-bearing rather than
// incidental — and a file NOT named is scanned.
test('TEST-10 SELF_EXEMPT skips exactly the file it names', () => {
  const files = {
    'scripts/decoy.mjs': "// plants `docs/design/planted.md`\n",
    'src-app/a.py': '# `docs/design/planted.md`\n',
  };
  const scanned = run(fixture({ files }));
  assert.equal(scanned.status, 1);
  assert.match(scanned.out, /cited by scripts\/decoy\.mjs:1/);
  assert.match(scanned.out, /cited by src-app\/a\.py:1/);

  const exempt = run(fixture({ files, selfExempt: [GUARD_REL, 'scripts/decoy.mjs'] }));
  assert.equal(exempt.status, 1, 'the OTHER site must still be caught');
  assert.ok(!exempt.out.includes('scripts/decoy.mjs:1'), exempt.out);
  assert.match(exempt.out, /cited by src-app\/a\.py:1/);
});

// ── TEST-11 ─────────────────────────────────────────────────────────────────────────
// Reads the SHIPPED register, because the register is part of the GUARD, not part of the
// tree. A row with no stated reason is a defect in the floor itself. What this does NOT do is
// care whether the tree has dangling citations — only whether each entry says why it is
// tolerated and which issue owns the repair.
test('TEST-11 every shipped KNOWN_DANGLING entry cites the issue that owns its repair', () => {
  const literal = KNOWN_DANGLING_RE.exec(GUARD_SRC);
  assert.ok(literal, 'the shipped KNOWN_DANGLING literal is unreadable — fix the regex, not this test');
  const entries = [...literal[0].matchAll(/'([^']+)':\s*\n?\s*'([^']*)'/g)];
  assert.ok(entries.length > 0, 'no KNOWN_DANGLING entries parsed');
  for (const [, cited, reason] of entries) {
    assert.match(cited, /^docs\/(design|research)\//, `${cited}: not a design or research path`);
    assert.match(reason, /#\d+/, `${cited}: the register entry names no issue`);
  }
  // ...and the cap is not slack. A cap sitting above the population is room a tenth entry can
  // arrive in without a second, visible line — the same slack `check-aggregate.test.mjs`
  // TEST-20 removed from AGGREGATE_FLOORS for exactly this reason.
  const cap = Number(/registerCap:\s*(\d+)/.exec(BOUNDS_RE.exec(GUARD_SRC)[0])[1]);
  assert.equal(cap, entries.length, 'registerCap must EQUAL the shipped register population');
});

// ── TEST-12 ─────────────────────────────────────────────────────────────────────────
// The shipped SELF_EXEMPT names this guard's own two files and nothing else. A third entry is
// an exemption for something that is not this guard, and it would arrive here rather than in
// a diff nobody reads.
test('TEST-12 the shipped SELF_EXEMPT names exactly this guard and this control suite', () => {
  const literal = SELF_EXEMPT_RE.exec(GUARD_SRC);
  assert.ok(literal, 'the shipped SELF_EXEMPT literal is unreadable');
  const named = [...literal[0].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(named, [GUARD_REL, 'scripts/check-design-citations.test.mjs']);
  for (const rel of named) assert.ok(fs.existsSync(path.join(REPO, rel)), `${rel} does not exist`);
});

// ── TEST-13 ─────────────────────────────────────────────────────────────────────────
// Decoding is named UTF-8 everywhere (#339: the locale-default decode defect has been closed
// four times in this tree). A non-ASCII byte before a citation must not shift its column or
// swallow it, and a `$&` in a register reason must not splice the guard back into itself.
test('TEST-13 non-ASCII text and a literal $& in a reason are handled', () => {
  const dir = fixture({
    files: {
      'src-app/a.py': '# Réalise « docs/design/absent-doc.md » — voir §6.4\n',
      'src-app/b.md': '# 参照 `docs/design/absent-doc.md`\n',
    },
    register: { 'docs/design/other.md': 'reason with $& and $` in it' },
  });
  const { status, out } = run(dir);
  assert.equal(status, 1);
  assert.match(out, /cited by src-app\/a\.py:1/);
  assert.match(out, /cited by src-app\/b\.md:1/);
  // The `$&` reason survived substitution intact rather than splicing the matched literal in.
  const patched = fs.readFileSync(path.join(dir, GUARD_REL), 'utf8');
  assert.ok(patched.includes('reason with $& and $` in it'), 'the reason was mangled by the replacer');
  assert.ok(!/const KNOWN_DANGLING = \{[\s\S]*const KNOWN_DANGLING/.test(patched), 'the literal was spliced into itself');
});

// ── TEST-14 ─────────────────────────────────────────────────────────────────────────
// A binary file is skipped by SNIFFING A NUL BYTE, never by extension, and skipping it does
// not abort the walk. "Did not run" and "found nothing" are the same bytes
// (`derived-guards.md` §7.1.2), so the skip is counted and reported.
test('TEST-14 a binary file is skipped by content, and the walk continues past it', () => {
  const dir = fixture({
    files: {
      'src-app/blob.dat': Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02, 0x03]),
      'src-app/a.py': '# `docs/design/absent-doc.md`\n',
    },
  });
  const { status, out } = run(dir);
  assert.equal(status, 1);
  assert.match(out, /cited by src-app\/a\.py:1/);
  assert.match(out, /\(1 binary skipped\)/);
});

// ── TEST-15 ─────────────────────────────────────────────────────────────────────────
// An untracked file is not the tree. The surface is DERIVED from `git ls-files`, and this is
// what proves it is that and not a filesystem walk wearing its name.
test('TEST-15 the surface is what git tracks, not what is on disk', () => {
  const dir = fixture({ files: { 'src-app/a.py': '# nothing\n' } });
  fs.writeFileSync(path.join(dir, 'src-app', 'untracked.py'), '# `docs/design/absent-doc.md`\n', 'utf8');
  assert.equal(run(dir).status, 0, 'an untracked file must not be scanned');
  execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: 'ignore' });
  const { status, out } = run(dir);
  assert.equal(status, 1, 'the same file, tracked, must be scanned');
  assert.match(out, /cited by src-app\/untracked\.py:1/);
});

// ── TEST-16 ─────────────────────────────────────────────────────────────────────────
// A FRAGMENT is not a citation, and this is the cry-wolf control for the one accident that
// produces fragments: a path split by a hard wrap or by a string concatenation.
// `staleClaims.test.ts` records a concatenation doing exactly this to a sentence it hunted.
// The ambiguous case fails OPEN — and the same test states the resulting hole out loud, so
// the fail-open is a decision rather than an oversight.
test('TEST-16 a wrapped or concatenated path is a fragment; an extensionless one is not', () => {
  const dir = fixture({
    files: {
      'docs/design/storage-layout.md': '# storage layout\n',
      // Hard-wrapped across a comment boundary...
      'src-app/a.py': '# Realizes `docs/design/storage-\n# layout.md` section 6.4.\n',
      // ...and split across a string concatenation.
      'src-app/b.ts': "const doc = 'docs/design/storage-' + 'layout.md'\n",
    },
  });
  const { status, out } = run(dir);
  assert.equal(status, 0, `a reflowed citation must not red the build:\n${out}`);

  // THE HOLE: because the fragment is ignored, a wrapped citation is UNCHECKED — the tree
  // below has no such document and still passes. Asserted rather than merely described, so
  // that a later change which does close it turns this red and says so.
  const unchecked = run(fixture({ files: { 'src-app/a.py': '# `docs/design/gone-\n# forever.md`\n' } }));
  assert.equal(unchecked.status, 0, 'the wrapped-citation hole is asserted, not assumed');

  // ...and the bound on the fail-open: an UNWRAPPED path in the same file is still caught.
  const caught = run(fixture({ files: { 'src-app/a.py': '# `docs/design/gone-\n# forever.md` and `docs/design/also-gone.md`\n' } }));
  assert.equal(caught.status, 1);
  assert.match(caught.out, /docs\/design\/also-gone\.md\s+-- no such path/);
  assert.match(caught.out, /cited by src-app\/a\.py:2/);

  // The fragment test is STRUCTURAL, and this is the half that keeps it from becoming an
  // exemption anyone can buy: an EXTENSIONLESS path in the middle of a line is still judged.
  // Dropping `.md` off a citation is not a wrap; it is three characters, and excusing it
  // would make the whole rule purchasable (`derived-guards.md` §5).
  const extensionless = run(fixture({ files: { 'src-app/a.py': '# see `docs/design/gone` for the rule\n' } }));
  assert.equal(extensionless.status, 1, 'an extensionless dangling path mid-line must still be caught');
  assert.match(extensionless.out, /docs\/design\/gone\s+-- no such path/);

  // ...and a DIRECTORY citation, which is extensionless by nature, is judged both ways.
  const dirOk = run(fixture({ files: { 'docs/design/sub/x.md': '#\n', 'src-app/a.py': '# under `docs/design/sub/`\n' } }));
  assert.equal(dirOk.status, 0, 'a directory citation that resolves must pass');
  const dirBad = run(fixture({ files: { 'src-app/a.py': '# under `docs/design/no-such-dir/`\n' } }));
  assert.equal(dirBad.status, 1, 'a directory citation that does not resolve must fail');
  assert.match(dirBad.out, /docs\/design\/no-such-dir\/\s+-- no such path/);
});

// ── TEST-17 ─────────────────────────────────────────────────────────────────────────
// `.` and `/` are both in the citation character set, so a citation can climb out of the
// repository. A bare `existsSync(join(REPO, cited))` answers TRUE for
// `docs/design/../../etc/hosts` and quietly accepts a pointer that names nothing in this
// tree — a fail-open, and the shape `derived-guards.md` §7.1.2 item 2 warns about, where
// "did not run" and "found nothing" print the same bytes.
test('TEST-17 a citation that escapes the repository root is reported, not silently accepted', () => {
  const dir = fixture({ files: { 'src-app/a.py': '# see `docs/design/../../../../etc/hosts`\n' } });
  const { status, out } = run(dir);
  assert.equal(status, 1, `a citation escaping the repo root must be reported:\n${out}`);
  assert.match(out, /cited by src-app\/a\.py:1/);
});
