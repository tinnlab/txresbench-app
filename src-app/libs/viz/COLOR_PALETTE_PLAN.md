# Categorical Color Palette — Custom Palettes, Stable Identity, Shortfall Policy

## The gap (current state)

Group (categorical) coloring uses a **fixed built-in 20-color palette** (`CATEGORICAL_PALETTE`,
`data/color.ts`) and there is **no way to supply your own colors**:

- The option-API `encode.colorBy` = `VizColorBy` (`Partial<ColorBy> & { mode, key }`), and
  `ColorBy = { mode, key, colormap, scale, hidden }`. The `colormap` field is a **continuous**
  colormap (viridis/…) — it does NOT apply to categorical. So a `{ mode:'categorical', key }`
  color-by has **no palette input**.
- A group **code → color is `CATEGORICAL_PALETTE[code % 20]`** — identical in the CPU path
  (`categoricalColors`), the GPU LUT (`buildPaletteLUT`, 256 entries filled `palette[i % n]`), and
  the legend swatch (`categoryColor`). So **>20 groups (or any palette shorter than the group
  count) SILENTLY CYCLE** → colliding colors, no warning, no auto-extend.

## Design

1. **Custom palette on the color API** — `ColorBy` (categorical) + `VizColorBy` gain, additively
   (single-channel + continuous paths unchanged):
   - `palette?: (string | readonly [number,number,number])[]` — an **ordered** override
     (code → `palette[code]`). Default = the built-in 20.
   - `categoryColors?: Record<string, string | [r,g,b]>` — an **explicit by-NAME** map, the
     **stable-identity** form: a named group always gets its color regardless of code order (e.g.
     "cluster 3" / "T cell" is always the same color across panes AND datasets). This is the more
     important one for real apps + cross-plot consistency.
2. **Shortfall policy — AUTO-EXTEND, not silent cycle.** When the effective palette has fewer
   entries than the group count, **generate additional maximally-distinct colors** (hue-rotate /
   lightness-vary the seed, or a golden-angle HCL generator — the d3/vega approach) up to the group
   count, with a **dev-mode warning**. Never reuse a color ambiguously. (Palette ≥ groups = fine;
   >256 groups is a rare edge — cycle + warn, bounded by the LUT size.)
3. **Stable identity via coordination.** The by-name map resolves through the shared color-scale
   coordination (`coordination/colorScale.ts`) so linked panes agree on a group's color.

## Where it plugs in

- `data/color.ts` — `CATEGORICAL_PALETTE` becomes the *default*; `categoricalColors` / `categoryColor`
  read an **effective palette** (custom ordered ∪ by-name map, auto-extended to ≥ group count); add
  the auto-extend generator (seed + N → N distinct colors).
- `gpu/colormapLut.ts` — `buildPaletteLUT(effectivePalette)` builds the 256-entry LUT from the
  effective palette (extended to cover the group count).
- `data/engine.ts` — `ColorBy` gains `palette?` / `categoryColors?`; `computeColoring` resolves the
  effective palette (map category names → codes → colors) for both CPU + GPU paths.
- `option/types.ts` + `parse.ts` — `VizColorBy` accepts `palette` / `categoryColors`, validated.
- `controls/Legend.tsx` — renders the effective palette (incl. auto-extended entries).

## Sequencing

Do this **AFTER blend Phase 1 reconciles** — it edits the same files
(`data/color.ts`, `data/engine.ts`, `ColorBy`, `gpu/colormapLut.ts`) the blend build touches, so
running them over the same files concurrently would collide.

Domain-neutral throughout: "category → color", ordered palette + by-name map + auto-extend — no
gene/cluster-specific vocabulary.

## Per-group DISPLAY OVERRIDES (color + label) — legacy parity, especially for export

Legacy TxResBench let users override an INDIVIDUAL group's **color** AND its **label** in the
plot, regardless of the raw input — mainly to produce publication-ready exported figures. Support
this as a per-category display-override layer (the color half is the `categoryColors` map above; the
label half is new):

- **`categoryColors?: Record<string, color>`** (from above) — override one group's color. Changing a
  single group = one entry.
- **`categoryLabels?: Record<string, string>`** (NEW) — override a group's DISPLAY label (raw value
  `"3"` / `"cluster_3"` → shown as `"T cells"`), regardless of the data's category names.
- **Applied everywhere the category name/color is rendered**, so it flows into export automatically
  (export captures what's rendered): the **legend** swatches + labels (`controls/Legend.tsx`), the
  **categorical axis tick labels** (violin/box/bar group names, e.g. `ViolinView` `categories[g]`),
  and **tooltips**. A tiny `displayCategory(name)` / `displayColor(code)` resolver reads the override
  maps (fallback = the raw name / palette color) and every render site goes through it.
- **Interactive editing (the legacy UX):** the Legend already has per-category show/hide/solo — add
  a per-swatch **color picker** + an **editable label**, writing into the override maps (persisted in
  the workspace/coordination state) so the change is live in the plot AND in the subsequent export
  (PNG/SVG/PDF/CSV). This is the "change color/label of individual group for export" feature.
- Export-specific note: because the overrides live on the rendered legend/axes/marks, the existing
  export (whole-grid or per-pane, all formats) picks them up with no export-path change.

Files add-on: `data/color.ts` (a `displayColor`/`displayCategory` resolver from the override maps),
`controls/Legend.tsx` (color-picker + editable-label per swatch + emit override edits), each chart's
categorical-axis label site + tooltips (route through `displayCategory`), and the option-API
`categoryColors`/`categoryLabels` on `VizColorBy` (or a sibling `groups` config). Coordination-state
persistence so it survives + exports consistently across panes.
