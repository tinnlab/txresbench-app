//! The sqlite leg's per-test FILE lifecycle: naming, ownership, sweep.
//!
//! The engine's Postgres leg clones a per-test DATABASE from a fully-migrated
//! TEMPLATE once per process. Under a `sqlite://` `DATABASE_URL` this leg works
//! on FILES instead: a fully-migrated TEMPLATE FILE is built once per process
//! (migrations applied to a scratch file, then `VACUUM INTO` a clean template),
//! and each test's database is a copy of that file. Nothing here is a process,
//! a port, a cluster user or a download — the whole leg is local I/O, which is
//! the point of the driver swap (INV-1: no network, no binary download).
//!
//! The file lifecycle is deliberately the mirror of the Postgres leg's:
//!
//! * **owned file** — [`OwnedTestFile`] holds the per-test file copy AND an
//!   exclusive `flock(2)` on it for the whole life of the test, so a sweep in
//!   another process has an exact liveness signal (the kernel releases the lock
//!   however the owner died, with no cooperation from it);
//! * **synchronous drop** — the destructor deletes the `.sqlite` file and its
//!   `-wal`/`-shm` sidecars, and REPORTS a failure instead of discarding it (a
//!   reclaim that fails and a reclaim that never ran leave identical state);
//! * **startup sweep** — the exit paths no destructor can reach (SIGKILL, OOM,
//!   `panic = "abort"`, a test-binary timeout) are reclaimed by
//!   [`sweep_stale_test_db_files`] at the start of the next test process, with
//!   the same two required discriminators as the data-dir sweep: anchored name
//!   AND age floor AND no live `flock` owner.
//!
//! The template file is rebuilt each process (so a migration change is picked
//! up) and is NOT swept — it carries no `_test_` name segment, the anchored
//! predicate of the sweep.

use std::fs::{File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// Default age floor for [`sweep_stale_test_db_files`], in seconds.
///
/// Matches the data-dir sweep's floor: a per-test database file lives exactly
/// one test's wall time, so two hours is two orders of magnitude of margin over
/// anything real. Not a tuning knob.
pub const DEFAULT_SWEEP_MIN_AGE_SECS: u64 = 7200;

/// Upper bound on one sweep pass, so a badly-leaked temp dir costs a bounded
/// startup rather than a long delete. The sweep is self-healing across runs, so
/// a capped pass still converges.
const SWEEP_MAX_PER_PASS: usize = 500;

/// The fully-migrated TEMPLATE file name: `{base}{suffix}.sqlite`.
///
/// `base` is the app's per-variant template-DB base (`HarnessApp::
/// template_db_base`), `suffix` the per-worktree suffix from
/// [`crate::worktree_suffix`] — the same two strings the Postgres leg's
/// template-DB NAME is built from, so a worktree's template is stable across
/// its own processes and never collides with another worktree's.
pub fn template_file_name(base: &str, suffix: &str) -> String {
    format!("{base}{suffix}.sqlite")
}

/// A per-test database FILE name: `{base}_test_{key}_{simple}.sqlite` —
/// `{key}` is the worktree suffix stripped of its leading underscore
/// (the Postgres-leg suffix convention carries `_`; the file name wants the
/// underscore-separated segment shape, so a double `_` must not appear).
///
/// `simple` is the test id with hyphens removed (the UUID-v4 string the engine
/// generates for the Postgres leg's `test_db_<uuid>` name). The embedded
/// `_test_` segment is the sweep's anchored boundary: it must separate this
/// leg's files from the template file and from anything else that happens to
/// live in the temp dir.
pub fn test_file_name(base: &str, suffix: &str, simple_test_id: &str) -> String {
    let key = suffix.trim_start_matches('_');
    if key.is_empty() {
        format!("{base}_test_{simple_test_id}.sqlite")
    } else {
        format!("{base}_test_{key}_{simple_test_id}.sqlite")
    }
}

/// Exactly the shape [`test_file_name`] generates: `{base}_test_` followed by
/// the (possibly absent) worktree-key segment and the lower-hex test id —
/// never anything else.
///
/// Anything else is somebody else's file and is never a candidate: the sweep
/// DELETES files, so the name test is the first and cheapest containment on its
/// blast radius.
pub fn is_engine_test_file_name(base: &str, name: &str) -> bool {
    let prefix = format!("{base}_test_");
    let Some(rest) = name.strip_prefix(&prefix) else {
        return false;
    };
    let Some(stem) = rest.strip_suffix(".sqlite") else {
        return false;
    };
    if stem.is_empty() {
        return false;
    }
    // `{key}_{uuid}`: underscore-separated hex segments (the worktree-key
    // segment may be absent), the LAST of which is the 32-char uuid — so
    // `…_test_.sqlite` (no id at all) and `…_test_00.sqlite` (not a generated
    // shape) are never candidates.
    if !stem.split('_').all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_hexdigit())) {
        return false;
    }
    stem.rsplit('_')
        .next()
        .is_some_and(|last| last.len() >= 32)
}

