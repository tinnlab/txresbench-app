//! The integration suite's reader for the store a processor writes.
//!
//! ## Why this exists at all
//!
//! The server never opens a byte of an artifact (INV-1) and the browser has its own
//! zero-dependency reader, so there is no Rust decoder in the tree for a test to
//! borrow. Before the output format moved, none was needed: a per-entity column was
//! one JSON document and a test read it with `serde_json`. After the move it is a
//! DIRECTORY — metadata documents plus sharded, compressed chunk files — and a test
//! that keeps parsing the old shape does not fail on the values it is about; it panics
//! on the first byte and never reaches its own subject. Two acceptance tests were in
//! exactly that state.
//!
//! ## What it is a port of
//!
//! `packages/_lib/txr_zarr_read.py`, the reference reader that ships beside the
//! writer, transcribed one function at a time. It is deliberately the SMALL surface
//! those tests need — whole-member reads of a 1-D array and of a split string member —
//! and not a general implementation: a fuller one would be a third decoder to keep in
//! step with a format two other languages already implement.
//!
//! ## What it does not claim
//!
//! Nothing here is a parity proof. Cross-language agreement with the writer is proved
//! where it belongs (`ui/src/core/workstore/*.test.ts`, against fixtures the writer
//! produced). This is an assertion instrument: it lets a test say what a processor
//! actually emitted, in the units the processor emitted them.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::Path;

use serde_json::Value;

/// A whole store, read into memory: member path (`/`-joined, store-root-relative) →
/// bytes. Stores written by the shipped entries are small enough that reading one
/// whole is simpler and more obviously correct than a lazy fetch, and a test that
/// asserts on values wants all of them anyway.
pub type Store = BTreeMap<String, Vec<u8>>;

/// The sharding index's "this chunk was never written" sentinel.
const EMPTY: u64 = u64::MAX;

/// Read a store from a directory on disk (a capsule's regenerated output).
pub fn load_dir(root: &Path) -> Store {
    fn walk(dir: &Path, root: &Path, out: &mut Store) {
        let Ok(rd) = std::fs::read_dir(dir) else {
            return;
        };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(&p, root, out);
            } else if let Ok(bytes) = std::fs::read(&p) {
                let rel = p
                    .strip_prefix(root)
                    .unwrap_or(&p)
                    .to_string_lossy()
                    .replace('\\', "/");
                out.insert(rel, bytes);
            }
        }
    }
    let mut out = Store::new();
    walk(root, root, &mut out);
    out
}

/// Read a store out of the server's own blob store, given the artifact's
/// `object_key` — which for a multi-file artifact addresses the member MANIFEST
/// (`path` → member blob key), the same document `resolve_member` reads to serve
/// `/data/{member}`.
pub async fn load_artifact(
    store: &dyn txresbench::modules::workstore::object_store::ObjectStore,
    object_key: &str,
) -> Store {
    use txresbench::modules::workstore::object_store::ContentKey;

    let manifest_bytes = store
        .get(&ContentKey::parse(object_key))
        .await
        .expect("read the artifact's member manifest");
    let manifest: BTreeMap<String, String> = serde_json::from_slice(&manifest_bytes)
        .unwrap_or_else(|e| {
            panic!(
                "object_key {object_key} does not address a member manifest ({e}) — a \
                 single-file artifact is read by its own bytes, not through this"
            )
        });
    let mut out = Store::new();
    for (path, key) in manifest {
        let bytes = store
            .get(&ContentKey::parse(&key))
            .await
            .unwrap_or_else(|e| panic!("read member {path}: {e}"));
        out.insert(path, bytes);
    }
    out
}

fn doc(store: &Store, path: &str) -> Value {
    let bytes = store.get(path).unwrap_or_else(|| {
        panic!(
            "member {path} is absent; the store holds: {:?}",
            store.keys().collect::<Vec<_>>()
        )
    });
    serde_json::from_slice(bytes).unwrap_or_else(|e| panic!("member {path} is not JSON: {e}"))
}

