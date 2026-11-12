//! Emit a REAL, self-contained, re-executable python script for a recorded
//! CRITERIA selection (filter-provenance ITEM-10/ITEM-18).
//!
//! ## Why this module exists
//!
//! `action_registry::emit_code` used to read a FLAT recipe dialect
//! (`{col, op, val}`) with placeholder fallbacks, so a `subset.filter` recipe
//! carrying the declarative UI's `criteria` list emitted
//! `mask = adata.obs["<col>"] == None`. That placeholder's sha256 became the run's
//! `code_sha256`, i.e. **the value presented as the reproducibility guarantee was
//! the hash of a fake script**.
//!
//! [`emit_criteria_script`] compiles the declarative UI's
//! `{column, control, min?, max?, keep?}[]` criteria into a **pure-stdlib python
//! module** whose `select(ctx)` returns the per-cell boolean keep-mask. It is a
//! faithful port of the committed keep-mask kernels
//! (`cell-filter.py::criteria_keep_mask` / `primitives.ts::keep_mask`) — the same
//! cell coercion, the same ONE decimal-bound grammar, the same python `str()`
//! keep-set spelling — so re-running the emitted script over the same data
//! reproduces the SAME cell set. The output is deterministic (byte-stable for a
//! fixed criteria list) so the code blob still dedups by sha256, and it is
//! criteria-specific so the recorded `code_sha256` actually attests to the recipe.
//!
//! Anything that cannot be honestly reproduced (a criteria list that imposes no
//! constraint at all) is an [`EmitError::MalformedRecipe`] — **fail loudly**, never
//! a placeholder.

use std::fmt::Write as _;

/// Why a recipe could not be turned into a reproducible script.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EmitError {
    /// The action type is not dispatchable (no capture this round).
    NotDispatchable(String),
    /// The recipe is unreadable / cannot be honestly reproduced. NEVER downgraded
    /// to a placeholder script — the whole point of ITEM-18.
    MalformedRecipe(String),
}

impl std::fmt::Display for EmitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EmitError::NotDispatchable(t) => {
                write!(f, "action type '{t}' is not dispatchable this round")
            }
            EmitError::MalformedRecipe(why) => write!(f, "unreproducible selection recipe: {why}"),
        }
    }
}
impl std::error::Error for EmitError {}

fn malformed(why: impl Into<String>) -> EmitError {
    EmitError::MalformedRecipe(why.into())
}

// ----------------------------------------------------------------------------
// python literal rendering (deterministic + injection-safe)
// ----------------------------------------------------------------------------

/// A python string literal. Hand-rolled rather than Rust's `{:?}` because Rust's
/// debug escape emits `\u{1f600}`, which python does NOT parse.
pub(super) fn py_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 || c as u32 == 0x7f => {
                let _ = write!(out, "\\x{:02x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Render an arbitrary, UNTRUSTED string for embedding inside a `#` comment line
/// of the emitted module.
///
/// ## Why this exists (the comment-line injection defect)
///
/// A `#` comment runs to the end of the LINE, so a raw newline inside an
/// interpolated identifier does not stay a comment — it terminates it and the
/// remainder is parsed as module-scope python. A criterion column of
/// `"pct_mito\nimport os\nos.system('…')\n#"` therefore turned a "harmless"
/// `# no-constraint criteria (omitted): …` line into executable code in the very
/// script whose sha256 is the run's reproducibility claim. Every OTHER use of the
/// same identifier already went through [`py_str`]; the comment was the one hole.
///
/// So: every control character (C0, DEL, the C1 range — `char::is_control`) plus
/// the Unicode line/paragraph separators is replaced by a VISIBLE `\xNN` /
/// `\u{NNNN}` escape. Nothing is dropped (a reviewer still sees what was
/// submitted), but no byte in the result can end the comment line.
pub(super) fn py_comment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            // A raw backslash would make the escapes below ambiguous, so it is
            // escaped first (the comment stays a faithful, decodable rendering).
            '\\' => out.push_str("\\\\"),
            c if c.is_control() => {
                let _ = write!(out, "\\x{:02x}", c as u32);
            }
            // LINE SEPARATOR / PARAGRAPH SEPARATOR — not python line terminators
            // today, but escaped so the rendering can never depend on that.
            '\u{2028}' | '\u{2029}' => {
                let _ = write!(out, "\\u{{{:04x}}}", ch as u32);
            }
            c => out.push(c),
        }
    }
    out
}

/// A finite f64 as a python float literal. Rust's `{:?}` gives the shortest
/// round-tripping form (`1.0`, `0.1`, `1e300`) — all valid python.
fn py_f64(v: f64) -> String {
    format!("{v:?}")
}

/// A python tuple literal from already-rendered elements (a 1-tuple keeps its
/// trailing comma so it stays a tuple).
fn py_tuple(items: &[String]) -> String {
    match items.len() {
        0 => "()".to_string(),
        1 => format!("({},)", items[0]),
        _ => format!("({})", items.join(", ")),
    }
}

// ----------------------------------------------------------------------------
// the LEGACY criteria dialect (`subset.filter`, ITEM-10)
// ----------------------------------------------------------------------------

/// The criteria runtime prelude — the pure-stdlib port of the keep-mask kernels
/// (`cell-filter.py::criteria_keep_mask` / `primitives.ts::keep_mask`).
const CRITERIA_PRELUDE: &str = r#"import math
import re

_DEC_RE = re.compile(r"^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$", re.ASCII)

# The ONE whitespace set every reader strips off an obs CELL, mirrored VERBATIM from
# `cell-filter.py::_VALUE_WS` and `primitives.ts::VALUE_WS`: the UNION of Unicode
# White_Space, python's extra U+001C-U+001F, and JS's U+FEFF. Each reader's NATIVE
# trim differs from the others in BOTH directions (JS strips the BOM and python does
# not; python strips NEL and U+001C-U+001F and JS does not), so a padded cell was kept
# by the live preview and dropped by the committed mask -- or the reverse.
_VALUE_WS = (
    " \t\n\r\x0b\x0c"
    "\x1c\x1d\x1e\x1f"
    "\x85\xa0"
    " "
    "           "
    "  "
    "  　"
    "﻿"
)


def _num(x):
    """A criterion's range branch only keeps FINITE numeric values.

    THE RULE, verbatim from `cell-filter.py::_value_float` (the kernel that produced the
    COMMITTED mask) and `primitives.ts::parseValue` (the live preview): None -> NA; a
    bool -> 1.0/0.0; a real number -> itself; a STRING -> stripped of `_VALUE_WS`, then
    held to the SAME plain-ASCII-decimal grammar as the bounds; anything else -> NA.

    This script's sha256 is sold to the user as "replaying this reproduces the cell set
    that was committed", so each clause is load-bearing:

    * bare `float()` accepted `"1_0"` (10.0) and non-ASCII decimal digits
      (`float("１２３") == 123.0` -- what a CJK or Arabic IME emits for ordinary
      typing) which the preview refuses. `_DEC_RE` is `re.ASCII`, so holding the
      string to it refuses both and SUBSUMES the former explicit `isascii()` gate.
    * a `bool` is 1.0/0.0 -- what a numpy bool column's `astype(float)` fast path
      answers, what the kernel's per-cell path now answers for an OBJECT-dtype bool
      column, and what `Number(true)` answers in the preview.
    * the strip runs BEFORE the grammar test on purpose: a merely padded ascii number
      must stay numeric, or the fix opens a divergence in the opposite direction.

    The keep-set branch's `_decimal` enforces the same grammar on the keep values."""
    if x is None:
        return None
    if isinstance(x, bool):
        return 1.0 if x else 0.0
    if isinstance(x, str):
        t = x.strip(_VALUE_WS)
        if not _DEC_RE.match(t):
            return None
        try:
            v = float(t)
        except (TypeError, ValueError):
            return None
        return v if math.isfinite(v) else None
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


def _col_opt(ctx, key):
    """The column, or None when it is ABSENT — an absent column imposes NO
    constraint (a filter never silently hides the dataset)."""
    cols = ctx.get("columns") or {}
    v = cols.get(key)
    return list(v) if v is not None else None


def _keep_range(col, i, lo, hi):
    if col is None or i >= len(col):
        return True
    v = _num(col[i])
    if v is None:
        return False
    if lo is not None and v < lo:
        return False
    if hi is not None and v > hi:
        return False
    return True


