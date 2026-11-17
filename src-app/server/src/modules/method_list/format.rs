//! The method list's body: the header, the two nested documents, and the rules that tie
//! them together.
//!
//! ```json
//! { "format": "txresbench-method-list", "format_version": 1, "sequence": 42,
//!   "assembled_at": "2026-11-20T10:00:00Z",
//!   "catalogue": { <catalogue.json, schema_version 1> },
//!   "images":    { <method-env-images.json, schema_version 2> } }
//! ```
//!
//! The nested documents go through their own loaders unchanged
//! ([`parse_catalogue`], [`parse_manifest`]): both are strict (`deny_unknown_fields`, exact
//! schema versions), so a change to either schema, or to this header, is a new
//! `format_version` (a new tag line). The header is strict the same way.
//!
//! Rules checked here, across the two documents: (1) every image entry has a catalogue row;
//! (2) every image entry carries its row's `version`. Rule (3), a row is never removed, needs
//! the older list: [`MethodList::keeps_rows_of`]. The writer (`scripts/assemble-method-list.py`)
//! and the guard (`scripts/check-method-list.sh`) check the same rules from the outside.

use std::fmt;

use serde::Deserialize;
use serde_json::value::RawValue;

use crate::modules::execution_engine::envmanifest::{parse_manifest, EnvManifest, ManifestLoadError};
use crate::modules::method_catalogue::catalogue::{parse_catalogue, CatalogueLoadError};
use crate::modules::method_catalogue::types::Catalogue;

use super::verify::{SignedComment, Signer, VerifiedList};

/// The list file's `format`.
pub const LIST_FORMAT: &str = "txresbench-method-list";
/// The format line this build reads.
pub const FORMAT_VERSION: u32 = 1;

/// A parsed, checked method list.
#[derive(Debug)]
pub struct MethodList {
    pub format_version: u32,
    pub sequence: u64,
    pub assembled_at: String,
    pub catalogue: Catalogue,
    pub images: EnvManifest,
    /// `None` for the unsigned bootstrap copy (sequence 0).
    pub signer: Option<Signer>,
}

/// A named refusal of a verified list's body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ListError {
    /// Not a list header (not JSON, a field missing or unknown, a wrong type).
    Header { message: String },
    /// `format` is not [`LIST_FORMAT`].
    WrongFormat { found: String },
    /// Another format line: this app is too old for it.
    FormatVersion { found: u64 },
    /// The signed comment names another format or sequence than the body.
    CommentMismatch {
        comment: SignedComment,
        format_version: u32,
        sequence: u64,
    },
    /// An unsigned list above sequence 0.
    Unsigned { sequence: u64 },
    /// The nested catalogue is refused by its loader.
    Catalogue(CatalogueLoadError),
    /// The nested images list is refused by its loader.
    Images(ManifestLoadError),
    /// Rule 1: an image entry without a catalogue row.
    UnknownMethod { entry: String, method_id: String },
    /// Rule 2: an image entry at another version than its row.
    VersionMismatch {
        entry: String,
        entry_version: String,
        row_version: String,
    },
    /// Rule 3: a row of the older list is missing.
    RowRemoved { id: String },
}

impl ListError {
    /// The stable code of the refusal.
    pub fn code(&self) -> &'static str {
        match self {
            ListError::Header { .. } => "METHOD_LIST_HEADER_INVALID",
            ListError::WrongFormat { .. } => "METHOD_LIST_WRONG_FORMAT",
            ListError::FormatVersion { .. } => "METHOD_LIST_FORMAT_VERSION",
            ListError::CommentMismatch { .. } => "METHOD_LIST_COMMENT_MISMATCH",
            ListError::Unsigned { .. } => "METHOD_LIST_UNSIGNED",
            ListError::Catalogue(_) => "METHOD_LIST_CATALOGUE_INVALID",
            ListError::Images(_) => "METHOD_LIST_IMAGES_INVALID",
            ListError::UnknownMethod { .. } => "METHOD_LIST_UNKNOWN_METHOD",
            ListError::VersionMismatch { .. } => "METHOD_LIST_VERSION_MISMATCH",
            ListError::RowRemoved { .. } => "METHOD_LIST_ROW_REMOVED",
        }
    }
}

