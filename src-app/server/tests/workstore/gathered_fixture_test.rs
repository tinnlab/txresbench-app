//! **Generates — and GUARDS — the fixture the client-parity test reads.**
//!
//! The parity test (`ui/src/core/workstore/zarrReader.gatheredParity.test.ts`) proves INV-3:
//! *the client cannot tell*. For that to mean anything the gathered bytes must be produced
//! by the REAL Rust gather, so they are generated here and committed under
//! `ui/src/core/workstore/__fixtures__/gathered/`.
//!
//! ## The `stored/` side is now what the WRITER emits — this is the point, not a tidy-up
//!
//! It used to be an uncompressed, unsharded column built by hand right here, and that was
//! recorded as a scope limitation — *"not the shuffle+gzip+sharded form the Python writer
//! emits"* — and passed over. That sentence hid a design defect for rounds: the gather only
//! ever worked on the one encoding no producer writes, and every test on this side agreed
//! with it because every fixture on this side chose it.
//!
//! Both inputs now come from `txr_zarr`, the writer production uses, in the production
//! chain `sharding_indexed[ bytes, (numcodecs.shuffle,) gzip ]`, committed under
//! `tests/fixtures/gathered_parity/` and regenerable with that directory's `generate.py`.
//! The gather reads them through `gather_decode` — the one module INV-1's amendment (DEC-23)
//! allows to decode — so the parity claim is now *a gathered artifact against a stored one
//! in the encoding production uses*, which is strictly stronger than what it proved before.
//!
//! ## Why this test also ASSERTS, and does not merely write
//!
//! "Regenerable" is only a property if regeneration is exercised. A fixture that can silently
//! drift from the code that produced it turns the parity test into a check against a frozen
//! artifact — a future gather change would pass parity against last month's output, which is
//! the shape where a green test certifies nothing.
//!
//! So: this test regenerates the bytes on every run and **asserts the committed fixture
//! matches**. A gather change that alters output fails HERE, loudly, naming the file, until
//! the fixture is regenerated with `UPDATE_GATHERED_FIXTURE=1`. That env var writes; without
//! it the test is read-only and comparison-only, so CI can never silently rewrite its own
//! oracle.
//!
//! ## What the two stores are
//!
//! Both are valid Zarr v3, both are read by the SAME unmodified client reader:
//!
//! * `stored/`   — a real writer-produced column: sharded, shuffled, gzipped.
//! * `gathered/` — the same logical column, produced by the gathered store's own node
//!   builders (`gathered_group_zarr_json` + `gathered_array_zarr_json`) +
//!   `gather_chunk` over the DECODED bytes of a real writer-produced source, through a
//!   NON-IDENTITY row vector.
//!
//! The gathered side reaches the same values by a genuinely different route: its source rows
//! are in a different order, and the row vector puts them back. An identity permutation over
//! an already-correct source would pass even if `gather_chunk` ignored the vector entirely,
//! which is why the fixture is built shuffled.
//!
//! **The two sides deliberately do NOT share chunk geometry any more.** A real column chunks
//! at the writer's 4096; a virtual array declares its own (DEC-15). That difference is why
//! the ITEM-24 assertions in the parity test had to be re-scoped — see the note there.

use std::fs;
use std::path::{Path, PathBuf};

use txresbench::modules::workstore::gather_decode::{decode_member, DecodePlan};
use txresbench::modules::workstore::gathered::{
    gather_chunk, gathered_array_zarr_json, gathered_group_zarr_json, CHUNK_ELEMENTS_TEST,
};
use serde_json::json;

/// The values both stores must decode to. Deliberately not `0..n`: distinct, order-sensitive
/// values so a permutation error is visible in the DATA rather than only in a count.
const VALUES: [f32; 10] = [
    10.5, 20.25, 30.125, 40.0, 50.5, 60.25, 70.125, 80.0, 90.5, 100.25,
];

