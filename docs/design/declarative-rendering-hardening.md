# Declarative rendering — robustness hardening (design)

**Status:** Slice 1 landed (`c0fe6c05`). Slices 2 + 3 are what this document specifies.

## 0. Why this document exists

The declarative rendering engine
(`src-app/ui/src/modules/workbench/declarative/`) is what **every** processor
surface renders through: a processor ships a `view_spec` as DATA
(`packages/<p>/ui/<p>.yaml`), and `DeclarativeRegion` → `WidgetList` →
`WidgetHost` → a per-kind renderer paints it. There is no per-processor React.
That means a defect in the shared engine is a defect in **every** processor UI,
present and future — and, symmetrically, a fix at the shared layer improves all
of them at once.

A robustness audit of the engine was performed against the tree at
`e5b4da29`. Its conclusion:

> The robustness **core** is genuinely good — per-widget `WidgetErrorBoundary`,
> an expr trust boundary, bounded `for_each`, defensive `asArray`/`toOptions` so
> a missing `options` degrades rather than crashes. The gaps are
> **layout**, **failure-surface**, and **coverage**.

The audit's findings are recorded below **verbatim** as F-N. They are the design
source; `.lifecycle/declarative-rendering-hardening/PLAN.md` is derived from
them and may not reframe them.

## 1. Audit findings (verbatim)

### Slice 1 — layout (LANDED, `c0fe6c05`)

> **F1 / F5 / F6 (layout):** a fanned form had NO padding, NO field alignment and
> NO width constraint; in a wide (bottom-dock) pane the controls AND the action
> buttons stretched edge-to-edge across the whole page (measured
> button-width : container-width ratio = 1.0, container padding = 0).

Fixed by the shared `RegionBody` (region frame: padding / gap / max-width /
reflow) + `WidgetField` (kit `Field`-based label/description/error scaffold).

### Slice 2 — failure-surface vocabulary

> **F3 (HIGH):** a failed data fetch renders a silent empty region — `viewData.ts`
> logs to console and returns `undefined`, and `DeclarativeRegion` just "renders
> structure", so backend-down / permission-denied is indistinguishable from
> genuine no-data.
> **Fix:** thread a `dataStatus` (`loading` | `ready` | `empty` | `error`) into
> the declarative store; render a real inline `Alert` (error, retryable) /
> `Empty` (no-data) / `Skeleton` (loading) at the region level. The information
> needed already exists at the `viewData` fetch site.

> **F7 (MED):** `WidgetErrorBoundary.resetKey` is the `scope` OBJECT IDENTITY,
> but `DeclarativeRegion` rebuilds a fresh `scope` literal every store-revision
> render — so the boundary resets on EVERY render regardless of whether the data
> was corrected, defeating the latch and re-throwing/console-spamming on every
> slider tick.
> **Fix:** key the reset on a stable signal (the store `revision`/token), not
> reference identity.

> **F9 (LOW):** empty `select`/`dataset-picker` render a blank native control
> with no affordance — add an empty-state row ("No options yet"); finish or
> properly gate the wave-2 `dataset-picker` placeholder that currently only
> echoes its value.

> **F8 (LOW):** the widget failure placeholder is generic ("Widget failed to
> render") — include the widget label/kind and offer a retry that bumps the reset
> signal.

### Slice 3 — responsive + gate coverage

> **F4 (HIGH):** there is ZERO gallery / `gate:ui` coverage of ANY declarative
> surface — so every processor UI's default quality is unverified at any width,
> and regressions in the shared engine are invisible until a human notices
> in-app.
> - Add gallery fixtures mounting `DeclarativeRegion` over representative specs:
>   **loaded**, **empty-data**, **error-data**, a **50-criteria `for_each`
>   stress**, a **long-label** case, and a **malformed-widget** case — each at
>   **narrow (~390px)** and **wide**.
> - Bring them under `npm run gate:ui` (runtime-health + the Layer A/axe pass).
>   Use a DEDICATED `GALLERY_PORT` — the default :1420 is often held by a foreign
>   worktree on this box and produces Category-B false failures.
> - Assert the Slice-1 invariants hold under these fixtures (container padding >
>   0; action buttons NOT ≈ container width in the wide case; no horizontal
>   overflow at 390px).

> **F2 (hardened by Slice 3):** the engine's degrade-don't-crash behavior
> (`asArray`/`toOptions`/`WidgetErrorBoundary`/bounded `for_each`) is only
> exercised by unit tests; no rendered surface proves it.

## 2. Non-negotiables

These are the promises the implementation may not silently reframe. They are
lifted into `PLAN.md`'s `## Invariants` verbatim and each is pinned by an
executable acceptance test.

1. **A failed data fetch must be visually distinguishable from genuine no-data.**
   A `dataStatus` (`loading` | `ready` | `empty` | `error`) is threaded into the
   declarative store and the region renders a real inline `Alert` (error,
   retryable) / `Empty` (no-data) / `Skeleton` (loading).
2. **The widget error-boundary reset is keyed on a stable signal (the store
   revision/token), not reference identity** — so an unrelated re-render does not
   defeat the latch.
3. **An empty `select`/`dataset-picker` never renders a blank native control with
   no affordance** — it shows an empty-state row.
4. **The widget failure placeholder names the widget (label/kind) and offers a
   retry that bumps the reset signal.**
5. **Every representative declarative surface (loaded / empty-data / error-data /
   50-criteria `for_each` stress / long-label / malformed-widget) has gallery
   coverage at narrow (~390px) and wide, running under `npm run gate:ui`.**
6. **The Slice-1 invariants hold under those fixtures: container padding > 0;
   action buttons NOT ≈ container width in the wide case; no horizontal overflow
   at 390px.**

## 3. Design constraints inherited from the engine

- **The engine stays domain-agnostic.** No processor-specific literal may enter
  `declarative/`. Every status/empty affordance is derived from the DECLARED
  spec (`spec.data` slice declarations, a widget's `options` binding), never from
  a hardcoded processor id or datatype.
- **Degrade, never crash.** A new failure surface must itself be defensive: the
  status resolution is best-effort and a status it cannot classify falls back to
  the pre-existing "render the structure" behavior.
- **`center` is the canvas grid, not a form.** The status surface is a REGION-BODY
  affordance and therefore applies to the fanned control regions
  (`left`/`right`/`bottom`). `center` keeps its own, older `inputReadyGate`
  ("Input not ready" + "Run <prerequisite> first"), which already answers the
  same question for the hero.
- **Shared-layer only.** Nothing here may be fixed in one renderer if the same
  bug exists in the shared scaffold.
