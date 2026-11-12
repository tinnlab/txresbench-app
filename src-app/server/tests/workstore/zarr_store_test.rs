//! `GET /artifacts/{id}/data[/{*member}]` is the ONE read surface (artifact-model
//! ITEM-9/10/12) — and, by ITEM-12, the ONLY one.
//!
//! **TEST-18 [covers: ITEM-12]** — `GET /artifacts/{id}/read` returns **404**. The route,
//! `serve_core.rs`, the Selection grammar and the tier system are gone.
//!
//! Why a 404 assertion is worth a test rather than "the file isn't there any more": a
//! deleted handler is invisible to every other gate. `cargo check` passes, the guards
//! pass, and a `.route("/artifacts/{id}/read", …)` line re-added tomorrow to "just
//! unblock one client" would put a Selection parser back on the server with nothing
//! failing. This test is what fails.
//!
//! It is asserted three ways, because 404 is a weak signal on its own:
//!   1. bare `/read` — the route is not registered at all;
//!   2. `/read?col=0` — the Selection grammar is not parsed either (a surviving handler
//!      would answer 200/400 on a well-formed selection, never 404);
//!   3. against a REAL artifact the caller can read — `/data` on the same id answers 200
//!      in the same test, so the 404 is the route's absence and not an authz or
//!      artifact-not-found result that would 404 whatever we asked for.
//!
//! (3) is the negative control. Without it this test passes on a broken server.
//!
//! **TEST-43 [covers: ITEM-30]** — the byte routes are DECLARED in the emitted OpenAPI
//! spec as `application/octet-stream`, so the generated client carries a method.
//!
//! **TEST-48 [covers: ITEM-36]** — `?range=` is the cacheable byte-span vocabulary:
//! `200` (never `206`), a suffix form, hard `416`/`400` validation, and — the
//! regression that motivated the item — a bad range NEVER degrades to the whole blob.
//!
//! **TEST-49 [covers: ITEM-37]** — serving a blob much larger than the memory bound
//! keeps peak RSS flat, with the pre-change buffering primitive as a negative control.

use serde_json::json;

use txresbench::modules::workstore::catalog::repository::CatalogRepository;
use txresbench::modules::workstore::object_store::ObjectStore;

use super::{create_project, new_artifact, pool_for, server_store, setup_admin};
use crate::common::TestServer;

// ── TEST-18 — the Selection→Arrow read surface is GONE ────────────────────────────
#[tokio::test]
async fn test18_artifact_read_route_is_gone() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let sid = create_project(&server, &token, "read-is-gone").await;
    let pool = pool_for(&server).await;
    let store = server_store(&server);

    // A real, readable, single-file artifact — the negative control's subject.
    let values: [f32; 4] = [1.0, 2.0, 3.0, 4.0];
    let bytes: Vec<u8> = values.iter().flat_map(|v| v.to_le_bytes()).collect();
    let key = store.put(&bytes).await.expect("put blob");
    let art = CatalogRepository::new(pool)
        .insert_artifact(&new_artifact(sid, "values", key.as_str(), false))
        .await
        .expect("insert artifact");

    let get = |path: String| {
        let url = server.api_url(&path);
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

    // (3) NEGATIVE CONTROL FIRST — this artifact IS readable over the surviving surface,
    //     so a 404 below cannot be "no such artifact" or "not allowed".
    let ok = get(format!("/artifacts/{}/data", art.id)).await;
    assert_eq!(
        ok.status().as_u16(),
        200,
        "the artifact IS readable over /data"
    );
    assert_eq!(
        ok.bytes().await.expect("body").as_ref(),
        bytes.as_slice(),
        "/data serves the stored bytes verbatim"
    );

    // (1) the bare route is not registered.
    assert_eq!(
        get(format!("/artifacts/{}/read", art.id))
            .await
            .status()
            .as_u16(),
        404,
        "GET /artifacts/{{id}}/read is deleted (ITEM-12): /data is the only read path"
    );

    // (2) …and neither is the Selection grammar. `col=` / `row=` / `project=` / `mask=`
    //     were the wire selection; a surviving handler would parse them, not 404.
    for selection in [
        "col=0",
        "row=0:1",
        "project=values",
        "mask=00000000-0000-0000-0000-000000000000",
    ] {
        let r = get(format!("/artifacts/{}/read?{selection}", art.id)).await;
        assert_eq!(
            r.status().as_u16(),
            404,
            "the Selection grammar is gone — `?{selection}` must not resolve to a handler"
        );
    }

    // The retired PREVIOUS generation stays retired too (S5b's `/de` + `/slice`), so this
    // test covers every read wire the workstore has ever exposed except `/data`.
    assert_eq!(
        get(format!("/artifacts/{}/de", art.id))
            .await
            .status()
            .as_u16(),
        404,
        "the bespoke /de page route stays retired"
    );
    let slice = server
        .client
        .post(server.api_url(&format!("/artifacts/{}/slice", art.id)))
        .bearer_auth(&token)
        .json(&json!({ "kind": "sparse_column", "column": 0 }))
        .send()
        .await
        .expect("slice request");
    assert_eq!(
        slice.status().as_u16(),
        404,
        "the bespoke /slice route stays retired"
    );
}

