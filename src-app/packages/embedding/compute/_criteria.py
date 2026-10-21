#!/usr/bin/env python3
# ruff: noqa
"""_criteria — the cell-filter predicate kernel, VENDORED VERBATIM (DEC-11 / ITEM-14a).

The inline metadata filter (ITEM-2b/2c/2d) reuses cell-filter's SHIPPED criteria
vocabulary — NOT a fourth dialect. DEC-11 asks for `criteria_keep_mask` "imported, not
forked". The platform's sandbox helper-staging confines an entry's `run.helpers` to its
OWN package (`processors/mod.rs::confine_under_package` + `guard_relative` reject any
`..`), so a runtime `import` of `cell-filter/compute/cell-filter.py` is impossible without
moving the kernel into the shared `_lib` package — an `src-app` edit that would break
ITEM-29/INV-16, the load-bearing invariant of Stage 0. So the kernel is VENDORED here
BYTE-FOR-BYTE (lines 308-606 of `cell-filter/compute/cell-filter.py`, the exact
`_DECIMAL_BOUND`…`criteria_keep_mask` span) — the SAME dialect, not a new one.

Conformance is machine-enforced, not asserted by eye: `tests/test_inline_filter.py`
imports cell-filter's REAL `criteria_keep_mask` off-sandbox and asserts this copy agrees
with it on the shared coercion corpus (`testdata/README-coercion-corpus.md`), so a drift
in either implementation fails the suite. See DRIFT-3 D1 for the platform-gap follow-up
(move the kernel into `_lib` so every package imports ONE copy).

Do NOT hand-edit the vendored span below — regenerate it from cell-filter.py if that file
changes, and let the conformance test prove agreement.
"""
import math
import re

import numpy as np


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
