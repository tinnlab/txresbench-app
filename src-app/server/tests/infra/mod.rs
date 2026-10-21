//! Infrastructure admin config acceptance tests (#63) — the SECURITY anchor for the
//! object-store + compute encrypted-config surfaces. Mirrors
//! `billing/integration_config_test.rs`: proves the #60 no-leak contract end-to-end
//! against a real spawned server in ENCRYPTED mode (the `secret_storage_key` knob):
//! INV-1 ciphertext-at-rest, INV-2 masked GET, INV-3 SecretView-boundary last4,
//! INV-4 clean-ok:false test (no 500, no leak), INV-5 env-fallback + refuse-without-key,
//! A9 (deny without `infra::settings::manage`).

use std::io::Write as _;
use std::path::PathBuf;

use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

use crate::common::TestServer;

/// A direct DB pool onto the spawned server's database (for tests that seed rows the HTTP
/// surface has no endpoint for — a `verified` migration row, a `running` job for the fence).
pub(crate) async fn pool_for(server: &TestServer) -> PgPool {
    PgPoolOptions::new()
        .max_connections(4)
        .connect(server.database_url())
        .await
        .expect("connect infra test pool")
}

mod auto_cutover_flow_test;
mod authz_test;
mod compute_config_test;
mod coupling_guard_test;
mod env_fallback_test;
mod masked_read_test;
mod migration_flow_test;
mod object_store_config_test;
mod object_store_roundtrip_test;
mod test_connection_test;

/// A ≥32-char at-rest storage key — set on the spawned server (via the harness knob →
/// `CYTO_SECRET_STORAGE_KEY`).
pub(crate) const STORAGE_KEY: &str = "infra-config-test-storage-key-0123456789ab";

pub(crate) fn encrypted_opts() -> crate::common::TestOptions {
    crate::common::TestOptions {
        secret_storage_key: Some(STORAGE_KEY.to_string()),
        ..Default::default()
    }
}

/// Announce a self-skip on BOTH channels (human `eprintln!` + the machine-readable skip
/// ledger), and HARD-FAIL under `CYTO_TEST_NO_SKIP=1`. Mirrors `billing::record_skip` — a
/// bare `eprintln!` skip is byte-for-byte indistinguishable from a real pass.
pub(crate) fn record_skip(test: &str, reason: &str) {
    let path = match std::env::var("CYTO_TEST_SKIP_LEDGER").ok() {
        Some(p) => PathBuf::from(p),
        None => PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/test-skip-ledger.tsv"),
    };
    eprintln!("SKIP {test}: {reason} — self-skip, not the ignore attribute");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{test}\t{reason}");
    }
    assert!(
        std::env::var("CYTO_TEST_NO_SKIP").ok().as_deref() != Some("1"),
        "SKIP not allowed under CYTO_TEST_NO_SKIP=1: {test}: {reason}"
    );
}
