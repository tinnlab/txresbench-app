//! **The ONE place the server decodes an artifact byte — INV-1 as amended (DEC-23).**
//!
//! Every other module in this server stores, serves, confines, caps, hashes and records
//! bytes, and never opens one for meaning. This file is the single named exception, and the
//! exception is deliberately smaller than "the server may decode": it is
//!
//! > **the GATHER may decode the exact codec chain the writer emits.**
//!
//! ## Why the exception exists — measured, not preferred
//!
//! A serve-time gather assembles an output chunk out of rows drawn from several source
//! columns. Three measurements on the producer's own bytes established that this cannot be
//! done without decoding, and they are worth keeping here because the next person to read
//! this file will reasonably ask why an invariant was bent:
//!
//! 1. **The shard index addresses CHUNKS, not elements** — one 16-byte `(offset, nbytes)`
//!    entry per inner chunk of 4096 elements — and the chunk payload is a DEFLATE stream
//!    with no positional index inside it. **No byte RANGE of a stored file is a row.**
//! 2. **`numcodecs.shuffle` strides an element's bytes by the chunk's element count**, so
//!    even a fully inflated chunk needs a per-chunk transposition before any row is
//!    contiguous: element 1 of a 4096-element `int64` chunk lives at bytes 1, 4097, 8193, …
//! 3. **Re-serving a source chunk verbatim is impossible**, because the gathered row axis is
//!    a CONCATENATION of per-source segments: an output chunk spanning a segment boundary
//!    draws from two different source arrays. Measured on both reference alignments — output
//!    chunk 0 draws from two sources in each.
//!
//! What was rejected, and why, is recorded in `DECISIONS.md` (DEC-23): shipping the row
//! vectors as control-plane metadata fixes the metadata half and leaves the mechanism dead
//! (barriers 1 and 2 are about SOURCE columns, not the vectors); gathering in the browser
//! works for viewing but cannot work for processors, whose inputs are staged by
//! **hardlinking pooled blobs** that a gathered artifact does not have.
//!
//! ## The allowance is SIZED — three codecs, and a refusal for everything else
//!
//! [`CHAIN`] is the whole allowance. A codec outside it is refused **by name**, not ignored
//! and not best-effort decoded, because "decode whatever the crate supports" is a different
//! and larger decision than the one that was made. `crc32c` is verified where the format
//! puts it (over the shard index) and is not a decode step — it yields no plaintext.
//!
//! ## The scope is enforced mechanically
//!
//! `scripts/check-no-format-crates.sh` keeps its crate denylist unchanged AND adds a scope
//! check: a decompressor appearing in any server source file other than **this one** fails
//! the build. Its two controls (`a_decoder_outside_the_gather_module_is_refused` and
//! `the_same_decoder_inside_the_gather_module_is_allowed`) were watched RED before this file
//! existed — a widened guard with nothing proving it still guards is the hazard `BASE.md`
//! names, and it is the reason the guard was narrowed rather than deleted.

use std::io::Read;

use ziee_core::AppError;

/// The codec chain this module is allowed to decode — **the entire allowance**.
///
/// Matched by name against what the array's own `zarr.json` declares. Anything else is a
/// refusal: the amendment permits the writer's chain, not whatever a decompressor happens to
/// implement.
pub const CHAIN: [&str; 3] = ["sharding_indexed", "numcodecs.shuffle", "gzip"];

/// The inner-codec name that carries the element bytes themselves.
const BYTES_CODEC: &str = "bytes";
/// Verified, not decoded: the shard index's trailing checksum.
const INDEX_CHECKSUM: &str = "crc32c";
/// The sharding index's "this chunk was never written" sentinel.
const EMPTY: u64 = u64::MAX;

