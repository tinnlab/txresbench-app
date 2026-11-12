// TxResBench desktop build script. No build-DB dance (the crate uses only
// runtime-checked queries + the txresbench lib, no compile-time `query!`), so
// this is just the Tauri codegen prep.
fn main() {
    tauri_build::build()
}
