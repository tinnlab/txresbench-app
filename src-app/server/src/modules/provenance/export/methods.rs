//! Methods-text generator (ITEM-18). Deterministic templated params→prose per run
//! node in topological order + a Key Resources Table + a Data/Code Availability
//! statement. A per-kind hook narrates known kinds; omitting kinds get a generic
//! sentence. LLM polish is OFF by default (the artifact stays byte-stable).

use serde_json::Value;

pub use crate::modules::extensions::types::{
    MethodsNarration, MethodsParamRole, MethodsReferenceAsset, MethodsSubject,
};

/// A run node's method-relevant facts.
#[derive(Debug, Clone)]
pub struct MethodRun {
    pub kind: String,
    pub generator_id: String,
    pub generator_version: String,
    pub seed: Option<i64>,
    pub params: Value,
    /// The run's USED-EDGE input slot names (`bundle::build_bundle` fills these
    /// from `RunSpec::inputs`).
    ///
    /// An analysis' result may intersect an allow-list supplied through an INPUT
    /// SLOT, and **nothing in `params` records it** — so a narration that reads
    /// params alone describes a method that is strictly laxer than the one that ran.
    /// Which slots those are is DECLARED (`MethodsNarration::allow_list_slots`).
    pub input_slots: Vec<String>,
    /// **ITEM-20 / INV-3** — the slots this run consumed that were bound
    /// AUTOMATICALLY (`UsedEdgeDto.bound_by == "auto"`): the system picked the value
    /// and nobody reviewed the choice.
    ///
    /// Empty means there is nothing extra to say — and it means that for BOTH a run
    /// whose inputs were all picked by a person AND a run that recorded no origin at
    /// all (every run predating the field). The prose must never describe the second
    /// as reviewed: an unstated origin is unstated, not `user` (DEC-7).
    pub auto_bound_slots: Vec<String>,
    /// The DECLARED narration for this run's analysis (S3), resolved by the caller
    /// from `contributes.analyses[<generator_id>].methods`. `None` ⇒ the generic
    /// sentence. Threaded in rather than looked up here so `methods_text` stays PURE
    /// (registry-free, and directly unit-testable over any declaration).
    pub narration: Option<MethodsNarration>,
    /// **#77** — the digest of the ROOTFS this run executed in, as recorded on the run
    /// (`env_rootfs_sha256`).
    ///
    /// It was captured, threaded into `reproduce_script.rs` (`ensure_env <digest>`) and
    /// `readiness.json`, and then dropped on the floor for the methods text — while the
    /// Data-and-Code-Availability paragraph asserted that environment digests "are
    /// shipped in this reproducibility bundle" without printing one. It is the single
    /// field that pins EVERY baked asset at once, so a reader who wants to know what
    /// software actually ran has no other handle on it.
    ///
    /// `None` for a run that recorded none — which is a real gap, and is reported as
    /// one rather than passed over in silence.
    pub env_rootfs_sha256: Option<String>,
}

/// One versioned external resource, RESOLVED for a specific run (#77): the declaration
/// (`MethodsReferenceAsset`) names the params; this is what those params actually held.
///
/// Resolved here rather than in `bundle.rs` because the values come from the run's
/// recorded scientific params, which are already threaded into [`MethodRun`] — so
/// `methods_text` stays PURE and the whole mechanism is unit-testable over a literal
/// declaration, with no new query, column or migration.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ResolvedAsset {
    /// The package-owned class noun (`pretrained model`, `reference database`, …).
    kind: String,
    /// The asset's identity.
    name: String,
    /// The asset's version — REQUIRED, because an asset named without its version is
    /// exactly the untraceability this exists to close.
    version: String,
    /// Where it came from, when declared and recorded.
    source: Option<String>,
    /// Its content digest, when declared and recorded — the one facet that pins bytes
    /// rather than a name.
    digest: Option<String>,
    /// The PARAM names that supplied the facets above. They are excluded from the
    /// undeclared-param disclosure only because they were narrated HERE; an asset that
    /// does not resolve contributes nothing to this list, so its params fall back into
    /// the disclosure instead of vanishing (the never-drop guarantee).
    params: Vec<String>,
}

/// Generate deterministic methods prose for a topologically-ordered run list.
pub fn methods_text(runs: &[MethodRun]) -> String {
    let mut out = String::new();
    out.push_str("## Methods\n\n");
    if runs.is_empty() {
        out.push_str("No analysis steps were captured for this export.\n\n");
    }
    for (n, r) in runs.iter().enumerate() {
        // The auto-binding note is APPENDED to the run's own numbered sentence rather
        // than given a section of its own: it is a property OF that step, and a reader
        // scanning the method must meet it where the step is described, not in a
        // footnote they may never reach.
        out.push_str(&format!("{}. {}{}\n", n + 1, sentence_for(r), auto_bound_note(r)));
    }
    out.push('\n');

    out.push_str("## Key Resources Table\n\n");
    // In a real Methods section "Key Resources" means the pinned MATERIALS a result
    // depends on — reagents, software, reference builds and MODELS — so the table
    // carries the software packages (as it always did) AND every declared, resolved
    // reference asset (#77). Both are deduplicated in run order, so the artifact stays
    // byte-stable for fixed params.
    let mut seen: Vec<String> = Vec::new();
    for r in runs {
        let key = format!("{} v{}", r.generator_id, r.generator_version);
        if !seen.contains(&key) {
            seen.push(key);
        }
        for asset in resolved_assets(r) {
            let key = asset.key_resources_row();
            if !seen.contains(&key) {
                seen.push(key);
            }
        }
    }
    if seen.is_empty() {
        out.push_str("- (none)\n");
    } else {
        for k in &seen {
            out.push_str(&format!("- {k}\n"));
        }
    }
    out.push('\n');

    out.push_str("## Data and Code Availability\n\n");
    // The completeness claim here is DELIBERATELY scoped (F2-17): this generator
    // cannot know whether every code blob was retrievable, so it states what the
    // bundle carries and points at the artifact that DOES know (`readiness.json`),
    // instead of asserting that everything needed is present.
    out.push_str(
        "The per-step scripts, input checksums, and environment digests recorded for \
         this analysis are shipped in this reproducibility bundle. `readiness.json` \
         reports, per run, which of them were actually captured — a run with a gap is \
         named there, and its step refuses to run rather than completing having \
         computed nothing. Each step is re-runnable via `run.sh`, which finishes by \
         comparing the regenerated outputs against the recorded hashes \
         (`verify_outputs.sh`).\n",
    );
    out.push_str(&env_digest_paragraph(runs));
    out
}

/// **#77** — PRINT the environment digests, rather than asserting they are shipped.
///
/// The paragraph above claims the recorded environment digests ride in the bundle. It
/// did not print one, so a reader holding only `methods.md` — which is the whole point
/// of an out-of-app deliverable — could not tell WHICH environment produced the result,
/// even though the digest was captured on every run and handed to `run.sh`.
///
/// A step that recorded NO digest is reported as a gap rather than passed over: the
/// count is the honest form of "this document cannot pin every step's environment".
fn env_digest_paragraph(runs: &[MethodRun]) -> String {
    let mut digests: Vec<&str> = Vec::new();
    let mut missing = 0usize;
    for r in runs {
        match r.env_rootfs_sha256.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
            Some(d) if !digests.contains(&d) => digests.push(d),
            Some(_) => {}
            // A missing digest is a GAP only for a step that executed code. Every other
            // node kind legitimately records none — `readiness::env_pinned_flag_for_kind`
            // keeps their flag green for exactly that reason — so counting them here
            // would print a gap claim this bundle's OWN readiness report contradicts.
            // That is the same false-accusation shape this change exists to remove.
            None if executes_code(r) => missing += 1,
            None => {}
        }
    }
    if digests.is_empty() && missing == 0 {
        return String::new();
    }
    let mut s = String::from("\n");
    if !digests.is_empty() {
        let named = digests.iter().map(|d| format!("`{d}`")).collect::<Vec<_>>().join(", ");
        let (subject, verb) = if digests.len() == 1 {
            ("environment digest", "is")
        } else {
            ("environment digests", "are")
        };
        // The caption is deliberately KIND-NEUTRAL. The gap COUNT below is scoped to
        // steps that executed code (a non-executing node pins no rootfs by design), but
        // the digest SET is not: a digest a non-executing node happens to have recorded is
        // still a recorded fact, and captioning the set "for the steps that executed code"
        // would make the sentence false of its own contents rather than dropping them.
        // DELIBERATELY not "the digest of the software that ran": a rootfs digest pins the
        // IMAGE, and the resolved version of each library inside it is knowable only at run
        // time — which is why each step records those separately. Claiming the digest
        // answers "which software" would be the kind of statement that reads as true and
        // is not, in the one document meant to be trusted outside the app.
        s.push_str(&format!(
            "The {subject} the steps of this analysis recorded {verb} {named}. `run.sh` \
             re-enters a step's OWN recorded environment (`ensure_env`) before re-running \
             it, where that step recorded one. A digest identifies the IMAGE a step ran in, not the resolved \
             version of each library inside it; where a step records those, it does so in \
             the report artifact it emits alongside its outputs."
        ));
    }
    if missing > 0 {
        if !digests.is_empty() {
            s.push(' ');
        }
        s.push_str(&format!(
            "{missing} executed step(s) recorded NO environment digest, so this document \
             cannot identify the image they ran in — and `run.sh` SKIPS those steps rather \
             than re-running them in an unknown environment (see `readiness.json`)."
        ));
    }
    s.push('\n');
    s
}

/// Whether this run EXECUTED code, and therefore ought to have pinned an environment.
///
/// Mirrors `readiness::env_pinned_flag_for_kind`'s discriminator, deliberately: the two
/// statements are read side by side out of the same bundle, and a reader who finds them
/// disagreeing learns nothing except that the bundle cannot be trusted.
fn executes_code(r: &MethodRun) -> bool {
    r.kind == "compute"
}

/// Per-run narration hook. A run whose analysis DECLARES a methods narration
/// (S3 — `contributes.analyses[].methods`) gets the declared narration; everything
/// else gets a generic sentence.
///
/// Keying is on the run's DECLARATION, never on `kind`: the `kind` of EVERY sandbox
/// compute run is the literal `"compute"`, so a kind-keyed hook would either never
/// match or narrate every processor alike.
fn sentence_for(r: &MethodRun) -> String {
    let seed_note = match r.seed {
        Some(s) => format!(" (random seed {s})"),
        None => String::new(),
    };
    if let Some(spec) = r.narration.as_ref() {
        return declared_sentence(r, spec, &seed_note);
    }
    if r.kind.starts_with("selection.") {
        format!(
            "A selection was recorded using {} v{} as a reproducible \
             predicate recipe{seed_note}.",
            r.generator_id, r.generator_version
        )
    } else {
        // Generic fallback for any run whose analysis declares no narration.
        format!(
            "Step '{}' was performed using {} v{}{seed_note}.",
            r.kind, r.generator_id, r.generator_version
        )
    }
}

/// The sentence stating that this run consumed one or more AUTOMATICALLY bound
/// inputs, naming each slot. Empty for a run with none — which includes every run
/// recorded before the origin was carried, because absence is UNSTATED and prose that
/// said "the inputs were chosen by the operator" over an unstated record would assert
/// a review nobody performed (DEC-7 / INV-4).
///
/// It states the CONSEQUENCE, not just the mechanism: "no one reviewed the choice" is
/// the fact a reader of this bundle is entitled to weigh, and a note that only said
/// "bound automatically" leaves them to infer it.
fn auto_bound_note(r: &MethodRun) -> String {
    if r.auto_bound_slots.is_empty() {
        return String::new();
    }
    // Each name appears ONCE, and the count that decides the verb is that deduplicated count.
    //
    // A slot appears once per INPUT, not once per slot: a `multiple` slot binds one entry per
    // artifact, so the realistic plural is the SAME name twice — "The inputs `x`, `x` were
    // bound automatically", which reads as two inputs to a reviewer and is a miscount in the
    // one sentence whose whole job is to be counted on. An empty name is dropped rather than
    // rendered as an empty code span that names nothing.
    let mut named_slots: Vec<&str> = Vec::new();
    for slot in &r.auto_bound_slots {
        let trimmed = slot.trim();
        if trimmed.is_empty() || named_slots.contains(&trimmed) {
            continue;
        }
        named_slots.push(trimmed);
    }
    if named_slots.is_empty() {
        return String::new();
    }
    // Backticks in a slot name would close the code span and let the rest render as markdown;
    // stripped rather than escaped, because a slot name is an identifier and a name that needs
    // escaping is one this sentence should not be reproducing verbatim.
    let named = named_slots
        .iter()
        .map(|s| format!("`{}`", s.replace('`', "")))
        .collect::<Vec<_>>()
        .join(", ");
    let (subject, verb) =
        if named_slots.len() == 1 { ("input", "was") } else { ("inputs", "were") };
    format!(
        " The {subject} {named} {verb} bound automatically from the only compatible \
         candidate; no one reviewed the choice."
    )
}

/// Capitalize the first character (the declared plural opens the sentence).
fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(first) => first.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

/// The first param declared with `role`, if the run recorded a value for it.
fn param_with_role<'a>(
    r: &'a MethodRun,
    spec: &'a MethodsNarration,
    role: MethodsParamRole,
) -> Option<(&'a str, &'a Value)> {
    spec.params.iter().filter(|(_, v)| **v == role).find_map(|(k, _)| {
        r.params
            .get(k)
            .filter(|v| !v.is_null())
            .map(|v| (k.as_str(), v))
    })
}

