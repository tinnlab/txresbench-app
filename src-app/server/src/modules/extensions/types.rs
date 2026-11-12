//! The extension-manifest type contract (ITEM-1/10). serde + JsonSchema structs
//! mirroring `src-app/packages/<id>/manifest.yaml` — authored once in Rust,
//! parsed from YAML at boot (`serde_norway`), and dumped verbatim over
//! `GET /api/extensions` (so every field is serializable). As of the modular seam
//! (ITEM-1 / DEC-19/DEC-20-amended) a manifest also CONTRIBUTES domain datatypes
//! (`Contributes.datatypes` → `DatatypeContribution`) merged into the datatype
//! registry, in addition to declaring converters + views.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::modules::datatype::types::{
    ArrayDecl, AxisSpec, ConverterRef, Datatype, FileLayout, IngestSpec, InputRequirements,
    LayoutKind, StorageSpec, ViewerRef,
};

/// One extension = one `manifest.yaml` folder. The registry holds one of these per
/// discovered `extensions/<id>/manifest.yaml`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ExtensionManifest {
    /// Stable extension id — the package's own directory name under `packages/`.
    pub id: String,
    /// Human-readable name.
    pub name: String,
    /// Publisher / owner.
    pub publisher: String,
    /// Extension version (semver string).
    pub version: String,
    /// The manifest-schema version this extension targets.
    #[serde(rename = "apiVersion")]
    pub api_version: String,
    /// The contribution kinds (converters / views / datatypes) this extension adds.
    #[serde(default)]
    pub contributes: Contributes,
}

/// The contribution kinds an extension adds. `datatypes` is now ACTIVE (ITEM-1 /
/// DEC-19/DEC-20-amended): an extension folder contributes DOMAIN datatypes — its own
/// namespaced types, `annotation-table`, whatever a future field needs — that the
/// loader MERGES into the datatype registry alongside the Rust-registered lattice
/// roots. A new domain is a new `extensions/<id>/` folder with ZERO core edit, which
/// is precisely why the core names no domain of its own.
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct Contributes {
    /// Auto/parametric converters this extension declares.
    #[serde(default)]
    pub converters: Vec<ConverterContribution>,
    /// Viewer contributions (per-datatype UI panels).
    #[serde(default)]
    pub views: Vec<ViewContribution>,
    /// Datatype declarations merged into the datatype registry (ITEM-1/2). Core
    /// ROOT/abstract types (`data`/`tabular`/`matrix`) stay Rust-registered; DOMAIN
    /// datatypes are manifest-contributed here (DEC-20-amended).
    #[serde(default)]
    pub datatypes: Vec<DatatypeContribution>,
    /// The FE analysis contributions (`ProcessorManifestData`), carried through
    /// LOSSLESSLY (see [`AnalysisContributionData`]) so `GET /api/extensions` stays
    /// byte-faithful, while the backend reads the ONE sub-block it owns: the
    /// declarative METHODS narration (S3).
    #[serde(default)]
    pub analyses: Vec<AnalysisContributionData>,
    /// INTERACTION ACTIONS this extension adds to the provenance capture vocabulary
    /// (S4). Before this, `provenance::action_registry::catalog()` was a CLOSED
    /// code-defined list: a package shipping a new user gesture could not have it
    /// captured without a server rebuild. A contributed action names the recipe
    /// DIALECT it posts, and the emitter compiles it with the same domain-free
    /// `select(ctx)` machinery the built-in actions use — so the recorded
    /// `code_sha256` attests to a real, runnable script for a contributed action too.
    #[serde(default)]
    pub actions: Vec<ActionContribution>,
    /// VISUALIZE-PANE SECTIONS this package contributes (ITEM-1). A section is a
    /// declarative `view_spec` rendering as one block inside a shared pane's single
    /// scroll track — its own first-class contribution kind, NOT an analysis carrying
    /// a flag (DEC-1) and NOT a view: it registers into the FE's `registry.sections`
    /// slot and therefore never reaches `placeViews` / `viewAutomountGate` /
    /// `assertContributableArea`. The centre reservation is unreachable from this path
    /// by construction.
    ///
    /// Additive by the same rule every other key here follows — `#[serde(default)]`,
    /// so every manifest that predates sections parses byte-identically.
    #[serde(default)]
    pub sections: Vec<SectionContribution>,
}

/// ONE `contributes.sections[]` entry — a block in a pane's stack (ITEM-1).
///
/// `deny_unknown_fields` on purpose, mirroring [`ActionContribution`]: the FIELD SET IS
/// THE CONTRACT. `pane:` is the key that says which stack this belongs to, and it is
/// deliberately not spelled `area` / `region` / `role` — those three words all name the
/// *docking* vocabulary a section must never reach. Denial is what makes that a parse
/// error naming the key rather than a section that silently never renders.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SectionContribution {
    /// Stable section id, unique within the package (e.g. `sc.coordinates`). It is the
    /// id the user's saved section order refers to.
    pub id: String,
    /// The section header's title.
    pub title: String,
    /// WHICH pane's stack this section joins (e.g. `visualize`). A pane KIND, not an
    /// area / region / role — a section never docks and never opens a pane. Free-form
    /// on the wire: the pane vocabulary is the shell's, and an unrecognised value
    /// simply matches no stack rather than forcing a central enum edit per new pane.
    pub pane: String,
    /// The package's DEFAULT position in the stack, ascending. The user's own saved
    /// order wins where it names this section; this is what places a section the user
    /// has never dragged (including one installed after they last dragged).
    #[serde(default)]
    pub order: Option<f64>,
    /// Whether the section starts collapsed. Default `false` (expanded).
    #[serde(default)]
    pub collapsed: bool,
    /// What KIND of data this section applies to — whether it is LISTED at all.
    /// Never a producer (INV-18): see [`SectionSelector`], whose field set makes
    /// naming one a parse error.
    #[serde(default)]
    pub applies_to: Vec<SectionSelector>,
    /// The declarative view-spec files this section renders, relative to the package
    /// folder (e.g. `ui/coordinates.yaml`). One `DeclarativeRegion` per file.
    ///
    /// **They live in the package's `ui/` directory** — the same one an analysis' view
    /// specs use — and that is a constraint, not a convention: THREE independent
    /// discovery surfaces hardcode it (the build-time vite glob in
    /// `loadProcessors.ts::discoverProcessorPackages`, the runtime asset server in
    /// `routes.rs::read_package_assets`, and this crate's own build lint in
    /// `processor_manifest.rs`), so a path under any other folder resolves to nothing
    /// and the loader reports *"declared in `ui:` … but no such view file"*. The
    /// directory carries no meaning — the manifest names the files and nothing infers a
    /// role from the folder — so a second one would buy nothing and risk the half-taught
    /// state (baked packages working, runtime-dropped ones not).
    #[serde(default)]
    pub ui: Vec<String>,
}

/// A section's `applies_to[]` entry (ITEM-1 / INV-18).
///
/// **"A section declares what kind of data it applies to. It never names a producer."**
/// This is the mechanism that makes that unbreakable BY DECLARATION rather than by
/// convention: the struct is `deny_unknown_fields`, so `analysis:` / `package:` /
/// `processor:` / `consumes:` / `slot:` — every way of naming who PRODUCED the data —
/// fails the parse, naming the offending key.
///
/// It mirrors the LISTING subset of the core [`TypeSelector`](crate::modules::datatype::types::TypeSelector)
/// as a manifest-side struct, exactly as [`ViewerContribution`] mirrors `ViewerRef`:
/// denial belongs on the manifest edge, never on the shared wire type (whose other
/// consumer, an analysis' `appliesTo`, legitimately carries input-slot keys). The two
/// input-slot fields (`multiple` / `required`) are absent for the same reason `slot` is
/// — a section binds no input; it asks one question, *"is this section relevant to this
/// project at all?"*.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SectionSelector {
    /// Exact datatype id to match (when `subtypes_of` is unset).
    #[serde(default)]
    pub type_id: Option<String>,
    /// Match any datatype that `is_a` this supertype (the lattice rule).
    #[serde(default)]
    pub subtypes_of: Option<String>,
    /// Required capabilities (a subset check). With neither `type_id` nor
    /// `subtypes_of`, a capability-only selector matches any datatype holding them —
    /// which is the cross-package binding this seam rests on.
    #[serde(default)]
    pub capabilities: Vec<String>,
    /// Datatype ids (or their subtypes) to REJECT even when the base match holds.
    #[serde(default)]
    pub excludes: Vec<String>,
}

