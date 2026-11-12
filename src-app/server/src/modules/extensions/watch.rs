//! Live filesystem watcher on `<data_root>/processors/` (ITEM-13, INV-10, S6).
//!
//! A debounced, cross-platform (`notify`) watch that auto-reflects a dropped /
//! edited / removed processor package WITHOUT a rebuild and WITHOUT a manual reload
//! — it fires the SAME rescan+republish path (`super::reflect_processors`) the S7
//! reload endpoint will call. A contributor drops a folder package next to the
//! seeded ones and it appears within ~one debounce window; no restart.
//!
//! ## Lifecycle (CODING_GUIDELINES §5 / §16)
//! - **Kill-switch (DEC-13):** a DEPLOY-level `enabled` toggle, default ON, read
//!   once in [`start`] (env `TXR_PROCESSOR_WATCH_ENABLED`). When OFF, NO watcher
//!   thread/task is spawned — boot-rescan + the manual reload endpoint still work,
//!   so disabling the watch never disables the feature.
//! - **Supervised task:** the spawned tokio task's `JoinHandle`, the cancellation
//!   `watch::Sender`, and the `notify` debouncer GUARD are stored together in
//!   [`WatcherHandle`] (kept in a process-wide holder) so nothing is dropped early.
//!   [`shutdown`] signals cancel + drops the guard (stopping the notify OS thread)
//!   + aborts the task — a clean, leak-free stop on the process exit path (wired
//!   next to `rootfs::shutdown` in `lib.rs`).
//! - **No feedback loop (two independent guards):** (a) a reflect never WRITES the
//!   folder (`ensure_extracted` is OnceCell-cached + no-clobber, `build_from_dir`
//!   never writes); and (b) — the load-bearing one on Linux — a reflect READS it, and
//!   reads are themselves watched events, so the handler ignores pure-ACCESS batches
//!   ([`is_real_change`]). Without (b) the watcher self-drives at the debouncer tick
//!   rate forever; see that function's docs for the measured numbers.
//! - **No panic on fs error:** a `notify` error is logged (`warn`) and the loop
//!   continues; a failed reflect is logged (`error`) and the watcher keeps running.
//! - **Debounce (DEC-14):** a fixed [`WATCH_DEBOUNCE`] (500 ms) named const coalesces
//!   an editor's multi-write burst into one `reflect_processors()` call.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use notify::RecursiveMode;
use notify_debouncer_full::{
    new_debouncer, DebounceEventResult, DebouncedEvent, Debouncer, RecommendedCache,
};
use once_cell::sync::Lazy;
use tokio::sync::watch;
use tokio::task::JoinHandle;

/// The FIXED debounce window (DEC-14): a burst of fs events within this window
/// coalesces into ONE `reflect_processors()` rescan. A named const (not an admin
/// row) — an internal tuning of the watch mechanism, promotable later without
/// touching call sites.
pub const WATCH_DEBOUNCE: Duration = Duration::from_millis(500);

/// The deploy-level kill-switch env (DEC-13). Default ON; set to a falsey value
/// (`0`/`false`/`no`/`off`) to disable the live watch subsystem for a deployment.
const WATCH_ENABLED_ENV: &str = "TXR_PROCESSOR_WATCH_ENABLED";

/// Is the live watcher enabled for this deployment? Default ON; only an explicit
/// falsey env value turns it off (an unset / unparseable value stays ON).
pub fn watch_enabled() -> bool {
    match std::env::var(WATCH_ENABLED_ENV) {
        Ok(v) => !matches!(
            v.trim().to_ascii_lowercase().as_str(),
            "0" | "false" | "no" | "off"
        ),
        Err(_) => true,
    }
}

/// The supervised watcher: the tokio task `JoinHandle`, its cancellation sender,
/// and the `notify` debouncer GUARD — held TOGETHER so none is dropped early
/// (dropping the debouncer stops its OS thread; §5). Cancellation is deterministic:
/// [`stop`](Self::stop) signals the task, drops the guard, and awaits the task to
/// completion (no leak); [`stop_blocking`](Self::stop_blocking) is the sync
/// process-exit variant.
pub struct WatcherHandle {
    join: JoinHandle<()>,
    cancel: watch::Sender<bool>,
    // Kept alive as the notify GUARD — its `Drop` stops the debouncer OS thread.
    // Underscore-free field: it is load-bearing state, not an unused placeholder.
    debouncer: Debouncer<notify::RecommendedWatcher, RecommendedCache>,
}

