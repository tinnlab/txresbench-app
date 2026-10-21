#!/usr/bin/env python3
# ruff: noqa
"""cell-filter — CytoAnalyst sandbox compute processor (declarative-canvas-plots ITEM-25/27/33).

Reads the ``expression`` count-matrix ARTIFACT + a **criteria/threshold recipe** (min/max per
per-cell metric, or categorical keep-sets) and/or a **cell-set** (an explicit barcode
allow-list) and emits ONLY a per-cell boolean **keep-mask** metadata-column. NON-DESTRUCTIVE
(ITEM-25/27): it NEVER writes a filtered ``.h5ad``, an embedding, or a subset — "filtered"
is a read-time ``(matrix, mask)`` view. Each Run commits ONE immutable mask named by the
run's ``label``, VERBATIM (see ``mask_column_name`` — no ``keep_`` prefix, no slug);
re-runs coexist (provenance-immutable, never overwrite), so a repeated label is a real
collision and the FORM refuses it against the columns already on the axis.

  * ``metadata-column:<label>`` — the per-cell boolean keep-mask, obs-aligned over ALL
                       input cells (``true`` = kept), ``chunked-1d`` (role=artifact)
  * ``filter-report`` — the delta report (cells in→kept, per-metric removals,
                       criteria applied, mask column name) (role=artifact)

## The input contract (ITEM-24)

Every input is resolved by **SLOT** out of ``/inputs/inputs.json``. There is no
filename glob and no reader-by-suffix: the runner names each mount from the artifact
it is mounting (ITEM-23), and the FORMAT comes from the artifact's own ``structure``
declaration (a Zarr group's ``attributes.cyto``).

  * ``expression``     — REQUIRED. The count matrix: a multifile **CSC Zarr store**
                         (``kind: sparse_csc``), NOT an ``.h5ad``. It declares the
                         cells axis's LENGTH — which is the length of the mask this
                         run commits — and backs the on-the-fly legacy metrics.
  * ``column:<name>``  — 0..N. One obs column the criteria may reference. The SLOT
                         carries the column's name: a ``metadata-column`` store
                         declares ``kind: table`` and a member called ``values``,
                         never the column's display name (that lives in the catalog
                         row's ``meta``, which is not staged into the sandbox).
  * ``cells_index``    — OPTIONAL. The cells-axis key artifact (barcodes), for the
                         gate / cell-set paths. Absent ⇒ positional ids.
  * ``gene_names``     — OPTIONAL. Gene labels, for the legacy ``pct_counts_mt`` /
                         ``pct_counts_ribo`` on-the-fly metrics. Absent ⇒ those are a
                         typed SKIP, never a fabricated 0 %.
  * ``cells`` / ``cell-set`` / ``cell_set`` / ``cellset`` — OPTIONAL, unchanged: a
                         barcode allow-list FILE.

Deterministic on ``seed``: the threshold/cell-set filter is order-preserving and
pure; an optional seeded ``max_cells`` down-sample uses ``seed`` so the same seed
reproduces the same selection.

Params (``/inputs/params.json``): ``thresholds`` = a ``[{metric,min,max,sample?}, …]``
list OR the interactive per-sample map ``{criterion:{ident:[lo,hi]}}`` the
``filter.yaml`` view emits (or a ``predicate`` DSL
``{and:[{lt:[{col},x]},{gt:[{col},y]}]}``), ``criteria`` = the declarative
``ui/cell-filter.yaml`` Run's ``[{column,control,min?,max?,keep?}, …]`` recipe (it
drives the committed keep-mask AND, since filter-provenance ITEM-16, the report's
``thresholds`` so the report says what was filtered on), ``gate`` (a brushed cell-set — cell ids
or pre-filter obs positions) + ``gate_ids`` (the pre-filter ``id`` column that maps
those positions to barcodes), ``max_cells`` (optional seeded down-sample),
``mito_regex`` / ``ribo_regex`` (for on-the-fly metric computation when the input
lacks a metric column), ``seed``. Optional ``cells`` input slot = a cell-set (JSON
array / newline barcodes / metadata-column JSON). Roots overridable via
``CYTO_INPUTS_DIR`` / ``CYTO_OUTPUTS_DIR``. Progress → ``$CYTO_PROGRESS_FIFO``.
"""
import json
import math
import os
import re
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

