//! The `tests/sqlite/*` suites (TESTS.md TEST-1…TEST-35): acceptance tests
//! that pin the SQLite runtime + migration seams. Wired as `mod sqlite;` from
//! `integration_tests.rs`; the chain tests need NO Postgres (they apply the
//! ported chain to scratch SQLite files), the later runtime tests exercise the
//! sqlite bootstrap itself (ITEM-12+).

pub mod apply_chain;
pub mod chain_account_project;
pub mod chain_dataset_drafts_prov;
pub mod chain_jobs;
pub mod chain_workstore;
pub mod final_layout;
pub mod module_account;
pub mod module_dataset;
pub mod module_jobs;
pub mod module_project;
pub mod module_provenance;
pub mod module_workstore;
