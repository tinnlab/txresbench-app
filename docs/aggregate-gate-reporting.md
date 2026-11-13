# Aggregate gate reporting — an aggregate answers about EVERY leg, or it is not an aggregate

Status: design · Owner: platform · Referenced by `.lifecycle/check-aggregate/` · Issue #287

## §1 The failure class

`just check` is the one command a person runs to ask *"is the tree healthy?"*. It was
written as sequential recipe lines, and `just` — like `make` — runs each line as a
separate command and **aborts on the first non-zero exit**, so with line 2 red, every
line after it was unreachable. The aggregate therefore answered a question about two
of its legs while presenting itself as answering about all of them.

That is `derived-guards.md` §1's failure class one level up: *a guard that silently
stops covering the thing it names is indistinguishable from a working one*. Two legs of
that aggregate had caught real defects in the same week — a version-guard had blocked a
behaviour change at an unbumped version, and the invariants gate was itself red in a way
the recipe would never reveal.

The asymmetry is what makes it worth a design note rather than a patch: a **green**
`just check` then meant less than it appeared to, and a **red** one named only the first
thing wrong. Both readings were wrong in the same direction — the reader believed they
had more information than they had.

## §2 The principle

> **An aggregate gate runs every leg it names and reports every leg's result. A leg's
> failure changes the aggregate's VERDICT; it never changes which legs RUN.**

The verdict and the traversal are two different things, and abort-on-first-failure
conflates them. Separating them costs one runner: run each leg with its failure
contained, collect the exit codes, and decide the aggregate's exit code at the end from
the collected set.

## §3 What is explicitly NOT the repair

- **Fix the reds and leave the recipe alone.** This is a *state*, not a fix. The
  abort-on-first-failure property survives, so the next red re-hides everything behind
  it. Leaving the mechanism in place guarantees the class returns.
- **Reorder the legs so an important one runs first.** That reasoning stands: reordering
  makes one leg verifiable and leaves the others exactly as hidden, and the resulting
  green is *more* misleading, not less.
- **Make the aggregate tolerate failures.** An aggregate that runs everything and then
  exits 0 is strictly worse than today: it converts a loud partial answer into a quiet
  wrong one.
- **A bare "something failed" summary.** That repeats the original defect one level up —
  the reader still has to run the legs by hand to learn which.

## §4 Consequence, stated up front

Running every leg surfaces every currently-hidden red at once, and the redness is
pre-existing and now visible, not introduced. Each red belongs to its own issue and its
own owner. The strip node removed the legs whose subjects left the tree (the
processor-package, env-recipe and coercion legs) and moved the `--min-legs` floor with
the removal; the aggregate keeps one floor per critical line of defence
(`check` 5, `check-invariants` 5, `check-guards` 4) and `check-aggregate.test.mjs`
asserts all of them.

## §5 Non-negotiables

- **INV-1**: An aggregate gate runs EVERY leg it names; a leg's failure never prevents another leg from running.
- **INV-2**: An aggregate gate whose run had any failing leg exits non-zero.
- **INV-3**: The aggregate's summary names every leg individually with its own result, both the ones that passed and the ones that failed.
- **INV-4**: An aggregate that ran fewer legs than it declares fails; it never reports success over a shrunken set.
