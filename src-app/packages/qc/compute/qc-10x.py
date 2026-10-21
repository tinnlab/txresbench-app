#!/usr/bin/env python3
# ruff: noqa
"""qc-10x — CytoAnalyst sandbox compute processor.

NON-DESTRUCTIVE annotator. Reads the count matrices bound to its ``matrices`` slot
and computes per-cell QC metric COLUMNS. It does NOT filter, split pooled samples,
or embed — the matrices are untouched; filtering is the downstream Cell-filter
analysis.

## The input contract (ITEM-17 / ITEM-24)

Every input is resolved by **SLOT** out of ``/inputs/inputs.json`` — the run's own
wiring, written by ``sandbox/inputs.rs::render_inputs_json``. There is no filename
glob and no reader-by-suffix: the runner names each mount from the artifact it is
mounting (ITEM-23), so a mount name says nothing about a format, and the FORMAT is
read from the artifact's own ``structure`` declaration (a Zarr group's
``attributes.cyto``).

  * ``matrices``   — REQUIRED, a **LIST**. One job over EVERY selected modality
                     matrix (DEC-6): the cells axis is SHARED, so joint filtering
                     (``rna:pct_mito`` AND ``prot:total_counts``) is only meaningful
                     if ONE run writes all of them onto that axis. Each is a
                     ``single-cell/expression``-family artifact, i.e. a multifile
                     **CSC Zarr store** (``kind: sparse_csc``) — NOT an ``.h5ad``.
  * ``gene_names`` — list-aligned with ``matrices``: entry *i* is the genes-axis
                     artifact whose **VALUES** matrix *i*'s gene patterns match
                     against (DEC-8). REQUIRED, one per matrix, whenever the run
                     selected any metric — which is every run that emits a column,
                     since EVERY metric is now a gene-set question (the builtins
                     that used to need no gene names are ordinary ``.*`` rows).

                     A list that cannot be paired one-to-one with ``matrices`` is
                     FATAL (``require_paired_gene_names``). It used to be answered
                     with a per-metric warning and a dropped column, which is the
                     same class of wrong answer as the zero column that preceded it:
                     the caller asked for ``pct_mito`` on every matrix, got it on
                     some, and nothing on the path to the screen said which.
  * ``cells_index``— OPTIONAL. The cells-axis key artifact; supplies the per-cell
                     ``id`` values of ``obs.json``. Absent ⇒ positional ids.

Every metric is OPTIONAL and every metric has the SAME shape (a per-run editable
set — ITEM-18): a NAME, a gene SET (a regex over gene names), and an AGGREGATION.
There is no privileged subset. ``total_counts`` and ``n_genes`` are ordinary rows
(``sum`` and ``count`` over ``.*``), so a user can remove, rename or narrow them —
none of which the hardcoded ``BUILTIN_METRIC_NAMES`` special case allowed.

Emitted outputs (typed, role-tagged):

  * ``report/qc``         — ``obs.json`` (the per-cell metric table the UI reads)
                            + ``qc-report.json`` (per-metric distributions)
  * ``metadata-column``×k — one column per SELECTED metric per MATRIX (all cells,
                            INPUT ORDER), modality-prefixed.

Params (``/inputs/params.json``): ``qc_metrics`` — a list of
``{name, pattern, aggregation}``; omitted ⇒ ``DEFAULT_QC_METRICS``. Three refusals,
all FATAL and all naming the row, because each alternative answer is a number
nobody can read:

  * ``MissingGenePattern`` — absent/empty ``pattern``. The empty regex the compute
    used to substitute matches EVERY gene and reports ~100 % on every cell.
  * ``InvalidAggregation`` — absent ``aggregation``, or one outside
    ``AGGREGATIONS``. Never defaulted: the unstated default is the defect.
  * ``DuplicateMetricName`` — two rows sharing a name. The name IS the emitted
    column name (DEC-1), so the second would overwrite the first.

``matrix_modalities`` — the per-matrix column PREFIX, positionally aligned with the
``matrices`` slot list (see ``modality_keys``).

``fileType`` and ``assay`` are GONE. ``fileType`` selected a reader; the artifact
declares its own encoding. ``assay`` re-did the importer's split by filtering
``adata.var["feature_types"]`` — a path that only exists when reading a raw AnnData,
and it read ``feature_types`` (plural) while a CELLxGENE dataset's column is
``feature_type``. The split is the importer's, and it already happened: each
modality arrives as its own matrix artifact.

Roots overridable via ``CYTO_INPUTS_DIR`` / ``CYTO_OUTPUTS_DIR`` (unset in the
sandbox → ``/inputs`` / ``/outputs``). Progress → ``$CYTO_PROGRESS_FIFO``.
"""
import json
import os
import sys
from pathlib import Path

# Single-thread the numeric stack BEFORE numpy/scipy/scanpy import: the sandbox
# caps PIDs, and the BLAS/OpenMP/numba thread pools otherwise exhaust it
# (`pthread_create: Resource temporarily unavailable` → SIGABRT). Also makes the
# compute deterministic (reproducible-run friendly).
for _v in (
    "OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS",
    "NUMEXPR_NUM_THREADS", "VECLIB_MAXIMUM_THREADS", "NUMBA_NUM_THREADS",
):
    os.environ.setdefault(_v, "1")

import numpy as np

# The shared output-format library (`_lib`, DEC-7) — staged into `/code` alongside every
# Python entry, same as `align` / `colsummary`. `cyto_columns` imports pandas lazily.
import cyto_deps
import cyto_columns

# NOTE: scipy is imported LAZILY (inside `is_outlier` / `main`), not at module top,
# so the pure, side-effect-free helpers (`parse_qc_metrics` / `compile_gene_pattern`
# / …) import with numpy alone. The sandbox runtime always ships scipy; the unit
# suite (numpy/pandas-only) exercises the helpers without it. The single-thread env
# caps above are still set before numpy import, so scipy inherits them either way.

# ─────────────────────────── shared compute runtime ───────────────────────────
DT_EXPRESSION = ("single-cell/expression", "chunked-sparse")
DT_METADATA_COLUMN = ("metadata-column", "chunked-1d")
DT_REPORT_QC = ("report/qc", "opaque")
DT_REPORT_HTML = ("report/html", "opaque")
DT_EMBEDDING = ("embedding", "chunked-dense")


def io_dirs():
    inp = Path(os.environ.get("CYTO_INPUTS_DIR", "/inputs"))
    out = Path(os.environ.get("CYTO_OUTPUTS_DIR", "/outputs"))
    out.mkdir(parents=True, exist_ok=True)
    return inp, out


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except (FileNotFoundError, ValueError):
        return {} if default is None else default


