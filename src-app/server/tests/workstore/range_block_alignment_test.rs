//! **TEST-9 [covers: ITEM-2, ITEM-14]** — the byte plane, asked the spans a BLOCK-ALIGNED
//! reader really emits (#158).
//!
//! The client half of this pair is a browser OME-TIFF reader. It fetches through geotiff's
//! block reader, which aligns every request to a multiple of its block size and therefore,
//! on the LAST block of any object whose length is not a whole number of blocks, asks for
//! bytes past the end. For a pyramidal image that last block is precisely where the level
//! directories live, so it is the one read a multi-level image cannot do without.
//!
//! The two dialects answer that differently, and this is where it is pinned:
//!
//!   * the `Range:` HEADER form **clamps** the inclusive end to the last byte → `206`;
//!   * the `?range=` QUERY form — the one every ziee client speaks, because the URL is then
//!     the cache key — **refuses** it → `416`, with `Content-Range: bytes */{total}`.
//!
//! So the client MUST clamp before it spells the span, and this test is what makes that
//! obligation real rather than defensive decoration. Its sibling on the TypeScript side
//! asserts the client never EMITS the unclamped span; either test alone would still pass
//! with the clamp deleted, which is exactly why both exist.
//!
//! The object length here is deliberately NOT a multiple of the block size (`4 * 65536 +
//! 1234`), because an object that happened to be block-aligned would never produce the
//! overrun and this test would assert nothing.

use cytoanalyst::modules::workstore::catalog::repository::CatalogRepository;
use cytoanalyst::modules::workstore::object_store::ObjectStore;

use super::{create_project, new_artifact, pool_for, server_store, setup_admin};
use crate::common::TestServer;

/// geotiff's default block size — the alignment every span below is derived from.
const BLOCK: usize = 65_536;
/// Not a whole number of blocks, on purpose. See the module comment.
const TOTAL: usize = 4 * BLOCK + 1_234;

#[tokio::test]
async fn test9_block_aligned_spans_are_answered_and_the_overrun_is_refused() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let sid = create_project(&server, &token, "range-block-alignment").await;
    let pool = pool_for(&server).await;
    let store = server_store(&server);

    // A recognisable byte pattern, so a wrong span is visible in the body rather than only
    // in a length.
    let bytes: Vec<u8> = (0..TOTAL).map(|i| (i % 251) as u8).collect();
    let key = store.put(&bytes).await.expect("put blob");
    let art = CatalogRepository::new(pool)
        .insert_artifact(&new_artifact(sid, "image", key.as_str(), false))
        .await
        .expect("insert artifact");

    let url = server.api_url(&format!("/artifacts/{}/data", art.id));
    let get = |query: String| {
        let url = url.clone();
        let token = token.clone();
        let client = server.client.clone();
        async move {
            client
                .get(format!("{url}{query}"))
                .bearer_auth(token)
                .send()
                .await
                .expect("request")
        }
    };

    // ── 1. every INTERIOR block-aligned span the reader emits is answered whole ──────────
    //
    // geotiff asks `bytes=<offset>-<offset + length>` — an inclusive end, so one byte MORE
    // than the block it will use. Each of these is a span a real read of this object issues.
    for block in 0..3usize {
        let start = block * BLOCK;
        let end = start + BLOCK; // inclusive, and inside the object for blocks 0..2
        let response = get(format!("?range={start}-{end}")).await;
        assert_eq!(
            response.status(),
            200,
            "an interior block-aligned span must be answered 200 (the URL names the bytes, \
             so the response is complete FOR THAT URL); block {block}"
        );
        assert_eq!(
            response.headers().get("content-length").unwrap(),
            (end - start + 1).to_string().as_str(),
            "the served length must be the whole inclusive span"
        );
        assert!(
            response.headers().get("content-range").is_none(),
            "the `?range=` dialect answers 200 and carries no Content-Range"
        );
        let body = response.bytes().await.expect("body");
        assert_eq!(
            body.as_ref(),
            &bytes[start..=end],
            "the served bytes must be exactly the requested span, not a shifted or short one"
        );
    }

    // ── 2. the LAST block overruns, and the query dialect REFUSES it ─────────────────────
    let last_start = 4 * BLOCK;
    let overrun_end = last_start + BLOCK; // 28 302 bytes past the end of the object
    assert!(overrun_end >= TOTAL, "the fixture must actually produce an overrun");
    let refused = get(format!("?range={last_start}-{overrun_end}")).await;
    assert_eq!(
        refused.status(),
        416,
        "`?range=` does NOT clamp: an end past the last byte is a request for bytes the \
         object does not have. This is why the client must clamp before it spells the span."
    );
    assert_eq!(
        refused.headers().get("content-range").unwrap(),
        format!("bytes */{TOTAL}").as_str()
    );
    assert!(
        refused.bytes().await.expect("body").is_empty(),
        "a 416 carries no body — a client that ignored the status would get nothing, not a \
         truncated block"
    );

    // ── 3. the SAME span, clamped the way the client clamps it, is answered ──────────────
    //
    // The positive control. Without it, step 2 would pass against a server that refused
    // every range, and this test would be certifying a broken byte plane.
    let clamped_end = TOTAL - 1;
    let ok = get(format!("?range={last_start}-{clamped_end}")).await;
    assert_eq!(ok.status(), 200, "the clamped last block must be answerable");
    assert_eq!(
        ok.bytes().await.expect("body").as_ref(),
        &bytes[last_start..=clamped_end],
        "the clamped last block must be the real tail of the object"
    );

    // ── 4. the HEADER dialect clamps the very same overrun ───────────────────────────────
    //
    // Recorded because it is the difference that decides the client's design: a reader
    // pointed at the header form would never have needed to clamp, and a reader pointed at
    // the cacheable query form always does.
    let via_header = server
        .client
        .get(&url)
        .bearer_auth(&token)
        .header("Range", format!("bytes={last_start}-{overrun_end}"))
        .send()
        .await
        .expect("request");
    assert_eq!(via_header.status(), 206, "the RFC 9110 header form clamps and answers 206");
    assert_eq!(
        via_header.headers().get("content-range").unwrap(),
        format!("bytes {last_start}-{clamped_end}/{TOTAL}").as_str()
    );

    // ── 5. and the whole object is never what a ranged read degrades into ────────────────
    //
    // The failure this pair ultimately protects against is silent: a client that fetched
    // `/data` with no span at all would render identically and be catastrophic on a
    // multi-gigabyte image. So the un-ranged read is measured here, once, to show that it is
    // a DIFFERENT and much larger answer — the thing every ranged assertion above is not.
    let whole = get(String::new()).await;
    assert_eq!(whole.status(), 200);
    assert_eq!(
        whole.headers().get("content-length").unwrap(),
        TOTAL.to_string().as_str(),
        "an un-ranged GET really does serve the entire object"
    );
}
