//! **THE SEAM TEST — a stage-1-PRODUCED alignment, read by this stage's resolver.**
//!
//! Until this round no such test existed, and that absence is the reason two successive
//! recipe shapes shipped green. Every other test on this branch builds its own alignment, so
//! both ends of every fixture speak this side's private dialect: a self-agreeing oracle
//! across a seam, which no amount of coverage on either side can catch.
//!
//! ## The fixture is EMITTED, not transcribed — and not extracted either
//!
//! `tests/fixtures/stage1_alignment[_reversed]/` is a byte-for-byte copy of what stage 1's
//! own generator writes:
//!
//! ```text
//! python3 src-app/packages/embedding-integrate/tools/emit_reference_alignment.py <dir>
//! python3 src-app/packages/embedding-integrate/tools/emit_reference_alignment.py <dir> --reversed
//! ```
//!
//! That generator stages two real datasets with the real writer and then **invokes the
//! producer as a subprocess**, so what lands is whatever the producer writes today.
//!
//! Two cheaper routes were tried on this branch and both produced a confidently wrong shape:
//!
//! * **hand-writing the fixture from the producer's docstring** — tests this side's READING
//!   of their format;
//! * **extracting their `build_vectors()` and running it** — tests an in-memory intermediate
//!   the producer consumes *before writing*. Running their code is not consuming their
//!   output; only the artifact the producer WRITES settles a format seam.
//!
//! ## What each test here is for
//!
//! 1. the plan parses at all (the gate this whole rebuild is measured by);
//! 2. members resolve BY ROLE and per-source digests come out of `meta.sources[]`;
//! 3. the real vectors, decoded from the real store, drive the real arithmetic;
//! 4. the `--reversed` fixture pins TEST-6, where array order and `declared_order` genuinely
//!    DISAGREE — a fixture where they coincide passes against a reader that ignores
//!    `declared_order` entirely and therefore proves nothing;
//! 5. the INV-1 boundary is measured rather than assumed: the vectors are stored in a codec
//!    chain the server may not decode, which is why (3) takes them as an input.

use std::path::{Path, PathBuf};

use serde_json::Value;

use txresbench::modules::workstore::alignment::{extent, role, AlignmentPlan, AlignmentVectors};

use crate::common::zarr;