impl From<&SectionSelector> for crate::modules::datatype::types::TypeSelector {
    /// Widen to the core selector the datatype registry matches against. Lossless:
    /// every `SectionSelector` field is a `TypeSelector` field, and the two the core
    /// type adds (`multiple` / `required`) are input-slot semantics a section has no
    /// use for, so they take their defaults.
    fn from(s: &SectionSelector) -> Self {
        Self {
            type_id: s.type_id.clone(),
            subtypes_of: s.subtypes_of.clone(),
            multiple: false,
            required: false,
            capabilities: s.capabilities.clone(),
            excludes: s.excludes.clone(),
        }
    }
}

/// ONE `contributes.analyses[]` entry, as far as the BACKEND is concerned (S3).
///
/// The block is authored for the FE (`ProcessorManifestData`) and the backend has no
/// business re-typing it, so every other key rides `rest` verbatim and re-serializes
/// unchanged — `GET /api/extensions` stays byte-faithful and the FE (which reads the
/// RAW manifest text over `GET /api/processors/packages`) is untouched.
///
/// What the backend DOES read is `id` (an analysis run's `generator_id`) and the
/// `methods` narration block below.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct AnalysisContributionData {
    /// The analysis id — the `generator_id` a run of this analysis records.
    pub id: String,
    /// How a run of this analysis is NARRATED in the exported methods section (S3).
    /// Absent ⇒ the generic sentence.
    #[serde(default)]
    pub methods: Option<MethodsNarration>,
    /// The `draftable` block (draftable-entity ITEM-9), TYPED on the wire so the FE
    /// analysis-contribution schema carries it (`types.ts` gets `draftable?:
    /// DraftableSpec`) — the FE mount uses it to detect a draftable editor view. It is
    /// pulled out of `rest` (so it is not double-serialized) and parsed LENIENTLY: a
    /// malformed block is logged + treated as absent (the `run()` precedent), never
    /// wedging the analysis. The loader stays DOMAIN-BLIND (INV-1): `kind`/`freeze`/
    /// `edit`/`freeze_on` are opaque strings it carries, never interprets.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de_lenient_draftable"
    )]
    pub draftable: Option<DraftableSpec>,
    /// The analysis-domain ENV IMAGE this analysis' compute runs inside (#189) — the
    /// analysis-side twin of [`ConverterContribution::env`], same manifest key, same
    /// grammar, same one-level-above-`run:` placement (DEC-1).
    ///
    /// `None` ⇒ the deployment default resolves exactly as it did before this field
    /// existed, so an analysis that declares no `env` is byte-identical to today
    /// (INV-1). Pulled out of `rest` so it is not double-serialized, mirroring
    /// `draftable`; with `skip_serializing_if` the wire is unchanged for a manifest
    /// that omits it (INV-5).
    ///
    /// **Parsed STRICTLY, unlike `draftable`.** A malformed env-id is rejected here
    /// naming the key and the value, never warn-and-ignored: a lenient parse would
    /// drop the declaration and silently run the analysis against the DEPLOYMENT
    /// DEFAULT image — presenting to the user as "the analysis is broken" while the
    /// real cause is a typo'd env-id that nothing reported (INV-2). The same value is
    /// rejected earlier and more loudly by the build lint
    /// (`build_helper/processor_manifest.rs`), which the loader runs BEFORE this parse
    /// and whose failure is `tracing::error!`-logged and collected into the package's
    /// `PackageLoadStatus.error`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de_checked_env"
    )]
    pub env: Option<String>,
    /// Every other `analyses[]` key, verbatim (FE-owned; never re-typed here).
    #[serde(flatten)]
    pub rest: serde_json::Map<String, serde_json::Value>,
}

/// Strict deserializer for the `env:` key (the deliberate counterpart to
/// [`de_lenient_draftable`]). An absent key is `None`; a present one must satisfy the
/// shared env-id grammar ([`is_valid_env_id`](crate::modules::sandbox::env_id::is_valid_env_id))
/// or the parse FAILS, naming both the key and the offending value.
///
/// Strict, not lenient, because the two failure modes are not comparable. A malformed
/// `draftable` block costs an editor affordance; a dropped `env` runs the analysis in
/// the WRONG IMAGE and reports success. The registry is open by design — any well-formed
/// id resolves to its own repo — so the grammar is the only check that can exist here,
/// which makes enforcing it non-negotiable.
fn de_checked_env<'de, D>(de: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = <Option<String> as serde::Deserialize>::deserialize(de)?;
    match raw {
        None => Ok(None),
        Some(v) if crate::modules::sandbox::env_id::is_valid_env_id(&v) => Ok(Some(v)),
        Some(v) => Err(serde::de::Error::custom(format!(
            "`env` must be a lowercase OCI repository path component \
             (a-z, 0-9, `.`, `_`, `-`; non-empty) — got `env: {v:?}`"
        ))),
    }
}

/// Lenient deserializer for the `draftable:` block (mirrors the lazy `run()`/former
/// `draftable()` warn-and-ignore contract): parse into an intermediate value, try
/// `DraftableSpec`, and on a malformed block LOG + yield `None` rather than failing the
/// whole analysis entry (a boot-time hard failure would take the registry down for one
/// bad package).
fn de_lenient_draftable<'de, D>(de: D) -> Result<Option<DraftableSpec>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = <Option<serde_json::Value> as serde::Deserialize>::deserialize(de)?;
    match raw {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(value) => match serde_json::from_value::<DraftableSpec>(value) {
            Ok(spec) => Ok(Some(spec)),
            Err(err) => {
                tracing::warn!(
                    %err,
                    "malformed `draftable` block on an analysis contribution; this analysis \
                     will NOT be treated as draftable"
                );
                Ok(None)
            }
        },
    }
}

impl AnalysisContributionData {
    /// The analysis' `run` block, typed (S6/S7). Read out of the verbatim `rest` so
    /// the block stays byte-faithful on the wire while the backend can still see the
    /// `helpers` / `host_resources` an analysis declares. A malformed block is
    /// LOGGED and treated as absent — the build-time manifest gate is what makes it
    /// an error; a boot-time hard failure here would take the whole registry down
    /// for one bad package.
    pub fn run(&self) -> Option<RunSpec> {
        let raw = self.rest.get("run")?;
        match serde_json::from_value::<RunSpec>(raw.clone()) {
            Ok(run) => Some(run),
            Err(err) => {
                tracing::warn!(
                    analysis = %self.id, %err,
                    "malformed `run` block on an analysis contribution; its declared \
                     helpers / host resources will NOT be applied"
                );
                None
            }
        }
    }

    /// The analysis' `draftable` block, typed (draftable-entity ITEM-9). Now a real
    /// typed field (`draftable`) surfaced on the wire so the FE schema carries it; this
    /// accessor is retained for the existing server call sites (`find_draftable_by_kind`)
    /// and simply hands back the parsed field. Parsing (incl. the malformed→absent
    /// warn-and-ignore) happens once at deserialize (`de_lenient_draftable`).
    pub fn draftable(&self) -> Option<DraftableSpec> {
        self.draftable.clone()
    }
}

/// The `draftable` block on a `contributes.analyses[]` entry (draftable-entity
/// ITEM-9). Every field is an OPAQUE, package-owned string the core carries but never
/// interprets (INV-1): `kind` labels the draft's `drafts.kind`; `freeze` names the
/// producer analysis id run at freeze; `edit` names the edit view; `freeze_on`
/// enumerates the consuming analysis ids that auto-freeze on consumption (ITEM-8).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct DraftableSpec {
    /// The opaque `kind` a draft of this analysis carries (`drafts.kind`).
    pub kind: String,
    /// The producer analysis id run at freeze (its outputs become the frozen artifact).
    pub freeze: String,
    /// The edit view (`ui/*.yaml`) that binds `$state` ↔ `draft.data`.
    #[serde(default)]
    pub edit: Option<String>,
    /// Consuming analysis ids that trigger auto-freeze-on-consume (ITEM-8 / INV-4).
    #[serde(default)]
    pub freeze_on: Vec<String>,
}