// ── TEST-43 [covers: ITEM-30] — the byte routes are DECLARED, not invisible ────────
//
// `.route()` registers a working endpoint that aide never sees: the spec has no entry,
// the generator emits no `ApiClient` method, and the only way for the frontend to reach
// it is a hand-rolled `getBaseUrl()` + `getAuthToken()` + raw `fetch` — the exact thing
// the "call the generated method" rule forbids, and a violation no gate could catch
// because as far as the generator was concerned the endpoint did not exist.
//
// So the assertion is on the two GENERATED artifacts, not on the router: the committed
// `openapi.json` must describe both byte routes with an `application/octet-stream` 200
// and the `range` query parameter, and the committed `types.ts` must carry a method for
// each. That also makes this the regen gate — declaring the routes in code but never
// running `just openapi-regen` leaves the client exactly as method-less as before.
#[test]
fn test43_byte_routes_are_declared_as_octet_stream() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let spec_path = root.join("../ui/openapi/openapi.json");
    // The endpoint map moved OUT of `types.ts` when `finish_and_emit` began
    // emitting four files: `Permissions`, `PermissionDescriptions` and the
    // `ApiEndpoints` map each got their own module. A guard that keeps reading
    // `types.ts` for an endpoint silently loses its subject — the same shape that
    // narrowed `regen.test.ts` and broke `collect-actions.mjs` in the same split.
    let types_path = root.join("../ui/src/api-client/apiEndpoints.ts");
    let spec: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(&spec_path)
            .unwrap_or_else(|e| panic!("read {}: {e}", spec_path.display())),
    )
    .expect("openapi.json parses");
    let types = std::fs::read_to_string(&types_path)
        .unwrap_or_else(|e| panic!("read {}: {e}", types_path.display()));

    for (path, op_id) in [
        ("/api/artifacts/{id}/data", "Workstore.getArtifactData"),
        (
            "/api/artifacts/{id}/data/{*member}",
            "Workstore.getArtifactDataMember",
        ),
    ] {
        let op = spec
            .pointer(&format!("/paths/{}/get", path.replace('~', "~0").replace('/', "~1")))
            .unwrap_or_else(|| {
                panic!("`GET {path}` is absent from the spec — it is still a plain `.route()`, or the regen was skipped")
            });

        // Declared as bytes, and as bytes SPECIFICALLY.
        assert!(
            op.pointer("/responses/200/content/application~1octet-stream")
                .is_some(),
            "`GET {path}` 200 must be declared `application/octet-stream`; got: {}",
            op.pointer("/responses/200/content").unwrap_or(&json!(null))
        );
        // …and NOT as JSON. Without this, a declaration that says `application/json`
        // over an opaque body would satisfy "the key exists" and mistype the client.
        assert!(
            op.pointer("/responses/200/content/application~1json")
                .is_none(),
            "`GET {path}` must not claim a JSON body — the server never opens these bytes (INV-1)"
        );

        // The `?range=` span is part of the CONTRACT (ITEM-36), so it must be declared
        // too — a client generated without it cannot express a chunk read.
        let params = op
            .get("parameters")
            .and_then(|p| p.as_array())
            .cloned()
            .unwrap_or_default();
        assert!(
            params
                .iter()
                .any(|p| p.get("name") == Some(&json!("range"))
                    && p.get("in") == Some(&json!("query"))),
            "`GET {path}` must declare the `range` QUERY parameter; got {params:?}"
        );

        assert_eq!(
            op.get("operationId").and_then(|v| v.as_str()),
            Some(op_id),
            "`GET {path}` must keep its stable operationId (it names the generated method)"
        );
        assert!(
            types.contains(&format!("'{op_id}': 'GET {path}'")),
            "the generated `apiEndpoints.ts` carries no `{op_id}` endpoint — regen was skipped"
        );
    }

    // NEGATIVE CONTROL: the check discriminates content types rather than accepting
    // whatever is there. A JSON control-plane route must NOT look like a byte route.
    let json_op = spec
        .pointer("/paths/~1api~1artifacts~1{id}/get")
        .expect("the artifact-metadata route exists");
    assert!(
        json_op
            .pointer("/responses/200/content/application~1json")
            .is_some()
            && json_op
                .pointer("/responses/200/content/application~1octet-stream")
                .is_none(),
        "the JSON control plane must still be declared as JSON — otherwise the octet \
         assertion above is not testing content type at all"
    );
}

