//! Test-only minisign signer: the tests sign lists with the FIXTURE test key, whose secret
//! half is committed with the fixtures (`scripts/method-list/fixtures/test-key.key`,
//! unencrypted on purpose; the app never trusts it). It writes exactly what `minisign -S`
//! writes: a prehashed signature (Ed25519 over BLAKE2b-512 of the file) and the global
//! signature over the signature and the trusted comment. ed25519 is deterministic, so the
//! unit test below reproduces the committed fixture signature byte for byte.
//!
//! Compiled only into tests (the unit tests' `#[cfg(test)]` module, and the integration
//! tests through a `#[path]` include); `ed25519-dalek` is a dev-dependency.

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use ed25519_dalek::{Signer as _, SigningKey};

/// The fixture secret key file.
const FIXTURE_SECRET_KEY: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../scripts/method-list/fixtures/test-key.key"
));

/// The untrusted comment the fixtures carry.
pub const FIXTURE_UNTRUSTED_COMMENT: &str = "txresbench-method-list fixture signature (test key)";

const IV: [u64; 8] = [
    0x6a09e667f3bcc908,
    0xbb67ae8584caa73b,
    0x3c6ef372fe94f82b,
    0xa54ff53a5f1d36f1,
    0x510e527fade682d1,
    0x9b05688c2b3e6c1f,
    0x1f83d9abfb41bd6b,
    0x5be0cd19137e2179,
];