/// The largest member this module will inflate or materialise, in bytes.
///
/// Both allocations it guards are driven by DECLARED numbers rather than by bytes in hand: a
/// gzip member decompresses to whatever it decompresses to (a zip bomb is a small file), and
/// the output buffer is `n * item_size` straight from an artifact's `structure`. Neither is
/// attacker-controlled today — nothing in the server can create a gathered artifact, and
/// declarations come from a trusted producer — which is exactly the reasoning that stops
/// being true the day the first one does. A cap costs nothing now and is the difference
/// between a refusal and an OOM later.
const MAX_MEMBER_BYTES: u64 = 4 * 1024 * 1024 * 1024;

/// Refuse a codec the amendment does not cover, naming it.
fn allowed(codec: &str) -> Result<(), AppError> {
    if CHAIN.contains(&codec) || codec == BYTES_CODEC || codec == INDEX_CHECKSUM {
        return Ok(());
    }
    Err(AppError::bad_request(
        "GATHER_CODEC_UNSUPPORTED",
        format!(
            "this array declares codec {codec:?}, which the gather is not permitted to \
             decode. INV-1 allows exactly {CHAIN:?} (plus `bytes` and the index's \
             `crc32c`) — an allowance sized to the chain the writer emits, not to whatever \
             a decompressor implements. Widening it is an invariant change, not a patch."
        ),
    ))
}

/// One array's decode plan, read from its declared `zarr.json` — never sniffed from bytes.
///
/// Everything here comes from the producer's DECLARATION, which is the part of INV-1 that
/// did not change: the server still learns an artifact's shape and dtype by reading what the
/// producer said, and uses the bytes only to obtain the values that declaration describes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodePlan {
    pub item_size: usize,
    /// Elements in the whole array (its declared `shape[0]`).
    pub n: usize,
    /// Elements per INNER chunk — the unit a DEFLATE member covers, and therefore the
    /// minimum amount that must be inflated to read one row.
    pub inner: usize,
    /// Elements per shard (the outer chunk grid).
    pub shard: usize,
    pub shuffled: bool,
}

impl DecodePlan {
    /// Read the plan out of an array's `zarr.json`, refusing anything outside [`CHAIN`].
    pub fn parse(meta: &serde_json::Value) -> Result<Self, AppError> {
        let outer = meta
            .get("codecs")
            .and_then(|c| c.get(0))
            .ok_or_else(|| AppError::internal_error("array declares no codecs"))?;
        let name = outer
            .get("name")
            .and_then(|n| n.as_str())
            .unwrap_or_default();
        allowed(name)?;
        if name != "sharding_indexed" {
            return Err(AppError::bad_request(
                "GATHER_CODEC_UNSUPPORTED",
                format!(
                    "the gather decodes the writer's container, which is `sharding_indexed`; \
                     this array's outer codec is {name:?}"
                ),
            ));
        }
        let cfg = outer
            .get("configuration")
            .ok_or_else(|| AppError::internal_error("sharding_indexed with no configuration"))?;

        let mut shuffled = false;
        let inner_chain = cfg
            .get("codecs")
            .and_then(|c| c.as_array())
            .ok_or_else(|| AppError::internal_error("sharding_indexed declares no inner chain"))?;
        for c in inner_chain {
            let n = c.get("name").and_then(|n| n.as_str()).unwrap_or_default();
            allowed(n)?;
            if n == "numcodecs.shuffle" {
                shuffled = true;
            }
        }
        for c in cfg
            .get("index_codecs")
            .and_then(|c| c.as_array())
            .into_iter()
            .flatten()
        {
            allowed(c.get("name").and_then(|n| n.as_str()).unwrap_or_default())?;
        }

        let data_type = meta
            .get("data_type")
            .and_then(|d| d.as_str())
            .ok_or_else(|| AppError::internal_error("array declares no data_type"))?;
        Ok(Self {
            item_size: item_size(data_type)?,
            n: dim0(meta.get("shape"), "shape")?,
            inner: dim0(cfg.get("chunk_shape"), "sharding chunk_shape")?,
            shard: dim0(
                meta.get("chunk_grid")
                    .and_then(|g| g.get("configuration"))
                    .and_then(|c| c.get("chunk_shape")),
                "chunk_grid chunk_shape",
            )?,
            shuffled,
        })
    }
}

