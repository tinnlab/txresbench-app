//! TEST-17 — storing the same emitted source twice yields ONE
//! `provenance_code_blobs` row (dedup by sha256); source/byte_len/language
//! round-trip by sha256.
//!
//! (The TEST-19 emitted-replay parity suite lived here and compared the stored blob
//! against the predicate-DSL evaluator. ITEM-4 scrapped that DSL; the surviving
//! emitter's replay parity is held by the shared coercion corpus in
//! `provenance::criteria_script`'s own tests.)

use super::*;

#[tokio::test]
async fn identical_code_dedups_to_one_row() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let (project_id, root_id, _hash) =
        create_project_with_artifact(&server, &admin, "code blob project").await;

    // Two selections that emit BYTE-IDENTICAL predicate code (same recipe).
    let run1 = record_selection(&server, &admin, project_id, root_id, column_recipe("3")).await;
    let run2 = record_selection(&server, &admin, project_id, root_id, column_recipe("3")).await;

    let sha1 = run1["code_sha256"].as_str().expect("run1 code_sha256");
    let sha2 = run2["code_sha256"].as_str().expect("run2 code_sha256");
    assert_eq!(sha1, sha2, "identical source → identical sha (the dedup key)");

    let pool = pool_for(&server).await;

    // Exactly ONE code-blob row for that sha, despite two recordings.
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM provenance_code_blobs WHERE sha256 = $1",
    )
    .bind(sha1)
    .fetch_one(&pool)
    .await
    .expect("count code blobs");
    assert_eq!(count, 1, "one deduped code-blob row for identical source");

    // source/byte_len/language round-trip by sha256.
    let row = sqlx::query_as::<_, (String, String, i64)>(
        "SELECT source, language, byte_len FROM provenance_code_blobs WHERE sha256 = $1",
    )
    .bind(sha1)
    .fetch_one(&pool)
    .await
    .expect("fetch code blob");
    assert!(!row.0.is_empty(), "source stored");
    assert_eq!(row.1, "python", "language round-trips");
    assert_eq!(row.2 as usize, row.0.len(), "byte_len == source length");

    // A DIFFERENT recipe emits different code → a distinct sha (a second row).
    let run3 = record_selection(&server, &admin, project_id, root_id, column_recipe("7")).await;
    let sha3 = run3["code_sha256"].as_str().expect("run3 code_sha256");
    assert_ne!(sha1, sha3, "different predicate → different code sha");
    let total: i64 = sqlx::query_scalar("SELECT count(*) FROM provenance_code_blobs")
        .fetch_one(&pool)
        .await
        .expect("count all");
    assert_eq!(total, 2, "two distinct code blobs total");
}
