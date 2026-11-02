//! Dataset persistence (the owner-corrected entity, DESIGN §5).
//!
//! **Canonical repository pattern.** Uses sqlx COMPILE-TIME `query_as!`/`query!`
//! macros: every query is verified against the build database's real schema at
//! `cargo check` time. Enabled by `build.rs` (provisions + migrates a
//! per-worktree build DB and sets `DATABASE_URL`).
//!
//! SQLite driver (sqlite-store DEC-1: the app's modules are single-driver):
//! `uuid` columns are 16-byte BLOBs, `jsonb` columns are JSON TEXT, and
//! `timestamptz` columns are canonical RFC3339-UTC TEXT (DEC-8's map), so the
//! `<ident: Type>` overrides the PG macro inference cannot produce are written
//! out explicitly wherever the DB type differs from the Rust type —
//! `col as "col: DateTime<Utc>"`, `col as "col: serde_json::Value"`, and the
//! INTEGER-affinity columns the sqlite macro infers as `i64` get their `i32`
//! field types spelled out. The `now()` → `strftime('%Y-%m-%dT%H:%M:%fZ','now')`
//! clock, the ILIKE → `instr(lower(x), lower($n))` rewrite (DEC-11, ASCII-only
//! folding), the `= ANY(uuid[])` → JSON1 membership rewrite (see
//! [`uuid_list_json`]) and the `ARRAY_AGG(…)[1]` → `json_group_array` +
//! `json_extract('$[0]')` rewrite (DEC-12) are documented at their sites.

use chrono::{DateTime, Utc};
use sqlx::SqlitePool;
use uuid::Uuid;
use ziee_core::AppError;

use crate::modules::datatype::types::FileLayout;
use crate::modules::workstore::object_store::{merkle_root, ContentKey, MemberRef};

use super::models::{
    compact_declaration, Dataset, DatasetArtifactGroup, DatasetFile, DatasetFolder, DatasetShare,
};

// =============================== pure helpers ===============================
// Extracted so they are unit-testable without a DB (TEST-1).

/// The dataset's content identity over its file(s): a single file's identity is
/// just its blob's `sha256:<hex>` (so a byte-preserving promote yields
/// `dataset.content_hash == source artifact hash`); a multi-file dataset's is the
/// merkle root over its `(filename, blob-hash)` members — the SAME algorithm the
/// workstore uses for multi-file artifacts, so identities line up across tiers.
///
/// Each entry is `(filename, sha256-hex, byte-len)`.
pub fn dataset_content_hash(files: &[(String, String, i64)]) -> Option<String> {
    match files.len() {
        0 => None,
        1 => Some(format!("sha256:{}", files[0].1)),
        _ => {
            let members: Vec<MemberRef> = files
                .iter()
                .map(|(path, hex, len)| MemberRef {
                    path: path.clone(),
                    blob: ContentKey::from_hex(hex),
                    len: (*len).max(0) as u64,
                })
                .collect();
            Some(format!("sha256:{}", merkle_root(&members)))
        }
    }
}

/// The one-logical-thing cardinality rule (DEC-2): a `Single`-layout datatype is
/// exactly one file; a multi-file layout (`Prefix`/`Manifest`) is one-or-many.
/// An unknown datatype (`None`) is not blocked (the sniffer may not have typed it).
pub fn enforce_cardinality(layout: Option<FileLayout>, file_count: usize) -> Result<(), AppError> {
    if file_count == 0 {
        return Err(AppError::bad_request(
            "EMPTY_DATASET",
            "A dataset must contain at least one file",
        ));
    }
    if layout == Some(FileLayout::Single) && file_count > 1 {
        return Err(AppError::bad_request(
            "DATASET_CARDINALITY",
            "This datatype is a single logical file; upload independent files as separate datasets",
        ));
    }
    Ok(())
}

/// Plan how N uploaded files group into dataset(s) (ITEM-4 / DEC-2). The DEFAULT
/// is one dataset per file — the safe "don't guess" behaviour (two independent
/// `.h5ad` → two datasets). An explicit grouping (the UI confirming that an mtx
/// trio's files jointly form ONE 10x matrix) is validated to partition
/// `0..n_files` exactly. Returns the group index-sets or a validation error msg.
pub fn plan_upload_groups(
    n_files: usize,
    explicit: Option<&[Vec<usize>]>,
) -> Result<Vec<Vec<usize>>, String> {
    let Some(groups) = explicit else {
        return Ok((0..n_files).map(|i| vec![i]).collect());
    };
    let mut seen = vec![false; n_files];
    for g in groups {
        if g.is_empty() {
            return Err("a group cannot be empty".to_string());
        }
        for &idx in g {
            if idx >= n_files {
                return Err(format!("file index {idx} out of range (0..{n_files})"));
            }
            if seen[idx] {
                return Err(format!("file index {idx} appears in more than one group"));
            }
            seen[idx] = true;
        }
    }
    if let Some(missing) = seen.iter().position(|&s| !s) {
        return Err(format!("file index {missing} is not assigned to any group"));
    }
    Ok(groups.to_vec())
}

// ------------------- multi-member manifest auto-group (ITEM-28 / DEC-31) -------------------

/// The DATA that drives multi-member auto-grouping: the datatype id to assign, and
/// the member filenames it declares. BOTH halves come from the registry — the id
/// from the `mtx-trio-target` capability carrier, the member names from that
/// same datatype's `input_requirements: { requires: manifest, members: [...] }`.
///
/// Nothing here knows what the members MEAN. The core knows only "these N declared
/// names, arriving together, form ONE dataset of this type"; which names, and hence
/// which domain convention, is entirely the contributed datatype's business.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestGroupSpec {
    /// The datatype id assigned to a detected group.
    pub datatype: String,
    /// The declared member filenames, in declaration order. An entry may list
    /// alternatives separated by `|` (`"features.tsv|genes.tsv"`) for a member with
    /// more than one accepted spelling — the ONLY matching sugar the core supports,
    /// and still pure DATA.
    pub members: Vec<String>,
}

/// Resolve EVERY multi-member auto-group spec the registry declares (ITEM-15 /
/// DEC-13, S11). Both the id and the member names are DATA — each contributed
/// datatype declaring the [`MANIFEST_GROUP_CAPABILITY`] owns them — so no
/// datatype-id literal and no member-FILENAME literal lives here (this used to
/// hard-code the Cell Ranger raw-output convention).
///
/// ## S11 — why this is a LIST, not "the first carrier"
///
/// It used to `return` inside the loop, and `types_with_capability` SORTS, so the
/// winner was whichever carrier sorted first ALPHABETICALLY. That silently capped a
/// deployment at exactly ONE multi-member auto-grouping datatype globally: install a
/// second domain declaring, say, a 4-file imaging bundle and its groups stop being
/// detected — with the same silent shape as S10, because a partial/failed group just
/// falls back to one-dataset-per-file.
///
/// Returning all carriers lets the caller try each and take the one that actually
/// MATCHES the uploaded filenames, which is both correct for N domains and
/// deterministic (id-sorted). A carrier declaring no manifest members contributes
/// nothing (it cannot detect a group) and is skipped.
///
/// Empty when the registry isn't built (a direct-repo unit context, never a request
/// path) or nothing declares the marker; the caller then leaves the group untyped
/// (falls back to a per-file sniff) rather than mistyping.
pub fn manifest_group_specs(
    registry: Option<&crate::modules::datatype::DatatypeRegistry>,
) -> Vec<ManifestGroupSpec> {
    let Some(reg) = registry else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for id in reg.types_with_capability(MANIFEST_GROUP_CAPABILITY) {
        let Some(dt) = reg.get(&id) else { continue };
        if let Some(crate::modules::datatype::types::InputRequirements::Manifest {
            members, ..
        }) = dt.input_requirements.as_ref()
        {
            if !members.is_empty() {
                out.push(ManifestGroupSpec {
                    datatype: id,
                    members: members.clone(),
                });
            }
        }
    }
    out
}

/// The capability marker a contributed datatype sets to opt into multi-member
/// auto-grouping. A CAPABILITY name, not a datatype id — the vocabulary of the
/// declaration seam itself, which every contributed domain shares.
///
/// The VALUE is the shipped contract (contributed manifests declare it verbatim), so
/// the prose above spells the same literal; the Rust identifier is generic because
/// nothing in the core is 10x-specific.
pub const MANIFEST_GROUP_CAPABILITY: &str = "mtx-trio-target";

/// Split a filename into the normalized SEGMENTS member matching compares.
///
/// Each segment is lowercased; empty segments (a leading, trailing or doubled
/// separator) are dropped; and ONE compression suffix is stripped from the LAST
/// segment only — a directory named `archive.gz` is a directory, not a compressed
/// thing. Both separators are honoured because a browser may send either.
///
/// All of this is generic file-transport convention, not domain knowledge — the rule
/// [`MANIFEST_GROUP_CAPABILITY`]'s doc-comment states for the capability seam applies
/// unchanged here: the core carries no vendor's vocabulary.
fn member_path_segments(filename: &str) -> Vec<String> {
    // A name ending in a separator NAMES A DIRECTORY, and a directory is not a member.
    // Dropping the trailing empty segment instead would both resurrect a name the
    // shipped normalizer matched nothing for (`outs/counts.h5/` used to normalize to
    // `""`) and strip a compression suffix off a directory (`archive.gz/`), which is the
    // one thing the rule below disclaims. Returning nothing keeps the old verdict.
    if filename.ends_with('/') || filename.ends_with('\\') {
        return Vec::new();
    }
    let mut segs: Vec<String> = filename
        .split(['/', '\\'])
        .filter(|s| !s.is_empty())
        .map(str::to_ascii_lowercase)
        .collect();
    if let Some(last) = segs.last_mut() {
        for suffix in [".gz", ".bz2", ".xz", ".zst"] {
            if let Some(stem) = last.strip_suffix(suffix) {
                *last = stem.to_string();
                break;
            }
        }
    }
    segs
}

/// Does `filename` satisfy the declared `member` (possibly a `|`-alternation)?
///
/// ## The key is the DECLARED member's own segment count (#160, DEC-2)
///
/// A member declaring no path separator matches on the BASENAME — byte-identically to
/// the behaviour every container shipped before this. A member declaring `K`
/// separators matches iff the candidate's **last `K+1`** normalized segments equal the
/// member's, so a declaration says for itself how much context it needs to be
/// unambiguous:
///
/// * `counts.h5` matches it anywhere (under an `outputs/` directory, at a zip root, or
///   in a folder the user renamed);
/// * `bin_b/counts.h5` matches only under `bin_b/`, so a bundle whose sub-directories
///   each hold an identically-named copy stops offering three candidates for ONE member
///   and offers one candidate for each of three members.
///
/// Anchoring at the SUFFIX rather than the whole relative path is the load-bearing
/// half: the root directory of an uploaded bundle is whatever the user called it, so a
/// full-path key would refuse the ordinary case. And the depth is DATA — it is read off
/// the declared member string, which a contributed package owns — so a vendor that
/// nests deeper declares deeper and this file is not edited. Each `|`-alternative
/// carries its own depth.
fn matches_member(filename: &str, member: &str) -> bool {
    segments_match_member(&member_path_segments(filename), member)
}

/// [`matches_member`] over ALREADY-SPLIT segments. The split is the expensive half and it
/// does not depend on the member, so a caller comparing one file against N members splits
/// once (see [`tail_segments`] for why that matters).
fn segments_match_member(got: &[String], member: &str) -> bool {
    member.split('|').any(|alt| {
        let want = member_path_segments(alt.trim());
        !want.is_empty() && got.len() >= want.len() && got[got.len() - want.len()..] == want[..]
    })
}

/// Why a declared multi-member group did NOT form. Every field is reported at once
/// because a real failed upload usually hits more than one: pointing a plain-Visium
/// declaration at a Visium HD bundle makes one member ambiguous (three bins) *and*
/// another missing (HD writes `.parquet` positions), and a message naming only the
/// first sends the user to fix the wrong thing.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ManifestGroupGap {
    /// The members each resolved to exactly one file, but those files do NOT come from one
    /// bundle — as `(member, the directory the match was found under)`, in declared order.
    /// Populated only for a declaration that carries path segments; see
    /// [`shares_one_bundle_root`].
    pub scattered_roots: Vec<(String, String)>,
    /// Declared members with MORE than one candidate, as `(member, candidate count)`.
    pub ambiguous: Vec<(String, usize)>,
    /// Declared members with NO candidate.
    pub missing: Vec<String>,
    /// Uploaded files satisfying more than one declared member, as
    /// `(filename, the members it claims)` — an ambiguous DECLARATION, not a bad upload.
    pub multi_claim: Vec<(String, Vec<String>)>,
}

impl ManifestGroupGap {
    /// A one-line, user-facing explanation. Names the members, never the mechanism.
    pub fn explain(&self) -> String {
        // CAPPED throughout. Every list below is built from CALLER-SUPPLIED filenames and
        // is echoed verbatim into a 400 body; an upload at the part ceiling would otherwise
        // reflect megabytes of the caller's own path text back at them.
        const MAX_LISTED: usize = 5;
        let mut parts: Vec<String> = Vec::new();
        if !self.scattered_roots.is_empty() {
            // The DISTINCT roots are the useful information — which places disagreed —
            // not one line per member repeating the same few. Listing them per member both
            // buried the answer and made the message grow with the declaration.
            let roots: std::collections::BTreeSet<&str> = self
                .scattered_roots
                .iter()
                .map(|(_, root)| root.as_str())
                .collect();
            let shown: Vec<String> = roots
                .iter()
                .take(MAX_LISTED)
                .map(|root| {
                    // Caller-supplied text echoed into a 400 body: elide, never reflect.
                    let head: String = root.chars().take(120).collect();
                    let tail = if head.len() < root.len() { "…" } else { "" };
                    format!("'{head}{tail}'")
                })
                .collect();
            let more = roots.len().saturating_sub(shown.len());
            parts.push(format!(
                "the members were found under {} different directories, so they are not one \
                 bundle ({}{})",
                roots.len(),
                shown.join(", "),
                if more > 0 {
                    format!(", and {more} more")
                } else {
                    String::new()
                }
            ));
        }
        for (name, members) in self.multi_claim.iter().take(MAX_LISTED) {
            parts.push(format!(
                "'{name}' matches more than one declared member ({})",
                members.join(", ")
            ));
        }
        if self.multi_claim.len() > MAX_LISTED {
            parts.push(format!(
                "…and {} more file(s) matching several members",
                self.multi_claim.len() - MAX_LISTED
            ));
        }
        for (member, n) in &self.ambiguous {
            parts.push(format!(
                "{n} files match '{member}' (exactly one is required)"
            ));
        }
        if !self.missing.is_empty() {
            parts.push(format!("no file matches {}", quoted_list(&self.missing)));
        }
        parts.join("; ")
    }
}

fn quoted_list(items: &[String]) -> String {
    items
        .iter()
        .map(|s| format!("'{s}'"))
        .collect::<Vec<_>>()
        .join(", ")
}

/// The path segments that sit BEFORE a member's own declared segments in the file that
/// matched it — i.e. where in the upload that bundle member was found. `None` when the
/// file does not match the member at all.
fn member_root(got: &[String], member: &str) -> Option<Vec<String>> {
    // The DEEPEST matching alternative decides, not the first one written. A mixed-depth
    // alternation (`positions.csv|geo/positions.csv`) can have BOTH alternatives match one
    // file, and taking whichever was written first made the bundle root — and so the
    // one-bundle verdict — depend on declaration ORDER. The deepest match is the one that
    // consumed the most declared context, which is the answer that does not move.
    member
        .split('|')
        .filter_map(|alt| {
            let want = member_path_segments(alt.trim());
            if want.is_empty() || got.len() < want.len() {
                return None;
            }
            (got[got.len() - want.len()..] == want[..])
                .then(|| (want.len(), got[..got.len() - want.len()].to_vec()))
        })
        .max_by_key(|(depth, _)| *depth)
        .map(|(_, root)| root)
}

/// Do the matched files all come from ONE bundle? (#160)
///
/// Suffix anchoring is what lets a member ignore whatever the user named the folder they
/// picked — and on its own it also lets members be gathered from DIFFERENT folders. For a
/// declaration whose members carry their own sub-directory that is not a nuisance, it is
/// silently wrong data: four members found under `RunA/…/bin_a/`, four under
/// `RunB/…/bin_b/` and four under `RunC/…/bin_c/` each resolve uniquely, so the group
/// forms and the resulting dataset's "three resolutions" describe three different
/// specimens. The whole reason such a bundle is ONE dataset is that its parts share a run.
///
/// The rule: the roots must form a CHAIN under "is a prefix of" — every root is a prefix
/// of the longest one. That covers "one bundle, with members at different depths inside
/// it": a container declaring `x.h5` and `sub/y.csv` legitimately finds them at `outs` and
/// `outs/sub`, while two sibling runs give `RunA/b` and `RunB/b`, neither of which is a
/// prefix of the other.
///
/// It is a NECESSARY condition, not a sufficient one, and the gap is worth naming: a root
/// strictly DEEPER than another chains with it, so a run folder holding a PARTIAL backup
/// copy of one sub-directory can still form a group mixing the live and backed-up parts. A
/// COMPLETE copy cannot — every member would then have two candidates and the ambiguity
/// check refuses first — so what survives is the partial-copy case. Tightening it means
/// asking what the bundle ROOT is, which the declaration does not say.
///
/// Applied ONLY when some member declares a path segment. Every container that shipped
/// before #160 declares bare basenames, for which a "root" is simply wherever that file
/// happened to be, and constraining it would change a behaviour nothing asked to change.
fn shares_one_bundle_root(roots: &[Vec<String>]) -> bool {
    let Some(longest) = roots.iter().max_by_key(|r| r.len()) else {
        return true;
    };
    roots
        .iter()
        .all(|r| r.len() <= longest.len() && longest[..r.len()] == r[..])
}