// ── TEST-48 [covers: ITEM-36] — `?range=` is the cacheable byte-span vocabulary ────
#[tokio::test]
async fn test48_range_query_param_semantics() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let sid = create_project(&server, &token, "range-param").await;
    let pool = pool_for(&server).await;
    let store = server_store(&server);

    // 64 distinct bytes, so "which bytes came back" is unambiguous.
    let blob: Vec<u8> = (0u8..64).collect();
    let key = store.put(&blob).await.expect("put blob");
    let art = CatalogRepository::new(pool)
        .insert_artifact(&new_artifact(sid, "span", key.as_str(), false))
        .await
        .expect("insert artifact");

    let base = format!("/artifacts/{}/data", art.id);
    let get = |query: &str, range_header: Option<&str>| {
        let url = server.api_url(&format!("{base}{query}"));
        let client = server.client.clone();
        let token = token.clone();
        let hdr = range_header.map(str::to_string);
        async move {
            let mut req = client.get(url).bearer_auth(token);
            if let Some(h) = hdr {
                req = req.header("Range", h);
            }
            req.send().await.expect("request")
        }
    };

    // ── the closed span: exactly those bytes, 200, immutable ──────────────────────
    let r = get("?range=8-11", None).await;
    assert_eq!(
        r.status().as_u16(),
        200,
        "`?range=` answers 200, NEVER 206 — the URL names the exact resource, so the \
         response is complete FOR THAT URL, which is what makes it cacheable"
    );
    assert_eq!(
        r.headers()
            .get("cache-control")
            .and_then(|v| v.to_str().ok()),
        Some("private, max-age=31536000, immutable"),
        "a byte span keeps the immutable cache contract (ITEM-9)"
    );
    assert_eq!(
        r.headers()
            .get("content-length")
            .and_then(|v| v.to_str().ok()),
        Some("4"),
        "Content-Length is set from stat — a client that cannot see the size upfront \
         cannot size a buffer or show progress"
    );
    assert!(
        r.headers().get("content-range").is_none(),
        "a 200 carries no Content-Range; that header is 206 vocabulary"
    );
    assert_eq!(r.bytes().await.expect("body").as_ref(), &blob[8..=11]);

    // ── the suffix form — load-bearing: it is how a client reads a trailer BEFORE
    //    it knows the file's size (a shard's index), so it cannot be dropped. ──────
    let r = get("?range=-4", None).await;
    assert_eq!(r.status().as_u16(), 200);
    assert_eq!(r.bytes().await.expect("body").as_ref(), &blob[60..64]);
    // …and it is the one CLAMPING form, for the same reason: a caller that cannot
    // know the length cannot be required to keep n inside it.
    let r = get("?range=-4096", None).await;
    assert_eq!(r.status().as_u16(), 200);
    assert_eq!(r.bytes().await.expect("body").as_ref(), blob.as_slice());

    // ── open-ended ────────────────────────────────────────────────────────────────
    let r = get("?range=60-", None).await;
    assert_eq!(r.status().as_u16(), 200);
    assert_eq!(r.bytes().await.expect("body").as_ref(), &blob[60..64]);

    // ── out of bounds ⇒ 416, and NOT clamped ──────────────────────────────────────
    for oob in [
        "?range=64-70",
        "?range=100-200",
        "?range=60-999",
        "?range=64-",
        "?range=-0",
    ] {
        let r = get(oob, None).await;
        assert_eq!(
            r.status().as_u16(),
            416,
            "`{oob}` names bytes this object does not have"
        );
        let body = r.bytes().await.expect("body");
        assert!(
            body.as_ref() != blob.as_slice(),
            "`{oob}` must not answer with the blob"
        );
    }

    // ── malformed ⇒ 400 ───────────────────────────────────────────────────────────
    for bad in [
        "?range=",           // empty
        "?range=-",          // no number either side
        "?range=junk",       // not a span
        "?range=8",          // a bare offset is not a span
        "?range=bytes=8-11", // the header's unit does not belong in the param
        "?range=8-11,20-29", // the batched form does not exist — refused, never widened
        "?range=11-8",       // inverted
        "?range=%208-11",    // leading whitespace: one spelling per value
        "?range=%2B8-11",    // a leading `+`
    ] {
        let r = get(bad, None).await;
        assert_eq!(r.status().as_u16(), 400, "`{bad}` must be a 400");
        let body = r.bytes().await.expect("body");
        assert!(
            body.as_ref() != blob.as_slice(),
            "`{bad}` must not answer with the blob"
        );
    }

    // ── THE REGRESSION THIS ITEM EXISTS FOR ───────────────────────────────────────
    // `parse_range` answers an unparsable spec with the WHOLE blob under a 200: a
    // client asking for 4 bytes silently receives all 64 and can only notice by
    // checking for a 206 it never sees. On a 134 MB shard that is a silent 134 MB
    // transfer. Asserted as a class, over every refused span above: none of them may
    // come back 200, and none may come back blob-sized.
    for refused in [
        "?range=junk",
        "?range=8-11,20-29",
        "?range=bytes=8-11",
        "?range=11-8",
        "?range=100-200",
        "?range=60-999",
    ] {
        let r = get(refused, None).await;
        let status = r.status().as_u16();
        let body = r.bytes().await.expect("body");
        assert_ne!(
            status, 200,
            "`{refused}` degraded to a 200 — the whole-blob fallback is back"
        );
        assert_ne!(
            body.len(),
            blob.len(),
            "`{refused}` returned a blob-sized body ({} bytes) — the whole-blob \
             fallback is back",
            body.len()
        );
    }

    // ── NEGATIVE CONTROL: one way to say it ───────────────────────────────────────
    // A `Range:` header AND `?range=` on one request is a 400, not a precedence rule:
    // two sources for one value is the ambiguity INV-2 forbids, and a precedence rule
    // would hand a client whose two spellings disagree bytes it did not ask for.
    let r = get("?range=8-11", Some("bytes=0-3")).await;
    assert_eq!(
        r.status().as_u16(),
        400,
        "a `Range:` header AND `?range=` on one request is a 400"
    );
    // …and the same pair AGREEING is still a 400 — this is a rule about ambiguity of
    // SOURCE, not about the values happening to differ.
    let r = get("?range=8-11", Some("bytes=8-11")).await;
    assert_eq!(
        r.status().as_u16(),
        400,
        "even two AGREEING spellings are a 400"
    );

    // ── the bare `Range:` header, alone, still answers RFC 9110 semantics ──────────
    // Kept deliberately: this surface advertises `Accept-Ranges: bytes`, so a generic
    // HTTP client (curl -r, a resumed download, a third-party range-aware reader) must
    // get the standard answer. It is not the cacheable path and no txresbench client emits
    // it, so it cannot reintroduce the 206-caching problem `?range=` solves. This
    // assertion is what makes the 400 above a rule about AMBIGUITY rather than a
    // back-door removal of the header.
    let r = get("", Some("bytes=8-11")).await;
    assert_eq!(
        r.status().as_u16(),
        206,
        "a bare `Range:` header still answers 206"
    );
    assert_eq!(r.bytes().await.expect("body").as_ref(), &blob[8..=11]);

    // ── no span at all ⇒ the whole object ─────────────────────────────────────────
    let r = get("", None).await;
    assert_eq!(r.status().as_u16(), 200);
    assert_eq!(
        r.headers()
            .get("content-length")
            .and_then(|v| v.to_str().ok()),
        Some("64")
    );
    assert_eq!(r.bytes().await.expect("body").as_ref(), blob.as_slice());
}