/// `SHUFFLE[i]` is the OUTPUT row that source row `i` holds. Kept in step with
/// `tests/fixtures/gathered_parity/generate.py`, which writes the source in this order.
const SHUFFLE: [usize; 10] = [7, 1, 5, 3, 6, 0, 4, 2, 9, 8];

fn fixture_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../ui/src/core/workstore/__fixtures__/gathered")
}

/// The writer-produced stores, committed rather than generated in Rust: there is no zarr
/// WRITER on this side, and inventing one would put a second implementation of the format in
/// the tree — which is how the old fixture came to describe an encoding nobody emits.
fn writer_fixture_root(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/gathered_parity")
        .join(name)
}

/// That store's single MEMBER directory — where the array node and its shards live.
fn writer_fixture(name: &str) -> PathBuf {
    writer_fixture_root(name).join("values")
}

fn read(p: &Path) -> Vec<u8> {
    fs::read(p).unwrap_or_else(|e| {
        panic!(
            "{}: {e}\nRegenerate the writer-produced stores with\n  PYTHONPATH=src-app/packages/_lib \
             python3 src-app/server/tests/fixtures/gathered_parity/generate.py \
             src-app/server/tests/fixtures/gathered_parity",
            p.display()
        )
    })
}

/// One writer-produced member's declaration plus its shard bytes.
fn writer_member(name: &str) -> (serde_json::Value, Vec<(usize, Vec<u8>)>) {
    let dir = writer_fixture(name);
    let meta: serde_json::Value =
        serde_json::from_slice(&read(&dir.join("zarr.json"))).expect("member zarr.json parses");
    let mut shards = Vec::new();
    let mut s = 0usize;
    while let Ok(bytes) = fs::read(dir.join(format!("c/{s}"))) {
        shards.push((s, bytes));
        s += 1;
    }
    assert!(
        !shards.is_empty(),
        "{}: no shards — a member with no bytes would make every decode below vacuous",
        dir.display()
    );
    (meta, shards)
}

/// **The decode the amendment exists for**: real writer bytes → plaintext element bytes.
fn decode_writer_member(name: &str) -> (DecodePlan, Vec<u8>) {
    let (meta, shards) = writer_member(name);
    let plan = DecodePlan::parse(&meta).expect("the writer's chain is the allowed one");
    let plain = decode_member(&plan, &shards).expect("decode");
    assert_eq!(
        plain.len(),
        plan.n * plan.item_size,
        "a decode that returned nothing would satisfy every equality below"
    );
    (plan, plain)
}

/// The axis the parity fixture's SOURCE store declares — READ from the committed writer
/// output, never restated here. This is the value the creator would carry through for these
/// sources, and reading it is what stops the fixture from drifting from the writer.
fn source_declared_axis() -> String {
    let zarr: serde_json::Value =
        serde_json::from_slice(&read(&writer_fixture_root("source").join("zarr.json")))
            .expect("the writer fixture's zarr.json parses");
    zarr.pointer("/attributes/txr/axis")
        .and_then(|a| a.as_str())
        .expect("the writer fixture's source store declares an axis")
        .to_string()
}

fn f32s(raw: &[u8]) -> Vec<f32> {
    raw.chunks_exact(4)
        .map(|c| f32::from_le_bytes(c.try_into().unwrap()))
        .collect()
}