/// What one [`sweep_stale_test_db_files`] pass did.
#[derive(Debug, Default, Clone)]
pub struct FileSweepReport {
    /// Every file the sweep judged abandoned and attempted to delete. This —
    /// not `removed` — is what the safety controls assert against: a sweep that
    /// has lost its liveness check would still usually FAIL to delete a live
    /// file (the server has it open, and SQLite needs the directory entry for
    /// its own operation bookkeeping on some paths), so a control that only
    /// inspects `removed` goes green on exactly the mutation it exists to catch.
    pub considered: Vec<PathBuf>,
    /// Successfully removed.
    pub removed: Vec<PathBuf>,
    /// Considered, but the removal did not fully succeed.
    pub refused: Vec<PathBuf>,
}

/// `flock(fd, LOCK_EX | LOCK_NB)` — true when the lock was taken.
///
/// The same call the data-dir liveness lock uses, on the DB file itself. SQLite
/// synchronizes its writers with POSIX record locks (`fcntl`), which do not
/// interact with `flock(2)` — so this advisory lock cannot perturb the server's
/// own concurrency, and it dies with the descriptor exactly as needed.
#[cfg(unix)]
fn lock_exclusive_nonblocking(file: &File) -> bool {
    use std::os::unix::io::AsRawFd;
    // SAFETY: `file` is a live, open descriptor for the duration of the call.
    unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) == 0 }
}

#[cfg(not(unix))]
fn lock_exclusive_nonblocking(_file: &File) -> bool {
    false
}

/// True when no live process owns `path`.
///
/// If the file can be flocked, no live owner exists — the kernel closes the
/// descriptor however the owner died. An unreadable file is treated as OWNED:
/// refusing to guess is the safe direction, and the cost is an orphan that
/// survives one more run.
fn appears_unowned(path: &Path) -> bool {
    match File::open(path) {
        Ok(f) => lock_exclusive_nonblocking(&f),
        Err(e) if e.kind() == io::ErrorKind::NotFound => true,
        Err(_) => false,
    }
}

/// The per-test database FILE and its liveness lock, owned from copy until the
/// test ends.
///
/// Mirrors the Postgres leg's `PerTestDb`: ownership starts where the resource
/// does (before the binary spawn, before the readiness ceiling), so no panic
/// path can unwind past an unowned database — the window that leaked 8,753
/// `test_db_*` databases on the shared cluster.
pub struct OwnedTestFile {
    path: PathBuf,
    /// The `flock`ed liveness handle. Held for the whole life of the file.
    _live_lock: Option<File>,
}

