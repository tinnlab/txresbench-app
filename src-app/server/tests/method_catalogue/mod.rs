//! The `method_catalogue` integration suites.
//!
//! ITEM-5 — the HTTP routes suite (TEST-MC-10..14, TEST-MC-21,
//! TEST-MC-26/28/29/30/31 HTTP halves): `api_test.rs`. One spawned server per
//! test; the embedded catalogue is the REAL committed one (runnable-only per
//! DEC-2), so the EXAMPLE-E2/E3 plan cases are pinned on the real methods that
//! carry their shapes (`asm-best-change-rule`; `crp-flare-response-kinetics` —
//! the plan's `dynforest` is not in the runnable set, see the test docs).
//!
//! ITEM-6 — the catalogue-hygiene + regen-parity suite (TEST-MC-8, TEST-MC-9,
//! TEST-MC-18, TEST-MC-21's data half, TEST-MC-24, TEST-MC-25):
//! `catalogue_hygiene_test.rs`. No server for most of it — the file reads the
//! COMMITTED catalogue + the generator's hermetic fixture parity (TEST-MC-9
//! spawns the one server that proves the no-bench-tree boot).

mod api_test;
mod catalogue_hygiene_test;
