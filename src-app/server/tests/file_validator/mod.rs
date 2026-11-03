//! The `file_validator` integration suites.
//!
//! ITEM-3 — the rule-port acceptance suite (TEST-FV-17, TEST-FV-18:
//! `rules_test.rs`). Pure model tests, no spawned server: the canonical model
//! is materialized as JSON rows from the COMMITTED example CSVs (the
//! everything-correct fixture) and deliberately broken one fact at a time —
//! the schema's own "one correct + several deliberately broken, right
//! message" fixture contract (INV-8).
//!
//! ITEM-5/ITEM-6 — `api_test.rs` / `material_test.rs` land with those items
//! (the HTTP endpoints and the generator parity legs).

mod rules_test;