impl fmt::Display for ListError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let code = self.code();
        match self {
            ListError::Header { message } => write!(f, "{code}: not a method list: {message}"),
            ListError::WrongFormat { found } => {
                write!(f, "{code}: format {found:?} is not {LIST_FORMAT:?}")
            }
            ListError::FormatVersion { found } => write!(
                f,
                "{code}: format_version {found}; this app reads {FORMAT_VERSION} (a newer app is needed)"
            ),
            ListError::CommentMismatch {
                comment,
                format_version,
                sequence,
            } => write!(
                f,
                "{code}: the signature says format={} sequence={}, the list says format={} \
                 sequence={}",
                comment.format_version, comment.sequence, format_version, sequence
            ),
            ListError::Unsigned { sequence } => write!(
                f,
                "{code}: an unsigned list must be the sequence 0 bootstrap copy, this one is {sequence}"
            ),
            ListError::Catalogue(e) => write!(f, "{code}: {e}"),
            ListError::Images(e) => write!(f, "{code}: {e}"),
            ListError::UnknownMethod { entry, method_id } => write!(
                f,
                "{code}: image entry {entry} names method {method_id:?}, which has no catalogue row"
            ),
            ListError::VersionMismatch {
                entry,
                entry_version,
                row_version,
            } => write!(
                f,
                "{code}: image entry {entry} is version {entry_version:?}, its catalogue row is \
                 {row_version:?}"
            ),
            ListError::RowRemoved { id } => write!(
                f,
                "{code}: method {id:?} is in the older list and missing here (a method is \
                 retired with runnable: false, never removed)"
            ),
        }
    }
}

impl std::error::Error for ListError {}

/// The header with the nested documents left as their raw bytes, for their own loaders.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Header<'a> {
    format: String,
    format_version: u32,
    sequence: u64,
    assembled_at: String,
    #[serde(borrow)]
    catalogue: &'a RawValue,
    #[serde(borrow)]
    images: &'a RawValue,
}

/// Read first, on its own: a list of another format line is refused by its version, not by
/// whichever field the strict parse trips on first.
#[derive(Deserialize)]
struct Probe {
    #[serde(default)]
    format: Option<String>,
    #[serde(default)]
    format_version: Option<u64>,
}

/// `YYYY-MM-DDTHH:MM:SSZ`.
fn is_utc_timestamp(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 20
        && b.iter().enumerate().all(|(i, c)| match i {
            4 | 7 => *c == b'-',
            10 => *c == b'T',
            13 | 16 => *c == b':',
            19 => *c == b'Z',
            _ => c.is_ascii_digit(),
        })
}

/// Parse and check a verified list: the header, the signed comment against the body, the
/// two nested documents with their own loaders, and rules 1-2.
pub fn parse(list: VerifiedList) -> Result<MethodList, ListError> {
    let header_error = |message: String| ListError::Header { message };
    let probe: Probe =
        serde_json::from_slice(list.bytes()).map_err(|e| header_error(e.to_string()))?;
    if let Some(found) = probe.format.filter(|f| f != LIST_FORMAT) {
        return Err(ListError::WrongFormat { found });
    }
    if let Some(found) = probe.format_version.filter(|v| *v != u64::from(FORMAT_VERSION)) {
        return Err(ListError::FormatVersion { found });
    }
    let header: Header<'_> =
        serde_json::from_slice(list.bytes()).map_err(|e| header_error(e.to_string()))?;
    if header.format != LIST_FORMAT {
        return Err(ListError::WrongFormat {
            found: header.format,
        });
    }
    if !is_utc_timestamp(&header.assembled_at) {
        return Err(header_error(format!(
            "assembled_at {:?} is not YYYY-MM-DDTHH:MM:SSZ",
            header.assembled_at
        )));
    }
    match list.comment() {
        Some(comment)
            if comment.format_version != header.format_version
                || comment.sequence != header.sequence =>
        {
            return Err(ListError::CommentMismatch {
                comment,
                format_version: header.format_version,
                sequence: header.sequence,
            });
        }
        None if header.sequence != 0 => {
            return Err(ListError::Unsigned {
                sequence: header.sequence,
            });
        }
        _ => {}
    }
    let catalogue =
        parse_catalogue(header.catalogue.get().as_bytes()).map_err(ListError::Catalogue)?;
    let images = parse_manifest(header.images.get().as_bytes()).map_err(ListError::Images)?;
    check_rules(&catalogue, &images)?;
    Ok(MethodList {
        format_version: header.format_version,
        sequence: header.sequence,
        assembled_at: header.assembled_at,
        catalogue,
        images,
        signer: list.signer().cloned(),
    })
}

