//! CytoAnalyst integration test binary. One test crate (`--test
//! integration_tests`) aggregating per-module test modules, mirroring ziee's
//! layout. Run with `--test-threads` ≥ 1 (per-test DB isolation makes
//! parallelism safe); needs a reachable Postgres (see `common`).

mod common;

mod account;
mod admin;
mod analysis;
mod auth;
mod billing;
// Compute T6 — quota-enforcement acceptance tests. saas-gated with the enforcement arms it binds
// (billing's `check_quota` + the saas helpers); compiled out of the default build (INV-3).
#[cfg(feature = "saas")]
mod compute_quota;
mod dataset;
mod datatype;
// Infra admin config acceptance tests (#63) — object-store + compute encrypted config +
// test-connection. saas-gated with the routes/permission it exercises (compiled out of
// the default build, like `compute_quota`).
#[cfg(feature = "saas")]
mod infra;
mod domain_surface;
mod drafts;
mod geneset;
mod extensions;
mod features;
// The `ziee-file` HTTP surface merged by `modules::file` — its authorization
// suite (the removed-member deny matrix + positive controls).
mod file;
mod harness_db_lifecycle;
mod harness_sentinel;
mod health;
mod sandbox;
mod jobs;
mod mcp;
mod metering;
mod model_coverage;
mod notification;
mod predicate_removed;
mod provenance;
mod project;
mod sync;
mod user;
mod workstore;

// TEST-19 (artifact-model ITEM-13) — the INVERTED suite: this module used to hold the
// native SOMA read/serve tests behind a `#[cfg(…)]` gate on the `tiledb_serve` cargo
// flag. It now asserts that the module, the cargo flag and `CYTO_TILEDB_LIB` are ABSENT.
// It is deliberately UNGATED — a removal proof hidden behind the very build flag whose
// removal it proves could never run.
mod tiledb_serve;