def load_inputs_index(inputs_dir):
    """``slot → [host path, …]``, in DECLARATION ORDER.

    A slot may repeat: `matrices` is a LIST (DEC-6), and the frontend pushes one
    ``{slot, artifactId}`` binding per selected artifact under the SAME slot name, so
    `inputs.json` carries several entries sharing one `slot`. Keying a plain dict by
    slot silently kept only the last of them.

    ``sandbox_path`` is the IN-SANDBOX bind target (`/inputs/<sub>`); only the subpath
    is used, so the same index resolves off-sandbox where `CYTO_INPUTS_DIR` points
    somewhere else entirely.
    """
    idx = read_json(inputs_dir / "inputs.json", {"inputs": []})
    slots = {}
    for e in idx.get("inputs", []):
        slot = e.get("slot")
        if not slot:
            continue
        sp_path = e.get("sandbox_path", "") or ""
        sub = sp_path[len("/inputs/") :] if sp_path.startswith("/inputs/") else Path(sp_path).name
        if not sub:
            continue
        slots.setdefault(str(slot), []).append(inputs_dir / sub)
    return slots


def slot_paths(slots, *names):
    """Every existing path bound to the FIRST of `names` that has one — **by SLOT
    ONLY** (ITEM-24).

    The three fallbacks this replaces each resolved an input the caller never named:
    (1) preferred slot names, then (2) *any* slot at all, then (3) a filename GLOB
    (`*.h5ad`, `*.h5`, `matrix.mtx*`, …). (2) handed the matrix reader whatever
    happened to be mounted first; (3) reached back to an era when the input was an
    uploaded AnnData rather than an artifact, and would happily pick up a stray file
    the run never declared. `inputs.json` maps slot → path and is the whole contract.

    Several `names` are still accepted, but they are SLOT names (a rename alias), never
    filename patterns.
    """
    for name in names:
        found = [Path(p) for p in slots.get(name, []) if Path(p).exists()]
        if found:
            return found
    return []


def slot_path(slots, *names):
    """The single path bound to the first present slot of `names`, else ``None``."""
    found = slot_paths(slots, *names)
    return found[0] if found else None


def require_distinct_mounts(paths, slot):
    """Refuse a LIST slot whose bindings landed on the SAME mount.

    A seam with the runner's mount naming (ITEM-23), now DEFENSIVE rather than live.

    STILL TRUE, and it is the fact every multi-binding compute must plan around:
    `derive_artifact_mount_name(slot, structure)` is a pure function of the SLOT and the
    store encoding — no artifact, dataset or content identity enters it — so a mount name
    carries no identity and a compute may never read one as though it did.

    NO LONGER TRUE: "the second stage overwrites the first, and `inputs.json` records
    several entries with an identical `sandbox_path`". `inputs.rs::unique_mount_name` is
    applied on the artifact path (`inputs.rs:275`) and disambiguates deterministically —
    `matrices.zarr`, `matrices_1.zarr` — so two bindings of one slot land in DISTINCT
    mounts and the collision below cannot occur today. Measured, after this docstring was
    cited as precedent by another package and the claim did not survive checking.

    The guard is kept because it is cheap and it fails loudly if that disambiguation ever
    regresses; it is no longer describing a reachable state. Its companion fact — that
    assignment is a function of BINDING ORDER, which is why identity must be relayed
    positionally (`params.matrix_modalities`) rather than read off a name — is the part
    that still governs.

    The compute cannot fix the naming. It can refuse to answer, which is the difference
    between a bug report and a corrupt column.
    """
    seen, collided = set(), set()
    for p in paths:
        key = str(Path(p).resolve())
        if key in seen:
            collided.add(Path(p).name)
        seen.add(key)
    if collided:
        fail(
            f"{len(paths)} inputs are bound to slot {slot!r} but they collide on "
            f"{sorted(collided)} — several bindings were staged at ONE mount, so the "
            "later one overwrote the earlier. Refusing rather than reading the same "
            "artifact several times under different names"
        )
    return paths


def require_paired_gene_names(gene_name_paths, matrix_paths, qc_metrics):
    """Refuse a ``gene_names`` list that cannot be paired one-to-one with ``matrices``.

    A metric is a question about gene NAMES, and it is asked of every bound matrix
    (the metric list is run-wide — a metric is not scoped to one modality; the modality only
    decides the emitted column's PREFIX). So `k` gene-name artifacts for `n` matrices answers
    the question for `k` of them and leaves `n - k` unanswerable.

    The two answers that were tried before this, in order, were both silent:

      1. match against ``adata.var_names`` — the hardcoded axis index. On a CELLxGENE dataset
         that index is ENSEMBL while the symbols live in a separate column, so ``^MT-``
         matched nothing and ``pct_mito`` came out **0 with no error**.
      2. drop the metric with a warning recorded in ``obs.json``. Better — 0 % and "not
         computed" are different claims — but the warning is inside the artifact, not on the
         path to the screen, so the visible result is still a metric the caller selected and
         did not get.

    The only answer that cannot be misread is refusing, so this names the slot and both
    counts.

    `0` is allowed exactly when NO metric was selected — i.e. a run that emits nothing.
    That escape used to cover the builtins-only run (``total_counts`` /
    ``n_genes_by_counts`` were computed directly, so they asked no gene-name question);
    with the builtin special case deleted those are ordinary ``.*`` gene-set rows, so a
    run that emits ANY column now needs gene names. That is a real change in what a run
    requires, and it is stated rather than papered over: the alternative was to special-
    case ``.*`` as "needs no names", which is a hidden rule about one pattern VALUE — the
    same shape of invisible decision this whole change removes.
    """
    n, k = len(matrix_paths), len(gene_name_paths)
    if k == n:
        return
    if k == 0 and not qc_metrics:
        return
    names = ", ".join(repr(m["name"]) for m in qc_metrics) or "(none)"
    fail(
        f"the `gene_names` slot has {k} binding(s) for {n} matrix input(s) — they are "
        "list-ALIGNED (entry i supplies the gene-name values for matrices[i]), so the "
        f"metric(s) {names} cannot be computed for every matrix. Bind one "
        "`gene_names` artifact per `matrices` binding, in the same order"
    )


def params(inputs_dir):
    return read_json(inputs_dir / "params.json", {})


def fail(message, code=2):
    """Exit with a diagnostic the runner surfaces. Prefixed so a caller (and the test
    harness) can tell OUR message from a library traceback that merely mentions a path."""
    print(f"qc-10x: {message}", file=sys.stderr, flush=True)
    sys.exit(code)


