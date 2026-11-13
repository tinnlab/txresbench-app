//! TEST-40 (ITEM-23 / ITEM-29) + WS-B + WS-D — the server-side domain surface, in
//! Rust, next to the wire contract it deliberately did not touch.
//!
//! ── FEAT/STRIP-SINGLE-CELL (this branch) ───────────────────────────────────
//! The seven single-cell modules were deleted, along with `build_helper/`,
//! the platform's package tree and data corpus, the removed server test trees (`dataset`, `datatype`,
//! `drafts`, `extensions`, `project`, `provenance`, `workstore`, `analysis`,
//! `geneset`, `model_coverage`, `tiledb_serve`, the trimmed `account`/`file`/
//! `jobs`/`sandbox`/`predicate_removed`/`sqlite` sets) and the `sdk/crates` the
//! single-cell platform needed. Every floor/ceiling/list in this file was
//! re-anchored on the CURRENT tree by emulating this file's own scanner (the
//! measurement and the constants are argued in each constant's own comment; the
//! derivation test, the cardinality ledger and the two project-wire tests were
//! deleted because their subjects are gone). The shared
//! `ui/scripts/domain-baseline.json` still holds entries for deleted files; the
//! JS side re-bases it in a separate step, so until then the STALE check names
//! those entries.
//!
//! ── WHAT WS-B CHANGED (DOMAIN_AUDIT §0, blind spot #3) ──────────────────────
//! This file used to scan **3 of 16 modules** (`sandbox`, `project`, `dataset`)
//! with a **3-word noun vocabulary** (`leiden`, `umap`, `CellSet`). The 2026-07-28
//! full-tree audit put ELEVEN HIGH findings in the server (S1-S11), and NINE of
//! them are in modules this test never opened: `workstore` (S2), `provenance`
//! (S3/S4/S5), `mcp` (S1), `jobs` (S7), `rootfs` (S8), `tiledb_serve` (S9/B3).
//! It reported green over all of them.
//!
//! ── WHAT WS-D CHANGES (the twin was STRICTLY NARROWER than its own twin) ─────
//! WS-C widened `ui/scripts/lint-no-domain-in-builtin.mjs` to 7 roots / 633 files
//! / 34 nouns + an acronym tier + a substring tier + a per-(file,token) COUNTS
//! ratchet, and recorded the resulting divergence as a KNOWN GAP in
//! `domain-baseline.json`'s README. A guard that is narrower than the one it
//! claims to mirror is a blind spot with a green light on it, so this round
//! closes every axis of that gap:
//!
//!   | axis                    | before WS-D                  | now                     |
//!   |-------------------------|------------------------------|-------------------------|
//!   | scan roots              | `server/src/modules/**` only | + `server/src/*.rs`,    |
//!   |                         |                              |   `build_helper/**`     |
//!   | nouns                   | 24                           | 34                      |
//!   | acronyms (`DE`/`QC`/…)  | absent                       | own case-sensitive tier |
//!   | substrings              | absent                       | `single-cell`, …        |
//!   | NON_DOMAIN_IDENTIFIERS  | 10                           | 27                      |
//!   | prose (comments)        | not scanned                  | own tier + own baseline |
//!   | tokenizer               | naive (a `//` inside a       | string-aware classifier |
//!   |                         | string blanked the line)     |                         |
//!   | ratchet                 | key PRESENCE                 | per-(file,token) COUNTS |
//!
//! ── WHAT WS-R3 CHANGES (the guard was REFUSING TO LOOK) ─────────────────────
//! An adversarial audit found the round-2 green was partly an artifact of what BOTH
//! guards declined to read. Four holes; all four closed on BOTH sides in the same
//! commit, because a twin that lags is a blind spot with a green light on it:
//!
//!   | axis                    | before WS-R3                 | now                     |
//!   |-------------------------|------------------------------|-------------------------|
//!   | `#[cfg(debug_assertions)]` | BLANKED before matching   | SCANNED                 |
//!   | file formats            | `.rs` only                   | + `.sql`/`.py`/`.json`/ |
//!   |                         |                              |   `.yaml` (root         |
//!   |                         |                              |   `server-data`)        |
//!   | nouns / acronyms        | 34 / 3                       | 38 / 4                  |
//!   | prose ratchet           | per-FILE TOTAL (fungible)    | per (file, TOKEN)       |
//!   | scan floors             | AT the measurement           | ≈2/3 margin             |
//!   | literal ceiling         | 0 (an artifact)              | 26, measured            |
//!
//! The `debug_assertions` row is the loudest. `workstore/data_api.rs` is almost
//! entirely written under that attribute — and it is a REAL surface, registering six
//! HTTP routes via `workstore/routes.rs:58,62,66,70,74,84` — so the baseline recorded
//! 104 prose hits and ZERO code hits for a file measuring ~398 raw vocabulary hits.
//! Un-blanking surfaces 243 code + 70 prose + 23 LITERAL hits there, including
//! `:551`'s literal mitochondrial and ribosomal GENE SYMBOLS.
//!
//! The prose row is the subtlest. A per-file TOTAL is decremented without inspecting
//! the token, so a file already in the ledger could absorb a brand-new leak of a
//! DIFFERENT token for free. Now it is per (file, token), like `code`.
//!
//! `#[cfg(test)]` STAYS blanked — a compiler-enforced, structural exemption — with its
//! cost measured and written down for the first time (633 code / 180 prose / 69 literal
//! hits) rather than assumed. See `cfg_block_spans`.
//!
//! The ratchet row is the load-bearing one. Presence-only means a file already in
//! the baseline can GROW new leaks invisibly: `criteria_script.rs` is baselined for
//! `cell`, so a commit taking it from 16 `cell` hits to 60 passed. It does not now.
//!
//! The tokenizer row was a live FAIL-OPEN, not a cosmetic difference: the old
//! `executable_code` treated any `//` as a line comment, so everything after a
//! `"https://…"` literal on the same line was blanked out of the scan.
//!
//! What this test holds:
//!
//!   1. the strip HAPPENED — no domain vocabulary outside the COMMITTED baseline
//!      (`ui/scripts/domain-baseline.json`, the same file the JS guard ratchets
//!      against, so the two enforcers cannot drift into disagreeing about what is
//!      permitted) and none of the baselined counts GREW;
//!   2. the scan is WIDE — positive floors per ROOT, on modules covered, on pairs
//!      and HITS actually matched, and on the prose tier, because "no domain
//!      vocabulary found" over three files reads exactly like compliance and did
//!      for a whole round;
//!   3. the WIRE contract is clean — `AdminProjectRow`'s `cell_count`/`gene_count`
//!      (DEC-M / W7) are GONE, asserted both in the source and on the wire.
//!
//! (3) was the inverse assertion for one round: the two fields were retained as a wire
//! contract while they were still on the schema. WS-H retired them (they had been dead
//! since DEC-1 pinned both to `0::bigint`, and the FE column was deleted in round 1), so
//! the pin flipped from "they must stay" to "they must not come back" — same reason,
//! executable rather than prose, and now with positive controls so neither half can pass
//! vacuously.

use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

// ════════════════════════════════════════════════════════════════════════════
//  VOCABULARY — kept in lockstep with `ui/scripts/lint-no-domain-in-builtin.mjs`
// ════════════════════════════════════════════════════════════════════════════

/// Datatype IDs that must not appear as a LITERAL. Matched only when QUOTE-DELIMITED on
/// both sides — the same boundary `lint-no-domain-in-builtin.mjs`'s `QUOTED_ID_RE` uses,
/// and the distinction is load-bearing rather than cosmetic:
///
///   `"metadata-column"`         an id literal — the app hardcoding one domain type
///   `"metadata-column-family"`  a CAPABILITY name — the mechanism by which the domain
///                               became DATA (`types_with_capability(..)` +
///                               `descendants_inclusive`), which is the ITEM-14/DEC-12
///                               fix, not the leak
///
/// A substring scan cannot tell those apart and flags the fix as the defect. It did,
/// on `sandbox/inputs.rs:325`, the first time this test ran.
///
/// WS-D: this is now exactly the JS guard's `QUOTED_ID_TOKENS` — the bare-word
/// members of `DATATYPE_IDS`. The slash ids (`single-cell/expression`, …) moved to
/// `SUBSTRING_TOKENS`, where the JS guard has always matched them, because a slash id
/// never occurs generically and quote-delimiting it misses a slash id path.
/// ── WS-R5 G2 — the vocabulary is DERIVED FROM THE MANIFESTS, on both sides ───────────
///
/// STRIP (this branch): the package tree no longer exists, so the derivation
/// below yields an EMPTY vocabulary (the read_dir failure path). The quoted-id
/// and quoted-title tiers are therefore empty, and the substring tier is
/// `SUBSTRING_PREFIXES` alone. That is the truth of this tree, not a shrunk
/// hand-list: there are no contributed datatype ids left to forbid. The
/// `CONTRIBUTED_DATATYPE_FLOOR` and its derivation test were deleted with the
/// subject they existed to guard.
fn contributed_datatypes() -> &'static Vec<(String, String)> {
    static CACHE: std::sync::OnceLock<Vec<(String, String)>> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| {
        let dir = src_app().join("packages");
        let mut pkgs: Vec<PathBuf> = match std::fs::read_dir(&dir) {
            Ok(rd) => rd
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect(),
            Err(_) => Vec::new(),
        };
        pkgs.sort();
        let mut out: Vec<(String, String)> = Vec::new();
        for pkg in pkgs {
            let Ok(src) = std::fs::read_to_string(pkg.join("manifest.yaml")) else {
                continue;
            };
            let mut in_datatypes = false;
            for raw in src.lines() {
                let trimmed = raw.trim_start();
                if trimmed.is_empty() || trimmed.starts_with('#') {
                    continue;
                }
                let indent = raw.len() - trimmed.len();
                if !in_datatypes {
                    if indent == 2 && trimmed == "datatypes:" {
                        in_datatypes = true;
                    }
                    continue;
                }
                if indent <= 2 {
                    in_datatypes = false;
                    continue;
                }
                if let Some(rest) = raw.strip_prefix("    - id: ") {
                    let id = rest
                        .trim()
                        .trim_matches(|c| c == '"' || c == '\'')
                        .to_string();
                    out.push((id, String::new()));
                } else if let Some(rest) = raw.strip_prefix("      title: ") {
                    if let Some(last) = out.last_mut() {
                        if last.1.is_empty() {
                            last.1 = rest
                                .trim()
                                .trim_matches(|c| c == '"' || c == '\'')
                                .to_string();
                        }
                    }
                }
            }
        }
        out
    })
}

/// Bare-word ids — matched ONLY when quote-delimited (see the doc above).
fn quoted_id_tokens() -> Vec<&'static str> {
    contributed_datatypes()
        .iter()
        .filter(|(id, _)| !id.contains('/'))
        .map(|(id, _)| id.as_str())
        .collect()
}

/// Their display titles — a hardcoded label like `"AnnData"` is a regression.
fn quoted_title_tokens() -> Vec<&'static str> {
    contributed_datatypes()
        .iter()
        .filter(|(_, t)| !t.is_empty())
        .map(|(_, t)| t.as_str())
        .collect()
}

/// Structural PATH prefixes — not datatype ids. Each SUBSUMES every id beneath it.
const SUBSTRING_PREFIXES: &[&str] = &["single-cell"];

/// Slash / compound tokens — they never occur in generic code, so they are matched as RAW
/// SUBSTRINGS with no boundary rule at all. `single-cell` (no slash) is what catches the
/// two real server hits the WS-C widening surfaced: the clap `about =` blurb in `main.rs`
/// and the baked recipe-path string of the old build helper.
///
/// WS-R5 G2 — the slash ids are DERIVED, minus anything a prefix already subsumes. The
/// subsumption filter is load-bearing rather than tidiness: substring tokens are matched
/// INDEPENDENTLY (unlike the nouns, which arbitrate longest-first), so listing
/// `single-cell/expression` alongside `single-cell` double-counts every site. What the
/// derivation ADDS is `geneset/collection`, `graph/attributed` and `de/result` — three
/// shipped ids that were matched by NOTHING: absent from the hand-list, excluded from
/// `quoted_id_tokens` by their slash, and not reachable by the `gene` noun either (the
/// lowercase `s` in `geneset` fails the right-hand letter boundary).
fn substring_tokens() -> Vec<&'static str> {
    let mut out: Vec<&'static str> = SUBSTRING_PREFIXES.to_vec();
    for (id, _) in contributed_datatypes() {
        if !id.contains('/') {
            continue;
        }
        if SUBSTRING_PREFIXES
            .iter()
            .any(|p| id.starts_with(&format!("{p}/")))
        {
            continue;
        }
        out.push(id.as_str());
    }
    out
}

/// The domain NOUN vocabulary — kept in lockstep with `DOMAIN_NOUNS` in
/// `ui/scripts/lint-no-domain-in-builtin.mjs` (34 tokens as of WS-C).
///
/// **LONGEST FIRST, and that ordering is load-bearing.** `match_nouns` tries the tokens
/// in array order at each byte and takes the FIRST whose text matches, mirroring the JS
/// regex alternation (which is sorted `b.length - a.length`). `cellranger` must win over
/// its own prefix `cell` so each site counts ONCE and is attributed to the most specific
/// token. `the_domain_token_scanner_actually_matches` asserts the ordering, so appending
/// a token to the end of this list fails the suite instead of silently mis-attributing.
///
/// The pre-WS-B list was `["leiden", "umap", "CellSet"]` — three words, none of which
/// appear in ANY of the eleven server findings. The WS-B list was the 24 below minus the
/// WS-C group; WS-C added the last ten because the widened scan set showed the tree
/// speaks a vocabulary the guard did not: `tiledbsoma` in particular was invisible to the
/// existing `soma` token, because the camel/letter left boundary refuses a lowercase
/// neighbour (`tiledb` + `soma`), and it is the single most common spelling of the store
/// API in this tree.
const DOMAIN_NOUNS: &[&str] = &[
    // 13
    "transcriptome",
    // 10
    "cellranger",
    "embeddings",
    "enrichment",
    "tiledbsoma",
    // 9
    "embedding",
    // 8
    "cell-set",
    "cell_set",
    "features",
    "barcodes",
    "pct_mito",
    "pct_ribo",
    // 7
    "cellset",
    "samples",
    "feature",
    "barcode",
    "anndata",
    // 6
    "leiden",
    "sample",
    "genome",
    "scanpy",
    "seurat",
    "GRCh38",
    "nCount",
    // 5
    "genes",
    "cells",
    "adata",
    "vis2D",
    "ident",
    // 4
    "gene",
    "umap",
    "cell",
    "h5ad",
    "soma",
    "h5mu",
    // 3
    "obs",
    "mtx",
    "10x",
];

/// WS-C/WS-D — SHORT ALL-CAPS ACRONYMS, matched CASE-SENSITIVELY with a NON-ALPHANUMERIC
/// boundary on both sides.
///
/// `DE` (differential expression), `QC` and `BAM` cannot join the tier above. Measured on
/// the widened scan set, case-insensitive + the letter/camel boundary gives `DE` **1575**
/// hits — `DERIVED`, `DESIGN`, `DEC-5`, `DEFAULT` — because an uppercase neighbour is
/// treated as a camel continuation. That is not a vocabulary, it is noise, and a noisy
/// guard gets narrowed. The stricter rule measures `DE 41 / QC 103 / BAM 6` tree-wide,
/// every sampled hit genuine.
///
/// **Measured server-side today: ZERO hits, in code AND in prose.** That is recorded
/// here on purpose — a tier with no live hit looks dead, and the next reader would delete
/// it. It is not dead: `the_domain_token_scanner_actually_matches` drives it directly,
/// and it exists so a `DE` table or a `BAM+bai` path landing in `server/**` tomorrow is
/// caught on arrival rather than after it has spread.
/// WS-R3 §3 adds `PBMC` — a short ALL-CAPS acronym, identical treatment for the identical
/// reason. Longest-first, like `DOMAIN_NOUNS`, because `match_acronyms` takes the first
/// token whose text matches.
const ACRONYM_NOUNS: &[&str] = &["PBMC", "BAM", "DE", "QC"];

/// LANGUAGE-LEVEL identifiers that merely CONTAIN a vocabulary noun and are not domain
/// references — DOMAIN_AUDIT §7's confirmed false-positive class (`std::marker::PhantomData`
/// needs no entry only because `marker` is not in the vocabulary). Mirrors
/// `NON_DOMAIN_IDENTIFIERS` in the JS guard. Matched on the WHOLE surrounding identifier,
/// so a domain `cell_count` next door is untouched.
///
/// The second group is the WS-C addition and closes the ALL-CAPS blind spot of the RIGHT
/// boundary: `right_ok` accepts an uppercase next char because it continues a camel word
/// (`cellsById` is still `cells`), but in an ALL-CAPS word EVERY next char is uppercase,
/// so `GENERIC` matched `gene`, `OBSERVED` matched `obs` and `SOMATIC` matched `soma` —
/// the very words the lowercase rule already rejects. Prose is written in emphasis caps,
/// so widening the scan made this the largest single source of nuisance red.
///
/// NOT in this list, on purpose: genuinely AMBIGUOUS English (the dock's grid `cells`).
/// Those are BASELINED — visible, with a FALSE-POSITIVE tag and a note — because an
/// invisible suppression of an ambiguous word is how the next `n_cells` hides.
const NON_DOMAIN_IDENTIFIERS: &[&str] = &[
    "oncecell",
    "once_cell",
    "refcell",
    "ref_cell",
    "unsafecell",
    "unsafe_cell",
    "lazycell",
    "lazy_cell",
    "syncunsafecell",
    "oncelock",
    // WS-C — the ALL-CAPS blind spot of the right boundary.
    "generic",
    "general",
    "generate",
    "generates",
    "generated",
    "generator",
    "generators",
    "generation",
    "degenerate",
    "regenerate",
    "observed",
    "observe",
    "observer",
    "observation",
    "observable",
    "obsolete",
    "somatic",
    // WS-R3 §3 — the same ALL-CAPS blind spot, for the new `ident` token. `identity` /
    // `identifier` are already rejected by `right_ok` (next char is a lowercase letter);
    // only the emphasis-caps spellings (`IDENTICAL`, `IDENTITY`) leak through.
    "identical",
    "identically",
    "identity",
    "identities",
    "identifier",
    "identifiers",
    "identified",
    "identify",
    "identifies",
    "identification",
    "identifying",
];

