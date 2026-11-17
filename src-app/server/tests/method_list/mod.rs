//! The `method_list` integration suite: the app's method list over a real spawned server.
//!
//! The registry is a stand-in `oras` staged in the server's `<data_dir>/bin` (the tool
//! lookup's second place, before PATH). It answers only the method list package, from
//! `<data_dir>/registry/` (`digest`, `method-list.json`, `method-list.json.minisig`), and
//! fails every other reference (the env downloads), so nothing leaves the machine. The
//! server's reference is a loopback one (`TXR_METHOD_LIST_REF`, the debug seam), and the
//! fixture test key is trusted through `TXR_METHOD_LIST_TEST_KEY`.
//!
//! The lists it serves are the server's own built-in list plus one method, one sequence
//! higher, signed by the fixture test key exactly as `minisign -S` signs
//! (`src/modules/method_list/test_sign.rs`, included below).

mod live_test;

#[path = "../../src/modules/method_list/test_sign.rs"]
#[allow(dead_code)]
mod test_sign;

use std::path::{Path, PathBuf};

use serde_json::Value;
use sha2::{Digest, Sha256};

/// The id of the method the served lists add.
pub const ADDED_METHOD: &str = "fx-list-update-check";

/// The fixture test key's public half (trusted only through the debug seam).
pub fn fixture_pub() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../scripts/method-list/fixtures/test-key.pub")
}

/// The stand-in `oras`: it serves the method list package from `<data_dir>/registry/`
/// (resolve → the `digest` file; pull → copy the two files into `-o`), records every call
/// in `registry/calls.txt`, and fails everything else after `ENV_DELAY_SECS` (so an env
/// download is slow, then refused).
pub fn oras_stub() -> (String, Vec<u8>, bool) {
    let script = "#!/bin/sh\n\
        reg=\"$(cd \"$(dirname \"$0\")/..\" && pwd)/registry\"\n\
        mkdir -p \"$reg\"\n\
        echo \"$@\" >> \"$reg/calls.txt\"\n\
        case \"$*\" in\n\
        *txresbench-method-list*) ;;\n\
        *) sleep \"$(cat \"$reg/env-delay\" 2>/dev/null || echo 0)\"; echo 'not served here' >&2; exit 1 ;;\n\
        esac\n\
        if [ \"$1\" = resolve ]; then\n\
        \x20 [ -f \"$reg/digest\" ] || { echo 'not found' >&2; exit 1; }\n\
        \x20 cat \"$reg/digest\"; exit 0\n\
        fi\n\
        if [ \"$1\" = pull ]; then\n\
        \x20 out=''; prev=''\n\
        \x20 for a in \"$@\"; do if [ \"$prev\" = -o ]; then out=\"$a\"; fi; prev=\"$a\"; done\n\
        \x20 cp \"$reg/method-list.json\" \"$reg/method-list.json.minisig\" \"$out/\"; exit 0\n\
        fi\n\
        exit 1\n";
    ("bin/oras".to_string(), script.as_bytes().to_vec(), true)
}

/// The built-in list's JSON (the file the server embeds).
pub fn builtin_doc() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../data/method-list/method-list.json");
    serde_json::from_slice(&std::fs::read(path).expect("the built-in list")).expect("JSON")
}

/// A list one sequence above the built-in one, holding every built-in row plus
/// [`ADDED_METHOD`]; `edit` changes it further. Returns the bytes and their `.minisig`.
pub fn newer_list(steps: u64, edit: impl FnOnce(&mut Value)) -> (Vec<u8>, Vec<u8>, u64) {
    let mut doc = builtin_doc();
    let sequence = doc["sequence"].as_u64().expect("sequence") + steps;
    doc["sequence"] = sequence.into();
    doc["assembled_at"] = "2026-11-20T10:00:00Z".into();
    let methods = doc["catalogue"]["methods"].as_array_mut().expect("methods");
    let mut added = methods[0].clone();
    added["id"] = ADDED_METHOD.into();
    added["title"] = "List update check".into();
    methods.push(added);
    edit(&mut doc);
    let list = serde_json::to_vec_pretty(&doc).expect("serializes");
    let sig = test_sign::TestSigner::fixture().sign_list(&list).into_bytes();
    (list, sig, sequence)
}

/// Publish a list in the stand-in registry of a running server.
pub fn publish(data_dir: &Path, list: &[u8], sig: &[u8]) {
    let reg = data_dir.join("registry");
    std::fs::create_dir_all(&reg).expect("registry dir");
    std::fs::write(reg.join("method-list.json"), list).expect("list");
    std::fs::write(reg.join("method-list.json.minisig"), sig).expect("sig");
    let digest = format!("sha256:{}", hex::encode(Sha256::digest(list)));
    std::fs::write(reg.join("digest"), digest).expect("digest");
}

/// What the stand-in registry was asked.
pub fn registry_calls(data_dir: &Path) -> String {
    std::fs::read_to_string(data_dir.join("registry").join("calls.txt")).unwrap_or_default()
}

/// The server's loopback list reference.
pub const LOOPBACK_REF: &str = "127.0.0.1:5999/tinnlab/txresbench-method-list:v1";
