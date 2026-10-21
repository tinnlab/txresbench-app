//! BUILD-TIME processor-manifest syntax gate (ITEM-8 / DEC-5, INV-5).
//!
//! The OWNER'S explicit ask — "compile-time checking for syntax of the
//! processor". A malformed `src-app/packages/<name>/manifest.yaml` must fail
//! at BUILD/`cargo check` time with a clear, PACKAGE-SCOPED error, not silently
//! mis-load (the runtime outer `Contributes` deliberately does NOT
//! `deny_unknown_fields`, DEC-4) or surface only at server boot.
//!
//! ## Mechanism
//! `build.rs` `#[path]`-includes this file (mirroring the `rootfs::version`
//! precedent) and calls [`lint_processor_tree`]; a returned `Err` is turned into
//! a `panic!` that fails the build — the SAME panic-on-malformed contract the
//! hub-seed build helper uses. It is ALSO `#[path]`-included (test-only) into the
//! crate so its `#[cfg(test)]` backstop (TEST-12) runs under `cargo test`.
//!
//! ## Why its own schema structs (not the runtime `ExtensionManifest`)
//! `build.rs` runs BEFORE the crate compiles, so it cannot use the crate's own
//! types. This module therefore carries a SELF-CONTAINED minimal mirror of the
//! manifest — using only `serde` / `serde_norway` / `serde_json` (build-deps) —
//! and, crucially, models the **UNIFIED** manifest: BOTH the backend keys
//! (`converters` / `views` / `datatypes`) AND the FE key (`analyses`), so
//! `#[serde(deny_unknown_fields)]` catches a genuine typo at the LINT boundary
//! WITHOUT rejecting the legitimate `analyses:` block every real package carries
//! (which whole-manifest `deny_unknown_fields` on the RUNTIME struct could not do
//! — that is the entire point of a separate lint schema, per ITEM-8's audit).
//!
//! The `ui/*.yaml` declarative view-spec half is a TS-side schema `build.rs`
//! cannot reach; it is validated by a vitest arm (`declarative/processorViewSpecs.test.ts`)
//! run in the FE `test:unit` pass (DEC-5).

use std::path::Path;

use serde::Deserialize;

/// The 6 universal ROOT datatype ids the app builtin (`datatype/builtin.rs`) still
/// code-seeds (DEC-2). A contributed datatype's `extends` must resolve to one of
/// these OR to another contributed id — otherwise it is a DANGLING `extends`.
/// Kept in lockstep with `builtin.rs`'s `seed!` roots (a divergence would either
/// false-fail a legitimate root-extending package or miss a dangling target; the
/// set is tiny + rarely changes, so a literal here is clearer than reaching into
/// the crate — which `build.rs` cannot do anyway).
const ROOT_DATATYPE_IDS: &[&str] = &[
    "data",
    "data/opaque",
    "tabular",
    "matrix",
    "report/html",
    "file/upload",
];

// ───────────────────────────── unified manifest schema ─────────────────────────
//
// deny_unknown_fields at EVERY level whose keys are fully enumerable, so a typo'd
// key fails the parse. Complex, free-form nested values (an analysis' `params` /
// `accepts` / `run`, a datatype `schema` / `axes` / `input_requirements`) are
// `serde_json::Value` — validated structurally where it matters (the `schema`
// shape below), never key-denied (their inner vocabulary is owned elsewhere).

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProcessorManifest {
    #[allow(dead_code)]
    id: String,
    #[allow(dead_code)]
    name: String,
    #[serde(default)]
    #[allow(dead_code)]
    publisher: Option<String>,
    #[allow(dead_code)]
    version: String,
    #[serde(rename = "apiVersion")]
    #[allow(dead_code)]
    api_version: String,
    #[serde(default)]
    #[allow(dead_code)]
    activation: Option<Vec<String>>,
    #[serde(default)]
    #[allow(dead_code)]
    dependencies: Option<Vec<String>>,
    #[serde(default)]
    contributes: Contributes,
}

/// The UNIFIED contribution block — backend (`converters`/`views`/`datatypes`) AND
/// FE (`analyses`) keys together, `deny_unknown_fields` so a `contributes.*` typo
/// (`converterz:` / `analysez:`) fails the build.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct Contributes {
    #[serde(default)]
    converters: Vec<Converter>,
    #[serde(default)]
    #[allow(dead_code)]
    views: Vec<View>,
    #[serde(default)]
    datatypes: Vec<DatatypeContribution>,
    #[serde(default)]
    #[allow(dead_code)]
    analyses: Vec<Analysis>,
    /// ITEM-1c — the LATENT TRAP, closed. `contributes.actions` has existed in the
    /// RUNTIME parser (`extensions/types.rs`) since S4, but was absent here — and this
    /// block is `deny_unknown_fields`, so the first package to actually spell
    /// `contributes.actions:` would have failed `build.rs` for everyone, with nothing
    /// but the serde message to explain why. It never fired only because no shipped
    /// manifest declares one. Independent of the sections work; fixed alongside it
    /// because it is the exact trap `sections` below must not repeat, and
    /// `build_lint_contributes_is_a_superset_of_the_runtime_contributes` is the
    /// regression test that now makes the pairing mechanical rather than remembered.
    #[serde(default)]
    #[allow(dead_code)]
    actions: Vec<Action>,
    /// The VISUALIZE-PANE sections mirror (ITEM-1). Must land in the same commit as
    /// the runtime `Contributes::sections` — see the superset test.
    #[serde(default)]
    #[allow(dead_code)]
    sections: Vec<Section>,
}

/// The build-lint mirror of `extensions::types::ActionContribution` (ITEM-1c).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)]
struct Action {
    action_type: String,
    fidelity: String,
    #[serde(default)]
    dispatchable: bool,
    #[serde(default)]
    recipe: Option<String>,
}

/// The build-lint mirror of `extensions::types::SectionContribution` (ITEM-1).
///
/// `deny_unknown_fields` at both levels, for the reason the runtime type documents:
/// `pane` is not `area`/`region`/`role`, and a section's `applies_to` never names a
/// producer (INV-18). A manifest that spells either fails the BUILD, naming the key.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)]
struct Section {
    id: String,
    title: String,
    pane: String,
    #[serde(default)]
    order: Option<f64>,
    #[serde(default)]
    collapsed: bool,
    #[serde(default)]
    applies_to: Vec<SectionSelector>,
    #[serde(default)]
    ui: Vec<String>,
}

/// The build-lint mirror of `extensions::types::SectionSelector` (ITEM-1 / INV-18).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)]
struct SectionSelector {
    #[serde(default)]
    type_id: Option<String>,
    #[serde(default)]
    subtypes_of: Option<String>,
    #[serde(default)]
    capabilities: Vec<String>,
    #[serde(default)]
    excludes: Vec<String>,
}

// The env-id GRAMMAR, single-sourced (#189). `#[path]`-included rather than imported
// because this module is compiled TWICE — into `build.rs` and, via lib.rs, into the
// crate — so it must stay self-contained (no `crate::` paths, which resolve to two
// different roots). Including the runtime's own grammar file is what makes "the build
// lint and the runtime accept the same env-ids" true by construction instead of by
// two mirrors somebody has to keep in step.
//
// The failure this prevents is the SILENT one: were the lint laxer than the runtime, a
// package would pass the build and then fail to register at boot, contributing nothing
// while every gate stayed green.
#[path = "../src/modules/sandbox/env_id.rs"]
mod env_id;

/// Strict `env:` deserializer for the lint mirror — the build-time twin of the runtime
/// `de_checked_env` (`extensions/types.rs`), enforcing the identical grammar via the
/// identical predicate. The error names the key AND the offending value, because this
/// message is what a package author sees when the build fails.
fn de_checked_env<'de, D>(de: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = <Option<String> as serde::Deserialize>::deserialize(de)?;
    match raw {
        None => Ok(None),
        Some(v) if env_id::is_valid_env_id(&v) => Ok(Some(v)),
        Some(v) => Err(serde::de::Error::custom(format!(
            "`env` must be a lowercase OCI repository path component \
             (a-z, 0-9, `.`, `_`, `-`; non-empty) — got `env: {v:?}`"
        ))),
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Converter {
    #[allow(dead_code)]
    id: String,
    #[allow(dead_code)]
    title: String,
    #[allow(dead_code)]
    trigger: String,
    #[serde(default)]
    #[allow(dead_code)]
    params: Option<serde_json::Value>,
    #[serde(default, deserialize_with = "de_checked_env")]
    #[allow(dead_code)]
    env: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    accepts: Vec<serde_json::Value>,
    #[serde(default)]
    #[allow(dead_code)]
    produces: Vec<serde_json::Value>,
    //
    // `produces_annotations` IS ABSENT ON PURPOSE (INV-5), and its absence is the gate:
    // `deny_unknown_fields` above turns a converter still declaring the producer-output
    // column forecast into a BUILD failure naming the file, line and key. It was the one
    // half of the forecast that the analysis-level removal did not reach — converters are
    // parsed by a different path (DRIFT-1.5/1.6) but are not exempt from the removed-key
    // gate. Column types are read from the artifacts that landed, never forecast here.
    /// TYPED for the same reason the analysis `run` is — see `RunSpec`. A converter's
    /// `run` block was an opaque `Value` too, so `run.inputs` rode through here as well;
    /// converters are parsed by a different path (DRIFT-1.5/1.6) but they are not exempt
    /// from the removed-key gate.
    #[allow(dead_code)]
    run: RunSpec,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct View {
    #[allow(dead_code)]
    id: String,
    #[allow(dead_code)]
    title: String,
    #[allow(dead_code)]
    datatype: String,
    #[allow(dead_code)]
    entry: String,
    #[serde(default)]
    #[allow(dead_code)]
    view_spec: Option<String>,
}

/// The FE analysis contribution as DATA — mirrors `@cyto/workbench-api`
/// `ProcessorAnalysisData` (the authoritative FE schema). `deny_unknown_fields`
/// catches a typo'd analysis key; a real manifest can only use keys the TS
/// interface declares, so denial here never false-fails the build.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)]
struct Analysis {
    id: String,
    category: String,
    title: String,
    /// #189 — the analysis-side `env:` declaration, the twin of `Converter::env`.
    ///
    /// Required here for the SAME reason `draftable` below is: this struct is
    /// `deny_unknown_fields`, so without the field a manifest declaring `env:` on an
    /// analysis fails the lint and the whole package is SKIPPED. That failure mode is
    /// the one worth naming — the package contributes nothing, and the visible symptom
    /// is an analysis that has simply vanished from the workbench, not a message about
    /// the key that caused it.
    ///
    /// Strictly parsed, so a malformed env-id fails the BUILD naming the key and the
    /// value, rather than reaching the runtime.
    #[serde(default, deserialize_with = "de_checked_env")]
    env: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(rename = "whenHint", default)]
    when_hint: Option<String>,
    #[serde(default)]
    examples: Option<Vec<String>>,
    #[serde(default)]
    safety: Option<String>,
    #[serde(default)]
    ai: Option<bool>,
    #[serde(default)]
    order: Option<f64>,
    /// What the analysis APPLIES TO — every entry required (no per-entry `required`
    /// flag), each optionally naming the input `slot` it binds. Replaces `accepts` +
    /// `when` + `params.fields`.
    #[serde(rename = "appliesTo", default)]
    applies_to: Vec<serde_json::Value>,
    /// Datatypes READ but not required — the chaining graph edge that an `accepts`
    /// entry with `required: false` used to smuggle. Never an availability input.
    #[serde(default)]
    consumes: Vec<String>,
    #[serde(default)]
    produces: Vec<serde_json::Value>,
    /// The view files this analysis renders, in order; multiple stack into ONE pane.
    /// Absent ⇒ no view ⇒ the generic fallback form.
    #[serde(default)]
    ui: Vec<String>,
    /// TYPED, not `serde_json::Value`. As an opaque `Value` these two were the ONE hole
    /// in the removed-key gate: `deny_unknown_fields` guards the keys it can SEE, and an
    /// opaque `Value` sees nothing — so `run.inputs` and `schedule.resources`, both
    /// removed keys, rode straight through the build while the comment below claimed
    /// they "cannot even compile". Found by the sandbox-mount agent reading the gate
    /// rather than trusting it.
    #[serde(default)]
    run: Option<RunSpec>,
    /// draftable-entity ITEM-9 — the opaque `draftable` block. The RUNTIME
    /// `AnalysisContributionData` carries it through `#[serde(flatten)] rest`, but this
    /// build-lint `Analysis` is `deny_unknown_fields`, so WITHOUT a field here a manifest
    /// declaring `draftable:` fails the lint (unknown field) and the package is SKIPPED —
    /// no draftable package could ever load (`find_draftable_by_kind` → None → freeze 422).
    /// Mirrored TYPED + `deny_unknown_fields` so a typo'd draftable key still fails the
    /// build, matching this file's superset-of-runtime discipline.
    #[serde(default)]
    draftable: Option<DraftableSpec>,
    #[serde(default)]
    schedule: Option<ScheduleSpec>,
    #[serde(default)]
    arch: Option<Vec<String>>,
    #[serde(default)]
    launchable: Option<bool>,
    #[serde(default)]
    trigger: Option<String>,
    #[serde(rename = "methodsText", default)]
    methods_text: Option<String>,
    /// S3 — the DECLARATIVE methods narration (mirrors `MethodsNarration` in
    /// `extensions/types.rs`). Typed here so a typo'd param role or a missing
    /// `subject` fails the BUILD, rather than silently degrading the exported
    /// `methods.md` — the out-of-app trust deliverable — to the generic sentence.
    #[serde(default)]
    methods: Option<MethodsNarration>,
    //
    // REMOVED KEYS ARE ABSENT ON PURPOSE. `deny_unknown_fields` above turns each into a
    // BUILD failure naming the file, line and key — which is the strongest form of the
    // hard-fail DEC-3 asks for: a manifest carrying `accepts`, `when`, `params`,
    // `defaults`, `produces_annotations`, `run.inputs`, `schedule.resources`,
    // `inStandardRecipe` or `recipeOrder` cannot even compile, let alone load. It is what
    // caught the first migrated manifest here.
    //
    // That claim is only true because `run` and `schedule` are TYPED above. They were
    // `Option<serde_json::Value>`, and `deny_unknown_fields` guards the keys it can SEE —
    // an opaque `Value` has none — so the two NESTED removed keys were exactly the pair
    // the gate could not catch, while this comment asserted the opposite.
}

/// The `run` block, TYPED so the gate can see inside it. Field set derived from the
/// shipped manifests (`entry`/`helpers`/`host_resources`/`kind`/`runtime`), not guessed.
/// `inputs` is ABSENT and `deny_unknown_fields` is what makes that a build failure:
/// the runner derives every mount name from the artifact now (ITEM-23), so a declared
/// `inputs` is a name the run does not use — the exact class of silently-ignored
/// declaration this change exists to remove.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)]
struct RunSpec {
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    entry: Option<String>,
    #[serde(default)]
    runtime: Option<serde_json::Value>,
    #[serde(default)]
    helpers: Option<serde_json::Value>,
    #[serde(default)]
    host_resources: Option<serde_json::Value>,
    /// #80 — the declared library + version-range contract. TYPED (not an opaque
    /// `Value`) for the same reason `run`/`schedule` are: `deny_unknown_fields` guards
    /// only the keys it can SEE, and this is the block whose whole job is to be
    /// enforceable. It must land in the SAME commit as the runtime mirror in
    /// `extensions/types.rs::RunSpec` — this struct denies unknown fields, so a manifest
    /// declaring a key only the runtime knows fails the BUILD for everyone.
    #[serde(default)]
    dependencies: Vec<DependencyRequirement>,
}

/// The build-lint mirror of `extensions::types::DependencyRequirement` (#80).
///
/// `deny_unknown_fields` at both levels: a dependency contract that silently parses to
/// "declares nothing" is worse than none, because the build stays green while enforcing
/// nothing. `PartialEq` so the shipped-tree test can compare declarations across
/// packages without re-parsing.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
struct DependencyRequirement {
    /// The distribution name, as the env recipe's pin set spells it.
    library: String,
    /// The supported range: a comma-ANDed specifier set over dotted-numeric releases.
    version: String,
    /// Used only on some paths (see the runtime mirror). Deliberately makes NO difference
    /// to this gate: the environment must still provide it, and its pin must still fall
    /// inside the declared range. An environment that cannot support that path at all is
    /// a build-time fact; `optional` is a statement about the RUN, not about the recipe.
    #[serde(default)]
    #[allow(dead_code)]
    optional: bool,
}

/// draftable-entity ITEM-9 — build-lint mirror of `extensions::types::DraftableSpec`.
/// Every field is an opaque, package-owned string the core carries but never interprets;
/// `kind` + `freeze` are required (mirroring the runtime struct), `edit` + `freeze_on`
/// default. `deny_unknown_fields` so a typo'd draftable key fails the build.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)]
struct DraftableSpec {
    kind: String,
    freeze: String,
    #[serde(default)]
    edit: Option<String>,
    #[serde(default)]
    freeze_on: Vec<String>,
}

/// The `schedule` block. `class` is the only key any shipped manifest sets. `resources`
/// is ABSENT on purpose — the owner's words on it were "drop it, you invented things
/// that are never used or mattered at all", and nothing ever read it.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)]
struct ScheduleSpec {
    #[serde(default)]
    class: Option<String>,
}

/// S3 — build-gate mirror of `extensions::types::MethodsNarration`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)]
struct MethodsNarration {
    subject: MethodsSubject,
    action: String,
    #[serde(default)]
    commits: Option<String>,
    #[serde(default)]
    commits_unlabeled: Option<String>,
    #[serde(default)]
    note: Option<String>,
    #[serde(default)]
    params: std::collections::BTreeMap<String, MethodsParamRole>,
    #[serde(default)]
    allow_list_slots: Vec<String>,
    /// #77 — build-gate mirror of `MethodsNarration::reference_assets`. Typed +
    /// `deny_unknown_fields` so a typo'd facet key (`versoin:`) fails the BUILD rather
    /// than silently un-narrating the one fact that makes a model-consuming result
    /// traceable.
    #[serde(default)]
    reference_assets: Vec<MethodsReferenceAsset>,
}

/// #77 — build-gate mirror of `extensions::types::MethodsReferenceAsset`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)]
struct MethodsReferenceAsset {
    kind: String,
    name: String,
    version: String,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    digest: Option<String>,
}

/// S3 — build-gate mirror of `extensions::types::MethodsSubject`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)]
struct MethodsSubject {
    singular: String,
    plural: String,
}

/// S3 — build-gate mirror of `extensions::types::MethodsParamRole`. A role outside
/// this set fails the build (an unrecognised role would otherwise silently drop the
/// param from the narration).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)]
enum MethodsParamRole {
    PredicateList,
    ThresholdList,
    OpaquePredicate,
    AllowList,
    SubsampleCap,
    Seed,
    OutputLabel,
    /// #131 — a scalar interpolated into the `commits` phrase by `{<param>}`. Additive:
    /// the vocabulary stays CLOSED, so an unrecognised role is still a build failure.
    NarratedValue,
}

/// A contributed datatype — the backend half's typo-caught, extends-resolved shape.
/// Mirrors the runtime `DatatypeContribution` + its `deny_unknown_fields` sub-structs.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DatatypeContribution {
    id: String,
    #[serde(default)]
    extends: Option<String>,
    #[allow(dead_code)]
    title: String,
    #[serde(default)]
    #[allow(dead_code)]
    description: String,
    #[serde(default)]
    schema: serde_json::Value,
    #[allow(dead_code)]
    storage: DcStorage,
    #[serde(default)]
    #[allow(dead_code)]
    capabilities: Vec<String>,
    #[serde(default)]
    #[allow(dead_code)]
    ingest: Option<DcIngest>,
    #[serde(default)]
    #[allow(dead_code)]
    axes: Vec<DcAxisSpec>,
    // Which declared axis is the ENTITY axis (mirrors the runtime
    // `DatatypeContribution::entity_axis`). Mirrored for the usual `deny_unknown_fields`
    // reason AND for a semantic one this mirror can uniquely enforce: `validate_parsed`
    // checks that the value NAMES one of the sibling `axes`, so a typo'd or stale entity
    // axis fails the BUILD instead of resolving to nothing at runtime — where "nothing"
    // is indistinguishable from an honest single-axis omission.
    #[serde(default)]
    entity_axis: Option<String>,
    // ITEM-14 / DEC-4: the per-column DISPLAY-LABEL lookup — `{ <column>: "<label>" }`.
    // Mirrored here for the SAME reason every other key is: this struct is
    // `deny_unknown_fields`, so a key the mirror does not know fails `cargo check`. Its
    // absence made the ONE surviving piece of the deleted column forecast impossible to
    // declare at all — a manifest that used the key could not build — which is how
    // the mechanism stayed inert while the runtime field, the TS mirror and the FE
    // consumer were all in place. Values are free-form display strings, so only the KEY
    // vocabulary is a mirror concern; `String → String` is the whole shape.
    #[serde(default)]
    #[allow(dead_code)]
    labels: std::collections::HashMap<String, String>,
    // INV-7: the open-axis `arrays[]` DATA, mirrored so a typo'd array/dim/attr field
    // fails the BUILD (parity with the runtime `ArrayDecl` + its `deny_unknown_fields`).
    #[serde(default)]
    #[allow(dead_code)]
    arrays: Vec<DcArrayDecl>,
    #[serde(default)]
    #[allow(dead_code)]
    is_abstract: bool,
    #[serde(default)]
    #[allow(dead_code)]
    viewers: Vec<DcViewer>,
    #[serde(default)]
    #[allow(dead_code)]
    input_requirements: Option<DcInputRequirements>,
    #[serde(default)]
    #[allow(dead_code)]
    converters: Vec<DcConverterRef>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)]
struct DcStorage {
    // `layout` is the tagged `LayoutKind` (kind + payload); its inner vocabulary
    // is owned by the runtime enum, so it stays a `Value` (a bad `kind` fails the
    // runtime parse) — B3 tightens the SIBLING free-form keys below, which the
    // runtime models as typed structs.
    layout: serde_json::Value,
    format: String,
    // B3: `file_layout` mirrors the runtime typed struct (`FileLayout`) so a bad value
    // fails the BUILD, not just at boot.
    //
    // artifact-model ITEM-14: `selector_map` + `tiers` were REMOVED here in lockstep
    // with the runtime `DatatypeContributionStorage`. Both shapes are
    // `deny_unknown_fields`, so a manifest still spelling either key now fails the
    // BUILD — which is the point: leaving them here would let a stale manifest pass
    // the build lint and then be refused at boot, the exact split this mirror exists
    // to prevent.
    #[serde(default)]
    file_layout: Option<DcFileLayout>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)]
struct DcIngest {
    #[serde(default)]
    extensions: Vec<String>,
    #[serde(default)]
    magic: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)]
struct DcViewer {
    view_kind_id: String,
    family: String,
    #[serde(default)]
    consumes: Vec<String>,
}

// ── B3: the formerly free-form `Value` sub-keys, now typed to MIRROR the runtime
// structs so a typo/bad-type inside them fails the BUILD (parity: a real manifest
// still lints clean because these are the same shapes the runtime deserializes).

/// Mirrors runtime `datatype::types::AxisSpec` — IDENTITY ONLY (`{ name, key_label }`).
///
/// `annotations` IS ABSENT ON PURPOSE (INV-5), and its absence is the gate: with
/// `deny_unknown_fields`, an axis still declaring the per-axis column forecast is a BUILD
/// failure naming the file, line and key. The mirrored `DcAnnotationSpec` /
/// `DcProducesAnnotation` / `DcAnnotationType` types went with it — a build gate that still
/// knows how to PARSE a forecast is one field away from admitting one again.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)]
struct DcAxisSpec {
    name: String,
    key_label: String,
}

/// Mirrors runtime `datatype::types::ArrayDecl` (INV-7 / open-axis DATA) — one array a
/// datatype declares over its axes, with its own `layout`. A typo'd array field fails
/// the build (`deny_unknown_fields`), same as the runtime type. `selector_map` was
/// removed here in lockstep with the runtime type (artifact-model ITEM-14).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)]
struct DcArrayDecl {
    name: String,
    kind: String,
    dims: Vec<DcArrayDim>,
    #[serde(default)]
    attrs: Vec<DcArrayAttr>,
    // `layout` is the tagged `LayoutKind` — its inner vocabulary is the runtime enum's,
    // so it stays a `Value` (a bad `kind` fails the runtime parse), mirroring `DcStorage`.
    layout: serde_json::Value,
}

/// Mirrors runtime `datatype::types::ArrayDim` (untagged `{ axis } | { k }`). Untagged
/// so a `{}`/typo matches neither variant and fails the build (the exactly-one guard).
#[derive(Debug, Deserialize)]
#[serde(untagged)]
#[allow(dead_code)]
enum DcArrayDim {
    Axis { axis: String },
    Anon { k: u64 },
}

/// Mirrors runtime `datatype::types::ArrayAttr` (`{ name, dtype }`).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)]
struct DcArrayAttr {
    name: String,
    dtype: String,
}

/// Mirrors runtime `datatype::types::FileLayout` (`#[serde(rename_all = "snake_case")]`).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)]
enum DcFileLayout {
    Single,
    Prefix,
    Manifest,
}

/// Mirrors runtime `datatype::types::InputRequirements`
/// (`#[serde(tag = "requires", rename_all = "snake_case")]`). A misspelled member
/// key surfaces as a missing-required-field parse error at build time. (No
/// `deny_unknown_fields`: serde does not support it on an internally-tagged enum
/// variant — this matches the runtime type exactly.)
#[derive(Debug, Deserialize)]
#[serde(tag = "requires", rename_all = "snake_case")]
#[allow(dead_code)]
enum DcInputRequirements {
    Single,
    Manifest {
        members: Vec<String>,
        #[serde(default)]
        allow_archive: bool,
    },
}

/// Mirrors runtime `datatype::types::ConverterRun` (`#[serde(rename_all = "lowercase")]`).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
#[allow(dead_code)]
enum DcConverterRun {
    Host,
    Sandbox,
}

/// Mirrors runtime `datatype::types::ConverterRef` (`{ from, to, run, entry? }`).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)]
struct DcConverterRef {
    from: String,
    to: String,
    run: DcConverterRun,
    #[serde(default)]
    entry: Option<String>,
}

// ───────────────────────────────── the lint ────────────────────────────────────

/// Lint EVERY `<processors_dir>/<name>/manifest.yaml`. Returns `Ok(())` when every
/// package is well-formed, or a single clear, PACKAGE-SCOPED `Err` on the first
/// malformed one (unknown/typo'd key, bad field type, missing required field,
/// malformed `schema`, or a dangling `extends` target).
///
/// Two passes: (1) parse each manifest against the unified schema (catches
/// key/type/required errors); (2) resolve every datatype `extends` against the
/// UNION of the 6 roots and ALL contributed ids across ALL packages (catches a
/// dangling target that a single-package parse cannot see).
pub fn lint_processor_tree(processors_dir: &Path) -> Result<(), String> {
    lint_processor_tree_with_env(processors_dir, None)
}

/// [`lint_processor_tree`] plus the #80 DEPENDENCY gate, resolving every declared
/// `run.dependencies[]` against the env recipe pin sets under `env_root`.
///
/// ## Why this is a separate entry point rather than a third pass inside `validate_parsed`
///
/// `validate_parsed` is shared with [`lint_processor_package`], which is the RUNTIME
/// per-package scan: it runs inside the shipped server, on a machine that has a packages
/// folder and NO env-recipe tree (the recipe is a build-time artifact; the runtime fetches
/// a published image instead). Putting a filesystem dependency on `env-rootfs/` into the
/// shared body would make every runtime-dropped package fail to load on a normal
/// deployment. The gate belongs to the BUILD, so only `build.rs` supplies the tree.
pub fn lint_processor_tree_with_env(
    processors_dir: &Path,
    env_root: Option<&Path>,
) -> Result<(), String> {
    // ── pass 1: discover + parse ──
    let mut parsed: Vec<(String, ProcessorManifest)> = Vec::new();
    let mut entries: Vec<_> = std::fs::read_dir(processors_dir)
        .map_err(|e| {
            format!(
                "cannot read processors dir `{}`: {e}",
                processors_dir.display()
            )
        })?
        .filter_map(|e| e.ok())
        .collect();
    // Deterministic order → a stable "first malformed package" error.
    entries.sort_by_key(|e| e.path());

    for entry in entries {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let manifest_path = path.join("manifest.yaml");
        if !manifest_path.exists() {
            continue; // a non-package dir (e.g. compute-only) is not an error.
        }
        let name = pkg_name(&path);
        let text = std::fs::read_to_string(&manifest_path)
            .map_err(|e| scoped(&name, format!("cannot read: {e}")))?;
        let manifest = parse_and_check_manifest(&name, &text).map_err(String::from)?;
        parsed.push((name, manifest));
    }

    // ── pass 2 (shared): id-uniqueness + extends/cycle + converter-entry, over the
    // UNION of every package's contributed ids (cross-package dangling `extends` is
    // only visible from the whole tree). ──
    validate_parsed(&parsed).map_err(String::from)?;

    // ── pass 3 (BUILD ONLY, #80): the declared dependency + version contract. ──
    if let Some(env_root) = env_root {
        // FILE VALIDITY FIRST, and NOT inside the gate below (#214 / INV-3).
        //
        // Round 4 of #192 found this precondition living inside `read_env_recipes`, reached
        // only from `lint_declared_dependencies` — which returns `Ok(())` immediately when
        // no package declares a `run.dependencies` or an `env`. "Are these bytes canonical"
        // was therefore a SIDE EFFECT of asking a different question, and in a tree where
        // nothing declared a dependency, NO pin file was checked at all while every other
        // reader went on parsing them.
        //
        // A file-validity rule must not be contingent on what some package happens to
        // declare, so it runs here, before the gate, unconditionally.
        assert_every_recipe_canonical(env_root)?;
        lint_declared_dependencies(&parsed, env_root)?;
    }
    Ok(())
}

/// Lint ONE processor PACKAGE directory (`<package_dir>/manifest.yaml`) — the
/// per-package entry point the RUNTIME scan (S4) uses so a single runtime-dropped
/// package can be validated and SKIPPED on error without aborting the whole scan.
/// It runs the IDENTICAL validator body as [`lint_processor_tree`] (INV-8), just
/// over a one-element parsed set: the same outer-manifest `deny_unknown_fields`,
/// structural `schema` check, dangling-`extends` resolution, self/cycle detection,
/// duplicate-id guard, and non-empty `run.entry` check — returning a single
/// PACKAGE-SCOPED `Err` (`packages/<name>/manifest.yaml: <problem>`) on any
/// malformation, or `Ok(())` when the package is well-formed.
///
/// Scoping note: with only ONE package in view, a datatype `extends` resolves
/// against the 6 universal ROOT ids ∪ THIS package's own contributed ids. A
/// supertype contributed by a DIFFERENT package is therefore reported as a
/// dangling `extends` here — cross-package resolution is the whole-tree gate's job
/// ([`lint_processor_tree`]); a per-package runtime scan validates each folder in
/// isolation.
// `#[allow(dead_code)]`: `build.rs` (the whole-tree gate) only calls
// `lint_processor_tree`, so this per-package entry point is unused in the
// BUILD-SCRIPT compilation of this file — the runtime scan (S4) is its LIB caller
// (+ the `#[cfg(test)]` anchors). Same allow-convention the struct fields above use.
#[allow(dead_code)]
pub fn lint_processor_package(package_dir: &Path) -> Result<(), String> {
    lint_processor_package_detailed(package_dir).map_err(String::from)
}

/// [`lint_processor_package`] with the rejection's stable CHECK ID attached (#190/#197).
///
/// The runtime scan calls THIS one: its report has to name a machine-readable check
/// alongside the human message so a test can assert the check rather than the prose, and
/// so an operator reading the boot diagnostic can search for a stable token.
///
/// The `String`-returning wrapper above keeps its exact signature and message text, but be
/// precise about what that buys: the runtime scan WAS its only production caller and now
/// calls this one, so the wrapper's remaining callers are tests (the anchors below and
/// `tests/extensions/datatype_contribution_test.rs`). It is kept rather than folded in
/// because it is the shape external callers expect and the shape `lint_processor_tree`
/// mirrors — collapsing the two would be an unrelated API change.
// `#[allow(dead_code)]` for the same reason the wrapper carries one: `build.rs` compiles
// this file without the lib-side caller.
#[allow(dead_code)]
pub fn lint_processor_package_detailed(package_dir: &Path) -> Result<(), LintFailure> {
    let name = pkg_name(package_dir);
    let manifest_path = package_dir.join("manifest.yaml");
    let text = std::fs::read_to_string(&manifest_path)
        .map_err(|e| failed(CHECK_UNREADABLE, &name, format!("cannot read: {e}")))?;
    lint_processor_manifest_text(&name, &text)
}

/// [`lint_processor_package_detailed`] over manifest TEXT THE CALLER ALREADY READ.
///
/// ## Why this exists — a TOCTOU the dir-taking form cannot close
///
/// `<data_root>/processors/` is writable at runtime, and the runtime scan needs the same
/// manifest for three things: classifying the package's ORIGIN (comparing the bytes on disk
/// to the ones this binary embedded), linting it, and parsing it into the registry type.
/// Each `&Path`-taking entry point does its own `read`, so those were THREE reads of an
/// attacker-writable file. Anyone able to rewrite it between reads could have the
/// classification see the shipped bytes (⇒ `first-party`) and the lint see garbage
/// (⇒ a rejection) — manufacturing a FIRST-PARTY refusal, which fails boot. That is the
/// denial of service the origin-by-bytes rule exists to prevent, reached through a race
/// rather than through a name.
///
/// So the scan reads ONCE and every consumer is handed the same bytes. This entry point is
/// what lets the lint be one of them. `build.rs` keeps using the dir-taking form, which is
/// correct there: the build tree is not attacker-writable and there is no second reader.
// `#[allow(dead_code)]`: `build.rs` compiles this file with no lib-side caller.
#[allow(dead_code)]
pub fn lint_processor_manifest_text(name: &str, text: &str) -> Result<(), LintFailure> {
    let manifest = parse_and_check_manifest(name, text)?;
    validate_parsed(&[(name.to_string(), manifest)])
}

/// The package name = the directory's file name (used to build package-scoped errors).
fn pkg_name(path: &Path) -> String {
    path.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("<unknown>")
        .to_string()
}

/// Parse ONE manifest's text against the unified schema (outer-manifest
/// `deny_unknown_fields` catches a typo'd/bad-typed/missing key) and run the
/// structural `schema` check on every contributed datatype. Shared by both entry
/// points so the parse+schema half never diverges.
fn parse_and_check_manifest(name: &str, text: &str) -> Result<ProcessorManifest, LintFailure> {
    // #190 ITEM-4 / INV-3: the env-id grammar first, so a malformed `env:` is its own
    // named rejection rather than a generic parse error.
    check_env_ids(name, text)?;
    let manifest: ProcessorManifest = serde_norway::from_str(text)
        .map_err(|e| failed(CHECK_MALFORMED_MANIFEST, name, format!("malformed manifest — {e}")))?;
    // Structural `schema` check on every contributed datatype (the runtime
    // compiles `schema` into the enforced validator, DEC-6 — a non-object /
    // wrong-typed `type` there would silently no-op; catch it at build time).
    for dt in &manifest.contributes.datatypes {
        check_schema(name, &dt.id, &dt.schema)?;
    }
    Ok(manifest)
}

/// The `code_ref`s the APP itself owns and dispatches out of its RESERVED (`_`-prefixed)
/// packages — `sandbox::processors::RESERVED_CODE_REFS`. A contribution may NOT declare
/// one as its `run.entry` (artifact-model ITEM-18).
///
/// ## Why the lint, and not only the resolver
/// The resolver consults the reserved table BEFORE `declared.package`, so a declaration
/// like `entry: verify_conformance.py` no longer substitutes a contributed package's
/// bytes for the framework CONFORMANCE GATE. A manifest making that claim is still a
/// defect worth naming: it is either an attempt at exactly that substitution, or an
/// author who believes they are contributing an entry that will silently never be the one
/// that runs. Rejecting the declaration turns both into a package-scoped build / load
/// error instead of a silent no-op, at the SAME boundary that already rejects an empty
/// `run.entry`. Ordering alone would leave a package able to CLAIM the entry; this alone
/// would leave the runtime drop-in path (a dropped folder needs no diff to lint).
///
/// The reserved packages themselves (`_lib`, `_helpers`) lint clean under this rule:
/// their manifests carry `contributes: {}`, and their entries are reached through the
/// app's own reserved table, never through a declaration.
///
/// Kept in lockstep with the resolver's table the same way `ROOT_DATATYPE_IDS` is kept in
/// lockstep with `builtin.rs` — `build.rs` runs before the crate compiles and cannot
/// reach into it. `reserved_entry_lint_matches_the_resolver_table` (in the SERVER lib,
/// which can see both) fails on any divergence.
// `pub` (unlike `ROOT_DATATYPE_IDS`) so the lockstep test named above can READ it from the
// lib side; `build.rs` compiles the same file with no such consumer, hence the allow.
#[allow(dead_code)]
pub const RESERVED_ENTRY_CODE_REFS: &[&str] =
    &["compute/demo-analysis.py", "verify_conformance.py"];

/// The SHARED cross-manifest validation body (INV-8): id-uniqueness (B4) + extends
/// resolution (dangling) + self/cycle detection (B2) + non-empty converter
/// `run.entry`, over the given parsed set. `lint_processor_tree` passes EVERY
/// package (cross-package resolution); `lint_processor_package` passes ONE. Both
/// resolve `extends`/dedup against the 6 ROOT ids ∪ the ids contributed by the
/// packages in `parsed`.
fn validate_parsed(parsed: &[(String, ProcessorManifest)]) -> Result<(), LintFailure> {
    // ── pass 2: id-uniqueness (B4) + extends resolution (dangling) + cycle (B2) ──
    //
    // B4: build the id set as an owner MAP (not a bare HashSet) so a DUPLICATE
    // datatype id — within one package or across two — is a BUILD error instead of
    // being silently deduped (the runtime registry's fail-loud collision guard is
    // otherwise the only catch). A collision with a universal ROOT id is likewise
    // rejected. `extends_of` (id → its `extends`) also feeds the B2 cycle walk.
    let mut id_owner: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut extends_of: std::collections::HashMap<String, Option<String>> =
        std::collections::HashMap::new();
    let mut known: std::collections::HashSet<String> =
        ROOT_DATATYPE_IDS.iter().map(|s| s.to_string()).collect();
    for (name, m) in parsed {
        for dt in &m.contributes.datatypes {
            if ROOT_DATATYPE_IDS.contains(&dt.id.as_str()) {
                return Err(failed(
                    CHECK_ROOT_ID_COLLISION,
                    name,
                    format!(
                        "datatype `{}` collides with a universal ROOT datatype id \
                         (duplicate datatype id)",
                        dt.id
                    ),
                ));
            }
            if let Some(prev) = id_owner.get(&dt.id) {
                return Err(failed(
                    CHECK_DUPLICATE_DATATYPE_ID,
                    name,
                    format!(
                        "datatype `{}` is already contributed by package `{}` \
                         (duplicate datatype id)",
                        dt.id, prev
                    ),
                ));
            }
            id_owner.insert(dt.id.clone(), name.clone());
            extends_of.insert(dt.id.clone(), dt.extends.clone());
            known.insert(dt.id.clone());
        }
    }
    // dangling `extends` — every declared supertype must resolve to a root ∪ a
    // contributed id.
    for (name, m) in parsed {
        for dt in &m.contributes.datatypes {
            if let Some(sup) = &dt.extends {
                if !known.contains(sup) {
                    return Err(failed(
                        CHECK_DANGLING_EXTENDS,
                        name,
                        format!(
                            "datatype `{}` extends `{}`, which is not a root datatype nor \
                             contributed by any package (dangling `extends`)",
                            dt.id, sup
                        ),
                    ));
                }
            }
        }
    }
    // B2: self-extend + cycle detection. Walk each contributed id's `extends` chain
    // toward a root; a revisit means a self-extend (`id extends id`) or a cycle
    // (`a → b → a`). Both ids are in `known`, so pass-2's dangling check passes them
    // — the RUNTIME lattice validator is otherwise the only catch (at server BOOT,
    // not at BUILD, contrary to INV-5). Iterating `parsed` (sorted) keeps the error
    // deterministic.
    for (name, m) in parsed {
        for dt in &m.contributes.datatypes {
            let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
            let mut cur = dt.id.as_str();
            loop {
                if !seen.insert(cur) {
                    return Err(failed(
                        CHECK_EXTENDS_CYCLE,
                        name,
                        format!(
                            "datatype `{}` has a cyclic / self-referential `extends` chain \
                             (revisits `{}`)",
                            dt.id, cur
                        ),
                    ));
                }
                // Follow `extends` only while it points at ANOTHER contributed id; a
                // root (or an already-errored dangling target) terminates the chain.
                match extends_of.get(cur).and_then(|e| e.as_deref()) {
                    Some(sup) if extends_of.contains_key(sup) => cur = sup,
                    _ => break,
                }
            }
        }
    }
    // `entity_axis` must NAME one of the datatype's own declared axes. The runtime
    // consumer resolves it by name and silently answers "no entity axis" when it does
    // not match — which is exactly the answer an honest single-axis omission gives, so a
    // typo is INVISIBLE at runtime. Here it is a build error naming both sides.
    // A datatype declaring NO axes may not name one either (there is nothing to name).
    for (name, m) in parsed {
        for dt in &m.contributes.datatypes {
            let Some(entity) = dt.entity_axis.as_deref() else {
                continue;
            };
            if !dt.axes.iter().any(|a| a.name == entity) {
                let declared: Vec<&str> = dt.axes.iter().map(|a| a.name.as_str()).collect();
                return Err(failed(
                    CHECK_BAD_ENTITY_AXIS,
                    name,
                    format!(
                        "datatype `{}` declares `entity_axis: {}`, which is not one of its \
                         declared axes {:?}",
                        dt.id, entity, declared
                    ),
                ));
            }
        }
    }
    // A converter is only reachable at runtime if its `run.entry` is non-empty
    // (loader.rs boot-validates entry-resolution); a build-time empty-entry check
    // gives the same class of error one phase earlier.
    for (name, m) in parsed {
        for c in &m.contributes.converters {
            let entry = c.run.entry.as_deref().unwrap_or("");
            if entry.trim().is_empty() {
                return Err(failed(
                    CHECK_EMPTY_RUN_ENTRY,
                    name,
                    format!("converter `{}` has an empty `run.entry`", c.id),
                ));
            }
        }
    }
    // artifact-model ITEM-18: a contribution may not CLAIM a `run.entry` the app itself
    // dispatches out of a reserved package. Both contribution kinds carry a `run` block
    // (a converter's is required + typed; an analysis' is optional + free-form), and the
    // registry lookup that feeds the resolver reads BOTH — so checking only converters
    // would leave the FE-owned half able to make the claim the resolver has to refuse.
    for (name, m) in parsed {
        let entries = m
            .contributes
            .converters
            .iter()
            .map(|c| (c.id.as_str(), "converter", c.run.entry.as_deref()))
            .chain(m.contributes.analyses.iter().map(|a| {
                (
                    a.id.as_str(),
                    "analysis",
                    a.run.as_ref().and_then(|r| r.entry.as_deref()),
                )
            }));
        for (id, kind, entry) in entries {
            let entry = entry.unwrap_or("").trim();
            if RESERVED_ENTRY_CODE_REFS.contains(&entry) {
                return Err(failed(
                    CHECK_RESERVED_RUN_ENTRY,
                    name,
                    format!(
                        "{kind} `{id}` declares `run.entry: {entry}`, which is a RESERVED \
                         app-owned entry — a contribution may not claim it (the resolver \
                         runs the framework's own file for a reserved `code_ref`, so this \
                         declaration could only substitute or silently never run)"
                    ),
                ));
            }
        }
    }
    // #131 — the METHODS PLACEHOLDER gate. Every `{token}` in a `methods.commits` /
    // `methods.commits_unlabeled` phrase must be DECLARED, or the exported `methods.md`
    // — the out-of-app trust deliverable — prints the braces verbatim to the reader.
    for (name, m) in parsed {
        for a in &m.contributes.analyses {
            let Some(methods) = a.methods.as_ref() else { continue };
            // #190/#197: `validate_parsed` returns a CODED failure, while these two #131
            // checks are `String`-returning and shared with their own tests. Map at the
            // call site so the message stays BYTE-IDENTICAL (every existing assertion on
            // it holds) and the rejection still carries a stable check id into the report.
            check_one_output_label(name, &a.id, &methods.params)
                .map_err(|m| LintFailure { check: CHECK_METHODS_OUTPUT_LABEL, message: m })?;
            for (field, phrase) in [
                ("commits", methods.commits.as_deref()),
                ("commits_unlabeled", methods.commits_unlabeled.as_deref()),
            ] {
                let Some(phrase) = phrase else { continue };
                check_methods_placeholders(name, &a.id, field, phrase, &methods.params)
                    .map_err(|m| LintFailure {
                        check: CHECK_METHODS_PLACEHOLDER,
                        message: m,
                    })?;
            }
            // The narrator prints these VERBATIM into the same document — and `note` now
            // prints on EVERY run — so a brace here reaches the reader exactly the way an
            // undeclared `commits` token used to. They are not substitution templates
            // (substituting `note` would mean a note that fails to resolve is a note that
            // is DROPPED, which is the very trap #131's note fix removes), so the brace is
            // refused outright rather than resolved.
            for (field, phrase) in [
                ("note", methods.note.as_deref()),
                ("action", Some(methods.action.as_str())),
                ("subject.singular", Some(methods.subject.singular.as_str())),
                ("subject.plural", Some(methods.subject.plural.as_str())),
            ] {
                let Some(phrase) = phrase else { continue };
                if phrase.contains('{') || phrase.contains('}') {
                    return Err(failed(
                        CHECK_METHODS_VERBATIM_BRACE,
                        name,
                        format!(
                            "analysis `{}`: `methods.{field}` contains a brace. Placeholder \
                             substitution is supported ONLY in `commits` / \
                             `commits_unlabeled`; this field is printed VERBATIM into the \
                             exported `methods.md`, which is the out-of-app trust \
                             deliverable, so a brace here reaches the reader as-is. Rewrite \
                             the sentence without it.",
                            a.id
                        ),
                    ));
                }
            }
        }
    }
    Ok(())
}

/// The RESERVED placeholder token: an alias for the value of whichever param is
/// declared `output_label`, whatever that param is spelled. Kept as an alias (rather
/// than folded into the general param lookup) so a manifest spelling `{label}` while
/// naming its label param something else keeps working — the backward-compatibility
/// contract the concurrently-built packages author against.
// `pub` (like `RESERVED_ENTRY_CODE_REFS`) so the lib-side lockstep test in `methods.rs`
// can read it; `build.rs` compiles the same file with no such consumer, hence the allow.
#[allow(dead_code)]
pub const METHODS_RESERVED_PLACEHOLDER: &str = "label";

/// #131 — reject any `{token}` in a `commits` phrase that is neither the reserved
/// `label` nor a key of that analysis' `methods.params`.
///
/// ## Why a BUILD failure and not a lenient render
///
/// `methods.rs` substituted exactly one literal token, `{label}`. Five shipped
/// manifests spell something else (`{name}` ×4, `{n_pcs}`/`{n_hvg}`/`{method}`), and
/// every one of them shipped its braces into an exported bundle. Nothing caught it,
/// because there is no reader between the manifest and the scientist: the defect is
/// invisible until a human opens the deliverable. Accepting an unknown token and
/// resolving it optimistically at runtime would reproduce exactly that — a manifest
/// typo (`{nmae}`) would render as an omission instead of a name. A declared
/// vocabulary is what makes the check possible at all, which is why
/// `narrated_value` exists.
///
/// An unbalanced brace is rejected too: `"{n_pcs"` has no closing brace, so no
/// substitution can match it and it would reach the reader verbatim.
fn check_methods_placeholders(
    package: &str,
    analysis_id: &str,
    field: &str,
    phrase: &str,
    declared: &std::collections::BTreeMap<String, MethodsParamRole>,
) -> Result<(), String> {
    let consequence = "Left unsubstitutable it would print VERBATIM into the exported \
                       `methods.md`, which is the out-of-app trust deliverable.";
    // The roles whose recorded value the narrator can render as a SCALAR. A token naming a
    // param of any other role passes a key-only check and then NEVER substitutes — the
    // "green build, silently missing clause" outcome this gate exists to prevent, arrived
    // at through the gate itself.
    let substitutable = |role: &MethodsParamRole| {
        matches!(
            role,
            MethodsParamRole::NarratedValue
                | MethodsParamRole::OutputLabel
                | MethodsParamRole::Seed
                | MethodsParamRole::SubsampleCap
        )
    };
    let scalar_keys = || {
        declared
            .iter()
            .filter(|(_, r)| substitutable(r))
            .map(|(k, _)| k.clone())
            .collect::<Vec<_>>()
    };
    // A `}` with no `{` before it is invisible to the tokenizer — it forms no token, so
    // nothing rejects it and the narrator prints it VERBATIM. The identical character is a
    // build failure in `note`/`action`/`subject`; enforcing it on three fields and not on
    // the two the rule was written for is the shape of hole this gate exists to close.
    // Every brace must therefore belong to a token.
    if let Some(stray) = stray_brace(phrase) {
        return Err(scoped(
            package,
            format!(
                "analysis `{analysis_id}`: `methods.{field}` contains a `{stray}` that is \
                 not part of a `{{placeholder}}`. It can never be substituted. {consequence}"
            ),
        ));
    }
    for token in methods_placeholder_tokens(phrase) {
        let token = token.map_err(|problem| {
            scoped(
                package,
                format!(
                    "analysis `{analysis_id}`: `methods.{field}` is malformed — {problem}. \
                     An unbalanced brace cannot be substituted. {consequence}"
                ),
            )
        })?;
        // An empty or non-identifier token cannot name a param at all, so the "declare it"
        // advice below would be an instruction nobody can follow.
        let is_identifier = !token.is_empty()
            && token
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'));
        if !is_identifier {
            return Err(scoped(
                package,
                format!(
                    "analysis `{analysis_id}`: `methods.{field}` contains `{{{token}}}`, \
                     which is not a parameter name (a placeholder names a param: letters, \
                     digits, `_`, `-`, `.`). If the braces are meant literally, rewrite the \
                     phrase without them. {consequence}"
                ),
            ));
        }
        let has_output_label =
            declared.values().any(|r| matches!(r, MethodsParamRole::OutputLabel));
        // AMBIGUITY, refused. The narrator resolves `{label}` by trying a param literally
        // named `label` FIRST and falling back to the `output_label` param. A manifest
        // that declares BOTH — a param named `label` AND a different param carrying the
        // `output_label` role — therefore has a `{label}` that renders one param's value
        // on one run and the other's on the next, chosen by which happened to record a
        // scalar, with nothing in `methods.md` saying which. That is worse than either
        // failure the resolution order was tuned to avoid, and it is exactly the "silently
        // WRONG value, with no gate able to see it" the narrator's own doc warns about.
        // The gate CAN see it, so it refuses it rather than blessing it.
        if token == METHODS_RESERVED_PLACEHOLDER
            && declared.contains_key(&token)
            && declared
                .iter()
                .any(|(k, r)| k != &token && matches!(r, MethodsParamRole::OutputLabel))
        {
            return Err(scoped(
                package,
                format!(
                    "analysis `{analysis_id}`: `methods.{field}` uses `{{label}}`, but this \
                     analysis declares BOTH a param named `label` and a separate \
                     `output_label` param. `{{label}}` would resolve to whichever of them \
                     the run happened to record, so one phrase would name different values \
                     on different runs with nothing saying which. Rename one of them, or \
                     use `{{<param>}}` to name the one you mean."
                ),
            ));
        }
        // Otherwise the alias is consulted before a declared token is called unrenderable,
        // because that is the order the NARRATOR resolves in: `scalar_param` first, and on
        // any non-resolution it falls through to the alias. A gate that treated "declared
        // with a non-scalar role" as terminal would refuse a phrase that actually renders.
        if token == METHODS_RESERVED_PLACEHOLDER && has_output_label {
            continue;
        }
        if let Some(role) = declared.get(&token) {
            if substitutable(role) {
                continue;
            }
            return Err(scoped(
                package,
                format!(
                    "analysis `{analysis_id}`: `methods.{field}` uses `{{{token}}}`, but \
                     `{token}` is declared `{role:?}` — a role whose recorded value is a \
                     list or a structure, which the narrator cannot render into a prose \
                     phrase. It would pass this gate and then NEVER substitute, silently \
                     dropping the whole `committing …` clause from the exported \
                     `methods.md`. Substitutable roles are `narrated_value`, \
                     `output_label`, `seed`, `subsample_cap`."
                ),
            ));
        }
        if token == METHODS_RESERVED_PLACEHOLDER {
            // Reached only when there is NO `output_label` param (the accepting case is
            // handled above): the alias can never resolve, so the phrase is dead on arrival.
            return Err(scoped(
                package,
                format!(
                    "analysis `{analysis_id}`: `methods.{field}` uses the reserved \
                     `{{label}}`, but this analysis declares no `output_label` param for it \
                     to resolve through, so the phrase can never be rendered. Map the \
                     param that carries the user's output name to `output_label` under \
                     `methods.params`."
                ),
            ));
        }
        let mut known = scalar_keys();
        if has_output_label {
            known.push(METHODS_RESERVED_PLACEHOLDER.to_string());
        }
        let known = if known.is_empty() { "(none declared)".to_string() } else { known.join(", ") };
        return Err(scoped(
            package,
            format!(
                "analysis `{analysis_id}`: `methods.{field}` uses the placeholder \
                 `{{{token}}}`, which is not declared. Substitutable tokens are: {known}. \
                 Declare it by adding `{token}: narrated_value` under `methods.params`. \
                 {consequence}"
            ),
        ));
    }
    Ok(())
}

/// An analysis has ONE output label — checked per ANALYSIS, not per phrase.
///
/// It lived inside the placeholder check at first, which meant it only ran for an
/// analysis that declared a `commits` phrase; the ambiguity is a property of the
/// DECLARATION and exists whether or not any phrase names it, because the role also
/// decides which of `commits` / `commits_unlabeled` the narrator uses at all.
fn check_one_output_label(
    package: &str,
    analysis_id: &str,
    declared: &std::collections::BTreeMap<String, MethodsParamRole>,
) -> Result<(), String> {
    let labels: Vec<&String> = declared
        .iter()
        .filter(|(_, r)| matches!(r, MethodsParamRole::OutputLabel))
        .map(|(k, _)| k)
        .collect();
    if labels.len() <= 1 {
        return Ok(());
    }
    Err(scoped(
        package,
        format!(
            "analysis `{analysis_id}`: `methods.params` declares {} params with the \
             `output_label` role ({}). An analysis has ONE output label: the narrator \
             resolves the role by taking the first of them THE RUN RECORDED, so which of \
             them names the \
             committed output — and therefore what `{{label}}` renders, and whether the \
             labelled or the unlabelled phrase is used at all — would depend on the RUN \
             rather than on anything declared, and could differ between two runs of the \
             same analysis. Give exactly one param the `output_label` role.",
            labels.len(),
            labels.iter().map(|k| format!("`{k}`")).collect::<Vec<_>>().join(", ")
        ),
    ))
}

/// The first brace in `phrase` that is NOT part of a well-formed `{token}`, if any.
///
/// `methods_placeholder_tokens` reports an UNCLOSED `{`, but a lone `}` closes nothing and
/// opens nothing — it simply is not a token, so a tokenizer has nothing to say about it
/// while the narrator prints it straight into the deliverable.
///
/// It has NO lockstep partner in the narrator, and needs none: the narrator emits a phrase
/// only once every token substituted, so a stray brace simply prevents a phrase from being
/// declared renderable there. This is a gate-side rule, not a mirrored one — stated
/// because the block above it IS mirrored, and a maintainer who read the two as one would
/// believe a lockstep test guards this function.
fn stray_brace(phrase: &str) -> Option<char> {
    let mut rest = phrase;
    loop {
        match (rest.find('{'), rest.find('}')) {
            // A `}` before the next `{` (or with no `{` left) belongs to no token.
            (open, Some(close)) if open.is_none_or(|o| close < o) => {
                let _ = close;
                return Some('}');
            }
            (Some(open), _) => {
                let after = &rest[open + 1..];
                match after.find('}') {
                    Some(c) => rest = &after[c + 1..],
                    None => return Some('{'), // unclosed; the tokenizer also reports it
                }
            }
            (None, None) => return None,
            (None, Some(_)) => return Some('}'),
        }
    }
}

/// Every `{token}` in a phrase, in order. `Err(problem)` on an unbalanced brace.
///
/// Shared in SHAPE (not in code — `build.rs` cannot reach into the crate it is
/// building) with `methods::placeholder_tokens`, and pinned in lockstep by
/// `methods::tests::the_build_lint_and_the_narrator_agree_on_what_a_placeholder_is`,
/// which runs both over the same corpus. A tokenizer that disagreed with the renderer
/// would let a token pass the gate and then fail to substitute, which is the exact
/// silent-verbatim outcome the gate exists to prevent.
///
/// `pub` for that lib-side lockstep test; unused in the build script's own compilation of
/// this file, hence the allow.
#[allow(dead_code)]
pub fn methods_placeholder_tokens(phrase: &str) -> Vec<Result<String, String>> {
    let mut out = Vec::new();
    let mut rest = phrase;
    while let Some(open) = rest.find('{') {
        rest = &rest[open + 1..];
        match rest.find('}') {
            Some(close) => {
                let token = rest[..close].to_string();
                // A `{` before the `}` means the braces do not nest cleanly.
                if token.contains('{') {
                    out.push(Err(format!("nested/unclosed brace near `{{{token}`")));
                    return out;
                }
                out.push(Ok(token));
                rest = &rest[close + 1..];
            }
            None => {
                out.push(Err(format!("unclosed `{{` before `{rest}`")));
                return out;
            }
        }
    }
    out
}

/// B1: every file whose IN-PLACE edit must re-fire the INV-5 build gate — each
/// `<processors>/<pkg>/manifest.yaml` AND each `<processors>/<pkg>/ui/*.yaml` view
/// spec. `build.rs` emits a per-file `cargo:rerun-if-changed` for each.
///
/// Why per-file and not just the top dir: cargo watches a DIRECTORY's own mtime,
/// which changes only on add/remove/rename of a DIRECT child — NOT on an in-place
/// edit to an existing `manifest.yaml` (nor a file nested inside an existing
/// package subdir). So watching the `processors` dir alone leaves the gate stale
/// under incremental builds, and the most common contribution edit (modifying an
/// existing manifest to introduce a typo / bad-type / dangling-extends) would not
/// re-lint until a clean build. Same tamper-detection class as the hub-seed helper,
/// closed here by watching each manifest + view-spec file directly.
pub fn watched_manifest_files(processors_dir: &Path) -> Vec<std::path::PathBuf> {
    let mut files = Vec::new();
    let Ok(entries) = std::fs::read_dir(processors_dir) else {
        return files;
    };
    let mut pkgs: Vec<_> = entries.filter_map(|e| e.ok().map(|e| e.path())).collect();
    pkgs.sort(); // deterministic emit order
    for pkg in pkgs {
        if !pkg.is_dir() {
            continue;
        }
        let manifest = pkg.join("manifest.yaml");
        if manifest.exists() {
            files.push(manifest);
        }
        // The declarative `ui/*.yaml` view specs (the FE half of INV-5).
        if let Ok(ui_entries) = std::fs::read_dir(pkg.join("ui")) {
            let mut ui_files: Vec<_> = ui_entries
                .filter_map(|e| e.ok().map(|e| e.path()))
                .collect();
            ui_files.sort();
            for f in ui_files {
                if f.extension().and_then(|x| x.to_str()) == Some("yaml") {
                    files.push(f);
                }
            }
        }
    }
    files
}

/// B1, for the #80 gate's OTHER input: every env recipe's pin file, so an IN-PLACE pin
/// edit re-fires the gate under an incremental build. Cargo watches a directory's own
/// mtime, which does not change when a file inside it is edited in place — and "a pin
/// moved under a shipped declaration" is exactly the drift the gate exists to catch, so
/// leaving it stale would make the gate reliably miss its most important case.
pub fn watched_env_pin_files(env_root: &Path) -> Vec<std::path::PathBuf> {
    let mut files = Vec::new();
    // …and the EXPORTED PARSE (#214 / INV-4, staleness mechanism 3). The freshness check
    // compares the committed artefact against a fresh derivation, so a hand edit of the
    // artefact ALONE — no pin file touched — must re-fire the build. Without this watch it
    // would sit behind a cached green until something else invalidated the build script,
    // which is the longest-lived form of the staleness this artefact could suffer.
    let artefact = env_root.join(ENV_PIN_ARTEFACT);
    if artefact.exists() {
        files.push(artefact);
    }
    let Ok(entries) = std::fs::read_dir(env_root) else {
        return files;
    };
    let mut dirs: Vec<_> = entries.filter_map(|e| e.ok().map(|e| e.path())).collect();
    dirs.sort(); // deterministic emit order
    for dir in dirs {
        if !dir.is_dir() {
            continue;
        }
        // Both of the gate's inputs per recipe: the pin set, and the marker whose
        // presence is what makes the directory a gated recipe at all. Watching only the
        // pin file left "a Dockerfile added to an existing directory" invisible under an
        // incremental build — the new recipe would not be checked until a clean one.
        for name in [ENV_PIN_FILE, ENV_RECIPE_MARKER] {
            let f = dir.join(name);
            if f.exists() {
                files.push(f);
            }
        }
    }
    files
}

/// Build a PACKAGE-SCOPED error: `packages/<name>/manifest.yaml: <problem>`.
fn scoped(name: &str, problem: String) -> String {
    format!("packages/{name}/manifest.yaml: {problem}")
}

// ───────────────────── #190/#197: a lint rejection carries a CHECK ID ─────────────────
//
// The runtime scan (`ExtensionRegistry::scan_dir`) reports every package it refused, and
// that report is asserted by tests and consumed by an operator. Reporting only PROSE
// makes both fragile in opposite directions: a test that matches an error MESSAGE reddens
// on a wording change and passes on a semantic one. So every rejection the RUNTIME
// per-package scan can produce also carries a stable machine-readable id, following
// `env_image.rs`'s typed-code convention (`ENV_IMAGE_UNKNOWN`, `ENV_IMAGE_RESOLVE`, …).
//
// Deliberately scoped to the failures `lint_processor_package` can raise — the read, the
// env-id grammar, the strict parse, the `schema` shape, and `validate_parsed`'s checks.
// `lint_declared_dependencies` is a BUILD-ONLY pass (`build.rs` alone supplies the env
// recipe tree; see `lint_processor_tree_with_env`'s doc) and can never reach the runtime
// report, so it keeps its plain `String` error rather than paying for a code it has no
// consumer for.
//
// The MESSAGE text of every rejection below is byte-identical to what it was before the
// code was added: the id is additive, so no existing assertion moves.

/// The manifest file could not be read.
pub const CHECK_UNREADABLE: &str = "PKG_UNREADABLE";
/// A declared `env:` value violates the OCI repository-path-component grammar.
pub const CHECK_ENV_ID_INVALID: &str = "PKG_ENV_ID_INVALID";
/// The manifest did not parse against the unified schema (unknown key, bad type, …).
pub const CHECK_MALFORMED_MANIFEST: &str = "PKG_MALFORMED_MANIFEST";
/// A contributed datatype's `schema` is not the shape the runtime validator compiles.
pub const CHECK_MALFORMED_SCHEMA: &str = "PKG_MALFORMED_SCHEMA";
/// A contributed datatype id collides with a universal ROOT datatype id.
pub const CHECK_ROOT_ID_COLLISION: &str = "PKG_ROOT_ID_COLLISION";
/// Two packages (or one package twice) contribute the same datatype id.
pub const CHECK_DUPLICATE_DATATYPE_ID: &str = "PKG_DUPLICATE_DATATYPE_ID";
/// A datatype `extends` a supertype that resolves to nothing in view.
pub const CHECK_DANGLING_EXTENDS: &str = "PKG_DANGLING_EXTENDS";
/// A datatype's `extends` chain revisits itself.
pub const CHECK_EXTENDS_CYCLE: &str = "PKG_EXTENDS_CYCLE";
/// `entity_axis` names something that is not one of the datatype's declared axes.
pub const CHECK_BAD_ENTITY_AXIS: &str = "PKG_BAD_ENTITY_AXIS";
/// A converter declares an empty `run.entry`.
pub const CHECK_EMPTY_RUN_ENTRY: &str = "PKG_EMPTY_RUN_ENTRY";
/// A contribution claims a `run.entry` the app dispatches out of a reserved package.
pub const CHECK_RESERVED_RUN_ENTRY: &str = "PKG_RESERVED_RUN_ENTRY";
/// #131 — a `methods.commits{,_unlabeled}` phrase carries a `{token}` that is not declared
/// in `methods.params`, so the exported `methods.md` would print the braces to the reader.
pub const CHECK_METHODS_PLACEHOLDER: &str = "PKG_METHODS_PLACEHOLDER";
/// #131 — `methods.params` declares more than one output label.
pub const CHECK_METHODS_OUTPUT_LABEL: &str = "PKG_METHODS_OUTPUT_LABEL";
/// #131 — a VERBATIM `methods` field (`note` / `action` / `subject.*`) contains a brace.
/// Those fields are not substitution templates, so the brace reaches the reader as-is.
pub const CHECK_METHODS_VERBATIM_BRACE: &str = "PKG_METHODS_VERBATIM_BRACE";

/// A per-package lint rejection: a stable `check` id beside the human `message`.
///
/// `From<LintFailure> for String` yields the message alone, so every pre-existing
/// `Result<(), String>` caller (`build.rs` through [`lint_processor_tree`], and
/// [`lint_processor_package`]) is unchanged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LintFailure {
    /// A stable machine-readable id (`PKG_*`). Assert THIS, not the prose.
    pub check: &'static str,
    /// The package-scoped human message (`packages/<name>/manifest.yaml: <problem>`).
    pub message: String,
}

impl std::fmt::Display for LintFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl From<LintFailure> for String {
    fn from(f: LintFailure) -> String {
        f.message
    }
}

/// Build a coded, PACKAGE-SCOPED lint failure.
fn failed(check: &'static str, name: &str, problem: String) -> LintFailure {
    LintFailure {
        check,
        message: scoped(name, problem),
    }
}

/// The `env:` values the manifest declares, checked against the SHARED grammar
/// ([`env_id::is_valid_env_id`]) BEFORE the strict parse, so a malformed env-id is its own
/// named rejection (`PKG_ENV_ID_INVALID`) instead of collapsing into the generic
/// "malformed manifest" the strict deserializer would otherwise produce (#190 ITEM-4,
/// INV-3). The strict deserializer stays the backstop — this pass never *accepts* anything
/// it would reject.
///
/// ## Why the walk is PATH-SCOPED, not a search for any key named `env`
///
/// The first version walked the WHOLE untyped document for any string-valued `env` key,
/// justified by "the outer schema is `deny_unknown_fields` at every enumerable level, so an
/// `env` key cannot appear anywhere it is not an env-id". **That premise is false**, and
/// this file's own header says so: a contribution's `params` / `accepts` / `produces` and a
/// datatype's `schema` / `axes` / `input_requirements` are free-form `serde_json::Value`
/// whose inner vocabulary is owned elsewhere and deliberately NOT key-denied. A manifest
/// carrying `env` inside one of those — a JSON-Schema `examples` block, a `host_resources`
/// map — is legitimate, and the blanket walk rejected the whole package for it. No shipped
/// manifest tripped it, so it was latent; the trigger is an ordinary idiom, not a
/// contrivance.
///
/// So the walk visits exactly the two positions where `env` IS the typed env-id field:
/// `contributes.converters[*].env` and `contributes.analyses[*].env` — the two structs
/// above carrying `deserialize_with = "de_checked_env"`. A third `env`-bearing contribution
/// kind means adding it to `ENV_BEARING_CONTRIBUTION_KINDS`, which is why this is a named
/// list rather than a recursive search: the omission becomes a visible edit instead of a
/// silent behaviour change, and `env_bearing_kinds_match_the_typed_fields` fails if the
/// list and the struct attributes drift apart.
///
/// A document that is not valid YAML is left entirely to the strict parse, which owns that
/// error and reports it better.
fn check_env_ids(name: &str, text: &str) -> Result<(), LintFailure> {
    let Ok(doc) = serde_norway::from_str::<serde_norway::Value>(text) else {
        return Ok(());
    };
    let Some(contributes) = doc.get("contributes") else {
        return Ok(());
    };
    for kind in ENV_BEARING_CONTRIBUTION_KINDS {
        let Some(items) = contributes.get(kind).and_then(|v| v.as_sequence()) else {
            continue;
        };
        for item in items {
            let Some(v) = item.get("env").and_then(|v| v.as_str()) else {
                continue;
            };
            if !env_id::is_valid_env_id(v) {
                // Phrased identically to the strict deserializer's message
                // (`de_checked_env`), so the author sees ONE wording whichever pass catches
                // it — and #189's acceptance test, which asserts the key and the value are
                // both named, holds against either.
                return Err(failed(
                    CHECK_ENV_ID_INVALID,
                    name,
                    format!(
                        "`env` must be a lowercase OCI repository path component \
                         (a-z, 0-9, `.`, `_`, `-`; non-empty) — got `env: {v:?}`"
                    ),
                ));
            }
        }
    }
    Ok(())
}

/// The `contributes.*` keys whose item type declares a typed, grammar-checked `env` field.
///
/// `env_bearing_kinds_match_the_typed_fields` keeps it honest from BOTH sides, because each
/// alone would leave a hole: the expected SET is derived from the runtime `Contributes`
/// schema (a kind whose items declare an `env` property), and the COUNT is cross-checked
/// against the `deserialize_with = "de_checked_env"` attributes in this file — the two
/// things the doc used to claim lockstep with while the test read only one of them.
const ENV_BEARING_CONTRIBUTION_KINDS: &[&str] = &["converters", "analyses"];

// ─────────────────── #80: the declared dependency + version gate ───────────────────
//
// The GAP this closes. A contribution's compute could only use whatever the environment
// image happened to contain, and nothing anywhere recorded which of those it relied on.
// So the two ways that went wrong both surfaced at the worst possible moment: a library
// the code imports but the image lacks became a raw interpreter import failure inside a
// user's sandboxed job, and a library the image DID contain at a different version
// silently changed the numbers a run published, with no diff in this repository to point
// at. Both are decidable HERE, from data, before anything is built.
//
// The two sides of the comparison are both DATA and neither is named in this crate: a
// manifest declares `run.dependencies[]` (a distribution name + a supported range), and
// the env recipe declares its pin set (a distribution name + the exact version it
// installs). This gate resolves one against the other. It understands what a version is;
// it understands nothing about any library.
//
// The recipe file this reads lives beside the recipe it pins, OUTSIDE this crate, for the
// same reason the recipe itself does: what an environment contains is a property of the
// environment, not of the server that dispatches into it.

/// The pin file that sits beside an env recipe and declares its exact installed set.
const ENV_PIN_FILE: &str = "requirements.txt";

/// The recipe file whose presence marks a directory as an env recipe.
///
/// Mirrors `rootfs::version::ENV_RECIPE_FILE`. The duplication exists because `build.rs`
/// compiles this file BEFORE the crate, so it cannot name a lib constant — the same
/// reason `ROOT_DATATYPE_IDS` and `RESERVED_ENTRY_CODE_REFS` above are literals here. The
/// divergence guard is `env_recipe_marker_matches_the_runtime_constant` below, which
/// compiles only on the LIB side (where both are visible) and is what makes the mirror
/// mechanical rather than remembered.
const ENV_RECIPE_MARKER: &str = "Dockerfile";

/// ONE parsed pin: a normalized distribution name and the exact version installed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnvPin {
    /// The distribution name, folded under the RECIPE'S declared ecosystem
    /// ([`normalize_dist_name_in`]) so a declaration and a pin match under one rule.
    /// For python that is the PEP 503 fold (lowercased, runs of `-`/`_`/`.` collapsed);
    /// for R it is the exact, case-preserved name.
    pub name: String,
    /// The exact version the recipe installs.
    pub version: String,
}

/// PEP 503-style name normalization: lowercase, and every run of `-`, `_` or `.`
/// collapsed to a single `-`. Package indexes treat these spellings as the same
/// distribution, so a gate that did not would reject a legitimate declaration for a
/// punctuation difference.
///
/// This is the PYTHON rule specifically — it is one arm of
/// [`normalize_dist_name_in`], which is what the gate calls. It keeps its name, its
/// signature and its behaviour because `_lib/cyto_deps.py::normalize_name` mirrors it at
/// run time (#192 / DEC-3). *Not byte-for-byte, and an audit was right to say so:* this
/// uses `to_ascii_lowercase` and the python mirror uses `str.lower()`, which is Unicode
/// aware, so python folds strictly MORE (`U+212A KELVIN SIGN` → `k`). The direction is
/// safe — the gate's equivalence classes are finer, so a disagreement surfaces as a loud
/// `cargo check` failure rather than a silent pass — and it is unreachable in practice
/// because an index normalises names before publishing. Stated rather than claimed away, and at least one shipped contribution's
/// compute calls that mirror — so changing this arm would reach a published analysis,
/// not just this gate. (Which contribution is deliberately NOT named here: this file is
/// app-core surface, and `lint-no-domain-in-builtin.mjs` correctly refuses a
/// contributed package's name in it, prose included. Ask the tree — the callers of
/// `cyto_deps.normalize_name` are derivable and this comment would only go stale.)
pub fn normalize_dist_name(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut last_sep = false;
    for ch in raw.trim().chars() {
        if ch == '-' || ch == '_' || ch == '.' {
            if !last_sep {
                out.push('-');
                last_sep = true;
            }
        } else {
            out.push(ch.to_ascii_lowercase());
            last_sep = false;
        }
    }
    out.trim_matches('-').to_string()
}

/// Which packaging ECOSYSTEM a recipe belongs to (#192 / ITEM-1).
///
/// ## One declaration, two derived facets
///
/// A pin file declares this once, as `# cyto:ecosystem=<python|r>`, and BOTH facets the
/// gate needs follow from it:
///
///   * the DISTRIBUTION-NAME rule — [`normalize_dist_name_in`] — PEP 503 folding for
///     python, exact and case-preserving for R;
///   * the VERSION grammar — [`EnvEcosystem::grammar`] — PEP 440 for python, R
///     `DESCRIPTION` for R.
///
/// ## Why the name rule has to be per-ecosystem at all
///
/// R package names are CASE-SENSITIVE by definition — `Matrix` and `matrix` are
/// different packages, and `scDblFinder` is not `scdblfinder`. Folding them PEP
/// 503-style can therefore match a declaration to the WRONG pin and report green, and
/// **a pin that matches the wrong package is strictly worse than no pin**: an absent
/// pin is visible, a false one is not. The R recipe's own header records that it was
/// shipped safe-for-now only because no two of its names collide under lowercasing, and
/// names this item as the general fix.
///
/// ## Why ONE declaration and not two
///
/// The shipped predecessor declared only the version grammar
/// (`# cyto:version-grammar=`) — correct for the problem it was written for, and half of
/// the problem the R lane actually has. Keeping both directives would let a file say
/// "R versions, PEP 503 names", a combination with no coherent meaning, in the one file
/// whose entire job is to be unambiguous. A recipe belongs to exactly one packaging
/// ecosystem and both facets are properties OF that ecosystem, not independent choices.
/// The retired key is a hard error naming this one, never a silent fall-through — see
/// [`parse_env_pin_ecosystem`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnvEcosystem {
    /// PyPI-style: names fold under PEP 503, versions read as PEP 440.
    Python,
    /// R: names are exact and case-sensitive, versions read as R `DESCRIPTION`.
    R,
}

impl EnvEcosystem {
    /// The token a pin file declares this ecosystem with.
    pub fn token(self) -> &'static str {
        match self {
            EnvEcosystem::Python => "python",
            EnvEcosystem::R => "r",
        }
    }

    /// The version grammar this ecosystem's pins and the declarations against them are
    /// written in.
    pub fn grammar(self) -> VersionGrammar {
        match self {
            EnvEcosystem::Python => VersionGrammar::Pep440,
            EnvEcosystem::R => VersionGrammar::RDescription,
        }
    }
}

/// [`normalize_dist_name`] under an explicit ecosystem — the form the gate calls, so
/// BOTH sides of every comparison fold under the rule the RECIPE declares.
///
/// That "both sides" is the whole content of the fix. The declaration side and the pin
/// side are folded in two different places (`lint_declared_dependencies` and
/// [`parse_env_pins_in`]); before #192 both used the python rule unconditionally, so an
/// R recipe's pins were lowercased on the way in and every declaration was lowercased to
/// match — consistent, and consistently wrong.
pub fn normalize_dist_name_in(raw: &str, ecosystem: EnvEcosystem) -> String {
    match ecosystem {
        EnvEcosystem::Python => normalize_dist_name(raw),
        // EXACT, deliberately: surrounding whitespace only. Not lowercased, and runs of
        // `-`/`_`/`.` are NOT collapsed — `bit64` and `bit-64` are not the same R package
        // and nothing in R's own machinery says they are. The PEP 503 fold exists because
        // a PyPI index treats those spellings as one distribution; no R repository does.
        EnvEcosystem::R => raw.trim().to_string(),
    }
}

/// Which version GRAMMAR a recipe's pins and the declarations against them are written in.
///
/// ## Why this exists, and why it is DECLARED rather than sniffed
///
/// The gate was written when every env was a python one, so it read exactly one grammar:
/// PEP 440's dotted-numeric release. R does not use that grammar. R's `DESCRIPTION`
/// version is a sequence of integers separated by `.` **or** `-`, treated identically by
/// R's own `numeric_version`/`compareVersion` — `Matrix 1.7-6`, `spatstat 3.6-2`,
/// `lme4 2.0-6`, `refund 0.1-40` are all real upstream versions in this shape.
///
/// Under the PEP 440 reader those parse to nothing, so the FIRST contribution to declare
/// `env: <an R recipe>` with a range over any of them would hard-fail `cargo check` with
/// "not a plain dotted-numeric release" — a build error naming a grammar, for a
/// declaration that is perfectly well formed in the language it is written for.
///
/// **The two grammars genuinely disagree, which is why the recipe has to SAY which one it
/// is rather than have it inferred from a `-`.** `1.0-1` is legal in both: R reads it as
/// release `1.0.1`, PEP 440 reads it as the non-canonical spelling of `1.0.post1`, and
/// `1.0.post1 < 1.0.1`. So a reader that accepted `-` for everything would, for that one
/// string, ACCEPT a declaration the python run time (`_lib/cyto_deps.py`, which uses the
/// reference implementation) REJECTS — the exact direction [`version_satisfies`]'s
/// fail-closed contract forbids.
///
/// **This is no longer declared directly.** Since #192 it is DERIVED from the recipe's
/// declared [`EnvEcosystem`] ([`EnvEcosystem::grammar`]), because the version grammar and
/// the distribution-name rule are two facets of one fact and a file that could declare
/// them separately could declare them incoherently. There is also no longer a default:
/// every recipe declares its ecosystem or fails, so "nobody declared anything" can never
/// be mistaken for "this is a python recipe".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VersionGrammar {
    /// PEP 440 dotted-numeric releases. Selected by `cyto:ecosystem=python`; NOT a
    /// default — a recipe that declares nothing is refused (see [`EnvEcosystem`]).
    Pep440,
    /// R `DESCRIPTION` versions: integers separated by `.` or `-`, equivalently.
    RDescription,
}

/// The directive a pin file uses to declare its [`EnvEcosystem`], written as a comment
/// so the file stays a valid requirements-style list for every other reader of it (the
/// recipe's own installer, the python guard, a human).
const ENV_ECOSYSTEM_DIRECTIVE: &str = "cyto:ecosystem";

/// The RETIRED predecessor of [`ENV_ECOSYSTEM_DIRECTIVE`] (#192 / DEC-1).
///
/// A pin file still carrying it is a HARD ERROR naming the replacement — never ignored.
/// The only recipe that ever declared it is the R one, and ignoring it there would
/// restore BOTH halves of the failure this item removes: PEP 440 version reading (the
/// thing the old directive existed to prevent) and PEP 503 name lowercasing (the thing
/// the new one exists to prevent). A silent migration of a directive whose absence means
/// "python" is a migration that reads an R recipe as python.
const RETIRED_GRAMMAR_DIRECTIVE: &str = "cyto:version-grammar";

/// The directive a pin file uses to declare where its pins were RESOLVED AGAINST.
///
/// Repeatable — see [`parse_env_pin_sources`].
const ENV_PIN_SOURCE_DIRECTIVE: &str = "cyto:pin-source";

/// Normalise a pin-file line to its comment BODY: leading whitespace and every leading
/// `#` removed, then trimmed. `#`, `# `, `##  ` and a tab-indented variant all reach the
/// same place, so a directive cannot be missed over cosmetic spelling — which is how the
/// first cut of the grammar directive silently selected the wrong default.
fn directive_body(raw: &str) -> &str {
    // ASCII WHITESPACE ONLY, and this is a security property rather than a nicety.
    //
    // `str::trim` is Unicode White_Space; the recipe's own R reader normalises with the
    // POSIX class `[[:space:]]`, which is ASCII. They differ at U+00A0 (NBSP) and U+0085
    // (NEL) — so `#<NBSP>cyto:pin-source=…` was a DIRECTIVE to this gate and INVISIBLE to
    // the reader that actually installs. A blind audit built the attack out of that: one
    // invisible byte in front of the real coordinate hides it from R, an added line
    // supplies another, `cargo check` sees the legitimate URL still present and passes,
    // and the image build resolves CRAN from somewhere else — where `install.packages`
    // runs the package's own install code as root into the published rootfs.
    //
    // Narrowing to ASCII makes both readers ignore the same lines. That is the safe
    // direction for a DISAGREEMENT; the safe direction for the ATTACK is closed by
    // per-class uniqueness below, which is what makes the second coordinate a refusal
    // rather than a silent choice. Neither alone is enough, and the fix is deliberately
    // both.
    let is_sp = |c: char| c.is_ascii_whitespace();
    raw.trim_start_matches(is_sp)
        .trim_start_matches('#')
        .trim_matches(is_sp)
}

/// Clamp untrusted file content before it reaches a build log.
///
/// Refusal messages interpolate raw lines from a committed pin file, and `build.rs`
/// panics with the result — so those bytes land on cargo's stderr, a developer's terminal
/// and whatever parses a CI log. An audit demonstrated a 200 KB line carrying `CR` + ANSI
/// SGR that repainted the terminal and forged a success message. Control characters are
/// escaped and the length is bounded; the message stays useful because the interesting
/// part of a malformed directive is its start.
fn clamp_for_message(raw: &str) -> String {
    const MAX: usize = 200;
    let mut out = String::with_capacity(MAX + 16);
    let mut n = 0usize;
    for c in raw.chars() {
        if n >= MAX {
            out.push_str("… (truncated)");
            break;
        }
        if c.is_control() {
            out.push_str(&format!("\\u{{{:x}}}", c as u32));
            n += 6;
        } else {
            out.push(c);
            n += 1;
        }
    }
    out
}

/// Does this comment body NAME `key` as a directive?
///
/// A bare `starts_with` is not enough, and the failure it produces is the one this
/// repository keeps re-learning in the other direction. `cyto:ecosystemXYZ=r` is not this
/// directive but begins with its name, so a prefix test made it a hard build error; worse,
/// a pin file's own PROSE about a directive — and these files document their directives at
/// length — is refused as a malformed declaration of it. The next character after the key
/// must be a separator, so the token is matched and not merely the string it starts with.
fn names_directive(body: &str, key: &str) -> bool {
    // ASCII whitespace, matching `directive_body` and the recipe's POSIX class. An audit
    // found this function and `directive_value` still on Unicode `is_whitespace` after
    // `directive_body` was narrowed — so `# cyto:pin-source<NBSP>=…` was still a live
    // directive here and invisible to the installer, which is the whole of the original
    // finding, one function over. Narrowing a normalisation in one of three places is not
    // narrowing it. (The canonical-bytes precondition now refuses such a file outright;
    // this stays ASCII anyway, because a precondition and a parser that disagree is the
    // same class of defect again.)
    match body.strip_prefix(key) {
        Some(rest) => rest
            .chars()
            .next()
            .map(|c| c == '=' || c.is_ascii_whitespace())
            .unwrap_or(true),
        None => false,
    }
}

/// Read the `=<value>` half of a directive line, or refuse.
///
/// A line that MENTIONS a directive and does not parse is an ERROR, not a fall-through:
/// for both directives here the fall-through is silently wrong rather than merely
/// missing.
fn directive_value<'a>(
    body: &'a str,
    key: &str,
    lineno: usize,
    raw: &str,
    shape: &str,
) -> Result<&'a str, String> {
    let rest = body[key.len()..].trim_start_matches(|c: char| c.is_ascii_whitespace());
    let Some(value) = rest.strip_prefix('=') else {
        return Err(format!(
            "{ENV_PIN_FILE} line {lineno}: `{}` names `{key}` but is not `{shape}` — a \
             near-miss is refused rather than silently read as absent, because a pin file \
             that says nothing and a pin file that tried to say something and failed are \
             not the same file",
            clamp_for_message(raw.trim())
        ));
    };
    // A trailing comment is allowed and ignored — but only when it is SEPARATED by
    // whitespace. A bare `#` is legal inside a URL fragment, and an unconditional split
    // silently truncated a coordinate there: the regime the file DECLARES and the regime
    // the build RESOLVES would differ, with no error anywhere, in the one file whose job
    // is to be the record of what the pins mean. The value is documented as free-form and
    // never interpreted here, which is incompatible with unconditional comment-stripping.
    let value = match value.find(|c: char| c.is_whitespace()) {
        Some(_) => {
            let mut out = value;
            for (i, c) in value.char_indices() {
                if c == '#' && value[..i].ends_with(char::is_whitespace) {
                    out = &value[..i];
                    break;
                }
            }
            out
        }
        None => value,
    };
    Ok(value.trim_matches(|c: char| c.is_ascii_whitespace()))
}

/// The bytes a pin file may contain, checked BEFORE anything is parsed (#192, round 3).
///
/// ## Why a byte-level precondition, and not a fourth whitespace fix
///
/// Three separate audit findings were one defect: this gate and the recipe's own R
/// installer disagreed about which bytes are whitespace, so a line could be a DIRECTIVE
/// to one and invisible to the other — in both directions.
///
///   * `str::lines()` splits only on LF; R's `readLines` also splits on a lone CR. So
///     `…# see the runbook<CR># cyto:pin-source=dated-snapshot:<attacker>` is a comment
///     fragment here and a whole directive line there.
///   * POSIX `[[:space:]]` includes U+000B; `char::is_ascii_whitespace` does not. So
///     `#<VT>cyto:pin-source=…` is invisible HERE and live there — the gate blind, the
///     installer obeying.
///   * Unicode `is_whitespace` includes U+00A0/U+0085; POSIX does not. The reverse.
///
/// Each round fixed the instance and left the CLASS, and the class is unbounded: one entry
/// per disagreement between two whitespace definitions in two languages, in four parsers.
/// **So the file is REFUSED if it contains any CONTROL or WHITESPACE character other than
/// SPACE, TAB and LF** — the UNION of what the three languages call a separator, widened in
/// round 4 after python's `str.splitlines()` terminators (U+001C/1D/1E) were found to pass
/// a set derived from `char::is_whitespace` alone. There is then nothing left to disagree about — every remaining byte is one
/// both definitions treat identically, and the divergence becomes unrepresentable rather
/// than merely agreed.
///
/// Non-whitespace non-ASCII is untouched. These files are full of em dashes and
/// box-drawing and none of it is parseable by anything.
/// The ONLY non-ASCII characters a pin file may contain — the decorative ones its prose
/// actually uses.
///
/// Kept small and enumerated on purpose. See [`assert_canonical_pin_bytes`] for why this
/// is an allowlist rather than a list of forbidden characters.
pub const PIN_FILE_ALLOWED_NON_ASCII: [char; 4] = ['\u{a7}', '\u{2014}', '\u{2192}', '\u{2500}'];

pub fn assert_canonical_pin_bytes(text: &str) -> Result<(), String> {
    for (idx, c) in text.char_indices() {
        // ── AN ALLOWLIST, NOT A FORBIDDEN SET. This is the important word. ──
        //
        // Rounds 2-4 of #192 each widened a FORBIDDEN set, and each widening was correct
        // and insufficient: NBSP, then a lone CR, then U+000B, then U+001C. Round 4 arrived
        // at `is_control() || is_whitespace()` minus {SP,TAB,LF} — the union of three
        // languages' notions of a separator — and called the class closed.
        //
        // It was not. A forbidden set FAILS OPEN on everything nobody thought of, and a
        // blind audit of #214 walked straight through the next door: `char::is_control()`
        // is category `Cc` only, so the whole `Cf` FORMAT class passed — U+FEFF, U+200B,
        // U+00AD, U+2060, and the bidi controls of Trojan Source (CVE-2021-42574). A
        // zero-width space in `#<ZWSP>cyto:pin-source=…` makes `names_directive` return
        // FALSE rather than error, so a declared coordinate becomes inert while remaining
        // visibly present, and the per-class uniqueness check then does not fire against a
        // second, live one. It is invisible to a reviewer in the pin file AND in the
        // generated artefact.
        //
        // That is the fifth member of a class that has produced one member per audit, so
        // the polarity is inverted rather than the set widened again. A pin file may
        // contain PRINTABLE ASCII, SPACE, TAB, LF, and the four decorative characters its
        // own prose uses. Everything else — every control, every format character, every
        // exotic space, every bidi override, and every character Unicode has not defined
        // yet — is refused BY DEFAULT.
        //
        // Three further things this buys, none of them small:
        //
        //  * The rule is now trivially expressible in all three languages. R needed a
        //    242-codepoint enumeration to express the forbidden version and now needs a
        //    four-character one, so the three implementations can be compared by eye as
        //    well as by test.
        //  * It closes homoglyph and confusable attacks, which no whitespace framing could
        //    ever have reached.
        //  * It cannot decay. A forbidden set silently stops covering the class the day
        //    Unicode adds a character; an allowlist refuses that character on the day it
        //    is first used, and the refusal names it.
        //
        // The cost is real and deliberate: adding a decorative character to a pin file's
        // prose costs a line here. That is the same shape `docs/design/derived-guards.md`
        // §4 sanctions for a frozen case — an edit only when a covered entry changes.
        let allowed = matches!(c, ' ' | '\t' | '\n')
            || c.is_ascii_graphic()
            || PIN_FILE_ALLOWED_NON_ASCII.contains(&c);
        if !allowed {
            let lineno = text[..idx].matches('\n').count() + 1;
            return Err(format!(
                "{ENV_PIN_FILE} line {lineno}: character U+{:04X} is not permitted. A pin \
                 file may contain printable ASCII, SPACE, TAB, LF, and only these \
                 non-ASCII characters: {}. Everything else is refused BY DEFAULT, because \
                 the {} programs that parse this file — {} — do not agree about which \
                 bytes separate tokens or end lines, and because a character a human \
                 reviewer cannot see is one they cannot review. Four audit rounds widened \
                 a list of FORBIDDEN characters and each widening was correct and \
                 insufficient; this list is the other polarity, so a character nobody has \
                 thought of is refused rather than admitted. If you genuinely need this \
                 character in prose, add it to `PIN_FILE_ALLOWED_NON_ASCII` and to the two \
                 other implementations, which two cross-check tests hold to each other.",
                c as u32,
                PIN_FILE_ALLOWED_NON_ASCII
                    .iter()
                    .map(|c| format!("U+{:04X} {c}", *c as u32))
                    .collect::<Vec<_>>()
                    .join(", "),
                PIN_FILE_PARSERS.len(),
                PIN_FILE_PARSERS.join("; "),
            ));
        }
    }
    Ok(())
}

/// Apply [`assert_canonical_pin_bytes`] to EVERY discovered recipe, unconditionally.
///
/// ## Why this is its own pass instead of a step inside the dependency gate
///
/// The precondition used to live inside `read_env_recipes`, which is reached only from
/// `lint_declared_dependencies` — and that function short-circuits with `return Ok(())`
/// when no package declares a `run.dependencies` or an `env`. So "is this file's bytes
/// canonical" was a side effect of asking a different question, and in a tree where
/// nothing declared a dependency, NO pin file was checked at all while every other reader
/// went on parsing them.
///
/// That is the wrong shape for a precondition. A file-validity rule must not be
/// contingent on what some package happens to declare, so it runs here, over the recipe
/// tree, before anything else looks at it.
pub fn assert_every_recipe_canonical(env_root: &Path) -> Result<(), String> {
    let Ok(entries) = std::fs::read_dir(env_root) else {
        // A missing env tree is not this check's error to report — the dependency gate
        // and the smoke guard each have their own, better-scoped message for it.
        return Ok(());
    };
    let mut dirs: Vec<std::path::PathBuf> =
        entries.filter_map(|e| e.ok().map(|e| e.path())).collect();
    dirs.sort();
    for dir in dirs {
        if !dir.is_dir() || !dir.join(ENV_RECIPE_MARKER).exists() {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(dir.join(ENV_PIN_FILE)) else {
            continue; // "recipe with no readable pin file" is `read_env_recipes`'s error
        };
        assert_canonical_pin_bytes(&text)
            .map_err(|e| format!("env recipe `{}`: {e}", pkg_name(&dir)))?;
    }
    Ok(())
}

/// Read a pin file's declared [`EnvEcosystem`].
///
/// **REQUIRED. There is no default** (#192 / DEC-1). A defaulting reader cannot tell
/// "this is a python recipe" from "somebody deleted the declaration", and the second is
/// exactly the deletion a derivation reading the same file is blind to
/// (`docs/design/derived-guards.md` §4). Requiring the declaration is a STRUCTURAL floor
/// — strictly stronger than counting something — and it costs one line per recipe.
pub fn parse_env_pin_ecosystem(text: &str) -> Result<EnvEcosystem, String> {
    let mut found: Option<(usize, EnvEcosystem)> = None;
    for (idx, raw) in text.lines().enumerate() {
        let lineno = idx + 1;
        let body = directive_body(raw);
        if names_directive(body, RETIRED_GRAMMAR_DIRECTIVE) {
            return Err(format!(
                "{ENV_PIN_FILE} line {lineno}: `{RETIRED_GRAMMAR_DIRECTIVE}` is RETIRED \
                 (#192). Declare `{ENV_ECOSYSTEM_DIRECTIVE}=<python|r>` instead — one \
                 declaration from which BOTH the version grammar and the \
                 distribution-name rule follow. It is an error rather than an ignored \
                 line because ignoring it would read this recipe as python: PEP 440 \
                 versions AND PEP 503 lowercased names, which is the exact pair of \
                 failures the replacement removes"
            ));
        }
        if !names_directive(body, ENV_ECOSYSTEM_DIRECTIVE) {
            continue;
        }
        let value = directive_value(
            body,
            ENV_ECOSYSTEM_DIRECTIVE,
            lineno,
            raw,
            "cyto:ecosystem=<python|r>",
        )?;
        let eco = match value {
            "python" => EnvEcosystem::Python,
            "r" => EnvEcosystem::R,
            other => {
                return Err(format!(
                    "{ENV_PIN_FILE} line {lineno}: `{ENV_ECOSYSTEM_DIRECTIVE}={other}` names \
                     no known packaging ecosystem (python, r). An unrecognised value is \
                     refused rather than defaulted — silently reading an R recipe as \
                     python lowercases its package names, and a declaration that matches \
                     the WRONG pin reports green"
                ));
            }
        };
        // A SECOND declaration is refused whether or not it agrees. Two lines that happen
        // to match today are two lines that can disagree tomorrow, and the file would then
        // silently mean whichever the loop saw last.
        if let Some((prev_line, prev)) = found {
            return Err(format!(
                "{ENV_PIN_FILE} line {lineno}: a second `{ENV_ECOSYSTEM_DIRECTIVE}` \
                 declaration ({}); line {prev_line} already declared {}. The file may \
                 declare exactly one",
                eco.token(),
                prev.token()
            ));
        }
        found = Some((lineno, eco));
    }
    found.map(|(_, e)| e).ok_or_else(|| {
        format!(
            "{ENV_PIN_FILE}: no `{ENV_ECOSYSTEM_DIRECTIVE}=<python|r>` declaration. Every \
             recipe must declare its packaging ecosystem — the distribution-name rule and \
             the version grammar both follow from it, and a default would make a DELETED \
             declaration indistinguishable from a python recipe. Add the line; do not \
             reintroduce a default to make this pass"
        )
    })
}

/// What a pin's upstream guarantees about the IDENTITY a recorded version denotes
/// (#192 / #209).
///
/// ## The question this answers
///
/// A pin file records `<name>==<version>` and a run's provenance records the image that
/// installed it. That is only an identity if the upstream guarantees **one (name,
/// version) pair denotes exactly one source tree**. For an index that guarantee is
/// definitional; for an unversioned VCS head it is simply false, and a pin against one
/// records the same string for different code — which is worse than no pin at all,
/// because an absence is visible and a false identity is not.
///
/// A second, weaker property matters too: whether a pinned version can still be FETCHED
/// later. It does not affect what a past run's record MEANS (the identity still holds);
/// it decides whether a rebuild reproduces the image or fails loud. The R recipe's own
/// header describes exactly this for Bioconductor: *"a rebuild a month from now does not
/// reproduce this image — it goes RED naming the package that moved."*
///
/// The taxonomy is not speculative generality for an absent case: three of the four
/// classes describe pins shipping on this branch today, and the fourth is #209's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PinSourceClass {
    /// An index whose published releases are immutable: `(name, version)` denotes one
    /// artifact forever, and old versions stay fetchable. PyPI.
    ImmutableIndex,
    /// A DATED SNAPSHOT of an index. Strictly stronger than an immutable index: it also
    /// fixes name→version, so "what the index served on day X" is reproducible. The
    /// Posit Package Manager CRAN snapshot the R recipe installs from.
    DatedSnapshot,
    /// A RELEASE CHANNEL. `(name, version)` still denotes one tree, but the channel
    /// serves new patch versions continuously and DROPS old ones, so nobody has to move
    /// it for it to move. A rebuild fails loud naming the package that moved; it does not
    /// silently ship a different version. Bioconductor's per-release repository.
    ReleaseChannel,
    /// An unversioned VCS head. `(name, version)` denotes NOTHING in particular: two
    /// builds a day apart record the same version string for different trees. **REFUSED**
    /// — see [`parse_env_pin_sources`] and #209.
    VcsHead,
}

/// Every [`PinSourceClass`], so the parser's messages and its class lookup can be DERIVED
/// rather than retyped. `token()` is an exhaustive match, so a new variant is a compile
/// error there; this array is what makes it SPELLABLE, and the round-trip assertion in
/// TEST-4 is what catches a variant added to the enum but forgotten here.
const PIN_SOURCE_CLASSES: [PinSourceClass; 4] = [
    PinSourceClass::ImmutableIndex,
    PinSourceClass::DatedSnapshot,
    PinSourceClass::ReleaseChannel,
    PinSourceClass::VcsHead,
];

impl PinSourceClass {
    /// The token a pin file declares this class with.
    pub fn token(self) -> &'static str {
        match self {
            PinSourceClass::ImmutableIndex => "immutable-index",
            PinSourceClass::DatedSnapshot => "dated-snapshot",
            PinSourceClass::ReleaseChannel => "release-channel",
            PinSourceClass::VcsHead => "vcs-head",
        }
    }

    /// Does `(name, version)` from this source denote exactly one source tree?
    ///
    /// **This is the gate.** A source that answers `false` cannot be pinned at all, only
    /// pinned-looking, and the build refuses it.
    pub fn identifies_one_tree(self) -> bool {
        !matches!(self, PinSourceClass::VcsHead)
    }

    /// Can a pinned version still be fetched from this source later?
    ///
    /// Not a gate — a `false` here is a REBUILD property, and it fails loud (the recipe
    /// asserts every installed version against the pin file). Recorded because the
    /// difference between "this rebuild will fail loudly" and "this pin is a lie" is the
    /// whole distinction the regime exists to make.
    pub fn refetchable_later(self) -> bool {
        matches!(
            self,
            PinSourceClass::ImmutableIndex | PinSourceClass::DatedSnapshot
        )
    }
}

/// One declared resolution coordinate: a class and the coordinate itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PinSource {
    /// Byte span of the DIRECTIVE'S LINE, and of the coordinate within it — the same
    /// treatment a pin gets, added by #214 round 6.
    ///
    /// It was missing, and a blind audit showed what that cost: `pin_sources` was the one
    /// half of the artefact no consumer could verify, so rewriting the R recipe's CRAN
    /// snapshot to `2020-01-01` and its Bioconductor release to `3.99` verified cleanly and
    /// both #192 regime guards passed on the fabricated values. That is TEST-P21's exact
    /// class — "a correct digest and fabricated data, every python guard green" — in the
    /// structure that records WHERE THE PINS WERE RESOLVED, which is the supply-chain
    /// identity #209 exists for.
    pub byte_offset: usize,
    pub byte_len: usize,
    pub coordinate_span: (usize, usize),
    pub class: PinSourceClass,
    /// Free-form and NEVER interpreted here — a URL, a release number, a date. The core
    /// interprets neither side of a comparison (INV-4); this is a value the recipe's own
    /// installer resolves, recorded so the regime is written down where the pins are.
    pub coordinate: String,
    pub line: usize,
}

/// Read a pin file's declared resolution coordinates.
///
/// **Repeatable, unlike the ecosystem** — the R recipe resolves against TWO coordinates
/// (a dated CRAN snapshot and a Bioconductor release channel), and a reader that allowed
/// only one would make the single most important fact about that recipe unrepresentable.
/// A duplicate of the same `(class, coordinate)` pair is still refused: it says nothing
/// twice and is the shape a bad merge leaves behind.
///
/// **At least one is REQUIRED** — the anti-deletion floor (#192 / ITEM-9). A recipe with
/// no declared source has an unrecorded regime, which is the state the python pin file
/// describes as *"a published result rested on a dependency version that appears in NO
/// diff in this repo."*
pub fn parse_env_pin_sources(text: &str) -> Result<Vec<PinSource>, String> {
    let mut found: Vec<PinSource> = Vec::new();
    let mut src_offset = 0usize;
    for (idx, raw) in text.lines().enumerate() {
        let line_offset = src_offset;
        src_offset += raw.len() + 1;
        let lineno = idx + 1;
        let body = directive_body(raw);
        if !names_directive(body, ENV_PIN_SOURCE_DIRECTIVE) {
            continue;
        }
        let value = directive_value(
            body,
            ENV_PIN_SOURCE_DIRECTIVE,
            lineno,
            raw,
            "cyto:pin-source=<class>:<coordinate>",
        )?;
        // `split_once`, not `split`: a coordinate is routinely a URL and contains `:`.
        let Some((class_tok, coordinate)) = value.split_once(':') else {
            return Err(format!(
                "{ENV_PIN_FILE} line {lineno}: `{ENV_PIN_SOURCE_DIRECTIVE}={value}` is not \
                 `<class>:<coordinate>` — the class says what identity the source \
                 guarantees, the coordinate says which one it is; neither is optional"
            ));
        };
        let coordinate = coordinate.trim();
        if coordinate.is_empty() {
            return Err(format!(
                "{ENV_PIN_FILE} line {lineno}: `{ENV_PIN_SOURCE_DIRECTIVE}={value}` has an \
                 empty coordinate — a class with no coordinate records nothing"
            ));
        }
        // Resolved AGAINST THE ENUM, not against a second list of the same tokens typed
        // here. A retyped list is one more place to forget when #209 adds a class.
        let want = class_tok.trim();
        let Some(class) = PIN_SOURCE_CLASSES.iter().copied().find(|c| c.token() == want) else {
            let known = PIN_SOURCE_CLASSES
                .iter()
                .map(|c| c.token())
                .collect::<Vec<_>>()
                .join(", ");
            return Err(format!(
                "{ENV_PIN_FILE} line {lineno}: `{want}` names no known pin-source class \
                 ({known}). An unrecognised class is refused rather than defaulted — the \
                 class is what decides whether a recorded version is an identity at all"
            ));
        };
        // THE GATE (#209). A source that cannot make a version string denote one tree is
        // not a pin source; a recipe installing from one records the SAME identity for
        // DIFFERENT code, which is why #191 deferred SPARK/SPARK-X and PANORAMIC rather
        // than shipping them from an unversioned HEAD.
        if !class.identifies_one_tree() {
            // The admissible classes are ENUMERATED FROM THE ENUM, with the guarantee each
            // makes, rather than typed into this string. Two reasons: a list typed here
            // drifts the day a class is added (which is what #209 will do), and the
            // difference this message has to convey — "reproducible" versus "fails loud on
            // a rebuild" — is precisely `refetchable_later`, so deriving it is what keeps
            // that distinction from living only in a doc comment.
            let admissible = PIN_SOURCE_CLASSES
                .iter()
                .filter(|c| c.identifies_one_tree())
                .map(|c| {
                    format!(
                        "`{}` ({})",
                        c.token(),
                        if c.refetchable_later() {
                            "reproducible"
                        } else {
                            "fails loud on a rebuild"
                        }
                    )
                })
                .collect::<Vec<_>>()
                .join(", ");
            return Err(format!(
                "{ENV_PIN_FILE} line {lineno}: `{ENV_PIN_SOURCE_DIRECTIVE}={}:{coordinate}` \
                 is REFUSED. A `{}` source does not make `<name>==<version>` denote one \
                 source tree: two builds a day apart record the SAME version string for \
                 DIFFERENT code, so a run's provenance record would lie. An absence is \
                 visible; a false pin is not. Admissible: {admissible}. Shipping from such \
                 a source needs a commit pin PLUS a source hash, so the recorded identity \
                 distinguishes two trees — that is #209, and it is a recipe change, not a \
                 change to this regime",
                class.token(),
                class.token()
            ));
        }
        // ONE COORDINATE PER CLASS. Not merely "no exact repeat": two DIFFERENT
        // `dated-snapshot` lines make "which snapshot were these pins resolved at"
        // unanswerable, which is the one fact this directive exists to record — and the
        // recipe's own reader already refuses that state (`cyto_source_coordinate` demands
        // exactly one), so accepting it here was a gate that disagreed with the thing it
        // gates. A blind audit showed that asymmetry is what turns an invisible-whitespace
        // line into a silent origin swap: this side stays green because the legitimate
        // coordinate is still present, while the installing side picks the other one.
        if let Some(prev) = found.iter().find(|p| p.class == class) {
            return Err(format!(
                "{ENV_PIN_FILE} line {lineno}: a second `{}` pin source ({coordinate}); \
                 line {} already declared {}. A class may be declared at most ONCE — two \
                 coordinates of one class make \"which one were these pins resolved at\" \
                 unanswerable, and the recipe's own installer refuses the same state",
                class.token(),
                prev.line,
                clamp_for_message(&prev.coordinate)
            ));
        }
        found.push(PinSource {
            byte_offset: line_offset,
            byte_len: raw.len(),
            coordinate_span: span_of(raw, coordinate, line_offset),
            class,
            coordinate: coordinate.to_string(),
            line: lineno,
        });
    }
    if found.is_empty() {
        return Err(format!(
            "{ENV_PIN_FILE}: no `{ENV_PIN_SOURCE_DIRECTIVE}=<class>:<coordinate>` \
             declaration. Every recipe must record what its pins were resolved against — \
             an unrecorded regime is how a published result comes to rest on a dependency \
             version that appears in no diff in this repository. Add the line(s); do not \
             relax this requirement to make it pass"
        ));
    }
    Ok(found)
}

/// Parse an env recipe's pin file into its exact pin set, under the ecosystem the recipe
/// DECLARES.
///
/// Every non-blank, non-comment line must be `<distribution>==<version>` — a bare name, a
/// range, or a duplicate distribution is an error. That strictness is what makes the gate
/// below a TOTAL function: "does this pin satisfy that range" is only decidable without a
/// resolver because the recipe side is always exactly one version.
///
/// The `ecosystem` argument is what makes the PIN side of every comparison fold under the
/// same rule as the DECLARATION side (#192 / ITEM-2). It takes no default: the caller has
/// already read the recipe's declaration, and a defaulted reading here would silently
/// lowercase an R recipe's pins — after which no case-preserving comparison downstream
/// could recover them.
pub fn parse_env_pins_in(text: &str, ecosystem: EnvEcosystem) -> Result<Vec<EnvPin>, String> {
    Ok(parse_env_pins_detailed(text, ecosystem)?
        .into_iter()
        .map(|d| EnvPin {
            name: d.name,
            version: d.version,
        })
        .collect())
}

/// ONE pin, carrying everything ANY consumer of the exported parse asks for (#214/ITEM-3).
///
/// [`EnvPin`] is the projection the #80 dependency gate needs; this is the whole thing. The
/// extra fields are not speculative — each is something a program used to re-parse the file
/// to obtain, and the point of #214 is that nobody re-parses it:
///
/// * `raw_name` — the name as WRITTEN. `name` is folded under the recipe's ecosystem, and
///   for a python recipe that fold is lossy (PEP 503 lowercases and collapses separators).
///   A guard asserting what the file literally says needs the unfolded spelling, and
///   recovering it by re-reading the file is exactly the sixth grammar.
/// * `import` — the `# import=<module>` token. Its grammar lived ONLY inside
///   `env_image.rs`'s private loop, which is WHY that loop existed.
/// * `line` — so a consumer's error can name the line without counting them itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnvPinDetail {
    /// Folded under the recipe's declared ecosystem — the same value [`EnvPin::name`] carries.
    pub name: String,
    /// Exactly as written in the file, before any fold.
    pub raw_name: String,
    /// The exact version the recipe installs.
    pub version: String,
    /// The `# import=<module>` token, if the line carries one.
    ///
    /// `Option`, not a hard requirement HERE, deliberately. Requiring it in this function
    /// would change the contract of a parser ~20 fixtures call to ask a different question
    /// ("is `alpha==1.0` an exact pin?"), and those fixtures are not recipes. The
    /// requirement belongs to a REAL recipe, so it is enforced by
    /// [`generate_env_pin_artefact`] — which runs over the whole recipe tree on the
    /// unconditional build path, and therefore still makes a recipe without the token a
    /// build error. Same refusal, correct scope.
    pub import: Option<String>,
    /// 1-based line number in the pin file.
    pub line: usize,
    /// Byte offset of this pin's LINE in the pin file, and its length in bytes.
    ///
    /// These are what let a consumer verify the artefact's row against the file **without a
    /// grammar** — it indexes the bytes the parser already located and hashes them. See
    /// `docs/design/pin-file-single-parse.md` §4.1 mechanism 6: the first cut had consumers
    /// searching for `<name>==<version>` as a substring, which needed a line anchor and a
    /// comment anchor and had therefore acquired two of the three rules that define a
    /// parser. Coordinates remove the search, so there is nothing left to get wrong.
    ///
    /// Exact because the pin file may contain no CR (the allowlist refuses it), so every
    /// line separator is exactly one byte.
    pub byte_offset: usize,
    pub byte_len: usize,
    /// Byte spans of the three fields that were READ OUT of the line, each an absolute
    /// offset into the pin file and a length.
    ///
    /// The line hash above proves the LINE is unchanged. It does not prove the artefact's
    /// FIELDS correspond to it — a fabricated `version` leaves the bytes untouched. These
    /// let a consumer check each field by exact equality at coordinates the parser
    /// supplied: `raw[off..off+len] == field`. No search, no anchor, no line rule, no
    /// comment rule, and truncation is caught by the length.
    pub raw_name_span: (usize, usize),
    pub version_span: (usize, usize),
    /// `None` exactly when `import` is `None`.
    pub import_span: Option<(usize, usize)>,
}

/// The absolute byte span of `sub` within `whole`, where `sub` IS a subslice of `whole`.
///
/// Pointer arithmetic rather than a search: `str::find` would pick the FIRST occurrence,
/// which for a line like `alpha==alpha` is the wrong one, and a wrong span here would
/// silently vouch for the wrong bytes. A subslice knows where it came from.
fn span_of(whole: &str, sub: &str, base: usize) -> (usize, usize) {
    let off = sub.as_ptr() as usize - whole.as_ptr() as usize;
    debug_assert!(off + sub.len() <= whole.len(), "not a subslice");
    (base + off, sub.len())
}

/// Extract a `# import=<module>` token from a pin line's COMMENT half.
///
/// `import=` must start a WORD. A bare `split_once` matched inside another token, so a
/// comment reading `do not reimport=alpha here` handed back the module `alpha` — a pin
/// silently keyed to whatever a sentence happened to contain. That defect and its fix were
/// found in `env_image.rs`; the fix moves here with the grammar rather than being left
/// behind in the reader that is being deleted.
fn import_token(comment: &str) -> Option<String> {
    import_token_span(comment).map(|(s, _)| s.to_string())
}

/// [`import_token`], with the module's offset WITHIN `comment`.
fn import_token_span(comment: &str) -> Option<(&str, usize)> {
    comment
        .match_indices("import=")
        .find(|(i, _)| {
            *i == 0 || {
                let prev = comment.as_bytes()[i - 1];
                !prev.is_ascii_alphanumeric() && prev != b'_'
            }
        })
        .map(|(i, m)| {
            // THE R READER'S CHARSET, adopted (#214 round 2). The R installer matches
            // `import=([A-Za-z0-9._]+)`; this took everything up to whitespace and then
            // trimmed only `,` and `;`, so `# import=alpha)` yielded the module `alpha)`
            // here and `alpha` there — a gate ⇄ installer disagreement in the very token
            // the smoke-correspondence guard is keyed on. Round 1 tightened the NAME and the
            // VERSION to the strict readers' rules and left this one; a blind audit found
            // the omission.
            let start = i + m.len();
            let n = comment[start..]
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_'))
                .map(char::len_utf8)
                .sum::<usize>();
            (&comment[start..start + n], start)
        })
        .filter(|(s, _)| !s.is_empty())
}

/// [`parse_env_pins_in`], keeping everything the line carries — **the ONE parse** every
/// other consumer now reads through the generated artefact (#214 / INV-1).
pub fn parse_env_pins_detailed(
    text: &str,
    ecosystem: EnvEcosystem,
) -> Result<Vec<EnvPinDetail>, String> {
    let mut pins: Vec<EnvPinDetail> = Vec::new();
    let mut offset = 0usize;
    for (idx, raw) in text.lines().enumerate() {
        let line_offset = offset;
        // +1 for the LF. Exact because CR is outside the allowlist, so `lines()` never
        // strips two bytes here. A trailing line with no LF over-counts by one only after
        // the last line, which no pin follows.
        offset += raw.len() + 1;
        let (body, comment) = match raw.find('#') {
            Some(i) => (&raw[..i], &raw[i + 1..]),
            None => (raw, ""),
        };
        let line = body.trim();
        if line.is_empty() {
            continue;
        }
        let lineno = idx + 1;
        let Some((name, version)) = line.split_once("==") else {
            let line = clamp_for_message(line);
            return Err(format!(
                "{ENV_PIN_FILE} line {lineno}: `{line}` is not an exact pin — every line \
                 must be `<distribution>==<version>` (a bare name or a range cannot be \
                 checked against a declared range without resolving)"
            ));
        };
        // `;`, `@` AND INTERNAL WHITESPACE were added by #214 after a blind audit
        // DEMONSTRATED an exploit through this exact hole.
        //
        // A PEP 508 environment marker attaches after the VERSION, and the name check below
        // only tests for `;` in the NAME half. So `packaging==25.0 ; sys_platform in "nope"`
        // parsed as a clean pin with the version `25.0 ; sys_platform in "nope"` — none of
        // the blacklisted characters appear in `in`. The gate recorded the pin; `uv`
        // evaluated the marker as false and installed a DIFFERENT version transitively; the
        // smoke import passed because the package was present; and every floor was
        // satisfied because the pin was in the file. Eighteen appended characters turned an
        // explicit pin into a lie, and the pin in question was one that had been promoted
        // from a transitive dependency precisely so a reproducibility gate would not rest
        // on an unpinned version.
        //
        // This is a gate ⇄ `uv` disagreement, which is the SAME class #214 exists to close
        // and a reminder that `uv` is a real third reader of these bytes (§3.1). An exact
        // version cannot contain whitespace, a marker separator or a direct-reference `@`,
        // so all three are refused here where the gate can name the line.
        //
        // `=` IS ALSO IN THE SET, added by #214 rather than found there.
        //
        // `env_image.rs`'s reader — the one #214 deletes — was deliberately STRICTER than
        // this one on exactly this character, and said so: *"`alpha===1.0` splits to
        // version `=1.0`, which the build gate accepts today (its character set omits `=`)
        // and which is not an exact version by any reading."*
        //
        // Deleting a reader that is stricter than the one you keep does not reduce the
        // parser count, it LOWERS THE BAR — and ledger row 64 of #192 names that direction
        // as the one that produced its security findings: *"making the four agree exactly
        // would mean widening the strict readers."* So the strict rule is adopted here
        // FIRST and the strict reader deleted after. Nothing is widened; no legal pin
        // carries `=` in its version.
        if version.contains("==")
            || version.contains(['=', '<', '>', '!', '~', '*', ',', ';', '@'])
            || version.trim().chars().any(char::is_whitespace)
        {
            return Err(format!(
                "{ENV_PIN_FILE} line {lineno}: `{line}` is not a single exact pin"
            ));
        }
        // The NAME must be a plain distribution name. An extras marker (`foo[bar]`) or an
        // environment marker (`; python_version < …`) is legal in a requirements file and
        // is silently unmatchable by any declaration, so it would surface later as the
        // misleading "the env recipe does NOT install foo".
        //
        // TRIMMED first: `numpy ==2.4.6` is legal spelling, and rejecting it under a
        // message about extras would be both wrong and confusing.
        let name = name.trim();
        // A PLAIN DISTRIBUTION NAME: starts alphanumeric, then alphanumerics and `-`, `_`,
        // `.` only. #214 tightened this from a blacklist (`[ ] ; SP TAB`) to a whitelist
        // after a blind audit pointed out that `--index-url==https://evil/simple` and
        // `https://evil/x.whl==1.0` both parsed as "pins" — a requirements file's option
        // lines and direct references are not distributions, and a gate that reads one as a
        // pin is reasoning about garbage.
        //
        // IT IS NOT IDENTICAL TO THE R READER'S, and saying so matters. The first cut of
        // this comment claimed "the same charset the R and python readers already required,
        // so nothing is widened"; a second blind audit checked and it is false — the R
        // installer's `[A-Za-z0-9._]*` excludes `-`, which python distribution names
        // require (`scikit-learn`). So this is the UNION of what the two ecosystems need,
        // and it is deliberately WIDER than the R reader on one character. That direction is
        // safe here and only here: an R recipe carrying `foo-bar` fails LOUDLY in the
        // installer at image-build time rather than resolving to something else, which is a
        // refusal, not a bypass. Every other charset on this line is at least as strict as
        // both readers.
        let plain_name = !name.is_empty()
            && name.starts_with(|c: char| c.is_ascii_alphanumeric())
            && name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
        if !plain_name {
            return Err(format!(
                "{ENV_PIN_FILE} line {lineno}: `{line}` — the distribution must be a plain \
                 name (alphanumeric, `-`, `_`, `.`; no extras, no environment marker, no \
                 option flag, no URL); a declaration can never match one"
            ));
        }
        // NOTE the version is NOT required to be dotted-numeric here. An earlier cut did
        // require it, and that was over-tight: `2.9.0.post0` is a legal, common release
        // (pip freeze emits several), and the RUN TIME compares it correctly through the
        // reference implementation. Refusing it at parse time would make a pin the recipe
        // cannot express, for a library that may never be declared by anyone. The
        // dotted-numeric requirement belongs to a pin that is actually COMPARED against a
        // declared range — enforced in `lint_declared_dependencies`, where the
        // declarations are in scope and the error can name the package that needs it.
        let version_trimmed = version.trim();
        if version_trimmed.is_empty() {
            return Err(format!("{ENV_PIN_FILE} line {lineno}: `{line}` has an empty side"));
        }
        let raw_name_span = span_of(raw, name, line_offset);
        let version_span = span_of(raw, version_trimmed, line_offset);
        let import_span = import_token_span(comment)
            .map(|(s, _)| span_of(raw, s, line_offset));
        let raw_name = name.to_string();
        let name = normalize_dist_name_in(name, ecosystem);
        let version = version_trimmed.to_string();
        if name.is_empty() {
            return Err(format!("{ENV_PIN_FILE} line {lineno}: `{line}` has an empty side"));
        }
        if let Some(prev) = pins.iter().find(|p| p.name == name) {
            return Err(format!(
                "{ENV_PIN_FILE} line {lineno}: `{name}` is pinned twice ({} and {version}) \
                 — the pin set must be a function from distribution to version",
                prev.version
            ));
        }
        pins.push(EnvPinDetail {
            name,
            raw_name,
            version,
            import: import_token(comment),
            line: lineno,
            byte_offset: line_offset,
            byte_len: raw.len(),
            raw_name_span,
            version_span,
            import_span,
        });
    }
    Ok(pins)
}

// ───────────────────────── THE EXPORTED PARSE (#214) ─────────────────────────
//
// `docs/design/pin-file-single-parse.md` is the design; §2 is the principle and §4 is this
// artefact. The short version: one text file was parsed by ten programs in three
// languages, four audit rounds each produced three exploitable defects, and every one was a
// disagreement between two of those grammars about which bytes separate tokens or end
// lines. Widening a forbidden-byte set fixed each instance and left the class, because the
// number of PAIRS that can disagree grows quadratically in the number of parsers.
//
// So the gate exports its parse and every other consumer reads DATA. The artefact has no
// line rule, no comment rule and no whitespace-token rule — there is nothing in it for two
// readers to disagree about. The four historical exploits are not refused in it, they are
// UNREPRESENTABLE in it.
//
// The R installer keeps its parser (§3): it runs inside `docker build` with only the
// recipe's two files in context and cannot reach this. It is the irreducible second, and
// the canonical-bytes precondition is the right shape for holding TWO parsers together —
// it was the wrong shape for holding ten.

/// The programs that parse an env recipe's pin file. **There are exactly three** (#214 /
/// INV-1) — two written here, plus `uv` — and this array is the single place that number
/// is written down.
///
/// ## Why `uv` is counted
///
/// The python recipe does not parse its own pin file; it runs `uv pip install -r
/// requirements.txt`, and `uv` parses it — the same role the R installer occupies for the R
/// lane. The first cut of #214 classified it out on the grounds that we do not write it,
/// and reported "two". A blind audit then DEMONSTRATED a gate ⇄ `uv` disagreement (a PEP
/// 508 environment marker appended to a version; see `parse_env_pins_detailed`) which
/// turned a shipped pin into a lie with every gate green. A parser you cannot remove is
/// still a parser, and pretending otherwise is the same undercount §7 criticises #192's
/// "FIVE programs" for.
///
/// So: **eleven readers before, three after, of which two are ours and one is not.** The
/// number that can still be reduced is zero.
///
/// ELEVEN, not ten. `uv` was a parser before as well as after — if it counts now it counted
/// then. The first cut of this paragraph updated the AFTER number and left the BEFORE one,
/// which is a one-sided accounting and precisely what §7 criticises #192's "FIVE programs"
/// for. Caught by a blind audit reading the arithmetic.
///
/// The refusal in [`assert_canonical_pin_bytes`] DERIVES its count and its list from here
/// rather than carrying a hand-typed one. That is not tidiness: the previous message said
/// *"the FIVE programs that parse this file"* and named five, at a moment when the real
/// count was ten — it had been typed once, in round 4, and every subsequent change left it
/// behind. A refusal message that misstates the reason it exists teaches the reader that
/// the reason is decorative.
///
/// Adding a FOURTH parser means editing this array, which is exactly the edit
/// `the_pin_file_has_exactly_two_parsers` is watching for.
pub const PIN_FILE_PARSERS: [&str; 3] = [
    "this build gate, which is the sole producer of the exported parse every other \
     consumer reads",
    "the R recipe's own installer, which runs inside the image with only the recipe's two \
     files in context and so cannot read that export",
    "`uv`, the python recipe's installer — a third-party PEP 508 reader in the same role, \
     which this repository does not write and cannot remove",
];

/// The generated artefact, relative to the env recipe tree root.
///
/// At the tree ROOT, never inside a recipe directory — see DEC-2. A recipe is deliberately
/// exactly two files because `rootfs::version::format_version` hashes only the Dockerfile's
/// bytes and [`watched_env_pin_files`] watches exactly `{Dockerfile, requirements.txt}`; a
/// third file in a recipe directory is invisible to both, so a per-recipe artefact could
/// change without re-triggering the build that generates it. That is the staleness defect,
/// installed at the root of the thing that exists to prevent it.
pub const ENV_PIN_ARTEFACT: &str = "env-pins.generated.json";

/// The one command that rewrites [`ENV_PIN_ARTEFACT`]. Named in every refusal, because a
/// build error that does not say how to fix itself is a build error people learn to route
/// around.
pub const ENV_PIN_REGEN_CMD: &str = "just env-pins-regen";

/// Bumped when the artefact's SHAPE changes, so a consumer reading an older shape says so
/// instead of silently finding no pins.
const ENV_PIN_ARTEFACT_SCHEMA: u32 = 1;

/// The environment variable that switches [`env_pin_artefact_check_or_write`] from
/// COMPARING to WRITING. Set only by `just env-pins-regen`.
pub const ENV_PIN_REGEN_VAR: &str = "CYTO_REGEN_ENV_PINS";

/// Lowercase hex SHA-256 — how a consumer checks the artefact is fresh for the file it
/// describes WITHOUT parsing that file (DEC-5).
///
/// A digest is not a parse: no line rule, no comment rule, no token rule, nothing for two
/// readers to disagree about. That is precisely why it is the admissible way for a
/// data-consumer to touch pin-file bytes. A consumer may hash them; it may not split them.
pub fn pin_bytes_sha256(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(bytes);
    h.finalize().iter().fold(String::new(), |mut s, b| {
        use std::fmt::Write as _;
        let _ = write!(s, "{b:02x}");
        s
    })
}

/// A JSON string literal, escaped by the library rather than by hand.
///
/// The STRUCTURE below is composed by hand, with explicit key order, rather than through
/// `serde_json::json!`. That is not stylistic: `serde_json`'s object type is a `BTreeMap`
/// by default and an insertion-ordered `IndexMap` under the `preserve_order` cargo flag,
/// and cargo unifies those flags for build-dependencies and dependencies SEPARATELY. This
/// file compiles into both `build.rs` and the lib, so relying on the map type would let the
/// two halves emit different bytes for the same input — a byte-exact freshness check that
/// fails depending on which half ran it. Escaping is delegated because escaping is the part
/// that is easy to get subtly wrong; ordering is owned because ordering is the part that
/// must not depend on a build flag.
fn jstr(s: &str) -> String {
    serde_json::Value::String(s.to_string()).to_string()
}

/// Generate the artefact: **the one parse**, exported (#214 / INV-1, INV-2).
///
/// For every discovered recipe, in sorted order: the canonical-bytes precondition FIRST,
/// then the declared ecosystem, then the exact pins, then the declared pin sources. The
/// precondition being first is what makes this function a second unconditional route to
/// INV-3 — you cannot obtain an artefact for a recipe whose bytes were never checked.
///
/// Returns the artefact's exact bytes, or the first recipe's diagnosis.
pub fn generate_env_pin_artefact(env_root: &Path) -> Result<String, String> {
    let mut dirs: Vec<std::path::PathBuf> = std::fs::read_dir(env_root)
        .map_err(|e| {
            format!(
                "cannot read env recipe tree `{}`: {e}",
                env_root.display()
            )
        })?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.is_dir() && p.join(ENV_RECIPE_MARKER).exists())
        .collect();
    // Sorted, so the bytes do NOT depend on the order the filesystem hands back entries.
    // A generated file whose content depends on readdir order is a generated file that goes
    // spuriously stale on another machine.
    dirs.sort();

    // ANTI-VACUITY. An empty recipe tree would produce a well-formed artefact describing
    // nothing, against which every consumer's floor would be compared and every one would
    // fail — but the FIRST thing to say is that discovery collapsed, not that a floor moved.
    if dirs.is_empty() {
        return Err(format!(
            "no env recipe discovered under `{}` — the discovery walk collapsed, and this \
             generator was about to export a parse of nothing",
            env_root.display()
        ));
    }

    let mut recipes: Vec<String> = Vec::new();
    for dir in &dirs {
        let id = pkg_name(dir);
        let pin_path = dir.join(ENV_PIN_FILE);
        let bytes = std::fs::read(&pin_path).map_err(|e| {
            format!(
                "env recipe `{id}` has no readable `{ENV_PIN_FILE}` ({e}) — an env whose \
                 installed set is not pinned cannot be checked against any declaration"
            )
        })?;
        let text = String::from_utf8(bytes.clone()).map_err(|e| {
            format!("env recipe `{id}`: `{ENV_PIN_FILE}` is not valid UTF-8 ({e})")
        })?;

        // THE PRECONDITION, FIRST — before any parsing, by construction rather than by
        // remembering to call it (INV-3).
        assert_canonical_pin_bytes(&text).map_err(|e| format!("env recipe `{id}`: {e}"))?;

        // ORDER MATTERS: the ecosystem decides how pin NAMES are folded, so it is read
        // before the pins. Reading it after would fold under some default first, and no
        // downstream comparison can recover a name that has already been lowercased.
        let ecosystem =
            parse_env_pin_ecosystem(&text).map_err(|e| format!("env recipe `{id}`: {e}"))?;
        let pins = parse_env_pins_detailed(&text, ecosystem)
            .map_err(|e| format!("env recipe `{id}`: {e}"))?;
        let sources =
            parse_env_pin_sources(&text).map_err(|e| format!("env recipe `{id}`: {e}"))?;

        if pins.is_empty() {
            return Err(format!(
                "env recipe `{id}`'s `{ENV_PIN_FILE}` yielded ZERO pins — either the recipe \
                 installs nothing, or every line was read as a comment. Both are refused: a \
                 recipe with no pins satisfies every declaration vacuously"
            ));
        }

        // THE `# import=` REQUIREMENT, enforced HERE rather than in the low-level parser
        // (DEC-4 / `EnvPinDetail::import`). This runs over the REAL recipe tree on the
        // unconditional build path, so a recipe without the token is still a build error —
        // while the ~20 fixtures that call the parser to ask "is this an exact pin?" keep
        // working, because they are not recipes.
        for p in &pins {
            if p.import.is_none() {
                return Err(format!(
                    "env recipe `{id}`, `{ENV_PIN_FILE}` line {}: `{}` carries no \
                     `# import=<module>` token. The import name is not derivable from the \
                     distribution name, and the smoke-correspondence guard is checked \
                     against it — a pin with no token is a pin nothing verifies loads",
                    p.line, p.raw_name
                ));
            }
        }

        let pin_rows: Vec<String> = pins
            .iter()
            .map(|p| {
                format!(
                    "      {{\n        \"name\": {},\n        \"raw_name\": {},\n        \
                     \"version\": {},\n        \"import\": {},\n        \"line\": {},\n        \
                     \"byte_offset\": {},\n        \"byte_len\": {},\n        \
                     \"line_sha256\": {},\n        \"raw_name_span\": [{}, {}],\n        \
                     \"version_span\": [{}, {}],\n        \"import_span\": [{}, {}]\n      }}",
                    jstr(&p.name),
                    jstr(&p.raw_name),
                    jstr(&p.version),
                    jstr(p.import.as_deref().unwrap_or_default()),
                    p.line,
                    p.byte_offset,
                    p.byte_len,
                    jstr(&pin_bytes_sha256(
                        &bytes[p.byte_offset..p.byte_offset + p.byte_len]
                    )),
                    p.raw_name_span.0,
                    p.raw_name_span.1,
                    p.version_span.0,
                    p.version_span.1,
                    p.import_span.map_or(0, |s| s.0),
                    p.import_span.map_or(0, |s| s.1),
                )
            })
            .collect();
        let source_rows: Vec<String> = sources
            .iter()
            .map(|s| {
                format!(
                    "      {{\n        \"class\": {},\n        \"coordinate\": {},\n        \
                     \"line\": {},\n        \"byte_offset\": {},\n        \"byte_len\": {},\n        \
                     \"line_sha256\": {},\n        \"coordinate_span\": [{}, {}]\n      }}",
                    jstr(s.class.token()),
                    jstr(&s.coordinate),
                    s.line,
                    s.byte_offset,
                    s.byte_len,
                    jstr(&pin_bytes_sha256(
                        &bytes[s.byte_offset..s.byte_offset + s.byte_len]
                    )),
                    s.coordinate_span.0,
                    s.coordinate_span.1,
                )
            })
            .collect();

        recipes.push(format!(
            "    {}: {{\n      \"ecosystem\": {},\n      \"pin_file_sha256\": {},\n      \
             \"pin_sources\": [\n{}\n      ],\n      \"pins\": [\n{}\n      ]\n    }}",
            jstr(&id),
            jstr(ecosystem.token()),
            jstr(&pin_bytes_sha256(&bytes)),
            source_rows.join(",\n"),
            pin_rows.join(",\n"),
        ));
    }

    // NO TOTAL, NO COUNT, NO CARDINALITY — DEC-12 / INV-5, and it is the one thing about
    // this file's shape that is a REFUSAL rather than an omission. A count carried here
    // moves with the pin file, so a floor compared against it would be a derivation whose
    // two sides read the same source: a tautology in exactly the deletion direction the
    // floors exist for (`docs/design/derived-guards.md` §4). This design makes that mistake
    // newly cheap, so the artefact declines to supply the temptation. A consumer computes
    // `len(pins)` and compares it against a literal it holds itself.
    Ok(format!(
        "{{\n  \"$generated\": {{\n    \"by\": \"build_helper::processor_manifest::generate_env_pin_artefact\",\n    \
         \"regenerate_with\": {},\n    \"design\": \"docs/design/pin-file-single-parse.md\",\n    \
         \"do_not_edit\": \"This file is the build gate's exported parse of every env recipe's \
requirements.txt. Editing it by hand is refused at `cargo check`; edit the pin file and regenerate.\"\n  }},\n  \
         \"schema_version\": {},\n  \"recipes\": {{\n{}\n  }}\n}}\n",
        jstr(ENV_PIN_REGEN_CMD),
        ENV_PIN_ARTEFACT_SCHEMA,
        recipes.join(",\n"),
    ))
}

/// The freshness gate (#214 / INV-4) — and, under [`ENV_PIN_REGEN_VAR`], the writer.
///
/// ## Why byte-exact and not semantic
///
/// A semantic comparison would need a second JSON reader on the build side and would
/// tolerate formatting drift. Byte-exactness makes the committed file *the* output of the
/// generator and nothing else, which is what lets a consumer trust it without re-deriving.
///
/// ## Why WRITING lives in the same function
///
/// Because the alternative is a bootstrap deadlock. If the check were the only path, a
/// stale artefact would fail the build, and the build is what regenerates it — you could
/// not get out. Gating the write on an env var nothing but `just env-pins-regen` sets keeps
/// the default path read-only (asserted by a test), while leaving an escape that does not
/// require anyone to hand-edit a generated file.
pub fn env_pin_artefact_check_or_write(env_root: &Path) -> Result<(), String> {
    let fresh = generate_env_pin_artefact(env_root)?;
    let path = env_root.join(ENV_PIN_ARTEFACT);

    if std::env::var(ENV_PIN_REGEN_VAR).is_ok_and(|v| v == "1") {
        // SAY SO, LOUDLY. This is the one path where a build MUTATES a tracked file, and a
        // blind audit pointed out the consequence of leaving the variable exported in a
        // shell: the byte-compare below — the only thing in the repo that catches a
        // hand-edited artefact — silently stops running, and `just check` quietly starts
        // rewriting a committed file. A `cargo:warning=` is printed on every build so the
        // state cannot be invisible.
        println!(
            "cargo:warning={ENV_PIN_REGEN_VAR}=1 — WRITING `{}` instead of checking it. The \
             freshness gate is OFF for this build; unset the variable to restore it.",
            path.display()
        );
        return std::fs::write(&path, &fresh)
            .map_err(|e| format!("cannot write `{}`: {e}", path.display()));
    }

    let committed = std::fs::read_to_string(&path).map_err(|e| {
        format!(
            "the generated env-pin artefact `{}` is missing or unreadable ({e}). It is the \
             build gate's exported parse, and every consumer outside this gate reads it \
             instead of parsing `{ENV_PIN_FILE}` — see `docs/design/pin-file-single-parse.md`. \
             Regenerate it with `{ENV_PIN_REGEN_CMD}`",
            path.display()
        )
    })?;

    if committed != fresh {
        return Err(format!(
            "the generated env-pin artefact `{}` is STALE — it does not match a fresh parse \
             of the recipe tree. A stale artefact is a disagreement between the gate and \
             every consumer that reads it, which is the whole defect class #214 exists to \
             close, one level up. Do NOT hand-edit it: change the pin file if the pins are \
             wrong, then run `{ENV_PIN_REGEN_CMD}`. ({} committed bytes vs {} fresh)",
            path.display(),
            committed.len(),
            fresh.len()
        ));
    }
    Ok(())
}

// ─────────────────────── THE EXPORTED PARSE, read back ───────────────────────
//
// The Rust-side consumer's view. Note what is NOT here: any function that turns pin-file
// bytes into pin data. A consumer gets `serde_json` to do its reading — a LIBRARY parser
// for a format with no line rule, no comment rule and no whitespace-token rule — which is
// the whole point of §2. A consumer that hand-rolled a JSON reader would have recreated the
// defect in a new format.

/// One pin, as a consumer of the artefact sees it.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct ArtefactPin {
    /// Folded under the recipe's declared ecosystem.
    pub name: String,
    /// Exactly as the pin file spells it.
    pub raw_name: String,
    pub version: String,
    /// The `# import=<module>` token. Not `Option`: the generator refuses a recipe whose
    /// pins do not all carry one, so a consumer never has to handle the partial case.
    pub import: String,
    pub line: usize,
    /// Where this pin's LINE lives in the pin file, and the SHA-256 of those exact bytes.
    ///
    /// **These exist for the PYTHON lane and are unused on this side, deliberately.**
    /// `_lib/env_pins.py` verifies every row by indexing and hashing at these coordinates,
    /// because `just check-py` never runs cargo and therefore never sees `build.rs`'s
    /// byte-compare. The Rust consumers do not repeat that work: `cargo test` runs
    /// `build.rs` first, so by the time any of them reads the artefact it has already been
    /// re-derived and compared byte for byte — a strictly stronger check than these
    /// coordinates give.
    ///
    /// Said plainly because the first version of this comment claimed "a consumer verifies
    /// the row by indexing and hashing" as a property of the FORMAT, and a blind audit
    /// pointed out it held in exactly one of the two languages.
    pub byte_offset: usize,
    pub byte_len: usize,
    pub line_sha256: String,
    /// `[offset, length]` of each field's own bytes in the pin file — see
    /// [`EnvPinDetail::raw_name_span`].
    ///
    /// **Like the line coordinates above, these are for the PYTHON lane and unused here.**
    /// `_lib/env_pins.py` checks each field by exact equality at these coordinates, and
    /// additionally requires them to be contained in the row's own line and adjacent across
    /// the `==`. The Rust consumers do not: `cargo test` runs `build.rs` first, so the
    /// artefact has already been re-derived and byte-compared, which is strictly stronger.
    /// (The `byte_offset` block above was corrected to say this in round 6; this sibling
    /// field had kept the uncorrected framing, which a blind audit noticed.)
    pub raw_name_span: (usize, usize),
    pub version_span: (usize, usize),
    pub import_span: (usize, usize),
}

/// One declared resolution coordinate, as a consumer sees it.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct ArtefactPinSource {
    pub class: String,
    pub coordinate: String,
    pub line: usize,
    pub byte_offset: usize,
    pub byte_len: usize,
    pub line_sha256: String,
    pub coordinate_span: (usize, usize),
}

/// One recipe's exported parse.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct ArtefactRecipe {
    pub ecosystem: String,
    /// SHA-256 of the pin file's bytes at generation time — see [`pin_bytes_sha256`].
    pub pin_file_sha256: String,
    pub pin_sources: Vec<ArtefactPinSource>,
    pub pins: Vec<ArtefactPin>,
}

/// The artefact.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct EnvPinArtefact {
    pub schema_version: u32,
    pub recipes: std::collections::BTreeMap<String, ArtefactRecipe>,
}

impl EnvPinArtefact {
    /// One recipe's parse, or `None`. Callers turn `None` into a REFUSAL naming the recipe
    /// — never into "no pins", which would make everything derived from it vacuous.
    pub fn get(&self, env_id: &str) -> Option<&ArtefactRecipe> {
        self.recipes.get(env_id)
    }
}

/// Read and validate the committed artefact.
///
/// Missing, malformed, wrong-schema and empty are all REFUSALS. `derived-guards.md` §3:
/// *"A skip is a skip, never a pass."*
pub fn read_env_pin_artefact(env_root: &Path) -> Result<EnvPinArtefact, String> {
    let path = env_root.join(ENV_PIN_ARTEFACT);
    let text = std::fs::read_to_string(&path).map_err(|e| {
        format!(
            "the exported pin parse `{}` is missing or unreadable ({e}) — it is what every \
             consumer outside the build gate reads instead of parsing `{ENV_PIN_FILE}` \
             (docs/design/pin-file-single-parse.md). Run `{ENV_PIN_REGEN_CMD}`",
            path.display()
        )
    })?;
    let parsed: EnvPinArtefact = serde_json::from_str(&text)
        .map_err(|e| format!("`{}` is not readable as the exported pin parse ({e}). Do not hand-edit it; run `{ENV_PIN_REGEN_CMD}`", path.display()))?;
    if parsed.schema_version != ENV_PIN_ARTEFACT_SCHEMA {
        return Err(format!(
            "`{}` declares schema_version {}, but this reader understands \
             {ENV_PIN_ARTEFACT_SCHEMA}. A reader that guessed would silently find no pins \
             and every derived floor would go quietly vacuous",
            path.display(),
            parsed.schema_version
        ));
    }
    if parsed.recipes.is_empty() {
        return Err(format!(
            "`{}` describes NO recipes. The generator refuses an empty tree, so this \
             artefact was hand-edited or truncated; run `{ENV_PIN_REGEN_CMD}`",
            path.display()
        ));
    }

    // THE FRESHNESS DIGEST LIVES HERE, not in each consumer (#214, moved after a blind
    // audit). Two consumers had opposite reasoning: `env_image.rs` digested the pin file
    // and explained why ("a guard that assumes its input is fresh because some other stage
    // should have checked is exactly the transitive-precondition shape round 4 rejected"),
    // while the dataset-conversion integration control relied on precisely that rejected
    // argument. Putting the check in the reader means neither consumer can be the one that
    // forgot.
    for (id, recipe) in &parsed.recipes {
        let pin_path = env_root.join(id).join(ENV_PIN_FILE);
        let bytes = std::fs::read(&pin_path).map_err(|e| {
            format!(
                "the exported parse describes recipe `{id}` but `{}` is unreadable ({e}) — \
                 a recipe was renamed or removed without regenerating; run \
                 `{ENV_PIN_REGEN_CMD}`",
                pin_path.display()
            )
        })?;
        let digest = pin_bytes_sha256(&bytes);
        if digest != recipe.pin_file_sha256 {
            return Err(format!(
                "the exported parse is STALE for recipe `{id}`: `{}` hashes to {digest} but \
                 the artefact records {}. Everything derived from it would be about a file \
                 that no longer exists in that form; run `{ENV_PIN_REGEN_CMD}`",
                pin_path.display(),
                recipe.pin_file_sha256
            ));
        }
    }

    // …and the OTHER direction: a recipe on disk the artefact says nothing about. Without
    // this, adding a recipe directory is invisible to every consumer of the artefact, which
    // is the "derivation blind to an addition" half of `derived-guards.md` §4.
    let on_disk: std::collections::BTreeSet<String> = std::fs::read_dir(env_root)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.is_dir() && p.join(ENV_RECIPE_MARKER).exists())
        .map(|p| pkg_name(&p))
        .collect();
    let described: std::collections::BTreeSet<String> = parsed.recipes.keys().cloned().collect();
    if on_disk != described {
        return Err(format!(
            "the exported parse and the recipe tree describe different recipe sets.\n  on \
             disk only: {:?}\n  in the artefact only: {:?}\nA recipe the artefact omits is \
             a recipe every consumer verifies nothing about; run `{ENV_PIN_REGEN_CMD}`",
            on_disk.difference(&described).collect::<Vec<_>>(),
            described.difference(&on_disk).collect::<Vec<_>>()
        ));
    }
    Ok(parsed)
}

/// Does `version` satisfy `spec` (a comma-ANDed specifier set)?
///
/// ## Why this is hand-written, and why it FAILS CLOSED
///
/// `build.rs` runs before the crate compiles and has only serde in its build-dependency
/// graph, so the reference version-comparison library is not reachable here. The subset
/// implemented is `==`, `!=`, `>=`, `>`, `<=`, `<` over dotted-numeric releases, and
/// ANYTHING else — a wildcard, a compatible-release operator, an epoch, a local version,
/// a pre-release suffix — is an ERROR naming the specifier, never a silent pass.
///
/// That direction matters. The run-time half uses the reference implementation, so the
/// two agree only if the build's subset is STRICTLY narrower than real specifier
/// semantics. Failing closed guarantees that: anything this cannot decide exactly, it
/// refuses, so the build can never accept a declaration the run time would reject.
///
/// ## The one place that guarantee does NOT hold, stated rather than assumed
///
/// Under [`VersionGrammar::RDescription`] the narrowing is no longer strict, and it cannot
/// be: `0.1-40` means release `0.1.40` to R and `0.1.post40` to PEP 440, so this gate
/// answers `true` for `0.1-40` against `==0.1.40` where `packaging` answers `false`. That
/// is not a defect to fix here — the two languages genuinely disagree, and reading an R
/// version by PEP 440's rules is the wrong answer, not the safe one.
///
/// It is LATENT rather than live for a concrete reason: the run-time half
/// (`packages/_lib/cyto_deps.py`) resolves versions through `importlib.metadata`, i.e. it
/// only ever sees PYTHON distributions. There is no R-side contract checker yet, so no
/// declaration written against an R recipe reaches the reference implementation at all.
/// **When one is built it must compare R versions with R's own rule** (`numeric_version` /
/// `compareVersion`), not with `packaging` — otherwise it will reject exactly the
/// declarations this gate accepts, which is the disagreement this paragraph exists to
/// hand forward. PEP 440 recipes are unaffected: they declare no grammar and keep the
/// strict narrowing above, byte for byte.
pub fn version_satisfies(version: &str, spec: &str) -> Result<bool, String> {
    version_satisfies_in(version, spec, VersionGrammar::Pep440)
}

/// [`version_satisfies`] under an explicit [`VersionGrammar`] — the form the gate calls,
/// with the grammar the RECIPE declared (derived from the recipe's declared [`EnvEcosystem`]).
pub fn version_satisfies_in(
    version: &str,
    spec: &str,
    grammar: VersionGrammar,
) -> Result<bool, String> {
    let shape = match grammar {
        VersionGrammar::Pep440 => "a plain dotted-numeric release",
        VersionGrammar::RDescription => "a plain `.`/`-` separated numeric R release",
    };
    let lhs = parse_release_in(version, grammar).ok_or_else(|| {
        format!(
            "version `{version}` is not {shape} — the build gate \
             refuses what it cannot compare exactly rather than guessing"
        )
    })?;
    let mut any = false;
    for clause in spec.split(',') {
        let clause = clause.trim();
        if clause.is_empty() {
            continue;
        }
        any = true;
        let (op, rhs_raw) = split_operator(clause).ok_or_else(|| {
            format!(
                "specifier `{clause}` uses an operator outside the supported set \
                 (==, !=, >=, >, <=, <) — the build gate fails closed on a grammar it \
                 cannot interpret exactly"
            )
        })?;
        let rhs = parse_release_in(rhs_raw, grammar).ok_or_else(|| {
            format!(
                "specifier `{clause}` compares against `{rhs_raw}`, which is not {shape} \
                 (wildcards, epochs, local versions and \
                 pre-release suffixes are refused, not guessed)"
            )
        })?;
        let ord = compare_release(&lhs, &rhs);
        let ok = match op {
            "==" => ord == std::cmp::Ordering::Equal,
            "!=" => ord != std::cmp::Ordering::Equal,
            ">=" => ord != std::cmp::Ordering::Less,
            "<=" => ord != std::cmp::Ordering::Greater,
            ">" => ord == std::cmp::Ordering::Greater,
            "<" => ord == std::cmp::Ordering::Less,
            _ => unreachable!("split_operator only yields the supported set"),
        };
        if !ok {
            return Ok(false);
        }
    }
    if !any {
        return Err(format!(
            "`{spec}` declares no version constraint — an empty range would let any \
             installed version satisfy the declaration, which is the state this gate exists \
             to remove"
        ));
    }
    Ok(true)
}

/// Split a clause into its operator and the version text. Two-character operators are
/// tested first so `>=` is never read as `>` followed by `=1.0`.
fn split_operator(clause: &str) -> Option<(&str, &str)> {
    for op in ["==", "!=", ">=", "<="] {
        if let Some(rest) = clause.strip_prefix(op) {
            return Some((op, rest.trim()));
        }
    }
    for op in [">", "<"] {
        if let Some(rest) = clause.strip_prefix(op) {
            return Some((op, rest.trim()));
        }
    }
    None
}

/// `1.11.5` → `[1, 11, 5]`. `None` for anything that is not purely dotted digits — which
/// is the fail-closed edge: a suffix, a wildcard, an epoch or a local version all land
/// here and become an error rather than a comparison this cannot do correctly.
///
/// Under [`VersionGrammar::RDescription`] the separator set widens to `.` and `-`, which
/// is R's own rule (`numeric_version` treats the two identically) — so `1.7-6` reads as
/// `[1, 7, 6]`. The digits-only requirement per segment is unchanged in BOTH grammars, so
/// the widening admits exactly R's release shape and nothing else.
fn parse_release_in(v: &str, grammar: VersionGrammar) -> Option<Vec<u64>> {
    let v = v.trim();
    if v.is_empty() {
        return None;
    }
    let is_sep = |c: char| c == '.' || (grammar == VersionGrammar::RDescription && c == '-');
    let mut out = Vec::new();
    for seg in v.split(is_sep) {
        if seg.is_empty() || !seg.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        out.push(seg.parse::<u64>().ok()?);
    }
    Some(out)
}

/// Compare two releases, zero-padding the shorter — so `1.11` and `1.11.0` are EQUAL and
/// `>=1.11` admits `1.11.5`. Without the padding a declaration written at two segments
/// would silently exclude every three-segment release, which is how most of them are
/// published.
fn compare_release(a: &[u64], b: &[u64]) -> std::cmp::Ordering {
    let n = a.len().max(b.len());
    for i in 0..n {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        match x.cmp(&y) {
            std::cmp::Ordering::Equal => continue,
            other => return other,
        }
    }
    std::cmp::Ordering::Equal
}

/// One env recipe's identity + its parsed pin set.
struct EnvRecipePins {
    id: String,
    pins: Vec<EnvPin>,
    /// The packaging ecosystem this recipe's pin file DECLARES. Every comparison against
    /// this recipe's pins — the NAME fold and the VERSION reading alike — is made under
    /// it, on BOTH sides, because both sides come from this one recipe.
    ecosystem: EnvEcosystem,
}

/// Read every env recipe under `env_root` and parse its pin file.
///
/// A directory holding the recipe marker but NO pin file is an error rather than a skip:
/// an unpinned recipe is exactly the state this gate exists to end, and skipping it would
/// make the gate silently vacuous for that environment.
fn read_env_recipes(env_root: &Path) -> Result<Vec<EnvRecipePins>, String> {
    let mut out: Vec<EnvRecipePins> = Vec::new();
    let entries = std::fs::read_dir(env_root)
        .map_err(|e| format!("cannot read env recipe tree `{}`: {e}", env_root.display()))?;
    let mut dirs: Vec<std::path::PathBuf> =
        entries.filter_map(|e| e.ok().map(|e| e.path())).collect();
    dirs.sort(); // deterministic error ordering
    for dir in dirs {
        if !dir.is_dir() || !dir.join(ENV_RECIPE_MARKER).exists() {
            continue;
        }
        let id = pkg_name(&dir);
        let pin_path = dir.join(ENV_PIN_FILE);
        let text = std::fs::read_to_string(&pin_path).map_err(|e| {
            format!(
                "env recipe `{id}` has no readable `{ENV_PIN_FILE}` ({e}) — an env whose \
                 installed set is not pinned cannot be checked against any declaration, \
                 and an unenforceable declaration is the state this gate removes"
            )
        })?;
        // FIRST, before any parsing: the bytes must be ones every reader of this file
        // agrees about. See `assert_canonical_pin_bytes` — this is what makes the
        // whitespace-divergence class unrepresentable instead of repeatedly patched.
        assert_canonical_pin_bytes(&text).map_err(|e| format!("env recipe `{id}`: {e}"))?;
        // ORDER MATTERS: the ecosystem decides how the pin NAMES are folded, so it must
        // be read before the pins are parsed. Reading it after would parse them under
        // some default first, and no downstream comparison can recover a name that has
        // already been lowercased.
        let ecosystem =
            parse_env_pin_ecosystem(&text).map_err(|e| format!("env recipe `{id}`: {e}"))?;
        let pins =
            parse_env_pins_in(&text, ecosystem).map_err(|e| format!("env recipe `{id}`: {e}"))?;
        // Parsed for its REFUSALS, which ARE the gate: a missing declaration, an unknown
        // class, a repeated coordinate, and above all a source that cannot make a version
        // string denote one source tree (#209). The parsed value has no consumer on this
        // side — the recipe's own installer is what resolves the coordinates — so it is
        // deliberately not carried on `EnvRecipePins`. A field nothing reads is a field
        // that can silently stop being correct.
        parse_env_pin_sources(&text).map_err(|e| format!("env recipe `{id}`: {e}"))?;
        out.push(EnvRecipePins {
            id,
            pins,
            ecosystem,
        });
    }
    Ok(out)
}

/// The GATE (#80 / INV-1): every `run.dependencies[]` a package declares must be
/// satisfied by EVERY env recipe's pin set.
///
/// ## Which recipes a declaration is resolved against
///
/// A contribution that DECLARES `env: X` is resolved against recipe `X` only (#189).
/// This is the relaxation the previous version of this comment prescribed, taken
/// verbatim: *"If an intentionally narrower second env ever lands, the right relaxation
/// is for a contribution to DECLARE the env it targets, not for this gate to guess."*
/// A declared env with no matching recipe is a hard error — never a skip, which would
/// report PASS for a declaration checked against nothing.
///
/// A contribution declaring NO env is still resolved against **every** recipe. A
/// deployment picks its env at run time (`CYTO_SANDBOX_ENV_ID`), so an undeclared
/// contribution can be scheduled into any of them, and a declaration satisfiable in only
/// some is a latent run-time failure in the others — precisely the failure class this
/// moves to build time. Requiring every recipe remains the fail-closed reading for that
/// case, and keeps every package shipping today gated exactly as strictly as before,
/// with zero manifest edits (DEC-2). Narrowing the env-less case to the deployment
/// default instead would have silently weakened the gate for all of them.
fn lint_declared_dependencies(
    parsed: &[(String, ProcessorManifest)],
    env_root: &Path,
) -> Result<(), String> {
    // Nothing declared anywhere ⇒ nothing to resolve. Checked first so a tree with no
    // declarations does not require an env tree to exist at all.
    let any_declared = parsed.iter().any(|(_, m)| {
        m.contributes
            .analyses
            .iter()
            .any(|a| a.run.as_ref().is_some_and(|r| !r.dependencies.is_empty()))
            || m.contributes
                .converters
                .iter()
                .any(|c| !c.run.dependencies.is_empty())
            // #189 — a declared `env` is itself something to resolve, dependencies or
            // not. Without this clause a manifest whose only new content is
            // `env: ghost-env` skipped the whole gate, so a typo'd env passed the build
            // and failed at PULL time inside a user's job — the failure class this gate
            // exists to move to build time.
            || m.contributes.analyses.iter().any(|a| a.env.is_some())
            || m.contributes.converters.iter().any(|c| c.env.is_some())
    });
    // BEFORE the short-circuit. The bytes of every recipe are checked whether or not any
    // package declares anything — see `assert_every_recipe_canonical` for why a
    // precondition must not be contingent on the question that happened to reach it.
    assert_every_recipe_canonical(env_root)?;

    if !any_declared {
        return Ok(());
    }

    let recipes = read_env_recipes(env_root)?;
    if recipes.is_empty() {
        return Err(format!(
            "a package declares `run.dependencies` or an `env` but no env recipe was \
             found under `{}` — there is nothing to resolve the declaration against",
            env_root.display()
        ));
    }

    for (name, m) in parsed {
        // Both contribution kinds carry a `run` block and both execute in the env, so
        // both are gated — checking only one would leave the other able to declare
        // something unenforceable.
        let declared = m
            .contributes
            .analyses
            .iter()
            // A run-LESS analysis is INCLUDED (with an empty dependency list) rather than
            // filtered out: it can still declare an `env`, and `declared_env_for_analysis`
            // deliberately resolves one for it at runtime, so the build must validate that
            // env or the two disagree about what is checkable.
            .map(|a| {
                let deps: &[DependencyRequirement] = a
                    .run
                    .as_ref()
                    .map(|r| r.dependencies.as_slice())
                    .unwrap_or(&[]);
                (a.id.as_str(), "analysis", deps, a.env.as_deref())
            })
            .chain(m.contributes.converters.iter().map(|c| {
                (
                    c.id.as_str(),
                    "converter",
                    c.run.dependencies.as_slice(),
                    c.env.as_deref(),
                )
            }));
        for (id, kind, deps, declared_env) in declared {
            // #189 — resolve against the env the contribution DECLARES, which is the
            // relaxation this gate's own doc prescribes.
            //
            // A contribution declaring NO env keeps the every-recipe fail-closed reading
            // (DEC-2): it can be scheduled into any env, so a declaration satisfiable in
            // only some of them is exactly the latent run-time failure this gate moved to
            // build time. Narrowing the env-less case to the deployment default would
            // silently WEAKEN the gate for every package shipping today, which is the
            // opposite of the change being made.
            let scoped_recipes: Vec<&EnvRecipePins> = match declared_env {
                Some(env) => {
                    let matched: Vec<&EnvRecipePins> =
                        recipes.iter().filter(|r| r.id == env).collect();
                    if matched.is_empty() {
                        // A declared env with no recipe is a hard error, not a skip. The
                        // silent alternative — checking a declaration against nothing —
                        // would report PASS for a contribution whose dependencies were
                        // never resolved against anything at all.
                        let known: Vec<&str> = recipes.iter().map(|r| r.id.as_str()).collect();
                        return Err(scoped(
                            name,
                            format!(
                                "{kind} `{id}` declares `env: {env}`, but no env recipe \
                                 `{env}` exists under `{}` (found: {}). Add the recipe, or \
                                 correct the declared env — its `run.dependencies` cannot \
                                 be resolved against an env that does not exist",
                                env_root.display(),
                                if known.is_empty() {
                                    "none".to_string()
                                } else {
                                    known.join(", ")
                                }
                            ),
                        ));
                    }
                    matched
                }
                None => recipes.iter().collect(),
            };
            // RECIPE-MAJOR, not dep-major (#192 / DEC-2). The fold from a declared
            // library name to a comparison key is a property of the RECIPE, so it — and
            // the duplicate-declaration check built on it — has to happen inside this
            // loop. An env-LESS contribution is resolved against every recipe, and
            // folding its declarations once, under whichever ecosystem was picked as the
            // default, is exactly the "the two sides of the comparison used different
            // rules" bug this item removes. It also gets the R reading right: `Matrix`
            // and `matrix` are different packages, so declaring both is well-formed
            // against an R recipe and ambiguous against a python one, and each recipe now
            // answers for itself instead of one answer being imposed on both.
            // RECIPE-INDEPENDENT well-formedness, checked BEFORE the recipe loop.
            //
            // An empty library name is malformed whatever any recipe says, and folding it
            // is not what makes it malformed. Inside the loop it would run only while
            // `scoped_recipes` is non-empty — true today, but only because of two guards
            // several hundred lines apart (`recipes.is_empty()` and the `matched.is_empty()`
            // arm), neither local to the loop and neither documented as load-bearing for
            // it. Relaxing either to a skip would have made this refusal silently stop
            // happening. Structural beats incidental.
            for dep in deps {
                if dep.library.trim().is_empty() {
                    return Err(scoped(
                        name,
                        format!("{kind} `{id}` declares a dependency with an empty library name"),
                    ));
                }
            }
            for recipe in &scoped_recipes {
                let mut seen: Vec<String> = Vec::new();
                for dep in deps {
                    let lib = normalize_dist_name_in(&dep.library, recipe.ecosystem);
                    if lib.is_empty() {
                        return Err(scoped(
                            name,
                            format!(
                                "{kind} `{id}` declares a dependency whose library name folds \
                                 to nothing under the env recipe `{}`'s rule",
                                recipe.id
                            ),
                        ));
                    }
                    if seen.contains(&lib) {
                        return Err(scoped(
                            name,
                            format!(
                                "{kind} `{id}` declares `{lib}` twice against the env recipe \
                                 `{}` — two ranges for one library is ambiguous; state one \
                                 range",
                                recipe.id
                            ),
                        ));
                    }
                    seen.push(lib.clone());
                    let Some(pin) = recipe.pins.iter().find(|p| p.name == lib) else {
                        // NEAR-MISS FIRST (#192 / ITEM-3). Under a case-preserving recipe
                        // the overwhelmingly likely cause of a miss is a spelling, and
                        // "the recipe does NOT install scdblfinder" sends the reader to
                        // add a pin that is already there. Naming both spellings and the
                        // rule turns a confusing refusal into an instruction. The generic
                        // message is kept for the genuinely-absent case: a diagnostic
                        // that swallowed it would be worse than none.
                        let near = recipe
                            .pins
                            .iter()
                            .find(|p| p.name.eq_ignore_ascii_case(&lib) && p.name != lib);
                        if let Some(near) = near {
                            return Err(scoped(
                                name,
                                format!(
                                    "{kind} `{id}` declares the library `{lib}`, but the env \
                                     recipe `{}` pins `{}` — the two differ only in CASE, and \
                                     this recipe declares `{ENV_ECOSYSTEM_DIRECTIVE}={}`, whose \
                                     package names are case-sensitive. Correct the declaration \
                                     to `{}`. (They are not folded together on purpose: a \
                                     declaration that matched a differently-cased pin would \
                                     report green against the WRONG package, which is worse \
                                     than no pin at all.)",
                                    recipe.id,
                                    near.name,
                                    recipe.ecosystem.token(),
                                    near.name
                                ),
                            ));
                        }
                        return Err(scoped(
                            name,
                            format!(
                                "{kind} `{id}` declares the library `{lib}`, which the env \
                                 recipe `{}` does NOT install. Add it to that recipe's \
                                 `{ENV_PIN_FILE}` (and to its build-time import check), or \
                                 drop the declaration — an undeclared-but-imported library \
                                 fails inside a user's sandboxed job instead of here",
                                recipe.id
                            ),
                        ));
                    };
                    // Compared under the grammar THIS RECIPE declares, derived from the
                    // ecosystem it declares. A python recipe reads PEP 440, exactly as
                    // before; an R recipe reads R `DESCRIPTION`, so its `1.7-6`-shaped
                    // pins are comparable instead of a build error naming a grammar.
                    let ok = version_satisfies_in(
                        &pin.version,
                        &dep.version,
                        recipe.ecosystem.grammar(),
                    )
                    .map_err(|e| {
                        scoped(
                            name,
                            format!(
                                "{kind} `{id}` declares `{lib} {}`, which cannot be \
                                     resolved against the env recipe `{}`'s pin \
                                     `{lib}=={}`: {e}",
                                dep.version, recipe.id, pin.version
                            ),
                        )
                    })?;
                    if !ok {
                        return Err(scoped(
                            name,
                            format!(
                                "{kind} `{id}` declares `{lib} {}`, but the env recipe `{}` \
                                 pins `{lib}=={}` — the pinned version is OUTSIDE the \
                                 declared supported range. Either the recipe moved under a \
                                 shipped contribution, or the declaration is stale; \
                                 reconcile them before this ships",
                                dep.version, recipe.id, pin.version
                            ),
                        ));
                    }
                }
            }
        }
    }
    Ok(())
}

/// A declared `schema` (when present) must be a JSON OBJECT, and — mirroring the
/// runtime hand-rolled subset (`type`/`required`/`properties`) — a `type` must be
/// a string, `required` an array, `properties` an object. Empty / null = no
/// schema (a valid no-op validator).
fn check_schema(name: &str, dt_id: &str, schema: &serde_json::Value) -> Result<(), LintFailure> {
    if schema.is_null() {
        return Ok(());
    }
    let obj = schema.as_object().ok_or_else(|| {
        failed(
            CHECK_MALFORMED_SCHEMA,
            name,
            format!("datatype `{dt_id}` has a malformed `schema` (must be a JSON object)"),
        )
    })?;
    if let Some(t) = obj.get("type") {
        if !t.is_string() {
            return Err(failed(
                CHECK_MALFORMED_SCHEMA,
                name,
                format!("datatype `{dt_id}` has a malformed `schema`: `type` must be a string"),
            ));
        }
    }
    if let Some(r) = obj.get("required") {
        if !r.is_array() {
            return Err(failed(
                CHECK_MALFORMED_SCHEMA,
                name,
                format!("datatype `{dt_id}` has a malformed `schema`: `required` must be an array"),
            ));
        }
    }
    if let Some(p) = obj.get("properties") {
        if !p.is_object() {
            return Err(failed(
                CHECK_MALFORMED_SCHEMA,
                name,
                format!(
                    "datatype `{dt_id}` has a malformed `schema`: `properties` must be an object"
                ),
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    //! TEST-12 [acceptance] [invariant: INV-5] — the build-time manifest validator:
    //! Ok over EVERY real in-tree package, and a clear PACKAGE-SCOPED Err over each
    //! malformed fixture (unknown key / bad field type / dangling `extends` /
    //! malformed `schema`). This is the SAME `lint_processor_tree` `build.rs` calls
    //! to PANIC the build, so a green build ⇒ these fixtures would fire the panic.

    use super::*;
    use std::path::PathBuf;

    /// `src-app/server` (this crate's manifest dir), from which the real
    /// `../packages` tree + the `tests/fixtures/...` fixtures resolve.
    fn crate_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    }

    fn real_processors() -> PathBuf {
        crate_dir().join("../packages")
    }

    fn fixtures() -> PathBuf {
        crate_dir().join("tests/fixtures/processor_manifest_lint")
    }

    // ── the gate PASSES on every real, shipped package ──
    //
    // TEST-24 / TEST-31 anchor. Both were planned as a TS
    // `runtime/shippedManifests.test.ts`; this IS that test, one language over. It
    // enumerates the packages from the DIRECTORY (`lint_processor_tree`'s
    // `read_dir`), never from a written-down list, so a package added later is
    // covered on the next run rather than silently skipped — TEST-31's whole
    // clause. And the schema it parses against is the NEW one: every removed key
    // (`accepts` / `params` / `when` / `defaults` / `produces_annotations` /
    // `inStandardRecipe` / `recipeOrder` / `run.inputs` / `schedule.resources`) is
    // ABSENT from `Analysis` / `RunSpec` / `ScheduleSpec` above, all three
    // `deny_unknown_fields`, so a shipped manifest still declaring one fails HERE —
    // TEST-24's first two clauses.
    #[test]
    fn real_processor_tree_lints_clean() {
        // NON-VACUITY FLOOR. `lint_processor_tree` returns `Ok(())` over an empty
        // directory, so a re-pointed / renamed path would make this test PASS having
        // parsed nothing at all — which is precisely the failure a directory-derived
        // subject set is supposed to protect against. Count what it is about to lint,
        // by the SAME `read_dir` walk, and require the real set.
        let discovered = watched_manifest_files(&real_processors())
            .into_iter()
            .filter(|p| p.ends_with("manifest.yaml"))
            .count();
        assert!(
            discovered >= 6,
            "only {discovered} shipped manifest(s) discovered under {} — the lint below \
             would be vacuously Ok over a set this small; re-point the path rather than \
             lowering this floor",
            real_processors().display()
        );

        let res = lint_processor_tree(&real_processors());
        assert!(res.is_ok(), "real packages/ must lint clean, got: {res:?}");
    }

    // ── the gate FIRES (package-scoped Err) on each malformed fixture ──
    fn lint_fixture(sub: &str) -> Result<(), String> {
        lint_processor_tree(&fixtures().join(sub))
    }

    #[test]
    fn ok_fixture_lints_clean() {
        // A minimal WELL-FORMED package (control): proves the fixture harness is
        // sound — a failure here would mean the malformed cases pass vacuously.
        assert!(
            lint_fixture("ok").is_ok(),
            "the ok/ fixture must lint clean"
        );
    }

    #[test]
    fn unknown_key_is_rejected() {
        let err = lint_fixture("unknown_key").expect_err("an unknown key must fail the lint");
        assert!(err.contains("packages/"), "package-scoped: {err}");
        assert!(err.contains("manifest.yaml:"), "manifest-scoped: {err}");
        // serde `deny_unknown_fields` surfaces the offending key.
        assert!(
            err.to_lowercase().contains("unknown field"),
            "names the bad key: {err}"
        );
    }

    #[test]
    fn bad_field_type_is_rejected() {
        let err = lint_fixture("bad_type").expect_err("a bad field type must fail the lint");
        assert!(
            err.contains("packages/") && err.contains("manifest.yaml:"),
            "scoped: {err}"
        );
        assert!(
            err.to_lowercase().contains("invalid type"),
            "names the type error: {err}"
        );
    }

    #[test]
    fn dangling_extends_is_rejected() {
        let err =
            lint_fixture("dangling_extends").expect_err("a dangling extends must fail the lint");
        assert!(
            err.contains("packages/") && err.contains("manifest.yaml:"),
            "scoped: {err}"
        );
        assert!(
            err.contains("dangling `extends`"),
            "names the dangling extends: {err}"
        );
    }

    #[test]
    fn malformed_schema_is_rejected() {
        let err =
            lint_fixture("malformed_schema").expect_err("a malformed schema must fail the lint");
        assert!(
            err.contains("packages/") && err.contains("manifest.yaml:"),
            "scoped: {err}"
        );
        assert!(
            err.contains("malformed `schema`"),
            "names the schema error: {err}"
        );
    }

    // ── B2: a SELF-EXTEND (`id extends id`) fails the build (was: runtime-only) ──
    #[test]
    fn self_extend_is_rejected() {
        let err = lint_fixture("self_extend").expect_err("a self-extend must fail the lint");
        assert!(
            err.contains("packages/") && err.contains("manifest.yaml:"),
            "scoped: {err}"
        );
        assert!(
            err.contains("cyclic / self-referential"),
            "names the cycle: {err}"
        );
    }

    // ── B2: an EXTENDS CYCLE (a → b → a) fails the build (was: runtime-only) ──
    #[test]
    fn extends_cycle_is_rejected() {
        let err = lint_fixture("cycle").expect_err("an extends cycle must fail the lint");
        assert!(
            err.contains("packages/") && err.contains("manifest.yaml:"),
            "scoped: {err}"
        );
        assert!(
            err.contains("cyclic / self-referential"),
            "names the cycle: {err}"
        );
    }

    // ── B4: a DUPLICATE datatype id across packages fails the build (was: dedup) ──
    #[test]
    fn duplicate_datatype_id_is_rejected() {
        let err = lint_fixture("duplicate_id").expect_err("a duplicate id must fail the lint");
        assert!(
            err.contains("packages/") && err.contains("manifest.yaml:"),
            "scoped: {err}"
        );
        assert!(
            err.contains("duplicate datatype id"),
            "names the duplicate: {err}"
        );
    }

    // ── B3: a TYPO inside a now-typed sub-key (`axes[].key_labal`) fails the build ──
    #[test]
    fn subkey_typo_is_rejected() {
        let err = lint_fixture("subkey_typo").expect_err("a sub-key typo must fail the lint");
        assert!(
            err.contains("packages/") && err.contains("manifest.yaml:"),
            "scoped: {err}"
        );
        // `DcAxisSpec` deny_unknown_fields surfaces the offending key.
        assert!(
            err.to_lowercase().contains("unknown field"),
            "names the bad key: {err}"
        );
    }

    // ── B1: the per-file rerun-if-changed set covers every real manifest.yaml ──
    #[test]
    fn watched_files_cover_every_real_manifest() {
        let watched = watched_manifest_files(&real_processors());
        // Every package's manifest.yaml is watched (so an IN-PLACE edit re-fires the
        // gate under incremental builds), and the set is non-empty.
        assert!(!watched.is_empty(), "watched set must not be empty");
        assert!(
            watched.iter().all(|p| p.exists()),
            "every watched path must exist: {watched:?}"
        );
        let manifests = watched
            .iter()
            .filter(|p| p.ends_with("manifest.yaml"))
            .count();
        assert!(
            manifests >= 6,
            "expected ≥6 package manifests watched, got {manifests}: {watched:?}"
        );
    }

    // ═══════════════════ S1 / ITEM-2 — per-package validation ═══════════════════
    //
    // TEST anchors for `lint_processor_package`: it runs the IDENTICAL validator
    // body as `lint_processor_tree` (INV-8) over ONE package dir, returning a
    // package-scoped Err (skip-on-error at the runtime scan, S4) or Ok.

    /// Point `lint_processor_package` at ONE package dir `<sub>/<pkg>` under the
    /// fixtures root (the runtime scan validates a single folder package).
    fn lint_package(sub: &str, pkg: &str) -> Result<(), String> {
        lint_processor_package(&fixtures().join(sub).join(pkg))
    }

    // ── a WELL-FORMED single package → Ok ──
    #[test]
    fn package_ok_lints_clean() {
        assert!(
            lint_package("ok", "goodpkg").is_ok(),
            "a well-formed single package must lint clean"
        );
    }

    // ── an unknown/typo'd key in ONE package → package-scoped Err ──
    #[test]
    fn package_unknown_key_is_rejected() {
        let err = lint_package("unknown_key", "badpkg")
            .expect_err("an unknown key must fail the per-package lint");
        assert!(
            err.contains("packages/") && err.contains("manifest.yaml:"),
            "scoped: {err}"
        );
        assert!(
            err.to_lowercase().contains("unknown field"),
            "names the bad key: {err}"
        );
    }

    // ── a bad field TYPE in ONE package → package-scoped Err ──
    #[test]
    fn package_bad_type_is_rejected() {
        let err = lint_package("bad_type", "badpkg")
            .expect_err("a bad field type must fail the per-package lint");
        assert!(
            err.contains("packages/") && err.contains("manifest.yaml:"),
            "scoped: {err}"
        );
        assert!(
            err.to_lowercase().contains("invalid type"),
            "names the type error: {err}"
        );
    }

    // ── a dangling `extends` in ONE package → package-scoped Err (resolved against
    // roots ∪ THIS package's own ids). ──
    #[test]
    fn package_dangling_extends_is_rejected() {
        let err = lint_package("dangling_extends", "badpkg")
            .expect_err("a dangling extends must fail the per-package lint");
        assert!(
            err.contains("packages/") && err.contains("manifest.yaml:"),
            "scoped: {err}"
        );
        assert!(
            err.contains("dangling `extends`"),
            "names the dangling extends: {err}"
        );
    }

    // ── a converter with an EMPTY `run.entry` in ONE package → package-scoped Err ──
    #[test]
    fn package_missing_run_entry_is_rejected() {
        let err = lint_package("missing_entry", "badpkg")
            .expect_err("an empty run.entry must fail the per-package lint");
        assert!(
            err.contains("packages/") && err.contains("manifest.yaml:"),
            "scoped: {err}"
        );
        assert!(
            err.contains("empty `run.entry`"),
            "names the empty entry: {err}"
        );
    }

    // ── a contribution CLAIMING a RESERVED app-owned `run.entry` → package-scoped Err.
    //
    // artifact-model ITEM-18. The gate is dispatched by `code_ref` alone, so before the
    // resolver's reserved-first ordering a declaration of `entry: verify_conformance.py`
    // got a CONTRIBUTED package's bytes run as the framework's conformance suite. This is
    // the declaration half of that fix: it is rejected here, at the same boundary that
    // rejects an empty `run.entry`, at BOTH the build gate and the runtime per-package
    // scan (a dropped package that fails the lint is SKIPPED, so it never even loads).
    //
    // Asserted on BOTH entry points because they are the two different exposures: the
    // whole-tree gate is what an in-repo claim meets, the per-package scan is what a
    // runtime drop-in meets, and the drop-in needs no diff at all to arrive. ──
    #[test]
    fn reserved_run_entry_claim_is_rejected() {
        for err in [
            lint_fixture("reserved_entry").expect_err("whole-tree gate must reject the claim"),
            lint_package("reserved_entry", "badpkg")
                .expect_err("per-package scan must reject the claim"),
        ] {
            assert!(
                err.contains("packages/") && err.contains("manifest.yaml:"),
                "scoped: {err}"
            );
            assert!(err.contains("RESERVED"), "names the reason: {err}");
            assert!(
                err.contains("verify_conformance.py"),
                "names the claimed entry: {err}"
            );
        }
        // NEGATIVE CONTROL: an ordinary (non-reserved) `run.entry` is untouched by the
        // rule — `ok/goodpkg` declares `compute/demo.py`, one path component away from the
        // reserved `compute/demo-analysis.py`, and must still lint clean. Without this the
        // check would pass just as well if it rejected every declared entry.
        assert!(
            lint_package("ok", "goodpkg").is_ok(),
            "a non-reserved run.entry must still lint clean"
        );
        assert!(
            !RESERVED_ENTRY_CODE_REFS.contains(&"compute/demo.py"),
            "the negative control's entry must not itself be reserved"
        );
    }

    // ── a missing manifest.yaml (not a package) → package-scoped read Err ──
    #[test]
    fn package_missing_manifest_is_rejected() {
        // The fixtures root itself has no `manifest.yaml`.
        let err = lint_processor_package(&fixtures())
            .expect_err("a dir with no manifest.yaml must fail the per-package lint");
        assert!(
            err.contains("cannot read:"),
            "package-scoped read error: {err}"
        );
    }

    // ═══════════════════ S1 / INV-8 — SINGLE-SOURCE anchor ═══════════════════
    //
    // Both boundaries compile the SAME `build_helper/processor_manifest.rs`:
    // `build.rs` `#[path]`-includes it (via `build_helper/mod.rs`) for the
    // whole-tree gate, and `src/lib.rs` `#[path]`-includes the SAME file as a real
    // `pub mod processor_manifest_lint`. This test binds both entry points to their
    // exact `fn(&Path) -> Result<(), String>` signatures — it only compiles when
    // both are real, callable fns in the lib-compiled module (NOT `#[cfg(test)]`-
    // gated away), so a green build ⇒ build & load resolve to ONE validator.
    #[test]
    fn single_source_entry_points_are_callable_fns() {
        let _tree: fn(&Path) -> Result<(), String> = lint_processor_tree;
        let _pkg: fn(&Path) -> Result<(), String> = lint_processor_package;
        // #190/#197: the runtime scan calls the DETAILED entry point (the one that carries
        // the stable check id into the boot rejection report). Bind it here too, so the
        // single-source guarantee covers the entry point that is actually on the load path
        // — binding only the `String` wrapper would let the detailed one be `#[cfg(test)]`-
        // gated away or diverge onto a second validator without this test noticing.
        let _pkg_detailed: fn(&Path) -> Result<(), LintFailure> = lint_processor_package_detailed;
        // And the shared body they both delegate to.
        let _body: fn(&[(String, ProcessorManifest)]) -> Result<(), LintFailure> = validate_parsed;
    }

    // ── TEST-2 [covers: ITEM-1] — the build-lint half of the sections parser pair ──
    //
    // The pairing is what matters: this block is `deny_unknown_fields` and `build.rs`
    // PANICS on it, so a manifest declaring `contributes.sections` while only the
    // RUNTIME parser knows the key is a broken build for everyone on the branch, not a
    // failing test. Accepting the key and still refusing an unknown sibling are the two
    // halves; asserting only the first would pass with the whole denial removed.
    #[test]
    fn sections_are_accepted_by_the_build_lint() {
        assert!(
            lint_fixture("sections_ok").is_ok(),
            "a package contributing ONLY sections must lint clean: {:?}",
            lint_fixture("sections_ok")
        );
    }

    // ── the fixture's CLAIM, made mechanical ──
    //
    // `sections_ok` says it "exercises every declared section key plus the
    // capability-only selector". For most of its life it declared `capabilities`
    // ALONE, so `sections_are_accepted_by_the_build_lint` survived deleting
    // `type_id` / `subtypes_of` / `excludes` from this lint's `SectionSelector` —
    // and because the struct is `deny_unknown_fields` and `build.rs` PANICS on it,
    // that deletion would have broken the build for the first package to declare
    // one, with the whole unit tier green.
    //
    // The sibling superset test compares TOP-LEVEL `contributes` keys only and does
    // not recurse, so it cannot see this. Derive the required set from the RUNTIME
    // `SectionSelector`'s own schema and require the fixture text to spell each one.
    //
    // RED ON REVERT: drop a selector key from the fixture (or from the runtime type
    // without adding it here) and this fails, naming the key.
    #[test]
    fn every_section_selector_key_is_exercised_by_the_fixture() {
        let schema = schemars::schema_for!(crate::modules::extensions::types::SectionSelector);
        let json = serde_json::to_value(&schema).expect("schema serializes");
        let props = json
            .get("properties")
            .and_then(|p| p.as_object())
            .expect("`SectionSelector` is an object schema with properties");
        assert!(
            props.len() >= 4,
            "NON-VACUITY FLOOR: only {} selector key(s) discovered — the loop below would \
             prove nothing. Re-derive the schema rather than lowering this.",
            props.len()
        );

        let fixture = fixtures().join("sections_ok/sectionpkg/manifest.yaml");
        let text = std::fs::read_to_string(&fixture)
            .unwrap_or_else(|e| panic!("read {}: {e}", fixture.display()));
        // Only the `applies_to` selectors count — a key named in the file's prose must
        // not certify the fixture.
        let parsed: ProcessorManifest =
            serde_norway::from_str(&text).expect("the fixture parses under the build lint");
        let declared: Vec<&SectionSelector> = parsed
            .contributes
            .sections
            .iter()
            .flat_map(|s| s.applies_to.iter())
            .collect();
        assert!(
            !declared.is_empty(),
            "the fixture declares no `applies_to` selector at all"
        );
        // The required SET is derived from the schema; whether a given key is EXERCISED has to
        // be read off the parsed selector, which is a typed struct — so this arm list is the
        // one hand-maintained part, and `_ => false` makes it FAIL CLOSED. The message says so,
        // because the obvious reading of the failure ("edit the fixture") cannot clear it for a
        // key that has no arm here.
        let spelled = |key: &str| -> Option<bool> {
            match key {
                "type_id" => Some(declared.iter().any(|s| s.type_id.is_some())),
                "subtypes_of" => Some(declared.iter().any(|s| s.subtypes_of.is_some())),
                "capabilities" => Some(declared.iter().any(|s| !s.capabilities.is_empty())),
                "excludes" => Some(declared.iter().any(|s| !s.excludes.is_empty())),
                _ => None,
            }
        };
        for key in props.keys() {
            match spelled(key) {
                Some(true) => {}
                Some(false) => panic!(
                    "`SectionSelector.{key}` exists on the RUNTIME type but no `applies_to` entry \
                     in {} exercises it — so `sections_are_accepted_by_the_build_lint` would stay \
                     green with `{key}` deleted from this lint, and `build.rs` would panic for the \
                     first package that declares it. Declare it in the fixture.",
                    fixture.display()
                ),
                None => panic!(
                    "`SectionSelector.{key}` is NEW on the runtime type and this test does not \
                     know how to tell whether the fixture exercises it. TWO edits are needed, and \
                     editing the fixture alone will NOT clear this: add a `{key}` arm to \
                     `spelled` here, AND declare `{key}` in {}.",
                    fixture.display()
                ),
            }
        }
    }

    #[test]
    fn an_unknown_contributes_sibling_is_still_refused() {
        let err = lint_fixture("sections_typo").expect_err("`sectionz:` must still fail the lint");
        assert!(
            err.contains("sectionz"),
            "the error must name the typo'd key: {err}"
        );
    }

    #[test]
    fn a_section_naming_a_producer_fails_the_build() {
        // INV-18, enforced by DECLARATION at the build gate too.
        let err = lint_fixture("sections_producer")
            .expect_err("a section whose selector names a producer must fail the lint");
        assert!(
            err.contains("analysis"),
            "the error must name the producer-naming key: {err}"
        );
    }

    // ── TEST-3 [covers: ITEM-1c] — the pairing, made mechanical ──
    #[test]
    fn build_lint_contributes_is_a_superset_of_the_runtime_contributes() {
        // The trap ITEM-1c reports, turned into a standing guard. `contributes.actions`
        // lived in the runtime parser and NOT here for the whole of S4; because this
        // struct is `deny_unknown_fields` and `build.rs` panics on it, the first package
        // to spell `contributes.actions:` would have broken the build for everyone. It
        // never fired only because none did.
        //
        // Rather than pin a written-down list (which is the same class of thing that
        // went stale), derive the runtime key set from the runtime type's own schema and
        // require this lint to accept every one of them. A key added to the runtime
        // parser and forgotten here now fails HERE instead of in someone's `build.rs`.
        let schema = schemars::schema_for!(crate::modules::extensions::types::Contributes);
        let json = serde_json::to_value(&schema).expect("schema serializes");
        let props = json
            .get("properties")
            .and_then(|p| p.as_object())
            .expect("`Contributes` is an object schema with properties");
        assert!(
            props.len() >= 6,
            "NON-VACUITY FLOOR: only {} runtime contribution key(s) discovered — the loop \
             below would prove nothing. Re-derive the schema rather than lowering this.",
            props.len()
        );

        for key in props.keys() {
            // Every runtime contribution kind is a list, so an EMPTY list is a valid
            // value for each: this isolates the question to the KEY being known.
            let yaml = format!("{key}: []\n");
            let parsed: Result<Contributes, _> = serde_norway::from_str(&yaml);
            assert!(
                parsed.is_ok(),
                "`contributes.{key}` is accepted by the RUNTIME parser but REFUSED by this \
                 build lint, which `build.rs` panics on — the first package to declare it \
                 would break the build for everyone. Add it to the lint's `Contributes`. \
                 serde said: {:?}",
                parsed.err()
            );
        }
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // #131 — the METHODS PLACEHOLDER gate.
    // ─────────────────────────────────────────────────────────────────────────────

    /// Run the REAL gate body (`parse_and_check_manifest` + `validate_parsed` — the two
    /// functions `build.rs` and the runtime per-package scan both call) over one
    /// manifest carrying the given `methods:` block.
    fn lint_methods_block(methods_yaml: &str) -> Result<(), String> {
        let indented = methods_yaml
            .lines()
            .map(|l| if l.trim().is_empty() { String::new() } else { format!("        {l}") })
            .collect::<Vec<_>>()
            .join("\n");
        let text = format!(
            "id: probe\nname: Probe\npublisher: cyto\nversion: 0.1.0\napiVersion: \"1.0\"\n\
             contributes:\n  analyses:\n    - id: probe.run\n      category: demo\n      \
             title: Probe\n      appliesTo: []\n      methods:\n{indented}\n"
        );
        // `String`-returning, unchanged: every assertion below reads the MESSAGE, and
        // #190/#197's `LintFailure` carries that message verbatim beside its check id
        // (`From<LintFailure> for String` yields the message alone). The coded half is
        // asserted by `every_stable_check_id_is_unique_and_well_formed` and by the loader's
        // report tests, so nothing here needs to change to keep the codes honest.
        let manifest = parse_and_check_manifest("probe", &text).map_err(String::from)?;
        validate_parsed(&[("probe".to_string(), manifest)]).map_err(String::from)
    }

    // TEST-2 [acceptance] [invariant: INV-1] — an UNDECLARED placeholder is a BUILD
    // FAILURE, never a verbatim render.
    //
    // THE FINDING: `methods.rs` substituted exactly one literal token, `{label}`. Five
    // shipped manifests spelled something else, and every one printed its braces into
    // the exported methods.md. Nothing caught it, because there is no reader between the
    // manifest and the scientist — the defect was invisible until a human opened a
    // bundle. The build gate is where that becomes visible.
    //
    // RED ON REVERT: delete the `check_methods_placeholders` call from `validate_parsed`
    // and every case below lints clean while shipping braces to the deliverable.
    #[test]
    fn an_undeclared_methods_placeholder_fails_the_build() {
        let err = lint_methods_block(
            "subject: { singular: row, plural: rows }\n\
             action: scored\n\
             commits: \"a column named `{name}`\"\n\
             params:\n  seed: seed\n",
        )
        .expect_err("an undeclared `{name}` must FAIL the build");
        assert!(err.contains("packages/probe"), "package-scoped: {err}");
        assert!(err.contains("probe.run"), "names the analysis: {err}");
        assert!(err.contains("methods.commits"), "names the field: {err}");
        assert!(err.contains("{name}"), "names the offending token: {err}");
        assert!(err.contains("narrated_value"), "names the fix: {err}");

        // The same token DECLARED lints clean — so the gate rejects the undeclared
        // token, not the syntax.
        assert!(
            lint_methods_block(
                "subject: { singular: row, plural: rows }\n\
                 action: scored\n\
                 commits: \"a column named `{name}`\"\n\
                 params:\n  seed: seed\n  name: narrated_value\n",
            )
            .is_ok(),
            "a DECLARED placeholder must lint clean"
        );

        // …and so does the reserved `{label}`, whatever the label param is spelled —
        // the alias that keeps every manifest authored against the old contract working.
        assert!(
            lint_methods_block(
                "subject: { singular: row, plural: rows }\n\
                 action: scored\n\
                 commits: \"a column labelled `{label}`\"\n\
                 params:\n  tag: output_label\n",
            )
            .is_ok(),
            "the reserved `{{label}}` needs no declaration"
        );
    }

    // TEST-2 (cont.) — `commits_unlabeled` is gated too (it reaches the reader on
    // exactly the runs where `commits` could not render, i.e. the ones nobody looks at
    // while developing), and an unbalanced brace is refused because no substitution can
    // ever match it.
    #[test]
    fn the_placeholder_gate_covers_both_phrases_and_refuses_a_broken_brace() {
        let err = lint_methods_block(
            "subject: { singular: row, plural: rows }\n\
             action: scored\n\
             commits_unlabeled: \"a {depth}-deep column\"\n",
        )
        .expect_err("an undeclared token in `commits_unlabeled` must FAIL");
        assert!(err.contains("methods.commits_unlabeled"), "{err}");

        // The EXPECTED message per phrase, not a disjunction. `stray_brace` runs first, so
        // a disjunction of the two diagnostics would have one dead branch and would stop
        // distinguishing them — and `{a{b}`, the one shape `stray_brace` returns None for,
        // is the ONLY remaining reader of the tokenizer's own nested/unclosed error. It is
        // listed here so that diagnostic keeps a test at all.
        for (why, phrase, needle) in [
            ("a lone opening brace", "a {label column", "not part of a `{placeholder}`"),
            ("a lone closing brace", "a la} column", "not part of a `{placeholder}`"),
            ("nested braces", "a {la{bel}} column", "not part of a `{placeholder}`"),
            ("an unclosed nested brace", "a {a{b} column", "is malformed"),
        ] {
            let err = lint_methods_block(&format!(
                "subject: {{ singular: row, plural: rows }}\n\
                 action: scored\n\
                 commits: \"{phrase}\"\n"
            ))
            .expect_err(&format!("{why} must FAIL the build"));
            assert!(err.contains(needle), "{why}: expected `{needle}` in: {err}");
            assert!(err.contains("VERBATIM"), "{why} states the consequence: {err}");
        }
    }

    // TEST-7 [acceptance] [invariant: INV-6] — the closed vocabulary SURVIVES the
    // widening. An unknown role and a typo'd reference-asset key are each still refused
    // by the build gate, and the new role + block parse.
    #[test]
    fn the_build_gate_still_rejects_an_unknown_role_and_an_unknown_asset_key() {
        let err = lint_methods_block(
            "subject: { singular: row, plural: rows }\n\
             action: scored\n\
             params:\n  x: resource_version\n",
        )
        .expect_err("an unknown param ROLE must still fail the build");
        assert!(err.contains("packages/probe"), "package-scoped: {err}");

        let err = lint_methods_block(
            "subject: { singular: row, plural: rows }\n\
             action: scored\n\
             reference_assets:\n  - { kind: k, name: n, version: v, versoin: w }\n",
        )
        .expect_err("a typo'd reference-asset key must fail the build");
        assert!(err.to_lowercase().contains("unknown field"), "names the bad key: {err}");

        // A reference asset MUST carry a version — an asset named without one is the
        // untraceability the block exists to close.
        assert!(
            lint_methods_block(
                "subject: { singular: row, plural: rows }\n\
                 action: scored\n\
                 reference_assets:\n  - { kind: k, name: n }\n",
            )
            .is_err(),
            "a reference asset with no `version` must fail the build"
        );

        // …and the widened vocabulary itself lints clean.
        assert!(
            lint_methods_block(
                "subject: { singular: row, plural: rows }\n\
                 action: scored\n\
                 params:\n  depth: narrated_value\n\
                 reference_assets:\n  - { kind: pretrained model, name: model, \
                 version: model_version, source: model_source, digest: model_sha256 }\n",
            )
            .is_ok(),
            "the new role + the new block must lint clean"
        );
    }

    // TEST-9 [acceptance] [invariant: INV-9] — BACKWARD COMPATIBILITY, which three
    // packages being built in parallel right now depend on.
    //
    // `real_processor_tree_lints_clean` already proves every SHIPPED manifest still
    // parses. This adds the case those three are authoring: a manifest written entirely
    // against the PRE-change contract — no `reference_assets`, no `narrated_value`, and
    // `{label}` spelled while the label param is named something else — must lint clean
    // and narrate unchanged.
    #[test]
    fn a_manifest_written_against_the_pre_change_contract_still_lints_clean() {
        assert!(
            lint_methods_block(
                "subject: { singular: cell, plural: cells }\n\
                 action: filtered\n\
                 commits: \"one per-cell keep-mask column, labelled `{label}`\"\n\
                 commits_unlabeled: a per-cell keep-mask column\n\
                 note: The matrix itself was not modified.\n\
                 params:\n\
                 \x20 thresholds: threshold_list\n\
                 \x20 criteria: predicate_list\n\
                 \x20 predicate: opaque_predicate\n\
                 \x20 gate: allow_list\n\
                 \x20 max_cells: subsample_cap\n\
                 \x20 seed: seed\n\
                 \x20 output_name: output_label\n\
                 allow_list_slots: [cells, cell-set]\n",
            )
            .is_ok(),
            "a manifest authored against the pre-change contract must still lint clean"
        );
    }


    // TEST-26 [ITEM-4] / ROUND-1 — the gate no longer certifies tokens the narrator can
    // never substitute.
    //
    // THE FINDING: it checked only that a token was a KEY of `methods.params`. A token
    // naming a `predicate_list` / `threshold_list` / `allow_list` / `opaque_predicate`
    // param therefore passed the build and then NEVER substituted (the narrator rejects
    // lists and objects), silently dropping the whole `committing …` clause from the
    // deliverable — the "pass the gate, then fail to substitute" outcome the gate exists
    // to prevent, arrived at THROUGH the gate.
    #[test]
    fn the_gate_refuses_a_token_whose_role_can_never_be_a_scalar() {
        for role in ["predicate_list", "threshold_list", "allow_list", "opaque_predicate"] {
            let err = lint_methods_block(&format!(
                "subject: {{ singular: row, plural: rows }}\n\
                 action: scored\n\
                 commits: \"a mask over {{x}}\"\n\
                 params:\n  x: {role}\n"
            ))
            .unwrap_err();
            assert!(err.contains("NEVER substitute"), "{role}: {err}");
            assert!(err.contains("committing"), "{role} states the consequence: {err}");
        }
        // …and every SCALAR-yielding role is accepted.
        for role in ["narrated_value", "output_label", "seed", "subsample_cap"] {
            assert!(
                lint_methods_block(&format!(
                    "subject: {{ singular: row, plural: rows }}\n\
                     action: scored\n\
                     commits: \"a mask over {{x}}\"\n\
                     params:\n  x: {role}\n"
                ))
                .is_ok(),
                "role `{role}` yields a scalar and must be substitutable"
            );
        }
    }

    // TEST-26 (cont.) / ROUND-1 — `{label}` with no `output_label` param can never resolve, so it is refused
    // rather than certified.
    #[test]
    fn the_gate_refuses_the_reserved_alias_with_nothing_to_resolve_through() {
        let err = lint_methods_block(
            "subject: { singular: row, plural: rows }\n\
             action: scored\n\
             commits: \"a column labelled `{label}`\"\n\
             params:\n  x: narrated_value\n",
        )
        .unwrap_err();
        assert!(err.contains("no `output_label` param"), "{err}");
        assert!(err.contains("can never be rendered"), "{err}");
    }

    // TEST-27 [ITEM-4] / ROUND-1 — an empty or non-identifier token gets a message an author can ACT on.
    //
    // THE FINDING: the message was templated as "Declare it by adding `<token>:
    // narrated_value`", so `{}` produced "Declare it by adding `: narrated_value`" — an
    // instruction nobody can follow, for a phrase that was harmless on `origin/main`.
    #[test]
    fn a_non_identifier_placeholder_gets_an_actionable_message() {
        for bad in ["{}", "{label:>10}", "{a b}"] {
            let err = lint_methods_block(&format!(
                "subject: {{ singular: row, plural: rows }}\n\
                 action: scored\n\
                 commits: \"an {bad} phrase\"\n\
                 params:\n  x: narrated_value\n"
            ))
            .unwrap_err();
            assert!(err.contains("is not a parameter name"), "{bad}: {err}");
            assert!(err.contains("rewrite the phrase without them"), "{bad}: {err}");
            assert!(
                !err.contains("Declare it by adding"),
                "{bad}: the message must not advise declaring an undeclarable name: {err}"
            );
        }
    }

    // TEST-28 [ITEM-4/ITEM-6] / ROUND-1 — the gate covers EVERY field the narrator prints verbatim, not only
    // `commits`.
    //
    // THE FINDING: `note` now prints on EVERY run (that is the #131 note fix), and
    // `action` / `subject` always did. A brace in any of them reached the scientist with a
    // green build — the exact #131 Defect-A shape, in the field #131 Defect-C is about.
    // They are refused rather than substituted: substituting `note` would mean a note that
    // fails to resolve is a note that is DROPPED, which is the trap the note fix removes.
    #[test]
    fn the_gate_refuses_a_brace_in_every_verbatim_narration_field() {
        for (field, yaml) in [
            ("note", "note: \"resolution {resolution} was applied\"\n"),
            ("action", "action: \"scored {x}\"\n"),
            ("subject.singular", "subject: { singular: \"row {x}\", plural: rows }\n"),
            ("subject.plural", "subject: { singular: row, plural: \"rows {x}\" }\n"),
        ] {
            // `action` / `subject` are required keys, so the offending case supplies its own.
            let base = if yaml.starts_with("subject:") {
                format!("action: scored\n{yaml}")
            } else if yaml.starts_with("action:") {
                format!("subject: {{ singular: row, plural: rows }}\n{yaml}")
            } else {
                format!("subject: {{ singular: row, plural: rows }}\naction: scored\n{yaml}")
            };
            let err = lint_methods_block(&base)
                .expect_err(&format!("a brace in `{field}` must fail the build"));
            assert!(err.contains("contains a brace"), "{field}: {err}");
            assert!(err.contains("printed VERBATIM"), "{field} states the consequence: {err}");
            assert!(
                err.contains("supported ONLY in `commits`"),
                "{field} names where substitution IS supported: {err}"
            );
        }
    }


    // TEST-35 [ITEM-4] / ROUND-2 — a brace OUTSIDE a token is refused in `commits` too.
    //
    // THE FINDING: a `}` with no `{` before it forms no token, so BOTH tokenizers were
    // silent about it and the narrator printed it verbatim — while the identical
    // character in `note` / `action` / `subject` had just been made a build failure.
    // Enforcing the rule on three fields and not on the two it was written for is the
    // shape of hole this gate exists to close.
    #[test]
    fn a_brace_outside_a_placeholder_is_refused_in_the_commit_phrases_too() {
        for phrase in ["a mask over 50}", "}", "{x} and a stray }", "} then {x}"] {
            let err = lint_methods_block(&format!(
                "subject: {{ singular: row, plural: rows }}\n\
                 action: scored\n\
                 commits: \"{phrase}\"\n\
                 params:\n  x: narrated_value\n"
            ))
            .expect_err(&format!("`{phrase}` must FAIL the build"));
            assert!(err.contains("not part of a `{placeholder}`"), "{phrase}: {err}");
            assert!(err.contains("VERBATIM"), "{phrase} states the consequence: {err}");
        }
        // A well-formed phrase is untouched, so the check rejects strays and not braces.
        assert!(
            lint_methods_block(
                "subject: { singular: row, plural: rows }\n\
                 action: scored\n\
                 commits: \"a {x}-wide column over {x} rows\"\n\
                 params:\n  x: narrated_value\n",
            )
            .is_ok(),
            "a phrase whose every brace belongs to a token must lint clean"
        );
    }

    // TEST-36 [ITEM-4] / ROUND-2, corrected in ROUND-3 — the gate treats `{label}` the way
    // the NARRATOR resolves it, and REFUSES the one shape the narrator cannot resolve
    // deterministically.
    //
    // ROUND-2 hoisted the alias check above the role check so the gate would stop refusing
    // a phrase that renders. ROUND-3's audit showed that hoist ACCEPTED the ambiguous
    // shape: a param literally named `label` alongside a DIFFERENT `output_label` param
    // makes `{label}` resolve to one param's value on one run and the other's on the next,
    // chosen by which happened to record a scalar — "a silently WRONG value, with no gate
    // able to see it", which is what the narrator's own doc says the ordering exists to
    // prevent. The gate can see it, so it refuses it.
    #[test]
    fn the_gate_refuses_an_ambiguous_label_and_accepts_an_unambiguous_one() {
        // AMBIGUOUS — both a `label` param and a separate `output_label` param.
        let err = lint_methods_block(
            "subject: { singular: row, plural: rows }\n\
             action: scored\n\
             commits: \"a column labelled `{label}`\"\n\
             params:\n  label: predicate_list\n  tag: output_label\n",
        )
        .expect_err("an ambiguous `{label}` must FAIL the build");
        assert!(err.contains("declares BOTH"), "{err}");
        assert!(err.contains("different values on different runs"), "{err}");

        // UNAMBIGUOUS — the alias alone, resolving through the one `output_label` param.
        assert!(
            lint_methods_block(
                "subject: { singular: row, plural: rows }\n\
                 action: scored\n\
                 commits: \"a column labelled `{label}`\"\n\
                 params:\n  tag: output_label\n",
            )
            .is_ok(),
            "the alias alone must lint clean"
        );
        // UNAMBIGUOUS — a param NAMED `label` that IS the output label.
        assert!(
            lint_methods_block(
                "subject: { singular: row, plural: rows }\n\
                 action: scored\n\
                 commits: \"a column labelled `{label}`\"\n\
                 params:\n  label: output_label\n",
            )
            .is_ok(),
            "the shipped spelling must lint clean"
        );
        // TWO `output_label` params is ambiguous the same way, and the gate keyed its
        // first refusal on the literal spelling `label`, so this shape slipped through:
        // `{label}` would resolve through whichever of them the role lookup reached first.
        let err = lint_methods_block(
            "subject: { singular: row, plural: rows }\n\
             action: scored\n\
             commits: \"a column labelled `{label}`\"\n\
             params:\n  a: output_label\n  b: output_label\n",
        )
        .expect_err("two output_label params must FAIL the build");
        assert!(err.contains("ONE output label"), "{err}");
        assert!(err.contains("`a`") && err.contains("`b`"), "names both: {err}");
        // …and it is a property of the DECLARATION, so it is refused even for an analysis
        // that declares no phrase at all — the role also decides which of `commits` /
        // `commits_unlabeled` the narrator uses, so the ambiguity exists without one.
        assert!(
            lint_methods_block(
                "subject: { singular: row, plural: rows }\n\
                 action: scored\n\
                 params:\n  a: output_label\n  b: output_label\n",
            )
            .is_err(),
            "the ambiguity is in the declaration, not in the phrase"
        );

        // …and with nothing to resolve through, it is still refused.
        assert!(
            lint_methods_block(
                "subject: { singular: row, plural: rows }\n\
                 action: scored\n\
                 commits: \"a column labelled `{label}`\"\n\
                 params:\n  label: predicate_list\n",
            )
            .is_err(),
            "with nothing to resolve through, the alias must still be refused"
        );
    }

    // ───────────────── #80 — the declared dependency + version gate ─────────────────

    use std::sync::atomic::{AtomicU64, Ordering};
    static DEP_SEQ: AtomicU64 = AtomicU64::new(0);

    /// A throwaway `(packages, env-rootfs)` pair, so a test drives the REAL gate
    /// function `build.rs` calls rather than a stand-in. Names are invented and carry no
    /// contributed vocabulary — this file is inside the app builtin.
    /// The total number of pins across EVERY shipped recipe, measured. It moves UP for
    /// free — a new pin or a whole new recipe needs no edit here — and DOWN only when a
    /// pin is deleted, which is what this number exists to refuse. Raising it is a
    /// consequence of adding pins; LOWERING it is a scientific decision that belongs in
    /// `docs/runbooks/env-image-republish.md`, never a way to make a red test green.
    ///
    /// RAISED 43 -> 44 on #214's merge of current main: #155 added `pillow==12.3.0` to the
    /// python recipe, and the floor is self-checking by EQUALITY, so it went red on the
    /// merge rather than silently acquiring a line of slack. That is the property #192
    /// raised it for, doing its job on someone else's pin.
    ///
    /// RAISED 41 -> 43 by #192, and the reason is the mutation battery that found it:
    /// deleting ONE pin line from the shipped R recipe left 42 and this floor did not
    /// fire. 41 was the exact total when it was recorded; #181 then added `tifffile` and
    /// `imagecodecs` to the PYTHON recipe, and the floor did not follow, so it had
    /// silently acquired two lines of slack — exactly enough to make it blind to the
    /// single-pin removal it exists to catch. A floor with headroom is a floor that has
    /// stopped being one.
    const MIN_TOTAL_PINS: usize = 44;

    /// Pins across every shipped recipe, counted through the SHIPPED parsers.
    fn shipped_total_pins() -> usize {
        let env_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../env-rootfs");
        let mut total = 0usize;
        for entry in std::fs::read_dir(&env_root).expect("the env recipe tree is readable") {
            let dir = entry.expect("a readable dir entry").path();
            if !dir.is_dir() || !dir.join(ENV_RECIPE_MARKER).exists() {
                continue;
            }
            let text = std::fs::read_to_string(dir.join(ENV_PIN_FILE)).expect("a pin file");
            let eco = parse_env_pin_ecosystem(&text).expect("a declared ecosystem");
            total += parse_env_pins_in(&text, eco).expect("exact pins").len();
        }
        total
    }

    struct DepFixture(PathBuf);
    impl DepFixture {
        fn new(tag: &str) -> Self {
            let seq = DEP_SEQ.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir()
                .join(format!("cyto-dep-gate-{tag}-{}-{seq}", std::process::id()));
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(root.join("packages")).unwrap();
            std::fs::create_dir_all(root.join("env-rootfs")).unwrap();
            DepFixture(root)
        }
        fn packages(&self) -> PathBuf {
            self.0.join("packages")
        }
        fn env_root(&self) -> PathBuf {
            self.0.join("env-rootfs")
        }
        /// One env recipe: a marker file plus its pin set, written VERBATIM.
        ///
        /// Used by every test whose subject is the required directives themselves —
        /// above all the deletion mutations, where supplying a missing declaration would
        /// make the floor untestable by the only means that proves it works.
        fn recipe_raw(&self, id: &str, pins: &str) -> &Self {
            let dir = self.env_root().join(id);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("Dockerfile"), "FROM scratch\n").unwrap();
            std::fs::write(dir.join("requirements.txt"), pins).unwrap();
            self
        }
        /// One env recipe, with the two declarations #192 requires of every recipe
        /// supplied when the given text does not carry them.
        ///
        /// This convenience exists so the dependency-gate fixtures written before #192
        /// keep exercising what they were written to exercise (the RESOLUTION, not the
        /// declaration). It is deliberately not magic: it fills in only what is absent,
        /// it never overrides a declaration the test makes, and a test about the
        /// declarations uses [`Self::recipe_raw`].
        fn recipe(&self, id: &str, pins: &str) -> &Self {
            let mut text = String::new();
            if !pins.contains(ENV_ECOSYSTEM_DIRECTIVE) {
                text.push_str("# cyto:ecosystem=python\n");
            }
            if !pins.contains(ENV_PIN_SOURCE_DIRECTIVE) {
                text.push_str("# cyto:pin-source=immutable-index:https://pypi.org/simple\n");
            }
            text.push_str(pins);
            self.recipe_raw(id, &text)
        }
        /// One package whose single analysis declares `deps` (raw YAML, already indented
        /// to sit under `dependencies:`).
        fn package(&self, id: &str, deps: &str) -> &Self {
            let dir = self.packages().join(id);
            std::fs::create_dir_all(&dir).unwrap();
            let manifest = format!(
                "id: {id}\nname: {id}\npublisher: t\nversion: 0.1.0\napiVersion: \"1.0\"\n\
                 contributes:\n  analyses:\n    - id: {id}.act\n      category: c\n      \
                 title: T\n      run:\n        kind: sandbox\n        runtime: python\n        \
                 entry: compute/e.py\n        dependencies:\n{deps}"
            );
            std::fs::write(dir.join("manifest.yaml"), manifest).unwrap();
            self
        }
        /// As [`Self::package`], but the analysis also DECLARES an env (#189). Kept as a
        /// separate constructor rather than a parameter on `package` so every existing
        /// dependency-gate test keeps exercising the env-LESS path unchanged — that path
        /// is the fail-closed default DEC-2 preserves, and it must stay covered.
        fn env_package(&self, id: &str, env: &str, deps: &str) -> &Self {
            let dir = self.packages().join(id);
            std::fs::create_dir_all(&dir).unwrap();
            let manifest = format!(
                "id: {id}\nname: {id}\npublisher: t\nversion: 0.1.0\napiVersion: \"1.0\"\n\
                 contributes:\n  analyses:\n    - id: {id}.act\n      category: c\n      \
                 title: T\n      env: {env}\n      run:\n        kind: sandbox\n        \
                 runtime: python\n        entry: compute/e.py\n        dependencies:\n{deps}"
            );
            std::fs::write(dir.join("manifest.yaml"), manifest).unwrap();
            self
        }
        fn lint(&self) -> Result<(), String> {
            lint_processor_tree_with_env(&self.packages(), Some(&self.env_root()))
        }
    }
    impl Drop for DepFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// TEST-2 [covers: ITEM-7] — the specifier comparator, INCLUDING the fail-closed
    /// edge. The direction matters: the run-time half uses the reference implementation,
    /// so these two agree only while this subset is STRICTLY narrower than real
    /// specifier semantics. Anything it cannot decide exactly must be an Err, never a
    /// silent `true`.
    #[test]
    fn version_specifier_comparator_and_its_fail_closed_edge() {
        for (v, spec) in [
            ("1.11.5", ">=1.11,<1.12"),
            ("1.11.0", ">=1.11"),
            ("1.11", ">=1.11"),      // zero-padding: 1.11 == 1.11.0
            ("1.11.5", "==1.11.5"),
            ("2.0.0", "!=1.0.0"),
            ("2.0.0", ">1.9,<=2.0"),
            ("0.5.2", ">=0.5,<0.6"),
        ] {
            assert!(
                version_satisfies(v, spec).unwrap_or_else(|e| panic!("{v} vs {spec}: {e}")),
                "`{v}` should satisfy `{spec}`"
            );
        }
        for (v, spec) in [
            ("1.12.0", ">=1.11,<1.12"),
            ("1.10.9", ">=1.11"),
            ("1.11.5", "==1.11.4"),
            ("1.0.0", "!=1.0.0"),
            ("1.11", ">1.11"),       // zero-padding again, the other way
        ] {
            assert!(
                !version_satisfies(v, spec).unwrap_or_else(|e| panic!("{v} vs {spec}: {e}")),
                "`{v}` should NOT satisfy `{spec}`"
            );
        }
        // FAIL CLOSED — every one of these is a grammar the reference implementation
        // understands and this one does not. Each must be an Err, so the build refuses
        // rather than accepting a declaration whose real meaning it cannot compute.
        for spec in ["==1.*", "~=1.11", ">=1!2.0", ">=1.0+cpu", ">=1.0rc1", "1.11.5", "", "  "] {
            assert!(
                version_satisfies("1.11.5", spec).is_err(),
                "specifier `{spec}` must fail closed, not silently pass"
            );
        }
        // …and a version that is not a plain dotted release is likewise refused.
        for v in ["1.11.5rc1", "1.11.*", "v1.11.5", "1!1.0", "1.0+local"] {
            assert!(
                version_satisfies(v, ">=1.0").is_err(),
                "version `{v}` must fail closed, not be guessed at"
            );
        }
    }

    /// **TEST-E3-15** [covers: ITEM-10] (#191) — R `DESCRIPTION` versions are comparable
    /// under the grammar an R recipe DECLARES, and are still refused under the default.
    ///
    /// The defect this closes: `parse_release` split only on `.`, so `Matrix==1.7-6`,
    /// `spatstat==3.6-2`, `lme4==2.0-6` and `refund==0.1-40` — four of the eighteen pins
    /// the `single-cell-r` recipe actually installs, every one of them the real upstream
    /// version string — parsed to nothing. The FIRST contribution to declare
    /// `env: single-cell-r` with a range over any of them would have hard-failed
    /// `cargo check` with a message about dotted-numeric releases.
    ///
    /// The default arm is asserted alongside, because the whole safety of the widening is
    /// that it is opt-in: `1.0-1` means `1.0.1` to R and `1.0.post1` to PEP 440, and
    /// `1.0.post1 < 1.0.1`, so a gate that read `-` for everybody would accept a
    /// declaration the python run time rejects.
    #[test]
    fn r_description_versions_compare_only_under_the_declared_grammar() {
        // Every dash-shaped pin the shipped R recipe carries, satisfied and unsatisfied.
        for (v, spec, want) in [
            ("1.7-6", ">=1.7", true),
            ("1.7-6", ">=1.7.6", true),
            ("1.7-6", ">=1.7-6,<1.8", true),
            ("1.7-6", ">=1.7-7", false),
            ("3.6-2", ">=3.6,<4.0", true),
            ("2.0-6", ">=2.0", true),
            ("2.0-6", ">=2.1", false),
            ("0.1-40", ">=0.1-39", true),
            ("0.1-40", ">=0.1-41", false),
            // `-` and `.` are the SAME separator to R, so a declaration may spell it
            // either way and mean the same thing.
            ("0.1-40", "==0.1.40", true),
        ] {
            assert_eq!(
                version_satisfies_in(v, spec, VersionGrammar::RDescription)
                    .unwrap_or_else(|e| panic!("{v} vs {spec}: {e}")),
                want,
                "`{v}` vs `{spec}` under the R grammar"
            );
        }

        // THE CONTROL, and the reason the grammar is declared rather than sniffed: the
        // default reader still REFUSES the dash form outright. If this ever passes, the
        // widening has leaked into every python recipe.
        for v in ["1.7-6", "3.6-2", "2.0-6", "0.1-40"] {
            assert!(
                version_satisfies(v, ">=1.0").is_err(),
                "`{v}` must remain unparseable under PEP 440 — the R reading is opt-in"
            );
            assert!(
                version_satisfies_in(v, ">=1.0", VersionGrammar::Pep440).is_err(),
                "the explicit Pep440 arm must agree with the default"
            );
        }

        // The R grammar widens the SEPARATOR set and nothing else — every fail-closed
        // edge of the default reader is still an error under it.
        for v in ["1.11.5rc1", "1.11.*", "v1.11.5", "1!1.0", "1.0+local", "1.7--6", "1.7-"] {
            assert!(
                version_satisfies_in(v, ">=1.0", VersionGrammar::RDescription).is_err(),
                "`{v}` must fail closed under the R grammar too"
            );
        }
    }

    /// **TEST-E3-17** [covers: ITEM-10] (#191) — END TO END through the real gate: a
    /// contribution declaring an R env with a RANGE over an R-shaped pin lints clean, and
    /// the identical declaration against a recipe that has NOT declared the grammar is
    /// refused. This is the thing the branch actually blocks — TEST-E3-15 proves the
    /// comparator, this proves the comparator is reached with the right grammar.
    #[test]
    fn a_range_over_an_r_shaped_pin_resolves_only_for_a_recipe_that_declared_the_grammar() {
        let ok = DepFixture::new("r-grammar-ok");
        ok.recipe(
            "renv",
            "# cyto:ecosystem=r\nMatrix==1.7-6  # import=Matrix\n",
        );
        ok.env_package("rpkg", "renv", "          - library: Matrix\n            version: \">=1.7,<2.0\"\n");
        ok.lint().expect("an R range over an R-shaped pin must resolve");

        // The SAME pin and the SAME declaration, against a recipe that declares PYTHON:
        // refused, with a message about the grammar rather than a wrong verdict.
        let missing = DepFixture::new("r-grammar-missing");
        missing.recipe(
            "renv",
            "# cyto:ecosystem=python\nMatrix==1.7-6  # import=Matrix\n",
        );
        missing.env_package(
            "rpkg",
            "renv",
            "          - library: Matrix\n            version: \">=1.7,<2.0\"\n",
        );
        let err = missing.lint().expect_err(
            "under the python reading the R version is unreadable and must fail closed",
        );
        assert!(
            err.contains("1.7-6") && err.contains("dotted-numeric"),
            "the refusal must name the version and the grammar it could not read: {err}"
        );

        // And the widening did not weaken the gate: an out-of-range R pin still fails.
        let out = DepFixture::new("r-grammar-out-of-range");
        out.recipe(
            "renv",
            "# cyto:ecosystem=r\nMatrix==1.7-6  # import=Matrix\n",
        );
        out.env_package(
            "rpkg",
            "renv",
            "          - library: Matrix\n            version: \">=1.8\"\n",
        );
        let err = out.lint().expect_err("1.7-6 is outside >=1.8");
        assert!(err.contains("OUTSIDE the declared supported range"), "{err}");
    }

    /// **TEST-1** `[acceptance]` `[invariant: INV-2]` [covers: ITEM-1, ITEM-2] (#192) —
    /// the whole point of the item, driven through the REAL gate over a real on-disk
    /// two-recipe tree.
    ///
    /// `scDblFinder` is the concrete case: E7 (#195) declares it to unblock the held
    /// doublet branch, and if a declaration spelled `scdblfinder` could match the pin
    /// `scDblFinder`, the gate would report green for a package that is not the one the
    /// recipe installs. R package names are case-sensitive by definition, so that match
    /// is not a near-miss — it is a different package.
    ///
    /// **Would fail with the fix reverted**: under the pre-#192 rule both sides were
    /// lowercased, so `scdblfinder` matched and the second assertion below would find no
    /// error to unwrap.
    #[test]
    fn r_pin_names_resolve_case_preservingly_and_python_pin_names_still_fold() {
        // The R half: the exact spelling resolves.
        let exact = DepFixture::new("r-case-exact");
        exact.recipe(
            "renv",
            "# cyto:ecosystem=r\nscDblFinder==1.26.7  # import=scDblFinder\n",
        );
        exact.env_package(
            "rpkg",
            "renv",
            "          - library: scDblFinder\n            version: \">=1.26\"\n",
        );
        exact
            .lint()
            .expect("the exact spelling must resolve against the pin");

        // ...and a spelling that differs ONLY in case does NOT.
        for wrong in ["scdblfinder", "SCDBLFINDER", "ScDblFinder"] {
            let f = DepFixture::new("r-case-wrong");
            f.recipe(
                "renv",
                "# cyto:ecosystem=r\nscDblFinder==1.26.7  # import=scDblFinder\n",
            );
            f.env_package(
                "rpkg",
                "renv",
                &format!("          - library: {wrong}\n            version: \">=1.26\"\n"),
            );
            let err = f.lint().expect_err(
                "a spelling differing only in case must NOT match the pin `scDblFinder` — a \
                 declaration that matched a differently-cased pin would report green against \
                 the WRONG package",
            );
            assert!(
                err.contains(wrong) && err.contains("scDblFinder"),
                "`{wrong}`: the refusal must name both spellings: {err}"
            );
        }

        // A library the recipe genuinely does not install still fails, naming the
        // package, the contribution and the env — the near-miss path must not swallow it.
        let absent = DepFixture::new("r-case-absent");
        absent.recipe(
            "renv",
            "# cyto:ecosystem=r\nscDblFinder==1.26.7  # import=scDblFinder\n",
        );
        absent.env_package(
            "rpkg",
            "renv",
            "          - library: BiocParallel\n            version: \">=1.46\"\n",
        );
        let err = absent.lint().expect_err("an absent library must fail");
        assert!(
            err.contains("BiocParallel")
                && err.contains("rpkg.act")
                && err.contains("renv")
                && err.contains("does NOT install"),
            "the refusal must name the package, the contribution and the env: {err}"
        );

        // THE PYTHON LANE IS UNCHANGED (frozen epic TEST-E4-2). All three spellings of one
        // distribution still resolve against the one pin — the PEP 503 fold is not
        // weakened by the R rule existing, because each side folds under its own recipe.
        for spelling in ["scikit-learn", "scikit_learn", "Scikit.Learn"] {
            let f = DepFixture::new("py-fold");
            f.recipe(
                "pyenv",
                "# cyto:ecosystem=python\nscikit-learn==1.9.0  # import=sklearn\n",
            );
            f.env_package(
                "pypkg",
                "pyenv",
                &format!("          - library: {spelling}\n            version: \">=1.9\"\n"),
            );
            f.lint().unwrap_or_else(|e| {
                panic!("`{spelling}` must still fold to one pin under the python rule: {e}")
            });
        }
    }

    /// **TEST-3** [covers: ITEM-3] (#192) — a near-miss is NAMED, and the plain-absent
    /// case is not swallowed by it.
    ///
    /// A refusal reading only "the env recipe does NOT install scdblfinder" sends the
    /// reader to add a pin that is already there. The message has to name both spellings
    /// and the rule, or the correct behaviour is indistinguishable from a bug.
    #[test]
    fn a_case_only_mismatch_is_refused_with_both_spellings_named() {
        let f = DepFixture::new("r-nearmiss");
        f.recipe(
            "renv",
            "# cyto:ecosystem=r\nscDblFinder==1.26.7  # import=scDblFinder\n",
        );
        f.env_package(
            "rpkg",
            "renv",
            "          - library: scdblfinder\n            version: \">=1.26\"\n",
        );
        let err = f.lint().expect_err("a case-only mismatch must be refused");
        assert!(
            err.contains("scdblfinder") && err.contains("scDblFinder"),
            "the refusal must name BOTH spellings: {err}"
        );
        assert!(
            err.contains("differ only in CASE") && err.contains("case-sensitive"),
            "the refusal must say WHY, or it reads as a missing pin: {err}"
        );
        assert!(
            !err.contains("does NOT install"),
            "the near-miss must not be reported as a plain absence: {err}"
        );

        // A python recipe has no near-miss to report — the two spellings fold together,
        // so the declaration RESOLVES rather than producing a case lecture.
        let py = DepFixture::new("py-nonearmiss");
        py.recipe(
            "pyenv",
            "# cyto:ecosystem=python\nscikit-learn==1.9.0  # import=sklearn\n",
        );
        py.env_package(
            "pypkg",
            "pyenv",
            "          - library: SciKit-Learn\n            version: \">=1.9\"\n",
        );
        py.lint()
            .expect("under the python fold this is the same distribution, not a near-miss");
    }

    /// **TEST-4** `[acceptance]` `[invariant: INV-5]` [covers: ITEM-4, ITEM-9] (#192 /
    /// #209) — the pin-SOURCE taxonomy, and the refusal that answers #209.
    ///
    /// The invariant: a recorded `<name>==<version>` is an identity only when its source
    /// guarantees that pair denotes one source tree. `vcs-head` does not, so a recipe
    /// installing from one would record the SAME identity for DIFFERENT code — worse than
    /// no pin, because an absence is visible and a false identity is not.
    ///
    /// **Would fail with the fix reverted**: without the taxonomy there is no refusal at
    /// all, and every assertion below that expects an `Err` would find `Ok`.
    #[test]
    fn a_pin_source_that_cannot_identify_one_tree_is_refused() {
        // ROUND-TRIP: every class LISTED IN `PIN_SOURCE_CLASSES` is spellable in a pin
        // file and parses back to itself.
        //
        // HONEST SCOPE, corrected after an audit: this loop's subject set IS the array, so
        // it is exactly the thing it cannot audit — a variant added to the enum but left
        // out of `PIN_SOURCE_CLASSES` is invisible to it. That gap is real and fails OPEN
        // (`identifies_one_tree` is `!matches!(self, VcsHead)`, so an unlisted variant
        // defaults to "identifies one tree"), and Rust has no enum iteration to close it
        // from here. What closes it is
        // `test_rootfs_deps_r.py::test_the_two_pin_source_readers_know_the_same_class_vocabulary`,
        // which reads the VARIANTS and the array out of this file and compares them — the
        // audit's mutation (a new variant with a `token()` arm, absent from the array) is
        // caught there and only there. Recorded so the next reader does not take this
        // loop for a completeness check.
        for c in PIN_SOURCE_CLASSES {
            let text = format!("# cyto:pin-source={}:x\n", c.token());
            match parse_env_pin_sources(&text) {
                Ok(v) => assert_eq!(v[0].class, c, "`{}` must round-trip", c.token()),
                Err(e) => assert!(
                    !c.identifies_one_tree(),
                    "`{}` is admissible but did not parse: {e}",
                    c.token()
                ),
            }
        }

        // The three classes that DO identify a tree parse, and record which of them can
        // still be fetched later — the difference between "this rebuild fails loudly" and
        // "this pin is a lie".
        for (tok, refetchable) in [
            ("immutable-index", true),
            ("dated-snapshot", true),
            ("release-channel", false),
        ] {
            let parsed =
                parse_env_pin_sources(&format!("# cyto:pin-source={tok}:coord\n")).unwrap();
            assert_eq!(parsed.len(), 1);
            assert_eq!(parsed[0].class.token(), tok);
            assert_eq!(parsed[0].coordinate, "coord");
            assert!(parsed[0].class.identifies_one_tree());
            assert_eq!(parsed[0].class.refetchable_later(), refetchable);
        }
        // A coordinate is routinely a URL, so the class/coordinate split must be on the
        // FIRST colon and nothing else.
        let parsed = parse_env_pin_sources(
            "# cyto:pin-source=dated-snapshot:https://packagemanager.posit.co/cran/x/2026-09-01\n",
        )
        .unwrap();
        assert_eq!(
            parsed[0].coordinate,
            "https://packagemanager.posit.co/cran/x/2026-09-01"
        );

        // THE #209 REFUSAL.
        assert!(!PinSourceClass::VcsHead.identifies_one_tree());
        let err = parse_env_pin_sources("# cyto:pin-source=vcs-head:https://github.com/x/y\n")
            .expect_err("a source that cannot identify a tree must be refused");
        assert!(
            err.contains("#209") && err.contains("DIFFERENT code") && err.contains("source hash"),
            "the refusal must say what identity fails and where the answer lives: {err}"
        );
        // ...and it must say what IS admissible, with each one's guarantee — derived from
        // the enum, so the list cannot fall behind the classes that exist.
        assert!(
            err.contains("`dated-snapshot` (reproducible)")
                && err.contains("`release-channel` (fails loud on a rebuild)")
                && !err.contains("`vcs-head` ("),
            "the refusal must enumerate the admissible classes and their guarantees, and \
             must not list the refused one as admissible: {err}"
        );

        // REPEATABLE, because the R recipe has two coordinates — but not the SAME one
        // twice, which says nothing twice and is what a bad merge leaves behind.
        let two = parse_env_pin_sources(
            "# cyto:pin-source=dated-snapshot:a\n# cyto:pin-source=release-channel:b\n",
        )
        .unwrap();
        assert_eq!(two.len(), 2);
        assert!(parse_env_pin_sources(
            "# cyto:pin-source=dated-snapshot:a\n# cyto:pin-source=dated-snapshot:a\n"
        )
        .is_err());

        // Unknown class, empty coordinate, near-miss spelling: refused, never defaulted.
        assert!(parse_env_pin_sources("# cyto:pin-source=whatever:x\n").is_err());
        assert!(parse_env_pin_sources("# cyto:pin-source=dated-snapshot:\n").is_err());
        assert!(parse_env_pin_sources("# cyto:pin-source dated-snapshot:a\n").is_err());

        // THE WHITESPACE DIVERGENCE CLASS, tested as a CLASS rather than enumerated.
        //
        // The first cut of this asserted two code points — U+00A0 and U+0085, the two an
        // audit had named — and its Rust and R twins both did. That is not a test of "the
        // two readers agree about which lines are directives"; it is a test of two
        // characters, and the next audit found U+000B, where the disagreement runs the
        // other way (invisible HERE, live in the installer — the gate blind, which is the
        // fail-open direction). An enumeration of the last finding cannot catch the next
        // one.
        //
        // The property is now: EVERY whitespace character except SPACE, TAB and LF makes
        // the file REFUSED. Not "ignored by both" — refused, which is a state neither
        // reader can interpret differently. Derived from `char::is_whitespace`, so a
        // future Unicode revision adding a space character is covered without an edit.
        let mut checked_ws = 0usize;
        for cp in 0u32..=0x10FFFF {
            let Some(c) = char::from_u32(cp) else { continue };
            if !(c.is_control() || c.is_whitespace()) || matches!(c, ' ' | '\t' | '\n') {
                continue;
            }
            checked_ws += 1;
            let text = format!("#{c}cyto:pin-source=dated-snapshot:https://evil/x\n");
            // `expect_err`, not `unwrap_or_else` — the latter runs its closure on Err,
            // which is the case being asserted, so it would have passed only when the
            // character was ACCEPTED. That inversion has now been written twice on this
            // branch (DRIFT-1.7 was the first); both times it was caught by running.
            let err = assert_canonical_pin_bytes(&text)
                .expect_err(&format!("U+{cp:04X} must be refused, not interpreted"));
            assert!(
                err.contains(&format!("U+{cp:04X}")),
                "the refusal for U+{cp:04X} must name it: {err}"
            );
        }
        assert!(
            checked_ws >= 70,
            "only {checked_ws} non-SPACE/TAB/LF control/whitespace characters were exercised — the \
             derivation found almost nothing and this assertion would be vacuous"
        );
        // …and the refusal names the character, so a person can find it in a file where it
        // is by definition invisible.
        let err = assert_canonical_pin_bytes("# cyto:pin-source\u{a0}=dated-snapshot:x\n")
            .expect_err("U+00A0 must be refused");
        assert!(
            err.contains("U+00A0") && err.contains("line 1"),
            "the refusal must name the character and the line: {err}"
        );
        // THE PYTHON TERMINATORS, named explicitly. U+001C/1D/1E end a line for
        // `str.splitlines()` and U+001C-1F are `str.isspace()`-true, while
        // `char::is_whitespace()` is FALSE for all four — so a set derived from Rust's
        // notion alone let them through, and a pin hidden behind one was a comment to this
        // gate and to the installer while every python floor still counted it. That is a
        // pin REMOVAL made invisible to the guards that exist to catch removals.
        for cp in [0x1cu32, 0x1d, 0x1e, 0x1f] {
            let c = char::from_u32(cp).unwrap();
            let err = assert_canonical_pin_bytes(&format!("alpha==1.0\n#{c}beta==2.0\n"))
                .expect_err("a python line terminator must be refused here too");
            assert!(err.contains(&format!("U+{cp:04X}")), "{err}");
        }
        // A NUL is not whitespace in any language, and R's `readChar` TRUNCATES at one —
        // so everything after it is invisible to the installer while this gate reads the
        // whole file. Forbidden as a control character.
        let err = assert_canonical_pin_bytes("alpha==1.0\n\0beta==2.0\n")
            .expect_err("an embedded NUL must be refused");
        assert!(err.contains("U+0000"), "{err}");

        // A LONE CR is the same class: `str::lines()` splits only on LF while the
        // installer's `readLines` also splits on CR, so a mid-line fragment is a whole
        // directive line to it. Refused.
        let err = assert_canonical_pin_bytes("# see the runbook\r# cyto:pin-source=x:y\n")
            .expect_err("a lone CR must be refused");
        assert!(err.contains("U+000D"), "{err}");
        // The SHIPPED files pass it. Without this the precondition could be arbitrarily
        // strict and nobody would notice until a rebuild.
        let env_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../env-rootfs");
        let mut canon_checked = 0usize;
        for entry in std::fs::read_dir(&env_root).expect("the env recipe tree is readable") {
            let dir = entry.expect("a readable dir entry").path();
            if !dir.is_dir() || !dir.join(ENV_RECIPE_MARKER).exists() {
                continue;
            }
            let text = std::fs::read_to_string(dir.join(ENV_PIN_FILE)).expect("a pin file");
            assert_canonical_pin_bytes(&text)
                .unwrap_or_else(|e| panic!("the SHIPPED {}: {e}", dir.display()));
            canon_checked += 1;
        }
        assert_eq!(
            canon_checked, 2,
            "expected both shipped recipes to be checked against the precondition"
        );

        // ONE COORDINATE PER CLASS. Two DIFFERENT `dated-snapshot` lines make "which
        // snapshot were these pins resolved at" unanswerable, and accepting that while the
        // recipe's own reader refuses it is what let the attack above stay green here.
        let err = parse_env_pin_sources(
            "# cyto:pin-source=dated-snapshot:https://good/x\n\
             # cyto:pin-source=dated-snapshot:https://evil/x\n",
        )
        .expect_err("two coordinates of one class must be refused");
        assert!(
            err.contains("a second `dated-snapshot` pin source"),
            "the refusal must name the class that was declared twice: {err}"
        );

        // A refusal must not carry unbounded or terminal-controlling bytes into a build
        // log: `build.rs` panics with this message straight onto cargo's stderr.
        let nasty = format!("# cyto:pin-source \u{1b}[2K\rforged{}\n", "A".repeat(5000));
        let err = parse_env_pin_sources(&nasty).expect_err("a near-miss is refused");
        assert!(
            !err.contains('\u{1b}') && !err.contains('\r'),
            "control characters must be escaped out of a refusal: {err:?}"
        );
        assert!(
            err.len() < 1000,
            "a refusal must not carry an unbounded line into a build log ({} bytes)",
            err.len()
        );

        // ABSENT is an error (ITEM-9's floor). An unrecorded regime is how a published
        // result comes to rest on a version that appears in no diff in this repository.
        let err = parse_env_pin_sources("alpha==1.0.0  # import=alpha\n")
            .expect_err("a recipe with no declared pin source must be refused");
        assert!(err.contains("no `cyto:pin-source="), "{err}");

        // THE SHIPPED TREE. Every recipe that ships declares at least one source, and
        // every one of them identifies a tree — read off disk, so a recipe that dropped
        // its declaration reddens here.
        let env_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../env-rootfs");
        let mut checked = 0usize;
        for entry in std::fs::read_dir(&env_root).expect("the env recipe tree is readable") {
            let dir = entry.expect("a readable dir entry").path();
            if !dir.is_dir() || !dir.join(ENV_RECIPE_MARKER).exists() {
                continue;
            }
            let text = std::fs::read_to_string(dir.join(ENV_PIN_FILE)).expect("a pin file");
            let sources = parse_env_pin_sources(&text)
                .unwrap_or_else(|e| panic!("recipe at {}: {e}", dir.display()));
            assert!(
                sources.iter().all(|s| s.class.identifies_one_tree()),
                "recipe at {} declares a source that cannot identify one source tree",
                dir.display()
            );
            checked += 1;
        }
        assert!(
            checked >= 2,
            "expected at least two shipped recipes to have been checked, saw {checked} — \
             an assertion that ranged over nothing would report PASS"
        );
    }

    /// Every double-quoted string literal on one line of Rust source, ignoring escapes.
    ///
    /// Deliberately small and deliberately conservative: it does not understand raw strings or
    /// a literal spanning lines, so it can MISS a leak but cannot invent one. A guard that
    /// under-reports is a floor; a guard that over-reports gets baselined. Used by TEST-12.
    fn string_literals_in(line: &str) -> Vec<&str> {
        let mut out = Vec::new();
        let b = line.as_bytes();
        let mut i = 0usize;
        while i < b.len() {
            if b[i] == b'"' {
                let start = i + 1;
                let mut j = start;
                let mut escaped = false;
                while j < b.len() {
                    if escaped {
                        escaped = false;
                    } else if b[j] == b'\\' {
                        escaped = true;
                    } else if b[j] == b'"' {
                        break;
                    }
                    j += 1;
                }
                if j < b.len() {
                    if let Some(s) = line.get(start..j) {
                        out.push(s);
                    }
                    i = j + 1;
                    continue;
                }
                break;
            }
            i += 1;
        }
        out
    }

    /// **TEST-14** [covers: ITEM-1, ITEM-9] (#192, fix round 3) — the R installer's
    /// enumerated forbidden-whitespace list must equal the set `char::is_whitespace`
    /// derives, minus SPACE/TAB/LF.
    ///
    /// R has no Unicode whitespace property, so the recipe has to enumerate. An
    /// enumeration beside a property is a mirror, and every mirror in this feature that
    /// was not mechanically checked has drifted — that is what three rounds of audits
    /// found. This is the check: the property is derived HERE from the standard library,
    /// the enumeration is read out of the recipe, and they must agree exactly. A future
    /// Unicode revision that adds a space character reddens this rather than silently
    /// TEST-14, RESTATED FOR THE ALLOWLIST (#192 round 3 → #214).
    ///
    /// The two programs that read this file are written in different languages and cannot
    /// share code, so the rule they both apply is held together HERE by reading the R
    /// recipe's own vector out of the recipe and comparing it to the gate's.
    ///
    /// What changed: this used to compare an 81-codepoint FORBIDDEN set derived from
    /// `char::is_whitespace` against the recipe's enumeration of the same. That framing
    /// failed open — the `Cf` format class was outside `is_control()` and therefore
    /// permitted, which a blind audit turned into an inert-but-visible directive. The rule
    /// is now an ALLOWLIST, so this compares four characters instead of eighty-one, and a
    /// character neither side has heard of is refused by both without either being edited.
    #[test]
    fn the_two_readers_allow_exactly_the_same_non_ascii_characters() {
        let recipe = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../env-rootfs/single-cell-r/Dockerfile");
        let src = std::fs::read_to_string(&recipe).expect("the R recipe is readable");
        // START AFTER THE `(`. The first cut sliced from the start of the assignment, so the
        // first token of the split was `cyto_allowed_non_ascii <- c(0xa7` — which does not
        // `strip_prefix("0x")` and was silently DROPPED. The Rust side then saw three
        // characters where R declares four and this test went red, which is exactly what it
        // is for: the python twin extracts the same vector with a paren-anchored regex, got
        // all four, and passed. Two implementations of one extraction disagreeing is the
        // miniature of the whole issue.
        let marker = "cyto_allowed_non_ascii <- c(";
        // EXACTLY ONCE. Both extractors read only the FIRST occurrence, so a shadowing
        // second assignment — `cyto_allowed_non_ascii <- c(cyto_allowed_non_ascii, 0x2000)`
        // — widened R's allowlist past all three guards while every one stayed green, and
        // the R reader then ACCEPTED U+2000. Demonstrated by a blind audit. This is the same
        // uniqueness discipline the python floor's `frozen` assignment has.
        assert_eq!(
            src.matches(marker).count(),
            1,
            "the marker text `cyto_allowed_non_ascii <- c(` appears more than once in the \
             recipe. Both this extractor and its python twin read only the FIRST, so a \
             later assignment widens what the installer allows while every cross-check \
             stays green. (This counts the MARKER, not assignments: a differently-spaced \
             assignment would evade it, and a comment containing the marker would trip it. \
             Both fail in the safe direction and neither is worth a parser.)"
        );
        let start = src
            .find(marker)
            .expect("the recipe must enumerate the non-ASCII characters it allows")
            + marker.len();
        let body = &src[start..];
        let body = &body[..body.find(')').expect("an unterminated c( in the recipe")];
        // EVERY token must PARSE, not merely the ones that look like `0x…`.
        //
        // Round 1 fixed a silent drop of the FIRST element and called that "exactly what
        // this test is for". A second blind audit pointed out the drop was fixed for one
        // POSITION, not for the CLASS: `filter_map` still discards any token this extractor
        // cannot read, so a decimal `8232` or an uppercase `0X2028` in the recipe's vector
        // would be invisible here while R's `%in%` honoured it — admitting U+2028 LINE
        // SEPARATOR, one of the historical divergence characters. A lossy extractor in a
        // cross-check is the cross-check failing quietly.
        let tokens: Vec<&str> = body
            .split(|c: char| c == ',' || c == '\n')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect();
        let enumerated: std::collections::BTreeSet<u32> = tokens
            .iter()
            .map(|tok| {
                tok.strip_prefix("0x")
                    .and_then(|h| u32::from_str_radix(h, 16).ok())
                    .unwrap_or_else(|| {
                        panic!(
                            "the recipe's `cyto_allowed_non_ascii` contains the token \
                             `{tok}`, which this extractor cannot read as `0x<hex>`. It \
                             would have been DROPPED, and the comparison below would then \
                             pass while R allowed a character the gate does not. Write it \
                             as `0x<hex>`, or teach this extractor the new spelling."
                        )
                    })
            })
            .collect();
        assert_eq!(
            enumerated.len(),
            tokens.len(),
            "the recipe's vector has {} token(s) but only {} distinct codepoints came out \
             — a DUPLICATE entry (a mis-read one panics above, so it cannot reach here)",
            tokens.len(),
            enumerated.len()
        );

        // ANTI-VACUITY: an extraction that finds nothing would make the comparison below
        // trivially true in the direction that matters.
        assert!(
            !enumerated.is_empty(),
            "extracted NO codepoints from the recipe's `cyto_allowed_non_ascii` — the \
             extraction has broken and this comparison was about to certify nothing"
        );

        let ours: std::collections::BTreeSet<u32> = PIN_FILE_ALLOWED_NON_ASCII
            .iter()
            .map(|c| *c as u32)
            .collect();
        assert_eq!(
            enumerated, ours,
            "the recipe's `cyto_allowed_non_ascii` and the gate's \
             `PIN_FILE_ALLOWED_NON_ASCII` disagree.\n  only in the recipe: {:04X?}\n  only \
             in the gate: {:04X?}\nBoth programs read the same file; a character one \
             allows and the other refuses is a build that fails in only one of them. \
             Update both lists, never just one, and never relax this comparison.",
            enumerated.difference(&ours).collect::<Vec<_>>(),
            ours.difference(&enumerated).collect::<Vec<_>>()
        );
    }

    /// **TEST-P22** [acceptance] [invariant: INV-2] — the allowlist is FAIL-CLOSED, which is
    /// the property that makes it different in kind from the four forbidden sets that
    /// preceded it.
    ///
    /// Every byte that defeated a previous round is refused — but so is every member of the
    /// class NOBODY had thought of, which is the point. `Cf` is checked explicitly because
    /// it is the one that got through round 4's "union of three languages' notions".
    #[test]
    fn the_allowlist_refuses_the_invisible_classes_by_default() {
        // The four historical bytes, and the fifth class a blind audit found.
        for (label, c) in [
            ("NBSP (round 2)", '\u{a0}'),
            ("lone CR (round 3)", '\r'),
            ("VT (round 3)", '\u{b}'),
            ("U+001C (round 4)", '\u{1c}'),
            ("NUL — truncates R's readChar", '\0'),
            ("ZWSP (Cf — the class round 4 missed)", '\u{200b}'),
            ("BOM / ZWNBSP (Cf)", '\u{feff}'),
            ("SOFT HYPHEN (Cf)", '\u{ad}'),
            ("WORD JOINER (Cf)", '\u{2060}'),
            ("RTL OVERRIDE — Trojan Source (Cf)", '\u{202e}'),
            ("POP DIRECTIONAL ISOLATE (Cf)", '\u{2069}'),
            ("a Cyrillic homoglyph of `a`", '\u{430}'),
            ("IDEOGRAPHIC SPACE", '\u{3000}'),
            ("DEL", '\u{7f}'),
        ] {
            let err = assert_canonical_pin_bytes(&format!("alpha==1.0{c}\n"))
                .expect_err(&format!("{label}: U+{:04X} must be refused", c as u32));
            assert!(
                err.contains(&format!("U+{:04X}", c as u32)),
                "{label}: the refusal must NAME the character, or a reader cannot act on \
                 it — an invisible character with an unnamed refusal is two puzzles: {err}"
            );
        }
        // …and again in the DIRECTIVE position, which is where the Cf finding was
        // demonstrated: a zero-width space there made the directive inert while leaving it
        // visibly present.
        for (label, c) in [
            ("ZWSP", '\u{200b}'),
            ("BOM", '\u{feff}'),
            ("RTL OVERRIDE", '\u{202e}'),
        ] {
            let err = assert_canonical_pin_bytes(&format!("#{c}cyto:pin-source=x:y\n"))
                .expect_err("must be refused");
            assert!(
                err.contains(&format!("U+{:04X}", c as u32)),
                "{label}: the refusal must name the character: {err}"
            );
        }

        // CONTROL — everything the shipped files legitimately contain is ALLOWED, so the
        // rule above is not merely "refuse everything".
        assert_canonical_pin_bytes(
            "# cyto:ecosystem=python — a note, §4, an arrow → and a rule ─\n\talpha==1.0\n",
        )
        .expect("printable ASCII, SPACE, TAB, LF and the four allowed characters must pass");
        for c in PIN_FILE_ALLOWED_NON_ASCII {
            assert_canonical_pin_bytes(&format!("# {c}\n"))
                .unwrap_or_else(|e| panic!("the allowlist must allow U+{:04X}: {e}", c as u32));
        }
    }

    /// **TEST-12** `[acceptance]` `[invariant: INV-4]` [covers: ITEM-2, ITEM-3] (#192) —
    /// the OTHER half of INV-4, and the half TEST-9 provably cannot see.
    ///
    /// ## Why TEST-9 is not enough, established by mutation rather than argued
    ///
    /// TEST-9 shows the gate's accept/refuse matrix is INVARIANT UNDER RENAMING: an
    /// invented package name behaves exactly as a real one. That is a real property and it
    /// is worth having. It is also blind in precisely one direction, and a blind audit
    /// found it: inserting
    ///
    /// ```ignore
    /// if lib == "scDblFinder" || lib == "harmonypy" { continue; }
    /// ```
    ///
    /// into `lint_declared_dependencies` — the crate literally naming two shipped
    /// libraries and silently exempting them from pin resolution, which is INV-4's exact
    /// prohibition — left all 59 tests green, this file's INV-4 test included. A rule keyed
    /// on a name the invariance test does not happen to exercise is invisible to it, and
    /// there are infinitely many such names.
    ///
    /// ## What this asserts, and what it deliberately does not
    ///
    /// The subject set is DERIVED: every pin name in every discovered recipe, so a package
    /// added tomorrow is covered with zero edits here. The predicate is EXACT STRING
    /// LITERAL EQUALITY in the PRODUCTION half of `build_helper/` — not a substring scan.
    /// That narrowness is the point: `digest`, `Matrix`, `refund` and `spatstat` are
    /// ordinary vocabulary in a codebase about content digests and matrices, so a substring
    /// guard would be a false-positive machine and would be baselined into uselessness
    /// within a week. A literal `"digest"` compared against a library name is a different
    /// thing from the word `digest` in a sentence, and only the first is a decision.
    ///
    /// Honest scope, stated rather than implied: this covers `build_helper/`, where the
    /// gate lives and where the mutation landed. INV-4's words are "anywhere in this
    /// crate", and this does not scan all of `src/`. Neither this nor TEST-9 alone is
    /// enough; the pair is the guard, and the pair is still narrower than the invariant.
    #[test]
    fn no_pinned_library_name_is_a_string_literal_in_the_gate() {

        let env_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../env-rootfs");
        let mut names: Vec<String> = Vec::new();
        for entry in std::fs::read_dir(&env_root).expect("the env recipe tree is readable") {
            let dir = entry.expect("a readable dir entry").path();
            if !dir.is_dir() || !dir.join(ENV_RECIPE_MARKER).exists() {
                continue;
            }
            let text = std::fs::read_to_string(dir.join(ENV_PIN_FILE)).expect("a pin file");
            let eco = parse_env_pin_ecosystem(&text).expect("a declared ecosystem");
            for pin in parse_env_pins_in(&text, eco).expect("exact pins") {
                names.push(pin.name);
            }
        }
        // ANCHORED TO THE MEASUREMENT, not floored below it. `MIN_NAMES = 30` against 43
        // derived names had thirteen lines of slack — it was blind to a thirteen-pin
        // removal, which is the same decay that had already happened to `MIN_TOTAL_PINS`
        // and is the reason that one is now self-checking. Equality has no slack to
        // acquire, and `shipped_total_pins()` is the same counter the aggregate floor
        // uses, so the two cannot drift apart.
        assert_eq!(
            names.len(),
            shipped_total_pins(),
            "the derived name set ({}) does not equal the shipped pin total ({}) — this \
             assertion is ranging over a different set from the one it claims",
            names.len(),
            shipped_total_pins()
        );

        let helper_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("build_helper");
        let mut scanned = 0usize;
        let mut scanned_names: Vec<String> = Vec::new();
        let mut leaks: Vec<String> = Vec::new();
        for entry in std::fs::read_dir(&helper_dir).expect("the build_helper dir is readable") {
            let path = entry.expect("a readable dir entry").path();
            if path.extension().and_then(|e| e.to_str()) != Some("rs") {
                continue;
            }
            let src = std::fs::read_to_string(&path).expect("a readable source file");
            // PRODUCTION HALF ONLY. Tests must be able to name a library — that is what
            // makes them tests of this gate — so everything from the first `#[cfg(test)]`
            // line onward is out of scope, the same structural exemption
            // `check-derived-vocabulary.sh` grants test code.
            let prod = match src.lines().position(|l| l.trim() == "#[cfg(test)]") {
                Some(i) => src.lines().take(i).collect::<Vec<_>>().join("\n"),
                None => src.clone(),
            };
            scanned += 1;
            scanned_names.push(
                path.file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or_default()
                    .to_string(),
            );
            for (lineno, line) in prod.lines().enumerate() {
                for lit in string_literals_in(line) {
                    if names.iter().any(|n| n == lit) {
                        leaks.push(format!(
                            "{}:{}: the string literal `\"{lit}\"` is a package name pinned \
                             by a shipped env recipe",
                            path.display(),
                            lineno + 1
                        ));
                    }
                }
            }
        }
        // NAMED, not counted. `scanned >= 1` was satisfied by `mod.rs` and
        // `sandbox_rootfs.rs` alone, so a filter change that skipped the file the gate
        // actually lives in — and the file the audit's mutation landed in — would leave
        // this green while scanning nothing that matters.
        assert!(
            scanned_names.iter().any(|n| n == "processor_manifest.rs"),
            "the guard did not scan `processor_manifest.rs`, which is where the gate lives \
             — it scanned {scanned_names:?}. A count of files is not a check that the right \
             file was among them"
        );
        assert!(
            scanned >= 1,
            "no build_helper source file was scanned — the guard found nothing to check, \
             which is not the same as finding nothing wrong"
        );
        assert!(
            leaks.is_empty(),
            "INV-4: the core must interpret neither field's meaning, and no library may be \
             named in it — both sides of every comparison are data. Found:\n{}\n\nA rule \
             keyed on a particular library is invisible to the invariance test (TEST-9), \
             because it only fires for a name that test does not exercise. Remove the \
             literal; do not add it to an allowlist.",
            leaks.join("\n")
        );
    }

    /// **TEST-9** `[acceptance]` `[invariant: INV-4]` [covers: ITEM-2, ITEM-3] (#192) —
    /// INV-4 asserted BEHAVIOURALLY: *"No library is named anywhere in this crate; both
    /// sides of every comparison are data."*
    ///
    /// The obvious form — grep the crate for the recipes' package names — cannot work
    /// here: `digest`, `Matrix`, `refund` and `spatstat` include ordinary vocabulary of
    /// this codebase, so that guard would be a false-positive machine and would be
    /// baselined into uselessness within a week.
    ///
    /// So the claim is tested as what it means: the gate's accept/refuse matrix must be
    /// INVARIANT UNDER RENAMING. Every outcome TEST-1 gets with real package names is
    /// reproduced here with names this crate has never seen. If any decision rested on a
    /// library's identity, a name it does not know would behave differently.
    #[test]
    fn the_gate_is_invariant_under_renaming_so_no_library_is_known_to_the_crate() {
        // The R matrix, with an invented package name.
        let exact = DepFixture::new("inv-r-exact");
        exact.recipe(
            "renv",
            "# cyto:ecosystem=r\nZqxWidget==1.26.7  # import=ZqxWidget\n",
        );
        exact.env_package(
            "rpkg",
            "renv",
            "          - library: ZqxWidget\n            version: \">=1.26\"\n",
        );
        exact.lint().expect("the exact spelling resolves");

        let wrong = DepFixture::new("inv-r-wrong");
        wrong.recipe(
            "renv",
            "# cyto:ecosystem=r\nZqxWidget==1.26.7  # import=ZqxWidget\n",
        );
        wrong.env_package(
            "rpkg",
            "renv",
            "          - library: zqxwidget\n            version: \">=1.26\"\n",
        );
        let err = wrong
            .lint()
            .expect_err("a case-only mismatch on an INVENTED name must refuse identically");
        assert!(
            err.contains("differ only in CASE") && err.contains("ZqxWidget"),
            "the near-miss diagnostic must work for a name the crate has never seen: {err}"
        );

        // The python matrix, with an invented distribution name.
        for spelling in ["qq-rr-tool", "qq_rr_tool", "QQ.RR.Tool"] {
            let f = DepFixture::new("inv-py-fold");
            f.recipe(
                "pyenv",
                "# cyto:ecosystem=python\nqq-rr-tool==1.9.0  # import=qqrr\n",
            );
            f.env_package(
                "pypkg",
                "pyenv",
                &format!("          - library: {spelling}\n            version: \">=1.9\"\n"),
            );
            f.lint().unwrap_or_else(|e| {
                panic!("`{spelling}` must fold under the python rule for an invented name too: {e}")
            });
        }

        // And the R rule does NOT fold punctuation — that is a PyPI index convention, not
        // an R one.
        //
        // THE PAIR HAS TO DISCRIMINATE, and the first cut's did not. It used `zz64` vs
        // `zz-64`, which PEP 503 folds to `zz64` and `zz-64` — still unequal — so the
        // assertion held with the punctuation half of the R rule fully reverted to the
        // PyPI rule. An audit reverted exactly that half (collapsing runs of `-`/`_`/`.`
        // while deliberately KEEPING case) and all 60 tests stayed green. `zz_64` vs
        // `zz-64` is the discriminating pair: identical under PEP 503, distinct under the
        // R rule.
        //
        // Worth knowing: no shipped R pin name contains `-`, `_` or `.`, so no shipped-tree
        // assertion can cover this either. This fixture is the only thing that does.
        let punct = DepFixture::new("inv-r-punct");
        punct.recipe("renv", "# cyto:ecosystem=r\nzz_64==1.0\n");
        punct.env_package(
            "rpkg",
            "renv",
            "          - library: zz-64\n            version: \">=1.0\"\n",
        );
        let err = punct.lint().expect_err(
            "the R rule must not collapse punctuation: `zz-64` and `zz_64` are one \
             distribution to a PyPI index and two different packages to R",
        );
        assert!(
            err.contains("zz-64") && err.contains("does NOT install"),
            "the refusal must name the declared spelling: {err}"
        );
        // The CONTROL: the same pair under the python rule DOES fold, so the pair is
        // genuinely discriminating rather than simply unmatched everywhere.
        let punct_py = DepFixture::new("inv-py-punct");
        punct_py.recipe("pyenv", "# cyto:ecosystem=python\nzz_64==1.0\n");
        punct_py.env_package(
            "pypkg",
            "pyenv",
            "          - library: zz-64\n            version: \">=1.0\"\n",
        );
        punct_py
            .lint()
            .expect("under the python fold `zz_64` and `zz-64` are the same distribution");
    }

    /// **TEST-10** [covers: ITEM-9] (#192) — the anti-DELETION floors, each proved by
    /// DELETING the thing and observing RED.
    ///
    /// `docs/design/derived-guards.md` §4: a derivation whose two sides read the same
    /// source is a tautology in the direction that source changes, so it is blind to a
    /// removal. Every one of these mutations is that direction. None of them is a
    /// hypothetical: the deleted text is taken from the SHIPPED pin file.
    #[test]
    fn deleting_a_required_declaration_goes_red_rather_than_defaulting() {
        let env_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../env-rootfs");
        let shipped =
            std::fs::read_to_string(env_root.join("single-cell-r").join(ENV_PIN_FILE)).unwrap();

        // (a) the ECOSYSTEM declaration deleted. It must NOT fall back to python — which
        // would lowercase every name in this file and read every dash version as PEP 440.
        let no_eco: String = shipped
            .lines()
            .filter(|l| !directive_body(l).starts_with(ENV_ECOSYSTEM_DIRECTIVE))
            .collect::<Vec<_>>()
            .join("\n");
        let f = DepFixture::new("del-eco");
        f.recipe_raw("renv", &no_eco);
        f.env_package(
            "rpkg",
            "renv",
            "          - library: scDblFinder\n            version: \">=1.26\"\n",
        );
        let err = f
            .lint()
            .expect_err("a recipe whose ecosystem declaration was deleted must be refused");
        assert!(
            err.contains("no `cyto:ecosystem=<python|r>` declaration")
                && err.contains("do not reintroduce a default"),
            "the refusal must name the deletion and forbid the easy fix: {err}"
        );

        // (b) every PIN-SOURCE declaration deleted.
        let no_src: String = shipped
            .lines()
            .filter(|l| !directive_body(l).starts_with(ENV_PIN_SOURCE_DIRECTIVE))
            .collect::<Vec<_>>()
            .join("\n");
        let f = DepFixture::new("del-src");
        f.recipe_raw("renv", &no_src);
        f.env_package(
            "rpkg",
            "renv",
            "          - library: scDblFinder\n            version: \">=1.26\"\n",
        );
        let err = f
            .lint()
            .expect_err("a recipe whose pin-source declarations were deleted must be refused");
        assert!(
            err.contains("no `cyto:pin-source=") && err.contains("do not relax"),
            "the refusal must name the deletion and forbid the easy fix: {err}"
        );

        // (c) a PIN line deleted, and the AGGREGATE FLOOR asserted against the result.
        //
        // The first cut computed `before`/`after` and asserted only that the mutation
        // removed a line — i.e. it proved its own `filter` worked and said nothing about
        // the floor, while its message and TESTS.md both claimed "the aggregate
        // MIN_TOTAL_PINS floor still fires". An audit deleted a real pin from the shipped
        // file and watched THIS test pass while a different one caught it. The floor is
        // now a module-level constant and this case evaluates it directly.
        let before = parse_env_pins_in(&shipped, EnvEcosystem::R).unwrap().len();
        let one_gone: String = shipped
            .lines()
            .filter(|l| !l.trim_start().starts_with("scDblFinder=="))
            .collect::<Vec<_>>()
            .join("\n");
        let after = parse_env_pins_in(&one_gone, EnvEcosystem::R).unwrap().len();
        assert_eq!(
            after,
            before - 1,
            "the mutation must actually remove a pin, or the floor below is being tested \
             against an unchanged file"
        );
        let mutated_total = shipped_total_pins() - 1;
        assert!(
            mutated_total < MIN_TOTAL_PINS,
            "with one pin removed the tree holds {mutated_total} pin(s), which is NOT below \
             the floor of {MIN_TOTAL_PINS} — the floor has acquired slack and can no longer \
             see the single-pin removal it exists for. Raise it to the measured total."
        );

        // (d) the CONTROL that makes (a)–(c) mean something: the shipped file, unmutated,
        // must LINT CLEAN through the same fixture path. Without it, all three refusals
        // above would also be produced by a fixture that never worked at all.
        let good = DepFixture::new("del-control");
        good.recipe_raw("renv", &shipped);
        good.env_package(
            "rpkg",
            "renv",
            "          - library: scDblFinder\n            version: \">=1.26\"\n",
        );
        good.lint()
            .expect("the SHIPPED pin file, unmutated, must resolve a real declaration");
    }

    /// **TEST-2** [covers: ITEM-1] (#192), succeeding **TEST-E3-16**/**TEST-E3-8**
    /// (#191) — the ECOSYSTEM directive, from which both the version grammar and the
    /// distribution-name rule are derived. A known value selects it; an UNRECOGNISED
    /// value, an ABSENT declaration, a near-miss spelling, a second declaration and the
    /// RETIRED predecessor key are each an error rather than a silent fall-back — every
    /// one of which would read this file as python and lowercase its package names.
    #[test]
    fn the_pin_file_declares_its_ecosystem_and_a_typo_or_an_absence_is_refused() {
        assert_eq!(
            parse_env_pin_ecosystem("# cyto:ecosystem=python\nalpha==1.0.0\n").unwrap(),
            EnvEcosystem::Python
        );
        assert_eq!(
            parse_env_pin_ecosystem("# cyto:ecosystem=r\nalpha==1.0-1\n").unwrap(),
            EnvEcosystem::R
        );
        // The two derived facets, asserted at the type so nothing can select one and not
        // the other.
        assert_eq!(EnvEcosystem::Python.grammar(), VersionGrammar::Pep440);
        assert_eq!(EnvEcosystem::R.grammar(), VersionGrammar::RDescription);
        assert_eq!(
            normalize_dist_name_in("Scikit.Learn", EnvEcosystem::Python),
            "scikit-learn"
        );
        assert_eq!(
            normalize_dist_name_in("scDblFinder", EnvEcosystem::R),
            "scDblFinder",
            "the R rule preserves case AND punctuation — it is not a fold at all"
        );

        // ABSENT IS AN ERROR (#192 / DEC-1). This is the anti-deletion floor at its
        // strongest: structural, not a count. A default here would make "somebody deleted
        // the line" indistinguishable from "this is a python recipe".
        let err = parse_env_pin_ecosystem("alpha==1.0.0  # import=alpha\n")
            .expect_err("a recipe that declares no ecosystem must be refused");
        assert!(
            err.contains("no `cyto:ecosystem=<python|r>` declaration"),
            "{err}"
        );

        let err = parse_env_pin_ecosystem("# cyto:ecosystem=R\nalpha==1.0-1\n")
            .expect_err("an unknown ecosystem must be refused, not defaulted");
        assert!(err.contains("names no known packaging ecosystem"), "{err}");

        // THE RETIRED KEY. Ignoring it would restore BOTH halves of the failure #192
        // removes, so it is a hard error that names its replacement.
        let err = parse_env_pin_ecosystem("# cyto:version-grammar=r-description\nalpha==1.0-1\n")
            .expect_err("the retired directive must be refused, not ignored");
        assert!(
            err.contains("is RETIRED") && err.contains("cyto:ecosystem=<python|r>"),
            "the refusal must name the replacement: {err}"
        );

        // SPELLINGS THAT MUST STILL BE UNDERSTOOD. Each of these silently selected the
        // default under the predecessor's first cut — which, for an R recipe, is the
        // failure the directive exists to remove, arriving with no message at all.
        for spelling in [
            "#cyto:ecosystem=r\n",
            "#  cyto:ecosystem=r\n",
            "## cyto:ecosystem=r\n",
            "# cyto:ecosystem = r\n",
            "#\tcyto:ecosystem=r\n",
            "   # cyto:ecosystem=r\n",
            "# cyto:ecosystem=r  # because R\n",
        ] {
            assert_eq!(
                parse_env_pin_ecosystem(spelling).unwrap_or_else(|e| panic!("{spelling:?}: {e}")),
                EnvEcosystem::R,
                "spelling {spelling:?} must be understood, not silently defaulted"
            );
        }
        // A line that NAMES the directive and does not parse is an error, never a default.
        let err = parse_env_pin_ecosystem("# cyto:ecosystem r\n")
            .expect_err("a near-miss must be refused, not read as absent");
        assert!(err.contains("is not"), "{err}");

        // TWO declarations are refused whether or not they agree — two lines that match
        // today are two lines that can disagree tomorrow.
        assert!(
            parse_env_pin_ecosystem("# cyto:ecosystem=python\n# cyto:ecosystem=r\n").is_err(),
            "two conflicting declarations must be refused"
        );
        assert!(
            parse_env_pin_ecosystem("# cyto:ecosystem=python\n# cyto:ecosystem=python\n").is_err(),
            "two IDENTICAL declarations must also be refused — the error message says the \
             file may declare exactly one, and it must mean it"
        );

        // THE SHIPPED TREE, not a fixture: the R recipe declares the R grammar and every
        // one of its pins parses under it. Read off disk so a recipe that dropped the
        // directive (or gained an unparseable pin) reddens here rather than at the first
        // declaration written against it.
        let env_root =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../env-rootfs");
        // TEST-E3-8's clause: the SHIPPED parser (`read_env_recipes` + `parse_env_pins`)
        // reads the REAL tree, finds at least two recipes, and parses every pin of each
        // without error — the R pin file is accepted by the same parser that gates every
        // declaration, not by a second one written for it. `read_env_recipes` returns Err
        // on any unparseable line, so the `expect` below IS that assertion; the per-recipe
        // floor is what stops it passing on a recipe whose pin file parsed to nothing.
        let recipes = read_env_recipes(&env_root).expect("the shipped recipe tree parses");
        assert!(recipes.len() >= 2, "expected two shipped recipes, got {}", recipes.len());
        for recipe in &recipes {
            assert!(
                !recipe.pins.is_empty(),
                "env recipe `{}` parsed to ZERO pins — an env whose installed set is not \
                 pinned cannot be checked against any declaration, and every assertion \
                 below would be vacuous for it",
                recipe.id
            );
        }
        let mut dash_pins = 0usize;
        for recipe in &recipes {
            for pin in &recipe.pins {
                // Only the DASH-shaped pins are checked for comparability. A pin file may
                // legitimately carry a version this comparator cannot read at all
                // (`2.9.0.post0` — see `parse_env_pins`'s note); that stays a fail-closed
                // error raised at the declaration that names it. What must NOT happen is
                // a pin that is unreadable ONLY because its recipe forgot the directive.
                if pin.version.contains('-') {
                    dash_pins += 1;
                    assert_eq!(
                        recipe.ecosystem.grammar(),
                        VersionGrammar::RDescription,
                        "recipe `{}` pins `{}=={}`, a version only the R grammar can read, \
                         but declares no `# {ENV_ECOSYSTEM_DIRECTIVE}=r`",
                        recipe.id,
                        pin.name,
                        pin.version
                    );
                    assert!(
                        version_satisfies_in(&pin.version, ">=0", recipe.ecosystem.grammar())
                            .is_ok(),
                        "recipe `{}`: pin `{}=={}` is not comparable under the grammar the \
                         recipe's declared ecosystem selects ({:?}) — the first declaration \
                         naming it would fail the build",
                        recipe.id,
                        pin.name,
                        pin.version,
                        recipe.ecosystem.grammar()
                    );
                }
            }
        }
        // ANTI-VACUITY, derived rather than counted. `dash_pins >= 4` was the first cut
        // and it has zero headroom on a number UPSTREAM owns: exactly four dash-shaped
        // pins ship, so a routine upstream bump of any one of them to a dot-form version
        // (`Matrix 1.8.0`) drops the count to three and reddens this test for a reason
        // that has nothing to do with the grammar directive. What must actually stay true
        // is that the directive is DECLARED and REACHED — and the comparator itself is
        // exercised on literal dash versions by TEST-E3-15, which needs no shipped pin.
        assert!(
            recipes.iter().any(|r| r.ecosystem == EnvEcosystem::R),
            "no shipped recipe declares `# {ENV_ECOSYSTEM_DIRECTIVE}=r` — the directive is \
             unexercised against the real tree, and an R recipe that lost it would fail \
             the first declaration written against it"
        );
        // #192: the NAME half of the same claim. A shipped R recipe must carry at least
        // one pin whose spelling is not its own lowercasing, or the case-preserving rule
        // is unexercised against the real tree and a regression to PEP 503 folding would
        // be invisible here.
        assert!(
            recipes
                .iter()
                .filter(|r| r.ecosystem == EnvEcosystem::R)
                .any(|r| r.pins.iter().any(|p| p.name != p.name.to_ascii_lowercase())),
            "no shipped R recipe pins a mixed-case package name — the case-preserving \
             rule this item exists for would be unexercised against the real tree"
        );
        let _ = dash_pins;
    }

    /// TEST-3 [covers: ITEM-1] — the pin file is a TOTAL function from distribution to
    /// version. That is what makes the gate decidable without a resolver, so each way of
    /// breaking it is an error rather than a tolerated line.
    #[test]
    fn env_pin_file_must_be_exact_pins_only() {
        let pins = parse_env_pins_in(
            "# a comment\n\nalpha-tool==1.11.5   # import=alpha\nBeta_Tool==2.0.0\n",
            EnvEcosystem::Python,
        )
        .expect("well-formed pins parse");
        assert_eq!(pins.len(), 2);
        assert_eq!(pins[0].name, "alpha-tool");
        assert_eq!(pins[0].version, "1.11.5");
        // Normalization: case + separator spelling must not decide whether a
        // declaration matches its pin.
        assert_eq!(pins[1].name, "beta-tool");
        for bad in [
            "alpha-tool\n",                       // bare name
            "alpha-tool>=1.0\n",                  // a range
            "alpha-tool==1.0,<2.0\n",             // not a single pin
            "alpha-tool==1.0\nalpha_tool==2.0\n", // the same distribution twice
            "==1.0\n",                            // empty name
            "alpha-tool==\n",                     // empty version
        ] {
            assert!(
                parse_env_pins_in(bad, EnvEcosystem::Python).is_err(),
                "pin file content must be refused: {bad:?}"
            );
        }
        // EVERY shipped pin file is itself well-formed — the regression that catches a
        // hand-edit which quietly makes the whole gate vacuous. The env ids are DISCOVERED
        // off the recipe tree rather than spelled, so a second environment is covered the
        // day it lands and this file names no contributed environment.
        // ── THE FLOOR, RE-BASED ONTO THE RING THAT ONLY GROWS (#191) ────────────────
        //
        // This read `parsed.len() >= 20` PER RECIPE, and 20 was a measurement of ONE
        // recipe (the python env's 23 direct pins) written down as if it were a property
        // of recipes. It went red the moment a second, DELIBERATELY NARROWER env landed
        // with 18 pins — failing a file that is exactly as complete as it is meant to be.
        //
        // `docs/design/derived-guards.md` §5 says, correctly, that LOWERING A FLOOR TO FIT
        // is not the repair, and an earlier cut of this change did exactly that (20 → 5).
        // It is not what happens below. §4 of the same document gives the actual shape,
        // corrected after a mutation audit found a derivation blind to a REMOVED
        // declaration: *"derive the set membership, and keep a floor on the derived counts
        // … A floor is not an enumeration — adding only moves the real number up, so it
        // needs no edit; removing one fails."* The bug was the RING the floor sat on, not
        // its existence: a floor per recipe is a cardinality of one contributed thing, and
        // it falls when a NARROWER recipe is added. The AGGREGATE across recipes does not:
        // it rises when a recipe or a pin is added and falls only when a pin is REMOVED —
        // which is precisely the direction a derived check here cannot see, because the
        // parser and the file it parses are the same source (§4's tautology test).
        //
        // So: a structural per-recipe floor that is not tuned to any recipe, and an
        // AGGREGATE floor at the measured total that catches a removal.
        //
        // What is deliberately NOT added is a "derived equivalent" of the old count. Both
        // candidates are hollow: "every non-blank line produced a pin" cannot fail
        // (`parse_env_pins` returns `Err` first, so the `.expect()` above has already
        // fired), and "the pin set covers every declared library" is what
        // `lint_declared_dependencies` already is. Shipping either would read like
        // coverage and assert nothing.

        /// The total number of pins across EVERY shipped recipe, measured. It moves UP for
        /// free — a new pin or a whole new recipe needs no edit here — and DOWN only when
        /// a pin is deleted, which is what this number exists to refuse. Raising it is a
        /// consequence of adding pins; LOWERING it is a scientific decision that belongs
        /// in `docs/runbooks/env-image-republish.md`, never a way to make a red test green.
        // `MIN_TOTAL_PINS` is a MODULE-LEVEL constant (above), because
        // `deleting_a_required_declaration_goes_red_rather_than_defaulting` must evaluate
        // the same number: a floor two tests describe and one test owns is a floor the
        // other one can only claim to check.
        /// A recipe that pins almost nothing is a truncated file, whatever its intent.
        /// Deliberately far below any real recipe so it cannot rot the way the per-recipe
        /// 20 did.
        ///
        /// SCOPE, stated because a mutation audit showed the obvious reading is wrong: on
        /// the CURRENT tree this can never fire for an EXISTING recipe, because
        /// `MIN_TOTAL_PINS` equals the exact current total and any deletion trips the
        /// aggregate first. Its live case is a NEWLY ADDED recipe that arrives truncated —
        /// which raises the total and so slips past the aggregate. The two floors cover
        /// different directions; neither is redundant, and neither alone is enough.
        ///
        /// That paragraph's premise — "`MIN_TOTAL_PINS` equals the exact current total" —
        /// had QUIETLY STOPPED BEING TRUE before #192 re-measured it (see the note on that
        /// constant). It is only ever true as long as somebody raises the aggregate with
        /// every pin added, which nothing enforces; the honest reading is that this
        /// per-recipe floor is the backstop for exactly the window in which the aggregate
        /// has drifted.
        const MIN_PINS_PER_RECIPE: usize = 5;

        let env_root = crate_dir().join("../env-rootfs");
        let mut checked = 0usize;
        let mut total_pins = 0usize;
        for entry in std::fs::read_dir(&env_root).expect("the env recipe tree is readable") {
            let dir = entry.expect("a readable dir entry").path();
            if !dir.is_dir() || !dir.join(ENV_RECIPE_MARKER).exists() {
                continue;
            }
            let text = std::fs::read_to_string(dir.join(ENV_PIN_FILE))
                .unwrap_or_else(|e| panic!("every recipe must carry a pin file: {e}"));
            let eco = parse_env_pin_ecosystem(&text)
                .unwrap_or_else(|e| panic!("every recipe must declare its ecosystem: {e}"));
            let parsed =
                parse_env_pins_in(&text, eco).expect("a shipped pin file must be exact pins");
            assert!(
                parsed.len() >= MIN_PINS_PER_RECIPE,
                "only {} pin(s) parsed from {} — a pin set this thin is a truncated file, \
                 not a bounded environment, and every declaration resolved against it \
                 would be resolved against nothing",
                parsed.len(),
                dir.display()
            );
            total_pins += parsed.len();
            checked += 1;
        }
        assert!(checked >= 1, "no env recipe found under {}", env_root.display());
        assert!(
            total_pins >= MIN_TOTAL_PINS,
            "{total_pins} pin(s) across {checked} recipe(s), below the recorded floor of \
             {MIN_TOTAL_PINS}. A pin was REMOVED. That is the one direction the parser \
             cannot see for itself — it reads the same file it is checking — so this floor \
             is the only thing standing between a deleted library and an image that \
             silently stops installing it. If the removal is intended, follow \
             `docs/runbooks/env-image-republish.md` and lower this number in the SAME \
             commit, with the reason; do not lower it to make this test pass."
        );
    }

    /// TEST-6 [acceptance] [invariant: INV-1] [covers: ITEM-8] — a DECLARED library the
    /// environment does not install fails the BUILD, naming the package, the contribution
    /// and the library. This is the half of INV-1 that moves an in-sandbox import failure
    /// to `cargo check`.
    #[test]
    fn a_declared_library_absent_from_the_env_fails_the_build_gate() {
        let f = DepFixture::new("absent");
        f.recipe("envone", "alpha-tool==1.11.5\n");
        f.package("pkgabsent", "          - library: gamma-tool\n            version: \">=1.0\"\n");
        let err = f.lint().expect_err("an unsatisfiable declaration must fail the gate");
        assert!(err.contains("packages/pkgabsent/manifest.yaml"), "package-scoped: {err}");
        assert!(err.contains("gamma-tool"), "names the missing library: {err}");
        assert!(err.contains("envone"), "names the env recipe: {err}");
        assert!(err.contains("pkgabsent.act"), "names the contribution: {err}");
    }

    /// TEST-7 [acceptance] [invariant: INV-1] [covers: ITEM-8] — the OTHER half of
    /// INV-1: the library is installed, but at a version OUTSIDE the declared supported
    /// range. This is the case that used to publish silently changed numbers.
    #[test]
    fn an_env_pin_outside_the_declared_range_fails_the_build_gate() {
        let f = DepFixture::new("range");
        f.recipe("envone", "alpha-tool==1.12.0\n");
        f.package("pkgrange", "          - library: alpha-tool\n            version: \">=1.11,<1.12\"\n");
        let err = f.lint().expect_err("an out-of-range pin must fail the gate");
        assert!(err.contains("packages/pkgrange/manifest.yaml"), "package-scoped: {err}");
        assert!(err.contains("1.12.0"), "names the resolved pin: {err}");
        assert!(err.contains(">=1.11,<1.12"), "names the declared range: {err}");
        // …and the SAME declaration passes once the pin is inside the range, so the
        // failure is about the range and not about the mechanism refusing everything.
        let ok = DepFixture::new("range-ok");
        ok.recipe("envone", "alpha-tool==1.11.5\n");
        ok.package("pkgrange", "          - library: alpha-tool\n            version: \">=1.11,<1.12\"\n");
        ok.lint().expect("an in-range pin satisfies the declaration");
    }

    /// TEST-8 [covers: ITEM-8] — the gate's quiet cases: nothing declared is a no-op
    /// (and does not even require an env tree), a satisfied declaration passes, a
    /// duplicate declaration is refused, and a declaration unsatisfiable in ONE of
    /// several environments still fails (the fail-closed reading — a contribution does
    /// not say which env it runs in).
    #[test]
    fn dependency_gate_quiet_cases() {
        // No declarations anywhere ⇒ Ok even with no env tree at all.
        let none = DepFixture::new("none");
        std::fs::create_dir_all(none.packages().join("pkgnone")).unwrap();
        std::fs::write(
            none.packages().join("pkgnone/manifest.yaml"),
            concat!(
                "id: pkgnone\nname: n\npublisher: t\nversion: 0.1.0\napiVersion: \"1.0\"\n",
                "contributes:\n  analyses:\n    - id: pkgnone.act\n      category: c\n",
                "      title: T\n      run:\n        kind: sandbox\n",
                "        runtime: python\n        entry: compute/e.py\n",
            ),
        )
        .unwrap();
        none.lint().expect("no declarations ⇒ nothing to resolve");

        // Declared twice for one library — ambiguous, refused.
        let dup = DepFixture::new("dup");
        dup.recipe("envone", "alpha-tool==1.11.5\n");
        dup.package(
            "pkgdup",
            concat!(
                "          - library: alpha-tool\n            version: \">=1.0\"\n",
                "          - library: alpha_tool\n            version: \"<2.0\"\n",
            ),
        );
        let err = dup.lint().expect_err("two ranges for one library is ambiguous");
        assert!(err.contains("twice"), "{err}");

        // Satisfied in one env, absent from a second ⇒ still fails. A contribution does
        // not declare which env it runs in, so "satisfiable somewhere" is not enough.
        let multi = DepFixture::new("multi");
        multi.recipe("envone", "alpha-tool==1.11.5\n");
        multi.recipe("envtwo", "beta-tool==1.0.0\n");
        multi.package("pkgmulti", "          - library: alpha-tool\n            version: \">=1.0\"\n");
        let err = multi.lint().expect_err("must be satisfiable in EVERY env recipe");
        assert!(err.contains("envtwo"), "names the env that cannot satisfy it: {err}");
    }

    /// TEST-14 [acceptance] [invariant: INV-3] [covers: ITEM-1, ITEM-15] — the pinning
    /// position is a machine-checked property of the tree, not a claim in a comment.
    ///
    /// Two clauses. (a) EVERY library any shipped contribution declares is exactly
    /// pinned by the shipped recipe — which is the whole gate, run over the real tree,
    /// so a pin moved out from under a shipped declaration is a red test here before it
    /// is a wrong number in a published result. (b) the shipped recipe's pin set is
    /// non-trivial and every line of it is an exact pin, so the position cannot be
    /// quietly reverted to bare names one line at a time.
    ///
    /// Deliberately expressed WITHOUT naming any library: the subject set is read from
    /// the shipped manifests, so it grows with the tree and this file names no
    /// contributed vocabulary.
    #[test]
    fn every_shipped_declaration_is_satisfied_by_an_exactly_pinned_env() {
        let packages = real_processors();
        let env_root = crate_dir().join("../env-rootfs");
        lint_processor_tree_with_env(&packages, Some(&env_root))
            .expect("every shipped declaration must be satisfied by the shipped env recipes");

        // NON-VACUITY: the clause above is trivially Ok if nothing declares anything.
        // Count the declarations the gate actually resolved.
        let mut declared = 0usize;
        for pkg in watched_manifest_files(&packages)
            .into_iter()
            .filter(|p| p.ends_with("manifest.yaml"))
        {
            let text = std::fs::read_to_string(&pkg).unwrap();
            let m: ProcessorManifest = serde_norway::from_str(&text).unwrap();
            for a in &m.contributes.analyses {
                declared += a.run.as_ref().map(|r| r.dependencies.len()).unwrap_or(0);
            }
            for c in &m.contributes.converters {
                declared += c.run.dependencies.len();
            }
        }
        assert!(
            declared >= 10,
            "only {declared} declaration(s) found across the shipped tree — the gate above \
             would be near-vacuous; the shipped packages are expected to declare what their \
             compute imports"
        );
    }

    /// The lockstep guard the `ENV_RECIPE_MARKER` doc comment names.
    ///
    /// This file is compiled twice — once by `build.rs`, which cannot see the crate, and
    /// once INTO the crate for tests, which can. The second compilation is the only place
    /// the hand-copied constant and the runtime one are both in scope, so it is the only
    /// place the mirror can be checked. Same pattern as
    /// `reserved_entry_lint_matches_the_resolver_table`.
    #[test]
    fn env_recipe_marker_matches_the_runtime_constant() {
        assert_eq!(
            ENV_RECIPE_MARKER,
            crate::modules::rootfs::version::ENV_RECIPE_FILE,
            "the build lint's recipe marker has drifted from the runtime's — the gate would \
             then discover a different set of environments than the one the build targets"
        );
    }

    /// A pin file line the gate cannot turn into a usable (name, version) pair must fail
    /// AT THE LINE, not later and somewhere else.
    ///
    /// Both cases were found by review, and both share a failure shape worth naming: the
    /// input is legal in a requirements file, so it parses, and the damage only surfaces
    /// when some package happens to declare that library — as a message blaming the
    /// declaration for a defect in the recipe.
    #[test]
    fn a_pin_the_gate_cannot_match_or_compare_fails_at_its_own_line() {
        // An extras marker: legal to install, impossible for any declaration to match.
        let err = parse_env_pins_in("alpha-tool[fast]==1.0.0\n", EnvEcosystem::Python)
            .expect_err("extras must fail");
        assert!(err.contains("plain name"), "{err}");
        // An environment marker, same class.
        assert!(parse_env_pins_in(
            "alpha-tool==1.0.0; python_version < \"3.12\"\n",
            EnvEcosystem::Python
        )
        .is_err());
        // A version the hand-written comparator cannot decide is NOT refused here — it is
        // a legal release the recipe may need (`2.9.0.post0` is emitted by pip freeze) and
        // the run time compares it correctly. It becomes an error only when some package
        // DECLARES that library, where the message can name who needs it.
        for legal in [
            "alpha-tool==2.9.0.post0\n",
            "alpha-tool==1.0rc1\n",
            "numpy ==2.4.6\n",
        ] {
            parse_env_pins_in(legal, EnvEcosystem::Python)
                .unwrap_or_else(|e| panic!("a legal pin must parse: {legal:?} -> {e}"));
        }
        // …and the decidability requirement lands at the DECLARATION, naming the package.
        let undecidable = DepFixture::new("undecidable");
        undecidable.recipe("envone", "alpha-tool==1.0rc1\n");
        undecidable.package(
            "pkgundecidable",
            "          - { library: alpha-tool, version: \">=1.0\" }\n",
        );
        let err = undecidable
            .lint()
            .expect_err("a pin the gate cannot compare must fail once it is DECLARED");
        assert!(err.contains("pkgundecidable"), "names the package that needs it: {err}");
        assert!(err.contains("1.0rc1"), "names the pin it cannot decide: {err}");
    }

    /// `optional` changes the RUN, never this gate: an optional declaration must still be
    /// installed by the recipe and still be inside the declared range.
    ///
    /// Stated as a test because the opposite is the intuitive reading, and getting it
    /// wrong would silently remove the build-time half of the contract for every entry
    /// that marks a dependency optional.
    #[test]
    fn an_optional_declaration_is_gated_exactly_like_a_required_one() {
        let missing = DepFixture::new("optmissing");
        missing.recipe("envone", "alpha-tool==1.0.0\n");
        missing.package(
            "pkgoptmissing",
            "          - { library: gamma-tool, version: \">=1.0\", optional: true }\n",
        );
        let err = missing
            .lint()
            .expect_err("an optional library the environment lacks is still a build error");
        assert!(err.contains("gamma-tool"), "{err}");

        let out_of_range = DepFixture::new("optrange");
        out_of_range.recipe("envone", "alpha-tool==2.0.0\n");
        out_of_range.package(
            "pkgoptrange",
            "          - { library: alpha-tool, version: \"<2.0\", optional: true }\n",
        );
        let err = out_of_range
            .lint()
            .expect_err("an optional library pinned outside its range is still a build error");
        assert!(err.contains("OUTSIDE"), "{err}");

        // …and a satisfied optional declaration passes, so the field parses at all.
        let ok = DepFixture::new("optok");
        ok.recipe("envone", "alpha-tool==1.5.0\n");
        ok.package(
            "pkgoptok",
            "          - { library: alpha-tool, version: \">=1,<2\", optional: true }\n",
        );
        ok.lint().expect("a satisfied optional declaration lints clean");
    }

    // ─────────────────────── #189 — the `env:` declaration ───────────────────────

    /// **TEST-E1-1** [acceptance] **PROV-E1-1** [covers: ITEM-1] — an analysis may
    /// DECLARE `env:`, and the build-lint mirror accepts it.
    ///
    /// This asserts the contract's own words — "parsed by BOTH the runtime type and the
    /// build-lint mirror" — from the build-lint side; the runtime half is the sibling
    /// test in `extensions::types`. It is a real acceptance test rather than a
    /// restatement of the code because the fixture is a MANIFEST: it fails if the
    /// `deny_unknown_fields` struct lacks the field, which is precisely the state that
    /// shipped before #189 and which silently skipped the whole package.
    /// Lifecycle id: **TEST-1** (see `.lifecycle/analysis-env-selection/TESTS.md`).
    #[test]
    fn analysis_and_converter_may_declare_an_env() {
        lint_fixture("env_declared")
            .expect("an analysis (and a converter) declaring `env:` must lint clean");
    }

    /// **TEST-E1-1** [acceptance] **PROV-E1-1** [covers: ITEM-1] — a malformed env-id is
    /// refused, NAMING the key and the value.
    ///
    /// The naming half is the part that matters and the part a weaker assertion would
    /// miss: the whole reason this is a hard rejection rather than a warn-and-ignore is
    /// that the author has to be told which value is wrong. An error that merely said
    /// "invalid manifest" would satisfy "it failed" and defeat the point.
    /// Lifecycle id: **TEST-2** (see `.lifecycle/analysis-env-selection/TESTS.md`).
    #[test]
    fn a_malformed_env_id_is_refused_naming_the_key_and_value() {
        let err = lint_fixture("env_bad_id").expect_err("a malformed env-id must fail the lint");
        assert!(
            err.contains("packages/") && err.contains("manifest.yaml:"),
            "package- and manifest-scoped: {err}"
        );
        assert!(err.contains("`env`"), "names the KEY: {err}");
        assert!(err.contains("Repo/Name"), "names the offending VALUE: {err}");
    }

    /// The grammar the lint enforces is the SAME predicate the runtime enforces.
    ///
    /// Single-sourcing is the actual guarantee here (this module `#[path]`-includes the
    /// runtime's `env_id.rs`), so this test's job is to fail if that include is ever
    /// replaced by a hand-written copy that drifts. It restates the reject set the
    /// grammar's own unit tests cover, from the build-lint compilation unit.
    /// Lifecycle id: **TEST-3** (see `.lifecycle/analysis-env-selection/TESTS.md`).
    #[test]
    fn the_lint_grammar_is_the_runtime_grammar() {
        for ok in ["a", "a-b", "a_b", "a.b", "x9"] {
            assert!(env_id::is_valid_env_id(ok), "{ok:?} must be accepted");
        }
        for bad in ["", "UPPER", "a/b", "x:tag", "y@sha256:0", "has space"] {
            assert!(!env_id::is_valid_env_id(bad), "{bad:?} must be rejected");
        }
    }

    /// **TEST-13** [covers: ITEM-4] (#190/#197) — `ENV_BEARING_CONTRIBUTION_KINDS` is
    /// exactly the set of contribution kinds whose item type carries a typed `env` field.
    ///
    /// ## Why a list at all, and why this test is the price of it
    ///
    /// `check_env_ids` runs BEFORE the strict parse, over the UNTYPED document, so it
    /// cannot ask the typed schema where the env-ids are — it has to be told. The first
    /// draft avoided the list by searching the whole document for any key spelled `env`,
    /// and that was a real defect (`the_env_grammar_check_does_not_reach_into_free_form_
    /// regions`): `params` / `accepts` / `produces` / `schema` / `axes` are free-form
    /// regions whose vocabulary is owned elsewhere, and a legitimate `env` key inside one
    /// of them rejected the entire package.
    ///
    /// A path-scoped walk is therefore correct, but it costs a written-down list — the
    /// exact thing that goes stale (`check-kinds-zero-core.sh` was a hardcoded denylist,
    /// vacuously green for every kind added after it). So the list is not asserted against
    /// another list: the expected set is DERIVED from the runtime `Contributes` schema,
    /// the same source `build_lint_contributes_is_a_superset_of_the_runtime_contributes`
    /// already trusts. A third `env`-bearing kind added tomorrow fails HERE, by name,
    /// instead of silently degrading a malformed env-id back to a generic parse error.
    ///
    /// The second leg proves the list is not merely well-maintained but ACTED ON: the
    /// pre-walk must actually reject a bad env-id at `contributes.<kind>[*].env` for every
    /// kind it names.
    #[test]
    fn env_bearing_kinds_match_the_typed_fields() {
        // ── leg 1: the SET, derived from the runtime schema. ──
        let schema = schemars::schema_for!(crate::modules::extensions::types::Contributes);
        let json = serde_json::to_value(&schema).expect("schema serializes");
        let defs = json
            .get("$defs")
            .and_then(|d| d.as_object())
            .cloned()
            .unwrap_or_default();
        let props = json
            .get("properties")
            .and_then(|p| p.as_object())
            .expect("`Contributes` is an object schema with properties");

        /// Does this contribution kind's ITEM type declare a property named `env`?
        /// Follows the `array → items → $ref → $defs/<T>` shape schemars emits, so the
        /// answer comes from the type, never from a second list.
        fn item_has_env(
            kind_schema: &serde_json::Value,
            defs: &serde_json::Map<String, serde_json::Value>,
        ) -> bool {
            let mut item = match kind_schema.get("items") {
                Some(i) => i.clone(),
                None => return false,
            };
            // Resolve one `$ref` hop into `$defs`.
            if let Some(r) = item.get("$ref").and_then(|r| r.as_str()) {
                let name = r.rsplit('/').next().unwrap_or_default();
                item = match defs.get(name) {
                    Some(d) => d.clone(),
                    None => return false,
                };
            }
            item.get("properties")
                .and_then(|p| p.as_object())
                .is_some_and(|p| p.contains_key("env"))
        }

        let mut derived: Vec<&str> = props
            .iter()
            .filter(|(_, v)| item_has_env(v, &defs))
            .map(|(k, _)| k.as_str())
            .collect();
        derived.sort();
        assert!(
            props.len() >= 6,
            "NON-VACUITY FLOOR: only {} contribution kind(s) discovered — the derivation \
             below would prove nothing. Re-derive the schema rather than lowering this.",
            props.len()
        );
        assert!(
            !derived.is_empty(),
            "NON-VACUITY FLOOR: the runtime schema exposes NO contribution kind with a \
             typed `env` field, so this test would pass against an empty list — the \
             `$ref`/`$defs` shape schemars emits has probably changed. Keys seen: {:?}",
            props.keys().collect::<Vec<_>>()
        );

        let mut declared: Vec<&str> = ENV_BEARING_CONTRIBUTION_KINDS.to_vec();
        declared.sort();
        assert_eq!(
            declared, derived,
            "`ENV_BEARING_CONTRIBUTION_KINDS` has drifted from the typed `env` fields. A \
             kind the walk does not name still parses strictly, so a malformed env-id \
             there degrades to a generic 'malformed manifest' instead of the named \
             `{CHECK_ENV_ID_INVALID}` an operator can act on (#190 ITEM-4). A kind the \
             walk names that has NO typed `env` field would reject free-form data."
        );

        // ── leg 1b: the BUILD-LINT side, which leg 1 does not read. ──
        // `check_env_ids` guards manifests parsed by THIS file's `ProcessorManifest`, and
        // the grammar it stands in front of is the `de_checked_env` deserializer, not the
        // runtime property name. Deriving only from the runtime schema left a kind that
        // gains a typed `env` on the build-lint side alone invisible, and a runtime `env`
        // property with NO `de_checked_env` would force the list to be widened — making the
        // walk reject a position the strict parser never grammar-checks, which is the
        // free-form false positive TEST-12 exists to prevent. Counting the attributes binds
        // that half.
        const THIS_FILE: &str = include_str!("processor_manifest.rs");
        let checked_env_fields = THIS_FILE
            .lines()
            .filter(|l| l.trim().starts_with("#[serde(") && l.contains("de_checked_env"))
            .count();
        assert_eq!(
            checked_env_fields,
            ENV_BEARING_CONTRIBUTION_KINDS.len(),
            "this file carries {checked_env_fields} `de_checked_env` field(s) but the walk \
             names {} contribution kind(s). Every grammar-checked `env` field must have its \
             kind in the walk (else a malformed env there degrades to a generic \
             `{CHECK_MALFORMED_MANIFEST}`), and every named kind must have one (else the \
             walk rejects a position the strict parser does not grammar-check at all).",
            ENV_BEARING_CONTRIBUTION_KINDS.len()
        );

        // ── leg 2: the walk actually FIRES at each declared path. ──
        // A list that is perfectly maintained but never consulted is the same defect
        // wearing a green badge.
        for kind in ENV_BEARING_CONTRIBUTION_KINDS {
            let doc = format!("contributes:\n  {kind}:\n    - env: \"Repo/Name\"\n");
            let e = check_env_ids("probe", &doc).err().unwrap_or_else(|| {
                panic!(
                    "the pre-walk did NOT reject a malformed env-id at \
                     `contributes.{kind}[*].env`, so a malformed env there degrades to a \
                     generic 'malformed manifest' and the author is never told WHICH key \
                     is wrong (#190 ITEM-4)"
                )
            });
            assert_eq!(e.check, CHECK_ENV_ID_INVALID, "{kind}: {e:?}");
            assert!(
                e.message.contains("Repo/Name"),
                "{kind}: names the offending value: {}",
                e.message
            );
        }

        // …and does NOT fire on a same-named key that is not an env-id position. This is
        // the free-form leg, restated here so the two halves of the scoping decision fail
        // together if the walk is ever widened back to a document-wide search.
        check_env_ids(
            "probe",
            "contributes:\n  datatypes:\n    - schema:\n        examples:\n          \
             - env: \"Repo/Name\"\n",
        )
        .expect("a free-form `env` key is not an env-id and must not be rejected");
    }

    /// **TEST-E1-4** [acceptance] **PROV-E1-3** [covers: ITEM-8] — `run.dependencies[]`
    /// resolve against the pin set of the env the contribution DECLARES.
    ///
    /// Two recipes with DISJOINT pin sets, which is the configuration the whole contract
    /// exists for: before #189 a declaration had to satisfy every recipe, so the moment a
    /// second, intentionally narrower env landed, one env's pins were forced into the
    /// other and a legitimately env-scoped dependency could not be declared at all.
    ///
    /// All three cases are asserted together because the contract is a TRIPLE — narrowing
    /// to the declared env, still failing when scoped to the wrong one, and leaving the
    /// env-less fail-closed default alone. Asserting only the first would pass for an
    /// implementation that had simply stopped checking.
    /// Lifecycle id: **TEST-4** (see `.lifecycle/analysis-env-selection/TESTS.md`).
    #[test]
    fn declared_env_scopes_the_dependency_gate_and_env_less_stays_fail_closed() {
        // (a) DECLARED env, dependency pinned in THAT recipe ⇒ passes, even though the
        //     other recipe does not pin it at all.
        let scoped = DepFixture::new("envscoped");
        scoped.recipe("alpha", "only-in-alpha==1.2.0\n");
        scoped.recipe("beta", "only-in-beta==3.1.0\n");
        scoped.env_package(
            "pkgalpha",
            "alpha",
            "          - { library: only-in-alpha, version: \">=1,<2\" }\n",
        );
        scoped
            .lint()
            .expect("a dependency pinned in the DECLARED env resolves against that env alone");

        // (b) The SAME declaration scoped to the WRONG env still fails, and the error
        //     NAMES that env — otherwise the relaxation would be indistinguishable from
        //     the gate having been switched off.
        let wrong = DepFixture::new("envwrong");
        wrong.recipe("alpha", "only-in-alpha==1.2.0\n");
        wrong.recipe("beta", "only-in-beta==3.1.0\n");
        wrong.env_package(
            "pkgbeta",
            "beta",
            "          - { library: only-in-alpha, version: \">=1,<2\" }\n",
        );
        let err = wrong
            .lint()
            .expect_err("a dependency absent from the DECLARED env's recipe must fail");
        assert!(err.contains("beta"), "the error names the declared env: {err}");
        assert!(
            err.contains("only-in-alpha"),
            "the error names the library: {err}"
        );

        // (c) DEC-2 — a contribution declaring NO env keeps the every-recipe fail-closed
        //     reading, so the same dependency fails against the recipe lacking it. This
        //     is what keeps every package shipping today gated exactly as strictly as
        //     before, with zero manifest edits.
        let envless = DepFixture::new("envless");
        envless.recipe("alpha", "only-in-alpha==1.2.0\n");
        envless.recipe("beta", "only-in-beta==3.1.0\n");
        envless.package(
            "pkgnone",
            "          - { library: only-in-alpha, version: \">=1,<2\" }\n",
        );
        let err = envless
            .lint()
            .expect_err("an env-LESS contribution is still resolved against EVERY recipe");
        assert!(err.contains("beta"), "fails against the recipe lacking it: {err}");
    }

    /// A declared env with no matching recipe is a hard error, never a silent skip.
    ///
    /// This is the failure mode the scoping change could most easily have introduced:
    /// filtering the recipe list to the declared env yields an EMPTY list for a typo'd
    /// env, and an empty list makes the inner loop body run zero times — so the gate
    /// would report PASS for a contribution whose dependencies were checked against
    /// nothing at all. The check exists specifically to make that impossible.
    /// Lifecycle id: **TEST-5** (see `.lifecycle/analysis-env-selection/TESTS.md`).
    #[test]
    fn a_declared_env_with_no_recipe_is_an_error_not_a_vacuous_pass() {
        let f = DepFixture::new("envmissing");
        f.recipe("alpha", "only-in-alpha==1.2.0\n");
        f.env_package(
            "pkgghost",
            "ghost-env",
            "          - { library: totally-absent, version: \">=1\" }\n",
        );
        let err = f
            .lint()
            .expect_err("a declared env with no recipe must fail, not pass vacuously");
        assert!(err.contains("ghost-env"), "names the missing env: {err}");
        assert!(err.contains("alpha"), "names the envs that DO exist: {err}");
    }

    // ───────────────────────── #214 — THE EXPORTED PARSE ─────────────────────────
    //
    // `docs/design/pin-file-single-parse.md` is the design these tests are tagged against.

    /// A fixture recipe tree, generated the way `build.rs` generates the real one.
    struct PinFixture(PathBuf);

    impl PinFixture {
        fn new(tag: &str) -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos();
            let p = std::env::temp_dir()
                .join(format!("cyto-pinfix-{tag}-{}-{nanos}", std::process::id()));
            std::fs::create_dir_all(&p).expect("mkdir fixture");
            Self(p)
        }
        fn recipe(&self, id: &str, pins: &str) -> &Self {
            let d = self.0.join(id);
            std::fs::create_dir_all(&d).expect("mkdir recipe");
            std::fs::write(d.join(ENV_RECIPE_MARKER), "FROM scratch\n").expect("dockerfile");
            std::fs::write(d.join(ENV_PIN_FILE), pins).expect("pins");
            self
        }
        fn generate(&self) -> Result<String, String> {
            generate_env_pin_artefact(&self.0)
        }
        /// Generate AND commit, so the freshness check has something to compare against.
        fn commit(&self) -> String {
            let j = self.generate().expect("fixture must generate");
            std::fs::write(self.0.join(ENV_PIN_ARTEFACT), &j).expect("write artefact");
            j
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for PinFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// A WELL-FORMED package that declares NO dependency and NO env — the configuration
    /// under which `lint_declared_dependencies` returns `Ok(())` before checking anything,
    /// and under which #192's round 4 found that no pin file was checked at all.
    const NO_DECL_MANIFEST: &str = concat!(
        "id: plain\n",
        "name: Plain Package\n",
        "publisher: cyto\n",
        "version: 0.1.0\n",
        "apiVersion: \"1.0\"\n",
        "contributes:\n",
        "  analyses:\n",
        "    - id: plain.demo\n",
        "      category: demo\n",
        "      title: Demo\n",
        "      appliesTo: []\n",
        "      produces: []\n",
        "      run: { kind: sandbox, runtime: python, entry: compute/demo.py }\n",
    );

    /// A well-formed pin file: both required directives and three pins with import tokens.
    const FIX_PINS: &str = "# cyto:ecosystem=python\n\
         # cyto:pin-source=immutable-index:https://example.invalid/simple\n\
         alpha==1.0  # import=alpha\n\
         beta==2.0   # import=beta\n\
         gamma==3.0  # import=gamma\n";

    /// What role a file that NAMES the pin file plays.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum PinFileRole {
        /// Turns pin-file BYTES into pin data with its own line, comment and token rules.
        Parser,
        /// Names the file but does not tokenize its content: a substring assertion, a path
        /// enumerator, a `COPY`, a digest, prose, or a consumer of the exported parse.
        NearMiss,
    }

    /// **THE CENSUS.** Every file in the tree that names the pin file, classified.
    ///
    /// ## Why this is a table and not just a scan
    ///
    /// A scan alone cannot tell a parser from a mention — that judgement is what the table
    /// records. What the scan provides is the DERIVED candidate set: a file that names the
    /// pin file and is absent from this table turns
    /// `the_pin_file_has_exactly_two_parsers` RED, so a new reader cannot be added
    /// silently. Derived set, frozen cases — `docs/design/derived-guards.md` §4's shape,
    /// and it costs an edit only when the covered set actually changes.
    ///
    /// ## This is a census, not an exemption allowlist
    ///
    /// §5 of the design refuses "widening an allowlist" as a repair, and it is right to.
    /// The distinction: an exemption allowlist lets a file OUT of a rule, so widening it
    /// weakens the rule. This table lets nothing out — every entry must still be true, and
    /// adding a `Parser` entry FAILS the count assertion rather than satisfying it. The
    /// only thing it can be widened with silently is a `NearMiss`, and a `NearMiss` that
    /// is really a parser is caught by the behavioural test next door, which asks what the
    /// consumers ANSWER rather than what they contain.
    const PIN_FILE_READERS: &[(&str, PinFileRole, &str)] = &[
        // ── THE THREE PARSERS. Two are ours; `uv` is not, and cannot be removed. ──
        (
            "src-app/server/build_helper/processor_manifest.rs",
            PinFileRole::Parser,
            "the build gate: the sole producer of the exported parse",
        ),
        (
            "src-app/env-rootfs/single-cell-r/Dockerfile",
            PinFileRole::Parser,
            "the R installer: runs inside the image with only the recipe's two files in \
             context, so it cannot read the export. The irreducible second (§3)",
        ),
        (
            "src-app/env-rootfs/single-cell/Dockerfile",
            PinFileRole::Parser,
            "the python installer: `uv pip install -r` — the RECIPE parses nothing, but \
             `uv` does, in the same role the R installer occupies. Counted (#214, after a \
             blind audit demonstrated a gate-vs-uv disagreement) because a parser you \
             cannot remove is still a parser",
        ),
        // ── consumers of the exported parse: they read JSON, never the pin file ──
        (
            "src-app/server/src/modules/sandbox/env_image.rs",
            PinFileRole::NearMiss,
            "the smoke-correspondence guard — WAS a parser (its own lines()/comment/token \
             rules); now reads the artefact and hashes the bytes for freshness",
        ),
        (
            "src-app/packages/_lib/test_deps.py",
            PinFileRole::NearMiss,
            "drives the reader above: writes fixture pin files and hashes them; its only \
             source-level check is an AST walk asserting `env_pins.py` has no grammar",
        ),
        (
            "src-app/packages/_lib/env_pins.py",
            PinFileRole::NearMiss,
            "the python reader of the artefact; names the pin file only to digest it",
        ),
        (
            "src-app/packages/differential-expression/tests/test_rootfs_deps.py",
            PinFileRole::NearMiss,
            "WAS a parser; now reads the artefact. Its remaining pin-file reads are \
             whole-file substring assertions",
        ),
        (
            "src-app/packages/differential-expression/tests/test_rootfs_deps_r.py",
            PinFileRole::NearMiss,
            "WAS THREE grammars (pin regex + two re.M directive scans); now reads the \
             artefact",
        ),
        (
            "src-app/packages/spatial-types/tests/test_spatial_dependency_declaration.py",
            PinFileRole::NearMiss,
            "#215 — WAS a parser; now reads the artefact",
        ),
        (
            "src-app/packages/spatial-import-visium/tests/test_package_registration.py",
            PinFileRole::NearMiss,
            "#215 — WAS a re.M parser behind no precondition at all; now reads the artefact",
        ),
        (
            "src-app/packages/embedding/tests/test_integration.py",
            PinFileRole::NearMiss,
            "#215 — WAS a narrow parser; now reads the artefact",
        ),
        (
            "src-app/server/tests/dataset/convert_soma_test.rs",
            PinFileRole::NearMiss,
            "#215 — WAS a parser used as a positive control; now reads the artefact",
        ),
        // ── the byte precondition: scans characters, extracts no pin data ──
        (
            "src-app/packages/differential-expression/tests/pin_file_canon.py",
            PinFileRole::NearMiss,
            "the canonical-bytes precondition, python side. No line, comment or token \
             rule; it counts \\n only so a refusal can name a line",
        ),
        // ── the R recipe's own suite: uses the parser under test, no rule of its own ──
        (
            "src-app/env-rootfs/single-cell-r/tests/regime_test.R",
            PinFileRole::NearMiss,
            "drives the R installer's parser through the installer's OWN reader \
             (readChar + strsplit), so it has no line rule of its own",
        ),
        (
            "src-app/env-rootfs/single-cell-r/tests/run-r-tests.sh",
            PinFileRole::NearMiss,
            "passes the pin file's PATH through to regime_test.R; parses the Dockerfile, \
             never the pin file",
        ),
        // ── transports, path enumerators, prose ──
        (
            "src-app/env-rootfs/env-pins.generated.json",
            PinFileRole::NearMiss,
            "the exported parse itself. It NAMES the pin file in its do-not-edit banner \
             and RECORDS a digest of it; it is the output of the one parse, never a reader \
             of the bytes",
        ),
        (
            "src-app/env-rootfs/single-cell/requirements.txt",
            PinFileRole::NearMiss,
            "a pin file naming itself in its own header prose",
        ),
        (
            "src-app/env-rootfs/single-cell-r/requirements.txt",
            PinFileRole::NearMiss,
            "a pin file naming itself in its own header prose",
        ),
        (
            "src-app/packages/_lib/zero_core_guard.py",
            PinFileRole::NearMiss,
            "matches git-diff PATH strings; never opens the file",
        ),
        (
            "src-app/packages/_lib/test_zero_core_guard.py",
            PinFileRole::NearMiss,
            "writes fixture pin files for the path guard above",
        ),
        (
            "src-app/packages/spatial-types/tests/test_zero_src_app_diff.py",
            PinFileRole::NearMiss,
            "a path allowlist",
        ),
        (
            "src-app/packages/trajectory/tests/test_zero_src_app_diff.py",
            PinFileRole::NearMiss,
            "a path allowlist",
        ),
        (
            "src-app/packages/spatial-import-visium/manifest.yaml",
            PinFileRole::NearMiss,
            "prose in a manifest comment",
        ),
        (
            "src-app/packages/spatial-import-visium/compute/ome_writer.py",
            PinFileRole::NearMiss,
            "a doc comment saying where `pillow` is pinned. Arrived from #155 while this \
             branch was open, and the tripwire caught it on the merge — which is the \
             behaviour it exists for",
        ),
        (
            "src-app/server/tests/sandbox/env_publish_runbook_test.rs",
            PinFileRole::NearMiss,
            "one whole-file substring assertion (the pin file points at the runbook); no \
             tokenization",
        ),
        (
            "scripts/publish-env-rootfs.sh",
            PinFileRole::NearMiss,
            "a comment mentioning the COPY",
        ),
        ("justfile", PinFileRole::NearMiss, "the regen recipe's prose"),
        (
            "docs/design/pin-file-single-parse.md",
            PinFileRole::NearMiss,
            "this design",
        ),
        (
            "docs/runbooks/env-image-republish.md",
            PinFileRole::NearMiss,
            "the runbook",
        ),
        (
            "docs/analysis-workbench/plans/P4-provenance/FINAL.md",
            PinFileRole::NearMiss,
            "a historical plan",
        ),
        (
            "docs/analysis-workbench/plans/P4-provenance/r2.md",
            PinFileRole::NearMiss,
            "a historical plan",
        ),
    ];

    /// Every file in the repository that NAMES the pin file — the DERIVED candidate set.
    ///
    /// ## Why this asks GIT rather than walking the filesystem
    ///
    /// The first cut walked three hand-picked roots (a partial enumeration wearing a
    /// derivation's clothes, correctly flagged), so the second cut walked the whole tree
    /// with a hardcoded exclusion list. That walk did not respect `.gitignore` and recursed
    /// on `is_dir()`, which follows symlinks, so a symlink cycle anywhere was unbounded; it
    /// also had to exclude `.claude` by name because it holds whole worktree COPIES of the
    /// repository, which would have double-counted every file here.
    ///
    /// `git ls-files --cached --others --exclude-standard` is the derived set that is
    /// actually wanted: everything the repository CONTAINS or is about to contain, and
    /// nothing it ignores. It cannot recurse, and it is close to the notion of "in the repo"
    /// a reviewer has.
    ///
    /// ## What it does and does NOT change, measured rather than assumed
    ///
    /// The first version of this comment claimed the switch stopped a developer's
    /// `NOTES-scratch.md` from reddening the build gate's own test. **It does not, and a
    /// blind audit ran it to show so.** `--others` deliberately includes untracked files
    /// that are not ignored — which is CORRECT: a new reader is untracked for exactly as
    /// long as it takes to `git add` it, and a census that could not see it would be blind
    /// during the window that matters. What actually changed is that a GITIGNORED file no
    /// longer reddens it, which is the real nuisance case.
    ///
    /// Two narrowings, stated because the comment they replace did not:
    ///  * **submodules are invisible.** `git ls-files` yields one gitlink entry for `sdk/`
    ///    and `agent-kit/`; the filesystem walk descended into them. Neither contains a
    ///    match today, so this is latent.
    ///  * **no `.git` means no census.** In an exported tarball `git ls-files` exits
    ///    non-zero and the assertion below fails LOUDLY. That is the right direction — a
    ///    false red, not a vacuous green — and it is deliberate.
    fn files_naming_the_pin_file(repo: &Path) -> Vec<String> {
        let out = std::process::Command::new("git")
            .args(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
            .current_dir(repo)
            .output()
            .expect("git ls-files must run — the census derives its candidate set from it");
        assert!(
            out.status.success(),
            "git ls-files failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        // BYTES, not `from_utf8_lossy`. A blind audit created an untracked
        // `ZZZ-\xff-probe.md` naming the pin file: `git ls-files -z` lists it, but
        // `from_utf8_lossy` maps the byte to U+FFFD, `repo.join(p)` then names a file that
        // does not exist, and the read filter dropped it silently — the census fell open on
        // the pathname exactly as it had on the file's CONTENT one line below, which this
        // same round had just fixed.
        use std::os::unix::ffi::OsStrExt;
        let entries: Vec<std::path::PathBuf> = out
            .stdout
            .split(|b| *b == 0)
            .filter(|s| !s.is_empty())
            .map(|s| std::path::PathBuf::from(std::ffi::OsStr::from_bytes(s)))
            .collect();
        // Every SPELLING a reader could reach the file by. The literal name is the obvious
        // one; the other three are the constants #214 itself introduced, and they matter
        // BECAUSE the change succeeded — the ~20 rewritten call sites no longer contain the
        // literal, so a future consumer writing `(env_pins.DEFAULT_ENV_ROOT / env_id /
        // env_pins.PIN_FILE_NAME).read_text().splitlines()` would be a grammar invisible to
        // a scan that only knew the literal.
        const KEYS: [&str; 4] = [
            "requirements.txt",
            "ENV_PIN_FILE",
            "PIN_FILE_NAME",
            "DEFAULT_ENV_ROOT",
        ];
        // A plain loop, not an iterator chain. The first cut filtered a `map`ped Vec of
        // display strings and then `zip`ped the ORIGINAL entries back on — which desyncs
        // the moment the filter drops anything, so 33 unrelated files were reported as
        // naming the pin file. Caught immediately by the test, which is the one place a
        // mis-pairing was always going to show.
        let mut found: Vec<String> = Vec::new();
        for path in &entries {
            // NO `\\` -> `/` REWRITE. `git ls-files` always emits forward slashes on every
            // platform, so it bought nothing — and a blind audit created a file whose
            // BASENAME contains literal backslashes (`src-app\server\build_helper\
            // processor_manifest.rs`), which the rewrite rendered as an existing census
            // entry and thereby hid an unclassified reader in plain sight.
            let display = path.to_string_lossy().to_string();
            // `.lifecycle/` is stripped at merge — process records that discuss the pin
            // file at length and read nothing. Classifying ~20 of them would put entries in
            // the census that cease to exist the moment the branch lands.
            if display.starts_with(".lifecycle/") {
                continue;
            }
            let abs = repo.join(path);
            // `read`, not `read_to_string`: a file with one latin-1 byte is legal in git,
            // and `read_to_string` DROPPED it — so a new unclassified reader with a stray
            // byte evaded the census entirely. Found by a blind audit; the python side
            // already knew this class.
            let bytes = match std::fs::read(&abs) {
                Ok(b) => b,
                // A path git lists but that is not a regular file (a submodule gitlink, a
                // directory) is not a reader and is not an error.
                Err(_) if !abs.is_file() => continue,
                // A read ERROR on a listed regular file is a hard failure, not a silent
                // skip: git says it is part of this repository, so "I could not read it"
                // is a reason to stop rather than a reason to leave it out of the census.
                Err(e) => panic!(
                    "the census could not read `{}`, which git lists as part of this \
                     repository ({e}). A file the census cannot examine is a file it cannot \
                     classify, so this stops rather than leaving it out.",
                    abs.display()
                ),
            };
            let text = String::from_utf8_lossy(&bytes);
            if KEYS.iter().any(|k| text.contains(k)) {
                found.push(display);
            }
        }
        found.sort();
        found.dedup();
        found
    }

    fn repo_root() -> PathBuf {
        crate_dir().join("../..")
    }

    /// THE TRIPWIRE, as a function of its inputs — so it can be DRIVEN, not re-described.
    ///
    /// The first cut inlined this in `the_pin_file_has_exactly_two_parsers` and gave
    /// TEST-P19 a hand-built `Vec` plus a re-implementation of the predicate. A blind audit
    /// pointed out the obvious consequence: delete the whole assertion block from the real
    /// test and TEST-P19 stays green, because it never touched it. A guard whose failure
    /// mode is demonstrated against a COPY of the guard is not demonstrated at all.
    ///
    /// Returns `Err` with the diagnosis, or `Ok(number of parsers)`.
    fn census_verdict(
        candidates: &[String],
        census: &[(&str, PinFileRole, &str)],
    ) -> Result<usize, String> {
        let known: std::collections::BTreeSet<&str> =
            census.iter().map(|(p, _, _)| *p).collect();
        let unclassified: Vec<&String> = candidates
            .iter()
            .filter(|p| !known.contains(p.as_str()))
            .collect();
        if !unclassified.is_empty() {
            return Err(format!(
                "these files name the pin file and are not in the census: {unclassified:?}.\n\
                 Classify each in `PIN_FILE_READERS`. If one PARSES the file — its own line \
                 rule, comment rule and token rule over the bytes — it is another grammar \
                 and it should read `env-rootfs/{ENV_PIN_ARTEFACT}` instead \
                 (docs/design/pin-file-single-parse.md). If it only mentions the name, \
                 record it as a NearMiss with the reason."
            ));
        }
        Ok(census
            .iter()
            .filter(|(_, role, _)| *role == PinFileRole::Parser)
            .count())
    }

    /// **TEST-P1** [acceptance] [invariant: INV-1] — the pin-file parser census.
    ///
    /// This is the number #214 exists to move: **11 → 3**, of which two are ours (the third
    /// is `uv`, which parses the python recipe's pin file and which this repository cannot
    /// remove — see `PIN_FILE_PARSERS`). The function's NAME still says "two" and is kept
    /// that way deliberately: it is cited from the design doc and from the issue, and
    /// renaming it would detach it from what it implements. The assertion is what is
    /// authoritative, and it says three.
    ///
    /// The claim is checked two ways, and the second is why the first is not merely a
    /// comment with a compiler behind it.
    #[test]
    fn the_pin_file_has_exactly_two_parsers() {
        // 1. THE COUNT. One place in the tree writes it down, and the refusal message
        //    derives from that same place.
        let parsers: Vec<&str> = PIN_FILE_READERS
            .iter()
            .filter(|(_, role, _)| *role == PinFileRole::Parser)
            .map(|(p, _, _)| *p)
            .collect();
        assert_eq!(
            parsers.len(),
            3,
            "the pin file must have exactly THREE parsers — this build gate, the R \
             recipe's installer, and `uv` for the python lane — of which only the first \
             two are code this repository writes. The census names {parsers:?}. A FOURTH \
             is the defect class #214 closed: the pairs that can disagree grow \
             quadratically in this number, and four audit rounds each produced three \
             exploitable defects from exactly that. If another parser is genuinely \
             unavoidable, that is a DESIGN change — amend \
             docs/design/pin-file-single-parse.md and say why, do not raise this number."
        );
        assert_eq!(
            parsers.len(),
            PIN_FILE_PARSERS.len(),
            "the census and the refusal message disagree about how many parsers there are"
        );

        // 2. THE DERIVED CANDIDATE SET. A file that names the pin file and is not
        //    classified is RED — this is what stops a new reader appearing unnoticed.
        let repo = repo_root();
        let found = files_naming_the_pin_file(&repo);
        assert!(
            found.len() >= 20,
            "the scan found only {} file(s) naming `{ENV_PIN_FILE}` — it has collapsed and \
             was about to certify a census of nothing. Found: {found:?}",
            found.len()
        );
        // The verdict over the REAL candidate set. Its parser count is the same value
        // asserted above (both are `PIN_FILE_READERS.filter(Parser).count()`), so it is not
        // re-asserted here — a blind audit pointed out that doing so compared an expression
        // to itself. What this call adds is the UNCLASSIFIED check over the derived set,
        // which is the half that can actually fail.
        census_verdict(&found, PIN_FILE_READERS).unwrap_or_else(|e| panic!("{e}"));

        // 3. …and every classified file still exists, so the census cannot rot into a list
        //    of paths that stopped being true.
        for (p, _, _) in PIN_FILE_READERS {
            assert!(
                repo.join(p).exists(),
                "the census names `{p}`, which no longer exists. A census of files that are \
                 gone is a census that has stopped ranging over anything."
            );
        }
    }

    /// **TEST-P19** — the census tripwire can FAIL. A guard whose failure mode has never
    /// been demonstrated is a guard nobody has checked (#192's own rule).
    #[test]
    fn the_census_tripwire_refuses_an_unclassified_reader() {
        // (a) AN UNKNOWN FILE naming the pin file: the real predicate, driven, over the
        //     REAL candidate set.
        //
        // The first cut built `found` from `PIN_FILE_READERS` itself, so `unclassified` was
        // structurally empty and the "control: the real census must be clean" leg could not
        // fail — a blind audit put a genuinely unclassified reader in the tree and watched
        // TEST-P1 go red while this leg stayed green. A control derived from the thing it
        // controls is not a control.
        let mut found = files_naming_the_pin_file(&repo_root());
        // The SAME anti-collapse floor TEST-P1 has. Without it, a collapsed derivation
        // makes leg (a) read `Ok(3)` and leg (b) `Ok(4)` and both pass vacuously — the
        // control would be controlling an empty set.
        assert!(
            found.len() >= 20,
            "the derived candidate set collapsed to {} file(s) — this case would prove \
             nothing about the tripwire",
            found.len()
        );
        assert_eq!(
            census_verdict(&found, PIN_FILE_READERS),
            Ok(3),
            "control: the real census must be clean, or the case below proves nothing"
        );
        found.push("src-app/packages/newcomer/tests/test_it.py".into());
        let err = census_verdict(&found, PIN_FILE_READERS)
            .expect_err("an unclassified reader must be refused");
        assert!(err.contains("newcomer"), "the refusal must name the file: {err}");
        assert!(
            err.contains(ENV_PIN_ARTEFACT),
            "the refusal must say what to read instead: {err}"
        );

        // (b) A FOURTH PARSER, classified honestly but still a fourth grammar — the other
        //     way a new parser arrives. Driven through the same function.
        let mut census: Vec<(&str, PinFileRole, &str)> = PIN_FILE_READERS.to_vec();
        census.push(("src-app/packages/newcomer/tests/test_it.py", PinFileRole::Parser, "a fourth"));
        assert_eq!(
            census_verdict(&found, &census),
            Ok(4),
            "the verdict must COUNT a newly classified parser, so the count assertion in \
             the real test is what refuses it"
        );
    }

    /// **TEST-P2** [acceptance] [invariant: INV-2] — the four historical exploits are
    /// REFUSED OR UNREPRESENTABLE.
    ///
    /// This is #214's acceptance test. Each byte below is a real, demonstrated exploit from
    /// #192's audit rounds 2-4, replayed at the placement that made it work:
    ///
    /// | byte | who disagreed with whom | what it did |
    /// |---|---|---|
    /// | `U+00A0` NBSP in a directive | Rust `str::trim` (Unicode) vs POSIX `[[:space:]]` | a directive to the gate, prose to the installer — a gate bypass |
    /// | lone `CR` | `str::lines()` (LF only) vs R `readLines` (CR too) | a comment fragment to Rust, a whole directive line to the program that installs |
    /// | `U+000B` | `is_ascii_whitespace` (false) vs POSIX `[[:space:]]` (true) | invisible to the gate, live to the installer |
    /// | `U+001C` | `char::is_whitespace` (false) vs `str.splitlines()` (breaks) | the gate read a comment (pin absent) while python counted it and every floor stayed green |
    ///
    /// The claim is stronger than "each is refused". Under this design a poisoned tree
    /// produces **NO ARTEFACT AT ALL**, so there is nothing for a consumer to read and
    /// therefore nothing it could answer differently from the gate. That is what INV-2
    /// means by *unrepresentable* rather than *refused*: the question "do these two readers
    /// agree about where this line ends?" cannot be asked of the artefact, because only one
    /// of them reads lines.
    #[test]
    fn the_four_historical_exploits_are_refused_or_unrepresentable() {
        // The exact placements, from FIX_ROUND-2/3/4.
        let cases: [(&str, &str, String); 4] = [
            (
                "NBSP in a cyto:pin-source directive (round 2, SEC-1)",
                "U+00A0",
                format!(
                    "# cyto:ecosystem=python\n\
                     # cyto:pin-source=immutable-index:https://example.invalid/simple\n\
                     #\u{a0}cyto:pin-source=dated-snapshot:https://attacker.invalid/cran\n\
                     alpha==1.0  # import=alpha\n"
                ),
            ),
            (
                "a lone CR smuggling a directive line (round 3)",
                "U+000D",
                format!(
                    "# cyto:ecosystem=python\n\
                     # cyto:pin-source=immutable-index:https://example.invalid/simple\n\
                     # see the runbook\r# cyto:pin-source=dated-snapshot:https://attacker.invalid/cran\n\
                     alpha==1.0  # import=alpha\n"
                ),
            ),
            (
                "U+000B before a directive (round 3)",
                "U+000B",
                format!(
                    "# cyto:ecosystem=python\n\
                     # cyto:pin-source=immutable-index:https://example.invalid/simple\n\
                     #\u{b}cyto:pin-source=dated-snapshot:https://attacker.invalid/cran\n\
                     alpha==1.0  # import=alpha\n"
                ),
            ),
            (
                "U+001C hiding a real pin from the gate (round 4 — the one that ended the \
                 guard-widening approach)",
                "U+001C",
                format!(
                    "# cyto:ecosystem=python\n\
                     # cyto:pin-source=immutable-index:https://example.invalid/simple\n\
                     alpha==1.0  # import=alpha\n\
                     beta==2.0   # import=beta\n\
                     \u{1c}gamma==3.0  # import=gamma\n"
                ),
            ),
        ];

        for (label, codepoint, pins) in &cases {
            let fx = PinFixture::new("exploit");
            fx.recipe("envx", pins);

            let err = match fx.generate() {
                Err(e) => e,
                Ok(_) => panic!(
                    "{label}: generated an artefact from a poisoned pin file — the byte \
                     reached a consumer, which is the whole defect"
                ),
            };
            assert!(
                err.contains(codepoint),
                "{label}: the refusal must name the codepoint {codepoint}, so the reader \
                 knows WHICH byte: {err}"
            );
            assert!(
                err.contains("envx"),
                "{label}: the refusal must name the recipe: {err}"
            );

            // UNREPRESENTABLE, not merely refused: no artefact exists, so the consumer
            // cannot be handed a parse at all — let alone one that disagrees with the gate.
            assert!(
                !fx.path().join(ENV_PIN_ARTEFACT).exists(),
                "{label}: a poisoned tree produced an artefact; a consumer could then read \
                 a pin set the gate never agreed to"
            );
            let downstream = read_env_pin_artefact(fx.path()).expect_err(
                "with no artefact a consumer must REFUSE, never fall back to parsing",
            );
            assert!(
                downstream.contains(ENV_PIN_REGEN_CMD),
                "{label}: the consumer's refusal must say how to fix it: {downstream}"
            );
        }

        // POSITIVE CONTROL — the byte-for-byte identical tree WITHOUT the poison byte
        // generates cleanly and yields the pins. Without this, every assertion above is
        // satisfied by a fixture that never built.
        let ok = PinFixture::new("exploit-control");
        ok.recipe("envx", FIX_PINS);
        let json = ok.commit();
        assert!(json.contains("\"gamma\""), "the control must carry all three pins");
        let art = read_env_pin_artefact(ok.path()).expect("the control tree must generate");
        assert_eq!(
            art.get("envx").expect("recipe present").pins.len(),
            3,
            "the control must yield exactly the three pins written"
        );
    }

    /// **TEST-P23** — the pin GRAMMAR refuses what `uv` would read differently.
    ///
    /// A blind audit demonstrated this end to end: `packaging==25.0 ; sys_platform in
    /// "nope"` parsed as a clean exact pin (a PEP 508 marker attaches after the VERSION,
    /// and the gate only tested for `;` in the NAME half — none of the blacklisted
    /// characters appear in `in`). `uv` then evaluated the marker as false and installed a
    /// DIFFERENT version transitively. The pin was in the file so every floor was green;
    /// the package was present so the smoke import passed; no manifest declares
    /// `packaging` so the version was never compared. Eighteen appended characters turned
    /// an explicit pin into a lie.
    ///
    /// That is a gate ⇄ `uv` disagreement — the class #214 exists to close, between two
    /// parsers one of which had been argued out of the census (see `PIN_FILE_PARSERS`).
    #[test]
    fn a_pin_the_gate_and_uv_would_read_differently_is_refused() {
        for (label, line) in [
            (
                "a PEP 508 environment marker, the demonstrated exploit",
                "packaging==25.0 ; sys_platform in \"nope\"  # import=packaging",
            ),
            (
                "the same marker with the `<` form the old charset did catch",
                "packaging==25.0 ; python_version < \"4\"  # import=packaging",
            ),
            ("a direct reference", "alpha==1.0 @ https://evil.invalid/x.whl  # import=alpha"),
            ("a trailing continuation", "alpha==1.0 \\  # import=alpha"),
            ("an option line read as a pin", "--index-url==https://evil.invalid/simple  # import=x"),
            ("a URL read as a distribution", "https://evil.invalid/x.whl==1.0  # import=x"),
            ("an extras marker", "alpha[extra]==1.0  # import=alpha"),
        ] {
            let err = parse_env_pins_detailed(&format!("{line}\n"), EnvEcosystem::Python)
                .expect_err(&format!("{label}: `{line}` must be refused"));
            assert!(
                err.contains("line 1"),
                "{label}: the refusal must name the line: {err}"
            );
        }

        // CONTROLS — every LEGAL spelling still parses, in both ecosystems. Without these
        // the refusals above are satisfied by a parser that rejects everything, and the
        // R-side cases are the ones a whitespace-or-punctuation rule would break first.
        for (label, line, eco, want) in [
            ("a plain python pin", "alpha==1.0  # import=alpha", EnvEcosystem::Python, "1.0"),
            (
                "a PEP 440 post-release",
                "alpha==2.9.0.post0  # import=alpha",
                EnvEcosystem::Python,
                "2.9.0.post0",
            ),
            (
                "a python name needing the PEP 503 fold",
                "Scikit.Learn==1.0  # import=sklearn",
                EnvEcosystem::Python,
                "1.0",
            ),
            (
                "an R DESCRIPTION dash version",
                "Matrix==1.7-6  # import=Matrix",
                EnvEcosystem::R,
                "1.7-6",
            ),
            (
                "an R dash version with a leading zero",
                "refund==0.1-40  # import=refund",
                EnvEcosystem::R,
                "0.1-40",
            ),
            (
                "padding around the operator is legal spelling",
                "alpha ==1.0  # import=alpha",
                EnvEcosystem::Python,
                "1.0",
            ),
        ] {
            let pins = parse_env_pins_detailed(&format!("{line}\n"), eco)
                .unwrap_or_else(|e| panic!("{label}: `{line}` must PARSE, got: {e}"));
            assert_eq!(pins.len(), 1, "{label}");
            assert_eq!(pins[0].version, want, "{label}");
        }

        // …and the SHIPPED files still parse, which is the control that matters most: a
        // tightening that broke a real recipe would be caught here rather than by a build.
        assert_eq!(
            shipped_total_pins(),
            MIN_TOTAL_PINS,
            "the shipped recipes must still parse to exactly the frozen total after the \
             grammar was tightened"
        );
    }

    /// **TEST-P3** [acceptance] [invariant: INV-3] — the canonical-bytes precondition is
    /// reached UNCONDITIONALLY.
    ///
    /// Round 4 of #192 found it inside `read_env_recipes`, reached only from
    /// `lint_declared_dependencies`, which returns `Ok(())` immediately when no package
    /// declares a `run.dependencies` or an `env`. So "are these bytes canonical" was a side
    /// effect of asking a different question, and **in a tree where nothing declared a
    /// dependency, no pin file was checked at all** while every other reader went on
    /// parsing them. Nothing tested that configuration; this does.
    #[test]
    fn the_precondition_is_reached_even_when_nothing_declares_a_dependency() {
        let fx = PinFixture::new("nodecl");
        // A poisoned pin file — the U+001C case, the one that defeated both previous
        // implementations of the precondition.
        fx.recipe(
            "envx",
            "# cyto:ecosystem=python\n\
             # cyto:pin-source=immutable-index:https://example.invalid/simple\n\
             alpha==1.0  # import=alpha\n\
             \u{1c}beta==2.0  # import=beta\n",
        );

        // A package tree in which NOTHING declares a dependency or an env — the exact
        // configuration under which the gate used to short-circuit before checking a byte.
        let pkgs = fx.path().join("__packages");
        std::fs::create_dir_all(pkgs.join("plain")).expect("mkdir pkg");
        // WELL-FORMED, and declaring NOTHING: no `run.dependencies`, no `env`. That is the
        // whole point — the gate used to short-circuit on exactly this shape, so a
        // malformed manifest here would fail earlier for the wrong reason and prove
        // nothing about the precondition.
        std::fs::write(pkgs.join("plain/manifest.yaml"), NO_DECL_MANIFEST)
            .expect("write manifest");

        let err = lint_processor_tree_with_env(&pkgs, Some(fx.path()))
            .expect_err("a poisoned pin file must be refused even with nothing declared");
        assert!(
            err.contains("U+001C") && err.contains("envx"),
            "the refusal must come from the canonical-bytes precondition and name the \
             recipe — not from some later check that happened to trip: {err}"
        );

        // CONTROL: the same package tree with a CLEAN pin file passes, so the refusal above
        // is attributable to the byte and not to the fixture being malformed.
        let ok = PinFixture::new("nodecl-control");
        ok.recipe("envx", FIX_PINS);
        let okpkgs = ok.path().join("__packages");
        std::fs::create_dir_all(okpkgs.join("plain")).expect("mkdir pkg");
        std::fs::write(okpkgs.join("plain/manifest.yaml"), NO_DECL_MANIFEST)
            .expect("write manifest");
        lint_processor_tree_with_env(&okpkgs, Some(ok.path()))
            .expect("the control tree must pass, or the case above proves nothing");
    }

    /// **TEST-P4** [acceptance] [invariant: INV-4] — a STALE artefact is an error.
    #[test]
    fn a_stale_exported_parse_is_refused_at_build_time() {
        let fx = PinFixture::new("stale");
        fx.recipe("envx", FIX_PINS);
        let fresh = fx.commit();

        // CONTROL FIRST — a fresh artefact passes, so "the check fires" is distinguishable
        // from "the check always fires".
        env_pin_artefact_check_or_write(fx.path())
            .expect("a freshly generated artefact must pass the freshness check");

        // (a) a HAND-EDITED artefact: the version changed, the pin file did not.
        std::fs::write(
            fx.path().join(ENV_PIN_ARTEFACT),
            fresh.replace("\"1.0\"", "\"9.9\""),
        )
        .expect("write mutated artefact");
        let err = env_pin_artefact_check_or_write(fx.path())
            .expect_err("a hand-edited artefact must be refused");
        assert!(err.contains("STALE"), "{err}");
        assert!(
            err.contains(ENV_PIN_REGEN_CMD),
            "the refusal must name the regeneration command: {err}"
        );

        // (b) a MOVED PIN with a stale artefact — the realistic case, and the one that
        //     matters: someone edits a pin and forgets to regenerate.
        std::fs::write(fx.path().join(ENV_PIN_ARTEFACT), &fresh).expect("restore");
        std::fs::write(
            fx.path().join("envx").join(ENV_PIN_FILE),
            FIX_PINS.replace("alpha==1.0", "alpha==1.1"),
        )
        .expect("move a pin");
        let err = env_pin_artefact_check_or_write(fx.path())
            .expect_err("a pin edited without a regen must be refused");
        assert!(err.contains("STALE"), "{err}");

        // (c) a DELETED artefact fails rather than being treated as "nothing to compare".
        std::fs::remove_file(fx.path().join(ENV_PIN_ARTEFACT)).expect("rm artefact");
        let err = env_pin_artefact_check_or_write(fx.path())
            .expect_err("a missing artefact must be refused, never skipped");
        assert!(err.contains("missing"), "{err}");
    }

    /// **TEST-P5** [acceptance] [invariant: INV-5] — the DELETION direction still reddens,
    /// and the artefact does not supply the value that would make it stop.
    ///
    /// This design makes the forbidden move cheap: a derived pin count is now one
    /// `json.load` away from every floor that exists to catch a removal. A floor compared
    /// against a count carried in the artefact would be a derivation whose two sides read
    /// the same source — a tautology in exactly the direction the floor exists for
    /// (`docs/design/derived-guards.md` §4). So the artefact refuses to carry one.
    #[test]
    fn the_exported_parse_carries_no_cardinality_and_a_removal_still_reddens() {
        // (a) STRUCTURAL: no total/count/cardinality key at any depth of the SHIPPED
        //     artefact. A consumer cannot re-point a floor at a value that does not exist.
        // KEYS, walked recursively — not a substring scan of the whole file.
        //
        // The first cut searched the artefact's TEXT for "total"/"count"/…, which matches
        // pin NAMES, import tokens and coordinates as well as keys: a blind audit pointed
        // out that a `pycountry` pin (a real PyPI distribution) or a coordinate containing
        // `total` would redden it, with a message insisting it was a key. The python twin
        // walked keys and got this right, so the two implementations of one check
        // disagreed — the miniature of this whole issue, inside its own test.
        let shipped: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(repo_root().join("src-app/env-rootfs").join(ENV_PIN_ARTEFACT))
                .expect("the shipped artefact is readable"),
        )
        .expect("the shipped artefact is valid JSON");

        fn keys(v: &serde_json::Value, out: &mut Vec<String>) {
            match v {
                serde_json::Value::Object(m) => {
                    for (k, val) in m {
                        out.push(k.clone());
                        keys(val, out);
                    }
                }
                serde_json::Value::Array(a) => a.iter().for_each(|val| keys(val, out)),
                _ => {}
            }
        }
        let mut all_keys = Vec::new();
        keys(&shipped, &mut all_keys);
        assert!(
            all_keys.len() > 20,
            "the key walk found only {} keys — it is not seeing the artefact",
            all_keys.len()
        );
        for k in &all_keys {
            let lower = k.to_ascii_lowercase();
            for banned in ["total", "count", "n_pins", "cardinality", "num_"] {
                assert!(
                    !lower.contains(banned),
                    "the exported parse carries the key {k:?}. A cardinality here moves with \
                     the pin file, so any floor compared against it is blind to a deletion — \
                     which is the ONE direction those floors exist for. Compute `len(pins)` \
                     in the consumer and compare against a literal it holds."
                );
            }
        }

        // (b) BEHAVIOURAL: remove a pin and the derived count drops, so a floor held as a
        //     literal in a consumer goes red. The floor is NOT read from the artefact.
        let fx = PinFixture::new("deletion");
        fx.recipe("envx", FIX_PINS);
        let before = read_env_pin_artefact({
            fx.commit();
            fx.path()
        })
        .expect("generate")
        .get("envx")
        .expect("recipe")
        .pins
        .len();
        assert_eq!(before, 3);

        let one_gone: String = FIX_PINS
            .lines()
            .filter(|l| !l.trim_start().starts_with("gamma=="))
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        std::fs::write(fx.path().join("envx").join(ENV_PIN_FILE), one_gone).expect("write");
        let after = generate_env_pin_artefact(fx.path()).expect("regenerate");
        let after_n = serde_json::from_str::<EnvPinArtefact>(&after)
            .expect("parse")
            .get("envx")
            .expect("recipe")
            .pins
            .len();
        assert_eq!(
            after_n,
            before - 1,
            "removing a pin must reduce the exported count — if it did not, every floor \
             below is comparing two numbers that move together"
        );

        // …and the SHIPPED tree's real floor is a literal, which is what makes the drop
        // visible. `MIN_TOTAL_PINS` is a `const` in this file, not a value read from the
        // artefact; one pin removed from the real tree puts it below.
        assert!(
            shipped_total_pins() - 1 < MIN_TOTAL_PINS,
            "with one pin removed the tree would hold {} pin(s), which is NOT below the \
             floor of {MIN_TOTAL_PINS} — the floor has acquired slack and can no longer see \
             the removal it exists for",
            shipped_total_pins() - 1
        );
    }

    /// **TEST-P20** — the ADDITION direction is seen. The pair to TEST-P5: a floor that
    /// only ever goes down is half a mutation battery.
    #[test]
    fn adding_a_pin_changes_the_exported_parse_and_goes_stale_until_regenerated() {
        let fx = PinFixture::new("addition");
        fx.recipe("envx", FIX_PINS);
        fx.commit();
        env_pin_artefact_check_or_write(fx.path()).expect("fresh");

        std::fs::write(
            fx.path().join("envx").join(ENV_PIN_FILE),
            format!("{FIX_PINS}delta==4.0  # import=delta\n"),
        )
        .expect("add a pin");

        // The ADDED pin makes the committed artefact stale — so the build refuses until
        // someone regenerates, which is how the addition becomes visible in review.
        let err = env_pin_artefact_check_or_write(fx.path())
            .expect_err("an ADDED pin must make the artefact stale");
        assert!(err.contains("STALE"), "{err}");

        let regenerated = generate_env_pin_artefact(fx.path()).expect("regenerate");
        let art: EnvPinArtefact = serde_json::from_str(&regenerated).expect("parse");
        let pins = &art.get("envx").expect("recipe").pins;
        assert_eq!(pins.len(), 4, "the new pin must appear");
        let delta = pins.iter().find(|p| p.name == "delta").expect("delta present");
        assert_eq!(delta.version, "4.0");
        assert_eq!(
            delta.import, "delta",
            "the added pin must carry its import token — the guard downstream is keyed on it"
        );
    }

    /// **TEST-P6** — the `# import=<module>` grammar now lives in the GATE's parser, which
    /// is what let `env_image.rs`'s copy be deleted, and it keeps the word-anchoring fix
    /// that copy had learned the hard way.
    #[test]
    fn the_gate_parses_the_import_token_and_anchors_it_to_a_word() {
        let pins = parse_env_pins_detailed(
            "alpha==1.0  # import=alpha\n\
             beta==2.0   # do not reimport=zzz here\n\
             gamma==3.0  # import=gamma, and prose after\n",
            EnvEcosystem::Python,
        )
        .expect("parses");
        assert_eq!(pins.len(), 3);
        assert_eq!(pins[0].import.as_deref(), Some("alpha"));
        assert_eq!(
            pins[1].import, None,
            "`reimport=zzz` must NOT yield the module `zzz` — a bare `split_once` matched \
             inside another token and keyed a pin to whatever a sentence happened to \
             contain. That fix moved here with the grammar."
        );
        assert_eq!(
            pins[2].import.as_deref(),
            Some("gamma"),
            "a trailing comma must not be swallowed into the module name"
        );
        assert_eq!(pins[0].line, 1);
        assert_eq!(pins[2].line, 3, "the source line travels with the pin");

        // The REQUIREMENT is enforced where a real recipe is in view, so the message can
        // name the recipe and the line (DEC-4).
        let fx = PinFixture::new("noimport");
        fx.recipe(
            "envx",
            "# cyto:ecosystem=python\n\
             # cyto:pin-source=immutable-index:https://example.invalid/simple\n\
             alpha==1.0\n",
        );
        let err = fx
            .generate()
            .expect_err("a recipe pin with no import token must be refused");
        assert!(err.contains("import=") && err.contains("alpha"), "{err}");

        // …and the RAW spelling survives the fold, which is what a guard asserting what the
        // file literally says needs. Under python's PEP 503 fold they differ.
        let folded = parse_env_pins_detailed(
            "Scikit.Learn==1.0  # import=sklearn\n",
            EnvEcosystem::Python,
        )
        .expect("parses");
        assert_eq!(folded[0].name, "scikit-learn", "the fold applies to `name`");
        assert_eq!(
            folded[0].raw_name, "Scikit.Learn",
            "`raw_name` is the unfolded spelling — recovering it by re-reading the file is \
             exactly the extra grammar this field exists to remove"
        );
    }

    /// **TEST-P7** — generation is DETERMINISTIC, and does not depend on the order the
    /// filesystem hands back directory entries. A generated file whose bytes depend on
    /// readdir order goes spuriously stale on another machine, which trains people to
    /// regenerate reflexively — and a regeneration nobody reads is a review step deleted.
    #[test]
    fn the_exported_parse_is_byte_deterministic() {
        let fx = PinFixture::new("determinism");
        // Created in an order that is NOT the sorted order.
        fx.recipe("zzz-last", FIX_PINS);
        fx.recipe("aaa-first", FIX_PINS);
        fx.recipe("mmm-middle", FIX_PINS);

        let a = fx.generate().expect("gen 1");
        let b = fx.generate().expect("gen 2");
        assert_eq!(a, b, "two generations of the same tree must be byte-identical");

        let ai = a.find("aaa-first").expect("aaa present");
        let mi = a.find("mmm-middle").expect("mmm present");
        let zi = a.find("zzz-last").expect("zzz present");
        assert!(
            ai < mi && mi < zi,
            "recipes must be emitted in sorted order regardless of creation order"
        );
        assert!(a.ends_with('\n'), "the artefact must end with a newline");
    }

    /// **TEST-P8** — no BOOTSTRAP DEADLOCK. If the check were the only path, a stale
    /// artefact would fail the build, and the build is the only thing that can refresh it.
    #[test]
    fn a_stale_artefact_can_always_be_regenerated() {
        let fx = PinFixture::new("bootstrap");
        fx.recipe("envx", FIX_PINS);
        std::fs::write(fx.path().join(ENV_PIN_ARTEFACT), "{ \"garbage\": true }\n")
            .expect("plant a stale artefact");

        // The COMPARE path errors on this input…
        env_pin_artefact_check_or_write(fx.path())
            .expect_err("a garbage artefact must fail the compare path");

        // …and the WRITE path fixes it, on the same input, with no intermediate step.
        let guard = RegenVar::set();
        env_pin_artefact_check_or_write(fx.path())
            .expect("the regen path must succeed against a stale artefact");
        drop(guard);

        env_pin_artefact_check_or_write(fx.path())
            .expect("after regeneration the compare path must pass");
    }

    /// **TEST-P9** — the COMPARE path never writes. `build.rs` runs on every build; a build
    /// script that silently mutates the source tree would make the artefact's whole
    /// reviewable-diff property a lie.
    #[test]
    fn the_freshness_check_never_writes_unless_asked() {
        let fx = PinFixture::new("nowrite");
        fx.recipe("envx", FIX_PINS);
        let planted = "{ \"schema_version\": 1, \"recipes\": {} }\n";
        std::fs::write(fx.path().join(ENV_PIN_ARTEFACT), planted).expect("plant");

        env_pin_artefact_check_or_write(fx.path())
            .expect_err("a stale artefact must fail rather than be silently repaired");

        let after = std::fs::read_to_string(fx.path().join(ENV_PIN_ARTEFACT)).expect("read");
        assert_eq!(
            after, planted,
            "the compare path modified the artefact. A build that repairs its own inputs \
             makes every stale artefact invisible: the first person to build would fix it \
             and commit the fix without noticing the pin change it belonged to."
        );
    }

    /// Serialises the tests that touch `CYTO_REGEN_ENV_PINS`, and restores it.
    ///
    /// `std::env::set_var` is process-global, so two tests toggling it concurrently would
    /// make each other flaky — and a flaky guard is a guard people re-run until it is
    /// green, which is worse than not having it.
    struct RegenVar(Option<std::sync::MutexGuard<'static, ()>>);

    static REGEN_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    impl RegenVar {
        fn set() -> Self {
            let g = REGEN_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            // SAFETY: the mutex above makes this the only thread mutating the variable, and
            // it is restored on drop.
            unsafe { std::env::set_var(ENV_PIN_REGEN_VAR, "1") };
            Self(Some(g))
        }
    }

    impl Drop for RegenVar {
        fn drop(&mut self) {
            unsafe { std::env::remove_var(ENV_PIN_REGEN_VAR) };
            self.0.take();
        }
    }

    /// **TEST-P17** — the refusal message states the count that is TRUE, and it DERIVES it.
    ///
    /// The previous message said *"the FIVE programs that parse this file"* and named five.
    /// It had been typed once and every later change left it behind; by the time #214
    /// started, the real number was ten. A refusal that misstates its own reason teaches
    /// the reader the reason is decorative.
    #[test]
    fn the_canonicality_refusal_derives_its_parser_count() {
        let err = assert_canonical_pin_bytes("alpha==1.0\n\u{1c}beta==2.0\n")
            .expect_err("U+001C is refused");
        assert!(
            err.contains(&format!("the {} programs", PIN_FILE_PARSERS.len())),
            "the message must derive its count from the census: {err}"
        );
        assert!(
            !err.contains("FIVE") && !err.contains("five programs"),
            "the stale hand-typed count is back: {err}"
        );
        for p in PIN_FILE_PARSERS {
            assert!(
                err.contains(p),
                "the message must name each parser from the census: {err}"
            );
        }
    }

    /// **TEST-P18** — the design doc is LOAD-BEARING, not decorative.
    ///
    /// A design that the code has drifted from is worse than no design: it certifies the
    /// drift. So the doc's own claims about the count and the two parsers are checked
    /// against the code that enforces them.
    #[test]
    fn the_design_doc_and_the_code_agree_about_the_census() {
        let doc = std::fs::read_to_string(
            repo_root().join("docs/design/pin-file-single-parse.md"),
        )
        .expect("the named design must exist — the plan is derived from it");

        for inv in ["INV-1", "INV-2", "INV-3", "INV-4", "INV-5"] {
            assert!(
                doc.contains(&format!("**{inv}**")),
                "the design's §6 must state {inv}; the acceptance tests are tagged against it"
            );
        }
        assert!(
            doc.contains("**After = 3 parsers"),
            "the design's §7 must state the after-count that this module enforces"
        );
        assert!(
            doc.contains("PIN_FILE_ALLOWED_NON_ASCII") || doc.contains("allowlist"),
            "the design must describe the allowlist rule the precondition applies"
        );
        assert!(
            doc.contains(ENV_PIN_ARTEFACT),
            "the design must name the artefact path the code writes"
        );
        assert!(
            doc.contains(ENV_PIN_REGEN_CMD),
            "the design must name the regeneration command the refusals point at"
        );
        // The two parsers the CODE names must be recognisable in the doc's after-table.
        assert!(
            doc.contains("processor_manifest.rs") && doc.contains("single-cell-r/Dockerfile"),
            "the design's after-table must name the two parsers the census names"
        );
    }
}
