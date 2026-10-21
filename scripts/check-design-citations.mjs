#!/usr/bin/env node
/**
 * **THE DESIGN-CITATION GATE — a `docs/design/` or `docs/research/` path cited in this tree
 * is a path a reader can open.**
 *
 * ## The bug this exists to stop (#315 / #355)
 *
 * `docs/design/spatial-storage-layout.md` was cited by seventeen sites and by roughly thirty
 * distinct section numbers — as the source of the write-time contract, of every placement
 * rule, and of the "required output of the importer" language that four issues rest on — at a
 * path that **was not in `origin/main`**. Nothing caught it. A person found it by following a
 * citation while planning #301, months after the first citation shipped, and had to lift the
 * invariants out of `git show e55b16ef:...` because there was nothing at the cited path to
 * read.
 *
 * Every such citation is a pointer a reader is invited to follow in order to check a claim.
 * This tree's own habit (#294) is that a claim whose evidence a reader cannot reach is the
 * next stale claim. The scanning machinery for this already existed three times over —
 * `libs/viz/src/viz-core/spatial/staleClaims.test.ts` walks four roots with a normalizer,
 * `spatial-types/tests/test_wire_measurement_strip_count.py` walks all of
 * `src-app/packages/`, and `scripts/check-viz-producer-magnitudes.mjs` walks `.ts`/`.tsx`/`.md`.
 * This is the same walk with a much cheaper predicate: does the path exist.
 *
 * ## THE SURFACE, stated exactly — an allowlist's honest description is its holes
 *
 * SCANNED: every file `git ls-files` reports with a regular-file mode (`100644` / `100755`),
 * decoded as UTF-8, whatever its extension. The surface is DERIVED from what git tracks
 * rather than from a glob of extensions, for the reason `docs/design/derived-guards.md` §7.1
 * gives at length: a glob typed into a guard drifts exactly the way a term list does, and
 * #303/#324 are two instances of that arriving one directory apart. A `.toml`, a `.yaml`, a
 * `.rs` docstring, a `README` and a manifest comment are all places a citation has actually
 * shipped in this tree, and a file type nobody has used yet is scanned the day it lands.
 *
 * NOT SCANNED, and each one is a hole rather than a tidy boundary:
 *
 *   * **anything git does not track.** Build output and scratch files are not the tree.
 *   * **symlinks (`120000`) and submodule gitlinks (`160000`).** A symlink's target is
 *     tracked in its own right and would be scanned twice; a gitlink is a different
 *     repository, whose citations resolve against ITS tree and not this one.
 *   * **binary files** — detected as a NUL byte in the first `BINARY_SNIFF_BYTES`, never by
 *     extension. The count is reported and floored, so "the binary filter swallowed the
 *     tree" cannot present as "no citations found".
 *   * **fenced code blocks in `.md` files** (``` and ~~~). A fenced block is a transcript or
 *     a worked example, not a citation; a shell transcript demonstrating that a path is
 *     ABSENT is a thing this repository's issue prose does routinely, and failing the build
 *     over it is the cry-wolf failure that gets a guard switched off. INLINE code spans
 *     (single backticks) are still scanned, and that is where citations in markdown actually
 *     live — so the exclusion is narrow. **The measured cost on this tree is zero: no cited
 *     `docs/design` or `docs/research` path appears only inside a fence.** The hole is that a
 *     citation which appears ONLY inside a fence is unchecked.
 *   * **URLs** — a match whose surrounding token contains `://` names a path on another host.
 *   * **this guard and its control suite**, by exact repo-relative path (`SELF_EXEMPT`). Both
 *     must spell dangling paths in order to hunt for them. This is not a hiding place: every
 *     entry is asserted below to actually be one of this guard's own files, and the control
 *     suite's whole job is to assert positively that the scanner reports what it is given.
 *
 * ## WHAT COUNTS AS A CITATION, and why the prefix is exactly these two
 *
 * A run of `docs/design/...` or `docs/research/...` in the scanned text, over the character
 * set `[A-Za-z0-9._/-]`, with trailing `.` characters trimmed (a citation at the end of an
 * English sentence ships in this tree, twice). Anything else that ordinarily follows a path —
 * a comma, a closing paren, a backtick, a quote, a `:` line-number suffix, a `§` — is outside
 * that character set and therefore already excluded. A run that is the visible HALF of a path
 * split by a wrap or a concatenation is a FRAGMENT and is skipped rather than judged; see
 * `citationsIn` for the structural test, why it is structural, and what it leaves open.
 *
 * The prefix is NOT widened to `docs/`, and the reason is measured rather than aesthetic. At
 * `f3f3ce03` the narrow prefix reports nine missing paths, all nine of them real. Widening to
 * `docs/` reports twenty-two, of which THIRTEEN are false: five are BRANCH names that begin
 * with `docs/` (`docs/spatial-design-revisions`, `docs/research-spatial-platforms`), five are
 * fragments of third-party documentation URLs (`docs/python/ipc.html`,
 * `docs/api-reference/layers/...`), and three are hypothetical directories named in prose
 * (`docs/scripts/`, which three files discuss precisely because nothing is there). A guard
 * that reds on thirteen correct sentences is the failure mode `derived-guards.md` §5 warns
 * about, and this repository has hit it three times in one day on the words "feature" and
 * "invitation" and on a wire-measurement scan. So the surface is the two directories where
 * this tree's design record actually lives, and the widening is refused with its cost shown.
 *
 * ## WHAT THIS DOES NOT BUY — section numbers, and why they are NOT checked
 *
 * A path that exists says nothing about whether the `§`-number inside it resolves, and
 * section resolution is deliberately out of scope. That is not a shrug; it is measured:
 *
 *   1. **There is no section-numbering convention to derive from.** Of the 36 markdown
 *      documents in `docs/design/`, six carry `§`-prefixed headings and thirty do not.
 *      `spatial-storage-layout.md` — the document carrying ~30 `§`-citations, the ones #315
 *      was filed over — has ZERO `§` headings: its sections are `## 6. Title` and
 *      `### 6.4 Title`. A `§`-checker would need a per-document heuristic over at least three
 *      heading dialects, which is an enumeration of conventions, i.e. `derived-guards.md`
 *      §1's failure class in the guard written to avoid it.
 *   2. **The live instances are not syntactic anyway.** #356 records two of them.
 *      `spatial-import-visium/tests/test_spatial_image.py:90` cites `§12.2 item 1` while
 *      quoting weakness 1 — `§12.2` EXISTS, so every possible existence check passes, and
 *      what is wrong is that the citation's two halves name different weaknesses. That is a
 *      predicate over a semantic property, which `derived-guards.md` §7.1 establishes has an
 *      unbounded evasion space. #356's other instance is a `manifest.yaml:386-422` line range
 *      that has drifted to `:446-482` — a LINE RANGE, which rots on every edit above it and
 *      is a third check again.
 *
 * **So: §-drift and line-range drift remain UNCAUGHT by this gate, and #356 is their live
 * instance.** This is the cheap half — the half that would have caught #315 on the day the
 * first citation landed — and saying which half it is, is the point.
 *
 * ## THE REGISTER (`KNOWN_DANGLING`) — a shrinking ledger, not an allowlist
 *
 * Nine cited paths were already missing when this gate was written (#368). They are carried
 * here rather than repaired because restoring eight documents from six unmerged branches is
 * #315 done eight more times, and four of the citing sites are under `src-app/packages/`
 * directories that sibling branches own (#300).
 *
 * It fails in BOTH directions, which is what makes it a register rather than a hiding place —
 * the shape `staleClaims.test.ts`'s `CORRECTED_BY_259_ALLOWED` and `check-pub-orphans.mjs`'s
 * `LEDGER` both use:
 *
 *   * a registered path that COMES TO EXIST is a hard failure. Restore the document and the
 *     row goes in the same diff.
 *   * a registered path that NOTHING CITES ANY MORE is a hard failure. Remove the last
 *     citation and the row goes in the same diff.
 *   * the register's SIZE is capped at its current population (`BOUNDS.registerCap`), so a
 *     tenth entry cannot arrive in the one diff that wanted it. `derived-guards.md` §7.1.2
 *     item 3 is the reason it is a cap on the number of DECLARATIONS and not a floor on a
 *     count of files: a cap does not decay.
 *
 * The second rule has a second job worth naming, because it is this guard's cheapest control:
 * **the shipped register is a permanent positive control for the matcher on the REAL tree.**
 * An empty regex, a never-firing matcher or a collapsed walk stops finding the nine registered
 * citations, and the "registered but no longer cited" rule turns that into a red — without any
 * synthetic fixture, and without the guard having to plant anything.
 *
 * ## FLOORS
 *
 * `BOUNDS` carries a liveness floor PER ROOT, not one combined bound, for the reason
 * `staleClaims.test.ts` states at length: a single combined bound is satisfiable by one root
 * while another silently walks nothing, and `src-app` is 94% of this tree, so a total-only
 * floor would still pass with `docs/` and `scripts/` entirely gone. A citation-existence check
 * that walks zero files is green forever.
 *
 * ## USAGE
 *
 *   node scripts/check-design-citations.mjs            # verify
 *   node scripts/check-design-citations.mjs --list     # print every citation and its verdict
 *
 * Exit 0 = every cited path resolves, or is registered. 1 = a dangling citation, a stale
 * register row, a breached floor, or an over-full register. 2 = tooling/repo broken.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The repository root, resolved from THIS FILE's own location and never from `process.cwd()`.
 *
 * `staleClaims.test.ts` argues this out: a run from a different directory would silently
 * re-scope the whole guard while still reporting green, which is the one failure mode a
 * tripwire cannot afford. It is also what lets the control suite make the TREE the variable —
 * it copies this file into a synthetic repo's `scripts/` and the walk follows.
 */
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(SCRIPT_PATH), '..');