_PROGRESS_FD = [-1]  # persistent FIFO write fd (index 0), lazily opened


def progress(phase, pct=None, message=None):
    parts = [str(phase)]
    if pct is not None:
        parts.append(str(int(pct)))
    if message is not None:
        if pct is None:
            parts.append("")
        parts.append(str(message))
    line = "|".join(parts)
    fifo = os.environ.get("CYTO_PROGRESS_FIFO")
    if fifo:
        # Persistent write fd: opened once, reused, closed at process exit — one
        # continuous stream to the runner's FIFO drain (streaming.rs), no per-frame
        # reopen churn. Retry the open if the reader was not ready on frame 1.
        if _PROGRESS_FD[0] < 0:
            try:
                _PROGRESS_FD[0] = os.open(fifo, os.O_WRONLY | os.O_NONBLOCK)
            except OSError:
                _PROGRESS_FD[0] = -1
        if _PROGRESS_FD[0] >= 0:
            try:
                os.write(_PROGRESS_FD[0], (line + "\n").encode())
            except OSError:
                try:
                    os.close(_PROGRESS_FD[0])
                except OSError:
                    pass
                _PROGRESS_FD[0] = -1
    print("progress:", line, file=sys.stderr, flush=True)


#: The `(datatype, layout)` this package emits its run-environment record as (#80).
#: Declared here because the package knows its own output type; the shared recorder
#: in `_lib` is app-core and may not name a contributed domain's vocabulary.
DT_RUN_ENVIRONMENT = ("report/qc", "opaque")


def write_manifest(outputs_dir, entries):
    # #80 — append this run's ENVIRONMENT RECORD (the resolved version of every library
    # this entry declares) before the manifest is written, and refuse the run if the
    # environment does not satisfy the declaration. Placed here, on the one path every
    # successful run takes, so recording is structural rather than remembered: a compute
    # cannot emit its outputs without also emitting what produced them.
    # The datatype is THIS package's, passed in: `cyto_deps` is app-core and may not
    # name a contributed domain's vocabulary, so the caller supplies the pair.
    cyto_deps.augment(outputs_dir, entries, DT_RUN_ENVIRONMENT)
    (outputs_dir / "manifest.json").write_text(json.dumps({"outputs": entries}, indent=2))


def output_entry(id, datatype_layout, path, role, *, structure, meta=None):
    """One `/outputs/manifest.json` entry. `structure` (HOW to decode the bytes) and
    `meta` (what they MEAN) are producer declarations with NO default on either side of
    the wire — artifact-model ITEM-5/6 — so both are named at every call site."""
    dt, layout = datatype_layout
    return {"id": id, "datatype": dt, "path": path, "layout": layout, "role": role,
            "structure": structure, "meta": meta}





def sanitize(name):
    keep = "".join(c if (c.isalnum() or c in "-_.") else "_" for c in str(name))
    return keep or "col"


# ───────────────────────── configurable QC metrics (ITEM-13/18) ───────────────
#
# EVERY metric row is the same shape: a NAME, a gene SET (a regex over gene names), and an
# AGGREGATION. There is no privileged subset and no second parse path.
#
# `total_counts` / `n_genes_by_counts` used to be a special case: name-matched against a
# hardcoded `BUILTIN_METRIC_NAMES`, carrying no pattern, uneditable, with their own
# `parse_builtin_metrics` and their own UI treatment. They are ordinary rows now — `sum`
# over all genes and `count` over all genes — so a user can remove them, rename them, or
# narrow them to a gene set, none of which was possible before. The constant and the parse
# path are deleted rather than kept "for compatibility": a second way to say the same thing
# is what let the aggregation stay invisible in the first place.

# The CLOSED aggregation vocabulary. Each entry is a COMPLETE definition INCLUDING its
# denominator — there is deliberately no separate "as a percentage" flag, because a shared
# flag would imply ONE denominator and each reducer's natural percentage has a different
# one (sum → % of the cell's total counts; count → % of the genes IN THE SET detected;
# mean → nothing coherent). A flat vocabulary of four makes no meaningless combination
# expressible.
#
#     sum[c]        = Σ_{g∈set} X[c,g]
#     mean[c]       = Σ_{g∈set} X[c,g] / |set|            ← DEC-2: |set|, NOT |detected|
#     count[c]      = |{ g∈set : X[c,g] > 0 }|
#     percentage[c] = 100 · Σ_{g∈set} X[c,g] / Σ_{all g} X[c,g]
#
# MEDIAN is deliberately EXCLUDED: a per-cell median over a gene subset needs the values
# grouped per cell, which is a different algorithm and a real cost at 35k genes. All four
# above are one weighted `bincount` pass over the CSC trio. Adding median later is a
# separate decision, not an omission.
AGGREGATIONS = ("sum", "mean", "count", "percentage")

# The default metric set. Two gene-set rows over ALL genes (what the deleted builtins were)
# plus the two species-sensitive percentage presets. Both patterns cover human (upper-case)
# AND mouse (`Mt-`/`Rp[sl]…`) nomenclature: mouse ribosomal genes are `Rps12`/`Rpl13`, so a
# human-only `^RP[SL]` would silently report 0% ribo on a mouse dataset (a coverage
# regression). Bare ribosomal symbols carry no separator, so an `^RPS-|^RPL-` form (which
# misses `RPS12`/`RPL13`) is deliberately NOT used.
#
# The NAMES are the emitted column names verbatim (DEC-1), so the familiar `pct_mito` /
# `pct_ribo` / `total_counts` / `n_genes` still appear — stated by the row rather than
# assembled by a decoration rule the user would have to learn.
#
# Mirrors the view's `const.defaultMetrics`; this copy exists for a different boundary
# (`params.json` may omit the key).
DEFAULT_QC_METRICS = [
    {"name": "total_counts", "pattern": r".*", "aggregation": "sum"},
    {"name": "n_genes", "pattern": r".*", "aggregation": "count"},
    {"name": "pct_mito", "pattern": r"^MT-|^mt-", "aggregation": "percentage"},
    {"name": "pct_ribo", "pattern": r"^(RP[SL]|Rp[sl])", "aggregation": "percentage"},
]