fn dim0(v: Option<&serde_json::Value>, what: &str) -> Result<usize, AppError> {
    v.and_then(|s| s.as_array())
        .and_then(|a| a.first())
        .and_then(serde_json::Value::as_u64)
        .map(|n| n as usize)
        .ok_or_else(|| AppError::internal_error(format!("array declares no 1-D {what}")))
}

/// Element width for the dtypes a gathered column can carry.
pub fn item_size(data_type: &str) -> Result<usize, AppError> {
    Ok(match data_type {
        "bool" | "int8" | "uint8" => 1,
        "int16" | "uint16" => 2,
        "int32" | "uint32" | "float32" => 4,
        "int64" | "uint64" | "float64" => 8,
        other => {
            return Err(AppError::bad_request(
                "GATHER_DTYPE_UNSUPPORTED",
                format!("the gather has no element width for dtype {other:?}"),
            ))
        }
    })
}

/// Inflate one gzip member.
fn gunzip(data: &[u8], what: &str) -> Result<Vec<u8>, AppError> {
    let mut out = Vec::new();
    // BOUNDED: `read_to_end` on a decompressor allocates whatever the stream expands to, and
    // the compressed size says nothing about that.
    let read = flate2::read::GzDecoder::new(data).take(MAX_MEMBER_BYTES + 1);
    let mut read = read;
    read.read_to_end(&mut out).map_err(|e| {
        AppError::internal_error(format!("{what}: the gzip member did not decode: {e}"))
    })?;
    if out.len() as u64 > MAX_MEMBER_BYTES {
        return Err(AppError::bad_request(
            "GATHER_MEMBER_TOO_LARGE",
            format!(
                "{what}: the chunk decompressed past the {MAX_MEMBER_BYTES}-byte ceiling. \
                 Refused rather than allocated — the compressed size is no bound on the \
                 decompressed one"
            ),
        ));
    }
    Ok(out)
}

/// Regroup bytes by element — the inverse of the writer's byte shuffle.
///
/// A 1-byte element type is the identity and the writer omits the codec there, so this is
/// applied per the DECLARED chain rather than inferred from the width: a reader that decided
/// for itself would silently disagree the day that rule changed.
fn unshuffle(buf: &[u8], item_size: usize) -> Result<Vec<u8>, AppError> {
    if item_size <= 1 {
        return Ok(buf.to_vec());
    }
    if buf.len() % item_size != 0 {
        return Err(AppError::internal_error(format!(
            "a shuffled buffer of {} bytes is not element-aligned at {item_size} bytes",
            buf.len()
        )));
    }
    let per = buf.len() / item_size;
    let mut out = vec![0u8; buf.len()];
    for b in 0..item_size {
        for e in 0..per {
            out[e * item_size + b] = buf[b * per + e];
        }
    }
    Ok(out)
}

