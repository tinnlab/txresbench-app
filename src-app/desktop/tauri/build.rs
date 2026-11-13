// TxResBench desktop build script. No build-DB dance (the crate uses only
// runtime-checked queries + the txresbench lib, no compile-time `query!`), so
// this is the Tauri codegen prep, preceded by the `oras` sidecar check: a
// plain cargo build without the staged sidecar leaves out
// `bundle.externalBin` instead of failing (build_sidecar.rs).
#[path = "build_sidecar.rs"]
mod build_sidecar;

fn main() {
    build_sidecar::drop_missing_sidecars();
    tauri_build::build()
}
