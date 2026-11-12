# Derived guards — a guard ranges over a DERIVED set, never an enumerated one

Status: design · Owner: platform · Supersedes nothing · Referenced by
`.lifecycle/zero-core-derived/`

## §1 The failure class

A guard exists to keep a property true as the tree grows. Three guards in this
repository do the opposite, and they fail in two opposite directions from **one**
root cause — each names the *instances* it knows about instead of *deriving* them
from the declaration that defines them.

| guard | what it enumerates | how it fails |
|---|---|---|
| `scripts/check-kinds-zero-core.sh` (#184) | `KINDS='geneset/collection\|graph/attributed\|de/result'` | **vacuously green** — a kind declared tomorrow is not looked for |
| `src-app/server/src/modules/datatype/tests/lattice_golden.json` | a frozen 26-entry lattice + `reg.len() == lattice.len()` | **falsely red** — every datatype added later must edit it |
| `src-app/packages/{embedding,clustering,differential-expression}/tests/test_zero_src_app_diff.py` | "the only package is `<this one>`", asserted over the **branch diff** | **falsely red** — every branch after the introducing one must edit another feature's acceptance tests to go green |

An enumerating guard silently stops covering the thing it names, or starts
refusing things it never meant to refuse. Both are worse than no guard, because
both are indistinguishable from a working one.

The contrast is already in the tree. `scripts/check-derived-vocabulary.sh` derives
its forbidden vocabulary from every `contributes.datatypes[].id` in every
`src-app/packages/*/manifest.yaml`, and says so in its own header: that is *"why a
processor contributed yesterday is already forbidden today."* Its subject set moves
with the tree because it is **read from the declaration**, not typed into the guard.

## §2 The principle

> **A guard derives the set it ranges over from the declaration that defines that
> set; it never enumerates instances of it.**

The declaration is whatever the *product* already treats as the source of truth —
`src-app/packages/*/manifest.yaml` for packages and datatypes, `ROOT_DATATYPE_IDS`
for the universal roots, the root `package.json` `workspaces` globs for workspaces,
`.gitmodules` for submodules. If a guard cannot name a declaration it derives from,
it is enumerating, and it will drift.

A **floor** (a committed minimum count, fail-closed when the derived set collapses)
is the correct companion to a derived set, and is *not* an enumeration: it detects a
broken derivation instead of standing in for one.

## §3 Corollary A — a branch-diff proof is scoped to the branch that can prove it

Some properties are properties of a **change**, not of the code: *"the branch that
introduced this package touched nothing outside it."* That is a legitimate and
valuable thing to assert — it is the executable anchor for the zero-core promise —
and it is only meaningful **on the branch whose diff it describes**.

A test that asserts it unconditionally re-executes on every later branch and asserts
that branch's diff is also confined to a package it has nothing to do with. It then
fails for a correct branch, and the only ways out are to edit another feature's
acceptance tests or to widen an allowlist. Both destroy the guard.

So: such a test must be **self-limiting**. It detects, from the diff itself, whether
this branch is the one that *introduces* its own subject, and where it is not, it
**skips visibly** with a stated reason.

The detector must be **add-only** — keyed on the *creation* of the subject's own
declaration (`git diff --diff-filter=A` on that package's `manifest.yaml`), never on
the subject merely being touched. `test_zero_src_app_diff.py`'s own
`_is_dependency_contract_branch` docstring already reasons this out for the #80
exemption: keying on a modification would let routine maintenance silently
resurrect a relaxation that was supposed to exist for exactly one branch. The same
reasoning applies to the enclosing assertion, and this is that reasoning applied one
level up rather than an exception carved out of it.

A skip is a **skip**, never a pass: a guard that quietly no-ops is the vacuous-green
failure of §1 in a different costume.

### The marker is the SUBJECT'S declaration, which is not always a package manifest

The paragraph above names `manifest.yaml` because the first subjects were packages. The
principle is one level up from that file: the marker is **whatever the product already
treats as the thing whose creation IS the subject's creation** (§2's "declaration"). For a
package that is its manifest — `ExtensionRegistry::scan_dir` skips a folder without one, so
"the manifest was added" IS "the package was introduced". For a PRODUCER added inside a
package that already exists, it is the producer module; for a claim about one file's own
authoring session, it is that file.

Both forms ship, and the distinction is load-bearing rather than cosmetic. #163 introduced a
producer inside a package #162 had already landed: keyed on the package manifest, its guards
would skip on the one branch they describe — self-limiting becoming SELF-DISABLING, which is
strictly worse than the unscoped guard, because a guard that can no longer fail reports green
for a reason unrelated to what it claims (§1). The same holds for `differential-expression`'s
advanced-contrast cut, whose branch is not the branch that introduced its package.

Two properties are **not** relaxed by the second form, and one is newly required:

* it is still **add-only** (`--diff-filter=A`), for the reason above;
* it still **skips visibly**, with the marker named in the reason;
* the marker must **name a real path in the tree**. A package manifest marker is DERIVED from
  the guard's own location and cannot be repointed; a named marker is a caller-supplied string
  and can. A marker naming nothing is not "a branch whose premise does not hold" — it is a
  guard switched off, and it looks identical from the outside. Every marker-keyed guard
  therefore carries an ungated control that its own marker names a file. This is sound by
  construction: the marker is a path the introducing branch ADDS, so on every later branch it
  exists.

### Corollary A applies to the SUBJECT, not to the mechanism

A guard reading `git status` rather than a commit range is still asserting a property of a
CHANGE — "the tree the author of this change was working in held nothing outside their
package" — and on `main` it asks that of whoever is running the suite. Scoping follows the
subject. Conversely, a guard that reads the tree to assert a property OF THE TREE ("the
shared golden does not re-freeze the contributed set") is not a branch-diff proof at all and
must NOT be gated: gating it makes it unreachable, which §5 calls deleting the assertion.

## §4 Corollary B — a golden asserts the DERIVATION, not a cardinality

A golden fixture holding a frozen count of a set the tree contributes to is an
enumeration by another name. `reg.len() == lattice.len()` compares two numbers that
move together only when a human edits the fixture, so contributing a datatype — the
thing the package system exists to make free — costs an edit to a file under
`src-app/server/src/`. That directly contradicts the zero-core invariant the same
package system rests on: **the two shipped rules are mutually unsatisfiable for any
new datatype.**

The repair is not to raise the number. It is to assert the *relation*: the loaded
registry must equal the **roots ∪ every datatype declared by every package
manifest**, compared per-id on the declared `extends` / `is_abstract`. That needs no
edit when a package is contributed, which is what makes §6's INV-3 satisfiable at all.

### What the derivation does NOT catch — corrected after a mutation audit

An earlier draft of this section claimed the derivation was *"strictly stronger than a
count — a count cannot tell an added type from a removed one."* **That was wrong, and it
was wrong in the direction that matters for a golden.** A blind reviewer deleted a shipped
datatype's entire declaration, forced a full recompile, and every test stayed green. The
reason is structural: the derivation re-reads the same manifests the registry is built
from, so on a *declaration-side* change **both sides move together**. The frozen count did
catch that (26 → 25).

A derived cross-check and a frozen expectation answer different questions, and a golden
needs both:

| | catches | costs an edit when |
|---|---|---|
| **derivation** (declared ⇄ loaded) | a declared type that never LOADED (a package silently skipped at boot — a live defect a count cannot see at all); a registry entry declared nowhere; a loader field-mapping bug | never |
| **frozen** (floors + case tables) | a declaration REMOVED or REPOINTED | a *covered* type changes; never on an addition |

So the correct shape is: derive the set membership, and keep a **floor** on the derived
counts (§2's own prescription, which the first cut omitted) plus frozen *cases* over the
types whose values matter. A floor is not an enumeration — adding a datatype only moves
the real number up, so it needs no edit; removing one fails. The zero-core invariant asks
that *adding* be free, not that every type be unfrozen.

The general lesson, which is why this paragraph exists rather than a quiet fix: **a
derivation whose two sides read the same source is a tautology in the direction that
source changes.** Ask, of any derived check, "what would have to be true for both sides to
move together?" — and put a frozen floor across exactly that direction.

Behavioural case tables (`is_a` / `accepts` / `viewers_for` / `layout_kind`) are
**not** enumerations of the set; they are enumerated *cases* over it, and adding a
datatype does not invalidate them. They stay.

## §5 What is explicitly NOT the repair

- **Widening an allowlist.** Adding the offending path to a `SANCTIONED` set fixes
  one branch and leaves the next one to do it again.
- **A prefix exemption.** `test_zero_src_app_diff.py` argues against this at length
  in its own comments, and correctly: an exemption that is not bound to the change
  it exists for outlives that change and relaxes the shipped invariant forever.
- **Lowering a floor to fit.** A floor that is edited whenever it fires trains
  everyone to treat a red guard as paperwork (`domain_surface/mod.rs` records this
  happening).
- **Deleting the assertion.** The property is real; only its *scope* is wrong.

If a guard is wrong, fix its **derivation**, and say so.

## §6 Non-negotiables

- **INV-1**: A guard derives the set it ranges over from the declaration that defines that set; it never enumerates instances of it.
- **INV-2**: A branch-diff proof runs only on the branch that introduces its own subject, detected add-only from the diff, and is a visible skip everywhere else — never a silent pass.
- **INV-3**: Contributing a datatype requires no edit to any file under `src-app/server/src/`.
- **INV-4**: A guard is never relaxed to make a branch pass: an exemption not bound to the change it exists for is refused, and a self-limiting guard still fails loudly on the branch where its premise does hold.

## §7 Known remaining instances

Not repaired here; recorded so the list is honest rather than tidy.

### §7.0 A gate's own definition, verified one recipe away from the gate — REPAIRED (#316)

A third way the class arrives, and the only one so far that has landed **twice**. The
guard is derived correctly and the surface is scanned correctly; what drifts is **who
runs it**.

`scripts/check-guard-integrity.sh` pins the BYTES OF THE GUARD FILES. TEST-20/TEST-21 in
`scripts/check-aggregate.test.mjs` pin the FROZEN FLOORS and the BYTES OF THE RECIPES that
decide which guards run at all. Those are one property — §2's, applied to the guard tree
itself — one level apart. They were verified in two different places:

| pinned thing | verified by | reachable from |
|---|---|---|
| guard FILE bytes | `check-guard-integrity` | `just check-guards`, `just check-invariants`, `just check` |
| gate RECIPE bytes | `check-aggregate-controls` | `just check` **only** |

So a `justfile` recipe edit gated with `just check-guards` — a real gate, run and green —
passed over a stale byte-pin. **Running a gate is not the same as running the test that
pins the gate**, and the two lived one recipe apart. It happened at `051c09a1`/`0bc9063e`
(`check-invariants`) and again at `cce0282e` (`check-guards`, merged as `6fd17559`); in
both cases the recipe change itself was a strengthening, and in both cases the pin was
simply left behind, so `main` carried a RED TEST-21 — the one test whose job is to prove
no gate has been silently neutered.

The distance is the defect, and it is one leg wide. **REPAIRED**: `check-recipe-pins`
(with its controls leg in front of it) is now a leg of `check-guards`, so all three entry
points verify both levels. It declares no recipe name, no hash and no floor of its own —
it re-invokes the pinned file's justfile assertions by name and requires them to have RUN,
which is not the same as their not having failed: `node --test --test-name-pattern` exits
0 when its pattern matches nothing, and a `# SKIP`ped test exits 0 too. §3's rule is the
one that applies — *a skip is a skip, never a pass* — and both spellings are refused.

**It covers five justfile assertions, declared by name.** The first cut named only the two
about pins, and a blind round showed what that left open: it rewrote `check-domain` into a
`set -euo pipefail` recipe with two bare gate invocations — reinstating the
abort-on-first-failure defect `aggregate-gate-reporting.md` INV-1 forbids — then followed the
guard's own documented re-pin instructions, and the guard printed PASS while the assertion that
forbids it stayed red. A gate that closes the distance for the pin but not for the recipe SHAPE
has closed half of it. The list is now those five, pinned to their **full assertion names**
rather than their ids — a later round substituted a trivial `TEST-13 the gate manifest is
present and non-empty` for the real one in a nine-line diff and every gate stayed green, so an
id alone pins nothing. The list is frozen against shrinkage; see the bound below for what it
deliberately does not claim.

**Two things code did not close, recorded rather than implied.**

1. *The floors were slack in the same direction and by the same mechanism.* Both recipes
   gained a controls leg and neither `AGGREGATE_FLOORS` entry moved, so `legs.length >=
   frozen` had two legs of play — the same-line `--min-legs` dodge that assertion exists
   to close, left open by omission rather than by edit. Raised to the real counts (§5:
   lowering a floor to fit is the anti-pattern; raising it with the set is not).
2. *Ordering a controls leg is not declaring it.* `check-aggregate.sh` holds a single
   `--controls-leg`, so `check-recipe-pins-controls` (like `check-derived-vocabulary-controls`
   before it) is ordered in front of the guard it controls but does not raise the "every
   other result above is unverified" banner if it fails. The ordering property holds; the
   banner property does not. Closing it needs a repeatable `--controls-leg` in a runner
   several recipes share, which is filed rather than smuggled into this repair.
3. *The process gap is real and no gate closes it.* Nothing makes someone run any gate
   before merging. The rule this leaves is a rule for humans and merge tooling, not for
   code: **a change that edits `justfile` is gated by `just check`, never by a
   sub-recipe** — because a sub-recipe cannot verify the file that decides which
   sub-recipes exist. The pre-push hook is deliberately NOT the answer
   (`scripts/install-guard-hooks.sh`'s own header: hooks are per-clone and bypassable by
   design, so pinning behaviour to one would imply a property the hook layer does not
   have).

**What the repair holds, and what it does not — the second half is the more useful half.**
The set TEST-13 once claimed to derive ("every assertion in that file that reads the
justfile") is a claim no matcher kept. Three rounds of blind review each walked through the
next version of it, and the last found that eight of nine ordinary spellings of a new
justfile-reading test escaped. The claim is withdrawn: the guard's list is a DECLARED list,
frozen against shrinkage and pinned to the exact assertion names, and a justfile assertion
added tomorrow will not join it by machine. It is still run, by `check-aggregate-controls`
under the full `just check` — so what is lost is EARLINESS for that one assertion, not
coverage.

**The RE-PIN LEDGER records a claim; it does not verify one.** This is the correction that
cost the most to learn. Three versions tried to make "this citation explains this pin change"
machine-checkable — a real commit, then a real commit touching the justfile, then a real
commit that moved *this recipe's* body plus a `+body`/`+stale` marker. A blind round laundered
the last one **ten ways**, each ending with a genuinely neutered gate and a green tree, because
`moved <sha> +body` is satisfied forever by any historical body-move commit for that recipe and
so never has to relate to the change in front of the reviewer. What survives is the property a
machine can actually hold:

> **every pin has exactly one ledger row carrying its current value, so a pin cannot move
> without the ledger moving in the same diff — and the reviewer is shown a claim about why.**

Whether the move was EARNED is a human verdict. #316 said so in as many words — *"I want an
angle that did not write the fix asking whether each re-pin was earned"* — and that is what
settled it here: two independent blind angles re-derived every recipe hash across every commit
that touched the justfile and confirmed both moves were strengthenings. **The blind audit is
the honesty gate. The ledger is what puts the claim in front of it.** A predicate that pretends
otherwise is worse than none, because it converts "a human must read this" into "a machine
said it was fine".

The same bound applies to everything around it, and is worth stating once: every evasion those
rounds found requires a VISIBLE, committed edit to a byte-pinned file. That is the property
`scripts/check-guard-integrity.sh` states for itself — *"not 'guards are immutable'; it is 'a
guard cannot be weakened SILENTLY'"* — and it is the only property any of this machinery has.
`--update` re-pins the guard SCRIPTS with no ledger at all, for instance; that is the same
bound, not a further hole.

The audit rule that falls out of #316, and the reason the pins now carry a **RE-PIN
LEDGER**: updating a byte-pin so it matches a body that moved is *also* exactly how a
weakened gate would be laundered into `main`. A pin updated without establishing why the
body moved defeats the test as thoroughly as deleting it. So every pin that has ever
moved cites the commit that moved it and a one-line reason, next to the constant;
`scripts/check-recipe-pins.test.mjs` TEST-10 asserts each cited commit exists and really
touches `justfile`. If the body was WEAKENED, the repair is to the recipe and the pin does
not move.

### §7.1 Gaps in a SCANNED SURFACE — a different failure from an enumerated set

§7 was a list of guards that ENUMERATE their vocabulary. #304 named a second way the same
class arrives, which this section had no slot for: the vocabulary is derived correctly and
the guard is nevertheless blind, because the SURFACE it ranges over is enumerated. §2 says a
guard derives *the set it ranges over*; a scanned surface is such a set, and a glob typed
into a guard drifts exactly the way a term list does.

- **`check-derived-vocabulary.sh`'s build surface** — the INSTANCE is repaired and the CLASS is
  now derived (#304). `BUILD_SURFACE_GLOBS` was `justfile` + `scripts/*.sh`, so the nine pinned
  `scripts/*.mjs` guards were unscanned.
  #277's leak lived in one of them and this guard printed PASS over it on `main` while
  `spatial-types`' `test_a_new_kind_costs_zero_core_code` — which scans `src-app`, `scripts`
  and `justfile` wholesale — caught it on the next branch. Two guards enforcing one invariant
  disagreed about whether a pinned guard may spell domain vocabulary, one structurally yes and
  one structurally no, and the merge that shipped #277 ran the shell guard and not the pytest.

  **The first repair was a third glob, and a blind audit refused it — on this document's own
  grounds.** `('justfile' 'scripts/*.sh' 'scripts/*.mjs')` is still an ENUMERATION of the set the
  guard ranges over: a planted id in `scripts/coercion-parity-kernel.py` — a real, PINNED build
  script — exited 0 under it, and so did one in a `.bash` file. §2 does not have an exception for
  file extensions. The surface is now DERIVED from the structural fact instead: `justfile`, plus
  every file git tracks under `scripts/`. A build script in a language nobody has used yet is
  scanned the day it lands. The DIALECT is then per-file, with an unknown extension falling to
  `raw` (nothing stripped), because fail-CLOSED is the right default for a format the guard
  cannot parse.
- **The self-reference exemption was the second half, and widening the glob alone would not
  have closed it** — REPAIRED (#304). The exemption was "the file is PINNED in
  `scripts/guard-hashes.txt`", i.e. the whole file, and the leaking guard was pinned. Pinning
  cannot distinguish a guard **hunting for** a term (`check-kinds-zero-core.sh`'s `KINDS=`,
  `check-no-legacy-wire.sh`'s `DOMAIN_REGEX=` — these MUST spell what they search for, and
  scanning them is the cry-wolf class §5 warns about) from a guard **dispatching on** one,
  which is what #303 found. Nothing can, from the outside — so the guard now SAYS which it is
  doing, in a declared block:

  ```sh
  # txr:guard-vocabulary
  KINDS=<the terms this guard hunts>
  # txr:end-guard-vocabulary
  ```

  Only those lines are blanked, and only in a pinned file; every other line of a pinned guard
  is scanned like any build file. Pinning stays NECESSARY and stops being SUFFICIENT, so an
  exemption costs two committed diffs instead of one. Both ways of getting it wrong fail
  closed: a marker in an unpinned file is a hard failure rather than a silent no-op, and an
  unterminated block is a hard failure rather than a whole-file exemption arriving by typo.
  The blocks were added only where the tree measurably needs them — two lines, in two guards.

- **What bounds the declared block is the PIN, and three attempts to bound it with a PATTERN
  are the reason this paragraph is worth reading.** The block started with no bound at all, so
  wrapping an ENTIRE pinned guard in one marker pair restored the whole-file exemption being
  removed, at exit 0. Then:
  1. *every non-blank line carries a forbidden term* — defeated by reading the RAW line while
     the scan read the STRIPPED one: a trailing `# <a declared term>` laundered any line in;
  2. *…checked on the stripped line* — defeated by a real `case $KIND in <term>)`, which spells
     a term because it dispatches on one;
  3. *…and the line must be an ASSIGNMENT* — defeated by `_=1; case $KIND in <term>)`, and it
     cried wolf on six ordinary declaration forms (a multi-line array, `export const`,
     `declare -r`, `+=`, an indexed assignment, a heredoc).

  Three rounds, three one-line defeats, and a growing false-positive surface. That is the
  signature of a **predicate over a semantic property**: "declares" versus "dispatches" is not
  decidable from the text, so the evasion space is unbounded and each round finds another
  spelling. The fourth attempt is not a sharper predicate — **there is no predicate any more.**

  What bounds the block is what always bounded it: the marker is honoured only in a file whose
  BYTES are pinned, so any edit inside the block changes the hash and fails
  `check-guard-integrity.sh` until it is re-pinned — a one-line diff in a committed manifest,
  with a human on the other side of it. The markers make that control's SCOPE readable; they do
  not decide whether the bytes inside deserve it, and the guard no longer pretends otherwise.

  **Say the consequence out loud, because a reader will otherwise assume the block is narrow:**
  a marker pair around an ENTIRE pinned guard, with a dispatch inside, is GREEN on every
  automated gate once the author runs the re-pin that `check-guard-integrity.sh` tells them to
  run. The block is a whole-file-scope exemption whose only content control is human review of
  that manifest diff. `TEST-14` asserts exactly that — including the green case — so that if a
  later change does add a sound content bound, the test goes red and says so rather than the
  improvement passing unnoticed.
  What it still checks is only what is decidable with no evasion space: the marker is in a
  pinned file, the block is terminated, the markers nest.

  **The general lesson, which is this section's real content:** when a guard's rounds keep
  landing on the same predicate, the answer is not a better predicate. Ask what the predicate
  was standing in for, find the control that actually holds it, and say so — even when the
  answer is "a human reads the re-pin".

- **The residual, stated rather than tidied: the two guards still do not agree COMPLETELY, and
  the disagreement now runs in BOTH directions.** Filed as **#311**; this is the record of what
  it covers, not a claim that it is closed.
  On the question #277 landed in — may a pinned `scripts/*.mjs` guard spell a contributed
  datatype id? — both now say NO, and both name the same file and term on the same planted
  leak (`check-derived-vocabulary.test.mjs`'s TEST-10 asserts exactly that, by running both).
  Three directions remain open:
  1. **the declared block** — a guard that legitimately hunted a `spatial/*` id would declare a
     `txr:guard-vocabulary` block, pass the shell guard, and fail the pytest, which grants no
     exemption at all. No guard does this today;
  2. **the test-module exclusions** — the shell guard excludes Python test modules by
     `pytest.ini`'s `python_files` and JS test modules by the justfile's own `node --test`
     declarations; the pytest excludes only by PATH SEGMENT (`tests`/`testdata`/`fixtures`/
     `__tests__`) and not by basename. This is not hypothetical: while #304 was being fixed, its
     own control suite spelled the id it plants and the pytest correctly reported it as a leak;
  3. **the surfaces themselves** — `src-app/libs/**` and `src-app/ui/**` are scanned by the
     pytest and are outside this guard's `SURFACE_ROOTS` (deliberately, for `src-app/ui/**`,
     which `lint-no-domain-in-builtin.mjs` covers with a ratchet this guard cannot carry);
  4. **an ESCAPED separator** — the shell guard resolves `spatial\/image` back to the term and
     reports it; the pytest greps raw text and does not. That direction was created by fixing a
     fail-open here, and it is the good direction (the shell guard is now stricter), but it is a
     divergence and is recorded rather than left to be rediscovered.

### §7.1.1 What #324 cost, and what #311 closed — residuals 1 and 3

**#324 is residual 3, arriving before anyone acted on it, and it is worth reading as the
measurement rather than as an incident.** #304's repair was to widen this guard's build
surface to "the whole of `scripts/`" — and `scripts` there is a git PATHSPEC, rooted at the
repo. #259's fixture generator landed at `src-app/libs/viz/scripts/`, which is inside the
pytest's wholesale surface and was outside this guard's, so this guard printed PASS while
`test_a_new_kind_costs_zero_core_code` carried the red onto `main`. That is #303 again, one
directory out, with #304 — #303's repair — already in the tree. When a repair's own shape
produces the next instance, the value was not what was wrong.

Two things are closed, and the manner matters more than the fact:

* **residual 3 is closed for every `**/scripts/` region, by a DERIVATION rather than a third
  glob.** `scripts/lib/zero-core-surface.txt` is now the ONE committed declaration BOTH guards
  read. It states the structural fact instead of an instance of it — *being under a directory
  named `scripts` is what makes a file build tooling, at any depth* — so a `scripts/` directory
  nobody has created yet is scanned the day it lands, with no edit anywhere. `MIN_SURFACE_DIRS`
  floors the walk at ≥2 directories, which is the assertion that it CROSSES THE REPO ROOT: a
  regression to the pre-#324 root-only pathspec resolves to 1 and fails, rather than scanning a
  smaller tree quietly. `MIN_BUILD_FILES` is a second, independent detector of the same
  regression *and* of the "add an exception for the leaking directory" dodge, because both land
  below it.
* **residual 1 is closed.** The pytest honours the same `txr:guard-vocabulary` block, on the
  same two committed keys (the markers, and the file being pinned in the manifest the
  declaration names), read from the same file. It changes nothing in the tree today — neither
  shipped block spells an id `spatial-types` contributes — which is the point: a latent false
  red is fixed while it is still latent, because §1 says the two directions are one failure.

And one relation is now asserted that never was: the pytest checks that its own wholesale scan
set **CONTAINS** the fast guard's declared build surface (TEST-24). #324 is exactly that
containment violated in reverse, and nothing was watching it. It fails loudly the day the fast
guard is pointed at a region the backstop cannot see — a `src-app/packages/*/scripts/`, say,
which the pytest excludes by prefix — which is the direction that would leave a leak with no
second opinion at all.

**What is NOT closed, and why each is deliberate rather than forgotten.**

* **Residual 2, the test-module exclusion, is deliberately untouched — and #324 is the reason.**
  One of its three leak sites was
  `src-app/libs/viz/src/viz-core/spatial/staleClaims.test.ts`: a test module by BASENAME, on no
  `tests/` path segment. Teaching the pytest a basename exclusion in this change would have made
  that leak vanish instead of being fixed — an exemption whose first act is to cover the defect
  that motivated the branch, which is §5's second bullet almost word for word. The derived form
  (reading the ui workspace's own `package.json` test declarations, as this guard reads the
  justfile's) is a second derivation with its own fail-open surface and belongs in its own
  change, against a tree where the leak is already gone.
* **Residual 4, the escaped separator, is a TOKENIZER question, not a surface one.** Closing it
  means giving the pytest an escape-resolution pass with a per-dialect table — the machinery
  that took four rounds and two opposite fail-opens to get right here, and that still carries
  #312. A second implementation of it is the drift #311 exists to remove.
* **Five FILES are excepted, and the first cut of them was a PREFIX — which is the part worth
  reading.** The declaration originally excepted `src-app/ui/scripts` wholesale. A blind
  design-conformance angle measured it: 66 files excluded to cover hits in a handful, and it
  planted a leak in one of the other 60 and reproduced the #324 STATE at a committed path — fast
  guard PASS, wholesale pytest RED, `just check-guards` green. A prefix exemption is §5's second
  bullet in substance even when its reason is sound, and "the reason is sound" is exactly what
  makes it survive review. The reason is now applied to the files it is about:

  | excepted file | why it must spell |
  |---|---|
  | `lint-no-domain-in-builtin.mjs` | the SIBLING GUARD over this same invariant. It must SPELL what it hunts (#304's case) and it *cannot* use a `txr:guard-vocabulary` block, because `check-guard-integrity.sh` deliberately does not pin it — and a marker in an unpinned file is a hard failure by design. |
  | `domain-baseline.json` | that guard's committed per-(file,token) ratchet BASELINE: a record of the hits it tolerates, which cannot exist without spelling them. |
  | `lint-no-domain-in-builtin.test.mjs` | its control suite — it PLANTS the vocabulary it asserts the guard reports. |
  | `capture-surface-baseline.test.mjs` | the surface-baseline control suite, same shape. |
  | `surface-baseline-expected-delta.json` | that suite's expected-delta fixture, which QUOTES the ids whose removal it asserts. |

  The other 61 files under `src-app/ui/scripts/` are now SCANNED — a region that was covered by
  nothing before this change, since `lint-no-domain-in-builtin.mjs`'s own roots are `ui/src` and
  `ui/tests`, not `ui/scripts`. **The residual cost, said plainly: a ui control suite that
  legitimately plants vocabulary tomorrow will be reported**, because the js-test-module
  derivation reads the JUSTFILE's `node --test` declarations and not the `ui` workspace's own.
  That is the repair **#325** names, and it is what would retire all five entries.

  The bounds on an exception are: DEFAULT-DENY (a new `scripts/` directory needs no entry and is
  covered on arrival — only an exclusion has to be written down); it must NAME A REAL PATH that
  the walk actually reaches (§3's rule, enforced ungated, in both readers); removing it turns
  the guard red on what it covers, so it is a live decision rather than decoration; and their
  NUMBER is capped in the byte-pinned guard, so a sixth cannot arrive in the one diff that
  wanted it. `lint-no-domain-in-builtin.mjs`'s own `UNSCANNED_PACKAGES.viz` is the neighbouring
  declared gap of the same shape, and is where #324 actually landed.

### §7.1.2 What two blind angles found in the repair, and why it is in the design record

The repair above was audited blind by a design-conformance angle and a correctness angle that
had not written it. Between them they turned five of its own claims into defects, and the
pattern across those five is the useful part: **every one was a place where the fix trusted a
NUMBER or a STRING where it should have removed the thing that needed trusting.** That is the
same lesson §7.1 reached about the vocabulary block, arriving again one file over, which is why
it is recorded here rather than quietly fixed.

1. **A value from the declaration is interpolated into FOUR matcher languages** — an awk ERE, a
   BRE `grep`, a Python `re` and a git PATHSPEC — and the first cut escaped for one of them.
   `vocab_block_open txr:guard-vocabulary(` made awk's *lazily compiled* dynamic regex fail on
   the first BUILD file, so awk died on **every** build file with its stderr swallowed, the
   guard read "no hits", and it printed PASS over a planted leak *while still reporting the same
   file count* — because that count is a line count of the file LIST and never had anything to
   do with what awk processed. `surface_root :(exclude)justfile` is a pathspec, not a path, so
   git exits 0 with empty output and the recipes leave the surface. `surface_exception
   src-app/x+y` was escaped ERE-style and consumed by a BRE `grep`, where `\+` is an OPERATOR:
   the declared directory was **not** exempted and a different one silently was. The repair is
   not a better escaper — it is a CHARSET that admits no metacharacter in any of the four, so
   the readers agree by construction rather than by two escapers that have to match.
2. **An exit status that is discarded turns "did not run" into "found nothing".** Those two
   are the same bytes, which is why the scanner's status is now a hard failure rather than a
   warning: it is the one shape in this tree that is indistinguishable from clean and fires on
   every file at once.
3. **A floor is not a policy.** The first cut claimed `MIN_BUILD_FILES` was "a second,
   INDEPENDENT detector" of the exempt-the-leaking-directory dodge, because the dodge landed one
   file below it. True that day; not a mechanism. The correctness angle paid the shortfall
   straight back in the same edit by adding a `surface_root` and landed exactly ON the floor,
   leak exempt, guard green. The claim is withdrawn in the guard's own annotation and replaced
   by a CAP on the number of exceptions — which does not decay, because it is a constant
   compared against a count of declarations rather than against a count of files.
4. **The widening reached the DATA.** `surface_dir scripts` applied to the whole tracked set
   pulled `src-app/packages/*/scripts/` into the surface — the one category this guard's header
   excludes by construction — so a package that shipped a `scripts/` directory would have had
   its own declared id reported as a leak. §1's false-red direction, landing on precisely the
   act INV-3 keeps free. `data_root` is now declared and both readers subtract it.
5. **An unbounded walk outran the backstop.** With no `scan_root`, the walk reached `scripts/`
   directories the wholesale pytest cannot see (`docs/scripts/`), making the fast guard range
   over a region with no second opinion — the containment TEST-24 exists to hold, violated by
   the guard that is supposed to be its subset. The roots are declared once and both read them,
   so a region is in scope for both or for neither.

Two smaller ones are recorded because they are the class §7.0 warns about: the declaration's
hand-kept measurement was already stale in the commit that introduced it (it said 46/45 where
the tree gave 50/49), and `MIN_JS_TEST_FILES`'s "measured 4" sat beside a PASS line printing 5.
Both are inside byte-pinned files whose entire value proposition is that a human reads the diff.

  **Known limits, stated because they are fail-OPEN and a reader deserves them up front.**
  Neither stripper is a lexer. A block-comment opener that a regex character class produces
  (`/[/*]/` — legal JavaScript) opens a comment the stripper cannot see through; unterminated,
  it is now a hard failure in both the shell guard and the TypeScript sweep, but one CLOSED by a
  later genuine `*/` blanks the span between them silently. The Rust in-source-test blanking has
  the same shape and no end-of-file report at all, and it predates all of this. These are filed
  as **#312**, not fixed here — the sound repair is a tokenizer, not a further special case, and
  four rounds of special cases is the evidence for that rather than the argument against it.

  Closing these needs the third option #304 lists — the pytest's surface, its test exclusion and
  its exemption rule derived from ONE shared declaration with this guard's. That is a change to
  `src-app/packages/spatial-types/**`, which #304's branch could not touch, so it is #311 rather
  than an allowlist widened here to make the sentence true.

- **The lesson, which is the reason this section exists rather than a fourth bullet in §7.**
  §4 asks, of any derived check, *"what would have to be true for both sides to move
  together?"* The surface question is its twin: **what would have to be true for the guard to
  be looking somewhere the defect is not?** A guard's SUBJECT SET and its SCANNED SURFACE are
  two derivations, and only one of them was ever being audited.


- **`scripts/check-kinds-zero-core.sh` (#184)** — hardcodes three kind ids, so it never
  looks for a kind added later. Its successor `check-derived-vocabulary.sh` already exists
  and already derives; the open question is retirement of the enumerating original, not a
  new mechanism.
- **`src-app/server/src/modules/extensions/loader.rs`'s `assert_eq!(conv.produces.len(), 4)`**
  — an in-source exact cardinality over the real extracted seed, pinned to a contributed
  package's declared `produces` list. Same class as §4, and it lives under
  `src-app/server/src/`, so a package that changes its declared outputs still costs a core
  edit. It is tracked as `R4-CARD-03` in the exact-cardinality ledger
  (`server/tests/domain_surface/mod.rs`), which is the right place for it; INV-3 as stated
  concerns *datatypes*, and widening it to converter outputs is a separate decision with
  its own scope.
- **`src-app/server/src/modules/provenance/interaction.rs`'s
  `the_shipped_package_declares_a_selection_datatype_carrier`** — asserts
  `text.contains("selection-set-target")` over the RAW manifest file, so it passes on a
  version-history *comment* that merely mentions the capability. Demonstrated, not
  hypothesized: when a shipped datatype declaring that capability was accidentally deleted
  during this branch's own review, the guard stayed green while the condition in its own
  failure message ("every stock deployment silently degrades its selections") had become
  true. §1's failure class, in the guard tree this document is about. Filed separately; the
  fix is to assert over the PARSED `contributes.datatypes[].capabilities`.

### §7.1.3 The SECOND exemption axis — a cap that was true of its field and false of its file

Two more blind rounds ran over the repair in §7.1.2. The first (a Rust control suite for the
same guard, reachable only through `just check-domain` and which no earlier round had run) found
the repair had made a FALSE-RED: it required an EXCLUSION path to name something, which
pre-empted the far better "the derivation collapsed" message the vocabulary floors already give.
The existence rule now covers INCLUSION paths only, and the asymmetry is written beside it —
**an inclusion path naming nothing removes a region while the guard reports the same PASS; an
exclusion naming nothing excludes nothing, so the guard scans MORE, which is a loud red.**

The second is the one that belongs in a design record, because it defeated the repair's own
headline claim from inside the repair's own declaration.

The guard capped its written exceptions and annotated the cap as *"the only non-decaying bound
on an exception"*. **The sentence was true of the field it named and false of the file it was
in.** One field over sat `test_path_segment` — an exemption with the same reach, no cap, no
control, and a *lower* price. With a real leak planted under a nested `scripts/` directory, one
appended line, `test_path_segment viz`, turned the fast guard, the wholesale scan **and** the
containment assertion green for the cost of a single re-pin: strictly cheaper than adding an
exception, which additionally costs an edit to a second pinned file.

Three things generalize out of it, and none of them is about path segments.

1. **A guard that bounds one exemption axis has said nothing about the others.** "The only
   bound" is a claim about a FILE, and it is checkable: enumerate every field in the declaration
   that can REMOVE something from a scanned set, and ask what each one costs. Two of the six
   here cost a second reviewed diff; the third cost one line. §5's "widening an allowlist" does
   not announce itself as an allowlist.
2. **The repair is to remove the axis from the tier that never needed it, not to cap it.** The
   cap is the fallback. What actually killed the vector is that neither reader applies test
   segments to the BUILD surface any more: build tooling is build tooling wherever it sits, and
   the exclusion that tier legitimately needs is the DERIVED one (the justfile's own
   `node --test` declarations), which no edit to a declaration can re-point. A derived exclusion
   is not an exemption axis at all.
3. **Two readers of one declaration must DISAGREE about something, or the second one is
   decoration.** The wholesale side now catches this vector on its own, because its model of the
   fast guard's build surface deliberately does not apply the segments while its own scan set
   does — so a segment that silences one set makes the two disagree and the containment
   assertion reddens. A backstop that applies every one of the fast guard's exemptions is not a
   backstop.

A fourth finding from the same round is a note about controls rather than guards, and it is the
one most likely to recur: **a control for a property of a SHARED declaration that exercises ONE
reader cannot see the disagreement the declaration exists to prevent.** The round that refused a
trailing slash wrote a control that drove only the shell; the counterpart's charset accepted it
(a `(?![/.])` lookahead succeeds at end-of-string), so one declaration had two answers in the
very commit that added the refusal, under a comment claiming both readers made "the same three
refusals".

### §7.1.4 Enumerating the exemption axes — the exercise, run properly

§7.1.3 above ends by telling the reader to *"enumerate every field in the declaration that can
REMOVE something from a scanned set, and ask what each one costs."* The round that wrote that
sentence enumerated six fields and priced two. A blind round then did to the third what the
round before had done to the second, in one line and for the same price, and the fact that the
instruction was already written down and still not followed is the part worth recording.

Run properly, over the shipped declaration, the exercise looks like this — and the ANSWERS are
what the section is for, because they are all different:

| field | can remove | what bounds it |
|---|---|---|
| `surface_exception` | files from the build surface | a CAP, plus an ungated "names a real path *the walk reaches*" check |
| `test_path_segment` | files from every tier | a CAP, plus "must classify something", plus: **the build tier does not apply it at all** |
| `data_root` | files from every set in BOTH readers | **DERIVED** — must hold a contributed `manifest.yaml` |
| `surface_root` | (adds; can be made inert) | must name something, and may not sit under a `data_root` |
| `scan_root` | the whole region | must name something |
| `vocab_block_*` | lines inside pinned files | the byte pin |

Three lessons generalize, and none is about this guard.

1. **The right bound is different for each field, and a cap is the weakest of them.** `data_root`
   took no cap at all: it is not an opinion about what to skip but a statement about where the
   contributed packages are, and that set has its own declaration — a directory is a package
   because it holds a manifest. Checking the value against the thing it claims to describe is
   §2 applied to the declaration itself, and unlike a cap it cannot be spent.
2. **A capped slot that names nothing is an exemption already paid for.** The cap prices ADDING
   a member and says nothing about RE-POINTING one, so an inert member is a slot a later commit
   spends for free, with the count never moving and the cap never firing. Every capped list
   therefore needs "each member must do something" as well as "there may be at most N" — and
   the honest statement of what that buys is a PRICE (spending a slot becomes a visible deletion)
   rather than closure, because nothing decidable stops a live member being re-pointed.
3. **A backstop that applies an exemption to its own model of the fast guard's surface cannot
   see that exemption used.** This is §7.1.3's bullet 3 with the failure attached: the branch
   stopped its wholesale side modelling `test_path_segment` and left it modelling `data_root`,
   so the containment assertion shrank with the scan for exactly one of the two axes — and it
   was the other one that got exploited. The rule is per-axis, and it has to be checked per-axis.

One more, about characters rather than fields, because it cost a HIGH finding twice in three
rounds. **A check that compares DECLARED STRINGS is only as good as the charset that admits
them.** The at-or-under-a-`data_root` check compared the declared spelling of two paths; the
shell charset admitted `src-app/./packages/_lib`; git normalised it and the exclusion emptied
the root anyway. An exhaustive differential between the two readers' charsets over `{a,.,/,-,_}`
to length 5 found 118 strings they disagreed about — the kind of thing that is cheap to
enumerate and impossible to eyeball, and worth doing whenever two implementations of one
grammar ship together.

### §7.2 `gateInvocations` enumerates what a GATE looks like — NOT repaired here

Found while mutation-testing #316's repair, pre-existing on `main`, and recorded rather than
fixed because the fix belongs to `check-aggregate.test.mjs` TEST-13's own lineage (#287) and
not to a pin repair.

TEST-13 — *"no recipe reachable as a leg of `just check` can abort on its first failure"* —
decides whether a recipe is an offender by counting how many GATES its body invokes, and it
recognises a gate by NAME:

```js
/scripts\/check-[\w.-]+|(?<![\w-])just\s+check-[\w-]+/g
```

That is §2's failure exactly: the set it ranges over is enumerated by a naming convention
rather than derived. Demonstrated, not hypothesised. `check-domain` currently runs two real
gates and contains their failures with `RC=$?` / `exit $RC`. Rewriting it to

```
    #!/usr/bin/env bash
    set -euo pipefail
    cd {{ui_dir}} && node scripts/lint-no-domain-in-builtin.mjs
    cd {{server_dir}} && CONFIG_FILE=config/dev.yaml cargo test --test integration_tests -- \
        --test-threads=1 domain_surface
```

restores the abort-on-first-failure defect `aggregate-gate-reporting.md` INV-1 forbids — the
`domain_surface` suite becomes unreachable whenever the lint is red, which is the original
#287 incident one recipe down — and **every gate stays green**, because neither command is
spelled `check-*`. The same rewrite using two `scripts/check-*.sh` invocations IS caught, which
is what makes this a naming hole rather than a missing assertion.

Filed as #317. `just check`'s own legs are additionally covered behaviourally by TEST-17/18/19, which drive
the real recipe with stubs; those stubs replace `just` itself, so they never descend into a
sub-recipe and cannot cover this.
