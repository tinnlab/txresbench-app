//! TEST-25 — `GET /api/sandbox/status` exposes the additive full `content_sha256`
//! (64 hex) alongside the unchanged 12-char `content_version` — the env digest the
//! provenance layer pins (ITEM-6).

use super::*;

#[tokio::test]
async fn sandbox_status_exposes_full_content_sha256() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    let resp = server
        .client
        .get(server.api_url("/sandbox/status"))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("get sandbox status");
    assert_eq!(resp.status().as_u16(), 200, "admin reads sandbox status");
    let status: Value = resp.json().await.expect("status json");

    let rootfs = &status["rootfs"];
    // Both fields are present strings (additive; the version is unchanged).
    let sha = rootfs["content_sha256"].as_str().expect("content_sha256 field present");
    let version = rootfs["content_version"].as_str().expect("content_version field present");

    // Consistency is asserted UNCONDITIONALLY (env-independent): the full digest
    // and the 12-char version are populated together or empty together — a build
    // that populated one but not the other (or inconsistently) fails here even in
    // a stub environment.
    assert_eq!(
        sha.is_empty(),
        version.is_empty(),
        "content_sha256 and content_version are populated consistently (both or neither)"
    );
    // On a real (non-stub) rootfs build the full digest is a 64-hex superset whose
    // 12-char prefix IS content_version (a stub build yields empty strings — docker
    // absent / non-Linux at build time — already covered by the consistency check).
    if !version.is_empty() {
        assert_eq!(sha.len(), 64, "full digest is 64 hex chars");
        assert!(sha.chars().all(|c| c.is_ascii_hexdigit()), "digest is hex");
        assert_eq!(version.len(), 12, "content_version is the 12-char prefix");
        assert_eq!(&sha[..12], version, "content_version is the sha256 prefix");
    }
}
