//! CROSS-SIDE AGREEMENT for the sniffer — the test whose absence let two enforcers of
//! ONE behaviour assert opposite things, both green, for three rounds.
//!
//! ── THE FAILURE THIS EXISTS TO PREVENT ──────────────────────────────────────
//! The sniff behaviour has (at least) three enforcers:
//!
//!   1. `server/src/modules/datatype/sniff.rs`  — the implementation + its unit test
//!   2. `ui/tests/e2e/datatype/sniff.spec.ts`   — the browser round-trip through the
//!                                                 real `POST /api/datatypes/sniff`
//!   3. doc-comments in the upload path that describe what a given extension resolves to
//!
//! A producer-less table type — the ONLY type that declared a `.csv` ingest hint — was
//! pruned. Enforcer (1) was updated in the same commit to expect `None` for a plain
//! `.csv`. Enforcers (2) and (3) were not, and went on asserting the pruned id. Nothing
//! compared them, so nothing failed: (3) is prose, and (2) is an end-to-end spec that no
//! CI job runs, so its staleness could only ever surface as a red run somebody had to
//! choose to start.
//!
//! The lesson is NOT "remember to update the twin". It is that an expectation SPELLED OUT
//! on two sides is a copy, and copies drift. So:
//!
//!   * the browser spec no longer names a datatype id at all — it DERIVES the expected
//!     answer from the same registry the server serves it (`__datatypeRegistry.ingestFor`);
//!   * `sniff_only_answers_with_a_type_that_declares_the_matching_hint` states the same
//!     derived property on the Rust side, so both sides now assert one contract computed
//!     from one source rather than two hardcoded answers that happened to agree once;
//!   * `the_browser_sniff_spec_hardcodes_no_datatype_answer` is the ratchet that keeps it
//!     that way — reintroducing a literal answer in the spec fails THIS test, in `cargo
//!     test`, without anybody having to run a browser.
//!
//! That last point is the load-bearing one: the divergence was invisible because the two
//! enforcers were checked by two different runners with two different costs. This test
//! moves the FE-side check onto the cheap runner.

use std::path::{Path, PathBuf};

use cytoanalyst::modules::datatype::registry::DatatypeRegistry;
use cytoanalyst::modules::datatype::sniff::sniff;

/// The repo's `src-app/` — this crate's manifest dir is `src-app/server`.
fn src_app() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("server/ has a parent")
        .to_path_buf()
}

/// The browser-side enforcer, by the path the ledger pins it at.
fn browser_spec() -> PathBuf {
    src_app().join("ui/tests/e2e/datatype/sniff.spec.ts")
}

/// Every `…datatype).toBe('literal')` / `.toEqual("literal")` in a spec — i.e. a sniff
/// answer SPELLED OUT rather than derived. A derived comparison
/// (`.toBe(out.claimants[0])`) or a null check (`.toBeNull()`) is not a literal and is
/// deliberately not matched.
fn hardcoded_datatype_answers(src: &str) -> Vec<String> {
    const MARK: &str = ".datatype)";
    let bytes = src.as_bytes();
    let mut found = Vec::new();
    let mut at = 0usize;

    while let Some(rel) = src[at..].find(MARK) {
        let after = at + rel + MARK.len();
        at = after;
        if !src.is_char_boundary(after) {
            continue;
        }
        // Skip whitespace between `.datatype)` and the matcher.
        let mut i = after;
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if !src.is_char_boundary(i) {
            continue;
        }
        let rest = &src[i..];
        let Some(skip) = [".toBe(", ".toEqual("]
            .iter()
            .find(|m| rest.starts_with(**m))
            .map(|m| m.len())
        else {
            continue;
        };
        // Skip whitespace between the matcher's `(` and its argument.
        let mut j = i + skip;
        while j < bytes.len() && bytes[j].is_ascii_whitespace() {
            j += 1;
        }
        if j >= bytes.len() || (bytes[j] != b'\'' && bytes[j] != b'"') {
            continue; // a derived expression, not a literal — fine.
        }
        let quote = bytes[j] as char;
        if let Some(end) = src[j + 1..].find(quote) {
            found.push(src[j + 1..j + 1 + end].to_string());
        }
    }
    found
}

/// The ingest-declaring types, id-sorted — DERIVED from the shipped registry, never
/// listed here. These are the only ids the sniffer can ever answer with.
fn sniffable(reg: &DatatypeRegistry) -> Vec<(String, Vec<String>)> {
    let mut v: Vec<(String, Vec<String>)> = reg
        .all()
        .into_iter()
        .filter_map(|d| {
            d.ingest.as_ref().map(|i| {
                (
                    d.id.clone(),
                    i.extensions.iter().map(|e| e.to_ascii_lowercase()).collect(),
                )
            })
        })
        .collect();
    v.sort();
    v
}

/// An extension no shipped type claims — asserted to be so wherever it is used, so the
/// "nothing can type this upload" branch is a real control and not an assumption.
const UNCLAIMED_EXT: &str = "xyz";

