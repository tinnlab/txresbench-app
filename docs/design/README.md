# Binding design references

Files here are **binding references**, not illustrations. Where one of them and a design
document's prose disagree, **the file here wins** — that is the owner's standing ruling, and
this directory exists so that the ruling has somewhere to live.

## `visualize-pane-mockup.html`

The Visualize pane, drawn at its real width (a 300 px region, a 284 px content box), with the
happy path and the three states that are not it. Open it in a browser; it is self-contained.

**Owner ruling (2026-08-13):** *"yes, mockup is the binding reference"*.

It was refined over hours and then cited by nothing. `grep -ci mockup` over the 152,514-byte
`.lifecycle/visualize-pane/DESIGN.md` (on branch `feat/visualize-pane`; the design was never
merged to `main`, which is part of the same problem) returns **0**: the plan never referenced it, no
gate compared against it, and no test asserted it. The pane consequently shipped with a Row
space control that enumerated every axis in the project — so one imported file offered two
populations, one of which nothing could be drawn on — while the mockup's own Row space block
lists three things a person would plot, each named by its source with its count beside it. A
reference nothing reads is not a reference; that process failure is the reason for this
directory and for the gate below.

### What reads it

- `src-app/ui/tests/e2e/15-visualize/mockup-conformance.spec.ts` — **parses this file at test
  time** and compares it against the pane rendered by the running app at the pane's real width:
  the block order, and the vocabulary each block defines. Editing either side without the other
  fails the gate. Structural and source-reading checks provably cannot catch this class — the
  shipped defect was legal, typed, tested and wrong — so the gate reads the RENDERED result.
- `src-app/ui/src/modules/workbench/core/runtime/rowSpaces.ts` — the candidacy rule cites the
  Row space block as the statement of what a row space is.