# DEC-13: a user-supplied regex over gene names is DATA applied server-side (a match
# over short gene symbols + a column sum — no code execution). ReDoS is the only real
# risk. The guarantees we actually provide are: (1) a hard length cap, (2) a compile
# (validity) check, and (3) a conservative REJECT of the nested-unbounded-quantifier
# family (`(a+)+` / `(.*)*` / …) — the shapes that drive catastrophic backtracking.
# This is a heuristic, NOT a proof of linear-time matching; `re.match` is anchored at
# the start but CAN still backtrack catastrophically, so we over-reject the known
# dangerous shapes rather than rely on any "anchored can't backtrack" claim.
MAX_PATTERN_LEN = 256


class MissingGenePattern(ValueError):
    """A PATTERN metric entry carries NO gene regex, so there is no question to ask.

    Distinguished from the plain ``ValueError`` the other pattern violations raise
    because the two deserve OPPOSITE severities, and collapsing them is what produced
    a silent wrong answer:

      * absent / empty pattern — the entry is not a well-formed metric at all. It used
        to be defaulted to ``""`` and compiled, and ``re.compile("").match(g)`` matches
        EVERY gene, so the emitted ``pct_<name>`` column read ~100 % on every cell with
        no warning anywhere. FATAL: this is the same class ``require_paired_gene_names``
        already refuses ("the only answer that cannot be misread is refusing").
      * present but REJECTED pattern (oversized / invalid / ReDoS-shaped, DEC-13) — a
        well-formed entry whose VALUE the compute declines and can name. Recorded as a
        per-metric warning and skipped; never fatal.

    Subclasses ``ValueError`` so an existing ``except ValueError`` around these helpers
    still catches it.
    """


class InvalidAggregation(ValueError):
    """A metric row's ``aggregation`` is absent, or outside the closed set of four.

    FATAL, and specifically NOT defaulted to ``percentage`` for compatibility with rows
    written before the column existed. A silent default is exactly how the invisible
    aggregation arose: every row meant ``100 × Σ(set) / total`` and nothing on the path to
    the screen said so, which is why ``pct_mito = 0`` could mean either "no mitochondrial
    reads" or "the regex matched nothing". Re-introducing the default under the banner of
    migration would re-introduce the defect it is here to remove.

    Same severity argument as ``MissingGenePattern`` and ``require_paired_gene_names``: the
    caller asked for a number whose DEFINITION the compute cannot determine, and both
    alternative answers (guess one, or drop the column) are unreadable downstream.

    Subclasses ``ValueError`` for the same reason ``MissingGenePattern`` does.
    """


class DuplicateMetricName(ValueError):
    """Two metric rows share a NAME, so they would write ONE column labelled as two.

    The name IS the emitted column name (DEC-1), so this is the same class of collision
    ``modality_keys`` already refuses for two matrices sharing a modality key. It used to
    de-dup silently to the first occurrence — tolerable when the name was only a stem the
    compute decorated, and not tolerable now: the dropped row may be the one whose
    aggregation the caller actually wanted.
    """


def _has_nested_unbounded_quantifier(pat):
    """Conservative ReDoS heuristic: True iff an unbounded quantifier (`*`/`+`/`{m,}`/a
    `{m,n}` range) is applied to a group whose OWN body already contains an unbounded
    quantifier — the `(a+)+` / `(a*)*` / `(.*)+` catastrophic-backtracking family.
    Escapes (`\\+`) and character classes (`[*+]`) are skipped so they don't
    false-positive. Deliberately conservative (may over-reject); never under-rejects
    the nested-quantifier shape."""
    def _quant_at(j):
        # (is_unbounded, index_after_the_quantifier) for a quantifier starting at j.
        if j >= len(pat):
            return False, j
        ch = pat[j]
        if ch in "*+":
            return True, j + 1
        if ch == "?":
            return False, j + 1
        if ch == "{":
            k = pat.find("}", j)
            if k == -1:
                return False, j + 1
            spec = pat[j + 1:k]
            # `{m,}` (open) or any `{m,n}` range multiplies work → treat as unbounded.
            return ("," in spec), k + 1
        return False, j

    body_has_quant = []  # per open group: does its body contain an unbounded quantifier?
    i, n = 0, len(pat)
    while i < n:
        c = pat[i]
        if c == "\\":
            i += 2
            continue
        if c == "[":  # skip a char class wholesale
            i += 1
            while i < n and pat[i] != "]":
                i += 2 if pat[i] == "\\" else 1
            i += 1
            continue
        if c == "(":
            body_has_quant.append(False)
            i += 1
            continue
        if c == ")":
            inner = body_has_quant.pop() if body_has_quant else False
            is_unbounded, nxt = _quant_at(i + 1)
            if inner and is_unbounded:
                return True
            # a quantified group itself acts as an unbounded quantifier in its parent.
            if body_has_quant and is_unbounded:
                body_has_quant[-1] = True
            i = nxt
            continue
        if c in "*+":
            if body_has_quant:
                body_has_quant[-1] = True
            i += 1
            continue
        if c == "{":
            is_unbounded, nxt = _quant_at(i)
            if body_has_quant and is_unbounded:
                body_has_quant[-1] = True
            i = nxt
            continue
        i += 1
    return False


def compile_gene_pattern(pattern, name):
    """Validate a user-supplied gene-name regex (DEC-13): PRESENCE + length cap +
    compile check + a conservative reject of the nested-unbounded-quantifier ReDoS
    family. Returns the validated pattern string.

    Raises ``MissingGenePattern`` when the pattern is absent or empty — the caller
    treats that as FATAL. Raises plain ``ValueError`` for a present-but-rejected
    pattern; the caller records THAT as a per-metric warning and skips the metric,
    never aborting the run. See ``MissingGenePattern`` for why the two differ.

    There is deliberately NO default. ``m.get("pattern", "")`` was the whole defect:
    ``""`` compiles cleanly, passes the ReDoS heuristic, and then matches every gene."""
    import re

    pat = str(pattern or "")
    if not pat:
        raise MissingGenePattern(
            f"qc metric '{name}': no gene pattern. A metric with no pattern is not a "
            "metric — the empty regex matches EVERY gene, so the column would report "
            "~100 % on every cell, which is a number and not an answer. Give the "
            "metric a gene regex, or remove the row"
        )
    if len(pat) > MAX_PATTERN_LEN:
        raise ValueError(f"qc metric '{name}': pattern exceeds {MAX_PATTERN_LEN} chars")
    try:
        re.compile(pat)
    except re.error as e:
        raise ValueError(f"qc metric '{name}': invalid regex ({e})")
    if _has_nested_unbounded_quantifier(pat):
        raise ValueError(
            f"qc metric '{name}': pattern rejected — nested unbounded quantifier "
            "(catastrophic-backtracking / ReDoS risk)"
        )
    return pat