/** A run of path characters after `docs/design/` or `docs/research/`. See the header. */
const CITATION_RE = /docs\/(?:design|research)\/[A-Za-z0-9._/-]*/g;

/** Characters that may surround a match without ending the token, for the URL test. */
const TOKEN_CHARS = /[A-Za-z0-9._/:~@%&?=+#-]/;

/** How much of a file is sniffed for a NUL byte before it is called binary. */
const BINARY_SNIFF_BYTES = 8192;

/**
 * This guard's own files, repo-relative. Both must SPELL dangling paths to hunt for them.
 *
 * Relative paths and not basenames, for the reason `staleClaims.test.ts` gives: a basename
 * exemption silently excuses every same-named file, which switches a guard off somewhere
 * nobody looked. Every entry is asserted below to be a file that exists, so an entry naming
 * nothing — a guard switched off, indistinguishable from the outside — is a hard failure.
 */
const SELF_EXEMPT = ['scripts/check-design-citations.mjs', 'scripts/check-design-citations.test.mjs'];

/**
 * Cited paths known to be missing, each with the issue that owns its repair (#368).
 *
 * NOT an allowlist. See the header: an entry whose path comes to exist fails, an entry
 * nothing cites any more fails, and the count is capped. The only way this object shrinks is
 * a document restored or a citation repointed — which is what #368 is for.
 *
 * The reasons record where each document actually lives, because that is the one thing a
 * reader following the citation needs and cannot get from the citation itself.
 */
const KNOWN_DANGLING = {
  'docs/design/metering-billing-quota.md':
    '#368 — added by 7f00c1e8, lives only on origin/design/metering-billing-quota',
  'docs/design/membership-rescope.md':
    '#368 — added by c50ab7bd, lives only on origin/spike/membership-rescope',
  'docs/research/account-self-service-membership.md':
    '#368 — added by be009a2e, lives only on origin/spike/research-account-membership',
  'docs/research/rna-velocity.md':
    '#368 — added by 4438e016, lives only on origin/spike/research-velocity',
  'docs/research/spatial-upload-path-verification.md':
    '#368 — added by 8e2853f9, lives only on origin/docs/spatial-upload-verification',
  'docs/research/spatial-platforms/':
    '#368 — added by 2ba1bf0f, lives only on origin/docs/research-spatial-platforms',
  'docs/research/spatial-platforms/01-sequencing-platforms.md':
    '#368 — added by 2ba1bf0f, lives only on origin/docs/research-spatial-platforms',
  'docs/research/spatial-platforms/02-imaging-platforms.md':
    '#368 — added by 2ba1bf0f, lives only on origin/docs/research-spatial-platforms',
  'docs/research/spatial-platforms/03-output-matrix.md':
    '#368 — added by 2ba1bf0f, lives only on origin/docs/research-spatial-platforms',
};

/**
 * Frozen bounds. Measured on this tree at `f3f3ce03`; each floor sits UNDER the real number
 * and far above a collapsed one.
 *
 *   text files scanned  3731   (231 more were binary)   floor 3650
 *   root `src-app`      3527                            floor 3400
 *   root `docs`          134                            floor  125
 *   root `scripts`        50                            floor   44
 *   citation sites       327                            floor  280
 *   distinct paths        38                            floor   34
 *   register entries       9                            cap     9
 *
 * The per-root floors are the load-bearing ones. `src-app` is 94% of the tree, so a single
 * combined floor of 3650 is satisfied with `docs/` and `scripts/` walked to zero — and
 * `docs/` is where more than half of this tree's design citations live.
 *
 * Adding files only moves the real numbers up, so nothing here needs editing when the tree
 * grows; `derived-guards.md` §5 names lowering a floor to fit as the anti-pattern.
 */
const BOUNDS = {
  textFiles: 3650,
  roots: { 'src-app': 3400, docs: 125, scripts: 44 },
  citationSites: 280,
  distinctPaths: 34,
  registerCap: 9,
};

/**
 * Does `cited` resolve to something inside THIS repository?
 *
 * `.` and `/` are both in the citation character set, so `docs/design/../../etc/hosts` is a
 * syntactically valid match — and a bare `fs.existsSync(path.join(REPO, cited))` would answer
 * TRUE for it, quietly accepting a citation that names nothing in this tree. A path that
 * escapes the repository root is reported as missing, which is what it is from a reader's
 * point of view: there is nothing here to open.
 */
function existsInRepo(cited) {
  const abs = path.resolve(REPO, cited);
  if (abs !== REPO && !abs.startsWith(REPO + path.sep)) return false;
  return fs.existsSync(abs);
}

/** Fail with a diagnosis. `code` 1 = the tree is wrong, 2 = the guard cannot run. */
function die(code, lines) {
  for (const line of lines) console.error(line);
  process.exit(code);
}

/**
 * Every git-tracked regular file, as `{ mode, rel }`.
 *
 * `-s` is what makes the mode available: filtering symlinks and gitlinks by mode is a
 * structural fact, where filtering them by name or by a `stat` after the fact is a guess.
 */
function trackedFiles() {
  let raw;
  try {
    raw = execFileSync('git', ['-C', REPO, 'ls-files', '-sz'], { maxBuffer: 1 << 28 });
  } catch (err) {
    die(2, [`check-design-citations: \`git ls-files\` failed in ${REPO}: ${err.message}`]);
  }
  return raw
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const tab = entry.indexOf('\t');
      return { mode: entry.slice(0, entry.indexOf(' ')), rel: entry.slice(tab + 1) };
    })
    .filter(({ mode }) => mode === '100644' || mode === '100755');
}