/// WS-R3 §3 — Rust MACRO FRAGMENT SPECIFIERS, the other half of making `ident` usable.
///
/// `ident` is a `macro_rules!` FRAGMENT KIND and this tree writes a lot of declarative
/// macros (`($ident:ident, $name:literal)`, `($static:ident, $ctor:ident)`, `pub struct
/// $ident;`) — ~30 of the 60 raw `ident` hits in the tree, with zero domain content. They
/// are suppressed by SHAPE, not by name: a match is a fragment specifier iff it is
/// preceded by `$` (the metavariable `$ident`) or by a `:` that is itself preceded by a
/// `$`-prefixed metavariable name (`$x:ident`). A domain `"ident"` column key,
/// `obj.get("ident")` or `for (ident, range)` has neither shape and is still caught.
/// Mirrors `isRustMacroFragment` in the JS guard.
fn is_rust_macro_fragment(hay: &[u8], start: usize) -> bool {
    if start == 0 {
        return false;
    }
    match hay[start - 1] {
        b'$' => true,
        b':' => {
            let mut a = start - 1;
            while a > 0 && is_ident(hay[a - 1]) {
                a -= 1;
            }
            a > 0 && hay[a - 1] == b'$'
        }
        _ => false,
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  SCAN ROOTS — WS-D
// ════════════════════════════════════════════════════════════════════════════

/// One scan root: a directory, the prefix its files get in the SHARED baseline, and its
/// own committed file-count floor.
///
/// Per-root floors, not one aggregate: a rename that takes `build_helper/` out from under
/// the guard drops 3 files out of ~169 and would never move an aggregate floor. Four such
/// silent-collapse incidents happened in the very commits that moved the subject, which is
/// why the JS guard grew `SCAN_FLOORS` and why the twin now mirrors it.
struct ScanRoot {
    label: &'static str,
    dir: PathBuf,
    /// `<path relative to src-app>` prefix — the baseline key namespace.
    key_prefix: &'static str,
    floor: usize,
    /// Skip files that some `mod.rs` declares `#[cfg(test)] mod …;` (module tree only —
    /// `build_helper` has no `mod.rs` test declarations and the JS guard does not apply
    /// the exclusion there either).
    apply_test_only: bool,
    /// Skip anything under `src/modules` (used by the `server/src/*.rs` root, which is
    /// "`server/src` MINUS the module tree").
    exclude_modules: bool,
    /// WS-R3 §2 — the extensions this root walks. THE RULE, stated once: a root is
    /// scanned in every format the app EMBEDS, EXECUTES or SHIPS from that tree, and in
    /// no others. The server EMBEDS all four DATA formats — `.sql` migrations are
    /// compiled in and run at boot, `seed_multimodal.py` / `seed_anndata_import.py` are
    /// `include_str!`-ed by `workstore/data_api.rs:1184,1470` AND executed,
    /// `mcp/frontend-actions.json` is a baked manifest — so a domain literal in any of
    /// them ships exactly like one in a `.rs` file. The platform's package tree and env
    /// recipes were the contributed domain AS DATA and stayed unscanned by decision;
    /// they have left, so nothing stands in for that decision now.
    exts: &'static [&'static str],
}

const RUST_EXTS: &[&str] = &["rs"];
const DATA_EXTS: &[&str] = &["sql", "py", "json", "yaml", "yml"];

/// Production `.rs` files under `src/modules` (the JS guard's committed floor is the
/// same number — they walk the same tree with the same test-only exclusion).
/// Measured 161 on 2026-07-28.
///
/// WS-R3 §4 — LOWERED 160 -> 107. Every floor in this block was sitting AT or ONE BELOW
/// its own measurement, which is a TRIPWIRE, not a collapse detector: deleting one
/// legitimate file turns the gate red and the only available response is to edit the
/// constant down by one, which trains everyone to treat a red floor as paperwork. It is
/// also verbatim the antipattern the POSITIVE-COUNT block below warns about, and it is
/// how this twin went red unnoticed across a round-1 merge. Restored to ≈2/3.
/// STRIP: RE-MEASURED **127** (107 -> 127) after the seven single-cell modules were
/// deleted; floor LOWERED 107 -> 84 (⅔ of 127). The walker's
/// test-only-BY-DECLARATION exclusion resolves to nothing in this tree (no
/// `#[cfg(test)] mod x;` declaration remains in `src/modules`), so the raw `.rs`
/// count is the walk's count.
const MIN_FILES_MODULES: usize = 84;
/// WS-D: `server/src/*.rs` OUTSIDE `modules/` — `lib.rs` (the whole boot assembly),
/// `main.rs` (the CLI), `config.rs`, `database.rs`, `openapi.rs`. The two files an
/// operator reads first, and both were outside every guard in the tree: `main.rs` names
/// the domain in the shipped binary's own `--help` blurb. Measured 5; floor 5 (this root
/// is small and fixed). WS-R3 §4: 5 -> 3, the same ≈2/3 restoration; the file IDENTITY is
/// pinned by `MUST_SCAN_KEYS`, which is the check that actually names what went missing.
/// STRIP: RE-MEASURED **6** (the tree also carries `harness_sentinel.rs` at this root);
/// floor LOWERED 3 -> 4 (⅔ of 6).
const MIN_FILES_SRC_ROOT: usize = 4;

/// WS-R3 §2 — `server/src/**` + `build_helper/**` in the four DATA formats. Measured 53
/// (49 `.sql` migrations, 2 `include_str!`-ed `.py` drivers, 2 `.json` manifests). Floor
/// at ≈2/3. `datatype/tests/lattice_golden.json` is NOT in this count: it lives under a
/// directory `datatype/mod.rs` declares `#[cfg(test)] mod tests;`, so the same
/// test-only-BY-DECLARATION exclusion that keeps its `mod.rs` sibling out keeps it out —
/// by declaration, not because it is named "golden".
///
/// ROUND-4 RECONCILIATION RE-MEASURED **12** (53 -> 12); floor LOWERED 35 -> 8 (≈2/3).
/// Fully accounted for by ONE workstream: r4squash collapsed the 49 module-local
/// migrations into 8 per-module baselines, so the root is now 8 `.sql` + the 2
/// `include_str!`-ed `.py` seed drivers + 2 `.json` manifests. This is the ONLY floor in
/// either enforcer that the round-4 merge drove BELOW itself, and it did exactly what a
/// collapse detector is for: it fired, named the root, and the drop turned out to be
/// accounted rather than a collapsed walk. Both halves agree at 12 (the JS twin's
/// `SCAN_FLOORS.serverData`), which is the check that neither was edited to fit.
/// STRIP: RE-MEASURED **32** (31 surviving module migrations + `mcp/frontend-actions.json`).
/// The two `include_str!`-ed `.py` seed drivers are gone with `workstore`; no `.py` or
/// `.yaml`/`.yml` file remains under `src/`. Floor LOWERED 8 -> 21 (⅔ of 32).
const MIN_FILES_SERVER_DATA: usize = 21;

// ── WS-R4: the TEST TREE roots ──────────────────────────────────────────────
//
// `server/tests/**` was in NO scan root at all — on EITHER side. That is a stronger
// statement than "`#[cfg(test)]` blanking hid it": the blanking never applied, because
// the walk never reached the directory. Nobody had ever looked, and this is where the
// audit found the EXACT-CARDINALITY CERTIFICATIONS of the contributed domain bundle
// (see the ledger's removal note above) — assertions that make the app's OWN suite
// fail if `packages/single-cell-types` is deleted.
//
// THE EXTENSION RULE FOR A TEST ROOT, in lockstep with the JS twin's block at
// `defaultScanSet`: round 3's production rule ("every format the app EMBEDS, EXECUTES or
// SHIPS from that tree") does not transfer, because a test tree ships NOTHING. The
// analogue is what makes a domain literal in a test tree load-bearing at all — that the
// SUITE RUNS IT: **a test root is scanned in every format the suite COMPILES, EXECUTES
// or ASSERTS AGAINST from that tree, and in no others.** Here that is `.rs` (compiled +
// run by `cargo test --test integration_tests`) — the DATA formats that used to qualify
// (the 12 processor-manifest lint fixtures, `make_mtx_trio.py`, `gen_oracle.py`) are
// gone with the removed test dirs, so the separate data root is gone too.
// `.sh` is NOT scanned: there is no `.sh` dialect in either tokenizer and adding one is
// a new-dialect decision, not a root decision. `.gz` is binary.
//
/// `server/tests/**.rs` — the backend integration suite. Measured 118; floor at ≈2/3.
/// ROUND-4 RE-MEASURED **119** (+1: r4dataapi added `workstore/seed_debug_test.rs`, the
/// first test the debug-seed surface has ever had); floor 78 -> 79.
/// ROUND-5 RE-MEASURED **120** (+1: the round's new cross-side agreement test, whose
/// absence let two enforcers of one behaviour assert opposite things); floor 79 -> 80.
/// STRIP: RE-MEASURED **85** after the removed test trees were deleted; floor LOWERED
/// 80 -> 56 (⅔ of 85).
const MIN_FILES_SERVER_TESTS: usize = 56;
// STRIP: the `server-tests-data` root is gone — the current `server/tests/**` tree
// carries no `.sql`/`.py`/`.json`/`.yaml` file at all (its fixtures left with the
// removed test dirs), so a root with a floor of 0 is not a floor. The literal tier
// still runs over every `.rs` file of `server-tests`, which is where the surviving
// test-tier literal hits live.

// ── WS-R4: the TEST tier's own CALIBRATION ──────────────────────────────────
//
// WHY SEPARATE CONSTANTS AND NOT THE EXISTING FLOORS. Folding ~2700 server-test hits
// into `MIN_NOUN_HITS` (483 measured) would mean a TOTAL collapse of the production
// walk still clears the floor — verbatim the "a collapsed root disappears into the
// total" failure `MUST_SCAN_KEYS` exists to catch, reintroduced one level up. And
// folding 301 test literals into `LITERAL_HITS_CEILING` (26) destroys the only number
// in this file that says something hard: "this many hardcoded domain datatype ids
// SHIP". A test literal is an assertion ON a domain id, not a shipped dispatch OF one.
//
/// Distinct (file, token) pairs in the TEST tier. Measured **374** on 2026-07-28.
/// ROUND-4 RE-MEASURED **373** (-1): r4embed took `sandbox/env_image_test.rs` `cell`
/// 4 -> 0, retiring the pair. Floor 249 -> 248 (≈2/3).
/// ROUND-5 RE-MEASURED **374** (+1: one new pair, in the contribution test whose coverage
/// claim was re-anchored this round). Floor 248 -> 249 (≈2/3).
/// DRIFT RECONCILIATION 2026-08-10 — RE-MEASURED **317** (374 -> 317); 249/317 = 79% is a
/// tripwire. LOWERED 249 -> 211 (⅔ of 317).
/// STRIP: RE-MEASURED **75** — the removed module test trees carried the rest, and
/// this file's own deleted tests retired no distinct pair (every deleted token
/// still occurs elsewhere in this file). Floor LOWERED 211 -> 50 (⅔ of 75). The
/// measurement is a snapshot: the server module strip was still landing while it
/// was taken, and the parent re-runs the floors once that work settles.
const MIN_TEST_NOUN_PAIRS: usize = 50;
/// Total noun+acronym hits in the TEST tier. Measured **1548** on 2026-07-28.
/// ROUND-4 RE-MEASURED **1544** (-4) — the same four `cell` hits. Floor 1032 -> 1029.
/// NOTE this tier barely moved while the JS twin's TEST tier rose by 185: the relocation
/// r4dataapi performed landed in `ui/tests/**`, which this twin does not walk (it never
/// has — `ui/**` is the JS half). Two enforcers, two scopes, one ledger.
/// ROUND-5 RE-MEASURED **1554** (+10): +8 from THIS file's own new drift-pinning test,
/// which has to spell what it searches for, and +2 from the contribution test whose
/// coverage claim was re-anchored because it was false as written. Floor 1029 -> 1036.
/// DRIFT RECONCILIATION 2026-08-10 — RE-MEASURED **1148** (1554 -> 1148); 1036/1148 = 90%
/// is the second-worst margin in the file. LOWERED 1036 -> 765 (⅔ of 1148).
/// STRIP: RE-MEASURED **355** (see the pairs note above for the snapshot caveat).
/// Floor LOWERED 765 -> 236 (⅔ of 355).
const MIN_TEST_NOUN_HITS: usize = 236;
/// Files with a TEST-tier comment hit. Measured **55** on 2026-07-28 — ROUND-4 UNCHANGED
/// (no server test file lost its LAST comment-tier hit), so the floor stays 36 (65%).
/// ROUND-5 UNCHANGED at **55**, same reason; floor stays 36.
/// STRIP: RE-MEASURED **16** — 16 server test files carry a comment-tier hit
/// (snapshotted while the module strip was still landing). Floor LOWERED 36 -> 10
/// (⅔ of 16).
const MIN_TEST_PROSE_FILES: usize = 10;
/// Total TEST-tier comment hits. Measured **832** on 2026-07-28. ROUND-4 RE-MEASURED
/// **838** (+6): this reconciliation's own doc comments in THIS file, recording what
/// r4dataapi deleted, hand-argued under `R3-META` in `domain-baseline.json` because
/// `--prune-baseline` is shrink-only. Floor stays 554 (66% of 838).
/// ROUND-5 RE-MEASURED **847** (+9): +10 THIS file, +2 the contribution test, and -3 from
/// the datatype suite's prose, which stopped describing a type the lattice no longer holds.
/// Floor 554 -> 564 (≈2/3).
/// DRIFT RECONCILIATION 2026-08-10 — RE-MEASURED **650** (847 -> 650); 564/650 = 87% is a
/// tripwire. LOWERED 564 -> 433 (⅔ of 650).
/// STRIP: RE-MEASURED **198** (snapshot caveat as above; the final hit came from this
/// strip's own removal note, which has to spell the surviving literal token).
/// Floor LOWERED 433 -> 132 (⅔ of 198).
const MIN_TEST_PROSE_HITS: usize = 132;
/// TEST-tier datatype LITERALS, server side. Measured **302** on 2026-07-28 — the first
/// time anyone looked. A CEILING, set AT the measurement and shrink-only from there:
/// a NEW test asserting on a hardcoded domain datatype id must be written against a
/// capability or a fixture-derived id instead, not baselined. (The JS twin's tree-wide
/// TEST ceiling is 543; the other 241 are frontend.) For scale, the PRODUCTION ceiling
/// three constants up is 26.
/// ROUND-4 RE-MEASURED **298** — LOWERED 302 -> 298, a real fix: r4embed took
/// `sandbox/env_image_test.rs` `single-cell` 4 -> 0 (the env-image test stopped asserting
/// on a domain rootfs flavour). Shrink-only from 298. (The JS twin's tree-wide TEST
/// ceiling RISES 543 -> 548 in the same commit, because 9 of the 23 literals r4dataapi
/// deleted from `workstore/data_api.rs` were relocated into `ui/tests/**`, which is
/// outside this twin's scope. Both moves are argued at the JS constant.)
///
/// WS-R5 RE-MEASURED **307**, and every one of the nine is a token that DID NOT EXIST in
/// this twin's vocabulary until G2 derived it from the manifests instead of hand-listing
/// it. Composition, from the JS side's own ledger (they share a baseline, so the numbers
/// reconcile):
///   +8  `annotation-table` across four `server/tests/**` files (contributed by
///       `anndata-import`, a package NEITHER enforcer's hand-list mentioned).
///   +4  `cell-set` (contributed by `single-cell-types` at its 0.3.0).
///  +13  `de/result` / `graph/attributed` / `geneset/collection` (the `open-kinds`
///       package) — ids that were matched by NOTHING: absent from the hand-list,
///       excluded from the quoted tier by their slash, and out of reach of the `gene`
///       noun (the lowercase `s` in `geneset` fails the right-hand letter boundary).
///  +11  this file's OWN new drift-pinning test, which has to SPELL the vocabulary it
///       searches for (R5-GUARD-SELF).
///  -20  this file again, in the other direction: porting `QUOTED_TITLE_TOKENS` /
///       `QUOTED_ID_TOKENS` / `SUBSTRING_TOKENS` from hand-lists to a manifest derivation
///       DELETED twenty verbatim datatype titles and ids from the twin's own source.
///  -16  `de` + `Differential expression`, pruned mechanically. Not a fix: `de` was
///       pruned from the LATTICE rounds ago and only the hand-lists kept it alive.
/// Net 298 -> 307. Set AT the new measurement, shrink-only from there.
/// ROUND-5 RECONCILIATION RE-MEASURED **307** — UNCHANGED, verified against a fresh
/// `$DOMAIN_SURFACE_DUMP` diffed against the JS twin's observation (identical over all
/// 1014 (file, token) pairs and all 315 scanned keys). The merge moved this tier by zero.
///
/// ── DRIFT RECONCILIATION 2026-08-27 (issue #28) — RE-MEASURED **318** ──────────────────
/// The saas/compute/accounts merges landed on `main` and this constant was NOT re-anchored,
/// so `main` failed this assertion deterministically (307 < 318) — the same stale-ceiling
/// class the `MIN_*` floors above document, one tier over. WHICH of the two causes, on
/// evidence (a ceiling growing is the one that needs the harder proof, since raising it admits
/// a hardcoding): NOT a new hardcoding by this branch — the parity port added ZERO datatype-id
/// literals (its new controls spell only the three ported context tokens, none of which is a
/// datatype id). And FULLY ACCOUNTED by the shrink-only shared ledger: the JS-maintained
/// `domain-baseline.json` `testLiterals` server sum is **318**, byte-for-byte equal to the
/// live observation over every one of the 48 files, so nothing entered the tree behind the
/// guard's back — the per-entry ratchet tracked each contributed-id literal as the derived
/// vocabulary grew (new contributed datatype ids ⇒ more test files asserting on them). This is
/// the "accounted" branch `reconcile_hint` names: ledger EQUALS measurement ⇒ the aggregate
/// constant was merely STALE, anchored at ⅔-free 307 at an earlier measurement. RE-ANCHORED to
/// the measured 318; shrink-only from there. (The JS twin's tree-wide TEST ceiling reads 521
/// in the same tree; the other 203 are frontend.)
///
/// ── ITEM-25 (sqlite-store) RE-ANCHORED **318 → 321**, fully accounted ──────────────────────
/// The stage1 reference fixtures were regenerated to match their (base-unchanged) emitter,
/// which also emits a `run-environment` output whose `datatype` is `report/qc` — +1 literal
/// hit in EACH of the three fixture manifests (ledgered under `R4-TESTS-FIXTURE`, the
/// producer-shaped-fixture finding, in the same commit). No new test LOGIC hardcodes a
/// datatype id; the one test literal this port would have added (the sqlite module_workstore
/// axis-candidate arm) was rewritten to a NON-domain datatype instead. Ledger again equals
/// measurement (321 = 318 + 3); shrink-only from here.
/// STRIP: RE-MEASURED **13** — every surviving test-tier literal is the
/// `single-cell` substring in THIS file (the guard's own matcher controls), all the
/// quoted-id/quoted-title hits are gone with the manifest-derived vocabulary, and
/// the removed test trees' literals went with them. LOWERED 321 -> 13, set AT the
/// measurement, shrink-only.
const TEST_LITERAL_HITS_CEILING: usize = 13;

/// A baseline key in the TEST tier. The Rust twin only walks SERVER roots (it always
/// has — `ui/**` is the JS twin's half), so server-side this is exactly "under
/// `server/tests/`". `*.test.ts` / `ui/tests/**` are classified by `isTestTierFile` on
/// the JS side; there is no Rust analogue to keep in sync because there is no Rust root
/// that could reach them.
fn is_test_tier_key(key: &str) -> bool {
    key.starts_with("server/tests/")
}
/// Module directories under `src/modules`. Exact, not `>=`: a NEW module must be
/// consciously admitted rather than silently joining an unscanned majority — and a
/// DELETED one must be consciously retired, which is what re-anchored this from 16
/// (artifact-model ITEM-13 removed `tiledb_serve`, the native array reader), then
/// back to 16 (increment-1 added the `drafts` module — the draftable-entity primitive
/// that freezes a curated draft into an immutable artifact), then to 17 on the accounts
/// merge (the accounts epic A1 added the `account` module). In lockstep with the FE
/// twin's assertion in `ui/scripts/lint-no-domain-in-builtin.test.mjs`, then 18 -> 20 on
/// the feature-flags merge (#40): +2 — the admin-authz-foundation merge (#31/#32) added the
/// `admin` module without bumping this (base sat at 19 against a stale 18), and #40 adds the
/// `features` module (the runtime feature-flags subsystem). Both consciously admitted = 20.
/// TXRBENCH STRIP retired 4 (billing, admin, user, app) and added 1 (`localsession`, the
/// single-owner local session) = 17 — consciously, in lockstep with the FE twin.
/// STRIP (this branch): RE-MEASURED **16** — the seven single-cell modules were
/// deleted, so 17 -> 16. This exact-count assertion fired at the base already
/// (the base held 23 modules against a stale 17); it is now correctly 16.
const EXPECT_MODULES: usize = 16;

// ── POSITIVE-COUNT FLOORS ───────────────────────────────────────────────────
//
// Four guards this round reported PASS having scanned ZERO files, and six were scoped
// just narrowly enough to miss what they forbid. So this test never accepts "nothing
// found" on its own: it asserts the scan is BIG and that it is still MATCHING.
//
// All four numbers below are COLLAPSE DETECTORS, not second ratchets — fixing leaks
// (the point of the exercise) legitimately lowers every one of them, and the per-entry
// baseline ratchet is what makes each of those fixes deliberate. They sit at roughly
// two thirds of the measurement so that a broken vocabulary / boundary / tokenizer /
// walker fails loudly while honest progress does not.

/// Distinct (file, token) pairs the widened vocabulary must still match, across ALL
/// roots. RE-MEASURED **24** at the round-2 reconciliation (44 at WS-FT's port; 45 before
/// its `CellSet` → `RowSet` rename).
///
/// HISTORY, because this constant is the reason the twin was RED: it was committed at 45
/// against a 74-pair measurement, and the round-1 merge `ab7f09a1` (the open-axis
/// data-model workstream) took the measurement to 42 — below its own floor — so the twin
/// failed from that merge onward and was still failing at the branch point. A floor set
/// just under the measurement is a floor that a normal, correct fix breaks.
///
/// 44 → 24 is 20 pairs, and every one is accounted for by a merged round-2 workstream (the
/// unaccounted drop is the exact signature this floor exists to catch): WS-E `main.rs` ×1 +
/// `datatype/builtin.rs` ×2 + `workstore/routes.rs` ×2; WS-G `tiledb_serve` ×2; WS-H
/// `project/{models,repository}.rs` ×5; WS-I `rootfs/version.rs` ×1 +
/// `build_helper/sandbox_rootfs.rs` ×1; WS-J `workstore/{ingest,serve_core}.rs` ×6.
/// LOWERED 30 → 16 to restore the ≈2/3 collapse-detector margin.
/// WS-R3 RE-MEASURED **82** (24 -> 82) after the four holes closed. RAISED 16 -> 54 (≈2/3).
/// ROUND-3 RECONCILIATION RE-MEASURED **79** (82 -> 79). WS-R3 anchored 54 against its OWN
/// pre-sibling tree (`c3313502`); 54/79 = 68% is a tripwire, so LOWERED 54 -> 52 (≈2/3 of
/// 79). All three lost pairs are r3methods retiring the `sample`/`ident` alias probe in
/// `provenance/export/methods.rs` — the file's whole code entry (`sample`, `ident`,
/// `samples`) went to zero and `--prune-baseline` removed it in this same commit.
///
/// ROUND-4 RECONCILIATION RE-MEASURED **48** (79 -> 48, -31). Accounted per FILE:
/// r4dataapi 19 (`data_api.rs` 18 pairs -> 2, `routes.rs` 1 -> 0), r4squash 12 (the whole
/// code entry of each of the 5 squashed migrations). LOWERED 52 -> 32 (⅔ of 48).
///
/// DRIFT RECONCILIATION 2026-08-10 — RE-MEASURED **35** (48 -> 35). 32/35 = 91% is the
/// worst margin of any floor in this file and the next one that would have gone red; see
/// `MIN_PROSE_HITS` below for the accounting of the same 13-day monotone drift that moved
/// all four production tiers. LOWERED 32 -> 23 (⅔ of 35).
/// STRIP: RE-MEASURED **77** (77 pairs across the surviving production tree; the
/// remainder was the deleted single-cell modules' entries). LOWERED 23 -> 51 (⅔ of 77).
const MIN_NOUN_PAIRS: usize = 51;
/// Total noun+acronym HITS in code. A pair floor alone cannot see a file going from 16
/// `cell` hits to 1 — the pair survives. RE-MEASURED **75** (115 at WS-FT's port, 126
/// before its rename). 126 → 75 is 51 hits: 11 to FT's own `CellSet` → `RowSet` rename and
/// 40 to the same five workstreams above (WS-J alone accounts for 14 in `serve_core.rs` +
/// `ingest.rs`, WS-G for 11 in `tiledb_serve`, WS-H for 6, WS-E for 5, WS-I for 4).
/// LOWERED 75 → 50: the old value sat EXACTLY on the measurement, i.e. the next correct
/// fix of any size would have broken it — the antipattern this block warns about.
/// WS-R3 RE-MEASURED **500** (75 -> 500): `data_api.rs` +243 and `routes.rs` +2 from §1,
/// the `.sql`/`.py`/`.json` roots from §2, `PBMC`/`nCount`/`pct_ribo`/`ident`/`10x` from
/// §3. RAISED 50 -> 330 (≈2/3).
/// ROUND-3 RECONCILIATION RE-MEASURED **483** (500 -> 483). LOWERED 330 -> 322 (≈2/3 of
/// 483). Both server-side workstreams account for all 17: r3methods `methods.rs` -10 (the
/// alias probe), r3crit `provenance/criteria_script.rs` -7 (`_CELL_WS` -> `VALUE_WS`,
/// `parseCell` -> `parseValue`, `_cell_float` -> `_value_float`).
///
/// ROUND-4 RECONCILIATION RE-MEASURED **186** (483 -> 186, -297) — by far the largest
/// single-round drop this constant has seen, and the floor of 322 would have FIRED had
/// the `server-data` floor not panicked first. Attribution, all 297, from the
/// `--prune-baseline` diff in this same commit:
///   r4dataapi 257  `workstore/data_api.rs` 261 -> 6 (the six subject-specific
///                  `_debug/seed-*` routes became ONE generic engine that frames bytes
///                  and reads ids off the driver's own manifest), `routes.rs` 2 -> 0
///   r4squash   37  the 5 module-local migrations carrying domain column comments,
///                  collapsed into the 8 baselines
///   r4spec      3  residual doc-comment nouns in the module files it rewrote
/// LOWERED 322 -> 124 (⅔ of 186) to put the collapse-detector margin back.
///
/// DRIFT RECONCILIATION 2026-08-10 — RE-MEASURED **144** (186 -> 144). 124/144 = 86%, the
/// same tripwire margin this file lowered `MIN_PROSE_FILES` for at 84%. LOWERED 124 -> 96
/// (⅔ of 144).
/// STRIP: RE-MEASURED **681** (the deleted single-cell modules carried the rest).
/// LOWERED 96 -> 454 (⅔ of 681).
const MIN_NOUN_HITS: usize = 454;
/// Files with at least one comment-tier hit. RE-MEASURED **68** (71 at WS-FT's port).
/// Floor UNCHANGED at 45 — that is still ≈2/3 of the new measurement.
/// WS-R3 RE-MEASURED **85** (68 -> 85). RAISED 45 -> 56 (≈2/3).
/// ROUND-3 RECONCILIATION RE-MEASURED **85** — UNCHANGED (no server file lost its LAST
/// comment-tier hit this round), so the floor stays 56 (66% of 85).
/// ROUND-4 RECONCILIATION RE-MEASURED **67** (85 -> 67, -18): the 17 squashed migrations
/// that carried a `--` header comment, plus `dataset/models.rs` losing its last one to
/// r4spec. 56/67 = 84% is a TRIPWIRE, so LOWERED 56 -> 44 (⅔ of 67).
/// DRIFT RECONCILIATION 2026-08-10 — RE-MEASURED **53** (67 -> 53); 44/53 = 83%, the same
/// tripwire the line above lowered for. LOWERED 44 -> 35 (⅔ of 53).
/// STRIP: RE-MEASURED **61**; the walk reaches 61 surviving production files with a
/// comment-tier hit (snapshot at the strip's module commit; a sibling worker was
/// still landing module trims while it was taken). LOWERED 35 -> 40 (⅔ of 61).
const MIN_PROSE_FILES: usize = 40;
/// Total comment-tier hits. RE-MEASURED **545** (585 at WS-FT's port, 586 before its
/// rename). 586 → 545 is 41, fully accounted: WS-J `serve_core.rs` −17 + `ingest.rs` −3;
/// WS-I `rootfs/version.rs` −6 + `sandbox/settings.rs` −7 + `build_helper` −1; WS-G
/// `tiledb_serve` −3; WS-H `project/models.rs` −3; WS-FT's own rename −1.
/// LOWERED 380 → 360 to hold the ≈2/3 margin against 545.
/// WS-R3 RE-MEASURED **794** (545 -> 794): the `#[cfg(debug_assertions)]` prose that came
/// back with §1, plus the `.sql` `--` headers and the Python module DOCSTRINGS. RAISED
/// 360 -> 525 (≈2/3).
/// ROUND-3 RECONCILIATION RE-MEASURED **775** (794 -> 775). LOWERED 525 -> 516 (≈2/3 of
/// 775). All 19 are r3docs truing-up server doc comments that asserted something FALSE:
/// `workstore/axes.rs` -10, `datatype/types.rs` -5, `workstore/artifact/mod.rs` -4.
/// (r3methods is net 0 here: `methods.rs` -1 `cell`, +1 `sample` — the R3-META
/// removal-documenting prose argued for by hand in `domain-baseline.json`.)
///
/// ROUND-4 RECONCILIATION RE-MEASURED **431** (775 -> 431, -344). Attribution:
///   r4dataapi 180  `data_api.rs` 185 -> 12, `routes.rs` 8 -> 1
///   r4spec    ~85  `datatype/types.rs` 58 -> 5, `extensions/types.rs` 18 -> 1,
///                  `dataset/models.rs` 4 -> 0, `jobs/models.rs` 4 -> 1, + smaller files
///   r4squash   78  the `--` headers of the 20 module-local migrations that carried
///                  domain prose
///   r4embed     1  `sandbox/env_image.rs` `cell` 3 -> 2
/// LOWERED 516 -> 287 (⅔ of 431).
///
/// ── DRIFT RECONCILIATION 2026-08-10 — this floor had gone RED ON `main` ITSELF ────────
/// RE-MEASURED **286**. 287 > 286, so `main` failed this assertion deterministically, in
/// isolation and under load, on every branch cut from it. WHICH of the two causes it was,
/// with the evidence, because "lower it until green" is the drift this floor exists to
/// catch:
///
/// NOT a removed mention. The measurement fell 431 -> 286 MONOTONICALLY across 15 commits
/// between 2026-07-28 and 2026-08-08, every one of them a domain-strip / doc-accuracy fix
/// that pruned the shrink-only `domain-baseline.json` in the SAME commit; not one raised
/// it. Reading the server non-test `prose` sum out of the baseline at each commit that
/// touched it: 431 (a1358707, where this floor was anchored) -> 302 (2751dac5) ->
/// 297 (92de3b5b) -> 292 (a5af5ae5) -> 289 (4bb8c3cb) -> 288 (57a86c71) -> 286 (2a910985)
/// -> 286 (main). The crossing commit is `2a910985`, and its whole -2 falls in ONE file,
/// `workstore/seed_multimodal.py`: two vocabulary tokens each 10 -> 9, from rewriting that
/// driver's module DOCSTRING to describe what it now actually writes. Nothing to restore —
/// the prose was replaced by MORE ACCURATE prose, which is this guard's stated goal. (The
/// two tokens are deliberately not written out: this file is itself scanned, and naming
/// them here is how a guard's own commentary becomes the leak. The first draft of this
/// comment did exactly that and this test caught it — `git show 2a910985` for the pair.)
///
/// The corroborating check is that the tree and the ledger AGREE: the baseline's server
/// non-test prose sum is 286 and the live observation is 286, so the STALE tier has
/// nothing to report — no comment-tier mention went missing behind the guard's back. And
/// the collapse this floor exists to detect did not happen: the walker still reaches all
/// six roots, `MUST_OBSERVE` / `MUST_SCAN_KEYS` still hold, and the three sibling
/// production floors still measure 35 pairs / 144 code hits / 53 prose files.
///
/// So the floor was simply STALE — anchored at ⅔ of a measurement 13 days and 436 commits
/// old, and never re-anchored while the tree got legitimately cleaner. At 287/286 = 100.3%
/// it was no longer a floor at all; it is verbatim the antipattern this block warns about
/// four constants up: "a floor set just under the measurement is a floor that a normal,
/// correct fix breaks." LOWERED 287 -> 190 (⅔ of 286), which puts the collapse-detector
/// margin back.
/// STRIP: RE-MEASURED **358** comment-tier hits in the surviving production tree
/// (same snapshot caveat). LOWERED 190 -> 238 (⅔ of 358).
const MIN_PROSE_HITS: usize = 238;

/// `substring` / `quoted-id` / `quoted-title` — a hardcoded domain datatype-id LITERAL,
/// the hardest INV-3 kind. This is a CEILING, not a ratchet with room: the count may only
/// go DOWN, and raising this constant is an explicit, reviewable admission that a datatype
/// id was hardcoded on purpose.
///
/// RE-MEASURED **0**. WS-FT recorded 3 server-side (`main.rs` `--help` ×1,
/// `build_helper/sandbox_rootfs.rs` build path ×2); WS-E removed the `--help` clause and
/// WS-I turned the recipe-path strings into build inputs, so the tier is now
/// EMPTY and the target it always wanted — zero hardcoded domain datatype ids in the
/// server — is actually met. `MUST_OBSERVE_LITERAL` went with it: a witness for an empty
/// tier is a permanently-failing assertion, not a guard.
/// ── WS-R3: RAISED 0 -> 26 (server side), the loudest result of the round ──
///
/// "Zero hardcoded domain datatype ids in the server" was never true — it was an artifact
/// of the two things this twin refused to read. Un-refusing them surfaces 26 server
/// literal hits that were in the tree the whole time:
///   * `workstore/data_api.rs` 23 — inside `#[cfg(debug_assertions)]` (§1): `single-cell`
///     x11, `report/qc` x5, `metadata-column` x3, `embedding` x2, `clustering` x2.
///     `:669` `"single-cell/expression"` / `:688` `"report/qc"` are executable dispatch.
///   * `workstore/seed_anndata_import.py` 3 — an `include_str!`-embedded, EXECUTED driver
///     (§2): `embedding` x2, `metadata-column` x1.
/// Raising the constant is exactly the "explicit, reviewable admission" this tier was
/// designed to force; here it admits a MEASUREMENT, not a new hardcoding. Shrink-only
/// from 26 — the fixes belong to sibling rounds, each lowering this in the same commit.
/// (The JS twin's tree-wide ceiling is 69: the other 43 are frontend.)
/// ROUND-3 RECONCILIATION RE-MEASURED **26** — UNCHANGED. This was the ceiling most at
/// risk of being stale (WS-R3 set it pre-sibling), and it is not: none of the six sibling
/// workstreams touched a quoted datatype id server-side. Still shrink-only from 26.
///
/// ── ROUND-4: LOWERED 26 -> 3, and this is the round's best number ──
/// r4dataapi deleted ALL 23 of `workstore/data_api.rs`'s literals — including `:669`
/// `"single-cell/expression"`, `:688` `"report/qc"` and `:708` `"metadata-column"`, the
/// three lines WS-R3 called out BY NUMBER as executable dispatch. What is left is the 3
/// in `workstore/seed_anndata_import.py` (`embedding` x2, `metadata-column` x1), an
/// `include_str!`-ed driver that is still `#[cfg(debug_assertions)]`-gated. The server's
/// literal surface is now one file. Shrink-only from 3.
/// STRIP: RE-MEASURED **0** — the last surviving literal was the `include_str!`-ed seed
/// driver with `workstore`, and the quoted-id/quoted-title tiers are empty with the
/// package manifests gone, so the production literal tier is empty again. Ceiling
/// 3 -> 0, set AT the measurement; shrink-only.
const LITERAL_HITS_CEILING: usize = 0;

/// (baseline key, token) pairs that MUST be observed — the audit's own load-bearing server
/// findings, named, PLUS one witness per newly-added root and per newly-added tier. A
/// vocabulary change that stops seeing these is a regression in the guard, not progress in
/// the tree; fixing the leak means REMOVING the entry here in the same commit as removing
/// it from `domain-baseline.json`.
///
/// WS-D REMOVED FIVE ENTRIES THAT WERE ALREADY DEAD. They were asserting findings the
/// round-1 merges had already fixed, and they were only invisible because `MIN_NOUN_PAIRS`
/// failed first and masked them:
///   * `workstore/axes.rs` + `cell` / `gene` — S2's `workstore_cell_axis` /
///     `workstore_gene_axis` tables were DROPPED by
///     `migrations-merged/202608020001_workstore_open_axes.sql:70-71`;
///   * `provenance/export/methods.rs` + `cell` — `CELL_FILTER_GENERATOR_ID`, fixed by S3;
///   * `provenance/action_registry.rs` + `obs` — fixed by S4;
///   * `provenance/interaction.rs` + `cell-set` — fixed by S5.
/// A MUST_OBSERVE entry outliving its finding is the same failure as a stale baseline
/// entry: it asserts the past, and it fails the moment the tree gets better.
/// ROUND-2 RECONCILIATION — FOUR ENTRIES RETIRED, for the reason this list itself gives:
/// the leak they named is gone, so the entry goes in the same commit as the fix.
///   * `project/models.rs` + `cell` — DEC-M's retained wire field; WS-H retired
///     `cell_count`/`gene_count` from `AdminProjectRow` (pinned instead by
///     `the_dec_m_wire_contract_fields_are_GONE`, the INVERSE assertion);
///   * `main.rs` + `cell` — WS-E removed the `--help` domain clause;
///   * `build_helper/sandbox_rootfs.rs` + `cell` — WS-I made the rootfs flavour table a
///     build INPUT;
///   * `workstore/serve_core.rs` + `cell-set` — WS-J replaced the hardcoded datatype
///     literal with a declared capability.
///
/// The last three were WS-D's per-ROOT and per-VOCABULARY-GROUP liveness witnesses, and
/// losing them is a real reduction in this guard's strength, so they are REPLACED rather
/// than dropped — by `MUST_SCAN_KEYS` below. A residue witness is self-destructing by
/// construction: it proves a root is live by asserting a LEAK still exists there, so the
/// very fix the round exists to make deletes the guard's own liveness proof. Pinning the
/// FILE the root must reach survives the tree getting clean, which is the point.
/// STRIP (this branch): the two surviving entries are RETIRED — both files went with
/// the removed modules (`provenance/criteria_script.rs`, `dataset/repository.rs`). Per
/// this list's own rule, the entry goes in the same commit as the subject; the
/// per-root liveness they provided is held by `MUST_SCAN_KEYS`, and `MIN_NOUN_PAIRS` /
/// `MIN_NOUN_HITS` still prove the matcher fires on the surviving tree.
const MUST_OBSERVE: &[(&str, &str)] = &[];

/// One REAL production file per scan root that the walk MUST reach — the replacement for
/// the retired per-root residue witnesses above (see `MUST_OBSERVE`). A root renamed,
/// re-prefixed or filtered out of `scan_roots()` fails HERE, and unlike a residue witness
/// this keeps working as the tree gets clean. Pairs with the per-root file-count floors
/// (which prove the walk found SOMETHING) and `the_domain_token_scanner_actually_matches`
/// (which proves the scanner fires) — together those are what the residue witnesses stood
/// in for. Mirrors the JS twin's `[WS-C][roots] every NEW root is really scanned`.
const MUST_SCAN_KEYS: &[&str] = &[
    // ROOT `modules`. STRIP: `workstore/data_api.rs` went with the workstore module.
    // Per this const's own rule — "removing an entry here needs the root's replacement
    // coverage named in the same commit" — the replacement is
    // `execution_engine/orchestrator.rs`: the same root, now the largest file in it
    // (which is what makes it a good liveness witness rather than an arbitrary one),
    // and it still carries the largest surviving domain residue.
    "server/src/modules/execution_engine/orchestrator.rs", // root `modules`
    "server/src/main.rs",                       // root `src-root`
    "server/src/lib.rs",                        // root `src-root`
    // WS-R3 §2 — one witness per DATA format the `server-data` root walks, so a root that
    // silently stops covering a format fails HERE and names the file.
    // ── ROUND-4 RECONCILIATION — re-decided on evidence, mirroring the JS twin ──
    // WS-R4 de-anchored the `.py` witness because the two seed drivers were "under active
    // review for deletion", and re-anchored on a MIGRATION, arguing that migrations are
    // append-only. The round-4 merge falsified both halves at once: r4squash DELETED
    // `202608020001_workstore_open_axes.sql` (49 module-local migrations -> 8 baselines),
    // so the "append-only" witness is the one that went missing; and r4dataapi RESOLVED
    // the review, keeping both drivers as the `include_str!`-ed payload of the single
    // generic seed engine. Re-pointing the `.sql` at the surviving baseline is correct —
    // a squash IS a coverage-relevant event and this check fired and named the file — but
    // it must not be the only thing standing between a root and a silently-dropped
    // FORMAT. `.py` is therefore pinned by FORMAT rather than by name; see
    // `FORMAT_COVERAGE_PINS` and `the_server_data_root_covers_every_format_it_walks`.
    // STRIP: the `.py` witness is gone by definition (no `.py` remains under `src/`, and
    // the format pin test is vacuous for it), and the `.sql` witness is re-pointed at
    // `jobs/migrations/202608030001_jobs_baseline.sql` — a surviving per-module
    // baseline migration in the same spirit as the round-4 re-point. `.json` still has
    // `mcp/frontend-actions.json`.
    "server/src/modules/jobs/migrations/202608030001_jobs_baseline.sql",
    "server/src/modules/mcp/frontend-actions.json",
    // WS-R4 — one witness per TEST root, same mechanism (a root that is renamed or
    // filtered out fails HERE and names the file). STRIP: the data-format witnesses
    // (`processor_manifest_lint` yaml, `make_mtx_trio.py`) and the datatype/extensions
    // test files left with their trees; the surviving test root witness is
    // `integration_tests.rs`, the file that declares every suite module.
    "server/tests/integration_tests.rs",
];

// ════════════════════════════════════════════════════════════════════════════
//  WS-R4 EXACT-CARDINALITY CERTIFICATIONS — REMOVED (this branch)
// ════════════════════════════════════════════════════════════════════════════
//
// The whole ledger is gone, per this file's own discipline. Every one of the
// certifications it pinned lived in a deleted unit: `server/src/modules/`
// `extensions/loader.rs` (R4-CARD-03), `datatype/sniff.rs` (R4-CARD-04),
// `datatype/mod.rs` (R4-CARD-15), and the deleted test trees
// `server/tests/extensions/{datatype_contribution_test,api_test}.rs`
// (R4-CARD-05/07/08) and `server/tests/datatype/mod.rs` (R4-CARD-06). Their
// subject — a test that makes the app's own suite fail if the contributed
// single-cell bundle is deleted or changes size — no longer exists, because the
// bundle itself (the removed package manifests the certifications counted)
// is gone. An empty certification list would pass vacuously, which is exactly the
// failure mode this ledger accuses; so `the_exact_cardinality_certifications_
// are_still_pinned` and `CERTIFICATION_CEILING` were deleted with the entries.
//
// NO replacement: the surviving server test tree pins nothing to any contributed
// bundle's cardinality (its `features`/`file_validator`/`sandbox`/`mcp` tests
// assert on their own modules' shape, not on a package's output count). The JS
// twin's half of the ledger is re-based in the sibling step the baseline work
// owns.


// `MUST_OBSERVE_LITERAL` was here. The `literals` tier is EMPTY as of the round-2
// reconciliation (WS-E removed the `main.rs` `--help` literal, WS-I the two
// baked recipe-path strings), so `LITERAL_HITS_CEILING` is 0 and a witness
// for an empty tier would be a permanently-failing assertion. What still holds the tier
// closed is the ceiling itself (shrink-only: a new literal cannot be baselined without
// raising a constant) plus `the_domain_token_scanner_actually_matches`, which pins
// `substring_hits`/`quoted_hits` against the exact shapes — an unquoted `--help` blurb
// and a baked recipe-path string — that the pre-WS-D quoted-only tier could
// not see. Those unit assertions are the substring tier's liveness proof now.

// `STALE_ALLOWED_CODE` / `STALE_ALLOWED_PROSE` were here. WS-FT could not prune the
// shared `domain-baseline.json` (it is the integrator's file), so it named the two
// entries its own `CellSet` → `RowSet` rename retired and let the STALE check tolerate
// exactly those. The round-2 `--prune-baseline` has now removed
// `code["…/workstore/axes.rs"]["cellset"]` and lowered
// `prose["…/workstore/axes.rs"]` 27 → 26, so the bridge has served its purpose and is
// gone: the STALE check is back at full strength for EVERY entry with no exceptions.

// ════════════════════════════════════════════════════════════════════════════
//  PATHS
// ════════════════════════════════════════════════════════════════════════════

fn server_src() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src/modules")
}

