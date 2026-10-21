//! The MODEL-COVERAGE guard: a new producer, or a new row-bearing output, cannot land
//! silently.
//!
//! The discriminator is already declared in the tree: `entity_axis` names "the axis whose
//! entries a value of this type has exactly ONE PER", and it is refused rather than
//! guessed when absent. That separates a value's ROW space from its COLUMN space, which is
//! the only question either arm below asks — so the guard fires at the moment a DATATYPE is
//! declared, one step earlier than a producer-set guard would, and against a file the
//! producer must edit anyway.
//!
//! ## The rule, and why it is DERIVED rather than listed
//!
//! A declared entity axis is ACCOUNTED FOR when it is an ORIGINAL axis — one anchored to
//! a dataset. That is not a hand-list here: a datatype carrying `ingest:` is by
//! definition what an uploaded dataset becomes, so the `key_label`s such a datatype
//! declares ARE the original axis identities. Every other axis identity belongs to a
//! space the tree invented downstream.
//!
//! `key_label` rather than `name` is load-bearing: the axis NAME vocabulary differs
//! between contributing packages for axes that are the same thing, while `key_label` is
//! the identity they agree on. Matching on names would silently exempt half the lattice.
//!
//! ## Why this file spells no id
//!
//! Both the lattice and the exempt entries are read as OPAQUE strings. `server/tests/**`
//! is domain-scanned, so a guard that hardcoded what it is guarding would be the place
//! the vocabulary re-enters the core. The exempt list therefore lives under `packages/`
//! — the domain tree — and this file only ever compares.
//!
//! ## The PRODUCER arm
//!
//! The second arm catches what the first cannot see: a producer that emits an ALREADY
//! declared row-bearing datatype without stating which rows of that axis it wrote. The
//! lattice arm
//! never fires for that — the datatype was declared long ago and is perfectly accounted
//! for; what is new is a producer emitting it.
//!
//! It is a REGISTER-completeness gate, and that is a deliberate choice with a cost worth
//! stating plainly. The evidence that a producer "declares which rows it describes" lives
//! in Python compute source, and the only mechanical way to read it is a source-text scan —
//! the hand-written static analyser whose evasion space is unbounded, which this repo has
//! already paid for twice. So the arm asserts the thing that IS mechanical and has no
//! evasion space at all: the derived set of (producer x row-bearing datatype) pairs and the
//! committed register agree BOTH WAYS, exactly as the lattice arm does for its list.
//!
//! What that buys is precise: a new producer, or a new row-bearing output on an existing
//! one, CANNOT land silently. It turns the arm red until someone writes down what that
//! pair states about its row space. What it does not buy is verification that the written
//! disposition is true — a register entry is a committed, reviewed statement, on the same
//! trust model the lattice exempt list already runs on ("a stated undecidable, never a
//! waiver"). Trading a checkable claim for an unbounded scan would be the worse deal.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use cytoanalyst::modules::extensions::types::{DatatypeContribution, ExtensionManifest};

/// `src-app/`, the parent of this crate.
fn src_app() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("server crate has a parent")
        .to_path_buf()
}

fn packages_dir() -> PathBuf {
    src_app().join("packages")
}

/// Every contributed manifest, parsed by the SAME parser the runtime loader uses.
///
/// Not a hand-rolled slice reader: the types and the parser are already in the crate, a
/// declaration this guard cannot parse is one the loader cannot parse either, and a
/// static analyser written by hand has an unbounded evasion space.
fn manifests() -> Vec<(String, ExtensionManifest)> {
    let dir = packages_dir();
    let mut pkgs: Vec<PathBuf> = std::fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("read {}: {e}", dir.display()))
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    pkgs.sort();

    let mut out = Vec::new();
    for pkg in pkgs {
        let path = pkg.join("manifest.yaml");
        let Ok(src) = std::fs::read_to_string(&path) else {
            continue;
        };
        let parsed: ExtensionManifest = serde_norway::from_str(&src)
            .unwrap_or_else(|e| panic!("{} does not parse: {e}", path.display()));
        let name = pkg
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_string();
        out.push((name, parsed));
    }
    out
}

/// The `key_label` of a datatype's ENTITY axis — the ONE rule, used everywhere this file
/// asks "what is this value's row space?".
///
/// ## Why it is one function and not two readings
///
/// `entity_axis` is declared only where there is a CHOICE to make; the tree's own
/// convention is to omit it for a single-axis datatype, and the multi-axis declarations say
/// so in their comments ("Required here because the type is multi-axis"). Two derivations in
/// this file needed that rule and only ONE of them had it: [`row_bearing_datatypes`] applied
/// the sole-axis reading, while [`anchored_from`] keyed on the presence of `entity_axis` and
/// so could not see the row space of any single-axis type at all.
///
/// That divergence was not cosmetic. It made a real, produced, in-tree alignment read as
/// resting on an axis nothing anchors — because its producer's declared input is a
/// single-axis type, which the fixpoint could not resolve and therefore silently scored as
/// unanchored. Splitting the rule back into two readings is the mutation
/// `an_input_whose_sole_axis_is_anchored_anchors_what_it_produces` exists to kill.
///
/// Returns `None` in exactly the two cases the model refuses to guess at:
///
/// * no axes at all — there is no row space for an answer to be about;
/// * several axes and no `entity_axis` — a declaration that answers nothing. Picking a
///   position here (`axes[0]`) would invent the answer, which is worse than refusing it.
fn entity_axis_key(dt: &DatatypeContribution) -> Option<String> {
    match dt.entity_axis.as_deref() {
        // Declared: it must resolve against this datatype's OWN axes, never a default.
        Some(named) => dt
            .axes
            .iter()
            .find(|a| a.name == named)
            .map(|a| a.key_label.clone()),
        // Not declared: the sole axis IS the entity axis, and nothing else is.
        None => match dt.axes.len() {
            1 => dt.axes.first().map(|a| a.key_label.clone()),
            _ => None,
        },
    }
}

