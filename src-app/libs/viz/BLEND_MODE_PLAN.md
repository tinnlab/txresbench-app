# Blend Mode / Multi-Channel Encoding — Design Plan

Co-visualize more than one data channel in a single mark — the headline case being a
**categorical annotation + a continuous value at once** ("which cluster **and** how much"). The
legacy TxResBench app did this on the CPU (chroma-js + one ECharts `visualMap` **per cluster**);
we do it **GPU-native** as an extension of the existing in-shader color LUT.

## The model: two stages — REDUCE → ENCODE

The *reduce* stage is **shared across all plot types**; the *encode* stage is **per plot type**.

### Stage 1 — Reduce (collapse N channels of a kind to one derived channel)

| Inputs | Reduce to |
|---|---|
| `cat` | the category |
| `cat + cat + …` | **concatenate** → one cross-product category (`A&X`, `A&Y`, …) |
| `real` | the value |
| `real + real + …` | **aggregate** → one scalar; operator is user-selectable (**mean** default; sum / product / min / max / median) |
| `cat(s) + real(s)` | concat the cats **and** aggregate the reals → one category + one value |

Two load-bearing rules (real footguns):

- **`real + real` MUST normalize each column to [0,1] BEFORE aggregating.** Otherwise a `sum`/
  `product` is dominated by the wider-range column and is meaningless. `mean` is the sane default;
  `product` of [0,1] values shrinks toward 0 (document it).
- **`cat + cat` = a FRESH combined category per combination** (its own hue), NOT the legacy
  "average the two parent hues" (averages collide: `avg(A,B) ≈ avg(C,D)`). Guard the **cross-product
  explosion** (K₁×K₂ combos vs a 20-color palette): assign fresh palette colors up to the palette
  size, then warn / cycle.

### Stage 2 — Encode (differs by plot type)

- **Scatter / spatial (per-point) — the actual "blend":** concat-category → **base hue** (palette
  LUT); aggregated-value → **lightness** (default — stays visible on a dark canvas) **or alpha**
  (legacy parity, opt-in). "Split the visual map per group": within each concatenated category the
  value ramps the lightness. Domain choice: **per-group** (each cluster's internal variation is
  visible — the "which cluster + how much" idiom, legacy) vs **shared-global** (cross-cluster values
  comparable) — a toggle, default **per-group**, reusing our shared-color-domain coordination for
  the global option.
- **Aggregated charts (violin / box / bar / dotplot):** the reduce stage feeds their **native
  encoding**, not a hue×lightness blend (they already put category on an axis + value in the mark).
  So there: multi-`cat` → **group-by multiple columns** (the group axis becomes the cross-product);
  multi-`real` → **aggregate** the plotted value. A data-reduction feature, not a color blend.
- **Heatmap:** multiple value columns are already its **rows** (`valueList`), so multi-real there =
  more rows, not an aggregate. Multi-cat → cross-product column grouping.

## Option-API implications

- `group` (categorical) binding → accept `string[]` with **concat** semantics.
- color/value channel → accept `string[]` + an `aggregator` (`mean|sum|product|min|max|median`) +
  a `normalize` flag.
- `colorBy: { mode: 'blend', … }` tying concat-cat → hue + aggregated-real → lightness/alpha, with
  the per-group/shared-domain toggle and the lightness|alpha channel choice.

## Architecture fit (why it's cheap)

Coloring is already in-shader (`ColormapScatterLayer`, the `vFillColor` write ~L131-145): one
per-point float attribute + a palette/colormap texture. Blend = keep the palette-sampled base hue
and modulate it by a **second** per-point scalar → **one extra instanced attribute + a couple of
uniforms + ~5–15 lines of GLSL** (base hue from the LUT, then `mix`/HSL-lightness by the normalized
value). **GPU-only, no CPU precompute; the single-channel color-by path stays byte-identical** (the
mod attribute defaults to off). Reuse `coordination/colorScale` for the value domain. The one
genuinely new UI surface is a **2D legend** (hue rows × value ramp).

Key files — ours: `gpu/ColormapScatterLayer.ts` (shader seam), `gpu/colormapLut.ts`, `data/color.ts`,
`data/engine.ts` (`ColorBy`), `DeckScatterCanvas.tsx` (attribute wiring), `coordination/colorScale.ts`,
a new 2D-legend component, `option/{types,parse}.ts`. Legacy reference:
`~/…/txresbench-ref/sc-website/imports/ui/pages/Analysis/CentralVisualization/echartsOptions.ts`
(`aggregateScatterPlots`, the cat×continuous alpha-ramp) for parity.

## Phasing

- **Phase 1 (build now):** scatter/spatial blend — **1 categorical → hue + 1 continuous →
  lightness** (+ alpha opt-in), per-group domain, the GPU shader + `ColorBy` `'blend'` variant +
  option-API single-channel blend + the **2D legend**. Single-channel color-by must stay
  byte-identical.
- **Phase 2:** the multi-column **reduce operators** — concat N cats (with the palette guard),
  aggregate M reals (operator + normalize) — wired into **both** the scatter blend **and** the
  aggregated charts' group-by / value. (This is where the `string[]` bindings + aggregator land.)
- **Phase 3 (optional):** `cat×cat`-only (concat-category coloring) and `real×real`-only
  (aggregated-value continuous coloring) as standalone modes — they fall out of Phase 2.

Domain-neutral framing throughout: "category → base color, continuous → luminance/alpha
modulation", not gene/cluster-specific.