/// `<repo>/src-app` — the root both this test and the JS guard key the shared baseline on.
fn src_app() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf()
}

fn scan_roots() -> Vec<ScanRoot> {
    let crate_root = Path::new(env!("CARGO_MANIFEST_DIR"));
    vec![
        ScanRoot {
            label: "modules",
            dir: crate_root.join("src/modules"),
            key_prefix: "server/src/modules",
            floor: MIN_FILES_MODULES,
            apply_test_only: true,
            exclude_modules: false,
            exts: RUST_EXTS,
        },
        ScanRoot {
            label: "src-root",
            dir: crate_root.join("src"),
            key_prefix: "server/src",
            floor: MIN_FILES_SRC_ROOT,
            apply_test_only: true,
            exclude_modules: true,
            exts: RUST_EXTS,
        },
        // WS-R3 §2 — the DATA root. One root for `server/src/**` in the four data
        // formats; `build_helper` carried none and was deleted with this strip, and a
        // second near-empty root would be a floor of 0, which is not a floor.
        ScanRoot {
            label: "server-data",
            dir: crate_root.join("src"),
            key_prefix: "server/src",
            floor: MIN_FILES_SERVER_DATA,
            apply_test_only: true,
            exclude_modules: false,
            exts: DATA_EXTS,
        },
        // ── WS-R4 — the TEST TREE. `apply_test_only` is FALSE by construction: the
        // test-only-BY-DECLARATION exclusion resolves `#[cfg(test)] mod …;` out of
        // `src/modules/**/mod.rs` and has nothing to say about `tests/`, whose files
        // are integration targets declared by `integration_tests.rs`. The JS twin
        // applies no such filter to its `serverTests` root either — that equality is
        // what the parity dump checks.
        ScanRoot {
            label: "server-tests",
            dir: crate_root.join("tests"),
            key_prefix: "server/tests",
            floor: MIN_FILES_SERVER_TESTS,
            apply_test_only: false,
            exclude_modules: false,
            exts: RUST_EXTS,
        },
        // STRIP: the `server-tests-data` root (DATA_EXTS under `tests/`) is gone — the
        // current test tree carries no data-format file at all. The literal tier of
        // `server-tests` still runs over every `.rs`, which is where the surviving
        // test-tier literal hits now live.
    ]
}

