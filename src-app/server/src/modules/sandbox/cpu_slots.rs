#![cfg_attr(not(target_os = "windows"), allow(dead_code))]

//! The WSL run-agent CPU-slot allocator (DEC-12's thread rule, enforced in WSL
//! by the agent's pinning).
//!
//! The app decides each method's CPU count with DEC-12: `per_method_cpus` =
//! `clamp(cpus / at_a_time, 1, 4)` over the host CPU count, so all methods
//! running at once ask for at most the PC's CPU count — but on Windows nothing
//! enforced it. This allocator gives each concurrent WSL run `n_cpu` slots of
//! its own: runs get DIFFERENT slots while there are enough, and share the
//! least-used ones when there are not. It never waits and never fails a run
//! for a slot shortage (the agent's pinning is best-effort).
//!
//! Only the Windows run path uses the allocator at run time; the module is
//! compiled on every platform (no cfg) so its tests run in the Linux gate too
//! — hence the dead-code allow for non-Windows builds.

use std::sync::{Arc, Mutex, OnceLock};

/// Process-wide lease table: one live-lease count per CPU slot.
pub struct CpuSlots {
    counts: Mutex<Vec<u32>>,
}

impl CpuSlots {
    /// A fresh allocator with at least 1 slot.
    pub fn new(slots: usize) -> Arc<CpuSlots> {
        Arc::new(CpuSlots {
            counts: Mutex::new(vec![0; slots.max(1)]),
        })
    }

    /// Take `n` distinct slots for one run: `n` is clamped to `1..=slots`,
    /// then the `n` slots with the fewest live leases are chosen (ties go to
    /// the lowest slot number), their lease counts incremented, and the slots
    /// returned in ascending order. The lock covers only the pick+increment,
    /// and a poisoned lock is recovered with `into_inner` (never a panic).
    pub fn take(self: &Arc<Self>, n: usize) -> CpuLease {
        let mut counts = self
            .counts
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let slots = counts.len();
        let n = n.max(1).min(slots);
        let mut order: Vec<usize> = (0..slots).collect();
        order.sort_by_key(|&i| (counts[i], i));
        let mut chosen: Vec<u32> = order[..n].iter().map(|&i| i as u32).collect();
        chosen.sort_unstable();
        for &slot in &chosen {
            counts[slot as usize] += 1;
        }
        CpuLease {
            owner: Arc::clone(self),
            slots: chosen,
        }
    }
}

/// One run's hold on the slots it was granted; dropping it releases them.
pub struct CpuLease {
    owner: Arc<CpuSlots>,
    slots: Vec<u32>,
}

impl CpuLease {
    /// The run's slots, ascending.
    pub fn slots(&self) -> &[u32] {
        &self.slots
    }
}

impl Drop for CpuLease {
    fn drop(&mut self) {
        let mut counts = self
            .owner
            .counts
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        for &slot in &self.slots {
            let count = &mut counts[slot as usize];
            *count = count.saturating_sub(1);
        }
    }
}

/// The one process-wide allocator, sized by the same host detection DEC-12
/// uses ([`crate::modules::method_catalogue::estimate::host_cpus`]) — the
/// macOS VM path mirrors that clamp (`service.rs`: vCPUs clamped to the host
/// CPU count), so slot allocation can never be asked for more distinct slots
/// than the machine has CPUs.
///
/// The slot count is the WINDOWS CPU count (the host DEC-12 uses): WSL may
/// expose fewer CPUs (`.wslconfig processors=`), and the agent then maps slot
/// `s` to its `s % n`-th allowed CPU (`n` = WSL's exposed count). So when WSL
/// exposes fewer CPUs than there are slots, concurrent leases can share a CPU
/// and a run may end up on fewer CPUs than `n_cpu` — still bounded by what the
/// host asked for, and the agent's pinning is best-effort, so a shortage never
/// fails a run.
pub fn global() -> &'static Arc<CpuSlots> {
    static GLOBAL: OnceLock<Arc<CpuSlots>> = OnceLock::new();
    GLOBAL.get_or_init(|| {
        CpuSlots::new(crate::modules::method_catalogue::estimate::host_cpus() as usize)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    fn live(slots: &CpuSlots) -> Vec<u32> {
        slots
            .counts
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone()
    }

    #[test]
    fn three_leases_of_four_are_pairwise_disjoint_and_refill_the_dropped_block() {
        let slots = CpuSlots::new(24);
        let a = slots.take(4);
        let b = slots.take(4);
        let c = slots.take(4);
        assert_eq!(a.slots(), &[0, 1, 2, 3]);
        assert_eq!(b.slots(), &[4, 5, 6, 7]);
        assert_eq!(c.slots(), &[8, 9, 10, 11]);
        for (left, right) in [(&a, &b), (&a, &c), (&b, &c)] {
            let (l, r) = (left.slots(), right.slots());
            assert!(
                l.iter().all(|s| !r.contains(s)),
                "{l:?} and {r:?} are not disjoint"
            );
        }
        drop(b);
        let d = slots.take(4);
        assert_eq!(
            d.slots(),
            &[4, 5, 6, 7],
            "the freed block is the least-used one"
        );
    }

    #[test]
    fn second_lease_shares_the_least_used_slots_with_lowest_ties() {
        let slots = CpuSlots::new(4);
        let a = slots.take(3);
        assert_eq!(a.slots(), &[0, 1, 2]);
        // counts are [1,1,1,0]: slot 3 is free, then the two lowest of the
        // three shared slots win the ties — {0,1,3}.
        let b = slots.take(3);
        assert_eq!(b.slots(), &[0, 1, 3]);
    }

    #[test]
    fn take_zero_still_gets_one_slot() {
        let slots = CpuSlots::new(4);
        let lease = slots.take(0);
        assert_eq!(lease.slots().len(), 1);
    }

    #[test]
    fn take_more_than_the_slot_count_gets_every_slot() {
        let slots = CpuSlots::new(4);
        let lease = slots.take(99);
        assert_eq!(lease.slots(), &[0, 1, 2, 3]);
    }

    #[test]
    fn dropping_every_lease_returns_every_count_to_zero() {
        let slots = CpuSlots::new(5);
        let a = slots.take(2);
        let b = slots.take(3);
        let c = slots.take(3);
        drop(a);
        drop(b);
        drop(c);
        assert!(live(&slots).iter().all(|&count| count == 0));
    }

    #[test]
    fn eight_threads_leave_every_count_at_zero_and_never_duplicate_slots() {
        let slots = CpuSlots::new(8);
        let bad = Arc::new(AtomicBool::new(false));
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let slots = Arc::clone(&slots);
                let bad = Arc::clone(&bad);
                std::thread::spawn(move || {
                    for _ in 0..1000 {
                        let lease = slots.take(2);
                        if lease.slots().len() != 2 || lease.slots()[0] == lease.slots()[1] {
                            bad.store(true, Ordering::SeqCst);
                        }
                        drop(lease);
                    }
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }
        assert!(!bad.load(Ordering::SeqCst), "a lease held duplicate slots");
        let counts = live(&slots);
        assert!(
            counts.iter().all(|&count| count == 0),
            "counts are not all zero: {counts:?}"
        );
    }
}