def _decimal(s):
    """The ONE bound/keep grammar: plain ASCII decimal notation, nothing else."""
    if not isinstance(s, str) or not s.isascii():
        return None
    t = s.strip(" \t\n\r\f\v")
    if not _DEC_RE.match(t):
        return None
    try:
        v = float(t)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


def _keep_in(col, i, wanted, wanted_nums):
    """String match on python's `str()` spelling, then a NUMERIC fallback -- exactly
    `cell-filter.py::criteria_keep_mask` and `criteriaPredicate.ts::categoricalMatches`.
    The fallback is what makes the answer independent of the column's dtype (a float
    column spells its `1` as "1.0", an int column as "1").

    ROUND-4b (R4A-01/R4A-02): an UNSPELLABLE cell -- a container -- matches NOTHING.
    Without this gate a keep value that is literally python's spelling of a container
    ("[1, 2]") matched a container CELL here and in the kernel while the live preview,
    which cannot reproduce that spelling in JS, did not. The keep SET is filtered the
    same way on the emitting side, so neither side of the comparison ever carries a
    container."""
    if col is None or i >= len(col):
        return True
    v = col[i]
    if isinstance(v, (list, tuple, dict, set, frozenset)):
        return False
    s = str(v)
    if s in wanted:
        return True
    n = _decimal(s)
    return n is not None and n in wanted_nums
"#;

const CRITERIA_CTX_DOC: &str = r#"#
# `select(ctx)` returns this committed keep-mask's per-element booleans (length
# N): the AND over every criterion of its keep-mask on ITS column (JOINT DROP —
# one boolean per element of the selected axis). `ctx["n"]` is the element count
# and `ctx["columns"][name]` a length-N sequence; an ABSENT column imposes no
# constraint. Criteria that impose no constraint are omitted below by name.
#
"#;

/// Plain decimal notation — the ONE bound grammar this feature accepts, mirrored in
/// `criteriaPredicate.ts::DECIMAL_BOUND` and `cell-filter.py::_DECIMAL_BOUND`.
///
/// Four parsers read the same criterion bound (JS `Number()`, Python `float()`, this
/// `parse::<f64>()`, and the narration in `export/methods.rs`) and their native
/// accept-sets differ — `"0x10"` is 16 to JS and an error to Python; `"inf"` is +inf
/// to Python and Rust but NaN to JS; `"1_0"` is 10.0 to Python only. Each difference
/// is a case where the recorded predicate constrains something the committed mask did
/// not, or the reverse. Restricting all four to decimal notation makes them agree.
///
/// Hand-rolled (no `regex` dependency for four characters of grammar): optional sign,
/// then digits with an optional fraction OR a leading `.` fraction, then an optional
/// `e`/`E` exponent with optional sign and at least one digit.
pub fn is_decimal_bound(s: &str) -> bool {
    let b = s.as_bytes();
    let mut i = 0usize;
    if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
        i += 1;
    }
    let int_digits = b[i..].iter().take_while(|c| c.is_ascii_digit()).count();
    i += int_digits;
    let mut frac_digits = 0usize;
    if i < b.len() && b[i] == b'.' {
        i += 1;
        frac_digits = b[i..].iter().take_while(|c| c.is_ascii_digit()).count();
        i += frac_digits;
    }
    // `123`, `123.`, `123.45` and `.45` are all fine; a lone `.` or `+` is not.
    if int_digits == 0 && frac_digits == 0 {
        return false;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        let exp_digits = b[i..].iter().take_while(|c| c.is_ascii_digit()).count();
        if exp_digits == 0 {
            return false;
        }
        i += exp_digits;
    }
    i == b.len()
}

/// Trim the SIX characters python's `str.strip(" \t\n\r\f\v")` strips — and NOT
/// `str::trim()`, which strips the whole Unicode `White_Space` property.
///
/// ## The measured divergence (all three probed by execution, not from memory)
///
/// Each reader's native trim set is different, and every difference is a bound/keep
/// spelling one reader would accept and another would not — i.e. a recorded predicate
/// that constrains something the committed mask did not, or the reverse:
///
/// * Rust `str::trim()` = Unicode `White_Space` — strips U+0085 and U+00A0, does NOT
///   strip U+001C-U+001F or U+FEFF.
/// * Python `str.strip()` = `str.isspace()` — additionally strips U+001C-U+001F
///   (which NEITHER other reader does), and does not strip U+FEFF.
/// * JS `String.prototype.trim()` = ECMA `WhiteSpace` + `LineTerminator` — strips all
///   of Unicode `White_Space` EXCEPT U+0085, PLUS U+FEFF (which neither other reader
///   strips). Verified on node v24.8.0: `("\u{85}1").trim() !== "1"`, while Rust and
///   Python both strip it. (The earlier note here said "the same three characters";
///   the intersection is these SIX.)
///
/// So the intersection — space, tab, LF, CR, VT, FF — is the only set all three agree
/// on, and it is what `cell-filter.py::_bound_or_none` strips explicitly.
///
/// The other readers ARE aligned on this set: `cell-filter.py::_bound_or_none` strips
/// exactly these six explicitly, and `criteriaPredicate.ts::parseBound` uses the same
/// six-character `ASCII_WS_LEAD`/`ASCII_WS_TRAIL` pair rather than JS's `trim()` (which
/// would additionally eat NBSP and U+FEFF). The `C*-pad-*` corpus cases pin one
/// contested codepoint each.
fn trim_ascii_ws(s: &str) -> &str {
    s.trim_matches(|c: char| matches!(c, ' ' | '\t' | '\n' | '\r' | '\u{b}' | '\u{c}'))
}

/// A STRING coerced to a finite number under the ONE grammar — the port of
/// `cell-filter.py::_bound_or_none`'s string branch (ASCII only, the six-character
/// trim, plain decimal notation, finite). Shared by the range bounds and by the
/// keep-set's numeric twin so the two cannot grow apart.
fn decimal_text(s: &str) -> Option<f64> {
    if !s.is_ascii() {
        return None;
    }
    let t = trim_ascii_ws(s);
    if !is_decimal_bound(t) {
        return None;
    }
    t.parse::<f64>().ok().filter(|x| x.is_finite())
}

/// Read a criterion bound (`min`/`max`): a finite number, or a string in plain
/// decimal notation. Empty / absent / any other spelling → unbounded.
fn bound(v: Option<&serde_json::Value>) -> Option<f64> {
    match v {
        Some(serde_json::Value::Number(n)) => n.as_f64().filter(|x| x.is_finite()),
        Some(serde_json::Value::String(s)) => decimal_text(s),
        _ => None,
    }
}

/// PYTHON's `str(x)` spelling of one JSON keep value — the spelling the committed
/// mask compares a cell against (`cell-filter.py::criteria_keep_mask` builds
/// `wanted_set = {str(x) for x in keep}`) — or `None` when the value is UNSPELLABLE.
///
/// Emitting serde's own `to_string()` here made the script keep NO cells for a boolean
/// keep-set the mask happily kept (`true` vs `True`), so the spelling is explicit.
///
/// ## ROUND-4b (R4A-01): a CONTAINER has no spelling — it is refused, not guessed
///
/// The `other => other.to_string()` arm this replaces spelled a non-scalar keep value
/// as **serde JSON** where the kernel and the preview spell it with python's `str()`:
///
/// | value | serde `to_string()` | python `str()` |
/// |---|---|---|
/// | `[1,2]` | `[1,2]` | `[1, 2]` (space) |
/// | `["a"]` | `["a"]` | `['a']` (single quotes) |
/// | `[true]` | `[true]` | `[True]` |
/// | `[null]` | `[null]` | `[None]` |
/// | `{"b":1,"a":2}` | `{"a":2,"b":1}` (serde SORTS keys) | `{'b': 1, 'a': 2}` (insertion order) |
///
/// So the attested replay computed the COMPLEMENT of the committed mask for such a
/// keep-set — the exact invariant `code_sha256` is sold on. Reproducing CPython's
/// `repr` in all three languages is not achievable: JS has no int/float distinction, so
/// `criteriaPredicate.ts` cannot tell `[1]` from `[1.0]` and the live preview would keep
/// diverging whatever this function did. The value is therefore REFUSED at the boundary
/// in every reader: an unspellable value contributes nothing to the keep-set and never
/// matches a cell (`CRITERIA_PRELUDE::_keep_in`, `cell-filter.py::_cat_hit`,
/// `criteriaPredicate.ts::categoricalMatches`).
fn keep_text(v: &serde_json::Value) -> Option<String> {
    match v {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Bool(true) => Some("True".to_string()),
        serde_json::Value::Bool(false) => Some("False".to_string()),
        serde_json::Value::Null => Some("None".to_string()),
        serde_json::Value::Number(n) => Some(n.to_string()),
        // UNSPELLABLE: an array or an object. See the doc above.
        serde_json::Value::Array(_) | serde_json::Value::Object(_) => None,
    }
}

