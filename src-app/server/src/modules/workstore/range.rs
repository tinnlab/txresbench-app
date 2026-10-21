//! Byte-span parsing for the `/data` plane. TWO vocabularies, deliberately kept
//! apart, because they have different contracts:
//!
//! * [`parse_range_param`] — the **`?range=` QUERY PARAM** (artifact-model
//!   ITEM-36). This is the form every ziee client uses. The URL is the cache key,
//!   so the answer is always a `200` and every chunk is an ordinary cacheable
//!   `GET`. Validation is HARD: the only outcomes are a span, a `400` or a `416`.
//!   There is no "serve the whole blob instead" outcome — see the type.
//! * [`parse_range`] — the **`Range:` HEADER**, RFC 9110 §14 semantics
//!   (`206`/`416`, and "ignore what you cannot parse"). Kept for generic HTTP
//!   clients; no ziee client emits it. A subtly-wrong `206` breaks a range-aware
//!   reader silently, so it is unit-tested against the exact forms they emit:
//!   `bytes=a-b`, `bytes=a-` (open-ended), `bytes=-n` (suffix).
//!
//! Sending BOTH on one request is a `400` at the handler (INV-2: two sources for
//! one value is exactly the ambiguity the design forbids), so the two never
//! interact here.

// ─────────────────────────── `?range=` (ITEM-36) ───────────────────────────

/// A validated byte span: `length` bytes starting at `offset`, already known to
/// be inside the blob. Handed straight to the streaming read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ByteSpan {
    pub offset: u64,
    pub length: u64,
}

/// Why a `?range=` value was refused.
///
/// **There is no `Full` variant, and that absence is the point.** The header
/// parser below answers an unparsable spec by serving the WHOLE blob — which on a
/// 134 MB shard means a client that asked for 200 bytes silently receives 134 MB
/// and can only notice by checking for a `206` it never sees. Making the param
/// parser return a `Result` with no whole-blob arm means that degradation is not
/// merely unused on this path, it is unrepresentable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RangeParamError {
    /// Not a byte-span at all (junk, a `bytes=` prefix, a comma-separated list,
    /// an inverted `b < a`, whitespace, a non-decimal number) → **400**.
    Malformed,
    /// A well-formed span naming bytes this blob does not have → **416**.
    Unsatisfiable,
}

/// `true` for a non-empty run of ASCII digits and nothing else. Deliberately
/// stricter than `str::parse` — that accepts a leading `+`, and `trim` would
/// accept surrounding whitespace. One spelling per value (INV-2).
fn is_decimal(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

/// Parse a `?range=` value against a known blob length (artifact-model ITEM-36).
///
/// Three forms, each naming a DIFFERENT span (so this is one vocabulary, not
/// three ways to say one thing):
///
/// | form | meaning |
/// |---|---|
/// | `a-b` | bytes `a` through `b`, inclusive |
/// | `a-`  | byte `a` through the last byte |
/// | `-n`  | the LAST `n` bytes |
///
/// The suffix form is load-bearing, not a nicety: a client fetches a shard's
/// index trailer with `?range=-3920` *before* it knows the file's size, so it is
/// the only form it can express that read in. It is therefore the one form that
/// CLAMPS — `n` larger than the blob yields the whole blob — because a caller
/// that cannot know the size cannot be required to keep `n` within it. Every
/// other form is checked against the real length and refused if it overruns.
///
/// A batched/multi-span form is NOT implemented; a comma is refused outright, so
/// the cap on a batch's count and total span is structural (there is no batch).
/// If one is ever added it arrives as its own parameter with its own caps, not as
/// a looser spelling of this one.
pub fn parse_range_param(spec: &str, total: u64) -> Result<ByteSpan, RangeParamError> {
    use RangeParamError::{Malformed, Unsatisfiable};

    // A list is the batched form, which does not exist. Refuse — never widen.
    if spec.contains(',') {
        return Err(Malformed);
    }
    // The header's `bytes=` unit does not belong in the param. One way to say it.
    let Some((a, b)) = spec.split_once('-') else {
        return Err(Malformed);
    };
    // A second `-` means a second span (or a signed number). Neither is a form.
    if b.contains('-') {
        return Err(Malformed);
    }

    match (a.is_empty(), b.is_empty()) {
        // `-n` — the last n bytes; the ONLY clamping form (see the doc comment).
        (true, false) => {
            if !is_decimal(b) {
                return Err(Malformed);
            }
            let n: u64 = b.parse().map_err(|_| Malformed)?;
            if n == 0 || total == 0 {
                return Err(Unsatisfiable);
            }
            let offset = total.saturating_sub(n);
            Ok(ByteSpan {
                offset,
                length: total - offset,
            })
        }
        // `a-` — from a to the end.
        (false, true) => {
            if !is_decimal(a) {
                return Err(Malformed);
            }
            let start: u64 = a.parse().map_err(|_| Malformed)?;
            if start >= total {
                return Err(Unsatisfiable);
            }
            Ok(ByteSpan {
                offset: start,
                length: total - start,
            })
        }
        // `a-b` — inclusive, and NOT clamped: an end past the last byte is a
        // request for bytes that do not exist, and answering it with fewer bytes
        // than asked for under a `200` is the silent degradation ITEM-36 exists
        // to kill. The caller knows the length (it read the index), so an overrun
        // is a bug on its side and it should hear about it.
        (false, false) => {
            if !is_decimal(a) || !is_decimal(b) {
                return Err(Malformed);
            }
            let start: u64 = a.parse().map_err(|_| Malformed)?;
            let end: u64 = b.parse().map_err(|_| Malformed)?;
            if start > end {
                return Err(Malformed);
            }
            if end >= total {
                return Err(Unsatisfiable);
            }
            Ok(ByteSpan {
                offset: start,
                length: end - start + 1,
            })
        }
        // A bare `-`, or an empty value.
        (true, true) => Err(Malformed),
    }
}

// ───────────────────────── `Range:` header (RFC 9110) ─────────────────────────

/// The decision for one request given the target blob length.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RangeOutcome {
    /// No `Range:` header, or one this server does not understand → serve the
    /// whole blob `200`.
    ///
    /// This arm is RFC 9110 §14.2's "ignore a Range you cannot satisfy", and it
    /// is reachable ONLY from the header path. The `?range=` param never lands
    /// here: [`parse_range_param`] has no whole-blob outcome to land in.
    Full,
    /// A satisfiable single range → `206`, inclusive `[start, end]`.
    Satisfiable { start: u64, end: u64 },
    /// The range is syntactically valid but not satisfiable → `416`.
    Unsatisfiable,
}

