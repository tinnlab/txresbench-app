//! The signature check of a method list: minisign, on the raw bytes, before any parse.
//!
//! [`VerifiedList`] is the only input [`super::format::parse`] takes, and it is made only
//! here: by [`verify`] / [`verify_with`] (a trusted key signed exactly these bytes) and by
//! the module's own unsigned path for the `sequence: 0` bootstrap copy an app release
//! carries until the first publish. Parsing an unverified list therefore does not compile.
//!
//! Refused: a list over 16 MiB or a signature over 4 KiB (before reading either for
//! meaning), a legacy (not prehashed) signature, a key id that is not trusted, a signature
//! that does not match the bytes, and a trusted comment that is not the list's own
//! (`txresbench-method-list format=<n> sequence=<n>`): a maintainer key that signs
//! something else cannot be replayed as a list signature.

use std::fmt;

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use minisign_verify::{Error as MinisignError, Signature};

use super::keys::{key_id_text, KeysError, TrustedKeys};

/// The largest list the app takes (the fetch kills a pull past it).
pub const MAX_LIST_BYTES: usize = 16 * 1024 * 1024;
/// The largest signature file the app takes.
pub const MAX_SIGNATURE_BYTES: usize = 4 * 1024;
/// The start of a list signature's trusted comment; the rest is
/// `format=<format_version> sequence=<sequence>`.
pub const COMMENT_PREFIX: &str = "txresbench-method-list ";

/// The prehashed Ed25519 signature tag (minisign's default since 0.10).
const PREHASHED: [u8; 2] = *b"ED";
/// The legacy (whole-message) Ed25519 signature tag.
const LEGACY: [u8; 2] = *b"Ed";

/// What the signed trusted comment says; the parse checks it against the body.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SignedComment {
    pub format_version: u32,
    pub sequence: u64,
}

/// Who signed a list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Signer {
    pub label: String,
    pub key_id: String,
}

/// List bytes whose signature checked out (or the unsigned bootstrap copy). The fields are
/// private: only this module makes one.
#[derive(Debug)]
pub struct VerifiedList {
    bytes: Vec<u8>,
    signer: Option<Signer>,
    comment: Option<SignedComment>,
}

impl VerifiedList {
    /// The verified bytes.
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    /// The signer, `None` for the unsigned bootstrap copy.
    pub fn signer(&self) -> Option<&Signer> {
        self.signer.as_ref()
    }

    /// The signed trusted comment, `None` for the unsigned bootstrap copy.
    pub fn comment(&self) -> Option<SignedComment> {
        self.comment
    }

    /// The bootstrap copy an app release carries before the first publish: no signature,
    /// and the parse accepts it only at `sequence: 0`. Private to the module: the CLI's
    /// no-signature check and (with the runtime) the built-in copy use it; a list from
    /// anywhere else always goes through [`verify`].
    pub(super) fn unsigned_bootstrap(bytes: Vec<u8>) -> Result<VerifiedList, VerifyError> {
        if bytes.len() > MAX_LIST_BYTES {
            return Err(VerifyError::TooLarge {
                what: "list",
                size: bytes.len(),
                cap: MAX_LIST_BYTES,
            });
        }
        Ok(VerifiedList {
            bytes,
            signer: None,
            comment: None,
        })
    }

    /// Unit tests of the parse build a list without signing each variant.
    #[cfg(test)]
    pub(super) fn for_tests(bytes: Vec<u8>, comment: Option<SignedComment>) -> VerifiedList {
        VerifiedList {
            bytes,
            signer: comment.map(|_| Signer {
                label: "test".to_string(),
                key_id: "0000000000000000".to_string(),
            }),
            comment,
        }
    }
}

/// A named verification refusal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VerifyError {
    /// The list or the signature is over its cap.
    TooLarge {
        what: &'static str,
        size: usize,
        cap: usize,
    },
    /// The signature file is not a minisign signature.
    SignatureUnreadable { message: String },
    /// A legacy (not prehashed) signature.
    LegacySignature,
    /// Signed by a key the app does not trust.
    UnknownKey { key_id: String },
    /// The signature does not match these bytes (or its trusted comment).
    BadSignature { key_id: String },
    /// A valid signature whose trusted comment is not a method list's.
    WrongPurpose { comment: String },
    /// The trusted-keys file could not be read.
    Keys(KeysError),
}

impl VerifyError {
    /// The stable code of the refusal.
    pub fn code(&self) -> &'static str {
        match self {
            VerifyError::TooLarge { .. } => "METHOD_LIST_TOO_LARGE",
            VerifyError::SignatureUnreadable { .. } => "METHOD_LIST_SIGNATURE_UNREADABLE",
            VerifyError::LegacySignature => "METHOD_LIST_LEGACY_SIGNATURE",
            VerifyError::UnknownKey { .. } => "METHOD_LIST_UNKNOWN_KEY",
            VerifyError::BadSignature { .. } => "METHOD_LIST_BAD_SIGNATURE",
            VerifyError::WrongPurpose { .. } => "METHOD_LIST_WRONG_PURPOSE",
            VerifyError::Keys(e) => e.code(),
        }
    }
}

