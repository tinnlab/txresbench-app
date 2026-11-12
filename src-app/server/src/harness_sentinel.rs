//! The BACKEND worktree sentinel — the cargo server's answer to "are you mine?".
//!
//! ## Why the backend needed one at all
//!
//! `ab51cabc` fixed six *backend-free* Playwright tiers. Each of those talks to a
//! vite server, and vite carries `gallerySentinelPlugin()`, which serves this
//! worktree's root at `/__worktree`. That endpoint is the whole basis of the
//! ownership rule: a port is usable only when whatever holds it can PROVE which
//! source tree it was built from. `playwright.config.ts` — the full-backend tier —
//! was reported and deliberately NOT fixed in that change, for one reason: a cargo
//! backend could not answer the question at all, so "is this server mine?" was not
//! merely unanswered, it was unaskable. This module makes it askable.
//!
//! ## What it proves, and why it is COMPILE-time
//!
//! The value served is `CARGO_MANIFEST_DIR` with everything from `/src-app` onward
//! stripped — i.e. the worktree root of the tree this binary was COMPILED from. That
//! is deliberately stronger than the vite plugin's runtime `git rev-parse` answer:
//! a binary is a build artifact, and the question a harness actually needs answered
//! is "was the code I am about to test compiled from MY tree", not "which directory
//! did somebody launch it from". A stale binary copied out of a sibling worktree
//! answers with the sibling's root and is correctly refused.
//!
//! The strip rule is byte-identical to `run-key.mjs::worktreeRoot`, which is what
//! the Node side compares against, and `sentinel_root_matches_js_strip_rule` below
//! pins that agreement.
//!
//! ## Why this is safe, and why it is still compiled out of release
//!
//! Two independent arguments, and the second is the one that carries:
//!
//! 1. The payload is not a secret. It is a build-time source path plus a pid — the
//!    same pair the vite plugin already serves to anyone who can reach the dev
//!    server, and strictly less than the binary's own panic messages carry.
//! 2. It is nevertheless `#[cfg(debug_assertions)]`, because a release server has no
//!    use for it and a filesystem path is free reconnaissance for anyone probing a
//!    deployment. This repo already writes test seams that way — the workstore's
//!    `_debug/seed` route (`workstore/routes.rs`) is the precedent, and it is a far
//!    more powerful surface than this one. Following the existing convention beats
//!    inventing a second posture for a weaker endpoint.
//!
//! It is also NOT aide-documented: the route is registered on the plain axum router
//! after `finish_api`, so it never enters the OpenAPI spec and cannot perturb the
//! generated `types.ts`.
//!
//! ## Consumers
//!
//! `src-app/ui/scripts/harness-origin.mjs::classifyOrigin` — the same function the
//! backend-free tiers use. It fetches `http://<host>:<port>/__worktree` and reads
//! `worktreeRoot`, so this endpoint is served at the ROOT path, NOT under the
//! `/api` prefix: one path, one shape, one rule for every tier.

/// This binary's worktree root — resolved at COMPILE time from the crate manifest
/// dir, with everything from the `/src-app` marker onward removed.
///
/// Mirrors `run-key.mjs::worktreeRoot` (and the Rust `worktree_db` key helper): both
/// separators are honoured, and a path with no marker is returned unchanged.
pub const fn strip_marker_len(dir: &str) -> usize {
    // `const fn` over bytes: no allocation, evaluated at compile time.
    let b = dir.as_bytes();
    let markers: [&[u8]; 2] = [b"/src-app", b"\\src-app"];
    let mut i = 0;
    while i < b.len() {
        let mut m = 0;
        while m < markers.len() {
            let marker = markers[m];
            if i + marker.len() <= b.len() {
                let mut k = 0;
                let mut hit = true;
                while k < marker.len() {
                    if b[i + k] != marker[k] {
                        hit = false;
                        break;
                    }
                    k += 1;
                }
                if hit {
                    return i;
                }
            }
            m += 1;
        }
        i += 1;
    }
    b.len()
}

/// The compile-time worktree root of the tree this binary was built from.
pub const WORKTREE_ROOT: &str = {
    let dir = env!("CARGO_MANIFEST_DIR");
    // `split_at` is const-stable; slicing a `&str` at a byte index found by an
    // ASCII-only marker search is UTF-8 safe by construction.
    let (root, _) = dir.split_at(strip_marker_len(dir));
    root
};

