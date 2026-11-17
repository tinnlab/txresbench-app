//! The list the app runs on.
//!
//! The app embeds ONE file, its built-in copy of the method list
//! (`data/method-list/method-list.json`, plus its `.minisig` once a published list is
//! imported; `scripts/import-method-list.sh` writes both). The catalogue and the image
//! list the app reads are that file's two nested documents: nothing else is compiled in.
//!
//! [`current`] hands out the list as an `Arc` snapshot. A request takes one snapshot and
//! asks it everything; a run takes one at its start and keeps it to the end (its plans,
//! its facts, its images), so a list that changes meanwhile never mixes into it.
//!
//! The built-in copy is first-party data: one that does not verify or parse is a boot
//! refusal (the module's `init`), never a silently empty list.

use std::fmt;
use std::sync::{Arc, OnceLock, RwLock};

use super::format::{self, ListError, MethodList};
use super::keys::TrustedKeys;
use super::verify::{self, VerifiedList, VerifyError};
use crate::modules::execution_engine::envmanifest::{self, ManifestLoadError};

/// The built-in list. `$CARGO_MANIFEST_DIR` is `src-app/server`.
const BUILTIN_LIST: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../data/method-list/method-list.json"
));

// `BUILTIN_SIGNATURE: Option<&[u8]>`: the built-in list's `.minisig`, which exists only from
// the first imported published list on (the sequence 0 bootstrap copy has none). The build
// script writes the include, or `None`, because `include_bytes!` cannot name a file that
// may be absent.
include!(concat!(env!("OUT_DIR"), "/builtin_method_list_signature.rs"));

/// Why the built-in list cannot be loaded (a build defect: the boot refuses).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BuiltinError {
    /// The signature does not verify with the compiled-in trusted keys.
    Verify(VerifyError),
    /// The list's body is refused.
    List(ListError),
    /// The debug-only `TXR_ENV_MANIFEST` override cannot be read.
    DevManifest(ManifestLoadError),
}

impl fmt::Display for BuiltinError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            BuiltinError::Verify(e) => write!(f, "the built-in method list: {e}"),
            BuiltinError::List(e) => write!(f, "the built-in method list: {e}"),
            BuiltinError::DevManifest(e) => write!(f, "the TXR_ENV_MANIFEST override: {e}"),
        }
    }
}

impl std::error::Error for BuiltinError {}

/// Verify and parse a built-in copy: with its signature against `keys`, or, without one,
/// as the unsigned bootstrap copy (accepted only at sequence 0).
fn load_builtin_with(
    bytes: &[u8],
    signature: Option<&[u8]>,
    keys: &TrustedKeys,
) -> Result<MethodList, BuiltinError> {
    let verified = match signature {
        Some(sig) => verify::verify_with(bytes, sig, keys).map_err(BuiltinError::Verify)?,
        None => VerifiedList::unsigned_bootstrap(bytes.to_vec()).map_err(BuiltinError::Verify)?,
    };
    format::parse(verified).map_err(BuiltinError::List)
}

/// The built-in list, with the debug-only `TXR_ENV_MANIFEST` override applied (a debug
/// build may replace the images half with a dev registry's list; a release build never
/// reads the variable).
fn load_builtin() -> Result<MethodList, BuiltinError> {
    let keys = TrustedKeys::builtin().map_err(|e| BuiltinError::Verify(e.into()))?;
    let mut list = load_builtin_with(BUILTIN_LIST, BUILTIN_SIGNATURE, keys)?;
    if let Some(images) = envmanifest::dev_manifest_override().map_err(BuiltinError::DevManifest)? {
        list.images = images;
    }
    Ok(list)
}

static BUILTIN: OnceLock<Result<Arc<MethodList>, BuiltinError>> = OnceLock::new();

/// Load (once) the built-in list, or the named refusal. The module's `init` calls this, so
/// a bad built-in copy stops the boot.
pub fn ensure_builtin() -> Result<&'static Arc<MethodList>, BuiltinError> {
    BUILTIN
        .get_or_init(|| load_builtin().map(Arc::new))
        .as_ref()
        .map_err(Clone::clone)
}

/// The built-in list. Production code asks [`current`]; the built-in copy is for what
/// must not move with an update (demo mode replays recordings made against it) and for
/// tests about the shipped data.
pub fn builtin() -> &'static MethodList {
    ensure_builtin().expect(
        "method_list: the built-in method list failed its boot check; a bad first-party \
         list is a boot refusal, not an empty one",
    )
}

/// Whether the debug-only `TXR_ENV_MANIFEST` override replaced the built-in images.
pub fn dev_manifest_active() -> bool {
    envmanifest::dev_manifest_override_path().is_some()
}

static ACTIVE: OnceLock<RwLock<Arc<MethodList>>> = OnceLock::new();

fn active_lock() -> &'static RwLock<Arc<MethodList>> {
    ACTIVE.get_or_init(|| {
        RwLock::new(
            ensure_builtin()
                .cloned()
                .unwrap_or_else(|e| panic!("method_list: {e}")),
        )
    })
}

/// The current list, as a snapshot: take it once per request (or once per run) and ask
/// it everything.
pub fn current() -> Arc<MethodList> {
    active_lock()
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The built-in copy verifies with the app's own trusted keys and parses; the sequence 0
    /// bootstrap copy (before the first publish) is the only one without a signature.
    #[test]
    fn builtin_signature_verifies() {
        let keys = TrustedKeys::builtin().expect("the compiled-in keys parse");
        let list = load_builtin_with(BUILTIN_LIST, BUILTIN_SIGNATURE, keys)
            .expect("the built-in list verifies and parses");
        match BUILTIN_SIGNATURE {
            Some(sig) => {
                let v = verify::verify(BUILTIN_LIST, sig).expect("signed by a trusted key");
                assert_eq!(v.comment().map(|c| c.sequence), Some(list.sequence));
                assert!(list.sequence >= 1, "a signed built-in copy is a published list");
                assert!(list.signer.is_some());
            }
            None => {
                assert_eq!(list.sequence, 0, "only the bootstrap copy is unsigned");
                assert!(list.signer.is_none());
            }
        }
        assert_eq!(builtin().sequence, list.sequence);
        assert!(!builtin().catalogue.methods.is_empty());
    }

    #[test]
    fn a_tampered_builtin_is_a_named_refusal() {
        let keys = TrustedKeys::builtin().expect("keys");
        let err = load_builtin_with(b"{ not json", None, keys).unwrap_err();
        assert!(matches!(err, BuiltinError::List(ref e) if e.code() == "METHOD_LIST_HEADER_INVALID"), "{err}");
        // A signature that does not verify is refused before the parse.
        let err = load_builtin_with(BUILTIN_LIST, Some(b"not a signature"), keys).unwrap_err();
        assert!(matches!(err, BuiltinError::Verify(_)), "{err}");
    }

    #[test]
    fn current_starts_on_the_builtin_list() {
        let list = current();
        assert_eq!(list.sha256, builtin().sha256);
    }
}
