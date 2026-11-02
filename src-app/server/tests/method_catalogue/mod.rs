//! ITEM-5 — the `method_catalogue` routes integration suite (TEST-MC-10..14,
//! TEST-MC-21, TEST-MC-26/28/29/30/31 HTTP halves). One spawned server per
//! test; the embedded catalogue is the REAL committed one (runnable-only per
//! DEC-2), so the EXAMPLE-E2/E3 plan cases are pinned on the real methods that
//! carry their shapes (`asm-best-change-rule`; `crp-flare-response-kinetics` —
//! the plan's `dynforest` is not in the runnable set, see the test docs).

mod api_test;
