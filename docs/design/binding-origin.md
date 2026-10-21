# A binding carries how it was chosen

## Why

An input bound by the system is byte-identical to one a human picked.

`grep` the whole frontend for any marker of an automatic choice — `source: 'auto'`,
`origin: 'auto'`, `isAuto`, `autoFilled`, `inferred` — and it returns nothing that
means it. There is no such fact anywhere in the tree, on either side of the wire:
`RunInput` is `{slot, artifactId}`, the wire is `{slot, artifact_ref}`,
`UsedEdgeDto` is `{slot, kind, ref_id, content_hash}`, and the exported
`inputs.json` is `{slot, kind, content_hash, sandbox_path}`. At every one of those
layers, a value the system guessed and a value a scientist deliberately selected
are the same four keys with the same contents.

That is not a cosmetic gap. Two rules already in force depend on the distinction
being carried, and neither can hold today.

**R2 / INV-3** (visualize-pane design §8.0) says: *"a resolver may never take `[0]`.
… If exactly one candidate exists and auto-binding is wanted, that is a **declared**
affordance (`auto_bind_sole_candidate: true`) so the form shows what it bound."*
Main already ships the declaration half (opt-IN, absence is OFF, DEC-15). The
*"shows what it bound"* half is shipped at exactly one of the four sites that bind,
and even there it is shown only as a sentence — the resulting VALUE is unmarked, so
nothing past the control can act on it.

**R8 / INV-9** says: *"an unverified assumption travels as far as the code can carry
it. … A marker seen only at the moment of choosing is not a marker; it is a
disclaimer nobody sees again."* That is precisely the shipped state of
`ArtifactRefWidget`'s sole-candidate arm: it renders *"Only one match — selected
automatically."*, and the instant the value leaves the control the sentence is gone
and the fact with it.

**INV-4** of `processor-manifest-ui-separation.md` is flatly violated by two of the
four sites: *"What is launched is what was shown. Every input the run consumes is
visible in the form before Run, and passed explicitly; nothing is resolved invisibly
between click and job."* `hostCtx.ts::resolveInputs` binds a sole candidate at
LAUNCH for a caller that supplied nothing (an agent or MCP call), and
`inputEconomy.ts::autoPickSoleArtifacts` patches one straight into `params` from a
mount effect — after which `runGate` reports the form READY. In both, a run launches
on a binding nobody ever looked at, and the record it leaves behind cannot say so.

## The sites that bind

The blind audit named three. There are four that this change covers, and a fifth it
deliberately does not. Counting them is the point: a vocabulary adopted by some of
the sites is a documented hole rather than a fix, and the only way that stays honest
is to enumerate the ones left out and say why.

| # | site | has a control? | reaches a run's inputs? |
|---|---|---|---|
| 1 | `core/render/ArtifactRefWidget.tsx` — the declared `artifact_ref` widget's sole-candidate pre-selection | yes (a read-only summary) | yes, via the view's `inputs:` block |
| 2 | `core/runtime/hostCtx.ts::resolveInputs` step 2 — the LAUNCH-time bind for a caller that supplied nothing | **no** | yes, directly |
| 3 | `extensions/analysis/inputEconomy.ts::autoPickSoleArtifacts` — a mount effect patching `params` | a control renders, but says nothing | yes, via `buildInputs` |
| 4 | ~~`core/shell/RowSpaceAnchor.tsx` — the pane ANCHOR's sole-row-space auto-bind~~ **DELETED 2026-08-13 — no longer a site; see below** | — | — |

Site 4 was why the rule below is stated as two independent legs. It bound, and its
control was indistinguishable from a user choice, so it needed the VISIBLE leg; it
was not an input to any run, so it had no provenance leg and inventing one would
have been a fact about nothing. **That is still why the rule has two legs** — the
argument is what the site taught, and it outlives the site.

