//! **TEST-1 [acceptance] [invariant: INV-1] [covers: ITEM-12, ITEM-15, ITEM-20]**
//!
//! > *The server stores and serves. It does not interpret. It confines, caps, hashes,
//! > stores, records and serves bytes. It never opens a byte for meaning.*
//!
//! **AMENDED 2026-08-17 (DEC-23), and this test is unaffected:** the GATHER may decode
//! the writer's chain (`sharding_indexed`+`gzip`+`numcodecs.shuffle`) in
//! `workstore/gather_decode.rs` and nowhere else, because a virtual dataset's bytes were
//! MEASURED to be unproducible otherwise. The opaque serve path this file covers still
//! never opens a byte, and `check-no-format-crates.sh`'s decode-scope check is what keeps
//! the exception to one module rather than to the server.
//! > — `00_CONSOLIDATED_DESIGN.md` §0.3, "The two invariants" (1).
//!
//! Every other test in this suite feeds the server bytes it could plausibly
//! understand and checks that the right ones come back. That shape cannot fail on
//! "the server interpreted them" — a server that decoded, re-encoded and returned
//! equivalent bytes would pass all of them. So this one feeds it a payload that is
//! **structurally impossible to decode** and asserts it comes back anyway, byte for
//! byte, with a `200` and a correct `Content-Length`.
//!
//! The fixture is a Zarr v3 store whose chunk carries a **valid gzip member header
//! and a deflate stream no conforming implementation may accept** (RFC 1951 §3.2.4:
//! a stored block's `LEN` and `NLEN` MUST be one's complements; here they are not).
//! Every signal the server can see says "this is gzip-compressed Zarr":
//!
//!   * the member layout IS a Zarr store (`zarr.json` + `c/0`);
//!   * `zarr.json` declares the `gzip` codec, `float64`, `shape: [8]`;
//!   * the producer's `structure` declares `encoding: "zarr_v3"` and says the chunk
//!     decompresses to 64 bytes — it holds 4, and they do not decompress at all.
//!
//! A server that "helpfully" validated — at ingest, at serve, or anywhere between —
//! would reject or repair this. It must do neither. **The server cannot report the
//! corruption, because it never parsed it.** That is the whole point of the test:
//! the passing condition is the server's *inability* to notice.
//!
//! Four things make it non-vacuous rather than a restatement of "GET returns bytes":
//!
//!  1. **The corruption is PROVED in-test, decoder-free** (`assert_gzip_header_valid_but_stream_undecodable`).
//!     Without that, "corrupt" would be an unverified claim about a byte string and
//!     the test would assert nothing.
//!  2. **`zarr.json` is served byte-identically**, including its non-alphabetical key
//!     order, 4-space indentation and trailing newline — none of which survives a
//!     parse-and-re-emit. A server that read the metadata document at all would
//!     return equivalent JSON, not identical bytes.
//!  3. **The same bytes under two different declared datatypes serve identically**
//!     (`data/opaque`/`opaque` vs a registry-resolved `chunked-dense` type), so the
//!     byte plane provably does not branch on the declared type. Interpretation that
//!     did not vary with the declaration would not be interpretation.
//!  4. **NEGATIVE CONTROL — a member not in the manifest is a `404`.** The `200`s
//!     above are the server resolving and serving a named thing, not a blanket
//!     "everything is 200" that would make every assertion here meaningless.

use serde_json::{json, Value};
use uuid::Uuid;

use cytoanalyst::modules::workstore::catalog::repository::CatalogRepository;
use cytoanalyst::modules::workstore::ingest::ingest_run_outputs;

use super::{create_project, pool_for, server_store, setup_admin, write_manifest};
use crate::common::TestServer;

// ── the fixture ───────────────────────────────────────────────────────────────

/// A Zarr v3 array metadata document — syntactically valid, and deliberately
/// formatted so that a parse-and-re-emit round trip is DETECTABLE: the keys are in
/// spec order rather than alphabetical order, the indentation is 4 spaces, and the
/// document ends with a newline. `serde_json::to_vec` preserves none of the three.
const ZARR_JSON: &[u8] = br#"{
    "zarr_format": 3,
    "node_type": "array",
    "shape": [8],
    "data_type": "float64",
    "chunk_grid": {"name": "regular", "configuration": {"chunk_shape": [8]}},
    "chunk_key_encoding": {"name": "default", "configuration": {"separator": "/"}},
    "fill_value": 0.0,
    "codecs": [
        {"name": "bytes", "configuration": {"endian": "little"}},
        {"name": "gzip", "configuration": {"level": 5}}
    ],
    "attributes": {}
}
"#;