// ── TEST-49 [covers: ITEM-37] — serving is STREAMED; peak RSS stays flat ──────────
//
// This has to be a MEMORY assertion. Buffering and streaming return byte-identical
// bodies, so every correctness test in this file is structurally blind to the
// difference — `/data` passed all of them while `ObjectStore::get` pulled the entire
// blob into a `Vec` per concurrent request. With shard geometry moving to ~16.8M
// elements (~134 MB for f64), that is 134 MB of heap pinned per in-flight reader for
// bytes the server never opens for meaning (INV-1).
//
// The gate is only worth anything if something can FAIL it, so the pre-change
// primitive runs as a negative control in the same test, against the same blob and
// the same bound: `ObjectStore::get` must EXCEED the bound. A bound nothing can fail
// proves nothing.
//
// Linux-only: it reads `VmHWM` (peak RSS) out of `/proc`. There is no portable
// equivalent, and platform-gating an OS-specific measurement is the house rule.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn test49_serving_a_large_blob_does_not_buffer_it() {
    use futures_util::StreamExt;

    /// Far larger than the bound, and larger than any shard geometry in play.
    const BLOB_BYTES: usize = 96 * 1024 * 1024;
    /// The bound, in KiB. A streamed read costs `STREAM_CHUNK_BYTES` (64 KiB) per
    /// in-flight request; a buffered one costs the whole blob. 32 MiB sits an order of
    /// magnitude above the first and a third of the second, so it discriminates
    /// without being sensitive to allocator slack.
    const BOUND_KIB: u64 = 32 * 1024;
    /// Concurrent readers. Under buffering this is 4 × 96 MiB resident at once, which
    /// no boot-time high-water mark could absorb — so the gate holds even if the peak
    /// reset below is refused by the kernel.
    const READERS: usize = 4;

    /// One `/proc/<pid>/status` field, in KiB.
    fn status_kib(pid: &str, field: &str) -> u64 {
        let s = std::fs::read_to_string(format!("/proc/{pid}/status"))
            .unwrap_or_else(|e| panic!("read /proc/{pid}/status: {e}"));
        s.lines()
            .find(|l| l.starts_with(field))
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|v| v.parse().ok())
            .unwrap_or_else(|| panic!("no {field} in /proc/{pid}/status"))
    }
    /// Reset the peak-RSS high-water mark to the CURRENT RSS (`clear_refs` type 5), so
    /// a delta measures this window and not whatever the process did at boot.
    fn reset_peak(pid: &str) {
        let _ = std::fs::write(format!("/proc/{pid}/clear_refs"), "5");
    }

    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let sid = create_project(&server, &token, "stream-not-buffer").await;
    let pool = pool_for(&server).await;
    let store = server_store(&server);

    // Real content, not a zero page — a `vec![0; N]` can stay backed by the shared
    // zero page and never become resident, which would make the negative control lie.
    let mut blob = vec![0u8; BLOB_BYTES];
    for (i, b) in blob.iter_mut().enumerate() {
        *b = (i % 251) as u8;
    }
    let key = store.put(&blob).await.expect("put big blob");
    drop(blob);
    let art = CatalogRepository::new(pool)
        .insert_artifact(&new_artifact(sid, "big", key.as_str(), false))
        .await
        .expect("insert artifact");

    // ── NEGATIVE CONTROL — the PRE-CHANGE path busts the bound ────────────────────
    // `ObjectStore::get` is literally what `range_response` used to call. If this did
    // not exceed the bound the bound would be meaningless and the positive assertion
    // below would prove nothing.
    reset_peak("self");
    let before = status_kib("self", "VmHWM:");
    let buffered = store.get(&key).await.expect("buffered read");
    let buffered_peak = status_kib("self", "VmHWM:").saturating_sub(before);
    assert_eq!(buffered.len(), BLOB_BYTES);
    drop(buffered);
    assert!(
        buffered_peak > BOUND_KIB,
        "NEGATIVE CONTROL FAILED: buffering a {} MiB blob only moved peak RSS by {} KiB, \
         under the {} KiB bound — the bound cannot discriminate, so the assertion below \
         is vacuous",
        BLOB_BYTES / (1024 * 1024),
        buffered_peak,
        BOUND_KIB
    );

    // ── POSITIVE (in-process) — the primitive the serve path now uses stays flat ──
    reset_peak("self");
    let before = status_kib("self", "VmHWM:");
    let mut stream = store
        .get_stream(&key, 0, BLOB_BYTES as u64)
        .await
        .expect("streamed read");
    let mut streamed = 0usize;
    while let Some(chunk) = stream.next().await {
        streamed += chunk.expect("stream chunk").len();
    }
    let streamed_peak = status_kib("self", "VmHWM:").saturating_sub(before);
    assert_eq!(streamed, BLOB_BYTES, "the stream must deliver every byte");
    assert!(
        streamed_peak < BOUND_KIB,
        "streaming the same {} MiB blob moved peak RSS by {} KiB — over the {} KiB bound",
        BLOB_BYTES / (1024 * 1024),
        streamed_peak,
        BOUND_KIB
    );

    // ── THE GATE — the real HTTP path, under concurrency ──────────────────────────
    // The two measurements above prove the bound discriminates between the two
    // PRIMITIVES. This one proves the HANDLER picked the right one: rewire it back to
    // `get()` and this is what fails.
    let pid = server_pid_for(server.data_dir())
        .expect("could not locate the spawned server process — the RSS gate cannot run blind");
    let pid = pid.to_string();

    // Warm up first, so connection/TLS/route-init allocations land BEFORE the baseline.
    let warm = server
        .client
        .get(server.api_url(&format!("/artifacts/{}/data?range=0-15", art.id)))
        .bearer_auth(&token)
        .send()
        .await
        .expect("warmup");
    assert_eq!(warm.status().as_u16(), 200);
    let _ = warm.bytes().await;

    reset_peak(&pid);
    let before = status_kib(&pid, "VmHWM:");

    // Drain chunk-by-chunk: a `.bytes()` here would buffer 4 × 96 MiB in the TEST and
    // say nothing about the server.
    let mut reads = Vec::new();
    for _ in 0..READERS {
        let url = server.api_url(&format!("/artifacts/{}/data", art.id));
        let client = server.client.clone();
        let token = token.clone();
        reads.push(tokio::spawn(async move {
            let mut resp = client
                .get(url)
                .bearer_auth(token)
                .send()
                .await
                .expect("big read");
            assert_eq!(resp.status().as_u16(), 200);
            assert_eq!(
                resp.headers()
                    .get("content-length")
                    .and_then(|v| v.to_str().ok()),
                Some(BLOB_BYTES.to_string().as_str()),
                "Content-Length comes from stat, never chunked encoding"
            );
            let mut n = 0usize;
            while let Some(c) = resp.chunk().await.expect("chunk") {
                n += c.len();
            }
            n
        }));
    }
    for r in reads {
        assert_eq!(r.await.expect("reader"), BLOB_BYTES, "every byte arrived");
    }

    let served_peak = status_kib(&pid, "VmHWM:").saturating_sub(before);
    assert!(
        served_peak < BOUND_KIB,
        "serving {READERS} concurrent reads of a {} MiB blob moved the SERVER's peak RSS \
         by {} KiB, over the {} KiB bound — the byte plane is buffering again \
         (`ObjectStore::get`/`get_range` instead of `get_stream`)",
        BLOB_BYTES / (1024 * 1024),
        served_peak,
        BOUND_KIB
    );
}

