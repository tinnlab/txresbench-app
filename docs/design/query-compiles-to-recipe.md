# Query over Zarr: compile to a recipe, not to a plan

**Status:** DRAFT FOR DISCUSSION. Nothing here is decided. Open decisions are in §7.
**Date:** 2026-08-19. **Base:** `main` @ `96770d83`.
**INV-1 is deliberately PARKED** for this round (see §6) — the owner asked that it not
constrain the discussion yet. It returns as a real constraint before anything is built.

---

## 1. The question

Should we extract a "database engine" that works over Zarr — with a query language,
views, filters, and streaming results?

The motivating example, in the owner's words:

```sql
select expression from A
concat
select expression from B
where A.mask = 1 and B.mask = 1
```

Two datasets, a row-wise concatenation, a projected column, and a per-source predicate.

## 2. The observation that reframes it

The row-space half of that query is built. **The projection half is not, and that is the
crux of this document.**

| clause | today | status |
|---|---|---|
| `concat` | the alignment's row vector + `segments`, recording which source each range came from | **built** (VERIFIED: `workstore/alignment.rs`) |
| differing feature spaces between A and B | the entity-axis intersection the alignment already computes | **built** — A and B need not share genes |
| a query over a query | chain resolution, `gather_exec::plan_chain` | **built**, merged `96770d83` |
| `select <metadata column>` | a gathered column over metadata-columns | **built** |
| **`select expression`** (a MATRIX) | — | **NOT built. See below.** |
| `where` | the row vector already expresses any subset + reordering; only the PRODUCER cannot compute one from a predicate | **representation BUILT, producer parameter missing** |

### The three vectors already carry the selection — VERIFIED, 2026-08-19

**Owner recollection, checked and confirmed on both axes.** An earlier draft listed `where`
as "not built", which understated what exists. The alignment already carries the selection
for BOTH axes; what is missing is narrower than a format gap.

**Entity (feature) axis — built in stage 1.** `resolve_features(sources, key, mode=,
authority=, normalize=)` (`_helpers/alignment.py:590`) takes a **user-chosen key column**, a
conflict mode, an authority source and a normalisation, and emits role
`alignment_entity_index` — a **per-source column index for every unified entity**
(`alignment.rs:131`) — plus `alignment_entity_evidence` and the `unified_entities` extent.
That IS "align the var column through var-column-id matching". The entity vector is
**total** (every entity has an index in every source), so absence is unrepresentable and the
axis needs no sentinel: an entity outside the intersection is simply absent from
`unified_entities`. **One vector says both what to KEEP and where it LIVES in each source.**

**Row axis — also built.** `alignment_row_source` (index within the source) and
`alignment_row_segment` (which segment), over a segment table of
`dataset`/`start`/`end`/`order` (`alignment.rs:123-127`). An output row therefore maps to
`(dataset, row index in that dataset)` — so the row vector can express **any subset and any
reordering**. A filter is just a SHORTER ROW VECTOR.

**Consequence: the `where` gap is a producer PARAMETER, not a format change.** The
representation has been able to carry an arbitrary selection since stage 1; the producer
simply accepts no predicate with which to compute one. This is materially smaller than
"build filtering", and it is why §4's worked example needs no new artifact shape.

### The gather cannot represent a matrix — VERIFIED, 2026-08-19

An earlier draft of this document claimed `select expression` was already built. **That was
wrong.** The gather is scalar-column-shaped by construction:

- `column_selector` is a single scalar string (`gathered.rs:84-125`)
- `gathered_structure()` hardcodes `"kind":"table"` with a **one-element** `columns` and
  `"arrays": []` (`virtual_dataset.rs:336-378`)
- `gather_chunk_multi` copies **one fixed-width element per output row**
  (`gathered.rs:1084-1126`)
- a gathered artifact carries its sources' datatype, and the sources are **always
  metadata-column** (`virtual_dataset.rs:944-960, 987-991`)

**So a virtual dataset has no matrix to project.** "Integrate two datasets and read the
merged expression matrix through the gather" is not available today, and making it
available means **sparse/matrix gather** — which reopens the argument DEC-3 settled, and is
a substantially larger change than a predicate.

So the question is not "build an execution engine," but it is also not "add a `where`." It is:

> **What does a query compile to — and does the projection target ever include a matrix?**

Those are two decisions, and the second is much the more expensive (D9).

## 3. The proposal

**A query compiles to a RECIPE (an alignment artifact + a gathered structure), not to a
physical operator tree.**

A conventional engine parses SQL, plans it, and evaluates operators at read time. The
alternative — and the one that fits what is already here — is that the query is a
*declaration of a row space*, which is exactly what an alignment artifact is. "Execution"
is then the gather serve path that already exists.

```
SQL-ish text  ──parse──▶  recipe (alignment + gathered structure)  ──serve──▶  bytes
                             ↑ content-addressed artifact              ↑ existing path
```

What this buys, at no additional cost, because each already exists:

- **Views** — a saved recipe *is* a view. Already true today. But see **§4.2**: the
  result is a VIRTUAL DATASET, not a view, because it can own attached artifacts of its
  own. The view analogy pays until that point and misleads after it.
- **Composition** — a query over a query is a chain. Merged today.
- **Streaming** — the existing member route.
- **Reproducibility and cache identity** — the result is a content-addressed artifact, so
  the same query is the same artifact, and the filter is recorded in lineage rather than
  living in an ephemeral URL parameter.
- **No optimizer, no operator implementations, no memory management, no spill.** A parser
  that emits a recipe is a small fraction of an execution engine.

## 3.1 There is no compile step — the query document IS the recipe

**Owner decision, 2026-08-19:** the SQL in §1 was illustrative. The surface may be JSON
(*"mongodb like a json for all I care"*). That collapses the proposal further than §3
claims, and in a good direction.

A JSON query document is *already* structured, serialisable, diffable and
content-addressable — which is precisely what an alignment declaration is. So there is no
translation layer to build:

```
JSON query document  ──validate──▶  stored as the recipe  ──serve──▶  bytes
                                       ↑ same object                    ↑ existing path
```

Gone with the text syntax: the lexer, the grammar, the parser, the text type-checker, the
error-message surface, and the "no tooling and no documentation anyone has read" objection
to a bespoke language. **The largest cost argument against a query surface does not apply.**

What does NOT go away, because it is semantics rather than syntax:

- the **vocabulary** — which operations exist at all (D4)
- the **predicate language** — what a filter clause MEANS, in three runtimes (D5)
- **validation** against the datatype registry — a JSON document can still be nonsense
  (a column that does not exist, a range on a categorical), and refusing it clearly is
  still work, just much less of it

### The trap this introduces

Reaching for MongoDB's operators (`{mask: {$eq: 1}}`, `$gte`, `$in`) *feels* like choosing
syntax. It is not. It is choosing a **predicate dialect**, and it would be the **fourth**
in this repo (D5). The one place "the syntax does not matter" stops being true is the part
that has to mean the same thing in Python, TypeScript and Rust — where a `$` operator set
with its own null/coercion/type-promotion rules is exactly the drift that produced the
existing CRITICAL. **Borrow MongoDB's SHAPE if it helps; do not borrow its OPERATORS.**

## 3.2 There is no `where` — selection is a MASK and an ALIGNMENT, both stored

**Owner decision, 2026-08-19, and it is the load-bearing one:**

> *"We don't actually do `where`. When we select anything, there is going to be something
> like mask and alignment — mask for example for row and alignment is for column. We store
> those and use those to filter stuff. **We do not support filtering on the fly.**"*

This removes an entire axis of cost from every option above.

| | selection object | already exists as |
|---|---|---|
| **rows** | a **mask** | the row vector (`alignment_row_source` + `alignment_row_segment` over the segment table) — see §2 |
| **columns / features** | an **alignment** | `alignment_entity_index`, the per-source column index over `unified_entities` — see §2 |

**A query is therefore `(mask, alignment, column)` — three stored references, no expression
anywhere.** Nothing is evaluated at read time beyond applying an indirection the gather
already applies.

What this kills outright:

- **No predicate language on the query surface.** A mask is DATA, not an expression. The
  MongoDB-operator trap in §3.1 does not arise here at all — there is nothing to borrow
  operators *for*. (The predicate that COMPUTES a mask still exists upstream; D5 stands
  there, not here.)
- **No PREDICATE evaluation at read time.** *(Corrected — an earlier draft said "no live
  evaluation", which was my misreading and is wrong in an important way. See §3.3: the mask
  IS applied during the read and the result IS streamed. What is not supported is computing
  a predicate on the fly.)* The engine's one genuine advantage over compiling to a recipe was
  evaluating an ARBITRARY PREDICATE during the scan; that is what is not wanted. **The last
  argument for an engine is gone.**
- **Attached artifacts are safe by construction** (§4.2/H2). An embedding attached to a
  virtual dataset cannot be invalidated by a filter change, because filters do not change.

**This is the design the deleted `serve_core` had already reached** (§9): `mask=<artifact-id>`,
a content-addressed row-id set referenced BY ID, with `pred=` deliberately reserved and
refused because *"a predicate resolves to a mask artifact upstream, so it never rides the URL
inline."* That conclusion was correct and is now re-confirmed independently by the owner.

### The one question this opens — D12

Is the mask **baked into** the alignment's row vector at creation, or a **separate stored
artifact composed with it** at selection?

Both satisfy "stored, not on the fly", and the difference is reuse and identity:

- **Baked** — one artifact, simplest, and exactly what exists today. But a different row
  selection means recomputing the alignment, and the alignment is the EXPENSIVE half (feature
  matching), while a mask is cheap.
- **Composed** — one alignment serves many masks. Much better reuse. But a virtual dataset
  is then defined by a `(alignment, mask)` PAIR, and anything attached to it must pin BOTH,
  or §4.2/H1 returns in a new form: an embedding valid under mask M1 silently mis-reads
  under M2.

**Recommendation: composed, with the pair as the virtual dataset's identity** — the reuse is
real and the identity requirement is the same one #149 already has to satisfy. But this is a
genuine decision and it should be made explicitly.

## 3.3 The selection is materialised; the RESULT is streamed

**Correction, 2026-08-19.** An earlier draft read the owner's *"we do not support filtering
on the fly"* as "the filtered result is materialised as an artifact". **That does not
follow, and it is wrong.** The owner's own restatement:

> *"I said we use the mask to filter the data before return as streaming, didn't I?"*

Two different claims were collapsed:

| | supported? |
|---|---|
| evaluating a **predicate** at read time | **NO** — this is what "on the fly" rules out |
| applying a **stored mask** at read time and streaming the filtered result | **YES — this is the design** |

So the shape is: **the SELECTION is materialised (a stored mask, a stored alignment); the
RESULT is streamed.** Nothing forces a filtered view to become its own artifact.

This is the same shape the gather already has — a stored row vector applied while serving —
which is why a mask is not a new kind of object. And it means **D1's "interactive vs
materialised" was a false dichotomy**: the third option is the one in use.

**Precedent, already shipped and already written down:** `cell-filter` emits a per-cell
boolean **keep-mask metadata-column** (non-destructive, one immutable mask per run, named by
the run label), and its own header states the model verbatim — *"a filtered dataset is a
read-time `(matrix, mask)` view"* (`packages/cell-filter/compute/cell-filter.py:7-10`). The
matrix is never modified.

### The single-source case — D13 [SUPERSEDED, see §3.4's mask+alignment correction]

> **SUPERSEDED (2026-08-20):** the framing below ("a mask is a one-source alignment") was WITHDRAWN
> by §3.4's correction — mask and alignment are ORTHOGONAL, either nullable under the source-count
> rule (§11.9 ITEM-2). A single-dataset filter has a mask and NO alignment; it is not a one-source
> alignment. Kept for the record; do not lift this framing.


The owner's example: *"create a new virtual dataset from the source dataset with the new
mask and no alignment."* Verified at `0339847b`, this cannot be declared:

- `GatheredFrom.alignment_artifact_id` is a required `Uuid`, **not an `Option`**
  (`gathered.rs:86`) — every gathered recipe names an alignment
- the integrate producer refuses one dataset **by design**: *"an integration over one dataset
  is not an integration"* (`embedding-integrate/ui/embedding-integrate.yaml:35-36`,
  `multiple: true` + `min_items: 2`)

**Recommendation — do NOT add an alignment-less recipe form. A MASK IS A ONE-SOURCE
ALIGNMENT:** row vector = the kept row indices, one segment, entity index = identity over
that source's own features. Same artifact type, degenerate case. No optional field, no
second recipe shape to validate, and chains then compose filter→integrate and
integrate→filter for free.

Note the refusal of a single dataset is the **integrate ANALYSIS's** opinion, not the
alignment **FORMAT's**. **To verify before committing: does the server actually accept a
one-source alignment** (one segment, total entity vector, subset row vector), or does
something downstream assume ≥2? That is D13.

## 3.4 The mask is the virtual dataset's ROW VECTOR — hidden, owned, exactly one

**Owner decision, 2026-08-19:**

> *"Mask artifact is something special and should not be shown to user, they will get
> confused. Also mask belongs to the virtual dataset, not to the real dataset, and there can
> only [be] one mask, while metadata column can have multiple."*

This supersedes an earlier recommendation of mine (kept visible in D12) that the committed
keep-mask column should stay a user-facing column on the SOURCE and double as the mask
artifact. **That was over-complicated and is withdrawn.**

**My argument for keeping it visible was also weaker than I claimed.** I said the
before/after tuning plots need the mask in the source's coordinate space. But `cell-filter`'s
own manifest states the tuning mask is *client-side `$derived` and tuned live*
(`packages/cell-filter/manifest.yaml:4`) — the stored artifact is only what **Run commits**.
Tuning never reads a stored column, so the case for visibility rests only on POST-commit
inspection, which is much weaker.

### All three constraints already have mechanisms

| constraint | mechanism, already present |
|---|---|
| not shown to the user | the `hidden` flag on artifacts; the listing already filters it (`data_api.rs:67`) |
| belongs to the VIRTUAL dataset, not the source | `dataset_id = <the virtual dataset>` — exactly how the creator already binds gathered artifacts (`virtual_dataset.rs:982-984`) |
| **exactly one**, unlike metadata columns | a partial unique index on `(dataset_id) WHERE role = 'mask'` — the same pattern as the existing dedup indexes |

### CORRECTION (owner, 2026-08-20): mask and alignment ALWAYS travel together, either may be NULL

The collapse below ("the mask IS the row vector, so there is only one object") **is wrong**,
and it is wrong for a reason the owner had already stated: *"mask for example for row and
alignment is for column."* **Rows and columns are ORTHOGONAL axes.** I noticed that the
alignment's row vector also encodes row selection and concluded the mask was redundant — that
conflated the alignment artifact's INTERNAL STRUCTURE with the CONCEPTUAL PAIR.

> **Owner: "mask and alignment should always go together, one of them can be null."**