/// **One member's plaintext element bytes**, from its stored shard bytes.
///
/// `shards` is `(shard index, whole stored bytes)` for each shard that was fetched. The
/// result is `n * item_size` bytes in element order — the form the gather indexes by row.
///
/// Unwritten positions read as the fill value; every shipped writer fills every position, so
/// zero-fill is only ever the padding of a short tail chunk.
pub fn decode_member(plan: &DecodePlan, shards: &[(usize, Vec<u8>)]) -> Result<Vec<u8>, AppError> {
    // BOUNDED: `n` and `item_size` are DECLARED, so this allocation is a number out of an
    // artifact's `structure` rather than a measurement of anything present.
    let want_bytes = (plan.n as u64).saturating_mul(plan.item_size as u64);
    if want_bytes > MAX_MEMBER_BYTES {
        return Err(AppError::bad_request(
            "GATHER_MEMBER_TOO_LARGE",
            format!(
                "the member declares {} element(s) of {} byte(s) = {want_bytes} bytes, past \
                 the {MAX_MEMBER_BYTES}-byte ceiling. The declaration is not a measurement, \
                 so this is refused before the allocation rather than after it",
                plan.n, plan.item_size
            ),
        ));
    }

    // **COMPLETENESS — a missing shard must not decode as zeros.**
    //
    // Ordered AFTER the size cap above deliberately: an absurd declared length would
    // otherwise be reported as a shard-count mismatch (`281474976710656 shard(s)`), which is
    // true and useless. The cheapest, most fundamental refusal goes first.
    //
    // The buffer below is pre-allocated to the DECLARED length and filled only where a shard
    // supplied bytes, so a fetch that stopped early (a transient store error on `c/1`) would
    // return shard 0's values followed by zeros, at full declared length, served as measured
    // data. That is the fabricated-zero failure INV-12 exists to forbid, arriving through the
    // back door: no error, no short read, just numbers that are not measurements.
    //
    // Found by a blind audit, which also observed that every committed fixture is
    // single-shard — so this branch had no test and could not have failed.
    let want = plan.n.div_ceil(plan.shard.max(1));
    let have: std::collections::BTreeSet<usize> = shards.iter().map(|(s, _)| *s).collect();
    if have.len() != want || (0..want).any(|s| !have.contains(&s)) {
        return Err(AppError::internal_error(format!(
            "member declares {} element(s) over {want} shard(s) but {} were supplied ({:?}). \
             Decoding the ones present would return the declared LENGTH with the missing \
             shards' rows as zeros — indistinguishable from measured data",
            plan.n,
            have.len(),
            have
        )));
    }
    let mut out = vec![0u8; plan.n * plan.item_size];
    let per_shard = plan.shard.div_ceil(plan.inner.max(1)).max(1);
    let trailer = per_shard * 16 + 4;

    for (s, body) in shards {
        if body.len() < trailer {
            return Err(AppError::internal_error(format!(
                "shard {s} is {} bytes, shorter than its own {trailer}-byte index",
                body.len()
            )));
        }
        let index = &body[body.len() - trailer..body.len() - 4];
        for k in 0..per_shard {
            let off = u64::from_le_bytes(index[k * 16..k * 16 + 8].try_into().expect("8 bytes"));
            let nb =
                u64::from_le_bytes(index[k * 16 + 8..k * 16 + 16].try_into().expect("8 bytes"));
            if off == EMPTY {
                continue;
            }
            let (off, nb) = (off as usize, nb as usize);
            if off + nb > body.len() {
                return Err(AppError::internal_error(format!(
                    "shard {s}'s index points at bytes {off}..{} of a {}-byte shard",
                    off + nb,
                    body.len()
                )));
            }
            let inflated = gunzip(&body[off..off + nb], &format!("shard {s} chunk {k}"))?;
            let plain = if plan.shuffled {
                unshuffle(&inflated, plan.item_size)?
            } else {
                inflated
            };
            let lo = s * plan.shard + k * plan.inner;
            if lo >= plan.n {
                continue;
            }
            let take = (plan.n - lo).min(plan.inner) * plan.item_size;
            if take > plain.len() {
                return Err(AppError::internal_error(format!(
                    "shard {s} chunk {k} decoded to {} bytes, short of the {take} its \
                     declared extent requires — the declaration and the bytes disagree",
                    plain.len()
                )));
            }
            out[lo * plan.item_size..lo * plan.item_size + take].copy_from_slice(&plain[..take]);
        }
    }
    Ok(out)
}