/// The DECLARATIVE methods narration for one analysis (S3).
///
/// ## Why this exists
///
/// `provenance/export/methods.rs` hardcoded ONE processor's analysis id in a
/// `*_GENERATOR_ID` constant, that processor's param vocabulary, its input-slot
/// spellings, and that processor's own axis noun in prose at nine sites. Since the
/// `kind` of EVERY sandbox compute run is the literal `"compute"`, any OTHER
/// processor — and every other deployment — got `"Step 'compute' was performed"`
/// forever. methods.md is the OUT-OF-APP trust deliverable, so that is the worst
/// place in the tree for a hardcoded processor id.
///
/// The narrator still owns the RENDERING (it must, to keep the "never silently drop
/// a term" guarantee mechanical); a package declares only the NOUNS and which ROLE
/// each of its params plays.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MethodsNarration {
    /// The noun for the axis elements this analysis acts on (`row` / `well` /
    /// `region` / `read`). Prose only — no logic depends on it.
    pub subject: MethodsSubject,
    /// The past-tense verb: `"<Subjects> were <action> on …"`. e.g. `filtered`.
    pub action: String,
    /// The noun phrase for what a run COMMITS, appended as `", committing <commits>"`.
    ///
    /// ## Placeholders
    ///
    /// `{label}` is a RESERVED alias for the value of whichever param is declared
    /// [`MethodsParamRole::OutputLabel`], whatever that param is spelled. Any OTHER
    /// `{token}` names a PARAM of this analysis directly and is filled from the run's
    /// recorded value for it.
    ///
    /// Every token must be DECLARED — `label`, or a key of [`Self::params`]. An
    /// undeclared token is a package-scoped BUILD failure
    /// (`build_helper::processor_manifest`), never a verbatim render: `{label}` used to
    /// be the only token substituted, so five shipped manifests spelling `{name}` /
    /// `{n_pcs}` / `{n_hvg}` / `{method}` printed their braces straight into the
    /// out-of-app trust deliverable, invisible until a human opened an exported bundle
    /// (#131).
    ///
    /// A token the RUN did not record is a different case the build cannot see (an
    /// older run, an unset optional param); the narrator then falls back to
    /// [`Self::commits_unlabeled`], and omits the clause entirely if that does not
    /// resolve either. A phrase is only ever emitted once FULLY substituted.
    #[serde(default)]
    pub commits: Option<String>,
    /// The `commits` phrase to use when the labelled phrase cannot be fully resolved
    /// (classically: no `output_label` was recorded). Declared separately rather than
    /// substituting an empty `{label}`, which would emit a half-formed name (an empty
    /// backticked slot) into the out-of-app trust deliverable.
    #[serde(default)]
    pub commits_unlabeled: Option<String>,
    /// A trailing caveat, narrated UNCONDITIONALLY.
    ///
    /// It used to be appended only when at least one constraint was narrated, so an
    /// analysis declaring no constraint-producing param role had its ENTIRE scientific
    /// caveat silently dropped from every exported `methods.md`, with every gate green
    /// (#131) — five of the six shipped declarations were in that state. The dropped
    /// text is what a package author writes precisely because the result is easy to
    /// over-read: the honest parts were the parts being dropped.
    #[serde(default)]
    pub note: Option<String>,
    /// The ROLE each of this analysis' params plays in the narration. A param NOT
    /// listed here is disclosed BY NAME rather than dropped, so a knob added
    /// tomorrow degrades to a named gap and never to an understated method.
    #[serde(default)]
    pub params: std::collections::BTreeMap<String, MethodsParamRole>,
    /// Input SLOT names that carry an explicit element-id allow-list. Such a slot is
    /// recorded only as a used edge, so a params-only reading cannot see it at all
    /// and the narration would describe a laxer method than the one that ran.
    #[serde(default)]
    pub allow_list_slots: Vec<String>,
    /// The VERSIONED EXTERNAL RESOURCES a run of this analysis consumed — a pretrained
    /// model, a pinned reference build, a reference-database release, an ontology
    /// version, a pinned reference artifact (#77).
    ///
    /// ## Why a first-class block and NOT an eighth param role
    ///
    /// A role cannot express a GROUPED tuple: the four facets of one asset would be
    /// four unrelated role entries with nothing binding them, and two assets would be
    /// indistinguishable from one. And the nearest EXISTING role,
    /// [`MethodsParamRole::OpaquePredicate`], renders an actively-WRONG sentence over a
    /// model — "a recorded `model` expression (not narrated here — see `manifest.json`)"
    /// — when a pinned model is not a predicate and *is* narratable. Without this
    /// block the most consequential input to a model-consuming analysis lands in the
    /// undeclared-param footnote: honest, but a gap statement rather than a narration,
    /// in the one artefact meant to travel outside the app.
    ///
    /// Empty for every analysis that declares nothing, which is every shipped manifest
    /// today — so this is purely additive.
    #[serde(default)]
    pub reference_assets: Vec<MethodsReferenceAsset>,
}

/// ONE versioned external resource a run consumed (#77).
///
/// Every field except `kind` names a PARAM of the analysis; the narrator reads the
/// run's RECORDED value for that param. The declaration is therefore static (it lives
/// in the manifest) while the identity and version it narrates are per-run facts —
/// which is the whole point: two runs of the same analysis against two model versions
/// must narrate differently.
///
/// `name` and `version` are REQUIRED because an asset narrated without its version is
/// exactly the untraceability #77 exists to close. `source` and `digest` are optional
/// detail. An asset whose `name` or `version` param the run did not record is NOT
/// narrated — and its params fall back into the undeclared-param disclosure, so the
/// never-drop guarantee holds rather than being quietly satisfied by a half-asset.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MethodsReferenceAsset {
    /// The package-owned NOUN for what class of resource this is — `pretrained model`,
    /// `reference database`, `ontology`, `reference build`. Prose only; the core
    /// carries it and never interprets it (the domain-blindness rule).
    pub kind: String,
    /// The param carrying the asset's IDENTITY (e.g. `model`).
    pub name: String,
    /// The param carrying the asset's VERSION (e.g. `model_version`).
    pub version: String,
    /// The param carrying where the asset came from (e.g. `model_source`) — a URL, a
    /// registry id, a release name.
    #[serde(default)]
    pub source: Option<String>,
    /// The param carrying the asset's CONTENT DIGEST (e.g. `model_sha256`) — the one
    /// facet that pins the bytes rather than the name.
    #[serde(default)]
    pub digest: Option<String>,
}

/// The singular/plural noun for one element of the axis an analysis acts on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MethodsSubject {
    /// e.g. `well`.
    pub singular: String,
    /// e.g. `wells`.
    pub plural: String,
}

/// The role a declared param plays in the methods narration (S3). Each names a
/// SHAPE the narrator already knows how to render — never a domain.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MethodsParamRole {
    /// `[{column, control?, min?, max?, keep?}]` — rendered as range / keep-set
    /// predicate phrases (the same coercion the committed mask used).
    PredicateList,
    /// A list of `[{metric|col|criteria, min, max, …}]`, where every FURTHER key is a
    /// qualifier the PROCESSOR itself named and is rendered under that name — OR the
    /// nested per-group map `{measure: {group: [lo, hi]}}`. Both render in the same
    /// range grammar (`threshold_phrases`); the role fixes only the measure and bound
    /// spellings and never a qualifier noun, so no one package's vocabulary reaches
    /// the out-of-app methods deliverable.
    ThresholdList,
    /// A payload this narrator cannot render faithfully. DISCLOSED by name, with a
    /// pointer at `manifest.json` — never dropped, never guessed.
    OpaquePredicate,
    /// An explicit element-id allow-list intersected into the result; its SIZE is
    /// narrated (the ids themselves are the pinned input, not a parameter).
    AllowList,
    /// A cap after which a SEEDED RANDOM subsample runs — the single most
    /// reproducibility-critical fact a method can have, and the easiest to omit.
    SubsampleCap,
    /// The RNG seed.
    Seed,
    /// A user label that names the committed output (fills `commits`' `{label}`).
    OutputLabel,
    /// A SCALAR whose recorded value the narration STATES — interpolated into the
    /// `commits` phrase by `{<param>}` where the phrase names it, and otherwise stated by
    /// value in the trailing disclosure. It constrains nothing.
    ///
    /// It exists so a placeholder can be DECLARED and therefore build-checked. Without
    /// a declared vocabulary the placeholder lint has nothing to check a token against,
    /// which is "silently accept anything" in a different costume — the exact failure
    /// being repaired. The shipped case is a phrase interpolating two SIZE parameters:
    /// neither is a label, so under the narrow `{label}`-only substitution both had no
    /// home at all and would simply have been deleted from the sentence.
    ///
    /// It does NOT buy the param an exemption from disclosure: a `narrated_value`
    /// whose phrase was not actually emitted falls BACK into the "Additional recorded
    /// parameters are NOT narrated here" list, because declared-but-unrendered would
    /// otherwise be a hole in the never-drop guarantee.
    NarratedValue,
}