/**
 * Every citation in `text`, as `{ line, cited }`.
 *
 * `mdFences` turns on the fenced-block exclusion; it is passed by the caller rather than
 * sniffed from `rel` here so the one place that decides "this is markdown" is the walk.
 */
function citationsIn(text, mdFences) {
  const found = [];
  let inFence = false;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (mdFences && /^\s{0,3}(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    for (const match of line.matchAll(CITATION_RE)) {
      // A URL names a path on another host. Walk back to the start of the surrounding token
      // and ask whether it carries a scheme separator; `origin/main:docs/design/x.md` and
      // `git show e55b16ef:docs/design/x.md` carry a bare `:` and are real citations.
      let start = match.index;
      while (start > 0 && TOKEN_CHARS.test(line[start - 1])) start--;
      if (line.slice(start, match.index + match[0].length).includes('://')) continue;
      const cited = match[0].replace(/\.+$/, '');
      if (cited === 'docs/design/' || cited === 'docs/research/') {
        // The bare prefix — what `docs/design/*.md`, `docs/design/<name>.md` and
        // "throughout `docs/design/`" all reduce to once the non-path characters are gone.
        // It resolves, so reporting it would be noise, but it is also not a citation of a
        // DOCUMENT and counting it would inflate the site floor with sentences.
        continue;
      }
      // ── FRAGMENTS ───────────────────────────────────────────────────────────────────
      // A path split by a hard wrap or by a string concatenation leaves
      // `docs/design/spatial-` on one line and `storage-layout.md` on the next.
      // `staleClaims.test.ts` records a string concatenation doing exactly that to a sentence
      // it was hunting, so this is a shape that ships here. Reporting the half as a missing
      // path reds the build on a CORRECT citation somebody reflowed — the cry-wolf failure
      // that gets a guard switched off — so a fragment is SKIPPED, not judged.
      //
      // The test is deliberately structural rather than semantic, because "is this the whole
      // path" is not decidable from the text and `derived-guards.md` §7.1 records what
      // happens when a guard keeps sharpening a predicate over an undecidable property. A
      // fragment is:
      //   * a run ending in `-` or `_` — a kebab or snake path broken at its separator, which
      //     is where a hand wrap and a concatenation both split one;
      //   * a run that ends exactly at END OF LINE with neither an extension nor a `/` — the
      //     wrap that was not broken at a separator.
      // Everything else is judged, INCLUDING an extensionless path in the middle of a line:
      // `docs/design/gone` is a citation a reader cannot follow, and excusing it because it
      // carries no `.md` would be an exemption bought by dropping three characters.
      //
      // THE RESIDUE, because an exclusion's honest description is its holes: a citation split
      // MID-WORD by a concatenation (`'docs/design/deriv' + 'ed-guards.md'`) is judged, and
      // would be reported. Nothing in this tree splits a path mid-word — measured at
      // `f3f3ce03`, the only three candidates of any of these shapes are two directory
      // citations ending in `/` and one complete path at a line end — and rejoining lines
      // before matching, which is the only real fix, costs the LINE NUMBER that is half of
      // what this guard reports.
      const base = cited.slice(cited.lastIndexOf('/') + 1);
      const complete = cited.endsWith('/') || /\.[A-Za-z0-9]+$/.test(base);
      const endsLine = match.index + match[0].length === line.length;
      if (/[-_]$/.test(cited) || (endsLine && !complete)) continue;
      found.push({ line: i + 1, cited });
    }
  }
  return found;
}

function main() {
  const list = process.argv.includes('--list');
  const files = trackedFiles();
  if (files.length === 0) die(2, ['check-design-citations: git tracks no files here']);

  const perRoot = Object.create(null);
  /** cited path -> [ "rel:line", ... ] */
  const sites = new Map();
  let textFiles = 0;
  let binaryFiles = 0;

  for (const { rel } of files) {
    let buf;
    try {
      buf = fs.readFileSync(path.join(REPO, rel));
    } catch (err) {
      // A tracked file that cannot be read is a broken checkout, never a reason to scan less.
      // "Did not run" and "found nothing" are the same bytes (`derived-guards.md` §7.1.2).
      die(2, [`check-design-citations: cannot read tracked file ${rel}: ${err.message}`]);
    }
    if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
      binaryFiles++;
      continue;
    }
    textFiles++;
    const root = rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : '.';
    perRoot[root] = (perRoot[root] ?? 0) + 1;
    if (SELF_EXEMPT.includes(rel)) continue;
    // Named explicitly. #339: the locale-default decode defect has been closed four times in
    // this tree, and a `toString()` with no argument is that defect's JavaScript spelling.
    for (const { line, cited } of citationsIn(buf.toString('utf8'), rel.endsWith('.md'))) {
      if (!sites.has(cited)) sites.set(cited, []);
      sites.get(cited).push(`${rel}:${line}`);
    }
  }

  const siteCount = [...sites.values()].reduce((n, v) => n + v.length, 0);
  const missing = [...sites.keys()].filter((p) => !existsInRepo(p)).sort();
  const registered = Object.keys(KNOWN_DANGLING);

  if (list) {
    for (const cited of [...sites.keys()].sort()) {
      const verdict = existsInRepo(cited)
        ? 'ok'
        : registered.includes(cited)
          ? 'REGISTERED-MISSING'
          : 'MISSING';
      console.log(`${verdict.padEnd(19)} ${cited}  (${sites.get(cited).length} site(s))`);
    }
  }

  const failures = [];

  // ── 1. THE SUBJECT: a cited path that is not on disk and is not registered ──────────
  const unregistered = missing.filter((p) => !registered.includes(p));
  if (unregistered.length > 0) {
    failures.push(
      `${unregistered.length} cited path(s) under docs/design or docs/research are not in this tree.`,
      'Each line below is a pointer a reader is invited to follow and cannot (#315, #355):',
      '',
    );
    for (const cited of unregistered) {
      failures.push(`  ${cited}   -- no such path`);
      for (const site of sites.get(cited)) failures.push(`      cited by ${site}`);
      failures.push('');
    }
    failures.push(
      'Either restore the document at that path, or repoint the citation at where the',
      'design actually lives. Do NOT add it to KNOWN_DANGLING: that register is capped at',
      `${BOUNDS.registerCap} and exists only for the backlog #368 already owns.`,
      '',
    );
  }

  // ── 2. THE REGISTER, in both directions ────────────────────────────────────────────
  for (const cited of registered) {
    if (existsInRepo(cited)) {
      failures.push(
        `KNOWN_DANGLING lists ${cited}, which now EXISTS. Delete the entry in the same diff`,
        '  that restored the document — a register that outlives what it registers is an',
        '  allowlist (derived-guards.md §5).',
        '',
      );
    } else if (!sites.has(cited)) {
      failures.push(
        `KNOWN_DANGLING lists ${cited}, which NOTHING CITES any more. Delete the entry.`,
        '  This rule is also this guard\'s positive control on the real tree: if the matcher',
        '  stopped matching, every registered path would report here at once.',
        '',
      );
    }
  }
  if (registered.length > BOUNDS.registerCap) {
    failures.push(
      `KNOWN_DANGLING holds ${registered.length} entries; the cap is ${BOUNDS.registerCap}.`,
      '  The cap exists so a tenth cannot arrive in the one diff that wanted it. Raising it',
      '  is not the repair (derived-guards.md §5).',
      '',
    );
  }

  // ── 3. SELF_EXEMPT names real files ────────────────────────────────────────────────
  // §3 of derived-guards: an exemption naming nothing is not "a case that does not arise",
  // it is a guard switched off, and it looks identical from the outside.
  for (const rel of SELF_EXEMPT) {
    if (!fs.existsSync(path.join(REPO, rel))) {
      failures.push(`SELF_EXEMPT names ${rel}, which does not exist — the exemption is dead.`, '');
    }
  }

  // ── 4. LIVENESS FLOORS, per root ───────────────────────────────────────────────────
  const floorFail = (what, actual, floor) =>
    failures.push(
      `LIVENESS: ${what} is ${actual}, below the frozen floor of ${floor}. The walk has`,
      '  collapsed, or the matcher has stopped matching. A citation-existence check that',
      '  walks zero files is green forever. Do NOT lower the floor to go green.',
      '',
    );
  if (textFiles < BOUNDS.textFiles) floorFail('the scanned text-file count', textFiles, BOUNDS.textFiles);
  for (const [root, floor] of Object.entries(BOUNDS.roots)) {
    const actual = perRoot[root] ?? 0;
    if (actual < floor) floorFail(`the scanned file count under ${root}/`, actual, floor);
  }
  if (siteCount < BOUNDS.citationSites) floorFail('the citation-site count', siteCount, BOUNDS.citationSites);
  if (sites.size < BOUNDS.distinctPaths) floorFail('the distinct cited-path count', sites.size, BOUNDS.distinctPaths);

  const summary =
    `${siteCount} citation(s) at ${sites.size} distinct path(s), over ${textFiles} text file(s) ` +
    `(${binaryFiles} binary skipped); ${registered.length} registered as missing (#368)`;

  if (failures.length > 0) {
    die(1, ['FAIL check-design-citations', '', ...failures, summary]);
  }
  console.log(`PASS check-design-citations — ${summary}`);
}

main();