/// The axis identities a dataset arrives carrying — the `key_label`s declared by every
/// datatype at the upload boundary (`ingest:`).
fn original_axis_keys() -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for (_, m) in manifests() {
        for dt in &m.contributes.datatypes {
            if dt.ingest.is_none() {
                continue;
            }
            for axis in &dt.axes {
                out.insert(axis.key_label.clone());
            }
        }
    }
    out
}

/// The ingest-anchored keys, PLUS the keys anchored **transitively** through a producer
/// whose own inputs are anchored (OQ-3 / ITEM-33).
///
/// ## Why the model needed this relation
///
/// A VIRTUAL dataset's axis is not anchored to an uploaded dataset — it is the intersection
/// of several datasets' axes, computed by an analysis. Under the direct rule alone it lands
/// `outside_the_model()`, and the guard's own failure text says what to do about that: it is
/// an owner decision about a relation the model does not have, **not** an exemption to add.
/// An exemption records an UNDECIDABLE ("no producer exists to decide it"), and here a
/// producer does exist, so that reading would be false.
///
/// So the relation is added, and it is **derived by rule rather than enumerated** — which is
/// the property the guard's doc calls load-bearing. The rule, stated exactly:
///
/// > An axis key is anchored when a datatype whose ENTITY AXIS it is (per
/// > [`entity_axis_key`] — declared where there was a choice, the sole axis where there was
/// > not) is PRODUCED by an analysis whose declared inputs (`appliesTo[].subtypes_of`) are
/// > themselves anchored.
///
/// Applied to a fixpoint, so a chain (an alignment over an alignment) resolves, and so the
/// order manifests happen to be read in cannot change the answer.
///
/// The parenthesis is the whole of a real defect this rule shipped with. It originally read
/// "a datatype DECLARING it as its entity axis", which keys on the presence of the optional
/// `entity_axis` field — and the tree's convention is to omit that field on a single-axis
/// type. So an analysis whose declared input is single-axis had an input the fixpoint could
/// not resolve, scored it unanchored, and left what it produces resting on an axis nothing
/// anchors, with the guard reporting the produced type rather than the unreadable input.
///
/// ## What it deliberately still REFUSES — the teeth
///
/// This is a change to a GUARD, so the bar is not "the guard now passes" but "the guard still
/// fails what it was built to catch":
///
/// * an axis with **no producer at all** stays outside the model — held under test by the
///   SYNTHETIC orphan below, which is now where that property lives: the standing exemption
///   acquired an in-tree producer, and its axis stays outside for a different and stronger
///   reason (see `the_widening_did_not_swallow_the_standing_exemption`);
/// * an axis whose producer declares **no inputs** stays outside — nothing anchors it;
/// * an axis whose producer's inputs are themselves unanchored stays outside, because the
///   fixpoint only ever adds keys that reach ingest;
/// * an axis whose producer's input is a MULTI-axis type declaring no `entity_axis` stays
///   outside — that input's row space is unresolvable, and an unresolvable input anchors
///   nothing rather than counting as satisfied.
///
/// `the_derivation_rule_still_refuses_an_unanchored_axis` asserts all three against
/// synthetic manifests, because a widening that makes everything pass is indistinguishable
/// from deleting the test.
fn anchored_axis_keys() -> BTreeSet<String> {
    anchored_from(&manifests())
}