/// The NUMERIC twin of one keep value — the port of the kernel's
/// `_bound_or_none(str(x))`. A JSON number is taken directly (its `str()` spelling is
/// exactly this value); anything else goes through the one decimal grammar, so
/// `True`/`False`/`None`/`"T"` contribute nothing, exactly as in the mask.
fn keep_number(v: &serde_json::Value, text: &str) -> Option<f64> {
    match v {
        serde_json::Value::Number(n) => n.as_f64().filter(|x| x.is_finite()),
        _ => decimal_text(text),
    }
}

/// A criterion is CATEGORICAL when it says so, or (the real declarative-UI path,
/// which never sets `control`) when it carries a non-empty `keep` ARRAY. A non-array
/// `keep` is not a keep-set — the mask (`cell-filter.py`) and the builder
/// (`criteriaPredicate.ts`) agree on that now, so a malformed `keep:"abc"` takes the
/// range branch everywhere instead of becoming the character set `{a,b,c}` in one.
fn is_categorical(c: &serde_json::Map<String, serde_json::Value>) -> bool {
    match c.get("control").and_then(|v| v.as_str()) {
        Some("multiselect") => true,
        Some("range") => false,
        _ => c
            .get("keep")
            .and_then(|v| v.as_array())
            .is_some_and(|a| !a.is_empty()),
    }
}

/// Compile the declarative UI's `{column, control, min?, max?, keep?}[]` criteria
/// into a real threshold/keep-set python script (`subset.filter`'s legacy dialect).
/// The categorical-vs-range rule, for the OTHER readers of a criteria list (the
/// methods-section narration). Same function the emitter uses — one rule, one place.
pub fn criterion_is_categorical(c: &serde_json::Map<String, serde_json::Value>) -> bool {
    is_categorical(c)
}

/// The canonical bound coercion, for the other readers of a criteria list.
pub fn criterion_bound(v: Option<&serde_json::Value>) -> Option<f64> {
    bound(v)
}