const SIGMA: [[usize; 16]; 10] = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
    [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
    [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
    [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
    [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
    [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
    [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
    [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
    [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];

#[allow(clippy::many_single_char_names)]
fn mix(v: &mut [u64; 16], a: usize, b: usize, c: usize, d: usize, x: u64, y: u64) {
    v[a] = v[a].wrapping_add(v[b]).wrapping_add(x);
    v[d] = (v[d] ^ v[a]).rotate_right(32);
    v[c] = v[c].wrapping_add(v[d]);
    v[b] = (v[b] ^ v[c]).rotate_right(24);
    v[a] = v[a].wrapping_add(v[b]).wrapping_add(y);
    v[d] = (v[d] ^ v[a]).rotate_right(16);
    v[c] = v[c].wrapping_add(v[d]);
    v[b] = (v[b] ^ v[c]).rotate_right(63);
}

fn compress(h: &mut [u64; 8], block: &[u8; 128], counter: u128, last: bool) {
    let mut m = [0u64; 16];
    for (i, w) in m.iter_mut().enumerate() {
        *w = u64::from_le_bytes(block[i * 8..i * 8 + 8].try_into().expect("8 bytes"));
    }
    let mut v = [0u64; 16];
    v[..8].copy_from_slice(h);
    v[8..].copy_from_slice(&IV);
    v[12] ^= counter as u64;
    v[13] ^= (counter >> 64) as u64;
    if last {
        v[14] = !v[14];
    }
    for round in 0..12 {
        let s = &SIGMA[round % 10];
        mix(&mut v, 0, 4, 8, 12, m[s[0]], m[s[1]]);
        mix(&mut v, 1, 5, 9, 13, m[s[2]], m[s[3]]);
        mix(&mut v, 2, 6, 10, 14, m[s[4]], m[s[5]]);
        mix(&mut v, 3, 7, 11, 15, m[s[6]], m[s[7]]);
        mix(&mut v, 0, 5, 10, 15, m[s[8]], m[s[9]]);
        mix(&mut v, 1, 6, 11, 12, m[s[10]], m[s[11]]);
        mix(&mut v, 2, 7, 8, 13, m[s[12]], m[s[13]]);
        mix(&mut v, 3, 4, 9, 14, m[s[14]], m[s[15]]);
    }
    for i in 0..8 {
        h[i] ^= v[i] ^ v[i + 8];
    }
}

/// BLAKE2b-512 (RFC 7693, unkeyed): minisign's prehash.
pub fn blake2b_512(data: &[u8]) -> [u8; 64] {
    let mut h = IV;
    h[0] ^= 0x0101_0040;
    let blocks = data.len().div_ceil(128).max(1);
    let mut counter: u128 = 0;
    for i in 0..blocks {
        let start = i * 128;
        let end = (start + 128).min(data.len());
        let mut block = [0u8; 128];
        block[..end - start].copy_from_slice(&data[start..end]);
        counter += (end - start) as u128;
        compress(&mut h, &block, counter, i + 1 == blocks);
    }
    let mut out = [0u8; 64];
    for (i, w) in h.iter().enumerate() {
        out[i * 8..i * 8 + 8].copy_from_slice(&w.to_le_bytes());
    }
    out
}

/// A minisign key that signs (the fixture test key).
pub struct TestSigner {
    key_id: [u8; 8],
    key: SigningKey,
}

impl TestSigner {
    /// The fixture test key (an unencrypted minisign secret key file).
    pub fn fixture() -> TestSigner {
        let line = FIXTURE_SECRET_KEY.lines().nth(1).expect("the key line");
        let raw = STANDARD.decode(line.trim()).expect("base64 secret key");
        // sig_alg "Ed" | kdf_alg (0000 = unencrypted) | chk_alg "B2" | salt 32 | opslimit 8 |
        // memlimit 8 | key id 8 | secret key 64 (seed + public) | checksum 32.
        assert_eq!(raw.len(), 158, "a minisign secret key");
        assert_eq!(&raw[..2], b"Ed");
        assert_eq!(&raw[2..4], &[0, 0], "the fixture key is not encrypted");
        let key_id: [u8; 8] = raw[54..62].try_into().expect("8 bytes");
        let seed: [u8; 32] = raw[62..94].try_into().expect("32 bytes");
        TestSigner {
            key_id,
            key: SigningKey::from_bytes(&seed),
        }
    }

    /// The `.minisig` text of `data` with this trusted comment (and the fixtures' untrusted
    /// comment).
    pub fn sign(&self, data: &[u8], trusted_comment: &str) -> String {
        let sig = self.key.sign(&blake2b_512(data)).to_bytes();
        let mut line = Vec::with_capacity(74);
        line.extend_from_slice(b"ED");
        line.extend_from_slice(&self.key_id);
        line.extend_from_slice(&sig);
        let mut global_input = sig.to_vec();
        global_input.extend_from_slice(trusted_comment.as_bytes());
        let global = self.key.sign(&global_input).to_bytes();
        format!(
            "untrusted comment: {FIXTURE_UNTRUSTED_COMMENT}\n{}\ntrusted comment: {trusted_comment}\n{}\n",
            STANDARD.encode(line),
            STANDARD.encode(global)
        )
    }

    /// The signature of a list, with its own trusted comment
    /// (`txresbench-method-list format=<n> sequence=<n>`, read from the list's header).
    pub fn sign_list(&self, list: &[u8]) -> String {
        let doc: serde_json::Value = serde_json::from_slice(list).expect("a JSON list");
        let comment = format!(
            "txresbench-method-list format={} sequence={}",
            doc["format_version"], doc["sequence"]
        );
        self.sign(list, &comment)
    }
}

#[test]
fn blake2b_matches_the_rfc_vector() {
    let hex: String = blake2b_512(b"abc").iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(
        hex,
        "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d1\
         7d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923"
    );
    // Two blocks plus a partial one, and the empty message (one zero block).
    assert_eq!(blake2b_512(&[]).len(), 64);
    assert_ne!(blake2b_512(&[0u8; 300]), blake2b_512(&[0u8; 301]));
}

#[test]
fn reproduces_the_committed_fixture_signature() {
    let list = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../scripts/method-list/fixtures/list-dir/method-list.json"
    ));
    let committed = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../scripts/method-list/fixtures/list-dir/method-list.json.minisig"
    ));
    assert_eq!(TestSigner::fixture().sign_list(list), committed);
}