/// A manifest-contributed interaction ACTION (S4).
///
/// The DECLARATION layer only — the emitter still owns how each dialect compiles,
/// because the emitted source is the attested artifact and a manifest must never be
/// able to inject python. A package therefore picks from the dialects this build
/// ships; declaring an unknown one is a boot-time lint failure, not a silently
/// uncapturable action.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ActionContribution {
    /// The dotted action type the client posts to `POST /provenance/actions`,
    /// e.g. `gate.commit`. Must not collide with a built-in action type.
    pub action_type: String,
    /// How faithfully a capture of this action reproduces.
    pub fidelity: ActionFidelity,
    /// Whether the interaction chokepoint captures it. A `false` entry RESERVES the
    /// vocabulary without dispatching it (mirroring the built-in `annotate.*`).
    #[serde(default)]
    pub dispatchable: bool,
    /// The recipe SHAPE this action posts, which selects the code emitter. Required
    /// for a `dispatchable` action (there is nothing to attest to without one).
    #[serde(default)]
    pub recipe: Option<ActionRecipeDialect>,
}

/// How faithfully a captured action reproduces. Mirrors
/// `provenance::action_registry::FidelityClass` (declared HERE so the manifest layer
/// does not depend on the higher-order provenance module).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ActionFidelity {
    /// A declarative predicate/recipe — fully re-executable code.
    Declarative,
    /// An identity/label operation.
    Identity,
    /// A view-only gesture (no data mutation).
    ViewOnly,
}

/// The recipe SHAPES this build can compile into a reproducible `select(ctx)`
/// script. Each names a payload shape, never a domain: the emitter reads the shape
/// and answers one boolean per element of the selected axis.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ActionRecipeDialect {
    /// `{criteria: [{column, control?, min?, max?, keep?}]}` — the AND-ed
    /// threshold/keep-set list.
    Criteria,
    /// `{col, op, val}` — one allow-listed comparator against one column.
    ColumnCompare,
    /// `{column_ref, labels}` — membership of a column in a label set.
    LabelSet,
    /// `{ids}` — an explicit element-id allow-list.
    IdList,
    /// `{coords_ref, polygon}` — a polygon over a pinned 2-D projection.
    Polygon,
    /// `{op, refs}` — a set operation combining named prior selections.
    SetOp,
}

/// A manifest-contributed datatype (ITEM-1/2 / DEC-19). Mirrors the Rust `Datatype`
/// shape but carries only the fields a data-only manifest declares; the loader converts
/// it into a full [`Datatype`] (defaulting the host-only fields — selectors, viewers,
/// converters) and MERGES it into the datatype registry. A declarative `schema`
/// (JSON-schema) replaces a Rust fn-pointer validator for manifest datatypes (DEC-21).
///
/// `#[serde(deny_unknown_fields)]` is scoped to `DatatypeContribution` + its sub-structs
/// ONLY (NOT `Contributes` / `ExtensionManifest`): the SAME `manifest.yaml` is dual-parsed
/// by the backend and the FE, each ignoring the other's top-level keys, so whole-manifest
/// denial would reject every real package's FE `analyses:` block at boot (DEC-4). Denial
/// HERE catches a typo'd datatype-contribution field at parse time.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DatatypeContribution {
    /// Namespaced datatype id, e.g. `annotation-table`, `genomics/vcf`.
    pub id: String,
    /// The single supertype id (must resolve in the merged lattice). Rooted domain
    /// types extend a Rust root (`data`/`tabular`/`matrix`).
    #[serde(default)]
    pub extends: Option<String>,
    /// Human-readable title.
    pub title: String,
    /// Description (optional; defaults to empty).
    #[serde(default)]
    pub description: String,
    /// A declarative JSON-schema document — the manifest datatype's validator (DEC-21).
    #[serde(default)]
    pub schema: serde_json::Value,
    /// Storage declaration (layout + wire format; host-only fields default).
    pub storage: DatatypeContributionStorage,
    /// Advertised capability strings.
    #[serde(default)]
    pub capabilities: Vec<String>,
    /// Sniffer hints (extension + magic-byte signatures).
    #[serde(default)]
    pub ingest: Option<DatatypeContributionIngest>,
    /// The entity AXES this datatype declares (ITEM-3) — e.g. the axis a
    /// supporting-aligned type carries, or a primary type's own entity axes.
    ///
    /// IDENTITY ONLY (`name`, `key_label`). An axis no longer enumerates the columns a
    /// dataset "would" carry: that list was an unverified forecast, and on one real
    /// imported dataset 8 of the 9 declared annotations did not exist while 64 of the
    /// dataset's 65 columns went undeclared. Column types are read from the artifacts
    /// that actually landed, each of which stamps its own kind — a fact the conformance
    /// gate verifies.
    #[serde(default)]
    pub axes: Vec<AxisSpec>,
    /// WHICH declared axis is this datatype's ENTITY axis — the axis whose entries a
    /// value of this type has ONE PER, i.e. the axis a read of one of its artifacts is
    /// dense over. Must name one of the `axes` above; carried verbatim onto
    /// [`Datatype::entity_axis`](crate::modules::datatype::types::Datatype::entity_axis),
    /// which documents why it is DECLARED rather than taken from a position.
    ///
    /// Omit it for a single-axis datatype (there is no choice to make). A MULTI-axis
    /// datatype that omits it gives its consumer no answer — the consumer then refuses
    /// rather than guessing, so a `pointCount`/dense-length read degrades visibly instead
    /// of reporting one axis's cardinality for another's.
    #[serde(default)]
    pub entity_axis: Option<String>,
    /// OPTIONAL per-column DISPLAY LABELS, keyed by column name — `{ <column>:
    /// "<display label>" }`. The only surviving piece of the removed `axes[].annotations`
    /// block: a raw column name is not always a good label, and that is the one thing
    /// about a column which is NOT derivable from the data.
    ///
    /// A lookup, not a schema claim — silent for a column it does not mention, so it can
    /// never assert that a column exists. That is exactly the property the annotation
    /// list lacked, and why this shape replaces it rather than shrinking it.
    ///
    /// The key is the column's OWN NAME — never a client catalog channel id, which
    /// carries a server-minted artifact id no author can write down. On the client it is
    /// what `annotationsForAxis` reports as `AxisAnnotation.column`: a member path for a
    /// column inside a multi-column artifact, and the producer's declared `meta.name` for
    /// an artifact that IS one column (which is what a per-column metric is).
    #[serde(default)]
    pub labels: std::collections::HashMap<String, String>,
    /// The arrays this datatype declares OVER its axes (INV-7 / open-axis DATA). A
    /// COMPOSITE kind (set-membership / graph / statistics-table / trajectory) declares
    /// its multiple arrays here;
    /// carried verbatim onto `Datatype.arrays`. Reuses the core `ArrayDecl` (which owns
    /// `deny_unknown_fields`), so a typo'd array field fails at manifest parse.
    #[serde(default)]
    pub arrays: Vec<ArrayDecl>,
    /// Abstract = a gating supertype only (no direct artifact). Defaults concrete.
    #[serde(default)]
    pub is_abstract: bool,
    /// The viewers that render this datatype (ITEM-1 / DEC-4). Carried onto the
    /// `Datatype.viewers` so a contributed type's own + inherited viewers travel — the
    /// field `to_datatype()` formerly hardcoded empty. Empty = inherit-only.
    #[serde(default)]
    pub viewers: Vec<ViewerContribution>,
    /// The file SHAPE an uploaded input of this type must arrive as (ITEM-1 / DEC-4) —
    /// drives the upload wizard's picker. `None` for types never directly uploaded.
    #[serde(default)]
    pub input_requirements: Option<InputRequirements>,
    /// Declared conversions FROM/TO this datatype (ITEM-1 / DEC-4). Carried verbatim onto
    /// `Datatype.converters` (the field `to_datatype()` formerly hardcoded empty).
    #[serde(default)]
    pub converters: Vec<ConverterRef>,
}

