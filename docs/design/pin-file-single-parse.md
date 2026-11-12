# One parse of the pin file — the exported-parse design (#214)

> Companion to `derived-guards.md`. That document is about the SET a guard ranges over.
> This one is about the GRAMMAR a guard reads it through. They fail the same way and the
> repair has the same shape: derive, do not re-implement.

## §1 The failure class

An env recipe's pin file (`src-app/env-rootfs/<id>/requirements.txt`) is one text file. It
is parsed independently by programs written in three languages, and **nothing holds their
grammars together**. Four audit rounds on #192 each produced three demonstrated
exploitable defects, and every one was the same fact wearing a different byte:

| byte | one reader | the other reader | consequence |
|---|---|---|---|
| `#<NBSP>txr:pin-source=` | Rust: `char::is_whitespace` is true for U+00A0, so it trims to a directive | R installer: POSIX `[[:space:]]` is false for it, so the line is prose | a directive the gate enforces and the installer never sees |
| a lone `CR` | Rust `str::lines()` splits on LF only → a comment *fragment* | R `readLines` splits on CR too → a whole *directive line* | one byte is a comment to every Rust and Python reader and a directive to the one program that installs |
| `U+000B` | Rust `is_ascii_whitespace` excludes it | POSIX `[[:space:]]` includes it | the same divergence, one class down |
| `U+001C` | Rust `char::is_whitespace` is **false** | Python `str.splitlines()` **breaks a line** on it, `str.isspace()` is **true** | the one that motivated #214 — see §2 |

The first three were each fixed by widening a forbidden-byte set. The fourth **passed both
implementations of that fix**, because the fix's closure was drawn around the Rust/R pair
and Python is a third definition it never covered.

### §1.1 Why the fourth one ends the guard-widening approach

One `U+001C` placed before a real pin made:

- the Rust build gate and the R installer read the line as a **comment** — 17 pins, the
  package absent, the image would not install it;
- `_pins()` in the Python guards count **18**;
- and the entire Python suite stay **green — including the `frozen = 18` per-recipe floor
  and the both-directions smoke correspondence, the two guards whose entire purpose is to
  make a silent pin removal impossible.**

That is not a guard that was too weak. It is a guard that was **blind by construction**:
it was asked "how many pins are in this file?" and it answered with its own grammar's
count, which is not the count the thing under test uses.

**The pairs that can disagree grow quadratically in the number of parsers, and nothing
bounds the number of parsers.** Eleven readers is 55 pairs. Every fix so far has been a
better predicate over text; the class keeps producing new members because the class is
"two grammars", not "one byte".

## §2 The principle

> **A program that needs to know what the pin file says READS THE GATE'S PARSE. It does
> not parse the file.**

The Rust build gate already parses the pin file completely — ecosystem declaration, exact
pins, `# import=` tokens, `txr:pin-source` directives — because the #80 dependency gate
and the #192 regime both need all of it. It exports that parse as a generated data
artefact. Every other consumer becomes a reader of data.

This is stronger than agreement, and the difference is the whole design:

- **Agreement** (what the canonical-bytes precondition buys) means two grammars are made
  to give the same answer on the bytes that are allowed. It is a real property and it is
  what makes the *irreducible* second parser safe. But it is maintained per byte-class,
  and it is only ever as wide as the disagreements someone has thought of.
- **Exported parse** means there is only one answer, because there is only one parse. The
  question "do these two readers agree about where this line ends?" **cannot be asked**,
  because only one of them reads lines.

The artefact has no line grammar, no comment rule and no whitespace-token rule. There is
nothing in it for two readers to disagree about: a name is a JSON string, a pin count is
the length of a JSON array. The four exploits above are not refused in the artefact — they
are **unrepresentable in it**.

## §3 The irreducible second parser

The R installer runs **inside the image**, at `docker build` time, with only the two files
the recipe ships (`Dockerfile` + `requirements.txt`) in its build context. It cannot
consume a Rust-generated artefact: the artefact is not in the image, and putting it there
would make the recipe three files and silently change the rootfs freshness key.

So the pin file keeps exactly **two** in-repo parsers (plus `uv`, §3.1), and that is the
floor:

1. the Rust build gate — the sole producer;
2. the recipe's own R installer — the sole other reader of the bytes.

The **canonical-bytes precondition** is what holds those two together, and it is the right
shape for holding *two* things together. It was the wrong shape for holding ten.

### §3.1 `uv` is the third parser, and it is counted