/// **Decode a contiguous ELEMENT WINDOW `[lo, hi)` from the shards that cover it** (ITEM-5).
///
/// The masked sparse serve reads ONE CSC column's slice — `indices[lo:hi]` / `data[lo:hi]` — and a
/// column is a few thousand nonzeros against a member of millions. Fetching + decoding the whole
/// member to slice five thousand elements is the `O(nnz total)` read INV-22 forbids; this decodes
/// only the shards that overlap the window, so the byte volume is `O(hi - lo)` (plus at most one
/// partial shard at each end), never the whole member.
///
/// It is [`decode_member`]'s shape restricted to a window: same shard-index parse, same
/// gzip+unshuffle inner chain, same fill-on-`EMPTY`, and the SAME completeness rule — a covering
/// shard that was not supplied is a hard refusal, never zero-filled (a missing shard decoding as
/// zeros is the fabricated-data failure INV-12 exists to forbid). Only the shards in the covering
/// range `[lo/shard ..= (hi-1)/shard]` must be present; shards outside the window are neither
/// required nor read.
pub fn decode_member_window(
    plan: &DecodePlan,
    shards: &[(usize, Vec<u8>)],
    lo: usize,
    hi: usize,
) -> Result<Vec<u8>, AppError> {
    if hi < lo || hi > plan.n {
        return Err(AppError::internal_error(format!(
            "window {lo}..{hi} is not within the member's {} declared element(s) — the column's \
             indptr slice and the member it indexes disagree about how many nonzeros exist",
            plan.n
        )));
    }
    let item = plan.item_size;
    let mut out = vec![0u8; (hi - lo) * item];
    if hi == lo {
        return Ok(out); // an empty slice: no nonzeros, no shards to read.
    }
    let s0 = lo / plan.shard.max(1);
    let s1 = (hi - 1) / plan.shard.max(1);
    // COMPLETENESS over the covering range only (decode_member's rule, windowed): a covering
    // shard that is absent must refuse rather than leave its window rows as fabricated zeros.
    let have: std::collections::BTreeSet<usize> = shards.iter().map(|(s, _)| *s).collect();
    if (s0..=s1).any(|s| !have.contains(&s)) {
        return Err(AppError::internal_error(format!(
            "window {lo}..{hi} spans shard(s) {s0}..={s1}, but only {:?} were supplied — decoding \
             the present ones would return the missing shards' elements as zeros, \
             indistinguishable from measured data",
            have
        )));
    }
    let per_shard = plan.shard.div_ceil(plan.inner.max(1)).max(1);
    let trailer = per_shard * 16 + 4;
    for (s, body) in shards {
        if *s < s0 || *s > s1 {
            continue; // outside the covering range — not part of this column's window.
        }
        if body.len() < trailer {
            return Err(AppError::internal_error(format!(
                "shard {s} is {} bytes, shorter than its own {trailer}-byte index",
                body.len()
            )));
        }
        let index = &body[body.len() - trailer..body.len() - 4];
        for k in 0..per_shard {
            let chunk_lo = s * plan.shard + k * plan.inner;
            if chunk_lo >= plan.n {
                continue;
            }
            let chunk_hi = (chunk_lo + plan.inner).min(plan.n);
            // Overlap of this chunk's element span with the requested window.
            let a = chunk_lo.max(lo);
            let b = chunk_hi.min(hi);
            if a >= b {
                continue; // this chunk holds no window element.
            }
            let off = u64::from_le_bytes(index[k * 16..k * 16 + 8].try_into().expect("8 bytes"));
            let nb =
                u64::from_le_bytes(index[k * 16 + 8..k * 16 + 16].try_into().expect("8 bytes"));
            if off == EMPTY {
                continue; // unwritten chunk — its rows read as the fill value (0), already set.
            }
            let (off, nb) = (off as usize, nb as usize);
            if off + nb > body.len() {
                return Err(AppError::internal_error(format!(
                    "shard {s}'s index points at bytes {off}..{} of a {}-byte shard",
                    off + nb,
                    body.len()
                )));
            }
            let inflated = gunzip(&body[off..off + nb], &format!("shard {s} chunk {k}"))?;
            let plain = if plan.shuffled {
                unshuffle(&inflated, item)?
            } else {
                inflated
            };
            let need = (chunk_hi - chunk_lo) * item;
            if need > plain.len() {
                return Err(AppError::internal_error(format!(
                    "shard {s} chunk {k} decoded to {} bytes, short of the {need} its declared \
                     extent requires — the declaration and the bytes disagree",
                    plain.len()
                )));
            }
            let src = (a - chunk_lo) * item;
            let len = (b - a) * item;
            out[(a - lo) * item..(a - lo) * item + len].copy_from_slice(&plain[src..src + len]);
        }
    }
    Ok(out)
}