/// The storage sub-declaration of a [`DatatypeContribution`] (ITEM-2). A manifest
/// declares `layout` + `format`; `file_layout` (defaults `single`) is optional so a
/// simple table datatype needs it.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DatatypeContributionStorage {
    /// The storage layout (mirrors `datatype::types::LayoutKind`).
    pub layout: LayoutKind,
    /// The served wire format (`csv`/`parquet`/`zarr`/…).
    pub format: String,
    /// How the bytes map to files; defaults to `single`.
    #[serde(default = "default_file_layout")]
    pub file_layout: FileLayout,
}

/// A viewer sub-declaration of a [`DatatypeContribution`] (ITEM-1 / DEC-4). Mirrors the
/// core [`ViewerRef`] but is a manifest-side struct so `deny_unknown_fields` can catch a
/// typo'd viewer key without imposing denial on the shared core [`ViewerRef`] wire type.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ViewerContribution {
    /// The P7 view-kind id (e.g. `matrix-grid`, `table`, `report`).
    pub view_kind_id: String,
    /// The renderer family (`deckgl` / `molstar` / `igv` / `html`).
    pub family: String,
    /// What this viewer consumes (a capability / selector hint), for the FE picker.
    #[serde(default)]
    pub consumes: Vec<String>,
}

/// The sniffer sub-declaration of a [`DatatypeContribution`] (ITEM-2). `magic` maps to
/// `IngestSpec.magic_hex` (lowercase-hex leading signatures).
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DatatypeContributionIngest {
    /// File extensions (without the dot) that hint this type, e.g. `["csv","tsv"]`.
    #[serde(default)]
    pub extensions: Vec<String>,
    /// Leading magic-byte signatures as lowercase hex.
    #[serde(default)]
    pub magic: Vec<String>,
}

fn default_file_layout() -> FileLayout {
    FileLayout::Single
}

impl DatatypeContribution {
    /// Convert this manifest declaration into a full [`Datatype`] ready to MERGE into
    /// the datatype registry (ITEM-1/2). Carries EVERY contributed field the core still
    /// has — viewers, `input_requirements`, `converters` — so a contributed domain type
    /// is byte-equivalent (on every wire field the app reads) to a formerly code-seeded
    /// one (INV-6). The declared `schema` is compiled into an ENFORCED validator by the
    /// registry (DEC-6), not consulted here.
    ///
    /// `storage.selector_map` / `storage.tiers` are not carried and are no longer even
    /// accepted: artifact-model ITEM-14 removed them from the core `StorageSpec` AND
    /// from this manifest-facing shape, which is `deny_unknown_fields`, so a manifest
    /// still spelling either key now fails to parse instead of declaring nothing.
    pub fn to_datatype(&self) -> Datatype {
        Datatype {
            id: self.id.clone(),
            extends: self.extends.clone(),
            title: self.title.clone(),
            description: self.description.clone(),
            schema: self.schema.clone(),
            storage: StorageSpec {
                layout: self.storage.layout.clone(),
                format: self.storage.format.clone(),
                file_layout: self.storage.file_layout.clone(),
            },
            capabilities: self.capabilities.clone(),
            axes: self.axes.clone(),
            entity_axis: self.entity_axis.clone(),
            arrays: self.arrays.clone(),
            // ITEM-14 / DEC-4. This line is the one that was missing: the field existed on
            // BOTH sides and on the TS mirror, and the FE consumer read it — but nothing
            // copied it across, so a declared label was permanently `undefined` at the only
            // place it is used. See `Datatype::labels`.
            labels: self.labels.clone(),
            viewers: self
                .viewers
                .iter()
                .map(|v| ViewerRef {
                    view_kind_id: v.view_kind_id.clone(),
                    family: v.family.clone(),
                    consumes: v.consumes.clone(),
                })
                .collect(),
            ingest: self.ingest.as_ref().map(|i| IngestSpec {
                extensions: i.extensions.clone(),
                magic_hex: i.magic.clone(),
            }),
            input_requirements: self.input_requirements.clone(),
            converters: self.converters.clone(),
            is_abstract: self.is_abstract,
        }
    }
}

/// A converter contribution: an accepts→produces transform run in a sandbox.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ConverterContribution {
    /// Stable converter id (unique within the extension).
    pub id: String,
    /// Human-readable title.
    pub title: String,
    /// When the converter fires. This round the vocabulary is `on-ingest` (DEC-4).
    pub trigger: String,
    /// Parameter declaration. `"none"` for a zero-param converter (this round).
    #[serde(default)]
    pub params: Option<String>,
    /// The analysis-domain ENV IMAGE this converter's compute runs inside
    /// (ITEM-23 / DEC-22/23). An env-id resolved by the sandbox `env_image`
    /// registry (`env-id → {oci_ref, digest}`), lazy-fetched on first use.
    /// The registry resolves ANY declared env-id to a per-env image repo — the set
    /// is deployment data, not a list this type knows.
    ///
    /// `None` ⇒ the DEPLOYMENT DEFAULT (`env_image::default_env_id`: the
    /// `TXR_SANDBOX_ENV_ID` override, else the admin settings row, else the union of
    /// the envs the loaded registry declares). There is **no embedded-rootfs
    /// fallback** — this doc claimed one until #189, and the claim was false:
    /// the embedded rootfs was removed when DEC-24 was reversed (see the `env_image` module
    /// doc, "nothing embedded"), and a run that resolves NO env-id is a hard
    /// `SANDBOX_UNAVAILABLE` 503 at `local_bwrap.rs` / `service.rs`, not a silent
    /// fallback. The stale promise mattered: it described the exact
    /// substitute-and-continue behaviour that INV-2 forbids, so a reader could
    /// reasonably have built one.
    ///
    /// Parsed strictly — see [`de_checked_env`] for why a malformed env-id may not be
    /// warn-and-ignored.
    #[serde(default, deserialize_with = "de_checked_env")]
    pub env: Option<String>,
    /// Input datatype selectors this converter accepts.
    #[serde(default)]
    pub accepts: Vec<AcceptsEntry>,
    /// The declared, static SUPERSET of outputs (the run emits the actual 0..N).
    #[serde(default)]
    pub produces: Vec<ProducesEntry>,
    //
    // There is no `produces_annotations`. It was the OTHER half of the deleted column
    // forecast (INV-5): the second declaration level, naming each output column and its
    // type before any run existed. It is undeclarable in the general case — the
    // generic integrate converter emits one column per column of a user-supplied
    // table, a set knowable only after the table arrives — and on real data it was wrong in
    // both directions. `produces` (which DATATYPE an output is) is the whole output
    // contract a converter owes; the type of each column that actually landed is read from
    // the artifact, which stamps its own kind and is checked by the conformance gate.
    /// How the converter runs (sandbox / runtime / entry script).
    pub run: RunSpec,
}