The python recipe does not parse its own pin file; it runs `uv pip install -r
requirements.txt`, and **`uv` parses it** — the same role the R installer occupies for the R
lane.

The first cut of this design classified it out on the grounds that we do not write it, and
reported "two". **That was wrong, and a blind audit demonstrated why.** A PEP 508
environment marker appended to a version — `packaging==25.0 ; sys_platform in "nope"` —
parsed as a clean exact pin to the gate (none of its blacklisted characters appear in `in`)
while `uv` evaluated the marker as false and installed a different version transitively.
The pin was in the file, so every floor was satisfied; the package was present, so the
smoke import passed; no manifest declares `packaging`, so the version was never compared.
Eighteen appended characters turned an explicit pin into a lie with the whole tree green.

That is a **gate ⇄ `uv` disagreement**: the same class this design exists to close, between
two parsers one of which had been argued out of the count. So:

> **A parser you cannot remove is still a parser.** The count is eleven before, three
> after, of which two are ours. What can still be reduced is zero.

Reporting "two" would have been the same undercount §7 criticises #192's "FIVE programs"
for, one level up. The gate now refuses `;`, `@` and internal whitespace in a version, so
that particular disagreement is closed at the strict end — but the accounting is the durable
fix, because it is what makes the next one findable.

**The asymmetry worth knowing about:** the R recipe re-reads its pin file inside the image
and asserts every installed package against it, failing the build on a mismatch. The python
recipe installs and smoke-imports but compares nothing. That is why the marker exploit
landed silently in the python lane and would have been loud in the R one. Closing it there
too would mean a `uv pip freeze` ⇄ artefact comparison inside the image — worth doing, and
out of scope here because it changes the image and needs a republish.

### §3.2 The precondition must be reached unconditionally

Round 4 found the precondition living inside `read_env_recipes`, reached only from
`lint_declared_dependencies`, which returns early when no package declares a dependency.
"Are these bytes canonical?" was a **side effect of asking a different question**, so in a
tree where nothing declared a dependency, **no pin file was checked at all** while every
other reader went on parsing them.

A file-validity rule may not be contingent on what some package happens to declare. Under
this design the precondition is additionally reached *by construction*: generating the
artefact requires reading every recipe, and generation is the unconditional pass.

## §4 The artefact

**Path:** `src-app/env-rootfs/env-pins.generated.json` — one file for the whole recipe
tree, at the tree root and NOT inside any recipe directory (a recipe stays two files, so
the rootfs freshness key and `watched_env_pin_files` are unchanged).

**Format:** JSON. Not a generated Rust module (Python could not read it), not a generated
Python module (`env_image.rs` could not read it). JSON is the one format where **every
consumer gets a library parser instead of a hand-written one** — which is the entire
point. A consumer that hand-rolled a JSON reader would have re-created the defect.

**Committed, not built.** Both were defensible; the reasons for committed are:

- **No build dependency for any consumer.** The Python guards run under `just check-py` —
  pytest, no cargo. A built-only artefact would make that gate depend on a Rust build, and
  the realistic implementation of "artefact missing" is a **skip**, which is the
  vacuous-green failure `derived-guards.md` §3 refuses.
- **Reviewable and diffable.** A pin change shows up in review as a data diff beside the
  text diff. That is the same property `openapi.json` is committed for.
- The cost — it can go stale — is paid for in §4.1, and paid for *harder* than
  `openapi.json` pays for it.

**Contents,** per recipe: the declared ecosystem, the declared pin sources
(`class` + `coordinate` + line), **`pin_file_sha256`** (the SHA-256 of the pin file's bytes,
which §4.1 mechanism 5 rests on), and the ordered pin list — for each pin: `name` folded
under the recipe's ecosystem, `raw_name` as written, `version`, `import` module, source
`line`, the line's **`byte_offset`/`byte_len`/`line_sha256`**, and the byte span of each
field (`raw_name_span`, `version_span`, `import_span`), which §4.1 mechanism 6 rests on.

The artefact therefore does record where each line begins and ends. That is not a line
GRAMMAR: it is one authority's answer, carried as data, which no consumer computes and none
can disagree with. INV-2 is about two readers being able to disagree, and there is only one
reader of the bytes.

**Deliberately NOT in the artefact: any total, count or cardinality.** A consumer's frozen
floor must stay a literal in the consumer. A count carried in the artefact moves with the
pin file, so a floor compared against it would be a derivation whose two sides read the
same source — a tautology in the deletion direction, exactly `derived-guards.md` §4.