// ════════════════════════════════════════════════════════════════════════════
//  TOKENIZER — a port of the JS guard's `classify` / `deriveTexts` /
//  `stripCfgBlocks`, byte-oriented (the JS side is UTF-16-char-oriented; every
//  token in the vocabulary is ASCII and every byte of a multi-byte UTF-8 char is
//  >= 0x80, hence a non-letter on both sides, so the boundary rules agree).
// ════════════════════════════════════════════════════════════════════════════

const CODE: u8 = 0;
const COMMENT: u8 = 1;
const STRING: u8 = 2;

/// Per-byte class for Rust source: CODE / COMMENT / STRING.
///
/// This replaces the pre-WS-D `executable_code`, which scanned for `//` and `/*` with no
/// notion of a string literal at all — so a `"https://…"` (or any `//` inside a literal)
/// blanked the REST OF THE LINE out of the scan. That is a fail-open in the direction
/// that matters, and it is also why the prose tier could not be added before: without a
/// classifier there is no comment text to scan.
fn classify(src: &[u8]) -> Vec<u8> {
    let n = src.len();
    let mut mask = vec![CODE; n];
    let mut i = 0usize;
    let at = |k: usize| -> u8 {
        if k < n {
            src[k]
        } else {
            0
        }
    };
    // Rust: distinguish a char literal `'x'` / `'\n'` from a lifetime `'a`.
    let looks_like_char_literal = |i: usize| -> bool { at(i + 1) == b'\\' || at(i + 2) == b'\'' };

    while i < n {
        let c = src[i];
        let c2 = at(i + 1);

        // line comment
        if c == b'/' && c2 == b'/' {
            while i < n && src[i] != b'\n' {
                mask[i] = COMMENT;
                i += 1;
            }
            continue;
        }
        // block comment (Rust block comments NEST)
        if c == b'/' && c2 == b'*' {
            let mut depth = 1usize;
            mask[i] = COMMENT;
            if i + 1 < n {
                mask[i + 1] = COMMENT;
            }
            i += 2;
            while i < n && depth > 0 {
                if src[i] == b'/' && at(i + 1) == b'*' {
                    mask[i] = COMMENT;
                    if i + 1 < n {
                        mask[i + 1] = COMMENT;
                    }
                    depth += 1;
                    i += 2;
                    continue;
                }
                if src[i] == b'*' && at(i + 1) == b'/' {
                    mask[i] = COMMENT;
                    if i + 1 < n {
                        mask[i + 1] = COMMENT;
                    }
                    depth -= 1;
                    i += 2;
                    continue;
                }
                mask[i] = COMMENT;
                i += 1;
            }
            continue;
        }
        // raw string: r"…", r#"…"#, br#"…"#
        if c == b'r' || (c == b'b' && c2 == b'r') {
            let mut j = if c == b'r' { i + 1 } else { i + 2 };
            if at(j) == b'#' || at(j) == b'"' {
                let mut hashes = 0usize;
                while at(j) == b'#' {
                    hashes += 1;
                    j += 1;
                }
                if at(j) == b'"' {
                    let mut closing = vec![b'"'];
                    closing.extend(std::iter::repeat(b'#').take(hashes));
                    for k in i..=j.min(n - 1) {
                        mask[k] = STRING;
                    }
                    let mut p = j + 1;
                    while p < n {
                        if p + closing.len() <= n && src[p..p + closing.len()] == closing[..] {
                            for k in p..p + closing.len() {
                                mask[k] = STRING;
                            }
                            p += closing.len();
                            break;
                        }
                        mask[p] = STRING;
                        p += 1;
                    }
                    i = p;
                    continue;
                }
            }
        }
        // string literal / char literal
        if c == b'"' || (c == b'\'' && looks_like_char_literal(i)) {
            let quote = c;
            mask[i] = STRING;
            i += 1;
            while i < n {
                if src[i] == b'\\' {
                    mask[i] = STRING;
                    if i + 1 < n {
                        mask[i + 1] = STRING;
                    }
                    i += 2;
                    continue;
                }
                mask[i] = STRING;
                if src[i] == quote {
                    i += 1;
                    break;
                }
                i += 1;
            }
            continue;
        }
        // ordinary code byte (incl. a Rust lifetime `'`)
        i += 1;
    }
    mask
}

/// Three newline-preserving projections (line numbers survive in all of them):
///   `scan`     comments blanked, code + string literals kept — the EXECUTABLE surface;
///              a domain literal here is a real dispatch.
///   `skeleton` comments AND string CONTENTS blanked — used to locate `#[cfg(…)]` attrs
///              and brace-match without miscounting braces inside string literals.
///   `prose`    the INVERSE of `scan`: only comments kept. WS-B blind spot #1 — domain
///              INTENT stated in a doc header was invisible to every gate.
/// WS-R3 §2 — the DATA dialects. Both guards read only `.rs`/`.ts`/`.tsx`, i.e. 633 of
/// the 1108 app+test code files in the tree; everything the server EMBEDS or EXECUTES in
/// another format was structurally invisible. `Lang` selects the classifier; every
/// downstream tier (scan / prose / literals) is unchanged.
///
/// Per-format comment + string rules, mirroring the JS `classifyData`:
///   Sql  — `--` to EOL, `/* … */`; strings `'…'`, quoted identifiers `"…"`.
///   Py   — `#` to EOL; `'…'` / `"…"`; TRIPLE-quoted blocks are classed as COMMENT,
///          because a Python docstring IS that language's documentation convention
///          (`seed_multimodal.py`'s module docstring is three paragraphs of domain intent,
///          which belongs next to a Rust `//!` header, not in the executable tier).
///   Yaml — `#` to EOL, only when it opens a token (`a#b` is not a comment).
///   Json — no comments; `"…"` only (a bare `'` is an apostrophe).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Lang {
    Rust,
    Sql,
    Py,
    Yaml,
    Json,
}

impl Lang {
    fn of(path: &Path) -> Lang {
        match path.extension().and_then(|x| x.to_str()) {
            Some("sql") => Lang::Sql,
            Some("py") => Lang::Py,
            Some("yaml") | Some("yml") => Lang::Yaml,
            Some("json") => Lang::Json,
            _ => Lang::Rust,
        }
    }
}

fn classify_data(src: &[u8], lang: Lang) -> Vec<u8> {
    let n = src.len();
    let mut mask = vec![CODE; n];
    let at = |k: usize| -> u8 {
        if k < n {
            src[k]
        } else {
            0
        }
    };
    let hash_comment = matches!(lang, Lang::Py | Lang::Yaml);
    let dash_comment = lang == Lang::Sql;
    let block_comment = lang == Lang::Sql;
    let single_quote = lang != Lang::Json;
    let triple = lang == Lang::Py;
    let mut i = 0usize;
    while i < n {
        let c = src[i];
        if hash_comment && c == b'#' {
            // YAML: `#` only opens a comment at start-of-token.
            if lang == Lang::Yaml && i > 0 && !matches!(src[i - 1], b' ' | b'\t' | b'\n') {
                i += 1;
                continue;
            }
            while i < n && src[i] != b'\n' {
                mask[i] = COMMENT;
                i += 1;
            }
            continue;
        }
        if dash_comment && c == b'-' && at(i + 1) == b'-' {
            while i < n && src[i] != b'\n' {
                mask[i] = COMMENT;
                i += 1;
            }
            continue;
        }
        if block_comment && c == b'/' && at(i + 1) == b'*' {
            mask[i] = COMMENT;
            if i + 1 < n {
                mask[i + 1] = COMMENT;
            }
            i += 2;
            while i < n {
                if src[i] == b'*' && at(i + 1) == b'/' {
                    mask[i] = COMMENT;
                    if i + 1 < n {
                        mask[i + 1] = COMMENT;
                    }
                    i += 2;
                    break;
                }
                mask[i] = COMMENT;
                i += 1;
            }
            continue;
        }
        if triple && i + 3 <= n && (c == b'"' || c == b'\'') && src[i + 1] == c && src[i + 2] == c {
            let closing = [c, c, c];
            for m in mask.iter_mut().take(i + 3).skip(i) {
                *m = COMMENT;
            }
            let mut q = i + 3;
            while q + 3 <= n && src[q..q + 3] != closing {
                mask[q] = COMMENT;
                q += 1;
            }
            let end = (q + 3).min(n);
            for m in mask.iter_mut().take(end).skip(q) {
                *m = COMMENT;
            }
            i = end;
            continue;
        }
        if c == b'"' || (single_quote && c == b'\'') {
            let quote = c;
            mask[i] = STRING;
            i += 1;
            while i < n {
                if src[i] == b'\\' && lang != Lang::Sql {
                    mask[i] = STRING;
                    if i + 1 < n {
                        mask[i + 1] = STRING;
                    }
                    i += 2;
                    continue;
                }
                mask[i] = STRING;
                if src[i] == quote {
                    i += 1;
                    break;
                }
                // an unterminated quote must not swallow the rest of the file
                if src[i] == b'\n' {
                    i += 1;
                    break;
                }
                i += 1;
            }
            continue;
        }
        i += 1;
    }
    mask
}

fn derive_texts_lang(src: &[u8], lang: Lang) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    let mask = if lang == Lang::Rust {
        classify(src)
    } else {
        classify_data(src, lang)
    };
    let mut scan = Vec::with_capacity(src.len());
    let mut skel = Vec::with_capacity(src.len());
    let mut prose = Vec::with_capacity(src.len());
    for (i, &c) in src.iter().enumerate() {
        let blank = if c == b'\n' { b'\n' } else { b' ' };
        match mask[i] {
            COMMENT => {
                scan.push(blank);
                skel.push(blank);
                prose.push(c);
            }
            STRING => {
                scan.push(c);
                skel.push(blank);
                prose.push(blank);
            }
            _ => {
                scan.push(c);
                skel.push(c);
                prose.push(blank);
            }
        }
    }
    (scan, skel, prose)
}