impl WatcherHandle {
    /// Deterministic async stop: signal cancel → drop the notify guard (stops its
    /// OS thread) → await the task to completion. Returns only once the task has
    /// observed the cancel and returned — proving no leaked task (TEST-7).
    pub async fn stop(self) {
        let _ = self.cancel.send(true);
        drop(self.debouncer);
        let _ = self.join.await;
    }

    /// Sync stop for the process-exit path (`lib.rs` shutdown, not async): signal
    /// cancel, drop the notify guard, and abort the task. The task is cooperative
    /// (it breaks on the cancel signal) — abort is the belt-and-suspenders backstop
    /// so a shutdown never blocks on it.
    pub fn stop_blocking(self) {
        let _ = self.cancel.send(true);
        drop(self.debouncer);
        self.join.abort();
    }
}

/// Process-wide holder for the single live watcher. `None` when the kill-switch is
/// off or the watcher was never started / already stopped. Poison-recovering.
static WATCHER: Lazy<Mutex<Option<WatcherHandle>>> = Lazy::new(|| Mutex::new(None));

/// Start the live watcher on `<data_root>/processors/` (called from
/// `ExtensionsModule::init`, which runs inside the tokio runtime at boot). No-op +
/// a log line when the kill-switch is OFF (no thread/task spawned) or when a watcher
/// is already running. A start failure (notify init / watch error) is logged and
/// swallowed — the live watch is a convenience over the always-available
/// boot-rescan + reload endpoint, so it must never fail boot.
pub fn start() {
    if !watch_enabled() {
        tracing::info!(
            "processor watch: disabled by kill-switch ({WATCH_ENABLED_ENV}); live discovery off (boot-rescan + reload still work)"
        );
        return;
    }
    let mut guard = WATCHER.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_some() {
        return; // already running
    }
    match spawn_watcher(|| {
        // The SINGLE reflect path shared with the S7 reload endpoint (mod.rs).
        match super::reflect_processors() {
            Ok(n) => tracing::info!(extensions = n, "processor watch: folder change reflected (rescan+republish)"),
            Err(e) => tracing::error!(error = %e, "processor watch: reflect failed; watcher continues"),
        }
    }) {
        Ok(h) => {
            tracing::info!(
                debounce_ms = WATCH_DEBOUNCE.as_millis() as u64,
                "processor watch: live filesystem watcher started"
            );
            *guard = Some(h);
        }
        Err(e) => {
            tracing::error!(error = %e, "processor watch: failed to start; continuing without live watch (boot-rescan + reload still work)");
        }
    }
}

/// Stop the live watcher on process exit (sync; wired next to `rootfs::shutdown`).
/// Idempotent — a no-op when no watcher is running.
pub fn shutdown() {
    if let Some(h) = WATCHER
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take()
    {
        h.stop_blocking();
    }
}

/// Build + spawn the supervised watcher over the extracted processors folder, calling
/// `reflect` (debounced) on every coalesced fs change. Split out from [`start`] so a
/// test can drive it against a temp folder with its own reflect closure (no global
/// state). Resolves the folder via `ensure_extracted()` (OnceCell-cached — the boot
/// paths already extracted it; this never re-writes it).
fn spawn_watcher<F>(reflect: F) -> Result<WatcherHandle, String>
where
    F: Fn() + Send + 'static,
{
    let dir = super::embedded::ensure_extracted()?;
    spawn_watcher_in(dir, reflect)
}