def parse_aggregation(value, name):
    """Validate a metric row's ``aggregation`` against the closed set (DEC-4).

    Raises ``InvalidAggregation`` — naming the row AND the four accepted values — when the
    key is absent, empty, or not one of them. There is deliberately NO default and NO
    case-folding: `SUM` is a different string from `sum`, and quietly accepting it would be
    the first step back toward a vocabulary the compute guesses at.
    """
    agg = value if isinstance(value, str) else None
    if agg in AGGREGATIONS:
        return agg
    accepted = ", ".join(AGGREGATIONS)
    got = "no aggregation" if value in (None, "") else f"aggregation {value!r}"
    raise InvalidAggregation(
        f"qc metric '{name}': {got}. Every metric states how its gene set is reduced to one "
        f"number per cell — one of: {accepted}. There is no default: the aggregation used to "
        "be an unstated 'percentage of total counts' on every row, which is why a 0 could "
        "mean either 'no reads' or 'the regex matched nothing'. Choose one for this row"
    )


def parse_qc_metrics(p, warnings=None):
    """Normalize `params.json` `qc_metrics` into a list of `{name, pattern, aggregation}`
    metrics, defaulting to `DEFAULT_QC_METRICS`.

    There is ONE row shape — no builtin/pattern split, no second parse path. Each row is
    checked on three axes:

      * `pattern` — PRESENCE-checked + length-capped + compile-checked + ReDoS-guarded
        (DEC-13). An invalid / oversized / dangerous pattern is SKIPPED with a recorded
        warning (the entry is well-formed; the compute declines its VALUE and can name
        why); an ABSENT one raises ``MissingGenePattern``, which is fatal.
      * `aggregation` — validated against the closed set; absent or unknown raises
        ``InvalidAggregation`` (DEC-4). Fatal, never defaulted.
      * `name` — the emitted column name verbatim (DEC-1), so a repeat raises
        ``DuplicateMetricName`` rather than silently dropping the later row.

    A malformed entry (not an object at all) is still skipped with a warning: there is no
    row to name, so there is nothing to refuse on behalf of.
    """
    raw = p.get("qc_metrics") or DEFAULT_QC_METRICS
    if not isinstance(raw, list):
        if warnings is not None:
            warnings.append(f"qc_metrics is not a list ({type(raw).__name__}); using defaults")
        raw = DEFAULT_QC_METRICS
    out, seen = [], set()
    for m in raw:
        if not isinstance(m, dict):
            if warnings is not None:
                warnings.append(f"qc metric entry {m!r} is not an object; skipped")
            continue
        name = sanitize(m.get("name") or "metric")
        if name in seen:
            raise DuplicateMetricName(
                f"qc metric '{name}': two metric rows carry this name. The name IS the emitted "
                "column name, so the second row would overwrite the first — one column labelled "
                "as two. Rename one of them"
            )
        seen.add(name)
        aggregation = parse_aggregation(m.get("aggregation"), name)
        try:
            pat = compile_gene_pattern(m.get("pattern"), name)
        except MissingGenePattern:
            # NOT a warning: propagate. Ordered before the `ValueError` clause because
            # it IS a ValueError — Python takes the first matching handler.
            raise
        except ValueError as e:
            if warnings is not None:
                warnings.append(str(e))
            continue
        out.append({"name": name, "pattern": pat, "aggregation": aggregation})
    return out


# ───────────────────────────── qc-specific helpers ────────────────────────────

def distribution(values, bins=50):
    v = np.asarray(values, dtype=float)
    v = v[~np.isnan(v)]
    if v.size == 0:
        return {"n": 0, "counts": [], "bin_edges": [], "median": None, "mean": None, "min": None, "max": None}
    counts, edges = np.histogram(v, bins=bins)
    return {
        "n": int(v.size),
        "counts": [int(x) for x in counts.tolist()],
        "bin_edges": [float(x) for x in edges.tolist()],
        "median": float(np.median(v)),
        "mean": float(np.mean(v)),
        "min": float(v.min()),
        "max": float(v.max()),
        "q25": float(np.percentile(v, 25)),
        "q75": float(np.percentile(v, 75)),
    }


# ─────────────── reading the ARTIFACTS (format from the declaration) ──────────
#
# A staged artifact says what it is. A `cyto_zarr` store stamps the producer-declared
# `structure` into its group `zarr.json` under `attributes.cyto` — `{"encoding":
# "zarr_v3", "kind": "sparse_csc", "axes": ["cells","genes"], "shape": […], …}` for a
# matrix, `{"kind": "table", "axis": …, "columns": […]}` for a column. That declaration
# is the format contract; a filename is not.


def artifact_structure(path):
    """The producer-DECLARED `structure` of a staged artifact, or ``None`` when the path
    is not a `cyto_zarr` store."""
    meta = Path(path) / "zarr.json"
    if not meta.is_file():
        return None
    try:
        doc = json.loads(meta.read_text())
    except (OSError, ValueError):
        return None
    cyto = (doc.get("attributes") or {}).get("cyto")
    return cyto if isinstance(cyto, dict) else None


def read_matrix(path, slot):
    """A count matrix input → ``(structure, indptr, indices, data)``.

    The ONLY accepted encoding is what the importer emits for the expression family: a
    CSC Zarr store. `kind` comes from the store's OWN declaration — never from the
    mount name — and anything else is refused BY NAME rather than guessed at.
    """
    import cyto_csc

    path = Path(path)
    structure = artifact_structure(path)
    if structure is None:
        fail(
            f"input on slot {slot!r} at {path.name!r} carries no `structure` declaration "
            "in a group `zarr.json` — it is not a cyto_zarr artifact. A "
            "`single-cell/expression` artifact is a multifile CSC Zarr store"
        )
    kind = structure.get("kind")
    if kind != "sparse_csc":
        fail(
            f"input on slot {slot!r} at {path.name!r} declares kind {kind!r}; qc reads a "
            "`sparse_csc` count matrix"
        )
    shape = structure.get("shape") or []
    if len(shape) != 2:
        fail(f"input on slot {slot!r} declares no 2-D shape (got {shape!r})")
    indptr, indices, data = cyto_csc.read_csc(path)
    n_cells = int(shape[0])
    if indices.size and int(np.asarray(indices).max()) >= n_cells:
        fail(
            f"input on slot {slot!r} stores a row index past its declared "
            f"{n_cells}-entry cells axis"
        )
    return structure, np.asarray(indptr), np.asarray(indices), np.asarray(data)


