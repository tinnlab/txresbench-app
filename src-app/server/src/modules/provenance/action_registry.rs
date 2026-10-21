//! Action registry (ITEM-13): action-type → `{fidelity class, recipe dialect}`, so
//! every future manual feature plugs the SAME capture seam. `selection.*` **and**
//! `subset.filter` (filter-provenance ITEM-10 — a committed keep-mask is a durable,
//! replayable selection) are dispatchable; the `annotate.*`/`group.*` vocabulary is
//! reserved (enumerated but NOT dispatchable).
//!
//! ## The vocabulary is OPEN (S4)
//!
//! The built-in list above is no longer the whole registry: a package declares its
//! own gesture under `contributes.actions` in its `manifest.yaml`
//! (`{action_type, fidelity, dispatchable, recipe}`) and [`catalog`] folds it in, so
//! a new capturable interaction needs no server rebuild. A contribution declares
//! only the recipe DIALECT it posts — never source — because the emitted script is
//! the attested artifact and a manifest must never be able to inject python.
//!
//! ## The recipe dialects (filter-provenance ITEM-10/ITEM-18, S4)
//!
//! `emit_code` reads the FLAT [`super::interaction::SelectionRecipe`] shapes —
//! `{col, op, val}` / `{column_ref, labels}` / `{ids}` / `{coords_ref, polygon}` /
//! `{op, refs}` (see [`payload_keys`]) — plus the `criteria` array, which
//! [`super::criteria_script`] compiles. EVERY dialect emits the same domain-free
//! `select(ctx)` module (see [`SELECTION_PRELUDE`]): the artifact this server
//! attests to may not presume one domain's container library or a fixed axis.
//!
//! (A predicate-DSL envelope nesting the selection under `predicate` was a third
//! dialect; it has been scrapped, so such a recipe is now a loud
//! [`EmitError::MalformedRecipe`] rather than a silently different script.)
//!
//! A recipe the emitter cannot read (a missing field, a shape this build cannot
//! honestly reproduce) is an [`EmitError::MalformedRecipe`] — **the emitter never
//! falls back to a placeholder script**, because the emitted source's sha256 IS the
//! run's recorded `code_sha256`, i.e. the reproducibility claim itself.

use std::fmt::Write as _;

use serde_json::Value;

pub use super::criteria_script::EmitError;
use super::criteria_script::{emit_criteria_script, py_comment, py_str};

// ════════════════════════════════════════════════════════════════════════════════
//  RECIPE PAYLOAD KEYS — the wire names, which must describe a SHAPE, not a domain
// ════════════════════════════════════════════════════════════════════════════════
//
// `ActionRecipeDialect`'s own doc says each variant "names a payload shape, never a
// domain". Two of its keys did not honour that: `LabelSet`'s and `Polygon`'s were both
// `<contributed-datatype-id>_<suffix>` — the app naming two of a PACKAGE's types in its
// own wire vocabulary. Both former spellings are the negative control in
// `no_recipe_payload_key_names_a_contributed_datatype`, which is where they may still
// be written down (that test is `#[cfg(test)]`, so it never ships).
//
// Neither key ever meant what it said. The `LabelSet` one is a COLUMN NAME looked up in
// `ctx["columns"]` (`_col` raises if it is absent or the wrong length). The `Polygon`
// one is a free-form attestation string rendered onto a python COMMENT line, pinning
// which coordinate source the polygon was drawn over; the coordinates themselves come
// from `ctx["coords"]`, and nothing verifies the two agree. So both rename to what they
// ARE, with no behaviour change.
//
// NO LEGACY ALIAS, deliberately. The old spellings were reachable only through
// `POST /provenance/selections` + `/actions`, and nothing produced them: the only
// shipping client posts `subset.filter` (the `Criteria` dialect), `SelectionRecipe` is
// never deserialized off the row (`capture_selection` takes a raw `Value`), and no
// replay path re-emits from a stored recipe — the emitted source is stored at capture.
// Carrying an alias would keep the two datatype ids in app code permanently to serve a
// wire nobody speaks, which is the "half-present, looks wired" shape this module's
// siblings already argue against.

/// The column NAME a `LabelSet` recipe tests membership in (`ctx["columns"][…]`).
const KEY_COLUMN_REF: &str = "column_ref";
/// The coordinate SOURCE a `Polygon` recipe was drawn over — an attestation string
/// pinned onto a comment line, never resolved.
const KEY_COORDS_REF: &str = "coords_ref";

/// Every payload key a dialect reads out of its recipe.
///
/// A SECOND declaration of what the emitter arms below read, and it exists to be
/// asserted against (`no_recipe_payload_key_names_a_contributed_datatype`): the arms
/// are prose to any guard, so the property "no wire key of ours names a contributed
/// datatype id" has to be checkable against a value. The `match` is exhaustive, so a
/// NEW dialect cannot be added without stating its keys here; a new key added to an
/// EXISTING arm still has to be added by hand, which is the residual drift this shape
/// does not close.
pub fn payload_keys(dialect: RecipeDialect) -> &'static [&'static str] {
    match dialect {
        RecipeDialect::Criteria => &["criteria"],
        RecipeDialect::ColumnCompare => &["col", "op", "val"],
        RecipeDialect::LabelSet => &[KEY_COLUMN_REF, "labels"],
        RecipeDialect::IdList => &["ids"],
        RecipeDialect::Polygon => &[KEY_COORDS_REF, "polygon"],
        RecipeDialect::SetOp => &["op", "refs"],
    }
}

/// Every dialect this build compiles — the CLOSED set, enumerated as a value so it can
/// be walked. Kept honest by [`dialect_index`], which is an exhaustive `match`: a new
/// variant fails to compile there rather than being quietly left out of this array.
pub const ALL_DIALECTS: [RecipeDialect; 6] = [
    RecipeDialect::Criteria,
    RecipeDialect::ColumnCompare,
    RecipeDialect::LabelSet,
    RecipeDialect::IdList,
    RecipeDialect::Polygon,
    RecipeDialect::SetOp,
];

/// The position of a dialect in [`ALL_DIALECTS`]. Exists ONLY so that array cannot go
/// stale: this `match` is exhaustive, so adding a variant is a compile error here.
fn dialect_index(dialect: RecipeDialect) -> usize {
    match dialect {
        RecipeDialect::Criteria => 0,
        RecipeDialect::ColumnCompare => 1,
        RecipeDialect::LabelSet => 2,
        RecipeDialect::IdList => 3,
        RecipeDialect::Polygon => 4,
        RecipeDialect::SetOp => 5,
    }
}

