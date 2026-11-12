# The artifact picker shows a tree, so it should render one

## Why

The count-matrices picker offers artifacts as a flat list of strings. Three defects, all
the same root cause:

1. **A long dataset name overflows.** The option is one string; the control clips it.
2. **The dataset an artifact came from is invisible.** A user with three datasets attached
   to a project cannot see which one an option belongs to.
3. **When it IS shown, it is shown where truncation removes it.**

The data is already a tree — dataset → artifact — and the picker flattens it into a
string.

## What is actually there today

`source_dataset_name` was added (ITEM-22) for exactly this. Its own docstring states the
intent:

> the picker **groups**/labels candidates by which dataset each came from, so a user with
> several datasets attached to a project can tell the inputs apart

What shipped is `disambiguate()` in `core/runtime/axisSource.ts`:

    label = ds ? `${c.label} · ${ds}` : c.label     // only when labels COLLIDE

So the grouping became string concatenation, applied only on collision. Two consequences:

- **In the common case the dataset is not shown at all.** The discriminator appears only
  when the system happens to notice two labels are identical — which is not the only time
  a user needs it.
- **In the collision case it is appended at the END**, and both the trigger and the option
  row are `truncate` (tail-clipping). The one substring that distinguishes the options is
  the first thing cut. `counts · Patient-A-…` and `counts · Patient-A-…` clip identically.

That is not a smaller version of a working picker. Choosing wrong here silently anchors the
whole run — including the axis every dependent control resolves from — to the wrong dataset.

## Why native rendering cannot fix it

An `<option>` is a flat string by specification: no second line, no secondary text, no
control over truncation, no styling. `<optgroup>` adds exactly one flat level of grouping
and nothing else. Every property this picker needs is outside what the element can express.

There is also an inconsistency worth removing on its own: the **multi** arm renders through
the kit's `MultiSelect` while the **single** arm drops to `NativeSelect`. One widget, two
rendering systems, two different sets of behaviour.

## The change is mostly REUSE, not a new control

`@txresbench/kit`'s `Select` already carries the whole vocabulary:

| need | kit `Select` | kit `MultiSelect` |
|---|---|---|
| grouped options | `SelectOptionGroup { label, options }` | **missing** — flat `MultiSelectOption[]` |
| custom option row | `optionRender?: (o) => ReactNode` | **missing** |
| custom trigger | `labelRender?: (o?) => ReactNode` | — (renders tags) |
| tail truncation | yes | yes (`truncate`, lines 128/158) |

So: the single arm stops using `NativeSelect` and uses `Select` with groups. The one real
kit addition is grouping + per-option rendering on `MultiSelect` — which is the arm the
count-matrices picker actually uses, and therefore the arm the complaint came from.

**Prefer extending `MultiSelect` over building a bespoke picker.** A control built inside
the workbench would be a second select implementation that every other kit consumer does
not get, and this repo has paid for parallel implementations of one concept before.

## Decisions

### DEC-1: group by source dataset ALWAYS, not only on collision

The grouping IS the disambiguation. A collision-only tie-breaker shows the discriminator
only when two labels happen to match exactly — but a user needs to know which dataset an
artifact came from whether or not another artifact shares its name.

`disambiguate()`'s id-suffix last resort stays, for genuine within-group ties (two
artifacts of ONE dataset with the same member name). It is unreachable in the common case
once grouping carries the dataset.

### DEC-2: the dataset is the GROUP HEADER, never a suffix

This is what fixes the overflow, not a wider control. With the dataset as a header, the
truncated text is the artifact name — the part that repeats — and the discriminating part
is on its own line, whole. Suffixing puts the discriminator in the clipped tail.

### DEC-3: artifacts with no source dataset get a NAMED group

`source_dataset_name` is nullable, and rows from some catalog reads carry no
`source_dataset_id` at all. They must not fall into an unlabelled group that reads as a
rendering bug. Name the group for what those artifacts ARE (produced by a run rather than
imported, per the row) — decide the wording against a real project's catalog, not from the
type.

### DEC-4: this is a CORE render change, and both analyses inherit it

`ArtifactRefWidget.tsx` is the single renderer for every `artifact_ref` in every shipped
view. QC and cell-filter inherit the fix with **zero** processor or view-file edits, and so
does every future one. INV-2/INV-6: the view declares `kind: artifact_ref` and what it
accepts; core owns how that renders. A per-view fix would be the wrong layer and would
have to be remembered by every author.

### DEC-5: no native select in the declarative widget vocabulary

The rule is scoped: `NativeSelect` stays a legitimate kit primitive for ordinary app
chrome. What it may not be is the rendering of a DECLARED control, because those are the
surfaces a processor author has no way to style, fix, or even see. Two files use it today
(`core/render/ArtifactRefWidget.tsx`, `extensions/widgets/renderers.tsx`) — sweep both, and
pin it so the third does not appear.

### DEC-6: state what the secondary line carries — and keep it to what is decidable

An option row can carry more than a name (datatype, dims, produced-by). More is not
better: every field costs a line and a scan. Decide against a REAL catalog — the QC picker
on a project with several datasets — and prefer the field that answers "is this the one I
mean". Anything not selected is not shipped; do not fill the row because it is empty.

### DEC-7: a truncated label must not be the only way to read the value

Whatever clips must remain reachable — the full value on hover/focus, at minimum. A user
who cannot read the option cannot verify the choice, which is the same defect as not
showing it.

## Surfaces

- `sdk/packages/kit/src/kit/multi-select.tsx` — grouped options + `optionRender`.
- `src-app/ui/src/modules/workbench/core/render/ArtifactRefWidget.tsx` — both arms render
  grouped; the single arm stops using `NativeSelect`.
- `src-app/ui/src/modules/workbench/core/runtime/axisSource.ts` — candidates carry the
  source dataset STRUCTURALLY (`{id, label, datatype, datasetId, datasetName}`) instead of
  concatenating it into `label`. `disambiguate()` narrows to within-group ties.
- `src-app/ui/src/modules/workbench/extensions/widgets/renderers.tsx` — the other
  `NativeSelect` use (DEC-5).
- `shippedFormConformance.test.tsx` — the tier already asserts every rendered affordance is
  honest; grouping is a rendered affordance.

## Acceptance

1. On a project with two datasets, the QC count-matrices picker shows each artifact under
   its dataset — with no collision required to make the dataset appear.
2. A dataset name long enough to clip does not overflow its container at a narrow viewport,
   and the artifact rows stay readable.
3. Two artifacts whose labels collide are distinguishable WITHOUT reading a truncated tail.
4. Cell-filter's pickers get the same rendering with **zero** edits to
   `cell-filter.yaml` or any processor file. That is the architectural claim; QC is
   merely the example.
5. The single-select arm and the multi arm render the same way — one widget, one system.
6. No `NativeSelect` remains in the declarative render path, and a guard keeps it out.
7. The full text of a clipped label is reachable without selecting the option.