# NOTE: scipy is imported LAZILY (inside `main`), not at module top, so the pure
# recipe helpers (`thresholds_from_params` / `resolve_gate` / `_gate_to_ids`) import
# with numpy alone — the sandbox runtime always ships scipy; the unit suite does not.

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

    A slot may legitimately repeat (a LIST slot), so the values are lists rather than a
    single path — keying a plain dict by slot silently kept only the last binding.

    ``sandbox_path`` is the IN-SANDBOX bind target (`/inputs/<sub>`); only the subpath is
    used, so the same index resolves off-sandbox where `CYTO_INPUTS_DIR` points elsewhere.
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
    """Every existing path bound to the FIRST of `names` that has one — **by SLOT ONLY**
    (ITEM-24).

    The three fallbacks this replaces each resolved an input the caller never named:
    preferred slot names, then a filename GLOB (`expression*.h5ad`, `*.h5ad`), then *any*
    slot at all. The glob is the one that mattered: it dates from when this processor's
    input was an uploaded AnnData, and it would read a stray `/inputs` file the run never
    declared. A `single-cell/expression` artifact is a multifile CSC Zarr store, so the
    suffix was never the format either. `inputs.json` maps slot → path and is the whole
    contract.
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


#: The slot-name PREFIX that binds one obs column the criteria may reference.
#: A `metadata-column` Zarr store declares `kind: table` and a member called `values` —
#: never the column's DISPLAY name (`pct_mito`), which lives in the catalog row's `meta`
#: and is not staged into the sandbox. So the name arrives with the BINDING: slot
#: `column:pct_mito`. Slot-carried, order-independent, and no second params channel to
#: fall out of step with the mounts.
COLUMN_SLOT_PREFIX = "column:"


def params(inputs_dir):
    return read_json(inputs_dir / "params.json", {})


def fail(message, code=2):
    """Exit with a diagnostic the runner surfaces. Prefixed so a caller (and the test
    harness) can tell OUR message from a library traceback that merely mentions a path."""
    print(f"cell-filter: {message}", file=sys.stderr, flush=True)
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


class BlankMaskLabel(ValueError):
    """The run was asked to commit a mask with no name. See `mask_column_name`."""


# The six ASCII whitespace characters `_trim_column` documents, reused here for the one
# question this module asks of them: is the label BLANK?
_LABEL_WS = " \t\n\r\f\v"


def mask_column_name(label):
    """The committed column IS the label, verbatim.

    ## Why there is no slug and no prefix any more

    This used to be `keep_column_name`: lowercase, `<`→`_lt_`, `>`→`_gt_`, every other
    non-alphanumeric run collapsed to `_`, the whole thing prefixed `keep_`, and an empty
    label defaulted to `keep_all`. So `Mito < 10%` committed as `keep_mito_10`, and the
    user was shown neither string. Three consequences, all of them why it is gone:

      * The user's answer was not the answer. A name they can read on the form is the
        only one they can then find in a downstream frame.
      * The collapse was LOSSY, so `abc-1`, `abc 1` and `abc_1` were one column. A form
        that checked the typed text for uniqueness would have passed all three.
      * The `keep_` prefix was quietly doing the NAMESPACING — it is what kept a label
        from colliding with the dataset's own obs columns. That job now belongs where it
        can actually be answered: the form's `require.not_in` against every column
        already declared on the cells axis this run writes to (`ui/cell-filter.yaml`).
        The compute cannot see that axis, so it never could have enforced it here.

    The `<`/`>` disambiguation the slug carried is not lost, it stopped being needed:
    `mito<10` and `mito>10` were only at risk of colliding because the collapse erased the
    operators. Verbatim they are simply two different strings.

    Identity also means there is no naming RULE left to keep two implementations of. The
    old docstring promised this mirrored a frontend `keepColumnName`; no such function
    ever existed, and the form now compares the typed text against the taken set directly,
    because the typed text is the name.

    ## The one thing it refuses

    A blank label. `keep_all` went with the prefix, and there is nothing to fall back to:
    a column must be called something, and picking that something on the user's behalf —
    for the run whose author gave it the least thought — is the silent behaviour this
    change removes. The FORM supplies a default and marks the field required, so a blank
    should never arrive; this is the boundary guard for the API/MCP callers that bypass it.

    Blankness is read with the SIX-character set, not python's `str.strip()`, and the
    property that matters is a CONTAINMENT: JS `String.trim()` (which is what the form's
    presence test uses) strips a superset, so every label refused here was refused by the
    form first. The form never declares a name valid and then has the run reject it."""
    name = "" if label is None else label if isinstance(label, str) else str(label)
    if name.strip(_LABEL_WS) == "":
        raise BlankMaskLabel(
            "the mask has no name: 'label' is blank. The committed column is named by the "
            "label, so name it (the form's Mask column name field, or the 'label' param)."
        )
    return name


def mask_path_component(name):
    """The mask artifact's FILENAME — one path segment, derived from but NOT equal to the
    column name. Same rule as `qc-10x.py::sanitize`, and kept local to each package for the
    same reason the packages are separate: a filename is a private detail of the run that
    wrote it, so the two copies have nothing to drift about (nothing reads either back by
    reconstructing it — consumers read the `path` off `/outputs/manifest.json`).

    It is REQUIRED, not cosmetic. `main` interpolates this into the output path, and the
    slug it replaces used to guarantee `[a-z0-9_]`; a verbatim name containing `/` (or being
    `..`) would otherwise write outside the artifact directory. The server's manifest reader
    refuses a traversing path, but only after the compute has already written the bytes."""
    safe = "".join(c if (c.isalnum() or c in "-_.") else "_" for c in str(name))
    # `.`/`..` are the two components that are legal characters and still not a NAME. The
    # `.zarr` suffix at the call site already disarms them; stripping is the direct answer,
    # so the guarantee does not depend on a suffix a future caller might drop.
    safe = safe.strip(".")
    return safe or "mask"


# The ONE decimal grammar every coercion in this feature accepts (mirrors
# `criteriaPredicate.ts::DECIMAL_BOUND` and `predicate_script::DECIMAL_BOUND`).
# Four parsers read the same bound — JS ``Number()``, this ``float()``, Rust
# ``parse::<f64>()`` and the narration — and their native accept-sets differ:
# ``"0x10"`` is 16 to JS and an error here; ``"inf"`` is +inf here and NaN to JS;
# ``"1_0"`` is 10.0 here and NaN to JS. Every difference is a case where the
# recorded predicate constrains something this mask did not (or vice versa), so all
# four are restricted to plain decimal notation and agree by construction.
# ``re.ASCII`` is load-bearing: Python's ``\d`` matches Unicode digits and ``float()``
# accepts them, while the JS regex and Rust's ``is_ascii_digit`` are ASCII-only. Without
# it a fullwidth / Arabic-Indic bound ("1 0" in fullwidth, Arabic-Indic digits -- what a
# CJK or Arabic IME emits for ordinary typing) constrained THIS mask while the recorded
# predicate omitted the criterion entirely, with no diagnostic. The explicit ``isascii``
# guard below is belt-and-braces for any spelling the pattern might still admit.
_DECIMAL_BOUND = re.compile(r"^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$", re.ASCII)


def _bound_or_none(x):
    """Coerce a criterion bound to a finite float or None (unbounded). An empty string / None /
    anything that is not plain decimal notation (an untouched or cleared control, or a spelling
    the other three parsers disagree about) is UNBOUNDED — never `float('')`."""
    if x is None:
        return None
    if isinstance(x, bool):
        return None  # a bool is not a bound (and `float(True)` would make it 1.0)
    if isinstance(x, (int, float)):
        v = float(x)
        return v if math.isfinite(v) else None
    if not isinstance(x, str) or not x.isascii():
        return None
    # Strip only the whitespace ALL THREE parsers strip. Python's ``str.strip()`` also
    # removes U+001C-U+001F and U+0085, which JS ``trim()`` / Rust ``str::trim()`` do
    # not agree on -- a third spelling that only one reader would accept.
    t = x.strip(" \t\n\r\f\v")
    if not _DECIMAL_BOUND.match(t):
        return None
    try:
        v = float(t)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


def _trim_column(name):
    """A criterion's obs COLUMN name, trimmed to the ONE canonical spelling.

    ROUND-4 (R3-64/R3-65): the SIX ASCII whitespace characters, NOT python's own
    ``str.strip()``. The three readers' native trims disagree on a column name exactly
    as they did on a cell -- python's ``str.strip()`` eats U+001C-U+001F and U+0085,
    JS ``trim()`` eats U+FEFF (the BOM Excel leaves on a CSV header) and not U+0085,
    Rust's ``str::trim()`` eats U+0085 and not U+001C-U+001F. So a padded column name
    resolved HERE (the filter ran) and was emitted by `predicate_script` as a different
    key whose absent column imposes NO constraint: the attested replay kept every cell
    the commit had filtered. The six-character intersection is the only set all three
    agree on natively -- and unlike the lenient CELL trim, keeping a name's exotic
    padding is the SAFE direction, because every reader then looks up the same
    unmodified obs key. Mirrored by `criteriaPredicate.ts::criterionColumn` and
    `predicate_script::emit_criteria_script`."""
    return name.strip(" \t\n\r\f\v") if isinstance(name, str) else name


# The ONE whitespace set every reader strips off an obs CELL before coercing it --
# mirrored VERBATIM by `predicate_script::CRITERIA_PRELUDE::_VALUE_WS` and
# `primitives.ts::VALUE_WS`. See `src-app/testdata/README-coercion-corpus.md`.
#
# ROUND-4 (R3-108): each reader used its own NATIVE trim, and the three native sets
# differ in BOTH directions -- JS ``trim()`` strips U+FEFF (BOM) and python's
# ``str.strip()`` does not; python strips U+0085 (NEL) and U+001C-U+001F and JS does
# not. So a BOM-padded cell was KEPT by the live preview and DROPPED by this committed
# mask, and a NEL-padded cell the reverse: the mask a user watched was not the mask
# that got committed, with no diagnostic. Enumerating the set -- the UNION of Unicode
# White_Space, python's extra U+001C-U+001F, and JS's U+FEFF -- makes the three agree
# by construction and never loses a cell any reader would have accepted.
_VALUE_WS = (
    " \t\n\r\x0b\x0c"          # the six ASCII (space, tab, LF, CR, VT, FF)
    "\x1c\x1d\x1e\x1f"         # FS/GS/RS/US -- python's `str.strip()` eats these
    "\x85\xa0"                 # NEL, NBSP
    " "                   # OGHAM SPACE MARK
    "           "
    "  "             # LINE / PARAGRAPH SEPARATOR
    "  　"       # NARROW NBSP, MEDIUM MATHEMATICAL SPACE, IDEOGRAPHIC
    "﻿"                   # ZERO WIDTH NO-BREAK SPACE (BOM) -- JS `trim()` eats this
)


def _value_float(x):
    """A single obs value as a float, or NaN when it is not numeric -- so a non-numeric
    cell FAILS a numeric threshold (the `np.isfinite` clause drops it) rather than
    raising. Mirrors `primitives.ts::parseValue` and the emitted prelude's `_num`.

    THE RULE (one sentence, three readers): ``None`` is NaN; a ``bool`` is 1.0/0.0; a
    real int/float is itself; a STRING is stripped of [`_VALUE_WS`] and then held to the
    SAME plain-ASCII-decimal grammar the bounds are (`_DECIMAL_BOUND`); anything else
    (a list, a dict) is NaN.

    ROUND-4, two changes, each of which was a live divergence:

    * a ``bool`` is now 1.0/0.0, NOT NaN (R3-131). ``criteria_keep_mask``'s range branch
      dispatches on ``np.asarray(col).dtype.kind``: a numpy ``bool_`` column is in
      "biuf" and takes the ``astype(float)`` fast path (True -> 1.0), while the SAME
      column read out of a pandas object/nullable-boolean dtype lands here. So the
      committed mask for a boolean obs column depended on a DTYPE the recorded recipe
      cannot see -- object-dtype answered the exact INVERSE of numpy-dtype, and of the
      emitted replay (``float(True)``) and the preview (``Number(true)``). One answer now.
    * a STRING is held to ``_DECIMAL_BOUND`` instead of bare ``float()`` (R3-109). Bare
      ``float()`` accepts ``"1_0"`` (10.0) and ``"　１２３"`` (fullwidth digits) which
      JS ``Number()`` refuses, so those cells passed the committed threshold and failed
      the previewed one. The grammar is ``re.ASCII``, so it subsumes the former explicit
      ``isascii()`` gate: a non-ASCII digit cannot match it at all.

    The strip happens BEFORE the grammar test on purpose: a merely padded ascii number
    must stay numeric (gating the RAW string would open a divergence in the opposite
    direction)."""
    if x is None:
        return float("nan")
    if isinstance(x, bool):
        return 1.0 if x else 0.0
    if isinstance(x, str):
        t = x.strip(_VALUE_WS)
        if not _DECIMAL_BOUND.match(t):
            return float("nan")
        try:
            return float(t)
        except (TypeError, ValueError):
            return float("nan")
    try:
        v = float(x)
    except (TypeError, ValueError):
        return float("nan")
    return v


def _is_spellable_scalar(x):
    """Does ``x`` have ONE ``str()`` spelling all four readers can produce?

    ROUND-4b (R4A-01 / R4A-02). Exactly the JSON scalars: ``None``, a bool, a real
    number, a string. A CONTAINER is refused, because the four readers spell one
    differently and cannot be made to agree:

    ======================  ==============================  ==========================
    value                   serde_json (the Rust emitter)   python ``str()`` (here)
    ======================  ==============================  ==========================
    ``[1, 2]``              ``[1,2]``  (no space)           ``[1, 2]``
    ``["a"]``               ``["a"]``  (double quotes)      ``['a']``
    ``[True]``              ``[true]``                      ``[True]``
    ``{"b": 1, "a": 2}``    ``{"a":2,"b":1}`` (keys SORTED) ``{'b': 1, 'a': 2}``
    ======================  ==============================  ==========================

    …and JS cannot spell ``[1.0]`` at ALL (it has no int/float distinction, so
    ``[1]`` and ``[1.0]`` are the same value), which is why "reproduce CPython's repr
    everywhere" is unwinnable and refusal is the rule instead. An unspellable value
    matches nothing, on EITHER side of the keep-set comparison.

    Defined by CONTAINER exclusion, deliberately, not by ``isinstance(x, (int, str, …))``:
    the cells here come out of numpy, and ``np.int64`` / ``np.bool_`` are NOT subclasses
    of python's ``int`` / ``bool``, so an inclusion test would refuse ordinary obs data.
    ``np.ndarray`` is listed because an object-dtype obs column can hold real arrays."""
    return not isinstance(x, (list, tuple, dict, set, frozenset, np.ndarray))


def _is_categorical_criterion(c):
    """A criterion is CATEGORICAL (a keep-set filter) vs CONTINUOUS (a min/max range) inferred
    from its SHAPE — NOT from a ``control`` field the declarative view never sets (the P1 bug:
    ``ui/cell-filter.yaml`` only sets column/min/max/keep, so ``control`` arrives as ``''`` and a
    categorical keep-set silently fell into the range branch → dropped → ALL cells kept). An
    explicit ``control`` is still honored when present (back-compat / an AI that sets it); otherwise
    a non-empty ``keep`` list ⇒ categorical, and min/max ⇒ range."""
    control = c.get("control")
    if control == "multiselect":
        return True
    if control == "range":
        return False
    # No explicit control (the real UI path): infer from the criterion's shape.
    # The `isinstance(..., list)` is load-bearing: ``len(c.get("keep") or []) > 0`` is
    # ALSO true for a non-empty STRING, so ``{"column": "x", "keep": "abc"}`` took the
    # categorical branch here (keep-set {'a','b','c'}!) while the emitter
    # (`predicate_script::is_categorical`, JSON-array-only) took the range branch. A
    # malformed non-list ``keep`` is not a keep-set anywhere now.
    keep = c.get("keep")
    return isinstance(keep, (list, tuple)) and len(keep) > 0


def criteria_keep_mask(criteria, obs, n_cells=None):
    """The COMBINED per-cell KEEP mask for the declarative `criteria` recipe (Slice 4, ITEM-9 /
    DEC-27 JOINT DROP). PURE — `criteria` is a list of ``{column, control, min?, max?, keep?}`` and
    `obs` is a ``{column: array}`` dict (built from ``adata.obs``). The mask is the AND over every
    criterion of its per-cell keep-mask on ITS column: a CONTINUOUS ``range`` keeps cells within
    ``[min, max]`` (each bound inclusive; empty/None unbounded); a CATEGORICAL keep-set keeps
    cells whose category is in ``keep`` (empty keep-set ⇒ no constraint). The categorical vs range
    branch is inferred from the criterion SHAPE (``_is_categorical_criterion``) so the real UI path
    — which never sets ``control`` — reaches the categorical branch (P1 fix). JOINT DROP is inherent
    — the mask is ONE per-cell boolean over the SHARED obs, so a criterion on ANY modality's column
    (e.g. ``prot:total_counts``) drops the WHOLE cell across all modalities. A criterion on an
    ABSENT column keeps every cell (never silently hides the dataset). ``n_cells`` pins the mask
    length to the FULL cell count so every-criterion-on-an-absent-column returns a full keep-all
    mask (P2: without it an empty ``obs`` yields a length-0 mask that broadcast-crashes the AND in
    ``main``). Mirrors the FE ``primitives.ts::keep_mask`` so the live-tuned mask and the committed
    mask agree."""
    n = int(n_cells) if n_cells is not None else 0
    if n_cells is None:
        for v in obs.values():
            n = max(n, len(v))
    keep = np.ones(n, dtype=bool)
    for c in criteria or []:
        if not isinstance(c, dict):
            continue
        # TRIMMED — the same spelling the predicate builder and both script emitters
        # use, so a padded column name cannot make the recorded recipe constrain a
        # column this mask never looked up.
        # ROUND-4b (R4A-09): only a STRING is a column name. `criteria` is client-supplied
        # JSON, so `column` can arrive as a number / list / dict; the raw value used to be
        # looked up in `obs` directly and an unhashable one (a list) raised
        # ``TypeError: unhashable type: 'list'`` out of the COMMITTED mask -- a hard job
        # failure -- while the emitter quietly answered "" and the live preview threw
        # ``raw.replace is not a function``. A non-string names no obs column anywhere now.
        raw_name = c.get("column")
        col_name = _trim_column(raw_name) if isinstance(raw_name, str) else None
        col = obs.get(col_name) if col_name else None
        if col is None:
            continue  # absent column ⇒ no constraint (keep all)
        if _is_categorical_criterion(c):
            # A non-LIST `keep` is not a keep-set -- the same rule
            # `_is_categorical_criterion` applies on the inferred path. Reached only via
            # an EXPLICIT ``control: "multiselect"``, where ``c.get("keep") or []`` used
            # to iterate a STRING into the character set {'1','2'}: a filter no other
            # reader agreed with (the TS mask and the emitter both saw no keep-set).
            wanted = c.get("keep")
            wanted = wanted if isinstance(wanted, (list, tuple)) else []
            if len(wanted) == 0:
                continue  # empty keep-set (or a malformed one) => no constraint
            # ROUND-4b (R4A-01/R4A-02): an UNSPELLABLE keep value -- a CONTAINER -- is
            # DROPPED from the keep-set. No two of the four readers spell a container
            # alike: serde says ``[1,2]`` where python says ``[1, 2]``, ``["a"]`` where
            # python says ``['a']``, ``[true]``/``[True]``, and serde SORTS object keys
            # where python preserves insertion order -- and JS cannot spell ``[1.0]`` at
            # all (no int/float distinction), so the live preview could never agree
            # whatever the other two did. The value is refused at the boundary in every
            # reader instead: it matches nothing, on either side of the comparison.
            #
            # The CONSTRAINT test above is ``len(wanted) == 0`` on the RAW list, so a
            # keep-set of only containers still constrains (it selects zero cells) --
            # it is not silently demoted to an empty keep-set, which keeps every cell.
            wanted_set = {str(x) for x in wanted if _is_spellable_scalar(x)}
            # NUMERIC fallback beside the string compare. Whether a cell's `1` spells
            # itself "1" or "1.0" depends on the column's DTYPE, which the UI that built
            # the keep-set cannot see -- so a keep-set of ["1","2"] over a FLOAT `leiden`
            # matched nothing here while the live preview matched everything. Comparing
            # numerically when both sides are plain decimals takes the dtype out of the
            # answer. Mirrored by `criteriaPredicate.ts::categoricalMatches` and by the
            # emitted replay prelude's `_keep_in`.
            wanted_nums = set()
            for x in wanted:
                if not _is_spellable_scalar(x):
                    continue
                nx = _bound_or_none(str(x))
                if nx is not None:
                    wanted_nums.add(nx)

            def _cat_hit(v):
                # ROUND-4b: the CELL side of the same gate. Without it a keep value that
                # is literally python's spelling of a container ("[1, 2]") matched a
                # container CELL here while the live preview -- which cannot reproduce
                # that spelling in JS -- kept the complement.
                if not _is_spellable_scalar(v):
                    return False
                sv = str(v)
                if sv in wanted_set:
                    return True
                nv = _bound_or_none(sv)
                return nv is not None and nv in wanted_nums

            m = np.array([_cat_hit(x) for x in col], dtype=bool)
        else:
            lo, hi = _bound_or_none(c.get("min")), _bound_or_none(c.get("max"))
            if lo is None and hi is None:
                continue
            try:
                # A NUMERIC dtype goes straight to numpy; anything else (a str/object
                # obs column) is coerced per CELL through `_value_float`. F2-6: numpy's
                # string->float uses python's `float()` per element, which accepts
                # Unicode decimal digits (a fullwidth "10" converts to 10.0)
                # while the live TS mask's `Number()` answers NaN -- so an all-numeric-
                # LOOKING string column took this fast path and never reached the
                # ascii-gated `_value_float`, leaving the committed mask disagreeing with
                # the preview on exactly the cells this gate exists for.
                arr = np.asarray(col)
                if arr.dtype.kind in "biuf":
                    vals = arr.astype(float)
                else:
                    vals = np.array([_value_float(x) for x in col], dtype=float)
            except (ValueError, TypeError):
                # A range criterion on a NON-NUMERIC column used to raise, failing the
                # WHOLE cell.filter job. Reachable from the real UI:
                # `cf.setCriterionField` writes ONE field, so typing a Min and then
                # switching `column` to a categorical one leaves the bound in state (the
                # min/max widgets are only HIDDEN by the `when` gate).
                # Coerce per CELL instead: a value that is not a finite number FAILS a
                # numeric threshold (the `np.isfinite` clause below drops it) -- exactly
                # what `primitives.ts::keep_range` and the emitted `_keep_range` already
                # do. Skipping the whole criterion would have been a third answer.
                vals = np.array([_value_float(x) for x in col], dtype=float)
            m = np.ones(len(vals), dtype=bool)
            with np.errstate(invalid="ignore"):
                if lo is not None:
                    m &= vals >= lo
                if hi is not None:
                    m &= vals <= hi
                # a non-finite value fails a real numeric threshold (can't be shown to satisfy it).
                m &= np.isfinite(vals)
        if len(m) < n:
            m = np.concatenate([m, np.ones(n - len(m), dtype=bool)])
        keep &= m
    return keep


def write_keep_mask(outputs_dir, rel_dir, name, mask):
    """Write the per-cell boolean KEEP mask as a `metadata-column` Zarr artifact
    (ITEM-25/27, ITEM-26): obs-aligned over ALL input cells, `true` = kept.

    One byte per cell instead of the JSON `true`/`false` token stream that preceded it
    — a 150k-cell mask went from ~750 KB of text the client had to parse whole to a
    gzipped byte array it fetches by chunk. Returns `(structure, meta)`."""
    import pandas as pd

    return cyto_columns.write_metadata_column(
        outputs_dir, rel_dir, name, pd.Series(np.asarray(mask, dtype=bool)), axis="cells")


def output_entry(id, datatype_layout, path, role, *, structure, meta=None):
    """One `/outputs/manifest.json` entry. `structure` (HOW to decode the bytes) and
    `meta` (what they MEAN) are producer declarations with NO default on either side of
    the wire — artifact-model ITEM-5/6 — so both are named at every call site."""
    dt, layout = datatype_layout
    return {"id": id, "datatype": dt, "path": path, "layout": layout, "role": role,
            "structure": structure, "meta": meta}


# ─────────────── reading the ARTIFACTS (format from the declaration) ──────────
#
# A staged artifact says what it is: a `cyto_zarr` store stamps the producer-declared
# `structure` into its group `zarr.json` under `attributes.cyto`. That declaration is the
# format contract; a filename is not.


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


def read_column_values(path, slot):
    """A column artifact input → its values as a numpy array of Python objects.

    Which member holds them is the producer's declaration (`structure.key`, else the
    single declared column, else the conventional `values`)."""
    import cyto_zarr_read

    structure = artifact_structure(path)
    if structure is None:
        fail(
            f"input on slot {slot!r} at {Path(path).name!r} carries no `structure` "
            "declaration in a group `zarr.json` — it is not a cyto_zarr column artifact"
        )
    member = structure.get("key")
    if not member:
        columns = structure.get("columns") or []
        if len(columns) == 1 and isinstance(columns[0], dict):
            member = columns[0].get("path")
    values = cyto_zarr_read.read_column(path, member or "values")
    return np.asarray(values.tolist() if hasattr(values, "tolist") else list(values))


class CscMatrix:
    """The count matrix behind a run — the CSC trio plus, when the run bound them, the
    gene LABELS a pattern metric needs.

    It exists so the legacy on-the-fly metrics survive the move off AnnData. The three
    quantities `sc.pp.calculate_qc_metrics` used to supply are computed here to the same
    definitions: `total_counts` is the per-cell sum, `n_genes_by_counts` the per-cell
    count of genes with a positive value, and `pct_counts_<m>` the percentage of a cell's
    counts carried by the genes a regex flagged.
    """

    def __init__(self, n_cells, n_genes, indptr, indices, data, gene_names=None):
        self.n_cells = int(n_cells)
        self.n_genes = int(n_genes)
        self.indptr = np.asarray(indptr)
        self.indices = np.asarray(indices)
        self.data = np.asarray(data)
        self.gene_names = None if gene_names is None else [str(g) for g in gene_names]

    def total_counts(self):
        return np.bincount(
            np.asarray(self.indices, dtype=np.intp),
            weights=np.asarray(self.data, dtype=float), minlength=self.n_cells,
        )[: self.n_cells]

    def n_genes_by_counts(self):
        positive = np.asarray(self.data) > 0
        return np.bincount(
            np.asarray(self.indices, dtype=np.intp)[positive], minlength=self.n_cells
        )[: self.n_cells].astype(float)

    def pct_on_pattern(self, pattern):
        """`pct_counts_<m>` for the genes matching `pattern`, or ``None`` when the run
        bound no gene labels — an uncomputable metric is a typed skip, NEVER a fabricated
        0 % (which is a different claim, and the one a filter would act on)."""
        if self.gene_names is None:
            return None
        rx = re.compile(pattern)
        flagged = [j for j, g in enumerate(self.gene_names) if rx.match(g)]
        on_set = np.zeros(self.n_cells, dtype=float)
        for j in flagged:
            lo, hi = int(self.indptr[j]), int(self.indptr[j + 1])
            if hi <= lo:
                continue
            on_set += np.bincount(
                np.asarray(self.indices[lo:hi], dtype=np.intp),
                weights=np.asarray(self.data[lo:hi], dtype=float),
                minlength=self.n_cells,
            )[: self.n_cells]
        total = self.total_counts()
        with np.errstate(divide="ignore", invalid="ignore"):
            pct = np.where(total > 0, 100.0 * on_set / total, 0.0)
        return np.nan_to_num(pct, nan=0.0, posinf=0.0, neginf=0.0)


def read_matrix(path, slot, gene_names=None):
    """The `expression` input → a [`CscMatrix`].

    The ONLY accepted encoding is what the importer emits for the expression family: a
    CSC Zarr store. `kind` comes from the store's OWN declaration — never from the mount
    name — and anything else is refused BY NAME rather than guessed at.
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
            f"input on slot {slot!r} at {path.name!r} declares kind {kind!r}; cell-filter "
            "reads a `sparse_csc` count matrix"
        )
    shape = structure.get("shape") or []
    if len(shape) != 2:
        fail(f"input on slot {slot!r} declares no 2-D shape (got {shape!r})")
    indptr, indices, data = cyto_csc.read_csc(path)
    n_cells = int(shape[0])
    if np.asarray(indices).size and int(np.asarray(indices).max()) >= n_cells:
        fail(
            f"input on slot {slot!r} stores a row index past its declared "
            f"{n_cells}-entry cells axis"
        )
    return CscMatrix(n_cells, int(shape[1]), indptr, indices, data, gene_names)