/// The first SEGMENT of `key` (split on `_ - . /`) that is a contributed datatype id,
/// or the whole key when it IS one. The segment split is what the shape needs: a leak
/// here is never a bare id, it is an id used as a STEM (`clustering_ref`), and a whole-
/// literal comparison — which is exactly what the app's own domain grep-guard does —
/// cannot see that.
fn contributed_id_in_key<'a>(key: &'a str, ids: &[String]) -> Option<&'a str> {
    std::iter::once(key)
        .chain(key.split(['_', '-', '.', '/']))
        .find(|seg| ids.iter().any(|id| id == seg))
}

/// The ONLY comparators a legacy flat `selection.column` recipe may carry.
///
/// The legacy arm splices `op` straight into emitted python (`adata.obs[c] {op} v`),
/// so an unconstrained `op` is arbitrary source: `"== 1\nimport os\n#"` appends a
/// module-scope statement. An allow-list is the correct guard here — unlike a
/// column NAME (which is data and is escaped), an operator IS syntax, and there is
/// no escaping that makes an arbitrary operator safe. Anything outside the list is
/// a LOUD `MalformedRecipe` (ITEM-18's no-placeholder rule: never silently coerce
/// an unreadable recipe into a script whose sha256 becomes the run's claim).
const LEGACY_COMPARATORS: [&str; 6] = ["==", "!=", "<", "<=", ">", ">="];

/// The ONLY set operations a legacy flat `selection.setop` recipe may carry
/// (mirrors the DSL's set combinators). Same reasoning as `LEGACY_COMPARATORS`:
/// `op` reaches emitted source, so it is allow-listed, not escaped.
const LEGACY_SETOPS: [&str; 8] =
    ["union", "intersect", "difference", "xor", "andnot", "and", "or", "not"];

/// Validate an operator against an allow-list, or fail loudly.
fn allowed_op<'a>(op: &'a str, allowed: &[&str], what: &str) -> Result<&'a str, EmitError> {
    if allowed.contains(&op) {
        return Ok(op);
    }
    Err(EmitError::MalformedRecipe(format!(
        "unsupported {what} {:?}; expected one of {allowed:?}",
        py_comment(op)
    )))
}

/// Render a JSON value as a PYTHON literal.
///
/// Replaces a former `{:?}`-based renderer that had two defects: Rust's debug
/// escape emits `\u{1f600}` (which python does NOT parse — a syntax error), and a
/// nested array/object was passed through as raw JSON (`true`/`false`/`null` are
/// not python). Strings go through [`py_str`], so a hostile identifier is escaped
/// exactly as the DSL emitter escapes one. The element separator is `,` (no
/// space), preserving the legacy emitter's byte shape.
fn py_literal(v: &Value) -> String {
    match v {
        Value::Null => "None".into(),
        Value::Bool(b) => if *b { "True" } else { "False" }.into(),
        // A JSON number's textual form is always a valid python numeric literal.
        Value::Number(n) => n.to_string(),
        Value::String(s) => py_str(s),
        Value::Array(a) => {
            format!("[{}]", a.iter().map(py_literal).collect::<Vec<_>>().join(","))
        }
        Value::Object(o) => format!(
            "{{{}}}",
            o.iter()
                .map(|(k, v)| format!("{}:{}", py_str(k), py_literal(v)))
                .collect::<Vec<_>>()
                .join(",")
        ),
    }
}

/// A python TUPLE literal from already-rendered elements (a 1-tuple keeps its
/// trailing comma so it stays a tuple).
fn py_tuple(items: &[String]) -> String {
    match items.len() {
        0 => "()".to_string(),
        1 => format!("({},)", items[0]),
        _ => format!("({})", items.join(", ")),
    }
}

/// The DOMAIN-FREE runtime prelude every flat `selection.*` script carries.
///
/// ## Why this exists (S4 — the attested artifact could not run)
///
/// The emitted script's sha256 IS the run's recorded `code_sha256`, i.e. the
/// reproducibility claim itself. The five flat arms used to emit
///
/// ```text
///   mask = adata.obs["c"] == v          # names a container library + a fixed axis
///   mask = adata.obs_names.isin([...])  #  "
///   mask = points_in_polygon(embedding, recipe['polygon'])   # undefined names
///   mask = apply_setop(recipe)                                # undefined names
/// ```
///
/// Three of those cannot execute ANYWHERE (`points_in_polygon` / `apply_setop` /
/// `recipe` are not defined by anything the bundle ships), and the other two are a
/// `NameError` on any deployment whose data is not an AnnData object. So the value
/// presented as the reproducibility guarantee was the hash of a script that does
/// not run.
///
/// The replacement is the SAME `select(ctx)` contract the criteria emitter already
/// uses, over a `ctx` that names no domain:
///
/// | key | meaning |
/// |---|---|
/// | `ctx["n"]` | the element count of the selected axis (required) |
/// | `ctx["columns"][name]` | a length-`n` annotation column |
/// | `ctx["ids"]` | the length-`n` stable element ids |
/// | `ctx["coords"]` | the length-`n` `[x, y]` positions in the pinned 2-D projection |
/// | `ctx["sets"][ref]` | a named prior selection: a length-`n` boolean mask OR an id list |
///
/// Every accessor RAISES on a `ctx` that cannot honestly answer (an absent column,
/// a length that disagrees with `n`) rather than degrading to an all-true /
/// all-false mask — a silently wrong replay is worse than a loud one, because the
/// whole artifact exists to be believed.
const SELECTION_PRELUDE: &str = r#"def _n(ctx):
    return int(ctx["n"])


def _col(ctx, n, key):
    """The named annotation column as a length-n list.

    An ABSENT column, or one whose length disagrees with `n`, RAISES: this ctx
    cannot reproduce the recorded selection, and answering an all-true or
    all-false mask would attest to a set that was never selected."""
    cols = ctx.get("columns") or {}
    if key not in cols or cols[key] is None:
        raise KeyError("selection column %r is not present in ctx['columns']" % (key,))
    col = list(cols[key])
    if len(col) != n:
        raise ValueError(
            "selection column %r has %d values but ctx['n'] is %d" % (key, len(col), n)
        )
    return col


def _seq(ctx, n, key):
    """A length-n per-element sequence (`ids` / `coords`). Same raise-don't-guess
    rule as `_col`."""
    v = ctx.get(key)
    if v is None:
        raise KeyError("this selection needs ctx[%r]" % (key,))
    seq = list(v)
    if len(seq) != n:
        raise ValueError("ctx[%r] has %d entries but ctx['n'] is %d" % (key, len(seq), n))
    return seq


