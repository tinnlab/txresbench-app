//! TxResBench integration test binary. One test crate (`--test
//! integration_tests`) aggregating per-module test modules, mirroring txresbench's
//! layout. Run with `--test-threads` ≥ 1 (per-test DB isolation makes
//! parallelism safe); needs a reachable Postgres (see `common`).

mod common;
// The SQLite suites (TESTS.md TEST-1…TEST-35): the chain-apply harness is live
// from the port item that builds it; the runtime/seam suites arrive with the
// items they cover. The chain tests need NO Postgres — they apply the ported
// chain to scratch SQLite files.
mod sqlite;

mod account;
mod admin;
mod analysis;
mod auth;
// The account-management/admin/billing/quota/metering suites were removed with the
// modules they exercised (TxResBench strip — single local owner, no SaaS surface).
mod dataset;
mod datatype;
mod domain_surface;
mod drafts;
// The `execution_engine` suites (ITEM-11's file set — TEST-EE-05/12/13/14/
// 15/17/18/19/20/21/25/26/27/30/32/33/34/35/36).
mod execution_engine;
mod geneset;
mod extensions;
mod features;
// The `txresbench-file` HTTP surface merged by `modules::file` — its authorization
// suite (the removed-member deny matrix + positive controls).
mod file;
// The `file_validator` suites (rule-port acceptance TEST-FV-17/18; the HTTP
// suites land with ITEM-5/6).
mod file_validator;
mod harness_db_lifecycle;
mod harness_sentinel;
// The `history_store` suites (ITEM-5's file set — TEST-HS-6/7/8/9/10/11/12/
// 13/14/15/16/17/18/20/21/22/23: the K view, the retention policy and the
// usage figure over a real spawned server; seeds through the engine's own
// repository).
mod history_store;
mod health;
mod sandbox;
mod jobs;
mod mcp;
mod method_catalogue;
// The `model_store` suites (ITEM-5's TEST-MS-08/09/10/15/16 + ITEM-6's
// TEST-MS-11..14 — the save flow, inventory + set CRUD, the .txr round trip
// over the real routes, the pretrained import seam, the per-model eligibility,
// the verified reuse resolution and the route matrix).
mod model_store;
mod model_coverage;
mod notification;
mod predicate_removed;
// The `pretrained_catalogue` suites (ITEM-1's file set — TEST-PC-10: the
// packer's .txr output is byte-stable, self-verifying and imports through the
// store's seam; TEST-PC-11's refusal matrix runs as the packer's own
// `--selftest`, driven here so CI executes it).
mod pretrained_catalogue;
mod provenance;
mod project;
mod sync;
mod workstore;

// TEST-19 (artifact-model ITEM-13) — the INVERTED suite: this module used to hold the
// native SOMA read/serve tests behind a `#[cfg(…)]` gate on the `tiledb_serve` cargo
// flag. It now asserts that the module, the cargo flag and `TXR_TILEDB_LIB` are ABSENT.
// It is deliberately UNGATED — a removal proof hidden behind the very build flag whose
// removal it proves could never run.
mod tiledb_serve;