fn fixture_dir(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

/// The `dataset-alignment` entry of a producer-emitted manifest.
fn alignment_entry(dir: &Path) -> Value {
    let manifest: Value = serde_json::from_str(
        &std::fs::read_to_string(dir.join("manifest.json")).expect("fixture manifest.json"),
    )
    .expect("manifest parses");
    manifest["outputs"]
        .as_array()
        .expect("manifest declares outputs")
        .iter()
        .find(|o| o["datatype"] == Value::from("dataset-alignment"))
        .cloned()
        .expect("the producer emits exactly one dataset-alignment output")
}

/// Assert the fixture really is a non-degenerate producer artifact.
///
/// A fixture inherits the shape of whatever was convenient, and convenience is uncorrelated
/// with the property under test — so its non-vacuity is ASSERTED here rather than arranged
/// and trusted. Without this, an empty or truncated fixture would make the parse below
/// succeed or fail for reasons that have nothing to do with the seam.
fn assert_non_vacuous(entry: &Value) {
    let aux = entry["structure"]["aux"]
        .as_array()
        .expect("the alignment declares aux members");
    assert!(
        aux.len() >= 4,
        "FIXTURE IS VACUOUS: {} aux member(s); the producer writes the four SEGMENT vector \
         members (D18 dropped the 2 row vectors) plus entity-index/evidence/level-lookups",
        aux.len()
    );
    for r in [
        role::SEGMENT_DATASET,
        role::SEGMENT_START,
        role::SEGMENT_END,
        role::SEGMENT_ORDER,
    ] {
        assert!(
            aux.iter().any(|m| m["role"] == Value::from(r)),
            "FIXTURE IS VACUOUS: no aux member carries role {r}"
        );
    }
    let sources = entry["meta"]["sources"]
        .as_array()
        .expect("the alignment records its sources in meta");
    assert!(
        sources.len() >= 2,
        "FIXTURE IS VACUOUS: an alignment over {} source(s) is not an alignment — and a \
         single-source fixture is exactly what let a single-source recipe look correct",
        sources.len()
    );
    assert!(
        sources.iter().all(|s| s["key_sequence_digest"]
            .as_str()
            .is_some_and(|d| !d.is_empty())),
        "FIXTURE IS VACUOUS: a source with no key_sequence_digest cannot exercise the \
         per-source precheck"
    );
}

/// **The gate.** The resolver reads a real stage-1 alignment.
#[test]
fn a_real_stage1_alignment_is_readable_by_this_stages_resolver() {
    let entry = alignment_entry(&fixture_dir("stage1_alignment"));
    assert_non_vacuous(&entry);

    let plan = AlignmentPlan::parse(&entry["structure"], &entry["meta"]).unwrap_or_else(|e| {
        panic!(
            "this stage's resolver cannot read a REAL stage-1 alignment. The producer emits a \
             zarr table whose vectors are aux MEMBERS addressed by role, with per-source \
             digests in `meta.sources[]`. Error: {e:?}"
        )
    });

    // The values, not merely "it parsed" — a parser that returned defaults would satisfy the
    // line above.
    assert_eq!(plan.axis, "unified_entities");
    assert_eq!(plan.key_column, "unified_key");
    assert_eq!(plan.n_rows, 5, "2 rows from ds-a + 3 from ds-b");
    assert_eq!(plan.n_segments, 2);
    assert_eq!(
        plan.n_entities, 2,
        "A and B unify; C conflicts and is dropped"
    );
    assert_eq!(plan.source_dataset_ids(), vec!["ds-a", "ds-b"]);
    assert_eq!(plan.segment_dataset.path, "segment_dataset");
    assert_eq!(plan.segment_order.path, "segment_order");
    // REPURPOSED, not deleted (round 42's rule: a test whose subject MOVED keeps guarding
    // the class it always guarded). Half of this assertion has been promoted into the parser
    // — `entity_index` is no longer `Option`, so a plan that dropped it cannot be constructed
    // and `AlignmentPlan::parse` refuses by name instead. THIS ASSERTION IS WHY: when stage 1
    // renamed the role, `optional()` returned `None`, parse SUCCEEDED, and only this line
    // noticed. The remaining half is still absence-able and still needs saying.
    assert_eq!(plan.entity_index.path, "entity_index");
    assert!(
        !plan.level_lookups.is_empty(),
        "the producer emits per-source level lookups; a plan that silently dropped them would \
         read as complete"
    );
    assert_eq!(
        plan.secondary_columns,
        vec!["unified_alias".to_string()],
        "the unified secondary identifier column is part of what the alignment declares"
    );
}

/// Per-source digests come out of `meta.sources[]`, and they DIFFER between sources.
///
/// A single pin — the shape this side carried until this round — is right only when every
/// source happens to share a digest. Here they do not, so a resolver holding one pin cannot
/// be correct for both rows of the output.
#[test]
fn each_source_carries_its_own_key_sequence_digest() {
    let entry = alignment_entry(&fixture_dir("stage1_alignment"));
    let plan = AlignmentPlan::parse(&entry["structure"], &entry["meta"]).expect("plan");

    let a = plan.digest_for(0).expect("ds-a is pinned");
    let b = plan.digest_for(1).expect("ds-b is pinned");
    assert_ne!(
        a, b,
        "the two sources must pin DIFFERENT digests, or a single-pin resolver passes here \
         while being wrong in general"
    );
    assert_eq!(plan.sources[0].n_rows, 2);
    assert_eq!(plan.sources[1].n_rows, 3);
    assert!(
        plan.digest_for(9).is_none(),
        "an unknown source is unknown, never a match"
    );
}

/// Decode the SEGMENT vectors the producer really wrote, and run the real reconstruction over
/// them. D18 (ITEM-11): there is no stored `row_source`/`row_segment` — `resolve_row` finds the
/// segment whose `[start,end)` range contains the output row, so rows 0 and 2 (which share
/// row-within-source 0 but come from DIFFERENT datasets) are told apart by RANGE, which a stored
/// per-row vector could not do without the second (also-dropped) vector.
#[test]
fn the_producers_own_segments_resolve_each_row_to_its_source() {
    let dir = fixture_dir("stage1_alignment");
    let entry = alignment_entry(&dir);
    let plan = AlignmentPlan::parse(&entry["structure"], &entry["meta"]).expect("plan");
    let v = decode_vectors(&dir, &plan);

    assert_eq!(v.resolve_row(0).unwrap(), (0, 0));
    assert_eq!(v.resolve_row(1).unwrap(), (0, 1));
    assert_eq!(v.resolve_row(2).unwrap(), (1, 0));
    assert_eq!(v.resolve_row(4).unwrap(), (1, 2));
}

/// **TEST-6 — `declared_order` is a field, and here it DISAGREES with array position.**
///
/// The `--reversed` fixture declares `ds-b, ds-a` while the segment arrays serialise sorted
/// by dataset id, so `segment_order` is `[1, 0]` and `segment_start` is `[3, 0]` —
/// non-monotonic in array order. The disagreement is asserted FIRST: stage 1 ran an ordering
/// control that changed nothing because their fixture's two orderings coincided, and a
/// coinciding fixture makes the mutation unobservable.
#[test]
fn segment_order_is_read_from_the_declaration_not_from_array_position() {
    let dir = fixture_dir("stage1_alignment_reversed");
    let entry = alignment_entry(&dir);
    let plan = AlignmentPlan::parse(&entry["structure"], &entry["meta"]).expect("plan");
    let v = decode_vectors(&dir, &plan);

    assert!(
        v.declared_order_disagrees_with_array_order(),
        "THE FIXTURE CANNOT TEST WHAT IT CLAIMS: segment_order is {:?}, i.e. array order. A \
         consumer that ignores declared_order entirely would pass every assertion below",
        v.segment_order
    );
    assert_eq!(v.segment_order, vec![1, 0]);
    assert_eq!(
        v.segment_start,
        vec![3, 0],
        "start rows are non-monotonic across the array — deliberately (INV-6)"
    );
    assert_eq!(
        v.segments_in_declared_order(),
        vec![1, 0],
        "the declared FIRST segment is array entry 1"
    );

    // AUDIT FINDING 3 — the assertion this test's NAME claims. Everything above exercises a
    // helper; the serve path calls `resolve_row`, and INV-6 is a claim about what a READ
    // returns. The row layout follows the DECLARATION, so output row 0 belongs to the
    // first-DECLARED source (ds-b, source index 0) — not to segment array entry 0.
    assert_eq!(
        v.resolve_row(0).unwrap(),
        (0, 0),
        "output row 0 must come from the first-DECLARED source"
    );
    assert_eq!(v.resolve_row(3).unwrap(), (1, 0), "row 3 is the second-declared source's first row");

    // And the declared order really is the row layout: the first-declared source's rows come
    // first in the output. `ds-b` is declared first here and contributes 3 rows.
    assert_eq!(plan.sources[0].dataset_id, "ds-b");
    let first_declared = v.segments_in_declared_order()[0];
    assert_eq!(
        v.segment_source[first_declared], 0,
        "segment of source ds-b"
    );
    assert_eq!(v.segment_start[first_declared], 0);
    assert_eq!(v.segment_end[first_declared], 3);
}

/// **The INV-1 boundary, measured on the producer's own store.**
///
/// Every vector the gather needs is written under `sharding_indexed[ bytes,
/// numcodecs.shuffle, gzip ]`. Decoding one server-side means opening an artifact byte for
/// meaning, which INV-1 forbids and `scripts/check-no-format-crates.sh` enforces on the
/// dependency graph — so the server can resolve an alignment's METADATA and cannot obtain its
/// VALUES. That is why `AlignmentVectors` takes them as an input and why the serve path
/// refuses with `GATHER_VECTORS_UNREADABLE` instead of producing a chunk.
///
/// This test exists so the day the producer emits these raw — or the day the boundary moves —
/// somebody is TOLD, rather than the gap persisting because it is nobody's error message.
#[test]
fn the_alignment_vectors_are_stored_in_a_chain_the_server_may_not_decode() {
    let dir = fixture_dir("stage1_alignment");
    let entry = alignment_entry(&dir);
    let plan = AlignmentPlan::parse(&entry["structure"], &entry["meta"]).expect("plan");

    let mut checked = 0;
    for member in [
        &plan.segment_dataset,
        &plan.segment_start,
        &plan.segment_end,
        &plan.segment_order,
    ] {
        let meta: Value = serde_json::from_str(
            &std::fs::read_to_string(
                dir.join("alignment.zarr")
                    .join(&member.path)
                    .join("zarr.json"),
            )
            .unwrap_or_else(|e| panic!("member {} has no zarr.json: {e}", member.path)),
        )
        .expect("member zarr.json parses");
        assert_eq!(
            meta["codecs"][0]["name"],
            Value::from("sharding_indexed"),
            "member {} is no longer sharded — if the producer now emits raw vectors, the \
             server may be able to read them without a decoder, and the gather's \
             GATHER_VECTORS_UNREADABLE refusal should be revisited",
            member.path
        );
        let inner: Vec<&str> = meta["codecs"][0]["configuration"]["codecs"]
            .as_array()
            .expect("inner codec chain")
            .iter()
            .filter_map(|c| c["name"].as_str())
            .collect();
        assert!(
            inner.contains(&"gzip"),
            "member {} inner chain is {inner:?} — the boundary this test measures has moved",
            member.path
        );
        checked += 1;
    }
    assert_eq!(
        checked, 4,
        "all four SEGMENT vector members must be measured, not some (D18 dropped the 2 row vectors)"
    );
}

/// Decode a fixture's alignment vectors with the SUITE's reader (never the server's — it has
/// none, by construction), and bind them to the plan so any length disagreement refuses.
fn decode_vectors(dir: &Path, plan: &AlignmentPlan) -> AlignmentVectors {
    let store = zarr::load_dir(&dir.join("alignment.zarr"));
    let as_u64 = |v: Vec<i64>| v.into_iter().map(|x| x as u64).collect::<Vec<_>>();
    let as_u32 = |v: Vec<i32>| v.into_iter().map(|x| x as u32).collect::<Vec<_>>();

    let raw = AlignmentVectors {
        segment_source: as_u32(zarr::read_i32(&store, &plan.segment_dataset.path)),
        segment_start: as_u64(zarr::read_i64(&store, &plan.segment_start.path)),
        segment_end: as_u64(zarr::read_i64(&store, &plan.segment_end.path)),
        segment_order: as_u32(zarr::read_i32(&store, &plan.segment_order.path)),
    };
    assert_eq!(
        raw.segment_source.len(),
        plan.n_segments,
        "the decode read {} segment(s) against a declared {} — a reader that returned nothing \
         would make every assertion below vacuously true",
        raw.segment_source.len(),
        plan.n_segments
    );
    AlignmentVectors::bind(plan, raw)
        .expect("the producer's own vectors must satisfy its own declaration")
}

/// The extents the plan is measured in are the producer's, and they are cross-checked against
/// the members' own shapes at parse time. This pins the NAMES, which is what a consumer keys
/// on — a renamed extent is a silent length loss otherwise.
#[test]
fn the_producers_extent_names_are_the_ones_this_side_reads() {
    let entry = alignment_entry(&fixture_dir("stage1_alignment"));
    let extents = entry["structure"]["extents"]
        .as_object()
        .expect("the alignment declares extents");
    // D18 (ITEM-11): `alignment_rows` was dropped with the row vectors it measured; `n_rows`
    // now comes from `sum(meta.sources[].n_rows)`.
    for name in [extent::SEGMENTS, extent::SOURCES, extent::UNIFIED_ENTITIES] {
        assert!(
            extents.contains_key(name),
            "the producer no longer declares `extents.{name}`; present: {:?}",
            extents.keys().collect::<Vec<_>>()
        );
    }
}

/// **What producing ONE gathered chunk actually requires — measured on the SOURCE columns.**
///
/// The alignment's own vectors being undecodable (above) fixes only half the question. The
/// gather also has to read SOURCE column bytes, and those carry the identical chain: this
/// walks every array in the two staged source datasets the producer was run over and requires
/// each to be `sharding_indexed` with `gzip` inside.
///
/// Two consequences, and they are why a control-plane copy of the vectors would not be
/// enough on its own:
///
/// * **The shard index addresses CHUNKS, not elements** (one 16-byte entry per inner chunk of
///   4096 elements), and the chunk payload is a DEFLATE stream with no positional index — so
///   no byte RANGE of a stored file corresponds to a row.
/// * **Where `numcodecs.shuffle` is declared, an element's bytes are strided by the chunk's
///   element count** — element 1 of a 4096-element int64 chunk lives at bytes 1, 4097, 8193,
///   … — so even a fully inflated chunk needs a per-chunk transposition before any row is
///   contiguous.
///
/// Reading one output row therefore costs inflating and un-shuffling the whole inner chunk
/// containing it, per source. That is decoding, and it is what INV-1 keeps out of the server.
#[test]
fn every_source_column_carries_the_same_undecodable_chain() {
    let root = fixture_dir("stage1_alignment").join("sources");
    let mut checked = 0;
    let mut stack = vec![root.clone()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir)
            .expect("fixture source tree")
            .flatten()
        {
            let p = entry.path();
            if p.is_dir() {
                stack.push(p);
                continue;
            }
            if p.file_name().and_then(|f| f.to_str()) != Some("zarr.json") {
                continue;
            }
            let meta: Value =
                serde_json::from_str(&std::fs::read_to_string(&p).expect("zarr.json"))
                    .expect("zarr.json parses");
            if meta["node_type"] != Value::from("array") {
                continue;
            }
            assert_eq!(
                meta["codecs"][0]["name"],
                Value::from("sharding_indexed"),
                "{p:?} is no longer sharded — the gather's input barrier has moved"
            );
            let inner: Vec<&str> = meta["codecs"][0]["configuration"]["codecs"]
                .as_array()
                .expect("inner chain")
                .iter()
                .filter_map(|c| c["name"].as_str())
                .collect();
            assert!(
                inner.contains(&"gzip"),
                "{p:?} inner chain is {inner:?}; a source column the server could read \
                 without inflating would change the answer to 'must the gather decode?'"
            );
            checked += 1;
        }
    }
    assert!(
        checked >= 7,
        "FIXTURE IS VACUOUS: {checked} source array(s) inspected — the two staged datasets \
         carry seven between them, and a walk that found none would pass this test silently"
    );
}