// ── TEST-46 [covers: ITEM-34] — the manifest is decoded ONCE, not per member ──────
//
// `resolve_member` read and JSON-decoded the WHOLE member manifest on every member
// request. ITEM-36 makes every chunk its own `GET`, so that put an O(members) read +
// decode + allocation on the per-chunk path and made reading one artifact O(members²)
// — measured, release, at 5,000 members: 2.3 ms and 873 KB per chunk request; at
// 50,000: 23.7 ms and 8.7 MB. The last figure is the one that mattered, because
// ITEM-37 exists to make serving bytes cost CONSTANT memory and resolution was
// allocating 8.7 MB in front of a 64 KB chunk, once per concurrent request.
//
// **This counts decodes, not latency.** A timing assertion on a shared box measures
// the box; and the failure it has to catch is not slowness but a cache that is
// populated and never consulted — which is exactly what a "the cache has an entry"
// assertion would pass against. So the manifest BLOB IS UNLINKED between the two
// requests. After that, the only thing that can answer a member request is a decoded
// map the server already holds: one manifest read is all the artifact ever gets, and
// the second request proves it needed no second one.
//
// Three properties are asserted, and the last two are what make the first mean
// something:
//
//   1. a SECOND member request — for a DIFFERENT member, so a per-result memo could
//      not stand in for a decoded map — still answers 200 with the right bytes;
//   2. NEGATIVE CONTROL: a second artifact, manifest unlinked the same way but never
//      requested, answers 404. Without it (1) also passes on a server that stopped
//      consulting manifests at all, which is the same green-for-nothing this test
//      exists to refuse;
//   3. a member that never existed still answers 404 from the cached map — the
//      cache resolves, it does not wave requests through.
#[tokio::test]
async fn test46_member_requests_decode_the_manifest_once() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let sid = create_project(&server, &token, "manifest decoded once").await;
    let pool = pool_for(&server).await;
    let store = server_store(&server);
    let repo = CatalogRepository::new(pool);

    // Two multi-file artifacts with DISTINCT member bytes, so their manifests are
    // distinct blobs and one cannot answer for the other.
    let mk = |tag: u8| -> Vec<(String, Vec<u8>)> {
        (0..8u8)
            .map(|i| (format!("X/c/0/{i}"), vec![tag ^ i; 32]))
            .collect()
    };
    let warmed_members = mk(0x10);
    let warmed = store.put_prefix(&warmed_members).await.expect("put warmed");
    let cold = store.put_prefix(&mk(0x20)).await.expect("put cold");
    assert_ne!(
        warmed.object_key, cold.object_key,
        "the two artifacts must not share a manifest blob"
    );

    let art_warm = repo
        .insert_artifact(&new_artifact(
            sid,
            "warmed",
            warmed.object_key.as_str(),
            true,
        ))
        .await
        .expect("insert warmed");
    let art_cold = repo
        .insert_artifact(&new_artifact(sid, "cold", cold.object_key.as_str(), true))
        .await
        .expect("insert cold");

    let member = |id: uuid::Uuid, path: &str| {
        let url = server.api_url(&format!("/artifacts/{id}/data/{path}"));
        let client = server.client.clone();
        let token = token.clone();
        async move {
            let r = client
                .get(url)
                .bearer_auth(token)
                .send()
                .await
                .expect("member request");
            (r.status().as_u16(), r.bytes().await.expect("body").to_vec())
        }
    };

    // ONE member request against the warmed artifact — the only manifest read it is
    // ever going to get.
    let (status, body) = member(art_warm.id, "X/c/0/0").await;
    assert_eq!(status, 200, "the first member request serves");
    assert_eq!(body, warmed_members[0].1, "…and serves the member's bytes");

    // Unlink BOTH manifest blobs. `delete` (not a raw unlink) is what the reclaim
    // path actually calls, and it drops the cached decoding — so this also proves the
    // 200 below is not stale state surviving a documented invalidation point.
    // Members are left intact: what is being removed is the ability to RESOLVE.
    for k in [&warmed.object_key, &cold.object_key] {
        store.delete(k).await.expect("unlink manifest blob");
        assert!(
            !store.exists(k).await.expect("exists"),
            "manifest blob gone"
        );
    }

    // (1) A DIFFERENT member of the warmed artifact — still served, still correct.
    let (status, body) = member(art_warm.id, "X/c/0/5").await;
    assert_eq!(
        status, 200,
        "a second member request must not need a second manifest read (ITEM-34)"
    );
    assert_eq!(
        body, warmed_members[5].1,
        "the cached manifest resolved to the RIGHT member, not merely to something"
    );

    // (3) Absence is still absence.
    let (status, _) = member(art_warm.id, "X/c/0/99").await;
    assert_eq!(
        status, 404,
        "a cached manifest answers for the members it holds and no others"
    );

    // (2) NEGATIVE CONTROL — never requested, so nothing decoded it.
    let (status, _) = member(art_cold.id, "X/c/0/0").await;
    assert_eq!(
        status, 404,
        "an artifact whose manifest was never read MUST fail once its blob is gone — \
         otherwise the 200 above proves nothing about the cache"
    );
}