fn is_ident(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// WS-R5 G1 — `not ( test )` present in `hay`, whitespace-insensitive. The Rust half of
/// the JS twin's `!/\bnot\s*\(\s*test\s*\)/`.
///
/// `contains_word(args, "test")` is true for `not(test)`, i.e. the attribute marking code
/// compiled ONLY OUTSIDE tests — the exact OPPOSITE of the `#[cfg(test)]` exemption's
/// premise. Both enforcers blanked such an item out of the scan, so a domain literal
/// inside one was invisible to every tier. Latent rather than live (nothing in the tree
/// spells `test` any other way today) and one line in each, which is the only reason it
/// stayed cheap.
fn contains_not_test(hay: &[u8]) -> bool {
    // NB a local `word(..)` rather than the file's byte-class helper: that helper's NAME is
    // itself a vocabulary hit, so two more call sites (and a comment naming it) would raise
    // this file's own baselined count. The guard's ledger should not grow to pay for the
    // guard's own helper names — the same reasoning as the `observed` local in the
    // format-pin test.
    let word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    let n = hay.len();
    let mut i = 0usize;
    while i + 3 <= n {
        if &hay[i..i + 3] == b"not"
            && (i == 0 || !word(hay[i - 1]))
            && (i + 3 == n || !word(hay[i + 3]))
        {
            let mut j = i + 3;
            while j < n && hay[j].is_ascii_whitespace() {
                j += 1;
            }
            if j < n && hay[j] == b'(' {
                j += 1;
                while j < n && hay[j].is_ascii_whitespace() {
                    j += 1;
                }
                if j + 4 <= n && &hay[j..j + 4] == b"test" {
                    let mut k = j + 4;
                    while k < n && hay[k].is_ascii_whitespace() {
                        k += 1;
                    }
                    if k < n && hay[k] == b')' {
                        return true;
                    }
                }
            }
        }
        i += 1;
    }
    false
}

/// `needle` present in `hay` with a non-identifier byte on both sides (a `\b…\b` match),
/// so `cfg(feature = "latest")` does not read as `cfg(test)`.
fn contains_word(hay: &[u8], needle: &str) -> bool {
    let t = needle.as_bytes();
    if t.len() > hay.len() {
        return false;
    }
    (0..=hay.len() - t.len()).any(|i| {
        &hay[i..i + t.len()] == t
            && (i == 0 || !is_ident(hay[i - 1]))
            && (i + t.len() == hay.len() || !is_ident(hay[i + t.len()]))
    })
}

/// Byte spans of every `#[cfg(test)]` ITEM, located and brace-matched against the
/// SKELETON so braces inside string literals cannot miscount. A non-block item
/// (`#[cfg(test)] use …;`) runs to its `;`.
///
/// ── WS-R3 §1: `#[cfg(debug_assertions)]` IS NO LONGER STRIPPED ──────────────
///
/// It was, "for the reason DOMAIN_AUDIT §7 gives: every fn/const/route in
/// `workstore/data_api.rs` carries it". That describes the SUBJECT; it is not a reason to
/// stop looking at it, and it is why both guards were green: `data_api.rs` was baselined
/// at 104 prose / ZERO code while measuring ~398 raw vocabulary hits. Un-stripping
/// surfaces 243 code + 70 prose + **23 LITERAL** hits there (incl. `:669`
/// `"single-cell/expression"`, `:688` `"report/qc"`, `:708` `"metadata-column"` and
/// `:551`'s literal mitochondrial/ribosomal GENE SYMBOLS), plus 2 code + 7 prose in
/// `workstore/routes.rs`, which registers SIX real HTTP routes under the same attribute.
/// `debug_assertions` compiles into every dev/debug binary — "dev-only" is a deployment
/// argument, not a structural one, and only structural exemptions are honoured.
///
/// `#[cfg(test)]` STAYS stripped: that exemption is COMPILER-ENFORCED (the same argument
/// `test_only_modules` makes at file granularity), and the in-tree grep-guards live in it
/// and must spell the vocabulary out to search for it. Its MEASURED cost, recorded rather
/// than assumed: scanning it too would add 633 code / 180 prose / 69 literal hits across
/// ~40 files. No ceiling is put on that — a ceiling over test code fires on every added
/// test, and a nuisance-red gate gets narrowed. See the JS twin's `stripCfgBlocks` for the
/// full decision, and finding R3-F1 for the ADJACENT hole it does not cover (the test
/// TREES, `server/tests/**` ≈1258 hits, are in no scan root at all).
fn cfg_block_spans(skeleton: &[u8]) -> Vec<(usize, usize)> {
    let n = skeleton.len();
    let mut spans = Vec::new();
    let mut p = 0usize;
    while p + 1 < n {
        if !(skeleton[p] == b'#' && skeleton[p + 1] == b'[') {
            p += 1;
            continue;
        }
        // the JS regex is `#\[\s*cfg\s*\(([^\]]*)\)\s*\]` — args may not contain `]`.
        let Some(close) = skeleton[p + 2..n]
            .iter()
            .position(|&c| c == b']')
            .map(|k| p + 2 + k)
        else {
            break;
        };
        let inner = &skeleton[p + 2..close];
        let trimmed: Vec<u8> = inner
            .iter()
            .copied()
            .skip_while(|c| c.is_ascii_whitespace())
            .collect();
        let is_cfg = trimmed.starts_with(b"cfg")
            && trimmed[3..]
                .iter()
                .skip_while(|c| c.is_ascii_whitespace())
                .next()
                == Some(&b'(')
            && trimmed.last() == Some(&b')');
        if !is_cfg {
            p += 2;
            continue;
        }
        let args =
            &trimmed[trimmed.iter().position(|&c| c == b'(').unwrap() + 1..trimmed.len() - 1];
        // WS-R5 G1 — see `contains_not_test`: `#[cfg(not(test))]` is SHIPPING code and
        // must NOT be blanked. Byte-for-byte the JS twin's guard in `stripCfgBlocks`.
        if !contains_word(args, "test") || contains_not_test(args) {
            p += 2;
            continue;
        }
        // first `{` or `;` after the attribute
        let mut q = close + 1;
        while q < n && skeleton[q] != b'{' && skeleton[q] != b';' {
            q += 1;
        }
        if q >= n {
            break;
        }
        let end = if skeleton[q] == b';' {
            q + 1
        } else {
            let mut depth = 0i32;
            let mut k = q;
            while k < n {
                if skeleton[k] == b'{' {
                    depth += 1;
                } else if skeleton[k] == b'}' {
                    depth -= 1;
                    if depth == 0 {
                        k += 1;
                        break;
                    }
                }
                k += 1;
            }
            k
        };
        spans.push((p, end));
        p = end;
    }
    spans
}

fn blank_spans(text: &mut [u8], spans: &[(usize, usize)]) {
    let n = text.len();
    for &(a, b) in spans {
        for c in text.iter_mut().take(b.min(n)).skip(a) {
            if *c != b'\n' {
                *c = b' ';
            }
        }
    }
}

/// `(scan, prose)` for one source — Rust sources are `#[cfg(test)]`-stripped in BOTH
/// projections (a comment inside a test module is as non-shipping as the code it
/// documents). Data dialects have no `cfg` concept, so `lang` selects the classifier and
/// the strip is skipped.
fn scan_and_prose_lang(src: &[u8], lang: Lang) -> (Vec<u8>, Vec<u8>) {
    let (mut scan, skel, mut prose) = derive_texts_lang(src, lang);
    if lang == Lang::Rust {
        let spans = cfg_block_spans(&skel);
        blank_spans(&mut scan, &spans);
        blank_spans(&mut prose, &spans);
    }
    (scan, prose)
}

fn scan_and_prose(src: &[u8]) -> (Vec<u8>, Vec<u8>) {
    scan_and_prose_lang(src, Lang::Rust)
}

/// Source with comments and `#[cfg(test)]` blocks blanked —
/// the executable surface. Kept as a named helper because it is what the matcher unit
/// test reads, and because "what does the binary DO" is the question this tier answers.
fn executable_code(src: &str) -> String {
    let (scan, _) = scan_and_prose(src.as_bytes());
    String::from_utf8_lossy(&scan).into_owned()
}

/// The comment text only, cfg-stripped.
fn prose_text(src: &str) -> String {
    let (_, prose) = scan_and_prose(src.as_bytes());
    String::from_utf8_lossy(&prose).into_owned()
}

// ════════════════════════════════════════════════════════════════════════════
//  MATCHERS
// ════════════════════════════════════════════════════════════════════════════

/// ── WS-R4: the SEGMENT the match sits in — a byte-for-byte port of the JS twin's
/// `segmentContaining` ────────────────────────────────────────────────────────────
///
/// `NON_DOMAIN_IDENTIFIERS` is checked against the WHOLE surrounding identifier, which is
/// right for the `once_cell` / `refcell` class (the entry IS the whole name) and useless
/// the moment the different-word lands inside a COMPOUND name — the normal case in
/// SCREAMING_SNAKE. `TXR_ENV_IMAGE_IDENTITY_REGEXP` (`sandbox/env_image.rs`) yields
/// `txr_env_image_identity_regexp`, which is not in the set, so the `identity` entry
/// never fires and the round-3 `ident` token reports 3 hits on an operator-facing env-var
/// name with no domain content. A noisy token is a token that gets deleted, so the
/// BOUNDARY is fixed rather than the vocabulary.
///
/// Rule: suppress when the WHOLE identifier is a non-domain identifier (unchanged) OR
/// when the SEGMENT containing the match is one. BOTH, not segments alone: `once_cell`
/// segments to `once` + `cell`, and `cell` is a real vocabulary token, so a segment-only
/// rule would un-suppress every `OnceCell` in the server. And segments do not
/// over-suppress: `GENERIC_CELL_CAP` still reports its `CELL` (segment `cell`, not in the
/// set) while the `gene` inside `GENERIC` is correctly dropped; a real `SAMPLE_IDENT`
/// segments to `ident` and is still reported.
fn segment_containing(ident: &str, offset: usize) -> String {
    let b = ident.as_bytes();
    let mut bounds: Vec<usize> = vec![0];
    for i in 1..b.len() {
        let prev = b[i - 1];
        let cur = b[i];
        if cur == b'_' {
            bounds.push(i);
            bounds.push(i + 1);
            continue;
        }
        if prev == b'_' {
            continue;
        }
        // camel hump: lower/digit -> Upper, or Upper -> Upper followed by lower
        if cur.is_ascii_uppercase()
            && (!prev.is_ascii_uppercase() || b.get(i + 1).is_some_and(|c| c.is_ascii_lowercase()))
        {
            bounds.push(i);
        }
    }
    bounds.push(b.len());
    bounds.sort_unstable();
    bounds.dedup();
    for w in bounds.windows(2) {
        if offset >= w[0] && offset < w[1] {
            return String::from_utf8_lossy(&b[w[0]..w[1]])
                .replace('_', "")
                .to_ascii_lowercase();
        }
    }
    ident.to_ascii_lowercase()
}

/// True when the match at `[i, end)` sits in a LANGUAGE identifier, not a domain one.
fn is_non_domain_identifier(hay: &[u8], i: usize, end: usize) -> bool {
    let mut a = i;
    while a > 0 && is_ident(hay[a - 1]) {
        a -= 1;
    }
    // NOTE the raw (non-lowercased) slice: segmentation reads CASE to find camel humps,
    // so it must run before the lowercase fold. The JS twin does the same.
    let mut b = end;
    while b < hay.len() && is_ident(hay[b]) {
        b += 1;
    }
    let raw = String::from_utf8_lossy(&hay[a..b]).into_owned();
    if NON_DOMAIN_IDENTIFIERS.contains(&raw.to_ascii_lowercase().as_str()) {
        return true;
    }
    NON_DOMAIN_IDENTIFIERS.contains(&segment_containing(&raw, i - a).as_str())
}

// ── CARGO / `cfg` BUILD `feature` + the `stripe-samples` repo name ───────────────────
//
// Byte-for-byte the JS twin's WS-R8/WS-R9 exclusions
// (`ui/scripts/lint-no-domain-in-builtin.mjs`: `isCargoCfgFeatureToken` /
// `isCargoFeatureSense`, and the `stripe-samples` clause of `matchNouns`). `feature` is a
// measured-variable-axis noun AND the Cargo build keyword; the saas / compute / accounts epics gate whole
// modules behind the cargo `feature` attribute, so every gated module carries it and it
// RECURS on the next one. The software sense is excluded by CONTEXT, never on a bare
// `feature`, so a genomic `feature` / `n_features` / `feature matrix` in a non-gated file (or
// any Python / TS file) is STILL caught. The two enforcers MUST agree byte for byte or the
// shared baseline drifts — `dump_observation_for_parity` is the proof.

/// P1 — the token sits in the cfg / cargo GRAMMAR itself (Rust only). Mirrors the four
/// `isCargoCfgFeatureToken` regexes; the `before` window is the same 16 bytes ending at
/// `start`, whose own start is treated as `^`.
fn is_cargo_cfg_feature_token(hay: &[u8], start: usize, end: usize) -> bool {
    // `feature = "…"` — the cfg predicate KEY (the `after` regex `^\s*=\s*"`).
    let mut j = end;
    while j < hay.len() && hay[j].is_ascii_whitespace() {
        j += 1;
    }
    if j < hay.len() && hay[j] == b'=' {
        let mut k = j + 1;
        while k < hay.len() && hay[k].is_ascii_whitespace() {
            k += 1;
        }
        if k < hay.len() && hay[k] == b'"' {
            return true;
        }
    }
    let before = &hay[start.saturating_sub(16)..start];
    // `[^A-Za-z_]` (or the window start) immediately left of `q`.
    let bound =
        |q: usize| q == 0 || !(before[q - 1].is_ascii_alphabetic() || before[q - 1] == b'_');
    // `(?:cfg!?|not|all|any)\s*\(\s*$`
    {
        let mut p = before.len();
        while p > 0 && before[p - 1].is_ascii_whitespace() {
            p -= 1;
        }
        if p > 0 && before[p - 1] == b'(' {
            p -= 1;
            while p > 0 && before[p - 1].is_ascii_whitespace() {
                p -= 1;
            }
            let kws: [&[u8]; 5] = [b"cfg!", b"cfg", b"not", b"all", b"any"];
            for kw in kws {
                if p >= kw.len() && &before[p - kw.len()..p] == kw && bound(p - kw.len()) {
                    return true;
                }
            }
        }
    }
    // `(?:no-)?default-$`
    {
        let n = before.len();
        let need: &[u8] = b"default-";
        if n >= need.len() && &before[n - need.len()..] == need {
            let mut q = n - need.len();
            if q >= 3 && &before[q - 3..q] == b"no-" {
                q -= 3;
            }
            if bound(q) {
                return true;
            }
        }
    }
    // `(?:^|\s)--$`
    {
        let n = before.len();
        if n >= 2 && &before[n - 2..] == b"--" && (n == 2 || before[n - 3].is_ascii_whitespace()) {
            return true;
        }
    }
    // `cargo[ \t-]$`
    {
        let n = before.len();
        if n >= 6
            && matches!(before[n - 1], b' ' | b'\t' | b'-')
            && &before[n - 6..n - 1] == b"cargo"
            && bound(n - 6)
        {
            return true;
        }
    }
    false
}

/// `needle` present in `hay` case-insensitively with a `\w` boundary (`[A-Za-z0-9_]`) on both
/// sides — internal non-word chars (`build.rs`, `default-features`) are not boundaries.
fn contains_word_ci(hay: &[u8], needle: &[u8]) -> bool {
    if needle.len() > hay.len() {
        return false;
    }
    // A local `word` predicate, not the file's byte-class helper: that helper's NAME is
    // itself a vocabulary hit, so calling it here would raise this file's own baselined
    // count (the same reasoning as `contains_not_test`'s local `word`).
    let word = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    (0..=hay.len() - needle.len()).any(|i| {
        hay[i..i + needle.len()].eq_ignore_ascii_case(needle)
            && (i == 0 || !word(hay[i - 1]))
            && (i + needle.len() == hay.len() || !word(hay[i + needle.len()]))
    })
}

/// P3 — a cargo / cfg register word on the token's own physical line. Mirrors
/// `CARGO_FEATURE_CONTEXT_RE = /\b(?:saas|cargo|cfg|sqlx|crate|default-features|build\.rs)\b|--features?\b/i`.
fn line_has_cargo_feature_context(hay: &[u8], pos: usize) -> bool {
    let mut a = pos;
    while a > 0 && hay[a - 1] != b'\n' {
        a -= 1;
    }
    let mut b = pos;
    while b < hay.len() && hay[b] != b'\n' {
        b += 1;
    }
    let line = &hay[a..b];
    let words: [&[u8]; 7] = [
        b"saas",
        b"cargo",
        b"cfg",
        b"sqlx",
        b"crate",
        b"default-features",
        b"build.rs",
    ];
    for w in words {
        if contains_word_ci(line, w) {
            return true;
        }
    }
    // `--features?\b` — no left boundary, optional trailing `s`, then a word boundary. Local
    // `word` predicate for the same reason as `contains_word_ci`.
    let word = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    let dash: &[u8] = b"--feature";
    let mut i = 0usize;
    while i + dash.len() <= line.len() {
        if line[i..i + dash.len()].eq_ignore_ascii_case(dash) {
            let mut e = i + dash.len();
            if e < line.len() && (line[e] | 0x20) == b's' {
                e += 1;
            }
            if e == line.len() || !word(line[e]) {
                return true;
            }
        }
        i += 1;
    }
    false
}

/// True when a `feature` / `features` match at `[start, end)` is the CARGO / software sense,
/// not the genomic one. Composes P1 (grammar, Rust), P2 (the file is a cfg-`feature`-gated
/// Rust module) and P3 (a cargo / cfg word on the line, Rust or its migration SQL).
fn is_cargo_feature_sense(
    hay: &[u8],
    start: usize,
    end: usize,
    lang: Lang,
    file_has_cfg_feature_attr: bool,
) -> bool {
    let rust = lang == Lang::Rust;
    if rust && is_cargo_cfg_feature_token(hay, start, end) {
        return true; // P1
    }
    if rust && file_has_cfg_feature_attr {
        return true; // P2
    }
    if rust || lang == Lang::Sql {
        return line_has_cargo_feature_context(hay, start); // P3
    }
    false
}

/// The `stripe-samples` repo-name clause: exclude the plural token ONLY when it is the tail of
/// a hyphenated identifier (e.g. `stripe-samples`). A bare genomic plural
/// (space / paren / quote before it) is not hyphen-tailed and STILL fires. Kept to the PLURAL,
/// mirroring the JS `matchNouns` guard: the genomic corpus uses SINGULAR hyphenated forms,
/// which must stay caught.
fn is_repo_name_plural(hay: &[u8], start: usize) -> bool {
    start >= 2 && hay[start - 1] == b'-' && hay[start - 2].is_ascii_alphanumeric()
}

/// `#[cfg(… feature = …)]` present anywhere in the raw source — the file is a
/// cfg-`feature`-gated Rust module (P2). Mirrors the JS `fileHasCfgFeatureAttr` regex
/// `#\s*\[\s*cfg\b[^\]]*\bfeature\s*=`, run on the RAW file (comments + strings included, as
/// the JS side does), so a file carrying the attribute is P2 regardless of tier.
fn file_has_cfg_feature_attr(src: &[u8]) -> bool {
    let n = src.len();
    // Local `word` predicate — see `contains_word_ci` for why the file's byte-class helper
    // is not called here.
    let word = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    let mut i = 0usize;
    while i < n {
        if src[i] == b'#' {
            let mut j = i + 1;
            while j < n && src[j].is_ascii_whitespace() {
                j += 1;
            }
            if j < n && src[j] == b'[' {
                let mut k = j + 1;
                while k < n && src[k].is_ascii_whitespace() {
                    k += 1;
                }
                if k + 3 <= n && &src[k..k + 3] == b"cfg" && (k + 3 == n || !word(src[k + 3])) {
                    let mut p = k + 3;
                    while p < n && src[p] != b']' {
                        if p + 7 <= n
                            && src[p..p + 7].eq_ignore_ascii_case(b"feature")
                            && (p == 0 || !word(src[p - 1]))
                        {
                            let mut q = p + 7;
                            while q < n && src[q] != b']' && src[q].is_ascii_whitespace() {
                                q += 1;
                            }
                            if q < n && src[q] == b'=' {
                                return true;
                            }
                        }
                        p += 1;
                    }
                }
            }
        }
        i += 1;
    }
    false
}

/// Every vocabulary noun in `code`, with the SAME boundary rule as the JS guard's
/// `matchNouns`:
///
///   LEFT  ok when the preceding char is not a letter, OR it is a lowercase letter and
///         the match starts UPPERCASE (a camelCase hump: `inputCells`, `nObs`).
///   RIGHT ok when the following char is not a LOWERCASE letter (an uppercase one
///         continues the camel word; a lowercase one means we matched a PREFIX —
///         `generic`, `observed`, `resampled`).
///
/// `\b` would treat `_` as a word char and MISS `n_cells`; a letter boundary alone
/// would miss `inputCells`. Both were live fail-open shapes (DOMAIN_AUDIT §0 #4).
///
/// On a text-match whose BOUNDARY fails, the cursor advances by ONE and no shorter token
/// is tried at that position — mirroring the JS regex, which commits to the alternation's
/// first text-match and then resumes at `start + 1`.
pub fn match_nouns<F: FnMut(usize, &'static str)>(
    hay: &[u8],
    lang: Lang,
    file_has_cfg_feature_attr: bool,
    mut on_hit: F,
) {
    let rust = lang == Lang::Rust;
    let mut i = 0usize;
    'outer: while i < hay.len() {
        for tok in DOMAIN_NOUNS {
            let t = tok.as_bytes();
            if i + t.len() > hay.len() {
                continue;
            }
            if !hay[i..i + t.len()]
                .iter()
                .zip(t)
                .all(|(a, b)| a.to_ascii_lowercase() == b.to_ascii_lowercase())
            {
                continue;
            }
            let end = i + t.len();
            let prev = if i > 0 { Some(hay[i - 1]) } else { None };
            let next = hay.get(end).copied();
            // WS-R3 §3 — a DIGIT-initial token (`10x`) gets a stricter LEFT boundary:
            // the letter+camel rule accepts any non-LETTER neighbour, so `110x` would
            // match. Requiring a non-ALPHANUMERIC neighbour is the acronym tier's rule,
            // and it costs nothing (`strip_10x_suffix`, `(10x`, ` 10x` still match).
            let digit_initial = hay[i].is_ascii_digit();
            let left_ok = if digit_initial {
                prev.is_none_or(|c| !c.is_ascii_alphanumeric())
            } else {
                match prev {
                    None => true,
                    Some(c) if !c.is_ascii_alphabetic() => true,
                    Some(c) => !c.is_ascii_uppercase() && hay[i].is_ascii_uppercase(),
                }
            };
            let right_ok = !next.is_some_and(|c| c.is_ascii_lowercase());
            if left_ok && right_ok {
                if !is_non_domain_identifier(hay, i, end)
                    && !(rust && is_rust_macro_fragment(hay, i))
                    && !((*tok == "feature" || *tok == "features")
                        && is_cargo_feature_sense(hay, i, end, lang, file_has_cfg_feature_attr))
                    && !(*tok == "samples" && is_repo_name_plural(hay, i))
                {
                    on_hit(i, tok);
                }
                i = end;
            } else {
                i += 1;
            }
            continue 'outer;
        }
        i += 1;
    }
}

/// WS-D acronym tier — CASE-SENSITIVE, and both neighbours must be NON-ALPHANUMERIC
/// (`_` is allowed, so `DE_TABLE` is a hit and `DERIVED` is not).
///
/// WS-R8 — the `-INV` DEPLOYMENT-invariant label family (`…-INV-1` desktop parity, `…-INV-10`
/// metering-compiles-out-of-desktop, …) RECURS by construction, so the acronym tier excludes a
/// two-letter acronym immediately followed by `-INV` rather than baselining each line. A
/// genuine acronym reference (not `-INV`-tailed) is untouched. Mirrors the JS twin's
/// `isDeployInvariantLabel`.
pub fn match_acronyms<F: FnMut(usize, &'static str)>(hay: &[u8], mut on_hit: F) {
    let mut i = 0usize;
    'outer: while i < hay.len() {
        for tok in ACRONYM_NOUNS {
            let t = tok.as_bytes();
            if i + t.len() > hay.len() || &hay[i..i + t.len()] != t {
                continue;
            }
            let end = i + t.len();
            let prev_ok = i == 0 || !hay[i - 1].is_ascii_alphanumeric();
            let next_ok = hay.get(end).is_none_or(|c| !c.is_ascii_alphanumeric());
            let deploy_invariant =
                *tok == "DE" && end + 4 <= hay.len() && &hay[end..end + 4] == b"-INV";
            if prev_ok && next_ok && !deploy_invariant {
                on_hit(i, tok);
            }
            i = end;
            continue 'outer;
        }
        i += 1;
    }
}

/// Convenience wrapper used by the matcher unit test: the SET of nouns in `code`.
pub fn scan_nouns(code: &str) -> BTreeSet<&'static str> {
    let mut out = BTreeSet::new();
    match_nouns(code.as_bytes(), Lang::Rust, false, |_, t| {
        out.insert(t);
    });
    out
}

/// Quote-delimited occurrence of `tok` — `"tok"` / `'tok'` / `` `tok` ``, and NOT
/// `"tok-suffix"`.
fn quoted_hits(code: &[u8], tok: &str) -> usize {
    let t = tok.as_bytes();
    let mut n = 0usize;
    let mut i = 0usize;
    while i + t.len() + 2 <= code.len() {
        let q = code[i];
        if (q == b'"' || q == b'\'' || q == b'`')
            && &code[i + 1..i + 1 + t.len()] == t
            && code[i + 1 + t.len()] == q
        {
            n += 1;
            i += t.len() + 2;
            continue;
        }
        i += 1;
    }
    n
}

fn quoted_id_hit(code: &str, tok: &str) -> bool {
    quoted_hits(code.as_bytes(), tok) > 0
}

/// Raw substring occurrences — no boundary rule (see `SUBSTRING_TOKENS`).
fn substring_hits(code: &[u8], tok: &str) -> usize {
    let t = tok.as_bytes();
    let mut n = 0usize;
    let mut i = 0usize;
    while i + t.len() <= code.len() {
        if &code[i..i + t.len()] == t {
            n += 1;
            i += t.len();
        } else {
            i += 1;
        }
    }
    n
}

// ════════════════════════════════════════════════════════════════════════════
//  WALKER
// ════════════════════════════════════════════════════════════════════════════