class ObsFrame:
    """The per-cell view a run filters over: the obs COLUMNS, the cell KEYS, and the
    count matrix behind them.

    It is deliberately duck-compatible with the narrow `AnnData` surface the kernels
    below already used (`.obs` / `.obs_names` / `.n_obs`), so `resolve_gate` and the
    criteria resolution are unchanged by the move off AnnData. What changed is where the
    pieces come from: obs columns are `metadata-column` ARTIFACTS bound one per
    `column:<name>` slot, the keys are the cells-axis key artifact, and the matrix is the
    CSC store — three artifacts where there used to be one opaque `.h5ad`.
    """

    def __init__(self, n_obs, obs_names, columns, matrix=None):
        import pandas as pd

        self.n_obs = int(n_obs)
        self.obs_names = pd.Index([str(x) for x in obs_names])
        self.obs = pd.DataFrame({k: v for k, v in columns.items()})
        self.matrix = matrix


# ──────────────────────────── recipe / cell-set parsing ───────────────────────

# Friendly aliases → canonical scanpy obs metric names.
METRIC_ALIASES = {
    "pct_mito": "pct_counts_mt", "percent.mito": "pct_counts_mt", "pct_counts_mt": "pct_counts_mt",
    "pct_ribo": "pct_counts_ribo", "percent.ribo": "pct_counts_ribo", "pct_counts_ribo": "pct_counts_ribo",
    "n_genes": "n_genes_by_counts", "nFeature": "n_genes_by_counts", "n_genes_by_counts": "n_genes_by_counts",
    "nCount": "total_counts", "total_counts": "total_counts", "n_counts": "total_counts",
}