def read_column_values(path, slot):
    """A column artifact input → its VALUES as a list of `str`.

    Which member holds them is the producer's declaration (`structure.key`, else the
    single declared column, else the conventional `values`) — the same rule
    `annotation_integrate.load_axis_index` applies to an axis index.
    """
    import cyto_zarr_read

    path = Path(path)
    structure = artifact_structure(path)
    if structure is None:
        fail(
            f"input on slot {slot!r} at {path.name!r} carries no `structure` declaration "
            "in a group `zarr.json` — it is not a cyto_zarr column artifact"
        )
    member = structure.get("key")
    if not member:
        columns = structure.get("columns") or []
        if len(columns) == 1 and isinstance(columns[0], dict):
            member = columns[0].get("path")
    member = member or "values"
    values = cyto_zarr_read.read_column(path, member)
    if hasattr(values, "tolist"):
        values = values.tolist()
    return [("" if v is None else str(v)) for v in values]


# ───────────────── the metric kernels, computed off the CSC store ─────────────
#
# There is no AnnData any more, so `sc.pp.calculate_qc_metrics` has nothing to take. Every
# quantity is computed here directly from the CSC trio.
#
# `indices` holds the ROW (cell) id of each stored value and `indptr` cuts them by
# COLUMN (gene), so each reducer is one weighted `bincount` over the columns the metric's
# regex flagged — the same cost for all four, and the reason median is not among them.
#
# A CSC store holds AT MOST ONE entry per (cell, gene), so counting the stored POSITIVE
# entries in a column set counts the DETECTED GENES of that set. That equivalence is what
# lets `count` be a `bincount` rather than a per-cell grouping.


def csc_total_counts(n_cells, indices, data):
    """Σ over ALL genes, per cell — the `percentage` DENOMINATOR.

    Not itself a metric any more: `total_counts` is now an ordinary `sum` row over `.*`
    (and `test_aggregation.py` pins that the two agree). It survives here because
    `percentage` needs the whole-cell total regardless of which genes the row selected.
    """
    return np.bincount(
        np.asarray(indices, dtype=np.intp), weights=np.asarray(data, dtype=float),
        minlength=n_cells,
    )[:n_cells]


def csc_counts_on_columns(n_cells, indptr, indices, data, columns):
    """Σ of the stored values in the given COLUMN set, per cell (`sum`)."""
    out = np.zeros(n_cells, dtype=float)
    for j in columns:
        lo, hi = int(indptr[j]), int(indptr[j + 1])
        if hi <= lo:
            continue
        out += np.bincount(
            np.asarray(indices[lo:hi], dtype=np.intp),
            weights=np.asarray(data[lo:hi], dtype=float),
            minlength=n_cells,
        )[:n_cells]
    return out


def csc_genes_detected_on_columns(n_cells, indptr, indices, data, columns):
    """|{ g ∈ set : X[c,g] > 0 }| per cell (`count`).

    Counts the POSITIVE stored entries rather than all stored entries: a store that kept an
    explicit zero (`eliminate_zeros` is the writer's choice, not a guarantee of the format)
    would otherwise report a gene as detected because a zero was written down for it.
    """
    out = np.zeros(n_cells, dtype=float)
    for j in columns:
        lo, hi = int(indptr[j]), int(indptr[j + 1])
        if hi <= lo:
            continue
        seg_idx = np.asarray(indices[lo:hi], dtype=np.intp)
        positive = np.asarray(data[lo:hi], dtype=float) > 0
        if not positive.any():
            continue
        out += np.bincount(seg_idx[positive], minlength=n_cells)[:n_cells]
    return out


def pct_of_total(on_set, total):
    with np.errstate(divide="ignore", invalid="ignore"):
        pct = np.where(total > 0, 100.0 * on_set / total, 0.0)
    return np.nan_to_num(pct, nan=0.0, posinf=0.0, neginf=0.0)


def mean_over_set(on_set, set_size):
    """Σ_{g∈set} X[c,g] / |set| — DEC-2.

    The denominator is the SIZE OF THE SET, not the number of genes detected in it, so an
    undetected gene contributes a zero to the mean rather than being dropped from it: "the
    mean expression of my housekeeping set" conventionally includes the zeros, a gene that
    is off being information rather than a missing value. The other reading is expressible
    from two rows (`sum` ÷ `count`); this one is not recoverable from that pair, because no
    emitted column carries |set|.

    An EMPTY set (a regex that matched no gene) divides by zero. It yields 0 rather than
    `nan` — the same choice `pct_of_total` makes for a zero-count cell, and for the same
    reason: a `nan` column is unplottable and unfilterable, so it is a worse answer than 0
    for a set that is genuinely empty. The empty match is separately WARNED about
    (`pattern matched 0 genes`), which is where "the set is empty" is actually said.
    """
    if set_size <= 0:
        return np.zeros_like(np.asarray(on_set, dtype=float))
    return np.asarray(on_set, dtype=float) / float(set_size)


def reduce_gene_set(aggregation, *, n_cells, indptr, indices, data, columns, total):
    """Apply ONE of the four aggregations to a metric's gene-column set.

    `aggregation` has already been validated against `AGGREGATIONS` by `parse_aggregation`,
    so the trailing raise is unreachable from `main` — it is the guard that keeps a future
    fifth vocabulary entry from silently reaching here with no kernel behind it.
    """
    if aggregation == "count":
        return csc_genes_detected_on_columns(n_cells, indptr, indices, data, columns)
    on_set = csc_counts_on_columns(n_cells, indptr, indices, data, columns)
    if aggregation == "sum":
        return on_set
    if aggregation == "mean":
        return mean_over_set(on_set, len(columns))
    if aggregation == "percentage":
        return pct_of_total(on_set, total)
    raise InvalidAggregation(f"no kernel for aggregation {aggregation!r}")


# ───────────────────────────── the modality PREFIX ────────────────────────────