/// `{ relative path -> bytes }` for both stores, exactly the map the client's `memoryStore`
/// is built from.
fn build_stores() -> Vec<(String, Vec<u8>)> {
    let n = VALUES.len();
    let item = 4;
    let mut out: Vec<(String, Vec<u8>)> = Vec::new();

    // ── stored/ — the control, copied VERBATIM from the writer's output. Not rebuilt here:
    // the whole point is that it is bytes this side did not author.
    //
    // **THE WHOLE STORE, group node included — not the member array alone.** It used to copy
    // `stored/values/zarr.json` up to `stored/zarr.json`, producing a ROOT ARRAY: a shape no
    // producer emits, which a client could only read by bypassing `parseStructure`,
    // `asZarrTable` and `resolveMember`. That erased the member-path asymmetry by
    // construction — the exact asymmetry C2 was — so the parity claim was being made against
    // a control that could not have exhibited it.
    let stored_root = writer_fixture_root("stored");
    out.push((
        "stored/zarr.json".into(),
        read(&stored_root.join("zarr.json")),
    ));
    out.push((
        "stored/values/zarr.json".into(),
        read(&stored_root.join("values/zarr.json")),
    ));
    let mut s = 0usize;
    while let Ok(bytes) = fs::read(stored_root.join(format!("values/c/{s}"))) {
        out.push((format!("stored/values/c/{s}"), bytes));
        s += 1;
    }
    assert!(s > 0, "the control store contributed no chunks");

    // ── gathered/ — the same values, reached by DECODING a real writer-produced source and
    // putting its rows back in order through a non-identity vector.
    let (_, source_bytes) = decode_writer_member("source");
    // rows[out] = the index IN THE SOURCE holding output row `out`.
    let rows: Vec<u32> = (0..n)
        .map(|o| SHUFFLE.iter().position(|&x| x == o).unwrap() as u32)
        .collect();

    // Declared small, for the same reason as above: the parity fixture must span several
    // chunks. Production chunks at `CHUNK_ELEMENTS`.
    //
    // The declaration comes from the CREATOR's own builder, and the two nodes from the same
    // functions the byte route serves — so this fixture cannot describe a store shape the
    // server does not produce, which is what the old hand-written `structure` allowed.
    let mut structure = txresbench::modules::workstore::virtual_dataset::gathered_structure(
        "float32",
        Some("numeric"),
        // The axis the writer-produced SOURCE store declares, read off that store rather
        // than spelled: the creator carries the sources' axis kind through
        // (`virtual_dataset::source_axis`), so a parity fixture that named a different one
        // would describe a gathered store the creator cannot produce.
        &source_declared_axis(),
        n,
        // A byte-parity fixture: it pins the STORE shape, not an axis identity. Said
        // explicitly now that the parameter exists, so the omission is a choice.
        txresbench::modules::workstore::virtual_dataset::KeyIdentity::Unpinned,
        json!({}),
    );
    structure["chunk_elements"] = json!(CHUNK_ELEMENTS_TEST);
    out.push((
        "gathered/zarr.json".into(),
        serde_json::to_vec_pretty(&gathered_group_zarr_json(&structure).unwrap()).unwrap(),
    ));
    out.push((
        "gathered/values/zarr.json".into(),
        serde_json::to_vec_pretty(&gathered_array_zarr_json(&structure, None, None).unwrap())
            .unwrap(),
    ));
    for g in 0..n.div_ceil(CHUNK_ELEMENTS_TEST) {
        out.push((
            format!("gathered/values/c/{g}"),
            gather_chunk(g, &rows, &source_bytes, item).unwrap(),
        ));
    }
    out
}

#[test]
fn the_committed_gathered_fixture_matches_freshly_generated_bytes() {
    let root = fixture_root();
    let files = build_stores();
    let updating = std::env::var("UPDATE_GATHERED_FIXTURE").is_ok();

    if updating {
        for (rel, bytes) in &files {
            let p = root.join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(&p, bytes).unwrap();
        }
        // Not a silent success: an updating run must not also be read as a passing guard.
        eprintln!("gathered fixture REGENERATED at {}", root.display());
        return;
    }

    let mut drifted = Vec::new();
    for (rel, bytes) in &files {
        match fs::read(root.join(rel)) {
            Ok(on_disk) if &on_disk == bytes => {}
            Ok(_) => drifted.push(format!("{rel} (content differs)")),
            Err(e) => drifted.push(format!("{rel} ({e})")),
        }
    }
    assert!(
        drifted.is_empty(),
        "the committed gathered fixture no longer matches what the gather produces: {drifted:?}\n\
         This is the guard working. The client parity test reads these bytes, so a stale \
         fixture would let it pass against last month's output while the real gather had \
         changed. Regenerate with UPDATE_GATHERED_FIXTURE=1 and re-run the parity test — do \
         NOT delete this assertion."
    );
}