/// The rule itself, over any manifest set — so the teeth test can drive it with synthetic
/// declarations instead of asserting against whatever the tree happens to contain today.
fn anchored_from(
    manifests: &[(
        String,
        cytoanalyst::modules::extensions::types::ExtensionManifest,
    )],
) -> BTreeSet<String> {
    // Seed: the directly-anchored keys.
    let mut anchored: BTreeSet<String> = BTreeSet::new();
    for (_, m) in manifests {
        for dt in &m.contributes.datatypes {
            if dt.ingest.is_none() {
                continue;
            }
            for axis in &dt.axes {
                anchored.insert(axis.key_label.clone());
            }
        }
    }

    // `datatype id -> its entity axis key_label`, under the SHARED rule — so a single-axis
    // type (which declares no `entity_axis`, by the tree's own convention) has a resolvable
    // row space here exactly as it does in `row_bearing_datatypes`.
    //
    // A datatype absent from this map is one whose row space the model cannot resolve, and
    // it stays absent: the fixpoint below then scores it UNANCHORED, which is the
    // conservative direction. `every_analysis_input_has_a_resolvable_row_space` is what
    // makes that case loud instead of leaving it to surface later as an unexplained
    // "rests on an axis no dataset anchors".
    let mut entity_key: BTreeMap<String, String> = BTreeMap::new();
    for (_, m) in manifests {
        for dt in &m.contributes.datatypes {
            if let Some(key) = entity_axis_key(dt) {
                entity_key.insert(dt.id.clone(), key);
            }
        }
    }

    // `(produced datatype, input datatype constraints)` for every ANALYSIS. A converter is
    // deliberately not a carrier here: it runs ON a dataset and produces into that dataset's
    // own axes, so it cannot mint a new axis identity to anchor.
    let mut edges: Vec<(String, Vec<String>)> = Vec::new();
    for (_, m) in manifests {
        for analysis in &m.contributes.analyses {
            let inputs: Vec<String> = analysis
                .rest
                .get("appliesTo")
                .and_then(|v| v.as_array())
                .map(|slots| {
                    slots
                        .iter()
                        .filter_map(|s| s.get("subtypes_of").and_then(|v| v.as_str()))
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            let Some(produces) = analysis.rest.get("produces").and_then(|v| v.as_array()) else {
                continue;
            };
            for produced in produces.iter().filter_map(|p| p.as_str()) {
                edges.push((produced.to_string(), inputs.clone()));
            }
        }
    }

    // Fixpoint. An edge with NO inputs anchors nothing — that is the "produced out of thin
    // air" case, and it must keep failing.
    loop {
        let mut grew = false;
        for (produced, inputs) in &edges {
            if inputs.is_empty() {
                continue;
            }
            let inputs_anchored = inputs.iter().all(|i| {
                entity_key
                    .get(i)
                    .map(|k| anchored.contains(k))
                    .unwrap_or(false)
            });
            if !inputs_anchored {
                continue;
            }
            if let Some(key) = entity_key.get(produced) {
                if anchored.insert(key.clone()) {
                    grew = true;
                }
            }
        }
        if !grew {
            break;
        }
    }
    anchored
}

/// Every declared datatype that names an entity axis, as
/// `datatype id -> (package, entity axis name, that axis's key_label)`.
///
/// A datatype naming an entity axis absent from its own `axes` list is a declaration
/// error, surfaced here rather than resolved to a default.
fn entity_axis_declarations() -> BTreeMap<String, (String, String, String)> {
    let mut out = BTreeMap::new();
    let mut unresolved = Vec::new();
    for (pkg, m) in manifests() {
        for dt in &m.contributes.datatypes {
            let Some(entity) = dt.entity_axis.as_deref() else {
                continue;
            };
            match dt.axes.iter().find(|a| a.name == entity) {
                Some(axis) => {
                    out.insert(
                        dt.id.clone(),
                        (pkg.clone(), entity.to_string(), axis.key_label.clone()),
                    );
                }
                None => unresolved.push(format!("{pkg}: {} names {entity}", dt.id)),
            }
        }
    }
    assert!(
        unresolved.is_empty(),
        "a datatype names an entity axis it does not declare:\n  {}",
        unresolved.join("\n  ")
    );
    out
}

/// Every datatype that HAS a row space, as `datatype id -> its entity axis's key_label`.
///
/// Wider than [`entity_axis_declarations`] on purpose. `entity_axis` is declared only
/// where there is a CHOICE to make — "omit it for a single-axis datatype" — so keying the
/// producer arm on its presence would silently skip every single-axis type, which is most
/// of what a producer emits.
///
/// A datatype declaring NO axis has no row space at all. Those are the opaque ones, and
/// they are absent here BY THE RULE rather than by enumeration: there is no axis for a
/// row space for a disposition to be about, so a new report can never make this arm red.
fn row_bearing_datatypes() -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for (_, m) in manifests() {
        for dt in &m.contributes.datatypes {
            // A datatype declaring NO axis and naming none has no row space at all.
            if dt.entity_axis.is_none() && dt.axes.is_empty() {
                continue;
            }
            // The SHARED rule (`entity_axis_key`): declared where there was a choice, the
            // sole axis where there was not. Several axes and no `entity_axis` is a
            // declaration that answers nothing, and it is registered as `?` rather than
            // resolved to a position.
            out.insert(
                dt.id.clone(),
                entity_axis_key(dt).unwrap_or_else(|| String::from("?")),
            );
        }
    }
    out
}

/// Every `(producer id, datatype)` pair a manifest declares, restricted to the outputs
/// that HAVE a row space.
///
/// Both producer shapes count. A converter types its `produces` entries; an analysis
/// carries its `produces` verbatim in the FE-owned block, as a bare list of ids. Reading
/// only one of them would leave the other able to land a row-bearing output in silence,
/// which is the whole failure this arm is against.
fn producer_outputs() -> BTreeSet<(String, String)> {
    let row_bearing = row_bearing_datatypes();
    let mut out = BTreeSet::new();
    for (_, m) in manifests() {
        for conv in &m.contributes.converters {
            for produced in &conv.produces {
                if row_bearing.contains_key(&produced.datatype) {
                    out.insert((conv.id.clone(), produced.datatype.clone()));
                }
            }
        }
        for analysis in &m.contributes.analyses {
            let Some(produces) = analysis.rest.get("produces").and_then(|v| v.as_array()) else {
                continue;
            };
            for produced in produces {
                let Some(id) = produced.as_str() else {
                    continue;
                };
                if row_bearing.contains_key(id) {
                    out.insert((analysis.id.clone(), id.to_string()));
                }
            }
        }
    }
    out
}

/// The committed producer register, as `(producer, datatype) -> disposition`.
///
/// The disposition vocabulary is CLOSED, because an open one is a free-text field that
/// stops being read. Anything other than `rows-declared` states a reason, on the same rule
/// the lattice entries follow.
fn producer_register() -> BTreeMap<(String, String), String> {
    let doc = exempt_doc();
    let entries = doc
        .get("producer")
        .and_then(|v| v.as_array())
        .unwrap_or_else(|| panic!("the exempt file has no `producer` array"));

    let mut out = BTreeMap::new();
    for entry in entries {
        let producer = entry
            .get("producer")
            .and_then(|v| v.as_str())
            .unwrap_or_else(|| panic!("a producer entry has no `producer`: {entry}"));
        let datatype = entry
            .get("datatype")
            .and_then(|v| v.as_str())
            .unwrap_or_else(|| panic!("a producer entry has no `datatype`: {entry}"));
        let disposition = entry
            .get("disposition")
            .and_then(|v| v.as_str())
            .unwrap_or_else(|| panic!("`{producer}` x `{datatype}` states no disposition"));
        assert!(
            matches!(disposition, "rows-declared" | "rows-undeclared"),
            "`{producer}` x `{datatype}` has disposition `{disposition}`, which is not one \
             of `rows-declared` / `rows-undeclared`. The vocabulary is closed so that a \
             disposition stays a decision rather than a sentence."
        );
        let reason = entry.get("reason").and_then(|v| v.as_str()).unwrap_or("");
        assert!(
            disposition == "rows-declared" || reason.trim().len() >= 40,
            "`{producer}` x `{datatype}` is `{disposition}` and states no reason. An entry \
             without one is a waiver, and this register exists to record decisions."
        );
        assert!(
            out.insert(
                (producer.to_string(), datatype.to_string()),
                disposition.to_string()
            )
            .is_none(),
            "duplicate register entry for `{producer}` x `{datatype}`"
        );
    }
    out
}

/// The exempt file, parsed. ONE reader for both arms, so neither can drift about where
/// the file lives or what a parse failure means.
fn exempt_doc() -> serde_json::Value {
    let path = packages_dir()
        .join("_lib")
        .join("model_coverage_exempt.json");
    let src = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "the exempt list must be committed at {}: {e}",
            path.display()
        )
    });
    serde_json::from_str(&src).unwrap_or_else(|e| panic!("{} does not parse: {e}", path.display()))
}