/// **ITEM-8 / F2-15 / S3** — the DECLARATION-driven narration.
///
/// The rule this obeys, unchanged from the hardcoded version it replaces: **every
/// constraint the run applied is narrated, and a constraint that cannot be
/// faithfully narrated is DISCLOSED by name** (an opaque predicate, an input-slot
/// allow-list, an unrecognised param). Nothing is ever dropped — methods.md is the
/// out-of-app trust deliverable, so understating a method is the worst failure mode
/// this module has.
///
/// What changed is WHO supplies the vocabulary. The former `filter_sentence`
/// hardcoded one processor's analysis id, its nine param names, its four input-slot
/// spellings, and "cells" as the axis noun at nine sites; every other processor and
/// every other deployment therefore got `"Step 'compute' was performed"` forever.
/// Now the package declares its nouns + which ROLE each param plays, and the
/// rendering (which is what carries the never-drop guarantee) stays here.
///
/// The params are the SCIENTIFIC params resolved by `bundle::science_params` (the
/// promoted column, else the run's re-run spec for a pre-promotion run), so this
/// never names `language`/`arch`.
fn declared_sentence(r: &MethodRun, spec: &MethodsNarration, run_seed_note: &str) -> String {
    use MethodsParamRole as Role;

    let subjects = capitalize(&spec.subject.plural);

    // **The never-drop bookkeeping.** A param earns its exemption from the
    // undeclared-param disclosure by being NARRATED, never by being DECLARED.
    //
    // Declaring a role is a statement of INTENT; every role's rendering is conditional on
    // the recorded value actually being renderable (a threshold list can yield no phrase,
    // an allow-list can be empty, a cap can be non-numeric, a commit phrase can fail to
    // substitute). Exempting on declaration therefore opened a hole in the ONE guarantee
    // this module exists to keep: a recorded param could be absent from the narration AND
    // absent from the disclosure, i.e. silently dropped from the out-of-app trust
    // deliverable. Two shipped analyses were in that state for their output name. So
    // each arm below records what it actually rendered.
    let mut narrated: Vec<String> = Vec::new();
    let mut mark = |k: &str| {
        if !narrated.iter().any(|n| n == k) {
            narrated.push(k.to_string());
        }
    };

    // ---- the seed ----
    // Prefer the DECLARED seed param over the run column: a run whose seed lives only in
    // its science params used to narrate no seed at all, and (before the rule above) was
    // not disclosed either — the single most reproducibility-critical scalar, gone.
    let declared_seed = param_with_role(r, spec, Role::Seed);
    // Coerced from a numeric STRING as well as a number. Every shipped seed control is a
    // text field (`seed: { type: string, default: "0" }`), so the recorded value is
    // `"0"`, and `as_i64()` alone returns None for it — which meant the DECLARED seed was
    // never used on a real run, and (worse) the param was then disclosed as un-narrated
    // while the run column narrated the same value two clauses earlier. `as_count`
    // already coerces numeric strings for the subsample cap; the seed was the outlier.
    let declared_seed_value = declared_seed.and_then(|(_, v)| as_signed(v));
    if declared_seed_value.is_some() {
        if let Some((k, _)) = declared_seed {
            mark(k);
        }
    }
    let seed_note = match declared_seed_value {
        Some(s) => format!(" (random seed {s})"),
        None => run_seed_note.to_string(),
    };

    // ---- what the run COMMITS ----
    // Resolved through `scalar_param`, NOT through a bespoke `as_str().trim()`. The two
    // must reject the same values, or the reserved `{label}` alias becomes a route around
    // the rule that closes INV-1 on the VALUE side: a user-typed output name like
    // `cluster_{x}` would be rejected when the token names the param directly and
    // accepted when it arrives through the alias, putting a literal brace into the
    // deliverable by the one path the build gate cannot see. (Found by re-reading the
    // two call sites side by side; the round-1 test covered the direct path only.)
    let label: Option<(&str, String)> = param_with_role(r, spec, Role::OutputLabel)
        .and_then(|(k, _)| scalar_param(r, k).map(|v| (k, v)));
    let label_ref: Option<(&str, &str)> = label.as_ref().map(|(k, v)| (*k, v.as_str()));
    // The commit phrase is emitted ONLY once every one of its placeholders resolved. The
    // labelled phrase is tried first; if any token is missing from the run's record
    // (classically `{label}`, but now any declared param) the DECLARED unlabeled phrase is
    // tried; if that does not resolve either the clause is omitted — and its ABSENCE is
    // then disclosed, because a declared statement of what the step produced that silently
    // does not appear is exactly the under-report this module must never commit.
    //
    // Omitted, never rendered half-formed: the previous fallback substituted an EMPTY
    // string for an unrecorded `{label}` when no unlabeled phrase was declared, which put
    // "labelled ``" — a backticked slot naming nothing — into the deliverable. And every
    // OTHER token was not substituted at all, which put the literal braces there (#131).
    let rendered_commits = render_commits(r, spec, label_ref);
    let (commit_note, undrawn_commits) = match &rendered_commits {
        Some((phrase, used)) => {
            for k in used {
                mark(k);
            }
            (format!(", committing {phrase}"), String::new())
        }
        None if spec.commits.is_some() || spec.commits_unlabeled.is_some() => (
            String::new(),
            " This analysis declares a description of what it commits, and it is NOT stated \
             here: the recorded parameters it names could not all be resolved (see \
             `manifest.json`)."
                .to_string(),
        ),
        None => (String::new(), String::new()),
    };
    let tool = format!("{} v{}", r.generator_id, r.generator_version);

    // ---- the AND-ed contributors, in declaration order ----
    let mut constraints: Vec<String> = Vec::new();
    // Whether any CONSTRAINT-role param carried a SUBSTANTIVE value. It separates "the
    // run recorded no criteria" from "the run recorded criteria this document cannot
    // state" — two different facts, and saying the first when the second is true is a
    // false claim about the run, which is the whole class of defect being repaired here.
    //
    // "Substantive", not merely non-null: an explicitly EMPTY list (`criteria: []`) is a
    // recorded param that states NO criteria, so calling it "criteria recorded for this
    // run" would assert both that criteria exist and that a predicate was applied — the
    // very false accusation this discriminator exists to prevent, one level down.
    let mut recorded_a_constraint_param = false;
    // …and whether one was recorded AT ALL, empty or not. An explicitly empty value is a
    // third fact: the run DID record the parameter and it states nothing. Folding it into
    // "no criteria were recorded" makes the paragraph contradict itself two sentences
    // later, where the same param is named as recorded-but-unstated.
    let mut recorded_any_constraint_param = false;

    for (key, role) in &spec.params {
        let Some(value) = r.params.get(key).filter(|v| !v.is_null()) else { continue };
        let substantive = !is_empty_value(value);
        if matches!(
            role,
            Role::ThresholdList | Role::PredicateList | Role::OpaquePredicate | Role::AllowList
        ) {
            recorded_any_constraint_param = true;
        }
        match role {
            Role::ThresholdList => {
                recorded_a_constraint_param |= substantive;
                let phrases = threshold_phrases(value);
                if !phrases.is_empty() {
                    mark(key);
                    constraints.push(format!(
                        "{} ({})",
                        plural(phrases.len(), "recorded threshold", "recorded thresholds"),
                        phrases.join("; ")
                    ));
                }
            }
            Role::PredicateList => {
                recorded_a_constraint_param |= substantive;
                let phrases = criteria_phrases(value);
                if !phrases.is_empty() {
                    mark(key);
                    constraints.push(format!(
                        "{} ({})",
                        plural(phrases.len(), "1 criterion", "criteria"),
                        phrases.join("; ")
                    ));
                }
            }
            // Not faithfully narratable here, so it is NAMED rather than dropped.
            Role::OpaquePredicate => {
                recorded_a_constraint_param |= substantive;
                // The `substantive` guard applies HERE too. Without it an empty
                // `predicate: {}` narrated "filtered ON a recorded `predicate`
                // expression" — asserting a predicate constrained the result — and,
                // because the key was marked narrated, never reached the disclosure and
                // produced no gap sentence either. The same empty value would then mean
                // "no predicate was applied" for the other three constraint roles and "a
                // predicate was applied" for this one.
                if substantive {
                    mark(key);
                    constraints.push(format!(
                        "a recorded `{key}` expression (not narrated here — see \
                         `manifest.json` for its verbatim form)"
                    ));
                }
            }
            Role::AllowList => {
                recorded_a_constraint_param |= substantive;
                if let Some(n) = allow_list_len(value) {
                    mark(key);
                    constraints.push(format!(
                        "an explicit allow-list of {n} {} (the `{key}` parameter)",
                        spec.subject.plural
                    ));
                }
            }
            // None of these constrains the result. Each is marked narrated at the site
            // that actually renders it — the seed above, the subsample below, the label
            // and every `narrated_value` inside the commit phrase.
            Role::SubsampleCap | Role::Seed | Role::OutputLabel | Role::NarratedValue => {}
        }
    }

    // A DECLARED input SLOT allow-list. Recorded ONLY as a used edge — invisible to
    // any params-only reading of the run.
    for slot in &r.input_slots {
        let slot = slot.trim();
        if spec.allow_list_slots.iter().any(|s| s.trim() == slot) {
            constraints.push(format!(
                "the allow-list supplied in the `{slot}` input slot (its contents are \
                 the pinned input object, not a parameter)"
            ));
            break;
        }
    }

    // ---- the post-result seeded RANDOM subsample ----
    let subsample = param_with_role(r, spec, Role::SubsampleCap)
        .and_then(|(k, v)| as_count(v).map(|n| (k, n)))
        .map(|(cap_key, n)| {
            mark(cap_key);
            let seed = declared_seed_value.or(r.seed);
            format!(
                " The retained set was then reduced to at most {n} {} by a SEEDED RANDOM \
                 subsample{}, so the recorded result retains fewer {} than the constraints \
                 above alone imply.",
                spec.subject.plural,
                match seed {
                    Some(s) => format!(" (seed {s})"),
                    None => String::new(),
                },
                spec.subject.plural,
            )
        });

    // ---- the DECLARED, VERSIONED external resources this run consumed (#77) ----
    let assets = resolved_assets(r);
    let asset_note = asset_sentence(&assets);
    for a in &assets {
        for k in &a.params {
            mark(k);
        }
    }

    // ---- anything recorded that was not NARRATED ----
    // The mechanical guarantee behind "never silently drop a term": a param the narration
    // did not actually state degrades to a NAMED disclosure rather than to silence —
    // whether it carries no declared role at all, or carries one whose rendering did not
    // fire for this run's recorded value.
    //
    // The two kinds are listed SEPARATELY, because one sentence cannot be true of both.
    // "may further constrain the result" is the right hedge for a param the narration
    // does not model at all — it could be anything. It is FALSE for a param whose
    // declared role explicitly does not constrain (a label, a seed, a cap, an
    // interpolated value) and which simply did not render: saying the user's chosen
    // output name "may further constrain the result" is a new false statement about the
    // run, which is the class of defect this branch exists to remove.
    let mut undeclared: Vec<String> = Vec::new();
    let mut declared_stated: Vec<String> = Vec::new();
    let mut declared_named: Vec<String> = Vec::new();
    if let Some(m) = r.params.as_object() {
        for k in m.keys() {
            if narrated.iter().any(|n| n == k.as_str()) {
                continue;
            }
            // "Modelled by the narration" is not the same as "has a param role": a
            // reference-asset facet is declared under `reference_assets`, never under
            // `params`, and hedging it as something that "may further constrain the
            // result" is the sentence reserved for params the narration does not model at
            // all. Both declaration sites count.
            let declared_by_an_asset = spec.reference_assets.iter().any(|a| {
                a.name == *k
                    || a.version == *k
                    || a.source.as_deref() == Some(k.as_str())
                    || a.digest.as_deref() == Some(k.as_str())
            });
            if spec.params.contains_key(k.as_str()) || declared_by_an_asset {
                // Two lists, because one sentence cannot be true of both: a value the
                // narrator can render IS stated, and one it cannot (a list, a structure, a
                // value carrying markup) can only be named. Claiming to state a value while
                // merely naming the param is the gap-statement-instead-of-a-narration shape
                // this module is being repaired for.
                match disclosure_value(r, k) {
                    Some(v) => declared_stated.push(format!("`{k}` = {v}")),
                    None => declared_named.push(format!("`{k}`")),
                }
            } else {
                undeclared.push(format!("`{k}`"));
            }
        }
    }
    let mut unnarrated_note = String::new();
    if !undeclared.is_empty() {
        unnarrated_note.push_str(&format!(
            " Additional recorded parameters are NOT narrated here and may further \
             constrain the result: {} (see `manifest.json`).",
            undeclared.join(", ")
        ));
    }
    // The VALUE, where there is a renderable one. Naming a param without its value is the
    // gap-statement-instead-of-a-narration shape #77 objects to, and it is at its worst
    // here: the two params this list most often holds on a real run are the output
    // column's name and the RNG seed — the two most reproducibility-relevant scalars in
    // the record, both already in hand.
    if !declared_stated.is_empty() {
        unnarrated_note.push_str(&format!(
            " These recorded parameters were not narrated in the sentence above, so they \
             are stated here: {}.",
            declared_stated.join(", ")
        ));
    }
    if !declared_named.is_empty() {
        // Self-contained: it can be the ONLY disclosure sentence that fires, so it must
        // not open with a "too" that has no antecedent.
        unnarrated_note.push_str(&format!(
            " These recorded parameters were not narrated either, and their values are \
             not in a form this document can state: {} (see `manifest.json`).",
            declared_named.join(", ")
        ));
    }

    let head = if constraints.is_empty() {
        // #131 — "this analysis applies NO predicate" and "this analysis applies a
        // predicate that was not RECORDED" are different facts, and only the second
        // warrants a warning. The gap sentence used to be printed for both, so every
        // shipped analysis that applies no predicate at all — five of the six — told a
        // reader they had hidden something they never had, in the one document meant to
        // travel outside the app and be trusted.
        //
        // A third fact was hiding inside the second, and the disclosure above is what
        // surfaced it: a run that DID record a constraint param whose value states no
        // constraint this document can render. Saying "no criteria were recorded" there is
        // itself false — the same bundle's `manifest.json` shows the criteria — so that
        // case gets its own sentence.
        let gap = if !declares_a_predicate(spec) {
            ""
        } else if recorded_any_constraint_param && !recorded_a_constraint_param {
            // Recorded, and EMPTY. Saying "no criteria were recorded" would be denied by
            // the disclosure two sentences later (which names the param) and by the same
            // bundle's `manifest.json` (which carries it); saying a predicate was withheld
            // would be a false accusation. Both are avoidable: an empty constraint
            // parameter is a run that applied no predicate, and that is simply stated.
            " NOTE: the constraint parameters recorded for this run are empty, so no \
             predicate was applied."
        } else if recorded_a_constraint_param {
            // Deliberately does NOT say "the predicate it applied", and deliberately says
            // "constraint parameters" rather than "criteria": the roles that reach here
            // include an allow-list, and for a predicate/allow-list the narrator mirrors
            // the kernel, so rendering nothing usually means nothing WAS applied. Claiming
            // a withheld predicate would be the same false accusation this branch exists
            // to remove, one level down. A threshold list is the case where the two can
            // genuinely differ, so the sentence states BOTH possibilities and points at
            // the artifact that settles it.
            " NOTE: the constraint parameters recorded for this run render no constraint \
             here — either they imposed none, or they imposed one this document cannot \
             state; `manifest.json` carries their recorded form."
        } else {
            // "ANY predicate", not "THE predicate". The analysis declares a
            // constraint-producing role and the run recorded nothing for it, so this
            // document cannot tell whether a predicate was applied — which is precisely
            // the gap worth warning about. The original wording presumed one WAS applied,
            // which is a smaller version of the same false claim the branch above removes.
            " NOTE: no criteria were recorded for this run, so any predicate it applied \
             is not documented here."
        };
        format!("{subjects} were {} using {tool}{commit_note}{seed_note}.{gap}", spec.action)
    } else {
        let mut clause = format!("{subjects} were {} on {}", spec.action, constraints[0]);
        for extra in &constraints[1..] {
            clause.push_str(&format!(", intersected with {extra}"));
        }
        format!("{clause} using {tool}{commit_note}{seed_note}.")
    };
    // #131 — the note is narrated UNCONDITIONALLY. It used to live inside the
    // constraints branch, so a package declaring no constraint-producing param role
    // silently lost its entire scientific caveat with every gate green. The honest parts
    // were the parts being dropped.
    let note = match spec.note.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
        Some(n) => format!(" {n}"),
        None => String::new(),
    };
    format!(
        "{head}{note}{asset_note}{}{undrawn_commits}{unnarrated_note}",
        subsample.unwrap_or_default()
    )
}

/// Whether a recorded value states NOTHING: an empty list, an empty object, or a blank
/// string. Such a value is a recorded param that carries no content, and treating it as
/// content is how a document ends up asserting a fact its own data does not support.
fn is_empty_value(v: &Value) -> bool {
    match v {
        Value::Array(a) => a.is_empty(),
        Value::Object(o) => o.is_empty(),
        Value::String(s) => s.trim().is_empty(),
        Value::Null => true,
        _ => false,
    }
}

/// Whether this analysis APPLIES a predicate at all — i.e. whether it declares any
/// param role that can produce a constraint, or a slot-borne allow-list.
///
/// This is the discriminator #131 asks for. It reads the DECLARATION, not the run: an
/// analysis that declares `predicate_list` and recorded nothing DID apply a predicate
/// nobody wrote down (a real gap, worth warning about); an analysis that declares no
/// such role applied none, and telling a reader otherwise is a false statement about
/// the run.
fn declares_a_predicate(spec: &MethodsNarration) -> bool {
    use MethodsParamRole as Role;
    spec.params.values().any(|role| {
        matches!(
            role,
            Role::PredicateList | Role::ThresholdList | Role::OpaquePredicate | Role::AllowList
        )
    }) || spec.allow_list_slots.iter().any(|s| !s.trim().is_empty())
}

/// Every `{token}` in a phrase, as `(span, token)` in order; `None` for the whole phrase
/// if any brace is unbalanced (such a phrase can never be fully substituted, so it must
/// never be emitted).
///
/// The SPAN is what lets [`substitute_placeholders`] rebuild the string in ONE pass
/// instead of running `String::replace` over its own accumulating output, and it is what
/// keeps this the module's ONLY tokenizer — a second, inlined one would be free to drift
/// from the build gate it is pinned against.
///
/// Kept in lockstep with `processor_manifest_lint::methods_placeholder_tokens`, the BUILD
/// gate's tokenizer, by
/// `tests::the_build_lint_and_the_narrator_agree_on_what_a_placeholder_is`. They are two
/// implementations because `build.rs` runs before this crate compiles and cannot reach
/// into it; a divergence would let a token pass the gate and then fail to substitute,
/// which is exactly the silent-verbatim outcome the gate exists to prevent.
fn placeholder_tokens(phrase: &str) -> Option<Vec<(std::ops::Range<usize>, &str)>> {
    let mut out = Vec::new();
    let mut at = 0usize;
    while let Some(rel_open) = phrase[at..].find('{') {
        // `{` and `}` are ASCII, so every index here lands on a code-point boundary.
        let open = at + rel_open;
        let close = phrase[open + 1..].find('}')? + open + 1;
        let token = &phrase[open + 1..close];
        if token.contains('{') {
            return None; // braces that do not nest cleanly can never be substituted
        }
        out.push((open..close + 1, token));
        at = close + 1;
    }
    Some(out)
}