/// An `accepts` selector — a datatype id the converter consumes. Kept as a struct
/// (not a bare string) so richer selectors (capabilities/subtypes) can be added
/// without a wire break. ITEM-6 adds the supporting-file facets (role/slot/axis/kind/
/// alignment), all `#[serde(default)]` so a bare `{type_id}` still parses as a PRIMARY
/// input (back-compat, DEC-6).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct AcceptsEntry {
    /// The exact datatype id accepted, e.g. `<package-namespace>/<type>`.
    pub type_id: String,
    /// The ROLE this input plays: `primary` (the dataset's main file) or `supporting`
    /// (an annotation aligned to an axis). Defaults to `primary` so an omitted `role`
    /// keeps a legacy `{type_id}` entry a primary input.
    #[serde(default = "default_accepts_role")]
    pub role: String,
    /// The named upload SLOT this accept fills (the wizard drop-zone id), if any.
    #[serde(default)]
    pub slot: Option<String>,
    /// The primary datatype AXIS a supporting input aligns to (an `AxisSpec.name` —
    /// a generic axis NAME, never a fixed two-axis enum; DEC-6).
    #[serde(default)]
    pub axis: Option<String>,
    /// The supporting `kind` as an OPEN string (parses to `datatype::types::SupportingKind`),
    /// e.g. `annotation_table`. `None` for a primary input.
    #[serde(default)]
    pub kind: Option<String>,
    /// A declarative `Alignment` descriptor carried as open JSON so a manifest declares
    /// it verbatim (parses to `datatype::types::Alignment`). `None` for a primary input.
    #[serde(default)]
    pub alignment: Option<serde_json::Value>,
}

fn default_accepts_role() -> String {
    "primary".to_string()
}

/// A `produces` entry — the datatype an output has + its declared CARDINALITY
/// (ITEM-10; the static superset shape, declared ≠ produced).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ProducesEntry {
    /// The datatype id of this output (must resolve in the Rust datatype registry
    /// at emit time; declared-only reference here).
    pub datatype: String,
    /// How many instances of this output a run may emit.
    pub cardinality: Cardinality,
}

/// The declared cardinality of a `produces` output (ITEM-10 / DEC-18).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Cardinality {
    /// Exactly one instance.
    One,
    /// Zero or one instance.
    Optional,
    /// Zero or more instances.
    Many,
}

/// How a converter's compute is executed.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct RunSpec {
    /// Execution kind (this round: `sandbox`).
    pub kind: String,
    /// The runtime the entry is written for (this round: `python`).
    pub runtime: String,
    /// The entry script path, relative to the extension folder (e.g.
    /// `compute/import.py`). MUST be non-empty (boot-validated).
    pub entry: String,
    /// Sibling files from THIS package co-staged into the sandbox code dir next to
    /// `entry`, so the entry can `import` them (S6).
    ///
    /// Package-relative paths; the staged name is the file's BASENAME. Formerly the
    /// server carried a fixed `PY_HELPER_FILES` table that staged one package's
    /// module into EVERY python entry's code dir, cross-package and globally — so
    /// the app builtin named a specific domain package and its script path.
    #[serde(default)]
    pub helpers: Vec<String>,
    /// Named HOST RESOURCES this entry needs bind-mounted read-only (S7).
    ///
    /// The server formerly carried ONE named reference dataset as a CONCEPT directly:
    /// a `needs_reference: bool` column in a code table, a fixed
    /// `TXR_SANDBOX_REFERENCE_ROOT` env var, a fixed `/refdata` mount path, and an
    /// error message naming that one resource. A processor now DECLARES what it
    /// needs and where; the operator maps the NAME to a host path.
    #[serde(default)]
    pub host_resources: Vec<HostResourceRequirement>,
    /// The interpreter-level LIBRARIES this entry's code imports, each with the version
    /// range it is supported against (#80).
    ///
    /// Before this, an entry could only use what the env image happened to contain, and
    /// nothing anywhere said which of those it actually relied on. The two failure modes
    /// that produced are the reason this field exists:
    ///
    /// * a library the entry imports but the image does not contain surfaced as a raw
    ///   interpreter import error, at run time, inside a sandbox — the latest and least
    ///   actionable point in the chain;
    /// * a library the image DID contain, at a version whose DEFAULTS differed from the
    ///   one the entry was written and validated against, silently changed the numbers a
    ///   run published, with no diff anywhere in this repository to point at.
    ///
    /// Declaring it moves both to the BUILD: the build-time manifest gate resolves every
    /// entry here against the selected env recipe's pin set and fails the build, naming
    /// the package and the requirement, when a declaration is unsatisfiable. What is left
    /// for run time is the assertion that the environment the job actually got matches
    /// what was declared, plus the recording of what it resolved to.
    ///
    /// The core interprets NEITHER field's meaning — `library` is an opaque distribution
    /// name it matches against recipe data, `version` an opaque specifier it compares. No
    /// library is named anywhere in this crate; both sides of every comparison are data.
    #[serde(default)]
    pub dependencies: Vec<DependencyRequirement>,
}

/// ONE `run.dependencies[]` entry — a declared library + the version range this entry is
/// supported against (#80).
///
/// `deny_unknown_fields` for the reason every other manifest sub-struct here carries it:
/// the FIELD SET IS THE CONTRACT. A misspelled `libary:` / `versions:` must be a parse
/// error naming the key, not a requirement that silently declares nothing — a dependency
/// contract that quietly parses to empty is worse than no contract, because it reports
/// the same green build while enforcing nothing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DependencyRequirement {
    /// The DISTRIBUTION name as the environment's package index knows it — the name the
    /// recipe installs and the name the resolved version is looked up by at run time.
    ///
    /// Deliberately the distribution name and NOT the import name: they differ often
    /// enough that guessing one from the other is a bug source, and the distribution name
    /// is the one both the recipe's pin set and the run-time metadata lookup are keyed on.
    /// The recipe's own pin file carries the import name alongside each pin, for the build
    /// smoke line that is the other consumer.
    pub library: String,
    /// The supported version range, as a comma-ANDed specifier set
    /// (`==` / `!=` / `>=` / `>` / `<=` / `<` over dotted-numeric releases), e.g.
    /// `">=1.11,<1.12"`.
    ///
    /// The build gate FAILS CLOSED on any grammar outside that subset rather than
    /// guessing: a specifier it cannot interpret exactly is a build error naming it, so
    /// the subset the build enforces can never be looser than what the run time — which
    /// uses the reference implementation — enforces.
    ///
    /// ONE EXCEPTION, since #192: against a recipe that declares `txr:ecosystem=r`, this
    /// is read under R `DESCRIPTION` rules, where `-` and `.` are the same separator. That
    /// is the correct reading for an R declaration and it is confined to R recipes.
    //
    // WHY THAT IS AN EXCEPTION TO THE PARAGRAPH ABOVE, and the hand-off it creates. Kept
    // as a `//` comment, not a doc comment: `utoipa` lifts doc comments into the OpenAPI
    // schema description and thence into every generated client, and an internal hand-off
    // note is not something an API consumer needs. A manifest author reads this file.
    //
    // On the one string where the two grammars genuinely disagree — `0.1-40` is R's
    // `0.1.40` and PEP 440's `0.1.post40` — the gate answers under R's reading, which is
    // LOOSER than what `packaging` says. It is latent today: helper staging is
    // Python-gated (`sandbox/processors/mod.rs`), so no R declaration reaches a run-time
    // checker at all. THE HAND-OFF IS TO #194 (E6), which builds that checker: it must
    // compare with R's own `numeric_version`/`compareVersion`, not with `packaging`, or
    // the two sides of this contract will disagree for exactly that string.
    pub version: String,
    /// This entry uses the library only on SOME paths — typically when a parameter
    /// enables the behaviour that needs it.
    ///
    /// It changes exactly one thing, at run time: an ABSENT optional library is recorded
    /// as absent instead of refusing the run, because the paths that do not use it are
    /// legitimate and a package handles the absence with its own named refusal on the path
    /// that does. Everything else is unchanged — the build gate still requires the
    /// environment to provide it (an environment that cannot support that path at all is
    /// a build-time fact, not a run-time surprise), and if it IS installed its version is
    /// range-checked exactly like a required one, because a run that used it is a run
    /// whose result depends on it.
    ///
    /// Without this the contract could only express "always needed", and declaring a
    /// conditionally-used library would break the fallback its own refusal message
    /// recommends: a run that never took that path would fail for a library it never
    /// touched.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub optional: bool,
}

/// A named, operator-supplied host resource an entry needs mounted read-only (S7).
///
/// The NAME is a deployment contract, not a concept the server understands: an
/// operator points `TXR_SANDBOX_RESOURCE_<NAME>` at a host path and allowlists its
/// root via `TXR_SANDBOX_REFERENCE_MOUNTS`. Nothing about WHAT the resource is — a
/// reference index, a model, a lookup table — is encoded here; only "this entry needs
/// the resource called X at path Y".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct HostResourceRequirement {
    /// The resource name the deployment configures, e.g. `reference`. Lowercase
    /// letters, digits, `_` and `-`; uppercased with `-`→`_` to form the env var.
    pub name: String,
    /// The ABSOLUTE in-sandbox path the resource is bound read-only at, e.g.
    /// `/refdata`. Declared by the package because the ENTRY is what reads it.
    pub mount_path: String,
}