def canon_metric(name):
    return METRIC_ALIASES.get(str(name), str(name))


def _range_bounds(rng):
    """A ``[lo, hi]`` inclusive-keep range → ``(lo, hi)``. Tolerates ``None`` / a short
    list / a non-numeric entry (→ that bound is dropped rather than crashing)."""
    if not isinstance(rng, (list, tuple)) or len(rng) < 2:
        return None, None

    def _num(x):
        if x is None:
            return None
        try:
            return float(x)
        except (TypeError, ValueError):
            return None

    return _num(rng[0]), _num(rng[1])


def criteria_thresholds(criteria):
    """Normalize the DECLARATIVE UI's ``criteria`` recipe into report threshold entries
    (filter-provenance ITEM-16 / DEC-3).

    ``ui/cell-filter.yaml``'s Run sends ``{criteria, label}`` — never ``thresholds`` — so
    before this branch the committed ``filter-report`` recorded ``"thresholds": []`` and had
    no ``criteria`` key at all: **the report did not say what was filtered on**. Each
    ``{column, control, min?, max?, keep?}`` criterion becomes a peer of the other three
    accepted shapes (``metric`` <- ``column``, plus ``min``/``max``, and for a CATEGORICAL
    criterion its ``keep`` set, which the numeric ``thresholds`` vocabulary cannot express).

    Entries are tagged ``source="criteria"`` and are **REPORT-ONLY**: the keep-mask stays the
    output of the dedicated, already-correct ``criteria_keep_mask`` branch in ``main`` (the
    only one that honours a categorical keep-set and the non-finite rule), so this addition
    leaves the committed mask BYTE-IDENTICAL. A criterion that imposes no constraint (no
    column, an unbounded range, an empty keep-set) is omitted, mirroring the per-sample
    branch's all-None skip."""
    out = []
    for c in criteria or []:
        if not isinstance(c, dict):
            continue
        # TRIMMED, like `criteria_keep_mask` / the predicate builder / both emitters —
        # and like main()'s `criteria_obs_cols` keys, which the report filter matches
        # `metric` against. An untrimmed `" pct_mito"` here made the filter drop an
        # entry for a criterion that DID constrain the mask, so the report UNDER-stated
        # the filter that ran (the exact inverse of the filter's purpose).
        # ROUND-4b (R4A-09): only a STRING is a column name — the SAME rule
        # `criteria_keep_mask` applies. A non-string names no obs column, so the mask
        # imposes no constraint for it; reporting one would claim a filter that never
        # ran (`{"column": ["q"]}` used to be reported under the metric `"['q']"`).
        col = c.get("column")
        if not isinstance(col, str):
            continue
        col = _trim_column(col)
        if not col:
            continue
        if _is_categorical_criterion(c):
            # A non-LIST `keep` is not a keep-set -- the SAME `isinstance` guard the mask
            # kernel (`criteria_keep_mask`) applies. Round 1 added it there and missed
            # this call site, which runs BEFORE any mask is written:
            #   * F2-2 -- `{control:"multiselect", keep:5}` raised
            #     `TypeError: 'int' object is not iterable` out of this comprehension and
            #     killed the WHOLE `cell.filter` job (`EXIT: 1`, empty outputs dir);
            #   * F2-3 -- `{control:"multiselect", keep:"abc"}` iterated the STRING into
            #     the keep-set `["a","b","c"]`, so the report claimed a categorical
            #     filter for a criterion the mask (which skips a non-list keep) applied
            #     NO constraint for.
            # Both answers are now the mask's: a malformed keep-set constrains nothing,
            # so it is omitted from the report.
            raw_keep = c.get("keep")
            keep = [str(x) for x in (raw_keep if isinstance(raw_keep, (list, tuple)) else [])]
            if not keep:
                continue  # an empty (or malformed) keep-set imposes no constraint
            out.append({
                "metric": str(col),
                "min": None,
                "max": None,
                "sample": None,
                "keep": keep,
                "source": "criteria",
            })
        else:
            lo, hi = _bound_or_none(c.get("min")), _bound_or_none(c.get("max"))
            if lo is None and hi is None:
                continue  # an unbounded range imposes no constraint
            out.append({
                "metric": str(col),
                "min": lo,
                "max": hi,
                "sample": None,
                "source": "criteria",
            })
    return out


