//! The `file_validator` integration suites.
//!
//! ITEM-3 — the rule-port acceptance suite (TEST-FV-17, TEST-FV-18:
//! `rules_test.rs`). Pure model tests, no spawned server: the canonical model
//! is materialized as JSON rows from the COMMITTED example CSVs (the
//! everything-correct fixture) and deliberately broken one fact at a time —
//! the schema's own "one correct + several deliberately broken, right
//! message" fixture contract (INV-8).
//!
//! ITEM-5/ITEM-6 — `api_test.rs` (TEST-FV-7/8/9/20/21/22/23/25, the four
//! endpoints through `TestServer`) and `material_test.rs` (TEST-FV-14/15/16
//! + the guard-script legs, the generator parity and the shipped-material
//! hygiene).

mod api_test;
mod material_test;
mod rules_test;