/// The sentinel JSON body. Shape is fixed by `harness-origin.mjs`, which reads
/// `worktreeRoot` and (for the banner only) `pid`.
pub fn payload() -> serde_json::Value {
    serde_json::json!({
        "worktreeRoot": WORKTREE_ROOT,
        "pid": std::process::id(),
        // Named so a human curling this endpoint knows what they are looking at.
        "server": "txresbench",
    })
}

/// Mount `GET /__worktree` on the ROOT router. Debug builds only — see the module
/// docs. In a release build this is a no-op that returns the router untouched, so
/// the call site needs no `cfg` of its own.
pub fn install(router: axum::Router) -> axum::Router {
    #[cfg(debug_assertions)]
    {
        use axum::response::IntoResponse;
        router.route(
            "/__worktree",
            axum::routing::get(|| async {
                (
                    [
                        ("content-type", "application/json"),
                        ("cache-control", "no-store"),
                    ],
                    payload().to_string(),
                )
                    .into_response()
            }),
        )
    }
    #[cfg(not(debug_assertions))]
    {
        router
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The strip rule, pinned against the JS twin (`run-key.mjs::worktreeRoot`).
    /// Both separators, and the no-marker passthrough.
    #[test]
    fn sentinel_root_matches_js_strip_rule() {
        let cases = [
            (
                "/data/pbya/txresbench/wt/src-app/server",
                "/data/pbya/txresbench/wt",
            ),
            ("C:\\work\\tree\\src-app\\server", "C:\\work\\tree"),
            ("/no/marker/here", "/no/marker/here"),
            ("/src-app/server", ""),
        ];
        for (input, want) in cases {
            let (got, _) = input.split_at(strip_marker_len(input));
            assert_eq!(got, want, "strip rule disagrees for {input}");
        }
    }

    /// The constant is a real worktree root, not the manifest dir. If this ever
    /// equals `CARGO_MANIFEST_DIR` the marker moved and every harness pre-flight
    /// would start refusing its own backend.
    #[test]
    fn worktree_root_is_stripped_and_absolute() {
        assert!(
            !WORKTREE_ROOT.contains("/src-app"),
            "WORKTREE_ROOT still carries the marker: {WORKTREE_ROOT}"
        );
        assert_ne!(WORKTREE_ROOT, env!("CARGO_MANIFEST_DIR"));
        assert!(!WORKTREE_ROOT.is_empty());
    }

    /// The ROUTE, driven as a real axum service — so this asserts the endpoint
    /// EXISTS and answers, not that some source file mentions it.
    ///
    /// The expectation is derived from `cfg!(debug_assertions)` rather than written
    /// down, which is what makes it the release-posture guard: deleting the
    /// `#[cfg(debug_assertions)]` from `install` leaves this green in a debug build
    /// and RED under `cargo test --release`, where the route would now answer 200 in
    /// a build that must not carry it.
    #[tokio::test]
    async fn route_answers_in_debug_and_is_absent_in_release() {
        use http_body_util::BodyExt;
        use tower::ServiceExt;

        let app = install(axum::Router::new());
        let res = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/__worktree")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        if cfg!(debug_assertions) {
            assert_eq!(
                res.status(),
                200,
                "the sentinel must answer in a debug build"
            );
            let bytes = res.into_body().collect().await.unwrap().to_bytes();
            let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(v["worktreeRoot"].as_str(), Some(WORKTREE_ROOT));
        } else {
            assert_eq!(
                res.status(),
                404,
                "a RELEASE build must not carry the sentinel route"
            );
        }
    }

    /// The payload shape the Node side parses. A rename of `worktreeRoot` here
    /// makes every origin read as `unidentified` — which is a refusal, so it fails
    /// loudly, but it fails as "somebody else's server" rather than "we renamed a
    /// field". Pin it.
    #[test]
    fn payload_carries_the_field_the_node_side_reads() {
        let p = payload();
        assert_eq!(p["worktreeRoot"].as_str(), Some(WORKTREE_ROOT));
        assert!(p["pid"].as_u64().is_some());
    }
}