def thresholds_from_params(p):
    """Normalize the recipe into a list of {metric,min,max,sample}. Accepts THREE shapes:

    * the interactive per-sample MAP the ``filter.yaml`` view_spec emits (DEC-1) —
      ``{criterion: {ident: [lo, hi]}}`` — each ``[lo,hi]`` becomes a
      ``{metric:criterion, min:lo, max:hi, sample:ident}`` per-sample threshold;
    * an explicit LIST of ``{metric|col|criteria, min, max, sample|ident}`` dicts;
    * the declarative UI's ``criteria`` list (filter-provenance ITEM-16, see
      ``criteria_thresholds`` — REPORT-ONLY entries tagged ``source="criteria"``).

    ITEM-4 stopped ``ui/cell-filter.yaml`` sending a ``predicate`` (the criteria→DSL lift
    was a SECOND encoding of the same filter, and the two could disagree); ITEM-9 deleted
    the predicate DSL from the frontend outright. Nothing constructs a ``predicate`` any
    more, so the report-only walker that used to consume one is deleted rather than left
    as an unreachable branch.

    The ``criteria`` entries are ALWAYS appended (F2-4: ``main`` applies that recipe
    unconditionally, so gating the report on ``if not out`` hid criteria that DID shape
    the mask). The live ``thresholds`` callers keep their own entries, in their own
    order, first.

    The RAW criteria name is preserved (resolved against the obs columns at apply time);
    a ``sample``/``ident`` restricts a threshold to one sample (per-sample, ITEM-13)."""
    out = []
    raw_thresholds = p.get("thresholds")
    if isinstance(raw_thresholds, dict):
        # Interactive per-sample map: {criterion: {ident: [lo, hi]}}.
        for criterion, per_sample in raw_thresholds.items():
            if not isinstance(per_sample, dict):
                continue
            for ident, rng in per_sample.items():
                lo, hi = _range_bounds(rng)
                if lo is None and hi is None:
                    continue  # an all-None range is a no-op criterion
                out.append({"metric": str(criterion), "min": lo, "max": hi, "sample": str(ident)})
    else:
        for t in raw_thresholds or []:
            if not isinstance(t, dict):
                continue
            raw = t.get("metric") or t.get("col") or t.get("criteria")
            # ROUND-4 (R3-42): coerce through `_bound_or_none`, the ONE grammar, exactly
            # as the criteria-derived entries do. These used to pass the raw JSON value
            # through, so within a SINGLE report `thresholds[].min` was an int for a
            # legacy entry and a float for a criteria entry -- and main's apply loop then
            # did an unguarded `float(t["min"])`, so a legacy `"0x10"` bound killed the
            # whole job (uncaught ValueError, empty outputs dir) where the criteria path
            # treats it as unbounded. One coercion, one type, one failure mode.
            out.append({
                "metric": str(raw),
                "min": _bound_or_none(t.get("min")),
                "max": _bound_or_none(t.get("max")),
                "sample": t.get("sample") if t.get("sample") is not None else t.get("ident"),
            })
    # The shape `ui/cell-filter.yaml` actually sends (ITEM-16). Report-only, and
    # ALWAYS appended -- never gated on `if not out` (F2-4). `main` applies the
    # `criteria` recipe unconditionally (via `criteria_keep_mask`), so when a caller
    # sent BOTH `thresholds` and `criteria` the gate hid every criterion from the
    # report while its constraint still shaped the mask: verified 5 cells in -> 2 kept,
    # where cells 3-4 were dropped by a `pct_mito` criterion that appeared NOWHERE in
    # the emitted `filter-report`. The gate bought nothing either -- these entries are
    # tagged `source="criteria"` and are skipped by main's apply loop BY CONSTRUCTION,
    # so the committed mask stays byte-identical and the live `thresholds` callers keep
    # their own entries, in their own order, first.
    out.extend(criteria_thresholds(p.get("criteria")))
    return out


def resolve_metric_col(frame, metric):
    """Resolve a criteria name to an obs column: prefer the RAW name (qc-10x now emits
    `pct_<name>` columns directly), then a legacy alias (`pct_mito`→`pct_counts_mt`)."""
    if metric in frame.obs.columns:
        return metric
    c = canon_metric(metric)
    return c  # in obs, or computable by ensure_metric for the 4 legacy names