def _set_mask(ctx, n, ref):
    """A referenced prior selection as a length-n boolean mask.

    Accepts either spelling a caller can hold: a length-n boolean mask, or a list
    of element ids (resolved against `ctx['ids']`)."""
    sets = ctx.get("sets") or {}
    if ref not in sets or sets[ref] is None:
        raise KeyError("this set operation needs ctx['sets'][%r]" % (ref,))
    v = list(sets[ref])
    if len(v) == n and all(isinstance(x, bool) for x in v):
        return [bool(x) for x in v]
    wanted = frozenset(str(x) for x in v)
    ids = _seq(ctx, n, "ids")
    return [str(ids[i]) in wanted for i in range(n)]


def _xor(vals):
    r = False
    for v in vals:
        r = r != bool(v)
    return r


def _in_poly(pt, poly):
    """Even-odd ray casting; a vertex/edge point counts as inside on the two
    edges the rule already includes, exactly as any standard implementation."""
    x = float(pt[0])
    y = float(pt[1])
    inside = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi = float(poly[i][0])
        yi = float(poly[i][1])
        xj = float(poly[j][0])
        yj = float(poly[j][1])
        if (yi > y) != (yj > y):
            t = (y - yi) / (yj - yi)
            if x < xi + t * (xj - xi):
                inside = not inside
        j = i
    return inside
"#;

pub use crate::modules::extensions::types::{
    ActionContribution, ActionFidelity as FidelityClass, ActionRecipeDialect as RecipeDialect,
};

impl RecipeDialect {
    /// The wire spelling (also what an error message names).
    pub fn as_str(self) -> &'static str {
        match self {
            RecipeDialect::Criteria => "criteria",
            RecipeDialect::ColumnCompare => "column_compare",
            RecipeDialect::LabelSet => "label_set",
            RecipeDialect::IdList => "id_list",
            RecipeDialect::Polygon => "polygon",
            RecipeDialect::SetOp => "set_op",
        }
    }
}

/// A registered action type.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActionSpec {
    pub action_type: String,
    pub fidelity: FidelityClass,
    /// Whether the interaction chokepoint will capture it.
    pub dispatchable: bool,
    /// The recipe SHAPE this action posts → the code emitter. `None` for a reserved
    /// (non-dispatchable) vocabulary entry, which has nothing to emit.
    pub dialect: Option<RecipeDialect>,
}

/// The BUILT-IN action vocabulary. `selection.*` + `subset.filter` are dispatchable;
/// the `annotate.*`/`group.*` vocabulary is reserved (enumerated, not dispatched).
///
/// This is no longer the WHOLE registry — see [`catalog`]. It stays a fixed list
/// because these action types are the ones the app's own surfaces post; a package's
/// own gesture arrives through `contributes.actions` instead.
fn builtin_catalog() -> Vec<ActionSpec> {
    use FidelityClass::*;
    use RecipeDialect as D;
    let dispatch = |action_type: &str, dialect: RecipeDialect| ActionSpec {
        action_type: action_type.to_string(),
        fidelity: Declarative,
        dispatchable: true,
        dialect: Some(dialect),
    };
    let reserved = |action_type: &str| ActionSpec {
        action_type: action_type.to_string(),
        fidelity: Identity,
        dispatchable: false,
        dialect: None,
    };
    vec![
        dispatch("selection.polygon", D::Polygon),
        dispatch("selection.column", D::ColumnCompare),
        dispatch("selection.label_set", D::LabelSet),
        dispatch("selection.setop", D::SetOp),
        dispatch("selection.freehand", D::IdList),
        // A COMMITTED keep-mask (filter-provenance ITEM-10) — the save/commit point
        // records the same durable versioned recipe an interactive selection does.
        dispatch("subset.filter", D::Criteria),
        // Reserved vocabulary — enumerated, NOT dispatchable.
        reserved("annotate.label"),
        reserved("group.create"),
    ]
}

/// Fold manifest-contributed actions onto the built-in vocabulary — the pure,
/// registry-free core of [`catalog`].
///
/// A contribution may NOT shadow a built-in action type, and a duplicate
/// contribution loses to the first (id-sorted manifest order), so the resulting
/// vocabulary is deterministic and a package can never re-point an action the app's
/// own surfaces post at a different emitter. A `dispatchable` contribution with no
/// declared `recipe` dialect is DOWNGRADED to reserved rather than accepted: there
/// would be nothing to attest to, and silently emitting nothing is exactly the
/// placeholder failure ITEM-18 forbids.
pub fn merge_catalog(contributed: &[ActionContribution]) -> Vec<ActionSpec> {
    let mut out = builtin_catalog();
    for c in contributed {
        if out.iter().any(|s| s.action_type == c.action_type) {
            continue;
        }
        let dispatchable = c.dispatchable && c.recipe.is_some();
        out.push(ActionSpec {
            action_type: c.action_type.clone(),
            fidelity: c.fidelity,
            dispatchable,
            dialect: c.recipe,
        });
    }
    out
}

/// The live action registry: the built-in vocabulary PLUS every
/// `contributes.actions` entry the extension registry currently holds (S4). Reads
/// the process-wide extension registry, so a dropped/edited package's action becomes
/// capturable on the next reflect with no rebuild.
pub fn catalog() -> Vec<ActionSpec> {
    merge_catalog(&crate::modules::extensions::contributed_actions())
}

/// Look up an action spec by type.
pub fn lookup(action_type: &str) -> Option<ActionSpec> {
    catalog().into_iter().find(|s| s.action_type == action_type)
}

/// True for a dispatchable action.
pub fn is_dispatchable(action_type: &str) -> bool {
    lookup(action_type).map(|s| s.dispatchable).unwrap_or(false)
}

fn req_str<'a>(recipe: &'a Value, field: &str, action_type: &str) -> Result<&'a str, EmitError> {
    recipe
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| {
            EmitError::MalformedRecipe(format!(
                "{action_type} recipe is missing a string \"{field}\" field"
            ))
        })
}

/// The reviewer-facing header: which action the script reproduces. Deterministic,
/// so the emitted source stays byte-stable.
///
/// **Every** interpolated value here is client-influenced and lands on a `#`
/// COMMENT line, so each goes through `py_comment` — a raw newline would otherwise
/// close the comment and inject module-scope python (the same defect class as the
/// criteria emitter's `skipped` list). `action_type` is already allow-listed by
/// `is_dispatchable`, but it goes through the same helper so no future edit
/// re-opens the hole.
fn header(action_type: &str) -> String {
    let mut h = String::new();
    h.push_str("# Auto-generated selection predicate (provenance capture)\n");
    h.push_str(&format!("# action: {}\n", py_comment(action_type)));
    h
}

