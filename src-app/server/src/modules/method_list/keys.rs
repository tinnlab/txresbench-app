//! The public keys the app trusts to sign a method list.
//!
//! `data/method-list/trusted-keys.json` is compiled in (`include_bytes!`, like the
//! catalogue): one minisign key per publishing maintainer plus an offline backup key. A
//! record is `{label, key_id, public_key}`: `public_key` is the second line of the key's
//! `minisign.pub`, `key_id` the id minisign prints for it (16 uppercase hex). The id is
//! checked against the key itself, so a record cannot name one key and carry another.
//!
//! The file may hold no key at all (the keys arrive in their own change, each made by its
//! maintainer with `minisign -G` on their own machine); then every signed list is refused
//! as signed by an unknown key.

use std::fmt;
use std::sync::OnceLock;

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use minisign_verify::PublicKey;
use serde::Deserialize;

/// The trusted-keys file's `format`.
pub const KEYS_FORMAT: &str = "txresbench-method-list-keys";
/// The trusted-keys file's `format_version`.
pub const KEYS_FORMAT_VERSION: u32 = 1;

/// The compiled-in trusted keys. `$CARGO_MANIFEST_DIR` is `src-app/server`.
const TRUSTED_KEYS_JSON: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../data/method-list/trusted-keys.json"
));

/// minisign's Ed25519 algorithm tag, the first two bytes of a public key.
const KEY_ALGORITHM: [u8; 2] = *b"Ed";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct KeysFile {
    format: String,
    format_version: u32,
    keys: Vec<KeyRecord>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct KeyRecord {
    label: String,
    key_id: String,
    public_key: String,
}

/// A trusted-keys file that cannot be read as one: the compiled-in file is first-party
/// data, so this is a build defect (the CLI reports it; the app will refuse to start).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeysError {
    pub message: String,
}

impl KeysError {
    /// The stable code of the failure.
    pub fn code(&self) -> &'static str {
        "METHOD_LIST_KEYS_INVALID"
    }
}

impl fmt::Display for KeysError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code(), self.message)
    }
}

impl std::error::Error for KeysError {}

/// One trusted signer.
#[derive(Debug, Clone)]
pub struct TrustedKey {
    /// Who holds the key (printed with every list it signed).
    pub label: String,
    /// The id minisign prints for the key (16 uppercase hex).
    pub key_id: String,
    id_bytes: [u8; 8],
    key: PublicKey,
}

impl TrustedKey {
    /// The key, for the signature check.
    pub(super) fn public_key(&self) -> &PublicKey {
        &self.key
    }
}

/// A set of trusted signers (the compiled-in set, or a file given to the CLI).
#[derive(Debug, Clone)]
pub struct TrustedKeys {
    keys: Vec<TrustedKey>,
}

/// The id minisign prints for the 8 key-id bytes of a key or a signature: the bytes as a
/// little-endian number, in uppercase hex.
pub(super) fn key_id_text(id: &[u8; 8]) -> String {
    id.iter().rev().map(|b| format!("{b:02X}")).collect()
}

impl TrustedKeys {
    /// Parse and check a trusted-keys file.
    pub fn from_json(bytes: &[u8]) -> Result<TrustedKeys, KeysError> {
        let bad = |message: String| KeysError { message };
        let file: KeysFile =
            serde_json::from_slice(bytes).map_err(|e| bad(format!("not a trusted-keys file: {e}")))?;
        if file.format != KEYS_FORMAT || file.format_version != KEYS_FORMAT_VERSION {
            return Err(bad(format!(
                "format {:?} version {} is not {KEYS_FORMAT:?} version {KEYS_FORMAT_VERSION}",
                file.format, file.format_version
            )));
        }
        let mut keys: Vec<TrustedKey> = Vec::with_capacity(file.keys.len());
        for r in file.keys {
            if r.label.trim().is_empty() {
                return Err(bad(format!("key {} has an empty label", r.key_id)));
            }
            let raw = STANDARD
                .decode(r.public_key.trim())
                .map_err(|e| bad(format!("key {:?}: public_key is not base64: {e}", r.label)))?;
            if raw.len() != 42 || raw[..2] != KEY_ALGORITHM {
                return Err(bad(format!(
                    "key {:?}: public_key is not a minisign Ed25519 public key",
                    r.label
                )));
            }
            let mut id_bytes = [0u8; 8];
            id_bytes.copy_from_slice(&raw[2..10]);
            let id = key_id_text(&id_bytes);
            if r.key_id != id {
                return Err(bad(format!(
                    "key {:?}: key_id {} is not the key's own id {id}",
                    r.label, r.key_id
                )));
            }
            if keys.iter().any(|k| k.id_bytes == id_bytes) {
                return Err(bad(format!("key id {id} is listed twice")));
            }
            let key = PublicKey::from_base64(r.public_key.trim())
                .map_err(|e| bad(format!("key {:?}: {e}", r.label)))?;
            keys.push(TrustedKey {
                label: r.label,
                key_id: id,
                id_bytes,
                key,
            });
        }
        Ok(TrustedKeys { keys })
    }