def _gate_to_ids(gate, gate_ids):
    """Translate a brushed gate into stable CELL IDs (barcodes) so it resolves against
    the current dataset regardless of index space.

    The interactive scatter (`filter.yaml`) brushes POSITIONS in the pre-filter
    `/obs` cell set (obs.json), but this processor's input `expression.h5ad` is the
    QC-KEPT subset — so a raw positional index means a DIFFERENT cell here. When the
    view passes the pre-filter id column as ``gate_ids`` (obs.json ``id``), each integer
    gate index is mapped ``gate_ids[i]`` → its barcode; barcode-string entries pass
    through unchanged; an out-of-range index is dropped (safer than resolving it against
    the wrong cell). With no ``gate_ids`` mapping the gate is returned verbatim (legacy /
    AI-supplied barcodes) for ``resolve_gate`` to handle.

    IDENTITY RULE (the fix): a gate entry's TYPE, not its spelling, says which space it
    lives in. A JSON **number** is a position; a **string** is a cell ID, ALWAYS — even
    when every character of it is a digit. The previous code ran a numeric STRING through
    ``int()`` and indexed ``gate_ids`` with it, so a dataset whose barcodes are plain
    integers (``"1"``, ``"42"``, …  — several pipelines emit exactly that) had a real
    barcode silently replaced by whatever cell sat at that ROW. That is the same
    name-standing-in-for-a-position defect this function exists to prevent, one level up.
    """
    if not isinstance(gate_ids, (list, tuple)) or not gate_ids:
        return gate
    n = len(gate_ids)
    out = []
    for item in gate:
        if isinstance(item, bool):
            continue
        # A NUMBER is a position. A string is an id — never re-read as a position.
        if isinstance(item, (int, np.integer)):
            idx = int(item)
            if 0 <= idx < n:
                out.append(str(gate_ids[idx]))
            continue  # out-of-range positional index → drop
        out.append(str(item))  # already a barcode
    return out


def resolve_gate(adata, gate):
    """Resolve a gate cell-set (a list of cell IDs and/or integer positions) to a boolean
    keep-mask over the current cells. Returns ``(mask, n_matched, unmatched)``.

    IDENTITY RULE — a gate entry's TYPE says which space it lives in:

      * a JSON **number** is a POSITION in this run's cell axis. Out of range ⇒ it names
        no cell, and is reported as unmatched (never clamped, never wrapped).
      * a **string** is a CELL ID. It is looked up in ``obs_names`` and NOWHERE else. A
        string that is not found is UNMATCHED — it is never re-read as a row number.

    That last clause is the fix. The old code fell back to ``mask[int(s)]`` when a
    digits-only barcode missed the index, so a gate naming barcode ``"42"`` — a barcode
    that is genuinely absent from this QC-kept subset — selected the 43rd ROW instead:
    a DIFFERENT, arbitrary cell, kept under the user's name for another one, with no
    error anywhere. A key that is not found is an absence, and an absence is reported
    (see ``main``, which refuses a gate that identifies nothing), never approximated by
    whatever happens to sit at that position.

    ``unmatched`` is the list of entries that identified no cell, in gate order, so the
    caller can state the miss instead of inferring it from a count."""
    names = adata.obs_names.astype(str).tolist()
    name_to_idx = {n: i for i, n in enumerate(names)}
    mask = np.zeros(adata.n_obs, dtype=bool)
    matched = 0
    unmatched = []
    for item in gate:
        if isinstance(item, bool):
            continue
        if isinstance(item, (int, np.integer)):
            i = int(item)
            if 0 <= i < adata.n_obs:
                mask[i] = True
                matched += 1
            else:
                unmatched.append(item)
            continue
        s = str(item)
        if s in name_to_idx:
            mask[name_to_idx[s]] = True
            matched += 1
        else:
            unmatched.append(s)
    return mask, matched, unmatched


def gate_refusal_reason(gate, matched, unmatched):
    """The message for a gate that identifies NO cell in this dataset, or ``None``.

    Pure, so the refusal is under test at the site that decides it. A gate that matched
    nothing commits an all-false keep-mask — zero cells kept, under a label the user chose
    — and the cause (a gate resolved against the wrong id space, or the wrong dataset) is
    exactly what an empty result hides. Before the identity fix this could not even
    present as empty: a missing numeric barcode fell back to a row position, so the run
    kept an arbitrary set of cells and looked successful."""
    if not gate or matched > 0:
        return None
    return (
        f"the gate identified none of this dataset's cells ({len(unmatched)} of "
        f"{len(gate)} entries matched nothing; first: {unmatched[:5]!r}). A cell id that "
        "is not present is not a row number — check that `gate`/`gate_ids` were resolved "
        "against THIS dataset."
    )


def load_cell_set(path):
    """Parse an allow-list of barcodes from a cell-set file (JSON array,
    ``{cells:[…]}``, metadata-column JSON ``{values:[…]}``, or newline list)."""
    raw = Path(path).read_text().strip()
    if not raw:
        return []
    try:
        obj = json.loads(raw)
        if isinstance(obj, list):
            return [str(x) for x in obj]
        if isinstance(obj, dict):
            for key in ("cells", "barcodes", "values", "cell_ids"):
                if key in obj and isinstance(obj[key], list):
                    return [str(x) for x in obj[key]]
    except ValueError:
        pass
    return [line.strip() for line in raw.splitlines() if line.strip()]


def ensure_metric(frame, metric, mito_regex, ribo_regex):
    """Compute a legacy QC metric column on the fly when no `column:<name>` slot bound it.

    ROUND-4 (R3-78) was the ORDER-DEPENDENCE fix, and it is worth restating why this
    function looks the way it does. `sc.pp.calculate_qc_metrics(..., inplace=True)`
    RECOMPUTED and OVERWROTE `total_counts` / `n_genes_by_counts` even when the input
    already carried them, so whether a criterion saw the dataset's own column or a
    freshly-recomputed one depended on whether a LATER criterion happened to trigger the
    call first. EXECUTED before the fix: the same two criteria in the opposite order gave
    3->2 kept vs 3->0 kept, on identical inputs. That breaks the feature's core invariant
    twice over — the recorded predicate is an order-free AND, so it can never replay an
    order-dependent mask.

    ITEM-24 removes the mechanism rather than compensating for it. The metrics are
    computed from the CSC artifact ONE AT A TIME, so this can only ever ADD the column
    asked for; there is no batch call with a side effect on its neighbours, and no
    snapshot/restore to keep in step with it. A bound column always wins.

    Returns True iff `metric` is present afterwards. `pct_counts_mt`/`pct_counts_ribo`
    need gene LABELS (the `gene_names` slot); without them the metric is a typed skip —
    never a fabricated 0 %.
    """
    if metric in frame.obs.columns:
        return True
    matrix = frame.matrix
    if matrix is None:
        return False
    if metric == "total_counts":
        frame.obs[metric] = matrix.total_counts()
        return True
    if metric == "n_genes_by_counts":
        frame.obs[metric] = matrix.n_genes_by_counts()
        return True
    if metric in ("pct_counts_mt", "pct_counts_ribo"):
        values = matrix.pct_on_pattern(mito_regex if metric == "pct_counts_mt" else ribo_regex)
        if values is None:
            return False
        frame.obs[metric] = values
        return True
    return False


def resolve_criteria_obs_cols(frame, criteria, mito_regex, ribo_regex):
    """The declarative `criteria` recipe's obs columns, as a ``{name: ndarray}`` snapshot
    for ``criteria_keep_mask`` -- keyed under BOTH the raw criterion spelling and the
    resolved obs name so a criterion resolves either way.

    ROUND-4 (R3-78) -- TWO PASSES, deliberately, and this is the fix for the worst
    defect of the round. ``ensure_metric`` may ADD obs columns (it computes the four
    legacy QC metrics on the fly), so resolving and snapshotting in ONE loop made
    criterion K's snapshot depend on whether criterion K+1 happened to trigger a
    computation first: the COMMITTED mask depended on the ORDER of a list the recorded
    AND-predicate is order-free over, so the recipe could never replay it. EXECUTED
    before the fix: the same two criteria in the opposite order gave 3->2 kept vs
    3->0 kept on identical inputs.

    Pass 1 resolves + computes; pass 2 snapshots, once everything that will ever be
    computed has been. Together with ``ensure_metric`` no longer OVERWRITING a
    pre-existing column, that makes order-independence structural rather than a
    property a reader has to re-derive from two cooperating loops."""
    resolved = []
    for c in criteria or []:
        if not isinstance(c, dict):
            continue
        # ROUND-4b (R4A-09): only a STRING is a column name (see `criteria_keep_mask`).
        # `resolve_metric_col` / `ensure_metric` index `adata.obs` with this value, so an
        # unhashable one (a list) raised out of main's resolve pass.
        raw_col = c.get("column")
        if not isinstance(raw_col, str):
            continue
        raw_col = _trim_column(raw_col)  # the ONE canonical spelling (see `criteria_keep_mask`)
        if not raw_col:
            continue
        col_name = resolve_metric_col(frame, raw_col)
        # Compute a missing LEGACY QC metric on the fly (best-effort; a bound
        # `column:<name>` artifact is used as-is; an absent column contributes no
        # constraint via `criteria_keep_mask`).
        if col_name not in frame.obs.columns:
            ensure_metric(frame, col_name, mito_regex, ribo_regex)
        resolved.append((raw_col, col_name))
    out = {}
    for raw_col, col_name in resolved:
        if col_name in frame.obs.columns:
            out[raw_col] = np.asarray(frame.obs[col_name])
            out[col_name] = out[raw_col]
    return out