impl OwnedTestFile {
    /// Take ownership of `path`: open + exclusively flock it. The flock is
    /// advisory and independent of SQLite's own locks (see
    /// [`lock_exclusive_nonblocking`]); its only reader is the sweep.
    pub fn lock(path: PathBuf) -> io::Result<Self> {
        let file = OpenOptions::new().read(true).open(&path)?;
        let live = lock_exclusive_nonblocking(&file).then_some(file);
        Ok(Self {
            path,
            _live_lock: live,
        })
    }

    /// The file's path.
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for OwnedTestFile {
    /// Delete the file + its `-wal`/`-shm` sidecars, and REPORT a failure.
    /// Errors are returned, never discarded: a delete that fails and a delete
    /// that never ran leave identical state.
    fn drop(&mut self) {
        if std::env::var("TXR_TEST_KEEP_DB").as_deref() == Ok("1") {
            eprintln!(
                "test harness: TXR_TEST_KEEP_DB=1 — keeping {}",
                self.path.display()
            );
            return;
        }
        // Declared AFTER `_live_lock` so the lock is dropped first: releasing
        // the flock before unlinking is what keeps a concurrent sweep's
        // liveness read coherent (it may observe the file between the two, but
        // then it sees it exactly as an orphan — which is what it shortly is).
        for suffix in ["", "-wal", "-shm"] {
            let p = match suffix {
                "" => self.path.clone(),
                s => PathBuf::from(format!("{}{}", self.path.display(), s)),
            };
            match std::fs::remove_file(&p) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => eprintln!(
                    "test harness: LEAKED {} — could not remove: {e}",
                    p.display()
                ),
            }
        }
    }
}

/// Reclaim per-test database files that no `Drop` will ever reach.
///
/// A file is reclaimed only when ALL of:
///
///   1. it sits directly in the system temp dir and its name matches the
///      anchored `{base}_test_` shape — never an arbitrary neighbour, and never
///      the template (`{base}{suffix}.sqlite`, which does not carry `_test_`);
///   2. no live process holds its `flock` (see [`appears_unowned`]);
///   3. its modification time is older than `min_age_secs`.
///
/// **Neither (2) nor (3) is sufficient alone** — the same conclusion the
/// database and data-dir sweeps reached. (2) alone is unsafe against a
/// concurrently running OLDER harness build that does not flock; (3) alone is
/// unsafe because mtime is a wall-clock guess about a stranger's process.
pub fn sweep_stale_test_db_files(base: &str, min_age_secs: u64) -> FileSweepReport {
    sweep_test_file_dir(&std::env::temp_dir(), base, min_age_secs)
}

/// [`sweep_stale_test_db_files`] against an explicit root, so the harness's own
/// control tests can exercise the real predicate against a scratch directory
/// instead of the shared machine's temp dir.
pub fn sweep_test_file_dir(root: &Path, base: &str, min_age_secs: u64) -> FileSweepReport {
    let mut report = FileSweepReport::default();
    let min_age = Duration::from_secs(min_age_secs);

    let entries = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(e) => {
            eprintln!("test harness: db-file sweep could not read {root:?}: {e}");
            return report;
        }
    };

    for entry in entries.flatten() {
        if report.considered.len() >= SWEEP_MAX_PER_PASS {
            break;
        }
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        // (1) the anchored name shape.
        if !is_engine_test_file_name(base, name) {
            continue;
        }
        // `symlink_metadata`: a symlink named like a test DB is not one, and
        // must never be followed into someone else's file.
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        // (3) the age floor.
        let old_enough = meta
            .modified()
            .ok()
            .and_then(|m| SystemTime::now().duration_since(m).ok())
            .is_some_and(|age| age >= min_age);
        if !old_enough {
            continue;
        }
        // (2) no live owner. Checked LAST because it is the only predicate
        // that costs a syscall, and the two cheap ones excluded first.
        if !appears_unowned(&path) {
            continue;
        }

        report.considered.push(path.clone());
        // Delete the whole family (db + -wal + -shm) exactly as Drop does.
        let mut ok = true;
        for suffix in ["", "-wal", "-shm"] {
            let p = match suffix {
                "" => path.clone(),
                s => PathBuf::from(format!("{}{}", path.display(), s)),
            };
            match std::fs::remove_file(&p) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => {
                    eprintln!("test harness: db-file sweep could not remove {}: {e}", p.display());
                    ok = false;
                }
            }
        }
        if ok {
            report.removed.push(path);
        } else {
            report.refused.push(path);
        }
    }

    if !report.removed.is_empty() {
        eprintln!(
            "test harness: db-file sweep reclaimed {} orphaned per-test sqlite file(s)",
            report.removed.len()
        );
    }
    report
}

