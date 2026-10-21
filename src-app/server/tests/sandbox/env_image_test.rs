//! TEST-21 [ITEM-23] — the env-image registry, integration-level. An
//! analysis-domain env-id (declared by a converter manifest as `env: <id>`)
//! resolves to its GHCR `EnvImageRef` (per-env repo + the moving
//! `schema<N>-latest-<arch>` tag the runtime resolves at pull time — fetch-newest,
//! nothing embedded). The live OCI pull+verify+mount is exercised in
//! `env_image_oci_test.rs`; this test's value is the resolve + cross-module wiring.
//!
//! The env_image codec has its own `#[cfg(test)]` unit tests; this test's added
//! value is the CROSS-MODULE + HTTP wiring — it derives the env-id from the LIVE
//! extension manifest served over `GET /api/extensions` (the real server's baked
//! registry) and proves that manifest's declared `env` resolves through the
//! sandbox registry. So a changed manifest `env` that no longer resolves fails
//! here, not silently at converter-run time.

use serde_json::Value;

use cytoanalyst::modules::rootfs::version::ROOTFS_SCHEMA_VERSION;
use cytoanalyst::modules::sandbox::env_image::resolve;

use super::setup_admin;
use crate::common::TestServer;

#[tokio::test]
async fn manifest_env_resolves_through_the_env_image_registry() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;

    // The env-id comes from the LIVE server manifest, not a hardcoded literal.
    let extensions: Value = server
        .client
        .get(server.api_url("/extensions"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("GET /extensions")
        .json()
        .await
        .expect("extensions json");
    let anndata = extensions
        .as_array()
        .expect("array")
        .iter()
        .find(|e| e["id"] == "anndata-import")
        .expect("anndata-import present");
    let env_id = anndata["contributes"]["converters"][0]["env"]
        .as_str()
        .expect("the h5ad-import converter declares an env image");
    // R3-F2: the env-id is DATA. This file's own header already promised it comes
    // "from the LIVE server manifest, not a hardcoded literal" — and then asserted
    // a concrete domain name anyway, which is the leak (the app crate's own test
    // surface knowing WHICH domain ships). What is load-bearing here is that the
    // manifest declares SOME well-formed env and that the app resolves THAT id;
    // the identity of the domain belongs to the processor package.
    assert!(
        !env_id.trim().is_empty(),
        "the converter must declare a non-empty env image id"
    );

    // --- the registry resolves that env-id to its per-env repo + the MOVING
    // schema+arch tag the runtime fetch-newest-resolves at pull time (DEC-I; NO
    // baked digest — the OciEnvImageProvider resolves tag→digest against the
    // registry). ---
    let env_ref = resolve(env_id).expect("the manifest's declared env resolves in the registry");
    // The app owns the REGISTRY BASE and nothing below it; the trailing component
    // is the manifest's id, passed through verbatim (DEC-23/L).
    assert_eq!(
        env_ref.oci_ref,
        format!("ghcr.io/ziee-ai/cyto-env/{env_id}"),
        "per-env GHCR repo = <product registry base>/<manifest env-id>"
    );
    let expect_tag = format!("schema{ROOTFS_SCHEMA_VERSION}-latest-amd64");
    assert_eq!(
        env_ref.tag, expect_tag,
        "moving schema+arch tag (fetch-newest, not a digest)"
    );
    assert!(
        !env_ref.tag.contains("sha256:"),
        "the tag is not a baked digest"
    );
    assert_eq!(
        env_ref.pull_ref(),
        format!("ghcr.io/ziee-ai/cyto-env/{env_id}:{expect_tag}"),
        "the tag pull ref is <oci_ref>:<tag>"
    );

    // ITEM-29: the registry is OPEN, not an allowlist — a well-formed id that no
    // image has been published for still RESOLVES (adding a domain is
    // `env-rootfs/<env>/` + a CI build, ZERO core edit); the failure for such an id
    // happens at PULL time, from the registry itself. Only a MALFORMED id is refused.
    //
    // These assertions used to read `.is_none()` for `bulk-rnaseq` /
    // `totally-unknown`, i.e. they CERTIFIED the closed-allowlist behaviour that
    // ITEM-29 deliberately removed — a standing red whose message ("bulk is a later
    // registry entry") asserted the exact OPPOSITE of the invariant the unit-level
    // TEST-1 proves.
    for open in ["bulk-rnaseq", "totally-unknown"] {
        let r = resolve(open).unwrap_or_else(|| panic!("{open} is a well-formed env-id"));
        assert_eq!(r.oci_ref, format!("ghcr.io/ziee-ai/cyto-env/{open}"));
    }
    for bad in [
        "",
        "Not-Lowercase",
        "a/b",
        "x:tag",
        "y@sha256:abc",
        "has space",
    ] {
        assert!(
            resolve(bad).is_none(),
            "{bad:?} is not a valid repo path component"
        );
    }
}