def build_frame(slots):
    """Assemble the run's [`ObsFrame`] from the ARTIFACTS bound to its slots (ITEM-24).

    Three artifacts where there used to be one opaque `.h5ad`, each resolved by SLOT:

      * `expression`    — the CSC count matrix. REQUIRED: it declares the cells axis's
                          LENGTH, which is the length of the mask this run commits.
      * `column:<name>` — 0..N obs columns; the slot carries each column's name.
      * `cells_index`   — the cells-axis key artifact (barcodes). Optional; absent ⇒
                          positional ids, which is all the gate/cell-set paths need when
                          the caller passes positions.
      * `gene_names`    — gene labels, for the legacy on-the-fly pattern metrics.
    """
    expr_path = slot_path(slots, "expression")
    if expr_path is None:
        fail(
            "no input is bound to the required slot 'expression'. `/inputs/inputs.json` "
            f"declares slot(s) {sorted(slots) or '[]'}; cell-filter resolves by SLOT only "
            "— there is no filename fallback"
        )

    gene_names_path = slot_path(slots, "gene_names")
    gene_names = None
    if gene_names_path is not None:
        gene_names = [str(g) for g in read_column_values(gene_names_path, "gene_names")]

    progress("reading", 10, "expression matrix")
    matrix = read_matrix(expr_path, "expression", gene_names)
    n_in = matrix.n_cells
    if gene_names is not None and len(gene_names) != matrix.n_genes:
        fail(
            f"the `gene_names` artifact holds {len(gene_names)} values but the matrix "
            f"declares {matrix.n_genes} genes — they are not the same axis"
        )

    columns = {}
    seen_mounts = {}
    for slot in sorted(slots):
        if not slot.startswith(COLUMN_SLOT_PREFIX):
            continue
        name = slot[len(COLUMN_SLOT_PREFIX):]
        if not name:
            continue
        # A live seam with the runner's mount naming (ITEM-23): the mount name is a pure
        # function of the SLOT, sanitized to `[A-Za-z0-9._-]`, so two DISTINCT column
        # slots can sanitize to ONE name (`column:a:b` and `column:a_b`). The second
        # stage then overwrites the first and both columns read as the later one's
        # values — a wrong mask with no symptom. Refuse instead of answering.
        mount = str(Path(slots[slot][0]).resolve())
        if mount in seen_mounts:
            fail(
                f"slots {seen_mounts[mount]!r} and {slot!r} collide on one mount "
                f"({Path(slots[slot][0]).name!r}) — the later stage overwrote the "
                "earlier, so both columns would read the same values"
            )
        seen_mounts[mount] = slot
        values = read_column_values(slots[slot][0], slot)
        if len(values) != n_in:
            fail(
                f"the column bound at slot {slot!r} holds {len(values)} values but the "
                f"matrix declares {n_in} cells — they are not the same axis"
            )
        columns[name] = values

    cells_index_path = slot_path(slots, "cells_index")
    if cells_index_path is not None:
        obs_names = [str(x) for x in read_column_values(cells_index_path, "cells_index")]
        if len(obs_names) != n_in:
            fail(
                f"the `cells_index` artifact holds {len(obs_names)} keys but the matrix "
                f"declares {n_in} cells — they are not the same axis"
            )
    else:
        obs_names = [str(i) for i in range(n_in)]

    return ObsFrame(n_in, obs_names, columns, matrix)