/// The lowest-sorting CONCRETE registered datatype declaring `layout` as its storage
/// layout. Used to obtain a second declared type that a byte-plane test can CONTRAST
/// against `data/opaque` without naming a contributed id: `ingest` validates the
/// declared layout against the registry's, so the pair has to be real, and the app's
/// own roots deliberately ship no concrete non-opaque leaf (DEC-2). Sorted so the
/// choice is deterministic across bundles; panics rather than degrading to a
/// same-layout pair, because a same-layout contrast is not the assertion this file
/// makes.
fn first_concrete_datatype_with_layout(layout: &str) -> String {
    use cytoanalyst::modules::datatype::DatatypeRegistry;
    let reg = DatatypeRegistry::build_from_embedded().expect("merged registry builds");
    let mut ids: Vec<String> = reg
        .all()
        .into_iter()
        .filter(|dt| !dt.is_abstract && dt.storage.layout.as_storage_layout() == layout)
        .map(|dt| dt.id.clone())
        .collect();
    ids.sort();
    ids.into_iter().next().unwrap_or_else(|| {
        panic!(
            "no CONCRETE registered datatype declares storage layout `{layout}`, so the \
             two-declaration contrast this test rests on cannot be built. Either a \
             contributed bundle stopped shipping one, or the roots changed."
        )
    })
}

/// Offsets into [`corrupt_gzip_chunk`]'s output, so the proof below reads the
/// fields it names rather than magic indices.
const GZIP_HEADER_LEN: usize = 10;
const DEFLATE_BLOCK_HEADER: usize = GZIP_HEADER_LEN; // BFINAL/BTYPE byte
const STORED_LEN_AT: usize = DEFLATE_BLOCK_HEADER + 1;
const STORED_NLEN_AT: usize = STORED_LEN_AT + 2;

/// A **valid gzip member header followed by an undecodable deflate stream.**
///
/// The header (RFC 1952 §2.3) is entirely legal, so a reader has every reason to
/// begin inflating. The first deflate block (RFC 1951 §3.2.4) is a *stored* block
/// whose `LEN`/`NLEN` pair is not a one's-complement pair — which the spec states
/// as a MUST, so every conforming inflate implementation is required to reject the
/// stream. The gzip trailer's CRC32 and ISIZE are wrong for any payload as well, so
/// even an implementation that ignored the block header would fail at the end.
fn corrupt_gzip_chunk() -> Vec<u8> {
    let mut v = Vec::new();
    // ID1 ID2 CM FLG MTIME(4) XFL OS — a canonical, entirely valid gzip header.
    v.extend_from_slice(&[0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0x00, 0xff]);
    // BFINAL = 1, BTYPE = 00 (stored).
    v.push(0x01);
    v.extend_from_slice(&4u16.to_le_bytes()); // LEN  = 4
    v.extend_from_slice(&0u16.to_le_bytes()); // NLEN = 0 — MUST be 0xfffb. It is not.
    v.extend_from_slice(b"\xde\xad\xbe\xef"); // the four "stored" bytes
    v.extend_from_slice(&[0, 0, 0, 0]); // CRC32 — wrong for any payload
    v.extend_from_slice(&[0, 0, 0, 0]); // ISIZE — wrong for any payload
    v
}

/// Prove, **without a decompressor**, that the fixture is what this test claims:
/// a stream a reader would start on and could not finish.
///
/// This is the assertion that stops the whole test from being "a GET returned the
/// bytes I stored". If the payload were merely arbitrary noise, "the server did not
/// notice" would say nothing — noise is not something a server could be expected to
/// notice. A gzip header that a decoder WOULD accept, in front of a body the format
/// spec REQUIRES it to reject, is a defect any validating server would report.
fn assert_gzip_header_valid_but_stream_undecodable(chunk: &[u8]) {
    assert_eq!(
        &chunk[0..3],
        &[0x1f, 0x8b, 0x08],
        "the fixture must carry the gzip magic + CM=deflate, so a reader BEGINS decoding it"
    );
    assert_eq!(
        chunk[3], 0x00,
        "FLG must be 0 (no extra/name/comment fields) — the header is unambiguously well-formed"
    );
    assert_eq!(
        chunk[DEFLATE_BLOCK_HEADER] & 0x07,
        0x01,
        "the first deflate block must be a FINAL STORED block (BFINAL=1, BTYPE=00), \
         which is the case whose LEN/NLEN check RFC 1951 §3.2.4 states as a MUST"
    );
    let len = u16::from_le_bytes([chunk[STORED_LEN_AT], chunk[STORED_LEN_AT + 1]]);
    let nlen = u16::from_le_bytes([chunk[STORED_NLEN_AT], chunk[STORED_NLEN_AT + 1]]);
    assert_ne!(
        nlen, !len,
        "NLEN is the one's complement of LEN, so this stream is DECODABLE and the \
         test's premise is false — every assertion below would then be vacuous"
    );
}