/// Emit a reproducible script for a captured action's recipe.
///
/// Returns [`EmitError::NotDispatchable`] for an unregistered / reserved action and
/// [`EmitError::MalformedRecipe`] for a recipe that cannot be honestly reproduced.
/// The emitter is deterministic (byte-stable for fixed input), so the stored code
/// blob dedups, and recipe-specific, so the recorded `code_sha256` attests to
/// THIS recipe.
pub fn emit_code(action_type: &str, recipe: &Value) -> Result<String, EmitError> {
    let spec = lookup(action_type).filter(|s| s.dispatchable);
    let Some(dialect) = spec.and_then(|s| s.dialect) else {
        return Err(EmitError::NotDispatchable(action_type.to_string()));
    };
    emit_code_in_dialect(action_type, dialect, recipe)
}

/// The pure emitter core: compile `recipe` in an already-resolved `dialect`.
/// Registry-free, so a test can drive every dialect without a built registry.
pub fn emit_code_in_dialect(
    action_type: &str,
    dialect: RecipeDialect,
    recipe: &Value,
) -> Result<String, EmitError> {
    let header = header(action_type);

    // The `criteria` dialect has its own (already domain-free) compiler.
    if matches!(dialect, RecipeDialect::Criteria) {
        let criteria = recipe.get("criteria").and_then(Value::as_array).ok_or_else(|| {
            EmitError::MalformedRecipe(format!(
                "a `{}`-dialect recipe ({action_type}) must carry a \"criteria\" array",
                dialect.as_str()
            ))
        })?;
        return emit_criteria_script(&header, criteria);
    }

    // ── the FLAT recipe dialects ───────────────────────────────────────────────
    // Each emits the SAME `select(ctx)` module the criteria dialect does, over the
    // domain-free ctx documented on `SELECTION_PRELUDE`. `# comment` lines carry
    // client-influenced text and therefore always go through `py_comment`.
    let mut notes = String::new();
    let mut preamble: Vec<String> = Vec::new();
    let expr: String = match dialect {
        RecipeDialect::Criteria => unreachable!("handled above"),
        RecipeDialect::ColumnCompare => {
            let col = req_str(recipe, "col", action_type)?;
            // `op` is SYNTAX, not data — allow-list it (no escaping makes an
            // arbitrary operator safe). `col`/`val` are DATA — escape them.
            let op = allowed_op(req_str(recipe, "op", action_type)?, &LEGACY_COMPARATORS, "comparator")?;
            let val = recipe.get("val").ok_or_else(|| {
                EmitError::MalformedRecipe(format!(
                    "a `{}`-dialect recipe ({action_type}) is missing a \"val\" field",
                    dialect.as_str()
                ))
            })?;
            preamble.push(format!("    _c0 = _col(ctx, n, {})", py_str(col)));
            format!("_c0[i] {op} {}", py_literal(val))
        }
        RecipeDialect::LabelSet => {
            let cref = req_str(recipe, KEY_COLUMN_REF, action_type)?;
            let labels = recipe.get("labels").and_then(Value::as_array).ok_or_else(|| {
                EmitError::MalformedRecipe(format!(
                    "a `{}`-dialect recipe ({action_type}) is missing a \"labels\" array",
                    dialect.as_str()
                ))
            })?;
            preamble.push(format!("    _c0 = _col(ctx, n, {})", py_str(cref)));
            preamble.push(format!(
                "    _w0 = [{}]",
                labels.iter().map(py_literal).collect::<Vec<_>>().join(",")
            ));
            "_c0[i] in _w0".to_string()
        }
        RecipeDialect::IdList => {
            let ids = recipe.get("ids").and_then(Value::as_array).ok_or_else(|| {
                EmitError::MalformedRecipe(format!(
                    "a `{}`-dialect recipe ({action_type}) is missing an \"ids\" array",
                    dialect.as_str()
                ))
            })?;
            preamble.push("    _ids = _seq(ctx, n, \"ids\")".to_string());
            preamble.push(format!(
                "    _w0 = [{}]",
                ids.iter().map(py_literal).collect::<Vec<_>>().join(",")
            ));
            "_ids[i] in _w0".to_string()
        }
        RecipeDialect::Polygon => {
            let emb = req_str(recipe, KEY_COORDS_REF, action_type)?;
            let poly = recipe.get("polygon").and_then(Value::as_array).ok_or_else(|| {
                EmitError::MalformedRecipe(format!(
                    "a `{}`-dialect recipe ({action_type}) is missing a \"polygon\" array",
                    dialect.as_str()
                ))
            })?;
            if poly.len() < 3 {
                return Err(EmitError::MalformedRecipe(format!(
                    "a `{}`-dialect recipe ({action_type}) needs at least 3 polygon vertices, got {}",
                    dialect.as_str(),
                    poly.len()
                )));
            }
            // `coords_ref` is a free-form client string on a COMMENT line — it
            // PINS which 2-D projection the polygon was drawn over, so the replay is
            // only meaningful against `ctx["coords"]` from that same projection.
            notes.push_str(&format!(
                "# polygon drawn over the 2-D projection pinned by {}\n",
                py_comment(emb)
            ));
            preamble.push("    _pts = _seq(ctx, n, \"coords\")".to_string());
            preamble.push(format!(
                "    _poly = {}",
                py_tuple(&poly.iter().map(py_literal).collect::<Vec<_>>())
            ));
            "_in_poly(_pts[i], _poly)".to_string()
        }
        RecipeDialect::SetOp => {
            // Allow-listed for the same reason as the comparator, AND rendered
            // through `py_comment` so even an allow-listed value can never carry a
            // comment-terminating byte.
            let op = allowed_op(req_str(recipe, "op", action_type)?, &LEGACY_SETOPS, "set operation")?;
            // The REFS are what the operation combines. The old emitter read `op`
            // and DROPPED `refs` entirely (its body was a call to an undefined
            // `apply_setop(recipe)`), so the attested script could not name — let
            // alone reproduce — which sets were combined. A recipe without them
            // cannot be honestly reproduced, so it is a loud MalformedRecipe.
            let refs: Vec<&str> = recipe
                .get("refs")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            if refs.is_empty() {
                return Err(EmitError::MalformedRecipe(format!(
                    "a `{}`-dialect recipe ({action_type}) must carry a non-empty \"refs\" \
                     array naming the sets it combines",
                    dialect.as_str()
                )));
            }
            let arity_error = |want: &str| {
                EmitError::MalformedRecipe(format!(
                    "the {op:?} set operation {want}, got {} reference(s)",
                    refs.len()
                ))
            };
            if op == "not" && refs.len() != 1 {
                return Err(arity_error("takes exactly 1 reference"));
            }
            if matches!(op, "difference" | "andnot") && refs.len() < 2 {
                return Err(arity_error("takes at least 2 references"));
            }
            notes.push_str(&format!("# set operation: {}\n", py_comment(op)));
            for (k, r) in refs.iter().enumerate() {
                preamble.push(format!("    _s{k} = _set_mask(ctx, n, {})", py_str(r)));
            }
            let term = |k: usize| format!("_s{k}[i]");
            match op {
                "not" => format!("not {}", term(0)),
                "union" | "or" => {
                    (0..refs.len()).map(term).collect::<Vec<_>>().join(" or ")
                }
                "intersect" | "and" => {
                    (0..refs.len()).map(term).collect::<Vec<_>>().join(" and ")
                }
                "difference" | "andnot" => format!(
                    "{} and not ({})",
                    term(0),
                    (1..refs.len()).map(term).collect::<Vec<_>>().join(" or ")
                ),
                "xor" => format!(
                    "_xor([{}])",
                    (0..refs.len()).map(term).collect::<Vec<_>>().join(", ")
                ),
                // `allowed_op` already restricted `op` to `LEGACY_SETOPS`; this arm
                // exists so ADDING a member there without an emitter is a loud
                // failure rather than a silently wrong script.
                other => {
                    return Err(EmitError::MalformedRecipe(format!(
                        "no set-operation emitter for {:?}",
                        py_comment(other)
                    )))
                }
            }
        }
    };

    let mut out = header;
    out.push_str(&notes);
    out.push_str(SELECTION_CTX_DOC);
    out.push('\n');
    out.push_str(SELECTION_PRELUDE);
    out.push_str("\n\ndef select(ctx):\n");
    out.push_str("    n = _n(ctx)\n");
    for line in &preamble {
        out.push_str(line);
        out.push('\n');
    }
    let _ = writeln!(out, "    return [bool({expr}) for i in range(n)]");
    Ok(out)
}