**The site itself is gone.** On 2026-08-13 the owner ruled that the question the
control asked does not exist: *"there is no such thing as a row space"*, and
cells-vs-genes is not a choice that exists. `RowSpaceAnchor.tsx` was deleted whole,
with its unit test and its e2e spec (`15-visualize/binding-origin-anchor.spec.ts`,
TEST-29). The pane's first block is now § Coordinates, and `$scope.axis` — the value
the anchor used to bind — is DERIVED from the coordinate set the user picks
(`core/runtime/coordinateAxis.ts`, a join over declarations).

So this is not a site that stopped being covered; it is a site that stopped
existing, and the distinction is the one this document already draws between a gap
and a defect. **Nothing auto-binds an axis, because nothing binds one.** There is no
control here whose value could be mistaken for a choice a person made, and therefore
no O1/O2 obligation to discharge: the only thing a user picks in that pane is the
coordinate set, and they pick it by hand — § Coordinates deliberately omits
`auto_bind_sole_candidate`, which under DEC-15 means OFF even when exactly one
coordinate set exists. A derivation is not a binding, and marking it `auto` would
re-introduce the failure O4 forbids: a fact stated about nothing.

The count above is therefore **three live sites**, not four. Restoring an axis
control (any control that asks WHICH ROWS, under any name) re-opens this entry: it
would be a fourth site again, it would need the VISIBLE leg again, and the argument
for why is preserved in the paragraph above rather than re-derived.

### The fifth site, and why it is left alone

`extensions/.../chaining.ts::buildChainLaunch` composes a launch for "run the step
that produces this first": it derives the SLOT and binds the artifact the user was
looking at, with no picker gesture at either end. It carries no origin at any hop.

It is not changed here, for two reasons, and the second is the one that makes the
omission safe rather than merely convenient:

1. `chaining.ts` is owned by a concurrently-running branch. Editing it would collide,
   and a merge conflict in the one module that composes launches is a poor trade for
   a leg that is not load-bearing.
2. **The gap it leaves is UNSTATED, not misstated.** A chained launch records no
   `bound_by` at all, and by O4 an absent origin is never read as `user` — not by the
   run table, not by the exported bundle, not by `methods.md`. So the failure mode is
   "this run says nothing about how its input was chosen", which is true, rather than
   "this run claims a review that never happened", which is the error the whole change
   exists to prevent.

The distinction is worth stating precisely because it is the one that decides whether
a hole can wait: an under-report that is SILENT is a gap, an under-report that reads
as a REVIEW is a defect. This one is the former.

## The rule

**A binding carries how it was chosen, and the origin travels as far as the value
does.**

- **O1** — A binding carries how it was chosen. `origin` is `user` or `auto`, it is
  written at the same moment the value is written, and it travels wherever the value
  travels.
- **O2** — An auto-bound value is never rendered as a chosen one. Every control that
  displays a binding displays its origin, without hover, and the mark survives into
  the exported record.
- **O3** — A run records the origin of every input it consumed. A run launched on an
  input nobody reviewed is observably different, in the provenance record, from one
  launched on an input a user chose.
- **O4** — Origin is a RESOLVED fact, never an absence. `auto` is written, never
  inferred from a missing `user` mark, and nothing refuses on "origin is unknown".
- **O5** — A user write resolves the origin to `user`, whatever it was before.
  Re-picking an auto-bound input is the review, and the record must say so.

## Annotate, do not block

An unreviewed auto-bind **launches**, and the run's provenance record states that
the input was bound automatically. It does not block.

Three reasons, in descending order of weight.

1. **A block at site 2 is unresolvable by construction.** Site 2 exists precisely
   for the caller that *cannot be asked* — an agent or MCP call with no form and no
   human at the keyboard. A refusal there has no path to a resolution, and this repo
   has already paid twice for a gate that can never resolve: a refusal that never
   clears is indistinguishable from no refusal at all. Blocking would convert every
   headless launch into a permanent failure, which is not safety, it is removal of
   the feature.