impl fmt::Display for VerifyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let code = self.code();
        match self {
            VerifyError::TooLarge { what, size, cap } => {
                write!(f, "{code}: the {what} is {size} bytes, over the {cap}-byte cap")
            }
            VerifyError::SignatureUnreadable { message } => {
                write!(f, "{code}: the signature is not a minisign signature ({message})")
            }
            VerifyError::LegacySignature => write!(
                f,
                "{code}: a legacy (not prehashed) signature; sign with a current minisign"
            ),
            VerifyError::UnknownKey { key_id } => {
                write!(f, "{code}: signed by key {key_id}, which this app does not trust")
            }
            VerifyError::BadSignature { key_id } => write!(
                f,
                "{code}: the signature by key {key_id} does not match the list's bytes"
            ),
            VerifyError::WrongPurpose { comment } => write!(
                f,
                "{code}: the signed comment {comment:?} is not a method list's \
                 ({COMMENT_PREFIX}format=<n> sequence=<n>)"
            ),
            VerifyError::Keys(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for VerifyError {}

impl From<KeysError> for VerifyError {
    fn from(e: KeysError) -> Self {
        VerifyError::Keys(e)
    }
}

/// Verify `bytes` against `signature` with the app's compiled-in trusted keys.
pub fn verify(bytes: &[u8], signature: &[u8]) -> Result<VerifiedList, VerifyError> {
    verify_with(bytes, signature, TrustedKeys::builtin()?)
}

/// Verify `bytes` against `signature` with `keys`.
pub fn verify_with(
    bytes: &[u8],
    signature: &[u8],
    keys: &TrustedKeys,
) -> Result<VerifiedList, VerifyError> {
    if bytes.len() > MAX_LIST_BYTES {
        return Err(VerifyError::TooLarge {
            what: "list",
            size: bytes.len(),
            cap: MAX_LIST_BYTES,
        });
    }
    if signature.len() > MAX_SIGNATURE_BYTES {
        return Err(VerifyError::TooLarge {
            what: "signature",
            size: signature.len(),
            cap: MAX_SIGNATURE_BYTES,
        });
    }
    let unreadable = |message: String| VerifyError::SignatureUnreadable { message };
    let text = std::str::from_utf8(signature).map_err(|e| unreadable(e.to_string()))?;
    let sig = Signature::decode(text).map_err(|e| unreadable(e.to_string()))?;
    // The algorithm tag and the key id are the first 10 bytes of the signature line (the
    // second line; `decode` checked it is 74 bytes of base64).
    let line = text.lines().nth(1).unwrap_or_default();
    let raw = STANDARD
        .decode(line.trim())
        .map_err(|e| unreadable(e.to_string()))?;
    if raw.len() < 10 {
        return Err(unreadable("the signature line is too short".to_string()));
    }
    let algorithm = [raw[0], raw[1]];
    if algorithm == LEGACY {
        return Err(VerifyError::LegacySignature);
    }
    if algorithm != PREHASHED {
        return Err(unreadable("not an Ed25519 signature".to_string()));
    }
    let mut id = [0u8; 8];
    id.copy_from_slice(&raw[2..10]);
    let key_id = key_id_text(&id);
    let Some(signer) = keys.find(&id) else {
        return Err(VerifyError::UnknownKey { key_id });
    };
    signer
        .public_key()
        .verify(bytes, &sig, false)
        .map_err(|e| match e {
            MinisignError::UnexpectedAlgorithm | MinisignError::UnsupportedLegacyMode => {
                VerifyError::LegacySignature
            }
            MinisignError::UnexpectedKeyId => VerifyError::UnknownKey {
                key_id: key_id.clone(),
            },
            _ => VerifyError::BadSignature {
                key_id: key_id.clone(),
            },
        })?;
    // The trusted comment is covered by the global signature checked just above.
    let comment = parse_comment(sig.trusted_comment()).ok_or_else(|| VerifyError::WrongPurpose {
        comment: sig.trusted_comment().to_string(),
    })?;
    Ok(VerifiedList {
        bytes: bytes.to_vec(),
        signer: Some(Signer {
            label: signer.label.clone(),
            key_id: signer.key_id.clone(),
        }),
        comment: Some(comment),
    })
}

/// `txresbench-method-list format=<u32> sequence=<u64>`, exactly (canonical decimals).
fn parse_comment(comment: &str) -> Option<SignedComment> {
    let rest = comment.strip_prefix(COMMENT_PREFIX)?;
    let (format, sequence) = rest.split_once(' ')?;
    let number = |s: &str| -> Option<u64> {
        let n: u64 = s.parse().ok()?;
        (n.to_string() == s).then_some(n)
    };
    let format_version = u32::try_from(number(format.strip_prefix("format=")?)?).ok()?;
    let sequence = number(sequence.strip_prefix("sequence=")?)?;
    Some(SignedComment {
        format_version,
        sequence,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIST: &[u8] = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../scripts/method-list/fixtures/list-dir/method-list.json"
    ));
    const SIG: &[u8] = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../scripts/method-list/fixtures/list-dir/method-list.json.minisig"
    ));
    const LEGACY_SIG: &[u8] = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../scripts/method-list/fixtures/signatures/legacy.minisig"
    ));
    const WRONG_PURPOSE_SIG: &[u8] = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../scripts/method-list/fixtures/signatures/wrong-purpose.minisig"
    ));
    const FIXTURE_KEYS: &[u8] = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../scripts/method-list/fixtures/fixture-keys.json"
    ));
    /// minisign's documentation key: a valid key with another id.
    const OTHER_KEYS: &str = r#"{"format": "txresbench-method-list-keys", "format_version": 1,
        "keys": [{"label": "other", "key_id": "E7620F1842B4E81F",
                  "public_key": "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3"}]}"#;

    fn fixture_keys() -> TrustedKeys {
        TrustedKeys::from_json(FIXTURE_KEYS).expect("fixture keys parse")
    }

    #[test]
    fn verify_accepts_trusted_key() {
        let v = verify_with(LIST, SIG, &fixture_keys()).expect("the fixture signature verifies");
        assert_eq!(v.bytes(), LIST);
        assert_eq!(v.signer().map(|s| s.key_id.as_str()), Some("73D9638AD48C0903"));
        assert_eq!(
            v.comment(),
            Some(SignedComment {
                format_version: 1,
                sequence: 1
            })
        );
    }

    #[test]
    fn verify_refuses_unknown_key_id() {
        let other = TrustedKeys::from_json(OTHER_KEYS.as_bytes()).expect("other keys parse");
        let err = verify_with(LIST, SIG, &other).unwrap_err();
        assert_eq!(err.code(), "METHOD_LIST_UNKNOWN_KEY");
        assert!(err.to_string().contains("73D9638AD48C0903"), "{err}");
        // The compiled-in set does not trust the fixture key either.
        assert_eq!(verify(LIST, SIG).unwrap_err().code(), "METHOD_LIST_UNKNOWN_KEY");
    }

    #[test]
    fn verify_refuses_flipped_byte() {
        let mut bytes = LIST.to_vec();
        let at = bytes.len() / 2;
        bytes[at] ^= 0x01;
        let err = verify_with(&bytes, SIG, &fixture_keys()).unwrap_err();
        assert_eq!(err.code(), "METHOD_LIST_BAD_SIGNATURE");
    }

    #[test]
    fn verify_refuses_legacy_signature() {
        let err = verify_with(LIST, LEGACY_SIG, &fixture_keys()).unwrap_err();
        assert_eq!(err, VerifyError::LegacySignature);
    }

    #[test]
    fn verify_refuses_wrong_purpose_comment() {
        let err = verify_with(LIST, WRONG_PURPOSE_SIG, &fixture_keys()).unwrap_err();
        assert_eq!(err.code(), "METHOD_LIST_WRONG_PURPOSE");
        for bad in [
            "txresbench-method-list format=1",
            "txresbench-method-list format=1 sequence=01",
            "txresbench-method-list format=1 sequence=+1",
            "txresbench-method-list format=1 sequence=1 extra",
            "txresbench-method-list  format=1 sequence=1",
            "other-list format=1 sequence=1",
        ] {
            assert_eq!(parse_comment(bad), None, "{bad}");
        }
    }

    #[test]
    fn verify_refuses_edited_trusted_comment() {
        // The comment is signed too: changing it breaks the global signature.
        let text = String::from_utf8_lossy(SIG).replace("sequence=1", "sequence=9");
        let err = verify_with(LIST, text.as_bytes(), &fixture_keys()).unwrap_err();
        assert_eq!(err.code(), "METHOD_LIST_BAD_SIGNATURE");
    }

    #[test]
    fn verify_refuses_over_the_caps() {
        let big = vec![b' '; MAX_LIST_BYTES + 1];
        assert_eq!(verify_with(&big, SIG, &fixture_keys()).unwrap_err().code(), "METHOD_LIST_TOO_LARGE");
        let big_sig = vec![b'a'; MAX_SIGNATURE_BYTES + 1];
        assert_eq!(
            verify_with(LIST, &big_sig, &fixture_keys()).unwrap_err().code(),
            "METHOD_LIST_TOO_LARGE"
        );
        assert_eq!(
            VerifiedList::unsigned_bootstrap(big).unwrap_err().code(),
            "METHOD_LIST_TOO_LARGE"
        );
    }

    #[test]
    fn verify_refuses_unreadable_signature() {
        let err = verify_with(LIST, b"not a signature", &fixture_keys()).unwrap_err();
        assert_eq!(err.code(), "METHOD_LIST_SIGNATURE_UNREADABLE");
    }
}