    /// The compiled-in set, parsed once.
    pub fn builtin() -> Result<&'static TrustedKeys, KeysError> {
        static BUILTIN: OnceLock<Result<TrustedKeys, KeysError>> = OnceLock::new();
        BUILTIN
            .get_or_init(|| TrustedKeys::from_json(TRUSTED_KEYS_JSON))
            .as_ref()
            .map_err(Clone::clone)
    }

    /// These keys plus the key of a minisign public key file (`minisign -G`'s `.pub`: an
    /// untrusted comment line, then the key line), labelled `label`. The debug-only test key
    /// seam (`TXR_METHOD_LIST_TEST_KEY`) uses it; a release build never calls it.
    pub fn with_minisign_pub(&self, pub_file: &str, label: &str) -> Result<TrustedKeys, KeysError> {
        let bad = |message: String| KeysError { message };
        let line = pub_file
            .lines()
            .map(str::trim)
            .find(|l| !l.is_empty() && !l.starts_with("untrusted comment:"))
            .ok_or_else(|| bad("the public key file has no key line".to_string()))?;
        let raw = STANDARD
            .decode(line)
            .map_err(|e| bad(format!("the public key is not base64: {e}")))?;
        if raw.len() != 42 || raw[..2] != KEY_ALGORITHM {
            return Err(bad("not a minisign Ed25519 public key".to_string()));
        }
        let mut id_bytes = [0u8; 8];
        id_bytes.copy_from_slice(&raw[2..10]);
        let key = PublicKey::from_base64(line).map_err(|e| bad(e.to_string()))?;
        let mut keys = self.keys.clone();
        if !keys.iter().any(|k| k.id_bytes == id_bytes) {
            keys.push(TrustedKey {
                label: label.to_string(),
                key_id: key_id_text(&id_bytes),
                id_bytes,
                key,
            });
        }
        Ok(TrustedKeys { keys })
    }

    /// The signer with this key id, if trusted.
    pub fn find(&self, id: &[u8; 8]) -> Option<&TrustedKey> {
        self.keys.iter().find(|k| &k.id_bytes == id)
    }

    /// The trusted signers, in file order.
    pub fn keys(&self) -> &[TrustedKey] {
        &self.keys
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE_KEYS: &[u8] = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../scripts/method-list/fixtures/fixture-keys.json"
    ));
    const FIXTURE_PUB: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../scripts/method-list/fixtures/test-key.pub"
    ));

    /// The release set never holds the test key whose secret half is committed with the
    /// fixtures (the guard `scripts/check-method-list.sh` checks the same from the outside).
    #[test]
    fn release_keys_exclude_fixture_key() {
        let builtin = TrustedKeys::builtin().expect("the compiled-in trusted keys parse");
        let fixture = TrustedKeys::from_json(FIXTURE_KEYS).expect("fixture keys parse");
        let fixture_key = &fixture.keys()[0];
        let pub_line = FIXTURE_PUB.lines().nth(1).expect("minisign.pub has the key line");
        assert!(builtin.find(&fixture_key.id_bytes).is_none());
        assert!(builtin.keys().iter().all(|k| k.key_id != fixture_key.key_id));
        assert!(!String::from_utf8_lossy(TRUSTED_KEYS_JSON).contains(pub_line.trim()));
    }

    #[test]
    fn a_minisign_pub_file_adds_its_key() {
        let builtin = TrustedKeys::builtin().expect("keys");
        let fixture = TrustedKeys::from_json(FIXTURE_KEYS).expect("fixture keys parse");
        let with = builtin
            .with_minisign_pub(FIXTURE_PUB, "test key")
            .expect("the fixture .pub reads");
        let added = with.find(&fixture.keys()[0].id_bytes).expect("the test key is trusted");
        assert_eq!(added.label, "test key");
        assert_eq!(added.key_id, fixture.keys()[0].key_id);
        assert_eq!(with.keys().len(), builtin.keys().len() + 1);
        assert!(builtin.with_minisign_pub("untrusted comment: x\nnot base64!", "x").is_err());
    }

    #[test]
    fn key_id_must_be_the_keys_own() {
        let text = String::from_utf8_lossy(FIXTURE_KEYS).replace("73D9638AD48C0903", "0000000000000000");
        let err = TrustedKeys::from_json(text.as_bytes()).unwrap_err();
        assert_eq!(err.code(), "METHOD_LIST_KEYS_INVALID");
        assert!(err.message.contains("not the key's own id"), "{err}");
    }

    #[test]
    fn fixture_key_id_matches_minisign_pub_comment() {
        let fixture = TrustedKeys::from_json(FIXTURE_KEYS).expect("fixture keys parse");
        let comment = FIXTURE_PUB.lines().next().expect("comment line");
        assert!(comment.ends_with(&fixture.keys()[0].key_id), "{comment}");
    }
}