/// The outcome of matching uploaded filenames against a declared member list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManifestGroupOutcome {
    /// Exactly one file matched each declared member; the indices are in DECLARED order.
    Grouped(Vec<usize>),
    /// The declaration named no members — nothing to detect.
    Undeclared,
    /// Some member could not be resolved to exactly one file. [`ManifestGroupGap`] says
    /// which, and the group does NOT form.
    Gap(ManifestGroupGap),
}

/// Match uploaded filenames against a declared member list AND say why when it fails.
///
/// The VERDICT is identical to [`detect_manifest_group`] (which delegates here): a
/// member with two candidates, a missing member, or a file claiming two members is a
/// refusal, never a pick. What this adds is the ability to TELL the user which member,
/// so a type-first upload can be refused by name instead of silently degrading into
/// one dataset per file (#160 / DEC-3).
///
/// Domain-free: the member names are the caller's DATA (see [`manifest_group_specs`]).
pub fn explain_manifest_group(filenames: &[String], members: &[String]) -> ManifestGroupOutcome {
    if members.is_empty() {
        return ManifestGroupOutcome::Undeclared;
    }
    // Split each uploaded name ONCE. The split is the expensive half and it does not depend
    // on the member; doing it inside the per-member loop made matching
    // O(path length x members x carriers) over caller-supplied data, inside a synchronous
    // stretch of the upload handler. (Truncating each path to the deepest declared member
    // would be cheaper still and is WRONG: the discarded prefix is exactly what the
    // one-bundle-root rule reads, and dropping it made every root empty, so every upload
    // "shared a root". The tests caught that; the length bound belongs at ingest, where it
    // also matches what the column can store.)
    let split: Vec<Vec<String>> = filenames.iter().map(|n| member_path_segments(n)).collect();

    let mut candidates: Vec<Vec<usize>> = vec![Vec::new(); members.len()];
    let mut gap = ManifestGroupGap::default();
    for (i, name) in filenames.iter().enumerate() {
        // A file may satisfy at most one member; a file matching several declared
        // members is an ambiguous declaration → don't guess.
        let hits: Vec<usize> = members
            .iter()
            .enumerate()
            .filter(|(_, member)| segments_match_member(&split[i], member))
            .map(|(m, _)| m)
            .collect();
        match hits.len() {
            0 => {}
            1 => candidates[hits[0]].push(i),
            _ => gap.multi_claim.push((
                name.clone(),
                hits.iter().map(|&m| members[m].clone()).collect(),
            )),
        }
    }
    for (m, found) in candidates.iter().enumerate() {
        match found.len() {
            1 => {}
            // A second file claims the same member → ambiguous; don't guess (DEC-2).
            0 => gap.missing.push(members[m].clone()),
            n => gap.ambiguous.push((members[m].clone(), n)),
        }
    }
    if gap != ManifestGroupGap::default() {
        return ManifestGroupOutcome::Gap(gap);
    }
    let picked: Vec<usize> = candidates.into_iter().map(|c| c[0]).collect();

    // Every member resolved. For a DEPTH-CARRYING declaration, they must also have
    // resolved inside ONE bundle — see `shares_one_bundle_root` for why suffix anchoring
    // alone is not enough, and why this is gated on the declaration carrying a segment.
    // ONLY the members that CARRY a path segment are constrained. A bare-basename member
    // says, in the declaration, that it does not care where it sits — so holding it to a
    // bundle root contradicts its own declaration, and it refused a legitimate bundle:
    // `["params.json", "bin_a/counts.h5"]` found at `run/meta/params.json` and
    // `run/data/bin_a/counts.h5` gave roots `[run,meta]` and `[run,data]`, which do not
    // chain, though both are plainly in `run/`.
    let deep: Vec<(usize, &String)> = members
        .iter()
        .enumerate()
        .filter(|(_, m)| m.contains('/') || m.contains('\\'))
        .collect();
    if deep.len() >= 2 {
        let roots: Vec<Vec<String>> = deep
            .iter()
            .map(|(m, member)| member_root(&split[picked[*m]], member).unwrap_or_default())
            .collect();
        if !shares_one_bundle_root(&roots) {
            // Reported in the user's OWN CASE. `roots` is built from the NORMALIZED
            // segments (lowercased, that being what matching compares), and echoing those
            // back showed a user who picked `Exp/RunA` a message about `exp/runa`.
            gap.scattered_roots = deep
                .iter()
                .zip(roots.iter())
                .map(|((m, member), root)| {
                    let original: Vec<&str> = filenames[picked[*m]]
                        .split(['/', '\\'])
                        .filter(|s| !s.is_empty())
                        .collect();
                    let shown = original
                        .get(..root.len())
                        .map(|segs| segs.join("/"))
                        .unwrap_or_else(|| root.join("/"));
                    ((*member).clone(), shown)
                })
                .collect();
            return ManifestGroupOutcome::Gap(gap);
        }
    }
    ManifestGroupOutcome::Grouped(picked)
}

/// Detect a declared multi-member GROUP among uploaded filenames (ITEM-28 / DEC-31).
/// Returns the file indices in DECLARED member order IFF EXACTLY one file matches
/// each declared member. Ambiguous cases — a member with two candidates, or a
/// missing member (e.g. only one of three) — return `None`, so the caller falls back
/// to the DEC-2 one-per-file default rather than guessing.
///
/// Domain-free: the member names are the caller's DATA (see [`manifest_group_specs`]).
///
/// #160: this now delegates to [`explain_manifest_group`], which computes the same
/// verdict and additionally says WHY. The contract here is unchanged on purpose —
/// every existing caller and test reads `Option<Vec<usize>>` and must keep seeing
/// `None` for every shape it saw `None` for before.
pub fn detect_manifest_group(filenames: &[String], members: &[String]) -> Option<Vec<usize>> {
    match explain_manifest_group(filenames, members) {
        ManifestGroupOutcome::Grouped(indices) => Some(indices),
        _ => None,
    }
}

/// A planned upload group: the file indices that jointly form ONE dataset, plus an
/// OPTIONAL fixed datatype. `datatype = Some(id)` means the group was auto-detected
/// from the declared member names (ITEM-28) so its type is FIXED (a per-file sniff
/// would mis-type an individual member as some single-file type); `None` means
/// "type it from the representative file's sniff" (the existing ITEM-4 behaviour).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UploadGroup {
    pub indices: Vec<usize>,
    pub datatype: Option<String>,
}

/// Plan how uploaded files group into dataset(s), by filename (ITEM-4 + ITEM-28).
///
/// - An EXPLICIT grouping is authoritative and unchanged: honoured + partition-
///   validated (delegates to `plan_upload_groups`); each group's type comes from
///   its representative file's sniff (`datatype: None`).
/// - Otherwise a declared multi-member GROUP auto-groups into ONE `Manifest` dataset
///   fixed to that carrier's datatype (a [`MANIFEST_GROUP_CAPABILITY`] carrier,
///   DEC-13 — no id literal and no member-filename literal here), and every OTHER
///   file stays one-per-file (DEC-2 default). A partial group (only some members
///   present) is not a group → each file stays its own single-file dataset.
/// - With neither, the default is one dataset per file (the safe "don't guess").
///
/// `groups` are the DATA-resolved specs (see [`manifest_group_specs`]). S11: this
/// takes a SLICE and picks the first carrier whose declared members actually MATCH
/// the uploaded filenames — it used to take one spec, so a deployment could only
/// ever auto-group for the alphabetically-first carrier. Empty disables auto-grouping
/// entirely (per-file sniff fallback).
pub fn plan_upload_groups_by_name(
    filenames: &[String],
    explicit: Option<&[Vec<usize>]>,
    groups: &[ManifestGroupSpec],
) -> Result<Vec<UploadGroup>, String> {
    plan_upload_groups_by_name_preferring(filenames, explicit, groups, None)
}

/// As [`plan_upload_groups_by_name`], but a `preferred` carrier is consulted FIRST.
///
/// #160: carriers are id-sorted and the planner takes the first that matches, which is
/// deterministic but arbitrary when two of them match one upload. If the CALLER declared a
/// type, that is not arbitrary at all — it is the user's stated intent, and id-sort order
/// must not override it. Without this, declaring one container while another sorted first
/// stamped the OTHER carrier's group with the declared id and left the declared type's real
/// members to be sniffed one by one: the same silent mistyping this item exists to close,
/// on the one path the refusal could not see.
pub fn plan_upload_groups_by_name_preferring(
    filenames: &[String],
    explicit: Option<&[Vec<usize>]>,
    groups: &[ManifestGroupSpec],
    preferred: Option<&str>,
) -> Result<Vec<UploadGroup>, String> {
    // Explicit grouping wins — honour it exactly (sniff drives each group's type).
    if explicit.is_some() {
        return Ok(plan_upload_groups(filenames.len(), explicit)?
            .into_iter()
            .map(|indices| UploadGroup {
                indices,
                datatype: None,
            })
            .collect());
    }

    // No explicit grouping: auto-group the declared members by filename. The carriers
    // are id-sorted, so the FIRST MATCH is deterministic — and a carrier that does not
    // match simply yields to the next, instead of being the only one ever consulted.
    let ordered = groups
        .iter()
        .filter(|g| preferred == Some(g.datatype.as_str()))
        .chain(
            groups
                .iter()
                .filter(|g| preferred != Some(g.datatype.as_str())),
        );
    let matched =
        ordered.into_iter().find_map(|g| detect_manifest_group(filenames, &g.members).map(|found| (g, found)));
    if let Some((group, found)) = matched {
        let in_group: std::collections::HashSet<usize> = found.iter().copied().collect();
        let mut planned = Vec::with_capacity(filenames.len());
        // The members → ONE Manifest dataset with the fixed type (DATA-resolved).
        planned.push(UploadGroup {
            indices: found,
            datatype: Some(group.datatype.clone()),
        });
        // Every other file → its own single-file dataset (DEC-2 default).
        for i in 0..filenames.len() {
            if !in_group.contains(&i) {
                planned.push(UploadGroup {
                    indices: vec![i],
                    datatype: None,
                });
            }
        }
        return Ok(planned);
    }

    // Default: one dataset per file (the safe "don't guess" behaviour).
    Ok((0..filenames.len())
        .map(|i| UploadGroup {
            indices: vec![i],
            datatype: None,
        })
        .collect())
}

// =============================== pagination ===============================

/// Default page size for the dataset list endpoints (CODING_GUIDELINES §4:
/// every user-facing list is bounded).
pub const DEFAULT_PER_PAGE: i64 = 50;
/// Hard cap on any single list page (§4). Also the effective ceiling the
/// internal "give me all the files" callers (process / split / detail-view)
/// request — a single-cell dataset is one-to-a-handful of files, well under it.
pub const MAX_PER_PAGE: i64 = 500;

/// Row-window offset from a 1-based `page` + `per_page` (both already clamped by
/// the caller). Mirrors the jobs list's `(page - 1).max(0) * per_page`.
fn page_offset(page: i64, per_page: i64) -> i64 {
    (page - 1).max(0) * per_page
}

// =============================== access (ITEM-2 role enforcement) ===============================

/// The acting user's resolved authority over a dataset. `is_visible_to`
/// distinguishes only owner ∪ ANY sharee; this additionally separates a
/// read-only `view` sharee from an `edit`-role sharee, so a MUTATION gate
/// (`require_can_edit`) can 403 a viewer while a READ keeps `is_visible_to`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DatasetAccess {
    /// Neither owner nor any sharee (or the dataset is absent) → 404 (no oracle).
    NotVisible,
    /// A `view`-role sharee: may read, may NOT mutate → 403 on a mutation.
    ViewOnly,
    /// Owner or an `edit`-role sharee: may mutate.
    CanEdit,
}

// =============================== repository ===============================

/// Serialize a `uuid[]` batch into the JSON-hex form the SQLite membership
/// predicates consume (the `= ANY(uuid[])` port — DEC-12/PROV-sqlite-store-4):
/// a JSON array of 32-char lowercase hex strings, compared against a 16-byte
/// BLOB column through `unhex()` —
/// `col IN (SELECT unhex(j.value) FROM json_each($1) AS j)`. This is the
/// ITEM-15 `ziee-file` convention (its `uuid_list_json`), kept local because
/// the app's modules are single-driver (DEC-1) and beside the seven
/// group-share + two `id = ANY(…)` sites in this module it serves no other
/// surface.
fn uuid_list_json(ids: &[Uuid]) -> String {
    serde_json::to_string(
        &ids.iter()
            .map(|id| id.simple().to_string())
            .collect::<Vec<String>>(),
    )
    .expect("a Vec<String> is always JSON-serializable")
}

pub struct DatasetRepository {
    pool: SqlitePool,
}