impl RangeOutcome {
    /// The `Content-Range: bytes start-end/total` value for a `206`.
    pub fn content_range(&self, total: u64) -> Option<String> {
        match self {
            RangeOutcome::Satisfiable { start, end } => {
                Some(format!("bytes {start}-{end}/{total}"))
            }
            _ => None,
        }
    }

    /// Offset + length for `ObjectStore::get_range` on a `206`.
    pub fn offset_len(&self) -> Option<(u64, u64)> {
        match self {
            RangeOutcome::Satisfiable { start, end } => Some((*start, end - start + 1)),
            _ => None,
        }
    }
}

/// Parse a `Range` header value against a known blob length. Only a single
/// `bytes=` range is honored (the common client pattern); a multi-range or
/// malformed value degrades to `Full` (serve the whole blob) rather than erroring.
///
/// That degradation is RFC 9110 §14.2 behaviour and is kept HERE on purpose: this
/// surface advertises `Accept-Ranges: bytes`, so a generic HTTP client (a resumed
/// download, `curl -r`, a third-party range-aware reader) must get the standard
/// answer, and "reject what you cannot parse" is not the standard answer. The
/// degradation that ITEM-36 names is killed where it mattered — the ziee read
/// path, which speaks [`parse_range_param`] and cannot reach this function.
pub fn parse_range(header: Option<&str>, total: u64) -> RangeOutcome {
    let Some(raw) = header else {
        return RangeOutcome::Full;
    };
    let Some(spec) = raw.trim().strip_prefix("bytes=") else {
        return RangeOutcome::Full;
    };
    // Multi-range not supported here — serve full rather than a wrong 206.
    if spec.contains(',') {
        return RangeOutcome::Full;
    }
    let Some((a, b)) = spec.split_once('-') else {
        return RangeOutcome::Full;
    };
    let (a, b) = (a.trim(), b.trim());

    match (a.is_empty(), b.is_empty()) {
        // `bytes=-n` — the last n bytes.
        (true, false) => {
            let n: u64 = match b.parse() {
                Ok(n) => n,
                Err(_) => return RangeOutcome::Full,
            };
            if n == 0 || total == 0 {
                return RangeOutcome::Unsatisfiable;
            }
            let start = total.saturating_sub(n);
            RangeOutcome::Satisfiable {
                start,
                end: total - 1,
            }
        }
        // `bytes=a-` — from a to the end.
        (false, true) => {
            let start: u64 = match a.parse() {
                Ok(n) => n,
                Err(_) => return RangeOutcome::Full,
            };
            if start >= total {
                return RangeOutcome::Unsatisfiable;
            }
            RangeOutcome::Satisfiable {
                start,
                end: total - 1,
            }
        }
        // `bytes=a-b` — inclusive.
        (false, false) => {
            let start: u64 = match a.parse() {
                Ok(n) => n,
                Err(_) => return RangeOutcome::Full,
            };
            let end: u64 = match b.parse() {
                Ok(n) => n,
                Err(_) => return RangeOutcome::Full,
            };
            if start > end || start >= total {
                return RangeOutcome::Unsatisfiable;
            }
            // Clamp the inclusive end to the last byte.
            RangeOutcome::Satisfiable {
                start,
                end: end.min(total - 1),
            }
        }
        (true, true) => RangeOutcome::Full,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_header_is_full() {
        assert_eq!(parse_range(None, 100), RangeOutcome::Full);
        assert_eq!(parse_range(Some("weird"), 100), RangeOutcome::Full);
    }

    #[test]
    fn closed_range_is_inclusive() {
        let r = parse_range(Some("bytes=0-9"), 100);
        assert_eq!(r, RangeOutcome::Satisfiable { start: 0, end: 9 });
        assert_eq!(r.offset_len(), Some((0, 10)));
        assert_eq!(r.content_range(100).as_deref(), Some("bytes 0-9/100"));
    }

    #[test]
    fn open_ended_and_suffix() {
        assert_eq!(
            parse_range(Some("bytes=90-"), 100),
            RangeOutcome::Satisfiable { start: 90, end: 99 }
        );
        assert_eq!(
            parse_range(Some("bytes=-10"), 100),
            RangeOutcome::Satisfiable { start: 90, end: 99 }
        );
    }

    #[test]
    fn end_is_clamped_to_last_byte() {
        // A client asking past the end still gets a valid 206 to the last byte.
        assert_eq!(
            parse_range(Some("bytes=95-999"), 100),
            RangeOutcome::Satisfiable { start: 95, end: 99 }
        );
    }

    #[test]
    fn unsatisfiable_when_start_past_end() {
        assert_eq!(
            parse_range(Some("bytes=100-200"), 100),
            RangeOutcome::Unsatisfiable
        );
        assert_eq!(
            parse_range(Some("bytes=200-"), 100),
            RangeOutcome::Unsatisfiable
        );
        assert_eq!(
            parse_range(Some("bytes=-0"), 100),
            RangeOutcome::Unsatisfiable
        );
    }

    // ───────────────── `?range=` param (ITEM-36) ─────────────────

    use RangeParamError::{Malformed, Unsatisfiable as Unsat};

    fn span(offset: u64, length: u64) -> Result<ByteSpan, RangeParamError> {
        Ok(ByteSpan { offset, length })
    }

    #[test]
    fn param_closed_span_is_inclusive() {
        assert_eq!(parse_range_param("0-9", 100), span(0, 10));
        assert_eq!(parse_range_param("40-40", 100), span(40, 1));
        assert_eq!(parse_range_param("0-99", 100), span(0, 100));
    }

    #[test]
    fn param_open_ended_runs_to_the_end() {
        assert_eq!(parse_range_param("90-", 100), span(90, 10));
        assert_eq!(parse_range_param("0-", 100), span(0, 100));
    }

    #[test]
    fn param_suffix_takes_the_last_n_and_is_the_only_clamping_form() {
        assert_eq!(parse_range_param("-10", 100), span(90, 10));
        // The caller cannot know the length — that is WHY it used the suffix
        // form — so an over-long suffix yields the whole blob rather than 416.
        assert_eq!(parse_range_param("-4096", 100), span(0, 100));
    }

    #[test]
    fn param_out_of_bounds_is_unsatisfiable_never_the_whole_blob() {
        // The regression this item exists to kill: each of these used to be
        // answered with the ENTIRE blob under a 200.
        assert_eq!(parse_range_param("100-200", 100), Err(Unsat));
        assert_eq!(parse_range_param("95-999", 100), Err(Unsat)); // NOT clamped
        assert_eq!(parse_range_param("200-", 100), Err(Unsat));
        assert_eq!(parse_range_param("-0", 100), Err(Unsat));
        assert_eq!(parse_range_param("0-0", 0), Err(Unsat));
        assert_eq!(parse_range_param("-1", 0), Err(Unsat));
    }

    #[test]
    fn param_malformed_forms_are_refused() {
        for bad in [
            "",          // empty
            "-",         // no number either side
            "abc",       // no separator at all
            "0",         // a bare offset is not a span
            "bytes=0-9", // the header's unit does not belong in the param
            "0-9,20-29", // the batched form does not exist
            "0 - 9",     // whitespace
            " 0-9",
            "0-9 ",
            // one spelling per number
            "+0-9",
            "0-+9",
            "0x0-0x9",
            // inverted
            "9-0",
            // two separators
            "-1-2",
            "1-2-3",
            "one-two",
            // u64 overflow
            "99999999999999999999999-0",
        ] {
            assert_eq!(
                parse_range_param(bad, 100),
                Err(Malformed),
                "`?range={bad}` must be a 400"
            );
        }
    }

    #[test]
    fn param_has_no_whole_blob_outcome() {
        // The structural claim, exercised: for EVERY input, the answer is either
        // an in-bounds span or an error. A "serve everything" answer for a span
        // that did not ask for everything cannot be produced, because there is no
        // variant to produce it with. (`-4096` and `0-` legitimately span the
        // whole blob — they asked for it.)
        for probe in ["0-9", "-10", "90-", "junk", "100-200", "", "0-9,10-19"] {
            match parse_range_param(probe, 100) {
                Ok(s) => {
                    assert!(
                        s.offset + s.length <= 100,
                        "`{probe}` produced a span past the blob"
                    );
                    assert!(s.length > 0, "`{probe}` produced an empty span");
                }
                Err(Malformed) | Err(Unsat) => {}
            }
        }
    }
}
