//! The per-run SSE broadcaster + run-stop registry (PLAN ITEM-8, PROV-EE-4's
//! channel + DEC-19's "SSE only").
//!
//! This is the `jobs::runtime` mirror for ONE analysis run: one in-memory
//! broadcaster per run id (the UI's F-screen stream), one run-level cancel
//! channel (the "Stop all" signal the drive loop's lane queue + env phase
//! select on — DEC-17's counterpart to the per-JOB cancel the admission
//! wrapper registers on the admitted `jobs` row). The runtime is pool-free and
//! shared-instance: the module installs [`RunRuntime::global`] in `init` (the
//! TEST-EE-01 "init installs the pool + the RunRuntime" half), and ITEM-10's
//! routes + ITEM-8's drive loops receive the same `Arc`.
//!
//! ### Why an instance, not a `LazyLock`
//!
//! `jobs::runtime` is a process-global `LazyLock` (every job stream in the
//! process shares one registry, and the framework's admin setting caps it).
//! This module's runtime is a single shared instance — [`RunRuntime::global`]:
//! the RunRuntime has no configurable cap (the app's single-user surface
//! needs only [`TxrLimits::SSE_CLIENTS_MAX`] as the OOM guard), no settings
//! seam — and once qa-fixes3 ITEM-3's example-set seam became a consumer, the
//! ONE instance is the shared one, so a run started by the example endpoint
//! streams and stops through the SAME registry the run routes use (two
//! registries would leave the engine's stream route subscribed to a runtime
//! that never broadcasts the example run). The register/broadcast/close/
//! cancel semantics are the jobs ones verbatim (subscribe-first +
//! replay-on-connect, prune-on-send, `signal_cancel` answers whether the run
//! was live).

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use axum::response::sse::Event;
use tokio::sync::{mpsc, watch};
use uuid::Uuid;

use super::types::TxrLimits;

type EventSender = mpsc::UnboundedSender<Result<Event, axum::Error>>;

/// The process's one RunRuntime: the engine module installs it at init, and
/// the model_store module's example-set seam shares the same instance (the
/// ITEM-3 example run drives through the same broadcaster + stop registry the
/// run routes read).
pub fn global() -> &'static Arc<RunRuntime> {
    static GLOBAL: OnceLock<Arc<RunRuntime>> = OnceLock::new();
    GLOBAL.get_or_init(|| Arc::new(RunRuntime::new()))
}

/// The per-run SSE + run-stop registry (in-memory only; lives as long as the
/// module instance).
pub struct RunRuntime {
    /// run_id → live SSE subscribers watching that run's stream.
    subscribers: Mutex<HashMap<Uuid, Vec<EventSender>>>,
    /// run_id → the run's stop signal (present ⇒ a drive loop is live).
    cancels: Mutex<HashMap<Uuid, watch::Sender<bool>>>,
}

impl RunRuntime {
    pub fn new() -> Self {
        Self {
            subscribers: Mutex::new(HashMap::new()),
            cancels: Mutex::new(HashMap::new()),
        }
    }

    fn total_subscribers(map: &HashMap<Uuid, Vec<EventSender>>) -> usize {
        map.values().map(Vec::len).sum()
    }

    /// Register an SSE subscriber for `run_id`, capped at `max_clients`. None
    /// when the global subscriber cap is reached (the routes answer 503). The
    /// subscribe happens BEFORE the replay snapshot (ITEM-10's replay
    /// contract — subscribe-first + snapshot + race-close).
    pub fn subscribe_with_cap(
        &self,
        run_id: Uuid,
        max_clients: usize,
    ) -> Option<mpsc::UnboundedReceiver<Result<Event, axum::Error>>> {
        let mut subs = self.subscribers.lock().unwrap_or_else(|e| e.into_inner());
        if Self::total_subscribers(&subs) >= max_clients {
            tracing::warn!("txr run SSE subscriber registry full; refusing new client");
            return None;
        }
        let (tx, rx) = mpsc::unbounded_channel();
        subs.entry(run_id).or_default().push(tx);
        Some(rx)
    }

    /// [`Self::subscribe_with_cap`] at the module's own cap
    /// ([`TxrLimits::SSE_CLIENTS_MAX`]) — the run stream's only OOM guard.
    pub fn subscribe(
        &self,
        run_id: Uuid,
    ) -> Option<mpsc::UnboundedReceiver<Result<Event, axum::Error>>> {
        self.subscribe_with_cap(run_id, TxrLimits::SSE_CLIENTS_MAX)
    }

    /// Push an event to every subscriber of `run_id`, pruning any that dropped.
    pub fn broadcast(&self, run_id: Uuid, event: Event) {
        let mut subs = self.subscribers.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(list) = subs.get_mut(&run_id) {
            list.retain(|tx| tx.send(Ok(event.clone())).is_ok());
            if list.is_empty() {
                subs.remove(&run_id);
            }
        }
    }