def modality_keys(p, matrix_paths, warnings):
    """One column PREFIX key per matrix, in SLOT ORDER — an OPEN set (INV-6).

    The source of truth is each matrix artifact's ``meta.modality``, stamped by the
    importer (DEC-7): `classify_feature_type` is open by construction ("an unrecognized
    feature type maps to a sanitized modality of its own — NEVER dropped, NEVER folded
    into RNA"), so the key may be `rna`/`prot`/`hto`/`atac`/`crispr` or any sanitized
    string. Nothing here enumerates them, and deriving one from `datatype` would be
    wrong anyway — `hto`/`crispr`/`custom` all share `single-cell/modality`.

    Two channels carry that one fact, in precedence order:

      1. the artifact's OWN declaration (`structure.modality`), if a producer stamps
         one — a thing that states a fact about itself always beats a relay of it;
      2. ``params.matrix_modalities``, positionally aligned with the `matrices` slot
         list the launcher passed. This relay exists because `meta` is a CATALOG column:
         `/inputs/inputs.json` carries `{slot, kind, content_hash, sandbox_path}` and
         nothing else, so the artifact's `meta` is not staged into the sandbox and the
         launcher — which does hold it — forwards it.

    A single-matrix run may also carry the legacy scalar ``params.modality``.

    An UNKNOWN key is never guessed. With one matrix it simply means no prefix (the
    pre-multimodal behaviour, byte-identical); with several it is fatal, because two
    unprefixed matrices would write colliding column names onto the shared cells axis.
    """
    n = len(matrix_paths)
    relayed = p.get("matrix_modalities")
    if not isinstance(relayed, (list, tuple)):
        relayed = []
    legacy = p.get("modality")

    keys = []
    for i, path in enumerate(matrix_paths):
        declared = (artifact_structure(path) or {}).get("modality")
        candidate = declared
        if not candidate and i < len(relayed):
            candidate = relayed[i]
        if not candidate and n == 1 and isinstance(legacy, str):
            candidate = legacy
        if isinstance(candidate, str) and candidate.strip():
            keys.append(sanitize(candidate.strip()))
        else:
            keys.append(None)

    if n > 1 and any(k is None for k in keys):
        fail(
            "a multi-matrix run needs each matrix's `meta.modality` (the column prefix) — "
            "supply `params.matrix_modalities`, one entry per `matrices` binding, in the "
            f"order they were passed (got {relayed!r} for {n} matrices). Without it two "
            "matrices would write colliding column names onto the shared cells axis"
        )
    if n > 1 and len(set(keys)) != n:
        # Same class as a mount collision: two matrices sharing a prefix write the SAME
        # column names onto the shared cells axis, so the second silently replaces the
        # first. Refuse rather than emit one column labelled as two.
        fail(
            "two matrices share the modality key(s) "
            f"{sorted({k for k in keys if keys.count(k) > 1})} — their columns would "
            "collide on the shared cells axis; each `matrices` binding needs its own "
            "`meta.modality`"
        )
    return keys


# ───────────────────────────────── processor ─────────────────────────────────


def compute_matrix_metrics(path, slot_index, modality, gene_names_path,
                           qc_metrics, warnings):
    """Every selected metric for ONE matrix → ``(n_cells, n_genes, columns, matched)``.

    `columns` is an ordered list of ``(display_name, values)`` where `display_name`
    carries the modality prefix; `matched` maps the display metric name to the gene
    labels its pattern flagged.

    A metric needs gene-name VALUES to resolve its SET, and `require_paired_gene_names` has
    already refused the run if any matrix lacks them — so the guard below is DEFENSIVE, shadowed by
    that one rather than dead. Mutating it alone changes no test outcome (nothing can reach
    it while the caller's guard stands); removing BOTH restores the silent degrade, which is
    what makes it worth keeping.

    Neither a zero column nor a dropped column is an acceptable answer here: on a CELLxGENE
    dataset the genes axis is keyed by ENSEMBL ids while the symbols live in a separate
    genes-axis column, so `^MT-|^mt-` matched nothing and `pct_mito` came out 0 with no error
    at all — the defect this whole contract exists to remove.
    """
    import re

    label = f"matrices[{slot_index}]"
    structure, indptr, indices, data = read_matrix(path, label)
    n_cells, n_genes = int(structure["shape"][0]), int(structure["shape"][1])
    prefix = f"{modality}:" if modality else ""

    gene_names = None
    if gene_names_path is not None:
        gene_names = read_column_values(gene_names_path, f"gene_names[{slot_index}]")
        if len(gene_names) != n_genes:
            fail(
                f"the `gene_names` artifact bound to {label} holds {len(gene_names)} values "
                f"but the matrix declares {n_genes} genes — they are not the same axis"
            )

    total = csc_total_counts(n_cells, indices, data)
    columns, matched = [], {}

    for m in qc_metrics:
        name, pattern, aggregation = m["name"], m["pattern"], m["aggregation"]
        # DEC-1: the emitted column name is the metric's OWN name, verbatim (only the
        # per-matrix modality prefix is added). It used to be decorated (`pct_counts_<name>`),
        # which with four aggregations would have had to VARY by aggregation — a naming rule
        # the user has to learn in order to predict their own output, restated in every
        # consumer, free to drift. The `name` cell IS the column name.
        display = f"{prefix}{name}"
        if gene_names is None:
            fail(
                f"qc metric '{display}': no `gene_names` input is bound for {label}, so the "
                "gene set has no values to match against. Neither a zero column nor a silently "
                "omitted one is an answer to the question that was asked"
            )
        rx = re.compile(pattern)
        flag = np.array([rx.match(g) is not None for g in gene_names], dtype=bool)
        hits = [g for g, f in zip(gene_names, flag) if f]
        matched[display] = hits
        if not hits:
            warnings.append(f"qc metric '{display}': pattern matched 0 genes")
        columns.append((display, reduce_gene_set(
            aggregation, n_cells=n_cells, indptr=indptr, indices=indices, data=data,
            columns=np.where(flag)[0], total=total,
        )))

    return n_cells, n_genes, columns, matched