/// Rules 1 and 2.
fn check_rules(catalogue: &Catalogue, images: &EnvManifest) -> Result<(), ListError> {
    for e in &images.envs {
        let entry = format!("{}-{}", e.env_id, e.arch.as_str());
        let Some(row) = catalogue.method(&e.method_id) else {
            return Err(ListError::UnknownMethod {
                entry,
                method_id: e.method_id.clone(),
            });
        };
        if row.version != e.method_version {
            return Err(ListError::VersionMismatch {
                entry,
                entry_version: e.method_version.clone(),
                row_version: row.version.clone(),
            });
        }
    }
    Ok(())
}

impl MethodList {
    /// Rule 3 against an older list: every row it has is still here (a retired method keeps
    /// its row with `runnable: false`; saved models and history keep their facts).
    pub fn keeps_rows_of(&self, older: &MethodList) -> Result<(), ListError> {
        for m in &older.catalogue.methods {
            if self.catalogue.method(&m.id).is_none() {
                return Err(ListError::RowRemoved { id: m.id.clone() });
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::super::keys::TrustedKeys;
    use super::super::verify::{verify, verify_with};
    use super::*;

    const LIST: &[u8] = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../scripts/method-list/fixtures/list-dir/method-list.json"
    ));
    const SIG: &[u8] = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../scripts/method-list/fixtures/list-dir/method-list.json.minisig"
    ));
    const SEQUENCE_2_SIG: &[u8] = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../scripts/method-list/fixtures/signatures/sequence-2.minisig"
    ));
    const FIXTURE_KEYS: &[u8] = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../scripts/method-list/fixtures/fixture-keys.json"
    ));

    const SIGNED_1: Option<SignedComment> = Some(SignedComment {
        format_version: 1,
        sequence: 1,
    });

    fn keys() -> TrustedKeys {
        TrustedKeys::from_json(FIXTURE_KEYS).expect("fixture keys parse")
    }

    fn doc() -> serde_json::Value {
        serde_json::from_slice(LIST).expect("the fixture list is JSON")
    }

    fn parse_doc(doc: &serde_json::Value, comment: Option<SignedComment>) -> Result<MethodList, ListError> {
        parse(VerifiedList::for_tests(serde_json::to_vec(doc).unwrap(), comment))
    }

    #[test]
    fn fixture_list_parses() {
        let list = parse(verify_with(LIST, SIG, &keys()).unwrap()).expect("the fixture list parses");
        assert_eq!(list.format_version, FORMAT_VERSION);
        assert_eq!(list.sequence, 1);
        assert_eq!(list.catalogue.methods.len(), 3);
        assert_eq!(list.images.envs.len(), 2);
        assert_eq!(list.signer.as_ref().map(|s| s.key_id.as_str()), Some("73D9638AD48C0903"));
    }

    #[test]
    fn bad_signature_reported_before_any_parse() {
        // Bytes that are not even JSON, with a signature that does not match: the refusal
        // is the signature's, never a parse error (nothing reads the bytes first).
        let err = verify_with(b"{ not json", SIG, &keys()).unwrap_err();
        assert_eq!(err.code(), "METHOD_LIST_BAD_SIGNATURE");
        assert_eq!(verify(b"{ not json", SIG).unwrap_err().code(), "METHOD_LIST_UNKNOWN_KEY");
    }

    #[test]
    fn parse_refuses_format_version_mismatch() {
        let mut d = doc();
        d["format_version"] = 2.into();
        let err = parse_doc(&d, SIGNED_1).unwrap_err();
        assert_eq!(err, ListError::FormatVersion { found: 2 });
        let mut d = doc();
        d["format"] = "another-list".into();
        assert_eq!(parse_doc(&d, SIGNED_1).unwrap_err().code(), "METHOD_LIST_WRONG_FORMAT");
    }

    #[test]
    fn parse_refuses_unknown_header_field() {
        let mut d = doc();
        d["note"] = "anything".into();
        let err = parse_doc(&d, SIGNED_1).unwrap_err();
        assert_eq!(err.code(), "METHOD_LIST_HEADER_INVALID");
        assert!(err.to_string().contains("note"), "{err}");
        let mut d = doc();
        d.as_object_mut().unwrap().remove("assembled_at");
        assert_eq!(parse_doc(&d, SIGNED_1).unwrap_err().code(), "METHOD_LIST_HEADER_INVALID");
        let mut d = doc();
        d["assembled_at"] = "yesterday".into();
        assert_eq!(parse_doc(&d, SIGNED_1).unwrap_err().code(), "METHOD_LIST_HEADER_INVALID");
    }

    #[test]
    fn parse_refuses_nested_schema_mismatch() {
        let mut d = doc();
        d["catalogue"]["schema_version"] = 2.into();
        let err = parse_doc(&d, SIGNED_1).unwrap_err();
        assert_eq!(err, ListError::Catalogue(CatalogueLoadError::SchemaVersion { found: 2 }));
        let mut d = doc();
        d["images"]["schema_version"] = 1.into();
        let err = parse_doc(&d, SIGNED_1).unwrap_err();
        assert_eq!(err, ListError::Images(ManifestLoadError::SchemaVersion { found: 1 }));
        let mut d = doc();
        d["images"]["envs"][0]["extra"] = true.into();
        assert_eq!(parse_doc(&d, SIGNED_1).unwrap_err().code(), "METHOD_LIST_IMAGES_INVALID");
    }

    #[test]
    fn parse_refuses_comment_sequence_mismatch() {
        // A real signature by the fixture key whose comment says sequence=2 over the
        // sequence 1 body: the signature is valid, the list is refused.
        let verified = verify_with(LIST, SEQUENCE_2_SIG, &keys()).expect("the signature itself verifies");
        let err = parse(verified).unwrap_err();
        assert_eq!(err.code(), "METHOD_LIST_COMMENT_MISMATCH");
        assert!(err.to_string().contains("sequence=2"), "{err}");
    }

    #[test]
    fn unsigned_list_only_at_sequence_0() {
        let err = parse(VerifiedList::unsigned_bootstrap(LIST.to_vec()).unwrap()).unwrap_err();
        assert_eq!(err, ListError::Unsigned { sequence: 1 });
        let mut d = doc();
        d["sequence"] = 0.into();
        let list = parse(VerifiedList::unsigned_bootstrap(serde_json::to_vec(&d).unwrap()).unwrap())
            .expect("the bootstrap copy parses");
        assert_eq!(list.sequence, 0);
        assert!(list.signer.is_none());
    }

    #[test]
    fn cross_rules_refuse_unknown_method_and_version_mismatch() {
        // Rule 1: the row of an imaged method is gone.
        let mut d = doc();
        d["catalogue"]["methods"]
            .as_array_mut()
            .unwrap()
            .retain(|m| m["id"] != "fx-baseline-cox");
        let err = parse_doc(&d, SIGNED_1).unwrap_err();
        assert_eq!(
            err,
            ListError::UnknownMethod {
                entry: "fx-baseline-cox-amd64".to_string(),
                method_id: "fx-baseline-cox".to_string()
            }
        );
        // Rule 2: the row moved to a new version, the image entry did not.
        let mut d = doc();
        for m in d["catalogue"]["methods"].as_array_mut().unwrap() {
            if m["id"] == "fx-asm-methylation-panel" {
                m["version"] = "1.1.0".into();
            }
        }
        let err = parse_doc(&d, SIGNED_1).unwrap_err();
        assert_eq!(err.code(), "METHOD_LIST_VERSION_MISMATCH");
        assert!(err.to_string().contains("fx-asm-methylation-panel-amd64"), "{err}");
    }

    #[test]
    fn cross_rules_refuse_removed_row() {
        let older = parse_doc(&doc(), SIGNED_1).unwrap();
        let mut d = doc();
        d["catalogue"]["methods"]
            .as_array_mut()
            .unwrap()
            .retain(|m| m["id"] != "fx-response-signature");
        let newer = parse_doc(&d, SIGNED_1).unwrap();
        assert_eq!(
            newer.keeps_rows_of(&older).unwrap_err(),
            ListError::RowRemoved {
                id: "fx-response-signature".to_string()
            }
        );
        let mut d = doc();
        for m in d["catalogue"]["methods"].as_array_mut().unwrap() {
            if m["id"] == "fx-response-signature" {
                m["runnable"] = false.into();
            }
        }
        let retired = parse_doc(&d, SIGNED_1).unwrap();
        retired.keeps_rows_of(&older).expect("a retired row is kept");
    }
}
