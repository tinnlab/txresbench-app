//! The `tests/sqlite/*` suites (TESTS.md TEST-1…TEST-35): acceptance tests
//! that pin the SQLite runtime + migration seams. Wired as `mod sqlite;` from
//! `integration_tests.rs`; the chain tests need NO Postgres (they apply the
//! ported chain to scratch SQLite files), the later runtime tests exercise the
//! sqlite bootstrap itself (ITEM-12+).

pub mod apply_chain;
pub mod chain_jobs;
pub mod chain_workstore;