/// The committed exempt list, as `datatype id -> stated reason`.
fn lattice_exemptions() -> BTreeMap<String, String> {
    let doc = exempt_doc();
    let entries = doc
        .get("lattice")
        .and_then(|v| v.as_array())
        .unwrap_or_else(|| panic!("the exempt file has no `lattice` array"));

    let mut out = BTreeMap::new();
    for entry in entries {
        let id = entry
            .get("datatype")
            .and_then(|v| v.as_str())
            .unwrap_or_else(|| panic!("an exempt entry has no `datatype`: {entry}"));
        let reason = entry.get("reason").and_then(|v| v.as_str()).unwrap_or("");
        assert!(
            reason.trim().len() >= 40,
            "the exempt entry for `{id}` states no reason. An entry without one is a \
             waiver, and the list exists to record undecidables, not to hold them."
        );
        assert!(
            out.insert(id.to_string(), reason.to_string()).is_none(),
            "duplicate exempt entry for `{id}`"
        );
    }
    out
}

/// Ids whose declared entity axis is NOT an original dataset axis — derived, every run.
fn outside_the_model() -> BTreeSet<String> {
    let original = anchored_axis_keys();
    entity_axis_declarations()
        .into_iter()
        .filter(|(_, (_, _, key))| !original.contains(key))
        .map(|(id, _)| id)
        .collect()
}

// ── vacuity floors ──────────────────────────────────────────────────────────
//
// Every assertion below is over a DERIVED set, so a parse that silently collapses
// turns the guard green rather than red. These floors are what fails instead. They
// are measured against THIS tree (2026-08-17: 11 packages, 13 entity-axis
// declarations, 3 original axis identities) and set with margin, so they catch a
// collapse toward zero rather than tracking the lattice.

const MIN_PACKAGES: usize = 8;
const MIN_ENTITY_AXIS_DECLARATIONS: usize = 10;
const MIN_ORIGINAL_AXIS_KEYS: usize = 2;
/// Measured against THIS tree (2026-08-17): 15 row-bearing datatypes, 12 producer x
/// datatype pairs. Set with margin for the same reason as the three above — every
/// producer-arm assertion is over a derived set, and a derivation that collapses to
/// nothing reads as agreement.
const MIN_ROW_BEARING_DATATYPES: usize = 6;
const MIN_PRODUCER_OUTPUTS: usize = 6;

