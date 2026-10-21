//! Re-run VERIFICATION (P4 ITEM-6/9/10/15) — re-execute a recorded compute run
//! via the P3 compute path, compare its regenerated output signature to the
//! recorded one, and persist a verification certificate. The re-execution itself
//! lives in `jobs::verify` (owns the compute internals); this module owns the
//! comparison (`diff`), the orchestration (`runner`), and the certificate.

pub mod certificate;
pub mod diff;
pub mod runner;

/// The single source of truth for the verification status vocabulary (DEC-4).
/// Used by the orchestrator, handlers, repository defaults, and the diff engine
/// so a status is never a scattered raw literal.
pub mod status {
    /// Inserted; the detached re-run task has not finished.
    pub const PENDING: &str = "pending";
    /// The full output SET regenerated bit-identically.
    pub const REPRODUCED: &str = "reproduced";
    /// Same output SET regenerated but ≥1 output byte-differs (tolerant mode) —
    /// numeric equivalence NOT asserted.
    pub const INCONCLUSIVE: &str = "inconclusive";
    /// An output is missing/extra, or a byte-diff under exact mode.
    pub const DIVERGED: &str = "diverged";
    /// The re-run could not complete (spawn/exit/timeout/not-re-runnable).
    pub const ERROR: &str = "error";
}