2. **DEC-15 is owner-approved and explicitly behaviour-preserving.** The owner ruled
   the declaration opt-IN *"so live behaviour is unchanged"*, and three shipped
   packages were migrated to declare it for exactly that reason. A block would
   silently re-break the three surfaces that migration existed to protect — the
   second half of the same mistake, one round later.
3. **The provenance record is an out-of-app trust deliverable, and this is precisely
   the kind of fact it exists to state.** An unreviewed input is not a bug to be
   prevented; it is a property of the run that a reader of the bundle is entitled to
   know. Recording it is stronger than refusing it, because the record outlives the
   session and reaches a reader who was never at the keyboard.

What makes this different from "annotate passively" is that the annotation is
**load-bearing on three surfaces that already exist** (R8's own test for whether a
marker is real): the control, the run's `inputs_json`, and the exported bundle's
`inputs.json` + `methods.md`. A mark that lives only in a tooltip fails that test,
and would be the passive option this rejects.

## Shape

### The store layer is a SIDECAR, not a wrapped value

The obvious reading of "make a binding a `{value, origin}` pair at the store layer"
is to wrap the stored value. Checked against the code, that is wrong here, for four
reasons that are properties of this tree rather than of the idea:

1. View state is read by the declarative expression language (`$state.matrices`),
   fed to the `derived` primitives (`unique`, `extent`, `filter_mask`, `keep_mask`)
   and to `for_each`. Wrapping the value changes the meaning of every `$`-reference
   in every shipped `ui/*.yaml`.
2. `ViewStore.snapshot()` is the AI-facing surface (`<view>.describe`). Wrapping
   changes the agent-visible contract of every field, not just the bindable ones.
3. A `scope: pane` write coerces (`typeof value === 'string' ? value : null`). A pair
   would land as `null`.
4. Only `artifact_ref` bindings can be auto-bound. Wrapping taxes every field with a
   property four of them have.

So origin is a **sidecar map keyed by field path on the same store, written in the
same `set` call**. One call writes both, so the value and its origin cannot
desynchronize — which is the whole reason the pair was wanted, and the lesson the
stale-snapshot class already taught: *keep whatever pairs with a value captured at
that same moment.*

### The chain

```
control / auto-bind  →  ViewStore.set(field, value, origin)   ← one write
                        params + paramOrigins (fallback form)
        ↓
run_processor        →  per-slot origin, from the DECLARED inputs: expression
        ↓
RunInput { slot, artifactId, origin }
        ↓
AnalysisSpec.inputs[] { slot, artifact_ref, bound_by }
        ↓
InputDecl.bound_by                        (server, sandbox/spec.rs)
        ↓
UsedEdgeDto.bound_by  →  provenance_run_repro.inputs_json
        ↓
export: inputs.json + per-step inputs.json + methods.md
```

Per-slot origin at `run_processor` is read from the **declared** `inputs:`
expression, using the expression language's OWN reference tokenizer — not a new
regex, and not an inference from a name. Every `$state.…` / `$scope.…` reference in
the declared expression is resolved against the store's origin sidecar, and `auto`
wins over `user` (a slot fed by anything auto is auto). An expression referencing no
state — `inputs_from` bindings resolve out of `$data`, which no picker writes — has
no origin, and no origin is not `auto` (O4).

### Vocabulary

`user` | `auto`. Two values, deliberately. A DECLARED `default:` in a view spec is a
third thing and is out of scope on purpose: it is authored by the package, visible in
the form before anyone touches it, and it is the consent R2 asks for. Sole candidacy
is not consent; a declared default is.

## Out of scope

- `readiness.json` gaining an "every input was reviewed" check. The fact reaches the
  bundle through `inputs.json` and `methods.md`; a readiness gate is a separate
  product decision about what makes a run publishable.
- A per-project setting to turn auto-binding off wholesale. `auto_bind_sole_candidate`
  is already the off switch, per package, per slot.
- Backfill. Runs recorded before this carry no `bound_by`, and absent is absent — not
  `user` (that would be a fabricated claim about a review that never happened) and not
  `auto` (a fabricated accusation). O4 is what makes the absence safe to leave.