/// Does this debounced batch represent REAL filesystem activity (something was
/// created / modified / removed / renamed), as opposed to pure READ noise?
///
/// **This is the feedback-loop guard, and it is load-bearing — not an optimization.**
/// `notify` 8's Linux inotify backend hard-codes `WatchMask::OPEN` into every watch
/// (`notify-8.2.0/src/inotify.rs::add_watch`), so merely OPENING a file inside the
/// watched tree emits an `EventKind::Access(AccessKind::Open(..))` event. A reflect
/// READS the whole tree (one `read_dir` plus an open of every package's
/// `manifest.yaml`), so those reads feed straight back into this very watcher:
///
/// > reflect → `Access(Open)` events → non-empty batch → reflect → …
///
/// self-sustaining forever at the debouncer's tick rate (`WATCH_DEBOUNCE / 4` =
/// 125 ms). Measured on an idle server (fresh DB, private `TXR_APP_DATA_DIR`, zero
/// requests): **8.00 reflects/s and 18.5% of a core**, each reflect a full recursive
/// scan + YAML parse + lint of every package + a datatype-registry rebuild + two
/// `Arc` swaps + an INFO log — plus ~8 log lines/s (~690k/day). Instrumenting that
/// idle loop showed **620 events over 10 s, 100% `Access(Open(Any))`, and zero
/// batches containing any non-access event** — so gating on "at least one non-access
/// event" stops the loop dead.
///
/// Note this is NOT the same as an empty-batch check: `notify_debouncer_full` already
/// suppresses empty batches itself (`if !send_data.is_empty()` in its tick loop), so
/// an idle tick never reaches this handler at all. The batches driving the loop are
/// genuinely non-empty — they are just full of the watcher's own reads.
///
/// **Fail-open, never swallow a real change:** only events that are *provably* access
/// noise are ignored. `Create` / `Modify` / `Remove` and the catch-all `Any` / `Other`
/// variants all still trigger a reflect, so a package added, edited, removed, or
/// renamed inside `<data_root>/processors/` reflects exactly as before. On macOS
/// (FSEvents) and Windows (`ReadDirectoryChangesW`) reads do not raise watch events in
/// the first place, so this predicate is simply always true there — the fix is a
/// no-op off Linux rather than a behavior change.
fn is_real_change(events: &[DebouncedEvent]) -> bool {
    events.iter().any(|e| !e.kind.is_access())
}