#[test]
fn the_guards_inputs_are_not_vacuous() {
    let pkgs = manifests();
    assert!(
        pkgs.len() >= MIN_PACKAGES,
        "only {} manifests parsed (floor {MIN_PACKAGES}) — the scan collapsed, and \
         every assertion in this file would pass over nothing",
        pkgs.len()
    );

    let declarations = entity_axis_declarations();
    assert!(
        declarations.len() >= MIN_ENTITY_AXIS_DECLARATIONS,
        "only {} entity-axis declarations parsed (floor {MIN_ENTITY_AXIS_DECLARATIONS})",
        declarations.len()
    );

    let original = original_axis_keys();
    assert!(
        original.len() >= MIN_ORIGINAL_AXIS_KEYS,
        "only {} original axis identities derived (floor {MIN_ORIGINAL_AXIS_KEYS}) — \
         with none, EVERY declaration would read as outside the model",
        original.len()
    );

    let row_bearing = row_bearing_datatypes();
    assert!(
        row_bearing.len() >= MIN_ROW_BEARING_DATATYPES,
        "only {} row-bearing datatypes derived (floor {MIN_ROW_BEARING_DATATYPES}) — with \
         none, EVERY producer output would read as opaque and the producer arm would \
         agree with an empty register",
        row_bearing.len()
    );

    let outputs = producer_outputs();
    assert!(
        outputs.len() >= MIN_PRODUCER_OUTPUTS,
        "only {} producer x row-bearing-datatype pairs derived (floor \
         {MIN_PRODUCER_OUTPUTS}) — a `produces` block this guard stopped reading is \
         indistinguishable from a package that produces nothing",
        outputs.len()
    );
}

/// TEST-44 (dimension-membership ITEM-33), LATTICE ARM.
#[test]
fn every_declared_entity_axis_is_original_or_exempt() {
    let exempt = lattice_exemptions();
    let unaccounted: Vec<String> = outside_the_model()
        .into_iter()
        .filter(|id| !exempt.contains_key(id))
        .collect();

    assert!(
        unaccounted.is_empty(),
        "{} declared datatype(s) rest on an axis no dataset anchors, with no stated \
         disposition:\n  {}\n\nThis is the shape the model does not hold. Either the \
         declaration is wrong, or the model needs a relation it does not have — and \
         that is an owner decision, not an entry to add here reflexively. Adding an \
         entry to `packages/_lib/model_coverage_exempt.json` records an UNDECIDABLE \
         (no producer exists to decide it); it does not make the datatype accounted for.",
        unaccounted.len(),
        unaccounted.join("\n  ")
    );
}

/// TEST-45 (dimension-membership ITEM-33) — the lattice list and the tree agree, checked as
/// a SET in both directions.
///
/// Never against the list's length or its presence: a guard satisfied by its own size is
/// the shape this file exists to refuse.
#[test]
fn the_exempt_list_and_the_tree_agree() {
    let derived = outside_the_model();
    let listed: BTreeSet<String> = lattice_exemptions().into_keys().collect();

    let stale: Vec<&String> = listed.difference(&derived).collect();
    assert!(
        stale.is_empty(),
        "exempt entries that no longer describe the tree — the datatype was removed, or \
         its entity axis became one a dataset anchors, so the entry now exempts nothing \
         and reads as a live undecidable:\n  {stale:?}"
    );

    let missing: Vec<&String> = derived.difference(&listed).collect();
    assert!(
        missing.is_empty(),
        "declared datatypes outside the model with no entry:\n  {missing:?}"
    );
}

/// TEST-44 (dimension-membership ITEM-33), PRODUCER ARM — the register and the tree agree,
/// as a SET, BOTH ways.
///
/// The two directions fail for different reasons and neither substitutes for the other: a
/// MISSING entry is a producer that landed a row-bearing output with nobody deciding what
/// it declares, and a STALE one is a register that has stopped describing the tree and is
/// therefore no longer evidence of anything.
#[test]
fn every_producer_output_with_a_row_space_is_registered() {
    let derived = producer_outputs();
    let registered: BTreeSet<(String, String)> = producer_register().into_keys().collect();

    let missing: Vec<String> = derived
        .difference(&registered)
        .map(|(p, d)| format!("{p} x {d}"))
        .collect();
    assert!(
        missing.is_empty(),
        "{} producer output(s) with a row space and no registered disposition:\n  {}\n\n\
         A producer emitting rows of an axis either declares WHICH of that axis's rows \
         they are, or says why it does not. Add an entry to \
         `packages/_lib/model_coverage_exempt.json` under `producer` — `rows-declared` \
         once the compute states which rows it wrote, `rows-undeclared` with a reason \
         while it does not.",
        missing.len(),
        missing.join("\n  ")
    );

    let stale: Vec<String> = registered
        .difference(&derived)
        .map(|(p, d)| format!("{p} x {d}"))
        .collect();
    assert!(
        stale.is_empty(),
        "register entries that no longer describe the tree — the producer was removed, \
         the output was dropped, or its datatype lost its row space:\n  {}",
        stale.join("\n  ")
    );
}

// ════════════════════════════════════════════════════════════════════════════
//  ITEM-33 — THE TEETH. A widening that makes everything pass is a deletion.
// ════════════════════════════════════════════════════════════════════════════
//
// `anchored_axis_keys()` added a RELATION to the model: an axis produced by an analysis
// whose inputs are themselves anchored is anchored too. That is what lets a virtual
// dataset's axis be accounted for without an exemption — and it is exactly the kind of
// change that can quietly turn a guard into a no-op.
//
// So the rule is driven here against SYNTHETIC manifests, covering the three shapes it must
// still refuse. Asserting only against the live tree would prove the rule accepts what is
// there today, which is the weaker half and the one that cannot fail.

fn manifest_from(yaml: &str) -> cytoanalyst::modules::extensions::types::ExtensionManifest {
    serde_norway::from_str(yaml).expect("synthetic manifest parses")
}