/// The producer's own declaration, as stamped into the store root's attributes — the
/// same document that rides the manifest entry into the artifact row. Reading it is
/// how a test learns what the members MEAN without inferring anything from bytes.
pub fn declaration(store: &Store) -> Value {
    doc(store, "zarr.json")["attributes"]["txr"].clone()
}

/// The declared names of the 1-D members in this store, in declaration order.
pub fn declared_names(store: &Store) -> Vec<String> {
    declaration(store)["columns"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| c["name"].as_str().map(str::to_string))
        .collect()
}

/// Geometry + codec facts for one member, read from its own `zarr.json`.
struct MemberMeta {
    data_type: String,
    itemsize: usize,
    n: usize,
    inner: usize,
    shard_rows: usize,
    shuffled: bool,
}

fn itemsize_of(data_type: &str) -> usize {
    match data_type {
        "bool" | "int8" | "uint8" => 1,
        "int16" | "uint16" => 2,
        "int32" | "uint32" | "float32" => 4,
        "int64" | "uint64" | "float64" => 8,
        other => panic!("unsupported data_type {other:?}"),
    }
}

fn member_meta(store: &Store, member: &str) -> MemberMeta {
    let meta = doc(store, &format!("{member}/zarr.json"));
    let cfg = &meta["codecs"][0]["configuration"];
    assert_eq!(
        meta["codecs"][0]["name"].as_str(),
        Some("sharding_indexed"),
        "member {member} is not sharded; this reader implements the shipped writer's \
         one container"
    );
    let data_type = meta["data_type"]
        .as_str()
        .unwrap_or_else(|| panic!("member {member} declares no data_type"))
        .to_string();
    let shape = meta["shape"].as_array().expect("shape");
    assert_eq!(
        shape.len(),
        1,
        "member {member} is {}-D; this reader implements the 1-D case",
        shape.len()
    );
    MemberMeta {
        itemsize: itemsize_of(&data_type),
        data_type,
        n: shape[0].as_u64().expect("shape[0]") as usize,
        inner: cfg["chunk_shape"][0].as_u64().expect("inner chunk") as usize,
        shard_rows: meta["chunk_grid"]["configuration"]["chunk_shape"][0]
            .as_u64()
            .expect("shard rows") as usize,
        shuffled: cfg["codecs"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|c| c["name"].as_str() == Some("numcodecs.shuffle")),
    }
}

fn gunzip(data: &[u8], what: &str) -> Vec<u8> {
    let mut out = Vec::new();
    flate2::read::GzDecoder::new(data)
        .read_to_end(&mut out)
        .unwrap_or_else(|e| panic!("{what}: gzip member did not decode: {e}"));
    out
}

/// Regroup bytes by element — the inverse of the writer's byte shuffle. A 1-byte
/// element type is the identity, and the writer omits the codec there.
fn unshuffle(buf: &[u8], itemsize: usize) -> Vec<u8> {
    if itemsize == 1 {
        return buf.to_vec();
    }
    assert_eq!(
        buf.len() % itemsize,
        0,
        "shuffled buffer is element-aligned"
    );
    let per = buf.len() / itemsize;
    let mut out = vec![0u8; buf.len()];
    for b in 0..itemsize {
        for e in 0..per {
            out[e * itemsize + b] = buf[b * per + e];
        }
    }
    out
}