/// Find the spawned test server's pid: the harness launches it as
/// `<binary> --config-file <temp config>`, and that config embeds this test's unique
/// `data_dir`. Scanning for that pairing identifies exactly one process even when
/// several test servers are running side by side.
#[cfg(target_os = "linux")]
fn server_pid_for(data_dir: &std::path::Path) -> Option<u32> {
    let want = data_dir.to_string_lossy().to_string();
    for entry in std::fs::read_dir("/proc").ok()?.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        let Ok(cmdline) = std::fs::read(format!("/proc/{pid}/cmdline")) else {
            continue;
        };
        let argv: Vec<String> = cmdline
            .split(|b| *b == 0)
            .filter(|s| !s.is_empty())
            .map(|s| String::from_utf8_lossy(s).to_string())
            .collect();
        let Some(i) = argv.iter().position(|a| a == "--config-file") else {
            continue;
        };
        let Some(config) = argv.get(i + 1) else {
            continue;
        };
        if std::fs::read_to_string(config)
            .map(|c| c.contains(&want))
            .unwrap_or(false)
        {
            return Some(pid);
        }
    }
    None
}

// ═════════════════════════════════════════════════════════════════════════════
//  TEST-16 [covers: ITEM-10] — the JSON control plane is NEVER long-lived-cached
// ═════════════════════════════════════════════════════════════════════════════
//
// > | `GET /artifacts?<filter>` (the JSON control plane) | **never** cacheable — rows
// > are mutable |
// > — `routes.rs`'s own header table, and artifact-model ITEM-10.
//
// The property holds by construction today: `IMMUTABLE_CACHE` has ONE set site
// (`data_api.rs`, inside `octet_response`) and it is on the byte plane. But a
// structural argument is not an assertion — nothing fails if a later edit adds the
// header to a control-plane route, and a stale-cached listing is invisible in
// exactly the way a caching bug always is: the client shows an artifact that was
// deleted, or misses one that was just produced, and every server-side test still
// passes because the SERVER is right.
//
// ── WHAT MAKES THIS MORE THAN "THE HEADER IS ABSENT" ──────────────────────────
// An assertion that a header is missing passes just as happily on a server where
// the header is set NOWHERE — including one where the byte plane's immutable
// contract has been deleted, which is the opposite regression and equally bad. So
// the byte route is exercised in the SAME test, against the SAME artifact, and must
// carry the exact directive string. That pairing is the negative control: one of the
// two assertions fails whichever direction the single set site moves.
//
// The parser is likewise driven against the byte route's real header and must
// REPORT it (immutable = true, max-age = 31536000). A directive parser that silently
// returns "nothing" would otherwise make every control-plane green meaningless.

/// The byte plane's cache contract, verbatim (ITEM-9). Spelled once.
const IMMUTABLE_CACHE_HEADER: &str = "private, max-age=31536000, immutable";

/// The largest `max-age` a MUTABLE resource may claim. Any freshness lifetime at all
/// is a client showing a deleted row; a minute is the slack for a proxy default, not
/// a licence.
const MAX_MUTABLE_AGE_SECONDS: u64 = 60;

/// The two directives that decide whether a response is long-lived-cacheable:
/// `(carries `immutable`, the `max-age` it claims)`.
fn cache_directives(header: Option<&str>) -> (bool, Option<u64>) {
    let Some(h) = header else {
        return (false, None);
    };
    let lower = h.to_ascii_lowercase();
    let immutable = lower.split(',').any(|d| d.trim() == "immutable");
    let max_age = lower.split(',').find_map(|d| {
        d.trim()
            .strip_prefix("max-age=")
            .and_then(|v| v.trim().parse::<u64>().ok())
    });
    (immutable, max_age)
}

#[tokio::test]
async fn test16_control_plane_is_never_long_lived_cached_but_the_byte_plane_is() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let sid = create_project(&server, &token, "cache-contract").await;
    let pool = pool_for(&server).await;
    let store = server_store(&server);

    let key = store.put(&[7u8; 32]).await.expect("put blob");
    let art = CatalogRepository::new(pool)
        .insert_artifact(&new_artifact(sid, "row", key.as_str(), false))
        .await
        .expect("insert artifact");

    let get = |path: String| {
        let url = server.api_url(&path);
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
    let header_of = |r: &reqwest::Response| -> Option<String> {
        r.headers()
            .get("cache-control")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
    };

    // ── THE POSITIVE CONTROL FIRST — the byte plane DOES carry the contract ──────
    // Stated before the negatives on purpose: if this fails, every "no cache header"
    // assertion below is being satisfied by a server that sets the header nowhere,
    // and reading them as evidence would be the exact mistake this entry corrects.
    for byte_path in [
        format!("/artifacts/{}/data", art.id),
        format!("/artifacts/{}/data?range=0-3", art.id),
    ] {
        let r = get(byte_path.clone()).await;
        assert_eq!(r.status().as_u16(), 200, "`{byte_path}` serves bytes");
        assert_eq!(
            header_of(&r).as_deref(),
            Some(IMMUTABLE_CACHE_HEADER),
            "`{byte_path}` must carry the immutable byte-plane contract (ITEM-9)"
        );
        // …and the parser can SEE it. A parser that reported nothing here would make
        // every control-plane assertion below vacuously true.
        let (immutable, max_age) = cache_directives(header_of(&r).as_deref());
        assert!(
            immutable && max_age == Some(31_536_000),
            "the directive parser did not read the byte plane's own header \
             ({:?}) — it cannot be trusted to detect one on the control plane",
            header_of(&r)
        );
    }

    // ── THE CONTROL PLANE — every JSON route, filtered and unfiltered ───────────
    for json_path in [
        format!("/projects/{sid}/artifacts"),
        // the `<filter>` form ITEM-10 names explicitly — a filtered listing is the
        // one most tempting to cache, and is just as mutable as the unfiltered one
        format!("/projects/{sid}/artifacts?output_id=row"),
        format!("/projects/{sid}/catalog"),
        format!("/artifacts/{}", art.id),
    ] {
        let r = get(json_path.clone()).await;
        assert_eq!(r.status().as_u16(), 200, "`{json_path}` answers");
        let header = header_of(&r);
        assert_ne!(
            header.as_deref(),
            Some(IMMUTABLE_CACHE_HEADER),
            "`{json_path}` is the JSON control plane over MUTABLE rows and must never \
             carry the byte plane's immutable contract"
        );
        let (immutable, max_age) = cache_directives(header.as_deref());
        assert!(
            !immutable,
            "`{json_path}` declares `immutable` over mutable rows — a client that \
             caches this shows deleted artifacts and misses new ones, forever \
             (cache-control: {header:?})"
        );
        assert!(
            max_age.is_none_or(|a| a < MAX_MUTABLE_AGE_SECONDS),
            "`{json_path}` claims max-age={max_age:?} on mutable rows (bound: \
             {MAX_MUTABLE_AGE_SECONDS}s). Rows are refreshed by the sync channel, so a \
             freshness lifetime is a stale listing the client cannot see past \
             (cache-control: {header:?})"
        );
    }
}