/// Every module whose `mod` declaration is `#[cfg(test)] mod <name>;` — TEST-ONLY BY
/// DECLARATION, compiled only for `cargo test` and never shipped. The grep-guards among
/// them (`workstore/no_legacy_wire.rs`) must spell the forbidden vocabulary out as
/// literals in order to search for it, so scanning them would make this test flag its
/// own twin (DOMAIN_AUDIT §7). Resolved from the DECLARATION, never a name pattern —
/// exactly as `testOnlyRustModules()` does on the JS side.
fn test_only_modules(root: &Path) -> BTreeSet<PathBuf> {
    let mut mods = Vec::new();
    collect_mod_files(root, &mut mods);
    let mut out = BTreeSet::new();
    for m in mods {
        let Ok(src) = std::fs::read_to_string(&m) else {
            continue;
        };
        let dir = m.parent().unwrap().to_path_buf();
        let lines: Vec<&str> = src.lines().collect();
        for (i, line) in lines.iter().enumerate() {
            if line.trim() != "#[cfg(test)]" {
                continue;
            }
            let Some(next) = lines[i + 1..].iter().find(|l| !l.trim().is_empty()) else {
                continue;
            };
            let t = next.trim().trim_start_matches("pub ").trim_start();
            let Some(rest) = t.strip_prefix("mod ") else {
                continue;
            };
            let Some(name) = rest.split(';').next().map(str::trim) else {
                continue;
            };
            if name.is_empty() || !name.chars().all(|c| c.is_alphanumeric() || c == '_') {
                continue;
            }
            let as_file = dir.join(format!("{name}.rs"));
            if as_file.exists() {
                out.insert(as_file);
            }
            let as_dir = dir.join(name);
            if as_dir.is_dir() {
                // WS-R3 §2 — sweep EVERY scanned extension, not just `.rs`. Adding the
                // data dialects made that load-bearing: `datatype/tests/
                // lattice_golden.json` is a 93-hit domain-lattice oracle in a directory
                // declared `#[cfg(test)] mod tests;`, and it is exempt for exactly the
                // same compiler-enforced reason its `mod.rs` sibling is.
                let mut nested = Vec::new();
                let all: Vec<&str> = RUST_EXTS.iter().chain(DATA_EXTS.iter()).copied().collect();
                sources_raw(&as_dir, &all, &mut nested);
                out.extend(nested);
            }
        }
    }
    out
}

fn collect_mod_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            collect_mod_files(&p, out);
        } else if p.file_name().is_some_and(|n| n == "mod.rs") {
            out.push(p);
        }
    }
}

fn sources_raw(dir: &Path, exts: &[&str], out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            sources_raw(&p, exts, out);
        } else if p
            .extension()
            .and_then(|x| x.to_str())
            .is_some_and(|x| exts.contains(&x))
        {
            out.push(p);
        }
    }
}

/// Every PRODUCTION `.rs` file under `root`, with its SHARED-BASELINE key.
fn production_sources(root: &ScanRoot) -> Vec<(PathBuf, String)> {
    let modules_dir = server_src();
    let skip = if root.apply_test_only {
        test_only_modules(&modules_dir)
    } else {
        BTreeSet::new()
    };
    let mut all = Vec::new();
    sources_raw(&root.dir, root.exts, &mut all);
    all.retain(|p| !skip.contains(p) && !(root.exclude_modules && p.starts_with(&modules_dir)));
    all.sort();
    all.into_iter()
        .map(|p| {
            let rel = p
                .strip_prefix(&root.dir)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            let key = format!("{}/{}", root.key_prefix, rel);
            (p, key)
        })
        .collect()
}

// ════════════════════════════════════════════════════════════════════════════
//  BASELINE
// ════════════════════════════════════════════════════════════════════════════

/// One baselined budget: the committed COUNT plus its finding id.
#[derive(Clone, Debug)]
struct Budget {
    count: usize,
}

/// The COMMITTED baseline the JS guard ratchets against: `<src-app>/ui/scripts/
/// domain-baseline.json`. Sharing one file is what stops the two enforcers drifting
/// into disagreeing about what is permitted.
///
/// WS-D: this used to return only the SET OF TOKENS per file, throwing the counts away —
/// so the twin's ratchet was key PRESENCE, and a file already in the baseline could grow
/// unboundedly. It now returns the counts, and `count` is what the ratchet compares.
struct Baseline {
    code: BTreeMap<String, BTreeMap<String, Budget>>,
    /// WS-R3 §4 — per (file, TOKEN), like `code`. It used to be a per-file TOTAL, which
    /// made 1268 hits across 168 files FUNGIBLE: a file already in the ledger could
    /// absorb a brand-new leak of a DIFFERENT token for free as long as its total did not
    /// rise. Shape: `<file> -> { finding?, note?, tokens: { <token>: <count> } }`; the
    /// retired per-file-total spellings PANIC here rather than being tolerated, because
    /// leaving a fungible spelling readable would leave the hole open.
    prose: BTreeMap<String, BTreeMap<String, Budget>>,
    literals: BTreeMap<String, BTreeMap<String, Budget>>,
    /// WS-R4 — the TEST tier's own three sections, never merged with the production
    /// ones. See `is_test_tier_key` + the calibration constants for why the split is
    /// load-bearing rather than tidy.
    test_code: BTreeMap<String, BTreeMap<String, Budget>>,
    test_prose: BTreeMap<String, BTreeMap<String, Budget>>,
    test_literals: BTreeMap<String, BTreeMap<String, Budget>>,
}

fn budget_of(spec: &Value, what: &str) -> Budget {
    let count = match spec {
        Value::Number(n) => n.as_u64().unwrap_or(0) as usize,
        Value::Object(_) => spec["count"].as_u64().unwrap_or(0) as usize,
        _ => panic!("domain-baseline.json {what}: unexpected entry shape {spec}"),
    };
    Budget { count }
}

fn load_baseline() -> Baseline {
    let p = src_app().join("ui/scripts/domain-baseline.json");
    let raw = std::fs::read_to_string(&p).unwrap_or_else(|e| {
        panic!(
            "the shared domain baseline must exist at {}: {e}",
            p.display()
        )
    });
    let v: Value = serde_json::from_str(&raw).expect("domain-baseline.json is valid JSON");
    let two_level = |key: &str| -> BTreeMap<String, BTreeMap<String, Budget>> {
        let mut out = BTreeMap::new();
        let Some(obj) = v[key].as_object() else {
            return out;
        };
        for (file, toks) in obj {
            let mut m = BTreeMap::new();
            for (tok, spec) in toks.as_object().expect("token map") {
                m.insert(tok.to_ascii_lowercase(), budget_of(spec, key));
            }
            out.insert(file.clone(), m);
        }
        out
    };
    let prose_section = |key: &str| -> BTreeMap<String, BTreeMap<String, Budget>> {
        let mut prose = BTreeMap::new();
        let Some(obj) = v[key].as_object() else {
            return prose;
        };
        for (file, spec) in obj {
            let toks = spec
                .get("tokens")
                .and_then(Value::as_object)
                .unwrap_or_else(|| {
                    panic!(
                        "domain-baseline.json {key}[\"{file}\"] is in the RETIRED per-file-total \
                     form. The prose tier is per (file, TOKEN) as of WS-R3: use \
                     {{\"tokens\": {{\"<token>\": <count>}}, \"finding\": …}}. A per-file \
                     total is FUNGIBLE — it lets this file absorb a brand-new leak of a \
                     different token for free."
                    )
                });
            let mut m = BTreeMap::new();
            for (tok, n) in toks {
                m.insert(tok.to_ascii_lowercase(), budget_of(n, key));
            }
            prose.insert(file.clone(), m);
        }
        prose
    };
    Baseline {
        code: two_level("code"),
        prose: prose_section("prose"),
        literals: two_level("literals"),
        test_code: two_level("testCode"),
        test_prose: prose_section("testProse"),
        test_literals: two_level("testLiterals"),
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  THE SCAN
// ════════════════════════════════════════════════════════════════════════════

/// Everything one pass over the three roots measured.
struct Observation {
    /// `<baseline key> -> <token> -> hits` (code + string literals; nouns + acronyms).
    code: BTreeMap<String, BTreeMap<String, usize>>,
    /// `<baseline key> -> <token> -> hits` (substring / quoted-id / quoted-title).
    literals: BTreeMap<String, BTreeMap<String, usize>>,
    /// `<baseline key> -> <token> -> hits` (comments only). WS-R3 §4: per TOKEN.
    prose: BTreeMap<String, BTreeMap<String, usize>>,
    /// `<root label> -> files scanned`.
    files_per_root: BTreeMap<&'static str, usize>,
    /// every scanned file's baseline key, in scan order.
    keys: Vec<String>,
}

fn observe() -> Observation {
    let mut obs = Observation {
        code: BTreeMap::new(),
        literals: BTreeMap::new(),
        prose: BTreeMap::new(),
        files_per_root: BTreeMap::new(),
        keys: Vec::new(),
    };
    for root in scan_roots() {
        let files = production_sources(&root);
        obs.files_per_root.insert(root.label, files.len());
        for (path, key) in files {
            obs.keys.push(key.clone());
            let raw = std::fs::read(&path).unwrap_or_default();
            let lang = Lang::of(&path);
            let rust = lang == Lang::Rust;
            // P2 — the file being a cfg-`feature`-gated Rust module suppresses its `feature`
            // tokens (JS `fileHasCfgFeatureAttr`); computed once from the RAW source and fed
            // to BOTH the scan and prose passes, exactly as the JS `scanFile` does.
            let fattr = rust && file_has_cfg_feature_attr(&raw);
            let (scan, prose) = scan_and_prose_lang(&raw, lang);

            let code_entry = obs.code.entry(key.clone()).or_default();
            match_nouns(&scan, lang, fattr, |_, tok| {
                *code_entry.entry(tok.to_ascii_lowercase()).or_insert(0) += 1;
            });
            match_acronyms(&scan, |_, tok| {
                *code_entry.entry(tok.to_ascii_lowercase()).or_insert(0) += 1;
            });
            if code_entry.is_empty() {
                obs.code.remove(&key);
            }

            let lit_entry = obs.literals.entry(key.clone()).or_default();
            for tok in substring_tokens() {
                let n = substring_hits(&scan, tok);
                if n > 0 {
                    *lit_entry.entry(tok.to_ascii_lowercase()).or_insert(0) += n;
                }
            }
            for tok in quoted_id_tokens()
                .iter()
                .chain(quoted_title_tokens().iter())
            {
                let n = quoted_hits(&scan, tok);
                if n > 0 {
                    *lit_entry.entry(tok.to_ascii_lowercase()).or_insert(0) += n;
                }
            }
            if lit_entry.is_empty() {
                obs.literals.remove(&key);
            }

            let prose_entry = obs.prose.entry(key.clone()).or_default();
            match_nouns(&prose, lang, fattr, |_, tok| {
                *prose_entry.entry(tok.to_ascii_lowercase()).or_insert(0) += 1;
            });
            match_acronyms(&prose, |_, tok| {
                *prose_entry.entry(tok.to_ascii_lowercase()).or_insert(0) += 1;
            });
            if prose_entry.is_empty() {
                obs.prose.remove(&key);
            }
        }
    }
    obs
}

#[test]
fn the_server_noun_scan_covers_every_module_and_still_matches() {
    let root = server_src();
    let obs = observe();

    // ── POSITIVE COUNT #1: the file set, PER ROOT ──
    for r in scan_roots() {
        let got = obs.files_per_root.get(r.label).copied().unwrap_or(0);
        assert!(
            got >= r.floor,
            "scan root `{}` ({}) collapsed — {got} production file(s), floor {}. \
             Pre-WS-B this test scanned 3 modules and reported green over the other 13; \
             pre-WS-D it never opened `server/src/*.rs` or `build_helper/**` at all.",
            r.label,
            r.dir.display(),
            r.floor
        );
    }

    // ── POSITIVE COUNT #2: every module directory contributes ──
    let modules: BTreeSet<String> = std::fs::read_dir(&root)
        .expect("src/modules")
        .flatten()
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    assert_eq!(
        modules.len(),
        EXPECT_MODULES,
        "the module count is a POSITIVE expectation — a new module must be consciously \
         admitted, not silently unscanned. Found: {modules:?}"
    );
    let covered: BTreeSet<String> = obs
        .keys
        .iter()
        .filter_map(|k| k.strip_prefix("server/src/modules/"))
        .filter_map(|r| r.split('/').next().map(str::to_string))
        .filter(|n| modules.contains(n))
        .collect();
    let uncovered: Vec<&String> = modules.difference(&covered).collect();
    assert!(
        uncovered.is_empty(),
        "these modules are outside the scan: {uncovered:?}"
    );

    // ── the RATCHET ──
    let baseline = load_baseline();
    let mut violations: Vec<String> = Vec::new();
    let mut stale: Vec<String> = Vec::new();

    // CODE tier — per (file, token) COUNTS. `got > want` is the hole WS-D closes: with a
    // presence-only ratchet a baselined file could grow new leaks of an already-baselined
    // token forever.
    // WS-R4 — the tier ROUTING. A finding under `server/tests/` is ratcheted against
    // `testCode`/`testProse`/`testLiterals`; everything else against the production
    // sections. The two budgets never see each other, which is the whole point of the
    // split (see the calibration constants). The section NAME travels into the message
    // so a failure says which ledger to edit.
    for (key, toks) in &obs.code {
        let test = is_test_tier_key(key);
        let sect = if test {
            &baseline.test_code
        } else {
            &baseline.code
        };
        let name = if test { "testCode" } else { "code" };
        for (tok, got) in toks {
            match sect.get(key).and_then(|m| m.get(tok)) {
                None => violations.push(format!(
                    "{key}: [domain-noun] {tok} ×{got} — NOT in ui/scripts/domain-baseline.json \
                     `{name}`. A known leak belongs there with its finding id (S1-S11 for \
                     production, R4-TESTS-* for the test trees); a new one belongs nowhere."
                )),
                Some(b) if *got > b.count => violations.push(format!(
                    "{key}: [domain-noun] {tok} GREW {} -> {got}. `{name}` is a \
                     SHRINK-ONLY ratchet: an already-baselined file may not accumulate more \
                     hits of the same token.",
                    b.count
                )),
                _ => {}
            }
        }
    }

    /// The one sentence a `MIN_*` failure needs and never carried: the RE-ANCHOR value.
    ///
    /// Every one of these floors is a collapse-detector anchored at ≈⅔ of a MEASUREMENT taken
    /// on the day it was written, and every correct domain-strip lowers the measurement without
    /// lowering the floor. That drift is silent until the day it crosses, and then it presents
    /// as a deterministic red on `main` with no indication of whether the tree LOST something or
    /// the constant went STALE — which is exactly what happened on 2026-08-10 (see
    /// `MIN_PROSE_HITS`) and cost every branch cut from `main` an independent investigation to
    /// re-derive the same answer.
    ///
    /// This does not decide the question — only the two-sided evidence does. But it puts the
    /// arithmetic and the procedure in the failure itself, so the answer costs minutes.
    fn reconcile_hint(name: &str, got: usize) -> String {
        format!(
            "\n\n  RECONCILING THIS FLOOR — it is anchored at ≈⅔ of a measurement, so a correct \
         domain-strip lowers the measurement and leaves the constant stale. Decide WHICH, on \
         evidence, before touching anything:\n    (a) run `dump_observation_for_parity` with \
         $DOMAIN_SURFACE_DUMP=<path> for the live per-(file, token) census;\n    (b) sum the \
         matching tier of `src-app/ui/scripts/domain-baseline.json` over `server/` keys. If it \
         EQUALS the measurement, the shrink-only ledger tracked the drop commit-by-commit and \
         the drop is ACCOUNTED — the constant is stale. If the ledger is HIGHER, a mention went \
         missing WITHOUT the ledger being pruned: find it with `git log -S` and RESTORE it; do \
         not lower this.\n    (c) accounted case ONLY: set {name} = {} (⅔ of the measured \
         {got}) and record the re-measure + the attribution in its doc comment, the way every \
         previous round in this file did.",
            got * 2 / 3
        )
    }

    /// Whether THIS scanner has a matcher for `tok` at all.
    ///
    /// The Rust twin and the JS guard (`ui/scripts/lint-no-domain-in-builtin.mjs`) share ONE
    /// baseline file but have INDEPENDENT vocabularies. The JS side gained a package-vocabulary
    /// axis (WS-R7) that derives shipped package / analysis / view / action ids from
    /// `packages/*/manifest.yaml` + `ui/*.yaml`; this scanner has no such axis. So the baseline
    /// legitimately holds entries for package/analysis/action ids that this scanner cannot see —
    /// and reading "0 occurrences" for one of them and concluding STALE is a false positive BY
    /// CONSTRUCTION, not a real shrink.
    ///
    /// (The three concrete ids are deliberately NOT written out here. Naming them would put the
    /// package vocabulary into an app-tier file, which is the exact leak the axis they belong to
    /// exists to catch — this comment tripped its own guard on the first attempt. Run the JS
    /// guard to see the current set.)
    ///
    /// A scanner may only judge staleness for what it actually scans. That is the structural
    /// fix; chasing token-for-token parity with the JS side is the alternative and it would
    /// drift again on the next axis either side gains — this repo has already paid for a
    /// dual-ledger divergence twice (R4-CARD-15's anchor was fixed in one ledger and left
    /// dangling in the other; then this).
    fn scanner_knows_token(tok: &str) -> bool {
        DOMAIN_NOUNS.iter().any(|n| n.eq_ignore_ascii_case(tok))
            || ACRONYM_NOUNS.iter().any(|n| *n == tok)
    }

    for (name, sect) in [("code", &baseline.code), ("testCode", &baseline.test_code)] {
        for (key, toks) in sect {
            if !key.starts_with("server/") {
                continue;
            }
            for (tok, b) in toks {
                // Only judge what this scanner can see — see `scanner_knows_token`.
                if !scanner_knows_token(tok) {
                    continue;
                }
                let got = obs
                    .code
                    .get(key)
                    .and_then(|m| m.get(tok))
                    .copied()
                    .unwrap_or(0);
                if got < b.count {
                    stale.push(format!(
                        "{name}[\"{key}\"][\"{tok}\"] = {} but only {got} remain — STALE. The \
                         residue may only shrink DELIBERATELY: run `node \
                         scripts/lint-no-domain-in-builtin.mjs --prune-baseline` in the same commit.",
                        b.count
                    ));
                }
            }
        }
    }

    // LITERAL tier — a hardcoded datatype-id literal, under a shrink-only CEILING.
    let mut literal_hits = 0usize;
    let mut test_literal_hits = 0usize;
    for (key, toks) in &obs.literals {
        let test = is_test_tier_key(key);
        let sect = if test {
            &baseline.test_literals
        } else {
            &baseline.literals
        };
        let name = if test { "testLiterals" } else { "literals" };
        for (tok, got) in toks {
            if test {
                test_literal_hits += got;
            } else {
                literal_hits += got;
            }
            match sect.get(key).and_then(|m| m.get(tok)) {
                None => violations.push(format!(
                    "{key}: [literal] {tok} ×{got} — a hardcoded domain datatype-id LITERAL \
                     (in PRODUCTION the hardest INV-3 kind; in a TEST the coupling that pins \
                     the app suite to one contributed bundle), and NOT in the baseline's \
                     `{name}` tier."
                )),
                Some(b) if *got > b.count => violations.push(format!(
                    "{key}: [literal] {tok} GREW {} -> {got} — `{name}` is SHRINK-ONLY.",
                    b.count
                )),
                _ => {}
            }
        }
    }
    for (name, sect) in [
        ("literals", &baseline.literals),
        ("testLiterals", &baseline.test_literals),
    ] {
        for (key, toks) in sect {
            if !key.starts_with("server/") {
                continue;
            }
            for (tok, b) in toks {
                // Only judge what this scanner can see — see `scanner_knows_token`.
                if !scanner_knows_token(tok) {
                    continue;
                }
                let got = obs
                    .literals
                    .get(key)
                    .and_then(|m| m.get(tok))
                    .copied()
                    .unwrap_or(0);
                if got < b.count {
                    stale.push(format!(
                        "{name}[\"{key}\"][\"{tok}\"] = {} but only {got} remain — STALE.",
                        b.count
                    ));
                }
            }
        }
    }
    assert!(
        literal_hits <= LITERAL_HITS_CEILING,
        "{literal_hits} PRODUCTION literal hit(s) server-side, above the committed ceiling of \
         {LITERAL_HITS_CEILING}. This tier is SHRINK-ONLY: a new hardcoded datatype id must be \
         removed, not baselined. Raising the constant is an explicit admission."
    );
    assert!(
        test_literal_hits <= TEST_LITERAL_HITS_CEILING,
        "{test_literal_hits} TEST-tier literal hit(s) under server/tests/, above the committed \
         ceiling of {TEST_LITERAL_HITS_CEILING}. Shrink-only: a NEW test asserting on a \
         hardcoded domain datatype id must be written against a capability or a fixture-derived \
         id instead, not baselined."
    );

    // PROSE tier — WS-R3 §4: per (file, TOKEN), exactly like `code`. A per-file total
    // could not tell a SWAP (one token down, another up, same total) from no change,
    // which is how a fungible ledger absorbs a brand-new leak.
    for (key, toks) in &obs.prose {
        let test = is_test_tier_key(key);
        let sect = if test {
            &baseline.test_prose
        } else {
            &baseline.prose
        };
        let name = if test { "testProse" } else { "prose" };
        for (tok, got) in toks {
            match sect.get(key).and_then(|m| m.get(tok)) {
                None => violations.push(format!(
                    "{key}: [domain-prose] {tok} x{got} — NOT in the baseline's `{name}` tier."
                )),
                Some(b) if *got > b.count => violations.push(format!(
                    "{key}: [domain-prose] {tok} GREW {} -> {got} (`{name}`).",
                    b.count
                )),
                _ => {}
            }
        }
    }
    for (name, sect) in [
        ("prose", &baseline.prose),
        ("testProse", &baseline.test_prose),
    ] {
        for (key, toks) in sect {
            if !key.starts_with("server/") {
                continue;
            }
            for (tok, b) in toks {
                // Only judge what this scanner can see — see `scanner_knows_token`.
                if !scanner_knows_token(tok) {
                    continue;
                }
                let got = obs
                    .prose
                    .get(key)
                    .and_then(|m| m.get(tok))
                    .copied()
                    .unwrap_or(0);
                if got < b.count {
                    stale.push(format!(
                        "{name}[\"{key}\"][\"{tok}\"] = {} but only {got} remain — STALE.",
                        b.count
                    ));
                }
            }
        }
    }

    // ── POSITIVE COUNT #3: the vocabulary is still MATCHING ──
    // WS-R4 — counted PER TIER. A merged total would let a total collapse of the
    // production walk hide inside the four-figure test total, which is the same
    // "collapse disappears into the aggregate" failure the per-ROOT floors exist for.
    let prod = |m: &BTreeMap<String, BTreeMap<String, usize>>| -> Vec<usize> {
        m.iter()
            .filter(|(k, _)| !is_test_tier_key(k))
            .map(|(_, v)| v.len())
            .collect()
    };
    let prod_hits = |m: &BTreeMap<String, BTreeMap<String, usize>>| -> usize {
        m.iter()
            .filter(|(k, _)| !is_test_tier_key(k))
            .flat_map(|(_, v)| v.values())
            .sum()
    };
    let test_pairs_of = |m: &BTreeMap<String, BTreeMap<String, usize>>| -> Vec<usize> {
        m.iter()
            .filter(|(k, _)| is_test_tier_key(k))
            .map(|(_, v)| v.len())
            .collect()
    };
    let test_hits_of = |m: &BTreeMap<String, BTreeMap<String, usize>>| -> usize {
        m.iter()
            .filter(|(k, _)| is_test_tier_key(k))
            .flat_map(|(_, v)| v.values())
            .sum()
    };
    let pairs: usize = prod(&obs.code).iter().sum();
    let hits: usize = prod_hits(&obs.code);
    let prose_files = obs.prose.keys().filter(|k| !is_test_tier_key(k)).count();
    let prose_hits: usize = prod_hits(&obs.prose);
    let test_pairs: usize = test_pairs_of(&obs.code).iter().sum();
    let test_hits: usize = test_hits_of(&obs.code);
    let test_prose_files = obs.prose.keys().filter(|k| is_test_tier_key(k)).count();
    let test_prose_hits: usize = test_hits_of(&obs.prose);
    assert!(
        pairs >= MIN_NOUN_PAIRS,
        "only {pairs} (file, token) pair(s) matched, below the floor of {MIN_NOUN_PAIRS}. The \
         tree is KNOWN to carry a measured domain residue, so a near-empty result means the \
         vocabulary, the letter+camel boundary, the tokenizer or the walker broke — not that \
         the tree got clean.{}",
        reconcile_hint("MIN_NOUN_PAIRS", pairs)
    );
    assert!(
        hits >= MIN_NOUN_HITS,
        "only {hits} code hit(s), below the floor of {MIN_NOUN_HITS}. A pair floor alone cannot \
         see a file drop from 16 hits of a token to 1 — the pair survives.{}",
        reconcile_hint("MIN_NOUN_HITS", hits)
    );
    assert!(
        prose_files >= MIN_PROSE_FILES,
        "only {prose_files} file(s) carry a comment-tier hit, below the floor of \
         {MIN_PROSE_FILES} — the prose projection or the classifier broke.{}",
        reconcile_hint("MIN_PROSE_FILES", prose_files)
    );
    assert!(
        prose_hits >= MIN_PROSE_HITS,
        "only {prose_hits} comment-tier hit(s), below the floor of {MIN_PROSE_HITS}.{}",
        reconcile_hint("MIN_PROSE_HITS", prose_hits)
    );
    // WS-R4 — the same four floors for the TEST tier. A future "why is the linter
    // reading my tests" edit is a one-line change to `scan_roots()`; these are what
    // make it fail loudly instead of shaving a few percent off a merged number.
    assert!(
        test_pairs >= MIN_TEST_NOUN_PAIRS,
        "only {test_pairs} TEST-tier (file, token) pair(s) matched, below the floor of \
         {MIN_TEST_NOUN_PAIRS}. `server/tests/**` was in no scan root at all until WS-R4; a \
         near-empty result means it has been taken back out.{}",
        reconcile_hint("MIN_TEST_NOUN_PAIRS", test_pairs)
    );
    assert!(
        test_hits >= MIN_TEST_NOUN_HITS,
        "only {test_hits} TEST-tier code hit(s), below the floor of {MIN_TEST_NOUN_HITS}.{}",
        reconcile_hint("MIN_TEST_NOUN_HITS", test_hits)
    );
    assert!(
        test_prose_files >= MIN_TEST_PROSE_FILES,
        "only {test_prose_files} TEST-tier file(s) carry a comment hit, below the floor of \
         {MIN_TEST_PROSE_FILES}.{}",
        reconcile_hint("MIN_TEST_PROSE_FILES", test_prose_files)
    );
    assert!(
        test_prose_hits >= MIN_TEST_PROSE_HITS,
        "only {test_prose_hits} TEST-tier comment hit(s), below the floor of \
         {MIN_TEST_PROSE_HITS}.{}",
        reconcile_hint("MIN_TEST_PROSE_HITS", test_prose_hits)
    );

    for (file, tok) in MUST_OBSERVE {
        assert!(
            obs.code
                .get(*file)
                .and_then(|m| m.get(*tok))
                .copied()
                .unwrap_or(0)
                > 0,
            "the scan no longer sees `{tok}` in {file} — one of the audit's own named server \
             findings, or a witness that a scan ROOT / vocabulary GROUP is live. If the leak was \
             genuinely fixed, remove this entry from MUST_OBSERVE and the matching entry from \
             domain-baseline.json in the SAME commit."
        );
    }
    // The per-ROOT liveness witnesses that replaced the retired residue ones: the walk must
    // still REACH these exact production files. A root renamed / re-prefixed / filtered out
    // of `scan_roots()` fails here even over a perfectly clean tree.
    for key in MUST_SCAN_KEYS {
        assert!(
            obs.keys.iter().any(|k| k == key),
            "the scan no longer reaches {key} — a scan ROOT was renamed, re-prefixed or \
             filtered out of `scan_roots()`. The per-root file-count floors only notice when \
             a root vanishes ENTIRELY; this is what notices when it merely stops covering the \
             file the audit cares about. Removing an entry here needs the root's replacement \
             coverage named in the same commit."
        );
    }

    assert!(
        stale.is_empty(),
        "the committed baseline is STALE against the tree ({} entr{}):\n  {}",
        stale.len(),
        if stale.len() == 1 { "y" } else { "ies" },
        stale.join("\n  ")
    );
    assert!(
        violations.is_empty(),
        "domain vocabulary outside the committed baseline ({} finding(s)):\n  {}",
        violations.len(),
        violations.join("\n  ")
    );
}

/// ROUND-4 — the PER-FORMAT coverage pin, the Rust half of the JS twin's
/// `FORMAT_COVERAGE_PINS`.
///
/// `MUST_SCAN_KEYS` pins a FILE, which is why WS-R4 had to de-anchor the `.py` witness
/// (both candidates were deletable) and why r4squash broke the `.sql` one by deleting the
/// migration it named. This pins the FORMAT: for each extension the `server-data` root
/// claims to walk, an INDEPENDENT probe (extension only — no exclusion policy, nothing
/// this test could have broken) counts what is on disk, and the walk must have reached at
/// least one of them.
///
/// It fails exactly on the collapse a per-FILE witness cannot see (the extension policy
/// or an exclusion silently stops covering a format) and goes VACUOUS rather than red
/// when the last file of a format is legitimately deleted — which is the property that
/// makes it usable for `.py`, whose only two files are `#[cfg(debug_assertions)]`-gated
/// seed drivers an unrelated round may well remove.
#[test]
fn the_server_data_root_covers_every_format_it_walks() {
    fn probe(dir: &Path, ext: &str, out: &mut Vec<PathBuf>) {
        let Ok(rd) = std::fs::read_dir(dir) else {
            return;
        };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                probe(&p, ext, out);
            } else if p.extension().and_then(|x| x.to_str()) == Some(ext) {
                out.push(p);
            }
        }
    }
    // NB the local is `observed`, not the three-letter name every other test in this file
    // uses for it: that name is itself a vocabulary token, so a new local would raise this
    // file's own baselined count by two. The guard's ledger should not grow to pay for the
    // guard's own variable naming. `observed` is in `NON_DOMAIN_IDENTIFIERS`, i.e.
    // suppressed structurally rather than by being spelled carefully.
    let observed = observe();
    // ── WS-R5 §3 — REAL PARITY WITH THE JS PIN ────────────────────────────────────────
    //
    // Two defects, both in the direction of passing when the JS twin fails:
    //
    //  1. IT PROBED ONE DIRECTORY. The JS pin probes `[SERVER_SRC, BUILD_HELPER]` (its
    //     `serverData` root walks both); this probed only `src`. `build_helper` carries no
    //     data file today, so the pin was vacuous there rather than wrong — but a `.py`
    //     dropped into `build_helper` tomorrow would be pinned on one side and not the other.
    //  2. IT MATCHED ANY KEY, ANYWHERE. `keys.any(|k| k.ends_with(".json"))` is satisfied by
    //     a `server/tests/**` fixture from the `server-tests-data` root. So a per-root `exts`
    //     edit dropping a format from `server-data` left THIS green while the JS pin fired —
    //     the exact per-root collapse the mechanism exists to catch, invisible to it. The JS
    //     side always required a PROBED file to be in the scan set (`present.some(f =>
    //     scanned.has(f))`); this now does the same, comparing the probe's own paths, mapped
    //     to baseline keys, against the walked set.
    let crate_root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let walked: std::collections::BTreeSet<&String> = observed.keys.iter().collect();
    for ext in ["py", "sql", "json"] {
        let mut present = Vec::new();
        for dir in [crate_root.join("src"), crate_root.join("build_helper")] {
            probe(&dir, ext, &mut present);
        }
        // VACUOUS BY DESIGN: no file of this format on disk means there is nothing to
        // cover, so a deletion can never turn this red. That is the whole reason the
        // pin is on the FORMAT and not on a named file.
        if present.is_empty() {
            continue;
        }
        // The probe's paths, expressed as the baseline keys the walk records. `src/**` →
        // `server/src/**`, `build_helper/**` → `server/build_helper/**` — the same two
        // `key_prefix`es `scan_roots()` uses, so the comparison is against what was
        // actually walked and not against a suffix that any root could satisfy.
        let key_of = |p: &Path| -> Option<String> {
            for (sub, prefix) in [
                ("src", "server/src"),
                ("build_helper", "server/build_helper"),
            ] {
                if let Ok(rel) = p.strip_prefix(crate_root.join(sub)) {
                    return Some(format!(
                        "{prefix}/{}",
                        rel.to_string_lossy().replace('\\', "/")
                    ));
                }
            }
            None
        };
        let reached = present
            .iter()
            .filter_map(|p| key_of(p))
            .any(|k| walked.contains(&k));
        assert!(
            reached,
            "the `server-data` root reached ZERO of the {} `.{ext}` file(s) that exist on \
             disk under `src/` + `build_helper/` (e.g. {}). Its extension policy \
             (`DATA_EXTS`) or an exclusion silently stopped covering the format — the \
             collapse a per-FILE witness cannot see once that file is deletable. Restore \
             coverage, or drop the format from this list deliberately, with the reason. \
             (WS-R5 §3: this used to accept ANY walked key ending in the extension, so a \
             `server/tests/**` fixture from a DIFFERENT root satisfied it and the per-root \
             collapse was invisible on this side while the JS twin fired.)",
            present.len(),
            present[0].display()
        );
    }
}