/// A viewer contribution: a UI panel that renders artifacts of a datatype.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ViewContribution {
    /// Stable view id (unique within the extension).
    pub id: String,
    /// Human-readable title.
    pub title: String,
    /// The datatype id this view renders.
    pub datatype: String,
    /// The view component path, relative to the extension folder (e.g.
    /// `ui/Inspector.tsx`).
    pub entry: String,
    /// An optional declarative view-spec document (YAML co-located in the processor
    /// bundle, e.g. `ui/<view>.yaml`), referenced parallel to the baked `entry:`
    /// (DEC-11 / ITEM-9). A view may ship a baked `.tsx` `entry`, a declarative
    /// `view_spec`, or both; `None` when the view is code-only. Additive — a manifest
    /// that omits it still parses.
    #[serde(default)]
    pub view_spec: Option<String>,
}

#[cfg(test)]
mod section_contribution_tests {
    //! TEST-1 [covers: ITEM-1] — the RUNTIME half of the `contributes.sections[]`
    //! parser pair. Its build-lint mirror is pinned by TEST-2/TEST-3 in
    //! `build_helper/processor_manifest.rs`; the two must land together, because the
    //! lint is `deny_unknown_fields` and a manifest declaring a key only one of them
    //! knows fails the BUILD rather than a test.

    use super::*;

    fn parse(yaml: &str) -> Result<Contributes, serde_norway::Error> {
        serde_norway::from_str(yaml)
    }

    #[test]
    fn section_deserializes_every_declared_field() {
        let c = parse(
            r#"
sections:
  - id: sc.embeddings
    title: Embeddings
    pane: visualize
    order: 10
    collapsed: false
    applies_to: [{ capabilities: [plottable-xy] }]
    ui: [ui/embeddings.yaml]
"#,
        )
        .expect("the design's own example must parse");
        assert_eq!(c.sections.len(), 1);
        let s = &c.sections[0];
        assert_eq!(s.id, "sc.embeddings");
        assert_eq!(s.title, "Embeddings");
        assert_eq!(s.pane, "visualize");
        assert_eq!(s.order, Some(10.0));
        assert!(!s.collapsed);
        assert_eq!(s.ui, vec!["ui/embeddings.yaml".to_string()]);
        assert_eq!(
            s.applies_to,
            vec![SectionSelector {
                capabilities: vec!["plottable-xy".to_string()],
                ..Default::default()
            }]
        );
    }

    #[test]
    fn only_id_title_and_pane_are_required() {
        let c = parse("sections:\n  - { id: s, title: T, pane: visualize }\n")
            .expect("the three required keys alone must parse");
        let s = &c.sections[0];
        assert_eq!(
            s.order, None,
            "no declared order ⇒ ranked after those that have one"
        );
        assert!(!s.collapsed, "default is EXPANDED");
        assert!(s.applies_to.is_empty());
        assert!(s.ui.is_empty());
    }

    #[test]
    fn the_docking_vocabulary_is_refused_by_name() {
        // `pane` is NOT `area`/`region`/`role`. Each of those three words names the
        // docking vocabulary a section must never reach, so each must fail the parse
        // NAMING the key — not be silently ignored into a section that never renders.
        for bad in ["area", "region", "role"] {
            let yaml =
                format!("sections:\n  - {{ id: s, title: T, pane: visualize, {bad}: left }}\n");
            let err = parse(&yaml).expect_err("`{bad}:` must be refused");
            let msg = err.to_string();
            assert!(
                msg.contains(bad),
                "the error must name the offending key `{bad}`, got: {msg}"
            );
        }
    }

    #[test]
    fn a_section_may_not_name_a_producer() {
        // INV-18: "A section declares what kind of data it applies to. It never names
        // a producer." Enforced by DECLARATION, not convention — every way of naming
        // who produced the data is an unknown field on `SectionSelector`.
        for bad in ["analysis", "package", "processor", "consumes", "slot"] {
            let yaml = format!(
                "sections:\n  - id: s\n    title: T\n    pane: visualize\n    applies_to: [{{ {bad}: qc }}]\n"
            );
            let err = parse(&yaml).expect_err("a producer-naming selector key must be refused");
            let msg = err.to_string();
            assert!(
                msg.contains(bad),
                "the error must name the offending key `{bad}`, got: {msg}"
            );
        }
    }

    #[test]
    fn a_capability_only_selector_widens_to_a_matching_type_selector() {
        // The cross-package binding: no `type_id`, no `subtypes_of` — the core
        // registry reads that as "matches any datatype holding these capabilities".
        let sel = SectionSelector {
            capabilities: vec!["plottable-xy".to_string()],
            ..Default::default()
        };
        let core: crate::modules::datatype::types::TypeSelector = (&sel).into();
        assert_eq!(core.type_id, None);
        assert_eq!(core.subtypes_of, None);
        assert_eq!(core.capabilities, vec!["plottable-xy".to_string()]);
        assert!(
            !core.multiple && !core.required,
            "input-slot semantics stay off"
        );
    }

    #[test]
    fn sections_default_to_empty_so_every_existing_manifest_is_unchanged() {
        // The additivity proof: a `contributes` block with no `sections` key parses,
        // and every other kind is untouched.
        let c = parse("converters: []\nviews: []\ndatatypes: []\nanalyses: []\nactions: []\n")
            .expect("a sections-free contributes block must still parse");
        assert!(c.sections.is_empty());
        let empty = parse("{}").expect("an empty contributes block must parse");
        assert!(empty.sections.is_empty());
    }
}

#[cfg(test)]
mod draftable_tests {
    //! TEST-13 [covers: ITEM-9] — the lazy `draftable()` accessor deserializes a
    //! well-formed `draftable:` block into `DraftableSpec` and warn-and-ignores
    //! (returns `None`) on a malformed one, with NO struct/loader change (the `run()`
    //! precedent; the block rides `#[serde(flatten)] rest`).

    use super::*;

    fn analysis(rest_yaml: &str) -> AnalysisContributionData {
        // Parse a full analysis entry through the flatten so `rest` is populated
        // exactly as the loader populates it.
        serde_norway::from_str(rest_yaml).expect("analysis entry parses")
    }

    #[test]
    fn draftable_deserializes_a_well_formed_block() {
        // A FICTITIOUS opaque kind (INV-1): no domain noun — the core never inspects it.
        let a = analysis(
            r#"
id: test.widget.curate
draftable:
  kind: "test/widget"
  edit: ui/widget-editor.yaml
  freeze: test.widget.freeze
  freeze_on: [score, annotate]
"#,
        );
        let spec = a
            .draftable()
            .expect("a well-formed draftable block deserializes");
        assert_eq!(spec.kind, "test/widget");
        assert_eq!(spec.freeze, "test.widget.freeze");
        assert_eq!(spec.edit.as_deref(), Some("ui/widget-editor.yaml"));
        assert_eq!(
            spec.freeze_on,
            vec!["score".to_string(), "annotate".to_string()]
        );
    }

    #[test]
    fn draftable_is_absent_when_the_block_is() {
        let a = analysis("id: test.widget.plain\n");
        assert!(a.draftable().is_none(), "no draftable block → None");
    }

    #[test]
    fn draftable_warn_and_ignores_a_malformed_block() {
        // `freeze` is required; a block missing it is malformed → warn-and-ignore (None),
        // NOT a hard failure (the run() precedent). The analysis entry itself still parses.
        let a = analysis(
            r#"
id: test.widget.broken
draftable:
  kind: "test/widget"
"#,
        );
        assert!(
            a.draftable().is_none(),
            "a malformed draftable block is treated as absent, not an error"
        );
    }
}