/// Substitute every placeholder in `phrase`, or return `None` if ANY of them cannot be
/// resolved from this run's record.
///
/// ## One pass, never `String::replace`
///
/// The output is built from the token SPANS, left to right, and a substituted value is
/// never re-scanned. A sequential `replace` over the accumulating string had two
/// data-dependent failure modes, both reachable from a user-typed output name: a value
/// containing braces put a literal `{…}` into the deliverable the build gate exists to
/// keep out, and a value that happened to SPELL a later token was itself replaced by
/// that token's value — so the document stated a value the run never recorded.
///
/// ## A DECLARED param named `label` wins over the reserved alias
///
/// `{label}` is the reserved alias for the `output_label` param's value, whatever that
/// param is spelled — but only when the analysis DECLARES no param named `label`. The
/// discriminator is the DECLARATION, not the run's record: testing the record first let
/// an undeclared param that happens to be named `label` shadow the declared output label
/// on some runs and not others, and the build gate — which can only see the manifest —
/// had no way to see it coming. Keying on the declaration makes the gate's verdict and
/// this function's behaviour the same statement about the same text, which is the
/// property that lets the gate refuse the genuinely ambiguous shape. The one shipped
/// manifest that uses the reserved token spells its label param `label` too, so both
/// readings agree there and its exported output is unchanged.
///
/// Returns the substituted text plus the PARAM NAMES it consumed — those names are what
/// earn a param its exemption from the undeclared-param disclosure, so the reserved alias
/// reports the OUTPUT-LABEL PARAM's name rather than the literal token.
fn substitute_placeholders(
    r: &MethodRun,
    spec: &MethodsNarration,
    phrase: &str,
    label: Option<(&str, &str)>,
) -> Option<(String, Vec<String>)> {
    let tokens = placeholder_tokens(phrase)?;
    let mut out = String::with_capacity(phrase.len());
    let mut used: Vec<String> = Vec::new();
    let mut cursor = 0usize;
    for (span, token) in tokens {
        out.push_str(&phrase[cursor..span.start]);
        // The reserved token resolves by the DECLARATION, not by what the run happened to
        // record. Testing the run's record first let an UNDECLARED param that happens to
        // be named `label` shadow the declared output label on some runs and not others —
        // run-dependent, and invisible to the build gate, which can only see the manifest.
        // Keying on the declaration makes the gate's verdict and the narrator's behaviour
        // the same statement about the same text.
        let reserved = token == crate::processor_manifest_lint::METHODS_RESERVED_PLACEHOLDER;
        let use_alias = reserved && !spec.params.contains_key(token);
        let (name, value) = if use_alias {
            let (name, v) = label?;
            (name.to_string(), v.to_string())
        } else {
            // NO alias fallback here. Once the analysis DECLARES a param named `label`,
            // that declaration is what `{label}` names; falling back to a different
            // param's value when this run did not record it would be the round-1 defect in
            // reverse — a run-dependent wrong value, and the phrase would say nothing about
            // which param it came from. Unresolvable is the honest answer: the clause falls
            // back to `commits_unlabeled`, and the param is disclosed.
            match scalar_param(r, token) {
                Some(v) => (token.to_string(), v),
                None => return None,
            }
        };
        if !used.contains(&name) {
            used.push(name);
        }
        out.push_str(&value);
        cursor = span.end;
    }
    out.push_str(&phrase[cursor..]);
    Some((out, used))
}

/// A run's recorded value for `key`, as prose — `None` when the run recorded nothing
/// usable.
///
/// Four rejections, each of which makes the phrase unrenderable rather than half-formed:
///
///  * absent / `null` — nothing to say;
///  * a blank or whitespace-only string — substituting it produces a phrase naming
///    nothing, which is the failure `commits_unlabeled` exists to avoid;
///  * a list or object — unreadable interpolated into a prose sentence, and an
///    unreadable sentence in the trust deliverable is worse than the unlabeled phrasing;
///  * **a value containing a brace** — INV-1 says no unsubstituted `{…}` may reach a
///    generated `methods.md`, and a param value is USER TEXT (an output name typed in
///    the app, or supplied through the agent path). Substituting `cluster_{x}` would put
///    exactly the token the build gate exists to keep out into the deliverable, by a
///    route no manifest lint can see.
///
/// A rejected value is never lost: the phrase falls back, and the param then appears in
/// the undeclared-param disclosure.
fn scalar_param(r: &MethodRun, key: &str) -> Option<String> {
    let v = r.params.get(key).filter(|v| !v.is_null())?;
    if v.is_array() || v.is_object() {
        return None;
    }
    let s = render_scalar(v);
    let s = s.trim();
    // Rejected, in every case falling back to naming the param without its value — which
    // is a smaller loss than any of these reaching the document:
    //  * empty — a phrase naming nothing;
    //  * a BRACE — INV-1 says no `{…}` may reach a generated methods.md, and a param value
    //    is user text, so this is the one route no manifest lint can see;
    //  * a BACKTICK — every site that prints a value wraps it in a markdown code span, and
    //    a backtick inside closes the span early, letting the rest of the sentence render
    //    as markup (the same reason `auto_bound_note` refuses one in a slot name);
    //  * a CONTROL character — a newline in a numbered list item breaks the list;
    //  * absurdly long — a paragraph is not a data dump, and a value this size is not
    //    something a reader can use in prose. `manifest.json` carries it verbatim.
    if s.is_empty()
        || s.contains('{')
        || s.contains('}')
        || s.contains('`')
        || s.chars().any(char::is_control)
        || s.chars().count() > 200
    {
        return None;
    }
    Some(s.to_string())
}

/// A recorded value as the DISCLOSURE should state it, or `None` when it genuinely
/// cannot be stated in prose.
///
/// This is deliberately WIDER than [`scalar_param`], which answers a different question:
/// "can this be interpolated into a sentence?". A `null`, an empty string and an empty
/// list are all unusable there, but each is perfectly statable HERE — and stating them is
/// the point, because a param recorded with no value is a fact about the run. Routing
/// them through `scalar_param` put them under "their values are not in a form this
/// document can state", which is false twice over: the value is statable, and for a null
/// the sentence also contradicts the head that has just said nothing was recorded. On the
/// DEFAULT shipped run of one analysis that sentence fired for the batch column, reading
/// as "a batch column exists but this document will not name it" when none was chosen.
fn disclosure_value(r: &MethodRun, key: &str) -> Option<String> {
    let v = r.params.get(key)?;
    if v.is_null() {
        return Some("(no value recorded)".to_string());
    }
    if is_empty_value(v) {
        return Some("(empty)".to_string());
    }
    scalar_param(r, key).map(|s| format!("`{s}`"))
}

/// The commit clause: the labelled phrase if it fully resolves, else the declared
/// unlabeled phrase if IT fully resolves, else nothing.
fn render_commits(
    r: &MethodRun,
    spec: &MethodsNarration,
    label: Option<(&str, &str)>,
) -> Option<(String, Vec<String>)> {
    spec.commits
        .as_deref()
        .and_then(|c| substitute_placeholders(r, spec, c, label))
        .or_else(|| {
            spec.commits_unlabeled
                .as_deref()
                .and_then(|c| substitute_placeholders(r, spec, c, label))
        })
}

/// Resolve every DECLARED reference asset against this run's recorded params (#77).
///
/// An asset is narrated only when BOTH its identity and its version resolved: naming a
/// model without its version is the untraceability this exists to close, so a
/// half-resolved asset is dropped from the narration — and, because its params then
/// appear in no `ResolvedAsset::params`, they fall back into the undeclared-param
/// disclosure rather than disappearing.
fn resolved_assets(r: &MethodRun) -> Vec<ResolvedAsset> {
    let Some(spec) = r.narration.as_ref() else { return Vec::new() };
    spec.reference_assets
        .iter()
        .filter_map(|decl| resolve_asset(r, decl))
        .collect()
}

fn resolve_asset(r: &MethodRun, decl: &MethodsReferenceAsset) -> Option<ResolvedAsset> {
    let mut params = vec![decl.name.clone(), decl.version.clone()];
    let name = scalar_param(r, &decl.name)?;
    let version = scalar_param(r, &decl.version)?;
    let mut optional = |declared: Option<&String>| {
        declared.and_then(|p| {
            let v = scalar_param(r, p)?;
            params.push(p.clone());
            Some(v)
        })
    };
    let source = optional(decl.source.as_ref());
    let digest = optional(decl.digest.as_ref());
    let kind = decl.kind.trim();
    Some(ResolvedAsset {
        // A declaration with a blank `kind` still narrates — with the structural word,
        // never a silently-empty noun phrase.
        kind: if kind.is_empty() { "reference resource".to_string() } else { kind.to_string() },
        name,
        version,
        source,
        digest,
        params,
    })
}

impl ResolvedAsset {
    /// The Key-Resources-Table row: `(name, version, source, digest)`, which is what a
    /// real Key Resources entry carries — not the `<id> v<version>` package row that
    /// was the table's only vocabulary.
    fn key_resources_row(&self) -> String {
        let mut row = format!("{}: {} v{}", self.kind, self.name, self.version);
        let mut tail: Vec<String> = Vec::new();
        if let Some(s) = &self.source {
            tail.push(format!("source: {s}"));
        }
        if let Some(d) = &self.digest {
            tail.push(format!("sha256 {d}"));
        }
        if !tail.is_empty() {
            row.push_str(&format!(" ({})", tail.join("; ")));
        }
        row
    }

    /// The in-sentence phrase — identity AND version, always together.
    fn prose(&self) -> String {
        let mut p = format!("the {} `{}`, version `{}`", self.kind, self.name, self.version);
        let mut tail: Vec<String> = Vec::new();
        if let Some(s) = &self.source {
            tail.push(format!("source `{s}`"));
        }
        if let Some(d) = &self.digest {
            tail.push(format!("sha256 `{d}`"));
        }
        if !tail.is_empty() {
            p.push_str(&format!(" ({})", tail.join("; ")));
        }
        p
    }
}

/// The sentence naming every resolved reference asset (#77). Empty when the analysis
/// declares none — which is every shipped analysis today, so this adds nothing to an
/// existing export.
fn asset_sentence(assets: &[ResolvedAsset]) -> String {
    if assets.is_empty() {
        return String::new();
    }
    let named = assets.iter().map(ResolvedAsset::prose).collect::<Vec<_>>().join("; ");
    let (subject, verb) = if assets.len() == 1 {
        ("resource", "was")
    } else {
        ("resources", "were")
    };
    format!(" The following pinned reference {subject} {verb} used: {named}.")
}

/// `1 criterion` / `N criteria`-style counting (the singular form is given whole
/// so an irregular plural reads correctly).
fn plural(n: usize, singular: &str, plural_word: &str) -> String {
    if n == 1 {
        if singular.starts_with('1') { singular.to_string() } else { format!("1 {singular}") }
    } else {
        format!("{n} {plural_word}")
    }
}

/// A signed integer from a JSON number or numeric string. The string case is not an
/// edge case: it is the shape every shipped seed control produces.
fn as_signed(v: &Value) -> Option<i64> {
    match v {
        Value::Number(n) => n.as_i64(),
        Value::String(s) => s.trim().parse::<i64>().ok(),
        _ => None,
    }
}

/// A non-negative integer count from a JSON number or numeric string (the shapes
/// `max_cells` / a `gate` length arrive in).
fn as_count(v: &Value) -> Option<u64> {
    match v {
        Value::Number(n) => n.as_u64().or_else(|| n.as_f64().and_then(|f| (f >= 0.0).then_some(f as u64))),
        Value::String(s) => s.trim().parse::<u64>().ok(),
        _ => None,
    }
}

/// The length of an `allow_list`-role param's element list. `None` when the value is
/// not a non-empty list (an empty/absent allow-list constrains nothing, matching the
/// kernels that require a non-empty list before intersecting).
fn allow_list_len(value: &Value) -> Option<usize> {
    let n = value.as_array()?.len();
    (n > 0).then_some(n)
}

/// The measured-quantity spellings the `threshold_list` ROLE defines. Generic
/// measurement words, owned by the role — not one package's field names. Any key
/// outside this set and [`THRESHOLD_BOUND_KEYS`] is a qualifier the PROCESSOR named,
/// and is rendered under that name.
const THRESHOLD_MEASURE_KEYS: [&str; 3] = ["metric", "col", "criteria"];

/// The two bound spellings the `threshold_list` role defines. They are the range
/// grammar itself: a lower/upper direction cannot be recovered from a value, so it
/// is the one thing the role must fix rather than read off the data.
const THRESHOLD_BOUND_KEYS: [&str; 2] = ["min", "max"];

/// Render a `threshold_list`-role param in the same range grammar the criteria use.
///
/// ## The role owns three slots; every other field is named by the PROCESSOR
///
/// An entry contributes a measured quantity ([`THRESHOLD_MEASURE_KEYS`]) and up to
/// two bounds ([`THRESHOLD_BOUND_KEYS`]). **Everything else it records is rendered
/// under the key the processor itself chose** — a qualifier spelled `sample` reads
/// `(sample S1)`, one spelled `ident` reads `(ident S1)`, one spelled `well` reads
/// `(well A1)`, and one spelled `replicate` reads `(replicate 2)`.
///
/// This replaces an `obj.get("sample").or_else(|| obj.get("ident"))` alias probe that
/// formatted the literal word `sample` into the output. Two things were wrong with
/// it. It stamped ONE domain's noun into methods.md — the out-of-app deliverable a
/// user cites in a publication — for every processor that ever adopts this role. And
/// because it recognised exactly two spellings, a THIRD qualifier a processor
/// recorded was silently DROPPED, understating the method: the single failure mode
/// this module exists to prevent. Rendering by the recorded key fixes both at once,
/// and needs no new declaration: the processor already spelled the slot, in its own
/// params.
///
/// Accepted shapes are unchanged: a LIST of entry objects, and the nested MAP
/// `{measure: {group: [lo, hi]}}`. The map's inner key is a VALUE — nothing in the
/// data names it — so it is labelled with the structural word `group`.
///
/// Before this function existed, a run whose predicate lived in `thresholds` was
/// narrated "no filter criteria were recorded … not documented here" — a false claim
/// of absent provenance that the SAME bundle's `manifest.json` contradicts.
fn threshold_phrases(raw: &Value) -> Vec<String> {
    let mut out = Vec::new();
    match raw {
        // Nested map: {measure: {group: [lo, hi]}}.
        Value::Object(map) => {
            for (measure, per_group) in map {
                let Some(groups) = per_group.as_object() else { continue };
                for (group, range) in groups {
                    let arr = range.as_array().map(|a| a.as_slice()).unwrap_or(&[]);
                    let lo = arr.first().and_then(bound_of);
                    let hi = arr.get(1).and_then(bound_of);
                    if let Some(p) = range_phrase(measure, lo, hi) {
                        out.push(format!("{p} (group {group})"));
                    }
                }
            }
        }
        Value::Array(list) => {
            for t in list {
                let Some(obj) = t.as_object() else { continue };
                let Some(measure_key) = THRESHOLD_MEASURE_KEYS.iter().copied().find(|k| {
                    obj.get(*k)
                        .and_then(Value::as_str)
                        .is_some_and(|s| !s.trim().is_empty())
                }) else {
                    continue;
                };
                let measure = obj[measure_key].as_str().unwrap_or_default().trim();
                let lo = obj.get("min").and_then(bound_of);
                let hi = obj.get("max").and_then(bound_of);
                let Some(p) = range_phrase(measure, lo, hi) else { continue };
                // Every REMAINING recorded field, under the processor's own key.
                // Iteration is over `serde_json`'s ordered map, so the rendering is
                // byte-stable for fixed params (what `methods_text` guarantees).
                let quals: Vec<String> = obj
                    .iter()
                    .filter(|(k, _)| {
                        k.as_str() != measure_key && !THRESHOLD_BOUND_KEYS.contains(&k.as_str())
                    })
                    .filter_map(|(k, v)| qualifier_phrase(v).map(|s| format!("{k} {s}")))
                    .collect();
                if quals.is_empty() {
                    out.push(p);
                } else {
                    out.push(format!("{p} ({})", quals.join(", ")));
                }
            }
        }
        _ => {}
    }
    out
}

/// A threshold qualifier's VALUE as prose. `None` for a field that records nothing
/// (`null`, or a blank string): such a field restricts nothing, so naming it would
/// add noise rather than provenance. A non-scalar value is rendered compactly rather
/// than dropped — an unreadable qualifier is still a narrated one.
fn qualifier_phrase(v: &Value) -> Option<String> {
    match v {
        Value::Null => None,
        Value::String(s) => {
            let s = s.trim();
            (!s.is_empty()).then(|| s.to_string())
        }
        other => Some(render_scalar(other)),
    }
}

/// The canonical bound coercion, shared with the criteria reader.
fn bound_of(v: &Value) -> Option<f64> {
    super::super::criteria_script::criterion_bound(Some(v))
}

/// `col ≥ lo` / `col ≤ hi` / `col between lo and hi`; `None` when unconstrained.
fn range_phrase(col: &str, lo: Option<f64>, hi: Option<f64>) -> Option<String> {
    match (lo, hi) {
        (Some(lo), Some(hi)) => Some(format!("{col} between {} and {}", fmt_bound(lo), fmt_bound(hi))),
        (Some(lo), None) => Some(format!("{col} ≥ {}", fmt_bound(lo))),
        (None, Some(hi)) => Some(format!("{col} ≤ {}", fmt_bound(hi))),
        (None, None) => None,
    }
}

/// Render each `{column, control?, min?, max?, keep?}` criterion (the shape the
/// cell-filter run params carry) as a human predicate phrase. A criterion with no
/// column, or that imposes no constraint, is skipped — never narrated as an
/// unbounded filter.
///
/// The narration must describe the filter that ACTUALLY RAN, so it applies the same
/// two rules the keep-mask and the predicate builder do:
///
///  * **Categorical FIRST** (`cell-filter.py::_is_categorical_criterion` /
///    `criteriaPredicate.ts::isCategoricalCriterion`). Matching on `(min, max, ..)`
///    first narrated `{column:"leiden", keep:["1","2"], min:0, max:5}` as
///    `leiden between 0 and 5`, while the mask and the recorded predicate treated it
///    as the keep-set and dropped the bounds — an exported methods section stating
///    a filter nobody applied.
///  * **The canonical bound coercion** (`criteria_script::bound`), not a bare null
///    check. `{column:"n_genes", min:""}` is an UNTOUCHED control: the mask applies
///    no constraint, but a null-check-only read rendered `n_genes >= ` with an empty
///    bound.
fn criteria_phrases(raw: &Value) -> Vec<String> {
    let Some(list) = raw.as_array() else {
        return Vec::new();
    };
    list.iter()
        .filter_map(|c| {
            let col = c.get("column").and_then(Value::as_str)?.trim();
            if col.is_empty() {
                return None;
            }
            let obj = c.as_object()?;
            if super::super::criteria_script::criterion_is_categorical(obj) {
                let keep: Vec<String> = obj
                    .get("keep")
                    .and_then(Value::as_array)
                    .map(|k| k.iter().map(render_scalar).collect())
                    .unwrap_or_default();
                if keep.is_empty() {
                    return None; // an empty keep-set imposes no constraint
                }
                return Some(format!("{col} in [{}]", keep.join(", ")));
            }
            let min = super::super::criteria_script::criterion_bound(obj.get("min"));
            let max = super::super::criteria_script::criterion_bound(obj.get("max"));
            range_phrase(col, min, max)
        })
        .collect()
}