### §4.1 How staleness is caught

A stale artefact silently disagreeing with the pin file would re-create the defect one
level up, so it is refused at the earliest possible point:

1. **`cargo check` re-derives and byte-compares.** `build.rs` regenerates the artefact from
   the pin files in memory and compares it byte-for-byte with the committed file. A
   mismatch is a **build error** naming the file and the regeneration command. You cannot
   compile the server against a stale artefact.
2. **The comparison is byte-exact, not semantic.** A semantic comparison would need a
   second JSON reader on the build side and would tolerate formatting drift; byte-exactness
   makes the committed file *the* output of the generator and nothing else.
3. **`build.rs` re-fires on the artefact.** `watched_env_pin_files` includes the artefact
   path, so hand-editing it under an incremental build re-runs the check rather than
   leaving a cached green.
4. **Regeneration cannot be blocked by the check it fixes.** `just env-pins-regen` sets the
   generator flag `build.rs` reads; on that path build.rs WRITES the artefact and skips the
   comparison, so there is no bootstrap deadlock where a stale artefact prevents the build
   that would refresh it.
5. **Every consumer checks freshness itself, with a HASH and not a grammar.** The artefact
   records `pin_file_sha256` per recipe. Before a consumer trusts the data it read, it
   digests the pin file's bytes and compares. This matters because the consumers do not all
   run behind the build: `just check-py` is pytest with no cargo in sight, so without this
   a stale artefact would let the Python gate stay green over a pin file that had changed
   underneath it — a *new* way to reproduce the original defect, invented by this very
   design, and closed here.

   **A digest is not a parse.** It has no line rule, no comment rule and no token rule;
   there is nothing in it for two readers to disagree about, which is exactly why it is the
   admissible way for a data-consumer to touch pin-file bytes. A consumer may compute
   `sha256(bytes)`. It may not split them.

6. **The artefact's rows must be VERIFIABLE against the file it describes, by coordinates.**
   A digest proves the file has not changed; it does **not** prove the artefact's data was
   derived from it. A blind audit built an artefact with the *correct* digest and fabricated
   versions (`scDblFinder → 9.9.9`) and every Python guard stayed green, including the frozen
   minimum-pin-set case.

   So the generator records, per pin, the **byte offset and length of its line**, the
   **SHA-256 of those bytes**, and the **byte span of each field it read out** (`raw_name`,
   `version`, `import`). A consumer verifies a row by slicing and comparing at coordinates
   the single parser supplied. **No search, no line rule, no comment rule** — there is
   nothing to find, so there is nothing to anchor.

   **This replaced a fixed-substring search, and the history is the argument.** The search
   needed a head anchor (prose was vouching for pins — the R pin file contains
   `` (`celltypist==1.7.1`) `` in a paragraph) and then a tail anchor (a truncated
   `alpha==1.0` vouched for a file pinning `alpha==1.0.5`). At that point it held a line rule
   AND a comment rule — two of the three properties §7 uses to define a parser — inside the
   consumer whose whole job is to have none.

   **Three properties the coordinates must have, each added because removing it was
   exploited:**
   - every span must be **well-formed** (integer, non-negative, non-empty). An empty span
     hashes to the digest of the empty string, which vouches for anything;
   - every field span must lie **inside its own row's line**. Spans are absolute file
     offsets, so without containment a row can be assembled from bytes scattered through the
     file — an audit deleted a pin, rebased the later rows, and aimed the deleted row's name
     and version at a PROSE line reading `` `spatstat 3.6-2` ``. It verified;
   - the line hash alone is not enough: a fabricated *field* leaves the line's bytes
     untouched, so each field is additionally compared by **exact equality** at its own span.

   **What it does not catch:** a DELETED row, because the loop iterates the artefact — that
   is what the consumers' frozen floors are for. And the DERIVED fields (`name`, folded under
   the recipe's ecosystem, and `ecosystem` itself) are not byte-vouched; they are covered by
   the build's byte-compare, which remains the authority. `cargo check` decides; `just check`
   runs it before `check-py`.

## §4.2 The canonical-bytes precondition is an ALLOWLIST

The two remaining in-repo parsers are held together by a byte rule, and #214 inverted its
polarity after a blind audit walked through it for the fifth time in five audits.