// ═════════════════════════════════════════════════════════════════════════════
//  TEST-15 [covers: ITEM-9] — ranges are exact AT CHUNK BOUNDARIES
// ═════════════════════════════════════════════════════════════════════════════
//
// TEST-15's other two clauses are asserted elsewhere and were verified there:
// member-path resolution in `member_path_test.rs::test5_…` (`:244-246`), and the
// immutable cache header in `test48_range_query_param_semantics` (`:277-280`).
// THIS is the clause that was asserted nowhere — the off-by-one at a chunk edge.
//
// ── WHY test48 COULD NOT COVER IT ─────────────────────────────────────────────
// `test48`'s fixture is a FLAT 64-byte blob, `(0u8..64).collect()`, with no chunk
// structure at all, and `range.rs`'s unit tests parse spans against a bare length.
// Both are blob-edge tests. A Zarr client does not read blob edges: it reads the
// i-th CHUNK out of a shard, at `[i*C, (i+1)*C)`, and an implementation that is one
// byte long or one byte late returns a buffer that DECODES — to the wrong values,
// silently, for one element per chunk.
//
// So the fixture here is a real shard: `CHUNKS` chunks of `CHUNK_BYTES`, each filled
// with a DISTINCT byte. That single property is what makes a one-byte error visible
// at all — on a uniform buffer a shifted read compares equal to a correct one and
// the test is blind. It is asserted directly, as the negative control: the
// deliberately-shifted read must return DIFFERENT bytes than the aligned one.
//
// It is driven through the MEMBER route (`/data/{*member}`), not the whole-object
// route, because that is where the clause lives: the span is resolved AFTER the
// manifest lookup, so an off-by-one could be introduced by either the parser or the
// member resolution, and only the member path exercises both.
//
// ── WHAT THIS DOES *NOT* CLAIM ────────────────────────────────────────────────
// Measured, not assumed: every off-by-one that could be injected into the SHARED
// parse/serve path (span length one short, span offset one late, the member route
// dropping `?range=` entirely, a "serve at most one chunk" truncation) turns this
// test red — and also turns `test48` or `member_path_test::test5` red, because
// `test48`'s blob is 64 DISTINCT bytes and catches a global shift too. So the
// incremental fault-detection here is narrow, and saying otherwise would be the
// overclaim this entry exists to correct.
//
// The reason no break is unique to it is itself the design: under INV-1 the server
// has no chunk concept at all — it never opens a byte for meaning — so there is no
// server-side chunk arithmetic for a chunk-only bug to live in. What this test adds
// is therefore a CONTRACT assertion rather than a new code path: that a client
// reading the i-th chunk of a shard by byte span receives the i-th chunk, stated at
// every boundary, with a shifted-read control that ties a returned buffer to a chunk
// IDENTITY (`test48` can say "these 4 bytes", never "this is chunk 2"). That is the
// clause TEST-15 enumerates and nothing asserted.

/// Bytes per chunk in the shard fixture.
const CHUNK_BYTES: usize = 16;
/// Chunks packed into the one shard member.
const CHUNKS: usize = 4;

/// The shard: `CHUNKS` chunks of `CHUNK_BYTES`, chunk `i` filled with `0xA0 + i`.
/// Distinct fills are the whole point — see the header.
fn shard_bytes() -> Vec<u8> {
    (0..CHUNKS)
        .flat_map(|i| std::iter::repeat_n(0xA0u8 + i as u8, CHUNK_BYTES))
        .collect()
}