| case | mask | alignment | why |
|---|---|---|---|
| filter one dataset | ✓ | **null** | **no features to align** — one source, its own features, unchanged |
| integrate, keep all rows | **null** | ✓ | no rows to drop |
| filtered integration | ✓ | ✓ | both axes act |

This also **withdraws §3.3/D13's recommendation** ("a mask is a one-source alignment"): it
forced a column-mapping concept onto a case that has no column mapping. A single-dataset
filter has a mask and NO alignment.

**The nullability rule is CONDITIONAL ON SOURCE COUNT** (owner, 2026-08-20 — this is tighter
than the "at least one non-null" I first wrote, which was too weak):

> *"Alignment can only be null if the virtual dataset is created from a single dataset. If it
> is from multiple datasets, there must be some kind of alignment."*

- **`sources` ≥ 2 ⇒ `alignment_artifact_id` NOT NULL.** Multiple datasets always need a column
  correspondence; there is no meaningful concat without one.
- **`sources` == 1 ⇒ alignment null**, and the mask must then be non-null — a single-source
  virtual dataset with no mask is the IDENTITY, which is not a virtual dataset at all.

**Consequence for the recipe — a real change.** `GatheredFrom.alignment_artifact_id` is a
required `Uuid` today, **not** an `Option` (`gathered.rs:86`). It must become nullable, and a
mask reference must be added. The invariant is enforceable as a row-level CHECK, because
`sources` lives in the same JSONB as the recipe:

```sql
CHECK (
  jsonb_array_length(structure->'gathered_from'->'sources') <= 1
  OR structure->'gathered_from'->>'alignment_artifact_id' IS NOT NULL
)
```

Same discipline as the constraint #151 landed (`202608040008`): **guard the STATE, not the
syntax** — a row that violates the invariant cannot commit, so a future creator that forgets
cannot quietly produce one. It is also the same shape as the existing
`artifacts_bytes_or_recipe`, already the discriminant pattern in this schema.

**D17 — ANSWERED by the owner, 2026-08-20: NO. There is no column selection anywhere.**

> *"There is no reason to subset feature from a single dataset — if user want to export them
> then they can subset, but not when it is in the workbench. The same when creating a virtual
> dataset from multiple datasets: we do not allow user to align a subset only. We intersect all
> column names to get the common, and among those check their compatibility to create virtual
> columns. We do not allow user to limit what virtual columns to create."*

Subsetting is an **export** concern, not a workbench one. No column mask, on either the
single-source or the multi-source path.

### The alignment is a PURE FUNCTION of its inputs

Intersect all column names → check compatibility → create **every** compatible virtual column.
No user choice at any step. So `(sources, key column, conflict mode)` fully determines the
alignment. Consequences:

- **Same inputs ⇒ same alignment.** Content-addressable and dedupable by construction, with no
  configuration to diff or migrate.
- **No column picker** on the integration form, and none in the recipe. The set of virtual
  columns is a CONSEQUENCE, never a parameter.
- **The compatibility check is the interesting half.** Intersecting names is mechanical;
  deciding whether two same-named columns are compatible (dtype agreement, reconcilable
  categorical levels) is the real work. **Precedent already set:** incompatible columns are
  filtered out but **kept in the table with a reason** — not silently dropped, and not offered
  as if they would work. A user who cannot choose columns MUST be able to see why an expected
  one is absent.

### This largely dissolves D10

If every compatible column becomes a virtual column **eagerly**, then §4.1's "select M from V"
is just reading V's member. The `(dataset, column name) → artifact id` resolver flagged there as
the one missing piece is needed only for columns that were NOT materialised — and there are
none.

Eager creation is nearly free: a gathered artifact carries **no bytes** (`object_key IS NULL`,
`stored_bytes = 0` — §4.2, migration `202608040007`), so it is a catalog row holding a recipe.
Thirty common columns is thirty small rows, not thirty copies of data. The virtual dataset ends
up complete and self-describing rather than lazily filled in.

**D16 — when BOTH are present, which space does the mask index?** A mask is a list of POSITIONS
(or a boolean per row). "Which space" means: positions counted in WHAT ORDERING.

Worked: D1 has 1000 cells, D2 has 800, the virtual dataset has 1800 rows. A mask says *keep rows
0-99*. Which 100 cells?

The alignment stores its segment array **sorted by `dataset_id`**, while `segment_order` carries
the producer's **declared** order — and the two deliberately disagree (that is what makes INV-6
testable at all).

| reading | layout | the mask selects |
|---|---|---|
| **declared order** (say D2 first) | rows 0-799 = D2, 800-1799 = D1 | the first 100 cells of **D2** |
| **array order** | rows 0-999 = D1, 1000-1799 = D2 | the first 100 cells of **D1** |

Same count. Different cells. Nothing downstream can tell.

**This hazard is already named in the code.** `alignment.rs::segments_in_declared_order` is
documented as *"the one place ordering is decided"*, and warns: *"Iterating the arrays in storage
order, or sorting by any derived value (dataset id, first row index), permutes the picture while
every count agrees — hazard H2, whose whole signature is that no length assertion sees it."*

**And there is a second half.** `cell-filter` produces a mask over ONE dataset's cells (1000
booleans in D1's space); the virtual dataset's space is 1800. A mask authored BEFORE integration
must be **lifted** into unified space using the segment offsets — and the same declared-vs-array
trap applies to the lift.

So D16 is two questions, and both wrong answers return the right number of rows:
1. **Is a mask authored in a SOURCE's coordinates or the VIRTUAL DATASET's?**
2. **If the latter, under which ordering** — declared, or array?

### D16 RESOLVES if the mask is PER-SOURCE (owner, 2026-08-20: *"why can't we just have boolean?"*)

**Boolean vs index list does NOT affect ordering** — both are positional. `[true, true, false,
…]` means "the *i*-th row" exactly as `[0, 1, 5]` does, so a producer counting *i* in declared
order and a consumer counting it in array order mismatch identically. Representation is
orthogonal to the hazard.

**But making the boolean PER-SOURCE eliminates it.** D1 → `bool[1000]`, D2 → `bool[800]`. The
mask is then indexed in each source's OWN row order, which is unambiguous. The unified ordering
still exists (the virtual dataset needs one), but **the mask no longer depends on it** —
ordering ambiguity stays confined to the alignment, where it already lives and is already
defended by `segments_in_declared_order`, instead of getting a SECOND place to go wrong.

It also composes with **no lifting**. At read the gather already resolves each output row to
`(source, row-within-source)`, so applying the mask is: resolve the row, check that source's
boolean, keep or skip. No unified-space mask, no segment-offset arithmetic, no
declared-vs-array question — **question 2 above simply does not arise.**

And question 1 answers itself in the safe direction: **`cell-filter` already emits exactly this
shape** — a boolean over ONE dataset's cells. No conversion, and no producer change.

**The distinction that matters is not boolean-vs-index; it is SOURCE SPACE vs UNIFIED SPACE**,
and source space is strictly safer.

Costs, both small:
- A per-source mask cannot express "keep OUTPUT rows 5-10" — a positional slice of the
  concatenated result. Filtering here is semantic (*which cells*), never positional, so this is
  not a capability given up.
- Size is a wash: a packed boolean over 500k rows is ~62 KB; an index list of 25k kept rows at 4
  bytes is ~100 KB. Dense booleans win when much is kept, index lists when little is; neither is
  large beside the matrices.

**Recommendation: per-source boolean.** It removes a whole class of silent failure rather than
defending against it, and it is what the existing producer already writes.

Any test for this must first assert the fixture's two orderings genuinely DISAGREE
(`declared_order_disagrees_with_array_order` exists for exactly this reason), or it passes
against a consumer that ignores ordering entirely.

### What the collapse got right, and what it did not

The mechanisms in the table above stand — hidden, owned by the virtual dataset, exactly one
mask. What does not stand is the inference that this makes the mask and the alignment the same
object. Kept below for the record.

### The constraints collapse D12 — SUPERSEDED, see the correction above

If the mask is **internal**, **one per virtual dataset**, and **never displayed**, then it has
no reason to be a boolean over the source — that shape existed only for display. It can be
the **index vector** directly, and that is precisely what a row vector is.

> **The mask IS the virtual dataset's row vector**, stored as one hidden artifact the virtual
> dataset owns.

So there is no `(alignment, mask)` pair to compose, nothing extra for an attached artifact to
pin, and §4.2/H1 does not return in a new form. It also REINFORCES §3.3's D13: a
single-source filtered virtual dataset is exactly a **one-source alignment whose row vector
is the mask** — one artifact type, no alignment-less recipe shape.

### Two consequences to decide rather than discover

- **D14 — ANSWERED by the owner, 2026-08-20: NO MIGRATION.** *"Nothing happens to it — we
  don't have any release of the software yet, we will just create a new project for testing."*
  `cell-filter`'s committed output changes shape freely (today a VISIBLE keep-mask
  metadata-column on the SOURCE, `cell-filter.py:14`; under this model a HIDDEN mask on a NEW
  virtual dataset).
  **And the reason this is safe is stronger than "pre-release":** the old keep-mask columns were
  masks only BY CONVENTION — structurally they are ordinary metadata columns named after a run
  label, with nothing in the schema marking them as defining a filtered view. When the
  convention goes, they do not become invalid or half-migrated; they simply stop being special.
  There is no mixed population because there was never a distinct KIND.
  Residual, harmless: the live dev stack's existing project still holds some, and they will
  render as plain metadata columns.
- **D15 — ANSWERED by the owner, 2026-08-20: NO.** *"If user want to see what is removed, they
  always have the original dataset to compare with."* No retained dropped-cell view, and the
  mask stays fully hidden. The source dataset is immutable and always present, so the comparison
  is available without the filter feature carrying anything for it — and if a comparison
  affordance is ever wanted it is a GENERAL dataset-vs-dataset capability, not a filter-specific
  one. This keeps the filter surface small.

## 3.5 How a compute runs against a filtered/integrated virtual dataset

**Owner, 2026-08-19:** *"If the embedding works on a virtual dataset with mask, then we just
need to send the mask and alignment to the python code along with the original datasets."*

Correct — and it is **D9(a)**, reached independently by the `embedding-analysis` re-plan,
which added it as ITEM-0f ("consume the alignment"). Two derivations, one answer.

**It is TWO references, and either may be NULL** (owner, 2026-08-20 — an earlier draft here
wrongly collapsed them into one; see the correction in §3.4). The processor receives:

- **the mask** (nullable) — the row selection
- **the alignment** (nullable) — `segments` and `entity_index` (**not a row vector — per §3.6 it is the identity within each segment**) (the per-source
  feature mapping)
- **the original datasets**, mounted as they already are

Uniform across all three cases, because the PAIR is uniform: a pure filter sends
`(mask, null)`; an unfiltered integration sends `(null, alignment)`; a filtered integration
sends both. The processor branches on which are present rather than on a special artifact
shape.

The economics favour it: an alignment is index vectors — a few MB at 500k cells — while the
matrices are gigabytes and are already mounted. **Metadata goes into the sandbox, not data.**

**And this is why matrix gather (D9) is not needed.** The join happens in Python where
`scanpy`/`anndata` do it natively; the server never represents a merged matrix and DEC-3
stays settled.

### Two contract terms, both guarding SILENT failures

- **The processor MUST NOT re-derive the join.** The alignment is the authority: `entity_index`
  says which feature in each source, the row vector says which row. A processor that recomputes
  the intersection from the var columns will usually agree — and will silently disagree exactly
  when normalisation or ordering differs. This is not hypothetical: the chain fixture hit it,
  where `pd.Series(dtype="category")` re-sorted a vocabulary and produced the RIGHT COUNT with
  every label off by one position.
- **The processor MUST verify the per-source `key_sequence_digest`** before using the vectors —
  that is what they are for. Without it a source whose rows moved underneath yields right-count,
  wrong-rows, with no error raised.

**Status: designed, not built.** `embedding.reduce` takes no alignment input today.

## 3.6 The ROW vectors are redundant — rows are segments + mask; only GENES need an index

**Owner, 2026-08-20:** *"Why don't we just use the order they are stored in the file, using
integer starting from 0? Why use some kind of indexing for the concatenation axis?"*

**Verified.** `_helpers/alignment.py::_emit_segments` (:1028) builds them as:

```python
row_source.extend(range(n_rows))                 # 0,1,2,… per segment
row_segment.extend([declared_order] * n_rows)    # constant per segment
```

**Both are the IDENTITY within each segment**, fully derivable from the segment table:
`row_source[i] = i - segment.start_row`; `row_segment[i]` = the segment whose
`[start_row, end_row)` contains `i`. At 1.8M cells that is ~7 MB carrying **zero information**
beyond a handful of segment rows. Row `i` resolves by binary search over a few segments plus a
subtraction — arithmetic, not a lookup.

| axis | mechanism | why |
|---|---|---|
| **rows (cells)** | **segments + mask** | concatenation is REGULAR — offsets computable |
| **genes / entities** | **intersected list + per-source column lookup** (`entities`, `entity_index`) | IRREGULAR — gene G sits at a different column in each file |

The gene index survives because it IS the mechanism for *"read gene G from the two datasets
separately"*. A single cell's profile comes from ONE dataset, straight out of the segments.

### Two things that do NOT go away

- **The digest becomes MORE important.** `source_key_digests` exists because addressing is
  POSITIONAL into a source — a source whose row order moved returns the right COUNT and the
  WRONG CELLS. Segment-offset addressing is equally positional; dropping the vectors removes the
  only redundant copy that might have caught it.
- **Segment ORDERING still decides layout.** `_emit_segments` lays rows out in DECLARED order
  then re-sorts the array for serialisation, deliberately, so a consumer iterating the array
  instead of sorting on `declared_order` produces visibly wrong ranges.
  `alignment.rs::segments_in_declared_order` stays load-bearing.

### `source_index` — a third redundancy, and the riskiest of them

Each segment carries `dataset_id`, `declared_order` AND `source_index`, with
`source_index = declared_order` unconditionally (`alignment.py:1058`). They answer:
`declared_order` = **where this segment lands in the output**; `source_index` = **which entry of
`meta.sources[]` these rows come from** (`alignment.rs:179`); `dataset_id` = **which dataset, by
name**. Today all three coincide.

`source_index` is doubly redundant — numerically with `declared_order`, and semantically with
`dataset_id`, which answers "which source" **nominally rather than positionally**. Given this
project's own discipline (identity by id with a `content_hash` cross-check, never by position),
`dataset_id` is the safe field and `source_index` is the one that can silently address the wrong
dataset if the layout ever stops matching declaration order — exactly the failure its own comment
cites as the reason to keep it. **It is defensive against a hypothetical, in the riskier of the
two available spellings.**

**Masking makes the case STRONGER (2026-08-20):** the masked read reconstructs every output
position from `segments + mask + rank` arithmetic (INV-S23) and never consults a stored row vector;
the stored UNMASKED vectors do not even reflect the masked reality. So under this design the vectors
are not merely redundant, they are INERT. The digest (INV-S5), not the vector, guards positional
addressing, so dropping them loses no safety.