/// The producer's declaration: it says the bytes are a gzip-coded Zarr v3 chunk that
/// decompresses to 64 bytes (8 × float64). They are 27 bytes that decompress to
/// nothing. A server holding any opinion about its payload has, in this row, every
/// input it needs to form one.
fn declared_structure() -> Value {
    json!({
        "encoding": "zarr_v3",
        "data_type": "float64",
        "shape": [8],
        "n": 8,
        "codecs": ["bytes", "gzip"],
        "members": {
            "c/0": { "codec": "gzip", "uncompressed_bytes": 64 }
        }
    })
}

// ── TEST-1 ────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn test1_a_structurally_undecodable_chunk_is_stored_and_served_verbatim() {
    let chunk = corrupt_gzip_chunk();
    assert_gzip_header_valid_but_stream_undecodable(&chunk);

    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let sid = create_project(&server, &token, "serve-opaque").await;
    let pool = pool_for(&server).await;
    let store = server_store(&server);

    // The SAME store directory declared TWICE under two different datatypes whose
    // registry storage layouts differ (`opaque` vs `chunked-dense`). If the byte
    // plane interpreted anything, the declaration is where it would learn how.
    //
    // The chunked id is RESOLVED FROM THE REGISTRY, not spelled: the app's six
    // universal roots (DEC-2) contain no CONCRETE `chunked-dense` type by design —
    // every one of them is contributed — so hardcoding one would pin this test to a
    // particular contributed bundle for a property that is about the BYTE PLANE and
    // has nothing to do with which domain shipped the type (INV-5).
    let chunked_datatype = first_concrete_datatype_with_layout("chunked-dense");
    let ws = server
        .data_dir()
        .join(format!("staging-{}", Uuid::new_v4()));
    let manifest = json!({ "outputs": [
        { "id": "as_opaque", "datatype": "data/opaque", "path": "opaque.zarr",
          "layout": "opaque", "role": "artifact",
          "structure": declared_structure(), "meta": { "title": "declared gzip zarr" } },
        { "id": "as_chunked", "datatype": chunked_datatype, "path": "chunked.zarr",
          "layout": "chunked-dense", "role": "artifact",
          "structure": declared_structure(), "meta": { "title": "declared gzip zarr" } }
    ]});
    write_manifest(
        &ws,
        &manifest,
        &[
            ("opaque.zarr/zarr.json", ZARR_JSON),
            ("opaque.zarr/c/0", &chunk),
            ("chunked.zarr/zarr.json", ZARR_JSON),
            ("chunked.zarr/c/0", &chunk),
        ],
    )
    .await;

    // ── (a) INGEST accepts it ─────────────────────────────────────────────────
    // The write path hashes, caps, confines and records. It does not decode, so a
    // payload that contradicts its own declaration is not its business. A validating
    // ingest fails here, before any of the serve assertions ever run.
    let run_id = Uuid::new_v4();
    let rows = ingest_run_outputs(&pool, &store, Some(sid), None, run_id, None, &ws)
        .await
        .expect(
            "ingest REFUSED a payload it could not decode — the write path is opening \
             bytes for meaning (INV-1)",
        );
    assert_eq!(rows.len(), 2);
    let opaque = rows
        .iter()
        .find(|r| r.output_id == "as_opaque")
        .expect("the opaque-typed row");
    let chunked = rows
        .iter()
        .find(|r| r.output_id == "as_chunked")
        .expect("the chunked-typed row");

    for row in [opaque, chunked] {
        assert_eq!(
            row.status, "ready",
            "an undecodable payload landed in a non-ready status ({}) — the server \
             formed an opinion about bytes it does not open",
            row.status
        );
        assert!(
            row.is_multifile,
            "a directory is ONE row with members (INV-4)"
        );
        assert_eq!(
            row.structure,
            declared_structure(),
            "the producer's declaration is stored VERBATIM even though it contradicts \
             the payload it describes: the server neither corrected it against the \
             bytes nor annotated it with what it found"
        );
    }

    // Identity is a pure function of the bytes: two rows, two declared datatypes,
    // two `structure`s' worth of claims — one content identity, because the only
    // thing that fed it was the member set.
    assert_eq!(
        opaque.content_hash, chunked.content_hash,
        "content identity moved when only the DECLARATION changed — the hash is \
         being fed something other than the bytes"
    );

    // ── (b) SERVE returns it, byte for byte ───────────────────────────────────
    let get = |artifact: Uuid, member: &str| {
        let url = server.api_url(&format!("/artifacts/{artifact}/data/{member}"));
        let client = server.client.clone();
        let token = token.clone();
        async move {
            client
                .get(url)
                .bearer_auth(token)
                .send()
                .await
                .expect("request")
        }
    };

    let r = get(opaque.id, "c/0").await;
    assert_eq!(
        r.status().as_u16(),
        200,
        "the undecodable chunk must serve 200 — the server has no basis for any other \
         answer, because it never looked"
    );
    assert_eq!(
        r.headers()
            .get("content-length")
            .and_then(|v| v.to_str().ok()),
        Some(chunk.len().to_string().as_str()),
        "Content-Length is the STORED length ({}), taken from stat — not a decoded \
         size, and not omitted because the body could not be understood",
        chunk.len()
    );
    assert_eq!(
        r.headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok()),
        Some("application/octet-stream"),
        "every body on this plane is octet-stream: the server does not know what it is \
         holding, so it cannot claim a more specific type"
    );
    let served = r.bytes().await.expect("body");
    assert_eq!(
        served.as_ref(),
        chunk.as_slice(),
        "the served chunk is not byte-identical to the stored one — something \
         decoded, normalized or repaired it"
    );

    // ── (c) the METADATA document is bytes too ────────────────────────────────
    // `zarr.json` is the one member a "helpful" server has an obvious reason to
    // read: it is JSON, it is small, and it describes everything else. Its bytes
    // come back with the same key order, the same 4-space indentation and the same
    // trailing newline they were written with — a parse-and-re-emit round trip
    // preserves none of those, so this assertion discriminates between "served the
    // bytes" and "served an equivalent document".
    let r = get(opaque.id, "zarr.json").await;
    assert_eq!(r.status().as_u16(), 200);
    let served_meta = r.bytes().await.expect("body");
    assert_eq!(
        served_meta.as_ref(),
        ZARR_JSON,
        "`zarr.json` came back re-formatted. The server parsed the store's metadata \
         document — the one file it would have to read to interpret anything else."
    );

    // ── (d) an arbitrary INTERIOR span of the undecodable stream ──────────────
    // A server that had to decode in order to answer could not serve bytes 12..=15
    // of a stream that cannot be decoded at all. This one seeks and limits.
    let r = server
        .client
        .get(server.api_url(&format!(
            "/artifacts/{}/data/c/0?range={}-{}",
            opaque.id,
            STORED_NLEN_AT,
            STORED_NLEN_AT + 3
        )))
        .bearer_auth(&token)
        .send()
        .await
        .expect("range request");
    assert_eq!(r.status().as_u16(), 200);
    assert_eq!(
        r.bytes().await.expect("body").as_ref(),
        &chunk[STORED_NLEN_AT..=STORED_NLEN_AT + 3],
        "an interior span of an undecodable stream must come back exactly — the \
         server answers a byte range, not a decoded region"
    );

    // ── (e) the two declared datatypes serve IDENTICALLY ──────────────────────
    let a = get(opaque.id, "c/0").await;
    let b = get(chunked.id, "c/0").await;
    assert_eq!(a.status(), b.status());
    assert_eq!(
        a.headers().get("content-length"),
        b.headers().get("content-length")
    );
    assert_eq!(
        a.bytes().await.expect("body"),
        b.bytes().await.expect("body"),
        "the same bytes served differently under two declared datatypes — the byte \
         plane is branching on the declaration, which is interpretation"
    );

    // ── (f) nothing, anywhere, reports the corruption ─────────────────────────
    // Not the status, not a header, not the row. The server has no channel for it
    // because it has no knowledge of it.
    let meta: Value = server
        .client
        .get(server.api_url(&format!("/artifacts/{}", opaque.id)))
        .bearer_auth(&token)
        .send()
        .await
        .expect("artifact metadata")
        .json()
        .await
        .expect("metadata json");
    assert_eq!(meta["status"], "ready");
    assert_eq!(
        meta["structure"],
        declared_structure(),
        "the declaration on the wire is still the producer's, unamended"
    );
    let repo = CatalogRepository::new(pool.clone());
    let reread = repo
        .get_any_status(opaque.id)
        .await
        .expect("get")
        .expect("row still there");
    assert_eq!(
        reread.status, "ready",
        "no later pass (a sweep, a verifier) downgraded the row after serving it"
    );

    // ── (g) NEGATIVE CONTROL — a member that is NOT in the manifest is a 404 ──
    // Without this, every 200 above would be consistent with a server that answers
    // 200 to anything, and the test would prove nothing at all.
    let r = get(opaque.id, "c/1").await;
    assert_eq!(
        r.status().as_u16(),
        404,
        "a member absent from the merkle manifest must 404 — the 200s above are the \
         server RESOLVING a named member, not answering indiscriminately"
    );
}
