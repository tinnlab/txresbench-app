# Dataset attach picker — readiness, search, and a CONTRIBUTED artifact preview

## Why

The project's "link a dataset" picker offers a name and a datatype tag, and nothing
else. Three things are wrong with that, in increasing order of interest.

**1. It hides readiness it already has.** A dataset whose on-ingest converter FAILED
looks identical to one that imported cleanly. The server has known the difference
since `DatasetListItem` gained `processing_status` / `processing_error` — the datasets
library table badges it on every row — and the picker throws it away: it maps its
candidates out of a bare `Dataset`, a type that does not carry the field. So a user
links a dataset with no artifacts in it, and finds out at the first analysis.

**2. Its search matches on the wrong string.** The kit `Select` turns search on past
ten options and filters on `optionHaystack(option)`, which is `searchText`, falling
back to the `label` when the label is a STRING and to `value` when it is not. This
picker's label is a `<span>` — a node — so the fallback is `value`, which is the
dataset's UUID. The control looks searchable and is: by uuid. Typing a dataset's name
narrows the list to nothing.

**3. It says nothing about what is IN a dataset.** Two rows reading `PBMC 10k raw ·
Expression matrix` and `PBMC 10k raw (copy) · Expression matrix` are the same row
twice. The system holds the answer — the dataset's artifacts, each carrying its
producer's declarations — and does not show it. Same shape as the value-preview
defect: having the information and not displaying it is the defect.

The third is the one with an architecture question attached, and it is the one this
note is mostly about. "Single-cell data normally care about the expression and its
size" is TRUE and it is NOT the app's business to know. An `if datatype ==
'single-cell/expression'` in a generic picker is the exact leak INV-1/INV-2/INV-3 and
`lint-no-domain-in-builtin` exist to prevent, and it is an `if` per datatype forever.

## The change

Three surfaces, one new read.

```
Link an existing dataset (yours or shared with you)
┌───────────────────────────────────────────────────────┐
│ Search…                                          [🔍] │
├───────────────────────────────────────────────────────┤
│ My datasets                                           │
│  PBMC 10k raw                    [Expression matrix]  │
│  3,460 cells × 32,738 genes · 63 metadata columns …   │
│                                                       │
│  Tumor QC table          [Failed]  [Untyped]          │
│  Nothing in this dataset yet                          │
└───────────────────────────────────────────────────────┘
```

- every candidate carries its DERIVED `processing_status` and, for the owner, the
  failure reason;
- every option declares `searchText`, so typing matches the NAME (and the datatype
  label), not the uuid;
- a second line says what the dataset HOLDS, composed out of phrases each datatype's
  own package contributes.

## The seam

### Who contributes

The package that owns the datatype. Nothing in the app registers a contribution, and
the app composes only strings the contributed layer already supplies:

| shown | contributed by | how it gets here |
|---|---|---|
| the phrase itself (`3,460 cells × 32,738 genes`) | the package's `dataset-preview.yaml` | the preview contribution registry |
| the datatype's title, in the FALLBACK (`Metadata column`) | the datatype manifest (`packages/<pkg>/manifest.yaml`) | `datatypeRegistry.get(id).title`, populated from `GET /api/datatypes` |
| the numbers inside a phrase | the PRODUCER, at run time | `artifacts.meta` + `artifacts.structure`, carried verbatim |

The app can COUNT, and it can repeat a declared title. It cannot say what a dataset
IS: nothing in the stored declarations connects a producer's `shape` key to a display
word, and inventing that mapping in app code is the leak INV-1/INV-2/INV-3 forbid.

### The contribution owns the SENTENCE, not a decoration on one

The first version of this seam let a contribution append `PreviewFact`s to a line the
app composed:

```
65 artifacts · 41.5 MB · 1 Expression matrix (32,738 genes, 2,286,884 non-zero) · 63 Metadata column · 1 Embedding (3,460 × 2)
```

That is the same leak one level up. The app still decided what the row led with, and
it led with `artifacts` — its own storage noun for a row in its own table — and a byte
total nobody chooses a dataset by, while the facts a reader actually wants (how many
cells, how many genes, how many metadata columns) were appended in parentheses or
missing entirely. So a contribution no longer supplies facts; it supplies the phrase.

```ts
interface DatasetPreviewContribution {
  /** The datatype id this describes. Matched up the `is_a` lattice, so a
   *  contribution on a supertype covers every subtype that has none of its own. */
  datatype: string
  /** Where this phrase sits in the dataset's line, ascending. */
  order: number
  /** The COMPLETE phrase, or `null` when the declarations it reads are absent.
   *  Pure, and MUST NOT THROW. */
  phrase: (group: DatasetArtifactGroup) => string | null
}
```

### What the app still does — and it is very little

Sort by the declared `order`, join with ` · `, and supply ONE fallback. That is all:

```
3,460 cells × 32,738 genes · 63 metadata columns · 1 embedding
```

Ties, and groups nobody contributes for, keep the server's own order (most-numerous
first); an uncontributed group sorts after every contributed phrase.

### What shape a declaration takes

A package ships a `dataset-preview.yaml` beside its `manifest.yaml`; the interpreter
(`preview/declared.ts`) turns it into the function above and knows no datatype id, no
key and no word of its own.

```yaml
apiVersion: "2.0"
previews:
  - datatype: single-cell/expression
    order: 10
    text: "{structure.shape.0} cells × {structure.shape.1} genes"
  - datatype: metadata-column
    order: 20
    text: "{count} metadata columns"
    one: "{count} metadata column"