/// An INGEST-anchored datatype, so the synthetic tree has a real seed to reach.
const ANCHORED_SOURCE: &str = r#"
id: synth-src
name: Synthetic Source
publisher: t
version: 0.0.1
apiVersion: "1.0"
contributes:
  datatypes:
    - id: synth/source
      title: synth/source
      storage: { layout: { kind: chunked_dense }, format: zarr, file_layout: single }
      axes:
        - { name: rows, key_label: synth_key }
      entity_axis: rows
      ingest: { extensions: [".synth"] }
"#;

#[test]
fn the_derivation_rule_still_refuses_an_unanchored_axis() {
    let src = ("synth-src".to_string(), manifest_from(ANCHORED_SOURCE));

    // (a) NO PRODUCER AT ALL. Nothing anchors it, and the relation must not reach it. This
    // synthetic case is now the ONLY carrier of that property: the tree's standing exemption
    // used to double as the live example, and it has since acquired a real producer.
    let orphan = manifest_from(
        r#"
id: synth-orphan
name: Orphan
publisher: t
version: 0.0.1
apiVersion: "1.0"
contributes:
  datatypes:
    - id: synth/orphan
      title: synth/orphan
      storage: { layout: { kind: chunked_dense }, format: zarr, file_layout: single }
      axes: [{ name: nodes, key_label: synth_node }]
      entity_axis: nodes
"#,
    );
    let keys = anchored_from(&[src.clone(), ("synth-orphan".into(), orphan)]);
    assert!(
        keys.contains("synth_key"),
        "the seed must be anchored, or this test proves nothing about the rule"
    );
    assert!(
        !keys.contains("synth_node"),
        "an axis NO producer emits must stay outside the model. This is the property the \
         `graph/attributed` exemption ORIGINALLY rested on; that exemption now has a real \
         producer and rests on a stronger reason instead, so this synthetic case is what \
         keeps the no-producer branch under test, and a rule that swallowed it would make \
         the whole relation vacuous"
    );

    // (b) A PRODUCER WITH NO DECLARED INPUTS — produced out of thin air.
    let thin_air = manifest_from(
        r#"
id: synth-thin
name: Thin Air
publisher: t
version: 0.0.1
apiVersion: "1.0"
contributes:
  analyses:
    - id: synth.thin
      category: t
      title: Thin
      produces: [synth/thin]
  datatypes:
    - id: synth/thin
      title: synth/thin
      storage: { layout: { kind: chunked_dense }, format: zarr, file_layout: single }
      axes: [{ name: things, key_label: synth_thing }]
      entity_axis: things
"#,
    );
    let keys = anchored_from(&[src.clone(), ("synth-thin".into(), thin_air)]);
    assert!(
        !keys.contains("synth_thing"),
        "an analysis that declares NO inputs anchors nothing — otherwise any producer could \
         mint an axis identity by existing, which is the whole property being guarded"
    );

    // (c) A PRODUCER WHOSE INPUTS ARE THEMSELVES UNANCHORED — the transitive case, and the
    // one a non-fixpoint implementation gets wrong in the permissive direction.
    let chained = manifest_from(
        r#"
id: synth-chain
name: Chain
publisher: t
version: 0.0.1
apiVersion: "1.0"
contributes:
  analyses:
    - id: synth.chain
      category: t
      title: Chain
      appliesTo: [{ slot: datasets, subtypes_of: synth/orphan }]
      produces: [synth/chained]
  datatypes:
    - id: synth/orphan
      title: synth/orphan
      storage: { layout: { kind: chunked_dense }, format: zarr, file_layout: single }
      axes: [{ name: nodes, key_label: synth_node }]
      entity_axis: nodes
    - id: synth/chained
      title: synth/chained
      storage: { layout: { kind: chunked_dense }, format: zarr, file_layout: single }
      axes: [{ name: derived, key_label: synth_derived }]
      entity_axis: derived
"#,
    );
    let keys = anchored_from(&[src.clone(), ("synth-chain".into(), chained)]);
    assert!(
        !keys.contains("synth_derived"),
        "anchoring must be TRANSITIVE to ingest: a producer whose own input is unanchored \
         anchors nothing, or the relation launders any axis through one hop"
    );

    // (d) THE POSITIVE ARM — the rule does accept the case it was added for, or it is not a
    // widening at all and the three refusals above are trivially satisfied.
    let integrated = manifest_from(
        r#"
id: synth-integrate
name: Integrate
publisher: t
version: 0.0.1
apiVersion: "1.0"
contributes:
  analyses:
    - id: synth.integrate
      category: t
      title: Integrate
      appliesTo: [{ slot: datasets, multiple: true, subtypes_of: synth/source }]
      produces: [synth/alignment]
  datatypes:
    - id: synth/alignment
      title: synth/alignment
      storage: { layout: { kind: chunked_dense }, format: zarr, file_layout: single }
      axes: [{ name: unified, key_label: synth_unified }]
      entity_axis: unified
"#,
    );
    let keys = anchored_from(&[src, ("synth-integrate".into(), integrated)]);
    assert!(
        keys.contains("synth_unified"),
        "an axis produced by an analysis over ANCHORED inputs is anchored — this is the \
         relation ITEM-33 adds, and without this arm the refusals above would also be \
         satisfied by a rule that anchors nothing"
    );
}