impl DatasetRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    // ------------------------------- core CRUD -------------------------------

    /// Behaviour-preserving create — stamps the owner's personal account (A2 DEC-7).
    /// Kept for callers with NO active-account request context (tests, the derived
    /// group-base + split-children paths). The user-facing upload/create handler uses
    /// [`create_in_account`] to stamp the ACTIVE account.
    pub async fn create(
        &self,
        owner_id: Uuid,
        name: &str,
        datatype: Option<&str>,
        metadata: &serde_json::Value,
    ) -> Result<Dataset, AppError> {
        let account_id =
            crate::modules::account::scope::ensure_personal_account_for(&self.pool, owner_id)
                .await?;
        self.create_in_account(owner_id, account_id, name, datatype, metadata)
            .await
    }

    /// A4 ITEM-7: create stamped with an EXPLICIT `account_id` — the ACTIVE account
    /// (`ActiveAccount`, PROV-A4-1) the request is acting under. Membership of that
    /// account is proven by the extractor (a non-member is 404'd before the write).
    /// For a solo user the active account IS their personal account == what A2
    /// stamped, so `create_dataset` stays behaviour-preserving (INV-2).
    pub async fn create_in_account(
        &self,
        owner_id: Uuid,
        account_id: Uuid,
        name: &str,
        datatype: Option<&str>,
        metadata: &serde_json::Value,
    ) -> Result<Dataset, AppError> {
        let id = Uuid::new_v4();
        sqlx::query_as!(
            Dataset,
            r#"INSERT INTO datasets (id, name, owner_id, account_id, datatype, metadata, source)
               VALUES ($1, $2, $3, $4, $5, $6, 'upload')
               RETURNING id as "id: Uuid", name, owner_id as "owner_id: Uuid", account_id as "account_id!: Uuid", datatype,
                         metadata as "metadata: serde_json::Value",
                         source, source_artifact_id as "source_artifact_id: Uuid", content_hash,
                         created_at as "created_at: DateTime<Utc>",
                         updated_at as "updated_at: DateTime<Utc>""#,
            id,
            name,
            owner_id,
            account_id,
            datatype,
            metadata,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// Create an owner-scoped dataset PROMOTED from a workstore artifact (ITEM-7):
    /// `source='promote'` + the `source_artifact_id` back-pointer + carried
    /// type-metadata. The `content_hash` is filled by `recompute_content_hash`
    /// after the promoted file(s) are linked (byte-preserving ⇒ it equals the
    /// source artifact's hash).
    pub async fn create_promoted(
        &self,
        owner_id: Uuid,
        name: &str,
        datatype: Option<&str>,
        metadata: &serde_json::Value,
        source_artifact_id: Uuid,
    ) -> Result<Dataset, AppError> {
        let id = Uuid::new_v4();
        // A2: stamp the owner's personal account (behaviour-preserving; DEC-7).
        let account_id =
            crate::modules::account::scope::ensure_personal_account_for(&self.pool, owner_id)
                .await?;
        sqlx::query_as!(
            Dataset,
            r#"INSERT INTO datasets
                 (id, name, owner_id, account_id, datatype, metadata, source, source_artifact_id)
               VALUES ($1, $2, $3, $4, $5, $6, 'promote', $7)
               RETURNING id as "id: Uuid", name, owner_id as "owner_id: Uuid", account_id as "account_id!: Uuid", datatype,
                         metadata as "metadata: serde_json::Value",
                         source, source_artifact_id as "source_artifact_id: Uuid", content_hash,
                         created_at as "created_at: DateTime<Utc>",
                         updated_at as "updated_at: DateTime<Utc>""#,
            id,
            name,
            owner_id,
            account_id,
            datatype,
            metadata,
            source_artifact_id,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    pub async fn get(&self, id: Uuid) -> Result<Option<Dataset>, AppError> {
        sqlx::query_as!(
            Dataset,
            r#"SELECT id as "id: Uuid", name, owner_id as "owner_id: Uuid", account_id as "account_id!: Uuid", datatype,
                      metadata as "metadata: serde_json::Value",
                      source, source_artifact_id as "source_artifact_id: Uuid", content_hash,
                      created_at as "created_at: DateTime<Utc>",
                      updated_at as "updated_at: DateTime<Utc>"
               FROM datasets WHERE id = $1"#,
            id,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// Datasets the user OWNS (the "Mine" library), newest first, one page (§4).
    /// Optional `search` = case-insensitive name substring (already trimmed by the
    /// caller; blank never reaches here); optional `folder_id` restricts to that
    /// folder's members (owner-scoped). Returns `(page, total)` where `total` is the
    /// count matching the SAME filters WITHOUT limit/offset.
    pub async fn list_mine(
        &self,
        owner_id: Uuid,
        search: Option<&str>,
        folder_id: Option<Uuid>,
        page: i64,
        per_page: i64,
    ) -> Result<(Vec<Dataset>, i64), AppError> {
        // let-bound: the sqlx bind is borrowed across the statement (E0716 class).
        let page_off = page_offset(page, per_page);
        let items = sqlx::query_as!(
            Dataset,
            r#"SELECT d.id as "id: Uuid", d.name, d.owner_id as "owner_id: Uuid", d.account_id as "account_id!: Uuid", d.datatype,
                      d.metadata as "metadata: serde_json::Value",
                      d.source, d.source_artifact_id as "source_artifact_id: Uuid", d.content_hash,
                      d.created_at as "created_at: DateTime<Utc>",
                      d.updated_at as "updated_at: DateTime<Utc>"
               FROM datasets d
               -- H-1 (#147): "datasets you own" is conjoined with CURRENT membership
               -- of each row's account. Without it a removed member kept seeing the
               -- names/metadata of every dataset they created in the organization,
               -- each of which now 404s when opened — a listing that contradicts the
               -- gate. Edited IDENTICALLY in the page and the `total` query so the
               -- pager cannot promise pages that do not exist.
               WHERE d.owner_id = $1
                 AND d.account_id IN (SELECT am.account_id FROM account_members am
                                       WHERE am.user_id = $1)
                 -- (DEC-11: ILIKE has no SQLite form; instr(lower(...), lower($2))
                 -- is ASCII-only folding — documented limitation.)
                 AND ($2 IS NULL OR instr(lower(d.name), lower($2)) > 0)
                 AND ($3 IS NULL OR EXISTS (
                       SELECT 1 FROM dataset_folder_members m
                         JOIN dataset_folders fo ON fo.id = m.folder_id
                        WHERE m.dataset_id = d.id
                          AND m.folder_id = $3 AND fo.owner_id = $1))
               ORDER BY d.created_at DESC
               LIMIT $4 OFFSET $5"#,
            owner_id,
            search,
            folder_id,
            per_page,
            page_off,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;

        let total = sqlx::query_scalar!(
            r#"SELECT COUNT(*) as "count!"
               FROM datasets d
               -- H-1 (#147): "datasets you own" is conjoined with CURRENT membership
               -- of each row's account. Without it a removed member kept seeing the
               -- names/metadata of every dataset they created in the organization,
               -- each of which now 404s when opened — a listing that contradicts the
               -- gate. Edited IDENTICALLY in the page and the `total` query so the
               -- pager cannot promise pages that do not exist.
               WHERE d.owner_id = $1
                 AND d.account_id IN (SELECT am.account_id FROM account_members am
                                       WHERE am.user_id = $1)
                 AND ($2 IS NULL OR instr(lower(d.name), lower($2)) > 0)
                 AND ($3 IS NULL OR EXISTS (
                       SELECT 1 FROM dataset_folder_members m
                         JOIN dataset_folders fo ON fo.id = m.folder_id
                        WHERE m.dataset_id = d.id
                          AND m.folder_id = $3 AND fo.owner_id = $1))"#,
            owner_id,
            search,
            folder_id,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)?;

        Ok((items, total))
    }

    /// Datasets shared WITH the user (not owned), via a user- or group-principal
    /// share. `group_ids` are the user's active group ids. Optional `search` =
    /// case-insensitive name substring. Returns `(page, total)` where `total` is the
    /// count matching the SAME filters WITHOUT limit/offset.
    pub async fn list_shared(
        &self,
        user_id: Uuid,
        group_ids: &[Uuid],
        search: Option<&str>,
        page: i64,
        per_page: i64,
    ) -> Result<(Vec<Dataset>, i64), AppError> {
        // let-bound: the sqlx bind is borrowed across the statement (E0716 class).
        let json_group_ids = uuid_list_json(group_ids);
        let page_off = page_offset(page, per_page);
        let items = sqlx::query_as!(
            Dataset,
            r#"SELECT d.id as "id: Uuid", d.name, d.owner_id as "owner_id: Uuid", d.account_id as "account_id!: Uuid", d.datatype,
                      d.metadata as "metadata: serde_json::Value",
                      d.source, d.source_artifact_id as "source_artifact_id: Uuid", d.content_hash,
                      d.created_at as "created_at: DateTime<Utc>",
                      d.updated_at as "updated_at: DateTime<Utc>"
               FROM datasets d
               WHERE d.owner_id <> $1
                 AND ($3 IS NULL OR instr(lower(d.name), lower($3)) > 0)
                 AND EXISTS (
                   SELECT 1 FROM dataset_shares ds WHERE ds.dataset_id = d.id
                     AND ( (ds.principal_type = 'user'  AND ds.principal_id = $1)
                        OR (ds.principal_type = 'group' AND ds.principal_id IN
                              (SELECT unhex(j.value) FROM json_each($2) AS j)) ))
               ORDER BY d.created_at DESC
               LIMIT $4 OFFSET $5"#,
            user_id,
            json_group_ids,
            search,
            per_page,
            page_off,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;

        // let-bound: the sqlx bind is borrowed across the statement (E0716 class).
        let json_group_ids = uuid_list_json(group_ids);
        let total = sqlx::query_scalar!(
            r#"SELECT COUNT(*) as "count!"
               FROM datasets d
               WHERE d.owner_id <> $1
                 AND ($3 IS NULL OR instr(lower(d.name), lower($3)) > 0)
                 AND EXISTS (
                   SELECT 1 FROM dataset_shares ds WHERE ds.dataset_id = d.id
                     AND ( (ds.principal_type = 'user'  AND ds.principal_id = $1)
                        OR (ds.principal_type = 'group' AND ds.principal_id IN
                              (SELECT unhex(j.value) FROM json_each($2) AS j)) ))"#,
            user_id,
            json_group_ids,
            search,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)?;

        Ok((items, total))
    }

    /// "How many artifacts, and what is in there" for every dataset the caller can
    /// SEE (owner ∪ sharee) — ONE statement, no N+1 (DEC-1/DEC-2 of
    /// `docs/design/dataset-attach-readiness-and-preview.md`).
    ///
    /// Reads `artifacts` (a workstore table) from the dataset module, which the
    /// provenance repository already does for the same reason: the question is "what
    /// does THIS dataset hold", the join key is `artifacts.dataset_id` (indexed), and
    /// routing it through a second module's repository would buy a layer and cost the
    /// single statement.
    ///
    /// Population (DEC-7): the `usable_artifacts` view — `role='artifact'` (the
    /// promotable tier — `intermediate` is viz-only), `status='ready'` (the conformance
    /// gate has passed it), and not `hidden` (an alternate representation is deliberately
    /// out of listings). The view is the SINGLE definition of that population: the
    /// project-level `CatalogRepository::footprint` reads the same one, so the "what does
    /// this project hold" total and the per-dataset totals are over the same set by
    /// construction rather than by two filters agreeing today.
    ///
    /// Shape: rows are `(dataset_id, total_count, total_bytes, Option<group>)` ordered
    /// by dataset then by group rank, so the caller folds them with a single pass.
    ///
    /// EVERY covered dataset yields at least one row — a dataset holding no counted
    /// artifact yields ONE row with a `None` group and zero totals (DEC-3). That is
    /// what makes absence mean "outside the cap, we do not know" rather than the
    /// double duty of "outside the cap OR holds nothing", which would let a caller
    /// print a confident "no artifacts" about a dataset nobody looked at.
    ///
    /// `dataset_cap` bounds the datasets considered (newest first, matching the list
    /// endpoints' order) and `group_cap` the groups per dataset; the totals are
    /// computed over ALL of a dataset's counted artifacts, including those in groups
    /// past the cap.
    #[allow(clippy::type_complexity)]
    pub async fn artifact_summary_rows(
        &self,
        user_id: Uuid,
        group_ids: &[Uuid],
        dataset_cap: i64,
        group_cap: i64,
    ) -> Result<Vec<(Uuid, i64, i64, Option<DatasetArtifactGroup>)>, AppError> {
        // let-bound: the sqlx bind is borrowed across the statement (E0716 class).
        let json_group_ids = uuid_list_json(group_ids);
        let rows = sqlx::query!(
            r#"WITH visible AS (
                   SELECT d.id, d.created_at
                     FROM datasets d
                    -- H-1 (#147): the creator branch is conjoined with CURRENT
                    -- membership of the dataset's account, so a removed member's
                    -- created datasets stop appearing in the artifact rollup that
                    -- backs the dataset list. Behaviour-preserving for every current
                    -- member (owner => member by construction) and for personal
                    -- accounts (sole member IS the owner).
                    WHERE (d.owner_id = $1
                           AND d.account_id IN (SELECT am.account_id
                                                  FROM account_members am
                                                 WHERE am.user_id = $1))
                       OR EXISTS (
                            SELECT 1 FROM dataset_shares ds
                             WHERE ds.dataset_id = d.id
                               AND ( (ds.principal_type = 'user'  AND ds.principal_id = $1)
                                  OR (ds.principal_type = 'group' AND ds.principal_id IN
                                        (SELECT unhex(j.value) FROM json_each($2) AS j)) ))
                    ORDER BY d.created_at DESC
                    LIMIT $3
               ),
               counted AS (
                   SELECT a.dataset_id, a.datatype, a.output_id, a.meta, a.structure,
                          a.logical_bytes, a.id, a.created_at
                     -- The POPULATION is the `usable_artifacts` view, not a predicate
                     -- written out here: it is the same definition the project-level
                     -- footprint reads, so the two totals cannot drift apart. See the
                     -- view's migration for why it is a view and not a constant.
                     FROM usable_artifacts a
                     JOIN visible v ON v.id = a.dataset_id
               ),
               grouped AS (
                   SELECT dataset_id, datatype,
                          COUNT(*) AS cnt,
                          -- SUM of INTEGER is INTEGER (i64) on SQLite; the PG
                          -- `::bigint` cast is gone and the wire model reads it
                          -- through the same `bytes?` projection. LOGICAL, not
                          -- stored: this total is displayed as the size of the
                          -- data. `SUM` skips NULLs, so an artifact with no
                          -- derivable size contributes nothing instead of a made-up 0.
                          SUM(logical_bytes) AS bytes,
                          -- The REPRESENTATIVE — the rule is stated in full on
                          -- `DatasetArtifactGroup`: best-DECLARED first, then most
                          -- RECENT, then a total order. It is deliberately no longer
                          -- `size_bytes DESC, id`. All three aggregates must keep the
                          -- IDENTICAL `ORDER BY`: the group ships one member's
                          -- declarations, and pairing one row's `meta` with another's
                          -- `structure` describes an artifact that does not exist.
                          --
                          -- SQLite port (DEC-12): `(ARRAY_AGG(x ORDER BY …))[1]` has
                          -- no SQLite form — it is `json_group_array(x ORDER BY …)`
                          -- + `json_extract(…, '$[0]')`. The PG `<> '{}'::jsonb`
                          -- comparisons become `jsonb(x) <> jsonb('{}')` (the DEC-8
                          -- canonical form for whitespace/number/escape — its ONLY
                          -- JSON comparison is against the `'{}'` literal, so the
                          -- key-order non-canonicalization measured at ITEM-11 is
                          -- not a hazard here; tied ranks fall through to
                          -- `created_at DESC` exactly as PG's jsonb-equality tie does).
                          json_extract(json_group_array(output_id ORDER BY jsonb(structure) <> jsonb('{}') DESC, jsonb(meta) <> jsonb('{}') DESC, created_at DESC, output_id, id), '$[0]') AS representative_output_id,
                          json_extract(json_group_array(meta      ORDER BY jsonb(structure) <> jsonb('{}') DESC, jsonb(meta) <> jsonb('{}') DESC, created_at DESC, output_id, id), '$[0]') AS representative_meta,
                          json_extract(json_group_array(structure ORDER BY jsonb(structure) <> jsonb('{}') DESC, jsonb(meta) <> jsonb('{}') DESC, created_at DESC, output_id, id), '$[0]') AS representative_structure
                     FROM counted
                    GROUP BY dataset_id, datatype
               ),
               ranked AS (
                   SELECT g.*,
                          ROW_NUMBER() OVER (PARTITION BY dataset_id ORDER BY cnt DESC, datatype) AS rn,
                          SUM(cnt)   OVER (PARTITION BY dataset_id) AS total_count,
                          SUM(bytes) OVER (PARTITION BY dataset_id) AS total_bytes
                     FROM grouped g
               )
               -- LEFT JOIN from `visible`, so a dataset holding nothing still yields a
               -- row (with a NULL group). See the doc comment: absence has to mean
               -- exactly one thing, and it means "not covered".
               SELECT v.id as "dataset_id!: Uuid",
                      COALESCE(r.total_count, 0) as "total_count!",
                      COALESCE(r.total_bytes, 0) as "total_bytes!",
                      r.datatype as "datatype?",
                      r.cnt as "cnt?",
                      r.bytes as "bytes?",
                      r.representative_output_id as "representative_output_id?: String",
                      r.representative_meta as "representative_meta?: serde_json::Value",
                      r.representative_structure as "representative_structure?: serde_json::Value"
                 FROM visible v
                 LEFT JOIN ranked r ON r.dataset_id = v.id AND r.rn <= $4
                ORDER BY v.id, r.rn"#,
            user_id,
            json_group_ids,
            dataset_cap,
            group_cap,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;

        Ok(rows
            .into_iter()
            .map(|r| {
                // All six group columns come from the same LEFT-JOINed row, so they are
                // present together or absent together; `datatype` decides.
                let group = r.datatype.map(|datatype| DatasetArtifactGroup {
                    datatype,
                    count: r.cnt.unwrap_or(0),
                    logical_bytes: r.bytes.unwrap_or(0),
                    representative_output_id: r.representative_output_id.unwrap_or_default(),
                    representative_meta: compact_declaration(
                        r.representative_meta
                            .as_ref()
                            .unwrap_or(&serde_json::Value::Null),
                    ),
                    representative_structure: compact_declaration(
                        r.representative_structure
                            .as_ref()
                            .unwrap_or(&serde_json::Value::Null),
                    ),
                });
                (r.dataset_id, r.total_count, r.total_bytes, group)
            })
            .collect())
    }

    /// Is the dataset visible to `user_id` (owner ∪ sharee)? The single
    /// visibility predicate — a foreign dataset reads as invisible → 404.
    pub async fn is_visible_to(
        &self,
        id: Uuid,
        user_id: Uuid,
        group_ids: &[Uuid],
    ) -> Result<bool, AppError> {
        // let-bound: the sqlx bind is borrowed across the statement (E0716 class).
        let json_group_ids = uuid_list_json(group_ids);
        sqlx::query_scalar!(
            // A3 (ITEM-3/DEC-9): visibility widens from owner ∪ sharee to ALSO admit
            // any member of the dataset's `account_id` (the account-membership union),
            // PRESERVING the orthogonal user/group share union. Behaviour-preserving
            // for personal accounts (the only member is the owner, caught by
            // `d.owner_id = $2`). Uses `idx_account_members_user`.
            //
            // H-1 (#147, disposition (c)): the standalone `d.owner_id = $2` disjunct
            // is GONE. It let a member removed from the dataset's account keep read
            // on every dataset they had created there, forever — removing an
            // `account_members` row changes neither `owner_id` (the creating member)
            // nor `account_id` (the tenant). Conjoining it with current membership
            // makes it a strict SUBSET of the role-agnostic membership union on the
            // next line, so it is deleted rather than left as a disjunct that can
            // never be the reason a row matches. NO legitimate access is lost: a
            // dataset's `owner_id` is a member of its `account_id` by construction
            // (create stamps the owner's personal account, `create_in_account` takes
            // the extractor-proven active account), so the only state this refuses is
            // `owner ∧ ¬member` — i.e. after a removal. The comment above still holds
            // for personal accounts, now via the membership union: their sole member
            // IS the owner (INV-11c).
            r#"SELECT EXISTS(
                 SELECT 1 FROM datasets d WHERE d.id = $1 AND (
                   d.account_id IN (SELECT am.account_id FROM account_members am
                                     WHERE am.user_id = $2)
                   OR EXISTS (
                     SELECT 1 FROM dataset_shares ds WHERE ds.dataset_id = d.id
                       AND ( (ds.principal_type = 'user'  AND ds.principal_id = $2)
                          OR (ds.principal_type = 'group' AND ds.principal_id IN (SELECT unhex(j.value) FROM json_each($3) AS j)) ))
                 )) as "e!: bool""#,
            id,
            user_id,
            json_group_ids,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// Resolve the acting user's authority over a dataset in ONE query: owner ∪
    /// `edit`-sharee ⇒ `CanEdit`; owner ∪ ANY sharee ⇒ at least `ViewOnly`;
    /// else/absent ⇒ `NotVisible`. Powers `require_can_edit` (mutations) while
    /// reads keep `is_visible_to`.
    pub async fn access(
        &self,
        id: Uuid,
        user_id: Uuid,
        group_ids: &[Uuid],
    ) -> Result<DatasetAccess, AppError> {
        // let-bound: the sqlx bind is borrowed across the statement (E0716 class).
        let json_group_ids = uuid_list_json(group_ids);
        let row = sqlx::query!(
            // A3 (ITEM-3/DEC-9/DEC-12): the account-membership union — any member of
            // the dataset's account is VISIBLE (Viewer floor); an account `admin`/
            // `owner` also CAN_EDIT (the dataset analog of the project account-role
            // floor). The orthogonal owner ∪ share unions are preserved. A bare
            // account `member` gets read-only (no edit) — the safe direction.
            // Behaviour-preserving for personal accounts (single member = the owner).
            //
            // H-1 (#147, disposition (c)): creator-ownership no longer bypasses
            // current membership. The TWO arms need two different spellings and they
            // are NOT interchangeable:
            //   `visible!`  — its membership union is role-AGNOSTIC and parameterized
            //                 on the same `$2`, so `owner ∧ member` is a strict subset
            //                 of it and the owner disjunct is deleted outright (same
            //                 admitted set, no dead SQL). Mirrors `is_visible_to`.
            //   `can_edit!` — its membership union is RESTRICTED to `admin`/`owner`,
            //                 so deleting the owner disjunct would strip edit from a
            //                 bare account `member` who CREATED the dataset — a
            //                 legitimate, current user. It is conjoined with
            //                 (role-agnostic) membership instead.
            r#"SELECT
                 (d.account_id IN (SELECT am.account_id FROM account_members am
                                    WHERE am.user_id = $2)
                  OR EXISTS (
                    SELECT 1 FROM dataset_shares ds WHERE ds.dataset_id = d.id
                      AND ( (ds.principal_type = 'user'  AND ds.principal_id = $2)
                         OR (ds.principal_type = 'group' AND ds.principal_id IN (SELECT unhex(j.value) FROM json_each($3) AS j)) ))
                 ) AS "visible!: bool",
                 ((d.owner_id = $2
                   AND d.account_id IN (SELECT am.account_id FROM account_members am
                                         WHERE am.user_id = $2))
                  OR d.account_id IN (SELECT am.account_id FROM account_members am
                                       WHERE am.user_id = $2 AND am.role IN ('admin','owner'))
                  OR EXISTS (
                    SELECT 1 FROM dataset_shares ds WHERE ds.dataset_id = d.id
                      AND ds.role = 'edit'
                      AND ( (ds.principal_type = 'user'  AND ds.principal_id = $2)
                         OR (ds.principal_type = 'group' AND ds.principal_id IN (SELECT unhex(j.value) FROM json_each($3) AS j)) ))
                 ) AS "can_edit!: bool"
               FROM datasets d WHERE d.id = $1"#,
            id,
            user_id,
            json_group_ids,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(match row {
            Some(r) if r.can_edit => DatasetAccess::CanEdit,
            Some(r) if r.visible => DatasetAccess::ViewOnly,
            _ => DatasetAccess::NotVisible,
        })
    }

    /// Mutation authority gate (ITEM-2 role enforcement): `Ok(())` for owner ∪
    /// `edit`-sharee; a `view`-only sharee → **403** (visible but not an editor);
    /// an invisible/absent dataset → **404** (no existence oracle). Every dataset
    /// MUTATION + `POST /datasets/{id}/process` resolves through this; reads keep
    /// `is_visible_to`.
    pub async fn require_can_edit(
        &self,
        id: Uuid,
        user_id: Uuid,
        group_ids: &[Uuid],
    ) -> Result<(), AppError> {
        match self.access(id, user_id, group_ids).await? {
            DatasetAccess::CanEdit => Ok(()),
            DatasetAccess::ViewOnly => Err(AppError::forbidden(
                "FORBIDDEN",
                "You do not have edit access to this dataset",
            )),
            DatasetAccess::NotVisible => Err(AppError::not_found("Dataset")),
        }
    }

    /// Which of `ids` the caller may EDIT — the batched form of [`Self::access`]'s
    /// `can_edit` arm, for list paths that must grade a whole page (the redaction in
    /// `routes::enrich_items`) without an `access()` per row.
    ///
    /// The predicate is byte-for-byte the `can_edit` expression in [`Self::access`],
    /// deliberately: `799d0cf3`'s second finding was a hand-copied share predicate
    /// that had drifted from its original, so `editable_subset_matches_access` in the
    /// integration suite asserts the two agree per role rather than trusting a reader
    /// to keep them in step.
    pub async fn editable_subset(
        &self,
        ids: &[Uuid],
        user_id: Uuid,
        group_ids: &[Uuid],
    ) -> Result<std::collections::HashSet<Uuid>, AppError> {
        // let-bound: the sqlx bind is borrowed across the statement (E0716 class).
        let json_ids = uuid_list_json(ids);
        let json_group_ids = uuid_list_json(group_ids);
        let rows = sqlx::query_scalar!(
            // A3 (ITEM-3): kept byte-for-byte aligned with the `can_edit` arm of
            // `access` (asserted by `editable_subset_matches_access`) — the SAME
            // account `admin`/`owner` union is added here.
            //
            // H-1 (#147): this is the FOURTH site of the removed-member hole, and the
            // spike's list does not name it — it was found by grepping `owner_id =`
            // across every authz predicate rather than by trusting that list. It
            // carries the same conjoined-membership owner branch as `access`'s
            // `can_edit` arm, byte-for-byte, or `editable_subset_matches_access`
            // becomes false for exactly the removed-owner principal.
            r#"SELECT d.id as "id!: Uuid" FROM datasets d
               WHERE d.id IN (SELECT unhex(j.value) FROM json_each($1) AS j)
                 AND ((d.owner_id = $2
                       AND d.account_id IN (SELECT am.account_id FROM account_members am
                                             WHERE am.user_id = $2))
                  OR d.account_id IN (SELECT am.account_id FROM account_members am
                                       WHERE am.user_id = $2 AND am.role IN ('admin','owner'))
                  OR EXISTS (
                    SELECT 1 FROM dataset_shares ds WHERE ds.dataset_id = d.id
                      AND ds.role = 'edit'
                      AND ( (ds.principal_type = 'user'  AND ds.principal_id = $2)
                         OR (ds.principal_type = 'group' AND ds.principal_id IN (SELECT unhex(j.value) FROM json_each($3) AS j)) ))
                 )"#,
            json_ids,
            user_id,
            json_group_ids,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(rows.into_iter().collect())
    }

    /// Is `user_id` the dataset's CURRENT owner — i.e. its creator AND still a
    /// member of its account? The shared predicate the owner-only dataset handler
    /// gates call — and, since it is `pub`, whatever else calls it; grep for callers
    /// rather than trusting a list here (one of them is `jobs::authz`, which uses it
    /// to decide who may STOP a dataset-scoped job, and is easy to miss).
    ///
    /// The same `owner_id = $n AND account_id IN (…)` conjunction is hand-copied into
    /// several predicates in this file. **This doc does not tell you which, or how
    /// many — grep for it.**
    ///
    /// That refusal is the correction, not laziness. Five successive revisions of
    /// this comment tried to state the set and each was wrong in a new way, each
    /// caught by a different blind audit round: "every owner-only dataset gate", then
    /// a three-item list with a wrong reason attached, then an exact count that was
    /// short by four, then — after all that — a sentence claiming the unlisted copies
    /// were held by nothing, which was false too. On this branch a claim of that
    /// shape (`revoke_share` is "the ONE project mutation…") concealed a live
    /// security bug from four audit rounds, so this is a security property of the
    /// comment, not a style preference.
    ///
    /// What is worth recording is not the set but the bindings, since a binding is
    /// what survives an edit. These pairs are held by a named test:
    ///
    /// * `delete` ⇔ this predicate — `is_current_owner_matches_delete` (TEST-34);
    /// * `editable_subset` ⇔ `access`'s `can_edit` arm — `editable_subset_matches_access`.
    ///
    /// And these copies have a behavioural test over them:
    ///
    /// * `add_to_folder`'s INSERT guard and its "already a member" fallback — TEST-30
    ///   exercises both paths;
    /// * `list_mine`'s page and total — TEST-7 asserts they agree;
    /// * `artifact_summary_rows`' `visible` CTE — TEST-8.
    ///
    /// Before editing any copy, grep for the conjunction and check whether the one
    /// you are touching appears above.
    pub async fn is_current_owner(&self, id: Uuid, user_id: Uuid) -> Result<bool, AppError> {
        sqlx::query_scalar!(
            r#"SELECT EXISTS(
                 SELECT 1 FROM datasets d
                  WHERE d.id = $1 AND d.owner_id = $2
                    AND d.account_id IN (SELECT am.account_id FROM account_members am
                                          WHERE am.user_id = $2)
               ) as "e!: bool""#,
            id,
            user_id,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    pub async fn owner_of(&self, id: Uuid) -> Result<Option<Uuid>, AppError> {
        let row = sqlx::query!("SELECT owner_id as \"owner_id: Uuid\" FROM datasets WHERE id = $1", id)
            .fetch_optional(&self.pool)
            .await
            .map_err(AppError::database_error)?;
        Ok(row.map(|r| r.owner_id))
    }

    /// Set a dataset's name by id. Authorization is the caller's
    /// `require_can_edit` gate (an `edit`-sharee is not the owner, so this is NOT
    /// owner-scoped). `None` = the dataset vanished between the gate and here.
    pub async fn set_name(&self, id: Uuid, name: &str) -> Result<Option<Dataset>, AppError> {
        sqlx::query_as!(
            Dataset,
            r#"UPDATE datasets SET name = $2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
               WHERE id = $1
               RETURNING id as "id: Uuid", name, owner_id as "owner_id: Uuid", account_id as "account_id!: Uuid", datatype,
                         metadata as "metadata: serde_json::Value",
                         source, source_artifact_id as "source_artifact_id: Uuid", content_hash,
                         created_at as "created_at: DateTime<Utc>",
                         updated_at as "updated_at: DateTime<Utc>""#,
            id,
            name,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// Overwrite a dataset's harvested `metadata` JSONB (ITEM-9 finalize hook).
    /// Called by the jobs ingest seam after a dataset-scoped converter run emits a
    /// `dataset-metadata` output (the harvested obs/var summary). NOT owner-scoped:
    /// the caller is the trusted run finalizer and the run is already dataset-scoped
    /// (there is no acting user at ingest time). `None` = the dataset vanished
    /// between the run finishing and ingest.
    pub async fn set_metadata(
        &self,
        id: Uuid,
        metadata: &serde_json::Value,
    ) -> Result<Option<Dataset>, AppError> {
        sqlx::query_as!(
            Dataset,
            r#"UPDATE datasets SET metadata = $2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
               WHERE id = $1
               RETURNING id as "id: Uuid", name, owner_id as "owner_id: Uuid", account_id as "account_id!: Uuid", datatype,
                         metadata as "metadata: serde_json::Value",
                         source, source_artifact_id as "source_artifact_id: Uuid", content_hash,
                         created_at as "created_at: DateTime<Utc>",
                         updated_at as "updated_at: DateTime<Utc>""#,
            id,
            metadata,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// Delete, owner-scoped. `false` = absent or not owned. Cascades
    /// `dataset_files`/`dataset_shares`/`project_datasets`/`dataset_folder_members`.
    pub async fn delete(&self, id: Uuid, owner_id: Uuid) -> Result<bool, AppError> {
        let res = sqlx::query!(
            // H-1 (#147): this SQL IS the authority for `DELETE /api/datasets/{id}`
            // (the handler passes `auth.user.id` straight in and maps a 0-row result
            // to 404), so an unconditional owner branch let a REMOVED member destroy
            // the organization's data. The creator branch is conjoined with current
            // membership; a still-current member who created the dataset — including
            // a bare `member`, and every personal-account user — deletes exactly as
            // before.
            "DELETE FROM datasets WHERE id = $1 AND owner_id = $2 \
             AND account_id IN (SELECT am.account_id FROM account_members am \
                                 WHERE am.user_id = $2)",
            id,
            owner_id,
        )
        .execute(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(res.rows_affected() > 0)
    }

    // ------------------------------- files -------------------------------

    /// Link one ziee-file file into a dataset at `ordinal` as a PRIMARY file
    /// (ITEM-9 back-compatible shim). Delegates to `link_file_with_role` with
    /// `role='primary'` + no `kind` — the pre-supporting-files behaviour.
    pub async fn link_file(
        &self,
        dataset_id: Uuid,
        file_id: Uuid,
        ordinal: i32,
    ) -> Result<(), AppError> {
        self.link_file_with_role(dataset_id, file_id, ordinal, "primary", None)
            .await
    }

    /// Link one ziee-file file into a dataset at `ordinal` with an explicit
    /// `role` (`primary`|`supporting`) + optional supporting `kind` (ITEM-9). A
    /// supporting file's `integration_status` starts NULL (the caller sets it to
    /// `pending` when it enqueues the kind-processor). An existing link is updated
    /// (ordinal/role/kind) on conflict.
    pub async fn link_file_with_role(
        &self,
        dataset_id: Uuid,
        file_id: Uuid,
        ordinal: i32,
        role: &str,
        kind: Option<&str>,
    ) -> Result<(), AppError> {
        sqlx::query!(
            "INSERT INTO dataset_files (dataset_id, file_id, ordinal, role, kind)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (dataset_id, file_id)
               DO UPDATE SET ordinal = EXCLUDED.ordinal,
                             role    = EXCLUDED.role,
                             kind    = EXCLUDED.kind",
            dataset_id,
            file_id,
            ordinal,
            role,
            kind,
        )
        .execute(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(())
    }

    /// Point a dataset at its PRIMARY processing (on-ingest convert / import) JOB
    /// so the dataset's processing status DERIVES from the job's live status — the
    /// same single-source-of-truth idiom as a supporting file's
    /// `integration_job_id`. Set best-effort by the upload / process path right
    /// after the import job is enqueued; a nonexistent dataset is a no-op.
    pub async fn set_processing_job(&self, dataset_id: Uuid, job_id: Uuid) -> Result<(), AppError> {
        sqlx::query!(
            "UPDATE datasets SET processing_job_id = $2 WHERE id = $1",
            dataset_id,
            job_id,
        )
        .execute(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(())
    }

    /// The raw processing-job `(status, error)` for each of `ids`, keyed by dataset
    /// id — DERIVED from `datasets.processing_job_id` via a LEFT JOIN (so a dataset
    /// with no job, or a pruned job, yields `(None, None)`). One batched query (no
    /// N+1) used to enrich the list + detail payloads; the raw job status is mapped
    /// to a display status by [`super::models::map_processing_status`]. A dataset id
    /// absent from the result (never seen) also reads as `(None, None)`.
    pub async fn processing_status_map(
        &self,
        ids: &[Uuid],
    ) -> Result<std::collections::HashMap<Uuid, (Option<String>, Option<String>)>, AppError> {
        // let-bound: the sqlx bind is borrowed across the statement (E0716 class).
        let json_ids = uuid_list_json(ids);
        let rows = sqlx::query!(
            r#"SELECT d.id as "id!: Uuid", j.status as "status?", j.error as "error?"
               FROM datasets d
               LEFT JOIN jobs j ON j.id = d.processing_job_id
               WHERE d.id IN (SELECT unhex(j.value) FROM json_each($1) AS j)"#,
            json_ids,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(rows
            .into_iter()
            .map(|r| (r.id, (r.status, r.error)))
            .collect())
    }

    /// Set a supporting file's `integration_status`
    /// (`pending`|`running`|`integrated`|`failed`) — the per-file mirror of its
    /// integrate (kind-processor) job (ITEM-11/20). Scoped to `(dataset_id, file_id)`;
    /// a no-op for a nonexistent link. Primary files never carry a status.
    pub async fn set_integration_status(
        &self,
        dataset_id: Uuid,
        file_id: Uuid,
        status: &str,
    ) -> Result<(), AppError> {
        sqlx::query!(
            "UPDATE dataset_files SET integration_status = $3
             WHERE dataset_id = $1 AND file_id = $2",
            dataset_id,
            file_id,
            status,
        )
        .execute(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(())
    }

    /// Point a supporting file at its integrate (kind-processor) JOB so
    /// [`list_files`](Self::list_files) DERIVES the per-file `integration_status`
    /// from the job's live status — the single source of truth (ITEM-11/20).
    /// Replaces the old `set_integration_status(_, _, "pending")` write: the status
    /// then tracks the job for success, direct failure, AND cascade-failure (the job
    /// row is failed) with no completion hook needed. Scoped to `(dataset_id,
    /// file_id)`; a no-op for a nonexistent link.
    pub async fn set_integration_job(
        &self,
        dataset_id: Uuid,
        file_id: Uuid,
        job_id: Uuid,
    ) -> Result<(), AppError> {
        sqlx::query!(
            "UPDATE dataset_files SET integration_job_id = $3
             WHERE dataset_id = $1 AND file_id = $2",
            dataset_id,
            file_id,
            job_id,
        )
        .execute(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(())
    }

    /// Persist a supporting file's integrate COVERAGE summary JSON
    /// (matched/total/…), captured by the integration-completion hook
    /// (`DatasetIntegrationSink`) when the integrate job finalizes. NOT owner-scoped
    /// (the trusted run finalizer; there is no acting user at finalize time). Scoped
    /// to `(dataset_id, file_id)`; a no-op for a nonexistent link.
    pub async fn set_integration_summary(
        &self,
        dataset_id: Uuid,
        file_id: Uuid,
        summary: Option<serde_json::Value>,
    ) -> Result<(), AppError> {
        sqlx::query!(
            "UPDATE dataset_files SET integration_summary = $3
             WHERE dataset_id = $1 AND file_id = $2",
            dataset_id,
            file_id,
            summary,
        )
        .execute(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(())
    }

    /// Count a dataset's SUPPORTING files (ITEM-14 cap check). Excludes primaries.
    pub async fn supporting_file_count(&self, dataset_id: Uuid) -> Result<i64, AppError> {
        sqlx::query_scalar!(
            r#"SELECT count(*) as "c!" FROM dataset_files
               WHERE dataset_id = $1 AND role = 'supporting'"#,
            dataset_id,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// One page of a dataset's linked files (§4). Detail-view / process / split
    /// callers request the full window `(1, MAX_PER_PAGE)` — a single-cell
    /// dataset is one-to-a-handful of files, so 500 is effectively unbounded for
    /// real data while still capping the select.
    ///
    /// A supporting file's `integration_status` is DERIVED from its integrate JOB
    /// (the single source of truth, ITEM-11/20) via the LEFT JOIN, OVERRIDING the
    /// stored column: no `integration_job_id` → the stored `integration_status`
    /// (legacy/fallback); `blocked`/`queued` → `pending`; `running` → `running`;
    /// `completed` → `integrated`; `failed`/`stopped` → `failed`. This makes the
    /// status correct on ANY refetch for success, direct failure, AND
    /// cascade-failure — no completion hook needed for status. Primary files carry
    /// no status. The coverage `integration_summary` still comes from the stored
    /// column (written by the completion hook).
    pub async fn list_files(
        &self,
        dataset_id: Uuid,
        page: i64,
        per_page: i64,
    ) -> Result<Vec<DatasetFile>, AppError> {
        // let-bound: the sqlx bind is borrowed across the statement (E0716 class).
        let page_off = page_offset(page, per_page);
        sqlx::query_as!(
            DatasetFile,
            r#"SELECT df.file_id as "file_id: Uuid", f.filename, f.file_size, df.ordinal as "ordinal: i32",
                      df.role, df.kind,
                      CASE
                        WHEN df.role <> 'supporting'      THEN NULL
                        WHEN df.integration_job_id IS NULL THEN df.integration_status
                        WHEN j.status IN ('blocked','queued') THEN 'pending'
                        WHEN j.status = 'running'          THEN 'running'
                        WHEN j.status = 'completed'        THEN 'integrated'
                        WHEN j.status IN ('failed','stopped') THEN 'failed'
                        ELSE df.integration_status
                      END as "integration_status?: String",
                      df.integration_summary as "integration_summary?: serde_json::Value"
               FROM dataset_files df
               JOIN files f ON f.id = df.file_id
               LEFT JOIN jobs j ON j.id = df.integration_job_id
               WHERE df.dataset_id = $1 ORDER BY df.ordinal, f.filename
               LIMIT $2 OFFSET $3"#,
            dataset_id,
            per_page,
            page_off,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    pub async fn file_count(&self, dataset_id: Uuid) -> Result<i64, AppError> {
        sqlx::query_scalar!(
            r#"SELECT count(*) as "c!" FROM dataset_files WHERE dataset_id = $1"#,
            dataset_id,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// Recompute + persist the dataset's merkle `content_hash` from its linked
    /// PRIMARY files' checksums. Supporting files are additive annotations and
    /// MUST NOT change the dataset's identity (DEC-10), so they are excluded here.
    /// Returns the new hash (`None` if any primary file lacks a checksum or the
    /// dataset has no primary files).
    pub async fn recompute_content_hash(
        &self,
        dataset_id: Uuid,
    ) -> Result<Option<String>, AppError> {
        let rows = sqlx::query!(
            r#"SELECT f.filename, f.checksum, f.file_size
               FROM dataset_files df JOIN files f ON f.id = df.file_id
               WHERE df.dataset_id = $1 AND df.role = 'primary'
               ORDER BY df.ordinal, f.filename"#,
            dataset_id,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;

        let mut files: Vec<(String, String, i64)> = Vec::with_capacity(rows.len());
        for r in rows {
            let Some(checksum) = r.checksum else {
                return Ok(None); // a file without a checksum → can't hash yet
            };
            files.push((r.filename, checksum, r.file_size));
        }
        let hash = dataset_content_hash(&files);
        if let Some(h) = &hash {
            sqlx::query!(
                "UPDATE datasets SET content_hash = $2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = $1",
                dataset_id,
                h,
            )
            .execute(&self.pool)
            .await
            .map_err(AppError::database_error)?;
        }
        Ok(hash)
    }

    // ------------------------------- shares -------------------------------

    pub async fn add_share(
        &self,
        dataset_id: Uuid,
        principal_type: &str,
        principal_id: Uuid,
        role: &str,
    ) -> Result<DatasetShare, AppError> {
        let id = Uuid::new_v4();
        sqlx::query_as!(
            DatasetShare,
            r#"INSERT INTO dataset_shares (id, dataset_id, principal_type, principal_id, role)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (dataset_id, principal_type, principal_id)
                 DO UPDATE SET role = EXCLUDED.role
               RETURNING id as "id: Uuid", dataset_id as "dataset_id: Uuid", principal_type, principal_id as "principal_id: Uuid", role,
                         created_at as "created_at: DateTime<Utc>""#,
            id,
            dataset_id,
            principal_type,
            principal_id,
            role,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    pub async fn remove_share(&self, dataset_id: Uuid, share_id: Uuid) -> Result<bool, AppError> {
        let res = sqlx::query!(
            "DELETE FROM dataset_shares WHERE id = $1 AND dataset_id = $2",
            share_id,
            dataset_id,
        )
        .execute(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(res.rows_affected() > 0)
    }

    pub async fn list_shares(
        &self,
        dataset_id: Uuid,
        page: i64,
        per_page: i64,
    ) -> Result<Vec<DatasetShare>, AppError> {
        // let-bound: the sqlx bind is borrowed across the statement (E0716 class).
        let page_off = page_offset(page, per_page);
        sqlx::query_as!(
            DatasetShare,
            r#"SELECT id as "id: Uuid", dataset_id as "dataset_id: Uuid", principal_type, principal_id as "principal_id: Uuid", role,
                      created_at as "created_at: DateTime<Utc>"
               FROM dataset_shares WHERE dataset_id = $1 ORDER BY created_at DESC
               LIMIT $2 OFFSET $3"#,
            dataset_id,
            per_page,
            page_off,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// Everyone who may currently see this dataset: the CURRENT members of its account
    /// ∪ its direct user-sharees ∪ the members of its ACTIVE shared groups. The set
    /// [`crate::modules::dataset::sync::dataset_audience`] fans sync frames to (#168),
    /// and the same set [`Self::is_visible_to`] admits, read from the other direction
    /// (given a dataset, who).
    ///
    /// The membership arm is what makes removal mean something here: `datasets.owner_id`
    /// is the creating member, `account_id` is the tenant, and deleting an
    /// `account_members` row changes neither — so an audience anchored on `owner_id`
    /// keeps addressing a removed member forever, which is the leak #168's comment
    /// names. The share arms are preserved verbatim (#172 stays open).
    ///
    /// This REPLACES `sharee_user_ids`, whose two share arms it carries character for
    /// character. That function was the SIXTH hand-copy of the group-share predicate and
    /// the one that still lacked the ACTIVE filter; `799d0cf3` collapsed five of these
    /// after finding `workstore::authz::require_dataset_read` resolved group shares
    /// through `user_groups` ALONE, so disabling a group revoked the dataset's endpoints
    /// and left its members reading the artifact bytes. Once #168 moved every audience
    /// here it had no caller left, and a `pub` "who can see this dataset" predicate with
    /// no membership arm sitting next to the correct one is precisely the drift hazard
    /// the rest of this file argues against — so it is deleted rather than kept. Its
    /// behavioural coverage lives on: `dataset::sharee_fanout_test::
    /// dataset_audience_resolves_owner_user_share_and_group_share` and
    /// `jobs::visibility_test::a_group_edit_share_grants_sight_and_deactivating_the_group_takes_it_back`
    /// both now run through this function. The DELIBERATE asymmetry with the job
    /// audience next door survives too: this one keeps `view` sharees (readers of a
    /// dataset are told when it changes — see `dataset/job_audience_test.rs`), where the
    /// job audience admits editors only.
    pub async fn audience_user_ids(&self, dataset_id: Uuid) -> Result<Vec<Uuid>, AppError> {
        let rows = sqlx::query_scalar!(
            r#"SELECT DISTINCT uid as "id!: Uuid" FROM (
                 SELECT am.user_id AS uid
                   FROM datasets d
                   JOIN account_members am ON am.account_id = d.account_id
                  WHERE d.id = $1
                 UNION
                 SELECT ds.principal_id
                   FROM dataset_shares ds
                  WHERE ds.dataset_id = $1 AND ds.principal_type = 'user'
                 UNION
                 SELECT ug.user_id
                   FROM dataset_shares ds
                   JOIN user_groups ug ON ug.group_id = ds.principal_id
                   JOIN groups g ON g.id = ug.group_id AND g.is_active
                  WHERE ds.dataset_id = $1 AND ds.principal_type = 'group'
               ) audience
               ORDER BY 1"#,
            dataset_id,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(rows)
    }

    // ------------------------------- folders -------------------------------

    pub async fn create_folder(
        &self,
        owner_id: Uuid,
        name: &str,
    ) -> Result<DatasetFolder, AppError> {
        let id = Uuid::new_v4();
        sqlx::query_as!(
            DatasetFolder,
            r#"INSERT INTO dataset_folders (id, owner_id, name) VALUES ($1, $2, $3)
               RETURNING id as "id: Uuid", owner_id as "owner_id: Uuid", name,
                         created_at as "created_at: DateTime<Utc>",
                         updated_at as "updated_at: DateTime<Utc>""#,
            id,
            owner_id,
            name,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    pub async fn get_folder(&self, id: Uuid) -> Result<Option<DatasetFolder>, AppError> {
        sqlx::query_as!(
            DatasetFolder,
            r#"SELECT id as "id: Uuid", owner_id as "owner_id: Uuid", name,
                      created_at as "created_at: DateTime<Utc>",
                      updated_at as "updated_at: DateTime<Utc>"
               FROM dataset_folders WHERE id = $1"#,
            id,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    pub async fn list_folders(
        &self,
        owner_id: Uuid,
        page: i64,
        per_page: i64,
    ) -> Result<Vec<DatasetFolder>, AppError> {
        // let-bound: the sqlx bind is borrowed across the statement (E0716 class).
        let page_off = page_offset(page, per_page);
        sqlx::query_as!(
            DatasetFolder,
            r#"SELECT id as "id: Uuid", owner_id as "owner_id: Uuid", name,
                      created_at as "created_at: DateTime<Utc>",
                      updated_at as "updated_at: DateTime<Utc>"
               FROM dataset_folders WHERE owner_id = $1 ORDER BY created_at DESC
               LIMIT $2 OFFSET $3"#,
            owner_id,
            per_page,
            page_off,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    pub async fn rename_folder(
        &self,
        id: Uuid,
        owner_id: Uuid,
        name: &str,
    ) -> Result<Option<DatasetFolder>, AppError> {
        sqlx::query_as!(
            DatasetFolder,
            r#"UPDATE dataset_folders SET name = $3, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
               WHERE id = $1 AND owner_id = $2
               RETURNING id as "id: Uuid", owner_id as "owner_id: Uuid", name,
                         created_at as "created_at: DateTime<Utc>",
                         updated_at as "updated_at: DateTime<Utc>""#,
            id,
            owner_id,
            name,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    pub async fn delete_folder(&self, id: Uuid, owner_id: Uuid) -> Result<bool, AppError> {
        let res = sqlx::query!(
            "DELETE FROM dataset_folders WHERE id = $1 AND owner_id = $2",
            id,
            owner_id,
        )
        .execute(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(res.rows_affected() > 0)
    }

    /// Add a dataset to a folder. Both must belong to `owner_id` (guarded here so
    /// a folder can't collect a foreign dataset). `false` = folder/dataset absent
    /// or not owned.
    pub async fn add_to_folder(
        &self,
        folder_id: Uuid,
        dataset_id: Uuid,
        owner_id: Uuid,
    ) -> Result<bool, AppError> {
        let res = sqlx::query!(
            r#"INSERT INTO dataset_folder_members (folder_id, dataset_id)
               SELECT $1, $2
               -- H-1 (#147): the dataset side of this guard admitted purely on
               -- `datasets.owner_id`, so a removed member could keep foldering (and
               -- thereby re-listing) the account's datasets. Conjoined with current
               -- membership; the FOLDER side is untouched (`dataset_folders` has no
               -- `account_id` — DEC-7).
               WHERE EXISTS (SELECT 1 FROM dataset_folders WHERE id = $1 AND owner_id = $3)
                 AND EXISTS (SELECT 1 FROM datasets d WHERE d.id = $2 AND d.owner_id = $3
                               AND d.account_id IN (SELECT am.account_id
                                                      FROM account_members am
                                                     WHERE am.user_id = $3))
               ON CONFLICT (folder_id, dataset_id) DO NOTHING"#,
            folder_id,
            dataset_id,
            owner_id,
        )
        .execute(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        // rows_affected 0 = already a member OR guard failed; treat "already a
        // member" as success by re-checking membership.
        if res.rows_affected() > 0 {
            return Ok(true);
        }
        let is_member = sqlx::query_scalar!(
            // H-1 (#147): the "already a member" fallback must carry the SAME
            // membership conjunct as the INSERT guard above. Without it the hardened
            // guard fails (0 rows), control falls through to here, and for a dataset
            // ALREADY in the folder a removed member gets `Ok(true)` — a false success
            // that contradicts `list_datasets_in_folder`, which no longer returns that
            // row, and that breaks this function's documented `false = not owned`
            // contract.
            r#"SELECT EXISTS(
                 SELECT 1 FROM dataset_folder_members m
                   JOIN dataset_folders fo ON fo.id = m.folder_id
                   JOIN datasets d ON d.id = m.dataset_id
                 WHERE m.folder_id = $1 AND m.dataset_id = $2 AND fo.owner_id = $3
                   AND d.owner_id = $3
                   AND d.account_id IN (SELECT am.account_id FROM account_members am
                                         WHERE am.user_id = $3)) as "e!: bool""#,
            folder_id,
            dataset_id,
            owner_id,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(is_member)
    }

    pub async fn remove_from_folder(
        &self,
        folder_id: Uuid,
        dataset_id: Uuid,
        owner_id: Uuid,
    ) -> Result<bool, AppError> {
        let res = sqlx::query!(
            // SQLite port (DEC-12/ITEM-18): `DELETE … USING` is not SQLite
            // grammar — the owner guard becomes an EXISTS on the folder. The
            // affected set is identical (only rows whose folder belongs to
            // `owner_id` are deleted) and the write lock is the statement's
            // own single-statement atomicity, exactly as the USING form.
            r#"DELETE FROM dataset_folder_members
               WHERE folder_id = $1 AND dataset_id = $2
                 AND EXISTS (SELECT 1 FROM dataset_folders fo
                              WHERE fo.id = dataset_folder_members.folder_id
                                AND fo.owner_id = $3)"#,
            folder_id,
            dataset_id,
            owner_id,
        )
        .execute(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(res.rows_affected() > 0)
    }

    /// The datasets in a folder (owner-scoped folder), one page (§4).
    pub async fn list_datasets_in_folder(
        &self,
        folder_id: Uuid,
        owner_id: Uuid,
        page: i64,
        per_page: i64,
    ) -> Result<Vec<Dataset>, AppError> {
        // let-bound: the sqlx bind is borrowed across the statement (E0716 class).
        let page_off = page_offset(page, per_page);
        sqlx::query_as!(
            Dataset,
            r#"SELECT d.id as "id: Uuid", d.name, d.owner_id as "owner_id: Uuid", d.account_id as "account_id!: Uuid", d.datatype,
                      d.metadata as "metadata: serde_json::Value",
                      d.source, d.source_artifact_id as "source_artifact_id: Uuid", d.content_hash,
                      d.created_at as "created_at: DateTime<Utc>",
                      d.updated_at as "updated_at: DateTime<Utc>"
               FROM datasets d
               JOIN dataset_folder_members m ON m.dataset_id = d.id
               JOIN dataset_folders fo ON fo.id = m.folder_id
               -- H-1 (#147): the predicate constrained only the FOLDER's owner —
               -- NOTHING constrained `d`, so a member removed from an account kept
               -- reading the full rows (name, account_id, datatype, metadata,
               -- content_hash) of every org dataset they had foldered. `list_mine`'s
               -- folder filter WAS conjoined; these two are siblings and must agree,
               -- or the listing contradicts the gate exactly as `list_mine`'s own
               -- comment warns. `dataset_folders` itself carries no `account_id`, so
               -- the folder-owner clause is left alone (DEC-7's reasoning).
               WHERE m.folder_id = $1 AND fo.owner_id = $2
                 AND d.account_id IN (SELECT am.account_id FROM account_members am
                                       WHERE am.user_id = $2)
               ORDER BY d.created_at DESC
               LIMIT $3 OFFSET $4"#,
            folder_id,
            owner_id,
            per_page,
            page_off,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)
    }
}

// =============================== unit tests (TEST-1) ===============================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::workstore::object_store::sha256_hex;

    // TEST-1: single-file content_hash IS the blob's sha256 (byte-preserving
    // promote relies on this identity), matching object_store::sha256_hex.
    #[test]
    fn content_hash_single_file_is_blob_hash() {
        let bytes = b"one dataset file";
        let hex = sha256_hex(bytes);
        let files = vec![("m.h5ad".to_string(), hex.clone(), bytes.len() as i64)];
        assert_eq!(dataset_content_hash(&files), Some(format!("sha256:{hex}")));
    }

    // TEST-1: multi-file content_hash is the (order-independent, member-sensitive)
    // merkle root — one clean identity for a trio.
    #[test]
    fn content_hash_multi_file_is_merkle_root() {
        let a = ("matrix.mtx".to_string(), sha256_hex(b"a"), 1);
        let b = ("barcodes.tsv".to_string(), sha256_hex(b"b"), 1);
        let c = ("features.tsv".to_string(), sha256_hex(b"c"), 1);

        let h1 = dataset_content_hash(&[a.clone(), b.clone(), c.clone()]).unwrap();
        // Order-independent.
        let h2 = dataset_content_hash(&[c.clone(), a.clone(), b.clone()]).unwrap();
        assert_eq!(h1, h2, "merkle root is order-independent");
        assert!(h1.starts_with("sha256:"));
        // Member-sensitive: change one file's bytes → different root.
        let c2 = ("features.tsv".to_string(), sha256_hex(b"CHANGED"), 1);
        let h3 = dataset_content_hash(&[a, b, c2]).unwrap();
        assert_ne!(h1, h3, "changing a member changes the root");
    }

    #[test]
    fn content_hash_empty_is_none() {
        assert_eq!(dataset_content_hash(&[]), None);
    }

    // TEST-1: the one-logical-thing cardinality rule.
    #[test]
    fn cardinality_single_rejects_multi() {
        // Single-layout datatype: exactly one file.
        assert!(enforce_cardinality(Some(FileLayout::Single), 1).is_ok());
        assert!(enforce_cardinality(Some(FileLayout::Single), 2).is_err());
        // Multi-file layouts: one-or-many.
        assert!(enforce_cardinality(Some(FileLayout::Manifest), 3).is_ok());
        assert!(enforce_cardinality(Some(FileLayout::Prefix), 2).is_ok());
        // Unknown datatype is not blocked.
        assert!(enforce_cardinality(None, 5).is_ok());
        // Zero files is always rejected.
        assert!(enforce_cardinality(Some(FileLayout::Manifest), 0).is_err());
    }

    // TEST-1 (ITEM-4 grouping): default is one dataset per file; explicit groups
    // must partition all files exactly.
    #[test]
    fn upload_grouping_default_and_explicit() {
        // Default: two independent files → two datasets.
        assert_eq!(plan_upload_groups(2, None).unwrap(), vec![vec![0], vec![1]]);
        // Explicit: an mtx trio → one dataset.
        assert_eq!(
            plan_upload_groups(3, Some(&[vec![0, 1, 2]])).unwrap(),
            vec![vec![0, 1, 2]]
        );
        // Explicit mixed: [0,1] + [2] → two datasets.
        assert_eq!(
            plan_upload_groups(3, Some(&[vec![0, 1], vec![2]])).unwrap(),
            vec![vec![0, 1], vec![2]]
        );
        // Validation: a missing file index is rejected.
        assert!(plan_upload_groups(3, Some(&[vec![0, 1]])).is_err());
        // Validation: a duplicated index is rejected.
        assert!(plan_upload_groups(2, Some(&[vec![0, 0]])).is_err());
        // Validation: out-of-range.
        assert!(plan_upload_groups(1, Some(&[vec![5]])).is_err());
    }

    fn names(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    // TEST-16 shape (ITEM-28): the DECLARED-member group detector. The member names
    // are the caller's DATA (a contributed datatype's `input_requirements.members`),
    // so this test supplies them explicitly — the detector itself knows no filenames.
    // A complete group (compression-suffix-optional, path-stripped, case-insensitive,
    // `|`-alternation aware) → its indices in DECLARED order; anything ambiguous
    // (missing member / duplicate member) → None.
    #[test]
    fn detect_manifest_group_matches_declared_members() {
        // The DATA a contributed datatype declares. Nothing in the production path
        // holds these strings; a different domain declares entirely different ones.
        let members = names(&["matrix.mtx", "barcodes.tsv", "features.tsv|genes.tsv"]);
        // Compressed, any upload order → indices in DECLARED member order.
        assert_eq!(
            detect_manifest_group(
                &names(&["barcodes.tsv.gz", "matrix.mtx.gz", "features.tsv.gz"]),
                &members
            ),
            Some(vec![1, 0, 2])
        );
        // Uncompressed + the `|` alternation, with a path prefix + odd case.
        assert_eq!(
            detect_manifest_group(
                &names(&["s/MATRIX.MTX", "s/Barcodes.TSV", "s/genes.tsv"]),
                &members
            ),
            Some(vec![0, 1, 2])
        );
        // A compression suffix other than `.gz` is also generic transport, not domain.
        assert_eq!(
            detect_manifest_group(
                &names(&["matrix.mtx.zst", "barcodes.tsv.zst", "features.tsv.zst"]),
                &members
            ),
            Some(vec![0, 1, 2])
        );
        // A single member present is NOT a group (DEC-2 → separate datasets).
        assert_eq!(
            detect_manifest_group(&names(&["matrix.mtx.gz"]), &members),
            None
        );
        assert_eq!(
            detect_manifest_group(&names(&["matrix.mtx.gz", "notes.html"]), &members),
            None
        );
        // Missing one member (2 of 3) → None.
        assert_eq!(
            detect_manifest_group(&names(&["matrix.mtx", "barcodes.tsv"]), &members),
            None
        );
        // Ambiguous: two files claim the same member → don't guess.
        assert_eq!(
            detect_manifest_group(
                &names(&[
                    "a/matrix.mtx.gz",
                    "b/matrix.mtx.gz",
                    "barcodes.tsv.gz",
                    "features.tsv.gz"
                ]),
                &members,
            ),
            None
        );
        // Unrelated files → None.
        assert_eq!(
            detect_manifest_group(&names(&["a.h5ad", "b.csv"]), &members),
            None
        );
        // No declared members ⇒ no grouping vocabulary ⇒ never a group.
        assert_eq!(
            detect_manifest_group(&names(&["matrix.mtx", "barcodes.tsv"]), &[]),
            None
        );
    }

    // ITEM-15 / DEC-13 + ITEM-29: BOTH the group's type id AND its member filenames
    // are DATA, resolved from the `mtx-trio-target` capability carrier's
    // `input_requirements`. The production path holds neither literal.
    #[test]
    fn manifest_group_spec_resolves_id_and_members_from_the_registry() {
        use crate::modules::datatype::DatatypeRegistry;
        let reg = DatatypeRegistry::build_from_embedded().expect("merged registry builds");
        let specs = manifest_group_specs(Some(&reg));
        let spec = specs
            .first()
            .expect("a capability carrier declares members");
        assert_eq!(
            spec.datatype, "single-cell/matrix-mtx",
            "the capability carrier owns the id (DATA)"
        );
        assert!(
            spec.members.len() >= 2,
            "the carrier's input_requirements supply the member names (DATA), got {:?}",
            spec.members
        );
        // The members really do drive detection — feed the resolved DATA back in. A
        // declared member may be a `|`-ALTERNATION (`features.tsv|genes.tsv`), which is a
        // matching pattern, not a filename: synthesize the upload from its FIRST
        // alternative. (Appending `.gz` to the raw pattern produced the non-filename
        // `features.tsv|genes.tsv.gz`, which of course matches no member.)
        let uploaded: Vec<String> = spec
            .members
            .iter()
            .map(|m| format!("{}.gz", m.split('|').next().unwrap_or(m).trim()))
            .collect();
        assert!(
            detect_manifest_group(&uploaded, &spec.members).is_some(),
            "the registry-declared members detect their own group"
        );
        // No registry (direct-repo context) → None → the planner leaves files
        // one-per-file rather than mistyping.
        assert!(manifest_group_specs(None).is_empty());
    }

    // REGRESSION — the SHIPPED manifest must auto-group a Cell Ranger **2.x** trio.
    //
    // CR renamed the third member at 3.0: 2.x writes `genes.tsv`, 3.x+ writes
    // `features.tsv`. The core's ONE matching sugar (`matches_member`'s `|`
    // alternation) is how both spellings group — but the sugar lives in the CORE while
    // the alternation lives in the contributed DATA, so a manifest that declares only
    // `features.tsv` silently un-groups every 2.x upload and every existing test stays
    // green: they all pass their OWN hand-written member list (`"features.tsv|genes.tsv"`)
    // instead of the shipped one.
    //
    // So this test reads the REAL in-tree `packages/` tree — deliberately NOT
    // `build_from_embedded`, whose extract-on-first-use cache would answer with a
    // previously-extracted copy of the manifest (a seed edit without a version bump is
    // invisible to reconciliation) and make the test read stale DATA.
    //
    // RED ON REVERT: drop `|genes.tsv` from the manifest and the CR-2.x cases fail.
    #[test]
    fn the_shipped_manifest_groups_a_cell_ranger_2x_trio() {
        use crate::modules::datatype::DatatypeRegistry;

        // ITEM-69's rename moved the SOURCE tree `src-app/processors/` → `src-app/packages/`.
        // The runtime root (`<data_root>/processors/`) did NOT move, which is why the textual
        // sweep could not decide this one by spelling alone — and why a path ASSEMBLED from
        // segments (`join("..").join("processors")`) survived it: no `src-app/processors`
        // substring ever appears in the file.
        let packages = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("packages");
        assert!(
            packages.is_dir(),
            "the contributed source tree must resolve at {} — a path that resolves nowhere \
             makes every assertion below vacuous rather than red",
            packages.display()
        );
        let contributed =
            crate::modules::extensions::contributed_datatypes_from_embedded_in(&packages)
                .expect("the in-tree package tree scans");
        let reg = DatatypeRegistry::build_merged(contributed).expect("merged registry builds");
        // Resolved through the PRODUCTION path — the capability carrier's declared members.
        let specs = manifest_group_specs(Some(&reg));
        let spec = specs
            .first()
            .expect("a capability carrier declares members");

        for trio in [
            names(&["matrix.mtx", "barcodes.tsv", "genes.tsv"]), // Cell Ranger 2.x
            names(&["matrix.mtx.gz", "barcodes.tsv.gz", "genes.tsv.gz"]), // …gzipped
            names(&["matrix.mtx.gz", "barcodes.tsv.gz", "features.tsv.gz"]), // 3.x+ (control)
        ] {
            assert!(
                detect_manifest_group(&trio, &spec.members).is_some(),
                "the SHIPPED manifest must auto-group {trio:?}; declared members = {:?}",
                spec.members
            );
        }
    }

    // S11: a deployment may declare MORE THAN ONE multi-member auto-grouping
    // datatype. `manifest_group_spec` used to `return` the FIRST carrier and
    // `types_with_capability` SORTS, so the winner was whichever id sorted first
    // ALPHABETICALLY — capping every deployment at exactly one auto-grouping
    // datatype globally, with the same silent shape as S10 (an undetected group just
    // falls back to one-dataset-per-file: no error, no log).
    //
    // RED ON REVERT: take `groups[0]` instead of the first MATCHING carrier and the
    // alphabetically-last carrier's bundle stops grouping.
    #[test]
    fn a_second_declared_group_carrier_is_reachable_not_shadowed_alphabetically() {
        // Deliberately ordered so the SECOND carrier sorts LAST — the exact case a
        // first-carrier-wins resolver could never reach.
        let aaa = ManifestGroupSpec {
            datatype: "aaa-domain/trio".to_string(),
            members: names(&["matrix.mtx", "barcodes.tsv", "features.tsv"]),
        };
        let zzz = ManifestGroupSpec {
            datatype: "zzz-domain/bundle".to_string(),
            members: names(&["image.tif", "labels.png"]),
        };
        let carriers = vec![aaa.clone(), zzz.clone()];
        let bundle_group = vec![UploadGroup {
            indices: vec![0, 1],
            datatype: Some("zzz-domain/bundle".to_string()),
        }];

        // The alphabetically-LAST carrier's bundle groups, typed by ITS datatype.
        assert_eq!(
            plan_upload_groups_by_name(&names(&["image.tif", "labels.png"]), None, &carriers)
                .unwrap(),
            bundle_group,
            "the second carrier must be reachable"
        );

        // …and the first carrier still works (no regression), typed by ITS datatype.
        assert_eq!(
            plan_upload_groups_by_name(
                &names(&["matrix.mtx.gz", "barcodes.tsv.gz", "features.tsv.gz"]),
                None,
                &carriers,
            )
            .unwrap(),
            vec![UploadGroup {
                indices: vec![0, 1, 2],
                datatype: Some("aaa-domain/trio".to_string()),
            }]
        );

        // Carrier order is the registry's (id-sorted) order, so the pick is
        // deterministic: reversing the input does not change which carrier serves a
        // filename set only ONE of them matches.
        assert_eq!(
            plan_upload_groups_by_name(&names(&["image.tif", "labels.png"]), None, &[zzz, aaa],)
                .unwrap(),
            bundle_group,
        );
    }

    // TEST-16 shape (ITEM-28): the name-aware planner. A complete declared group
    // auto-groups into ONE fixed-type dataset; extra files stay one-per-file;
    // explicit grouping and the no-group default are unchanged (sniff-typed).
    #[test]
    fn plan_upload_groups_by_name_autogroups_declared_members() {
        // The caller resolves BOTH halves from the registry (DEC-13); here the pure
        // planner just receives them. Test-local literals (test scope is exempt from
        // the strip) stand in for the resolved DATA.
        let spec = ManifestGroupSpec {
            datatype: "single-cell/matrix-mtx".to_string(),
            members: names(&["matrix.mtx", "barcodes.tsv", "features.tsv|genes.tsv"]),
        };
        let dt = Some(spec.datatype.clone());
        // Bare complete group → ONE group (fixed type), nothing else.
        let planned = plan_upload_groups_by_name(
            &names(&["matrix.mtx.gz", "barcodes.tsv.gz", "features.tsv.gz"]),
            None,
            std::slice::from_ref(&spec),
        )
        .unwrap();
        assert_eq!(
            planned,
            vec![UploadGroup {
                indices: vec![0, 1, 2],
                datatype: dt.clone()
            }]
        );

        // Group + an unrelated file → the group + the unrelated file one-per-file.
        let planned = plan_upload_groups_by_name(
            &names(&[
                "notes.html",
                "matrix.mtx.gz",
                "barcodes.tsv.gz",
                "features.tsv.gz",
            ]),
            None,
            std::slice::from_ref(&spec),
        )
        .unwrap();
        assert_eq!(
            planned,
            vec![
                UploadGroup {
                    indices: vec![1, 2, 3],
                    datatype: dt.clone()
                },
                UploadGroup {
                    indices: vec![0],
                    datatype: None
                },
            ]
        );

        // A single member + an unrelated file → two separate sniff-typed datasets.
        let planned = plan_upload_groups_by_name(
            &names(&["matrix.mtx", "unrelated.h5ad"]),
            None,
            std::slice::from_ref(&spec),
        )
        .unwrap();
        assert_eq!(
            planned,
            vec![
                UploadGroup {
                    indices: vec![0],
                    datatype: None
                },
                UploadGroup {
                    indices: vec![1],
                    datatype: None
                },
            ]
        );

        // Explicit grouping still wins (honoured verbatim, sniff-typed).
        let planned = plan_upload_groups_by_name(
            &names(&["matrix.mtx.gz", "barcodes.tsv.gz", "features.tsv.gz"]),
            Some(&[vec![0, 1], vec![2]]),
            std::slice::from_ref(&spec),
        )
        .unwrap();
        assert_eq!(
            planned,
            vec![
                UploadGroup {
                    indices: vec![0, 1],
                    datatype: None
                },
                UploadGroup {
                    indices: vec![2],
                    datatype: None
                },
            ]
        );

        // NO resolved spec (registry absent) → no grouping vocabulary at all, so every
        // file stays its own sniff-typed dataset. This is a DELIBERATE contract change
        // from the baked-filename era, where the trio was detected without the registry
        // and then left untyped: with the member names now DATA, "no DATA" means "no
        // basis to group", which is the safe "don't guess" default (DEC-2) rather than
        // grouping files on a convention the core has no longer any right to know.
        let planned = plan_upload_groups_by_name(
            &names(&["matrix.mtx.gz", "barcodes.tsv.gz", "features.tsv.gz"]),
            None,
            &[],
        )
        .unwrap();
        assert_eq!(
            planned,
            vec![
                UploadGroup {
                    indices: vec![0],
                    datatype: None
                },
                UploadGroup {
                    indices: vec![1],
                    datatype: None
                },
                UploadGroup {
                    indices: vec![2],
                    datatype: None
                },
            ]
        );

        // Default (no group match, no explicit) → one dataset per file.
        let planned = plan_upload_groups_by_name(
            &names(&["a.h5ad", "b.h5ad"]),
            None,
            std::slice::from_ref(&spec),
        )
        .unwrap();
        assert_eq!(
            planned,
            vec![
                UploadGroup {
                    indices: vec![0],
                    datatype: None
                },
                UploadGroup {
                    indices: vec![1],
                    datatype: None
                },
            ]
        );
    }

    // ─────────────────────────── #160 · declared-depth membership ───────────────────────────

    /// The realistic Visium HD upload: a user picked the run folder, so every part
    /// carries its vendor-relative path. Three bins, each mirroring a full Visium
    /// `outs/` with identically-named files, plus the noise a real bundle carries.
    fn hd_upload_paths() -> Vec<String> {
        let mut v: Vec<String> = Vec::new();
        for bin in ["square_002um", "square_008um", "square_016um"] {
            v.push(format!("MyRun_outs/binned_outputs/{bin}/filtered_feature_bc_matrix.h5"));
            v.push(format!("MyRun_outs/binned_outputs/{bin}/spatial/tissue_positions.parquet"));
            v.push(format!("MyRun_outs/binned_outputs/{bin}/spatial/scalefactors_json.json"));
            v.push(format!("MyRun_outs/binned_outputs/{bin}/spatial/tissue_hires_image.png"));
            // Noise a real bundle carries and no member declares.
            v.push(format!("MyRun_outs/binned_outputs/{bin}/filtered_feature_bc_matrix/matrix.mtx.gz"));
            v.push(format!("MyRun_outs/binned_outputs/{bin}/analysis/clustering/graphclust/clusters.csv"));
        }
        v.push("MyRun_outs/web_summary.html".into());
        v.push("MyRun_outs/barcode_mappings.parquet".into());
        v
    }

    /// The twelve declared members, in declaration order. These are DATA in
    /// `spatial-types/manifest.yaml`; spelled here so the unit test is independent of
    /// the registry (the registry-resolved form is asserted by TEST-3 below).
    fn hd_members() -> Vec<String> {
        let mut v = Vec::new();
        for bin in ["square_002um", "square_008um", "square_016um"] {
            v.push(format!("{bin}/filtered_feature_bc_matrix.h5"));
            v.push(format!("{bin}/spatial/tissue_positions.parquet"));
            v.push(format!("{bin}/spatial/scalefactors_json.json"));
            v.push(format!("{bin}/spatial/tissue_hires_image.png"));
        }
        v
    }

    /// TEST-8 — the segment normalizer and the depth-anchored matcher, directly.
    #[test]
    fn member_path_segments_and_depth_anchored_matching() {
        // Both separators; empty segments dropped; per-segment lowercase; ONE
        // compression suffix, from the LAST segment only.
        assert_eq!(member_path_segments("A.GZ/b.tsv.gz"), vec!["a.gz", "b.tsv"]);
        assert_eq!(member_path_segments("a\\B\\c.MTX"), vec!["a", "b", "c.mtx"]);
        assert_eq!(member_path_segments("//x//y.h5"), vec!["x", "y.h5"]);
        // A name ENDING in a separator names a directory, and yields nothing — the
        // shipped normalizer's verdict for `outs/counts.h5/` was "matches nothing" and it
        // still is. Dropping the trailing empty segment instead would both revive that
        // name and strip a compression suffix off a DIRECTORY.
        assert!(member_path_segments("//x//y.h5//").is_empty());
        assert!(member_path_segments("archive.gz/").is_empty());
        assert!(!matches_member("outs/counts.h5/", "counts.h5"));
        assert!(!matches_member("archive.gz/", "archive"));
        assert_eq!(member_path_segments("bare.h5"), vec!["bare.h5"]);
        // Only ONE suffix comes off, exactly as before.
        assert_eq!(member_path_segments("a.tar.gz"), vec!["a.tar"]);

        // K = 1 — the pre-#160 behaviour, preserved: matches anywhere.
        assert!(matches_member("outs/deep/er/matrix.mtx.gz", "matrix.mtx"));
        assert!(matches_member("matrix.mtx", "matrix.mtx"));
        // K = 2 — anchored at the SUFFIX, so the run-root name is irrelevant…
        assert!(matches_member(
            "whatever_the_user_called_it/binned_outputs/square_008um/filtered_feature_bc_matrix.h5",
            "square_008um/filtered_feature_bc_matrix.h5"
        ));
        // …and a SIBLING bin does not match.
        assert!(!matches_member(
            "outs/binned_outputs/square_002um/filtered_feature_bc_matrix.h5",
            "square_008um/filtered_feature_bc_matrix.h5"
        ));
        // K = 3.
        assert!(matches_member(
            "o/binned_outputs/square_016um/spatial/tissue_positions.parquet",
            "square_016um/spatial/tissue_positions.parquet"
        ));
        assert!(!matches_member(
            "o/binned_outputs/square_016um/tissue_positions.parquet",
            "square_016um/spatial/tissue_positions.parquet"
        ));
        // Fewer segments than the member declares → no match, never a partial one.
        assert!(!matches_member(
            "filtered_feature_bc_matrix.h5",
            "square_002um/filtered_feature_bc_matrix.h5"
        ));
        // A `|`-alternation whose alternatives differ in DEPTH: each carries its own.
        let alt = "tissue_positions.csv|spatial/tissue_positions.parquet";
        assert!(matches_member("outs/spatial/tissue_positions.csv", alt));
        assert!(matches_member("outs/spatial/tissue_positions.parquet", alt));
        assert!(!matches_member("outs/tissue_positions.parquet", alt));
        // An empty / separator-only declaration matches nothing (never everything).
        assert!(!matches_member("anything.h5", "/"));
        assert!(!matches_member("anything.h5", ""));
        // A relative-path escape is DATA here, not a path: it segments like anything else
        // and matches only what it literally spells. Nothing in this function opens a file.
        assert_eq!(
            member_path_segments("../../etc/passwd"),
            vec!["..", "..", "etc", "passwd"]
        );
        assert!(matches_member("../../etc/passwd", "passwd"));
        assert!(!matches_member("../../etc/passwd", "etc/shadow"));
        assert!(!matches_member("passwd", "../passwd"));
    }

    /// TEST-22 — the committed case table, from the side that OWNS the rule.
    ///
    /// `member_match_cases.json` is the one authority the Rust core, the TypeScript
    /// upload-wizard mirror and a contributed package's Python mirror all answer to. A
    /// mirror that drifts WIDER promises an upload the server refuses; one that drifts
    /// NARROWER silently blocks a valid upload in the panel with no server-side signal.
    /// This half asserts the CORE agrees with the table; `memberMatch.test.ts` asserts the
    /// mirror does, over the same file.
    #[test]
    fn the_matcher_agrees_with_the_committed_case_table() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/modules/dataset/member_match_cases.json"
        );
        let raw = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("read {path}: {e}"));
        let doc: serde_json::Value = serde_json::from_str(&raw).expect("the table is valid JSON");
        let cases = doc["cases"].as_array().expect("`cases` is an array");
        assert!(
            cases.len() >= 20,
            "the case table holds {} row(s) — it collapsed and this test was about to pass \
             having asserted almost nothing",
            cases.len()
        );
        // Both verdicts must be REPRESENTED, or "they all agree" is satisfied by a table
        // of one answer and a predicate that always gives it.
        let positives = cases.iter().filter(|c| c["matches"] == true).count();
        assert!(positives >= 5 && cases.len() - positives >= 5, "{positives} positive(s)");

        let mut wrong: Vec<String> = Vec::new();
        for case in cases {
            let file = case["file"].as_str().expect("`file`");
            let member = case["member"].as_str().expect("`member`");
            let want = case["matches"].as_bool().expect("`matches`");
            let why = case["why"].as_str().unwrap_or("");
            if matches_member(file, member) != want {
                wrong.push(format!("{file:?} vs {member:?} should be {want} ({why})"));
            }
        }
        assert!(
            wrong.is_empty(),
            "the core disagrees with the committed case table:\n{}",
            wrong.join("\n")
        );

        // ── the GROUP half: the whole member set against a whole upload ──────────
        // The pair cases above pin only the PREDICATE. The DECISION is where the
        // one-bundle-root rule lives, and a mirror that implements only the predicate is
        // silently WIDER than the core exactly there — which is what happened.
        let groups = doc["groups"].as_array().expect("`groups` is an array");
        assert!(
            groups.len() >= 8,
            "the group table holds {} row(s) — it collapsed",
            groups.len()
        );
        let grouped_rows = groups.iter().filter(|g| g["grouped"] == true).count();
        assert!(
            grouped_rows >= 3 && groups.len() - grouped_rows >= 3,
            "both verdicts must be represented: {grouped_rows} grouped"
        );
        let mut wrong_groups: Vec<String> = Vec::new();
        for case in groups {
            let name = case["name"].as_str().unwrap_or("?");
            let files: Vec<String> = case["files"]
                .as_array()
                .expect("`files`")
                .iter()
                .map(|f| f.as_str().expect("file").to_string())
                .collect();
            let members: Vec<String> = case["members"]
                .as_array()
                .expect("`members`")
                .iter()
                .map(|m| m.as_str().expect("member").to_string())
                .collect();
            let want = case["grouped"].as_bool().expect("`grouped`");
            match (explain_manifest_group(&files, &members), want) {
                (ManifestGroupOutcome::Grouped(_), true) => {}
                (ManifestGroupOutcome::Gap(ref gap), false) => {
                    // The KIND of gap is pinned too, or "it refused" would be satisfied by
                    // refusing for the wrong reason.
                    let kind = case["gap"].as_str().unwrap_or("");
                    let present = match kind {
                        "scattered_roots" => !gap.scattered_roots.is_empty(),
                        "ambiguous" => !gap.ambiguous.is_empty(),
                        "missing" => !gap.missing.is_empty(),
                        "multi_claim" => !gap.multi_claim.is_empty(),
                        other => panic!("unknown gap kind {other:?} in case {name:?}"),
                    };
                    if !present {
                        wrong_groups.push(format!("{name}: refused, but not with `{kind}`: {gap:?}"));
                    }
                }
                (got, _) => wrong_groups.push(format!("{name}: expected grouped={want}, got {got:?}")),
            }
        }
        assert!(
            wrong_groups.is_empty(),
            "the core disagrees with the committed GROUP table:\n{}",
            wrong_groups.join("\n")
        );
    }

    /// TEST-2 `[acceptance]` `[invariant: INV-1]` — a Visium HD `binned_outputs/` upload
    /// groups, and each member binds to ITS OWN bin. The negative arm is the whole
    /// point: with the `square_NNNum/` prefixes stripped — i.e. the declaration as it
    /// stood before #160 — the very same upload returns `None`.
    #[test]
    fn a_visium_hd_binned_outputs_upload_groups_into_one_dataset() {
        let files = hd_upload_paths();
        let members = hd_members();

        let picked = detect_manifest_group(&files, &members)
            .expect("every declared HD member resolves to exactly one file");
        assert_eq!(picked.len(), 12, "one file per declared member");

        // The COUNT being right is not the claim; the BINDING being right is. Assert
        // that member i's chosen file carries member i's own bin segment — a matcher
        // that grouped twelve files from the wrong bins fails here.
        for (m, &fi) in members.iter().zip(picked.iter()) {
            let bin = m.split('/').next().unwrap();
            assert!(
                files[fi].contains(&format!("/{bin}/")),
                "member {m:?} bound to {:?}, which is not in {bin}",
                files[fi]
            );
            assert!(
                files[fi].ends_with(m.rsplit('/').next().unwrap()),
                "member {m:?} bound to {:?}",
                files[fi]
            );
        }

        // NEGATIVE ARM — the pre-#160 declaration (basenames only) over the same upload.
        let flat: Vec<String> = members
            .iter()
            .map(|m| m.rsplit('/').next().unwrap().to_string())
            .collect();
        assert_eq!(
            detect_manifest_group(&files, &flat),
            None,
            "with basename-only members every member has three candidates — this is the \
             shipped behaviour #160 exists to change, and it must still refuse rather than pick"
        );
    }

    /// TEST-23 — a DECLARED type is consulted before id-sort order.
    ///
    /// Carriers are id-sorted and the planner takes the first whose members match. That is
    /// arbitrary between two carriers that can both claim one upload, and the caller's
    /// stated type is not arbitrary. It is load-bearing rather than tidy: when the
    /// alphabetically-first carrier's members are a SUBSET of the declared one's, the
    /// planner used to group by the SUBSET — leaving the declared type's remaining members
    /// outside the group, each becoming its own dataset stamped with the declared id, with
    /// no refusal, because the declared type had in fact resolved.
    ///
    /// Synthetic carriers, because no two SHIPPED declarations overlap — which is exactly
    /// why this needs a test rather than a fixture.
    #[test]
    fn a_declared_carrier_is_tried_before_the_id_sorted_first_one() {
        let spec = |id: &str, members: &[&str]| ManifestGroupSpec {
            datatype: id.to_string(),
            members: names(members),
        };
        // `aaa/subset` sorts first and its members are a SUBSET of `zzz/whole`'s.
        let carriers = vec![
            spec("aaa/subset", &["a.csv", "b.csv"]),
            spec("zzz/whole", &["a.csv", "b.csv", "c.csv"]),
        ];
        let files = names(&["a.csv", "b.csv", "c.csv"]);

        // Undeclared: the id-sorted first carrier wins, and `c.csv` is left over. This is
        // the SHIPPED behaviour and it is asserted so the preference below is visible as a
        // difference rather than as a coincidence.
        let planned = plan_upload_groups_by_name(&files, None, &carriers).expect("plans");
        assert_eq!(planned[0].datatype.as_deref(), Some("aaa/subset"));
        assert_eq!(planned[0].indices.len(), 2);
        assert_eq!(planned.len(), 2, "`c.csv` is left outside the group");

        // Declared: the caller's type groups, and it covers everything it declares.
        let planned = plan_upload_groups_by_name_preferring(&files, None, &carriers, Some("zzz/whole"))
            .expect("plans");
        assert_eq!(planned.len(), 1, "one group, no leftovers: {planned:?}");
        assert_eq!(planned[0].datatype.as_deref(), Some("zzz/whole"));
        assert_eq!(planned[0].indices.len(), 3);

        // A preference naming a carrier that does NOT match changes nothing.
        let planned =
            plan_upload_groups_by_name_preferring(&files, None, &carriers, Some("nope/absent"))
                .expect("plans");
        assert_eq!(planned[0].datatype.as_deref(), Some("aaa/subset"));
        // …and the un-preferring wrapper is byte-compatible with the shipped contract.
        assert_eq!(
            plan_upload_groups_by_name(&files, None, &carriers).unwrap(),
            plan_upload_groups_by_name_preferring(&files, None, &carriers, None).unwrap()
        );
    }

    /// TEST-19 `[acceptance]` `[invariant: INV-3]` — members gathered from THREE DIFFERENT
    /// bundles do not become one dataset.
    ///
    /// Suffix anchoring is what lets a member ignore the folder name the user chose, and
    /// on its own it also lets members be collected from different folders: each member
    /// still resolves to exactly ONE file, so nothing is "ambiguous" and the group forms.
    /// The resulting dataset's three resolutions would describe three different specimens
    /// — silently wrong data, produced by a 200. This is the case the whole one-dataset
    /// decision rests on NOT happening, so it is asserted rather than argued.
    #[test]
    fn members_gathered_from_different_bundles_are_refused_not_grouped() {
        let members = hd_members();

        // Each run contributes the four members of ONE bin. Every member has exactly one
        // candidate; the only thing wrong is WHERE they came from.
        let mut scattered: Vec<String> = Vec::new();
        for (run, bin) in [
            ("RunA_outs", "square_002um"),
            ("RunB_outs", "square_008um"),
            ("RunC_outs", "square_016um"),
        ] {
            for m in members.iter().filter(|m| m.starts_with(&format!("{bin}/"))) {
                scattered.push(format!("{run}/binned_outputs/{m}"));
            }
        }
        assert_eq!(scattered.len(), 12, "one file per member: {scattered:?}");

        let ManifestGroupOutcome::Gap(gap) = explain_manifest_group(&scattered, &members) else {
            panic!(
                "members from three different runs grouped into one dataset — the bundle \
                 that resulted would claim to be three resolutions of one specimen and be \
                 three different specimens: {scattered:?}"
            );
        };
        assert!(gap.ambiguous.is_empty(), "nothing is ambiguous here: {gap:?}");
        assert!(gap.missing.is_empty(), "nothing is missing here: {gap:?}");
        assert_eq!(gap.scattered_roots.len(), 12);
        // The message names the directories, so the user can see WHICH parts disagree —
        // in the CASE THE USER TYPED, not the lowercased form matching compares on.
        let why = gap.explain();
        for run in ["RunA_outs", "RunB_outs", "RunC_outs"] {
            assert!(why.contains(run), "the message names {run} verbatim: {why}");
        }
        assert!(
            !why.contains("runa_outs"),
            "the normalized (lowercased) form must not reach the user: {why}"
        );
        assert_eq!(detect_manifest_group(&scattered, &members), None);

        // The CONTROL that makes the above mean "different bundles" rather than "this
        // input never groups": the same twelve members under ONE root still group.
        assert!(
            detect_manifest_group(&hd_upload_paths(), &members).is_some(),
            "the one-root form of the same upload must still group, or the assertion above \
             is about something else"
        );

        // The roots must CHAIN, not be EQUAL, and that distinction has to be exercised or
        // `shares_one_bundle_root` could be `roots.all(|r| r == roots[0])` and every other
        // assertion here would still pass. It cannot: a loosely-declared member legitimately
        // sits DEEPER inside the same bundle than a member that names its own directory.
        //
        // `counts.h5` picked at `outs/sub/counts.h5` has root `["outs","sub"]`;
        // `sub2/positions.csv` at `outs/sub2/positions.csv` has root `["outs"]`. Nested, so
        // one bundle — and an equality rule would refuse it.
        let mixed_members = names(&["counts.h5", "sub2/positions.csv"]);
        assert!(
            detect_manifest_group(
                &names(&["outs/sub/counts.h5", "outs/sub2/positions.csv"]),
                &mixed_members
            )
            .is_some(),
            "a member sitting deeper inside the SAME bundle must not be refused — the roots \
             nest, and a rule demanding they be identical would reject a legitimate bundle"
        );
        // The equal-roots form of the same shape also groups (the common case).
        assert!(detect_manifest_group(
            &names(&["outs/counts.h5", "outs/sub2/positions.csv"]),
            &mixed_members
        )
        .is_some());
        // A single DEEP member is unconstrained, and that is the declaration's own reading:
        // `counts.h5` says it does not care where it sits, so with one path-carrying member
        // there is nothing for the root rule to compare it against. Stated here rather than
        // left to be discovered, because it is a real limit of the rule: a container with
        // exactly one deep member gets no cross-bundle protection.
        assert!(
            detect_manifest_group(
                &names(&["runA/counts.h5", "runB/sub2/positions.csv"]),
                &mixed_members
            )
            .is_some(),
            "one deep member cannot disagree with itself"
        );
        // With TWO deep members it can, and does — including under a COMMON PARENT, which
        // a rule comparing only the first segment would group.
        let two_deep = names(&["bin_a/counts.h5", "bin_b/positions.csv"]);
        assert_eq!(
            detect_manifest_group(
                &names(&["runA/bin_a/counts.h5", "runB/bin_b/positions.csv"]),
                &two_deep
            ),
            None
        );
        assert_eq!(
            detect_manifest_group(
                &names(&["shared/runA/bin_a/counts.h5", "shared/runB/bin_b/positions.csv"]),
                &two_deep
            ),
            None,
            "two sibling runs UNDER A COMMON PARENT are still two bundles — a rule that \
             compared only the first segment would group them"
        );
        // …and a BARE member beside them is not held to the bundle root, so a container
        // mixing depths is not refused for the wrong reason.
        let mixed_depths = names(&["params.json", "bin_a/counts.h5", "bin_b/positions.csv"]);
        assert!(
            detect_manifest_group(
                &names(&[
                    "run/meta/params.json",
                    "run/data/bin_a/counts.h5",
                    "run/data/bin_b/positions.csv",
                ]),
                &mixed_depths
            )
            .is_some(),
            "a bare member sitting in its own sub-directory of the SAME bundle must not be \
             refused — it declared that it does not care where it sits"
        );

        // And a BASENAME-only declaration is untouched by the rule: every container that
        // shipped before #160 declares bare basenames, and gathering those from different
        // directories is the behaviour the trio has always had.
        let trio = names(&["matrix.mtx", "barcodes.tsv", "features.tsv|genes.tsv"]);
        assert!(
            detect_manifest_group(
                &names(&["a/matrix.mtx", "b/barcodes.tsv", "c/features.tsv"]),
                &trio
            )
            .is_some(),
            "the root rule must apply ONLY to a declaration that carries path segments"
        );
    }

    /// TEST-6 `[acceptance]` `[invariant: INV-3]` — the explanation is an explanation,
    /// not a decision: every shape `explain_manifest_group` reports as a gap is still
    /// `None` from `detect_manifest_group`.
    #[test]
    fn an_unresolvable_group_is_explained_and_still_refused() {
        let files = hd_upload_paths();

        // AMBIGUOUS — the plain-Visium members (all K=1) over an HD upload. This is the
        // "quietly the 8 um bin" case: three candidates for one member.
        let plain = names(&[
            "filtered_feature_bc_matrix.h5",
            "tissue_positions.csv|tissue_positions_list.csv",
            "scalefactors_json.json",
            "tissue_hires_image.png",
        ]);
        let ManifestGroupOutcome::Gap(gap) = explain_manifest_group(&files, &plain) else {
            panic!("a plain-Visium declaration cannot resolve an HD upload");
        };
        assert!(
            gap.ambiguous
                .iter()
                .any(|(m, n)| m == "filtered_feature_bc_matrix.h5" && *n == 3),
            "the ambiguous member and its candidate count are named: {gap:?}"
        );
        assert!(
            gap.missing
                .iter()
                .any(|m| m.starts_with("tissue_positions.csv")),
            "HD writes .parquet positions, so the .csv member is MISSING and is also \
             reported — a message naming only the first problem sends the user to fix \
             the wrong thing: {gap:?}"
        );
        assert!(gap.explain().contains("filtered_feature_bc_matrix.h5"));
        assert_eq!(detect_manifest_group(&files, &plain), None);

        // MISSING — a partial HD upload (the 16 um bin absent).
        let partial: Vec<String> = files
            .iter()
            .filter(|f| !f.contains("square_016um"))
            .cloned()
            .collect();
        let ManifestGroupOutcome::Gap(gap) = explain_manifest_group(&partial, &hd_members())
        else {
            panic!("a bin-less upload cannot resolve");
        };
        assert_eq!(gap.ambiguous, vec![], "nothing is ambiguous here: {gap:?}");
        assert_eq!(
            gap.missing.len(),
            4,
            "exactly the four members of the absent bin are named: {gap:?}"
        );
        assert!(gap.missing.iter().all(|m| m.starts_with("square_016um/")));
        assert_eq!(detect_manifest_group(&partial, &hd_members()), None);

        // MULTI-CLAIM — one file satisfying two declared members is an ambiguous
        // DECLARATION, and is reported as such rather than silently assigned.
        let dup = names(&["matrix.mtx", "matrix.mtx|other.mtx"]);
        let ManifestGroupOutcome::Gap(gap) = explain_manifest_group(&names(&["matrix.mtx"]), &dup)
        else {
            panic!("one file claiming two members cannot resolve");
        };
        assert_eq!(gap.multi_claim.len(), 1, "{gap:?}");
        assert_eq!(gap.multi_claim[0].0, "matrix.mtx");
        assert_eq!(detect_manifest_group(&names(&["matrix.mtx"]), &dup), None);

        // An empty declaration is not a gap — it is nothing to detect.
        assert_eq!(
            explain_manifest_group(&files, &[]),
            ManifestGroupOutcome::Undeclared
        );
    }

    /// TEST-3 `[acceptance]` `[invariant: INV-2]` — the shipped depth-1 containers group
    /// EXACTLY as before, and the MEX basename collision that is the design's stated
    /// reason for declaring the `.h5` still refuses.
    ///
    /// The carriers are resolved through the PRODUCTION path (the real in-tree packages),
    /// and are selected by the SHAPE of their declaration — whether any member carries a
    /// path segment — never by a datatype id. Spelling a domain id here would be a leak
    /// the package's own guard catches, and it would be the wrong test anyway: this file's
    /// contract is that member names are the caller's DATA.
    #[test]
    fn the_shipped_depth_one_containers_are_unchanged_and_the_mex_collision_still_refuses() {
        use crate::modules::datatype::DatatypeRegistry;
        let packages = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("packages");
        assert!(packages.is_dir(), "{}", packages.display());
        let contributed =
            crate::modules::extensions::contributed_datatypes_from_embedded_in(&packages)
                .expect("the in-tree package tree scans");
        let reg = DatatypeRegistry::build_merged(contributed).expect("merged registry builds");
        let specs = manifest_group_specs(Some(&reg));
        assert!(!specs.is_empty(), "no carrier declares members — nothing to assert over");

        let has_depth = |s: &ManifestGroupSpec| s.members.iter().any(|m| m.contains('/'));
        let deep: Vec<&ManifestGroupSpec> = specs.iter().filter(|s| has_depth(s)).collect();
        let flat: Vec<&ManifestGroupSpec> = specs.iter().filter(|s| !has_depth(s)).collect();
        assert!(
            !flat.is_empty(),
            "every container shipped before #160 declares bare basenames; if none is left \
             the regression legs below are vacuous"
        );
        assert!(
            !deep.is_empty(),
            "NO contributed carrier declares a path-carrying member, so the depth rule is \
             dead code — the mechanism exists and nothing puts it on the runtime path"
        );

        let hd = hd_upload_paths();

        // ── the depth-carrying carrier resolves a real multi-directory bundle ───────
        assert!(
            deep.iter()
                .any(|s| detect_manifest_group(&hd, &s.members).is_some()),
            "no declared depth-carrying carrier resolves a Visium HD upload"
        );

        // ── and EVERY depth-1 carrier still REFUSES it, rather than taking one bin ──
        for s in &flat {
            assert_eq!(
                detect_manifest_group(&hd, &s.members),
                None,
                "the basename carrier `{}` resolved an HD upload — three identically-named \
                 candidates must stay a refusal, not become a pick",
                s.datatype
            );
        }

        // ── the shipped shapes, over member lists spelled as the caller's DATA ──────
        // (filenames, not datatype ids — the same convention the shipped tests use.)
        let trio = names(&["matrix.mtx", "barcodes.tsv", "features.tsv|genes.tsv"]);
        for files in [
            names(&["matrix.mtx", "barcodes.tsv", "genes.tsv"]),
            names(&["matrix.mtx.gz", "barcodes.tsv.gz", "features.tsv.gz"]),
            names(&[
                "outs/raw/matrix.mtx.gz",
                "outs/raw/barcodes.tsv.gz",
                "outs/raw/features.tsv.gz",
            ]),
        ] {
            assert!(
                detect_manifest_group(&files, &trio).is_some(),
                "the shipped trio must still group: {files:?}"
            );
        }
        let bundle = names(&[
            "filtered_feature_bc_matrix.h5",
            "tissue_positions.csv|tissue_positions_list.csv",
            "scalefactors_json.json",
            "tissue_hires_image.png",
        ]);
        let outs = names(&[
            "outs/filtered_feature_bc_matrix.h5",
            "outs/spatial/tissue_positions.csv",
            "outs/spatial/scalefactors_json.json",
            "outs/spatial/tissue_hires_image.png",
        ]);
        assert_eq!(
            detect_manifest_group(&outs, &bundle),
            Some(vec![0, 1, 2, 3]),
            "the four depth-1 members still match anywhere in the path"
        );
        // …and the Space Ranger <=1.x spelling still rides the `|` alternation.
        assert!(detect_manifest_group(
            &names(&[
                "filtered_feature_bc_matrix.h5",
                "tissue_positions_list.csv",
                "scalefactors_json.json",
                "tissue_hires_image.png",
            ]),
            &bundle
        )
        .is_some());

        // ── the MEX collision (design SS6.7's stated reason for declaring the `.h5`) ──
        let mex = names(&[
            "outs/filtered_feature_bc_matrix/matrix.mtx.gz",
            "outs/raw_feature_bc_matrix/matrix.mtx.gz",
            "outs/filtered_feature_bc_matrix/barcodes.tsv.gz",
            "outs/filtered_feature_bc_matrix/features.tsv.gz",
        ]);
        assert_eq!(
            detect_manifest_group(&mex, &trio),
            None,
            "two `matrix.mtx.gz` under different directories are still TWO candidates for \
             one depth-1 member — the depth rule must not have turned a K=1 member into a \
             full-path or parent-directory match"
        );
    }

    /// TEST-7 `[acceptance]` `[invariant: INV-4]` — the core learns no vendor layout.
    /// Negative: no vendor token in the dataset module's source. Positive: the rule
    /// works for a vendor NO manifest in this tree declares, so it is a general rule
    /// and not a shape fitted to 10x.
    #[test]
    fn the_matcher_is_generic_and_the_module_holds_no_vendor_token() {
        // The token list is the guard's teeth, so it is named once and self-checked below.
        // It covers the vendor's platform names, its directory conventions AND the member
        // FILENAMES a leak would most plausibly be spelled with — an earlier six-literal
        // list would have passed a `name.contains("tissue_positions")`.
        const VENDOR_TOKENS: [&str; 12] = [
            "square_0",
            "binned_outputs",
            "visium",
            "xenium",
            "spaceranger",
            "space ranger",
            "tissue_positions",
            "scalefactors",
            "feature_bc_matrix",
            "cellranger",
            "cell ranger",
            "10x",
        ];

        let module = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/modules/dataset");
        // RECURSIVE: a leak one directory down is still a leak, and a `read_dir` that sees
        // only the top level reports green over a sub-module it never opened.
        fn rs_files(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            for entry in std::fs::read_dir(dir).unwrap_or_else(|e| panic!("{}: {e}", dir.display()))
            {
                let path = entry.expect("readable entry").path();
                if path.is_dir() {
                    rs_files(&path, out);
                } else if path.extension().and_then(|s| s.to_str()) == Some("rs") {
                    out.push(path);
                }
            }
        }
        let mut sources = Vec::new();
        rs_files(&module, &mut sources);
        assert!(
            sources.len() >= 3,
            "the walk found {} source file(s) — it collapsed and was about to pass having \
             scanned almost nothing",
            sources.len()
        );
        // The floor above does NOT defend the property this walk added: the module holds
        // enough top-level files that a flat `read_dir` clears it comfortably. What
        // defends recursion is naming a file that only recursion can reach.
        let nested: Vec<&std::path::PathBuf> = sources
            .iter()
            .filter(|p| p.parent().and_then(|d| d.file_name()) != module.file_name())
            .collect();
        assert!(
            !nested.is_empty(),
            "the walk found NO file below the module's top level, so a non-recursive \
             `read_dir` would report the same green over a sub-module it never opened"
        );
        let mut offenders: Vec<String> = Vec::new();
        for path in sources {
            let src = std::fs::read_to_string(&path).expect("readable source");
            // The claim is about the module's PRODUCTION source. A `#[cfg(test)]` block
            // legitimately spells vendor names — the declared members are the CALLER's
            // data and a test that proves an HD upload groups must name one — so the
            // scan stops there. Everything the server actually runs is scanned.
            let production = match src.find("#[cfg(test)]") {
                Some(at) => &src[..at],
                None => &src[..],
            };
            for (n, line) in production.lines().enumerate() {
                let lower = line.to_ascii_lowercase();
                // `mtx-trio-target` is the CAPABILITY constant's shipped VALUE — the
                // seam's own legacy spelling, which the constant's doc-comment already
                // explains — and `matrix.mtx` appears only in tests as caller DATA.
                // A COMMENT may name the motivating vendor — that is how the shipped
                // `MANIFEST_GROUP_CAPABILITY` doc-comment already reads, and prose is not
                // behaviour. What may not appear is a vendor token in CODE: a literal, an
                // identifier or a match arm, i.e. the core deciding something per-vendor.
                let prose = lower.trim_start().starts_with("//");
                if prose || lower.contains("mtx-trio-target") {
                    continue;
                }
                for token in VENDOR_TOKENS {
                    if lower.contains(token) {
                        offenders.push(format!(
                            "{}:{}: {token} in {line:?}",
                            path.file_name().unwrap().to_string_lossy(),
                            n + 1
                        ));
                    }
                }
            }
        }
        assert!(
            offenders.is_empty(),
            "the core must learn no vendor layout — the declared member string carries \
             the depth, and a vendor literal here is the sixth enumeration #224 warns \
             about:\n{}",
            offenders.join("\n")
        );

        // The guard must FIRE. Without this, a token list that stopped matching — a typo,
        // a case change, an accidentally-emptied array — reports the same green as a clean
        // module, which is the failure mode this whole test exists to prevent.
        // PER TOKEN, not `any`: a single witness proves that ONE token still matches, and
        // a typo in the other eleven is then invisible. Each token gets its own planted
        // line, built from the token itself, and each must be caught by the same predicate
        // the scan above uses.
        for token in VENDOR_TOKENS {
            let planted = format!("    if name.contains(\"{token}\") {{ return true; }}");
            let lower = planted.to_ascii_lowercase();
            assert!(
                !lower.trim_start().starts_with("//"),
                "the witness must be CODE, or the comment exemption would swallow it"
            );
            assert!(
                VENDOR_TOKENS.iter().any(|t| lower.contains(t)),
                "the token {token:?} matches nothing in a line that leaks it, so the scan \
                 above cannot catch that spelling and its green means nothing"
            );
        }

        // POSITIVE control: an invented vendor with a two-level bundle no manifest here
        // declares. If the rule were shaped to 10x this would not work.
        let members = names(&[
            "plate_a/readout.csv",
            "plate_b/readout.csv",
            "run_manifest.json",
        ]);
        let files = names(&[
            "Experiment 7/plate_b/readout.csv",
            "Experiment 7/plate_a/readout.csv",
            "Experiment 7/run_manifest.json",
            "Experiment 7/notes.txt",
        ]);
        assert_eq!(detect_manifest_group(&files, &members), Some(vec![1, 0, 2]));
    }

    /// TEST-9 — the refusal-shaped legs of the SHIPPED detector, re-asserted verbatim
    /// after the delegation, so the contract change is proven to be none.
    #[test]
    fn the_shipped_detector_contract_is_unchanged_by_the_delegation() {
        let members = names(&["matrix.mtx", "barcodes.tsv", "features.tsv|genes.tsv"]);
        assert_eq!(
            detect_manifest_group(&names(&["barcodes.tsv.gz", "matrix.mtx.gz", "features.tsv.gz"]), &members),
            Some(vec![1, 0, 2])
        );
        // 1-of-3 and 2-of-3 → None.
        assert_eq!(detect_manifest_group(&names(&["matrix.mtx"]), &members), None);
        assert_eq!(
            detect_manifest_group(&names(&["matrix.mtx", "barcodes.tsv"]), &members),
            None
        );
        // Two files claiming one member → None.
        assert_eq!(
            detect_manifest_group(
                &names(&["a/matrix.mtx", "b/matrix.mtx", "barcodes.tsv", "genes.tsv"]),
                &members
            ),
            None
        );
        // Unrelated files → None; empty members → None.
        assert_eq!(detect_manifest_group(&names(&["a.h5ad", "b.h5ad"]), &members), None);
        assert_eq!(detect_manifest_group(&names(&["matrix.mtx"]), &[]), None);
        // Extra files alongside a complete group are IGNORED, not fatal.
        assert_eq!(
            detect_manifest_group(
                &names(&["matrix.mtx", "barcodes.tsv", "genes.tsv", "notes.html"]),
                &members
            ),
            Some(vec![0, 1, 2])
        );
    }
}