// ════════════════════════════════════════════════════════════════════════════
//  1 — the contract, stated as a derived property (the Rust half of the pair)
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn sniff_only_answers_with_a_type_that_declares_the_matching_hint() {
    let reg = DatatypeRegistry::build_from_embedded().expect("merged registry builds");
    let types = sniffable(&reg);

    // Non-vacuity: with nothing sniffable, every assertion below holds trivially.
    assert!(
        !types.is_empty(),
        "no shipped type declares an ingest hint, so this property test proves nothing"
    );

    let mut checked = 0usize;
    for (_, exts) in &types {
        for ext in exts {
            // The documented rule: among equal matches, the LOWEST id wins. `types` is
            // id-sorted, so the first claimant is that answer — computed, not spelled out.
            let expected = types
                .iter()
                .find(|(_, e)| e.contains(ext))
                .map(|(id, _)| id.clone());
            assert_eq!(
                sniff(&reg, &format!("probe.{ext}"), b""),
                expected,
                "`.{ext}` must resolve to the lowest-id type declaring it"
            );
            checked += 1;
        }
    }
    assert!(
        checked >= 5,
        "only {checked} declared extension(s) exercised — too few for this to be a real sweep"
    );

    // The other branch of the user-visible behaviour: an extension nothing claims must
    // answer `None` so the caller can show "unknown" instead of mistyping the upload.
    assert!(
        !types.iter().any(|(_, e)| e.iter().any(|x| x == UNCLAIMED_EXT)),
        "`.{UNCLAIMED_EXT}` is now claimed by a shipped type, so it is no longer a control"
    );
    assert_eq!(sniff(&reg, &format!("probe.{UNCLAIMED_EXT}"), b""), None);

    // …and an unclaimed extension in FRONT of a declared signature must still type, or
    // "magic beats extension" is not actually being enforced.
    let with_magic = types
        .iter()
        .filter_map(|(id, _)| reg.get(id).and_then(|d| d.ingest.as_ref()))
        .find_map(|i| i.magic_hex.first().filter(|h| !h.is_empty()).cloned());
    if let Some(hex) = with_magic {
        let sig: Vec<u8> = (0..hex.len())
            .step_by(2)
            .filter_map(|k| u8::from_str_radix(&hex[k..k + 2], 16).ok())
            .collect();
        let got = sniff(&reg, &format!("probe.{UNCLAIMED_EXT}"), &sig);
        assert!(got.is_some(), "a declared signature must beat an unclaimed extension");
        let answer = got.unwrap();
        let declares = reg
            .get(&answer)
            .and_then(|d| d.ingest.as_ref())
            .map(|i| i.magic_hex.contains(&hex))
            .unwrap_or(false);
        assert!(declares, "`{answer}` was returned for a signature it does not declare");
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  2 — the ratchet: the browser half must stay DERIVED
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn the_browser_sniff_spec_hardcodes_no_datatype_answer() {
    let path = browser_spec();
    let src = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "the browser sniff enforcer is missing at {}: {e}. If it moved, re-point this \
             test — a cross-side check that cannot find the other side is not a check.",
            path.display()
        )
    });

    let literals = hardcoded_datatype_answers(&src);
    assert!(
        literals.is_empty(),
        "{} spells out {} sniff answer(s) {:?}. That is the exact shape that drifted: a \
         literal here cannot be updated by the prune that invalidates it, and no runner \
         this project actually runs would notice. Derive it from \
         `__datatypeRegistry.ingestFor` instead.",
        path.display(),
        literals.len(),
        literals
    );

    // Stronger than the shape rule: no quoted id of any SHIPPED type either, so the spec
    // cannot silently re-acquire a copy of the registry through some other assertion.
    let reg = DatatypeRegistry::build_from_embedded().expect("merged registry builds");
    let mut leaked: Vec<String> = Vec::new();
    for d in reg.all() {
        if src.contains(&format!("'{}'", d.id)) || src.contains(&format!("\"{}\"", d.id)) {
            leaked.push(d.id.clone());
        }
    }
    assert!(
        leaked.is_empty(),
        "{} quotes shipped datatype id(s) {:?}. The spec is supposed to look them up, not \
         restate them.",
        path.display(),
        leaked
    );
}

// ════════════════════════════════════════════════════════════════════════════
//  3 — positive control: the detector above must actually fire
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn the_hardcoded_answer_detector_actually_fires() {
    // The literal shape the browser spec carried before this round, reproduced here with
    // a stand-in id so the detector keeps a permanent positive control even after the
    // real occurrence is gone. Without this, a typo in `MARK` would make test 2 green
    // forever — which is precisely how the original divergence survived.
    let stale = "expect(results.csv.datatype).toBe('a-type-that-no-longer-ships')";
    assert_eq!(
        hardcoded_datatype_answers(stale),
        vec!["a-type-that-no-longer-ships".to_string()],
        "the detector no longer recognises the very shape it was written for"
    );

    // Double-quoted and `toEqual` variants are the same defect.
    assert_eq!(
        hardcoded_datatype_answers("expect(r.datatype).toEqual(\"pinned\")"),
        vec!["pinned".to_string()]
    );
    // Whitespace/newline between the members must not smuggle a literal past it.
    assert_eq!(
        hardcoded_datatype_answers("expect(r.datatype)\n  .toBe( 'pinned' )"),
        vec!["pinned".to_string()]
    );

    // …and the DERIVED forms the fixed spec uses must NOT be flagged, or the ratchet is
    // unsatisfiable and the next author deletes it.
    for ok in [
        "expect(out.csv.datatype).toBe(out.csvClaimants[0])",
        "expect(out.mystery.datatype).toBeNull()",
        "expect(out.magic.datatype).not.toBeNull()",
        "expect(out.csvClaimants).toContain(out.csv.datatype)",
        "expect(out.csv.filename).toBe('results.csv')",
    ] {
        assert!(
            hardcoded_datatype_answers(ok).is_empty(),
            "derived form wrongly flagged as a hardcoded answer: {ok}"
        );
    }
}
