//! Scratch folders for unit tests: under `TXR_TEST_SCRATCH` when set (the variable the
//! integration suites use), else under the build area (`<repo>/target/txr-unit-scratch`,
//! gitignored). Never the system temp folder, which is the root disk on a workspace.

use std::path::PathBuf;

/// A new empty folder `<scratch>/<area>/<tag>-<unique>`.
pub(crate) fn dir(area: &str, tag: &str) -> PathBuf {
    let base = match std::env::var_os("TXR_TEST_SCRATCH") {
        Some(dir) => PathBuf::from(dir),
        None => PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/txr-unit-scratch"),
    };
    let dir = base
        .join(area)
        .join(format!("{tag}-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).expect("make the unit-test scratch folder");
    dir
}