#[cfg(test)]
mod dependency_requirement_tests {
    //! TEST-1 [covers: ITEM-5, ITEM-6] — the RUNTIME half of the `run.dependencies[]`
    //! parser pair. Its build-lint mirror lives in
    //! `build_helper/processor_manifest.rs`; the two MUST land together, because that
    //! one is `deny_unknown_fields` and a manifest declaring a key only one of them
    //! knows fails the BUILD rather than a test.
    //!
    //! Fixtures use invented, vocabulary-free names on purpose: this file is inside the
    //! app builtin, which may not name any contributed domain's vocabulary.

    use super::*;

    fn run_spec(yaml: &str) -> Result<RunSpec, serde_norway::Error> {
        serde_norway::from_str(yaml)
    }

    #[test]
    fn run_spec_deserializes_a_declared_dependency_set() {
        let r = run_spec(
            r#"
kind: sandbox
runtime: python
entry: compute/thing.py
dependencies:
  - library: alpha-tool
    version: ">=1.11,<1.12"
  - library: beta_tool
    version: "==2.0.0"
"#,
        )
        .expect("a well-formed dependency set deserializes");
        assert_eq!(r.dependencies.len(), 2);
        assert_eq!(r.dependencies[0].library, "alpha-tool");
        assert_eq!(r.dependencies[0].version, ">=1.11,<1.12");
        assert_eq!(r.dependencies[1].library, "beta_tool");
        assert_eq!(r.dependencies[1].version, "==2.0.0");
    }

    #[test]
    fn a_run_block_without_dependencies_parses_to_an_empty_set() {
        // Every manifest that predates the field must parse byte-identically — the
        // additive rule every other key on this struct follows.
        let r = run_spec("kind: sandbox\nruntime: python\nentry: compute/thing.py\n")
            .expect("a run block predating the field still parses");
        assert!(r.dependencies.is_empty(), "absent ⇒ empty, never an error");
    }

    #[test]
    fn a_typod_dependency_key_is_a_parse_error_naming_the_key() {
        // The whole point of `deny_unknown_fields` here: a contract that silently parses
        // to "declares nothing" reports the same green build while enforcing nothing.
        let err = run_spec(
            r#"
kind: sandbox
runtime: python
entry: compute/thing.py
dependencies:
  - libary: alpha-tool
    version: "==1.0.0"
"#,
        )
        .expect_err("a misspelled key must fail the parse");
        let msg = err.to_string();
        assert!(
            msg.contains("libary"),
            "the parse error must NAME the offending key; got: {msg}"
        );
    }

    #[test]
    fn both_dependency_fields_are_required() {
        for yaml in [
            "kind: sandbox\nruntime: python\nentry: e.py\ndependencies:\n  - library: alpha-tool\n",
            "kind: sandbox\nruntime: python\nentry: e.py\ndependencies:\n  - version: \"==1.0.0\"\n",
        ] {
            assert!(
                run_spec(yaml).is_err(),
                "a dependency entry missing a required field must fail the parse: {yaml}"
            );
        }
    }
}

#[cfg(test)]
mod env_declaration_tests {
    //! #189 — the RUNTIME half of PROV-E1-1 (the build-lint half lives in
    //! `processor_manifest_lint`), plus the ITEM-13 doc correction.
    use super::*;

    fn parse_analysis(env: serde_json::Value) -> Result<AnalysisContributionData, serde_json::Error> {
        let mut a = serde_json::json!({ "id": "pkg.act" });
        if !env.is_null() {
            a["env"] = env;
        }
        serde_json::from_value(a)
    }

    /// **TEST-E1-1** [acceptance] **PROV-E1-1** [covers: ITEM-1] — an analysis
    /// contribution ACCEPTS `env:` at runtime, and a malformed value is REFUSED naming
    /// the key and the value.
    ///
    /// The accept half alone would have passed before #189 (the key rode invisibly in
    /// `#[serde(flatten)] rest`), so the assertions that carry weight are that the value
    /// is now READABLE as a typed field, and that a bad one is rejected rather than
    /// silently carried.
    /// Lifecycle id: **TEST-23** (see `.lifecycle/analysis-env-selection/TESTS.md`).
    #[test]
    fn an_analysis_may_declare_an_env_and_a_malformed_one_is_refused() {
        const DECLARED: &str = "fixture-env-a";

        // Accepted, and READABLE — not merely tolerated in `rest`.
        let a = parse_analysis(serde_json::json!(DECLARED)).expect("a well-formed env parses");
        assert_eq!(a.env.as_deref(), Some(DECLARED));
        assert!(
            !a.rest.contains_key("env"),
            "`env` is pulled OUT of `rest`, so it is not double-serialized (INV-5)"
        );

        // Absent ⇒ None, and nothing appears in `rest` either.
        let a = parse_analysis(serde_json::Value::Null).expect("an env-less analysis parses");
        assert_eq!(a.env, None);

        // Refused, naming the key and the value. This is the deliberate divergence from
        // `draftable`'s lenient parse: dropping a malformed env would run the analysis in
        // the DEPLOYMENT DEFAULT image and report success (INV-2).
        for bad in ["", "UPPER", "a/b", "x:tag", "y@sha256:0", "has space", "reg.io/a"] {
            let err = parse_analysis(serde_json::json!(bad))
                .expect_err("a malformed env-id must be refused at parse");
            let msg = err.to_string();
            assert!(msg.contains("`env`"), "names the KEY for {bad:?}: {msg}");
            assert!(msg.contains(bad), "names the VALUE for {bad:?}: {msg}");
        }
    }

    /// The CONVERTER side accepts and validates the identical spelling — one key, one
    /// grammar, two contribution kinds (DEC-1).
    /// Lifecycle id: **TEST-24** (see `.lifecycle/analysis-env-selection/TESTS.md`).
    #[test]
    fn a_converter_env_uses_the_same_key_and_grammar() {
        const DECLARED: &str = "fixture-env-b";
        let base = serde_json::json!({
            "id": "pkg.conv", "title": "T", "trigger": "on-ingest",
            "run": { "kind": "sandbox", "runtime": "python", "entry": "compute/e.py" }
        });
        let mut ok = base.clone();
        ok["env"] = serde_json::json!(DECLARED);
        let c: ConverterContribution = serde_json::from_value(ok).expect("parses");
        assert_eq!(c.env.as_deref(), Some(DECLARED));

        let mut bad = base;
        bad["env"] = serde_json::json!("Bad/Id");
        let err = serde_json::from_value::<ConverterContribution>(bad)
            .expect_err("a converter's malformed env is refused too");
        assert!(err.to_string().contains("`env`"), "{err}");
    }

    /// **TEST-E1-13** [covers: ITEM-13] — the `ConverterContribution::env` doc no longer
    /// promises an embedded-rootfs fallback.
    ///
    /// The claim was false and it mattered: it described exactly the
    /// substitute-and-continue behaviour INV-2 forbids ("`None` (or an unregistered id)
    /// falls back to the EMBEDDED rootfs"), so a reader could reasonably have built one.
    /// Embedding was removed when DEC-24 was reversed; an unresolvable env is a hard
    /// `SANDBOX_UNAVAILABLE`, not a fallback.
    ///
    /// Asserted over the doc TEXT because that is what the defect was — the code was
    /// already correct, and no behavioural test can fail on a lie in a comment.
    /// Lifecycle id: **TEST-25** (see `.lifecycle/analysis-env-selection/TESTS.md`).
    #[test]
    fn the_converter_env_doc_no_longer_promises_an_embedded_rootfs_fallback() {
        let src = include_str!("types.rs");
        // Locate the doc block attached to the field, so this cannot be satisfied by the
        // phrase merely being absent from some unrelated part of a large file.
        let anchor = "pub struct ConverterContribution {";
        let start = src.find(anchor).expect("the converter contribution type is here");
        let end = src[start..].find("\n}").map(|e| start + e).unwrap_or(src.len());
        let block = &src[start..end];
        assert!(block.contains("pub env: Option<String>"), "the field is in this block");
        assert!(
            !block.contains("EMBEDDED rootfs"),
            "the retired embedded-rootfs fallback claim is back in the `env` docs"
        );
        // And the correction is actually stated, so this is not satisfied by deleting the
        // documentation altogether.
        assert!(
            block.contains("no embedded-rootfs") || block.contains("DEPLOYMENT DEFAULT"),
            "the doc must say what `None` ACTUALLY does, not just omit the false claim"
        );
    }
}