def main():
    inputs_dir, outputs_dir = io_dirs()
    p = params(inputs_dir)
    seed = int(p.get("seed", 0))
    rng = np.random.default_rng(seed)
    mito_regex = p.get("mito_regex", r"^(MT-|mt-)")
    ribo_regex = p.get("ribo_regex", r"^(RP[SL]|Rp[sl])")

    slots = load_inputs_index(inputs_dir)
    adata = build_frame(slots)
    n_in, n_genes_in = int(adata.n_obs), int(adata.matrix.n_genes)
    keep = np.ones(n_in, dtype=bool)

    thresholds = thresholds_from_params(p)
    per_metric_removed = {}
    progress("filtering", 40, f"{len(thresholds)} thresholds")
    for t in thresholds:
        if t.get("source") == "criteria":
            # REPORT-ONLY (ITEM-16 / DEC-3): a `criteria`-derived entry describes what was
            # filtered on; the MASK for those criteria is computed below by the dedicated
            # `criteria_keep_mask` branch, which alone honours a categorical keep-set and
            # the non-finite rule. Applying it here too would run the same constraint under
            # DIFFERENT semantics — so the committed mask stays byte-identical.
            continue
        col_name = resolve_metric_col(adata, t["metric"])
        if not ensure_metric(adata, col_name, mito_regex, ribo_regex):
            per_metric_removed[t["metric"]] = None  # metric unavailable → skipped
            continue
        # A range threshold needs a NUMERIC column. A categorical/string obs column can't be
        # float-coerced — skip the criterion gracefully (typed skip, `None`) instead of raising an
        # uncaught ValueError that would fail the whole job.
        try:
            col = np.asarray(adata.obs[col_name], dtype=float)
        except (ValueError, TypeError):
            print(
                f"cell-filter: range threshold on non-numeric column '{col_name}' skipped",
                file=sys.stderr,
            )
            per_metric_removed[t["metric"]] = None
            continue
        # `dropped`, not `fail`: a local called `fail` SHADOWS the module's `fail()` exit for
        # the whole of `main`, so every diagnostic after this loop raised `UnboundLocalError`
        # instead of exiting with its message. Nothing had needed one yet; the mask-naming
        # refusal below is the first, and it found this.
        dropped = np.zeros(n_in, dtype=bool)
        bounded = t.get("min") is not None or t.get("max") is not None
        if t.get("min") is not None:
            dropped |= col < float(t["min"])
        if t.get("max") is not None:
            dropped |= col > float(t["max"])
        # ROUND-4 (R3-84): a NON-FINITE cell fails a real numeric threshold here too.
        # `criteria_keep_mask` has always applied `m &= np.isfinite(vals)` (a value that
        # cannot be SHOWN to satisfy a threshold must not be kept), but this loop only
        # compared -- and `NaN < lo` / `NaN > hi` are both False, so a NaN cell survived.
        # Both paths write entries into the report's ONE `thresholds` list under an
        # identical shape, so the report described two constraints that were not the same
        # constraint. They are the same constraint now.
        if bounded:
            dropped |= ~np.isfinite(col)
        # Per-sample thresholds (ITEM-13): a threshold carrying a `sample`/`ident`
        # only fails cells of THAT sample (others are untouched by this criterion).
        sample = t.get("sample")
        if sample is not None and "sample" in adata.obs.columns:
            in_sample = np.asarray(adata.obs["sample"].astype(str)) == str(sample)
            dropped &= in_sample
        # ROUND-4 (R3-87): keyed by metric AND sample. The interactive per-sample map
        # emits one threshold PER SAMPLE for the same metric, so keying by metric name
        # alone made each sample overwrite the previous one and the report understated
        # every removal but the last.
        key = t["metric"] if sample is None else f"{t['metric']}@{sample}"
        per_metric_removed[key] = int(dropped.sum())
        keep &= ~dropped  # inclusive keep, AND across metrics

    # Declarative `criteria` recipe (Slice 4, ITEM-9 / DEC-27 JOINT DROP) — the shape the
    # `ui/cell-filter.yaml` Run emits: a list of `{column, control, min?, max?, keep?}`. Each
    # criterion resolves against `adata.obs` (its column may be a modality-prefixed obs column, e.g.
    # `prot:total_counts`); the combined keep-mask is a SINGLE per-cell boolean over the SHARED obs,
    # so a criterion on ANY modality's column drops the WHOLE cell across all modalities. On-the-fly
    # metric computation is honored for the legacy metric names (mirrors the thresholds path).
    criteria = p.get("criteria")
    criteria_obs_cols = {}
    if isinstance(criteria, list) and len(criteria) > 0:
        criteria_obs_cols.update(
            resolve_criteria_obs_cols(adata, criteria, mito_regex, ribo_regex)
        )
        obs_cols = criteria_obs_cols
        # Pass the FULL input cell count so the returned mask is always length n_in — even when
        # EVERY criterion references an absent column (obs_cols == {}), where an inferred length
        # would be 0 and `keep &= crit_keep` would raise a (n_in,) vs (0,) broadcast error (P2).
        crit_keep = criteria_keep_mask(criteria, obs_cols, n_cells=n_in)
        progress("criteria", 55, f"{len(criteria)} criteria → {int(crit_keep.sum())} kept")
        keep &= crit_keep

    # The report must describe the filter that ACTUALLY RAN. `criteria_thresholds` is
    # built from the params alone (it has no adata), so it happily listed a criterion
    # whose column is ABSENT from obs — which `criteria_keep_mask` skips entirely
    # ("an unresolved column must never silently hide the dataset") and for which
    # main's loop writes no `per_metric_removed` entry either. The result was a
    # `filter-report` naming a threshold that constrained nothing. Drop those now that
    # the resolved obs columns are known.
    thresholds = [
        t
        for t in thresholds
        if t.get("source") != "criteria" or str(t.get("metric")) in criteria_obs_cols
    ]

    # Gate cell-set allow-list (intersect). Two sources, both optional: an explicitly
    # named `cells`/`cell-set` INPUT SLOT (barcodes file) AND/OR a `gate`/`cells`
    # PARAM (a list of cell ids OR integer indices, ITEM-13).
    cell_set_applied = False
    # How many gate entries identified NO cell here. `None` = no gate was applied at all,
    # which is a different fact from "a gate was applied and missed nothing".
    gate_unmatched = None
    # SLOT names, not filename patterns — `slot_path` takes the first of them that is
    # bound (`manifest.yaml`'s `methods.allow_list_slots` lists the same four).
    cells_path = slot_path(slots, "cells", "cell-set", "cell_set", "cellset")
    if cells_path is not None:
        allow = set(load_cell_set(cells_path))
        if allow:
            in_set = np.array([bc in allow for bc in adata.obs_names.astype(str)], dtype=bool)
            keep &= in_set
            cell_set_applied = True

    gate = p.get("gate")
    if gate is None and isinstance(p.get("cells"), list):
        gate = p.get("cells")
    if isinstance(gate, list) and len(gate) > 0:
        # Map pre-filter obs.json positions → barcodes (id space) before resolving, so
        # the brushed gate hits the right cells in this QC-kept subset (see _gate_to_ids).
        gate_ids = p.get("gate_ids")
        # De-silence the ambiguity (finding): a brushed gate of RAW INTEGER positions with NO
        # `gate_ids` mapping is pre-filter obs.json positions, but `resolve_gate` will interpret them
        # as positions in THIS QC-kept subset — a different cell set. Warn loudly instead of silently
        # keeping the wrong cells; the interactive view should always pass `gate_ids`.
        # Only a genuine INTEGER is ambiguous now: a digits-only STRING is a cell ID and is
        # resolved by name, so it is not a position that could be read in the wrong space.
        if not gate_ids and any(isinstance(g, (int, np.integer)) and not isinstance(g, bool) for g in gate):
            print(
                "cell-filter: WARNING — integer gate positions without a `gate_ids` mapping are "
                "resolved against the QC-kept subset, NOT the pre-filter obs the brush swept; "
                "the interactive view should pass `gate_ids` to disambiguate.",
                file=sys.stderr,
            )
        gate = _gate_to_ids(gate, gate_ids)
        gate_mask, matched, unmatched = resolve_gate(adata, gate)
        # A gate that identifies NOTHING is a refusal, not an empty result. Every entry
        # missed, so the mask this run would commit is all-false — it keeps zero cells
        # under a label the user chose, and the reason (a gate resolved against the wrong
        # id space, or against the wrong dataset entirely) is exactly the one a silent
        # all-false mask hides. It used to be able to look SUCCESSFUL instead: a missing
        # numeric barcode fell back to a row position, so the run kept some arbitrary set
        # of cells rather than saying it could not find the ones it was given.
        refusal = gate_refusal_reason(gate, matched, unmatched)
        if refusal:
            fail(refusal)
        if unmatched:
            # A PARTIAL miss is legitimate (the brush swept the pre-filter obs, and QC has
            # since removed some of those cells) — but it is stated, never swallowed.
            print(
                f"cell-filter: {len(unmatched)} of {len(gate)} gate entries identified no "
                f"cell in this dataset and were skipped (first: {unmatched[:5]!r}).",
                file=sys.stderr,
            )
        gate_unmatched = len(unmatched)
        keep &= gate_mask
        cell_set_applied = True

    # Optional seeded down-sample (makes `seed` load-bearing; deterministic).
    max_cells = p.get("max_cells")
    subsample_applied = False
    if max_cells is not None and int(keep.sum()) > int(max_cells):
        kept_idx = np.where(keep)[0]
        chosen = rng.choice(kept_idx, size=int(max_cells), replace=False)
        newkeep = np.zeros(n_in, dtype=bool)
        newkeep[np.sort(chosen)] = True  # sort → stable, order-preserving output
        keep = newkeep
        subsample_applied = True

    # NON-DESTRUCTIVE (ITEM-25/27, DEC-18): commit ONLY a per-cell boolean KEEP-mask
    # metadata-column (obs-aligned over ALL input cells, `true` = kept) named by the LABEL.
    # NEVER a filtered `.h5ad`, an embedding, or a subset — "filtered" is a read-time
    # (matrix, mask) view. The mask is `keep` itself (the AND of the criteria + optional gate).
    try:
        col_name = mask_column_name(p.get("label", ""))
    except BlankMaskLabel as e:
        # The one metric problem that is not a warning. A run that cannot name its output
        # must not commit it under a name nobody chose (see `mask_column_name`).
        fail(str(e))
    n_out = int(keep.sum())
    # The column NAME is the user's; the FILENAME is a sanitised component of it. They are
    # deliberately different strings — a consumer reads the path off `manifest.json`.
    mask_rel = f"{mask_path_component(col_name)}.zarr"
    progress("writing-mask", 75, mask_rel)
    mask_structure, mask_meta = write_keep_mask(outputs_dir, mask_rel, col_name, keep)
    # ITEM-13 (§11.3 / DEC-6): MARK this keep-mask as a FILTER output the server-side finalize sink
    # recognizes and mints a virtual dataset from — the mirror of how an integrate run tags its
    # `dataset-alignment` by SHAPE. The marker is an object carrying the run LABEL (the VD's name);
    # the sink stamps the SOURCE dataset into the mask's `meta.sources[]` itself (it resolves it
    # from the `expression` input's catalog dataset_id — a handle the sandboxed producer does not
    # have), so the producer records only the marker + the label it already chose.
    mask_meta = {**(mask_meta or {}), "filter_mask": {"label": col_name}}

    report = {
        # ROUND-4 (R3-41): a SCHEMA version on the payload. `thresholds[]` gained
        # `source` and `keep` keys in this branch and `per_metric_removed` gained the
        # `metric@sample` key form, with nothing on the document letting a consumer tell
        # an old report from a new one. `manifest.yaml`'s package `version` (which
        # `scripts/check-processor-seed-versions.sh` now gates) versions the CODE; this
        # versions the PAYLOAD, and the two move for different reasons.
        #   1 = the pre-round-4 shape (implicit, absent key)
        #   2 = `thresholds[].source`/`keep`, float-coerced `min`/`max`,
        #       `per_metric_removed` keyed `metric` or `metric@sample`
        #   3 = `gate_unmatched` (gate entries that identified no cell)
        "report_schema": 3,
        "n_cells_in": n_in,
        "n_cells_out": n_out,
        "n_removed": n_in - n_out,
        "retained_pct": round(100.0 * n_out / max(1, n_in), 3),
        "n_genes_in": n_genes_in,
        # ANNOTATE-ONLY: genes are never touched (the matrix is not filtered).
        "n_genes_out": n_genes_in,
        "mask_column": col_name,
        "thresholds": thresholds,
        "per_metric_removed": per_metric_removed,
        "cell_set_applied": cell_set_applied,
        # report_schema 3: entries in `gate` that identified no cell in this dataset and
        # were skipped (`null` = no gate). Reported because the alternative — the old
        # numeric-string→row-position fallback — made a miss look like a hit.
        "gate_unmatched": gate_unmatched,
        "subsample": {"max_cells": (int(max_cells) if max_cells is not None else None), "applied": subsample_applied},
        "seed": seed,
    }
    progress("report", 92, "filter-report.json")
    (outputs_dir / "filter-report.json").write_text(json.dumps(report, indent=2))

    entries = [
        # The keep-mask is the primary (catalogable) output; the delta report is the run summary.
        output_entry(f"metadata-column:{col_name}", DT_METADATA_COLUMN, mask_rel, "artifact",
                     structure=mask_structure, meta=mask_meta),
        output_entry("filter-report", DT_REPORT_QC, "filter-report.json", "artifact",
                     structure=cyto_columns.opaque("application/json"),
                     meta={"kind": "filter-report", "n_cells_in": n_in, "n_cells_out": n_out}),
    ]
    write_manifest(outputs_dir, entries)
    progress("done", 100, f"{n_in}→{n_out} kept (mask {col_name})")
    print(f"cell-filter: {n_in}→{n_out} kept, mask={col_name} (seed={seed})", file=sys.stderr)


if __name__ == "__main__":
    main()