**D18 — drop the row vectors (and `source_index`), or keep them against a future reordering
layout?** They exist for a non-declaration-ordered layout that does not exist and, under this
design, never will: filtering lives in the mask, not the alignment. The DIGEST, not the vector,
is what guards positional addressing either way.

## 3.7 Corrections from the shape inventory (2026-08-20)

A full read-only inventory (`/data/pbya/cytoanalyst/tmp/data-shape-inventory.md`, 534 lines)
corrected several things asserted earlier in this document.

- **There are exactly TWO artifact `structure.kind` values: `table` and `sparse_csc`.** A list I
  offered of twelve literals was **four different vocabularies mashed together** — datatype-manifest
  `LayoutKind` (`chunked_dense`/`chunked_sparse`/`opaque_as_is`), a datatype id (`embedding`), a
  dead provenance `SelectionRecipe` vocabulary (`polygon`/`column`/`label_set`/`setop`/`freehand`
  — **no producer**), and command-palette targeting (`instance`). `bool` is not a member kind;
  nothing emits it. Real shapes: `zarr_v3/table`, `zarr_v3/sparse_csc`, `encoding:"opaque"`, and
  the synthetic gathered column. Member kinds are exactly `numeric`/`categorical`/`string`.
- **"No canonical enum" was half right and INVERTED.** The vocabulary is closed and enforced — in
  **three independent copies** (`artifactReader.ts:213`, `conformance.py:1509-1517`, and *nothing
  in Rust*). Rust stores `structure` as opaque JSONB and validates only that `encoding` is a
  non-empty string (`ingest.rs:301-323`); it never inspects `kind`. **The risk is drift between
  three closed copies with no shared definition**, not scatter.
- **`layout.kind` does not map 1:1 onto `structure.kind`** — `embedding` declares `chunked_dense`
  but emits `kind:"table"`. The manifest layout is a gating hint, not the read dispatch.
- **`embedding` is not a shape** — it is a `table` with one 2-D member, and that member lands in
  `structure["arrays"]`, not `columns`.
- **A fourth member bucket exists: `aux` + `extents`** (`cyto_zarr.py:1288-1300`) — members
  explicitly NOT on the table's axis. **A mask must never touch them.**
- **CSC axis resolved:** `axes=("cells","genes")` (`h5ad_import.py:376-378`) — rows are cells,
  columns are genes, `indptr` is `n_genes+1`. **Gene = contiguous slice; cell = scatter.**
- **The gather is not fixed-width-only** — `gather_split_strings` serves variable-width strings and
  `remap_codes` serves categoricals. Fixed-width is one of THREE paths.

### The four genuinely hard shapes

1. **`sparse_csc` under a CELL mask.** The mask filters the axis `indices` lives on, i.e. inside
   every column: rebuild `indptr`, **rank/prefix-sum remap every `indices` value**, compact `data`
   in lockstep. It cannot be a view over stored bytes because the stored values change. **A GENE
   mask would be nearly free — the cheap direction is the one nobody wants.**
2. **2-D embeddings.** Trivial mechanically (chunks are rows × full width, so kept rows stay
   contiguous runs), but the gathered structure hardcodes `shape:[n]` and `arrays:[]` and cannot
   NAME a 2-D member.
3. **`opaque`, especially `cell-set`.** Nothing to do — which is the danger: stored selections hold
   cell references whose meaning a mask silently changes, and an opaque artifact has no declared
   axis to reason about.
4. **AXIS ATTRIBUTION — not a shape, and the thing to design against FIRST.** Deciding "is this
   artifact cell-indexed?" rests on a producer-declared `axis` STRING plus an **optional**
   `aligned_to` digest. An artifact omitting `aligned_to` with a coincidentally-matching axis label
   is **indistinguishable** from a cell-indexed one, and Rust has no dispatch point to enforce it.
   Silent, plausible, wrong.

**The good news:** for everything the gather already serves, **a mask is just a SHORTER PLAN**.
`AlignmentVectors::resolve_row` already yields per-output-row `(source, row)` (`alignment.rs:629`),
`gather_chunk_multi` consumes exactly that, and `n`/chunk-grid/offsets all derive from
`plan.len()`. Categoricals come free — `levels` is code-indexed, so a mask cannot corrupt the
mapping.

## 4. Worked example

> **Caveat, per §2:** this compiles cleanly **only if `expression` is a scalar column**. If
> `expression` means the expression MATRIX — which is what the word means in this domain —
> the gathered half of this example is **not currently expressible**, and D9 governs.
> The alignment half below is accurate today either way.

The query in §1 compiles to:

```
alignment artifact
  sources:  [A, B]
  per-source predicate:  mask == 1
  row vector:  concat( A.rows where mask==1 , B.rows where mask==1 )
  segments:    [ A: 0..n_a' , B: n_a'..n ]
  level lookups: unified vocabulary per categorical column

gathered artifact  ("expression")
  structure.gathered_from:
     column_selector: "expression"
     alignment_artifact_id: <the above>
     sources: [{dataset_id: A, artifact_id: …}, {dataset_id: B, artifact_id: …}]
```

Both are artifacts the system already knows how to create, store, verify and serve. The
**only** new capability required is that the producer accept a predicate — today
`embedding-integrate` joins on keys but cannot filter.

That is a small, well-scoped processor feature. It is not an engine.

## 4.1 The clearer worked example: "select M from view V"

Owner's example, 2026-08-19: *select metadata column M from View V, where V is the
integration of D1 and D2, aligned on a var column matched by id.*

**This is NOT a chain**, and the distinction is the whole point. Two things look alike and
cost very differently:

- **(a) RE-PROJECTION through an existing alignment** — select M from V where V never
  materialised M. The alignment *is* the view: it defines the row space, and M is gathered
  through it straight from D1 and D2. **Depth-1.**
- **(b) A real CHAIN** — V's own output column becomes a source for a FURTHER integration
  (V ⨝ D3). **Depth-2**, needs `plan_chain` (merged `96770d83`) plus **#149**.

The owner's example is (a). It does not need chains at all.

**Creating V** — the alignment, which is the view definition:

```json
{
  "view": "V",
  "concat": [{ "dataset": "D1" }, { "dataset": "D2" }],
  "align": { "axis": "entity", "key": "gene_symbol", "mode": "intersect" }
}
```

Produces a `dataset-alignment` artifact: the row vector, `segments` (which source each row
range came from, plus `segment_order`), `sources[]` each with a `key_sequence_digest`,
`unified_entities`, and per-source level lookups for categoricals. The `key` is the
var-column id matching. **This exists** — `embedding.integrate` emits exactly this over a
user-chosen key with conflict mode and evidence recorded (`embedding_integrate.py:965-982`).

**Selecting M from V:**

```json
{ "from": "V", "select": "M" }
```

resolves to a gathered artifact (field names VERIFIED against `virtual_dataset.rs:336-378`,
`alignment.rs:123-144`):

```json
{
  "gathered_from": {
    "alignment_artifact_id": "<V's alignment>",
    "column_selector": "M",
    "sources": [
      { "dataset_id": "D1", "artifact_id": "<D1's M column>" },
      { "dataset_id": "D2", "artifact_id": "<D2's M column>" }
    ]
  }
}
```

The alignment supplies *which row comes from where*; `sources` supply the bytes.

### The one gap this exposes — D10

The mapping from query document to recipe is nearly mechanical, with **exactly one** piece
missing. The query says `"select": "M"`. The recipe needs **artifact ids** — which artifact
inside D1 holds column M. That resolution, `(dataset, column name) → artifact id`, is a
**catalog lookup, not a query engine**, and it is the only genuinely new machinery this
example requires. **D10: where does that resolver live, and what does it do when a named
column is absent from one source but present in the other?**

### What stands between the owner and running this query — none of it an engine

1. **Creating V is not reachable.** `embedding.integrate` is `launchable: false` —
   `completeRequiredPickers()` filters to `isSinglePicker`, and this form's first required
   control is a `multiple` picker. A shared-harness bug, not a design one (**Q22** in the
   embedding-analysis re-plan).
2. **Projecting M through V's alignment AFTER V exists has no path.** Columns are gathered
   at integration time. This is the genuine new capability, and it is small: the same recipe
   shape, resolved later.
3. **If M was materialised when V was built**, there is nothing to do — that is reading V's
   member, and it works today.

And §2's constraint still binds: this works because **M is a metadata column**. If M were
the expression matrix, the gather cannot represent it (D9), and no query syntax changes that.

## 4.2 It is a VIRTUAL DATASET, not a view — and that is not pedantry

**Owner correction, 2026-08-19:** *"saying View is not very accurate here… since we can
attach artifact to that virtual dataset."*

This is the point where the SQL-view analogy stops paying and starts misleading. **A view
cannot own data.** A virtual dataset can: create it from D1 and D2 with filtering, compute
an embedding *in its row space*, and **attach that embedding to it**. The embedding is not
derived from D1 and D2 — it is native to the virtual dataset.

So a virtual dataset has **two classes of member**:

| class | how it is stored | read path |
|---|---|---|
| **derived (gathered)** — a metadata column projected from the sources | no blob; `structure.gathered_from` recipe | goes **through** the alignment row mapping |
| **native (attached)** — an embedding or any artifact computed against this row space | its own bytes | served **directly**; the mapping must NOT be applied |
| **the MASK** — exactly one, hidden, owned by the virtual dataset (§3.4) | its own bytes (an index vector) | it IS the mapping; never served to the user at all |

### The mechanism already exists

Both facts are already true in the catalog, verified at `96770d83`:

- the creator writes gathered artifacts with `dataset_id: Some(dataset)`, `project_id: None`
  (`virtual_dataset.rs:982-984`) — **a virtual dataset already OWNS its members**, and
  `NewArtifact` requires exactly one of `project_id`/`dataset_id` (ITEM-23,
  `catalog/models.rs:30-32`), so attaching an embedding is just an insert with
  `dataset_id = <the virtual dataset>`
- **DEC-8 is already the discriminant**: `object_key IS NULL` ⇔ gathered ⇔
  `structure.gathered_from` present, enforced by the `artifacts_bytes_or_recipe` CHECK

**So the owner's read semantics fall out with no new mechanism.** A member with
`object_key IS NULL` routes to the gather path and gets the row mapping; a member with real
bytes routes to the normal byte serve and does not. "Everything queried through the virtual
dataset goes through the filtering, *except* the artifacts later attached to it" is a
restatement of the existing discriminant.

### Two hazards this exposes

**H1 — nothing binds an attached artifact to the row space it claims.** If an embedding is
attached with a row count that does not match the virtual dataset's, or was computed
against a different row space entirely, reads silently mismatch. This is the SAME class as
the identity gap in **#149** (the creator stamps no `key_sequence_digest`/`aligned_to`), and
it should be closed by the same mechanism rather than a second bespoke one.

**H2 — is the filter BAKED or LIVE?** This is the question the phrase "read real-time
filtering" leaves open, and the answer decides whether attached artifacts are safe at all.

- **Baked** — the predicate is applied when the alignment is produced, so the row vector
  *is* the filter and the gather applying it at read is "real-time filtering" in the only
  sense that matters. Attached artifacts are then permanently valid. **This is consistent
  with the standing decision that alignments are immutable**, and it is what exists today.
- **Live** — the predicate is evaluated per request and can change. Then an embedding
  computed under filter F1 **does not match** the row set under F2, and cannot simply
  "bypass the filter": its rows correspond to a row space that no longer exists. Every
  attached artifact would have to record the filter it was computed under, and a filter
  change would invalidate it (a narrowing could subset it; a widening or a change could
  not).

Recorded as **D11**. If the answer is "live", attaching artifacts and filtering are in
direct tension and the model needs a story for it. If "baked", there is nothing to build.

### Consequences to carry into the in-flight work

- **GC / cascade** — an attached artifact is dataset-scoped to the virtual dataset, so
  deleting the virtual dataset must cascade it, while never touching the sources.