```

A phrase is a template with exactly THREE roots, and a path must name one:

| root | is |
|---|---|
| `{count}` | how many artifacts of that datatype the dataset holds — the app's own arithmetic over real rows, and the only value here that is not a producer declaration |
| `{meta.<key>…}` | the representative artifact's `meta` — what the bytes MEAN |
| `{structure.<key>…}` | the representative artifact's `structure` — how to DECODE them |

Paths walk mappings by key and ARRAYS BY INDEX, so `{structure.shape.0}` is the first
entry of the producer's own dimension list. Requiring the root spelt out is what makes
a typo fail loudly: a bare `{n_vars}` names no root and is REJECTED at read time,
rather than resolving to nothing forever.

`one:` is the wording used when the group holds exactly one artifact. The app selects
between the two by CARDINALITY and never edits either string — inventing a plural for
a contributed word is language- and term-specific, and it is not the app's word to
inflect.

### How it resolves, and how it degrades

`phraseFor(group)` takes the MOST SPECIFIC contribution — exact datatype id first,
then the nearest ancestor by `datatypeRegistry.isA`. Three outcomes:

- **a phrase** — it is the group's whole contribution to the line;
- **a DECLINE** (`text: null`, because a path it names is absent, or because it threw,
  which is caught once per call) — the app renders its fallback at the position the
  contribution declared, so one missing producer declaration does not visibly
  re-order the line;
- **nothing at all** (no contribution anywhere along the lattice) — the fallback, at
  the end of the line.

### What an UNCONTRIBUTED datatype says, and why

`{count} {title}` — `63 Metadata column` — and nothing else.

That is deliberately made of only the two things the app is entitled to: a number it
computed, and a word the datatype's own package chose. The title is used verbatim
(pluralising it would be the app editing another package's word). A datatype the
registry has never heard of shows its raw id, which is at least true.

The old fallback led with `65 artifacts · 41.5 MB`. Both are gone from the line:
`artifact` is this app's storage vocabulary and means nothing to a scientist reading a
picker, and the size is not how anyone picks a dataset. The size moved to the row's
HOVER, which is not truncated — available to a reader who wants it, out of the way of
the reader who is choosing.

A dataset the read counted as ZERO reads `Nothing in this dataset yet`, for the same
reason: it states what the app actually established (it counted, and found nothing)
without naming a row in its own table.

Because the head-of-line total is gone, a dataset with more datatypes than `GROUP_CAP`
would under-report silently — the total used to cover that by accident. It is now
covered on purpose: when the shown groups do not account for `artifact_count`, the
line ends `+{n} more`.

## Decisions

### DEC-1: the summary is a SEPARATE batched read, not a field on the dataset list row

`DatasetListItem` is what the datasets LIBRARY renders, 500 rows at a time, and it has
no use for artifact groups. Folding the summary in makes every list caller pay for a
picker feature. It is one extra request that only the picker makes.

**Basis:** the same reasoning as the value preview's DEC-1 — a consequence of the
surface that needs it, not of every surface that lists the entity.

### DEC-2: the endpoint answers for every dataset the caller can SEE, not for an id list

`GET /api/datasets/artifact-summaries` takes no ids. The picker's candidate set is
exactly owner ∪ sharee, which is exactly this endpoint's ACL, so an id list would
duplicate the scope rule and force a POST (500 uuids is an 18 KB URL). It is capped at
`SUMMARY_DATASET_CAP` datasets, ordered like the list endpoints, so it aligns with the
`per_page: 500` page the picker already fetches. A candidate past the cap simply has
no summary, which the renderer already handles.

**Basis:** the ACL is the scope. Restating it as a client-supplied id list is a second
place to get it wrong.

### DEC-3: every COVERED dataset is in the response; absence means "not looked at"

A dataset holding nothing arrives with `artifact_count: 0` and `groups: []`, and a
dataset past `SUMMARY_DATASET_CAP` is absent. The first draft of this said the
opposite — empty datasets omitted, "absence means zero" — and it is wrong, because
absence would then carry TWO meanings. The picker fetches its own 500 owned and 500
shared candidates, so a user with 400 of each has 800 candidates over a 500-dataset
cap: 300 rows would have been absent, and the client would have printed a confident
"No artifacts yet" about datasets nobody counted.

The zero row costs ~90 bytes and buys an unambiguous absence. The client renders "No
artifacts yet" ONLY for a present-and-zero summary, and renders nothing at all for an
absent one.

### DEC-4: the preview carries only DECLARATIONS, never a server reading of the bytes

`output_id`, `datatype`, `size_bytes`, `meta`, `structure` — all producer- or
manifest-declared, all already columns. Nothing is parsed, sniffed or inferred.
artifact-model ITEM-7 dropped a `shape` column precisely because it was the host's own
reading of bytes it does not open; carrying the producer's OWN `structure` is the
opposite move — it is the declaration the producer already wrote, travelling unread.

**Why `structure` is carried at all (added with the phrase model).** It is the half a
preview usually needs. A producer states an array's dimensions in `structure`
(`shape`, an axis length), not in `meta`: the h5ad importer's expression entry has
`meta = {n_vars, nnz, source_dtype, x_state, count_source}` and **no row count
anywhere in it**. A summary built from `meta` alone can therefore describe only one
side of a matrix, which is exactly what the first version shipped — `32,738 genes`,
with the cell count, the fact a reader asks about FIRST, simply absent.

The alternative considered and rejected was inferring the missing extent from a
neighbouring `metadata-column` group's `meta.n`. That column's axis is nested inside
`structure` per column (so the scalar-only rule dropped it), a group of metadata
columns mixes both axes, and its representative is chosen by SIZE — so `n` could be
either dimension. A number that is right half the time is worse than a number that is
absent.

### DEC-5: both declarations are size-BOUNDED on the way out, and never interpreted

A producer declaration is unbounded third-party input. `compact_declaration` (one
function, applied identically to `meta` and to `structure` — they are the same kind of
thing, so two rules would only be two places to reason about) keeps scalar-valued keys
and SHORT ALL-SCALAR ARRAYS, at most `DECL_MAX_KEYS` of them (sorted, so the choice is
deterministic), with string values truncated to `DECL_MAX_VALUE_CHARS`.

That is a size rule. It reads no key by name and gives no key a meaning. One clause
earns its own sentence: an over-long array is **dropped whole, never truncated**. A
truncated dimension list is not a smaller declaration, it is a false one, and a
contribution indexing into it would print a number the producer never wrote.

Adding the second bag doubles the wire ceiling per group (~1 KB → ~2 KB) and nothing
more: arrays are capped at `DECL_MAX_ARRAY_ITEMS` entries of `DECL_MAX_ARRAY_ITEM_CHARS`
characters, so an array-valued key cannot cost more than a string-valued one.

### DEC-6: a not-ready dataset stays SELECTABLE, and says why

The alternative — disabling the option — was considered and rejected. Linking is a
reversible bookkeeping act (`project_datasets` is an M:N link; detach restores the
prior state and the dataset itself is untouched), a failed ingest can be re-run on the
dataset afterwards with the link already in place, and "link everything for this study
now, fix the broken import later" is a real workflow. What must not happen is a SILENT
dead end. So the option is marked in the list AND, once selected, the panel states the
consequence next to the Attach button — before the click, not after it.

`pending` / `running` are likewise selectable and marked: they become usable on their
own.

### DEC-7: only `role='artifact'`, `status='ready'`, non-hidden artifacts are counted

`intermediate` is the viz-only tier (DEC-8 of the artifact model), a non-`ready` row is
one the conformance gate has not passed or has condemned, and `hidden` is an alternate
representation deliberately kept out of listings. Counting any of them would answer a
different question than the one the user asked.

### DEC-8: the count is grouped by datatype, not a list of artifacts

A single `.h5ad` import emits one expression matrix and one metadata column PER obs
column — 65 artifacts is ordinary. A list of the first four is four near-identical
rows; the grouped count is the actual answer to "what is in there". At most
`GROUP_CAP` groups per dataset, most-numerous first.

The server's most-numerous-first order is what the client OVERRIDES with the declared
`order`, and it has to: the 63 metadata columns arrive before the single expression
matrix, so a line that followed the server would bury the headline fact behind an
inventory of columns.

### DEC-9: contributions are registered by the domain package — one per DATATYPE, not one per dataset

Registering `single-cell/expression → "{n_cells} × {n_genes}"` from app code would be
the exact INV-3 violation this seam exists to avoid, and `lint-no-domain-in-builtin`
fails on the nouns. The contribution belongs in the package that already owns the
datatype (`packages/single-cell-types`), alongside the manifest that declares it.

**Why a contribution speaks for ONE DATATYPE rather than for the whole dataset.** A
dataset summary is plainly a statement about the DATASET, so the alternative was one
dataset-level declaration owning the entire line, anchored on some datatype the
dataset holds. It was rejected: a dataset can hold datatypes contributed by SEVERAL
packages, and a dataset-level declaration then needs an anchor rule that picks one
winner and silently drops everything the other packages had to say — with the winner
decided by a tie-break the reader cannot see. Per-datatype phrases with a declared
position COMPOSE; a dataset-level declaration ARBITRATES. The dataset-level statement
is still produced — it is just assembled from every group that has something to say,
which is the thing that was actually wanted.

The cost is stated: a phrase can only draw on ONE group, so a fact spanning two
datatypes cannot be expressed today. Nothing shipped needs one — `cells × genes` are
both extents of a single `structure.shape`.

## What this does not do

- **No per-row fetch.** One request, one SQL statement, one window function. An N+1
  over a 500-row picker was the failure mode to design out, and the endpoint cannot
  express one.
- **No new persistence.** No column, no table, no migration. Everything read is
  already stored.
- **No opinion about which artifact matters.** The representative of a group is its
  LARGEST member (ties broken by id) — a size rule, not a semantic one. A contribution
  that wants a different one reads the group it is given.
