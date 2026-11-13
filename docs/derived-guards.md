# Derived guards — a guard ranges over a DERIVED set, never an enumerated one

Status: design · Owner: platform · Supersedes nothing · Referenced by
`.lifecycle/zero-core-derived/`

## §1 The failure class

A guard exists to keep a property true as the tree grows. Guards in this
repository fail in two opposite directions from **one** root cause — they name
the *instances* they know about instead of *deriving* them from the declaration
that defines them:

- **vacuously green** — an instance declared tomorrow is not looked for;
- **falsely red** — every addition to the derived set must also edit the guard.

An enumerating guard silently stops covering the thing it names, or starts
refusing things it never meant to refuse. Both are worse than no guard, because
both are indistinguishable from a working one.

The exemplars this design was born from — the per-package acceptance tests of
the processor package tree and the vocabulary guard whose subject was the
package manifests — left the repository with the single-cell platform. The
principle survives in the kept guards: the aggregate's `--min-legs` floor is a
count derived from the legs the recipe actually declares, `check-guard-integrity`
derives its pin set from the files that exist (`git ls-files --cached --others`
over the guard globs), and the domain lint derives its floors from its measured
scan set. This document records the principle and the two design records that
remained live after the platform's removal: the gate-definition repair (#316,
§7.0) and the gate-naming hole (#317, §7.2).

## §2 The principle

> **A guard derives the set it ranges over from the declaration that defines that
> set; it never enumerates instances of it.**

The declaration is whatever the *product* already treats as the source of truth —
the `workspaces` globs in the root `package.json` for workspaces, the guard
globs for `guard-hashes.txt`, the scan roots for the domain lint. If a guard
cannot name a declaration it derives from, it is enumerating, and it will drift.

A **floor** (a committed minimum count, fail-closed when the derived set
collapses) is the correct companion to a derived set, and is *not* an
enumeration: it detects a broken derivation instead of standing in for one.

## §3 Corollary A — a branch-diff proof is scoped to the branch that can prove it

Some properties are properties of a **change**, not of the code: *"the branch
that introduced this unit touched nothing outside it."* That is a legitimate and
valuable thing to assert, and it is only meaningful **on the branch whose diff
it describes**.

A test that asserts it unconditionally re-executes on every later branch and
asserts that branch's diff is also confined to something it has nothing to do
with. It then fails for a correct branch, and the only ways out are to edit
another change's acceptance tests or to widen an allowlist. Both destroy the
guard.

So: such a test must be **self-limiting**. It detects, from the diff itself,
whether this branch is the one that *introduces* its own subject, and where it
is not, it **skips visibly** with a stated reason.

The detector must be **add-only** — keyed on the *creation* of the subject's own
declaration, never on the subject merely being touched. Keying on a modification
would let routine maintenance silently resurrect a relaxation that was supposed
to exist for exactly one branch.

A skip is a **skip**, never a pass: a guard that quietly no-ops is the
vacuous-green failure of §1 in a different costume.

The marker is the subject's declaration, whatever the product treats as the
thing whose creation IS the subject's creation. Two properties are not relaxed:
the skip marker stays add-only and stays visible, and it must **name a real path
in the tree** — a marker naming nothing is a guard switched off, and every
marker-keyed guard carries an ungated control that its own marker names a file.

Corollary A applies to the SUBJECT, not to the mechanism: a guard reading `git
status` rather than a commit range is still asserting a property of a CHANGE,
and scoping follows the subject. Conversely, a guard that reads the tree to
assert a property OF THE TREE is not a branch-diff proof at all and must NOT
be gated: gating it makes it unreachable, which §5 calls deleting the assertion.

## §4 Corollary B — a golden asserts the DERIVATION, not a cardinality

A golden fixture holding a frozen count of a set the tree contributes to is an
enumeration by another name: the count moves together with the derivation only
when a human edits the fixture, so contributing to the set costs an edit to a
file outside the contributor's own surface. The repair is not to raise the
number, it is to assert the *relation* — compare the derived set against the
declaration, per member, so contributing needs no edit anywhere in the golden.

The kept golden fixtures are byte pins (`guard-hashes.txt`) rather than counts:
a pin asserts an identity, which is derived from the file set the guard globs,
and a count floor next to it is the fail-closed companion of §2.

## §5 What is explicitly NOT the repair

- **Widening an allowlist.** Adding the offending path fixes one incident and
  leaves the next one to do it again.
- **A prefix exemption.** An exemption that is not bound to the change it exists
  for outlives that change and relaxes the asserted invariant forever.
- **Lowering a floor to fit.** A floor that is edited whenever it fires trains
  everyone to treat a red guard as paperwork.
- **Deleting the assertion.** The property is real; only its *scope* is wrong.

If a guard is wrong, fix its **derivation**, and say so.

## §6 Non-negotiables

- **INV-1**: A guard derives the set it ranges over from the declaration that defines that set; it never enumerates instances of it.
- **INV-2**: A branch-diff proof runs only on the branch that introduces its own subject, detected add-only from the diff, and is a visible skip everywhere else — never a silent pass.
- **INV-3**: Contributing to a derived surface (a method in the catalogue, a flag in the registry) requires no edit to any file under `src-app/server/src/` — the catalogue is data embedded from `data/`, the registry is code already in the module.
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
verifies the gate.** The repair declares the pin-verification leg as the aggregate's
`--controls-leg`: a run whose pin check fails still runs the other legs (the #287 property)
and prints an explicit "every other result above is unverified" banner instead of letting
the other guards' PASS lines stand on their own.

### §7.1 Gaps in a SCANNED SURFACE — the class, and the property that keeps it closed

A scanned set can be enumerated too: the vocabulary is derived correctly and the guard is
nevertheless blind, because the SURFACE it ranges over is a glob typed into the guard
instead of read from the structure. The #304 audit that closed this class in the platform
guards established the two properties that still matter for the kept scanners:

- the cowardly fix — adding one more glob — is the same enumeration one level down, so the
  surface must be DERIVED from the structural fact (e.g. "every file git tracks under
  `scripts/`"), and an unknown format falls to the most conservative dialect;
- a self-reference exemption must be scope-limited, not whole-file: a guard's own pinned
  file is scanned like any build file except a **declared** block naming the vocabulary it
  hunts, and pinning stays necessary without being sufficient.

The kept scanners' floors are the fail-closed sentinel for this class, and
`src-app/ui/scripts/guard-floors.test.mjs` asserts them: a scanner whose floor constant
is missing, or whose scan set collapses, must fail rather than congratulate itself.

### §7.2 `gateInvocations` enumerates what a GATE looks like — NOT repaired here

Found while mutation-testing #316's repair, pre-existing on `main`, and recorded rather than
fixed because the fix belongs to `check-aggregate.test.mjs` TEST-13's own lineage (#287)
and not to a pin repair.

TEST-13 — *"no recipe reachable as a leg of `just check` can abort on its first failure"* —
decides whether a recipe is an offender by counting how many GATES its body invokes, and it
recognises a gate by NAME:

```js
/scripts\/check-[\w.-]+|(?<![\w-])just\s+check-[\w-]+/g
```

That is §2's failure exactly: the set it ranges over is enumerated by a naming convention
rather than derived. Demonstrated, not hypothesised. `check-domain` currently runs two real
gates and contains their failures with `RC=$?` / `exit $RC`. Rewriting it to a bare
two-line recipe restores the abort-on-first-failure defect `aggregate-gate-reporting.md`
INV-1 forbids — and **every gate stays green**, because neither command is spelled
`check-*`. The same rewrite using two `scripts/check-*.sh` invocations IS caught, which
is what makes this a naming hole rather than a missing assertion.

Filed as #317. `just check`'s own legs are additionally covered behaviourally by
TEST-17/18/19.