    /// End every stream of `run_id` and drop its run-stop registration (a
    /// terminal run closes the channel; the stream then serves the replay
    /// snapshot only — PROV-EE-4's terminal-close contract).
    pub fn close_run(&self, run_id: Uuid) {
        self.subscribers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&run_id);
        self.cancels
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&run_id);
    }

    /// Mark `run_id` as live + register its run-stop channel. The drive loop
    /// registers at spawn (before any method could be stopped — a stop racing
    /// the spawn is not lost) and picks the receiver up immediately; the
    /// stop route observes the SAME signal via [`Self::cancel_receiver`].
    pub fn register_cancel(&self, run_id: Uuid) -> watch::Receiver<bool> {
        let (tx, rx) = watch::channel(false);
        self.cancels
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(run_id, tx);
        rx
    }

    /// Subscribe to an ALREADY-registered run's stop signal (the stop route /
    /// a late-arriving observer). None ⇒ the run is not live here.
    pub fn cancel_receiver(&self, run_id: Uuid) -> Option<watch::Receiver<bool>> {
        self.cancels
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&run_id)
            .map(watch::Sender::subscribe)
    }

    /// Signal a LIVE run to stop (the "Stop all" route). True when a signal
    /// was delivered; false when the run is not live here (the route then
    /// falls back to the DB-state transition path — the drive may have
    /// finished between the read and the signal).
    pub fn signal_cancel(&self, run_id: Uuid) -> bool {
        let cancels = self.cancels.lock().unwrap_or_else(|e| e.into_inner());
        match cancels.get(&run_id) {
            Some(tx) => {
                let _ = tx.send(true);
                true
            }
            None => false,
        }
    }
}

impl Default for RunRuntime {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// TEST-EE-01's RunRuntime half (the pin the plan defers to the item that
    /// owns `runtime.rs` — TESTS.md note (b)): the broadcaster registers
    /// streams, caps at [`TxrLimits::SSE_CLIENTS_MAX`], broadcasts reach a
    /// live subscriber, and close frees the slots (the jobs runtime's
    /// `broadcaster_registers_caps_and_frees` mirror).
    #[test]
    fn broadcaster_registers_caps_and_frees() {
        let rt = RunRuntime::new(); // fresh instance — parallel-safe
        let run = Uuid::new_v4();

        // Fill to the cap.
        let mut held = Vec::new();
        for _ in 0..TxrLimits::SSE_CLIENTS_MAX {
            let rx = rt.subscribe(run).expect("under cap → Some");
            held.push(rx);
        }
        assert!(rt.subscribe(run).is_none(), "at cap → None");

        // Broadcast reaches a live subscriber.
        rt.broadcast(run, Event::default().data("x"));
        // Free every slot; the cap is GLOBAL across runs (the jobs mirror's
        // contract — the map's subscribers, not one run's), so the small-cap
        // block starts from an empty registry.
        held.clear();
        rt.close_run(run);
        let _a = rt.subscribe_with_cap(run, 2).expect("1st under small cap");
        let _b = rt.subscribe_with_cap(run, 2).expect("2nd under small cap");
        assert!(
            rt.subscribe_with_cap(run, 2).is_none(),
            "at the passed cap → None"
        );
        rt.close_run(run);
        assert!(rt.subscribe(run).is_some(), "after close → Some again");
    }

    /// The run-stop channel mirrors the jobs cancel registry: register → the
    /// drive's own receiver + a late observer see ONE signal; signal answers
    /// whether the run was live; close frees the registration.
    #[test]
    fn run_stop_registry_routes() {
        let rt = RunRuntime::new();
        let run = Uuid::new_v4();
        assert!(!rt.signal_cancel(run), "unregistered → false");
        assert!(
            rt.cancel_receiver(run).is_none(),
            "unregistered → no receiver for a late observer"
        );
        let mut drive_rx = rt.register_cancel(run);
        // A stop route that did NOT register picks the SAME signal up — if
        // this were a fresh channel, the route's Stop button would report
        // success and the drive would never see it.
        let mut late = rt.cancel_receiver(run).expect("registered → a receiver");
        assert!(rt.signal_cancel(run), "registered → true");
        assert_eq!(*drive_rx.borrow_and_update(), true);
        assert_eq!(
            *late.borrow_and_update(),
            true,
            "the late observer sees the same signal"
        );
        rt.close_run(run);
        assert!(!rt.signal_cancel(run), "after close → false");
        assert!(
            rt.cancel_receiver(run).is_none(),
            "after close → no receiver"
        );
    }

    /// The run-stop registration is keyed per run: two runs' signals never
    /// cross (a stop of run A must not stop run B).
    #[test]
    fn run_stop_channels_are_per_run() {
        let rt = RunRuntime::new();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let mut a_rx = rt.register_cancel(a);
        let mut b_rx = rt.register_cancel(b);
        assert!(rt.signal_cancel(a));
        assert_eq!(*a_rx.borrow_and_update(), true, "run A saw the stop");
        assert_eq!(*b_rx.borrow_and_update(), false, "run B did not");
        assert!(rt.cancel_receiver(b).is_some(), "run B is still live");
    }
}