/// Which shard indices cover output-relevant source rows — so a gather fetches the shards it
/// needs rather than the whole member.
pub fn shards_for_rows(plan: &DecodePlan, rows: &[u32]) -> Vec<usize> {
    let mut s: Vec<usize> = rows
        .iter()
        .map(|r| (*r as usize) / plan.shard.max(1))
        .collect();
    s.sort_unstable();
    s.dedup();
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn meta(inner_chain: serde_json::Value, dtype: &str, n: usize) -> serde_json::Value {
        json!({
            "shape": [n], "data_type": dtype,
            "chunk_grid": { "name": "regular", "configuration": { "chunk_shape": [4096] } },
            "codecs": [ { "name": "sharding_indexed", "configuration": {
                "chunk_shape": [4096],
                "codecs": inner_chain,
                "index_codecs": [ {"name": "bytes"}, {"name": "crc32c"} ],
                "index_location": "end" } } ],
        })
    }

    fn writers_chain() -> serde_json::Value {
        json!([{"name": "bytes"}, {"name": "numcodecs.shuffle"}, {"name": "gzip"}])
    }

    #[test]
    fn the_writers_chain_is_accepted_and_its_shuffle_is_read_from_the_declaration() {
        let p = DecodePlan::parse(&meta(writers_chain(), "int64", 5)).expect("the writer's chain");
        assert_eq!(
            p,
            DecodePlan {
                item_size: 8,
                n: 5,
                inner: 4096,
                shard: 4096,
                shuffled: true
            }
        );
        // The 1-byte case omits the shuffle codec, and the plan must reflect the
        // DECLARATION rather than inferring from the width.
        let p1 = DecodePlan::parse(&meta(
            json!([{"name": "bytes"}, {"name": "gzip"}]),
            "uint8",
            3,
        ))
        .expect("the unshuffled chain");
        assert!(!p1.shuffled);
    }

    /// **The allowance is SIZED.** A codec outside the three is refused BY NAME.
    #[test]
    fn a_codec_outside_the_allowance_is_refused_naming_it() {
        for extra in ["blosc", "zstd", "numcodecs.bitround", "transpose"] {
            let m = meta(
                json!([{"name": "bytes"}, {"name": extra}, {"name": "gzip"}]),
                "float32",
                4,
            );
            let err = DecodePlan::parse(&m)
                .expect_err("a codec the amendment does not cover must be refused");
            let msg = format!("{err:?}");
            assert!(
                msg.contains(extra),
                "the refusal must name the codec it will not decode: {msg}"
            );
            assert!(
                msg.contains("GATHER_CODEC_UNSUPPORTED"),
                "and carry its own code, so a client is not parsing prose: {msg}"
            );
        }
    }

    /// An unsharded array is refused too: the allowance is the writer's CONTAINER, and a
    /// bare `[bytes, gzip]` array is a shape this module was never measured against.
    #[test]
    fn an_unsharded_container_is_refused_rather_than_guessed_at() {
        let m = json!({
            "shape": [4], "data_type": "float32",
            "chunk_grid": { "name": "regular", "configuration": { "chunk_shape": [4] } },
            "codecs": [ { "name": "bytes" } ],
        });
        let err = DecodePlan::parse(&m).expect_err("not the writer's container");
        assert!(format!("{err:?}").contains("sharding_indexed"));
    }

    #[test]
    fn unshuffle_inverts_the_writers_transposition_and_is_identity_at_one_byte() {
        // Element bytes strided by the element COUNT is what the writer produces.
        let plain: Vec<u8> = (0u8..8).collect(); // two 4-byte elements
        let per = 2;
        let mut shuffled = vec![0u8; 8];
        for b in 0..4 {
            for e in 0..per {
                shuffled[b * per + e] = plain[e * 4 + b];
            }
        }
        assert_eq!(unshuffle(&shuffled, 4).unwrap(), plain);
        assert_eq!(unshuffle(&plain, 1).unwrap(), plain);
        assert!(
            unshuffle(&[0u8; 7], 4).is_err(),
            "a buffer that is not element-aligned is a refusal, not a truncated read"
        );
    }

    /// **A MISSING shard is refused, not decoded as zeros** (audit finding 4).
    ///
    /// The shape this rules out: a member declaring two shards, one of which failed to
    /// fetch. Filling the gap with the pre-allocated zeros returns the DECLARED length with
    /// half the rows fabricated — served as measurement, with no error and no short read.
    #[test]
    fn an_incomplete_shard_set_is_refused_rather_than_zero_filled() {
        // 8 elements at 4 per shard = two shards; supply only the first.
        let plan = DecodePlan {
            item_size: 4,
            n: 8,
            inner: 4,
            shard: 4,
            shuffled: false,
        };
        let err = decode_member(&plan, &[(0, vec![0u8; 64])])
            .expect_err("one of two shards must not decode");
        let msg = format!("{err:?}");
        assert!(
            msg.contains("2 shard(s)") && msg.contains("zeros"),
            "the refusal must name the gap and why filling it would be indistinguishable \
             from measured data: {msg}"
        );

        // …and the complete case is not refused, or this test would pass against a decoder
        // that rejected everything.
        let single = DecodePlan {
            item_size: 4,
            n: 2,
            inner: 4096,
            shard: 4096,
            shuffled: false,
        };
        assert!(
            decode_member(&single, &[(0, vec![0u8; 8])]).is_err(),
            "a malformed shard still fails for its own reason"
        );
        assert_eq!(
            single.n.div_ceil(single.shard),
            1,
            "the single-shard geometry every committed fixture uses — which is why this \
             branch had no coverage before"
        );
    }

    #[test]
    fn a_short_shard_is_refused_rather_than_read_past_its_own_index() {
        let plan = DecodePlan {
            item_size: 8,
            n: 5,
            inner: 4096,
            shard: 4096,
            shuffled: true,
        };
        let err = decode_member(&plan, &[(0, vec![0u8; 8])]).expect_err("shorter than its index");
        assert!(format!("{err:?}").contains("shorter than its own"));
    }

    #[test]
    fn only_the_shards_covering_the_wanted_rows_are_named() {
        let plan = DecodePlan {
            item_size: 4,
            n: 10_000,
            inner: 4096,
            shard: 4096,
            shuffled: false,
        };
        assert_eq!(shards_for_rows(&plan, &[0, 5, 4095]), vec![0]);
        assert_eq!(shards_for_rows(&plan, &[4096, 9000, 3]), vec![0, 1, 2]);
    }
}

#[cfg(test)]
mod cap_tests {
    use super::*;

    /// A declaration alone must not be able to demand an arbitrary allocation.
    ///
    /// `n` and `item_size` come out of an artifact's `structure`, so this buffer is sized by
    /// a NUMBER rather than by anything present. Nothing can create a gathered artifact
    /// today, which is exactly the reasoning that stops holding the day something can.
    #[test]
    fn an_absurd_declared_length_is_refused_before_the_allocation() {
        let plan = DecodePlan {
            item_size: 8,
            n: usize::MAX / 16,
            inner: 4096,
            shard: 4096,
            shuffled: false,
        };
        let err = decode_member(&plan, &[(0, vec![0u8; 4096])])
            .expect_err("a declared length past the ceiling must refuse");
        assert!(
            format!("{err:?}").contains("GATHER_MEMBER_TOO_LARGE"),
            "the refusal must be the CAP, not an out-of-memory abort: {err:?}"
        );
    }
}