/// `flock` the template BUILD lock (exclusive), so two test processes in the
/// same worktree serialise template building rather than racing a half-written
/// file into each other's copies.
pub fn lock_template_build(template: &Path) -> io::Result<Option<File>> {
    let lock_path = PathBuf::from(format!("{}.build-lock", template.display()));
    let file = OpenOptions::new()
        .create(true)
        .write(true)
        .read(true)
        .truncate(false)
        .open(&lock_path)?;
    if lock_exclusive_nonblocking(&file) {
        Ok(Some(file))
    } else {
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE: &str = "txresbench_test_template";

    #[test]
    fn only_the_engines_own_test_file_names_are_admitted() {
        // What `test_file_name` actually generates: base + `_test_`, the
        // (possibly empty) worktree-key suffix, a uuid without hyphens.
        let generated = test_file_name(BASE, "_479efbff", "1425da4ab7354daaa9ed92ca8ca0f8fd");
        assert!(is_engine_test_file_name(BASE, &generated), "{generated}");
        let no_suffix = test_file_name(BASE, "", "1425da4ab7354daaa9ed92ca8ca0f8fd");
        assert!(is_engine_test_file_name(BASE, &no_suffix), "{no_suffix}");

        // Shared files this fix must never take with it.
        assert!(!is_engine_test_file_name(
            BASE,
            &template_file_name(BASE, "_479efbff")
        ));
        assert!(!is_engine_test_file_name(BASE, "txresbench_build_479efbff.sqlite"));
        assert!(!is_engine_test_file_name(BASE, "txresbench_test_template_1a2b3c4d.sqlite"));

        // Unanchored containment is not a match.
        assert!(!is_engine_test_file_name(BASE, "not_a_txresbench_test_template_test_x.sqlite"));
        assert!(!is_engine_test_file_name(BASE, "xtxresbench_test_template_test_x.sqlite"));

        // The prefix alone names no file.
        assert!(!is_engine_test_file_name(BASE, "txresbench_test_template_test_.sqlite"));

        // Anything outside [0-9a-f_] cannot be swept — quotes, semicolons,
        // whitespace and path separators.
        for hostile in [
            "txresbench_test_template_test_a; DROP.sqlite",
            "txresbench_test_template_test_\"a\".sqlite",
            "txresbench_test_template_test_a b.sqlite",
            "txresbench_test_template_test_%25.sqlite",
            "txresbench_test_template_test_ZZZ.sqlite",
        ] {
            assert!(!is_engine_test_file_name(BASE, hostile), "admitted {hostile:?}");
        }
    }

    #[test]
    fn a_locked_file_is_owned_and_an_unlocked_one_is_not() {
        let scratch = tempfile::tempdir().expect("scratch");
        let path = scratch.path().join(test_file_name(BASE, "_479efbff", "00aa11bb22cc33dd44ee55ff66778899"));
        std::fs::File::create(&path).expect("create");

        let held = OwnedTestFile::lock(path.clone()).expect("lock");
        assert!(
            !appears_unowned(&path),
            "a file whose flock is held must read as OWNED"
        );
        drop(held);
        assert!(
            appears_unowned(&path),
            "releasing the flock must make it collectable again"
        );
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn the_sweep_takes_an_old_unlocked_file_and_leaves_an_old_locked_one() {
        let scratch = tempfile::tempdir().expect("scratch");

        let dead = scratch
            .path()
            .join(test_file_name(BASE, "_479efbff", "dead00dead00dead00dead00dead00dead"));
        std::fs::File::create(&dead).expect("create dead");

        let live = scratch
            .path()
            .join(test_file_name(BASE, "_479efbff", "live00live00live00live00live00live"));
        std::fs::File::create(&live).expect("create live");
        let _held = OwnedTestFile::lock(live.clone()).expect("lock live");

        // Age floor 0 so BOTH are old enough: the only thing that can separate
        // them is the liveness lock.
        let report = sweep_test_file_dir(scratch.path(), BASE, 0);

        assert!(
            report.considered.contains(&dead),
            "an old, unlocked file must be reclaimed; considered={:?}",
            report.considered
        );
        assert!(!dead.exists(), "and actually removed");
        assert!(
            !report.considered.contains(&live),
            "a LIVE run's file must never even be considered; considered={:?}",
            report.considered
        );
        assert!(live.exists(), "and must still be there");
    }

    #[test]
    fn the_age_floor_alone_protects_a_young_file_with_no_lock() {
        let scratch = tempfile::tempdir().expect("scratch");
        let young = scratch
            .path()
            .join(test_file_name(BASE, "", "0000dead0000dead0000dead0000dead"));
        std::fs::File::create(&young).expect("create");

        let report = sweep_test_file_dir(scratch.path(), BASE, DEFAULT_SWEEP_MIN_AGE_SECS);
        assert!(
            report.considered.is_empty(),
            "a freshly-created file must be excluded by the age floor alone; considered={:?}",
            report.considered
        );
        assert!(young.exists());
    }

    #[test]
    fn the_sweep_never_considers_a_neighbour_that_is_not_ours() {
        let scratch = tempfile::tempdir().expect("scratch");
        for name in [
            "important-data.sqlite",
            &template_file_name(BASE, "_479efbff"),
            "txresbench_test_template_test_.sqlite",
            "txr_test_template_test_00.sqlite",
        ] {
            std::fs::File::create(scratch.path().join(name)).expect("create");
        }
        let report = sweep_test_file_dir(scratch.path(), BASE, 0);
        assert!(
            report.considered.is_empty(),
            "only the harness's own name shape is a candidate; considered={:?}",
            report.considered
        );
        for name in [
            "important-data.sqlite",
            &template_file_name(BASE, "_479efbff"),
            "txresbench_test_template_test_.sqlite",
            "txr_test_template_test_00.sqlite",
        ] {
            assert!(scratch.path().join(name).exists(), "{name} must survive");
        }
    }

    #[test]
    fn a_created_test_file_is_locked_and_removed_on_drop() {
        let scratch = tempfile::tempdir().expect("scratch");
        let path = scratch
            .path()
            .join(test_file_name(BASE, "", "babe00babe00babe00babe00babe00babe"));
        std::fs::File::create(&path).expect("create");
        std::fs::write(
            PathBuf::from(format!("{}-wal", path.display())),
            b"wal-pages",
        )
        .expect("wal");
        std::fs::write(
            PathBuf::from(format!("{}-shm", path.display())),
            b"shm",
        )
        .expect("shm");

        let owned = OwnedTestFile::lock(path.clone()).expect("lock");
        assert!(
            !appears_unowned(&path),
            "a live OwnedTestFile must hold its liveness lock"
        );
        drop(owned);
        assert!(!path.exists(), "drop must remove the db file");
        assert!(
            !PathBuf::from(format!("{}-wal", path.display())).exists(),
            "drop must remove the -wal sidecar"
        );
        assert!(
            !PathBuf::from(format!("{}-shm", path.display())).exists(),
            "drop must remove the -shm sidecar"
        );
    }
}