Rounds 2, 3 and 4 of #192 each **widened a set of FORBIDDEN characters** — NBSP, then a lone
CR, then U+000B, then U+001C — and round 4 arrived at "control or whitespace, minus
SPACE/TAB/LF", the union of three languages' notions of a separator, and called the class
closed. This branch's audit found the next door open: `char::is_control()` is category `Cc`
only, so the whole `Cf` FORMAT class passed. A `U+200B` in `#<ZWSP>txr:pin-source=` makes
the directive **inert while leaving it visibly present** — in the pin file, and in the
generated artefact a reviewer reads. The bidi overrides behind Trojan Source
(CVE-2021-42574) passed too.

**A forbidden set fails OPEN on everything nobody has thought of.** So the rule is now:

> A pin file may contain PRINTABLE ASCII, SPACE, TAB, LF, and a small named allowlist of
> non-ASCII characters (`§ — → ─`, the decorative ones its prose uses). Everything else is
> refused **by default**.

Four consequences, in descending order of how much they matter:

1. **It cannot decay.** A forbidden set silently stops covering the class the day Unicode
   adds a character. An allowlist refuses that character the day it is first used, and the
   refusal names it.
2. **It closes classes no whitespace framing could reach** — format characters, bidi
   controls, homoglyphs, unassigned codepoints — without anyone having enumerated them.
3. **It is a REVIEW property, not only a parser property.** The earlier framing was "two
   parsers must not disagree". This one adds "a character a human reviewer cannot see is one
   they cannot review", which is what the `Cf` finding actually exploited — the gate and the
   installer agreed with each other perfectly and both disagreed with the reader.
4. **All three implementations shrink.** R needed 81 enumerated codepoints to express the
   old rule (242 to express the corrected one) and now needs four. The Rust, R and Python
   lists can be compared by eye as well as by the two cross-check tests that hold them
   together.

The cost is deliberate and small: a decorative character added to a pin file's prose costs a
line in three places. `derived-guards.md` §4 sanctions exactly that shape — an edit only when
a covered entry changes, never on an addition.

## §5 What is explicitly NOT the repair

- **A sixth better predicate over text.** Four rounds of that is the evidence.
- **Widening the forbidden-byte set again.** It is already the union of all three
  languages' notions (81 codepoints, derived twice and enumerated once, cross-checked).
  It stays, for the two parsers that remain — but it is not what makes the class closed.
- **Making a consumer "call the gate's reader" while keeping its own read.** The residual
  read is the defect. Round 4 found a fifth parser whose comment claimed it mirrored the
  build gate.
- **Turning a frozen floor into a derived one** now that a derived value is conveniently
  available. See §4.

## §6 Non-negotiables

- **INV-1**: Exactly three programs parse an env recipe's pin file — the Rust build gate, the R recipe's own installer, and `uv` for the python lane — of which only the first two are code this repository writes. Every other consumer reads the gate's exported parse and performs no line-splitting, comment-stripping or token-splitting of pin-file bytes.
- **INV-2**: The exported parse is a data artefact with no line, comment or whitespace-token grammar, so a disagreement between two readers about which bytes separate tokens or end lines is not merely refused — it is unrepresentable in what a consumer reads.
- **INV-3**: The canonical-bytes precondition is reached unconditionally, for every recipe in the tree, before anything parses a pin file — never as a side effect of asking a different question.
- **INV-4**: A stale artefact cannot reach a green tree: the committed artefact is re-derived and byte-compared at `cargo check`, and a mismatch is a build error.
- **INV-5**: Converting a consumer from parser to data-consumer never converts an enumerated anchor into a derivation: every frozen floor and frozen case stays a literal in the consumer, per `derived-guards.md` §4.

## §7 Parser census — the number this design exists to move

**Counting rule.** One count per PROGRAM (module / executable), not per function. A program
counts as a parser when it turns pin-file bytes into pin data using **its own** line rule,
comment rule and token rule. Three things therefore do NOT count, and are listed as
near-misses so the number cannot be inflated or deflated by taste:

- **a substring assertion** (`pins.contains("docs/runbooks/…")`) — no tokenization;
- **a path enumerator** (`watched_env_pin_files`) — never opens the file;
- **a digest** (`sha256(bytes)`) — see §4.1 mechanism 5;
- **a caller that delegates** to another program's parser rather than having its own rule.

### Before

