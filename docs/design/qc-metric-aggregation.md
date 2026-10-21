# QC metric aggregation — an explicit third column

## Why

Today the QC metric table has two columns, `Metric` and `Gene regex`, and every row means
exactly one thing: `100 × Σ(matching genes) / total counts`. That aggregation is never
stated. It is not configurable, it is not shown, and the emitted column name
(`pct_counts_<name>`) is the only place it surfaces — after the run.

Two consequences, both observed:

1. A user cannot ask for the **sum** of a gene set, its **mean**, or how many of its genes
   were **detected**. The form offers a name and a regex; the compute offers one formula.
2. The one decision the system makes on the user's behalf is invisible, so a result cannot
   be read without knowing the source. `pct_mito = 0` means either "no mitochondrial reads"
   or "the regex matched nothing" — and nothing on screen distinguishes them.

This is the same class the manifest/UI separation removed elsewhere: a fact the system
decides silently, that the user has no way to see or state.

## The change

    Metric              | Genes            | Aggregation
    --------------------|------------------|-------------
    pct_mito            | ^MT-|^mt-        | percentage
    pct_ribo            | ^(RP[SL]|Rp[sl]) | percentage
    total_counts        | .*               | sum
    n_genes             | .*               | count
    housekeeping_mean   | ^ACTB|^GAPDH     | mean

`Aggregation` is a closed set of four. Each is a COMPLETE definition including its
denominator — there is no separate "as a percentage" flag.

    sum[c]        = Σ_{g∈set} X[c,g]
    mean[c]       = Σ_{g∈set} X[c,g] / |set|            ← see DEC-2
    count[c]      = |{ g∈set : X[c,g] > 0 }|
    percentage[c] = 100 · Σ_{g∈set} X[c,g] / Σ_{all g} X[c,g]

**Why one column and not reducer × normalisation.** A shared "as % of total" flag implies
ONE denominator. Each reducer's natural percentage has a different one: sum → % of the
cell's total counts; count → % of the genes IN THE SET that were detected; mean → nothing
coherent. A flat vocabulary of four keeps each denominator inside its own definition and
makes no meaningless combinations expressible.

All four are one weighted `bincount` pass over the CSC trio — the same cost as today.
Median is deliberately EXCLUDED: a per-cell median over a gene subset needs the values
grouped per cell, which is a different algorithm and a real cost at 35k genes. Adding it
later is a separate decision, not an omission.

## The builtin/pattern split disappears

`total_counts` and `n_genes_by_counts` are currently name-matched against a hardcoded
`BUILTIN_METRIC_NAMES` in the compute, carry no pattern, and cannot be edited — a special
case with its own parse path (`parse_builtin_metrics`) and its own UI treatment.

Under this spec they are ordinary rows: `sum` over all genes, and `count` over all genes.
The special case, its constant, and its parse path are deleted. A user can remove them,
rename them, or narrow them to a gene set — none of which is possible today.

## Decisions

### DEC-1: the emitted column name is the metric's `name`, verbatim

Today the compute decorates: a row named `mito` emits `pct_counts_mito`. With four
aggregations the decoration would have to vary by aggregation (`sum_`, `mean_`, `count_`,
`pct_`), which is a rule the user has to learn in order to predict their own output.

Instead the `name` cell IS the column name. The shipped defaults are renamed so the
familiar names still appear: `pct_mito`, `pct_ribo`, `total_counts`, `n_genes`.

**Basis:** the feature's own principle — do not invent what the user can state. It also
makes the metric table's first column mean exactly one thing, rather than "a stem the
system will decorate".

**Cost, stated plainly:** an existing run emitted `pct_counts_mito`; a re-run under this
spec emits `pct_mito`. See *Migration*.

### DEC-2: `mean` divides by `|set|`, not by the detected count

`Σ / |set|` counts undetected genes as zeros; `Σ / |{detected}|` does not. Both are
defensible and they give different numbers.

`|set|` is chosen because "the mean expression of my housekeeping set" conventionally
includes the zeros — a gene that is off is information, not a missing value — and because
the alternative is expressible as `sum` ÷ `count` from two rows, whereas the reverse is
not.

**This must be stated in the UI**, not just here: the Aggregation cell's help text says
which denominator `mean` uses. A hidden denominator is the defect this spec exists to
remove.

### DEC-3: `Genes` replaces `Gene regex`

The column selects a gene SET; a regex is one way to express it. The repo already has a
`geneset/collection` datatype, so a set REFERENCE is a plausible future cell value. Naming
the column after the mechanism would have to be undone then — the same rename this feature
already did for `accepts` → `appliesTo`.

The cell accepts a regex today. An empty value is REFUSED at the compute (already true —
`compile_gene_pattern` rejects absent/empty rather than defaulting to `""`, which used to
match every gene and produce a fake 100% column).

### DEC-4: an unknown aggregation is a hard failure, not a default

`parse_qc_metrics` must refuse a row whose `aggregation` is absent or outside the closed
set, naming the row. It must NOT fall back to `percentage` for compatibility: a silent
default is how the current invisible aggregation arose.

## Migration

Existing `qc_metrics` rows have `{id, name, pattern}` and no `aggregation`, and existing
run outputs carry `pct_counts_<name>` columns.

- **Persisted view state** (a workspace with an in-progress QC form): a row with no
  `aggregation` is REFUSED by DEC-4 rather than defaulted. The view must migrate its own
  seeded state — the shipped defaults ship with aggregations, and a stale persisted row is
  repaired on load by the same shape that repairs a retired pane kind, or the form refuses
  with a message naming the row. Pick one and pin it with a test; do not let a stale row
  reach the compute.
- **Existing produced columns** are NOT renamed. `pct_counts_mito` stays what it is; a new
  run emits `pct_mito`. Consumers that read a column by name — the canvas series, the
  cell-filter criteria builder — resolve columns from the ARTIFACTS (INV-5), so both names
  coexist without a lookup table. State this in the release note: a project with runs from
  both eras will show both columns, and that is correct.

## Surfaces to change

- `packages/qc/ui/qc.yaml` — the table gains an `Aggregation` cell; `$const.defaultMetrics`
  gains the field and the renamed defaults; the two builtin rows become ordinary rows; the
  `addMetric`/`addHb`/`addIsotype` actions append an aggregation.
- The view-spec **cell vocabulary** — an `Aggregation` cell is a closed-set choice. Check
  whether a `select` cell primitive exists beside `editable_text` and the `button` cell
  added for row deletion. If not, add it GENERICALLY (INV-6 forbids a bespoke
  qc-metric-list kind); a closed-set cell is reusable by any table.
- `packages/qc/compute/qc-10x.py` — `parse_qc_metrics` reads and validates
  `aggregation`; `parse_builtin_metrics` + `BUILTIN_METRIC_NAMES` are deleted; the four
  reducers; the emitted column name is the metric's `name` (DEC-1) with a duplicate-name
  refusal.
- `packages/qc/tests/` — a case per aggregation with hand-computed expected values on a
  tiny fixture; the DEC-4 refusal; the duplicate-name refusal; the DEC-2 denominator.

## Acceptance

1. A row with each of the four aggregations produces the hand-computed values on a fixture
   whose numbers are checkable by eye.
2. `total_counts` and `n_genes` produced as ORDINARY rows equal what the deleted builtin
   path produced for the same input — the special case is removed without changing results.
3. A row with no aggregation, or an unknown one, FAILS the run naming the row.
4. The Aggregation cell renders as a closed-set control, and what it shows is what the run
   receives (the shipped-form conformance tier already asserts show == state == launch).
5. `mean`'s denominator is visible in the UI without running anything.