/// A coerced bound as prose — an integral value without a `.0` tail (so a `10`
/// typed by the user still reads as `10`, not `10.0`).
fn fmt_bound(v: f64) -> String {
    if v.fract() == 0.0 && v.abs() < 1e15 {
        format!("{}", v as i64)
    } else {
        format!("{v}")
    }
}

/// A JSON scalar as prose (a string without its quotes; anything else verbatim).
///
/// A keep-set value is rendered in PYTHON's spelling — `True`/`False`/`None`, not
/// serde's `true`/`false`/`null` — because that is the spelling the committed mask
/// compares in (`str(x)`), the spelling `emit_criteria_script` writes into the replay
/// script, and therefore the only spelling a reader could match against the data.
/// Narrating `flags in [true]` described a keep-set that does not exist.
fn render_scalar(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Bool(true) => "True".to_string(),
        Value::Bool(false) => "False".to_string(),
        Value::Null => "None".to_string(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal run whose ONLY interesting property is which of its inputs were bound
    /// automatically — so the note under test is not entangled with narration or params.
    fn run_with_auto(slots: &[&str]) -> MethodRun {
        MethodRun {
            kind: "compute.step".into(),
            generator_id: "some.tool".into(),
            generator_version: "1.0".into(),
            seed: None,
            params: serde_json::json!({}),
            input_slots: Vec::new(),
            auto_bound_slots: slots.iter().map(|s| (*s).to_string()).collect(),
            narration: None,
            env_rootfs_sha256: None,
        }
    }

    // TEST-24 (binding-origin / ITEM-20) — the exported prose NAMES the unreviewed inputs.
    //
    // Every other fixture in this module declares `auto_bound_slots: Vec::new()`, so before
    // this the empty arm was the only one any unit test drove and the PLURAL branch had never
    // executed. A reader of methods.md is the audience this whole change is for; a sentence
    // that is wrong in the plural is wrong for exactly the run with the most unreviewed
    // inputs.
    #[test]
    fn auto_bound_note_states_the_singular_the_plural_and_the_silence() {
        // SILENCE. A run where a person chose everything says nothing extra — a marker that
        // appeared on every run would stop being read (the design's own corollary).
        let none = methods_text(&[run_with_auto(&[])]);
        assert!(
            !none.contains("bound automatically"),
            "a fully-reviewed run must add no note: {none}"
        );

        // SINGULAR — and it names the slot, because "an input was guessed" without saying
        // WHICH is a disclaimer rather than a fact a reader can act on.
        let one = methods_text(&[run_with_auto(&["expression"])]);
        assert!(one.contains("The input `expression` was bound automatically"), "{one}");
        assert!(one.contains("no one reviewed the choice"), "{one}");
        assert!(!one.contains("were bound"), "singular must not use the plural verb: {one}");

        // PLURAL — every slot named, and the verb agreeing. This branch had no coverage at all.
        let two = methods_text(&[run_with_auto(&["expression", "gene_names"])]);
        assert!(
            two.contains("The inputs `expression`, `gene_names` were bound automatically"),
            "{two}"
        );
        assert!(!two.contains("was bound automatically"), "plural must not use the singular verb: {two}");

        // The REALISTIC plural: a `multiple` slot binds one entry per artifact, so the same
        // name arrives twice. Rendering it twice reads as two inputs to a reviewer, which is a
        // miscount in the one sentence whose whole job is to be counted on — and the verb must
        // follow the DEDUPLICATED count, not the raw length.
        let dup = methods_text(&[run_with_auto(&["expression", "expression"])]);
        assert!(dup.contains("The input `expression` was bound automatically"), "{dup}");
        assert!(!dup.contains("`expression`, `expression`"), "a repeated slot is named once: {dup}");

        // A blank name is dropped rather than rendered as a code span naming nothing.
        let blank = methods_text(&[run_with_auto(&["", "expression"])]);
        assert!(blank.contains("The input `expression` was bound automatically"), "{blank}");
        assert!(!blank.contains("``"), "an empty slot name must not render an empty span: {blank}");

        // …and a run whose ONLY slot names are blank says nothing at all, rather than emitting
        // a sentence about no inputs.
        let all_blank = methods_text(&[run_with_auto(&["", "  "])]);
        assert!(!all_blank.contains("bound automatically"), "{all_blank}");
    }

    // TEST-10: prose is deterministic for fixed params, narrates seeds + a
    // selection, and a kind lacking a hook gets the generic fallback sentence.
    #[test]
    fn methods_deterministic_and_narrated() {
        let runs = vec![
            MethodRun {
                kind: "selection.column".into(),
                generator_id: "provenance.selection".into(),
                generator_version: "1.0".into(),
                seed: Some(7),
                params: serde_json::json!({"col": "leiden"}),
                input_slots: Vec::new(),
                auto_bound_slots: Vec::new(),
                narration: None,
                env_rootfs_sha256: None,
            },
            MethodRun {
                kind: "compute.unknownkind".into(),
                generator_id: "custom.tool".into(),
                generator_version: "2.3".into(),
                seed: None,
                params: serde_json::json!({}),
                input_slots: Vec::new(),
                auto_bound_slots: Vec::new(),
                narration: None,
                env_rootfs_sha256: None,
            },
        ];
        let a = methods_text(&runs);
        let b = methods_text(&runs);
        assert_eq!(a, b, "byte-stable for fixed params");
        assert!(a.contains("A selection was recorded"), "narrates the selection step");
        assert!(a.contains("random seed 7"), "narrates the seed");
        assert!(a.contains("Step 'compute.unknownkind' was performed"), "generic fallback for unknown kind");
        assert!(a.contains("Key Resources Table") && a.contains("Data and Code Availability"));
    }

    /// The narration the SHIPPED `packages/cell-filter/manifest.yaml` declares
    /// (S3). Parsed from the real file, not retyped here: these tests are the gate
    /// on the exported methods.md, so a manifest edit that silently drops a param
    /// role must break them rather than be masked by a test-local copy.
    fn shipped_cell_filter_narration() -> MethodsNarration {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../packages/cell-filter/manifest.yaml");
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        let manifest: crate::modules::extensions::types::ExtensionManifest =
            serde_norway::from_str(&text).expect("the shipped cell-filter manifest parses");
        manifest
            .contributes
            .analyses
            .into_iter()
            .find(|a| a.id == "cell.filter")
            .expect("the shipped manifest declares the cell.filter analysis")
            .methods
            .expect(
                "the shipped cell.filter analysis declares a `methods` narration — without                  it every exported methods.md degrades to \"Step 'compute' was performed\"",
            )
    }

    fn filter_run(params: Value) -> MethodRun {
        filter_run_with_slots(params, Vec::new())
    }

    fn filter_run_with_slots(params: Value, input_slots: Vec<String>) -> MethodRun {
        MethodRun {
            // A sandbox compute run's kind is the literal "compute" for EVERY
            // processor — the discriminator is the analysis' own DECLARATION.
            kind: "compute".into(),
            generator_id: "cell.filter".into(),
            generator_version: "0.1.0".into(),
            seed: Some(42),
            params,
            input_slots,
            auto_bound_slots: Vec::new(),
            narration: Some(shipped_cell_filter_narration()),
            env_rootfs_sha256: None,
        }
    }

    // S3 — THE FINDING: a DIFFERENT domain's analysis gets a real methods sentence,
    // not "Step 'compute' was performed". The narrator hardcoded one processor's
    // analysis id (`CELL_FILTER_GENERATOR_ID = "cell.filter"`), its param names, its
    // input-slot spellings and "cells" as the axis noun; since the `kind` of EVERY
    // sandbox compute run is the literal "compute", every other processor and every
    // non-single-cell deployment exported the generic sentence forever — in the
    // OUT-OF-APP trust deliverable.
    //
    // Nothing below mentions a cell. The declaration supplies the nouns; the
    // narrator supplies the rendering AND the never-drop guarantee.
    //
    // RED ON REVERT: restore the `generator_id == "cell.filter"` hook and this run
    // falls through to `Step 'compute' was performed`.
    #[test]
    fn a_non_single_cell_analysis_is_narrated_from_its_own_declaration() {
        let spec: MethodsNarration = serde_json::from_value(serde_json::json!({
            "subject": { "singular": "well", "plural": "wells" },
            "action": "excluded",
            "commits": "the per-well exclusion column `drop_{label}`",
            "commits_unlabeled": "a per-well exclusion column",
            "note": "The plate readout itself was not modified.",
            "params": {
                "cutoffs": "threshold_list",
                "rules": "predicate_list",
                "expression": "opaque_predicate",
                "picked": "allow_list",
                "max_wells": "subsample_cap",
                "rng": "seed",
                "tag": "output_label"
            },
            "allow_list_slots": ["wells", "well-set"]
        }))
        .expect("the declaration parses");

        let run = MethodRun {
            kind: "compute".into(),
            generator_id: "plate.qc".into(),
            generator_version: "2.1".into(),
            seed: None,
            params: serde_json::json!({
                "cutoffs": [{ "metric": "z_prime", "min": 0.5 }],
                "rules": [{ "column": "plate_row", "keep": ["A", "B"] }],
                "expression": { "gt": [{ "col": "z" }, 1] },
                "picked": ["w1", "w2", "w3"],
                "max_wells": 2,
                "rng": 7,
                "tag": "edge",
                "some_future_knob": true
            }),
            input_slots: vec!["readout".into(), "well-set".into()],
            auto_bound_slots: Vec::new(),
            narration: Some(spec),
            env_rootfs_sha256: None,
        };
        let text = methods_text(&[run]);

        assert!(!text.contains("Step 'compute' was performed"), "not the generic fallback: {text}");
        // Every noun comes from the DECLARATION — nothing single-cell survives.
        assert!(text.contains("Wells were excluded on"), "declared subject + action: {text}");
        assert!(!text.to_lowercase().contains("cell"), "no other domain's noun: {text}");
        // …and every contributor the run applied is still narrated or disclosed.
        for needle in [
            "z_prime \u{2265} 0.5",                   // threshold_list
            "plate_row in [A, B]",                    // predicate_list
            "`expression` expression",                // opaque_predicate, disclosed by name
            "allow-list of 3 wells",                  // allow_list, declared plural
            "`well-set` input slot",                  // declared allow-list SLOT
            "at most 2 wells",                        // subsample_cap
            "SEEDED RANDOM",
            "(seed 7)",                               // seed role, not the run column
            "`drop_edge`",                            // commits, {label} filled
            "The plate readout itself was not modified.",
            "`some_future_knob`",                     // undeclared param → NAMED, never dropped
        ] {
            assert!(text.contains(needle), "missing `{needle}` in: {text}");
        }
    }

    // THE FINDING (threshold value grammar): the narrator renders a `threshold_list`
    // entry's qualifiers under THE KEYS THE PROCESSOR CHOSE, so no processor's field
    // spelling — and no domain's noun — is baked into the deliverable.
    //
    // RED ON REVERT: restore `obj.get("sample").or_else(|| obj.get("ident"))` +
    // `format!("{p} (sample {})")` and (a) the `ident`/`well` spellings all render as
    // the literal word "sample", (b) `replicate` is silently DROPPED, and (c) the
    // nested map reads "(sample …)".
    #[test]
    fn threshold_qualifiers_render_under_the_processors_own_keys() {
        let spec: MethodsNarration = serde_json::from_value(serde_json::json!({
            "subject": { "singular": "site", "plural": "sites" },
            "action": "gated",
            "params": { "cutoffs": "threshold_list" }
        }))
        .expect("the declaration parses");
        let narrate = |cutoffs: Value| {
            methods_text(&[MethodRun {
                kind: "compute".into(),
                generator_id: "assay.gate".into(),
                generator_version: "1.0".into(),
                seed: None,
                params: serde_json::json!({ "cutoffs": cutoffs }),
                input_slots: Vec::new(),
                auto_bound_slots: Vec::new(),
                narration: Some(spec.clone()),
                env_rootfs_sha256: None,
            }])
        };

        // (a) three different spellings of the SAME structural slot each keep their
        //     own name — the two-alias probe collapsed the first two into "sample"
        //     and had no idea what to do with the third.
        for (key, value, want) in [
            ("sample", "S1", "(sample S1)"),
            ("ident", "S1", "(ident S1)"),
            ("well", "A1", "(well A1)"),
        ] {
            let text = narrate(serde_json::json!([{ "metric": "signal", "min": 3, key: value }]));
            assert!(text.contains("signal ≥ 3"), "the bound: {text}");
            assert!(text.contains(want), "expected `{want}` in: {text}");
        }

        // (b) a qualifier the old probe did not recognise is NAMED, never dropped —
        //     and several are all narrated, in one parenthetical.
        let many = narrate(serde_json::json!([{
            "metric": "signal", "max": 9, "replicate": 2, "sample": "S1", "note": "  ",
        }]));
        assert!(many.contains("signal ≤ 9"), "{many}");
        assert!(many.contains("replicate 2"), "an UNRECOGNISED qualifier is narrated: {many}");
        assert!(many.contains("sample S1"), "…alongside the recognised one: {many}");
        assert!(!many.contains("note"), "a blank qualifier restricts nothing: {many}");

        // (c) the nested map's inner key is a VALUE with no name in the data, so it is
        //     labelled structurally.
        let nested = narrate(serde_json::json!({ "signal": { "S1": [1, 4] } }));
        assert!(nested.contains("signal between 1 and 4"), "{nested}");
        assert!(nested.contains("(group S1)"), "structural label, not a domain noun: {nested}");

        // (d) the narrator's own output carries no domain vocabulary of its own.
        let all = format!("{many}{nested}");
        assert!(!all.to_lowercase().contains("cell"), "no domain noun from the narrator: {all}");
    }

    // S3: an analysis that declares NO narration keeps the honest generic sentence —
    // the narrator never invents a method it was not told about.
    #[test]
    fn an_undeclared_analysis_keeps_the_generic_sentence() {
        let text = methods_text(&[MethodRun {
            kind: "compute".into(),
            generator_id: "some.other.tool".into(),
            generator_version: "1.0".into(),
            seed: None,
            params: serde_json::json!({ "knob": 1 }),
            input_slots: Vec::new(),
            auto_bound_slots: Vec::new(),
            narration: None,
            env_rootfs_sha256: None,
        }]);
        assert!(text.contains("Step 'compute' was performed using some.other.tool v1.0"), "{text}");
    }

    // TEST-12 [ITEM-8]: the methods prose STATES WHAT WAS FILTERED ON. The hook is
    // keyed on `generator_id` (never on `kind`, which is "compute" for every
    // processor), it names the actual criteria + the committed mask column, it
    // leaves a non-filter compute run on the generic sentence, and it never names
    // `language`/`arch`.
    #[test]
    fn filter_narration_is_keyed_on_generator_id_and_names_the_criteria() {
        let filter = filter_run(serde_json::json!({
            "criteria": [
                { "column": "pct_counts_mito", "control": "range", "max": 10 },
                { "column": "n_genes_by_counts", "control": "range", "min": 500 },
                { "column": "cell_type", "control": "multiselect", "keep": ["T", "B"] },
                { "column": "total_counts", "control": "range", "min": 1000, "max": 20000 }
            ],
            "label": "lowqc",
            "seed": 42,
        }));
        let text = methods_text(&[filter]);

        assert!(text.contains("4 criteria"), "the criterion count is narrated: {text}");
        assert!(text.contains("pct_counts_mito ≤ 10"), "an upper bound reads as ≤: {text}");
        assert!(text.contains("n_genes_by_counts ≥ 500"), "a lower bound reads as ≥: {text}");
        assert!(text.contains("cell_type in [T, B]"), "a categorical keep-set is narrated: {text}");
        assert!(text.contains("total_counts between 1000 and 20000"), "a two-sided bound is a range: {text}");
        // The committed column IS the label, verbatim (cell-filter 0.9.0, a62c3d80), and
        // this harness renders the SHIPPED manifest — so the narration names the label.
        assert!(text.contains("labelled `lowqc`"), "the committed mask column is named: {text}");
        assert!(
            !text.contains("keep_lowqc"),
            "…and never as a `keep_`-prefixed column, which no run commits: {text}"
        );
        assert!(text.contains("random seed 42"), "the seed is still narrated");
        assert!(!text.contains("language") && !text.contains("x86_64"), "no runtime metadata in prose");
        assert!(!text.contains("Step 'compute' was performed"), "not the generic fallback");

        // A DIFFERENT processor with the SAME kind keeps the generic sentence — the
        // proof that the hook keys on generator_id, not on kind.
        let qc = MethodRun {
            kind: "compute".into(),
            generator_id: "qc.10x".into(),
            generator_version: "0.1.0".into(),
            seed: None,
            params: serde_json::json!({ "min_genes": 200 }),
            input_slots: Vec::new(),
            auto_bound_slots: Vec::new(),
            // qc declares no `methods` narration → the generic sentence.
            narration: None,
            env_rootfs_sha256: None,
        };
        let qc_text = methods_text(&[qc]);
        assert!(qc_text.contains("Step 'compute' was performed using qc.10x"), "generic: {qc_text}");
        assert!(!qc_text.contains("Cells were filtered"), "a non-filter compute run is not narrated as a filter");
    }

    // TEST-12 (cont.): a filter run whose criteria were NOT recorded says so —
    // it never narrates a filter it cannot describe, and an unbounded criterion is
    // dropped rather than presented as an all-pass predicate.
    #[test]
    fn filter_narration_is_honest_about_missing_criteria() {
        let bare = methods_text(&[filter_run(serde_json::json!({ "seed": 42 }))]);
        assert!(bare.contains("no criteria were recorded"), "honest gap: {bare}");

        // A criterion that imposes no constraint is not narrated as a filter — and the
        // sentence now distinguishes it from a run that recorded NOTHING. Saying "no
        // criteria were recorded" here was itself false (the same bundle's manifest.json
        // shows them), which the new undeclared-param disclosure surfaced by naming
        // `criteria` two sentences later. Both halves are asserted.
        let unbounded = methods_text(&[filter_run(serde_json::json!({
            "criteria": [{ "column": "leiden", "control": "multiselect" }, { "column": "" }],
            "label": "x",
        }))]);
        assert!(
            unbounded.contains("render no constraint here"),
            "a criterion with no bound (and one with no column) is not narrated as a filter: {unbounded}"
        );
        assert!(
            !unbounded.contains("the predicate it applied is not documented here"),
            "…and it must not assert a predicate WAS applied: the narrator mirrors the \
             keep-mask, so rendering nothing usually means nothing was applied: {unbounded}"
        );
        assert!(
            !unbounded.contains("no criteria were recorded"),
            "a recorded-but-unnarratable criterion is not 'no criteria were recorded': {unbounded}"
        );
        assert!(
            unbounded.contains("are not in a form this document can state")
                && unbounded.contains("`criteria`"),
            "…and the recorded param is disclosed by name, never dropped: {unbounded}"
        );
    }
    // TEST-41: the narration follows the SAME categorical-first rule and the SAME
    // bound coercion as the keep-mask, so an exported methods section can never
    // describe a filter that did not run.
    #[test]
    fn narration_matches_the_filter_that_actually_ran() {
        let run = |params: serde_json::Value| {
            methods_text(&[MethodRun {
                kind: "compute".into(),
                generator_id: "cell.filter".into(),
                generator_version: "1.0".into(),
                seed: None,
                params,
                input_slots: Vec::new(),
                auto_bound_slots: Vec::new(),
                narration: Some(shipped_cell_filter_narration()),
                env_rootfs_sha256: None,
            }])
        };

        // (a) categorical FIRST: stale min/max on a keep-set criterion are dropped by
        // the mask AND by the predicate builder, so they must not be narrated.
        let cat = run(serde_json::json!({
            "criteria": [{"column": "leiden", "keep": ["1", "2"], "min": 0, "max": 5}]
        }));
        assert!(cat.contains("leiden in [1, 2]"), "narrates the keep-set: {cat}");
        assert!(!cat.contains("between"), "never the dropped bounds: {cat}");

        // (b) an UNTOUCHED control (`min: ""`) constrains nothing — it used to render
        // as an empty-bounded `n_genes >= `. The run DID record a criteria param, so the
        // sentence says the recorded criteria state no constraint, never that none were
        // recorded (which the same bundle's manifest.json would contradict).
        let empty = run(serde_json::json!({ "criteria": [{"column": "n_genes", "min": ""}] }));
        assert!(
            empty.contains("render no constraint here"),
            "an unbounded criterion is not narrated as a filter: {empty}"
        );
        assert!(empty.contains("`criteria`"), "…and is disclosed by name: {empty}");

        // (c) a spelling the mask rejects (`float("0x10")` raises) is likewise no
        // constraint here.
        let hex = run(serde_json::json!({ "criteria": [{"column": "n_genes", "min": "0x10"}] }));
        assert!(hex.contains("render no constraint here"), "{hex}");

        // (d) a real bound still narrates, without a spurious `.0` tail.
        let real = run(serde_json::json!({ "criteria": [{"column": "pct_mito", "max": "10"}] }));
        assert!(real.contains("pct_mito \u{2264} 10"), "{real}");
    }

    // F2-15 (LEDGER reproducibility-1/-2/-3): the narration must describe the
    // WHOLE committed mask, not `params.criteria` alone.
    //
    // `cell-filter.py::main` builds it as
    //     keep = thresholds AND criteria AND <cell-set slot> AND gate
    //     then, if `max_cells` is set, a SEEDED RANDOM subsample.
    // Every one of those terms is a contributor the exported methods.md must state;
    // a term this narrator cannot render faithfully must be DISCLOSED BY NAME, never
    // dropped. (Executed against the real kernel, `{criteria:[n_genes>=500],
    // max_cells:3}` over an 8-cell fixture commits 3 cells while the old prose
    // claimed the 6 the criteria alone keep.)
    #[test]
    fn narration_states_every_mask_contributor_and_never_drops_a_term() {
        let crit = serde_json::json!([{ "column": "n_genes", "control": "range", "min": 500 }]);

        // (a) `max_cells` — the seeded RANDOM down-sample. It is the single most
        //     reproducibility-critical fact about a filter and used to be invisible.
        let sub = methods_text(&[filter_run(serde_json::json!({
            "criteria": crit, "max_cells": 3, "seed": 42,
        }))]);
        assert!(sub.contains("n_genes ≥ 500"), "the criterion still narrates: {sub}");
        assert!(sub.contains("at most 3 cells"), "the down-sample cap is stated: {sub}");
        assert!(sub.contains("SEEDED RANDOM"), "the sample is stated to be RANDOM: {sub}");
        assert!(sub.contains("seed 42"), "the seed that determines WHICH cells: {sub}");

        // (b) a `gate` allow-list intersects into the mask.
        let gated = methods_text(&[filter_run(serde_json::json!({
            "criteria": crit, "gate": ["c1", "c2", "c3"],
        }))]);
        assert!(gated.contains("intersected with"), "the gate is an intersection: {gated}");
        assert!(gated.contains("allow-list of 3 cells"), "its size is stated: {gated}");
        // The kernel reads a LIST-valued `cells` param as the same gate.
        let gated_cells = methods_text(&[filter_run(serde_json::json!({
            "criteria": crit, "cells": ["c1", "c2"],
        }))]);
        assert!(gated_cells.contains("allow-list of 2 cells"), "`cells` is a gate too: {gated_cells}");

        // (c) the `cells`/`cell-set` INPUT SLOT — recorded ONLY as a used edge, so a
        //     params-only reading cannot see it at all.
        let slotted = methods_text(&[filter_run_with_slots(
            serde_json::json!({ "criteria": crit }),
            vec!["expression".into(), "cell-set".into()],
        )]);
        assert!(slotted.contains("`cell-set` input slot"), "the slot allow-list is named: {slotted}");
        assert!(slotted.contains("intersected with"), "and stated as an intersection: {slotted}");

        // (d) `thresholds` — cell-filter's ORIGINAL predicate vocabulary. It used to
        //     be narrated as "no criteria were recorded", a FALSE claim of
        //     absent provenance that the same bundle's manifest.json contradicts.
        let thr = methods_text(&[filter_run(serde_json::json!({
            "thresholds": [{ "metric": "n_genes", "min": 500 }, { "metric": "pct_mito", "max": 10 }],
        }))]);
        assert!(!thr.contains("no criteria were recorded"), "not a false gap claim: {thr}");
        assert!(thr.contains("n_genes ≥ 500") && thr.contains("pct_mito ≤ 10"), "narrated: {thr}");
        // The nested MAP shape resolves too. Its inner key is a VALUE the data never
        // names, so it is labelled with the structural word `group` — NOT the word
        // `sample`, which was one domain's noun hardcoded into the deliverable.
        let per_group = methods_text(&[filter_run(serde_json::json!({
            "thresholds": { "n_genes": { "s1": [500, 5000] } },
        }))]);
        assert!(per_group.contains("n_genes between 500 and 5000"), "{per_group}");
        assert!(per_group.contains("(group s1)"), "the per-group restriction: {per_group}");

        // (e) a `predicate` DSL cannot be rendered faithfully → disclosed by name.
        let pred = methods_text(&[filter_run(serde_json::json!({
            "predicate": { "gt": [{ "col": "n_genes" }, 500] },
        }))]);
        assert!(!pred.contains("no criteria were recorded"), "not a false gap claim: {pred}");
        assert!(pred.contains("`predicate` expression"), "disclosed by name: {pred}");

        // (f) THE CATCH-ALL: a param this narrator does not model is disclosed, never
        //     silently dropped — so a processor param added tomorrow degrades to a
        //     named gap rather than to an understated filter.
        let unknown = methods_text(&[filter_run(serde_json::json!({
            "criteria": crit, "mito_regex": "^MT-", "some_future_knob": 1,
        }))]);
        assert!(unknown.contains("NOT narrated here"), "unmodelled params are disclosed: {unknown}");
        assert!(unknown.contains("`mito_regex`") && unknown.contains("`some_future_knob`"), "{unknown}");

        // (g) all of them at once, and the seed/mask-column narration is unharmed.
        let all = methods_text(&[filter_run_with_slots(
            serde_json::json!({
                "thresholds": [{ "metric": "total_counts", "min": 1000 }],
                "criteria": crit,
                "gate": [0, 1, 2],
                "max_cells": 2,
                "label": "lowqc",
                "seed": 42,
            }),
            vec!["cells".into()],
        )]);
        for needle in [
            "total_counts ≥ 1000",
            "n_genes ≥ 500",
            "`cells` input slot",
            "allow-list of 3 cells",
            "at most 2 cells",
            // The committed column IS the label, verbatim (cell-filter 0.9.0, a62c3d80).
            "labelled `lowqc`",
        ] {
            assert!(all.contains(needle), "missing `{needle}` in: {all}");
        }
        assert!(
            !all.contains("keep_lowqc"),
            "never a `keep_`-prefixed column, which no run commits: {all}"
        );
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // #131 / #77 — the repair's acceptance tests.
    // ─────────────────────────────────────────────────────────────────────────────

    /// Every `methods:` narration DECLARED by a SHIPPED package, with the package and
    /// analysis it came from. Read off disk, never retyped: the whole point of #131's
    /// acceptance clause is that the assertion runs over the shipped manifests rather
    /// than over a copy that cannot go stale with them.
    fn shipped_narrations() -> Vec<(String, String, MethodsNarration)> {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../packages");
        let mut entries: Vec<_> = std::fs::read_dir(&dir)
            .unwrap_or_else(|e| panic!("read {}: {e}", dir.display()))
            .filter_map(Result::ok)
            .map(|e| e.path())
            .collect();
        entries.sort();
        let mut out = Vec::new();
        for path in entries {
            let manifest_path = path.join("manifest.yaml");
            if !manifest_path.exists() {
                continue;
            }
            let pkg = path.file_name().unwrap().to_string_lossy().to_string();
            let text = std::fs::read_to_string(&manifest_path).unwrap();
            let manifest: crate::modules::extensions::types::ExtensionManifest =
                serde_norway::from_str(&text)
                    .unwrap_or_else(|e| panic!("the shipped `{pkg}` manifest parses: {e}"));
            for a in manifest.contributes.analyses {
                if let Some(methods) = a.methods {
                    out.push((pkg.clone(), a.id, methods));
                }
            }
        }
        assert!(
            out.len() >= 6,
            "the shipped tree declares at least the six known narrations; found {}",
            out.len()
        );
        out
    }

    /// A plausible RECORDED value for a declared param, by role — enough for the
    /// narrator to render every branch.
    fn sample_value(role: MethodsParamRole) -> Value {
        use MethodsParamRole as Role;
        match role {
            Role::PredicateList => serde_json::json!([{ "column": "c", "min": 1 }]),
            Role::ThresholdList => serde_json::json!([{ "metric": "m", "min": 1 }]),
            Role::OpaquePredicate => serde_json::json!({ "gt": [{ "col": "c" }, 1] }),
            Role::AllowList => serde_json::json!(["a", "b"]),
            Role::SubsampleCap => serde_json::json!(5),
            Role::Seed => serde_json::json!(7),
            Role::OutputLabel => serde_json::json!("mylabel"),
            Role::NarratedValue => serde_json::json!("42"),
        }
    }

    fn run_with(spec: MethodsNarration, params: Value) -> MethodRun {
        MethodRun {
            kind: "compute".into(),
            generator_id: "some.analysis".into(),
            generator_version: "1.0".into(),
            seed: None,
            params,
            input_slots: Vec::new(),
            auto_bound_slots: Vec::new(),
            narration: Some(spec),
            env_rootfs_sha256: None,
        }
    }

    // TEST-1 [acceptance] [invariant: INV-1] — NO unsubstituted `{…}` token can reach a
    // generated methods.md, asserted over the SHIPPED manifests rather than by
    // inspection (#131's own acceptance clause).
    //
    // THE FINDING, reproduced before the fix against these very files: `clustering`
    // printed "labelled `{name}`", `embedding.reduce` printed "a {n_pcs}-component PCA
    // embedding over {n_hvg} highly-variable genes", `embedding.visualize` printed
    // "a 2-D {method} embedding", and `geneset` + both `differential-expression`
    // analyses printed "`{name}`" — braces and all, into the out-of-app trust
    // deliverable, invisible until a human opened an exported bundle.
    //
    // RED ON REVERT: restore `c.replace("{label}", …)` as the only substitution and five
    // of the six shipped declarations render braces here.
    #[test]
    fn no_shipped_manifest_can_leak_a_placeholder_into_the_deliverable() {
        for (pkg, analysis, spec) in shipped_narrations() {
            // (a) every declared param RECORDED — the fully-resolvable case.
            let recorded: serde_json::Map<String, Value> = spec
                .params
                .iter()
                .map(|(k, r)| (k.clone(), sample_value(*r)))
                .collect();
            // (b) NOTHING recorded — the fallback case, which is where the old code
            //     substituted an empty string or nothing at all.
            // (c) only the NON-label params recorded — the case that forces
            //     `commits_unlabeled` while other tokens are resolvable.
            let mut no_label = recorded.clone();
            for (k, r) in &spec.params {
                if matches!(r, MethodsParamRole::OutputLabel) {
                    no_label.remove(k);
                }
            }
            // THE VALUE SPACE, not just the param space. The three cases above vary WHICH
            // params are recorded; a param VALUE is user text (an output name typed in the
            // app, or supplied through the agent path) and is the one input class that can
            // carry a brace into the deliverable by a route no manifest lint can see. An
            // acceptance test for "no unsubstituted token can reach methods.md" that never
            // varies the values cannot see that class at all.
            // ONE HOSTILE CLASS PER CASE. A single value carrying all of them is worse
            // than useless: the brace rule rejects it first, so the backtick and the
            // newline are never exercised and the assertions about them pass without
            // reaching the code they name. Each class gets its own run.
            let hostile = |v: Value| -> Value {
                let mut m = serde_json::Map::new();
                for (k, r) in &spec.params {
                    let value = match r {
                        MethodsParamRole::OutputLabel | MethodsParamRole::NarratedValue => {
                            v.clone()
                        }
                        other => sample_value(*other),
                    };
                    m.insert(k.clone(), value);
                }
                Value::Object(m)
            };
            for (case, params) in [
                ("all params recorded", Value::Object(recorded)),
                ("no params recorded", serde_json::json!({})),
                ("no label recorded", Value::Object(no_label)),
                // INV-1, by the one route no manifest lint can see: a user-typed value.
                ("a brace in the value", hostile(serde_json::json!("a{b}c"))),
                // Closes the markdown code span early and lets the rest render as markup.
                ("a backtick in the value", hostile(serde_json::json!("has`tick"))),
                // Breaks the numbered list item across lines.
                ("a newline in the value", hostile(serde_json::json!("two\nlines"))),
                // A paragraph is not a data dump.
                ("an absurdly long value", hostile(serde_json::json!("x".repeat(400)))),
            ] {
                let text = methods_text(&[run_with(spec.clone(), params)]);
                assert!(
                    !text.contains('{') && !text.contains('}'),
                    "{pkg}/{analysis} ({case}) leaked a placeholder into methods.md:\n{text}"
                );
                // The document is a numbered markdown list; a value that broke out of its
                // sentence would corrupt the reader's view of every step below it. Each
                // numbered item must stay ONE line with balanced code spans, and no line
                // may run away with 400 characters of somebody's parameter.
                for (n, line) in text.lines().enumerate() {
                    assert!(
                        line.matches('`').count() % 2 == 0,
                        "{pkg}/{analysis} ({case}) left an unbalanced code span on line \
                         {n}:\n{text}"
                    );
                }
                assert_eq!(
                    text.lines().filter(|l| l.starts_with("1. ")).count(),
                    1,
                    "{pkg}/{analysis} ({case}) split the step across lines:\n{text}"
                );
                assert!(
                    !text.contains(&"x".repeat(200)),
                    "{pkg}/{analysis} ({case}) inlined an unbounded value:\n{text}"
                );
            }
        }
    }

    // TEST-1 (cont.) — the shipped manifests actually SAY something: the placeholders
    // resolve to the recorded values rather than being deleted. A repair that simply
    // stripped the braces would pass the assertion above while UNDER-REPORTING the
    // method, which is the failure mode this module exists to prevent.
    #[test]
    fn the_shipped_placeholders_resolve_to_the_recorded_values() {
        let by_id = |id: &str| {
            shipped_narrations()
                .into_iter()
                .find(|(_, a, _)| a == id)
                .unwrap_or_else(|| panic!("the shipped tree declares `{id}`"))
                .2
        };

        // `{name}` — four analyses spell their output label this way; `name` is declared
        // `output_label`, so the value was always resolved. It just had nowhere to land.
        for (id, needle) in [
            ("clustering.cluster", "labelled `leiden_r1`"),
            ("de.compare", "gene table, `contrast_a`"),
            ("de.markers", "marker gene table, `contrast_a`"),
            ("geneset.collection.freeze", "collection, `contrast_a`"),
        ] {
            let label = if id == "clustering.cluster" { "leiden_r1" } else { "contrast_a" };
            let text = methods_text(&[run_with(
                by_id(id),
                serde_json::json!({ "name": label }),
            )]);
            assert!(text.contains(needle), "{id}: expected `{needle}` in:\n{text}");
        }

        // `{n_pcs}` / `{n_hvg}` / `{method}` — NOT labels, and under the "just fix the
        // manifests to `{label}`" option they would have been deleted from the sentence
        // outright. They are the reason the substitution was widened instead.
        // Both are stated as UPPER BOUNDS, because both are the REQUESTED counts and the
        // compute clamps them; a flat assertion would be a citable number the run can
        // contradict.
        let reduce = methods_text(&[run_with(
            by_id("embedding.reduce"),
            serde_json::json!({ "name": "pca", "n_pcs": 50, "n_hvg": 2000 }),
        )]);
        assert!(
            reduce.contains(
                "a PCA embedding of at most 50 components over at most 2000 \
                 highly-variable genes"
            ),
            "{reduce}"
        );
        let visualize = methods_text(&[run_with(
            by_id("embedding.visualize"),
            serde_json::json!({ "name": "umap", "method": "UMAP" }),
        )]);
        assert!(visualize.contains("a 2-D UMAP embedding"), "{visualize}");
    }

    // TEST-3 [acceptance] [invariant: INV-2] — an analysis declaring `note:` gets it
    // narrated REGARDLESS of whether it declares a constraint-producing param role,
    // asserted against a REAL SHIPPED MANIFEST (#131's acceptance wording).
    //
    // THE FINDING: `note` was appended only inside the constraints branch, so the
    // carefully written caveats in `clustering`, both `embedding` analyses and both
    // `differential-expression` analyses were absent from EVERY exported methods.md —
    // the double-dipping disclosure, the pseudobulk unit-of-replication disclosure and
    // the not-batch-corrected disclosure. The honest parts were the parts being dropped.
    //
    // RED ON REVERT: move `note` back inside the `else` arm and every assertion here
    // fails, because none of these analyses can produce a constraint at all.
    #[test]
    fn a_declared_note_is_narrated_even_with_no_constraint_producing_role() {
        let mut checked = 0;
        for (pkg, analysis, spec) in shipped_narrations() {
            let Some(note) = spec.note.clone() else { continue };
            if declares_a_predicate(&spec) {
                continue; // covered by the pre-existing cell-filter tests
            }
            // This analysis CANNOT produce a constraint, so before the repair it always
            // took the branch that dropped the note.
            let text = methods_text(&[run_with(spec, serde_json::json!({}))]);
            let note = note.trim();
            assert!(
                text.contains(note),
                "{pkg}/{analysis} dropped its scientific caveat from methods.md.\n\
                 expected: {note}\ngot:\n{text}"
            );
            checked += 1;
        }
        assert!(
            checked >= 3,
            "at least clustering + embedding.reduce + both DE analyses declare a note \
             with no constraint role; only {checked} were exercised — the fixture has \
             drifted away from the defect"
        );
    }

    // TEST-4 [acceptance] [invariant: INV-3] — the "no criteria were recorded" sentence
    // is emitted ONLY when the analysis actually applies an unrecorded predicate, never
    // for one that applies none.
    //
    // THE FINDING: for `embedding.reduce`, `embedding.visualize`,
    // `clustering.cluster` — and every trajectory analysis — there IS no predicate. The
    // sentence told a reader the analysis had hidden something it never had, in the one
    // document meant to travel outside the app and be trusted.
    //
    // RED ON REVERT: drop the `declares_a_predicate` gate and every shipped
    // no-predicate analysis accuses itself again.
    #[test]
    fn the_no_criteria_accusation_is_only_made_when_a_predicate_was_actually_applied() {
        const ACCUSATION: &str = "no criteria were recorded";
        let mut without = 0;
        let mut with = 0;
        for (pkg, analysis, spec) in shipped_narrations() {
            let applies_a_predicate = declares_a_predicate(&spec);
            let text = methods_text(&[run_with(spec, serde_json::json!({}))]);
            if applies_a_predicate {
                // An analysis that DOES apply a predicate, whose run recorded none, is a
                // real gap and must still say so — the honest half of the distinction.
                assert!(
                    text.contains(ACCUSATION),
                    "{pkg}/{analysis} applies a predicate but recorded none, and said \
                     nothing about it:\n{text}"
                );
                with += 1;
            } else {
                assert!(
                    !text.contains(ACCUSATION),
                    "{pkg}/{analysis} applies NO predicate, yet methods.md accuses the \
                     run of hiding one:\n{text}"
                );
                without += 1;
            }
        }
        assert!(with >= 1 && without >= 4, "both halves must be exercised: {with}/{without}");

        // EXPLICIT per-role expectations. Without these the loop above is an identity
        // check: it computes its expectation with the SAME production classifier it is
        // testing, so it goes red only if the gate is removed wholesale — a role dropped
        // from the classifier (say `allow_list`) would stay green on both sides. These are
        // written down, not derived.
        for (role, applies_a_predicate) in [
            ("predicate_list", true),
            ("threshold_list", true),
            ("opaque_predicate", true),
            ("allow_list", true),
            ("subsample_cap", false),
            ("seed", false),
            ("output_label", false),
            ("narrated_value", false),
        ] {
            let narration: MethodsNarration = serde_json::from_value(serde_json::json!({
                "subject": { "singular": "row", "plural": "rows" },
                "action": "scored",
                "params": { "x": role }
            }))
            .unwrap_or_else(|e| panic!("role `{role}` parses: {e}"));
            let text = methods_text(&[run_with(narration, serde_json::json!({}))]);
            assert_eq!(
                text.contains(ACCUSATION),
                applies_a_predicate,
                "role `{role}` must{} produce the gap sentence:\n{text}",
                if applies_a_predicate { "" } else { " NOT" }
            );
        }
        // A declared allow-list SLOT is a predicate too, and it is the one that lives
        // outside `params` entirely.
        let slotted: MethodsNarration = serde_json::from_value(serde_json::json!({
            "subject": { "singular": "row", "plural": "rows" },
            "action": "scored",
            "allow_list_slots": ["picked"]
        }))
        .unwrap();
        assert!(
            methods_text(&[run_with(slotted, serde_json::json!({}))]).contains(ACCUSATION),
            "a declared allow-list slot IS an applied predicate"
        );
    }

    // TEST-5 [acceptance] [invariant: INV-4] — the never-drop guarantee survives the two
    // NEW narration mechanisms. A param earns its exemption from the undeclared-param
    // disclosure by being NARRATED, never merely by being declared.
    #[test]
    fn a_declared_but_unrendered_param_falls_back_into_the_disclosure() {
        let spec: MethodsNarration = serde_json::from_value(serde_json::json!({
            "subject": { "singular": "row", "plural": "rows" },
            "action": "scored",
            "commits": "a {depth}-deep score column named `{label}`",
            "params": { "label": "output_label", "depth": "narrated_value" },
            "reference_assets": [
                { "kind": "reference database", "name": "db", "version": "db_version",
                  "digest": "db_sha256" }
            ]
        }))
        .expect("the declaration parses");

        // (a) EVERYTHING resolves → the values are narrated, so none of them is listed
        //     as un-narrated.
        let full = methods_text(&[run_with(
            spec.clone(),
            serde_json::json!({
                "label": "score", "depth": 3,
                "db": "ligrec", "db_version": "2024.1", "db_sha256": "deadbeef",
            }),
        )]);
        assert!(full.contains("a 3-deep score column named `score`"), "{full}");
        assert!(full.contains("the reference database `ligrec`, version `2024.1`"), "{full}");
        assert!(!full.contains("NOT narrated here"), "nothing left to disclose: {full}");
        assert!(
            !full.contains("stated here"),
            "…by either disclosure sentence: {full}"
        );

        // (b) the commit phrase CANNOT render (no `depth` recorded) and there is no
        //     unlabeled fallback → the clause is omitted, and `depth`… wait: `depth` was
        //     not recorded at all, so there is nothing to disclose about it. The real
        //     hazard is the NEXT case.
        let no_depth = methods_text(&[run_with(
            spec.clone(),
            serde_json::json!({ "label": "score" }),
        )]);
        assert!(!no_depth.contains('{'), "no half-substituted phrase: {no_depth}");

        // (c) THE HAZARD: `depth` IS recorded, but the phrase still cannot render
        //     because `{label}` is missing. `depth` is therefore NOT narrated anywhere —
        //     and being declared must not buy it silence.
        let no_label = methods_text(&[run_with(
            spec.clone(),
            serde_json::json!({ "depth": 3 }),
        )]);
        assert!(!no_label.contains('{'), "no half-substituted phrase: {no_label}");
        assert!(
            no_label.contains("`depth` = `3`"),
            "a declared-but-unrendered `narrated_value` must fall back into the \
             disclosure, never vanish: {no_label}"
        );
        // …and it is NOT described as something that "may further constrain the result".
        // A `narrated_value` explicitly does not constrain; saying it might would be a new
        // false statement about the run.
        assert!(
            !no_label.contains("may further constrain"),
            "a declared non-constraining param must not be hedged as a constraint: \
             {no_label}"
        );

        // (d) the same hazard for a reference asset: its VERSION was not recorded, so
        //     the asset is not narrated — and its identity param must be disclosed
        //     rather than silently dropped. Naming a model without its version is the
        //     untraceability the block exists to close, so a half-asset is not narrated.
        let half_asset = methods_text(&[run_with(
            spec,
            serde_json::json!({ "label": "score", "depth": 3, "db": "ligrec" }),
        )]);
        assert!(
            !half_asset.contains("reference database `ligrec`"),
            "an asset with no recorded version must NOT be narrated: {half_asset}"
        );
        assert!(
            half_asset.contains("`db` = `ligrec`"),
            "…and its params must be disclosed by name, in the DECLARED sentence (an asset \
             facet is modelled by the narration, so the unmodelled-param hedge would be \
             wrong about it): {half_asset}"
        );
    }

    // TEST-5 (cont.) — the ORIGINAL never-drop rule is untouched: a param with no
    // declared role at all is still disclosed by name.
    #[test]
    fn an_undeclared_param_is_still_disclosed_by_name() {
        let spec: MethodsNarration = serde_json::from_value(serde_json::json!({
            "subject": { "singular": "row", "plural": "rows" },
            "action": "scored",
            "params": { "seed": "seed" }
        }))
        .unwrap();
        let text = methods_text(&[run_with(
            spec,
            serde_json::json!({ "seed": 1, "future_knob": true }),
        )]);
        assert!(text.contains("NOT narrated here") && text.contains("`future_knob`"), "{text}");
        assert!(!text.contains("`seed`"), "a declared role is not disclosed as a gap: {text}");
    }

    // TEST-6 [acceptance] [invariant: INV-5] — a declared versioned external resource is
    // NAMED, WITH ITS VERSION, in prose AND in the Key Resources Table (#77).
    //
    // THE FINDING: `MethodRun` had no field for it, the param-role vocabulary had no
    // slot for a version, and the "Key Resources Table" was a table of PACKAGES built
    // from `format!("{} v{}", generator_id, generator_version)`. An analysis that ran a
    // pretrained model could narrate THAT it ran but not WHICH model — so the most
    // consequential input to the result was scientifically untraceable in the one
    // artefact meant to travel outside the app.
    //
    // RED ON REVERT: delete the `reference_assets` rendering and the model's identity
    // falls back to the undeclared-param footnote — honest, but a gap statement rather
    // than a narration.
    #[test]
    fn a_declared_reference_asset_is_named_with_its_version_in_prose_and_the_table() {
        let spec: MethodsNarration = serde_json::from_value(serde_json::json!({
            "subject": { "singular": "row", "plural": "rows" },
            "action": "labelled",
            "params": {},
            "reference_assets": [
                { "kind": "pretrained model", "name": "model", "version": "model_version",
                  "source": "model_source", "digest": "model_sha256" },
                { "kind": "ontology", "name": "onto", "version": "onto_version" }
            ]
        }))
        .expect("the declaration parses");
        let text = methods_text(&[run_with(
            spec,
            serde_json::json!({
                "model": "Immune_All_Low", "model_version": "2.1.0",
                "model_source": "registry://models/immune", "model_sha256": "abc123",
                "onto": "cl", "onto_version": "2024-05-15",
            }),
        )]);

        // PROSE — identity and version, always together, plus the pinning facets.
        assert!(
            text.contains("the pretrained model `Immune_All_Low`, version `2.1.0`"),
            "prose must name the model AND its version: {text}"
        );
        assert!(text.contains("source `registry://models/immune`"), "{text}");
        assert!(text.contains("sha256 `abc123`"), "{text}");
        assert!(text.contains("the ontology `cl`, version `2024-05-15`"), "{text}");
        assert!(text.contains("pinned reference resources were used"), "plural verb: {text}");

        // KEY RESOURCES TABLE — a richer row than `<id> v<version>`, carrying
        // (name, version, source, digest). "Key Resources" in a real Methods section
        // means models and reference builds, not only software packages.
        let table = text
            .split("## Key Resources Table")
            .nth(1)
            .and_then(|s| s.split("## Data and Code").next())
            .expect("the table section exists")
            .to_string();
        assert!(
            table.contains(
                "- pretrained model: Immune_All_Low v2.1.0 \
                 (source: registry://models/immune; sha256 abc123)"
            ),
            "the asset row: {table}"
        );
        assert!(table.contains("- ontology: cl v2024-05-15"), "{table}");
        assert!(
            table.contains("- some.analysis v1.0"),
            "…and the pre-existing package row is unchanged: {table}"
        );

        // The declaring params are narrated, so they are not ALSO listed as gaps.
        assert!(!text.contains("NOT narrated here"), "{text}");

        // SINGULAR — the verb agrees, because a sentence that is wrong in the singular
        // is wrong for the commonest case.
        let one: MethodsNarration = serde_json::from_value(serde_json::json!({
            "subject": { "singular": "row", "plural": "rows" },
            "action": "labelled",
            "reference_assets": [
                { "kind": "pretrained model", "name": "model", "version": "model_version" }
            ]
        }))
        .unwrap();
        let single = methods_text(&[run_with(
            one,
            serde_json::json!({ "model": "m", "model_version": "1" }),
        )]);
        assert!(single.contains("pinned reference resource was used"), "{single}");
    }

    // TEST-7's runtime half — INV-6: the vocabulary stays CLOSED. An unknown role, and
    // an unknown key inside a reference-asset entry, are both REFUSED at parse; a
    // half-declared asset (no `version`) is refused too, because an asset narrated
    // without its version is exactly the untraceability the block exists to close.
    #[test]
    fn the_declaration_vocabulary_stays_closed() {
        let base = |extra: &str| {
            format!(
                "subject: {{ singular: row, plural: rows }}\naction: scored\n{extra}"
            )
        };
        for (why, yaml) in [
            ("an unknown param role", base("params:\n  x: resource_version\n")),
            (
                "an unknown reference-asset key",
                base("reference_assets:\n  - {{ kind: k, name: n, version: v, versoin: w }}\n"),
            ),
            (
                "a reference asset with no version",
                base("reference_assets:\n  - {{ kind: k, name: n }}\n"),
            ),
            ("an unknown narration key", base("nite: hello\n")),
        ] {
            let yaml = yaml.replace("{{", "{").replace("}}", "}");
            assert!(
                serde_norway::from_str::<MethodsNarration>(&yaml).is_err(),
                "{why} must be REFUSED, not silently ignored:\n{yaml}"
            );
        }
        // …and the seven pre-existing roles plus the new one all still parse.
        for role in [
            "predicate_list", "threshold_list", "opaque_predicate", "allow_list",
            "subsample_cap", "seed", "output_label", "narrated_value",
        ] {
            let yaml = base(&format!("params:\n  x: {role}\n"));
            serde_norway::from_str::<MethodsNarration>(&yaml)
                .unwrap_or_else(|e| panic!("role `{role}` must parse: {e}"));
        }
    }

    // TEST-8 [acceptance] [invariant: INV-7] — an analysis that declares nothing is
    // UNCHANGED, and a minimal declaration narrates with no note, no accusation, no
    // asset row and no braces. This is the backward-compatibility floor the three
    // concurrently-built packages sit on.
    #[test]
    fn an_analysis_that_declares_nothing_is_unchanged() {
        // No narration at all → the byte-for-byte pre-change generic sentence.
        let generic = methods_text(&[MethodRun {
            kind: "compute".into(),
            generator_id: "some.other.tool".into(),
            generator_version: "1.0".into(),
            seed: Some(3),
            params: serde_json::json!({ "knob": 1 }),
            input_slots: Vec::new(),
            auto_bound_slots: Vec::new(),
            narration: None,
            env_rootfs_sha256: None,
        }]);
        assert!(
            generic.contains(
                "1. Step 'compute' was performed using some.other.tool v1.0 (random seed 3).\n"
            ),
            "{generic}"
        );

        // The MINIMAL declaration — only the two required fields.
        let minimal: MethodsNarration = serde_json::from_value(serde_json::json!({
            "subject": { "singular": "row", "plural": "rows" },
            "action": "scored"
        }))
        .unwrap();
        let text = methods_text(&[run_with(minimal, serde_json::json!({}))]);
        assert!(text.contains("1. Rows were scored using some.analysis v1.0.\n"), "{text}");
        assert!(!text.contains("no criteria"), "no accusation: {text}");
        assert!(!text.contains("NOT narrated here"), "nothing recorded to disclose: {text}");
        assert!(!text.contains("pinned reference"), "no assets declared: {text}");
        assert!(!text.contains('{'), "{text}");
    }

    // TEST-10 [ITEM-11 / #77] — the environment digest is PRINTED, not merely asserted
    // to be shipped.
    //
    // THE FINDING: `env_rootfs_sha256` was captured, threaded into `run.sh` and
    // `readiness.json`, and then dropped — while the Data-and-Code-Availability
    // paragraph told the reader environment digests "are shipped in this reproducibility
    // bundle" without printing one. It is the single field that pins every baked asset
    // at once, so a reader holding only methods.md had no handle on it at all.
    #[test]
    fn the_environment_digest_is_printed_and_a_missing_one_is_reported() {
        let run = |digest: Option<&str>| MethodRun {
            kind: "compute".into(),
            generator_id: "t".into(),
            generator_version: "1".into(),
            seed: None,
            params: serde_json::json!({}),
            input_slots: Vec::new(),
            auto_bound_slots: Vec::new(),
            narration: None,
            env_rootfs_sha256: digest.map(str::to_string),
        };

        let one = methods_text(&[run(Some("sha-a"))]);
        assert!(one.contains("The environment digest the steps of this analysis recorded"), "{one}");
        assert!(one.contains("`sha-a`"), "{one}");
        assert!(!one.contains("recorded NO environment digest"), "{one}");

        // Two runs sharing a digest name it ONCE — a digest repeated per step reads as
        // several environments to a reviewer.
        let shared = methods_text(&[run(Some("sha-a")), run(Some("sha-a"))]);
        assert_eq!(shared.matches("sha-a").count(), 1, "{shared}");
        assert!(
            shared.contains("The environment digest the steps of this analysis recorded is `sha-a`"),
            "one environment, singular verb: {shared}"
        );
        // …and the sentence does NOT claim the digest identifies the software itself. A
        // rootfs digest names the IMAGE; the resolved version of each library inside it is
        // knowable only at run time, which is why each step records those separately. The
        // packages' own recorders say so in as many words, and a deliverable that
        // contradicted them would be worse than one that stayed quiet.
        assert!(
            !shared.contains("pinning the software that actually ran"),
            "the digest must not be presented as the software identity: {shared}"
        );
        assert!(
            shared.contains("not the resolved version of each library inside it"),
            "…and the limit is stated, not left for the reader to infer: {shared}"
        );
        // (the standing paragraph above already contains the words "environment
        // digests", so the plural check has to be made on OUR sentence, not the file)
        // (the standing paragraph above already says "environment digests recorded for
        // this analysis are shipped …", so the plural check must be made on OUR sentence)
        assert!(
            !shared.contains("environment digests the steps of this analysis recorded"),
            "one environment must not read as several: {shared}"
        );

        let two = methods_text(&[run(Some("sha-a")), run(Some("sha-b"))]);
        assert!(
            two.contains("The environment digests the steps of this analysis recorded are `"),
            "plural: {two}"
        );
        assert!(two.contains("`sha-a`, `sha-b`"), "in run order: {two}");

        // A GAP is reported as a gap, not passed over in silence.
        let gap = methods_text(&[run(Some("sha-a")), run(None)]);
        assert!(gap.contains("1 executed step(s) recorded NO environment digest"), "{gap}");

        // A blank digest is a gap, not an empty backticked span.
        let blank = methods_text(&[run(Some("   "))]);
        assert!(blank.contains("1 executed step(s) recorded NO environment digest"), "{blank}");
        assert!(!blank.contains("``"), "{blank}");

        // …and an export with NO runs at all says nothing extra, so the marker keeps
        // meaning something when it appears. (The standing paragraph's own mention of
        // "environment digests" is not this sentence, hence the specific needles.)
        let none = methods_text(&[]);
        // Both the singular and the plural sentence, and the gap sentence — the empty
        // guard must not match only one of the three.
        assert!(!none.contains("the steps of this analysis recorded"), "{none}");
        assert!(!none.contains("recorded NO environment digest"), "{none}");
    }

    // The BUILD gate and the NARRATOR must agree on what a placeholder IS.
    //
    // They are two implementations (`build.rs` runs before this crate compiles and
    // cannot reach into it). A tokenizer that disagreed with the renderer would let a
    // token pass the gate and then fail to substitute — which is precisely the silent
    // verbatim render the gate exists to prevent, reintroduced through the back door.
    #[test]
    fn the_build_lint_and_the_narrator_agree_on_what_a_placeholder_is() {
        use crate::processor_manifest_lint::methods_placeholder_tokens as lint_tokens;
        for phrase in [
            "no placeholders at all",
            "one `{label}` here",
            "{a} and {b} and {a}",
            "a {n_pcs}-component embedding over {n_hvg} genes",
            "adjacent {a}{b}",
            "empty {} token",
            "unclosed {a",
            "nested {a{b}}",
            "trailing brace}",
            "{}{}",
            // EDGE SPANS: a token that is the WHOLE phrase, one at index 0, one at the
            // very end, and an empty phrase. The one-pass rebuild copies the slices
            // BETWEEN spans, so an off-by-one at either boundary would silently drop or
            // duplicate a character of the deliverable.
            "{a}",
            "{a} tail",
            "head {a}",
            "",
            "}{",
        ] {
            let ours = placeholder_tokens(phrase);
            let theirs = lint_tokens(phrase);
            let theirs_ok: Option<Vec<String>> =
                theirs.iter().cloned().collect::<Result<Vec<_>, _>>().ok();
            assert_eq!(
                ours.as_ref().map(|v| {
                    v.iter().map(|(_, t)| (*t).to_string()).collect::<Vec<_>>()
                }),
                theirs_ok,
                "tokenizers disagree on `{phrase}`"
            );
            // …and OUR spans really do bracket the tokens they claim, so the one-pass
            // rebuild cannot silently drop or duplicate a slice of the phrase.
            if let Some(spans) = ours {
                for (span, token) in spans {
                    assert_eq!(&phrase[span.clone()], format!("{{{token}}}"), "{phrase}");
                }
            }
        }
        // The reserved token is spelled the same on both sides.
        assert_eq!(
            crate::processor_manifest_lint::METHODS_RESERVED_PLACEHOLDER,
            "label"
        );

        // ROUND-1 — the ONE-PASS REBUILD is exact: substituting each token with its own
        // name in braces must reproduce the phrase byte-for-byte. An off-by-one at either
        // span boundary would drop or duplicate a character of the deliverable, and no
        // prose assertion elsewhere would notice a single missing space.
        let spec: MethodsNarration = serde_json::from_value(serde_json::json!({
            "subject": { "singular": "row", "plural": "rows" },
            "action": "scored",
            "params": { "a": "narrated_value", "b": "narrated_value" }
        }))
        .unwrap();
        for phrase in ["{a}", "{a} tail", "head {a}", "x{a}{b}y", "no tokens", "", "{a}{b}"] {
            let run = run_with(spec.clone(), serde_json::json!({ "a": "{a}", "b": "{b}" }));
            // A brace-carrying value is unsubstitutable BY DESIGN, so round-trip with
            // identity-shaped values that carry no brace instead.
            let run = MethodRun {
                params: serde_json::json!({ "a": "A", "b": "B" }),
                ..run
            };
            let (out, _) = substitute_placeholders(&run, &spec, phrase, None)
                .unwrap_or_else(|| panic!("`{phrase}` must resolve"));
            let expect = phrase.replace("{a}", "A").replace("{b}", "B");
            assert_eq!(out, expect, "one-pass rebuild is not exact for `{phrase}`");
        }
    }

    // TEST-18 [ITEM-15] — the COMMITTED generated clients carry the widened contract.
    // A forgotten `just openapi-regen` (either pass) ships a client that cannot express
    // what the backend accepts; the merge-gate's C3 catches it at merge time, this
    // catches it at test time.
    #[test]
    fn the_generated_clients_carry_the_widened_narration_contract() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../ui");
        for rel in [
            "openapi/openapi.json",
            "openapi-saas/openapi.json",
            "src/api-client/types.ts",
            "src/api-client-saas/types.ts",
        ] {
            let path = root.join(rel);
            let text = std::fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
            assert!(
                text.contains("narrated_value"),
                "{rel} does not carry the new role — run `just openapi-regen`"
            );
            assert!(
                text.contains("reference_assets") || text.contains("referenceAssets"),
                "{rel} does not carry the new field — run `just openapi-regen`"
            );
            // …and every pre-existing role SURVIVES: the vocabulary was widened, not
            // rewritten (the backward-compatibility contract the concurrent builds rely on).
            for role in [
                "predicate_list", "threshold_list", "opaque_predicate", "allow_list",
                "subsample_cap", "output_label",
            ] {
                assert!(text.contains(role), "{rel} lost the pre-existing role `{role}`");
            }
        }
    }


    // TEST-19 [ITEM-16] — a SIXTH manifest defect, found by rendering the shipped
    // manifests rather than by reading them: `geneset` declared `action: froze`, and the
    // narrator renders `<Subjects> were <action>`, so every exported methods.md read
    // "Gene sets were froze using geneset.collection.freeze …". The template needs the
    // past PARTICIPLE.
    //
    // RED ON REVERT: set `action: froze` back in `packages/geneset/manifest.yaml`.
    #[test]
    fn the_shipped_geneset_narration_is_grammatical() {
        let spec = shipped_narrations()
            .into_iter()
            .find(|(_, a, _)| a == "geneset.collection.freeze")
            .expect("the shipped tree declares geneset.collection.freeze")
            .2;
        let text = methods_text(&[run_with(spec, serde_json::json!({ "name": "hallmark" }))]);
        assert!(text.contains("Gene sets were frozen"), "{text}");
        assert!(!text.contains("were froze "), "the simple past reads as a typo: {text}");
    }


    // ─────────────────────────────────────────────────────────────────────────────
    // FIX_ROUND-1 — the blind audit's findings, each pinned.
    // ─────────────────────────────────────────────────────────────────────────────

    // TEST-20 [ITEM-8] / ROUND-1 (never-drop, high) — a param earns its exemption from
    // the disclosure by being NARRATED, never by being DECLARED.
    //
    // THE FINDING: exemption was computed from the declared ROLE, but every role's
    // rendering is CONDITIONAL on the recorded value being renderable. So a recorded
    // param could be absent from the narration AND absent from the disclosure — silently
    // dropped from the out-of-app trust deliverable, which is the one thing this module
    // exists to prevent. Both shipped `embedding` analyses were in that state for the
    // user's output name.
    //
    // RED ON REVERT: exempt on `spec.params.contains_key` and every case below loses its
    // param from both surfaces.
    #[test]
    fn every_declared_role_falls_back_into_the_disclosure_when_it_does_not_render() {
        // Each case: a param with a REAL role, recorded, whose rendering cannot fire.
        for (why, params, commits, recorded, needle) in [
            (
                "an output_label the commit phrase never names",
                serde_json::json!({ "name": "output_label" }),
                serde_json::json!("a fixed column"),
                serde_json::json!({ "name": "chosen_by_the_user" }),
                "`name`",
            ),
            (
                "a threshold_list that yields no phrase",
                serde_json::json!({ "cut": "threshold_list" }),
                Value::Null,
                serde_json::json!({ "cut": [{ "metric": "m" }] }),
                "`cut`",
            ),
            (
                "an allow_list that is empty",
                serde_json::json!({ "gate": "allow_list" }),
                Value::Null,
                serde_json::json!({ "gate": [] }),
                "`gate`",
            ),
            (
                "a subsample_cap that is not a count",
                serde_json::json!({ "cap": "subsample_cap" }),
                Value::Null,
                serde_json::json!({ "cap": "lots" }),
                "`cap`",
            ),
            (
                "a seed that is not a number",
                serde_json::json!({ "rng": "seed" }),
                Value::Null,
                serde_json::json!({ "rng": "from the clock" }),
                "`rng`",
            ),
            (
                "a narrated_value whose phrase could not render",
                serde_json::json!({ "depth": "narrated_value", "tag": "output_label" }),
                serde_json::json!("a {depth}-deep column named `{tag}`"),
                serde_json::json!({ "depth": 3 }),
                "`depth`",
            ),
        ] {
            let mut decl = serde_json::json!({
                "subject": { "singular": "row", "plural": "rows" },
                "action": "scored",
                "params": params,
            });
            if !commits.is_null() {
                decl["commits"] = commits;
            }
            let narration: MethodsNarration =
                serde_json::from_value(decl).expect("the declaration parses");
            let text = methods_text(&[run_with(narration, recorded)]);
            assert!(
                (text.contains("so they are stated here")
                    || text.contains("are not in a form this document can state"))
                    && text.contains(needle),
                "{why}: the recorded param vanished from BOTH surfaces:\n{text}"
            );
            // Every param in this loop carries a DECLARED role, so none of them may be
            // hedged as possibly constraining the result — that sentence is for params
            // the narration does not model at all.
            assert!(
                !text.contains("may further constrain"),
                "{why}: a declared param must not be described as a possible \
                 constraint:\n{text}"
            );
        }
    }

    // TEST-21 [ITEM-1/ITEM-2] / ROUND-1 — a seed recorded ONLY in the science params is
    // narrated, not lost.
    #[test]
    fn a_seed_recorded_only_in_the_params_is_narrated() {
        let narration: MethodsNarration = serde_json::from_value(serde_json::json!({
            "subject": { "singular": "row", "plural": "rows" },
            "action": "scored",
            "params": { "rng": "seed" }
        }))
        .unwrap();
        let text = methods_text(&[run_with(narration, serde_json::json!({ "rng": 99 }))]);
        assert!(text.contains("(random seed 99)"), "the seed is narrated: {text}");
        assert!(!text.contains("`rng`"), "…so it is not ALSO disclosed as a gap: {text}");
    }

    // TEST-22 [ITEM-1/ITEM-2] / ROUND-1 — the substitution is ONE PASS and a value carrying
    // a brace is not substitutable.
    //
    // THE FINDING: `String::replace` over the accumulating output meant (a) a param value
    // containing braces put a literal `{…}` into the deliverable the build gate exists to
    // keep out — reachable from a user-typed output name — and (b) an earlier token's
    // value was re-scanned by later tokens, so a value spelling a later token was itself
    // replaced, and the document stated a value the run never recorded.
    //
    // HONEST SCOPE, because the obvious claim would be false: with the brace rejection in
    // place, part (a) can no longer be made to fail by restoring the sequential `replace`
    // — a value that spells a token must contain a brace, and such a value is now
    // unsubstitutable, so the re-scan defect is UNREACHABLE. The brace rejection is the
    // belt; the one-pass rebuild is the braces, kept because it makes the property
    // structural instead of contingent on another rule staying in place. What actually
    // pins the rebuild is the span round-trip in
    // `the_build_lint_and_the_narrator_agree_on_what_a_placeholder_is`, which fails on an
    // off-by-one at either boundary. Part (b) IS red on revert of the brace rejection.
    #[test]
    fn a_substituted_value_is_never_rescanned_and_never_carries_a_brace() {
        let narration: MethodsNarration = serde_json::from_value(serde_json::json!({
            "subject": { "singular": "row", "plural": "rows" },
            "action": "scored",
            "commits": "a {a}-deep column over {b} rows",
            "commits_unlabeled": "a column",
            "params": { "a": "narrated_value", "b": "narrated_value" }
        }))
        .unwrap();

        // (a) an earlier value that SPELLS a later token is not re-substituted.
        let rescan = methods_text(&[run_with(
            narration.clone(),
            serde_json::json!({ "a": "{b}", "b": "9" }),
        )]);
        assert!(
            !rescan.contains("a 9-deep column over 9 rows"),
            "a value was re-scanned and replaced by another param's value: {rescan}"
        );

        // (b) a value carrying a brace is UNSUBSTITUTABLE — the phrase falls back, and the
        // value is disclosed rather than dropped. INV-1 is absolute: no `{…}` reaches the
        // deliverable, by ANY route, including a user-typed one.
        let braced = methods_text(&[run_with(
            narration,
            serde_json::json!({ "a": "3", "b": "cluster_{x}" }),
        )]);
        assert!(!braced.contains('{'), "a param VALUE leaked a brace: {braced}");
        assert!(braced.contains(", committing a column"), "fell back: {braced}");
        assert!(
            braced.contains("are not in a form this document can state")
                && braced.contains("`b`")
                && braced.contains("`a`"),
            "…and neither value was dropped: {braced}"
        );

        // (c) THE ALIAS IS NOT A ROUTE AROUND (b). `{label}` resolves through the
        // `output_label` param, and that resolution must apply the SAME rejection rules
        // as a directly-named token — otherwise a user-typed output name carrying a brace
        // is refused on one path and accepted on the other, and the deliverable gets its
        // literal brace by the one route no manifest lint can see.
        let via_alias: MethodsNarration = serde_json::from_value(serde_json::json!({
            "subject": { "singular": "row", "plural": "rows" },
            "action": "scored",
            "commits": "a column labelled `{label}`",
            "commits_unlabeled": "a column",
            "params": { "name": "output_label" }
        }))
        .unwrap();
        let aliased = methods_text(&[run_with(
            via_alias,
            serde_json::json!({ "name": "cluster_{x}" }),
        )]);
        assert!(!aliased.contains('{'), "the alias leaked a brace: {aliased}");
        assert!(aliased.contains(", committing a column."), "fell back: {aliased}");
        assert!(
            aliased.contains("are not in a form this document can state")
                && aliased.contains("`name`"),
            "…and the label value is disclosed rather than dropped: {aliased}"
        );
    }

    // TEST-23 [ITEM-1] / ROUND-1, corrected in ROUND-4 — `{label}` resolves by the
    // DECLARATION, so an UNDECLARED param that happens to be named `label` cannot shadow
    // the declared output label.
    //
    // THE FINDING (round 1): resolving the alias first let a manifest with
    // `name: output_label` and a separate recorded `label` param render `name`'s value
    // under `{label}` — a silently wrong value. Round 1 fixed it by trying the RUN's
    // record first, which traded one wrong value for a run-DEPENDENT one and put the
    // choice somewhere the build gate cannot see: the gate reads the manifest, and an
    // undeclared param exists only in the run. Keying on the DECLARATION makes the gate's
    // verdict and the narrator's behaviour the same statement about the same text, which
    // is what lets the gate refuse the genuinely ambiguous shape at all.
    #[test]
    fn the_reserved_label_resolves_by_the_declaration_not_by_the_run() {
        let with_name: MethodsNarration = serde_json::from_value(serde_json::json!({
            "subject": { "singular": "row", "plural": "rows" },
            "action": "scored",
            "commits": "a column labelled `{label}`",
            "params": { "name": "output_label" }
        }))
        .unwrap();

        // (a) an UNDECLARED `label` in the RUN does not shadow the declared output label…
        let shadowed = methods_text(&[run_with(
            with_name.clone(),
            serde_json::json!({ "name": "the_declared_label", "label": "an_undeclared_param" }),
        )]);
        assert!(shadowed.contains("labelled `the_declared_label`"), "{shadowed}");
        assert!(
            !shadowed.contains("labelled `an_undeclared_param`"),
            "an undeclared param must not shadow the declared output label — the build \
             gate cannot see it: {shadowed}"
        );
        // …and it is still disclosed, never dropped.
        assert!(shadowed.contains("`label`"), "{shadowed}");

        // (b) with nothing else recorded, the alias resolves through the declared role.
        let aliased = methods_text(&[run_with(
            with_name,
            serde_json::json!({ "name": "the_declared_label" }),
        )]);
        assert!(aliased.contains("labelled `the_declared_label`"), "{aliased}");

        // (c) the SHIPPED spelling — the label param is itself named `label` — resolves to
        // the same value under either reading, which is why the shipped export is
        // unchanged by any of this.
        let shipped: MethodsNarration = serde_json::from_value(serde_json::json!({
            "subject": { "singular": "row", "plural": "rows" },
            "action": "scored",
            "commits": "a column labelled `{label}`",
            "params": { "label": "output_label" }
        }))
        .unwrap();
        let text = methods_text(&[run_with(shipped, serde_json::json!({ "label": "lowqc" }))]);
        assert!(text.contains("labelled `lowqc`"), "{text}");
    }

    // TEST-24 [ITEM-2] / ROUND-1 — a declared commit phrase that could not be
    // rendered is DISCLOSED, not silently absent.
    #[test]
    fn an_unrenderable_commit_phrase_is_disclosed() {
        let narration: MethodsNarration = serde_json::from_value(serde_json::json!({
            "subject": { "singular": "row", "plural": "rows" },
            "action": "scored",
            "commits": "a {depth}-deep column",
            "params": { "depth": "narrated_value" }
        }))
        .unwrap();
        let text = methods_text(&[run_with(narration, serde_json::json!({ "other": 1 }))]);
        assert!(!text.contains(", committing"), "no clause was rendered: {text}");
        assert!(
            text.contains("declares a description of what it commits, and it is NOT stated here"),
            "…and the document SAYS a statement was withheld: {text}"
        );
    }

    // TEST-25 [ITEM-11] / ROUND-1 — a non-executing node's absent environment digest is
    // NOT a gap.
    //
    // THE FINDING: every run with no digest was counted, but `None` is the DESIGNED state
    // for a selection / interaction / promote node — `readiness::env_pinned_flag_for_kind`
    // keeps their flag green for exactly that reason. Counting them printed a gap claim
    // this bundle's OWN readiness report contradicts: the same false-accusation shape the
    // branch exists to remove, reintroduced two sections lower.
    #[test]
    fn a_non_executing_node_without_a_digest_is_not_reported_as_a_gap() {
        let node = |kind: &str, digest: Option<&str>| MethodRun {
            kind: kind.into(),
            generator_id: "t".into(),
            generator_version: "1".into(),
            seed: None,
            params: serde_json::json!({}),
            input_slots: Vec::new(),
            auto_bound_slots: Vec::new(),
            narration: None,
            env_rootfs_sha256: digest.map(str::to_string),
        };
        let mixed = methods_text(&[node("compute", Some("sha-a")), node("selection.column", None)]);
        assert!(mixed.contains("`sha-a`"), "{mixed}");
        assert!(
            !mixed.contains("recorded NO environment digest"),
            "a selection node pins no rootfs BY DESIGN; calling it a gap contradicts \
             readiness.json: {mixed}"
        );
        // …and a COMPUTE run with none is still a gap, so the check did not go silent.
        let real_gap = methods_text(&[node("compute", None)]);
        assert!(real_gap.contains("1 executed step(s) recorded NO environment digest"), "{real_gap}");
    }


    // TEST-33 [ITEM-8] / ROUND-2 — the DISCLOSURE SENTENCE must be true of what it lists.
    //
    // THE FINDING: the narrated-not-declared rewrite changed WHICH params reach the
    // disclosure but not the sentence. "may further constrain the result" is the right
    // hedge for a param the narration does not model at all; it is FALSE for a param
    // whose declared role explicitly does NOT constrain (a label, a seed, a cap, an
    // interpolated value). Both shipped `embedding` analyses declare an `output_label`
    // whose commit phrase never names it, so EVERY embedding export would have stated
    // that the user's chosen output name "may further constrain the result" — a new false
    // statement about the run, in the deliverable this branch exists to make honest.
    //
    // RED ON REVERT: merge the two lists back into one sentence.
    #[test]
    fn the_disclosure_does_not_call_a_declared_non_constraining_param_a_constraint() {
        let narration: MethodsNarration = serde_json::from_value(serde_json::json!({
            "subject": { "singular": "row", "plural": "rows" },
            "action": "scored",
            "commits": "a fixed column",
            "params": { "name": "output_label" }
        }))
        .unwrap();
        let text = methods_text(&[run_with(
            narration,
            serde_json::json!({ "name": "chosen_by_the_user", "mystery_knob": 1 }),
        )]);

        // The UNDECLARED param keeps the honest hedge — it could be anything.
        assert!(
            text.contains("may further constrain the result: `mystery_knob`"),
            "an unmodelled param keeps its hedge: {text}"
        );
        // The DECLARED, non-constraining one is disclosed WITHOUT that claim.
        assert!(
            text.contains("`name` = `chosen_by_the_user`"),
            "a declared non-constraining param is still disclosed: {text}"
        );
        assert!(
            !text.contains("constrain the result: `name`")
                && !text.contains("`mystery_knob`, `name`")
                && !text.contains("`name`, `mystery_knob`"),
            "…but never as something that may constrain the result: {text}"
        );

        // …AND against the SHIPPED manifests, which is where the defect actually lives and
        // what this feature's own INV-1 discipline demands ("enforced by a test over the
        // shipped manifests, not by inspection"). Every shipped analysis that declares an
        // `output_label` its commit phrase never names lands its user-chosen output name in
        // this disclosure on EVERY export; the synthetic case above would not notice if the
        // shipped shape changed underneath it.
        let mut checked = 0;
        for (pkg, analysis, spec) in shipped_narrations() {
            let Some((label_key, _)) =
                spec.params.iter().find(|(_, r)| matches!(r, MethodsParamRole::OutputLabel))
            else {
                continue;
            };
            let phrase = format!(
                "{}{}",
                spec.commits.as_deref().unwrap_or(""),
                spec.commits_unlabeled.as_deref().unwrap_or("")
            );
            if phrase.contains(&format!("{{{label_key}}}")) || phrase.contains("{label}") {
                continue; // this analysis DOES name its label; nothing to disclose
            }
            let recorded: serde_json::Map<String, Value> = spec
                .params
                .iter()
                .map(|(k, r)| (k.clone(), sample_value(*r)))
                .collect();
            let out = methods_text(&[run_with(spec.clone(), Value::Object(recorded))]);
            assert!(
                !out.contains(&format!("constrain the result: `{label_key}`")),
                "{pkg}/{analysis}: the user's chosen output name must not be described as \
                 a possible constraint:\n{out}"
            );
            assert!(
                out.contains(&format!("`{label_key}` = ")),
                "{pkg}/{analysis}: an output name the phrase never states must be stated \
                 in the disclosure, with its value:\n{out}"
            );
            checked += 1;
        }
        assert!(
            checked >= 2,
            "both shipped `embedding` analyses are in this shape; only {checked} were \
             exercised — the fixture has drifted away from the defect"
        );
    }

    // TEST-34 [ITEM-7] / ROUND-2 — an EMPTY constraint value is not "criteria were
    // recorded".
    //
    // THE FINDING: the round-1 discriminator was `!value.is_null()`, so `criteria: []`
    // counted as a recorded constraint and the run was told "the criteria recorded for
    // this run state no constraint … so the predicate it applied is not documented here"
    // — asserting both that criteria exist (the list is empty) and that a predicate was
    // applied (none was). That is the false accusation the gap-sentence split exists to
    // remove, reintroduced one level down.
    #[test]
    fn an_empty_constraint_value_is_not_treated_as_recorded_criteria() {
        for empty in [
            serde_json::json!([]),
            serde_json::json!({}),
            serde_json::json!("   "),
        ] {
            let text = methods_text(&[filter_run(serde_json::json!({ "criteria": empty }))]);
            // Its own sentence, because it is its own FACT: the run DID record the
            // parameter and it states nothing. Saying "no criteria were recorded" would be
            // denied by the disclosure two sentences later (which names `criteria`) and by
            // the same bundle's `manifest.json` (which carries it); saying a predicate was
            // withheld would be a false accusation. Neither is necessary.
            assert!(
                text.contains("are empty, so no predicate was applied"),
                "an empty value is its own fact: {text}"
            );
            assert!(
                !text.contains("no criteria were recorded"),
                "…and the param WAS recorded, so it must not claim otherwise while the \
                 disclosure below names it: {text}"
            );
            assert!(
                !text.contains("the predicate it applied is not documented here"),
                "…and no predicate was applied, so none may be claimed withheld: {text}"
            );
            assert!(
                text.contains("`criteria`"),
                "…and the recorded param is still disclosed by name: {text}"
            );
        }
        // …and a NON-EMPTY but unrenderable value still takes the other branch, so the
        // discriminator did not simply go silent.
        let unrenderable = methods_text(&[filter_run(serde_json::json!({
            "criteria": [{ "column": "x" }],
        }))]);
        assert!(unrenderable.contains("render no constraint here"), "{unrenderable}");
        assert!(
            !unrenderable.contains("no criteria were recorded"),
            "…and not the other sentence: {unrenderable}"
        );
    }


    // TEST-37 [ITEM-1/ITEM-2] / ROUND-3 — the SEED is recorded as a numeric STRING by
    // every shipped control, and must still be narrated.
    //
    // THE FINDING: the round-1 seed fix coerced with `as_i64()` alone, which returns None
    // for `"0"` — the value every shipped seed control actually produces
    // (`seed: { type: string, default: "0" }`). So on every UI-launched run the DECLARED
    // seed was ignored and the param was then disclosed as un-narrated while the run
    // column narrated the same value two clauses earlier: double-reported, and the fix
    // that was supposed to rescue "the single most reproducibility-critical scalar" never
    // fired on a real run.
    #[test]
    fn a_seed_recorded_as_a_numeric_string_is_narrated_like_a_number() {
        let narration: MethodsNarration = serde_json::from_value(serde_json::json!({
            "subject": { "singular": "row", "plural": "rows" },
            "action": "scored",
            "params": { "seed": "seed" }
        }))
        .unwrap();
        for recorded in [serde_json::json!("7"), serde_json::json!(" 7 "), serde_json::json!(7)] {
            let text = methods_text(&[run_with(
                narration.clone(),
                serde_json::json!({ "seed": recorded }),
            )]);
            assert!(text.contains("(random seed 7)"), "{recorded}: {text}");
            assert!(
                !text.contains("`seed`"),
                "{recorded}: a narrated seed must not ALSO be disclosed as un-narrated: {text}"
            );
        }
        // A seed that is not a number at all is not invented — it is disclosed.
        let odd = methods_text(&[run_with(
            narration,
            serde_json::json!({ "seed": "from the clock" }),
        )]);
        assert!(!odd.contains("random seed"), "no seed is fabricated: {odd}");
        assert!(odd.contains("`seed`"), "…and the recorded value is disclosed: {odd}");
    }

    // TEST-38 [ITEM-11] / ROUND-3 — `executes_code` and the readiness checklist's
    // discriminator are pinned to each other.
    //
    // The two statements are read side by side out of the SAME bundle: methods.md says
    // "N executed step(s) recorded NO environment digest" and `readiness.json` says, per
    // run, whether its environment was pinned. A reader who finds them disagreeing learns
    // only that the bundle cannot be trusted. Two implementations of one discriminator is
    // the same hazard the tokenizer pair carries, and it gets the same remedy: a test that
    // fails on divergence rather than a comment claiming they agree.
    #[test]
    fn the_executed_step_discriminator_matches_the_readiness_checklist() {
        use crate::modules::provenance::export::readiness::env_pinned_flag_for_kind;
        for kind in [
            "compute",
            "selection.column",
            "selection.predicate",
            "annotation",
            "group",
            "promote",
            "interaction",
            "some.future.kind",
        ] {
            let run = MethodRun {
                kind: kind.into(),
                generator_id: "t".into(),
                generator_version: "1".into(),
                seed: None,
                params: serde_json::json!({}),
                input_slots: Vec::new(),
                auto_bound_slots: Vec::new(),
                narration: None,
                env_rootfs_sha256: None,
            };
            // With NO digest recorded, readiness calls the run pinned exactly when it did
            // not need to pin one — i.e. exactly when it did not execute code.
            let readiness_says_pinned = env_pinned_flag_for_kind(kind, None, "1.0", true);
            assert_eq!(
                executes_code(&run),
                !readiness_says_pinned,
                "`{kind}`: methods.md and readiness.json disagree about whether this node \
                 executes code, so the two statements in one bundle contradict each other"
            );
        }
    }


    // TEST-39 [ITEM-8] / ROUND-4 — a reference-asset facet is MODELLED by the narration,
    // so it must not be hedged as a param the narration does not model.
    //
    // THE FINDING: the round-2 split bucketed on `spec.params.contains_key`, but an asset
    // facet is declared under `reference_assets`, never under `params`. An unresolved
    // asset's params therefore landed in the "may further constrain the result" list — the
    // sentence explicitly reserved for params the narration knows nothing about.
    #[test]
    fn an_unresolved_reference_asset_param_is_not_hedged_as_unmodelled() {
        let spec: MethodsNarration = serde_json::from_value(serde_json::json!({
            "subject": { "singular": "row", "plural": "rows" },
            "action": "scored",
            "reference_assets": [
                { "kind": "reference database", "name": "db", "version": "db_version",
                  "source": "db_source", "digest": "db_sha256" }
            ]
        }))
        .unwrap();
        // No version recorded → the asset does not resolve → every facet falls back.
        let text = methods_text(&[run_with(
            spec,
            serde_json::json!({
                "db": "ligrec", "db_source": "s", "db_sha256": "d", "mystery": 1,
            }),
        )]);
        for facet in ["`db`", "`db_source`", "`db_sha256`"] {
            assert!(text.contains(facet), "{facet} must be disclosed: {text}");
        }
        assert!(
            text.contains("so they are stated here")
                || text.contains("are not in a form this document can state"),
            "an asset facet is DECLARED, so it takes a declared sentence: {text}"
        );
        assert!(
            !text.contains("constrain the result: `db`")
                && !text.contains("`db`, `db_sha256`, `db_source`, `mystery`"),
            "…never the unmodelled-param hedge: {text}"
        );
        // …and a genuinely unmodelled param still gets that hedge, so the split is a
        // classification and not a blanket rename.
        assert!(
            text.contains("may further constrain the result: `mystery`"),
            "{text}"
        );
    }

}
