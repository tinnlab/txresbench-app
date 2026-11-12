//! Compute↔storage COUPLING matrix (#61 §1) — the single source of truth for which
//! (compute backend, object-store backend) pairs are valid.
//!
//! The locality coupling: a REMOTE compute backend (kubernetes) runs its work in cluster
//! pods that CANNOT read the host's local filesystem — a pod fetches every blob from the
//! object store, so the object store must be REMOTELY REACHABLE (a cloud store). Therefore
//! the one invalid pairing is **remote compute + Local object store**; the other three are
//! valid:
//!
//! | Compute \ Storage | Local-FS | Cloud (S3/GCS) |
//! |---|---|---|
//! | Local (bwrap)     | ✅        | ✅ (fetches from cloud) |
//! | Remote (k8s)      | ❌ INVALID | ✅ |
//!
//! This is a PURE, unit-tested function (no env, no DB) so both the object-store PUT and the
//! compute PUT enforce it from ONE place (mirrors `config.rs`'s pure `backend_from_env` /
//! `merge_backend`). The API refuses the invalid pairing with **422 `INCOMPATIBLE_BACKENDS`**;
//! the FE blocks the save with the same message. There is no other source of the rule.

use txresbench_core::AppError;

use super::config::ObjectStoreKind;

/// The compute backend's LOCALITY — the only property the coupling matrix cares about.
/// `Local` runs on the host (can read the local FS); `Remote` runs in cluster pods (cannot).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComputeKind {
    Local,
    /// Kubernetes / any remote pod backend.
    Remote,
}

impl ComputeKind {
    /// Map the effective compute-backend string (as `infra_compute` resolves it: `"local"`
    /// | `"kubernetes"`) to a locality. Anything not explicitly a remote backend is treated
    /// as `Local` (fail-safe: the guard only ever REFUSES the one hazardous pairing, so an
    /// unknown backend defaults to the permissive-but-safe local side).
    pub fn from_backend_str(s: &str) -> Self {
        match s.trim() {
            "kubernetes" | "k8s" | "remote" => ComputeKind::Remote,
            _ => ComputeKind::Local,
        }
    }

    pub fn is_remote(self) -> bool {
        matches!(self, ComputeKind::Remote)
    }
}

/// Is this object-store backend REMOTELY REACHABLE (visible to a remote compute pod)?
/// `Local` (local FS) is not; `S3` (cloud S3/GCS) is.
pub fn store_is_remote(store: ObjectStoreKind) -> bool {
    match store {
        ObjectStoreKind::Local => false,
        ObjectStoreKind::S3 => true,
    }
}

/// The stable error code the API returns (422) and the FE keys off.
pub const INCOMPATIBLE_BACKENDS_CODE: &str = "INCOMPATIBLE_BACKENDS";

/// The single operator-facing message for the invalid pairing. Actionable, no internal detail.
pub const INCOMPATIBLE_BACKENDS_MSG: &str =
    "Remote (Kubernetes) compute cannot read the local-filesystem object store — a cluster \
     pod fetches its inputs from the object store, which must be remotely reachable. Set up \
     a remote (S3/GCS) object store first, then select the Kubernetes compute backend.";

/// The pure coupling-matrix decision. `Ok(())` for the three valid pairings; the one invalid
/// pairing (remote compute + Local store) returns `Err(true)` so a caller can render the block
/// without importing `AppError` (used by tests + the pure layer). Prefer
/// [`check_backend_compat_api`] at an HTTP boundary.
///
/// This is the ONLY place the matrix is encoded.
pub fn is_compatible(compute: ComputeKind, store: ObjectStoreKind) -> bool {
    // Invalid iff remote compute is paired with a non-remote (local) store.
    !(compute.is_remote() && !store_is_remote(store))
}

/// The HTTP-boundary form: `Ok(())` when compatible, else a **422 `INCOMPATIBLE_BACKENDS`**
/// [`AppError`] carrying the fixed actionable message. Both the object-store PUT and the
/// compute PUT call this before persisting, so the invalid pairing can never be activated.
pub fn check_backend_compat_api(
    compute: ComputeKind,
    store: ObjectStoreKind,
) -> Result<(), AppError> {
    if is_compatible(compute, store) {
        Ok(())
    } else {
        Err(AppError::unprocessable_entity(
            INCOMPATIBLE_BACKENDS_CODE,
            INCOMPATIBLE_BACKENDS_MSG,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The full 2×2 matrix, exhaustively — the single source of truth (INV-1). Exactly one
    /// pairing is invalid; flipping any pairing here is flipping the product rule.
    #[test]
    // TEST-U1
    fn matrix_has_exactly_one_invalid_cell() {
        // Valid: local compute + local store.
        assert!(is_compatible(ComputeKind::Local, ObjectStoreKind::Local));
        // Valid: local compute + cloud store.
        assert!(is_compatible(ComputeKind::Local, ObjectStoreKind::S3));
        // Valid: remote compute + cloud store.
        assert!(is_compatible(ComputeKind::Remote, ObjectStoreKind::S3));
        // INVALID (the one pairing): remote compute + local store.
        assert!(!is_compatible(ComputeKind::Remote, ObjectStoreKind::Local));
    }

    #[test]
    fn api_refuses_only_the_invalid_cell_with_422() {
        // The three valid pairings return Ok.
        assert!(check_backend_compat_api(ComputeKind::Local, ObjectStoreKind::Local).is_ok());
        assert!(check_backend_compat_api(ComputeKind::Local, ObjectStoreKind::S3).is_ok());
        assert!(check_backend_compat_api(ComputeKind::Remote, ObjectStoreKind::S3).is_ok());
        // The invalid pairing returns a 422 with the stable code + actionable message.
        let err = check_backend_compat_api(ComputeKind::Remote, ObjectStoreKind::Local)
            .expect_err("remote compute + local store must be refused");
        assert_eq!(err.status_code(), 422);
        assert_eq!(err.error_code(), INCOMPATIBLE_BACKENDS_CODE);
        // The operator-facing message names the fix (asserted on the single source constant).
        assert!(INCOMPATIBLE_BACKENDS_MSG.contains("remotely reachable"));
        assert!(INCOMPATIBLE_BACKENDS_MSG.to_lowercase().contains("s3/gcs"));
    }

    #[test]
    fn compute_kind_maps_backend_strings() {
        assert_eq!(ComputeKind::from_backend_str("kubernetes"), ComputeKind::Remote);
        assert_eq!(ComputeKind::from_backend_str("k8s"), ComputeKind::Remote);
        assert_eq!(ComputeKind::from_backend_str("local"), ComputeKind::Local);
        assert_eq!(ComputeKind::from_backend_str(""), ComputeKind::Local);
        assert_eq!(ComputeKind::from_backend_str("  kubernetes "), ComputeKind::Remote);
        // Unknown ⇒ local (fail-safe; the guard only refuses the one hazardous pair).
        assert_eq!(ComputeKind::from_backend_str("nomad"), ComputeKind::Local);
    }

    #[test]
    fn store_remoteness_is_correct() {
        assert!(!store_is_remote(ObjectStoreKind::Local));
        assert!(store_is_remote(ObjectStoreKind::S3));
    }
}
