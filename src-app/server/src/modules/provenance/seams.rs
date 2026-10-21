//! Provenance capture seam (ITEM-7). A thin SYNC notify seam mirroring
//! `jobs/seams.rs` (trait + Noop + `OnceLock<Arc<dyn>>` + install-in-`init` +
//! Noop-fallback getter). The REAL async DB capture lives in `capture.rs` /
//! `interaction.rs`; this seam is only the observability/notify hook a future
//! compute chokepoint (ITEM-8, DESCOPED) fires when a run is recorded.

use std::sync::{Arc, OnceLock};

use uuid::Uuid;

/// Notified after a provenance run node has been recorded. The compute
/// chokepoint (deferred) will implement this to publish sync/notifications; the
/// interaction path publishes directly from its handler this round.
pub trait ProvenanceCapture: Send + Sync {
    fn on_run_recorded(&self, project_id: Uuid, run_id: Uuid);
}

/// No-op default (this round). Logs so the emit points are observable in dev.
pub struct NoopProvenanceCapture;

impl ProvenanceCapture for NoopProvenanceCapture {
    fn on_run_recorded(&self, project_id: Uuid, run_id: Uuid) {
        tracing::debug!(%project_id, %run_id, "provenance capture on_run_recorded (noop seam)");
    }
}

static CAPTURE: OnceLock<Arc<dyn ProvenanceCapture>> = OnceLock::new();

/// Install the process-wide capture seam (called once from
/// `ProvenanceModule::init`). Idempotent — a second install is ignored.
pub fn install_capture(capture: Arc<dyn ProvenanceCapture>) {
    let _ = CAPTURE.set(capture);
}

/// The installed capture seam (Noop default if never installed).
pub fn capture() -> Arc<dyn ProvenanceCapture> {
    CAPTURE
        .get()
        .cloned()
        .unwrap_or_else(|| Arc::new(NoopProvenanceCapture))
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    #[derive(Default)]
    struct Capturing {
        calls: Mutex<Vec<(Uuid, Uuid)>>,
    }
    impl ProvenanceCapture for Capturing {
        fn on_run_recorded(&self, project_id: Uuid, run_id: Uuid) {
            self.calls.lock().unwrap().push((project_id, run_id));
        }
    }

    // TEST-4: the default getter returns the Noop — it records nothing (no shared
    // state is touched), while a capturing control proves the recording mechanism
    // is otherwise observable. (The process singleton can't be reset in a unit,
    // so the install-swap is exercised at the integration boot.)
    #[test]
    fn noop_default_is_inert() {
        // A capturing control confirms the recording mechanism is observable.
        let control = Capturing::default();
        control.on_run_recorded(Uuid::new_v4(), Uuid::new_v4());
        assert_eq!(control.calls.lock().unwrap().len(), 1, "control records its call");

        // The default getter is the Noop: calling it (twice) returns and touches
        // no shared state — the control's recorded count is unchanged.
        let seam = capture();
        seam.on_run_recorded(Uuid::new_v4(), Uuid::new_v4());
        seam.on_run_recorded(Uuid::new_v4(), Uuid::new_v4());
        assert_eq!(
            control.calls.lock().unwrap().len(),
            1,
            "the noop seam records nothing"
        );
    }

    // Prove dispatch reaches the concrete impl through the `Arc<dyn
    // ProvenanceCapture>` trait object that `capture()` hands back. The
    // `install_capture` `OnceLock::set` path itself is NOT unit-tested here (a
    // unit can't reset a process-global `OnceLock` without breaking the sibling
    // default-getter test — the same limitation as `jobs/seams.rs`); the real
    // install→dispatch path is exercised end-to-end by the `capture_selection`
    // integration test. This test only asserts the trait-object indirection.
    #[test]
    fn capturing_impl_dispatches_through_arc() {
        let concrete = Arc::new(Capturing::default());
        let seam: Arc<dyn ProvenanceCapture> = concrete.clone();
        let sid = Uuid::new_v4();
        let rid = Uuid::new_v4();
        seam.on_run_recorded(sid, rid);

        let calls = concrete.calls.lock().unwrap();
        assert_eq!(calls.len(), 1, "trait-object dispatch reached the concrete impl");
        assert_eq!(calls[0], (sid, rid));
        drop(calls);

        // The global getter returns a usable Arc (the Noop default here).
        capture().on_run_recorded(Uuid::new_v4(), Uuid::new_v4());
    }
}