/// **No gathered output chunk can be a source chunk passed through un-decoded.**
///
/// The one escape from decoding would be re-serving a source's stored chunk bytes verbatim.
/// It is closed by the shape of the row axis, not by policy: the axis is a CONCATENATION of
/// per-source segments, so a chunk spanning a segment boundary draws from two different
/// source ARRAYS, and there is no single stored chunk to pass through.
///
/// Measured here on the producer's own vectors rather than argued.
#[test]
fn a_gathered_chunk_straddles_sources_so_nothing_can_be_passed_through() {
    for tag in ["stage1_alignment", "stage1_alignment_reversed"] {
        let dir = fixture_dir(tag);
        let entry = alignment_entry(&dir);
        let plan = AlignmentPlan::parse(&entry["structure"], &entry["meta"]).expect("plan");
        let v = decode_vectors(&dir, &plan);

        let chunk = txresbench::modules::workstore::gathered::CHUNK_ELEMENTS;
        let hi = usize::min(chunk, plan.n_rows);
        let sources: std::collections::BTreeSet<usize> = (0..hi)
            .map(|i| v.resolve_row(i).expect("row resolves").0)
            .collect();
        assert!(
            sources.len() >= 2,
            "{tag}: output chunk 0 draws from source(s) {sources:?} — a single-source chunk \
             here would make this test's claim untestable on this fixture rather than false"
        );
    }
}
