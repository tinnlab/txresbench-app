# Aggregate gate reporting — an aggregate answers about EVERY leg, or it is not an aggregate

Status: design · Owner: platform · Supersedes nothing · Referenced by
`.lifecycle/check-aggregate/` · Issue #287

## §1 The failure class

`just check` is the one command a person runs to ask *"is the tree healthy?"*. It is
written as nine sequential recipe lines, and `just` — like `make` — runs each line as a
separate command and **aborts on the first non-zero exit**. Line 2
(`cd src-app/ui && npm run check`) is red on main today (#226 ×1 + #246 ×4), so seven of
the nine legs are unreachable:

```
check:
    cargo check --workspace --tests   ← runs
    npm run check                     ← FAILS HERE
    npm run build                     ← unreachable
    just check-py                     ← unreachable
    just check-packages               ← unreachable
    just check-coercion               ← unreachable
    just check-processor-versions     ← unreachable
    just check-invariants             ← unreachable
    just check-r-regime               ← unreachable
```

The aggregate therefore answers a question about **two** of its nine legs while
presenting itself as answering about nine. That is `derived-guards.md` §1's failure
class one level up: *a guard that silently stops covering the thing it names is
indistinguishable from a working one*. Two of the hidden legs have caught real defects
this week — `check-processor-versions` blocked #247 from shipping a behaviour change at
an unbumped version, and `check-invariants` is itself red on main (#272) in a way this
recipe would never reveal.

The asymmetry is what makes it worth a design note rather than a patch: a **green**
`just check` today means less than it appears to, and a **red** one names only the first
thing wrong. Both readings are wrong in the same direction — the reader believes they
have more information than they have.

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
  it. The tree has re-discovered this class at least six times (#213, #272, #218, #210,
  #238/#268/#282, #274); leaving the mechanism in place guarantees a seventh.
- **Reorder the legs so an important one runs first.** The #276 branch found this defect
  and deliberately declined to reorder, calling it *"special-pleading for one gate over
  six"*. That reasoning stands: reordering makes one leg verifiable and leaves the other
  six exactly as hidden, and the resulting green is *more* misleading, not less.
- **Make the aggregate tolerate failures.** An aggregate that runs everything and then
  exits 0 is strictly worse than today: it converts a loud partial answer into a quiet
  wrong one.
- **A bare "something failed" summary.** That repeats the original defect one level up —
  the reader still has to run the legs by hand to learn which.

## §4 Consequence, stated up front

Running all nine surfaces every currently-hidden red at once. `just check` is expected to
be RED on main after this lands, and the redness is **pre-existing and now visible**, not
introduced. Each red belongs to its own issue and its own owner. A reviewer who reads the
first full run as a regression has read it backwards: the branch's entire value is that
those failures are now in the output.

## §5 Non-negotiables

- **INV-1**: An aggregate gate runs EVERY leg it names; a leg's failure never prevents another leg from running.
- **INV-2**: An aggregate gate whose run had any failing leg exits non-zero.
- **INV-3**: The aggregate's summary names every leg individually with its own result, both the ones that passed and the ones that failed.
- **INV-4**: An aggregate that ran fewer legs than it declares fails; it never reports success over a shrunken set.