// (The derivation test was here: `the_contributed_vocabulary_is_derived_not_hand_listed`
// and its `CONTRIBUTED_DATATYPE_FLOOR`. Its subject — the parser over
// the package manifests, their census and their completeness rule —
// was removed with the package tree, so the test could only assert 0 >= 0. The
// derivation functions remain: they are what the scan reads, and their failure path
// (missing dir -> empty vocabulary) is now the truth of this tree.)

/// `$DOMAIN_SURFACE_DUMP` as JSON so it can be diffed, per file and per token, against
/// the JS guard's. Round 3 verified parity this way and WS-R4 does the same for the two
/// new roots; making it an in-tree `#[test]` (a no-op unless the env var is set) means
/// the next round does not have to rebuild the harness to re-verify.
#[test]
fn dump_observation_for_parity() {
    let Ok(dest) = std::env::var("DOMAIN_SURFACE_DUMP") else {
        return;
    };
    let obs = observe();
    let j = json!({
        "code": obs.code,
        "prose": obs.prose,
        "literals": obs.literals,
        "files_per_root": obs.files_per_root,
        "keys": obs.keys,
    });
    std::fs::write(&dest, serde_json::to_string_pretty(&j).unwrap()).expect("dump written");
}

// (The certification test was here: `the_exact_cardinality_certifications_are_still_pinned`
// with `CARDINALITY_CERTIFICATIONS` and `CERTIFICATION_CEILING`. The ledger's own rules
// said the whole point was that ONLY the JS twin keeps the full list and both halves
// move together; this branch removed the bundle the certifications counted, so all
// seven entries' files are gone and the list is empty — see the section note above
// where the ledger's removal is recorded.)