/// One member's values as raw little-endian element bytes (`n * itemsize` of them).
fn raw_elements(store: &Store, member: &str) -> (MemberMeta, Vec<u8>) {
    let m = member_meta(store, member);
    // Unwritten positions read as the fill value; every shipped writer fills every
    // position, so zero-fill is only ever the padding of a short tail chunk.
    let mut out = vec![0u8; m.n * m.itemsize];
    let per_shard = m.shard_rows / m.inner.max(1);
    let n_shards = m.n.div_ceil(m.shard_rows.max(1));
    for s in 0..n_shards {
        let key = format!("{member}/c/{s}");
        let body = store
            .get(&key)
            .unwrap_or_else(|| panic!("shard {key} is absent"));
        let trailer = per_shard * 16 + 4;
        assert!(
            body.len() >= trailer,
            "shard {key} is {} bytes, shorter than its own {trailer}-byte index",
            body.len()
        );
        let index = &body[body.len() - trailer..body.len() - 4];
        for k in 0..per_shard {
            let off = u64::from_le_bytes(index[k * 16..k * 16 + 8].try_into().unwrap());
            let nb = u64::from_le_bytes(index[k * 16 + 8..k * 16 + 16].try_into().unwrap());
            if off == EMPTY {
                continue;
            }
            let (off, nb) = (off as usize, nb as usize);
            // The shuffle is applied per the DECLARED codec chain, not inferred from
            // the width: the writer omits it at one byte, where it is the identity,
            // and a reader that decided for itself would silently disagree the day
            // that rule changed.
            let gz = gunzip(&body[off..off + nb], &key);
            let plain = if m.shuffled {
                unshuffle(&gz, m.itemsize)
            } else {
                gz
            };
            let lo = s * m.shard_rows + k * m.inner;
            if lo >= m.n {
                continue;
            }
            let take = (m.n - lo).min(m.inner) * m.itemsize;
            out[lo * m.itemsize..lo * m.itemsize + take].copy_from_slice(&plain[..take]);
        }
    }
    (m, out)
}

/// One `bool` member's values.
pub fn read_bools(store: &Store, member: &str) -> Vec<bool> {
    let (m, raw) = raw_elements(store, member);
    assert_eq!(
        m.data_type, "bool",
        "member {member} is not a boolean member"
    );
    raw.into_iter().map(|b| b != 0).collect()
}

/// One `uint32` member's values.
fn read_u32(store: &Store, member: &str) -> Vec<u32> {
    let (m, raw) = raw_elements(store, member);
    assert_eq!(m.data_type, "uint32", "member {member} is not uint32");
    raw.chunks_exact(4)
        .map(|c| u32::from_le_bytes(c.try_into().unwrap()))
        .collect()
}

/// One `int64` member's values — the width the producer writes row/segment vectors in.
///
/// Added for the alignment seam test, which needs the alignment's OWN vectors in the units
/// the producer wrote them. The server cannot obtain these (they are zarr arrays under
/// `sharding_indexed[bytes, numcodecs.shuffle, gzip]`, and INV-1 keeps a decoder out of the
/// server's dependency graph) — which is precisely why the arithmetic over them is written as
/// a pure function that TAKES them, and why the test suite is where they get decoded.
pub fn read_i64(store: &Store, member: &str) -> Vec<i64> {
    let (m, raw) = raw_elements(store, member);
    assert_eq!(m.data_type, "int64", "member {member} is not int64");
    raw.chunks_exact(8)
        .map(|c| i64::from_le_bytes(c.try_into().unwrap()))
        .collect()
}

/// One `int32` member's values.
pub fn read_i32(store: &Store, member: &str) -> Vec<i32> {
    let (m, raw) = raw_elements(store, member);
    assert_eq!(m.data_type, "int32", "member {member} is not int32");
    raw.chunks_exact(4)
        .map(|c| i32::from_le_bytes(c.try_into().unwrap()))
        .collect()
}

/// A SPLIT string member's values: a `uint32` offsets member bounding each value in a
/// `uint8` payload member. The offsets are a second, independent degree of freedom over
/// the same payload, which is why the producer also declares a digest of what they split
/// it into — recomputing that is the framework gate's job, not this reader's.
pub fn read_strings(store: &Store, member: &str) -> Vec<String> {
    let offsets = read_u32(store, &format!("{member}/offsets"));
    let (_, payload) = raw_elements(store, &format!("{member}/values"));
    assert!(!offsets.is_empty(), "a split member has n+1 offsets");
    offsets
        .windows(2)
        .map(|w| {
            let (a, b) = (w[0] as usize, w[1] as usize);
            assert!(
                a <= b && b <= payload.len(),
                "offsets {a}..{b} are outside the {}-byte payload",
                payload.len()
            );
            String::from_utf8(payload[a..b].to_vec())
                .unwrap_or_else(|e| panic!("member {member} value is not UTF-8: {e}"))
        })
        .collect()
}

/// The one member every column artifact writes its values into.
pub const VALUES: &str = "values";