/// The fixture must be a real EXERCISE of the gather, not a shape that would pass anyway.
///
/// Three things, and they pull in different directions on purpose.
#[test]
fn the_fixture_is_a_real_exercise_of_the_gather() {
    // (0) THE STORED SIDE IS PRODUCTION-ENCODED. This is the assertion that stops the old
    // simplification returning: if `stored/` ever goes back to an uncompressed, unsharded
    // column, the parity claim silently weakens to "gathered decodes like a shape nobody
    // emits" — which is exactly what it used to mean.
    let (stored_meta, _) = writer_member("stored");
    assert_eq!(
        stored_meta["codecs"][0]["name"],
        serde_json::Value::from("sharding_indexed"),
        "the parity control must be in the encoding production uses"
    );
    let inner: Vec<&str> = stored_meta["codecs"][0]["configuration"]["codecs"]
        .as_array()
        .expect("inner chain")
        .iter()
        .filter_map(|c| c["name"].as_str())
        .collect();
    assert!(inner.contains(&"gzip"), "inner chain is {inner:?}");

    // (1) the gather reproduced the stored VALUES, chunk for chunk. Byte-identity is gone
    // and its loss is the improvement: the two stores now differ in encoding, so equality
    // has to be established by DECODING both, which is what the client does.
    let (_, stored_plain) = decode_writer_member("stored");
    assert_eq!(
        f32s(&stored_plain),
        VALUES,
        "the control decodes to the values"
    );

    let files = build_stores();
    let get = |name: &str| {
        files
            .iter()
            .find(|(r, _)| r == name)
            .unwrap_or_else(|| panic!("fixture is missing {name}"))
            .1
            .clone()
    };
    let mut gathered_plain = Vec::new();
    for g in 0..VALUES.len().div_ceil(CHUNK_ELEMENTS_TEST) {
        gathered_plain.extend_from_slice(&get(&format!("gathered/values/c/{g}")));
    }
    assert_eq!(
        f32s(&gathered_plain[..VALUES.len() * 4]),
        f32s(&stored_plain),
        "the gathered chunks must decode to the stored column's values — that identity IS \
         the claim the parity test then proves through the real client reader"
    );

    // (2) …and it had to do real work to get there. If the source were already in output
    // order, (1) would hold for a gather that ignored the row vector entirely.
    let (_, source_plain) = decode_writer_member("source");
    assert_ne!(
        f32s(&source_plain),
        VALUES.to_vec(),
        "the fixture's source must NOT already be in output order, or assertion (1) would \
         pass for a gather that returned the source verbatim"
    );
    assert_ne!(
        source_plain[..CHUNK_ELEMENTS_TEST * 4],
        stored_plain[..CHUNK_ELEMENTS_TEST * 4],
        "the first chunk specifically must be reordered, so chunk 0 alone is a real test"
    );
}

/// **The shard-index arithmetic, exercised across SEVERAL inner chunks.**
///
/// A ten-element column at the writer's default geometry is one inner chunk in one shard, so
/// it cannot tell a correct index walk from one that reads entry 0 and stops.
/// `source_multi/` is the same values written by the same writer in the same chain at
/// `inner_chunk = 4`, so the index carries three entries and the offsets must actually be
/// followed.
#[test]
fn a_member_spanning_several_inner_chunks_decodes_end_to_end() {
    let (plan, plain) = decode_writer_member("source_multi");
    assert!(
        plan.inner < plan.n,
        "FIXTURE IS VACUOUS: inner chunk {} covers the whole {}-element member, so the index \
         walk is never exercised",
        plan.inner,
        plan.n
    );
    let expect: Vec<f32> = SHUFFLE.iter().map(|&i| VALUES[i]).collect();
    assert_eq!(
        f32s(&plain),
        expect,
        "every inner chunk must land at its own offset — a walk that decoded only the first \
         entry would leave the tail as fill and still return the right LENGTH"
    );
}