pub fn emit_criteria_script(
    header: &str,
    criteria: &[serde_json::Value],
) -> Result<String, EmitError> {
    let mut preamble: Vec<String> = Vec::new();
    let mut parts: Vec<String> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    let mut cols: Vec<(String, String)> = Vec::new();
    let mut sets = 0usize;

    for c in criteria {
        // ROUND-4b (R4A-07): a NON-OBJECT entry is SKIPPED, not fatal. `criteria` is
        // client-supplied JSON; `cell-filter.py::criteria_keep_mask`
        // (`if not isinstance(c, dict): continue`), `primitives.ts::keep_mask` and
        // `criteriaToPredicate` all skip such an entry and apply the REST of the
        // recipe, while this refused the WHOLE recipe with `PROVENANCE_INVALID_RECIPE`
        // — the committed mask ran and nothing recorded it. A criterion nobody can
        // read imposes no constraint; that is the answer everywhere now.
        let Some(obj) = c.as_object() else {
            skipped.push("<malformed>".to_string());
            continue;
        };
        // ROUND-4 (R3-64): `trim_ascii_ws`, NOT Rust's `str::trim()`. `str::trim()`
        // spans the Unicode `White_Space` property and so strips U+0085, which python's
        // `str.strip()` also strips but JS `trim()` does not — and it does NOT strip
        // U+001C–U+001F, which python's `str.strip()` does. So a criterion column padded
        // with one of those was resolved by the committed kernel (the filter ran) and
        // emitted here as a DIFFERENT key, whose `_col_opt` `None` makes `_keep_range`
        // all-true: the attested replay selected every cell the commit had filtered.
        // The six-character intersection is the one set all three readers agree on and
        // is now what `criteriaPredicate.ts::criterionColumn` and the kernel use too.
        let column = trim_ascii_ws(obj.get("column").and_then(|v| v.as_str()).unwrap_or("")).to_string();
        if column.is_empty() {
            skipped.push("<unnamed>".to_string());
            continue;
        }
        let var = match cols.iter().find(|(k, _)| *k == column) {
            Some((_, v)) => v.clone(),
            None => {
                let v = format!("_c{}", cols.len());
                preamble.push(format!("    {v} = _col_opt(ctx, {})", py_str(&column)));
                cols.push((column.clone(), v.clone()));
                v
            }
        };
        if is_categorical(obj) {
            // ONE pass over the keep values builds BOTH halves of the match rule, each
            // from the SAME source `Value`: the python-spelling STRING set the mask
            // compares `str(cell)` against, and its NUMERIC twin (the dtype-independent
            // fallback — a float column spells its `1` as "1.0", an int column as "1").
            //
            // ## Why one pass — the round-2 defect this replaces
            //
            // The twin used to be recovered by re-parsing the ALREADY-RENDERED python
            // literals with `q.trim_matches('\'')`. `py_str` quotes with DOUBLE quotes,
            // so every literal kept its `"`, every one failed `is_decimal_bound`, and the
            // emitted `_wNn` was ALWAYS `frozenset(())` — the dtype-independence fallback
            // the emitted script advertises was DEAD in this reader. A keep-set of
            // `["1","2"]` over a float column replayed as all-False while the committed
            // kernel kept those cells, and inside an `and` that one criterion collapsed
            // the whole mask. That is ITEM-18's defect in yet another coat: the
            // `code_sha256` offered as the reproducibility guarantee attested to a script
            // producing a DIFFERENT cell set than the data that was committed.
            //
            // Deriving both sets from the source value — never from the rendered text —
            // is what makes them unable to drift apart again.
            let mut wanted: Vec<String> = Vec::new();
            let mut nums: Vec<String> = Vec::new();
            let mut keep_len = 0usize;
            if let Some(a) = obj.get("keep").and_then(|v| v.as_array()) {
                keep_len = a.len();
                for v in a {
                    // ROUND-4b (R4A-01): an UNSPELLABLE value (an array / an object) is
                    // DROPPED from the keep-set rather than spelled — no two readers
                    // spell a container alike (see [`keep_text`]).
                    let Some(text) = keep_text(v) else { continue };
                    if let Some(x) = keep_number(v, &text) {
                        nums.push(py_f64(x));
                    }
                    wanted.push(py_str(&text));
                }
            }
            // The CONSTRAINT test is the keep ARRAY's length, NOT the spellable
            // remainder's. A keep-set of only unspellable values selects ZERO cells; an
            // EMPTY keep-set selects every cell. Collapsing the two (the pre-round-4b
            // `wanted.is_empty()` test would now do exactly that) would emit an
            // all-true replay for a mask that kept nothing.
            if keep_len == 0 {
                skipped.push(column);
                continue; // an empty keep-set imposes no constraint
            }
            let set = format!("_w{sets}");
            sets += 1;
            preamble.push(format!("    {set} = frozenset({})", py_tuple(&wanted)));
            preamble.push(format!("    {set}n = frozenset({})", py_tuple(&nums)));
            parts.push(format!("_keep_in({var}, i, {set}, {set}n)"));
        } else {
            let lo = bound(obj.get("min"));
            let hi = bound(obj.get("max"));
            if lo.is_none() && hi.is_none() {
                skipped.push(column);
                continue; // an unbounded range imposes no constraint
            }
            parts.push(format!(
                "_keep_range({var}, i, {}, {})",
                lo.map(py_f64).unwrap_or_else(|| "None".into()),
                hi.map(py_f64).unwrap_or_else(|| "None".into()),
            ));
        }
    }

    if parts.is_empty() {
        return Err(malformed(
            "the criteria impose no constraint at all — an all-true \"selection\" is not \
             a selection and must not be recorded as one",
        ));
    }

    let mut out = String::with_capacity(2048);
    out.push_str(header);
    out.push_str(CRITERIA_CTX_DOC);
    if !skipped.is_empty() {
        // The criterion `column` is client-supplied and only `.trim()`ed, so it is
        // rendered through `py_comment` — a raw newline here would END the comment
        // and make the rest of the identifier module-scope python. (Everywhere ELSE
        // in this function the same string already goes through `py_str`; this line
        // was the sole unescaped interpolation.)
        let names: Vec<String> = skipped.iter().map(|s| py_comment(s)).collect();
        out.push_str(&format!(
            "# no-constraint criteria (omitted): {}\n#\n",
            names.join(", ")
        ));
    }
    out.push('\n');
    out.push_str(CRITERIA_PRELUDE);
    out.push('\n');
    out.push_str("def select(ctx):\n");
    out.push_str("    n = int(ctx[\"n\"])\n");
    for line in &preamble {
        out.push_str(line);
        out.push('\n');
    }
    let _ = writeln!(
        out,
        "    return [bool({}) for i in range(n)]",
        parts.join(" and ")
    );
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ── injection: an identifier NEVER reaches emitted source unescaped ─────────

    /// Compile the emitted module with the host's python3 and return an error when it is
    /// not a single well-formed module.
    ///
    /// ROUND-4 (R3F-11, same class): this used to return `Ok(())` when python3 was
    /// absent — a silent PASS for the injection assertion. python3 is a build-and-test
    /// dependency of this repo (`just check-py`), and `run_select` beside it now panics
    /// on an absent interpreter, so this does too: an absent interpreter is a failure to
    /// verify, never a pass.
    fn python_compiles(src: &str) -> Result<(), String> {
        use std::io::Write as _;
        let dir = std::env::temp_dir().join(format!("txresbench-emit-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let f = dir.join("emitted.py");
        std::fs::File::create(&f)
            .and_then(|mut h| h.write_all(src.as_bytes()))
            .map_err(|e| e.to_string())?;
        let out = match std::process::Command::new("python3")
            .arg("-c")
            .arg(format!(
                "compile(open({:?}).read(), 'emitted.py', 'exec')",
                f.display().to_string()
            ))
            .output()
        {
            Ok(o) => o,
            // ONLY an absent interpreter is a skip — every other spawn failure (a
            // resource-exhausted fork, a permission error) is a real failure and must
            // not quietly retire the assertion. Same rule as `run_select`.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let _ = std::fs::remove_dir_all(&dir);
                return Err(format!(
                    "python3 is not on PATH. It is a build-and-test dependency of this \
                     repo (`just check-py`), and this assertion is what proves a hostile \
                     identifier cannot open a statement in the emitted script — an absent \
                     interpreter is a failure to verify, never a pass: {e}"
                ));
            }
            Err(e) => {
                let _ = std::fs::remove_dir_all(&dir);
                return Err(format!("could not spawn python3 (it IS installed): {e}"));
            }
        };
        let _ = std::fs::remove_dir_all(&dir);
        if out.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).to_string())
        }
    }

    /// Every identifier shape a hostile client can post: a comment-terminating
    /// newline, a CR, quotes, a backslash, a NUL, and a trailing `#` meant to
    /// swallow the rest of the generated line.
    const HOSTILE: [&str; 6] = [
        "pct_mito\nimport os\nos.system('id')\n#",
        "a\rimport os\r#",
        "a\"b\\c",
        "x\u{0}y",
        "# not a comment",
        "ok\u{2028}import os",
    ];

    // Injection (THE FIX): the criteria emitter's `# no-constraint criteria
    // (omitted): …` comment. Before `py_comment`, an interior newline in the
    // client's `column` TERMINATED the comment and the remainder became
    // module-scope python — in the very script whose sha256 is the run's
    // reproducibility claim. RED ON REVERT: drop `py_comment` from
    // `emit_criteria_script` and the `import os` assertion fails.
    #[test]
    fn criteria_emitter_never_lets_a_skipped_name_escape_into_source() {
        // Baseline: the same pair with a BENIGN skipped name — a hostile name may
        // legitimately appear inside a python STRING LITERAL (escaped), so the
        // injection test is not "the text is absent" but "the module has the same
        // SHAPE" (identical line count; an escaped newline adds no line).
        let baseline_lines = emit_criteria_script(
            "# test\n",
            &[
                json!({ "column": "pct_mito", "control": "range", "max": "10" }),
                json!({ "column": "benign" }),
            ],
        )
        .unwrap()
        .lines()
        .count();
        for hostile in HOSTILE {
            // one CONSTRAINING criterion (so the emitter does not bail) + the
            // hostile one, which imposes nothing and lands in the comment.
            let src = emit_criteria_script(
                "# test\n",
                &[
                    json!({ "column": "pct_mito", "control": "range", "max": "10" }),
                    json!({ "column": hostile }),
                ],
            )
            .expect("emits");
            assert!(
                src.contains("no-constraint criteria (omitted)"),
                "the skipped criterion is still reported: {src}"
            );
            assert_eq!(
                src.lines().count(),
                baseline_lines,
                "a hostile criterion name added {} line(s) — it terminated the comment:\n{src}",
                src.lines().count() as i64 - baseline_lines as i64
            );
            python_compiles(&src)
                .unwrap_or_else(|e| panic!("emitted source is not a well-formed module: {e}\n{src}"));
        }
    }

    #[test]
    fn py_comment_escapes_every_line_terminator() {
        assert_eq!(py_comment("a\nb"), "a\\x0ab");
        assert_eq!(py_comment("a\rb"), "a\\x0db");
        assert_eq!(py_comment("a\u{0}b"), "a\\x00b");
        assert_eq!(py_comment("a\\b"), "a\\\\b");
        assert_eq!(py_comment("a\u{2028}b"), "a\\u{2028}b");
        // a benign identifier is untouched (the comment stays readable).
        assert_eq!(py_comment("pct_mito"), "pct_mito");
    }

    /// Execute an emitted script and return its mask. NEVER `None`, NEVER a skip.
    ///
    /// ROUND-4 / R3F-11: this used to return `Option<Vec<bool>>`, with `None` meaning
    /// "python3 is not installed here" — and every caller wrapped its assertions in
    /// `if let Some(m)`. `run_select` announced that skip with an `eprintln!`, which
    /// libtest CAPTURES, so on any python3-less host the whole emitted-replay parity
    /// suite printed `test result: ok` having asserted NOTHING. That is a false green
    /// on the ONE invariant this file exists to hold (the attested `code_sha256`
    /// replays the committed mask), so the skip is gone: python3 is a build-and-test
    /// dependency of this repo (`just check-py` runs the processor pytest suites and
    /// `just check` calls it), and an absent interpreter is now a FAILURE TO VERIFY —
    /// a panic naming the dependency — not a pass.
    ///
    /// It used to `.ok()?` every step — create_dir_all, File::create, write_all, and the
    /// spawn — and each caller wrapped its assertions in `if let Some(m)`. So an
    /// unwritable TMPDIR made the whole parity suite report PASS having asserted
    /// NOTHING (`TMPDIR=/proc/self/nope cargo test …` → "2 passed" in 0.00s), which is
    /// precisely the self-skip-presented-as-PASS this lifecycle forbids.
    ///
    /// The LAST such hole (round 2) was the result decode: `from_slice(&out.stdout).ok()`
    /// degraded a garbled reply to the same `None` skip. Anything on the interpreter's
    /// stdout — a `sitecustomize.py` that merely `print`s is enough — therefore disabled
    /// every parity assertion in the file while the suite still reported `ok`. A decode
    /// failure now PANICS with the raw stdout/stderr, and the spawn probe panics on
    /// `NotFound` too.
    fn run_select(src: &str, ctx_json: serde_json::Value) -> Vec<bool> {
        run_select_raw(src, &ctx_json.to_string())
    }

    /// `run_select` with the ctx supplied as RAW JSON TEXT.
    ///
    /// The corpus reader needs this because `serde_json` cannot spell a non-finite
    /// float (it renders `f64::INFINITY` as `null`), while a non-finite obs cell is
    /// entirely ordinary in a QC metric column. Python's `json.load` accepts the
    /// `Infinity` / `-Infinity` / `NaN` literals, so the corpus ctx is rendered as
    /// text (`corpus_ctx_json`) instead of through `serde_json::Value::to_string`.
    fn run_select_raw(src: &str, ctx_text: &str) -> Vec<bool> {
        use std::io::Write as _;
        match std::process::Command::new("python3").arg("--version").output() {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => panic!(
                "python3 is not on PATH. It is a build-and-test dependency of this repo \
                 (`just check-py`), and these tests verify that the ATTESTED replay script \
                 reproduces the committed mask — an absent interpreter is a failure to \
                 verify, never a pass: {e}"
            ),
            Err(e) => panic!("could not probe python3 (this is NOT 'python3 is absent'): {e}"),
        }
        let dir = std::env::temp_dir().join(format!("txresbench-run-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create temp dir for the emitted script");
        let py = dir.join("emitted.py");
        std::fs::File::create(&py)
            .expect("create emitted.py")
            .write_all(src.as_bytes())
            .expect("write emitted.py");
        // ROUND-3: the ctx travels as a UTF-8 FILE, not as a Rust-`Debug`-quoted
        // literal spliced into python source. `{:?}` escapes a non-printable char
        // to Rust's `\u{a0}` form, which is not python's `\uXXXX` — so ANY ctx
        // containing NBSP/BOM/control whitespace made the driver a SyntaxError, and
        // every non-ASCII parity case was unexpressible in this harness. (The
        // fullwidth/Arabic-digit cases survived only because those code points are
        // `Debug`-printable.) The dir name is a UUID, so the path itself is ascii.
        let ctx_path = dir.join("ctx.json");
        std::fs::File::create(&ctx_path)
            .expect("create ctx.json")
            .write_all(ctx_text.as_bytes())
            .expect("write ctx.json");
        let driver = dir.join("drive.py");
        let code = format!(
            "import json,sys\nsys.path.insert(0, {dir:?})\nimport emitted\nwith open({ctx:?}, encoding='utf-8') as fh:\n    _ctx = json.load(fh)\nprint(json.dumps(emitted.select(_ctx)))\n",
            dir = dir.display().to_string(),
            ctx = ctx_path.display().to_string(),
        );
        std::fs::File::create(&driver)
            .expect("create drive.py")
            .write_all(code.as_bytes())
            .expect("write drive.py");
        let out = std::process::Command::new("python3")
            .arg(&driver)
            .output()
            .expect("run the emitted script");
        // Clean up BEFORE the checks so the failure paths below can panic freely.
        let _ = std::fs::remove_dir_all(&dir);
        if !out.status.success() {
            panic!(
                "emitted script failed: {}\n--- source ---\n{src}",
                String::from_utf8_lossy(&out.stderr)
            );
        }
        match serde_json::from_slice::<Vec<bool>>(&out.stdout) {
            Ok(mask) => mask,
            Err(e) => panic!(
                "the emitted script exited 0 but its reply is not a boolean mask ({e}) — the \
                 parity assertions must NOT be skipped for this:\n--- stdout ---\n{}\n\
                 --- stderr ---\n{}\n--- source ---\n{src}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr),
            ),
        }
    }

    // TEST-37 (parity): the ONE decimal-bound grammar. Four parsers read these
    // strings; the grammar is what makes them agree. Every rejected spelling below
    // is one that at least one of {JS Number, Python float, Rust parse} accepts and
    // another does not — i.e. a recorded predicate that would constrain something
    // the committed mask did not, or the reverse.
    #[test]
    fn decimal_bound_grammar_is_the_intersection_of_all_three_parsers() {
        for ok in ["0", "1", "-2", "+3", "1.5", "1.", ".5", "1e3", "1E-3", "-1.5e+2"] {
            assert!(is_decimal_bound(ok), "must accept {ok:?}");
        }
        for bad in [
            "", " ", ".", "+", "-", "abc", "0x10", "0b1", "0o7", "1_0", "inf", "-inf", "Infinity",
            "nan", "NaN", "1e", "1e+", "1.2.3", "1 2",
        ] {
            assert!(!is_decimal_bound(bad), "must reject {bad:?}");
        }
        // …and the coercion follows the grammar (a `"0x10"` bound is UNBOUNDED here,
        // exactly as `float("0x10")` is in the mask).
        assert_eq!(bound(Some(&json!("0x10"))), None);
        assert_eq!(bound(Some(&json!("inf"))), None);
        assert_eq!(bound(Some(&json!(" 10 "))), Some(10.0));
        assert_eq!(bound(Some(&json!(""))), None);
        assert_eq!(bound(Some(&json!(10))), Some(10.0));
    }

    // TEST-38: a non-array `keep` is NOT a keep-set. `cell-filter.py` used to read
    // `len(c["keep"] or []) > 0`, which is true for the STRING "abc" (keep-set
    // {a,b,c}!), while this emitter required an array — the mask and the script
    // disagreeing about which KIND of filter the criterion is.
    #[test]
    fn a_non_array_keep_is_not_a_keep_set() {
        let cat = json!({"column": "x", "keep": ["a"]});
        let str_keep = json!({"column": "x", "keep": "abc"});
        assert!(criterion_is_categorical(cat.as_object().unwrap()));
        assert!(!criterion_is_categorical(str_keep.as_object().unwrap()));
    }

    // TEST-39: the emitted keep-set carries PYTHON's spelling of a non-string JSON
    // value. The mask compares `str(x)`, so `true`/`null` must emit `True`/`None`;
    // serde's `to_string()` spelling made the script keep NO cells for a boolean
    // keep-set the mask kept.
    //
    // BOUNDARY (deliberate, not an inconsistency): this is the LEGACY criteria dialect,
    // which reproduces the committed keep-mask verbatim and therefore must accept every
    // keep-set the mask does — booleans included. The DSL builder
    // (`criteriaPredicate.ts::isNumericKeepSet`) REFUSES a boolean keep-set, because the
    // DSL `in` is a numeric membership test and lifting one there would record a
    // predicate that reproduces the EMPTY selection (FINDING 12). Two dialects, two
    // correct answers: this one mirrors the mask, that one refuses to misrepresent it.
    #[test]
    fn keep_set_uses_pythons_spelling_for_non_strings() {
        let src = emit_criteria_script(
            "# t\n",
            &[json!({"column": "is_doublet", "keep": [true, false, null, 3]})],
        )
        .expect("emit");
        assert!(src.contains("\"True\""), "python True spelling: {src}");
        assert!(src.contains("\"False\""), "python False spelling: {src}");
        assert!(src.contains("\"None\""), "python None spelling: {src}");
        assert!(src.contains("\"3\""), "numbers already agreed: {src}");
        assert!(!src.contains("\"true\""), "never serde's spelling: {src}");
        assert!(!src.contains("\"null\""), "never serde's spelling: {src}");
    }

    // ── ROUND-4b (R4A-01/R4A-02): a CONTAINER keep value is REFUSED, never spelled ──

    /// RED ON REVERT: restore `keep_text`'s `other => other.to_string()` arm and this
    /// fails on the very first assert — the emitted set carries serde's `[1,2]`, which
    /// python's `str()` spells `[1, 2]`, so the attested replay computes the complement
    /// of the committed mask.
    #[test]
    fn an_unspellable_keep_value_is_dropped_from_the_emitted_set() {
        let src = emit_criteria_script(
            "# t\n",
            &[json!({"column": "x", "keep": ["T", [1, 2], {"b": 1, "a": 2}]})],
        )
        .expect("emit");
        // Inspect the emitted keep-set BINDING, not the whole script — the prelude's
        // own docstring quotes the container spellings it exists to refuse.
        let w0 = src
            .lines()
            .find(|l| l.trim_start().starts_with("_w0 = "))
            .expect("a `_w0` binding")
            .trim()
            .to_string();
        assert_eq!(w0, "_w0 = frozenset((\"T\",))", "only the SCALAR member: {src}");
        for serde_spelling in ["[1,2]", "[1, 2]", "{\\\"a\\\":2", "{'b': 1"] {
            assert!(
                !w0.contains(serde_spelling),
                "no container spelling may reach the emitted set ({serde_spelling}): {w0}"
            );
        }
        // …and it still CONSTRAINS on the scalar member.
        let m = run_select(&src, json!({ "n": 2, "columns": { "x": ["T", "B"] } }));
        assert_eq!(m, vec![true, false]);
    }

    /// A keep-set of ONLY unspellable values selects ZERO cells — it must NOT collapse
    /// to "no constraint" (which keeps every cell) and must not be refused as a
    /// no-constraint recipe. RED ON REVERT: put back the `wanted.is_empty()` skip and
    /// the emitter answers `Err(the criteria impose no constraint at all)`.
    #[test]
    fn a_keep_set_of_only_unspellable_values_still_constrains() {
        let src = emit_criteria_script("# t\n", &[json!({"column": "x", "keep": [[1]]})])
            .expect("a keep-set that selects nothing is still a selection");
        let m = run_select(&src, json!({ "n": 2, "columns": { "x": [1, 2] } }));
        assert_eq!(m, vec![false, false], "selects nothing, not everything: {src}");
    }

    /// The CELL side of the same gate: a keep value that is LITERALLY python's spelling
    /// of a container must not match a container CELL — only a real string cell.
    #[test]
    fn an_unspellable_cell_matches_no_keep_value() {
        let src = emit_criteria_script("# t\n", &[json!({"column": "x", "keep": ["[1, 2]"]})])
            .expect("emit");
        let m = run_select(
            &src,
            json!({ "n": 2, "columns": { "x": [[1, 2], "[1, 2]"] } }),
        );
        assert_eq!(m, vec![false, true], "the container cell never matches: {src}");
    }

    /// R4A-07: a NON-OBJECT entry in the criteria list is SKIPPED and the rest of the
    /// recipe still applies. RED ON REVERT: restore the `ok_or_else(malformed(…))?` and
    /// this returns `Err` while the kernel and the preview both filter on `q`.
    #[test]
    fn a_non_object_criterion_entry_is_skipped_not_fatal() {
        let src = emit_criteria_script(
            "# t\n",
            &[json!(null), json!("nope"), json!({"column": "q", "min": "5"})],
        )
        .expect("the readable criteria still apply");
        let m = run_select(&src, json!({ "n": 2, "columns": { "q": [1, 5] } }));
        assert_eq!(m, vec![false, true]);
        // …and a list of ONLY unreadable entries constrains nothing, so it is refused
        // exactly as an empty list is.
        assert!(emit_criteria_script("# t\n", &[json!(null), json!(7)]).is_err());
    }

    /// R4A-09: a non-STRING `column` names no obs column — no constraint, no panic.
    #[test]
    fn a_non_string_column_names_no_column() {
        for col in [json!(5), json!(null), json!(["q"]), json!({"a": 1})] {
            let r = emit_criteria_script("# t\n", &[json!({"column": col, "min": "1"})]);
            assert!(r.is_err(), "{col} imposes no constraint, so nothing to record");
        }
    }

    // ── F2-7: the emitted keep-set's NUMERIC twin ───────────────────────────────

    /// The `_wNn` line of an emitted criteria script (the EMITTED TEXT, not an
    /// intermediate — the whole defect was that an intermediate looked right).
    fn emitted_twin(keep: serde_json::Value) -> String {
        let src = emit_criteria_script("# t\n", &[json!({ "column": "leiden", "keep": keep })])
            .expect("emit");
        src.lines()
            .find(|l| l.trim_start().starts_with("_w0n = "))
            .unwrap_or_else(|| panic!("no `_w0n` binding in the emitted script:\n{src}"))
            .trim()
            .to_string()
    }

    // The twin used to be recovered by re-parsing the RENDERED python literals with
    // `q.trim_matches('\'')` while `py_str` quotes with `"`. Every value therefore
    // failed `is_decimal_bound` and `_w0n` was ALWAYS `frozenset(())` — the
    // dtype-independence fallback the emitted script advertises was dead, so a
    // keep-set of ["1","2"] over a float column replayed all-False while the
    // committed mask kept those cells.
    // RED ON REVERT: restore the `wanted.iter().filter_map(|q| q.trim_matches('\''))`
    // derivation and every assertion below reports `frozenset(())`.
    #[test]
    fn keep_set_numeric_twin_is_built_from_the_source_values() {
        // numeric STRINGS — the real declarative-UI path (a multiselect posts strings)
        assert_eq!(emitted_twin(json!(["1", "2"])), "_w0n = frozenset((1.0, 2.0))");
        // JSON NUMBERS — `n.as_f64()`, never a re-parse of the rendering
        assert_eq!(emitted_twin(json!([1, 2])), "_w0n = frozenset((1.0, 2.0))");
        // a float spelling, and a 1-element tuple keeps its trailing comma
        assert_eq!(emitted_twin(json!(["1.0"])), "_w0n = frozenset((1.0,))");
        // exponent + negative zero (both plain decimal notation)
        assert_eq!(emitted_twin(json!(["1e3"])), "_w0n = frozenset((1000.0,))");
        assert_eq!(emitted_twin(json!(["-0"])), "_w0n = frozenset((-0.0,))");
        // a GENUINELY non-numeric keep-set stays empty — the string compare is the
        // whole match rule there, and inventing numbers would widen the filter.
        assert_eq!(emitted_twin(json!(["T", "NK"])), "_w0n = frozenset(())");
        // …and so do the spellings outside the ONE grammar (`_bound_or_none` rejects
        // them too), and the non-numeric python spellings of bools/null.
        assert_eq!(emitted_twin(json!(["0x10", "inf", "1_0"])), "_w0n = frozenset(())");
        assert_eq!(emitted_twin(json!([true, false, null, 3])), "_w0n = frozenset((3.0,))");
        // the STRING half is unchanged by all of this (it is what the mask matches first)
        let src = emit_criteria_script("# t\n", &[json!({ "column": "leiden", "keep": ["1", "2"] })])
            .expect("emit");
        assert!(src.contains(r#"_w0 = frozenset(("1", "2"))"#), "{src}");
        assert!(src.contains("_keep_in(_c0, i, _w0, _w0n)"), "{src}");
    }

    // ROUND-3 / F3-2 — the emitted RANGE branch must coerce an obs CELL by exactly
    // the rule the COMMITTED kernel used, because `code_sha256` is sold to the user
    // as "replaying this script reproduces the cell set that was committed".
    //
    // `CRITERIA_PRELUDE::_num` was a bare `float(x)`. Python's `float()` accepts
    // NON-ASCII decimal digits (`float("１２３") == 123.0`, `float("١٢٣") == 123.0` —
    // what a CJK or Arabic IME emits for ordinary typing) and coerces a `bool`.
    // `cell-filter.py::_value_float` — the kernel that produced the committed mask —
    // refuses both (`if isinstance(x, str) and not x.strip().isascii()` / `isinstance
    // (x, bool)` → NaN → dropped). So over a string obs column of fullwidth or
    // Arabic-Indic digits the attested replay KEPT cells the commit DROPPED.
    //
    // Note the SAME prelude's keep-set half (`_decimal`) already had the ascii gate,
    // so before this fix the two branches of one emitted script disagreed with each
    // other. The strip is python's own (Unicode) one and happens BEFORE the ascii
    // test, verbatim as in `_value_float`: an NBSP-PADDED ascii number must stay
    // acceptable (JS `Number()` trims the Unicode set too), so gating the RAW string
    // would open a new divergence in the opposite direction.
    //
    // RED ON REVERT: restore `_num` to a bare `float(x)` guarded only by `x is None`
    // and both the fullwidth and the Arabic-Indic cell flip to `true`.
    #[test]
    fn the_emitted_range_branch_coerces_cells_exactly_as_the_committed_kernel_does() {
        let src = emit_criteria_script(
            "# t\n",
            &[json!({ "column": "qc", "control": "range", "min": "1", "max": "200" })],
        )
        .expect("emit");

        // A string obs column carrying non-ASCII digits. The committed kernel reads
        // every one of these as NaN and DROPS the cell; "50" is the positive control
        // that proves the range itself still selects.
        // NOT `if let Some(..)`. `run_select` returns None when python3 is absent and
        // says so with an `eprintln!`, which libtest CAPTURES — so the usual `if let`
        // wrapper makes this test report `ok` with the F3-2 defect fully present on any
        // python3-less host. Verified by the round-3 fix review: with the defect
        // re-introduced and PATH emptied, the `if let` form printed `test result: ok`.
        // This test guards an attestation invariant, so an absent interpreter is a
        // FAILURE to verify, not a pass.
        {
            let m = run_select(
                &src,
                json!({ "n": 4, "columns": { "qc": ["１２３", "١٢٣", "50", "999"] } }),
            );
            assert_eq!(
                m,
                vec![false, false, true, false],
                "a non-ASCII-digit cell is NA to the committed kernel, so the attested \
                 replay must drop it too"
            );
        }
        // An NBSP-padded ASCII number must STILL be accepted (the opposite-direction
        // regression the ordering of the two guards exists to prevent).
        {
            let m = run_select(&src, json!({ "n": 2, "columns": { "qc": ["\u{a0}50", "999"] } }));
            assert_eq!(m, vec![true, false], "an NBSP-padded ascii number is still numeric");
        }
        // A boolean cell reads as 1.0 — the branch a bool obs column actually takes
        // in the kernel (`dtype.kind == "b"` is in "biuf" → `astype(float)`), and what
        // `primitives.ts::parseValue` answers too. `_value_float`'s bool→NaN rule is on
        // the OBJECT-dtype branch a bool column does not reach.
        {
            let m = run_select(&src, json!({ "n": 2, "columns": { "qc": [true, 999] } }));
            assert_eq!(m, vec![true, false], "a bool cell is 1.0, inside [1,200]");
        }
    }

    // …and EXECUTE it. The kernel rule (`cell-filter.py::criteria_keep_mask`) is
    // `str(cell) in wanted or _bound_or_none(str(cell)) in wanted_nums`, so a keep-set
    // of ["1","2"] keeps the same cells whether the column's dtype spells its 1 as
    // "1" (int/categorical) or "1.0" (float). With the dead twin the float column
    // replayed [False, False, False] against the mask's [True, True, False].
    // RED ON REVERT: the float and mixed cases fail; the int case passes either way
    // (it is the positive control that isolates the defect to the numeric fallback).
    #[test]
    fn emitted_keep_set_replays_the_committed_mask_on_float_and_int_columns() {
        let src = emit_criteria_script("# t\n", &[json!({ "column": "leiden", "keep": ["1", "2"] })])
            .expect("emit");

        // FLOAT column — cells spell themselves "1.0"/"2.0"/"3.0"; only the numeric
        // twin can match them.
        let m = run_select(&src, json!({ "n": 3, "columns": { "leiden": [1.0, 2.0, 3.0] } }));
        assert_eq!(m, vec![true, true, false], "float column: the numeric twin matches");
        // INT column — the string compare already matched (positive control).
        let m = run_select(&src, json!({ "n": 3, "columns": { "leiden": [1, 2, 3] } }));
        assert_eq!(m, vec![true, true, false], "int column: the string compare matches");
        // CATEGORICAL (string) column — the dtype the keep-set was authored against.
        let m = run_select(&src, json!({ "n": 3, "columns": { "leiden": ["1", "2", "3"] } }));
        assert_eq!(m, vec![true, true, false], "string column: unchanged");

        // The MIXED case, which was the worst: inside the `and` the dead twin
        // collapsed the WHOLE mask to all-False, so the run's `code_sha256` attested
        // to a script that selected NOTHING.
        let mixed = emit_criteria_script(
            "# t\n",
            &[
                json!({ "column": "pct_mito", "control": "range", "max": "10" }),
                json!({ "column": "leiden", "keep": ["1", "2"] }),
            ],
        )
        .expect("emit");
        let m = run_select(
            &mixed,
            json!({
                "n": 4,
                "columns": {
                    "pct_mito": [1.0, 5.0, 50.0, 2.0],
                    "leiden": [1.0, 2.0, 1.0, 3.0],
                }
            }),
        );
        assert_eq!(
            m,
            vec![true, true, false, false],
            "range AND keep-set: the categorical half must not zero the mask"
        );

        // A non-numeric keep-set still matches purely by string (the empty twin is
        // correct there, not a regression).
        let cat = emit_criteria_script(
            "# t\n",
            &[json!({ "column": "cell_type", "keep": ["T", "NK"] })],
        )
        .expect("emit");
        let m = run_select(&cat, json!({ "n": 3, "columns": { "cell_type": ["T", "B", "NK"] } }));
        assert_eq!(m, vec![true, false, true], "categorical: string compare only");
    }

    // ── ROUND-4: the SHARED criteria-coercion parity corpus ─────────────────────
    //
    // `src-app/testdata/criteria-coercion-corpus.json` is read by FOUR readers — this
    // emitter (below), the committed kernel (`scripts/coercion-parity-kernel.py`), the
    // live preview and the DSL builder (`scripts/coercion-parity-ts.mjs`) — and the
    // cross-language orchestrator `scripts/coercion-parity.mjs` requires all four to
    // agree cell-for-cell. This test is the emitter's own gate, so a coercion
    // regression fails `cargo test` without needing node or the orchestrator; see
    // `src-app/testdata/README-coercion-corpus.md` for the ONE coercion rule the
    // corpus encodes.

    #[derive(serde::Deserialize)]
    struct CorpusCase {
        id: String,
        criteria: Vec<serde_json::Value>,
        obs: serde_json::Map<String, serde_json::Value>,
        expect: Vec<bool>,
    }

    #[derive(serde::Deserialize)]
    struct Corpus {
        cases: Vec<CorpusCase>,
    }

    fn corpus_path() -> std::path::PathBuf {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../testdata/criteria-coercion-corpus.json")
    }

    /// Render a corpus value as PYTHON-JSON text.
    ///
    /// `serde_json` cannot spell a non-finite float (it emits `null` for
    /// `f64::INFINITY`), and a non-finite obs cell is entirely ordinary in a QC metric
    /// column — so the corpus escapes them as `{"$special":"inf"|"-inf"|"nan"}` and
    /// this renders them as the `Infinity` / `-Infinity` / `NaN` literals python's
    /// `json.load` accepts. Everything else is serde's own rendering.
    fn corpus_py_json(v: &serde_json::Value) -> String {
        match v {
            serde_json::Value::Object(o) => {
                if o.len() == 1 {
                    if let Some(serde_json::Value::String(s)) = o.get("$special") {
                        return match s.as_str() {
                            "inf" => "Infinity".to_string(),
                            "-inf" => "-Infinity".to_string(),
                            "nan" => "NaN".to_string(),
                            other => panic!("unknown corpus $special {other:?}"),
                        };
                    }
                }
                let body: Vec<String> = o
                    .iter()
                    .map(|(k, val)| {
                        format!(
                            "{}:{}",
                            serde_json::Value::String(k.clone()),
                            corpus_py_json(val)
                        )
                    })
                    .collect();
                format!("{{{}}}", body.join(","))
            }
            serde_json::Value::Array(a) => {
                let body: Vec<String> = a.iter().map(corpus_py_json).collect();
                format!("[{}]", body.join(","))
            }
            other => other.to_string(),
        }
    }

    /// The emitter's answer for one corpus case: the replayed mask, or the refusal
    /// message when the criteria impose NO constraint at all (which the emitter
    /// deliberately declines to record as a "selection").
    fn corpus_emitter_mask(case: &CorpusCase) -> Result<Vec<bool>, String> {
        let src = match emit_criteria_script("# corpus\n", &case.criteria) {
            Ok(s) => s,
            Err(e) => return Err(format!("{e}")),
        };
        let n = case
            .obs
            .values()
            .filter_map(|v| v.as_array().map(|a| a.len()))
            .max()
            .unwrap_or(0);
        let cols: Vec<String> = case
            .obs
            .iter()
            .map(|(k, v)| {
                format!(
                    "{}:{}",
                    serde_json::Value::String(k.clone()),
                    corpus_py_json(v)
                )
            })
            .collect();
        let ctx = format!("{{\"n\":{n},\"columns\":{{{}}}}}", cols.join(","));
        Ok(run_select_raw(&src, &ctx))
    }

    /// The corpus' EXACT case-id set — the shrink guard (ROUND-6 / B2). See the
    /// bidirectional assertions in `the_emitted_replay_matches_the_shared_coercion_corpus`.
    const CORPUS_CASE_IDS: [&str; 127] = [
        "A00-bound-plain",
        "A01-bound-exponent",
        "A02-bound-leading-dot",
        "A03-bound-trailing-dot",
        "A04-bound-signed",
        "A05-bound-ascii-padded",
        "A06-bound-hex-unbounded",
        "A07-bound-underscore-unbounded",
        "A08-bound-inf-unbounded",
        "A09-bound-Infinity-unbounded",
        "A10-bound-nan-unbounded",
        "A11-bound-empty-unbounded",
        "A12-bound-nbsp-padded-unbounded",
        "A13-bound-fullwidth-digits-unbounded",
        "A14-bound-arabic-digits-unbounded",
        "A15-bound-number-json",
        "A16-bound-bool-unbounded",
        "A17-bound-null-unbounded",
        "A18-bound-array-unbounded",
        "A19-bound-object-unbounded",
        "B00-cell-plain",
        "B01-cell-exponent",
        "B02-cell-leading-dot",
        "B03-cell-trailing-dot",
        "B04-cell-signed",
        "B05-cell-hex",
        "B06-cell-octal",
        "B07-cell-binary",
        "B08-cell-underscore",
        "B09-cell-inf-word",
        "B10-cell-nan-word",
        "B11-cell-infinity-word",
        "B12-cell-double-dot",
        "B13-cell-interior-space",
        "C00-pad-space",
        "C01-pad-tab",
        "C02-pad-newline",
        "C03-pad-cr",
        "C04-pad-ff",
        "C05-pad-vt",
        "C06-pad-nbsp",
        "C07-pad-figure-space",
        "C08-pad-ideographic-space",
        "C09-pad-thin-space",
        "C10-pad-ogham-space",
        "C11-pad-line-sep",
        "C12-pad-para-sep",
        "C13-pad-narrow-nbsp",
        "C14-pad-mmsp",
        "C15-pad-bom",
        "C16-pad-nel",
        "C17-pad-fs",
        "C18-pad-us",
        "D00-cell-fullwidth-digits",
        "D01-cell-arabic-indic-digits",
        "D02-cell-devanagari-digits",
        "E00-cell-null",
        "E01-cell-empty",
        "E02-cell-blank",
        "E03-cell-inf",
        "E04-cell-nonfinite-unbounded",
        "E05-cell-array",
        "E06-cell-object",
        "E07-cell-negative-zero",
        "E08-cell-half-bounded-min",
        "E09-cell-half-bounded-max",
        "F00-bool-cells-in-range",
        "F01-bool-cells-zero-kept",
        "G00-keep-string-col",
        "G01-keep-int-col",
        "G02-keep-float-col",
        "G03-keep-numeric-json",
        "G04-keep-categorical",
        "G05-keep-exponent",
        "G06-keep-empty-noop",
        "G07-keep-non-list",
        "H00-keep-bool-true",
        "H01-keep-bool-json",
        "H02-keep-null",
        "H03-keep-inf",
        "H04-keep-ninf",
        "H05-keep-nan",
        "H06-keep-nested-array",
        "H07-cell-nested-array-vs-scalar-keep",
        "H08-keep-object",
        "H09-keep-only-null",
        "I00-and-two-ranges",
        "I01-and-range-and-keep",
        "I02-and-order-swapped",
        "I03-absent-column",
        "I04-absent-plus-real",
        "I05-padded-column-name",
        "I06-explicit-control-range-wins",
        "I07-shape-inferred-categorical",
        "J00-colname-fs",
        "J01-colname-us",
        "J02-colname-nel",
        "J03-colname-bom",
        "J04-colname-nbsp",
        "J05-colname-ascii-padded",
        "J06-keep-lowercase-true",
        "J07-keep-True-matches",
        "J08-keep-numeric-fallback-widens",
        "J09-keep-numeric-fallback-does-not-widen-to-non-decimals",
        "J10-keep-tiny-exponent",
        "J11-absent-column-with-keep-set",
        "H10-keep-array-multi-element",
        "H11-keep-array-string-member",
        "H12-keep-array-bool-member",
        "H13-keep-array-null-member",
        "H14-keep-array-float-member",
        "H15-keep-object-key-order",
        "H16-cell-container-vs-literal-string-keep",
        "H17-keep-mixed-scalar-and-container",
        "H18-keep-all-containers-still-constrains",
        "H19-keep-object-vs-its-python-spelling",
        "K00-criteria-empty-list",
        "K01-criteria-null-entry",
        "K02-criteria-string-entry",
        "K03-criteria-only-non-object-entries",
        "K04-column-number",
        "K05-column-null",
        "K06-column-array",
        "G08-keep-cell-ascii-padded-does-not-match",
        "G09-keep-cell-nbsp-padded-does-not-match",
        "E10-cell-nonfinite-one-sided-bound",
        "L00-ragged-obs-columns-pad-kept",
    ];

    #[test]
    fn the_emitted_replay_matches_the_shared_coercion_corpus() {
        let text = std::fs::read_to_string(corpus_path()).unwrap_or_else(|e| {
            panic!(
                "the shared coercion corpus is REQUIRED, never optional — it is what makes \
                 the attested replay, the committed kernel and the live preview one rule \
                 ({:?}): {e}",
                corpus_path()
            )
        });
        let corpus: Corpus = serde_json::from_str(&text).expect("parse the coercion corpus");
        // BIDIRECTIONAL, like the capsule's `ALWAYS_MEMBERS` + undeclared-member
        // allow-list (`tests/dataset/capsule_manifest_test.rs`).
        //
        // ROUND-6 (B2): this was `>= 80` against a committed 123 with nothing pinning
        // case IDENTITY, so DELETING a case was an unguarded way to hide a divergence —
        // proven by deleting `H16` while reintroducing the real kernel defect it guards
        // (`_cat_hit`'s container gate): the whole gate stayed at rc 0 and printed "the 3
        // MASK readers agree cell-for-cell on all 122". A one-directional guard is the
        // exact defect this branch fixed for the capsule manifest, shipped again here.
        //
        // Deliberately a hand-maintained list, NOT derived from the file: a new case makes
        // this RED and the only way to green is to come here and declare it. Do not
        // "simplify" it into a bare count or a prefix rule — that makes the corpus
        // self-certifying and the guard vacuous.
        let ids: Vec<&str> = corpus.cases.iter().map(|c| c.id.as_str()).collect();
        for want in CORPUS_CASE_IDS {
            assert!(
                ids.contains(&want),
                "the coercion corpus LOST case {want} — a deleted case is how a real \
                 divergence gets hidden; restore it, or remove it from CORPUS_CASE_IDS \
                 deliberately"
            );
        }
        for got in &ids {
            assert!(
                CORPUS_CASE_IDS.contains(got),
                "undeclared coercion corpus case {got} — declare it in CORPUS_CASE_IDS"
            );
        }
        assert_eq!(
            ids.len(),
            CORPUS_CASE_IDS.len(),
            "the corpus has duplicate case ids"
        );

        // The runner writes every case's answer so `scripts/coercion-parity.mjs` can
        // diff this reader against the other three without re-running cargo's harness.
        let mut dump = serde_json::Map::new();
        let mut failures: Vec<String> = Vec::new();
        for case in &corpus.cases {
            let all_true = case.expect.iter().all(|b| *b);
            match corpus_emitter_mask(case) {
                Ok(mask) => {
                    dump.insert(case.id.clone(), json!({ "mask": mask }));
                    if mask != case.expect {
                        failures.push(format!(
                            "{}: emitted replay {mask:?} != corpus {:?}",
                            case.id, case.expect
                        ));
                    }
                }
                Err(msg) => {
                    dump.insert(case.id.clone(), json!({ "refused": msg }));
                    // A refusal is CORRECT exactly when the case constrains nothing: an
                    // all-true "selection" must not be recordable (that is the degenerate
                    // state this whole feature exists to catch).
                    if !all_true {
                        failures.push(format!(
                            "{}: the emitter REFUSED a constraining recipe ({msg}) — the \
                             corpus expects {:?}",
                            case.id, case.expect
                        ));
                    }
                }
            }
        }
        let out = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/coercion-parity-rust.json");
        if let Some(parent) = out.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&out, serde_json::Value::Object(dump).to_string());
        assert!(
            failures.is_empty(),
            "{} of {} corpus cases disagree with the emitted replay:\n{}",
            failures.len(),
            corpus.cases.len(),
            failures.join("\n")
        );
    }
}
