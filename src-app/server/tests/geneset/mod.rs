//! gene-set increment-1 integration tests — the geneset KIND freezing through the REAL seeded
//! `geneset` package (no fixture install: `geneset.collection.freeze` resolves from the baked
//! seed). Reuses the draftable primitive's helpers (`crate::drafts::*`) and the rootfs gate
//! (`crate::dataset::hardening_common`).
//!
//! The KIND-AGNOSTIC draftable invariants — the CRUD/lifecycle (TEST-2), auto-freeze-on-consume
//! hash-pin (TEST-8), and the 401/403 auth gate on `/api/drafts` (TEST-20) — are proven for the
//! generic primitive by the existing `tests/drafts/` suite (DEC-8: geneset reuses `drafts::use`
//! and the `/api/drafts` surface unchanged). This suite adds the geneset-KIND proof: freezing a
//! `geneset/collection` draft mints an immutable `geneset/collection` artifact whose per-set
//! metadata carries kind/origin/data_driven (TEST-1/3/4), and an edit forks a new artifact
//! (TEST-6).

mod draft_lifecycle_test;
mod freeze_test;