// ────────────────────────────────────────────────────────────────────────────
//  THE SHARED ENTITY-AXIS RULE. One reading of "what is this value's row space",
//  driven against synthetic declarations, with the permissive mis-fixes named.
// ────────────────────────────────────────────────────────────────────────────
//
// The defect these cover: `anchored_from` keyed on the PRESENCE of the optional
// `entity_axis` field while `row_bearing_datatypes` applied the sole-axis rule, so an
// analysis over a single-axis input had an input the fixpoint could not read.
//
// Each assertion below states the mutation it uniquely kills, because a test that only
// asserts the tree as it stands today is circular — it would pass against a declaration
// edited to match it.

/// An INGEST-anchored single-axis source, declaring NO `entity_axis` — the shape of the
/// live input that exposed the defect, and the shape the tree's convention produces.
const ANCHORED_SINGLE_AXIS_SOURCE: &str = r#"
id: synth-sole
name: Sole Axis Source
publisher: t
version: 0.0.1
apiVersion: "1.0"
contributes:
  datatypes:
    - id: synth/sole
      title: synth/sole
      storage: { layout: { kind: chunked_1d }, format: zarr, file_layout: single }
      axes:
        - { name: rows, key_label: synth_sole_key }
      ingest: { extensions: [".synth"] }
"#;

#[test]
fn an_input_whose_sole_axis_is_anchored_anchors_what_it_produces() {
    let src = (
        "synth-sole".to_string(),
        manifest_from(ANCHORED_SINGLE_AXIS_SOURCE),
    );

    // A single-axis, NON-ingest carrier over that anchored axis — the `metadata-column`
    // shape — and an analysis that consumes it and produces a new axis identity.
    let over_sole = manifest_from(
        r#"
id: synth-over-sole
name: Over Sole
publisher: t
version: 0.0.1
apiVersion: "1.0"
contributes:
  analyses:
    - id: synth.carry
      category: t
      title: Carry
      appliesTo: [{ slot: rows, subtypes_of: synth/sole }]
      produces: [synth/carried]
    - id: synth.fuse
      category: t
      title: Fuse
      appliesTo: [{ slot: rows, multiple: true, subtypes_of: synth/carried }]
      produces: [synth/fused]
  datatypes:
    - id: synth/carried
      title: synth/carried
      storage: { layout: { kind: chunked_1d }, format: zarr, file_layout: single }
      axes: [{ name: rows, key_label: synth_sole_key }]
    - id: synth/fused
      title: synth/fused
      storage: { layout: { kind: chunked_dense }, format: zarr, file_layout: single }
      axes:
        - { name: unified, key_label: synth_fused_key }
        - { name: out_rows, key_label: synth_out_row }
      entity_axis: unified
"#,
    );
    let keys = anchored_from(&[src, ("synth-over-sole".into(), over_sole)]);

    assert!(
        keys.contains("synth_sole_key"),
        "the ingest seed must be anchored, or this test proves nothing about the rule"
    );
    // KILLS: reverting `entity_key` to `dt.entity_axis`-keyed. `synth/carried` declares no
    // `entity_axis` — under the old reading it is absent from the map, `synth.fuse`'s input
    // scores unanchored, and `synth_fused_key` never anchors. This is the live defect,
    // reproduced without naming a single domain id.
    assert!(
        keys.contains("synth_fused_key"),
        "an analysis over a SINGLE-AXIS input (which by convention declares no \
         `entity_axis`) must resolve that input's row space and anchor what it produces — \
         keying on the presence of the optional field instead makes every such input \
         unreadable, and reports the produced type as the problem"
    );
}

#[test]
fn an_unresolvable_or_unanchored_input_still_anchors_nothing() {
    let src = (
        "synth-sole".to_string(),
        manifest_from(ANCHORED_SINGLE_AXIS_SOURCE),
    );

    // (a) A single-axis input whose sole axis reaches NO ingest.
    let floating = manifest_from(
        r#"
id: synth-floating
name: Floating
publisher: t
version: 0.0.1
apiVersion: "1.0"
contributes:
  analyses:
    - id: synth.float
      category: t
      title: Float
      appliesTo: [{ slot: rows, subtypes_of: synth/floating }]
      produces: [synth/from-floating]
  datatypes:
    - id: synth/floating
      title: synth/floating
      storage: { layout: { kind: chunked_1d }, format: zarr, file_layout: single }
      axes: [{ name: rows, key_label: synth_floating_key }]
    - id: synth/from-floating
      title: synth/from-floating
      storage: { layout: { kind: chunked_1d }, format: zarr, file_layout: single }
      axes: [{ name: rows, key_label: synth_from_floating }]
"#,
    );
    let keys = anchored_from(&[src.clone(), ("synth-floating".into(), floating)]);
    // KILLS: the permissive over-fix — treating an input the map cannot score as satisfied
    // (`.unwrap_or(true)` in `inputs_anchored`, or dropping the `inputs_anchored` guard).
    // Under that mutation the sole-axis rule would launder ANY axis through one hop.
    assert!(
        !keys.contains("synth_from_floating"),
        "a single-axis input whose own axis reaches no ingest anchors nothing — the \
         sole-axis rule makes an input READABLE, it does not make it anchored"
    );

    // (b) A MULTI-axis input declaring no `entity_axis`, every one of whose axes is an
    // anchored key. Its row space is genuinely unresolvable: the declaration answers
    // nothing, and the model refuses to pick a position.
    let ambiguous = manifest_from(
        r#"
id: synth-ambiguous
name: Ambiguous
publisher: t
version: 0.0.1
apiVersion: "1.0"
contributes:
  analyses:
    - id: synth.ambiguous
      category: t
      title: Ambiguous
      appliesTo: [{ slot: rows, subtypes_of: synth/ambiguous }]
      produces: [synth/from-ambiguous]
  datatypes:
    - id: synth/ambiguous
      title: synth/ambiguous
      storage: { layout: { kind: chunked_dense }, format: zarr, file_layout: single }
      axes:
        - { name: rows, key_label: synth_sole_key }
        - { name: cols, key_label: synth_sole_key }
    - id: synth/from-ambiguous
      title: synth/from-ambiguous
      storage: { layout: { kind: chunked_1d }, format: zarr, file_layout: single }
      axes: [{ name: rows, key_label: synth_from_ambiguous }]
"#,
    );
    let keys = anchored_from(&[src, ("synth-ambiguous".into(), ambiguous)]);
    // KILLS: resolving the sole-axis rule as `axes.first()` / "any axis is the entity axis"
    // rather than "exactly one axis". Both axes here carry an ANCHORED key, so a positional
    // reading anchors the output and only this arm notices.
    assert!(
        !keys.contains("synth_from_ambiguous"),
        "a MULTI-axis input declaring no `entity_axis` answers nothing about its row \
         space; picking a position would invent the answer, so it must anchor nothing even \
         when every axis it names is itself anchored"
    );
}