- **Detach guard (#151)** — an attached embedding makes the guard *more* load-bearing, not
  less: detaching D1 does not destroy the embedding's bytes, but it destroys their
  **meaning**, because the rows no longer resolve. A refusal keyed only on "does this
  artifact have bytes" would miss it.

## 5. What this does NOT do

Stated plainly, because it is the deciding tradeoff.

**Every query materialises a row space as an artifact.** That is ideal for analysis —
reproducible, cacheable, citable, and the selection becomes provenance. It is wrong for a
**range slider being dragged**, where the expectation is sub-second response and no
artifact per frame.

A conventional engine's real value is evaluating a predicate *during* the scan and never
materialising the row set. Compiling to a recipe cannot do that and cannot be made to.

If a surface needs live exploratory filtering, it needs a different answer for that
surface — most plausibly **client-side evaluation over an already-fetched column**, not a
server engine. The two answers can coexist; they should not be conflated.

**#147 states its scope as "inline filtering by any metadata column, with ranges on
continuous columns."** That phrasing reads *interactive*. Resolving which it means is
decision D1 below, and it decides the architecture.

## 6. INV-1 (PARKED for this round)

Recorded so the discussion is not re-derived later.

Evaluating `mask = 1` means reading a column's bytes to test them, which is opening bytes
for meaning. Artifact-model's **INV-1** (VERIFIED verbatim, `.lifecycle/artifact-model/PLAN.md`):

> *"The server stores and serves. It does not interpret. It confines, caps, hashes, stores,
> records and serves bytes. It never opens a byte for meaning."*

ITEM-20 built a dependency guard (no format-parsing crate in the server's graph) as the
mechanical proof. DEC-23 later amended INV-1 narrowly, permitting decode in one module
(`workstore/gather_decode.rs`) enforced by a scope check.

**Correction to an earlier draft:** I implied DEC-23 had opened the door far enough to
revive server-side selection generally. It has not. **DEC-23 is a CODEC-scope amendment**
— three named codecs in one file — **not a LAYOUT-scope one.** It permits decoding a chunk
whose format is known; it does not authorise interpreting a sparse matrix's structure. So
it does not help the matrix case in §2/D9 at all, and citing it there would be wrong.

Two placements, independent of the invariant:

- **Producer evaluates the predicate** — a sandboxed processor emits the filtered
  alignment. Same shape as `embedding-integrate`. Keeps INV-1 intact. The filter lands in
  recorded lineage.
- **Server evaluates the predicate** — requires widening INV-1 a second time.

Even with INV-1 set aside, the *provenance* argument favours the producer: in a scientific
tool the filter should be part of what is recorded, not a URL parameter.

## 7. Open decisions — the point of this document

- **D1 — Interactive or reproducible?** Does filtering mean a dragged slider (live,
  ephemeral) or a recorded analysis input (materialised, replayable)? **This decides the
  architecture.** If both, which surface is which?
- **D2 — Who evaluates the predicate?** Producer or server. (INV-1 parked; the provenance
  consequence stands regardless.)
- **D3 — Is there text syntax at all? — ANSWERED by the owner, 2026-08-19: NO.** The SQL in
  §1 was illustrative, not a proposed surface: *"we can use the syntax of mongodb like a
  json for all I care."* This is a significant simplification — see §3.1. No parser, no
  grammar, no text type-checker, no error-message surface. **What remains open is not the
  syntax but the VOCABULARY** (D4) and the predicate semantics (D5).
- **D4 — The VOCABULARY. Substantially collapsed by D11's answer** (§3.2): with no `where`
  and no predicates, the vocabulary is *select a mask, select an alignment, project a
  column*. What remains is which of those are COMPOSABLE (may one alignment serve many
  masks?) — see D12 — not which operators exist. Original framing kept below for the record. With syntax settled (D3), what
  operations exist at all? The §1 example is *illustrative*, per the owner — so it does not
  pin this, and the capability list has to be stated rather than inferred from it.
  Candidates, cheapest first: row-wise `concat` across datasets (**built**); projection of
  metadata columns (**built**); a per-source predicate (**not built**, small); compound
  multi-column predicates (**not built**, needs a real expression surface — D5); joins
  beyond concat; aggregation; matrix projection (**D9, expensive**). **The list is the
  decision.** A fixed vocabulary covering ranges and equality is dramatically cheaper than
  a general expression language, and the honest question is which jobs actually require the
  latter.
- **D5 — LARGELY MOOT under D11, but do not relax it.** With selection expressed as stored
  masks and alignments, the QUERY surface needs no predicate dialect at all — a mask is
  DATA, not an expression. The risk moves upstream: whatever COMPUTES a mask still needs to
  express a predicate, and that is where the existing three implementations live. Original
  wording: DO NOT build a fourth filter DSL. One filter DSL already exists here in **three**
  implementations (`cell-filter.py`, `primitives.ts`, a 1,479-line Rust emitter) and drifted
  into a CRITICAL where "the value presented as the reproducibility guarantee was the hash
  of a fake script." If D4 needs expressions, converge the existing three (the expression-IR
  work) rather than authoring a new one.
- **D6 — ANSWERED by the owner, 2026-08-20: a VIRTUAL DATASET, not a column — and as many as
  wanted.** *"They can create as many virtual dataset as they want, it is not expensive anyway."*
  The arithmetic supports it. Per virtual dataset: one `datasets` row, one `project_datasets`
  link, one mask blob, and N gathered artifact rows — and **gathered artifacts carry NO BYTES**
  (`object_key IS NULL`, `stored_bytes = 0`; §4.2, migration `202608040007`). A packed boolean
  over 500k cells is ~62 KB. A hundred virtual datasets do not register beside one matrix.
  Two consequences, neither a reason to revisit:
  - **Listing is the real cost, not storage.** Ten filter runs put ten datasets in every picker.
    Arguably correct rather than clutter — if a filtered view IS a dataset, listing it is honest,
    and filters producing invisible things is the worse alternative.
  - **The resolution cache is where it shows up at runtime.** #150 bounded it at 256 MiB and a
    resolution is ~10 MB at 500k rows, so ~25 live resolutions fit. Working across many virtual
    datasets at once evicts, and evicted columns fall back to the cold-read cost. Degrades
    gracefully; but "many VDs, all being read" is the workload where cheap creation surfaces as
    latency.
  **Cheap creation raises deletion volume**, so the cascade must genuinely work: deleting a
  virtual dataset removes its gathered artifacts and its mask, and never touches the sources.
- **D7 — RESTATED. My framing was at the wrong LEVEL** (owner, 2026-08-20: *"artifact has
  datatype, not dataset"*). Verified: `datasets.datatype` is a nullable column with exactly ONE
  consumer — `provenance/export/bundle.rs:271`, which falls back to the literal `"dataset"` when
  NULL. No picker reads it; the creator writes NULL. **Datatype is an ARTIFACT property.**

  The real question is at the artifact: **gathered artifacts declare
  `structure.axis = "unified_rows"`** instead of `cells`/`genes` (`virtual_dataset.rs:336-380`),
  and that is why `resolveIntegrationGrid` refuses an integrated dataset as an input REGARDLESS
  of the picker (found by #152). **It is what blocks filter→integrate and integrate→integrate at
  the creator**, while the SERVE path for chains already landed (#144).

  **ANSWERED by the owner, 2026-08-20 — the hypothesis below is CONFIRMED:** *"If we combine
  cells with cells then axis becomes cells. We cannot combine cells with something completely
  different."*

  So a gathered artifact declares the **shared axis kind** (`cells`), and takes its distinctness
  from its own `content_hash` per INV-3. `unified_rows` goes.

  **And the second clause adds a constraint that was not previously stated: the sources must
  SHARE an axis kind, and that agreement is a PRECONDITION of integration.** Cells with cells is
  valid; cells with something completely different is not an integration at all and must be
  REFUSED, rather than papered over by inventing a new axis name. This matters more once virtual
  datasets are themselves inputs: today integration is offered only over expression datasets, so
  the shared axis is implicit — once anything can be an input, the check must be explicit.
  **To verify: does any such check exist today, or is it implicit in the picker's type filter?**

  **Hypothesis, now confirmed: `unified_rows` is a NAME doing an IDENTITY's job.**
  A virtual dataset's rows ARE cells — concatenating D1's cells with D2's cells yields cells,
  just a different SET. A new axis name asserts a new KIND of thing when what differs is the
  instance. The artifact model already separates these: **INV-3 — *"axis identity is
  `content_hash`, never a name; `AXIS_AMBIGUOUS` on collision"*.** If identity is the content
  hash, a gathered artifact should declare `axis: cells` (the kind) and take its distinct
  identity from its own hash. `unified_rows` invents a name to express what the identity
  mechanism already expresses — the same error shape as several other defects found this week.
- **D8 — Ordering.** The gather serve path re-decodes every source's whole column on every
  chunk request — amplification `ceil(n/4096)` (**#150**, in flight). **Narrower than an
  earlier draft claimed:** this is the **browser byte-serve** path (`data_api.rs:1230`). A
  sandboxed processor takes the other caller — `sandbox/inputs.rs:742` resolves **once per
  run**, then `materialize()` writes every member. So #150 bounds an interactive Visualize
  pane, **not** a compute. It gates D1's *interactive* branch and is close to irrelevant to
  the *materialised* one.
- **D11 — ANSWERED by the owner, 2026-08-19: BAKED.** *"We do not support filtering on the
  fly."* Selection is two STORED objects — a **mask** for rows and an **alignment** for
  columns — not a predicate evaluated per request. So attached artifacts are permanently
  valid, §4.2/H2's tension does not arise, and nothing needs building for it. See §3.2.
- **D17 — ANSWERED: NO.** No column selection anywhere; subsetting is an EXPORT concern. The
  alignment is a pure function of `(sources, key, conflict mode)` and creates every compatible
  common column. See §3.4 — this also largely dissolves D10.
- **D16 — LIKELY RESOLVED: make the mask a PER-SOURCE boolean** (§3.4). Boolean-vs-index is
  orthogonal to the hazard; SOURCE-space-vs-UNIFIED-space is what matters. A per-source mask is
  indexed in each source's own unambiguous order, needs no lifting, and is the shape
  `cell-filter` already emits. Confirm and close.
- **D14 — ANSWERED: no migration** (pre-release; a new project for testing). Safe because the
  old keep-mask columns were masks only by CONVENTION — structurally ordinary metadata columns —
  so there is no distinct kind to leave half-migrated. See §3.4.
- **D15 — ANSWERED: NO.** The original dataset is always there to compare against; no
  dropped-cell surface, and the mask stays hidden. Any future comparison is a general
  dataset-vs-dataset capability, not part of filtering. See §3.4.
- **D13 — Can a MASK be expressed as a ONE-SOURCE alignment?** See §3.3. If yes, the
  single-source filtered virtual dataset needs no new recipe shape at all. Verify the server
  accepts a one-source alignment before relying on it; the ≥2 refusal is the analysis's, not
  the format's.
- **D12 — ANSWERED by the owner, 2026-08-19: effectively BAKED — the mask IS the virtual
  dataset's row vector.** See §3.4. My earlier recommendation here ("composed, with the
  `(alignment, mask)` pair as the identity") is WITHDRAWN: it was built on the mask also
  being a user-visible column, which the owner has ruled out. With the mask hidden,
  one-per-virtual-dataset and owned by it, there is no second object to compose with.
- **D10 — LARGELY DISSOLVED by D17** (§3.4): with every compatible column materialised eagerly,
  "select M from V" reads a member and there is nothing to resolve. Retained only for a column
  that is genuinely absent from a source. Original framing: where does the
  `(dataset, column name) → artifact id` resolver live? See §4.1.
  The only genuinely new machinery the owner's worked example needs. A catalog lookup, not
  an engine. Sub-question: what happens when a named column is present in one source and
  absent from another — refuse the query, or emit a column with a declared absence?
- **D9 — Does the projection target ever include a MATRIX?** The expensive decision. Today
  the gather is scalar-column-shaped (§2) and a virtual dataset has no matrix. Options:
  **(a)** projection stays metadata-columns only, and any matrix-shaped work is done by a
  processor that consumes the alignment plus the N real matrices — no sparse gather, no
  DEC-3 reopening; **(b)** build sparse/matrix gather, which reopens DEC-3 and is a large
  change. The `embedding-analysis` re-plan independently landed on **(a)**: `embedding.reduce`
  takes the alignment artifact *and* the real matrices and applies the join itself, keeping
  the claim upstream and explicit while the bytes stay on the path that works. **(a) is the
  recommendation here too**, and it means the §1 query is answerable for metadata columns
  and deliberately NOT answerable for `expression`.

## 8. Evidence: why not an external engine

From the landscape survey (`/data/pbya/cytoanalyst/tmp/query-engine-landscape.md`, 448
lines, 2026-08-19). Survey-sourced unless marked.

- **DataFusion** — feasible, wrong shape. Zarr carries **no statistics**, so
  `PruningPredicate` has nothing to prune with. `arrow-zarr` (the only real Zarr
  `TableProvider`) does coordinate broadcasting → **1.5 × 10¹⁰ rows** for this matrix,
  `Inexact` on every filter, no projection pushdown, bus factor 1, unpublished. The recipe
  expressed as SQL is a sort plus two hash joins — three pipeline breakers, so no streaming.
  As a custom `ExecutionPlan`, `CREATE VIEW` buys nothing.
- **Lance** — disqualified on measured evidence *in this domain*. Upstream issue #4261
  reports sparse-matrix COO at **1.0× compression** vs Parquet's 3.1×, citing **62 GB against
  HDF5's 18 GB on single-cell genomics**. No N-D arrays, no sparse representation, and
  versioning that duplicates the content-addressed catalog.
- **TileDB-SOMA** — already measured *here* and removed: SOMA cost **73 s of an 85 s import
  (86%)**; the replacement is 9.5 s / 0.72 GB vs 14.8 s / 1.76 GB (`cyto_csc.py`).
- **Array-DBMS lineage** — SciDB is dead; Rasdaman is GPL with virtual coverages
  enterprise-only. Stonebraker & Pavlo (SIGMOD 2024) describe the hybrid as the normal
  outcome: *"most applications maintain both array and non-array data together."*

**Keep Zarr.** No external engine is a fit, and the storage layer is not what is missing.

## 9. Prior art in this repo — read before deciding

`feat/universal-tiledb-serving` was **not abandoned**. It ran a full lifecycle, closed with
all invariants upheld and TEST-1..26 PASS, and **merged to main 2026-07-27** (`e92a3ec8`).
It was then deliberately removed by `artifact-model` on 2026-07-29 (`2751dac5`), whose
commit message reads: *"`/data[/{*member}]` the only read surface; `/read` + `serve_core`
deleted (INV-1)"*.

It contained a query surface (VERIFIED by reading `serve_core.rs` at `2751dac5^`):

- `dim<N>=lo:hi` / `axis.<name>=lo:hi` — inclusive ranges over any dimension, addressed by
  position or by declared axis name
- `project=a,b` — field selection
- `at=<u64>` — time travel
- `mask=<artifact-id>` — a **content-addressed row-id set artifact**; served rows are the
  intersection with the dim projection. Implemented, not merely parsed (`serve_sparse` /
  `serve_dense` both apply it).
- `pred=<base64-JSON>` — **deliberately reserved and refused**, with the note: *"a predicate
  resolves to a mask artifact upstream, so it never rides the URL inline."*

**The mask was never judged on its merits.** It was collateral: the entire `/read` surface
was replaced by the single member route, and everything on it went too.

Two things follow. First, that design had already reached the conclusion §3 argues for —
predicates resolve upstream, the wire stays dumb. Second, **recover it from git rather than
re-deriving it**; it is a merged, tested implementation, not a sketch.

## 10. Recommendation (for discussion, not decided)

1. Answer **D9** first, then **D1**. D9 decides whether the motivating query in §1 is even
   in scope as written; D1 decides the architecture for whatever is.
2. Take **D9(a)** — projection stays metadata-columns; matrix work goes to a processor that
   consumes the alignment plus the real matrices. This avoids sparse gather and does not
   reopen DEC-3. The `embedding-analysis` re-plan reached the same conclusion independently,
   which is weak corroboration but corroboration.
3. Fix **#150** before the *interactive* branch of D1 — but note it does **not** gate a
   materialised/compute path (D8).
4. If reproducible/materialised: teach the producer a predicate, and compile queries to
   recipes. Small, well-scoped, consistent with the existing architecture.
5. If interactive: solve that surface separately, most likely client-side, and do not build
   a server engine for it.
6. Either way: **keep Zarr, keep artifacts, do not adopt an external engine, and do not
   author a fourth filter DSL.**

### What would make me wrong

If the answer to D9 is that users genuinely need to *read a merged expression matrix
through the platform* — not merely to compute over one inside a processor — then (a) is
insufficient, sparse gather is back on the table, and DEC-3 must be reopened deliberately
rather than worked around. That is a product question, not an engineering one, and it is
the single question in this document I cannot answer from the code.

---

### Provenance of claims

**VERIFIED by reading code/history at `96770d83`:** the alignment/segment decomposition in
§2; the scalar-column shape of the gather (§2, `gathered.rs:84-125`, `:1084-1126`,
`virtual_dataset.rs:336-378`, `:944-991`); the `serve_core.rs` grammar and mask
implementation in §9; the deletion commit message and artifact-model INV-1 in §6 and §9;
the creator inserting a NULL datatype (D7); the `model_coverage` base failures on
`dataset-alignment`.

**CORRECTED IN REVIEW — earlier drafts of this document asserted all three:**
(i) that `select expression` was already built — it is not, the gather has no matrix (§2);
(ii) that DEC-23 had opened INV-1 far enough to matter here — it is codec-scope, not
layout-scope (§6); (iii) that #150 gates every query feature — it gates the browser serve
path, not a compute (D8). All three were caught by the `embedding-analysis` re-plan
measuring rather than trusting. They are left visible rather than silently edited out,
because the pattern matters: **the claims that survived scrutiny here are the ones with a
`file:line` beside them, and the ones that failed are the ones I reasoned to.**

**SURVEY-SOURCED, not independently re-verified here:** every external-project claim in §8,
and the read-amplification measurement in D8 (reported by two independent agents;
`#150` is measuring it directly).

**INFERRED, flagged as such:** that #147's "inline filtering with ranges" implies an
interactive surface (§5) — this is a reading of the phrasing, and D1 exists to settle it.

---

# 11. Invariants — for the future lifecycle

**Status: this document is intended to become the `## Design source` of a feature lifecycle.**
Nothing here is implemented yet. The section below exists because the lifecycle requires
non-negotiables lifted **VERBATIM** into `PLAN.md`'s `## Invariants`, each pinned to an
executable `[acceptance]` test — and **a DECISION is not an INVARIANT.** D1-D18 record what was
chosen; the lines below are the promises a plan may not silently reframe.

This is the defence against the failure this repo has already paid for: a plan that reframes a
design into bespoke work while every structural gate reports green.

## 11.1 CORRECTNESS invariants

Each is stated so it can be lifted word-for-word, and each names the shape of the test that
would FAIL if it were violated.

- **INV-S1**: A mask NEVER touches an artifact that is not on the mask's axis.
  *Test:* an `aux`/`extents` member and a gene-indexed var column, served through a masked
  virtual dataset, are byte-identical to their unmasked bytes.
- **INV-S2**: A mask is PER-SOURCE and is indexed in that source's OWN row order.
  *Test:* a fixture whose two segments' declared order and array order DISAGREE returns the same
  cells whichever order a consumer iterates. (Assert the disagreement first, or the test passes
  against a consumer that ignores ordering.)
- **INV-S3**: The alignment is the AUTHORITY. No consumer re-derives the join.
  *Test:* a fixture where re-deriving the intersection from the var columns yields a DIFFERENT
  answer than the alignment's `entity_index` (differing normalisation or ordering) — the served
  result follows the alignment.
- **INV-S4**: Row layout is read from `declared_order`, NEVER from array order.
  *Test:* as INV-S2's fixture; a consumer that iterates the segment array produces visibly wrong
  ranges rather than a plausible permutation.
- **INV-S5**: Positional addressing is guarded by the per-source `key_sequence_digest`. A source
  whose row sequence changed underneath is REFUSED, never served.
  *Test:* mutate a source's key sequence without changing its row COUNT; the read refuses.
- **INV-S6**: Categorical levels are CODE-indexed, so row selection cannot corrupt the code↔level
  mapping.
  *Test:* a masked categorical column's labels equal the unmasked labels of the kept rows —
  with a vocabulary whose order differs from source order, so an off-by-one is visible.
- **INV-S7**: An ATTACHED artifact is served DIRECTLY; the row mapping is never applied to it.
  *Test:* an embedding attached to a virtual dataset returns its own rows unchanged; a mutation
  that routes it through the gather fails.
- **INV-S8**: Selection is STORED. No predicate is evaluated at read time.
  *Test:* the read path links no expression evaluator; the scope check that proves INV-1 also
  covers this.
- **INV-S9**: The alignment is a PURE FUNCTION of `(sources, key, conflict mode)`. The user
  selects no columns.
  *Test:* the same inputs twice produce the same alignment content hash; no code path accepts a
  column subset.
- **INV-S10**: An artifact's cell-indexed-ness is DECIDABLE, not inferred from a label.
  *Test:* an artifact carrying the label `cells` but no `aligned_to` digest is REFUSED as a mask
  target rather than treated as cell-indexed. **See §3.7 — this is the weakest link today and
  the one to design against first.**

## 11.1b The UNIFIED read model — a real dataset is the identity case

**Owner, 2026-08-20:** *"We do not materialize the mask of all 1, but in principle it is the
same, so we can treat real dataset and virtual dataset the same way, using the same code path to
read all data with mask or no mask."*

Adopted. Every dataset — real or virtual — is `(sources, mask, alignment)`:

| | sources | mask | alignment |
|---|---|---|---|
| a real dataset | one | **identity** | none |
| a filtered dataset | one | a per-source boolean | none |
| an integration | N | identity | required |
| a filtered integration | N | a per-source boolean | required |

**An all-ones mask is NEVER materialised.** Absent IS the encoding of identity — *n* bits
asserting "keep everything" is the same redundancy §3.6 found in the row vectors: derivable,
large, and a second thing to keep consistent. This is the `KeyIdentity::Unpinned` shape — the
model names the trivial case explicitly instead of expressing it by omission.

### Why this is a CORRECTNESS win, not only a tidiness one

Today the distinction is a **FORK** — a branch on `object_key IS NULL` with two mechanisms behind
it (`data_api.rs`: *"a gathered artifact forks HERE — this is the one place the branch belongs
(INV-3)"*). A fork means every invariant must be verified on BOTH branches independently, and an
invariant that holds on one while silently failing on the other is exactly what ships.

Under the unified model it is a **SPECIALISATION**: one entry point, one set of semantics, the
trivial case returning early. Invariants are stated ONCE and the fast path is an optimisation
**proved equivalent** rather than a second implementation to re-verify.

- **INV-S11**: The identity fast path is BYTE-EQUIVALENT to the general path.
  *Test:* serve the same column twice — once through the stored passthrough, once through the
  resolver with an identity mask — and assert the bytes are identical. **This single assertion is
  what makes keeping the fast path safe.** Without it the fast path is a second implementation
  wearing the word "optimisation".

### What stays different, invisibly

The fast path preserves three properties the general path cannot: the server never decodes
(INV-1 intact for ordinary reads), constant memory (a 134 MB shard costs one 64 KiB buffer via
`get_stream` + `Body::from_stream`), and native object-store Range rather than Range over
already-materialised bytes. **Routing ordinary reads through the resolver would invert INV-1** —
"the server never opens a byte for meaning" would become "the server always does", surviving in
wording and dying in substance. The unification is therefore in the MODEL and the ENTRY POINT,
never in the byte path.

Consequence: §3.7's four-shape read/stream table applies to REAL datasets unchanged — a real
dataset is the case where the mask is identity and there is no alignment, so there is no second
set of rules for "plain" datasets.

## 11.1c Addressing — request by ROWS, respond by CHUNKS

**Owner, 2026-08-20:** *"Why do we let client request chunk? … For value preview we can just add
something like limit in the reading."*

**The premise "there is no use case for a partial read" is FALSE** — verified: `valuePreview`
exists precisely to read a column's first few values (*"the whole reason this entry point exists
rather than a `.slice()`"*), `readComplex(array, lo, hi)` takes a range, `typedRead` has a slice
accessor reusing one handle, and the tests exercise byte-Range and suffix requests. Virtualized
tables are the second case. Fetching a 500k-row column to show three values is pathological.

**But the instinct behind the question is right: the CLIENT should not be doing chunk
arithmetic.** Today it is a Zarr reader — it fetches `zarr.json`, learns the grid, composes
`c/5`. Under a mask that breaks down: the OUTPUT grid only exists after the mask is applied, so
either the server publishes a derived grid or the client computes against a mapping it cannot
see.

**Resolution: `offset` + `limit` (preview is `offset = 0`), answered CHUNK-ALIGNED.**

The alignment is what preserves INV-1. A row-EXACT response ("values for rows 0-4") forces the
server to decode a chunk to extract five elements — the server opening bytes for meaning on an
ORDINARY read. A chunk-ALIGNED response ("rows 0-4 live in chunk 0; here it is") keeps the server
a byte passthrough and leaves decode with the client.

| | request | server work | who decodes |
|---|---|---|---|
| **stored** | `offset`+`limit` | map rows → covering chunks, stream them | **client** |
| **masked** | `offset`+`limit` | prefix-sum walk, assemble the output chunk | **server** (the DEC-23 exception it already uses) |

Identical from the client's side (INV-3), unifying the REQUEST model as §11.1b unifies the READ
model, while leaving the byte path different exactly where it must be. Over-fetch is bounded: at
most one extra chunk at each end. Preview with `limit=5` costs ONE chunk (~16 KB at 4096 float32)
against a whole column today.

- **INV-S12**: A row-addressed read of a STORED artifact never decodes server-side. The response
  is chunk-aligned bytes.
  *Test:* the stored read path links no decoder — the same scope check that proves INV-1 covers
  it; and a row-addressed response's byte length is a whole number of chunks.

### Two open questions

- **D19a — does `/data/` remain a raw Zarr store alongside the row-addressed API?** Codec-free
  byte-Range serving is an explicit property today and is what lets off-the-shelf Zarr readers work
  against it. Keeping both means two request surfaces to keep honest.
- **D19b — how does the response declare WHICH chunks it returned?** It must, or the client cannot
  locate its requested rows inside the bytes. A header or envelope; getting it wrong is a silent
  off-by-chunk.

## 11.1d Categorical reads — the remap is the cost of INTEGRATION, not of masking

A categorical column stores `uint8`/`uint16` CODES plus a declared `levels` array on the
member's `zarr.json`; code width is `len(levels)`, never observed codes (DEC-6). Two axes act,
independently:

- **Rows** — the mask, exactly as for numeric. Select kept rows, concatenate in declared order.
- **Codes** — each kept row's code is translated through the source's level lookup into the
  unified vocabulary (`remap_codes`, `gathered.rs:1020`): `lookup[c]` = "what does THIS source's
  code `c` become in the merged vocabulary?" Gather kept codes first, remap the survivors only.

**The remap is the cost of INTEGRATION, not of masking:**

| | mask applied | codes remapped? |
|---|---|---|
| filtered single dataset (no alignment) | yes | **NO** — no vocabulary to unify; codes pass through |
| integration (alignment present) | maybe | **YES** — each source's codes → unified vocabulary, mask or no mask |

So for a filter, a categorical behaves exactly like a numeric — pure row selection. "Categoricals
come free" (§3.7) is only half right: the MASK is free; the INTEGRATION costs one `remap_codes`
pass per element regardless of the mask.

- **INV-S16**: A categorical read is NOT two requests. Levels ride on the member's `zarr.json`
  (`attributes.cyto.levels`), which every column read fetches anyway for dtype/shape/chunks — the
  same metadata+data count as a numeric column (D10: *"ONE artifact, not a codes artifact and a
  levels artifact"*). The obligation this puts on the integrated path: the OUTPUT column's
  `zarr.json` must carry the UNIFIED vocabulary, not any source's — else the single metadata fetch
  returns levels that do not match the remapped codes (§11.1d), which is right-codes-wrong-labels
  with no error.
  *Test:* a masked integrated categorical is rendered from ONE metadata fetch + its chunks; the
  `levels` on the output `zarr.json` equal the unified vocabulary the codes were remapped into.
### Worked example — OVERLAPPING vocabularies `(A,B,C)` and `(B,C,D,E)`

The union deduplicates by level VALUE, not by code position — which is what makes overlap work
(`resolve_levels`, `_helpers/alignment.py:680`).

```
source 0: (A,B,C)        source 1: (B,C,D,E)
unified = first-seen(A,B,C,B,C,D,E) = [A,B,C,D,E]     index = {A:0,B:1,C:2,D:3,E:4}
source 0 lookup: 0→0, 1→1, 2→2         = [0,1,2]
source 1 lookup: 0→1, 1→2, 2→3, 3→4    = [1,2,3,4]
```

Source 0's code `1` and source 1's code `0` are DIFFERENT stored codes but the SAME level `B`,
and both map to unified `1`. At read, `remap_codes` runs each source's codes through its OWN
lookup, so `B` from either source converges on unified `1`. Overlap resolves by value.

- The two sources need NOT agree on order: `(A,B,C)` and `(C,B,A)` both union to `[A,B,C]`, every
  code still maps by value — **safe only because a fused categorical asserts no order (INV-15)**.
- **authority mode DROPS, not unions**: authority = source 0 ⇒ unified `(A,B,C)`, and `D`/`E` map
  to −1, so a source-1 cell holding `D` REFUSES (`GATHER_LEVEL_ABSENT`) rather than rendering as a
  wrong label — INV-S15.
- width is from the unified count (5 → `uint8`); union past 256 widens the output to `uint16` even
  from two `uint8` sources — INV-S14.

- **INV-S13**: The `levels` table is code-indexed and travels once on the output column. A mask
  never touches it. A masked categorical may declare a level surviving in zero rows — correct,
  because width is from the DECLARED set.
  *Test:* a masked categorical's `levels` equals the unified vocabulary; dropping every row of one
  level does not change the declared `levels`.
- **INV-S14**: Code width may differ PER SOURCE (uint8 source into a uint16 unified vocab); each
  read uses its own `src_item` → the unified `dst_item`.
  *Test:* an integration of a uint8 source and a uint16 source serves a single uniform-width column
  with both remapped correctly.
- **INV-S15**: The two categorical refusals survive masking, in order. `GATHER_LEVEL_CODE_UNMAPPED`
  (a code past the lookup — the source moved under the alignment) and `GATHER_LEVEL_ABSENT` (a code
  mapping to −1 — not in the unified vocabulary) both REFUSE rather than write. ABSENT is tested
  BEFORE the width check, because `-1 as u64` reads as "too wide" — one message for two different
  bugs (`gathered.rs:1049-1075`).
  *Test:* a masked read whose surviving rows include an unmapped code refuses; one including an
  ABSENT (−1) code refuses with the ABSENT message, not a width message.

## 11.1e Reading a virtual dataset — request-identical to a real one, work on the METADATA fetch

**From the client, reading a virtual dataset is byte-for-byte the same request shape as a real
dataset — that IS the design (INV-3).** Per column: one metadata (`zarr.json`) + chunks; levels
ride on the metadata for categorical, same as real. The client cannot tell a gathered column from
a stored one.

**The entire difference is server-side, and it lands on the METADATA request:**

- a STORED column's `zarr.json` is byte-served;
- a GATHERED column's `zarr.json` is COMPUTED by `resolve_shared` (the #150 cache). It MUST be:
  the shape is the post-mask kept count, and the unified levels live on the alignment's group
  attributes, so the declaration cannot be completed from the column's own `structure`. The code
  confirms it (`data_api.rs:1213-1240`): *"Serving the cheap version would hand the client a column
  of integers with no vocabulary — numbers where labels belong."*

So the **first touch of a virtual-dataset column — its `zarr.json` — is where the mask/alignment
resolution happens**; subsequent chunk reads hit the warm cache. Same request count; the work is
on the metadata fetch and cached after it. **This is what makes INV-S16 achievable rather than
aspirational** — the unified vocabulary is on the resolved metadata by construction, not stamped
by a second step that could drift.

A virtual dataset is also a MIX of member kinds, both identical to the client:

| member | metadata | data |
|---|---|---|
| gathered column (derived) | **resolved** `zarr.json` | assembled chunks (server decodes — DEC-23) |
| attached artifact (embedding) | byte-served `zarr.json` | byte-served chunks (INV-S7 — mask never applied) |

- **INV-S17**: A gathered column's `zarr.json` is RESOLVED, not structure-only. Its shape is the
  post-mask kept count and its `levels` are the unified vocabulary, both from the same resolution
  that produces its chunks.
  *Test:* a gathered categorical's `zarr.json` shape equals the kept-row count and its `levels`
  equal the unified vocabulary; a mutation serving the structure-only `zarr.json` (source shape,
  source levels) is caught.

## 11.1f String columns — the one SPLIT shape; two members, offsets rebuilt, values unbounded

A string column is not one array. It is a GROUP with two members (Arrow variable-length):
`offsets` (`uint32`, `n+1` cumulative byte positions) and `values` (`uint8` bytes). Row `r` is
`values[offsets[r]:offsets[r+1]]` (`cyto_zarr.py:43-47`; `gather_split_strings`,
`gathered.rs:934`).

**String is the one dtype that is genuinely more than one data member.** A categorical folds its
levels onto the metadata the client already fetches (§11.1e/INV-S16), staying single-member; a
string CANNOT — variable-length needs a separate offsets array by construction. Reading it is
group metadata + `offsets`(meta+chunks) + `values`(meta+chunks). Not a masking cost — inherent.

**Masking rebuilds the offsets, it does not select them.** Dropping a row shifts every subsequent
offset, because offsets are positions into the compacted `values` buffer. `gather_split_strings`
rebuilds from 0, accumulating only kept spans. Like the categorical remap, the rebuild is the cost
of GATHERING (an unmasked gather rebuilds them too), not of masking.

- **INV-S18**: A string column is served as its two members with the offsets REBUILT to index the
  compacted values, never byte-copied from the source. A masked/gathered string's `offsets[0]==0`
  and `offsets[i+1]-offsets[i]` equals kept row `i`'s byte length.
  *Test:* a masked string column round-trips to the exact kept strings; a mutation that byte-copies
  source offsets yields wrong slices.
- **INV-E6**: For strings, INV-E1's density bound holds ONLY for the fixed-width `offsets` member.
  The `values` member's amplification is bounded by the LENGTH DISTRIBUTION of kept vs dropped
  rows, NOT by density — stating a single density bound for a string column is wrong.
  *Test:* two masks keeping the same COUNT but different length rows read measurably different
  `values` bytes.
- **INV-S19**: A row-addressed read (§11.1c) of a string column is two-level — `offsets` locates
  the `values` span for rows `[lo,hi)` before the span is read. There is no direct byte offset into
  `values` from a row index.

**Loose end (→ #156):** `gather_split_strings` works, but a stale error elsewhere in `gathered.rs`
still says split-string gather "is not implemented" — clear it with #156 so it does not misdirect
an implementer.

## 11.1g Sparse expression under a mask — viz coloring is the CHEAP direction

### Terminology fix (owner, 2026-08-20): the index is a ROW POSITION, not a "cell id"

Earlier drafts of this section said "cell id". **That is wrong — the CSC `indices` are ROW
POSITIONS** (`cyto_csc.py:76`: *"row ids, ascending within a column"* = positions `0..n-1`), and
everything below should read "row position". The barcode is a SEPARATE sequence — the `row_keys`
(`alignment.py:110`: *"the cell barcodes, not the join key"*) — whose ONLY job is to be digested
(`key_sequence_digest`, INV-S5). **A barcode never indexes the matrix.**

This is the design, and it is deliberate: **position-indexing gives identity's SAFETY without
identity's per-entry COST.** Each of millions of nonzeros is a `uint32` position, not a string
key; the barcode sequence is hashed ONCE into a digest, and that digest is what guarantees
"position `p` is still the same cell" — i.e. catches a reordered source, the one failure
positional addressing is exposed to. Barcode-indexing would make every nonzero carry a string —
huge and slow to scatter — to buy safety the digest already provides. The reframe (source position
→ output position via segment offset + mask rank) is therefore purely positional; barcodes only
ever VERIFY, never index.



Expression is CSC — compressed by column, column axis = genes (`axes=("cells","genes")`,
`h5ad_import.py:376`). One gene is a contiguous run: read `indptr[G..G+2]` → `(lo,hi)`, slice
`indices[lo:hi]` (row positions, ascending) and `data[lo:hi]` (values). We return the SPARSE column —
raw member slices — and the client densifies against the row-space length (`readSparseColumn` /
`readOneEntryColumn` window the `indptr` by the gene's position; `columnValues.ts:72`). The server
never scatters a dense vector (wasteful + INV-1).

### CORRECTION (2026-08-20) — checked the ACTUAL viz core (`src-app/libs/viz`)

An earlier draft here described a CPU "merge-walk against position chunks". **That machinery is
invented — the real viz core does not use it.** The verified contract:

- The viz core's value-column input IS a `SparseColumn { row: Uint32Array, value: Float32Array,
  length }` (`viz/src/viz-core/data/wire.ts:30`) — the `[cellid, value]` form plus N, NOT a dense
  array.
- The wire form is **sparse CSC bytes streamed** as `AsyncIterable<Uint8Array>`
  (`streamingSource.ts`, channel `{kind:'value', key}` — *"a value column (sparse CSC on the
  wire)"*). Only the nonzeros travel; the zero cells never do.
- Densify is a **GPU scatter**, not a CPU fill (`densifyGpu.ts`): *"one GL_POINT per sparse entry at
  the center of its dense index's texel"*, rendered into a zero-initialised texture[N].
- **`row-reframe` is a stage the viz ALREADY owns** (`streamingSource.ts`: *"the viz owns decode +
  row-reframe + progressive emit + cancellation"*): the wire carries SOURCE cell ids, the viz maps
  them to canonical point positions `0..N-1` before scattering. For a real dataset that map is
  identity. **A mask/alignment plugs in HERE — it is not a new mechanism, it is an existing stage
  whose mapping changes.**

Pipeline: `server streams sparse CSC → viz decode → viz row-reframe (cell id → point position) →
viz GPU densify (one point/nonzero into zero-init texture) → scatter layer colors from it`.

**Precise streaming semantics (verified `streamDecode.ts:96`, `progressiveDomain.ts:44`):** the
WIRE is a genuine byte stream — `decodeSparseColumnStream` consumes `AsyncIterable<Uint8Array>`
chunk by chunk, parsing a 4-byte header (`n` = nnz) then filling `row`/`value` incrementally, never
collecting the whole blob first. But the RESULT is one complete `SparseColumn` (`Promise`), resolved
when the stream ENDS — there is no partial-column emit, and the GPU densify runs ONCE on the finished
column. Only POSITIONS stream progressively; the value/color column is whole-collect. So a gene's
color appears when its (small, few-thousand-nnz) column has fully arrived, not point-by-point — which
is why the value channel being sparse-and-small is what makes this acceptable.

### Coloring by a gene needs one value per plotted point

The plot shows the kept cells in output order `0..n_kept`. Coloring by gene G means densifying G
against `n_kept` — exactly what a real dataset does against `n_cells` (INV-3). So the masked gene
read returns sparse pairs **already in OUTPUT coordinates**:

```
source: 5 cells, gene 1 nonzero in cells 0,2,4 = 5,3,8;  mask keeps {0,2,3}
mask         = [1,0,1,1,0]
rank (excl.) = [0,1,1,2,3]      n_kept = 3     (source cell → output position)
gene 1 pairs (0,5)(2,3)(4,8):  cell0→(0,5)  cell2→(1,3)  cell4 DROPPED
return [(0,5),(1,3)], n_kept=3  →  client densifies → [5,3,0]
```

Per nonzero: `if mask[cell]: emit (rank[cell], value)`. `rank` is the exclusive prefix-sum of the
mask — `n_cells` entries, built ONCE per `(dataset,mask)`, cached, reused across every gene.

### This narrows D9: the serve path only does the CHEAP direction

Coloring by a gene costs `O(nnz in G)` — a few thousand — NOT `O(n_cells)`. The inventory's scary
case (rebuild `indptr`, remap every `indices`, compact `data`) is WHOLE-MATRIX materialisation, and
**viz coloring never wants the whole matrix — it wants one gene, and a gene is sparse.**

| operation | who | cost |
|---|---|---|
| color by gene G (viz) | **serve path** | O(nnz in G) — one gene, cheap even masked |
| filtered matrix for a compute | **Python processor** (§3.5) | whole-matrix, NEVER on the serve path |

**The server never materialises a filtered sparse matrix.** It serves genes one at a time for viz;
whole-filtered-matrix work is a compute, handed the mask+alignment+matrices per §3.5.

### The one remaining choice — WHERE the per-gene filter+renumber runs

- **Server-side (RECOMMENDED)** — consistent with dense (already server-resolved, §11.1e); the
  client reads gene G identically to a real dataset (INV-3). Cost: the DEC-23 gather-decode scope
  extends to CSC slices — the server reads `indices` to filter/renumber, bounded to one gene in the
  one module.
- **Client-side** — server byte-passes the raw gene slice + the rank vector, client filters. Keeps
  INV-1 pure but ships the rank vector to the browser and makes the client treat virtual sparse
  unlike real sparse, breaking the INV-3 symmetry every other shape has.

- **INV-S20**: The wire form of a value column is the SPARSE column (nonzeros only). Under a mask,
  the mask/alignment is applied in the viz's existing ROW-REFRAME stage (source cell id → canonical
  point position), so a kept cell scatters to its output position and a dropped cell reframes to
  "absent" and is not scattered. The GPU densify then fills a zero-init texture of length `n_kept`.
  *Test:* a masked gene's densified texture equals the source gene's values at kept cells' output
  positions, zeros elsewhere, length `n_kept`; NO dense array is streamed on the wire (only
  nonzeros). The masking is applied SERVER-SIDE (§11.1i) so the wire and client are identical to a real
  dataset and the viz reframe is IDENTITY in both cases; client-side masking is rejected (breaks
  INV-3, ships the rank, fights the header-declares-n decoder).
- **INV-S21**: The serve path NEVER materialises a filtered sparse matrix. It serves at most one
  gene per request; whole-filtered-matrix work goes to a processor (§3.5). *Test:* a serve-path
  sparse read's byte volume is `O(nnz in the requested gene)`, not `O(nnz total)`.
- **INV-E7**: The mask `rank` (exclusive prefix-sum) is computed once per `(dataset,mask)` and
  cached, reused across genes. *Test:* N gene reads on one masked dataset build the rank once.

**This is the D9 resolution for the SERVE path.** Sparse is tractable because the serve path is
always per-gene, and per-gene is cheap. **The server-vs-client placement above was SETTLED
server-side in §11.1i** (the wire and client stay identical to a real dataset, INV-3; the header `n`
is correct upfront). The two options are retained only for the record; the decision is server-side.

## 11.1h Canonical data flow — visualising a gene's expression (verified end to end)

Two INDEPENDENT channels. Positions load once; the gene is a separate fetch on colour-pick.

**Wire format for a gene** (`viz/src/viz-core/data/streamDecode.ts:96`):
```
[ u32 n ][ n × u32 row-positions ][ n × f32 values ]      total = 4 + 8n bytes
  nnz      ascending positions       expression
```
`N` (the point count) is NOT on the wire — it rides the small STRUCTURE channel (DEC-8); the
decoder is `decodeSparseColumnStream(stream, N)`. Guard: `n > N` is rejected as corrupt (nnz ≤ rows).

**Flow for "colour by gene G":**
```
server:  indptr[G..G+2] → (lo,hi);  serve indices[lo:hi] + data[lo:hi] as sparse CSC bytes
   ↓  AsyncIterable<Uint8Array>  (streamed on the wire; ~40 KB for a gene)
decode:  decodeSparseColumnStream(stream, N) → SparseColumn { row:u32[nnz], value:f32[nnz], length:N }
   ↓  (whole-collect — resolves at stream end; only POSITIONS stream progressively)
reframe: row[i] : source position → canonical point position   (identity for a real dataset;
                                                                  + segment offset + mask rank for virtual)
densify: densifyGpu — one GL_POINT per nonzero at row[i], writing value[i] into a zero-init texture[N]
colour:  scatter layer reads the per-point scalar → colorScale → RGBA
```

**Shapes** (N = 1.8M points; a gene ≈ 5k nonzeros):

| stage | shape | size |
|---|---|---|
| stored CSC gene slice | `indices[nnz]` u32 + `data[nnz]` f32 | ~40 KB |
| **wire** | `4 + nnz·4 + nnz·4` bytes | **~40 KB** |
| decoded `SparseColumn` | `{ row:u32[nnz], value:f32[nnz], length:N }` | ~40 KB |
| after reframe | same, `row` remapped | ~40 KB |
| **densified GPU texture** | `scalar[N]`, zero-init, nnz written | **7.2 MB, GPU-resident** |
| positions (separate, loaded once) | `f32[2N]` | 14.4 MB |

**The load-bearing property: the payload is SPARSE (~40 KB); the dense 7.2 MB scalar array is a GPU
DESTINATION, never a payload.** Shipping dense would push 7.2 MB per gene switch; sparse ships
40 KB and the GPU scatter fills a zero-init texture in one pass. Consequences:
- **Gene switching is cheap** — a new ~40 KB sparse fetch re-scatters into the texture; positions
  (14.4 MB) stay resident.
- **`N` and the values are decoupled** — `N` rides the structure channel; the wire carries only WHICH
  points are nonzero and their values. That is what lets one small sparse column project into a large
  fixed point set.

- **INV-S22**: The colour payload for a gene is the SPARSE column (`4 + 8·nnz` bytes), never a dense
  `N`-length array. The dense scalar[N] is built GPU-side by scatter into a zero-init texture and does
  not cross the wire. *Test:* a gene colour fetch transfers `O(nnz)` bytes, not `O(N)`.

## 11.1i Masked gene return — same shape, only `row` and `length` change

Owner framing (2026-08-20): the return must be *exactly* the same `SparseColumn` shape; the mask
lives entirely in how `row` is computed. **This settles the placement fork (§11.1g) SERVER-SIDE.**

**Server-side masked gene read:**
```
read indptr[G..G+2] → (lo,hi)
for k in lo..hi:
    p = indices[k]
    if mask[p]: emit (rank[p], data[k])     # OUTPUT position + value
# header n = kept nnz;  length N = N_kept
```
`rank` = exclusive prefix-sum of the mask (cached per dataset+mask). Output positions come out
ASCENDING for free — source positions ascending + `rank` monotonic ⇒ order preserved, still a valid
CSC slice, no re-sort.

**Integration adds a segment offset** (gene G from D1 and D2, each filtered+ranked in its own space,
D2 shifted by D1's kept count):
```
D1 keeps {0,2} rank=[0,1,1] n_D1=2 ;  D2 keeps {1} rank=[0,0] offset=2 ;  N_kept=3
gene G: D1 cell0=5 cell2=8, D2 cell1=3
  → row=[0,1,2] value=[5,8,3] length=3   (ascending, valid)
```

**Why server-side is the answer, not just workable:**
- **Wire + client are byte-identical to a real dataset.** Header `n` = kept nnz is correct UPFRONT —
  a client-side mask would force post-decode compaction, because `decodeSparseColumnStream` allocates
  `row`/`value` from the header `n`. The client decodes → `SparseColumn{row:output positions,
  value, length:N_kept}`, reframe is IDENTITY (as for a real dataset), GPU scatters into texture[N_kept].
  **INV-3 holds completely.**
- **`N_kept` rides the structure channel, already there** — the gathered column's `zarr.json` is
  server-resolved with `shape = post-mask kept count` (§11.1e/INV-S17). No new plumbing.
- Client-side would ship the mask/rank, break INV-3, and fight the header-declares-`n` decoder.

**Cost:** the server reads `indices` (source positions) to filter+rank — the SAME bounded INV-1
concession the dense gathered path already makes (§11.1e), now over three members instead of one,
one gene at a time, in the gather-decode module.

- **INV-S23**: The masked gene return is shape-invariant with the unmasked/real one —
  `SparseColumn{row,value,length}`. Only `row` (filter→drop, rank→renumber, +segment offset) and
  `length` (N→N_kept) differ; `row` stays ASCENDING; the wire header `n` is the KEPT nnz.
  *Test:* a masked integrated gene decodes to the same type as a real gene, `row` strictly ascending,
  densifies to the kept values at their output positions over length N_kept; the client applies an
  IDENTITY reframe in both cases.

## 11.1j 2-D dense embeddings — masking is a row gather, the gap is STRUCTURE not logic

**Storage: row-chunked `n × k` dense** (`zarrReader.ts:28,724`). Row `r` = flat `[r·k, (r+1)·k)`,
and `read(lo,hi)` is *"a range of chunks instead of a scatter"* — a genuinely tiled 2-D array is
deliberately NOT supported, because row-chunking makes a row-range one contiguous read. Positions
are `Positions { positions: Float32Array[2N] ([x0,y0,…]), length: N }`, dense, whole-collect decode
(`decodeFloat32Stream`). Straight to the GPU position buffer — **NO densify, NO scatter** (that is
sparse machinery; a dense array has nothing to fill in).

**Masking is SIMPLER than sparse:** gather the kept rows in output order → `n_kept × k` dense,
contiguous. The contrast is the point:

| | sparse gene | dense 2-D embedding |
|---|---|---|
| index | explicit (`indices`) | implicit (array position) |
| mask does | filter + rank-renumber + scatter | gather kept rows |
| renumber | needed (positions are values) | **none** — output order IS the output position |
| densify | GPU scatter | **none** — already dense |

Amplification `~1/density` (kept rows scattered in the source → touch their source chunks), k-wide.

**Two DIFFERENT cases for an embedding on a virtual dataset:**
- **(a) computed ON the virtual dataset** → ATTACHED artifact (INV-S7): already `n_kept × k`, served
  DIRECTLY, mask NEVER applied. The "filter then recompute UMAP on the subset" flow. Works TODAY —
  a plain dense 2-D artifact, no gather.
- **(b) a SOURCE embedding viewed THROUGH the mask** → masked 2-D read (gather kept rows of the
  parent's `n×2`, so survivors keep their ORIGINAL coordinates). The "filter but stay put in the same
  UMAP" flow — arguably the MORE common expectation. Needs the gathered path to serve a 2-D member.

**The gap is STRUCTURE, not logic.** The masking mechanics for (b) are trivial (row gather). What
blocks it is that `gathered_structure` hardcodes `shape:[n]` + `arrays:[]` and **cannot NAME a 2-D
member** (§3.7 hard-shape #2, D9). The fix is a DECLARATION change — carry `shape:[n_kept, k]` in
`arrays[]` — not gather logic.

### Orientation (owner, 2026-08-20): "10 vectors of 2", not "2 vectors of 10"

An embedding is ONE `n × k` member stored ROW-MAJOR — `rowElements = product(shape[1:])` = 2,
row `r` = flat `[r·2, (r+1)·2)` (`zarrReader.ts:724,776`). So `[x0,y0,x1,y1,…]`: each CELL is a
contiguous 2-tuple. It is the deliberate OPPOSITE of expression:

| | orientation | one contiguous read | dominant access |
|---|---|---|---|
| expression (CSC) | gene-major | one gene, all cells | one gene across all cells (colour) |
| embedding | cell-major (row-chunked) | one cell, all dims | every dim of a cell (to position it) |

Cell-major keeps a point's coordinates contiguous and is GPU-native (WebGL buffers are interleaved
`[x,y,x,y,…]`).

**D20 — DECIDED (owner, 2026-08-20): positions are TWO NUMERIC COLUMNS, not an `n×2` member.**
The embedding is stored as k contiguous 1-D columns (`umap_0`, `umap_1`); the frontend sends k
requests, each a plain numeric-column read, masked by the numeric path verbatim. **This deletes the
2-D member concept from the entire read/mask/serve design** — there is no 2-D gathered structure, no
D9 #2 gap, and no special embedding shape.

Why it is the right call, beyond deleting the gap:
- **A UMAP stops being special.** A scatter becomes "two numeric columns → x,y", and a UMAP is the
  case where those columns are `umap_0`/`umap_1`. Gene-A-vs-gene-B, QC-X-vs-QC-Y, and the embedding
  are then the SAME mechanism.
- **A coloured UMAP is 3 uniform requests:** `umap_0`, `umap_1` (numeric positions) + `gene_G`
  (sparse colour). All three are "read a column".

Honest costs (this is a CHANGE, not a reuse — the viz core today has ONE positions path, a single
interleaved `Float32Array[2N]` member; there is no 2-column composition):
- **Storage** — dims stored CONTIGUOUSLY (2 columns), forced: a row-major `n×2` has STRIDED columns
  (dim 0 = elements 0,2,4,…), so "read dim 0" would be a scatter. Producer change.
- **Read** — the scatter still wants interleaved `[x,y,x,y]`, so after reading two columns either
  interleave client-side (~1.8M-element loop, a few ms) or bind two GPU attributes (`aX`,`aY`). The
  scatter layer is untouched; only the SOURCE of its position buffer changes.

### D20 is an ADAPTER change, NOT a render-core change (verified `src-app/libs/viz`)

Do we modify the viz core to accept `{x: streamable, y: streamable}`? **No.** The render core
(`scatter.ts`) takes `getPosition: { value: Float32Array, size: 2 }` — one interleaved deck.gl binary
attribute, `[x,y,x,y]`. deck.gl's `getPosition` wants ONE buffer per instance (you cannot feed two
size-1 arrays without a custom layer), so the interleaved buffer stays and the core contract is
STABLE.

The composition is one method — `streamingAdapter.positions(layoutId)`. Today:
`decodePositionsStream(stream({kind:'positions', layout}))`. Under D20: read the layout's two numeric
VALUE columns, interleave → `Positions{ positions: Float32Array[2N], length: N }`. Same return type.
**The `{x,y}` pair is an internal detail of that method, not a new core contract.**

**Masking comes FREE:** `positions()` now reads value columns, and a virtual dataset serves value
columns already masked by the numeric path — so masked positions need ZERO render-core change, zero
2-D gather, zero new masking logic. The mask acts where it already acts (numeric column serving); the
adapter is oblivious.

| layer | change |
|---|---|
| render core (`scatter.ts`, `getPosition`) | **none** |
| adapter `positions()` | read 2 value columns + interleave (was: decode 1 member) |
| catalog/layout descriptor | a layout names its 2 columns |
| masking | **none new** — inherited from the numeric column path |

Honest notes: the current `packed-u16` positions encoding (a compression on the single member) is
dropped for two f32 columns — minor. The interleave is whole-collect and cheap (positions decode
whole today via `collectStream`): read both dim columns, interleave in one ~1.8M-element loop, a few
ms per LAYOUT LOAD, never per frame.

- **INV-S26**: An embedding is served as k contiguous 1-D numeric columns, each read+masked by the
  numeric path; positions are composed client-side (interleave or k attributes). There is no 2-D
  gathered member. *Test:* a masked scatter reads its x and y as two independent numeric columns
  whose masked results interleave to the kept points; no `arrays[]`/`shape:[n,k]` member is served.

**(superseded framing below — kept for the record)** The orientation IS what creates the 2-D
masking gap.** Because positions are one `n×2`
member, masked case (b) needs the gathered structure to NAME a 2-D member (§11.1j / D9 #2). The
alternative — store each dim as a 1-D COLUMN (`x[]`, `y[]`, "2 vectors of 10") — makes each dim an
ordinary numeric column, masked by the numeric path, and **deletes the 2-D gap entirely**.

| | row-major `n×2` (today) | dim-as-column |
|---|---|---|
| GPU feed | direct (interleaved) | re-interleave on read |
| members | one | k |
| masking | needs 2-D structure (gap) | reuses numeric masking, **no gap** |
| read one point | contiguous | two reads |

For `k=2` the re-interleave is trivial, so serving positions as two masked numeric columns is a
viable way to erase the 2-D gap; wide embeddings (`k=50` PCA) are compute inputs, not positions, so
the tradeoff is confined to the small-k visualisation case. **Decide deliberately** — it is the
difference between "build 2-D gathered structure" and "reuse the numeric path".

- **INV-S24**: A masked 2-D dense read is a ROW GATHER: kept rows copied in output order to
  `n_kept × k`, no index renumber (position is implicit), no scatter. *Test:* a masked embedding's
  row `i` equals the source's `i`-th kept row, at length `n_kept`.
- **INV-S25**: An attached artifact is ALWAYS a compute output of the dataset (D21) — hence on its
  row space by construction — and is served DIRECTLY (mask never applied, INV-S7). Only a SOURCE
  artifact viewed through the mask is gathered. *Test:* an attached
  `n_kept × k` embedding round-trips unmasked; routing it through the gather fails.

**D9 residue for 2-D:** case (a) needs nothing; case (b) needs the gathered structure to name a 2-D
member (`shape:[n,k]` in `arrays[]`). That declaration gap is the last thing blocking the full read
path, and it is small.

## 11.2 EFFICIENCY invariants

Efficiency claims must be MEASURED, not asserted. #150 built the oracle: a counting decorator
over the real `ObjectStore`, which is exact and deterministic rather than timing-dependent.
Reuse it.

- **INV-E1**: Read amplification is bounded by `1/density`, NOT by chunk count.
  *Test:* a whole-column scan of a masked column at >=500k rows measures amplification at the
  `ObjectStore` seam; at 60% kept it is <=~2x, not 123x. **State the kill criterion up front.**
- **INV-E2**: The resolution is computed ONCE per `(column, alignment, mask)`, never per chunk.
  *Test:* a whole-column scan issues a bounded number of resolutions; a mutation that resolves
  per chunk fails it.
- **INV-E3**: The resolution cache key includes the MASK.
  *Test:* two virtual datasets differing ONLY by mask do not serve each other's rows. **This is
  a correctness test wearing an efficiency hat — the failure is right-length, wrong-cells.**
- **INV-E4**: Metadata goes to the sandbox, not data. A compute receives the alignment + mask
  (index vectors, ~MB) plus already-mounted matrices, never a materialised merged matrix.
  *Test:* the staged input set for a run contains no matrix-sized artifact the sources did not
  already provide.
- **INV-E5**: A virtual dataset costs catalog rows, not bytes. Gathered artifacts carry no blob.
  *Test:* creating a virtual dataset over N common columns adds 0 to `sum(stored_bytes)`.

## 11.4 Axis attribution — MUCH NARROWER than first framed (correction)

**Correction (owner pushback, 2026-08-20): the broad "axis attribution is THE verifiability gate"
framing below was INFLATED.** Walking the actual serve flow, most of it evaporates:

- The mask is the VIRTUAL DATASET's mask, applied to the VIRTUAL DATASET's own members. **You never
  cross datasets**, so the "dataset A's `cells` vs dataset B's `cells`" collision — the whole basis of
  the hazard — does not arise: you operate on ONE dataset at a time.
- **masked vs served-direct** is `object_key` NULL-ness (DEC-8), not attribution.
- **cell-axis vs gene-axis member** (so a cell mask skips a gene-indexed var column) is the member's
  declared axis, which **#149 made reliable**; within one dataset `"cells"` / `"genes"` are
  unambiguous.

So "the mask hits the wrong axis" is ALREADY prevented by dataset scope + `object_key` + #149's axis
declaration. The pervasive-attribution problem was a phantom.

**The one genuinely open thing, and it is small:** an ATTACHED artifact (INV-S7, served direct) —
is it on the VD's row space? And it only bites under one condition:
- attachment **constrained to "an output of a compute that ran on THIS VD"** ⇒ on the row space BY
  CONSTRUCTION, nothing to check, no issue;
- attachment **allows an ARBITRARY artifact** ⇒ a wrong-population artifact with matching `N` could
  pass silently ⇒ a DIGEST check AT ATTACH TIME (one check, not a system).

**D21 — ANSWERED by the owner, 2026-08-20: RESTRICTED. "There will be no case that we allow an
arbitrary artifact to be attached to a dataset."** An attached artifact is always the output of a
compute that ran on that dataset, so it is on the dataset's row space BY CONSTRUCTION. No attach-time
digest check, no attribution gate anywhere — the wrong-population attach is not a state the system can
reach. **This fully closes axis attribution:** the mask path was already handled (dataset scope +
`object_key` + #149's declared axis), and the attach path is closed by this scoping rule. INV-S10 is
retained only as the digest-over-label PRINCIPLE for identity, not as an open gate.

---

## 11.4-old Axis attribution — the verifiability gate (INV-S10 explained) [SUPERSEDED FRAMING]

**The question:** for any artifact, which ROW SPACE do its elements index — and can it be decided
with certainty? A mask belongs to ONE row space; applying it to an artifact on a different one
silently corrupts. So attribution must be DECIDABLE before a mask is safe.

**Two signals** (`coordinateAxis.ts:15-23`), and the gap is the difference between them:
- **`aligned_to` — a DIGEST** (content hash of the row-key sequence). Same `aligned_to` ⇒ provably
  the same cells in the same order. Precise — **but OPTIONAL** (pre-aligner imports lack it).
- **a declared axis LABEL** (`"cells"`), scoped to `(source dataset, axis label)`. Always present —
  **but a NAME, not an identity**, and `axis:` is deliberately allowed to be just a label.

**The label is shared BY CONSTRUCTION, not by coincidence.** The axis NAME `"cells"` is declared by
the DATATYPE (`single-cell-types/manifest.yaml`: *"Both entries DO declare `axes`, deliberately"*;
checked via `reg.axes_for(dataset.datatype)`). So EVERY dataset of that datatype has a row axis
labelled `"cells"` — dataset A (1000 cells) and dataset B (800 cells) both do, same label, different
populations. **The label identifies the axis's ROLE ("this is the cells axis"), never WHICH cells.**
The system already scopes around this: an axis INSTANCE is `(source dataset, axis label)`
(`coordinateAxis.ts:23`), with a test named *"keeps two datasets that SHARE a name apart"*
(`candidateGroups.test.ts:46`); `siblingsOnAxis` is *"scoped to the anchor artifact's dataset AND
axis"*. So decide "on my row space?" by LABEL and you match EVERY dataset's cells axis — a mask lands
on the wrong population, right shape, wrong cells, no error.

Two identities that DO pin a population: `(source dataset, axis label)` (works within one dataset),
or the DIGEST (works across datasets — and is REQUIRED for a virtual dataset, whose row space is a
NEW population matching no single source's `(dataset,label)` but carrying its own digest).

**Why it GATES everything:** the masking design rests on INV-S1 (*a mask never touches an artifact
not on the mask's axis*). You cannot write a passing test for INV-S1 if "on the mask's axis" is
ambiguous. So every read/mask invariant is only as sound as this one — it must be made decidable
FIRST. And Rust has NO dispatch point today: `structure` is opaque JSONB, `axis`/`aligned_to` are
never inspected server-side (only `encoding` non-empty is checked). Nothing refuses to mask an
unattributable artifact.

**Resolution direction (recommended): attribute by DIGEST, not label.** A mask applies iff the
artifact's `aligned_to` (or own key digest) equals the mask's row-space digest; **no digest ⇒
REFUSE** (membership unprovable ⇒ do not act). Label stays a discovery/display convenience, never the
authority for a row-space operation. Same digest machinery as INV-S5, same identity #149 began
stamping on gathered artifacts — hardened to: unattributable ⇒ not a mask target. This is what makes
INV-S1/S10 checkable.

- **INV-S10 (restated)**: An artifact's cell-indexed-ness is decided by DIGEST match, not label. An
  artifact carrying a matching axis LABEL but no `aligned_to` digest is REFUSED as a mask target, not
  treated as on-axis. *Test:* an artifact labelled `cells` with no digest is refused; one whose
  digest equals the mask's row-space digest is accepted; a DIFFERENT population also labelled `cells`
  is refused.

## 11.5 There is NO row alignment — rows concatenate, only genes align (and why that is correct)

Owner, 2026-08-20: *"there is no such thing as row alignment right? in what case we need it?"*
**Correct, and it is not a gap.** The alignment's asymmetry is explicit (`_helpers/alignment.py:902`):
*"the ROW axis is a CONCATENATION … the ENTITY axis is an INTERSECTION."* Cells are stacked; only
genes are matched (by symbol) and intersected. "Alignment" is exclusively a gene-axis concept.

Row alignment is a real concept — it is the MIRROR of integration:

| | rows (cells) | features |
|---|---|---|
| integrate two RNA datasets | concatenate (different cells) | join by gene symbol |
| multi-modal, same cells | **join by barcode** | concatenate (different modalities) |

**But the join-on-cells case (multi-modal: RNA+ATAC+protein on the SAME cells) is resolved at
IMPORT, not at runtime.** It arrives as one combined feature-barcode matrix — cells already shared,
features split by modality into column indices (`anndata-import/compute/multimodal.py`, INV-10). The
cell-join happened upstream; by the time it is a dataset the cells are one set. So the runtime
alignment only ever concatenates rows and joins genes — the asymmetry is correct for the current
scope.

**The one future case that would resurface it:** joining two SEPARATELY-imported datasets on the
same cells at runtime (an RNA dataset + an independently-imported ATAC dataset on the same barcodes).
Not supported today (import them together as a combined matrix instead). If ever wanted, the design
would need the JOIN to apply to the cell axis too — generalising today's entity-only join. Recorded,
out of scope now.

## 11.6 The correct vocabulary: METADATA merging + FEATURE merging (not "alignment")

Owner, 2026-08-20: *"there is no such thing as row alignment; there is metadata merging and feature
merging."* Two operations, one per axis:

- **METADATA merging** — reconcile the cell-level obs columns when cells are concatenated.
- **FEATURE merging** — reconcile the genes (the entity intersection + gene-annotation handling).

### Metadata merging (re-stated)

Concatenating D1+D2's cells keeps every cell's metadata; the COLUMNS are reconciled across datasets.
- **numeric / string** metadata → just concatenate values; nothing to reconcile.
- **categorical** (`cell_type`, `condition`) → the real work (`resolve_levels`):
  - **`strict`** — UNION the vocabularies (`(A,B,C)+(B,C,D,E)→[A,B,C,D,E]`; each source's codes
    remapped into the union). Asserts nothing.
  - **`authority`** — take the NAMED dataset's vocabulary, drop the rest; a dropped level becomes NA
    (a declared `missing_level`), so the CELL STAYS with an NA value — never a dropped row.

**One rule generates both modes, and it explains why they behave OPPOSITELY on the two axes**
(`_helpers/alignment.py:688-696`, verbatim): *"strict never asserts an identity nobody observed;
authority lets one dataset's annotation be the assertion."*

| | `strict` | `authority` |
|---|---|---|
| FEATURE merging (genes) | DROPS — merging disagreeing gene annotations is an assertion | KEEPS — one dataset's annotation is the assertion |
| METADATA merging (levels) | KEEPS — unioning two vocabularies asserts nothing | DROPS — declaring one vocabulary complete is an assertion |

Manifests in the read as a gathered categorical column: assembled from both sources' cells, codes
remapped to the unified vocabulary via `remap_codes` (§11.1d). `ordered` categoricals union by the
same path (no order claimed, INV-15). **A dropped level is NA, never a dropped cell** — metadata
merging never changes WHICH cells exist, only what a column SAYS about them.

## 11.7 Feature merging — engine executes, processor/widget decides

A feature (gene) carries its own annotations as var columns (`gene_id`, `feature_name`,
`ensembl_id`); a dataset may have one, all, or more, and they are NOT guaranteed unique. Feature
merging matches genes across datasets on ONE of those columns. Four operations, verified in
`_helpers/alignment.py`:

1. **`candidate_keys(sources)`** — the INTERSECTION of var-column names ("a column one source lacks
   cannot join anything"). Handles "1 or all or more": only shared columns can be keys.
2. **`join_quality(sources, keys)`** — per candidate key, `matched / conflicting / duplicated`
   (e.g. `ensembl_id 17,900/0/0` vs `symbol 18,204/1,204/12`). **Non-uniqueness surfaced as data**;
   this table is the `embedding.join-quality` widget.
3. **`refuse_duplicate_keys(sources, key)`** — a duplicated (or normalisation-colliding) key
   HARD-FAILS. The engine never takes-first or collapses; it refuses. Clean-key selection is upstream.
4. **`resolve_features(sources, key, mode, authority)`** — execute the match (strict/authority per
   §11.6).

**The boundary (owner, 2026-08-20): the engine EXECUTES an alignment spec; it does NOT decide how to
align.**

| layer | owns |
|---|---|
| **engine** (`_helpers/alignment.py` + workstore) | the operations — discover / measure / refuse / execute. Domain-free. |
| **widget** (`embedding.join-quality`) | show candidates + quality; the user PICKS |
| **processor** (`embedding.integrate`) | take chosen `key`+`mode`, call the operations, emit the alignment |

Creating a virtual dataset takes an alignment SPEC (`key`, `mode`, `authority`) as a parameter and
the engine executes it. WHICH column, WHICH mode, refuse-vs-normalise are domain decisions authored
by the processor/widget from what `join_quality` reveals — never baked into the engine. Same
domain-free-engine / domain-in-processor split as the rest of the system.

**Consequence to make first-class in the UX:** because the engine REFUSES a non-unique key rather
than resolving it, producing a clean key is upstream — the user picks a unique candidate, supplies a
normalisation, or the merge refuses. There is no "engine figures out the duplicates" path (guessing
how to collapse duplicate symbols is a domain decision the engine has no business making). So the
widget must treat "this key has duplicates — pick another or normalise" as a first-class state, not
an error.

## 11.7b What the engine actually stores for a feature merge — the RESOLVED MAPPING

Owner, 2026-08-20: the engine needs only the resolved matching, not the recipe. If DS1 has 10
features, DS2 has 7, and the widget decides 5 are common, the engine needs two mapping vectors —
`var1_mapping numeric(10)`, `var2_mapping numeric(7)`, each entry the unified index (0-4) or a
sentinel for "not in the common set" — plus a label reference. **Correct.** All domain work (key,
normalize, dedup, mode) is BAKED INTO the mapping by the widget; the engine never sees `key` or
`normalize`.

**Encoding equivalence:** the owner's SOURCE-major vectors (source feature → unified index) and the
stored `entity_index` (UNIFIED-major: `entities × sources`, unified feature → per-source column) are
the SAME bipartite matching, transposed.
- **serving prefers unified-major** — gene G needs "which column in each source?", i.e.
  `entity_index[G]` directly; the source-major form is inverted once to answer it.
- **source-major carries the DROPPED features** (via the sentinel) that `entity_index` forgets —
  useful for the `join_quality` coverage report, not for the read.
- Store either; derive the other.

**Labels are a REFERENCE, not a copy.** The unified feature does not store a merged label; it
references one source's var annotation ("map back to DS1" = DS1 is the label authority). The engine
holds `authority = ds1`, and the unified gene's `feature_name` is read THROUGH DS1's annotation. Same
`authority` decision as §11.6/11.7, on the feature axis.

| the engine STORES | NOT (this is provenance) |
|---|---|
| the mapping (per-source ↔ unified) | the key column |
| the label authority | the normalization pipeline |
| level lookups for categorical VAR annotations, if any | the dedup/mode logic |

Everything on the right is provenance — recorded for reproducibility/audit, but the SERVE path needs
none of it. **Caveat:** the mapping vectors are the MATCHING for the key. If datasets carry
categorical VAR annotations to be merged too (a per-gene `chromosome` categorical), those still need
the §11.6 level-unification — the same metadata-merge machinery, on the gene axis. Mapping = matching;
categorical var values = the §11.6 treatment. For plain expression, mapping + label authority is the
whole story.

## 11.8 Key normalization — a fixed, curated vocabulary, part of the spec

Normalization canonicalises a key BEFORE matching, so semantically-equal keys with superficial
differences join. Verified in `_helpers/align.py`.

**Vocabulary — exactly four steps** (`_KNOWN_STEPS`); an unknown step hard-errors:

| step | does | example |
|---|---|---|
| `casefold` | Unicode-aware lowercasing | `TP53` → `tp53` |
| `ensembl_version` | strip `.NN` version | `ENSG…141510.17` → `ENSG…141510` |
| `barcode_suffix` | strip trailing `-<lane int>` / `_<sample>` (numeric lane only) | `AAAC-1_s1` → `AAAC` |
| `trim` | whitespace | `" TP53 "` → `TP53` |

`_as_key` runs FIRST: integer-float `1.0 → "1"`; `None`/NaN → `""` = ABSENCE, never a key.

**Three properties:**
1. **Matching ONLY** — applied to both sides to decide equality; the stored values are unchanged.
2. **Part of the spec, from a FIXED vocabulary.** `normalize=[…]` is an ordered pipeline authored
   per-alignment. The engine EXECUTES a declared pipeline; it never invents a canonicalisation. The
   fixed vocabulary is the safety — no arbitrary code runs in the join, only curated domain-known
   steps. (Extends §11.7: an alignment spec is `(key, mode, authority, normalize[])`; ALL FOUR are
   processor/widget decisions, the engine decides none.)
3. **Normalization can CREATE a collision, and it is refused.** Two distinct raw keys canonicalising
   to one (`TP53` + `tp53` under `casefold`) hard-fail (`normalized key … maps to multiple rows`).
   The coverage report exposes `matched_before_normalize` vs `matched_after_normalize`, so the widget
   shows how much a step helped versus what it risked.

**One vocabulary, both axes:** `barcode_suffix` canonicalises CELL barcodes (row/multi-modal join),
`ensembl_version` canonicalises GENE ids (feature merge). Normalization is axis-agnostic —
"canonicalise a key", applied wherever there is a key to match — so metadata-merge and feature-merge
share one normalization engine.

## 11.9 CURRENT CODE vs this design — what exists, what is new (the BASE delta)

Verified against `build_vectors` (`_helpers/alignment.py`), which returns:
`{key, mode, authority, segments, row_source, row_segment, entities, entity_index, level_lookups,
source_digests, n_rows}`.

**The FEATURE-MERGE half is already built — no update needed.** `entity_index` IS the resolved
mapping (unified-major = the transpose of the source-major `var_mapping` vectors; equivalent).
`authority` is the label reference. The processor decides key/mode/normalize and calls
`resolve_features`; the engine executes. That is the design. Two caveats: it stores the mapping in the
TRANSPOSE of the source-major drawing (cosmetic), and it ALSO stores `key/mode/normalize` as
PROVENANCE (the serve path does not read them; keep them for reproducibility).

**The MASK half is NOT built — that is the new work.**

| the design needs | current code | delta |
|---|---|---|
| feature-merge mapping | `entity_index` | **none** |
| label authority | `authority` | **none** |
| row concatenation | `segments` | **none** |
| categorical level unification | `level_lookups` | **none** |
| per-source key digest | `source_digests` | **none** |
| **the MASK** (per-source boolean row selection) | **absent** | **NEW** — `embedding-integrate` integrates, it does not filter; the alignment carries no mask, and `cell-filter` writes a mask column on the SOURCE that nothing consumes as a virtual-dataset row selection |
| drop redundant `row_source`/`row_segment` | present | **D18** |
| positions as numeric columns | one 2-D member | **D20** |
| masked serve path (§11.1i) | gather serves unmasked | **NEW** |
| filter→virtual-dataset creation | no such path | **NEW** (§11.3) |

So the merging model is largely IMPLEMENTED; the MASK and everything downstream of it (masked serve,
filter-creates-a-virtual-dataset) is the genuinely new capability this design adds. A plan must not
mistake "the feature merge is built" for "the design is built" — the mask is the work.

## 11.3 What must be settled BEFORE this can become a lifecycle

- **Attachment scope (D21, §11.4)** — is an attached artifact restricted to this-VD's own compute
  outputs (no check needed) or arbitrary (one attach-time digest check)? This REPLACES the earlier
  overblown "axis attribution is the verifiability gate" item — the serve flow already disambiguates
  masked/direct and cell/gene, so only attached-artifact validation is genuinely open.
- **D9 / sparse** — in or out. The inventory sharpened the cost: sparse needs a SECOND STREAMING
  GRID (per-gene, not per-row-chunk), not merely sparse-aware gather.
- **D18** — drop the row vectors and `source_index`, or keep them.
- **The filter→virtual-dataset path does not exist.** #149 established there is NO filter path
  that creates a dataset: `cell-filter` attributes its mask to the ORIGINAL dataset and the DB
  CHECK admits only `upload|promote|integrate`. This design assumes that path; it is NEW WORK,
  not a modification.