#[tokio::test]
async fn test15_member_ranges_are_exact_at_chunk_boundaries() {
    use txresbench::modules::workstore::ingest::ingest_run_outputs;
    use uuid::Uuid;

    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let sid = create_project(&server, &token, "chunk-edges").await;
    let pool = pool_for(&server).await;
    let store = server_store(&server);

    // A multi-file artifact whose `data/c/0` member IS the shard.
    let shard = shard_bytes();
    let total = shard.len();
    assert_eq!(total, CHUNKS * CHUNK_BYTES);
    let ws = server
        .data_dir()
        .join(format!("staging-{}", Uuid::new_v4()));
    let manifest = json!({ "outputs": [
        { "id": "shard", "datatype": "data/opaque", "path": "result", "layout": "opaque",
          "role": "artifact",
          "structure": { "encoding": "opaque", "media_type": "application/octet-stream" },
          "meta": {} }
    ]});
    super::write_manifest(
        &ws,
        &manifest,
        &[
            (
                "result/zarr.json",
                br#"{"zarr_format":3,"node_type":"group"}"#.as_slice(),
            ),
            ("result/data/c/0", shard.as_slice()),
        ],
    )
    .await;
    let mut rows = ingest_run_outputs(&pool, &store, Some(sid), None, Uuid::new_v4(), None, &ws)
        .await
        .expect("ingest the shard directory");
    let art = rows.remove(0);
    assert!(art.is_multifile, "the fixture is a directory artifact");

    let base = format!("/artifacts/{}/data/data/c/0", art.id);
    let fetch = |query: String| {
        let url = server.api_url(&format!("{base}{query}"));
        let client = server.client.clone();
        let token = token.clone();
        async move {
            let r = client
                .get(url)
                .bearer_auth(token)
                .send()
                .await
                .expect("member range request");
            let status = r.status().as_u16();
            let len = r
                .headers()
                .get("content-length")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<usize>().ok());
            let body = r.bytes().await.expect("body").to_vec();
            (status, len, body)
        }
    };

    // ── the whole member first: the fixture really is what this test thinks ─────
    let (status, len, body) = fetch(String::new()).await;
    assert_eq!(status, 200);
    assert_eq!(len, Some(total));
    assert_eq!(body, shard, "the member serves the shard verbatim");

    for i in 0..CHUNKS {
        let start = i * CHUNK_BYTES;
        let end = start + CHUNK_BYTES - 1; // inclusive

        // ── the chunk itself: exactly its own bytes, none of its neighbours' ─────
        let (status, len, body) = fetch(format!("?range={start}-{end}")).await;
        assert_eq!(status, 200, "chunk {i} at [{start},{end}]");
        assert_eq!(
            len,
            Some(CHUNK_BYTES),
            "chunk {i} reported the wrong Content-Length"
        );
        assert_eq!(
            body,
            shard[start..=end],
            "chunk {i} served the wrong bytes — a chunk-aligned read must be the \
             chunk, with no neighbour byte and no missing byte"
        );

        // ── ONE BYTE EITHER SIDE of the leading boundary ─────────────────────────
        // The first byte of chunk i…
        let (_, len, body) = fetch(format!("?range={start}-{start}")).await;
        assert_eq!(len, Some(1));
        assert_eq!(
            body,
            vec![shard[start]],
            "the single byte AT chunk {i}'s boundary is the first byte of chunk {i}"
        );
        // …and the byte before it, which belongs to the PREVIOUS chunk.
        if start > 0 {
            let (_, len, body) = fetch(format!("?range={}-{}", start - 1, start - 1)).await;
            assert_eq!(len, Some(1));
            assert_eq!(
                body,
                vec![shard[start - 1]],
                "the byte BEFORE chunk {i}'s boundary belongs to chunk {} — an \
                 off-by-one here returns the wrong chunk's value",
                i - 1
            );
            // …and a two-byte span STRADDLING the boundary carries exactly one of each.
            let (_, len, body) = fetch(format!("?range={}-{}", start - 1, start)).await;
            assert_eq!(len, Some(2));
            assert_eq!(
                body,
                vec![shard[start - 1], shard[start]],
                "a span straddling chunk {i}'s boundary must carry the last byte of \
                 the previous chunk and the first of this one, in that order"
            );
            assert_ne!(
                body[0], body[1],
                "the two bytes across a boundary came from the same chunk, so this \
                 fixture has lost its chunk structure and the whole test is blind"
            );
        }

        // ── NEGATIVE CONTROL: a deliberately SHIFTED read of the same length ─────
        // This is what proves the assertions above are measuring alignment and not
        // merely "some bytes came back". On a uniform buffer the shifted read would
        // compare EQUAL to the aligned one and every assertion here would pass while
        // the server was off by one.
        if start > 0 {
            let (_, len, shifted) = fetch(format!("?range={}-{}", start - 1, end - 1)).await;
            assert_eq!(
                len,
                Some(CHUNK_BYTES),
                "the shifted read is the same LENGTH"
            );
            assert_ne!(
                shifted,
                shard[start..=end],
                "a one-byte-shifted read returned chunk {i} exactly — the fixture \
                 cannot distinguish an off-by-one, so its green proves nothing"
            );
            assert_eq!(
                shifted,
                shard[start - 1..=end - 1],
                "the shifted read must be the shifted slice, byte for byte"
            );
        }
    }

    // ── the LAST boundary — the end of the shard, and one past it ───────────────
    let (_, len, body) = fetch(format!("?range={}-{}", total - 1, total - 1)).await;
    assert_eq!(len, Some(1));
    assert_eq!(body, vec![shard[total - 1]], "the shard's final byte");
    // One past the end is NOT clamped: a chunk index computed one too far is a bug on
    // the client, and it must hear about it rather than receive a short buffer.
    let (status, _, body) = fetch(format!("?range={}-{}", total - 1, total)).await;
    assert_eq!(
        status, 416,
        "a span reaching one byte past the last chunk is unsatisfiable, never clamped"
    );
    assert_ne!(body, shard, "…and must not degrade to the whole member");

    // ── the suffix form lands on a chunk boundary too ───────────────────────────
    // It is the form a client uses before it knows the member's size, so it is the
    // one that reads a trailing chunk without arithmetic.
    let (status, len, body) = fetch(format!("?range=-{CHUNK_BYTES}")).await;
    assert_eq!(status, 200);
    assert_eq!(len, Some(CHUNK_BYTES));
    assert_eq!(
        body,
        shard[total - CHUNK_BYTES..],
        "`?range=-{CHUNK_BYTES}` is exactly the last chunk"
    );
}