/// The live tree's analysis inputs all have a row space the model can READ.
///
/// This is the loud gate. Without it, the next input datatype the shared rule cannot
/// resolve reproduces the exact failure this change fixed: the fixpoint scores it
/// unanchored, and the guard goes red naming the PRODUCED datatype — a report that points
/// at the wrong declaration and reads as an unexplained standing failure.
///
/// It spells no id: the inputs and the datatypes are both derived from the manifests.
#[test]
fn every_analysis_input_has_a_resolvable_row_space() {
    let all = manifests();

    let mut resolvable: BTreeSet<String> = BTreeSet::new();
    let mut declared: BTreeSet<String> = BTreeSet::new();
    for (_, m) in &all {
        for dt in &m.contributes.datatypes {
            declared.insert(dt.id.clone());
            if entity_axis_key(dt).is_some() {
                resolvable.insert(dt.id.clone());
            }
        }
    }

    let mut inputs: BTreeSet<(String, String)> = BTreeSet::new();
    for (_, m) in &all {
        for analysis in &m.contributes.analyses {
            let Some(slots) = analysis.rest.get("appliesTo").and_then(|v| v.as_array()) else {
                continue;
            };
            for slot in slots {
                if let Some(id) = slot.get("subtypes_of").and_then(|v| v.as_str()) {
                    inputs.insert((analysis.id.clone(), id.to_string()));
                }
            }
        }
    }
    assert!(
        !inputs.is_empty(),
        "no analysis input constraints were read at all — this assertion would then hold \
         over nothing, which is the vacuity shape every derivation in this file guards"
    );

    let unreadable: Vec<String> = inputs
        .iter()
        .filter(|(_, id)| declared.contains(id) && !resolvable.contains(id))
        .map(|(a, id)| format!("{a} <- {id}"))
        .collect();
    assert!(
        unreadable.is_empty(),
        "{} analysis input(s) name a declared datatype whose ROW SPACE the model cannot \
         resolve — several axes and no `entity_axis`:\n  {}\n\nThe anchoring fixpoint \
         scores such an input unanchored, so whatever the analysis produces will read as \
         resting on an axis nothing anchors, and the guard will name the PRODUCED type \
         instead of this one. Declare `entity_axis` on the input datatype; that is where \
         the choice actually is.",
        unreadable.len(),
        unreadable.join("\n  ")
    );
}

/// TEST-19 — the live tree still keeps its one exemption OUTSIDE the model after the widening.
///
/// `the_exempt_list_and_the_tree_agree` already fails on a stale entry, but it would also
/// pass if the entry were removed alongside the widening. This says the quiet part.
///
/// The assertion is UNCHANGED and its bar has gone UP. It used to hold for a reason that took
/// no work — the kind had no in-tree producer at all, so no derivation could reach it, and the
/// check was true by absence. A producer has since landed, so the assertion now states
/// something with content: that the anchoring relation does NOT reach this producer's output.
/// It does not, and the reason is a decision recorded beside the register rather than an
/// accident of the fixpoint: the producer's nodes are LEVELS of a categorical column — a
/// partition OF an axis, not entries of one — so no upload anchors them.
///
/// Deleting this check when it acquired teeth would have been exactly backwards; the standing
/// bar for touching a guard here is that it still fails what it was built to catch, so what
/// changed is the stated reason, not the assertion. The no-producer branch it used to double
/// as the live example of is now carried by the synthetic orphan in
/// `the_derivation_rule_still_refuses_an_unanchored_axis`, where it stays true.
#[test]
fn the_widening_did_not_swallow_the_standing_exemption() {
    assert!(
        outside_the_model().contains("graph/attributed"),
        "`graph/attributed` is now INSIDE the model. Its entity axis is anchored only if some \
         producer's declared inputs anchor it, and the decision recorded in the register is \
         that this kind's nodes are levels of a categorical column rather than entries of any \
         uploaded axis. If this fails, either the relation is reaching further than the rule \
         it states, or that decision has changed and the register must change with it"
    );
}