/// The testable core: watch `dir` recursively + spawn the debounced reflect task.
fn spawn_watcher_in<F>(dir: PathBuf, reflect: F) -> Result<WatcherHandle, String>
where
    F: Fn() + Send + 'static,
{
    // fs events → this unbounded tokio channel (a `()` tick per debounced batch).
    // `UnboundedSender::send` is callable from the notify OS thread (no runtime /
    // no blocking). The debouncer already coalesces a burst within WATCH_DEBOUNCE;
    // the task drains any extra ticks so N batches collapse to one reflect.
    let (evt_tx, mut evt_rx) = tokio::sync::mpsc::unbounded_channel::<()>();

    let mut debouncer = new_debouncer(WATCH_DEBOUNCE, None, move |res: DebounceEventResult| match res {
        Ok(events) => {
            // Ignore batches that carry ONLY access (read) events: a reflect reads the
            // watched tree, and on Linux those reads are themselves watched events, so
            // an ungated send self-drives the watcher forever. See `is_real_change`.
            if is_real_change(&events) {
                // A dropped receiver (task ended) makes send Err — ignore (shutting down).
                let _ = evt_tx.send(());
            }
        }
        Err(errors) => {
            for e in errors {
                tracing::warn!(error = %e, "processor watch: fs event error (ignored; watcher continues)");
            }
        }
    })
    .map_err(|e| format!("notify debouncer init failed: {e}"))?;

    debouncer
        .watch(&dir, RecursiveMode::Recursive)
        .map_err(|e| format!("notify watch failed on `{}`: {e}", dir.display()))?;

    let (cancel_tx, mut cancel_rx) = watch::channel(false);
    let join = tokio::spawn(async move {
        loop {
            tokio::select! {
                // Cancellation: shutdown() sends `true`.
                _ = cancel_rx.changed() => {
                    if *cancel_rx.borrow() {
                        break;
                    }
                }
                recv = evt_rx.recv() => {
                    match recv {
                        Some(()) => {
                            // Coalesce any ticks that queued while we were reflecting.
                            while evt_rx.try_recv().is_ok() {}
                            reflect();
                        }
                        // All senders dropped (debouncer gone) → nothing more to do.
                        None => break,
                    }
                }
            }
        }
    });

    Ok(WatcherHandle { join, cancel: cancel_tx, debouncer })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;
    use std::time::Instant;

    static TEST_SEQ: AtomicU64 = AtomicU64::new(0);

    /// A throwaway temp dir (a processors-style folder) — the watcher target.
    struct TmpDir(PathBuf);
    impl TmpDir {
        fn new(tag: &str) -> Self {
            let seq = TEST_SEQ.fetch_add(1, Ordering::Relaxed);
            let p = std::env::temp_dir()
                .join(format!("txr-watch-{tag}-{}-{seq}", std::process::id()));
            let _ = std::fs::remove_dir_all(&p);
            std::fs::create_dir_all(&p).unwrap();
            TmpDir(p)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TmpDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Poll `cond` up to `bound`, sleeping between tries; returns whether it held.
    async fn wait_until<F: Fn() -> bool>(bound: Duration, cond: F) -> bool {
        let start = Instant::now();
        while start.elapsed() < bound {
            if cond() {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        cond()
    }

    /// Recursively READ `dir` the way the real `reflect_processors` does — one
    /// `read_dir` per directory plus an OPEN+read of every file. This is what makes
    /// the reflect closure in the tests below faithful: on Linux each of these opens
    /// raises an inotify `Access(Open)` event back into the watcher, which is exactly
    /// the feedback loop [`is_real_change`] exists to break. A reflect closure that
    /// only bumps a counter cannot observe the bug at all.
    fn read_tree(dir: &Path) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                read_tree(&p);
            } else {
                let _ = std::fs::read(&p);
            }
        }
    }

    /// Spawn a watcher over `dir` whose reflect closure counts AND reads the tree
    /// (see [`read_tree`]). Returns the handle + the shared counter.
    fn spawn_counting_reader(dir: &Path) -> (WatcherHandle, Arc<AtomicU64>) {
        let count = Arc::new(AtomicU64::new(0));
        let c = count.clone();
        let root = dir.to_path_buf();
        let handle = spawn_watcher_in(root.clone(), move || {
            c.fetch_add(1, Ordering::SeqCst);
            read_tree(&root);
        })
        .expect("watcher spawns");
        (handle, count)
    }

    /// Write a minimal processor-package-shaped folder (a `manifest.yaml` the reflect
    /// closure will OPEN) under `root`.
    fn write_pkg(root: &Path, id: &str, version: &str) {
        let pkg = root.join(id);
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(
            pkg.join("manifest.yaml"),
            format!("id: {id}\nversion: {version}\n"),
        )
        .unwrap();
    }

    // ── The idle-quiescence guard (the check the suite lacked) ────────────────────
    //
    // REGRESSION TEST for the watcher busy-loop: with the watcher running and ZERO
    // filesystem activity, the reflect closure must not run AT ALL.
    //
    // Why this is the test that catches it, when the three pre-existing watch tests
    // did not: the loop is self-sustaining ONLY when the reflect READS the watched
    // tree (each open → an inotify `Access(Open)` event → another batch → another
    // reflect). So the reflect closure here reads the tree exactly like the real
    // `reflect_processors` does, and the assertion is on QUIESCENCE, not on firing.
    //
    // Robustness: no "sleep and hope" — the reflect count is an atomic counter, and
    // the idle window (2 s) is 16× the debouncer's tick (`WATCH_DEBOUNCE / 4` =
    // 125 ms), so an ungated watcher racks up ~16 reflects here and fails loudly.
    // Against the pre-fix code this asserted 0 and observed 16.
    #[tokio::test]
    async fn watcher_stays_quiet_when_idle() {
        let tmp = TmpDir::new("idle");
        let (handle, count) = spawn_counting_reader(tmp.path());

        // Seed two packages AFTER the watch is live, so this is a real observed change:
        // it both gives the reflect closure something to OPEN (the loop's fuel) and
        // proves the watcher actually fires — otherwise "0 reflects" below would pass
        // vacuously on a dead watcher.
        write_pkg(tmp.path(), "pkg-a", "1.0.0");
        write_pkg(tmp.path(), "pkg-b", "1.0.0");
        let fired = wait_until(Duration::from_secs(5), || count.load(Ordering::SeqCst) >= 1).await;
        assert!(fired, "the seed writes reflected (the watcher is genuinely live)");

        // Let that reflect — and the READS it performed — fully settle.
        tokio::time::sleep(WATCH_DEBOUNCE * 4).await;

        // ── The measurement window: NOTHING touches the folder from here on. ──
        let baseline = count.load(Ordering::SeqCst);
        tokio::time::sleep(Duration::from_secs(2)).await;
        let idle_reflects = count.load(Ordering::SeqCst) - baseline;

        assert_eq!(
            idle_reflects, 0,
            "an IDLE watcher must not reflect at all; observed {idle_reflects} reflect(s) over 2 s \
             with zero filesystem activity (~16 debouncer ticks). A non-zero count means the \
             watcher is self-driving off its own reads — see `is_real_change`."
        );

        handle.stop().await;
    }

    // The other half of the contract: gating on "real change" must not SWALLOW a real
    // change. Each of add / edit / remove triggers EXACTLY ONE reflect — one (not
    // zero, proving nothing was filtered out; and not two, proving the reflect's own
    // reads no longer bounce back as a second trigger).
    #[tokio::test]
    async fn add_edit_remove_each_trigger_exactly_one_reflect() {
        let tmp = TmpDir::new("exactly-one");
        write_pkg(tmp.path(), "seed", "1.0.0");
        let (handle, count) = spawn_counting_reader(tmp.path());
        // Settle the seed write.
        let _ = wait_until(Duration::from_secs(5), || count.load(Ordering::SeqCst) >= 1).await;
        tokio::time::sleep(WATCH_DEBOUNCE * 4).await;

        // Run `change`, then assert it produced exactly one reflect (waiting for the
        // first, then holding still long enough for a spurious second to show up).
        async fn one_reflect(count: &Arc<AtomicU64>, label: &str, change: impl FnOnce()) {
            let before = count.load(Ordering::SeqCst);
            change();
            let fired = wait_until(Duration::from_secs(5), || {
                count.load(Ordering::SeqCst) > before
            })
            .await;
            assert!(fired, "`{label}` must trigger a reflect (a real change is never swallowed)");
            tokio::time::sleep(WATCH_DEBOUNCE * 4).await;
            assert_eq!(
                count.load(Ordering::SeqCst) - before,
                1,
                "`{label}` must trigger EXACTLY one reflect"
            );
        }

        // ADD a package.
        one_reflect(&count, "add", || write_pkg(tmp.path(), "added", "1.0.0")).await;
        // EDIT an existing manifest.
        one_reflect(&count, "edit", || {
            std::fs::write(
                tmp.path().join("added").join("manifest.yaml"),
                b"id: added\nversion: 2.0.0\n",
            )
            .unwrap()
        })
        .await;
        // REMOVE the package.
        one_reflect(&count, "remove", || {
            std::fs::remove_dir_all(tmp.path().join("added")).unwrap()
        })
        .await;

        handle.stop().await;
    }

    // The gate predicate itself, tested deterministically (no timing, no filesystem):
    // access-only batches are noise; anything else is a real change.
    #[test]
    fn is_real_change_ignores_access_only_batches() {
        use notify::event::{AccessKind, AccessMode, CreateKind, EventKind, ModifyKind, RemoveKind};
        use notify::Event;

        let at = Instant::now();
        let ev = |kind: EventKind| DebouncedEvent::new(Event::new(kind), at);

        // The exact shape the idle loop produced (measured: 620/620 events were this).
        assert!(
            !is_real_change(&[
                ev(EventKind::Access(AccessKind::Open(AccessMode::Any))),
                ev(EventKind::Access(AccessKind::Read)),
                ev(EventKind::Access(AccessKind::Close(AccessMode::Read))),
            ]),
            "a batch of pure read/open noise must NOT trigger a reflect"
        );
        // An empty batch is not a change either (belt-and-braces: the debouncer
        // already suppresses these before the handler).
        assert!(!is_real_change(&[]), "an empty batch is not a change");

        // Every mutating kind still triggers …
        for kind in [
            EventKind::Create(CreateKind::File),
            EventKind::Modify(ModifyKind::Data(notify::event::DataChange::Content)),
            EventKind::Modify(ModifyKind::Name(notify::event::RenameMode::Both)),
            EventKind::Remove(RemoveKind::Folder),
            // … as do the catch-alls: unknown never means "ignore" (fail-open).
            EventKind::Any,
            EventKind::Other,
        ] {
            assert!(is_real_change(&[ev(kind)]), "{kind:?} must trigger a reflect");
        }

        // A real change buried in a pile of access noise still triggers.
        assert!(
            is_real_change(&[
                ev(EventKind::Access(AccessKind::Open(AccessMode::Any))),
                ev(EventKind::Create(CreateKind::Folder)),
                ev(EventKind::Access(AccessKind::Open(AccessMode::Any))),
            ]),
            "one real event among access noise must trigger a reflect"
        );
    }

    // TEST-7 (unit, ITEM-13): the notify watcher FIRES on a folder change, stores its
    // JoinHandle + cancellation + notify guard together, and `stop()` STOPS the task
    // deterministically (awaited handle completes — no leaked task, §5). Uses a temp
    // folder + a local reflect counter, so it never touches the global OnceCell /
    // registries (isolation-safe under parallel test threads).
    #[tokio::test]
    async fn watcher_fires_on_change_and_cancels_cleanly() {
        let tmp = TmpDir::new("fires");
        let count = Arc::new(AtomicU64::new(0));
        let c2 = count.clone();
        let handle = spawn_watcher_in(tmp.path().to_path_buf(), move || {
            c2.fetch_add(1, Ordering::SeqCst);
        })
        .expect("watcher spawns");

        // Drop a file → after the debounce the reflect closure ran at least once.
        std::fs::write(tmp.path().join("dropped.txt"), b"hello").unwrap();
        let fired = wait_until(Duration::from_secs(5), || count.load(Ordering::SeqCst) >= 1).await;
        assert!(fired, "the watcher reflected a folder change within the bound");

        // Cancel: stop() must RETURN (awaited task completes) — no hang, no leak.
        // Bound the await so a hang FAILS the test rather than blocking forever.
        let stopped = tokio::time::timeout(Duration::from_secs(5), handle.stop()).await;
        assert!(stopped.is_ok(), "stop() completed — the task terminated, no leak");

        // After stop, a further change does NOT increment (the task is gone).
        let after = count.load(Ordering::SeqCst);
        std::fs::write(tmp.path().join("after-stop.txt"), b"world").unwrap();
        tokio::time::sleep(WATCH_DEBOUNCE * 3).await;
        assert_eq!(
            count.load(Ordering::SeqCst),
            after,
            "no reflect fires after the watcher is stopped"
        );
    }

    // TEST-7 (unit, ITEM-13): the kill-switch, when OFF, spawns NO watcher — the
    // process-wide holder stays empty after start(). Restores the env after.
    #[tokio::test]
    async fn kill_switch_off_spawns_no_watcher() {
        // Serialize env mutation with the holder: no other test flips this env, and
        // start() reads the env + the global holder. Ensure a clean holder first.
        shutdown();
        std::env::set_var(WATCH_ENABLED_ENV, "0");
        assert!(!watch_enabled(), "env=0 disables the watch");
        start();
        {
            let g = WATCHER.lock().unwrap_or_else(|e| e.into_inner());
            assert!(g.is_none(), "kill-switch off → no watcher spawned");
        }
        std::env::remove_var(WATCH_ENABLED_ENV);
        assert!(watch_enabled(), "default (unset) is ON");
    }

    // The debounce const is the documented 500 ms (DEC-14).
    #[test]
    fn debounce_is_500ms() {
        assert_eq!(WATCH_DEBOUNCE, Duration::from_millis(500));
    }
}