| # | program | language | why it parses |
|---|---|---|---|
| 1 | `build_helper/processor_manifest.rs` — the build gate | Rust | the #80 dependency gate + the #192 regime |
| 2 | `src/modules/sandbox/env_image.rs` — the smoke-correspondence guard | Rust | pin ⇄ `# import=` ⇄ smoke line, with its OWN (stricter) version charset |
| 3 | `env-rootfs/single-cell-r/Dockerfile` — the R installer | R | installs the packages; runs inside the image |
| 4 | `env-rootfs/single-cell-r/tests/regime_test.R` | R | `readLines()` on the shipped file — a *fourth* line-ending opinion, then delegates |
| 5 | `differential-expression/tests/test_rootfs_deps.py` | Python | the python recipe's guard |
| 6 | `differential-expression/tests/test_rootfs_deps_r.py` | Python | the R recipe's guard — **three** grammars: the pin regex and two `re.M` directive scans |
| 7 | `server/tests/dataset/convert_soma_test.rs` | Rust | the positive control for the no-heavy-dependency scan |
| 8 | `spatial-import-visium/tests/test_package_registration.py` | Python | `re.M` `findall` — the one reader behind no precondition at all |
| 9 | `spatial-types/tests/test_spatial_dependency_declaration.py` | Python | #154's dependency declarations |
| 10 | `embedding/tests/test_integration.py` | Python | one `startswith("harmonypy==")` lookup |
| 11 | `packages/_lib/` had none; `pin_file_canon.py` is the PRECONDITION, not a parser | — | (listed to be explicit) |

**Before = 11 parsers**: the ten tabulated above, plus `uv` (§3.1) — which was a parser
then as much as it is now; row 11 of the table is a deliberate non-entry. Counting `uv`
only in the AFTER column would be the same one-sided accounting this section criticises
#192's "FIVE programs" for, and a blind audit caught it there too.

**Why #192 said five.** The count comes from `pin_file_canon.py`'s module docstring at
`c8874f8c^`, which enumerates *"the Rust build gate, the Rust smoke-correspondence guard,
the recipe's R installer, its R build-time smoke, and these python guards"* — five items,
but not five of the rows above: it collapses rows 5 and 6 (the two Python guards) into one,
and counts the R recipe's build-time smoke, which shares the installer's parser and is not a
separate row here. (The Rust refusal message of that revision says "the FIVE programs" and
enumerates nothing.) What #192 did not know about at all were rows 4, 7, 8, 9 and 10, and
`uv`. Rows 7–10 are #215.

(Two earlier versions of this paragraph were themselves wrong — the first asserted the list
named four distinct programs, and the second attributed the quotation to a commit message,
where no such text exists. A blind auditor walked every message on every ref to check, and
found the docstring. Recorded rather than silently corrected, because a paragraph about
someone else's miscount is a poor place to miscount twice.)

(An earlier version of this paragraph tried to recount #192's five and got it wrong — it
asserted the list named four distinct programs, which is not what the message says. A blind
audit recovered the original text from `c8874f8c^` and checked. Recorded because a paragraph
about someone else's miscount is a poor place to miscount.)

### After

| # | program | language | why it is irreducible |
|---|---|---|---|
| 1 | `build_helper/processor_manifest.rs` — the build gate | Rust | the sole producer; every other consumer reads its export |
| 2 | `env-rootfs/single-cell-r/Dockerfile` — the R installer | R | runs inside the image with only the recipe's two files; cannot reach the artefact |
| 3 | `uv`, via `env-rootfs/single-cell/Dockerfile` | (third-party) | the python lane's installer, same role as row 2; not code this repository writes — see §3.1 |

**After = 3 parsers, of which 2 are ours.** Pairs that can disagree: **55 → 3**, and one of
the three (gate ⇄ R installer) is the pair the canonical-bytes precondition was designed for.

The executable form of this section is
`processor_manifest.rs::the_pin_file_has_exactly_two_parsers` — the name is now a
misnomer and kept deliberately, because renaming it would detach it from the issue it
implements; the assertion inside it is `parsers.len() == 3`. Its behavioural companion is
`the_four_historical_exploits_are_refused_or_unrepresentable`.

### Out of scope, stated rather than omitted

The **env lock** (`/usr/local/lib/R/.txresbench-env-lock.txt`, `/opt/venv/.txresbench-env-lock.txt`) is
a second file with three parsers of its own — the R writer/reader, `scripts/env-lock-of.sh`
(`grep '^[^#][^=]*=='`), and `_lib/txr_deps.py::env_lock_digest`. They are **not** reduced
here. The lock has no build-time Rust parse to export: it does not exist until the image is
built, and it is read from inside or beside a published artifact. The same design would
need a different producer, and inventing one on this branch would be scope this issue did
not ask for. Its count is unchanged at 3.