def main():
    """Annotate-only QC over EVERY matrix bound to the `matrices` slot.

    ONE job, all selected modality matrices (DEC-6): the cells axis is SHARED, so joint
    filtering (`rna:pct_mito` AND `prot:total_counts`) is only meaningful if one run
    writes them all onto it. Emits per-cell metric `metadata-column`s (+ a `report/qc`
    obs table). QC does NOT filter, split, or embed — the matrices are untouched;
    filtering is the downstream Cell-filter analysis. Metrics are per-run OPTIONAL and
    uniform (ITEM-18): ONE column per configured `qc_metrics` row, named by that row and
    reduced by that row's own `aggregation`.
    """
    inputs_dir, outputs_dir = io_dirs()
    p = params(inputs_dir)
    np.random.seed(int(p.get("seed", 0)))

    qc_warnings = []  # DEC-13: bad-pattern / 0-match notices — recorded, never fatal
    try:
        # [{name, pattern, aggregation}] — ONE row shape; defaults to DEFAULT_QC_METRICS.
        qc_metrics = parse_qc_metrics(p, qc_warnings)
    except (MissingGenePattern, InvalidAggregation, DuplicateMetricName) as e:
        # The three metric problems that are NOT warnings. Each names the offending row
        # and what to do; the run never reaches a column nobody should trust — a ~100 %
        # one (no pattern), one whose definition the compute guessed (no aggregation), or
        # one column labelled as two (a repeated name).
        fail(str(e))

    # ── resolve every input by SLOT (ITEM-24) ────────────────────────────────
    slots = load_inputs_index(inputs_dir)
    matrix_paths = slot_paths(slots, "matrices")
    if not matrix_paths:
        fail(
            "no input is bound to the required slot 'matrices'. `/inputs/inputs.json` "
            f"declares slot(s) {sorted(slots) or '[]'}; qc resolves by SLOT only — there "
            "is no filename fallback"
        )
    require_distinct_mounts(matrix_paths, "matrices")
    # List-aligned with `matrices`: entry i is the gene-name artifact for matrix i. A list
    # that cannot be paired one-to-one is FATAL rather than partially answered.
    gene_name_paths = require_distinct_mounts(slot_paths(slots, "gene_names"), "gene_names")
    require_paired_gene_names(gene_name_paths, matrix_paths, qc_metrics)
    cells_index_path = slot_path(slots, "cells_index")

    modalities = modality_keys(p, matrix_paths, qc_warnings)

    # ── one pass per matrix, onto the SHARED cells axis ──────────────────────
    emitted = []          # [(display_name, values)] in emission order
    matched_genes = {}    # display metric name → the gene labels it flagged
    n_cells = None
    per_matrix = []
    for i, path in enumerate(matrix_paths):
        pct = 10 + int(60 * i / max(1, len(matrix_paths)))
        progress("reading", pct, f"matrix {i + 1}/{len(matrix_paths)}")
        got_cells, got_genes, columns, matched = compute_matrix_metrics(
            path, i, modalities[i],
            gene_name_paths[i] if i < len(gene_name_paths) else None,
            qc_metrics, qc_warnings,
        )
        if n_cells is None:
            n_cells = got_cells
        elif got_cells != n_cells:
            fail(
                f"matrices[{i}] declares {got_cells} cells but matrices[0] declares "
                f"{n_cells} — a single run's matrices must share ONE cells axis (DEC-6)"
            )
        emitted.extend(columns)
        matched_genes.update(matched)
        per_matrix.append({
            "modality": modalities[i], "n_cells": got_cells, "n_genes": got_genes,
            "metrics": [display for display, _ in columns],
        })

    friendly_cols = [display for display, _ in emitted]
    if not friendly_cols:
        qc_warnings.append("no metrics selected — no metric columns emitted")

    # ── per-cell ids ─────────────────────────────────────────────────────────
    # The cells axis's own key artifact when the run bound one; otherwise the POSITION,
    # recorded as such (`id_source`) rather than passed off as a barcode. A CSC matrix
    # stores no labels — the axis keys are a separate artifact.
    if cells_index_path is not None:
        cell_ids = read_column_values(cells_index_path, "cells_index")
        if len(cell_ids) != n_cells:
            fail(
                f"the `cells_index` artifact holds {len(cell_ids)} keys but the matrices "
                f"declare {n_cells} cells — they are not the same axis"
            )
        id_source = "cells_index"
    else:
        cell_ids = [str(i) for i in range(n_cells)]
        id_source = "position"

    # /obs artifact (report/qc) — the per-cell metric table the UI reads.
    progress("obs", 72, "obs.json")
    obs_columns = {"id": cell_ids}
    for display, values in emitted:
        obs_columns[display] = [float(x) for x in np.asarray(values, dtype=float).tolist()]
    # Cap the per-metric matched-gene sample embedded in the served obs.json: a broad pattern can
    # match tens of thousands of symbols, bloating the artifact. The TRUE per-metric count is kept
    # in qc-report.json (`len(v)` below); obs.json carries a representative sample only.
    MATCHED_GENES_SAMPLE_CAP = 50
    matched_genes_sample = {k: v[:MATCHED_GENES_SAMPLE_CAP] for k, v in matched_genes.items()}
    (outputs_dir / "obs.json").write_text(json.dumps({
        "columns": ["id"] + friendly_cols,
        "n_cells": n_cells,
        "id_source": id_source,
        "obs": obs_columns,
        "matched_genes": matched_genes_sample,
        "matched_gene_counts": {k: len(v) for k, v in matched_genes.items()},
        "warnings": qc_warnings,
    }))
    entries = [output_entry(
        "qc-obs", DT_REPORT_QC, "obs.json", "artifact",
        structure=cyto_columns.opaque("application/json"),
        meta={"kind": "qc-obs", "n_cells": n_cells, "columns": ["id"] + friendly_cols},
    )]

    # Per-cell QC metric metadata-columns (ALL cells, input order). The filename
    # sanitizes the `:` in a modality-prefixed display name; the column `name` keeps
    # the prefixed display.
    progress("metadata", 86, "qc metric columns")
    import pandas as pd

    for display, values in emitted:
        rel = f"metadata/{sanitize(display)}.zarr"
        structure, meta = cyto_columns.write_metadata_column(
            outputs_dir, rel, display, pd.Series(np.asarray(values, dtype=float)),
            axis="cells")
        entries.append(output_entry(
            f"metadata-column:{display}", DT_METADATA_COLUMN, rel, "artifact",
            structure=structure, meta=meta))

    # qc report — per-metric distributions (pre-filter only; QC does not filter).
    progress("report", 94, "qc-report.json")
    (outputs_dir / "qc-report.json").write_text(json.dumps({
        "n_cells": n_cells,
        "n_genes": sum(m["n_genes"] for m in per_matrix),
        "matrices": per_matrix,
        # The modality keys this run actually used — an OPEN set read off the artifacts
        # (DEC-7/INV-6), never chosen from a list this file carries.
        "modalities": [m["modality"] for m in per_matrix],
        "metrics": {display: {"distribution": distribution(values)} for display, values in emitted},
        "matched_genes": {k: len(v) for k, v in matched_genes.items()},
        "warnings": qc_warnings,
    }, indent=2))
    entries.append(output_entry(
        "qc-report", DT_REPORT_QC, "qc-report.json", "artifact",
        structure=cyto_columns.opaque("application/json"),
        meta={"kind": "qc-report", "n_cells": n_cells,
              "n_genes": sum(m["n_genes"] for m in per_matrix)},
    ))

    write_manifest(outputs_dir, entries)
    progress("done", 100, f"{n_cells} cells, {len(friendly_cols)} metric columns, {len(entries)} outputs")
    print(
        f"qc-10x: annotated {n_cells} cells with {len(friendly_cols)} metric columns "
        f"across {len(matrix_paths)} matrix input(s)",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