/// The reviewer-facing contract note carried by every flat-dialect script.
const SELECTION_CTX_DOC: &str = r#"#
# `select(ctx)` returns this selection's per-element booleans (length
# `ctx["n"]`). The ctx names no domain: `ctx["columns"][name]` is an annotation
# column, `ctx["ids"]` the stable element ids, `ctx["coords"]` the 2-D positions
# of the pinned projection, `ctx["sets"][ref]` a named prior selection. A ctx
# that cannot answer (absent column, length mismatch) RAISES rather than
# returning a mask that was never selected.
#
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::provenance::pyrun::{python_compiles, run_select};
    use serde_json::json;

    // ── S4: the ATTESTED artifact is domain-free AND actually runs ──────────────
    //
    // The emitted script's sha256 IS the run's `code_sha256` — the reproducibility
    // claim itself. Three of the five `selection.*` arms used to emit a fragment
    // that could not execute ANYWHERE (`points_in_polygon` / `apply_setop` /
    // `recipe` are undefined names), and the other two named `adata.obs` /
    // `adata.obs_names` — a container library and an axis this server has no
    // business knowing. On a deployment whose data is not AnnData the attested
    // replay is a `NameError`, i.e. the reproducibility guarantee is the hash of a
    // script that cannot run.
    //
    // RED ON REVERT: restore the `adata.obs[...]` / `points_in_polygon(...)` /
    // `apply_setop(recipe)` emitters and every case below fails — the first two on
    // the identifier assertion, all five on `select(ctx)` execution.

    /// One `(action_type, recipe, ctx, expected mask)` case per dispatchable arm.
    fn attested_replay_cases() -> Vec<(&'static str, serde_json::Value, serde_json::Value, Vec<bool>)>
    {
        vec![
            (
                "selection.column",
                json!({ "kind": "column", "col": "grp", "op": "==", "val": "3" }),
                json!({ "n": 3, "columns": { "grp": ["3", "4", "3"] } }),
                vec![true, false, true],
            ),
            (
                "selection.label_set",
                json!({ "kind": "label_set", "column_ref": "grp", "labels": ["3", "4"] }),
                json!({ "n": 3, "columns": { "grp": ["3", "4", "5"] } }),
                vec![true, true, false],
            ),
            (
                "selection.freehand",
                json!({ "kind": "freehand", "ids": ["e1", "e3"] }),
                json!({ "n": 3, "ids": ["e1", "e2", "e3"] }),
                vec![true, false, true],
            ),
            (
                "selection.polygon",
                json!({
                    "kind": "polygon",
                    "coords_ref": "sha256:proj",
                    "polygon": [[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]],
                }),
                json!({ "n": 3, "coords": [[1.0, 1.0], [50.0, 50.0], [9.0, 9.0]] }),
                vec![true, false, true],
            ),
            (
                "selection.setop",
                json!({ "kind": "setop", "op": "union", "refs": ["a", "b"] }),
                json!({ "n": 3, "sets": { "a": [true, false, false], "b": [false, true, false] } }),
                vec![true, true, false],
            ),
            (
                "subset.filter",
                json!({ "criteria": [{ "column": "q", "control": "range", "min": "5" }] }),
                json!({ "n": 2, "columns": { "q": [1, 5] } }),
                vec![false, true],
            ),
        ]
    }

    /// Identifiers that name a specific analysis container library / a fixed axis.
    /// None of them may appear in an artifact this server attests to.
    const FORBIDDEN_IN_ATTESTED_SOURCE: [&str; 6] =
        ["adata", "obs_names", "var_names", ".obs[", "AnnData", "scanpy"];

    #[test]
    fn every_attested_selection_script_is_domain_free() {
        for (action_type, recipe, _, _) in attested_replay_cases() {
            let src = emit_code(action_type, &recipe)
                .unwrap_or_else(|e| panic!("{action_type} emits: {e}"));
            for needle in FORBIDDEN_IN_ATTESTED_SOURCE {
                assert!(
                    !src.contains(needle),
                    "the attested {action_type} script names `{needle}` — its sha256 is sold \
                     as the reproducibility claim, so it must not presume one domain's \
                     container library:\n{src}"
                );
            }
        }
    }

    #[test]
    fn every_attested_selection_script_runs_and_reproduces_its_recipe() {
        for (action_type, recipe, ctx, expect) in attested_replay_cases() {
            let src = emit_code(action_type, &recipe)
                .unwrap_or_else(|e| panic!("{action_type} emits: {e}"));
            python_compiles(&src).unwrap_or_else(|e| {
                panic!("the attested {action_type} script is not a well-formed module: {e}\n{src}")
            });
            let got = run_select(&src, ctx);
            assert_eq!(
                got, expect,
                "the attested {action_type} replay must reproduce the recorded set:\n{src}"
            );
        }
    }

    // TEST-6: selection.* is registered with a code emitter + Declarative fidelity;
    // the reserved annotate.*/group.* vocabulary is enumerated but NOT dispatchable.
    #[test]
    fn selection_dispatchable_reserved_not() {
        let sel = lookup("selection.column").expect("selection.column registered");
        assert!(sel.dispatchable);
        assert_eq!(sel.fidelity, FidelityClass::Declarative);
        assert!(emit_code(
            "selection.column",
            &json!({"kind":"column","col":"leiden","op":"==","val":"3"})
        )
        .is_ok());

        let annotate = lookup("annotate.label").expect("annotate.label reserved");
        assert!(!annotate.dispatchable, "reserved vocabulary is not dispatchable");
        assert!(lookup("group.create").is_some_and(|s| !s.dispatchable));
        assert!(matches!(
            emit_code("annotate.label", &json!({})),
            Err(EmitError::NotDispatchable(_))
        ));
    }

    // TEST-17 (ITEM-10): `subset.filter` is dispatchable AND has its own emitter arm
    // producing THRESHOLD-predicate python — never the old catch-all's polygon code.
    #[test]
    fn subset_filter_is_dispatchable_with_its_own_threshold_emitter() {
        let spec = lookup("subset.filter").expect("subset.filter registered");
        assert!(spec.dispatchable, "ITEM-10: subset.filter is dispatchable");
        assert_eq!(spec.fidelity, FidelityClass::Declarative);

        let src = emit_code(
            "subset.filter",
            &json!({ "criteria": [
                { "column": "pct_mito", "control": "range", "max": "10" },
                { "column": "cell_type", "keep": ["T", "NK"] }
            ] }),
        )
        .expect("subset.filter emits");
        assert!(src.contains("pct_mito"), "names the filtered column: {src}");
        assert!(src.contains("cell_type"), "names the categorical column: {src}");
        assert!(
            !src.contains("points_in_polygon"),
            "a threshold filter must NOT fall through to polygon code: {src}"
        );
        assert!(src.contains("def select(ctx):"), "a runnable module: {src}");
    }

    // TEST-18 (ITEM-18): the PLACEHOLDER DEFECT IS GONE, and the emitted source is
    // RECIPE-SPECIFIC (so the recorded `code_sha256` attests to THIS recipe) and
    // byte-stable (so the code blob dedups).
    #[test]
    fn the_emitted_source_is_recipe_specific_so_the_hash_is_too() {
        let filt = |max: &str| {
            emit_code(
                "subset.filter",
                &json!({ "criteria": [{ "column": "pct_mito", "control": "range", "max": max }] }),
            )
            .expect("subset.filter emits")
        };
        let a = filt("10");
        let b = filt("25");
        let c = emit_code(
            "subset.filter",
            &json!({ "criteria": [{ "column": "n_genes", "control": "range", "max": "10" }] }),
        )
        .expect("subset.filter emits");

        // no placeholder survives.
        assert!(!a.contains("<col>"), "the `<col>` placeholder is gone:\n{a}");
        assert!(!a.contains("== None"), "the `== None` placeholder is gone:\n{a}");
        // it names the real column + threshold, and is a runnable module.
        assert!(a.contains("pct_mito"), "{a}");
        assert!(a.contains("_keep_range(_c0, i, None, 10.0)"), "{a}");
        assert!(a.contains("def select(ctx):"), "{a}");

        assert_ne!(a, b, "a different threshold → different source → different sha");
        assert_ne!(a, c, "a different column → different source → different sha");
        assert_eq!(a, filt("10"), "byte-stable for a fixed recipe");
    }

    // S4 (was `legacy_flat_recipes_still_emit_their_original_script`): each flat
    // recipe still emits a RECIPE-SPECIFIC script naming exactly what was selected —
    // but as the domain-free `select(ctx)` module, not the old `adata.obs[...]` /
    // `points_in_polygon(...)` fragments. The ORIGINAL assertions pinned the very
    // identifiers that made the attested artifact unrunnable (see
    // `every_attested_selection_script_runs_and_reproduces_its_recipe`), so they are
    // replaced by the ctx-dialect equivalents; what they were really guarding — that
    // the emitted source names the actual column / labels / ids / vertices — is kept.
    #[test]
    fn flat_recipes_emit_a_recipe_specific_ctx_predicate() {
        let src = emit_code(
            "selection.column",
            &json!({ "kind": "column", "col": "leiden", "op": "==", "val": "3" }),
        )
        .unwrap();
        assert!(src.contains(r#"_c0 = _col(ctx, n, "leiden")"#), "{src}");
        assert!(src.contains(r#"_c0[i] == "3""#), "{src}");

        let clu = emit_code(
            "selection.label_set",
            &json!({ "kind": "label_set", "column_ref": "grp", "labels": ["3", "4"] }),
        )
        .unwrap();
        assert!(clu.contains(r#"_c0 = _col(ctx, n, "grp")"#), "{clu}");
        assert!(clu.contains(r#"_w0 = ["3","4"]"#), "{clu}");
        assert!(clu.contains("_c0[i] in _w0"), "{clu}");

        let free = emit_code(
            "selection.freehand",
            &json!({ "kind": "freehand", "ids": ["cell_1"] }),
        )
        .unwrap();
        assert!(free.contains(r#"_w0 = ["cell_1"]"#), "{free}");
        assert!(free.contains("_ids[i] in _w0"), "{free}");

        let poly = emit_code(
            "selection.polygon",
            &json!({ "kind": "polygon", "coords_ref": "sha256:emb", "polygon": [[0.0,0.0],[1.0,0.0],[0.0,1.0]] }),
        )
        .unwrap();
        assert!(poly.contains("_in_poly(_pts[i], _poly)"), "{poly}");
        assert!(poly.contains("[0.0,0.0]"), "the vertices are named: {poly}");
        // The pinned projection is still disclosed (a polygon replay is only
        // meaningful against the SAME projection's coordinates).
        assert!(poly.contains("sha256:emb"), "{poly}");

        let setop = emit_code(
            "selection.setop",
            &json!({ "kind": "setop", "op": "difference", "refs": ["a", "b"] }),
        )
        .unwrap();
        assert!(setop.contains(r#"_s0 = _set_mask(ctx, n, "a")"#), "{setop}");
        assert!(setop.contains("_s0[i] and not (_s1[i])"), "{setop}");
    }

    // S4: the emitted source stays RECIPE-SPECIFIC (so `code_sha256` attests to THIS
    // recipe) and byte-stable (so the blob dedups) for the flat dialects too — the
    // property `the_emitted_source_is_recipe_specific_so_the_hash_is_too` already
    // holds for `subset.filter`.
    #[test]
    fn flat_dialect_sources_are_recipe_specific_and_byte_stable() {
        let col = |c: &str, v: &str| {
            emit_code("selection.column", &json!({ "col": c, "op": "==", "val": v })).unwrap()
        };
        assert_ne!(col("a", "1"), col("a", "2"), "a different value → a different sha");
        assert_ne!(col("a", "1"), col("b", "1"), "a different column → a different sha");
        assert_eq!(col("a", "1"), col("a", "1"), "byte-stable for a fixed recipe");
    }

    // S4: a set operation that names no sets cannot be honestly reproduced. The old
    // emitter read `op` and DROPPED `refs`, emitting a call to an undefined
    // `apply_setop(recipe)` — so the attested script could not even name which sets
    // were combined. Arity is checked for the operations that have one.
    #[test]
    fn a_setop_without_resolvable_refs_fails_loudly() {
        for bad in [
            json!({ "op": "union" }),                       // no refs at all
            json!({ "op": "union", "refs": [] }),           // empty
            json!({ "op": "union", "refs": [1, 2] }),       // non-string refs
            json!({ "op": "not", "refs": ["a", "b"] }),     // `not` is unary
            json!({ "op": "difference", "refs": ["a"] }),   // difference needs ≥2
        ] {
            let err = emit_code("selection.setop", &bad).unwrap_err();
            assert!(matches!(err, EmitError::MalformedRecipe(_)), "{bad} → {err:?}");
        }
        // Every allow-listed set operation has an emitter (a member added to
        // `LEGACY_SETOPS` without one is a loud failure, never a wrong script).
        for op in LEGACY_SETOPS {
            let refs = if op == "not" { json!(["a"]) } else { json!(["a", "b"]) };
            assert!(
                emit_code("selection.setop", &json!({ "op": op, "refs": refs })).is_ok(),
                "{op} has an emitter"
            );
        }
    }

    // ── The recipe wire vocabulary names SHAPES, not a contributed domain ──────────
    //
    // `ActionRecipeDialect` says each variant "names a payload shape, never a domain",
    // three lines above two variants that were defined by `clustering_ref` and
    // `embedding_hash` — two CONTRIBUTED datatype ids. That is a claim contradicted by
    // its own doc, and the app's domain grep-guard could not see it: an id is matched
    // ONLY as a whole quoted literal (deliberately — the anchor is what keeps the guard
    // false-positive-free), so an id used as a STEM is invisible.
    //
    // So the property is asserted here instead, on the VALUE (`payload_keys`) rather
    // than on the source text, and against the LIVE registry rather than a hand list —
    // a package contributing a datatype called `polygon` or `criteria` tomorrow turns
    // this red, which is the correct outcome: it would mean the app's own wire had
    // started colliding with a domain's vocabulary.
    #[test]
    fn no_recipe_payload_key_names_a_contributed_datatype() {
        use crate::modules::datatype::registry::DatatypeRegistry;
        let reg = DatatypeRegistry::build_from_embedded().expect("merged registry builds");
        let ids: Vec<String> = reg.all().iter().map(|d| d.id.clone()).collect();

        // Non-vacuity + the NEGATIVE CONTROL in one: the registry must be populated,
        // and the two spellings this test exists because of must still be CAUGHT by the
        // very predicate the assertion below uses. Without this, a predicate that
        // silently matched nothing would pass the loop and prove nothing.
        assert!(
            ids.len() > 10,
            "the registry must be populated (saw {})",
            ids.len()
        );
        for legacy in ["clustering_ref", "embedding_hash"] {
            assert!(
                contributed_id_in_key(legacy, &ids).is_some(),
                "the negative control `{legacy}` must be caught by this predicate, or \
                 the assertion below is vacuous"
            );
        }

        for (i, dialect) in ALL_DIALECTS.into_iter().enumerate() {
            assert_eq!(
                dialect_index(dialect),
                i,
                "ALL_DIALECTS is out of order/stale"
            );
            for key in payload_keys(dialect) {
                assert!(
                    contributed_id_in_key(key, &ids).is_none(),
                    "the `{}` dialect's payload key `{key}` names the contributed \
                     datatype `{}` — the app's own wire vocabulary must describe a \
                     SHAPE, not a domain",
                    dialect.as_str(),
                    contributed_id_in_key(key, &ids).unwrap_or_default(),
                );
            }
        }
    }

    // S4: `catalog()` is no longer a closed code-defined list — a package's own
    // gesture becomes capturable through `contributes.actions`, with the SAME
    // domain-free emitter behind it. A contribution may not shadow a built-in, and a
    // dispatchable contribution with no declared dialect is downgraded to reserved
    // rather than accepted with nothing to attest to.
    #[test]
    fn a_manifest_contributed_action_is_capturable_and_cannot_shadow_a_builtin() {
        use crate::modules::extensions::types::ActionContribution;

        let contributed = vec![
            ActionContribution {
                action_type: "gate.commit".to_string(),
                fidelity: FidelityClass::Declarative,
                dispatchable: true,
                recipe: Some(RecipeDialect::Criteria),
            },
            // Reserved-by-declaration (no dialect ⇒ nothing to emit).
            ActionContribution {
                action_type: "gate.preview".to_string(),
                fidelity: FidelityClass::ViewOnly,
                dispatchable: true,
                recipe: None,
            },
            // A shadow attempt on a built-in: ignored, the built-in survives intact.
            ActionContribution {
                action_type: "selection.column".to_string(),
                fidelity: FidelityClass::ViewOnly,
                dispatchable: true,
                recipe: Some(RecipeDialect::IdList),
            },
        ];
        let cat = merge_catalog(&contributed);
        let by = |t: &str| cat.iter().find(|s| s.action_type == t).cloned();

        let gate = by("gate.commit").expect("the contributed action is registered");
        assert!(gate.dispatchable);
        assert_eq!(gate.dialect, Some(RecipeDialect::Criteria));

        let preview = by("gate.preview").expect("registered");
        assert!(!preview.dispatchable, "no dialect ⇒ nothing to attest to ⇒ reserved");

        let builtin = by("selection.column").expect("the built-in survives");
        assert_eq!(builtin.dialect, Some(RecipeDialect::ColumnCompare), "not shadowed");
        assert_eq!(builtin.fidelity, FidelityClass::Declarative);
        assert_eq!(
            cat.iter().filter(|s| s.action_type == "selection.column").count(),
            1,
            "no duplicate entry"
        );

        // …and the contributed action emits a REAL, runnable, recipe-specific script.
        let src = emit_code_in_dialect(
            "gate.commit",
            RecipeDialect::Criteria,
            &json!({ "criteria": [{ "column": "q", "control": "range", "min": "5" }] }),
        )
        .expect("a contributed action emits");
        assert!(src.contains("# action: gate.commit"), "{src}");
        assert_eq!(run_select(&src, json!({ "n": 2, "columns": { "q": [1, 5] } })), vec![false, true]);

        // The built-in vocabulary alone is unchanged when nothing is contributed.
        assert_eq!(merge_catalog(&[]), builtin_catalog());
    }

    // ── injection: the LEGACY flat arms + the shared header ─────────────────────

    /// Hostile spellings a client can post into a legacy flat recipe.
    const HOSTILE: [&str; 4] = [
        "== 1\nimport os\nos.system('id')\n#",
        "leiden\nimport os\n#",
        "a\rimport os\r#",
        "x\u{0}y",
    ];

    // (`python_compiles` used to be duplicated here with an `Ok(())`-on-absent-python3
    // arm — a silent PASS for the injection assertion. It now comes from
    // `provenance::pyrun`, where an absent interpreter is a FAILURE TO VERIFY.)

    // FINDING 2. The legacy `selection.column` / `selection.setop` arms spliced the
    // client's `op` into emitted python with NO escaping and NO vocabulary check:
    // `{"op":"== 1\nimport os\n#"}` appended a module-scope statement to the very
    // script whose sha256 is recorded as `code_sha256`. An operator is SYNTAX, so
    // the guard is an ALLOW-LIST (a comparator that is not one of the six is a loud
    // MalformedRecipe), not escaping.
    // RED ON REVERT: drop `allowed_op` and the first assertion fails.
    #[test]
    fn a_legacy_operator_outside_the_allow_list_fails_loudly() {
        for hostile in HOSTILE {
            let err = emit_code(
                "selection.column",
                &json!({ "kind": "column", "col": "leiden", "op": hostile, "val": 1 }),
            )
            .unwrap_err();
            assert!(matches!(err, EmitError::MalformedRecipe(_)), "{hostile:?} -> {err:?}");
            // the ERROR itself never carries a raw line terminator either.
            assert!(!format!("{err}").contains('\n'), "the error text is single-line: {err}");
        }
        // a plausible-but-wrong spelling is refused too (not just an injecting one).
        assert!(matches!(
            emit_code("selection.column", &json!({ "col": "l", "op": "is not", "val": 3 })).unwrap_err(),
            EmitError::MalformedRecipe(_)
        ));
        // …and the set-operation vocabulary.
        assert!(matches!(
            emit_code("selection.setop", &json!({ "op": "union\nimport os\n#" })).unwrap_err(),
            EmitError::MalformedRecipe(_)
        ));
        // every allow-listed comparator still emits.
        for op in LEGACY_COMPARATORS {
            assert!(
                emit_code("selection.column", &json!({ "col": "l", "op": op, "val": 3 })).is_ok(),
                "{op} is a supported comparator"
            );
        }
    }

    // FINDING 2 (the comment half). `coords_ref` is a free-form client string
    // that lands on a `#` COMMENT line. A raw newline in it ended the comment.
    // RED ON REVERT: drop `py_comment` from `header`/the polygon arm and the
    // line-count assertions fail.
    #[test]
    fn a_hostile_identifier_never_adds_a_line_to_the_emitted_source() {
        // the polygon arm's `coords_ref` comment.
        let benign = emit_code(
            "selection.polygon",
            &json!({ "coords_ref": "sha256:emb", "polygon": [[0.0,0.0],[1.0,0.0],[0.0,1.0]] }),
        )
        .unwrap();
        for hostile in HOSTILE {
            let src = emit_code(
                "selection.polygon",
                &json!({ "coords_ref": hostile, "polygon": [[0.0,0.0],[1.0,0.0],[0.0,1.0]] }),
            )
            .unwrap();
            assert_eq!(
                src.lines().count(),
                benign.lines().count(),
                "coords_ref escaped its comment:\n{src}"
            );
            python_compiles(&src).unwrap_or_else(|e| panic!("not a well-formed module: {e}\n{src}"));
        }
    }

    // The legacy literal renderer must emit PYTHON, not JSON: `true`/`false`/`null`
    // are not python tokens, and Rust's `{:?}` emits `\u{1f600}` which python
    // cannot parse. Both produced a syntactically broken module.
    #[test]
    fn legacy_literals_are_python_not_json() {
        let src = emit_code(
            "selection.label_set",
            &json!({ "column_ref": "grp", "labels": [true, null, 3, "😀"] }),
        )
        .unwrap();
        assert!(src.contains("[True,None,3,\"😀\"]"), "{src}");
        assert!(!src.contains("\\u{"), "no Rust-debug unicode escape reaches python: {src}");
        python_compiles(&src).unwrap_or_else(|e| panic!("not a well-formed module: {e}\n{src}"));
    }

    // A malformed recipe FAILS LOUDLY — it never silently hashes a fake script.
    #[test]
    fn malformed_recipes_fail_loudly_instead_of_emitting_a_placeholder() {
        for bad in [
            json!({ "kind": "column" }),                          // no col/op/val
            json!({ "kind": "column", "col": "leiden" }),          // no op/val
            json!({ "kind": "column", "col": "leiden", "op": "==" }), // no val
        ] {
            let err = emit_code("selection.column", &bad).unwrap_err();
            assert!(matches!(err, EmitError::MalformedRecipe(_)), "{bad} → {err:?}");
        }
        // the SCRAPPED predicate-DSL envelope: no longer a dialect this build reads,
        // so it is a LOUD MalformedRecipe, never a silently different script.
        let err = emit_code(
            "selection.column",
            &json!({ "kind": "column", "predicate": { "gt": [{ "col": "q" }, 1.0] } }),
        )
        .unwrap_err();
        assert!(matches!(err, EmitError::MalformedRecipe(_)), "{err:?}");
        // clustering / freehand / polygon missing their payload
        assert!(matches!(
            emit_code("selection.label_set", &json!({ "kind": "clustering" })).unwrap_err(),
            EmitError::MalformedRecipe(_)
        ));
        assert!(matches!(
            emit_code("selection.freehand", &json!({ "kind": "freehand" })).unwrap_err(),
            EmitError::MalformedRecipe(_)
        ));
        assert!(matches!(
            emit_code("selection.polygon", &json!({ "kind": "polygon", "coords_ref": "e" }))
                .unwrap_err(),
            EmitError::MalformedRecipe(_)
        ));
        assert!(matches!(
            emit_code("subset.filter", &json!({ "kind": "filter" })).unwrap_err(),
            EmitError::MalformedRecipe(_)
        ));
    }
}