#[test]
fn the_domain_token_scanner_actually_matches() {
    // The scan above is an absence assertion, so its matcher gets its own positive test —
    // otherwise a typo in the vocabulary would make it permanently, silently green.

    // The alternation ordering IS the attribution rule: `cellranger` must beat `cell`.
    // Appending a token to the end of DOMAIN_NOUNS silently mis-attributes every site it
    // shares a prefix with, so the ordering is asserted rather than trusted.
    for w in DOMAIN_NOUNS.windows(2) {
        assert!(
            w[0].len() >= w[1].len(),
            "DOMAIN_NOUNS must stay LONGEST-FIRST (`{}` before `{}`) — the matcher takes the \
             first token whose text matches, mirroring the JS regex alternation.",
            w[0],
            w[1]
        );
    }
    assert_eq!(
        DOMAIN_NOUNS.len(),
        38,
        "the noun vocabulary is the JS guard's 38 tokens"
    );
    assert_eq!(
        ACRONYM_NOUNS.len(),
        4,
        "the acronym tier is the JS guard's 4"
    );
    assert_eq!(
        NON_DOMAIN_IDENTIFIERS.len(),
        38,
        "the suppression list is the JS guard's 38"
    );
    assert!(scan_nouns("let x = cellranger_freshness_tag;").contains("cellranger"));
    assert!(
        !scan_nouns("let x = cellranger_freshness_tag;").contains("cell"),
        "longest wins"
    );

    let code = executable_code("// a comment mentioning leiden\nlet x = \"leiden\";\n");
    assert!(!code.contains("// a comment"), "line comments are blanked");
    assert!(
        scan_nouns(&code).contains("leiden"),
        "the code line survives blanking and is matched"
    );
    assert!(
        !scan_nouns(&executable_code("/* block: umap */ let a = 1;\n")).contains("umap"),
        "block comments are blanked too (they were NOT, pre-WS-B)"
    );

    // WS-D — the tokenizer is STRING-AWARE. The pre-WS-D scanner treated any `//` as a
    // line comment, so a URL literal blanked the rest of the line out of the scan. That
    // is a fail-open, and this is its regression test.
    let url = executable_code("let u = \"https://x.test/\"; let g = n_genes;\n");
    assert!(
        scan_nouns(&url).contains("genes"),
        "a `//` INSIDE a string literal must not blank the rest of the line (WS-D fail-open)"
    );
    // ...and the inverse: a comment marker inside a string is not comment TEXT either.
    assert!(
        !prose_text("let u = \"https://cells.test/\";\n").contains("cells"),
        "string contents are not prose"
    );
    // The prose projection is the INVERSE of the scan projection.
    assert!(prose_text("// the single-cell QC table\nlet a = 1;\n").contains("single-cell"));
    assert!(!executable_code("// the single-cell QC table\nlet a = 1;\n").contains("single-cell"));

    let with_test = executable_code(
        "pub fn a() {}\n#[cfg(test)]\nmod t {\n  let x = \"umap\";\n}\npub fn b() {}\n",
    );
    assert!(
        !scan_nouns(&with_test).contains("umap"),
        "#[cfg(test)] blocks are blanked"
    );
    assert!(
        with_test.contains("pub fn a"),
        "production code before the test mod survives"
    );
    assert!(
        with_test.contains("pub fn b"),
        "production code AFTER the test mod survives"
    );
    // WS-R5 G1 — `#[cfg(not(test))]` is the EXACT OPPOSITE of that exemption: code compiled
    // ONLY OUTSIDE tests, i.e. shipping code. `contains_word(args, "test")` matched it, so
    // BOTH enforcers blanked it and a domain literal inside one was invisible to every tier.
    // Latent rather than live — nothing in the tree spells `test` any other way today —
    // which is exactly why it needed a test rather than a sighting.
    let not_test = executable_code(
        "#[cfg(not(test))]\nmod ship {\n  let x = \"umap\";\n  let n_cells = 1;\n}\n",
    );
    assert!(
        scan_nouns(&not_test).contains("umap"),
        "#[cfg(not(test))] is SHIPPING code and must be SCANNED"
    );
    assert!(
        scan_nouns(&not_test).contains("cells"),
        "its nouns must fire too"
    );
    // …and the whitespace-tolerant spelling, since the attribute is free-form.
    let spaced = executable_code("#[cfg( not ( test ) )]\nmod ship {\n  let x = \"leiden\";\n}\n");
    assert!(
        scan_nouns(&spaced).contains("leiden"),
        "`not ( test )` must not be blanked either"
    );
    // WS-R3 §1 — this assertion is INVERTED. It used to read "#[cfg(debug_assertions)]
    // seeds are blanked (§7)", and it was the assertion that CERTIFIED the hole: a passing
    // test that the twin must not look at the one attribute `workstore/data_api.rs` is
    // written entirely under. It is inverted rather than deleted so the intent is on the
    // record in both directions.
    let dev = executable_code(
        "#[cfg(debug_assertions)]\nfn seed() { let n_cells = 1; }\npub fn r() {}\n",
    );
    assert!(
        scan_nouns(&dev).contains("cells"),
        "#[cfg(debug_assertions)] is SCANNED as of WS-R3 — it compiles into every dev binary \
         and `workstore/routes.rs` registers six real HTTP routes under it"
    );
    assert!(
        dev.contains("pub fn r"),
        "production code after the dev block survives"
    );
    // ...and the two attributes are treated DIFFERENTLY by the same file.
    let both = executable_code(
        "#[cfg(test)]\nmod t { let a = \"x_umap\"; }\n#[cfg(debug_assertions)]\nmod d { let b = \"x_umap\"; }\n",
    );
    let mut umaps = 0usize;
    match_nouns(both.as_bytes(), Lang::Rust, false, |_, t| {
        if t == "umap" {
            umaps += 1
        }
    });
    assert_eq!(
        umaps, 1,
        "exactly ONE of the two identical literals survives — the debug one"
    );
    // A cfg attr whose args merely CONTAIN the word must not strip the item.
    let feat = executable_code("#[cfg(feature = \"latest\")]\nfn f() { let n_cells = 1; }\n");
    assert!(
        scan_nouns(&feat).contains("cells"),
        "`feature = \"latest\"` is not `cfg(test)`"
    );

    // WS-B blind spot #4 — `\b` treats `_` as a word char, so `\bcells\b` MISSES
    // `n_cells`; a letter boundary alone misses the camel hump in `inputCells`.
    assert!(scan_nouns("struct C { n_cells: i64, n_genes: i64 }").contains("cells"));
    assert!(scan_nouns("struct C { n_cells: i64, n_genes: i64 }").contains("genes"));
    assert!(
        scan_nouns("let x = obs_umap_key;").contains("umap"),
        "underscore is not a letter"
    );
    assert!(
        scan_nouns("let inputCells = 1;").contains("cells"),
        "camelCase hump must match"
    );
    assert!(
        scan_nouns("const MAX_CELLS: i64 = 1;").contains("cells"),
        "SCREAMING_CASE must match"
    );
    assert!(
        scan_nouns("let nObs = 1;").contains("obs"),
        "camelCase hump on a 3-letter noun"
    );

    // WS-D — the ten nouns the widened JS vocabulary added, each driven here so a future
    // narrowing of the list is a test failure and not a quiet loss of coverage.
    for (src, tok) in [
        ("let e = enrichment_score;", "enrichment"),
        ("let m = pct_mito;", "pct_mito"),
        ("let t = transcriptome_ref;", "transcriptome"),
        ("let v = vis2D;", "vis2D"),
        ("use scanpy_bridge;", "scanpy"),
        ("let s = seurat_obj;", "seurat"),
        ("let p = mtx_trio;", "mtx"),
        ("let h = h5mu_path;", "h5mu"),
        ("import tiledbsoma;", "tiledbsoma"),
        ("let r = GRCh38;", "GRCh38"),
    ] {
        assert!(
            scan_nouns(src).contains(tok),
            "the WS-C noun `{tok}` must match in `{src}`"
        );
    }
    // `tiledbsoma` is listed EXPLICITLY even though `soma` is a token: the left boundary
    // refuses `…dbsoma` (lowercase neighbour, lowercase match start), so the single most
    // common spelling of the store API in this tree was invisible.
    assert!(
        !scan_nouns("import tiledbsoma;").contains("soma"),
        "longest-first attributes once"
    );

    // ── WS-R3 §3 — the four new NOUN tokens + the two boundary rules they needed ──
    for (src, tok) in [
        ("let r = pct_ribo;", "pct_ribo"),
        ("let c = nCount;", "nCount"),
        ("let cols = vec![\"ident\"];", "ident"),
        ("let n = strip_10x_suffix;", "10x"),
    ] {
        assert!(
            scan_nouns(src).contains(tok),
            "the WS-R3 noun `{tok}` must match in `{src}`"
        );
    }
    // `ident` must NOT claim English or Rust macro syntax. `identity`/`identifier` fall to
    // `right_ok`; `IDENTICAL`/`IDENTITY` to NON_DOMAIN_IDENTIFIERS; `$x:ident` / `$ident`
    // to `is_rust_macro_fragment` — by SHAPE, so a real `"ident"` column key survives.
    for innocent in [
        "let identity = 1; let identifier = \"a\";",
        "const IDENTICAL: u8 = 1;",
        "struct IDENTITY;",
        "macro_rules! p { ($ident:ident, $n:literal) => { pub struct $ident; }; }",
        "macro_rules! d { ($static:ident, $ctor:ident, $validate:ident) => {}; }",
    ] {
        assert!(
            scan_nouns(innocent).is_empty(),
            "`ident` false positive on `{innocent}` -> {:?}",
            scan_nouns(innocent)
        );
    }
    // `10x` is DIGIT-initial and gets the stricter non-alphanumeric left boundary,
    // otherwise `110x` matches.
    assert!(!scan_nouns("let v = 110;").contains("10x"));
    assert!(
        scan_nouns("let v = v110x;").is_empty(),
        "`110x` inside an ident is not `10x`"
    );

    // WS-D — the ACRONYM tier: case-sensitive, non-alphanumeric boundary on both sides.
    let acr = |s: &str| {
        let mut v = Vec::new();
        match_acronyms(s.as_bytes(), |_, t| v.push(t));
        v
    };
    assert_eq!(
        acr("a (comparison,gene) DE table"),
        vec!["DE"],
        "a genuine DE reference"
    );
    assert_eq!(acr("a QC metric column"), vec!["QC"]);
    assert_eq!(acr("Zarr chunk-dir / BAM+bai"), vec!["BAM"]);
    assert_eq!(
        acr("let DE_TABLE = 1;"),
        vec!["DE"],
        "`_` is not alphanumeric — still a hit"
    );
    // The whole reason this tier is separate: the ordinary boundary gives `DE` 1575 hits.
    for noisy in [
        "DERIVED", "DESIGN", "DEC-5", "DEFAULT", "QCOW2", "BAMBOO", "de", "qc",
    ] {
        assert!(
            acr(noisy).is_empty(),
            "the acronym tier must not claim `{noisy}`"
        );
    }

    // ── PARITY WITH THE JS TWIN: the three context exclusions ported this round (WS-R8/R9)
    //    — the cargo/cfg `feature` sense, the `stripe-samples` repo name, and the `DE-INV`
    //    deployment label. NEGATIVE CONTROLS first: the genomic senses must STILL fire, or the
    //    port has quietly narrowed the guard (the exact failure the whole file exists to stop).
    assert!(
        scan_nouns("let x = n_features;").contains("features"),
        "a genomic `n_features` in a non-cargo context must STILL be caught"
    );
    assert!(
        scan_nouns("the feature matrix").contains("feature"),
        "a genomic `feature` on a non-cargo line must STILL be caught"
    );
    // P1/P2/P3 are Rust/SQL-only, so a Python `features =` fixture line STILL fires.
    let mut py = BTreeSet::new();
    match_nouns(b"features = tsv.read()", Lang::Py, false, |_, t| {
        py.insert(t);
    });
    assert!(
        py.contains("features"),
        "a Python `features =` line is not cargo grammar"
    );
    // a bare plural (space/quote/paren before it) is the genomic sense and STILL fires.
    assert!(
        scan_nouns("first = samples").contains("samples"),
        "a bare plural must STILL be caught"
    );

    // POSITIVE CONTROLS: the software / repo-name senses are EXCLUDED.
    // P1 — the cfg predicate grammar (`feature = "…"`, `cfg(feature …`).
    assert!(
        scan_nouns("#[cfg(feature = \"x\")]").is_empty(),
        "P1: cfg(feature = …) is a build flag"
    );
    assert!(
        scan_nouns("cfg!(all(feature = \"x\"))").is_empty(),
        "P1: a nested cfg(feature) too"
    );
    // P2 — a cfg-`feature`-gated Rust module suppresses its bare `feature` (flag on vs off).
    let mut p2on = BTreeSet::new();
    match_nouns(b"the feature is gated here", Lang::Rust, true, |_, t| {
        p2on.insert(t);
    });
    assert!(
        p2on.is_empty(),
        "P2: a bare `feature` in a cfg-feature-gated module is the cargo one"
    );
    let mut p2off = BTreeSet::new();
    match_nouns(b"the feature is gated here", Lang::Rust, false, |_, t| {
        p2off.insert(t);
    });
    assert!(
        p2off.contains("feature"),
        "…and with no cfg-feature attr the same `feature` fires"
    );
    // P3 — a cargo/cfg register word on the line, Rust or SQL only.
    assert!(
        scan_nouns("gated on the saas feature").is_empty(),
        "P3: `saas` on the line is cargo context"
    );
    assert!(
        scan_nouns("sqlx enables the time feature").is_empty(),
        "P3: `sqlx` on the line too"
    );
    let mut p3py = BTreeSet::new();
    match_nouns(b"the saas feature column", Lang::Py, false, |_, t| {
        p3py.insert(t);
    });
    assert!(
        p3py.contains("feature"),
        "P3 is Rust/SQL-only; a Python `saas feature` line still fires"
    );
    // the hyphen-tailed repo name is EXCLUDED; the file-level P2 flag is DETECTED.
    assert!(
        scan_nouns("see the stripe-samples repo").is_empty(),
        "hyphen-tailed plural is a repo name"
    );
    assert!(
        file_has_cfg_feature_attr(b"#[cfg(feature = \"saas\")]\nfn f() {}"),
        "the attr is detected"
    );
    assert!(
        file_has_cfg_feature_attr(b"#[cfg(not(feature = \"saas\"))]\nfn f() {}"),
        "…including not(feature=…)"
    );
    assert!(
        !file_has_cfg_feature_attr(b"#[cfg(test)]\nfn f() {}"),
        "cfg(test) is not a feature gate"
    );
    // the `-INV` deployment-invariant label is EXCLUDED at every occurrence (the genuine-acronym
    // positive control is the first `acr(...)` assertion earlier in this test).
    assert!(
        acr("DE-INV-10 metering export").is_empty(),
        "`…-INV-N` is a deployment label, not the acronym"
    );
    assert!(
        acr("all(DE-INV-1, DE-INV-2)").is_empty(),
        "…and each occurrence, not just the first"
    );

    // ...and the innocent English the noun tier must NOT claim.
    for innocent in [
        "let generic = 1;",
        "fn generate() {}",
        "let generator = 1;",
        "let degenerate = 1;",
        "let jobs = 1; let JOBS = 2;",
        "struct Jobs;",
        "let observed = 1; let obsolete = 2;",
        "let excellent = 1;",
        "let resampled = 1;",
        "struct Somatic;",
        "use std::marker::PhantomData;",
        "const ROOTFS_SCHEMA_MARKER: &str = \"x\";",
        "static C: OnceCell<u32> = OnceCell::new();",
        "use once_cell::sync::Lazy;",
        // WS-C — the ALL-CAPS blind spot of the RIGHT boundary. Every next char in an
        // ALL-CAPS word is uppercase, which `right_ok` reads as a camel continuation.
        "const GENERIC: u8 = 1;",
        "const OBSERVED: u8 = 1;",
        "struct SOMATIC;",
        "const REGENERATE: u8 = 1;",
    ] {
        assert!(
            scan_nouns(innocent).is_empty(),
            "false positive on `{innocent}` → {:?}",
            scan_nouns(innocent)
        );
    }

    // THE distinction the quoted-id half exists for: the id literal fails, the capability
    // NAME that makes the domain DATA does not.
    assert!(
        quoted_id_hit("let t = \"metadata-column\";", "metadata-column"),
        "the id literal is a hit"
    );
    assert!(
        !quoted_id_hit(
            "reg.types_with_capability(\"metadata-column-family\")",
            "metadata-column"
        ),
        "the `metadata-column-family` CAPABILITY is the ITEM-14/DEC-12 fix, not the leak — a \
         substring scan flags the fix as the defect, and did on sandbox/inputs.rs the first \
         time this test ran"
    );
    assert!(
        quoted_id_hit("const D: &str = \'clustering\';", "clustering"),
        "single quotes count"
    );

    // WS-D — the SUBSTRING tier has no boundary rule at all, which is the only way to see
    // the two real server hits (unquoted `--help` copy; a baked recipe-path
    // string). A quoted-id scan sees neither.
    assert_eq!(
        substring_hits(b"about = \"a single-cell workbench\"", "single-cell"),
        1
    );
    assert_eq!(
        substring_hits(b"\"../scratch/single-cell/recipe/Dockerfile\"", "single-cell"),
        1
    );
    assert_eq!(
        quoted_hits(b"\"../scratch/single-cell/recipe/Dockerfile\"", "single-cell"),
        0
    );
}

/// WS-R3 §2 — the DATA dialects get their own positive test. A tokenizer that silently
/// mis-classifies a format would make a whole new root permanently, quietly green.
#[test]
fn the_data_dialect_tokenizer_splits_code_from_comment_in_each_format() {
    let split = |src: &str, lang: Lang| -> (String, String) {
        let (scan, prose) = scan_and_prose_lang(src.as_bytes(), lang);
        (
            String::from_utf8_lossy(&scan).into_owned(),
            String::from_utf8_lossy(&prose).into_owned(),
        )
    };

    // SQL — `--` to EOL and `/* … */` are prose; the DDL is code.
    let (scan, prose) = split(
        r#"-- canonical cell/gene axes
CREATE TABLE t (system_cell_id BIGINT);
/* umap */
"#,
        Lang::Sql,
    );
    assert!(scan.contains("system_cell_id") && !scan.contains("canonical"));
    assert!(prose.contains("canonical cell/gene axes") && prose.contains("umap"));
    assert!(
        !scan.contains("umap"),
        "a SQL block comment is prose, not code"
    );

    // PY — `#` to EOL is prose, and so is a TRIPLE-quoted docstring (that is Python's
    // documentation convention; `seed_multimodal.py`'s is three paragraphs of intent).
    let (scan, prose) = split(
        r#""""seed: stages a single-cell/multimodal dataset"""
# a note about barcodes
COLS = ["pct_ribo"]
"#,
        Lang::Py,
    );
    assert!(
        prose.contains("single-cell/multimodal"),
        "a module docstring is prose"
    );
    assert!(prose.contains("barcodes"));
    assert!(scan.contains("pct_ribo") && !scan.contains("barcodes"));

    // JSON — no comments at all, and a bare `'` is an apostrophe, not a string opener.
    let (scan, prose) = split(
        "{\"to\": \"the datatype (e.g. `de`) it's for\"}\n",
        Lang::Json,
    );
    assert!(prose.trim().is_empty(), "JSON has no comment syntax");
    assert_eq!(
        quoted_hits(scan.as_bytes(), "de"),
        1,
        "the shipped contract's `de` is a literal"
    );

    // YAML — `#` opens a comment only at start-of-token.
    let (scan, prose) = split("# leiden\nkey: a#b\n", Lang::Yaml);
    assert!(prose.contains("leiden"));
    assert!(scan.contains("a#b"), "`a#b` is a value, not a comment");

    // And the DISPATCH is by extension, so a rename cannot silently pick the wrong one.
    assert!(Lang::of(Path::new("/a/b.sql")) == Lang::Sql);
    assert!(Lang::of(Path::new("/a/b.py")) == Lang::Py);
    assert!(Lang::of(Path::new("/a/b.json")) == Lang::Json);
    assert!(Lang::of(Path::new("/a/b.yaml")) == Lang::Yaml);
    assert!(Lang::of(Path::new("/a/b.rs")) == Lang::Rust);
}

#[test]
fn the_shared_baseline_is_a_worklist_not_amnesia() {
    // The baseline is the ONLY thing keeping this test green over a tree with known
    // leaks, so its shape is part of the guard. Every entry names the DOMAIN_AUDIT
    // finding it records (or an explicit non-finding tag), and the server side of it is
    // big enough to still be describing this repo.
    let p = src_app().join("ui/scripts/domain-baseline.json");
    let v: Value =
        serde_json::from_str(&std::fs::read_to_string(&p).expect("baseline")).expect("valid JSON");
    let code = v["code"].as_object().expect("code");
    let mut server_entries = 0usize;
    let mut server_findings: BTreeSet<String> = BTreeSet::new();
    for (file, toks) in code {
        for (tok, spec) in toks.as_object().expect("token map") {
            let finding = spec["finding"]
                .as_str()
                .unwrap_or_else(|| panic!("{file}[{tok}] has no `finding` id"));
            assert!(
                spec["count"].as_u64().unwrap_or(0) > 0,
                "{file}[{tok}] is a zero-count entry — prune it"
            );
            assert!(
                spec["note"].as_str().is_some_and(|n| n.len() > 10),
                "{file}[{tok}] has no explanatory note"
            );
            assert_ne!(
                finding, "RESIDUE",
                "{file}[{tok}] is tagged RESIDUE — that tag is RETIRED (WS-C triaged the last \
                 nine). Give it a real disposition: a DOMAIN_AUDIT finding id, or \
                 FALSE-POSITIVE / GENERIC / DEC-* with the usage cited, or fix it."
            );
            if file.starts_with("server/") {
                server_entries += 1;
                server_findings.insert(finding.to_string());
            }
        }
    }
    // RE-MEASURED **24** at the round-2 reconciliation (45 before the round, 44 after
    // WS-FT's own rename). Every one of the 20 retired pairs is attributed in
    // `MIN_NOUN_PAIRS`' doc comment above — this floor and that one measure the same
    // quantity from the two sides (the LEDGER here, the TREE there), and they agreed at 24
    // in this commit, which is itself the check that neither was edited to fit.
    // LOWERED 40 → 16 to restore the ≈2/3 collapse-detector margin.
    // WS-R3 RE-MEASURED **82** (24 -> 82): the four holes closed this round added 58 more
    // (file, token) pairs on the server side alone. RAISED 16 -> 54, the same ≈2/3 rule.
    // ROUND-4 RE-MEASURED **48** — the same quantity `MIN_NOUN_PAIRS` measures from the
    // TREE side, and the two agree at 48 in this commit, which is the check that neither
    // was edited to fit. LOWERED 54 -> 32 (⅔ of 48), in lockstep with `MIN_NOUN_PAIRS`.
    assert!(
        server_entries >= 32,
        "only {server_entries} baselined server entries — the S1-S11 worklist evaporated"
    );
    // DEC-M LEFT this list at the round-2 reconciliation: WS-H retired
    // `cell_count`/`gene_count` from `AdminProjectRow`, which was the whole of DEC-M's
    // server-side CODE residue, so requiring the tag would require the leak back. The
    // decision is not lost — it is pinned harder, by the two INVERSE tests
    // (`the_dec_m_wire_contract_fields_are_GONE` + the wire-shape twin), each with a
    // positive control. Asserted below rather than assumed: a finding leaves this list
    // only when its code residue is actually zero.
    // S2 LEFT this list at the artifact-model ITEM-14/15 reconciliation, on exactly the
    // DEC-M precedent above and with the same burden of proof. S2's whole remaining
    // server-side CODE residue was ONE token: the one carried by the
    // `COLUMN_ENVELOPE_KEYS` envelope-name constant, which `--prune-baseline` took to
    // zero. Its own committed
    // note had already named the condition under which that would be legitimate —
    // *"It goes to zero for real with ITEM-15, which deletes `infer_shape_*` wholesale"* —
    // and that is what happened: `ingest.rs`'s byte-inference block is gone, so the
    // constant is gone with it. This is a finding COMPLETED, not a finding pruned on the
    // strength of a file move (the earlier serve_core.rs -> ingest.rs relocation was
    // deliberately RE-baselined rather than pruned, precisely to avoid that). The
    // removal-documenting PROSE survives as that file's surviving `prose` entry in the
    // baseline, so the history is not erased — only the executable residue is.
    // S3 LEFT this list at the strip's ITEM-4 baseline re-base, on the S2
    // precedent above and with the same burden of proof. S3's whole server-side
    // CODE residue was one module's record-parser pair (the two token entries
    // the file's own S3 doc comment above names) plus that module's
    // export-doc prose row — the module is `provenance`, which left with the
    // registry walk in ITEM-3, and the pruning pass (ITEM-4) took the residue
    // to zero with the file. This is a finding COMPLETED, not a finding pruned
    // on the strength of a re-tag: the entries left ONLY because their carrier
    // left.
    assert!(
        !server_findings.contains("S3"),
        "S3 has server-side CODE residue again — the record-parser vocabulary is back in \
         app-core. Put S3 back in the must-list above in the same commit, with the reason."
    );
    assert!(
        !server_findings.contains("DEC-M"),
        "DEC-M has server-side CODE residue again — the `cell_count`/`gene_count` wire \
         fields came back. Put DEC-M back in the must-list above; the two wire-shape \
         inverse tests that used to pin this (`the_dec_m_wire_contract_fields_*`) were \
         deleted with the project module this strip removed."
    );
    // The INVERSE pin for S2, mirroring the DEC-M one: S2 is "the two-axis persistence
    // layer" blast radius, and artifact-model deleted that layer. A new S2-tagged CODE
    // entry means the layer — or its domain envelope-name constant — came back, so it
    // must be argued for in the commit that re-adds it, not absorbed silently.
    assert!(
        !server_findings.contains("S2"),
        "S2 has server-side CODE residue again — the two-axis persistence layer (or its \
         `COLUMN_ENVELOPE_KEYS`-style domain envelope-name constant) is back in app-core. \
         Put S2 back in the must-list above in the same commit, with the reason."
    );
    // WS-D — the LITERAL tier is the hardest INV-3 kind and had no baseline at all before
    // WS-C, i.e. zero tolerance, which was only survivable while half the tree was
    // unscanned. It exists now, and it is SHRINK-ONLY.
    let literals = v["literals"]
        .as_object()
        .expect("the `literals` tier must exist");
    let server_literal_hits: u64 = literals
        .iter()
        .filter(|(f, _)| f.starts_with("server/"))
        .flat_map(|(_, toks)| toks.as_object().expect("token map").values())
        .map(|s| s["count"].as_u64().unwrap_or(0))
        .sum();
    assert!(
        server_literal_hits as usize <= LITERAL_HITS_CEILING,
        "the baseline records {server_literal_hits} server literal hit(s), above the ceiling of \
         {LITERAL_HITS_CEILING}"
    );
}

// (The two DEC-M wire tests were here: `the_dec_m_wire_contract_fields_are_GONE`
// (source) and `the_project_admin_wire_shape_no_longer_carries_the_dec_m_fields`
// (wire, via `/projects` and `/admin/projects`). Their subject — `AdminProjectRow` and
// the project module's wire contract — was removed with the `project` module, so both
// could only fail on the file-not-found path. The DEC-M decision is recorded above in
// `the_shared_baseline_is_a_worklist_not_amnesia`'s must-not list; the wire-shape
// inverse assertion it named is gone with the wire it guarded.)
